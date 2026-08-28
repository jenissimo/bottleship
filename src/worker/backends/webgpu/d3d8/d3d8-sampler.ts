/**
 * D3D8 texture-stage sampler decode → shared SamplerSpec.
 * D3D8 uses SetTextureStageState (TSS) instead of D3D9 SetSamplerState, but the VALUES
 * are D3D9's D3DTEXTUREFILTERTYPE, not D3D7's — a D3D8→D3D9 layer passes them through
 * unchanged (DXVK d3d8_device.cpp SetTextureStageState → SetSamplerState). Decoding them
 * with the D3D7 numbering silently downgrades every LINEAR request to nearest.
 */

import type { DxSamplerAddressMode, DxSamplerUnsupportedFeature, SamplerSpec } from "../shared/dx-sampler";
import {
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTSS_MAGFILTER,
    D3DTSS_MINFILTER,
    D3DTSS_MIPFILTER,
    D3DTSS_MAXANISOTROPY,
} from "../../../modules/ddraw/constants";
// Not re-exported by the barrel above — imported straight from the leaf constants module.
import {
    D3DTSS_MIPMAPLODBIAS,
    D3DTSS_MAXMIPLEVEL,
    D3DTSS_BORDERCOLOR,
} from "../../../modules/ddraw/d3d/sampler-constants";

// D3DTSS_MIPMAPLODBIAS is a DWORD carrying IEEE-754 float bits (same bit-cast d3d9-sampler.ts
// uses). This decode runs once per stage per draw, not per-vertex/pixel.
const lodBiasBitsScratch = new Uint32Array(1);
const lodBiasFloatScratch = new Float32Array(lodBiasBitsScratch.buffer);

// D3DTEXTUREFILTERTYPE — D3D8/D3D9 numbering (D3D7 is NONE=1/POINT=2/LINEAR=3; see
// d3d9-sampler.ts). These are also the D3D8 defaults' vocabulary: MIN/MAG default to
// POINT and MIPFILTER to NONE.
export const D3DTEXF_NONE = 0;
export const D3DTEXF_POINT = 1;
export const D3DTEXF_LINEAR = 2;
export const D3DTEXF_ANISOTROPIC = 3;

const D3DTADDRESS_WRAP = 1;
const D3DTADDRESS_MIRROR = 2;
const D3DTADDRESS_CLAMP = 3;
const D3DTADDRESS_BORDER = 4;
const D3DTADDRESS_MIRRORONCE = 5;

function minMagFilter(v: number): GPUFilterMode {
    return v === D3DTEXF_LINEAR || v === D3DTEXF_ANISOTROPIC ? "linear" : "nearest";
}

function mipFilter(v: number): GPUMipmapFilterMode {
    return v === D3DTEXF_LINEAR ? "linear" : "nearest";
}

function addressMode(v: number): DxSamplerAddressMode {
    switch (v) {
        case D3DTADDRESS_MIRROR:
        case D3DTADDRESS_MIRRORONCE:
            return "mirror-repeat";
        case D3DTADDRESS_CLAMP:
            return "clamp-to-edge";
        case D3DTADDRESS_BORDER:
            // WebGPU has no clamp-to-border. Preserve the mode explicitly (as d3d9-sampler.ts
            // does) so the shader emitter — already generic over SamplerSpec for this
            // programmable draw path (see d3d9/shader/emit/tex.ts) — substitutes the real
            // border colour instead of silently collapsing to clamp-to-edge.
            return "d3d9-border";
        default:
            return "repeat";
    }
}

/** Decode TSS state for one stage from a flat D3D8 textureStates array. */
export function decodeD3d8TssSampler(
    textureStates: Int32Array,
    stage: number,
): SamplerSpec {
    const base = stage * 32;
    const get = (type: number) => textureStates[base + type] ?? 0;
    const minV = get(D3DTSS_MINFILTER);
    const magV = get(D3DTSS_MAGFILTER);
    const mipV = get(D3DTSS_MIPFILTER);
    const anisoRequested = minV === D3DTEXF_ANISOTROPIC || magV === D3DTEXF_ANISOTROPIC;
    // D3DTSS_MAXANISOTROPY is a plain DWORD (DXVK forwards TSS 1:1 to D3D9's SetSamplerState) —
    // read the game's real request instead of forcing a fixed 16x whenever ANISOTROPIC is merely
    // selected as the filter mode (docs/d3d8-parity/02-samplers.md F3).
    const maxAnisotropy = Math.max(1, get(D3DTSS_MAXANISOTROPY) >>> 0);
    const unsupportedFeatures: DxSamplerUnsupportedFeature[] = [];
    // A request above the advertised MaxAnisotropy=16 is CLAMPED, not refused: engines write
    // their config value straight through, and the D3D9 runtime and DXVK both clamp to the
    // cap. Dropping the draw instead loses every primitive on the stage.
    const mipLodBiasBits = get(D3DTSS_MIPMAPLODBIAS) >>> 0;
    lodBiasBitsScratch[0] = mipLodBiasBits;
    const mipLodBias = lodBiasFloatScratch[0];
    const maxMipLevel = get(D3DTSS_MAXMIPLEVEL) >>> 0;
    const borderColor = get(D3DTSS_BORDERCOLOR) >>> 0;
    return {
        min: minMagFilter(minV),
        mag: minMagFilter(magV),
        mip: mipFilter(mipV),
        // D3DTEXF_NONE is 0, which is also "never set" — and D3D8's own MIPFILTER default
        // IS NONE, so the two collapse onto the same, correct answer.
        mipNone: mipV === D3DTEXF_NONE,
        addressU: addressMode(get(D3DTSS_ADDRESSU) || D3DTADDRESS_WRAP),
        addressV: addressMode(get(D3DTSS_ADDRESSV) || D3DTADDRESS_WRAP),
        addressW: addressMode(D3DTADDRESS_WRAP),
        gameAnisotropy: anisoRequested ? maxAnisotropy : 1,
        maxMipLevel,
        borderColor,
        mipLodBias,
        mipLodBiasBits,
        unsupportedFeatures: unsupportedFeatures.length > 0 ? unsupportedFeatures : undefined,
    };
}
