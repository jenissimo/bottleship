import {afterEach, beforeEach, expect, test} from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import {System} from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {SystemResourceProvider} from "../../src/worker/core/resources/system-resource-provider";
import {DMusic} from "../../src/worker/modules/dmusic";
import {
    CLSID_DirectMusicLoader, CLSID_DirectMusicSegment, CLSID_DirectMusicBand, IID_IUnknown,
    type DMusicObject, type LoaderObject, type SegmentObject,
} from "../../src/worker/modules/dmusic-objects";
import { preserveMemBinding, preserveComVtableOwners, preserveComReleaseTracking } from "./helpers/scoped-process-state";
preserveMemBinding(); preserveComVtableOwners(); preserveComReleaseTracking();


const system = System.getInstance(), savedFs = system.fileSystem, savedProcess = system.process, savedScheduler = system.scheduler, OUT = 0x200;
const E_POINTER = 0x80004003 | 0, E_FAIL = 0x80004005 | 0;
let mem: Uint8Array, module: DMusic, internals: any, heap: Set<number>, objects: DMusicObject[];
let denyWrite: boolean, epoch = 100, nextHeap: number, nextCom: number;
const rp = SystemResourceProvider.getInstance();

beforeEach(() => {
    system.scheduler = new Scheduler();
    mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);
    heap = new Set(); objects = []; denyWrite = false; nextHeap = 0x8000; nextCom = 0x4000;
    const process = {
        resetGeneration: 0,
        getCurrentMemory: () => mem,
        memory: {
            systemPoolGeneration: ++epoch,
            alloc: (n: number) => { const p = nextHeap; nextHeap += n; heap.add(p); return p; },
            free: (p: number) => { heap.delete(p); },
            allocSystemBlock: (n: number) => { const p = nextCom; nextCom += n; return p; },
            freeSystemBlock: () => {},
        },
        addressSpace: {validateRange: (p: number, n: number, perms: string) => p > 0 && p + n <= mem.length
            && !(denyWrite && perms.includes("w") && p < OUT + 8 && p + n > OUT)},
        environment: new Map([["PATH", "C:\\BIN;C:\\LIB"]]),
        getModule: () => undefined,
    };
    system.process = process as any;
    module = new DMusic();
    internals = module as any;
    internals.process = process;
    module.vtables = new Proxy({}, {get: () => ({address: 0x1000})}) as any;
    for (const method of ["registerObjectExports", "registerPerformanceExports", "registerPortExports", "registerSegmentStateExports", "registerAudioPathExports", "registerLoaderExports"]) internals[method]();
    new DataView(mem.buffer).setUint32(0x3000, 0x3100, true);
    new DataView(mem.buffer).setUint32(0x3100 + 3 * 4, 0x1300, true);
});
afterEach(() => {
    module.reset();
    for (const obj of objects) obj.forceRelease();
    system.fileSystem = savedFs;
    system.process = savedProcess;
    system.scheduler = savedScheduler;
});

function make<T extends DMusicObject>(clsid: string): {obj: T; ptr: number} {
    expect(module.coCreateInstance(clsid, IID_IUnknown, OUT)).toBe(0);
    const ptr = Mem.readUint32(OUT)!;
    const obj = rp.getComObjectByAddress(ptr) as T;
    objects.push(obj);
    return {obj, ptr};
}
function call(name: string, args: number[]): number {
    return module.exports[name]!({} as never, mem, args) as number;
}

