/**
 * Serve `avcodec_decode_video2` from the browser's own video decoder.
 *
 * WHY: a guest that ships ffmpeg runs VP8's scalar bool decoder as x86. Entropy decoding is
 * the one hot loop neither SIMD nor a better dynarec can touch, so the only lever is to not
 * run it: the guest's avformat still demuxes and hands us compressed packets, and WebCodecs
 * turns them into I420 planes we publish into the guest's own AVFrame.
 *
 * WHAT MAKES THIS FAITHFUL rather than a shortcut:
 *   - It is keyed on the CODEC (`avctx->codec->name`), never on a game. A codec the browser
 *     will not decode is DECLINED, and the guest's real decoder runs exactly as it does today.
 *   - The legacy decode API's own contract is what makes the async→sync bridge legal: a real
 *     decoder is allowed to answer `*got_picture_ptr = 0` for a packet and emit that picture
 *     later. `decoder_decode_frame` then fetches the next packet, and at EOF it drains with an
 *     empty packet until a call answers 0. We use exactly that latitude, so no thread parks and
 *     no guest stack is touched — the handler is synchronous.
 *   - `refcounted_frames` is 1 and the caller `av_frame_unref`s every frame. We leave `buf[]`
 *     NULL and own the plane memory ourselves, so unref's NULL-safe `av_buffer_unref` loop frees
 *     nothing of ours; the entry check below re-verifies that on every call.
 *
 * The ABI comes from `avcodec-abi.ts`, measured out of the shipped DLLs, and every gate here
 * refuses rather than guesses: a failed check declines to the guest's decoder.
 */

import { Logger, LogCategory } from '../../core/logger';
import { isValidAddress } from '../../core/memory/address-guard';
import { toPlainGuestMemory } from '../../core/memory/guest-memory';
import type { Process } from '../../core/process';
import { videoEngine } from '../../../video/video-engine';
import {
    AV_NOPTS_HI, AV_PIX_FMT_YUV420P, AV_PKT_FLAG_KEY, AVMEDIA_TYPE_VIDEO,
    type AvcodecAbi,
} from './avcodec-abi';

/** ffmpeg decoder name -> WebCodecs codec string. Nothing else is served. */
const CODEC_MAP: Record<string, string> = {
    vp8: 'vp8',
    libvpx: 'vp8',
    vp9: 'vp09.00.10.08',
    'libvpx-vp9': 'vp09.00.10.08',
};

/**
 * Backlog bound for accepted packets the decoder has not taken yet — a MEMORY guard, never a
 * liveness test. WebCodecs delivers on the worker's event loop while the guest's decode calls
 * all land inside one v86 slice, so a healthy decoder holds its packets and refuses every push
 * for a whole burst of calls until the loop yields. A tight bound reads that as a dead decoder
 * and hands a working stream back for the rest of the movie. Liveness is `decoderIsDead`.
 */
/** Plane buffers per session: a caller may hold a few frames of decode-ahead, and each one
 *  must keep its own pixels (see publish). */
const PLANE_RING = 4;
const MAX_PENDING_BYTES = 32 << 20;
const MAX_PENDING_PACKETS = 4096;

/** Packet timestamps are handed to WebCodecs as an index; the real 64-bit pts rides this map. */
interface PtsPair { lo: number; hi: number }

interface Session {
    handle: number;
    /** True when this codec's bitstream states keyframe-ness itself (VP8) and we prefer it. */
    bitstreamKeys: boolean;
    width: number;
    height: number;
    /** Plane buffers, used round-robin — see PLANE_RING. */
    planeBufs: number[];
    /** Index of the buffer the last published frame points at. */
    planeSlot: number;
    planeBytes: number;
    /** Compressed packets accepted but not yet taken by the decoder (backpressure). */
    pending: { bytes: Uint8Array; index: number; key: boolean }[];
    /** Bytes held in `pending`, maintained with it so the cap never walks the list. */
    pendingBytes: number;
    nextIndex: number;
    pts: Map<number, PtsPair>;
    framesServed: number;
    /** Set once the first published frame has passed the layout cross-checks. */
    proven: boolean;
    /** First and last dword of the last published Y plane — see checkPlanesIntact. */
    canary: [number, number] | null;
    canaryTail: number;
    /** The opening packets, kept so a session that never produces a frame can say WHY. */
    trace: Array<{ n: number; size: number; flags: number; keyFlag: boolean; keyTag: boolean; head: string }>;
}

