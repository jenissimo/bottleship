/**
 * Smacker Video Library (smackw32.dll)
 *
 * Decodes .SMK video files via the FFmpeg WASM video engine.
 * Falls back to stub (return 0 / fakeHandle) when WASM is unavailable.
 *
 * Smacker 4.x handle struct layout (128 bytes):
 *   +0   "SMK2" signature  DWORD
 *   +4   Width             DWORD
 *   +8   Height            DWORD
 *   +12  Frames            DWORD  ← 0 = game skips, real count = plays
 *   +16  FrameRate         DWORD  ← ms per frame (positive)
 *   +20  FrameNum          DWORD  ← current frame
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult, X86Context } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { videoEngine, Pal8Frame } from "../../video/video-engine";
import { setCtrl, CTRL_VOLUME, CTRL_PAN, CTRL_PLAY_CURSOR, CTRL_BUFFER_BYTES, CTRL_BLOCK_ALIGN, CTRL_SAMPLE_RATE, CTRL_STATE, STATE_PLAYING } from "../../audio/audio-ring-buffer";
import { DirectDrawPaletteObject } from "./ddraw/com-objects-ddraw";
import { DirectDrawSurfaceObject, DirectDrawSurfaceState, isRenderSurface } from "./ddraw/com-objects";
import { readAnsiFromGuest } from "./codepage-utils";
import { setAuthorityCpu } from "./ddraw/surface-sync";
import { TimeService } from "../runtime/time";
import { Mem } from "../core/memory/mem-accessor";
import { overlapsThunkCode } from "../core/memory/address-guard";
import { Glide2x } from "./glide2x";
import { VideoFrameViews } from "../video/video-routing-types";

// HSMACK guest struct: Storm reads dirty rects @0x380..0x38c, palette @0x6c,
// NewPalette @0x68, internal buf @0x3c; SmackBuffer path also touches +0x448.
const SMACK_STRUCT_SIZE = 0x500;
// SmackBuffer guest struct: Storm passes *(HSMACKBUF+0x448) as SmackToBuffer buf.
const SMACKBUF_STRUCT_SIZE = 0x450;
const SMACK_FROM_HANDLE = 0x1000;

/** SmackDoFrame return flags (RAD Smacker SDK). */
const SMACKFRM_NEWPAL = 0x01;
const SMACKFRM_NEWPIX = 0x04;

/**
 * Detect destination bpp from pitch vs video width.
 */
function smkDetectDestBpp(pitch: number, videoWidth: number): number {
    if (videoWidth <= 0) return 4;
    if (pitch < videoWidth * 2) return 1;  // 8-bit (palettized)
    if (pitch < videoWidth * 3) return 2;  // 16-bit
    if (pitch < videoWidth * 4) return 3;  // 24-bit
    return 4;                                // 32-bit
}

/**
 * Copy one row of decoded 32bpp pixels to destination surface.
 */
/**
 * Copy one row of decoded pixels to destination surface.
 * For 8bpp: if PAL8 data available, copy palette indices directly (zero conversion).
 *           Otherwise fall back to BGRA → luminance.
 * For 16bpp: BGRA → RGB565.
 * For 32bpp: direct memcpy.
 */
function smkCopyDecodedRow(
    src: Uint8Array, srcOff: number,
    dst: Uint8Array, dstOff: number,
    width: number, destBpp: number,
): void {
    if (destBpp === 2) {
        // BGRA → RGB565 via typed array views (bulk u32 read + u16 write)
        const srcAbs = src.byteOffset + srcOff;
        const dstAbs = dst.byteOffset + dstOff;
        if ((srcAbs & 3) === 0 && (dstAbs & 1) === 0) {
            const src32 = new Uint32Array(src.buffer, srcAbs, width);
            const dst16 = new Uint16Array(dst.buffer, dstAbs, width);
            for (let x = 0; x < width; x++) {
                const px = src32[x];
                dst16[x] = ((px & 0x00F80000) >>> 8) | ((px & 0x0000FC00) >> 5) | ((px & 0x000000F8) >> 3);
            }
        } else {
            for (let x = 0; x < width; x++) {
                const si = srcOff + x * 4;
                const b0 = src[si], b1 = src[si + 1], b2 = src[si + 2];
                const rgb565 = ((b2 >> 3) << 11) | ((b1 >> 2) << 5) | (b0 >> 3);
                const di = dstOff + x * 2;
                dst[di] = rgb565 & 0xFF;
                dst[di + 1] = (rgb565 >> 8) & 0xFF;
            }
        }
    } else if (destBpp === 3) {
        // BGRA → BGR24
        for (let x = 0; x < width; x++) {
            const si = srcOff + x * 4;
            const di = dstOff + x * 3;
            dst[di] = src[si];
            dst[di + 1] = src[si + 1];
            dst[di + 2] = src[si + 2];
        }
    } else {
        dst.set(src.subarray(srcOff, srcOff + width * 4), dstOff);
    }
}

/**
 * Copy one row of PAL8 indices directly into an 8bpp destination.
 * indices is the PAL8 index buffer from the decoder (width*height bytes).
 */
function smkCopyPal8Row(
    indices: Uint8Array, srcOff: number,
    dst: Uint8Array, dstOff: number,
    width: number,
): void {
    dst.set(indices.subarray(srcOff, srcOff + width), dstOff);
}

/** Per SmackBufferOpen session (guest struct + pixel backing store). */
interface SmackBufferSession {
    guestPtr: number;
    hwnd: number;
    blitType: number;
    width: number;
    height: number;
    stretchWidth: number;
    stretchHeight: number;
    pixelBuf: number;
    pixelPitch: number;
    /** Associated HSMACK pointer, set when SmackBufferNewPalette links buf↔smk */
    hSmack: number;
}

/** Per-open session */
interface SmackSession {
    guestPtr: number;
    engineHandle: number;
    width: number;
    height: number;
    frameCount: number;
    fps: number;
    lastFrameMs: number;   // performance.now() after last DoFrame decode
    eof: boolean;  // true after first EOF from decoder
    audioSab?: SharedArrayBuffer; // VideoEngine circular SAB for volume/pan control
    destBuf: number;   // guest address set by SmackToBuffer
    destPitch: number;
    destLeft: number;
    destTop: number;
    destHeight: number;
    destBpp: number;   // bytes per pixel from smkDetectDestBpp()
    audioCtrl: Int32Array | null; // cached Int32Array view of SAB control block
    lastPlayCursor: number;   // last CTRL_PLAY_CURSOR reading (bytes)
    audioWrapCount: number;   // detected ring buffer wraps
    audioBaselineMs: number;   // audio time (ms) at first frame decode; -1 = not set
    frameDecodeCount: number;  // frames decoded so far
    internalBuf: number;  // guest address of internal pixel buffer (allocated when SmackToBuffer buf=0)
    /** SmackToBufferRect: one full-frame dirty rect pending after DoFrame. */
    pendingBufferRect: boolean;
    /** Last-frame SmackDoFrame change flags for SmackToBufferRect arg. */
    lastDoFrameFlags: number;
    /** RGB fingerprint (256×3) to detect real palette changes for HSMACK+0x68. */
    paletteRgb: Uint8Array | null;
    paletteDirty: boolean;
    explicitDdrawSurface: DirectDrawSurfaceState | null;
    explicitGlideSurfacePtr: number;
}

export class SmackW32 implements IModule {
    name = "smackw32";
    exports: Record<string, ThunkImplementation> = {};

    private process!: Process;
    /** Used as fallback when WASM is unavailable (game skips immediately). */
    private fakeHandle: number = 0;
    /** Whether SmackSoundUseMSS/UseDirectSound was called (audio uses VideoEngine SAB either way) */
    private soundDriverSet: boolean = false;

    /** Maps guest SmackHandle ptr → session */
    private sessions: Map<number, SmackSession> = new Map();

