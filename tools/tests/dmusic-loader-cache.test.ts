import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { DMusic } from "../../src/worker/modules/dmusic";
import {
    CLSID_DirectMusicLoader, CLSID_DirectMusicSegment, IID_IUnknown, type DMusicObject, type LoaderObject,
} from "../../src/worker/modules/dmusic-objects";
import { guidBytes } from "../../src/worker/modules/dpnet/constants";

const ALL_TYPES = "d2ac2893-b39b-11d1-8704-00600893b1bd";
const DESC = { validData: 4, fileName: 0x138 };
const DMUS_OBJ_FILENAME = 1 << 4;
const OUT = 0x200, RIID = 0x300, DESC_AT = 0x1000, PATH_AT = 0x2000, CLASS_AT = 0x2800, ALL_AT = 0x2810;
const DMUS_E_LOADER_OBJECTNOTFOUND = 0x88781185 | 0;
const S_FALSE = 1;

const system = System.getInstance(), savedProcess = system.process, savedFs = (system as unknown as { fileSystem: unknown }).fileSystem;
const rp = SystemResourceProvider.getInstance();
let mem: Uint8Array, module: DMusic, internals: Record<string, any>, created: DMusicObject[], reads: string[];
let nextCom = 0x8000;

const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const be16 = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const SMF = Uint8Array.from([...ascii("MThd"), ...be32(6), ...be16(0), ...be16(1), ...be16(96),
    ...ascii("MTrk"), ...be32(8), 0x00, 0x90, 0x3c, 0x64, 0x00, 0xff, 0x2f, 0x00]);

beforeEach(() => {
    mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);
    created = [];
    reads = [];
    const process = {
        resetGeneration: 0,
        getCurrentMemory: () => mem,
        memory: {
            alloc: () => 0, free: () => undefined,
            allocSystemBlock: (n: number) => { const p = nextCom; nextCom += (n + 15) & ~15; return p; },
            freeSystemBlock: () => undefined,
        },
        addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length },
        getModule: () => undefined,
    };
    system.process = process as never;
    (system as unknown as { fileSystem: unknown }).fileSystem = { currentDir: "C:\\GAME\\" };
    module = new DMusic();
    internals = module as unknown as Record<string, any>;
    internals.process = process;
    module.vtables = new Proxy({}, { get: () => ({ address: 0x1000 }) }) as never;
    internals.registerLoaderExports();
    internals.readSystemFile = (paths: string[]) => {
        if (!/\.dls$/i.test(paths[0]!)) reads.push(paths[0]!);
        return /(^|\\)song\.mid$/i.test(paths[0]!) ? SMF : null;
    };
    mem.set(guidBytes(IID_IUnknown), RIID);
    mem.set(guidBytes(CLSID_DirectMusicSegment), CLASS_AT);
    mem.set(guidBytes(ALL_TYPES), ALL_AT);
});

afterEach(() => {
    for (const o of created) o.forceRelease();
    system.process = savedProcess;
    (system as unknown as { fileSystem: unknown }).fileSystem = savedFs;
});

function call(name: string, args: number[]): number {
    return module.exports[`IDirectMusicLoader8_${name}`]!({} as never, mem, args) as number;
}

function writeWide(at: number, text: string): void {
    for (let i = 0; i < text.length; i++) new DataView(mem.buffer).setUint16(at + i * 2, text.charCodeAt(i), true);
    new DataView(mem.buffer).setUint16(at + text.length * 2, 0, true);
}

function loader(): { obj: LoaderObject; ptr: number } {
    expect(module.coCreateInstance(CLSID_DirectMusicLoader, IID_IUnknown, OUT)).toBe(0);
    const ptr = Mem.readUint32(OUT)!;
    const obj = rp.getComObjectByAddress(ptr) as LoaderObject;
    created.push(obj);
    return { obj, ptr };
}

function getObject(ptr: number, name: string): number {
    mem.fill(0, DESC_AT, DESC_AT + 0x350);
    new DataView(mem.buffer).setUint32(DESC_AT + DESC.validData, DMUS_OBJ_FILENAME, true);
    writeWide(DESC_AT + DESC.fileName, name);
    expect(call("GetObject", [ptr, DESC_AT, RIID, OUT])).toBe(0);
    const out = Mem.readUint32(OUT)!;
    created.push(rp.getComObjectByAddress(out) as DMusicObject);
    return out;
}

describe("DirectMusic loader cache", () => {
    test("a second GetObject for the same file returns the same object, whatever the case of the name", () => {
        const { ptr } = loader();
        writeWide(PATH_AT, "C:\\GAME\\MUSIC");
        call("SetSearchDirectory", [ptr, ALL_AT, PATH_AT, 0]);
        const first = getObject(ptr, "song.mid");
        const second = getObject(ptr, "SONG.MID");
        expect(second).toBe(first);
        expect(reads).toEqual(["C:\\GAME\\MUSIC\\song.mid"]);
    });

    test("without the cache every GetObject loads a new object", () => {
        const { ptr } = loader();
        expect(call("EnableCache", [ptr, CLASS_AT, 0])).toBe(0);
        expect(call("EnableCache", [ptr, CLASS_AT, 0])).toBe(S_FALSE);
        const first = getObject(ptr, "song.mid");
        const second = getObject(ptr, "song.mid");
        expect(second).not.toBe(first);
        expect(reads.length).toBe(2);
        expect(call("EnableCache", [ptr, CLASS_AT, 1])).toBe(0);
        expect(getObject(ptr, "song.mid")).toBe(getObject(ptr, "song.mid"));
    });

    test("ClearCache and ReleaseObject drop the cached object and its reference", () => {
        const { ptr } = loader();
        const first = getObject(ptr, "song.mid");
        const segment = rp.getComObjectByAddress(first)!;
        const refs = segment.addRef() - 1;
        segment.release();
        expect(call("ClearCache", [ptr, ALL_AT])).toBe(0);
        expect(segment.addRef() - 1).toBe(refs - 1);
        segment.release();
        const second = getObject(ptr, "song.mid");
        expect(second).not.toBe(first);
        expect(call("ReleaseObject", [ptr, second])).toBe(0);
        expect(call("ReleaseObject", [ptr, second])).toBe(DMUS_E_LOADER_OBJECTNOTFOUND);
        expect(getObject(ptr, "song.mid")).not.toBe(second);
    });

    test("the loader releases what it cached when it goes", () => {
        const { obj, ptr } = loader();
        const segment = rp.getComObjectByAddress(getObject(ptr, "song.mid"))!;
        const refs = segment.addRef() - 1;
        segment.release();
        obj.release();
        expect(segment.addRef() - 1).toBe(refs - 1);
        segment.release();
    });
});

describe("DirectMusic loader search directory", () => {
    test("a NULL path means the current directory", () => {
        const { ptr } = loader();
        writeWide(PATH_AT, "C:\\OTHER");
        call("SetSearchDirectory", [ptr, ALL_AT, PATH_AT, 0]);
        expect(call("SetSearchDirectory", [ptr, ALL_AT, 0, 0])).toBe(0);
        getObject(ptr, "song.mid");
        expect(reads).toEqual(["C:\\GAME\\song.mid"]);
    });

    test("a path is used as given", () => {
        const { ptr } = loader();
        writeWide(PATH_AT, "C:\\GAME\\MUSIC\\");
        call("SetSearchDirectory", [ptr, ALL_AT, PATH_AT, 0]);
        getObject(ptr, "song.mid");
        expect(reads).toEqual(["C:\\GAME\\MUSIC\\song.mid"]);
    });
});
