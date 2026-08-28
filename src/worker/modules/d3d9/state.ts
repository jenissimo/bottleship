/**
 * D3D9 State functions
 *
 * Atomic implementation for Direct3D state operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import {
    addComRef,
    deviceClipStatus,
    devices,
    getComRefCount,
    getVTables,
    createComObject,
    registerDeviceChildFinalizer,
    releaseComRef,
    stateBlocks,
} from './shared-state';
import { surfaceMeta, textureMeta, vertexBufferMeta } from './resource-registry';
import {
    beginStateBlockShadowWindow, endStateBlockShadowWindow,
} from './state-block-shadow-window';
import { stubRegistry } from '../../core/diagnostics/stub-registry';
import { RawVertexElement } from '../../backends/webgpu/d3d9/shader';
import { fvfToRawElements } from '../../backends/webgpu/d3d9/swvp';
import { D3D9_FFP_STAGE_COUNT, isD3D9TextureStage } from '../../backends/webgpu/d3d9/d3d9-state-tracker';
import type { D3D9StateBlockData } from '../../backends/webgpu/d3d9/d3d9-state-block';
import {
    classifyStateBlockCoverage,
    disposeStateBlockData,
    retainStateBlockRefs,
    tryAttachWasmBlockSlot,
} from '../../backends/webgpu/d3d9/d3d9-state-block';
import { d3d9PerfStateBlockCreated } from './d3d9-perf';
import {
    vertexDeclComObjects,
    vertexShaderComObjects,
    pixelShaderComObjects,
    resolveVertexDeclComPtr,
    resolveVertexShaderComPtr,
    resolvePixelShaderComPtr,
} from '../../backends/webgpu/d3d9/d3d9-com-objects';
import {
    E_NOINTERFACE,
    d3d9ObjectSupportsIid,
} from './object-contracts';

/**
 * A texture level / cube face surface has no refcount of its own: real D3D9 keeps
 * the parent texture's, and a Release through the surface is what frees the
 * texture. Every AddRef/Release/QueryInterface on a Surface9 therefore lands on
 * the parent when there is one.
 */
export function addD3D9ComRef(prefix: string, ptr: number): number {
    const pObject = ptr >>> 0;
    if (!pObject) return 0;
    if (prefix === 'IDirect3DSurface9') {
        const parentTexture = surfaceMeta.get(pObject)?.texturePtr ?? 0;
        if (parentTexture) return addComRef(parentTexture) ?? 0;
    }
    return addComRef(pObject) ?? 0;
}

export function releaseD3D9ComRef(prefix: string, ptr: number): number {
    const pObject = ptr >>> 0;
    if (!pObject) return 0;
    if (prefix === 'IDirect3DSurface9') {
        const parentTexture = surfaceMeta.get(pObject)?.texturePtr ?? 0;
        if (parentTexture) return releaseComRef(parentTexture) ?? 0;
    }
    return releaseComRef(pObject) ?? 0;
}

