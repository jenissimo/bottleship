import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Ole32 } from "../../src/worker/modules/ole32";
import { HleComServer } from "../../src/worker/core/com/hle-com-server";
import { captureHleComServerLoads, restoreHleComServerLoads } from "../../src/worker/core/com/hle-com-registry";
import { BaseComObject, ComObjectFactory } from "../../src/worker/core/com/base-com-object";
import { registerComVtableOwner } from "../../src/worker/core/com/com-memory";
import { comApartments } from "../../src/worker/core/com/apartment";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { ModuleRegistry } from "../../src/worker/core/module-registry";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { resetGuestCodeInvalidationState } from "../../src/worker/core/memory/guest-code";
import { MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "../../src/worker/core/cpu/emulator-config";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { boundHleModules, hleImageBase, isHleModuleLoaded, markHleModuleLoaded, materializeHleModuleImages, onHleModuleAttach, resetHleModuleImages } from "../../src/worker/core/hle-module-images";
import { exports as kernel32 } from "../../src/worker/modules/kernel32/module/module";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { guidBytes } from "../../src/worker/modules/dpnet/constants";
import { touchedModules } from "../../src/worker/savestate/core-participants";
import { restoreModuleImages, type ModuleImagesState } from "../../src/worker/savestate/participants/module-images";
import type { ModuleDescriptor } from "../../src/worker/api/types";
import type { VTableInfo } from "../../src/worker/api/adapters/module-adapter";
import type { Process } from "../../src/worker/core/process";

const system = System.getInstance(), resources = system.resourceProvider, config = EmulatorConfig.getInstance();
const savedProcess = system.process, savedThread = system.scheduler.getCurrentThreadId, savedMem = Object.getOwnPropertyDescriptors(Mem);
const CLSID = "5d0a4f10-6c1e-4b0c-9d52-0d6f6f2c7a01", IID = "5d0a4f10-6c1e-4b0c-9d52-0d6f6f2c7a02";
const OTHER_CLSID = "5d0a4f10-6c1e-4b0c-9d52-0d6f6f2c7a03", OTHER_IID = "5d0a4f10-6c1e-4b0c-9d52-0d6f6f2c7a04";
const DLL = "user32", OTHER = "gdi32";
const ctx = { esp: 0x1800, eip: 0 } as never;
let ram: Uint8Array, thread: number, baseline: Set<number>, savedExports: unknown, savedDisabled: string[], attached = 0;

interface Session { owner: any; ole: Ole32; servers: Record<string, HleComServer> }
let session: Session;

function boot(): Session {
    let next = 0x200000;
    const alloc = (size: number) => { const p = next; next += (size + 15) & ~15; return p; };
    const gen = new ThunkGenerator(); gen.setBaseAddress(0x21046000);
    const owner: any = { resetGeneration: 0, lastError: 0, thunkGenerator: gen, modules: new Map(), moduleRegistry: new ModuleRegistry(),
        dispatcher: { registerModule() {}, applyPendingRegistrations() {}, thunkGenerator: gen, pendingRegistrations: new Map() },
        getCurrentMemory: () => ram, memory: { alloc, free() {}, allocSystemBlock: alloc, freeSystemBlock() {} },
        addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= ram.length } };
    system.process = owner;
    comApartments.reset();
    resetHleModuleImages();
    materializeHleModuleImages(owner);
    const servers: Record<string, HleComServer> = {};
    for (const [dll, clsid, iid, table] of [[DLL, CLSID, IID, 0x6000], [OTHER, OTHER_CLSID, OTHER_IID, 0x6400]] as const) {
        const descriptor = { name: dll, functions: [], interfaces: [{ name: "Activated", iid, methods: [] }] } as ModuleDescriptor;
        const tables = { IClassFactory: { address: table, size: 5 }, Activated: { address: table + 0x100, size: 3 } } as Record<string, VTableInfo>;
        for (const t of Object.values(tables)) registerComVtableOwner(t.address, dll);
        ComObjectFactory.register(iid, class extends BaseComObject { constructor(t: number) { super(iid, t); } protected destroy() {} });
        servers[dll] = new HleComServer(owner as Process, descriptor, () => tables, [{ clsid, interfaces: ["Activated"] }]);
        servers[dll]!.install({});
    }
    const ole = new Ole32(); ole.initialize(owner);
    return session = { owner, ole, servers };
}

