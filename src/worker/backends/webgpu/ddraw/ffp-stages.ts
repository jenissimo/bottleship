/**
 * FFP texture-stage cascade state — data-oriented, stage-count-generic.
 *
 * Replaces the suffixed-scalar plumbing (colorArg1_1, minFilter2, ...) that capped the
 * fixed-function pipeline at 3 hardcoded stages. One resolver loop applies the D3D7/D3D8
 * per-stage defaulting/remap/cascade-termination rules for all MAX_FFP_STAGES stages, and
 * one packer produces the GPU-side `stages: array<vec4u, MAX_FFP_STAGES>` block shared by
 * the legacy uniform slot and the MegaBatch storage slot.
 *
 * Per-stage vec4u packing (16 bytes/stage):
 *   x = colorOp | alphaOp << 8 | colorArg0 << 16 | alphaArg0 << 24
 *   y = colorArg1 | colorArg2 << 8 | alphaArg1 << 16 | alphaArg2 << 24
 *       (D3DTA select mask 0x0F + COMPLEMENT 0x10 + ALPHAREPLICATE 0x20 fit in a byte)
 *   z = raw D3DTSS_TEXCOORDINDEX (low 16 = UV set, high 16 = D3DTSS_TCI_* texgen mode)
 *   w = resolved texture-transform flags (D3DTTFF count | PROJECTED bit; 0 = untransformed)
 */

import {
    D3DTOP_DISABLE,
    D3DTOP_MODULATE,
    D3DTOP_SELECTARG1,
    D3DTOP_SELECTARG2,
    D3DTA_TEXTURE,
    D3DTA_DIFFUSE,
    D3DTA_CURRENT,
    D3DTA_SELECTMASK,
    D3DTSS_COLOROP,
    D3DTSS_COLORARG1,
    D3DTSS_COLORARG2,
    D3DTSS_ALPHAOP,
    D3DTSS_ALPHAARG1,
    D3DTSS_ALPHAARG2,
    D3DTSS_COLORARG0,
    D3DTSS_ALPHAARG0,
    D3DTSS_TEXCOORDINDEX,
    D3DTSS_MINFILTER,
    D3DTSS_MAGFILTER,
    D3DTSS_MIPFILTER,
    D3DTSS_MAXANISOTROPY,
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTADDRESS_WRAP,
    D3DTFP_NONE,
    D3DTOP_MULTIPLYADD,
    D3DTOP_LERP,
} from "../../../modules/ddraw/constants";

/** Cascade depth we implement — matches the advertised MaxTextureBlendStages. */
export const MAX_FFP_STAGES = 8;

/** Stages that can bind + sample a texture (uv0..uv3 varyings). Stages above this
 *  participate in the arithmetic cascade only (CURRENT/TFACTOR/DIFFUSE args). */
export const MAX_FFP_SAMPLED_STAGES = 4;

/** Vertex UV sets carried by the converted 64-byte vertex (uv0..uv2). */
export const MAX_FFP_UV_SETS = 3;

/** Per-stage texture matrices carried in the legacy uniform slot (stages 0..2).
 *  Stage 3 samples with untransformed coordinates (detector logs if a game transforms it). */
export const MAX_FFP_TEX_MATRICES = 3;

export const FFP_STAGE_PACK_BYTES = MAX_FFP_STAGES * 16;
export const FFP_STAGE_PACK_WORDS = MAX_FFP_STAGES * 4;

/** Per-stage sampler parameters (D3D7 enums), consumed by BindGroupManager. */
export interface StageSamplerState {
    minFilter: number;
    magFilter: number;
    mipFilter: number;
    maxAnisotropy: number;
    addressU: number;
    addressV: number;
}

/**
 * Resolved state of the whole FFP stage cascade for one draw. Reusable (zero-alloc):
 * call resolve() per draw, then pack() after any sampling demotions.
 */
export class FfpStagesState {
    readonly colorOp = new Int32Array(MAX_FFP_STAGES);
    readonly alphaOp = new Int32Array(MAX_FFP_STAGES);
    readonly colorArg1 = new Int32Array(MAX_FFP_STAGES);
    readonly colorArg2 = new Int32Array(MAX_FFP_STAGES);
    readonly alphaArg1 = new Int32Array(MAX_FFP_STAGES);
    readonly alphaArg2 = new Int32Array(MAX_FFP_STAGES);
    readonly colorArg0 = new Int32Array(MAX_FFP_STAGES);
    readonly alphaArg0 = new Int32Array(MAX_FFP_STAGES);
    readonly tci = new Int32Array(MAX_FFP_STAGES);
    readonly texXformFlags = new Int32Array(MAX_FFP_STAGES);

