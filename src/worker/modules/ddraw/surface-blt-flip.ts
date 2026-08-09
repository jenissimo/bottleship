/**
 * Surface Blt, BltFast, Flip, GetBltStatus, GetFlipStatus, SetColorKey, GetColorKey.
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { profiler } from "../../core/profiler";
import { frameProfiler } from "../../core/frame-profiler";
import { framePacer, PRESENT_INTERVAL_ONE } from "../../core/frame-pacer";
import { DDrawContext } from "./context";
import {
    DD_OK,
    E_FAIL,
    E_POINTER,
    DDFLIP_INTERVAL2,
    DDFLIP_INTERVAL3,
    DDFLIP_INTERVAL4,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_FLIP,
    DDSCAPS_FRONTBUFFER,
    DDSCAPS_OVERLAY,
    DDSCAPS_BACKBUFFER,
    DDSCAPS_3DDEVICE,
    DDSCAPS_ZBUFFER,
    DDSCAPS_TEXTURE,
    DDERR_NOTFLIPPABLE,
    DDERR_SURFACEBUSY,
    DDBLT_COLORFILL,
    DDERR_INVALIDPARAMS,
    D3DCLEAR_TARGET,
    D3DCLEAR_ZBUFFER,
    D3DCLEAR_STENCIL,
    DDBLT_DEPTHFILL,
    DDCKEY_COLORSPACE,
    DDCKEY_SRCBLT,
    DDCKEY_DESTBLT,
    DDBLT_KEYSRC,
    DDBLT_KEYSRCOVERRIDE,
    DDBLTFAST_SRCCOLORKEY,
    DDBLT_ROP,
    DDBLTFX_SIZE,
    DDBLTFX_OFFSETS,
    DDERR_WASSTILLDRAWING,
    DDGFS_ISFLIPDONE,
    DDGFS_CANFLIP,
} from "./constants";
import { readRect, type Rect } from "./helpers";
import { absToRel } from "./helpers";
import { copySurfaceRegion, copySurfaceRegionWithColorKey, copySurfaceRegionWithRop, copyCompressedSurfaceRegion, buildFullRect } from "./surface-helpers";
import { RectPool } from "./rect-pool";
import { DirectDrawSurfaceObject, isBitmapTexture, isRenderSurface } from "./com-objects";
import { convertRGBAToSurface, createGPUTexture, uploadToGPUTexture } from "./gpu-texture-utils";
import {
    decodeSurfaceFormatToRgba8,
    getSurfaceFormatLayout,
} from "../../backends/webgpu/shared/texture-formats";
import type { DirectDrawSurfaceState } from "./com-objects";
import {
    setAuthorityCpu,
    setAuthorityGpu,
    surfaceSyncManager,
    surfaceHasActiveWriteLease,
    unionSurfaceDirtyRegion,
} from "./surface-sync";
import { propagateSurfaceStateToRegistry } from "./d3d/texture-manager";
import { isValidAddress } from "../../core/memory/address-guard";
import { markGpuSyncedFromCpu } from "./surface-sync";
import { onFrameEnd as frameCaptureOnFrameEnd } from "./frame-capture";
import { recordSurfaceOp } from "./surface-op-log";
import { clearDepthForZSurface, fillZSurfaceMemory, isZBufferSurface } from "./depth-fill";
import { collectFlipChain, findFlipBlockingLease, flipStorageCompatible, rotateFlipChain } from "./flip-chain";

// Module-level rect pool to reduce allocations in hot paths
const rectPool = new RectPool(8);

const missingFormatWarnedSurfacePtrs = new Set<number>();

/**
 * Lazy GPU Promotion: Create GPU texture for surface on-demand when needed for GPU Blt.
 * This allows SYSMEM offscreen surfaces (e.g., video frames) to participate in GPU blits
 * without changing CreateSurface logic or affecting other games.
 *
 * @param targetFormat - GPU texture format to use (should match destination for copyTextureToTexture)
 * @returns true if surface now has a valid GPU texture
 */
function ensureGpuTextureForBlt(
    state: DirectDrawSurfaceState,
    context: DDrawContext,
    mem: Uint8Array,
    targetFormat: GPUTextureFormat = "bgra8unorm"
): boolean {
    // Already has GPU texture
    if (state.gpuTexture) return true;

    // No backend — cannot create
    if (!context.backend) return false;

    const device = context.backend.getDevice();
    const queue = context.backend.getQueue();
    if (!device || !queue) return false;

    const isRenderTarget =
        (state.caps & (DDSCAPS_PRIMARYSURFACE | DDSCAPS_BACKBUFFER | DDSCAPS_3DDEVICE)) !== 0;
    // Keep non-render-target surfaces in stable RGBA format.
    // This matches executor/directdraw policy and avoids accidental B/R swaps
    // when lazy promotion happens before gpuTextureFormat is initialized.
    const promotionFormat: GPUTextureFormat = isRenderTarget ? targetFormat : "rgba8unorm";

    // Lazy create GPU texture: Copy + RenderAttachment so it can be used as blit source/dest or render target
    const gpuResult = createGPUTexture(
        device,
        queue,
        state.width,
        state.height,
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
        promotionFormat
    );

    if (!gpuResult) {
        Logger.warn(LogCategory.DDRAW,
            `ensureGpuTextureForBlt: Failed to create GPU texture for 0x${state.surfacePtr.toString(16)}`);
        return false;
    }

    state.gpuTexture = gpuResult.texture;
    state.gpuTextureView = gpuResult.view;
    state.gpuTextureFormat = promotionFormat;

    Logger.log(LogCategory.DDRAW,
        `ensureGpuTextureForBlt: PROMOTED surface 0x${state.surfacePtr.toString(16)} ` +
        `${state.width}x${state.height} to GPU (lazy, format=${promotionFormat}, caps=0x${state.caps.toString(16)})`);

    // Upload current data to GPU
    let rgbaData: Uint8Array;

    if (isBitmapTexture(state)) {
        // BitmapTextureSurface: Use authoritative rgbaScratch directly (fast path)
        rgbaData = state.rgbaScratch;
    } else if (isRenderSurface(state) && state.surfacePtr) {
        // Upload immediately — the surface may be destroyed before deferred batch runs,
        // freeing surfacePtr memory. flushAll() would then read stale/reused data.
        // (SYSMEM surfaces promoted, deferred, destroyed; surfacePtr reused → wrong pixel data.)
        const layout = getSurfaceFormatLayout(state.format, state.width, state.height);
        const rgbaImmediate = decodeSurfaceFormatToRgba8(
            mem, state.surfacePtr, state.width, state.height,
            Math.max(state.pitch, layout.pitch), state.format, state.rgbaScratch, state.srcColorKey
        );
        uploadToGPUTexture(queue, state.gpuTexture!, rgbaImmediate, state.width, state.height,
            undefined, promotionFormat);
        markGpuSyncedFromCpu(state);
        state.gpuDirty = false;

        Logger.log(LogCategory.DDRAW,
            `ensureGpuTextureForBlt: Immediate upload for 0x${state.surfacePtr.toString(16)} ` +
            `${state.width}x${state.height} (format=${promotionFormat})`);
    } else {
        // No valid data to upload
        return false;
    }

    return true;
}

function resolveSurfaceTextureFormat(
    state: DirectDrawSurfaceState
): GPUTextureFormat {
    if (state.gpuTextureFormat) {
        return state.gpuTextureFormat;
    }

    const textureFormat = (state.gpuTexture as unknown as { format?: GPUTextureFormat } | undefined)?.format;
    if (textureFormat) {
        return textureFormat;
    }

    const isRenderTarget =
        (state.caps & (DDSCAPS_PRIMARYSURFACE | DDSCAPS_BACKBUFFER | DDSCAPS_3DDEVICE)) !== 0;
    const inferred: GPUTextureFormat = isRenderTarget ? "bgra8unorm" : "rgba8unorm";
    const surfacePtr = state.surfacePtr >>> 0;
    if (!missingFormatWarnedSurfacePtrs.has(surfacePtr)) {
        missingFormatWarnedSurfacePtrs.add(surfacePtr);
        Logger.warn(
            LogCategory.DDRAW,
            `resolveSurfaceTextureFormat(Blt): missing gpuTextureFormat/texture.format ` +
            `for surface=0x${surfacePtr.toString(16)}, inferred=${inferred}`
        );
    }
    return inferred;
}

