/**
 * Explicit capability contract for the one float texture format that has a
 * bounded native WebGPU storage path today: the D3D9 16-bit float texture family.
 *
 * WebGPU exposes no portable format-probe API.  Keep the D3D9 answer opt-in so
 * a browser/device that accepts the descriptor but cannot sample, upload, or
 * read it back never receives a falsely positive CheckDeviceFormat result.
 * Other D3D9 float formats, and all float render-targets, remain outside this
 * contract until their attachment and conversion paths are independently
 * proven.
 */

// Keep the numeric format definition in the shared format table; re-export it
// here so policy consumers can depend on this seam without duplicating values.
import {
    D3DFMT_A16B16G16R16F,
    D3DFMT_G16R16F,
    D3DFMT_R16F,
    d3dFloatFormatInfo,
} from './texture-formats';
import { bumpCapabilityGeneration } from './capability-generation';
export { D3DFMT_A16B16G16R16F, D3DFMT_G16R16F, D3DFMT_R16F } from './texture-formats';

export interface D3D9FloatCapabilityContract {
    /** Probe a native WebGPU `r16float` texture allocation. */
    supportsTexture(format: number): boolean;
    /** Probe queue.writeTexture/upload of the D3D9 little-endian texel rows. */
    supportsUpload(format: number): boolean;
    /** Probe shader sampling with a `texture_2d<f32>` view. */
    supportsSampling(format: number): boolean;
    /** Probe copy/readback or lock coherence for the format. */
    supportsReadback(format: number): boolean;
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
        typeof candidate.supportsReadback === "function";
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
        default: return null;
    }
}

/** Resolve the sampled-texture policy for one D3D9 float format. */
export function resolveD3D9FloatTexturePolicy(format: number): D3D9FloatTexturePolicy {
    const fmt = format >>> 0;
    const gpuFormat = gpuFormatFor(fmt);
    const info = d3dFloatFormatInfo(fmt);
    if (!gpuFormat || !info || info.bytesPerChannel !== 2) {
        return unsupported(fmt, "only 16-bit R/RG/RGBA float textures have a bounded native texture path");
    }
    const contract = getD3D9FloatCapabilityContract();
    if (!contract) return unsupported(fmt, "no explicit 16-bit-float adapter capability contract");
    try {
        if (!contract.supportsTexture(fmt) || !contract.supportsUpload(fmt) ||
            !contract.supportsSampling(fmt) || !contract.supportsReadback(fmt)) {
            return unsupported(fmt, "adapter probe rejected 16-bit-float texture storage/sampling");
        }
    } catch {
        return unsupported(fmt, "16-bit-float adapter probe threw");
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
