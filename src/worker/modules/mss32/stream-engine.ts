/**
 * Incremental AIL stream engine — one open handle, seek, refill.
 *
 * Miles streams a file: it keeps the stream's file open for the life of the
 * HSTREAM, reads a buffer at a time as playback consumes it, and asks the app
 * for more through the callback AIL_register_stream_callback installed. It does
 * not read the file. We used to: AIL_open_stream ran open → seek(END) →
 * seek(BEGIN) → N × read → close through the app's OWN file callbacks and
 * buffered the entire thing, so a 50 MB radio station was read end to end every
 * time the app opened it, and AIL_register_stream_callback had nothing to call.
 *
 * The engine here holds the file open, seeds a fixed circular ring from the
 * header read, and tops the ring up a slab at a time as playback drains it.
 *
 * TWO BACKINGS, because Miles has two ways to reach a stream's bytes:
 *   - "app": the title installed AILCALLBACKs, so the file lives in ITS archive
 *     and only its own code can read it. A refill is one guest call chain (seek
 *     if the cursor moved, then read) driven from AIL_serve / AIL_service_stream,
 *     the two entry points at which real Miles services its streams; it parks and
 *     resumes like any other guest read.
 *   - "vfs": no callbacks — the name is a path and we read it ourselves. A refill
 *     is an ordinary async read off the 20 ms playback heartbeat, no guest code
 *     involved. This is the common case (GTA III's radio is here).
 *
 * Scope: formats we decode ourselves (PCM and IMA ADPCM WAV). An MP3/OGG stream
 * is played by a host media element that takes the whole encoded image, so those
 * keep the whole-file path — see the sniff in both open functions.
 */

import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { System } from "../../core/system";
import type { VfsFileHandle } from "../../runtime/filesystem/vfs";
import { MSSContext } from "./context";
import { MSSStream, MSSStreamSource } from "./types";
import { getMemory, isMp3, isOgg, makeView, refreshStreamLenDone } from "./helpers";
import { ThunkResult } from "../../core/thunking/thunk-dispatcher";
import {
    AIL_FILE_SEEK_BEGIN, AIL_FILE_SEEK_END,
    GuestCall, GuestCallChain, hasAppFileCallbacks, runGuestCallChain,
} from "./app-file-io";
import {
    convertToFloat, countWavSampleFrames, scanWavChunks, WavChunkInfo,
} from "./audio-decode";
import {
    appendStreamingRing, ensureStreamingRing, hasStreamingRing, resetStreamingRing,
    startStreamingRing, streamingRingBytes, streamingRingFreeBytes,
} from "./playback-engine";

/** Header probe: big enough for any sane RIFF chunk prelude plus a first slab of data. */
const HEADER_PROBE_BYTES = 64 * 1024;

/** Guest scratch the app's read callback writes into. One read per refill fits in it. */
const SCRATCH_BYTES = 64 * 1024;

/** How much decoded audio the ring holds. Deep enough that a stalled frame or a
 *  cold archive read cannot starve the worklet, shallow enough that a seek or a
 *  station switch discards a fraction of a second, not a minute. */
const RING_SECONDS = 2.0;

/** Refill once the ring is this far from full — leaves a full pump period of slack. */
const REFILL_THRESHOLD = 0.35;

/**
 * Service-point accounting. A starving ring has exactly three causes and they are
 * indistinguishable from the ring itself: the pump never ran (`pumps` flat), it ran
 * and decided nothing wanted data (`pumps` climbing, `wanted` flat), or the read
 * itself came back empty (`refills` climbing, `refillBytes` flat). Without these the
 * only symptom is silence, which every one of them produces.
 */
export const streamEngineStats = {
    adopted: 0, pumps: 0, wanted: 0, refills: 0, refillBytes: 0,
    shortReads: 0, rollovers: 0, errors: 0,
};

/** Formats we decode ourselves, and can therefore feed a frame at a time. */
function isIncrementalWavFormat(info: WavChunkInfo): boolean {
    if (info.formatTag === 17) return true;                       // IMA ADPCM
    if (info.formatTag === 1 && info.bitsPerSample > 0) return true;
    if (info.formatTag === 3 && info.bitsPerSample === 32) return true;
    return false;
}

