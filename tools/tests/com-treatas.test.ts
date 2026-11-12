import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import type { Process } from "../../src/worker/core/process";
import type { ThunkResult } from "../../src/worker/core/thunking/thunk-dispatcher";
import { RegistryStore } from "../../src/worker/runtime/filesystem/registry";
import { tryInprocCoCreateInstance } from "../../src/worker/core/com/inproc-com";

const ORIGINAL = "11111111-2222-3333-4455-66778899aabb";
const TARGET = "aabbccdd-eeff-1234-5678-90abcdef1234";
const system = System.getInstance();
let savedRegistry: typeof system.registry;
let savedMemoryGetter: typeof Mem.memoryGetter;
let mem: Uint8Array;
let process: Process;
let calls: { address: number; args: number[]; complete: (hr: number) => number | null }[];
let loaded: string[];
let freed: number[];
let alreadyLoaded: boolean;
let missingExport: boolean;
let failLoad: boolean;

function seed(clsid: string, key: string, data: string | number, type = "REG_SZ") {
    system.registry.seed({ root: "HKEY_CLASSES_ROOT", path: `CLSID\\{${clsid}}\\${key}`,
        values: [{ name: "", type, data }] });
}
function guidBytes(guid: string): number[] {
    const [a, b, c, d, e] = guid.split("-");
    return [a.slice(6, 8), a.slice(4, 6), a.slice(2, 4), a.slice(0, 2),
        b.slice(2, 4), b.slice(0, 2), c.slice(2, 4), c.slice(0, 2),
        ...((d + e).match(/../g) ?? [])].map(byte => parseInt(byte, 16));
}
function activate() {
    return tryInprocCoCreateInstance(process, { esp: 0x2000 }, mem,
        { rclsid: 0x100, riid: 0x200, ppv: 0x300, clsidNormalized: ORIGINAL });
}
function completeCreation() {
    const first = calls.at(-1)!;
    const scratch = first.args[1];
    expect(Array.from(mem.slice(first.args[0], first.args[0] + 16))).toEqual(guidBytes(TARGET));
    expect(Array.from(mem.slice(0x100, 0x110))).toEqual(guidBytes(ORIGINAL));
    Mem.writeUint32(0x8000, 0x8100);
    Mem.writeUint32(0x8108, 0x9010);
    Mem.writeUint32(0x810c, 0x9020);
    Mem.writeUint32(first.args[2], 0x8000);
    expect(first.complete(0)).toBeNull();
    expect(calls.at(-1)!.address).toBe(0x9020);
    expect(calls.at(-1)!.args).toEqual([0x8000, 0, 0x200, 0x300]);
    Mem.writeUint32(0x300, 0xbeef);
    expect(calls.at(-1)!.complete(0)).toBeNull();
    expect(calls.at(-1)!.address).toBe(0x9010);
    expect(calls.at(-1)!.complete(0)).toBe(0);
    expect(Mem.readUint32(0x300)).toBe(0xbeef);
    expect(freed).toContain(scratch);
}

beforeEach(() => {
    savedRegistry = system.registry;
    savedMemoryGetter = Mem.memoryGetter;
    system.registry = new RegistryStore();
    mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);
    mem.set(guidBytes(ORIGINAL), 0x100);
    Mem.writeUint32(0x2000, 0x1234);
    calls = []; loaded = []; freed = [];
    alreadyLoaded = true; missingExport = false; failLoad = false;
    let next = 0x10000;
    process = {
        memory: { alloc: (size: number) => { const ptr = next; next += size; return ptr; },
            free: (ptr: number) => { freed.push(ptr); } },
        moduleRegistry: {
            getByName: (name: string) => { loaded.push(name); return alreadyLoaded ? { name } : undefined; },
            getExportAddress: () => missingExport ? 0 : 0x9000,
        },
        loader: {
            loadDll: async (name: string) => { loaded.push(name); if (failLoad) throw new Error("load failed"); return { name }; },
            getPendingDllInits: () => [],
        },
        dispatcher: { callbackManager: {
            saveSuspendedThunkContext: () => 1,
            invokeCallback: (address: number, args: number[], _cleanup: number,
                complete: (hr: number) => number | null) => {
                calls.push({ address, args, complete }); return { callbackId: calls.length };
            },
        } },
    } as unknown as Process;
    seed(ORIGINAL, "InprocServer32", "original.dll");
    seed(TARGET, "InprocServer32", "target.dll");
});
afterEach(() => { system.registry = savedRegistry; Mem.bind(savedMemoryGetter); });

