import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {System} from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {SystemResourceProvider} from "../../src/worker/core/resources/system-resource-provider";
import {DMusic} from "../../src/worker/modules/dmusic";
import {
    CLSID_DirectMusic, CLSID_DirectMusicPerformance, CLSID_DirectMusicSegment, CLSID_DirectMusicBand,
    CLSID_DirectMusicStyle, CLSID_DirectMusicCollection, IID_IUnknown, IID_IPersistStream,
    GraphObject, type DMusicObject, type PerformanceObject, type SegmentObject, type PortObject, type LoadableObject,
} from "../../src/worker/modules/dmusic-objects";
import {PerfSegment, Performance} from "../../src/worker/core/audio/directmusic/performance";
import {DlsSynth} from "../../src/worker/core/audio/directmusic/synth";

const system = System.getInstance(), savedProcess = system.process, OUT = 0x200;
const E_POINTER = 0x80004003 | 0, E_FAIL = 0x80004005 | 0;
let mem: Uint8Array, module: DMusic, internals: any, heap: Set<number>, objects: DMusicObject[];
let denyWrite: boolean, epoch = 100, nextHeap: number, nextCom: number;
const rp = SystemResourceProvider.getInstance();

beforeEach(() => {
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
    for (const method of ["registerObjectExports", "registerPerformanceExports", "registerPortExports", "registerSegmentStateExports", "registerAudioPathExports", "registerGraphExports"]) internals[method]();
    new DataView(mem.buffer).setUint32(0x3000, 0x3100, true);
    new DataView(mem.buffer).setUint32(0x3100 + 3 * 4, 0x1300, true);
});
afterEach(() => {
    module.reset();
    for (const obj of objects) obj.forceRelease();
    system.process = savedProcess;
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

describe("DirectMusic streams and COM lifetimes", () => {
    test("short header/body and missing pcbRead never load stale bytes; scratch is freed", () => {
        for (const bad of ["header", "body", "missing count"]) {
            const it = internals.readStream(0x3000);
            let step = it.next();
            const a = step.value.args;
            Mem.writeBytes(a[1], riff().subarray(0, 12));
            Mem.writeUint32(a[3], bad === "header" ? 8 : 12);
            step = it.next(bad === "header" ? 1 : 0);
            if (!step.done) {
                const body = step.value.args;
                Mem.writeBytes(body[1], riff().subarray(12));
                if (bad !== "missing count") Mem.writeUint32(body[3], 4);
                step = it.next(1);
            }
            expect(step.done).toBe(true);
            expect(step.value).toBeNull();
            expect(heap.size).toBe(0);
        }
    });

    test("a complete stream is reproduced exactly across the two Read calls", () => {
        const it = internals.readStream(0x3000), bytes = riff();
        let step = it.next();
        Mem.writeBytes(step.value.args[1], bytes.subarray(0, 12));
        Mem.writeUint32(step.value.args[3], 12);
        step = it.next(0);
        Mem.writeBytes(step.value.args[1], bytes.subarray(12));
        Mem.writeUint32(step.value.args[3], 12);
        step = it.next(0);
        expect(step.done).toBe(true);
        expect(step.value).toEqual(bytes);
        expect(heap.size).toBe(0);
    });

    test("QueryInterface failure cannot add a reference or publish an alias", () => {
        const {obj} = make(CLSID_DirectMusicSegment);
        const before = obj.addresses.size;
        Mem.writeUint32(OUT, 0x12345678);
        denyWrite = true;
        expect(internals.queryInterface(obj, IID_IPersistStream, OUT)).toBe(E_POINTER);
        expect(obj.refCount).toBe(1);
        expect(obj.addresses.size).toBe(before);
        expect(Mem.readUint32(OUT)).toBe(0x12345678);
        denyWrite = false;
        expect(internals.queryInterface(obj, IID_IPersistStream, OUT)).toBe(0);
        expect(obj.refCount).toBe(2);
        obj.release();
    });

    test("publishing a new object to an invalid output releases the creation reference", () => {
        const {obj} = make(CLSID_DirectMusicBand);
        expect(internals.publish(obj, mem.length - 2)).toBe(E_POINTER);
        expect(obj.refCount).toBe(0);
        expect(rp.getComObjectByAddress([...obj.addresses.values()][0] ?? 0)).toBeNull();
    });

    test("nested Load of the same object fails and pins are released on cancellation", () => {
        const {obj} = make<LoadableObject>(CLSID_DirectMusicSegment);
        const first = internals.load(obj, 0x3000);
        expect(first.next().done).toBe(false);
        expect(obj.refCount).toBe(2);
        expect(internals.load(obj, 0x3000).next()).toEqual({done: true, value: E_FAIL});
        first.return(E_FAIL);
        expect(obj.refCount).toBe(1);
        expect(internals.loading.size).toBe(0);
        expect(heap.size).toBe(0);
    });

    test("reference-cycle check catches self and transitive edges", () => {
        const a = make<LoadableObject>(CLSID_DirectMusicSegment).obj;
        const b = make<LoadableObject>(CLSID_DirectMusicStyle).obj;
        const c = make<LoadableObject>(CLSID_DirectMusicCollection).obj;
        expect(internals.referenceWouldCycle(a, a)).toBe(true);
        expect(internals.referenceWouldCycle(a, b)).toBe(false);
        b.references.push(c); c.references.push(a);
        expect(internals.referenceWouldCycle(a, b)).toBe(true);
    });

    test("performance owns supplied DirectMusic and port until CloseDown", () => {
        const perf = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        const dm = make(CLSID_DirectMusic);
        Mem.writeUint32(OUT, dm.ptr);
        expect(call("IDirectMusicPerformance8_Init", [perf.ptr, OUT, 0, 0])).toBe(0);
        dm.obj.release();
        expect(dm.obj.refCount).toBe(1);
        const port = internals.createPort(dm.obj, 22050, 2, 8) as PortObject;
        objects.push(port);
        const portPtr = internals.addressOf(port, port.primaryVtable);
        expect(call("IDirectMusicPerformance8_AddPort", [perf.ptr, portPtr])).toBe(0);
        port.release();
        expect(port.refCount).toBe(1);
        denyWrite = true;
        expect(call("IDirectMusicPerformance8_PChannelInfo", [perf.ptr, 0, OUT, 0, 0])).toBe(E_POINTER);
        expect(port.refCount).toBe(1);
        denyWrite = false;
        expect(call("IDirectMusicPerformance8_CloseDown", [perf.ptr])).toBe(0);
        expect(port.refCount).toBe(0);
        expect(dm.obj.refCount).toBe(0);
        expect(call("IDirectMusicPerformance8_CloseDown", [perf.ptr])).toBe(0);
    });

    test("a returned state holds its segment after caller Release and performance CloseDown", () => {
        const perf = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        const port = internals.createPort(null, 22050, 2, 8) as PortObject;
        objects.push(port); internals.attachEngine(perf.obj, port); port.release();
        const seg = make<SegmentObject>(CLSID_DirectMusicSegment);
        seg.obj.segment = new PerfSegment(); seg.obj.segment.length = 3072;
        expect(call("IDirectMusicPerformance8_PlaySegment", [perf.ptr, seg.ptr, 0, 0, 0, OUT])).toBe(0);
        const statePtr = Mem.readUint32(OUT)!, state = rp.getComObjectByAddress(statePtr) as DMusicObject;
        objects.push(state); seg.obj.release();
        expect(seg.obj.refCount).toBe(1);
        expect(call("IDirectMusicPerformance8_CloseDown", [perf.ptr])).toBe(0);
        expect(state.refCount).toBe(1);
        expect(call("IDirectMusicSegmentState8_GetSegment", [statePtr, OUT])).toBe(0);
        expect(Mem.readUint32(OUT)).toBe(seg.ptr);
        seg.obj.release(); state.release();
        expect(seg.obj.refCount).toBe(0);
    });

    test("default audio path retains a performance reference and closes once", () => {
        const perf = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        expect(call("IDirectMusicPerformance8_GetDefaultAudioPath", [perf.ptr, OUT])).toBe(0);
        const path = rp.getComObjectByAddress(Mem.readUint32(OUT)!) as DMusicObject;
        objects.push(path); expect(path.refCount).toBe(2);
        path.release(); expect(path.refCount).toBe(1);
        module.reset(); expect(path.refCount).toBe(0);
        module.reset(); expect(path.refCount).toBe(0);
    });

    test("replacing or destroying a port releases its buffer and DirectSound references", () => {
        const refs = new Map([[0x6000, 1], [0x6100, 1], [0x6200, 1]]);
        const change = (a: number[], n: number) => {
            const p = a[0]!; const next = (refs.get(p) ?? 0) + n; refs.set(p, next); return next;
        };
        (system.process as any).getModule = () => ({exports: {
            IDirectSound8_AddRef: (_c: unknown, _m: unknown, a: number[]) => change(a, 1),
            IDirectSound8_Release: (_c: unknown, _m: unknown, a: number[]) => change(a, -1),
            IDirectSoundBuffer8_AddRef: (_c: unknown, _m: unknown, a: number[]) => change(a, 1),
            IDirectSoundBuffer8_Release: (_c: unknown, _m: unknown, a: number[]) => change(a, -1),
        }});
        const port = internals.createPort(null, 22050, 2, 8) as PortObject;
        objects.push(port);
        const ptr = internals.addressOf(port, port.primaryVtable);
        expect(call("IDirectMusicPort_SetDirectSound", [ptr, 0x6000, 0x6100])).toBe(0);
        expect(refs.get(0x6000)).toBe(2); expect(refs.get(0x6100)).toBe(2);
        expect(call("IDirectMusicPort_SetDirectSound", [ptr, 0x6000, 0x6100])).toBe(0);
        expect(refs.get(0x6000)).toBe(2); expect(refs.get(0x6100)).toBe(2);
        expect(call("IDirectMusicPort_SetDirectSound", [ptr, 0x6000, 0x6200])).toBe(0);
        expect(refs.get(0x6100)).toBe(1); expect(refs.get(0x6200)).toBe(2);
        port.release();
        expect(refs.get(0x6000)).toBe(1); expect(refs.get(0x6200)).toBe(1);
    });

    test("an invalid notification output neither consumes the queue nor leaks a state reference", () => {
        const perf = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        const port = internals.createPort(null, 22050, 2, 8) as PortObject;
        objects.push(port); internals.attachEngine(perf.obj, port); port.release();
        const seg = make<SegmentObject>(CLSID_DirectMusicSegment);
        seg.obj.segment = new PerfSegment(); seg.obj.segment.length = 3072;
        expect(call("IDirectMusicPerformance8_PlaySegment", [perf.ptr, seg.ptr, 0, 0, 0, 0])).toBe(0);
        const state = [...perf.obj.stateObjects.keys()][0]!;
        perf.obj.notifySegments = true;
        internals.notify(perf.obj, 1, state, 0);
        const obj = perf.obj.stateObjects.get(state)!;
        const count = obj.refCount;
        denyWrite = true;
        expect(call("IDirectMusicPerformance8_GetNotificationPMsg", [perf.ptr, OUT])).toBe(E_POINTER);
        expect(perf.obj.notifications).toHaveLength(1); expect(obj.refCount).toBe(count);
        denyWrite = false;
        expect(call("IDirectMusicPerformance8_GetNotificationPMsg", [perf.ptr, OUT])).toBe(0);
        const msg = Mem.readUint32(OUT)!;
        expect(perf.obj.notifications).toHaveLength(0);
        expect(call("IDirectMusicPerformance8_FreePMsg", [perf.ptr, msg])).toBe(0);
        expect(obj.refCount).toBe(count - 1);
        expect(heap.size).toBe(0);
    });

    test("port caps never overwrite a structure smaller than its declared header", () => {
        Mem.writeUint32(OUT, 4); mem.fill(0x5a, OUT + 4, OUT + 320);
        expect(internals.writePortCaps(OUT)).not.toBe(0);
        expect([...mem.subarray(OUT + 4, OUT + 320)].every(b => b === 0x5a)).toBe(true);
    });

    test("malformed tempo cannot stall an infinitely repeating segment", () => {
        for (const tempo of [Infinity, NaN, -1, Number.MAX_VALUE]) {
            const engine = new Performance(new DlsSynth(22050, 1));
            const seg = new PerfSegment(); seg.length = 1; seg.repeats = 0xffffffff;
            seg.tempos = [{time: 0, tempo}];
            engine.playSegment(seg, 0);
            const left = new Float32Array(32), right = new Float32Array(32);
            engine.render(left, right, 32); engine.render(left, right, 32);
            expect(engine.currentTempo).toBe(120);
            expect(Number.isFinite(engine.musicTime)).toBe(true);
        }
    });
    test("an audio path makes its tool graph on first request and hands back the same one", () => {
        const {ptr: perf} = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        const PP = 0x640, GUID_NULL = 0x660, IID = 0x680;
        expect(call("IDirectMusicPerformance8_CreateStandardAudioPath", [perf, 8, 2, 1, PP])).toBe(0);
        const path = Mem.readUint32(PP)!;
        Mem.writeBytes(IID, new Uint8Array([0x77, 0xc2, 0xef, 0x2b, 0x97, 0x54, 0xd2, 0x11, 0xbc, 0xcb, 0x00, 0xa0, 0xc9, 0x22, 0xe6, 0xeb])); // IID_IDirectMusicGraph
        const get = () => call("IDirectMusicAudioPath_GetObjectInPath", [path, 0, 0x2200, 0, GUID_NULL, 0, IID, 0x6a0]);
        expect(get()).toBe(0);
        const graph = Mem.readUint32(0x6a0)!;
        expect(graph).not.toBe(0);
        expect(get()).toBe(0);
        expect(Mem.readUint32(0x6a0)).toBe(graph);
        expect(call("IDirectMusicGraph_StampPMsg", [graph, 0x700])).toBe(0);
        expect(call("IDirectMusicGraph_GetTool", [graph, 0, 0x6a4]) >>> 0).toBe(0x88781161); // DMUS_E_NOT_FOUND
    });

    test("immediate wave tools get the playback time and decoded duration", () => {
        const perf = make<PerformanceObject>(CLSID_DirectMusicPerformance).obj;
        perf.engine = new Performance(new DlsSynth(22_050, 8));
        const graph = new GraphObject();
        objects.push(graph);
        graph.tools.push(0x3000);
        const segment = new PerfSegment();
        segment.wave = { rate: 22_050, frames: 44_100, left: new Float32Array(44_100), right: new Float32Array(44_100) };
        const state = perf.engine.playSegment(segment, 0x80);
        const routine = internals.deliverWaveToTools(perf, graph, state);
        let step = routine.next();
        expect(step.value.tag).toEndWith("GetMsgDeliveryType");
        Mem.writeUint32(step.value.args[1], 4);
        step = routine.next(0);
        expect(step.value.tag).toEndWith("GetMediaTypeArraySize");
        Mem.writeUint32(step.value.args[1], 1);
        step = routine.next(0);
        expect(step.value.tag).toEndWith("GetMediaTypes");
        Mem.writeUint32(Mem.readUint32(step.value.args[1])!, 12);
        step = routine.next(0);
        expect(step.value.tag).toEndWith("ProcessPMsg(wave)");
        const message = new DataView(mem.buffer, step.value.args[2], 88);
        expect(message.getUint32(0, true)).toBe(88);
        expect(message.getUint32(20, true)).toBe(7);
        expect(message.getUint32(32, true)).toBe(0x3000);
        expect(message.getUint32(36, true)).toBeGreaterThan(0);
        expect(message.getUint32(40, true)).toBe(12);
        expect(message.getBigInt64(64, true)).toBe(20_000_000n);
        expect(routine.next(0)).toEqual({ done: true, value: 0 });
        expect(heap.size).toBe(0);
    });

});
