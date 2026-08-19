/**
 * WebCodecs decode backend for VideoEngine — the browser's own video decoders behind the
 * engine's existing sync/pull handle API.
 *
 * WHY: a title that ships its own software decoder (ffmpeg's VP8 bool decoder, say) runs that
 * decoder as guest x86. Scalar entropy decoding is exactly what neither SIMD nor a better
 * dynarec can help, so the only real lever is to not run it — hand the compressed packets to
 * `VideoDecoder` instead. The WASM-ffmpeg backend stays the fallback for everything it already
 * serves.
 *
 * THE IMPEDANCE MISMATCH is the whole design problem: WebCodecs is async/push (feed chunks,
 * frames arrive on a callback), while the engine API is sync/pull (`doFrame()` → bool, then read
 * pixels). It is bridged by a bounded ring of ALREADY-COPIED frames:
 *
 *   - A `VideoFrame` is copied to CPU planes the moment it arrives and closed immediately. That
 *     is what makes the pull side synchronous at all (`copyTo` is async and there is no sync
 *     equivalent), and it makes ownership trivial: no VideoFrame outlives its callback, so there
 *     is no frame to leak into a browser-wide stall.
 *   - The ring is bounded IN BYTES, not in frames — a 1080p I420 frame is ~3 MB, so a
 *     frame-count cap is a memory cap only by accident. Backpressure is applied on the PUSH
 *     side (`pushPacket` refuses while the ring plus the decoder's own queue are full), which is
 *     the only place that can refuse without losing data.
 *   - `doFrame()` never blocks. Its `false` therefore means "no frame ready", which merges
 *     "still decoding" with "end of stream" — see `isEndOfStream()` / `stats()`.
 */

import { Logger, LogCategory } from "../worker/core/logger";

/** Planar YUV 4:2:0, the layout a real VP8/H.264 decoder produces (AV_PIX_FMT_YUV420P). */
export interface I420Frame {
    y: Uint8Array;
    u: Uint8Array;
    v: Uint8Array;
    strideY: number;
    strideU: number;
    strideV: number;
    width: number;
    height: number;
}

export interface EncodedStreamConfig {
    /** WebCodecs codec string — "vp8", "vp09.00.10.08", "avc1.640028", … */
    codec: string;
    width: number;
    height: number;
    /** Codec setup bytes (avcC, vpcC). Omit for VP8, which needs none. */
    description?: Uint8Array;
    fps?: number;
    /** Known frame count, for `getInfo().frameCount`; 0 when unknown. */
    frameCount?: number;
    /** Override the byte budget for the decode-ahead ring. */
    ringBudgetBytes?: number;
}

export interface WebCodecsStats {
    /** Frames handed to the ring by the decoder. */
    framesDecoded: number;
    /** Frames consumed through doFrame(). */
    framesConsumed: number;
    /** Frames dropped because the ring was full despite backpressure (should stay 0). */
    framesDropped: number;
    /** doFrame() calls that found nothing ready. */
    starves: number;
    /** pushPacket() calls refused by backpressure. */
    backpressureRejects: number;
    /** Packets accepted by the decoder. */
    packetsPushed: number;
    /** Slots currently held (ready or awaiting their copy). */
    ringDepth: number;
    ringCapacity: number;
    /** VideoDecoder.decodeQueueSize at the last observation. */
    decodeQueueSize: number;
    /** Accepted packets that have not yet produced a frame — what backpressure counts. */
    outstandingPackets: number;
    /** Native pixel format the decoder reported, e.g. "I420". */
    nativeFormat: string;
    /** Frames whose copy failed (a closed/unreadable frame). */
    copyFailures: number;
    /** A terminal decoder error, if one occurred. */
    error: string | null;
    endOfStream: boolean;
}

