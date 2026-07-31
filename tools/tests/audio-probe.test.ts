// Unit tests for the container-level audio probe (packages/formats/src/audio).
// Pure: every fixture is synthesized in memory — Ogg (Vorbis/Opus/FLAC-in-Ogg,
// with real page CRCs), MPEG audio (Xing/LAME/VBRI/CBR), native FLAC and RIFF/WAVE.
// Also asserts the probe stays out of the audio payload: a >1 MB stream must be
// answered from a few KB at each end.

import { describe, it, expect } from "bun:test";
import { BufferSource, type RandomAccessSource } from "@bottleship/formats/unpack/source";
import { probeAudioStream } from "@bottleship/formats/audio";

// --- helpers ----------------------------------------------------------------

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

function ascii(s: string): Uint8Array {
    return enc.encode(s);
}

function u32leBytes(v: number): Uint8Array {
    return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

function u32beBytes(v: number): Uint8Array {
    return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

/** Byte-accounting wrapper: proves the fast path never touches the payload. */
class CountingSource implements RandomAccessSource {
    readonly size: number;
    bytesRead = 0;
    constructor(private readonly data: Uint8Array) {
        this.size = data.length;
    }
    readRangeSync(start: number, end: number): Uint8Array {
        const s = Math.max(0, Math.min(start, this.size));
        const e = Math.max(s, Math.min(end, this.size));
        this.bytesRead += e - s;
        return this.data.subarray(s, e);
    }
}

// --- Ogg fixtures -----------------------------------------------------------

const oggCrcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
        t[i] = r >>> 0;
    }
    return t;
})();

/** Builds one page carrying whole packets, with a real Ogg CRC. */
function oggPage(opts: { packets: Uint8Array[]; granule: number; serial: number; seq: number; flags?: number }): Uint8Array {
    const laces: number[] = [];
    for (const packet of opts.packets) {
        let left = packet.length;
        while (left >= 255) {
            laces.push(255);
            left -= 255;
        }
        laces.push(left); // a lace < 255 terminates the packet
    }
    const body = concat(...opts.packets);

    const page = new Uint8Array(27 + laces.length + body.length);
    page.set(ascii("OggS"), 0);
    page[4] = 0;
    page[5] = opts.flags ?? 0;
    if (opts.granule < 0) {
        page.fill(0xff, 6, 14);
    } else {
        page.set(u32leBytes(opts.granule >>> 0), 6);
        page.set(u32leBytes(Math.floor(opts.granule / 0x100000000)), 10);
    }
    page.set(u32leBytes(opts.serial), 14);
    page.set(u32leBytes(opts.seq), 18);
    page[26] = laces.length;
    page.set(laces, 27);
    page.set(body, 27 + laces.length);

    let crc = 0;
    for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ oggCrcTable[((crc >>> 24) ^ page[i]!) & 0xff]!) >>> 0;
    page.set(u32leBytes(crc), 22);
    return page;
}

function vorbisIdHeader(channels: number, sampleRate: number): Uint8Array {
    const b = new Uint8Array(30);
    b[0] = 0x01;
    b.set(ascii("vorbis"), 1);
    b[11] = channels;
    b.set(u32leBytes(sampleRate), 12);
    b[29] = 0x01; // framing bit
    return b;
}

/** A minimal but structurally honest Vorbis stream: 3 header packets, then audio pages. */
function vorbisStream(opts: {
    channels?: number;
    sampleRate?: number;
    granules: number[];
    serial?: number;
    headerGranule?: number;
    audioBodySize?: number;
    lastFlags?: number;
}): Uint8Array {
    const serial = opts.serial ?? 0x1234abcd;
    const pages: Uint8Array[] = [
        oggPage({
            packets: [vorbisIdHeader(opts.channels ?? 2, opts.sampleRate ?? 44100)],
            granule: 0,
            serial,
            seq: 0,
            flags: 0x02,
        }),
        // Comment + setup packets both finish here, so this is the last header page.
        oggPage({ packets: [new Uint8Array(40), new Uint8Array(60)], granule: opts.headerGranule ?? 0, serial, seq: 1 }),
    ];
    opts.granules.forEach((g, i) => {
        const last = i === opts.granules.length - 1;
        pages.push(
            oggPage({
                packets: [new Uint8Array(opts.audioBodySize ?? 200).fill(0x5a)],
                granule: g,
                serial,
                seq: 2 + i,
                flags: last ? (opts.lastFlags ?? 0x04) : 0,
            }),
        );
    });
    return concat(...pages);
}

