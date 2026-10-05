// Unit tests for the Matroska/WebM demuxer (packages/formats/src/matroska). Pure unit: the
// fixtures are built here by a tiny EBML muxer, so every case — including the ones a real file
// cannot produce on demand (EBML/fixed lacing, ContentEncryption, an unknown-size Cluster) — is
// constructible, and a wrong parse shows up as a wrong VALUE rather than a silent zero.
//
// The real-file cross-check (1920x1080 VP8 + Vorbis, keyframe flags vs the VP8 frame tag) lives
// in tools/tests/matroska-real.smoke.ts, which needs the game assets on disk.

import { describe, it, expect } from "bun:test";
import { BufferSource } from "@bottleship/formats/unpack/source";
import {
    parseMatroska, readFrames, assertDecodable, isMatroska, MatroskaError,
} from "../../packages/formats/src/matroska";

/* ── minimal EBML muxer (test-only) ─────────────────────────────────────── */

function idBytes(id: number): number[] {
    const out: number[] = [];
    let v = id;
    while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256); }
    return out;
}

/** Size vint, always emitted in the 8-byte form for simplicity. */
function sizeBytes(size: number): number[] {
    const out = [0x01];
    for (let i = 6; i >= 0; i--) out.push(Math.floor(size / Math.pow(256, i)) & 0xff);
    return out;
}

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function el(id: number, payload: number[] | Uint8Array): number[] {
    const body = Array.from(payload);
    return [...idBytes(id), ...sizeBytes(body.length), ...body];
}

function elUnknownSize(id: number, payload: number[]): number[] {
    return [...idBytes(id), ...UNKNOWN_SIZE, ...payload];
}

function uint(value: number, width = 1): number[] {
    const out: number[] = [];
    for (let i = width - 1; i >= 0; i--) out.push(Math.floor(value / Math.pow(256, i)) & 0xff);
    return out;
}

function f64(value: number): number[] {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value);
    return Array.from(b);
}

function str(s: string): number[] {
    return Array.from(new TextEncoder().encode(s));
}

const ID = {
    EBML: 0x1a45dfa3, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
    Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
    Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86,
    CodecPrivate: 0x63a2, DefaultDuration: 0x23e383, FlagLacing: 0x9c,
    Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
    Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
    ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentCompression: 0x5034, ContentEncryption: 0x5035,
    Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
    BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb,
    Void: 0xec,
};

interface BlockSpec {
    track: number;
    relative: number;
    keyframe?: boolean;
    invisible?: boolean;
    /** 0 none, 1 Xiph, 2 fixed, 3 EBML. */
    lacing?: number;
    frames: Uint8Array[];
}

/** Block payload: [track vint][int16 relative][flags][lacing sizes][frame data…]. */
function blockPayload(spec: BlockSpec): number[] {
    const lacing = spec.lacing ?? 0;
    const flags = (spec.keyframe === false ? 0 : 0x80) | (lacing << 1) | (spec.invisible ? 0x08 : 0);
    const out: number[] = [0x80 | spec.track, (spec.relative >> 8) & 0xff, spec.relative & 0xff, flags];
    if (lacing !== 0) {
        out.push(spec.frames.length - 1);
        if (lacing === 1) {
            for (let i = 0; i < spec.frames.length - 1; i++) {
                let remaining = spec.frames[i]!.length;
                while (remaining >= 255) { out.push(0xff); remaining -= 255; }
                out.push(remaining);
            }
        } else if (lacing === 3) {
            // First size is an unsigned vint; the rest are signed vint deltas. Both are emitted
            // in the 2-byte form (14 payload bits, bias 2^13 - 1) so the sizes here fit.
            const first = spec.frames[0]!.length;
            out.push(0x40 | ((first >> 8) & 0x3f), first & 0xff);
            for (let i = 1; i < spec.frames.length - 1; i++) {
                const biased = spec.frames[i]!.length - spec.frames[i - 1]!.length + (Math.pow(2, 13) - 1);
                out.push(0x40 | ((biased >> 8) & 0x3f), biased & 0xff);
            }
        }
        // lacing === 2 (fixed) carries no size table at all.
    }
    for (const f of spec.frames) out.push(...Array.from(f));
    return out;
}

