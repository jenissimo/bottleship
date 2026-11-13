import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ModuleRegistry, type LoadedPEModule } from "../../src/worker/core/module-registry";
import { CallbackManager } from "../../src/worker/core/thunking/callback-manager";
import { captureModuleRefs, exports as api, resetModuleRefs, restoreModuleRefs } from "../../src/worker/modules/kernel32/module/module";

type CallbackResources = {
    stubsByCleanup: Map<number, Array<{ inUse: boolean }>>;
    trackPendingCallback(id: number, owner: number, frame: number, source: string): boolean;
};

for (const failure of ["return stubs", "pending slots"] as const) {
    test(`FreeLibrary retains DLL ownership and rethrows when real callback setup exhausts ${failure}`, async () => {
        const system = System.getInstance();
        const previous = { process: system.process, scheduler: system.scheduler, refs: captureModuleRefs() };
        const mem = new Uint8Array(0x10000);
        const view = new DataView(mem.buffer);
        view.setUint32(0xc000, 0x2000, true);
        const cpu = { reg32: new Int32Array(8), instruction_pointer: new Int32Array([0x3000]), is_jumping: false };
        cpu.reg32[4] = 0xc000;
        let pins = 0;
        system.scheduler = {
            getCurrentThreadId: () => 1,
            getThreadStackBounds: () => ({ base: 0xa000, top: 0xd000 }),
            pinCurrentThread: () => { pins++; },
            unpinThread: () => { pins--; },
            wakeCurrentThreadForCallbackDispatch: () => {},
            reportCallbackFrameFatal: () => {},
        } as never;
        const manager = new CallbackManager({ cpu }, {} as never, () => mem);
        manager.initialize({ getRegions: () => ({ callbackStubPoolBase: 0x4000, callbackStubPoolSize: 0x4000 }) } as never);
        const resources = manager as unknown as CallbackResources;
        // Fill the real allocator's resources; do not replace invokeCallback or its failure paths.
        if (failure === "return stubs") {
            for (const stub of resources.stubsByCleanup.get(0)!) stub.inUse = true;
        } else {
            for (let i = 0; i < manager.getPendingSlotSummary().max; i++) {
                expect(resources.trackPendingCallback(0x10000 + i, 1, 0, "fixture")).toBe(true);
            }
        }
        const registry = new ModuleRegistry();
        const mod: LoadedPEModule = {
            name: "detach-throw.dll", path: "C:/detach-throw.dll", baseAddress: 0x24100000, size: 0x10000,
            entryPoint: 0x100, exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: true,
        };
        const loader = {
            peekLoadDll: () => ({ kind: "io" }),
            loadDll: async () => { registry.register(mod); return mod; },
            getPendingDllInits: () => [],
        };
        system.process = {
            moduleRegistry: registry, loader, resetGeneration: 0, dispatcher: { callbackManager: manager },
            addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length },
        } as never;
        for (let i = 0; i < mod.name.length; i++) mem[0x100 + i] = mod.name.charCodeAt(i);
        try {
            await api.LoadLibraryA!({} as never, mem, [0x100]);
            let caught: unknown;
            try {
                api.FreeLibrary!({ esp: 0xc000 } as never, mem, [mod.baseAddress]);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(Error);
            expect((caught as Error).message).toContain(
                failure === "return stubs" ? "No return stub available" : "Pending callback slots exhausted",
            );
            expect(registry.getByBase(mod.baseAddress)).toBe(mod);
            expect(mod.initialized).toBe(true);
            expect(captureModuleRefs().dynamicRefs).toEqual([[mod.baseAddress, 1]]);
            expect(manager.getActiveSuspendedFrameId()).toBe(0);
            expect(pins).toBe(0);
            // The late exception has already installed the guest frame. It must propagate,
            // not masquerade as a normal FALSE return or a CPU restoration.
            expect(cpu.reg32[4]).toBe(failure === "return stubs" ? 0xc000 : 0xbff0);
            expect(cpu.instruction_pointer[0]).toBe(failure === "return stubs" ? 0x3000 : mod.baseAddress + mod.entryPoint);
            expect(cpu.is_jumping).toBe(failure === "pending slots");
            expect(view.getUint32(0xc000, true)).toBe(0x2000);
            expect(manager.getPendingSlotSummary().count).toBe(failure === "return stubs" ? 0 : manager.getPendingSlotSummary().max);
        } finally {
            manager.reset();
            system.process = previous.process;
            system.scheduler = previous.scheduler;
            resetModuleRefs();
            restoreModuleRefs(previous.refs);
        }
    });
}
