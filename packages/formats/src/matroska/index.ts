/**
 * Matroska / WebM reader — the demux half only.
 *
 * Scope is deliberately narrow: the EBML header, Segment/Info/Tracks metadata, and Cluster
 * iteration yielding raw compressed frames. That is exactly the seam a browser decoder wants —
 * WebCodecs takes `EncodedVideoChunk`s, so a container reader plus the codec's own bitstream
 * is the whole job and no codec lives here. Anything a caller cannot then decode is REFUSED
 * BY NAME (`assertDecodable`) rather than handed over as bytes of an unknown shape.
 *
 * Encryption (ContentEncoding/ContentEncryption) and stream compression (a per-track
 * ContentCompAlgo, incl. Matroska's header-strip) change what the frame data IS, so a track
 * carrying either is flagged and refused: "could not check" and "not encoded" must not look
 * alike. All three lacing modes are implemented (Xiph/fixed/EBML) because WebM Vorbis routinely
 * laces, and silently dropping laced sub-frames loses audio without any error.
 *
 * Format reference: Matroska specification (matroska.org), EBML RFC 8794. Element layout is
 *   [ID vint][Size vint][payload]; a size of all-ones is "unknown", used for live Segments
 *   and Clusters, and is handled by scanning to the next sibling-level element.
 */

import type { RandomAccessSource } from "../unpack/source";

export const EBML_MAGIC = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);

export class MatroskaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MatroskaError";
    }
}

/* EBML / Matroska element IDs, stored as their full big-endian ID bytes. */
const ID_EBML = 0x1a45dfa3;
const ID_DOCTYPE = 0x4282;
const ID_DOCTYPE_VERSION = 0x4287;
const ID_DOCTYPE_READ_VERSION = 0x4285;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_MUXING_APP = 0x4d80;
const ID_WRITING_APP = 0x5741;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_UID = 0x73c5;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_DEFAULT_DURATION = 0x23e383;
const ID_FLAG_LACING = 0x9c;
const ID_LANGUAGE = 0x22b59c;
const ID_TRACK_NAME = 0x536e;
const ID_VIDEO = 0xe0;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_DISPLAY_WIDTH = 0x54b0;
const ID_DISPLAY_HEIGHT = 0x54ba;
const ID_AUDIO = 0xe1;
const ID_SAMPLING_FREQ = 0xb5;
const ID_OUT_SAMPLING_FREQ = 0x78b5;
const ID_CHANNELS = 0x9f;
const ID_BIT_DEPTH = 0x6264;
const ID_CONTENT_ENCODINGS = 0x6d80;
const ID_CONTENT_ENCODING = 0x6240;
const ID_CONTENT_COMPRESSION = 0x5034;
const ID_CONTENT_ENCRYPTION = 0x5035;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;
const ID_REFERENCE_BLOCK = 0xfb;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_CUES = 0x1c53bb6b;
const ID_TAGS = 0x1254c367;
const ID_CHAPTERS = 0x1043a770;
const ID_ATTACHMENTS = 0x1941a469;
const ID_VOID = 0xec;
const ID_CRC32 = 0xbf;

/** TrackType values (Matroska §TrackType). */
const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;
const TRACK_TYPE_SUBTITLE = 17;

/** Elements that may legally follow a Cluster at Segment level — the terminator set for a
 *  Cluster of unknown size. */
const SEGMENT_LEVEL_IDS = new Set([
    ID_CLUSTER, ID_INFO, ID_TRACKS, ID_SEEK_HEAD, ID_CUES, ID_TAGS, ID_CHAPTERS, ID_ATTACHMENTS,
]);

export type MatroskaTrackKind = "video" | "audio" | "subtitle" | "other";