const call = (api: string, args: number[] = []): any => session.ole.exports[api]!(ctx, ram, args);
const create = (other = false): number => call("CoCreateInstance", [other ? 0x1080 : 0x1000, 0, 1, other ? 0x10a0 : 0x1040, 0x1100]);
function handle(dll = DLL): number {
    ram.set(new TextEncoder().encode(dll + ".dll\0"), 0x1200);
    return (kernel32.GetModuleHandleA!(ctx, ram, [0x1200]) as any).value as number;
}
function release(): void {
    resources.getComObjectByAddress(Mem.readUint32(0x1100)!)!.release();
    Mem.writeUint32(0x1100, 0);
}

beforeAll(() => {
    APIRegistry.getInstance().registerModule(kernel32Module);
    ram = new Uint8Array(MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE);
    savedExports = (preemptionManager as any).wasmExports;
    (preemptionManager as any).wasmExports = { jit_dirty_cache() {}, jit_clear_cache_js() {} };
    savedDisabled = config.disabledDlls;
    onHleModuleAttach(DLL, () => { attached++; });
});
beforeEach(() => {
    Mem.bind(() => ram); thread = 7; config.disabledDlls = []; attached = 0;
    baseline = new Set(resources.getAllComObjects().map(o => o.handle));
    system.scheduler.getCurrentThreadId = () => thread;
    boot();
    ram.set(guidBytes(CLSID), 0x1000); ram.set(guidBytes(IID), 0x1040);
    ram.set(guidBytes(OTHER_CLSID), 0x1080); ram.set(guidBytes(OTHER_IID), 0x10a0);
});
afterEach(() => {
    for (const object of resources.getAllComObjects()) if (!baseline.has(object.handle)) object.forceRelease();
    session.ole.reset(); comApartments.reset(); system.process = savedProcess; system.scheduler.getCurrentThreadId = savedThread;
    config.disabledDlls = savedDisabled;
    resetHleModuleImages();
});
afterAll(() => {
    (preemptionManager as any).wasmExports = savedExports; resetGuestCodeInvalidationState();
    for (const key of ["memoryGetter", "validateRange", "getRegion"]) Object.defineProperty(Mem, key, savedMem[key]!);
});

test("a module COM holds for an activated class is saved by name and held again after a restore into a fresh session", () => {
    expect(call("CoInitialize", [0])).toBe(0);
    expect(create()).toBe(0); release();
    expect(attached).toBe(1);
    expect(handle()).toBe(hleImageBase(DLL)!);
    const modules = touchedModules().sort();
    const saved = structuredClone(session.ole.captureSavestate());
    expect(saved.comServerLoads).toEqual([DLL]);

    boot(); attached = 0;
    expect(handle()).toBe(0);
    expect(session.servers[DLL]!.holdsLoaderReference).toBe(false);
    session.ole.restoreSavestate(saved);
    expect(session.servers[DLL]!.holdsLoaderReference).toBe(true);
    expect(session.servers[OTHER]!.holdsLoaderReference).toBe(false);
    expect(handle()).toBe(hleImageBase(DLL)!);
    expect(touchedModules().sort()).toEqual(modules);
    expect(attached).toBe(0);
    expect(session.ole.captureSavestate()).toEqual(saved);

    call("CoUninitialize");
    expect(handle()).toBe(0);
    expect(isHleModuleLoaded(DLL)).toBe(false);
    expect(captureHleComServerLoads(session.owner)).toEqual([]);
    expect(call("CoInitialize", [0])).toBe(0);
    expect(create()).toBe(0); release();
    expect(attached).toBe(1);
    expect(handle()).toBe(hleImageBase(DLL)!);
    call("CoUninitialize");
    expect(handle()).toBe(0);
});

