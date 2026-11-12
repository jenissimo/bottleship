import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { BaseComObject } from "../../src/worker/core/com/base-com-object";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { DMusic } from "../../src/worker/modules/dmusic";
import {
    BandObject, CLSID_DirectMusicBand, CLSID_DirectMusicCollection, CLSID_DirectMusicLoader, CLSID_DirectMusicSegment,
    CLSID_DirectMusicStyle, CollectionObject, type DMusicObject, IID_IUnknown, type LoadableObject, type LoaderObject,
    PerformanceObject, PortObject, SegmentObject, SegmentStateObject, StyleObject, TrackObject,
} from "../../src/worker/modules/dmusic-objects";
import {
    BAND_FIELDS, COLLECTION_FIELDS, DMUSIC_SCHEMA, SEGMENT_FIELDS, SEGMENT_SETTINGS, STYLE_FIELDS, TRACK_FIELDS,
    type SavedLoadable, type SavedSegment,
} from "../../src/worker/modules/dmusic-savestate";
import { guidBytes } from "../../src/worker/modules/dpnet/constants";
import { DMUS_IO_INST_PATCH } from "../../packages/formats/src/dmusic/band";
import { DMUS_OBJ_FILENAME, DMUS_OBJ_MEMORY } from "../../packages/formats/src/dmusic/reference";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { CaptureRefusal, newObjectGraph, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { ParticipantRegistry, savestateParticipants } from "../../src/worker/savestate/participant";
import { writeRamChunks, RAM_CHUNK_SIZE } from "../../src/worker/savestate/ram";
import { captureSession } from "../../src/worker/savestate/session";
import { sha256HexSync } from "../../src/worker/savestate/sha256";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { ascii, bandChunks, bytes as cat, chunk, f64, guid, i16, i32, list, reference, riff, u16, u32, u8, wide } from "./dmusic-fixtures";

const PART_ID = "0e54d502-1111-2222-3344-556677889900";
const GUID_CommandParam = "d2ac289d-b39b-11d1-8704-00600893b1bd";
const CLSID_BandTrack = "d2ac2894-b39b-11d1-8704-00600893b1bd";
const DESC = { validData: 4, fileName: 0x138, memLength: 0x340, memData: 0x348 };
const OUT = 0x200, RIID = 0x300, GUID_AT = 0x320, PARAM_AT = 0x340, DESC_AT = 0x1000, STREAM = 0x3000, GET_LOADER = 0x3010, GUEST_LOADER = 0x3020;
const WAVE_AT = 0x6000;
const E_FAIL = 0x80004005 | 0, DMUS_S_PARTIALLOAD = 0x08781091, DMUS_E_LOADER_FORMATNOTSUPPORTED = 0x88781183 | 0;

function dls(fill: number, samples = 6): Uint8Array {
    const wave = list("wave",
        chunk("fmt ", u16(1, 1), u32(22050, 44100), u16(2, 16)),
        chunk("wsmp", u32(20), u16(60), i16(-3), i32(-655360), u32(0, 1), u32(16, 0, 2, 3)),
        chunk("data", i16(...Array.from({ length: samples }, (_, i) => ((i * 37 + fill * 101) & 0x7fff) - 0x4000))));
    return riff("DLS ",
        chunk("colh", u32(1)),
        chunk("dlid", guid(PART_ID)),
        list("lins", list("ins ",
            chunk("insh", u32(1, 0, 25)),
            list("lrgn", list("rgn ", chunk("rgnh", u16(0, 127, 0, 127, 0, 0)), chunk("wlnk", u16(0, 0), u32(1, 0)))),
            list("INFO", chunk("INAM", ascii(`Kit${fill}\0`))))),
        chunk("ptbl", u32(8, 1), u32(0)),
        list("wvpl", wave));
}

const band = (name = "Brass"): Uint8Array => riff("DMBD", chunk("guid", guid(PART_ID)), ...bandChunks(name, [
    { patch: 5, pChannel: 0, flags: DMUS_IO_INST_PATCH, collection: "kit.dls" },
    { patch: 7, pChannel: 1, flags: DMUS_IO_INST_PATCH, collection: "none.dls" },
    { patch: 9, pChannel: 2, flags: DMUS_IO_INST_PATCH },
]));

function style(tempo = 96): Uint8Array {
    const choices = new Uint32Array(32).fill(0x20000000);
    const note = cat(i32(4), u32(1), i32(192), i16(-6), u16(0x3110), u8(100, 0, 0, 0, 0, 14), u8(0, 0));
    return riff("DMST",
        chunk("styh", u8(3, 4), u16(4), u32(0), f64(tempo)),
        chunk("guid", guid(PART_ID)),
        list("DMBD", ...bandChunks("Default", [{ patch: 5, pChannel: 0, flags: DMUS_IO_INST_PATCH, collection: "kit.dls" }])),
        list("part",
            chunk("prth", u8(4, 4), u16(2), new Uint8Array(choices.buffer), guid(PART_ID), u16(2), u8(14, 0, 0), u8(0, 0, 0)),
            chunk("note", cat(u32(24), note))),
        list("pttn",
            chunk("ptnh", u8(3, 4), u16(4), u8(10, 20), u16(0), u16(4)),
            chunk("rhtm", u32(1, 0, 0, 0)),
            list("UNFO", chunk("UNAM", wide("Verse"))),
            list("pref", chunk("prfc", guid(PART_ID), u16(7), u8(2, 1, 100, 1), u16(0), u32(7)))),
        list("pttn",
            chunk("ptnh", u8(3, 4), u16(4), u8(1, 100), u16(0), u16(1)),
            chunk("mtfs", u32(2), i32(0, 0, 2304), u32(0x1000)),
            list("UNFO", chunk("UNAM", wide("Sting")))));
}

function track(classId: string, group: number, ...body: Uint8Array[]): Uint8Array {
    return riff("DMTK", chunk("trkh", guid(classId), u32(0, group), ascii("xxxx"), u32(0)), ...body);
}

const segment = (name = "Race"): Uint8Array => riff("DMSG",
    chunk("segh", u32(99), i32(12288, 3072, 3072, 9216), u32(0x2000)),
    chunk("guid", guid(PART_ID)),
    list("UNFO", chunk("UNAM", wide(name))),
    list("trkl",
        track("d2ac2885-b39b-11d1-8704-00600893b1bd", 0xffffffff, chunk("tetr", u32(16), i32(0), u32(0), f64(140), i32(768), u32(0), f64(135.5))),
        track("d2ac288c-b39b-11d1-8704-00600893b1bd", 1,
            chunk("cmnd", u32(12), i32(0), u16(0), u8(0, 0, 13, 0), u16(0), i32(12288), u16(4), u8(0, 4, 56, 2), u16(0))),
        track("d2ac288d-b39b-11d1-8704-00600893b1bd", 1,
            list("sttr", list("strf", chunk("stmp", i32(0)), reference(CLSID_DirectMusicStyle, "Race.sty", PART_ID)))),
        track(CLSID_BandTrack, 1,
            riff("DMBT", list("lbdl", list("lbnd", chunk("bdih", i32(3072)),
                riff("DMBD", ...bandChunks("Second", [{ patch: 1, pChannel: 2, flags: DMUS_IO_INST_PATCH, collection: "kit.dls" }]))))))));

const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const le32 = (v: number): number[] => [...le16(v & 0xffff), ...le16(v >>> 16)];
function wav(...samples: number[]): Uint8Array {
    const data = samples.flatMap((x) => le16(x & 0xffff));
    const body = [...ascii("WAVE"), ...ascii("fmt "), ...le32(16), ...le16(1), ...le16(1), ...le32(22050), ...le32(44100), ...le16(2), ...le16(16),
        ...ascii("data"), ...le32(data.length), ...data];
    return Uint8Array.from([...ascii("RIFF"), ...le32(body.length), ...body]);
}
const be = (v: number, n: number): number[] => Array.from({ length: n }, (_, i) => (v >>> ((n - 1 - i) * 8)) & 0xff);
const SMF = Uint8Array.from([...ascii("MThd"), ...be(6, 4), ...be(0, 2), ...be(1, 2), ...be(96, 2),
    ...ascii("MTrk"), ...be(8, 4), 0x00, 0x90, 0x3c, 0x64, 0x00, 0xff, 0x2f, 0x00]);

const system = System.getInstance(), savedProcess = system.process, savedFs = (system as unknown as { fileSystem: unknown }).fileSystem;
const rp = SystemResourceProvider.getInstance();
const flags = globalThis as { __savestates?: unknown };
let mem: Uint8Array, module: DMusic, internals: Record<string, any>, guestProcess: unknown;
let files: Map<string, Uint8Array>, dispose: Array<() => void>, comBefore: Set<number>, nextHeap: number, nextCom: number, savedFlag: unknown;

function newModule(): DMusic {
    const m = new DMusic(), i = m as unknown as Record<string, any>;
    i.process = guestProcess;
    m.vtables = new Proxy({}, { get: () => ({ address: 0x1000 }) }) as never;
    for (const method of ["registerLoaderExports", "registerObjectExports", "registerSegmentExports", "registerStyleExports", "registerBandExports"]) i[method]();
    i.readSystemFile = (paths: string[]) => files.get(paths[0]!.toLowerCase()) ?? null;
    dispose.push(m.registerSavestate());
    return m;
}

beforeEach(() => {
    savedFlag = flags.__savestates;
    flags.__savestates = true;
    comBefore = new Set(rp.getAllComObjects().map(o => o.handle));
    mem = new Uint8Array(0x80000);
    Mem.bind(() => mem);
    nextHeap = 0x10000; nextCom = 0x8000;
    files = new Map(); dispose = [];
    guestProcess = {
        resetGeneration: 0,
        getCurrentMemory: () => mem,
        memory: {
            alloc: (n: number) => { const p = nextHeap; nextHeap += (n + 15) & ~15; return p; }, free: () => undefined,
            allocSystemBlock: (n: number) => { const p = nextCom; nextCom += (n + 15) & ~15; return p; },
            freeSystemBlock: () => undefined,
        },
        addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= mem.length },
        getModule: () => undefined,
    };
    system.process = guestProcess as never;
    (system as unknown as { fileSystem: unknown }).fileSystem = { currentDir: "C:\\MUSIC\\" };
    module = newModule();
    internals = module as unknown as Record<string, any>;
    mem.set(guidBytes(IID_IUnknown), RIID);
});

