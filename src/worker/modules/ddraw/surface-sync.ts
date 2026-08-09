import { DirectDrawSurfaceState, isBitmapTexture, isRenderSurface } from "./com-objects";
import { registerSurfaceTeardownHook } from "./surface-teardown";
import { System } from "../../core/system";
import { Logger, LogCategory, LogLevel } from "../../core/logger";
import { profiler } from "../../core/profiler";
import { leaseRegistry } from "../../core/memory/lease-registry";
import { DDSCAPS_TEXTURE } from "./constants";
import {
    uploadToGPUTexture,
    convertRGBAToSurface,
    surfaceFormatOutputsRGBA,
    detectPixelFormat,
    PixelFormat,
    applyColorKeyToRGBA,
    colorKeyChanged,
    resolvePalette,
} from "./gpu-texture-utils";
import { overlapsThunkCode } from "../../core/memory/address-guard";
import type { TextureConverter } from "../../backends/webgpu/ddraw/compute/texture-converter";
import {
    decodeSurfaceFormatToRgba8,
    getSurfaceFormatLayout,
} from "../../backends/webgpu/shared/texture-formats";
import { awaitInflightPrefetch } from "./surface-readback-prefetch";

// ============================================================================
// LEASE VALIDATION (single source of truth for pixel-write safety)
// ============================================================================

/**
 * True when the guest currently holds a *writable* Lock lease on this surface
 * (the Lease Model contract). Engine-internal pixel-write paths (CPU Blt/ColorFill,
 * GPU→CPU sync, GDI blit-into-surface) MUST consult this before touching the
 * surface's pixel memory: writing into memory the guest has locked for writing
 * races with the guest's own in-progress pixel writes and corrupts either side.
 *
 * This is the same LeaseRegistry lookup the Unlock commit path uses
 * (validateLease(activeLeaseId) + perms check) — it does NOT register a lease,
 * so it is zero-alloc (a single Map lookup) and safe to call per-Blt.
 */
export function surfaceHasActiveWriteLease(state: DirectDrawSurfaceState): boolean {
    if (state.activeLeaseId === undefined) return false;
    const lease = leaseRegistry.validateLease(state.activeLeaseId);
    return !!lease && lease.perms !== "r";
}

// ============================================================================
// AUTHORITY HELPERS (single source of truth for sync decisions)
// ============================================================================

/** Log surface state for debugging (address, mode, version, dirty flags). */
export const logSurfaceState = (
    state: DirectDrawSurfaceState,
    reason: string,
    surfaceAddr?: number
): void => {
    if (!Logger.isEnabled(LogCategory.DDRAW, LogLevel.VERBOSE)) {
        return;
    }
    const addr = surfaceAddr ?? state.surfacePtr;

    if (isBitmapTexture(state)) {
        Logger.verbose(
            LogCategory.DDRAW,
            `logSurfaceState 0x${addr.toString(16)}: [BitmapTexture] gpuNeedsUpload=${state.gpuNeedsUpload} reason=${reason}`
        );
    } else {
        Logger.verbose(
            LogCategory.DDRAW,
            `logSurfaceState 0x${addr.toString(16)}: mode=${state.mode} version=${state.version} ` +
                `gpuDirty=${state.gpuDirty} everLocked=${state.everLocked} ` +
                `gpuWrittenV=${state.gpuWrittenVersion ?? 'none'} reason=${reason}`
        );
    }
};

/** Assert mode invariants in debug. */
export const assertAuthorityInvariants = (
    state: DirectDrawSurfaceState,
    caller: string
): void => {
    // BitmapTextureSurface has no mode tracking - skip check
    if (isBitmapTexture(state)) {
        return;
    }

    // CPU-First invariants
    if (state.mode === "GPU_ONLY" && state.everLocked) {
        Logger.warn(
            LogCategory.DDRAW,
            `assertAuthorityInvariants [${caller}]: mode=GPU_ONLY but everLocked=true (should be demoted to CPU)`
        );
    }
    if (state.mode === "CPU" && state.gpuWrittenVersion === state.version) {
        Logger.warn(
            LogCategory.DDRAW,
            `assertAuthorityInvariants [${caller}]: mode=CPU but gpuWrittenVersion matches current version (GPU write without demotion?)`
        );
    }
};

/**
 * Demote GPU_ONLY surface to permanent CPU mode (one-time readback).
 * Called when Lock() is requested on a surface that GPU has written to.
 */
export async function demoteSurfaceToCpu(
    state: DirectDrawSurfaceState,
    device: GPUDevice,
    queue: GPUQueue,
    textureConverter: TextureConverter
): Promise<void> {
    if (isBitmapTexture(state) || state.mode !== "GPU_ONLY") {
        return; // Already CPU mode or immutable
    }

    // ONE-TIME GPU→CPU readback (expensive but rare)
    const token = profiler.startToken("demotion:syncToCPU");
    const manager = surfaceSyncManager;
    await manager.syncToCPU(state, device, queue, textureConverter);
    profiler.endToken(token);

    // Permanent CPU mode
    state.mode = "CPU";
    state.everLocked = true;

    Logger.warn(
        LogCategory.DDRAW,
        `Surface demoted to CPU mode: addr=0x${state.surfacePtr.toString(16)} ` +
        `(GPU write detected, Lock requested)`
    );
}

/** CPU-First: Mark that CPU wrote to surface. Increment version, set gpuDirty flag.
 *  IMPORTANT: Only applies to RenderSurface - BitmapTextureSurface is immutable.
 */
export const setAuthorityCpu = (state: DirectDrawSurfaceState): void => {
    if (isBitmapTexture(state)) {
        // BitmapTextureSurface is immutable - this should never be called
        Logger.warn(LogCategory.DDRAW, "setAuthorityCpu called on BitmapTextureSurface - ignoring");
        return;
    }

    // CPU-First: surfacePtr always authoritative, just mark GPU as dirty
    state.version += 1;
    state.gpuDirty = true; // GPU texture needs re-upload
};

/** Add a CPU-written rectangle to the region that the next upload must copy. */
export function unionSurfaceDirtyRegion(
    state: DirectDrawSurfaceState,
    rect: { left: number; top: number; right: number; bottom: number }
): void {
    if (!isRenderSurface(state)) return;

    const left = Math.max(0, Math.min(state.width, rect.left));
    const top = Math.max(0, Math.min(state.height, rect.top));
    const right = Math.max(left, Math.min(state.width, rect.right));
    const bottom = Math.max(top, Math.min(state.height, rect.bottom));
    if (right <= left || bottom <= top) return;

    if (!state.dirtyRegion) {
        state.dirtyRegion = { left, top, right, bottom };
        return;
    }

    state.dirtyRegion.left = Math.min(state.dirtyRegion.left, left);
    state.dirtyRegion.top = Math.min(state.dirtyRegion.top, top);
    state.dirtyRegion.right = Math.max(state.dirtyRegion.right, right);
    state.dirtyRegion.bottom = Math.max(state.dirtyRegion.bottom, bottom);
}

/** CPU-First: Mark that GPU wrote to texture (D3D DrawPrimitive).
 *  Sets gpuWrittenVersion for demotion detection.
 *  IMPORTANT: Only applies to RenderSurface in GPU_ONLY mode.
 */
