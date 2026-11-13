import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { BaseComObject } from "../../src/worker/core/com/base-com-object";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { Performance, PerfSegment, PerfSegmentState } from "../../src/worker/core/audio/directmusic/performance";
import { DlsSynth } from "../../src/worker/core/audio/directmusic/synth";
import { DMusic } from "../../src/worker/modules/dmusic";
import {
    AudioPathObject, CLSID_DirectMusicCollection, CLSID_DirectMusicComposer, CLSID_DirectMusicLoader, CLSID_DirectMusicPerformance,
    CLSID_DirectMusicSegment, CLSID_DirectMusicStyle, type CollectionObject, type ComposerObject, type DirectMusicObject, DMusicObject,
    IID_IUnknown, type LoadableObject, type LoaderObject, PerformanceObject, PortObject, SegmentObject, SegmentStateObject, type StyleObject,
} from "../../src/worker/modules/dmusic-objects";
import {
    AUDIO_PATH_FIELDS, DIRECTMUSIC_FIELDS, DMUSIC_MODULE_FIELDS, DMUSIC_SCHEMA, ENGINE_FIELDS, ENGINE_STATE_FIELDS, PERFORMANCE_FIELDS,
    PORT_FIELDS, SEGMENT_STATE_FIELDS, SINK_FIELDS, SYNTH_CHANNEL_FIELDS, SYNTH_FIELDS, SYNTH_VOICE_FIELDS, type SavedAudioPath,
    type SavedModule, type SavedPerformance, type SavedPort, type SavedSegmentState,
} from "../../src/worker/modules/dmusic-savestate";
import { DirectSoundSink } from "../../src/worker/modules/dmusic-sink";
import { guidBytes } from "../../src/worker/modules/dpnet/constants";
import { DMUS_IO_INST_PATCH } from "../../packages/formats/src/dmusic/band";
import { DMUS_OBJ_MEMORY } from "../../packages/formats/src/dmusic/reference";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import { preserveGlobals } from "./helpers/scoped-globals";
import { preserveComReleaseTracking, preserveMemBinding } from "./helpers/scoped-process-state";
import { newCaptureRun } from "../../src/worker/savestate/session";
import { restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { ascii, bandChunks, bytes as cat, chunk, f64, guid, i16, i32, list, reference, riff, u16, u32, u8, wide } from "./dmusic-fixtures";

const PART_ID = "0e54d502-1111-2222-3344-556677889900";
const GUID_NOTIFICATION_SEGMENT = "d2ac2899-b39b-11d1-8704-00600893b1bd";
const DMUS_SEGF_SECONDARY = 1 << 7, DMUS_SEGF_QUEUE = 1 << 8, DMUS_SEGF_MEASURE = 1 << 13;
const DMUS_APATH_DYNAMIC_STEREO = 8;
const DESC = { validData: 4, fileName: 0x138, memLength: 0x340, memData: 0x348 };
const OUT = 0x200, RIID = 0x300, GUID_AT = 0x320, NAME_AT = 0x340, DESC_AT = 0x1000, STREAM = 0x3000, GET_LOADER = 0x3010, GUEST_LOADER = 0x3020;
const WAVE_AT = 0x4000, HEAP = 0x10000, COM = 0x8000, SOUND = 0x80000, MEMORY = 0x100000;
const E_FAIL = 0x80004005 | 0;
const RATE = 22050;

function dls(): Uint8Array {
    const wave = list("wave",
        chunk("fmt ", u16(1, 1), u32(RATE, RATE * 2), u16(2, 16)),
        chunk("wsmp", u32(20), u16(60), i16(0), i32(0), u32(0, 1), u32(16, 0, 0, 300)),
        chunk("data", i16(...Array.from({ length: 300 }, (_, i) => Math.round(Math.sin(i / 300 * Math.PI * 12) * 9000)))));
    return riff("DLS ",
        chunk("colh", u32(1)), chunk("dlid", guid(PART_ID)),
        list("lins", list("ins ",
            chunk("insh", u32(1, 0, 5)),
            list("lrgn", list("rgn ", chunk("rgnh", u16(0, 127, 0, 127, 0, 0)), chunk("wlnk", u16(0, 0), u32(1, 0)))),
            list("lart", chunk("art1", u32(8, 1), u16(0, 0, 0x209, 0), i32(-0x20000000))),
            list("INFO", chunk("INAM", ascii("Tone\0"))))),
        chunk("ptbl", u32(8, 1), u32(0)),
        list("wvpl", wave));
}

function style(): Uint8Array {
    const choices = new Uint32Array(32).fill(0x20000000);
    choices[0] = choices[1] = choices[2] = 0x3fffffff;
    const note = (grid: number, variations: number, value: number): Uint8Array =>
        cat(i32(grid), u32(variations), i32(1400), i16(0), u16(value), u8(90, 0, 60, 30, 0, 14), u8(0, 0));
    return riff("DMST",
        chunk("styh", u8(4, 4), u16(4), u32(0), f64(120)),
        chunk("guid", guid(PART_ID)),
        list("DMBD", ...bandChunks("Default", [{ patch: 5, pChannel: 7, flags: DMUS_IO_INST_PATCH, collection: "kit.dls" }])),
        list("part",
            chunk("prth", u8(4, 4), u16(4), new Uint8Array(choices.buffer), guid(PART_ID), u16(1), u8(14, 0, 0), u8(0, 0, 0)),
            chunk("note", cat(u32(24), note(0, 1, 0x3000), note(4, 2, 0x3010), note(8, 4, 0x3100), note(12, 7, 0x3200), note(2, 6, 0x3110)))),
        list("pttn",
            chunk("ptnh", u8(4, 4), u16(4), u8(1, 100), u16(0), u16(1)),
            list("UNFO", chunk("UNAM", wide("Verse"))),
            list("pref", chunk("prfc", guid(PART_ID), u16(7), u8(0, 0, 100, 1), u16(0), u32(7)))),
        list("pttn",
            chunk("ptnh", u8(4, 4), u16(4), u8(1, 100), u16(0), u16(1)),
            list("UNFO", chunk("UNAM", wide("Chorus"))),
            list("pref", chunk("prfc", guid(PART_ID), u16(7), u8(0, 0, 100, 0), u16(0), u32(7)))),
        list("pttn",
            chunk("ptnh", u8(4, 4), u16(4), u8(1, 100), u16(0), u16(1)),
            chunk("mtfs", u32(40), i32(0, 0, 0), u32(0)),
            list("UNFO", chunk("UNAM", wide("Sting"))),
            list("pref", chunk("prfc", guid(PART_ID), u16(7), u8(0, 0, 100, 1), u16(0), u32(7)))));
}

function track(classId: string, group: number, ...body: Uint8Array[]): Uint8Array {
    return riff("DMTK", chunk("trkh", guid(classId), u32(0, group), ascii("xxxx"), u32(0)), ...body);
}

const segment = (name: string, groove: number): Uint8Array => riff("DMSG",
    chunk("segh", u32(99), i32(6144, 0, 0, 0), u32(0)),
    chunk("guid", guid(PART_ID)),
    list("UNFO", chunk("UNAM", wide(name))),
    list("trkl",
        track("d2ac2885-b39b-11d1-8704-00600893b1bd", 0xffffffff, chunk("tetr", u32(16), i32(0), u32(0), f64(150))),
        track("d2ac288c-b39b-11d1-8704-00600893b1bd", 1, chunk("cmnd", u32(12), i32(0), u16(0), u8(0, 0, groove, 8), u16(0))),
        track("d2ac288d-b39b-11d1-8704-00600893b1bd", 1,
            list("sttr", list("strf", chunk("stmp", i32(0)), reference(CLSID_DirectMusicStyle, "Race.sty", PART_ID)))),
        track("d2ac2894-b39b-11d1-8704-00600893b1bd", 1,
            riff("DMBT", list("lbdl", list("lbnd", chunk("bdih", i32(0)),
                riff("DMBD", ...bandChunks("Main", [{ patch: 5, pChannel: 7, flags: DMUS_IO_INST_PATCH, collection: "kit.dls" }]))))))));

const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const le32 = (v: number): number[] => [...le16(v & 0xffff), ...le16(v >>> 16)];
function wav(frames: number): Uint8Array {
    const data = Array.from({ length: frames }, (_, i) => le16(Math.round(Math.sin(i / 9) * 6000) & 0xffff)).flat();
    const body = [...ascii("WAVE"), ...ascii("fmt "), ...le32(16), ...le16(1), ...le16(1), ...le32(11025), ...le32(22050), ...le16(2), ...le16(16),
        ...ascii("data"), ...le32(data.length), ...data];
    return Uint8Array.from([...ascii("RIFF"), ...le32(body.length), ...body]);
}

interface SoundBuffer { size: number; data: number; playing: boolean; play: number; bytesPerSecond: number; refs: number }

class FakeDirectSound {
    buffers = new Map<number, SoundBuffer>();
    next = SOUND;
    written = new Map<number, number[]>();

    snapshot(): { buffers: Map<number, SoundBuffer>; next: number } {
        return structuredClone({ buffers: this.buffers, next: this.next });
    }

    rewind(snap: { buffers: Map<number, SoundBuffer>; next: number }): void {
        const copy = structuredClone(snap);
        this.buffers = copy.buffers;
        this.next = copy.next;
        this.written = new Map();
    }

    advance(ms: number): void {
        for (const b of this.buffers.values()) {
            if (b.playing) b.play = (b.play + Math.floor(b.bytesPerSecond * ms / 1000 / 4) * 4) % b.size;
        }
    }

    readonly exports: Record<string, (ctx: unknown, m: Uint8Array, a: number[]) => number> = (() => {
        const view = (): DataView => new DataView(mem.buffer);
        const buf = (a: number[]): SoundBuffer => this.buffers.get(a[0]!)!;
        return {
            directsoundcreate: (_c, _m, a) => { view().setUint32(a[1]!, 0x7000, true); return 0; },
            idirectsound8_createsoundbuffer: (_c, _m, a) => {
                const size = view().getUint32(a[1]! + 8, true), format = view().getUint32(a[1]! + 16, true);
                const ptr = this.next;
                this.next += 16;
                const data = this.next;
                this.next += (size + 15) & ~15;
                this.buffers.set(ptr, { size, data, playing: false, play: 0, bytesPerSecond: view().getUint32(format + 8, true), refs: 1 });
                view().setUint32(a[2]!, ptr, true);
                return 0;
            },
            idirectsoundbuffer8_getcaps: (_c, _m, a) => { view().setUint32(a[1]! + 8, buf(a).size, true); return 0; },
            idirectsoundbuffer8_play: (_c, _m, a) => { buf(a).playing = true; return 0; },
            idirectsoundbuffer8_stop: (_c, _m, a) => { buf(a).playing = false; return 0; },
            idirectsoundbuffer8_setvolume: () => 0,
            idirectsoundbuffer8_getcurrentposition: (_c, _m, a) => {
                const b = buf(a);
                view().setUint32(a[1]!, b.play, true);
                view().setUint32(a[2]!, (b.play + 1764) % b.size, true);
                return 0;
            },
            idirectsoundbuffer8_lock: (_c, _m, a) => {
                const b = buf(a), offset = a[1]!, length = a[2]!, first = Math.min(length, b.size - offset);
                view().setUint32(a[3]!, b.data + offset, true);
                view().setUint32(a[4]!, first, true);
                view().setUint32(a[5]!, first < length ? b.data : 0, true);
                view().setUint32(a[6]!, length - first, true);
                return 0;
            },
            idirectsoundbuffer8_unlock: (_c, _m, a) => {
                let log = this.written.get(a[0]!);
                if (!log) this.written.set(a[0]!, log = []);
                for (const [ptr, length] of [[a[1]!, a[2]!], [a[3]!, a[4]!]] as const) {
                    for (let i = 0; i + 1 < length; i += 2) log.push(view().getInt16(ptr + i, true));
                }
                return 0;
            },
            IDirectSoundBuffer8_AddRef: (_c, _m, a) => ++buf(a).refs,
            IDirectSoundBuffer8_Release: (_c, _m, a) => this.buffers.has(a[0]!) ? --buf(a).refs : 0,
            IDirectSound8_AddRef: () => 2,
            IDirectSound8_Release: () => 1,
        };
    })();
}

const system = System.getInstance(), savedProcess = system.process, savedFs = (system as unknown as { fileSystem: unknown }).fileSystem;
const rp = SystemResourceProvider.getInstance();
const byAddress = rp.getComObjectByAddress.bind(rp);
const realNow = performance.now.bind(performance);
const flags = globalThis as { __savestates?: unknown };
preserveGlobals("__savestates");
preserveMemBinding();
preserveComReleaseTracking();
type Internals = Record<string, any>;
let mem: Uint8Array, module: DMusic, internals: Internals, sound: FakeDirectSound, restoredAt: Map<number, BaseComObject> | null;
let dispose: Array<() => void>, modules: DMusic[], comBefore: Set<number>, nextHeap: number, nextCom: number, savedFlag: unknown, guestProcess: unknown;

function newModule(): DMusic {
    const m = new DMusic(), i = m as unknown as Internals;
    i.process = guestProcess;
    m.vtables = new Proxy({}, { get: () => ({ address: 0x1000 }) }) as never;
    for (const method of [
        "registerLoaderExports", "registerObjectExports", "registerSegmentExports", "registerStyleExports", "registerBandExports",
        "registerPerformanceExports", "registerSegmentStateExports", "registerComposerExports", "registerAudioPathExports", "registerPortExports",
    ]) i[method]();
    i.readSystemFile = () => null;
    dispose.push(m.registerSavestate());
    modules.push(m);
    return m;
}

beforeEach(() => {
    savedFlag = flags.__savestates;
    flags.__savestates = true;
    performance.now = () => 5000;
    comBefore = new Set(rp.getAllComObjects().map(o => o.handle));
    mem = new Uint8Array(MEMORY);
    Mem.bind(() => mem);
    nextHeap = HEAP; nextCom = COM;
    dispose = []; modules = []; restoredAt = null;
    sound = new FakeDirectSound();
    guestProcess = {
        resetGeneration: 0,
        getCurrentMemory: () => mem,
        memory: {
            alloc: (n: number) => { const p = nextHeap; nextHeap += (n + 15) & ~15; return p; }, free: () => undefined,
            allocSystemBlock: (n: number) => { const p = nextCom; nextCom += (n + 15) & ~15; return p; },
            freeSystemBlock: () => undefined,
        },
        addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length },
        getModule: (name: string) => (name === "dsound" ? { exports: sound.exports } : undefined),
    };
    system.process = guestProcess as never;
    (system as unknown as { fileSystem: unknown }).fileSystem = { currentDir: "C:\\MUSIC\\" };
    rp.getComObjectByAddress = (address: number) => restoredAt?.get(address) ?? byAddress(address);
    module = newModule();
    internals = module as unknown as Internals;
    mem.set(guidBytes(IID_IUnknown), RIID);
});