// --- FLAC fixtures ----------------------------------------------------------

function streamInfoBlock(sampleRate: number, channels: number, bitsPerSample: number, totalSamples: number): Uint8Array {
    const b = new Uint8Array(34);
    b[10] = (sampleRate >>> 12) & 0xff;
    b[11] = (sampleRate >>> 4) & 0xff;
    b[12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | (((bitsPerSample - 1) >> 4) & 0x01);
    b[13] = (((bitsPerSample - 1) & 0x0f) << 4) | (Math.floor(totalSamples / 0x100000000) & 0x0f);
    b.set(u32beBytes(totalSamples >>> 0), 14);
    return b;
}

function flacFile(sampleRate: number, channels: number, totalSamples: number, prefix = new Uint8Array(0)): Uint8Array {
    return concat(
        prefix,
        ascii("fLaC"),
        new Uint8Array([0x80, 0x00, 0x00, 34]), // last-block flag + STREAMINFO type, 24-bit length
        streamInfoBlock(sampleRate, channels, 16, totalSamples),
        new Uint8Array(64),
    );
}

function id3v2(payloadSize: number): Uint8Array {
    const b = new Uint8Array(10 + payloadSize);
    b.set(ascii("ID3"), 0);
    b[3] = 3;
    b[6] = (payloadSize >>> 21) & 0x7f;
    b[7] = (payloadSize >>> 14) & 0x7f;
    b[8] = (payloadSize >>> 7) & 0x7f;
    b[9] = payloadSize & 0x7f;
    return b;
}

// --- MP3 fixtures -----------------------------------------------------------

const MP3_FRAME_SIZE = 417; // MPEG1 Layer III, 44.1 kHz, 128 kbps, no padding

function mp3Frame(fill = 0): Uint8Array {
    const f = new Uint8Array(MP3_FRAME_SIZE).fill(fill);
    f.set([0xff, 0xfb, 0x90, 0x00], 0);
    return f;
}

function xingFrame(frames: number, lame?: { delay: number; padding: number }): Uint8Array {
    const f = mp3Frame();
    const xing = 4 + 32; // MPEG1 stereo side info
    f.set(ascii("Xing"), xing);
    f.set(u32beBytes(0x0001), xing + 4); // frame count present
    f.set(u32beBytes(frames), xing + 8);
    if (lame) {
        const l = xing + 12;
        f.set(ascii("LAME3.99r"), l);
        f[l + 21] = (lame.delay >> 4) & 0xff;
        f[l + 22] = ((lame.delay & 0x0f) << 4) | ((lame.padding >> 8) & 0x0f);
        f[l + 23] = lame.padding & 0xff;
    }
    return f;
}

// --- WAV fixtures -----------------------------------------------------------

function chunk(id: string, body: Uint8Array): Uint8Array {
    const pad = body.length & 1;
    return concat(ascii(id), u32leBytes(body.length), body, new Uint8Array(pad));
}

function fmtChunk(opts: { tag?: number; channels: number; sampleRate: number; bits: number; byteRate?: number; extensible?: boolean }): Uint8Array {
    const tag = opts.extensible ? 0xfffe : (opts.tag ?? 1);
    const blockAlign = (opts.channels * opts.bits) / 8;
    const byteRate = opts.byteRate ?? opts.sampleRate * blockAlign;
    const base = concat(
        new Uint8Array([tag & 0xff, tag >> 8, opts.channels & 0xff, opts.channels >> 8]),
        u32leBytes(opts.sampleRate),
        u32leBytes(byteRate),
        new Uint8Array([blockAlign & 0xff, blockAlign >> 8, opts.bits & 0xff, opts.bits >> 8]),
    );
    if (!opts.extensible) return chunk("fmt ", base);
    const ext = new Uint8Array(24);
    ext[0] = 22; // cbSize
    ext.set([opts.bits & 0xff, opts.bits >> 8], 2);
    ext.set(u32leBytes(3), 4); // channel mask
    ext.set([(opts.tag ?? 1) & 0xff, (opts.tag ?? 1) >> 8], 8); // SubFormat GUID head = real tag
    return chunk("fmt ", concat(base, ext));
}

function riff(...chunks: Uint8Array[]): Uint8Array {
    const body = concat(ascii("WAVE"), ...chunks);
    return concat(ascii("RIFF"), u32leBytes(body.length), body);
}

// --- tests ------------------------------------------------------------------

describe("probeAudioStream / ogg", () => {
    it("derives duration from the last page's granulepos", () => {
        const file = vorbisStream({ granules: [44100, 88200, 132300, 176400] });
        expect(probeAudioStream(new BufferSource(file))).toEqual({
            durationMs: 4000,
            sampleRate: 44100,
            channels: 2,
            format: "ogg",
        });
    });

    it("reads granulepos as 64-bit (a 32-bit read wraps past ~27 h)", () => {
        // 0x1_0000_2710 samples @ 44100 — the low word alone would report 250 ms.
        const file = vorbisStream({ granules: [0x100002710] });
        const info = probeAudioStream(new BufferSource(file))!;
        expect(info.durationMs).toBe(Math.round((0x100002710 * 1000) / 44100));
        expect(info.durationMs).toBeGreaterThan(97_000_000);
    });

    it("subtracts a non-zero start granule", () => {
        const file = vorbisStream({ headerGranule: 44100, granules: [44100 * 5] });
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(4000);
    });

    it("ignores an 'OggS' that is really audio payload", () => {
        // A page whose body contains the capture pattern: scanning back finds it first,
        // and only the page CRC tells it apart from a real page.
        const serial = 0x777;
        const body = new Uint8Array(400).fill(0x11);
        body.set(ascii("OggS"), 100);
        body[104] = 0; // version
        body.set(u32leBytes(44100 * 99), 106); // a granule that would be believed
        body.set(u32leBytes(serial), 114); // and the right serial number
        body[126] = 1; // segment count
        const file = concat(
            vorbisStream({ granules: [44100], serial }),
            oggPage({ packets: [body], granule: 88200, serial, seq: 99, flags: 0x04 }),
        );
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(2000);
    });

    it("skips a trailing page that completes no packet (granule -1)", () => {
        const serial = 0x999;
        const file = concat(
            vorbisStream({ granules: [44100, 88200], serial }),
            oggPage({ packets: [new Uint8Array(300).fill(7)], granule: -1, serial, seq: 50, flags: 0x04 }),
        );
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(2000);
    });

    it("ignores pages of a foreign serial number", () => {
        const file = concat(
            vorbisStream({ granules: [44100 * 3], serial: 0xaaaa }),
            oggPage({ packets: [new Uint8Array(120).fill(3)], granule: 99999999, serial: 0xbbbb, seq: 0, flags: 0x04 }),
        );
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(3000);
    });

    it("reports mono and non-CD sample rates", () => {
        const file = vorbisStream({ channels: 1, sampleRate: 22050, granules: [22050 * 7] });
        expect(probeAudioStream(new BufferSource(file))).toMatchObject({ durationMs: 7000, sampleRate: 22050, channels: 1 });
    });

    it("handles Opus (48 kHz granules, pre-skip removed)", () => {
        const serial = 0x2222;
        const head = new Uint8Array(19);
        head.set(ascii("OpusHead"), 0);
        head[8] = 1;
        head[9] = 2;
        head[10] = 312 & 0xff; // pre-skip
        head[11] = 312 >> 8;
        const file = concat(
            oggPage({ packets: [head], granule: 0, serial, seq: 0, flags: 0x02 }),
            oggPage({ packets: [concat(ascii("OpusTags"), new Uint8Array(8))], granule: 0, serial, seq: 1 }),
            oggPage({ packets: [new Uint8Array(200)], granule: 48000 * 3 + 312, serial, seq: 2, flags: 0x04 }),
        );
        expect(probeAudioStream(new BufferSource(file))).toEqual({
            durationMs: 3000,
            sampleRate: 48000,
            channels: 2,
            format: "ogg",
        });
    });

    it("handles FLAC-in-Ogg", () => {
        const serial = 0x3333;
        const mapping = concat(
            new Uint8Array([0x7f]),
            ascii("FLAC"),
            new Uint8Array([1, 0, 0, 1]), // version 1.0, one further header packet
            ascii("fLaC"),
            new Uint8Array([0x00, 0x00, 0x00, 34]),
            streamInfoBlock(48000, 2, 16, 48000 * 5),
        );
        const file = concat(
            oggPage({ packets: [mapping], granule: 0, serial, seq: 0, flags: 0x02 }),
            oggPage({ packets: [new Uint8Array(64)], granule: 0, serial, seq: 1 }),
            oggPage({ packets: [new Uint8Array(128)], granule: 48000 * 5, serial, seq: 2, flags: 0x04 }),
        );
        expect(probeAudioStream(new BufferSource(file))).toEqual({
            durationMs: 5000,
            sampleRate: 48000,
            channels: 2,
            format: "ogg",
        });
    });

    it("returns null for an Ogg mapping it cannot measure", () => {
        const serial = 0x4444;
        const speex = concat(ascii("Speex   "), new Uint8Array(72));
        const file = concat(
            oggPage({ packets: [speex], granule: 0, serial, seq: 0, flags: 0x02 }),
            oggPage({ packets: [new Uint8Array(100)], granule: 100000, serial, seq: 1, flags: 0x04 }),
        );
        expect(probeAudioStream(new BufferSource(file))).toBeNull();
    });

    it("measures up to the last intact page when the file is cut short", () => {
        const file = vorbisStream({ granules: [44100, 88200] });
        expect(probeAudioStream(new BufferSource(file.subarray(0, file.length - 40)))!.durationMs).toBe(1000);
        expect(probeAudioStream(new BufferSource(file.subarray(0, 20)))).toBeNull();
    });

    it("probes a multi-MB stream from a few KB at each end", () => {
        const serial = 0x5150;
        const pages: Uint8Array[] = [vorbisStream({ granules: [], serial })];
        for (let i = 0; i < 200; i++) {
            pages.push(
                oggPage({
                    packets: [new Uint8Array(8000).fill(i & 0xff)],
                    granule: 44100 * (i + 1),
                    serial,
                    seq: 2 + i,
                    flags: i === 199 ? 0x04 : 0,
                }),
            );
        }
        const file = concat(...pages);
        expect(file.length).toBeGreaterThan(1_600_000);

        const src = new CountingSource(file);
        expect(probeAudioStream(src)!.durationMs).toBe(200_000);
        expect(src.bytesRead).toBeLessThan(64 * 1024);
    });
});

describe("probeAudioStream / mp3", () => {
    it("uses the Xing frame count", () => {
        const file = concat(xingFrame(1000), mp3Frame(1), mp3Frame(2));
        expect(probeAudioStream(new BufferSource(file))).toEqual({
            durationMs: Math.round((1000 * 1152 * 1000) / 44100),
            sampleRate: 44100,
            channels: 2,
            format: "mp3",
        });
    });

    it("applies the LAME encoder delay/padding trim", () => {
        const file = concat(xingFrame(1000, { delay: 576, padding: 1000 }), mp3Frame(1), mp3Frame(2));
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(Math.round(((1000 * 1152 - 1576) * 1000) / 44100));
    });

    it("uses a VBRI frame count", () => {
        const f = mp3Frame();
        f.set(ascii("VBRI"), 36);
        f.set(u32beBytes(500), 36 + 14);
        const file = concat(f, mp3Frame(1), mp3Frame(2));
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(Math.round((500 * 1152 * 1000) / 44100));
    });

    it("falls back to CBR estimation, skipping ID3v2 and ID3v1", () => {
        const frames: Uint8Array[] = [];
        for (let i = 0; i < 100; i++) frames.push(mp3Frame(i & 0xff));
        const id3v1 = new Uint8Array(128);
        id3v1.set(ascii("TAG"), 0);
        const file = concat(id3v2(2048), ...frames, id3v1);
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(Math.round((100 * 417 * 8000) / 128000));
    });

    // APEv2 footer: magic(8) version(8) size(12) item count(16) FLAGS(20) reserved(24). Both
    // cases are here because the flags field was being read at +16 — the item count — so
    // `hasHeader` was always false and the header-present case counted 32 bytes of tag as
    // audio. A fixture that writes the flags at +16 passes either way.
    const apeTag = (items: number, flags: number) => {
        const footer = new Uint8Array(32);
        footer.set(ascii("APETAGEX"), 0);
        footer.set(u32leBytes(2000), 8);
        footer.set(u32leBytes(items + 32), 12); // items + footer
        footer.set(u32leBytes(3), 16);          // item COUNT, not flags
        footer.set(u32leBytes(flags), 20);
        return footer;
    };

    it("excludes a header-less APEv2 tag from the CBR byte range", () => {
        const frames: Uint8Array[] = [];
        for (let i = 0; i < 50; i++) frames.push(mp3Frame(i & 0xff));
        const apeItems = new Uint8Array(64);
        const file = concat(...frames, apeItems, apeTag(apeItems.length, 0));
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(Math.round((50 * 417 * 8000) / 128000));
    });

    it("excludes the 32-byte APEv2 HEADER too when the flags say there is one", () => {
        const frames: Uint8Array[] = [];
        for (let i = 0; i < 50; i++) frames.push(mp3Frame(i & 0xff));
        const apeHeader = new Uint8Array(32);
        const apeItems = new Uint8Array(64);
        const file = concat(...frames, apeHeader, apeItems, apeTag(apeItems.length, 0x80000000));
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(Math.round((50 * 417 * 8000) / 128000));
    });

    it("falls back to the CBR estimate when Xing declares zero frames", () => {
        // The frame-count flag is set and the count is 0: taking that literally reports 0 ms.
        const frames: Uint8Array[] = [];
        for (let i = 0; i < 50; i++) frames.push(mp3Frame(i & 0xff));
        const xing = 4 + 32; // MPEG1 stereo side info
        frames[0]!.set(ascii("Xing"), xing);
        frames[0]!.set(u32beBytes(0x0001), xing + 4);
        frames[0]!.set(u32beBytes(0), xing + 8);
        const file = concat(...frames);
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(Math.round((50 * 417 * 8000) / 128000));
    });

    it("reads MPEG-2 sample rate and samples-per-frame", () => {
        // 0xFF 0xF3: MPEG2, Layer III; 0x30: 24 kbps, 22.05 kHz; 0xC0: mono.
        const f = new Uint8Array(1000);
        f.set([0xff, 0xf3, 0x30, 0xc0], 0);
        const frameSize = Math.floor((576 / 8) * (24000 / 22050)); // 78
        f.set([0xff, 0xf3, 0x30, 0xc0], frameSize);
        const xing = 4 + 9; // MPEG2 mono side info
        f.set(ascii("Xing"), xing);
        f.set(u32beBytes(0x0001), xing + 4);
        f.set(u32beBytes(300), xing + 8);
        const info = probeAudioStream(new BufferSource(f))!;
        expect(info.sampleRate).toBe(22050);
        expect(info.channels).toBe(1);
        expect(info.durationMs).toBe(Math.round((300 * 576 * 1000) / 22050));
    });

    it("returns null when no valid frame is present", () => {
        expect(probeAudioStream(new BufferSource(concat(new Uint8Array([0xff, 0xe0]), new Uint8Array(4096))))).toBeNull();
    });
});

describe("probeAudioStream / flac", () => {
    it("uses STREAMINFO total samples", () => {
        expect(probeAudioStream(new BufferSource(flacFile(44100, 2, 4_410_000)))).toEqual({
            durationMs: 100_000,
            sampleRate: 44100,
            channels: 2,
            format: "flac",
        });
    });

    it("reads the 36-bit sample count past 2^32", () => {
        const samples = 0x1_0000_0000 + 44100;
        expect(probeAudioStream(new BufferSource(flacFile(44100, 2, samples)))!.durationMs).toBe(
            Math.round((samples * 1000) / 44100),
        );
    });

    it("sees past a prepended ID3v2 tag", () => {
        const info = probeAudioStream(new BufferSource(flacFile(48000, 1, 96000, id3v2(30))))!;
        expect(info).toMatchObject({ durationMs: 2000, sampleRate: 48000, channels: 1, format: "flac" });
    });

    it("returns null when the total sample count is unknown", () => {
        expect(probeAudioStream(new BufferSource(flacFile(44100, 2, 0)))).toBeNull();
    });
});

describe("probeAudioStream / wav", () => {
    it("derives duration from data size over byte rate", () => {
        const file = riff(fmtChunk({ channels: 2, sampleRate: 44100, bits: 16 }), chunk("data", new Uint8Array(176400)));
        expect(probeAudioStream(new BufferSource(file))).toEqual({
            durationMs: 1000,
            sampleRate: 44100,
            channels: 2,
            format: "wav",
        });
    });

    it("walks past odd-sized chunks (word alignment)", () => {
        const file = riff(
            chunk("LIST", ascii("odd")),
            fmtChunk({ channels: 1, sampleRate: 22050, bits: 8 }),
            chunk("data", new Uint8Array(11025)),
        );
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(500);
    });

    it("resolves WAVE_FORMAT_EXTENSIBLE to its SubFormat tag", () => {
        const file = riff(
            fmtChunk({ channels: 2, sampleRate: 48000, bits: 24, extensible: true }),
            chunk("data", new Uint8Array(48000 * 6)),
        );
        expect(probeAudioStream(new BufferSource(file))).toMatchObject({ durationMs: 1000, sampleRate: 48000, channels: 2 });
    });

    it("prefers the fact chunk for compressed payloads", () => {
        const file = riff(
            fmtChunk({ tag: 0x0011, channels: 1, sampleRate: 22050, bits: 4, byteRate: 11000 }),
            chunk("fact", u32leBytes(44100)),
            chunk("data", new Uint8Array(5000)),
        );
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(2000);
    });

    it("clamps a data size that runs past EOF", () => {
        const file = riff(fmtChunk({ channels: 2, sampleRate: 44100, bits: 16 }), chunk("data", new Uint8Array(88200)));
        const dataSizeField = file.length - 88200 - 4;
        file.set(new Uint8Array([0xff, 0xff, 0xff, 0xff]), dataSizeField);
        expect(probeAudioStream(new BufferSource(file))!.durationMs).toBe(500);
    });

    it("returns null without a data chunk", () => {
        expect(probeAudioStream(new BufferSource(riff(fmtChunk({ channels: 2, sampleRate: 44100, bits: 16 }))))).toBeNull();
    });
});

describe("probeAudioStream / dispatch", () => {
    it("returns null instead of throwing on junk, empty and truncated input", () => {
        expect(probeAudioStream(new BufferSource(new Uint8Array(0)))).toBeNull();
        expect(probeAudioStream(new BufferSource(new Uint8Array(4)))).toBeNull();
        expect(probeAudioStream(new BufferSource(ascii("not audio at all, just text")))).toBeNull();
        expect(probeAudioStream(new BufferSource(ascii("OggS")))).toBeNull();
        expect(probeAudioStream(new BufferSource(concat(ascii("RIFF"), new Uint8Array(8))))).toBeNull();
        const noise = new Uint8Array(4096);
        for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 11) & 0xff;
        expect(() => probeAudioStream(new BufferSource(noise))).not.toThrow();
    });

    it("sniffs the container rather than trusting an extension", () => {
        expect(probeAudioStream(new BufferSource(flacFile(44100, 2, 44100)))!.format).toBe("flac");
        expect(probeAudioStream(new BufferSource(vorbisStream({ granules: [44100] })))!.format).toBe("ogg");
        expect(probeAudioStream(new BufferSource(concat(xingFrame(10), mp3Frame(1))))!.format).toBe("mp3");
    });
});
