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
 * format too but nothing decodes it, so it is deliberately absent.
 */
const BUMPMAP_FORMATS = new Set([
    60, // V8U8
    61, // L6V5U5
    62, // X8L8V8U8
    63, // Q8W8V8U8
    64, // V16U16
    65, // W11V11U10
    67, // A2W10V10U10
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

    // ── D3DUSAGE_QUERY_* (D3D9 only; see the constant block) ───────────────────────────
    // A query bit asks "can the pipeline do THIS with this format", and an unconditional
    // yes is the worst kind of lie: the app switches to the mechanism we claimed and gets
    // no signal that it did nothing. Answer each from what our backends actually run.
    if (version === 9) {
        // No sRGB anywhere: no backend creates an *-srgb texture/target and no shader
        // applies the transfer function, so a "yes" here silently doubles the gamma the
        // app was going to compensate for.
        if ((usage & (D3DUSAGE_QUERY_SRGBREAD | D3DUSAGE_QUERY_SRGBWRITE)) !== 0) return D3DERR_NOTAVAILABLE;
        // Vertex-shader texture sampling: shader/vs-codegen.ts emits none, and D3DCAPS9
        // zeroes VertexTextureFilterCaps to say the same thing.
        if ((usage & D3DUSAGE_QUERY_VERTEXTEXTURE) !== 0) return D3DERR_NOTAVAILABLE;
        // Displacement mapping (D3DUSAGE_DMAP, N-patch/RT-patch tessellation) is not
        // implemented on any path.
        if ((usage & D3DUSAGE_DMAP) !== 0) return D3DERR_NOTAVAILABLE;
        // Legacy bump-env sampling reaches the shader only through the signed dU/dV
        // formats the texture decoder unpacks (ps1.x texbem/texbeml, see ps-codegen).
        // Real drivers refuse this query for every other format; so do we.
        if ((usage & D3DUSAGE_QUERY_LEGACYBUMPMAP) !== 0 && !BUMPMAP_FORMATS.has(fmt)) {
            return D3DERR_NOTAVAILABLE;
        }
        // Block-compressed textures upload level 0 and nothing else (d3d9-device
        // ensureDxtTexture creates a 1-level texture), so a mip chain is not something
        // this format can carry here. Uncompressed textures do get their authored
        // sublevels, and WRAP addressing is universal.
        if ((usage & D3DUSAGE_QUERY_WRAPANDMIP) !== 0 && isDxtFormat(fmt)) return D3DERR_NOTAVAILABLE;
        // A plain surface is not a shader resource: only POSTPIXELSHADER_BLENDING is a
        // meaningful question about one (matches wined3d's per-resource-type allowance).
        if (rType === D3DRTYPE_SURFACE &&
            (usage & (D3DUSAGE_QUERY_MASK & ~D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING)) !== 0) {
            return D3DERR_NOTAVAILABLE;
        }
        // QUERY_FILTER and QUERY_POSTPIXELSHADER_BLENDING are HELD, and stay D3D_OK below:
        // every format we accept is decoded to rgba8unorm (shared/texture-formats.ts), and
        // rgba8/bgra8 render targets are both linearly filterable and blendable in WebGPU.
        // We back no float texture/target, which is the one case that would need a caveat.
    }

    let hr: number;
    switch (rType) {
        case D3DRTYPE_SURFACE:
        case D3DRTYPE_TEXTURE:
            // Report support for any real (non-exclusive, non-UNKNOWN) format — our HLE
            // backs/converts them all. A depth format is only valid here when DEPTHSTENCIL
            // usage is asked.
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
            // Neither version can create one (both CreateVolumeTexture entries return
            // D3DERR_INVALIDCALL) and both caps blobs clear VOLUMEMAP/MIPVOLUMEMAP.
            hr = D3DERR_NOTAVAILABLE;
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
        return D3DOK_NOAUTOGEN;
    }
    return hr;
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
