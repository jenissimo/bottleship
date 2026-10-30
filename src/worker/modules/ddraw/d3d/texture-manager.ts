/**
 * Texture Manager - handles texture resolution, registration, and lifecycle
 *
 * This module encapsulates the texture handling logic including:
 * - Surface/texture resolution from various identifiers (addresses, handles, GDI bitmaps)
 * - Texture handle registry for D3DTEXTUREHANDLE support
 * - Device texture binding with reference counting
 */
import { Logger, LogCategory } from "../../../core/logger";
import { ResourceType } from "../../../core/resources/system-resource-provider";
import { DDrawContext } from "../context";
import {
    DirectDrawSurfaceObject,
    DirectDrawSurfaceState,
    Direct3DTextureObject,
    Direct3DTexture2Object,
    Direct3DDevice3Object,
    Direct3DDevice7Object,
    isRenderSurface,
} from "../com-objects";
import { TextureResolution, TextureManager } from "./types";

/**
 * Propagate surface content state to texture handle registry.
 * Call after any writer that sets authority/version on a texture surface so that
 * Draw by handle (texStateFromRegistry) sees current state and doesn't skip sync incorrectly.
 * Single canonical place for "state → registry" so we don't duplicate or miss writers.
 *
 * IMPORTANT: srcColorKey is propagated for ALL surface types (including BitmapTextureSurface)
 * because SetColorKey can be called on any texture, not just RenderSurface.
 */
export const propagateSurfaceStateToRegistry = (
    context: DDrawContext,
    state: DirectDrawSurfaceState
): void => {
    if (!state.gpuTexture) {
        if (state.srcColorKey) {
            Logger.warn(LogCategory.DDRAW,
                `[COLORKEY] propagateSurfaceStateToRegistry: srcColorKey SET but NO gpuTexture! ` +
                `surfacePtr=0x${(state.surfacePtr ?? 0).toString(16)} ` +
                `colorKey=0x${state.srcColorKey.low.toString(16)}-0x${state.srcColorKey.high.toString(16)} ` +
                `— colorkey will be on live state but NOT in registry until GPU tex created`);
        }
        return;
    }
    const gpuTex = state.gpuTexture;

    let propagatedCount = 0;
    for (const [handle, entry] of context.textureHandles.entries()) {
        if (entry.gpuTexture === gpuTex) {
            // Always propagate srcColorKey for ALL surface types (including BitmapTexture)
            // Old D3D games call SetColorKey on texture surfaces to set transparency
            entry.srcColorKey = state.srcColorKey;
            entry.gpuTextureFormat = state.gpuTextureFormat;
            propagatedCount++;

            // Only propagate mode/version for RenderSurface
            if (isRenderSurface(state) && entry) {
                entry.mode = state.mode;
                entry.version = state.version;
                entry.lastUploadVersion = state.lastUploadVersion;
            }
        }
    }
    if (state.srcColorKey && propagatedCount === 0) {
        Logger.warn(LogCategory.DDRAW,
            `propagateSurfaceStateToRegistry: srcColorKey=0x${state.srcColorKey.low.toString(16)} ` +
            `set but NO registry entries found for gpuTexture (registrySize=${context.textureHandles.size}) ` +
            `surfacePtr=0x${(state.surfacePtr ?? 0).toString(16)}`);
    } else if (state.srcColorKey && propagatedCount > 0) {
        Logger.log(LogCategory.DDRAW,
            `propagateSurfaceStateToRegistry: srcColorKey=0x${state.srcColorKey.low.toString(16)} ` +
            `propagated to ${propagatedCount} registry entries ` +
            `surfacePtr=0x${(state.surfacePtr ?? 0).toString(16)}`);
    }
};