function simpleBlock(spec: BlockSpec): number[] {
    return el(ID.SimpleBlock, blockPayload(spec));
}

/** BlockGroup: keyframe-ness is the ABSENCE of ReferenceBlock, not a flag. */
function blockGroup(spec: BlockSpec, opts: { reference?: number; durationTc?: number } = {}): number[] {
    const children = [...el(ID.Block, blockPayload({ ...spec, keyframe: false }))];
    if (opts.durationTc != null) children.push(...el(ID.BlockDuration, uint(opts.durationTc)));
    if (opts.reference != null) children.push(...el(ID.ReferenceBlock, uint(opts.reference)));
    return el(ID.BlockGroup, children);
}

interface TrackSpec {
    number: number;
    type: number;
    codecId: string;
    width?: number; height?: number;
    sampleRate?: number; channels?: number;
    defaultDurationNs?: number;
    codecPrivate?: Uint8Array;
    compressed?: boolean;
    encrypted?: boolean;
}

function trackEntry(t: TrackSpec): number[] {
    const body = [
        ...el(ID.TrackNumber, uint(t.number)),
        ...el(ID.TrackType, uint(t.type)),
        ...el(ID.CodecID, str(t.codecId)),
    ];
    if (t.defaultDurationNs) body.push(...el(ID.DefaultDuration, uint(t.defaultDurationNs, 4)));
    if (t.codecPrivate) body.push(...el(ID.CodecPrivate, t.codecPrivate));
    if (t.width) {
        body.push(...el(ID.Video, [...el(ID.PixelWidth, uint(t.width, 2)), ...el(ID.PixelHeight, uint(t.height ?? 0, 2))]));
    }
    if (t.sampleRate) {
        body.push(...el(ID.Audio, [...el(ID.SamplingFrequency, f64(t.sampleRate)), ...el(ID.Channels, uint(t.channels ?? 1))]));
    }
    if (t.compressed || t.encrypted) {
        const inner = t.encrypted ? el(ID.ContentEncryption, []) : el(ID.ContentCompression, []);
        body.push(...el(ID.ContentEncodings, el(ID.ContentEncoding, inner)));
    }
    return el(ID.TrackEntry, body);
}

interface FileSpec {
    docType?: string;
    timecodeScale?: number;
    durationTc?: number;
    tracks: TrackSpec[];
    /** Each cluster: its Timecode plus already-serialized block elements. */
    clusters: Array<{ timecode: number; blocks: number[][]; unknownSize?: boolean }>;
}

function buildWebm(spec: FileSpec): Uint8Array {
    const header = el(ID.EBML, [
        ...el(ID.DocType, str(spec.docType ?? "webm")),
        ...el(ID.DocTypeVersion, uint(2)),
        ...el(ID.DocTypeReadVersion, uint(2)),
    ]);
    const info = el(ID.Info, [
        ...el(ID.TimecodeScale, uint(spec.timecodeScale ?? 1_000_000, 4)),
        ...(spec.durationTc != null ? el(ID.Duration, f64(spec.durationTc)) : []),
    ]);
    const tracks = el(ID.Tracks, spec.tracks.flatMap(trackEntry));
    const clusters = spec.clusters.flatMap((c) => {
        const body = [...el(ID.Timecode, uint(c.timecode, 2)), ...c.blocks.flat()];
        return c.unknownSize ? elUnknownSize(ID.Cluster, body) : el(ID.Cluster, body);
    });
    return Uint8Array.from([...header, ...el(ID.Segment, [...info, ...tracks, ...clusters])]);
}

function frame(byte: number, length: number): Uint8Array {
    return new Uint8Array(length).fill(byte);
}