    readonly minFilter = new Int32Array(MAX_FFP_STAGES);
    readonly magFilter = new Int32Array(MAX_FFP_STAGES);
    readonly mipFilter = new Int32Array(MAX_FFP_STAGES);
    readonly maxAnisotropy = new Int32Array(MAX_FFP_STAGES);
    readonly addressU = new Int32Array(MAX_FFP_STAGES);
    readonly addressV = new Int32Array(MAX_FFP_STAGES);

    /** Stage N's cascade block runs (op/args applied). Bit 0 is always set. */
    enabledMask = 1;
    /** Stage N binds + samples a texture (subset of enabledMask ∩ sampleable stages). */
    sampledMask = 0;
    /** Stage is active with TEXTURE args but its texture has no GPU view. */
    missingMask = 0;
    /** Pre-remap: stage args referenced D3DTA_TEXTURE. */
    private wantsTextureMask = 0;
    /** Stage is active and never references TEXTURE (pure arithmetic stage). */
    private arithMask = 0;
    /** Stage has D3DTSS_TCI_* texgen flags in TEXCOORDINDEX. */
    texgenMask = 0;

    /** Number of cascade blocks the shader must emit: 1 + index of highest enabled stage. */
    stageCount = 1;

    /** GPU-ready stages block (MAX_FFP_STAGES × vec4u). Valid after pack(). */
    readonly packed = new Uint32Array(FFP_STAGE_PACK_WORDS);