/** Source bytes that decode as one indivisible unit; refills are whole multiples. */
function sourceBlockBytes(info: WavChunkInfo): number {
    if (info.formatTag === 17) return Math.max(1, info.blockAlign);
    return Math.max(1, info.channels * Math.max(1, info.bitsPerSample >> 3));
}

/** Decoded frames one source block yields. */
function framesPerSourceBlock(info: WavChunkInfo): number {
    return Math.max(1, countWavSampleFrames({ ...info, dataChunkSize: sourceBlockBytes(info) }));
}

// ==================== Open ====================

/**
 * Open `namePtr` through the app's file callbacks and, if it is a WAV we decode,
 * leave it OPEN with a primed ring. Returns true when the stream became
 * incremental; false means the caller should fall back to the whole-file read
 * (the sniff said MP3/OGG, or the header was unreadable).
 *
 * On a false return the app's handle has already been closed, and on a true one
 * it belongs to `stream.source` until close_stream.
 */
export function* openStreamSource(
    ctx: MSSContext,
    stream: MSSStream,
    namePtr: number,
    what: string,
): Generator<GuestCall, boolean, number> {
    if (!hasAppFileCallbacks(ctx)) return false;
    const cb = ctx.fileCallbacks!;

    const scratch = ctx.process.memory.alloc(4 + SCRATCH_BYTES);
    if (!scratch) {
        Logger.error(LogCategory.SYSTEM, `MSS32: stream engine: no guest memory for "${what}"`);
        return false;
    }
    const handleOut = scratch;
    const buffer = scratch + 4;

    // Single exit: cleanup has to be able to YIELD (the app's close callback is
    // guest code), and a `yield` inside a generator's `finally` runs during
    // .return() — which is exactly how runGuestCallChain abandons a chain it
    // could not start. Keep the teardown on the normal path instead.
    let fileHandle = 0;
    let adopted = false;
    let ok = false;

    const opened = yield { fn: cb.open, args: [namePtr, handleOut], label: "open" };
    if (opened) {
        fileHandle = readU32(ctx, handleOut);

        const fileSize = (yield { fn: cb.seek, args: [fileHandle, 0, AIL_FILE_SEEK_END], label: "seek(end)" }) >>> 0;
        yield { fn: cb.seek, args: [fileHandle, 0, AIL_FILE_SEEK_BEGIN], label: "seek(begin)" };

        const probeLen = Math.min(HEADER_PROBE_BYTES, SCRATCH_BYTES, fileSize);
        const got = probeLen > 0
            ? (yield { fn: cb.read, args: [fileHandle, buffer, probeLen], label: "read(header)" }) >>> 0
            : 0;

        if (got === 0 || got > probeLen) {
            Logger.error(LogCategory.SYSTEM, `MSS32: stream "${what}": header read returned ${got}/${probeLen}`);
        } else {
            const mem = getMemory(ctx);
            if (!MemoryGuard.isValidRange(mem, buffer, got)) {
                Logger.error(LogCategory.SYSTEM, `MSS32: stream "${what}": app read buffer out of range`);
            } else {
                const head = mem.slice(buffer, buffer + got);
                // Not ours to decode (MP3/OGG, or a WAV variant convertToFloat refuses)
                // → leave `adopted` false and let the whole-file path re-open it.
                const info = scanWavChunks(head);
                if (info && isIncrementalWavFormat(info)) {
                    adopted = adoptSource(ctx, stream, info, head,
                        { kind: "app", fileHandle, scratch, vfsHandle: null }, fileSize, what);
                    ok = adopted;
                }
            }
        }
    } else {
        Logger.warn(LogCategory.SYSTEM, `MSS32: app file callback could not open "${what}"`);
    }

    if (!adopted) {
        if (fileHandle) yield { fn: cb.close, args: [fileHandle], label: "close" };
        ctx.process.memory.free(scratch);
    }
    return ok;
}

/**
 * The data chunk's DECLARED size, read straight off the chunk header.
 *
 * scanWavChunks clamps `dataChunkSize` to the buffer it was handed, which is right
 * for a whole-file image and wrong for a header probe: over 64 KiB it reports every
 * station as a 64 KiB station, and the engine then plays two seconds and calls it
 * the end of the file.
 */
