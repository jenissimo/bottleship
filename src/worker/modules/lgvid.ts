/**
 * lgvid.dll HLE — the Dark Engine's video module (SS2 NewDark, Thief 1/2/Gold).
 *
 * The shipped DLL front-ends a bundled ffmpeg.dll; we answer its two exports with the
 * native VideoEngine instead, so Indeo5 + rescale run as WASM rather than as emulated
 * x86 on top of the game.
 *
 * DIVISION OF LABOUR — the engine keeps everything it already owns:
 *   - it resolves the movie path (`movie_path` / `fm_movie_dir`) and hands it to us,
 *   - it allocates the frame buffers, owns their pixel format, and presents them,
 *   - it owns the sound stream and pulls PCM from us.
 * We only decode and fill pixels. That is why nothing here touches D3D or the VFS
 * layout: the two things a per-game shortcut would have had to guess are given to us.
 *
 * Calling into the guest: the host's ShowFrame/EndFrame present through d3d9, so they
 * are not leaf functions and `sync-guest-call` cannot run them. Every host call goes
 * through the suspended-thunk callback chain instead — the same JS→x86 re-entry
 * DispatchMessage uses. Each of our methods opens at most one short chain and
 * completes in the same thunk, so no async thunk (and no `startCallbackChain`) is
 * needed; the file read is the one genuinely async step and is polled by BeginFrame
 * returning "not ready" until it lands.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult, X86Context } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { videoEngine } from "../../video/video-engine";
import { createVTablesFromDescriptor, VTableInfo } from "../api/adapters/module-adapter";
import { lgvidModule } from "../api/lgvid.api";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";

/** Host vtable slots lgvid uses (byte offsets, __stdcall, `this` pushed first). */
const HOST_GET_PIXEL_FORMAT = 0x24;
const HOST_ALLOC_FRAME_BUFFER = 0x28;
const HOST_LOCK_FRAME_BUFFER = 0x2c;
const HOST_SHOW_FRAME = 0x34;
const HOST_END_FRAME = 0x38;

/**
 * Field offsets inside the 11-dword struct GetPixelFormat fills. Read off the real
 * DLL's own consumer (lgvid 0x10003880-0x10003919): it anchors the struct with
 * `LEA ECX,[ESP+0xc]` at 0x10003878 and then tests these four slots against the
 * mask constants that select an ffmpeg PIX_FMT — 0x1b/0x1c/0x1d/0x1e for the four
 * 32-bit channel orders, 0x2c/0x30 for 16-bit. The 16-bit branch reads
 * (0xf800, 0x07e0, 0x001f), i.e. plain RGB565, which pins which slot is which.
 */
const PIXFMT_BPP = 0x08;
const PIXFMT_R_MASK = 0x0c;
const PIXFMT_G_MASK = 0x10;
const PIXFMT_B_MASK = 0x14;

/**
 * The host's frame-buffer object, as SS2's own ShowFrame (0x6db230) reads it:
 * row length is `bytesPerPixel * width`, rows advance by `pitch`, and it copies
 * `height` rows with NO scaling — so the buffer is already display-sized and the
 * movie must be scaled into it (which is what the real DLL's sws_scale does, and
 * what `movie_sw_scale_quality` tunes).
 */
const FB_WIDTH = 0x08;             // u16
const FB_HEIGHT = 0x0a;            // u16
const FB_PITCH = 0x0c;             // u16
const FB_BYTES_PER_PIXEL = 0x11;   // u8

/** Our IMoviePlayer1 object: vtable pointer then our session id. */
const PLAYER_OBJECT_SIZE = 8;

/** Scratch for a host out-parameter (LockFrameBuffer writes 2 dwords). */
const OUT_SCRATCH_BYTES = 16;

interface PixelFormat {
    bpp: number;
    rMask: number;
    gMask: number;
    bMask: number;
}

