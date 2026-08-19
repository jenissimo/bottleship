/**
 * D3D9 Device functions
 *
 * Atomic implementation for Direct3D device operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { gammaService } from '../../core/gamma-service';
import { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import {
    PP_BACKBUFFER_WIDTH, PP_BACKBUFFER_HEIGHT, PP_BACKBUFFER_FORMAT,
    PP_WINDOWED, PP_ENABLE_AUTO_DEPTHSTENCIL,
    PP_AUTO_DEPTHSTENCIL_FORMAT, PP_PRESENTATION_INTERVAL, readD3d9SwapEffect,
} from './presentation-params';
import { WebGPUBackend } from '../../backends/webgpu/webgpu-backend';
import { resizeFullscreenWindowToMode } from '../../runtime/windowing/fullscreen-window';
import {
    acknowledgeDeviceReset,
    deviceCooperativeLevel,
    forgetLossTrackedDevice,
    registerLossTrackedDevice,
} from '../../core/gpu/gpu-device-loss-contract';
import { writeDeviceCaps9 } from './caps';
import {
    addComRef, getVTables, devices, createComObject, registerComFinalizer,
    releaseComRef, resourceToDevice, deviceToD3D9, deviceCreationParams,
    deviceBackBufferInfo,
} from './shared-state';
import {
    clearDeviceRenderTargets,
    deviceBoundDepthStencil,
    dropDeviceBackBufferSurface,
    getDeviceBackBufferSurface,
    getDeviceRenderTarget,
    releaseSurfaceMetadata,
    resolveSurfaceInfo,
    setDeviceBackBufferSurface,
    setDeviceRenderTarget,
    setDeviceSlotRef,
    surfaceMeta,
    takeAllDeviceSlotRefs,
    takeDeviceBackBufferSurfaces,
    takeDeviceSlotRef,
} from './resource-registry';
import {
    isHardwareDeviceCursor, releaseDeviceCursor, setDeviceCursorImage,
    setDeviceCursorPosition, showDeviceCursor,
} from '../../core/device-cursor';

const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_INDEX32 = 102;

const D3DRTYPE_SURFACE = 1;
const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_DEPTHSTENCIL = 0x2;
const D3DPOOL_DEFAULT = 0;
const D3DFMT_D24S8 = 75;
const D3DDEVTYPE_HAL = 1;
const D3D9_MAX_RENDER_TARGETS = 4;
const D3DBACKBUFFER_TYPE_MONO = 0;
const D3DERR_NOTFOUND = 0x88760866;

function formatForBpp(bpp: number): number {
    return bpp <= 16 ? D3DFMT_R5G6B5 : D3DFMT_X8R8G8B8;
}

/** Register real backbuffer geometry for a fabricated implicit-backbuffer surface so
 *  GetDesc reports the true mode instead of a fallback. Deliberately NO texturePtr —
 *  SetRenderTarget resolves texturePtr 0 to the swap-chain. */
function registerImplicitBackbufferMeta(surfacePtr: number, devicePtr: number): void {
    const bb = resolveBackBufferGeometry(devicePtr);
    surfaceMeta.set(surfacePtr, {
        format: bb.format,
        type: D3DRTYPE_SURFACE,
        usage: D3DUSAGE_RENDERTARGET,
        pool: D3DPOOL_DEFAULT,
        multiSampleType: 0,
        multiSampleQuality: 0,
        width: bb.width,
        height: bb.height,
    });
}

/** The object a surface reference actually lands on: a mip level / cube face has no
 *  refcount of its own, its parent texture holds it. */
function surfaceRefTarget(surfacePtr: number): number {
    const pSurface = surfacePtr >>> 0;
    if (!pSurface) return 0;
    return (surfaceMeta.get(pSurface)?.texturePtr || pSurface) >>> 0;
}

/** Point a device binding slot at a surface. The new reference is taken before the
 *  slot's old one is dropped (re-binding the same texture must never transiently
 *  free it), and what was incremented is recorded — see deviceSlotRefs. */
function rebindSurfaceSlot(devicePtr: number, slot: string, surfacePtr: number): void {
    const target = surfaceRefTarget(surfacePtr);
    if (target) addComRef(target);
    releaseSurfaceSlot(devicePtr, slot);
    if (target) setDeviceSlotRef(devicePtr, slot, target);
}

/** Hand a slot a reference it already owns (an implicit surface created for it). */
function adoptSurfaceSlot(devicePtr: number, slot: string, surfacePtr: number): void {
    const target = surfaceRefTarget(surfacePtr);
    releaseSurfaceSlot(devicePtr, slot);
    if (target) setDeviceSlotRef(devicePtr, slot, target);
}

function releaseSurfaceSlot(devicePtr: number, slot: string): void {
    const held = takeDeviceSlotRef(devicePtr, slot);
    if (held) releaseComRef(held);
}

function renderTargetSlot(index: number): string {
    return `rt${index >>> 0}`;
}

/** Drop every reference this device's bindings and implicit surfaces hold. */
function releaseDeviceSurfaceRefs(devicePtr: number): void {
    for (const held of takeAllDeviceSlotRefs(devicePtr)) releaseComRef(held);
    for (const surfacePtr of takeDeviceBackBufferSurfaces(devicePtr)) releaseComRef(surfacePtr);
}

/**
 * The device's backbuffer geometry, or the emulator's screen mode when the device never
 * declared one (BackBufferWidth/Height 0 = "use the focus window's client area", which is
 * the windowed default in real D3D9). Recorded per-device at CreateDevice/Reset because
 * the app owns this number, not the bundle manifest.
 */
function resolveBackBufferGeometry(devicePtr: number): { width: number; height: number; format: number; windowed: boolean } {
    const cfg = EmulatorConfig.getInstance().screenResolution;
    const info = deviceBackBufferInfo.get(devicePtr >>> 0);
    if (info && info.width > 0 && info.height > 0) return info;
    return { width: cfg.width, height: cfg.height, format: formatForBpp(cfg.bpp), windowed: !!info?.windowed };
}

/** Record what CreateDevice/Reset was actually given. Width/height 0 stay 0 so
 *  resolveBackBufferGeometry falls back rather than inventing an extent. */
