/**
 * Bink Video Library (binkw32.dll)
 *
 * Decodes .BIK video files via the FFmpeg WASM video engine.
 * Falls back to stub (return 0) when the WASM module is unavailable.
 *
 * The HBINK struct handed to the guest follows the ABI of the binkw32.dll the title
 * ships (bink-struct.ts): RAD moved Frames/FrameNum/rects between SDK releases, and
 * the guest reads them at the offsets its own header declared. The layout is resolved
 * once per session from that DLL's version resource.
 *
 * Allocation is oversized (2048 bytes, zero-filled) because games read internal
 * fields at higher offsets (rect pointers, frame buffers, etc.).  Without enough
 * zeroed space, pointer fields contain heap garbage → game dereferences them →
 * infinite loop / crash.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult, X86Context } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { videoEngine } from "../../video/video-engine";
import { CTRL_PLAY_CURSOR, CTRL_BUFFER_BYTES, CTRL_BLOCK_ALIGN, CTRL_SAMPLE_RATE, CTRL_STATE, STATE_PLAYING } from "../../audio/audio-ring-buffer";
import { DirectDrawSurfaceObject, DirectDrawSurfaceState, isRenderSurface, type BitmapTextureSurface } from "./ddraw/com-objects";
import { setAuthorityCpu } from "./ddraw/surface-sync";
import { resolveD3D8TextureSurface } from "./d3d8/shared-state";
import { resolveD3D9LockedTextureTarget } from "./d3d9/shared-state";
import { readAnsiFromGuest } from "./codepage-utils";
import { Mem } from "../core/memory/mem-accessor";
import { overlapsThunkCode } from "../core/memory/address-guard";
import { Glide2x } from "./glide2x";
import { VideoFrameViews } from "../video/video-routing-types";
import { readPeVersionString, readPeFixedFileVersion } from "../core/pe-version";
import { BinkStructLayout, BINK_LAYOUT_DEFAULT, binkLayoutFor, selectBinkLayout } from "./bink-struct";

// Real HBINK structs are 300-500+ bytes depending on SDK version.  Games read
// internal fields (rect pointers, frame buffer ptrs) at offsets well beyond our
// populated header.  Allocate generously and zero-fill so all pointer fields
// are NULL and all counts are 0 — prevents games from dereferencing garbage.
const BINK_HANDLE_SIZE = 2048;

/**
 * BINKSURFACE* — the destination pixel format, named by the GAME in the low nibble
 * (BINKSURFACEMASK) of the `flags` argument to BinkCopyToBuffer/BinkCopyToBufferRect.
 *
 * This is the only authoritative source for the format: the destination is a bare
 * pointer + pitch, so nothing about its layout can be derived, and a title that never
 * calls BinkDDSurfaceType/BinkBufferOpen declares its format here and nowhere else.
 * Guessing bytes-per-pixel from `pitch / width` is a fallback for the flags==8P case
 * only (see binkSurfaceFromFlags).
 */
const enum BinkSurface {
    P8       = 0,   // 8-bit palette indices
    BGR24    = 1,   // BINKSURFACE24
    RGB24    = 2,   // BINKSURFACE24R
    BGRA32   = 3,   // BINKSURFACE32
    RGBA32   = 4,   // BINKSURFACE32R
    BGRA32A  = 5,   // BINKSURFACE32A
    RGBA32A  = 6,   // BINKSURFACE32RA
    ARGB4444 = 7,
    ARGB1555 = 8,   // BINKSURFACE5551
    XRGB1555 = 9,   // BINKSURFACE555
    RGB565   = 10,
    RGB655   = 11,
    RGB664   = 12,
    YUY2     = 13,
    UYVY     = 14,
    YV12     = 15,
}
const BINKSURFACE_MASK = 0xF;

/** Bytes per pixel per BINKSURFACE type; 0 = a packed/planar YUV we do not emit. */
const BINK_SURFACE_BPP: readonly number[] = [1, 3, 3, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 0, 0, 0];

function binkSurfaceBpp(surf: BinkSurface): number {
    return BINK_SURFACE_BPP[surf] || 4;
}

/**
 * Destination format the game declared, or -1 when it declared nothing usable.
 *
 * BINKSURFACE8P is 0, which is indistinguishable from "passed no flags at all" — and
 * our BinkDDSurfaceType hands back 0 precisely because we cannot know the caller's SDK
 * constants — so 0 stays with the pitch/surface heuristic rather than forcing 8bpp
 * palettized output. The YUV types have no BGRA-sourced packer here.
 */
function binkSurfaceFromFlags(flags: number): BinkSurface | -1 {
    const surf = (flags & BINKSURFACE_MASK) as BinkSurface;
    if (surf === BinkSurface.P8) return -1;
    return BINK_SURFACE_BPP[surf] > 0 ? surf : -1;
}

/** The BINKSURFACE type the legacy bytes-per-pixel heuristic stands for. */
function binkSurfaceFromBpp(bpp: number): BinkSurface {
    switch (bpp) {
        case 1:  return BinkSurface.P8;
        case 2:  return BinkSurface.RGB565;
        case 3:  return BinkSurface.BGR24;
        default: return BinkSurface.BGRA32;
    }
}

/**
 * Detect destination bytes-per-pixel from pitch and destination row width in pixels.
 * Using video width here breaks D3D8 texture targets (e.g. 512-wide surface, 640-wide Bink).
 */
function detectDestBpp(pitch: number, destRowPixels: number): number {
    if (pitch <= 0 || destRowPixels <= 0) return 4;
    if (pitch % destRowPixels === 0) {
        const bpp = pitch / destRowPixels;
        if (bpp === 1 || bpp === 2 || bpp === 3 || bpp === 4) return bpp;
    }
    return 4;
}

function inferDestRowPixels(pitch: number, storedBpp: number, surface: BitmapTextureSurface | null): number {
    if (surface?.width) return surface.width;
    if (storedBpp > 0 && pitch > 0 && pitch % storedBpp === 0) return pitch / storedBpp;
    if (pitch > 0) {
        for (const bpp of [4, 3, 2, 1]) {
            if (pitch % bpp === 0) {
                const w = pitch / bpp;
                if (w >= 16 && w <= 4096) return w;
            }
        }
    }
    return 0;
}

function isGpuVideoPresenterActive(): boolean {
    return !!System.getInstance().services.render.getActive()?.suppressGdiOverlay;
}

/** Pack one BGRA pixel into the 16-bit layout `surf` names. */
function pack16(surf: BinkSurface, b: number, g: number, r: number, a: number): number {
    switch (surf) {
        case BinkSurface.ARGB4444: return ((a & 0xF0) << 8) | ((r & 0xF0) << 4) | (g & 0xF0) | (b >> 4);
        case BinkSurface.ARGB1555: return (a >= 0x80 ? 0x8000 : 0) | ((r & 0xF8) << 7) | ((g & 0xF8) << 2) | (b >> 3);
        case BinkSurface.XRGB1555: return ((r & 0xF8) << 7) | ((g & 0xF8) << 2) | (b >> 3);
        case BinkSurface.RGB655:   return ((r & 0xFC) << 8) | ((g & 0xF8) << 2) | (b >> 3);
        case BinkSurface.RGB664:   return ((r & 0xFC) << 8) | ((g & 0xFC) << 2) | (b >> 4);
        default:                   return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); // RGB565
    }
}

/**
 * Copy one row of decoded pixels into the destination format the game declared.
 * The decoder emits BGRA: [B, G, R, A], i.e. little-endian u32 A<<24|R<<16|G<<8|B.
 *
 * The 16bpp packers use Uint32Array/Uint16Array views where alignment allows
 * (~3-5x over byte-at-a-time); BINKSURFACE32 is already native DDraw order (memcpy).
 */
