import {afterEach, beforeEach, expect, test} from "bun:test";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import {System} from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {SystemResourceProvider} from "../../src/worker/core/resources/system-resource-provider";
import {DMusic} from "../../src/worker/modules/dmusic";
import {
    CLSID_DirectMusicPerformance, IID_IUnknown,
    type DMusicObject, type PerformanceObject, type AudioPathObject,
} from "../../src/worker/modules/dmusic-objects";
import { preserveMemBinding, preserveComVtableOwners, preserveComReleaseTracking } from "./helpers/scoped-process-state";
preserveMemBinding(); preserveComVtableOwners(); preserveComReleaseTracking();

import {TimeService} from "../../src/worker/runtime/time";
import {Performance} from "../../src/worker/core/audio/directmusic/performance";
import {DlsSynth} from "../../src/worker/core/audio/directmusic/synth";

const system = System.getInstance(), savedProcess = system.process, savedScheduler = system.scheduler, OUT = 0x200;
const E_POINTER = 0x80004003 | 0, E_FAIL = 0x80004005 | 0;
let mem: Uint8Array, module: DMusic, internals: any, heap: Set<number>, objects: DMusicObject[];
let now = 0;
const clock = TimeService.getInstance(), realNow = clock.nowMs;
let denyWrite: boolean, epoch = 100, nextHeap: number, nextCom: number;
const rp = SystemResourceProvider.getInstance();

beforeEach(() => {
    system.scheduler = new Scheduler();
    now = 0; clock.nowMs = () => now;
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
    clock.nowMs = realNow;
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

function fixture(type = 8) {
    const perf = make<PerformanceObject>(CLSID_DirectMusicPerformance);
    perf.obj.engine = new Performance(new DlsSynth(22050, 2));
    expect(call("IDirectMusicPerformance8_CreateStandardAudioPath", [perf.ptr, type, 2, 1, 0x640])).toBe(0);
    const ptr = Mem.readUint32(0x640)!, path = rp.getComObjectByAddress(ptr) as AudioPathObject;
    objects.push(path);
    const volumes: number[] = [];
    let made = 0, plays = 0, releases = 0, failure = false;
    internals.process.getModule = () => ({exports: {
        directsoundcreate: (_c: unknown, _m: unknown, a: number[]) => { Mem.writeUint32(a[1]!, 0x7000); return 0; },
        idirectsound8_createsoundbuffer: (_c: unknown, _m: unknown, a: number[]) => { made++; Mem.writeUint32(a[2]!, 0x7100); return 0; },
        idirectsound8_release: () => 0,
        idirectsoundbuffer8_setvolume: (_c: unknown, _m: unknown, a: number[]) => { if (failure) return E_FAIL; volumes.push(a[1]!); return 0; },
        idirectsoundbuffer8_addref: () => 2,
        idirectsoundbuffer8_release: () => { releases++; return 0; },
        idirectsoundbuffer8_play: () => { plays++; return 0; },
    }});
    return {perf, path, ptr, volumes, set: (value: number, ms = 0) => call("IDirectMusicAudioPath_SetVolume", [ptr, value, ms]),
        counts: () => ({made, plays, releases}), fail: (value: boolean) => { failure = value; }};
}

test("volume set before buffer creation is applied without starting playback", () => {
    const f = fixture();
    expect(f.set(-900)).toBe(0);
    expect(f.path.buffer).toBe(0); expect(f.counts()).toEqual({made: 0, plays: 0, releases: 0});
    expect(internals.ensurePathBuffer(f.path)).toBe(true);
    expect(f.volumes).toEqual([-900]); expect(f.counts().plays).toBe(0);
    expect(f.set(-1200)).toBe(0); expect(f.volumes).toEqual([-900, -1200]);
});
test("fades follow the requested duration and a replacement starts at the current level", () => {
    const f = fixture(); expect(internals.ensurePathBuffer(f.path)).toBe(true);
    expect(f.set(-1000, 100)).toBe(0);
    now = 50; internals.pump(); expect(f.volumes.at(-1)).toBe(-500);
    expect(f.set(-1500, 200)).toBe(0);
    now = 150; internals.pump(); expect(f.volumes.at(-1)).toBe(-1000);
    now = 250; internals.pump(); expect(f.volumes.at(-1)).toBe(-1500);
    expect(internals.volumeFades.size).toBe(0); expect(internals.pumpTimer).toBeNull();
});
test("a fade can finish before a lazy buffer is requested", () => {
    const f = fixture(); expect(f.set(-2000, 100)).toBe(0);
    now = 100; internals.pump();
    expect(f.path.volume).toBe(-2000); expect(f.path.buffer).toBe(0);
    expect(internals.ensurePathBuffer(f.path)).toBe(true);
    expect(f.volumes).toEqual([-2000]); expect(f.counts().plays).toBe(0);
});
test("invalid attenuation and unsupported/uninitialized paths fail without changing state", () => {
    const f = fixture();
    expect(f.set(1)).toBe(0x80070057 | 0); expect(f.set(-9601)).toBe(0x80070057 | 0);
    expect(f.path.volume).toBe(0);
    f.perf.obj.engine = null;
    expect(f.set(-100)).toBe(0x88781162 | 0);
    const shared = fixture(1); expect(shared.set(-100)).toBe(0x80004001 | 0);
    expect(call("IDirectMusicAudioPath_SetVolume", [0xdead, -100, 0])).toBe(E_POINTER);
});
test("buffer failures propagate and failed lazy initialization releases its buffer", () => {
    const f = fixture(); expect(internals.ensurePathBuffer(f.path)).toBe(true);
    f.fail(true); expect(f.set(-100)).toBe(E_FAIL); expect(f.path.volume).toBe(0);
    f.fail(false); expect(f.set(-100, 100)).toBe(0);
    f.fail(true); now = 50; internals.pump();
    expect(f.path.volume).toBe(0); expect(internals.volumeFades.size).toBe(0);
    const lazy = fixture(); expect(lazy.set(-400)).toBe(0); lazy.fail(true);
    expect(internals.ensurePathBuffer(lazy.path)).toBe(false);
    expect(lazy.path.buffer).toBe(0); expect(lazy.counts().releases).toBe(1);
});
test("releasing a fading path removes it from control updates and stops an idle pump", () => {
    const f = fixture(); expect(f.set(-1000, 100)).toBe(0);
    f.path.release();
    expect(internals.volumeFades.size).toBe(0); expect(internals.pumpTimer).toBeNull();
    now = 200; internals.pump(); expect(f.volumes).toEqual([]);
});

test("an immediate change interrupts the fade and removes an otherwise idle pump", () => {
    const f = fixture(); expect(f.set(-1000, 100)).toBe(0);
    now = 30; expect(f.set(-400)).toBe(0);
    expect(f.path.volume).toBe(-400); expect(f.path.volumeDuration).toBe(0);
    expect(internals.volumeFades.size).toBe(0); expect(internals.pumpTimer).toBeNull();
});