/**
 * CPU-First: Deterministic decision for GPU fast path.
 * ONLY use GPU for pure 3D render-to-texture scenarios.
 * Default to CPU path for all other cases (reliable, predictable).
 */
function canUseGpuFastPath(
    srcState: DirectDrawSurfaceState,
    dstState: DirectDrawSurfaceState,
    useColorKey: boolean,
    isStretch: boolean
): boolean {
    // BitmapTexture or CPU mode surfaces → CPU path
    if (!isRenderSurface(srcState) || !isRenderSurface(dstState)) {
        return false;
    }

    // DETERMINISTIC criteria for GPU fast path:
    // 1. Both surfaces are GPU_ONLY mode (pure 3D render targets)
    // 2. Neither surface has EVER been locked (everLocked=false)
    // 3. Both have GPU textures
    // 4. No colorkey or stretch (GPU copyTextureToTexture limitations)
    return (
        srcState.mode === "GPU_ONLY" &&
        dstState.mode === "GPU_ONLY" &&
        !srcState.everLocked &&
        !dstState.everLocked &&
        !!srcState.gpuTexture &&
        !!dstState.gpuTexture &&
        !useColorKey &&
        !isStretch
    );
}

function clampRectsForBlt(
    src: DirectDrawSurfaceState,
    dst: DirectDrawSurfaceState,
    srcRect: Rect,
    dstRect: Rect
): { src: Rect; dst: Rect; width: number; height: number } | null {
    const s = rectPool.acquireCopy(srcRect);
    const d = rectPool.acquireCopy(dstRect);

    // Normalize negatives by shifting both rects
    if (s.left < 0) {
        const dlt = -s.left;
        s.left = 0; s.right += dlt;
        d.left += dlt; d.right += dlt;
    }
    if (s.top < 0) {
        const dlt = -s.top;
        s.top = 0; s.bottom += dlt;
        d.top += dlt; d.bottom += dlt;
    }
    if (d.left < 0) {
        const dlt = -d.left;
        d.left = 0; d.right += dlt;
        s.left += dlt; s.right += dlt;
    }
    if (d.top < 0) {
        const dlt = -d.top;
        d.top = 0; d.bottom += dlt;
        s.top += dlt; s.bottom += dlt;
    }

    // Clip each rect independently to its surface bounds (preserves stretch dimensions)
    s.right = Math.min(s.right, src.width);
    s.bottom = Math.min(s.bottom, src.height);
    d.right = Math.min(d.right, dst.width);
    d.bottom = Math.min(d.bottom, dst.height);

    const srcW = s.right - s.left;
    const srcH = s.bottom - s.top;
    const dstW = d.right - d.left;
    const dstH = d.bottom - d.top;
    if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
        rectPool.release(s);
        rectPool.release(d);
        return null;
    }

    const resultSrc = rectPool.acquire();
    resultSrc.left = s.left;
    resultSrc.top = s.top;
    resultSrc.right = s.right;
    resultSrc.bottom = s.bottom;

    const resultDst = rectPool.acquire();
    resultDst.left = d.left;
    resultDst.top = d.top;
    resultDst.right = d.right;
    resultDst.bottom = d.bottom;

    rectPool.release(s);
    rectPool.release(d);

    // width/height reflect the destination dimensions for presentation purposes
    return { src: resultSrc, dst: resultDst, width: dstW, height: dstH };
}

/**
 * Flip's dwFlags → refreshes to hold the flip for. The INTERVALn flags are DirectDraw's
 * spelling of D3DPRESENT_INTERVAL_TWO/THREE/FOUR and are honored.
 *
 * DDFLIP_NOVSYNC is deliberately NOT mapped to IMMEDIATE yet. Its faithful reading is "do
 * not wait for the retrace", but Flip is the only frame throttle a great many DDraw-era
 * titles have, and this backend carries most of the library: releasing it lets guest logic
 * run at the IMMEDIATE backstop (8x refresh) on the same worker thread the guest CPU and the
 * audio pump share, and a title whose simulation is tied to its frame loop then runs fast.
 * That is a change to every existing DDraw bundle and wants its own regression pass, not a
 * ride-along with the d3d paths. `__forcePresentInterval` 0 exercises it meanwhile.
 */
function flipPresentInterval(dwFlags: number): number {
    if (dwFlags & DDFLIP_INTERVAL4) return 4;
    if (dwFlags & DDFLIP_INTERVAL3) return 3;
    if (dwFlags & DDFLIP_INTERVAL2) return 2;
    return PRESENT_INTERVAL_ONE;
}

