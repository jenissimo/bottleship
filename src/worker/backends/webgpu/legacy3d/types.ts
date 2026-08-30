export type Legacy3DApi = "glide" | "opengl";

export const enum Legacy3DCommandType {
    Clear = 1,
    Draw = 2,
}

export type LegacyPrimitiveTopology = "point-list" | "line-list" | "triangle-list";

export interface Legacy3DClearCommand {
    color: number;
    depth: number;
    clearColor: boolean;
    clearDepth: boolean;
}

export interface Legacy3DDrawCommand {
    firstVertex: number;
    vertexCount: number;
    topology: LegacyPrimitiveTopology;
    textureHandle: number;
    useTexture: boolean;
    blendEnabled: boolean;
    depthTestEnabled: boolean;
    depthWriteEnabled: boolean;
    depthFunction: number;
    alphaTestEnabled: boolean;
    alphaRef: number;
    cullMode: number;
    constantColor: number;
    clampS: boolean;
    clampT: boolean;
    filterLinear: boolean;
    // Glide combine / blend / fog state (packed); see glide-combine.ts.
    colorCombine: number; // packCombine()
    alphaCombine: number; // packCombine()
    blend: number; // packBlend() — all four GR_BLEND_* factors
    colorMaskRgb: boolean;
    colorMaskAlpha: boolean;
    alphaTestFunc: number; // GR_CMP_*
    fogMode: number; // GrFogMode_t
    fogColor: number; // 0x00RRGGBB
    /** grTexMipMapMode != GR_MIPMAP_DISABLE — otherwise the TMU samples LOD 0 only. */
    mipMapEnabled: boolean;
    /** grClipWindow, in vertex screen space; the rasterizer must not touch pixels outside it. */
    clipX0: number;
    clipY0: number;
    clipX1: number;
    clipY1: number;
}