export function createStateExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const recordingDevices = new Set<number>();

    const D3D_OK = 0;
    const D3DERR_INVALIDCALL = 0x8876086c;
    const D3DERR_NOTAVAILABLE = 0x8876086a;
    const D3DERR_INBEGINSTATEBLOCK = 0x88760825;
    const D3DERR_NOTINBEGINSTATEBLOCK = 0x88760826;
    const E_POINTER = 0x80004003;
    const D3DMATERIAL9_SIZE = 68;
    const D3DLIGHT9_SIZE = 104;
    const D3DDECLTYPE_UNUSED = 17;
    const VS_FLOAT_REGISTER_COUNT = 256;
    const SWVP_FLOAT_REGISTER_COUNT = 8192;
    const SWVP_INTEGER_REGISTER_COUNT = 2048;
    const SWVP_BOOLEAN_REGISTER_COUNT = 2048;
    const PS_FLOAT_REGISTER_COUNT = 224;
    const normalizeStateBlockHr = (hr: number): number =>
        hr === D3DERR_INBEGINSTATEBLOCK || hr === D3DERR_NOTINBEGINSTATEBLOCK
            ? D3DERR_INVALIDCALL : hr;

    function createStateBlockComObject(devicePtr: number, data: D3D9StateBlockData): number | null {
        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DStateBlock9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DStateBlock9 vtable not found');
            return null;
        }
        const sbPtr = createComObject(vtableAddr);
        data.devicePtr = devicePtr;
        const coverage = classifyStateBlockCoverage(data.entries);
        data.coverable = coverage.coverable;
        tryAttachWasmBlockSlot(data); // may downgrade coverable on unrepresentable entries
        retainStateBlockRefs(data);
        d3d9PerfStateBlockCreated(
            data.blockType,
            data.entries.length,
            coverage.coverable,
            coverage.opCounts,
            coverage.vsConstRanges,
            coverage.psConstRanges,
        );
        stateBlocks.set(sbPtr, data);
        registerDeviceChildFinalizer(sbPtr, devicePtr, () => {
            disposeStateBlockData(data);
            stateBlocks.delete(sbPtr);
        });
        return sbPtr;
    }

    function writeComPtrOut(ppOut: number, ptr: number, mem: Uint8Array): boolean {
        if (!ppOut) return false;
        return Mem.writeUint32(ppOut, ptr);
    }

    const writeStateBlockOut = writeComPtrOut;

    function writeVertexElements(pElement: number, elements: RawVertexElement[], mem: Uint8Array): boolean {
        if (!pElement) return false;
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let ptr = pElement;
        for (const e of elements) {
            dv.setUint16(ptr, e.stream, true);
            dv.setUint16(ptr + 2, e.offset, true);
            dv.setUint8(ptr + 4, e.type);
            dv.setUint8(ptr + 5, 0); // method
            dv.setUint8(ptr + 6, e.usage);
            dv.setUint8(ptr + 7, e.usageIndex);
            ptr += 8;
        }
        // D3DDECL_END: {0xFF, 0, D3DDECLTYPE_UNUSED, 0, 0, 0}. Type is the documented
        // termination test, so it must be UNUSED (17) and not a valid type id (0 = FLOAT1).
        dv.setUint16(ptr, 0xff, true);
        dv.setUint16(ptr + 2, 0, true);
        dv.setUint8(ptr + 4, D3DDECLTYPE_UNUSED);
        dv.setUint8(ptr + 5, 0);
        dv.setUint8(ptr + 6, 0);
        dv.setUint8(ptr + 7, 0);
        return true;
    }

    exports['IDirect3DDevice9_SetRenderState'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const State = args[1];
        const Value = args[2];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `SetRenderState: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        // Render-state selectors occupy the fixed D3D9 DWORD table.  A selector
        // outside it is dropped, not stored — but the runtime still reports
        // success, and the write-buffer fast path must not answer differently.
        if ((State >>> 0) >= 256) return D3D_OK;

        Logger.verbose(LogCategory.D3D9, `SetRenderState(${State}, 0x${Value.toString(16)})`);
        device.setRenderState(State, Value);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetTransform'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const State = args[1];
        const pMatrix = args[2];

        const device = devices.get(pDevice);
        if (!device || !pMatrix) {
            Logger.error(LogCategory.D3D9, `SetTransform: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `SetTransform(${State})`);

        // Read 4x4 matrix from memory (16 floats)
        const matrix = new Float32Array(16);
        for (let i = 0; i < 16; i++) {
            const value = Mem.readFloat32(pMatrix + i * 4);
            if (value === null) return D3DERR_INVALIDCALL;
            matrix[i] = value;
        }

        return device.setTransform(State, matrix);
    };

    exports['IDirect3DDevice9_GetTransform'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const state = args[1];
        const pMatrix = args[2];

        const device = devices.get(pDevice);
        if (!device || !pMatrix) {
            return D3DERR_INVALIDCALL;
        }

        const matrix = device.getTransform(state);
        if (!matrix || matrix.length < 16) {
            return D3DERR_INVALIDCALL;
        }

        for (let i = 0; i < 16; i++) {
            if (!Mem.writeFloat32(pMatrix + i * 4, matrix[i]!)) {
                return D3DERR_INVALIDCALL;
            }
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_MultiplyTransform'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        const pMatrix = args[2] >>> 0;
        if (!device || !pMatrix) return D3DERR_INVALIDCALL;
        const matrix = new Float32Array(16);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        try {
            for (let i = 0; i < 16; i++) matrix[i] = view.getFloat32(pMatrix + i * 4, true);
        } catch {
            return D3DERR_INVALIDCALL;
        }
        return device.multiplyTransform(args[1] >>> 0, matrix);
    };

    exports['IDirect3DDevice9_SetFVF'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const FVF = args[1];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `SetFVF: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `SetFVF(0x${FVF.toString(16)})`);
        device.setFVF(FVF);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetFVF'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pFVF = args[1] >>> 0;
        if (!device || !pFVF) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(pFVF, device.getFVF() >>> 0) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetSoftwareVertexProcessing'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setSoftwareVertexProcessing((args[1] >>> 0) !== 0);
    };

    exports['IDirect3DDevice9_GetSoftwareVertexProcessing'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pEnabled = args[1] >>> 0;
        if (!device || !pEnabled) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(pEnabled, device.getSoftwareVertexProcessing() ? 1 : 0)
            ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetNPatchMode'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const buffer = new ArrayBuffer(4);
        new DataView(buffer).setUint32(0, args[1] >>> 0, true);
        return device.setNPatchMode(new DataView(buffer).getFloat32(0, true));
    };

    exports['IDirect3DDevice9_GetNPatchMode'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pSegments = args[1] >>> 0;
        if (!device || !pSegments) return D3DERR_INVALIDCALL;
        const buffer = new ArrayBuffer(4);
        new DataView(buffer).setFloat32(0, device.getNPatchMode(), true);
        return Mem.writeUint32(pSegments, new DataView(buffer).getUint32(0, true))
            ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetStreamSource'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const StreamNumber = args[1];
        const pStreamData = args[2];
        const OffsetInBytes = args[3];
        const Stride = args[4];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `SetStreamSource: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `SetStreamSource(Stream=${StreamNumber}, Offset=${OffsetInBytes}, Stride=${Stride})`);
        return device.setStreamSource(StreamNumber, pStreamData, OffsetInBytes, Stride);
    };

    // SetStreamSourceFreq(StreamNumber, Setting) — the hardware-instancing divider. We advertise
    // vs_3_0, which in D3D9 IS the statement that instancing works, so this cannot answer
    // E_NOTIMPL: an engine sets the dividers and draws without ever reading the HRESULT.
    exports['IDirect3DDevice9_SetStreamSourceFreq'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setStreamSourceFreq(args[1] >>> 0, args[2] >>> 0);
    };

    exports['IDirect3DDevice9_GetStreamSourceFreq'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pSetting = args[2];
        if (!device || !pSetting) return D3DERR_INVALIDCALL;
        const setting = device.getStreamSourceFreq(args[1] >>> 0);
        if (setting === null) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(pSetting, setting) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // GetStreamSource(StreamNumber, ppStreamData, pOffsetInBytes, pStride). ppStreamData is
    // mandatory; the other two out-params are optional. Real D3D9 AddRefs the returned buffer —
    // mirror that so callers can hold the returned COM pointer independently.
    exports['IDirect3DDevice9_GetStreamSource'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const ppStreamData = args[2];
        if (!device || !ppStreamData) return D3DERR_INVALIDCALL;

        const binding = device.getStreamBinding(args[1] >>> 0);
        if (!binding) {
            Logger.warn(LogCategory.D3D9, `GetStreamSource: stream ${args[1] >>> 0} out of range`);
            return D3DERR_INVALIDCALL;
        }
        if (!Mem.writeUint32(ppStreamData, binding.ptr)) return D3DERR_INVALIDCALL;
        if (args[3] && !Mem.writeUint32(args[3], binding.offset)) return D3DERR_INVALIDCALL;
        if (args[4] && !Mem.writeUint32(args[4], binding.stride)) return D3DERR_INVALIDCALL;
        if (binding.ptr) addComRef(binding.ptr);
        return D3D_OK;
    };

    // ProcessVertices(SrcStartIndex, DestIndex, VertexCount, pDestBuffer, pVertexDecl, Flags):
    // software T&L of the bound streams into a destination vertex buffer.
    let processVerticesWarned = false;
    exports['IDirect3DDevice9_ProcessVertices'] = (ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pDevice = args[0] >>> 0;
        const pVertexDecl = args[5] >>> 0;
        const pDestBuffer = args[4] >>> 0;
        if (!device || !pDestBuffer || !vertexBufferMeta.has(pDestBuffer)) return D3DERR_INVALIDCALL;
        if ((args[3] >>> 0) === 0) return D3D_OK;

        // D3D9 uses the destination vertex buffer's FVF when pVertexDecl is NULL,
        // except for a vs_3_0+ programmable vertex shader, which requires an explicit
        // output declaration. Resolve that legacy path instead of rejecting every FVF VB.
        let destElements: RawVertexElement[];
        if (!pVertexDecl) {
            const activeVs = (device as { getActiveVsShader?: () => { prog?: { major?: number } } | null }).getActiveVsShader?.();
            if ((activeVs?.prog?.major ?? 0) >= 3) return D3DERR_INVALIDCALL;
            const fvf = vertexBufferMeta.get(pDestBuffer)?.fvf ?? 0;
            const fvfElements = fvfToRawElements(fvf);
            if (!fvfElements) return D3DERR_NOTAVAILABLE;
            destElements = fvfElements;
        } else {
            const decl = resolveVertexDeclComPtr(pVertexDecl);
            if (!decl || decl.devicePtr !== pDevice) return D3DERR_INVALIDCALL;
            destElements = decl.elements;
        }

        const process = (device as { processVertices?: (...a: unknown[]) => number }).processVertices;
        if (typeof process !== 'function') {
            if (!processVerticesWarned) {
                processVerticesWarned = true;
                Logger.error(LogCategory.D3D9,
                    'ProcessVertices: no CPU vertex pipeline — destination buffer left untouched');
            }
            stubRegistry.record('d3d9', 'IDirect3DDevice9_ProcessVertices', 0,
                (Mem.readUint32(ctx.esp) ?? 0) >>> 0);
            return D3DERR_NOTAVAILABLE;
        }
        return process.call(device,
            args[1] >>> 0, args[2] >>> 0, args[3] >>> 0,
            pDestBuffer, destElements, args[6] >>> 0);
    };

    exports['IDirect3DDevice9_SetIndices'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pIndexData = args[1];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `SetIndices: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `SetIndices(0x${pIndexData.toString(16)})`);
        return device.setIndices(pIndexData);
    };

    exports['IDirect3DDevice9_SetTexture'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Stage = args[1];
        const pTexture = args[2];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `SetTexture: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `SetTexture(Stage=${Stage}, Texture=0x${pTexture.toString(16)})`);
        return device.setTexture(Stage, pTexture);
    };

    // GetTexture(Stage, ppTexture) / GetIndices(ppIndexData): the bound resource,
    // AddRef'd, or NULL + S_OK when the slot is empty. Left unimplemented these
    // returned 0 (== S_OK) without touching the out-param, so the caller read an
    // uninitialised local as an interface pointer.
    exports['IDirect3DDevice9_GetTexture'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        const stage = args[1] >>> 0;
        const ppTexture = args[2];
        if (!device || !ppTexture || !isD3D9TextureStage(stage)) return D3DERR_INVALIDCALL;
        const texPtr = device.getBoundTexturePtr(stage) >>> 0;
        if (!writeComPtrOut(ppTexture, texPtr, mem)) return D3DERR_INVALIDCALL;
        if (texPtr) addComRef(texPtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetIndices'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        const ppIndexData = args[1];
        if (!device || !ppIndexData) return D3DERR_INVALIDCALL;
        const ibPtr = device.getBoundIndexBufferPtr() >>> 0;
        if (!writeComPtrOut(ppIndexData, ibPtr, mem)) return D3DERR_INVALIDCALL;
        if (ibPtr) addComRef(ibPtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetRenderState'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const state = args[1];
        const pValue = args[2];

        const device = devices.get(pDevice);
        if (!device || !pValue) return D3DERR_INVALIDCALL;

        return Mem.writeUint32(pValue, device.getRenderState(state)) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetTextureStageState'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const stage = args[1];
        const type = args[2];
        const value = args[3];

        const device = devices.get(pDevice);
        if (!device || !Number.isInteger(stage) || stage < 0 || stage >= D3D9_FFP_STAGE_COUNT) return D3DERR_INVALIDCALL;

        return device.setTextureStageState(stage, type, value);
    };

    exports['IDirect3DDevice9_GetTextureStageState'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const stage = args[1];
        const type = args[2];
        const pValue = args[3];

        const device = devices.get(pDevice);
        if (!device || !pValue || !Number.isInteger(stage) || stage < 0 || stage >= D3D9_FFP_STAGE_COUNT) return D3DERR_INVALIDCALL;

        return Mem.writeUint32(pValue, device.getTextureStageState(stage, type)) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetSamplerState'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const sampler = args[1];
        const type = args[2];
        const value = args[3];

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        return device.setSamplerState(sampler, type, value);
    };

    exports['IDirect3DDevice9_GetSamplerState'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const sampler = args[1];
        const type = args[2];
        const pValue = args[3];

        const device = devices.get(pDevice);
        if (!device || !pValue || !isD3D9TextureStage(sampler)) return D3DERR_INVALIDCALL;

        return Mem.writeUint32(pValue, device.getSamplerState(sampler, type)) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetMaterial'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pMaterial = args[1];

        const device = devices.get(pDevice);
        if (!device || !pMaterial) return D3DERR_INVALIDCALL;

        const bytes = Mem.readBytes(pMaterial, D3DMATERIAL9_SIZE);
        if (!bytes) return D3DERR_INVALIDCALL;

        return device.setMaterial(bytes);
    };

    exports['IDirect3DDevice9_GetMaterial'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pMaterial = args[1];

        const device = devices.get(pDevice);
        if (!device || !pMaterial) return D3DERR_INVALIDCALL;

        const bytes = device.getMaterial();
        return Mem.writeBytes(pMaterial, bytes) === D3DMATERIAL9_SIZE ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // D3D9 light INDICES are a sparse, unbounded DWORD space: MaxActiveLights caps how many
    // lights may be ENABLED at once, not which slots may be addressed. Rejecting a high index
    // here loses lights from any engine that allocates one slot per scene light.
    exports['IDirect3DDevice9_SetLight'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1] >>> 0;
        const pLight = args[2];

        const device = devices.get(pDevice);
        if (!device || !pLight) return D3DERR_INVALIDCALL;

        const bytes = Mem.readBytes(pLight, D3DLIGHT9_SIZE);
        if (!bytes) return D3DERR_INVALIDCALL;

        return device.setLight(index, bytes);
    };

    exports['IDirect3DDevice9_GetLight'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1] >>> 0;
        const pLight = args[2];

        const device = devices.get(pDevice);
        if (!device || !pLight) return D3DERR_INVALIDCALL;

        const light = device.getLight(index);
        if (!light) return D3DERR_INVALIDCALL;

        return Mem.writeBytes(pLight, light) === D3DLIGHT9_SIZE ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_LightEnable'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1] >>> 0;
        const enable = args[2];

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        return device.lightEnable(index, enable);
    };

    exports['IDirect3DDevice9_GetLightEnable'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1] >>> 0;
        const pEnable = args[2];

        const device = devices.get(pDevice);
        if (!device || !pEnable) return D3DERR_INVALIDCALL;

        return Mem.writeUint32(pEnable, device.getLightEnable(index)) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetClipPlane'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1];
        const pPlane = args[2];

        const device = devices.get(pDevice);
        // D3D9 exposes exactly six user clip planes (0..5).  Do not retain an
        // out-of-range plane in the backend map: it would be silently ignored
        // by the shader while the setter reported success.
        if (!device || !pPlane || !Number.isInteger(index) || index < 0 || index >= 6) {
            return D3DERR_INVALIDCALL;
        }

        const plane = new Float32Array(4);
        for (let i = 0; i < 4; i++) {
            const v = Mem.readFloat32(pPlane + i * 4);
            if (v === null || !Number.isFinite(v)) return D3DERR_INVALIDCALL;
            plane[i] = v;
        }
        return device.setClipPlane(index, plane);
    };

    exports['IDirect3DDevice9_GetClipPlane'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1];
        const pPlane = args[2];

        const device = devices.get(pDevice);
        if (!device || !pPlane || !Number.isInteger(index) || index < 0 || index >= 6) {
            return D3DERR_INVALIDCALL;
        }

        const plane = device.getClipPlane(index);
        if (!plane) return D3DERR_INVALIDCALL;
        for (let i = 0; i < 4; i++) {
            if (!Mem.writeFloat32(pPlane + i * 4, plane[i]!)) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    // Clip status — D3DCLIPSTATUS9 {DWORD ClipUnion; DWORD ClipIntersection;}. The device
    // only ever reports back what the app wrote (ProcessVertices is the sole producer on
    // real hardware and we do not run it through the clipper), so store-and-return matches
    // DXVK. A NULL pointer is D3DERR_INVALIDCALL, not a silent success: an app reading an
    // untouched struct behind a SUCCEEDED() would treat garbage as "everything clipped".
    exports['IDirect3DDevice9_SetClipStatus'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const pClipStatus = args[1];
        if (!devices.has(pDevice) || !pClipStatus) return D3DERR_INVALIDCALL;
        const clipUnion = Mem.readUint32(pClipStatus);
        const clipIntersection = Mem.readUint32(pClipStatus + 4);
        if (clipUnion === null || clipIntersection === null) return D3DERR_INVALIDCALL;
        deviceClipStatus.set(pDevice, { clipUnion, clipIntersection });
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetClipStatus'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const pClipStatus = args[1];
        if (!devices.has(pDevice) || !pClipStatus) return D3DERR_INVALIDCALL;
        const status = deviceClipStatus.get(pDevice);
        const clipUnion = status ? status.clipUnion : 0;
        const clipIntersection = status ? status.clipIntersection : 0xFFFFFFFF;
        if (!Mem.writeUint32(pClipStatus, clipUnion)) return D3DERR_INVALIDCALL;
        if (!Mem.writeUint32(pClipStatus + 4, clipIntersection)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    // Palette — IDirect3DDevice9 texture palettes (P8/A8P8), same contract as D3D8/DXVK.
    exports['IDirect3DDevice9_SetPaletteEntries'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pEntries = args[2];
        if (!pEntries) return D3DERR_INVALIDCALL;
        device.setPaletteEntries(args[1] >>> 0, pEntries, mem);
        return D3D_OK;
    };
    exports['IDirect3DDevice9_GetPaletteEntries'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pEntries = args[2];
        if (!pEntries) return D3DERR_INVALIDCALL;
        return device.getPaletteEntries(args[1] >>> 0, pEntries, mem) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['IDirect3DDevice9_SetCurrentTexturePalette'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        device.setCurrentTexturePalette(args[1] >>> 0);
        return D3D_OK;
    };
    exports['IDirect3DDevice9_GetCurrentTexturePalette'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pPalette = args[1];
        if (!device || !pPalette) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(pPalette, device.getCurrentTexturePalette()) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // COM interface methods (shared across all D3D9 objects)
    const comPrefixes = [
        'IDirect3DDevice9',
        'IDirect3DVertexBuffer9',
        'IDirect3DIndexBuffer9',
        'IDirect3DTexture9',
        'IDirect3DCubeTexture9',
        'IDirect3DSurface9',
        'IDirect3DStateBlock9',
        'IDirect3DVertexDeclaration9',
        'IDirect3DVertexShader9',
        'IDirect3DPixelShader9',
    ];

    for (const prefix of comPrefixes) {
        // QueryInterface returns a NEW reference: `QI(&p); … p->Release();` is a
        // balanced pair in every engine and D3DX helper, so skipping the AddRef nets
        // −1 per pair and frees the object out from under its live bindings.
        // D3DX and runtime code QI for IUnknown/base interfaces on the same object
        // pointer, so every accepted IID maps back to `this`.
        exports[`${prefix}_QueryInterface`] = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const ppvObject = args[2] >>> 0;
            if (!ppvObject) return E_POINTER;
            // QI must reject unrelated interfaces.  Returning the same pointer
            // for an arbitrary IID lets the caller dispatch a vtable with a
            // different layout and turns a probe into memory corruption.
            if (!getComRefCount(thisPtr) || !d3d9ObjectSupportsIid(prefix, mem, args[1] >>> 0)) {
                Mem.writeUint32(ppvObject, 0);
                return E_NOINTERFACE;
            }
            if (!Mem.writeUint32(ppvObject, thisPtr)) return E_POINTER;
            addD3D9ComRef(prefix, thisPtr);
            return D3D_OK;
        };

        exports[`${prefix}_AddRef`] = (ctx, mem, args) => {
            const pObject = args[0];
            Logger.verbose(LogCategory.D3D9, `${prefix}::AddRef(0x${pObject.toString(16)})`);
            return addD3D9ComRef(prefix, pObject);
        };

        exports[`${prefix}_Release`] = (ctx, mem, args) => {
            const pObject = args[0];
            Logger.verbose(LogCategory.D3D9, `${prefix}::Release(0x${pObject.toString(16)})`);
            return releaseD3D9ComRef(prefix, pObject);
        };
    }

    // ── Vertex Shader ─────────────────────────────────────────────────

    exports['IDirect3DDevice9_CreateVertexShader'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pFunction = args[1]; // DWORD* bytecode pointer
        const ppShader = args[2];  // IDirect3DVertexShader9** out

        const device = devices.get(pDevice);
        if (!device || !ppShader) {
            Logger.error(LogCategory.D3D9, `CreateVertexShader: invalid device`);
            return D3DERR_INVALIDCALL;
        }

        const result = device.createVertexShader(pFunction, mem);
        if (result.hr !== D3D_OK) return result.hr;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DVertexShader9']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const shaderPtr = createComObject(vtableAddr);
        vertexShaderComObjects.set(shaderPtr, {
            devicePtr: pDevice,
            internalHandle: result.handle,
            bytecode: result.bytecode,
        });
        registerDeviceChildFinalizer(shaderPtr, pDevice, () => vertexShaderComObjects.delete(shaderPtr));

        if (!writeComPtrOut(ppShader, shaderPtr, mem)) {
            releaseComRef(shaderPtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetVertexShader'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pShader = args[1]; // IDirect3DVertexShader9* (or NULL)

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        if (pShader === 0) {
            return device.setVertexShader(0, 0);
        }
        const meta = resolveVertexShaderComPtr(pShader);
        if (!meta) return D3DERR_INVALIDCALL;
        return device.setVertexShader(meta.internalHandle, pShader);
    };

    exports['IDirect3DDevice9_GetVertexShader'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const ppShader = args[1];

        const device = devices.get(pDevice);
        if (!device || !ppShader) return D3DERR_INVALIDCALL;

        const shaderPtr = device.getVertexShaderComPtr();
        if (!writeComPtrOut(ppShader, shaderPtr, mem)) return D3DERR_INVALIDCALL;
        if (shaderPtr) addComRef(shaderPtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetVertexShaderConstantF'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const StartRegister = args[1];
        const pConstantData = args[2];
        const Vector4fCount = args[3];

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        return device.setVertexShaderConstantF(StartRegister, pConstantData, Vector4fCount, mem);
    };

    exports['IDirect3DDevice9_SetVertexShaderConstantI'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setVertexShaderConstantI(args[1], args[2], args[3], mem);
    };
    exports['IDirect3DDevice9_GetVertexShaderConstantI'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const start = args[1];
        const pData = args[2];
        const count = args[3] >>> 0;
        const limit = typeof device?.getSoftwareVertexProcessing === 'function' && device.getSoftwareVertexProcessing() ? SWVP_INTEGER_REGISTER_COUNT : 16;
        if (!device || start < 0 || count > limit || start + count > limit || (count > 0 && !pData)) return D3DERR_INVALIDCALL;
        const data = device.getVertexShaderConstantsI(start, count);
        for (let i = 0; i < data.length; i++) {
            if (!Mem.writeUint32(pData + i * 4, data[i]! >>> 0)) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };
    exports['IDirect3DDevice9_SetVertexShaderConstantB'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setVertexShaderConstantB(args[1], args[2], args[3], mem);
    };
    exports['IDirect3DDevice9_GetVertexShaderConstantB'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const start = args[1];
        const pData = args[2];
        const count = args[3] >>> 0;
        const limit = typeof device?.getSoftwareVertexProcessing === 'function' && device.getSoftwareVertexProcessing() ? SWVP_BOOLEAN_REGISTER_COUNT : 16;
        if (!device || start < 0 || count > limit || start + count > limit || (count > 0 && !pData)) return D3DERR_INVALIDCALL;
        const data = device.getVertexShaderConstantsB(start, count);
        for (let i = 0; i < data.length; i++) {
            if (!Mem.writeUint32(pData + i * 4, data[i]! >>> 0)) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };
    exports['IDirect3DDevice9_GetVertexShaderConstantF'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const start = args[1] >>> 0;
        const pData = args[2] >>> 0;
        const count = args[3] >>> 0;
        const limit = typeof device?.getSoftwareVertexProcessing === 'function' && device.getSoftwareVertexProcessing() ? SWVP_FLOAT_REGISTER_COUNT : VS_FLOAT_REGISTER_COUNT;
        if (!device || start > limit || count > limit - start ||
            (count > 0 && !pData)) return D3DERR_INVALIDCALL;

        const data = device.getVertexShaderConstants(start, count);
        for (let i = 0; i < data.length; i++) {
            if (!Mem.writeFloat32(pData + i * 4, data[i]!)) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    // ── Vertex Declaration ───────────────────────────────────────────

    exports['IDirect3DDevice9_CreateVertexDeclaration'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pVertexElements = args[1]; // D3DVERTEXELEMENT9*
        const ppDecl = args[2];          // IDirect3DVertexDeclaration9** out

        const device = devices.get(pDevice);
        if (!device || !ppDecl) return D3DERR_INVALIDCALL;

        // Read D3DVERTEXELEMENT9 array (8 bytes each)
        // struct: WORD Stream, WORD Offset, BYTE Type, BYTE Method, BYTE Usage, BYTE UsageIndex
        // Sentinel: stream field == 0xFF (D3DDECL_END macro sets stream=0xFF)
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const elements: RawVertexElement[] = [];
        let ptr = pVertexElements;
        for (let i = 0; i < 64; i++) { // safety limit
            const stream = dv.getUint16(ptr, true);
            if (stream === 0xFF) break;  // D3DDECL_END sentinel
            const offset = dv.getUint16(ptr + 2, true);
            const type = dv.getUint8(ptr + 4);
            // method = dv.getUint8(ptr + 5) — ignored
            const usage = dv.getUint8(ptr + 6);
            const usageIndex = dv.getUint8(ptr + 7);
            elements.push({ stream, offset, type, usage, usageIndex });
            ptr += 8;
        }

        const result = device.createVertexDeclaration(elements);
        if (result.hr !== D3D_OK) return result.hr;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DVertexDeclaration9']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const declPtr = createComObject(vtableAddr);
        vertexDeclComObjects.set(declPtr, {
            devicePtr: pDevice,
            internalHandle: result.handle,
            elements,
        });
        registerDeviceChildFinalizer(declPtr, pDevice, () => vertexDeclComObjects.delete(declPtr));

        if (!writeComPtrOut(ppDecl, declPtr, mem)) {
            releaseComRef(declPtr);
            return D3DERR_INVALIDCALL;
        }
        Logger.log(LogCategory.D3D9, `CreateVertexDeclaration → 0x${declPtr.toString(16)} (${elements.length} elements)`);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetVertexDeclaration'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pDecl = args[1];

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        if (pDecl === 0) {
            return device.setVertexDeclaration(0, 0);
        }
        const meta = resolveVertexDeclComPtr(pDecl);
        if (!meta) return D3DERR_INVALIDCALL;
        return device.setVertexDeclaration(meta.internalHandle, pDecl);
    };

    exports['IDirect3DDevice9_GetVertexDeclaration'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device || !args[1]) return D3DERR_INVALIDCALL;
        const declPtr = device.getVertexDeclarationComPtr();
        if (!writeComPtrOut(args[1], declPtr, mem)) return D3DERR_INVALIDCALL;
        if (declPtr) addComRef(declPtr);
        return D3D_OK;
    };

    // ── Pixel Shader ─────────────────────────────────────────────────

    exports['IDirect3DDevice9_CreatePixelShader'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pFunction = args[1]; // DWORD* bytecode
        const ppShader = args[2];  // IDirect3DPixelShader9** out

        const device = devices.get(pDevice);
        if (!device || !ppShader) {
            Logger.error(LogCategory.D3D9, `CreatePixelShader: invalid device`);
            return D3DERR_INVALIDCALL;
        }

        const result = device.createPixelShader(pFunction, mem);
        if (result.hr !== D3D_OK) return result.hr;

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DPixelShader9']?.address;
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const shaderPtr = createComObject(vtableAddr);
        pixelShaderComObjects.set(shaderPtr, {
            devicePtr: pDevice,
            internalHandle: result.handle,
            bytecode: result.bytecode,
        });
        registerDeviceChildFinalizer(shaderPtr, pDevice, () => pixelShaderComObjects.delete(shaderPtr));

        if (!writeComPtrOut(ppShader, shaderPtr, mem)) {
            releaseComRef(shaderPtr);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetPixelShader'] = (ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const pShader = args[1];
        if (pShader === 0) {
            return device.setPixelShader(0, 0);
        }
        const meta = resolvePixelShaderComPtr(pShader);
        if (!meta) return D3DERR_INVALIDCALL;
        return device.setPixelShader(meta.internalHandle, pShader);
    };

    exports['IDirect3DDevice9_GetPixelShader'] = (ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device || !args[1]) return D3DERR_INVALIDCALL;
        const shaderPtr = device.getPixelShaderComPtr();
        if (!writeComPtrOut(args[1], shaderPtr, mem)) return D3DERR_INVALIDCALL;
        if (shaderPtr) addComRef(shaderPtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetPixelShaderConstantF'] = (ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setPixelShaderConstantF(args[1], args[2], args[3], mem);
    };

    exports['IDirect3DDevice9_GetPixelShaderConstantF'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const start = args[1] >>> 0;
        const pData = args[2] >>> 0;
        const count = args[3] >>> 0;
        if (!device || start > PS_FLOAT_REGISTER_COUNT || count > PS_FLOAT_REGISTER_COUNT - start ||
            (count > 0 && !pData)) return D3DERR_INVALIDCALL;

        const data = device.getPixelShaderConstants(start, count);
        for (let i = 0; i < data.length; i++) {
            if (!Mem.writeFloat32(pData + i * 4, data[i]!)) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };
    exports['IDirect3DDevice9_SetPixelShaderConstantI'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setPixelShaderConstantI(args[1], args[2], args[3], mem);
    };
    exports['IDirect3DDevice9_GetPixelShaderConstantI'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const start = args[1];
        const pData = args[2];
        const count = args[3] >>> 0;
        if (!device || start < 0 || count > 16 || start + count > 16 || (count > 0 && !pData)) return D3DERR_INVALIDCALL;
        const data = device.getPixelShaderConstantsI(start, count);
        for (let i = 0; i < data.length; i++) {
            if (!Mem.writeUint32(pData + i * 4, data[i]! >>> 0)) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };
    exports['IDirect3DDevice9_SetPixelShaderConstantB'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setPixelShaderConstantB(args[1], args[2], args[3], mem);
    };
    exports['IDirect3DDevice9_GetPixelShaderConstantB'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const start = args[1];
        const pData = args[2];
        const count = args[3] >>> 0;
        if (!device || start < 0 || count > 16 || start + count > 16 || (count > 0 && !pData)) return D3DERR_INVALIDCALL;
        const data = device.getPixelShaderConstantsB(start, count);
        for (let i = 0; i < data.length; i++) {
            if (!Mem.writeUint32(pData + i * 4, data[i]! >>> 0)) return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    // D3DX effect framework probes whether current VS/PS/state can render in N passes.
    exports['IDirect3DDevice9_ValidateDevice'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pNumPasses = args[1];
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        const result = device.validateDevice();
        if (pNumPasses && !Mem.writeUint32(pNumPasses, result.passes)) return D3DERR_INVALIDCALL;
        return result.hr;
    };

    // ── State blocks (D3DX effect framework) ───────────────────────────

    exports['IDirect3DDevice9_BeginStateBlock'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const hr = normalizeStateBlockHr(device.beginStateBlock());
        if (hr === D3D_OK) {
            recordingDevices.add(args[0] >>> 0);
            // A recording device journals setters instead of applying them, so a guest-side
            // shadow skip would drop the entry from the BLOCK, not just from the device.
            beginStateBlockShadowWindow(args[0] >>> 0);
            Logger.verbose(LogCategory.D3D9, 'BeginStateBlock');
        }
        return hr;
    };

    exports['IDirect3DDevice9_EndStateBlock'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const ppSB = args[1];
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        // Native D3D9 validates the output pointer before closing the recorder.
        // A failed EndStateBlock must leave BeginStateBlock active so the guest
        // can retry with a valid destination.
        if (!ppSB || !Mem.writeUint32(ppSB, 0)) return D3DERR_INVALIDCALL;

        const result = device.endStateBlock();
        const endHr = normalizeStateBlockHr(result.hr);
        if (endHr !== D3D_OK) return endHr;
        // The device is applying setters again as of this line; a later failure here does not
        // put it back to recording, so the gate is re-armed now rather than at the export's end.
        endStateBlockShadowWindow(pDevice >>> 0);

        const sbPtr = createStateBlockComObject(pDevice, {
            devicePtr: pDevice,
            blockType: 0,
            entries: result.entries,
        });
        if (!sbPtr) return D3DERR_INVALIDCALL;
        if (!writeStateBlockOut(ppSB, sbPtr, mem)) {
            releaseComRef(sbPtr);
            return D3DERR_INVALIDCALL;
        }
        recordingDevices.delete(pDevice >>> 0);

        Logger.verbose(LogCategory.D3D9, `EndStateBlock → 0x${sbPtr.toString(16)} (${result.entries.length} entries)`);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateStateBlock'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const blockType = args[1];
        const ppSB = args[2];
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        if (!ppSB || !Mem.writeUint32(ppSB, 0) || recordingDevices.has(pDevice >>> 0)) {
            return D3DERR_INVALIDCALL;
        }

        const sbPtr = createStateBlockComObject(pDevice, device.createStateBlockData(blockType));
        if (!sbPtr) return D3DERR_INVALIDCALL;
        if (!writeStateBlockOut(ppSB, sbPtr, mem)) {
            releaseComRef(sbPtr);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `CreateStateBlock(type=${blockType}) → 0x${sbPtr.toString(16)}`);
        return D3D_OK;
    };

    exports['IDirect3DStateBlock9_GetDevice'] = (_ctx, mem, args) => {
        const pSB = args[0];
        const ppDevice = args[1];
        const block = stateBlocks.get(pSB);
        if (!block || !ppDevice) return D3DERR_INVALIDCALL;
        if (!writeComPtrOut(ppDevice, block.devicePtr, mem)) return D3DERR_INVALIDCALL;
        addComRef(block.devicePtr);
        return D3D_OK;
    };

    exports['IDirect3DStateBlock9_Capture'] = (_ctx, _mem, args) => {
        const pSB = args[0];
        const block = stateBlocks.get(pSB);
        const device = block ? devices.get(block.devicePtr) : null;
        if (!block || !device) return D3DERR_INVALIDCALL;
        return device.captureStateBlockData(block);
    };

    exports['IDirect3DStateBlock9_Apply'] = (_ctx, _mem, args) => {
        const pSB = args[0];
        const block = stateBlocks.get(pSB);
        const device = block ? devices.get(block.devicePtr) : null;
        if (!block || !device) return D3DERR_INVALIDCALL;
        Logger.verbose(LogCategory.D3D9, `StateBlock::Apply(0x${pSB.toString(16)}, ${block.entries.length} entries)`);
        return device.applyStateBlockData(block);
    };

    // ── Vertex declaration / shader COM interfaces ─────────────────────

    exports['IDirect3DVertexDeclaration9_GetDevice'] = (_ctx, mem, args) => {
        const meta = resolveVertexDeclComPtr(args[0]);
        if (!meta || !args[1]) return D3DERR_INVALIDCALL;
        if (!writeComPtrOut(args[1], meta.devicePtr, mem)) return D3DERR_INVALIDCALL;
        addComRef(meta.devicePtr);
        return D3D_OK;
    };

    // GetDeclaration(pElement, pNumElements). The reported count INCLUDES the trailing
    // D3DDECL_END entry that writeVertexElements appends — the query-then-fill idiom
    // (`GetDeclaration(d, NULL, &n); malloc(n * 8); GetDeclaration(d, e, &n);`) sizes the
    // caller's buffer from this number, so reporting the stored count (which stops at the
    // sentinel) overflows it by exactly one element.
    exports['IDirect3DVertexDeclaration9_GetDeclaration'] = (_ctx, mem, args) => {
        const meta = resolveVertexDeclComPtr(args[0]);
        if (!meta) return D3DERR_INVALIDCALL;
        if (args[2] && !Mem.writeUint32(args[2], meta.elements.length + 1)) return D3DERR_INVALIDCALL;
        if (args[1] && !writeVertexElements(args[1], meta.elements, mem)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    exports['IDirect3DVertexShader9_GetDevice'] = (_ctx, mem, args) => {
        const meta = resolveVertexShaderComPtr(args[0]);
        if (!meta || !args[1]) return D3DERR_INVALIDCALL;
        if (!writeComPtrOut(args[1], meta.devicePtr, mem)) return D3DERR_INVALIDCALL;
        addComRef(meta.devicePtr);
        return D3D_OK;
    };

    exports['IDirect3DVertexShader9_GetFunction'] = (_ctx, mem, args) => {
        const meta = resolveVertexShaderComPtr(args[0]);
        if (!meta) return D3DERR_INVALIDCALL;
        const byteSize = meta.bytecode.length * 4;
        if (args[2] && !Mem.writeUint32(args[2], byteSize)) return D3DERR_INVALIDCALL;
        if (args[1] && byteSize > 0) {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < meta.bytecode.length; i++) {
                dv.setUint32(args[1] + i * 4, meta.bytecode[i]!, true);
            }
        }
        return D3D_OK;
    };

    exports['IDirect3DPixelShader9_GetDevice'] = (_ctx, mem, args) => {
        const meta = resolvePixelShaderComPtr(args[0]);
        if (!meta || !args[1]) return D3DERR_INVALIDCALL;
        if (!writeComPtrOut(args[1], meta.devicePtr, mem)) return D3DERR_INVALIDCALL;
        addComRef(meta.devicePtr);
        return D3D_OK;
    };

    exports['IDirect3DPixelShader9_GetFunction'] = (_ctx, mem, args) => {
        const meta = resolvePixelShaderComPtr(args[0]);
        if (!meta) return D3DERR_INVALIDCALL;
        const byteSize = meta.bytecode.length * 4;
        if (args[2] && !Mem.writeUint32(args[2], byteSize)) return D3DERR_INVALIDCALL;
        if (args[1] && byteSize > 0) {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < meta.bytecode.length; i++) {
                dv.setUint32(args[1] + i * 4, meta.bytecode[i]!, true);
            }
        }
        return D3D_OK;
    };

    return exports;
}
