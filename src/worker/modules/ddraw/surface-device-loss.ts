/**
 * DirectDraw's half of device loss: which surfaces survive one, and what the guest is told.
 *
 * Every GPU handle a surface holds belongs to the device that made it, so on loss they are all
 * dead references. What differs is whether the PIXELS also died:
 *
 *   - `bitmap_texture` owns an authoritative `rgbaScratch`; `mode:"CPU"` render surfaces are
 *     backed by guest memory at `surfacePtr`. Both are system-memory surfaces in DirectDraw's
 *     own terms, and DirectDraw never loses those. We forget the texture, raise the upload
 *     flag, and the next draw re-uploads. IsLost keeps answering DD_OK.
 *   - `mode:"GPU_ONLY"` — a pure 3D render target — had exactly one copy and it was on the
 *     lost device. The contents are GONE. Real hardware behaves the same way: Restore()
 *     reallocates and the contents are undefined. So the surface is reported LOST until the
 *     app restores it, and it comes back cleared (a fresh WebGPU texture is zeroed) instead of
 *     as whatever the allocator had lying around.
 *
 * Surfaces live in more than one registry — the COM object table, d3d8's per-device texture
 * map, the D3DTEXTUREHANDLE registry — and a surface missed by the walk keeps a dead
 * `gpuTexture` that looks perfectly healthy. So holders REGISTER a source here rather than
 * this file trying to know where every surface lives; the mip sublevels hanging off a root
 * are then walked from whichever source yielded the root.
 */

import { System } from "../../core/system";
import { Logger, LogCategory } from "../../core/logger";
import { registerGpuDeviceObserver } from "../../core/gpu/gpu-device-lifecycle";
import { forgetLossTrackedSurface, isSurfaceLost, markSurfaceLost, markSurfaceRestored } from "../../core/gpu/gpu-device-loss-contract";
import { registerSurfaceTeardownHook } from "./surface-teardown";
import { clearGPUTexturePool } from "./gpu-texture-utils";
import { isBitmapTexture, isRenderSurface, type DirectDrawSurfaceState } from "./com-objects";

export interface SurfaceLossTally {
    /** Surfaces whose GPU texture was dropped. */
    invalidated: number;
    /** Surfaces re-uploadable from CPU-side pixels (system memory, in DirectDraw's terms). */
    restorable: number;
    /** GPU_ONLY surfaces whose only copy was the lost texture — contents gone. */
    contentLost: number;
    /** Which sources contributed, and how many surfaces each yielded. A source that silently
     *  yields nothing is the failure mode this exists to make visible. */
    bySource: Record<string, number>;
}

export type SurfaceEntry = { state: DirectDrawSurfaceState };
export type SurfaceSource = () => Iterable<SurfaceEntry>;

const sources = new Map<string, SurfaceSource>();

/**
 * Register a place surfaces live. Called once per holder; re-registering a label replaces it,
 * so a per-device holder can register under a stable label without leaking.
 */
export function registerDDrawSurfaceSource(label: string, source: SurfaceSource): () => void {
    sources.set(label, source);
    return () => { sources.delete(label); };
}

/** Drop one surface's device-derived handles and classify whether its pixels survived. */
function invalidateSurface(state: DirectDrawSurfaceState, tally: SurfaceLossTally, seen: Set<DirectDrawSurfaceState>): void {
    if (seen.has(state)) return;
    seen.add(state);

    const hadTexture = !!state.gpuTexture || !!state.gpuTextureRGB565;
    state.gpuTexture = undefined;
    state.gpuTextureView = undefined;
    state.gpuMipLevels = undefined;
    state.gpuTextureFormat = undefined;
    state.gpuTextureRGB565 = undefined;
    state.gpuTextureRGB565View = undefined;
    // Executor hazard bookkeeping refers to a command buffer that no longer exists.
    state.sampledEncoderEpoch = undefined;
    state.sampledContentVersion = undefined;
    if (hadTexture) tally.invalidated++;

    if (isBitmapTexture(state)) {
        state.gpuNeedsUpload = true;
        tally.restorable++;
    } else if (isRenderSurface(state)) {
        if (state.mode === "GPU_ONLY") {
            // No CPU copy existed. Report it lost; Restore() gives back a cleared surface.
            markSurfaceLost(state);
            tally.contentLost++;
        } else {
            state.gpuDirty = true;
            state.lastUploadVersion = -1;
            state.cpuSyncedVersion = undefined;
            tally.restorable++;
        }
    }

    for (const sub of state.mipSublevels ?? []) {
        invalidateSurface(sub, tally, seen);
    }
}