export interface MatroskaTrack {
    number: number;
    uid: number | null;
    kind: MatroskaTrackKind;
    /** Raw TrackType byte, for a kind we do not name. */
    type: number;
    /** e.g. "V_VP8", "V_VP9", "V_MPEG4/ISO/AVC", "A_VORBIS", "A_OPUS". */
    codecId: string;
    /** Codec setup bytes (Vorbis' three headers, AVC's avcC, …) or null. */
    codecPrivate: Uint8Array | null;
    language: string;
    name: string;
    /** Nanoseconds per frame/block when the track declares it, else 0. */
    defaultDurationNs: number;
    /** The track's FlagLacing; frames may still be laced regardless, so the block parser
     *  never trusts it. */
    lacingAllowed: boolean;
    /** Video geometry — the CODED size, which is what a decoder is configured with. */
    width: number;
    height: number;
    displayWidth: number;
    displayHeight: number;
    sampleRate: number;
    /** Output sample rate when the track declares SR upsampling, else 0. */
    outputSampleRate: number;
    channels: number;
    bitDepth: number;
    /** A ContentEncoding declared compression (incl. header-strip): the frame bytes are NOT
     *  the codec bitstream. */
    compressed: boolean;
    /** A ContentEncryption element: the frame bytes are ciphertext. */
    encrypted: boolean;
    /** The ContentEncodings subtree could not be walked, so the two flags above are unknown,
     *  not false. */
    encodingUnreadable: boolean;
}

export interface MatroskaFile {
    docType: string;
    docTypeVersion: number;
    docTypeReadVersion: number;
    /** Nanoseconds per timecode unit (Matroska default 1_000_000 = 1 ms). */
    timecodeScale: number;
    /** Total duration in nanoseconds, or 0 when the Info block omits it. */
    durationNs: number;
    muxingApp: string;
    writingApp: string;
    tracks: MatroskaTrack[];
    /** Byte range of the Segment payload — where `readFrames` iterates. */
    segmentStart: number;
    segmentEnd: number;
}

export interface MatroskaFrame {
    trackNumber: number;
    /** A COPY of the frame's compressed bytes (the reader's window is reused). */
    data: Uint8Array;
    timestampNs: number;
    isKeyframe: boolean;
    /** Set on a Block whose flags mark it invisible (a renderer should not present it). */
    invisible: boolean;
    /** BlockDuration in ns when the BlockGroup carries one, else 0. */
    durationNs: number;
    /** Index within a laced block; 0 for an unlaced frame. */
    lacedIndex: number;
    /** Whether `timestampNs` is the block's own timestamp or was interpolated for a laced
     *  sub-frame from DefaultDuration. Laced sub-frames with no DefaultDuration share the
     *  block timestamp and set this false, so a caller can tell an exact stamp from a guess. */
    timestampExact: boolean;
}

/** Cheap probe for callers dispatching on container type. */
export function isMatroska(head: Uint8Array): boolean {
    if (head.length < EBML_MAGIC.length) return false;
    for (let i = 0; i < EBML_MAGIC.length; i++) if (head[i] !== EBML_MAGIC[i]) return false;
    return true;
}

/**
 * Windowed EBML cursor. Elements are small and mostly sequential, so one sliding window keeps
 * a multi-GB file off the heap while still allowing byte-at-a-time vint decoding.
 */
class Cursor {
    private buf: Uint8Array = new Uint8Array(0);
    private bufPos = 0;

    constructor(private readonly src: RandomAccessSource, public pos: number) {}

    get size(): number {
        return this.src.size;
    }

    private window(offset: number, length: number): Uint8Array {
        if (offset >= this.bufPos && offset + length <= this.bufPos + this.buf.length) {
            const start = offset - this.bufPos;
            return this.buf.subarray(start, start + length);
        }
        const span = Math.max(length, 1 << 16);
        this.buf = this.src.readRangeSync(offset, Math.min(offset + span, this.src.size));
        this.bufPos = offset;
        if (this.buf.length < length) throw new MatroskaError(`truncated file at offset ${offset}`);
        return this.buf.subarray(0, length);
    }

    /** Copy: the window is reused, so a caller holding a subarray would see it change. */
    bytes(length: number): Uint8Array {
        const out = this.window(this.pos, length).slice();
        this.pos += length;
        return out;
    }

    peek(length: number): Uint8Array {
        return this.window(this.pos, length);
    }

    byte(): number {
        const b = this.window(this.pos, 1)[0]!;
        this.pos += 1;
        return b;
    }