export const setAuthorityGpu = (state: DirectDrawSurfaceState, _setCpuValidFalse = true): void => {
    if (isBitmapTexture(state)) {
        // BitmapTextureSurface is immutable - this should never be called
        Logger.warn(LogCategory.DDRAW, "setAuthorityGpu called on BitmapTextureSurface - ignoring");
        return;
    }

    // CPU-First: GPU write only happens for GPU_ONLY render targets
    state.version += 1;
    state.gpuWrittenVersion = state.version; // Mark for demotion detection
    state.gpuDirty = false; // GPU has current data
    // The GPU texture now holds this version (e.g. ReleaseDC uploaded the GDI canvas, or
    // D3D drew). needsGPUSync keys on lastUploadVersion, so it MUST advance too — otherwise
    // it reports lastUploadVersion < version and the next BeginScene re-uploads the (often
    // black/stale) CPU memory over GPU-authored content (StretchDIBits intro video → black).
    state.lastUploadVersion = state.version;
};

/** Reset to no content (e.g. LOST/Restore, or empty CreateSurface).
 *  IMPORTANT: Only applies to RenderSurface - BitmapTextureSurface is immutable.
 */
export const setAuthorityNone = (state: DirectDrawSurfaceState): void => {
    if (isBitmapTexture(state)) {
        // BitmapTextureSurface is immutable - this should never be called
        Logger.warn(LogCategory.DDRAW, "setAuthorityNone called on BitmapTextureSurface - ignoring");
        return;
    }

    // CPU-First: reset to clean slate
    state.mode = "CPU"; // Default to CPU mode
    state.version = 0;
    state.gpuDirty = false;
    state.gpuWrittenVersion = undefined;
    state.lastUploadVersion = -1;
    state.cpuSyncedVersion = undefined; // version rewinds to 0 here
};

/** After sync CPU→GPU: GPU now has current content.
 *  For BitmapTextureSurface, clears gpuNeedsUpload flag.
 *  For RenderSurface, clears gpuDirty and updates lastUploadVersion.
 */
export const markGpuSyncedFromCpu = (state: DirectDrawSurfaceState): void => {
    if (isBitmapTexture(state)) {
        state.gpuNeedsUpload = false;
        return;
    }

    // CPU-First: clear dirty flag, record upload version
    state.gpuDirty = false;
    state.lastUploadVersion = state.version;
};

/** After sync GPU→CPU (readback): guest memory at surfacePtr now holds this version's
 *  GPU content, so needsCPUSync must stop asking for it until something writes again.
 *  Every writer bumps `version`, so recording the synced version is sufficient and
 *  cannot serve stale pixels.
 *  BitmapTextureSurface never syncs GPU→CPU.
 */
export const markCpuSyncedFromGpu = (
    state: DirectDrawSurfaceState,
    expectedVersion?: number,
): boolean => {
    if (isBitmapTexture(state)) {
        // BitmapTextureSurface is immutable - this should never be called
        Logger.warn(LogCategory.DDRAW, "markCpuSyncedFromGpu called on BitmapTextureSurface - ignoring");
        return false;
    }

    // An async copy/map may finish after another GPU write bumped the surface.
    // The bytes that just landed belong to expectedVersion, never to the newer
    // version. Leaving the memo unset makes Lock retry instead of serving stale
    // pixels; this is the correctness gate that makes speculative prefetch safe.
    const version = expectedVersion ?? state.version;
    if (state.version !== version) {
        return false;
    }
    state.cpuSyncedVersion = version;
    return true;
};

/** Drop the readback memo. Required wherever `version` is assigned rather than
 *  incremented (flip rotation, sibling propagation across surfaces sharing one
 *  surfacePtr): such an assignment can move `version` backwards onto a value this
 *  surface already recorded, which would otherwise memoise a stale readback. */
export const invalidateCpuSyncedVersion = (state: DirectDrawSurfaceState): void => {
    if (isBitmapTexture(state)) return;
    state.cpuSyncedVersion = undefined;
};

/** GPU→CPU readback accounting. `roundTrips` is the honest cost metric (one
 *  copyTextureToBuffer/compute-convert + map per unit); `memoHits` counts the Locks
 *  that would have cost one before markCpuSyncedFromGpu recorded the version.
 *  `redundant` must stay 0: it fires when two readbacks of the SAME surface at the
 *  SAME version both reach the GPU, i.e. the memo has eroded. */
export const readbackCounters = {
    /** syncToCPU entered with a real sync decision. */
    calls: 0,
    /** Served from the cached RGBA copy, no GPU work. */
    scratchHits: 0,
    /** needsCPUSync answered "no" because this version was already read back. */
    memoHits: 0,
    /** Actual GPU→CPU round trips (compute-convert path + CPU slow path). */
    roundTrips: 0,
    /** Round trips that repeated a (surface, version) already read back — must be 0. */
    redundant: 0,
    reset(): void {
        this.calls = 0;
        this.scratchHits = 0;
        this.memoHits = 0;
        this.roundTrips = 0;
        this.redundant = 0;
    },
};

/** Per-surface MAP_READ staging buffer for the CPU slow path. The buffer is the size of
 *  the whole padded surface, so creating and destroying one per Lock is the single
 *  largest allocation on the readback path; a surface's size changes only on a mode
 *  switch, so one buffer per surface serves every readback of it.
 *  `busy` covers the window where a second readback of the SAME surface starts while
 *  the first still holds the mapping — that one gets a throwaway buffer. */
interface PooledReadbackBuffer {
    buffer: GPUBuffer;
    size: number;
    busy: boolean;
}
const readbackBufferPool = new WeakMap<object, PooledReadbackBuffer>();

/** Acquire a readback buffer for `state`; `release()` unmaps it and returns it to the
 *  pool (or destroys it, when it was a throwaway). Idempotent. */
function acquireReadbackBuffer(
    device: GPUDevice,
    state: DirectDrawSurfaceState,
    size: number
): { buffer: GPUBuffer; release: () => void } {
    const pooled = readbackBufferPool.get(state);
    if (pooled && !pooled.busy && pooled.size === size) {
        pooled.busy = true;
        let released = false;
        return {
            buffer: pooled.buffer,
            release: () => {
                if (released) return;
                released = true;
                pooled.buffer.unmap();
                pooled.busy = false;
                // Surface torn down while this readback was in flight: we are the last owner.
                if (readbackBufferPool.get(state) !== pooled) pooled.buffer.destroy();
            },
        };
    }

    const buffer = device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    if (pooled?.busy) {
        // Concurrent readback of the same surface owns the pooled buffer — throwaway.
        let released = false;
        return {
            buffer,
            release: () => {
                if (released) return;
                released = true;
                buffer.unmap();
                buffer.destroy();
            },
        };
    }

    if (pooled) pooled.buffer.destroy(); // size changed (mode switch) — replace
    const entry: PooledReadbackBuffer = { buffer, size, busy: true };
    readbackBufferPool.set(state, entry);
    let released = false;
    return {
        buffer,
        release: () => {
            if (released) return;
            released = true;
            buffer.unmap();
            entry.busy = false;
            if (readbackBufferPool.get(state) !== entry) buffer.destroy();
        },
    };
}

/** Drop the pooled staging buffer of a surface being torn down; nothing else ever frees
 *  it, and it is the size of the whole padded surface. */
function releaseReadbackBufferPool(state: DirectDrawSurfaceState): void {
    const pooled = readbackBufferPool.get(state);
    if (!pooled) return;
    readbackBufferPool.delete(state);
    // A busy slot is still mapped by an in-flight readback; its own release() destroys it.
    if (!pooled.busy) pooled.buffer.destroy();
}
registerSurfaceTeardownHook(releaseReadbackBufferPool);

