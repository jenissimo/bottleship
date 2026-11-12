import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { Ole32, OLE32_FIELDS, type Ole32State } from "../../src/worker/modules/ole32";
import { comApartments } from "../../src/worker/core/com/apartment";
import { ThunkGenerator, type ThunkGeneratorState } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import { System } from "../../src/worker/core/system";
import { comVtableOwner, registerComVtableOwner } from "../../src/worker/core/com/com-memory";
import { registerHleComServer } from "../../src/worker/core/com/hle-com-registry";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Handler = (ctx: unknown, mem: Uint8Array, args: number[]) => number;
type Internals = Record<string, unknown> & { exports: Record<string, Handler> };

let memory: Uint8Array;
let servers = new Map<string, { held: boolean }>();

interface Booted { ole: Ole32 & Internals; handlers: Map<string, Record<string, Handler>>; generator: ThunkGenerator; allocs: () => number }

function boot(thunks?: ThunkGeneratorState, heapStart = 0x100000): Booted {
    let next = heapStart;
    const generator = new ThunkGenerator();
    generator.setBaseAddress(0x1000);
    if (thunks) generator.restoreState(thunks);
    const handlers = new Map<string, Record<string, Handler>>();
    let allocs = 0;
    const alloc = (size: number) => { allocs++; const p = next; next += (Math.max(4, size) + 3) & ~3; return p; };
    const ole = new Ole32() as Ole32 & Internals;
    ole.process = {
        memory: { alloc, allocAt: () => undefined, allocSystemBlock: alloc, freeSystemBlock: () => undefined },
        dispatcher: { registerModule: (name: string, h: Record<string, Handler>) => { handlers.set(name, h); }, applyPendingRegistrations: () => undefined },
        thunkGenerator: generator,
        getCurrentMemory: () => memory,
    };
    for (const name of ["dplayx", "dpnet", "quartz"]) {
        const server = {
            descriptor: { name }, held: false,
            get holdsLoaderReference() { return this.held; },
            acquireLoaderReference() { this.held = true; return true; },
            releaseLoaderReference() { this.held = false; },
            releaseUnusedLoaderReference() { this.held = false; },
        };
        registerHleComServer(ole.process as never, server as never, [{ clsid: `00000000-0000-0000-0000-${name.padStart(12, "0")}`, interfaces: [] }]);
        servers.set(name, server);
    }
    return { ole, handlers, generator, allocs: () => allocs };
}

function used(): Booted {
    const b = boot();
    const { ole } = b;
    ole.guidState = 0x1234abcd;
    ole.guidCounter = 9;
    ole.nextClassRegistration = 0x1003;
    ole.messageFilter = 0x402000;
    (ole.classRegistrations as Map<number, unknown>).set(0x1001, { clsid: "11111111-2222-3333-4444-555555555555", punk: 0x403000, flags: 1 });
    (ole.taskMemSizes as Map<number, number>).set(0x500000, 32).set(0x500040, 8);
    (ole.dragDropRegistrations as { restoreState(rows: Array<[number, number]>): void }).restoreState([[0x10001, 0x404000]]);
    comApartments.restoreState([[1, "sta", 2, 1], [5, "mta", 1, 0]]);
    servers.get("dplayx")!.held = true;
    return b;
}

beforeEach(() => {
    memory = new Uint8Array(0x400000);
    Mem.bind(() => memory, (a, s) => a >= 0 && a + s <= memory.length);
    comApartments.reset();
});
afterEach(() => {
    comApartments.reset();
});