function declaredDataChunkSize(head: Uint8Array, info: WavChunkInfo): number {
    const sizeAt = info.dataChunkOffset - 4;
    if (sizeAt < 0 || sizeAt + 4 > head.length) return info.dataChunkSize;
    return new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(sizeAt, true);
}

/** How the engine reaches this stream's bytes — see the header. */
type SourceBacking = Pick<MSSStreamSource, "kind" | "fileHandle" | "scratch" | "vfsHandle">;

/** Install the incremental source on `stream` and prime its ring from the header read. */
function adoptSource(
    ctx: MSSContext,
    stream: MSSStream,
    info: WavChunkInfo,
    head: Uint8Array,
    backing: SourceBacking,
    fileSize: number,
    what: string,
): boolean {
    // The declared data chunk can outrun the file (a truncated or streamed WAV);
    // trust the file, which is what a player reading forward would hit anyway.
    const dataStart = info.dataChunkOffset;
    const declaredSize = declaredDataChunkSize(head, info);
    const declaredEnd = declaredSize > 0 ? dataStart + declaredSize : fileSize;
    const dataEnd = Math.min(declaredEnd, fileSize);
    if (dataEnd <= dataStart) {
        Logger.error(LogCategory.SYSTEM, `MSS32: stream "${what}": empty data chunk`);
        return false;
    }

    const blockBytes = sourceBlockBytes(info);
    const totalFrames = countWavSampleFrames({ ...info, dataChunkSize: dataEnd - dataStart });
    if (totalFrames <= 0) {
        Logger.error(LogCategory.SYSTEM, `MSS32: stream "${what}": data chunk decodes to no frames`);
        return false;
    }

    // The guest-visible format is the DECODED one, so bytes-per-second, position,
    // ms-position and the len/done fields are all in ONE unit. The whole-file path
    // never managed that for ADPCM: it reported 4-bit samples and a compressed length
    // while advancing position at the decoded rate.
    stream.fileFormat = "wav";
    stream.sampleRate = info.sampleRate;
    stream.channels = info.channels;
    stream.bitsPerSample = 16;
    stream.formatTag = 1;
    stream.blockAlign = info.channels * 2;
    stream.pcmBytes = totalFrames * info.channels * 2;
    stream.fileData = null;
    stream.decodedData = null;
    refreshStreamLenDone(ctx, stream);

    const source: MSSStreamSource = {
        ...backing,
        fileSize,
        info,
        blockBytes,
        framesPerBlock: framesPerSourceBlock(info),
        dataStart,
        dataEnd,
        totalFrames,
        readOffset: dataStart,
        cursor: head.length,
        framesDecoded: 0,
        busy: false,
        exhausted: false,
        endReported: false,
        pending: null,
    };
    stream.source = source;

    const frameBytes = Math.max(1, info.channels) * 4;
    const ringBytes = Math.max(frameBytes * 1024, Math.ceil(info.sampleRate * RING_SECONDS) * frameBytes);
    ensureStreamingRing(stream, ringBytes);

    // The header read already delivered the first slab of data — decode it rather
    // than seeking backwards over bytes we are holding.
    if (head.length > dataStart) {
        const usable = Math.floor((Math.min(head.length, dataEnd) - dataStart) / blockBytes) * blockBytes;
        if (usable > 0) {
            pushDecoded(stream, head.subarray(dataStart, dataStart + usable));
            source.readOffset = dataStart + usable;
        }
    }

    streamEngineStats.adopted++;
    Logger.log(LogCategory.SYSTEM,
        `MSS32: stream "${what}" opened incrementally: ${info.channels}ch ${info.sampleRate}Hz tag${info.formatTag} ` +
        `data=[${dataStart},${dataEnd}) of ${fileSize}B, ${totalFrames} frames, ring=${streamingRingBytes(stream)}B`);
    return true;
}

// ==================== Refill ====================

/** True when this stream is incrementally fed and its ring wants more data. */
export function streamNeedsRefill(stream: MSSStream): boolean {
    const src = stream.source;
    if (!src || src.busy || !hasStreamingRing(stream)) return false;
    if (src.exhausted && !src.pending) return false;
    const ringBytes = streamingRingBytes(stream);
    if (ringBytes <= 0) return false;
    return streamingRingFreeBytes(stream) >= ringBytes * REFILL_THRESHOLD;
}