    /** Element ID: leading-1 marks the width, and the ID keeps its marker bits. */
    id(): number {
        const first = this.byte();
        if (first === 0) throw new MatroskaError(`invalid element ID at ${this.pos - 1}`);
        let width = 1;
        for (let mask = 0x80; mask && !(first & mask); mask >>= 1) width++;
        if (width > 4) throw new MatroskaError(`element ID wider than 4 bytes at ${this.pos - 1}`);
        let value = first;
        for (let i = 1; i < width; i++) value = value * 256 + this.byte();
        return value;
    }

    /**
     * Element size vint. Returns null for the all-ones "unknown size" form, which live
     * Segments and Clusters use.
     */
    size_(): number | null {
        const first = this.byte();
        if (first === 0) throw new MatroskaError(`invalid size vint at ${this.pos - 1}`);
        let width = 1;
        for (let mask = 0x80; mask && !(first & mask); mask >>= 1) width++;
        if (width > 8) throw new MatroskaError(`size vint wider than 8 bytes at ${this.pos - 1}`);
        let value = first & (0xff >> width);
        let allOnes = value === (0xff >> width);
        for (let i = 1; i < width; i++) {
            const b = this.byte();
            if (b !== 0xff) allOnes = false;
            value = value * 256 + b;
        }
        if (allOnes) return null;
        if (!Number.isSafeInteger(value)) throw new MatroskaError("element size exceeds safe integer range");
        return value;
    }

    /** Unsigned vint used inside a Block for the track number and EBML lace sizes. */
    vintUnsigned(): number {
        const s = this.size_();
        if (s === null) throw new MatroskaError("unknown-size vint where a value was required");
        return s;
    }
}

function readUint(bytes: Uint8Array): number {
    let value = 0;
    for (const b of bytes) value = value * 256 + b;
    if (!Number.isSafeInteger(value)) throw new MatroskaError("integer exceeds safe integer range");
    return value;
}

function readFloat(bytes: Uint8Array): number {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength === 4) return dv.getFloat32(0);
    if (bytes.byteLength === 8) return dv.getFloat64(0);
    if (bytes.byteLength === 0) return 0;
    throw new MatroskaError(`unsupported float width ${bytes.byteLength}`);
}

function readString(bytes: Uint8Array): string {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder().decode(bytes.subarray(0, end));
}

function kindOf(trackType: number): MatroskaTrackKind {
    if (trackType === TRACK_TYPE_VIDEO) return "video";
    if (trackType === TRACK_TYPE_AUDIO) return "audio";
    if (trackType === TRACK_TYPE_SUBTITLE) return "subtitle";
    return "other";
}

function emptyTrack(): MatroskaTrack {
    return {
        number: 0, uid: null, kind: "other", type: 0, codecId: "", codecPrivate: null,
        language: "eng", name: "", defaultDurationNs: 0, lacingAllowed: true,
        width: 0, height: 0, displayWidth: 0, displayHeight: 0,
        sampleRate: 0, outputSampleRate: 0, channels: 0, bitDepth: 0,
        compressed: false, encrypted: false, encodingUnreadable: false,
    };
}

/** Walk a container's direct children, calling `visit(id, payloadStart, payloadEnd)`. */
function eachChild(
    cur: Cursor,
    start: number,
    end: number,
    visit: (id: number, payloadStart: number, payloadEnd: number) => void,
): void {
    cur.pos = start;
    while (cur.pos < end) {
        const id = cur.id();
        const size = cur.size_();
        const payloadStart = cur.pos;
        if (size === null) throw new MatroskaError(`unknown-size child element 0x${id.toString(16)} at ${payloadStart}`);
        const payloadEnd = payloadStart + size;
        if (payloadEnd > end) throw new MatroskaError(`child element 0x${id.toString(16)} overruns its parent`);
        visit(id, payloadStart, payloadEnd);
        cur.pos = payloadEnd;
    }
}