    /**
     * Apply the D3D fixed-function per-stage rules to raw texture-stage state.
     *
     * @param textureStates  stage*32+D3DTSS_* array from the device layer
     * @param realTexMask    bit N set = stage N has a texture with a live GPU view
     * @param hasTexCoords   FVF carries at least one UV set
     * @param hasDummyTexture executor has a fallback view for stage 0 (missing-texture path)
     */
    resolve(
        textureStates: Int32Array,
        realTexMask: number,
        hasTexCoords: boolean,
        hasDummyTexture: boolean,
    ): void {
        let enabledMask = 0;
        let sampledMask = 0;
        let missingMask = 0;
        let wantsMask = 0;
        let arithMask = 0;
        let texgenMask = 0;
        let prevEnabled = true;

        for (let s = 0; s < MAX_FFP_STAGES; s++) {
            const base = s * 32;
            const hasRealTexture = (realTexMask & (1 << s)) !== 0;

            // In DX7 a raw 0 means "uninitialized". Stage 0 defaults to MODULATE,
            // stages 1+ default to DISABLE (cascade off).
            let colorOp = textureStates[base + D3DTSS_COLOROP] || 0;
            if (colorOp === 0) colorOp = s === 0 ? D3DTOP_MODULATE : D3DTOP_DISABLE;
            // Default alphaOp is SELECTARG1 (texture alpha), NOT MODULATE — MODULATE
            // would multiply in uninitialized vertex alpha and blank the geometry.
            let alphaOp = textureStates[base + D3DTSS_ALPHAOP] || 0;
            if (alphaOp === 0 && (s === 0 || colorOp !== D3DTOP_DISABLE)) {
                alphaOp = D3DTOP_SELECTARG1;
            }

            const active = colorOp !== D3DTOP_DISABLE;

            // Argument defaults: stage 0 blends TEXTURE against DIFFUSE, later stages
            // against CURRENT (the cascade accumulator). A raw 0 with a non-zero default
            // is "uninitialized" (D3DTA_DIFFUSE=0 stays representable via the default).
            const defArg2 = s === 0 ? D3DTA_DIFFUSE : D3DTA_CURRENT;
            let colorArg1 = readStageArg(textureStates, base, D3DTSS_COLORARG1, D3DTA_TEXTURE);
            let colorArg2 = readStageArg(textureStates, base, D3DTSS_COLORARG2, defArg2);
            let alphaArg1 = readStageArg(textureStates, base, D3DTSS_ALPHAARG1, D3DTA_TEXTURE);
            let alphaArg2 = readStageArg(textureStates, base, D3DTSS_ALPHAARG2, defArg2);
            let colorArg0 = readStageArg(textureStates, base, D3DTSS_COLORARG0, D3DTA_CURRENT);
            let alphaArg0 = readStageArg(textureStates, base, D3DTSS_ALPHAARG0, D3DTA_CURRENT);

            if (s === 0) {
                // D3DTA_CURRENT on stage 0 resolves to DIFFUSE (no previous stage).
                colorArg1 = currentToDiffuse(colorArg1);
                colorArg2 = currentToDiffuse(colorArg2);
                alphaArg1 = currentToDiffuse(alphaArg1);
                alphaArg2 = currentToDiffuse(alphaArg2);
                colorArg0 = currentToDiffuse(colorArg0);
                alphaArg0 = currentToDiffuse(alphaArg0);
            }

            // Captured BEFORE the missing-texture remap: distinguishes a true arithmetic
            // stage (args never reference TEXTURE, e.g. CURRENT×TFACTOR fade) from a
            // textured stage degraded by a missing texture.
            // ARG0 counts only when the op READS it — MULTIPLYADD and LERP are the only
            // two that do. Every other op ignores ARG0, and the state persists across
            // draws, so a stale ARG0=TEXTURE from an earlier LERP would otherwise make a
            // pure-arithmetic stage look textured and drop it (and everything above it)
            // out of the cascade.
            const readsArg0 = (op: number): boolean => op === D3DTOP_MULTIPLYADD || op === D3DTOP_LERP;
            const wantsTexture =
                (colorArg1 & D3DTA_SELECTMASK) === D3DTA_TEXTURE ||
                (colorArg2 & D3DTA_SELECTMASK) === D3DTA_TEXTURE ||
                (alphaArg1 & D3DTA_SELECTMASK) === D3DTA_TEXTURE ||
                (alphaArg2 & D3DTA_SELECTMASK) === D3DTA_TEXTURE ||
                (readsArg0(colorOp) && (colorArg0 & D3DTA_SELECTMASK) === D3DTA_TEXTURE) ||
                (readsArg0(alphaOp) && (alphaArg0 & D3DTA_SELECTMASK) === D3DTA_TEXTURE);

            if (!hasRealTexture) {
                // TEXTURE args with no texture bound resolve to DIFFUSE.
                colorArg1 = textureToDiffuse(colorArg1);
                colorArg2 = textureToDiffuse(colorArg2);
                alphaArg1 = textureToDiffuse(alphaArg1);
                alphaArg2 = textureToDiffuse(alphaArg2);
                colorArg0 = textureToDiffuse(colorArg0);
                alphaArg0 = textureToDiffuse(alphaArg0);

                if (s === 0) {
                    // MODULATE(DIFFUSE, DIFFUSE) darkens vertex-color rendering
                    // (fade overlays); it is equivalent to SELECTARG1 — use that.
                    if (colorOp === D3DTOP_MODULATE &&
                        (colorArg1 & D3DTA_SELECTMASK) === D3DTA_DIFFUSE &&
                        (colorArg2 & D3DTA_SELECTMASK) === D3DTA_DIFFUSE) {
                        colorOp = D3DTOP_SELECTARG1;
                    }
                    if (alphaOp === D3DTOP_MODULATE &&
                        (alphaArg1 & D3DTA_SELECTMASK) === D3DTA_DIFFUSE &&
                        (alphaArg2 & D3DTA_SELECTMASK) === D3DTA_DIFFUSE) {
                        alphaOp = D3DTOP_SELECTARG1;
                    }
                }
            }

            let samples: boolean;
            let enabled: boolean;
            const sampleable = s < MAX_FFP_SAMPLED_STAGES;
            if (s === 0) {
                // Stage 0 always runs. Sampling matches the legacy useTexture rules:
                // DISABLE and SELECTARG2(non-texture) never sample; otherwise sample when
                // UVs exist, a view is bindable (real, or the 1×1 dummy fallback so the
                // pipeline layout stays satisfiable), and args still reference TEXTURE
                // after the missing-texture remap (i.e. a real texture is present).
                const argsRequireTexture = wantsTexture && hasRealTexture;
                if (!active || (colorOp === D3DTOP_SELECTARG2 &&
                    (colorArg2 & D3DTA_SELECTMASK) !== D3DTA_TEXTURE)) {
                    samples = false;
                } else {
                    samples = hasTexCoords && (hasRealTexture || hasDummyTexture) && argsRequireTexture;
                }
                enabled = true;
                if (hasTexCoords && !hasRealTexture && active && wantsTexture) {
                    missingMask |= 1 << s;
                }
            } else {
                // The D3D cascade terminates at the first COLOROP=DISABLE stage; a stage
                // only runs when every stage below it runs.
                const usesTexture = active && hasTexCoords && hasRealTexture && wantsTexture;
                const arith = active && !wantsTexture;
                samples = prevEnabled && usesTexture && sampleable;
                enabled = prevEnabled && (samples || arith);
                if (arith) arithMask |= 1 << s;
                if (hasTexCoords && !hasRealTexture && active && wantsTexture) {
                    missingMask |= 1 << s;
                }
            }

            if (wantsTexture) wantsMask |= 1 << s;
            if (enabled) enabledMask |= 1 << s;
            if (samples) sampledMask |= 1 << s;

            const tci = textureStates[base + D3DTSS_TEXCOORDINDEX];
            if ((tci & ~0xffff) !== 0) texgenMask |= 1 << s;

            this.colorOp[s] = colorOp;
            this.alphaOp[s] = alphaOp;
            this.colorArg1[s] = colorArg1;
            this.colorArg2[s] = colorArg2;
            this.alphaArg1[s] = alphaArg1;
            this.alphaArg2[s] = alphaArg2;
            this.colorArg0[s] = colorArg0;
            this.alphaArg0[s] = alphaArg0;
            this.tci[s] = tci;
            this.texXformFlags[s] = 0; // filled by the executor's texture-transform resolver

            this.minFilter[s] = textureStates[base + D3DTSS_MINFILTER] || 0;
            this.magFilter[s] = textureStates[base + D3DTSS_MAGFILTER] || 0;
            this.mipFilter[s] = textureStates[base + D3DTSS_MIPFILTER] || D3DTFP_NONE;
            this.maxAnisotropy[s] = textureStates[base + D3DTSS_MAXANISOTROPY] || 1;
            this.addressU[s] = textureStates[base + D3DTSS_ADDRESSU] || D3DTADDRESS_WRAP;
            this.addressV[s] = textureStates[base + D3DTSS_ADDRESSV] || D3DTADDRESS_WRAP;

            prevEnabled = enabled;
        }

        this.enabledMask = enabledMask | 1;
        this.sampledMask = sampledMask;
        this.missingMask = missingMask;
        this.wantsTextureMask = wantsMask;
        this.arithMask = arithMask;
        this.texgenMask = texgenMask;
        this.stageCount = 32 - Math.clz32(this.enabledMask);
    }

