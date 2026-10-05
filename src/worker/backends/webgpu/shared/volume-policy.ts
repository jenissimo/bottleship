/**
 * D3D9 volume-texture capability contract.
 *
 * WebGPU does not expose a portable "3-D texture support" probe that can be
 * inferred from a TypeScript type.  In particular, a device may accept a
 * texture_3d descriptor but still reject one of the formats, dimensions, or
 * sampler combinations used by a D3D9 title.  Keep the public D3D9 answer
 * opt-in and let the host install a contract only after probing the actual
 * adapter/device path.
 */

import { bumpCapabilityGeneration } from './capability-generation';

export const D3DFMT_A8R8G8B8 = 21;

/**
 * Formats the 3-D upload path really converts.  A volume level is decoded by
 * decodeD3DTextureToRgba8 and written into one rgba8unorm texture_3d, so the format
 * question is "does that decoder unpack this texel", not "is there a native 3-D
 * format".  Keeping the answer to ARGB8 alone refused the common case: an
 * X8R8G8B8/L8/DXT volume LUT, which every era card and DXVK accept.
 *
 * Deliberately absent: palettized (no palette on the 3-D path and D3D9 dropped them),
 * float (the rgba8 shadow is lossy), depth, and the BC4/5 vendor FourCCs, which were
 * never an era volume capability.  Numeric literals keep this module free of the
 * texture-formats import cycle, exactly like dx-format-support's FourCC set.
 */
export const D3D9_VOLUME_UPLOAD_FORMATS: ReadonlySet<number> = new Set([
    20, 21, 22, 23, 24, 25, 26, 27, 29, 30, // R8G8B8..X4R4G4B4 packed color
    31, 32, 33, 34, 35, 36,                 // A2B10G10R10 / A8B8G8R8 / X8B8G8R8 / G16R16 / A2R10G10B10 / A16B16G16R16
    28, 50, 51, 52, 81,                     // A8 / L8 / A8L8 / A4L4 / L16
    60, 61, 62, 63, 64, 65, 67, 110,        // signed bump (V8U8 .. Q16W16V16U16)
    0x31545844, 0x32545844, 0x33545844, 0x34545844, 0x35545844, // DXT1..DXT5
]);

// D3DPTEXTURECAPS values from d3d9types.h.
export const D3DPTEXTURECAPS_VOLUMEMAP = 0x00002000;
export const D3DPTEXTURECAPS_MIPVOLUMEMAP = 0x00008000;

// D3DPTFILTERCAPS values from d3d9types.h.  These are the fields in
// D3DCAPS9.VolumeTextureFilterCaps (not the sampler-state enum values).
export const D3DPTFILTERCAPS_MINFPOINT = 0x00000100;
export const D3DPTFILTERCAPS_MINFLINEAR = 0x00000200;
export const D3DPTFILTERCAPS_MIPFPOINT = 0x00010000;
export const D3DPTFILTERCAPS_MIPFLINEAR = 0x00020000;
export const D3DPTFILTERCAPS_MAGFPOINT = 0x01000000;
export const D3DPTFILTERCAPS_MAGFLINEAR = 0x02000000;

export const D3D9_VOLUME_FILTER_CAPS_MASK =
    D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MINFLINEAR |
    D3DPTFILTERCAPS_MIPFPOINT | D3DPTFILTERCAPS_MIPFLINEAR |
    D3DPTFILTERCAPS_MAGFPOINT | D3DPTFILTERCAPS_MAGFLINEAR;

// D3DPTADDRESSCAPS values.  The shader sampler lowering supports all of these
// modes, but the adapter contract still has to opt in to the exact subset it
// probed rather than inheriting the 2-D caps blindly.
export const D3DPTADDRESSCAPS_WRAP = 0x00000001;
export const D3DPTADDRESSCAPS_MIRROR = 0x00000002;
export const D3DPTADDRESSCAPS_CLAMP = 0x00000004;
export const D3DPTADDRESSCAPS_BORDER = 0x00000008;
export const D3DPTADDRESSCAPS_MIRRORONCE = 0x00000020;

export const D3D9_VOLUME_ADDRESS_CAPS_MASK =
    D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_MIRROR |
    D3DPTADDRESSCAPS_CLAMP | D3DPTADDRESSCAPS_BORDER |
    D3DPTADDRESSCAPS_MIRRORONCE;

