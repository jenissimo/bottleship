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



for (const type of [8, 4]) {
    test(`PlaySegmentEx tracks non-wave segments on path type ${type}`, () => {
        const { obj: perf, ptr } = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        perf.engine = new Performance(new DlsSynth(22050, 2));
        const path = (kind: number) => {
            call("IDirectMusicPerformance8_CreateStandardAudioPath", [ptr, kind, 2, 1, 0x640]);
            const address = Mem.readUint32(0x640)!;
            const obj = rp.getComObjectByAddress(address) as DMusicObject; objects.push(obj);
            return { address, obj };
        };
        const a = path(type), b = path(type);
        const play = (output: number) => {
            const segment = make<SegmentObject>(CLSID_DirectMusicSegment);
            segment.obj.segment = new PerfSegment(); segment.obj.segment.length = 3072;
            expect(call("IDirectMusicPerformance8_PlaySegmentEx", [ptr, segment.ptr, 0, 0, 0x80, 0, 0, 0, 0, output])).toBe(0);
            return segment.obj.segment;
        };
        const first = play(a.address), other = play(b.address), third = play(a.address);
        perf.engine.render(new Float32Array(16), new Float32Array(16), 16);
        expect(perf.engine.statesOnAudioPath(a.obj)).toHaveLength(2);
        expect(perf.engine.statesOnAudioPath(a.obj).every(s => s.output === null)).toBe(true);
        expect(call("IDirectMusicPerformance8_StopEx", [ptr, a.address, 0, 0, 0])).toBe(0);
        expect(perf.engine.isPlaying(first, null)).toBe(false);
        expect(perf.engine.isPlaying(third, null)).toBe(false);
        expect(perf.engine.isPlaying(other, null)).toBe(true);
        expect(perf.engine.statesOnAudioPath(a.obj)).toHaveLength(0);
        expect(call("IDirectMusicPerformance8_StopEx", [ptr, 0xdead, 0, 0, 0])).toBe(0);
        const unloaded = make<SegmentObject>(CLSID_DirectMusicSegment);
        expect(call("IDirectMusicPerformance8_StopEx", [ptr, unloaded.ptr, 0, 0, 0])).toBe(0);
        expect(call("IDirectMusicPerformance8_Stop", [ptr, unloaded.ptr, 0, 0, 0])).toBe(0);
        expect(perf.engine.isPlaying(other, null)).toBe(true);
        expect(call("IDirectMusicPerformance8_StopEx", [ptr, 0, 0, 0, 0])).toBe(0);
        expect(perf.engine.isPlaying(other, null)).toBe(false);
    });
}

test("a null PlaySegmentEx path is owned by the default audio path", () => {
    const { obj: perf, ptr } = make<PerformanceObject>(CLSID_DirectMusicPerformance);
    perf.engine = new Performance(new DlsSynth(22050, 2));
    const segment = make<SegmentObject>(CLSID_DirectMusicSegment);
    segment.obj.segment = new PerfSegment(); segment.obj.segment.length = 3072;
    expect(call("IDirectMusicPerformance8_PlaySegmentEx", [ptr, segment.ptr, 0, 0, 0x80, 0, 0, 0, 0, 0])).toBe(0);
    call("IDirectMusicPerformance8_GetDefaultAudioPath", [ptr, 0x640]);
    const path = Mem.readUint32(0x640)!;
    objects.push(rp.getComObjectByAddress(path) as DMusicObject);
    perf.engine.render(new Float32Array(16), new Float32Array(16), 16);
    expect(perf.engine.isPlaying(segment.obj.segment, null)).toBe(true);
    expect(perf.engine.statesOnAudioPath(perf.defaultAudioPath!)).toHaveLength(1);
    expect(call("IDirectMusicPerformance8_StopEx", [ptr, path, 0, 0, 0])).toBe(0);
    expect(perf.engine.isPlaying(segment.obj.segment, null)).toBe(false);
});