export function createSurfaceBltFlipExports(context: DDrawContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // NOTE: Changed back to async for FramePacer integration.
    // FramePacer pauses virtual time when presenter is busy, preventing waste.
    // PERF: Sync-by-default — only returns Promise when GPU readback, deferred upload, or frame pacing needed.
    exports["IDirectDrawSurface7_Flip"] = (ctx, mem, args): number | Promise<number> => {
        const thisPtr = args[0];
        const lpDDSurfaceTargetOverride = args[1];
        const presentInterval = flipPresentInterval(args[2] >>> 0);
        profiler.start('Flip:lookup');
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;
        const state = obj.getState();

        const system = System.getInstance();
        const gdiContext = system.gdiContext;
        profiler.end('Flip:lookup');

        // GDI sync phase
        profiler.start('Flip:gdiSync');
        const surfacesToSync = [thisPtr];
        if (state.attachedSurfaceAddr) surfacesToSync.push(state.attachedSurfaceAddr);

        for (const sPtr of surfacesToSync) {
            const hdc = gdiContext.getHDCBySurface(sPtr);
            if (hdc && gdiContext.isDirty(hdc)) {
                const sObj = context.resourceProvider.getComObjectByAddress(sPtr) as DirectDrawSurfaceObject | null;
                if (!sObj) continue;
                Logger.log(LogCategory.DDRAW, `IDirectDrawSurface7_Flip: Force syncing active GDI HDC 0x${hdc.toString(16)} on surface 0x${sPtr.toString(16)}`);
                try {
                    const imageData = gdiContext.getImageData(hdc);
                    if (imageData) {
                        const sState = sObj.getState();
                        const width = Math.min(sState.width, imageData.width);
                        const height = Math.min(sState.height, imageData.height);
                        const pitch = sState.pitch || (width * Math.max(1, sState.format.bpp / 8));
                        convertRGBAToSurface(imageData.data, mem, sState.surfacePtr, width, height, pitch, sState.format, { clearAlphaBit: true });
                        setAuthorityCpu(sState);
                        unionSurfaceDirtyRegion(sState, { left: 0, top: 0, right: width, bottom: height });
                        gdiContext.clearDirty(hdc);
                    }
                } catch (e) {
                    Logger.warn(LogCategory.SYSTEM, `IDirectDrawSurface7_Flip: GDI Sync failed: ${e}`);
                }
            }
        }
        profiler.end('Flip:gdiSync');

        // Flip renames storage around a chain whose FRONT is `this`. Wine
        // (ddraw_surface1_Flip) refuses anything else outright — a back buffer, a
        // non-flippable surface, or an override that is this very surface.
        profiler.start('Flip:resolve');
        const isFront = (state.caps & (DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER | DDSCAPS_OVERLAY)) !== 0;
        if (!isFront || (state.caps & DDSCAPS_FLIP) === 0
            || (lpDDSurfaceTargetOverride && (lpDDSurfaceTargetOverride >>> 0) === (thisPtr >>> 0))) {
            profiler.end('Flip:resolve');
            Logger.warn(LogCategory.DDRAW,
                `IDirectDrawSurface7_Flip: surface 0x${thisPtr.toString(16)} caps=0x${state.caps.toString(16)} ` +
                `is not the front buffer of a flip chain -> DDERR_NOTFLIPPABLE`);
            return DDERR_NOTFLIPPABLE;
        }

        const ring = collectFlipChain(thisPtr, (a) =>
            context.resourceProvider.getComObjectByAddress(a) as DirectDrawSurfaceObject | null);

        // The links do not close into a ring only when the back buffer reached us
        // through context.surfaces rather than an attachment; pair with it directly.
        let chain = ring;
        if (!chain) {
            const bbAddr = context.surfaces.backBuffer;
            const bbObj = bbAddr && bbAddr !== thisPtr
                ? context.resourceProvider.getComObjectByAddress(bbAddr) as DirectDrawSurfaceObject | null
                : null;
            const bbState = bbObj?.getState();
            if (bbState && flipStorageCompatible(state, bbState)) {
                chain = [{ addr: thisPtr >>> 0, state }, { addr: bbAddr >>> 0, state: bbState }];
            }
        }
        if (!chain || chain.length < 2) {
            profiler.end('Flip:resolve');
            Logger.warn(LogCategory.DDRAW,
                `IDirectDrawSurface7_Flip: no flip target for surface 0x${thisPtr.toString(16)} -> DDERR_NOTFLIPPABLE`);
            return DDERR_NOTFLIPPABLE;
        }

        // Flip(target) renames front and target and leaves the surfaces between them
        // untouched; without a target the whole ring rotates one position.
        let rotateSpan = chain.map((e) => e.state);
        if (lpDDSurfaceTargetOverride) {
            const idx = chain.findIndex((e) => e.addr === (lpDDSurfaceTargetOverride >>> 0));
            if (idx <= 0) {
                profiler.end('Flip:resolve');
                Logger.warn(LogCategory.DDRAW,
                    `IDirectDrawSurface7_Flip: override 0x${lpDDSurfaceTargetOverride.toString(16)} is not on ` +
                    `the flip chain of 0x${thisPtr.toString(16)} -> DDERR_NOTFLIPPABLE`);
                return DDERR_NOTFLIPPABLE;
            }
            rotateSpan = [chain[0].state, chain[idx].state];
        }

        const busy = findFlipBlockingLease(rotateSpan);
        if (busy) {
            profiler.end('Flip:resolve');
            Logger.warn(LogCategory.DDRAW,
                `IDirectDrawSurface7_Flip: surface 0x${busy.surfacePtr.toString(16)} still holds a Lock lease ` +
                `-> DDERR_SURFACEBUSY (the guest must Unlock before flipping)`);
            return DDERR_SURFACEBUSY;
        }

        // The image about to reach the screen is the one the successor holds.
        const srcState = rotateSpan[1];
        const dstState = state;
        profiler.end('Flip:resolve');

        // Diagnostic: log flip resolution
        {
            const s = srcState as any;
            Logger.log(LogCategory.DDRAW,
                `IDirectDrawSurface7_Flip: chain=${chain.length} src=0x${srcState.surfacePtr.toString(16)} dst=0x${dstState.surfacePtr.toString(16)} srcMode=${s.mode ?? '?'} srcGpuTex=${!!srcState.gpuTexture} dstGpuTex=${!!dstState.gpuTexture} srcGpuDirty=${s.gpuDirty ?? '?'} srcVer=${s.version ?? '?'} srcGpuWriteVer=${s.gpuWrittenVersion ?? '?'}`);
        }

        // Helper: post-copy Flip tail — deferred uploads, frame pacing, present
        const finishFlip = (): number | Promise<number> => {
            // DEFERRED UPLOAD: Batch upload all dirty surfaces accumulated during frame
            profiler.start('Flip:deferredUploads');
            const hasUploads = !!(context.backend && context.backend.getQueue());
            if (hasUploads) {
                const queue = context.backend!.getQueue()!;
                return context.deferredUploadManager.flushAll(queue, mem).then(() => {
                    profiler.end('Flip:deferredUploads');
                    return doFramePacingAndPresent();
                });
            }
            profiler.end('Flip:deferredUploads');
            return doFramePacingAndPresent();
        };

        // Helper: frame pacing + present (always async — Flip MUST pace)
        const doFramePacingAndPresent = (): Promise<number> => {
            profiler.start('Flip:flush');
            if (context.executor) context.executor.flush();
            profiler.end('Flip:flush');

            // Frame capture: finalize captured draw calls for this frame
            frameCaptureOnFrameEnd();

            // Frame Pacer: hold for the interval this Flip asked for (default = one refresh).
            return framePacer.waitForPresentInterval(presentInterval).then(() => {
                // Mark frame END after pacer wait so frameMs includes real inter-frame interval.
                frameProfiler.markFrame("ddraw");

                // Flip is usually the end of a frame, so we throttle.
                profiler.start('Flip:present');
                if (!context.suppressPresent) {
                    // A primary-chain Flip puts the flip chain on screen: in exclusive
                    // fullscreen, GDI windows stop being visible (until FlipToGDISurface).
                    context.gdiSurfaceVisible = false;
                    Logger.verbose(LogCategory.DDRAW,
                        `Flip: calling present dst=0x${dstState.surfacePtr.toString(16)} gpuDirty=${(dstState as any).gpuDirty} gpuTexView=${!!dstState.gpuTextureView}`);
                    void context.presenter.present(dstState, mem, { throttle: true, frameAlreadyMarked: true });
                } else {
                    Logger.warn(LogCategory.DDRAW, `Flip: suppressPresent=true, skipping present!`);
                }
                profiler.end('Flip:present');

                return DD_OK;
            });
        };

        // Flip phase — rotate storage around the chain (DirectDraw renames surfaces,
        // it does not copy pixels; see flip-chain.ts).
        profiler.start('Flip:rotate');
        // A pending render pass still targets the pre-rotation texture.
        if (context.executor) context.executor.flush();

        // Two indexes are keyed by the storage that is about to move and would otherwise
        // describe the wrong surface afterwards: the surfacePtr→handle map (sibling
        // propagation reads it) and the deferred-upload batch.
        const handleOf = new Map<DirectDrawSurfaceState, number>();
        for (const e of chain) {
            const obj = context.resourceProvider.getComObjectByAddress(e.addr) as DirectDrawSurfaceObject | null;
            if (obj) handleOf.set(e.state, obj.handle);
        }
        const wasPendingUpload = new Set(
            rotateSpan.filter((s) => context.deferredUploadManager.isPendingUpload(s)));

        rotateFlipChain(rotateSpan, rotateSpan.length, (move) => {
            const handle = handleOf.get(move.to);
            if (handle !== undefined && move.previousPtr !== move.to.surfacePtr) {
                context.resourceProvider.unregisterSurfacePtr(handle, move.previousPtr);
                context.resourceProvider.registerSurfacePtr(handle, move.to.surfacePtr);
            }
            context.deferredUploadManager.setPendingUpload(move.to, wasPendingUpload.has(move.from));
        });
        recordSurfaceOp("flip", `rotate:${rotateSpan.length}`, dstState, srcState, null, null);
        profiler.end('Flip:rotate');

        return finishFlip();
    };

    exports["IDirectDrawSurface7_GetBltStatus"] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.DDRAW, `IDirectDrawSurface7_GetBltStatus: called (always returning DD_OK)`);
        return DD_OK;
    };

    exports["IDirectDrawSurface7_GetFlipStatus"] = (ctx, mem, args) => {
        const dwFlags = args[1];

        // DDGFS_ISFLIPDONE / DDGFS_CANFLIP: return WASSTILLDRAWING while
        // the frame pacer is busy (i.e. waiting for next rAF). This provides
        // backpressure for games that spin on GetFlipStatus instead of
        // calling WaitForVerticalBlank.
        if (dwFlags & (DDGFS_ISFLIPDONE | DDGFS_CANFLIP)) {
            if (!framePacer.isFrameSlotAvailable()) {
                return DDERR_WASSTILLDRAWING;
            }
        }
        return DD_OK;
    };

    exports["IDirectDrawSurface7_SetColorKey"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwFlags = args[1];
        const lpColorKey = args[2];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const state = obj.getState();
        const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;

        Logger.log(LogCategory.DDRAW, `[COLORKEY] IDirectDrawSurface7_SetColorKey: called (thisPtr=0x${thisPtr.toString(16)} dwFlags=0x${dwFlags.toString(16)} lpColorKey=0x${lpColorKey.toString(16)})`);
        
        if (!lpColorKey || !isValidAddress(mem, lpColorKey, 8)) {
            if (dwFlags & DDCKEY_SRCBLT) state.srcColorKey = undefined;
            if (dwFlags & DDCKEY_DESTBLT) state.destColorKey = undefined;

            // Invalidate colorkey cache based on surface type
            if (isBitmapTexture(state)) {
                state.rgbaScratchWithColorKey = undefined;
                state.appliedColorKey = undefined;
                state.gpuNeedsUpload = true;
            } else if (isRenderSurface(state)) {
                state.rgbaScratch = undefined;
                state.rgbaScratchVersion = undefined;
            }

            Logger.verbose(LogCategory.DDRAW, `SetColorKey: Cleared colorkey flags=0x${dwFlags.toString(16)}${isTexture ? " [TEXTURE]" : ""}`);
            if (isTexture) {
                propagateSurfaceStateToRegistry(context, state);
            }
            return DD_OK;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const low = view.getUint32(lpColorKey, true);
        // Without DDCKEY_COLORSPACE the key is a single color: dwColorSpaceHighValue
        // is ignored by DirectDraw (games routinely leave it as stack garbage).
        const high = (dwFlags & DDCKEY_COLORSPACE) !== 0 ? view.getUint32(lpColorKey + 4, true) : low;

        if (dwFlags & DDCKEY_SRCBLT) {
            state.srcColorKey = { low, high };
            Logger.log(LogCategory.DDRAW,
                `SetColorKey: SRCBLT 0x${low.toString(16)}-0x${high.toString(16)}${isTexture ? " [TEXTURE]" : ""} surface=0x${thisPtr.toString(16)}`);

            // ================================================================
            // COLORKEY CACHE INVALIDATION
            // ================================================================
            // Old D3D games may call SetColorKey AFTER loading the texture.
            // We need to invalidate cached RGBA and mark for re-upload.
            if (isBitmapTexture(state)) {
                // BitmapTexture: Mark for re-upload, cache will be rebuilt
                state.gpuNeedsUpload = true;
                Logger.log(LogCategory.DDRAW,
                    `SetColorKey: Marked BitmapTexture 0x${thisPtr.toString(16)} for re-upload (colorkey changed)`);
            } else if (isRenderSurface(state)) {
                // RenderSurface: Invalidate rgbaScratch cache so it's rebuilt with new colorkey
                state.rgbaScratch = undefined;
                state.rgbaScratchVersion = undefined;
                Logger.verbose(LogCategory.DDRAW,
                    `SetColorKey: Invalidated RenderSurface 0x${thisPtr.toString(16)} cache (colorkey changed)`);
            }
        }
        if (dwFlags & DDCKEY_DESTBLT) {
            state.destColorKey = { low, high };
            Logger.log(LogCategory.DDRAW, `SetColorKey: DESTBLT 0x${low.toString(16)}-0x${high.toString(16)}${isTexture ? " [TEXTURE]" : ""} surface=0x${thisPtr.toString(16)}`);
        }
        if (isTexture && (state.srcColorKey || state.destColorKey)) {
            propagateSurfaceStateToRegistry(context, state);
        }
        return DD_OK;
    };

    exports["IDirectDrawSurface7_GetColorKey"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwFlags = args[1];
        const lpColorKey = args[2];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;
        if (!lpColorKey || !isValidAddress(mem, lpColorKey, 8)) return E_POINTER;

        const state = obj.getState();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        if (dwFlags & DDCKEY_SRCBLT) {
            if (state.srcColorKey) {
                view.setUint32(lpColorKey, state.srcColorKey.low, true);
                view.setUint32(lpColorKey + 4, state.srcColorKey.high, true);
            } else {
                view.setUint32(lpColorKey, 0, true);
                view.setUint32(lpColorKey + 4, 0, true);
            }
        } else if (dwFlags & DDCKEY_DESTBLT) {
            if (state.destColorKey) {
                view.setUint32(lpColorKey, state.destColorKey.low, true);
                view.setUint32(lpColorKey + 4, state.destColorKey.high, true);
            } else {
                view.setUint32(lpColorKey, 0, true);
                view.setUint32(lpColorKey + 4, 0, true);
            }
        } else {
            view.setUint32(lpColorKey, 0, true);
            view.setUint32(lpColorKey + 4, 0, true);
        }
        return DD_OK;
    };

    exports["IDirectDrawSurface7_Blt"] = (ctx, mem, args): number | Promise<number> => {
        const thisPtr = args[0];
        const lpDestRect = args[1];
        const lpSrcSurface = args[2];
        const lpSrcRect = args[3];
        const dwFlags = args[4];
        const lpDDBltFx = args[5];

        const dstObj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!dstObj) return E_FAIL;
        const dstState = dstObj.getState();

        if ((dstState.caps & DDSCAPS_TEXTURE) !== 0) {
            const srcObj = lpSrcSurface ? context.resourceProvider.getComObjectByAddress(lpSrcSurface) as DirectDrawSurfaceObject | null : null;
            Logger.log(LogCategory.DDRAW, 
                `Blt to TEXTURE: dst=0x${thisPtr.toString(16)} src=0x${(lpSrcSurface || 0).toString(16)} ` +
                `flags=0x${dwFlags.toString(16)} dstSize=${dstState.width}x${dstState.height} ` +
                `srcSize=${srcObj ? srcObj.getState().width + "x" + srcObj.getState().height : "N/A"}`);
        }

        const dstRect = lpDestRect ? readRect(mem, lpDestRect) : buildFullRect(dstState);
        if (!dstRect) return DD_OK;

        if (!lpSrcSurface) {
            // A source-less Blt is a fill, and a fill carries its value in DDBLTFX: without
            // one of the fill flags, or without the struct, DirectDraw has nothing to write.
            const isFill = (dwFlags & (DDBLT_COLORFILL | DDBLT_DEPTHFILL)) !== 0;
            const fillSize = DDBLTFX_OFFSETS.fillColor + 4;
            const hasFx = !!lpDDBltFx && isValidAddress(mem, lpDDBltFx, fillSize);
            if (!isFill || !hasFx) return DDERR_INVALIDPARAMS;
            const fillColor = new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
                .getUint32(lpDDBltFx + DDBLTFX_OFFSETS.fillColor, true);

            // A source-less fill aimed at a z buffer is a DEPTH CLEAR. DDBLT_DEPTHFILL says so
            // explicitly, but on real hardware the z surface IS the depth memory, so engines of
            // this era clear it with a plain DDBLT_COLORFILL just as often — the destination's
            // DDSCAPS_ZBUFFER is what decides, not the flag.
            if ((dwFlags & DDBLT_DEPTHFILL) !== 0 || isZBufferSurface(dstState)) {
                // The guest pixels ARE the depth memory as far as the app is concerned, and a
                // later Lock reads them back to decide what to clear to, so write them too —
                // the depth attachment behind them is our cache, not the app's view.
                fillZSurfaceMemory(dstState, mem, dstRect, fillColor);
                clearDepthForZSurface(context, thisPtr, dstState, dstRect, fillColor);
                recordSurfaceOp("fill", "depth", dstState, null, dstRect, null);
                return DD_OK;
            }

            // GPU_ONLY surfaces: use GPU-only clear (never Lock/Unlocked)
            const isGpuOnly = isRenderSurface(dstState) && dstState.mode === "GPU_ONLY";
            if (isGpuOnly && dstState.gpuTexture && context.executor) {
                let argbColor = 0xff000000;
                const fmt = dstState.format;
                const use32bit = fmt.bpp === 32 || (fmt.bpp === 16 && fillColor > 0xffff);
                if (use32bit) {
                    argbColor = 0xff000000 | (fillColor & 0xffffff);
                } else if (fmt.bpp === 16) {
                    const ctz = (mask: number): number => {
                        if (mask === 0) return 0;
                        let count = 0;
                        while ((mask & 1) === 0) { mask >>>= 1; count++; }
                        return count;
                    };
                    const popcount = (mask: number): number => {
                        let count = 0;
                        while (mask !== 0) { count++; mask &= mask - 1; }
                        return count;
                    };
                    const rShift = ctz(fmt.rMask);
                    const gShift = ctz(fmt.gMask);
                    const bShift = ctz(fmt.bMask);
                    const r5 = (fillColor & fmt.rMask) >>> rShift;
                    const g = (fillColor & fmt.gMask) >>> gShift;
                    const b5 = (fillColor & fmt.bMask) >>> bShift;
                    const rBits = popcount(fmt.rMask);
                    const gBits = popcount(fmt.gMask);
                    const bBits = popcount(fmt.bMask);
                    const rMax = (1 << rBits) - 1;
                    const gMax = (1 << gBits) - 1;
                    const bMax = (1 << bBits) - 1;
                    const r8 = Math.round((r5 * 255) / rMax);
                    const g8 = Math.round((g * 255) / gMax);
                    const b8 = Math.round((b5 * 255) / bMax);
                    argbColor = 0xff000000 | (r8 << 16) | (g8 << 8) | b8;
                }

                Logger.verbose(LogCategory.DDRAW, `IDirectDrawSurface7_Blt: Using GPU-only clear for GPU_ONLY surface ColorFill color=0x${(fillColor >>> 0).toString(16)}`);
                context.executor!.clear(dstState, D3DCLEAR_TARGET, argbColor, 1.0, {
                    x: dstRect.left,
                    y: dstRect.top,
                    width: dstRect.right - dstRect.left,
                    height: dstRect.bottom - dstRect.top,
                });
                setAuthorityGpu(dstState);
                recordSurfaceOp("fill", "gpu", dstState, null, dstRect, null);
                return DD_OK;
            }

            // CPU-mode surfaces (including lazily GPU-promoted ones): MUST fill CPU memory.
            // Lock/Unlock accesses surfacePtr directly — GPU-only clear would leave
            // stale data visible to the game, causing cursor accumulation bugs etc.
            const bpp = Math.max(1, dstState.format.bpp / 8);
            const bytesPerPixel = Math.floor(bpp);
            const rectWidth = dstRect.right - dstRect.left;
            const rectHeight = dstRect.bottom - dstRect.top;

            // Lease guard: ColorFill writes CPU pixel memory directly. Skip
            // while the guest holds a writable Lock lease on the destination.
            if (surfaceHasActiveWriteLease(dstState)) {
                Logger.warn(LogCategory.DDRAW,
                    `IDirectDrawSurface7_Blt: SKIP ColorFill - dst 0x${dstState.surfacePtr.toString(16)} is locked for writing (active write lease)`);
                recordSurfaceOp("fill", "skip:lease", dstState, null, dstRect, null);
                return DD_OK;
            }

            if (rectWidth > 0 && rectHeight > 0) {
                for (let y = 0; y < rectHeight; y++) {
                    const rowAddr = dstState.surfacePtr + (dstRect.top + y) * dstState.pitch + dstRect.left * bytesPerPixel;
                    const relRowAddr = absToRel(mem, rowAddr);
                    if (relRowAddr >= 0 && relRowAddr + rectWidth * bytesPerPixel <= mem.length) {
                        if (bytesPerPixel === 2) {
                            for (let x = 0; x < rectWidth; x++) {
                                mem[relRowAddr + x * 2] = fillColor & 0xff;
                                mem[relRowAddr + x * 2 + 1] = (fillColor >> 8) & 0xff;
                            }
                        } else if (bytesPerPixel === 4) {
                            for (let x = 0; x < rectWidth; x++) {
                                mem[relRowAddr + x * 4] = fillColor & 0xff;
                                mem[relRowAddr + x * 4 + 1] = (fillColor >> 8) & 0xff;
                                mem[relRowAddr + x * 4 + 2] = (fillColor >> 16) & 0xff;
                                mem[relRowAddr + x * 4 + 3] = (fillColor >> 24) & 0xff;
                            }
                        } else {
                            mem.fill(fillColor & 0xff, relRowAddr, relRowAddr + rectWidth * bytesPerPixel);
                        }
                    }
                }
                setAuthorityCpu(dstState);
                unionSurfaceDirtyRegion(dstState, dstRect);
            }

            recordSurfaceOp("fill", "cpu", dstState, null, dstRect, null);
            return DD_OK;
        }

        const srcObj = context.resourceProvider.getComObjectByAddress(lpSrcSurface) as DirectDrawSurfaceObject | null;
        if (!srcObj) return E_FAIL;

        const srcState = srcObj.getState();
        const srcRect = lpSrcRect ? readRect(mem, lpSrcRect) : buildFullRect(srcState);
        if (!srcRect) return DD_OK;

        // Propagate palette metadata for indexed blits.
        // D3D7-era engines often blit 8-bit lightmap data into transient textures and
        // expect destination texture to resolve indices with the same palette as source.
        if (srcState.format.bpp === 8 && dstState.format.bpp === 8 && srcState.paletteHandle !== undefined) {
            dstState.paletteHandle = srcState.paletteHandle;
            dstState.rgbaScratch = undefined;
            if (isRenderSurface(dstState)) {
                dstState.rgbaScratchVersion = undefined;
            }
            if (isBitmapTexture(dstState)) {
                dstState.rgbaScratchWithColorKey = undefined;
            }
        }

        // Use the destination rect as-is - don't override position!
        // The game specifies where to draw (e.g., cursor at {358,1,378,25}).
        // Clipping to surface bounds is handled by clampRectsForBlt below.
        const effectiveDstRect = dstRect;

        const clamped = clampRectsForBlt(srcState, dstState, srcRect, effectiveDstRect);
        if (!clamped) return DD_OK;

        const { src: effSrcRect, dst: effDstRect, width: w, height: h } = clamped;

        // Check if colorkey blitting is requested (supports KEYOVERRIDE)
        let colorKeyOverride: { low: number; high: number } | undefined;
        if ((dwFlags & DDBLT_KEYSRCOVERRIDE) && lpDDBltFx && isValidAddress(mem, lpDDBltFx, DDBLTFX_SIZE)) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const low = view.getUint32(lpDDBltFx + DDBLTFX_OFFSETS.ddckSrcColorkey, true);
            const high = view.getUint32(lpDDBltFx + DDBLTFX_OFFSETS.ddckSrcColorkey + 4, true);
            colorKeyOverride = { low, high };
        }
        const colorKey = colorKeyOverride ?? (((dwFlags & DDBLT_KEYSRC) && srcState.srcColorKey) ? srcState.srcColorKey : undefined);
        const useColorKey = !!colorKey;

        if (useColorKey && colorKey) {
            Logger.verbose(LogCategory.DDRAW,
                `IDirectDrawSurface7_Blt: COLORKEY enabled! src=0x${srcState.surfacePtr.toString(16)} ` +
                `colorkey=0x${colorKey.low.toString(16)}-0x${colorKey.high.toString(16)}${colorKeyOverride ? " (override)" : ""}`);
        }

        let rop3: number | undefined;
        if (dwFlags & DDBLT_ROP) {
            if (lpDDBltFx && isValidAddress(mem, lpDDBltFx, DDBLTFX_SIZE)) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const dwRop = view.getUint32(lpDDBltFx + DDBLTFX_OFFSETS.rop, true);
                rop3 = (dwRop >>> 16) & 0xff;
                Logger.log(LogCategory.DDRAW, `IDirectDrawSurface7_Blt: ROP3=0x${rop3.toString(16)} (dwROP=0x${dwRop.toString(16)})`);
            } else {
                rop3 = 0xcc; // Default to SRCCOPY if missing DDBLTFX
                Logger.warn(LogCategory.DDRAW, `IDirectDrawSurface7_Blt: DDBLT_ROP set but DDBLTFX missing/invalid; defaulting to SRCCOPY`);
            }
        }

        // Stretch detection: GPU copyTextureToTexture can't scale, CPU path uses nearest-neighbor
        const srcWidth = srcRect.right - srcRect.left;
        const srcHeight = srcRect.bottom - srcRect.top;
        const dstWidth = effectiveDstRect.right - effectiveDstRect.left;
        const dstHeight = effectiveDstRect.bottom - effectiveDstRect.top;
        const isStretch = srcWidth !== dstWidth || srcHeight !== dstHeight;
        if (isStretch) {
            Logger.verbose(LogCategory.DDRAW,
                `Blt STRETCH: src=${srcWidth}x${srcHeight} → dst=${dstWidth}x${dstHeight} (CPU nearest-neighbor)`
            );
        }

        // ---- LAZY GPU PROMOTION & RE-SYNC ----
        // If destination has GPU texture but source doesn't, promote source on-demand.
        // This enables GPU fast path for video playback and sprite blitting without
        // changing CreateSurface logic (safe for other games).
        // Use destination's format for copy compatibility (copyTextureToTexture requires same format).
        if (context.backend && dstState.gpuTexture && !srcState.gpuTexture && w > 0 && h > 0) {
            profiler.start("Blt:lazyPromotion");
            const targetFormat = resolveSurfaceTextureFormat(dstState);
            ensureGpuTextureForBlt(srcState, context, mem, targetFormat);
            profiler.end("Blt:lazyPromotion");
        }

        // Deferred Upload: Mark source as dirty if needs GPU upload.
        // Actual upload is deferred to Present/Flip for batching (50% faster).
        // Exception: GPU fast path needs immediate upload for source (handled below).
        const needsResync = srcState.gpuTexture && context.backend && (
            (isBitmapTexture(srcState) && srcState.gpuNeedsUpload) ||
            (isRenderSurface(srcState) && srcState.gpuDirty)
        );

        if (needsResync) {
            // Just mark dirty - upload will happen later in batch
            context.deferredUploadManager.markDirty(srcState);
            Logger.verbose(LogCategory.DDRAW,
                `Blt: Deferring upload for src=0x${srcState.surfacePtr.toString(16)} until present`);
        }
        // ----------------------------

        // CPU-First: Deterministic GPU fast path decision
        const srcMode = isRenderSurface(srcState) ? srcState.mode : "bitmap";
        const dstMode = isRenderSurface(dstState) ? dstState.mode : "bitmap";
        const shouldUseGpu = canUseGpuFastPath(srcState, dstState, useColorKey, isStretch);
        const hasBackend = !!(context.backend && w > 0 && h > 0);
        const noRop = rop3 === undefined;
        const willUseGpu = shouldUseGpu && hasBackend && noRop;

        Logger.verbose(LogCategory.DDRAW,
            `IDirectDrawSurface7_Blt: src=0x${srcState.surfacePtr.toString(16)}(mode=${srcMode}) ` +
            `dst=0x${dstState.surfacePtr.toString(16)}(mode=${dstMode}) ` +
            `srcRect=(${effSrcRect.left},${effSrcRect.top},${effSrcRect.right},${effSrcRect.bottom}) ` +
            `dstRect=(${effDstRect.left},${effDstRect.top},${effDstRect.right},${effDstRect.bottom}) ` +
            `canUseGpuFastPath=${shouldUseGpu} willUseGpu=${willUseGpu} useColorKey=${useColorKey} isStretch=${isStretch}`);

        // Helper: present to primary (if needed), cleanup rects, return DD_OK.
        // PERF: Returns number directly when no present needed (common case).
        const finishBlt = (): number | Promise<number> => {
            if (context.surfaces.primary && thisPtr === context.surfaces.primary) {
                // Blt to primary triggers present for games without explicit Flip.
                // Non-blocking: yield at most once per rAF cycle. Without this, games that
                // do many Blts per visual frame (background + sprites + text) would stall
                // 16ms on EACH Blt, and the spin loop would inflate virtual time N× too fast.
                return framePacer.waitForFrameSlot({ nonBlocking: true }).then(() => {
                    profiler.start("Blt:present");
                    if (!context.suppressPresent) {
                        void context.presenter.present(dstState, mem, { throttle: true });
                    }
                    profiler.end("Blt:present");
                    rectPool.release(effSrcRect);
                    rectPool.release(effDstRect);
                    return DD_OK;
                });
            }
            rectPool.release(effSrcRect);
            rectPool.release(effDstRect);
            return DD_OK;
        };

        // Helper: execute the CPU blit operation (after any readbacks complete)
        const doCpuBlit = (): void => {
            // Lease guard: CPU blit writes dst pixel memory. Skip while the
            // guest holds a writable Lock lease on the destination surface.
            if (surfaceHasActiveWriteLease(dstState)) {
                Logger.warn(LogCategory.DDRAW,
                    `IDirectDrawSurface7_Blt: SKIP CPU blit - dst 0x${dstState.surfacePtr.toString(16)} is locked for writing (active write lease)`);
                recordSurfaceOp("blt", "skip:lease", dstState, srcState, effDstRect, effSrcRect, colorKey);
                profiler.end("Blt:cpuPath");
                return;
            }
            const srcModeStr = isRenderSurface(srcState) ? srcState.mode : "bitmap";
            const dstModeStr = isRenderSurface(dstState) ? dstState.mode : "bitmap";
            Logger.verbose(LogCategory.DDRAW,
                `IDirectDrawSurface7_Blt: Using CPU DEFAULT PATH (src mode=${srcModeStr} dst mode=${dstModeStr} ` +
                `useColorKey=${useColorKey} isStretch=${isStretch})`);

            if (copyCompressedSurfaceRegion(mem, srcState, dstState, effSrcRect, effDstRect,
                                            useColorKey ? colorKey : undefined)) {
                // Block-compressed source — decompressed on the way in. A ROP against block
                // storage is meaningless, so it is deliberately not honoured here.
            } else if (rop3 !== undefined) {
                copySurfaceRegionWithRop(mem, srcState, dstState, effSrcRect, effDstRect, rop3);
            } else if (useColorKey && colorKey) {
                copySurfaceRegionWithColorKey(mem, srcState, dstState, effSrcRect, effDstRect, colorKey);
            } else {
                copySurfaceRegion(mem, srcState, dstState, effSrcRect, effDstRect);
            }

            setAuthorityCpu(dstState);
            unionSurfaceDirtyRegion(dstState, effDstRect);
            (dstState as { surfaceEverWritten?: boolean }).surfaceEverWritten = true;
            recordSurfaceOp("blt",
                rop3 !== undefined ? "cpu:rop" : useColorKey ? "cpu:colorkey" : isStretch ? "cpu:stretch" : "cpu",
                dstState, srcState, effDstRect, effSrcRect, colorKey);
            profiler.end("Blt:cpuPath");
        };

        // Helper: execute the GPU blit after optional upload completes
        const doGpuBlit = (): void => {
            const srcFmt = srcState.gpuTextureFormat;
            const dstFmt = dstState.gpuTextureFormat;
            const formatMismatch = !!(srcFmt && dstFmt && srcFmt !== dstFmt);
            if (useColorKey && colorKey) {
                profiler.start("Blt:gpuPath:colorKeyBlit");
                context.executor!.blitWithColorKey(srcState, dstState, effSrcRect, effDstRect, colorKey);
                context.executor!.flush();
                profiler.end("Blt:gpuPath:colorKeyBlit");
                setAuthorityGpu(dstState);
            } else if (formatMismatch) {
                Logger.warn(LogCategory.DDRAW,
                    `IDirectDrawSurface7_Blt: GPU format mismatch src=${srcFmt} dst=${dstFmt} - using shader copy`);
                profiler.start("Blt:gpuPath:shaderCopy");
                context.executor!.blitWithShaderCopy(srcState, dstState, effSrcRect, effDstRect);
                context.executor!.flush();
                profiler.end("Blt:gpuPath:shaderCopy");
                setAuthorityGpu(dstState);
            } else {
                profiler.start("Blt:gpuPath:copy");
                const device = context.backend!.getDevice()!;
                const encoder = device.createCommandEncoder();
                encoder.copyTextureToTexture(
                    { texture: srcState.gpuTexture!, origin: { x: effSrcRect.left, y: effSrcRect.top, z: 0 } },
                    { texture: dstState.gpuTexture!, origin: { x: effDstRect.left, y: effDstRect.top, z: 0 } },
                    { width: w, height: h, depthOrArrayLayers: 1 }
                );
                context.backend!.getQueue()?.submit([encoder.finish()]);
                profiler.end("Blt:gpuPath:copy");
                setAuthorityGpu(dstState);
            }
            recordSurfaceOp("blt",
                useColorKey ? "gpu:colorkey" : formatMismatch ? "gpu:shadercopy" : "gpu",
                dstState, srcState, effDstRect, effSrcRect, colorKey);
        };

        if (willUseGpu) {
            profiler.start("Blt:gpuPath");
            Logger.verbose(LogCategory.DDRAW, `IDirectDrawSurface7_Blt: Using GPU FAST PATH`);
            if (context.executor) {
                profiler.start("Blt:gpuPath:flush");
                context.executor.flush();
                profiler.end("Blt:gpuPath:flush");
            }
            const backend = context.backend!;
            const device = backend.getDevice();
            if (device && context.executor) {
                // GPU fast path needs immediate upload for source if dirty
                // (Blt chain case: A→B→C where B is dirty and used immediately)
                if (needsResync) {
                    const queue = backend.getQueue();
                    if (queue) {
                        // Async path: upload then continue GPU blit
                        profiler.start("Blt:gpuPath:immediateUpload");
                        return context.deferredUploadManager.uploadImmediate(srcState, queue, mem).then(() => {
                            Logger.verbose(LogCategory.DDRAW,
                                `Blt GPU path: Forced immediate upload for src=0x${srcState.surfacePtr.toString(16)}`);
                            profiler.end("Blt:gpuPath:immediateUpload");
                            doGpuBlit();
                            profiler.end("Blt:gpuPath");
                            return finishBlt();
                        });
                    }
                }

                // Sync GPU blit (no upload needed — common case)
                doGpuBlit();
            } else if (surfaceHasActiveWriteLease(dstState)) {
                // Lease guard: CPU fallback writes dst pixels — skip while locked.
                Logger.warn(LogCategory.DDRAW,
                    `IDirectDrawSurface7_Blt: SKIP CPU fallback - dst 0x${dstState.surfacePtr.toString(16)} is locked for writing (active write lease)`);
                recordSurfaceOp("blt", "skip:lease", dstState, srcState, effDstRect, effSrcRect, colorKey);
            } else {
                if (useColorKey && colorKey) {
                    copySurfaceRegionWithColorKey(mem, srcState, dstState, effSrcRect, effDstRect, colorKey);
                } else {
                    copySurfaceRegion(mem, srcState, dstState, effSrcRect, effDstRect);
                }
                setAuthorityCpu(dstState);
                unionSurfaceDirtyRegion(dstState, effDstRect);
                (dstState as { surfaceEverWritten?: boolean }).surfaceEverWritten = true;
                recordSurfaceOp("blt", "cpu:nogpu", dstState, srcState, effDstRect, effSrcRect, colorKey);
            }
            profiler.end("Blt:gpuPath");
        } else if (isStretch && hasBackend && noRop && !useColorKey && context.executor) {
            // GPU stretch path: render pass with viewport-based scaling
            profiler.start("Blt:gpuStretch");
            Logger.verbose(LogCategory.DDRAW,
                `IDirectDrawSurface7_Blt: Using GPU STRETCH PATH ` +
                `src=${srcWidth}x${srcHeight} → dst=${dstWidth}x${dstHeight}`);

            // Ensure source has GPU texture (lazy promotion if needed)
            if (!srcState.gpuTexture) {
                const targetFormat = resolveSurfaceTextureFormat(dstState);
                ensureGpuTextureForBlt(srcState, context, mem, targetFormat);
            }

            if (srcState.gpuTexture) {
                context.executor.blitWithShaderCopy(srcState, dstState, effSrcRect, effDstRect);
                context.executor.flush();
                setAuthorityGpu(dstState);
                recordSurfaceOp("blt", "gpu:stretch", dstState, srcState, effDstRect, effSrcRect, colorKey);
            } else if (surfaceHasActiveWriteLease(dstState)) {
                // Lease guard: CPU nearest-neighbor writes dst pixels — skip while locked.
                Logger.warn(LogCategory.DDRAW,
                    `IDirectDrawSurface7_Blt: SKIP CPU stretch fallback - dst 0x${dstState.surfacePtr.toString(16)} is locked for writing (active write lease)`);
                recordSurfaceOp("blt", "skip:lease", dstState, srcState, effDstRect, effSrcRect, colorKey);
            } else {
                // Fallback to CPU nearest-neighbor if GPU promotion failed
                copySurfaceRegion(mem, srcState, dstState, effSrcRect, effDstRect);
                setAuthorityCpu(dstState);
                unionSurfaceDirtyRegion(dstState, effDstRect);
                recordSurfaceOp("blt", "cpu:stretch", dstState, srcState, effDstRect, effSrcRect, colorKey);
            }
            (dstState as { surfaceEverWritten?: boolean }).surfaceEverWritten = true;
            profiler.end("Blt:gpuStretch");
        } else if (hasBackend && noRop && context.executor && srcState.gpuTexture &&
                   isRenderSurface(dstState) && dstState.mode === "GPU_ONLY" && dstState.gpuTexture) {
            // Mixed-mode GPU path: source is CPU-mode (or bitmap) with a GPU texture,
            // destination is GPU_ONLY (D3D render target). CPU blit would write to memory
            // but the GPU texture (which is what gets rendered) would never receive the data.
            // Use blitWithShaderCopy which handles CPU→GPU sync and format conversion.
            profiler.start("Blt:mixedGpuPath");
            Logger.log(LogCategory.DDRAW,
                `IDirectDrawSurface7_Blt: Using MIXED GPU PATH ` +
                `(src=0x${srcState.surfacePtr.toString(16)} mode=CPU → dst=0x${dstState.surfacePtr.toString(16)} mode=GPU_ONLY)`);

            // Force immediate upload of source if needed (deferred upload won't be ready)
            if (surfaceSyncManager.needsGPUSync(srcState).needed) {
                const queue = context.backend!.getQueue();
                if (queue) {
                    profiler.start("Blt:mixedGpuPath:upload");
                    return context.deferredUploadManager.uploadImmediate(srcState, queue, mem).then(() => {
                        profiler.end("Blt:mixedGpuPath:upload");
                        if (useColorKey && colorKey) {
                            context.executor!.blitWithColorKey(srcState, dstState, effSrcRect, effDstRect, colorKey);
                        } else {
                            context.executor!.blitWithShaderCopy(srcState, dstState, effSrcRect, effDstRect);
                        }
                        context.executor!.flush();
                        setAuthorityGpu(dstState);
                        recordSurfaceOp("blt", useColorKey ? "gpu:mixed:colorkey" : "gpu:mixed", dstState, srcState, effDstRect, effSrcRect, colorKey);
                        profiler.end("Blt:mixedGpuPath");
                        return finishBlt();
                    });
                }
            }

            // Source already synced — blit directly
            if (useColorKey && colorKey) {
                context.executor.blitWithColorKey(srcState, dstState, effSrcRect, effDstRect, colorKey);
            } else {
                context.executor.blitWithShaderCopy(srcState, dstState, effSrcRect, effDstRect);
            }
            context.executor.flush();
            setAuthorityGpu(dstState);
            recordSurfaceOp("blt", useColorKey ? "gpu:mixed:colorkey" : "gpu:mixed", dstState, srcState, effDstRect, effSrcRect, colorKey);
            profiler.end("Blt:mixedGpuPath");
        } else {
            profiler.start("Blt:cpuPath");
            if (context.executor) {
                let needSrcReadback = surfaceSyncManager.needsCPUSync(srcState).needed;
                const isPartial = (effDstRect.left > 0 || effDstRect.top > 0 ||
                    effDstRect.right < dstState.width || effDstRect.bottom < dstState.height);
                let needDstReadback = isPartial && surfaceSyncManager.needsCPUSync(dstState).needed;

                if (needSrcReadback && context.executor.syncSurfaceToMemoryFromScratch(srcState, mem)) {
                    needSrcReadback = false;
                }
                if (needDstReadback && context.executor.syncSurfaceToMemoryFromScratch(dstState, mem)) {
                    needDstReadback = false;
                }

                if (needSrcReadback || needDstReadback) {
                    const ss: any = srcState, ds: any = dstState;
                    Logger.log(LogCategory.DDRAW,
                        `READBACK-DIAG Blt-readback srcRB=${needSrcReadback} dstRB=${needDstReadback} ` +
                        `src=0x${ss.surfacePtr.toString(16)}(${ss.width}x${ss.height} caps=0x${ss.caps.toString(16)} mode=${ss.mode} gpuTex=${!!ss.gpuTexture}) ` +
                        `dst=0x${ds.surfacePtr.toString(16)}(${ds.width}x${ds.height} caps=0x${ds.caps.toString(16)} mode=${ds.mode} gpuTex=${!!ds.gpuTexture} everLocked=${ds.everLocked})`);
                    // Async path: GPU→CPU readback needed before CPU blit
                    const readbackSrc = needSrcReadback
                        ? (Logger.verbose(LogCategory.DDRAW,
                            `IDirectDrawSurface7_Blt: CPU path requires GPU→CPU readback for src=0x${srcState.surfacePtr.toString(16)}`),
                            context.executor.syncSurfaceToMemory(srcState))
                        : Promise.resolve();
                    return readbackSrc.then(() => {
                        if (needDstReadback) {
                            Logger.verbose(LogCategory.DDRAW,
                                `IDirectDrawSurface7_Blt: Partial CPU blt requires GPU→CPU readback for dst=0x${dstState.surfacePtr.toString(16)}`);
                            return context.executor!.syncSurfaceToMemory(dstState);
                        }
                    }).then(() => {
                        doCpuBlit();
                        return finishBlt();
                    });
                }
            }

            // Sync CPU path (common case: SYSMEM surfaces, no GPU readback)
            doCpuBlit();
        }

        return finishBlt();
    };

    // PERF: Sync-by-default — only returns Promise when GPU readback or present is needed.
    exports["IDirectDrawSurface7_BltFast"] = (ctx, mem, args): number | Promise<number> => {
        const thisPtr = args[0];
        const dwX = args[1];
        const dwY = args[2];
        const lpSrcSurface = args[3];
        const lpSrcRect = args[4];
        const dwTrans = args[5] >>> 0;

        const dstObj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!dstObj) return E_FAIL;
        const dstState = dstObj.getState();

        const srcObj = context.resourceProvider.getComObjectByAddress(lpSrcSurface) as DirectDrawSurfaceObject | null;
        if (!srcObj) return E_FAIL;

        const srcState = srcObj.getState();
        const srcRect = lpSrcRect ? readRect(mem, lpSrcRect) : buildFullRect(srcState);
        if (!srcRect) return DD_OK;

        const dstRect = {
            left: dwX,
            top: dwY,
            right: dwX + (srcRect.right - srcRect.left),
            bottom: dwY + (srcRect.bottom - srcRect.top),
        };

        const useColorKey =
            (dwTrans & DDBLTFAST_SRCCOLORKEY) !== 0 &&
            !!srcState.srcColorKey;

        const srcMode = isRenderSurface(srcState) ? srcState.mode : "bitmap";
        const dstMode = isRenderSurface(dstState) ? dstState.mode : "bitmap";
        Logger.log(LogCategory.DDRAW,
            `IDirectDrawSurface7_BltFast: src=0x${srcState.surfacePtr.toString(16)}(mode=${srcMode}) ` +
            `dst=0x${dstState.surfacePtr.toString(16)}(mode=${dstMode}) ` +
            `srcRect=(${srcRect.left},${srcRect.top},${srcRect.right},${srcRect.bottom}) ` +
            `dstPos=(${dwX},${dwY}) useColorKey=${useColorKey} dwTrans=0x${dwTrans.toString(16)}`);

        // Helper: perform the CPU copy, present if primary, return DD_OK
        const doBltFast = (): number | Promise<number> => {
            // Lease guard: BltFast writes dst pixel memory. Skip while the
            // guest holds a writable Lock lease on the destination surface.
            if (surfaceHasActiveWriteLease(dstState)) {
                Logger.warn(LogCategory.DDRAW,
                    `IDirectDrawSurface7_BltFast: SKIP - dst 0x${dstState.surfacePtr.toString(16)} is locked for writing (active write lease)`);
                recordSurfaceOp("bltfast", "skip:lease", dstState, srcState, dstRect, srcRect, srcState.srcColorKey);
                return DD_OK;
            }
            if (useColorKey && srcState.srcColorKey) {
                copySurfaceRegionWithColorKey(mem, srcState, dstState, srcRect, dstRect, srcState.srcColorKey);
            } else {
                copySurfaceRegion(mem, srcState, dstState, srcRect, dstRect);
            }
            setAuthorityCpu(dstState);
            unionSurfaceDirtyRegion(dstState, dstRect);
            (dstState as { surfaceEverWritten?: boolean }).surfaceEverWritten = true;
            recordSurfaceOp("bltfast", useColorKey ? "cpu:colorkey" : "cpu", dstState, srcState, dstRect, srcRect, useColorKey ? srcState.srcColorKey : undefined);

            // BltFast to primary triggers present (same as Blt to primary).
            // Many 2D games use BltFast exclusively for rendering.
            // Non-blocking: yield at most once per rAF cycle (see Blt comment above).
            if (context.surfaces.primary && thisPtr === context.surfaces.primary) {
                return framePacer.waitForFrameSlot({ nonBlocking: true }).then(() => {
                    if (!context.suppressPresent) {
                        void context.presenter.present(dstState, mem, { throttle: true });
                    }
                    return DD_OK;
                });
            }
            return DD_OK;
        };

        // Readback GPU-authoritative data before CPU copy to prevent stale pixels
        if (context.executor) {
            let needSrcReadback = surfaceSyncManager.needsCPUSync(srcState).needed;
            const isPartial = (dstRect.left > 0 || dstRect.top > 0 ||
                dstRect.right < dstState.width || dstRect.bottom < dstState.height);
            let needDstReadback = isPartial && surfaceSyncManager.needsCPUSync(dstState).needed;

            if (needSrcReadback && context.executor.syncSurfaceToMemoryFromScratch(srcState, mem)) {
                needSrcReadback = false;
            }
            if (needDstReadback && context.executor.syncSurfaceToMemoryFromScratch(dstState, mem)) {
                needDstReadback = false;
            }

            if (needSrcReadback || needDstReadback) {
                // Async path: GPU→CPU readback needed
                const readbackSrc = needSrcReadback
                    ? context.executor.syncSurfaceToMemory(srcState)
                    : Promise.resolve();
                return readbackSrc.then(() => {
                    if (needDstReadback) {
                        Logger.log(LogCategory.DDRAW,
                            `IDirectDrawSurface7_BltFast: Partial CPU blt requires GPU→CPU readback for dst=0x${dstState.surfacePtr.toString(16)}`);
                        return context.executor!.syncSurfaceToMemory(dstState);
                    }
                }).then(() => doBltFast());
            }
        }

        // Sync fast path (common case: SYSMEM surfaces, no GPU readback)
        return doBltFast();
    };

    return exports;
}
