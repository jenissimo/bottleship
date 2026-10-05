/**
 * D3D8 State methods — SetRenderState, SetTransform, SetVertexShader,
 * SetStreamSource, SetIndices, SetTexture, SetTextureStageState, SetViewport + COM stubs
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import { sanitizeViewport } from '../../backends/webgpu/ddraw/types';
import { addComRef, createComObject, devices, deviceBoundDepthStencil, deviceClipStatus, deviceCreationParams, deviceRenderTargetOverride, deviceWindowed, getVTables, releaseComRef, resourceToDevice, surfaceInfo, textureD3DFormat, isComObjectLive } from './shared-state';
import { bindAutoDepthStencil, invalidateDevicePresentationSurfaces, resizeFullscreenDeviceWindow } from './device-lifecycle';
import { isBitmapTexture } from '../ddraw/com-objects';
import { D3DMaterial7Data, D3DLight7Data } from '../ddraw/d3d/types';
import { gammaService } from '../../core/gamma-service';
import { acknowledgeDeviceReset } from '../../core/gpu/gpu-device-loss-contract';
import {
    isHardwareDeviceCursor, releaseDeviceCursor, setDeviceCursorImage,
    setDeviceCursorPosition, showDeviceCursor,
} from '../../core/device-cursor';
import { decodeSurfaceFormatToRgba8 } from '../../backends/webgpu/shared/texture-formats';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { D3D8_MAX_STREAMS } from '../../backends/webgpu/d3d8/vsd-constants';

const D3D_OK = 0;
const D3DFMT_A8R8G8B8 = 21;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_DEVICELOST = 0x88760868;
const E_NOTIMPL = 0x80004001;

// Render state name lookup for diagnostics
const RS_NAMES: Record<number, string> = {
    7: 'ZENABLE', 8: 'FILLMODE', 9: 'SHADEMODE', 14: 'ZWRITEENABLE',
    15: 'ALPHATESTENABLE', 19: 'SRCBLEND', 20: 'DESTBLEND', 22: 'CULLMODE',
    23: 'ZFUNC', 24: 'ALPHAREF', 25: 'ALPHAFUNC', 26: 'DITHERENABLE',
    27: 'ALPHABLENDENABLE', 28: 'FOGENABLE', 29: 'SPECULARENABLE',
    34: 'FOGCOLOR', 35: 'FOGTABLEMODE', 41: 'COLORKEYENABLE',
    47: 'ZBIAS', 52: 'STENCILENABLE', 60: 'TEXTUREFACTOR',
    137: 'LIGHTING', 139: 'AMBIENT', 140: 'FOGVERTEXMODE',
    141: 'COLORVERTEX', 145: 'DIFFUSEMATERIALSOURCE',
};

const BLEND_NAMES: Record<number, string> = {
    1: 'ZERO', 2: 'ONE', 3: 'SRCCOLOR', 4: 'INVSRCCOLOR',
    5: 'SRCALPHA', 6: 'INVSRCALPHA', 7: 'DESTALPHA', 8: 'INVDESTALPHA',
    9: 'DESTCOLOR', 10: 'INVDESTCOLOR',
};

const TSS_NAMES: Record<number, string> = {
    1: 'COLOROP', 2: 'COLORARG1', 3: 'COLORARG2',
    4: 'ALPHAOP', 5: 'ALPHAARG1', 6: 'ALPHAARG2',
    11: 'TEXCOORDINDEX',
    13: 'ADDRESSU', 14: 'ADDRESSV', 16: 'MINFILTER', 17: 'MAGFILTER', 18: 'MIPFILTER',
};

const TOP_NAMES: Record<number, string> = {
    1: 'DISABLE', 2: 'SELECTARG1', 3: 'SELECTARG2', 4: 'MODULATE',
    5: 'MODULATE2X', 6: 'MODULATE4X', 7: 'ADD', 8: 'ADDSIGNED',
    9: 'ADDSIGNED2X', 10: 'SUBTRACT', 11: 'ADDSMOOTH',
    12: 'BLENDDIFFUSEALPHA', 13: 'BLENDTEXTUREALPHA', 14: 'BLENDFACTORALPHA',
};

const TA_NAMES: Record<number, string> = {
    0: 'DIFFUSE', 1: 'CURRENT', 2: 'TEXTURE', 3: 'TFACTOR',
};

function fmtTSSValue(type: number, value: number): string {
    if (type >= 1 && type <= 4 && type !== 2 && type !== 3) return TOP_NAMES[value] ?? `${value}`;
    if (type === 2 || type === 3 || type === 5 || type === 6) return TA_NAMES[value & 0xF] ?? `0x${value.toString(16)}`;
    return `${value}`;
}

function writeOptionalUint32(ptr: number, value: number): boolean {
    return ptr === 0 || Mem.writeUint32(ptr, value);
}

/** Read `count` vec4f constants from guest memory for state-block journaling. */
function readConstantsForRecording(mem: Uint8Array, dataPtr: number, count: number): Float32Array | null {
    const floatCount = (count >>> 0) * 4;
    if (!dataPtr || dataPtr + floatCount * 4 > mem.byteLength) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const data = new Float32Array(floatCount);
    for (let i = 0; i < floatCount; i++) data[i] = view.getFloat32(dataPtr + i * 4, true);
    return data;
}

function writeRequiredUint32(ptr: number, value: number): boolean {
    return ptr !== 0 && Mem.writeUint32(ptr, value);
}

/**
 * Read a guest D3DLIGHT8 (104 bytes). Shared with the FastPath registration so the
 * struct layout has ONE definition — a divergence here would only ever surface as a
 * wrongly-lit scene.
 */
