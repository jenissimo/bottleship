/**
 * GetProcAddress is scoped by HMODULE, and a name resolves only through a module that
 * really exports it.
 *
 * WaitOnAddress and most AppPolicyGet* live in kernelbase alone: asking kernel32 for them
 * is NULL on Windows, and a runtime probing kernel32 first must see that. The VS2015+ CRT
 * reaches them through api-set contracts instead, which the loader resolves through the
 * ApiSetSchema to the host's module — so LoadLibrary on the contract answers kernelbase's
 * HMODULE, and GetProcAddress on it finds kernelbase's implementation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { materializeHleModuleImages, resetHleModuleImages } from "../../src/worker/core/hle-module-images";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { resetGuestCodeInvalidationState } from "../../src/worker/core/memory/guest-code";
import { MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "../../src/worker/core/cpu/emulator-config";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { System } from "../../src/worker/core/system";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { kernelbaseModule } from "../../src/worker/api/kernelbase.api";
import { resolveThunkedDllAlias } from "../../src/worker/core/dll-aliases";
import { exports as kernel32 } from "../../src/worker/modules/kernel32/module/module";
import { Kernelbase, kernelbaseOwnExports } from "../../src/worker/modules/kernelbase";

const NAME = 0x10000;       // guest scratch for strings
const ESP = 0x11000;
const OUT = 0x12000;
const ADDR = 0x12100;
const CMP = 0x12110;

let mem: Uint8Array;
let dv: DataView;
let gen: ThunkGenerator;
let savedExports: unknown;
let savedProcess: unknown;

function writeAnsi(at: number, s: string): number {
    for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i);
    mem[at + s.length] = 0;
    return at;
}

function call(name: string, ...args: number[]): number {
    const r = kernel32[name]!({ esp: ESP, eip: 0 } as never, mem, args) as any;
    return (typeof r === "number" ? r : r.value) >>> 0;
}

const loadLibrary = (dll: string) => call("LoadLibraryA", writeAnsi(NAME, dll));
const getProcAddress = (hModule: number, proc: string) => call("GetProcAddress", hModule, writeAnsi(NAME + 0x200, proc));

beforeAll(() => {
    APIRegistry.getInstance().registerModule(kernel32Module);
    APIRegistry.getInstance().registerModule(kernelbaseModule);
    mem = new Uint8Array(MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE);
    dv = new DataView(mem.buffer);
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
    const process: any = {
        thunkGenerator: gen, resetGeneration: Math.random(), lastError: 0,
        dispatcher: { thunkGenerator: gen, pendingRegistrations: new Map() },
        getCurrentMemory: () => mem,
    };
    (System.getInstance() as any).process = process;
    materializeHleModuleImages(process);
});

/** The export a resolved address leads to, as the dispatcher would bind it. */
function exportAt(address: number): { dll: string; name: string } | null {
    const stub = gen.getStubByAddress(address);
    return stub ? { dll: stub.dllName.toLowerCase(), name: stub.functionName } : null;
}

describe("api-set contracts resolve to their host", () => {
    test("the schema, not a per-name list, decides the host; the patch number is ignored", () => {
        expect(resolveThunkedDllAlias("api-ms-win-core-synch-l1-2-0.dll")).toBe("kernelbase");
        expect(resolveThunkedDllAlias("API-MS-WIN-CORE-SYNCH-L1-2-1")).toBe("kernelbase");
        expect(resolveThunkedDllAlias("api-ms-win-appmodel-runtime-l1-1-2")).toBe("kernelbase");
        expect(resolveThunkedDllAlias("api-ms-win-core-processthreads-l1-1-2")).toBe("kernel32");
        expect(resolveThunkedDllAlias("ext-ms-win-ntuser-dialogbox-l1-1-0")).toBe("user32");
        expect(resolveThunkedDllAlias("api-ms-win-crt-runtime-l1-1-0")).toBe("msvcrt");
        expect(resolveThunkedDllAlias("api-ms-win-core-no-such-contract-l1-1-0")).toBe("api-ms-win-core-no-such-contract-l1-1-0");
    });
});

describe("GetProcAddress scoping", () => {
    test("kernel32 does not export WaitOnAddress or the kernelbase-only AppPolicy calls", () => {
        const k32 = loadLibrary("kernel32.dll");
        expect(k32).not.toBe(0);
        expect(getProcAddress(k32, "WaitOnAddress")).toBe(0);
        expect(getProcAddress(k32, "WakeByAddressSingle")).toBe(0);
        expect(getProcAddress(k32, "AppPolicyGetProcessTerminationMethod")).toBe(0);
        // kernel32 does forward this one.
        expect(getProcAddress(k32, "AppPolicyGetWindowingModel")).not.toBe(0);
    });

    test("the synch contract loads as kernelbase and resolves a working WaitOnAddress", () => {
        const kb = loadLibrary("kernelbase.dll");
        const synch = loadLibrary("api-ms-win-core-synch-l1-2-0.dll");
        expect(kb).not.toBe(0);
        expect(synch).toBe(kb);

        const viaContract = getProcAddress(synch, "WaitOnAddress");
        const viaKernelbase = getProcAddress(kb, "WaitOnAddress");
        expect(viaContract).not.toBe(0);
        expect(viaContract).toBe(viaKernelbase);
        expect(exportAt(viaContract)).toEqual({ dll: "kernelbase", name: "WaitOnAddress" });

        // The handler kernelbase binds under that name: a differing value returns TRUE.
        const module = new Kernelbase();
        module.setHosts([{ exports: kernel32 }]);
        module.initialize({} as never);
        expect(module.exports["WaitOnAddress"]).toBe(kernelbaseOwnExports["WaitOnAddress"]);
        dv.setUint32(ADDR, 1, true);
        dv.setUint32(CMP, 2, true);
        const r = module.exports["WaitOnAddress"]!({ esp: ESP } as never, mem, [ADDR, CMP, 4, 0]) as any;
        expect(r.value).toBe(1);
    });

    test("kernelbase also exports the classic names it shares with kernel32, with ONE handler", () => {
        const kb = loadLibrary("kernelbase.dll");
        expect(exportAt(getProcAddress(kb, "InitializeCriticalSectionEx"))?.name).toBe("InitializeCriticalSectionEx");
        // A kernel32-only name is not a kernelbase export.
        expect(getProcAddress(kb, "WinExec")).toBe(0);

        const module = new Kernelbase();
        module.setHosts([{ exports: kernel32 }]);
        module.initialize({} as never);
        expect(module.exports["GetProcAddress"]).toBe(kernel32["GetProcAddress"]);
    });

    test("AppPolicyGetProcessTerminationMethod through the appmodel contract answers ExitProcess", () => {
        const appmodel = loadLibrary("api-ms-win-appmodel-runtime-l1-1-2.dll");
        const address = getProcAddress(appmodel, "AppPolicyGetProcessTerminationMethod");
        expect(exportAt(address)).toEqual({ dll: "kernelbase", name: "AppPolicyGetProcessTerminationMethod" });

        dv.setUint32(OUT, 0xDEADBEEF, true);
        const r = kernelbaseOwnExports["AppPolicyGetProcessTerminationMethod"]!(
            { esp: ESP } as never, mem, [0xFFFFFFFC, OUT]) as any;
        expect(r.value).toBe(0);                        // ERROR_SUCCESS
        expect(dv.getUint32(OUT, true)).toBe(0);        // AppPolicyProcessTerminationMethod_ExitProcess
    });
});