function copyDecodedRow(
    src: Uint8Array, srcOff: number,
    dst: Uint8Array, dstOff: number,
    width: number, surf: BinkSurface,
): void {
    switch (surf) {
        case BinkSurface.P8:
            // BGRA → luminance as palette index (rough approximation)
            for (let x = 0; x < width; x++) {
                const si = srcOff + x * 4;
                dst[dstOff + x] = (src[si + 2] * 77 + src[si + 1] * 150 + src[si] * 29) >> 8;
            }
            return;

        case BinkSurface.BGR24:
            for (let x = 0; x < width; x++) {
                const si = srcOff + x * 4;
                const di = dstOff + x * 3;
                dst[di] = src[si];
                dst[di + 1] = src[si + 1];
                dst[di + 2] = src[si + 2];
            }
            return;

        case BinkSurface.RGB24:
            for (let x = 0; x < width; x++) {
                const si = srcOff + x * 4;
                const di = dstOff + x * 3;
                dst[di] = src[si + 2];
                dst[di + 1] = src[si + 1];
                dst[di + 2] = src[si];
            }
            return;

        case BinkSurface.RGBA32:
        case BinkSurface.RGBA32A:
            for (let x = 0; x < width; x++) {
                const si = srcOff + x * 4;
                const di = dstOff + x * 4;
                dst[di] = src[si + 2];
                dst[di + 1] = src[si + 1];
                dst[di + 2] = src[si];
                dst[di + 3] = src[si + 3];
            }
            return;

        case BinkSurface.BGRA32:
        case BinkSurface.BGRA32A:
            dst.set(src.subarray(srcOff, srcOff + width * 4), dstOff);
            return;

        default: {
            const srcAbs = src.byteOffset + srcOff;
            const dstAbs = dst.byteOffset + dstOff;
            if ((srcAbs & 3) === 0 && (dstAbs & 1) === 0) {
                const src32 = new Uint32Array(src.buffer, srcAbs, width);
                const dst16 = new Uint16Array(dst.buffer, dstAbs, width);
                for (let x = 0; x < width; x++) {
                    const px = src32[x];
                    dst16[x] = pack16(surf, px & 0xFF, (px >>> 8) & 0xFF, (px >>> 16) & 0xFF, (px >>> 24) & 0xFF);
                }
            } else {
                for (let x = 0; x < width; x++) {
                    const si = srcOff + x * 4;
                    const v = pack16(surf, src[si], src[si + 1], src[si + 2], src[si + 3]);
                    const di = dstOff + x * 2;
                    dst[di]     = v & 0xFF;
                    dst[di + 1] = (v >> 8) & 0xFF;
                }
            }
            return;
        }
    }
}

/** Per-open session: maps guest ptr → JS-side video engine handle */
interface BinkSession {
    guestPtr:    number;  // pointer returned to game
    engineHandle: number; // video engine handle
    width:       number;
    height:      number;
    frameCount:  number;
    fps:         number;
    lastFrameMs: number;  // performance.now() after last DoFrame decode
    paused:      boolean; // BinkPause state
    loggedCopy:  boolean; // one-shot diagnostic log for CopyToBuffer
    eof:         boolean; // true after first EOF from decoder
    // Audio sync fields
    audioSab?:       SharedArrayBuffer;
    audioCtrl:       Int32Array | null;
    lastPlayCursor:  number;
    audioWrapCount:  number;
    audioBaselineMs: number;   // -1 = not set
    frameDecodeCount: number;
    destPtr: number;
    destPitch: number;
    destHeight: number;
    destX: number;
    destY: number;
    destBpp: number;
    explicitDdrawSurface: DirectDrawSurfaceState | null;
    explicitGlideSurfacePtr: number;
    /** Geometry of the D3D9 texture lock the last copy destination fell inside, if any.
     *  Sampled at COPY time — the guest unlocks right after, and by the time the sink is
     *  chosen the lock is gone. */
    d3d9LockTarget: { pitch: number; width: number; height: number } | null;
    lastCopyAtMs: number;
    hasBufferApiHint: boolean;
    hasPointerFault: boolean;
    videoOn: boolean;   // BinkSetVideoOnOff — mutes video path only, audio/timing keep running
    ioSize:  number;    // IO buffer size hint set by BinkSetIOSize before BinkOpen
}

interface BinkBufferSession {
    handle: number;
    hwnd: number;
    width: number;
    height: number;
    flags: number;
    locked: boolean;
    lastBlitAtMs: number;
}

export class BinkW32 implements IModule {
    name = "binkw32";
    exports: Record<string, ThunkImplementation> = {};

    private process!: Process;

    /** Maps guest BinkHandle ptr → session */
    private sessions: Map<number, BinkSession> = new Map();

    /** Surface bpp determined by BinkDDSurfaceType (0 = not yet called) */
    private lastSurfaceBpp: number = 0;

    /** HBINK field offsets for the binkw32.dll this title ships (see bink-struct.ts). */
    private layout: BinkStructLayout = BINK_LAYOUT_DEFAULT;
    private layoutResolved = false;
    private nextBufferHandle = 0x7800;
    private binkBuffers = new Map<number, BinkBufferSession>();

    /**
     * Global IO buffer size hint set by BinkSetIOSize(iosize) before BinkOpen.
     * Stored here and copied into the session's ioSize field at open time.
     * Native Bink uses this to size its read-ahead ring buffer; we track it
     * for ABI faithfulness but don't use it to actually size any buffer.
     */
    private pendingIoSize: number = 0;

    /** Diagnostic: log first N API calls per session to trace game's video loop pattern */
    private apiCallLog: Map<number, number> = new Map();
    private _logApi(bink: number, name: string, extra = ""): void {
        const count = (this.apiCallLog.get(bink) ?? 0) + 1;
        this.apiCallLog.set(bink, count);
        if (count <= 30) {
            const s = this.sessions.get(bink);
            const frame = s ? s.frameDecodeCount : "?";
            Logger.log(LogCategory.SYSTEM,
                `[BINK-TRACE] #${count} ${name} bink=0x${bink.toString(16)} frame=${frame}${extra ? " " + extra : ""}`);
        }
    }

