import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeValue, encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { Msacm32, MSACM32_FIELDS, type Msacm32State } from "../../src/worker/modules/msacm32";
import { savestateParticipants } from "../../src/worker/savestate/participant";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALHANDLE = 5;
const ACMSTREAMHEADER_SIZE = 84;
const STREAM_HANDLE_BASE = 0xacd30000;
const FIXTURES = join(import.meta.dir, "fixtures", "adpcm");

const SRC_FMT = 0x1000;
const DST_FMT = 0x1100;
const HAS_PTR = 0x1200;
const HDR = 0x1300;
const SRC_DATA = 0x2000;
const DST_DATA = 0x12000;
const DST_ROOM = 0x20000;

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};
const throughCodec = (s: Msacm32State) => decodeValue(encodeValue(s as unknown as SaveValue)) as unknown as Msacm32State;

type Internals = Record<string, unknown>;

class Guest {
    readonly acm = new Msacm32() as Msacm32 & Internals;
    readonly mem: Uint8Array;
    readonly view: DataView;

    constructor(ram?: Uint8Array) {
        this.acm.initialize({} as never);
        this.mem = ram ? ram.slice() : new Uint8Array(0x40000);
        this.view = new DataView(this.mem.buffer);
    }

    call(name: string, ...args: number[]): number {
        return (this.acm.exports[name] as ThunkImplementation)({} as never, this.mem, args) as number;
    }

    pcm(at: number, channels: number, rate: number, bits = 16): void {
        this.mem.fill(0, at, at + 18);
        this.view.setUint16(at, 1, true);
        this.view.setUint16(at + 2, channels, true);
        this.view.setUint32(at + 4, rate, true);
        this.view.setUint32(at + 8, rate * channels * (bits >> 3), true);
        this.view.setUint16(at + 12, channels * (bits >> 3), true);
        this.view.setUint16(at + 14, bits, true);
    }

    open(): number {
        expect(this.call("acmStreamOpen", HAS_PTR, 0, SRC_FMT, DST_FMT, 0, 0, 0, 0)).toBe(MMSYSERR_NOERROR);
        return this.view.getUint32(HAS_PTR, true);
    }

    openFixture(name: string): { has: number; wav: Wav } {
        const wav = readWav(name);
        this.mem.set(wav.fmt, SRC_FMT);
        this.pcm(DST_FMT, wav.channels, wav.rate);
        this.mem.set(wav.data, SRC_DATA);
        return { has: this.open(), wav };
    }