interface Session {
    objPtr: number;
    host: number;
    hostVtbl: number;
    path: string;
    engineHandle: number;
    /** null until the async open settles; false once it has failed for good. */
    opened: boolean | null;
    width: number;
    height: number;
    fps: number;
    frameCount: number;
    started: boolean;
    done: boolean;
    startMs: number;
    /** Frames delivered to the host so far — drives the presentation clock. */
    shownFrames: number;
    format: PixelFormat | null;
    frameBuffers: number[];
    /** Index of the buffer BeginFrame filled and EndFrame must show. */
    armedBuffer: number;
    outScratch: number;
    /** Resample tables, rebuilt only if the destination geometry changes. */
    scale: ScaleTables | null;
    /** Wall-clock attributed to the decoder and to the scaler, per CALL (not per
     *  shown frame — the two differ exactly when we are behind, which is the case
     *  worth measuring). */
    decodeMs: number;
    scaleMs: number;
    decodeCalls: number;
    scaleCalls: number;
}

/** Fixed-point source indices and 0..255 blend weights, one entry per dst pixel. */
interface ScaleTables {
    dstW: number;
    dstH: number;
    x0: Int32Array;
    x1: Int32Array;
    wx: Int32Array;
    y0: Int32Array;
    y1: Int32Array;
    wy: Int32Array;
}

/** One step of a guest-call chain: the target and its stdcall arguments. */
interface GuestCall {
    fn: number;
    args: number[];
}

export class Lgvid implements IModule {
    name = "lgvid";
    exports: Record<string, ThunkImplementation> = {};

    private process!: Process;
    private vtables: Record<string, VTableInfo> | null = null;
    private sessions: Map<number, Session> = new Map();
    private nextSessionId = 1;

    initialize(process: Process): void {
        this.process = process;
        this.vtables = null;
        this.sessions.clear();
        this.registerExports();
    }

    reset(): void {
        for (const s of this.sessions.values()) {
            if (s.engineHandle) videoEngine.close(s.engineHandle);
        }
        this.sessions.clear();
        this.vtables = null;
    }

    recreateVTables(): void {
        this.vtables = null;
    }

    reregisterExports(process: Process): void {
        this.process = process;
        this.vtables = null;
        this.registerExports();
    }

    private getVTables(): Record<string, VTableInfo> {
        if (!this.vtables) {
            this.vtables = createVTablesFromDescriptor(this.process, lgvidModule);
        }
        return this.vtables;
    }

    // ==================== exports ====================

    private registerExports(): void {
        const create: ThunkImplementation = (_ctx, memory, args) =>
            this.createDecoder(memory, args[0] ?? 0, args[1] ?? 0);
        this.exports["CreateLGVideoDecoder"] = create;
        this.exports["CreateLGVideoDecoder2"] = create;

        this.exports["IMoviePlayer1_Destroy"] = (_ctx, _memory, args) => this.destroy(args[0] ?? 0);
        this.exports["IMoviePlayer1_DeleteDtor"] = (_ctx, _memory, args) => this.destroy(args[0] ?? 0);
        this.exports["IMoviePlayer1_Play"] = (_ctx, _memory, args) => this.play(args[0] ?? 0);
        this.exports["IMoviePlayer1_IsDone"] = (_ctx, _memory, args) => this.isDone(args[0] ?? 0);
        this.exports["IMoviePlayer1_GetTime"] = (_ctx, _memory, args) => this.getTime(args[0] ?? 0);
        this.exports["IMoviePlayer1_BeginFrame"] = (ctx, memory, args) => this.beginFrame(ctx, memory, args[0] ?? 0);
        this.exports["IMoviePlayer1_EndFrame"] = (ctx, memory, args) => this.endFrame(ctx, memory, args[0] ?? 0);
        this.exports["IMoviePlayer1_FillAudio"] = (_ctx, _memory, args) => this.fillAudio(args[0] ?? 0, args[1] ?? 0);
    }

    private session(objPtr: number): Session | null {
        return this.sessions.get(objPtr >>> 0) ?? null;
    }

    // ==================== creation ====================