/** Last version each surface was actually read back at, for the redundancy assertion.
 *  Separate from `cpuSyncedVersion` on purpose: this one is never cleared by the
 *  memo-invalidating paths, so it can still catch a memo that stopped working. */
const lastGpuReadbackVersion = new WeakMap<object, number>();

/** Count a real GPU→CPU round trip and assert it is not a repeat of one we already did
 *  at this version. */
const noteGpuRoundTrip = (state: DirectDrawSurfaceState, path: string, checkRepeat = true): void => {
    readbackCounters.roundTrips++;
    if (!isRenderSurface(state)) return;
    const previous = lastGpuReadbackVersion.get(state);
    if (checkRepeat && previous === state.version) {
        readbackCounters.redundant++;
        Logger.error(
            LogCategory.DDRAW,
            `REDUNDANT READBACK: surface 0x${state.surfacePtr.toString(16)} read back twice at ` +
            `version=${state.version} via ${path} (cpuSyncedVersion=${state.cpuSyncedVersion}) — ` +
            `the readback memo is not holding`
        );
    }
    lastGpuReadbackVersion.set(state, state.version);
};

// ============================================================================
// GDI CONTEXT SYNC
// ============================================================================

/**
 * Synchronize active GDI DC content to CPU surface memory.
 * If game used GetDC/ReleaseDC to draw on surface, we need to sync those pixels.
 *
 * Also updates rgbaScratch with Canvas RGBA data to ensure GPU sync
 * uses the fresh data from BitBlt/StretchBlt operations, not stale cached data.
 */
export const syncActiveGdiContext = (
    surfaceState: DirectDrawSurfaceState,
    surfaceAddr: number,
    mem: Uint8Array
): void => {
    const system = System.getInstance();
    const gdiContext = system.gdiContext;
    const hdc = gdiContext.getHDCBySurface(surfaceAddr);

    if (!hdc) return;

    Logger.log(
        LogCategory.DDRAW,
        `syncActiveGdiContext: Syncing HDC 0x${hdc.toString(16)} for surface 0x${surfaceAddr.toString(16)}`
    );

    const dcCtx = gdiContext.getDC(hdc);
    const dcCanvas = dcCtx?.canvas as OffscreenCanvas | undefined;

    if (!dcCanvas || !dcCtx) return;

    try {
        const imageData = gdiContext.getImageData(hdc);
        if (!imageData) return;

        const width = Math.min(surfaceState.width, imageData.width);
        const height = Math.min(surfaceState.height, imageData.height);
        const pitch =
            surfaceState.pitch || width * Math.max(1, surfaceState.format.bpp / 8);

        convertRGBAToSurface(
            imageData.data,
            mem,
            surfaceState.surfacePtr,
            width,
            height,
            pitch,
            surfaceState.format,
            { clearAlphaBit: true }
        );
        
        // Mark surface as written when GDI data is synced
        // This helps deferred Load() detection - if GDI wrote data, we should copy immediately
        surfaceState.surfaceEverWritten = true;

        // Update authority and rgbaScratch with Canvas RGBA data
        // This ensures that subsequent GPU sync uses the fresh RGBA data from
        // BitBlt/StretchBlt operations, not stale cached data.
        // Update authority FIRST, then rgbaScratch atomically
        // This prevents race condition where another thread reads mismatched version/data
        if (isRenderSurface(surfaceState)) {
            setAuthorityCpu(surfaceState);

            const expectedSize = width * height * 4;
            if (imageData.data.length >= expectedSize) {
                // Copy RGBA data to rgbaScratch (must copy, not view, as imageData may be reused)
                const newScratch = new Uint8Array(expectedSize);
                newScratch.set(new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, expectedSize));
                surfaceState.rgbaScratch = newScratch;
                surfaceState.rgbaScratchVersion = surfaceState.version; // Now matches version set by setAuthorityCpu
                Logger.log(LogCategory.DDRAW,
                    `syncActiveGdiContext: Updated rgbaScratch (${expectedSize} bytes) for surface 0x${surfaceAddr.toString(16)}`);
            } else {
                // Invalidate rgbaScratch to force convertSurfaceToRGBA on next GPU sync
                surfaceState.rgbaScratch = undefined;
                surfaceState.rgbaScratchVersion = undefined;
                Logger.warn(LogCategory.DDRAW,
                    `syncActiveGdiContext: Invalidated rgbaScratch (size mismatch: ${imageData.data.length} < ${expectedSize})`);
            }
        } else {
            // BitmapTextureSurface - update rgbaScratch (authoritative) and mark for upload
            const expectedSize = width * height * 4;
            if (imageData.data.length >= expectedSize) {
                const newScratch = new Uint8Array(expectedSize);
                newScratch.set(new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, expectedSize));
                surfaceState.rgbaScratch = newScratch;
                surfaceState.gpuNeedsUpload = true;
                Logger.log(LogCategory.DDRAW,
                    `syncActiveGdiContext: Updated BitmapTexture rgbaScratch (${expectedSize} bytes) for surface 0x${surfaceAddr.toString(16)}`);
            } else {
                Logger.warn(LogCategory.DDRAW,
                    `syncActiveGdiContext: Size mismatch for BitmapTexture: ${imageData.data.length} < ${expectedSize}`);
            }
        }
    } catch (e) {
        Logger.warn(LogCategory.DDRAW, `syncActiveGdiContext: Error syncing GDI DC: ${e}`);
    }
};

/** Minimal executor surface for GDI→GPU upload before D3D draws on the same RT. */
export interface GdiGpuUploadExecutor {
    uploadCanvasToTexture(
        state: DirectDrawSurfaceState,
        canvas: OffscreenCanvas,
        dirtyRect: { x: number; y: number; width: number; height: number } | null
    ): void;
    syncSurfaceFromMemory(state: DirectDrawSurfaceState): void;
}

/**
 * Composite an active GetDC canvas onto the render target before D3D BeginScene.
 * Blade/BOD draws intro/menu video via StretchDIBits on a leaked HDC, then renders
 * menu items with D3D on the same backbuffer — without this, GDI and GPU layers diverge.
 */
export const syncActiveGdiContextBeforeD3D = (
    surfaceState: DirectDrawSurfaceState,
    surfaceAddr: number,
    mem: Uint8Array,
    executor: GdiGpuUploadExecutor | null | undefined
): void => {
    const system = System.getInstance();
    const gdiContext = system.gdiContext;
    const hdc = gdiContext.getHDCBySurface(surfaceAddr);
    if (!hdc || !gdiContext.isDirty(hdc)) return;

    Logger.log(
        LogCategory.DDRAW,
        `syncActiveGdiContextBeforeD3D: HDC 0x${hdc.toString(16)} on surface 0x${surfaceAddr.toString(16)}`
    );

    const canvas = gdiContext.getCanvasForHDC(hdc);
    if (executor && surfaceState.gpuTexture && canvas) {
        executor.uploadCanvasToTexture(surfaceState, canvas, gdiContext.getDirtyRect(hdc));
        setAuthorityGpu(surfaceState, true);
        surfaceState.surfaceEverWritten = true;
    } else {
        syncActiveGdiContext(surfaceState, surfaceAddr, mem);
        if (executor && surfaceSyncManager.needsGPUSync(surfaceState).needed) {
            executor.syncSurfaceFromMemory(surfaceState);
        }
    }
    gdiContext.clearDirty(hdc);
};

