// Unit tests for the WebCodecs → sync/pull bridge (src/video/webcodecs-backend.ts) and the
// WebM codec-string mapping (src/video/webm-source.ts).
//
// WebCodecs does not exist in bun, so the decoder is FAKED — which is the point: a fake can do
// what a real decoder will not do on demand (resolve frame copies out of order, emit more frames
// than the ring can hold, fail a copy), and those are exactly the paths where a push/pull bridge
// silently loses or reorders frames. The real-browser half of the verification runs through the
// harness in the worker scope.
//
// Every counter assertion is two-sided: a bridge that decoded ZERO frames must not be able to
// pass a test about frame handling.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { WebCodecsVideoSession, convertI420ToBgra, type I420Frame } from "../../src/video/webcodecs-backend";
import { codecStringFor } from "../../src/video/webm-source";
import type { MatroskaTrack } from "@bottleship/formats/matroska";

/* ── fake WebCodecs ──────────────────────────────────────────────────────── */

interface FakeFrameOptions {
    format?: string;
    /** Delay (in resolved-promise ticks) before this frame's copyTo settles. */
    copyDelay?: number;
    failCopy?: boolean;
}

let liveFrames = 0;
let framesCreated = 0;
let framesClosed = 0;

class FakeVideoFrame {
    format: string;
    timestamp: number;
    colorSpace = { matrix: "bt709", fullRange: false, primaries: "bt709", transfer: "bt709" };
    closed = false;
    private width: number;
    private height: number;
    private opts: FakeFrameOptions;
    /** Byte written into every plane, so a reordering shows up in the DATA too. */
    readonly marker: number;

    constructor(width: number, height: number, timestamp: number, marker: number, opts: FakeFrameOptions = {}) {
        this.width = width;
        this.height = height;
        this.timestamp = timestamp;
        this.marker = marker;
        this.opts = opts;
        this.format = opts.format ?? "I420";
        liveFrames++;
        framesCreated++;
    }

    allocationSize(options?: { format?: string }): number {
        if (options?.format === "BGRA") return this.width * this.height * 4;
        return this.width * this.height + 2 * ((this.width + 1) >> 1) * ((this.height + 1) >> 1);
    }

    async copyTo(buf: Uint8Array, options?: { format?: string }): Promise<{ offset: number; stride: number }[]> {
        for (let i = 0; i < (this.opts.copyDelay ?? 0); i++) await Promise.resolve();
        await new Promise<void>((r) => setTimeout(r, this.opts.copyDelay ? this.opts.copyDelay : 0));
        if (this.closed) throw new Error("copyTo on a closed frame");
        if (this.opts.failCopy) throw new Error("synthetic copy failure");
        buf.fill(this.marker);
        if (options?.format === "BGRA") return [{ offset: 0, stride: this.width * 4 }];
        const ySize = this.width * this.height;
        const cw = (this.width + 1) >> 1;
        const ch = (this.height + 1) >> 1;
        return [
            { offset: 0, stride: this.width },
            { offset: ySize, stride: cw },
            { offset: ySize + cw * ch, stride: cw },
        ];
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        liveFrames--;
        framesClosed++;
    }
}

class FakeVideoDecoder {
    state = "unconfigured";
    decodeQueueSize = 0;
    configureCalls = 0;
    resetCalls = 0;
    lastConfig: unknown = null;
    private output: (f: unknown) => void;
    private queue: { timestamp: number; marker: number }[] = [];
    private marker = 1;

    constructor(init: { output: (f: unknown) => void; error: (e: unknown) => void }) {
        this.output = init.output;
    }

    /** Set per-frame behavior for the frames this decoder will emit next. */
    frameOptions: FakeFrameOptions = {};
    width = 4;
    height = 4;

    configure(cfg: unknown): void {
        this.state = "configured";
        this.configureCalls++;
        this.lastConfig = cfg;
    }

    decode(chunk: { timestamp: number }): void {
        this.decodeQueueSize++;
        this.queue.push({ timestamp: chunk.timestamp, marker: this.marker++ });
    }