export const createTextureManager = (context: DDrawContext): TextureManager => {
    const resourceProvider = context.resourceProvider;

    /**
     * Helper to resolve an interface address to DirectDrawSurfaceObject.
     * Used in Load() to get base Surface objects from Texture/Surface interfaces.
     */
    const resolveToSurface = (interfaceAddr: number): DirectDrawSurfaceObject | null => {
        if (!interfaceAddr) return null;

        // Try Address Lookup
        let comObj = resourceProvider.getComObjectByAddress(interfaceAddr);

        // Try Handle Lookup
        if (!comObj) {
            comObj = resourceProvider.getComObject(interfaceAddr);
            if (!comObj) {
                const addr = resourceProvider.getAddressForHandle(interfaceAddr);
                if (addr) {
                    comObj = resourceProvider.getComObjectByAddress(addr);
                }
            }
        }

        // Resolve specific types
        if (comObj instanceof Direct3DTextureObject || comObj instanceof Direct3DTexture2Object) {
            const surfaceAddr = comObj.getSurfaceAddr();
            return resourceProvider.getComObjectByAddress(surfaceAddr) as DirectDrawSurfaceObject | null;
        } else if (comObj instanceof DirectDrawSurfaceObject) {
            return comObj;
        } else if (!comObj) {
            // Fallback: GDI Bitmap / LoadImageA result
            const resource = resourceProvider.getResource(interfaceAddr);
            if (resource && (resource.type === ResourceType.USER_OBJECT || resource.type === ResourceType.GDI_OBJECT) && resource.resource) {
                const gdiObj = resource.resource;
                if (gdiObj.type === "BITMAP" && !gdiObj.loading && gdiObj.width && gdiObj.height
                    && (gdiObj.pixels || gdiObj.bitsPtr)) {
                    const ddraw = context.process.getModule("ddraw") as any;
                    if (ddraw?.createTextureFromBitmap) {
                        const newAddr = ddraw.createTextureFromBitmap(interfaceAddr, gdiObj);
                        if (newAddr) {
                            return resourceProvider.getComObjectByAddress(newAddr) as DirectDrawSurfaceObject | null;
                        }
                    }
                }
            }
        }

        return null;
    };

    /**
     * Unified surface resolution: converts any texture/surface identifier (address, handle, GDI bitmap)
     * into a DirectDrawSurfaceObject address and object.
     */
    const resolve = (ptrOrHandle: number): TextureResolution => {
        if (!ptrOrHandle) return { addr: 0, obj: null, source: "null" };

        let surfaceAddr = ptrOrHandle;
        let surfaceObj: DirectDrawSurfaceObject | null = null;
        let source = "raw";

        // 0. Check texture handle registry, but also verify if a LIVE COM object exists
        // at this address. A surface may have been destroyed (handle persisted in registry)
        // and a new surface created at the same address. The live object takes priority.
        const textureEntry = context.textureHandles.get(ptrOrHandle);
        if (textureEntry) {
            const liveComObj = resourceProvider.getComObjectByAddress(ptrOrHandle);
            if (liveComObj instanceof DirectDrawSurfaceObject) {
                const liveGpu = liveComObj.getState().gpuTexture;
                if (liveGpu && textureEntry.gpuTexture && liveGpu !== textureEntry.gpuTexture) {
                    context.textureHandles.delete(ptrOrHandle);
                } else {
                    return { addr: ptrOrHandle, obj: liveComObj, source: "surface_direct" };
                }
            } else {
                return { addr: ptrOrHandle, obj: null, source: "texture_handle_registry", textureHandleEntry: textureEntry };
            }
        }

        // 1. Try Address Lookup
        let comObj = resourceProvider.getComObjectByAddress(ptrOrHandle);

        // 2. Try Handle Lookup
        if (!comObj) {
            comObj = resourceProvider.getComObject(ptrOrHandle);
            if (!comObj) {
                const addr = resourceProvider.getAddressForHandle(ptrOrHandle);
                if (addr) {
                    comObj = resourceProvider.getComObjectByAddress(addr);
                    if (comObj) {
                        surfaceAddr = addr;
                        source = "handle_lookup";
                    }
                }
            }
        }

        // 3. Resolve based on object type
        if (comObj instanceof Direct3DTextureObject || comObj instanceof Direct3DTexture2Object) {
            source = comObj instanceof Direct3DTextureObject ? "d3dtex1" : "d3dtex2";
            const surfAddr = comObj.getSurfaceAddr();
            if (surfAddr) {
                surfaceAddr = surfAddr;
                surfaceObj = resourceProvider.getComObjectByAddress(surfAddr) as DirectDrawSurfaceObject | null;
            }
        } else if (comObj instanceof DirectDrawSurfaceObject) {
            source = "surface_direct";
            surfaceObj = comObj;
            // When resolved via getComObject(handle), ptrOrHandle is D3DTEXTUREHANDLE; use mapped address so device stores surface addr
            surfaceAddr = resourceProvider.getAddressForHandle(ptrOrHandle) ?? ptrOrHandle;
        } else if (!comObj) {
            // Fallback: GDI Bitmap / LoadImageA result
            const resource = resourceProvider.getResource(ptrOrHandle);
            if (resource && (resource.type === ResourceType.USER_OBJECT || resource.type === ResourceType.GDI_OBJECT) && resource.resource) {
                const gdiObj = resource.resource;
                if (gdiObj.type === "BITMAP" && !gdiObj.loading && gdiObj.width && gdiObj.height
                    && (gdiObj.pixels || gdiObj.bitsPtr)) {
                    source = "gdi_bitmap";
                    const ddraw = context.process.getModule("ddraw") as any;
                    if (ddraw?.createTextureFromBitmap) {
                        const newAddr = ddraw.createTextureFromBitmap(ptrOrHandle, gdiObj);
                        if (newAddr) {
                            surfaceAddr = newAddr;
                            surfaceObj = resourceProvider.getComObjectByAddress(newAddr) as DirectDrawSurfaceObject | null;
                        }
                    }
                }
            }
        }

        return { addr: surfaceAddr, obj: surfaceObj, source };
    };

    /**
     * Helper to register a surface state into the texture handle registry.
     * This ensures the GPU texture persists even if the COM object is released.
     * Uses surface.handle as the D3DTEXTUREHANDLE to ensure Identity.
     */
    const registerPersistent = (surfaceObj: DirectDrawSurfaceObject): void => {
        if (!surfaceObj) return;
        const state = surfaceObj.getState();

        // Only register if we have a valid GPU texture
        if (!state.gpuTexture || !state.gpuTextureView) return;

        // Use surface.handle as the D3DTEXTUREHANDLE
        const handle = surfaceObj.handle;
        const wasAlreadyRegistered = context.textureHandles.has(handle);

        // Check for duplicate registration by gpuTexture
        for (const [existingHandle, entry] of context.textureHandles) {
            if (entry.gpuTexture === state.gpuTexture && existingHandle !== handle) {
                Logger.log(LogCategory.DDRAW, `Duplicate texture registration: surface handle 0x${handle.toString(16)} has same gpuTexture as handle 0x${existingHandle.toString(16)}`);
                if (!wasAlreadyRegistered) {
                    surfaceObj.addRef();
                }
                context.textureHandles.set(handle, entry);
                return;
            }
        }

        // No duplicate found - register new handle
        if (!wasAlreadyRegistered) {
            surfaceObj.addRef();
        }

        // Store snapshot of fields + content state so prepareDraw doesn't sync from CPU (registry has no surfacePtr)
        context.textureHandles.set(handle, {
            handle,
            gpuTexture: state.gpuTexture,
            gpuTextureView: state.gpuTextureView,
            gpuTextureFormat: state.gpuTextureFormat,
            width: state.width,
            height: state.height,
            pitch: state.pitch,
            format: state.format ? {
                flags: state.format.flags,
                bpp: state.format.bpp,
                rMask: state.format.rMask,
                gMask: state.format.gMask,
                bMask: state.format.bMask,
                aMask: state.format.aMask
            } : { flags: 0, bpp: 32, rMask: 0xFF0000, gMask: 0xFF00, bMask: 0xFF, aMask: 0xFF000000 },
            version: isRenderSurface(state) ? state.version : 0,
            srcColorKey: state.srcColorKey,
        });
    };

    /**
     * Safe texture setting with reference counting: releases old texture, resolves and adds ref to new one.
     * Supports texture handles that survive COM Release (DirectX behavior).
     * Registers reverse references in surface state for unbindFromDevices() cleanup.
     */
    const setDeviceTexture = (deviceObj: Direct3DDevice3Object | Direct3DDevice7Object, stage: number, textureId: number): void => {
        if (!deviceObj) return;
        // A recorded binding is not bound yet: the references move when the block is applied.
        if (deviceObj.isRecording()) {
            deviceObj.setTexture(stage, textureId);
            return;
        }

        const deviceHandle = deviceObj.handle;
        const oldAddr = deviceObj.getTexture(stage);
        
        // Unbind old texture from device (remove reverse reference)
        if (oldAddr) {
            if (context.textureHandles.has(oldAddr)) {
                Logger.verbose(LogCategory.DDRAW, `SetTexture: Old texture 0x${oldAddr.toString(16)} is persistent handle - skipping release`);
            } else {
                let oldComAddr = oldAddr;
                const oldObjByHandle = resourceProvider.getComObject(oldAddr);
                if (oldObjByHandle) {
                    const addr = resourceProvider.getAddressForHandle(oldAddr);
                    if (addr !== null) {
                        oldComAddr = addr;
                    }
                }
                
                const oldObj = resourceProvider.getComObjectByAddress(oldComAddr);
                if (oldObj instanceof DirectDrawSurfaceObject) {
                    // Remove reverse reference from old surface
                    const oldState = oldObj.getState();
                    if (oldState.boundByDevices) {
                        const key = `${deviceHandle}:${stage}`;
                        oldState.boundByDevices.delete(key);
                        Logger.verbose(LogCategory.DDRAW, `SetTexture: Removed reverse reference from old surface 0x${oldComAddr.toString(16)} (device=0x${deviceHandle.toString(16)} stage=${stage})`);
                    }
                    oldObj.release();
                    Logger.verbose(LogCategory.DDRAW, `SetTexture: Released old texture 0x${oldComAddr.toString(16)} (resolved from 0x${oldAddr.toString(16)}) on stage ${stage}`);
                } else if (oldObj) {
                    oldObj.release();
                    Logger.verbose(LogCategory.DDRAW, `SetTexture: Released old texture 0x${oldComAddr.toString(16)} (resolved from 0x${oldAddr.toString(16)}) on stage ${stage}`);
                }
            }
        }

        if (!textureId) {
            deviceObj.setTexture(stage, 0);
            return;
        }

        const resolved = resolve(textureId);

        if (resolved.textureHandleEntry) {
            // Auto-colorkey for registry entries: non-alpha 16-bit textures without colorkey
            // Real DX6 hardware treated pixel 0x0000 as transparent in non-alpha textures.
            // Some games without explicit colorkey rely on this implicit behavior.
            const entry = resolved.textureHandleEntry;
            if (!entry.srcColorKey && entry.format && !entry.format.aMask && entry.format.bpp === 16) {
                entry.srcColorKey = { low: 0, high: 0 };
            }
            // Keep the registry key: this binding owns no COM reference. Converting it
            // to a surface address makes unbinding mistake it for an owned COM binding.
            deviceObj.setTexture(stage, textureId);
            return;
        }

        if (resolved.obj) {
            // Auto-colorkey for live surfaces: non-alpha 16-bit textures without colorkey.
            // Real DX6 hardware treated pixel 0x0000 as transparent in non-alpha textures.
            // ARGB1555 (aMask=0x8000) is EXCLUDED: its alpha bit handles transparency
            // via the ARGB1555_TO_RGBA LUT (bit15=0→alpha=0, bit15=1→alpha=255) +
            // auto-alpha-test in ddraw-backend-executor.ts.
            const state = resolved.obj.getState();
            if (!state.srcColorKey && state.format && !state.format.aMask && state.format.bpp === 16) {
                state.srcColorKey = { low: 0, high: 0 };
                propagateSurfaceStateToRegistry(context, state);
            }
            // Add reverse reference to surface state for unbindFromDevices() cleanup
            if (!state.boundByDevices) {
                state.boundByDevices = new Map();
            }
            const key = `${deviceHandle}:${stage}`;
            state.boundByDevices.set(key, { deviceHandle, stage });
            Logger.verbose(LogCategory.DDRAW, `SetTexture: Added reverse reference to surface 0x${resolved.addr.toString(16)} (device=0x${deviceHandle.toString(16)} stage=${stage})`);
            // Register handle in textureHandles if not yet (e.g. app passed handle, GetHandle was called before GPU tex existed)
            if (state.gpuTexture && state.gpuTextureView && !context.textureHandles.has(resolved.obj.handle)) {
                registerPersistent(resolved.obj);
            }
            // Device stores resolved.addr (surface address); draw path looks up textureHandles.get(getTexture(0)).
            // Registry is keyed by surface.handle. Register same entry under surface address so lookup succeeds.
            const entryByHandle = context.textureHandles.get(resolved.obj.handle);
            if (entryByHandle && resolved.addr !== resolved.obj.handle) {
                context.textureHandles.set(resolved.addr, entryByHandle);
            }
            resolved.obj.addRef();
            deviceObj.setTexture(stage, resolved.addr);
        } else {
            Logger.warn(LogCategory.DDRAW, `SetTexture: No surface object found for 0x${textureId.toString(16)}`);
            deviceObj.setTexture(stage, resolved.addr);
        }
    };

    return {
        resolve,
        resolveToSurface,
        registerPersistent,
        setDeviceTexture,
    };
};

/**
 * Safe render target setting with reference counting
 */
export const setDeviceRenderTarget = (
    context: DDrawContext,
    deviceObj: Direct3DDevice3Object | Direct3DDevice7Object,
    rtId: number
): void => {
    if (!deviceObj) return;

    const resourceProvider = context.resourceProvider;

    // 1. Release old render target reference
    const oldAddr = deviceObj.getRenderTarget();
    if (oldAddr) {
        const oldObj = resourceProvider.getComObjectByAddress(oldAddr);
        if (oldObj) {
            oldObj.release();
            Logger.verbose(LogCategory.DDRAW, `SetRenderTarget: Released old render target 0x${oldAddr.toString(16)}`);
        }
    }

    // 2. Set new render target
    deviceObj.setRenderTarget(rtId);

    // 3. AddRef new render target
    if (rtId) {
        const newObj = resourceProvider.getComObjectByAddress(rtId);
        if (newObj) {
            newObj.addRef();
            Logger.verbose(LogCategory.DDRAW, `SetRenderTarget: Added ref to new render target 0x${rtId.toString(16)}`);
        }
    }
};
