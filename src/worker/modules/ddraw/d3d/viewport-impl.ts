/**
 * IDirect3DViewport2 and IDirect3DViewport3 implementations.
 * Viewport COM identity, D3DVIEWPORT vs D3DVIEWPORT2 layouts, region-aware Clear/Clear2.
 */
import { Logger, LogCategory, LogLevel } from "../../../core/logger";
import { ComObjectFactory } from "../../../core/com/base-com-object";
import { DDrawContext } from "../context";
import { bytesToGuid } from "../helpers";
import { isValidAddress } from "../../../core/memory/address-guard";
import type { RegionPerms } from "../../../core/memory/address-space";
import { IID_IDirect3DViewport3, E_FAIL, D3DCLEAR_TARGET, D3DCLEAR_ZBUFFER, DDERR_INVALIDPARAMS } from "../constants";
import { COM_OBJECT_SIZE, allocateComObject } from "../../../core/com/com-memory";
import {
    Direct3DViewport3Object,
    Direct3DViewport2Object,
    Direct3DDevice3Object,
    Direct3DMaterial3Object,
    DirectDrawSurfaceObject,
} from "../com-objects";
import { D3DExports, D3D_OK, D3DERR_INVALIDCALL } from "./types";

const E_POINTER = 0x80004003;

// Structure sizes for buffer overflow protection
const D3DVIEWPORT_SIZE = 44; // D3DVIEWPORT v1 structure size
// D3DVIEWPORT2 is 44 bytes, NOT 28: dwSize 0, dwX 4, dwY 8, dwWidth 12, dwHeight 16,
// dvClipX 20, dvClipY 24, dvClipWidth 28, dvClipHeight 32, dvMinZ 36, dvMaxZ 40.
// Offsets 20/24 are the CLIP VOLUME, not the depth range — that layout belongs to
// D3DVIEWPORT7. Reading dvMinZ/dvMaxZ from 20/24 hands the rasterizer the default
// clip volume (-1 .. 1) as its depth range.
const D3DVIEWPORT2_SIZE = 44; // D3DVIEWPORT2 v2 structure size
/** D3D's default clipping volume: x -1, y 1, width 2, height 2 (the -1..1 cube). */
const DEFAULT_CLIP_VOLUME = { x: -1, y: 1, width: 2, height: 2 };

/**
 * Clip-space remap a D3DVIEWPORT2 contributes (ddraw viewport_activate, VERSION_2 branch).
 * dvMinZ/dvMaxZ are consumed here — they are NOT the rasterizer's depth range.
 */
const clipSpaceFromViewport2 = (
    clipX: number, clipY: number, clipW: number, clipH: number, minZ: number, maxZ: number,
) => {
    const dz = maxZ - minZ;
    if (clipW === 0 || clipH === 0 || dz === 0) return { sx: 1, sy: 1, sz: 1, ox: 0, oy: 0, oz: 0 };
    return {
        sx: 2 / clipW,
        sy: 2 / clipH,
        sz: 1 / dz,
        ox: (-2 * clipX) / clipW - 1,
        oy: (-2 * clipY) / clipH + 1,
        oz: -minZ / dz,
    };
};

/**
 * Clip-space remap a D3DVIEWPORT (v1) contributes (same function, VERSION_1 branch): the
 * scale comes from dvScaleX/dvScaleY against the pixel rect, there is no offset, and
 * dvMinZ/dvMaxZ do not participate at all.
 */
const clipSpaceFromViewport1 = (scaleX: number, scaleY: number, width: number, height: number) => {
    if (!width || !height) return { sx: 1, sy: 1, sz: 1, ox: 0, oy: 0, oz: 0 };
    return { sx: (2 * scaleX) / width, sy: (2 * scaleY) / height, sz: 1, ox: 0, oy: 0, oz: 0 };
};

const D3DRECT_SIZE = 16; // D3DRECT structure: 4 LONGs (x1, y1, x2, y2)
const CLEAR2_Z_CAST_BUFFER = new ArrayBuffer(4);
const CLEAR2_Z_CAST_U32 = new Uint32Array(CLEAR2_Z_CAST_BUFFER);
const CLEAR2_Z_CAST_F32 = new Float32Array(CLEAR2_Z_CAST_BUFFER);

/**
 * Validate a guest D3DVIEWPORT/D3DVIEWPORT2 before reading its self-declared size.
 *
 * `perms` is what the CALLER will do with it — every path here writes the struct back
 * except SetViewport. Bounds alone are not validation: a pointer inside guest RAM can
 * still address THUNK_CODE or a NOACCESS region, and only the region map knows that.
 * The dwSize read is guarded separately because the length that bounds the rest of the
 * struct comes out of the struct itself.
 */
