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

import {
    d3dFloatFormatInfo,
    D3DFMT_ATI1,
    D3DFMT_ATI2,
    D3DFMT_DXT1,
    D3DFMT_DXT2,
    D3DFMT_DXT3,
    D3DFMT_DXT4,
    D3DFMT_DXT5,
    isBlockCompressedFormat,
    isDxtFormat,
} from './texture-formats';
import { resolveDxMsaaPolicy } from './msaa-policy';
import { resolveD3D9VolumePolicy } from './volume-policy';
import { resolveD3D9FloatTexturePolicy } from './float-format-policy';
import { getD3D9MsaaCapabilityContract } from '../d3d9/multisample';
import { capabilityGeneration } from './capability-generation';

export type DxVersion = 8 | 9;

export const D3D_OK = 0;
export const D3DERR_INVALIDCALL = 0x8876086c;
export const D3DERR_NOTAVAILABLE = 0x8876086a;
/** MAKE_D3DSTATUS(2159) — a SUCCESS code: "the format is supported, but the runtime will
 *  not auto-generate its mip sublevels". The documented answer to a D3DUSAGE_AUTOGENMIPMAP
 *  query on hardware that cannot do it, and what Wine returns (wined3d WINED3DOK_NOMIPGEN). */
export const D3DOK_NOAUTOGEN = 0x0876086f;

const D3DFMT_UNKNOWN = 0;
const D3DFMT_VERTEXDATA = 100;
const D3DFMT_INDEX16 = 101;
const D3DFMT_INDEX32 = 102;

// Color formats valid in both versions and referenced by name below.
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_A8B8G8R8 = 32;
const D3DFMT_X8B8G8R8 = 33;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_X1R5G5B5 = 24;
const D3DFMT_A1R5G5B5 = 25;
const D3DFMT_A4R4G4B4 = 26;
const D3DFMT_R3G3B2 = 27;
const D3DFMT_A8R3G3B2 = 29;
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
const D3DFMT_Q16W16V16U16 = 110;
const FOURCC_NULL = 0x4c4c554e; // 'NULL'

// FourCC values are not an open-ended format namespace. These are the only
// legacy FourCCs with a decoder/storage path in this worker; rejecting the rest
// keeps capability queries from claiming vendor depth, video, or private formats.
const SUPPORTED_FOURCC_FORMATS = new Set([
    // Keep this initialization independent of texture-formats.ts.  That module
    // imports the legacy GPU texture utilities, which reach the D3D9 API during
    // bootstrap; reading its live bindings here would make this module's cycle
    // fail in the temporal-dead-zone before the constants are initialized.
    0x31545844, 0x32545844, 0x33545844, 0x34545844, 0x35545844,
    0x31495441, 0x32495441,
    FOURCC_NULL,
]);

const refusedFourCCs = new Map<number, number>();
const refusedFormats = new Map<number, number>();

export function resetDxFormatSupportCensus(): void {
    refusedFourCCs.clear();
    refusedFormats.clear();
}

export function getDxFormatSupportCensus(): {
    refusedFormat: Record<string, number>;
    refusedFourCC: Record<string, number>;
} {
    const refusedFormat: Record<string, number> = {};
    for (const [format, count] of refusedFormats) {
        refusedFormat[String(format)] = count;
    }
    const refusedFourCC: Record<string, number> = {};
    for (const [format, count] of refusedFourCCs) {
        refusedFourCC[`0x${format.toString(16).padStart(8, '0')}`] = count;
    }
    return { refusedFormat, refusedFourCC };
}

function noteRefusedFourCC(format: number): void {
    const fmt = format >>> 0;
    refusedFourCCs.set(fmt, (refusedFourCCs.get(fmt) ?? 0) + 1);
}

function noteRefusedFormat(format: number): void {
    const fmt = format >>> 0;
    refusedFormats.set(fmt, (refusedFormats.get(fmt) ?? 0) + 1);
}