/** A two-track file mirroring the shape of the real game asset. */
function standardFile(): Uint8Array {
    return buildWebm({
        timecodeScale: 1_000_000,
        durationTc: 120,
        tracks: [
            { number: 1, type: 1, codecId: "V_VP8", width: 1920, height: 1080, defaultDurationNs: 40_000_000 },
            { number: 2, type: 2, codecId: "A_VORBIS", sampleRate: 48000, channels: 2, codecPrivate: frame(0xaa, 16) },
        ],
        clusters: [
            {
                timecode: 0,
                blocks: [
                    simpleBlock({ track: 1, relative: 0, keyframe: true, frames: [frame(0x11, 300)] }),
                    simpleBlock({ track: 2, relative: 0, lacing: 1, frames: [frame(0x21, 10), frame(0x22, 260), frame(0x23, 40)] }),
                    simpleBlock({ track: 1, relative: 40, keyframe: false, frames: [frame(0x12, 100)] }),
                ],
            },
            {
                timecode: 80,
                blocks: [
                    simpleBlock({ track: 1, relative: 0, keyframe: true, invisible: true, frames: [frame(0x13, 250)] }),
                    blockGroup({ track: 1, relative: 40, frames: [frame(0x14, 90)] }, { reference: 40, durationTc: 40 }),
                ],
            },
        ],
    });
}

const src = (b: Uint8Array) => new BufferSource(b);

/* ── tests ───────────────────────────────────────────────────────────────── */

describe("matroska: magic + header", () => {
    it("recognizes the EBML magic and rejects anything else", () => {
        expect(isMatroska(standardFile())).toBe(true);
        expect(isMatroska(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa2]))).toBe(false);
        expect(isMatroska(Uint8Array.from([0x1a, 0x45]))).toBe(false);
        expect(() => parseMatroska(src(Uint8Array.from([0x00, 0x01, 0x02, 0x03])))).toThrow(MatroskaError);
    });

    it("refuses a non-Matroska DocType by name", () => {
        const bytes = buildWebm({ docType: "not-a-container", tracks: [{ number: 1, type: 1, codecId: "V_VP8" }], clusters: [] });
        expect(() => parseMatroska(src(bytes))).toThrow(/DocType "not-a-container"/);
    });

    it("reads TimecodeScale and scales Duration by it", () => {
        const file = parseMatroska(src(standardFile()));
        expect(file.docType).toBe("webm");
        expect(file.timecodeScale).toBe(1_000_000);
        expect(file.durationNs).toBe(120_000_000);
    });

    it("scales Duration by a NON-default TimecodeScale", () => {
        // 1 µs units: the same Duration value must yield a 1000x smaller wall time. A parser
        // that hardcoded 1 ms would return 120 ms here.
        const bytes = buildWebm({
            timecodeScale: 1000, durationTc: 120,
            tracks: [{ number: 1, type: 1, codecId: "V_VP8" }], clusters: [],
        });
        expect(parseMatroska(src(bytes)).durationNs).toBe(120_000);
    });

    it("scales FRAME timestamps by TimecodeScale too", () => {
        // The Duration assertion above does not cover the block path: a parser that scaled
        // Duration correctly and hardcoded 1 ms for blocks would still pass it.
        const bytes = buildWebm({
            timecodeScale: 1000,
            tracks: [{ number: 1, type: 1, codecId: "V_VP8" }],
            clusters: [{ timecode: 10, blocks: [simpleBlock({ track: 1, relative: 5, frames: [frame(1, 8)] })] }],
        });
        const frames = Array.from(readFrames(src(bytes), parseMatroska(src(bytes))));
        expect(frames.map((f) => f.timestampNs)).toEqual([15_000]);
    });
});