afterEach(() => {
    for (const m of modules) (m as unknown as Internals).stopPump();
    for (const off of dispose) off();
    rp.getComObjectByAddress = byAddress;
    for (const o of rp.getAllComObjects()) if (!comBefore.has(o.handle)) o.forceRelease();
    system.process = savedProcess;
    (system as unknown as { fileSystem: unknown }).fileSystem = savedFs;
    flags.__savestates = savedFlag;
    performance.now = realNow;
});

const view = (): DataView => new DataView(mem.buffer);
const ptrOf = (obj: DMusicObject): number => obj.addresses.get(obj.primaryVtable)!;
const at = <T extends DMusicObject>(address: number): T => rp.getComObjectByAddress(address) as unknown as T;
const call = (name: string, args: number[], m: DMusic = module): number => m.exports[name]!({} as never, mem, args) as number;

function make<T extends DMusicObject>(clsid: string): T {
    expect(module.coCreateInstance(clsid, IID_IUnknown, OUT)).toBe(0);
    return at<T>(view().getUint32(OUT, true));
}

function writeWide(address: number, text: string): void {
    for (let i = 0; i <= text.length; i++) view().setUint16(address + i * 2, i < text.length ? text.charCodeAt(i) : 0, true);
}

function readWide(address: number): string {
    let out = "";
    for (let i = 0; ; i++) {
        const code = view().getUint16(address + i * 2, true);
        if (!code) return out;
        out += String.fromCharCode(code);
    }
}