    /** SmackBuffer sessions keyed by guest HSMACKBUF pointer */
    private smackBuffers: Map<number, SmackBufferSession> = new Map();

    /** Suppress repeat logs for unknown handles in SmackDoFrame */
    private loggedUnknownHandles: Set<number> = new Set();

    private getMemory(): Uint8Array {
        return this.process.v86.mem8 || (this.process.v86.v86 && this.process.v86.v86.cpu.mem8);
    }

    private writeU32(mem: Uint8Array, addr: number, value: number): void {
        if (Mem.writeUint32(addr, value >>> 0)) {
            return;
        }
        if (addr >= 0 && addr + 4 <= mem.length && !overlapsThunkCode(addr, 4)) {
            mem[addr] = value & 0xFF;
            mem[addr + 1] = (value >> 8) & 0xFF;
            mem[addr + 2] = (value >> 16) & 0xFF;
            mem[addr + 3] = (value >> 24) & 0xFF;
        }
    }

    private validateWritableSpan(address: number, size: number): boolean {
        if (address <= 0 || size <= 0) return false;
        const mem = this.getMemory();
        if (address + size > mem.length) return false;
        if (overlapsThunkCode(address, size)) return false;
        const space = System.getInstance().process?.addressSpace;
        if (space && !space.validateRange(address, size, "w")) return false;
        return true;
    }

    private writeBytesChecked(address: number, bytes: Uint8Array): boolean {
        if (!this.validateWritableSpan(address, bytes.length)) {
            return false;
        }
        return Mem.writeBytes(address, bytes) === bytes.length;
    }

    private resolveDdrawSurfaceStateBySurfacePtr(surfacePtr: number): DirectDrawSurfaceState | null {
        if (!surfacePtr) return null;
        const sys = System.getInstance();
        const objs = sys.resourceProvider.getComObjectsBySurfacePtr(surfacePtr);
        for (const obj of objs) {
            if (obj instanceof DirectDrawSurfaceObject) {
                const state = obj.getState();
                if (state.surfacePtr === surfacePtr) return state;
            }
        }
        return null;
    }

    private resolveGlideLfbPointer(surfacePtr: number): number {
        if (!surfacePtr) return 0;
        const glide = System.getInstance().process?.getModule("glide2x") as Glide2x | undefined;
        const lfb = glide?.findLfbSurfaceByDataPtr?.(surfacePtr);
        return lfb ? surfacePtr : 0;
    }

    private updateExplicitSinkHints(s: SmackSession, surfacePtr: number): void {
        s.explicitDdrawSurface = this.resolveDdrawSurfaceStateBySurfacePtr(surfacePtr);
        if (s.explicitDdrawSurface && isRenderSurface(s.explicitDdrawSurface)) {
            setAuthorityCpu(s.explicitDdrawSurface);
        }
        s.explicitGlideSurfacePtr = s.explicitDdrawSurface ? 0 : this.resolveGlideLfbPointer(surfacePtr);
    }

    private findBufferForSmack(hSmack: number): SmackBufferSession | null {
        for (const buf of this.smackBuffers.values()) {
            if (buf.hSmack === hSmack) return buf;
        }
        return null;
    }

    private findBufferByPixelBuf(pixelBuf: number): SmackBufferSession | null {
        for (const buf of this.smackBuffers.values()) {
            if (buf.pixelBuf === pixelBuf) return buf;
        }
        return null;
    }

    /** Storm SmackBuffer path: DoFrame returns 0 and rects come from SmackToBufferRect. */
    private usesSmackBufferRectPath(s: SmackSession): boolean {
        return this.findBufferForSmack(s.guestPtr) !== null;
    }

    private resolveHsmackFromRectHandle(handle: number): number {
        if (this.sessions.has(handle)) return handle;
        const sbuf = this.smackBuffers.get(handle);
        return sbuf?.hSmack ?? 0;
    }

    private writeDirtyRect(mem: Uint8Array, smk: number, s: SmackSession): void {
        const sbuf = this.findBufferForSmack(smk);
        const rectW = (sbuf && sbuf.stretchWidth > 0) ? sbuf.stretchWidth : s.width;
        const rectH = (sbuf && sbuf.stretchHeight > 0) ? sbuf.stretchHeight : s.height;
        this.writeU32(mem, smk + 0x380, 0);
        this.writeU32(mem, smk + 0x384, 0);
        this.writeU32(mem, smk + 0x388, rectW);
        this.writeU32(mem, smk + 0x38c, rectH);
    }

    private notePaletteChange(s: SmackSession, bgraPalette: Uint8Array): boolean {
        if (!s.paletteRgb) {
            s.paletteRgb = new Uint8Array(768);
            s.paletteDirty = true;
        }
        let changed = s.paletteDirty;
        for (let i = 0; i < 256; i++) {
            const si = i * 4;
            const di = i * 3;
            const r = bgraPalette[si + 2];
            const g = bgraPalette[si + 1];
            const b = bgraPalette[si];
            if (s.paletteRgb[di] !== r || s.paletteRgb[di + 1] !== g || s.paletteRgb[di + 2] !== b) {
                changed = true;
                s.paletteRgb[di] = r;
                s.paletteRgb[di + 1] = g;
                s.paletteRgb[di + 2] = b;
            }
        }
        s.paletteDirty = changed;
        return changed;
    }

    private writeSmackBufferHeader(mem: Uint8Array, buf: SmackBufferSession): void {
        mem.fill(0, buf.guestPtr, buf.guestPtr + SMACKBUF_STRUCT_SIZE);
        this.writeU32(mem, buf.guestPtr + 4, buf.width);
        this.writeU32(mem, buf.guestPtr + 8, buf.height);
        if (buf.stretchWidth > 0) {
            this.writeU32(mem, buf.guestPtr + 0x10, buf.stretchWidth);
        }
        if (buf.stretchHeight > 0) {
            this.writeU32(mem, buf.guestPtr + 0x14, buf.stretchHeight);
        }
        this.writeU32(mem, buf.guestPtr + 0x448, buf.pixelBuf);
    }

    private hasAppManagedSink(s: SmackSession): boolean {
        return s.destBuf !== 0 && s.destBuf !== s.internalBuf;
    }

    private getRoutingTargetHint(s: SmackSession): { kind: "none" | "ddraw_surface" | "glide_lfb" | "app_buffer"; valid: boolean; surfacePtr?: number; pitch?: number; width?: number; height?: number } {
        if (s.explicitDdrawSurface?.surfacePtr) {
            return {
                kind: "ddraw_surface",
                valid: true,
                surfacePtr: s.explicitDdrawSurface.surfacePtr,
                pitch: s.explicitDdrawSurface.pitch,
                width: s.explicitDdrawSurface.width,
                height: s.explicitDdrawSurface.height,
            };
        }
        if (s.explicitGlideSurfacePtr) {
            return {
                kind: "glide_lfb",
                valid: true,
                surfacePtr: s.explicitGlideSurfacePtr,
            };
        }
        if (this.hasAppManagedSink(s)) {
            return { kind: "app_buffer", valid: true };
        }
        return { kind: "none", valid: false };
    }

    private buildFrameViews(s: SmackSession): VideoFrameViews {
        const pal8: Pal8Frame | null = videoEngine.getFramePal8(s.engineHandle);
        const palette = this._getValidPalette(s);
        return {
            width: s.width,
            height: s.height,
            frameIndex: s.frameDecodeCount,
            frameDurationMs: s.fps > 0 ? 1000 / s.fps : 66,
            decodedAtMs: performance.now(),
            bgra: videoEngine.getFrameBgra(s.engineHandle),
            rgb565: videoEngine.getFrameRgb565(s.engineHandle),
            pal8Indices: pal8?.indices ?? null,
            paletteBgra: palette ?? pal8?.palette ?? null,
        };
    }

