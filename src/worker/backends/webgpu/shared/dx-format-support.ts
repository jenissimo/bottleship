/**
 * Shared DirectX 8/9 adapter-format validation for CheckDeviceType /
 * CheckDeviceFormat / CheckDepthStencilMatch / CheckDeviceMultiSampleType.
 *
 * One implementation, parameterised by `version` (8 | 9). The HAL rules are the same
 * shape across the two APIs; only the valid format SETS differ — D3D9 is a superset
 * (A8B8G8R8, A2R10G10B10, A16B16G16R16, floating-point formats, lockable/float depth).
 * Unify the common logic, branch only where the version semantics genuinely differ
 * (the format sets).
 *
 * Design rationale:
 * engines enumerate format support and build per-format descriptor tables; a stray
 * D3DERR_NOTAVAILABLE leaves a NULL hole they then copy from -> #PF. When the
 * adapter format is *unknown* (Morrowind cube-map scan garbage), stay permissive.
 * When adapterFormat is a real display format, CheckDeviceFormat reports what our
 * HAL can do — not theoretical 1999 VRAM bpp limits. We convert every accepted
 * uncompressed format on the GPU path, and modern D3D9 drivers do the same (PoP
 * SoT launcher probes adapter=R5G6B5 + check=A8R8G8B8 and expects OK). GTA III
 * CAPS.DAT probes use the current 32-bit desktop adapter and are unaffected.
 */

import { isDxtFormat } from './texture-formats';

export type DxVersion = 8 | 9;

export const D3D_OK = 0;
export const D3DERR_INVALIDCALL = 0x8876086c;
export const D3DERR_NOTAVAILABLE = 0x8876086a;

const D3DFMT_UNKNOWN = 0;
const D3DFMT_VERTEXDATA = 100;
const D3DFMT_INDEX16 = 101;
const D3DFMT_INDEX32 = 102;

// Color formats valid in both versions and referenced by name below.
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_X1R5G5B5 = 24;
const D3DFMT_A1R5G5B5 = 25;
const D3DFMT_A4R4G4B4 = 26;
const D3DFMT_X4R4G4B4 = 30;
const D3DFMT_A2R10G10B10 = 35;
const D3DFMT_A2B10G10R10 = 31;
const D3DFMT_A16B16G16R16 = 36;
const D3DFMT_A8 = 28;
const D3DFMT_A8P8 = 40;
const D3DFMT_P8 = 41;
const D3DFMT_L8 = 50;
const D3DFMT_A8L8 = 51;
const D3DFMT_A4L4 = 52;
const FOURCC_NULL = 0x4c4c554e; // 'NULL'

// Usage / resource-type / device-type enums (identical across DX8 & DX9).
const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_DEPTHSTENCIL = 0x2;
const D3DUSAGE_QUERY_VERTEXTEXTURE = 0x4;

const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DRTYPE_VERTEXBUFFER = 6;
const D3DRTYPE_INDEXBUFFER = 7;

const D3DDEVTYPE_HAL = 1;
const D3DDEVTYPE_REF = 2;
const D3DDEVTYPE_SW = 3;

const D3DMULTISAMPLE_NONE = 0;
const D3DMULTISAMPLE_NONMASKABLE = 1;
const D3DMULTISAMPLE_2_SAMPLES = 2;
const D3DMULTISAMPLE_4_SAMPLES = 4;

// Depth/stencil formats. D3D9 adds the lockable/floating-point depth variants.
const DEPTH_STENCIL_COMMON = new Set([
    70, // D16_LOCKABLE
    71, // D32
    73, // D15S1
    75, // D24S8
    77, // D24X8
    79, // D24X4S4
    80, // D16
]);
const DEPTH_STENCIL_D3D9_ONLY = new Set([
    82, // D32F_LOCKABLE
    83, // D24FS8
]);

