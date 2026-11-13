import {afterEach, beforeEach, expect, test} from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import {System} from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {SystemResourceProvider} from "../../src/worker/core/resources/system-resource-provider";
import {DMusic} from "../../src/worker/modules/dmusic";
import {
    CLSID_DirectMusicPerformance, CLSID_DirectMusicSegment, CLSID_DirectMusicComposer, IID_IUnknown,
    type DMusicObject, type PerformanceObject, type SegmentObject, type AudioPathObject,
} from "../../src/worker/modules/dmusic-objects";
import { preserveMemBinding, preserveComVtableOwners, preserveComReleaseTracking } from "./helpers/scoped-process-state";
preserveMemBinding(); preserveComVtableOwners(); preserveComReleaseTracking();

import {PerfSegment, Performance} from "../../src/worker/core/audio/directmusic/performance";
import type {Style} from "../../packages/formats/src/dmusic/style";
import {DlsSynth} from "../../src/worker/core/audio/directmusic/synth";

const system = System.getInstance(), savedProcess = system.process, savedScheduler = system.scheduler, OUT = 0x200;
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
    for (const method of ["registerObjectExports", "registerPerformanceExports", "registerPortExports", "registerSegmentStateExports", "registerAudioPathExports", "registerComposerExports"]) internals[method]();
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
for (const type of [8, 1]) {
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

for (const target of [0, 0xdead, "segment"] as const) {
    test(`PlaySegmentEx path ${target} falls back to the default audio path`, () => {
        const { obj: perf, ptr } = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        perf.engine = new Performance(new DlsSynth(22050, 2));
        const segment = make<SegmentObject>(CLSID_DirectMusicSegment);
        segment.obj.segment = new PerfSegment(); segment.obj.segment.length = 3072;
        expect(call("IDirectMusicPerformance8_PlaySegmentEx", [ptr, segment.ptr, 0, 0, 0x80, 0, 0, 0, 0, target === "segment" ? segment.ptr : target])).toBe(0);
        call("IDirectMusicPerformance8_GetDefaultAudioPath", [ptr, 0x640]);
        const path = Mem.readUint32(0x640)!;
        objects.push(rp.getComObjectByAddress(path) as DMusicObject);
        perf.engine.render(new Float32Array(16), new Float32Array(16), 16);
        expect(perf.engine.isPlaying(segment.obj.segment, null)).toBe(true);
        expect(perf.engine.statesOnAudioPath(perf.defaultAudioPath!)).toHaveLength(1);
        expect(call("IDirectMusicPerformance8_StopEx", [ptr, path, 0, 0, 0])).toBe(0);
        expect(perf.engine.isPlaying(segment.obj.segment, null)).toBe(false);
    });
}

for (const withStyle of [false, true]) {
    test(`AutoTransition assigns the default path with style=${withStyle}`, () => {
        const { obj: perf, ptr } = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        perf.engine = new Performance(new DlsSynth(22050, 2));
        const composer = make<DMusicObject>(CLSID_DirectMusicComposer);
        const to = make<SegmentObject>(CLSID_DirectMusicSegment);
        to.obj.segment = new PerfSegment(); to.obj.segment.length = 3072;
        if (withStyle) {
            const from = make<SegmentObject>(CLSID_DirectMusicSegment);
            from.obj.segment = new PerfSegment(); from.obj.segment.length = 12000;
            const style: Style = {
                identity: {objectId: "", name: "", versionMS: 0, versionLS: 0, hasVersion: false},
                timeSig: {beatsPerMeasure: 4, beat: 4, gridsPerBeat: 4}, tempo: 120,
                bands: [], parts: new Map(), patterns: [], motifs: [],
            };
            from.obj.segment.styles = [{time: 0, style}];
            expect(call("IDirectMusicPerformance8_PlaySegmentEx", [ptr, from.ptr, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(0);
            perf.engine.render(new Float32Array(16), new Float32Array(16), 16);
        }
        expect(call("IDirectMusicComposer8_AutoTransition", [composer.ptr, ptr, to.ptr, 0, 0, 0, 0, 0x650, 0x654])).toBe(0);
        const toState = internals.object(Mem.readUint32(0x650)!).state;
        const transPtr = Mem.readUint32(0x654)!;
        const transition = transPtr ? internals.object(transPtr).state : null;
        expect(toState.audioPath).toBe(perf.defaultAudioPath);
        expect(Boolean(transition)).toBe(withStyle);
        if (transition) expect(transition.audioPath).toBe(perf.defaultAudioPath);
        call("IDirectMusicPerformance8_GetDefaultAudioPath", [ptr, 0x640]);
        const path = Mem.readUint32(0x640)!;
        expect(call("IDirectMusicPerformance8_StopEx", [ptr, path, 0, 0, 0])).toBe(0);
        expect(toState.ended).toBe(true);
        if (transition) expect(transition.ended).toBe(true);
        internals.object(path).release();
        internals.object(Mem.readUint32(0x650)!).release();
        if (transPtr) internals.object(transPtr).release();
    });
}

for (const type of [8, 1]) {
    test(`releasing path type ${type} clears live and queued state references`, () => {
        const {obj: perf, ptr} = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        perf.engine = new Performance(new DlsSynth(22050, 2));
        expect(call("IDirectMusicPerformance8_CreateStandardAudioPath", [ptr, type, 2, 1, 0x640])).toBe(0);
        const address = Mem.readUint32(0x640)!;
        const path = rp.getComObjectByAddress(address) as AudioPathObject;
        const segment = make<SegmentObject>(CLSID_DirectMusicSegment);
        segment.obj.segment = new PerfSegment(); segment.obj.segment.length = 3072;
        for (const flags of [0, 0x100]) {
            expect(call("IDirectMusicPerformance8_PlaySegmentEx", [ptr, segment.ptr, 0, 0, flags, 0, 0, 0x650, 0, address])).toBe(0);
            internals.object(Mem.readUint32(0x650)!).release();
            if (flags === 0) perf.engine.render(new Float32Array(16), new Float32Array(16), 16);
        }
        const state = perf.engine.activeStates()[0]!;
        expect(state.audioPath).toBe(path);
        expect(state.queued!.audioPath).toBe(path);
        expect(path.refCount).toBe(1);
        path.release();
        expect(path.refCount).toBe(0);
        expect(state.audioPath).toBeNull();
        expect(state.queued!.audioPath).toBeNull();
        expect(state.ended).toBe(false);
    });
}
