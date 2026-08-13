/**
 * D3D8 Factory — Direct3DCreate8 and IDirect3D8 methods.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { WebGPUBackend } from '../../backends/webgpu/webgpu-backend';
import { FFPRenderer } from '../../backends/webgpu/shared';
import { D3D8DeviceAdapter } from '../../backends/webgpu/d3d8/d3d8-device-adapter';
import { getVTables, createComObject, devices, deviceCreationParams, deviceWindowed, resourceToDevice } from './shared-state';
import { bindAutoDepthStencil, resizeFullscreenDeviceWindow } from './device-lifecycle';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import {
    checkD3D8DeviceFormat,
    checkD3D8DeviceMultiSampleType,
    checkD3D8DeviceType,
    checkD3D8DepthStencilMatch,
} from './format-support';
import { Mem } from '../../core/memory/mem-accessor';
import { writeDeviceCaps8 } from './caps';
import { logDxCheckDeviceFormat, setDxCheckFormatVerboseLogging } from '../../backends/webgpu/shared/dx-format-check-log';
import {
    DEFAULT_DEVICE_ID,
    DEFAULT_VENDOR_ID,
    writeAdapterIdentifier8,
} from '../../backends/webgpu/shared/dx-adapter-identifier';
import { registerLossTrackedDevice } from '../../core/gpu/gpu-device-loss-contract';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

// D3DFORMAT (d3d8types.h)
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;

// Display formats a D3D8 HAL adapter reports modes for, in driver-typical order
// (16bpp first, then 32bpp). NetImmerse/Gamebryo (Morrowind launcher) enumerates the
// flat mode list and filters by D3DDISPLAYMODE.Format bit-depth; reporting only 32bpp
// leaves its 16bpp NiTArray empty → uiMaxSize>0 assert. D3D8's EnumAdapterModes (unlike
// D3D9's) has NO Format parameter, so the per-format modes must be flattened into one list.
const D3D8_DISPLAY_FORMATS = [D3DFMT_R5G6B5, D3DFMT_X8R8G8B8];

const bppForD3D8Format = (format: number): number | null => {
    switch (format) {
        case D3DFMT_X8R8G8B8:
        case D3DFMT_A8R8G8B8:
            return 32;
        case D3DFMT_R5G6B5:
            return 16;
        default:
            return null;
    }
};

const d3d8FormatForBpp = (bpp: number): number =>
    bpp <= 16 ? D3DFMT_R5G6B5 : D3DFMT_X8R8G8B8;

type D3D8Mode = { width: number; height: number; refreshRate: number; format: number };

let loggedD3D8AdapterIdentifier = false;

export function createFactoryExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // HRESULT ValidateVertexShader(DWORD* pVertexShader, DWORD* pVertexDecl,
    //   const D3DCAPS8* pCaps, BOOL ReturnError, char** ppErrorString)
    // HRESULT ValidatePixelShader(DWORD* pPixelShader, const D3DCAPS8* pCaps,
    //   BOOL ReturnError, char** ppErrorString)
    //
    // Runtime-side (not driver) shader-bytecode validators exported by d3d8.dll.
    // The real functions parse the token stream against the caps and return D3D_OK
    // when the shader is well-formed. Our shader translator accepts any vs_1_1/ps_1_x
    // stream the game hands to Create*Shader, so from the app's contract the shader is
    // always "valid" here — mirror that by returning D3D_OK. On success the reference
    // runtime leaves no error text, so NULL out the optional out-pointer (games LocalFree
    // it; LocalFree(NULL) is a well-defined no-op) to avoid handing back an uninit pointer.
    const clearErrorString = (ppErrorString: number): void => {
        if (ppErrorString) Mem.writeUint32(ppErrorString, 0);
    };

    exports['ValidateVertexShader'] = (_ctx, _mem, args) => {
        clearErrorString(args[4]);
        return D3D_OK;
    };

    exports['ValidatePixelShader'] = (_ctx, _mem, args) => {
        clearErrorString(args[3]);
        return D3D_OK;
    };

    exports['Direct3DCreate8'] = (ctx, mem, args) => {
        const sdkVersion = args[0];
        Logger.log(LogCategory.SYSTEM, `Direct3DCreate8(SDK=0x${sdkVersion.toString(16)})`);

        try {
            const vtables = getVTables();
            const vtableAddr = vtables['IDirect3D8']?.address;
            if (!vtableAddr) {
                Logger.error(LogCategory.SYSTEM, 'IDirect3D8 vtable not found!');
                return 0;
            }
            const d3dPtr = createComObject(vtableAddr);
            Logger.log(LogCategory.SYSTEM, `Direct3DCreate8 -> 0x${d3dPtr.toString(16)}`);
            return d3dPtr;
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `Direct3DCreate8 failed: ${error}`);
            return 0;
        }
    };

    // IDirect3D8 enumeration methods

    exports['IDirect3D8_GetAdapterCount'] = (_ctx, _mem, _args) => 1;

    exports['IDirect3D8_GetAdapterIdentifier'] = (_ctx, mem, args) => {
        const adapter = args[1];
        const flags = args[2];
        const pIdentifier = args[3];
        if (adapter !== 0 || !pIdentifier) return D3DERR_INVALIDCALL;

        if (!loggedD3D8AdapterIdentifier) {
            loggedD3D8AdapterIdentifier = true;
            Logger.log(
                LogCategory.D3D9,
                `D3D8 GetAdapterIdentifier: VendorId=0x${DEFAULT_VENDOR_ID.toString(16)} ` +
                    `DeviceId=0x${DEFAULT_DEVICE_ID.toString(16)} (GTA3 cache key)`,
            );
        }
        return writeAdapterIdentifier8(mem, pIdentifier, flags) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D8_GetAdapterDisplayMode'] = (_ctx, _mem, args) => {
        const pMode = args[2]; // D3DDISPLAYMODE*
        if (!pMode) return D3DERR_INVALIDCALL;

        const cfg = EmulatorConfig.getInstance().screenResolution;
        const width = cfg.width || 800;
        const height = cfg.height || 600;
        const refreshRate = cfg.refreshRate || 60;

        const ok =
            Mem.writeUint32(pMode + 0, width) &&
            Mem.writeUint32(pMode + 4, height) &&
            Mem.writeUint32(pMode + 8, refreshRate) &&
            Mem.writeUint32(pMode + 12, d3d8FormatForBpp(cfg.bpp));
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D8_GetDeviceCaps'] = (_ctx, mem, args) => {
        const pCaps = args[3]; // D3DCAPS8*
        return writeDeviceCaps8(pCaps, mem) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D8_CheckDeviceType'] = (_ctx, _mem, args) =>
        checkD3D8DeviceType(args[1], args[2], args[3], args[4], args[5]);
    exports['IDirect3D8_CheckDeviceFormat'] = (_ctx, _mem, args) => {
        const adapterFormat = args[3];
        const usage = args[4];
        const rType = args[5];
        const checkFormat = args[6];
        const hr = checkD3D8DeviceFormat(args[1], args[2], adapterFormat, usage, rType, checkFormat);
        logDxCheckDeviceFormat("D3D8", adapterFormat, usage, rType, checkFormat, hr);
        return hr;
    };
    exports['IDirect3D8_CheckDeviceMultiSampleType'] = (_ctx, _mem, args) =>
        checkD3D8DeviceMultiSampleType(args[1], args[2], args[3], args[4], args[5]);
    exports['IDirect3D8_CheckDepthStencilMatch'] = (_ctx, _mem, args) =>
        checkD3D8DepthStencilMatch(args[1], args[2], args[3], args[4], args[5]);
    // Build the flat D3D8 adapter-mode list from EmulatorConfig.supportedResolutions
    // (the same source DDraw EnumDisplayModes uses). D3D8's GetAdapterModeCount/
    // EnumAdapterModes have no Format parameter, so every supported display format's
    // modes are concatenated into one list and the app filters by Format.
    // Each format gets ≥2 modes — NetImmerse (and similar engines) iterate with
    // modes[i+1] comparisons and OOB-crash on a single-entry array per bit depth.
    const buildModesForFormat = (format: number): D3D8Mode[] => {
        const bpp = bppForD3D8Format(format);
        if (bpp === null) return [];

        const emulatorConfig = EmulatorConfig.getInstance();
        const seen = new Set<string>();
        const modes: D3D8Mode[] = [];
        for (const m of emulatorConfig.supportedResolutions) {
            if (m.bpp !== bpp) continue;
            if (m.width < 640 || m.height < 480) continue;
            const refreshRate = m.refreshRate || 60;
            const key = `${m.width}x${m.height}@${refreshRate}`;
            if (seen.has(key)) continue;
            seen.add(key);
            modes.push({ width: m.width, height: m.height, refreshRate, format });
        }
        // Guarantee ≥2 modes per format (game OOB-crashes with only 1).
        if (modes.length === 0) {
            modes.push(
                { width: 640, height: 480, refreshRate: 60, format },
                { width: 800, height: 600, refreshRate: 60, format },
            );
        } else if (modes.length === 1) {
            const only = modes[0];
            const fallback = only.width === 640 && only.height === 480
                ? { width: 800, height: 600, refreshRate: 60, format }
                : { width: 640, height: 480, refreshRate: 60, format };
            modes.push(fallback);
        }
        return modes;
    };

    const getD3D8Modes = (): D3D8Mode[] =>
        D3D8_DISPLAY_FORMATS.flatMap(buildModesForFormat);

    exports['IDirect3D8_GetAdapterModeCount'] = () => getD3D8Modes().length;
    exports['IDirect3D8_RegisterSoftwareDevice'] = () => D3D_OK;
    exports['IDirect3D8_GetAdapterMonitor'] = () => 0x10001;

    exports['IDirect3D8_EnumAdapterModes'] = (_ctx, _mem, args) => {
        const modeIdx = args[2];
        const pMode = args[3];
        if (!pMode) return D3DERR_INVALIDCALL;

        const modes = getD3D8Modes();
        const mode = modes[modeIdx] ?? modes[modes.length - 1];

        const ok =
            Mem.writeUint32(pMode + 0, mode.width) &&
            Mem.writeUint32(pMode + 4, mode.height) &&
            Mem.writeUint32(pMode + 8, mode.refreshRate || 60) &&
            Mem.writeUint32(pMode + 12, mode.format);
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // CreateDevice — the big one
    exports['IDirect3D8_CreateDevice'] = async (_ctx, mem, args) => {
        const pD3D8 = args[0];
        const Adapter = args[1];
        const DeviceType = args[2];
        const hFocusWindow = args[3];
        const BehaviorFlags = args[4];
        const pPresParams = args[5];
        const ppDevice = args[6];

        Logger.log(LogCategory.SYSTEM, `IDirect3D8_CreateDevice(Adapter=${Adapter}, Type=${DeviceType}, Flags=0x${BehaviorFlags.toString(16)})`);

        try {
            const system = System.getInstance();
            const process = system.process;
            if (!process || !process.canvas) {
                Logger.error(LogCategory.SYSTEM, 'D3D8 CreateDevice: no process/canvas');
                return D3DERR_INVALIDCALL;
            }

            // Read presentation parameters
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const bbWidth = view.getUint32(pPresParams + 0, true) || 800;
            const bbHeight = view.getUint32(pPresParams + 4, true) || 600;

            const enableAutoDepthStencil = view.getUint32(pPresParams + 32, true);
            const autoDepthStencilFormat = view.getUint32(pPresParams + 36, true);
            Logger.log(LogCategory.SYSTEM, `D3D8 CreateDevice: ${bbWidth}x${bbHeight} depthStencil=${enableAutoDepthStencil} fmt=${autoDepthStencilFormat}`);

            // Get or create WebGPU backend
            let backend = system.services.render.getBackend() as WebGPUBackend | null;
            if (!backend || backend.kind !== 'webgpu') {
                backend = new WebGPUBackend();
                await backend.initialize(process.canvas);
                system.services.render.setBackend(backend);
            }

            // Get or create FFP renderer (shared with DDraw)
            let renderer: InstanceType<typeof FFPRenderer>;
            const ddrawModule = process.getModule?.("ddraw") as any;
            const existingExecutor = ddrawModule?.context?.executor;
            if (existingExecutor) {
                renderer = existingExecutor;
                Logger.log(LogCategory.SYSTEM, 'D3D8: sharing DDraw executor');
            } else {
                renderer = new FFPRenderer(backend);
                Logger.log(LogCategory.SYSTEM, 'D3D8: created new FFPRenderer');
            }

            // Create D3D8 device adapter
            const device = new D3D8DeviceAdapter(renderer, bbWidth, bbHeight, backend);

            // Honor the requested back-buffer MSAA (D3DPRESENT_PARAMETERS.MultiSampleType @ +16):
            // fold it into the executor's effective sample count so in-engine AA works.
            device.applyPresentMultiSampleType(view.getUint32(pPresParams + 16, true));

            // The swap interval the app asked for (FullScreen_PresentationInterval @ +48).
            // D3DCAPS8.PresentationIntervals advertises IMMEDIATE|ONE, so Present must honor it.
            device.setPresentationInterval(view.getUint32(pPresParams + 48, true));

            // Resize canvas to match backbuffer (like DDraw SetDisplayMode does). Only a
            // FULLSCREEN device is a mode-set — a windowed backbuffer lives inside the
            // desktop and must not become SM_CXSCREEN. (Windowed @ +28 in d3d8.)
            system.requestHostResize(bbWidth, bbHeight, {
                modeSet: view.getUint32(pPresParams + 28, true) === 0,
            });

            // FULLSCREEN device: also resize the focus/device window's tracked client rect to
            // the back-buffer size, like real D3D8 does. Apps GetClientRect() the now-fullscreen
            // window and size their render targets to it (GTA III's RenderWare camera raster
            // requires clientRect >= cameraSize, else CreateCamera fails -> startup exit).
            // See resizeFullscreenDeviceWindow() for the full rationale.
            const windowedFlag = view.getUint32(pPresParams + 28, true);
            if (!windowedFlag) {
                const hDeviceWindow = view.getUint32(pPresParams + 24, true) || hFocusWindow;
                resizeFullscreenDeviceWindow(hDeviceWindow >>> 0, bbWidth, bbHeight);
            }

            // Create COM object
            const vtables = getVTables();
            const vtableAddr = vtables['IDirect3DDevice8']?.address;
            if (!vtableAddr) {
                Logger.error(LogCategory.SYSTEM, 'IDirect3DDevice8 vtable not found!');
                return D3DERR_INVALIDCALL;
            }

            const devicePtr = createComObject(vtableAddr);
            devices.set(devicePtr, device);
            registerLossTrackedDevice(devicePtr);
            // The cursor kind depends on it, and a device that never Resets would otherwise
            // be read as fullscreen.
            deviceWindowed.set(devicePtr, !!windowedFlag);
            // Remembered for GetCreationParameters (faithful echo of the game's own flags).
            deviceCreationParams.set(devicePtr, {
                adapter: Adapter,
                deviceType: DeviceType,
                hFocusWindow,
                behaviorFlags: BehaviorFlags,
            });

            if (ppDevice) {
                view.setUint32(ppDevice, devicePtr, true);
            }

            bindAutoDepthStencil(devicePtr, mem, pPresParams);

            // Console API: d3d8DiagDraws(N) logs N draw calls with texture/filter/vertex info
            (globalThis as any).d3d8DiagDraws = (n: number) => device.enableDrawDiag(n);
            (globalThis as any).d3d8LogCheckFormat = (on = true) => setDxCheckFormatVerboseLogging(!!on);

            Logger.log(LogCategory.SYSTEM, `D3D8 CreateDevice -> 0x${devicePtr.toString(16)}`);
            Logger.log(LogCategory.SYSTEM, `[D3D8] Console API: d3d8DiagDraws(N) — log N draw calls; d3d8LogCheckFormat(true) — verbose CheckDeviceFormat`);
            return D3D_OK;
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `D3D8 CreateDevice failed: ${error}`);
            return D3DERR_INVALIDCALL;
        }
    };

    return exports;
}