afterEach(() => {
    for (const off of dispose) off();
    for (const o of rp.getAllComObjects()) if (!comBefore.has(o.handle)) o.forceRelease();
    system.process = savedProcess;
    (system as unknown as { fileSystem: unknown }).fileSystem = savedFs;
    flags.__savestates = savedFlag;
});

function make<T extends DMusicObject>(clsid: string): T {
    expect(module.coCreateInstance(clsid, IID_IUnknown, OUT)).toBe(0);
    return rp.getComObjectByAddress(Mem.readUint32(OUT)!) as T;
}

const ptrOf = (obj: DMusicObject): number => obj.addresses.get(obj.primaryVtable)!;

function writeWide(at: number, text: string): void {
    const view = new DataView(mem.buffer);
    for (let i = 0; i <= text.length; i++) view.setUint16(at + i * 2, i < text.length ? text.charCodeAt(i) : 0, true);
}

function readWide(at: number): string {
    let out = "";
    for (let i = 0; ; i++) {
        const code = new DataView(mem.buffer).getUint16(at + i * 2, true);
        if (!code) return out;
        out += String.fromCharCode(code);
    }
}

function load(obj: LoadableObject, content: Uint8Array, named: Record<string, DMusicObject> = {}): number {
    nextHeap = 0x10000;
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

function loaded<T extends LoadableObject>(clsid: string, content: Uint8Array, named: Record<string, DMusicObject> = {}, hr = 0): T {
    const obj = make<T>(clsid);
    expect(load(obj, content, named)).toBe(hr);
    return obj;
}

function getObject(loader: LoaderObject, valid: number, name = "", memory?: Uint8Array): SegmentObject {
    mem.fill(0, DESC_AT, DESC_AT + 0x350);
    const view = new DataView(mem.buffer);
    view.setUint32(DESC_AT + DESC.validData, valid, true);
    if (name) writeWide(DESC_AT + DESC.fileName, name);
    if (memory) {
        mem.set(memory, WAVE_AT);
        view.setUint32(DESC_AT + DESC.memLength, memory.length, true);
        view.setUint32(DESC_AT + DESC.memData, WAVE_AT, true);
    }
    expect(module.exports["IDirectMusicLoader8_GetObject"]!({} as never, mem, [ptrOf(loader), DESC_AT, RIID, OUT])).toBe(0);
    return rp.getComObjectByAddress(Mem.readUint32(OUT)!) as SegmentObject;
}

function setCommand(seg: SegmentObject, time: number, command: number, level: number, range: number): number {
    mem.set(guidBytes(GUID_CommandParam), GUID_AT);
    mem.set([command, level, range], PARAM_AT);
    return module.exports["IDirectMusicSegment8_SetParam"]!({} as never, mem, [ptrOf(seg), GUID_AT, 1, 0, time, PARAM_AT]) as number;
}

function getTrack(seg: SegmentObject, classId: string): TrackObject {
    mem.set(guidBytes(classId), GUID_AT);
    expect(module.exports["IDirectMusicSegment8_GetTrack"]!({} as never, mem, [ptrOf(seg), GUID_AT, 1, 0, OUT])).toBe(0);
    return rp.getComObjectByAddress(Mem.readUint32(OUT)!) as TrackObject;
}

const encoded = (v: unknown): string => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

interface Trip<T extends unknown[]> { first: string; again: string; back: T; objects: Array<[string, SaveValue]>; blobs: Map<string, Uint8Array> }

function capture(roots: unknown[]): { objects: Array<[string, SaveValue]>; blobs: Map<string, Uint8Array>; refs: number[] } {
    const graph = newObjectGraph();
    const refs = roots.map((o, i) => graph.ref(o, `root ${i}`));
    return { objects: graph.objects, blobs: graph.blobs, refs };
}

function restore<T extends unknown[]>(objects: Array<[string, SaveValue]>, blobs: ReadonlyMap<string, Uint8Array>, refs: number[]): T {
    newModule();
    const e = encodeValue(objects as unknown as SaveValue);
    const ctx = restoreObjectGraph(decodeValue(e) as unknown as Array<[string, SaveValue]>, blobs);
    return refs.map(r => ctx.object(r)) as T;
}

function roundTrip<T extends unknown[]>(roots: [...T]): Trip<T> {
    const { objects, blobs, refs } = capture(roots);
    const back = restore<T>(objects, blobs, refs);
    return { first: encoded(objects), again: encoded(capture(back).objects), back, objects, blobs };
}

function sameCom(back: DMusicObject, live: DMusicObject): void {
    expect(BaseComObject.captureComBase(back)).toEqual(BaseComObject.captureComBase(live));
    expect([...back.addresses]).toEqual([...live.addresses]);
    expect(back).not.toBe(live);
}

const savedOf = (roots: unknown[]): SavedLoadable & SavedSegment => capture(roots).objects[0]![1] as unknown as SavedLoadable & SavedSegment;

function world() {
    const kit = loaded<CollectionObject>(CLSID_DirectMusicCollection, dls(1));
    const brass = loaded<BandObject>(CLSID_DirectMusicBand, band(), { "kit.dls": kit }, DMUS_S_PARTIALLOAD);
    const race = loaded<StyleObject>(CLSID_DirectMusicStyle, style(), { "kit.dls": kit });
    const song = loaded<SegmentObject>(CLSID_DirectMusicSegment, segment(), { "Race.sty": race, "kit.dls": kit });
    return { kit, brass, race, song };
}

describe("dmusic objects loaded from a stream", () => {
    test("a collection, band, style and segment are parsed again from the bytes Load consumed", () => {
        const { kit, brass, race, song } = world();
        expect(kit.source).toEqual({ bytes: dls(1) });
        expect(song.resolved).toEqual([race, kit]);
        const { first, again, back, blobs } = roundTrip([kit, brass, race, song]);
        expect(again).toBe(first);
        expect([...blobs.keys()].sort()).toEqual([dls(1), band(), style(), segment()].map(sha256HexSync).sort());
        const [kit2, brass2, race2, song2] = back;
        for (const [b, l] of [[kit2, kit], [brass2, brass], [race2, race], [song2, song]] as const) {
            sameCom(b, l);
            expect(b.constructor).toBe(l.constructor);
            expect(b.identity).toEqual(l.identity);
            expect(b.loaded).toBe(true);
            expect(b.source).toEqual(l.source);
        }
        expect(kit2.collection).toEqual(kit.collection!);
        expect(kit2.collection).not.toBe(kit.collection);
        expect(kit2.identity).toBe(kit2.collection!.identity);

        expect(brass2.file).toEqual(brass.file!);
        expect(brass2.band).toEqual(brass.band!);
        expect(brass2.band!.band).toBe(brass2.file!);
        expect(brass2.band!.collections).toEqual([kit2.collection, null, null]);
        expect(brass2.band!.collections[0]).toBe(kit2.collection);
        expect(brass2.references).toEqual([kit2]);
        expect(brass2.references[0]).toBe(kit2);
        expect(brass2.resolved).toEqual([kit2, null]);

        expect(race2.style).toEqual(race.style!);
        expect(race2.bands).toEqual(race.bands);
        expect(race2.bands[0]!.collections[0]).toBe(kit2.collection);
        expect(race2.references[0]).toBe(kit2);

        expect(song2.file).toEqual(song.file!);
        expect(song2.segment).toEqual(song.segment!);
        expect(song2.segment!.styles[0]!.style).toBe(race2.style!);
        expect(song2.segment!.bands[0]!.band.collections[0]).toBe(kit2.collection);
        expect(song2.tracks).toEqual(song.tracks);
        expect(song2.references).toEqual([race2, kit2]);
        expect(song2.references[0]).toBe(race2);
        expect(song2.references[1]).toBe(kit2);
        const released: DMusicObject[] = [];
        for (const target of song2.references) target.release = () => { released.push(target); return 0; };
        song2.onDestroy?.();
        expect(released).toEqual([race2, kit2]);
        expect(song2.references).toEqual([]);
    });

    test("an object created but never loaded keeps its descriptor and stays unloaded", () => {
        const seg = make<SegmentObject>(CLSID_DirectMusicSegment);
        seg.fileName = "later.sgt";
        seg.identity.name = "Later";
        const { first, again, back: [back] } = roundTrip([seg]);
        expect(again).toBe(first);
        sameCom(back, seg);
        expect(back).toMatchObject({ fileName: "later.sgt", loaded: false, source: null, segment: null, file: null });
        expect(back.identity).toEqual(seg.identity);
    });

    test("what the guest set on a loaded object afterwards is kept: descriptor, segment settings, commands, tracks", () => {
        const { song, brass } = world();
        brass.identity.name = "Renamed";
        brass.identity.objectId = "11111111-2222-3333-4444-555555555555";
        brass.fileName = "brass.bnd";
        SEGMENT_SETTINGS.forEach((key, i) => { song.segment![key] = 1000 + i; });
        expect(setCommand(song, 0, 1, 77, 3)).toBe(0);
        expect(setCommand(song, 3072 * 2, 2, 33, 1)).toBe(0);
        expect(setCommand(song, 0, 4, 78, 5)).toBe(0);
        expect([...song.commandEdits]).toEqual([[6144, [2, 33, 1]], [0, [4, 78, 5]]]);
        const bandTrack = getTrack(song, CLSID_BandTrack);
        const dropped = getTrack(song, "d2ac288c-b39b-11d1-8704-00600893b1bd");
        dropped.release();
        const { first, again, back: [song2, brass2, track2] } = roundTrip([song, brass, bandTrack]);
        expect(again).toBe(first);
        expect(brass2.identity).toEqual(brass.identity);
        expect(brass2.identity).toBe(brass2.file!.identity);
        expect(brass2.fileName).toBe("brass.bnd");
        expect(song2.segment).toEqual(song.segment!);
        expect(song2.segment!.commands).toEqual(song.segment!.commands);
        expect([...song2.commandEdits]).toEqual([...song.commandEdits]);
        expect(song2.tracks.map(t => t.object)).toEqual([null, null, null, track2]);
        sameCom(track2, bandTrack);
        expect(track2.classId).toBe(CLSID_BandTrack);
        expect(track2.owner).toBe(song2);
    });

    test("a second Load replaces the source; a failed one leaves an unloaded object, or is refused by name when stale content stays usable", () => {
        const { kit, song, brass } = world();
        setCommand(song, 0, 1, 77, 3);
        expect(load(song, segment("Again"), {})).toBe(DMUS_S_PARTIALLOAD);
        expect(song.source).toEqual({ bytes: segment("Again") });
        expect(song.commandEdits.size).toBe(0);
        const { first, again, back: [song2] } = roundTrip([song]);
        expect(again).toBe(first);
        expect(song2.identity.name).toBe("Again");
        expect(song2.resolved).toEqual([null, null]);
        expect(song2.segment).toEqual(song.segment!);
        expect(load(kit, band())).toBe(DMUS_E_LOADER_FORMATNOTSUPPORTED);
        expect(kit).toMatchObject({ source: null, loaded: false, collection: null });
        const { back: [kit2] } = roundTrip([kit]);
        expect(kit2).toMatchObject({ source: null, loaded: false, collection: null });
        expect(kit2.identity).toEqual(kit.identity);
        expect(load(song, dls(1))).toBe(DMUS_E_LOADER_FORMATNOTSUPPORTED);
        expect(song.source).toBeNull();
        expect(() => capture([song])).toThrow(CaptureRefusal);
        expect(() => capture([song])).toThrow("dmusic: a DirectMusic segment whose load failed is not part of a savestate");
        expect(load(brass, dls(1))).toBe(DMUS_E_LOADER_FORMATNOTSUPPORTED);
        expect(() => capture([brass])).toThrow("dmusic: a DirectMusic band whose load failed is not part of a savestate");
    });
});

describe("dmusic objects made by the system loader", () => {
    function setup() {
        files.set("c:\\music\\hit.wav", wav(100, -200, 300));
        files.set("c:\\music\\song.mid", SMF);
        const loader = make<LoaderObject>(CLSID_DirectMusicLoader);
        loader.searchDirectory = "C:\\MUSIC";
        const fromFile = getObject(loader, DMUS_OBJ_FILENAME, "hit.wav");
        const midi = getObject(loader, DMUS_OBJ_FILENAME, "song.mid");
        const fromMemory = getObject(loader, DMUS_OBJ_MEMORY, "", wav(1, 2, 3, 4));
        const twin = getObject(loader, DMUS_OBJ_MEMORY, "", wav(1, 2, 3, 4));
        return { loader, fromFile, midi, fromMemory, twin };
    }

    test("a WAVE from memory keeps its bytes; a WAVE or MIDI file keeps its path, length and hash", () => {
        const { loader, fromFile, midi, fromMemory, twin } = setup();
        mem.fill(0, WAVE_AT, WAVE_AT + 64);
        expect(fromMemory.source).toEqual({ bytes: wav(1, 2, 3, 4) });
        expect(fromFile.source).toEqual({ file: "C:\\MUSIC\\hit.wav", length: wav(100, -200, 300).length, hash: sha256HexSync(wav(100, -200, 300)) });
        expect(midi.source).toEqual({ file: "C:\\MUSIC\\song.mid", length: SMF.length, hash: sha256HexSync(SMF) });
        expect(midi.resolved).toEqual([loader.defaultCollection]);
        const { first, again, back, blobs } = roundTrip([loader, fromFile, midi, fromMemory, twin]);
        expect(again).toBe(first);
        expect([...blobs.keys()]).toEqual([sha256HexSync(wav(1, 2, 3, 4))]);
        const [loader2, fromFile2, midi2, fromMemory2, twin2] = back;
        for (const [b, l] of [[fromFile2, fromFile], [midi2, midi], [fromMemory2, fromMemory], [twin2, twin]] as const) {
            sameCom(b, l);
            expect(b.source).toEqual(l.source);
            expect(b.identity).toEqual(l.identity);
            expect(b.fileName).toBe(l.fileName);
            expect(b.segment).toEqual(l.segment!);
            expect(b.file).toEqual(l.file);
            expect(b.tracks).toEqual(l.tracks);
            expect(b.loaded).toBe(true);
        }
        expect(fromMemory2.segment!.wave).not.toBe(fromMemory.segment!.wave);
        expect(twin2.segment!.wave).toBe(fromMemory2.segment!.wave);
        expect(twin2.source).toEqual(fromMemory2.source);
        expect([...loader2.cache.keys()]).toEqual(["c:\\music\\hit.wav", "c:\\music\\song.mid"]);
        expect(loader2.cache.get("c:\\music\\hit.wav")).toBe(fromFile2);
        expect(loader2.cache.get("c:\\music\\song.mid")).toBe(midi2);
        expect(midi2.resolved).toEqual([loader2.defaultCollection]);
        expect(midi2.resolved[0]).toBe(loader2.defaultCollection);
        expect(midi2.segment!.bands[0]!.band.collections[0]).toBe(loader2.defaultCollection!.collection);
    });

    test("a file that changed or went missing is named, and so is a missing or unparseable blob", () => {
        const { fromFile, midi, fromMemory } = setup();
        const { objects, blobs, refs } = capture([fromFile, midi, fromMemory]);
        const hash = sha256HexSync(wav(1, 2, 3, 4));
        files.set("c:\\music\\hit.wav", wav(100, -200, 301));
        expect(() => restore(objects, blobs, refs)).toThrow("dmusic: C:\\MUSIC\\hit.wav changed since a DirectMusic segment was loaded from it");
        files.set("c:\\music\\hit.wav", wav(100, -200));
        expect(() => restore(objects, blobs, refs)).toThrow("dmusic: C:\\MUSIC\\hit.wav changed since a DirectMusic segment was loaded from it");
        files.set("c:\\music\\hit.wav", wav(100, -200, 300));
        files.delete("c:\\music\\song.mid");
        expect(() => restore(objects, blobs, refs)).toThrow("dmusic: C:\\MUSIC\\song.mid is missing; a DirectMusic segment was loaded from it");
        files.set("c:\\music\\song.mid", SMF);
        expect(() => restore(objects, new Map(), refs)).toThrow(`savestate: blob ${hash} is missing`);
        expect(() => restore(objects, new Map([[hash, Uint8Array.from(ascii("RIFF....WAVE"))]]), refs))
            .toThrow(`dmusic: a DirectMusic segment no longer parses from blob ${hash}`);
        expect(restore(objects, blobs, refs).length).toBe(3);
    });

    test("a snapshot whose references no longer match what the bytes ask for does not restore", () => {
        const { brass } = world();
        const { objects, blobs, refs } = capture([brass]);
        (objects[0]![1] as unknown as SavedLoadable).resolved.pop();
        expect(() => restore(objects, blobs, refs)).toThrow(`dmusic: a DirectMusic band no longer parses from blob ${sha256HexSync(band())}`);
    });
});

describe("dmusic saved fields", () => {
    test("every saved field changes the capture and comes back", () => {
        const { kit, brass, song } = world();
        const other = loaded<CollectionObject>(CLSID_DirectMusicCollection, dls(2));
        const baseline = encoded(savedOf([song]));
        const edits: Array<[string, () => void, (s: SegmentObject) => unknown, unknown]> = [
            ["fileName", () => { song.fileName = "race.sgt"; }, s => s.fileName, "race.sgt"],
            ["identity", () => { song.identity.name = "Lap"; }, s => s.identity.name, "Lap"],
            ...SEGMENT_SETTINGS.map((key, i) => [`settings.${key}`, () => { song.segment![key] = 50 + i; }, (s: SegmentObject) => s.segment![key], 50 + i] as [string, () => void, (s: SegmentObject) => unknown, unknown]),
            ["commandEdits", () => { setCommand(song, 0, 2, 9, 1); }, s => s.segment!.commands![0], { time: 0, measure: 0, beat: 0, command: 2, grooveLevel: 9, grooveRange: 1 }],
            ["tracks", () => { getTrack(song, CLSID_BandTrack); }, s => s.tracks[3]!.object!.classId, CLSID_BandTrack],
            ["addresses", () => { song.addresses.set("IDirectMusicObject", 0x9990); }, s => s.addresses.get("IDirectMusicObject"), 0x9990],
            ["base", () => { song.addRef(); }, s => s.refCount, song.refCount + 1],
        ];
        let previous = baseline;
        for (const [name, edit, read, want] of edits) {
            edit();
            const now = encoded(savedOf([song]));
            expect([name, now === previous]).toEqual([name, false]);
            previous = now;
            const { first, again, back: [back] } = roundTrip([song]);
            expect([name, again === first]).toEqual([name, true]);
            expect([name, read(back)]).toEqual([name, want]);
        }

        const before = savedOf([brass]);
        expect(load(brass, band("Reeds"), { "kit.dls": kit })).toBe(DMUS_S_PARTIALLOAD);
        expect(savedOf([brass]).source).not.toEqual(before.source);
        const kitRef = encoded(capture([brass]).objects);
        expect(load(brass, band("Reeds"), { "kit.dls": other })).toBe(DMUS_S_PARTIALLOAD);
        expect(encoded(capture([brass]).objects)).not.toBe(kitRef);
        const { back: [brass2, other2] } = roundTrip([brass, other]);
        expect(brass2.band!.collections[0]).toBe(other2.collection);
        expect(brass2.file!.identity.name).toBe("Reeds");

        const bandTrack = getTrack(song, CLSID_BandTrack);
        const trackBefore = encoded(capture([bandTrack]).objects);
        bandTrack.classId = "d2ac288c-b39b-11d1-8704-00600893b1bd";
        expect(encoded(capture([bandTrack]).objects)).not.toBe(trackBefore);
        expect(roundTrip([bandTrack]).back[0].classId).toBe("d2ac288c-b39b-11d1-8704-00600893b1bd");
    });

    test("every field of the saved classes has a policy", () => {
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
        expect(own(new CollectionObject())).toEqual(Object.keys(COLLECTION_FIELDS).sort());
        expect(own(new BandObject())).toEqual(Object.keys(BAND_FIELDS).sort());
        expect(own(new StyleObject())).toEqual(Object.keys(STYLE_FIELDS).sort());
        expect(own(new SegmentObject())).toEqual(Object.keys(SEGMENT_FIELDS).sort());
        expect(own(new TrackObject())).toEqual(Object.keys(TRACK_FIELDS).sort());
        const { song } = world();
        const saved = savedOf([song]);
        expect(Object.keys(saved).sort()).toEqual([...DMUSIC_SCHEMA.loadable, ...DMUSIC_SCHEMA.savedSegment].sort());
        expect(Object.keys(saved.identity).sort()).toEqual(DMUSIC_SCHEMA.identity);
        expect(Object.keys(saved.settings!)).toEqual([...DMUSIC_SCHEMA.segmentSettings]);
    });
});

describe("dmusic objects made by another object", () => {
    function made() {
        const { kit, brass, race } = world();
        const call = <T extends DMusicObject>(name: string, args: number[]): T => {
            expect(module.exports[name]!({} as never, mem, args)).toBe(0);
            return rp.getComObjectByAddress(Mem.readUint32(OUT)!) as T;
        };
        const bandSegment = call<SegmentObject>("IDirectMusicBand_CreateSegment", [ptrOf(brass), OUT]);
        writeWide(PARAM_AT, "Sting");
        const motif = call<SegmentObject>("IDirectMusicStyle8_GetMotif", [ptrOf(race), PARAM_AT, OUT]);
        const styleBand = call<BandObject>("IDirectMusicStyle8_GetDefaultBand", [ptrOf(race), OUT]);
        return { kit, brass, race, bandSegment, motif, styleBand };
    }

    test("a motif, a band segment and a style's band keep their origin and are made again from it", () => {
        const { brass, race, bandSegment, motif, styleBand } = made();
        expect(motif.source).toEqual({ made: "motif", index: 0, of: race.source });
        expect(bandSegment.source).toEqual({ made: "band-segment", of: brass.source });
        expect(styleBand.source).toEqual({ made: "style-band", index: 0, of: race.source });
        expect(motif.references).toEqual([race]);
        motif.segment!.repeats = 7;
        const { first, again, back } = roundTrip([motif, bandSegment, styleBand, race, brass]);
        expect(again).toBe(first);
        const [motif2, bandSegment2, styleBand2, race2, brass2] = back;
        for (const [b, l] of [[motif2, motif], [bandSegment2, bandSegment], [styleBand2, styleBand]] as const) {
            sameCom(b, l);
            expect(b.identity).toEqual(l.identity);
            expect(b.loaded).toBe(true);
        }
        expect(motif2.segment).toEqual(motif.segment!);
        expect(motif2.segment!.repeats).toBe(7);
        expect(motif2.segment!.fixedPattern!.style).toBe(race2.style!);
        expect(motif2.segment!.fixedPattern!.pattern).toBe(race2.style!.motifs[0]!);
        expect(motif2.references[0]).toBe(race2);
        expect(motif2.source).toEqual({ made: "motif", index: 0, of: race2.source });
        expect((motif2.source as { of: unknown }).of).toBe(race2.source);
        expect(bandSegment2.segment).toEqual(bandSegment.segment!);
        expect(bandSegment2.segment!.bands[0]!.band).toBe(brass2.band!);
        expect(bandSegment2.references[0]).toBe(brass2);
        expect(styleBand2.band).toBe(race2.bands[0]!);
        expect(styleBand2.file).toBe(race2.style!.bands[0]!);
        expect(styleBand2.references[0]).toBe(race2);
    });

    test("the origin stays alive while what it made does, and is released with it", () => {
        const { race, motif } = made();
        const held = race.refCount;
        motif.release();
        expect(race.refCount).toBe(held - 1);
    });

    test("an origin loaded again since, a made object without one, and an origin that no longer has the part are named", () => {
        const { kit, race, motif, styleBand } = made();
        const { objects, blobs, refs } = capture([styleBand]);
        const saved = objects[0]![1] as unknown as SavedLoadable;
        (saved.source as { index: number }).index = 5;
        expect(() => restore(objects, blobs, refs)).toThrow("dmusic: a DirectMusic band can no longer be made from its origin (style-band)");
        expect(load(race, style(120), { "kit.dls": kit })).toBe(0);
        expect(() => capture([motif])).toThrow(CaptureRefusal);
        expect(() => capture([motif])).toThrow("dmusic: a DirectMusic segment made from an object that was loaded again since is not part of a savestate");
        const bare = internals.wrapSegment(motif.segment, "Bare") as SegmentObject;
        expect(() => capture([bare])).toThrow("dmusic: a DirectMusic segment that was not loaded from a stream, memory or a file is not part of a savestate");
    });
});

describe("dmusic objects still refused", () => {
    test("an object loaded while savestates were off has no source and is refused by name", () => {
        flags.__savestates = false;
        const kit = loaded<CollectionObject>(CLSID_DirectMusicCollection, dls(1));
        expect(kit.source).toBeNull();
        expect(() => capture([kit])).toThrow("dmusic: a DLS collection that was not loaded from a stream, memory or a file is not part of a savestate");
    });
});

describe("dmusic source sizes", () => {
    test("fifty objects cost a few hundred bytes each in the section; equal sources are stored once and a second save writes none", async () => {
        const kits = [1, 2, 3, 4, 5].map(i => dls(i, 16000));
        const objects: LoadableObject[] = [];
        for (let i = 0; i < 10; i++) objects.push(loaded<CollectionObject>(CLSID_DirectMusicCollection, kits[i % 5]!));
        for (let i = 0; i < 10; i++) objects.push(loaded<BandObject>(CLSID_DirectMusicBand, band(`Band${i % 5}`), { "kit.dls": objects[i]! }, DMUS_S_PARTIALLOAD));
        for (let i = 0; i < 10; i++) objects.push(loaded<StyleObject>(CLSID_DirectMusicStyle, style(90 + (i % 5)), { "kit.dls": objects[i]! }));
        for (let i = 0; i < 20; i++) {
            objects.push(loaded<SegmentObject>(CLSID_DirectMusicSegment, segment(`Song${i % 10}`), { "Race.sty": objects[20 + (i % 10)]!, "kit.dls": objects[i % 10]! }));
        }
        expect(objects.length).toBe(50);
        const sourceBytes = objects.reduce((n, o) => n + (o.source as { bytes: Uint8Array }).bytes.length, 0);
        const reg = new ParticipantRegistry();
        reg.add({ id: "dmusic", version: 4, capture: (ctx) => objects.map((o, i) => ctx.ref(o, `object ${i}`)), restore: () => undefined });
        const target = {
            guestMemory: () => new Uint8Array(RAM_CHUNK_SIZE), overlayState: () => "", gameId: () => "g", touchedModules: () => [],
            compatibilityKey: () => ({ buildSha: "a", contentHash: "b", configHash: "c", bootLayout: "d", participants: {} }),
        };
        const store = new MemoryChunkStore();
        const first = await captureSession(target, new Set(), () => undefined, reg);
        const section = encodeValue(capture(objects).objects as unknown as SaveValue);
        const sectionBytes = section.json.length + section.blobs.reduce((n, b) => n + b.length, 0);
        const blobBytes = first.blobs.reduce((n, [, length]) => n + length, 0);
        const written = first.pending.size;
        await writeRamChunks(first.pending, store);
        const stored = [...store.chunks.values()].reduce((n, b) => n + b.length, 0);
        const second = await captureSession(target, new Set(await store.list()), () => undefined, reg);
        expect(section.blobs.length).toBe(0);
        expect(sectionBytes / 50).toBeLessThan(700);
        expect(first.blobs.length).toBe(25);
        expect(written).toBe(25);
        expect(blobBytes).toBeLessThan(sourceBytes * 0.55);
        expect(stored).toBeLessThan(blobBytes);
        expect(second.pending.size).toBe(0);
        expect(second.bytes.length).toBe(first.bytes.length);
        if (process.env.DMUSIC_SIZES) console.log(JSON.stringify({ sourceBytes, sectionBytes, perObject: Math.round(sectionBytes / 50), blobs: first.blobs.length, blobBytes, stored, stateBytes: first.bytes.length }));
    });
});