    /**
     * Emit `n` frames the way Chrome does when delivery lags the queue drain: decodeQueueSize
     * drops immediately, the output callback fires on a later task.
     */
    emitDeferred(n = Infinity): void {
        while (n-- > 0 && this.queue.length > 0) {
            const q = this.queue.shift()!;
            this.decodeQueueSize--;
            setTimeout(() => this.output(new FakeVideoFrame(this.width, this.height, q.timestamp, q.marker, this.frameOptions)), 0);
        }
    }

    /** Emit `n` queued frames (the fake's stand-in for the decoder's own pacing). */
    emit(n = Infinity): void {
        while (n-- > 0 && this.queue.length > 0) {
            const q = this.queue.shift()!;
            this.decodeQueueSize--;
            this.output(new FakeVideoFrame(this.width, this.height, q.timestamp, q.marker, this.frameOptions));
        }
    }

    /** Deferred, like the real one: flush() returns a promise and emits later, so a caller
     *  cannot observe the queue as already drained on the line after calling it. */
    async flush(): Promise<void> {
        await new Promise<void>((r) => setTimeout(r, 0));
        this.emit();
    }

    reset(): void {
        this.resetCalls++;
        this.queue.length = 0;
        this.decodeQueueSize = 0;
        this.state = "unconfigured";
    }

    close(): void {
        this.state = "closed";
        this.queue.length = 0;
    }
}

class FakeEncodedVideoChunk {
    type: string;
    timestamp: number;
    byteLength: number;
    constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.byteLength = init.data.byteLength;
    }
}

const globals = globalThis as unknown as Record<string, unknown>;
let savedChunk: unknown;

beforeEach(() => {
    savedChunk = globals.EncodedVideoChunk;
    globals.EncodedVideoChunk = FakeEncodedVideoChunk;
    liveFrames = 0;
    framesCreated = 0;
    framesClosed = 0;
});

afterEach(() => {
    globals.EncodedVideoChunk = savedChunk;
});