// ============================================================================
// SURFACE SYNC MANAGER
// ============================================================================

/**
 * Sync decision result
 */
export interface SyncDecision {
    /** Whether sync is needed */
    needed: boolean;
    /** Reason for sync decision (for logging) */
    reason: string;
}

/**
 * Options for syncToGPU (optional inject conversion, force behavior).
 */
export interface SyncToGPUOptions {
    /** Custom CPU→RGBA conversion; if omitted, uses convertSurfaceToRGBA. */
    convertToRGBA?: (mem: Uint8Array, state: DirectDrawSurfaceState) => Uint8Array;
    /** GPU conversion function (encoder, state) -> void. If provided, uses GPU path directly. */
    convertToTextureGPU?: (encoder: GPUCommandEncoder, mem: Uint8Array, state: DirectDrawSurfaceState) => void;
    /** Custom upload function for RGBA data to GPU texture. If omitted, uses uploadToGPUTexture. */
    uploadToGPU?: (queue: GPUQueue, texture: GPUTexture, rgbaData: Uint8Array, width: number, height: number, scratch?: Uint8Array) => void;
    /** Passed to needsGPUSync when not using force. */
    forceInitialSync?: boolean;
    /** Skip needsGPUSync and always perform sync (e.g. prepareDraw/copySurface). */
    force?: boolean;
    /** Command encoder for GPU path (required if convertToTextureGPU is provided). */
    encoder?: GPUCommandEncoder;
}

/**
 * Centralized surface synchronization manager.
 * Handles CPU↔GPU sync decisions and operations.
 */
export class SurfaceSyncManager {
    /**
     * Check if surface needs to be synced from CPU to GPU (CPU-First architecture).
     *
     * @param state Surface state
     * @param forceInitialSync Force sync for newly created textures
     */
    needsGPUSync(state: DirectDrawSurfaceState, _forceInitialSync = false): SyncDecision {
        // No surface pointer - nothing to sync
        if (!state.surfacePtr || state.surfacePtr <= 0) {
            return { needed: false, reason: "no surfacePtr" };
        }

        // No GPU texture - can't sync
        if (!state.gpuTexture) {
            return { needed: false, reason: "no gpuTexture" };
        }

        // BitmapTextureSurface path: Check gpuNeedsUpload flag
        // Also check gpuTextureView to catch race where texture exists but was never uploaded
        if (isBitmapTexture(state)) {
            if (state.gpuNeedsUpload || !state.gpuTextureView) {
                return { needed: true, reason: `BitmapTexture needs upload (flag=${state.gpuNeedsUpload} view=${!!state.gpuTextureView})` };
            }
            return { needed: false, reason: "BitmapTexture already on GPU" };
        }

        // Lazy GPU texture was created but never populated from guest CPU memory.
        if (state.lastUploadVersion < 0) {
            return { needed: true, reason: "initial upload (lastUploadVersion=-1)" };
        }

        // CPU content is ahead of the last successful GPU upload.
        if (state.lastUploadVersion < state.version) {
            return { needed: true, reason: `CPU version ${state.version} > uploaded ${state.lastUploadVersion}` };
        }

        // CPU-First: generation-aware dirty check. surfaceEverWritten is a
        // lifetime hint, not a content generation; only a new version should
        // cause another CPU->GPU upload after the current version was synced.
        // A completed upload CLEARS gpuDirty (setAuthorityGpu), so a raised flag can only mean
        // "the CPU wrote after the last upload" — it is not something that can go stale on its
        // own. Dismissing it whenever version === lastUploadVersion assumed every writer also
        // bumps version, and several do not (D3D texture Load, some Blt paths): the surface then
        // keeps whatever reached the GPU on its FIRST upload for the rest of its life, which is
        // how lightmapped world surfaces ended up permanently black.
        if (state.gpuDirty) {
            return { needed: true, reason: `gpuDirty=true (CPU version ${state.version}, uploaded ${state.lastUploadVersion})` };
        }

        return { needed: false, reason: "GPU texture up-to-date" };
    }

    /**
     * Check if surface needs to be synced from GPU to CPU (rare demotion case).
     *
     * @param state Surface state
     */
    needsCPUSync(state: DirectDrawSurfaceState): SyncDecision {
        // No surface pointer - nothing to sync
        if (!state.surfacePtr || state.surfacePtr <= 0) {
            return { needed: false, reason: "no surfacePtr" };
        }

        // No GPU texture - can't sync
        if (!state.gpuTexture) {
            return { needed: false, reason: "no gpuTexture" };
        }

        // BitmapTextureSurface is immutable - never sync GPU→CPU
        if (isBitmapTexture(state)) {
            return { needed: false, reason: "BitmapTexture is immutable" };
        }

        // GPU has authoritative data when gpuWrittenVersion matches current version.
        // This covers two cases:
        // 1. GPU_ONLY mode: D3D rendered, Lock requested (demotion)
        // 2. CPU mode: surface was demoted by Lock, then D3D EndScene wrote GPU data
        //    (Lock backbuffer → Unlock → D3D Clear/EndScene → Flip CPU path)
        if (state.gpuWrittenVersion === state.version) {
            // Already read this exact content back into guest memory: a second round trip
            // would copy identical bytes. Any writer bumps `version` and invalidates this.
            // Diagnostic A/B only: setWorkerFlag('__noReadbackMemo', true) restores the
            // one-round-trip-per-Lock behaviour so the saving can be measured, not assumed.
            if (state.cpuSyncedVersion === state.version &&
                !(globalThis as { __noReadbackMemo?: boolean }).__noReadbackMemo) {
                readbackCounters.memoHits++;
                return { needed: false, reason: `already synced at version ${state.version}` };
            }
            const modeInfo = isRenderSurface(state) ? state.mode : "bitmap";
            return { needed: true, reason: `GPU has latest data (mode=${modeInfo}, gpuWrittenVersion=version)` };
        }

        // CPU has latest data - no readback needed
        return { needed: false, reason: "CPU has latest data" };
    }

    /**
     * True when a GPU-authoritative render surface can be synchronized to CPU
     * memory from the cached RGBA copy without issuing a GPU readback.
     */
    hasFreshCpuSyncScratch(state: DirectDrawSurfaceState): boolean {
        if (!isRenderSurface(state)) {
            return false;
        }
        const expectedSize = state.width * state.height * 4;
        return (
            state.rgbaScratch !== undefined &&
            state.rgbaScratch.length === expectedSize &&
            state.rgbaScratchVersion === state.version
        );
    }