function load(obj: LoadableObject, content: Uint8Array, named: Record<string, DMusicObject> = {}): number {
    const it = internals.load(obj, STREAM);
    let offset = 0, step = it.next();
    while (!step.done) {
        const { args, tag } = step.value as { args: number[]; tag: string };
        let hr = 0;
        if (tag === "IStream::Read") {
            Mem.writeBytes(args[1]!, content.subarray(offset, offset + args[2]!));
            Mem.writeUint32(args[3]!, Math.min(args[2]!, content.length - offset));
            offset += args[2]!;
        } else if (tag.startsWith("IStream::QueryInterface")) Mem.writeUint32(args[2]!, GET_LOADER);
        else if (tag === "IDirectMusicGetLoader::GetLoader") Mem.writeUint32(args[1]!, GUEST_LOADER);
        else if (tag.startsWith("IDirectMusicLoader::GetObject")) {
            const target = named[readWide(args[1]! + DESC.fileName)];
            if (target) {
                target.addRef();
                Mem.writeUint32(args[3]!, internals.addressOf(target, target.primaryVtable));
            } else hr = E_FAIL;
        }
        step = it.next(hr);
    }
    return step.value as number;
}

function loaded<T extends LoadableObject>(clsid: string, content: Uint8Array, named: Record<string, DMusicObject> = {}): T {
    const obj = make<T>(clsid);
    expect(load(obj, content, named)).toBe(0);
    return obj;
}

function content() {
    const kit = loaded<CollectionObject>(CLSID_DirectMusicCollection, dls());
    const race = loaded<StyleObject>(CLSID_DirectMusicStyle, style(), { "kit.dls": kit });
    const song = loaded<SegmentObject>(CLSID_DirectMusicSegment, segment("Song", 50), { "Race.sty": race, "kit.dls": kit });
    const other = loaded<SegmentObject>(CLSID_DirectMusicSegment, segment("Other", 20), { "Race.sty": race, "kit.dls": kit });
    const loader = make<LoaderObject>(CLSID_DirectMusicLoader);
    mem.fill(0, DESC_AT, DESC_AT + 0x350);
    const bytes = wav(30000);
    mem.set(bytes, WAVE_AT);
    view().setUint32(DESC_AT + DESC.validData, DMUS_OBJ_MEMORY, true);
    view().setUint32(DESC_AT + DESC.memLength, bytes.length, true);
    view().setUint32(DESC_AT + DESC.memData, WAVE_AT, true);
    expect(call("IDirectMusicLoader8_GetObject", [ptrOf(loader), DESC_AT, RIID, OUT])).toBe(0);
    const effect = at<SegmentObject>(view().getUint32(OUT, true));
    writeWide(NAME_AT, "Sting");
    expect(call("IDirectMusicStyle8_GetMotif", [ptrOf(race), NAME_AT, OUT])).toBe(0);
    const sting = at<SegmentObject>(view().getUint32(OUT, true));
    return { kit, race, song, other, effect, sting };
}