/**
 * Memoization of the three capability queries below. Each is a pure function of its
 * arguments and of the runtime capability contracts, which is exactly what
 * `capabilityGeneration()` tracks — a generation change drops every cached answer.
 *
 * The key space is the format enum crossed with usage/resource-type, so an entry map
 * stays in the hundreds; MEMO_MAX is an assertion of that, not an eviction policy — a
 * blow-past clears the map rather than pretending an LRU is needed here.
 *
 * A/B kill-switch: globalThis.__noCapsMemo keeps every call on the full computation.
 */
const MEMO_MAX = 4096;

interface CapabilityMemo {
    generation: number;
    entries: Map<string, number>;
}

const capsMemoDisabled = (): boolean =>
    (globalThis as { __noCapsMemo?: boolean }).__noCapsMemo === true;

function memoEntries(memo: CapabilityMemo): Map<string, number> {
    const generation = capabilityGeneration();
    if (memo.generation !== generation || memo.entries.size > MEMO_MAX) {
        memo.entries.clear();
        memo.generation = generation;
    }
    return memo.entries;
}

const deviceFormatMemo: CapabilityMemo = { generation: -1, entries: new Map() };
const depthStencilMatchMemo: CapabilityMemo = { generation: -1, entries: new Map() };
const multiSampleTypeMemo: CapabilityMemo = { generation: -1, entries: new Map() };

function deviceFormatKey(
    version: DxVersion, deviceType: number, adapterFormat: number,
    usage: number, rType: number, checkFormat: number,
): string {
    return `${version}|${deviceType}|${adapterFormat >>> 0}|${usage >>> 0}|${rType}|${checkFormat >>> 0}`;
}

/**
 * The refusal census counts CALLS, not distinct keys, so it is bumped by the wrapper on
 * every answer — memoized or freshly computed. D3DOK_NOAUTOGEN is a success status.
 */
function noteDeviceFormatRefusal(checkFormat: number, hr: number): void {
    const fmt = checkFormat >>> 0;
    if (fmt === D3DFMT_UNKNOWN || hr === D3D_OK || hr === D3DOK_NOAUTOGEN) return;
    if (fmt > 0xffff) noteRefusedFourCC(fmt);
    else noteRefusedFormat(fmt);
}

function isDxSupportedFourCC(format: number): boolean {
    const fmt = format >>> 0;
    return fmt <= 0xffff || SUPPORTED_FOURCC_FORMATS.has(fmt);
}

// Usage / resource-type / device-type enums (identical across DX8 & DX9).
const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_DEPTHSTENCIL = 0x2;
// Everything below exists ONLY in d3d9types.h — d3d8types.h stops at D3DUSAGE_DYNAMIC
// (0x200). Every test of these bits is therefore gated on version === 9: a D3D8 caller
// cannot have asked a question its own API has no word for, and answering one rejects a
// usage the app never requested.
const D3DUSAGE_AUTOGENMIPMAP = 0x00000400;
const D3DUSAGE_DMAP = 0x00004000;
const D3DUSAGE_QUERY_LEGACYBUMPMAP = 0x00008000;
const D3DUSAGE_QUERY_SRGBREAD = 0x00010000;
const D3DUSAGE_QUERY_FILTER = 0x00020000;
const D3DUSAGE_QUERY_SRGBWRITE = 0x00040000;
const D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING = 0x00080000;
const D3DUSAGE_QUERY_VERTEXTEXTURE = 0x00100000;
const D3DUSAGE_QUERY_WRAPANDMIP = 0x00200000;
/** Every D3DUSAGE_QUERY_* bit — the set a plain (non-texture) surface cannot carry. */
const D3DUSAGE_QUERY_MASK =
    D3DUSAGE_QUERY_LEGACYBUMPMAP | D3DUSAGE_QUERY_SRGBREAD | D3DUSAGE_QUERY_FILTER |
    D3DUSAGE_QUERY_SRGBWRITE | D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING |
    D3DUSAGE_QUERY_VERTEXTEXTURE | D3DUSAGE_QUERY_WRAPANDMIP;

