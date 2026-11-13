import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ModuleRegistry, type LoadedPEModule } from "../../src/worker/core/module-registry";
import { exports as api, captureModuleRefs } from "../../src/worker/modules/kernel32/module/module";

type Res = { value: number; suspendedForCallback?: boolean };

async function loadAndFree(over: Partial<LoadedPEModule>, failure: "save" | "invoke" | null = null) {
    const system = System.getInstance();
    const previous = system.process;
    const registry = new ModuleRegistry();
    const mod: LoadedPEModule = {
        name: "detach-test.dll", path: "C:/detach-test.dll", baseAddress: 0x24100000, size: 0x10000,
        entryPoint: 0x1234, exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: true, ...over,
    };
    const loader = { peekLoadDll: () => ({ kind: "io" }), loadDll: async () => { registry.register(mod); return mod; }, getPendingDllInits: () => [] };
    let finish: ((ret: number) => number | null) | undefined;
    const calls: Array<{ entry: number; args: number[] }> = [];
    const abandoned: number[] = [];
    const callbackManager = {
        abandonSuspendedFrame: (id: number) => { abandoned.push(id); },
        saveSuspendedThunkContext: () => failure === "save" ? 0 : 7,
        invokeCallback: (entry: number, args: number[], _cleanup: number, done: (ret: number) => number | null) => {
            if (failure === "invoke") return {callbackId: 0};
            calls.push({ entry, args }); finish = done; return { callbackId: 1 };
        },
    };
    system.process = { moduleRegistry: registry, loader, resetGeneration: 0, dispatcher: { callbackManager } } as never;
    const mem = new Uint8Array(0x1000);
    for (let i = 0; i < mod.name.length; i++) mem[0x100 + i] = mod.name.charCodeAt(i);
    try {
        await api["LoadLibraryA"]({} as never, mem, [0x100]);
        const res = await api["FreeLibrary"]({} as never, mem, [mod.baseAddress]) as Res;
        return { res, mod, registry, calls, finish, abandoned, refs: captureModuleRefs() };
    } finally { system.process = previous; }
}

test("FreeLibrary of an attached DLL runs DllMain(DLL_PROCESS_DETACH) before unloading", async () => {
    const { res, mod, registry, calls, finish } = await loadAndFree({});
    expect(res.value).toBe(1);
    expect(calls).toEqual([{ entry: mod.baseAddress + 0x1234, args: [mod.baseAddress, 0, 0] }]);
    expect(registry.getByBase(mod.baseAddress)).toBe(mod);
    finish!(1);
    expect(registry.getByBase(mod.baseAddress)).toBeUndefined();
    expect(mod.initialized).toBe(false);
});

test("FreeLibrary keeps the module attached and loaded when the DETACH chain cannot start", async () => {
    const { res, mod, registry, calls, refs } = await loadAndFree({}, "save");
    expect(res.value).toBe(0);
    expect(calls).toEqual([]);
    expect(refs.dynamicRefs).toContainEqual([mod.baseAddress, 1]);
    expect(registry.getByBase(mod.baseAddress)).toBe(mod);
    expect(mod.initialized).toBe(true);
});

test("FreeLibrary of a DLL with no DllMain unloads immediately", async () => {
    const { res, mod, registry } = await loadAndFree({ entryPoint: 0 });
    expect(res.suspendedForCallback).toBeUndefined();
    expect(registry.getByBase(mod.baseAddress)).toBeUndefined();
});

test("FreeLibrary skips DllMain when ATTACH never ran or there is no entry point", async () => {
    for (const over of [{ initialized: false }, { entryPoint: 0 }]) {
        expect((await loadAndFree(over)).res.suspendedForCallback).toBeUndefined();
    }
});

test("FreeLibrary rolls back when callback invocation cannot start", async () => {
    const {res, mod, registry, calls, abandoned, refs} = await loadAndFree({}, "invoke");
    expect(res.value).toBe(0);
    expect(registry.getByBase(mod.baseAddress)).toBe(mod);
    expect(mod.initialized).toBe(true);
    expect(calls).toEqual([]);
    expect(abandoned).toEqual([7]);
    expect(refs.dynamicRefs).toContainEqual([mod.baseAddress, 1]);
});