function audio(): { perf: PerformanceObject; port: PortObject } {
    const perf = make<PerformanceObject>(CLSID_DirectMusicPerformance);
    expect(call("IDirectMusicPerformance8_InitAudio", [ptrOf(perf), 0, 0, 0, 0, 64, 0, 0])).toBe(0);
    return { perf, port: perf.port! };
}

function play(perf: PerformanceObject, seg: SegmentObject, segFlags: number, path: AudioPathObject | null = null): SegmentStateObject {
    view().setUint32(OUT, 0, true);
    expect(call("IDirectMusicPerformance8_PlaySegmentEx", [ptrOf(perf), ptrOf(seg), 0, 0, segFlags, 0, 0, OUT, 0, path ? ptrOf(path) : 0])).toBe(0);
    return at<SegmentStateObject>(view().getUint32(OUT, true));
}

function ticks(count: number, m: DMusic = module): void {
    for (let i = 0; i < count; i++) {
        (m as unknown as Internals).pump();
        sound.advance(10);
    }
}

const encoded = (v: unknown): string => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

interface Snapshot { objects: Array<[string, SaveValue]>; section: SavedModule; blobs: Map<string, Uint8Array>; refs: number[] }

const participant = () => savestateParticipants.all().find(p => p.id === "dmusic")!;
const ours = (): DMusicObject[] => rp.getAllComObjects().filter((o): o is DMusicObject => !comBefore.has(o.handle) && o instanceof DMusicObject);

function capture(roots: unknown[] = ours()): Snapshot {
    const run = newCaptureRun();
    const refs = roots.map((o, i) => run.ref(o, `com ${i}`));
    const section = participant().capture(run) as unknown as SavedModule;
    const round = decodeValue(encodeValue({ objects: run.objects, section } as unknown as SaveValue)) as unknown as Snapshot;
    return { ...round, blobs: new Map(run.blobs), refs };
}

function restore(snap: Snapshot): { module: DMusic; roots: DMusicObject[] } {
    const fresh = newModule();
    const ctx = restoreObjectGraph(snap.objects, snap.blobs);
    const roots = snap.refs.map(r => ctx.object(r) as DMusicObject);
    void participant().restore(snap.section as unknown as SaveValue, ctx);
    restoredAt = new Map();
    for (const o of roots) for (const address of o.addresses.values()) restoredAt.set(address, o);
    return { module: fresh, roots };
}

function again(back: { module: DMusic; roots: DMusicObject[] }): string {
    const run = newCaptureRun();
    back.roots.forEach((o, i) => run.ref(o, `com ${i}`));
    return encoded({ objects: run.objects, section: participant().capture(run) });
}

const first = (snap: Snapshot): string => encoded({ objects: snap.objects, section: snap.section });
const of = <T>(snap: Snapshot, tag: string, nth = 0): T => snap.objects.filter(([t]) => t === tag)[nth]![1] as unknown as T;
const restoredOf = <T extends DMusicObject>(back: { roots: DMusicObject[] }, type: new () => T, nth = 0): T =>
    back.roots.filter((o): o is T => o instanceof type)[nth]!;

describe("dmusic without music", () => {
    test("nothing created saves and restores an empty module", () => {
        const snap = capture();
        expect(snap.section).toEqual({ performances: [], ports: [], pathOutputs: [], messages: [], pumpTimer: -1 });
        const back = restore(snap);
        expect(again(back)).toBe(first(snap));
        expect(back.module.savestateRefusal()).toBeNull();
    });

    test("a performance without a port keeps its DirectMusic, notification setup and master values", () => {
        const perf = make<PerformanceObject>(CLSID_DirectMusicPerformance);
        expect(call("IDirectMusicPerformance8_Init", [ptrOf(perf), 0, 0x5550, 0])).toBe(0);
        perf.notificationHandle = 0x44;
        perf.masterVolume = -600;
        perf.masterTempo = 1.5;
        mem.set(guidBytes(GUID_NOTIFICATION_SEGMENT), GUID_AT);
        call("IDirectMusicPerformance8_AddNotificationType", [ptrOf(perf), GUID_AT]);
        call("IDirectMusicPerformance8_GetDefaultAudioPath", [ptrOf(perf), OUT]);
        make<ComposerObject>(CLSID_DirectMusicComposer);
        const snap = capture();
        expect(of<SavedPerformance>(snap, "dmusic-performance").engine).toBeNull();
        const back = restore(snap);
        expect(again(back)).toBe(first(snap));
        const perf2 = restoredOf(back, PerformanceObject);
        expect(BaseComObject.captureComBase(perf2)).toEqual(BaseComObject.captureComBase(perf));
        expect(perf2).toMatchObject({ engine: null, port: null, notificationHandle: 0x44, notifySegments: true, masterVolume: -600, masterTempo: 1.5 });
        expect(perf2.directMusic!.directSound).toBe(0x5550);
        expect(perf2.defaultAudioPath).toBeInstanceOf(AudioPathObject);
        expect([...(back.module as unknown as Internals).performances]).toEqual([perf2]);
        const closed: string[] = [];
        (back.module as unknown as Internals).closePerformance = () => { closed.push("closed"); };
        perf2.onDestroy?.();
        expect(closed).toEqual(["closed"]);
        expect((back.module as unknown as Internals).performances.size).toBe(0);
    });

    test("an active port with nothing playing keeps its buffer, sink and pump, and stays silent", () => {
        const { perf, port } = audio();
        ticks(30);
        const snap = capture();
        const saved = of<SavedPort>(snap, "dmusic-port");
        expect(saved).toMatchObject({ active: true, ownsBuffer: true, buffer: port.buffer, sampleRate: 22050, audioChannels: 2, voices: 64 });
        expect(saved.sink).toMatchObject({ playing: true, bufferBytes: 176400 });
        expect(snap.section.pumpTimer).toBe(internals.pumpTimer);
        expect(snap.section.pumpTimer).toBeGreaterThan(0);
        const created = sound.buffers.size;
        const back = restore(snap);
        expect(again(back)).toBe(first(snap));
        expect(sound.buffers.size).toBe(created);
        const port2 = restoredOf(back, PortObject), perf2 = restoredOf(back, PerformanceObject);
        expect(BaseComObject.captureComBase(port2)).toEqual(BaseComObject.captureComBase(port));
        expect(port2.performance).toBe(perf2);
        expect(perf2.port).toBe(port2);
        expect(perf2.engine!.synth).toBe(port2.synth);
        expect(perf2.engine!.musicTime).toBe(perf.engine!.musicTime);
        expect(port2.owner).toBe(perf2.directMusic);
        expect([...perf2.directMusic!.ports]).toEqual([port2]);
        expect([...(back.module as unknown as Internals).ports]).toEqual([port2]);
        expect((back.module as unknown as Internals).pumpTimer).toBe(internals.pumpTimer);
        sound.written.clear();
        const before = perf2.engine!.musicTime;
        ticks(50, back.module);
        expect(perf2.engine!.musicTime).toBeGreaterThan(before + 700);
        const pcm = sound.written.get(port2.buffer)!;
        expect(pcm.length).toBeGreaterThan(20000);
        expect(pcm.every(x => x === 0)).toBe(true);
    });
});

