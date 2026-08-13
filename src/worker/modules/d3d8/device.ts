/**
 * D3D8 Device methods — BeginScene/EndScene/Clear/Present/Draw/GetBackBuffer
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory, LogLevel } from '../../core/logger';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { Mem } from '../../core/memory/mem-accessor';
import { sanitizeViewport } from '../../backends/webgpu/ddraw/types';
import { devices, deviceBoundDepthStencil, addComRef, isComObjectLive, deviceRenderTargetOverride, surfaceInfo } from './shared-state';
import { ensureBackBufferSurface } from './device-lifecycle';
import type { D3D8DeviceAdapter } from '../../backends/webgpu/d3d8/d3d8-device-adapter';
import { writeDeviceCaps8 } from './caps';
import { deviceCooperativeLevel } from '../../core/gpu/gpu-device-loss-contract';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_DEVICELOST = 0x88760868;
const D3DERR_DEVICENOTRESET = 0x88760869;
const D3DERR_NOTFOUND = 0x88760866;

const PRIM_NAMES = ['?', 'POINTLIST', 'LINELIST', 'LINESTRIP', 'TRILIST', 'TRISTRIP', 'TRIFAN'];

function logDrawState(device: D3D8DeviceAdapter, label: string, primType: number, primCount: number): void {
    if (!Logger.isEnabled(LogCategory.SYSTEM, LogLevel.VERBOSE)) return;

    const rs = device.renderStates;
    const blendEn = rs[27]; // ALPHABLENDENABLE
    const srcB = rs[19];    // SRCBLEND
    const dstB = rs[20];    // DESTBLEND
    const alphaTestEn = rs[15]; // ALPHATESTENABLE
    const alphaRef = rs[24];
    const alphaFunc = rs[25];
    const tex0 = device.textures[0];
    const tex1 = device.textures[1];
    const ts = device.textureStates;
    const colorOp0 = ts[1];  // stage0 COLOROP
    const alphaOp0 = ts[4];  // stage0 ALPHAOP
    const colorOp1 = ts[32 + 1]; // stage1 COLOROP

    let texInfo = 'no-tex';
    if (tex0 && tex0.surfaceType === 'bitmap_texture') {
        texInfo = `${tex0.width}x${tex0.height} bpp=${tex0.format.bpp} aMask=0x${(tex0.format.aMask >>> 0).toString(16)}`;
    }

    Logger.verbose(LogCategory.SYSTEM,
        `D3D8 ${label} ${PRIM_NAMES[primType] ?? primType} cnt=${primCount} FVF=0x${device.fvf.toString(16)} ` +
        `blend=${blendEn}(${srcB},${dstB}) atest=${alphaTestEn}(fn=${alphaFunc},ref=${alphaRef}) ` +
        `cOp0=${colorOp0} aOp0=${alphaOp0} cOp1=${colorOp1} tex=[${texInfo}]${tex1 ? '+stage1' : ''}`
    );
}

export function createDeviceExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['IDirect3DDevice8_BeginScene'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        const rt = device.renderTarget;
        device.viewport = sanitizeViewport(device.viewport, rt.width, rt.height);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_EndScene'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return D3D_OK;
    };

    exports['IDirect3DDevice8_Clear'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        const Flags = args[3];
        const Color = args[4];
        // Z is passed as float bits in u32
        const zBits = new Uint32Array(1);
        zBits[0] = args[5];
        const Z = new Float32Array(zBits.buffer)[0];
        const Stencil = args[6];

        const parts: string[] = [];
        if (Flags & 1) parts.push('TARGET');
        if (Flags & 2) parts.push('ZBUFFER');
        if (Flags & 4) parts.push('STENCIL');
        Logger.log(LogCategory.SYSTEM, `D3D8 Clear flags=${parts.join('|')||Flags} color=0x${(Color>>>0).toString(16)} z=${Z.toFixed(2)}`);
        device.clear(Flags, Color, Z, Stencil);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_Present'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.present();
    };

    exports['IDirect3DDevice8_DrawPrimitive'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        logDrawState(device, 'DrawPrim', args[1], args[3]);
        return device.drawPrimitive(args[1], args[2], args[3]);
    };

    exports['IDirect3DDevice8_DrawIndexedPrimitive'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        // D3D8: DrawIndexedPrimitive(this, PrimType, MinIndex, NumVertices, StartIndex, PrimCount)
        logDrawState(device, 'DrawIdxPrim', args[1], args[5]);
        return device.drawIndexedPrimitive(args[1], args[2], args[3], args[4], args[5]);
    };

    exports['IDirect3DDevice8_DrawPrimitiveUP'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;

        logDrawState(device, 'DrawPrimUP', args[1], args[2]);
        return device.drawPrimitiveUP(args[1], args[2], args[3], args[4]);
    };

    // DrawIndexedPrimitiveUP(this, PrimType, MinVertexIndex, NumVertices, PrimCount,
    //                        pIndexData, IndexDataFormat, pVertexStreamZeroData, Stride)
    exports['IDirect3DDevice8_DrawIndexedPrimitiveUP'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        if (!args[5] || !args[7]) return D3DERR_INVALIDCALL;

        logDrawState(device, 'DrawIdxPrimUP', args[1], args[4]);
        return device.drawIndexedPrimitiveUP(
            args[1], args[2], args[3], args[4],
            args[5], (args[6] >>> 0) === 102 /* D3DFMT_INDEX32 */,
            args[7], args[8] >>> 0,
        );
    };

    exports['IDirect3DDevice8_GetBackBuffer'] = (_ctx, mem, args) => {
        const devicePtr = args[0];
        const device = devices.get(devicePtr);
        if (!device) return D3DERR_INVALIDCALL;

        const ppSurface = args[3];
        if (!ppSurface) return D3DERR_INVALIDCALL;

        const surfPtr = ensureBackBufferSurface(devicePtr, device);
        if (!surfPtr) return D3DERR_INVALIDCALL;
        if (addComRef(surfPtr) === undefined) return D3DERR_INVALIDCALL;

        Mem.writeUint32(ppSurface, surfPtr);
        return D3D_OK;
    };

    // Same contract, same HRESULT values as d3d9 (D3D8 defines the identical facility codes).
    exports['IDirect3DDevice8_TestCooperativeLevel'] = (_ctx, _mem, args) => {
        const devicePtr = args[0] >>> 0;
        if (!devices.has(devicePtr)) return D3DERR_INVALIDCALL;
        switch (deviceCooperativeLevel(devicePtr)) {
            case "lost": return D3DERR_DEVICELOST;
            case "notreset": return D3DERR_DEVICENOTRESET;
            default: return D3D_OK;
        }
    };
    exports['IDirect3DDevice8_GetAvailableTextureMem'] = () => 256 * 1024 * 1024; // 256MB
    exports['IDirect3DDevice8_ResourceManagerDiscardBytes'] = (_ctx, _mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        // Evict D3DPOOL_MANAGED resources (we have no managed pool backing yet).
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetDisplayMode'] = (_ctx, _mem, args) => {
        const pMode = args[1];
        if (!pMode) return D3DERR_INVALIDCALL;
        const cfg = EmulatorConfig.getInstance().screenResolution;
        const ok =
            Mem.writeUint32(pMode + 0, cfg.width || 800) &&
            Mem.writeUint32(pMode + 4, cfg.height || 600) &&
            Mem.writeUint32(pMode + 8, cfg.refreshRate || 60) &&
            Mem.writeUint32(pMode + 12, 22); // D3DFMT_X8R8G8B8
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice8_GetDeviceCaps'] = (_ctx, mem, args) => {
        return writeDeviceCaps8(args[1], mem) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice8_GetRenderTarget'] = (_ctx, mem, args) => {
        const devicePtr = args[0];
        const device = devices.get(devicePtr);
        if (!device) return D3DERR_INVALIDCALL;

        const ppSurface = args[1];
        if (!ppSurface) return D3DERR_INVALIDCALL;

        const override = deviceRenderTargetOverride.get(devicePtr >>> 0) ?? 0;
        if (override !== 0 && surfaceInfo.has(override)) {
            if (addComRef(override) === undefined) return D3DERR_INVALIDCALL;
            Mem.writeUint32(ppSurface, override);
            return D3D_OK;
        }

        const surfPtr = ensureBackBufferSurface(devicePtr, device);
        if (!surfPtr) return D3DERR_INVALIDCALL;
        if (addComRef(surfPtr) === undefined) return D3DERR_INVALIDCALL;

        Mem.writeUint32(ppSurface, surfPtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice8_GetDepthStencilSurface'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        const ppSurface = args[1];
        if (!device || !ppSurface) return D3DERR_INVALIDCALL;

        let bound = device.depthStencilSurfacePtr || deviceBoundDepthStencil.get(args[0]) || 0;
        if (bound !== 0 && !isComObjectLive(bound)) {
            device.depthStencilSurfacePtr = 0;
            deviceBoundDepthStencil.delete(args[0]);
            bound = 0;
        }
        if (bound === 0) {
            // Faithful: a device with no depth-stencil returns D3DERR_NOTFOUND, NOT
            // D3D_OK. Engines that only check SUCCEEDED() would otherwise deref the
            // NULL we wrote (observed: AV at addr=0x0 right after device setup).
            if (!Mem.writeUint32(ppSurface, 0)) return D3DERR_INVALIDCALL;
            return D3DERR_NOTFOUND;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(ppSurface, bound, true);
        addComRef(bound);
        return D3D_OK;
    };

    return exports;
}