/** Any app-backed stream in `ctx` that wants a refill right now (AIL_serve's work). */
export function findStreamNeedingRefill(ctx: MSSContext): MSSStream | null {
    for (const stream of ctx.streams.values()) {
        if (!stream.isPlaying || stream.isPaused) continue;
        if (stream.source?.kind === "app" && streamNeedsRefill(stream)) return stream;
    }
    return null;
}

/**
 * Miles' stream service point: top up ONE app-backed stream whose ring wants data.
 * Returns the suspended-thunk result when a guest chain started (the caller must
 * return it unchanged), or null when there was nothing to do.
 */
export function serveIncrementalStreams(
    ctx: MSSContext,
    thunkCtx: unknown,
    stackCleanup: number,
    source: string,
): ThunkResult | null {
    const stream = findStreamNeedingRefill(ctx);
    if (!stream) return null;
    const result = runGuestCallChain(ctx, thunkCtx, stackCleanup, source, (function* (): GuestCallChain {
        yield* refillStream(ctx, stream);
        return 0;
    })());
    return typeof result === "number" ? null : result;
}

/** Consume the tail a full ring made us hold back. True = ring still full, stop here. */
function drainPending(stream: MSSStream, src: MSSStreamSource): boolean {
    if (!src.pending) return false;
    const consumed = appendStreamingRing(stream, src.pending.floats, src.pending.at);
    src.framesDecoded += consumed / Math.max(1, stream.channels);
    src.pending.at += consumed;
    if (src.pending.at >= src.pending.floats.length) src.pending = null;
    return src.pending !== null;
}

/** Source bytes to ask for: whole blocks, decoding to no more than the ring's free space. */
function planRefill(stream: MSSStream, src: MSSStreamSource): number {
    const freeBytes = streamingRingFreeBytes(stream);
    if (freeBytes <= 0) return 0;
    const frameBytes = Math.max(1, stream.channels) * 4;
    const wantFrames = Math.floor(freeBytes / frameBytes);
    const wantBlocks = Math.max(1, Math.floor(wantFrames / src.framesPerBlock));
    return Math.min(
        wantBlocks * src.blockBytes,
        Math.floor(SCRATCH_BYTES / src.blockBytes) * src.blockBytes,
        src.dataEnd - src.readOffset,
    );
}

/** A slab has landed: decode the whole blocks in it and advance the read offset. */
function absorb(stream: MSSStream, src: MSSStreamSource, slab: Uint8Array): number {
    const usable = Math.floor(slab.length / src.blockBytes) * src.blockBytes;
    if (usable <= 0) return 0;
    pushDecoded(stream, slab.subarray(0, usable));
    src.readOffset += usable;
    return usable;
}

/** A read that came up short is the end of the data, whatever the header claimed. */
function reportShortRead(stream: MSSStream, src: MSSStreamSource, got: number, ask: number): void {
    streamEngineStats.shortReads++;
    Logger.warn(LogCategory.SYSTEM,
        `MSS32: stream "${stream.filename}": refill read returned ${got} for ${ask} at ${src.readOffset} — treating as end of data`);
    src.dataEnd = src.readOffset;
    src.cursor = -1;
}

/**
 * One refill: drain whatever the last read left over, then (seek +) read one
 * slab and decode it. Yields the app's own callbacks, so every `await` inside
 * them is an ordinary guest yield point — nothing here holds a guest view or a
 * VFS cursor across one.
 */
