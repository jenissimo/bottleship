/**
 * IDirect3DDevice3 and IDirect3DDevice7 implementations
 */
import { Logger, LogCategory, LogLevel } from "../../../core/logger";
import { assignStubsOnce } from "../../../core/thunking/stub-merge";
import { ThunkImplementation } from "../../../core/thunking/thunk-dispatcher";
import { System } from "../../../core/system";
import { DDrawContext } from "../context";
import { resolveDDrawTearOff } from "../com-tearoff";
import { bytesToGuid } from "../helpers";
import { isValidAddress } from "../../../core/memory/address-guard";
import { initReturnPtr } from "../../../backends/webgpu/shared/dx-com-helpers";
import { asArrayBuffer } from "../../../../dom-buffer";
import {
    DDPF_ALPHAPIXELS,
    DDPF_RGB,
    DDPF_FOURCC,
    DDPF_PALETTEINDEXED8,
    SUPPORTED_FOURCC_CODES,
    DDPIXELFORMAT_OFFSETS,
    DDSCAPS_TEXTURE,
    DDSD_CAPS,
    DDSD_PIXELFORMAT,
    DDSURFACEDESC_OFFSETS,
    DDSURFACEDESC_SIZE,
    DDSURFACEDESC2_OFFSETS,
    IID_IDirect3D,
    IID_IDirect3D2,
    IID_IDirect3D7,
    IID_IDirect3D3,
    IID_IDirect3DDevice3,
    IID_IDirectDraw7,
    D3DTSS_COLOROP,
    D3DTSS_COLORARG1,
    D3DTSS_COLORARG2,
    D3DTSS_ALPHAOP,
    D3DTSS_ALPHAARG1,
    D3DTSS_ALPHAARG2,
    // Lighting structure offsets
    D3DMATERIAL7_SIZE,
    D3DMATERIAL7_OFFSETS,
    D3DLIGHT7_SIZE,
    D3DLIGHT7_OFFSETS,
    D3DCOLORVALUE_OFFSETS,
    D3DVECTOR_OFFSETS,
    D3D_MAX_LIGHTS,
    D3DVIEWPORT7_SIZE,
    D3DVIEWPORT7_OFFSETS,
    E_INVALIDARG,
    allocateComObject,
} from "../constants";
import { ComObjectFactory } from "../../../core/com/base-com-object";
import {
    DirectDrawSurfaceObject,
    DirectDrawSurfaceState,
    Direct3DDevice3Object,
    Direct3DDevice7Object,
    Direct3DViewport3Object,
    Direct3DVertexBufferObject,
    isRenderSurface,
    isBitmapTexture,
} from "../com-objects";
import {
    D3DExports,
    D3D_OK,
    D3DERR_INVALIDCALL,
    TextureManager,
    DrawHandler,
    D3DMaterial7Data,
    D3DLight7Data,
    D3DColorValue,
    D3DVector,
} from "./types";
import { setDeviceRenderTarget } from "./texture-manager";
import { surfaceSyncManager, syncActiveGdiContextBeforeD3D } from "../surface-sync";
import { createDeviceStubsExports } from "./device-impl-stubs";
import { frustumPlanesFromCombined, sphereVisibilityBits, clipBitsToD3dVis } from "./sphere-visibility";
import {
    fillDeviceDesc,
    fillDeviceDesc7,
    D3DDEVICEDESC7_SIZE,
    D3D7_HAL_DEVICE_GUID_BYTES,
    d3d7DeviceGuidForKind,
} from "./d3d-caps-utils";

interface EnumTextureFormat {
    bpp: number;
    r: number;
    g: number;
    b: number;
    a: number;
    flags: number;
    fourCC?: number;
}

/**
 * The uncompressed RGB formats EnumTextureFormats has always offered. ARGB1555 comes before
 * XRGB1555 so games needing alpha (foliage, particles) get it; transparency for alpha=0 is
 * then handled by blend state, and when blending is off the shader forces alpha=1.0 so black
 * objects do not turn transparent. Thief needs ARGB1555 and RGB565 present to accept
 * hardware mode. Order is load-bearing beyond that too: apps stop enumerating as soon as
 * they find a format they like, so nothing may be inserted ABOVE these six.
 */
const ENUM_TEXTURE_FORMATS_RGB: ReadonlyArray<EnumTextureFormat> = [
    { bpp: 16, r: 0xF800, g: 0x07E0, b: 0x001F, a: 0x0000, flags: DDPF_RGB },                                            // RGB565
    { bpp: 16, r: 0x7C00, g: 0x03E0, b: 0x001F, a: 0x8000, flags: DDPF_RGB | DDPF_ALPHAPIXELS },                         // ARGB1555
    { bpp: 16, r: 0x7C00, g: 0x03E0, b: 0x001F, a: 0x0000, flags: DDPF_RGB },                                            // XRGB1555
    { bpp: 32, r: 0x00FF0000, g: 0x0000FF00, b: 0x000000FF, a: 0x00000000, flags: DDPF_RGB },                            // X8R8G8B8
    { bpp: 16, r: 0x0F00, g: 0x00F0, b: 0x000F, a: 0xF000, flags: DDPF_RGB | DDPF_ALPHAPIXELS },                         // ARGB4444
    { bpp: 32, r: 0x00FF0000, g: 0x0000FF00, b: 0x000000FF, a: 0xFF000000, flags: DDPF_RGB | DDPF_ALPHAPIXELS },         // A8R8G8B8
];

/**
 * Palettised 8-bit. The surface path handles it end to end — detectPixelFormat →
 * PixelFormat.PALETTE8, a palette-aware decode, a GPU LUT upload, and colour-key compared as
 * a palette INDEX. Never enumerating it told every palettised title the hardware had no such
 * texture format, which costs it palette-cycling animation as a MECHANISM, not just a layout.
 */
const ENUM_TEXTURE_FORMAT_P8: EnumTextureFormat =
    { bpp: 8, r: 0, g: 0, b: 0, a: 0, flags: DDPF_PALETTEINDEXED8 | DDPF_RGB };

/**
 * DXT1..DXT5 (DX6 and later — absent from the IDirect3DDevice2/DX5 list for that reason).
 * A DDPF_FOURCC descriptor carries no masks and no bit count by contract; the block layout
 * comes from the FourCC alone, and decodeSurfaceFormatToRgba8 routes it to the block decoder.
 * Descriptor and ordering match a real driver's (Wine ddrawformat_from_wined3dformat:
 * DDPF_FOURCC + dwFourCC, everything else zero; DXT last, after P8; absent from the DX5 list).
 */
const ENUM_TEXTURE_FORMATS_DXT: ReadonlyArray<EnumTextureFormat> = SUPPORTED_FOURCC_CODES.map(
    (code) => ({ bpp: 0, r: 0, g: 0, b: 0, a: 0, flags: DDPF_FOURCC, fourCC: code })
);

/** DX6+ (IDirect3DDevice3 / IDirect3DDevice7). */
const ENUM_TEXTURE_FORMATS: ReadonlyArray<EnumTextureFormat> = [
    ...ENUM_TEXTURE_FORMATS_RGB, ENUM_TEXTURE_FORMAT_P8, ...ENUM_TEXTURE_FORMATS_DXT,
];

/** DX5 (IDirect3DDevice2) — no block-compressed formats existed yet. */
const ENUM_TEXTURE_FORMATS_DX5: ReadonlyArray<EnumTextureFormat> = [
    ...ENUM_TEXTURE_FORMATS_RGB, ENUM_TEXTURE_FORMAT_P8,
];