describe("ole32 participant", () => {
    test("capture → restore → capture is byte-identical in a fresh module", () => {
        const first = used().ole.captureSavestate();
        comApartments.reset();
        const fresh = boot().ole;
        fresh.restoreSavestate(structuredClone(first));
        expect(bytes(fresh.captureSavestate())).toBe(bytes(first));
        expect(comApartments.isOleInitialized(1)).toBe(true);
        expect(comApartments.model(5)).toBe("mta");
    });

    test("every instance field has a policy", () => {
        expect(Object.keys(new Ole32()).sort()).toEqual(Object.keys(OLE32_FIELDS).sort());
    });

    test("every saved field reaches the capture and survives a restore", () => {
        const base = used().ole.captureSavestate();
        const boxes = new Uint32Array(18 + 1024).fill(7);
        const values: Record<keyof Ole32State, unknown> = {
            guidState: 1, guidCounter: 2, nextClassRegistration: 0x2000, messageFilter: 0x405000,
            classRegistrations: [[0x1005, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", 0x406000, 4]],
            taskMemSizes: new Uint32Array([0x600000, 16]), mallocObjAddr: 0, blowfishVtableAddr: 0,
            blowfishInstances: [[0x700000, 3, boxes]], dragDropRegistrations: [[0x10002, 0x407000], [0x10003, 0x408000]],
            apartments: [[2, "mta", 1, 0]], comServerLoads: ["dpnet", "quartz"],
        };
        expect(Object.keys(values).sort()).toEqual(Object.keys(base).sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof Ole32State, unknown]>) {
            if (field === "mallocObjAddr" || field === "blowfishVtableAddr") continue;
            expect({ field, same: bytes(value) === bytes(base[field]) }).toEqual({ field, same: false });
            comApartments.reset();
            const fresh = boot().ole;
            fresh.restoreSavestate(structuredClone({ ...base, [field]: value }) as Ole32State);
            expect({ field, value: bytes(fresh.captureSavestate()[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("the IMalloc singleton keeps its address and answers again after a restore into a fresh thunk table", () => {
        const a = used();
        const obj = (a.ole.ensureTaskMalloc as (m: Uint8Array) => number)(memory);
        expect(obj).toBeGreaterThan(0);
        const vtable = Mem.readUint32(obj)!;
        const slots = Array.from({ length: 9 }, (_, i) => Mem.readUint32(vtable + i * 4)!);
        const system = System.getInstance();
        const previous = system.process;
        system.process = a.ole.process as never;
        const block = a.handlers.get("ole32_imalloc")!.Malloc_Alloc!({}, memory, [obj, 24]);
        system.process = previous;
        expect(block).toBeGreaterThan(0);
        const saved = structuredClone(a.ole.captureSavestate());
        const thunks = structuredClone(a.generator.captureState());
        expect(saved.mallocObjAddr).toBe(obj);

        comApartments.reset();
        const b = boot(thunks, 0x200000);
        expect(b.handlers.has("ole32_imalloc")).toBe(false);
        b.ole.restoreSavestate(saved);
        expect(b.ole.mallocObjAddr).toBe(obj);
        const h = b.handlers.get("ole32_imalloc")!;
        expect(h.Malloc_GetSize!({}, memory, [obj, block])).toBe(24);
        expect(h.Malloc_DidAlloc!({}, memory, [obj, block])).toBe(1);
        expect((b.ole.ensureTaskMalloc as (m: Uint8Array) => number)(memory)).toBe(obj);
        expect(Array.from({ length: 9 }, (_, i) => Mem.readUint32(vtable + i * 4)!)).toEqual(slots);
        const again = b.generator.generateStubDll("ole32_imalloc", [{ name: "Malloc_Alloc", argCount: 2, stackCleanupBytes: 8, callingConvention: "stdcall" }]);
        expect(again.stubCode.length).toBe(0);
        expect(again.exportTable.get("malloc_alloc")).toBe(slots[3]);
    });

    test("a keyed Blowfish object decrypts after a restore what it encrypted before the save", () => {
        const a = used();
        const obj = (a.ole.createBlowfishObject as (m: Uint8Array, v: DataView, ppv: number) => number)(memory, new DataView(memory.buffer), 0);
        expect(obj).toBeGreaterThan(0);
        const bf = a.handlers.get("ole32_blowfish")!;
        memory.set([1, 2, 3, 4, 5, 6, 7, 8], 0x300000);
        expect(bf.BF_Submit_Key!({}, memory, [obj, 8, 0x300000])).toBe(0);
        memory.set(new TextEncoder().encode("savestat"), 0x300100);
        expect(bf.BF_Encrypt!({}, memory, [obj, 8, 0x300100, 0x300200])).toBe(0);
        const cipherText = [...memory.subarray(0x300200, 0x300208)];
        expect(cipherText).not.toEqual([...memory.subarray(0x300100, 0x300108)]);
        const saved = structuredClone(a.ole.captureSavestate());
        const thunks = structuredClone(a.generator.captureState());
        expect(saved.blowfishInstances.length).toBe(1);

        comApartments.reset();
        const b = boot(thunks, 0x200000);
        b.ole.restoreSavestate(saved);
        expect(b.ole.blowfishVtableAddr).toBe(saved.blowfishVtableAddr);
        const restored = b.handlers.get("ole32_blowfish")!;
        expect(restored.BF_Decrypt!({}, memory, [obj, 8, 0x300200, 0x300300])).toBe(0);
        expect(new TextDecoder().decode(memory.subarray(0x300300, 0x300308))).toBe("savestat");
        expect(restored.BF_Release!({}, memory, [obj])).toBe(0);
        expect((b.ole.blowfishInstances as Map<number, unknown>).size).toBe(0);
    });

    test("a restore binds the saved IMalloc and Blowfish vtables without allocating", () => {
        const a = used();
        const malloc = (a.ole.ensureTaskMalloc as (m: Uint8Array) => number)(memory);
        const blowfish = (a.ole.createBlowfishObject as (m: Uint8Array, v: DataView, ppv: number) => number)(memory, new DataView(memory.buffer), 0);
        const mallocVtable = Mem.readUint32(malloc)!;
        const blowfishVtable = Mem.readUint32(blowfish)!;
        const saved = structuredClone(a.ole.captureSavestate());
        const thunks = structuredClone(a.generator.captureState());
        expect(saved.blowfishVtableAddr).toBe(blowfishVtable);
        registerComVtableOwner(mallocVtable, "stale");
        registerComVtableOwner(blowfishVtable, "stale");
        const image = memory.slice();

        for (let load = 0; load < 2; load++) {
            comApartments.reset();
            const b = boot(thunks, 0x200000);
            b.ole.restoreSavestate(structuredClone(saved));
            expect(b.allocs()).toBe(0);
            expect(b.handlers.has("ole32_imalloc")).toBe(true);
            expect(b.handlers.has("ole32_blowfish")).toBe(true);
            expect(comVtableOwner(mallocVtable)).toBe("ole32_imalloc");
            expect(comVtableOwner(blowfishVtable)).toBe("ole32_blowfish");
            expect(comVtableOwner(0x200000)).toBe("unknown");
            expect(b.ole.blowfishVtableAddr).toBe(blowfishVtable);
            expect(bytes(b.ole.captureSavestate())).toBe(bytes(saved));
            expect(memory).toEqual(image);
            registerComVtableOwner(mallocVtable, "stale");
            registerComVtableOwner(blowfishVtable, "stale");
        }
    });

    test("a saved vtable that does not hold the restored stubs is not bound", () => {
        const a = used();
        const malloc = (a.ole.ensureTaskMalloc as (m: Uint8Array) => number)(memory);
        const saved = structuredClone(a.ole.captureSavestate());
        const thunks = structuredClone(a.generator.captureState());
        Mem.writeUint32(Mem.readUint32(malloc)! + 12, 0xdead0000);
        expect(() => boot(thunks, 0x200000).ole.restoreSavestate(saved)).toThrow("IMalloc handlers could not be installed");
    });

    test("a Blowfish state of the wrong size is not restored", () => {
        const saved = used().ole.captureSavestate();
        saved.blowfishInstances = [[0x700000, 1, new Uint32Array(4)]];
        expect(() => boot().ole.restoreSavestate(saved)).toThrow("Blowfish state of 4 words");
    });

    test("the registered participant covers ole32 and has a pinned schema", () => {
        const { ole } = used();
        const undo = ole.registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("ole32")).toBe(true);
            expect(savestateParticipants.schemas().ole32).toEqual({ version: 2, schemaHash: "0f1a20eac3ad8590" });
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("ole32")).toBe(false);
    });
});