function scene() {
    const c = content();
    const { perf, port } = audio();
    mem.set(guidBytes(GUID_NOTIFICATION_SEGMENT), GUID_AT);
    call("IDirectMusicPerformance8_AddNotificationType", [ptrOf(perf), GUID_AT]);
    expect(call("IDirectMusicPerformance8_CreateStandardAudioPath", [ptrOf(perf), DMUS_APATH_DYNAMIC_STEREO, 16, 1, OUT])).toBe(0);
    const path = at<AudioPathObject>(view().getUint32(OUT, true));
    perf.engine!.randomState = 99;
    const primary = play(perf, c.song, 0);
    ticks(60);
    const effect = play(perf, c.effect, DMUS_SEGF_SECONDARY, path);
    c.effect.segment!.repeats = 2;
    effect.state!.repeatsLeft = 2;
    const sting = play(perf, c.sting, DMUS_SEGF_SECONDARY | DMUS_SEGF_MEASURE);
    const queued = play(perf, c.other, DMUS_SEGF_QUEUE);
    ticks(150);
    expect(call("IDirectMusicPerformance8_GetNotificationPMsg", [ptrOf(perf), OUT])).toBe(0);
    const message = view().getUint32(OUT, true);
    return { ...c, perf, port, path, primary, effect, sting, queued, message };
}