describe("matroska: tracks", () => {
    it("reports track number, kind, codec, geometry and codec private data", () => {
        const { tracks } = parseMatroska(src(standardFile()));
        expect(tracks.length).toBe(2);
        const [video, audio] = tracks;
        expect(video!.number).toBe(1);
        expect(video!.kind).toBe("video");
        expect(video!.codecId).toBe("V_VP8");
        expect(video!.width).toBe(1920);
        expect(video!.height).toBe(1080);
        expect(video!.displayWidth).toBe(1920); // defaulted from PixelWidth
        expect(video!.defaultDurationNs).toBe(40_000_000);
        expect(video!.codecPrivate).toBeNull();
        expect(audio!.kind).toBe("audio");
        expect(audio!.codecId).toBe("A_VORBIS");
        expect(audio!.sampleRate).toBe(48000);
        expect(audio!.channels).toBe(2);
        expect(audio!.codecPrivate?.length).toBe(16);
    });

    it("names an unknown TrackType 'other' rather than guessing", () => {
        const bytes = buildWebm({ tracks: [{ number: 3, type: 17, codecId: "S_TEXT/UTF8" }], clusters: [] });
        expect(parseMatroska(src(bytes)).tracks[0]!.kind).toBe("subtitle");
        const weird = buildWebm({ tracks: [{ number: 4, type: 0x20, codecId: "X_WHAT" }], clusters: [] });
        expect(parseMatroska(src(weird)).tracks[0]!.kind).toBe("other");
    });
});

describe("matroska: assertDecodable refuses what it cannot hand over", () => {
    const trackOf = (spec: TrackSpec) => parseMatroska(src(buildWebm({ tracks: [spec], clusters: [] }))).tracks[0]!;

    it("accepts a plain VP8/Vorbis track", () => {
        expect(() => assertDecodable(trackOf({ number: 1, type: 1, codecId: "V_VP8" }))).not.toThrow();
        expect(() => assertDecodable(trackOf({ number: 1, type: 2, codecId: "A_VORBIS" }))).not.toThrow();
    });

    it("refuses ContentEncryption, ContentCompression and an unvouched CodecID by name", () => {
        expect(() => assertDecodable(trackOf({ number: 1, type: 1, codecId: "V_VP8", encrypted: true })))
            .toThrow(/encrypted track/);
        expect(() => assertDecodable(trackOf({ number: 1, type: 1, codecId: "V_VP8", compressed: true })))
            .toThrow(/ContentCompression/);
        expect(() => assertDecodable(trackOf({ number: 1, type: 1, codecId: "V_REAL/RV40" })))
            .toThrow(/CodecID "V_REAL\/RV40"/);
    });
});

