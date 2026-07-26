import { ThunkImplementation, ThunkResult } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { profiler } from "../../core/profiler";
import { frameVarianceDiagnostics } from "../../core/frame-variance-diagnostics";
import { DDrawContext } from "./context";
import { registerSurfaceV1Exports } from "./surface-v1";
import {
    DD_OK,
    DDERR_NOTFOUND,
    DDERR_INVALIDPARAMS,
    DDERR_NOCLIPPER,
    DDSCAPS_BACKBUFFER,
    DDSCAPS_FLIP,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_VIDEOMEMORY,
    DDSCAPS_TEXTURE,
    DDSCAPS_ZBUFFER,
    DDSCAPS_MIPMAP,
    DDSD_LPSURFACE,
    allocateComObject,
    checkComGuard,
    D3DCLEAR_TARGET,
    DDSURFACEDESC2_OFFSETS,
    DDSURFACEDESC_OFFSETS,
    DDSURFACEDESC2_SIZE,
    DDSURFACEDESC_SIZE,
    IID_IDirectDrawSurface7,
    IID_IDirect3DTexture,
    IID_IDirect3DTexture2,
    E_NOINTERFACE,
    E_POINTER,
    E_FAIL,
    DDCKEY_SRCBLT,
    DDCKEY_DESTBLT,
    DDPF_ALPHAPIXELS,
    DDLOCK_READONLY,
    DDLOCK_WRITEONLY,
    DDLOCK_DISCARDCONTENTS,
    IID_IDirectDrawGammaControl,
    IID_IDirect3DDevice3,
    IID_IDirect3DHALDevice,
    IID_IDirect3DRGBDevice,
    IID_IDirect3DRampDevice,
    IID_IDirect3DMMXDevice,
    D3DRENDERSTATE_COLORKEYENABLE,
} from "./constants";
import { bytesToGuid, readRect, Rect, absToRel, readU16Abs, readU32Abs } from "./helpers";
import { writeSurfaceDescV1 } from "./structs";
import { DirectDrawSurfaceObject, DirectDrawSurfaceState, Direct3DTextureObject, Direct3DTexture2Object, DirectDrawGammaControlObject, DirectDrawClipperObject, Direct3DDevice3Object, isBitmapTexture, isRenderSurface } from "./com-objects";
import { writePixelFormat, writeSurfaceDesc } from "./structs";
import { isValidAddress, isSafeSurfaceAddress, overlapsThunkCode } from "../../core/memory/address-guard";
import { ComObjectFactory } from "../../core/com/base-com-object";

import { convertRGBAToSurface, uploadToGPUTexture, convertSurfaceToRGBA } from "./gpu-texture-utils";
import { setAuthorityCpu, setAuthorityGpu, markCpuSyncedFromGpu, syncActiveGdiContext, surfaceSyncManager, logSurfaceState, demoteSurfaceToCpu } from "./surface-sync";
import { propagateSurfaceStateToRegistry } from "./d3d/texture-manager";
import { thunkChecksumManager } from "../../core/memory/thunk-checksum";
import { leaseRegistry } from "../../core/memory/lease-registry";
import { Mem } from "../../core/memory/mem-accessor";
import { lockTracker } from "../../core/lock-tracker";
import { getLastGetDIBitsBuffer } from "../gdi32/painting";
import { clipRect } from "./surface-helpers";
import { createSurfaceStubsExports } from "./surface-stubs";
import { createSurfaceBltFlipExports } from "./surface-blt-flip";

// Performance: Texture diagnostics are expensive (scan 1000+ pixels per Unlock).
// Enable only when debugging texture corruption issues.
const ENABLE_TEXTURE_DIAGNOSTICS = false;

// Performance: Thunk checksum validation in Lock/Unlock is VERY expensive (131ms per Lock!).
// Enable only when debugging memory corruption issues.
// In production, rely on existing memory guards and region checks.
const ENABLE_LOCK_THUNK_VALIDATION = false;

type SurfaceLookup = (addr: number) => DirectDrawSurfaceObject | null;

const clearActiveLeaseSnapshot = (state: DirectDrawSurfaceState): void => {
    state.activeLeaseSnapshot = undefined;
    state.activeLeaseSnapshotBase = undefined;
    state.activeLeaseSnapshotSize = undefined;
};

const captureActiveLeaseSnapshot = (
    mem: Uint8Array,
    state: DirectDrawSurfaceState,
    leaseId: number
): void => {
    clearActiveLeaseSnapshot(state);
    const lease = leaseRegistry.validateLease(leaseId);
    if (!lease || lease.perms === "r") return;
    if (lease.base < 0 || lease.size <= 0 || lease.base + lease.size > mem.length) return;

    const snapshot = new Uint8Array(lease.size);
    snapshot.set(mem.subarray(lease.base, lease.base + lease.size));
    state.activeLeaseSnapshot = snapshot;
    state.activeLeaseSnapshotBase = lease.base;
    state.activeLeaseSnapshotSize = lease.size;
};

const consumeActiveLeaseWriteState = (
    mem: Uint8Array,
    state: DirectDrawSurfaceState
): { hadLease: boolean; wasReadOnly: boolean; changed: boolean } => {
    if (state.activeLeaseId === undefined) {
        clearActiveLeaseSnapshot(state);
        return { hadLease: false, wasReadOnly: true, changed: false };
    }

    const lease = leaseRegistry.validateLease(state.activeLeaseId);
    if (!lease) {
        clearActiveLeaseSnapshot(state);
        return { hadLease: false, wasReadOnly: true, changed: false };
    }
    if (lease.perms === "r") {
        clearActiveLeaseSnapshot(state);
        return { hadLease: true, wasReadOnly: true, changed: false };
    }

    // Exact byte comparison is only needed for texture staging surfaces, where a
    // writable Lock may be followed by no actual texel writes and a false dirty
    // bit can upload zero-filled implementation storage. Backbuffers/primaries
    // are hot render paths; DirectDraw treats writable locks as CPU write intent.
    if ((state.caps & DDSCAPS_TEXTURE) === 0) {
        clearActiveLeaseSnapshot(state);
        return { hadLease: true, wasReadOnly: false, changed: true };
    }

    const snapshot = state.activeLeaseSnapshot;
    const base = state.activeLeaseSnapshotBase;
    const size = state.activeLeaseSnapshotSize;
    if (!snapshot || base === undefined || size === undefined ||
        base !== lease.base || size !== lease.size ||
        base < 0 || size <= 0 || base + size > mem.length) {
        clearActiveLeaseSnapshot(state);
        return { hadLease: true, wasReadOnly: false, changed: true };
    }

    let changed = false;
    for (let i = 0; i < size; i++) {
        if (mem[base + i] !== snapshot[i]) {
            changed = true;
            break;
        }
    }
    clearActiveLeaseSnapshot(state);
    return { hadLease: true, wasReadOnly: false, changed };
};

/** True when attached surface caps satisfy requested DDSCAPS (DirectDraw semantics). */
function attachedCapsMatch(attachedCaps: number, requestedCaps: number): boolean {
    if (!requestedCaps) return true;
    if ((attachedCaps & requestedCaps) === requestedCaps) return true;
    // Lower mip levels often drop DDSCAPS_MIPMAP but remain TEXTURE nodes in the chain.
    if ((requestedCaps & DDSCAPS_MIPMAP) !== 0 && (requestedCaps & DDSCAPS_TEXTURE) !== 0) {
        const withoutMip = requestedCaps & ~DDSCAPS_MIPMAP;
        return withoutMip !== 0 && (attachedCaps & withoutMip) === withoutMip;
    }
    return false;
}

/** Walk the attached-surface linked list; return first address whose caps match. */
function resolveGetAttachedSurfaceTarget(
    context: DDrawContext,
    lookup: SurfaceLookup,
    thisPtr: number,
    requestedCaps: number,
): number {
    const obj = lookup(thisPtr);
    if (!obj) return 0;

    let currentAddr = obj.getState().attachedSurfaceAddr;
    const visited = new Set<number>();
    while (currentAddr && !visited.has(currentAddr)) {
        visited.add(currentAddr);
        const attachedObj = lookup(currentAddr);
        if (!attachedObj) break;
        const attachedCaps = attachedObj.getState().caps >>> 0;
        if (attachedCapsMatch(attachedCaps, requestedCaps)) {
            return currentAddr;
        }
        currentAddr = attachedObj.getState().attachedSurfaceAddr;
    }

    if (requestedCaps & DDSCAPS_BACKBUFFER) {
        const bb = context.surfaces.backBuffer;
        if (bb) return bb;
    }
    if (requestedCaps & DDSCAPS_PRIMARYSURFACE) {
        const prim = context.surfaces.primary;
        if (prim) return prim;
    }
    return 0;
}

