/**
 * D3D9-specific sampler-state decode → version-agnostic SamplerSpec.
 *
 * The D3D9 enum numbering differs from D3D7 (notably mip-filter: D3D9 D3DTEXF_NONE=0/POINT=1/LINEAR=2
 * vs D3D7 NONE=1/POINT=2/LINEAR=3), so the decode lives in the D3D9 backend; the resulting SamplerSpec
 * is handed to the shared DxSamplerCache that DX7/D3D8/D3D9 all use (see shared/dx-sampler.ts).
 */

import type {
    DxSamplerAddressMode,
    SamplerSpec,
} from "../shared/dx-sampler";

// D3DSAMPLERSTATETYPE
export const D3DSAMP_ADDRESSU = 1;
export const D3DSAMP_ADDRESSV = 2;
export const D3DSAMP_ADDRESSW = 3;
export const D3DSAMP_BORDERCOLOR = 4;
export const D3DSAMP_MAGFILTER = 5;
export const D3DSAMP_MINFILTER = 6;
export const D3DSAMP_MIPFILTER = 7;
export const D3DSAMP_MIPMAPLODBIAS = 8; // Shader emitter applies the decoded float (no GPUSampler lodBias field)
export const D3DSAMP_MAXMIPLEVEL = 9;
export const D3DSAMP_MAXANISOTROPY = 10;
export const D3DSAMP_SRGBTEXTURE = 11;

// D3DTEXTUREFILTERTYPE
const D3DTEXF_NONE = 0;
const D3DTEXF_POINT = 1;
const D3DTEXF_LINEAR = 2;
const D3DTEXF_ANISOTROPIC = 3;

// D3DTEXTUREADDRESS
const D3DTADDRESS_WRAP = 1;
const D3DTADDRESS_MIRROR = 2;
const D3DTADDRESS_CLAMP = 3;
const D3DTADDRESS_BORDER = 4;
const D3DTADDRESS_MIRRORONCE = 5;

// D3DSAMP_MIPMAPLODBIAS is a float bit-cast into a DWORD. decodeD3d9Sampler runs per draw
// per stage, so the reinterpret pair is module-level scratch rather than two fresh arrays.
const _bitCastU32 = new Uint32Array(1);
const _bitCastF32 = new Float32Array(_bitCastU32.buffer);

/** D3D9 min/mag default is POINT, so an unset (0/NONE) value resolves to nearest. */
function minMagFilter(v: number): GPUFilterMode {
    return v === D3DTEXF_LINEAR || v === D3DTEXF_ANISOTROPIC ? "linear" : "nearest";
}

function mipFilter(v: number): GPUMipmapFilterMode {
    // DXVK maps every filter value above POINT (including ANISOTROPIC) to
    // linear mip selection. WebGPU anisotropy is represented separately by
    // maxAnisotropy, so treating this enum as nearest changes observable LOD.
    return v > D3DTEXF_POINT ? "linear" : "nearest";
}

/** D3D9 default address mode is WRAP, so an unset (0) value resolves to repeat. */
function addressMode(v: number): DxSamplerAddressMode {
    switch (v) {
        case D3DTADDRESS_MIRROR:
            return "mirror-repeat";
        case D3DTADDRESS_MIRRORONCE:
            // WebGPU has no mirror-once. Keep the mode explicit so the shader emitter can apply
            // D3D's clamp(abs(coord), 0, 1) semantics around a native clamp sampler.
            return "d3d9-mirror-once";
        case D3DTADDRESS_CLAMP:
            return "clamp-to-edge";
        case D3DTADDRESS_BORDER:
            // Border colour is a shader concern, not clamp-to-edge. Preserve the mode so the
            // emitter can select the packed border colour outside the texture domain.
            return "d3d9-border";
        case D3DTADDRESS_WRAP:
        default:
            return "repeat";
    }
}

/**
 * The D3D9 default for a D3DSAMP_* state the game never touched — what GetSamplerState (and a
 * D3DSBT_ALL state-block capture) must answer, as distinct from decodeD3d9Sampler's rendering
 * fallback above (which already treats raw 0 as POINT/WRAP at the point of use). Without this,
 * a game that reads back a sampler slot it never set observes 0 for every state, which is wrong
 * for MAXANISOTROPY (real default 1, not "no anisotropy requested" — 0 there is not achievable
 * through the API at all) even though it happens to be right for the filter/address states.
 * Mirrors wined3d's init_default_sampler_states.
 */
export function d3d9SamplerStateDefault(type: number): number {
    switch (type) {
        case D3DSAMP_ADDRESSU:
        case D3DSAMP_ADDRESSV:
        case D3DSAMP_ADDRESSW:
            return D3DTADDRESS_WRAP;
        case D3DSAMP_MAGFILTER:
        case D3DSAMP_MINFILTER:
            return D3DTEXF_POINT;
        case D3DSAMP_MAXANISOTROPY:
            return 1;
        default:
            return 0;
    }
}

/**
 * Decode the D3D9 sampler-state block for one stage into a SamplerSpec.
 * `get(type)` returns the raw D3DSAMP_* value (0 if the game never set it → D3D9 defaults apply).
 */
export function decodeD3d9Sampler(get: (type: number) => number): SamplerSpec {
    const minV = get(D3DSAMP_MINFILTER);
    const magV = get(D3DSAMP_MAGFILTER);
    const mipV = get(D3DSAMP_MIPFILTER);
    const anisoRequested = minV === D3DTEXF_ANISOTROPIC || magV === D3DTEXF_ANISOTROPIC;
    const maxAnisotropy = Math.max(1, get(D3DSAMP_MAXANISOTROPY) >>> 0);
    // D3DCAPS9 advertises MaxAnisotropy=16 and a value above it is CLAMPED, never refused —
    // D3D9 has no failure mode for a legal SetSamplerState, and DXVK clamps to [1,16] too.
    // The clamp lives in the shared DxSamplerCache; the raw request stays in gameAnisotropy.
    // MIPMAPLODBIAS is a DWORD containing the IEEE-754 float bits. WebGPU has no sampler
    // lodBias field, so shader emitters add it to implicit/explicit sample LODs.
    const mipLodBiasBits = get(D3DSAMP_MIPMAPLODBIAS) >>> 0;
    _bitCastU32[0] = mipLodBiasBits;
    const mipLodBias = _bitCastF32[0]!;
    // sRGB decode is a texture-view/resource property in WebGPU, not a sampler flag. Preserve
    // it in the version-agnostic spec; the D3D9 device selects a declared sRGB view for the
    // bound resource and refuses only formats for which no compatible view exists.
    const srgbTexture = (get(D3DSAMP_SRGBTEXTURE) >>> 0) !== 0;
    return {
        min: minMagFilter(minV),
        mag: minMagFilter(magV),
        mip: mipFilter(mipV),
        mipNone: mipV === D3DTEXF_NONE, // D3D9 MIPFILTER=NONE (0) → sample base level only
        addressU: addressMode(get(D3DSAMP_ADDRESSU)),
        addressV: addressMode(get(D3DSAMP_ADDRESSV)),
        addressW: addressMode(get(D3DSAMP_ADDRESSW)),
        gameAnisotropy: anisoRequested ? maxAnisotropy : 1,
        maxMipLevel: get(D3DSAMP_MAXMIPLEVEL) >>> 0,
        srgbTexture,
        borderColor: get(D3DSAMP_BORDERCOLOR) >>> 0,
        mipLodBias,
        mipLodBiasBits,
    };
}
