/**
 * Explicit capability contract for the D3D9 float texture formats that have a bounded
 * native WebGPU storage path: the 16-bit and 32-bit R/RG/RGBA float families.
 *
 * WebGPU exposes no portable format-probe API.  Keep the D3D9 answer opt-in so
 * a browser/device that accepts the descriptor but cannot sample, upload, or
 * read it back never receives a falsely positive CheckDeviceFormat result.
 * Other D3D9 float formats remain outside this contract.  Render-target use is a
 * SECOND, separately probed contract on the same formats: a format can be sampleable
 * storage and still be refused as a color attachment, so the two answers never share
 * one flag.
 */

// Keep the numeric format definition in the shared format table; re-export it
// here so policy consumers can depend on this seam without duplicating values.
import {
    D3DFMT_A16B16G16R16F,
    D3DFMT_A32B32G32R32F,
    D3DFMT_G16R16F,
    D3DFMT_G32R32F,
    D3DFMT_R16F,
    D3DFMT_R32F,
    d3dFloatFormatInfo,
} from './texture-formats';
import { bumpCapabilityGeneration } from './capability-generation';
export {
    D3DFMT_A16B16G16R16F, D3DFMT_A32B32G32R32F, D3DFMT_G16R16F,
    D3DFMT_G32R32F, D3DFMT_R16F, D3DFMT_R32F,
} from './texture-formats';

export interface D3D9FloatCapabilityContract {
    /** Probe a native WebGPU `r16float` texture allocation. */
    supportsTexture(format: number): boolean;
    /** Probe queue.writeTexture/upload of the D3D9 little-endian texel rows. */
    supportsUpload(format: number): boolean;
    /** Probe shader sampling with a `texture_2d<f32>` view. */
    supportsSampling(format: number): boolean;
    /** Probe copy/readback or lock coherence for the format. */
    supportsReadback(format: number): boolean;
    /** Probe attachment + readback of a rendered texel for the format. */
    supportsRenderTarget(format: number): boolean;
    /** Probe whether a blended pipeline targeting the format is legal. */
    supportsRenderTargetBlending(format: number): boolean;
}

export interface D3D9FloatTexturePolicy {
    format: number;
    supported: boolean;
    gpuFormat: GPUTextureFormat | null;
    bytesPerTexel: number;
    reason: string | null;
}

function validContract(candidate: D3D9FloatCapabilityContract | undefined): candidate is D3D9FloatCapabilityContract {
    return !!candidate &&
        typeof candidate.supportsTexture === "function" &&
        typeof candidate.supportsUpload === "function" &&
        typeof candidate.supportsSampling === "function" &&
        typeof candidate.supportsReadback === "function" &&
        typeof candidate.supportsRenderTarget === "function" &&
        typeof candidate.supportsRenderTargetBlending === "function";
}

let activeFloatCapabilityContract: D3D9FloatCapabilityContract | null = null;

/** Return the probe published by the current live WebGPU device, or null before probing. */
export function getD3D9FloatCapabilityContract(): D3D9FloatCapabilityContract | null {
    return activeFloatCapabilityContract;
}

/** Publish or clear the result of the current device's real format probe. */
export function setD3D9FloatCapabilityContract(
    contract: D3D9FloatCapabilityContract | null,
): void {
    activeFloatCapabilityContract = contract && validContract(contract) ? contract : null;
    bumpCapabilityGeneration();
}

function unsupported(format: number, reason: string): D3D9FloatTexturePolicy {
    return { format: format >>> 0, supported: false, gpuFormat: null, bytesPerTexel: 0, reason };
}

function gpuFormatFor(format: number): GPUTextureFormat | null {
    switch (format >>> 0) {
        case D3DFMT_R16F: return 'r16float';
        case D3DFMT_G16R16F: return 'rg16float';
        case D3DFMT_A16B16G16R16F: return 'rgba16float';
        case D3DFMT_R32F: return 'r32float';
        case D3DFMT_G32R32F: return 'rg32float';
        case D3DFMT_A32B32G32R32F: return 'rgba32float';
        default: return null;
    }
}

/** Resolve the sampled-texture policy for one D3D9 float format. */
export function resolveD3D9FloatTexturePolicy(format: number): D3D9FloatTexturePolicy {
    const fmt = format >>> 0;
    const gpuFormat = gpuFormatFor(fmt);
    const info = d3dFloatFormatInfo(fmt);
    if (!gpuFormat || !info) {
        return unsupported(fmt, "only R/RG/RGBA float textures have a bounded native texture path");
    }
    const contract = getD3D9FloatCapabilityContract();
    if (!contract) return unsupported(fmt, "no explicit float adapter capability contract");
    try {
        if (!contract.supportsTexture(fmt) || !contract.supportsUpload(fmt) ||
            !contract.supportsSampling(fmt) || !contract.supportsReadback(fmt)) {
            return unsupported(fmt, "adapter probe rejected float texture storage/sampling");
        }
    } catch {
        return unsupported(fmt, "float adapter probe threw");
    }
    return {
        format: fmt,
        supported: true,
        gpuFormat,
        bytesPerTexel: info.channels * info.bytesPerChannel,
        reason: null,
    };
}

