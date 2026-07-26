/**
 * D3D9 State functions
 *
 * Atomic implementation for Direct3D state operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { devices, getVTables, createComObject, stateBlocks } from './shared-state';
import { vertexBufferMeta } from './resource-registry';
import { stubRegistry } from '../../core/diagnostics/stub-registry';
import { RawVertexElement } from '../../backends/webgpu/d3d9/shader';
import type { D3D9StateBlockData } from '../../backends/webgpu/d3d9/d3d9-state-block';
import { classifyStateBlockCoverage, tryAttachWasmBlockSlot } from '../../backends/webgpu/d3d9/d3d9-state-block';
import { d3d9PerfStateBlockCreated } from './d3d9-perf';
import {
    vertexDeclComObjects,
    vertexShaderComObjects,
    pixelShaderComObjects,
    resolveVertexDeclComPtr,
    resolveVertexShaderComPtr,
    resolvePixelShaderComPtr,
} from '../../backends/webgpu/d3d9/d3d9-com-objects';

export function createStateExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const D3D_OK = 0;
    const D3DERR_INVALIDCALL = 0x8876086c;
    const E_POINTER = 0x80004003;
    const D3DMATERIAL9_SIZE = 68;
    const D3DLIGHT9_SIZE = 104;

    function d3d9QueryInterface(_ctx: unknown, mem: Uint8Array, args: number[]): number {
        const thisPtr = args[0] >>> 0;
        const ppvObject = args[2] >>> 0;
        if (!ppvObject) return E_POINTER;
        // D3DX and runtime code QI for IUnknown/base interfaces on the same object pointer.
        if (!Mem.writeUint32(ppvObject, thisPtr)) return E_POINTER;
        return D3D_OK;
    }

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
        d3d9PerfStateBlockCreated(
            data.blockType,
            data.entries.length,
            coverage.coverable,
            coverage.opCounts,
            coverage.vsConstRanges,
            coverage.psConstRanges,
        );
        stateBlocks.set(sbPtr, data);
        return sbPtr;
    }

    function writeComPtrOut(ppOut: number, ptr: number, mem: Uint8Array): boolean {
        if (!ppOut) return false;
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        dv.setUint32(ppOut, ptr, true);
        return true;
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
        // D3DDECL_END sentinel
        dv.setUint16(ptr, 0xff, true);
        dv.setUint16(ptr + 2, 0, true);
        dv.setUint8(ptr + 4, 0);
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

        Logger.verbose(LogCategory.D3D9, `SetRenderState(${State}, 0x${Value.toString(16)})`);
        device.setRenderState(State, Value);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetTransform'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const State = args[1];
        const pMatrix = args[2];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `SetTransform: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `SetTransform(${State})`);

        // Read 4x4 matrix from memory (16 floats)
        const matrix = new Float32Array(16);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        for (let i = 0; i < 16; i++) {
            matrix[i] = view.getFloat32(pMatrix + i * 4, true);
        }

        device.setTransform(State, matrix);
        return D3D_OK;
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
        device.setStreamSource(StreamNumber, pStreamData, OffsetInBytes, Stride);
        return D3D_OK;
    };

    // GetStreamSource(StreamNumber, ppStreamData, pOffsetInBytes, pStride). ppStreamData is
    // mandatory; the other two out-params are optional. Real D3D9 AddRefs the returned buffer —
    // a no-op here, since d3d9 COM objects are not reference counted (AddRef/Release above are
    // constant stubs), exactly like GetRenderTarget/GetBackBuffer in this module.
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
        return D3D_OK;
    };

    // ProcessVertices(SrcStartIndex, DestIndex, VertexCount, pDestBuffer, pVertexDecl, Flags):
    // software T&L of the bound streams into a destination vertex buffer.
    let processVerticesWarned = false;
    exports['IDirect3DDevice9_ProcessVertices'] = (ctx, _mem, args) => {
        const device = devices.get(args[0]);
        const pDestBuffer = args[4] >>> 0;
        if (!device || !pDestBuffer || !vertexBufferMeta.has(pDestBuffer)) return D3DERR_INVALIDCALL;
        if ((args[3] >>> 0) === 0) return D3D_OK;

        // The real runtime succeeds here even on a hardware-VP device (wine's own
        // dlls/d3d9/tests/visual.c asserts D3D_OK after D3DCREATE_HARDWARE_VERTEXPROCESSING,
        // and dxvk returns D3D_OK when it cannot emulate SWVP), so returning an error would
        // push the guest down a branch real hardware never takes. We have no CPU vertex
        // pipeline — the FFP is WGSL and runs on the GPU — so the destination buffer keeps
        // whatever it held. Recording the miss keeps the gap answerable from harness stubs()
        // instead of surfacing later as unexplained geometry.
        if (!processVerticesWarned) {
            processVerticesWarned = true;
            Logger.error(LogCategory.D3D9,
                'ProcessVertices: no CPU vertex pipeline — destination buffer left untouched');
        }
        stubRegistry.record('d3d9', 'IDirect3DDevice9_ProcessVertices', 0,
            (Mem.readUint32(ctx.esp) ?? 0) >>> 0);
        return D3D_OK;
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
        device.setIndices(pIndexData);
        return D3D_OK;
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
        device.setTexture(Stage, pTexture);
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
        if (!device) return D3DERR_INVALIDCALL;

        return device.setTextureStageState(stage, type, value);
    };

    exports['IDirect3DDevice9_GetTextureStageState'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const stage = args[1];
        const type = args[2];
        const pValue = args[3];

        const device = devices.get(pDevice);
        if (!device || !pValue) return D3DERR_INVALIDCALL;

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
        if (!device || !pValue) return D3DERR_INVALIDCALL;

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

    exports['IDirect3DDevice9_SetLight'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1];
        const pLight = args[2];

        const device = devices.get(pDevice);
        if (!device || !pLight) return D3DERR_INVALIDCALL;

        const bytes = Mem.readBytes(pLight, D3DLIGHT9_SIZE);
        if (!bytes) return D3DERR_INVALIDCALL;

        return device.setLight(index, bytes);
    };

    exports['IDirect3DDevice9_GetLight'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1];
        const pLight = args[2];

        const device = devices.get(pDevice);
        if (!device || !pLight) return D3DERR_INVALIDCALL;

        const light = device.getLight(index);
        if (!light) return D3DERR_INVALIDCALL;

        return Mem.writeBytes(pLight, light) === D3DLIGHT9_SIZE ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_LightEnable'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1];
        const enable = args[2];

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        return device.lightEnable(index, enable);
    };

    exports['IDirect3DDevice9_GetLightEnable'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1];
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
        if (!device || !pPlane) return D3DERR_INVALIDCALL;

        const plane = new Float32Array(4);
        for (let i = 0; i < 4; i++) {
            const v = Mem.readFloat32(pPlane + i * 4);
            if (v === null) return D3DERR_INVALIDCALL;
            plane[i] = v;
        }
        return device.setClipPlane(index, plane);
    };

    exports['IDirect3DDevice9_GetClipPlane'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const index = args[1];
        const pPlane = args[2];

        const device = devices.get(pDevice);
        if (!device || !pPlane) return D3DERR_INVALIDCALL;

        const plane = device.getClipPlane(index);
        if (!plane) return D3DERR_INVALIDCALL;
        for (let i = 0; i < 4; i++) {
            if (!Mem.writeFloat32(pPlane + i * 4, plane[i]!)) return D3DERR_INVALIDCALL;
        }
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
        'IDirect3D9',
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
        exports[`${prefix}_QueryInterface`] = d3d9QueryInterface;

        exports[`${prefix}_AddRef`] = (ctx, mem, args) => {
            const pObject = args[0];
            Logger.verbose(LogCategory.D3D9, `${prefix}::AddRef(0x${pObject.toString(16)})`);
            return 2; // Dummy ref count
        };

        exports[`${prefix}_Release`] = (ctx, mem, args) => {
            const pObject = args[0];
            Logger.verbose(LogCategory.D3D9, `${prefix}::Release(0x${pObject.toString(16)})`);
            return 1; // Dummy ref count
        };
    }

    // ── Vertex Shader ─────────────────────────────────────────────────

    exports['IDirect3DDevice9_CreateVertexShader'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pFunction = args[1]; // DWORD* bytecode pointer
        const ppShader = args[2];  // IDirect3DVertexShader9** out

        const device = devices.get(pDevice);
        if (!device) {
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

        if (ppShader) {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            dv.setUint32(ppShader, shaderPtr, true);
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
        if (!device) return D3DERR_INVALIDCALL;

        if (ppShader) {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            dv.setUint32(ppShader, device.getVertexShaderComPtr(), true);
        }
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

    // Stubs for integer/boolean constants (rarely used in vs_1_x)
    exports['IDirect3DDevice9_SetVertexShaderConstantI'] = () => D3D_OK;
    exports['IDirect3DDevice9_GetVertexShaderConstantI'] = () => D3D_OK;
    exports['IDirect3DDevice9_SetVertexShaderConstantB'] = () => D3D_OK;
    exports['IDirect3DDevice9_GetVertexShaderConstantB'] = () => D3D_OK;
    exports['IDirect3DDevice9_GetVertexShaderConstantF'] = () => D3D_OK;

    // ── Vertex Declaration ───────────────────────────────────────────

    exports['IDirect3DDevice9_CreateVertexDeclaration'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pVertexElements = args[1]; // D3DVERTEXELEMENT9*
        const ppDecl = args[2];          // IDirect3DVertexDeclaration9** out

        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

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

        if (ppDecl) {
            dv.setUint32(ppDecl, declPtr, true);
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
        if (!device) return D3DERR_INVALIDCALL;
        if (args[1]) {
            writeComPtrOut(args[1], device.getVertexDeclarationComPtr(), mem);
        }
        return D3D_OK;
    };

    // ── Pixel Shader ─────────────────────────────────────────────────

    exports['IDirect3DDevice9_CreatePixelShader'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pFunction = args[1]; // DWORD* bytecode
        const ppShader = args[2];  // IDirect3DPixelShader9** out

        const device = devices.get(pDevice);
        if (!device) {
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

        if (ppShader) {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            dv.setUint32(ppShader, shaderPtr, true);
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
        if (!device) return D3DERR_INVALIDCALL;
        if (args[1]) {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            dv.setUint32(args[1], device.getPixelShaderComPtr(), true);
        }
        return D3D_OK;
    };

    exports['IDirect3DDevice9_SetPixelShaderConstantF'] = (ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setPixelShaderConstantF(args[1], args[2], args[3], mem);
    };

    exports['IDirect3DDevice9_GetPixelShaderConstantF'] = () => D3D_OK;
    exports['IDirect3DDevice9_SetPixelShaderConstantI'] = () => D3D_OK;
    exports['IDirect3DDevice9_GetPixelShaderConstantI'] = () => D3D_OK;
    exports['IDirect3DDevice9_SetPixelShaderConstantB'] = () => D3D_OK;
    exports['IDirect3DDevice9_GetPixelShaderConstantB'] = () => D3D_OK;

    // D3DX effect framework probes whether current VS/PS/state can render in N passes.
    exports['IDirect3DDevice9_ValidateDevice'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pNumPasses = args[1];
        if (!devices.has(pDevice)) return D3DERR_INVALIDCALL;
        if (pNumPasses && !Mem.writeUint32(pNumPasses, 1)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    // ── State blocks (D3DX effect framework) ───────────────────────────

    exports['IDirect3DDevice9_BeginStateBlock'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const hr = device.beginStateBlock();
        if (hr === D3D_OK) {
            Logger.verbose(LogCategory.D3D9, 'BeginStateBlock');
        }
        return hr;
    };

    exports['IDirect3DDevice9_EndStateBlock'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const ppSB = args[1];
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const result = device.endStateBlock();
        if (result.hr !== D3D_OK) return result.hr;

        const sbPtr = createStateBlockComObject(pDevice, {
            devicePtr: pDevice,
            blockType: 0,
            entries: result.entries,
        });
        if (!sbPtr || !writeStateBlockOut(ppSB, sbPtr, mem)) return D3DERR_INVALIDCALL;

        Logger.verbose(LogCategory.D3D9, `EndStateBlock → 0x${sbPtr.toString(16)} (${result.entries.length} entries)`);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateStateBlock'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const blockType = args[1];
        const ppSB = args[2];
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;

        const sbPtr = createStateBlockComObject(pDevice, device.createStateBlockData(blockType));
        if (!sbPtr || !writeStateBlockOut(ppSB, sbPtr, mem)) return D3DERR_INVALIDCALL;

        Logger.verbose(LogCategory.D3D9, `CreateStateBlock(type=${blockType}) → 0x${sbPtr.toString(16)}`);
        return D3D_OK;
    };

    exports['IDirect3DStateBlock9_GetDevice'] = (_ctx, mem, args) => {
        const pSB = args[0];
        const ppDevice = args[1];
        const block = stateBlocks.get(pSB);
        if (!block || !ppDevice) return D3DERR_INVALIDCALL;
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        dv.setUint32(ppDevice, block.devicePtr, true);
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
        return writeComPtrOut(args[1], meta.devicePtr, mem) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DVertexDeclaration9_GetDeclaration'] = (_ctx, mem, args) => {
        const meta = resolveVertexDeclComPtr(args[0]);
        if (!meta) return D3DERR_INVALIDCALL;
        if (args[2] && !Mem.writeUint32(args[2], meta.elements.length)) return D3DERR_INVALIDCALL;
        if (args[1] && !writeVertexElements(args[1], meta.elements, mem)) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    exports['IDirect3DVertexShader9_GetDevice'] = (_ctx, mem, args) => {
        const meta = resolveVertexShaderComPtr(args[0]);
        if (!meta || !args[1]) return D3DERR_INVALIDCALL;
        return writeComPtrOut(args[1], meta.devicePtr, mem) ? D3D_OK : D3DERR_INVALIDCALL;
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
        return writeComPtrOut(args[1], meta.devicePtr, mem) ? D3D_OK : D3DERR_INVALIDCALL;
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