function parseContentEncodings(cur: Cursor, start: number, end: number, track: MatroskaTrack): void {
    try {
        eachChild(cur, start, end, (id, s, e) => {
            if (id !== ID_CONTENT_ENCODING) return;
            eachChild(cur, s, e, (cid) => {
                if (cid === ID_CONTENT_COMPRESSION) track.compressed = true;
                else if (cid === ID_CONTENT_ENCRYPTION) track.encrypted = true;
            });
        });
    } catch {
        track.encodingUnreadable = true;
    }
}

function parseTrackEntry(cur: Cursor, start: number, end: number): MatroskaTrack {
    const t = emptyTrack();
    eachChild(cur, start, end, (id, s, e) => {
        const len = e - s;
        switch (id) {
            case ID_TRACK_NUMBER: cur.pos = s; t.number = readUint(cur.bytes(len)); break;
            case ID_TRACK_UID: cur.pos = s; t.uid = len <= 6 ? readUint(cur.bytes(len)) : null; break;
            case ID_TRACK_TYPE: cur.pos = s; t.type = readUint(cur.bytes(len)); t.kind = kindOf(t.type); break;
            case ID_CODEC_ID: cur.pos = s; t.codecId = readString(cur.bytes(len)); break;
            case ID_CODEC_PRIVATE: cur.pos = s; t.codecPrivate = cur.bytes(len); break;
            case ID_DEFAULT_DURATION: cur.pos = s; t.defaultDurationNs = readUint(cur.bytes(len)); break;
            case ID_FLAG_LACING: cur.pos = s; t.lacingAllowed = readUint(cur.bytes(len)) !== 0; break;
            case ID_LANGUAGE: cur.pos = s; t.language = readString(cur.bytes(len)); break;
            case ID_TRACK_NAME: cur.pos = s; t.name = readString(cur.bytes(len)); break;
            case ID_VIDEO:
                eachChild(cur, s, e, (vid, vs, ve) => {
                    cur.pos = vs;
                    const bytes = cur.bytes(ve - vs);
                    if (vid === ID_PIXEL_WIDTH) t.width = readUint(bytes);
                    else if (vid === ID_PIXEL_HEIGHT) t.height = readUint(bytes);
                    else if (vid === ID_DISPLAY_WIDTH) t.displayWidth = readUint(bytes);
                    else if (vid === ID_DISPLAY_HEIGHT) t.displayHeight = readUint(bytes);
                });
                break;
            case ID_AUDIO:
                eachChild(cur, s, e, (aid, as_, ae) => {
                    cur.pos = as_;
                    const bytes = cur.bytes(ae - as_);
                    if (aid === ID_SAMPLING_FREQ) t.sampleRate = readFloat(bytes);
                    else if (aid === ID_OUT_SAMPLING_FREQ) t.outputSampleRate = readFloat(bytes);
                    else if (aid === ID_CHANNELS) t.channels = readUint(bytes);
                    else if (aid === ID_BIT_DEPTH) t.bitDepth = readUint(bytes);
                });
                break;
            case ID_CONTENT_ENCODINGS:
                parseContentEncodings(cur, s, e, t);
                break;
            default: break;
        }
    });
    if (t.displayWidth === 0) t.displayWidth = t.width;
    if (t.displayHeight === 0) t.displayHeight = t.height;
    return t;
}

/**
 * Parse the EBML header, Info and Tracks. Clusters are NOT read here — they are streamed by
 * `readFrames` so a 60 MB video costs one metadata pass, not a full buffer.
 *
 * `startOffset` lets a caller skip a wrapper; omit it and the magic must be at byte 0.
 */