export function isD3D9FloatTextureFormatSupported(format: number): boolean {
    return resolveD3D9FloatTexturePolicy(format).supported;
}

/**
 * Resolve the RENDER-TARGET policy for one D3D9 float format.  A game that asks for an
 * HDR target (RA3's scene buffer) creates it whether or not we said yes to the
 * sub-capability queries around it, so the honest answer has to be backed by a real
 * attachment path, not by the sampled-storage answer above.
 */
export function resolveD3D9FloatRenderTargetPolicy(format: number): D3D9FloatTexturePolicy {
    const sampled = resolveD3D9FloatTexturePolicy(format);
    if (!sampled.supported) return sampled;
    const contract = getD3D9FloatCapabilityContract();
    if (!contract) return unsupported(format, "no explicit float adapter capability contract");
    try {
        if (!contract.supportsRenderTarget(format >>> 0)) {
            return unsupported(format, "adapter probe rejected float color attachment");
        }
    } catch {
        return unsupported(format, "float render-target probe threw");
    }
    return sampled;
}

export function isD3D9FloatRenderTargetSupported(format: number): boolean {
    return resolveD3D9FloatRenderTargetPolicy(format).supported;
}

/**
 * Can a pipeline BLEND into this float target?  Separate from attachment: WebGPU allows
 * r32float as a color attachment everywhere and as a blend target almost nowhere, and a
 * pipeline that asks for blending it cannot have is a validation error that discards the
 * whole pass — so the answer gates both the capability query and the pipeline descriptor.
 */
export function isD3D9FloatRenderTargetBlendable(format: number): boolean {
    if (!resolveD3D9FloatRenderTargetPolicy(format).supported) return false;
    const contract = getD3D9FloatCapabilityContract();
    if (!contract) return false;
    try {
        return contract.supportsRenderTargetBlending(format >>> 0);
    } catch {
        return false;
    }
}

/** Is this GPU color format one a pipeline may declare a blend state for? */
export function isGpuColorFormatBlendable(format: GPUTextureFormat): boolean {
    switch (format) {
        case "r16float": return isD3D9FloatRenderTargetBlendable(D3DFMT_R16F);
        case "rg16float": return isD3D9FloatRenderTargetBlendable(D3DFMT_G16R16F);
        case "rgba16float": return isD3D9FloatRenderTargetBlendable(D3DFMT_A16B16G16R16F);
        case "r32float": return isD3D9FloatRenderTargetBlendable(D3DFMT_R32F);
        case "rg32float": return isD3D9FloatRenderTargetBlendable(D3DFMT_G32R32F);
        case "rgba32float": return isD3D9FloatRenderTargetBlendable(D3DFMT_A32B32G32R32F);
        // Every other format this backend renders into is 8-bit unorm, always blendable.
        default: return true;
    }
}

/**
 * Build a WebGPU queue.writeTexture payload from a tightly packed D3D9 float
 * row store.  The guest pitch may include padding; WebGPU's copy layout uses
 * a 256-byte row stride, so padding is added to a transient upload buffer.
 */
export function makeD3D9FloatUpload(
    source: Uint8Array,
    width: number,
    height: number,
    pitch: number,
    bytesPerTexel: number,
): { data: Uint8Array; bytesPerRow: number } | null {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width <= 0 || height <= 0 || !Number.isSafeInteger(pitch) ||
        !Number.isSafeInteger(bytesPerTexel) || bytesPerTexel <= 0) return null;
    const rowBytes = width * bytesPerTexel;
    const sourceBytes = pitch * height;
    if (!Number.isSafeInteger(rowBytes) || !Number.isSafeInteger(sourceBytes) ||
        pitch < rowBytes || source.byteLength < sourceBytes) return null;
    const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
    const uploadBytes = bytesPerRow * height;
    if (!Number.isSafeInteger(uploadBytes)) return null;
    const data = new Uint8Array(uploadBytes);
    for (let row = 0; row < height; row++) {
        data.set(source.subarray(row * pitch, row * pitch + rowBytes), row * bytesPerRow);
    }
    return { data, bytesPerRow };
}

/** Backwards-compatible R16F helper for callers that only need the first format seam. */
export function makeD3D9R16FUpload(
    source: Uint8Array,
    width: number,
    height: number,
    pitch: number,
): { data: Uint8Array; bytesPerRow: number } | null {
    return makeD3D9FloatUpload(source, width, height, pitch, 2);
}