export const validateViewportStruct = (
    mem: Uint8Array,
    ptr: number,
    perms: RegionPerms = "rw",
): { ok: boolean; size: number } => {
    if (!ptr) return { ok: false, size: 0 };
    // Protect low memory (0x0-0xFFFF)
    if (ptr < 0x10000 || ptr + 4 > mem.length) return { ok: false, size: 0 };
    if (!isValidAddress(mem, ptr, 4, perms)) return { ok: false, size: 0 };
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const size = view.getUint32(ptr, true);
    // Limit size to prevent buffer overflow (max reasonable structure size)
    const maxSize = Math.max(D3DVIEWPORT_SIZE, D3DVIEWPORT2_SIZE);
    if (size < 4 || size > maxSize || ptr + size > mem.length) {
        return { ok: false, size };
    }
    if (!isValidAddress(mem, ptr, size, perms)) return { ok: false, size };
    return { ok: true, size };
};

/**
 * Find existing Viewport3 object for the same handle (COM Identity)
 * Returns address if found, null otherwise
 */
const findExistingViewport3ForHandle = (
    resourceProvider: any,
    handle: number,
    excludeAddr: number
): number | null => {
    // Search all addresses mapped to this handle
    // Note: handleToAddress stores only one address, but we need to check all objects with same handle
    // We'll iterate through all COM objects to find Viewport3 with same handle
    const allObjects = resourceProvider.getAllComObjects();
    for (const obj of allObjects) {
        if (obj.handle === handle && obj instanceof Direct3DViewport3Object) {
            const addr = resourceProvider.getAddressForHandle(handle);
            if (addr !== null && addr !== excludeAddr) {
                return addr;
            }
        }
    }
    return null;
};