export interface D3D9VolumeCapabilityContract {
    /** True only after a real texture_3d allocation/upload/sample probe. */
    supportsTexture3D(format: number): boolean;
    /** Maximum edge length accepted by the adapter's 3-D texture path. */
    maxExtent: number;
    /** D3DCAPS9.VolumeTextureFilterCaps mask established by the probe. */
    filterCaps: number;
    /** D3DCAPS9.VolumeTextureAddressCaps mask established by the probe. */
    addressCaps: number;
    /** Optional per-format mip-generation probe. False by default. */
    supportsAutoGenMipmaps?: (format: number) => boolean;
}

export interface D3D9VolumePolicy {
    version: 8 | 9;
    format: number;
    supported: boolean;
    maxExtent: number;
    filterCaps: number;
    addressCaps: number;
    supportsAutoGenMipmaps: boolean;
    reason: string | null;
}

function validExtent(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
}

function validContract(candidate: D3D9VolumeCapabilityContract | undefined): candidate is D3D9VolumeCapabilityContract {
    if (!candidate || typeof candidate.supportsTexture3D !== "function") return false;
    if (!validExtent(candidate.maxExtent)) return false;
    if (!Number.isInteger(candidate.filterCaps) ||
        (candidate.filterCaps & ~D3D9_VOLUME_FILTER_CAPS_MASK) !== 0 ||
        (candidate.filterCaps & (D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MAGFPOINT)) === 0) {
        return false;
    }
    if (!Number.isInteger(candidate.addressCaps) ||
        (candidate.addressCaps & ~D3D9_VOLUME_ADDRESS_CAPS_MASK) !== 0 ||
        candidate.addressCaps === 0) {
        return false;
    }
    if (candidate.supportsAutoGenMipmaps !== undefined &&
        typeof candidate.supportsAutoGenMipmaps !== "function") return false;
    return true;
}

let activeVolumeCapabilityContract: D3D9VolumeCapabilityContract | null = null;

/** Read the probe published by the current live WebGPU device. Missing/invalid means unsupported. */
export function getD3D9VolumeCapabilityContract(): D3D9VolumeCapabilityContract | null {
    return activeVolumeCapabilityContract;
}

/** Publish or clear the result of the current device's real 3-D texture probe. */
export function setD3D9VolumeCapabilityContract(
    contract: D3D9VolumeCapabilityContract | null,
): void {
    activeVolumeCapabilityContract = contract && validContract(contract) ? contract : null;
    bumpCapabilityGeneration();
}

function unsupported(version: 8 | 9, format: number, reason: string): D3D9VolumePolicy {
    return {
        version,
        format: format >>> 0,
        supported: false,
        maxExtent: 0,
        filterCaps: 0,
        addressCaps: 0,
        supportsAutoGenMipmaps: false,
        reason,
    };
}

/** Resolve the public capability for one volume format. */
export function resolveD3D9VolumePolicy(version: 8 | 9, format: number): D3D9VolumePolicy {
    const fmt = format >>> 0;
    if (version !== 9) return unsupported(version, fmt, "D3D8 volume textures are not exposed by this backend");
    const contract = getD3D9VolumeCapabilityContract();
    if (!contract) {
        return unsupported(9, fmt, "no explicit texture_3d adapter capability contract");
    }
    let formatSupported = false;
    try {
        formatSupported = contract.supportsTexture3D(fmt) === true;
    } catch {
        formatSupported = false;
    }
    if (!formatSupported) return unsupported(9, fmt, "adapter probe rejected this volume format");

    let autoGen = false;
    if (contract.supportsAutoGenMipmaps) {
        try { autoGen = contract.supportsAutoGenMipmaps(fmt) === true; } catch { autoGen = false; }
    }
    return {
        version: 9,
        format: fmt,
        supported: true,
        maxExtent: contract.maxExtent,
        filterCaps: contract.filterCaps >>> 0,
        addressCaps: contract.addressCaps >>> 0,
        supportsAutoGenMipmaps: autoGen,
        reason: null,
    };
}

/** Validate the dimensions before a caller attempts CreateVolumeTexture. */
export function isD3D9VolumeExtentSupported(
    width: number,
    height: number,
    depth: number,
    policy: D3D9VolumePolicy,
): boolean {
    if (!policy.supported || !validExtent(policy.maxExtent)) return false;
    return [width, height, depth].every((value) => Number.isSafeInteger(value) && value > 0 && value <= policy.maxExtent);
}

/** The D3DCAPS9 TextureCaps bits corresponding to an accepted mipmapped volume path. */
export function d3d9VolumeTextureCapsBits(policy: D3D9VolumePolicy): number {
    return policy.supported ? D3DPTEXTURECAPS_VOLUMEMAP | D3DPTEXTURECAPS_MIPVOLUMEMAP : 0;
}
