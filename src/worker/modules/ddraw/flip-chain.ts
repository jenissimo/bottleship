/**
 * Flip-chain rotation — the faithful DirectDraw Flip.
 *
 * Flip does not copy pixels. It renames the surface STORAGE around the chain: the
 * guest's interface pointers keep addressing the same surfaces while the memory and
 * GPU texture behind them rotate by one position. A 2-surface chain is therefore back
 * where it started after two Flips, and every buffer still holds the frame it last
 * displayed — which is precisely what dirty-rectangle renderers depend on when they
 * redraw only the regions that changed and leave the rest to the previous content of
 * that buffer.
 *
 * Copying back→front instead collapses the chain onto a single image: every region the
 * guest does not redraw this frame is whatever the one surviving buffer happens to
 * hold, so a full-surface clear followed by partial redraws erases the rest of the
 * frame permanently.
 */

import type { DirectDrawSurfaceState } from "./com-objects";
import { isRenderSurface } from "./com-objects";
import type { DirectDrawSurfaceObject } from "./com-objects";
import type { Rect } from "./helpers";
import { Logger, LogCategory } from "../../core/logger";

/** Everything that belongs to the PIXELS rather than to the surface identity.
 *  Identity (caps, dimensions, pixel format, attachment links, Lock leases, colour
 *  keys, palette/clipper handles, private data) stays with the surface; storage
 *  travels with the image. */
interface SurfaceStorage {
    surfacePtr: number;
    surfacePtrAllocated?: boolean;
    vidMemSize?: number;
    gpuTexture?: GPUTexture;
    gpuTextureView?: GPUTextureView;
    gpuTextureFormat?: GPUTextureFormat;
    gpuMipLevels?: number;
    gpuTextureRGB565?: GPUTexture;
    gpuTextureRGB565View?: GPUTextureView;
    rgbaPaddedScratch?: Uint8Array;
    surfaceEverWritten?: boolean;
    writeGeneration: number;
    needsColorClear?: boolean;
    clearColor?: number;
    // RenderSurface content/authority state — describes the image, not the slot.
    mode?: "CPU" | "GPU_ONLY";
    version?: number;
    gpuDirty?: boolean;
    gpuWrittenVersion?: number;
    everLocked?: boolean;
    lastUploadVersion?: number;
    dirtyRegion?: Rect;
    rgbaScratch?: Uint8Array;
    rgbaScratchVersion?: number;
}

function takeStorage(s: DirectDrawSurfaceState): SurfaceStorage {
    const st: SurfaceStorage = {
        surfacePtr: s.surfacePtr,
        surfacePtrAllocated: s.surfacePtrAllocated,
        vidMemSize: s.vidMemSize,
        gpuTexture: s.gpuTexture,
        gpuTextureView: s.gpuTextureView,
        gpuTextureFormat: s.gpuTextureFormat,
        gpuMipLevels: s.gpuMipLevels,
        gpuTextureRGB565: s.gpuTextureRGB565,
        gpuTextureRGB565View: s.gpuTextureRGB565View,
        rgbaPaddedScratch: s.rgbaPaddedScratch,
        surfaceEverWritten: s.surfaceEverWritten,
        writeGeneration: s.writeGeneration,
        needsColorClear: s.needsColorClear,
        clearColor: s.clearColor,
    };
    if (isRenderSurface(s)) {
        st.mode = s.mode;
        st.version = s.version;
        st.gpuDirty = s.gpuDirty;
        st.gpuWrittenVersion = s.gpuWrittenVersion;
        st.everLocked = s.everLocked;
        st.lastUploadVersion = s.lastUploadVersion;
        st.dirtyRegion = s.dirtyRegion;
        st.rgbaScratch = s.rgbaScratch;
        st.rgbaScratchVersion = s.rgbaScratchVersion;
    }
    return st;
}