test("the restored reference is released on the final leave of the restored apartments, not earlier", () => {
    call("CoInitialize", [0]); call("CoInitialize", [0]);
    thread = 11; call("CoInitialize", [0]);
    expect(create()).toBe(0); release();
    expect(create(true)).toBe(0); release();
    const saved = structuredClone(session.ole.captureSavestate());
    expect(saved.comServerLoads).toEqual([OTHER, DLL]);

    boot();
    session.ole.restoreSavestate(saved);
    thread = 7; call("CoUninitialize");
    thread = 11; call("CoUninitialize");
    expect(handle()).toBe(hleImageBase(DLL)!);
    expect(handle(OTHER)).toBe(hleImageBase(OTHER)!);
    thread = 7; call("CoUninitialize");
    expect(handle()).toBe(0);
    expect(handle(OTHER)).toBe(0);
});

test("a restored reference stays while an object of the module is alive", () => {
    call("CoInitialize", [0]);
    expect(create()).toBe(0); release();
    const saved = structuredClone(session.ole.captureSavestate());

    boot();
    session.ole.restoreSavestate(saved);
    expect(create()).toBe(0);
    call("CoUninitialize");
    expect(handle()).toBe(hleImageBase(DLL)!);
    release();
    call("CoInitialize", [0]); call("CoUninitialize");
    expect(handle()).toBe(0);
});

test("a session that holds a module the snapshot did not hold drops it on restore", () => {
    const saved = structuredClone(session.ole.captureSavestate());
    expect(saved.comServerLoads).toEqual([]);
    boot();
    call("CoInitialize", [0]);
    expect(create()).toBe(0); release();
    expect(handle()).toBe(hleImageBase(DLL)!);
    session.ole.restoreSavestate(saved);
    expect(handle()).toBe(0);
    expect(session.servers[DLL]!.holdsLoaderReference).toBe(false);
});

test("a held module without a COM server in the restoring session fails the restore by name and takes nothing", () => {
    expect(() => restoreHleComServerLoads(session.owner, [DLL, "quartz"])).toThrow(
        "ole32: COM held quartz loaded for an activated class, but this session registers no COM server for it");
    expect(session.servers[DLL]!.holdsLoaderReference).toBe(false);
    expect(handle()).toBe(0);
});

test("a held module the restoring session may not load fails the restore by name", () => {
    config.disabledDlls = [DLL];
    expect(() => restoreHleComServerLoads(session.owner, [DLL])).toThrow(
        "ole32: COM held user32 loaded for an activated class, but this session cannot load it");
    expect(isHleModuleLoaded(DLL)).toBe(false);
});

test("the module-images restore marks a bound HLE module loaded without running its attach hook", () => {
    expect(isHleModuleLoaded(DLL)).toBe(false);
    const state: ModuleImagesState = {
        images: [], nextDllBase: 0, freeDllRanges: [], implicitTls: [], hleBound: [...boundHleModules(), DLL],
        inlineStubs: { heap: null, crt: null, caseFold: null, locale: null, mbwc: null, mbwcDeclined: false, math: null },
    };
    const savedTls = system.implicitTlsEntries;
    try {
        restoreModuleImages(state, new Map(), { getByBase: () => undefined, restoreLayout: () => undefined } as never, { restoreInlineStubs: () => undefined } as never);
    } finally {
        system.implicitTlsEntries = savedTls;
    }
    expect(isHleModuleLoaded(DLL)).toBe(true);
    expect(boundHleModules()).toContain(DLL);
    expect(attached).toBe(0);

    resetHleModuleImages();
    boot();
    expect(isHleModuleLoaded(DLL)).toBe(false);
    markHleModuleLoaded(DLL);
    expect(attached).toBe(1);
});
