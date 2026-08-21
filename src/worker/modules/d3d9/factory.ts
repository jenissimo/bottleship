/**
 * D3D9 Factory functions
 *
 * Atomic implementation for Direct3D object creation
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { Mem } from '../../core/memory/mem-accessor';
import { writeDeviceCaps9 } from './caps';
import { createComObject, getVTables } from './shared-state';
import {
    checkDxDeviceFormat,
    checkDxDeviceMultiSampleType,
    checkDxDeviceType,
    checkDxDepthStencilMatch,
} from '../../backends/webgpu/shared/dx-format-support';
import { logDxCheckDeviceFormat } from '../../backends/webgpu/shared/dx-format-check-log';
import { writeAdapterIdentifier9 } from '../../backends/webgpu/shared/dx-adapter-identifier';

// D3DFORMAT
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;

const D3DADAPTER_DEFAULT = 0;

type D3D9Mode = {
    width: number;
    height: number;
    refreshRate: number;
    format: number;
};

function getBppForFormat(format: number): number | null {
    switch (format) {
        case D3DFMT_X8R8G8B8:
        case D3DFMT_A8R8G8B8:
            return 32;
        case D3DFMT_R5G6B5:
            return 16;
        default:
            return null;
    }
}

function getFormatForBpp(bpp: number): number {
    return bpp <= 16 ? D3DFMT_R5G6B5 : D3DFMT_X8R8G8B8;
}

function buildModeList(format: number): D3D9Mode[] {
    const bpp = getBppForFormat(format);
    if (bpp === null) return [];

    const emulatorConfig = EmulatorConfig.getInstance();
    const seen = new Set<string>();
    const modes: D3D9Mode[] = [];

    for (const mode of emulatorConfig.supportedResolutions) {
        if (mode.bpp !== bpp) continue;
        if (mode.width < 640 || mode.height < 480) continue;

        const key = `${mode.width}x${mode.height}`;
        if (seen.has(key)) continue;
        seen.add(key);

        modes.push({
            width: mode.width,
            height: mode.height,
            refreshRate: mode.refreshRate || 60,
            format,
        });
    }

    // Keep behavior stable for engines that iterate assuming >1 mode.
    if (modes.length === 0) {
        modes.push(
            { width: 640, height: 480, refreshRate: 60, format },
            { width: 800, height: 600, refreshRate: 60, format },
        );
    } else if (modes.length === 1) {
        const fallback = modes[0].width === 640 && modes[0].height === 480
            ? { width: 800, height: 600, refreshRate: 60, format }
            : { width: 640, height: 480, refreshRate: 60, format };
        modes.push(fallback);
    }

    return modes;
}

function writeDisplayMode(pMode: number, mode: D3D9Mode): boolean {
    return (
        Mem.writeUint32(pMode + 0, mode.width) &&
        Mem.writeUint32(pMode + 4, mode.height) &&
        Mem.writeUint32(pMode + 8, mode.refreshRate) &&
        Mem.writeUint32(pMode + 12, mode.format)
    );
}

export function createFactoryExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const D3D_OK = 0;
    const D3DERR_INVALIDCALL = 0x8876086c;

    exports['IDirect3D9_RegisterSoftwareDevice'] = () => D3D_OK;

    exports['IDirect3D9_GetAdapterCount'] = () => 1;

    exports['IDirect3D9_GetAdapterIdentifier'] = (_ctx, mem, args) => {
        const adapter = args[1];
        const flags = args[2];
        const pIdentifier = args[3];

        if (adapter !== D3DADAPTER_DEFAULT || !pIdentifier) {
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `GetAdapterIdentifier(Adapter=${adapter}, Flags=0x${flags.toString(16)})`);
        return writeAdapterIdentifier9(mem, pIdentifier, flags) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D9_GetAdapterModeCount'] = (_ctx, _mem, args) => {
        const adapter = args[1];
        const format = args[2];

        if (adapter !== D3DADAPTER_DEFAULT) {
            return 0;
        }

        const count = buildModeList(format).length;
        // A game that finds no mode it can use exits before it ever presents, and the
        // format it asked for is the whole story — log the question, not just the answer.
        Logger.log(LogCategory.D3D9, `GetAdapterModeCount(format=${format}) -> ${count}`);
        return count;
    };

    exports['IDirect3D9_EnumAdapterModes'] = (_ctx, _mem, args) => {
        const adapter = args[1];
        const format = args[2];
        const modeIndex = args[3];
        const pMode = args[4];

        if (adapter !== D3DADAPTER_DEFAULT || !pMode) {
            return D3DERR_INVALIDCALL;
        }

        const modes = buildModeList(format);
        const mode = modes[modeIndex];
        if (!mode) {
            Logger.log(LogCategory.D3D9,
                `EnumAdapterModes(format=${format}, index=${modeIndex}) -> INVALIDCALL (${modes.length} mode(s))`);
            return D3DERR_INVALIDCALL;
        }
        Logger.verbose(LogCategory.D3D9,
            `EnumAdapterModes(format=${format}, index=${modeIndex}) -> ${mode.width}x${mode.height}@${mode.refreshRate}`);

        return writeDisplayMode(pMode, mode) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D9_GetAdapterDisplayMode'] = (_ctx, _mem, args) => {
        const adapter = args[1];
        const pMode = args[2];
        if (adapter !== D3DADAPTER_DEFAULT || !pMode) {
            return D3DERR_INVALIDCALL;
        }

        const emulatorConfig = EmulatorConfig.getInstance();
        const mode: D3D9Mode = {
            width: emulatorConfig.screenResolution.width,
            height: emulatorConfig.screenResolution.height,
            refreshRate: emulatorConfig.screenResolution.refreshRate || 60,
            format: getFormatForBpp(emulatorConfig.screenResolution.bpp),
        };

        return writeDisplayMode(pMode, mode) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D9_GetDeviceCaps'] = (_ctx, _mem, args) => {
        const adapter = args[1];
        const _deviceType = args[2];
        const pCaps = args[3];
        if (adapter !== D3DADAPTER_DEFAULT || !pCaps) {
            return D3DERR_INVALIDCALL;
        }

        return writeDeviceCaps9(pCaps) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3D9_CheckDeviceType'] = (_ctx, _mem, args) =>
        checkDxDeviceType(9, args[1], args[2], args[3], args[4], args[5]);
    exports['IDirect3D9_CheckDeviceFormat'] = (_ctx, _mem, args) => {
        const adapterFormat = args[3];
        const usage = args[4];
        const rType = args[5];
        const checkFormat = args[6];
        const hr = checkDxDeviceFormat(9, args[1], args[2], adapterFormat, usage, rType, checkFormat);
        logDxCheckDeviceFormat("D3D9", adapterFormat, usage, rType, checkFormat, hr);
        return hr;
    };
    exports['IDirect3D9_CheckDeviceMultiSampleType'] = (_ctx, _mem, args) => {
        const hr = checkDxDeviceMultiSampleType(9, args[1], args[2], args[3], args[4], args[5]);
        // pQualityLevels (out, optional): we expose a single quality level for NONE.
        const pQualityLevels = args[6] >>> 0;
        if (pQualityLevels) Mem.writeUint32(pQualityLevels, hr === D3D_OK ? 1 : 0);
        return hr;
    };
    exports['IDirect3D9_CheckDepthStencilMatch'] = (_ctx, _mem, args) =>
        checkDxDepthStencilMatch(9, args[1], args[2], args[3], args[4], args[5]);
    // StretchRect-style format conversion: our blit path converts freely; report support.
    exports['IDirect3D9_CheckDeviceFormatConversion'] = () => D3D_OK;
    exports['IDirect3D9_GetAdapterMonitor'] = () => 0x10001;
    exports['DebugSetMute'] = (_ctx, _mem, _args) => 0;

    exports['Direct3DCreate9'] = (ctx, mem, args) => {
        // SDKVersion - unused for now
        const sdkVersion = args[0];

        Logger.log(LogCategory.D3D9, `Direct3DCreate9(SDK=0x${sdkVersion.toString(16)})`);

        try {
            // Get or create vtables
            const vtables = getVTables();
            
            // Get IDirect3D9 vtable address
            const vtableAddr = vtables['IDirect3D9']?.address;
            if (!vtableAddr) {
                Logger.error(LogCategory.D3D9, 'IDirect3D9 vtable not found!');
                return 0; // NULL
            }

            // Create COM object in memory
            const d3dPtr = createComObject(vtableAddr);
            Logger.verbose(LogCategory.D3D9, `Created IDirect3D9 object at 0x${d3dPtr.toString(16)} with vtable 0x${vtableAddr.toString(16)}`);
            return d3dPtr;
        } catch (error) {
            Logger.error(LogCategory.D3D9, `Direct3DCreate9 failed: ${error}`);
            return 0; // NULL
        }
    };

    // Helper functions for other modules (not exported)

    return exports;
}