// Formats introduced in D3D9 — NOT valid on a D3D8 device, valid on D3D9.
const D3D9_ONLY_FORMATS = new Set([
    32, 33,          // A8B8G8R8 / X8B8G8R8
    35, 36,          // A2R10G10B10 / A16B16G16R16
    81,              // L16
    82, 83, 84, 85,  // D32F_LOCKABLE / D24FS8 / D32_LOCKABLE / S8_LOCKABLE
    110,             // Q16W16V16U16
    111, 112, 113,   // R16F / G16R16F / A16B16G16R16F
    114, 115, 116,   // R32F / G32R32F / A32B32G32R32F
    117,             // CxV8U8
]);

// Floating-point render-target formats (D3D9 only).
const D3D9_FLOAT_RT = new Set([111, 112, 113, 114, 115, 116]);

/** Formats that exist only in a newer DX version than `version` (must be rejected). */
export function isDxExclusiveFormat(format: number, version: DxVersion): boolean {
    if (version === 9) return false; // D3D9 supports its full superset
    return D3D9_ONLY_FORMATS.has(format >>> 0);
}

export function isDxDepthStencilFormat(format: number, version: DxVersion): boolean {
    const fmt = format >>> 0;
    if (DEPTH_STENCIL_COMMON.has(fmt)) return true;
    if (version === 9 && DEPTH_STENCIL_D3D9_ONLY.has(fmt)) return true;
    return false;
}

/** Valid adapter/display (front-buffer) formats. */
export function isDxDisplayFormat(format: number, version: DxVersion): boolean {
    const fmt = format >>> 0;
    if (fmt === D3DFMT_R5G6B5 || fmt === D3DFMT_X1R5G5B5 || fmt === D3DFMT_X8R8G8B8 || fmt === D3DFMT_A8R8G8B8) {
        return true;
    }
    if (version === 9 && fmt === D3DFMT_A2R10G10B10) return true; // 10-bit display mode (D3D9)
    return false;
}

/**
 * Strict "real-hardware" render-target / back-buffer format set (used by CheckDeviceType
 * back-buffer validation and CreateRenderTarget). Broader than display formats — includes
 * the 16-bit alpha variants — but not every RGB format. See isDxRenderableFormat for the
 * permissive set used by capability ENUMERATION.
 */
export function isDxRenderTargetFormat(format: number, version: DxVersion): boolean {
    const fmt = format >>> 0;
    if (
        fmt === D3DFMT_R5G6B5 ||
        fmt === D3DFMT_X1R5G5B5 ||
        fmt === D3DFMT_A1R5G5B5 ||
        fmt === D3DFMT_A4R4G4B4 ||
        fmt === D3DFMT_X4R4G4B4 ||
        fmt === D3DFMT_X8R8G8B8 ||
        fmt === D3DFMT_A8R8G8B8 ||
        fmt === FOURCC_NULL
    ) {
        return true;
    }
    if (version === 9 && (fmt === D3DFMT_A2R10G10B10 || fmt === D3DFMT_A2B10G10R10 ||
        fmt === D3DFMT_A16B16G16R16 || D3D9_FLOAT_RT.has(fmt))) {
        return true;
    }
    return false;
}

/**
 * Formats our WebGPU HLE can render to. We back every surface with an rgba8 (or wider)
 * target and convert, so any uncompressed RGB/alpha format is genuinely renderable for
 * us — a truthful statement of OUR HAL's capability, used for capability enumeration so
 * we never leave NULL holes in an engine's per-format table. Reject only what we cannot
 * represent: compressed (DXT), depth-stencil, palettized, wrong-version-exclusive,
 * UNKNOWN, and the buffer "formats".
 */
export function isDxRenderableFormat(format: number, version: DxVersion): boolean {
    const fmt = format >>> 0;
    if (fmt === FOURCC_NULL) return true;
    if (fmt === D3DFMT_UNKNOWN || fmt === D3DFMT_VERTEXDATA) return false;
    if (isDxExclusiveFormat(fmt, version)) return false;
    if (isDxDepthStencilFormat(fmt, version)) return false;
    if (isDxtFormat(fmt)) return false;
    if (fmt === D3DFMT_P8 || fmt === D3DFMT_A8P8) return false;
    if (fmt === D3DFMT_INDEX16 || fmt === D3DFMT_INDEX32) return false;
    return true;
}