export interface DecodeHleState {
    process: Process;
    abi: AvcodecAbi;
    /** A patch in the set could not be applied. Patches are one-way (lib-patcher), so an
     *  already-installed hook cannot be taken back — it declines to the guest's own body
     *  instead, which is exactly the "leave the module as it was" outcome. */
    degraded: boolean;
    /** Original-body trampolines by export name — the decline path for each hook. */
    trampolines: Map<string, number>;
    /** avctx -> session. An avctx with no entry has not been claimed. */
    sessions: Map<number, Session>;
    /** avctx values we have decided never to serve. */
    refused: Set<number>;
    /** WebCodecs codec string -> support, from VideoDecoder.isConfigSupported. */
    support: Map<string, boolean>;
    stats: {
        served: number; declined: number; packets: number; got0: number;
        /** Packets whose AV_PKT_FLAG_KEY disagreed with the VP8 frame tag. Zero on every
         *  shipped video here, so a non-zero value means the flag was worth distrusting. */
        keyFlagMismatch: number;
    };
    /** Why each context was handed back, newest last. A refusal is logged ONCE per avctx, so
     *  the reason is unrecoverable once the log ring rolls - and "declined: 468, served: 266"
     *  then reports that a stream went back to the guest without saying what we could not do. */
    refusals: Array<{
        avctx: string; why: string; expected: boolean; servedBefore: number;
        trace: Session['trace']; wc: unknown;
    }>;
}

/** Kick off the async support probes so the answer is cached long before the first decode. */
export function probeCodecSupport(state: DecodeHleState): void {
    const VideoDecoderCtor = (self as unknown as { VideoDecoder?: { isConfigSupported(c: VideoDecoderConfig): Promise<{ supported?: boolean }> } }).VideoDecoder;
    if (!VideoDecoderCtor) return;
    for (const codec of new Set(Object.values(CODEC_MAP))) {
        VideoDecoderCtor.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })
            .then((r) => {
                state.support.set(codec, r.supported === true);
                Logger.log(LogCategory.SYSTEM, `[ffmpeg-hle] WebCodecs ${codec}: ${r.supported === true ? 'supported' : 'unsupported'}`);
            })
            .catch(() => state.support.set(codec, false));
    }
}

function readU32(mem: Uint8Array, addr: number): number {
    return (mem[addr]! | (mem[addr + 1]! << 8) | (mem[addr + 2]! << 16) | (mem[addr + 3]! << 24)) >>> 0;
}

function writeU32(mem: Uint8Array, addr: number, v: number): void {
    mem[addr] = v & 0xff; mem[addr + 1] = (v >>> 8) & 0xff;
    mem[addr + 2] = (v >>> 16) & 0xff; mem[addr + 3] = (v >>> 24) & 0xff;
}

/**
 * Is this VP8 packet a keyframe, per the bitstream itself? The frame tag's low bit is the
 * frame TYPE and it is inverted (0 = key), and a keyframe follows it with the `9d 01 2a` start
 * code. Returns null when the payload is too short or does not look like VP8 at all.
 *
 * The container flag is the usual source, but it is only as good as whoever set it; this is the
 * stream's own answer, and the two were verified to agree on every frame of these videos
 * (tools/tests/matroska-real.smoke.ts). A decoder handed a leading `delta` emits nothing, ever,
 * so getting this wrong is indistinguishable from a dead decoder.
 */
export function vp8FrameTagIsKeyframe(mem: Uint8Array, data: number, size: number): boolean | null {
    if (!data || size < 3) return null;
    const isKey = (mem[data]! & 1) === 0;
    if (!isKey) return false;
    if (size < 10) return null;
    if (mem[data + 3] !== 0x9d || mem[data + 4] !== 0x01 || mem[data + 5] !== 0x2a) return null;
    return true;
}

function readCString(mem: Uint8Array, addr: number, max = 32): string {
    let s = '';
    for (let i = 0; i < max; i++) {
        const c = mem[addr + i];
        if (!c) break;
        if (c < 0x20 || c > 0x7e) return '';
        s += String.fromCharCode(c);
    }
    return s;
}

