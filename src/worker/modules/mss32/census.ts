/**
 * MSS32 census — what the Miles layer is playing, and at what rate it says so.
 *
 * Miles titles gate real logic on audio: a cutscene advances with the stream's
 * position, a teardown loop spins on a sample's status. Those answers were only
 * observable by grepping the log firehose, which is per-call, unsampled and gone
 * in seconds. This is the state itself, plus the one derived number a wrong answer
 * shows up in: how fast the position we publish moves against wall time.
 *
 * `positionMs` is what the guest can READ (the value at handle+0x18 for a stream,
 * converted with the stream's own byte rate) — not our internal bookkeeping, so a
 * divergence between the two is visible rather than averaged away.
 */

import { MSSContext } from "./context";
import { MSSSample, MSSStream } from "./types";
import { getBytesPerSecond, getPlaybackLengthBytes } from "./helpers";
import { MemoryGuard } from "../../core/memory/mem-guard";

export interface MssStreamCensus {
    id: number;
    handleHex: string;
    file: string | null;
    format: string;
    isPlaying: boolean;
    isPaused: boolean;
    pendingStart: boolean;
    /** Our own byte cursor. */
    position: number;
    lengthBytes: number;
    bytesPerSec: number;
    positionMs: number | null;
    lengthMs: number | null;
    /** The position word the guest reads (handle+0x18), in bytes and ms. */
    publishedPosition: number | null;
    publishedMs: number | null;
    incremental: boolean;
    /** Nominal rate of the source, and the multiplier the guest asked for. */
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    playbackRate: number;
    /** WHICH path last moved the position: the host's own report, or our estimate.
     *  `updateEmulatorState` prefers a host report younger than 250 ms, so a number
     *  that looks wrong is only interpretable next to its source. */
    positionSource: "host" | "estimate" | "idle";
    hostPositionAgeMs: number | null;
    /** The status word the guest polls (handle+0x00): 1 FREE / 2 DONE / 4 PLAYING /
     *  8 STOPPED. A title's teardown and its cutscene sequencing both branch on it, so
     *  "we said DONE" and "the guest decided to stop" are only tellable apart here. */
    publishedStatus: number | null;
}

export interface MssSampleCensus {
    id: number;
    handleHex: string;
    is3D: boolean;
    isPlaying: boolean;
    isStopped: boolean;
    pendingStart: boolean;
    position: number;
    lengthBytes: number;
    positionMs: number | null;
}

export interface MssCensus {
    streams: MssStreamCensus[];
    samples: MssSampleCensus[];
    playingSamples: number;
    playingStreams: number;
}

function msOf(bytes: number, bytesPerSec: number): number | null {
    return bytesPerSec > 0 ? Math.round((bytes / bytesPerSec) * 1000) : null;
}

function readPublishedPosition(ctx: MSSContext, stream: MSSStream): number | null {
    const mem = ctx.process.getCurrentMemory?.();
    if (!mem) return null;
    const at = stream.handle + 0x18;
    if (!MemoryGuard.isValidRange(mem, at, 4)) return null;
    return new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint32(at, true);
}

function readPublishedStatus(ctx: MSSContext, stream: MSSStream): number | null {
    const mem = ctx.process.getCurrentMemory?.();
    if (!mem || !MemoryGuard.isValidRange(mem, stream.handle, 4)) return null;
    return new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint32(stream.handle, true);
}

function streamRow(ctx: MSSContext, s: MSSStream): MssStreamCensus {
    const bytesPerSec = getBytesPerSecond(s);
    const hostAge = s.lastAudioPositionTime === undefined
        ? null : Math.round(performance.now() - s.lastAudioPositionTime);
    const lengthBytes = getPlaybackLengthBytes(s);
    const published = readPublishedPosition(ctx, s);
    return {
        id: s.id,
        handleHex: `0x${s.handle.toString(16)}`,
        file: s.filename,
        format: s.fileFormat ?? "unknown",
        isPlaying: s.isPlaying,
        isPaused: s.isPaused,
        pendingStart: s.pendingStart,
        position: s.position,
        lengthBytes,
        bytesPerSec,
        positionMs: msOf(s.position, bytesPerSec),
        lengthMs: msOf(lengthBytes, bytesPerSec),
        publishedPosition: published,
        publishedMs: published === null ? null : msOf(published, bytesPerSec),
        incremental: !!s.source,
        sampleRate: s.sampleRate,
        channels: s.channels,
        bitsPerSample: s.bitsPerSample,
        playbackRate: s.playbackRate,
        positionSource: !s.isPlaying ? "idle" : (hostAge !== null && hostAge < 250 ? "host" : "estimate"),
        hostPositionAgeMs: hostAge,
        publishedStatus: readPublishedStatus(ctx, s),
    };
}

function sampleRow(s: MSSSample): MssSampleCensus {
    const bytesPerSec = getBytesPerSecond(s);
    return {
        id: s.id,
        handleHex: `0x${s.handle.toString(16)}`,
        is3D: !!s.is3D,
        isPlaying: s.isPlaying,
        isStopped: s.isStopped,
        pendingStart: s.pendingStart,
        position: s.position,
        lengthBytes: getPlaybackLengthBytes(s),
        positionMs: msOf(s.position, bytesPerSec),
    };
}

export function mssCensus(ctx: MSSContext): MssCensus {
    const streams = [...ctx.streams.values()].map(s => streamRow(ctx, s));
    const samples = [...ctx.samples.values()].map(sampleRow);
    return {
        streams,
        samples,
        playingStreams: streams.filter(s => s.isPlaying).length,
        playingSamples: samples.filter(s => s.isPlaying).length,
    };
}