export function readD3DLight8(view: DataView, pLight: number): D3DLight7Data {
    const light: D3DLight7Data = {
        type: view.getUint32(pLight + 0, true),
        diffuse: {
            r: view.getFloat32(pLight + 4, true),
            g: view.getFloat32(pLight + 8, true),
            b: view.getFloat32(pLight + 12, true),
            a: view.getFloat32(pLight + 16, true),
        },
        specular: {
            r: view.getFloat32(pLight + 20, true),
            g: view.getFloat32(pLight + 24, true),
            b: view.getFloat32(pLight + 28, true),
            a: view.getFloat32(pLight + 32, true),
        },
        ambient: {
            r: view.getFloat32(pLight + 36, true),
            g: view.getFloat32(pLight + 40, true),
            b: view.getFloat32(pLight + 44, true),
            a: view.getFloat32(pLight + 48, true),
        },
        position: {
            x: view.getFloat32(pLight + 52, true),
            y: view.getFloat32(pLight + 56, true),
            z: view.getFloat32(pLight + 60, true),
        },
        direction: {
            x: view.getFloat32(pLight + 64, true),
            y: view.getFloat32(pLight + 68, true),
            z: view.getFloat32(pLight + 72, true),
        },
        range: view.getFloat32(pLight + 76, true),
        falloff: view.getFloat32(pLight + 80, true),
        attenuation0: view.getFloat32(pLight + 84, true),
        attenuation1: view.getFloat32(pLight + 88, true),
        attenuation2: view.getFloat32(pLight + 92, true),
        theta: view.getFloat32(pLight + 96, true),
        phi: view.getFloat32(pLight + 100, true),
    };
    return light;
}

/** One-shot: SetViewport now faithfully rejects a viewport that doesn't fit the active
 *  render target (see the handler below) instead of silently clamping it. That can newly
 *  surface a guest-side assert that expected native's D3DERR_INVALIDCALL here — this flag
 *  makes sure the FIRST occurrence is loud instead of the guest just asserting cold. */
let loggedViewportOverflow = false;

/**
 * The generic COM triple (QueryInterface/AddRef/Release) for every D3D8 interface.
 *
 * Merged with `assignStubsOnce` so a resource that owns its own lifetime — a texture whose
 * Release must free its storage, a sub-surface whose refcount lives on the parent texture —
 * wins regardless of merge order. As a plain `Object.assign` this loop silently replaced
 * four of those with the generic pair whenever it happened to be merged last.
 */
export function createComTripleStubs(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // COM stubs for all D3D8 interfaces
    const comPrefixes = [
        'IDirect3D8', 'IDirect3DDevice8',
        'IDirect3DTexture8', 'IDirect3DSurface8',
        'IDirect3DVertexBuffer8', 'IDirect3DIndexBuffer8',
    ];

    for (const prefix of comPrefixes) {
        // QueryInterface MUST write the interface pointer into *ppvObject (out-param) and AddRef.
        // Returning S_OK without writing it left the caller with a garbage pointer it then derefs.
        // Our D3D8 interfaces are a single fat object, so every accepted IID maps back to `this`.
        exports[`${prefix}_QueryInterface`] = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const ppvObject = args[2] >>> 0;
            if (ppvObject && isValidAddress(mem, ppvObject, 4)) {
                Mem.writeUint32(ppvObject, thisPtr);
                addComRef(thisPtr);
            }
            return D3D_OK;
        };
        exports[`${prefix}_AddRef`] = (_ctx, _mem, args) => {
            const refCount = addComRef(args[0]);
            return refCount ?? 2;
        };
        exports[`${prefix}_Release`] = (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            const refCount = releaseComRef(ptr);
            // Final Release of a device: its cursor dies with it (wined3d_device_uninit_3d
            // drops cursor_texture), so the host must stop being told to draw it.
            if (refCount === 0 && devices.has(ptr)) releaseDeviceCursor(ptr);
            return refCount ?? 1;
        };
    }

    return exports;
}

