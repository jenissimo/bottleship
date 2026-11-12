import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { Oleaut32, OLEAUT32_FIELDS, type Oleaut32State } from "../../src/worker/modules/oleaut32";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../src/worker/savestate/participant";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Handler = (ctx: unknown, mem: Uint8Array, args: number[]) => number;
type Internals = Record<string, unknown> & { exports: Record<string, Handler> };
interface Booted { ole: Oleaut32 & Internals; handlers: Record<string, Handler>; freed: number[] }

const system = System.getInstance();
const savedProcess = system.process;
const savedMem = Object.getOwnPropertyDescriptors(Mem);
let memory: Uint8Array;

function boot(heapStart = 0x100000): Booted {
    let next = heapStart;
    const generator = new ThunkGenerator();
    generator.setBaseAddress(0x1000);
    const handlers: Record<string, Handler> = {};
    const freed: number[] = [];
    const alloc = (size: number) => { const p = next; next += (Math.max(4, size) + 3) & ~3; return p; };
    const process = {
        memory: { alloc, allocAt: () => undefined, free: (p: number) => { freed.push(p); }, allocSystemBlock: alloc, freeSystemBlock: () => undefined },
        dispatcher: { registerModule: (_name: string, h: Record<string, Handler>) => { Object.assign(handlers, h); }, applyPendingRegistrations: () => undefined },
        thunkGenerator: generator,
        getCurrentMemory: () => memory,
    };
    system.process = process as never;
    const ole = new Oleaut32() as Oleaut32 & Internals;
    ole.initialize(process as never);
    return { ole, handlers, freed };
}

function createArray(b: Booted, elements: number): number {
    Mem.writeUint32(0x2000, elements);
    Mem.writeUint32(0x2004, 0);
    return b.ole.exports.SafeArrayCreate!({}, memory, [3, 1, 0x2000]);
}

function loadTypeLib(b: Booted): number {
    const path = "SUN.TLB";
    for (let i = 0; i <= path.length; i++) memory[0x2100 + i * 2] = path.charCodeAt(i) || 0;
    expect(b.ole.exports.LoadTypeLib!({}, memory, [0x2100, 0x2200])).toBe(0);
    return Mem.readUint32(0x2200)!;
}

beforeEach(() => {
    memory = new Uint8Array(0x400000);
    Mem.bind(() => memory, (a, s) => a >= 0 && a + s <= memory.length);
});
afterEach(() => {
    system.process = savedProcess;
    for (const key of ["memoryGetter", "validateRange", "getRegion"]) Object.defineProperty(Mem, key, savedMem[key]!);
});