export function* refillStream(ctx: MSSContext, stream: MSSStream): Generator<GuestCall, number, number> {
    const src = stream.source;
    if (!src || src.busy) return 0;
    const cb = ctx.fileCallbacks;
    if (!cb) return 0;

    src.busy = true;
    try {
        // Leftovers from the previous refill first — the ring was full then.
        if (drainPending(stream, src)) return 0;

        if (src.readOffset >= src.dataEnd) {
            if (!(yield* rollOver(ctx, stream))) return 0;
        }

        const ask = planRefill(stream, src);
        if (ask <= 0) return 0;

        if (src.cursor !== src.readOffset) {
            yield { fn: cb.seek, args: [src.fileHandle, src.readOffset, AIL_FILE_SEEK_BEGIN], label: "seek" };
            src.cursor = src.readOffset;
        }

        const buffer = src.scratch + 4;
        const got = (yield { fn: cb.read, args: [src.fileHandle, buffer, ask], label: "read" }) >>> 0;
        if (got === 0 || got > ask) {
            reportShortRead(stream, src, got, ask);
            return 0;
        }
        src.cursor = src.readOffset + got;

        // Re-derived after the yields: a plain guest view does not survive them (§3.1).
        const mem = getMemory(ctx);
        if (!MemoryGuard.isValidRange(mem, buffer, got)) {
            Logger.error(LogCategory.SYSTEM, `MSS32: stream "${stream.filename}": refill buffer out of range`);
            return 0;
        }
        return absorb(stream, src, mem.slice(buffer, buffer + got));
    } finally {
        src.busy = false;
    }
}

// ==================== VFS-backed source ====================

/** Read-only open, OPEN_EXISTING — the same access loadStreamFile uses. */
const VFS_ACCESS = 0x80000000;
const VFS_OPEN_EXISTING = 3;

/**
 * Open `path` through our file system and, if it is a WAV we decode, leave it OPEN
 * with a primed ring. False means the caller should fall back to the whole-file
 * read; the handle is dropped in that case.
 *
 * The handle is a file object nothing else can reach (the guest never sees it), so
 * its cursor is ours and no second owner appears (§3.2).
 */
export async function openVfsStreamSource(ctx: MSSContext, stream: MSSStream, path: string): Promise<boolean> {
    const fs = System.getInstance().fileSystem;
    let handle: VfsFileHandle | null = null;
    try {
        handle = fs.openSync(path, VFS_ACCESS, VFS_OPEN_EXISTING)
            ?? await fs.open(path, VFS_ACCESS, VFS_OPEN_EXISTING);
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: stream "${path}": open failed: ${e}`);
        return false;
    }
    if (!handle) return false;

    const fileSize = fs.getFileSize(handle.path);
    if (fileSize <= 0) return false;

    fs.setPosition(handle, 0, 0);
    const probeLen = Math.min(HEADER_PROBE_BYTES, fileSize);
    let head: Uint8Array;
    try {
        head = fs.readSync(handle, probeLen) ?? await fs.read(handle, probeLen);
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: stream "${path}": header read failed: ${e}`);
        return false;
    }
    if (!head || head.length === 0) return false;

    // Not ours to decode (MP3/OGG, or a WAV variant convertToFloat refuses) → the
    // whole-file path re-opens it and hands the encoded image to the host.
    const info = scanWavChunks(head);
    if (!info || !isIncrementalWavFormat(info)) return false;

    return adoptSource(ctx, stream, info, head,
        { kind: "vfs", fileHandle: 0, scratch: 0, vfsHandle: handle }, fileSize, path);
}

/** What a stream file turned out to be, decided from its first bytes. */
export type StreamSniff =
    /** Adopted: the source is installed and its ring already holds the header slab. */
    | "incremental"
    /** Audio, but not ours to feed a slab at a time (MP3/OGG, or a WAV we cannot decode). */
    | "other-audio"
    /** Not audio at all — AIL_open_stream must FAIL, exactly as real Miles does. */
    | "not-audio"
    /** Could not be read without blocking; the caller falls back to the async open. */
    | "unknown";

/**
 * Classify — and where possible ADOPT — a stream file without leaving this JS turn.
 *
 * AIL_open_stream is synchronous in Miles and answers 0 for a file it cannot play.
 * Answering with a handle regardless is a false capability answer: a title scanning
 * a folder for tracks (GTA III's MP3 player does exactly this) then re-opens the
 * same unplayable file forever, once per frame, because nothing ever tells it no.
 * One header read is enough to answer honestly, and for a format we decode ourselves
 * it is the same read the incremental engine needs anyway.
 */
