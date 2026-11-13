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


    test("an audio path hands back its own DirectSound buffer for DMUS_PATH_BUFFER, and frees it with the path", () => {
        const released: number[] = [];
        let made = 0, plays = 0, locks = 0;
        const dsound = { exports: {
            directsoundcreate: (_c: unknown, _m: unknown, a: number[]) => { Mem.writeUint32(a[1]!, 0x7000); return 0; },
            idirectsound8_createsoundbuffer: (_c: unknown, _m: unknown, a: number[]) => { made++; Mem.writeUint32(a[2]!, 0x7100); return 0; },
            idirectsoundbuffer8_getcaps: (_c: unknown, _m: unknown, a: number[]) => { Mem.writeUint32(a[1]! + 8, 4096); return 0; },
            idirectsoundbuffer8_play: () => { plays++; return 0; },
            idirectsoundbuffer8_lock: () => { locks++; return E_FAIL; },
            idirectsoundbuffer8_stop: () => 0,
            IDirectSoundBuffer8_QueryInterface: (_c: unknown, _m: unknown, a: number[]) => { Mem.writeUint32(a[2]!, a[0]!); return 0; },
            IDirectSoundBuffer8_Release: (_c: unknown, _m: unknown, a: number[]) => { released.push(a[0]!); return 0; },
            IDirectSound8_Release: () => 0,
        } };
        internals.process.getModule = (name: string) => (name === "dsound" ? dsound : undefined);
        const {ptr: perf, obj: performance} = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        const PP = 0x640, GUID_NULL = 0x660, IID = 0x680;
        expect(call("IDirectMusicPerformance8_CreateStandardAudioPath", [perf, 8, 2, 1, PP])).toBe(0);
        const path = Mem.readUint32(PP)!;
        const get = (stage: number, buffer = 0) => call("IDirectMusicAudioPath_GetObjectInPath", [path, 0xfffffffb, stage, buffer, GUID_NULL, 0, IID, 0x6a0]);
        expect(get(0x6000)).toBe(0);
        expect(Mem.readUint32(0x6a0)).toBe(0x7100);
        expect(get(0x6000)).toBe(0); // the same buffer every time
        expect(made).toBe(1);
        expect(plays).toBe(0); expect(locks).toBe(0);
        expect(internals.pathOutputs.size).toBe(0); expect(internals.pumpTimer).toBeNull();
        expect(get(0x6000, 1)).not.toBe(0); // a path has one buffer
        expect(get(0x3000)).not.toBe(0);    // performance stage: nothing to hand back
        expect(Mem.readUint32(0x6a0)).toBe(0);
        performance.engine = new Performance(new DlsSynth(22050, 2));
        const segment = make<SegmentObject>(CLSID_DirectMusicSegment);
        segment.obj.segment = PerfSegment.fromWave({ channels: [new Float32Array(22050)], rate: 22050, frames: 22050 });
        expect(call("IDirectMusicPerformance8_PlaySegmentEx", [perf, segment.ptr, 0, 0, 0x80, 0, 0, 0, 0, path])).toBe(0);
        expect(made).toBe(1); expect(plays).toBe(1);
        expect(internals.pathOutputs.size).toBe(1); expect(internals.pumpTimer).not.toBeNull();
        expect((rp.getComObjectByAddress(path) as any).sink).not.toBeNull();
        const obj = rp.getComObjectByAddress(path) as DMusicObject;
        obj.forceRelease();
        expect(released).toContain(0x7100);
    });