    /**
     * Synchronous GPU->CPU sync fast path using the cached RGBA copy.
     *
     * Returns true only when CPU memory was updated. A false return means the
     * caller must either skip the sync by API semantics (WRITEONLY/DISCARD) or
     * fall back to the real async GPU readback path.
     */
    syncToCPUFromScratch(state: DirectDrawSurfaceState, mem?: Uint8Array): boolean {
        const decision = this.needsCPUSync(state);
        if (!decision.needed || !this.hasFreshCpuSyncScratch(state)) {
            return false;
        }

        const process = System.getInstance()?.process;
        const targetMem = mem ?? process?.getCurrentMemory();
        if (!targetMem) {
            return false;
        }

        if (!this.validateSurfacePtr(state, targetMem)) {
            Logger.warn(
                LogCategory.DDRAW,
                `syncToCPUFromScratch: Invalid surface pointer 0x${state.surfacePtr.toString(16)}`
            );
            return false;
        }

        // Lease guard: never write into pixels the guest has locked for writing.
        if (surfaceHasActiveWriteLease(state)) {
            Logger.warn(
                LogCategory.DDRAW,
                `syncToCPUFromScratch: SKIP - surface 0x${state.surfacePtr.toString(16)} is locked for writing (active write lease)`
            );
            return false;
        }

        profiler.start("syncToCPU:cachedScratch");
        try {
            const { width, height } = state;
            const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
            const pitch = Math.max(state.pitch, width * bytesPerPixel);

            const rgba = state.rgbaScratch!;
            const rgbaClamped = rgba instanceof Uint8ClampedArray
                ? rgba
                : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);

            convertRGBAToSurface(rgbaClamped, targetMem, state.surfacePtr, width, height, pitch, state.format);
            markCpuSyncedFromGpu(state);
            readbackCounters.scratchHits++;
            profiler.increment("SurfaceSyncManager.syncToCPU", "bytes", rgba.byteLength);

            Logger.verbose(
                LogCategory.DDRAW,
                `syncToCPUFromScratch: synchronized 0x${state.surfacePtr.toString(16)} ` +
                `${width}x${height} from cached rgbaScratch without GPU readback`
            );
            return true;
        } finally {
            profiler.end("syncToCPU:cachedScratch");
        }
    }

    /**
     * Validate that surface pointer is safe to read/write.
     *
     * @param state Surface state
     * @param mem Memory array
     */
    validateSurfacePtr(state: DirectDrawSurfaceState, mem: Uint8Array): boolean {
        if (!state.surfacePtr || state.surfacePtr <= 0) {
            return false;
        }

        const layout = getSurfaceFormatLayout(state.format, state.width, state.height);
        const pitch = Math.max(state.pitch, layout.pitch);
        const totalSize = pitch * layout.rows;

        // Check bounds
        if (state.surfacePtr < 0 || state.surfacePtr + totalSize > mem.length) {
            return false;
        }

        // Check for protected regions
        const process = System.getInstance().process;
        let regions = null;
        try {
            regions = process?.thunkMemoryManager?.getRegions() ?? null;
        } catch {
            regions = null;
        }

        if (regions) {
            const end = state.surfacePtr + totalSize;

            // Check callback stub pool
            const callbackEnd = regions.callbackStubPoolBase + regions.callbackStubPoolSize;
            if (state.surfacePtr < callbackEnd && end > regions.callbackStubPoolBase) {
                Logger.error(
                    LogCategory.DDRAW,
                    `validateSurfacePtr: Surface overlaps CALLBACK_STUB_POOL ` +
                        `ptr=0x${state.surfacePtr.toString(16)} size=0x${totalSize.toString(16)}`
                );
                return false;
            }

            // Check spin loop
            const spinEnd = regions.spinLoopAddress + regions.spinLoopSize;
            if (state.surfacePtr < spinEnd && end > regions.spinLoopAddress) {
                Logger.error(
                    LogCategory.DDRAW,
                    `validateSurfacePtr: Surface overlaps SPIN_LOOP ` +
                        `ptr=0x${state.surfacePtr.toString(16)} size=0x${totalSize.toString(16)}`
                );
                return false;
            }

            // Check thunk generator
            const thunkEnd = regions.thunkGeneratorBase + regions.thunkGeneratorSize;
            if (state.surfacePtr < thunkEnd && end > regions.thunkGeneratorBase) {
                Logger.error(
                    LogCategory.DDRAW,
                    `validateSurfacePtr: Surface overlaps THUNK_GENERATOR ` +
                        `ptr=0x${state.surfacePtr.toString(16)} size=0x${totalSize.toString(16)}`
                );
                return false;
            }
        }

        return true;
    }

    /**
     * Sync surface from CPU memory to GPU texture.
     *
     * @param state Surface state
     * @param queue GPU queue
     * @param options Optional: convertToRGBA, forceInitialSync, force
     * @returns true if sync was performed
     */
    syncToGPU(
        state: DirectDrawSurfaceState,
        queue: GPUQueue,
        options?: SyncToGPUOptions
    ): boolean {
        const force = options?.force === true;
        const forceInitialSync = options?.forceInitialSync ?? false;

        if (!force) {
            const decision = this.needsGPUSync(state, forceInitialSync);
            if (!decision.needed) {
                Logger.verbose(
                    LogCategory.DDRAW,
                    `syncToGPU: skipped for 0x${state.surfacePtr.toString(16)} - ${decision.reason}`
                );
                return false;
            }
        }

        profiler.start("SurfaceSyncManager.syncToGPU");
        try {
            const system = System.getInstance();
            const process = system?.process;
            if (!process) {
                return false;
            }

            const mem = process.getCurrentMemory();
            if (!this.validateSurfacePtr(state, mem)) {
                Logger.warn(
                    LogCategory.DDRAW,
                    `syncToGPU: Invalid surface pointer 0x${state.surfacePtr.toString(16)}`
                );
                return false;
            }

            const { width, height } = state;
            const layout = getSurfaceFormatLayout(state.format, width, height);

            // Use stored pitch as authoritative source
            const computedPitch = layout.pitch;
            const storedPitch = state.pitch || 0;
            let pitch: number;

            if (storedPitch > 0) {
                pitch = storedPitch;
                if (pitch < computedPitch) {
                    Logger.error(LogCategory.DDRAW,
                        `syncToGPU: Invalid stored pitch ${pitch} < ${computedPitch}, using computed.`);
                    pitch = computedPitch;
                } else if (pitch > computedPitch) {
                    Logger.log(LogCategory.DDRAW,
                        `syncToGPU: Using stored pitch ${pitch} > computed ${computedPitch} (row padding)`);
                }
            } else {
                pitch = computedPitch;
                Logger.warn(LogCategory.DDRAW,
                    `syncToGPU: No stored pitch for surface 0x${state.surfacePtr.toString(16)}, using computed ${pitch}`);
            }

            // BOUNDS CHECK: Verify pitch * height fits in memory
            const totalSize = pitch * layout.rows;
            if (state.surfacePtr + totalSize > mem.length) {
                Logger.error(LogCategory.DDRAW,
                    `syncToGPU: Surface overrun! ptr=0x${state.surfacePtr.toString(16)} ` +
                    `size=${totalSize} mem.length=${mem.length}`);
                return false; // ABORT to prevent corruption
            }

            const borrowedLeaseId = leaseRegistry.createLease(
                state.surfacePtr,
                totalSize,
                "SurfaceSyncManager_GPU",
                "r",
                { tag: "sync_to_gpu" }
            );

            // Check for lease conflict (surface locked for writing)
            if (borrowedLeaseId === 0) {
                Logger.warn(LogCategory.DDRAW,
                    `syncToGPU: SKIP - surface 0x${state.surfacePtr.toString(16)} is locked for writing (lease conflict detected)`
                );
                return false;
            }

            // GPU path: direct conversion to texture (zero-copy)
            if (options?.convertToTextureGPU && options.encoder) {
                try {
                    options.convertToTextureGPU(options.encoder, mem, state);

                    // GPU path: GPU now has content from CPU — clear dirty flags
                    if (isBitmapTexture(state)) {
                        state.gpuNeedsUpload = false;
                    } else {
                        // CPU-First: Clear dirty flag and record upload version
                        state.gpuDirty = false;
                        state.lastUploadVersion = state.version;
                    }
                    
                    const bytes = width * height * 4;
                    profiler.increment("SurfaceSyncManager.syncToGPU", "bytes", bytes);
                    
                    // Update frame snapshot counters
                    const ddraw = system.process?.getModule("ddraw") as any;
                    if (ddraw?.incrementFrameCounter) {
                        ddraw.incrementFrameCounter("uploads");
                        ddraw.incrementFrameCounter("textureBytes", bytes);
                    }

                    Logger.verbose(
                        LogCategory.DDRAW,
                        `syncToGPU: GPU path completed for 0x${state.surfacePtr.toString(16)} ${width}x${height}`
                    );
                    return true;
                } finally {
                    leaseRegistry.revokeLease(borrowedLeaseId);
                }
            }

            // CPU path: convert to RGBA, then upload
            let rgbaData: Uint8Array;
            try {
                if (options?.convertToRGBA) {
                    rgbaData = options.convertToRGBA(mem, state);
                } else if (isBitmapTexture(state)) {
                    // ================================================================
                    // BitmapTextureSurface: Handle colorkey for texture transparency
                    // ================================================================
                    // Some D3D games may call SetColorKey AFTER
                    // texture load. We cache the colorkey-applied version separately
                    // to avoid mutating the authoritative rgbaScratch.

                    if (state.srcColorKey) {
                        // Check if we have cached version with current colorkey
                        const needsRebuild = colorKeyChanged(state.srcColorKey, state.appliedColorKey);

                        if (needsRebuild || !state.rgbaScratchWithColorKey) {
                            // Apply colorkey: read surface pixels in original format,
                            // compare with colorkey range, set alpha=0 for matches
                            Logger.verbose(LogCategory.DDRAW,
                                `syncToGPU: BitmapTexture applying colorkey 0x${state.srcColorKey.low.toString(16)}-` +
                                `0x${state.srcColorKey.high.toString(16)} for 0x${state.surfacePtr.toString(16)}`);

                            state.rgbaScratchWithColorKey = applyColorKeyToRGBA(
                                state.rgbaScratch,
                                mem,
                                state.surfacePtr,
                                width,
                                height,
                                pitch,
                                state.format,
                                state.srcColorKey
                            );
                            // Remember which colorkey was applied
                            state.appliedColorKey = { ...state.srcColorKey };
                        }

                        rgbaData = state.rgbaScratchWithColorKey;
                        Logger.verbose(LogCategory.DDRAW,
                            `syncToGPU: BitmapTexture with colorkey for 0x${state.surfacePtr.toString(16)}`);
                    } else {
                        // No colorkey - use authoritative rgbaScratch directly (fast path)
                        rgbaData = state.rgbaScratch;
                        Logger.verbose(LogCategory.DDRAW,
                            `syncToGPU: BitmapTexture fast path (no colorkey) for 0x${state.surfacePtr.toString(16)}`);
                    }
                } else {
                    // RenderSurface: Check if we have cached RGBA
                    const expectedSize = width * height * 4;
                    const hasFreshRGBA =
                        state.rgbaScratch !== undefined &&
                        state.rgbaScratch.length === expectedSize &&
                        state.rgbaScratchVersion === state.version;

                    if (hasFreshRGBA && state.rgbaScratch) {
                        // Use cached rgbaScratch (ephemeral cache, but valid for this version)
                        rgbaData = state.rgbaScratch;
                        Logger.verbose(
                            LogCategory.DDRAW,
                            `syncToGPU: Using cached rgbaScratch for RenderSurface 0x${state.surfacePtr.toString(16)}`
                        );
                    } else {
                        // Convert from surface memory (stale or missing cache)
                        const palette = resolvePalette(state);
                        rgbaData = decodeSurfaceFormatToRgba8(
                            mem,
                            state.surfacePtr,
                            width,
                            height,
                            pitch,
                            state.format,
                            state.rgbaScratch,
                            state.srcColorKey,
                            palette
                        );
                        // Update cache for RenderSurface
                        state.rgbaScratch = rgbaData;
                        state.rgbaScratchVersion = state.version;
                    }
                }
            } finally {
                leaseRegistry.revokeLease(borrowedLeaseId);
            }

            // Format conversion (RGBA/BGRA) is handled at upload time in uploadToGPUTexture

            const unpaddedBPR = width * 4;
            const alignedBPR = (unpaddedBPR + 255) & ~255;
            let padScratch: Uint8Array | undefined;
            if (alignedBPR !== unpaddedBPR && height > 1) {
                const requiredBytes = alignedBPR * height;
                if (!state.rgbaPaddedScratch || state.rgbaPaddedScratch.length !== requiredBytes) {
                    state.rgbaPaddedScratch = new Uint8Array(requiredBytes);
                }
                padScratch = state.rgbaPaddedScratch;
            }
            const gpuFormat = state.gpuTextureFormat ?? "rgba8unorm";
            if (options?.uploadToGPU) {
                options.uploadToGPU(queue, state.gpuTexture!, rgbaData, width, height, padScratch);
            } else {
                uploadToGPUTexture(queue, state.gpuTexture!, rgbaData, width, height, padScratch, gpuFormat);
            }

            // After successful CPU->GPU upload, clear dirty flags
            if (isBitmapTexture(state)) {
                // BitmapTextureSurface: Clear upload flag
                state.gpuNeedsUpload = false;
                Logger.verbose(LogCategory.DDRAW,
                    `syncToGPU: BitmapTexture uploaded successfully, cleared gpuNeedsUpload for 0x${state.surfacePtr.toString(16)}`
                );
            } else {
                // CPU-First: Clear dirty flag and record upload version
                state.gpuDirty = false;
                state.lastUploadVersion = state.version;
                Logger.verbose(LogCategory.DDRAW,
                    `syncToGPU: RenderSurface uploaded successfully, cleared gpuDirty for 0x${state.surfacePtr.toString(16)} (ver=${state.version})`
                );
            }

            const bytes = rgbaData.byteLength;
            profiler.increment("SurfaceSyncManager.syncToGPU", "bytes", bytes);
            
            // Update frame snapshot counters
            const ddraw = system.process?.getModule("ddraw") as any;
            if (ddraw?.incrementFrameCounter) {
                ddraw.incrementFrameCounter("uploads");
                ddraw.incrementFrameCounter("textureBytes", bytes);
            }

            Logger.verbose(
                LogCategory.DDRAW,
                `syncToGPU: completed for 0x${state.surfacePtr.toString(16)} ${width}x${height}`
            );
            return true;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `syncToGPU: Failed: ${e}`);
            return false;
        } finally {
            profiler.end("SurfaceSyncManager.syncToGPU");
        }
    }

    /**
     * Sync surface from GPU texture to CPU memory.
     *
     * @param state Surface state
     * @param device GPU device
     * @param queue GPU queue
     * @param textureConverter Optional TextureConverter for GPU-accelerated format conversion
     * @returns true if sync was performed
     */
    async syncToCPU(
        state: DirectDrawSurfaceState,
        device: GPUDevice,
        queue: GPUQueue,
        textureConverter?: TextureConverter,
        opts?: { fromPrefetch?: boolean }
    ): Promise<boolean> {
        // Prefer a version-matched in-flight prefetch over starting a second trip.
        // Prefetch itself must not await its own promise (deadlock).
        if (!opts?.fromPrefetch && await awaitInflightPrefetch(state)) {
            return true;
        }

        const decision = this.needsCPUSync(state);
        if (!decision.needed) {
            Logger.verbose(
                LogCategory.DDRAW,
                `syncToCPU: skipped for 0x${state.surfacePtr.toString(16)} - ${decision.reason}`
            );
            return false;
        }
        readbackCounters.calls++;

        // Token span: syncToCPU crosses awaits, so concurrent readbacks would corrupt
        // each other's start time under the Map-keyed start/end. The token is closed
        // exactly once (in `finally`), which also fixes the double-counting the
        // per-branch profiler.end()s used to produce.
        const syncToken = profiler.startToken("SurfaceSyncManager.syncToCPU");
        // The pool slot is marked busy at acquire; a rejected mapAsync (or any throw past
        // it) must still hand it back or every later readback of this surface allocates.
        let releasePooledReadback: (() => void) | null = null;
        try {
            const system = System.getInstance();
            const process = system?.process;
            if (!process) {
                return false;
            }

            const mem = process.getCurrentMemory();
            if (!this.validateSurfacePtr(state, mem)) {
                Logger.warn(
                    LogCategory.DDRAW,
                    `syncToCPU: Invalid surface pointer 0x${state.surfacePtr.toString(16)}`
                );
                return false;
            }

            // Lease guard: a GPU→CPU readback writes guest pixel memory. Skip
            // while the guest holds a writable Lock lease to avoid racing its writes.
            if (surfaceHasActiveWriteLease(state)) {
                Logger.warn(
                    LogCategory.DDRAW,
                    `syncToCPU: SKIP - surface 0x${state.surfacePtr.toString(16)} is locked for writing (active write lease)`
                );
                return false;
            }

            const { width, height } = state;
            const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
            const pitch = Math.max(state.pitch, width * bytesPerPixel);

            // Cached GPU-written RGBA can be converted into guest memory
            // synchronously. Only miss this branch when a real GPU readback is
            // required.
            if (this.syncToCPUFromScratch(state, mem)) {
                return true;
            }
            if (!isRenderSurface(state)) return false;

            // Capture only after the synchronous scratch path. All GPU bytes copied
            // below belong to this version even if another writer advances the state
            // while mapAsync is pending.
            const readbackVersion = state.version;

            // ================================================================
            // GPU COMPUTE FAST PATH: Use compute shader for format conversion
            // This avoids expensive CPU loops (187ms → ~5ms)
            // ================================================================
            // Set once the compute-convert path issued its round trip: the CPU slow path
            // below is then a legitimate SECOND trip (convert failed), not an eroded memo.
            let attemptedGpuRoundTrip = false;
            const surfacePixelFormat = detectPixelFormat(state.format);
            const gpuConvertSupported =
                textureConverter &&
                state.gpuTexture &&
                (surfacePixelFormat === PixelFormat.RGB565 ||
                 surfacePixelFormat === PixelFormat.RGB555 ||
                 surfacePixelFormat === PixelFormat.ARGB8888 ||
                 surfacePixelFormat === PixelFormat.XRGB8888);

            if (gpuConvertSupported) {
                const gpuConvertToken = profiler.startToken("syncToCPU:gpuConvert");
                Logger.log(LogCategory.DDRAW,
                    `🚀 syncToCPU GPU COMPUTE PATH: Converting ${width}x${height} format=${surfacePixelFormat} on GPU`);

                noteGpuRoundTrip(state, "gpuConvert");
                attemptedGpuRoundTrip = true;
                const gpuFormat = state.gpuTextureFormat ?? "rgba8unorm";
                const converted = await textureConverter.convertFromTexture(
                    state.gpuTexture!,
                    gpuFormat,
                    surfacePixelFormat,
                    width,
                    height,
                    pitch
                );

                if (converted) {
                    // Write converted data directly to surface memory
                    // NOTE: surfacePtr is a guest address that maps directly to mem[] index.
                    // Do NOT subtract mem.byteOffset — that would write to the wrong location.
                    const totalWriteSize = pitch * height;
                    const inBounds = state.surfacePtr >= 0 && state.surfacePtr + totalWriteSize <= mem.length;

                    if (inBounds && !overlapsThunkCode(state.surfacePtr, totalWriteSize)) {
                        mem.set(converted.subarray(0, totalWriteSize), state.surfacePtr);
                        const versionStillCurrent = markCpuSyncedFromGpu(state, readbackVersion);

                        profiler.increment("SurfaceSyncManager.syncToCPU", "bytes", totalWriteSize);
                        profiler.endToken(gpuConvertToken);

                        // DIAGNOSTIC: Pixel dump to verify readback is not all-black
                        {
                            const u16 = new Uint16Array(converted.buffer, converted.byteOffset, Math.min(16, converted.length >> 1));
                            const px = Array.from(u16.subarray(0, 8)).map(v => `0x${v.toString(16).padStart(4, '0')}`);
                            const allZero = u16.every(v => v === 0);
                            Logger.log(LogCategory.DDRAW,
                                `PIXEL DUMP after readback 0x${state.surfacePtr.toString(16)}: [${px.join(', ')}] allZero=${allZero}`);
                        }
                        // DIAGNOSTIC: Verify data actually landed in mem at the correct offset
                        {
                            if (state.surfacePtr >= 0 && state.surfacePtr + 16 <= mem.length) {
                                const u16v = new Uint16Array(mem.buffer, mem.byteOffset + state.surfacePtr, 8);
                                const pxv = Array.from(u16v).map(v => `0x${v.toString(16).padStart(4, '0')}`);
                                Logger.log(LogCategory.DDRAW,
                                    `VERIFY mem[0x${state.surfacePtr.toString(16)}] after write: [${pxv.join(', ')}]`);
                            }
                        }

                        Logger.log(LogCategory.DDRAW,
                            `syncToCPU GPU COMPUTE PATH completed for 0x${state.surfacePtr.toString(16)} ` +
                            `(${totalWriteSize} bytes, format=${surfacePixelFormat})`);
                        return versionStillCurrent;
                    } else {
                        Logger.warn(LogCategory.DDRAW,
                            `syncToCPU: GPU convert succeeded but write blocked (bounds=${inBounds}, thunk=${overlapsThunkCode(state.surfacePtr, totalWriteSize)})`);
                    }
                } else {
                    Logger.warn(LogCategory.DDRAW,
                        `syncToCPU: GPU convert failed, falling back to CPU path`);
                }
                profiler.endToken(gpuConvertToken);
                // Fall through to CPU path
            }

            // ================================================================
            // CPU SLOW PATH: Traditional readback with CPU format conversion
            // ================================================================

            // WebGPU alignment: 256 bytes per row
            const unpaddedBytesPerRow = width * 4;
            const align = 256;
            const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / align) * align;
            const bufferSize = paddedBytesPerRow * height;

            noteGpuRoundTrip(state, "copyTextureToBuffer", !attemptedGpuRoundTrip);

            const { buffer: readback, release: releaseReadback } =
                acquireReadbackBuffer(device, state, bufferSize);
            releasePooledReadback = releaseReadback;

            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture: state.gpuTexture! },
                { buffer: readback, bytesPerRow: paddedBytesPerRow },
                { width, height, depthOrArrayLayers: 1 }
            );
            queue.submit([encoder.finish()]);

            // DIAGNOSTIC: Log expensive blocking operation with caller stack
            const beforeWait = performance.now();
            Logger.warn(LogCategory.DDRAW,
                `⚠️ syncToCPU BLOCKING: Starting GPU→CPU readback for surface 0x${state.surfacePtr.toString(16)} ` +
                `(${width}x${height} = ${bufferSize} bytes). This will STALL the frame!`
            );

            // mapAsync already resolves after the submitted copy completes; an
            // onSubmittedWorkDone() fence in front of it is a second wait on the same event.
            const mapAsyncToken = profiler.startToken("syncToCPU:mapAsync");
            await readback.mapAsync(GPUMapMode.READ);
            profiler.endToken(mapAsyncToken);
            const afterMap = performance.now();
            Logger.log(LogCategory.DDRAW,
                `syncToCPU: mapAsync completed in ${(afterMap - beforeWait).toFixed(2)}ms`
            );
            const mapped = new Uint8Array(readback.getMappedRange());

            const copyConvertToken = profiler.startToken("syncToCPU:copyConvert");
            const gpuFormat = state.gpuTextureFormat ?? "rgba8unorm";
            const pixelFormat = detectPixelFormat(state.format);
            const totalWriteSize = pitch * height;
            // NOTE: surfacePtr maps directly to mem[] index. Do NOT subtract mem.byteOffset.
            const inBounds = state.surfacePtr >= 0 && state.surfacePtr + totalWriteSize <= mem.length;

            // FAST PATH: BGRA readback -> ARGB/XRGB surface is a direct row copy (no swizzle/convert).
            if (
                gpuFormat === "bgra8unorm" &&
                (pixelFormat === PixelFormat.ARGB8888 || pixelFormat === PixelFormat.XRGB8888) &&
                pitch >= unpaddedBytesPerRow &&
                inBounds &&
                !overlapsThunkCode(state.surfacePtr, totalWriteSize)
            ) {
                if (paddedBytesPerRow === unpaddedBytesPerRow && pitch === unpaddedBytesPerRow) {
                    mem.set(mapped.subarray(0, unpaddedBytesPerRow * height), state.surfacePtr);
                } else {
                    for (let row = 0; row < height; row++) {
                        const srcStart = row * paddedBytesPerRow;
                        const dstStart = state.surfacePtr + row * pitch;
                        mem.set(mapped.subarray(srcStart, srcStart + unpaddedBytesPerRow), dstStart);
                    }
                }

                releaseReadback();

                profiler.endToken(copyConvertToken);
                const versionStillCurrent = markCpuSyncedFromGpu(state, readbackVersion);
                profiler.increment("SurfaceSyncManager.syncToCPU", "bytes", unpaddedBytesPerRow * height);
                Logger.log(
                    LogCategory.DDRAW,
                    `syncToCPU: FAST BGRA copy completed for 0x${state.surfacePtr.toString(16)} ${width}x${height}`
                );
                return versionStillCurrent;
            }

            // Extract RGBA data (remove padding when needed)
            const unpaddedSize = unpaddedBytesPerRow * height;
            let rgbaData: Uint8Array;
            const canReuseScratch = isRenderSurface(state) && state.rgbaScratch && state.rgbaScratch.length === unpaddedSize;
            const needsDepad = paddedBytesPerRow !== unpaddedBytesPerRow;

            if (!needsDepad) {
                rgbaData = mapped.subarray(0, unpaddedSize);
            } else {
                rgbaData = canReuseScratch ? state.rgbaScratch! : new Uint8Array(unpaddedSize);
                for (let row = 0; row < height; row++) {
                    const srcStart = row * paddedBytesPerRow;
                    const dstStart = row * unpaddedBytesPerRow;
                    rgbaData.set(mapped.subarray(srcStart, srcStart + unpaddedBytesPerRow), dstStart);
                }
            }

            // Convert and write to CPU memory
            // If GPU texture is BGRA, swizzle to logical RGBA before conversion
            if (gpuFormat === "bgra8unorm") {
                const view32 = new Uint32Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.length / 4);
                for (let i = 0; i < view32.length; i++) {
                    const rgba = view32[i];
                    view32[i] =
                        (rgba & 0xFF00FF00) |
                        ((rgba & 0x00FF0000) >> 16) |
                        ((rgba & 0x000000FF) << 16);
                }
            }
            // Cache the (depadded, RGBA-swizzled) readback so the NEXT syncToCPU of
            // this same surface version hits the CPU-only fast path above (~1ms) instead
            // of repeating the ~190ms GPU→CPU readback. The fast path keys on
            // rgbaScratchVersion===version, so any GPU write (which bumps version)
            // correctly invalidates this. Covers BOTH needsDepad and !needsDepad — the
            // latter previously skipped caching, so 256-aligned widths re-read every time.
            if (isRenderSurface(state) && rgbaData.length === unpaddedSize) {
                if (needsDepad) {
                    // rgbaData is already a standalone buffer (the depad target).
                    state.rgbaScratch = rgbaData;
                } else {
                    // rgbaData is a view into the readback buffer (unmapped below) — copy out.
                    if (!state.rgbaScratch || state.rgbaScratch.length !== unpaddedSize) {
                        state.rgbaScratch = new Uint8Array(unpaddedSize);
                    }
                    state.rgbaScratch.set(rgbaData);
                }
                state.rgbaScratchVersion = readbackVersion;
            }

            const rgbaClamped = rgbaData instanceof Uint8ClampedArray
                ? rgbaData
                : new Uint8ClampedArray(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);

            // DIAGNOSTIC: Log where we're about to write
            Logger.log(
                LogCategory.DDRAW,
                `syncToCPU: Writing ${width}x${height} (${totalWriteSize} bytes) to surfacePtr=0x${state.surfacePtr.toString(16)} ` +
                `mem.byteOffset=0x${mem.byteOffset.toString(16)} mem.length=0x${mem.length.toString(16)}`
            );

            try {
                convertRGBAToSurface(rgbaClamped, mem, state.surfacePtr, width, height, pitch, state.format);
            } finally {
                releaseReadback();
            }
            profiler.endToken(copyConvertToken);
            const versionStillCurrent = markCpuSyncedFromGpu(state, readbackVersion);

            profiler.increment("SurfaceSyncManager.syncToCPU", "bytes", rgbaData.byteLength);
            Logger.log(
                LogCategory.DDRAW,
                `syncToCPU: completed for 0x${state.surfacePtr.toString(16)} ${width}x${height}`
            );
            return versionStillCurrent;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `syncToCPU: Failed: ${e}`);
            return false;
        } finally {
            releasePooledReadback?.();
            profiler.endToken(syncToken);
        }
    }
}

// Singleton instance
export const surfaceSyncManager = new SurfaceSyncManager();

/**
 * A D3D render target must consume any newer CPU writes before the next draw.
 *
 * This is intentionally independent of the surface caps. Legacy games can mix
 * DirectDraw CPU blits with D3D rendering on an ordinary video-memory
 * backbuffer. Limiting this check to texture/system-memory targets leaves those
 * CPU writes invisible to the GPU.
 */
export function needsRenderTargetUploadBeforeDraw(state: DirectDrawSurfaceState): boolean {
    return surfaceSyncManager.needsGPUSync(state).needed;
}