function isValidDeviceType(devType: number): boolean {
    return devType === D3DDEVTYPE_HAL || devType === D3DDEVTYPE_REF || devType === D3DDEVTYPE_SW;
}

/** Bit depth of a known display (adapter) format; null if unrecognized. */
export function adapterBppDepth(adapterFormat: number, version: DxVersion): number | null {
    const fmt = adapterFormat >>> 0;
    if (fmt === D3DFMT_R5G6B5 || fmt === D3DFMT_X1R5G5B5) return 16;
    if (fmt === D3DFMT_X8R8G8B8 || fmt === D3DFMT_A8R8G8B8) return 32;
    if (version === 9 && fmt === D3DFMT_A2R10G10B10) return 32;
    return null;
}

/** Bit depth of an uncompressed texture format; null = not bpp-gated (DXT / unknown). */
export function textureBppDepth(checkFormat: number): number | null {
    const fmt = checkFormat >>> 0;
    if (isDxtFormat(fmt)) return null;
    switch (fmt) {
        case D3DFMT_A8R8G8B8:
        case D3DFMT_X8R8G8B8:
        case D3DFMT_A2B10G10R10:
        case D3DFMT_A2R10G10B10:
        case D3DFMT_A16B16G16R16:
            return 32;
        case D3DFMT_R5G6B5:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_A4R4G4B4:
        case D3DFMT_X4R4G4B4:
        case D3DFMT_A8P8:
            return 16;
        case D3DFMT_A8:
        case D3DFMT_P8:
        case D3DFMT_L8:
        case D3DFMT_A8L8:
        case D3DFMT_A4L4:
            return 8;
        default:
            return null;
    }
}

/**
 * Whether checkFormat is usable on adapterFormat for CheckDeviceFormat. Our WebGPU
 * HAL converts every accepted texture format regardless of adapter display bpp;
 * modern D3D9 drivers report the same permissive capability (PoP SoT detection).
 */
export function isDxTextureFormatCompatibleWithAdapter(
    _adapterFormat: number,
    _checkFormat: number,
    _version: DxVersion,
): boolean {
    return true;
}

export function checkDxDeviceType(
    version: DxVersion,
    adapter: number,
    devType: number,
    adapterFormat: number,
    backBufferFormat: number,
    _windowed: number,
): number {
    if (adapter !== 0) return D3DERR_INVALIDCALL;
    if (!isValidDeviceType(devType)) return D3DERR_INVALIDCALL;
    if (!isDxDisplayFormat(adapterFormat, version)) return D3DERR_NOTAVAILABLE;
    if (!isDxRenderTargetFormat(backBufferFormat, version)) return D3DERR_NOTAVAILABLE;
    return D3D_OK;
}