export function createStateExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['IDirect3DDevice8_SetRenderState'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const state = args[1], value = args[2];
        // BeginStateBlock recording: journal the call, do NOT apply (real D3D8 semantics).
        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'renderState', state, value });
            return D3D_OK;
        }
        Logger.logLazy(LogCategory.SYSTEM, () => {
            const name = RS_NAMES[state] ?? `RS_${state}`;
            let valStr = `${value}`;
            if (state === 19 || state === 20) valStr = BLEND_NAMES[value] ?? valStr;
            if (state === 60) valStr = `0x${(value >>> 0).toString(16)}`;
            return `D3D8 SetRS ${name}=${valStr}`;
        });
        device.setRenderState(state, value);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetRenderState'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (!writeRequiredUint32(args[2], device.getRenderState(args[1]))) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    exports['IDirect3DDevice8_SetTextureStageState'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const stage = args[1], type = args[2], value = args[3];
        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'textureStageState', stage, type, value });
            return D3D_OK;
        }
        Logger.logLazy(LogCategory.SYSTEM, () => {
            const tName = TSS_NAMES[type] ?? `TSS_${type}`;
            return `D3D8 SetTSS stage=${stage} ${tName}=${fmtTSSValue(type, value)}`;
        });
        device.setTextureStageState(stage, type, value);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetTextureStageState'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (!writeRequiredUint32(args[3], device.getTextureStageState(args[1], args[2]))) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    exports['IDirect3DDevice8_SetTransform'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        const pMatrix = args[2];
        const matrix = new Float32Array(16);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < 16; i++) {
            matrix[i] = view.getFloat32(pMatrix + i * 4, true);
        }
        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'transform', state: args[1], matrix });
            return D3D_OK;
        }
        device.setTransform(args[1], matrix);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetTransform'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const m = device.getTransform(args[1]);
        if (m && args[2]) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < 16; i++) {
                view.setFloat32(args[2] + i * 4, m[i], true);
            }
        }
        return D3D_OK;
    };

    // D3D8 quirk: SetVertexShader takes a DWORD that is either FVF token or shader handle.
    // FVF tokens have bit0 cleared. Shader handles are odd values (bit0 set).
    exports['IDirect3DDevice8_SetVertexShader'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        const token = args[1] >>> 0;
        if (device.recordingStateBlock) {
            if ((token & 0x1) !== 0 && !device.shaders.getVsObject(token)) return D3DERR_INVALIDCALL;
            device.recordStateBlock({ op: 'vertexShader', token });
            return D3D_OK;
        }
        if ((token & 0x1) === 0) {
            device.setFVF(token);
        } else {
            const hr = device.setVertexShaderHandle(token);
            if (hr !== D3D_OK) return hr;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetVertexShader'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (!writeOptionalUint32(args[1], device.getActiveVertexToken())) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    // D3D8: SetStreamSource(this, StreamNumber, pStreamData, Stride) — NO OffsetInBytes.
    // Streams 0..15 are first-class (caps.MaxStreams = 16, matching vs_1_1-era HAL parts);
    // multi-stream declarations (D3DVSD_STREAM(n)) source each stream independently.
    exports['IDirect3DDevice8_SetStreamSource'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const streamNumber = args[1] >>> 0;
        const vbPtr = args[2] >>> 0;
        const stride = args[3] >>> 0;

        if (streamNumber >= D3D8_MAX_STREAMS) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 SetStreamSource: stream ${streamNumber} exceeds MaxStreams`);
            return D3DERR_INVALIDCALL;
        }
        if (vbPtr !== 0 && !device.vbData.has(vbPtr)) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 SetStreamSource: unknown VB 0x${vbPtr.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'streamSource', stream: streamNumber, vb: vbPtr, stride });
            return D3D_OK;
        }
        device.setStreamSource(streamNumber, vbPtr, stride);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetStreamSource'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const streamNumber = args[1] >>> 0;
        if (streamNumber >= D3D8_MAX_STREAMS) return D3DERR_INVALIDCALL;
        const src = device.getStreamSource(streamNumber);
        if (!writeOptionalUint32(args[2], src.vb)) return D3DERR_INVALIDCALL;
        if (!writeOptionalUint32(args[3], src.stride)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    // D3D8: SetIndices(this, pIndexData, BaseVertexIndex)
    exports['IDirect3DDevice8_SetIndices'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const ibPtr = args[1] >>> 0;

        if (ibPtr !== 0 && !device.ibData.has(ibPtr)) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 SetIndices: unknown IB 0x${ibPtr.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'indices', ib: ibPtr, baseVertex: args[2] | 0 });
            return D3D_OK;
        }
        device.indexIB = ibPtr;                // IB COM ptr
        device.baseVertexIndex = args[2] | 0;  // D3D8 includes BaseVertexIndex here
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetIndices'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (!writeOptionalUint32(args[1], device.indexIB)) return D3DERR_INVALIDCALL;
        if (!writeOptionalUint32(args[2], device.baseVertexIndex >>> 0)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    exports['IDirect3DDevice8_SetTexture'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        const stage = args[1];
        const texPtr = args[2];

        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'texture', stage, texPtr: texPtr >>> 0 });
            return D3D_OK;
        }

        if (texPtr === 0) {
            Logger.logLazy(LogCategory.SYSTEM, () => `D3D8 SetTexture stage=${stage} NULL`);
            device.setTexture(stage, null, 0);
        } else {
            const surface = device.texSurfaces.get(texPtr);
            Logger.logLazy(LogCategory.SYSTEM, () => {
                const fmt = textureD3DFormat.get(texPtr);
                if (surface && surface.surfaceType === 'bitmap_texture') {
                    return `D3D8 SetTexture stage=${stage} tex=0x${texPtr.toString(16)} ${surface.width}x${surface.height} fmt=${fmt} bpp=${surface.format.bpp} aMask=0x${(surface.format.aMask >>> 0).toString(16)}`;
                }
                return `D3D8 SetTexture stage=${stage} tex=0x${texPtr.toString(16)} fmt=${fmt} surface=${surface ? surface.surfaceType : 'MISSING'}`;
            });
            device.setTexture(stage, surface ?? null, texPtr);
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetTexture'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const stage = args[1] >>> 0;
        const ppTexture = args[2];
        if (!ppTexture) return D3DERR_INVALIDCALL;
        let texPtr = device.getTextureComPtr(stage);
        // Faithful GetTexture must not resurrect a released COM object — the stage
        // handle can outlive the texture if the guest Released it without SetTexture(NULL).
        if (texPtr !== 0 && (!device.texSurfaces.has(texPtr) || !isComObjectLive(texPtr))) {
            device.invalidateTextureComPtr(texPtr);
            texPtr = 0;
        }
        if (!writeOptionalUint32(ppTexture, texPtr)) return D3DERR_INVALIDCALL;
        if (texPtr !== 0) addComRef(texPtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_SetViewport'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        const pVP = args[1] >>> 0;
        if (!pVP || !isValidAddress(mem, pVP, 24)) return D3DERR_INVALIDCALL;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const rt = device.activeRenderTarget;
        const raw = {
            x: view.getUint32(pVP + 0, true),
            y: view.getUint32(pVP + 4, true),
            width: view.getUint32(pVP + 8, true),
            height: view.getUint32(pVP + 12, true),
            minZ: view.getFloat32(pVP + 16, true),
            maxZ: view.getFloat32(pVP + 20, true),
        };

        // Wine dlls/d3d8/device.c:1782-1807 — a viewport that doesn't fit the active
        // render target is D3DERR_INVALIDCALL on real D3D8, not silently clamped onto it
        // (sanitizeViewport below is for internal callers — BeginScene/Reset/render-target
        // switch — that legitimately want a forced-valid viewport, not this guest call).
        if (raw.x > rt.width || raw.width > rt.width - raw.x ||
            raw.y > rt.height || raw.height > rt.height - raw.y) {
            if (!loggedViewportOverflow) {
                loggedViewportOverflow = true;
                Logger.error(LogCategory.SYSTEM,
                    `D3D8 SetViewport(${raw.x},${raw.y} ${raw.width}x${raw.height}) does not fit ` +
                    `render target ${rt.width}x${rt.height} -> D3DERR_INVALIDCALL ` +
                    `(further occurrences of this diagnostic are suppressed)`);
            }
            return D3DERR_INVALIDCALL;
        }

        const vp = sanitizeViewport(raw, rt.width, rt.height);
        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'viewport', vp });
            return D3D_OK;
        }
        device.viewport = vp;
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetViewport'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        const pVP = args[1];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(pVP + 0, device.viewport.x, true);
        view.setUint32(pVP + 4, device.viewport.y, true);
        view.setUint32(pVP + 8, device.viewport.width, true);
        view.setUint32(pVP + 12, device.viewport.height, true);
        view.setFloat32(pVP + 16, device.viewport.minZ ?? 0, true);
        view.setFloat32(pVP + 20, device.viewport.maxZ ?? 1, true);
        return D3D_OK;
    };

    // ---------------------------------------------------------------
    // All remaining device stubs — every vtable slot must have a handler
    // ---------------------------------------------------------------

    // Device info
    exports['IDirect3DDevice8_GetDirect3D'] = (_ctx, mem, args) => {
        // Return a dummy IDirect3D8 pointer — game may need this for caps queries
        const ppD3D8 = args[1];
        if (ppD3D8) {
            const vtables = getVTables();
            const vtableAddr = vtables['IDirect3D8']?.address;
            if (vtableAddr) {
                const d3dPtr = createComObject(vtableAddr);
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppD3D8, d3dPtr, true);
            }
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetCreationParameters'] = (_ctx, mem, args) => {
        const pParams = args[1];
        if (pParams) {
            // Faithful echo of what the game passed to CreateDevice. Fallback (device not in
            // the map, e.g. exotic COM ptr): HARDWARE_VERTEXPROCESSING | FPU_PRESERVE = 0x42.
            // The old hardcode 0x60 was an ILLEGAL combo (HARDWARE|SOFTWARE_VERTEXPROCESSING).
            const params = deviceCreationParams.get(args[0]);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(pParams + 0, params?.adapter ?? 0, true);        // AdapterOrdinal
            view.setUint32(pParams + 4, params?.deviceType ?? 1, true);     // DeviceType (HAL)
            view.setUint32(pParams + 8, params?.hFocusWindow ?? 0, true);   // hFocusWindow
            view.setUint32(pParams + 12, params?.behaviorFlags ?? 0x42, true); // BehaviorFlags
        }
        return D3D_OK;
    };

    // Cursor — the device cursor is the pointer for a game that hides the Win32 one
    // (see core/device-cursor). Validation mirrors wined3d: 2D A8R8G8B8, both extents
    // powers of two, and (d3d8 layer) no larger than the display mode.
    exports['IDirect3DDevice8_SetCursorProperties'] = (_ctx, mem, args) => {
        const pDevice = args[0] >>> 0;
        const xHotSpot = args[1] >>> 0;
        const yHotSpot = args[2] >>> 0;
        const pCursorBitmap = args[3] >>> 0;

        if (!devices.has(pDevice) || !pCursorBitmap) return D3DERR_INVALIDCALL;
        const info = surfaceInfo.get(pCursorBitmap);
        if (!info || info.d3dFormat !== D3DFMT_A8R8G8B8) return D3DERR_INVALIDCALL;

        const surface = info.surface;
        const { width, height } = surface;
        if (!width || !height) return D3DERR_INVALIDCALL;
        if ((width & (width - 1)) !== 0 || (height & (height - 1)) !== 0) return D3DERR_INVALIDCALL;
        const mode = EmulatorConfig.getInstance().screenResolution;
        if (width > mode.width || height > mode.height) return D3DERR_INVALIDCALL;

        // Snapshot the pixels: real D3D does not addref the surface, so the app is free
        // to release or reuse it the moment this returns.
        const rgba = decodeSurfaceFormatToRgba8(mem, surface.surfacePtr, width, height, surface.pitch, surface.format);
        const windowed = deviceWindowed.get(pDevice) ?? false;
        setDeviceCursorImage(pDevice,
            { width, height, pixels: new Uint8Array(rgba), hotspotX: xHotSpot, hotspotY: yHotSpot }, windowed);
        Logger.log(LogCategory.D3D9,
            `D3D8 SetCursorProperties(${width}x${height}, hotspot ${xHotSpot},${yHotSpot}) ` +
            `kind=${isHardwareDeviceCursor(width, height, windowed) ? 'hardware' : 'software'} windowed=${windowed}`);
        return D3D_OK;
    };

    // STDMETHOD_(void, ...) — the guest ignores the return value.
    exports['IDirect3DDevice8_SetCursorPosition'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        if (!devices.has(pDevice)) return 0;
        setDeviceCursorPosition(pDevice, args[1] | 0, args[2] | 0);
        return 0;
    };

    exports['IDirect3DDevice8_ShowCursor'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        if (!devices.has(pDevice)) return 0;
        return showDeviceCursor(pDevice, !!args[1]) ? 1 : 0;
    };

    // Swap chain / reset
    exports['IDirect3DDevice8_CreateAdditionalSwapChain'] = () => D3DERR_INVALIDCALL;
    exports['IDirect3DDevice8_Reset'] = (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        // No GPU device yet: a Reset cannot succeed, and real D3D8 says so rather than
        // pretending — that answer is what keeps the app's poll loop honest.
        if (!acknowledgeDeviceReset(devicePtr)) return D3DERR_DEVICELOST;
        const hr = device.reset(args[1], mem);
        if (hr !== D3D_OK) return hr;
        invalidateDevicePresentationSurfaces(args[0]);
        bindAutoDepthStencil(args[0], mem, args[1]);
        // The device cursor does not survive a Reset (wined3d_device_reset drops
        // cursor_texture) — the app must re-SetCursorProperties.
        releaseDeviceCursor(devicePtr);
        // Match real D3D8: a Reset into fullscreen re-sizes the device window to the new mode
        // so GetClientRect reports the back-buffer size (see resizeFullscreenDeviceWindow).
        const pp = args[1];
        if (pp) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const windowed = view.getUint32(pp + 28, true) !== 0;
            deviceWindowed.set(devicePtr, windowed);
            if (!windowed) {
                resizeFullscreenDeviceWindow(
                    view.getUint32(pp + 24, true) >>> 0,
                    view.getUint32(pp + 0, true) >>> 0,
                    view.getUint32(pp + 4, true) >>> 0,
                );
            }
        }
        return D3D_OK;
    };
    exports['IDirect3DDevice8_GetRasterStatus'] = (_ctx, mem, args) => {
        const pStatus = args[1];
        if (pStatus) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(pStatus + 0, 0, true);   // InVBlank = FALSE
            view.setUint32(pStatus + 4, 0, true);   // ScanLine = 0
        }
        return D3D_OK;
    };

    // Gamma — SetGammaRamp(Flags, pRamp); GetGammaRamp(pRamp). Routed to the shared RAMDAC LUT sink.
    exports['IDirect3DDevice8_SetGammaRamp'] = (_ctx, mem, args) => {
        gammaService.applyFromGuest(mem, args[2]);
        return D3D_OK;
    };
    exports['IDirect3DDevice8_GetGammaRamp'] = (_ctx, mem, args) => {
        gammaService.writeToGuest(mem, args[1]);
        return D3D_OK;
    };

    // Volume/cube textures are not implemented, and D3DCAPS8 says so (caps.ts clears
    // VOLUMEMAP/CUBEMAP). Refuse with the out-param NULLed the way a real Create* does on
    // failure — a caller that ignores the HRESULT then derefs NULL instead of stack garbage.
    exports['IDirect3DDevice8_CreateVolumeTexture'] = (_ctx, _mem, args) => {
        if (args[8]) Mem.writeUint32(args[8], 0);
        return D3DERR_INVALIDCALL;
    };
    exports['IDirect3DDevice8_CreateCubeTexture'] = (_ctx, _mem, args) => {
        if (args[6]) Mem.writeUint32(args[6], 0);
        return D3DERR_INVALIDCALL;
    };

    // Front buffer
    exports['IDirect3DDevice8_GetFrontBuffer'] = async (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pDestSurface = args[1];
        if (!pDestSurface) return D3DERR_INVALIDCALL;
        const destInfo = surfaceInfo.get(pDestSurface);
        if (!destInfo || !isBitmapTexture(destInfo.surface)) return D3DERR_INVALIDCALL;
        return (await device.readRenderTargetToBitmapSurface(destInfo.surface))
            ? D3D_OK
            : D3DERR_INVALIDCALL;
    };

    // Material & lighting
    exports['IDirect3DDevice8_SetMaterial'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pMat = args[1];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const mat: D3DMaterial7Data = {
            diffuse: {
                r: view.getFloat32(pMat + 0, true),
                g: view.getFloat32(pMat + 4, true),
                b: view.getFloat32(pMat + 8, true),
                a: view.getFloat32(pMat + 12, true),
            },
            ambient: {
                r: view.getFloat32(pMat + 16, true),
                g: view.getFloat32(pMat + 20, true),
                b: view.getFloat32(pMat + 24, true),
                a: view.getFloat32(pMat + 28, true),
            },
            specular: {
                r: view.getFloat32(pMat + 32, true),
                g: view.getFloat32(pMat + 36, true),
                b: view.getFloat32(pMat + 40, true),
                a: view.getFloat32(pMat + 44, true),
            },
            emissive: {
                r: view.getFloat32(pMat + 48, true),
                g: view.getFloat32(pMat + 52, true),
                b: view.getFloat32(pMat + 56, true),
                a: view.getFloat32(pMat + 60, true),
            },
            power: view.getFloat32(pMat + 64, true),
        };
        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'material', mat });
            return D3D_OK;
        }
        device.setMaterial(mat);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetMaterial'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pMat = args[1];
        if (pMat) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const mat = device.getFFPLightingState()?.material;
            if (mat) {
                view.setFloat32(pMat + 0, mat.diffuse.r, true);
                view.setFloat32(pMat + 4, mat.diffuse.g, true);
                view.setFloat32(pMat + 8, mat.diffuse.b, true);
                view.setFloat32(pMat + 12, mat.diffuse.a, true);
                view.setFloat32(pMat + 16, mat.ambient.r, true);
                view.setFloat32(pMat + 20, mat.ambient.g, true);
                view.setFloat32(pMat + 24, mat.ambient.b, true);
                view.setFloat32(pMat + 28, mat.ambient.a, true);
                view.setFloat32(pMat + 32, mat.specular.r, true);
                view.setFloat32(pMat + 36, mat.specular.g, true);
                view.setFloat32(pMat + 40, mat.specular.b, true);
                view.setFloat32(pMat + 44, mat.specular.a, true);
                view.setFloat32(pMat + 48, mat.emissive.r, true);
                view.setFloat32(pMat + 52, mat.emissive.g, true);
                view.setFloat32(pMat + 56, mat.emissive.b, true);
                view.setFloat32(pMat + 60, mat.emissive.a, true);
                view.setFloat32(pMat + 64, mat.power, true);
            }
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice8_SetLight'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const index = args[1], pLight = args[2];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const light = readD3DLight8(view, pLight);
        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'light', index, light });
            return D3D_OK;
        }
        device.setLight(index, light);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetLight'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const index = args[1], pLight = args[2];
        if (!pLight) return D3DERR_INVALIDCALL;
        const light = device.getLight(index);
        // Faithful: GetLight on an index that was never Set returns D3DERR_INVALIDCALL
        // (and must NOT leave the caller's D3DLIGHT8 filled with stale stack garbage —
        // the old stub returned D3D_OK without writing, so games read uninitialized
        // light data: wrong type/colors and, worst case, a garbage field used downstream).
        if (!light) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(pLight + 0, light.type >>> 0, true);
        view.setFloat32(pLight + 4, light.diffuse.r, true);
        view.setFloat32(pLight + 8, light.diffuse.g, true);
        view.setFloat32(pLight + 12, light.diffuse.b, true);
        view.setFloat32(pLight + 16, light.diffuse.a, true);
        view.setFloat32(pLight + 20, light.specular.r, true);
        view.setFloat32(pLight + 24, light.specular.g, true);
        view.setFloat32(pLight + 28, light.specular.b, true);
        view.setFloat32(pLight + 32, light.specular.a, true);
        view.setFloat32(pLight + 36, light.ambient.r, true);
        view.setFloat32(pLight + 40, light.ambient.g, true);
        view.setFloat32(pLight + 44, light.ambient.b, true);
        view.setFloat32(pLight + 48, light.ambient.a, true);
        view.setFloat32(pLight + 52, light.position.x, true);
        view.setFloat32(pLight + 56, light.position.y, true);
        view.setFloat32(pLight + 60, light.position.z, true);
        view.setFloat32(pLight + 64, light.direction.x, true);
        view.setFloat32(pLight + 68, light.direction.y, true);
        view.setFloat32(pLight + 72, light.direction.z, true);
        view.setFloat32(pLight + 76, light.range, true);
        view.setFloat32(pLight + 80, light.falloff, true);
        view.setFloat32(pLight + 84, light.attenuation0, true);
        view.setFloat32(pLight + 88, light.attenuation1, true);
        view.setFloat32(pLight + 92, light.attenuation2, true);
        view.setFloat32(pLight + 96, light.theta, true);
        view.setFloat32(pLight + 100, light.phi, true);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_LightEnable'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'lightEnable', index: args[1], enable: !!args[2] });
            return D3D_OK;
        }
        device.lightEnable(args[1], !!args[2]);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetLightEnable'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const enabled = device.isLightEnabled(args[1]);
        if (!writeOptionalUint32(args[2], enabled ? 1 : 0)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    // Clip planes — stored faithfully (Get/Set/state blocks); the FFP raster path
    // does not evaluate them yet (same parity as the D3D9 backend).
    exports['IDirect3DDevice8_SetClipPlane'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pPlane = args[2];
        if (!pPlane) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const plane = new Float32Array(4);
        for (let i = 0; i < 4; i++) plane[i] = view.getFloat32(pPlane + i * 4, true);
        if (device.recordingStateBlock) {
            device.recordStateBlock({ op: 'clipPlane', index: args[1] >>> 0, plane });
            return D3D_OK;
        }
        device.setClipPlane(args[1] >>> 0, plane);
        return D3D_OK;
    };
    exports['IDirect3DDevice8_GetClipPlane'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pPlane = args[2];
        if (!pPlane) return D3DERR_INVALIDCALL;
        const plane = device.getClipPlane(args[1] >>> 0);
        if (!plane) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < 4; i++) view.setFloat32(pPlane + i * 4, plane[i], true);
        return D3D_OK;
    };

    // MultiplyTransform: the given matrix composes BEFORE the current transform
    // (row-vector v' = v·M·T — hierarchical child-then-parent, matches real D3D).
    // Not journaled into state blocks (matches the D3D9 runtime).
    exports['IDirect3DDevice8_MultiplyTransform'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pMatrix = args[2];
        if (!pMatrix) return D3DERR_INVALIDCALL;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const matrix = new Float32Array(16);
        for (let i = 0; i < 16; i++) matrix[i] = view.getFloat32(pMatrix + i * 4, true);
        device.multiplyTransform(args[1], matrix);
        return D3D_OK;
    };

    // Render target
    // SetRenderTarget(pRenderTarget, pNewZStencil) — real retargeting: the adapter's
    // activeRenderTarget switches to the surface, so subsequent draws/clears land in the
    // offscreen RT (whose GPU texture is later sampled when the game binds the parent
    // texture — render-to-texture composite). Semantics per real D3D8:
    //   - pRenderTarget==NULL leaves the color target UNCHANGED (only the DS changes).
    //   - the surface must be RT-capable (D3DUSAGE_RENDERTARGET / CreateRenderTarget /
    //     the back buffer), otherwise D3DERR_INVALIDCALL.
    //   - the viewport resets to the full new target (adapter handles that).
    //   - pNewZStencil==NULL detaches the DS.
    exports['IDirect3DDevice8_SetRenderTarget'] = (_ctx, _mem, args) => {
        const devicePtr = args[0];
        const device = devices.get(devicePtr);
        if (!device) return D3DERR_INVALIDCALL;

        const pRenderTarget = args[1] >>> 0;
        const pZStencil = args[2] >>> 0;

        // Wine dlls/d3d8/device.c:1531-1609 — a depth-stencil smaller than the render
        // target it will be paired with is rejected before either is bound. Resolve the
        // target dims BEFORE the RT switch below: pRenderTarget==0 means the color target
        // is left unchanged, so the check must run against whichever RT is about to be live.
        if (pZStencil !== 0) {
            const dsInfo = surfaceInfo.get(pZStencil);
            if (!dsInfo) return D3DERR_INVALIDCALL;
            const rtDims = pRenderTarget !== 0
                ? (surfaceInfo.get(pRenderTarget)?.surface ?? device.activeRenderTarget)
                : device.activeRenderTarget;
            if (dsInfo.surface.width < rtDims.width || dsInfo.surface.height < rtDims.height) {
                Logger.warn(LogCategory.SYSTEM,
                    `D3D8 SetRenderTarget: depth-stencil 0x${pZStencil.toString(16)} ` +
                    `${dsInfo.surface.width}x${dsInfo.surface.height} is smaller than render ` +
                    `target ${rtDims.width}x${rtDims.height} -> D3DERR_INVALIDCALL`);
                return D3DERR_INVALIDCALL;
            }
        }

        if (pRenderTarget !== 0) {
            const info = surfaceInfo.get(pRenderTarget);
            if (!info) return D3DERR_INVALIDCALL;
            if (info.role === 'backbuffer' || info.surface === device.renderTarget) {
                deviceRenderTargetOverride.delete(devicePtr);
                device.setRenderTargetOverride(null);
                Logger.log(LogCategory.SYSTEM, `D3D8 SetRenderTarget -> back buffer`);
            } else if (info.surface.surfaceType === 'render_surface') {
                deviceRenderTargetOverride.set(devicePtr, pRenderTarget);
                device.setRenderTargetOverride(info.surface);
                Logger.log(LogCategory.SYSTEM,
                    `D3D8 SetRenderTarget -> offscreen 0x${pRenderTarget.toString(16)} ` +
                    `${info.surface.width}x${info.surface.height}` +
                    (info.texturePtr ? ` (tex=0x${info.texturePtr.toString(16)})` : ''));
            } else {
                // Surface without render-target usage (plain texture level / image surface).
                Logger.warn(LogCategory.SYSTEM,
                    `D3D8 SetRenderTarget: surface 0x${pRenderTarget.toString(16)} is not RT-capable -> D3DERR_INVALIDCALL`);
                return D3DERR_INVALIDCALL;
            }
        }

        if (pZStencil === 0) {
            device.depthStencilSurfacePtr = 0;
            deviceBoundDepthStencil.delete(devicePtr);
        } else {
            device.depthStencilSurfacePtr = pZStencil;
            deviceBoundDepthStencil.set(devicePtr, pZStencil);
        }
        return D3D_OK;
    };

    // State blocks (D3D8 uses DWORD tokens, not COM). Begin journals Set* calls
    // WITHOUT applying them; End returns the token; Apply replays; Capture refreshes
    // the recorded entries from current device state.
    exports['IDirect3DDevice8_BeginStateBlock'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const hr = device.beginStateBlock();
        if (hr === D3D_OK) Logger.log(LogCategory.SYSTEM, 'D3D8 BeginStateBlock');
        return hr;
    };
    exports['IDirect3DDevice8_EndStateBlock'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const result = device.endStateBlock();
        if (result.hr !== D3D_OK) return result.hr;
        if (!writeOptionalUint32(args[1], result.token)) return D3DERR_INVALIDCALL;
        Logger.log(LogCategory.SYSTEM, `D3D8 EndStateBlock -> token=${result.token}`);
        return D3D_OK;
    };
    exports['IDirect3DDevice8_ApplyStateBlock'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.applyStateBlock(args[1]);
    };
    exports['IDirect3DDevice8_CaptureStateBlock'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.captureStateBlock(args[1]);
    };
    exports['IDirect3DDevice8_DeleteStateBlock'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.deleteStateBlock(args[1]);
    };
    exports['IDirect3DDevice8_CreateStateBlock'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const result = device.createStateBlock(args[1] >>> 0);
        if (result.hr !== D3D_OK) return result.hr;
        if (!writeOptionalUint32(args[2], result.token)) return D3DERR_INVALIDCALL;
        Logger.log(LogCategory.SYSTEM, `D3D8 CreateStateBlock(type=${args[1]}) -> token=${result.token}`);
        return D3D_OK;
    };

    // Clip status — D3DCLIPSTATUS8 {DWORD ClipUnion; DWORD ClipIntersection;}. Reporting
    // success while leaving the app's struct untouched hands it whatever was on the stack;
    // store what was written and answer with the "nothing clipped / full extents" default
    // until something is. Matches DXVK's D3D9 contract (identical struct in D3D8).
    exports['IDirect3DDevice8_SetClipStatus'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const pClipStatus = args[1];
        if (!devices.has(pDevice) || !pClipStatus) return D3DERR_INVALIDCALL;
        const clipUnion = Mem.readUint32(pClipStatus);
        const clipIntersection = Mem.readUint32(pClipStatus + 4);
        if (clipUnion === null || clipIntersection === null) return D3DERR_INVALIDCALL;
        deviceClipStatus.set(pDevice, { clipUnion, clipIntersection });
        return D3D_OK;
    };
    exports['IDirect3DDevice8_GetClipStatus'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const pClipStatus = args[1];
        if (!devices.has(pDevice) || !pClipStatus) return D3DERR_INVALIDCALL;
        const status = deviceClipStatus.get(pDevice);
        if (!Mem.writeUint32(pClipStatus, status ? status.clipUnion : 0)) return D3DERR_INVALIDCALL;
        if (!Mem.writeUint32(pClipStatus + 4, status ? status.clipIntersection : 0xFFFFFFFF)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    // Validate
    exports['IDirect3DDevice8_ValidateDevice'] = (_ctx, mem, args) => {
        if (!writeOptionalUint32(args[1], 1)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    // Device info
    exports['IDirect3DDevice8_GetInfo'] = () => 0x80004001; // E_NOTIMPL (valid for GetInfo)

    // Palette — palettized (P8/A8P8) texture support. SetPaletteEntries(this, num,
    // pEntries) / SetCurrentTexturePalette(this, num) feed the device's palette store;
    // the draw-time bake decodes bound P8 textures against the current palette.
    exports['IDirect3DDevice8_SetPaletteEntries'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pEntries = args[2];
        if (!pEntries) return D3DERR_INVALIDCALL;
        device.setPaletteEntries(args[1] >>> 0, pEntries, mem);
        return D3D_OK;
    };
    exports['IDirect3DDevice8_GetPaletteEntries'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pEntries = args[2];
        if (!pEntries) return D3DERR_INVALIDCALL;
        return device.getPaletteEntries(args[1] >>> 0, pEntries, mem) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['IDirect3DDevice8_SetCurrentTexturePalette'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        device.setCurrentTexturePalette(args[1] >>> 0);
        return D3D_OK;
    };
    exports['IDirect3DDevice8_GetCurrentTexturePalette'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!writeOptionalUint32(args[1], device ? device.getCurrentTexturePalette() : 0)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    // Vertex processing
    exports['IDirect3DDevice8_ProcessVertices'] = () => D3D_OK;

    // Vertex shaders (D3D8: DWORD handles)
    exports['IDirect3DDevice8_CreateVertexShader'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const result = device.shaders.createVertexShader(args[1], args[2], mem);
        if (args[3]) Mem.writeUint32(args[3], result.handle);
        return result.hr;
    };
    exports['IDirect3DDevice8_DeleteVertexShader'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.deleteVertexShader(args[1]);
    };
    exports['IDirect3DDevice8_SetVertexShaderConstant'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (device.recordingStateBlock) {
            const data = readConstantsForRecording(mem, args[2], args[3]);
            if (!data) return D3DERR_INVALIDCALL;
            device.recordStateBlock({ op: 'vsConstant', start: args[1] >>> 0, data });
            return D3D_OK;
        }
        return device.shaders.setVertexShaderConstant(args[1], args[2], args[3], mem);
    };
    exports['IDirect3DDevice8_GetVertexShaderConstant'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.shaders.getVertexShaderConstant(args[1], args[2], args[3], mem);
    };
    exports['IDirect3DDevice8_GetVertexShaderDeclaration'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const handle = device.getActiveVertexToken();
        if ((handle & 1) === 0) return D3DERR_INVALIDCALL;
        return device.shaders.copyDeclarationToGuest(handle, args[1], mem);
    };
    exports['IDirect3DDevice8_GetVertexShaderFunction'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const handle = device.getActiveVertexToken();
        if ((handle & 1) === 0) return D3DERR_INVALIDCALL;
        const vs = device.shaders.getVsObject(handle);
        return device.shaders.copyFunctionToGuest(vs?.bytecode ?? null, args[1], mem);
    };

    // Pixel shaders (D3D8: DWORD handles)
    exports['IDirect3DDevice8_CreatePixelShader'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const result = device.shaders.createPixelShader(args[1], mem);
        if (args[2]) Mem.writeUint32(args[2], result.handle);
        return result.hr;
    };
    exports['IDirect3DDevice8_SetPixelShader'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (device.recordingStateBlock) {
            const handle = args[1] >>> 0;
            if (handle !== 0 && !device.shaders.getPsObject(handle)) return D3DERR_INVALIDCALL;
            device.recordStateBlock({ op: 'pixelShader', handle });
            return D3D_OK;
        }
        return device.setPixelShader(args[1]);
    };
    exports['IDirect3DDevice8_GetPixelShader'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (!writeOptionalUint32(args[1], device.getPixelShaderHandle())) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };
    exports['IDirect3DDevice8_DeletePixelShader'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.deletePixelShader(args[1]);
    };
    exports['IDirect3DDevice8_SetPixelShaderConstant'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (device.recordingStateBlock) {
            const data = readConstantsForRecording(mem, args[2], args[3]);
            if (!data) return D3DERR_INVALIDCALL;
            device.recordStateBlock({ op: 'psConstant', start: args[1] >>> 0, data });
            return D3D_OK;
        }
        return device.shaders.setPixelShaderConstant(args[1], args[2], args[3], mem);
    };
    exports['IDirect3DDevice8_GetPixelShaderConstant'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.shaders.getPixelShaderConstant(args[1], args[2], args[3], mem);
    };
    exports['IDirect3DDevice8_GetPixelShaderFunction'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const handle = device.getPixelShaderHandle();
        if (handle === 0) return D3DERR_INVALIDCALL;
        const ps = device.shaders.getPsObject(handle);
        return device.shaders.copyFunctionToGuest(ps?.bytecode ?? null, args[1], mem);
    };

    // Patches
    exports['IDirect3DDevice8_DrawRectPatch'] = () => D3D_OK;
    exports['IDirect3DDevice8_DrawTriPatch'] = () => D3D_OK;
    exports['IDirect3DDevice8_DeletePatch'] = () => D3D_OK;

    return exports;
}