/** Let queued microtasks and timer callbacks (the copyTo settlements) run. */
async function settle(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

function makeSession(opts: { width?: number; height?: number; ringBudgetBytes?: number } = {}) {
    let decoder!: FakeVideoDecoder;
    let output!: (f: unknown) => void;
    const width = opts.width ?? 4;
    const height = opts.height ?? 4;
    const session = new WebCodecsVideoSession(
        {
            codec: "vp8", width, height, fps: 25,
            ...(opts.ringBudgetBytes ? { ringBudgetBytes: opts.ringBudgetBytes } : {}),
        },
        ((init: never) => {
            const typed = init as unknown as { output: (f: unknown) => void; error: (e: unknown) => void };
            output = typed.output;
            decoder = new FakeVideoDecoder(typed);
            decoder.width = width;
            decoder.height = height;
            return decoder as unknown as VideoDecoder;
        }) as unknown as (init: VideoDecoderInit) => VideoDecoder,
    );
    return { session, decoder: decoder!, output: output! };
}

const packet = (n: number) => new Uint8Array(8).fill(n);

/* ── tests ───────────────────────────────────────────────────────────────── */

describe("webcodecs bridge: push side", () => {
    it("configures the decoder from the stream config", () => {
        const { decoder } = makeSession({ width: 1920, height: 1080 });
        expect(decoder.configureCalls).toBe(1);
        expect(decoder.state).toBe("configured");
        expect(decoder.lastConfig).toMatchObject({ codec: "vp8", codedWidth: 1920, codedHeight: 1080 });
    });

    it("applies backpressure instead of growing without limit, and loses nothing", () => {
        const { session, decoder } = makeSession();
        let accepted = 0;
        let refused = 0;
        for (let i = 0; i < 200; i++) {
            if (session.pushPacket(packet(i), i * 1000, i === 0)) accepted++; else refused++;
        }
        const stats = session.stats();
        expect(accepted).toBeGreaterThan(0);
        expect(refused).toBeGreaterThan(0);
        // Nothing was accepted beyond the ring's capacity, so nothing can be dropped later.
        expect(accepted).toBeLessThanOrEqual(stats.ringCapacity);
        expect(decoder.decodeQueueSize).toBeLessThanOrEqual(stats.ringCapacity);
        expect(stats.backpressureRejects).toBe(refused);
        expect(stats.framesDropped).toBe(0);
        session.close();
    });

    it("counts in-flight packets ITSELF, so a drained queue with undelivered frames cannot overfill", async () => {
        // decodeQueueSize hits 0 while the frames are still on their way to the callback. Trusting
        // it lets the next pushes through, and the arriving frames then have nowhere to go — which
        // a real 1080p run showed as framesDropped=1.
        const { session, decoder } = makeSession();
        const cap = session.stats().ringCapacity;
        for (let i = 0; i < cap; i++) expect(session.pushPacket(packet(i), i * 1000, i === 0)).toBe(true);
        decoder.emitDeferred();
        expect(decoder.decodeQueueSize).toBe(0);
        expect(session.stats().outstandingPackets).toBe(cap);
        // Every further push must be refused while those frames are undelivered.
        for (let i = 0; i < 5; i++) expect(session.pushPacket(packet(99), 99_000, false)).toBe(false);
        await settle();
        expect(session.stats().framesDecoded).toBe(cap);
        expect(session.stats().framesDropped).toBe(0);
        expect(session.stats().ringDepth).toBe(cap);
        session.close();
    });

    it("sizes the ring from the BYTE budget, not a frame count", () => {
        // 1080p I420 ≈ 3.1 MB: a 10 MB budget must allow 3 frames, not the 12-slot maximum.
        const small = makeSession({ width: 1920, height: 1080, ringBudgetBytes: 10 << 20 });
        expect(small.session.stats().ringCapacity).toBe(3);
        const tiny = makeSession({ width: 1920, height: 1080, ringBudgetBytes: 1 << 20 });
        expect(tiny.session.stats().ringCapacity).toBe(2); // clamped to the minimum
        const big = makeSession({ width: 320, height: 240, ringBudgetBytes: 48 << 20 });
        expect(big.session.stats().ringCapacity).toBe(12); // clamped to the maximum
        small.session.close(); tiny.session.close(); big.session.close();
    });
});

describe("webcodecs bridge: pull side", () => {
    it("doFrame() is false with nothing ready and counts the starve, then true once decoded", async () => {
        const { session, decoder } = makeSession();
        expect(session.pushPacket(packet(1), 0, true)).toBe(true);
        expect(session.doFrame()).toBe(false);
        expect(session.stats().starves).toBe(1);
        expect(session.frameReady()).toBe(false);

        decoder.emit();
        await settle();
        expect(session.frameReady()).toBe(true);
        expect(session.doFrame()).toBe(true);
        expect(session.stats().framesConsumed).toBe(1);
        expect(session.currentTimestampUs()).toBe(0);
        session.close();
    });

    it("preserves frame ORDER when the async copies settle out of order", async () => {
        const { session, decoder } = makeSession();
        // Frame 1 copies slowly, frame 2 quickly: the later frame is ready first.
        session.pushPacket(packet(1), 1000, true);
        decoder.frameOptions = { copyDelay: 4 };
        decoder.emit(1);
        session.pushPacket(packet(2), 2000, false);
        decoder.frameOptions = { copyDelay: 0 };
        decoder.emit(1);

        // Before the slow copy lands, the SECOND frame is ready while the head is not. doFrame()
        // must refuse rather than serve the ready one out of order.
        await settle(1);
        expect(session.frameReady()).toBe(false);
        expect(session.doFrame()).toBe(false);
        await settle(10);

        expect(session.doFrame()).toBe(true);
        expect(session.currentTimestampUs()).toBe(1000);
        const first = session.getI420()!.y[0];
        expect(session.doFrame()).toBe(true);
        expect(session.currentTimestampUs()).toBe(2000);
        // The pixel markers must follow the same order — the ring slot could carry the right
        // timestamp while holding the other frame's buffer.
        expect(session.getI420()!.y[0]).not.toBe(first);
        expect(first).toBe(1);
        expect(session.getI420()!.y[0]).toBe(2);
        session.close();
    });

    it("does not hand out a frame until its copy has landed", async () => {
        const { session, decoder } = makeSession();
        session.pushPacket(packet(1), 0, true);
        decoder.frameOptions = { copyDelay: 3 };
        decoder.emit(1);
        // The slot exists (order is reserved on arrival) but is not ready.
        expect(session.stats().ringDepth).toBe(1);
        expect(session.frameReady()).toBe(false);
        expect(session.doFrame()).toBe(false);
        await settle(10);
        expect(session.doFrame()).toBe(true);
        session.close();
    });

    it("skips a frame whose copy failed rather than serving stale pixels", async () => {
        const { session, decoder } = makeSession();
        session.pushPacket(packet(1), 0, true);
        decoder.frameOptions = { failCopy: true };
        decoder.emit(1);
        session.pushPacket(packet(2), 1000, false);
        decoder.frameOptions = {};
        decoder.emit(1);
        await settle();
        expect(session.doFrame()).toBe(true);
        expect(session.currentTimestampUs()).toBe(1000);
        expect(session.stats().copyFailures).toBe(1);
        session.close();
    });

    it("separates 'still decoding' from 'end of stream'", async () => {
        const { session, decoder } = makeSession();
        session.pushPacket(packet(1), 0, true);
        expect(session.doFrame()).toBe(false);
        expect(session.isEndOfStream()).toBe(false); // false ≠ EOF
        decoder.emit();
        await settle();
        expect(session.doFrame()).toBe(true);
        expect(session.isEndOfStream()).toBe(false); // input not declared over
        session.signalEndOfInput();
        expect(session.isEndOfStream()).toBe(true);
        expect(session.doFrame()).toBe(false);
        session.close();
    });

    it("does not report EOF while the decoder still holds the tail of the stream", async () => {
        // The decoder's own queue IS the tail: reporting EOF on an empty ring alone loses every
        // frame the decoder has not emitted yet, which is what a real 102-frame clip showed as 90.
        const { session, decoder } = makeSession();
        for (let i = 0; i < 5; i++) session.pushPacket(packet(i), i * 1000, i === 0);
        decoder.emit(2);
        await settle();
        while (session.doFrame()) { /* drain what is ready */ }
        session.signalEndOfInput();
        expect(decoder.decodeQueueSize).toBeGreaterThan(0);
        expect(session.isEndOfStream()).toBe(false);
        await settle();  // signalEndOfInput kicks a flush, which emits the tail
        let tail = 0;
        while (session.doFrame()) tail++;
        expect(tail).toBe(3);
        expect(session.stats().framesConsumed).toBe(5);
        expect(session.isEndOfStream()).toBe(true);
        session.close();
    });

    it("does not report EOF while the LAST frame is still on its way to the callback", async () => {
        // decodeQueueSize is already 0 here; only our own in-flight count knows the frame exists.
        // A consumer polling isEndOfStream() drops exactly this frame otherwise.
        const { session, decoder } = makeSession();
        session.pushPacket(packet(1), 0, true);
        decoder.emitDeferred();
        expect(decoder.decodeQueueSize).toBe(0);
        session.signalEndOfInput();
        expect(session.isEndOfStream()).toBe(false);
        await settle();
        expect(session.doFrame()).toBe(true);
        expect(session.stats().framesConsumed).toBe(1);
        expect(session.isEndOfStream()).toBe(true);
        session.close();
    });

    it("advances currentFrameIndex per consumed frame", async () => {
        const { session, decoder } = makeSession();
        for (let i = 0; i < 3; i++) session.pushPacket(packet(i), i * 1000, i === 0);
        decoder.emit();
        await settle();
        const seen: number[] = [];
        while (session.doFrame()) seen.push(session.currentFrameIndex());
        expect(seen).toEqual([0, 1, 2]);
        session.close();
    });

    it("discards forward to a seek target", async () => {
        const { session, decoder } = makeSession();
        for (let i = 0; i < 4; i++) session.pushPacket(packet(i), i * 1000, i === 0);
        decoder.emit();
        await settle();
        session.setDiscardTarget(2);
        expect(session.doFrame()).toBe(true);
        expect(session.currentTimestampUs()).toBe(2000);
        session.close();
    });
});

describe("webcodecs bridge: frame ownership", () => {
    it("closes every VideoFrame it is handed, and holds none after close()", async () => {
        const { session, decoder } = makeSession();
        for (let i = 0; i < 5; i++) session.pushPacket(packet(i), i * 1000, i === 0);
        decoder.emit();
        await settle();
        // Every arrived frame is copied and closed in its own callback — nothing survives to be
        // consumed, so the count is already complete before any doFrame().
        expect(framesCreated).toBe(5);
        expect(framesClosed).toBe(5);
        expect(liveFrames).toBe(0);
        session.doFrame();
        session.close();
        expect(liveFrames).toBe(0);
        expect(session.heldBytes()).toBe(0);
    });

    it("closes frames that arrive after close() instead of retaining them", async () => {
        const { session, output } = makeSession();
        session.pushPacket(packet(1), 0, true);
        session.close();
        // A real decoder can deliver a frame decoded before close(); the callback outlives the
        // session, and a frame it merely ignores is a leak.
        output(new FakeVideoFrame(4, 4, 0, 9));
        await settle();
        expect(framesCreated).toBe(1);
        expect(liveFrames).toBe(0);
        expect(framesClosed).toBe(1);
    });

    it("keeps held bytes inside the ring budget", async () => {
        const { session, decoder } = makeSession({ width: 640, height: 480, ringBudgetBytes: 4 << 20 });
        for (let i = 0; i < 40; i++) session.pushPacket(packet(i), i * 1000, i === 0);
        decoder.emit();
        await settle();
        const cap = session.stats().ringCapacity;
        const frameBytes = 640 * 480 * 1.5;
        expect(session.stats().framesDecoded).toBeGreaterThan(0);
        // Ring + pool + at most one converted BGRA frame.
        expect(session.heldBytes()).toBeLessThanOrEqual((cap + 2) * frameBytes + 640 * 480 * 4);
        expect(session.stats().framesDropped).toBe(0);
        session.close();
    });

    it("re-configures the decoder after reset() so the stream keeps decoding", async () => {
        const { session, decoder } = makeSession();
        session.pushPacket(packet(1), 0, true);
        decoder.emit();
        await settle();
        expect(session.doFrame()).toBe(true);
        session.reset();
        expect(decoder.resetCalls).toBe(1);
        expect(decoder.configureCalls).toBe(2);
        expect(decoder.state).toBe("configured");
        expect(session.currentFrameIndex()).toBe(0);
        expect(session.pushPacket(packet(2), 0, true)).toBe(true);
        session.close();
    });
});

describe("webcodecs bridge: pixel output", () => {
    /** Independent float reference for BT.601 full-range YUV→RGB. */
    function referenceRgb(y: number, u: number, v: number): [number, number, number] {
        const r = y + 1.402 * (v - 128);
        const g = y - 0.344136 * (u - 128) - 0.714136 * (v - 128);
        const b = y + 1.772 * (u - 128);
        const cl = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
        return [cl(r), cl(g), cl(b)];
    }

    function solidI420(width: number, height: number, y: number, u: number, v: number): I420Frame {
        const cw = width >> 1, ch = height >> 1;
        return {
            y: new Uint8Array(width * height).fill(y),
            u: new Uint8Array(cw * ch).fill(u),
            v: new Uint8Array(cw * ch).fill(v),
            strideY: width, strideU: cw, strideV: cw,
            width, height,
        };
    }

    it("writes BGRA in that byte order — verified PER CHANNEL, not by luminance", () => {
        // BT.601 full-range values for pure primaries.
        const cases: Array<{ name: string; yuv: [number, number, number]; expect: [number, number, number] }> = [
            { name: "red", yuv: [76, 84, 255], expect: [255, 0, 0] },
            { name: "green", yuv: [149, 43, 21], expect: [0, 255, 0] },
            { name: "blue", yuv: [29, 255, 107], expect: [0, 0, 255] },
        ];
        for (const c of cases) {
            const src = solidI420(4, 4, c.yuv[0], c.yuv[1], c.yuv[2]);
            const out = new Uint8Array(4 * 4 * 4);
            convertI420ToBgra(src, out, "smpte170m", true);
            const [r, g, b] = c.expect;
            // Byte 0 is BLUE, byte 2 is RED. An RGBA writer passes any luminance check and fails
            // here, which is the point.
            expect(Math.abs(out[0]! - b)).toBeLessThanOrEqual(3);
            expect(Math.abs(out[1]! - g)).toBeLessThanOrEqual(3);
            expect(Math.abs(out[2]! - r)).toBeLessThanOrEqual(3);
            expect(out[3]).toBe(255);
        }
    });

    it("matches an independent float reference across the YUV cube", () => {
        let worst = 0;
        for (let y = 0; y <= 255; y += 17) {
            for (let u = 0; u <= 255; u += 51) {
                for (let v = 0; v <= 255; v += 51) {
                    const out = new Uint8Array(2 * 2 * 4);
                    convertI420ToBgra(solidI420(2, 2, y, u, v), out, "smpte170m", true);
                    const [r, g, b] = referenceRgb(y, u, v);
                    worst = Math.max(worst, Math.abs(out[0]! - b), Math.abs(out[1]! - g), Math.abs(out[2]! - r));
                }
            }
        }
        expect(worst).toBeLessThanOrEqual(2);
    });

    it("distinguishes BT.709 from BT.601 and limited from full range", () => {
        const src = solidI420(2, 2, 128, 200, 60);
        const a = new Uint8Array(16); convertI420ToBgra(src, a, "smpte170m", true);
        const b = new Uint8Array(16); convertI420ToBgra(src, b, "bt709", true);
        const c = new Uint8Array(16); convertI420ToBgra(src, c, "smpte170m", false);
        expect(Array.from(a.subarray(0, 3))).not.toEqual(Array.from(b.subarray(0, 3)));
        expect(Array.from(a.subarray(0, 3))).not.toEqual(Array.from(c.subarray(0, 3)));
    });

    it("respects chroma strides and subsampling (not a same-stride special case)", () => {
        // Luma padded to a wider stride than the visible width; chroma likewise.
        const width = 4, height = 4;
        const strideY = 6, strideU = 3;
        const y = new Uint8Array(strideY * height);
        // Chroma varies per row: with a constant plane a wrong chroma stride reads the wrong
        // row and produces identical output, so the check would pass while broken.
        const u = new Uint8Array(strideU * (height >> 1));
        const v = new Uint8Array(strideU * (height >> 1));
        for (let cr = 0; cr < (height >> 1); cr++) {
            for (let cc = 0; cc < (width >> 1); cc++) {
                u[cr * strideU + cc] = 128;
                v[cr * strideU + cc] = 128 + cr * 40;
            }
            u[cr * strideU + 2] = 30; v[cr * strideU + 2] = 30; // padding must be ignored
        }
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) y[row * strideY + col] = 10 + row * 4 + col;
            y[row * strideY + 4] = 200; y[row * strideY + 5] = 201; // padding must be ignored
        }
        const out = new Uint8Array(width * height * 4);
        convertI420ToBgra({ y, u, v, strideY, strideU, strideV: strideU, width, height }, out, "smpte170m", true);
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const lum = 10 + row * 4 + col;
                const o = (row * width + col) * 4;
                // B channel: U is neutral everywhere, so it tracks luma exactly.
                expect(Math.abs(out[o]! - lum)).toBeLessThanOrEqual(2);
                // R channel: V is row-dependent, so it pins WHICH chroma row was read.
                const expectedR = Math.max(0, Math.min(255, Math.round(lum + 1.402 * ((128 + (row >> 1) * 40) - 128))));
                expect(Math.abs(out[o + 2]! - expectedR)).toBeLessThanOrEqual(2);
            }
        }
    });

    it("exposes I420 planes with the decoder's own strides, and BGRA derived from them", async () => {
        const { session, decoder } = makeSession({ width: 4, height: 4 });
        session.pushPacket(packet(7), 0, true);
        decoder.emit();
        await settle();
        expect(session.doFrame()).toBe(true);
        const i420 = session.getI420()!;
        expect(i420).not.toBeNull();
        expect(i420.width).toBe(4);
        expect(i420.strideY).toBe(4);
        expect(i420.y.length).toBe(16);
        expect(i420.u.length).toBe(4);
        expect(i420.y.every((b) => b === 1)).toBe(true);
        const bgra = session.getBgra()!;
        expect(bgra.length).toBe(4 * 4 * 4);
        // Y=1, U=V=1 is a near-black, near-neutral pixel; opaque alpha is non-negotiable.
        expect(bgra[3]).toBe(255);
        expect(session.stats().nativeFormat).toBe("I420");
        session.close();
    });

    it("uses the decoder's BGRA conversion when the native format is not I420", async () => {
        const { session, decoder } = makeSession({ width: 4, height: 4 });
        decoder.frameOptions = { format: "NV12" };
        session.pushPacket(packet(1), 0, true);
        decoder.emit();
        await settle();
        expect(session.doFrame()).toBe(true);
        expect(session.getI420()).toBeNull(); // honest: no planar route for this frame
        const bgra = session.getBgra()!;
        expect(bgra.length).toBe(4 * 4 * 4);
        expect(bgra.every((b) => b === 1)).toBe(true);
        expect(session.stats().nativeFormat).toBe("NV12");
        session.close();
    });
});