export function checkDxDeviceFormat(
    version: DxVersion,
    adapter: number,
    deviceType: number,
    adapterFormat: number,
    usage: number,
    rType: number,
    checkFormat: number,
): number {
    if (adapter !== 0) return D3DERR_INVALIDCALL;
    if (!isValidDeviceType(deviceType)) return D3DERR_INVALIDCALL;

    const fmt = checkFormat >>> 0;
    if (fmt === D3DFMT_UNKNOWN) return D3DERR_NOTAVAILABLE;
    if (isDxExclusiveFormat(fmt, version)) return D3DERR_NOTAVAILABLE;
    // D3D9 dropped palettized textures — no D3D9 driver advertises P8/A8P8 here (Wine and
    // DXVK refuse them too). Saying yes is not harmlessly permissive: a game's "pick the
    // best format for this card" pass then CHOOSES palettized for everything, and D3D9 has
    // no palette to resolve it with. D3D8 keeps them; palettized surfaces are a normal
    // D3D8 path we convert.
    if (version === 9 && (fmt === D3DFMT_P8 || fmt === D3DFMT_A8P8)) return D3DERR_NOTAVAILABLE;
    if ((usage & D3DUSAGE_RENDERTARGET) && !isDxRenderableFormat(fmt, version)) return D3DERR_NOTAVAILABLE;
    if ((usage & D3DUSAGE_DEPTHSTENCIL) && !isDxDepthStencilFormat(fmt, version)) return D3DERR_NOTAVAILABLE;
    if ((usage & D3DUSAGE_QUERY_VERTEXTEXTURE) !== 0) return D3DERR_NOTAVAILABLE;

    switch (rType) {
        case D3DRTYPE_SURFACE:
        case D3DRTYPE_TEXTURE:
        case D3DRTYPE_VOLUMETEXTURE:
        case D3DRTYPE_CUBETEXTURE:
            // Report support for any real (non-exclusive, non-UNKNOWN) format across
            // surface/texture/volume/cube — our HLE backs/converts them all and a capable
            // card advertises cube/volume support. A depth format is only valid here when
            // DEPTHSTENCIL usage is asked.
            if (isDxDepthStencilFormat(fmt, version)) {
                return (usage & D3DUSAGE_DEPTHSTENCIL) !== 0 ? D3D_OK : D3DERR_NOTAVAILABLE;
            }
            return D3D_OK;
        case D3DRTYPE_VERTEXBUFFER:
            return fmt === D3DFMT_VERTEXDATA ? D3D_OK : D3DERR_NOTAVAILABLE;
        case D3DRTYPE_INDEXBUFFER:
            return fmt === D3DFMT_INDEX16 || fmt === D3DFMT_INDEX32 ? D3D_OK : D3DERR_NOTAVAILABLE;
        default:
            return D3DERR_NOTAVAILABLE;
    }
}

export function checkDxDepthStencilMatch(
    version: DxVersion,
    adapter: number,
    deviceType: number,
    _adapterFormat: number,
    renderTargetFormat: number,
    depthStencilFormat: number,
): number {
    if (adapter !== 0) return D3DERR_INVALIDCALL;
    if (!isValidDeviceType(deviceType)) return D3DERR_INVALIDCALL;

    const rt = renderTargetFormat >>> 0;
    const ds = depthStencilFormat >>> 0;
    if (isDxExclusiveFormat(rt, version) || isDxExclusiveFormat(ds, version)) return D3DERR_NOTAVAILABLE;
    // Use the SAME renderable set CheckDeviceFormat advertises (consistency: an RT ok in
    // CheckDeviceFormat but rejected here leaves a NULL table hole -> crash).
    if (!isDxRenderableFormat(rt, version)) return D3DERR_NOTAVAILABLE;
    if (!isDxDepthStencilFormat(ds, version)) return D3DERR_NOTAVAILABLE;

    // Faithful HAL: any supported render-target pairs with any supported depth-stencil.
    // Real cards do NOT enforce RT<->DS bit-depth matching (A8R8G8B8 + D16 is universal).
    return D3D_OK;
}

export function checkDxDeviceMultiSampleType(
    version: DxVersion,
    adapter: number,
    deviceType: number,
    surfaceFormat: number,
    _windowed: number,
    multiSampleType: number,
): number {
    if (adapter !== 0) return D3DERR_INVALIDCALL;
    if (!isValidDeviceType(deviceType)) return D3DERR_INVALIDCALL;
    if (!isDxRenderableFormat(surfaceFormat, version) && !isDxDepthStencilFormat(surfaceFormat, version)) {
        return D3DERR_NOTAVAILABLE;
    }
    // Our WebGPU backend resolves multisampled color/depth (MsaaColorManager + DepthManager)
    // at sample counts 2 and 4, so advertise exactly those to guest engines that gate their
    // in-engine AA on CheckDeviceMultiSampleType. NONMASKABLE (driver-chosen, no fixed count)
    // is trivially satisfiable — we pick a supported count internally. All other n_SAMPLES
    // (3/5/6/7/8/16) stay NOTAVAILABLE since we don't back those sample counts.
    switch (multiSampleType >>> 0) {
        case D3DMULTISAMPLE_NONE:
        case D3DMULTISAMPLE_NONMASKABLE:
        case D3DMULTISAMPLE_2_SAMPLES:
        case D3DMULTISAMPLE_4_SAMPLES:
            return D3D_OK;
        default:
            return D3DERR_NOTAVAILABLE;
    }
}