describe("dmusic with music playing", () => {
    test("a primary segment mid-pattern, a motif, a queued segment and a wave on its own audio path are all restored", () => {
        const s = scene();
        expect(s.port.synth.activeVoiceCount).toBeGreaterThan(0);
        expect(s.perf.notifications.length).toBeGreaterThan(0);
        expect(s.primary.state!.pattern).not.toBeNull();
        expect(s.effect.state!.wavePosition).toBeGreaterThan(0);
        const snap = capture();
        expect(snap.section.messages).toHaveLength(1);
        expect(snap.section.messages[0]![0]).toBe(s.message);
        expect(snap.section.pathOutputs).toHaveLength(1);
        const before = { heap: nextHeap, com: nextCom, buffers: sound.buffers.size, next: sound.next, guest: mem.slice() };
        const back = restore(snap);
        expect({ heap: nextHeap, com: nextCom, buffers: sound.buffers.size, next: sound.next }).toEqual({ heap: before.heap, com: before.com, buffers: before.buffers, next: before.next });
        expect(mem).toEqual(before.guest);
        expect(again(back)).toBe(first(snap));
        const perf2 = restoredOf(back, PerformanceObject), port2 = restoredOf(back, PortObject);
        const find = (live: DMusicObject): DMusicObject => restoredAt!.get(ptrOf(live)) as DMusicObject;
        const [primary2, effect2, sting2, queued2] = [s.primary, s.effect, s.sting, s.queued].map(o => find(o) as SegmentStateObject);
        const [song2, other2, wave2, motif2] = [s.song, s.other, s.effect.segment!, s.sting.segment!].map(o => find(o) as SegmentObject);
        const path2 = find(s.path) as AudioPathObject;
        expect(perf2.engine!.activeStates()).toEqual([primary2!.state!, effect2!.state!, sting2!.state!]);
        expect(primary2!.state!.queued).toBe(queued2!.state);
        expect(primary2!.state!.segment).toBe(song2!.segment!);
        expect(queued2!.state!.segment).toBe(other2!.segment!);
        expect(effect2!.state!.segment).toBe(wave2!.segment!);
        expect(sting2!.state!.segment).toBe(motif2!.segment!);
        expect(primary2!.state!.pattern).toBe(song2!.segment!.styles[0]!.style.patterns[song2!.segment!.styles[0]!.style.patterns.indexOf(primary2!.state!.pattern!)]!);
        expect(primary2!.state!.pattern!.name).toBe(s.primary.state!.pattern!.name);
        expect(primary2!.state!.parts.map(p => p.variation)).toEqual(s.primary.state!.parts.map(p => p.variation));
        expect(sting2!.state!.pattern).toBe(motif2!.segment!.fixedPattern!.pattern);
        expect(effect2!.state!.output).toBe(path2);
        expect(effect2!.state!.wavePosition).toBe(s.effect.state!.wavePosition);
        for (const [b, l] of [[primary2, s.primary], [effect2, s.effect], [sting2, s.sting], [queued2, s.queued]] as const) {
            expect(BaseComObject.captureComBase(b!)).toEqual(BaseComObject.captureComBase(l));
            expect(b!.performance).toBe(perf2);
            expect(perf2.stateObjects.get(b!.state!)).toBe(b!);
            expect(b!.segment).toBe(find(l.segment!) as SegmentObject);
        }
        expect(path2.performance).toBe(perf2);
        expect(path2.sink).toBeInstanceOf(DirectSoundSink);
        expect(path2).toMatchObject({ buffer: s.path.buffer, channels: 2, pathType: DMUS_APATH_DYNAMIC_STEREO });
        expect([...(back.module as unknown as Internals).pathOutputs]).toEqual([path2]);
        expect(perf2.notifications.map(n => [n.type, n.musicTime, n.queuedAtMs])).toEqual(s.perf.notifications.map(n => [n.type, n.musicTime, n.queuedAtMs]));
        expect(perf2.notifications.map(n => n.state)).toEqual(s.perf.notifications.map(n => find(n.state) as SegmentStateObject));
        const messages = (back.module as unknown as Internals).messages as Map<number, SegmentStateObject | null>;
        expect([...messages.keys()]).toEqual([s.message]);
        expect(messages.get(s.message)).toBe(find(internals.messages.get(s.message)) as SegmentStateObject);
        expect(port2.synth.activeVoiceCount).toBe(s.port.synth.activeVoiceCount);
        expect(call("IDirectMusicPerformance8_IsPlaying", [ptrOf(perf2), ptrOf(song2!), 0], back.module)).toBe(0);
        expect(call("IDirectMusicPerformance8_IsPlaying", [ptrOf(perf2), ptrOf(other2!), 0], back.module)).toBe(1);
        expect(call("IDirectMusicPerformance8_FreePMsg", [ptrOf(perf2), s.message], back.module)).toBe(0);
        expect(messages.size).toBe(0);
    });

    test("after a restore the music goes on where it was: the same PCM on the port and on the audio path, the same notifications", () => {
        const s = scene();
        const snap = capture();
        const world = { mem: mem.slice(), sound: sound.snapshot(), heap: nextHeap, com: nextCom };
        sound.written.clear();
        const timeAtSave = s.perf.engine!.musicTime, notesAtSave = s.port.synth.stats.notes;
        ticks(900);
        const heard = new Map(sound.written), described = JSON.stringify(module.describe());
        const queue = s.perf.notifications.map(n => [n.type, n.musicTime]);
        expect(s.perf.engine!.musicTime).toBeGreaterThan(timeAtSave + 10000);
        expect(s.port.synth.stats.notes).toBeGreaterThan(notesAtSave + 10);
        expect(heard.get(s.port.buffer)!.some(x => x !== 0)).toBe(true);
        expect(heard.get(s.path.buffer)!.some(x => x !== 0)).toBe(true);
        expect(s.perf.engine!.primaryState()!.segment).toBe(s.song.segment!);

        mem.set(world.mem);
        sound.rewind(world.sound);
        nextHeap = world.heap; nextCom = world.com;
        const back = restore(snap);
        const perf2 = restoredOf(back, PerformanceObject), port2 = restoredOf(back, PortObject);
        expect(perf2.engine!.musicTime).toBe(timeAtSave);
        ticks(900, back.module);
        expect(perf2.engine!.musicTime).toBe(s.perf.engine!.musicTime);
        expect(port2.synth.stats).toEqual(s.port.synth.stats);
        expect(perf2.notifications.map(n => [n.type, n.musicTime])).toEqual(queue);
        expect(JSON.stringify(back.module.describe())).toBe(described);
        for (const buffer of [s.port.buffer, s.path.buffer]) {
            const a = heard.get(buffer)!, b = sound.written.get(buffer)!;
            expect(b.length).toBe(a.length);
            let differing = 0;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
            expect(differing).toBe(0);
        }
    });

    test("a transition and the segment queued behind it are restored and play out the same", () => {
        const c = content();
        const { perf, port } = audio();
        const composer = make<ComposerObject>(CLSID_DirectMusicComposer);
        perf.engine!.randomState = 5;
        play(perf, c.song, 0);
        ticks(70);
        expect(call("IDirectMusicComposer8_AutoTransition", [ptrOf(composer), ptrOf(perf), ptrOf(c.other), 2, 0x20, 0, 0, 0, 0])).toBe(0);
        const states = [...perf.stateObjects.values()];
        expect(states).toHaveLength(3);
        const transition = states[1]!.segment!;
        expect(transition.source).toMatchObject({ made: "transition", style: 0, tempo: 150, command: 2 });
        expect(transition.references).toEqual([c.song]);
        expect(states[2]!.segment).toBe(c.other);
        const snap = capture();
        const world = { mem: mem.slice(), sound: sound.snapshot(), heap: nextHeap, com: nextCom };
        sound.written.clear();
        ticks(500);
        const heard = sound.written.get(port.buffer)!;
        expect(perf.engine!.primaryState()!.segment).toBe(c.other.segment!);
        mem.set(world.mem);
        sound.rewind(world.sound);
        nextHeap = world.heap; nextCom = world.com;
        const back = restore(snap);
        expect(again(back)).toBe(first(snap));
        const perf2 = restoredOf(back, PerformanceObject), port2 = restoredOf(back, PortObject);
        const transition2 = [...perf2.stateObjects.values()][1]!;
        expect(transition2.segment!.segment).toEqual(transition.segment!);
        expect(transition2.state!.queued!.segment).toBe((restoredAt!.get(ptrOf(c.other)) as SegmentObject).segment!);
        ticks(500, back.module);
        expect(sound.written.get(port2.buffer)).toEqual(heard);
        expect(perf2.engine!.primaryState()!.segment).toBe((restoredAt!.get(ptrOf(c.other)) as SegmentObject).segment!);
    });
});