    /**
     * Demote a stage that failed GPU view resolution: it no longer samples, and unless it
     * is a pure arithmetic stage it drops out of the cascade — which re-terminates the
     * cascade at that point for every stage above it (cascade rule).
     */
    demoteSampling(stage: number): void {
        this.sampledMask &= ~(1 << stage);
        let prevEnabled = true;
        let enabledMask = 1;
        for (let s = 1; s < MAX_FFP_STAGES; s++) {
            const bit = 1 << s;
            const samples: boolean = (this.sampledMask & bit) !== 0 && prevEnabled;
            if (!samples) this.sampledMask &= ~bit;
            const enabled: boolean = prevEnabled && (samples || (this.arithMask & bit) !== 0);
            if (enabled) enabledMask |= bit;
            prevEnabled = enabled;
        }
        this.enabledMask = enabledMask;
        this.stageCount = 32 - Math.clz32(this.enabledMask);
    }

    /** Pack the resolved cascade into the GPU vec4u block (disabled stages → DISABLE ops). */
    pack(): void {
        const p = this.packed;
        for (let s = 0; s < MAX_FFP_STAGES; s++) {
            const enabled = (this.enabledMask & (1 << s)) !== 0;
            const colorOp = enabled ? this.colorOp[s] : D3DTOP_DISABLE;
            const alphaOp = enabled ? this.alphaOp[s] : D3DTOP_DISABLE;
            p[s * 4 + 0] =
                (colorOp & 0xff) |
                ((alphaOp & 0xff) << 8) |
                ((this.colorArg0[s] & 0xff) << 16) |
                ((this.alphaArg0[s] & 0xff) << 24);
            p[s * 4 + 1] =
                (this.colorArg1[s] & 0xff) |
                ((this.colorArg2[s] & 0xff) << 8) |
                ((this.alphaArg1[s] & 0xff) << 16) |
                ((this.alphaArg2[s] & 0xff) << 24);
            p[s * 4 + 2] = this.tci[s] >>> 0;
            p[s * 4 + 3] = this.texXformFlags[s] >>> 0;
        }
    }
}

function readStageArg(states: Int32Array, base: number, key: number, def: number): number {
    const value = states[base + key];
    return value === 0 && def !== 0 ? def : value;
}

function currentToDiffuse(arg: number): number {
    return (arg & D3DTA_SELECTMASK) === D3DTA_CURRENT
        ? (arg & ~D3DTA_SELECTMASK) | D3DTA_DIFFUSE
        : arg;
}

function textureToDiffuse(arg: number): number {
    return (arg & D3DTA_SELECTMASK) === D3DTA_TEXTURE
        ? (arg & ~D3DTA_SELECTMASK) | D3DTA_DIFFUSE
        : arg;
}