/**
 * Signed bump-map (dU/dV) formats our texture decoder actually unpacks
 * (decodePackedD3DTextureToRgba8 in shared/texture-formats.ts). CxV8U8 (117) is a bump
 * format too, but it was an NVIDIA-only format with no decoder here and none in DXVK
 * or wined3d, so it stays refused rather than listed.
 */
const BUMPMAP_FORMATS = new Set([
    60, // V8U8
    61, // L6V5U5
    62, // X8L8V8U8
    63, // Q8W8V8U8
    64, // V16U16
    65, // W11V11U10
    67, // A2W10V10U10
    D3DFMT_Q16W16V16U16,
]);

const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DRTYPE_VERTEXBUFFER = 6;
const D3DRTYPE_INDEXBUFFER = 7;

const D3DDEVTYPE_HAL = 1;
const D3DDEVTYPE_REF = 2;
const D3DDEVTYPE_SW = 3;

/**
 * Multisample types backed by the corresponding HLE render path.
 *
 * D3D8 exposes only the portable 4x contract. D3D9 advertises 2x/4x only through
 * the explicit host capability contract that gates its attachment and resolve
 * plumbing; without that probe the public answer remains NONE-only. Reporting
 * counts without a verified adapter would create a surface whose descriptor
 * claims MSAA while the GPU attachment cannot honor it.
 */
export function isDxMultiSampleTypeSupported(version: DxVersion, multiSampleType: number): boolean {
    return resolveDxMsaaPolicy(version, multiSampleType).supported;
}

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
    84, // D32_LOCKABLE
]);

// Formats for which the WebGPU backend can select an sRGB render-target view.
// Keep this explicit so QUERY_SRGBWRITE never advertises a format whose actual
// attachment is still linear.
const SRGB_WRITE_FORMATS = new Set([
    D3DFMT_A8R8G8B8, D3DFMT_X8R8G8B8,
    D3DFMT_A8B8G8R8, D3DFMT_X8B8G8R8,
]);

/**
 * D3DSAMP_SRGBTEXTURE is implemented by selecting a declared WebGPU `*-srgb`
 * view.  Keep this list aligned with the formats for which the backend can
 * select that view without changing the meaning of packed data: ordinary
 * RGBA8/BGRA8-compatible color and DXT1/3/5 (native BC1/2/3 or the RGBA8
 * decode fallback).  BC4/5 and signed bump formats are deliberately absent;
 * gamma-decoding those channels would corrupt normals, and native BC4/5 has
 * no WebGPU sRGB view at all.
 */
const SRGB_READ_FORMATS = new Set([
    D3DFMT_A8R8G8B8, D3DFMT_X8R8G8B8,
    D3DFMT_A8B8G8R8, D3DFMT_X8B8G8R8,
    0x31545844, // DXT1
    0x32545844, // DXT2
    0x33545844, // DXT3
    0x34545844, // DXT4
    0x35545844, // DXT5
]);

function isDxSrgbReadFormat(format: number): boolean {
    const fmt = format >>> 0;
    return SRGB_READ_FORMATS.has(fmt);
}

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

/**
 * D3D9 formats which exist in the API but have no faithful storage path in this
 * WebGPU backend yet. Keep these separate from D3D9_ONLY_FORMATS: the former
 * describes the API's format namespace, while this set describes our current
 * implementation contract. R16F is resolved separately above through its
 * explicit host capability contract; the generic rgba8 upload path still cannot
 * preserve the remaining float texels, and neither CxV8U8 (NVIDIA-only; DXVK's
 * d3d9_format.cpp maps it to no format at all) nor S8-only depth has a storage path.
 */
const D3D9_UNSUPPORTED_FORMATS = new Set([
    85,              // S8_LOCKABLE (stencil-only lockable depth)
    114, 115, 116,   // R32F / G32R32F / A32B32G32R32F
    117,             // CxV8U8 (normal-compression sampler path)
]);

