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


    test("StopEx on an audio path stops only what plays on that path; an empty target stops nothing", () => {
        const {obj: perf, ptr: perfPtr} = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        const stops: unknown[][] = [];
        (perf as any).engine = { stop: (seg: unknown, state: unknown, flags: number) => stops.push([seg, state, flags]) };
        const PP = 0x640;
        call("IDirectMusicPerformance8_CreateStandardAudioPath", [perfPtr, 8, 2, 1, PP]);
        const pathA = Mem.readUint32(PP)!;
        call("IDirectMusicPerformance8_CreateStandardAudioPath", [perfPtr, 8, 2, 1, PP]);
        const pathB = Mem.readUint32(PP)!;
        const a = rp.getComObjectByAddress(pathA) as any, b = rp.getComObjectByAddress(pathB) as any;
        objects.push(a, b);
        const s1 = { id: 1, output: a }, s2 = { id: 2, output: b }, s3 = { id: 3, output: a };
        (perf.engine as any).statesOnOutput = (path: unknown) => [s1, s2, s3].filter(state => state.output === path);

        expect(call("IDirectMusicPerformance8_StopEx", [perfPtr, pathA, 0, 0, 0x40])).toBe(0);
        expect(stops).toEqual([[null, s1, 0x40], [null, s3, 0x40]]);

        stops.length = 0;
        const {ptr: unloaded} = make<SegmentObject>(CLSID_DirectMusicSegment); // nothing loaded behind it
        expect(call("IDirectMusicPerformance8_StopEx", [perfPtr, unloaded, 0, 0, 0])).toBe(0);
        expect(call("IDirectMusicPerformance8_Stop", [perfPtr, unloaded, 0, 0, 0])).toBe(0);
        expect(stops).toEqual([]);

        expect(call("IDirectMusicPerformance8_StopEx", [perfPtr, 0, 0, 0, 0])).toBe(0);
        expect(stops).toEqual([[null, null, 0]]);
    });
