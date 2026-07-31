/**
 * IDirect3DTexture and IDirect3DTexture2 implementations
 */
import { Logger, LogCategory, LogLevel } from "../../../core/logger";
import { System } from "../../../core/system";
import { DDrawContext } from "../context";
import { bytesToGuid } from "../helpers";
import { isValidAddress } from "../../../core/memory/address-guard";
import {
    DirectDrawSurfaceObject,
    Direct3DTextureObject,
    Direct3DTexture2Object,
    isRenderSurface,
    isBitmapTexture,
} from "../com-objects";
import { DDSCAPS_SYSTEMMEMORY, DDSCAPS_ALLOCONLOAD } from "../constants";
import { setAuthorityCpu, setAuthorityGpu, invalidateCpuSyncedVersion, syncActiveGdiContext, surfaceSyncManager } from "../surface-sync";
import { propagateSurfaceStateToRegistry } from "./texture-manager";
import { D3DExports, D3D_OK, D3DERR_INVALIDCALL, TextureManager } from "./types";

const DDERR_UNSUPPORTED = 0x80004001; // ddraw.h: DDERR_UNSUPPORTED == E_NOTIMPL
import { convertRGBAToSurface } from "../gpu-texture-utils";
import {
    decodeSurfaceFormatToRgba8,
    getSurfaceFormatLayout,
} from "../../../backends/webgpu/shared/texture-formats";

