import { afterEach, expect, test } from "bun:test";
import { PELoader } from "../../src/worker/core/pe-loader";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { ModuleRegistry } from "../../src/worker/core/module-registry";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import type { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import {
    dllSearchDirectories, resetDllSearchState, setDllDirectory, LOAD_WITH_ALTERED_SEARCH_PATH,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
} from "../../src/worker/core/dll-search-order";

const system = System.getInstance();
const originalProcess = system.process;
const originalExePath = system.executablePath;
afterEach(() => {
    system.process = originalProcess;
    system.executablePath = originalExePath;
    resetDllSearchState();
});

/** PE32 with one ordinal export and an optional ordinal import. */
function image(dependency?: string): Uint8Array {
    const bytes = new Uint8Array(0x1200);
    const view = new DataView(bytes.buffer);
    const text = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
    const rva = (value: number) => value - 0x1000 + 0x200;
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x40, true);
    view.setUint32(0x40, 0x4550, true);
    view.setUint16(0x44, 0x14c, true);
    view.setUint16(0x46, 1, true);
    view.setUint16(0x54, 224, true);
    view.setUint16(0x56, 0x2102, true);
    const opt = 0x58;
    view.setUint16(opt, 0x10b, true);
    view.setUint32(opt + 32, 0x1000, true);
    view.setUint32(opt + 36, 0x200, true);
    view.setUint32(opt + 56, 0x2000, true);
    view.setUint32(opt + 60, 0x200, true);
    view.setUint32(opt + 92, 16, true);
    view.setUint32(opt + 96, 0x1100, true);
    view.setUint32(opt + 100, 0x50, true);
    const section = opt + 224;
    text(section, ".text");
    view.setUint32(section + 8, 0x1000, true);
    view.setUint32(section + 12, 0x1000, true);
    view.setUint32(section + 16, 0x1000, true);
    view.setUint32(section + 20, 0x200, true);
    view.setUint32(section + 36, 0x60000020, true);
    view.setUint32(rva(0x1100) + 16, 1, true);
    view.setUint32(rva(0x1100) + 20, 1, true);
    view.setUint32(rva(0x1100) + 28, 0x1140, true);
    view.setUint32(rva(0x1140), 0x1800, true);
    bytes[rva(0x1800)] = 0xc3;
    if (dependency) {
        view.setUint32(opt + 104, 0x1200, true);
        view.setUint32(opt + 108, 40, true);
        view.setUint32(rva(0x1200), 0x1320, true);
        view.setUint32(rva(0x1200) + 12, 0x1300, true);
        view.setUint32(rva(0x1200) + 16, 0x1340, true);
        text(rva(0x1300), dependency);
        view.setUint32(rva(0x1320), 0x80000001, true);
    }
    return bytes;
}

function setup(files: Record<string, Uint8Array>, beforeRead?: (path: string) => Promise<void>) {
    system.process = null;
    system.executablePath = "C:\\APP\\game.exe";
    const memory = new Uint8Array(0x100000);
    const entries = new Map(Object.entries(files).map(([path, bytes]) => [path.toLowerCase(), { path, bytes }]));
    const loader = new PELoader(() => memory, new ThunkGenerator(), APIRegistry.getInstance());
    const registry = new ModuleRegistry();
    let nextBase = 0x10000;
    registry.allocateBase = () => { const base = nextBase; nextBase += 0x10000; return base; };
    loader.setModuleRegistry(registry);
    loader.setVfs({
        currentDir: "C:\\CURRENT\\",
        resolvePath: (path: string) => path.replace(/\//g, "\\"),
        statEntry: (path: string) => {
            const entry = entries.get(path.toLowerCase());
            return entry ? { kind: "file", path: entry.path } : null;
        },
        open: async (path: string) => entries.get(path.toLowerCase()),
        getFileSize: (path: string) => entries.get(path.toLowerCase())!.bytes.length,
        read: async (entry: { path: string; bytes: Uint8Array }) => {
            await beforeRead?.(entry.path);
            return entry.bytes;
        },
    } as unknown as VirtualFileSystem);
    return { loader, registry, view: new DataView(memory.buffer) };
}

test("altered search follows the top-level DLL directory through nested imports", async () => {
    setDllDirectory("C:\\OTHER");
    const { loader, registry, view } = setup({
        "C:\\PLUGIN\\root.dll": image("bridge.dll"),
        "C:\\OTHER\\bridge.dll": image("leaf.dll"),
        "C:\\PLUGIN\\leaf.dll": image(),
        "C:\\OTHER\\leaf.dll": image(),
        "C:\\APP\\leaf.dll": image(),
    });
    const root = await loader.loadDll("C:\\PLUGIN\\root.dll", true, LOAD_WITH_ALTERED_SEARCH_PATH);
    const bridge = registry.getByName("bridge")!;
    const leaf = registry.getByName("leaf")!;
    expect(leaf.path).toBe("C:\\PLUGIN\\leaf.dll");
    expect(view.getUint32(root!.baseAddress + 0x1340, true)).toBe(bridge.baseAddress + 0x1800);
    expect(view.getUint32(bridge.baseAddress + 0x1340, true)).toBe(leaf.baseAddress + 0x1800);
});

test("a full path without search flags keeps the application directory for dependencies", async () => {
    const { loader, registry } = setup({
        "C:\\PLUGIN\\root.dll": image("leaf.dll"),
        "C:\\PLUGIN\\leaf.dll": image(),
        "C:\\APP\\leaf.dll": image(),
    });
    await loader.loadDll("C:\\PLUGIN\\root.dll");
    expect(registry.getByName("leaf")!.path).toBe("C:\\APP\\leaf.dll");
});

test("DLL_LOAD_DIR searches its directory and preserves the selected fallback directories", () => {
    const ctx = { appDir: "C:\\APP", currentDir: "C:\\CURRENT", loadDir: "C:\\PLUGIN" };
    expect(dllSearchDirectories({ ...ctx, loadFlags: LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR })).toEqual(["C:\\PLUGIN\\"]);
    expect(dllSearchDirectories({ ...ctx, loadFlags: LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS }))
        .toEqual(["C:\\PLUGIN\\", "C:\\APP\\", "C:\\WINDOWS\\SYSTEM32\\"]);
});

test("overlapping async loads keep independent search directories and do not change later loads", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { loader, registry } = setup({
        "C:\\A\\aroot.dll": image("achild.dll"),
        "C:\\A\\achild.dll": image(),
        "C:\\B\\broot.dll": image("bchild.dll"),
        "C:\\B\\bchild.dll": image(),
        "C:\\APP\\later.dll": image(),
        "C:\\A\\later.dll": image(),
    }, async path => { if (path === "C:\\A\\aroot.dll") await gate; });
    const a = loader.loadDll("C:\\A\\aroot.dll", true, LOAD_WITH_ALTERED_SEARCH_PATH);
    await loader.loadDll("C:\\B\\broot.dll", true, LOAD_WITH_ALTERED_SEARCH_PATH);
    release();
    await a;
    expect(registry.getByName("achild")!.path).toBe("C:\\A\\achild.dll");
    expect(registry.getByName("bchild")!.path).toBe("C:\\B\\bchild.dll");
    await loader.loadDll("later.dll");
    expect(registry.getByName("later")!.path).toBe("C:\\APP\\later.dll");
});