    private getMemory(): Uint8Array {
        return this.process.getCurrentMemory();
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

    private readU32(mem: Uint8Array, addr: number): number {
        return (mem[addr] | (mem[addr+1] << 8) | (mem[addr+2] << 16) | (mem[addr+3] << 24)) >>> 0;
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
                if (state.surfacePtr === surfacePtr) {
                    return state;
                }
            }
        }
        return null;
    }

    private resolveBitmapTextureTarget(addr: number): BitmapTextureSurface | null {
        const ddraw = this.resolveDdrawSurfaceStateBySurfacePtr(addr);
        if (ddraw?.surfaceType === "bitmap_texture") {
            return ddraw;
        }
        return resolveD3D8TextureSurface(addr);
    }

    private resolveGlideLfbPointer(surfacePtr: number): number {
        if (!surfacePtr) return 0;
        const glide = System.getInstance().process?.getModule("glide2x") as Glide2x | undefined;
        const lfb = glide?.findLfbSurfaceByDataPtr?.(surfacePtr);
        return lfb ? surfacePtr : 0;
    }

    private updateExplicitSinkHints(s: BinkSession, surfacePtr: number): void {
        const bitmap = this.resolveBitmapTextureTarget(surfacePtr);
        if (!bitmap) {
            const locked = resolveD3D9LockedTextureTarget(surfacePtr);
            if (locked) s.d3d9LockTarget = locked;
        }
        s.explicitDdrawSurface = bitmap;
        if (bitmap && isRenderSurface(bitmap)) {
            setAuthorityCpu(bitmap);
        }
        s.explicitGlideSurfacePtr = bitmap ? 0 : this.resolveGlideLfbPointer(surfacePtr);
    }

    private getCopyGeometry(
        s: BinkSession,
        destPtr: number,
        pitch: number,
        destH: number,
        destX: number,
        destY: number,
        storedBpp: number,
        flags: number,
    ): { surf: BinkSurface; destBpp: number; copyWidth: number; rows: number; destSurface: BitmapTextureSurface | null } {
        const destSurface = this.resolveBitmapTextureTarget(destPtr);
        const declared = binkSurfaceFromFlags(flags);
        const destRowPixels = inferDestRowPixels(pitch, storedBpp, destSurface);
        const surf = declared !== -1
            ? declared
            : binkSurfaceFromBpp(storedBpp || detectDestBpp(pitch, destRowPixels || s.width));
        const destBpp = binkSurfaceBpp(surf);
        const maxWidth = destRowPixels > 0 ? Math.max(0, destRowPixels - destX) : s.width;
        const maxHeight = destSurface
            ? Math.max(0, destSurface.height - destY)
            : Math.max(0, destH - destY);
        const copyWidth = Math.min(s.width, maxWidth);
        const rows = Math.min(s.height, destH - destY, maxHeight);
        return { surf, destBpp, copyWidth, rows, destSurface };
    }

    private hasAppManagedSink(s: BinkSession): boolean {
        if (s.explicitDdrawSurface || s.explicitGlideSurfacePtr) return true;
        if (!s.destPtr && !s.hasBufferApiHint) return false;
        // Morrowind-style D3D8: BinkCopyToBuffer → raw malloc buffer, then custom GPU upload.
        // Until we resolve a real texture/surface, don't block the video overlay fallback.
        if (isGpuVideoPresenterActive() && !this.resolveBitmapTextureTarget(s.destPtr)) {
            return false;
        }
        return true;
    }

    private getRoutingTargetHint(s: BinkSession): { kind: "none" | "ddraw_surface" | "glide_lfb" | "app_buffer"; valid: boolean; surfacePtr?: number; pitch?: number; width?: number; height?: number } {
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
                pitch: s.destPitch,
                width: s.width,
                height: s.height,
            };
        }
        if (s.destPtr || s.hasBufferApiHint) {
            const gpuPresenter = isGpuVideoPresenterActive();
            const resolvedSurface = s.destPtr ? this.resolveBitmapTextureTarget(s.destPtr) : null;
            // A D3D9 LockRect staging buffer is uploaded by the guest's own UnlockRect, so
            // it stays visible under a GPU presenter — without this the sink falls back to
            // the video overlay, which presents the movie OVER the game's own frame and
            // hides the UI a menu draws on top of its background loop.
            const lockedTexture = resolvedSurface
                ? null
                : (s.destPtr ? resolveD3D9LockedTextureTarget(s.destPtr) : null) ?? s.d3d9LockTarget;
            return {
                kind: "app_buffer",
                valid: !gpuPresenter || !!resolvedSurface || !!lockedTexture,
                surfacePtr: s.destPtr || undefined,
                pitch: s.destPitch || lockedTexture?.pitch || undefined,
                width: resolvedSurface?.width ?? lockedTexture?.width ?? s.width,
                height: resolvedSurface?.height ?? lockedTexture?.height ?? s.height,
            };
        }
        return { kind: "none", valid: false };
    }

    private buildFrameViews(s: BinkSession): VideoFrameViews {
        const pal8 = videoEngine.getFramePal8(s.engineHandle);
        return {
            width: s.width,
            height: s.height,
            frameIndex: s.frameDecodeCount,
            frameDurationMs: s.fps > 0 ? 1000 / s.fps : 66,
            decodedAtMs: performance.now(),
            bgra: videoEngine.getFrameBgra(s.engineHandle),
            rgb565: videoEngine.getFrameRgb565(s.engineHandle),
            pal8Indices: pal8?.indices ?? null,
            paletteBgra: pal8?.palette ?? null,
        };
    }

    private submitExplicitDdrawSink(s: BinkSession): boolean {
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

    /**
     * Derive absolute audio playback time (ms) from the ring buffer's play cursor.
     * Detects wraps by checking if cursor jumped backward by more than half the buffer.
     */
    /**
     * Replace a hot BinkWait poll loop with one scheduler deadline. The thunk stays
     * synchronous from the guest's perspective: its post-return context is saved and
     * EAX=0 (frame ready) is delivered only when the timer wakes the thread.
     */
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

    private _getAudioTimeMs(s: BinkSession): number {
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

    /**
     * Decode one frame and update session state.
     * DDraw Blt/BltFast handles all presentation — game controls position and order.
     */
    private _decodeFrame(s: BinkSession, bink: number): void {
        const ok = videoEngine.doFrame(s.engineHandle);
        s.lastFrameMs = performance.now();
        s.frameDecodeCount++;

        // Set audio baseline on first frame with active audio
        if (s.audioBaselineMs < 0 && s.audioCtrl) {
            const t = this._getAudioTimeMs(s);
            if (t >= 0) s.audioBaselineMs = t;
        }

        const L = this.layout;
        if (!ok) {
            s.eof = true;
            const m = this.getMemory();
            const frames = this.readU32(m, bink + L.frames);
            this.writeU32(m, bink + L.frameNum, frames);
            console.log(`[BINK] BinkDoFrame(0x${bink.toString(16)}): EOF (set FrameNum=${frames})`);
        } else {
            // Publish one whole-frame dirty rect (BINKRECT {Left,Top,Width,Height}) plus
            // NumRects. Games call BinkGetRects and blit exactly this region — left zero,
            // they blit a 0x0 area and the video is invisible.
            const m = this.getMemory();
            this.writeU32(m, bink + L.frameRects + 0, 0);
            this.writeU32(m, bink + L.frameRects + 4, 0);
            this.writeU32(m, bink + L.frameRects + 8, s.width);
            this.writeU32(m, bink + L.frameRects + 12, s.height);
            this.writeU32(m, bink + L.numRects, 1);
        }
    }

    /**
     * Zero out the dirty-rect fields written by _decodeFrame so the game sees
     * no changed region and skips the blit — the video-off equivalent of
     * "nothing decoded this frame".
     */
    private clearBinkDirtyRects(bink: number): void {
        const m = this.getMemory();
        const L = this.layout;
        this.writeU32(m, bink + L.frameRects + 0, 0);
        this.writeU32(m, bink + L.frameRects + 4, 0);
        this.writeU32(m, bink + L.frameRects + 8, 0);
        this.writeU32(m, bink + L.frameRects + 12, 0);
        this.writeU32(m, bink + L.numRects, 0);
    }

    /**
     * Sync the native-ABI compat fields in the guest HBINK struct that real
     * Bink sets when BinkSetVideoOnOff / BinkSetIOSize change state: bit 0x20000
     * of OpenFlags is the video-disabled flag. Games that read it directly (e.g.
     * to decide whether to call CopyToBuffer) then see the right value.
     */
    private writeBinkCompatState(bink: number, s: BinkSession): void {
        const m = this.getMemory();
        let flags = this.readU32(m, bink + this.layout.openFlags);
        const VIDEO_OFF_FLAG = 0x00020000;
        if (s.videoOn) {
            flags &= ~VIDEO_OFF_FLAG;
        } else {
            flags |= VIDEO_OFF_FLAG;
        }
        this.writeU32(m, bink + this.layout.openFlags, flags);
    }

    private readCString(mem: Uint8Array, ptr: number, maxLen = 520): string {
        return readAnsiFromGuest(mem, ptr, maxLen);
    }

    /** Read a complete file from VFS into a Uint8Array. */
    private async readVfsFile(path: string): Promise<Uint8Array | null> {
        try {
            const vfs  = System.getInstance().fileSystem;
            const size = vfs.getFileSize(path);
            if (size <= 0) {
                Logger.warn(LogCategory.SYSTEM, `[BinkW32] readVfsFile("${path}"): size=${size}`);
                return null;
            }
            const LIMIT_BYTES = 256 * 1024 * 1024; // 256 MB cap
            if (size > LIMIT_BYTES) {
                Logger.warn(LogCategory.SYSTEM,
                    `[BinkW32] readVfsFile("${path}"): size ${size} exceeds ${LIMIT_BYTES} limit, skipping`);
                return null;
            }
            const GENERIC_READ = 0x80000000;
            const OPEN_EXISTING = 3;
            const handle = await vfs.open(path, GENERIC_READ, OPEN_EXISTING);
            if (!handle) {
                Logger.warn(LogCategory.SYSTEM, `[BinkW32] readVfsFile("${path}"): open failed`);
                return null;
            }
            const data = await vfs.read(handle, size);
            return data;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `[BinkW32] readVfsFile("${path}") error: ${e}`);
            return null;
        }
    }

    /**
     * Resolve the HBINK ABI from the binkw32.dll the bundle ships. We stand in for that
     * DLL, so its SDK release — not the .bik file — decides where the guest looks for
     * Frames/FrameNum/dirty rects. Resolved once per session, before the first HBINK is
     * built; a missing/unreadable DLL keeps the default layout.
     */
    private async ensureLayout(): Promise<void> {
        if (this.layoutResolved) return;
        this.layoutResolved = true;
        const path = System.getInstance().process?.loader?.findDllPath("binkw32");
        if (!path) {
            Logger.warn(LogCategory.SYSTEM,
                `[BinkW32] binkw32.dll not found in the bundle — assuming Bink ${this.layout.id} struct layout`);
            return;
        }
        const image = await this.readVfsFile(path);
        const version = image ? readPeVersionString(image, "FileVersion") : null;
        // StringFileInfo is localizable text a build may omit; VS_FIXEDFILEINFO is the
        // binary version every versioned image carries.
        const fixed = image ? readPeFixedFileVersion(image) : null;
        const resolved = selectBinkLayout(version)
            ?? (fixed ? binkLayoutFor(fixed.major, fixed.minor) : null);
        if (!resolved) {
            Logger.error(LogCategory.SYSTEM,
                `[BinkW32] ${path}: no readable version (FileVersion="${version ?? ""}", no VS_FIXEDFILEINFO) — ` +
                `GUESSING HBINK layout ${this.layout.id}. If this DLL is 0.8x, Frames/FrameNum land 8 bytes ` +
                `off and the guest's "video finished" test never fires.`);
            return;
        }
        this.layout = resolved;
        Logger.log(LogCategory.SYSTEM,
            `[BinkW32] ${path}: FileVersion="${version ?? "?"}"` +
            `${fixed ? ` fixed=${fixed.major}.${fixed.minor}.${fixed.build}.${fixed.revision}` : ""}` +
            ` → HBINK layout ${this.layout.id} ` +
            `(Frames@0x${this.layout.frames.toString(16)} FrameNum@0x${this.layout.frameNum.toString(16)} ` +
            `rects@0x${this.layout.frameRects.toString(16)})`);
    }

    initialize(process: Process): void {
        this.process = process;

        // BinkSetSoundSystem — no-op (we handle audio directly via SAB)
        this.exports["_BinkSetSoundSystem@8"] = (_ctx, _mem, args) => {
            console.log(`[BINK] BinkSetSoundSystem(callback=0x${args[0].toString(16)}, param=0x${args[1].toString(16)})`);
            return 1;
        };

        // BinkOpenMiles(HDIGDRIVER driver) — Miles Sound System audio init for Bink, no-op
        this.exports["_BinkOpenMiles@4"] = (_ctx, _mem, args) => {
            console.log(`[BINK] BinkOpenMiles(driver=0x${args[0].toString(16)}) - no-op`);
            return 1;
        };

        // BinkGetSummary(HBINK bink, BINKSUMMARY* summary) — fill from session data
        // BINKSUMMARY layout (40 bytes):
        //   +0x00  Width          +0x04  Height
        //   +0x08  TotalTime(ms)  +0x0C  FileFrameRate
        //   +0x10  FileFrameRateDiv +0x14  FrameRate
        //   +0x18  FrameRateDiv   +0x1C  TotalOpenedFrames
        //   +0x20  TotalFrames    +0x24  TotalPlayedFrames
        //   +0x28  SkippedFrames  +0x2C  ...padding...
        this.exports["_BinkGetSummary@8"] = (_ctx, mem, args) => {
            const bink    = args[0];
            const sumPtr  = args[1];
            console.log(`[BINK] BinkGetSummary(bink=0x${bink.toString(16)}, out=0x${sumPtr.toString(16)})`);
            if (!sumPtr) return 0;
            // Zero the struct first
            mem.fill(0, sumPtr, sumPtr + 80);
            const s = this.sessions.get(bink);
            if (s) {
                const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const fps = Math.round(s.fps) || 15;  // never 0 — games divide by this
                const totalTimeMs = s.frameCount > 0 ? Math.round((s.frameCount / fps) * 1000) : 0;
                v.setUint32(sumPtr + 0x00, s.width, true);
                v.setUint32(sumPtr + 0x04, s.height, true);
                v.setUint32(sumPtr + 0x08, totalTimeMs, true);
                v.setUint32(sumPtr + 0x0C, fps, true);            // FileFrameRate
                v.setUint32(sumPtr + 0x10, 1, true);              // FileFrameRateDiv
                v.setUint32(sumPtr + 0x14, fps, true);            // FrameRate (game DIVs by this)
                v.setUint32(sumPtr + 0x18, 1, true);              // FrameRateDiv
                v.setUint32(sumPtr + 0x20, s.frameCount, true);   // TotalFrames
            }
            return 0;
        };

        // BinkGetRects(HBINK bink, DWORD flags) → number of dirty rects
        // Return 1 = "whole frame is dirty" so the game proceeds to copy.
        // The game may read rect data from the HBINK struct; we don't fill
        // that in, but most games just check (numRects > 0) then call
        // BinkCopyToBuffer for the full frame.
        this.exports["_BinkGetRects@8"] = (_ctx, _mem, args) => {
            const bink = args[0];
            const s = this.sessions.get(bink);
            if (!s || s.eof || !s.videoOn) {
                if (s) this.clearBinkDirtyRects(bink);
                return 0;
            }
            return 1;
        };

        // BinkSetSoundTrack — no-op
        this.exports["_BinkSetSoundTrack@8"] = (_ctx, _mem, args) => {
            console.log(`[BINK] BinkSetSoundTrack(tracks=${args[0]}, ids=0x${args[1].toString(16)})`);
            return 0;
        };

        // BinkSetVolume — no-op. Two ABI generations ship under this name: pre-1.9
        // BinkSetVolume(HBINK, S32 volume) and 1.9+ BinkSetVolume(HBINK, U32 trackid,
        // S32 volume). Both must be DECLARED: with only one, the registry's
        // single-variant base-name fallback sizes the other from it, and the stub's
        // RET N then differs from what the caller pushed. A 4-byte ESP drift moves every
        // local in the caller's frame, so the fault lands far away with nothing pointing
        // back here (Gothic's Bink intro: a stack-local zFILE read as a NULL vtable).
        this.exports["_BinkSetVolume@12"] = (_ctx, _mem, args) => {
            console.log(`[BINK] BinkSetVolume(bink=0x${args[0].toString(16)}, track=${args[1]}, vol=${args[2]})`);
            return 0;
        };
        // Same handler shape as @12: the `@8` decoration is stale, the caller passes
        // (handle, trackid, volume) — see the descriptor note in binkw32.api.ts.
        this.exports["_BinkSetVolume@8"] = (_ctx, _mem, args) => {
            Logger.verbose(LogCategory.SYSTEM,
                `[BINK] BinkSetVolume(bink=0x${args[0].toString(16)}, track=${args[1]}, vol=${args[2]})`);
            return 0;
        };

        // BinkSetPan — no-op
        this.exports["_BinkSetPan@12"] = (_ctx, _mem, args) => {
            console.log(`[BINK] BinkSetPan(bink=0x${args[0].toString(16)}, track=${args[1]}, pan=${args[2]})`);
            return 0;
        };

        // BinkPause — track pause state
        this.exports["_BinkPause@8"] = (_ctx, _mem, args) => {
            const bink = args[0];
            const pause = args[1];
            const s = this.sessions.get(bink);
            if (s) s.paused = !!pause;
            console.log(`[BINK] BinkPause(bink=0x${bink.toString(16)}, pause=${pause})`);
            return 0;
        };

        // BinkSetSoundOnOff — no-op
        this.exports["_BinkSetSoundOnOff@8"] = (_ctx, _mem, args) => {
            console.log(`[BINK] BinkSetSoundOnOff(bink=0x${args[0].toString(16)}, on=${args[1]})`);
            return 0;
        };

        // BinkSetVideoOnOff(HBINK bink, int onoff) → previous onoff value
        // Mutes only the video presentation path (dirty rects, CopyToBuffer,
        // videoRouting).  Decoding and audio/timing continue so sync stays intact.
        // Returns the previous state so callers can save/restore it.
        this.exports["_BinkSetVideoOnOff@8"] = (_ctx, _mem, args) => {
            const bink = args[0];
            const on   = args[1] !== 0;
            const s    = this.sessions.get(bink);

            if (!s) {
                Logger.warn(LogCategory.SYSTEM, `[BinkW32] BinkSetVideoOnOff(bink=0x${bink.toString(16)}, on=${args[1]}) — unknown handle`);
                return 0;
            }

            const previous = s.videoOn ? 1 : 0;
            s.videoOn = on;
            this.writeBinkCompatState(bink, s);

            if (!on) {
                // Clear dirty rects immediately so the game sees nothing to blit.
                this.clearBinkDirtyRects(bink);
            }

            Logger.verbose(LogCategory.SYSTEM, `[BinkW32] BinkSetVideoOnOff(bink=0x${bink.toString(16)}, on=${on ? 1 : 0}) prev=${previous}`);
            return previous;
        };

        // BinkSetIOSize(int iosize) — global read-ahead buffer size hint.
        // Native Bink uses this to size its streaming ring buffer before open.
        // We store it as a pending value; BinkOpen picks it up into the session.
        this.exports["_BinkSetIOSize@4"] = (_ctx, _mem, args) => {
            this.pendingIoSize = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `[BinkW32] BinkSetIOSize(${this.pendingIoSize})`);
            return 0;
        };

        // BinkSetMemory — no-op (we use our own allocator)
        this.exports["_BinkSetMemory@8"] = (_ctx, _mem, args) => {
            console.log(`[BINK] BinkSetMemory(alloc=0x${args[0].toString(16)}, free=0x${args[1].toString(16)})`);
            return 0;
        };

        // в”Ђв”Ђ BinkOpen(const char* name, DWORD flags) → HBINK в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_BinkOpen@8"] = async (_ctx, mem, args) => {
            const namePtr = args[0];
            const flags   = args[1];

            // skipVideo: return 0 (stub) to skip video playback entirely
            if (EmulatorConfig.getInstance().skipVideo) {
                console.log(`[BINK] BinkOpen: SKIPPED (skipVideo=true)`);
                return 0;
            }

            await this.ensureLayout();

            // BINKFILEHANDLE: arg0 is a Win32 HANDLE, not a string pointer. It is ONE bit —
            // 0x08000000 is its NEIGHBOUR, BINKNOTHREADEDIO, which says nothing about arg0
            // and which titles pass with an ordinary filename (the rest of the block, in
            // ascending order: BINKIOSIZE 0x01000000, BINKIOPROCESSOR 0x02000000,
            // BINKFROMMEMORY 0x04000000). Reading a filename pointer as a handle fails the
            // open, and a game that never checks HBINK dereferences NULL a frame later.
            const isFileHandle = !!(flags & 0x00800000);

            let bytes: Uint8Array | null = null;
            let label: string;

            if (isFileHandle) {
                console.log(`[BINK] BinkOpen(HANDLE=0x${namePtr.toString(16)}, flags=0x${flags.toString(16)}) ← BINKFILEHANDLE`);
                // Resolve Win32 file handle → read Bink stream at current position
                const sys = System.getInstance();
                const wrapper = sys.resourceProvider.getFileHandle(namePtr);
                if (!wrapper || !wrapper.vfsHandle) {
                    Logger.warn(LogCategory.SYSTEM,
                        `BinkOpen: HANDLE 0x${namePtr.toString(16)} not found in resource table`);
                    return 0;
                }
                const filePath = wrapper.vfsHandle.path;
                const startPos = wrapper.position;
                label = `HANDLE=0x${namePtr.toString(16)} (${filePath}@${startPos})`;

                // Open a FRESH VFS handle to avoid shared buffer/prefetch state issues
                // with the game's handle. The game seeked to the Bink offset; we read from there.
                const vfs = sys.fileSystem;
                const GENERIC_READ = 0x80000000;
                const OPEN_EXISTING = 3;
                const tempHandle = await vfs.open(filePath, GENERIC_READ, OPEN_EXISTING);
                if (!tempHandle) {
                    Logger.warn(LogCategory.SYSTEM, `BinkOpen(${label}): failed to open fresh handle`);
                    return 0;
                }

                // Seek to the Bink stream position and read the 8-byte header
                vfs.setPosition(tempHandle, startPos, 0);
                const header = await vfs.read(tempHandle, 8);
                if (header.length < 8) {
                    Logger.warn(LogCategory.SYSTEM, `BinkOpen(${label}): couldn't read 8-byte header`);
                    return 0;
                }
                const sig = String.fromCharCode(header[0], header[1], header[2]);
                if (sig !== "BIK") {
                    Logger.warn(LogCategory.SYSTEM,
                        `BinkOpen(${label}): bad signature "${sig}" at offset ${startPos}`);
                    return 0;
                }
                const dataSize = header[4] | (header[5] << 8) | (header[6] << 16) | ((header[7] << 24) >>> 0);
                const totalSize = dataSize + 8;
                Logger.log(LogCategory.SYSTEM,
                    `BinkOpen(${label}): sig=${sig}${String.fromCharCode(header[3])} dataSize=${dataSize} totalSize=${totalSize}`);

                // Read the remaining bytes
                console.log(`[BINK] BinkOpen: header OK, reading remaining ${totalSize - 8} bytes...`);
                bytes = new Uint8Array(totalSize);
                bytes.set(header, 0);
                const remaining = await vfs.read(tempHandle, totalSize - 8);
                console.log(`[BINK] BinkOpen: read returned ${remaining?.length ?? 'null'} bytes`);
                if (!remaining || remaining.length === 0) {
                    Logger.warn(LogCategory.SYSTEM,
                        `BinkOpen(${label}): read stalled at 8/${totalSize} bytes`);
                    return 0;
                }
                bytes.set(remaining, 8);

                // Advance the game's handle past the Bink data (real Bink library does this)
                wrapper.seek(startPos + totalSize);
            } else {
                const namePreview = namePtr ? this.readCString(mem, namePtr) : "(null)";
                console.log(`[BINK] BinkOpen("${namePreview}", flags=0x${flags.toString(16)})`);
                if (!namePtr) return 0;
                const rawName = this.readCString(mem, namePtr);
                label = `"${rawName}"`;

                if (!rawName) {
                    Logger.warn(LogCategory.SYSTEM, `BinkOpen: empty filename`);
                    return 0;
                }

                Logger.log(LogCategory.SYSTEM,
                    `BinkOpen("${rawName}", flags=0x${flags.toString(16)}) …`);
                bytes = await this.readVfsFile(rawName);
                if (!bytes) {
                    Logger.warn(LogCategory.SYSTEM,
                        `BinkOpen("${rawName}"): file not found, skipping video`);
                    return 0;
                }
            }

            try {
                const binkTag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
                Logger.log(LogCategory.SYSTEM,
                    `BinkOpen(${label}): variant="${binkTag}", size=${bytes.length}`);

                const engineHandle = await videoEngine.open(bytes);

                const info = videoEngine.getInfo(engineHandle);
                if (!info) { videoEngine.close(engineHandle); return 0; }

                /* Allocate guest BinkHandle struct */
                const L = this.layout;
                const guestPtr = process.memory.alloc(BINK_HANDLE_SIZE);
                const m = this.getMemory();
                m.fill(0, guestPtr, guestPtr + BINK_HANDLE_SIZE);
                this.writeU32(m, guestPtr + L.width, info.width);
                this.writeU32(m, guestPtr + L.height, info.height);
                if (L.widthAlt !== null) this.writeU32(m, guestPtr + L.widthAlt, info.width);
                if (L.heightAlt !== null) this.writeU32(m, guestPtr + L.heightAlt, info.height);
                this.writeU32(m, guestPtr + L.frames, info.frameCount);
                this.writeU32(m, guestPtr + L.frameNum, info.currentFrame);
                if (L.lastFrameNum !== null) this.writeU32(m, guestPtr + L.lastFrameNum, info.currentFrame);
                this.writeU32(m, guestPtr + L.frameRate, Math.round(info.fps));
                this.writeU32(m, guestPtr + L.frameRateDiv, 1);
                this.writeU32(m, guestPtr + L.size, bytes.length);

                const session: BinkSession = {
                    guestPtr, engineHandle,
                    width:  info.width, height: info.height,
                    frameCount: info.frameCount, fps: info.fps,
                    lastFrameMs: 0, paused: false, loggedCopy: false, eof: false,
                    audioCtrl: null, lastPlayCursor: 0,
                    audioWrapCount: 0, audioBaselineMs: -1,
                    frameDecodeCount: 0,
                    destPtr: 0,
                    destPitch: 0,
                    destHeight: 0,
                    destX: 0,
                    destY: 0,
                    destBpp: 0,
                    explicitDdrawSurface: null,
                    explicitGlideSurfacePtr: 0,
                    d3d9LockTarget: null,
                    lastCopyAtMs: 0,
                    hasBufferApiHint: false,
                    hasPointerFault: false,
                    videoOn: true,
                    ioSize:  this.pendingIoSize,
                };

                // Wire up audio SAB for sync pacing
                const sab = videoEngine.getAudioSab(engineHandle);
                if (sab) {
                    session.audioSab = sab;
                    session.audioCtrl = new Int32Array(sab, 0, 32);
                }

                this.sessions.set(guestPtr, session);
                System.getInstance().videoRouting.openSession({
                    codec: "bink",
                    guestHandle: guestPtr,
                    width: info.width,
                    height: info.height,
                    fps: info.fps,
                });
                console.log(`[BINK] BinkOpen → 0x${guestPtr.toString(16)} ${info.width}×${info.height} ${info.fps.toFixed(1)}fps ${info.frameCount}f audio=${!!sab}`);

                Logger.log(LogCategory.SYSTEM,
                    `BinkOpen(${label}) → 0x${guestPtr.toString(16)} ` +
                    `(${info.width}×${info.height} ${info.fps.toFixed(2)}fps ${info.frameCount}f)`);
                return guestPtr;

            } catch (e) {
                console.error(`[BINK] BinkOpen(${label}) error:`, e);
                Logger.error(LogCategory.SYSTEM, `BinkOpen(${label}) error: ${e}`);
                return 0;
            }
        };

        // в”Ђв”Ђ BinkDoFrame(HBINK) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        // Always SYNC — pacing is handled by BinkWait (above).  DoFrame only
        // decodes the current frame.  Keeping this sync is critical: an async
        // thunk costs ~70ms spin-loop overhead per call even for immediate
        // return, and a busy-wait here blocked DDraw Blt from presenting
        // (66ms JS thread stall → only 58/2427 frames reached the screen).
        this.exports["_BinkDoFrame@4"] = (_ctx, _mem, args) => {
            const bink = args[0];
            const s = this.sessions.get(bink);
            if (!s) return 0;
            this._logApi(bink, "DoFrame", `paused=${s.paused} eof=${s.eof}`);

            if (s.paused || s.eof) return 0;

            this._decodeFrame(s, bink);
            if (!s.eof && s.videoOn) {
                System.getInstance().videoRouting.onFrameDecoded({
                    codec: "bink",
                    guestHandle: bink,
                    frame: this.buildFrameViews(s),
                    hasAppManagedSink: this.hasAppManagedSink(s),
                    targetHint: this.getRoutingTargetHint(s),
                    legacyPrimarySink: null,
                    explicitDdrawSink: s.explicitDdrawSurface ? () => this.submitExplicitDdrawSink(s) : null,
                    explicitGlideSink: null,
                });
            }
            return 0;
        };

        // в”Ђв”Ђ BinkCopyToBuffer(HBINK, void* buf, pitch, h, x, y, flags) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_BinkCopyToBuffer@28"] = (_ctx, _mem, args) => {
            const bink    = args[0];
            const destPtr = args[1];
            const pitch   = args[2];
            const destH   = args[3];
            const destX   = args[4];
            const destY   = args[5];
            const rawFlags = args[6];

            const s = this.sessions.get(bink);
            if (!s || !destPtr) return 0;
            this._logApi(bink, "CopyToBuffer", `dest=0x${destPtr.toString(16)} pitch=${pitch}`);

            const { surf, destBpp, copyWidth, rows, destSurface } = this.getCopyGeometry(
                s, destPtr, pitch, destH, destX, destY, this.lastSurfaceBpp, rawFlags,
            );
            if (!s.loggedCopy) {
                s.loggedCopy = true;
                Logger.log(LogCategory.SYSTEM, `[BINK] BinkCopyToBuffer: bink=0x${bink.toString(16)} dest=0x${destPtr.toString(16)} ` +
                    `pitch=${pitch} destH=${destH} destX=${destX} destY=${destY} flags=0x${rawFlags.toString(16)} ` +
                    `video=${s.width}x${s.height} copy=${copyWidth}x${rows} surf=${surf} destBpp=${destBpp} ` +
                    `storedBpp=${this.lastSurfaceBpp} d3d8=${destSurface ? `${destSurface.width}x${destSurface.height}` : "no"}`);
            }

            s.destPtr = destPtr;
            s.destPitch = pitch;
            s.destHeight = destH;
            s.destX = destX;
            s.destY = destY;
            s.destBpp = destBpp;
            s.lastCopyAtMs = performance.now();
            s.hasBufferApiHint = true;
            s.hasPointerFault = false;
            this.updateExplicitSinkHints(s, destPtr);

            if (rows <= 0 || copyWidth <= 0) return 0;
            const markPointerFault = () => {
                if (!s.hasPointerFault) {
                    s.hasPointerFault = true;
                    Logger.warn(
                        LogCategory.SYSTEM,
                        `[BinkW32] invalid target span in BinkCopyToBuffer bink=0x${bink.toString(16)} ptr=0x${destPtr.toString(16)} bpp=${destBpp}`
                    );
                }
                s.destPtr = 0;
                s.hasBufferApiHint = false;
                s.explicitDdrawSurface = null;
                s.explicitGlideSurfacePtr = 0;
            };

            // 8bpp: use PAL8 indices directly if available
            if (surf === BinkSurface.P8) {
                const pal8 = videoEngine.getFramePal8(s.engineHandle);
                if (pal8) {
                    for (let row = 0; row < rows; row++) {
                        const srcOff = row * s.width;
                        const dstOff = destPtr + (destY + row) * pitch + destX;
                        const rowData = pal8.indices.subarray(srcOff, srcOff + copyWidth);
                        if (!this.writeBytesChecked(dstOff, rowData)) {
                            markPointerFault();
                            return 0;
                        }
                    }
                    if (destSurface) destSurface.gpuNeedsUpload = true;
                    return 0;
                }
                // Fallback: BGRA → luminance
                const bgra = videoEngine.getFrameBgra(s.engineHandle);
                if (!bgra) return 0;
                const rowScratch = new Uint8Array(copyWidth);
                for (let row = 0; row < rows; row++) {
                    for (let x = 0; x < copyWidth; x++) {
                        const si = (row * s.width + x) * 4;
                        rowScratch[x] = (bgra[si + 2] * 77 + bgra[si + 1] * 150 + bgra[si] * 29) >> 8;
                    }
                    const dstOff = destPtr + (destY + row) * pitch + destX;
                    if (!this.writeBytesChecked(dstOff, rowScratch)) {
                        markPointerFault();
                        return 0;
                    }
                }
                if (destSurface) destSurface.gpuNeedsUpload = true;
                return 0;
            }

            // RGB565 only: the WASM-side packer emits exactly that layout (memcpy per row,
            // ~8-15x faster). Every other 16bpp BINKSURFACE goes through pack16.
            if (surf === BinkSurface.RGB565) {
                const rgb565 = videoEngine.getFrameRgb565(s.engineHandle);
                if (rgb565) {
                    const srcPitch = s.width * 2;
                    for (let row = 0; row < rows; row++) {
                        const srcOff = row * srcPitch;
                        const dstOff = destPtr + (destY + row) * pitch + destX * 2;
                        const rowData = rgb565.subarray(srcOff, srcOff + copyWidth * 2);
                        if (!this.writeBytesChecked(dstOff, rowData)) {
                            markPointerFault();
                            return 0;
                        }
                    }
                    if (destSurface) destSurface.gpuNeedsUpload = true;
                    return 0;
                }
                // Fallthrough: use JS-side typed array conversion (Tier 1)
            }

            const bgra = videoEngine.getFrameBgra(s.engineHandle);
            if (!bgra) return 0;

            const srcPitch = s.width * 4;
            const rowScratch = new Uint8Array(copyWidth * destBpp);
            for (let row = 0; row < rows; row++) {
                const srcOff = row * srcPitch;
                const dstOff = destPtr + (destY + row) * pitch + destX * destBpp;
                copyDecodedRow(bgra, srcOff, rowScratch, 0, copyWidth, surf);
                if (!this.writeBytesChecked(dstOff, rowScratch)) {
                    markPointerFault();
                    return 0;
                }
            }
            if (destSurface) destSurface.gpuNeedsUpload = true;
            return 0;
        };

        // в”Ђв”Ђ BinkCopyToBufferRect(HBINK, buf, pitch, h, x, y, l, t, w, h2, flags) в”Ђв”Ђ
        this.exports["_BinkCopyToBufferRect@44"] = (_ctx, _mem, args) => {
            const bink    = args[0];
            const destPtr = args[1];
            const pitch   = args[2];
            const destH   = args[3];
            const destX   = args[4];
            const destY   = args[5];
            const srcL    = args[6];
            const srcT    = args[7];
            const srcW    = args[8];
            const srcH2   = args[9];
            const rawFlags = args[10];

            const s = this.sessions.get(bink);
            if (!s || !destPtr) return 0;
            this._logApi(bink, "CopyToBufferRect", `dest=0x${destPtr.toString(16)} pitch=${pitch}`);

            const clipH = Math.min(srcH2, destH - destY, s.height - srcT);
            const clipW = Math.min(srcW, s.width - srcL);
            if (clipH <= 0 || clipW <= 0) return 0;

            const declared = binkSurfaceFromFlags(rawFlags);
            const destSurface = this.resolveBitmapTextureTarget(destPtr);
            // The heuristic needs the DESTINATION row width; clipW is the source rect's.
            const surf = declared !== -1
                ? declared
                : binkSurfaceFromBpp(
                    this.lastSurfaceBpp
                    || detectDestBpp(pitch, inferDestRowPixels(pitch, this.lastSurfaceBpp, destSurface) || s.width));
            const destBpp = binkSurfaceBpp(surf);
            if (!s.loggedCopy) {
                s.loggedCopy = true;
                Logger.log(LogCategory.SYSTEM, `[BINK] BinkCopyToBufferRect: bink=0x${bink.toString(16)} dest=0x${destPtr.toString(16)} ` +
                    `pitch=${pitch} destH=${destH} destX=${destX} destY=${destY} flags=0x${rawFlags.toString(16)} ` +
                    `video=${s.width}x${s.height} copy=${clipW}x${clipH} surf=${surf} destBpp=${destBpp} ` +
                    `storedBpp=${this.lastSurfaceBpp} d3d8=${destSurface ? `${destSurface.width}x${destSurface.height}` : "no"}`);
            }
            s.destPtr = destPtr;
            s.destPitch = pitch;
            s.destHeight = destH;
            s.destX = destX;
            s.destY = destY;
            s.destBpp = destBpp;
            s.lastCopyAtMs = performance.now();
            s.hasBufferApiHint = true;
            s.hasPointerFault = false;
            this.updateExplicitSinkHints(s, destPtr);
            const markPointerFault = () => {
                if (!s.hasPointerFault) {
                    s.hasPointerFault = true;
                    Logger.warn(
                        LogCategory.SYSTEM,
                        `[BinkW32] invalid target span in BinkCopyToBufferRect bink=0x${bink.toString(16)} ptr=0x${destPtr.toString(16)} bpp=${destBpp}`
                    );
                }
                s.destPtr = 0;
                s.hasBufferApiHint = false;
                s.explicitDdrawSurface = null;
                s.explicitGlideSurfacePtr = 0;
            };

            // RGB565 only — see BinkCopyToBuffer.
            if (surf === BinkSurface.RGB565) {
                const rgb565 = videoEngine.getFrameRgb565(s.engineHandle);
                if (rgb565) {
                    const fullSrcPitch = s.width * 2;
                    for (let row = 0; row < clipH; row++) {
                        const srcOff = (srcT + row) * fullSrcPitch + srcL * 2;
                        const dstOff = destPtr + (destY + row) * pitch + destX * 2;
                        const rowData = rgb565.subarray(srcOff, srcOff + clipW * 2);
                        if (!this.writeBytesChecked(dstOff, rowData)) {
                            markPointerFault();
                            return 0;
                        }
                    }
                    return 0;
                }
            }

            const bgra = videoEngine.getFrameBgra(s.engineHandle);
            if (!bgra) return 0;

            const fullSrcPitch = s.width * 4;
            const rowScratch = new Uint8Array(clipW * destBpp);
            for (let row = 0; row < clipH; row++) {
                const srcOff = (srcT + row) * fullSrcPitch + srcL * 4;
                const dstOff = destPtr + (destY + row) * pitch + destX * destBpp;
                copyDecodedRow(bgra, srcOff, rowScratch, 0, clipW, surf);
                if (!this.writeBytesChecked(dstOff, rowScratch)) {
                    markPointerFault();
                    return 0;
                }
            }
            return 0;
        };

        // в”Ђв”Ђ BinkNextFrame(HBINK) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_BinkNextFrame@4"] = (_ctx, _mem, args) => {
            const bink = args[0];
            const s = this.sessions.get(bink);
            if (!s) return 0;
            this._logApi(bink, "NextFrame");
            if (!s.paused && !s.eof) {
                System.getInstance().videoRouting.onFrameFinalize({
                    codec: "bink",
                    guestHandle: bink,
                    hasAppManagedSink: this.hasAppManagedSink(s),
                    targetHint: this.getRoutingTargetHint(s),
                    legacyPrimarySink: null,
                    explicitDdrawSink: s.explicitDdrawSurface ? () => this.submitExplicitDdrawSink(s) : null,
                    explicitGlideSink: null,
                });
            }
            const m0 = this.getMemory();
            const prevFrame = this.readU32(m0, bink + this.layout.frameNum);
            videoEngine.nextFrame(s.engineHandle);
            /* Update FrameNum / LastFrameNum in guest struct */
            const info = videoEngine.getInfo(s.engineHandle);
            if (info) {
                const m = this.getMemory();
                this.writeU32(m, bink + this.layout.frameNum, info.currentFrame);
                if (this.layout.lastFrameNum !== null) {
                    this.writeU32(m, bink + this.layout.lastFrameNum, prevFrame);
                }
            }
            return 0;
        };

        // в”Ђв”Ђ BinkWait(HBINK) → 0 = ready, 1 = not ready в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        // MUST be sync — games poll BinkWait in their own event loop:
        //   while (bink_open) { pump_messages(); if (!BinkWait(h)) { DoFrame(); CopyToBuffer(); render(); } }
        // HoMM3 decompilation (FUN_0044dd20) confirms: BinkWait is called inside
        // FUN_0044daa0, result stored in DAT_00694ce0, then the OUTER loop calls
        // FUN_005979d0 (DDraw Unlock→Blt→Lock) only when DAT_00694ce0==1.
        // An async BinkWait would block FUN_0044daa0, preventing the outer loop
        // from ever reaching the DDraw render call.
        this.exports["_BinkWait@4"] = (ctx, mem, args) => {
            const bink = args[0];
            const s = this.sessions.get(bink);
            if (!s || s.paused || s.eof) return 0;

            // First frame or unknown fps — ready immediately
            if (s.lastFrameMs <= 0 || s.fps <= 0) return 0;

            const msPerFrame = 1000 / s.fps;

            // Audio-synced pacing (preferred): pace frames to the audio clock via
            // a fixed-timestep target (baseline + frameCount*msPerFrame) instead of
            // re-anchoring to now() each frame, so decode time doesn't leak in and
            // video stays locked to audio over long clips. The 3x-wall-clock safety
            // valve forces ready if the audio clock stalls/lags — this is the guard
            // the earlier wall-clock-only version lacked (which is why a naive
            // audio-sync attempt could throttle to ~5fps permanently).
            if (s.audioBaselineMs >= 0 && s.audioCtrl) {
                const targetAudioMs = s.audioBaselineMs + s.frameDecodeCount * msPerFrame;
                const audioMs = this._getAudioTimeMs(s);
                if (audioMs >= 0 && audioMs < targetAudioMs) {
                    const wallElapsed = performance.now() - s.lastFrameMs;
                    if (wallElapsed < msPerFrame * 3) {
                        const audioRemaining = targetAudioMs - audioMs;
                        const safetyRemaining = msPerFrame * 3 - wallElapsed;
                        return this.markVideoWaitNotReady(ctx, mem, Math.min(audioRemaining, safetyRemaining));
                    }
                }
                return 0; // ready
            }

            // Fallback: wall-clock pacing (no active audio to sync against).
            const elapsed = performance.now() - s.lastFrameMs;
            if (elapsed < msPerFrame - 2) {
                return this.markVideoWaitNotReady(ctx, mem, msPerFrame - 2 - elapsed);
            }
            return 0; // ready
        };

        // в”Ђв”Ђ BinkGoto(HBINK, frame, flags) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_BinkGoto@12"] = (_ctx, _mem, args) => {
            const bink  = args[0];
            const frame = args[1];
            const s = this.sessions.get(bink);
            if (!s) return 0;
            videoEngine.gotoFrame(s.engineHandle, frame);
            s.eof = false; // seeking resets EOF state
            const m = this.getMemory();
            this.writeU32(m, bink + this.layout.frameNum, frame);
            return 0;
        };

        // в”Ђв”Ђ BinkClose(HBINK) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_BinkClose@4"] = (_ctx, _mem, args) => {
            const bink = args[0];
            this._logApi(bink, "Close");
            const s = this.sessions.get(bink);
            if (!s) {
                Logger.verbose(LogCategory.SYSTEM, `BinkClose(0x${bink.toString(16)}): unknown handle`);
                return 0;
            }
            videoEngine.close(s.engineHandle);
            (self as any).postMessage({ type: 'video_end' });
            System.getInstance().videoRouting.closeSession("bink", bink);
            process.memory.free(s.guestPtr);
            this.sessions.delete(bink);
            this.apiCallLog.delete(bink);
            Logger.log(LogCategory.SYSTEM, `BinkClose(0x${bink.toString(16)}): closed`);
            return 0;
        };

        // в”Ђв”Ђ Buffer API (minimal compatibility + routing hints) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        this.exports["_BinkBufferOpen@16"]   = (_ctx, _mem, args) => {
            const handle = this.nextBufferHandle++;
            const session: BinkBufferSession = {
                handle,
                hwnd: args[0],
                width: args[1],
                height: args[2],
                flags: args[3],
                locked: false,
                lastBlitAtMs: 0,
            };
            this.binkBuffers.set(handle, session);
            Logger.log(
                LogCategory.SYSTEM,
                `BinkBufferOpen(hwnd=0x${args[0].toString(16)}, w=${args[1]}, h=${args[2]}, flags=0x${args[3].toString(16)}) -> 0x${handle.toString(16)}`
            );
            return handle;
        };
        this.exports["_BinkBufferClose@4"]   = (_ctx, _mem, args) => {
            const handle = args[0];
            this.binkBuffers.delete(handle);
            Logger.verbose(LogCategory.SYSTEM, `BinkBufferClose(0x${handle.toString(16)})`);
            return 1;
        };
        this.exports["_BinkBufferBlit@16"]   = (_ctx, _mem, args) => {
            const handle = args[0];
            const buf = this.binkBuffers.get(handle);
            if (buf) {
                buf.lastBlitAtMs = performance.now();
                for (const session of this.sessions.values()) {
                    session.hasBufferApiHint = true;
                }
            }
            Logger.verbose(LogCategory.SYSTEM, `BinkBufferBlit(0x${handle.toString(16)})`);
            return 1;
        };
        this.exports["_BinkBufferLock@4"]    = (_ctx, _mem, args) => {
            const handle = args[0];
            const buf = this.binkBuffers.get(handle);
            if (buf) {
                buf.locked = true;
                for (const session of this.sessions.values()) {
                    session.hasBufferApiHint = true;
                }
            }
            Logger.verbose(LogCategory.SYSTEM, `BinkBufferLock(0x${handle.toString(16)})`);
            return 1;
        };
        this.exports["_BinkBufferUnlock@4"]  = (_ctx, _mem, args) => {
            const handle = args[0];
            const buf = this.binkBuffers.get(handle);
            if (buf) {
                buf.locked = false;
            }
            Logger.verbose(LogCategory.SYSTEM, `BinkBufferUnlock(0x${handle.toString(16)})`);
            return 1;
        };

        // в”Ђв”Ђ BinkDDSurfaceType(IDirectDrawSurface*) → Bink surface type в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
        // The return value's meaning depends on the Bink SDK version the game was
        // built with (constants differ!).  We don't know which version, so we
        // return 0 (the game stores and passes it back to BinkCopyToBuffer).
        // The REAL work: store the surface bpp so BinkCopyToBuffer can use it
        // for format conversion, independent of the opaque constant.
        this.exports["_BinkDDSurfaceType@4"] = (_ctx, _mem, args) => {
            const surfAddr = args[0];
            const sys = System.getInstance();

            const d3d8Surface = resolveD3D8TextureSurface(surfAddr);
            if (d3d8Surface) {
                this.lastSurfaceBpp = Math.ceil(d3d8Surface.format.bpp / 8);
                console.log(`[BINK] BinkDDSurfaceType(0x${surfAddr.toString(16)}): ` +
                    `D3D8 ${d3d8Surface.width}x${d3d8Surface.height} bpp=${d3d8Surface.format.bpp} → destBpp=${this.lastSurfaceBpp}`);
                return 0;
            }

            // Try to look up the DDraw surface COM object for its bpp
            const comObj = sys.resourceProvider.getComObjectByAddressFast(surfAddr);
            if (comObj && 'getState' in comObj) {
                const state = (comObj as any).getState();
                if (state?.format) {
                    this.lastSurfaceBpp = Math.ceil(state.format.bpp / 8);
                    console.log(`[BINK] BinkDDSurfaceType(0x${surfAddr.toString(16)}): ` +
                        `bpp=${state.format.bpp} rMask=0x${state.format.rMask.toString(16)} → stored destBpp=${this.lastSurfaceBpp}`);
                    return 0;
                }
            }

            // Fallback: use display bpp from DDraw context
            const ctx = sys.ddrawContext;
            if (ctx) {
                this.lastSurfaceBpp = Math.ceil(ctx.display.bpp / 8);
                console.log(`[BINK] BinkDDSurfaceType(0x${surfAddr.toString(16)}): ` +
                    `fallback display.bpp=${ctx.display.bpp} → stored destBpp=${this.lastSurfaceBpp}`);
                return 0;
            }

            console.log(`[BINK] BinkDDSurfaceType(0x${surfAddr.toString(16)}): no DDraw context, assuming 32bpp`);
            this.lastSurfaceBpp = 4;
            return 0;
        };
        this.exports["_BinkGetError@0"]      = (_ctx, _mem, _args) => { console.log(`[BINK] BinkGetError() → null`); return 0; };
        this.exports["_BinkLogoAddress@0"]   = (_ctx, _mem, _args) => 0;
    }

    reset(): void {
        // Engines already closed by System.reset → videoEngine.closeAll().
        this.sessions.clear();
        this.binkBuffers.clear();
        this.apiCallLog.clear();
        this.lastSurfaceBpp = 0;
        this.layout = BINK_LAYOUT_DEFAULT;
        this.layoutResolved = false;
        this.nextBufferHandle = 0x7800;
        this.pendingIoSize = 0;
    }
}