export const createSurfaceExports = (context: DDrawContext): Record<string, ThunkImplementation> => {
    const exports: Record<string, ThunkImplementation> = {};
    // Diagnostic counters for texture interface creation (per surface)
    const textureQueryCounts: Map<number, number> = new Map();
    let texture2CreateCount = 0;
    let textureCreateCount = 0;

    // Performance: Cache memory regions to avoid repeated lookups in Lock/Unlock hot paths
    let cachedRegions: any = null;
    const getRegions = () => {
        if (!cachedRegions) {
            const process = System.getInstance().process;
            try {
                cachedRegions = process?.thunkMemoryManager?.getRegions() ?? null;
            } catch { }
        }
        return cachedRegions;
    };

    // IDirectDrawSurface4_QueryInterface - can query IDirectDrawSurface7
    exports["IDirectDrawSurface4_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;

        const iidBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            iidBytes[i] = mem[riidPtr + i];
        }
        const iidStr = bytesToGuid(iidBytes);
        const normalizedIid = iidStr.replace(/[{}]/g, "").toLowerCase();

        Logger.log(LogCategory.COM, `IDirectDrawSurface4_QueryInterface: this=0x${thisPtr.toString(16)} iid=${iidStr} ppvObject=0x${ppvObject.toString(16)}`);

        if (!obj) {
            // TOLERANCE: Some games call QueryInterface on already-released surfaces
            // This is use-after-free bug in the app, but we handle it gracefully
            Logger.verbose(LogCategory.COM,
                `IDirectDrawSurface4_QueryInterface: Surface 0x${thisPtr.toString(16)} not found ` +
                `(already released?) - returning E_POINTER`
            );
            if (ppvObject) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppvObject, 0, true);
            }
            return E_POINTER; // Graceful degradation - indicate invalid object pointer
        }

        // Can query IDirectDrawSurface7 (tear-off)
        if (normalizedIid === IID_IDirectDrawSurface7.toLowerCase()) {
            const vtableAddr = context.vtables.IDirectDrawSurface7?.address;
            if (!vtableAddr) return E_NOINTERFACE;

            const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppvObject, objAddr, true);
            context.resourceProvider.mapAddressToHandle(objAddr, obj.handle);
            obj.addRef();

            Logger.log(LogCategory.SYSTEM, `IDirectDrawSurface4_QueryInterface -> Created IDirectDrawSurface7 at 0x${objAddr.toString(16)} via tear-off`);
            return DD_OK;
        }

        // Texture interfaces (same as Surface7)
        if (
            normalizedIid === IID_IDirect3DTexture.toLowerCase() ||
            normalizedIid === IID_IDirect3DTexture2.toLowerCase()
        ) {
            return exports["IDirectDrawSurface7_QueryInterface"]?.(ctx, mem, args) ?? E_NOINTERFACE;
        }

        // IDirectDrawGammaControl (queried on primary surface by some DX6 titles)
        if (normalizedIid === IID_IDirectDrawGammaControl.toLowerCase()) {
            const vtableAddr = context.vtables.IDirectDrawGammaControl?.address;
            if (!vtableAddr) {
                Logger.verbose(LogCategory.DDRAW,
                    `IDirectDrawSurface4_QI(GammaControl): no vtable registered`);
                return E_NOINTERFACE;
            }

            const gammaObj = ComObjectFactory.create(IID_IDirectDrawGammaControl, vtableAddr, obj.handle) as DirectDrawGammaControlObject | null;
            if (!gammaObj) {
                Logger.verbose(LogCategory.DDRAW,
                    `IDirectDrawSurface4_QI(GammaControl): ComObjectFactory.create returned null`);
                return E_FAIL;
            }

            const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppvObject, objAddr, true);
            context.resourceProvider.mapAddressToHandle(objAddr, gammaObj.handle);

            Logger.verbose(LogCategory.DDRAW,
                `IDirectDrawSurface4_QI(GammaControl) -> obj=0x${objAddr.toString(16)}`);
            return DD_OK;
        }

        return obj.queryInterface(iidStr, ppvObject, mem);
    };

    exports["IDirectDrawSurface4_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirectDrawSurface4_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    // IDirectDrawSurface4_GetSurfaceDesc - uses DDSURFACEDESC2 (same as Surface7)
    exports["IDirectDrawSurface4_GetSurfaceDesc"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDSurfaceDesc = args[1];
        if (!lpDDSurfaceDesc) return E_POINTER;
        if (!isValidAddress(mem, lpDDSurfaceDesc, 4)) return E_POINTER;

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const state = obj.getState();

        const estimatedSize = state.pitch * state.height;
        if (state.surfacePtr > 0 && !isValidAddress(mem, state.surfacePtr, estimatedSize)) {
            Logger.error(
                LogCategory.DDRAW,
                `IDirectDrawSurface4_GetSurfaceDesc: CORRUPTED surfacePtr=0x${state.surfacePtr.toString(16)} detected, refusing to expose`
            );
            return E_FAIL;
        }

        // Read caller's dwSize to preserve it (caller fills it before call)
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const callerSize = view.getUint32(lpDDSurfaceDesc + DDSURFACEDESC2_OFFSETS.size, true);

        writeSurfaceDesc(mem, lpDDSurfaceDesc, {
            size: callerSize || DDSURFACEDESC2_SIZE, // Preserve caller's size or use default
            flags: 0, // Will be set by writeSurfaceDesc based on what we write
            width: state.width,
            height: state.height,
            pitch: state.pitch,
            backBufferCount: 0,
            caps: state.caps,
            surfacePtr: state.surfacePtr,
            pixelFormat: state.format,
        });

        return DD_OK;
    };

    // IDirectDrawSurface (v1) methods
    exports["IDirectDrawSurface_QueryInterface"] = (ctx, mem, args) => {
        // Delegate to Surface7 for now (can query Surface4/7)
        return exports["IDirectDrawSurface7_QueryInterface"]?.(ctx, mem, args) ?? E_NOINTERFACE;
    };

    exports["IDirectDrawSurface_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirectDrawSurface_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    // IDirectDrawSurface_GetSurfaceDesc - uses DDSURFACEDESC (v1 structure)
    exports["IDirectDrawSurface_GetSurfaceDesc"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDSurfaceDesc = args[1];
        if (!lpDDSurfaceDesc) return E_POINTER;
        if (!isValidAddress(mem, lpDDSurfaceDesc, 4)) return E_POINTER;

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const state = obj.getState();

        const estimatedSize = state.pitch * state.height;
        if (state.surfacePtr > 0 && !isValidAddress(mem, state.surfacePtr, estimatedSize)) {
            Logger.error(
                LogCategory.DDRAW,
                `IDirectDrawSurface_GetSurfaceDesc: CORRUPTED surfacePtr=0x${state.surfacePtr.toString(16)} detected, refusing to expose`
            );
            return E_FAIL;
        }

        // Read caller's dwSize to preserve it (caller fills it before call)
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const callerSize = view.getUint32(lpDDSurfaceDesc + DDSURFACEDESC_OFFSETS.size, true);

        // IDirectDrawSurface (v1) uses DDSURFACEDESC (v1 structure) - 108 bytes
        writeSurfaceDescV1(mem, lpDDSurfaceDesc, {
            size: callerSize || DDSURFACEDESC_SIZE, // Preserve caller's size or use default
            flags: 0, // Will be set by writeSurfaceDescV1 based on what we write
            width: state.width,
            height: state.height,
            pitch: state.pitch,
            backBufferCount: 0,
            caps: state.caps,
            surfacePtr: state.surfacePtr,
            pixelFormat: state.format,
        });

        return DD_OK;
    };

    exports["IDirectDrawSurface7_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;

        const iidBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            iidBytes[i] = mem[riidPtr + i];
        }
        const iidStr = bytesToGuid(iidBytes);
        const normalizedIid = iidStr.replace(/[{}]/g, "").toLowerCase();

        Logger.log(LogCategory.COM, `IDirectDrawSurface7_QueryInterface: this=0x${thisPtr.toString(16)} iid=${iidStr} ppvObject=0x${ppvObject.toString(16)} obj=${obj ? obj.constructor.name : 'null'}`);

        if (!obj) {
            // TOLERANCE: Some games call QueryInterface on already-released surfaces
            // This is use-after-free bug in the app, but we handle it gracefully
            Logger.verbose(LogCategory.COM,
                `IDirectDrawSurface7_QueryInterface: Surface 0x${thisPtr.toString(16)} not found ` +
                `(already released?) - returning E_POINTER`
            );
            if (ppvObject) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppvObject, 0, true);
            }
            return E_POINTER; // Graceful degradation - indicate invalid object pointer
        }

        if (
            normalizedIid === IID_IDirect3DTexture.toLowerCase() ||
            normalizedIid === IID_IDirect3DTexture2.toLowerCase()
        ) {
            const isTexture2 = normalizedIid === IID_IDirect3DTexture2.toLowerCase();
            if (!ppvObject || !isValidAddress(mem, ppvObject, 4)) {
                return E_POINTER;
            }
            const vtableKey = isTexture2 ? "IDirect3DTexture2" : "IDirect3DTexture";
            const vtableAddr = context.vtables[vtableKey]?.address;
            if (!vtableAddr) {
                return E_NOINTERFACE;
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Track query counts per surface to estimate texture usage
            const prevCount = textureQueryCounts.get(thisPtr) ?? 0;
            const nextCount = prevCount + 1;
            textureQueryCounts.set(thisPtr, nextCount);


            // COM Identity: Check if we already have a cached texture interface for this surface
            const cachedHandle = isTexture2 ? obj.getCachedTexture2Handle() : obj.getCachedTextureHandle();
            if (cachedHandle) {
                const cachedTexObj = context.resourceProvider.getComObject(cachedHandle);
                if (cachedTexObj) {
                    // Return cached object with AddRef (COM Identity)
                    cachedTexObj.addRef();
                    const cachedAddr = context.resourceProvider.getAddressForHandle(cachedHandle);
                    if (cachedAddr) {
                        view.setUint32(ppvObject, cachedAddr, true);
                        Logger.log(LogCategory.DDRAW, `IDirectDrawSurface7_QueryInterface: Returning cached ${vtableKey} objAddr=0x${cachedAddr.toString(16)} surfaceAddr=0x${thisPtr.toString(16)} handle=0x${cachedHandle.toString(16)} newRefCount=${cachedTexObj.refCount} qCount=${nextCount}`);
                        return DD_OK;
                    }
                }
                // Cached handle is stale, clear it
                if (isTexture2) {
                    obj.setCachedTexture2Handle(0);
                } else {
                    obj.setCachedTextureHandle(0);
                }
            }

            // Create new texture interface object
            // Pass surfaceHandle directly to constructor to avoid initialization race
            // Constructor will immediately set surfaceHandle and call addRef() on Surface
            // This ensures object is never in an uninitialized state
            const texObj = ComObjectFactory.create(normalizedIid, vtableAddr, obj.handle);
            if (!texObj) {
                return E_FAIL;
            }

            // Verify that surfaceHandle was set correctly in constructor
            if (texObj instanceof Direct3DTextureObject || texObj instanceof Direct3DTexture2Object) {
                const surfaceAddr = texObj.getSurfaceAddr();
                if (surfaceAddr !== thisPtr) {
                    Logger.warn(LogCategory.DDRAW, `IDirectDrawSurface7_QueryInterface: surfaceAddr mismatch! Expected 0x${thisPtr.toString(16)} but got 0x${surfaceAddr.toString(16)}`);
                } else {
                    Logger.verbose(LogCategory.DDRAW, `IDirectDrawSurface7_QueryInterface: Verified surfaceAddr=0x${surfaceAddr.toString(16)} matches surface 0x${thisPtr.toString(16)}`);
                }
                Logger.verbose(LogCategory.COM, `IDirectDrawSurface7_QueryInterface: Linked ${vtableKey} to SurfaceObject (handle=0x${obj.handle.toString(16)}, refcount already increased by constructor)`);
            }

            const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
            view.setUint32(ppvObject, objAddr, true);
            context.resourceProvider.mapAddressToHandle(objAddr, texObj.handle);

            // Cache the texture handle for COM Identity
            if (isTexture2) {
                obj.setCachedTexture2Handle(texObj.handle);
                texture2CreateCount++;
            } else {
                obj.setCachedTextureHandle(texObj.handle);
                textureCreateCount++;
            }

            // Log when surface is queried for texture interface
            Logger.log(LogCategory.DDRAW, `IDirectDrawSurface7_QueryInterface: Created ${vtableKey} objAddr=0x${objAddr.toString(16)} surfaceAddr=0x${thisPtr.toString(16)} handle=0x${texObj.handle.toString(16)} qCount=${nextCount} totals: tex2=${texture2CreateCount} tex1=${textureCreateCount}`);

            return DD_OK;
        }

        // IDirectDrawGammaControl (queried on primary surface by some DX6 titles)
        if (normalizedIid === IID_IDirectDrawGammaControl.toLowerCase()) {
            const vtableAddr = context.vtables.IDirectDrawGammaControl?.address;
            if (!vtableAddr) return E_NOINTERFACE;

            const gammaObj = ComObjectFactory.create(IID_IDirectDrawGammaControl, vtableAddr, obj.handle) as DirectDrawGammaControlObject | null;
            if (!gammaObj) return E_FAIL;

            const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppvObject, objAddr, true);
            context.resourceProvider.mapAddressToHandle(objAddr, gammaObj.handle);

            Logger.log(LogCategory.DDRAW,
                `IDirectDrawSurface7_QueryInterface -> Created IDirectDrawGammaControl at 0x${objAddr.toString(16)}`);
            return DD_OK;
        }

        // Device GUID on a surface = the DX2/3 way to create a D3D device, with THIS
        // surface as the render target (IDirect3D::CreateDevice only arrived in DX5).
        // Every rasterizer GUID lands on the same device; we have one renderer.
        if (
            normalizedIid === IID_IDirect3DHALDevice.toLowerCase() ||
            normalizedIid === IID_IDirect3DRGBDevice.toLowerCase() ||
            normalizedIid === IID_IDirect3DRampDevice.toLowerCase() ||
            normalizedIid === IID_IDirect3DMMXDevice.toLowerCase()
        ) {
            if (!ppvObject || !isValidAddress(mem, ppvObject, 4)) return E_POINTER;

            const vtableAddr = context.vtables.IDirect3DDevice?.address;
            if (!vtableAddr) return E_NOINTERFACE;

            // Device3Object for the full state (transforms/render states/viewport),
            // presented over the v1 vtable — same split as IDirect3D2_CreateDevice.
            const devObj = ComObjectFactory.create(IID_IDirect3DDevice3, vtableAddr) as Direct3DDevice3Object | null;
            if (!devObj) return E_FAIL;

            devObj.setRenderTarget(thisPtr);
            obj.addRef(); // the device holds a reference on its render target

            // D3DRENDERSTATE_COLORKEYENABLE did not exist before DX5: on a v1 device a
            // texture that carries a source colour key IS keyed, with no state to turn
            // that off. Gating on the render state (default 0) makes every keyed sprite
            // of an execute-buffer title paint its key colour as an opaque block.
            devObj.setRenderState(D3DRENDERSTATE_COLORKEYENABLE, 1);

            const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppvObject, objAddr, true);
            context.resourceProvider.mapAddressToHandle(objAddr, devObj.handle);

            Logger.log(LogCategory.DDRAW,
                `IDirectDrawSurface7_QueryInterface -> Created IDirect3DDevice (v1) at 0x${objAddr.toString(16)} ` +
                `rt=0x${thisPtr.toString(16)} iid=${iidStr}`);
            return DD_OK;
        }

        return obj.queryInterface(iidStr, ppvObject, mem);
    };

    exports["IDirectDrawSurface7_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirectDrawSurface7_Release"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr);
        if (obj) {
            return obj.release();
        }
        return 0;
    };

    exports["IDirectDrawSurface7_GetSurfaceDesc"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDSurfaceDesc = args[1];
        if (!lpDDSurfaceDesc) return E_POINTER;
        if (!isValidAddress(mem, lpDDSurfaceDesc, 4)) return E_POINTER;

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const state = obj.getState();

        const estimatedSize = state.pitch * state.height;
        if (state.surfacePtr > 0 && !isValidAddress(mem, state.surfacePtr, estimatedSize)) {
            Logger.error(
                LogCategory.DDRAW,
                `IDirectDrawSurface7_GetSurfaceDesc: CORRUPTED surfacePtr=0x${state.surfacePtr.toString(16)} detected, refusing to expose`
            );
            return E_FAIL;
        }

        // Read caller's dwSize to preserve it (caller fills it before call)
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const callerSize = view.getUint32(lpDDSurfaceDesc + DDSURFACEDESC2_OFFSETS.size, true);

        writeSurfaceDesc(mem, lpDDSurfaceDesc, {
            size: callerSize || DDSURFACEDESC2_SIZE, // Preserve caller's size or use default
            flags: 0, // Will be set by writeSurfaceDesc based on what we write
            width: state.width,
            height: state.height,
            pitch: state.pitch,
            backBufferCount: 0,
            caps: state.caps,
            surfacePtr: state.surfacePtr,
            pixelFormat: state.format,
        });

        return DD_OK;
    };

    // IDirectDrawSurface4_Lock - Uses DDSURFACEDESC2 (same as Surface7), but different vtable slot
    // PERF: Sync-by-default — only returns Promise when GPU readback is actually needed.
    // D2's SYSMEM surfaces never need readback, avoiding ~700us async overhead per call.
    exports["IDirectDrawSurface4_Lock"] = (ctx, mem, args): number | Promise<number> => {
        const thisPtr = args[0];
        const lpDestRect = args[1];
        const lpDDSurfaceDesc = args[2];
        const dwFlags = args[3] || 0; // DDLOCK flags (READONLY, WRITEONLY, etc.)

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;
        if (!lpDDSurfaceDesc) return E_POINTER;
        if (!isValidAddress(mem, lpDDSurfaceDesc, 4)) return E_POINTER;

        const state = obj.getState();

        // SYNC: If GPU has current content and CPU doesn't, readback before game reads/writes pixels
        const isWriteOnly = (dwFlags & DDLOCK_WRITEONLY) !== 0;
        const isDiscard = (dwFlags & DDLOCK_DISCARDCONTENTS) !== 0;
        const learnedWriteOnly = lockTracker.shouldSkipReadback(thisPtr);
        const needsReadback = surfaceSyncManager.needsCPUSync(state).needed;

        // Helper: completes Lock after optional readback
        const completeLock = (didReadback: boolean, readbackTime: number): number => {
            // Read caller's dwSize to preserve it (caller fills it before call)
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const callerSize = view.getUint32(lpDDSurfaceDesc + DDSURFACEDESC2_OFFSETS.size, true);

            const estimatedSize = state.pitch * state.height;
            if (state.surfacePtr > 0 && !isValidAddress(mem, state.surfacePtr, estimatedSize)) {
                Logger.error(
                    LogCategory.DDRAW,
                    `IDirectDrawSurface4_Lock: CORRUPTED surfacePtr=0x${state.surfacePtr.toString(16)} detected ` +
                    `(points to protected region), refusing to expose to game to prevent memory corruption`
                );
                return E_FAIL;
            }

            let rect = lpDestRect ? readRect(mem, lpDestRect) : null;
            if (rect) {
                rect = clipRect(rect, state.width, state.height);
            }

            const desc = {
                size: callerSize || DDSURFACEDESC2_SIZE, // Preserve caller's size or use default
                flags: 0, // Will be set by writeSurfaceDesc based on what we write
                width: state.width,
                height: state.height,
                pitch: state.pitch,
                backBufferCount: 0,
                caps: state.caps,
                surfacePtr: state.surfacePtr,
                pixelFormat: state.format,
            };

            if (rect) {
                const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
                desc.width = rect.right - rect.left;
                desc.height = rect.bottom - rect.top;
                const offsetTop = rect.top * state.pitch;
                const offsetLeft = rect.left * bytesPerPixel;
                if (offsetTop < 0 || offsetLeft < 0 || offsetTop > 0x7FFFFFFF || offsetLeft > 0x7FFFFFFF) {
                    Logger.error(LogCategory.DDRAW, `IDirectDrawSurface4_Lock: integer overflow in pointer calculation`);
                    return E_FAIL;
                }
                const calculatedPtr = state.surfacePtr + offsetTop + offsetLeft;
                if (calculatedPtr < state.surfacePtr) {
                    Logger.error(LogCategory.DDRAW, `IDirectDrawSurface4_Lock: pointer addition overflow`);
                    return E_FAIL;
                }
                desc.surfacePtr = calculatedPtr;

                const adjustedSize = desc.height * state.pitch;
                if (!isValidAddress(mem, desc.surfacePtr, adjustedSize)) {
                    Logger.error(LogCategory.DDRAW, `IDirectDrawSurface4_Lock: adjusted surfacePtr overlaps protected region`);
                    return E_FAIL;
                }
            }

            const regions = getRegions();
            if (regions) {
                const finalPtr = desc.surfacePtr;
                const finalSize = desc.height * desc.pitch;
                const finalEnd = finalPtr + finalSize;
                const thunkEnd = regions.thunkGeneratorBase + regions.thunkGeneratorSize;
                const isInsideThunk = finalPtr >= regions.thunkGeneratorBase && finalPtr < thunkEnd;
                const overlapsThunk = finalPtr < thunkEnd && finalEnd > regions.thunkGeneratorBase;
                if (isInsideThunk || overlapsThunk) {
                    Logger.error(
                        LogCategory.DDRAW,
                        `IDirectDrawSurface4_Lock: surfacePtr overlaps thunk region`
                    );
                    return E_FAIL;
                }
            }

            // IDirectDrawSurface4 uses DDSURFACEDESC2 (same as Surface7)
            writeSurfaceDesc(mem, lpDDSurfaceDesc, desc);

            const isReadOnly = (dwFlags & DDLOCK_READONLY) !== 0;
            const leaseId = leaseRegistry.createLease(
                desc.surfacePtr,
                desc.height * desc.pitch,
                "IDirectDrawSurface4",
                isReadOnly ? "r" : "rw",
                {
                    pitch: desc.pitch,
                    rect: rect ?? undefined,
                    tag: `surface_${thisPtr.toString(16)}_lock`,
                }
            );
            state.activeLeaseId = leaseId;
            if (leaseId !== 0 && !isReadOnly && (state.caps & DDSCAPS_TEXTURE) !== 0) {
                captureActiveLeaseSnapshot(mem, state, leaseId);
            }

            // Primary front-buffer writes may be visible while locked on old renderers.
            // Textures are committed on Unlock after exact lease content comparison.
            if (!isReadOnly && isRenderSurface(state) && (state.caps & DDSCAPS_PRIMARYSURFACE) !== 0) {
                setAuthorityCpu(state);
            }

            // Track lock for optimization
            lockTracker.startLock(thisPtr, dwFlags, didReadback, readbackTime);

            return DD_OK;
        };

        // Same RT readback fix as Surface7 — WRITEONLY is advisory on real hardware
        const isRT = isRenderSurface(state);
        const forceReadbackForRT = isRT && needsReadback && !isDiscard;
        if (needsReadback && context.executor) {
            if (!forceReadbackForRT && (isWriteOnly || isDiscard || learnedWriteOnly)) {
                Logger.log(LogCategory.DDRAW,
                    `IDirectDrawSurface4_Lock: SKIP GPU→CPU readback for surface 0x${thisPtr.toString(16)} ` +
                    `(WRITEONLY=${isWriteOnly} DISCARD=${isDiscard} learned=${learnedWriteOnly})`
                );
            } else {
                if (context.executor.syncSurfaceToMemoryFromScratch(state, mem)) {
                    return completeLock(true, 0);
                }
                // Async path: GPU readback needed — return Promise
                Logger.log(LogCategory.DDRAW,
                    `IDirectDrawSurface4_Lock: Syncing GPU -> CPU for surface 0x${thisPtr.toString(16)} (authority=gpu)`
                );
                const before = performance.now();
                return context.executor.syncSurfaceToMemory(state).then((): number => {
                    const readbackTime = performance.now() - before;
                    return completeLock(true, readbackTime);
                });
            }
        }

        // Sync fast path (common case: SYSMEM surfaces, no GPU readback)
        return completeLock(false, 0);
    };

    // IDirectDrawSurface (v1) Lock - uses DDSURFACEDESC (v1 structure)
    // PERF: Sync-by-default — only returns Promise when GPU readback is actually needed.
    exports["IDirectDrawSurface_Lock"] = (ctx, mem, args): number | Promise<number> => {
        const thisPtr = args[0];
        const lpDestRect = args[1];
        const lpDDSurfaceDesc = args[2];
        const dwFlags = args[3] || 0; // DDLOCK flags (READONLY, WRITEONLY, etc.)

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;
        if (!lpDDSurfaceDesc) return E_POINTER;
        if (!isValidAddress(mem, lpDDSurfaceDesc, 4)) return E_POINTER;

        const state = obj.getState();

        // SYNC: If GPU has current content and CPU doesn't, readback before game reads/writes pixels
        const isWriteOnly = (dwFlags & DDLOCK_WRITEONLY) !== 0;
        const isDiscard = (dwFlags & DDLOCK_DISCARDCONTENTS) !== 0;
        const learnedWriteOnly = lockTracker.shouldSkipReadback(thisPtr);
        const needsReadback = surfaceSyncManager.needsCPUSync(state).needed;

        // Helper: completes Lock after optional readback
        const completeLock = (didReadback: boolean, readbackTime: number): number => {
            // Read caller's dwSize to preserve it (caller fills it before call)
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const callerSize = view.getUint32(lpDDSurfaceDesc + DDSURFACEDESC_OFFSETS.size, true);

            const estimatedSize = state.pitch * state.height;

            const regions = getRegions();
            Logger.verbose(
                LogCategory.DDRAW,
                `IDirectDrawSurface_Lock: surface=0x${thisPtr.toString(16)} surfacePtr=0x${state.surfacePtr.toString(16)} ` +
                `range=0x${state.surfacePtr.toString(16)}..0x${(state.surfacePtr + estimatedSize).toString(16)} ` +
                `size=${state.width}x${state.height} pitch=${state.pitch} estimatedSize=0x${estimatedSize.toString(16)} ` +
                (regions ? `THUNK=0x${regions.thunkGeneratorBase.toString(16)}..0x${(regions.thunkGeneratorBase + regions.thunkGeneratorSize).toString(16)}` : `THUNK=unknown`)
            );

            if (state.surfacePtr > 0 && !isValidAddress(mem, state.surfacePtr, estimatedSize)) {
                Logger.error(
                    LogCategory.DDRAW,
                    `IDirectDrawSurface_Lock: corrupted surfacePtr detected`
                );
                return E_FAIL;
            }

            let rect = lpDestRect ? readRect(mem, lpDestRect) : null;
            if (rect) {
                rect = clipRect(rect, state.width, state.height);
            }

            const desc = {
                size: callerSize || DDSURFACEDESC_SIZE, // Preserve caller's size or use default
                flags: 0, // Will be set by writeSurfaceDescV1 based on what we write
                width: state.width,
                height: state.height,
                pitch: state.pitch,
                backBufferCount: 0,
                caps: state.caps,
                surfacePtr: state.surfacePtr,
                pixelFormat: state.format,
            };

            if (rect) {
                const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
                desc.width = rect.right - rect.left;
                desc.height = rect.bottom - rect.top;
                const offsetTop = rect.top * state.pitch;
                const offsetLeft = rect.left * bytesPerPixel;
                const calculatedPtr = state.surfacePtr + offsetTop + offsetLeft;
                desc.surfacePtr = calculatedPtr;

                const adjustedSize = desc.height * state.pitch;
                const isValid = isValidAddress(mem, desc.surfacePtr, adjustedSize);
                if (!isValid) {
                    Logger.error(
                        LogCategory.DDRAW,
                        `IDirectDrawSurface_Lock: adjusted surfacePtr overlaps protected region`
                    );
                    return E_FAIL;
                }
            }

            if (regions) {
                const finalPtr = desc.surfacePtr;
                const finalSize = desc.height * desc.pitch;
                const finalEnd = finalPtr + finalSize;
                const thunkEnd = regions.thunkGeneratorBase + regions.thunkGeneratorSize;
                const isInsideThunk = finalPtr >= regions.thunkGeneratorBase && finalPtr < thunkEnd;
                const overlapsThunk = finalPtr < thunkEnd && finalEnd > regions.thunkGeneratorBase;
                if (isInsideThunk || overlapsThunk) {
                    Logger.error(
                        LogCategory.DDRAW,
                        `IDirectDrawSurface_Lock: surfacePtr overlaps thunk region`
                    );
                    return E_FAIL;
                }
            }

            // IDirectDrawSurface (v1) uses DDSURFACEDESC (v1 structure) - 108 bytes
            writeSurfaceDescV1(mem, lpDDSurfaceDesc, desc);

            const isReadOnly = (dwFlags & DDLOCK_READONLY) !== 0;
            const leaseId = leaseRegistry.createLease(
                desc.surfacePtr,
                desc.height * desc.pitch,
                "IDirectDrawSurface",
                isReadOnly ? "r" : "rw",
                {
                    pitch: desc.pitch,
                    rect: rect ?? undefined,
                    tag: `surface_${thisPtr.toString(16)}_lock`,
                }
            );
            state.activeLeaseId = leaseId;
            if (leaseId !== 0 && !isReadOnly && (state.caps & DDSCAPS_TEXTURE) !== 0) {
                captureActiveLeaseSnapshot(mem, state, leaseId);
            }

            // Primary front-buffer writes may be visible while locked on old renderers.
            // Textures are committed on Unlock after exact lease content comparison.
            if (!isReadOnly && isRenderSurface(state) && (state.caps & DDSCAPS_PRIMARYSURFACE) !== 0) {
                setAuthorityCpu(state);
            }

            // Track lock for optimization
            lockTracker.startLock(thisPtr, dwFlags, didReadback, readbackTime);

            return DD_OK;
        };

        // Same RT readback fix — WRITEONLY is advisory on real hardware
        const isRT_v1 = isRenderSurface(state);
        const forceReadbackForRT_v1 = isRT_v1 && needsReadback && !isDiscard;
        if (needsReadback && context.executor) {
            if (!forceReadbackForRT_v1 && (isWriteOnly || isDiscard || learnedWriteOnly)) {
                Logger.log(LogCategory.DDRAW,
                    `IDirectDrawSurface_Lock: SKIP GPU→CPU readback for surface 0x${thisPtr.toString(16)} ` +
                    `(WRITEONLY=${isWriteOnly} DISCARD=${isDiscard} learned=${learnedWriteOnly})`
                );
            } else {
                if (context.executor.syncSurfaceToMemoryFromScratch(state, mem)) {
                    return completeLock(true, 0);
                }
                // Async path: GPU readback needed — return Promise
                Logger.log(LogCategory.DDRAW,
                    `IDirectDrawSurface_Lock: Syncing GPU -> CPU for surface 0x${thisPtr.toString(16)} (authority=gpu)`
                );
                const before = performance.now();
                return context.executor.syncSurfaceToMemory(state).then((): number => {
                    const readbackTime = performance.now() - before;
                    return completeLock(true, readbackTime);
                });
            }
        }

        // Sync fast path (common case: SYSMEM surfaces, no GPU readback)
        return completeLock(false, 0);
    };

    // IDirectDrawSurface7_Lock — sync-by-default, Promise only when GPU readback needed.
    // Declaring the handler as `async` forces every call through the async-thunk spin-loop
    // even for pure sysmem temps (which dominate texture-load paths in D3D7 titles —
    // the inner mipmap loop creates a sysmem surrogate and locks it
    // hundreds of times per scene). The cumulative async-restore churn wedges main-thread
    // progress. Mirror the pattern already used by IDirectDrawSurface4_Lock / _Surface_Lock
    // and IDirect3DTexture_Load.
    exports["IDirectDrawSurface7_Lock"] = (ctx, mem, args): ThunkResult | Promise<ThunkResult> => {
        const lockStart = performance.now();
        profiler.start("Lock");
        profiler.start("Lock:setup");

        const thisPtr = args[0];
        const lpDestRect = args[1];
        const lpDDSurfaceDesc = args[2];
        const dwFlags = args[3] || 0; // DDLOCK flags (READONLY, WRITEONLY, etc.)

        // DIAGNOSTIC: Log all args to catch potential offset issues
        const isStackAddr = (addr: number) => addr >= 0x80000 && addr < 0x100000;
        Logger.verboseLazy(LogCategory.DDRAW, () =>
            `IDirectDrawSurface7_Lock ARGS: this=0x${thisPtr.toString(16)} ` +
            `lpDestRect=0x${lpDestRect.toString(16)}${isStackAddr(lpDestRect) ? '(STACK)' : ''} ` +
            `lpDDSurfaceDesc=0x${lpDDSurfaceDesc.toString(16)}${isStackAddr(lpDDSurfaceDesc) ? '(STACK)' : ''} ` +
            `dwFlags=0x${dwFlags.toString(16)} ESP=0x${ctx.esp.toString(16)}`
        );

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) {
            profiler.end("Lock:setup");
            profiler.end("Lock");
            return { value: E_FAIL, stackCleanup: 20 };
        }
        if (!lpDDSurfaceDesc) {
            profiler.end("Lock:setup");
            profiler.end("Lock");
            return { value: E_POINTER, stackCleanup: 20 };
        }
        if (!isValidAddress(mem, lpDDSurfaceDesc, 4)) {
            profiler.end("Lock:setup");
            profiler.end("Lock");
            return { value: E_POINTER, stackCleanup: 20 };
        }

        const state = obj.getState();
        profiler.end("Lock:setup");
        const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;

        // Extract lock flags once at the beginning
        const isReadOnly = (dwFlags & DDLOCK_READONLY) !== 0;
        const isWriteOnly = (dwFlags & DDLOCK_WRITEONLY) !== 0;
        const isDiscard = (dwFlags & DDLOCK_DISCARDCONTENTS) !== 0;

        const system = System.getInstance();
        const gdiContext = system.gdiContext;
        const hdc = gdiContext.getHDCBySurface(thisPtr);
        if (hdc && gdiContext.isDirty(hdc)) {
            Logger.log(LogCategory.DDRAW, `IDirectDrawSurface7_Lock: Syncing Canvas -> CPU for surface 0x${thisPtr.toString(16)} (Canvas dirty=true)`);
            syncActiveGdiContext(state, thisPtr, mem);
            gdiContext.clearDirty(hdc);
        }
        profiler.end("Lock:gdiSync");

        // Check if GPU has authoritative data that needs readback before game accesses guest memory.
        // This covers BOTH GPU_ONLY and CPU-mode surfaces where D3D rendered after a previous Lock
        // (e.g., EndScene writes to backbuffer GPU texture, then game Locks backbuffer for GDI text).
        const learnedWriteOnly = lockTracker.shouldSkipReadback(thisPtr);
        const needsReadback = surfaceSyncManager.needsCPUSync(state).needed;

        // On real hardware, WRITEONLY is advisory — the lock buffer still
        // contains GPU-rendered pixels. In our emulation GPU/CPU memory are separate, so for
        // render targets we must always readback (except DISCARDCONTENTS which explicitly opts out).
        const isRT = isRenderSurface(state);
        const forceReadbackForRT = isRT && needsReadback && !isDiscard;
        const needsAsyncReadback = needsReadback && !!context.executor &&
            (forceReadbackForRT || (!isWriteOnly && !isDiscard && !learnedWriteOnly));

        // Tail of the Lock operation — runs after optional GPU readback. Updates surface
        // authority state, validates the pointer, writes DDSURFACEDESC2, and registers the
        // lock lease. Split out so the sync path (no readback) skips Promise overhead.
        const finalize = (didReadback: boolean, readbackTime: number): ThunkResult => {
            if (isTexture) {
                Logger.log(LogCategory.DDRAW, 
                    `Lock TEXTURE: surface=0x${thisPtr.toString(16)} ptr=0x${state.surfacePtr.toString(16)} ` +
                    `flags=0x${dwFlags.toString(16)} mode=${isRenderSurface(state) ? state.mode : "bitmap"}`);
            }
            profiler.start("Lock:demotion");
            if (didReadback) {
                // Demote GPU_ONLY → CPU on first lock
                if (isRenderSurface(state) && state.mode === "GPU_ONLY") {
                    state.mode = "CPU";
                }
                if (isRenderSurface(state)) {
                    state.everLocked = true;
                }
                lockTracker.startLock(thisPtr, dwFlags, true, readbackTime);
            } else if (isRenderSurface(state)) {
                if (!isReadOnly) {
                    // A writable Lock hands the app a CPU pointer to the surface bits. Per
                    // DirectDraw semantics the app owns those bits until Unlock and may write them
                    // through the returned pointer at any point, including the common
                    // Lock-to-acquire-pointer then write-through-the-retained-pointer pattern. So a
                    // write Lock is itself the signal that the surface holds (or will hold) app
                    // pixels — mark it locked-for-write so the GPU sync path treats its CPU memory as
                    // authoritable and never strands it as a never-written "empty texture". Whether
                    // the bytes actually changed (version/surfaceEverWritten) is decided separately
                    // by the Unlock content comparison.
                    state.everLocked = true;
                    if (state.mode === "GPU_ONLY") {
                        state.mode = "CPU";
                        Logger.log(LogCategory.DDRAW,
                            `IDirectDrawSurface7_Lock: Demoted GPU_ONLY → CPU (write lock, everLocked=true)`
                        );
                    }
                } else if (state.mode === "GPU_ONLY") {
                    Logger.verbose(LogCategory.DDRAW,
                        `IDirectDrawSurface7_Lock: Read-only lock on GPU_ONLY surface - keeping GPU_ONLY mode ` +
                        `surface=0x${thisPtr.toString(16)} (${state.width}x${state.height})`
                    );
                }
                lockTracker.startLock(thisPtr, dwFlags, false, 0);
            } else {
                lockTracker.startLock(thisPtr, dwFlags, false, 0);
            }
            profiler.end("Lock:demotion");

            return finalizeLock();
        };

        // The massive validation/writeDesc/lease/return block stays inline (it closes over
        // many locals), wrapped in a thunk-returning function so both paths share it.
        const finalizeLock = (): ThunkResult => {
        profiler.start("Lock:validation");
        // Read caller's dwSize to preserve it (caller fills it before call)
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const callerSize = view.getUint32(lpDDSurfaceDesc + DDSURFACEDESC2_OFFSETS.size, true);

        // DIAGNOSTIC: Check if dwSize looks valid - invalid values suggest pointer confusion
        if (callerSize !== 108 && callerSize !== 124) {
            const peek = [];
            for (let i = 0; i < 16; i += 4) {
                peek.push(`0x${view.getUint32(lpDDSurfaceDesc + i, true).toString(16)}`);
            }
            Logger.warn(LogCategory.DDRAW,
                `⚠️ IDirectDrawSurface7_Lock: lpDDSurfaceDesc=0x${lpDDSurfaceDesc.toString(16)} has INVALID dwSize=${callerSize} ` +
                `(expected 108 or 124). First 16 bytes: [${peek.join(', ')}]. ` +
                `Possible pointer confusion or uninitialized struct!`);
        }

        const estimatedSize = state.pitch * state.height;

        // Check if surfacePtr is safe for surface use (not in THUNK_CODE or other protected regions)
        if (state.surfacePtr > 0 && !isSafeSurfaceAddress(state.surfacePtr, estimatedSize)) {
            Logger.error(
                LogCategory.DDRAW,
                `🚨 IDirectDrawSurface7_Lock: REFUSING Lock - surfacePtr=0x${state.surfacePtr.toString(16)} ` +
                `size=0x${estimatedSize.toString(16)} is not safe for surface use! ` +
                `This would allow game to corrupt protected memory. surface=0x${thisPtr.toString(16)} size=${state.width}x${state.height}`);
            profiler.end("Lock:validation");
            profiler.end("Lock");
            return { value: E_FAIL, stackCleanup: 20 };
        }

        if (state.surfacePtr > 0 && !isValidAddress(mem, state.surfacePtr, estimatedSize)) {
            Logger.error(
                LogCategory.DDRAW,
                `IDirectDrawSurface7_Lock: CORRUPTED surfacePtr=0x${state.surfacePtr.toString(16)} detected, refusing to expose to game`
            );
            profiler.end("Lock:validation");
            profiler.end("Lock");
            return { value: E_FAIL, stackCleanup: 20 };
        }
        profiler.end("Lock:validation");

        profiler.start("Lock:rectCalc");
        let rect = lpDestRect ? readRect(mem, lpDestRect) : null;
        if (rect) {
            rect = clipRect(rect, state.width, state.height);
        }

        const desc = {
            size: callerSize || DDSURFACEDESC2_SIZE, // Preserve caller's size or use default
            flags: 0, // Will be set by writeSurfaceDesc based on what we write
            width: state.width,
            height: state.height,
            pitch: state.pitch,
            backBufferCount: 0,
            caps: state.caps,
            surfacePtr: state.surfacePtr,
            pixelFormat: state.format,
        };

        if (rect) {
            const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
            desc.width = rect.right - rect.left;
            desc.height = rect.bottom - rect.top;
            const offsetTop = rect.top * state.pitch;
            const offsetLeft = rect.left * bytesPerPixel;

            // Check for integer overflow and THUNK_CODE overlap
            if (offsetTop < 0 || offsetLeft < 0 || offsetTop > 0x7FFFFFFF || offsetLeft > 0x7FFFFFFF) {
                Logger.error(LogCategory.DDRAW,
                    `🚨 IDirectDrawSurface7_Lock: integer overflow in rect offset calculation! ` +
                    `rect.top=${rect.top} rect.left=${rect.left} pitch=${state.pitch} bpp=${bytesPerPixel} ` +
                    `offsetTop=0x${offsetTop.toString(16)} offsetLeft=0x${offsetLeft.toString(16)}`);
                return { value: E_FAIL, stackCleanup: 20 };
            }

            const calculatedPtr = state.surfacePtr + offsetTop + offsetLeft;

            // Check for pointer addition overflow
            if (calculatedPtr < state.surfacePtr || calculatedPtr < 0 || calculatedPtr > 0xFFFFFFFF) {
                Logger.error(LogCategory.DDRAW,
                    `🚨 IDirectDrawSurface7_Lock: pointer addition overflow! ` +
                    `base=0x${state.surfacePtr.toString(16)} offsetTop=0x${offsetTop.toString(16)} ` +
                    `offsetLeft=0x${offsetLeft.toString(16)} result=0x${calculatedPtr.toString(16)}`);
                return { value: E_FAIL, stackCleanup: 20 };
            }

            const adjustedSize = desc.height * state.pitch;

            // Check if adjusted pointer is safe for surface use
            if (!isSafeSurfaceAddress(calculatedPtr, adjustedSize)) {
                Logger.error(LogCategory.DDRAW,
                    `🚨 IDirectDrawSurface7_Lock: adjusted surfacePtr=0x${calculatedPtr.toString(16)} ` +
                    `size=0x${adjustedSize.toString(16)} is not safe for surface use! ` +
                    `base=0x${state.surfacePtr.toString(16)} rect=(${rect.left},${rect.top},${rect.right},${rect.bottom})`);
                profiler.end("Lock:rectCalc");
                profiler.end("Lock");
                return { value: E_FAIL, stackCleanup: 20 };
            }

            desc.surfacePtr = calculatedPtr;

            const isValid = isValidAddress(mem, desc.surfacePtr, adjustedSize);
            if (!isValid) {
                Logger.error(
                    LogCategory.DDRAW,
                    `IDirectDrawSurface7_Lock: adjusted surfacePtr overlaps protected region`
                );
                profiler.end("Lock:rectCalc");
                profiler.end("Lock");
                return { value: E_FAIL, stackCleanup: 20 };
            }
        }
        profiler.end("Lock:rectCalc");

        profiler.start("Lock:regions");
        // Final validation before exposing pointer to game
        const finalRegions = getRegions();
        if (finalRegions) {
            const finalPtr = desc.surfacePtr;
            const finalSize = desc.height * desc.pitch;
            const finalEnd = finalPtr + finalSize;
            const thunkEnd = finalRegions.thunkGeneratorBase + finalRegions.thunkGeneratorSize;
            const isInsideThunk = finalPtr >= finalRegions.thunkGeneratorBase && finalPtr < thunkEnd;
            const overlapsThunk = finalPtr < thunkEnd && finalEnd > finalRegions.thunkGeneratorBase;
            if (isInsideThunk || overlapsThunk) {
                Logger.error(
                    LogCategory.DDRAW,
                    `IDirectDrawSurface7_Lock: surfacePtr overlaps thunk region`
                );
                profiler.end("Lock:regions");
                profiler.end("Lock");
                return { value: E_FAIL, stackCleanup: 20 };
            }
        }
        profiler.end("Lock:regions");

        profiler.start("Lock:writeDesc");
        writeSurfaceDesc(mem, lpDDSurfaceDesc, desc);
        profiler.end("Lock:writeDesc");

        // DIAGNOSTIC: ALWAYS verify lpSurface was written correctly (not just for textures)
        const writtenLpSurface = view.getUint32(lpDDSurfaceDesc + 36, true); // offset 36 = lpSurface
        const writtenPitch = view.getUint32(lpDDSurfaceDesc + 16, true); // offset 16 = pitch
        const writtenFlags = view.getUint32(lpDDSurfaceDesc + 4, true); // offset 4 = flags

        // If we accidentally wrote a THUNK_CODE address, ABORT immediately!
        if (writtenLpSurface > 0 && overlapsThunkCode(writtenLpSurface, writtenPitch * state.height)) {
            Logger.error(LogCategory.DDRAW,
                `🚨🚨🚨 IDirectDrawSurface7_Lock: WE WROTE A THUNK_CODE ADDRESS TO lpSurface! ` +
                `This is a BUG in writeSurfaceDesc or desc.surfacePtr calculation! ` +
                `surface=0x${thisPtr.toString(16)} lpDDSurfaceDesc=0x${lpDDSurfaceDesc.toString(16)} ` +
                `desc.surfacePtr=0x${desc.surfacePtr.toString(16)} writtenLpSurface=0x${writtenLpSurface.toString(16)}`);
            profiler.end("Lock");
            return { value: E_FAIL, stackCleanup: 20 };
        }

        profiler.start("Lock:lease");
        const leaseId = leaseRegistry.createLease(
            desc.surfacePtr,
            desc.height * desc.pitch,
            "IDirectDrawSurface7",
            isReadOnly ? "r" : "rw",
            {
                pitch: desc.pitch,
                rect: rect ?? undefined,
                tag: `surface_${thisPtr.toString(16)}_lock`,
            }
        );
        state.activeLeaseId = leaseId;
        if (leaseId !== 0 && !isReadOnly && (state.caps & DDSCAPS_TEXTURE) !== 0) {
            captureActiveLeaseSnapshot(mem, state, leaseId);
        }

        // Primary front-buffer writes may be visible while locked on old renderers.
        // Textures are committed on Unlock after exact lease content comparison.
        if (!isReadOnly && isRenderSurface(state) && (state.caps & DDSCAPS_PRIMARYSURFACE) !== 0) {
            setAuthorityCpu(state);
        }

        // Track dirty region for partial uploads
        if (isRenderSurface(state) && !isReadOnly && rect) {
            if (!state.dirtyRegion) {
                state.dirtyRegion = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
            } else {
                // Expand to union of dirty rects
                state.dirtyRegion.left = Math.min(state.dirtyRegion.left, rect.left);
                state.dirtyRegion.top = Math.min(state.dirtyRegion.top, rect.top);
                state.dirtyRegion.right = Math.max(state.dirtyRegion.right, rect.right);
                state.dirtyRegion.bottom = Math.max(state.dirtyRegion.bottom, rect.bottom);
            }

            // Rect merge heuristic: if union covers >70% of surface, upgrade to full upload
            const dirtyArea = (state.dirtyRegion.right - state.dirtyRegion.left) *
                (state.dirtyRegion.bottom - state.dirtyRegion.top);
            const fullArea = state.width * state.height;

            // Track for diagnostics
            context.deferredUploadManager?.trackLock(true, dirtyArea);

            if (dirtyArea > fullArea * 0.7) {
                Logger.verbose(LogCategory.DDRAW,
                    `Lock: Dirty union is ${(dirtyArea / fullArea * 100).toFixed(0)}% of surface → upgrading to full upload`);
                state.dirtyRegion = { left: 0, top: 0, right: state.width, bottom: state.height };
            } else {
                Logger.verbose(LogCategory.DDRAW,
                    `Lock: Marked dirty rect ({${rect.left},${rect.top}}-{${rect.right},${rect.bottom}}) ` +
                    `union=({${state.dirtyRegion.left},${state.dirtyRegion.top}}-{${state.dirtyRegion.right},${state.dirtyRegion.bottom}}) ` +
                    `area=${(dirtyArea / fullArea * 100).toFixed(0)}%`);
            }
        } else if (isRenderSurface(state) && !isReadOnly && !rect) {
            // Full surface lock - mark entire surface dirty
            state.dirtyRegion = { left: 0, top: 0, right: state.width, bottom: state.height };
            // Track for diagnostics
            context.deferredUploadManager?.trackLock(false);
        }

        profiler.end("Lock:lease");

        // DIAGNOSTIC: Validate thunk code integrity after Lock (EXPENSIVE: ~1ms per call!)
        // Disabled in production (ENABLE_LOCK_THUNK_VALIDATION = false) — dead code below.
        // Kept for parity with the other _Unlock validation gates. Runs fire-and-forget so
        // this handler stays synchronous; violations still log an error.
        if (ENABLE_LOCK_THUNK_VALIDATION) {
            profiler.start("Lock:thunkValidation");
            void Promise.resolve(thunkChecksumManager.validateThunkRegion(mem, "IDirectDrawSurface7_Lock"))
                .then((valid) => {
                    profiler.end("Lock:thunkValidation");
                    if (!valid) {
                        Logger.error(LogCategory.DDRAW, "🚨 Thunk corruption detected AFTER Lock!");
                    }
                });
        }

        profiler.end("Lock");

        // Record lock event for variance diagnostics
        if (frameVarianceDiagnostics.isEnabled()) {
            const lockDuration = performance.now() - lockStart;
            const isTextureSurf = (state.caps & DDSCAPS_TEXTURE) !== 0;
            frameVarianceDiagnostics.recordEvent(
                'texture_lock',
                isTextureSurf ? 'texture' : 'surface',
                lockDuration
            );
        }

        return { value: DD_OK, stackCleanup: 20 };
        }; // end finalizeLock

        // Dispatch: sync when no GPU readback is needed, Promise chain otherwise.
        if (needsAsyncReadback) {
            if (context.executor!.syncSurfaceToMemoryFromScratch(state, mem)) {
                return finalize(true, 0);
            }
            const modeStr = isRenderSurface(state) ? state.mode : "bitmap";
            Logger.log(LogCategory.DDRAW,
                `IDirectDrawSurface7_Lock: GPU→CPU readback for surface 0x${thisPtr.toString(16)} ` +
                `(${state.width}x${state.height}) mode=${modeStr}`
            );
            const before = performance.now();
            return context.executor!.syncSurfaceToMemory(state).then((): ThunkResult => {
                return finalize(true, performance.now() - before);
            });
        }
        return finalize(false, 0);
    };

    exports["IDirectDrawSurface7_Unlock"] = (ctx, mem, args) => {
        const unlockStart = performance.now();
        const thisPtr = args[0];

        // DIAGNOSTIC: Validate THUNK integrity BEFORE any operations (EXPENSIVE!)
        // Disabled in production - rely on existing memory guards.
        if (ENABLE_LOCK_THUNK_VALIDATION) {
            const validBefore = thunkChecksumManager.validateThunkRegion(mem, "IDirectDrawSurface7_Unlock_START") as any;
            if (!validBefore) {
                Logger.error(LogCategory.DDRAW, "🚨 THUNK corruption detected BEFORE Unlock operations!");
            }
        }

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (obj) {
            const state = obj.getState();
            const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;
            const leaseWriteState = consumeActiveLeaseWriteState(mem, state);
            const wasReadOnly = leaseWriteState.wasReadOnly;
            const didWritePixels = leaseWriteState.changed;
            const previousSurfaceEverWritten = state.surfaceEverWritten;
            const previousWriteGeneration = state.writeGeneration;
            if (!leaseWriteState.hadLease) {
                Logger.warn(LogCategory.DDRAW,
                    `Unlock: surface=0x${thisPtr.toString(16)} without active Lock lease; ignoring CPU write commit`);
            }

            // Mark surface as written if unlock was not readonly
            // This helps deferred Load() detection - if surface was written, we should copy immediately
            if (state.activeLeaseId !== undefined) {
                const lease = leaseRegistry.validateLease(state.activeLeaseId);
                if (lease && lease.perms !== "r") {
                    state.surfaceEverWritten = true;
                    // Bump write generation for Load() dedup — allows skipping
                    // redundant copies when source surface content hasn't changed
                    state.writeGeneration++;
                }
            }
            if (!didWritePixels) {
                state.surfaceEverWritten = previousSurfaceEverWritten;
                state.writeGeneration = previousWriteGeneration;
            }

            if (ENABLE_TEXTURE_DIAGNOSTICS && isTexture && state.surfacePtr > 0 && isValidAddress(mem, state.surfacePtr, 64)) {
                const totalSize = state.pitch * state.height;
                const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));

                // Sample points: row 0, middle row, last row, center pixel
                const midRow = Math.floor(state.height / 2);
                const lastRow = state.height - 1;
                const centerX = Math.floor(state.width / 2);

                const sampleOffsets = [
                    { name: "row0_start", offset: 0 },
                    { name: "row0_center", offset: centerX * bytesPerPixel },
                    { name: "midRow_start", offset: midRow * state.pitch },
                    { name: "midRow_center", offset: midRow * state.pitch + centerX * bytesPerPixel },
                    { name: "lastRow_start", offset: lastRow * state.pitch },
                    { name: "lastRow_center", offset: lastRow * state.pitch + centerX * bytesPerPixel },
                ];

                let anyNonZero = false;
                let nonZeroCount = 0;
                const samples: string[] = [];

                // Use same addressing method as TextureConverter
                // TextureConverter uses srcAddr directly as index in memory array
                // So we need to convert absolute address to relative index: abs - mem.byteOffset
                const surfaceRelPtr = absToRel(mem, state.surfacePtr);

                for (const sample of sampleOffsets) {
                    if (sample.offset + bytesPerPixel <= totalSize) {
                        let pixelValue = 0;
                        const sampleRelOffset = surfaceRelPtr + sample.offset;
                        // Validate bounds
                        if (sampleRelOffset >= 0 && sampleRelOffset + bytesPerPixel <= mem.length) {
                            for (let i = 0; i < bytesPerPixel; i++) {
                                const byte = mem[sampleRelOffset + i];
                                pixelValue |= byte << (i * 8);
                                if (byte !== 0) anyNonZero = true;
                            }
                            // Use >>> 0 to convert to unsigned 32-bit for proper hex formatting
                            const unsignedValue = pixelValue >>> 0;
                            // For 32bpp, show ARGB components separately for clarity
                            if (bytesPerPixel === 4) {
                                const a = (unsignedValue >>> 24) & 0xFF;
                                const r = (unsignedValue >>> 16) & 0xFF;
                                const g = (unsignedValue >>> 8) & 0xFF;
                                const b = unsignedValue & 0xFF;
                                samples.push(`${sample.name}=A${a.toString(16).padStart(2, '0')}R${r.toString(16).padStart(2, '0')}G${g.toString(16).padStart(2, '0')}B${b.toString(16).padStart(2, '0')}`);
                            } else {
                                samples.push(`${sample.name}=0x${unsignedValue.toString(16).padStart(bytesPerPixel * 2, '0')}`);
                            }
                        }
                    }
                }

                const scanLimit = Math.min(1000 * bytesPerPixel, totalSize);
                for (let i = 0; i < scanLimit && surfaceRelPtr + i < mem.length; i++) {
                    if (mem[surfaceRelPtr + i] !== 0) nonZeroCount++;
                }

                const formatInfo = `format=${state.format.bpp}bpp flags=0x${state.format.flags.toString(16)} ` +
                    `rMask=0x${state.format.rMask.toString(16)} gMask=0x${state.format.gMask.toString(16)} ` +
                    `bMask=0x${state.format.bMask.toString(16)} aMask=0x${state.format.aMask.toString(16)} ` +
                    `pitch=${state.pitch} expectedPitch=${state.width * bytesPerPixel}`;

                // DIAGNOSTIC: Check both direct and offset-adjusted addresses to find where x86 actually wrote
                const directAddr = state.surfacePtr;
                const offsetAdjusted = state.surfacePtr - mem.byteOffset;
                let directNonZero = 0;
                let offsetNonZero = 0;
                const checkSize = Math.min(64, totalSize);

                for (let i = 0; i < checkSize; i++) {
                    if (directAddr + i < mem.length && mem[directAddr + i] !== 0) directNonZero++;
                    if (offsetAdjusted >= 0 && offsetAdjusted + i < mem.length && mem[offsetAdjusted + i] !== 0) offsetNonZero++;
                }

                // Also check via buffer directly (bypassing Uint8Array view)
                const buffer = mem.buffer;
                const bufferView = new Uint8Array(buffer);
                let bufferDirectNonZero = 0;
                let bufferWithOffsetNonZero = 0;
                for (let i = 0; i < checkSize; i++) {
                    if (directAddr + i < bufferView.length && bufferView[directAddr + i] !== 0) bufferDirectNonZero++;
                    const withOffset = mem.byteOffset + directAddr + i;
                    if (withOffset < bufferView.length && bufferView[withOffset] !== 0) bufferWithOffsetNonZero++;
                }

                Logger.warn(
                    LogCategory.DDRAW,
                    `🔍 IDirectDrawSurface7_Unlock TEXTURE SCAN: texture=0x${thisPtr.toString(16)} ` +
                    `surfacePtr=0x${state.surfacePtr.toString(16)} size=${state.width}x${state.height} ` +
                    `${formatInfo} anyNonZero=${anyNonZero} nonZeroBytes(first1000px)=${nonZeroCount} ` +
                    `samples=[${samples.join(', ')}]`
                );

                Logger.warn(
                    LogCategory.DDRAW,
                    `🔍 MEMORY DIAGNOSTIC: byteOffset=${mem.byteOffset} memLength=${mem.length} bufferLength=${bufferView.length} ` +
                    `mem[directAddr]=${directNonZero}/64 mem[offsetAdjusted]=${offsetNonZero}/64 ` +
                    `buffer[directAddr]=${bufferDirectNonZero}/64 buffer[byteOffset+directAddr]=${bufferWithOffsetNonZero}/64`
                );
            }

            if (didWritePixels) {
                // CPU-First: Mark surface as written (increment version, set gpuDirty)
                if (isRenderSurface(state)) {
                    const oldMode = state.mode;
                    const oldVersion = state.version;

                    // Increment version and mark GPU as dirty
                    setAuthorityCpu(state); // Increments version, sets gpuDirty=true

                    // Mark as locked (permanent CPU mode)
                    state.everLocked = true;
                    if (state.mode === "GPU_ONLY") {
                        state.mode = "CPU"; // Demotion
                    }

                    Logger.log(LogCategory.DDRAW,
                        `Unlock: CPU write detected - mode=${oldMode}→${state.mode} version=${oldVersion}→${state.version} ` +
                        `gpuDirty=true everLocked=true surface=0x${thisPtr.toString(16)}`);

                    if (ENABLE_TEXTURE_DIAGNOSTICS && state.surfacePtr > 0) {
                        const diagSize = Math.min(16, state.width * Math.max(1, Math.floor(state.format.bpp / 8)));
                        const diagRel = absToRel(mem, state.surfacePtr);
                        if (diagRel >= 0 && diagRel + diagSize <= mem.length) {
                            const u16 = new Uint16Array(mem.buffer, mem.byteOffset + diagRel, Math.floor(diagSize / 2));
                            const hasData = u16.some(v => v !== 0);
                            if (hasData) {
                                Logger.warn(LogCategory.DDRAW,
                                    `POST-UNLOCK: Non-zero pixel data at 0x${state.surfacePtr.toString(16)} surface=0x${thisPtr.toString(16)}`);
                            }
                        }
                    }

                    // OPTIMIZATION: Only invalidate rgbaScratch for WRITABLE locks
                    // Game just wrote to guest memory via Lock, so cached RGBA is stale.
                    // Next GPU sync will re-convert from guest memory using the correct LUT.
                    state.rgbaScratch = undefined;
                    state.rgbaScratchVersion = undefined;

                    // Auto-present for primary surface: in real DDraw, front buffer writes
                    // are immediately visible. Some games write video frames
                    // directly to the primary via Lock/Unlock without calling Flip.
                    const isPrimary = (state.caps & DDSCAPS_PRIMARYSURFACE) !== 0;
                    if (isPrimary && context.presenter && !context.suppressPresent) {
                        void context.presenter.present(state, mem, { throttle: true });
                    }
                } else {
                    // BitmapTexture path (shouldn't be locked for writes, but handle gracefully)
                    Logger.warn(LogCategory.DDRAW,
                        `Unlock: Write lock on BitmapTexture 0x${thisPtr.toString(16)} (unexpected)`);
                }
            } else if (!wasReadOnly) {
                if (isRenderSurface(state)) {
                    if (!isTexture) {
                        state.everLocked = true;
                    }
                }
                Logger.verbose(LogCategory.DDRAW,
                    `Unlock: writable lock unchanged - preserving GPU sync state for 0x${thisPtr.toString(16)}`);
            } else {
                // OPTIMIZATION: Read-only lock path - preserve rgbaScratch cache
                // Lease validation ensures no writes occurred, safe to reuse cached RGBA conversions
                Logger.verbose(LogCategory.DDRAW,
                    `Unlock: Read-only lock - preserving rgbaScratch cache for 0x${thisPtr.toString(16)} ` +
                    `(saves ~1ms format conversion on next GPU sync)`);
            }

            if (isTexture) {
                logSurfaceState(state, "Unlock", thisPtr);
            }

            // Revoke active lease if any
            if (state.activeLeaseId !== undefined) {
                leaseRegistry.revokeLease(state.activeLeaseId);
                state.activeLeaseId = undefined;
            }

            // Texture writes are committed by the dirty/version state above. Keep the
            // actual GPU upload out of the Unlock thunk; WebGPU conversion/pipeline work
            // belongs in the normal deferred upload or prepareDraw path.
            if (didWritePixels && isTexture && isRenderSurface(state) && context.executor) {
                if (state.width >= 128 || state.height >= 128) {
                    Logger.log(LogCategory.DDRAW,
                        `Unlock texture dirty: surface=0x${thisPtr.toString(16)} ` +
                        `ptr=0x${state.surfacePtr.toString(16)} ${state.width}x${state.height} ` +
                        `version=${state.version} lastUpload=${state.lastUploadVersion} ` +
                        `gpuDirty=${state.gpuDirty} everWritten=${state.surfaceEverWritten} ` +
                        `format={bpp=${state.format.bpp} R=0x${state.format.rMask.toString(16)} ` +
                        `G=0x${state.format.gMask.toString(16)} B=0x${state.format.bMask.toString(16)} ` +
                        `A=0x${state.format.aMask.toString(16)}}`);
                }
                context.deferredUploadManager?.markDirty(state, false);
            }

            // Track Lock/Unlock pattern for optimization detection
            // dataAccessed = true for now (we don't have memory access tracking yet)
            // In future, we could use memory guard pages or counters to detect actual reads
            const dataAccessed = didWritePixels;
            lockTracker.endLock(thisPtr, dataAccessed);
        }

        // Validate thunk code integrity after surface unlock (EXPENSIVE!)
        if (ENABLE_LOCK_THUNK_VALIDATION) {
            const valid = thunkChecksumManager.validateThunkRegion(mem, "IDirectDrawSurface7_Unlock") as any;
            if (!valid) {
                Logger.error(LogCategory.DDRAW, "Thunk checksum validation failed after Unlock");
                return E_FAIL;
            }
        }

        // Periodically log Lock/Unlock statistics (every 100 locks)
        const stats = lockTracker.getStats();
        if (stats.totalLocks > 0 && stats.totalLocks % 100 === 0) {
            lockTracker.logSummary();
        }

        // Record unlock event for variance diagnostics
        if (frameVarianceDiagnostics.isEnabled()) {
            const unlockDuration = performance.now() - unlockStart;
            const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
            if (obj) {
                const state = obj.getState();
                const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;
                frameVarianceDiagnostics.recordEvent(
                    'texture_unlock',
                    isTexture ? 'texture' : 'surface',
                    unlockDuration
                );
            }
        }

        return DD_OK;
    };

    exports["IDirectDrawSurface4_Unlock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (obj) {
            const state = obj.getState();
            const leaseWriteState = consumeActiveLeaseWriteState(mem, state);
            const didWritePixels = leaseWriteState.changed;

            if (didWritePixels) {
                state.surfaceEverWritten = true;
                setAuthorityCpu(state);
                state.writeGeneration++;

                // Invalidate rgbaScratch — game just wrote to guest memory via Lock,
                // so cached RGBA is stale. Matches v7 Unlock behavior.
                if (isRenderSurface(state)) {
                    state.rgbaScratch = undefined;
                    state.rgbaScratchVersion = undefined;

                    // Auto-present for primary surface (see v7 Unlock for details)
                    const isPrimary = (state.caps & DDSCAPS_PRIMARYSURFACE) !== 0;
                    if (isPrimary && context.presenter && !context.suppressPresent) {
                        void context.presenter.present(state, mem, { throttle: true });
                    }
                }
            }

            // Revoke active lease if any
            if (state.activeLeaseId !== undefined) {
                leaseRegistry.revokeLease(state.activeLeaseId);
                state.activeLeaseId = undefined;
            }

            // Track Lock/Unlock pattern
            const dataAccessed = didWritePixels;
            lockTracker.endLock(thisPtr, dataAccessed);
        }

        // Validate thunk code integrity after surface unlock (EXPENSIVE!)
        if (ENABLE_LOCK_THUNK_VALIDATION) {
            const valid = thunkChecksumManager.validateThunkRegion(mem, "IDirectDrawSurface4_Unlock") as any;
            if (!valid) {
                Logger.error(LogCategory.DDRAW, "Thunk checksum validation failed after Unlock");
                return E_FAIL;
            }
        }

        return DD_OK;
    };

    exports["IDirectDrawSurface_Unlock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (obj) {
            const state = obj.getState();
            const leaseWriteState = consumeActiveLeaseWriteState(mem, state);
            const didWritePixels = leaseWriteState.changed;

            if (didWritePixels) {
                state.surfaceEverWritten = true;
                setAuthorityCpu(state);
                state.writeGeneration++;

                // Invalidate rgbaScratch — game just wrote to guest memory via Lock,
                // so cached RGBA is stale. Matches v7 Unlock behavior.
                if (isRenderSurface(state)) {
                    state.rgbaScratch = undefined;
                    state.rgbaScratchVersion = undefined;

                    // Auto-present for primary surface (see v7 Unlock for details)
                    const isPrimary = (state.caps & DDSCAPS_PRIMARYSURFACE) !== 0;
                    if (isPrimary && context.presenter && !context.suppressPresent) {
                        void context.presenter.present(state, mem, { throttle: true });
                    }
                }
            }

            // Revoke active lease if any
            if (state.activeLeaseId !== undefined) {
                leaseRegistry.revokeLease(state.activeLeaseId);
                state.activeLeaseId = undefined;
            }

            // Track Lock/Unlock pattern
            const dataAccessed = didWritePixels;
            lockTracker.endLock(thisPtr, dataAccessed);
        }

        // Validate thunk code integrity after surface unlock (EXPENSIVE!)
        if (ENABLE_LOCK_THUNK_VALIDATION) {
            const valid = thunkChecksumManager.validateThunkRegion(mem, "IDirectDrawSurface_Unlock") as any;
            if (!valid) {
                Logger.error(LogCategory.DDRAW, "Thunk checksum validation failed after Unlock");
                return E_FAIL;
            }
        }

        return DD_OK;
    };

    // =========================================================================
    // EnumAttachedSurfaces — shared implementation for v1, v4, v7
    // COM signature: EnumAttachedSurfaces(LPVOID lpContext, LPDDENUMSURFACESCALLBACK lpCallback)
    // Callback signature: DWORD cb(LPDIRECTDRAWSURFACE, LPDDSURFACEDESC, LPVOID)
    // Returns DDENUMRET_OK (1) to continue, DDENUMRET_CANCEL (0) to stop.
    // =========================================================================
    const enumAttachedSurfacesImpl = (ctx: any, mem: Uint8Array, args: number[], useV2Desc: boolean): any => {
        const thisPtr = args[0];
        const lpContext = args[1];
        const lpCallback = args[2];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        const state = obj?.getState();

        // Collect attached surface addresses
        const attached: number[] = [];
        if (state?.attachedSurfaceAddr) attached.push(state.attachedSurfaceAddr);
        if (state && (state.caps & DDSCAPS_PRIMARYSURFACE) && context.surfaces.backBuffer &&
                !attached.includes(context.surfaces.backBuffer)) {
            attached.push(context.surfaces.backBuffer);
        }
        if (state && (state.caps & DDSCAPS_BACKBUFFER) && context.surfaces.primary &&
                !attached.includes(context.surfaces.primary)) {
            attached.push(context.surfaces.primary);
        }

        Logger.log(LogCategory.DDRAW,
            `[DDRAW] EnumAttachedSurfaces: this=0x${thisPtr.toString(16)} found ${attached.length} attached surfaces, cb=0x${lpCallback?.toString(16)}`);

        if (!lpCallback || attached.length === 0) return DD_OK;

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return DD_OK;

        const descSize = useV2Desc ? DDSURFACEDESC2_SIZE : DDSURFACEDESC_SIZE;
        const descAddr = context.process.memory.alloc(descSize);
        let index = 0;

        callbackManager.saveSuspendedThunkContext(ctx, 12);
        let firstCallbackId: number | null = null;

        const processNext = (): void => {
            if (index >= attached.length) {
                context.process.memory.free(descAddr);
                return;
            }

            const surfaceAddr = attached[index];
            const attachedObj = context.resourceProvider.getComObjectByAddress(surfaceAddr) as DirectDrawSurfaceObject | null;
            const attachedState = attachedObj?.getState();
            index++;

            // Real DDraw AddRefs each attached surface before handing it to the callback (wine
            // ddraw_surface7_EnumAttachedSurfaces surface.c:3159); the app is expected to Release it.
            // Omitting this left apps that Release the enumerated surface dropping the refcount below
            // the true count → premature surface destruction.
            attachedObj?.addRef();

            // Fill the surface desc for this attached surface
            mem.fill(0, descAddr, descAddr + descSize);
            if (attachedState) {
                const desc = {
                    size: descSize,
                    flags: 0,
                    width: attachedState.width,
                    height: attachedState.height,
                    pitch: attachedState.pitch,
                    backBufferCount: 0,
                    caps: attachedState.caps,
                    surfacePtr: 0,
                    pixelFormat: attachedState.format,
                };
                if (useV2Desc) {
                    writeSurfaceDesc(mem, descAddr, desc);
                } else {
                    writeSurfaceDescV1(mem, descAddr, desc);
                }
            } else {
                // Minimal desc: just write size
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(descAddr, descSize, true);
            }

            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [surfaceAddr, descAddr, lpContext],
                0,
                (cbRet: number) => {
                    // DDENUMRET_CANCEL (0) stops enumeration; anything else continues
                    if (cbRet === 0 || index >= attached.length) {
                        context.process.memory.free(descAddr);
                        return DD_OK;
                    }
                    return null; // continue → enumerationState.continueEnumeration()
                }
            );

            if (firstCallbackId === null) firstCallbackId = callbackId;

            const invocation = callbackManager.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = {
                    continueEnumeration: processNext,
                    finishEnumeration: () => { context.process.memory.free(descAddr); },
                };
            }
        };

        processNext();

        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: firstCallbackId ?? 0,
            stackCleanup: 12,
        };
    };

    exports["IDirectDrawSurface7_EnumAttachedSurfaces"] = (ctx, mem, args) => {
        return enumAttachedSurfacesImpl(ctx, mem, args, true);
    };
    exports["IDirectDrawSurface4_EnumAttachedSurfaces"] = (ctx, mem, args) => {
        return enumAttachedSurfacesImpl(ctx, mem, args, true);
    };

    registerSurfaceV1Exports(exports, enumAttachedSurfacesImpl);

    exports["IDirectDrawSurface7_GetCaps"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDSCaps = args[1];
        if (!lpDDSCaps) return E_POINTER;
        if (!isValidAddress(mem, lpDDSCaps, 16)) return E_POINTER;

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpDDSCaps, obj.getState().caps, true);
        view.setUint32(lpDDSCaps + 4, 0, true);
        view.setUint32(lpDDSCaps + 8, 0, true);
        view.setUint32(lpDDSCaps + 12, 0, true);
        return DD_OK;
    };

    exports["IDirectDrawSurface7_GetPixelFormat"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDPixelFormat = args[1];
        if (!lpDDPixelFormat) return E_POINTER;
        if (!isValidAddress(mem, lpDDPixelFormat, 4)) return E_POINTER;

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const declaredSize = view.getUint32(lpDDPixelFormat, true);
        if (declaredSize < 4 || declaredSize > 0x2000 || !isValidAddress(mem, lpDDPixelFormat, declaredSize)) {
            return E_POINTER;
        }

        writePixelFormat(mem, lpDDPixelFormat, obj.getState().format, declaredSize);
        return DD_OK;
    };

    exports["IDirectDrawSurface7_GetAttachedSurface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDSCaps = args[1];
        const lplpDDSurface = args[2];

        if (!lplpDDSurface) return E_POINTER;
        if (!isValidAddress(mem, lplpDDSurface, 4)) return E_POINTER;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (lpDDSCaps && !isValidAddress(mem, lpDDSCaps, 4)) return E_POINTER;
        const requestedCaps = lpDDSCaps ? view.getUint32(lpDDSCaps, true) : 0;

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) {
            view.setUint32(lplpDDSurface, 0, true);
            return E_FAIL;
        }

        const state = obj.getState();
        const targetAddr = resolveGetAttachedSurfaceTarget(
            context,
            (addr) => context.resourceProvider.getComObjectByAddress(addr) as DirectDrawSurfaceObject | null,
            thisPtr,
            requestedCaps,
        );
        if (!targetAddr) {
            view.setUint32(lplpDDSurface, 0, true);
            return DDERR_NOTFOUND;
        }

        const targetObj = context.resourceProvider.getComObjectByAddress(targetAddr) as DirectDrawSurfaceObject | null;
        if (!targetObj) {
            view.setUint32(lplpDDSurface, 0, true);
            return DDERR_NOTFOUND;
        }

        targetObj.addRef();
        view.setUint32(lplpDDSurface, targetAddr, true);
        return DD_OK;
    };

    exports["IDirectDrawSurface7_GetDC"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lphDC = args[1];

        if (!lphDC) return E_POINTER;
        if (!isValidAddress(mem, lphDC, 4)) return E_POINTER;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const system = System.getInstance();

        // ✅ FIX: If an HDC is already linked to this surface, reuse it.
        // This prevents handle leaks and sync issues when games call GetDC in a loop without ReleaseDC.
        const existingHdc = system.gdiContext.getHDCBySurface(thisPtr);
        if (existingHdc) {
            Logger.log(LogCategory.DDRAW, `IDirectDrawSurface7_GetDC: Reusing existing HDC 0x${existingHdc.toString(16)} for surface 0x${thisPtr.toString(16)}`);
            view.setUint32(lphDC, existingHdc, true);
            return DD_OK;
        }

        // Check if this is a texture, SYSMEM, or BACKBUFFER surface - use surface-sized canvas
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        const isTexture = obj ? (obj.getState().caps & DDSCAPS_TEXTURE) !== 0 : false;
        const isSysMem = obj ? (obj.getState().caps & DDSCAPS_SYSTEMMEMORY) !== 0 : false;
        const isBackBuffer = obj ? (obj.getState().caps & DDSCAPS_BACKBUFFER) !== 0 : false;

        let hdc: number;
        let state: DirectDrawSurfaceState | undefined;
        if ((isTexture || isSysMem || isBackBuffer) && obj) {
            // For SYSMEM/TEXTURE/BACKBUFFER surfaces, create a DC with canvas matching surface size
            state = obj.getState();
            hdc = system.gdiContext.createSurfaceDC(state.width, state.height);
            if (!hdc) return E_FAIL;

            const surfaceType = isTexture ? 'TEXTURE' : (isSysMem ? 'SYSMEM' : 'BACKBUFFER');
            const getDCMsg = `IDirectDrawSurface7_GetDC: ${surfaceType} surface=0x${thisPtr.toString(16)} ${state.width}x${state.height} surfacePtr=0x${state.surfacePtr.toString(16)} -> hdc=0x${hdc.toString(16)} (surface-sized canvas)`;
            Logger.log(LogCategory.SYSTEM, getDCMsg);
            Logger.log(LogCategory.DDRAW, getDCMsg);

            // Faithful DDraw GetDC: the DC draws over the surface's OWN pixels. For a SYSMEM
            // surface whose CPU memory is current (the cardinal-sin-free case — no GPU authority),
            // seed the canvas from those pixels so GDI text composites onto the existing content
            // (e.g. a Blt'd button frame). ReleaseDC then writes the full canvas back to CPU and
            // keeps the surface CPU-authoritative, so a later Lock/Blt/Flip never triggers a
            // blocking GPU→CPU readback. If the GPU holds the latest data, skip seeding and fall
            // back to the existing GPU-upload path (seeding from stale CPU would be wrong).
            if (isSysMem && isRenderSurface(state)) {
                const expectedRgba = state.width * state.height * 4;
                const scratch = state.rgbaScratch;
                if (!surfaceSyncManager.needsCPUSync(state).needed) {
                    // CPU memory is current — seed from it (faithful: DC over surface bits).
                    const bpp = Math.max(1, Math.floor(state.format.bpp / 8));
                    const pitch = Math.max(state.pitch, state.width * bpp);
                    if (state.surfacePtr > 0 && state.surfacePtr + pitch * state.height <= mem.length) {
                        const rgba = convertSurfaceToRGBA(mem, state.surfacePtr, state.width, state.height, pitch, state.format);
                        system.gdiContext.seedSurfaceDC(hdc, rgba, state.width, state.height);
                    }
                } else if (scratch && scratch.length >= expectedRgba) {
                    // GPU holds the latest, but rgbaScratch caches the last full composited content
                    // (kept fresh by ReleaseDC). Seed from it so GDI composites onto the real pixels
                    // WITHOUT a GPU→CPU readback — then ReleaseDC writes back to CPU and the surface
                    // becomes CPU-authoritative, breaking the readback cycle.
                    system.gdiContext.seedSurfaceDC(hdc, scratch, state.width, state.height);
                }
            }
        } else {
            // For primary surface only, use overlay canvas
            hdc = system.gdiContext.createOverlayDC();
            if (!hdc) return E_FAIL;
            if (obj) {
                state = obj.getState();
            }
            Logger.log(LogCategory.SYSTEM, `IDirectDrawSurface7_GetDC: PRIMARY surface=0x${thisPtr.toString(16)} -> hdc=0x${hdc.toString(16)} (overlay canvas)`);
        }

        // Link DC to surface for ReleaseDC to copy pixels back
        system.gdiContext.linkDCToSurface(hdc, thisPtr);

        view.setUint32(lphDC, hdc, true);
        return DD_OK;
    };

    exports["IDirectDrawSurface7_ReleaseDC"] = async (ctx, mem, args) => {
        const thisPtr = args[0];
        const hdc = args[1];

        const system = System.getInstance();
        const gdiContext = system.gdiContext;

        Logger.verbose(LogCategory.DDRAW, `IDirectDrawSurface7_ReleaseDC: surface=0x${thisPtr.toString(16)} hdc=0x${hdc.toString(16)}`);

        const linkedSurfacePtr = gdiContext.getLinkedSurface(hdc);
        if (linkedSurfacePtr === thisPtr) {
            const dcCtx = gdiContext.getDC(hdc);
            const dcCanvas = dcCtx?.canvas as OffscreenCanvas | undefined;
            const isDirty = gdiContext.isDirty(hdc);
            const shouldSync = !!(dcCanvas && dcCtx && isDirty);


            if (shouldSync) {
                try {
                    const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
                    const isBackBuffer = obj ? (obj.getState().caps & DDSCAPS_BACKBUFFER) !== 0 : false;
                    const isPrimary = obj ? (obj.getState().caps & DDSCAPS_PRIMARYSURFACE) !== 0 : false;

                    if (obj) {
                        const state = obj.getState();
                        const width = state.width;
                        const height = state.height;
                        const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;

                        Logger.verbose(LogCategory.DDRAW,
                            `IDirectDrawSurface7_ReleaseDC: Syncing GDI canvas to surface 0x${thisPtr.toString(16)} ` +
                            `(size=${width}x${height} hasGpuTexture=${!!state.gpuTexture})`
                        );


                        // If the canvas was seeded from the surface's own CPU pixels at GetDC, it now
                        // holds the FULL composited content (existing pixels + GDI draws). Write it
                        // straight back to CPU (the slow path below) and keep the surface
                        // CPU-authoritative — this avoids the GPU→CPU readback a later Lock/Blt/Flip
                        // would otherwise force (the GPU texture is re-uploaded lazily from CPU on the
                        // next draw via needsGPUSync). Faithful to real DDraw SYSMEM GetDC semantics.
                        const seeded = gdiContext.wasSurfaceSeeded(hdc);

                        // OPTIMIZATION: Fast Path for GPU-backed surfaces using direct GPU-to-GPU copy
                        if (state.gpuTexture && context.executor && !seeded) {
                            profiler.start('ReleaseDC:fastGpuUpload');

                            const canvas = gdiContext.getCanvasForHDC(hdc);
                            const dirtyRect = gdiContext.getDirtyRect(hdc);

                            if (canvas) {
                                // Direct GPU upload (Canvas → GPU). Authority = GPU; cpuValid = false so we never upload zeros from CPU.
                                context.executor.uploadCanvasToTexture(state, canvas, dirtyRect);
                                setAuthorityGpu(state, true); // cpuValid=false (ReleaseDC fast) - also invalidates rgbaScratch
                                state.surfaceEverWritten = true; // Mark as written for deferred Load() detection
                                // Propagate authority and GPU resource to all surfaces sharing this gpuTexture or same surfacePtr (same guest surface, different COM ptr at Draw).
                                // Surfaces with same surfacePtr but different gpuTexture would bind an empty texture at Draw; share the filled gpuTexture/gpuTextureView.
                                const gpuTex = state.gpuTexture;
                                const gpuTexView = state.gpuTextureView;
                                const gpuTexFormat = state.gpuTextureFormat;
                                const surfacePtrVal = state.surfacePtr;
                                const versionAfter = isRenderSurface(state) ? state.version : 0;

                                // OPTIMIZATION: Use surfacePtr index instead of iterating all COM objects (O(1) vs O(N))
                                const siblingObjects = surfacePtrVal > 0
                                    ? context.resourceProvider.getComObjectsBySurfacePtr(surfacePtrVal)
                                    : [];

                                for (const other of siblingObjects) {
                                    if (!(other instanceof DirectDrawSurfaceObject)) continue;
                                    const otherState = other.getState();
                                    if (otherState === state) continue;

                                    // Update state based on surface type
                                    if (isBitmapTexture(otherState)) {
                                        // BitmapTextureSurface: DON'T clear gpuNeedsUpload here!
                                        // Fast GPU path already uploaded via Blt, but this isn't a full sync
                                        // Let syncToGPU clear the flag after proper upload
                                        // Prevents black screen when Blt called before first Draw
                                    } else if (isRenderSurface(otherState)) {
                                        // RenderSurface: Update version and dirty state
                                        // DO NOT set gpuDirty=false here! The actual upload happens in syncActiveGdiContext
                                        // or later in prepareDraw. Siblings must remain dirty until upload completes.
                                        otherState.version = versionAfter;
                                        otherState.gpuDirty = isRenderSurface(state) ? state.gpuDirty : false;
                                        otherState.surfaceEverWritten = true;
                                        // Invalidate ephemeral rgbaScratch cache
                                        otherState.rgbaScratch = undefined;
                                        otherState.rgbaScratchVersion = undefined;
                                    }
                                    if (gpuTex && otherState.gpuTexture !== gpuTex) {
                                        otherState.gpuTexture = gpuTex;
                                        otherState.gpuTextureView = gpuTexView;
                                    }
                                    if (gpuTexFormat) {
                                        otherState.gpuTextureFormat = gpuTexFormat;
                                    }
                                }
                                // Update texture handle registry so texStateFromRegistry has authority=gpu when drawing by handle
                                propagateSurfaceStateToRegistry(context, state);
                                logSurfaceState(state, "ReleaseDC fast", thisPtr);
                                profiler.end('ReleaseDC:fastGpuUpload');
                            } else {
                                // Fallback: upload ImageData to GPU and copy to surfacePtr — authority CPU
                                const fallbackImageData = gdiContext.getImageData(hdc);
                                if (fallbackImageData) {
                                    context.executor.uploadImageData(state, fallbackImageData);
                                    const pitch = state.pitch || (width * Math.max(1, state.format.bpp / 8));
                                    convertRGBAToSurface(fallbackImageData.data, mem, state.surfacePtr, width, height, pitch, state.format, { clearAlphaBit: true });
                                    setAuthorityCpu(state);
                                    state.surfaceEverWritten = true;
                                }
                                profiler.end('ReleaseDC:fastGpuUpload');
                            }

                            // Force present for Primary surface to show changes immediately
                            if (isPrimary) {
                                Logger.verbose(LogCategory.DDRAW, `IDirectDrawSurface7_ReleaseDC: Forcing present on PRIMARY surface`);
                                await context.presenter.present(state, mem, { throttle: false });
                            }
                        } else {
                            // FALLBACK: Slow Path (No GPU texture or Software Rasterizer)
                            // Get ImageData for CPU path
                            profiler.start('ReleaseDC:getImageData');
                            const fallbackImageData = gdiContext.getImageData(hdc);
                            profiler.end('ReleaseDC:getImageData');

                            if (fallbackImageData) {
                                const pitch = state.pitch || (width * Math.max(1, state.format.bpp / 8));

                                profiler.start('ReleaseDC:convertRGBA');
                                convertRGBAToSurface(fallbackImageData.data, mem, state.surfacePtr, width, height, pitch, state.format, { clearAlphaBit: true });
                                profiler.end('ReleaseDC:convertRGBA');
                                profiler.increment('ReleaseDC:convertRGBA', 'pixels', width * height);

                                setAuthorityCpu(state);
                                state.surfaceEverWritten = true; // Mark as written for deferred Load() detection

                                // ✅ FIX P3: Update rgbaScratch cache for RenderSurface (ReleaseDC slow path)
                                // When GDI modifies surface via GetDC/ReleaseDC, we need to cache the RGBA data
                                // so that subsequent GPU uploads don't use stale data
                                if (isRenderSurface(state)) {
                                    state.rgbaScratch = new Uint8Array(fallbackImageData.data);
                                    state.rgbaScratchVersion = state.version;
                                }

                                // Propagate to all surfaces sharing same surfacePtr (src+dst share buffer in Tex_LoadTexture)
                                // OPTIMIZATION: Use surfacePtr index instead of iterating all COM objects
                                const surfacePtrVal = state.surfacePtr;
                                if (surfacePtrVal > 0) {
                                    const siblingObjects = context.resourceProvider.getComObjectsBySurfacePtr(surfacePtrVal);
                                    for (const other of siblingObjects) {
                                        if (!(other instanceof DirectDrawSurfaceObject)) continue;
                                        const otherState = other.getState();
                                        if (otherState === state) continue;

                                        // Update based on surface type
                                        if (isRenderSurface(otherState) && isRenderSurface(state)) {
                                            otherState.gpuDirty = true; // CPU writes, mark GPU as stale
                                            otherState.version = state.version;
                                            otherState.surfaceEverWritten = true;
                                        }
                                        // BitmapTextureSurface doesn't need authority updates (immutable)
                                    }
                                }
                            } else {
                                if (isBackBuffer) {
                                    Logger.warn(LogCategory.DDRAW, `IDirectDrawSurface7_ReleaseDC: Failed to get ImageData for BACKBUFFER surface!`);
                                }
                            }
                        }

                        // IMMEDIATE PRESENT: If this is the Primary Surface, force a present to update the screen.
                        // Apps using FlipToGDISurface + ReleaseDC expect immediate feedback.
                        // We set throttle: false to avoid stalling the game loop.
                        if (isPrimary) {
                            Logger.verbose(LogCategory.DDRAW, `IDirectDrawSurface7_ReleaseDC: Forcing present on PRIMARY surface`);
                            await context.presenter.present(state, mem, { throttle: false });
                        }
                    }
                } catch (e) {
                    Logger.warn(LogCategory.SYSTEM, `IDirectDrawSurface7_ReleaseDC: Error copying pixels: ${e}`);
                }
            }

            // Clear dirty flag after ReleaseDC (whether we synced or not)
            gdiContext.clearDirty(hdc);
            gdiContext.unlinkDCFromSurface(hdc);
        }

        gdiContext.releaseDC(hdc);
        return DD_OK;
    };

    Object.assign(exports, createSurfaceBltFlipExports(context));

    exports["IDirectDrawSurface7_SetSurfaceDesc"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDSD = args[1];
        const dwFlags = args[2];

        if (!lpDDSD || !isValidAddress(mem, lpDDSD, 4)) return E_POINTER;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;

        if (!obj) {
            Logger.warn(LogCategory.DDRAW, `IDirectDrawSurface7_SetSurfaceDesc: surface object not found for 0x${thisPtr.toString(16)}`);
            return E_FAIL;
        }

        const state = obj.getState();
        const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;
        const isSysMem = (state.caps & DDSCAPS_SYSTEMMEMORY) !== 0;

        // Read DDSURFACEDESC2 structure
        const dwSize = view.getUint32(lpDDSD, true);
        const dwFlagsDesc = view.getUint32(lpDDSD + 4, true);

        // Log ALL SetSurfaceDesc calls for debugging
        Logger.log(LogCategory.DDRAW, `IDirectDrawSurface7_SetSurfaceDesc: surface=0x${thisPtr.toString(16)} caps=0x${state.caps.toString(16)} isTexture=${isTexture} isSysMem=${isSysMem} descFlags=0x${dwFlagsDesc.toString(16)} argFlags=0x${dwFlags.toString(16)}`);

        // DDSD_LPSURFACE flag means lpSurface is being set
        if (dwFlagsDesc & DDSD_LPSURFACE) {
            const lpSurface = view.getUint32(lpDDSD + DDSURFACEDESC2_OFFSETS.lpSurface, true);
            const oldSurfacePtr = state.surfacePtr;

            const estimatedSize = state.pitch * state.height;

            // Check if lpSurface is safe for surface use
            if (lpSurface > 0 && !isSafeSurfaceAddress(lpSurface, estimatedSize)) {
                Logger.error(LogCategory.DDRAW,
                    `🚨 IDirectDrawSurface7_SetSurfaceDesc: Game provided lpSurface=0x${lpSurface.toString(16)} ` +
                    `size=0x${estimatedSize.toString(16)} that is not safe for surface use! ` +
                    `This would allow game to corrupt protected memory. REJECTING!`);
                return 0x8876005a; // DDERR_INVALIDPARAMS
            }

            const isValid = lpSurface > 0 ? isValidAddress(mem, lpSurface, estimatedSize) : false;
            if (lpSurface > 0 && !isValid) {
                Logger.error(LogCategory.DDRAW, `IDirectDrawSurface7_SetSurfaceDesc: Game provided invalid lpSurface=0x${lpSurface.toString(16)} (points to protected region), ignoring to protect system memory`);
                return 0x8876005a; // DDERR_INVALIDPARAMS
            }

            // Update surface pointer (game provided new RAM — CPU is authority)
            state.surfacePtr = lpSurface;
            setAuthorityCpu(state);

            if (isTexture || isSysMem) {
                let sampleStr = "";
                const bpp = state.format.bpp;
                for (let i = 0; i < 4; i++) {
                    if (bpp === 16) {
                        const px = readU16Abs(mem, lpSurface + i * 2);
                        if (px !== null) {
                            sampleStr += `0x${px.toString(16)} `;
                        }
                    } else {
                        const px = readU32Abs(mem, lpSurface + i * 4);
                        if (px !== null) {
                            sampleStr += `0x${px.toString(16)} `;
                        }
                    }
                }
                const msg = `IDirectDrawSurface7_SetSurfaceDesc: ${isTexture ? 'TEXTURE' : 'SYSMEM'} surface=0x${thisPtr.toString(16)} ${state.width}x${state.height} lpSurface: 0x${oldSurfacePtr.toString(16)} -> 0x${lpSurface.toString(16)} flags=0x${dwFlagsDesc.toString(16)} samples: ${sampleStr}`;
                Logger.log(LogCategory.SYSTEM, msg);
                Logger.log(LogCategory.DDRAW, msg);

            } else {
                Logger.verbose(LogCategory.SYSTEM, `IDirectDrawSurface7_SetSurfaceDesc: this=0x${thisPtr.toString(16)} lpSurface=0x${lpSurface.toString(16)}`);
            }
        } else if (isTexture) {
            const msg = `IDirectDrawSurface7_SetSurfaceDesc: TEXTURE surface=0x${thisPtr.toString(16)} flags=0x${dwFlagsDesc.toString(16)} (no lpSurface)`;
            Logger.log(LogCategory.SYSTEM, msg);
            Logger.log(LogCategory.DDRAW, msg);
        }

        return DD_OK;
    };

    exports["IDirectDrawSurface7_SetPalette"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDPalette = args[1];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const state = obj.getState();
        const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;

        if (!lpDDPalette) {
            state.paletteHandle = undefined;
            Logger.verbose(LogCategory.DDRAW, `SetPalette: Cleared palette surface=0x${thisPtr.toString(16)}${isTexture ? ' [TEXTURE]' : ''}`);
            return DD_OK;
        }

        const paletteObj = context.resourceProvider.getComObjectByAddress(lpDDPalette);
        if (!paletteObj) {
            Logger.warn(LogCategory.DDRAW, `SetPalette: Palette object not found at 0x${lpDDPalette.toString(16)}`);
            return E_FAIL;
        }

        state.paletteHandle = paletteObj.handle;
        setAuthorityCpu(state); // Force re-upload with new palette on next draw

        // Propagate palette to flipping chain members (back buffers inherit primary's palette)
        if (state.caps & DDSCAPS_PRIMARYSURFACE) {
            let nextAddr = state.attachedSurfaceAddr;
            while (nextAddr && nextAddr !== thisPtr) {
                const nextObj = context.resourceProvider.getComObjectByAddress(nextAddr) as DirectDrawSurfaceObject | null;
                if (!nextObj) break;
                const nextState = nextObj.getState();
                nextState.paletteHandle = paletteObj.handle;
                setAuthorityCpu(nextState);
                nextAddr = nextState.attachedSurfaceAddr;
            }
        }

        Logger.log(LogCategory.DDRAW, `SetPalette: Linked palette handle=0x${paletteObj.handle.toString(16)} to surface=0x${thisPtr.toString(16)}${isTexture ? ' [TEXTURE]' : ''}`);
        return DD_OK;
    };

    exports["IDirectDrawSurface7_SetClipper"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDClipper = args[1];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const state = obj.getState();

        const releaseCurrentClipper = (): void => {
            if (state.clipperHandle === undefined) return;
            context.resourceProvider.getComObject(state.clipperHandle)?.release();
            state.clipperHandle = undefined;
        };

        if (!lpDDClipper) {
            releaseCurrentClipper();
            Logger.verbose(LogCategory.DDRAW, `SetClipper: Cleared clipper surface=0x${thisPtr.toString(16)}`);
            return DD_OK;
        }

        const clipperObj = context.resourceProvider.getComObjectByAddress(lpDDClipper);
        if (!(clipperObj instanceof DirectDrawClipperObject)) {
            Logger.warn(LogCategory.DDRAW, `SetClipper: invalid clipper at 0x${lpDDClipper.toString(16)}`);
            return DDERR_INVALIDPARAMS;
        }

        if (state.clipperHandle === clipperObj.handle) {
            return DD_OK;
        }

        releaseCurrentClipper();
        clipperObj.addRef();
        state.clipperHandle = clipperObj.handle;
        Logger.log(LogCategory.DDRAW, `SetClipper: Linked clipper handle=0x${clipperObj.handle.toString(16)} hwnd=0x${clipperObj.getHwnd().toString(16)} to surface=0x${thisPtr.toString(16)}`);
        return DD_OK;
    };

    exports["IDirectDrawSurface7_GetClipper"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lplpDDClipper = args[1];

        if (!lplpDDClipper || !isValidAddress(mem, lplpDDClipper, 4)) return E_POINTER;

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        const state = obj.getState();
        if (state.clipperHandle === undefined) {
            return DDERR_NOCLIPPER;
        }

        const clipperObj = context.resourceProvider.getComObject(state.clipperHandle);
        if (!clipperObj) {
            state.clipperHandle = undefined;
            return DDERR_NOCLIPPER;
        }

        const clipperAddr = context.resourceProvider.getAddressForHandle(state.clipperHandle);
        if (!clipperAddr) {
            state.clipperHandle = undefined;
            return DDERR_NOCLIPPER;
        }

        Mem.writeUint32(lplpDDClipper, clipperAddr);
        clipperObj.addRef();
        return DD_OK;
    };

    // Implement AddAttachedSurface to attach Z-buffer and other surfaces
    exports["IDirectDrawSurface7_AddAttachedSurface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDSAttachedSurface = args[1];

        if (!lpDDSAttachedSurface) return E_POINTER;

        const thisObj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!thisObj) {
            Logger.warn(LogCategory.DDRAW, `AddAttachedSurface: invalid this=0x${thisPtr.toString(16)}`);
            return E_FAIL;
        }

        const attachedObj = context.resourceProvider.getComObjectByAddress(lpDDSAttachedSurface) as DirectDrawSurfaceObject | null;
        if (!attachedObj) {
            Logger.warn(LogCategory.DDRAW, `AddAttachedSurface: invalid attached surface=0x${lpDDSAttachedSurface.toString(16)}`);
            return E_FAIL;
        }

        const attachedState = attachedObj.getState();
        const isZBuffer = (attachedState.caps & DDSCAPS_ZBUFFER) !== 0;

        thisObj.setAttachedSurface(lpDDSAttachedSurface);

        Logger.verbose(LogCategory.DDRAW,
            `IDirectDrawSurface7_AddAttachedSurface: this=0x${thisPtr.toString(16)} ` +
            `attached=0x${lpDDSAttachedSurface.toString(16)} ${isZBuffer ? '[ZBUFFER]' : ''}`
        );

        return DD_OK;
    };

    // IsLost: report surface lost state (e.g. after Alt+Tab). We never lose surfaces in emu.
    exports["IDirectDrawSurface7_IsLost"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) {
            // TOLERANCE: Some games call IsLost on already-released surfaces
            // This is allowed in Windows (returns DDERR_SURFACELOST or DDERR_INVALIDOBJECT)
            // We return DD_OK to indicate surface is not lost (even though it doesn't exist anymore)
            Logger.verbose(LogCategory.DDRAW,
                `IDirectDrawSurface7_IsLost: Surface 0x${thisPtr.toString(16)} not found (already released?) - returning DD_OK`
            );
            return DD_OK; // Graceful degradation - pretend surface is fine
        }
        // In emu we never lose surfaces; always return DD_OK (not lost)
        return DD_OK;
    };

    // Restore: restore surface after loss. No-op in emu since we never lose.
    exports["IDirectDrawSurface7_Restore"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
        if (!obj) {
            Logger.warn(LogCategory.DDRAW, `IDirectDrawSurface7_Restore: invalid this=0x${thisPtr.toString(16)}`);
            return DDERR_INVALIDPARAMS;
        }
        return DD_OK;
    };

    Object.assign(exports, createSurfaceStubsExports(context));

    // IDirectDrawSurface (v1) stub methods - delegate to v7 where possible
    // Note: QueryInterface, AddRef, Release, Lock, GetSurfaceDesc are already implemented
    const idirectDrawSurfaceStubs = [
        "AddAttachedSurface", "AddOverlayDirtyRect", "Blt", "BltBatch", "BltFast",
        "DeleteAttachedSurface", "EnumAttachedSurfaces", "EnumOverlayZOrders",
        "Flip", "GetAttachedSurface", "GetBltStatus", "GetCaps", "GetClipper",
        "GetColorKey", "GetDC", "GetFlipStatus", "GetOverlayPosition",
        "GetPalette", "GetPixelFormat", "Initialize", "IsLost", "ReleaseDC",
        "Restore", "SetClipper", "SetColorKey", "SetOverlayPosition",
        "SetPalette", "Unlock", "UpdateOverlay", "UpdateOverlayDisplay",
        "UpdateOverlayZOrder"
    ];

    for (const method of idirectDrawSurfaceStubs) {
        // Skip if already implemented
        if (exports[`IDirectDrawSurface_${method}`]) continue;
        // Delegate to v7 if it exists, otherwise return DD_OK stub
        exports[`IDirectDrawSurface_${method}`] = (ctx, mem, args) => {
            const v7Method = exports[`IDirectDrawSurface7_${method}`];
            if (v7Method) {
                return v7Method(ctx, mem, args);
            }
            Logger.verbose(LogCategory.SYSTEM, `IDirectDrawSurface_${method} stub called: this=0x${args[0].toString(16)}`);
            return DD_OK;
        };
    }

    // EXPLICIT IDirectDrawSurface4_SetColorKey with diagnostic logging.
    // DX6 titles call TexInfo[tpage].Surface->SetColorKey(DDCKEY_SRCBLT, &ck)
    // through IDirectDrawSurface4 interface. This logs the call before delegating to v7.
    exports["IDirectDrawSurface4_SetColorKey"] = (ctx, mem, args) => {
        Logger.log(LogCategory.DDRAW,
            `[COLORKEY] IDirectDrawSurface4_SetColorKey CALLED! this=0x${args[0].toString(16)} flags=0x${args[1].toString(16)} lpColorKey=0x${args[2].toString(16)}`);
        const v7Method = exports["IDirectDrawSurface7_SetColorKey"];
        if (v7Method) return v7Method(ctx, mem, args);
        Logger.warn(LogCategory.DDRAW, `[COLORKEY] IDirectDrawSurface4_SetColorKey: v7 method NOT FOUND!`);
        return DD_OK;
    };

    // IDirectDrawSurface4 stub methods - delegate to v7 where possible
    // Note: QueryInterface, AddRef, Release, Lock, GetSurfaceDesc, SetColorKey are already implemented
    const idirectDrawSurface4Stubs = [
        "AddAttachedSurface", "AddOverlayDirtyRect", "Blt", "BltBatch", "BltFast",
        "DeleteAttachedSurface", "EnumAttachedSurfaces", "EnumOverlayZOrders",
        "Flip", "GetAttachedSurface", "GetBltStatus", "GetCaps", "GetClipper",
        "GetColorKey", "GetDC", "GetFlipStatus", "GetOverlayPosition",
        "GetPalette", "GetPixelFormat", "Initialize", "IsLost", "ReleaseDC",
        "Restore", "SetClipper", "SetColorKey", "SetOverlayPosition",
        "SetPalette", "Unlock", "UpdateOverlay", "UpdateOverlayDisplay",
        "UpdateOverlayZOrder", "GetDDInterface", "PageLock", "PageUnlock",
        "SetSurfaceDesc", "SetPrivateData", "GetPrivateData", "FreePrivateData",
        "GetUniquenessValue", "ChangeUniquenessValue"
    ];

    for (const method of idirectDrawSurface4Stubs) {
        // Skip if already implemented
        if (exports[`IDirectDrawSurface4_${method}`]) continue;
        // Delegate to v7 if it exists, otherwise return DD_OK stub
        exports[`IDirectDrawSurface4_${method}`] = (ctx, mem, args) => {
            const v7Method = exports[`IDirectDrawSurface7_${method}`];
            if (v7Method) {
                return v7Method(ctx, mem, args);
            }
            Logger.verbose(LogCategory.SYSTEM, `IDirectDrawSurface4_${method} stub called: this=0x${args[0].toString(16)}`);
            return DD_OK;
        };
    }

    return exports;
};