function putStorage(s: DirectDrawSurfaceState, st: SurfaceStorage): void {
    s.surfacePtr = st.surfacePtr;
    s.surfacePtrAllocated = st.surfacePtrAllocated;
    s.vidMemSize = st.vidMemSize;
    s.gpuTexture = st.gpuTexture;
    s.gpuTextureView = st.gpuTextureView;
    s.gpuTextureFormat = st.gpuTextureFormat;
    s.gpuMipLevels = st.gpuMipLevels;
    s.gpuTextureRGB565 = st.gpuTextureRGB565;
    s.gpuTextureRGB565View = st.gpuTextureRGB565View;
    s.rgbaPaddedScratch = st.rgbaPaddedScratch;
    s.surfaceEverWritten = st.surfaceEverWritten;
    s.writeGeneration = st.writeGeneration;
    s.needsColorClear = st.needsColorClear;
    s.clearColor = st.clearColor;
    if (isRenderSurface(s)) {
        if (st.mode !== undefined) s.mode = st.mode;
        if (st.version !== undefined) s.version = st.version;
        if (st.gpuDirty !== undefined) s.gpuDirty = st.gpuDirty;
        s.gpuWrittenVersion = st.gpuWrittenVersion;
        if (st.everLocked !== undefined) s.everLocked = st.everLocked;
        if (st.lastUploadVersion !== undefined) s.lastUploadVersion = st.lastUploadVersion;
        s.dirtyRegion = st.dirtyRegion;
        s.rgbaScratch = st.rgbaScratch;
        s.rgbaScratchVersion = st.rgbaScratchVersion;
    }
}

/** Walk the attachment ring from `startAddr` back to itself, the way DirectDraw finds
 *  a flip target. Returns the surfaces in chain order (front first), or null when the
 *  links do not close into a ring. */
export function collectFlipChain(
    startAddr: number,
    resolve: (addr: number) => DirectDrawSurfaceObject | null
): { addr: number; state: DirectDrawSurfaceState }[] | null {
    const start = resolve(startAddr);
    if (!start) return null;
    const chain: { addr: number; state: DirectDrawSurfaceState }[] = [{ addr: startAddr >>> 0, state: start.getState() }];
    let addr = chain[0].state.attachedSurfaceAddr >>> 0;
    // A flip chain is at most a handful of surfaces; the bound only guards corrupt links.
    for (let i = 0; addr && i < 16; i++) {
        if (addr === (startAddr >>> 0)) return chain;
        const obj = resolve(addr);
        if (!obj) return null;
        const state = obj.getState();
        chain.push({ addr, state });
        addr = state.attachedSurfaceAddr >>> 0;
    }
    return null;
}

/**
 * Rotate storage one position towards the front over `chain[0..count-1]`, exactly as
 * DirectDraw does: each surface takes its successor's image and the front's image
 * lands on the last surface of the rotated span. For the usual 2-surface chain that
 * is a straight exchange of front and back.
 */
export function rotateFlipChain(states: DirectDrawSurfaceState[], count = states.length): void {
    const n = Math.min(count, states.length);
    if (n < 2) return;
    const front = takeStorage(states[0]);
    for (let i = 0; i < n - 1; i++) {
        putStorage(states[i], takeStorage(states[i + 1]));
    }
    putStorage(states[n - 1], front);
}

/** A flip must not rotate memory out from under a live Lock: the guest still holds the
 *  pointer the lease handed it. Real DirectDraw refuses (DDERR_SURFACEBUSY); we log and
 *  let the flip proceed so a leaked lease cannot freeze the frame loop. */
export function warnOnLockedFlip(states: DirectDrawSurfaceState[]): void {
    for (const s of states) {
        if (s.activeLeaseId !== undefined) {
            Logger.warn(LogCategory.DDRAW,
                `Flip: surface 0x${s.surfacePtr.toString(16)} still has an active Lock lease; ` +
                `rotating storage anyway (guest kept a stale lpSurface across Flip)`);
        }
    }
}