    private createDecoder(mem: Uint8Array, host: number, pathPtr: number): number {
        if (!host || !pathPtr) return 0;
        const path = this.readCString(mem, pathPtr);
        if (!path) return 0;

        const vt = this.getVTables()["IMoviePlayer1"];
        if (!vt) {
            Logger.error(LogCategory.SYSTEM, "lgvid: IMoviePlayer1 vtable unavailable");
            return 0;
        }

        const objPtr = this.process.memory.alloc(PLAYER_OBJECT_SIZE, "THUNK_DATA", "rw");
        const outScratch = this.process.memory.alloc(OUT_SCRATCH_BYTES, "THUNK_DATA", "rw");
        const id = this.nextSessionId++;
        Mem.writeUint32(objPtr, vt.address);
        Mem.writeUint32(objPtr + 4, id);

        const session: Session = {
            objPtr, host, hostVtbl: (Mem.readUint32(host) ?? 0) >>> 0, path,
            engineHandle: 0, opened: null,
            width: 0, height: 0, fps: 0, frameCount: 0,
            started: false, done: false, startMs: 0, shownFrames: 0,
            format: null, frameBuffers: [], armedBuffer: -1, outScratch, scale: null, decodeMs: 0, scaleMs: 0, decodeCalls: 0, scaleCalls: 0,
        };
        this.sessions.set(objPtr, session);

        Logger.log(LogCategory.SYSTEM, `lgvid: CreateLGVideoDecoder("${path}") -> 0x${objPtr.toString(16)}`);
        void this.openMovie(session);
        return objPtr;
    }