describe("oleaut32 participant", () => {
    test("capture → restore → capture is byte-identical in a fresh module, and the restored arrays are destroyed as before", () => {
        const a = boot();
        const first = createArray(a, 4), second = createArray(a, 8);
        expect(first).toBeGreaterThan(0);
        const saved = structuredClone(a.ole.captureSavestate());
        expect([...saved.safeArrays]).toEqual([first, Mem.readUint32(first + 12)!, second, Mem.readUint32(second + 12)!]);

        const b = boot(0x280000);
        expect(b.ole.captureSavestate().safeArrays.length).toBe(0);
        b.ole.restoreSavestate(saved);
        expect(bytes(b.ole.captureSavestate())).toBe(bytes(saved));
        expect(b.ole.exports.SafeArrayDestroy!({}, memory, [first])).toBe(0);
        expect(b.freed).toEqual([saved.safeArrays[1]!, first]);
        expect([...b.ole.captureSavestate().safeArrays]).toEqual([second, saved.safeArrays[3]!]);
        expect(b.ole.exports.SafeArrayDestroy!({}, memory, [first])).toBe(0);
        expect(b.freed.length).toBe(2);
    });

    test("every instance field has a policy; every saved field reaches the capture and survives a restore", () => {
        expect(Object.keys(new Oleaut32()).sort()).toEqual(Object.keys(OLEAUT32_FIELDS).sort());
        const a = boot();
        createArray(a, 4);
        const base = a.ole.captureSavestate();
        const values: Oleaut32State = { safeArrays: new Uint32Array([0x500000, 0x500040, 0x500080, 0x5000c0]) };
        expect(Object.keys(values).sort()).toEqual(Object.keys(base).sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof Oleaut32State, unknown]>) {
            expect({ field, same: bytes(value) === bytes(base[field]) }).toEqual({ field, same: false });
            const fresh = boot().ole;
            fresh.restoreSavestate(structuredClone({ ...base, [field]: value }) as Oleaut32State);
            expect({ field, value: bytes(fresh.captureSavestate()[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("a SAFEARRAY table of odd length is not restored", () => {
        const a = boot();
        createArray(a, 4);
        expect(() => a.ole.restoreSavestate({ safeArrays: new Uint32Array(3) })).toThrow("oleaut32: a SAFEARRAY table of 3 words is not a list of pairs");
        expect(a.ole.captureSavestate().safeArrays.length).toBe(2);
    });

    test("a loaded type library and a type info refuse the save by kind, address and name until they are released", () => {
        const b = boot();
        const lib = loadTypeLib(b);
        expect(lib).toBeGreaterThan(0);
        const hex = (n: number) => `0x${n.toString(16)}`;
        expect(() => b.ole.captureSavestate()).toThrow(`oleaut32: not idle, 1 thing(s) open: type library ${hex(lib)} "SUN"`);
        expect(b.handlers.TL_GetTypeInfo!({}, memory, [lib, 0, 0x2300])).toBe(0);
        const info = Mem.readUint32(0x2300)!;
        expect(info).toBeGreaterThan(0);
        expect(() => b.ole.captureSavestate()).toThrow(
            `oleaut32: not idle, 2 thing(s) open: type library ${hex(lib)} "SUN", type info ${hex(info)} "BlowfishCipher"`);
        expect(b.handlers.TL_Release!({}, memory, [lib])).toBe(0);
        expect(() => b.ole.captureSavestate()).toThrow(`oleaut32: not idle, 1 thing(s) open: type info ${hex(info)} "BlowfishCipher"`);
        expect(b.handlers.TI_Release!({}, memory, [info])).toBe(0);
        expect(b.ole.captureSavestate()).toEqual({ safeArrays: new Uint32Array(0) });
    });

    test("a second reference keeps the type library open", () => {
        const b = boot();
        const lib = loadTypeLib(b);
        expect(b.handlers.TL_AddRef!({}, memory, [lib])).toBe(2);
        expect(b.handlers.TL_Release!({}, memory, [lib])).toBe(1);
        expect(() => b.ole.captureSavestate()).toThrow("type library");
        expect(b.handlers.TL_Release!({}, memory, [lib])).toBe(0);
        expect(() => b.ole.captureSavestate()).not.toThrow();
    });

    test("more than four open things are counted and the list is cut", () => {
        const b = boot();
        for (let i = 0; i < 6; i++) loadTypeLib(b);
        expect(() => b.ole.captureSavestate()).toThrow(/^oleaut32: not idle, 6 thing\(s\) open: (type library 0x[0-9a-f]+ "SUN", ){4}…$/);
    });

    test("a restore into a session that is not idle fails", () => {
        const saved = boot().ole.captureSavestate();
        const b = boot();
        const lib = loadTypeLib(b);
        expect(() => b.ole.restoreSavestate(saved)).toThrow(`oleaut32: the fresh session is not idle: type library 0x${lib.toString(16)} "SUN"`);
    });

    test("the registered participant covers oleaut32, refuses with a CaptureRefusal and has a pinned schema", () => {
        const b = boot();
        const undo = b.ole.registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("oleaut32")).toBe(true);
            expect(savestateParticipants.schemas().oleaut32).toEqual({ version: 1, schemaHash: "1dd6aade52f87f64" });
            loadTypeLib(b);
            expect(() => savestateParticipants.all().find(p => p.id === "oleaut32")!.capture({} as never)).toThrow(CaptureRefusal);
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("oleaut32")).toBe(false);
    });
});
