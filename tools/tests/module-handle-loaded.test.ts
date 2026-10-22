import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { hleImageBase, isHleModuleLoaded, loadedHleModules, markHleModuleLoaded, materializeHleModuleImages, resetHleModuleImages } from "../../src/worker/core/hle-module-images";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { resetGuestCodeInvalidationState } from "../../src/worker/core/memory/guest-code";
import { MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "../../src/worker/core/cpu/emulator-config";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { ModuleRegistry, type LoadedPEModule } from "../../src/worker/core/module-registry";
import { System } from "../../src/worker/core/system";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { exports as kernel32, registerFastPathModuleFunctions } from "../../src/worker/modules/kernel32/module/module";

const NAME = 0x10000, OUT = 0x10800, ESP = 0x11000, EXE = 0x400000;
let mem: Uint8Array;
let process: any;
let savedProcess: unknown, savedExports: unknown, savedExe: string;
let savedDisabled: string[], savedAppDir: string[];
let memoryDescriptors: PropertyDescriptorMap;
const apis = ["GetModuleHandleA", "GetModuleHandleW", "GetModuleHandleExA", "GetModuleHandleExW"] as const;
const config = EmulatorConfig.getInstance();
function module(name: string, baseAddress: number, executable = false): LoadedPEModule {
    return { name, path: "C:\\game\\" + name, baseAddress, size: 0x2000, entryPoint: 0,
        exports: new Map(), ordinalExports: new Map(), isRealDll: !executable, isExecutable: executable, initialized: true };
}
function writeName(value: string, wide: boolean): number {
    const view = new DataView(mem.buffer);
    for (let i = 0; i <= value.length; i++) {
        const byte = value.charCodeAt(i) || 0;
        if (wide) view.setUint16(NAME + i * 2, byte, true);
        else mem[NAME + i] = byte;
    }
    return NAME;
}
function call(api: string, args: number[]): any {
    return kernel32[api]!({ esp: ESP, eip: 0 } as never, mem, args);
}
function lookup(api: typeof apis[number], name: string | null): number {
    const pointer = name === null ? 0 : writeName(name, api.endsWith("W"));
    if (!api.includes("Ex")) return call(api, [pointer]).value;
    new DataView(mem.buffer).setUint32(OUT, 0xdeadbeef, true);
    const result = call(api, [0, pointer, OUT]);
    const handle = new DataView(mem.buffer).getUint32(OUT, true);
    expect(result.value).toBe(handle ? 1 : 0);
    return handle;
}
function fast(name: string): number | null {
    let implementation: any;
    registerFastPathModuleFunctions({ registerFastPath: (_dll: string, _name: string, impl: unknown) => { implementation = impl; } } as never);
    new DataView(mem.buffer).setUint32(ESP + 4, writeName(name, false), true);
    return implementation(ESP, new DataView(mem.buffer), mem);
}
beforeAll(() => {
    APIRegistry.getInstance().registerModule(kernel32Module);
    mem = new Uint8Array(MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE);
    memoryDescriptors = Object.getOwnPropertyDescriptors(Mem);
    Mem.bind(() => mem);
    savedProcess = System.getInstance().process;
    savedExe = System.getInstance().executableName;
    savedExports = (preemptionManager as any).wasmExports;
    (preemptionManager as any).wasmExports = { jit_dirty_cache: () => {}, jit_clear_cache_js: () => {} };
    savedDisabled = config.disabledDlls;
    savedAppDir = config.appDirDlls;
});
afterAll(() => {
    (System.getInstance() as any).process = savedProcess;
    System.getInstance().executableName = savedExe;
    (preemptionManager as any).wasmExports = savedExports;
    config.disabledDlls = savedDisabled;
    config.appDirDlls = savedAppDir;
    for (const key of ["memoryGetter", "validateRange", "getRegion"]) Object.defineProperty(Mem, key, memoryDescriptors[key]!);
    resetGuestCodeInvalidationState();
    resetHleModuleImages();
});
beforeEach(() => {
    config.disabledDlls = [];
    config.appDirDlls = [];
    const gen = new ThunkGenerator();
    gen.setBaseAddress(0x21046000);
    const registry = new ModuleRegistry();
    registry.register(module("game.exe", EXE, true));
    process = { thunkGenerator: gen, resetGeneration: 0, lastError: 0, moduleRegistry: registry,
        dispatcher: { thunkGenerator: gen, pendingRegistrations: new Map() }, getCurrentMemory: () => mem };
    (System.getInstance() as any).process = process;
    System.getInstance().executableName = "game.exe";
    materializeHleModuleImages(process);
});

describe("GetModuleHandle observes loaded HLE images without loading them", () => {
    for (const api of apis) {
        test(api + " rejects merely materialized DLLs and leaves the loader set unchanged", () => {
            const before = loadedHleModules();
            for (const name of ["ws2_32.dll", "wsock32.dll", "user32.dll"]) {
                expect(hleImageBase(name)).toBeDefined();
                expect(lookup(api, name)).toBe(0);
                expect(process.lastError).toBe(126);
                expect(isHleModuleLoaded(name)).toBe(false);
            }
            expect(loadedHleModules()).toEqual(before);
        });
        test(api + " observes an import and preserves native registry priority", () => {
            markHleModuleLoaded("ws2_32.dll");
            process.lastError = 1234;
            expect(lookup(api, "C:\\Windows\\System32\\WS2_32.DLL")).toBe(hleImageBase("ws2_32"));
            expect(process.lastError).toBe(1234);
            expect(isHleModuleLoaded("wsock32")).toBe(false);
            process.moduleRegistry.register(module("ws2_32.dll", 0x12000000));
            expect(lookup(api, "ws2_32.dll")).toBe(0x12000000);
            expect(lookup(api, null)).toBe(EXE);
        });
    }
    for (const api of ["LoadLibraryA", "LoadLibraryW", "LoadLibraryExA", "LoadLibraryExW"]) {
        test(api + " marks a successful explicit load so later lookups can find it", async () => {
            const name = writeName("ws2_32.dll", api.endsWith("W"));
            const result = await call(api, api.includes("Ex") ? [name, 0, 0] : [name]);
            expect(result.value).toBe(hleImageBase("ws2_32"));
            expect(isHleModuleLoaded("ws2_32")).toBe(true);
            for (const getter of apis) expect(lookup(getter, "ws2_32.dll")).toBe(result.value);
            expect(isHleModuleLoaded("wsock32")).toBe(false);
        });
        test(api + " cannot mark a DLL loaded before a disabled-rule rejection", async () => {
            config.disabledDlls = ["ws2_32"];
            const name = writeName("ws2_32.dll", api.endsWith("W"));
            expect((await call(api, api.includes("Ex") ? [name, 0, 0] : [name])).value).toBe(0);
            expect(process.lastError).toBe(126);
            expect(isHleModuleLoaded("ws2_32")).toBe(false);
        });
    }
    test("an alias with its own image needs its original name recorded by LoadLibrary", async () => {
        markHleModuleLoaded("dinput");
        expect(isHleModuleLoaded("dinput8")).toBe(false);
        for (const api of apis) expect(lookup(api, "dinput8.dll")).toBe(0);
        const result = await call("LoadLibraryA", [writeName("dinput8.dll", false)]);
        expect(result.value).toBe(hleImageBase("dinput"));
        expect(isHleModuleLoaded("dinput8")).toBe(true);
        for (const api of apis) expect(lookup(api, "dinput8.dll")).toBe(result.value);
    });
    test("the fast path declines an unloaded image without changing loader membership", () => {
        expect(fast("ws2_32.dll")).toBeNull();
        expect(isHleModuleLoaded("ws2_32")).toBe(false);
        expect(lookup("GetModuleHandleA", "ws2_32.dll")).toBe(0);
        markHleModuleLoaded("ws2_32");
        expect(fast("ws2_32.dll")).toBe(hleImageBase("ws2_32"));
        expect(fast("wsock32.dll")).toBeNull();
        expect(isHleModuleLoaded("wsock32")).toBe(false);
        config.disabledDlls = ["ws2_32"];
        expect(fast("ws2_32.dll")).toBeNull();
        expect(lookup("GetModuleHandleA", "ws2_32.dll")).toBe(0);
    });
    test("fast lookup falls through for native/appdir shadow policy", () => {
        markHleModuleLoaded("dinput");
        process.moduleRegistry.register(module("dinput.dll", 0x12000000));
        expect(fast("dinput.dll")).toBeNull();
        expect(lookup("GetModuleHandleA", "dinput.dll")).toBe(0x12000000);
        markHleModuleLoaded("ddraw");
        config.appDirDlls = ["ddraw"];
        process.loader = { findDllPath: () => "C:\\game\\ddraw.dll" };
        expect(fast("ddraw.dll")).toBeNull();
    });
    for (const api of ["GetModuleHandleExA", "GetModuleHandleExW"]) {
        test(api + " FROM_ADDRESS rejects unknown/unloaded images and accepts loaded ranges", () => {
            const view = new DataView(mem.buffer);
            const address = hleImageBase("ws2_32")! + 0x120;
            for (const missing of [address, 0x12345678]) {
                view.setUint32(OUT, 0xdeadbeef, true);
                expect(call(api, [4, missing, OUT]).value).toBe(0);
                expect(view.getUint32(OUT, true)).toBe(0);
                expect(process.lastError).toBe(126);
            }
            markHleModuleLoaded("ws2_32");
            expect(call(api, [4, address, OUT]).value).toBe(1);
            expect(view.getUint32(OUT, true)).toBe(hleImageBase("ws2_32"));
            expect(call(api, [4, EXE + 4, OUT]).value).toBe(1);
            expect(view.getUint32(OUT, true)).toBe(EXE);
        });
    }
});