/**
 * Register fast-path implementations for high-frequency surface methods.
 * GetAttachedSurface is called ~972K times in UT99 demo (3.6s total).
 * The result is deterministic per surface: source → attached is fixed for a flipping chain.
 */
export function registerFastPathSurfaceFunctions(dispatcher: any, context: DDrawContext): void {
    if (!dispatcher || typeof dispatcher.registerFastPath !== 'function') return;

    const resourceProvider = context.resourceProvider;

    // Cache: source surface address → { source object, target address, target COM object }.
    // COM iface addresses are pool-reused after Release, so a hit is valid only while BOTH
    // addresses still resolve to the SAME objects (a recreated flip chain can land on the old
    // primary's address — returning the old backbuffer then sends every frame to a zombie surface).
    const attachedCache = new Map<string, { srcObj: unknown; addr: number; obj: { addRef(): number } }>();

    const fastPathGetAttachedSurface = (cpu: any, mem8: Uint8Array): number | null => {
        const esp = cpu.reg32[4];
        if (esp + 16 > mem8.length) return null;
        const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        // Stack layout (stdcall, args pushed right-to-left):
        // esp + 0  = return address
        // esp + 4  = thisPtr (IDirectDrawSurface*)
        // esp + 8  = lpDDSCaps (DDSCAPS*)
        // esp + 12 = lplpDDSurface (IDirectDrawSurface**)
        const thisPtr = view.getUint32(esp + 4, true);
        const lpDDSCaps = view.getUint32(esp + 8, true);
        const lplpDDSurface = view.getUint32(esp + 12, true);
        const requestedCaps = (lpDDSCaps && lpDDSCaps + 4 <= mem8.length)
            ? view.getUint32(lpDDSCaps, true) : 0;
        const cacheKey = `${thisPtr}:${requestedCaps >>> 0}`;

        if (!lplpDDSurface || lplpDDSurface + 4 > mem8.length) return null;

        const obj = resourceProvider.getComObjectByAddressFast(thisPtr) as DirectDrawSurfaceObject | null;

        // Check cache first; a hit must still map to the same live objects at both addresses
        const cached = attachedCache.get(cacheKey);
        if (cached) {
            if (obj === cached.srcObj
                && resourceProvider.getComObjectByAddressFast(cached.addr) === cached.obj) {
                cached.obj.addRef();
                view.setUint32(lplpDDSurface, cached.addr, true);
                return DD_OK;
            }
            attachedCache.delete(cacheKey);
        }

        // Cache miss — resolve and cache for future calls
        if (!obj) return null; // fallthrough to slow path

        const targetAddr = resolveGetAttachedSurfaceTarget(
            context,
            (addr) => resourceProvider.getComObjectByAddressFast(addr) as DirectDrawSurfaceObject | null,
            thisPtr,
            requestedCaps,
        );
        if (!targetAddr) {
            Logger.verbose(LogCategory.DDRAW, `[FASTPATH] GetAttachedSurface: no match for this=0x${thisPtr.toString(16)} reqCaps=0x${(requestedCaps >>> 0).toString(16)}`);
            view.setUint32(lplpDDSurface, 0, true);
            return DDERR_NOTFOUND;
        }

        const targetObj = resourceProvider.getComObjectByAddressFast(targetAddr) as DirectDrawSurfaceObject | null;
        if (!targetObj) {
            view.setUint32(lplpDDSurface, 0, true);
            return DDERR_NOTFOUND;
        }

        // Cache the mapping
        attachedCache.set(cacheKey, { srcObj: obj, addr: targetAddr, obj: targetObj });

        targetObj.addRef();
        view.setUint32(lplpDDSurface, targetAddr, true);
        return DD_OK;
    };

    // Register for both IDirectDrawSurface and IDirectDrawSurface7 variants
    dispatcher.registerFastPath('ddraw', 'IDirectDrawSurface7_GetAttachedSurface', fastPathGetAttachedSurface);
    dispatcher.registerFastPath('ddraw', 'IDirectDrawSurface_GetAttachedSurface', fastPathGetAttachedSurface);
    dispatcher.registerFastPath('ddraw', 'IDirectDrawSurface4_GetAttachedSurface', fastPathGetAttachedSurface);

}