describe("dmusic saved fields of the playing objects", () => {
    test("every saved value of a port, a performance, a segment state, an audio path and the module comes back", () => {
        scene();
        const snap = capture();
        const edit = (change: (s: Snapshot) => void, check?: (back: { roots: DMusicObject[] }) => void): void => {
            const copy: Snapshot = { ...structuredClone({ objects: snap.objects, section: snap.section }), blobs: snap.blobs, refs: snap.refs };
            change(copy);
            expect(first(copy)).not.toBe(first(snap));
            const back = restore(copy);
            if (check) check(back);
            else expect(again(back)).toBe(first(copy));
        };
        for (const key of ["channelGroups", "directSound", "voices"] as const) edit((s) => { of<SavedPort>(s, "dmusic-port")[key] += 1; });
        for (const key of ["ownsBuffer", "active"] as const) edit((s) => { of<SavedPort>(s, "dmusic-port")[key] = !of<SavedPort>(s, "dmusic-port")[key]; });
        edit((s) => { of<SavedPort>(s, "dmusic-port").sampleRate = 44100; });
        edit((s) => { of<SavedPort>(s, "dmusic-port").audioChannels = 1; });
        edit((s) => { of<SavedPort>(s, "dmusic-port").buffer += 16; });
        edit((s) => { of<SavedPort>(s, "dmusic-port").owner = -1; });
        edit((s) => { of<SavedPort>(s, "dmusic-port").performance = -1; });
        edit((s) => { of<SavedPort>(s, "dmusic-port").sink = null; });
        for (const key of ["bufferBytes", "scratch", "writeOffset", "silentBytes"] as const) {
            edit((s) => { of<SavedPort>(s, "dmusic-port").sink![key] += 4; });
            edit((s) => { of<SavedAudioPath>(s, "dmusic-audiopath").sink![key] += 4; });
        }
        edit((s) => { of<SavedPort>(s, "dmusic-port").sink!.playing = false; });
        edit((s) => { of<SavedPort>(s, "dmusic-port").synth.masterGain = 0.25; });
        for (const key of ["notificationHandle", "masterVolume", "masterTempo"] as const) edit((s) => { of<SavedPerformance>(s, "dmusic-performance")[key] += 2; });
        edit((s) => { of<SavedPerformance>(s, "dmusic-performance").notifySegments = false; });
        for (const column of [0, 2, 3]) edit((s) => { of<SavedPerformance>(s, "dmusic-performance").notifications[0]![column]! += 1; });
        edit((s) => { of<SavedPerformance>(s, "dmusic-performance").notifications.pop(); });
        edit((s) => { of<SavedPerformance>(s, "dmusic-performance").directMusic = -1; }, (back) => {
            expect(restoredOf(back, PerformanceObject).directMusic).toBeNull();
        });
        edit((s) => { of<SavedPerformance>(s, "dmusic-performance").engine!.now += 1; });
        for (const key of ["pathType", "buffer", "channels"] as const) edit((s) => { of<SavedAudioPath>(s, "dmusic-audiopath")[key] += 1; });
        edit((s) => { of<SavedAudioPath>(s, "dmusic-audiopath").performance = -1; });
        edit((s) => { of<SavedSegmentState>(s, "dmusic-segment-state").state!.grooveLevel += 1; });
        edit((s) => { of<SavedSegmentState>(s, "dmusic-segment-state", 3).performance = -1; });
        edit((s) => { s.section.pumpTimer += 1; });
        edit((s) => { s.section.messages[0]![0] += 8; });
        edit((s) => { s.section.messages[0]![1] = -1; });
        edit((s) => { s.section.pathOutputs.pop(); });
    });

    test("every field of the playing classes has a policy, and the schema is pinned", () => {
        class Plain extends BaseComObject {
            constructor() {
                super(IID_IUnknown, 0);
            }

            protected destroy(): void {
                return;
            }
        }
        const baseKeys = new Set(Object.keys(new Plain()));
        const own = (o: object) => Object.keys(o).filter(k => !baseKeys.has(k)).sort();
        const keys = (policy: object) => Object.keys(policy).sort();
        const { port } = audio();
        expect(own(port)).toEqual(keys(PORT_FIELDS));
        expect(own(new PerformanceObject())).toEqual(keys(PERFORMANCE_FIELDS));
        expect(own(new SegmentStateObject())).toEqual(keys(SEGMENT_STATE_FIELDS));
        expect(own(new AudioPathObject())).toEqual(keys(AUDIO_PATH_FIELDS));
        expect(own(port.owner as DirectMusicObject)).toEqual(keys(DIRECTMUSIC_FIELDS));
        expect(Object.keys(new DMusic()).sort()).toEqual(keys(DMUSIC_MODULE_FIELDS));
        const synth = new DlsSynth(22050, 2) as unknown as { voices: object[]; channel(id: number): object };
        expect(Object.keys(new Performance(synth as unknown as DlsSynth)).sort()).toEqual(keys(ENGINE_FIELDS));
        expect(Object.keys(new PerfSegmentState(new PerfSegment(), true, 0)).sort()).toEqual(keys(ENGINE_STATE_FIELDS));
        expect(Object.keys(synth).sort()).toEqual(keys(SYNTH_FIELDS));
        expect(Object.keys(synth.channel(0)).sort()).toEqual(keys(SYNTH_CHANNEL_FIELDS));
        expect(Object.keys(synth.voices[0]!).filter(k => (synth.voices[0] as Record<string, unknown>)[k] !== undefined).sort())
            .toEqual(keys(SYNTH_VOICE_FIELDS).filter(k => k !== "channel" && k !== "region"));
        expect(Object.keys(port.sink!).sort()).toEqual(keys(SINK_FIELDS));
        expect(Object.keys(of<SavedPort>(capture(), "dmusic-port")).sort()).toEqual(DMUSIC_SCHEMA.savedPort);
        expect(savestateParticipants.schemas().dmusic).toEqual({ version: 5, schemaHash: "2c7000ebe28c598d" });
    });
});

describe("dmusic refusals that remain", () => {
    test("an object still loading asks to try again; nothing else about the module refuses", () => {
        scene();
        expect(module.savestateRefusal()).toBeNull();
        internals.loading.add({});
        expect(module.savestateRefusal()).toBe("dmusic: an object is still loading; try saving again");
        expect(() => capture()).toThrow(CaptureRefusal);
        expect(() => capture()).toThrow("dmusic: an object is still loading; try saving again");
    });

    test("a state whose segment was loaded again, a playing state without its object, and a transition without its origin are named", () => {
        const s = scene();
        const kept = s.primary.state!;
        s.perf.stateObjects.delete(kept);
        expect(() => capture()).toThrow("dmusic: a playing segment state without its object is not part of a savestate");
        s.perf.stateObjects.set(kept, s.primary);
        expect(load(s.song, segment("Song", 50), {})).toBe(0x08781091);
        expect(() => capture()).toThrow(CaptureRefusal);
        expect(() => capture()).toThrow("dmusic: a segment state whose segment was released or loaded again is not part of a savestate");
        const bare = internals.wrapSegment(s.sting.segment, "Transition") as SegmentObject;
        expect(() => capture([bare])).toThrow("dmusic: a DirectMusic segment that was not loaded from a stream, memory or a file is not part of a savestate");
    });

    test("a channel whose collection was loaded again comes back without an instrument instead of refusing", () => {
        const s = scene();
        expect(load(s.kit, dls())).toBe(0);
        const snap = capture();
        const channel = of<SavedPort>(snap, "dmusic-port").synth.channels.find(ch => ch.id === 7)!;
        expect(channel.collection).toBe(-1);
        const back = restore(snap);
        expect(restoredOf(back, PortObject).synth.activeVoiceCount).toBe(0);
    });
});