const CLASS = 0x500, IID = 0x540, FILE = 0x1000, RESULT = 0x680;
const FAILEDOPEN = 0x88781182 | 0, FORMAT = 0x88781183 | 0;
function guid(at: number, text: string): void {
    const bytes = text.replace(/-/g, "").match(/../g)!.map(x => parseInt(x, 16));
    const raw = [bytes[3]!, bytes[2]!, bytes[1]!, bytes[0]!, bytes[5]!, bytes[4]!, bytes[7]!, bytes[6]!, ...bytes.slice(8)];
    Mem.writeBytes(at, new Uint8Array(raw));
}
function wide(at: number, text: string): void {
    for (let i = 0; i <= text.length; i++) Mem.writeUint16(at + i * 2, text.charCodeAt(i) || 0);
}
function wave(): Uint8Array {
    const b = new Uint8Array(48), v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("RIFF")); v.setUint32(4, 40, true);
    b.set(new TextEncoder().encode("WAVEfmt "), 8); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 22050, true);
    v.setUint32(28, 44100, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    b.set(new TextEncoder().encode("data"), 36); v.setUint32(40, 4, true);
    return b;
}
function fixture() {
    const loader = make<LoaderObject>(CLSID_DirectMusicLoader);
    const reads: string[] = [], files = new Map<string, Uint8Array>();
    const resolvePath = (path: string) => /^[a-z]:/i.test(path) ? path : "C:\\GAME\\" + path;
    system.fileSystem = {currentDir: "C:\\GAME", resolvePath} as never;
    loader.obj.searchDirectory = "C:\\SOUND";
    internals.readSystemFile = ([path]: string[]) => { reads.push(path!); return files.get(path!.toLowerCase()) ?? null; };
    guid(CLASS, CLSID_DirectMusicSegment); guid(IID, IID_IUnknown);
    const load = (name: string) => { wide(FILE, name); return call("IDirectMusicLoader8_LoadObjectFromFile", [loader.ptr, CLASS, IID, FILE, RESULT]); };
    const take = () => {
        const obj = rp.getComObjectByAddress(Mem.readUint32(RESULT)!) as SegmentObject;
        objects.push(obj); return obj;
    };
    return {loader, reads, files, load, take};
}
test("relative WAVE loads search cwd, PATH, then the loader directory", () => {
    const f = fixture(); f.files.set("c:\\sound\\tone.wav", wave());
    expect(f.load("tone.wav")).toBe(0);
    expect(f.reads).toEqual(["C:\\GAME\\tone.wav", "C:\\BIN\\tone.wav", "C:\\LIB\\tone.wav", "C:\\SOUND\\tone.wav"]);
    expect(f.take().segment!.wave!.frames).toBe(2);
});
test("cwd wins over PATH and the configured directory", () => {
    const f = fixture(); f.files.set("c:\\game\\tone.wav", wave()); f.files.set("c:\\sound\\tone.wav", new Uint8Array(1));
    expect(f.load("tone.wav")).toBe(0); f.take();
    expect(f.reads).toEqual(["C:\\GAME\\tone.wav"]);
});
test("absolute paths bypass search and cached interfaces retain caller ownership", () => {
    const f = fixture(); f.files.set("d:\\tone.wav", wave());
    expect(f.load("D:\\tone.wav")).toBe(0); const first = f.take();
    expect(first.refCount).toBe(2);
    expect(f.load("d:\\TONE.wav")).toBe(0); const second = f.take();
    expect(second).toBe(first); expect(first.refCount).toBe(3);
    expect(f.reads).toEqual(["D:\\tone.wav"]);
    first.release(); second.release();
    expect(first.refCount).toBe(1);
    call("IDirectMusicLoader8_ClearCache", [f.loader.ptr, CLASS]);
    expect(first.refCount).toBe(0);
});
test("disabled cache leaves only the caller's reference", () => {
    const f = fixture(); f.loader.obj.cacheDisabled.add(CLSID_DirectMusicSegment); f.files.set("c:\\game\\tone.wav", wave());
    expect(f.load("tone.wav")).toBe(0); const first = f.take();
    expect(first.refCount).toBe(1); first.release(); expect(first.refCount).toBe(0);
    expect(f.load("tone.wav")).toBe(0); expect(f.take()).not.toBe(first);
    expect(f.loader.obj.cache.size).toBe(0);
});
test("a failed interface query clears output, releases the object, and does not cache it", () => {
    const f = fixture(); f.files.set("c:\\game\\tone.wav", wave()); guid(IID, CLSID_DirectMusicBand);
    const before = rp.getAllComObjects().length;
    expect(f.load("tone.wav")).toBe(0x80004002 | 0);
    expect(Mem.readUint32(RESULT)).toBe(0); expect(f.loader.obj.cache.size).toBe(0);
    expect(rp.getAllComObjects().length).toBe(before);
});
test("missing, malformed, and unsupported-class files fail explicitly", () => {
    const f = fixture(); expect(f.load("missing.wav")).toBe(FAILEDOPEN);
    expect(Mem.readUint32(RESULT)).toBe(0);
    f.files.set("c:\\game\\bad.wav", new Uint8Array(20));
    expect(f.load("bad.wav")).toBe(FORMAT);
    guid(CLASS, CLSID_DirectMusicBand); expect(f.load("bad.wav")).toBe(0x80040154 | 0);
});
test("invalid pointers and unterminated filenames cannot publish an interface", () => {
    const f = fixture();
    for (const index of [1, 2, 3, 4]) {
        const args = [f.loader.ptr, CLASS, IID, FILE, RESULT]; args[index] = mem.length;
        expect(call("IDirectMusicLoader8_LoadObjectFromFile", args)).toBe(E_POINTER);
    }
    expect(f.load("")).toBe(0x80070057 | 0);
    Mem.writeBytes(FILE, new Uint8Array(522).fill(65));
    expect(call("IDirectMusicLoader8_LoadObjectFromFile", [f.loader.ptr, CLASS, IID, FILE, RESULT])).toBe(0x80070057 | 0);
    expect(f.reads).toEqual([]);
});