describe("matroska: frames", () => {
    const all = () => Array.from(readFrames(src(standardFile()), parseMatroska(src(standardFile()))));

    it("yields every frame from both SimpleBlock and BlockGroup, with the right sizes", () => {
        const frames = all();
        // 3 video (2 SimpleBlock + 1 in a BlockGroup) + 1 invisible video + 3 laced audio.
        expect(frames.length).toBe(7);
        const video = frames.filter((f) => f.trackNumber === 1);
        const audio = frames.filter((f) => f.trackNumber === 2);
        expect(video.map((f) => f.data.length)).toEqual([300, 100, 250, 90]);
        expect(audio.map((f) => f.data.length)).toEqual([10, 260, 40]);
        // Content, not just length — a lacing off-by-one would still give plausible sizes.
        expect(audio[0]!.data.every((b) => b === 0x21)).toBe(true);
        expect(audio[1]!.data.every((b) => b === 0x22)).toBe(true);
        expect(audio[2]!.data.every((b) => b === 0x23)).toBe(true);
    });

    it("computes timestamps as (clusterTimecode + relative) * timecodeScale", () => {
        const video = all().filter((f) => f.trackNumber === 1);
        expect(video.map((f) => f.timestampNs)).toEqual([0, 40_000_000, 80_000_000, 120_000_000]);
    });

    it("derives keyframe-ness from block flags and from ReferenceBlock absence", () => {
        const frames = all();
        const video = frames.filter((f) => f.trackNumber === 1);
        expect(video.map((f) => f.isKeyframe)).toEqual([true, false, true, false]);
        expect(video[2]!.invisible).toBe(true);
        expect(video[3]!.durationNs).toBe(40_000_000); // BlockDuration, scaled
        // A BlockGroup with no ReferenceBlock IS a keyframe even though the Block's own flag
        // byte says otherwise — Block flags have no keyframe bit.
        const bytes = buildWebm({
            tracks: [{ number: 1, type: 1, codecId: "V_VP8" }],
            clusters: [{ timecode: 0, blocks: [blockGroup({ track: 1, relative: 0, frames: [frame(1, 8)] })] }],
        });
        const only = Array.from(readFrames(src(bytes), parseMatroska(src(bytes))));
        expect(only.map((f) => f.isKeyframe)).toEqual([true]);
    });

    it("splits all three lacing modes, and distributes laced timestamps only when it can", () => {
        const mk = (lacing: number, defaultDurationNs?: number) => {
            const bytes = buildWebm({
                tracks: [{ number: 1, type: 2, codecId: "A_VORBIS", sampleRate: 48000, channels: 2, defaultDurationNs }],
                clusters: [{
                    timecode: 10,
                    blocks: [simpleBlock({
                        track: 1, relative: 0, lacing,
                        frames: lacing === 2
                            ? [frame(1, 64), frame(2, 64), frame(3, 64)]
                            : [frame(1, 300), frame(2, 40), frame(3, 555)],
                    })],
                }],
            });
            return Array.from(readFrames(src(bytes), parseMatroska(src(bytes))));
        };
        for (const lacing of [1, 3]) {
            const f = mk(lacing);
            expect(f.map((x) => x.data.length)).toEqual([300, 40, 555]);
            expect(f.map((x) => x.lacedIndex)).toEqual([0, 1, 2]);
            // No DefaultDuration ⇒ sub-frames share the block stamp and say so.
            expect(f.map((x) => x.timestampNs)).toEqual([10_000_000, 10_000_000, 10_000_000]);
            expect(f.map((x) => x.timestampExact)).toEqual([true, false, false]);
        }
        const fixed = mk(2);
        expect(fixed.map((x) => x.data.length)).toEqual([64, 64, 64]);
        expect(fixed[1]!.data.every((b) => b === 2)).toBe(true);

        const spaced = mk(1, 20_000_000);
        expect(spaced.map((x) => x.timestampNs)).toEqual([10_000_000, 30_000_000, 50_000_000]);
        expect(spaced.every((x) => x.timestampExact)).toBe(true);
    });

    it("honors trackNumbers and limit", () => {
        const bytes = standardFile();
        const file = parseMatroska(src(bytes));
        expect(Array.from(readFrames(src(bytes), file, { trackNumbers: [2] })).length).toBe(3);
        expect(Array.from(readFrames(src(bytes), file, { limit: 2 })).length).toBe(2);
    });

    it("skips Void padding and walks an unknown-size Cluster", () => {
        const bytes = buildWebm({
            tracks: [{ number: 1, type: 1, codecId: "V_VP8" }],
            clusters: [
                {
                    timecode: 0, unknownSize: true,
                    blocks: [
                        [...el(ID.Void, new Uint8Array(7))],
                        simpleBlock({ track: 1, relative: 0, frames: [frame(0x55, 32)] }),
                    ],
                },
                { timecode: 100, blocks: [simpleBlock({ track: 1, relative: 0, frames: [frame(0x56, 48)] })] },
            ],
        });
        const frames = Array.from(readFrames(src(bytes), parseMatroska(src(bytes))));
        expect(frames.map((f) => f.data.length)).toEqual([32, 48]);
        expect(frames.map((f) => f.timestampNs)).toEqual([0, 100_000_000]);
    });

    it("throws rather than silently truncating a malformed laced block", () => {
        // Xiph size table claiming more bytes than the block holds.
        const payload = blockPayload({ track: 1, relative: 0, lacing: 1, frames: [frame(1, 300), frame(2, 40), frame(3, 10)] });
        const bytes = buildWebm({
            tracks: [{ number: 1, type: 2, codecId: "A_VORBIS", sampleRate: 48000, channels: 1 }],
            clusters: [{ timecode: 0, blocks: [el(ID.SimpleBlock, payload.slice(0, payload.length - 200))] }],
        });
        expect(() => Array.from(readFrames(src(bytes), parseMatroska(src(bytes))))).toThrow(MatroskaError);
    });
});