export const createDeviceExports = (
    context: DDrawContext,
    textureManager: TextureManager,
    drawHandler: DrawHandler
): D3DExports => {
    const exports: D3DExports = {};
    const resourceProvider = context.resourceProvider;

    // ==========================================================================
    // PERFORMANCE OPTIMIZATION: Cached DataView and Matrix Pool
    // ==========================================================================
    // Instead of creating new DataView on every thunk call (700K+ allocations),
    // we cache a single DataView and only recreate when the underlying buffer changes.
    let cachedDataView: DataView | null = null;
    let cachedBuffer: ArrayBuffer | null = null;

    /**
     * Get a cached DataView for the given memory buffer.
     * This avoids allocating a new DataView on every thunk call.
     */
    const getDataView = (mem: Uint8Array): DataView => {
        if (cachedBuffer !== mem.buffer || !cachedDataView) {
            cachedDataView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            cachedBuffer = asArrayBuffer(mem.buffer);
        }
        return cachedDataView;
    };

    // Matrix pool for SetTransform - avoids allocating Float32Array(16) on every call
    const matrixPool: Float32Array[] = [];
    const MAX_POOL_SIZE = 32;

    /**
     * Acquire a Float32Array(16) from the pool or create a new one.
     */
    const acquireMatrix = (): Float32Array => {
        return matrixPool.pop() || new Float32Array(16);
    };

    /**
     * Release a Float32Array(16) back to the pool for reuse.
     */
    const releaseMatrix = (m: Float32Array): void => {
        if (matrixPool.length < MAX_POOL_SIZE) {
            matrixPool.push(m);
        }
    };

    // ==========================================================================

    // Helper function to check if a vtable address belongs to our vtables
    const isOurVTable = (vtableAddr: number): boolean => {
        for (const vtableInfo of Object.values(context.vtables)) {
            if (vtableInfo.address === vtableAddr) {
                return true;
            }
        }
        return false;
    };

    // --- IDirect3DDevice7 ---

    exports["IDirect3DDevice7_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = resourceProvider.getComObjectByAddress(thisPtr);

        const iidBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            iidBytes[i] = mem[riidPtr + i];
        }
        const iidStr = bytesToGuid(iidBytes);

        Logger.log(LogCategory.COM, `IDirect3DDevice7_QueryInterface: this=0x${thisPtr.toString(16)} iid=${iidStr} ppvObject=0x${ppvObject.toString(16)} obj=${obj ? obj.constructor.name : 'null'}`);

        if (!obj) {
            Logger.warn(LogCategory.COM, `IDirect3DDevice7_QueryInterface: Object not found for thisPtr=0x${thisPtr.toString(16)}`);
            return 0x80004002;
        }

        // DX7: a device can hand back the owning IDirectDraw7 via QueryInterface. Blade relies on
        // this — on failure it releases the device (cleanup-on-failure), driving refcount to 0 so
        // we destroy a device it keeps using, then spins on the dead pointer. Return a LIVE
        // IDirectDraw7 (AddRef'd) so the game stays on its success path. All our DDraw objects share
        // one context (display/surfaces), so any live instance is functionally equivalent; prefer
        // the tracked one, else find any live DirectDrawObject (the game's churn creates/destroys
        // several during device enumeration, so the tracked addr can be stale).
        if (iidStr.replace(/[{}]/g, "").toLowerCase() === IID_IDirectDraw7.toLowerCase()) {
            let ddAddr = context.ddraw7ObjectAddr >>> 0;
            let ddObj = ddAddr ? resourceProvider.getComObjectByAddress(ddAddr) : null;
            if (!ddObj || ddObj.constructor.name !== "DirectDrawObject") {
                ddObj = null;
                let bestHandle = -1;
                for (const o of resourceProvider.getAllComObjects()) {
                    if (o.constructor.name === "DirectDrawObject" && o.handle > bestHandle) {
                        const a = resourceProvider.getAddressForHandle(o.handle);
                        if (a) { bestHandle = o.handle; ddObj = o; ddAddr = a >>> 0; }
                    }
                }
            }
            if (ddObj && ppvObject) {
                ddObj.addRef();
                getDataView(mem).setUint32(ppvObject, ddAddr, true);
                Logger.log(LogCategory.COM, `IDirect3DDevice7_QueryInterface(IID_IDirectDraw7) -> 0x${ddAddr.toString(16)}`);
                return D3D_OK;
            }
            Logger.warn(LogCategory.COM, `IDirect3DDevice7_QueryInterface(IID_IDirectDraw7): no live DDraw7 found`);
        }

        const result = obj.queryInterface(iidStr, ppvObject, mem);
        if (ppvObject) {
            const view = getDataView(mem);
            const returnedAddr = view.getUint32(ppvObject, true);
            Logger.log(LogCategory.COM, `IDirect3DDevice7_QueryInterface: result=0x${result.toString(16)} returnedAddr=0x${returnedAddr.toString(16)}`);
        }
        return result;
    };

    exports["IDirect3DDevice7_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirect3DDevice7_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    exports["IDirect3DDevice7_GetCaps"] = (ctx, mem, args) => {
        const lpCaps = args[1];
        if (!lpCaps || !isValidAddress(mem, lpCaps, D3DDEVICEDESC7_SIZE)) return 0x80004003;

        // Echo the device kind the game created (rgb/hal/tnlhal): the GUID selects the
        // per-kind dwDevCaps split inside fillDeviceDesc7. Fallback = old HAL echo.
        const devObj = resourceProvider.getComObjectByAddress(args[0]) as Direct3DDevice7Object | null;
        const guid = devObj instanceof Direct3DDevice7Object
            ? d3d7DeviceGuidForKind(devObj.getD3d7DeviceKind())
            : D3D7_HAL_DEVICE_GUID_BYTES;

        const view = getDataView(mem);
        fillDeviceDesc7(view, lpCaps, guid);

        return D3D_OK;
    };

    // IDirect3DDevice7_Clear: must run before draw, clears RT/depth so no trails.
    // Clear is scoped to current viewport; when no rects, pass full-RT viewport so we don't clear "everything".
    // Signature: Clear(dwCount, lpRects, dwFlags, dwColor, dvZ, dwStencil)
    exports["IDirect3DDevice7_Clear"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwCount = args[1];
        const lpRects = args[2];
        const dwFlags = args[3];
        const dwColor = args[4];
        const dvZBits = args[5];
        const dwStencil = args[6];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        Logger.log(LogCategory.DDRAW, `IDirect3DDevice7_Clear: flags=0x${(dwFlags>>>0).toString(16)} color=0x${(dwColor>>>0).toString(16)} z=${dvZBits} stencil=${dwStencil} rects=${dwCount}`);
        if (!obj || !context.executor) return D3D_OK;
        const rtAddr = obj.getRenderTarget() || context.surfaces.backBuffer || context.surfaces.primary;
        if (!rtAddr) return D3D_OK;
        const rtObj = resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null;
        if (!rtObj) return D3D_OK;
        const state = rtObj.getState();
        const zBuf = new Uint32Array(1);
        zBuf[0] = dvZBits >>> 0;
        const dvZ = new Float32Array(zBuf.buffer)[0];
        const validDepth = (typeof dvZ === "number" && !isNaN(dvZ) && isFinite(dvZ)) ? dvZ : 1.0;

        let rects: Array<{ x1: number; y1: number; x2: number; y2: number }> | undefined;
        const n = Math.min(dwCount >>> 0, 256);
        if (n > 0 && lpRects != null && lpRects >= 0 && lpRects + n * 16 <= mem.length) {
            rects = [];
            const view = getDataView(mem); // OPTIMIZED: Use cached DataView
            for (let i = 0; i < n; i++) {
                const p = lpRects + i * 16;
                rects.push({
                    x1: view.getInt32(p, true),
                    y1: view.getInt32(p + 4, true),
                    x2: view.getInt32(p + 8, true),
                    y2: view.getInt32(p + 12, true),
                });
            }
        }

        let viewport: { x: number; y: number; width: number; height: number } | undefined;
        if (rects?.length) {
            viewport = undefined;
        } else {
            const vp = obj.getViewportData();
            viewport = vp
                ? { x: vp.x, y: vp.y, width: vp.width, height: vp.height }
                : { x: 0, y: 0, width: state.width, height: state.height };
        }
        context.executor.clear(state, dwFlags, dwColor, validDepth, viewport, rects, dwStencil);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_SetViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpViewport = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3D_OK;
        // D3DVIEWPORT7 is 24 bytes and has NO leading dwSize — unlike D3DVIEWPORT/D3DVIEWPORT2,
        // which do (d3dtypes.h). Reading a size field here consumes dwX, shifts every field by
        // one DWORD and hands back width/height of 0 for the overwhelmingly common x=0 viewport.
        if (!lpViewport || !isValidAddress(mem, lpViewport, D3DVIEWPORT7_SIZE)) return D3DERR_INVALIDCALL;
        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        const x = view.getUint32(lpViewport + D3DVIEWPORT7_OFFSETS.x, true);
        const y = view.getUint32(lpViewport + D3DVIEWPORT7_OFFSETS.y, true);
        const w = view.getUint32(lpViewport + D3DVIEWPORT7_OFFSETS.width, true);
        const h = view.getUint32(lpViewport + D3DVIEWPORT7_OFFSETS.height, true);
        const minZ = view.getFloat32(lpViewport + D3DVIEWPORT7_OFFSETS.minZ, true);
        const maxZ = view.getFloat32(lpViewport + D3DVIEWPORT7_OFFSETS.maxZ, true);
        // The viewport must lie inside the render target; out of range leaves the previous
        // viewport untouched (d3d_device7_SetViewport's wined3d_bound_range check).
        const rtAddr = obj.getRenderTarget() || context.surfaces.backBuffer || context.surfaces.primary;
        const rtState = rtAddr
            ? (resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null)?.getState()
            : null;
        if (rtState && (x > rtState.width || w > rtState.width - x ||
                        y > rtState.height || h > rtState.height - y)) {
            Logger.warn(LogCategory.DDRAW,
                `IDirect3DDevice7_SetViewport: out of range ${x},${y} ${w}x${h} for RT ${rtState.width}x${rtState.height}`);
            return E_INVALIDARG;
        }
        obj.setViewportData({ x, y, width: w, height: h, minZ, maxZ });
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_SetViewport: x=${x} y=${y} w=${w} h=${h}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpViewport = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!lpViewport || !isValidAddress(mem, lpViewport, D3DVIEWPORT7_SIZE)) return D3DERR_INVALIDCALL;
        const vp = obj.getViewportData();
        // Unset means the device still carries the viewport it was created with — the full
        // render target, not a 640x480 guess.
        const rtAddr = obj.getRenderTarget() || context.surfaces.backBuffer || context.surfaces.primary;
        const rtState = rtAddr
            ? (resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null)?.getState()
            : null;
        const x = vp?.x ?? 0, y = vp?.y ?? 0;
        const w = vp?.width ?? rtState?.width ?? 0, h = vp?.height ?? rtState?.height ?? 0;
        const minZ = vp?.minZ ?? 0, maxZ = vp?.maxZ ?? 1;
        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(lpViewport + D3DVIEWPORT7_OFFSETS.x, x, true);
        view.setUint32(lpViewport + D3DVIEWPORT7_OFFSETS.y, y, true);
        view.setUint32(lpViewport + D3DVIEWPORT7_OFFSETS.width, w, true);
        view.setUint32(lpViewport + D3DVIEWPORT7_OFFSETS.height, h, true);
        view.setFloat32(lpViewport + D3DVIEWPORT7_OFFSETS.minZ, minZ, true);
        view.setFloat32(lpViewport + D3DVIEWPORT7_OFFSETS.maxZ, maxZ, true);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_SetRenderTarget"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpNewRT = args[1];
        // const dwFlags = args[2]; // usually 0, can ignore for now

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;

        setDeviceRenderTarget(context, obj, lpNewRT);

        if (context.executor && lpNewRT) {
            const rtObj = resourceProvider.getComObjectByAddress(lpNewRT) as DirectDrawSurfaceObject | null;
            const state = rtObj?.getState();
            if (state && surfaceSyncManager.needsGPUSync(state).needed) {
                Logger.log(LogCategory.DDRAW, `Device7_SetRenderTarget: Sync RT 0x${lpNewRT.toString(16)} from CPU`);
                context.executor.syncSurfaceFromMemory(state);
            }
        }

        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetRenderTarget"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lplpRT = args[1];
        if (!lplpRT || !isValidAddress(mem, lplpRT, 4)) return D3DERR_INVALIDCALL;
        initReturnPtr(lplpRT);

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        const rt = obj ? obj.getRenderTarget() : 0;
        // GetRenderTarget increments the surface's reference count.
        if (rt) resourceProvider.getComObjectByAddress(rt)?.addRef();

        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(lplpRT, rt, true);
        return D3D_OK;
    };

    type ParentD3Iface = "IDirect3D7" | "IDirect3D3" | "IDirect3D2" | "IDirect3D";
    const PARENT_D3_IID: Record<ParentD3Iface, string> = {
        IDirect3D7: IID_IDirect3D7,
        IDirect3D3: IID_IDirect3D3,
        IDirect3D2: IID_IDirect3D2,
        IDirect3D: IID_IDirect3D,
    };

    /** Per device, the parent object handed out for each IDirect3D generation. IDirect3D v1
     *  and IDirect3D3 are not an inheritance chain (v1 slot 7 is CreateViewport, v3 slot 7 is
     *  FindDevice), so a device asked for both must return two different objects. */
    const parentD3ByDevice = new WeakMap<object, Map<ParentD3Iface, number>>();

    const writeGetDirect3D = (
        deviceObj: Direct3DDevice7Object | Direct3DDevice3Object | null,
        lplpDirect3D: number,
        iface: ParentD3Iface,
        mem: Uint8Array,
    ): number => {
        if (!lplpDirect3D || !isValidAddress(mem, lplpDirect3D, 4)) return D3DERR_INVALIDCALL;
        initReturnPtr(lplpDirect3D);

        // Devices created from an IDirect3D tear-off keep the owning DirectDraw COM
        // object as their parent. Resolve the requested D3D generation from that live
        // owner instead of manufacturing a second object. Besides preserving COM
        // identity, the owner holds the tear-off alive after the caller releases it.
        //
        // The old standalone cache stored only a guest address. Once the caller
        // released that object, the allocator could reuse the address for an unrelated
        // COM object; a later GetDirect3D then returned (and AddRef'd) that object.
        const owningParentPtr = deviceObj?.getParentD3() ?? 0;
        const owningParent = owningParentPtr
            ? resourceProvider.getComObjectByAddress(owningParentPtr)
            : null;
        if (owningParent) {
            const tearOffResult = resolveDDrawTearOff(
                context,
                owningParent,
                PARENT_D3_IID[iface].toLowerCase(),
                lplpDirect3D,
                mem,
            );
            if (tearOffResult !== null) return tearOffResult;

            const expectedVtable = context.vtables[iface]?.address;
            if (expectedVtable && owningParent.vtableAddress === expectedVtable) {
                owningParent.addRef(owningParentPtr);
                getDataView(mem).setUint32(lplpDirect3D, owningParentPtr, true);
                return D3D_OK;
            }
        }

        let cache: Map<ParentD3Iface, number> | undefined;
        if (deviceObj) {
            cache = parentD3ByDevice.get(deviceObj);
            if (!cache) {
                cache = new Map();
                parentD3ByDevice.set(deviceObj, cache);
            }
        }

        let parentPtr = cache?.get(iface) ?? 0;
        if (parentPtr) {
            const parentObj = resourceProvider.getComObjectByAddress(parentPtr);
            const expectedVtable = context.vtables[iface]?.address;
            if (parentObj && parentObj.vtableAddress === expectedVtable) {
                parentObj.addRef(parentPtr);
            } else {
                // Never trust an address-only cache entry after its COM object died:
                // guest COM allocations are reusable.
                cache?.delete(iface);
                parentPtr = 0;
            }
        }
        if (!parentPtr) {
            const vtableAddr = context.vtables[iface]?.address;
            if (!vtableAddr) return D3DERR_INVALIDCALL;
            const parentObj = ComObjectFactory.create(PARENT_D3_IID[iface], vtableAddr);
            if (!parentObj) return D3DERR_INVALIDCALL;
            parentPtr = allocateComObject(context.process.memory, mem, vtableAddr);
            resourceProvider.mapAddressToHandle(parentPtr, parentObj.handle);
            cache?.set(iface, parentPtr);
            // The device keeps a reference to whichever generation it produced first.
            if (deviceObj && !deviceObj.getParentD3()) deviceObj.setParentD3(parentPtr);
        }

        getDataView(mem).setUint32(lplpDirect3D, parentPtr, true);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetDirect3D"] = (_ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]) as Direct3DDevice7Object | null;
        return writeGetDirect3D(obj, args[1], "IDirect3D7", mem);
    };

    // =========================================================================
    // LIGHTING METHODS
    // =========================================================================

    // Helper: Read D3DCOLORVALUE from memory
    const readColorValue = (view: DataView, addr: number): D3DColorValue => ({
        r: view.getFloat32(addr + D3DCOLORVALUE_OFFSETS.r, true),
        g: view.getFloat32(addr + D3DCOLORVALUE_OFFSETS.g, true),
        b: view.getFloat32(addr + D3DCOLORVALUE_OFFSETS.b, true),
        a: view.getFloat32(addr + D3DCOLORVALUE_OFFSETS.a, true),
    });

    // Helper: Write D3DCOLORVALUE to memory
    const writeColorValue = (view: DataView, addr: number, color: D3DColorValue): void => {
        view.setFloat32(addr + D3DCOLORVALUE_OFFSETS.r, color.r, true);
        view.setFloat32(addr + D3DCOLORVALUE_OFFSETS.g, color.g, true);
        view.setFloat32(addr + D3DCOLORVALUE_OFFSETS.b, color.b, true);
        view.setFloat32(addr + D3DCOLORVALUE_OFFSETS.a, color.a, true);
    };

    // Helper: Read D3DVECTOR from memory
    const readVector = (view: DataView, addr: number): D3DVector => ({
        x: view.getFloat32(addr + D3DVECTOR_OFFSETS.x, true),
        y: view.getFloat32(addr + D3DVECTOR_OFFSETS.y, true),
        z: view.getFloat32(addr + D3DVECTOR_OFFSETS.z, true),
    });

    // Helper: Write D3DVECTOR to memory
    const writeVector = (view: DataView, addr: number, vec: D3DVector): void => {
        view.setFloat32(addr + D3DVECTOR_OFFSETS.x, vec.x, true);
        view.setFloat32(addr + D3DVECTOR_OFFSETS.y, vec.y, true);
        view.setFloat32(addr + D3DVECTOR_OFFSETS.z, vec.z, true);
    };

    exports["IDirect3DDevice7_SetMaterial"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpMaterial = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!lpMaterial || !isValidAddress(mem, lpMaterial, D3DMATERIAL7_SIZE)) return D3DERR_INVALIDCALL;

        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        const mat: D3DMaterial7Data = {
            diffuse: readColorValue(view, lpMaterial + D3DMATERIAL7_OFFSETS.diffuse),
            ambient: readColorValue(view, lpMaterial + D3DMATERIAL7_OFFSETS.ambient),
            specular: readColorValue(view, lpMaterial + D3DMATERIAL7_OFFSETS.specular),
            emissive: readColorValue(view, lpMaterial + D3DMATERIAL7_OFFSETS.emissive),
            power: view.getFloat32(lpMaterial + D3DMATERIAL7_OFFSETS.power, true),
        };
        obj.setMaterial(mat);
        // Log on the first 30 calls, then on any call whose diffuse/ambient/emissive
        // alpha (or diffuse RGB) *transitions* away from the previous snapshot.
        // Captures intermediate fade-ramp values a naive "first-N" sampler misses.
        {
            const g = globalThis as any;
            const n = (g._matDiagN ?? 0) + 1;
            g._matDiagN = n;
            const key =
                `${mat.diffuse.r.toFixed(2)},${mat.diffuse.g.toFixed(2)},${mat.diffuse.b.toFixed(2)},${mat.diffuse.a.toFixed(2)}|` +
                `${mat.ambient.a.toFixed(2)}|${mat.emissive.a.toFixed(2)}`;
            const last = g._matDiagLastKey;
            const shouldLog = n <= 30 || (n % 300 === 0) || last !== key;
            g._matDiagLastKey = key;
            if (shouldLog) {
                const fmt = (c: {r:number;g:number;b:number;a:number}) =>
                    `(${c.r.toFixed(2)},${c.g.toFixed(2)},${c.b.toFixed(2)},${c.a.toFixed(2)})`;
                Logger.log(LogCategory.DDRAW,
                    `[MAT-DIAG #${n}] SetMaterial: ` +
                    `diffuse=${fmt(mat.diffuse)} ambient=${fmt(mat.ambient)} ` +
                    `specular=${fmt(mat.specular)} emissive=${fmt(mat.emissive)} power=${mat.power.toFixed(2)}`);
            }
        }
        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetMaterial"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpMaterial = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!lpMaterial || !isValidAddress(mem, lpMaterial, D3DMATERIAL7_SIZE)) return D3DERR_INVALIDCALL;

        const mat = obj.getMaterial();
        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        writeColorValue(view, lpMaterial + D3DMATERIAL7_OFFSETS.diffuse, mat.diffuse);
        writeColorValue(view, lpMaterial + D3DMATERIAL7_OFFSETS.ambient, mat.ambient);
        writeColorValue(view, lpMaterial + D3DMATERIAL7_OFFSETS.specular, mat.specular);
        writeColorValue(view, lpMaterial + D3DMATERIAL7_OFFSETS.emissive, mat.emissive);
        view.setFloat32(lpMaterial + D3DMATERIAL7_OFFSETS.power, mat.power, true);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_SetLight"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const index = args[1];
        const lpLight = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (index < 0 || index >= D3D_MAX_LIGHTS) return D3DERR_INVALIDCALL;
        if (!lpLight || !isValidAddress(mem, lpLight, D3DLIGHT7_SIZE)) return D3DERR_INVALIDCALL;

        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        const light: D3DLight7Data = {
            type: view.getUint32(lpLight + D3DLIGHT7_OFFSETS.type, true),
            diffuse: readColorValue(view, lpLight + D3DLIGHT7_OFFSETS.diffuse),
            specular: readColorValue(view, lpLight + D3DLIGHT7_OFFSETS.specular),
            ambient: readColorValue(view, lpLight + D3DLIGHT7_OFFSETS.ambient),
            position: readVector(view, lpLight + D3DLIGHT7_OFFSETS.position),
            direction: readVector(view, lpLight + D3DLIGHT7_OFFSETS.direction),
            range: view.getFloat32(lpLight + D3DLIGHT7_OFFSETS.range, true),
            falloff: view.getFloat32(lpLight + D3DLIGHT7_OFFSETS.falloff, true),
            attenuation0: view.getFloat32(lpLight + D3DLIGHT7_OFFSETS.attenuation0, true),
            attenuation1: view.getFloat32(lpLight + D3DLIGHT7_OFFSETS.attenuation1, true),
            attenuation2: view.getFloat32(lpLight + D3DLIGHT7_OFFSETS.attenuation2, true),
            theta: view.getFloat32(lpLight + D3DLIGHT7_OFFSETS.theta, true),
            phi: view.getFloat32(lpLight + D3DLIGHT7_OFFSETS.phi, true),
        };
        obj.setLight(index, light);
        const typeNames = ["?", "POINT", "SPOT", "DIRECTIONAL"];
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_SetLight: index=${index} type=${typeNames[light.type] || light.type} dir=(${light.direction.x.toFixed(2)},${light.direction.y.toFixed(2)},${light.direction.z.toFixed(2)})`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetLight"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const index = args[1];
        const lpLight = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (index < 0 || index >= D3D_MAX_LIGHTS) return D3DERR_INVALIDCALL;
        if (!lpLight || !isValidAddress(mem, lpLight, D3DLIGHT7_SIZE)) return D3DERR_INVALIDCALL;

        const light = obj.getLight(index);
        if (!light) {
            // Light not set - return default or error
            return D3DERR_INVALIDCALL;
        }

        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(lpLight + D3DLIGHT7_OFFSETS.type, light.type, true);
        writeColorValue(view, lpLight + D3DLIGHT7_OFFSETS.diffuse, light.diffuse);
        writeColorValue(view, lpLight + D3DLIGHT7_OFFSETS.specular, light.specular);
        writeColorValue(view, lpLight + D3DLIGHT7_OFFSETS.ambient, light.ambient);
        writeVector(view, lpLight + D3DLIGHT7_OFFSETS.position, light.position);
        writeVector(view, lpLight + D3DLIGHT7_OFFSETS.direction, light.direction);
        view.setFloat32(lpLight + D3DLIGHT7_OFFSETS.range, light.range, true);
        view.setFloat32(lpLight + D3DLIGHT7_OFFSETS.falloff, light.falloff, true);
        view.setFloat32(lpLight + D3DLIGHT7_OFFSETS.attenuation0, light.attenuation0, true);
        view.setFloat32(lpLight + D3DLIGHT7_OFFSETS.attenuation1, light.attenuation1, true);
        view.setFloat32(lpLight + D3DLIGHT7_OFFSETS.attenuation2, light.attenuation2, true);
        view.setFloat32(lpLight + D3DLIGHT7_OFFSETS.theta, light.theta, true);
        view.setFloat32(lpLight + D3DLIGHT7_OFFSETS.phi, light.phi, true);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_LightEnable"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const index = args[1];
        const enable = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (index < 0 || index >= D3D_MAX_LIGHTS) return D3DERR_INVALIDCALL;

        obj.setLightEnabled(index, enable !== 0);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_LightEnable: index=${index} enable=${enable !== 0}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetLightEnable"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const index = args[1];
        const pEnable = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (index < 0 || index >= D3D_MAX_LIGHTS) return D3DERR_INVALIDCALL;
        if (!pEnable || !isValidAddress(mem, pEnable, 4)) return D3DERR_INVALIDCALL;

        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(pEnable, obj.isLightEnabled(index) ? 1 : 0, true);
        return D3D_OK;
    };

    // =========================================================================
    // STATE BLOCK METHODS
    // =========================================================================

    exports["IDirect3DDevice7_BeginStateBlock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        obj.beginStateBlock();
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_BeginStateBlock`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_EndStateBlock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const pHandle = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!pHandle || !isValidAddress(mem, pHandle, 4)) return D3DERR_INVALIDCALL;

        const handle = obj.endStateBlock();
        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(pHandle, handle, true);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_EndStateBlock: handle=${handle}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_CreateStateBlock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const type = args[1];
        const pHandle = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!pHandle || !isValidAddress(mem, pHandle, 4)) return D3DERR_INVALIDCALL;

        const handle = obj.createStateBlock(type);
        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(pHandle, handle, true);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_CreateStateBlock: type=${type} handle=${handle}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_CaptureStateBlock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const handle = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;

        const success = obj.captureStateBlock(handle);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_CaptureStateBlock: handle=${handle} success=${success}`);
        return success ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports["IDirect3DDevice7_ApplyStateBlock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const handle = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;

        const success = obj.applyStateBlock(handle);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_ApplyStateBlock: handle=${handle} success=${success}`);
        return success ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports["IDirect3DDevice7_DeleteStateBlock"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const handle = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;

        const success = obj.deleteStateBlock(handle);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_DeleteStateBlock: handle=${handle} success=${success}`);
        return success ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // =========================================================================
    // GETTER METHODS
    // =========================================================================

    exports["IDirect3DDevice7_GetRenderState"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const state = args[1];
        const pValue = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!pValue || !isValidAddress(mem, pValue, 4)) return D3DERR_INVALIDCALL;

        const value = obj.getRenderState(state);
        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(pValue, value >>> 0, true);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_GetRenderState: state=${state} value=0x${(value >>> 0).toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetTexture"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const stage = args[1];
        const ppTexture = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!ppTexture || !isValidAddress(mem, ppTexture, 4)) return D3DERR_INVALIDCALL;
        initReturnPtr(ppTexture);

        const textureAddr = obj.getTexture(stage);
        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(ppTexture, textureAddr, true);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_GetTexture: stage=${stage} texture=0x${textureAddr.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetTextureStageState"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const stage = args[1];
        const type = args[2];
        const pValue = args[3];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!pValue || !isValidAddress(mem, pValue, 4)) return D3DERR_INVALIDCALL;

        const value = obj.getTextureStageState(stage, type);
        const view = getDataView(mem); // OPTIMIZED: Use cached DataView
        view.setUint32(pValue, value >>> 0, true);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice7_GetTextureStageState: stage=${stage} type=${type} value=0x${(value >>> 0).toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_EndScene"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        Logger.log(LogCategory.SYSTEM, `IDirect3DDevice7_EndScene: this=0x${thisPtr.toString(16)} - ending frame and resetting ring buffers`);
        // Do NOT setAuthorityGpu here. Real GPU writes already mark the RT
        // (immediate draw / Clear / flushBatch when actualDrawCalls > 0). An
        // unconditional bump on empty Begin/EndScene forces Lock into a full
        // GPU→CPU readback of unchanged pixels and double-bumps scenes that drew.
        // endFrame() flushes pending batches so authority is set before the guest
        // can Lock after this call returns.
        if (context.executor) {
            context.executor.endFrame();
        }
        return D3D_OK;
    };

    exports["IDirect3DDevice7_SetTexture"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const stage = args[1];
        const texture = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;

        if (!obj && thisPtr && thisPtr >= 0x1000 && thisPtr + 4 <= mem.length) {
            const view = getDataView(mem); // OPTIMIZED: Use cached DataView
            const vtableAddr = view.getUint32(thisPtr, true);
            if (Logger.isEnabled(LogCategory.COM, LogLevel.NORMAL)) {
                Logger.log(LogCategory.COM, `IDirect3DDevice7_SetTexture: Object not found for thisPtr=0x${thisPtr.toString(16)}, checking vtable=0x${vtableAddr.toString(16)} isOur=${isOurVTable(vtableAddr)}`);
            }

            if (isOurVTable(vtableAddr) && vtableAddr === context.vtables.IDirect3DDevice7?.address && Logger.isEnabled(LogCategory.COM, LogLevel.WARN)) {
                Logger.warn(LogCategory.COM, `IDirect3DDevice7_SetTexture: Device7 object at 0x${thisPtr.toString(16)} has our vtable but is not registered!`);
            }
        }

        if (obj) {
            textureManager.setDeviceTexture(obj, stage, texture);
        }

        const actualTexture = obj ? obj.getTexture(stage) : 0;
        const resolved = textureManager.resolve(actualTexture);
        
        if (Logger.isEnabled(LogCategory.DDRAW, LogLevel.NORMAL)) {
            let stageStateLog = "";
            if (obj && stage === 0) {
                try {
                    const textureStates = obj.getTextureStageStates();
                    if (textureStates) {
                        const colorOp = textureStates[0 * 32 + D3DTSS_COLOROP] || 0;
                        const colorArg1 = textureStates[0 * 32 + D3DTSS_COLORARG1] ?? 2;
                        const colorArg2 = textureStates[0 * 32 + D3DTSS_COLORARG2] ?? 0;
                        const alphaOp = textureStates[0 * 32 + D3DTSS_ALPHAOP] || 0;
                        stageStateLog = ` stage0: COLOROP=${colorOp} COLORARG1=${colorArg1} COLORARG2=${colorArg2} ALPHAOP=${alphaOp}`;
                    } else {
                        stageStateLog = ` stage0: textureStates=null`;
                    }
                } catch (e) {
                    stageStateLog = ` stage0: error=${e}`;
                }
            } else if (!obj) {
                stageStateLog = ` stage=${stage}: obj=null`;
            } else {
                stageStateLog = ` stage=${stage}: (not stage0)`;
            }
            const logMsg = `IDirect3DDevice7_SetTexture: thisPtr=0x${thisPtr.toString(16)} stage=${stage} texture=0x${texture.toString(16)} -> actual=0x${actualTexture.toString(16)} surfaceAddr=0x${resolved.addr.toString(16)}${stageStateLog}`;
            Logger.log(LogCategory.DDRAW, logMsg);
            Logger.verbose(LogCategory.SYSTEM, logMsg);
        }

        // Texture sync deferred to prepareDraw (which already checks needsGPUSync).
        // Removing eager sync here avoids duplicate work when texture hasn't changed between SetTexture and Draw.
        
        return D3D_OK;
    };

    exports["IDirect3DDevice7_SetRenderState"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const state = args[1];
        const value = args[2];
        let obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;

        if (!obj && thisPtr && thisPtr >= 0x1000 && thisPtr + 4 <= mem.length) {
            const view = getDataView(mem); // OPTIMIZED: Use cached DataView
            const vtableAddr = view.getUint32(thisPtr, true);
            Logger.log(LogCategory.COM, `IDirect3DDevice7_SetRenderState: Object not found for thisPtr=0x${thisPtr.toString(16)}, checking vtable=0x${vtableAddr.toString(16)} isOur=${isOurVTable(vtableAddr)}`);

            if (isOurVTable(vtableAddr) && vtableAddr === context.vtables.IDirect3DDevice7?.address) {
                Logger.warn(LogCategory.COM, `IDirect3DDevice7_SetRenderState: Device7 object at 0x${thisPtr.toString(16)} has our vtable but is not registered!`);
            }
        }

        if (obj) {
            obj.setRenderState(state, value);
        }
        // Log important state changes at info level for debugging
        if (state === 22 && value === 1) {
            // D3DRENDERSTATE_CULLMODE = 22, D3DCULL_NONE = 1
            Logger.log(LogCategory.DDRAW, `SetRenderState: CULLMODE = D3DCULL_NONE (culling disabled)`);
        }
        if (state === 41) {
            Logger.log(LogCategory.DDRAW, `IDirect3DDevice7_SetRenderState: COLORKEYENABLE = ${value}`);
        }
        // OPTIMIZED: Use lazy logging to avoid string formatting overhead
        Logger.verboseLazy(LogCategory.DDRAW, () =>
            `IDirect3DDevice7_SetRenderState: state=${state} value=0x${value.toString(16)}`
        );

        // TEXTUREMAPBLEND (21) translation now handled inside obj.setRenderState()

        return D3D_OK;
    };

    exports["IDirect3DDevice7_SetTextureStageState"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const stage = args[1];
        const type = args[2];
        const value = args[3];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (obj) {
            obj.setTextureStageState(stage, type, value);
        }

        Logger.log(LogCategory.DDRAW,
            `IDirect3DDevice7_SetTextureStageState: stage=${stage} type=${type} value=0x${value.toString(16)}`);
        return D3D_OK;
    };

    // Helper functions for matrix operations (defined before use)
    // OPTIMIZED: Uses cached DataView and matrix pool
    const readMat4 = (mem: Uint8Array, addr: number): Float32Array => {
        const m = acquireMatrix(); // Use pooled matrix instead of new allocation
        const view = getDataView(mem); // Use cached DataView
        for (let i = 0; i < 16; i++) {
            m[i] = view.getFloat32(addr + i * 4, true);
        }
        return m;
    };

    const writeMat4 = (mem: Uint8Array, addr: number, m: Float32Array): void => {
        const view = getDataView(mem); // Use cached DataView
        for (let i = 0; i < 16; i++) {
            view.setFloat32(addr + i * 4, m[i], true);
        }
    };

    const identityMat4 = (): Float32Array => {
        return new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);
    };

    // D3D7: WORLD=256..259, VIEW=2, PROJ=3
    // D3D3: WORLD=1, VIEW=2, PROJ=3
    // Normalize: accept old WORLD=1 as WORLD=256 for compatibility
    const normalizeTransformStateForD3D7 = (state: number): number => {
        if (state === 1) return 256; // Accept old WORLD=1 as WORLD=256
        return state;
    };

    // Matrix multiplication for row-major D3D convention: result = a * b
    // (v' = v * a * b, so result = a * b). Math.fround mimics 32-bit float to avoid double accumulation.
    const multiplyMatrices = (a: Float32Array, b: Float32Array): Float32Array => {
        const result = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            const ai0 = a[i * 4 + 0];
            const ai1 = a[i * 4 + 1];
            const ai2 = a[i * 4 + 2];
            const ai3 = a[i * 4 + 3];
            result[i * 4 + 0] = Math.fround(ai0 * b[0]  + ai1 * b[4]  + ai2 * b[8]  + ai3 * b[12]);
            result[i * 4 + 1] = Math.fround(ai0 * b[1]  + ai1 * b[5]  + ai2 * b[9]  + ai3 * b[13]);
            result[i * 4 + 2] = Math.fround(ai0 * b[2]  + ai1 * b[6]  + ai2 * b[10] + ai3 * b[14]);
            result[i * 4 + 3] = Math.fround(ai0 * b[3]  + ai1 * b[7]  + ai2 * b[11] + ai3 * b[15]);
        }
        return result;
    };

    // DIAGNOSTIC: Track SetTransform call count to detect missing init calls
    let setTransformCallCount = 0;

    exports["IDirect3DDevice7_SetTransform"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const state = args[1];
        const pMatrix = args[2];
        setTransformCallCount++;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;

        if (!obj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice7_SetTransform: invalid device ${thisPtr} (call #${setTransformCallCount})`);
            return D3D_OK;
        }

        // Validate address
        if (!pMatrix || !isValidAddress(mem, pMatrix, 64)) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice7_SetTransform: bad pMatrix=0x${pMatrix.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        // Read 4x4 matrix from memory (16 floats = 64 bytes)
        const matrix = readMat4(mem, pMatrix);

        // Normalize state before storing
        // D3D3 uses state=1 for WORLD, D3D7 uses state=256
        // Many games use old D3D3 constants with D3D7 interfaces
        const normalizedState = normalizeTransformStateForD3D7(state);

        obj.setTransform(normalizedState, matrix);

        // DIAGNOSTIC: Log matrix type and full matrix for VIEW and PROJECTION
        // Also log first 10 calls unconditionally to catch init-time calls
        const matrixType = normalizedState >= 256 && normalizedState <= 259 ? "WORLD" : normalizedState === 2 ? "VIEW" : normalizedState === 3 ? "PROJECTION" : `UNKNOWN(${normalizedState})`;
        const isViewOrProj = normalizedState === 2 || normalizedState === 3;
        const isInitPhase = setTransformCallCount <= 10;

        if (isViewOrProj || isInitPhase) {
            Logger.log(
                LogCategory.DDRAW,
                `IDirect3DDevice7_SetTransform: call#${setTransformCallCount} state=${state}->${normalizedState} type=${matrixType} FULL MATRIX:\n` +
                `  [${matrix[0].toFixed(3)}, ${matrix[1].toFixed(3)}, ${matrix[2].toFixed(3)}, ${matrix[3].toFixed(3)}]\n` +
                `  [${matrix[4].toFixed(3)}, ${matrix[5].toFixed(3)}, ${matrix[6].toFixed(3)}, ${matrix[7].toFixed(3)}]\n` +
                `  [${matrix[8].toFixed(3)}, ${matrix[9].toFixed(3)}, ${matrix[10].toFixed(3)}, ${matrix[11].toFixed(3)}]\n` +
                `  [${matrix[12].toFixed(3)}, ${matrix[13].toFixed(3)}, ${matrix[14].toFixed(3)}, ${matrix[15].toFixed(3)}]`
            );
        } else {
            Logger.log(
                LogCategory.DDRAW,
                `IDirect3DDevice7_SetTransform: state=${state}->${normalizedState} type=${matrixType} ` +
                `matrix[0-3]=[${matrix[0].toFixed(3)}, ${matrix[1].toFixed(3)}, ${matrix[2].toFixed(3)}, ${matrix[3].toFixed(3)}]`
            );
        }
        return D3D_OK;
    };

    exports["IDirect3DDevice7_GetTransform"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        let state = args[1];
        const pMatrix = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;

        if (!obj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice7_GetTransform: invalid device ${thisPtr}`);
            return D3DERR_INVALIDCALL;
        }

        if (!pMatrix || !isValidAddress(mem, pMatrix, 64)) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice7_GetTransform: bad pMatrix=0x${pMatrix.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        state = normalizeTransformStateForD3D7(state);

        // Get current matrix from object
        let m: Float32Array | null = null;
        if (state >= 256 && state <= 259) {
            // D3DTS_WORLD (256) or WORLD0..WORLD3 (256..259)
            // For now, we only support WORLD0 (256), treat others as WORLD0
            m = obj.getWorldMatrix();
        } else if (state === 2) {
            // D3DTS_VIEW
            m = obj.getViewMatrix();
        } else if (state === 3) {
            // D3DTS_PROJECTION
            m = obj.getProjMatrix();
        }

        if (!m) {
            m = identityMat4();
        }

        writeMat4(mem, pMatrix, m);

        Logger.verbose(LogCategory.DDRAW, `IDirect3DDevice7_GetTransform: state=0x${state.toString(16)} p=0x${pMatrix.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_MultiplyTransform"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        let state = args[1];
        const pMatrix = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;

        if (!obj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice7_MultiplyTransform: invalid device ${thisPtr}`);
            return D3DERR_INVALIDCALL;
        }

        if (!pMatrix || !isValidAddress(mem, pMatrix, 64)) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice7_MultiplyTransform: bad pMatrix=0x${pMatrix.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        state = normalizeTransformStateForD3D7(state);

        // Read multiplier matrix from memory
        const mul = readMat4(mem, pMatrix);

        // Get current matrix (defaults to identity)
        let cur: Float32Array | null = null;
        if (state >= 256 && state <= 259) {
            // D3DTS_WORLD (256) or WORLD0..WORLD3 (256..259)
            cur = obj.getWorldMatrix();
        } else if (state === 2) {
            // D3DTS_VIEW
            cur = obj.getViewMatrix();
        } else if (state === 3) {
            // D3DTS_PROJECTION
            cur = obj.getProjMatrix();
        }

        if (!cur) {
            cur = identityMat4();
        }

        // D3D row-vector convention (v' = v·M): the ARGUMENT is applied to the vertex
        // first, then the matrix already in the state — M = mul · cur, not cur · mul.
        // (Mirrors wined3d_stateblock_multiply_transform, and is what a GL wrapper's
        // glMultMatrix maps to once transposed into D3D's row-vector form.)
        const res = multiplyMatrices(mul, cur);

        obj.setTransform(state, res);

        Logger.verbose(LogCategory.DDRAW, `IDirect3DDevice7_MultiplyTransform: state=0x${state.toString(16)} p=0x${pMatrix.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_BeginScene"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        Logger.log(LogCategory.SYSTEM, `IDirect3DDevice7_BeginScene: this=0x${thisPtr.toString(16)}`);

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice7Object | null;
        if (obj && context.executor) {
            const rtAddr = obj.getRenderTarget() || context.surfaces.backBuffer || context.surfaces.primary;
            if (rtAddr) {
                const rtObj = resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null;
                const state = rtObj?.getState();
                if (state) {
                    // StretchDIBits on a leaked GetDC HDC must land on the GPU RT before D3D draws.
                    syncActiveGdiContextBeforeD3D(state, rtAddr, mem, context.executor);
                }
                if (state && surfaceSyncManager.needsGPUSync(state).needed) {
                    const modeStr = isRenderSurface(state) ? state.mode : "bitmap_texture";
                    Logger.log(LogCategory.DDRAW, `IDirect3DDevice7_BeginScene: Syncing RT 0x${rtAddr.toString(16)} from CPU (modeStr=${modeStr})`);
                    context.executor.syncSurfaceFromMemory(state);
                }
                if (state) {

                    // Auto-set viewport if not set or invalid (0x0)
                    // Many games don't call SetViewport, causing "nothing renders" bugs
                    const vp = obj.getViewportData();
                    if (!vp || vp.width === 0 || vp.height === 0) {
                        const autoViewport = {
                            x: 0,
                            y: 0,
                            width: state.width,
                            height: state.height,
                            minZ: 0,
                            maxZ: 1,
                        };
                        obj.setViewportData(autoViewport);
                        Logger.log(LogCategory.DDRAW,
                            `IDirect3DDevice7_BeginScene: Auto-set viewport to RT size: ` +
                            `x=${autoViewport.x} y=${autoViewport.y} w=${autoViewport.width} h=${autoViewport.height} ` +
                            `(RT was ${state.width}x${state.height})`
                        );
                    } else {
                        Logger.log(LogCategory.DDRAW,
                            `IDirect3DDevice7_BeginScene: Viewport already set: ` +
                            `x=${vp.x} y=${vp.y} w=${vp.width} h=${vp.height} minZ=${vp.minZ} maxZ=${vp.maxZ}`
                        );
                    }
                }
            }
        }
        return D3D_OK;
    };

    exports["IDirect3DDevice7_DrawPrimitive"] = (ctx, mem, args) => {
        const threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;
        Logger.verbose(LogCategory.DDRAW, `[TID=${threadId}] IDirect3DDevice7_DrawPrimitive: type=${args[1]} vtype=0x${args[2].toString(16)} count=${args[4]}`);
        drawHandler.handleDrawPrimitive(args[0], args[1], args[2], args[3], args[4], mem);
        return D3D_OK;
    };

    exports["IDirect3DDevice7_DrawIndexedPrimitive"] = (ctx, mem, args) => {
        const threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;
        Logger.verbose(LogCategory.DDRAW, `[TID=${threadId}] IDirect3DDevice7_DrawIndexedPrimitive: type=${args[1]} vtype=0x${args[2].toString(16)} vCount=${args[4]} iCount=${args[6]}`);
        drawHandler.handleDrawPrimitive(args[0], args[1], args[2], args[3], args[4], mem, true, args[5], args[6]);
        return D3D_OK;
    };

    // IDirect3DDevice7::DrawPrimitiveVB(this, primType, lpVB, startVertex, numVertices, flags)
    exports["IDirect3DDevice7_DrawPrimitiveVB"] = (ctx, mem, args) => {
        const primType = args[1];
        const lpVB = args[2];
        const startVertex = args[3];
        const numVertices = args[4];
        const obj = resourceProvider.getComObjectByAddress(lpVB) as Direct3DVertexBufferObject | null;
        if (!obj) {
            Logger.error(LogCategory.DDRAW, `IDirect3DDevice7_DrawPrimitiveVB: VB not found at 0x${lpVB.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }
        const dataAddr = obj.getDataPtr() + startVertex * obj.getVertexSize();
        drawHandler.handleDrawPrimitive(args[0], primType, obj.getFVF(), dataAddr, numVertices, mem);
        return D3D_OK;
    };

    // IDirect3DDevice7::DrawIndexedPrimitiveVB(this, primType, lpVB, startVertex, numVertices, lpIndices, indexCount, flags)
    exports["IDirect3DDevice7_DrawIndexedPrimitiveVB"] = (ctx, mem, args) => {
        const primType = args[1];
        const lpVB = args[2];
        const startVertex = args[3];
        const numVertices = args[4];
        const lpIndices = args[5];
        const indexCount = args[6];
        const obj = resourceProvider.getComObjectByAddress(lpVB) as Direct3DVertexBufferObject | null;
        if (!obj) {
            Logger.error(LogCategory.DDRAW, `IDirect3DDevice7_DrawIndexedPrimitiveVB: VB not found at 0x${lpVB.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }
        const dataAddr = obj.getDataPtr() + startVertex * obj.getVertexSize();
        drawHandler.handleDrawPrimitive(args[0], primType, obj.getFVF(), dataAddr, numVertices, mem, true, lpIndices, indexCount);
        return D3D_OK;
    };

    // IDirect3DDevice7::Load(this, lpDestTex, lpDestPoint, lpSrcTex, lprcSrcRect, dwFlags)
    // Copies pixel data from one DirectDrawSurface7 to another (used for lightmaps in UT).
    exports["IDirect3DDevice7_Load"] = (ctx, mem, args) => {
        const lpDestTex = args[1];
        const lpDestPoint = args[2];
        const lpSrcTex = args[3];
        const lprcSrcRect = args[4];

        const srcObj = resourceProvider.getComObjectByAddress(lpSrcTex) as DirectDrawSurfaceObject | null;
        const dstObj = resourceProvider.getComObjectByAddress(lpDestTex) as DirectDrawSurfaceObject | null;

        if (!srcObj || !dstObj) {
            Logger.warn(LogCategory.DDRAW,
                `IDirect3DDevice7_Load: surface not found src=0x${lpSrcTex.toString(16)}(${!!srcObj}) dst=0x${lpDestTex.toString(16)}(${!!dstObj})`);
            return D3DERR_INVALIDCALL;
        }

        const srcState = srcObj.getState();
        const dstState = dstObj.getState();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Parse optional destPoint and srcRect
        let srcX = 0, srcY = 0, srcW = srcState.width, srcH = srcState.height;
        let dstX = 0, dstY = 0;

        if (lprcSrcRect) {
            srcX = view.getInt32(lprcSrcRect, true);      // left
            srcY = view.getInt32(lprcSrcRect + 4, true);   // top
            srcW = view.getInt32(lprcSrcRect + 8, true) - srcX; // right - left
            srcH = view.getInt32(lprcSrcRect + 12, true) - srcY; // bottom - top
        }
        if (lpDestPoint) {
            dstX = view.getInt32(lpDestPoint, true);
            dstY = view.getInt32(lpDestPoint + 4, true);
        }

        // Clamp copy region to both surfaces
        const copyW = Math.min(srcW, dstState.width - dstX, srcState.width - srcX);
        const copyH = Math.min(srcH, dstState.height - dstY, srcState.height - srcY);
        if (copyW <= 0 || copyH <= 0) return D3DERR_INVALIDCALL;

        const bpp = srcState.format.bpp;
        const bytesPerPixel = bpp >> 3;
        const srcPitch = srcState.pitch || srcState.width * bytesPerPixel;
        const dstPitch = dstState.pitch || dstState.width * bytesPerPixel;
        const srcBase = srcState.surfacePtr;
        const dstBase = dstState.surfacePtr;

        if (!srcBase || !dstBase) {
            Logger.warn(LogCategory.DDRAW,
                `IDirect3DDevice7_Load: missing surfacePtr src=0x${srcBase} dst=0x${dstBase}`);
            return D3DERR_INVALIDCALL;
        }

        // Copy pixel data row by row
        for (let row = 0; row < copyH; row++) {
            const srcOff = srcBase + (srcY + row) * srcPitch + srcX * bytesPerPixel;
            const dstOff = dstBase + (dstY + row) * dstPitch + dstX * bytesPerPixel;
            const rowBytes = copyW * bytesPerPixel;
            mem.copyWithin(dstOff, srcOff, srcOff + rowBytes);
        }

        // Propagate colorkey
        if (srcState.srcColorKey) {
            dstState.srcColorKey = { low: srcState.srcColorKey.low, high: srcState.srcColorKey.high };
        }

        // Propagate palette for indexed textures (critical for P8 lightmaps in UT).
        // Without this, destination surface keeps paletteHandle=undefined and PALETTE8 upload
        // falls back to black LUT in texture-converter.
        if (srcState.format.bpp === 8 && dstState.format.bpp === 8 && srcState.paletteHandle !== undefined) {
            dstState.paletteHandle = srcState.paletteHandle;
        }

        // Mark destination dirty for GPU sync
        if (isRenderSurface(dstState)) {
            dstState.gpuDirty = true;
            dstState.rgbaScratch = undefined;
            dstState.rgbaScratchVersion = undefined;
            dstState.version = (dstState.version || 0) + 1;
        } else if (isBitmapTexture(dstState)) {
            dstState.gpuNeedsUpload = true;
        }

        // Queue for deferred upload
        if (context.deferredUploadManager && dstState.surfacePtr) {
            context.deferredUploadManager.markDirty(dstState, false);
        }

        return D3D_OK;
    };

    // --- IDirect3DDevice3 ---

    exports["IDirect3DDevice3_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];

        const obj = resourceProvider.getComObjectByAddress(thisPtr);

        const iidBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            iidBytes[i] = mem[riidPtr + i];
        }
        const iidStr = bytesToGuid(iidBytes);

        const isDevice2 = iidStr === IID_IDirect3D7;
        const isDevice3 = iidStr === IID_IDirect3DDevice3;
        if (isDevice2 || isDevice3) {
            Logger.log(LogCategory.DDRAW, `IDirect3DDevice3_QueryInterface: ${isDevice2 ? 'Device2 (DX5)' : 'Device3 (DX6)'} IID requested: ${iidStr}`);
        }

        Logger.log(LogCategory.COM, `IDirect3DDevice3_QueryInterface: this=0x${thisPtr.toString(16)} iid=${iidStr} ppvObject=0x${ppvObject.toString(16)} obj=${obj ? obj.constructor.name : 'null'}`);

        if (!obj) {
            Logger.warn(LogCategory.COM, `IDirect3DDevice3_QueryInterface: Object not found for thisPtr=0x${thisPtr.toString(16)}`);
            return 0x80004002;
        }

        const result = obj.queryInterface(iidStr, ppvObject, mem);
        if (ppvObject) {
            const view = getDataView(mem);
            const returnedAddr = view.getUint32(ppvObject, true);
            Logger.log(LogCategory.COM, `IDirect3DDevice3_QueryInterface: result=0x${result.toString(16)} returnedAddr=0x${returnedAddr.toString(16)}`);
        }
        return result;
    };

    exports["IDirect3DDevice3_AddRef"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirect3DDevice3_Release"] = (ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    // Store HAL caps address for cross-function memory watchpoint
    let lastHalCapsAddr = 0;

    exports["IDirect3DDevice3_GetCaps"] = (ctx, mem, args) => {
        const lpHalCaps = args[1];
        const lpHelCaps = args[2];
        Logger.log(LogCategory.DDRAW, `[COLORKEY] IDirect3DDevice3_GetCaps: lpHalCaps=0x${lpHalCaps?.toString(16) ?? 'null'} lpHelCaps=0x${lpHelCaps?.toString(16) ?? 'null'} EBX=0x${ctx.ebx.toString(16)} EAX=0x${ctx.eax.toString(16)}`);
        if (!lpHalCaps && !lpHelCaps) return 0x80004003;

        // Store for memory watchpoint in SetRenderState
        if (lpHalCaps) lastHalCapsAddr = lpHalCaps;

        const view = getDataView(mem);

        // Ensure dwSize is valid before fillDeviceDesc — games may pass uninitialized
        // stack structs where dwSize=0, causing fillDeviceDesc to bail on its size guard.
        // EnumDevices sets dwSize=252 explicitly; GetCaps must do the same.
        const DX6_DESC_SIZE = 252;
        const DX5_DESC_SIZE = 172;

        const ensureDwSize = (addr: number) => {
            if (!addr || !isValidAddress(mem, addr, 4)) return;
            const sz = view.getUint32(addr, true);
            if (sz !== DX5_DESC_SIZE && sz !== DX6_DESC_SIZE) {
                Logger.log(LogCategory.DDRAW,
                    `[GETCAPS-FIX] dwSize=${sz} is invalid (expected 172 or 252), forcing ${DX6_DESC_SIZE}`);
                view.setUint32(addr, DX6_DESC_SIZE, true);
            }
        };

        if (lpHalCaps) ensureDwSize(lpHalCaps);
        if (lpHelCaps) ensureDwSize(lpHelCaps);

        // HEL desc = software rasterizer: HW-only dwDevCaps bits stripped inside.
        if (lpHalCaps) fillDeviceDesc(view, lpHalCaps);
        if (lpHelCaps) fillDeviceDesc(view, lpHelCaps, true);

        return D3D_OK;
    };

    exports["IDirect3DDevice3_BeginScene"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        Logger.verbose(LogCategory.SYSTEM, `IDirect3DDevice3_BeginScene: this=0x${thisPtr.toString(16)}`);

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        if (obj && context.executor) {
            const rtAddr = obj.getRenderTarget() || context.surfaces.backBuffer || context.surfaces.primary;
            if (rtAddr) {
                const rtObj = resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null;
                const state = rtObj?.getState();
                if (state) {
                    syncActiveGdiContextBeforeD3D(state, rtAddr, mem, context.executor);
                }
                if (state && surfaceSyncManager.needsGPUSync(state).needed) {
                    Logger.log(LogCategory.DDRAW, `IDirect3DDevice3_BeginScene: Syncing RT 0x${rtAddr.toString(16)} from CPU before D3D rendering (DX6)`);
                    context.executor.syncSurfaceFromMemory(state);
                }
            }
        }
        return D3D_OK;
    };

    exports["IDirect3DDevice3_EndScene"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        Logger.log(LogCategory.SYSTEM, `IDirect3DDevice3_EndScene: this=0x${thisPtr.toString(16)} - ending frame and resetting ring buffers`);
        // Same as Device7: authority belongs to real GPU writes / flushBatch, not EndScene.
        if (context.executor) {
            context.executor.endFrame();
        }
        return D3D_OK;
    };

    exports["IDirect3DDevice3_SetRenderTarget"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDS = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;

        if (obj) {
            setDeviceRenderTarget(context, obj, lpDDS);

            // Sync new RT from CPU immediately if it's dirty
            if (context.executor && lpDDS) {
                const rtObj = resourceProvider.getComObjectByAddress(lpDDS) as DirectDrawSurfaceObject | null;
                const state = rtObj?.getState();
                if (state && surfaceSyncManager.needsGPUSync(state).needed) {
                    Logger.log(LogCategory.DDRAW, `IDirect3DDevice3_SetRenderTarget: Syncing new RT 0x${lpDDS.toString(16)} from CPU`);
                    context.executor.syncSurfaceFromMemory(state);
                }
            }
        }

        Logger.verbose(LogCategory.SYSTEM, `IDirect3DDevice3_SetRenderTarget: this=0x${thisPtr.toString(16)}, rt=0x${lpDDS.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_GetRenderTarget"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lplpDDS = args[1];
        if (!lplpDDS || !isValidAddress(mem, lplpDDS, 4)) return 0x80004003;
        initReturnPtr(lplpDDS);

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        const rt = obj ? obj.getRenderTarget() : 0;
        // GetRenderTarget increments the surface's reference count.
        if (rt) resourceProvider.getComObjectByAddress(rt)?.addRef();
        const view = getDataView(mem);
        view.setUint32(lplpDDS, rt, true);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_SetCurrentViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpViewport = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        if (obj) {
            obj.setCurrentViewport(lpViewport);
        }
        Logger.verboseLazy(LogCategory.SYSTEM, () => `IDirect3DDevice3_SetCurrentViewport: this=0x${thisPtr.toString(16)} vp=0x${lpViewport.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_GetCurrentViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lplpViewport = args[1];
        if (!lplpViewport || !isValidAddress(mem, lplpViewport, 4)) return D3DERR_INVALIDCALL;

        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        const vp = obj ? obj.getCurrentViewport() : 0;
        // GetCurrentViewport increments the viewport's reference count.
        if (vp) resourceProvider.getComObjectByAddress(vp)?.addRef();
        const view = getDataView(mem);
        view.setUint32(lplpViewport, vp, true);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_GetTransform"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const state = args[1];
        const pMatrix = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;

        if (!obj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice3_GetTransform: invalid device ${thisPtr}`);
            return D3DERR_INVALIDCALL;
        }

        if (!pMatrix || !isValidAddress(mem, pMatrix, 64)) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice3_GetTransform: bad pMatrix=0x${pMatrix.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        // Get current matrix from object
        let m: Float32Array | null = null;
        if (state === 1) {
            // D3DTRANSFORMSTATE_WORLD
            m = obj.getWorldMatrix();
        } else if (state === 2) {
            // D3DTRANSFORMSTATE_VIEW
            m = obj.getViewMatrix();
        } else if (state === 3) {
            // D3DTRANSFORMSTATE_PROJECTION
            m = obj.getProjMatrix();
        }

        if (!m) {
            m = identityMat4();
        }

        writeMat4(mem, pMatrix, m);

        Logger.verbose(LogCategory.DDRAW, `IDirect3DDevice3_GetTransform: state=${state} p=0x${pMatrix.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_MultiplyTransform"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const state = args[1];
        const pMatrix = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;

        if (!obj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice3_MultiplyTransform: invalid device ${thisPtr}`);
            return D3DERR_INVALIDCALL;
        }

        if (!pMatrix || !isValidAddress(mem, pMatrix, 64)) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice3_MultiplyTransform: bad pMatrix=0x${pMatrix.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        // Read multiplier matrix from memory
        const mul = readMat4(mem, pMatrix);

        // Get current matrix (defaults to identity)
        let cur: Float32Array | null = null;
        if (state === 1) {
            // D3DTRANSFORMSTATE_WORLD
            cur = obj.getWorldMatrix();
        } else if (state === 2) {
            // D3DTRANSFORMSTATE_VIEW
            cur = obj.getViewMatrix();
        } else if (state === 3) {
            // D3DTRANSFORMSTATE_PROJECTION
            cur = obj.getProjMatrix();
        }

        if (!cur) {
            cur = identityMat4();
        }

        // D3D row-vector convention: v' = v * M
        // Argument first, then the stored matrix (see the Device7 note above).
        const res = multiplyMatrices(mul, cur);

        obj.setTransform(state, res);

        Logger.verbose(LogCategory.DDRAW, `IDirect3DDevice3_MultiplyTransform: state=${state} p=0x${pMatrix.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_DrawPrimitive"] = (ctx, mem, args) => {
        const threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;
        Logger.verbose(LogCategory.DDRAW, `[TID=${threadId}] IDirect3DDevice3_DrawPrimitive: type=${args[1]} vtype=0x${args[2].toString(16)} count=${args[4]}`);
        drawHandler.handleDrawPrimitive(args[0], args[1], args[2], args[3], args[4], mem);
        return D3D_OK;
    };

    // Track render state call count for init-time diagnostics
    let renderStateCallCount = 0;

    // Named render states from SetupDxState for diagnostics
    const RENDER_STATE_NAMES: Record<number, string> = {
        2: "ANTIALIAS", 4: "TEXTUREPERSPECTIVE", 7: "ZENABLE", 8: "FILLMODE",
        14: "ZWRITEENABLE", 15: "ALPHATESTENABLE", 16: "FOGENABLE",
        19: "SRCBLEND", 20: "DESTBLEND", 22: "CULLMODE",
        23: "ZFUNC", 26: "DITHERENABLE", 27: "ALPHABLENDENABLE",
        29: "SPECULARENABLE", 34: "FOGCOLOR", 41: "COLORKEYENABLE",
    };

    exports["IDirect3DDevice3_SetRenderState"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const state = args[1];
        const value = args[2];
        renderStateCallCount++;
        let obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;

        if (!obj && thisPtr && thisPtr >= 0x1000 && thisPtr + 4 <= mem.length) {
            const view = getDataView(mem);
            const vtableAddr = view.getUint32(thisPtr, true);
            Logger.log(LogCategory.COM, `IDirect3DDevice3_SetRenderState: Object not found for thisPtr=0x${thisPtr.toString(16)}, checking vtable=0x${vtableAddr.toString(16)} isOur=${isOurVTable(vtableAddr)}`);

            if (isOurVTable(vtableAddr) && vtableAddr === context.vtables.IDirect3DDevice3?.address) {
                Logger.warn(LogCategory.COM, `IDirect3DDevice3_SetRenderState: Device3 object at 0x${thisPtr.toString(16)} has our vtable but is not registered!`);
            }
        }

        if (obj) {
            obj.setRenderState(state, value);
        }

        // Log ALL render states during init phase (first 500 calls) to capture SetupDxState after ClearBuffers iterations
        const stateName = RENDER_STATE_NAMES[state] || `state${state}`;
        if (renderStateCallCount <= 500) {
            Logger.log(LogCategory.DDRAW,
                `[INIT-RS #${renderStateCallCount}] SetRenderState: ${stateName}(${state}) = ${value} (0x${value.toString(16)})`);
        }

        if (state === 1) { // D3DRENDERSTATE_TEXTUREHANDLE
            if (obj) {
                textureManager.setDeviceTexture(obj, 0, value);
            }

            const resolved = textureManager.resolve(value);
            Logger.verboseLazy(LogCategory.DDRAW, () => `!!! IDirect3DDevice3_SetRenderState: D3DRENDERSTATE_TEXTUREHANDLE value=0x${value.toString(16)} surfaceAddr=0x${resolved.addr.toString(16)} src=${resolved.source}`);
            Logger.verboseLazy(LogCategory.SYSTEM, () => `!!! IDirect3DDevice3_SetRenderState: D3DRENDERSTATE_TEXTUREHANDLE value=0x${value.toString(16)} surfaceAddr=0x${resolved.addr.toString(16)} src=${resolved.source}`);
        } else if (state === 41) {
            // Log return address + code dump to identify which game function sets COLORKEYENABLE
            let retAddrStr = "";
            if (ctx.esp >= 0 && ctx.esp + 4 <= mem.length) {
                const retAddr = getDataView(mem).getUint32(ctx.esp, true);
                retAddrStr = ` retAddr=0x${retAddr.toString(16)}`;
                // Dump 64 bytes BEFORE and 64 bytes AFTER return address to see the decision logic
                const dumpStart = retAddr - 64;
                if (dumpStart >= 0x10000 && retAddr + 64 <= mem.length) {
                    const before: string[] = [];
                    const after: string[] = [];
                    for (let i = 0; i < 64; i++) before.push(mem[dumpStart + i].toString(16).padStart(2, '0'));
                    for (let i = 0; i < 64; i++) after.push(mem[retAddr + i].toString(16).padStart(2, '0'));
                    Logger.log(LogCategory.DDRAW,
                        `[COLORKEY-CODE] BEFORE 0x${retAddr.toString(16)} (0x${dumpStart.toString(16)}): ${before.join(' ')}`);
                    Logger.log(LogCategory.DDRAW,
                        `[COLORKEY-CODE] AFTER  0x${retAddr.toString(16)}: ${after.join(' ')}`);
                }
            }
            Logger.log(LogCategory.DDRAW,
                `IDirect3DDevice3_SetRenderState: COLORKEYENABLE = ${value} [call #${renderStateCallCount}]${retAddrStr}`);

            // MEMORY WATCHPOINT: Read D3Dcaps GLOBAL that x86 code actually checks
            // Found via disassembly: MOV EDI, 0x006B4B88; REP MOVSD (copies hal → D3Dcaps)
            // The game copies hal→D3Dcaps via REP MOVSD, then SetupDxState reads from the global.
            const GLOBAL_D3DCAPS = 0x6B4B88;  // D3Dcaps global in revolt.exe .data section
            const GLOBAL_TEXCAPS = 0x6B4C0C;  // D3Dcaps.dpcTriCaps.dwTextureCaps (offset 0x84)
            const GLOBAL_NOCOLORKEY = 0x49EC58; // NoColorKey global (from disasm: CMP [0x49EC58], EDI)
            if (GLOBAL_TEXCAPS + 4 < mem.length) {
                const wv = getDataView(mem);
                const g_dwFlags = wv.getUint32(GLOBAL_D3DCAPS + 4, true);
                const g_texCaps = wv.getUint32(GLOBAL_TEXCAPS, true);
                const g_texCapsByte = mem[GLOBAL_TEXCAPS]; // TEST byte ptr [0x6B4C0C], 0x8
                const g_noColorKey = wv.getUint32(GLOBAL_NOCOLORKEY, true);
                const hasTRICAPS = !!(g_dwFlags & 0x40);
                const hasTRANSPARENCY = !!(g_texCapsByte & 0x8);
                Logger.log(LogCategory.DDRAW,
                    `[CAPS-WATCHPOINT] GLOBAL D3Dcaps@0x${GLOBAL_D3DCAPS.toString(16)}: ` +
                    `dwFlags=0x${g_dwFlags.toString(16)} texCaps(dword)=0x${g_texCaps.toString(16)} texCaps(byte)=0x${g_texCapsByte.toString(16)} ` +
                    `TRICAPS=${hasTRICAPS} TRANSPARENCY=${hasTRANSPARENCY} NoColorKey=${g_noColorKey}`);
                // Also read the stack-local hal for comparison
                if (lastHalCapsAddr && lastHalCapsAddr + 160 < mem.length) {
                    const s_dwFlags = wv.getUint32(lastHalCapsAddr + 4, true);
                    const s_texCaps = wv.getUint32(lastHalCapsAddr + 132, true);
                    Logger.log(LogCategory.DDRAW,
                        `[CAPS-WATCHPOINT] STACK hal@0x${lastHalCapsAddr.toString(16)}: ` +
                        `dwFlags=0x${s_dwFlags.toString(16)} texCaps=0x${s_texCaps.toString(16)} ` +
                        `(stack may be STALE if reused since GetCaps)`);
                }
            }
        } else if (renderStateCallCount > 500) {
            Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice3_SetRenderState: ${stateName}(${state}) = 0x${value.toString(16)}`);
        }

        // TEXTUREMAPBLEND (21) translation now handled inside obj.setRenderState()

        return D3D_OK;
    };

    exports["IDirect3DDevice3_SetTexture"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const stage = args[1];
        const texture = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;

        if (!obj && thisPtr && thisPtr >= 0x1000 && thisPtr + 4 <= mem.length) {
            const view = getDataView(mem);
            const vtableAddr = view.getUint32(thisPtr, true);
            Logger.log(LogCategory.COM, `IDirect3DDevice3_SetTexture: Object not found for thisPtr=0x${thisPtr.toString(16)}, checking vtable=0x${vtableAddr.toString(16)} isOur=${isOurVTable(vtableAddr)}`);

            if (isOurVTable(vtableAddr) && vtableAddr === context.vtables.IDirect3DDevice3?.address) {
                Logger.warn(LogCategory.COM, `IDirect3DDevice3_SetTexture: Device3 object at 0x${thisPtr.toString(16)} has our vtable but is not registered!`);
            }
        }

        if (obj) {
            textureManager.setDeviceTexture(obj, stage, texture);
        }

        const actualTexture = obj ? obj.getTexture(stage) : 0;
        const resolved = textureManager.resolve(texture);
        const resolvedActual = textureManager.resolve(actualTexture);
        
        // DIAGNOSTIC: Log texture stage states to debug white texture issue
        let stageStateLog = "";
        if (obj && stage === 0) {
            const textureStates = obj.getTextureStageStates();
            // Use correct D3DTSS_* constants instead of hardcoded indices
            const colorOp = textureStates[0 * 32 + D3DTSS_COLOROP] || 0;
            const colorArg1 = textureStates[0 * 32 + D3DTSS_COLORARG1] ?? 2;
            const colorArg2 = textureStates[0 * 32 + D3DTSS_COLORARG2] ?? 0;
            const alphaOp = textureStates[0 * 32 + D3DTSS_ALPHAOP] || 0;
            stageStateLog = ` stage0: COLOROP=${colorOp} COLORARG1=${colorArg1} COLORARG2=${colorArg2} ALPHAOP=${alphaOp}`;
        }
        
        const logMsg = `IDirect3DDevice3_SetTexture: thisPtr=0x${thisPtr.toString(16)} stage=${stage} texture=0x${texture.toString(16)} (resolved:${resolved.addr.toString(16)}) -> actual=0x${actualTexture.toString(16)} (resolved:${resolvedActual.addr.toString(16)}) source=${resolved.source}${stageStateLog}`;
        Logger.verbose(LogCategory.DDRAW, logMsg);
        Logger.verbose(LogCategory.SYSTEM, logMsg);

        // EAGER SYNC: Sync texture when modeStr/version says GPU needs update (DEFER only by modeStr=none)
        if (context.executor && resolved.obj) {
            const textureState = resolved.obj.getState();
            if (textureState && textureState.surfacePtr && surfaceSyncManager.needsGPUSync(textureState).needed) {
                const modeStr = isRenderSurface(textureState) ? textureState.mode : "bitmap_texture";
                const ver = isRenderSurface(textureState) ? textureState.version : 0;
                Logger.log(LogCategory.DDRAW,
                    `IDirect3DDevice3_SetTexture: Eager sync texture 0x${textureState.surfacePtr.toString(16)} modeStr=${modeStr} version=${ver}`
                );
                context.executor.syncSurfaceFromMemory(textureState);
            }
        }

        return D3D_OK;
    };

    // Track TSS call count for init-time diagnostics
    let tssCallCount = 0;

    // D3DTSS_* names for diagnostics
    const TSS_NAMES: Record<number, string> = {
        1: "COLOROP", 2: "COLORARG1", 3: "COLORARG2",
        4: "ALPHAOP", 5: "ALPHAARG1", 6: "ALPHAARG2",
        7: "BUMPENVMAT00", 11: "TEXCOORDINDEX",
        12: "ADDRESS", 13: "ADDRESSU", 14: "ADDRESSV",
        15: "BORDERCOLOR", 16: "MAGFILTER", 17: "MINFILTER",
        18: "MIPFILTER", 19: "MIPMAPLODBIAS",
        20: "MAXMIPLEVEL", 21: "MAXANISOTROPY",
    };

    exports["IDirect3DDevice3_SetTextureStageState"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const stage = args[1];
        const type = args[2];
        const value = args[3];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        if (obj) {
            obj.setTextureStageState(stage, type, value);
        }
        tssCallCount++;
        const tssName = TSS_NAMES[type] || `type${type}`;
        if (tssCallCount <= 40) {
            Logger.log(LogCategory.DDRAW,
                `[INIT-TSS #${tssCallCount}] SetTextureStageState: stage=${stage} ${tssName}(${type}) = ${value} (0x${value.toString(16)})`);
        } else if (stage === 0 && (type === 4 || type === 5 || type === 6 || type === 7 || type === 12)) {
            Logger.verbose(LogCategory.DDRAW, `IDirect3DDevice3_SetTextureStageState: stage=${stage} ${tssName}(${type}) value=0x${value.toString(16)}`);
        } else {
            Logger.verbose(LogCategory.SYSTEM, `IDirect3DDevice3_SetTextureStageState: stage=${stage} ${tssName}(${type}) value=0x${value.toString(16)}`);
        }
        return D3D_OK;
    };

    exports["IDirect3DDevice3_SetTransform"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const state = args[1];
        const pMatrix = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;

        if (!obj) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice3_SetTransform: invalid device ${thisPtr}`);
            return D3D_OK;
        }

        // Validate address
        if (!pMatrix || !isValidAddress(mem, pMatrix, 64)) {
            Logger.warn(LogCategory.DDRAW, `IDirect3DDevice3_SetTransform: bad pMatrix=0x${pMatrix.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        // Read 4x4 matrix from memory (16 floats = 64 bytes)
        const matrix = readMat4(mem, pMatrix);

        // Quick checksum to detect changes
        let sum = 0;
        for (let i = 0; i < 64; i++) sum = (sum + mem[pMatrix + i]) & 0xFFFF;

        obj.setTransform(state, matrix);

        Logger.verbose(LogCategory.DDRAW, `IDirect3DDevice3_SetTransform: state=${state} (0x${state.toString(16)}) p=0x${pMatrix.toString(16)} sum=0x${sum.toString(16)}`);
        return D3D_OK;
    };

    // Strided draw: full implementation needed for games like Quake 2 (D3D mode) that use LPD3DDRAWPRIMITIVESTRIDEDDATA.
    exports["IDirect3DDevice3_DrawPrimitiveStrided"] = (ctx, mem, args) => {
        const type = args[1];
        const vtype = args[2];
        const count = args[4];
        Logger.verbose(LogCategory.SYSTEM, `IDirect3DDevice3_DrawPrimitiveStrided: type=${type} vtype=${vtype} count=${count}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_DrawIndexedPrimitive"] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, `IDirect3DDevice3_DrawIndexedPrimitive: type=${args[1]} vtype=0x${args[2].toString(16)} vCount=${args[4]} iCount=${args[6]}`);
        drawHandler.handleDrawPrimitive(args[0], args[1], args[2], args[3], args[4], mem, true, args[5], args[6]);
        return D3D_OK;
    };

    // IDirect3DDevice3::DrawPrimitiveVB(this, primType, lpVB, startVertex, numVertices, flags)
    exports["IDirect3DDevice3_DrawPrimitiveVB"] = (ctx, mem, args) => {
        const primType = args[1];
        const lpVB = args[2];
        const startVertex = args[3];
        const numVertices = args[4];
        const obj = resourceProvider.getComObjectByAddress(lpVB) as Direct3DVertexBufferObject | null;
        if (!obj) {
            Logger.error(LogCategory.DDRAW, `IDirect3DDevice3_DrawPrimitiveVB: VB not found at 0x${lpVB.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }
        const dataAddr = obj.getDataPtr() + startVertex * obj.getVertexSize();
        drawHandler.handleDrawPrimitive(args[0], primType, obj.getFVF(), dataAddr, numVertices, mem);
        return D3D_OK;
    };

    // IDirect3DDevice3::DrawIndexedPrimitiveVB(this, primType, lpVB, lpIndices, indexCount, flags)
    exports["IDirect3DDevice3_DrawIndexedPrimitiveVB"] = (ctx, mem, args) => {
        const primType = args[1];
        const lpVB = args[2];
        const lpIndices = args[3];
        const indexCount = args[4];
        const obj = resourceProvider.getComObjectByAddress(lpVB) as Direct3DVertexBufferObject | null;
        if (!obj) {
            Logger.error(LogCategory.DDRAW, `IDirect3DDevice3_DrawIndexedPrimitiveVB: VB not found at 0x${lpVB.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }
        const dataAddr = obj.getDataPtr();
        drawHandler.handleDrawPrimitive(args[0], primType, obj.getFVF(), dataAddr, obj.getNumVertices(), mem, true, lpIndices, indexCount);
        return D3D_OK;
    };

    // Strided indexed draw: full implementation needed for games like Quake 2 (D3D mode).
    exports["IDirect3DDevice3_DrawIndexedPrimitiveStrided"] = (ctx, mem, args) => {
        const type = args[1];
        const vtype = args[2];
        const vCount = args[4];
        const iCount = args[6];
        Logger.log(LogCategory.SYSTEM, `IDirect3DDevice3_DrawIndexedPrimitiveStrided: type=${type} vtype=${vtype} vCount=${vCount} iCount=${iCount}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_AddViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpViewport = args[1];
        const vpObj = resourceProvider.getComObjectByAddress(lpViewport) as Direct3DViewport3Object | null;
        if (vpObj) {
            vpObj.setDevice(thisPtr);
            // The device's viewport list holds a reference until DeleteViewport.
            vpObj.addRef();
        }
        Logger.log(LogCategory.SYSTEM, `IDirect3DDevice3_AddViewport: device=0x${thisPtr.toString(16)} vp=0x${lpViewport.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_DeleteViewport"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpViewport = args[1];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        const vpObj = resourceProvider.getComObjectByAddress(lpViewport) as Direct3DViewport3Object | null;
        if (!vpObj) return D3DERR_INVALIDCALL;
        // Deleting the current viewport leaves the device with none (real behavior).
        if (obj && obj.getCurrentViewport() === lpViewport) {
            obj.setCurrentViewport(0);
        }
        vpObj.release();
        Logger.log(LogCategory.SYSTEM, `IDirect3DDevice3_DeleteViewport: device=0x${thisPtr.toString(16)} vp=0x${lpViewport.toString(16)}`);
        return D3D_OK;
    };

    assignStubsOnce(exports, createDeviceStubsExports(), "d3d device stubs");

    exports["IDirect3DDevice3_GetDirect3D"] = (_ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]) as Direct3DDevice3Object | null;
        return writeGetDirect3D(obj, args[1], "IDirect3D3", mem);
    };

    // =========================================================================
    // DEVICE3 GETTER METHODS
    // =========================================================================

    exports["IDirect3DDevice3_GetRenderState"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const state = args[1];
        const pValue = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!pValue || !isValidAddress(mem, pValue, 4)) return D3DERR_INVALIDCALL;

        const value = obj.getRenderState(state);
        const view = getDataView(mem);
        view.setUint32(pValue, value >>> 0, true);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice3_GetRenderState: state=${state} value=0x${(value >>> 0).toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_GetTexture"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const stage = args[1];
        const ppTexture = args[2];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!ppTexture || !isValidAddress(mem, ppTexture, 4)) return D3DERR_INVALIDCALL;
        initReturnPtr(ppTexture);

        const textureAddr = obj.getTexture(stage);
        const view = getDataView(mem);
        view.setUint32(ppTexture, textureAddr, true);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice3_GetTexture: stage=${stage} texture=0x${textureAddr.toString(16)}`);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_GetTextureStageState"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const stage = args[1];
        const type = args[2];
        const pValue = args[3];
        const obj = resourceProvider.getComObjectByAddress(thisPtr) as Direct3DDevice3Object | null;
        if (!obj) return D3DERR_INVALIDCALL;
        if (!pValue || !isValidAddress(mem, pValue, 4)) return D3DERR_INVALIDCALL;

        const value = obj.getTextureStageState(stage, type);
        const view = getDataView(mem);
        view.setUint32(pValue, value >>> 0, true);
        Logger.verboseLazy(LogCategory.DDRAW, () => `IDirect3DDevice3_GetTextureStageState: stage=${stage} type=${type} value=0x${(value >>> 0).toString(16)}`);
        return D3D_OK;
    };

    // --- EnumTextureFormats ---

    exports["IDirect3DDevice3_EnumTextureFormats"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpCallback = args[1];
        const lpContext = args[2];

        if (!lpCallback) {
            Logger.error(LogCategory.DDRAW, `IDirect3DDevice3_EnumTextureFormats: lpCallback is NULL!`);
            return D3DERR_INVALIDCALL;
        }

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return D3D_OK;

        // EnumTextureFormats callback receives LPDDPIXELFORMAT, NOT LPDDSURFACEDESC
        const pixelFormatSize = 32;
        const pfAddr = context.process.memory.alloc(pixelFormatSize);
        const view = getDataView(mem);

        const formats = ENUM_TEXTURE_FORMATS;

        callbackManager.saveSuspendedThunkContext(ctx, 12);
        let index = 0;
        let firstCallbackId: number | null = null;
        let freed = false;
        const freeOnce = (): void => {
            if (freed) return;
            freed = true;
            context.process.memory.free(pfAddr);
        };

        const processNext = (): void => {
            if (index >= formats.length) {
                freeOnce();
                return;
            }

            const f = formats[index++];
            mem.fill(0, pfAddr, pfAddr + pixelFormatSize);

            // DDPIXELFORMAT structure
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.size, pixelFormatSize, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.flags, f.flags, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.fourCC, f.fourCC ?? 0, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.rgbBitCount, f.bpp, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.rMask, f.r, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.gMask, f.g, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.bMask, f.b, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.aMask, f.a, true);

            Logger.log(LogCategory.DDRAW,
                `EnumTextureFormats(Device3): offering #${index}/${formats.length}: ${f.bpp}bpp ` +
                `R=0x${f.r.toString(16)} G=0x${f.g.toString(16)} B=0x${f.b.toString(16)} A=0x${f.a.toString(16)} ` +
                `flags=0x${f.flags.toString(16)} hasAlpha=${!!(f.flags & DDPF_ALPHAPIXELS)}`);

            const currentIndex = index;
            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [pfAddr, lpContext],
                0,
                (ret) => {
                    Logger.log(LogCategory.DDRAW,
                        `EnumTextureFormats(Device3): callback for #${currentIndex} returned ${ret} (${ret === 0 ? 'STOP' : 'CONTINUE'})`);
                    if (ret === 0 || index >= formats.length) {
                        freeOnce();
                        return D3D_OK;
                    }
                    return null;
                }
            );

            if (firstCallbackId === null) firstCallbackId = callbackId;
            const inv = callbackManager.getPendingCallback(callbackId);
            if (inv) inv.enumerationState = { continueEnumeration: processNext, finishEnumeration: freeOnce };
        };

        processNext();
        return { value: 0, suspendedForCallback: true, callbackId: firstCallbackId || 0, stackCleanup: 12 };
    };

    exports["IDirect3DDevice7_EnumTextureFormats"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpCallback = args[1];
        const lpContext = args[2];
                
        if (!lpCallback) return D3DERR_INVALIDCALL;

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return D3D_OK;

        // EnumTextureFormats callback receives LPDDPIXELFORMAT
        const pixelFormatSize = 32;
        const pfAddr = context.process.memory.alloc(pixelFormatSize);
        const view = getDataView(mem);

        const formats = ENUM_TEXTURE_FORMATS;

        callbackManager.saveSuspendedThunkContext(ctx, 12);
        let index = 0;
        let firstCallbackId: number | null = null;
        let freed = false;
        const freeOnce = (): void => {
            if (freed) return;
            freed = true;
            context.process.memory.free(pfAddr);
        };

        const processNext = (): void => {
            if (index >= formats.length) {
                freeOnce();
                return;
            }

            const f = formats[index++];
            mem.fill(0, pfAddr, pfAddr + pixelFormatSize);

            // DDPIXELFORMAT structure
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.size, pixelFormatSize, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.flags, f.flags, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.fourCC, f.fourCC ?? 0, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.rgbBitCount, f.bpp, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.rMask, f.r, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.gMask, f.g, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.bMask, f.b, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.aMask, f.a, true);

            Logger.log(LogCategory.DDRAW,
                `EnumTextureFormats(Device7): offering #${index}/${formats.length}: ${f.bpp}bpp ` +
                `R=0x${f.r.toString(16)} G=0x${f.g.toString(16)} B=0x${f.b.toString(16)} A=0x${f.a.toString(16)} ` +
                `flags=0x${f.flags.toString(16)} hasAlpha=${!!(f.flags & DDPF_ALPHAPIXELS)}`);

            const currentIndex = index;
            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [pfAddr, lpContext],
                0,
                (ret) => {
                    Logger.log(LogCategory.DDRAW,
                        `EnumTextureFormats(Device7): callback for #${currentIndex} returned ${ret} (${ret === 0 ? 'STOP' : 'CONTINUE'})`);
                    if (ret === 0 || index >= formats.length) {
                        freeOnce();
                        return D3D_OK;
                    }
                    return null;
                }
            );

            if (firstCallbackId === null) firstCallbackId = callbackId;
            const inv = callbackManager.getPendingCallback(callbackId);
            if (inv) inv.enumerationState = { continueEnumeration: processNext, finishEnumeration: freeOnce };
        };

        processNext();
        return { value: 0, suspendedForCallback: true, callbackId: firstCallbackId || 0, stackCleanup: 12 };
    };

    // ValidateDevice(LPDWORD lpdwPasses) — the pass count the CURRENT texture-stage setup
    // would need. Our stage resolver evaluates every advertised D3DTOP in one shader
    // (backends/webgpu/ddraw/ffp-stages.ts), so the answer is one pass — but it has to be
    // WRITTEN: a D3D_OK over an untouched DWORD leaves the caller reading its own stack and
    // deciding, from garbage, to split the material into passes it never needed.
    const validateDevice: ThunkImplementation = (ctx, mem, args) => {
        const lpdwPasses = args[1];
        if (!lpdwPasses || !isValidAddress(mem, lpdwPasses, 4)) return D3DERR_INVALIDCALL;
        getDataView(mem).setUint32(lpdwPasses, 1, true);
        return D3D_OK;
    };
    exports["IDirect3DDevice3_ValidateDevice"] = validateDevice;
    exports["IDirect3DDevice7_ValidateDevice"] = validateDevice;

    // --- Clip status (D3DCLIPSTATUS: dwFlags, dwStatus, minx, maxx, miny, maxy, minz, maxz) ---
    // SetClipStatus is a promise from the app about where its geometry lies; nothing in this
    // renderer consumes it, so accepting it is faithful. GetClipStatus is the dangerous half:
    // it is pure OUT, and the app reads the extents back to size its own 2D work.
    const D3DCLIPSTATUS_SIZE = 32;
    const D3DCLIPSTATUS_EXTENTS2 = 0x00000002;

    const setClipStatus: ThunkImplementation = (ctx, mem, args) => {
        const lpClipStatus = args[1];
        if (!lpClipStatus || !isValidAddress(mem, lpClipStatus, D3DCLIPSTATUS_SIZE)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    /** Screen extents of whatever viewport the device is currently rendering through. */
    const deviceViewportExtents = (thisPtr: number): { x: number; y: number; w: number; h: number } => {
        const obj = resourceProvider.getComObjectByAddress(thisPtr);
        if (obj instanceof Direct3DDevice7Object) {
            const vp = obj.getViewportData();
            if (vp) return { x: vp.x, y: vp.y, w: vp.width, h: vp.height };
        } else if (obj instanceof Direct3DDevice3Object) {
            const vpAddr = obj.getCurrentViewport();
            const vpObj = vpAddr
                ? (resourceProvider.getComObjectByAddress(vpAddr) as Direct3DViewport3Object | null)
                : null;
            if (vpObj) {
                const vp = vpObj.getViewport();
                return { x: vp.x, y: vp.y, w: vp.width, h: vp.height };
            }
        }
        const rtAddr = context.surfaces.backBuffer || context.surfaces.primary;
        const rtState = rtAddr
            ? (resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null)?.getState()
            : null;
        return { x: 0, y: 0, w: rtState?.width ?? 0, h: rtState?.height ?? 0 };
    };

    const getClipStatus: ThunkImplementation = (ctx, mem, args) => {
        const lpClipStatus = args[1];
        if (!lpClipStatus || !isValidAddress(mem, lpClipStatus, D3DCLIPSTATUS_SIZE)) return D3DERR_INVALIDCALL;
        const { x, y, w, h } = deviceViewportExtents(args[0]);
        const view = getDataView(mem);
        // We do not accumulate per-draw clip results, so dwStatus is 0 (nothing was clipped)
        // and the extents are the whole viewport — the widest honest answer, and the one that
        // cannot make an app discard geometry it did draw.
        view.setUint32(lpClipStatus + 0, D3DCLIPSTATUS_EXTENTS2, true);
        view.setUint32(lpClipStatus + 4, 0, true);
        view.setFloat32(lpClipStatus + 8, x, true);
        view.setFloat32(lpClipStatus + 12, x + w, true);
        view.setFloat32(lpClipStatus + 16, y, true);
        view.setFloat32(lpClipStatus + 20, y + h, true);
        view.setFloat32(lpClipStatus + 24, 0, true);
        view.setFloat32(lpClipStatus + 28, 0, true);
        return D3D_OK;
    };

    exports["IDirect3DDevice3_SetClipStatus"] = setClipStatus;
    exports["IDirect3DDevice7_SetClipStatus"] = setClipStatus;
    exports["IDirect3DDevice3_GetClipStatus"] = getClipStatus;
    exports["IDirect3DDevice7_GetClipStatus"] = getClipStatus;

    // --- ComputeSphereVisibility ---
    // The DX6/DX7 visibility query: the app hands us bounding spheres in WORLD space and we
    // classify each against the current frustum. It is pure OUT through lpdwReturnValues, and
    // a D3D_OK over an untouched array is the worst shape of all — the engine reads its own
    // stack as D3DVIS_OUTSIDE_* and drops objects that are on screen.
    //
    // The frustum planes come straight out of the combined world*view*projection matrix
    // (a clip-space plane pulled back into world space is a row combination of that matrix),
    // so the device already holds everything needed; no renderer state is involved.
    const computeSphereVisibility = (
        mem: Uint8Array, args: number[], legacyEncoding: boolean
    ): number => {
        const obj = resourceProvider.getComObjectByAddress(args[0]) as
            Direct3DDevice3Object | Direct3DDevice7Object | null;
        const lpCenters = args[1];
        const lpRadii = args[2];
        const count = args[3] >>> 0;
        const lpdwReturnValues = args[5];
        if (!obj || !lpCenters || !lpRadii || !lpdwReturnValues) return D3DERR_INVALIDCALL;
        if (count === 0) return D3D_OK;
        if (!isValidAddress(mem, lpCenters, count * 12) ||
            !isValidAddress(mem, lpRadii, count * 4) ||
            !isValidAddress(mem, lpdwReturnValues, count * 4)) {
            return D3DERR_INVALIDCALL;
        }

        const planes = frustumPlanesFromCombined(multiplyMatrices(
            multiplyMatrices(obj.getWorldMatrix(), obj.getViewMatrix()),
            obj.getProjMatrix()
        ));
        const view = getDataView(mem);
        for (let s = 0; s < count; s++) {
            const bits = sphereVisibilityBits(
                planes,
                view.getFloat32(lpCenters + s * 12, true),
                view.getFloat32(lpCenters + s * 12 + 4, true),
                view.getFloat32(lpCenters + s * 12 + 8, true),
                view.getFloat32(lpRadii + s * 4, true),
                legacyEncoding
            );
            view.setUint32(lpdwReturnValues + s * 4, legacyEncoding ? clipBitsToD3dVis(bits) : bits, true);
        }
        return D3D_OK;
    };

    exports["IDirect3DDevice3_ComputeSphereVisibility"] = (ctx, mem, args) =>
        computeSphereVisibility(mem, args, true);
    exports["IDirect3DDevice7_ComputeSphereVisibility"] = (ctx, mem, args) =>
        computeSphereVisibility(mem, args, false);

    // --- IDirect3DDevice2 ---
    // Device2 vtable has SwapTextureHandles at index 4 (absent in Device3),
    // shifting all subsequent methods by one slot. Most implementations are
    // identical to Device3, so we delegate — EXCEPT EnumTextureFormats which
    // has a different callback signature in DX5 vs DX6.

    // DX5 IDirect3DDevice2::EnumTextureFormats callback: HRESULT CALLBACK(LPDDSURFACEDESC, LPVOID)
    // — the callback receives a full 108-byte DDSURFACEDESC with DDPIXELFORMAT embedded at offset 72.
    // DX6 IDirect3DDevice3::EnumTextureFormats callback: HRESULT CALLBACK(LPDDPIXELFORMAT, LPVOID)
    // — only the 32-byte pixel format struct is passed.
    const enumTextureFormatsDx5: ThunkImplementation = (ctx, mem, args) => {
        const lpCallback = args[1];
        const lpContext  = args[2];

        if (!lpCallback) {
            Logger.error(LogCategory.DDRAW, `IDirect3DDevice2_EnumTextureFormats: lpCallback is NULL!`);
            return D3DERR_INVALIDCALL;
        }

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return D3D_OK;

        // Allocate one DDSURFACEDESC (108 bytes) reused across callbacks.
        const sdAddr = context.process.memory.alloc(DDSURFACEDESC_SIZE);
        const view = getDataView(mem);

        const formats = ENUM_TEXTURE_FORMATS_DX5;

        callbackManager.saveSuspendedThunkContext(ctx, 12);
        let index = 0;
        let firstCallbackId: number | null = null;
        let freed = false;
        const freeOnce = (): void => {
            if (freed) return;
            freed = true;
            context.process.memory.free(sdAddr);
        };

        const processNext = (): void => {
            if (index >= formats.length) {
                freeOnce();
                return;
            }

            const f = formats[index++];

            // Zero the whole DDSURFACEDESC, then fill header + embedded DDPIXELFORMAT.
            mem.fill(0, sdAddr, sdAddr + DDSURFACEDESC_SIZE);
            view.setUint32(sdAddr + DDSURFACEDESC_OFFSETS.size,  DDSURFACEDESC_SIZE, true);
            view.setUint32(sdAddr + DDSURFACEDESC_OFFSETS.flags, DDSD_PIXELFORMAT, true);

            // DDPIXELFORMAT is embedded at offset 72.
            const pfAddr = sdAddr + DDSURFACEDESC_OFFSETS.pixelFormat;
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.size,        32, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.flags,       f.flags, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.fourCC,      f.fourCC ?? 0, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.rgbBitCount, f.bpp, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.rMask,       f.r, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.gMask,       f.g, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.bMask,       f.b, true);
            view.setUint32(pfAddr + DDPIXELFORMAT_OFFSETS.aMask,       f.a, true);

            Logger.log(LogCategory.DDRAW,
                `EnumTextureFormats(Device2): offering #${index}/${formats.length}: ${f.bpp}bpp ` +
                `R=0x${f.r.toString(16)} G=0x${f.g.toString(16)} B=0x${f.b.toString(16)} A=0x${f.a.toString(16)} ` +
                `flags=0x${f.flags.toString(16)}`);

            const currentIndex = index;
            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [sdAddr, lpContext],
                0,
                (ret) => {
                    Logger.log(LogCategory.DDRAW,
                        `EnumTextureFormats(Device2): callback for #${currentIndex} returned ${ret} (${ret === 0 ? 'STOP' : 'CONTINUE'})`);
                    if (ret === 0 || index >= formats.length) {
                        freeOnce();
                        return D3D_OK;
                    }
                    return null;
                }
            );

            if (firstCallbackId === null) firstCallbackId = callbackId;
            const inv = callbackManager.getPendingCallback(callbackId);
            if (inv) inv.enumerationState = { continueEnumeration: processNext, finishEnumeration: freeOnce };
        };

        processNext();
        return { value: 0, suspendedForCallback: true, callbackId: firstCallbackId || 0, stackCleanup: 12 };
    };

    const device2Methods = [
        "QueryInterface", "AddRef", "Release", "GetCaps",
        "GetStats", "AddViewport", "DeleteViewport", "NextViewport",
        // EnumTextureFormats intentionally excluded — Device2 has its own above (DX5 LPDDSURFACEDESC callback)
        // DrawPrimitive/DrawIndexedPrimitive intentionally excluded — Device2 passes
        // D3DVERTEXTYPE, not FVF (own handlers below)
        "BeginScene", "EndScene", "GetDirect3D",
        "SetCurrentViewport", "GetCurrentViewport", "SetRenderTarget",
        "GetRenderTarget", "Begin", "BeginIndexed", "Vertex", "Index",
        "End", "GetRenderState", "SetRenderState", "GetLightState",
        "SetLightState", "SetTransform", "GetTransform", "MultiplyTransform",
        "SetClipStatus", "GetClipStatus",
    ];
    for (const method of device2Methods) {
        const d3key = `IDirect3DDevice3_${method}`;
        if (exports[d3key]) {
            exports[`IDirect3DDevice2_${method}`] = exports[d3key];
        }
    }

    const device2OnlyStubs = [
        "GetStats", "DeleteViewport", "NextViewport",
        "Begin", "BeginIndexed", "Vertex", "Index", "End",
        "GetLightState", "SetLightState", "SetClipStatus", "GetClipStatus",
    ];
    for (const method of device2OnlyStubs) {
        const key = `IDirect3DDevice2_${method}`;
        if (!exports[key]) {
            exports[key] = () => D3D_OK;
        }
    }

    // SwapTextureHandles (Device2-only, no Device3 equivalent) — stub
    exports["IDirect3DDevice2_SwapTextureHandles"] = () => D3D_OK;

    // --- IDirect3DDevice (v1) ---
    // The device a DX2/3-era title gets from IDirectDrawSurface::QueryInterface(IID_IDirect3D*Device).
    // Backed by the same Device3 state object; only the vtable layout differs. Execute-buffer
    // methods stay unregistered on purpose — an UNIMPLEMENTED stub names itself in stubs(),
    // where a D3D_OK lie would send the guest off with a null buffer.
    const device1Methods = [
        "QueryInterface", "AddRef", "Release", "GetCaps",
        "AddViewport", "DeleteViewport", "NextViewport",
        "BeginScene", "EndScene",
    ];
    for (const method of device1Methods) {
        const d3key = `IDirect3DDevice3_${method}`;
        if (exports[d3key]) exports[`IDirect3DDevice_${method}`] = exports[d3key];
    }
    // GetDirect3D is NOT aliasable: a v1 device must hand back an IDirect3D, whose vtable
    // is a different layout from IDirect3D3's, not merely a shorter prefix of it.
    exports["IDirect3DDevice_GetDirect3D"] = (_ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]) as Direct3DDevice3Object | null;
        return writeGetDirect3D(obj, args[1], "IDirect3D", mem);
    };
    exports["IDirect3DDevice2_GetDirect3D"] = (_ctx, mem, args) => {
        const obj = resourceProvider.getComObjectByAddress(args[0]) as Direct3DDevice3Object | null;
        return writeGetDirect3D(obj, args[1], "IDirect3D2", mem);
    };
    // v1 and Device2 share the DX5 LPDDSURFACEDESC enumeration callback.
    exports["IDirect3DDevice2_EnumTextureFormats"] = enumTextureFormatsDx5;
    exports["IDirect3DDevice_EnumTextureFormats"] = enumTextureFormatsDx5;
    exports["IDirect3DDevice_SwapTextureHandles"] = () => D3D_OK;
    exports["IDirect3DDevice_GetStats"] = () => D3D_OK;
    // Initialize is a no-op for an already-created device (DDERR_ALREADYINITIALIZED).
    exports["IDirect3DDevice_Initialize"] = () => 0x88760005; // MAKE_DDHRESULT(5)

    // Device2 draw calls take a D3DVERTEXTYPE enum (1=VERTEX, 2=LVERTEX, 3=TLVERTEX),
    // not an FVF. The Device3 handler would misread D3DVT_TLVERTEX=3 as FVF XYZ
    // (stride 12) and shred the vertex stream (TR2 menu rendered as garbage quads).
    // D3DFVF_LVERTEX's dwReserved DWORD occupies the same slot the converter already
    // skips for the 0x020 (PSIZE) bit, so all three layouts parse correctly.
    const D3DVT_TO_FVF: Record<number, number> = {
        1: 0x112, // D3DVT_VERTEX   -> D3DFVF_VERTEX   (XYZ|NORMAL|TEX1, 32 bytes)
        2: 0x1e2, // D3DVT_LVERTEX  -> D3DFVF_LVERTEX  (XYZ|RESERVED1|DIFFUSE|SPECULAR|TEX1, 32 bytes)
        3: 0x1c4, // D3DVT_TLVERTEX -> D3DFVF_TLVERTEX (XYZRHW|DIFFUSE|SPECULAR|TEX1, 32 bytes)
    };
    const vtypeToFvf = (vtype: number, caller: string): number | null => {
        const fvf = D3DVT_TO_FVF[vtype];
        if (fvf === undefined) {
            Logger.warn(LogCategory.DDRAW, `${caller}: unknown D3DVERTEXTYPE ${vtype}, dropping draw`);
            return null;
        }
        return fvf;
    };
    exports["IDirect3DDevice2_DrawPrimitive"] = (ctx, mem, args) => {
        const fvf = vtypeToFvf(args[2], "IDirect3DDevice2_DrawPrimitive");
        if (fvf === null) return D3D_OK;
        Logger.verbose(LogCategory.DDRAW, `IDirect3DDevice2_DrawPrimitive: type=${args[1]} vtype=${args[2]} fvf=0x${fvf.toString(16)} count=${args[4]}`);
        drawHandler.handleDrawPrimitive(args[0], args[1], fvf, args[3], args[4], mem);
        return D3D_OK;
    };
    exports["IDirect3DDevice2_DrawIndexedPrimitive"] = (ctx, mem, args) => {
        const fvf = vtypeToFvf(args[2], "IDirect3DDevice2_DrawIndexedPrimitive");
        if (fvf === null) return D3D_OK;
        Logger.verbose(LogCategory.DDRAW, `IDirect3DDevice2_DrawIndexedPrimitive: type=${args[1]} vtype=${args[2]} fvf=0x${fvf.toString(16)} vCount=${args[4]} iCount=${args[6]}`);
        drawHandler.handleDrawPrimitive(args[0], args[1], fvf, args[3], args[4], mem, true, args[5], args[6]);
        return D3D_OK;
    };

    return exports;
};
