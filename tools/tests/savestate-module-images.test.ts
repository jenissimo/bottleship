import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PELoader, type InlineStubState } from "../../src/worker/core/pe-loader";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import { ModuleRegistry, type LoadedPEModule } from "../../src/worker/core/module-registry";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { registerNativeModulePatcher } from "../../src/worker/core/hooks/native-module-patchers";
import type { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import { exports as kernel32, captureModuleRefs, restoreModuleRefs } from "../../src/worker/modules/kernel32/module/module";
import {
    captureModuleImages, moduleImagesHooks, restoreModuleImages, verifyModuleImages,
    MODULE_IMAGE_FIELDS, MODULE_IMAGES_SCHEMA, type ModuleImagesState,
} from "../../src/worker/savestate/participants/module-images";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { RAM_CHUNK_SIZE, writeRamChunks } from "../../src/worker/savestate/ram";
import { ParticipantRegistry, schemaHash } from "../../src/worker/savestate/participant";
import { captureSession, newCaptureRun, restoreSession, RestoreFailed, type SavestateTarget } from "../../src/worker/savestate/session";
import { restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { decodeSavestate } from "../../src/worker/savestate/container";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { sha256HexSync } from "../../src/worker/savestate/sha256";

const system = System.getInstance();
const flag = globalThis as { __savestates?: unknown };
const original = { process: system.process, exe: system.executablePath, tls: system.implicitTlsEntries, flag: flag.__savestates };
let hookedName = "";
let hookMode: "patches" | "declines-after-a-stub" | "throws" = "patches";

beforeAll(() => {
    APIRegistry.getInstance().registerModule(kernel32Module);
    APIRegistry.getInstance().registerModule(msvcrtModule);
    registerNativeModulePatcher({
        id: "savestate-module-images-test",
        matches: (m) => m.name === hookedName,
        patch: (process) => {
            if (hookMode === "throws") throw new Error("patcher failed half way");
            if (hookMode === "declines-after-a-stub") { process.thunkGenerator.allocateOneStub("test-hle", "Probe", 0, "stdcall"); return false; }
            return true;
        },
    });
});
afterEach(() => {
    system.process = original.process;
    system.executablePath = original.exe;
    system.implicitTlsEntries = original.tls;
    flag.__savestates = original.flag;
    hookedName = "";
    hookMode = "patches";
});
afterAll(() => {
    registerNativeModulePatcher({ id: "savestate-module-images-test", matches: () => false, patch: () => false });
});

const EXPORT_RVA = 0x1800, IAT_RVA = 0x1340, DATA_RVA = 0x1900;

function image(opts: { imports?: string; importDll?: string; tag?: number } = {}): Uint8Array {
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
    view.setUint32(opt + 16, 0x1810, true);
    view.setUint32(opt + 32, 0x1000, true);
    view.setUint32(opt + 36, 0x200, true);
    view.setUint32(opt + 56, 0x2000, true);
    view.setUint32(opt + 60, 0x200, true);
    view.setUint32(opt + 92, 16, true);
    view.setUint32(opt + 96, 0x1100, true);
    view.setUint32(opt + 100, 0x90, true);
    const section = opt + 224;
    text(section, ".text");
    view.setUint32(section + 8, 0x1000, true);
    view.setUint32(section + 12, 0x1000, true);
    view.setUint32(section + 16, 0x1000, true);
    view.setUint32(section + 20, 0x200, true);
    view.setUint32(section + 36, 0xe0000020, true);
    const dir = rva(0x1100);
    view.setUint32(dir + 16, 1, true);
    view.setUint32(dir + 20, 1, true);
    view.setUint32(dir + 24, 1, true);
    view.setUint32(dir + 28, 0x1140, true);
    view.setUint32(dir + 32, 0x1150, true);
    view.setUint32(dir + 36, 0x1160, true);
    view.setUint32(rva(0x1140), EXPORT_RVA, true);
    view.setUint32(rva(0x1150), 0x1170, true);
    text(rva(0x1170), "Answer");
    bytes[rva(EXPORT_RVA)] = 0xc3;
    bytes[rva(0x1810)] = 0xc3;
    bytes[rva(DATA_RVA)] = opts.tag ?? 0;
    if (opts.imports || opts.importDll) {
        view.setUint32(opt + 104, 0x1200, true);
        view.setUint32(opt + 108, 40, true);
        view.setUint32(rva(0x1200), 0x1320, true);
        view.setUint32(rva(0x1200) + 12, 0x1300, true);
        view.setUint32(rva(0x1200) + 16, IAT_RVA, true);
        text(rva(0x1300), opts.importDll ?? "KERNEL32.dll");
        if (opts.imports) {
            view.setUint32(rva(0x1320), 0x1360, true);
            text(rva(0x1362), opts.imports);
        } else {
            view.setUint32(rva(0x1320), 0x80000001, true);
        }
    }
    return bytes;
}

interface Session {
    loader: PELoader; registry: ModuleRegistry; memory: Uint8Array; view: DataView; generator: ThunkGenerator;
    files: Map<string, Uint8Array>; process: unknown; beforeRead: { run?: (path: string) => void };
    write(path: string, bytes: Uint8Array): void; remove(path: string): void;
}

function session(files: Record<string, Uint8Array>): Session {
    system.process = null;
    system.executablePath = "C:\\APP\\game.exe";
    system.implicitTlsEntries = [];
    const memory = new Uint8Array(0x100000);
    const entries = new Map(Object.entries(files).map(([path, bytes]) => [path.toLowerCase(), bytes]));
    const generator = new ThunkGenerator();
    generator.setBaseAddress(0x80000);
    const loader = new PELoader(() => memory, generator, APIRegistry.getInstance());
    const registry = new ModuleRegistry();
    let nextBase = 0x10000;
    registry.allocateBase = () => {
        while (registry.getByBase(nextBase)) nextBase += 0x10000;
        const base = nextBase;
        nextBase += 0x10000;
        return base;
    };
    loader.setModuleRegistry(registry);
    const beforeRead: Session["beforeRead"] = {};
    const written = new Set<string>();
    const write = (path: string, data: Uint8Array) => { entries.set(path.toLowerCase(), data); written.add(path.toLowerCase()); };
    const remove = (path: string) => { entries.delete(path.toLowerCase()); written.delete(path.toLowerCase()); };
    loader.setVfs({
        currentDir: "C:\\APP\\",
        resolvePath: (path: string) => path.replace(/\//g, "\\"),
        statEntry: (path: string) => (entries.has(path.toLowerCase()) ? { kind: "file", path } : null),
        open: async (path: string) => (entries.has(path.toLowerCase()) ? { path: path.toLowerCase(), source: written.has(path.toLowerCase()) ? "overlay" : "rom" } : null),
        getFileSize: (path: string) => entries.get(path.toLowerCase())!.length,
        read: async (entry: { path: string }) => { beforeRead.run?.(entry.path); return entries.get(entry.path)!; },
    } as unknown as VirtualFileSystem);
    const process = { moduleRegistry: registry, loader, thunkGenerator: generator, resetGeneration: 0, lastError: 0, getModule: () => undefined };
    return { loader, registry, memory, view: new DataView(memory.buffer), generator, files: entries, process, beforeRead, write, remove };
}

const bootDone = (s: Session) => { (s.loader as unknown as { bootImagesLoaded: boolean }).bootImagesLoaded = true; };

async function booted(files: Record<string, Uint8Array>): Promise<Session> {
    flag.__savestates = true;
    const s = session(files);
    await s.loader.loadDll("boot.dll");
    s.loader.getPendingDllInits();
    bootDone(s);
    return s;
}

const FILES = () => ({
    "C:\\APP\\boot.dll": image(),
    "C:\\APP\\plugin.dll": image({ imports: "GetTickCount", tag: 7 }),
    "C:\\APP\\other.dll": image({ tag: 9 }),
});

const bytes = (v: unknown) => encodeValue(v as SaveValue).json;
const STUBS = (n: number) => ({ regionBase: n * 0x100, regionEnd: n * 0x100 + 0x40 });

function capture(s: Session): { state: ModuleImagesState; blobs: Map<string, Uint8Array> } {
    const run = newCaptureRun();
    const state = structuredClone(captureModuleImages(s.registry, s.loader, run));
    return { state, blobs: new Map([...run.blobs].map(([hash, data]) => [hash, data.slice()])) };
}

const snapshot = (s: Session) => bytes(capture(s).state);
const noBlobs = restoreObjectGraph([]).blob;

async function restoreInto(fresh: Session, state: ModuleImagesState, blobs: ReadonlyMap<string, Uint8Array> = new Map()): Promise<void> {
    const files = await verifyModuleImages(state, fresh.registry, fresh.loader, restoreObjectGraph([], blobs).blob);
    restoreModuleImages(state, files, fresh.registry, fresh.loader);
}

describe("a DLL loaded at run time is part of the savestate", () => {
    test("the fresh session registers it at the same base without mapping it or running DllMain", async () => {
        const a = await booted(FILES());
        const plugin = (await a.loader.loadDll("plugin.dll"))!;
        expect(a.loader.getPendingDllInits().map(i => i.name)).toEqual(["plugin"]);
        expect(plugin.contentHash).toBe(sha256HexSync(a.files.get("c:\\app\\plugin.dll")!));
        expect(a.registry.getByName("boot.dll")!.contentHash).toBeUndefined();
        a.memory[plugin.baseAddress + DATA_RVA] = 0x55;
        system.implicitTlsEntries = [{ tlsIndex: 3, templateStart: plugin.baseAddress + DATA_RVA, templateSize: 4, zeroFillSize: 8, moduleName: "plugin" }];
        const saved = capture(a).state;
        const thunks = structuredClone(a.generator.captureState());
        const iat = a.view.getUint32(plugin.baseAddress + IAT_RVA, true);
        expect(a.generator.getStubByAddress(iat)?.functionName).toBe("GetTickCount");

        const b = await booted(FILES());
        expect(b.registry.getByName("plugin.dll")).toBeUndefined();
        b.memory.set(a.memory);
        const ram = b.memory.slice();
        await restoreInto(b, saved);
        b.generator.restoreState(thunks);

        const restored = b.registry.getByBase(plugin.baseAddress)!;
        expect(restored).toBe(b.registry.getByName("PLUGIN.DLL")!);
        expect(restored.path).toBe(plugin.path);
        expect(restored.size).toBe(plugin.size);
        expect(restored.initialized).toBe(true);
        expect(restored.isRealDll).toBe(true);
        expect(restored.sections).toEqual(plugin.sections);
        expect([...restored.exports]).toEqual([["answer", plugin.baseAddress + EXPORT_RVA]]);
        expect([...restored.ordinalExports]).toEqual([[1, plugin.baseAddress + EXPORT_RVA]]);
        expect(b.registry.getModuleContainingAddress(plugin.baseAddress + 0x1fff)).toBe(restored);
        expect(b.memory).toEqual(ram);
        expect(b.memory[plugin.baseAddress + DATA_RVA]).toBe(0x55);
        expect(b.loader.getPendingDllInits()).toEqual([]);
        expect(system.implicitTlsEntries).toEqual(saved.implicitTls);
        const stub = b.generator.getStubByAddress(b.view.getUint32(plugin.baseAddress + IAT_RVA, true))!;
        expect([stub.dllName.toLowerCase().replace(/\.dll$/, ""), stub.functionName]).toEqual(["kernel32", "GetTickCount"]);
        expect(snapshot(b)).toBe(bytes(saved));
        expect(b.registry.getAllModules().map(m => m.name)).toEqual(a.registry.getAllModules().map(m => m.name));
    });

    test("GetModuleHandle, GetProcAddress and the FreeLibrary count continue where they were", async () => {
        const mem = new Uint8Array(0x11000);
        const str = (at: number, value: string) => { mem.fill(0, at, at + 64); for (let i = 0; i < value.length; i++) mem[at + i] = value.charCodeAt(i); return at; };
        const call = async (name: string, args: number[]) => (await kernel32[name]!({ esp: 0x800, eip: 0 } as never, mem, args) as { value: number }).value;

        const a = await booted(FILES());
        system.process = a.process as never;
        const base = await call("LoadLibraryA", [str(0x100, "plugin.dll")]);
        expect(await call("LoadLibraryA", [str(0x100, "plugin.dll")])).toBe(base);
        a.loader.getPendingDllInits();
        const proc = await call("GetProcAddress", [base, str(0x10200, "Answer")]);
        expect(proc).toBe(base + EXPORT_RVA);
        const images = capture(a).state;
        const refs = structuredClone(captureModuleRefs());
        expect(refs.dynamicRefs).toEqual([[base, 2]]);

        const b = await booted(FILES());
        system.process = b.process as never;
        await restoreInto(b, images);
        restoreModuleRefs(refs);
        expect(await call("GetModuleHandleA", [str(0x100, "plugin.dll")])).toBe(base);
        expect(await call("GetProcAddress", [base, str(0x10200, "Answer")])).toBe(proc);
        expect(await call("GetProcAddress", [base, 1])).toBe(proc);
        expect(await call("FreeLibrary", [base])).toBe(1);
        expect(b.registry.getByBase(base)).toBeDefined();
        expect(await call("FreeLibrary", [base])).toBe(1);
        expect(b.registry.getByBase(base)).toBeUndefined();
        expect(await call("GetModuleHandleA", [str(0x100, "plugin.dll")])).toBe(0);
        expect(await call("FreeLibrary", [b.registry.getByName("boot.dll")!.baseAddress])).toBe(1);
        expect(b.registry.getByName("boot.dll")).toBeDefined();
        const again = await call("LoadLibraryA", [str(0x100, "plugin.dll")]);
        expect(b.registry.getByBase(again)!.name).toBe("plugin");
        expect(b.registry.getByBase(again)!.contentHash).toBe(images.images.find(i => i.name === "plugin")!.contentHash);
        expect(captureModuleRefs().dynamicRefs).toEqual([[again, 1]]);
    });

    test("the base allocator continues from the saved layout", () => {
        const a = new ModuleRegistry();
        const mod = (name: string, size: number): LoadedPEModule => ({
            name, path: `C:\\${name}`, baseAddress: a.allocateBase(size), size, entryPoint: 0,
            exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: true,
        });
        for (const m of [mod("one.dll", 0x10000), mod("two.dll", 0x30000), mod("three.dll", 0x10000)]) a.register(m);
        a.unregister("two.dll");
        const layout = structuredClone(a.captureLayout());
        expect(layout.freeDllRanges.length).toBe(1);
        const b = new ModuleRegistry();
        b.restoreLayout(layout.nextDllBase, layout.freeDllRanges);
        expect(b.captureLayout()).toEqual(layout);
        for (const size of [0x20000, 0x10000, 0x10000]) expect(b.allocateBase(size)).toBe(a.allocateBase(size));
        b.restoreLayout(layout.nextDllBase, layout.freeDllRanges);
        expect(b.captureLayout()).toEqual(layout);
    });
});

describe("a session that cannot take the images refuses before anything is written", () => {
    async function saved(): Promise<{ state: ModuleImagesState; base: number }> {
        const a = await booted(FILES());
        const plugin = (await a.loader.loadDll("plugin.dll"))!;
        return { state: capture(a).state, base: plugin.baseAddress };
    }
    const refusal = async (fresh: Session, state: ModuleImagesState) => {
        const ram = fresh.memory.slice();
        const names = fresh.registry.getAllModules().map(m => m.name);
        const err = await verifyModuleImages(state, fresh.registry, fresh.loader, noBlobs).catch(e => e as Error);
        expect(fresh.memory).toEqual(ram);
        expect(fresh.registry.getAllModules().map(m => m.name)).toEqual(names);
        return err instanceof Error ? err.message : "";
    };

    test("the file is gone", async () => {
        const { state } = await saved();
        const { ["C:\\APP\\plugin.dll"]: _gone, ...rest } = FILES();
        expect(await refusal(await booted(rest), state)).toBe("module images: C:\\APP\\plugin.dll is missing");
    });

    test("the file has other bytes, or another length", async () => {
        const { state } = await saved();
        const sameLength = { ...FILES(), "C:\\APP\\plugin.dll": image({ imports: "GetTickCount", tag: 8 }) };
        expect(await refusal(await booted(sameLength), state)).toBe("module images: C:\\APP\\plugin.dll changed since the snapshot was taken");
        const longer = new Uint8Array(0x1201);
        longer.set(FILES()["C:\\APP\\plugin.dll"]);
        expect(await refusal(await booted({ ...FILES(), "C:\\APP\\plugin.dll": longer }), state)).toBe("module images: C:\\APP\\plugin.dll changed since the snapshot was taken");
    });

    test("the base is taken, or the module is already loaded elsewhere", async () => {
        const { state, base } = await saved();
        const taken = await booted(FILES());
        await taken.loader.loadDll("other.dll", false);
        const first = taken.registry.getByName("boot.dll")!;
        taken.registry.unregister("boot.dll");
        expect(taken.registry.getByBase(base)!.name).toBe("other");
        taken.registry.register(first);
        expect(await refusal(taken, state)).toBe(`module images: 0x${base.toString(16)} holds C:\\APP\\other.dll here, the snapshot has C:\\APP\\plugin.dll`);

        const overlapping = await booted(FILES());
        overlapping.registry.register({ ...first, name: "wide.dll", path: "C:\\APP\\wide.dll", baseAddress: base - 0x1000, size: 0x2000 });
        const shifted: ModuleImagesState = { ...state, images: [...state.images, { ...first, name: "wide.dll", path: "C:\\APP\\wide.dll", baseAddress: base - 0x1000, size: 0x2000 }] };
        expect(await refusal(overlapping, shifted)).toBe(`module images: the base 0x${base.toString(16)} of C:\\APP\\plugin.dll is taken by C:\\APP\\wide.dll at 0x${(base - 0x1000).toString(16)}`);
    });

    test("the session loads an image the snapshot does not have, or lacks one of its start images", async () => {
        const { state } = await saved();
        const extra = await booted(FILES());
        const other = (await extra.loader.loadDll("other.dll", false))!;
        const moved = { ...state, images: state.images.map(i => (i.name === "plugin" ? { ...i, baseAddress: 0x50000 } : i)) };
        expect(await refusal(extra, moved)).toBe(`module images: this session loads C:\\APP\\other.dll at 0x${other.baseAddress.toString(16)}, the snapshot does not`);

        const lacking = session(FILES());
        expect(await refusal(lacking, state)).toBe("module images: C:\\APP\\boot.dll is loaded at start in the snapshot, not in this session");
    });

    test("restoreSession asks every participant before the first write", async () => {
        const mem = new Uint8Array(2 * RAM_CHUNK_SIZE).fill(5);
        const target = (m: Uint8Array): SavestateTarget => ({
            guestMemory: () => m, overlayState: () => "", gameId: () => "g", touchedModules: () => [],
            compatibilityKey: () => ({ buildSha: "a", contentHash: "b", configHash: "c", bootLayout: "d", participants: {} }),
        });
        const log: string[] = [];
        const reg = (verify: () => void) => {
            const r = new ParticipantRegistry();
            r.add({ id: "time", version: 1, order: 1, capture: () => 1, restore: () => { log.push("restore time"); } });
            r.add({
                id: "module-images", version: 1, order: 7, capture: (ctx) => ctx.blob(new Uint8Array([1, 2, 3])),
                verify: (s, blob) => { log.push(`verify ${[...blob(s as string)]}`); verify(); }, restore: () => { log.push("restore images"); },
            });
            return r;
        };
        const store = new MemoryChunkStore();
        const result = await captureSession(target(mem), new Set(), () => undefined, reg(() => undefined));
        await writeRamChunks(result.pending, store);
        const fresh = new Uint8Array(mem.length).fill(1);
        const err = await restoreSession(target(fresh), decodeSavestate(result.bytes), store, reg(() => { throw new Error("module images: x is missing"); })).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(RestoreFailed);
        expect(err.message).toBe("module images: x is missing");
        expect(fresh.every(b => b === 1)).toBe(true);
        expect(log).toEqual(["verify 1,2,3"]);
        log.length = 0;
        await restoreSession(target(fresh), decodeSavestate(result.bytes), store, reg(() => undefined));
        expect(fresh).toEqual(mem);
        expect(log).toEqual(["verify 1,2,3", "restore time", "restore images"]);
    });

    test("the participant hooks restore from the verified files and verify on their own when nobody did", async () => {
        const { state, base } = await saved();
        const b = await booted(FILES());
        let reads = 0;
        b.beforeRead.run = () => { reads++; };
        const hooks = moduleImagesHooks(() => ({ registry: b.registry, loader: b.loader }));
        const section = state as unknown as SaveValue;
        await hooks.verify(section, noBlobs);
        await hooks.restore(section, restoreObjectGraph([]));
        expect(reads).toBe(1);
        expect(b.registry.getByBase(base)!.name).toBe("plugin");
        const c = await booted(FILES());
        await moduleImagesHooks(() => ({ registry: c.registry, loader: c.loader })).restore(section, restoreObjectGraph([]));
        expect(c.registry.getByBase(base)!.name).toBe("plugin");
    });
});

describe("a DLL from a file the program wrote is carried in the snapshot", () => {
    const TEMP = "C:\\TEMP\\x1.tmp\\made.dll";
    async function saved() {
        const a = await booted(FILES());
        a.write(TEMP, image({ imports: "GetTickCount", tag: 3 }));
        const made = (await a.loader.loadDll(TEMP))!;
        a.remove(TEMP);
        return { a, made, ...capture(a) };
    }

    test("the file is deleted after the load, the snapshot is taken, and a session without the file registers the image", async () => {
        const { a, made, state, blobs } = await saved();
        expect(a.registry.getByName("plugin.dll")).toBeUndefined();
        const image = state.images.find(i => i.path === made.path)!;
        expect(image.blob).toBe(made.contentHash!);
        expect([...blobs.keys()]).toEqual([made.contentHash!]);
        expect(state.images.filter(i => i.blob !== undefined).length).toBe(1);

        const b = await booted(FILES());
        b.memory.set(a.memory);
        const ram = b.memory.slice();
        let reads = 0;
        b.beforeRead.run = () => { reads++; };
        await restoreInto(b, state, blobs);
        expect(reads).toBe(0);
        expect(b.memory).toEqual(ram);
        const restored = b.registry.getByBase(made.baseAddress)!;
        expect(restored.path).toBe(made.path);
        expect([...restored.exports]).toEqual([...made.exports]);
        expect([...restored.ordinalExports]).toEqual([...made.ordinalExports]);
        expect(b.loader.getPendingDllInits()).toEqual([]);
        const again = capture(b);
        expect(bytes(again.state)).toBe(bytes(state));
        expect([...again.blobs.keys()]).toEqual([...blobs.keys()]);
    });

    test("a package file is named by path and hash only", async () => {
        const a = await booted(FILES());
        const plugin = (await a.loader.loadDll("plugin.dll"))!;
        const { state, blobs } = capture(a);
        expect(plugin.imageBytes).toBeUndefined();
        expect(blobs.size).toBe(0);
        expect(state.images.every(i => i.blob === undefined)).toBe(true);
    });

    test("a missing or foreign blob refuses before anything is written", async () => {
        const { state, blobs, made } = await saved();
        const hash = [...blobs.keys()][0]!;
        const b = await booted(FILES());
        const ram = b.memory.slice();
        const refuse = (with_: Map<string, Uint8Array>) => restoreInto(b, state, with_).then(() => "", e => (e as Error).message);
        expect(await refuse(new Map())).toBe(`savestate: blob ${hash} is missing`);
        expect(await refuse(new Map([[hash, image({ tag: 4 })]]))).toBe(`module images: the stored copy of ${made.path} is not the file that was loaded`);
        expect(b.memory).toEqual(ram);
        expect(b.registry.getAllModules().map(m => m.name)).toEqual(["boot"]);
    });

    test("through the session: the blob travels in the chunk store and its absence is found before the first write", async () => {
        const { a, made, state } = await saved();
        const target = (m: Uint8Array): SavestateTarget => ({
            guestMemory: () => m, overlayState: () => "", gameId: () => "g", touchedModules: () => [],
            compatibilityKey: () => ({ buildSha: "a", contentHash: "b", configHash: "c", bootLayout: "d", participants: {} }),
        });
        const reg = (s: Session) => {
            const r = new ParticipantRegistry();
            const hooks = moduleImagesHooks(() => ({ registry: s.registry, loader: s.loader }));
            r.add({ id: "module-images", version: 1, ...hooks });
            return r;
        };
        const ramA = new Uint8Array(RAM_CHUNK_SIZE).fill(6);
        const store = new MemoryChunkStore();
        const result = await captureSession(target(ramA), new Set(), () => undefined, reg(a));
        await writeRamChunks(result.pending, store);
        expect(result.blobs.map(([hash]) => hash)).toEqual([made.contentHash!]);

        const b = await booted(FILES());
        const fresh = new Uint8Array(ramA.length).fill(1);
        await restoreSession(target(fresh), decodeSavestate(result.bytes), store, reg(b));
        expect(fresh).toEqual(ramA);
        expect(b.registry.getByBase(made.baseAddress)!.path).toBe(made.path);
        expect(bytes(capture(b).state)).toBe(bytes(state));

        await store.delete(made.contentHash!);
        const c = await booted(FILES());
        const untouched = new Uint8Array(ramA.length).fill(1);
        const err = await restoreSession(target(untouched), decodeSavestate(result.bytes), store, reg(c)).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(RestoreFailed);
        expect(String(err.message)).toContain("blob");
        expect(untouched.every(v => v === 1)).toBe(true);
        expect(c.registry.getByName("made.dll")).toBeUndefined();
    });
});

describe("inline stubs a run-time image made the loader emit", () => {
    const emitted = { mallocStub: 0x90010, freeStub: 0x90040, regionBase: 0x90000, regionEnd: 0x90100 };
    const files = () => ({
        ...FILES(),
        "C:\\APP\\first.dll": image({ importDll: "other.dll" }),
        "C:\\APP\\second.dll": image({ importDll: "MSVCRT.dll", imports: "malloc" }),
    });
    const ranges = () => (system.scheduler as unknown as { nonPreemptibleRanges: Array<{ base: number; end: number }> }).nonPreemptibleRanges;

    test("are saved, and a DLL loaded after the restore binds to the same stubs", async () => {
        const a = await booted(files());
        a.beforeRead.run = (path) => {
            if (path.endsWith("other.dll")) (a.loader as unknown as { crtInlineStubs: unknown }).crtInlineStubs = { ...emitted };
        };
        const first = (await a.loader.loadDll("first.dll"))!;
        expect(first.unsaved).toBeUndefined();
        const { state } = capture(a);
        expect(state.inlineStubs.crt).toEqual(emitted);
        const second = (await a.loader.loadDll("second.dll"))!;
        const bound = a.view.getUint32(second.baseAddress + IAT_RVA, true);
        expect(bound).toBe(emitted.mallocStub);

        const plain = await booted(files());
        await plain.loader.loadDll("first.dll");
        const unbound = (await plain.loader.loadDll("second.dll"))!;
        expect(plain.view.getUint32(unbound.baseAddress + IAT_RVA, true)).not.toBe(emitted.mallocStub);

        const b = await booted(files());
        const before = ranges().length;
        await restoreInto(b, state);
        expect(b.loader.captureInlineStubs()).toEqual(state.inlineStubs);
        expect(ranges().slice(before)).toEqual([{ base: emitted.regionBase, end: emitted.regionEnd }]);
        const later = (await b.loader.loadDll("second.dll"))!;
        expect(later.baseAddress).toBe(second.baseAddress);
        expect(b.view.getUint32(later.baseAddress + IAT_RVA, true)).toBe(bound);
        expect(b.loader.captureInlineStubs()).toEqual(state.inlineStubs);
        ranges().length = before;
    });
});

describe("what a savestate still cannot carry is refused by name at capture", () => {
    test("a run-time image patched by a host-side hook", async () => {
        const a = await booted(FILES());
        system.process = a.process as never;
        hookedName = "plugin";
        const plugin = (await a.loader.loadDll("plugin.dll"))!;
        expect(plugin.contentHash).toBeUndefined();
        expect(() => capture(a)).toThrow(`module images: plugin (0x${plugin.baseAddress.toString(16)}) was loaded at run time and is patched by host-side hooks`);
        a.registry.unregister("plugin.dll");
        expect(() => capture(a)).not.toThrow();
    });

    test("the patcher's own answer decides, not the stub count: no new stub still refuses, a new stub without a patch does not", async () => {
        const a = await booted(FILES());
        system.process = a.process as never;
        hookedName = "plugin";
        const stubs = a.generator.getAllStubs().length;
        const plugin = (await a.loader.loadDll("plugin.dll"))!;
        expect(a.generator.getAllStubs().filter(x => x.dllName === "test-hle").length).toBe(0);
        expect(a.generator.getAllStubs().length).toBeGreaterThan(stubs);
        expect(plugin.unsaved).toBe("is patched by host-side hooks");

        hookedName = "other";
        hookMode = "declines-after-a-stub";
        const other = (await a.loader.loadDll("other.dll"))!;
        expect(a.generator.getAllStubs().filter(x => x.dllName === "test-hle").length).toBe(1);
        expect(other.unsaved).toBeUndefined();
        expect(other.contentHash).toBeDefined();

        const b = await booted(FILES());
        system.process = b.process as never;
        hookedName = "plugin";
        hookMode = "throws";
        expect((await b.loader.loadDll("plugin.dll"))!.unsaved).toBe("is patched by host-side hooks");
    });

    test("a run-time image always has a content hash or a named reason, a start image has neither", async () => {
        const a = await booted(FILES());
        const on = (await a.loader.loadDll("plugin.dll"))!;
        flag.__savestates = undefined;
        const off = (await a.loader.loadDll("other.dll"))!;
        for (const m of [on, off]) expect([m.name, Boolean(m.contentHash) !== Boolean(m.unsaved)]).toEqual([m.name, true]);
        const boot = a.registry.getByName("boot.dll")!;
        expect([boot.contentHash, boot.unsaved]).toEqual([undefined, undefined]);
    });

    test("the same hook on a start image is not a refusal", async () => {
        flag.__savestates = true;
        const a = session(FILES());
        system.process = a.process as never;
        hookedName = "plugin";
        const plugin = (await a.loader.loadDll("plugin.dll"))!;
        expect(plugin.unsaved).toBeUndefined();
        expect(() => capture(a)).not.toThrow();
    });

    test("a run-time image loaded while savestates were off", async () => {
        const a = await booted(FILES());
        flag.__savestates = undefined;
        const plugin = (await a.loader.loadDll("plugin.dll"))!;
        expect(() => capture(a)).toThrow(`module images: plugin (0x${plugin.baseAddress.toString(16)}) was loaded at run time and has no content hash`);
    });
});

describe("field policies", () => {
    test("every saved image field reaches the capture, every other one stays out", async () => {
        const a = await booted(FILES());
        const plugin = (await a.loader.loadDll("plugin.dll"))!;
        const before = snapshot(a);
        const mutate: Record<keyof LoadedPEModule, (m: LoadedPEModule) => void> = {
            name: m => { m.name = "renamed"; },
            path: m => { m.path = "C:\\APP\\renamed.dll"; },
            baseAddress: m => { m.baseAddress += 0x10000; },
            size: m => { m.size += 0x1000; },
            fileSize: m => { m.fileSize = 1; },
            entryPoint: m => { m.entryPoint = 0x1234; },
            initialized: m => { m.initialized = !m.initialized; },
            sections: m => { m.sections = [...m.sections!, { name: ".x", virtualAddress: 0, virtualSize: 0, rawSize: 0, characteristics: 0 }]; },
            contentHash: m => { m.contentHash = "00"; },
            imageBytes: m => { m.imageBytes = new Uint8Array([1]); },
            exports: m => { m.exports = new Map([["other", 1]]); },
            ordinalExports: m => { m.ordinalExports = new Map([[9, 1]]); },
            isRealDll: m => { m.isRealDll = false; },
            isExecutable: m => { m.isExecutable = true; },
            unsaved: () => undefined,
        };
        expect(Object.keys(mutate).sort()).toEqual(Object.keys(MODULE_IMAGE_FIELDS).sort());
        for (const [field, policy] of Object.entries(MODULE_IMAGE_FIELDS) as Array<[keyof LoadedPEModule, string]>) {
            const kept = { ...plugin };
            mutate[field](plugin);
            const changed = snapshot(a) !== before;
            for (const key of Object.keys(plugin) as Array<keyof LoadedPEModule>) if (!(key in kept)) delete plugin[key];
            Object.assign(plugin, kept);
            expect([field, changed]).toEqual([field, policy === "save"]);
        }
        expect(snapshot(a)).toBe(before);
    });

    test("every state key reaches the capture and the schema names them all", async () => {
        const a = await booted(FILES());
        await a.loader.loadDll("plugin.dll");
        const { state } = capture(a);
        expect(Object.keys(state).sort()).toEqual(MODULE_IMAGES_SCHEMA.state);
        const before = bytes(state);
        a.registry.restoreLayout(0x70000, []);
        const layout = snapshot(a);
        expect(layout).not.toBe(before);
        a.registry.restoreLayout(0x70000, [[0x40000, 0x10000]]);
        const free = snapshot(a);
        expect(free).not.toBe(layout);
        for (const key of MODULE_IMAGES_SCHEMA.tls) {
            const entry = { tlsIndex: 1, templateStart: 2, templateSize: 3, zeroFillSize: 4, moduleName: "plugin" };
            system.implicitTlsEntries = [entry];
            const one = snapshot(a);
            (entry as Record<string, unknown>)[key] = key === "moduleName" ? "other" : 99;
            expect([key, snapshot(a) !== one]).toEqual([key, true]);
        }
        system.implicitTlsEntries = [];
        expect(snapshot(a)).toBe(free);
        const stubs = { heap: STUBS(1), crt: STUBS(2), caseFold: STUBS(3), locale: STUBS(4), mbwc: STUBS(5), mbwcDeclined: false, math: STUBS(6) } as unknown as InlineStubState;
        a.loader.restoreInlineStubs(stubs);
        expect(a.loader.captureInlineStubs()).toEqual(stubs);
        const withStubs = snapshot(a);
        for (const key of MODULE_IMAGES_SCHEMA.inlineStubs as Array<keyof InlineStubState>) {
            a.loader.restoreInlineStubs({ ...stubs, [key]: key === "mbwcDeclined" ? true : null });
            expect([key, snapshot(a) !== withStubs]).toEqual([key, true]);
        }
    });

    test("the schema is pinned", () => {
        expect(schemaHash(MODULE_IMAGES_SCHEMA as unknown as SaveValue)).toBe("d20656b52f2472e7");
    });
});