describe("dmusic object lifetimes", () => {
    const transitions = (perf: PerformanceObject, composer: ComposerObject, to: SegmentObject, count: number, gap: number): void => {
        for (let i = 0; i < count; i++) {
            expect(call("IDirectMusicComposer8_AutoTransition", [ptrOf(composer), ptrOf(perf), ptrOf(to), 2, 0x20, 0, 0, 0, 0])).toBe(0);
            ticks(gap);
        }
    };
    const segments = (): number => ours().filter(o => o instanceof SegmentObject).length;

    for (const [gap, count] of [[0, 50], [30, 5]] as const) {
        test(`without savestates, ${count} AutoTransitions ${gap} ticks apart with NULL outs leave no state object and no reference behind`, () => {
            flags.__savestates = false;
            const c = content();
            const { perf } = audio();
            const composer = make<ComposerObject>(CLSID_DirectMusicComposer);
            play(perf, c.song, 0);
            ticks(70);
            const before = { song: c.song.refCount, other: c.other.refCount, segments: segments() };
            expect(before).toMatchObject({ song: 2, other: 1 });
            transitions(perf, composer, c.other, count, gap);
            ticks(2000);
            expect(perf.stateObjects.size).toBe(0);
            expect({ song: c.song.refCount, other: c.other.refCount, segments: segments() }).toEqual(before);
            expect(perf.engine!.primaryState()!.segment).toBe(c.other.segment!);
        });

        test(`with savestates, ${count} AutoTransitions ${gap} ticks apart keep only the playing state and its segment`, () => {
            const c = content();
            const { perf } = audio();
            const composer = make<ComposerObject>(CLSID_DirectMusicComposer);
            play(perf, c.song, 0);
            ticks(70);
            const before = { song: c.song.refCount, other: c.other.refCount, segments: segments() };
            transitions(perf, composer, c.other, count, gap);
            ticks(2000);
            expect(perf.engine!.activeStates()).toHaveLength(1);
            expect([...perf.stateObjects.keys()]).toEqual([perf.engine!.primaryState()!]);
            expect({ song: c.song.refCount, other: c.other.refCount, segments: segments() }).toEqual({ ...before, other: before.other + 1 });
            call("IDirectMusicPerformance8_Stop", [ptrOf(perf), 0, 0, 0, 0]);
            expect(perf.stateObjects.size).toBe(0);
            expect(c.other.refCount).toBe(before.other);
        });
    }

    for (const saving of [false, true]) {
        test(`fifty times over, what is made and released leaves counts as they were (savestates ${saving ? "on" : "off"})`, () => {
            flags.__savestates = saving;
            const c = content();
            const { perf, port } = audio();
            const composer = make<ComposerObject>(CLSID_DirectMusicComposer);
            expect(call("IDirectMusicStyle8_GetDefaultBand", [ptrOf(c.race), OUT])).toBe(0);
            const band = at<DMusicObject>(view().getUint32(OUT, true));
            const counts = () => ({
                objects: ours().length, kit: c.kit.refCount, race: c.race.refCount, song: c.song.refCount, other: c.other.refCount,
                band: band.refCount, states: perf.stateObjects.size, playing: perf.engine!.activeStates().length,
            });
            const before = counts();
            for (let i = 0; i < 50; i++) {
                writeWide(NAME_AT, "Sting");
                expect(call("IDirectMusicStyle8_GetMotif", [ptrOf(c.race), NAME_AT, OUT])).toBe(0);
                const motif = at<SegmentObject>(view().getUint32(OUT, true));
                expect(c.race.refCount).toBe(before.race + (saving ? 1 : 0));
                motif.release();
            }
            expect(counts()).toEqual(before);
            for (let i = 0; i < 50; i++) {
                expect(call("IDirectMusicBand_CreateSegment", [ptrOf(band), OUT])).toBe(0);
                at<SegmentObject>(view().getUint32(OUT, true)).release();
                expect(call("IDirectMusicStyle8_GetDefaultBand", [ptrOf(c.race), OUT])).toBe(0);
                at<DMusicObject>(view().getUint32(OUT, true)).release();
            }
            expect(counts()).toEqual(before);
            for (let i = 0; i < 50; i++) {
                play(perf, c.song, 0).release();
                ticks(3);
                expect(call("IDirectMusicPerformance8_Stop", [ptrOf(perf), 0, 0, 0, 0])).toBe(0);
            }
            expect(counts()).toEqual(before);
            for (let i = 0; i < 50; i++) play(perf, i % 2 ? c.song : c.other, DMUS_SEGF_MEASURE).release();
            ticks(400);
            expect(counts()).toEqual({ ...before, objects: before.objects + 1, song: before.song + 1, states: 1, playing: 1 });
            transitions(perf, composer, c.other, 50, 0);
            ticks(600);
            expect(counts()).toEqual({ ...before, objects: before.objects + (saving ? 1 : 0), other: before.other + (saving ? 1 : 0), states: saving ? 1 : 0, playing: 1 });
            call("IDirectMusicPerformance8_Stop", [ptrOf(perf), 0, 0, 0, 0]);
            ticks(3);
            expect(counts()).toEqual(before);
            expect(port.synth.stats.notes).toBeGreaterThan(0);
        });
    }

    test("without savestates nothing is recorded: no source, no origin reference, no command log, and the host's random source", () => {
        flags.__savestates = false;
        const c = content();
        const { perf } = audio();
        expect([c.kit, c.race, c.song, c.effect, c.sting].map(o => o.source)).toEqual([null, null, null, null, null]);
        expect(c.sting.references).toEqual([]);
        mem.set(guidBytes("d2ac289d-b39b-11d1-8704-00600893b1bd"), GUID_AT);
        mem.set([1, 40, 0], NAME_AT);
        expect(call("IDirectMusicSegment8_SetParam", [ptrOf(c.song), GUID_AT, 1, 0, 0, NAME_AT])).toBe(0);
        expect(c.song.commandEdits.size).toBe(0);
        expect(perf.engine!.random).toBe(Math.random);
        flags.__savestates = true;
        expect(call("IDirectMusicSegment8_SetParam", [ptrOf(c.song), GUID_AT, 1, 0, 0, NAME_AT])).toBe(0);
        expect(c.song.commandEdits.size).toBe(1);
    });

    test("a collection that was released is not named for an instrument still on a channel", () => {
        const s = scene();
        const refs = s.kit.refCount;
        for (let i = 0; i < refs; i++) s.kit.release();
        expect(s.kit.refCount).toBe(0);
        const channel = of<SavedPort>(capture(ours().filter(o => o !== s.kit)), "dmusic-port").synth.channels.find(ch => ch.id === 7)!;
        expect(channel.collection).toBe(-1);
    });
});