export function sniffVfsStream(ctx: MSSContext, stream: MSSStream, path: string): StreamSniff {
    const fs = System.getInstance().fileSystem;
    let handle: VfsFileHandle | null;
    try {
        handle = fs.openSync(path, VFS_ACCESS, VFS_OPEN_EXISTING);
    } catch {
        return "unknown";
    }
    if (!handle) return "unknown";

    const fileSize = fs.getFileSize(handle.path);
    if (fileSize <= 0) return "not-audio";

    fs.setPosition(handle, 0, 0);
    const probeLen = Math.min(HEADER_PROBE_BYTES, fileSize);
    let head: Uint8Array | null;
    try {
        head = fs.readSync(handle, probeLen);
    } catch {
        return "unknown";
    }
    // Not resident: answering "not audio" from a read that never happened would be the
    // same false answer in the other direction. Let the async path decide.
    if (!head || head.length === 0) return "unknown";

    const info = scanWavChunks(head);
    if (info && isIncrementalWavFormat(info)) {
        const adopted = adoptSource(ctx, stream, info, head,
            { kind: "vfs", fileHandle: 0, scratch: 0, vfsHandle: handle }, fileSize, path);
        if (adopted) return "incremental";
    }
    if (info || isMp3(head) || isOgg(head)) return "other-audio";
    return "not-audio";
}

/**
 * One refill over the VFS backing. No guest code runs here, so the `await` is an
 * ordinary host yield — but the stream can be closed across it, which is what the
 * identity re-check after the read is for.
 */
export async function refillVfsStream(ctx: MSSContext, stream: MSSStream): Promise<number> {
    const src = stream.source;
    if (!src || src.kind !== "vfs" || src.busy) return 0;
    const handle = src.vfsHandle;
    if (!handle) return 0;
    const fs = System.getInstance().fileSystem;

    src.busy = true;
    streamEngineStats.refills++;
    try {
        if (drainPending(stream, src)) return 0;
        if (src.readOffset >= src.dataEnd && !rollOverVfs(ctx, stream)) return 0;

        const ask = planRefill(stream, src);
        if (ask <= 0) return 0;

        if (src.cursor !== src.readOffset) {
            fs.setPosition(handle, src.readOffset, 0);
            src.cursor = src.readOffset;
        }
        const slab = fs.readSync(handle, ask) ?? await fs.read(handle, ask);
        // Closed (or re-seeked) while the read was in flight: those bytes describe a
        // stream that no longer exists, and absorbing them would advance a dead cursor.
        if (stream.source !== src || src.cursor !== src.readOffset) return 0;
        if (!slab || slab.length === 0 || slab.length > ask) {
            reportShortRead(stream, src, slab?.length ?? 0, ask);
            return 0;
        }
        src.cursor = src.readOffset + slab.length;
        const used = absorb(stream, src, slab);
        streamEngineStats.refillBytes += used;
        return used;
    } catch (e) {
        streamEngineStats.errors++;
        Logger.error(LogCategory.SYSTEM, `MSS32: stream "${stream.filename}": refill failed: ${e}`);
        return 0;
    } finally {
        src.busy = false;
    }
}

/**
 * Top up every VFS-backed stream that wants it. Called from the playback heartbeat,
 * so it must never throw and never await: one refill per stream is in flight at a
 * time (`busy`), and the ring is deep enough to cover a whole heartbeat period.
 */
export function pumpVfsStreams(ctx: MSSContext): void {
    streamEngineStats.pumps++;
    for (const stream of ctx.streams.values()) {
        if (!stream.isPlaying || stream.isPaused) continue;
        if (stream.source?.kind !== "vfs" || !streamNeedsRefill(stream)) continue;
        streamEngineStats.wanted++;
        void refillVfsStream(ctx, stream);
    }
}

/** Close the VFS backing. Handles are plain file objects — dropping ours frees it. */
export function closeVfsStreamSource(stream: MSSStream): void {
    const src = stream.source;
    if (!src || src.kind !== "vfs") return;
    stream.source = null;
    src.vfsHandle = null;
}

/**
 * End of the source data. Loop back to the start when the app asked for more
 * plays, otherwise mark the stream exhausted; either way this is the point at
 * which Miles notifies the app's registered stream callback.
 */