export function parseMatroska(src: RandomAccessSource, startOffset = 0): MatroskaFile {
    const head = src.readRangeSync(startOffset, startOffset + 4);
    if (!isMatroska(head)) throw new MatroskaError("not a Matroska/WebM file (bad EBML magic)");

    const cur = new Cursor(src, startOffset);
    const file: MatroskaFile = {
        docType: "", docTypeVersion: 1, docTypeReadVersion: 1,
        timecodeScale: 1_000_000, durationNs: 0, muxingApp: "", writingApp: "",
        tracks: [], segmentStart: 0, segmentEnd: 0,
    };

    // EBML header.
    if (cur.id() !== ID_EBML) throw new MatroskaError("EBML header element missing");
    const ebmlSize = cur.size_();
    if (ebmlSize === null) throw new MatroskaError("EBML header has unknown size");
    const ebmlStart = cur.pos;
    eachChild(cur, ebmlStart, ebmlStart + ebmlSize, (id, s, e) => {
        cur.pos = s;
        const bytes = cur.bytes(e - s);
        if (id === ID_DOCTYPE) file.docType = readString(bytes);
        else if (id === ID_DOCTYPE_VERSION) file.docTypeVersion = readUint(bytes);
        else if (id === ID_DOCTYPE_READ_VERSION) file.docTypeReadVersion = readUint(bytes);
    });
    if (file.docType !== "matroska" && file.docType !== "webm") {
        throw new MatroskaError(`EBML DocType "${file.docType}" is not Matroska/WebM`);
    }

    // Segment. Skip any non-Segment top-level element rather than assuming adjacency.
    cur.pos = ebmlStart + ebmlSize;
    let segmentSize: number | null = null;
    for (;;) {
        if (cur.pos >= src.size) throw new MatroskaError("no Segment element found");
        const id = cur.id();
        const size = cur.size_();
        if (id === ID_SEGMENT) { segmentSize = size; break; }
        if (size === null) throw new MatroskaError(`unknown-size top-level element 0x${id.toString(16)}`);
        cur.pos += size;
    }
    file.segmentStart = cur.pos;
    file.segmentEnd = segmentSize === null ? src.size : Math.min(src.size, cur.pos + segmentSize);

    // Info + Tracks. Walk Segment children with unknown-size Clusters tolerated (skipped by
    // scan), because metadata always precedes the media in a seekable file.
    let pos = file.segmentStart;
    let sawTracks = false;
    while (pos < file.segmentEnd) {
        cur.pos = pos;
        const id = cur.id();
        const size = cur.size_();
        const payloadStart = cur.pos;
        const payloadEnd = size === null ? scanUnknownSizeEnd(cur, payloadStart, file.segmentEnd) : payloadStart + size;
        if (payloadEnd > file.segmentEnd) throw new MatroskaError(`Segment child 0x${id.toString(16)} overruns the Segment`);

        if (id === ID_INFO) {
            eachChild(cur, payloadStart, payloadEnd, (iid, s, e) => {
                cur.pos = s;
                const bytes = cur.bytes(e - s);
                if (iid === ID_TIMECODE_SCALE) file.timecodeScale = readUint(bytes);
                else if (iid === ID_MUXING_APP) file.muxingApp = readString(bytes);
                else if (iid === ID_WRITING_APP) file.writingApp = readString(bytes);
            });
            // Duration is in timecode units and Info may list it before TimecodeScale, so it
            // takes a second pass once the scale is known.
            eachChild(cur, payloadStart, payloadEnd, (iid, s, e) => {
                if (iid !== ID_DURATION) return;
                cur.pos = s;
                file.durationNs = Math.round(readFloat(cur.bytes(e - s)) * file.timecodeScale);
            });
        } else if (id === ID_TRACKS) {
            eachChild(cur, payloadStart, payloadEnd, (tid, s, e) => {
                if (tid === ID_TRACK_ENTRY) file.tracks.push(parseTrackEntry(cur, s, e));
            });
            sawTracks = true;
        } else if (id === ID_CLUSTER && sawTracks) {
            break; // Media has started and Tracks is in hand.
        }
        pos = payloadEnd;
    }
    if (!sawTracks) throw new MatroskaError("Segment has no Tracks element");
    return file;
}

/**
 * End of an unknown-size element: scan forward to the next element whose ID belongs at
 * Segment level. Only used for a Segment/Cluster written by a streaming muxer.
 */
function scanUnknownSizeEnd(cur: Cursor, start: number, limit: number): number {
    let pos = start;
    while (pos < limit) {
        cur.pos = pos;
        let id: number;
        let size: number | null;
        try {
            id = cur.id();
            size = cur.size_();
        } catch {
            return limit;
        }
        if (SEGMENT_LEVEL_IDS.has(id)) return pos;
        if (size === null) return limit;
        pos = cur.pos + size;
    }
    return limit;
}

