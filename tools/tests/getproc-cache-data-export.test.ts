/**
 * The boot-time GetProcAddress cache answers what the IAT binds.
 *
 * An importer that resolves its imports at run time (a UPX-packed DLL resolves EVERY import
 * through GetProcAddress) must get the address the PE loader would have written into its
 * IAT. For a data export that is not merely the same code at a second address: msvcrt's
 * qsort keeps a declared stub whose handler returns without sorting, while the registered
 * data export is the native sort. Seeding the cache with the stub made FMOD's embedded
 * libvorbis build its codebooks from unsorted tables.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { hleImageBase, materializeHleModuleImages, resetHleModuleImages } from "../../src/worker/core/hle-module-images";
import { hleExportBindingAddress } from "../../src/worker/core/thunking/export-resolver";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { resetGuestCodeInvalidationState } from "../../src/worker/core/memory/guest-code";
import { MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "../../src/worker/core/cpu/emulator-config";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { System } from "../../src/worker/core/system";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import { exports as kernel32, prePopulateGetProcAddressCache } from "../../src/worker/modules/kernel32/module/module";

const NAME = 0x10000;
const ESP = 0x11000;
/** Stands in for the native qsort body msvcrt publishes through registerDataExport. */
const NATIVE_QSORT = 0x21030000;

let mem: Uint8Array;
let gen: ThunkGenerator;
let dispatcher: any;
let savedExports: unknown;
let savedProcess: unknown;

function getProcAddress(hModule: number, proc: string): number {
    for (let i = 0; i < proc.length; i++) mem[NAME + i] = proc.charCodeAt(i);
    mem[NAME + proc.length] = 0;
    const r = kernel32["GetProcAddress"]!({ esp: ESP, eip: 0 } as never, mem, [hModule, NAME]) as any;
    return (typeof r === "number" ? r : r.value) >>> 0;
}

beforeAll(() => {
    APIRegistry.getInstance().registerModule(kernel32Module);
    APIRegistry.getInstance().registerModule(msvcrtModule);
    mem = new Uint8Array(MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE);
    Mem.bind(() => mem);
    savedExports = (preemptionManager as unknown as { wasmExports: unknown }).wasmExports;
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = {
        jit_dirty_cache: () => { }, jit_clear_cache_js: () => { },
    };
    savedProcess = System.getInstance().process;
});

afterAll(() => {
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = savedExports;
    (System.getInstance() as any).process = savedProcess;
    resetGuestCodeInvalidationState();
    resetHleModuleImages();
});

beforeEach(() => {
    gen = new ThunkGenerator();
    gen.setBaseAddress(0x21046000);
    dispatcher = { thunkGenerator: gen, pendingRegistrations: new Map() };
    const process: any = {
        thunkGenerator: gen, resetGeneration: Math.random(), lastError: 0, dispatcher,
        getCurrentMemory: () => mem,
    };
    (System.getInstance() as any).process = process;
    materializeHleModuleImages(process);
    gen.registerDataExport("msvcrt", "qsort", NATIVE_QSORT);
    prePopulateGetProcAddressCache(dispatcher);
});

describe("pre-populated GetProcAddress cache", () => {
    test("a data export answers its registered address, not the declared stub", () => {
        const msvcrt = hleImageBase("msvcrt")!;
        expect(msvcrt).toBeDefined();
        // The declared stub exists — that is what the cache used to be seeded with.
        expect(gen.getAllStubs().some((s: any) => s.dllName.toLowerCase() === "msvcrt" && s.functionName === "qsort")).toBe(true);
        expect(getProcAddress(msvcrt, "qsort")).toBe(NATIVE_QSORT);
        expect(getProcAddress(msvcrt, "qsort")).toBe(hleExportBindingAddress(gen, "msvcrt", "qsort")!);
    });

    test("an ordinary export answers the same address the IAT binds", () => {
        const msvcrt = hleImageBase("msvcrt")!;
        const bound = hleExportBindingAddress(gen, "msvcrt", "strlen");
        expect(bound).toBeDefined();
        expect(getProcAddress(msvcrt, "strlen")).toBe(bound!);
    });
});