/** True when the format is known to this API but not representable by our HAL. */
export function isDxUnsupportedFormat(format: number, version: DxVersion): boolean {
    if (version !== 9) return false;
    const fmt = format >>> 0;
    if (d3dFloatFormatInfo(fmt)?.bytesPerChannel === 2) {
        return !resolveD3D9FloatTexturePolicy(fmt).supported;
    }
    return D3D9_UNSUPPORTED_FORMATS.has(fmt);
}

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
    if (isDxUnsupportedFormat(fmt, version)) return false;
    // The bounded float contract covers sampled 2-D 16-bit-float textures only.
    // Do not let the broad renderable-format set turn that into an attachment
    // claim before a float render-target path has been proven.
    if (version === 9 && d3dFloatFormatInfo(fmt)?.bytesPerChannel === 2) return false;
    if (
        fmt === D3DFMT_R5G6B5 ||
        fmt === D3DFMT_X1R5G5B5 ||
        fmt === D3DFMT_A1R5G5B5 ||
        fmt === D3DFMT_A4R4G4B4 ||
        fmt === D3DFMT_X4R4G4B4 ||
        fmt === D3DFMT_X8R8G8B8 ||
        fmt === D3DFMT_A8R8G8B8 ||
        fmt === D3DFMT_A8B8G8R8 ||
        fmt === D3DFMT_X8B8G8R8 ||
        fmt === FOURCC_NULL
    ) {
        return true;
    }
    // No float attachment is renderable: every surface is backed by an rgba8-or-wider
    // integer target. A float render-target path needs a native float attachment, a
    // matching resolve/readback encoder, and a blend contract before it can be claimed.
    if (version === 9 && (fmt === D3DFMT_A2R10G10B10 || fmt === D3DFMT_A2B10G10R10 ||
        fmt === D3DFMT_A16B16G16R16)) {
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
    if (fmt > 0xffff && !SUPPORTED_FOURCC_FORMATS.has(fmt)) return false;
    if (fmt === D3DFMT_UNKNOWN || fmt === D3DFMT_VERTEXDATA) return false;
    if (isDxUnsupportedFormat(fmt, version)) return false;
    if (isDxExclusiveFormat(fmt, version)) return false;
    if (isDxDepthStencilFormat(fmt, version)) return false;
    // All block-compressed formats are sample-only in WebGPU.  This includes
    // BC4/BC5 FourCCs, which are not covered by the legacy DXT predicate.
    if (isBlockCompressedFormat(fmt)) return false;
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
            return 32;
        case D3DFMT_A16B16G16R16:
            return 64;
        case D3DFMT_Q16W16V16U16:
            return 64;
        case D3DFMT_R5G6B5:
        case D3DFMT_X1R5G5B5:
        case D3DFMT_A1R5G5B5:
        case D3DFMT_A4R4G4B4:
        case D3DFMT_A8R3G3B2:
        case D3DFMT_X4R4G4B4:
        case D3DFMT_A8P8:
            return 16;
        case D3DFMT_A8:
        case D3DFMT_P8:
        case D3DFMT_L8:
        case D3DFMT_A8L8:
        case D3DFMT_A4L4:
            return 8;
        case D3DFMT_R3G3B2:
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
    checkFormat: number,
    version: DxVersion,
): boolean {
    return isDxSupportedFourCC(checkFormat) && !isDxUnsupportedFormat(checkFormat, version);
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

/**
 * Validate the explicit format-conversion query against the formats exposed by the copy path.
 * This is intentionally narrower than isDxRenderableFormat: a generic decoder is not a
 * StretchRect capability contract, and accepting arbitrary numeric formats would advertise
 * conversions that have no matching source/target encoder.
 */
const FORMAT_CONVERSION_SOURCE_BACKBUFFERS = new Set([
    D3DFMT_A2R10G10B10,
    D3DFMT_A8R8G8B8,
    D3DFMT_X8R8G8B8,
    D3DFMT_A1R5G5B5,
    D3DFMT_X1R5G5B5,
    D3DFMT_R5G6B5,
]);

const FORMAT_CONVERSION_TARGETS = new Set([
    D3DFMT_X1R5G5B5,
    D3DFMT_A1R5G5B5,
    D3DFMT_R5G6B5,
    D3DFMT_X8R8G8B8,
    D3DFMT_A8R8G8B8,
    D3DFMT_A2R10G10B10,
    D3DFMT_A16B16G16R16,
    D3DFMT_A2B10G10R10,
    D3DFMT_A8B8G8R8,
    D3DFMT_X8B8G8R8,
]);

function isDxFormatConversionSource(format: number): boolean {
    const fmt = format >>> 0;
    return FORMAT_CONVERSION_SOURCE_BACKBUFFERS.has(fmt) ||
        (fmt !== FOURCC_NULL && SUPPORTED_FOURCC_FORMATS.has(fmt));
}

export function checkDxDeviceFormatConversion(
    version: DxVersion,
    adapter: number,
    devType: number,
    sourceFormat: number,
    targetFormat: number,
): number {
    if (adapter !== 0 || !isValidDeviceType(devType)) return D3DERR_INVALIDCALL;
    if (version !== 9) return D3DERR_NOTAVAILABLE;
    return isDxFormatConversionSource(sourceFormat) && FORMAT_CONVERSION_TARGETS.has(targetFormat >>> 0)
        ? D3D_OK
        : D3DERR_NOTAVAILABLE;
}

/** The decision itself: pure in its arguments and the capability contracts. */
function computeDxDeviceFormat(
    version: DxVersion,
    _adapterFormat: number,
    usage: number,
    rType: number,
    checkFormat: number,
): number {
    const fmt = checkFormat >>> 0;
    const refuseFormat = (): number => D3DERR_NOTAVAILABLE;
    if (fmt === D3DFMT_UNKNOWN) return D3DERR_NOTAVAILABLE;
    if (isDxExclusiveFormat(fmt, version)) return refuseFormat();
    if (!isDxSupportedFourCC(fmt)) return refuseFormat();
    if (isDxUnsupportedFormat(fmt, version)) return refuseFormat();
    if (version === 9 && d3dFloatFormatInfo(fmt)?.bytesPerChannel === 2) {
        // The first float seam is deliberately limited to IDirect3DTexture9
        // sampled storage. Surfaces and cubes still use the RGBA8/attachment
        // paths and must not inherit this answer.
        const policy = resolveD3D9FloatTexturePolicy(fmt);
        if (!policy.supported || rType !== D3DRTYPE_TEXTURE ||
            (usage & D3DUSAGE_RENDERTARGET) !== 0) return refuseFormat();
    }
    // D3D9 dropped palettized textures — no D3D9 driver advertises P8/A8P8 here (Wine and
    // DXVK refuse them too). Saying yes is not harmlessly permissive: a game's "pick the
    // best format for this card" pass then CHOOSES palettized for everything, and D3D9 has
    // no palette to resolve it with. D3D8 keeps them; palettized surfaces are a normal
    // D3D8 path we convert.
    if (version === 9 && (fmt === D3DFMT_P8 || fmt === D3DFMT_A8P8)) return refuseFormat();
    if ((usage & D3DUSAGE_RENDERTARGET) && !isDxRenderableFormat(fmt, version)) return refuseFormat();
    if ((usage & D3DUSAGE_DEPTHSTENCIL) && !isDxDepthStencilFormat(fmt, version)) return refuseFormat();

    // ── D3DUSAGE_QUERY_* (D3D9 only; see the constant block) ───────────────────────────
    // A query bit asks "can the pipeline do THIS with this format", and an unconditional
    // yes is the worst kind of lie: the app switches to the mechanism we claimed and gets
    // no signal that it did nothing. Answer each from what our backends actually run.
    if (version === 9) {
        // sRGB texture reads use a declared WebGPU *-srgb view selected from the sampler
        // state.  The view path covers the color resources accepted by this HLE (including
        // DXT resources after native BC upload or CPU RGBA decode). Render-target writes use
        // an sRGB attachment view selected by D3DRS_SRGBWRITEENABLE. Keep the resource-type
        // and format checks explicit so a surface/depth probe cannot inherit this capability.
        // The question a render target asks is "can I sRGB-write to THIS format", and it
        // asks it as a SURFACE at least as often as a TEXTURE — D3DRS_SRGBWRITEENABLE
        // selects the sRGB attachment view either way, so gating on the resource type
        // refused gamma-correct rendering to the back buffer.
        if ((usage & D3DUSAGE_QUERY_SRGBWRITE) !== 0 &&
            ((rType !== D3DRTYPE_TEXTURE && rType !== D3DRTYPE_CUBETEXTURE && rType !== D3DRTYPE_SURFACE) ||
                !SRGB_WRITE_FORMATS.has(fmt))) {
            return refuseFormat();
        }
        if ((usage & D3DUSAGE_QUERY_SRGBREAD) !== 0 &&
            (rType !== D3DRTYPE_TEXTURE && rType !== D3DRTYPE_CUBETEXTURE ||
                isDxDepthStencilFormat(fmt, version) || !isDxSrgbReadFormat(fmt))) {
            return refuseFormat();
        }
        // W16 supports 2D vertex textures through D3DVERTEXTEXTURESAMPLER0..3. Cube and
        // volume vertex fetch declarations are not emitted, so keep those resource types out.
        if ((usage & D3DUSAGE_QUERY_VERTEXTEXTURE) !== 0 && rType !== D3DRTYPE_TEXTURE) {
            return refuseFormat();
        }
        // Displacement mapping (D3DUSAGE_DMAP, N-patch/RT-patch tessellation) is not
        // implemented on any path.
        if ((usage & D3DUSAGE_DMAP) !== 0) return refuseFormat();
        // Legacy bump-env sampling reaches the shader only through the signed dU/dV
        // formats the texture decoder unpacks (ps1.x texbem/texbeml, see ps-codegen).
        // Real drivers refuse this query for every other format; so do we.
        if ((usage & D3DUSAGE_QUERY_LEGACYBUMPMAP) !== 0 && !BUMPMAP_FORMATS.has(fmt)) {
            return refuseFormat();
        }
        // DXT textures retain every contiguous authored mip level: native BC upload uses
        // per-level block pitches and the CPU fallback decodes the same chain.  Therefore
        // WRAPANDMIP is honest for DXT as well as uncompressed formats.  AUTOGENMIPMAP is
        // still reported as D3DOK_NOAUTOGEN above because this backend never synthesizes
        // missing levels.
        // A plain surface is not a shader resource: only POSTPIXELSHADER_BLENDING is a
        // meaningful question about one (matches wined3d's per-resource-type allowance).
        if (rType === D3DRTYPE_SURFACE &&
            (usage & (D3DUSAGE_QUERY_MASK & ~D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING)) !== 0) {
            return refuseFormat();
        }
        // Filtering is available for every accepted sampled format.  Post-PS blending,
        // however, is a render-target capability: block-compressed, depth, and packed
        // sample-only formats must not pass this query merely because their texture
        // decoder exists.
        if ((usage & D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING) !== 0 &&
            !isDxRenderTargetFormat(fmt, version)) {
            return refuseFormat();
        }
        // Remaining float/CxV8U8/S8 formats have already been refused above because they do
        // not enter that conversion path faithfully. R16F is allowed only for sampled 2-D
        // storage under its explicit contract; render-target use was rejected above.
    }

    let hr: number;
    switch (rType) {
        case D3DRTYPE_SURFACE:
        case D3DRTYPE_TEXTURE:
            // Every format reaching this switch has passed the supported-format gate. A depth
            // format is only valid here when DEPTHSTENCIL usage is asked.
            hr = D3D_OK;
            break;
        case D3DRTYPE_CUBETEXTURE:
            // D3D9 creates real cube textures (createCubeTexture / ensureCubeTexture) and
            // D3DCAPS9 keeps CUBEMAP. D3D8's CreateCubeTexture returns D3DERR_INVALIDCALL
            // and D3DCAPS8 clears CUBEMAP — this probe must not disagree with the caps the
            // same app reads, or it picks cube mapping and dies at creation.
            hr = version === 9 ? D3D_OK : D3DERR_NOTAVAILABLE;
            break;
        case D3DRTYPE_VOLUMETEXTURE:
            // Volume COM/LockBox storage is available in the API module, but the public
            // capability is opt-in: a host must probe the actual texture_3d upload,
            // sampling, and reset path before making this answer visible to a title.
            hr = version === 9 && resolveD3D9VolumePolicy(9, fmt).supported
                ? D3D_OK
                : D3DERR_NOTAVAILABLE;
            break;
        case D3DRTYPE_VERTEXBUFFER:
            hr = fmt === D3DFMT_VERTEXDATA ? D3D_OK : D3DERR_NOTAVAILABLE;
            break;
        case D3DRTYPE_INDEXBUFFER:
            hr = fmt === D3DFMT_INDEX16 || fmt === D3DFMT_INDEX32 ? D3D_OK : D3DERR_NOTAVAILABLE;
            break;
        default:
            hr = D3DERR_NOTAVAILABLE;
            break;
    }

    if (hr === D3D_OK && (rType === D3DRTYPE_SURFACE || rType === D3DRTYPE_TEXTURE ||
        rType === D3DRTYPE_CUBETEXTURE) && isDxDepthStencilFormat(fmt, version)) {
        hr = (usage & D3DUSAGE_DEPTHSTENCIL) !== 0 ? D3D_OK : D3DERR_NOTAVAILABLE;
    }

    // Auto-generated mip sublevels: nothing generates them for a D3D9 texture (mip slots
    // are filled only from what the app itself LockRect'd). Answering D3D_OK tells the app
    // the runtime owns mip generation, so it stops doing it — and then NOBODY does, which
    // is a change of behaviour, not of quality. D3DOK_NOAUTOGEN succeeds (the format IS
    // supported) while saying the generation is the app's job. Not gated on the format,
    // because the gap is the missing generator, not the format.
    if (hr === D3D_OK && version === 9 && (usage & D3DUSAGE_AUTOGENMIPMAP) !== 0) {
        // A volume contract may explicitly include a per-format generator probe.  Without
        // it preserve the documented NOAUTOGEN success status; this keeps a title's own
        // mip uploads working without claiming that GenerateMipSubLevels is GPU-backed.
        const volumeAutoGen = rType === D3DRTYPE_VOLUMETEXTURE
            ? resolveD3D9VolumePolicy(9, fmt).supportsAutoGenMipmaps
            : false;
        return volumeAutoGen ? D3D_OK : D3DOK_NOAUTOGEN;
    }
    return hr;
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

    const disabled = capsMemoDisabled();
    const entries = memoEntries(deviceFormatMemo);
    const key = deviceFormatKey(version, deviceType, adapterFormat, usage, rType, checkFormat);
    let hr = disabled ? undefined : entries.get(key);
    if (hr === undefined) {
        hr = computeDxDeviceFormat(version, adapterFormat, usage, rType, checkFormat);
        if (!disabled) entries.set(key, hr);
    }
    noteDeviceFormatRefusal(checkFormat, hr);
    return hr;
}

/**
 * Memo-hit-only entry point for the D3D8/D3D9 fast paths. `null` means "no cached answer",
 * which defers to the full thunk — so the first call for each key still runs the whole
 * path, including logDxCheckDeviceFormat. A repeated identical query therefore logs once
 * per distinct key by design; the CALL count lives in the refusal census.
 */
export function peekDxDeviceFormat(
    version: DxVersion,
    adapter: number,
    deviceType: number,
    adapterFormat: number,
    usage: number,
    rType: number,
    checkFormat: number,
): number | null {
    if (adapter !== 0 || !isValidDeviceType(deviceType) || capsMemoDisabled()) return null;
    const hr = memoEntries(deviceFormatMemo)
        .get(deviceFormatKey(version, deviceType, adapterFormat, usage, rType, checkFormat));
    if (hr === undefined) return null;
    noteDeviceFormatRefusal(checkFormat, hr);
    return hr;
}

function computeDxDepthStencilMatch(
    version: DxVersion,
    renderTargetFormat: number,
    depthStencilFormat: number,
): number {
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

export function checkDxDepthStencilMatch(
    version: DxVersion,
    adapter: number,
    deviceType: number,
    adapterFormat: number,
    renderTargetFormat: number,
    depthStencilFormat: number,
): number {
    if (adapter !== 0) return D3DERR_INVALIDCALL;
    if (!isValidDeviceType(deviceType)) return D3DERR_INVALIDCALL;
    const disabled = capsMemoDisabled();
    const entries = memoEntries(depthStencilMatchMemo);
    const key = `${version}|${deviceType}|${adapterFormat >>> 0}|${renderTargetFormat >>> 0}|${depthStencilFormat >>> 0}`;
    let hr = disabled ? undefined : entries.get(key);
    if (hr === undefined) {
        hr = computeDxDepthStencilMatch(version, renderTargetFormat, depthStencilFormat);
        if (!disabled) entries.set(key, hr);
    }
    return hr;
}

/** Memo-hit-only entry point for the fast paths; see peekDxDeviceFormat. */
export function peekDxDepthStencilMatch(
    version: DxVersion,
    adapter: number,
    deviceType: number,
    adapterFormat: number,
    renderTargetFormat: number,
    depthStencilFormat: number,
): number | null {
    if (adapter !== 0 || !isValidDeviceType(deviceType) || capsMemoDisabled()) return null;
    const key = `${version}|${deviceType}|${adapterFormat >>> 0}|${renderTargetFormat >>> 0}|${depthStencilFormat >>> 0}`;
    return memoEntries(depthStencilMatchMemo).get(key) ?? null;
}

function computeDxDeviceMultiSampleType(
    version: DxVersion,
    surfaceFormat: number,
    multiSampleType: number,
): number {
    if (!isDxRenderableFormat(surfaceFormat, version) && !isDxDepthStencilFormat(surfaceFormat, version)) {
        return D3DERR_NOTAVAILABLE;
    }
    // Keep this answer coupled to the actual attachment path. In particular,
    // NONMASKABLE is not a free pass: D3D9 has no sample-count selection or
    // resolve implementation, so accepting it would still promise MSAA.
    if (isDxMultiSampleTypeSupported(version, multiSampleType)) return D3D_OK;
    // The static policy's public default stays NONE-only for D3D9. An explicit host
    // contract is the sole opt-in that may expose 2x/4x, and it is also what the device
    // and attachment cache use at runtime — so the query must consult the same seam.
    const type = multiSampleType >>> 0;
    if (version === 9 && (type === 2 || type === 4)
        && getD3D9MsaaCapabilityContract()?.supportsSampleCount(type) === true) {
        return D3D_OK;
    }
    return D3DERR_NOTAVAILABLE;
}

export function checkDxDeviceMultiSampleType(
    version: DxVersion,
    adapter: number,
    deviceType: number,
    surfaceFormat: number,
    windowed: number,
    multiSampleType: number,
): number {
    if (adapter !== 0) return D3DERR_INVALIDCALL;
    if (!isValidDeviceType(deviceType)) return D3DERR_INVALIDCALL;
    const disabled = capsMemoDisabled();
    const entries = memoEntries(multiSampleTypeMemo);
    const key = `${version}|${deviceType}|${surfaceFormat >>> 0}|${windowed ? 1 : 0}|${multiSampleType >>> 0}`;
    let hr = disabled ? undefined : entries.get(key);
    if (hr === undefined) {
        hr = computeDxDeviceMultiSampleType(version, surfaceFormat, multiSampleType);
        if (!disabled) entries.set(key, hr);
    }
    return hr;
}

/** Memo-hit-only entry point for the fast paths; see peekDxDeviceFormat. */
export function peekDxDeviceMultiSampleType(
    version: DxVersion,
    adapter: number,
    deviceType: number,
    surfaceFormat: number,
    windowed: number,
    multiSampleType: number,
): number | null {
    if (adapter !== 0 || !isValidDeviceType(deviceType) || capsMemoDisabled()) return null;
    const key = `${version}|${deviceType}|${surfaceFormat >>> 0}|${windowed ? 1 : 0}|${multiSampleType >>> 0}`;
    return memoEntries(multiSampleTypeMemo).get(key) ?? null;
}