interface LacedFrame { data: Uint8Array }

/** Split a Block payload's frame data by its lacing mode. */
function readLacedFrames(cur: Cursor, lacing: number, dataStart: number, dataEnd: number): LacedFrame[] {
    if (lacing === 0) {
        cur.pos = dataStart;
        return [{ data: cur.bytes(dataEnd - dataStart) }];
    }
    cur.pos = dataStart;
    const count = cur.byte() + 1;
    const sizes: number[] = [];
    if (lacing === 2) {
        const total = dataEnd - cur.pos;
        if (total % count !== 0) throw new MatroskaError(`fixed-lace block of ${total}B does not divide into ${count} frames`);
        for (let i = 0; i < count; i++) sizes.push(total / count);
    } else if (lacing === 1) {
        // Xiph: each of the first count-1 sizes is a run of 0xFF bytes plus a terminator.
        for (let i = 0; i < count - 1; i++) {
            let size = 0;
            for (;;) {
                const b = cur.byte();
                size += b;
                if (b !== 0xff) break;
                if (cur.pos > dataEnd) throw new MatroskaError("Xiph lace size runs past the block");
            }
            sizes.push(size);
        }
    } else {
        // EBML: first size is an unsigned vint, the rest are signed vint deltas.
        let size = cur.vintUnsigned();
        sizes.push(size);
        for (let i = 1; i < count - 1; i++) {
            const before = cur.pos;
            const raw = cur.vintUnsigned();
            const width = cur.pos - before;
            // Signed vint: bias by 2^(7*width - 1) - 1.
            const delta = raw - (Math.pow(2, 7 * width - 1) - 1);
            size += delta;
            if (size < 0) throw new MatroskaError("EBML lace produced a negative frame size");
            sizes.push(size);
        }
    }
    if (lacing !== 2) {
        const consumed = sizes.reduce((a, b) => a + b, 0);
        const remaining = dataEnd - cur.pos - consumed;
        if (remaining < 0) throw new MatroskaError("laced frame sizes exceed the block payload");
        sizes.push(remaining); // last frame's size is implicit
    }
    const out: LacedFrame[] = [];
    for (const size of sizes) {
        if (cur.pos + size > dataEnd) throw new MatroskaError("laced frame overruns the block payload");
        out.push({ data: cur.bytes(size) });
    }
    return out;
}

export interface ReadFramesOptions {
    /** Only yield frames for these track numbers (default: all). */
    trackNumbers?: number[];
    /** Stop after this many yielded frames (0 = no limit). */
    limit?: number;
}

/**
 * Stream frames out of the Segment's Clusters, in stored order.
 *
 * Keyframe determination follows Matroska: a SimpleBlock states it in its flags, while a
 * BlockGroup's Block is a keyframe exactly when the group carries no ReferenceBlock.
 */
