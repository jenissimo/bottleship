/**
 * D3D8 texture-stage sampler decode → shared SamplerSpec.
 * D3D8 uses SetTextureStageState (TSS) instead of D3D9 SetSamplerState, but the VALUES
 * are D3D9's D3DTEXTUREFILTERTYPE, not D3D7's — a D3D8→D3D9 layer passes them through
 * unchanged (DXVK d3d8_device.cpp SetTextureStageState → SetSamplerState). Decoding them
 * with the D3D7 numbering silently downgrades every LINEAR request to nearest.
 */

import type { SamplerSpec } from "../shared/dx-sampler";
import {
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTSS_MAGFILTER,
    D3DTSS_MINFILTER,
    D3DTSS_MIPFILTER,
} from "../../../modules/ddraw/constants";

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

function addressMode(v: number): GPUAddressMode {
    switch (v) {
        case D3DTADDRESS_MIRROR:
        case D3DTADDRESS_MIRRORONCE:
            return "mirror-repeat";
        case D3DTADDRESS_CLAMP:
        case D3DTADDRESS_BORDER:
            return "clamp-to-edge";
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
        gameAnisotropy: anisoRequested ? 16 : 1,
        maxMipLevel: 0,
    };
}
