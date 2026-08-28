import { Emitter } from "../emitter";

/** Four D3DVERTEXTEXTURESAMPLER slots follow the existing PS texture and
 * hybrid-sampler windows. Keep these private: PROG_BIND is a stable public
 * API and W16 must not renumber any existing programmable binding. */
const VERTEX_TEXTURE_SAMPLER_COUNT = 4;
const FRAGMENT_TEXTURE_STAGE_COUNT = 16;

export interface BindLayoutOptions {
    hasTexture: boolean;
    fragSamplers: number[];
    cubeMask: number;
    /** Bitmask of fragment stages backed by a 3-D volume texture. */
    volumeMask?: number;
    /** Bitmask of VS vertex-texture stages backed by a 3-D volume texture. */
    vertexVolumeMask?: number;
    programmablePixel: boolean;
    samplerBinding: number;
    textureBase: number;
    hybridSamplerBase: number;
    /** Bitmask of stages whose resources are depth textures sampled with PCF. */
    comparisonMask?: number;
}

export function emitBindLayout(emitter: Emitter, opts: BindLayoutOptions): void {
    if (opts.hasTexture) {
        const comparisonMask = opts.programmablePixel ? (opts.comparisonMask ?? 0) : 0;
        const stage0SamplerType = (comparisonMask & 1) !== 0 ? "sampler_comparison" : "sampler";
        emitter.line(`@group(0) @binding(${opts.samplerBinding}) var samp: ${stage0SamplerType};`);
        for (const n of opts.fragSamplers) {
            const comparison = ((comparisonMask >> n) & 1) !== 0;
            const volume = ((opts.volumeMask ?? 0) >> n) & 1;
            // Volume bindings must take precedence over cube/depth. D3D does not expose
            // comparison sampling for volume resources in this backend; the link/device
            // seam masks that combination out before reaching WGSL.
            const kind = volume
                ? "texture_3d<f32>"
                : comparison
                ? "texture_depth_2d"
                : ((opts.cubeMask >> n) & 1 ? "texture_cube<f32>" : "texture_2d<f32>");
            emitter.line(`@group(0) @binding(${opts.textureBase + n}) var tex${n}: ${kind};`);
        }
        // Stage 0 is the stable shared `samp` binding above. Stages 1..15 occupy one
        // contiguous, non-overlapping window immediately after all fragment textures.
        for (const n of opts.fragSamplers) {
            if (n === 0) continue;
            const type = opts.programmablePixel && ((comparisonMask >> n) & 1) !== 0
                ? "sampler_comparison" : "sampler";
            emitter.line(`@group(0) @binding(${opts.hybridSamplerBase + n - 1}) var samp${n}: ${type};`);
        }
    }

    // VS3 texldl uses s0..s3, but D3D9 binds those resources at API stages
    // D3DVERTEXTEXTURESAMPLER0..3 (257..260). The vertex declarations are
    // stable and harmlessly unused for shaders without a vertex sample.
    const vertexTextureBase = opts.hybridSamplerBase + FRAGMENT_TEXTURE_STAGE_COUNT - 1;
    const vertexSamplerBase = vertexTextureBase + VERTEX_TEXTURE_SAMPLER_COUNT;
    for (let n = 0; n < VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
        emitter.line(`// D3DVERTEXTEXTURESAMPLER${n} (stage ${257 + n})`);
        const volume = ((opts.vertexVolumeMask ?? 0) >> n) & 1;
        emitter.line(`@group(0) @binding(${vertexTextureBase + n}) var vtex${n}: ${volume ? "texture_3d<f32>" : "texture_2d<f32>"};`);
        emitter.line(`@group(0) @binding(${vertexSamplerBase + n}) var vsamp${n}: sampler;`);
    }
}
