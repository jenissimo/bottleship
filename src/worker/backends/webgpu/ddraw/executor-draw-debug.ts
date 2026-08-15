/**
 * Draw-time debug/diagnostic helpers for the DDraw WebGPU executor — contained-UV
 * clamp probe, sampler debug overrides, and last-draw diagnostics capture. Run
 * only when a debug flag is set (off by default); touch only
 * debugFlags/lastDrawDiagnostics. Take the executor as `self`.
 */
import { PrepareDrawResult } from './types';
import { MAX_FFP_SAMPLED_STAGES } from './ffp-stages';
import {
    D3DTFN_POINT, D3DTFN_LINEAR, D3DTFG_POINT, D3DTFG_LINEAR, D3DTFP_NONE,
    D3DTADDRESS_CLAMP, D3DTADDRESS_WRAP, D3DFVF_DIFFUSE, D3DFVF_SPECULAR, D3DFVF_XYZRHW,
} from '../../../modules/ddraw/constants';

export function maybeClampContainedUv(self: any,
        pr: PrepareDrawResult,
        memory: Uint8Array,
        verticesAddr: number,
        vertexCount: number,
        stride: number,
        vertexType: number
    ): void {
        if (self.debugFlags.disableContainedUvClamp || (pr.sampledMask & 1) === 0) return;
        if (vertexCount <= 0 || vertexCount > 4096) return;
        if ((vertexType & 0x000e) !== D3DFVF_XYZRHW) return;
        if (((vertexType >> 8) & 0xf) < 1) return;
        const s0 = pr.stageSamplers[0];
        const wantU = s0.addressU === D3DTADDRESS_WRAP;
        const wantV = s0.addressV === D3DTADDRESS_WRAP;
        if (!wantU && !wantV) return;
        if (s0.magFilter !== D3DTFG_LINEAR && s0.minFilter !== D3DTFN_LINEAR) return;

        let uvOff = 16; // XYZRHW position incl. rhw
        if (vertexType & D3DFVF_DIFFUSE) uvOff += 4;
        if (vertexType & D3DFVF_SPECULAR) uvOff += 4;
        if (uvOff + 8 > stride) return;

        const end = verticesAddr + (vertexCount - 1) * stride + uvOff + 8;
        if (verticesAddr <= 0 || end > memory.length) return;

        // Never cache views into v86 memory — create per call (guest mem can detach).
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        const eps = 1e-3;
        let okU = wantU, okV = wantV;
        for (let i = 0; i < vertexCount && (okU || okV); i++) {
            const base = verticesAddr + i * stride + uvOff;
            const u = view.getFloat32(base, true);
            const v = view.getFloat32(base + 4, true);
            if (okU && !(u >= -eps && u <= 1 + eps)) okU = false; // NaN fails the predicate too
            if (okV && !(v >= -eps && v <= 1 + eps)) okV = false;
        }
        if (okU) s0.addressU = D3DTADDRESS_CLAMP;
        if (okV) s0.addressV = D3DTADDRESS_CLAMP;
        self.lastDrawDiagnostics.addressU = s0.addressU;
        self.lastDrawDiagnostics.addressV = s0.addressV;
    }

export function applySamplerDebugOverrides(self: any, pr: PrepareDrawResult): void {
        if (!self.debugFlags.forcePointFilter) return;
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            const sp = pr.stageSamplers[s];
            sp.minFilter = D3DTFN_POINT;
            sp.magFilter = D3DTFG_POINT;
            sp.mipFilter = D3DTFP_NONE;
        }
    }

export function updateLastDrawDiagnostics(self: any, pr: PrepareDrawResult): void {
        const d = self.lastDrawDiagnostics;
        const s0 = pr.stageSamplers[0];
        d.valid = true;
        d.useTexture = (pr.sampledMask & 1) !== 0;
        d.minFilter = s0.minFilter;
        d.magFilter = s0.magFilter;
        d.mipFilter = s0.mipFilter;
        d.addressU = s0.addressU;
        d.addressV = s0.addressV;
        d.maxAnisotropy = s0.maxAnisotropy;
        d.forcePointFilter = self.debugFlags.forcePointFilter;
    }