function* rollOver(ctx: MSSContext, stream: MSSStream): Generator<GuestCall, boolean, number> {
    const src = stream.source!;
    const callback = takeEndCallback(ctx, stream);
    if (callback) yield { fn: callback, args: [stream.handle], label: "stream_callback" };
    return restartOrExhaust(stream, src);
}

/** rollOver for a VFS-backed stream: no chain to yield on, so the app's stream
 *  callback goes on the queue AIL_serve drains, exactly like an EOS callback. */
function rollOverVfs(ctx: MSSContext, stream: MSSStream): boolean {
    const src = stream.source!;
    const callback = takeEndCallback(ctx, stream);
    if (callback) ctx.pendingStreamCallbacks.push({ callback, handle: stream.handle });
    return restartOrExhaust(stream, src);
}

/** The app's stream callback, once per end-of-source. */
function takeEndCallback(ctx: MSSContext, stream: MSSStream): number {
    const src = stream.source!;
    if (src.endReported) return 0;
    src.endReported = true;
    const callback = ctx.streamCallbacks.get(stream.handle) ?? 0;
    if (callback) {
        Logger.log(LogCategory.SYSTEM,
            `MSS32: stream callback 0x${callback.toString(16)} for stream 0x${stream.handle.toString(16)} at end of source`);
    }
    return callback;
}

/** Loop back to the start when the app asked for more plays, else mark it spent. */
function restartOrExhaust(stream: MSSStream, src: MSSStreamSource): boolean {
    streamEngineStats.rollovers++;
    const loops = stream.loopCount;
    if (!(loops === 0 || loops === -1)) {
        src.exhausted = true;
        return false;
    }
    src.readOffset = src.dataStart;
    src.endReported = false;
    return true;
}

/** Decode one source slab and hand it to the ring, keeping any tail that did not fit. */
function pushDecoded(stream: MSSStream, srcBytes: Uint8Array): void {
    const src = stream.source!;
    const info = src.info;
    const floats = convertToFloat(srcBytes, info.channels, info.bitsPerSample, info.formatTag, info.blockAlign);
    if (floats.length === 0) return;
    const consumed = appendStreamingRing(stream, floats, 0);
    src.framesDecoded += consumed / Math.max(1, info.channels);
    if (consumed < floats.length) src.pending = { floats, at: consumed };
}

// ==================== Position / lifetime ====================

/** Seek: drop the ring, re-anchor the source cursor at `positionBytes` (decoded). */
export function seekIncrementalStream(stream: MSSStream, positionBytes: number): void {
    const src = stream.source;
    if (!src) return;
    const decodedFrameBytes = Math.max(1, stream.channels) * 2;
    const frame = Math.max(0, Math.floor(positionBytes / decodedFrameBytes));
    const block = Math.floor(frame / src.framesPerBlock);
    src.readOffset = Math.min(src.dataEnd, src.dataStart + block * src.blockBytes);
    src.framesDecoded = block * src.framesPerBlock;
    src.pending = null;
    src.exhausted = false;
    src.endReported = false;
    resetStreamingRing(stream);
}

/** Begin (or resume) playback of an incrementally fed stream. */
export function startIncrementalStream(ctx: MSSContext, stream: MSSStream): void {
    startStreamingRing(ctx, stream);
}

/**
 * Close the app's file handle and release the scratch. Yields the app's close
 * callback, so the caller must be able to run a guest chain; when it cannot, the
 * generator is abandoned and the finally still frees our own memory.
 */
export function* closeStreamSource(ctx: MSSContext, stream: MSSStream): Generator<GuestCall, number, number> {
    const src = stream.source;
    if (!src) return 0;
    if (src.kind === "vfs") {
        closeVfsStreamSource(stream);
        return 0;
    }
    stream.source = null;
    try {
        const cb = ctx.fileCallbacks;
        if (cb && src.fileHandle) {
            yield { fn: cb.close, args: [src.fileHandle], label: "close" };
        }
    } finally {
        ctx.process.memory.free(src.scratch);
    }
    return 0;
}

function readU32(ctx: MSSContext, addr: number): number {
    const mem = getMemory(ctx);
    if (!MemoryGuard.isValidRange(mem, addr, 4)) return 0;
    return makeView(mem).getUint32(addr, true) >>> 0;
}