function recordBackBufferInfo(devicePtr: number, pPresentationParameters: number, mem: Uint8Array): void {
    if (!pPresentationParameters) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const width = view.getUint32(pPresentationParameters + PP_BACKBUFFER_WIDTH, true) >>> 0;
    const height = view.getUint32(pPresentationParameters + PP_BACKBUFFER_HEIGHT, true) >>> 0;
    const rawFormat = view.getUint32(pPresentationParameters + PP_BACKBUFFER_FORMAT, true) >>> 0;
    const windowed = (view.getUint32(pPresentationParameters + PP_WINDOWED, true) >>> 0) !== 0;
    const cfg = EmulatorConfig.getInstance().screenResolution;
    // D3DFMT_UNKNOWN (0) is legal in windowed mode: the runtime adopts the desktop format.
    deviceBackBufferInfo.set(devicePtr >>> 0, {
        width, height,
        format: rawFormat || formatForBpp(cfg.bpp),
        windowed,
    });
    Logger.log(LogCategory.D3D9,
        `backbuffer geometry: ${width}x${height} fmt=${rawFormat || formatForBpp(cfg.bpp)} windowed=${windowed}`);
}

/**
 * Faithful auto depth-stencil: a device created (or Reset) with
 * EnableAutoDepthStencil=TRUE gets an IMPLICIT depth-stencil surface that
 * IDirect3DDevice9::GetDepthStencilSurface returns. Games retrieve it (e.g. to
 * Release it during a mode-switch teardown) and assume it is non-NULL — without
 * it GetDepthStencilSurface returns 0 and the game's teardown loop calls Release
 * on a NULL pointer → access violation (NFSU's resolution-change crash). Creates
 * a surface object identical to CreateDepthStencilSurface and binds it as the
 * device's current depth-stencil.
 */
function bindAutoDepthStencil(device: D3D9Device, devicePtr: number, mem: Uint8Array, pPresentationParameters: number): void {
    if (!pPresentationParameters) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const enableAutoDS = view.getUint32(pPresentationParameters + PP_ENABLE_AUTO_DEPTHSTENCIL, true);
    releaseSurfaceSlot(devicePtr, 'ds');
    if (!enableAutoDS) {
        // No implicit DS — clear any stale binding so Get returns NULL faithfully.
        deviceBoundDepthStencil.delete(devicePtr);
        return;
    }
    const vtableAddr = getVTables()['IDirect3DSurface9']?.address;
    if (!vtableAddr) {
        Logger.error(LogCategory.D3D9, 'auto depth-stencil: IDirect3DSurface9 vtable not found');
        return;
    }
    const w = Math.max(1, view.getUint32(pPresentationParameters + PP_BACKBUFFER_WIDTH, true) || 800);
    const h = Math.max(1, view.getUint32(pPresentationParameters + PP_BACKBUFFER_HEIGHT, true) || 600);
    const format = view.getUint32(pPresentationParameters + PP_AUTO_DEPTHSTENCIL_FORMAT, true) || D3DFMT_D24S8;

    const surfacePtr = createComObject(vtableAddr);
    resourceToDevice.set(surfacePtr, device);
    surfaceMeta.set(surfacePtr, {
        format,
        type: D3DRTYPE_SURFACE,
        usage: D3DUSAGE_DEPTHSTENCIL,
        pool: D3DPOOL_DEFAULT,
        multiSampleType: 0,
        multiSampleQuality: 0,
        width: w,
        height: h,
    });
    registerComFinalizer(surfacePtr, () => releaseSurfaceMetadata(surfacePtr));
    deviceBoundDepthStencil.set(devicePtr, surfacePtr);
    // The implicit DS is device-owned: its creation reference IS the binding's.
    adoptSurfaceSlot(devicePtr, 'ds', surfacePtr);
    Logger.log(LogCategory.D3D9, `auto depth-stencil ${w}x${h} fmt=${format} -> 0x${surfacePtr.toString(16)} (bound)`);
}

/**
 * The device's implicit backbuffer surface for (iSwapChain, iBackBuffer). Real D3D9
 * hands out the SAME object on every call — `GetRenderTarget(0,&rt)` and
 * `GetBackBuffer(0,0,&bb)` compare equal, and a per-frame Get/Release loop must not
 * mint a fresh guest object each frame. The cache owns one reference, dropped when
 * the device dies or a Reset re-declares the geometry.
 */
function ensureImplicitBackBuffer(devicePtr: number, device: D3D9Device, iSwapChain: number, iBackBuffer: number): number {
    const key = `${iSwapChain >>> 0}:${iBackBuffer >>> 0}`;
    const cached = getDeviceBackBufferSurface(devicePtr, key);
    if (cached) return cached;

    const vtableAddr = getVTables()['IDirect3DSurface9']?.address;
    if (!vtableAddr) {
        Logger.error(LogCategory.D3D9, 'IDirect3DSurface9 vtable not found!');
        return 0;
    }
    const surfacePtr = createComObject(vtableAddr);
    resourceToDevice.set(surfacePtr, device);
    registerImplicitBackbufferMeta(surfacePtr, devicePtr);
    registerComFinalizer(surfacePtr, () => {
        dropDeviceBackBufferSurface(devicePtr, surfacePtr);
        releaseSurfaceMetadata(surfacePtr);
    });
    setDeviceBackBufferSurface(devicePtr, key, surfacePtr);
    return surfacePtr;
}

/** A8R8G8B8 texture bytes (B,G,R,A little-endian) → tightly packed RGBA. */
function bgraToRgba(src: Uint8Array, width: number, height: number, pitch: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        let s = y * pitch;
        let d = y * width * 4;
        for (let x = 0; x < width; x++, s += 4, d += 4) {
            out[d] = src[s + 2];
            out[d + 1] = src[s + 1];
            out[d + 2] = src[s];
            out[d + 3] = src[s + 3];
        }
    }
    return out;
}