export const createViewportExports = (context: DDrawContext): D3DExports => {
    const exports: D3DExports = {};
    const resourceProvider = context.resourceProvider;
    const getDefaultViewport = () => ({
        x: 0,
        y: 0,
        width: Math.max(1, context.display.width || 640),
        height: Math.max(1, context.display.height || 480),
        minZ: 0,
        maxZ: 1,
    });
    const normalizeViewport = (vp?: { x: number; y: number; width: number; height: number; minZ?: number; maxZ?: number }) => {
        const dv = getDefaultViewport();
        return {
            x: vp?.x ?? dv.x,
            y: vp?.y ?? dv.y,
            width: vp?.width ?? dv.width,
            height: vp?.height ?? dv.height,
            minZ: vp?.minZ ?? dv.minZ,
            maxZ: vp?.maxZ ?? dv.maxZ,
        };
    };

    // --- IDirect3DViewport3 ---

    exports["IDirect3DViewport3_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = resourceProvider.getComObjectByAddress(thisPtr);

        const iidBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            iidBytes[i] = mem[riidPtr + i];
        }
        const iidStr = bytesToGuid(iidBytes);

        Logger.log(LogCategory.COM, `IDirect3DViewport3_QueryInterface: this=0x${thisPtr.toString(16)} iid=${iidStr} ppvObject=0x${ppvObject.toString(16)} obj=${obj ? obj.constructor.name : 'null'}`);

        if (!obj) {
            Logger.warn(LogCategory.COM, `IDirect3DViewport3_QueryInterface: Object not found for thisPtr=0x${thisPtr.toString(16)}`);
            return 0x80004002;
        }

        const result = obj.queryInterface(iidStr, ppvObject, mem);
        if (ppvObject) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const returnedAddr = view.getUint32(ppvObject, true);
            Logger.log(LogCategory.COM, `IDirect3DViewport3_QueryInterface: result=0x${result.toString(16)} returnedAddr=0x${returnedAddr.toString(16)}`);
        }
        return result;
    };

    exports["IDirect3DViewport3_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirect3DViewport3_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    exports["IDirect3DViewport3_GetViewport2"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpData = args[1];
        const guard = validateViewportStruct(mem, lpData);
        if (!guard.ok) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport3Object | null;
        const vp = normalizeViewport(obj?.getViewport());

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const size = Math.min(guard.size, D3DVIEWPORT2_SIZE);
        const clip = obj?.getClipVolume() ?? DEFAULT_CLIP_VOLUME;
        if (size >= 8) view.setUint32(lpData + 4, vp.x, true);
        if (size >= 12) view.setUint32(lpData + 8, vp.y, true);
        if (size >= 16) view.setUint32(lpData + 12, vp.width, true);
        if (size >= 20) view.setUint32(lpData + 16, vp.height, true);
        if (size >= 24) view.setFloat32(lpData + 20, clip.x, true);        // dvClipX
        if (size >= 28) view.setFloat32(lpData + 24, clip.y, true);        // dvClipY
        if (size >= 32) view.setFloat32(lpData + 28, clip.width, true);    // dvClipWidth
        if (size >= 36) view.setFloat32(lpData + 32, clip.height, true);   // dvClipHeight
        if (size >= 40) view.setFloat32(lpData + 36, vp.minZ ?? 0, true);  // dvMinZ
        if (size >= 44) view.setFloat32(lpData + 40, vp.maxZ ?? 1, true);  // dvMaxZ

        return D3D_OK;
    };

    exports["IDirect3DViewport3_SetViewport2"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpData = args[1];
        const { ok, size } = validateViewportStruct(mem, lpData, "r");
        if (!ok) {
            Logger.warn(LogCategory.SYSTEM, `IDirect3DViewport3_SetViewport2: invalid lpData=0x${lpData.toString(16)} size=${size}`);
            return D3DERR_INVALIDCALL;
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const dwSize = Math.min(view.getUint32(lpData, true), D3DVIEWPORT2_SIZE);
        const dwX = dwSize >= 8 ? view.getUint32(lpData + 4, true) : 0;
        const dwY = dwSize >= 12 ? view.getUint32(lpData + 8, true) : 0;
        const dwWidth = dwSize >= 16 ? view.getUint32(lpData + 12, true) : 0;
        const dwHeight = dwSize >= 20 ? view.getUint32(lpData + 16, true) : 0;
        const clipX = dwSize >= 24 ? view.getFloat32(lpData + 20, true) : DEFAULT_CLIP_VOLUME.x;
        const clipY = dwSize >= 28 ? view.getFloat32(lpData + 24, true) : DEFAULT_CLIP_VOLUME.y;
        const clipW = dwSize >= 32 ? view.getFloat32(lpData + 28, true) : DEFAULT_CLIP_VOLUME.width;
        const clipH = dwSize >= 36 ? view.getFloat32(lpData + 32, true) : DEFAULT_CLIP_VOLUME.height;
        const minZ = dwSize >= 40 ? view.getFloat32(lpData + 36, true) : 0;
        const maxZ = dwSize >= 44 ? view.getFloat32(lpData + 40, true) : 1;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport3Object | null;
        if (obj) {
            obj.setViewport(dwX, dwY, dwWidth, dwHeight, minZ, maxZ);
            obj.setClipVolume(clipX, clipY, clipW, clipH);
            const cs = clipSpaceFromViewport2(clipX, clipY, clipW, clipH, minZ, maxZ);
            obj.setClipSpace(cs.sx, cs.sy, cs.sz, cs.ox, cs.oy, cs.oz);
        }

        Logger.verbose(LogCategory.SYSTEM, `IDirect3DViewport3_SetViewport2: lpData=0x${lpData.toString(16)} size=${dwSize} x=${dwX} y=${dwY} w=${dwWidth} h=${dwHeight} clip=(${clipX},${clipY},${clipW},${clipH}) z=(${minZ},${maxZ})`);
        return D3D_OK;
    };

    // D3DVIEWPORT (v1) is 44 bytes; dvScaleX/Y, dvMaxX/Y, dvMinZ, dvMaxZ are float32.
    // Offsets: dwSize 0, dwX 4, dwY 8, dwWidth 12, dwHeight 16,
    //          dvScaleX 20, dvScaleY 24, dvMaxX 28, dvMaxY 32, dvMinZ 36, dvMaxZ 40.
    exports["IDirect3DViewport3_GetViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpData = args[1];
        const guard = validateViewportStruct(mem, lpData);
        if (!guard.ok) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport3Object | null;
        const vp = normalizeViewport(obj?.getViewport());

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const size = Math.min(guard.size, D3DVIEWPORT_SIZE);

        const scaleX = vp.width / 2.0;
        const scaleY = vp.height / 2.0;
        if (size >= 8) view.setUint32(lpData + 4, vp.x, true);
        if (size >= 12) view.setUint32(lpData + 8, vp.y, true);
        if (size >= 16) view.setUint32(lpData + 12, vp.width, true);
        if (size >= 20) view.setUint32(lpData + 16, vp.height, true);
        if (size >= 24) view.setFloat32(lpData + 20, scaleX, true);                    // dvScaleX
        if (size >= 28) view.setFloat32(lpData + 24, scaleY, true);                    // dvScaleY
        if (size >= 32) view.setFloat32(lpData + 28, vp.x + scaleX, true);             // dvMaxX
        if (size >= 36) view.setFloat32(lpData + 32, vp.y + scaleY, true);             // dvMaxY
        if (size >= 40) view.setFloat32(lpData + 36, vp.minZ ?? 0, true);              // dvMinZ
        if (size >= 44) view.setFloat32(lpData + 40, vp.maxZ ?? 1, true);              // dvMaxZ

        return D3D_OK;
    };

    exports["IDirect3DViewport3_SetViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpData = args[1];
        const { ok, size } = validateViewportStruct(mem, lpData, "r");
        if (!ok) {
            Logger.warn(LogCategory.SYSTEM, `IDirect3DViewport3_SetViewport: invalid lpData=0x${lpData.toString(16)} size=${size}`);
            return D3DERR_INVALIDCALL;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const dwSize = Math.min(size, D3DVIEWPORT_SIZE);
        const dwX = dwSize >= 8 ? view.getUint32(lpData + 4, true) : 0;
        const dwY = dwSize >= 12 ? view.getUint32(lpData + 8, true) : 0;
        const dwWidth = dwSize >= 16 ? view.getUint32(lpData + 12, true) : 0;
        const dwHeight = dwSize >= 20 ? view.getUint32(lpData + 16, true) : 0;
        const scaleX = dwSize >= 24 ? view.getFloat32(lpData + 20, true) : dwWidth / 2;  // dvScaleX
        const scaleY = dwSize >= 28 ? view.getFloat32(lpData + 24, true) : dwHeight / 2; // dvScaleY
        const minZ = dwSize >= 40 ? view.getFloat32(lpData + 36, true) : 0;  // dvMinZ
        const maxZ = dwSize >= 44 ? view.getFloat32(lpData + 40, true) : 1;  // dvMaxZ

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport3Object | null;
        if (obj) {
            obj.setViewport(dwX, dwY, dwWidth, dwHeight, minZ, maxZ);
            const cs = clipSpaceFromViewport1(scaleX, scaleY, dwWidth, dwHeight);
            obj.setClipSpace(cs.sx, cs.sy, cs.sz, cs.ox, cs.oy, cs.oz);
        }

        Logger.log(LogCategory.SYSTEM, `IDirect3DViewport3_SetViewport: lpData=0x${lpData.toString(16)} size=${dwSize} x=${dwX} y=${dwY} w=${dwWidth} h=${dwHeight}`);
        return D3D_OK;
    };

    exports["IDirect3DViewport3_SetBackgroundDepth2"] = (ctx, mem, args) => {
        const lpDDSurface = args[1];
        Logger.log(LogCategory.SYSTEM, `IDirect3DViewport3_SetBackgroundDepth2: surface=0x${lpDDSurface.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DViewport3_GetBackgroundDepth2"] = (ctx, mem, args) => {
        const lplpDDSurface = args[1];
        const lpValid = args[2];

        if (lplpDDSurface && isValidAddress(mem, lplpDDSurface, 4, "rw")) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lplpDDSurface, 0, true);
        }
        if (lpValid && isValidAddress(mem, lpValid, 4, "rw")) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpValid, 0, true);
        }
        return D3D_OK;
    };

    exports["IDirect3DViewport3_SetBackground"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const hMat = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport3Object | null;
        if (obj) {
            obj.setBackground(hMat);
        }
        Logger.log(LogCategory.SYSTEM, `IDirect3DViewport3_SetBackground: this=0x${thisPtr.toString(16)} hMat=0x${hMat.toString(16)}`);
        return D3D_OK;
    };

    /**
     * Clear viewport region with proper color, depth, and stencil handling.
     * Supports scissor rects for partial clears. If rects provided, use only rects; else viewport.
     */
    const clearViewportRegion = (
        vpObj: Direct3DViewport3Object | Direct3DViewport2Object | null,
        rtObj: DirectDrawSurfaceObject,
        dwFlags: number,
        clearColor: number,
        depthValue: number,
        context: DDrawContext,
        rects?: Array<{ x1: number, y1: number, x2: number, y2: number }>,
        stencil?: number
    ): void => {
        const state = rtObj.getState();
        const dv = getDefaultViewport();
        const vp = vpObj ? (vpObj instanceof Direct3DViewport3Object ? vpObj.getViewport() :
            (vpObj as any).getViewport?.() || dv) : dv;

        if (state.gpuTextureView && context.executor) {
            const validDepth = (depthValue !== undefined && !isNaN(depthValue) && isFinite(depthValue))
                ? depthValue
                : 1.0;
            const viewportToUse = rects?.length ? undefined : vp;
            context.executor.clear(state, dwFlags, clearColor, validDepth, viewportToUse, rects, stencil);
        }
    };

    // Clear(dwCount, lpRects, dwFlags): respect rects when provided
    exports["IDirect3DViewport3_Clear"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwCount = args[1];
        const lpRects = args[2];
        const dwFlags = args[3];

        Logger.log(LogCategory.SYSTEM, `IDirect3DViewport3_Clear: this=0x${thisPtr.toString(16)} count=${dwCount} flags=0x${dwFlags.toString(16)}`);

        const vpObj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport3Object | null;
        const devAddr = vpObj ? vpObj.getDevice() : 0;
        const devObj = resourceProvider.getComObjectByAddress(devAddr) as Direct3DDevice3Object | null;
        const rtAddr = devObj ? devObj.getRenderTarget() : (context.surfaces.backBuffer || context.surfaces.primary);

        if (rtAddr) {
            const rtObj = resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null;
            if (rtObj) {
                // Resolve background material emissive color (D3D3 background clear uses emissive component)
                let clearColor = 0;
                if (vpObj) {
                    const bgHandle = vpObj.getBackground();
                    if (bgHandle) {
                        const matObj = resourceProvider.getComObject(bgHandle) as Direct3DMaterial3Object | null;
                        if (matObj) {
                            const d = matObj.getMaterialData();
                            // Use emissive color (D3D3 background fill = emissive); fall back to diffuse
                            const em = d.emissive;
                            const df = d.diffuse;
                            const hasEmissive = em.r !== 0 || em.g !== 0 || em.b !== 0;
                            const col = hasEmissive ? em : df;
                            const r = Math.round(col.r * 255) & 0xFF;
                            const g = Math.round(col.g * 255) & 0xFF;
                            const b = Math.round(col.b * 255) & 0xFF;
                            clearColor = 0xFF000000 | (r << 16) | (g << 8) | b;
                        }
                    }
                    if (!clearColor) clearColor = vpObj.getBackgroundColor();
                }
                const vp = vpObj ? vpObj.getViewport() : getDefaultViewport();
                const depthValue = (dwFlags & D3DCLEAR_ZBUFFER) ? 1.0 : (vp.maxZ ?? 1.0);
                const rects = readD3DRects(mem, lpRects, dwCount);

                clearViewportRegion(vpObj, rtObj, dwFlags, clearColor, depthValue, context, rects ?? undefined, 0);
            }
        }
        return D3D_OK;
    };

    /**
     * Read D3DRECT array from memory.
     * Bounds-check: clamp n = min(dwCount>>>0, 256) first to avoid overflow in n*16.
     */
    const readD3DRects = (mem: Uint8Array, lpRects: number, dwCount: number): Array<{ x1: number, y1: number, x2: number, y2: number }> | null => {
        if (!lpRects || dwCount === 0) return null;
        const n = Math.min(dwCount >>> 0, 256);
        if (n === 0) return null;
        if (lpRects < 0 || lpRects + n * D3DRECT_SIZE > mem.length) {
            Logger.warn(LogCategory.SYSTEM, `readD3DRects: lpRects=0x${lpRects.toString(16)} n=${n} out of bounds`);
            return null;
        }
        if (dwCount > 256) {
            Logger.warn(LogCategory.SYSTEM, `readD3DRects: dwCount=${dwCount} too large, clamping to 256`);
        }

        const rects: Array<{ x1: number, y1: number, x2: number, y2: number }> = [];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < n; i++) {
            const rectPtr = lpRects + i * D3DRECT_SIZE;
            rects.push({
                x1: view.getInt32(rectPtr, true),
                y1: view.getInt32(rectPtr + 4, true),
                x2: view.getInt32(rectPtr + 8, true),
                y2: view.getInt32(rectPtr + 12, true),
            });
        }
        return rects.length > 0 ? rects : null;
    };

    exports["IDirect3DViewport3_Clear2"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwCount = args[1];
        const lpRects = args[2];
        const dwFlags = args[3];
        const dwColor = args[4];
        CLEAR2_Z_CAST_U32[0] = args[5];
        const dvZ = CLEAR2_Z_CAST_F32[0];
        const dwStencil = args[6];

        Logger.verboseLazy(LogCategory.SYSTEM, () => `IDirect3DViewport3_Clear2: this=0x${thisPtr.toString(16)} count=${dwCount} flags=0x${dwFlags.toString(16)} color=0x${dwColor.toString(16)} z=${dvZ}`);

        const vpObj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport3Object | null;
        if (!vpObj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DViewport3_Clear2: invalid viewport this=0x${thisPtr.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        const devAddr = vpObj.getDevice();
        const devObj = resourceProvider.getComObjectByAddress(devAddr) as Direct3DDevice3Object | null;
        if (!devObj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DViewport3_Clear2: viewport has no device this=0x${thisPtr.toString(16)} dev=0x${devAddr.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        if (dwCount > 0 && lpRects === 0) {
            return DDERR_INVALIDPARAMS;
        }

        const rtAddr = devObj.getRenderTarget();
        if (!rtAddr) {
            return D3D_OK;
        }

        const rtObj = resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null;
        if (!rtObj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DViewport3_Clear2: invalid render target addr=0x${rtAddr.toString(16)}`);
            return D3D_OK;
        }

        const rects = readD3DRects(mem, lpRects, dwCount);
        if (rects && rects.length > 0 && Logger.isEnabled(LogCategory.SYSTEM, LogLevel.VERBOSE)) {
            Logger.verbose(LogCategory.SYSTEM, `IDirect3DViewport3_Clear2: Processing ${rects.length} rects`);
        }

        // Clear2 has explicit Z argument; always use bitcast depth value as-is.
        clearViewportRegion(vpObj, rtObj, dwFlags, dwColor, dvZ, context, rects || undefined, dwStencil);
        return D3D_OK;
    };

    const viewportStubs = [
        "Initialize",
        "TransformVertices",
        "LightElements",
        "GetBackground",
        "SetBackgroundDepth",
        "GetBackgroundDepth",
        "AddLight",
        "DeleteLight",
        "NextLight",
    ];

    for (const method of viewportStubs) {
        exports[`IDirect3DViewport3_${method}`] = () => D3D_OK;
    }

    // --- IDirect3DViewport2 ---

    // COM Identity - reuse existing Viewport3 object instead of creating new
    exports["IDirect3DViewport2_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = resourceProvider.getComObjectByAddress(thisPtr);
        if (!obj) return 0x80004002;
        // Both borrowed: the IID is read whole, the out-param written, and every branch
        // below writes it — so validate once here rather than at each return path.
        if (!riidPtr || !isValidAddress(mem, riidPtr, 16, "r")) return E_POINTER;
        if (!ppvObject || !isValidAddress(mem, ppvObject, 4, "rw")) return E_POINTER;

        const iidBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            iidBytes[i] = mem[riidPtr + i];
        }
        const iidStr = bytesToGuid(iidBytes);
        const iidNormalized = iidStr.replace(/[{}]/g, "").toLowerCase();

        // If querying for IDirect3DViewport3 from IDirect3DViewport2
        if (iidNormalized === IID_IDirect3DViewport3.toLowerCase()) {
            const handle = obj.handle;
            
            // First check if Viewport3 already exists for this handle
            const existingVp3Addr = findExistingViewport3ForHandle(resourceProvider, handle, thisPtr);
            if (existingVp3Addr !== null) {
                const vp3Obj = resourceProvider.getComObjectByAddress(existingVp3Addr);
                if (vp3Obj instanceof Direct3DViewport3Object) {
                    obj.addRef();
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(ppvObject, existingVp3Addr, true);
                    Logger.log(LogCategory.COM, `IDirect3DViewport2_QueryInterface: Reusing existing Viewport3 at 0x${existingVp3Addr.toString(16)} (COM Identity)`);
                    return D3D_OK;
                }
            }

            // Fallback: check via getAddressForHandle (might return Viewport2 address)
            const vp3Addr = resourceProvider.getAddressForHandle(handle);
            if (vp3Addr !== null && vp3Addr !== thisPtr) {
                const vp3Obj = resourceProvider.getComObjectByAddress(vp3Addr);
                if (vp3Obj instanceof Direct3DViewport3Object) {
                    obj.addRef();
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(ppvObject, vp3Addr, true);
                    Logger.log(LogCategory.COM, `IDirect3DViewport2_QueryInterface: Returning Viewport3 address 0x${vp3Addr.toString(16)} for same object (COM Identity)`);
                    return D3D_OK;
                }
            }

            // Only create new Viewport3 if none exists (COM Identity: one object per handle)
            const vtableAddr = context.vtables.IDirect3DViewport3?.address;
            if (!vtableAddr || !ppvObject) return 0x80004002;

            const vp3 = ComObjectFactory.create(IID_IDirect3DViewport3, vtableAddr) as Direct3DViewport3Object;
            if (!vp3) return 0x80004005;

            const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppvObject, objAddr, true);

            // Map to same handle (COM Identity)
            resourceProvider.mapAddressToHandle(objAddr, handle);
            vp3.setViewport2Address(thisPtr);
            Logger.log(LogCategory.COM, `IDirect3DViewport2_QueryInterface: Created Viewport3 at 0x${objAddr.toString(16)} and mapped to same handle 0x${handle.toString(16)} (COM Identity)`);
            return D3D_OK;
        }

        return obj.queryInterface(iidStr, ppvObject, mem);
    };

    exports["IDirect3DViewport2_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirect3DViewport2_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    exports["IDirect3DViewport2_GetViewport2"] = (ctx, mem, args) => {
        const lpData = args[1];
        const guard = validateViewportStruct(mem, lpData);
        if (!guard.ok) return D3DERR_INVALIDCALL;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const size = Math.min(guard.size, D3DVIEWPORT2_SIZE); // Buffer overflow protection
        const obj = resourceProvider.getComObjectByAddress(args[0]) as any;
        const vp = normalizeViewport(obj?.getViewport?.());

        // Limit loop to prevent buffer overflow
        const safeSize = Math.min(size, D3DVIEWPORT2_SIZE);
        if (safeSize >= 4 && lpData + safeSize <= mem.length) {
            // Zero out structure (but don't overwrite size field)
            for (let i = 4; i < safeSize; i++) {
                mem[lpData + i] = 0;
            }
            view.setUint32(lpData, safeSize, true);
            const clip = obj?.getClipVolume?.() ?? DEFAULT_CLIP_VOLUME;
            if (safeSize >= 8) view.setUint32(lpData + 4, vp.x, true);
            if (safeSize >= 12) view.setUint32(lpData + 8, vp.y, true);
            if (safeSize >= 16) view.setUint32(lpData + 12, vp.width, true);
            if (safeSize >= 20) view.setUint32(lpData + 16, vp.height, true);
            if (safeSize >= 24) view.setFloat32(lpData + 20, clip.x, true);        // dvClipX
            if (safeSize >= 28) view.setFloat32(lpData + 24, clip.y, true);        // dvClipY
            if (safeSize >= 32) view.setFloat32(lpData + 28, clip.width, true);    // dvClipWidth
            if (safeSize >= 36) view.setFloat32(lpData + 32, clip.height, true);   // dvClipHeight
            if (safeSize >= 40) view.setFloat32(lpData + 36, vp.minZ ?? 0, true);  // dvMinZ
            if (safeSize >= 44) view.setFloat32(lpData + 40, vp.maxZ ?? 1, true);  // dvMaxZ
        }
        return D3D_OK;
    };

    exports["IDirect3DViewport2_SetViewport2"] = (ctx, mem, args) => {
        const lpData = args[1];
        const { ok, size } = validateViewportStruct(mem, lpData, "r");
        if (!ok) {
            Logger.warn(LogCategory.SYSTEM, `IDirect3DViewport2_SetViewport2: invalid lpData=0x${lpData.toString(16)} size=${size} mem=0x${mem.length.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const dwSize = Math.min(view.getUint32(lpData, true), D3DVIEWPORT2_SIZE);
        const dwX = dwSize >= 8 ? view.getUint32(lpData + 4, true) : 0;
        const dwY = dwSize >= 12 ? view.getUint32(lpData + 8, true) : 0;
        const dwWidth = dwSize >= 16 ? view.getUint32(lpData + 12, true) : 0;
        const dwHeight = dwSize >= 20 ? view.getUint32(lpData + 16, true) : 0;
        const clipX = dwSize >= 24 ? view.getFloat32(lpData + 20, true) : DEFAULT_CLIP_VOLUME.x;
        const clipY = dwSize >= 28 ? view.getFloat32(lpData + 24, true) : DEFAULT_CLIP_VOLUME.y;
        const clipW = dwSize >= 32 ? view.getFloat32(lpData + 28, true) : DEFAULT_CLIP_VOLUME.width;
        const clipH = dwSize >= 36 ? view.getFloat32(lpData + 32, true) : DEFAULT_CLIP_VOLUME.height;
        const minZ = dwSize >= 40 ? view.getFloat32(lpData + 36, true) : 0;
        const maxZ = dwSize >= 44 ? view.getFloat32(lpData + 40, true) : 1;
        const obj = resourceProvider.getComObjectByAddress(args[0]) as any;
        if (obj?.setViewport) {
            obj.setViewport(dwX, dwY, dwWidth, dwHeight, minZ, maxZ);
            obj.setClipVolume?.(clipX, clipY, clipW, clipH);
            const cs = clipSpaceFromViewport2(clipX, clipY, clipW, clipH, minZ, maxZ);
            obj.setClipSpace?.(cs.sx, cs.sy, cs.sz, cs.ox, cs.oy, cs.oz);
        }
        Logger.log(LogCategory.SYSTEM, `IDirect3DViewport2_SetViewport2: lpData=0x${lpData.toString(16)} size=${dwSize} x=${dwX} y=${dwY} w=${dwWidth} h=${dwHeight}`);
        return D3D_OK;
    };

    // D3DVIEWPORT v1: 44 bytes, float32 at 20–40 (same layout as Viewport3).
    exports["IDirect3DViewport2_GetViewport"] = (ctx, mem, args) => {
        const lpData = args[1];
        const guard = validateViewportStruct(mem, lpData);
        if (!guard.ok) return D3DERR_INVALIDCALL;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const size = Math.min(view.getUint32(lpData, true), D3DVIEWPORT_SIZE);
        const obj = resourceProvider.getComObjectByAddress(args[0]) as any;
        const vp = normalizeViewport(obj?.getViewport?.());

        const safeSize = Math.min(size, D3DVIEWPORT_SIZE);
        if (safeSize >= 4 && lpData + safeSize <= mem.length) {
            for (let i = 4; i < safeSize; i++) mem[lpData + i] = 0;
            view.setUint32(lpData, safeSize, true);
            const scaleX = vp.width / 2.0;
            const scaleY = vp.height / 2.0;
            if (safeSize >= 8) view.setUint32(lpData + 4, vp.x, true);
            if (safeSize >= 12) view.setUint32(lpData + 8, vp.y, true);
            if (safeSize >= 16) view.setUint32(lpData + 12, vp.width, true);
            if (safeSize >= 20) view.setUint32(lpData + 16, vp.height, true);
            if (safeSize >= 24) view.setFloat32(lpData + 20, scaleX, true);            // dvScaleX
            if (safeSize >= 28) view.setFloat32(lpData + 24, scaleY, true);            // dvScaleY
            if (safeSize >= 32) view.setFloat32(lpData + 28, vp.x + scaleX, true);     // dvMaxX
            if (safeSize >= 36) view.setFloat32(lpData + 32, vp.y + scaleY, true);     // dvMaxY
            if (safeSize >= 40) view.setFloat32(lpData + 36, vp.minZ ?? 0, true);      // dvMinZ
            if (safeSize >= 44) view.setFloat32(lpData + 40, vp.maxZ ?? 1, true);      // dvMaxZ
        }
        return D3D_OK;
    };

    exports["IDirect3DViewport2_SetViewport"] = (ctx, mem, args) => {
        const lpData = args[1];
        const { ok, size } = validateViewportStruct(mem, lpData, "r");
        if (!ok) {
            Logger.warn(LogCategory.SYSTEM, `IDirect3DViewport2_SetViewport: invalid lpData=0x${lpData.toString(16)} size=${size}`);
            return D3DERR_INVALIDCALL;
        }
        const safeSize = Math.min(size, D3DVIEWPORT_SIZE);
        if (safeSize >= 8) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const dwX = view.getUint32(lpData + 4, true);
            const dwY = safeSize >= 12 ? view.getUint32(lpData + 8, true) : 0;
            const dwWidth = safeSize >= 16 ? view.getUint32(lpData + 12, true) : 0;
            const dwHeight = safeSize >= 20 ? view.getUint32(lpData + 16, true) : 0;
            const scaleX = safeSize >= 24 ? view.getFloat32(lpData + 20, true) : dwWidth / 2;  // dvScaleX
            const scaleY = safeSize >= 28 ? view.getFloat32(lpData + 24, true) : dwHeight / 2; // dvScaleY
            const minZ = safeSize >= 40 ? view.getFloat32(lpData + 36, true) : 0;  // dvMinZ
            const maxZ = safeSize >= 44 ? view.getFloat32(lpData + 40, true) : 1;  // dvMaxZ
            const obj = resourceProvider.getComObjectByAddress(args[0]) as any;
            if (obj?.setViewport) {
                obj.setViewport(dwX, dwY, dwWidth, dwHeight, minZ, maxZ);
                const cs = clipSpaceFromViewport1(scaleX, scaleY, dwWidth, dwHeight);
                obj.setClipSpace?.(cs.sx, cs.sy, cs.sz, cs.ox, cs.oy, cs.oz);
            }
        }
        Logger.log(LogCategory.SYSTEM, `IDirect3DViewport2_SetViewport: lpData=0x${lpData.toString(16)} size=${safeSize}`);
        return D3D_OK;
    };

    exports["IDirect3DViewport2_SetBackground"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const hMat = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport2Object | null;
        if (obj) {
            obj.setBackground(hMat);
        }
        Logger.log(LogCategory.SYSTEM, `IDirect3DViewport2_SetBackground: this=0x${thisPtr.toString(16)} hMat=0x${hMat.toString(16)}`);
        return D3D_OK;
    };

    // Clear(dwCount, lpRects, dwFlags): respect rects when provided
    exports["IDirect3DViewport2_Clear"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwCount = args[1];
        const lpRects = args[2];
        const dwFlags = args[3];

        Logger.verbose(LogCategory.SYSTEM, `IDirect3DViewport2_Clear: this=0x${thisPtr.toString(16)} count=${dwCount} flags=0x${dwFlags.toString(16)}`);

        const vpObj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DViewport2Object | null;
        const rtAddr = context.surfaces.backBuffer || context.surfaces.primary;
        if (!rtAddr) return D3D_OK;

        const rtObj = resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null;
        if (!rtObj) return D3D_OK;

        // Resolve background material emissive color (same logic as Viewport3_Clear)
        let clearColor = 0;
        if (vpObj) {
            const bgHandle = (vpObj as any).getBackground?.() ?? 0;
            if (bgHandle) {
                const matObj = resourceProvider.getComObject(bgHandle) as Direct3DMaterial3Object | null;
                if (matObj) {
                    const d = matObj.getMaterialData();
                    const em = d.emissive;
                    const df = d.diffuse;
                    const hasEmissive = em.r !== 0 || em.g !== 0 || em.b !== 0;
                    const col = hasEmissive ? em : df;
                    const r = Math.round(col.r * 255) & 0xFF;
                    const g = Math.round(col.g * 255) & 0xFF;
                    const b = Math.round(col.b * 255) & 0xFF;
                    clearColor = 0xFF000000 | (r << 16) | (g << 8) | b;
                }
            }
        }
        const vp = vpObj ? (vpObj as any).getViewport?.() || getDefaultViewport() : getDefaultViewport();
        const depthValue = (dwFlags & D3DCLEAR_ZBUFFER) ? 1.0 : (vp.maxZ ?? 1.0);
        const rects = readD3DRects(mem, lpRects, dwCount);

        clearViewportRegion(vpObj, rtObj, dwFlags, clearColor, depthValue, context, rects ?? undefined);

        return D3D_OK;
    };

    const viewport2Stubs = [
        "Initialize",
        "TransformVertices",
        "LightElements",
        "GetBackground",
        "SetBackgroundDepth",
        "GetBackgroundDepth",
        "AddLight",
        "DeleteLight",
        "NextLight",
    ];

    for (const method of viewport2Stubs) {
        exports[`IDirect3DViewport2_${method}`] = () => D3D_OK;
    }

    return exports;
};
