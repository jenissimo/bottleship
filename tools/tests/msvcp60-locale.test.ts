import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { msvcp60Module } from "../../src/worker/api/msvcp60.api";
import { registerVc6LocaleExports, type Vc6LocaleSnapshot } from "../../src/worker/modules/crt-cpp-locale-vc6";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

let mem: Uint8Array;
let exports: Record<string, ThunkImplementation>;
let next: number;
let edx: number;
let errno: number;
let freed: number[];
let snapshot: Vc6LocaleSnapshot;
const call = (name: string, ...args: number[]) => exports[name]!(null as never, mem, args) as number;

describe("VC6 locale ABI and C-locale semantics", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x10000);
        Mem.bind(() => mem);
        exports = {};
        next = 0x4000;
        edx = 0x12345678;
        errno = 0;
        freed = [];
        snapshot = { collateHandle: 0, collateCodePage: 0, ctypeHandle: 0, ctypeCodePage: 0, ctypeTable: 0x1000 };
        // Distinctive source bits test actual copying, including the last table entry.
        for (let i = 0; i < 256; i++) Mem.writeUint16(0x1000 + 2*i, i ^ 0x1234);
        registerVc6LocaleExports(exports, {
            snapshot: () => snapshot,
            alloc: n => { const p = next; next += n; return p; },
            free: p => { freed.push(p); },
            setEdx: n => { edx = n; },
            setErrno: n => { errno = n; },
        });
    });

    test("small structs return in EDX:EAX; _Getctype alone has a cdecl hidden argument", () => {
        const registry = APIRegistry.getInstance();
        registry.registerModule(msvcp60Module);
        for (const [name, argc] of [["_Getcoll", 0], ["_Getcvt", 0], ["_Getctype", 1], ["_Mbrtowc", 5], ["_Wcrtomb", 4], ["_Strcoll", 5], ["_Strxfrm", 5], ["_Tolower", 2], ["_Toupper", 2], ["btowc", 1], ["wctob", 1]] as const) {
            expect(registry.getArgCount("msvcp60", name), name).toBe(argc);
            expect(registry.getCallingConvention("msvcp60", name), name).toBe("cdecl");
        }
        // Distinct fields catch reversed halves and using LC_CTYPE for LC_COLLATE.
        snapshot = { ...snapshot, collateHandle: 0x409, collateCodePage: 1252, ctypeHandle: 0x411, ctypeCodePage: 932 };
        expect(call("_Getcoll")).toBe(0x409);
        expect(edx).toBe(1252);
        expect(call("_Getcvt")).toBe(0x411);
        expect(edx).toBe(932);
        // As in Wine's msvcp60, _Getctype pairs the COLLATE handle with the CTYPE code page
        // (Wine's observed behavior; not checked against a native DLL).
        expect(call("_Getctype", 0x200)).toBe(0x200);
        expect(Mem.readUint32(0x200)).toBe(0x409);
        expect(Mem.readUint32(0x204)).toBe(932);
    });

    test("_Getctype writes exactly 16 bytes and returns a separately owned table", () => {
        mem.fill(0xaa, 0x1fc, 0x214);
        expect(call("_Getctype", 0x200)).toBe(0x200);
        expect(Mem.readUint32(0x200)).toBe(0);
        expect(Mem.readUint32(0x204)).toBe(0);
        const table = Mem.readUint32(0x208)!;
        expect(table).toBe(0x4000);
        expect(Mem.readUint32(0x20c)).toBe(1);
        expect(mem.slice(table, table+512)).toEqual(mem.slice(0x1000, 0x1200));
        expect(Mem.readUint32(0x1fc)).toBe(0xaaaaaaaa);
        expect(Mem.readUint32(0x210)).toBe(0xaaaaaaaa);
        call("_Getctype", 0x220);
        expect(Mem.readUint32(0x228)).toBe(0x4200);
        Mem.writeUint16(table, 0xffff);
        expect(Mem.readUint16(0x1000)).toBe(0x1234);
    });

    test("C case mapping preserves signed EOF and all non-ASCII values", () => {
        expect(call("_Tolower", 0x41, 0)).toBe(0x61);
        expect(call("_Toupper", 0x7a, 0)).toBe(0x5a);
        expect(call("_Tolower", 0xffffffff, 0)).toBe(-1);
        expect(call("_Toupper", 0xe9, 0)).toBe(0xe9);
        expect(call("_Tolower", 0x1234, 0)).toBe(0x1234);
    });

    test("C conversion preserves high bytes, NUL, state and EILSEQ behavior", () => {
        mem[0x100] = 0xfe;
        Mem.writeUint32(0x300, 0xaabbccdd);
        expect(call("_Mbrtowc", 0x200, 0x100, 1, 0x300, 0)).toBe(1);
        expect(Mem.readUint16(0x200)).toBe(0xfe);
        expect(Mem.readUint32(0x300)).toBe(0);
        mem[0x100] = 0;
        expect(call("_Mbrtowc", 0x200, 0x100, 1, 0x300, 0)).toBe(0);
        expect(Mem.readUint16(0x200)).toBe(0);
        Mem.writeUint32(0x300, 123);
        expect(call("_Mbrtowc", 0, 0, 0, 0x300, 0)).toBe(0);
        expect(Mem.readUint32(0x300)).toBe(123);
        expect(call("_Wcrtomb", 0x100, 0xff, 0, 0)).toBe(1);
        expect(mem[0x100]).toBe(0xff);
        expect(call("_Wcrtomb", 0x100, 0x100, 0, 0)).toBe(-1);
        expect(errno).toBe(42);
        expect(mem[0x100]).toBe(0xff);
    });

    test("byte/wide helpers keep VC6 NUL, signed-char and EOF conventions", () => {
        expect(call("btowc", 0x80)).toBe(0x80);
        expect(call("btowc", 0xffffffff)).toBe(0xffff);
        expect(call("btowc", 0)).toBe(0xffff);
        expect(call("wctob", 0x80)).toBe(-128);
        expect(call("wctob", 0xffff)).toBe(-1);
        expect(call("wctob", 0x100)).toBe(-1);
        expect(call("wctob", 0)).toBe(0);
    });

    test("collation compares full ranges including embedded NUL and unsigned high bytes", () => {
        mem.set([0x41, 0, 0x80], 0x100);
        mem.set([0x41, 0, 0x7f], 0x200);
        expect(call("_Strcoll", 0x100, 0x103, 0x200, 0x203, 0)).toBeGreaterThan(0);
        expect(call("_Strcoll", 0x100, 0x102, 0x200, 0x203, 0)).toBeLessThan(0);
        expect(call("_Strcoll", 0x100, 0x102, 0x200, 0x202, 0)).toBe(0);
    });

    test("C sort keys use exact byte ranges with no terminator or short-buffer writes", () => {
        mem.set([0x41, 0, 0xff], 0x100);
        mem.fill(0x99, 0x200, 0x210);
        expect(call("_Strxfrm", 0, 0, 0x100, 0x103, 0)).toBe(3);
        expect(call("_Strxfrm", 0x200, 0x202, 0x100, 0x103, 0)).toBe(3);
        expect(mem.slice(0x200, 0x204)).toEqual(new Uint8Array([0x99,0x99,0x99,0x99]));
        expect(call("_Strxfrm", 0x200, 0x203, 0x100, 0x103, 0)).toBe(3);
        expect(mem.slice(0x200, 0x204)).toEqual(new Uint8Array([0x41,0,0xff,0x99]));
    });

    test("non-C vectors fail explicitly instead of silently returning C results", () => {
        Mem.writeUint32(0x400, 0x409);
        Mem.writeUint32(0x404, 1252);
        expect(() => call("_Tolower", 0xc0, 0x400)).toThrow("non-C locale");
        expect(() => call("_Strcoll", 0x100, 0x101, 0x200, 0x201, 0x400)).toThrow("non-C locale");
    });

    test("rejected conversion and sort-key writes throw instead of returning success", () => {
        mem[0x100] = 0x41;
        mem.fill(0xa5, 0x200, 0x300);
        Mem.bind(() => mem, (p,n,perms) => p >= 0x100 && p+n <= mem.length
            && (!perms.includes("w") || p+n <= 0x200 || p >= 0x300));
        expect(() => call("_Wcrtomb", 0x200, 65, 0, 0)).toThrow("invalid guest write");
        expect(() => call("_Mbrtowc", 0x200, 0x100, 1, 0, 0)).toThrow("invalid guest write");
        expect(() => call("_Mbrtowc", 0, 0x100, 1, 0x200, 0)).toThrow("invalid guest write");
        expect(() => call("_Strxfrm", 0x200, 0x201, 0x100, 0x101, 0)).toThrow("invalid guest write");
        expect(mem.slice(0x200, 0x210)).toEqual(new Uint8Array(16).fill(0xa5));
    });

    test("_Getctype frees an unpublished table after destination or table write rejection", () => {
        mem.fill(0xa5, 0x200, 0x210);
        Mem.bind(() => mem, (p,n,perms) => !perms.includes("w") || p+n <= 0x200 || p >= 0x300);
        expect(() => call("_Getctype", 0x200)).toThrow("invalid guest write");
        expect(freed).toEqual([0x4000]);
        expect(mem.slice(0x200, 0x210)).toEqual(new Uint8Array(16).fill(0xa5));
        Mem.bind(() => mem, (p,n,perms) => !perms.includes("w") || p+n <= 0x4000);
        expect(() => call("_Getctype", 0x300)).toThrow("invalid guest write");
        expect(freed).toEqual([0x4000, 0x4200]);
        expect(Mem.readUint32(0x300)).toBe(0);
    });

    test("unreadable and physically truncated ranges cannot turn into zero-filled locale results", () => {
        Mem.bind(() => mem, (p,n) => p >= 0x100 && p+n <= mem.length && (p+n <= 0x500 || p >= 0x600));
        expect(() => call("_Tolower", 65, 0x500)).toThrow("invalid guest read");
        expect(() => call("_Mbrtowc", 0x200, 0x500, 1, 0, 0)).toThrow("invalid guest read");
        Mem.bind(() => mem); // No address-space validator must still preserve physical bounds.
        expect(() => call("_Tolower", 65, mem.length-2)).toThrow("invalid guest range");
        expect(() => call("_Mbrtowc", mem.length-1, 0x100, 1, 0, 0)).toThrow("invalid guest range");
        expect(() => call("_Strcoll", mem.length-1, mem.length+1, 0x100, 0x102, 0)).toThrow("invalid guest range");
        expect(() => call("_Wcrtomb", mem.length, 65, 0, 0)).toThrow("invalid guest range");
    });
});