    prepare(has: number): void {
        this.mem.fill(0, HDR, HDR + ACMSTREAMHEADER_SIZE);
        this.view.setUint32(HDR, ACMSTREAMHEADER_SIZE, true);
        expect(this.call("acmStreamPrepareHeader", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
    }

    convert(has: number, srcAt: number, srcBytes: number): { out: number[]; srcUsed: number } {
        this.view.setUint32(HDR + 12, srcAt, true);
        this.view.setUint32(HDR + 16, srcBytes, true);
        this.view.setUint32(HDR + 28, DST_DATA, true);
        this.view.setUint32(HDR + 32, DST_ROOM, true);
        expect(this.call("acmStreamConvert", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
        const used = this.view.getUint32(HDR + 36, true);
        return { out: [...this.mem.subarray(DST_DATA, DST_DATA + used)], srcUsed: this.view.getUint32(HDR + 20, true) };
    }
}

interface Wav { fmt: Uint8Array; data: Uint8Array; channels: number; rate: number; blockAlign: number }

function readWav(name: string): Wav {
    const buf = new Uint8Array(readFileSync(join(FIXTURES, name)));
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = 12;
    let fmt: Uint8Array | null = null;
    let data: Uint8Array | null = null;
    while (p + 8 <= buf.length) {
        const id = String.fromCharCode(buf[p]!, buf[p + 1]!, buf[p + 2]!, buf[p + 3]!);
        const size = v.getUint32(p + 4, true);
        if (id === "fmt ") fmt = buf.subarray(p + 8, p + 8 + size);
        if (id === "data") data = buf.subarray(p + 8, p + 8 + size);
        p += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error(`${name}: missing fmt/data chunk`);
    const fv = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
    return { fmt, data, channels: fv.getUint16(2, true), rate: fv.getUint32(4, true), blockAlign: fv.getUint16(12, true) };
}

function reference(name: string): number[] {
    return [...new Uint8Array(readFileSync(join(FIXTURES, name)))];
}

function used(): { guest: Guest; ima: number; ms: number; pcm: number } {
    const guest = new Guest();
    const closed = guest.openFixture("ima_mono.wav").has;
    const ima = guest.openFixture("ima_st.wav").has;
    const ms = guest.openFixture("ms_st.wav").has;
    guest.pcm(SRC_FMT, 2, 44100, 16);
    guest.pcm(DST_FMT, 1, 22050, 8);
    const pcm = guest.open();
    expect(guest.call("acmStreamClose", closed, 0)).toBe(MMSYSERR_NOERROR);
    return { guest, ima, ms, pcm };
}

describe("msacm32 participant", () => {
    test("every instance field has a policy", () => {
        expect(Object.keys(new Msacm32()).sort()).toEqual(Object.keys(MSACM32_FIELDS).sort());
    });

    test("an idle module saves only its handle counter", () => {
        const idle = new Guest().acm.captureSavestate();
        expect(idle).toEqual({ nextStreamHandle: STREAM_HANDLE_BASE, streams: [] });
        const fresh = new Guest();
        fresh.acm.restoreSavestate(throughCodec(idle));
        expect(bytes(fresh.acm.captureSavestate())).toBe(bytes(idle));
    });

    test("capture → codec → restore → capture is byte-identical in a fresh module", () => {
        const { guest, ima, ms, pcm } = used();
        const first = guest.acm.captureSavestate();
        expect(first.nextStreamHandle).toBe(STREAM_HANDLE_BASE + 4);
        expect(first.streams.map(s => [s.handle, s.src.formatTag, s.dst.formatTag])).toEqual([[ima, 0x11, 1], [ms, 2, 1], [pcm, 1, 1]]);
        expect(first.streams[1]!.src.coefs).toBeInstanceOf(Int16Array);
        expect(first.streams[0]!.src.coefs).toBeNull();
        const fresh = new Guest();
        fresh.openFixture("ms_mono.wav");
        fresh.acm.restoreSavestate(throughCodec(first));
        expect(bytes(fresh.acm.captureSavestate())).toBe(bytes(first));
        expect([...(fresh.acm.streams as Map<number, unknown>).keys()]).toEqual([ima, ms, pcm]);
    });

    test("the capture does not alias the live streams", () => {
        const { guest, ms } = used();
        const saved = guest.acm.captureSavestate();
        const before = bytes(saved);
        const live = (guest.acm.streams as Map<number, { src: { coefs: Int16Array; channels: number } }>).get(ms)!;
        live.src.coefs[0] = 1234;
        live.src.channels = 7;
        expect(bytes(saved)).toBe(before);
        const fresh = new Guest();
        fresh.acm.restoreSavestate(saved);
        saved.streams[1]!.src.coefs![1] = 4321;
        expect(bytes(fresh.acm.captureSavestate())).toBe(before);
    });

    test("every saved field reaches the capture and survives a restore", () => {
        const base = used().guest.acm.captureSavestate();
        const one = base.streams[0]!;
        const values: Msacm32State = {
            nextStreamHandle: STREAM_HANDLE_BASE + 0x40,
            streams: [{ handle: STREAM_HANDLE_BASE + 2, src: one.src, dst: one.dst }],
        };
        expect(Object.keys(values).sort()).toEqual(Object.keys(base).sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof Msacm32State, unknown]>) {
            expect({ field, same: bytes(value) === bytes(base[field]) }).toEqual({ field, same: false });
            const fresh = new Guest();
            fresh.acm.restoreSavestate(throughCodec({ ...base, [field]: value } as Msacm32State));
            expect({ field, value: bytes(fresh.acm.captureSavestate()[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("every field of a saved format survives a restore", () => {
        const base = used().guest.acm.captureSavestate();
        const formats: Record<string, [number, unknown]> = {
            formatTag: [1, 0x11], channels: [1, 1], samplesPerSec: [1, 8000], bitsPerSample: [2, 8], blockAlign: [1, 300],
            samplesPerBlock: [1, 77], coefs: [1, new Int16Array([1, 2, 3, 4])],
        };
        expect(Object.keys(formats).sort()).toEqual(Object.keys(base.streams[1]!.src).sort());
        for (const [field, [stream, value]] of Object.entries(formats)) {
            const changed = structuredClone(base);
            (changed.streams[stream]!.src as unknown as Record<string, unknown>)[field] = value;
            expect({ field, same: bytes(changed) === bytes(base) }).toEqual({ field, same: false });
            const fresh = new Guest();
            fresh.acm.restoreSavestate(throughCodec(changed));
            expect({ field, value: bytes(fresh.acm.captureSavestate()) }).toEqual({ field, value: bytes(changed) });
        }
    });

    for (const [wavName, refName] of [
        ["ms_mono.wav", "ms_mono.ref"], ["ms_st.wav", "ms_st.ref"], ["ima_mono.wav", "ima_mono.ref"], ["ima_st.wav", "ima_st.ref"],
    ] as const) {
        test(`${wavName}: a stream saved halfway decodes the rest identically after a restore`, () => {
            const a = new Guest();
            a.openFixture("ima_mono.wav");
            const { has, wav } = a.openFixture(wavName);
            const blocks = Math.floor(wav.data.length / wav.blockAlign);
            expect(blocks).toBeGreaterThanOrEqual(2);
            const half = Math.floor(blocks / 2) * wav.blockAlign;
            a.prepare(has);
            const head = a.convert(has, SRC_DATA, half);
            expect(head.srcUsed).toBe(half);

            const saved = throughCodec(a.acm.captureSavestate());
            const b = new Guest(a.mem);
            expect(b.call("acmStreamConvert", has, HDR, 0)).toBe(MMSYSERR_INVALHANDLE);
            b.acm.restoreSavestate(saved);

            const restA = a.convert(has, SRC_DATA + half, wav.data.length - half);
            const restB = b.convert(has, SRC_DATA + half, wav.data.length - half);
            expect(restB.out.length).toBeGreaterThan(0);
            expect(restB).toEqual(restA);
            expect([...head.out, ...restB.out]).toEqual(reference(refName));
            expect(b.call("acmStreamUnprepareHeader", has, HDR, 0)).toBe(MMSYSERR_NOERROR);
            expect(b.call("acmStreamClose", has, 0)).toBe(MMSYSERR_NOERROR);
            expect(b.call("acmStreamClose", has, 0)).toBe(MMSYSERR_INVALHANDLE);
        });
    }

    test("a PCM resampling stream saved halfway converts the rest identically after a restore", () => {
        const a = new Guest();
        a.pcm(SRC_FMT, 2, 44100, 16);
        a.pcm(DST_FMT, 1, 11025, 8);
        const has = a.open();
        const total = 4096;
        for (let i = 0; i < total; i++) a.mem[SRC_DATA + i] = (i * 37 + (i >> 3)) & 0xff;
        a.prepare(has);
        const head = a.convert(has, SRC_DATA, total / 2);
        const b = new Guest(a.mem);
        b.acm.restoreSavestate(throughCodec(a.acm.captureSavestate()));
        const restA = a.convert(has, SRC_DATA + total / 2, total / 2);
        const restB = b.convert(has, SRC_DATA + total / 2, total / 2);
        expect(head.out.length).toBe(total / 2 / 16);
        expect(restB.out.length).toBe(total / 2 / 16);
        expect(restB).toEqual(restA);
    });

    test("after a restore a new stream opens on the saved counter and converts", () => {
        const { guest, ima, ms, pcm } = used();
        const fresh = new Guest();
        fresh.acm.restoreSavestate(throughCodec(guest.acm.captureSavestate()));
        const { has, wav } = fresh.openFixture("ima_mono.wav");
        expect(has).toBe(STREAM_HANDLE_BASE + 4);
        expect([ima, ms, pcm]).not.toContain(has);
        fresh.prepare(has);
        expect(fresh.convert(has, SRC_DATA, wav.data.length).out).toEqual(reference("ima_mono.ref"));
        expect(guest.openFixture("ima_mono.wav").has).toBe(has);
    });

    test("without the saved counter a fresh module would hand out a live handle again", () => {
        const { guest, ima } = used();
        const saved = guest.acm.captureSavestate();
        const fresh = new Guest();
        fresh.acm.restoreSavestate({ ...saved, nextStreamHandle: STREAM_HANDLE_BASE + 4 });
        expect(fresh.openFixture("ima_mono.wav").has).toBe(STREAM_HANDLE_BASE + 4);
        const stale = new Guest();
        stale.openFixture("ima_mono.wav");
        expect(stale.openFixture("ima_mono.wav").has).toBe(ima);
    });

    test("a restore refuses a saved stream it cannot run, by name, and leaves the module untouched", () => {
        const { guest } = used();
        const good = guest.acm.captureSavestate();
        const target = new Guest();
        const kept = target.openFixture("ima_mono.wav").has;
        const before = bytes(target.acm.captureSavestate());

        const twice = structuredClone(good);
        twice.streams.push(structuredClone(twice.streams[0]!));
        expect(() => target.acm.restoreSavestate(twice))
            .toThrow("msacm32: saved conversion stream 0xacd30001 (IMA ADPCM 4bit/2ch/11025Hz → PCM 16bit/2ch/11025Hz) does not fit the saved handle counter 0xacd30004");

        const ahead = structuredClone(good);
        ahead.nextStreamHandle = STREAM_HANDLE_BASE + 3;
        expect(() => target.acm.restoreSavestate(ahead))
            .toThrow("msacm32: saved conversion stream 0xacd30003 (PCM 16bit/2ch/44100Hz → PCM 8bit/1ch/22050Hz) does not fit the saved handle counter 0xacd30003");

        const foreign = structuredClone(good);
        foreign.streams[1]!.src.formatTag = 0x55;
        expect(() => target.acm.restoreSavestate(foreign))
            .toThrow("msacm32: saved conversion stream 0xacd30002 (tag 0x55 4bit/2ch/11025Hz → PCM 16bit/2ch/11025Hz) is not a conversion this build performs");

        const encode = structuredClone(good);
        encode.streams[2]!.dst = structuredClone(encode.streams[0]!.src);
        expect(() => target.acm.restoreSavestate(encode))
            .toThrow("(PCM 16bit/2ch/44100Hz → IMA ADPCM 4bit/2ch/11025Hz) is not a conversion this build performs");

        expect(bytes(target.acm.captureSavestate())).toBe(before);
        expect([...(target.acm.streams as Map<number, unknown>).keys()]).toEqual([kept]);
        expect(() => target.acm.restoreSavestate(structuredClone(good))).not.toThrow();
        expect(bytes(target.acm.captureSavestate())).toBe(bytes(good));
    });

    test("the registered participant covers msacm32, captures open streams and has a pinned schema", () => {
        const { guest } = used();
        const undo = guest.acm.registerSavestate();
        try {
            expect(savestateParticipants.coveredModules().has("msacm32")).toBe(true);
            expect(savestateParticipants.schemas().msacm32).toEqual({ version: 1, schemaHash: "c39672b19cccb835" });
            const participant = savestateParticipants.all().find(p => p.id === "msacm32")!;
            const saved = participant.capture({} as never);
            expect(bytes(saved)).toBe(bytes(guest.acm.captureSavestate()));
            const fresh = new Guest();
            const undoFresh = fresh.acm.registerSavestate();
            try {
                savestateParticipants.all().find(p => p.id === "msacm32")!.restore(decodeValue(encodeValue(saved)), {} as never);
            } finally {
                undoFresh();
            }
            expect(bytes(fresh.acm.captureSavestate())).toBe(bytes(saved));
        } finally {
            undo();
        }
        expect(savestateParticipants.coveredModules().has("msacm32")).toBe(false);
    });
});