    /**
     * Read + open the movie off the thunk's critical path; BeginFrame polls `opened`.
     * The guest can Destroy the player across either await — a cutscene the player skips
     * immediately does exactly that — and `destroy` then sees engineHandle 0 and closes
     * nothing. Re-check that the session is still the registered one after each await, or
     * the decoder and its frame buffers outlive it for the life of the process.
     */
    private async openMovie(s: Session): Promise<void> {
        const stillLive = () => this.sessions.get(s.objPtr) === s;
        try {
            const bytes = await this.readVfsFile(s.path);
            if (!stillLive()) return;
            if (!bytes) {
                Logger.warn(LogCategory.SYSTEM, `lgvid: movie not found: ${s.path}`);
                s.opened = false;
                s.done = true;
                return;
            }
            const handle = await videoEngine.open(bytes);
            if (!stillLive()) { videoEngine.close(handle); return; }
            const info = videoEngine.getInfo(handle);
            if (!info) {
                videoEngine.close(handle);
                s.opened = false;
                s.done = true;
                return;
            }
            s.engineHandle = handle;
            s.width = info.width;
            s.height = info.height;
            s.fps = info.fps > 0 ? info.fps : 15;
            s.frameCount = info.frameCount;
            s.opened = true;
            Logger.log(LogCategory.SYSTEM,
                `lgvid: opened ${s.path} — ${info.width}x${info.height} ${s.fps.toFixed(2)}fps ${info.frameCount}f`);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `lgvid: open failed for ${s.path}: ${e}`);
            s.opened = false;
            s.done = true;
        }
    }

    private async readVfsFile(path: string): Promise<Uint8Array | null> {
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(path);
            if (size <= 0) return null;
            const handle = await vfs.open(path, 0x80000000 /* GENERIC_READ */, 3 /* OPEN_EXISTING */);
            if (!handle) return null;
            return await vfs.read(handle, size);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `lgvid: readVfsFile("${path}") failed: ${e}`);
            return null;
        }
    }

    // ==================== simple methods ====================

    private destroy(objPtr: number): number {
        const s = this.session(objPtr);
        if (!s) return 0;
        if (s.engineHandle) videoEngine.close(s.engineHandle);
        this.sessions.delete(objPtr >>> 0);
        // Decode and scale are reported PER CALL, which equals per shown frame only while
        // we keep up. The scaler shares the worker with the guest and the audio ring, so a
        // regression here is heard before it is seen.
        Logger.log(LogCategory.SYSTEM,
            `lgvid: destroyed 0x${objPtr.toString(16)} (${s.shownFrames} frames shown) ` +
            `decode=${(s.decodeMs / Math.max(1, s.decodeCalls)).toFixed(2)}ms x${s.decodeCalls} ` +
            `scale=${(s.scaleMs / Math.max(1, s.scaleCalls)).toFixed(2)}ms x${s.scaleCalls}`);
        return objPtr >>> 0;
    }

    private play(objPtr: number): number {
        const s = this.session(objPtr);
        if (!s) return 0;
        s.started = true;
        s.startMs = performance.now();
        return 1;
    }

    private isDone(objPtr: number): number {
        const s = this.session(objPtr);
        if (!s) return 1;
        return s.done ? 1 : 0;
    }

    /** Presentation clock in ms — frames actually shown, not wall clock, so a slow
     *  host stretches the movie instead of silently dropping the whole thing. */
    private getTime(objPtr: number): number {
        const s = this.session(objPtr);
        if (!s || !s.fps) return 0;
        return Math.round((s.shownFrames / s.fps) * 1000);
    }

    private fillAudio(objPtr: number, _bytes: number): number {
        const s = this.session(objPtr);
        if (!s) return 0;
        // Audio is decoded alongside video and drained into the engine's SAB;
        // the host's pull path gets silence rather than a stalled mixer.
        return 0;
    }

    // ==================== frame path ====================

    /**
     * Returns 1 only when a frame is sitting in a host buffer ready to show. The
     * first call also acquires the format and the two buffers, which needs guest
     * calls, so it costs one extra "not ready" round trip — the game's movie loop
     * polls, so that is a frame of latency, not a stall.
     */
    private beginFrame(ctx: X86Context, mem: Uint8Array, objPtr: number): number | ThunkResult {
        const s = this.session(objPtr);
        if (!s || s.done) return 0;
        if (s.opened !== true) return 0;

        if (!s.format || s.frameBuffers.length < 2) {
            return this.acquireBuffers(ctx, mem, s) ?? 0;
        }

        // A frame already prepared and waiting for EndFrame is the answer; decoding
        // another one here would throw it away. The real DLL decodes on its own thread
        // into a two-deep queue and BeginFrame only asks whether one is ready — polling
        // it must stay O(1), or falling behind makes every poll cost a whole frame and
        // the player never catches up.
        if (s.armedBuffer >= 0) return 1;
        if (!this.frameDue(s)) return 0;
        if (!this.decodeNextFrame(s)) return 0;

        const buffer = s.frameBuffers[s.shownFrames % s.frameBuffers.length];
        const chain = this.callGuest(ctx, mem, "lgvid:LockFrameBuffer",
            [{ fn: this.hostSlot(s, HOST_LOCK_FRAME_BUFFER), args: [s.host, buffer, s.outScratch] }],
            4,
            (results) => {
                if (!results[0]) return 0;
                const pixels = (Mem.readUint32(s.outScratch) ?? 0) >>> 0;
                const pitch = (Mem.readUint32(s.outScratch + 4) ?? 0) >>> 0;
                if (!this.writeFrame(s, pixels, pitch, buffer)) return 0;
                videoEngine.nextFrame(s.engineHandle);   // pixels consumed — advance
                s.armedBuffer = buffer;
                return 1;
            });
        return chain ?? 0;
    }

    /** ShowFrame + EndFrame on the host, in that order — the real DLL's sequence. */
    private endFrame(ctx: X86Context, mem: Uint8Array, objPtr: number): number | ThunkResult {
        const s = this.session(objPtr);
        if (!s || s.armedBuffer < 0) return 0;
        const buffer = s.armedBuffer;
        s.armedBuffer = -1;
        s.shownFrames++;
        const chain = this.callGuest(ctx, mem, "lgvid:ShowFrame", [
            { fn: this.hostSlot(s, HOST_SHOW_FRAME), args: [s.host, buffer] },
            { fn: this.hostSlot(s, HOST_END_FRAME), args: [s.host] },
        ], 4, () => 0);
        return chain ?? 0;
    }

    /** GetPixelFormat then two AllocFrameBuffer calls, exactly as the real DLL. */
    private acquireBuffers(ctx: X86Context, mem: Uint8Array, s: Session): ThunkResult | null {
        const fmtOut = s.outScratch;
        return this.callGuest(ctx, mem, "lgvid:AcquireBuffers", [
            { fn: this.hostSlot(s, HOST_GET_PIXEL_FORMAT), args: [s.host, fmtOut] },
            { fn: this.hostSlot(s, HOST_ALLOC_FRAME_BUFFER), args: [s.host] },
            { fn: this.hostSlot(s, HOST_ALLOC_FRAME_BUFFER), args: [s.host] },
        ], 4, (results) => {
            s.format = this.readPixelFormat(fmtOut);
            const buffers = [results[1] >>> 0, results[2] >>> 0].filter((b) => b !== 0);
            if (buffers.length < 2 || !s.format) {
                Logger.warn(LogCategory.SYSTEM,
                    `lgvid: host gave ${buffers.length} frame buffer(s), bpp=${s.format?.bpp ?? "?"} — no playback`);
                s.done = true;
                return 0;
            }
            s.frameBuffers = buffers;
            Logger.log(LogCategory.SYSTEM,
                `lgvid: buffers ${buffers.map((b) => "0x" + b.toString(16)).join(",")} ` +
                `bpp=${s.format.bpp} masks=${s.format.rMask.toString(16)}/` +
                `${s.format.gMask.toString(16)}/${s.format.bMask.toString(16)}`);
            return 0;
        });
    }

    /**
     * Read the four fields the real DLL reads, at the offsets its own code uses.
     * Nothing here is inferred from the values: a format we cannot express is
     * refused loudly instead of packed into something plausible-looking.
     */
    private readPixelFormat(ptr: number): PixelFormat | null {
        const bpp = (Mem.readUint32(ptr + PIXFMT_BPP) ?? 0) >>> 0;
        const rMask = (Mem.readUint32(ptr + PIXFMT_R_MASK) ?? 0) >>> 0;
        const gMask = (Mem.readUint32(ptr + PIXFMT_G_MASK) ?? 0) >>> 0;
        const bMask = (Mem.readUint32(ptr + PIXFMT_B_MASK) ?? 0) >>> 0;
        if ((bpp !== 16 && bpp !== 32) || !rMask || !gMask || !bMask ||
            (rMask & gMask) || (gMask & bMask) || (rMask & bMask)) {
            Logger.warn(LogCategory.SYSTEM,
                `lgvid: unusable pixel format bpp=${bpp} masks=` +
                `${rMask.toString(16)}/${gMask.toString(16)}/${bMask.toString(16)}`);
            return null;
        }
        return { bpp, rMask, gMask, bMask };
    }

    private hostSlot(s: Session, offset: number): number {
        return (Mem.readUint32(s.hostVtbl + offset) ?? 0) >>> 0;
    }

    /** Frame pacing: hold the current frame until its presentation time arrives. */
    private frameDue(s: Session): boolean {
        if (!s.started) return false;
        const dueMs = (s.shownFrames / s.fps) * 1000;
        return performance.now() - s.startMs >= dueMs;
    }

    private decodeNextFrame(s: Session): boolean {
        const t0 = performance.now();
        const ok = videoEngine.doFrame(s.engineHandle);
        s.decodeMs += performance.now() - t0;
        s.decodeCalls++;
        if (!ok) {
            s.done = true;
            return false;
        }
        return true;
    }

    /**
     * Per-destination-pixel resample tables. The movie size and the buffer size are
     * both fixed for the life of a session, so the source indices and the blend
     * weights are constants — computing them per frame is 480k redundant divides on
     * the same worker thread that runs the guest CPU and feeds the audio worklet.
     */
    private buildScaleTables(s: Session, dstW: number, dstH: number): ScaleTables {
        const cached = s.scale;
        if (cached && cached.dstW === dstW && cached.dstH === dstH) return cached;
        const stepX = Math.floor((s.width << 16) / dstW);
        const stepY = Math.floor((s.height << 16) / dstH);
        const x0 = new Int32Array(dstW), x1 = new Int32Array(dstW), wx = new Int32Array(dstW);
        for (let x = 0; x < dstW; x++) {
            const fx = x * stepX;
            const i = fx >>> 16;
            x0[x] = i * 4;
            x1[x] = (i + 1 < s.width ? i + 1 : i) * 4;
            wx[x] = (fx >>> 8) & 0xff;          // 0..255
        }
        const y0 = new Int32Array(dstH), y1 = new Int32Array(dstH), wy = new Int32Array(dstH);
        for (let y = 0; y < dstH; y++) {
            const fy = y * stepY;
            const i = fy >>> 16;
            y0[y] = i * s.width * 4;
            y1[y] = (i + 1 < s.height ? i + 1 : i) * s.width * 4;
            wy[y] = (fy >>> 8) & 0xff;
        }
        const tables: ScaleTables = { dstW, dstH, x0, x1, wx, y0, y1, wy };
        s.scale = tables;
        return tables;
    }

    /**
     * Scale the decoded BGRA frame into the host's buffer and pack it to the host's
     * channel masks. The buffer is display-sized and ShowFrame copies it row-for-row
     * with no scaling of its own, so the scale has to happen here — this stands in for
     * the real DLL's sws_scale. Bilinear, matching that default, in fixed point: this
     * runs on the worker that also runs the guest and pumps audio, so the inner loop
     * stays integer-only, allocation-free and free of calls.
     */
    private writeFrame(s: Session, pixels: number, pitch: number, buffer: number): boolean {
        if (!pixels || !pitch || !s.format) return false;
        const bgra = videoEngine.getFrameBgra(s.engineHandle);
        if (!bgra) return false;

        const mem = this.process.getCurrentMemory();
        const bytesPerPixel = mem[buffer + FB_BYTES_PER_PIXEL] || (s.format.bpp === 32 ? 4 : 2);
        const dstW = (mem[buffer + FB_WIDTH] | (mem[buffer + FB_WIDTH + 1] << 8)) >>> 0;
        const dstH = (mem[buffer + FB_HEIGHT] | (mem[buffer + FB_HEIGHT + 1] << 8)) >>> 0;
        if (!dstW || !dstH || dstW * bytesPerPixel > pitch) {
            Logger.warn(LogCategory.SYSTEM,
                `lgvid: frame buffer ${dstW}x${dstH} bpp=${bytesPerPixel} does not fit pitch ${pitch}`);
            return false;
        }
        // The host hands these back from LockFrameBuffer, so they are guest-supplied: validate
        // the WHOLE extent against the region map once, here, before the hoisted word view.
        // A bare `pixels + size <= mem.length` is not validation (§3.1) — only the region map
        // knows the target is not THUNK_CODE, a PE image or a red zone, and writing there
        // through a typed-array view raises no #PF and leaves nothing in the log.
        if (!isValidAddress(mem, pixels, dstH * pitch, "rw")) {
            Logger.warn(LogCategory.SYSTEM,
                `lgvid: frame buffer 0x${pixels.toString(16)}+${dstH * pitch} is not writable guest memory`);
            return false;
        }

        const tScale = performance.now();
        const rShift = maskShift(s.format.rMask), rDrop = 8 - popcount(s.format.rMask);
        const gShift = maskShift(s.format.gMask), gDrop = 8 - popcount(s.format.gMask);
        const bShift = maskShift(s.format.bMask), bDrop = 8 - popcount(s.format.bMask);
        const t = this.buildScaleTables(s, dstW, dstH);
        const tx0 = t.x0, tx1 = t.x1, twx = t.wx, ty0 = t.y0, ty1 = t.y1, twy = t.wy;

        // Write whole pixels through a word view on the underlying buffer. Byte-at-a-time
        // stores into the guest-memory array are ~two orders of magnitude slower here, and
        // that cost lands on the worker that also runs the guest and feeds the audio ring.
        const wordShift = bytesPerPixel === 4 ? 2 : 1;
        const base = mem.byteOffset + pixels;
        if ((base % bytesPerPixel) !== 0 || (pitch % bytesPerPixel) !== 0) {
            Logger.warn(LogCategory.SYSTEM,
                `lgvid: frame buffer base 0x${pixels.toString(16)} / pitch ${pitch} not ${bytesPerPixel}-aligned`);
            return false;
        }
        const words = bytesPerPixel === 4
            ? new Uint32Array(mem.buffer, base, (dstH * pitch) >> wordShift)
            : new Uint16Array(mem.buffer, base, (dstH * pitch) >> wordShift);
        const rowWords = pitch >> wordShift;

        for (let y = 0; y < dstH; y++) {
            const row0 = ty0[y], row1 = ty1[y], fy = twy[y], iy = 256 - fy;
            let o = y * rowWords;
            for (let x = 0; x < dstW; x++, o++) {
                const ax = tx0[x], bx = tx1[x], fx = twx[x], ix = 256 - fx;
                const a = row0 + ax, b2 = row0 + bx, c = row1 + ax, d = row1 + bx;
                const bl = ((bgra[a] * ix + bgra[b2] * fx) * iy +
                            (bgra[c] * ix + bgra[d] * fx) * fy) >>> 16;
                const gr = ((bgra[a + 1] * ix + bgra[b2 + 1] * fx) * iy +
                            (bgra[c + 1] * ix + bgra[d + 1] * fx) * fy) >>> 16;
                const rd = ((bgra[a + 2] * ix + bgra[b2 + 2] * fx) * iy +
                            (bgra[c + 2] * ix + bgra[d + 2] * fx) * fy) >>> 16;
                words[o] = (((rd >> rDrop) << rShift) |
                            ((gr >> gDrop) << gShift) |
                            ((bl >> bDrop) << bShift)) >>> 0;
            }
        }
        s.scaleMs += performance.now() - tScale;
        s.scaleCalls++;
        return true;
    }

    // ==================== guest-call chain ====================

    /**
     * Run `calls` in the guest, in order, then complete this thunk with `finish`.
     * Mirrors the DispatchMessage re-entry: one suspended frame, one callback in
     * flight at a time, the next one started from the previous one's completion.
     */
    private callGuest(
        ctx: X86Context,
        mem: Uint8Array,
        tag: string,
        calls: GuestCall[],
        stackCleanup: number,
        finish: (results: number[]) => number,
    ): ThunkResult | null {
        const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
        if (!callbackManager || calls.length === 0) return null;
        for (const c of calls) {
            if (!c.fn) {
                Logger.warn(LogCategory.SYSTEM, `${tag}: host slot is NULL — skipping chain`);
                return null;
            }
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const thunkReturnAddr = view.getUint32(ctx.esp, true);
        const stubRange = callbackManager.getStubPoolRange();
        const reusedFrame = thunkReturnAddr >= stubRange.base && thunkReturnAddr < stubRange.end;
        const frameId = reusedFrame
            ? callbackManager.getActiveSuspendedFrameId()
            : callbackManager.saveSuspendedThunkContext(
                { ...ctx, returnAddr: thunkReturnAddr }, stackCleanup, tag);
        if (frameId === 0) {
            Logger.error(LogCategory.SYSTEM, `${tag}: failed to save suspended context`);
            return null;
        }

        const results: number[] = [];
        let index = 0;
        let firstCallbackId = 0;

        const step = (): number => {
            const call = calls[index++];
            const { callbackId } = callbackManager.invokeCallback(
                call.fn,
                call.args,
                0,
                (ret) => {
                    results.push(ret >>> 0);
                    if (index >= calls.length) return finish(results);
                    return null;   // more to do — enumerationState drives the next one
                },
                false,
                tag,
                frameId,
            );
            if (callbackId === 0) return 0;
            if (firstCallbackId === 0) firstCallbackId = callbackId;
            const invocation = callbackManager.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = {
                    continueEnumeration: () => { step(); },
                    finishEnumeration: () => { /* nothing to release */ },
                };
            }
            return callbackId;
        };

        if (step() === 0) {
            Logger.error(LogCategory.SYSTEM, `${tag}: invokeCallback failed`);
            return null;
        }

        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: firstCallbackId,
            stackCleanup,
            skipStackCheck: true,
            preserveCallbackReturnAddress: reusedFrame,
        };
    }

    // ==================== helpers ====================

    private readCString(mem: Uint8Array, ptr: number, max = 512): string {
        let out = "";
        for (let i = 0; i < max; i++) {
            const c = mem[ptr + i];
            if (!c) break;
            out += String.fromCharCode(c);
        }
        return out;
    }
}

function popcount(v: number): number {
    let n = 0;
    let x = v >>> 0;
    while (x) { x &= x - 1; n++; }
    return n;
}

function maskShift(mask: number): number {
    if (!mask) return 0;
    let n = 0;
    let x = mask >>> 0;
    while ((x & 1) === 0) { x >>>= 1; n++; }
    return n;
}