describe("webm-source: codec strings", () => {
    const track = (over: Partial<MatroskaTrack>): MatroskaTrack => ({
        number: 1, uid: null, kind: "video", type: 1, codecId: "V_VP8", codecPrivate: null,
        language: "und", name: "", defaultDurationNs: 40_000_000, lacingAllowed: false,
        width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080,
        sampleRate: 0, outputSampleRate: 0, channels: 0, bitDepth: 0,
        compressed: false, encrypted: false, encodingUnreadable: false,
        ...over,
    });

    it("maps VP8 with no description", () => {
        expect(codecStringFor(track({}))).toEqual({ codec: "vp8" });
    });

    it("DERIVES the H.264 codec string from avcC rather than assuming baseline", () => {
        // avcC: [version][profile][compat][level] — High profile (0x64), level 4.0 (0x28).
        const avcC = Uint8Array.from([0x01, 0x64, 0x00, 0x28, 0xff, 0xe1]);
        const r = codecStringFor(track({ codecId: "V_MPEG4/ISO/AVC", codecPrivate: avcC }));
        expect(r.codec).toBe("avc1.640028");
        expect(r.description).toBe(avcC);
        // A different profile must produce a different string — a hardcoded constant would not.
        const baseline = Uint8Array.from([0x01, 0x42, 0xc0, 0x1e]);
        expect(codecStringFor(track({ codecId: "V_MPEG4/ISO/AVC", codecPrivate: baseline })).codec).toBe("avc1.42C01E");
    });

    it("reads VP9 profile/level/depth from vpcC when present", () => {
        const vpcC = Uint8Array.from([0x02, 0x1f, 0xa0, 0x00, 0x00, 0x00]);
        expect(codecStringFor(track({ codecId: "V_VP9", codecPrivate: vpcC })).codec).toBe("vp09.02.31.10");
        expect(codecStringFor(track({ codecId: "V_VP9" })).codec).toBe("vp09.00.10.08");
    });

    it("refuses a codec it has no mapping for, and H.264 with no avcC", () => {
        expect(() => codecStringFor(track({ codecId: "V_AV1" }))).toThrow(/no WebCodecs mapping/);
        expect(() => codecStringFor(track({ codecId: "V_MPEG4/ISO/AVC" }))).toThrow(/no avcC/);
    });
});