    private submitExplicitDdrawSink(s: SmackSession): boolean {
        const state = s.explicitDdrawSurface;
        if (!state?.surfacePtr) return false;
        const ddrawCtx = System.getInstance().ddrawContext;
        if (!ddrawCtx?.presenter) return false;
        if (isRenderSurface(state)) {
            setAuthorityCpu(state);
        }
        void ddrawCtx.presenter.present(state, this.getMemory(), { throttle: false });
        return true;
    }

    private submitLegacyPrimarySink(s: SmackSession): boolean {
        // Storm's SmackBuffer + SmackToBufferRect path owns presentation geometry.
        if (this.findBufferForSmack(s.guestPtr)) return false;
        if (s.destBuf !== 0) return false;
        return this._compositeToPrimary(s, this.getMemory());
    }

    /** Park this synchronous SmackWait call until its next-frame deadline. */
    private markVideoWaitNotReady(ctx: X86Context, mem: Uint8Array, waitMs: number): number | ThunkResult {
        if (ctx.esp < 0 || ctx.esp + 4 > mem.length) {
            return 1;
        }
        const returnAddr = new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
            .getUint32(ctx.esp, true);
        const result = System.getInstance().scheduler.parkCurrentThreadUntil(
            Math.max(1, waitMs),
            returnAddr,
            (ctx.esp + 8) >>> 0,
            { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
        );
        if (result === 0) return 1;
        return { value: 0, blockedNoSwitch: true, stackCleanup: 4 };
    }

    private readCString(mem: Uint8Array, ptr: number, maxLen = 520): string {
        return readAnsiFromGuest(mem, ptr, maxLen);
    }

    /** Read a complete file from VFS. */
    private async readVfsFile(path: string): Promise<Uint8Array | null> {
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(path);
            if (size <= 0) return null;
            const LIMIT_BYTES = 256 * 1024 * 1024;
            if (size > LIMIT_BYTES) {
                Logger.warn(LogCategory.SYSTEM,
                    `[SmackW32] readVfsFile("${path}"): size ${size} > limit, skipping`);
                return null;
            }
            const GENERIC_READ = 0x80000000;
            const OPEN_EXISTING = 3;
            const handle = await vfs.open(path, GENERIC_READ, OPEN_EXISTING);
            if (!handle) return null;
            return await vfs.read(handle, size);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `[SmackW32] readVfsFile("${path}") error: ${e}`);
            return null;
        }
    }

    /**
     * Write video palette into HSMACK struct at offset +0x6c (256 × 3 bytes RGB).
     * Real smackw32.dll stores palette at HSMACK+0x6c. Storm.dll's SVidPlayContinueSingle
     * (Ordinal_457) reads from this offset to feed SDrawUpdatePalette → DDraw SetEntries.
     * The decoder palette is 256 × 4 bytes BGRA; we write RGB (matching real smackw32.dll).
     */
    private _writePaletteToStruct(mem: Uint8Array, smk: number, bgraPalette: Uint8Array): void {
        const PALETTE_OFFSET = 0x6c;
        for (let i = 0; i < 256; i++) {
            const si = i * 4; // BGRA
            const di = smk + PALETTE_OFFSET + i * 3;
            mem[di] = bgraPalette[si + 2]; // R ← from BGRA[2]
            mem[di + 1] = bgraPalette[si + 1]; // G ← from BGRA[1]
            mem[di + 2] = bgraPalette[si];     // B ← from BGRA[0]
        }
    }

    /** Cached reconstructed BGRA palette (256×4 bytes) built from PAL8 indices + BGRA frame */
    private _reconstructedPalette: Uint8Array | null = null;

    /**
     * Reconstruct a BGRA palette from PAL8 indices + BGRA frame data.
     * For each index 0-255, find a pixel with that index and read its BGRA color.
     * This is needed because FFmpeg's Smacker decoder may not populate data[1].
     */
    private _reconstructPalette(indices: Uint8Array, bgra: Uint8Array, width: number, height: number): Uint8Array {
        if (!this._reconstructedPalette) {
            this._reconstructedPalette = new Uint8Array(1024);
        }
        const pal = this._reconstructedPalette;
        pal.fill(0);
        const found = new Uint8Array(256); // track which indices we've found
        let remaining = 256;
        const totalPixels = width * height;
        for (let i = 0; i < totalPixels && remaining > 0; i++) {
            const idx = indices[i];
            if (!found[idx]) {
                found[idx] = 1;
                remaining--;
                const si = i * 4;
                const di = idx * 4;
                pal[di]     = bgra[si];     // B
                pal[di + 1] = bgra[si + 1]; // G
                pal[di + 2] = bgra[si + 2]; // R
                pal[di + 3] = bgra[si + 3]; // A
            }
        }
        return pal;
    }

    /**
     * Get a valid BGRA palette for the current frame.
     * Uses PAL8 palette if it has any non-zero color bytes (skipping entry 0
     * which is often legitimately black), otherwise reconstructs from BGRA+indices.
     */
    private _getValidPalette(s: SmackSession): Uint8Array | null {
        const pal8 = videoEngine.getFramePal8(s.engineHandle);
        if (pal8) {
            // Check if palette has any non-zero color values (skip entry 0 — often black)
            let nonZeroColors = 0;
            for (let i = 4; i < 1024; i += 4) { // start from entry 1
                if (pal8.palette[i] || pal8.palette[i + 1] || pal8.palette[i + 2]) {
                    nonZeroColors++;
                    if (nonZeroColors >= 2) break; // at least 2 colored entries → valid
                }
            }
            if (nonZeroColors >= 2) return pal8.palette;

            // Palette is all zeros — reconstruct from BGRA frame + indices
            const bgra = videoEngine.getFrameBgra(s.engineHandle);
            if (bgra) {
                return this._reconstructPalette(pal8.indices, bgra, s.width, s.height);
            }
        }
        return null;
    }

    /**
     * Copy the current decoded frame pixels into guest memory at the
     * destination set by SmackToBuffer. Handles 8bpp, 16bpp, and 32bpp.
     */
    private _copyFrameToGuest(s: SmackSession, mem: Uint8Array): void {
        const rows = Math.min(s.height, s.destHeight - s.destTop);
        if (rows <= 0) return;
        if (s.destBpp <= 0) return;

        if (s.destBpp === 1) {
            // 8bpp: PAL8 indices directly
            const pal8 = videoEngine.getFramePal8(s.engineHandle);
            if (pal8) {
                for (let row = 0; row < rows; row++) {
                    const srcOff = row * s.width;
                    const dstOff = s.destBuf + (s.destTop + row) * s.destPitch + s.destLeft;
                    const rowData = pal8.indices.subarray(srcOff, srcOff + s.width);
                    if (!this.writeBytesChecked(dstOff, rowData)) {
                        return;
                    }
                }
                return;
            }
            // Fallback: BGRA → luminance
            const bgra = videoEngine.getFrameBgra(s.engineHandle);
            if (!bgra) return;
            const rowScratch = new Uint8Array(s.width);
            for (let row = 0; row < rows; row++) {
                for (let x = 0; x < s.width; x++) {
                    const si = row * s.width * 4 + x * 4;
                    rowScratch[x] = (bgra[si + 2] * 77 + bgra[si + 1] * 150 + bgra[si] * 29) >> 8;
                }
                const dstOff = s.destBuf + (s.destTop + row) * s.destPitch + s.destLeft;
                if (!this.writeBytesChecked(dstOff, rowScratch)) {
                    return;
                }
            }
            return;
        }

        if (s.destBpp === 2) {
            // 16bpp: prefer WASM-side RGB565
            const rgb565 = videoEngine.getFrameRgb565(s.engineHandle);
            if (rgb565) {
                const srcPitch = s.width * 2;
                for (let row = 0; row < rows; row++) {
                    const srcOff = row * srcPitch;
                    const dstOff = s.destBuf + (s.destTop + row) * s.destPitch + s.destLeft * 2;
                    const rowData = rgb565.subarray(srcOff, srcOff + srcPitch);
                    if (!this.writeBytesChecked(dstOff, rowData)) {
                        return;
                    }
                }
                return;
            }
        }

        // 16bpp fallback / 32bpp: use BGRA frame
        const bgra = videoEngine.getFrameBgra(s.engineHandle);
        if (!bgra) return;
        const srcPitch = s.width * 4;
        const rowBytes = s.width * s.destBpp;
        const rowScratch = new Uint8Array(rowBytes);
        for (let row = 0; row < rows; row++) {
            const srcOff = row * srcPitch;
            const dstOff = s.destBuf + (s.destTop + row) * s.destPitch + s.destLeft * s.destBpp;
            smkCopyDecodedRow(bgra, srcOff, rowScratch, 0, s.width, s.destBpp);
            if (!this.writeBytesChecked(dstOff, rowScratch)) {
                return;
            }
        }
    }

    /**
     * Direct-composite decoded frame to DDraw primary surface.
     * Used when the game doesn't call SmackToBuffer (e.g., StarCraft's Storm.dll
     * reads HSMACK internal buffers directly — which we can't populate since we
     * don't know the exact struct layout). Instead, we write 8bpp indices
     * directly to the primary surface and update the DDraw palette.
     */
    private _compositeToPrimary(s: SmackSession, mem: Uint8Array): boolean {
        const ddrawCtx = System.getInstance().ddrawContext;
        if (!ddrawCtx) return false;

        const primaryAddr = ddrawCtx.surfaces.primary;
        if (!primaryAddr) return false;

        const primaryObj = ddrawCtx.resourceProvider.getComObjectByAddress(primaryAddr) as DirectDrawSurfaceObject | null;
        if (!primaryObj) return false;

        const state = primaryObj.getState();
        if (!state.surfacePtr || state.width <= 0 || state.height <= 0) return false;

        // Get PAL8 frame data (8bpp indices)
        const pal8 = videoEngine.getFramePal8(s.engineHandle);
        if (!pal8) return false;

        // Get valid palette (may reconstruct from BGRA if WASM palette is zeros)
        const validPalette = this._getValidPalette(s);
        if (!validPalette) return false;

        // Center the video on the primary surface (1:1, no scaling)
        const dstX = Math.max(0, Math.floor((state.width - s.width) / 2));
        const dstY = Math.max(0, Math.floor((state.height - s.height) / 2));

        // Write 8bpp indices to primary surface pixel memory
        const copyW = Math.min(s.width, state.width - dstX);
        const copyH = Math.min(s.height, state.height - dstY);
        for (let row = 0; row < copyH; row++) {
            const srcOff = row * s.width;
            const dstOff = state.surfacePtr + (dstY + row) * state.pitch + dstX;
            const rowData = pal8.indices.subarray(srcOff, srcOff + copyW);
            if (!this.writeBytesChecked(dstOff, rowData)) {
                return false;
            }
        }

        // Only a FULLSCREEN clip may own the shared 8-bit primary palette. A windowed
        // (sub-region) clip composited over existing UI must NOT repaint the global
        // palette: on real 8-bit DirectDraw a sub-region blit cannot change the screen
        // palette without corrupting the surrounding UI. (StarCraft mission-briefing: a
        // small portrait Smacker was overwriting the briefing UI palette → whole screen blue.)
        const ownsPrimaryPalette = s.width >= state.width && s.height >= state.height;
        if (ownsPrimaryPalette && state.paletteHandle) {
            const paletteObj = ddrawCtx.resourceProvider.getComObject(state.paletteHandle) as DirectDrawPaletteObject | null;
            if (paletteObj) {
                paletteObj.setEntriesFromBGRA(validPalette, 256);
            }
        }

        // Mark surface as CPU-dirty so presenter uploads new pixels
        if (isRenderSurface(state)) {
            setAuthorityCpu(state);
        }

        // Trigger presentation — sync call, no await.
        if (ddrawCtx.presenter) {
            ddrawCtx.presenter.present(state, mem, { throttle: false });
        }

        return true;
    }

    /**
     * Derive absolute audio playback time (ms) from the ring buffer's play cursor.
     * Detects wraps by checking if cursor jumped backward by more than half the buffer.
     */
    private _getAudioTimeMs(s: SmackSession): number {
        if (!s.audioCtrl) return -1;

        const ctrl = s.audioCtrl;
        const state = Atomics.load(ctrl, CTRL_STATE);
        if (state !== STATE_PLAYING) return -1;

        const playCursor = Atomics.load(ctrl, CTRL_PLAY_CURSOR);
        const bufferBytes = Atomics.load(ctrl, CTRL_BUFFER_BYTES);
        const blockAlign = Atomics.load(ctrl, CTRL_BLOCK_ALIGN);
        const sampleRate = Atomics.load(ctrl, CTRL_SAMPLE_RATE);

        if (blockAlign <= 0 || sampleRate <= 0 || bufferBytes <= 0) return -1;

        // Detect wrap: cursor jumped backward by more than half the buffer
        if (playCursor < s.lastPlayCursor - bufferBytes / 2) {
            s.audioWrapCount++;
        }
        s.lastPlayCursor = playCursor;

        const totalBytesPlayed = s.audioWrapCount * bufferBytes + playCursor;
        return (totalBytesPlayed / blockAlign / sampleRate) * 1000;
    }

    /** Write SMK2 header into guest struct. */
    private writeSmackHeader(mem: Uint8Array, ptr: number, s: SmackSession): void {
        mem.fill(0, ptr, ptr + SMACK_STRUCT_SIZE);
        // "SMK2" signature
        mem[ptr + 0] = 0x53; mem[ptr + 1] = 0x4D; mem[ptr + 2] = 0x4B; mem[ptr + 3] = 0x32;
        this.writeU32(mem, ptr + 4, s.width);
        this.writeU32(mem, ptr + 8, s.height);
        this.writeU32(mem, ptr + 12, s.frameCount);  // Frames at +12 (real Smacker layout)
        // FrameRate at +16: ms per frame (positive)
        const msPerFrame = s.fps > 0 ? Math.round(1000 / s.fps) : 66;
        this.writeU32(mem, ptr + 16, msPerFrame);
        this.writeU32(mem, ptr + 20, 0);  // FrameNum at +20, starts at 0
        this.writeU32(mem, ptr + 884, 0); // FrameNum at +884 (real Smacker SDK offset)
        // Internal buffer pointer at +0x3c and +0x448 (Storm reads both layouts)
        if (s.internalBuf) {
            this.writeU32(mem, ptr + 0x3c, s.internalBuf);
            this.writeU32(mem, ptr + 0x448, s.internalBuf);
        }
    }

    initialize(process: Process): void {
        this.process = process;

        // Allocate fallback SmackHandle — Frames=1 at +12 so game's loop guard exits cleanly
        this.fakeHandle = process.memory.alloc(SMACK_STRUCT_SIZE);
        const mem = this.getMemory();
        if (mem) {
            mem.fill(0, this.fakeHandle, this.fakeHandle + SMACK_STRUCT_SIZE);
            // "SMK2" signature so struct looks valid
            mem[this.fakeHandle + 0] = 0x53; mem[this.fakeHandle + 1] = 0x4D;
            mem[this.fakeHandle + 2] = 0x4B; mem[this.fakeHandle + 3] = 0x32;
            // Frames=1 at +12 → game loop runs once then exits (not infinite spin)
            this.writeU32(mem, this.fakeHandle + 12, 1);
            // FrameNum=0 at +20 (already zero from fill)
        }
        Logger.log(LogCategory.SYSTEM,
            `SmackW32: fallback handle at 0x${this.fakeHandle.toString(16)}`);

        // в”Ђв”Ђ SmackSoundUseMSS — audio plays via VideoEngine circular SAB в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_SmackSoundUseMSS@4"] = (_ctx, _mem, _args) => {
            this.soundDriverSet = true;
            return 1;
        };

        // в”Ђв”Ђ SmackUseMMX — no-op в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_SmackUseMMX@4"] = (_ctx, _mem, _args) => {
            return 0;
        };

        // в”Ђв”Ђ SmackSoundUseDirectSound — audio plays via VideoEngine circular SAB
        this.exports["_SmackSoundUseDirectSound@4"] = (_ctx, _mem, _args) => {
            this.soundDriverSet = true;
            return 1;
        };

        // в”Ђв”Ђ SmackOpen(name | HANDLE, flags, extraBufs) → HSMACK в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_SmackOpen@12"] = async (_ctx, mem, args) => {
            const arg0 = args[0];
            const flags = args[1];

            Logger.log(LogCategory.SYSTEM,
                `SmackOpen(arg0=0x${arg0.toString(16)}, flags=0x${flags.toString(16)}, extraBufs=${args[2]}) ` +
                `FROM_HANDLE=${!!(flags & SMACK_FROM_HANDLE)}`);

            // skipVideo: return fakeHandle to skip video playback entirely
            if (EmulatorConfig.getInstance().skipVideo) {
                Logger.verbose(LogCategory.SYSTEM, `SmackOpen: skipped (skipVideo=true)`);
                return this.fakeHandle;
            }

            let rawName = "";
            if (flags & SMACK_FROM_HANDLE) {
                const sys = System.getInstance();
                const fw = sys.resourceProvider.getFileHandle(arg0);
                if (!fw || !fw.vfsHandle) {
                    Logger.warn(LogCategory.SYSTEM,
                        `SmackW32: SmackOpen(HANDLE=0x${arg0.toString(16)}, flags=0x${flags.toString(16)}) — no wrapper → fakeHandle`);
                    return this.fakeHandle;
                }

                const filePath = fw.vfsHandle.path;
                const startPos = fw.position;
                const label = `HANDLE=0x${arg0.toString(16)} (${filePath}@${startPos})`;

                // Open a fresh VFS handle to read only the SMK data (not the entire archive)
                const vfs = sys.fileSystem;
                const GENERIC_READ = 0x80000000;
                const OPEN_EXISTING = 3;
                const tempHandle = await vfs.open(filePath, GENERIC_READ, OPEN_EXISTING);
                if (!tempHandle) {
                    Logger.warn(LogCategory.SYSTEM, `SmackOpen(${label}): failed to open fresh handle`);
                    return this.fakeHandle;
                }

                // Read SMK header (104 bytes) to determine actual file size
                const SMK_HEADER_SIZE = 104;
                vfs.setPosition(tempHandle, startPos, 0);
                const header = await vfs.read(tempHandle, SMK_HEADER_SIZE);
                if (header.length < SMK_HEADER_SIZE) {
                    Logger.warn(LogCategory.SYSTEM, `SmackOpen(${label}): couldn't read SMK header`);
                    return this.fakeHandle;
                }
                if (header[0] !== 0x53 || header[1] !== 0x4D || header[2] !== 0x4B) {
                    Logger.warn(LogCategory.SYSTEM, `SmackOpen(${label}): no SMK signature`);
                    return this.fakeHandle;
                }
                const hdrView = new DataView(header.buffer, header.byteOffset, header.byteLength);
                const frameCount = hdrView.getUint32(0x0C, true);
                const treesSize = hdrView.getUint32(0x34, true);

                // Read frame size table (frameCount * 4 bytes) to compute total data size
                const frameSizeTableLen = frameCount * 4;
                const frameSizeTable = await vfs.read(tempHandle, frameSizeTableLen);
                const fsView = new DataView(frameSizeTable.buffer, frameSizeTable.byteOffset, frameSizeTable.byteLength);
                let totalFrameData = 0;
                for (let i = 0; i < frameCount; i++) {
                    totalFrameData += fsView.getUint32(i * 4, true) & 0xFFFFFFFC; // mask flag bits
                }
                // Total = header + frame sizes + frame types + trees + frame data
                const totalSize = SMK_HEADER_SIZE + frameSizeTableLen + frameCount + treesSize + totalFrameData;
                Logger.log(LogCategory.SYSTEM,
                    `SmackOpen(${label}): frames=${frameCount} treesSize=${treesSize} totalSize=${totalSize}`);

                // Read the full SMK file
                vfs.setPosition(tempHandle, startPos, 0);
                const bytes = await vfs.read(tempHandle, totalSize);

                // Advance the game's handle past the SMK data
                fw.seek(startPos + totalSize);

                if (bytes.length < SMK_HEADER_SIZE) {
                    Logger.warn(LogCategory.SYSTEM, `SmackOpen(${label}): read returned only ${bytes.length} bytes`);
                    return this.fakeHandle;
                }

                try {
                    const engineHandle = await videoEngine.open(bytes);
                    const info = videoEngine.getInfo(engineHandle);
                    if (!info) { videoEngine.close(engineHandle); return this.fakeHandle; }

                    const guestPtr = process.memory.alloc(SMACK_STRUCT_SIZE);
                    const s: SmackSession = {
                        guestPtr, engineHandle,
                        width: info.width, height: info.height,
                        frameCount: info.frameCount, fps: info.fps,
                        lastFrameMs: 0, eof: false,
                        destBuf: 0, destPitch: 0, destLeft: 0,
                        destTop: 0, destHeight: 0, destBpp: 0,
                        audioCtrl: null, lastPlayCursor: 0,
                        audioWrapCount: 0, audioBaselineMs: -1,
                        frameDecodeCount: 0, internalBuf: 0,
                        pendingBufferRect: false, lastDoFrameFlags: 0,
                        paletteRgb: null, paletteDirty: false,
                        explicitDdrawSurface: null,
                        explicitGlideSurfacePtr: 0,
                    };
                    this.writeSmackHeader(this.getMemory(), guestPtr, s);
                    this.sessions.set(guestPtr, s);

                    // Store audio SAB for volume/pan control via SmackVolumePan
                    if (info.hasAudio) {
                        s.audioSab = videoEngine.getAudioSab(engineHandle) ?? undefined;
                        if (s.audioSab) {
                            s.audioCtrl = new Int32Array(s.audioSab, 0, 32);
                        }
                    }

                    System.getInstance().videoRouting.openSession({
                        codec: "smack",
                        guestHandle: guestPtr,
                        width: info.width,
                        height: info.height,
                        fps: info.fps,
                        legacyPrimarySink: () => this.submitLegacyPrimarySink(s),
                    });

                    Logger.log(LogCategory.SYSTEM,
                        `SmackW32: open 0x${guestPtr.toString(16)} ${info.width}×${info.height} ` +
                        `${info.fps.toFixed(1)}fps ${info.frameCount}f ` +
                        `audio=${info.hasAudio ? `${info.sampleRate}Hz×${info.channels}ch` : 'none'}`);
                    return guestPtr;
                } catch (e) {
                    Logger.error(LogCategory.SYSTEM, `SmackOpen(HANDLE) error: ${e}`);
                    return this.fakeHandle;
                }
            } else if (arg0) {
                rawName = this.readCString(mem, arg0);
            }

            if (!rawName) return this.fakeHandle;

            try {
                const bytes = await this.readVfsFile(rawName);
                if (!bytes) {
                    Logger.warn(LogCategory.SYSTEM,
                        `SmackOpen("${rawName}"): file not found, using fake handle`);
                    return this.fakeHandle;
                }

                const engineHandle = await videoEngine.open(bytes);
                const info = videoEngine.getInfo(engineHandle);
                if (!info) { videoEngine.close(engineHandle); return this.fakeHandle; }

                const guestPtr = process.memory.alloc(SMACK_STRUCT_SIZE);
                const s: SmackSession = {
                    guestPtr, engineHandle,
                    width: info.width,
                    height: info.height,
                    frameCount: info.frameCount,
                    fps: info.fps,
                    lastFrameMs: 0,
                    eof: false,
                    destBuf: 0, destPitch: 0, destLeft: 0,
                    destTop: 0, destHeight: 0, destBpp: 0,
                    audioCtrl: null, lastPlayCursor: 0,
                    audioWrapCount: 0, audioBaselineMs: -1,
                    frameDecodeCount: 0, internalBuf: 0,
                    pendingBufferRect: false, lastDoFrameFlags: 0,
                    paletteRgb: null, paletteDirty: false,
                    explicitDdrawSurface: null,
                    explicitGlideSurfacePtr: 0,
                };
                this.writeSmackHeader(this.getMemory(), guestPtr, s);
                this.sessions.set(guestPtr, s);

                // Store audio SAB for volume/pan control via SmackVolumePan
                if (info.hasAudio) {
                    s.audioSab = videoEngine.getAudioSab(engineHandle) ?? undefined;
                    if (s.audioSab) {
                        s.audioCtrl = new Int32Array(s.audioSab, 0, 32);
                    }
                }

                System.getInstance().videoRouting.openSession({
                    codec: "smack",
                    guestHandle: guestPtr,
                    width: info.width,
                    height: info.height,
                    fps: info.fps,
                    legacyPrimarySink: () => this.submitLegacyPrimarySink(s),
                });

                Logger.log(LogCategory.SYSTEM,
                    `SmackOpen("${rawName}") → 0x${guestPtr.toString(16)} ` +
                    `(${info.width}×${info.height} ${info.fps.toFixed(2)}fps ${info.frameCount}f ` +
                    `audio=${info.hasAudio ? `${info.sampleRate}Hz×${info.channels}ch` : "none"})`);
                return guestPtr;

            } catch (e) {
                Logger.error(LogCategory.SYSTEM, `SmackOpen("${rawName}") error: ${e}`);
                return this.fakeHandle;
            }
        };

        // в”Ђв”Ђ SmackClose(HSMACK) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_SmackClose@4"] = (_ctx, _mem, args) => {
            const smk = args[0];
            const s = this.sessions.get(smk);
            if (s) {
                videoEngine.close(s.engineHandle);
                (self as any).postMessage({ type: 'video_end' });

                System.getInstance().videoRouting.closeSession("smack", smk);

                if (s.internalBuf) {
                    process.memory.free(s.internalBuf);
                }
                for (const [bufPtr, buf] of this.smackBuffers) {
                    if (buf.hSmack === smk) {
                        if (buf.pixelBuf) process.memory.free(buf.pixelBuf);
                        process.memory.free(buf.guestPtr);
                        this.smackBuffers.delete(bufPtr);
                    }
                }
                process.memory.free(s.guestPtr);
                this.sessions.delete(smk);
                Logger.log(LogCategory.SYSTEM, `SmackClose(0x${smk.toString(16)}): closed`);
            } else if (smk === this.fakeHandle) {
                Logger.verbose(LogCategory.SYSTEM, `SmackClose(fakeHandle): no-op`);
            }
            return 0;
        };

        // в”Ђв”Ђ SmackDoFrame(HSMACK) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        // Decode frame, copy pixels to guest memory (if SmackToBuffer was called),
        // and composite via WebGPU for direct display (DDraw surface may be locked).
        // This MUST be synchronous. Using async/setTimeout here freezes
        // virtual time while real time advances, breaking in-game narration timers.
        this.exports["_SmackDoFrame@4"] = (_ctx, _mem, args) => {
            const smk = args[0];
            const s = this.sessions.get(smk);
            if (s) {
                if (s.eof) return 0;

                const startMs = performance.now();
                const ok = videoEngine.doFrame(s.engineHandle);
                const decodeElapsed = performance.now() - startMs;

                // Restore "stolen" virtual time spent in heavy decoding back to the game clock
                if (decodeElapsed > 1) {
                    TimeService.getInstance().advanceVirtualTime(decodeElapsed);
                }

                s.lastFrameMs = performance.now();
                s.frameDecodeCount++;

                // Set audio baseline on first frame with active audio
                if (s.audioBaselineMs < 0 && s.audioCtrl) {
                    const t = this._getAudioTimeMs(s);
                    if (t >= 0) s.audioBaselineMs = t;
                }

                // Faithful Smacker auto-loop: real SmackNextFrame wraps the last frame
                // back to frame 0, so a clip the game keeps driving (animated menu panels,
                // ambient backgrounds) plays forever instead of freezing on its final
                // frame. Seek to 0 and decode it now, then fall through to the normal
                // palette/copy/routing path with the fresh frame. A genuine one-shot clip
                // never reaches here: the game stops driving it at the last frame before
                // the next DoFrame would EOF.
                let decoded = ok;
                if (!decoded && s.frameCount > 1) {
                    videoEngine.gotoFrame(s.engineHandle, 0);
                    s.audioBaselineMs = -1;    // re-baseline audio pacing for the new pass
                    s.frameDecodeCount = 1;    // about to (re)decode frame 0
                    decoded = videoEngine.doFrame(s.engineHandle);
                    if (decoded) {
                        const m = this.getMemory();
                        this.writeU32(m, smk + 20, 0);
                        this.writeU32(m, smk + 884, 0);
                        Logger.verbose(LogCategory.SYSTEM, `SmackW32: DoFrame loop→0 (smk=0x${smk.toString(16)})`);
                    }
                }
                if (!decoded) {
                    s.eof = true;
                    const m = this.getMemory();
                    if (m) {
                        const frames = m[smk + 12] | (m[smk + 13] << 8) | (m[smk + 14] << 16) | (m[smk + 15] << 24);
                        this.writeU32(m, smk + 20, frames);
                        this.writeU32(m, smk + 884, frames);
                    }
                    Logger.log(LogCategory.SYSTEM, `SmackW32: DoFrame EOF (smk=0x${smk.toString(16)})`);
                    return 0;
                }

                // Update palette in HSMACK struct after each frame
                const validPalette = this._getValidPalette(s);
                let doFrameFlags = SMACKFRM_NEWPIX;
                if (validPalette) {
                    const m2 = this.getMemory();
                    this._writePaletteToStruct(m2, smk, validPalette);
                    if (this.notePaletteChange(s, validPalette)) {
                        doFrameFlags |= SMACKFRM_NEWPAL;
                        this.writeU32(m2, smk + 0x68, 1);
                    } else {
                        this.writeU32(m2, smk + 0x68, 0);
                    }
                } else {
                    this.writeU32(this.getMemory(), smk + 0x68, 0);
                }

                s.lastDoFrameFlags = doFrameFlags;

                // Copy decoded pixels to guest memory if SmackToBuffer set a destination
                if (s.destBuf !== 0) {
                    const mem = this.getMemory();
                    this._copyFrameToGuest(s, mem);
                }
                // NOTE: _compositeToPrimary is deferred to SmackNextFrame so it
                // runs AFTER Storm's DDraw Blt (which would overwrite our frame).

                // Populate dirty rect fields for SmackToBufferRect iteration.
                {
                    const m = this.getMemory();
                    this.writeDirtyRect(m, smk, s);
                    s.pendingBufferRect = true;
                }

                System.getInstance().videoRouting.onFrameDecoded({
                    codec: "smack",
                    guestHandle: smk,
                    frame: this.buildFrameViews(s),
                    hasAppManagedSink: this.hasAppManagedSink(s),
                    targetHint: this.getRoutingTargetHint(s),
                    legacyPrimarySink: () => this.submitLegacyPrimarySink(s),
                    explicitDdrawSink: s.explicitDdrawSurface ? () => this.submitExplicitDdrawSink(s) : null,
                    explicitGlideSink: null,
                });

                // Storm SmackBuffer path: DoFrame==0 triggers FUN_6ffde580 → SmackToBufferRect loop.
                if (this.usesSmackBufferRectPath(s)) {
                    return 0;
                }
                return doFrameFlags;
            } else {
                // Unknown handle (game-allocated struct or fakeHandle from a previous session).
                // Patch Frames=1 at +12 so game's loop (FrameNum < Frames-1) doesn't wrap to 0xFFFFFFFF.
                const m = this.getMemory();
                if (m) {
                    const frames = m[smk + 12] | m[smk + 13] << 8 | m[smk + 14] << 16 | m[smk + 15] << 24;
                    if (frames === 0) {
                        if (!this.loggedUnknownHandles.has(smk)) {
                            this.loggedUnknownHandles.add(smk);
                            Logger.log(LogCategory.SYSTEM, `SmackW32: DoFrame unknown handle 0x${smk.toString(16)}, patching Frames=1`);
                        }
                        this.writeU32(m, smk + 12, 1);
                    } else {
                        if (!this.loggedUnknownHandles.has(smk)) {
                            this.loggedUnknownHandles.add(smk);
                            const frameNum = m[smk + 20] | m[smk + 21] << 8 | m[smk + 22] << 16 | m[smk + 23] << 24;
                            Logger.log(LogCategory.SYSTEM, `SmackW32: DoFrame unknown handle 0x${smk.toString(16)} Frames=${frames} FrameNum=${frameNum}`);
                        }
                    }
                }
            }
            return 0;
        };

        // в”Ђв”Ђ SmackNextFrame(HSMACK) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_SmackNextFrame@4"] = (_ctx, _mem, args) => {
            const smk = args[0];
            const s = this.sessions.get(smk);
            if (s) {
                if (s.eof) return 0;  // Don't overwrite FrameNum after EOF

                // Finalize routing decisions before advancing decoder frame index.
                System.getInstance().videoRouting.onFrameFinalize({
                    codec: "smack",
                    guestHandle: smk,
                    hasAppManagedSink: this.hasAppManagedSink(s),
                    targetHint: this.getRoutingTargetHint(s),
                    legacyPrimarySink: () => this.submitLegacyPrimarySink(s),
                    explicitDdrawSink: s.explicitDdrawSurface ? () => this.submitExplicitDdrawSink(s) : null,
                    explicitGlideSink: null,
                });

                videoEngine.nextFrame(s.engineHandle);
                const info = videoEngine.getInfo(s.engineHandle);
                if (info) {
                    const m = this.getMemory();
                    this.writeU32(m, smk + 20, info.currentFrame);  // FrameNum at +20
                    this.writeU32(m, smk + 884, info.currentFrame); // real SDK FrameNum offset
                    Logger.verbose(LogCategory.SYSTEM, `SmackW32: NextFrame → ${info.currentFrame}/${s.frameCount}`);
                }
            } else {
                // fakeHandle or unknown: increment FrameNum at +20 so game's loop exits
                const m = this.getMemory();
                if (m) {
                    const cur = m[smk + 20] | (m[smk + 21] << 8) | (m[smk + 22] << 16) | (m[smk + 23] << 24);
                    this.writeU32(m, smk + 20, cur + 1);
                    this.writeU32(m, smk + 884, cur + 1); // real SDK FrameNum offset
                }
            }
            return 0;
        };

        // в”Ђв”Ђ SmackWait(HSMACK) → 0 = ready, non-zero = not ready в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        // Synchronous polling API. Games call this in tight message/render loops;
        // async sleeping here turns every poll into an expensive parked thunk.
        this.exports["_SmackWait@4"] = (ctx, mem, args) => {
            const smk = args[0];
            const s = this.sessions.get(smk);
            if (!s || s.eof || s.fps <= 0 || s.lastFrameMs <= 0) return 0;

            const msPerFrame = 1000 / s.fps;

            // Audio-synced pacing
            if (s.audioBaselineMs >= 0 && s.audioCtrl) {
                const targetAudioMs = s.audioBaselineMs + s.frameDecodeCount * msPerFrame;
                const audioMs = this._getAudioTimeMs(s);
                if (audioMs >= 0 && audioMs < targetAudioMs) {
                    // Safety: don't hold back more than 3x frame time past wall-clock.
                    const wallElapsed = performance.now() - s.lastFrameMs;
                    if (wallElapsed < msPerFrame * 3) {
                        const audioRemaining = targetAudioMs - audioMs;
                        const safetyRemaining = msPerFrame * 3 - wallElapsed;
                        return this.markVideoWaitNotReady(ctx, mem, Math.min(audioRemaining, safetyRemaining));
                    }
                }
                return 0; // ready
            }

            // Fallback: wall-clock pacing
            const elapsed = performance.now() - s.lastFrameMs;
            if (elapsed < msPerFrame - 2) {
                return this.markVideoWaitNotReady(ctx, mem, msPerFrame - 2 - elapsed);
            }
            return 0; // ready
        };

        // в”Ђв”Ђ SmackToBuffer(HSMACK, left, top, pitch, height, buf, flags) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_SmackToBuffer@28"] = (_ctx, mem, args) => {
            const smk = args[0];
            const left = args[1];
            const top = args[2];
            let pitch = args[3];
            let destH = args[4];
            let buf = args[5];

            const s = this.sessions.get(smk);
            if (!s) return 0;

            // buf=0 means "use internal buffer" in real Smacker SDK.
            // Storm.dll calls SmackToBuffer(smk, 0, 0, pitch, h, 0, flags) and then
            // reads decoded pixels from HSMACK internal buffer pointers.
            if (buf === 0) {
                if (!s.internalBuf) {
                    const bufSize = s.width * s.height; // 8bpp
                    s.internalBuf = process.memory.alloc(bufSize);
                    Logger.log(LogCategory.SYSTEM,
                        `SmackToBuffer: allocated internal buffer at 0x${s.internalBuf.toString(16)} (${s.width}×${s.height}=${bufSize} bytes)`);
                }
                buf = s.internalBuf;
                // Write internal buffer pointer to HSMACK+0x3c/+0x448 so Storm can read it
                this.writeU32(mem, smk + 0x3c, s.internalBuf);
                this.writeU32(mem, smk + 0x448, s.internalBuf);
                // Use video dimensions if caller passed 0
                if (!pitch) pitch = s.width;
                if (!destH) destH = s.height;
            }

            const destBpp = smkDetectDestBpp(pitch, s.width);

            // Store destination params so SmackDoFrame can copy on subsequent frames
            const sbufForDest = this.findBufferByPixelBuf(buf);
            if (sbufForDest && sbufForDest.hSmack !== smk) {
                sbufForDest.hSmack = smk;
            }
            s.destBuf = buf;
            s.destPitch = pitch;
            s.destLeft = left;
            s.destTop = top;
            s.destHeight = destH;
            s.destBpp = destBpp;
            this.updateExplicitSinkHints(s, buf);
            const rows = Math.min(s.height, destH - top);

            if (destBpp === 1) {
                // 8bpp: use PAL8 indices directly (zero conversion)
                const pal8 = videoEngine.getFramePal8(s.engineHandle);
                if (pal8) {
                    for (let row = 0; row < rows; row++) {
                        const srcOff = row * s.width;
                        const dstOff = buf + (top + row) * pitch + left;
                        const rowData = pal8.indices.subarray(srcOff, srcOff + s.width);
                        if (!this.writeBytesChecked(dstOff, rowData)) {
                            return 0;
                        }
                    }
                    // Write valid palette into HSMACK struct
                    const validPal = this._getValidPalette(s);
                    if (validPal) {
                        this._writePaletteToStruct(mem, smk, validPal);
                    }
                    return 0;
                }
                // Fallback: no PAL8 available (pre-rebuild WASM), use BGRA → luminance
                const bgra = videoEngine.getFrameBgra(s.engineHandle);
                if (!bgra) return 0;
                const rowScratch = new Uint8Array(s.width);
                for (let row = 0; row < rows; row++) {
                    for (let x = 0; x < s.width; x++) {
                        const si = row * s.width * 4 + x * 4;
                        // BGRA -> luminance
                        rowScratch[x] = (bgra[si + 2] * 77 + bgra[si + 1] * 150 + bgra[si] * 29) >> 8;
                    }
                    const dstOff = buf + (top + row) * pitch + left;
                    if (!this.writeBytesChecked(dstOff, rowScratch)) {
                        return 0;
                    }
                }
                return 0;
            }

            // 16bpp: prefer WASM-side RGB565 (memcpy per row)
            if (destBpp === 2) {
                const rgb565 = videoEngine.getFrameRgb565(s.engineHandle);
                if (rgb565) {
                    const srcPitch = s.width * 2;
                    for (let row = 0; row < rows; row++) {
                        const srcOff = row * srcPitch;
                        const dstOff = buf + (top + row) * pitch + left * 2;
                        const rowData = rgb565.subarray(srcOff, srcOff + srcPitch);
                        if (!this.writeBytesChecked(dstOff, rowData)) {
                            return 0;
                        }
                    }
                    return 0;
                }
            }

            // 16bpp (fallback) / 32bpp: use BGRA frame
            const bgra = videoEngine.getFrameBgra(s.engineHandle);
            if (!bgra) return 0;

            const srcPitch = s.width * 4;
            const rowScratch = new Uint8Array(s.width * destBpp);
            for (let row = 0; row < rows; row++) {
                const srcOff = row * srcPitch;
                const dstOff = buf + (top + row) * pitch + left * destBpp;
                smkCopyDecodedRow(bgra, srcOff, rowScratch, 0, s.width, destBpp);
                if (!this.writeBytesChecked(dstOff, rowScratch)) {
                    return 0;
                }
            }
            return 0;
        };

        // в”Ђв”Ђ SmackToBufferRect(handle, SmackDoFrameReturn) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        // Real API: SmackToBufferRect(hSmackOrBuf, changeFlags).
        // Storm loops while return != 0, reading dirty rects from HSMACK+0x380..+0x38c.
        this.exports["_SmackToBufferRect@8"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const hSmack = this.resolveHsmackFromRectHandle(handle);
            const s = hSmack ? this.sessions.get(hSmack) : undefined;
            if (!s || !s.pendingBufferRect) return 0;
            s.pendingBufferRect = false;
            return s.lastDoFrameFlags || SMACKFRM_NEWPIX;
        };

        // в”Ђв”Ђ SmackGoto(HSMACK, frame) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_SmackGoto@8"] = (_ctx, _mem, args) => {
            const smk = args[0];
            const frame = args[1];
            const s = this.sessions.get(smk);
            if (s) {
                videoEngine.gotoFrame(s.engineHandle, frame);
                s.eof = false; // seeking resets EOF state
            }
            const m = this.getMemory();
            if (m) {
                this.writeU32(m, smk + 20, frame);  // FrameNum at +20
                this.writeU32(m, smk + 884, frame); // real SDK FrameNum offset
            }
            return 0;
        };

        // в”Ђв”Ђ Buffer API в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

        // SmackBufferOpen(hwnd, blitType, w, h, stretchW, stretchH) → HSMACKBUF guest ptr
        this.exports["_SmackBufferOpen@24"] = (_ctx, mem, args) => {
            const width = args[2] | 0;
            const height = args[3] | 0;
            const stretchW = args[4] | 0;
            const stretchH = args[5] | 0;
            const pixelW = width > 0 ? width : 1;
            const pixelH = height > 0 ? height : 1;
            const pixelPitch = pixelW; // 8bpp indices
            const pixelBuf = process.memory.alloc(pixelPitch * pixelH);

            const guestPtr = process.memory.alloc(SMACKBUF_STRUCT_SIZE);
            const session: SmackBufferSession = {
                guestPtr,
                hwnd: args[0],
                blitType: args[1],
                width: pixelW,
                height: pixelH,
                stretchWidth: stretchW,
                stretchHeight: stretchH,
                pixelBuf,
                pixelPitch,
                hSmack: 0,
            };
            this.writeSmackBufferHeader(mem, session);
            this.smackBuffers.set(guestPtr, session);
            Logger.log(LogCategory.SYSTEM,
                `SmackBufferOpen → 0x${guestPtr.toString(16)} (${pixelW}×${pixelH} stretch ${stretchW}×${stretchH} buf=0x${pixelBuf.toString(16)})`);
            return guestPtr;
        };

        // SmackBufferClose(hSmackBuf) → 0
        this.exports["_SmackBufferClose@4"] = (_ctx, _mem, args) => {
            const hBuf = args[0];
            const sbuf = this.smackBuffers.get(hBuf);
            if (sbuf) {
                if (sbuf.pixelBuf) process.memory.free(sbuf.pixelBuf);
                process.memory.free(sbuf.guestPtr);
                this.smackBuffers.delete(hBuf);
            }
            return 0;
        };

        // SmackBufferNewPalette(hSmackBuf, palPtr, palType) → 0
        // Link SmackBuffer → HSMACK; clear NewPalette after Storm consumes palette.
        this.exports["_SmackBufferNewPalette@12"] = (_ctx, mem, args) => {
            const hSmackBuf = args[0];
            const palPtr = args[1];

            const sbuf = this.smackBuffers.get(hSmackBuf);
            const hSmack = palPtr - 0x6c;
            if (sbuf) sbuf.hSmack = hSmack;

            const s = this.sessions.get(hSmack);
            if (s) {
                this.writeU32(mem, hSmack + 0x68, 0);
                s.paletteDirty = false;
            }

            return 0;
        };

        // в”Ђв”Ђ Sound control в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_SmackSoundOnOff@8"] = (_ctx, _mem, args) => { return 0; };
        // SmackVolumePan(HSMACK, trackFlags, volume, pan)
        // trackFlags: bitmask of audio tracks (0xfe000 = all tracks)
        // volume: 0..65536 (Smacker SDK scale)
        // pan: 0x8000 = center
        this.exports["_SmackVolumePan@16"] = (_ctx, _mem, args) => {
            const smk = args[0];
            const vol = args[2];  // 0..65536 (Smacker SDK), or game-scaled value
            const s = this.sessions.get(smk);
            if (s?.audioSab) {
                // Smacker volume scale varies by game; normalize assuming max ~65536
                const maxVol = 65536;
                const linear = Math.min(1, vol / maxVol);
                const centibels = linear <= 0 ? -10000 : Math.max(-10000, Math.round(2000 * Math.log10(linear)));
                setCtrl(s.audioSab, CTRL_VOLUME, centibels);
            }
            return 0;
        };
    }

    reset(): void {
        // Engines already closed by System.reset → videoEngine.closeAll(); drop host maps
        // so reused guest VAs cannot resolve to a previous session.
        this.sessions.clear();
        this.smackBuffers.clear();
        this.loggedUnknownHandles.clear();
        this.soundDriverSet = false;
        this.fakeHandle = 0;
    }

    reregisterExports(process: Process): void {
        this.process = process;
        this.fakeHandle = process.memory.alloc(SMACK_STRUCT_SIZE);
        const mem = this.getMemory();
        if (mem) {
            mem.fill(0, this.fakeHandle, this.fakeHandle + SMACK_STRUCT_SIZE);
            mem[this.fakeHandle + 0] = 0x53; mem[this.fakeHandle + 1] = 0x4D;
            mem[this.fakeHandle + 2] = 0x4B; mem[this.fakeHandle + 3] = 0x32;
            this.writeU32(mem, this.fakeHandle + 12, 1);
        }
    }
}
