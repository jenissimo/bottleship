import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Msvcp60 } from "../../src/worker/modules/msvcp60";
import { Msvcrt } from "../../src/worker/modules/msvcrt";
import { vc6ExceptionCtor, vc6ExceptionCopy, vc6ExceptionDtor, vc6ExceptionDelete, vc6ExceptionWhat } from "../../src/worker/modules/crt-cpp-exception-vc6";
import type { CppStringHeap } from "../../src/worker/modules/crt-cppstring-vc6";

let mem: Uint8Array;
let next: number;
let heap: CppStringHeap;
let freed: number[];
const str = (p: number, s: string) => Mem.writeBytes(p, new TextEncoder().encode(s + "\0"));
const read = (p: number) => { let s = ""; while (mem[p]) s += String.fromCharCode(mem[p++]!); return s; };

let publishedModule: Msvcp60 | null = null;

describe("VC6 bad_cast storage, virtual methods and caller ABI", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x20000);
        Mem.bind(() => mem);
        next = 0x4000;
        freed = [];
        heap = { alloc: n => { const p = next; next += n; return p; }, free: p => { freed.push(p); } };
    });

    test("ctor writes 12 bytes, copies the borrowed message and dtor frees only that copy", () => {
        mem.fill(0xaa, 0x1fc, 0x210);
        str(0x100, "bad cast message");
        expect(vc6ExceptionCtor(0x200, 0x100, 0x800, heap)).toBe(0x200);
        const name = Mem.readUint32(0x204)!;
        expect(name).not.toBe(0x100);
        expect(read(name)).toBe("bad cast message");
        expect(Mem.readUint32(0x208)).toBe(1);
        expect(Mem.readUint32(0x1fc)).toBe(0xaaaaaaaa);
        expect(Mem.readUint32(0x20c)).toBe(0xaaaaaaaa);
        vc6ExceptionDtor(0x200, 0x900, heap);
        expect(freed).toEqual([name]);
        expect(Mem.readUint32(0x200)).toBe(0x900);
    });

    test("copying owned names deep-copies while borrowed names retain ownership", () => {
        str(0x100, "bad cast");
        vc6ExceptionCtor(0x200, 0x100, 0x800, heap);
        vc6ExceptionCopy(0x220, 0x200, 0x800, heap);
        expect(Mem.readUint32(0x224)).not.toBe(Mem.readUint32(0x204));
        expect(read(Mem.readUint32(0x224)!)).toBe("bad cast");
        Mem.writeUint32(0x208, 0);
        vc6ExceptionCopy(0x240, 0x200, 0x800, heap);
        expect(Mem.readUint32(0x244)).toBe(Mem.readUint32(0x204));
        expect(Mem.readUint32(0x248)).toBe(0);
        vc6ExceptionDtor(0x240, 0x900, heap);
        expect(freed).toEqual([]);
    });

    test("deleting destructor handles scalar flags and reverse-order array cookies", () => {
        str(0x100, "x");
        vc6ExceptionCtor(0x200, 0x100, 0x800, heap);
        const scalarName = Mem.readUint32(0x204)!;
        vc6ExceptionDelete(0x200, 1, 0x900, heap);
        expect(freed).toEqual([scalarName, 0x200]);
        freed = [];
        Mem.writeUint32(0x2fc, 2);
        vc6ExceptionCtor(0x300, 0x100, 0x800, heap);
        vc6ExceptionCtor(0x30c, 0x100, 0x800, heap);
        const n1 = Mem.readUint32(0x304)!, n2 = Mem.readUint32(0x310)!;
        vc6ExceptionDelete(0x300, 2, 0x900, heap);
        expect(freed).toEqual([n2, n1, 0x2fc]);
    });

    test("module publishes data vtable with real thiscall stubs, including after rebind", () => {
        const tg = new ThunkGenerator();
        tg.setBaseAddress(0x10000);
        const regs = new Int32Array(8);
        const process = {
            memory: { alloc: (n: number) => heap.alloc(n) },
            thunkGenerator: tg,
            getCurrentMemory: () => mem,
            v86: { cpu: { reg32: regs } },
        };
        const crt = {
            getCppLocaleSnapshot: () => ({ collateHandle: 0x409, collateCodePage: 1252, ctypeHandle: 0x411, ctypeCodePage: 932, ctypeTable: 0x1000 }),
            exports: { malloc: (_c: unknown, _m: unknown, a: number[]) => heap.alloc(a[0]!), free: (_c: unknown, _m: unknown, a: number[]) => heap.free(a[0]!), _errno: () => 0x80 },
        };
        const module = new Msvcp60();
        module.setMsvcrt(crt as never);
        module.initialize(process as never);
        publishedModule = module;
        const ctx = { ecx: 0x200 } as never;
        const run = (name: string, ...args: number[]) => module.exports[name]!(ctx, mem, args);
        expect(run("_Getcoll")).toBe(0x409);
        expect(regs[2]).toBe(1252);
        expect(run("_Getcvt")).toBe(0x411);
        expect(regs[2]).toBe(932);
        const getVtable = () => tg.generateStubDll("msvcp60", [{ name: "??_7bad_cast@std@@6B@", argCount: 0 }]).exportTable.get("??_7bad_cast@std@@6b@")!;
        const vtable = getVtable();
        expect(vtable).toBeGreaterThan(0);
        str(0x100, "test bad cast");
        expect(run("??0bad_cast@std@@QAE@PBD@Z", 0x100)).toBe(0x200);
        expect(Mem.readUint32(0x200)).toBe(vtable);
        const method0 = Mem.readUint32(vtable)!;
        const method1 = Mem.readUint32(vtable + 4)!;
        expect(mem.slice(method0 + 11, method0 + 14)).toEqual(new Uint8Array([0xc2, 4, 0]));
        expect(mem[method1 + 11]).toBe(0xc3);
        expect(read(run("IVc6Exception_What") as number)).toBe("test bad cast");
        const name = Mem.readUint32(0x204)!;
        expect(run("IVc6Exception_DeletingDestructor", 0)).toBe(0x200);
        expect(freed).toEqual([name]);
        run("??0bad_cast@std@@QAE@PBD@Z", 0);
        expect(read(run("IVc6Exception_What") as number)).toBe("Unknown exception");
        str(0x100, "assigned");
        module.exports["??0bad_cast@std@@QAE@PBD@Z"]!({ ecx: 0x240 } as never, mem, [0x100]);
        const sourceName = Mem.readUint32(0x244)!;
        expect(run("??4bad_cast@std@@QAEAAV01@ABV01@@Z", 0x240)).toBe(0x200);
        expect(read(Mem.readUint32(0x204)!)).toBe("assigned");
        expect(Mem.readUint32(0x204)).not.toBe(sourceName);
        // As in Wine's msvcp60, assignment runs the base dtor and copy and leaves the base
        // vtable in place (Wine's observed behavior; not checked against a native DLL).
        expect(Mem.readUint32(0x200)).not.toBe(vtable);
        const beforeSelf = Mem.readUint32(0x204), freesBeforeSelf = freed.length;
        run("??4bad_cast@std@@QAEAAV01@ABV01@@Z", 0x200);
        expect(Mem.readUint32(0x204)).toBe(beforeSelf);
        expect(freed.length).toBe(freesBeforeSelf);
        module.reregisterExports(process as never);
        expect(getVtable()).not.toBe(vtable);
    });

    test("CRT snapshot does not substitute ANSI code page for C or accept fake named state", () => {
        const crt = Object.create(Msvcrt.prototype);
        crt.currentLocale = "C";
        crt.pctypeTableAddr = 0x1000;
        crt.ensureRuntimeStorage = () => {};
        expect(crt.getCppLocaleSnapshot()).toEqual({ collateHandle: 0, collateCodePage: 0, ctypeHandle: 0, ctypeCodePage: 0, ctypeTable: 0x1000 });
        crt.currentLocale = "French_France.1252";
        expect(() => crt.getCppLocaleSnapshot()).toThrow("non-C locale snapshot");
    });

    test("inaccessible exception source and message throw without publishing a fake empty object", () => {
        mem.fill(0xa5, 0x200, 0x20c);
        Mem.bind(() => mem, (p,n) => p >= 0x100 && p+n <= mem.length && (p+n <= 0x500 || p >= 0x600));
        expect(() => vc6ExceptionCopy(0x200, 0x500, 0x800, heap)).toThrow("invalid guest read");
        expect(() => vc6ExceptionCtor(0x200, 0x500, 0x800, heap)).toThrow("invalid guest read");
        expect(() => vc6ExceptionWhat(0x500, 0x700)).toThrow("invalid guest read");
        expect(mem.slice(0x200, 0x20c)).toEqual(new Uint8Array(12).fill(0xa5));
        expect(next).toBe(0x4000);
        Mem.bind(() => mem);
        mem[mem.length-1] = 0x41;
        expect(() => vc6ExceptionCopy(0x200, mem.length-4, 0x800, heap)).toThrow("invalid guest range");
        expect(() => vc6ExceptionCtor(0x200, mem.length-1, 0x800, heap)).toThrow("invalid guest range");
    });

    test("rejected exception object writes throw and free unpublished message allocations", () => {
        str(0x100, "x");
        mem.fill(0xa5, 0x200, 0x20c);
        Mem.bind(() => mem, (p,n,perms) => !perms.includes("w") || p+n <= 0x200 || p >= 0x300);
        expect(() => vc6ExceptionCtor(0x200, 0x100, 0x800, heap)).toThrow("invalid guest write");
        expect(freed).toEqual([0x4000]);
        expect(mem.slice(0x200, 0x20c)).toEqual(new Uint8Array(12).fill(0xa5));
        // Borrowed names do not allocate, but their destination still must be writable.
        Mem.writeUint32(0x304, 0x100);
        expect(() => vc6ExceptionCopy(0x200, 0x300, 0x800, heap)).toThrow("invalid guest write");
        expect(freed).toEqual([0x4000]);
    });

    test("rejected message storage and destructor writes cannot free or publish the wrong object", () => {
        str(0x100, "x");
        Mem.bind(() => mem, (p,n,perms) => !perms.includes("w") || p+n <= 0x4000);
        expect(() => vc6ExceptionCtor(0x200, 0x100, 0x800, heap)).toThrow("invalid guest write");
        expect(freed).toEqual([0x4000]);
        expect(Mem.readUint32(0x200)).toBe(0);
        Mem.bind(() => mem);
        vc6ExceptionCtor(0x200, 0x100, 0x800, heap);
        freed = [];
        Mem.bind(() => mem, (p,n,perms) => !perms.includes("w") || p+n <= 0x200 || p >= 0x300);
        expect(() => vc6ExceptionDtor(0x200, 0x900, heap)).toThrow("invalid guest write");
        expect(freed).toEqual([]);
        expect(Mem.readUint32(0x200)).toBe(0x800);
        Mem.writeUint32(mem.length - 4, 1);
        expect(() => vc6ExceptionDelete(mem.length, 2, 0x900, heap)).toThrow("invalid guest range");
    });
});

// Last, and importing System only here: the singleton must not exist while the tests
// above drive guest memory directly.
describe("VC6 exception::_Doraise", () => {
    test("stops the process naming the missing method instead of pretending to raise", async () => {
        const { System } = await import("../../src/worker/core/system");
        const system = System.getInstance() as any;
        const original = system.reportGuestCrash;
        const crashes: any[] = [];
        system.reportGuestCrash = (opts: any) => crashes.push(opts);
        try {
            expect(publishedModule!.exports["IVc6Exception_Doraise"]!({ eip: 0x401000 } as never, mem, [])).toBe(0);
        } finally {
            system.reportGuestCrash = original;
        }
        expect(crashes).toEqual([{ reason: "msvcp60!exception::_Doraise is not implemented", eip: 0x401000 }]);
    });
});