/** The COM object table — every ddraw/D3D7 surface the guest holds an interface to. */
function* comObjectSurfaces(): Iterable<SurfaceEntry> {
    const provider = System.getInstance().resourceProvider;
    for (const obj of provider.getAllComObjects()) {
        const state = (obj as { getState?: () => unknown }).getState?.() as DirectDrawSurfaceState | undefined;
        if (!state || typeof (state as { surfacePtr?: unknown }).surfacePtr !== "number") continue;
        yield { state };
    }
}

registerDDrawSurfaceSource("com-objects", comObjectSurfaces);

/**
 * Walk every registered source and drop what the lost device owned. Exported so a test can
 * drive it without a device, and so the harness can report the tally.
 */
export function invalidateAllDDrawSurfaces(): SurfaceLossTally {
    const tally: SurfaceLossTally = { invalidated: 0, restorable: 0, contentLost: 0, bySource: {} };
    const seen = new Set<DirectDrawSurfaceState>();
    for (const [label, source] of sources) {
        let n = 0;
        try {
            for (const { state } of source()) {
                if (seen.has(state)) continue;
                n++;
                invalidateSurface(state, tally, seen);
            }
        } catch (err) {
            Logger.error(LogCategory.DDRAW,
                `[GPU-LOST] surface source "${label}" failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        tally.bySource[label] = n;
    }

    // The recycle pool hands out textures by size/format; every one in it belongs to the dead
    // device, so a post-recovery acquire would hand back a dead handle that looks healthy.
    clearGPUTexturePool();

    // D3DTEXTUREHANDLE registry: a second, independent holder of the same GPU textures that
    // deliberately outlives COM Release, so it is not reached by any surface walk.
    const ddraw = System.getInstance().process?.getModule?.("ddraw") as
        { context?: { textureHandles?: Map<number, { gpuTexture?: unknown; gpuTextureView?: unknown; gpuTextureFormat?: unknown; lastUploadVersion?: number }> } } | undefined;
    const handles = ddraw?.context?.textureHandles;
    if (handles) {
        for (const entry of handles.values()) {
            entry.gpuTexture = undefined;
            entry.gpuTextureView = undefined;
            entry.gpuTextureFormat = undefined;
            entry.lastUploadVersion = -1;
        }
        tally.bySource["d3d-texture-handles"] = handles.size;
    }

    return tally;
}

/**
 * IDirectDraw::RestoreAllSurfaces — revalidate every lost surface at once. Walks the same
 * sources as the invalidation, so a surface that could be reported lost can always be restored;
 * a second registry that the loss reaches but the restore does not would strand it forever.
 * Returns how many were restored.
 */
export function restoreAllLostSurfaces(): number {
    let restored = 0;
    const seen = new Set<DirectDrawSurfaceState>();
    const visit = (state: DirectDrawSurfaceState): void => {
        if (seen.has(state)) return;
        seen.add(state);
        if (isSurfaceLost(state)) { markSurfaceRestored(state); restored++; }
        for (const sub of state.mipSublevels ?? []) visit(sub);
    };
    for (const [label, source] of sources) {
        try {
            for (const { state } of source()) visit(state);
        } catch (err) {
            Logger.error(LogCategory.DDRAW,
                `[GPU-LOST] surface source "${label}" failed during restore: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return restored;
}

// A surface destroyed while lost must not leave the global lost count raised — the IsLost fast
// path defers to JS for as long as it is non-zero, so a leak here is a permanent slow path.
registerSurfaceTeardownHook((state) => forgetLossTrackedSurface(state));

let lastTally: SurfaceLossTally | null = null;

/** The most recent loss's tally — what came back and what did not. */
export function lastSurfaceLossTally(): SurfaceLossTally | null {
    return lastTally;
}

registerGpuDeviceObserver("ddraw-surfaces", {
    onDeviceLost: () => {
        lastTally = invalidateAllDDrawSurfaces();
        Logger.warn(LogCategory.DDRAW,
            `[GPU-LOST] ddraw surfaces invalidated — ${lastTally.invalidated} textures dropped, ` +
            `${lastTally.restorable} restore from CPU pixels, ${lastTally.contentLost} GPU-only surfaces lost their contents`);
    },
});