test("TreatAs selects the target DLL and passes its CLSID through the complete factory chain", () => {
    seed(ORIGINAL, "TreatAs", `{${TARGET.toUpperCase()}}`);
    expect((activate() as ThunkResult).suspendedForCallback).toBe(true);
    expect(loaded).toEqual(["target.dll"]);
    completeCreation();
    expect(freed).toHaveLength(1);
});

test("async activation defers guest callbacks until the dispatcher safe point", async () => {
    seed(ORIGINAL, "TreatAs", TARGET);
    alreadyLoaded = false;
    const result = await activate();
    expect(calls).toHaveLength(0);
    expect(freed).toHaveLength(0);
    expect(loaded).toEqual(["target.dll", "target.dll"]);
    expect(result!.startCallbackChain!({ esp: 0x2000, returnAddr: 0x1234, mem })).toBe(true);
    completeCreation();
    expect(freed).toHaveLength(1);
});

test("without TreatAs, the original DLL and CLSID are retained", () => {
    activate();
    expect(loaded).toEqual(["original.dll"]);
    const first = calls[0]!;
    expect(Array.from(mem.slice(first.args[0], first.args[0] + 16))).toEqual(guidBytes(ORIGINAL));
    expect(first.complete(0x80004005)).toBe(0x80004005);
    expect(freed).toHaveLength(1);
});

test("malformed or non-string entries preserve the existing activation path", () => {
    for (const [data, type] of [["not-a-guid", "REG_SZ"], [42, "REG_DWORD"]] as const) {
        seed(ORIGINAL, "TreatAs", data, type);
        expect((activate() as ThunkResult).suspendedForCallback).toBe(true);
        const first = calls.at(-1)!;
        expect(Array.from(mem.slice(first.args[0], first.args[0] + 16))).toEqual(guidBytes(ORIGINAL));
        first.complete(0x80040111);
    }
    expect(loaded).toEqual(["original.dll", "original.dll"]);
});

test("an unregistered target fails rather than using the original class", () => {
    seed(ORIGINAL, "TreatAs", "99999999-2222-3333-4455-66778899aabb");
    Mem.writeUint32(0x300, 0xbeef);
    expect(activate()).toEqual({ value: 0x80040154, stackCleanup: 20 });
    expect(Mem.readUint32(0x300)).toBe(0);
    expect(calls).toHaveLength(0);
});

test("failed class lookup frees scratch and the next activation reads the current registry", () => {
    seed(ORIGINAL, "TreatAs", TARGET);
    activate();
    expect(calls[0]!.complete(0x80040111)).toBe(0x80040111);
    expect(freed).toHaveLength(1);
    seed(ORIGINAL, "TreatAs", ORIGINAL);
    activate();
    expect(loaded).toEqual(["target.dll", "original.dll"]);
    const last = calls.at(-1)!;
    expect(Array.from(mem.slice(last.args[0], last.args[0] + 16))).toEqual(guidBytes(ORIGINAL));
    last.complete(0x80040111);
    expect(freed).toHaveLength(2);
});

test("a redirected DLL without a class export cannot fall back to the original class", async () => {
    seed(ORIGINAL, "TreatAs", TARGET);
    missingExport = true;
    expect(await activate()).toEqual({ value: 0x80040154, stackCleanup: 20 });
    alreadyLoaded = false;
    expect(await activate()).toEqual({ value: 0x80040154, stackCleanup: 20 });
    missingExport = false; failLoad = true;
    expect(await activate()).toEqual({ value: 0x80040154, stackCleanup: 20 });
    expect(calls).toHaveLength(0);
});
