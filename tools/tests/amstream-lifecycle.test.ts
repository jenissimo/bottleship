import {afterEach, beforeEach, expect, test} from "bun:test";
import {Amstream, CLSID_AMMultiMediaStream} from "../../src/worker/modules/amstream";
import {System} from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {SystemResourceProvider} from "../../src/worker/core/resources/system-resource-provider";
import {videoEngine} from "../../src/video/video-engine";

const system = System.getInstance(), rp = SystemResourceProvider.getInstance();
const OUT = 0x200, PATH = 0x300, E_FAIL = 0x80004005 | 0;
let module: Amstream, mem: Uint8Array, object: any, ptr: number, epoch = 1500;
let savedProcess: any, savedVfs: any, savedRead: any, savedLoaded: any, savedOpen: any;
let finishRead: (value: Uint8Array) => void, opens: number;
beforeEach(() => {
    savedProcess = system.process; savedVfs = system.fileSystem;
    savedLoaded = videoEngine.ensureLoaded; savedOpen = videoEngine.openLoaded;
    mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);
    let bump = 0x4000;
    const process = {
        memory: {systemPoolGeneration: ++epoch,
            allocSystemBlock: (n: number) => {const p = bump; bump += n; return p;},
            freeSystemBlock: () => {}},
        addressSpace: {validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length},
        getCurrentMemory: () => mem, getModule: () => undefined,
    };
    system.process = process as any;
    module = new Amstream();
    (module as any).process = process;
    module.vtables = new Proxy({}, {get: () => ({address: 0x1000})});
    (module as any).registerUnknownExports("IAMMultiMediaStream");
    (module as any).registerMultiMediaStreamExports();
    expect(module.coCreateInstance(CLSID_AMMultiMediaStream, "00000000-0000-0000-c000-000000000046", OUT)).toBe(0);
    ptr = Mem.readUint32(OUT)!;
    object = rp.getComObjectByAddress(ptr);
    "clip.avi".split("").forEach((c, i) => Mem.writeUint16(PATH + i * 2, c.charCodeAt(0)));
    savedRead = (module as any).readFile;
    (module as any).readFile = () => new Promise<Uint8Array>(resolve => {finishRead = resolve;});
    opens = 0;
    videoEngine.ensureLoaded = async () => {};
    videoEngine.openLoaded = () => {opens++; throw new Error("unexpected decoder use");};
});
afterEach(() => {
    module.reset(); object.forceRelease();
    (module as any).readFile = savedRead;
    videoEngine.ensureLoaded = savedLoaded; videoEngine.openLoaded = savedOpen;
    system.process = savedProcess; system.fileSystem = savedVfs;
});
const open = () => module.exports.IAMMultiMediaStream_OpenFile!({} as never, mem, [ptr, PATH, 0]) as Promise<number>;

test("OpenFile cannot reopen a decoder after the stream is released", async () => {
    const pending = open();
    object.release();
    finishRead(new Uint8Array([1]));
    expect(await pending).toBe(E_FAIL);
    expect(opens).toBe(0);
});
test("OpenFile cannot publish into a reset guest session", async () => {
    const pending = open();
    module.reset();
    finishRead(new Uint8Array([1]));
    expect(await pending).toBe(E_FAIL);
    expect(opens).toBe(0);
});
test("a concurrent OpenFile cannot replace the pending source", async () => {
    const first = open();
    expect(await open()).toBe(0x80040408 | 0);
    module.reset(); finishRead(new Uint8Array([1])); await first;
});
test("asynchronous Update is refused without falsely signaling completion", () => {
    (module as any).registerSampleExports();
    const savedObject = (module as any).object;
    (module as any).object = () => ({stream: {owner: {running: true, endOfStream: true}}, status: 0});
    try {
        expect(module.exports.IDirectDrawStreamSample_Update!({} as never, mem, [1, 1, 0x1234, 0, 0])).toBe(0x80004001 | 0);
    } finally {(module as any).object = savedObject;}
});

test("GetSurface validates every output before publishing an owned reference", () => {
    (module as any).registerSampleExports();
    const savedObject = (module as any).object;
    (module as any).object = () => ({surface: ptr});
    const refs = object.refCount;
    try {
        expect(module.exports.IDirectDrawStreamSample_GetSurface!({} as never, mem,
            [1, OUT, mem.length - 4])).toBe(0x80004003 | 0);
        expect(object.refCount).toBe(refs);
    } finally {(module as any).object = savedObject;}
});