/** Ring slot. Ordering is reserved on ARRIVAL so an async copy cannot reorder frames. */
interface Slot {
    timestampUs: number;
    ready: boolean;
    failed: boolean;
    /** Native-layout copy (I420 family) — the pooled buffer plus its plane layout. */
    native: Uint8Array | null;
    layout: { offset: number; stride: number }[] | null;
    /** Set when the native format was NOT I420-family and the frame was copied as BGRA. */
    bgraDirect: Uint8Array | null;
    bytes: number;
}

/** Default ring budget. 1080p I420 ≈ 3 MB, so this is ~15 frames at 1080p, ~60 at 480p. */
const DEFAULT_RING_BUDGET_BYTES = 48 << 20;
/** Hard slot cap regardless of budget — decode-ahead beyond this buys nothing for playback. */
const MAX_RING_SLOTS = 12;
const MIN_RING_SLOTS = 2;

/** Whether WebCodecs video decoding exists in this scope. */
export function webCodecsAvailable(): boolean {
    return typeof (self as unknown as { VideoDecoder?: unknown }).VideoDecoder === "function"
        && typeof (self as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk === "function";
}

/** BT.601 / BT.709 YUV→RGB coefficients in 16.16 fixed point, per range. */
interface YuvCoeffs {
    yScale: number; yOffset: number;
    rV: number; gU: number; gV: number; bU: number;
}

function coeffsFor(matrix: string | null, fullRange: boolean | null): YuvCoeffs {
    // Kr/Kb per matrix; the 601 set covers "bt470bg" and "smpte170m" alike.
    const bt709 = matrix === "bt709" || matrix === "bt2020ncl";
    const kr = bt709 ? 0.2126 : 0.299;
    const kb = bt709 ? 0.0722 : 0.114;
    const kg = 1 - kr - kb;
    const full = fullRange === true;
    const yScale = full ? 1 : 255 / 219;
    const cScale = full ? 1 : 255 / 224;
    const f = (x: number) => Math.round(x * 65536);
    return {
        yScale: f(yScale),
        yOffset: full ? 0 : 16,
        rV: f(2 * (1 - kr) * cScale),
        gU: f((2 * kb * (1 - kb) / kg) * cScale),
        gV: f((2 * kr * (1 - kr) / kg) * cScale),
        bU: f(2 * (1 - kb) * cScale),
    };
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * I420 → BGRA (the byte order a Win32 32-bit surface expects: B,G,R,A ascending).
 *
 * Written out rather than delegated to `copyTo({format:'BGRA'})` because the engine's existing
 * consumers depend on an exact channel order and a silent swap here is invisible to any
 * luminance-based check.
 */
export function convertI420ToBgra(
    src: I420Frame,
    out: Uint8Array,
    matrix: string | null = null,
    fullRange: boolean | null = null,
): void {
    const { width, height, y, u, v, strideY, strideU, strideV } = src;
    const c = coeffsFor(matrix, fullRange);
    let o = 0;
    for (let row = 0; row < height; row++) {
        const yRow = row * strideY;
        const cRow = (row >> 1);
        const uRow = cRow * strideU;
        const vRow = cRow * strideV;
        for (let col = 0; col < width; col++) {
            const yy = ((y[yRow + col]! - c.yOffset) * c.yScale) >> 16;
            const cc = col >> 1;
            const uu = u[uRow + cc]! - 128;
            const vv = v[vRow + cc]! - 128;
            out[o] = clamp255(yy + ((c.bU * uu) >> 16));
            out[o + 1] = clamp255(yy - ((c.gU * uu + c.gV * vv) >> 16));
            out[o + 2] = clamp255(yy + ((c.rV * vv) >> 16));
            out[o + 3] = 255;
            o += 4;
        }
    }
}

/**
 * One decoded video stream. Packets in (push), CPU frames out (pull).
 *
 * Callers outside this file go through VideoEngine; this class is exported for the unit tests,
 * which drive it with a fake decoder.
 */
export class WebCodecsVideoSession {
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly frameCount: number;

    private decoder: VideoDecoder | null = null;
    private ring: Slot[] = [];
    private pool: Uint8Array[] = [];
    private poolBytes = 0;
    private current: Slot | null = null;
    private currentBgra: Uint8Array | null = null;
    private currentI420: I420Frame | null = null;
    private consumed = 0;
    private ringCapacity: number;
    private frameBytesEstimate: number;
    private ringBudgetBytes: number;
    private nativeFormat = "";
    private colorMatrix: string | null = null;
    private colorFullRange: boolean | null = null;
    private inputEnded = false;
    private closed = false;
    /** Frames to discard before the next one is handed out (gotoFrame). */
    private discardTarget = 0;
    private stat = {
        framesDecoded: 0, framesConsumed: 0, framesDropped: 0, starves: 0,
        backpressureRejects: 0, packetsPushed: 0, copyFailures: 0,
    };
    private lastError: string | null = null;
    /** In-flight async plane copies — awaited by flush() so teardown is deterministic. */
    private pendingCopies = 0;
    /** Packets accepted by the decoder that have not yet produced a frame. */
    private outstanding = 0;
    private readonly config: VideoDecoderConfig;

    constructor(cfg: EncodedStreamConfig, decoderFactory?: (init: VideoDecoderInit) => VideoDecoder) {
        this.width = cfg.width;
        this.height = cfg.height;
        this.fps = cfg.fps && cfg.fps > 0 ? cfg.fps : 0;
        this.frameCount = cfg.frameCount ?? 0;
        // I420 size is the floor; a decoder handing back BGRA costs ~2.7x that, and the ring
        // is re-sized from the real allocation the first time a frame arrives.
        this.frameBytesEstimate = Math.ceil(this.width * this.height * 1.5);
        this.ringBudgetBytes = cfg.ringBudgetBytes ?? DEFAULT_RING_BUDGET_BYTES;
        this.ringCapacity = this.computeCapacity();

        this.config = {
            codec: cfg.codec,
            codedWidth: cfg.width,
            codedHeight: cfg.height,
            ...(cfg.description ? { description: cfg.description } : {}),
            optimizeForLatency: true,
        };
        const make = decoderFactory ?? ((init: VideoDecoderInit) => new VideoDecoder(init));
        this.decoder = make({
            output: (frame) => this.onFrame(frame),
            error: (e) => {
                this.lastError = e instanceof Error ? e.message : String(e);
                Logger.warn(LogCategory.SYSTEM, `[WebCodecs] decoder error: ${this.lastError}`);
            },
        });
        this.decoder.configure(this.config);
    }

    private computeCapacity(): number {
        const byBudget = Math.floor(this.ringBudgetBytes / Math.max(1, this.frameBytesEstimate));
        return Math.max(MIN_RING_SLOTS, Math.min(MAX_RING_SLOTS, byBudget));
    }

    // ── push side ─────────────────────────────────────────────────────────────

    /**
     * Feed one compressed packet. Returns false when the pipeline is full — the caller must
     * retry the SAME packet later. Refusing is the only lossless way to apply backpressure:
     * accepting would grow either the decoder's queue or our ring without bound.
     */
    pushPacket(data: Uint8Array, timestampUs: number, isKeyframe: boolean, durationUs = 0): boolean {
        if (this.closed || !this.decoder || this.inputEnded) return false;
        if (this.lastError) return false;
        if (!this.hasRoom()) {
            this.stat.backpressureRejects++;
            return false;
        }
        // A chunk must own its bytes: `data` may be a reused demux window.
        const chunk = new EncodedVideoChunk({
            type: isKeyframe ? "key" : "delta",
            timestamp: timestampUs,
            ...(durationUs > 0 ? { duration: durationUs } : {}),
            data: data.slice(),
        });
        this.decoder.decode(chunk);
        this.outstanding++;
        this.stat.packetsPushed++;
        return true;
    }

    /**
     * Room for one more frame: the ring plus what the decoder has not yet emitted.
     *
     * The in-flight count is OURS, not `decodeQueueSize` — that counter drops when the decoder
     * finishes a frame, which is before the output callback delivers it, so a push landing in
     * that window sees a queue emptier than reality and overfills the ring.
     */
    private hasRoom(): boolean {
        return this.ring.length + this.outstanding < this.ringCapacity;
    }

    /**
     * No more packets are coming. Kicks a flush, because the decoder holds the tail of the
     * stream in its own queue and will not emit it otherwise — without this the last
     * decodeQueueSize frames are silently lost at EOF.
     */
    signalEndOfInput(): void {
        if (this.inputEnded) return;
        this.inputEnded = true;
        void this.flush();
    }

    /** Drain the decoder so every accepted packet has produced its frame. */
    async flush(): Promise<void> {
        if (!this.decoder || this.closed) return;
        try {
            if (this.decoder.state === "configured") await this.decoder.flush();
        } catch (e) {
            // A flush rejects when the decoder was reset mid-flight; that is not a decode error.
            Logger.verbose(LogCategory.SYSTEM, `[WebCodecs] flush rejected: ${e instanceof Error ? e.message : String(e)}`);
        }
        // copyTo settles on a task, not a microtask, so yielding the microtask queue alone
        // would spin forever here.
        while (this.pendingCopies > 0) await new Promise<void>((r) => setTimeout(r, 0));
        // A completed flush means the decoder emitted everything it held, so any residue in the
        // in-flight count (a codec that drops a frame rather than emitting it) is cleared here
        // instead of throttling the stream forever.
        this.outstanding = 0;
    }

    // ── the async→sync bridge ─────────────────────────────────────────────────

    private onFrame(frame: VideoFrame): void {
        if (this.closed) { frame.close(); return; }
        if (this.outstanding > 0) this.outstanding--;
        if (!this.nativeFormat) {
            this.nativeFormat = frame.format ?? "";
            this.colorMatrix = frame.colorSpace?.matrix ?? null;
            this.colorFullRange = frame.colorSpace?.fullRange ?? null;
        }
        if (this.ring.length >= this.ringCapacity) {
            // Backpressure should have prevented this; count it loudly instead of growing.
            this.stat.framesDropped++;
            frame.close();
            return;
        }
        const isI420 = (frame.format ?? "").startsWith("I420");
        const slot: Slot = {
            timestampUs: frame.timestamp,
            ready: false, failed: false, native: null, layout: null, bgraDirect: null, bytes: 0,
        };
        this.ring.push(slot);
        this.stat.framesDecoded++;
        this.copyOut(frame, slot, isI420);
    }

    /**
     * Copy the frame's pixels to a pooled CPU buffer and close it in the same turn's
     * continuation. `copyTo` is the only way out of a VideoFrame and it is async, which is
     * precisely why the copy happens here on arrival rather than lazily on the pull side.
     */
    private copyOut(frame: VideoFrame, slot: Slot, isI420: boolean): void {
        this.pendingCopies++;
        const options: VideoFrameCopyToOptions | undefined = isI420 ? undefined : { format: "BGRA" };
        let size: number;
        try {
            size = frame.allocationSize(options);
        } catch (e) {
            this.failSlot(frame, slot, e);
            return;
        }
        if (size > this.frameBytesEstimate) {
            this.frameBytesEstimate = size;
            // Never below what admission has already granted: hasRoom() let those packets in
            // at the old capacity, and shrinking under them would drop frames the push side
            // was told there was room for. The byte budget applies from the next admission on.
            this.ringCapacity = Math.max(this.computeCapacity(), this.ring.length + this.outstanding);
        }
        const buf = this.take(size);
        let copy: Promise<unknown>;
        try {
            copy = frame.copyTo(buf, options);
        } catch (e) {
            // copyTo THROWS (rather than rejecting) for a detached/closed frame, and a throw
            // here would skip the .finally that closes the frame and decrements pendingCopies
            // — leaking the frame and wedging flush()'s drain loop for ever.
            this.give(buf);
            this.failSlot(frame, slot, e);
            return;
        }
        copy.then((layout) => {
            slot.bytes = size;
            if (isI420) { slot.native = buf; slot.layout = layout as { offset: number; stride: number }[]; }
            else {
                slot.bgraDirect = buf;
                // A BGRA copy may come back with a padded stride (allocationSize accounts for
                // it, so nothing throws); reading it as width*4 shears every row.
                slot.layout = layout as { offset: number; stride: number }[];
            }
            slot.ready = true;
        }).catch((e) => {
            this.give(buf);
            slot.failed = true;
            slot.ready = true;
            this.stat.copyFailures++;
            Logger.warn(LogCategory.SYSTEM, `[WebCodecs] frame copy failed: ${e instanceof Error ? e.message : String(e)}`);
        }).finally(() => {
            frame.close();
            this.pendingCopies--;
        });
    }

    private failSlot(frame: VideoFrame, slot: Slot, e: unknown): void {
        slot.failed = true;
        slot.ready = true;
        this.stat.copyFailures++;
        frame.close();
        this.pendingCopies--;
        Logger.warn(LogCategory.SYSTEM, `[WebCodecs] allocationSize failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── pull side ─────────────────────────────────────────────────────────────

    /**
     * Make the next decoded frame current. Never blocks.
     *
     * Returns false when nothing is ready — which is "still decoding" OR "end of stream". The
     * engine's boolean contract cannot express both; `isEndOfStream()` separates them.
     */
    doFrame(): boolean {
        if (this.closed) return false;
        for (;;) {
            const head = this.ring[0];
            if (!head || !head.ready) {
                this.stat.starves++;
                return false;
            }
            this.ring.shift();
            if (head.failed) { this.recycle(head); continue; }
            if (this.discardTarget > this.consumed) {
                this.consumed++;
                this.recycle(head);
                continue;
            }
            if (this.current) this.recycle(this.current);
            this.current = head;
            this.currentBgra = null;
            this.currentI420 = null;
            this.consumed++;
            this.stat.framesConsumed++;
            return true;
        }
    }

    /** A frame is ready to be made current without any decode wait. */
    frameReady(): boolean {
        return !this.closed && (this.ring[0]?.ready ?? false);
    }

    /**
     * Input is finished AND nothing is left anywhere: not in the ring, not mid-copy, and not
     * still inside the decoder. "Inside the decoder" is `outstanding`, not `decodeQueueSize`, for
     * the same reason backpressure uses it — the queue reads 0 while the last frame is still on
     * its way to the callback, and an EOF declared there loses exactly that frame.
     */
    isEndOfStream(): boolean {
        return this.inputEnded
            && this.ring.length === 0
            && this.pendingCopies === 0
            && this.outstanding === 0;
    }

    /** Planar YUV 4:2:0 of the current frame, or null when the decoder gave BGRA directly. */
    getI420(): I420Frame | null {
        const s = this.current;
        if (!s || !s.native || !s.layout) return null;
        if (this.currentI420) return this.currentI420;
        const [ly, lu, lv] = s.layout;
        if (!ly || !lu || !lv) return null;
        const ch = (this.height + 1) >> 1;
        this.currentI420 = {
            y: s.native.subarray(ly.offset, ly.offset + ly.stride * this.height),
            u: s.native.subarray(lu.offset, lu.offset + lu.stride * ch),
            v: s.native.subarray(lv.offset, lv.offset + lv.stride * ch),
            strideY: ly.stride, strideU: lu.stride, strideV: lv.stride,
            width: this.width, height: this.height,
        };
        return this.currentI420;
    }

    /** BGRA of the current frame — converted from I420 on demand and cached per frame. */
    getBgra(): Uint8Array | null {
        const s = this.current;
        if (!s) return null;
        if (s.bgraDirect) {
            const rowBytes = this.width * 4;
            const stride = s.layout?.[0]?.stride ?? rowBytes;
            const offset = s.layout?.[0]?.offset ?? 0;
            if (stride === rowBytes && offset === 0) return s.bgraDirect.subarray(0, rowBytes * this.height);
            if (this.currentBgra) return this.currentBgra;
            const packed = new Uint8Array(rowBytes * this.height);
            for (let y = 0; y < this.height; y++) {
                packed.set(s.bgraDirect.subarray(offset + y * stride, offset + y * stride + rowBytes), y * rowBytes);
            }
            this.currentBgra = packed;
            return packed;
        }
        if (this.currentBgra) return this.currentBgra;
        const i420 = this.getI420();
        if (!i420) return null;
        const out = new Uint8Array(this.width * this.height * 4);
        convertI420ToBgra(i420, out, this.colorMatrix, this.colorFullRange);
        this.currentBgra = out;
        return out;
    }

    /** Presentation timestamp of the current frame, in microseconds. */
    currentTimestampUs(): number {
        return this.current?.timestampUs ?? 0;
    }

    currentFrameIndex(): number {
        return Math.max(0, this.consumed - 1);
    }

    /**
     * Ask for frame `index` next. Only a rewind past the current position needs the container
     * to re-feed from a keyframe, which the engine handles; forward seeks are served by
     * discarding.
     */
    setDiscardTarget(index: number): void {
        this.discardTarget = index;
    }

    /** Drop every queued frame and reset the decoder — used when the container rewinds. */
    reset(): void {
        for (const s of this.ring) this.recycle(s);
        this.ring.length = 0;
        if (this.current) { this.recycle(this.current); this.current = null; }
        this.currentBgra = null;
        this.currentI420 = null;
        this.consumed = 0;
        this.discardTarget = 0;
        this.inputEnded = false;
        this.outstanding = 0;
        // The re-configure below is the point at which a previous decode error stops applying;
        // leaving it latched makes pushPacket refuse for ever and a seek reads as a permanent
        // starve instead of the error it was.
        this.lastError = null;
        try { this.decoder?.reset(); } catch { /* a reset on a closed decoder is not an error */ }
        // reset() clears the configuration; nothing else re-applies it.
        if (this.decoder && this.decoder.state !== "closed") this.decoder.configure(this.config);
    }

    stats(): WebCodecsStats {
        return {
            ...this.stat,
            ringDepth: this.ring.length,
            ringCapacity: this.ringCapacity,
            decodeQueueSize: this.decoder?.decodeQueueSize ?? 0,
            outstandingPackets: this.outstanding,
            nativeFormat: this.nativeFormat,
            error: this.lastError,
            endOfStream: this.isEndOfStream(),
        };
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const s of this.ring) this.recycle(s);
        this.ring.length = 0;
        if (this.current) { this.recycle(this.current); this.current = null; }
        this.currentBgra = null;
        this.currentI420 = null;
        this.pool.length = 0;
        this.poolBytes = 0;
        try { this.decoder?.close(); } catch { /* already closed */ }
        this.decoder = null;
    }

    // ── buffer pool ───────────────────────────────────────────────────────────

    private take(size: number): Uint8Array {
        for (let i = 0; i < this.pool.length; i++) {
            if (this.pool[i]!.byteLength === size) {
                const buf = this.pool.splice(i, 1)[0]!;
                this.poolBytes -= size;
                return buf;
            }
        }
        return new Uint8Array(size);
    }

    private give(buf: Uint8Array): void {
        // The pool is capacity-bounded like the ring: a stale size must not accumulate.
        if (this.pool.length >= this.ringCapacity + 2) return;
        this.pool.push(buf);
        this.poolBytes += buf.byteLength;
    }

    private recycle(slot: Slot): void {
        if (slot.native) this.give(slot.native);
        else if (slot.bgraDirect) this.give(slot.bgraDirect);
        slot.native = null;
        slot.bgraDirect = null;
        slot.layout = null;
    }

    /** Bytes held by the ring plus pool — the number the byte budget is about. */
    heldBytes(): number {
        let bytes = this.poolBytes;
        for (const s of this.ring) bytes += s.bytes;
        if (this.current) bytes += this.current.bytes;
        if (this.currentBgra) bytes += this.currentBgra.byteLength;
        return bytes;
    }
}