/** The decoder name this context was opened with, or "" when it cannot be read. */
function codecNameOf(mem: Uint8Array, abi: AvcodecAbi, avctx: number): string {
    const codec = readU32(mem, avctx + abi.ctxCodec);
    if (!isValidAddress(mem, codec, 16, 'r')) return '';
    if (readU32(mem, codec + abi.codecType) !== AVMEDIA_TYPE_VIDEO) return '';
    const namePtr = readU32(mem, codec + abi.codecName);
    if (!isValidAddress(mem, namePtr, 2, 'r')) return '';
    return readCString(mem, namePtr).toLowerCase();
}

/**
 * A freshly `av_frame_unref`ed AVFrame is in avutil's get_frame_defaults state: format -1,
 * best_effort_timestamp AV_NOPTS_VALUE, every buf[] NULL. The caller hands us exactly that on
 * every call, so this doubles as a live proof of the two AVFrame offsets we could not measure
 * statically AND as the standing check that unref is not taking our plane memory with it.
 */
export function frameLooksFresh(mem: Uint8Array, abi: AvcodecAbi, frame: number): string | null {
    if ((readU32(mem, frame + abi.frameFormat) | 0) !== -1) {
        return `format=${readU32(mem, frame + abi.frameFormat) | 0} (expected -1)`;
    }
    if (readU32(mem, frame + abi.frameBestEffort + 4) !== AV_NOPTS_HI) {
        return `best_effort_timestamp hi=0x${readU32(mem, frame + abi.frameBestEffort + 4).toString(16)} (expected 0x80000000)`;
    }
    for (let i = 0; i < 8; i++) {
        const buf = readU32(mem, frame + abi.frameBuf + i * 4);
        if (buf !== 0) return `buf[${i}]=0x${buf.toString(16)} (expected NULL — av_frame_unref took a reference we do not own)`;
    }
    return null;
}

function closeSession(state: DecodeHleState, avctx: number, why: string): void {
    const s = state.sessions.get(avctx);
    if (!s) return;
    state.sessions.delete(avctx);
    try { videoEngine.close(s.handle); } catch { /* a closed session is not an error */ }
    for (const buf of s.planeBufs) state.process.memory.free(buf);
    Logger.log(LogCategory.SYSTEM,
        `[ffmpeg-hle] session closed for avctx=0x${avctx.toString(16)} after ${s.framesServed} frames (${why})`);
}

/**
 * Stop serving this context for good — the guest's own decoder takes it from here. Logged once
 * per context (every later call is a silent decline), and `expected` keeps an ordinary
 * fall-through — a codec we simply do not map — out of the warning stream.
 */
function refuse(state: DecodeHleState, avctx: number, why: string, expected = false): void {
    const session = state.sessions.get(avctx);
    const servedBefore = session?.framesServed ?? 0;
    // Capture BEFORE closeSession drops the handle: "we fed it and it produced nothing" and
    // "the decoder reported an error" are different failures that look identical afterwards.
    const wc = session ? videoEngine.getWebCodecsStats(session.handle) : null;
    const trace = session?.trace ?? [];
    closeSession(state, avctx, why);
    if (state.refused.has(avctx)) return;
    state.refused.add(avctx);
    state.refusals.push({ avctx: `0x${avctx.toString(16)}`, why, expected, servedBefore, trace, wc });
    if (state.refusals.length > 8) state.refusals.shift();
    const line = `[ffmpeg-hle] declining avctx=0x${avctx.toString(16)} from now on: ${why}`;
    if (expected) Logger.log(LogCategory.SYSTEM, line);
    else Logger.warn(LogCategory.SYSTEM, line);
}

/** Guest seek: the decoder's buffered frames are pre-seek, so drop the session entirely. */
export function onFlushBuffers(state: DecodeHleState, avctx: number): void {
    closeSession(state, avctx, 'avcodec_flush_buffers');
}

/** The context is going away; a later open2 may hand the same address to a different stream. */
export function onCodecClose(state: DecodeHleState, avctx: number): void {
    closeSession(state, avctx, 'avcodec_close');
    state.refused.delete(avctx);
}