export const createTextureExports = (
    context: DDrawContext,
    textureManager: TextureManager
): D3DExports => {
    const exports: D3DExports = {};
    const resourceProvider = context.resourceProvider;

    // PERF: Sync-by-default — returns void when no GPU readback is needed (D2's common case).
    // Only returns Promise when GPU→CPU readback is required, avoiding ~500-700us async overhead per call.
    const copyTexture2Data = (
        srcSurf: DirectDrawSurfaceObject,
        dstSurf: DirectDrawSurfaceObject,
        mem: Uint8Array,
        _threadId: number,
        tag: string
    ): void | Promise<void> => {
        const srcState = srcSurf.getState();
        const dstState = dstSurf.getState();
        const system = System.getInstance();
        const gdiContext = system.gdiContext;

        // 1. Sync GDI if needed
        const hdc = gdiContext.getHDCBySurface(srcState.surfacePtr);
        if (hdc && gdiContext.isDirty(hdc)) {
            syncActiveGdiContext(srcState, srcState.surfacePtr, mem);
            gdiContext.clearDirty(hdc);
        }

        // OPTIMIZATION: Generation-based Load deduplication — skip pixel copy if source unchanged.
        // Works for ALL surface types including SYSMEM (D2's texture surfaces).
        // writeGeneration is bumped on every non-readonly Unlock, so this catches actual content changes.
        {
            const srcGen = srcState.writeGeneration;
            const srcPtr = srcState.surfacePtr;
            if (dstState.lastLoadSourceGeneration !== undefined &&
                dstState.lastLoadSourcePtr === srcPtr &&
                dstState.lastLoadSourceGeneration === srcGen) {
                return; // Early exit - no copy needed
            }
        }

        // Helper: pixel copy + finalization + mipmap recursion (all sync except mipmap may return Promise)
        const doCopyAndFinalize = (): void | Promise<void> => {
            let formatMismatch = srcState.format.bpp !== dstState.format.bpp ||
                srcState.format.rMask !== dstState.format.rMask ||
                srcState.format.gMask !== dstState.format.gMask ||
                srcState.format.bMask !== dstState.format.bMask ||
                srcState.format.aMask !== dstState.format.aMask;

            // D3D6 ALLOCONLOAD semantics: a DDSCAPS_ALLOCONLOAD texture has no storage of
            // its own until Texture::Load — the load allocates it with the SOURCE's
            // attributes, including pixel format. Games create the VIDMEM dest with no
            // DDSD_PIXELFORMAT (it transiently inherits the display format) and an
            // explicit-format SYSMEM source (e.g. an inverted-alpha ARGB4444 font atlas);
            // converting to the inherited format would silently drop the alpha channel.
            // Adopt the source format and copy bits raw. Real DDraw clears the flag on
            // the first Load.
            if (formatMismatch && (dstState.caps & DDSCAPS_ALLOCONLOAD) !== 0) {
                if (srcState.format.bpp === dstState.format.bpp) {
                    Logger.log(LogCategory.DDRAW,
                        `Texture Load${tag}: ALLOCONLOAD dest 0x${dstState.surfacePtr.toString(16)} adopts source format ` +
                        `(bpp=${srcState.format.bpp} A=0x${srcState.format.aMask.toString(16)} R=0x${srcState.format.rMask.toString(16)} ` +
                        `G=0x${srcState.format.gMask.toString(16)} B=0x${srcState.format.bMask.toString(16)}; ` +
                        `was A=0x${dstState.format.aMask.toString(16)} R=0x${dstState.format.rMask.toString(16)})`);
                    dstState.format = { ...srcState.format };
                    formatMismatch = false;
                } else {
                    Logger.warn(LogCategory.DDRAW,
                        `Texture Load${tag}: ALLOCONLOAD dest 0x${dstState.surfacePtr.toString(16)} bpp mismatch ` +
                        `(src=${srcState.format.bpp} dst=${dstState.format.bpp}) — falling back to format conversion`);
                }
            }
            dstState.caps &= ~DDSCAPS_ALLOCONLOAD;

            const height = Math.min(srcState.height, dstState.height);
            const width = Math.min(srcState.width, dstState.width);

            if (formatMismatch) {
                // Use format converter for mismatched formats
                // 1. If source is BitmapTextureSurface with rgbaScratch, use it directly
                if (srcState.rgbaScratch) {
                    const rgbaData = new Uint8ClampedArray(srcState.rgbaScratch);
                    convertRGBAToSurface(
                        rgbaData,
                        mem,
                        dstState.surfacePtr,
                        width,
                        height,
                        dstState.pitch,
                        dstState.format
                    );
                } else {
                    // 2. Otherwise, convert src → RGBA → dst
                    const layout = getSurfaceFormatLayout(srcState.format, width, height);
                    const rgbaData = decodeSurfaceFormatToRgba8(
                        mem,
                        srcState.surfacePtr,
                        width,
                        height,
                        Math.max(srcState.pitch, layout.pitch),
                        srcState.format,
                        srcState.rgbaScratch, // Reuse scratch buffer
                        undefined, // colorkey - not needed during copy
                        undefined  // palette
                    );
                    convertRGBAToSurface(
                        new Uint8ClampedArray(rgbaData),
                        mem,
                        dstState.surfacePtr,
                        width,
                        height,
                        dstState.pitch,
                        dstState.format
                    );
                }
            } else {
                // Formats match - direct byte copy
                const srcBytesPerPixel = Math.max(1, Math.floor(srcState.format.bpp / 8));
                const dstBytesPerPixel = Math.max(1, Math.floor(dstState.format.bpp / 8));
                const rowBytes = Math.min(
                    width * Math.min(srcBytesPerPixel, dstBytesPerPixel),
                    srcState.pitch,
                    dstState.pitch
                );

                // OPTIMIZATION: Single-copy for aligned surfaces (common case for D2)
                // If pitches match, copy entire surface in one operation instead of row-by-row
                if (srcState.pitch === dstState.pitch && srcState.pitch === rowBytes) {
                    // Fast path: no padding, direct block copy
                    const totalBytes = rowBytes * height;
                    const srcStart = srcState.surfacePtr;
                    const dstStart = dstState.surfacePtr;
                    if (srcStart >= 0 && dstStart >= 0 &&
                        srcStart + totalBytes <= mem.length && dstStart + totalBytes <= mem.length) {
                        mem.set(mem.subarray(srcStart, srcStart + totalBytes), dstStart);
                    }
                } else {
                    // Slow path: row-by-row copy for padded surfaces
                    for (let y = 0; y < height; y++) {
                        const srcOffset = srcState.surfacePtr + y * srcState.pitch;
                        const dstOffset = dstState.surfacePtr + y * dstState.pitch;
                        if (srcOffset >= 0 && dstOffset >= 0 &&
                            srcOffset + rowBytes <= mem.length && dstOffset + rowBytes <= mem.length) {
                            mem.set(mem.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
                        }
                    }
                }
            }

            setAuthorityCpu(dstState);
            dstState.surfaceEverWritten = true;
            dstState.writeGeneration++;

            // Copy color key from source to dest (for transparency)
            if (srcState.srcColorKey) {
                dstState.srcColorKey = {
                    low: srcState.srcColorKey.low,
                    high: srcState.srcColorKey.high
                };
            }
            if (srcState.destColorKey) {
                dstState.destColorKey = {
                    low: srcState.destColorKey.low,
                    high: srcState.destColorKey.high
                };
            }
            if (srcState.format.bpp === 8 && dstState.format.bpp === 8 && srcState.paletteHandle !== undefined) {
                dstState.paletteHandle = srcState.paletteHandle;
            }

            // PERF: Skip rgbaScratch rebuild here — the caller (Load) always calls
            // syncSurfaceFromMemory afterward, which handles GPU upload directly from
            // guest memory via compute shader (faster) or builds RGBA on demand.
            // Building rgbaScratch here was redundant triple-conversion waste.
            // Invalidate stale cache so syncSurfaceFromMemory re-reads from guest memory.
            dstState.rgbaScratch = undefined;
            if (isRenderSurface(dstState)) {
                dstState.rgbaScratchVersion = undefined;
            }
            if (isBitmapTexture(dstState)) {
                dstState.rgbaScratchWithColorKey = undefined;
            }

            // Update generation tracking for Load deduplication
            dstState.lastLoadSourceGeneration = srcState.writeGeneration;
            dstState.lastLoadSourcePtr = srcState.surfacePtr;

            // 3. Handle Mipmaps: Recursively copy attached surfaces if they exist
            if (srcState.attachedSurfaceAddr && dstState.attachedSurfaceAddr) {
                const srcAttached = resourceProvider.getComObjectByAddress(srcState.attachedSurfaceAddr) as DirectDrawSurfaceObject | null;
                const dstAttached = resourceProvider.getComObjectByAddress(dstState.attachedSurfaceAddr) as DirectDrawSurfaceObject | null;

                if (srcAttached && dstAttached) {
                    return copyTexture2Data(srcAttached, dstAttached, mem, _threadId, `${tag}[MIP]`);
                }
            }
        };

        // 2. Sync GPU→CPU if needed (e.g. authority=gpu, CPU doesn't have current version)
        if (surfaceSyncManager.needsCPUSync(srcState).needed && context.executor) {
            if (context.executor.syncSurfaceToMemoryFromScratch(srcState, mem)) {
                return doCopyAndFinalize();
            }
            // Async fallback: GPU readback required — return Promise
            return context.executor.syncSurfaceToMemory(srcState).then(doCopyAndFinalize);
        }

        // Sync fast path (D2's common case: SYSMEM sources, no GPU readback)
        return doCopyAndFinalize();
    };

    // --- IDirect3DTexture ---

    exports["IDirect3DTexture_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = resourceProvider.getComObjectByAddress(thisPtr);

        const iidBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            iidBytes[i] = mem[riidPtr + i];
        }
        const iidStr = bytesToGuid(iidBytes);

        Logger.log(LogCategory.COM, `IDirect3DTexture_QueryInterface: this=0x${thisPtr.toString(16)} iid=${iidStr} ppvObject=0x${ppvObject.toString(16)} obj=${obj ? obj.constructor.name : 'null'}`);

        if (!obj) {
            Logger.warn(LogCategory.COM, `IDirect3DTexture_QueryInterface: Object not found for thisPtr=0x${thisPtr.toString(16)}`);
            return 0x80004002;
        }

        const result = obj.queryInterface(iidStr, ppvObject, mem);
        if (ppvObject) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const returnedAddr = view.getUint32(ppvObject, true);
            Logger.log(LogCategory.COM, `IDirect3DTexture_QueryInterface: result=0x${result.toString(16)} returnedAddr=0x${returnedAddr.toString(16)}`);
        }
        return result;
    };

    exports["IDirect3DTexture_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirect3DTexture_Initialize"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const surface = args[2];
        Logger.log(LogCategory.SYSTEM, `IDirect3DTexture_Initialize: this=0x${thisPtr.toString(16)} surface=0x${surface.toString(16)}`);
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DTextureObject | null;
        if (obj && surface) {
            const surfaceObj = resourceProvider.getComObjectByAddress(surface) as DirectDrawSurfaceObject | null;
            if (surfaceObj) {
                obj.setSurfaceHandle(surfaceObj.handle);
                surfaceObj.addRef();
                Logger.verbose(LogCategory.COM, `IDirect3DTexture_Initialize: Linked texture to SurfaceObject (handle=0x${surfaceObj.handle.toString(16)}, refcount increased)`);
            }
        }
        return D3D_OK;
    };

    exports["IDirect3DTexture_GetHandle"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const devicePtr = args[1];
        const lpHandle = args[2];
        if (!lpHandle || !isValidAddress(mem, lpHandle, 4)) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DTextureObject | null;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        if (!obj) {
            view.setUint32(lpHandle, 0, true);
            Logger.warn(LogCategory.DDRAW, `IDirect3DTexture_GetHandle: Texture object not found for 0x${thisPtr.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        const surfaceAddr = obj.getSurfaceAddr();
        const surfaceObj = resourceProvider.getComObjectByAddress(surfaceAddr) as DirectDrawSurfaceObject | null;

        if (!surfaceObj) {
            view.setUint32(lpHandle, 0, true);
            Logger.warn(LogCategory.DDRAW, `IDirect3DTexture_GetHandle: Surface object not found for 0x${surfaceAddr.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        const state = surfaceObj.getState();
        const handle = surfaceObj.handle;

        // See IDirect3DTexture2_GetHandle: reuse only if the registry entry refers to
        // THIS surface's GPU texture — handle numbers are recycled after Release and
        // can collide with persisted entries of dead surfaces.
        const existingEntry = context.textureHandles.get(handle);
        if (existingEntry) {
            if (state.gpuTexture && existingEntry.gpuTexture === state.gpuTexture) {
                view.setUint32(lpHandle, handle, true);
                Logger.log(LogCategory.DDRAW, `IDirect3DTexture_GetHandle: Reusing existing handle=0x${handle.toString(16)} (surface.handle) for texture 0x${thisPtr.toString(16)}`);
                return D3D_OK;
            }
            context.textureHandles.delete(handle);
            Logger.log(LogCategory.DDRAW, `IDirect3DTexture_GetHandle: handle=0x${handle.toString(16)} had STALE registry entry (recycled handle from a released surface) - re-registering for texture 0x${thisPtr.toString(16)}`);
        }

        // Always return surface.handle for identity, even if GPU texture doesn't exist yet.
        // Games may call GetHandle() once, store the result, and always pass it to SetTexture.
        // If we return surfaceAddr on first call and surface.handle later, the game will send the wrong value.
        // Register texture handle entry if GPU texture exists (for persistence), but always return handle.
        if (state.gpuTexture && state.gpuTextureView) {
            textureManager.registerPersistent(surfaceObj);
            view.setUint32(lpHandle, handle, true);
            Logger.log(LogCategory.DDRAW, `IDirect3DTexture_GetHandle: Created NEW handle=0x${handle.toString(16)} (surface.handle) for texture 0x${thisPtr.toString(16)} (${state.width}x${state.height})`);
            Logger.log(LogCategory.SYSTEM, `IDirect3DTexture_GetHandle: Created NEW handle=0x${handle.toString(16)} (surface.handle) for texture 0x${thisPtr.toString(16)} (${state.width}x${state.height})`);
            return D3D_OK;
        }

        view.setUint32(lpHandle, handle, true);
        Logger.verbose(LogCategory.DDRAW, `IDirect3DTexture_GetHandle: NO GPU TEXTURE YET for surface 0x${surfaceAddr.toString(16)} (will be created lazily on bind)`);
        return D3D_OK;
    };

    exports["IDirect3DTexture_PaletteChanged"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        Logger.log(LogCategory.DDRAW, `IDirect3DTexture_PaletteChanged: this=0x${thisPtr.toString(16)}`);
        
        // Invalidate texture when palette changes (for P8/L8 formats)
        // Palette change means texture colors will be different even if pixel data is same
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DTextureObject | null;
        if (obj) {
            const surfaceAddr = obj.getSurfaceAddr();
            const surfaceObj = resourceProvider.getComObjectByAddress(surfaceAddr) as DirectDrawSurfaceObject | null;
            if (surfaceObj) {
                const state = surfaceObj.getState();
                // Force re-upload with new palette on next bind
                setAuthorityCpu(state);
                Logger.log(LogCategory.DDRAW,
                    `IDirect3DTexture_PaletteChanged: Marked surface 0x${surfaceAddr.toString(16)} authority=cpu for palette update`
                );
            }
        }
        
        return D3D_OK;
    };

    // PERF: Sync-by-default — only returns Promise when GPU readback is needed.
    exports["IDirect3DTexture_Load"] = (ctx, mem, args): number | Promise<number> => {
        const thisPtr = args[0];
        const srcTexture = args[1];

        const srcSurf = textureManager.resolveToSurface(srcTexture);
        const dstSurf = textureManager.resolveToSurface(thisPtr);

        if (Logger.isEnabled(LogCategory.DDRAW, LogLevel.NORMAL)) {
            Logger.log(LogCategory.DDRAW, 
                `IDirect3DTexture_Load: this=0x${thisPtr.toString(16)} srcTexture=0x${srcTexture.toString(16)} ` +
                `srcSurf=${!!srcSurf} dstSurf=${!!dstSurf}`);
        }

        if (!srcSurf || !dstSurf) {
            Logger.log(LogCategory.DDRAW, `IDirect3DTexture_Load: this=0x${thisPtr.toString(16)} srcTexture=0x${srcTexture.toString(16)} - missing surfaces`);
            return D3DERR_INVALIDCALL;
        }

        const srcState = srcSurf.getState();
        const dstState = dstSurf.getState();

        // Always propagate colorkey state to destination, regardless of GPU/CPU load path.
        // Some DX4 games set colorkey on SYS surface then Load() into a GPU texture.
        if (srcState.srcColorKey) {
            dstState.srcColorKey = {
                low: srcState.srcColorKey.low,
                high: srcState.srcColorKey.high
            };
        }
        if (srcState.destColorKey) {
            dstState.destColorKey = {
                low: srcState.destColorKey.low,
                high: srcState.destColorKey.high
            };
        }
        if (srcState.format.bpp === 8 && dstState.format.bpp === 8 && srcState.paletteHandle !== undefined) {
            dstState.paletteHandle = srcState.paletteHandle;
        }

        // NOTE: Fingerprint-based Load() cache REMOVED — sampling 8 positions across the texture
        // missed real changes when games (D2) reuse SYSMEM surfaces with different data between
        // Load() calls, causing "textures swap to foreign ones" artifacts.

        const markDirtyAndFinish = (): number => {
            // Mark destination as dirty so GPU upload will happen.
            if (isRenderSurface(dstState)) {
                dstState.gpuDirty = true;
            } else if (isBitmapTexture(dstState)) {
                dstState.gpuNeedsUpload = true;
            }

            // OPTIMIZATION: Defer GPU upload to Present/Flip instead of immediate sync
            if (context.deferredUploadManager && dstState.surfacePtr) {
                context.deferredUploadManager.markDirty(dstState, false);
            }

            return D3D_OK;
        };

        // copyTexture2Data returns void (sync) or Promise<void> (async readback needed)
        const result = copyTexture2Data(srcSurf, dstSurf, mem, 0, "");
        if (result instanceof Promise) {
            return result.then((): number => markDirtyAndFinish());
        }
        return markDirtyAndFinish();
    };

    // Slot 7 of IDirect3DTexture — the DX5 SDK documents it as never implemented, and the
    // retail driver returns DDERR_UNSUPPORTED. Games call it when tearing textures down for a
    // mode change, so the slot must exist even though it does nothing.
    exports["IDirect3DTexture_Unload"] = () => DDERR_UNSUPPORTED;

    // --- IDirect3DTexture2 ---

    exports["IDirect3DTexture2_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = resourceProvider.getComObjectByAddress(thisPtr);

        const iidBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            iidBytes[i] = mem[riidPtr + i];
        }
        const iidStr = bytesToGuid(iidBytes);

        Logger.log(LogCategory.COM, `IDirect3DTexture2_QueryInterface: this=0x${thisPtr.toString(16)} iid=${iidStr} ppvObject=0x${ppvObject.toString(16)} obj=${obj ? obj.constructor.name : 'null'}`);

        if (!obj) {
            Logger.warn(LogCategory.COM, `IDirect3DTexture2_QueryInterface: Object not found for thisPtr=0x${thisPtr.toString(16)}`);
            return 0x80004002;
        }

        const result = obj.queryInterface(iidStr, ppvObject, mem);
        if (ppvObject) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const returnedAddr = view.getUint32(ppvObject, true);
            Logger.log(LogCategory.COM, `IDirect3DTexture2_QueryInterface: result=0x${result.toString(16)} returnedAddr=0x${returnedAddr.toString(16)}`);
        }
        return result;
    };

    exports["IDirect3DTexture2_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirect3DTexture2_GetHandle"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const devicePtr = args[1];
        const lpHandle = args[2];
        if (!lpHandle || !isValidAddress(mem, lpHandle, 4)) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DTexture2Object | null;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        if (!obj) {
            view.setUint32(lpHandle, 0, true);
            Logger.warn(LogCategory.DDRAW, `IDirect3DTexture2_GetHandle: Texture object not found for 0x${thisPtr.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        const surfaceAddr = obj.getSurfaceAddr();
        const surfaceObj = resourceProvider.getComObjectByAddress(surfaceAddr) as DirectDrawSurfaceObject | null;

        if (!surfaceObj) {
            view.setUint32(lpHandle, 0, true);
            Logger.warn(LogCategory.DDRAW, `IDirect3DTexture2_GetHandle: Surface object not found for 0x${surfaceAddr.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        const state = surfaceObj.getState();
        const handle = surfaceObj.handle;

        // The COM layer recycles handle numbers after Release, but registry entries
        // persist past Release (by design — D3DTEXTUREHANDLE survives COM Release).
        // A NEW surface can therefore receive a handle still mapped to a dead
        // surface's GPU texture and silently inherit its pixels (TR2 title menu
        // rendered fragments of boot-time textures). Reuse the entry only when it
        // actually refers to this surface's GPU texture; otherwise drop the stale
        // entry and re-register below.
        const existingEntry = context.textureHandles.get(handle);
        if (existingEntry) {
            if (state.gpuTexture && existingEntry.gpuTexture === state.gpuTexture) {
                view.setUint32(lpHandle, handle, true);
                Logger.log(LogCategory.DDRAW, `IDirect3DTexture2_GetHandle: Reusing existing handle=0x${handle.toString(16)} (surface.handle) for texture 0x${thisPtr.toString(16)}`);
                return D3D_OK;
            }
            context.textureHandles.delete(handle);
            Logger.log(LogCategory.DDRAW, `IDirect3DTexture2_GetHandle: handle=0x${handle.toString(16)} had STALE registry entry (recycled handle from a released surface) - re-registering for texture 0x${thisPtr.toString(16)}`);
        }

        // Always return surface.handle for identity, even if GPU texture doesn't exist yet.
        // Games may call GetHandle() once, store the result, and always pass it to SetTexture.
        // If we return surfaceAddr on first call and surface.handle later, the game will send the wrong value.
        // Register texture handle entry if GPU texture exists (for persistence), but always return handle.
        if (state.gpuTexture && state.gpuTextureView) {
            textureManager.registerPersistent(surfaceObj);
            view.setUint32(lpHandle, handle, true);
            Logger.log(LogCategory.DDRAW, `IDirect3DTexture2_GetHandle: Created NEW handle=0x${handle.toString(16)} (surface.handle) for texture 0x${thisPtr.toString(16)} (${state.width}x${state.height})`);
            Logger.log(LogCategory.SYSTEM, `IDirect3DTexture2_GetHandle: Created NEW handle=0x${handle.toString(16)} (surface.handle) for texture 0x${thisPtr.toString(16)} (${state.width}x${state.height})`);
            return D3D_OK;
        }

        view.setUint32(lpHandle, handle, true);
        Logger.verbose(LogCategory.DDRAW, `IDirect3DTexture2_GetHandle: NO GPU TEXTURE YET for surface 0x${surfaceAddr.toString(16)} (will be created lazily on bind)`);
        return D3D_OK;
    };

    exports["IDirect3DTexture2_PaletteChanged"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        Logger.log(LogCategory.DDRAW, `IDirect3DTexture2_PaletteChanged: this=0x${thisPtr.toString(16)}`);
        
        // Invalidate texture when palette changes (for P8/L8 formats)
        // Palette change means texture colors will be different even if pixel data is same
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DTexture2Object | null;
        if (obj) {
            const surfaceAddr = obj.getSurfaceAddr();
            const surfaceObj = resourceProvider.getComObjectByAddress(surfaceAddr) as DirectDrawSurfaceObject | null;
            if (surfaceObj) {
                const state = surfaceObj.getState();
                // Force re-upload with new palette on next bind
                setAuthorityCpu(state);
                Logger.log(LogCategory.DDRAW,
                    `IDirect3DTexture2_PaletteChanged: Marked surface 0x${surfaceAddr.toString(16)} authority=cpu for palette update`
                );
            }
        }
        
        return D3D_OK;
    };

    exports["IDirect3DTexture2_Load"] = (ctx, mem, args): number | Promise<number> => {
        const thisPtr = args[0];
        const srcTexture = args[1];

        const srcSurf = textureManager.resolveToSurface(srcTexture);
        const dstSurf = textureManager.resolveToSurface(thisPtr);

        if (Logger.isEnabled(LogCategory.DDRAW, LogLevel.NORMAL)) {
            Logger.log(LogCategory.DDRAW, 
                `IDirect3DTexture2_Load: this=0x${thisPtr.toString(16)} srcTexture=0x${srcTexture.toString(16)} ` +
                `srcSurf=${!!srcSurf} dstSurf=${!!dstSurf}`);
        }

        if (!srcSurf || !dstSurf) {
            Logger.warn(LogCategory.DDRAW,
                `IDirect3DTexture2_Load: Failed to resolve surfaces! srcSurf=${!!srcSurf} dstSurf=${!!dstSurf}`);
            return D3DERR_INVALIDCALL;
        }

        const srcState = srcSurf.getState();
        const dstState = dstSurf.getState();
        // Always propagate colorkey state to destination, regardless of GPU/CPU load path.
        // Some DX4 games set colorkey on SYS surface then Load() into a GPU texture.
        if (srcState.srcColorKey) {
            dstState.srcColorKey = {
                low: srcState.srcColorKey.low,
                high: srcState.srcColorKey.high
            };
        }
        if (srcState.destColorKey) {
            dstState.destColorKey = {
                low: srcState.destColorKey.low,
                high: srcState.destColorKey.high
            };
        }
        if (srcState.format.bpp === 8 && dstState.format.bpp === 8 && srcState.paletteHandle !== undefined) {
            dstState.paletteHandle = srcState.paletteHandle;
        }

        // NOTE: Fingerprint-based Load() cache REMOVED — sampling 8 positions across the texture
        // missed real changes when games (D2) reuse SYSMEM surfaces with different data between
        // Load() calls, causing "textures swap to foreign ones" artifacts.

        // NOTE: ARGB1555 alpha is handled by the LUT (ARGB1555_TO_RGBA):
        // bit15=0 → alpha=0 (transparent), bit15=1 → alpha=255 (opaque).
        // Some titles bake alpha into bit15 during texture loading.
        // Auto-alpha-test in ddraw-backend-executor.ts discards alpha=0 pixels at draw time.

        const sameSurface = srcSurf === dstSurf || (srcState.surfacePtr === dstState.surfacePtr && srcState.surfacePtr > 0);
        let loadBranch: "sameSurface" | "gpu" | "cpu" = "cpu";
        if (sameSurface) {
            loadBranch = "sameSurface";
        } else if (isRenderSurface(srcState) && srcState.mode === "GPU_ONLY" && !srcState.gpuDirty && srcState.gpuTexture && dstState.gpuTexture && context.executor) {
            // GPU fast path: both surfaces GPU_ONLY, source GPU has current data
            loadBranch = "gpu";
            context.executor.copySurfaceGpuToGpu(srcState, dstState);
            setAuthorityGpu(dstState, true);
        } else {
            loadBranch = "cpu";
        }

        const runLoadTail = (): number => {
            propagateSurfaceStateToRegistry(context, dstState);
            if (dstState.gpuTexture && dstState.surfacePtr > 0) {
                const gpuTex = dstState.gpuTexture;
                const gpuTexView = dstState.gpuTextureView;
                const gpuTexFormat = dstState.gpuTextureFormat;
                const versionAfter = isRenderSurface(dstState) ? dstState.version : 0;
                // PERF: Use surfacePtr index for O(1) lookup instead of O(N) scan of all COM objects
                const siblings = context.resourceProvider.getComObjectsBySurfacePtr(dstState.surfacePtr);
                for (const other of siblings) {
                    if (!(other instanceof DirectDrawSurfaceObject)) continue;
                    const otherState = other.getState();
                    if (otherState === dstState) continue;
                    const sharesGpuTex = otherState.gpuTexture === gpuTex;
                    if (!sharesGpuTex) {
                        otherState.gpuTexture = gpuTex;
                        otherState.gpuTextureView = gpuTexView;
                    }
                    if (gpuTexFormat) {
                        otherState.gpuTextureFormat = gpuTexFormat;
                    }
                    // CPU-First: Propagate dirty state to siblings.
                    // DO NOT set gpuDirty=false here! The actual upload happens later
                    // in prepareDraw or flushAll. If dstState is dirty, siblings are too.
                    if (isRenderSurface(otherState)) {
                        otherState.gpuDirty = isRenderSurface(dstState) ? dstState.gpuDirty : true;
                        otherState.version = versionAfter;
                        // version was ASSIGNED, not incremented — the readback memo keys on
                        // this surface's own version numbering and must be dropped.
                        invalidateCpuSyncedVersion(otherState);
                        // lastUploadVersion stays as-is until markGpuSyncedFromCpu
                    }
                }
            }
            return D3D_OK;
        };

        if (loadBranch !== "cpu") {
            return runLoadTail();
        }

        const markDirtyAndTail = (): number => {
            // Mark destination as dirty so GPU upload will happen.
            // copyTexture2Data writes pixels to guest memory but doesn't set any sync flags.
            // Without this, needsGPUSync returns false (gpuDirty=false) and the texture
            // data never reaches the GPU — causing invisible textures.
            if (isRenderSurface(dstState)) {
                dstState.gpuDirty = true;
            } else if (isBitmapTexture(dstState)) {
                dstState.gpuNeedsUpload = true;
            }
            // OPTIMIZATION: Defer GPU upload to Present/Flip instead of immediate sync
            // DeferredUploadManager will batch all texture uploads at frame end (1 submission vs 26)
            // prepareDraw() handles immediate upload if texture is bound before Present
            if (context.deferredUploadManager && dstState.surfacePtr) {
                context.deferredUploadManager.markDirty(dstState, false);
            }
            return runLoadTail();
        };

        // PERF: copyTexture2Data returns void (sync) or Promise (async readback needed)
        const copyResult = copyTexture2Data(srcSurf, dstSurf, mem, 0, "");
        if (copyResult instanceof Promise) {
            return copyResult.then((): number => markDirtyAndTail());
        }
        return markDirtyAndTail();
    };

    // --- Safe Release (shared logic for texture Release) ---

    const safeReleaseTexture = (thisPtr: number, interfaceName: string): number => {
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as (Direct3DTextureObject | Direct3DTexture2Object) | null;

        if (!obj) return 0;

        const oldRefCount = obj.refCount;
        // Direct3DTextureObject.release() delegates to parent surface.release()
        // This means the surface refcount is managed correctly, but we should verify
        // that when refcount reaches 0, the surface is properly destroyed
        const newRefCount = obj.release();
        
        // Note: If newRefCount is 0, the surface will be destroyed via BaseComObject.destroy()
        // which handles GPU resource cleanup. The surface ref added in Initialize() will be
        // released when surface refcount reaches 0, ensuring proper COM lifetime management.
        
        Logger.log(LogCategory.DDRAW, `${interfaceName}_Release: addr=0x${thisPtr.toString(16)} handle=0x${obj.handle.toString(16)} refCount=${oldRefCount}->${newRefCount}`);
        return newRefCount;
    };

    exports["IDirect3DTexture_Release"] = (ctx, mem, args) => {
        return safeReleaseTexture(args[0], "IDirect3DTexture");
    };

    exports["IDirect3DTexture2_Release"] = (ctx, mem, args) => {
        return safeReleaseTexture(args[0], "IDirect3DTexture2");
    };

    return exports;
};
