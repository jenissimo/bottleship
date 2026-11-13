import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import {System} from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {SystemResourceProvider} from "../../src/worker/core/resources/system-resource-provider";
import {DMusic} from "../../src/worker/modules/dmusic";
import {
    CLSID_DirectMusic, CLSID_DirectMusicPerformance, CLSID_DirectMusicSegment, CLSID_DirectMusicBand,
    CLSID_DirectMusicStyle, CLSID_DirectMusicCollection, IID_IUnknown, IID_IPersistStream,
    type DMusicObject, type PerformanceObject, type SegmentObject, type PortObject, type LoadableObject,
} from "../../src/worker/modules/dmusic-objects";
import { preserveMemBinding, preserveComVtableOwners, preserveComReleaseTracking } from "./helpers/scoped-process-state";
preserveMemBinding(); preserveComVtableOwners(); preserveComReleaseTracking();

import {PerfSegment, Performance} from "../../src/worker/core/audio/directmusic/performance";
import {DlsSynth} from "../../src/worker/core/audio/directmusic/synth";

const system = System.getInstance(), savedProcess = system.process, savedScheduler = system.scheduler, OUT = 0x200;
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
        getModule: () => undefined,
    };
    system.process = process as any;
    module = new DMusic();
    internals = module as any;
    internals.process = process;
    module.vtables = new Proxy({}, {get: () => ({address: 0x1000})}) as any;
    for (const method of ["registerObjectExports", "registerPerformanceExports", "registerPortExports", "registerSegmentStateExports", "registerAudioPathExports"]) internals[method]();
    new DataView(mem.buffer).setUint32(0x3000, 0x3100, true);
    new DataView(mem.buffer).setUint32(0x3100 + 3 * 4, 0x1300, true);
});
afterEach(() => {
    module.reset();
    for (const obj of objects) obj.forceRelease();
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
function riff(): Uint8Array {
    const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, 16, true);
    bytes.set(new TextEncoder().encode("DMSGdata"), 8); view.setUint32(16, 4, true);
    return bytes;
}


    test("InitAudio creates the DirectSound object when *ppDirectSound is NULL and returns it", () => {
        internals.activatePort = () => true;
        const calls: string[] = [];
        let refs = 0;
        const dsound = { exports: {
            directsoundcreate8: (_c: unknown, _m: unknown, a: number[]) => { calls.push("create"); refs = 1; Mem.writeUint32(a[1]!, 0x7000); return 0; },
            idirectsound8_setcooperativelevel: (_c: unknown, _m: unknown, a: number[]) => { calls.push(`coop ${a[0]!.toString(16)} ${a[1]!.toString(16)} ${a[2]}`); return 0; },
            IDirectSound8_AddRef: () => ++refs,
            IDirectSound8_Release: () => --refs,
        } };
        internals.process.getModule = (name: string) => (name === "dsound" ? dsound : undefined);
        const {ptr} = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        const ppDS = 0x600;
        Mem.writeUint32(ppDS, 0);
        expect(call("IDirectMusicPerformance8_InitAudio", [ptr, 0, ppDS, 0x10001, 0, 64, 0, 0])).toBe(0);
        expect(Mem.readUint32(ppDS)).toBe(0x7000);
        expect(calls).toEqual(["create", "coop 7000 10001 2"]);
        expect(refs).toBe(3); // caller, DirectMusic object, and default port

        // A caller-supplied object is used as it is; nothing new is created.
        calls.length = 0;
        const other = make<PerformanceObject>(CLSID_DirectMusicPerformance).ptr;
        call("IDirectMusicPerformance8_InitAudio", [other, 0, ppDS, 0x10001, 0, 64, 0, 0]);
        expect(calls).toEqual([]);
        expect(Mem.readUint32(ppDS)).toBe(0x7000);
        module.reset();
        expect(refs).toBe(1); // only the caller retains it after closing both performances
    });

test("InitAudio rejects a bad out pointer before creating DirectSound", () => {
    let calls = 0;
    internals.process.getModule = () => { calls++; return undefined; };
    const { ptr } = make<PerformanceObject>(CLSID_DirectMusicPerformance);
    expect(call("IDirectMusicPerformance8_InitAudio", [ptr, 0, mem.length - 1, 0, 0, 64, 0, 0])).toBe(E_POINTER);
    expect(calls).toBe(0);
});

test("a failed cooperative-level setup releases the new device and leaves the output empty", () => {
    let refs = 0;
    internals.process.getModule = () => ({ exports: {
        directsoundcreate8: (_c: unknown, _m: unknown, a: number[]) => { refs++; Mem.writeUint32(a[1]!, 0x7000); return 0; },
        idirectsound8_setcooperativelevel: () => E_FAIL,
        IDirectSound8_Release: () => --refs,
    } });
    const { ptr } = make<PerformanceObject>(CLSID_DirectMusicPerformance);
    Mem.writeUint32(0x600, 0);
    expect(call("IDirectMusicPerformance8_InitAudio", [ptr, 0, 0x600, 0, 0, 64, 0, 0])).toBe(E_FAIL);
    expect(Mem.readUint32(0x600)).toBe(0);
    expect(refs).toBe(0);
    expect(heap.size).toBe(0);
});