function openSession(
    state: DecodeHleState, mem: Uint8Array, avctx: number, codecString: string,
): Session | null {
    const { abi } = state;
    const width = readU32(mem, avctx + abi.ctxWidth) | 0;
    const height = readU32(mem, avctx + abi.ctxHeight) | 0;
    if (width < 16 || height < 16 || width > 8192 || height > 8192) {
        refuse(state, avctx, `implausible avctx dimensions ${width}x${height}`);
        return null;
    }
    // I420 allocations for the life of the stream. The decoder picks its own padded strides,
    // so a buffer allows 256 bytes of row padding; a stride past that fails the publish check
    // and hands the stream back rather than overrunning.
    const planeBytes = Math.ceil((width + 256) * (height + 2) * 1.5);
    const planeBufs: number[] = [];
    for (let i = 0; i < PLANE_RING; i++) {
        const buf = state.process.memory.alloc(planeBytes, 'SURFACE', 'rw');
        if (!buf) {
            for (const taken of planeBufs) state.process.memory.free(taken);
            refuse(state, avctx, `could not allocate ${PLANE_RING}x${planeBytes} bytes for the plane buffers`);
            return null;
        }
        planeBufs.push(buf);
    }
    let handle = 0;
    try {
        handle = videoEngine.openEncoded({ codec: codecString, width, height });
    } catch (e) {
        for (const buf of planeBufs) state.process.memory.free(buf);
        refuse(state, avctx, `openEncoded failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
    const session: Session = {
        handle, bitstreamKeys: codecString === 'vp8', width, height,
        planeBufs, planeSlot: planeBufs.length - 1, planeBytes,
        pending: [], pendingBytes: 0, nextIndex: 0, pts: new Map(), framesServed: 0, proven: false,
        canary: null, canaryTail: 0, trace: [],
    };
    state.sessions.set(avctx, session);
    Logger.log(LogCategory.SYSTEM,
        `[ffmpeg-hle] serving avctx=0x${avctx.toString(16)} ${width}x${height} "${codecString}" from WebCodecs`);
    return session;
}

/**
 * Has the decoder actually failed, as opposed to not having been given a turn yet? Only two
 * things count: it reported an error, or it has never produced a single frame despite holding
 * everything we gave it. "Behind" is not "dead" — a decoder that has emitted frames is alive.
 */
function decoderIsDead(session: Session): string | null {
    const wc = videoEngine.getWebCodecsStats(session.handle);
    if (!wc) return 'decoder session vanished';
    if (wc.error) return `decoder error: ${wc.error}`;
    if (wc.framesDecoded === 0) return `decoder produced no frame from ${wc.packetsPushed} packet(s)`;
    return null;
}

/** Hand the decoder as much of the backlog as it will take. */
function feed(session: Session): void {
    while (session.pending.length) {
        const p = session.pending[0]!;
        if (!videoEngine.pushPacket(session.handle, p.bytes, p.index * 1000, p.key)) return;
        session.pending.shift();
        session.pendingBytes -= p.bytes.length;
    }
}

/**
 * Publish the decoder's current frame into the guest AVFrame. Returns null on success or the
 * reason the frame could not be published faithfully.
 */
function publish(
    state: DecodeHleState, session: Session, mem: Uint8Array, frame: number,
): string | null {
    const { abi } = state;
    const i420 = videoEngine.getFrameI420(session.handle);
    if (!i420) return 'decoder produced a non-I420 frame (no YUV420P to publish)';
    if (i420.strideU !== i420.strideV) return `chroma strides differ (${i420.strideU} vs ${i420.strideV})`;

    // The plane views are windows into one pooled copy, so their byte offsets say what the
    // decoder REALLY produced. That is the only independent check on avctx->width/height,
    // whose offsets are bracketed by measured AVOptions rather than measured themselves.
    const chromaH = (i420.height + 1) >> 1;
    if (i420.strideY < i420.width || i420.strideU < ((i420.width + 1) >> 1)) {
        return `stride below width (y ${i420.strideY}/${i420.width}, u ${i420.strideU})`;
    }
    if (i420.u.byteOffset - i420.y.byteOffset !== i420.strideY * i420.height) {
        return `luma plane is not ${i420.strideY}x${i420.height} — avctx dimensions disagree with the bitstream`;
    }
    if (i420.v.byteOffset - i420.u.byteOffset !== i420.strideU * chromaH) {
        return `chroma plane is not ${i420.strideU}x${chromaH} — avctx dimensions disagree with the bitstream`;
    }

    const ySize = i420.strideY * i420.height;
    const uSize = i420.strideU * chromaH;
    if (ySize + uSize * 2 > session.planeBytes) return `frame needs ${ySize + uSize * 2} bytes, buffer holds ${session.planeBytes}`;

    // A caller with refcounted_frames av_frame_move_ref's the frame into a picture queue and
    // keeps reading it, so publishing every frame into ONE buffer makes every queued frame
    // show the newest picture. Rotate, so a few frames of decode-ahead each keep their own.
    session.planeSlot = (session.planeSlot + 1) % session.planeBufs.length;
    const yAddr = session.planeBufs[session.planeSlot]!;
    const uAddr = yAddr + ySize;
    const vAddr = uAddr + uSize;
    if (!isValidAddress(mem, yAddr, ySize + uSize * 2, 'rw')) return 'plane buffer is not writable guest memory';
    mem.set(i420.y, yAddr);
    mem.set(i420.u, uAddr);
    mem.set(i420.v, vAddr);

    writeU32(mem, frame + abi.frameData + 0, yAddr);
    writeU32(mem, frame + abi.frameData + 4, uAddr);
    writeU32(mem, frame + abi.frameData + 8, vAddr);
    writeU32(mem, frame + abi.frameLinesize + 0, i420.strideY);
    writeU32(mem, frame + abi.frameLinesize + 4, i420.strideU);
    writeU32(mem, frame + abi.frameLinesize + 8, i420.strideU);
    writeU32(mem, frame + abi.frameWidth, i420.width);
    writeU32(mem, frame + abi.frameHeight, i420.height);
    writeU32(mem, frame + abi.frameFormat, AV_PIX_FMT_YUV420P);

    // The consumer takes its pts from best_effort_timestamp only (decoder_reorder_pts == -1).
    const index = Math.round(videoEngine.getFrameTimestampUs(session.handle) / 1000);
    const pts = session.pts.get(index) ?? { lo: 0, hi: AV_NOPTS_HI };
    // Output is in order, so anything older than the frame just delivered is unreachable —
    // dropping it here is what keeps the map from growing with every frame the decoder skips.
    for (const key of session.pts.keys()) if (key <= index) session.pts.delete(key);
    writeU32(mem, frame + abi.frameBestEffort, pts.lo);
    writeU32(mem, frame + abi.frameBestEffort + 4, pts.hi);
    // A real decoder sets both: a consumer outside ffplay's decoder_reorder_pts == -1 branch
    // reads frame->pts, and unref leaves that AV_NOPTS_VALUE if we only write best_effort.
    writeU32(mem, frame + abi.framePts, pts.lo);
    writeU32(mem, frame + abi.framePts + 4, pts.hi);

    session.canary = [readU32(mem, yAddr), readU32(mem, vAddr + uSize - 4)];
    session.canaryTail = vAddr + uSize - 4;
    session.framesServed++;
    return null;
}

/**
 * The live answer to "does our frame survive av_frame_unref?". We hand back planes we own,
 * with `buf[]` left NULL, betting that unref's NULL-safe av_buffer_unref loop frees nothing.
 * If that bet were wrong the memory would be freed and handed to another allocation, so the
 * bytes we wrote last frame would not still be there when the caller comes back for the next.
 */
function checkPlanesIntact(session: Session, mem: Uint8Array): string | null {
    if (!session.canary) return null;
    const head = readU32(mem, session.planeBufs[session.planeSlot]!);
    const tail = readU32(mem, session.canaryTail);
    if (head === session.canary[0] && tail === session.canary[1]) return null;
    return `plane memory changed between calls (head 0x${session.canary[0].toString(16)}->0x${head.toString(16)}, ` +
        `tail 0x${session.canary[1].toString(16)}->0x${tail.toString(16)})`;
}

/**
 * `avcodec_decode_video2(AVCodecContext*, AVFrame*, int *got_picture_ptr, const AVPacket*)`,
 * cdecl. Returns bytes consumed; a negative value is an error the caller propagates.
 *
 * `declined` means "run the original body instead": the caller pushes the trampoline address
 * under the return address so the stub's own RET lands there with the frame the guest built.
 */
export function makeDecodeVideo2Handler(state: DecodeHleState) {
    return (ctx: { esp: number }, rawMem: Uint8Array, args: number[]): { value: number; skipStackCheck?: boolean } => {
        const mem = toPlainGuestMemory(rawMem);
        const { abi } = state;
        const avctx = args[0]! >>> 0;
        const frame = args[1]! >>> 0;
        const gotPtr = args[2]! >>> 0;
        const pkt = args[3]! >>> 0;

        const decline = (): { value: number; skipStackCheck: boolean } => {
            state.stats.declined++;
            return declineToOriginal(state, ctx, mem, 'avcodec_decode_video2');
        };

        if (state.degraded || state.refused.has(avctx)) return decline();
        if (!isValidAddress(mem, avctx, 0x3c0, 'rw') || !isValidAddress(mem, frame, abi.frameSizeof, 'rw')
            || !isValidAddress(mem, gotPtr, 4, 'rw') || !isValidAddress(mem, pkt, 0x50, 'r')) {
            return decline();
        }

        const stale = frameLooksFresh(mem, abi, frame);
        if (stale) {
            if (state.sessions.has(avctx)) refuse(state, avctx, `AVFrame invariant broke: ${stale}`);
            return decline();
        }

        let session = state.sessions.get(avctx);
        const pktData = readU32(mem, pkt + abi.pktData);
        const pktSize = readU32(mem, pkt + abi.pktSize) | 0;
        const flagKey = (readU32(mem, pkt + abi.pktFlags) & AV_PKT_FLAG_KEY) !== 0;
        // The bitstream's own answer wins WHERE WE KNOW THE FORMAT: a decoder handed a leading
        // `delta` emits nothing forever, which is indistinguishable from a dead decoder. Reading
        // a VP9 payload as a VP8 frame tag would invent that same failure, so the parse is gated
        // on the codec rather than attempted blind.
        const bitstreamKey = (isVp8: boolean): boolean | null =>
            (isVp8 ? vp8FrameTagIsKeyframe(mem, pktData, pktSize) : null);

        if (!session) {
            // Claim the context only at a keyframe: a decoder cannot start anywhere else, and
            // declining until then leaves the guest's decoder in charge of exactly those frames.
            if (!pktData || pktSize <= 0 || !flagKey) return decline();
            const name = codecNameOf(mem, abi, avctx);
            const codecString = CODEC_MAP[name];
            if (!codecString) {
                refuse(state, avctx, name ? `codec "${name}" has no WebCodecs equivalent` : 'codec is not a readable video decoder', true);
                return decline();
            }
            // For VP8 the container flag alone is not enough to open on: only the frame tag
            // proves the decoder can actually start here. Declining is silent and costs the
            // guest exactly the frames up to the next real keyframe.
            if (codecString === 'vp8' && bitstreamKey(true) !== true) return decline();
            if (state.support.get(codecString) !== true) {
                // Unresolved probe or an unsupported codec: the guest's decoder handles it.
                if (!state.support.has(codecString)) return decline();
                refuse(state, avctx, `WebCodecs reports "${codecString}" unsupported`, true);
                return decline();
            }
            const opened = openSession(state, mem, avctx, codecString);
            if (!opened) return decline();
            session = opened;
            // We are the decoder now: announce the format the consumer branches on.
            writeU32(mem, avctx + abi.ctxPixFmt, AV_PIX_FMT_YUV420P);
        }

        const clobbered = checkPlanesIntact(session, mem);
        if (clobbered) {
            refuse(state, avctx, clobbered);
            return decline();
        }

        if (pktData && pktSize > 0) {
            if (!isValidAddress(mem, pktData, pktSize, 'r')) {
                refuse(state, avctx, 'packet data is not readable guest memory');
                return decline();
            }
            if (session.pendingBytes >= MAX_PENDING_BYTES || session.pending.length >= MAX_PENDING_PACKETS) {
                const dead = decoderIsDead(session);
                // A live decoder that is merely behind keeps its backlog; only a dead one, or a
                // backlog this size with nothing to show for it, goes back to the guest.
                refuse(state, avctx, dead
                    ? `${dead} (backlog ${session.pending.length} packets / ${session.pendingBytes} bytes)`
                    : `backlog cap reached with a live decoder (${session.pending.length} packets / ${session.pendingBytes} bytes)`);
                return decline();
            }
            const tagKey = bitstreamKey(session.bitstreamKeys);
            if (tagKey !== null && tagKey !== flagKey) state.stats.keyFlagMismatch++;
            const isKey = tagKey ?? flagKey;
            const index = session.nextIndex++;
            if (session.trace.length < 8) {
                session.trace.push({
                    n: index, size: pktSize, flags: readU32(mem, pkt + abi.pktFlags),
                    keyFlag: flagKey, keyTag: tagKey === true,
                    head: [...mem.subarray(pktData, pktData + 10)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
                });
            }
            const lo = readU32(mem, pkt + abi.pktPts);
            const hi = readU32(mem, pkt + abi.pktPts + 4);
            session.pts.set(index, { lo, hi });
            session.pending.push({ bytes: mem.slice(pktData, pktData + pktSize), index, key: isKey });
            session.pendingBytes += pktSize;
            state.stats.packets++;
            feed(session);
        } else if (!pktData) {
            // A NULL-data packet is ffplay's EOF drain; a zero-length one with data is not.
            videoEngine.signalEndOfInput(session.handle);
        }

        if (!videoEngine.frameReady(session.handle) || !videoEngine.doFrame(session.handle)) {
            // A legal "not yet" — the caller fetches the next packet, or ends the stream.
            writeU32(mem, gotPtr, 0);
            state.stats.got0++;
            return { value: Math.max(0, pktSize) };
        }

        const why = publish(state, session, mem, frame);
        if (why) {
            refuse(state, avctx, why);
            return decline();
        }
        if (!session.proven) {
            session.proven = true;
            Logger.log(LogCategory.SYSTEM,
                `[ffmpeg-hle] first frame published for avctx=0x${avctx.toString(16)}: ` +
                `${session.width}x${session.height} YUV420P, ${session.planeBufs.length} plane buffers from ` +
                `0x${session.planeBufs[0]!.toString(16)}`);
        }
        writeU32(mem, gotPtr, 1);
        state.stats.served++;
        return { value: Math.max(0, pktSize) };
    };
}

/**
 * Run the guest's original function body instead of us.
 *
 * The stub is cdecl, so it ends in a bare RET: push the trampoline under the caller's return
 * address and that RET jumps there with the stack exactly as the body's entry expects (return
 * address at [ESP], arguments above it). Setting EIP directly would not survive v86's JIT
 * merging OUT+RET into one block — the same reason every park path redirects [ESP] instead.
 */
export function declineToOriginal(
    state: DecodeHleState, ctx: { esp: number }, mem: Uint8Array, exportName: string,
): { value: number; skipStackCheck: true } {
    const cpu = getGuestCpu(state);
    const trampoline = state.trampolines.get(exportName) ?? 0;
    const esp = (ctx.esp - 4) >>> 0;
    if (!cpu || !trampoline || !isValidAddress(mem, esp, 4, 'rw')) {
        // Without the redirect the original never runs; answering "no picture, nothing consumed"
        // is the only honest alternative, and it is what a decoder returns for a packet it
        // cannot use.
        Logger.error(LogCategory.SYSTEM, '[ffmpeg-hle] cannot redirect to the original body — returning no picture');
        return { value: 0, skipStackCheck: true };
    }
    writeU32(mem, esp, trampoline);
    cpu.reg32[4] = esp | 0;
    return { value: 0, skipStackCheck: true };
}

function getGuestCpu(state: DecodeHleState): { reg32: Int32Array } | null {
    const v86 = state.process.v86 as { cpu?: { reg32: Int32Array }; v86?: { cpu?: { reg32: Int32Array } } } | undefined;
    return v86?.cpu ?? v86?.v86?.cpu ?? null;
}