export function createDeviceExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const D3D_OK = 0;
    const D3DERR_INVALIDCALL = 0x8876086c;
    const D3DERR_DEVICELOST = 0x88760868;
    const D3DERR_DEVICENOTRESET = 0x88760869;

    // Gamma — SetGammaRamp(iSwapChain, Flags, pRamp); GetGammaRamp(iSwapChain, pRamp).
    // Routed to the shared RAMDAC LUT sink so the D3D9 brightness slider actually works.
    exports['IDirect3DDevice9_SetGammaRamp'] = (_ctx, mem, args) => {
        gammaService.applyFromGuest(mem, args[3]);
        return D3D_OK;
    };
    exports['IDirect3DDevice9_GetGammaRamp'] = (_ctx, mem, args) => {
        gammaService.writeToGuest(mem, args[2]);
        return D3D_OK;
    };

    // Cursor — SetCursorProperties(XHotSpot, YHotSpot, pCursorBitmap). The bitmap contract is
    // strict on real D3D9: A8R8G8B8 only, power-of-two extents, hotspot inside the bitmap, and
    // the extents are checked against the DISPLAY MODE rather than the backbuffer.
    exports['IDirect3DDevice9_SetCursorProperties'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const xHotSpot = args[1] >>> 0;
        const yHotSpot = args[2] >>> 0;
        const pCursorBitmap = args[3] >>> 0;

        if (!devices.has(pDevice) || !pCursorBitmap) return D3DERR_INVALIDCALL;
        const meta = surfaceMeta.get(pCursorBitmap);
        if (!meta || meta.format !== D3DFMT_A8R8G8B8) return D3DERR_INVALIDCALL;
        if ((meta.width & (meta.width - 1)) !== 0 || (meta.height & (meta.height - 1)) !== 0) return D3DERR_INVALIDCALL;
        if (xHotSpot >= meta.width || yHotSpot >= meta.height) return D3DERR_INVALIDCALL;

        const cfg = EmulatorConfig.getInstance().screenResolution;
        if (meta.width > cfg.width || meta.height > cfg.height) return D3DERR_INVALIDCALL;

        // Snapshot the pixels for the host pointer: real D3D does not addref the
        // surface, so the app may release or reuse it as soon as this returns.
        const resolved = resolveSurfaceInfo(pCursorBitmap);
        const pixels = resolved?.device.getTextureLevelPixels(resolved.texturePtr, resolved.level);
        const windowed = resolveBackBufferGeometry(pDevice).windowed;
        setDeviceCursorImage(pDevice, pixels ? {
            width: meta.width,
            height: meta.height,
            // Format is A8R8G8B8 (validated above) = B,G,R,A bytes little-endian.
            pixels: bgraToRgba(pixels.data, meta.width, meta.height, pixels.pitch),
            hotspotX: xHotSpot,
            hotspotY: yHotSpot,
        } : null, windowed);
        Logger.log(LogCategory.D3D9,
            `SetCursorProperties(${meta.width}x${meta.height}, hotspot ${xHotSpot},${yHotSpot}) surface=0x${pCursorBitmap.toString(16)} ` +
            `kind=${isHardwareDeviceCursor(meta.width, meta.height, windowed) ? 'hardware' : 'software'} windowed=${windowed}`);
        return D3D_OK;
    };

    // ShowCursor(bShow) — returns the PREVIOUS visibility. Enabling the device cursor gives
    // the app a pointer even while it keeps the Win32 one hidden (core/device-cursor).
    exports['IDirect3DDevice9_ShowCursor'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        if (!devices.has(pDevice)) return 0;
        return showDeviceCursor(pDevice, !!args[1]) ? 1 : 0;
    };

    // SetCursorPosition(X, Y, Flags) is STDMETHOD_(void, ...) — the guest ignores the return
    // value. D3DCURSOR_IMMEDIATE_UPDATE is moot: our update is always immediate.
    exports['IDirect3DDevice9_SetCursorPosition'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        if (!devices.has(pDevice)) return 0;
        setDeviceCursorPosition(pDevice, args[1] | 0, args[2] | 0);
        return 0;
    };

    // GetRasterStatus(iSwapChain, pRasterStatus) → D3DRASTER_STATUS { BOOL InVBlank; UINT ScanLine }.
    // No real RAMDAC exists here, so sweep a synthetic raster off the guest clock at the mode's
    // refresh rate: a frozen value would spin any app that polls for a vblank edge or waits for
    // the scanline to advance. ScanLine reads 0 whenever the raster is inside the blank.
    const VBLANK_LINES = 45;
    exports['IDirect3DDevice9_GetRasterStatus'] = (_ctx, _mem, args) => {
        const pRasterStatus = args[2] >>> 0;
        if (!devices.has(args[0] >>> 0)) return D3DERR_INVALIDCALL;
        if ((args[1] >>> 0) !== 0 || !pRasterStatus) return D3DERR_INVALIDCALL;

        const cfg = EmulatorConfig.getInstance().screenResolution;
        const visibleLines = Math.max(1, cfg.height >>> 0);
        const totalLines = visibleLines + VBLANK_LINES;
        const framePeriodMs = 1000 / (cfg.refreshRate || 60);
        const phase = (System.getInstance().services.time.nowMs() % framePeriodMs) / framePeriodMs;
        const line = Math.min(totalLines - 1, Math.floor(phase * totalLines));
        const inVBlank = line >= visibleLines;

        const ok =
            Mem.writeUint32(pRasterStatus + 0, inVBlank ? 1 : 0) &&
            Mem.writeUint32(pRasterStatus + 4, inVBlank ? 0 : line);
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_TestCooperativeLevel'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        if (!devices.has(pDevice)) return D3DERR_INVALIDCALL;
        // The documented recovery sequence, driven by the real WebGPU device state:
        // DEVICELOST while there is nothing to reset onto, DEVICENOTRESET once there is.
        // Answering an error before the backend could recreate a device would be worse than
        // the old unconditional D3D_OK — the app would spin in a Reset that cannot succeed.
        switch (deviceCooperativeLevel(pDevice)) {
            case "lost": return D3DERR_DEVICELOST;
            case "notreset": return D3DERR_DEVICENOTRESET;
            default: return D3D_OK;
        }
    };

    exports['IDirect3DDevice9_GetAvailableTextureMem'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        if (!devices.has(pDevice)) return 0;
        // Report a stable non-zero budget to satisfy legacy probes.
        return 256 * 1024 * 1024;
    };

    exports['IDirect3DDevice9_EvictManagedResources'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        return devices.has(pDevice) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D9_CreateDevice'] = async (ctx, mem, args) => {
        const pD3D9 = args[0];
        const Adapter = args[1];
        const DeviceType = args[2];
        const hFocusWindow = args[3];
        const BehaviorFlags = args[4];
        const pPresentationParameters = args[5];
        const ppReturnedDeviceInterface = args[6];

        Logger.log(LogCategory.D3D9, `IDirect3D9_CreateDevice(Adapter=${Adapter}, DeviceType=${DeviceType})`);

        try {
            const system = System.getInstance();
            const process = system.process;
            if (!process || !process.canvas) {
                Logger.error(LogCategory.D3D9, 'CreateDevice: Process or canvas not available');
                return D3DERR_INVALIDCALL;
            }

            // Get or create WebGPU backend
            let backend = system.services.render.getBackend() as WebGPUBackend | null;
            if (!backend || backend.kind !== 'webgpu') {
                backend = new WebGPUBackend();
                await backend.initialize(process.canvas);
                system.services.render.setBackend(backend);
            }

            // Create D3D9Device instance
            const device = new D3D9Device(backend);

            // Establish backbuffer size from present params (single source of truth
            // for resolution: host canvas + viewport + XYZRHW NDC divisor must agree).
            // Mirrors the D3D8 CreateDevice path; without it the device kept its
            // 800x600 default while the canvas was sized elsewhere -> 2D squish.
            if (pPresentationParameters) {
                const ppView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const bbWidth = ppView.getUint32(pPresentationParameters + 0, true);
                const bbHeight = ppView.getUint32(pPresentationParameters + 4, true);
                // D3DPRESENT_PARAMETERS.Windowed @ +32 (d3d9); 0 = fullscreen, i.e. a mode-set.
                const fullscreen = ppView.getUint32(pPresentationParameters + 32, true) === 0;
                Logger.log(LogCategory.D3D9, `CreateDevice backbuffer ${bbWidth}x${bbHeight} fullscreen=${fullscreen}`);
                device.setBackBufferSize(bbWidth, bbHeight, fullscreen);
                // A FULLSCREEN device also puts its window INTO that mode, and engines size
                // themselves from the window they get back (hDeviceWindow @ +28, else the
                // focus window).
                if (fullscreen) {
                    resizeFullscreenWindowToMode(
                        (ppView.getUint32(pPresentationParameters + 28, true) || hFocusWindow) >>> 0,
                        bbWidth, bbHeight, "D3D9 CreateDevice");
                }
                // The swap interval the app asked for. D3DCAPS9.PresentationIntervals
                // advertises IMMEDIATE|ONE|TWO|THREE|FOUR, so Present has to honor it.
                device.setPresentationInterval(
                    ppView.getUint32(pPresentationParameters + PP_PRESENTATION_INTERVAL, true));
                device.setSwapEffect(readD3d9SwapEffect(ppView, pPresentationParameters));
            }

            // Get or create vtables
            const vtables = getVTables();
            
            // Get IDirect3DDevice9 vtable address
            const vtableAddr = vtables['IDirect3DDevice9']?.address;
            if (!vtableAddr) {
                Logger.error(LogCategory.D3D9, 'IDirect3DDevice9 vtable not found!');
                return D3DERR_INVALIDCALL;
            }

            // Create COM object in memory for device
            const devicePtr = createComObject(vtableAddr);
            
            // Store device instance mapped to COM object pointer
            devices.set(devicePtr, device);
            registerLossTrackedDevice(devicePtr);
            deviceToD3D9.set(devicePtr, pD3D9);
            deviceCreationParams.set(devicePtr, {
                adapter: Adapter >>> 0,
                deviceType: DeviceType >>> 0,
                hFocusWindow: hFocusWindow >>> 0,
                behaviorFlags: BehaviorFlags >>> 0,
            });
            // The app's own backbuffer geometry, recorded before anything can query it
            // back out (GetBackBuffer/GetRenderTarget descs, GetDisplayMode).
            recordBackBufferInfo(devicePtr, pPresentationParameters, mem);
            addComRef(pD3D9);
            registerComFinalizer(devicePtr, () => {
                device.releaseComBindings();
                releaseDeviceSurfaceRefs(devicePtr);
                devices.delete(devicePtr);
                forgetLossTrackedDevice(devicePtr);
                releaseComRef(pD3D9);
                deviceToD3D9.delete(devicePtr);
                deviceBoundDepthStencil.delete(devicePtr);
                clearDeviceRenderTargets(devicePtr);
                deviceCreationParams.delete(devicePtr);
                deviceBackBufferInfo.delete(devicePtr);
                releaseDeviceCursor(devicePtr);
            });

            // Bind this device as the active owner of the guest-side setter-shadow trampolines and
            // re-sentinel their shadow tables: a fresh device has a fresh JS state-of-record, so a
            // stale shadow left over from a prior device would wrongly skip a needed set. (Coherence
            // invariant for dispatcher.registerShadowedWriteBufferFunction / writeShadowTrampoline.)
            try {
                const disp = System.getInstance().process?.dispatcher as {
                    setShadowOwner?: (p: number) => void;
                    resetShadow?: (dll: string, fn: string) => void;
                } | undefined;
                disp?.setShadowOwner?.(devicePtr);
                disp?.resetShadow?.('d3d9', 'IDirect3DDevice9_SetRenderState');
                disp?.resetShadow?.('d3d9', 'IDirect3DDevice9_SetSamplerState');
            } catch { /* non-fatal */ }

            // Return device interface pointer
            if (ppReturnedDeviceInterface) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppReturnedDeviceInterface, devicePtr, true);
            }

            // Implicit depth-stencil (EnableAutoDepthStencil) — see bindAutoDepthStencil.
            bindAutoDepthStencil(device, devicePtr, mem, pPresentationParameters);

            Logger.log(LogCategory.D3D9, `Created device at 0x${devicePtr.toString(16)}`);
            return D3D_OK;
        } catch (error) {
            Logger.error(LogCategory.D3D9, `CreateDevice failed: ${error}`);
            return D3DERR_INVALIDCALL;
        }
    };

    exports['IDirect3DDevice9_Reset'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const pPresentationParameters = args[1];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Reset: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        // A Reset while the backend still has no device cannot succeed. Real D3D9 answers
        // D3DERR_DEVICELOST here, which is what keeps a correct app in its poll loop instead
        // of proceeding as if the reset had worked.
        if (!acknowledgeDeviceReset(pDevice)) {
            Logger.warn(LogCategory.D3D9, `Reset refused — no GPU device yet (still recovering)`);
            return D3DERR_DEVICELOST;
        }

        // Reset destroys the implicit depth-stencil, the implicit backbuffer surfaces and
        // every render-target binding, then re-creates the depth-stencil from the new
        // present parameters (when EnableAutoDepthStencil is still set).
        deviceBoundDepthStencil.delete(pDevice);
        releaseDeviceSurfaceRefs(pDevice);
        clearDeviceRenderTargets(pDevice);
        // The device cursor does not survive a Reset either (wined3d_device_reset drops
        // cursor_texture) — the app must re-SetCursorProperties. Dropped before the new
        // present parameters land, so a re-upload sees the new windowed state.
        releaseDeviceCursor(pDevice);
        const hr = device.reset(pPresentationParameters, mem);
        // An in-game resolution switch IS a Reset, and a fullscreen one re-sizes the window
        // to the new mode just as CreateDevice did — an engine that re-creates its render
        // targets from GetClientRect otherwise builds them for the mode it just left.
        if (pPresentationParameters) {
            const ppView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (ppView.getUint32(pPresentationParameters + 32, true) === 0) {
                const hwnd = (ppView.getUint32(pPresentationParameters + 28, true)
                    || deviceCreationParams.get(pDevice)?.hFocusWindow || 0) >>> 0;
                resizeFullscreenWindowToMode(
                    hwnd,
                    ppView.getUint32(pPresentationParameters + 0, true),
                    ppView.getUint32(pPresentationParameters + 4, true),
                    "D3D9 Reset");
            }
        }
        bindAutoDepthStencil(device, pDevice, mem, pPresentationParameters);
        // A Reset re-declares the backbuffer (this is how in-game resolution switchers
        // work), so the recorded geometry must follow it or every later GetDesc /
        // GetDisplayMode answers for the previous mode. The fabricated implicit
        // backbuffer/render-target surfaces cached their extents from the OLD geometry —
        // drop them so the next Get* re-registers against the new one.
        recordBackBufferInfo(pDevice, pPresentationParameters, mem);
        return hr;
    };

    exports['IDirect3DDevice9_SetViewport'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setViewport(args[1], mem);
    };

    exports['IDirect3DDevice9_GetViewport'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        const pViewport = args[1];
        if (!device || !pViewport) return D3DERR_INVALIDCALL;

        const vp = device.getViewport();
        const ok =
            Mem.writeUint32(pViewport + 0, vp.x) &&
            Mem.writeUint32(pViewport + 4, vp.y) &&
            Mem.writeUint32(pViewport + 8, vp.width) &&
            Mem.writeUint32(pViewport + 12, vp.height) &&
            Mem.writeFloat32(pViewport + 16, vp.minZ) &&
            Mem.writeFloat32(pViewport + 20, vp.maxZ);
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetRenderTarget'] = (_ctx, _mem, args) => {
        const devicePtr = args[0] >>> 0;
        const device = devices.get(devicePtr);
        if (!device) return D3DERR_INVALIDCALL;
        const renderTargetIndex = args[1] >>> 0;
        const surfacePtr = args[2] >>> 0;
        if (renderTargetIndex >= D3D9_MAX_RENDER_TARGETS) return D3DERR_INVALIDCALL;
        // Resolve the render-target SURFACE → its parent TEXTURE (GetSurfaceLevel recorded the link
        // in surfaceMeta). A surface with no texture parent (the implicit backbuffer from
        // GetBackBuffer / a NULL restore) → texturePtr 0 = render to the swap-chain.
        if (surfacePtr === 0) {
            if (renderTargetIndex === 0) return D3DERR_INVALIDCALL;
            setDeviceRenderTarget(devicePtr, renderTargetIndex, 0);
            releaseSurfaceSlot(devicePtr, renderTargetSlot(renderTargetIndex));
            Logger.verbose(LogCategory.D3D9, `SetRenderTarget(index=${renderTargetIndex}, surface=NULL)`);
            return D3D_OK;
        }

        const meta = surfaceMeta.get(surfacePtr);
        if (!meta) return D3DERR_INVALIDCALL;
        if ((meta.usage & D3DUSAGE_RENDERTARGET) === 0) return D3DERR_INVALIDCALL;
        if (resourceToDevice.get(surfacePtr) !== device) return D3DERR_INVALIDCALL;
        const texturePtr = meta.texturePtr ?? 0;
        // A cube-face surface carries its face index (GetCubeMapSurface recorded it); -1 = 2D RT.
        const face = meta?.face ?? -1;
        device.noteRtResolve(surfacePtr, true, texturePtr);
        Logger.verboseLazy(LogCategory.D3D9, () => `SetRenderTarget(index=${renderTargetIndex}, surface=0x${surfacePtr.toString(16)} -> tex=0x${texturePtr.toString(16)} face=${face})`);
        if (getDeviceRenderTarget(devicePtr, renderTargetIndex) !== surfacePtr) {
            rebindSurfaceSlot(devicePtr, renderTargetSlot(renderTargetIndex), surfacePtr);
            setDeviceRenderTarget(devicePtr, renderTargetIndex, surfacePtr);
        }
        if (renderTargetIndex === 0) {
            device.setRenderTarget(0, texturePtr >>> 0, face);
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetRenderTarget'] = (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const device = devices.get(devicePtr);
        const renderTargetIndex = args[1] >>> 0;
        const ppRenderTarget = args[2];
        if (!device || !ppRenderTarget) return D3DERR_INVALIDCALL;
        if (renderTargetIndex >= D3D9_MAX_RENDER_TARGETS) return D3DERR_INVALIDCALL;
        // Return the surface currently bound as RT0. Games save this and pass it back
        // to SetRenderTarget (a NULL here becomes a NULL-vtable call in the guest).
        // With no explicit RT bound, hand out a stable implicit-backbuffer surface
        // object (meta carries real geometry but no texturePtr → SetRenderTarget
        // still resolves it to the swap-chain).
        let rt = getDeviceRenderTarget(devicePtr, renderTargetIndex);
        if (!rt && renderTargetIndex === 0) {
            rt = ensureImplicitBackBuffer(devicePtr, device, 0, 0);
            if (!rt) return D3DERR_INVALIDCALL;
            rebindSurfaceSlot(devicePtr, renderTargetSlot(0), rt);
            setDeviceRenderTarget(devicePtr, 0, rt);
        }
        // An index with nothing bound is D3DERR_NOTFOUND, out-param untouched.
        if (!rt) return D3DERR_NOTFOUND;
        const target = surfaceRefTarget(rt);
        addComRef(target);
        if (!Mem.writeUint32(ppRenderTarget, rt)) {
            releaseComRef(target);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_BeginScene'] = (ctx, mem, args) => {
        const pDevice = args[0];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `BeginScene: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'BeginScene');
        device.beginScene();
        return D3D_OK;
    };

    exports['IDirect3DDevice9_EndScene'] = (ctx, mem, args) => {
        const pDevice = args[0];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `EndScene: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'EndScene');
        device.endScene();
        return D3D_OK;
    };

    exports['IDirect3DDevice9_Clear'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Count = args[1];
        const pRects = args[2];
        const Flags = args[3];
        const Color = args[4];
        
        // Bitcast u32 to f32 for the Z parameter
        const zBuffer = new Uint32Array(1);
        zBuffer[0] = args[5];
        const Z = new Float32Array(zBuffer.buffer)[0];
        
        const Stencil = args[6];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Clear: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `Clear(Count=${Count}, Flags=0x${Flags.toString(16)}, Color=0x${Color.toString(16)}, Z=${Z}, Stencil=${Stencil})`);

        // Clear expects ARGB color as single number
        device.clear(Flags, Color, Z, Stencil);
        return D3D_OK;
    };

    // StretchRect(pSourceSurface, pSourceRect, pDestSurface, pDestRect, Filter).
    // The usual shape is an offscreen render target moved into the backbuffer, so a
    // success-only stub silently drops the whole world layer and leaves just the HUD.
    let stretchRectFailures = 0;
    exports['IDirect3DDevice9_StretchRect'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pSrcSurface = args[1] >>> 0;
        const pSrcRect = args[2] >>> 0;
        const pDstSurface = args[3] >>> 0;
        const pDstRect = args[4] >>> 0;
        const filter = args[5] >>> 0;
        if (!device || !pSrcSurface || !pDstSurface || filter > 2) return D3DERR_INVALIDCALL;

        const srcMeta = surfaceMeta.get(pSrcSurface);
        const dstMeta = surfaceMeta.get(pDstSurface);
        if (!srcMeta || !dstMeta) return D3DERR_INVALIDCALL;
        if (resourceToDevice.get(pSrcSurface) !== device || resourceToDevice.get(pDstSurface) !== device) {
            return D3DERR_INVALIDCALL;
        }
        if ((srcMeta.usage & D3DUSAGE_DEPTHSTENCIL) !== 0 ||
            (dstMeta.usage & D3DUSAGE_RENDERTARGET) === 0) {
            return D3DERR_INVALIDCALL;
        }

        const readRect = (ptr: number, width: number, height: number) => {
            const rect = ptr ? {
                left: Mem.readInt32(ptr) ?? 0,
                top: Mem.readInt32(ptr + 4) ?? 0,
                right: Mem.readInt32(ptr + 8) ?? 0,
                bottom: Mem.readInt32(ptr + 12) ?? 0,
            } : { left: 0, top: 0, right: width, bottom: height };
            if (rect.left < 0 || rect.top < 0 || rect.right > width || rect.bottom > height ||
                rect.right <= rect.left || rect.bottom <= rect.top) return null;
            return rect;
        };
        const srcRect = readRect(pSrcRect, srcMeta.width, srcMeta.height);
        const dstRect = readRect(pDstRect, dstMeta.width, dstMeta.height);
        if (!srcRect || !dstRect) return D3DERR_INVALIDCALL;

        const endpoint = (meta: typeof srcMeta) => meta.texturePtr ? {
            texturePtr: meta.texturePtr,
            face: meta.face ?? -1,
            width: meta.width,
            height: meta.height,
        } : null;
        if (device.stretchRect(endpoint(srcMeta), endpoint(dstMeta), srcRect, dstRect, filter === 2)) {
            return D3D_OK;
        }
        if ((stretchRectFailures++ & 0xff) === 0) {
            Logger.warn(LogCategory.D3D9,
                `StretchRect failed src=0x${pSrcSurface.toString(16)}(tex=0x${(srcMeta.texturePtr ?? 0).toString(16)}) ` +
                `dst=0x${pDstSurface.toString(16)}(tex=0x${(dstMeta.texturePtr ?? 0).toString(16)}) filter=${filter}`);
        }
        return D3DERR_INVALIDCALL;
    };

    // ColorFill(pSurface, pRect, color). Two shapes, both real:
    //  - the backbuffer, full rect, nothing recorded yet → a color-only Clear (the clear
    //    applies at render-pass START, so it is only equivalent while nothing is pending);
    //  - an OFFSCREEN surface → the backend fills that texture. This is how an engine that
    //    composes its 2D layer into a render target erases the layer between frames, and
    //    dropping it makes every frame's UI accumulate on top of the last.
    // What is still not expressible is a SUB-RECT of a render target (no scissored fill
    // pipeline); that one is reported, not silently swallowed.
    let colorFillDropped = 0;
    exports['IDirect3DDevice9_ColorFill'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pSurface = args[1] >>> 0;
        const pRect = args[2] >>> 0;
        const color = args[3] >>> 0;
        if (!device || !pSurface) return D3DERR_INVALIDCALL;

        const meta = surfaceMeta.get(pSurface);
        const texturePtr = meta?.texturePtr ?? 0;
        const isBackbuffer = !texturePtr;
        let rect: { left: number; top: number; right: number; bottom: number } | null = null;
        let fullRect = !pRect;
        if (pRect) {
            rect = {
                left: Mem.readInt32(pRect) ?? 0,
                top: Mem.readInt32(pRect + 4) ?? 0,
                right: Mem.readInt32(pRect + 8) ?? 0,
                bottom: Mem.readInt32(pRect + 12) ?? 0,
            };
            const bb = EmulatorConfig.getInstance().screenResolution;
            const width = meta?.width ?? bb.width;
            const height = meta?.height ?? bb.height;
            fullRect = rect.left <= 0 && rect.top <= 0 && rect.right >= width && rect.bottom >= height;
        }

        if (isBackbuffer && fullRect && !device.hasPendingWork()) {
            const D3DCLEAR_TARGET = 1;
            device.clear(D3DCLEAR_TARGET, color, 1, 0);
            return D3D_OK;
        }
        if (!isBackbuffer && device.colorFillSurface(texturePtr, rect, color)) {
            return D3D_OK;
        }
        // Rate-limited by COUNT, not by a once-per-session latch: a latch fires during the
        // load firehose and then never again, which is how a fill that was being dropped
        // every single frame stayed invisible.
        if ((colorFillDropped++ & 0xff) === 0) {
            Logger.warn(LogCategory.D3D9,
                `ColorFill: unsupported target (surface=0x${pSurface.toString(16)}, tex=0x${texturePtr.toString(16)}, ` +
                `backbuffer=${isBackbuffer}, fullRect=${fullRect}, pendingWork=${device.hasPendingWork()}) — ` +
                `fill dropped (${colorFillDropped} so far)`);
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetScissorRect'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pRect = args[1] >>> 0;
        if (!device || !pRect) return D3DERR_INVALIDCALL;
        device.setScissorRect(
            Mem.readInt32(pRect) ?? 0,
            Mem.readInt32(pRect + 4) ?? 0,
            Mem.readInt32(pRect + 8) ?? 0,
            Mem.readInt32(pRect + 12) ?? 0,
        );
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetScissorRect'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pRect = args[1] >>> 0;
        if (!device || !pRect) return D3DERR_INVALIDCALL;
        const r = device.getScissorRect();
        const ok =
            Mem.writeUint32(pRect, r.left >>> 0) &&
            Mem.writeUint32(pRect + 4, r.top >>> 0) &&
            Mem.writeUint32(pRect + 8, r.right >>> 0) &&
            Mem.writeUint32(pRect + 12, r.bottom >>> 0);
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_Present'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pSourceRect = args[1];
        const pDestRect = args[2];
        const hDestWindowOverride = args[3];
        const pDirtyRegion = args[4];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Present: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'Present');
        // Return Promise so dispatcher awaits → guest blocks during throttle wait (no "infinite FPS" spin).
        return device.present();
    };

    exports['IDirect3DDevice9_DrawPrimitive'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const PrimitiveType = args[1];
        const StartVertex = args[2];
        const PrimitiveCount = args[3];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `DrawPrimitive: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `DrawPrimitive(Type=${PrimitiveType}, Start=${StartVertex}, Count=${PrimitiveCount})`);
        device.drawPrimitive(PrimitiveType, StartVertex, PrimitiveCount);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_DrawIndexedPrimitive'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const PrimitiveType = args[1];
        const BaseVertexIndex = args[2];
        const MinVertexIndex = args[3];
        const NumVertices = args[4];
        const startIndex = args[5];
        const primCount = args[6];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `DrawIndexedPrimitive: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `DrawIndexedPrimitive(Type=${PrimitiveType}, Base=${BaseVertexIndex}, Start=${startIndex}, Count=${primCount})`);
        device.drawIndexedPrimitive(PrimitiveType, BaseVertexIndex, MinVertexIndex, NumVertices, startIndex, primCount);
        return D3D_OK;
    };

    // DrawIndexedPrimitiveUP(this, PrimitiveType, MinVertexIndex, NumVertices, PrimitiveCount,
    //                        pIndexData, IndexDataFormat, pVertexStreamZeroData, Stride)
    exports['IDirect3DDevice9_DrawIndexedPrimitiveUP'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        const stride = args[8] >>> 0;
        const pIndexData = args[5] >>> 0;
        const pVertexData = args[7] >>> 0;
        if (!stride || !pIndexData || !pVertexData) return D3DERR_INVALIDCALL;

        const primitiveCount = args[4] >>> 0;
        const numVertices = args[3] >>> 0;
        // A zero-primitive / zero-vertex call is a legal no-op, not an error.
        if (!primitiveCount || !numVertices) return D3D_OK;

        Logger.verbose(LogCategory.D3D9,
            `DrawIndexedPrimitiveUP(Type=${args[1]}, MinVtx=${args[2]}, NumVtx=${numVertices}, Count=${primitiveCount}, Stride=${stride})`);
        device.drawIndexedPrimitiveUP(
            args[1] >>> 0, args[2] >>> 0, numVertices, primitiveCount,
            pIndexData, (args[6] >>> 0) === D3DFMT_INDEX32,
            pVertexData, stride,
        );
        return D3D_OK;
    };

    exports['IDirect3DDevice9_DrawPrimitiveUP'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const PrimitiveType = args[1];
        const PrimitiveCount = args[2];
        const pVertexStreamZeroData = args[3];
        const VertexStreamZeroStride = args[4];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `DrawPrimitiveUP: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `DrawPrimitiveUP(Type=${PrimitiveType}, Count=${PrimitiveCount}, Stride=${VertexStreamZeroStride})`);

        // drawPrimitiveUP expects pointer to vertex data, not array
        device.drawPrimitiveUP(PrimitiveType, PrimitiveCount, pVertexStreamZeroData, VertexStreamZeroStride);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetDeviceCaps'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pCaps = args[1];

        const device = devices.get(pDevice);
        if (!device || !pCaps) {
            Logger.error(LogCategory.D3D9, `GetDeviceCaps: invalid args device=${pDevice} pCaps=0x${(pCaps ?? 0).toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        return writeDeviceCaps9(pCaps) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_GetDirect3D'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const ppD3D9 = args[1];

        const device = devices.get(pDevice);
        if (!device || !ppD3D9) {
            return D3DERR_INVALIDCALL;
        }

        let parentPtr = deviceToD3D9.get(pDevice) ?? 0;
        if (!parentPtr) {
            const vtables = getVTables();
            const d3d9VtableAddr = vtables['IDirect3D9']?.address;
            if (!d3d9VtableAddr) {
                return D3DERR_INVALIDCALL;
            }
            parentPtr = createComObject(d3d9VtableAddr);
            deviceToD3D9.set(pDevice, parentPtr);
        }
        addComRef(parentPtr);
        if (!Mem.writeUint32(ppD3D9, parentPtr)) {
            releaseComRef(parentPtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetDisplayMode'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const _iSwapChain = args[1];
        const pMode = args[2];
        const device = devices.get(pDevice);
        if (!device || !pMode) {
            return D3DERR_INVALIDCALL;
        }

        // A FULLSCREEN device mode-set the display to its own backbuffer, so that is the
        // display mode; a WINDOWED one is a guest of the desktop mode. Answering the
        // bundle's configured resolution either way tells a mode-setting app the screen is
        // a size it is not rendering at.
        const cfg = EmulatorConfig.getInstance().screenResolution;
        const bb = resolveBackBufferGeometry(pDevice);
        const useDeviceMode = !bb.windowed && bb.width > 0 && bb.height > 0;
        const ok =
            Mem.writeUint32(pMode + 0, (useDeviceMode ? bb.width : cfg.width) >>> 0) &&
            Mem.writeUint32(pMode + 4, (useDeviceMode ? bb.height : cfg.height) >>> 0) &&
            Mem.writeUint32(pMode + 8, cfg.refreshRate || 60) &&
            Mem.writeUint32(pMode + 12, useDeviceMode ? bb.format : formatForBpp(cfg.bpp));
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    /**
     * D3DDEVICE_CREATION_PARAMETERS { UINT AdapterOrdinal; D3DDEVTYPE DeviceType;
     * HWND hFocusWindow; DWORD BehaviorFlags; } — a verbatim echo of the CreateDevice
     * arguments. Engines re-read hFocusWindow here to hook/resize their own window and
     * BehaviorFlags to decide whether to run the FFP through hardware vertex processing,
     * so a wrong (or absent) answer silently reconfigures the renderer.
     */
    exports['IDirect3DDevice9_GetCreationParameters'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pParameters = args[1];
        if (!devices.has(pDevice) || !pParameters) return D3DERR_INVALIDCALL;
        // Fallback (device created before the map existed): HAL + adapter 0 +
        // HARDWARE_VERTEXPROCESSING|FPU_PRESERVE (0x42) — a legal combination.
        const p = deviceCreationParams.get(pDevice);
        const ok =
            Mem.writeUint32(pParameters + 0, p?.adapter ?? 0) &&
            Mem.writeUint32(pParameters + 4, p?.deviceType ?? D3DDEVTYPE_HAL) &&
            Mem.writeUint32(pParameters + 8, p?.hFocusWindow ?? 0) &&
            Mem.writeUint32(pParameters + 12, p?.behaviorFlags ?? 0x42);
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // GetBackBuffer(iSwapChain, iBackBuffer, Type, ppBackBuffer) — the ONE implicit
    // backbuffer object for that slot, AddRef'd (see ensureImplicitBackBuffer).
    exports['IDirect3DDevice9_GetBackBuffer'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const iSwapChain = args[1] >>> 0;
        const iBackBuffer = args[2] >>> 0;
        const type = args[3] >>> 0;
        const ppBackBuffer = args[4];

        const device = devices.get(pDevice);
        if (!device || !ppBackBuffer) {
            Logger.error(LogCategory.D3D9, `GetBackBuffer: invalid args device=${pDevice} pp=0x${(ppBackBuffer ?? 0).toString(16)}`);
            return D3DERR_INVALIDCALL;
        }
        // One implicit swap chain; D3DBACKBUFFER_TYPE_MONO is the only legal type.
        if (iSwapChain !== 0 || type !== D3DBACKBUFFER_TYPE_MONO) return D3DERR_INVALIDCALL;

        const surfacePtr = ensureImplicitBackBuffer(pDevice, device, iSwapChain, iBackBuffer);
        if (!surfacePtr) return D3DERR_INVALIDCALL;
        addComRef(surfacePtr);
        if (!Mem.writeUint32(ppBackBuffer, surfacePtr)) {
            releaseComRef(surfacePtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetDepthStencilSurface'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pNewZStencil = args[1] >>> 0;

        const device = devices.get(pDevice);
        if (!device) {
            return D3DERR_INVALIDCALL;
        }

        if (pNewZStencil !== 0) {
            const owner = resourceToDevice.get(pNewZStencil);
            if (owner !== device) {
                Logger.error(LogCategory.D3D9, `SetDepthStencilSurface: surface 0x${pNewZStencil.toString(16)} not owned by device`);
                return D3DERR_INVALIDCALL;
            }
        }

        const previous = deviceBoundDepthStencil.get(pDevice) ?? 0;
        if (previous !== pNewZStencil) {
            rebindSurfaceSlot(pDevice, 'ds', pNewZStencil);
            if (pNewZStencil) deviceBoundDepthStencil.set(pDevice, pNewZStencil);
            else deviceBoundDepthStencil.delete(pDevice);
        }
        Logger.verbose(LogCategory.D3D9, `SetDepthStencilSurface(0x${pNewZStencil.toString(16)})`);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetDepthStencilSurface'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const ppZStencilSurface = args[1];

        const device = devices.get(pDevice);
        if (!device || !ppZStencilSurface) {
            Logger.error(LogCategory.D3D9, `GetDepthStencilSurface: invalid args device=${pDevice} pp=0x${(ppZStencilSurface ?? 0).toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        // No depth-stencil bound is D3DERR_NOTFOUND with the out-param UNTOUCHED. Writing
        // NULL and returning D3D_OK sends `if (SUCCEEDED(hr)) ds->GetDesc(&d);` through a
        // NULL vtable, which on an identity-mapped address space jumps into garbage.
        const bound = deviceBoundDepthStencil.get(pDevice) ?? 0;
        if (!bound) return D3DERR_NOTFOUND;

        const target = surfaceRefTarget(bound);
        addComRef(target);
        if (!Mem.writeUint32(ppZStencilSurface, bound)) {
            releaseComRef(target);
            return D3DERR_INVALIDCALL;
        }

        return D3D_OK;
    };

    return exports;
}