export function* readFrames(
    src: RandomAccessSource,
    file: MatroskaFile,
    options: ReadFramesOptions = {},
): Generator<MatroskaFrame> {
    const wanted = options.trackNumbers ? new Set(options.trackNumbers) : null;
    const limit = options.limit ?? 0;
    const durationByTrack = new Map<number, number>();
    for (const t of file.tracks) durationByTrack.set(t.number, t.defaultDurationNs);

    const cur = new Cursor(src, file.segmentStart);
    let yielded = 0;
    let pos = file.segmentStart;

    while (pos < file.segmentEnd) {
        cur.pos = pos;
        const id = cur.id();
        const size = cur.size_();
        const payloadStart = cur.pos;
        const payloadEnd = size === null ? scanUnknownSizeEnd(cur, payloadStart, file.segmentEnd) : payloadStart + size;
        if (payloadEnd > file.segmentEnd) throw new MatroskaError("Cluster overruns the Segment");
        pos = payloadEnd;
        if (id !== ID_CLUSTER) continue;

        let clusterTimecode = 0;
        // Timecode is the first Cluster child in practice, but read it explicitly before any
        // block: a block timestamp is meaningless without it.
        let scan = payloadStart;
        while (scan < payloadEnd) {
            cur.pos = scan;
            const cid = cur.id();
            const csize = cur.size_();
            if (csize === null) throw new MatroskaError("unknown-size Cluster child");
            const cStart = cur.pos;
            const cEnd = cStart + csize;
            if (cEnd > payloadEnd) throw new MatroskaError("Cluster child overruns the Cluster");
            scan = cEnd;

            if (cid === ID_TIMECODE) {
                cur.pos = cStart;
                clusterTimecode = readUint(cur.bytes(csize));
                continue;
            }
            if (cid === ID_VOID || cid === ID_CRC32) continue;

            let blockStart = cStart;
            let blockEnd = cEnd;
            let groupKeyframe: boolean | null = null;
            let blockDurationNs = 0;

            if (cid === ID_BLOCK_GROUP) {
                let found = false;
                let hasReference = false;
                eachChild(cur, cStart, cEnd, (gid, gs, ge) => {
                    if (gid === ID_BLOCK) { blockStart = gs; blockEnd = ge; found = true; }
                    else if (gid === ID_REFERENCE_BLOCK) hasReference = true;
                    else if (gid === ID_BLOCK_DURATION) {
                        cur.pos = gs;
                        blockDurationNs = readUint(cur.bytes(ge - gs)) * file.timecodeScale;
                    }
                });
                if (!found) continue;
                groupKeyframe = !hasReference;
            } else if (cid !== ID_SIMPLE_BLOCK) {
                continue;
            }

            cur.pos = blockStart;
            const trackNumber = cur.vintUnsigned();
            const tcBytes = cur.peek(2);
            const relative = (((tcBytes[0]! << 8) | tcBytes[1]!) << 16) >> 16; // int16 BE
            cur.pos += 2;
            const flags = cur.byte();
            const dataStart = cur.pos;

            if (wanted && !wanted.has(trackNumber)) continue;

            const lacing = (flags >> 1) & 0x03;
            const isKeyframe = groupKeyframe ?? (flags & 0x80) !== 0;
            const invisible = (flags & 0x08) !== 0;
            const blockTsNs = (clusterTimecode + relative) * file.timecodeScale;
            const frames = readLacedFrames(cur, lacing, dataStart, blockEnd);
            const subDuration = durationByTrack.get(trackNumber) ?? 0;

            for (let i = 0; i < frames.length; i++) {
                const exact = i === 0 || subDuration > 0;
                yield {
                    trackNumber,
                    data: frames[i]!.data,
                    timestampNs: blockTsNs + (subDuration > 0 ? i * subDuration : 0),
                    isKeyframe,
                    invisible,
                    durationNs: blockDurationNs,
                    lacedIndex: i,
                    timestampExact: exact,
                };
                yielded++;
                if (limit > 0 && yielded >= limit) return;
            }
        }
    }
}

/** CodecIDs this reader's frames are known to be the plain bitstream of. */
export const KNOWN_CODEC_IDS = [
    "V_VP8", "V_VP9", "V_AV1", "V_MPEG4/ISO/AVC", "V_MPEGH/ISO/HEVC",
    "A_VORBIS", "A_OPUS", "A_AAC", "A_MPEG/L3",
] as const;

/**
 * Refuse a track whose frame bytes are not the codec bitstream this reader claims to hand
 * over — a caller must never feed a decoder something it could not actually demux.
 */
export function assertDecodable(track: MatroskaTrack): void {
    if (track.encodingUnreadable) {
        throw new MatroskaError(`track ${track.number}: unreadable ContentEncodings — cannot rule out encryption`);
    }
    if (track.encrypted) {
        throw new MatroskaError(`track ${track.number}: encrypted track (ContentEncryption) is not supported`);
    }
    if (track.compressed) {
        throw new MatroskaError(
            `track ${track.number}: ContentCompression (incl. header-strip) is not implemented`,
        );
    }
    if (!(KNOWN_CODEC_IDS as readonly string[]).includes(track.codecId)) {
        throw new MatroskaError(`track ${track.number}: CodecID "${track.codecId}" is not a codec this reader vouches for`);
    }
}
