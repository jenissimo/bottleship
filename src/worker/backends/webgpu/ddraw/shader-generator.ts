/**
 * WGSL shader generation for DirectDraw/Direct3D7 WebGPU backend.
 * Generates vertex and fragment shaders based on D3D7 render state configuration.
 *
 * The FFP texture cascade is stage-count-generic: per-stage ops/args/TCI/transform-flags
 * travel in a packed `stages: array<vec4u, MAX_FFP_STAGES>` block (see ffp-stages.ts for
 * the packing), and the fragment cascade is loop-emitted per compiled variant from
 * (stageCount, sampledMask).
 */

import {
    D3DTOP_DISABLE,
    D3DTOP_SELECTARG1,
    D3DTOP_SELECTARG2,
    D3DTOP_MODULATE,
    D3DTOP_MODULATE2X,
    D3DTOP_MODULATE4X,
    D3DTOP_ADD,
    D3DTOP_ADDSIGNED,
    D3DTOP_ADDSIGNED2X,
    D3DTOP_SUBTRACT,
    D3DTOP_BLENDTEXTUREALPHA,
    D3DTOP_BLENDFACTORALPHA,
    D3DTOP_BLENDDIFFUSEALPHA,
    D3DTOP_MULTIPLYADD,
    D3DTOP_LERP,
    D3DTA_TEXTURE,
    D3DTA_DIFFUSE,
    D3DTA_TFACTOR,
    D3DTA_CURRENT,
    D3DTA_COMPLEMENT,
    D3DTA_ALPHAREPLICATE,
    D3DTA_SELECTMASK,
} from "../../../modules/ddraw/constants";
import { DebugFlags } from "./types";
import { MAX_FFP_STAGES, MAX_FFP_SAMPLED_STAGES, MAX_FFP_TEX_MATRICES } from "./ffp-stages";
import {
    FFP_LIGHTSET_STRUCT_WGSL,
    FFP_SELECT_COLOR_WGSL,
    emitFfpComputeLighting,
} from "../d3d9/ffp-lighting";
import { FFP_FOG_WGSL } from "../d3d9/ffp-fog";

/**
 * Per-sampled-stage GPU bind slots: [sampler, texture] for stages 0..3.
 * Binding 0 = uniforms/storage, binding 5 = FFP light set (legacy path only) —
 * the historical stage numbering skips over it.
 */
export const STAGE_BINDINGS: ReadonlyArray<readonly [number, number]> = [
    [1, 2],
    [3, 4],
    [6, 7],
    [8, 9],
];

/**
 * Shader generation configuration
 */
export interface ShaderConfig {
    /** Bit N set = stage N binds + samples a texture (N < MAX_FFP_SAMPLED_STAGES). */
    sampledMask: number;
    /** Number of cascade stage blocks to emit (1 + highest enabled stage). */
    stageCount: number;
    /** D3DRENDERSTATE_SHADEMODE == D3DSHADE_FLAT: flat-shade the diffuse (COLOR0) and specular
     *  (COLOR1) varyings — the provoking (first) vertex's color is used for the whole primitive,
     *  matching real D3D. Games (e.g. Airfix Dogfighter's menu) set only the provoking vertex's
     *  color and leave the rest 0; Gouraud-interpolating that fades every tri to black. */
    flatShading: boolean;
    /** Whether alpha test is enabled */
    alphaTestEnabled: boolean;
    /** Alpha function for alpha test (D3DCMP_*) */
    alphaFunc: number;
    /** Whether alpha blending should be enabled */
    shouldEnableBlending: boolean;
    /** Whether texture is missing (for fallback handling) */
    missingTexture: boolean;
    /** Whether color key is enabled (D3DRENDERSTATE_COLORKEYENABLE) */
    colorKeyEnabled: boolean;
    /** Color key value (not used in shader config, passed via uniform buffer) */
    colorKey: { r: number; g: number; b: number; a: number } | null;
    /** Debug flags for diagnostic rendering */
    debugFlags: DebugFlags;
    /** If true, invert V coordinate in vertex shader (for bottom-up BMP files).
     * Avoids CPU array manipulation in parseBMPPixels by doing flip on GPU.
     */
    needsUVFlip?: boolean;
    /** If true, generate MegaBatch shader variant using storage buffer for per-draw uniforms.
     * Uses instance_index to index into the draws array.
     */
    useMegaBatch?: boolean;
}

/**
 * Generate WGSL expression for alpha test based on D3DCMP function
 */
export function generateAlphaTestExpr(alphaFunc: number): string {
    // D3DCMP_* values:
    // 1=NEVER, 2=LESS, 3=EQUAL, 4=LESSEQUAL, 5=GREATER, 6=NOTEQUAL, 7=GREATEREQUAL, 8=ALWAYS
    // Quantize to 0..255 range for accurate comparison (matches D3D7 hardware behavior)

    switch (alphaFunc | 0) {
        case 1:
            return "false";
        case 2:
            return "u32(clamp(finalColor.a, 0.0, 1.0) * 255.0 + 0.5) < uniforms.alphaRef255";
        case 3:
            return "u32(clamp(finalColor.a, 0.0, 1.0) * 255.0 + 0.5) == uniforms.alphaRef255";
        case 4:
            return "u32(clamp(finalColor.a, 0.0, 1.0) * 255.0 + 0.5) <= uniforms.alphaRef255";
        case 5:
            return "u32(clamp(finalColor.a, 0.0, 1.0) * 255.0 + 0.5) > uniforms.alphaRef255";
        case 6:
            return "u32(clamp(finalColor.a, 0.0, 1.0) * 255.0 + 0.5) != uniforms.alphaRef255";
        case 7:
            return "u32(clamp(finalColor.a, 0.0, 1.0) * 255.0 + 0.5) >= uniforms.alphaRef255";
        case 8:
            return "true";
        default:
            // Default to ALWAYS (true) for unknown functions - D3D7 default is ALWAYS when alphaTestEnabled=true
            return "true";
    }
}

/** Depth CLAMP for a pre-transformed draw whose depth state makes z inert (RHW_DEPTH_CLAMP).
 *  WebGPU always clips against 0 <= z <= w — `depth-clip-control`/`unclippedDepth` is optional
 *  and not requested — while real hardware rasterizes a TL quad whatever its z holds, and games
 *  leave that field stale in the vertex buffer they reuse for HUD sprites. Pulling z inside the
 *  volume is what unclippedDepth would do, minus the feature dependency; nothing reads the
 *  result, since ZENABLE=FALSE forces the compare to ALWAYS and depth writes off. */
const RHW_DEPTH_CLAMP_WGSL = `let zw = out.position.w;
                        let zNdc = select(0.0, out.position.z / zw, zw != 0.0);
                        out.position.z = clamp(zNdc, 0.0, 1.0) * zw;`;

/**
 * Generate WGSL code for Z transformation block
 */
function generateZBlock(forceZMidpoint: boolean): string {
    if (forceZMidpoint) {
        return `// Debug: force Z = 0.5*w to isolate NDC/projection issues
                    out.position.z = 0.5 * out.position.w;`;
    }
    return `let z_ndc = out.position.z / out.position.w;
                    let z_ndc2 = z_ndc * (uniforms.maxZ - uniforms.minZ) + uniforms.minZ;
                    out.position.z = z_ndc2 * out.position.w;`;
}

/** D3DTEXF_POINT is a plain nearest fetch — no coordinate nudge. Real D3D (and Wine
 *  and DXVK, which map D3DTEXF_POINT straight to VK_FILTER_NEAREST) bias nothing, and
 *  a nudge shifts a glyph-atlas cell into its neighbour: Hitman's HUD strings came out
 *  as fragments of the wrong letters. */
function generateTextureSample(textureName: string, samplerName: string, uvExpr: string): string {
    return `textureSample(${textureName}, ${samplerName}, ${uvExpr})`;
}

/**
 * Generate WGSL helper functions for color and alpha operations
 */
function generateShaderHelpers(): string {
    return `
${FFP_FOG_WGSL}

fn selectTexCoord(rawIndex: u32, uv0: vec2f, uv1: vec2f, uv2: vec2f) -> vec2f {
    let index = rawIndex & 0xffffu;
    if (index == 1u) {
        return uv1;
    }
    if (index == 2u) {
        return uv2;
    }
    return uv0;
}

fn resolveColorArg(arg: u32, texColor: vec3f, currentColor: vec3f, diffuse: vec3f, textureFactor: vec3f, texAlpha: f32, currentAlpha: f32, diffuseAlpha: f32, factorAlpha: f32) -> vec3f {
    let argType = arg & ${D3DTA_SELECTMASK}u;
    var result: vec3f;
    var sourceAlpha: f32;

    if (argType == ${D3DTA_TEXTURE}u) {
        result = texColor;
        sourceAlpha = texAlpha;
    } else if (argType == ${D3DTA_TFACTOR}u) {
        result = textureFactor;
        sourceAlpha = factorAlpha;
    } else if (argType == ${D3DTA_CURRENT}u) {
        result = currentColor;
        sourceAlpha = currentAlpha;
    } else {
        result = diffuse;
        sourceAlpha = diffuseAlpha;
    }

    if ((arg & ${D3DTA_ALPHAREPLICATE}u) != 0u) {
        result = vec3f(sourceAlpha);
    }

    if ((arg & ${D3DTA_COMPLEMENT}u) != 0u) {
        result = vec3f(1.0) - result;
    }
    return result;
}

fn resolveAlphaArg(arg: u32, texAlpha: f32, currentAlpha: f32, diffuseAlpha: f32, factorAlpha: f32) -> f32 {
    let argType = arg & ${D3DTA_SELECTMASK}u;
    var result: f32;
    if (argType == ${D3DTA_TEXTURE}u) {
        result = texAlpha;
    } else if (argType == ${D3DTA_TFACTOR}u) {
        result = factorAlpha;
    } else if (argType == ${D3DTA_CURRENT}u) {
        result = currentAlpha;
    } else {
        result = diffuseAlpha;
    }
    if ((arg & ${D3DTA_COMPLEMENT}u) != 0u) {
        result = 1.0 - result;
    }
    return result;
}

fn applyColorOp(op: u32, arg0: vec3f, arg1: vec3f, arg2: vec3f, texAlpha: f32, factorAlpha: f32, diffuseAlpha: f32) -> vec3f {
    if (op == ${D3DTOP_SELECTARG1}u) { return arg1; }
    if (op == ${D3DTOP_SELECTARG2}u) { return arg2; }
    if (op == ${D3DTOP_MODULATE}u)   { return arg1 * arg2; }
    if (op == ${D3DTOP_MODULATE2X}u) { return clamp(arg1 * arg2 * 2.0, vec3f(0.0), vec3f(1.0)); }
    if (op == ${D3DTOP_MODULATE4X}u) { return clamp(arg1 * arg2 * 4.0, vec3f(0.0), vec3f(1.0)); }
    if (op == ${D3DTOP_ADD}u)        { return clamp(arg1 + arg2, vec3f(0.0), vec3f(1.0)); }
    if (op == ${D3DTOP_SUBTRACT}u)   { return clamp(arg1 - arg2, vec3f(0.0), vec3f(1.0)); }
    if (op == ${D3DTOP_ADDSIGNED}u)  { return clamp(arg1 + arg2 - 0.5, vec3f(0.0), vec3f(1.0)); }
    if (op == ${D3DTOP_ADDSIGNED2X}u){ return clamp((arg1 + arg2 - 0.5) * 2.0, vec3f(0.0), vec3f(1.0)); }
    if (op == ${D3DTOP_BLENDDIFFUSEALPHA}u) {
        return arg1 * diffuseAlpha + arg2 * (1.0 - diffuseAlpha);
    }
    if (op == ${D3DTOP_BLENDTEXTUREALPHA}u) {
        return arg1 * texAlpha + arg2 * (1.0 - texAlpha);
    }
    if (op == ${D3DTOP_BLENDFACTORALPHA}u) {
        return arg1 * factorAlpha + arg2 * (1.0 - factorAlpha);
    }
    if (op == ${D3DTOP_MULTIPLYADD}u) { return clamp(arg0 + arg1 * arg2, vec3f(0.0), vec3f(1.0)); }
    if (op == ${D3DTOP_LERP}u) { return arg1 * arg0 + arg2 * (vec3f(1.0) - arg0); }
    return arg1 * arg2; // Default to MODULATE
}

fn applyAlphaOp(op: u32, currentAlpha: f32, a0: f32, a1: f32, a2: f32, texAlpha: f32, factorAlpha: f32, diffuseAlpha: f32) -> f32 {
    if (op == ${D3DTOP_DISABLE}u)    { return currentAlpha; }
    if (op == ${D3DTOP_SELECTARG1}u) { return a1; }
    if (op == ${D3DTOP_SELECTARG2}u) { return a2; }
    if (op == ${D3DTOP_MODULATE}u)   { return a1 * a2; }
    if (op == ${D3DTOP_MODULATE2X}u) { return clamp(a1 * a2 * 2.0, 0.0, 1.0); }
    if (op == ${D3DTOP_MODULATE4X}u) { return clamp(a1 * a2 * 4.0, 0.0, 1.0); }
    if (op == ${D3DTOP_ADD}u)        { return clamp(a1 + a2, 0.0, 1.0); }
    if (op == ${D3DTOP_SUBTRACT}u)   { return clamp(a1 - a2, 0.0, 1.0); }
    if (op == ${D3DTOP_ADDSIGNED}u)  { return clamp(a1 + a2 - 0.5, 0.0, 1.0); }
    if (op == ${D3DTOP_ADDSIGNED2X}u){ return clamp((a1 + a2 - 0.5) * 2.0, 0.0, 1.0); }
    if (op == ${D3DTOP_BLENDDIFFUSEALPHA}u) {
        return a1 * diffuseAlpha + a2 * (1.0 - diffuseAlpha);
    }
    if (op == ${D3DTOP_BLENDTEXTUREALPHA}u) {
        return a1 * texAlpha + a2 * (1.0 - texAlpha);
    }
    if (op == ${D3DTOP_BLENDFACTORALPHA}u) {
        return a1 * factorAlpha + a2 * (1.0 - factorAlpha);
    }
    if (op == ${D3DTOP_MULTIPLYADD}u) { return clamp(a0 + a1 * a2, 0.0, 1.0); }
    if (op == ${D3DTOP_LERP}u) { return a1 * a0 + a2 * (1.0 - a0); }
    return a1 * a2; // Default to MODULATE
}
`;
}

/** Per-sampled-stage sampler/texture binding declarations for the enabled mask. */
function generateStageBindings(sampledMask: number): string {
    let out = "";
    for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
        if ((sampledMask & (1 << s)) === 0) continue;
        const [samplerBinding, textureBinding] = STAGE_BINDINGS[s];
        out += `
            @group(0) @binding(${samplerBinding}) var tex${s}Sampler: sampler;
            @group(0) @binding(${textureBinding}) var tex${s}: texture_2d<f32>;`;
    }
    return out;
}

/**
 * Emit one FFP cascade stage block for the fragment shader.
 *
 * Ops/args are dynamic (read from the packed stages block), so the only compile-time
 * variation is whether the stage samples its texture (binding exists). Stage 0 keeps its
 * historical texColor fallback: with no texture bound the "texture" input is the diffuse
 * color (D3DTA_TEXTURE args were already remapped to DIFFUSE by the resolver, so this
 * only affects the colorkey path and texAlpha).
 */
function emitStageBlock(s: number, prefix: string, sampled: boolean): string {
    const uvExpr = s === 0 ? "in.uv" : `in.uv${s}`;
    const texColorExpr = sampled
        ? generateTextureSample(`tex${s}`, `tex${s}Sampler`, uvExpr)
        : (s === 0 ? "diffuse" : "vec4f(0.0, 0.0, 0.0, 1.0)");
    return `
                // ---- FFP stage ${s} ----
                let sp${s} = ${prefix}.stages[${s}];
                let colorOp${s} = sp${s}.x & 0xffu;
                let alphaOp${s} = (sp${s}.x >> 8u) & 0xffu;
                // Non-sampling stages never reference tex${s}Color: the resolver
                // remaps/never-produces D3DTA_TEXTURE args for them.
                var tex${s}Color = ${texColorExpr};
                let tex${s}Alpha = tex${s}Color.a;

                let cArg1_${s} = resolveColorArg(sp${s}.y & 0xffu, tex${s}Color.rgb, currentColor, diffuse.rgb, ${prefix}.textureFactor.rgb, tex${s}Alpha, currentAlpha, diffuse.a, factorAlpha);
                let cArg2_${s} = resolveColorArg((sp${s}.y >> 8u) & 0xffu, tex${s}Color.rgb, currentColor, diffuse.rgb, ${prefix}.textureFactor.rgb, tex${s}Alpha, currentAlpha, diffuse.a, factorAlpha);
                let cArg0_${s} = resolveColorArg((sp${s}.x >> 16u) & 0xffu, tex${s}Color.rgb, currentColor, diffuse.rgb, ${prefix}.textureFactor.rgb, tex${s}Alpha, currentAlpha, diffuse.a, factorAlpha);
                if (colorOp${s} != ${D3DTOP_DISABLE}u) {
                    currentColor = applyColorOp(colorOp${s}, cArg0_${s}, cArg1_${s}, cArg2_${s}, tex${s}Alpha, factorAlpha, diffuse.a);
                }

                let aArg1_${s} = resolveAlphaArg((sp${s}.y >> 16u) & 0xffu, tex${s}Alpha, currentAlpha, diffuse.a, factorAlpha);
                let aArg2_${s} = resolveAlphaArg((sp${s}.y >> 24u) & 0xffu, tex${s}Alpha, currentAlpha, diffuse.a, factorAlpha);
                let aArg0_${s} = resolveAlphaArg((sp${s}.x >> 24u) & 0xffu, tex${s}Alpha, currentAlpha, diffuse.a, factorAlpha);
                currentAlpha = applyAlphaOp(alphaOp${s}, currentAlpha, aArg0_${s}, aArg1_${s}, aArg2_${s}, tex${s}Alpha, factorAlpha, diffuse.a);
`;
}

/** Emit the whole cascade for stages 0..stageCount-1. */
function emitStageCascade(config: ShaderConfig, prefix: string): string {
    let out = "";
    const count = Math.max(1, Math.min(MAX_FFP_STAGES, config.stageCount));
    for (let s = 0; s < count; s++) {
        const sampled = (config.sampledMask & (1 << s)) !== 0 && s < MAX_FFP_SAMPLED_STAGES;
        out += emitStageBlock(s, prefix, sampled);
    }
    return out;
}

/**
 * Per-stage texture-coordinate source + transform, computed in the vertex shader.
 *
 * genTexCoordSrc selects the stage's PRE-matrix source coordinate from the raw
 * D3DTSS_TEXCOORDINDEX (stages[N].z). The high 16 bits are a D3DTSS_TCI_* texgen mode;
 * the low 16 bits pick a vertex UV set for passthrough:
 *   0 PASSTHRU               → vertex UV, extended to (u, v, 1, 0)
 *   1 CAMERASPACENORMAL      → view-space normal,            (x, y, z, 1)
 *   2 CAMERASPACEPOSITION    → view-space position,          (x, y, z, 1)
 *   3 CAMERASPACEREFLECTION  → view-space eye-reflection vec, (x, y, z, 1)
 * The generated 3-vector pads its 4th component with 1 so the texture matrix's
 * translation column applies (env-map bias/scale); passthrough keeps the legacy
 * (u, v, 1, 0) convention.
 *
 * applyTexXform (D3DTSS_TEXTURETRANSFORMFLAGS + texture matrix, stages[N].w): a 2D
 * input texcoord extended to (u, v, 1, 0) is transformed with row-vector semantics
 * against the D3D row-major matrix. Our mat4x4 uniforms are uploaded with the
 * row-major D3D bytes and read column-major by WGSL, so `m * v` yields exactly that
 * row-vector product (same convention as uniforms.mvp).
 * flags: D3DTTFF count in the low byte, PROJECTED at bit 8; 0 = stage untransformed.
 * PROJECTED divides by the output component at index count-1. Known approximation:
 * the divide runs per-vertex here (our varyings are vec2), while real D3D hardware
 * interpolates the full coordinate and divides per-pixel.
 */
const TEX_XFORM_HELPER = `
fn genTexCoordSrc(rawIndex: u32, uv0: vec2f, uv1: vec2f, uv2: vec2f, camPos: vec3f, camNormal: vec3f, camReflect: vec3f) -> vec4f {
    let mode = (rawIndex >> 16u) & 0xffffu;
    if (mode == 1u) { return vec4f(camNormal, 1.0); }
    if (mode == 2u) { return vec4f(camPos, 1.0); }
    if (mode == 3u) { return vec4f(camReflect, 1.0); }
    return vec4f(selectTexCoord(rawIndex, uv0, uv1, uv2), 1.0, 0.0);
}

fn applyTexXform(src: vec4f, m: mat4x4<f32>, flags: u32) -> vec2f {
    if (flags == 0u) { return src.xy; }
    let count = flags & 0xffu;
    let v = m * src;
    if ((flags & 256u) != 0u && count >= 2u) {
        let p = v[count - 1u];
        if (abs(p) > 1e-6) { return v.xy / p; }
    }
    return v.xy;
}`;

/**
 * Generate complete WGSL shader code
 */
export function generateShaderCode(config: ShaderConfig): string {
    const { alphaTestEnabled, alphaFunc, shouldEnableBlending, colorKeyEnabled: _ck, debugFlags, needsUVFlip = false } = config;
    const useTexture = (config.sampledMask & 1) !== 0;

    const zBlock = generateZBlock(debugFlags.forceZMidpoint);
    const alphaDiscardExpr = generateAlphaTestExpr(alphaFunc);

    const uniformsStruct = `
            struct Uniforms {
                viewport: vec2f,
                minZ: f32,
                maxZ: f32,
                alphaRef255: u32,
                isRHW: u32,
                lightingEnabled: u32,
                colorKeyEnabled: u32,
                specularEnable: u32,
                premultiplyOutput: u32,
                hasNormal: u32,
                localViewer: u32,
                colorKey: vec4f,
                ambientColor: vec4f,
                textureFactor: vec4f,
                mvp: mat4x4<f32>,
                fogColor: vec4f,
                fogParams: vec4f,
                stages: array<vec4u, ${MAX_FFP_STAGES}>,
                world: mat4x4<f32>,
                matDiffuse: vec4f,
                matAmbient: vec4f,
                matSpecular: vec4f,
                matEmissive: vec4f,
                matPower: f32,
                matDiffuseSrc: u32,
                matAmbientSrc: u32,
                matSpecularSrc: u32,
                matEmissiveSrc: u32,
                _pad2: u32,
                _pad3: u32,
                _pad4: u32,
                texMat0: mat4x4<f32>,
                texMat1: mat4x4<f32>,
                texMat2: mat4x4<f32>,
                worldView: mat4x4<f32>,
                // @736: D3DRS_CLIPPLANEENABLE bitmask (bit N = user clip plane N enabled).
                // Occupies the first free spare word after worldView (672..735). Default 0 →
                // clipping fully inert (see vs_main/fs_main). Kept in lockstep with the JS
                // writer in ring-buffer-manager.ts allocateUniformSlot (view.setUint32(736,...)).
                clipPlaneEnable: u32,
            }`;

    const bindings = `
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            ${generateStageBindings(config.sampledMask)}
            `;

    const vertexOutput = `
            struct VertexOutput {
                @builtin(position) position: vec4f,
                @location(0) ${config.flatShading ? "@interpolate(flat) " : ""}color: vec4f,
                @location(1) ${config.flatShading ? "@interpolate(flat) " : ""}specular: vec4f,
                @location(2) uv: vec2f,
                @location(3) uv1: vec2f,
                @location(4) fogFactor: f32,
                @location(5) normal: vec3f,
                @location(6) uv2: vec2f,
                @location(7) uv3: vec2f,
                // FFP user clip-plane signed distances (planes 0..5), interpolated so the
                // fragment stage can discard per-pixel. clipDistA = planes 0..3, clipDistB =
                // planes 4..5. Written to a constant (>=0, no clip) when clipping is inert.
                @location(8) clipDistA: vec4f,
                @location(9) clipDistB: vec2f,
            }`;

    const vertexShader = `
            @vertex
            fn vs_main(
                @location(0) pos: vec4f,
                @location(1) normal: vec3f,
                @location(2) color: vec4f,
                @location(3) specular: vec4f,
                @location(4) uv: vec2f,
                @location(5) uv1: vec2f,
                @location(6) uv2: vec2f
            ) -> VertexOutput {
                var out: VertexOutput;

                // Camera-space texgen inputs (D3DTSS_TCI_CAMERASPACE*): the vertex
                // position/normal in view (camera) space and the eye-reflection vector.
                // genTexCoordSrc feeds these to a stage whose TEXCOORDINDEX carries texgen
                // flags (env mapping, projected terrain diffuse); passthrough otherwise.
                // Cheap for the common non-texgen case (a few MACs per vertex).
                let tcCamPos = (uniforms.worldView * vec4f(pos.xyz, 1.0)).xyz;
                let tcCamNormal = normalize((uniforms.worldView * vec4f(normal, 0.0)).xyz);
                let tcCamReflect = reflect(normalize(tcCamPos), tcCamNormal);

                // Apply UV flip if needed (for bottom-up BMP files); only ever the
                // passthrough UV set — BMP-loaded textures are never texgen-sourced.
                var src0 = genTexCoordSrc(uniforms.stages[0].z, uv, uv1, uv2, tcCamPos, tcCamNormal, tcCamReflect);
                ${needsUVFlip ? 'src0 = vec4f(src0.x, 1.0 - src0.y, src0.z, src0.w);' : ''}
                var adjustedUV = applyTexXform(src0, uniforms.texMat0, uniforms.stages[0].w);

                if ((uniforms.isRHW & 1u) != 0u) {
                    out.position = pos;
                    if ((uniforms.isRHW & 2u) != 0u) {
                        ${RHW_DEPTH_CLAMP_WGSL}
                    }
                } else {
                    out.position = uniforms.mvp * vec4f(pos.xyz, 1.0);
                    ${zBlock}
                }

                // Swizzle BGRA -> RGBA
                var vDiffuse = color.bgra;
                var vSpecular = specular.bgra;

                // FFP Lighting. D3D7 rule: lighting affects ONLY RGB. Alpha of the lit
                // pixel is the source-selected diffuse alpha (matDiffuse.a for MATERIAL,
                // vDiffuse.a for COLOR1), never summed across emissive/ambient/lights.
                // Summing alphas produces 2×matAlpha (emissive + ambient*1.0 for a typical
                // all-white material with global ambient alpha=1.0), which clamps to 1.0
                // once matAlpha>=0.5 and turns smooth crossfades into binary flickers.
                if (uniforms.lightingEnabled != 0u && (uniforms.isRHW & 1u) == 0u) {
                    // Full D3D fixed-function lighting (all enabled lights from the shared light set,
                    // directional/point/spot + attenuation + spot cone + specular). Computed in VIEW
                    // space (worldView), matching the D3D9 reference path: the shared math's infinite
                    // viewer dir (0,0,-1) and the CPU-side world→view light transform both assume view
                    // space. localViewer + hasNormal come from real per-draw state (RS + FVF), so a
                    // normal-less draw correctly collapses to ambient+emissive.
                    let ecPos = (uniforms.worldView * vec4f(pos.xyz, 1.0)).xyz;
                    let ecNormal = (uniforms.worldView * vec4f(normal, 0.0)).xyz;
                    let lit = ffpComputeLighting(
                        ecPos, ecNormal,
                        uniforms.matDiffuse, uniforms.matAmbient, uniforms.matSpecular, uniforms.matEmissive,
                        uniforms.matPower, uniforms.specularEnable != 0u, uniforms.localViewer != 0u, uniforms.hasNormal != 0u,
                        // The ddraw uniform block carries no D3DRENDERSTATE_NORMALIZENORMALS,
                        // so this path cannot observe the state and always normalizes.
                        true,
                        f32(uniforms.matDiffuseSrc), f32(uniforms.matAmbientSrc),
                        f32(uniforms.matSpecularSrc), f32(uniforms.matEmissiveSrc),
                        uniforms.ambientColor.rgb, i32(ffpLightSet.count.x),
                        vDiffuse, vSpecular);
                    vDiffuse = lit[0];
                    // Lit specular replaces the vertex-specular RGB (added post-texture in fs when
                    // SPECULARENABLE); keep its alpha (used as the per-vertex fog factor).
                    vSpecular = vec4f(lit[1].rgb, vSpecular.a);
                }

                out.color = vDiffuse;
                out.specular = vSpecular;
                out.uv = adjustedUV;
                out.uv1 = applyTexXform(genTexCoordSrc(uniforms.stages[1].z, uv, uv1, uv2, tcCamPos, tcCamNormal, tcCamReflect), uniforms.texMat1, uniforms.stages[1].w);
                out.uv2 = applyTexXform(genTexCoordSrc(uniforms.stages[2].z, uv, uv1, uv2, tcCamPos, tcCamNormal, tcCamReflect), uniforms.texMat2, uniforms.stages[2].w);
                // Stage 3 has no texture-matrix slot (MAX_FFP_TEX_MATRICES=${MAX_FFP_TEX_MATRICES}); untransformed source.
                out.uv3 = genTexCoordSrc(uniforms.stages[3].z, uv, uv1, uv2, tcCamPos, tcCamNormal, tcCamReflect).xy;
                out.normal = normal;

                // Fog: mode encoding + formula live in ffp-fog.ts, shared with the D3D9 FFP.
                out.fogFactor = ffpFogFactor(uniforms.fogParams.w, uniforms.fogParams.x,
                    uniforms.fogParams.y, uniforms.fogParams.z,
                    out.position.z, out.position.w, vSpecular.a);

                // FFP user clip planes. D3D fixed-function evaluates the plane equations in
                // WORLD space: DXVK's d3d9_fixed_function_vert.vert emitVsClipping() computes
                // worldPos = InverseView * viewPos (== World * objPos) and dist = dot(worldPos,
                // clipPlane) with the plane kept RAW (no transform). We already upload the world
                // matrix (uniforms.world), so worldPos = uniforms.world * objPos directly — no
                // inverse-view matrix needed. Inert unless a plane is enabled (default 0). Skipped
                // for pre-transformed (XYZRHW) draws — those have no meaningful world transform.
                var cpaClip = vec4f(1.0, 1.0, 1.0, 1.0);
                var cpbClip = vec2f(1.0, 1.0);
                if (uniforms.clipPlaneEnable != 0u && (uniforms.isRHW & 1u) == 0u) {
                    let worldPos = uniforms.world * vec4f(pos.xyz, 1.0);
                    cpaClip = vec4f(
                        dot(worldPos, ffpClipPlanes.planes[0]),
                        dot(worldPos, ffpClipPlanes.planes[1]),
                        dot(worldPos, ffpClipPlanes.planes[2]),
                        dot(worldPos, ffpClipPlanes.planes[3]));
                    cpbClip = vec2f(
                        dot(worldPos, ffpClipPlanes.planes[4]),
                        dot(worldPos, ffpClipPlanes.planes[5]));
                }
                out.clipDistA = cpaClip;
                out.clipDistB = cpbClip;
                return out;
            }`;

    // Build fragment shader body.
    // Texture stage operations ALWAYS run, even if stage 0 samples no texture:
    // in D3D7 stage 0 runs unless explicitly disabled, with D3DTA_TEXTURE args
    // resolved to DIFFUSE by the CPU-side resolver when no texture is bound.
    const fragmentShaderBody = `
                // FFP user clip planes: discard fragments outside any ENABLED plane
                // (D3D clips where the signed distance is negative). Portable per-pixel
                // equivalent of gl_ClipDistance (WebGPU's clip-distances builtin is optional).
                // Inert when clipPlaneEnable == 0 (the common case): no branch taken, no discard.
                let clipEnable = uniforms.clipPlaneEnable;
                if (clipEnable != 0u) {
                    if ((clipEnable & 1u) != 0u && in.clipDistA.x < 0.0) { discard; }
                    if ((clipEnable & 2u) != 0u && in.clipDistA.y < 0.0) { discard; }
                    if ((clipEnable & 4u) != 0u && in.clipDistA.z < 0.0) { discard; }
                    if ((clipEnable & 8u) != 0u && in.clipDistA.w < 0.0) { discard; }
                    if ((clipEnable & 16u) != 0u && in.clipDistB.x < 0.0) { discard; }
                    if ((clipEnable & 32u) != 0u && in.clipDistB.y < 0.0) { discard; }
                }

                var diffuse = in.color;
                var currentColor = diffuse.rgb;
                var currentAlpha = diffuse.a;
                let factorAlpha = uniforms.textureFactor.a;

                ${emitStageCascade(config, "uniforms")}

                ${useTexture ? `
                // Colorkey check: discard pixels matching the color key RGB value.
                // Only checks RGB match — alpha-based discard is handled by alpha test or
                // blend equations, not colorkey.
                if (uniforms.colorKeyEnabled != 0u) {
                    let ckEps = 1.0 / 255.0;
                    let diff = abs(tex0Color.rgb - uniforms.colorKey.rgb);
                    let ckMatch = all(diff <= vec3f(ckEps));
                    if (ckMatch) {
                        discard;
                    }
                }
                ` : ""}

                // D3D7 fixed-function: specular RGB contributes only when SPECULARENABLE is set.
                if (uniforms.specularEnable != 0u) {
                    currentColor = clamp(currentColor + in.specular.rgb, vec3f(0.0), vec3f(1.0));
                }

                var finalColor = vec4f(currentColor, currentAlpha);

                if (uniforms.premultiplyOutput != 0u) {
                    finalColor = vec4f(finalColor.rgb * finalColor.a, finalColor.a);
                }
                `;

    // Add alpha test if enabled
    const alphaTestBlock = alphaTestEnabled
        ? `
                if (!(${alphaDiscardExpr})) { discard; }`
        : "";

    const fogBlock = `
                if (uniforms.fogParams.w > 0.0) {
                    finalColor = vec4f(mix(finalColor.rgb, uniforms.fogColor.rgb, in.fogFactor), finalColor.a);
                }`;
    const fragmentShader = `
            @fragment
            fn fs_main(in: VertexOutput) -> @location(0) vec4f {
                ${fragmentShaderBody}
                ${alphaTestBlock}
                ${fogBlock}
                ${!shouldEnableBlending ? `
                // When ALPHABLENDENABLE=0, force alpha=1.0 to prevent ARGB1555 alpha=0
                // from leaking into intermediate render targets.
                finalColor = vec4f(finalColor.rgb, 1.0);
                ` : ''}
                return finalColor;
            }`;

    // Shared FFP lighting: the device-global light set (binding 5) + the shared compute fn.
    // Per-draw material/world come from the uniform slot (binding 0); lighting runs in world space.
    const lightingDecls = `${FFP_LIGHTSET_STRUCT_WGSL}
@group(0) @binding(5) var<uniform> ffpLightSet: FfpLightSet;
${FFP_SELECT_COLOR_WGSL}
${emitFfpComputeLighting("ffpLightSet.lights")}`;

    // Device-global FFP user clip planes (binding 6), mirroring the binding-5 light set.
    // Coefficients are the RAW world-space plane equations as set by SetClipPlane (D3D FFP
    // defines them in world space); the VS evaluates dot(worldPos, plane) — see vs_main.
    // Read only in the vertex stage. Always present so the pipeline/bind-group layout matches
    // even for inert draws (clipPlaneEnable == 0), whose shader never reads these values.
    const clipPlaneDecls = `
struct FfpClipPlanes {
    planes: array<vec4f, 6>,
}
@group(0) @binding(6) var<uniform> ffpClipPlanes: FfpClipPlanes;`;

    return `${uniformsStruct}
${bindings}
${lightingDecls}
${clipPlaneDecls}
${generateShaderHelpers()}
${TEX_XFORM_HELPER}
${vertexOutput}
${vertexShader}
${fragmentShader}`;
}

/**
 * Generate MegaBatch WGSL shader code.
 * Uses storage buffer for per-draw uniforms, indexed by instance_index.
 * This allows batching draws with different MVP matrices and render states.
 *
 * Storage slot layout (512 bytes per draw, matches allocateDrawUniforms):
 *    0..64   mvp: mat4x4<f32>
 *   64..80   textureFactor: vec4f
 *   80..96   colorKey: vec4f
 *   96..112  ambientColor: vec4f
 *  112..128  fogColor: vec4f
 *  128..144  fogParams: vec4f (start, end, density, mode)
 *  144..160  viewport: vec4f (width, height, minZ, maxZ)
 *  160..176  misc: vec4u (alphaRef255, rhwFlags, lightingEnabled, colorKeyEnabled)
 *  176..192  misc2: vec4u (premultiplyOutput, alphaTestEnabled, alphaFunc, specularEnable)
 *  192..320  stages: array<vec4u, MAX_FFP_STAGES>
 *  320..384  world: mat4x4<f32>
 *  384..448  matDiffuse/matAmbient/matSpecular/matEmissive: vec4f×4
 *  448..464  matParams: vec4f (x = power)
 *  464..480  matSrcs: vec4u (diffuseSrc, ambientSrc, specularSrc, emissiveSrc)
 *  480..496  lightColor: vec4f
 *  496..512  lightDir: vec4f (xyz = dir, w = hasDirLight flag)
 *
 * MegaBatch is vetoed for draws with texture transforms or camera-space texgen, so
 * stages[N].w is always 0 here and TCI passthrough (selectTexCoord) suffices.
 */
export function generateMegaBatchShaderCode(config: ShaderConfig): string {
    const { shouldEnableBlending, debugFlags, needsUVFlip = false } = config;
    const useTexture = (config.sampledMask & 1) !== 0;
    // NOTE: alphaTestEnabled and alphaFunc are dynamic uniforms, not compile-time constants

    const drawUniformsStruct = `
            struct DrawUniforms {
                mvp: mat4x4<f32>,
                textureFactor: vec4f,
                colorKey: vec4f,
                ambientColor: vec4f,
                fogColor: vec4f,
                fogParams: vec4f,
                viewport: vec4f,
                misc: vec4u,
                misc2: vec4u,
                stages: array<vec4u, ${MAX_FFP_STAGES}>,
                world: mat4x4<f32>,
                matDiffuse: vec4f,
                matAmbient: vec4f,
                matSpecular: vec4f,
                matEmissive: vec4f,
                matParams: vec4f,
                matSrcs: vec4u,
                lightColor: vec4f,
                lightDir: vec4f,
            }`;

    const bindings = `
            @group(0) @binding(0) var<storage, read> draws: array<DrawUniforms>;
            ${generateStageBindings(config.sampledMask)}
            `;

    const vertexOutput = `
            struct VertexOutput {
                @builtin(position) position: vec4f,
                @location(0) ${config.flatShading ? "@interpolate(flat) " : ""}color: vec4f,
                @location(1) ${config.flatShading ? "@interpolate(flat) " : ""}specular: vec4f,
                @location(2) uv: vec2f,
                @location(3) uv1: vec2f,
                @location(4) fogFactor: f32,
                @location(5) @interpolate(flat) drawIndex: u32,
                @location(6) normal: vec3f,
                @location(7) uv2: vec2f,
                @location(8) uv3: vec2f,
            }`;

    // Vertex shader uses instance_index to index into draws array
    const vertexShader = `
            @vertex
            fn vs_main(
                @location(0) pos: vec4f,
                @location(1) normal: vec3f,
                @location(2) color: vec4f,
                @location(3) specular: vec4f,
                @location(4) uv: vec2f,
                @location(5) uv1: vec2f,
                @location(6) uv2: vec2f,
                @builtin(instance_index) drawId: u32
            ) -> VertexOutput {
                var out: VertexOutput;
                let draw = draws[drawId];

                // Pass draw index to fragment shader
                out.drawIndex = drawId;

                // Apply UV flip if needed
                var adjustedUV = selectTexCoord(draw.stages[0].z, uv, uv1, uv2);
                ${needsUVFlip ? 'adjustedUV.y = 1.0 - adjustedUV.y;' : ''}

                if ((draw.misc.y & 1u) != 0u) { // isRHW
                    out.position = pos;
                    if ((draw.misc.y & 2u) != 0u) {
                        ${RHW_DEPTH_CLAMP_WGSL}
                    }
                } else {
                    out.position = draw.mvp * vec4f(pos.xyz, 1.0);
                    // Z remap
                    let minZ = draw.viewport.z;
                    let maxZ = draw.viewport.w;
                    ${debugFlags.forceZMidpoint
                        ? 'out.position.z = 0.5 * out.position.w;'
                        : `let z_ndc = out.position.z / out.position.w;
                    let z_ndc2 = z_ndc * (maxZ - minZ) + minZ;
                    out.position.z = z_ndc2 * out.position.w;`
                    }
                }

                // Swizzle BGRA -> RGBA
                var vDiffuse = color.bgra;
                var vSpecular = specular.bgra;

                // FFP Lighting — D3D7 rule: lighting affects ONLY RGB. Alpha is the
                // source-selected diffuse alpha (matDiffuse.a for MATERIAL, vDiffuse.a
                // for COLOR1). Summing alphas across emissive/ambient/lights produces
                // 2×matAlpha and saturates fades to opaque past 0.5.
                if (draw.misc.z != 0u && (draw.misc.y & 1u) == 0u) { // lightingEnabled && !isRHW
                    let worldNorm = normalize((draw.world * vec4f(normal, 0.0)).xyz);

                    let emissiveColor = select(draw.matEmissive.rgb, vDiffuse.rgb, draw.matSrcs.w == 1u);
                    var litColor = emissiveColor;

                    let ambColor = select(draw.matAmbient.rgb, vDiffuse.rgb, draw.matSrcs.y == 1u);
                    litColor += ambColor * draw.ambientColor.rgb;

                    if (draw.lightDir.w != 0.0) { // hasDirLight
                        let diffColor = select(draw.matDiffuse.rgb, vDiffuse.rgb, draw.matSrcs.x == 1u);
                        let L = normalize(-draw.lightDir.xyz);
                        let nDotL = max(dot(worldNorm, L), 0.0);
                        litColor += diffColor * draw.lightColor.rgb * nDotL;
                    }

                    let litA = select(draw.matDiffuse.a, vDiffuse.a, draw.matSrcs.x == 1u);
                    vDiffuse = vec4f(clamp(litColor, vec3f(0.0), vec3f(1.0)), clamp(litA, 0.0, 1.0));
                }

                out.color = vDiffuse;
                out.specular = vSpecular;
                out.uv = adjustedUV;
                out.uv1 = selectTexCoord(draw.stages[1].z, uv, uv1, uv2);
                out.uv2 = selectTexCoord(draw.stages[2].z, uv, uv1, uv2);
                out.uv3 = selectTexCoord(draw.stages[3].z, uv, uv1, uv2);
                out.normal = normal;

                out.fogFactor = ffpFogFactor(draw.fogParams.w, draw.fogParams.x,
                    draw.fogParams.y, draw.fogParams.z,
                    out.position.z, out.position.w, vSpecular.a);

                return out;
            }`;

    // Fragment shader reads per-draw uniforms from storage buffer
    const fragmentShader = `
            @fragment
            fn fs_main(in: VertexOutput) -> @location(0) vec4f {
                let draw = draws[in.drawIndex];

                var diffuse = in.color;
                var currentColor = diffuse.rgb;
                var currentAlpha = diffuse.a;
                let factorAlpha = draw.textureFactor.a;

                ${emitStageCascade(config, "draw")}

                ${useTexture ? `
                // Colorkey check: discard pixels matching the color key RGB value.
                // Only checks RGB match — alpha-based discard is handled by alpha test or
                // blend equations, not colorkey.
                let colorKeyEnabled = draw.misc.w;
                if (colorKeyEnabled != 0u) {
                    let ckEps = 1.0 / 255.0;
                    let diff = abs(tex0Color.rgb - draw.colorKey.rgb);
                    let ckMatch = all(diff <= vec3f(ckEps));
                    if (ckMatch) {
                        discard;
                    }
                }
                ` : ''}

                let specularEnable = draw.misc2.w;
                if (specularEnable != 0u) {
                    currentColor = clamp(currentColor + in.specular.rgb, vec3f(0.0), vec3f(1.0));
                }

                var finalColor = vec4f(currentColor, currentAlpha);

                // Premultiply if needed
                let premultiply = draw.misc2.x;
                if (premultiply != 0u) {
                    finalColor = vec4f(finalColor.rgb * finalColor.a, finalColor.a);
                }

                // Dynamic alpha test (alphaTestEnabled and alphaFunc are runtime uniforms)
                let alphaTestEnabled = draw.misc2.y;
                let alphaFunc = draw.misc2.z;
                if (alphaTestEnabled != 0u) {
                    let alphaRef255 = draw.misc.x;
                    let alpha255 = u32(clamp(finalColor.a, 0.0, 1.0) * 255.0 + 0.5);
                    var alphaTestPass = true;
                    // D3DCMP_*: 1=NEVER, 2=LESS, 3=EQUAL, 4=LESSEQUAL, 5=GREATER, 6=NOTEQUAL, 7=GREATEREQUAL, 8=ALWAYS
                    switch (alphaFunc) {
                        case 1u: { alphaTestPass = false; }        // NEVER
                        case 2u: { alphaTestPass = alpha255 < alphaRef255; }   // LESS
                        case 3u: { alphaTestPass = alpha255 == alphaRef255; }  // EQUAL
                        case 4u: { alphaTestPass = alpha255 <= alphaRef255; }  // LESSEQUAL
                        case 5u: { alphaTestPass = alpha255 > alphaRef255; }   // GREATER
                        case 6u: { alphaTestPass = alpha255 != alphaRef255; }  // NOTEQUAL
                        case 7u: { alphaTestPass = alpha255 >= alphaRef255; }  // GREATEREQUAL
                        case 8u: { alphaTestPass = true; }         // ALWAYS
                        default: { alphaTestPass = true; }         // Unknown = ALWAYS
                    }
                    if (!alphaTestPass) { discard; }
                }

                // Fog
                if (draw.fogParams.w > 0.0) {
                    finalColor = vec4f(mix(finalColor.rgb, draw.fogColor.rgb, in.fogFactor), finalColor.a);
                }

                ${!shouldEnableBlending ? `
                // When ALPHABLENDENABLE=0, D3D writes pixels without blending.
                // Force alpha=1.0 to prevent ARGB1555 alpha=0 from leaking into
                // intermediate render targets or causing compositing artifacts.
                finalColor = vec4f(finalColor.rgb, 1.0);
                ` : ''}

                return finalColor;
            }`;

    return `${drawUniformsStruct}
${bindings}
${generateShaderHelpers()}
${vertexOutput}
${vertexShader}
${fragmentShader}`;
}

/**
 * Generate clear pipeline shader code.
 * Depth value from uniform; fs_main returns vec4(1) so blend constant * 1 = clear color.
 * fs_main_depth_only has no color output — for depth/stencil-only partial clear (no color attachment).
 */
export function generateClearShaderCode(): string {
    return `
            struct ClearUniforms {
                depth: f32,
                _pad1: f32,
                _pad2: f32,
                _pad3: f32,
            }

            @group(0) @binding(0) var<uniform> uniforms: ClearUniforms;

            @vertex
            fn vs_main(@location(0) pos: vec2<f32>) -> @builtin(position) vec4<f32> {
                return vec4<f32>(pos, uniforms.depth, 1.0);
            }

            @fragment
            fn fs_main() -> @location(0) vec4<f32> {
                return vec4<f32>(1.0, 1.0, 1.0, 1.0);
            }

            @fragment
            fn fs_main_depth_only() {
            }
        `;
}

/**
 * Generate WGSL shader code for colorkey blit operation.
 * This shader renders a full-screen quad that samples from a source texture
 * and discards pixels that match the colorkey range.
 *
 * The quad fills the viewport, which is set to the destination rect.
 * UVs are interpolated to sample from the source rect.
 *
 * Uniform buffer layout (48 bytes):
 * - vec4f srcRect: UV coordinates (left, top, right, bottom) normalized 0-1
 * - vec4f colorKeyLow: (r, g, b, epsilon) - low bound and tolerance
 * - vec4f colorKeyHigh: (r, g, b, enableFlag) - high bound + enable flag
 */
export function generateColorKeyBlitShaderCode(): string {
    return `
        struct Uniforms {
            srcRect: vec4f,      // UV: left, top, right, bottom (0-1)
            colorKeyLow: vec4f,  // r, g, b, epsilon
            colorKeyHigh: vec4f, // r, g, b, enableFlag
        }

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;
        @group(0) @binding(1) var srcTexture: texture_2d<f32>;
        @group(0) @binding(2) var srcSampler: sampler;

        struct VertexOutput {
            @builtin(position) position: vec4f,
            @location(0) uv: vec2f,
        }

        @vertex
        fn vs_main(@location(0) pos: vec2f) -> VertexOutput {
            var out: VertexOutput;

            // Pass through position - viewport handles destination positioning
            out.position = vec4f(pos, 0.0, 1.0);

            // Map vertex position (-1 to 1) to normalized (0 to 1) for UV interpolation
            let t = (pos + 1.0) * 0.5;

            // Interpolate source UV from srcRect
            // NDC Y=-1 is at screen bottom, Y=+1 is at screen top
            // Texture V=0 is at top, V=1 is at bottom
            // So we flip: screen top (t.y=1) should sample from texture top (srcRect.y)
            let srcU = mix(uniforms.srcRect.x, uniforms.srcRect.z, t.x);
            let srcV = mix(uniforms.srcRect.w, uniforms.srcRect.y, t.y); // Flipped: w->y as t.y goes 0->1
            out.uv = vec2f(srcU, srcV);

            return out;
        }

        @fragment
        fn fs_main(in: VertexOutput) -> @location(0) vec4f {
            let texColor = textureSample(srcTexture, srcSampler, in.uv);

            // Extract colorkey bounds and epsilon
            let ckLow = uniforms.colorKeyLow.rgb;
            let ckHigh = uniforms.colorKeyHigh.rgb;
            let eps = uniforms.colorKeyLow.w;
            let ckEnabled = uniforms.colorKeyHigh.w;

            if (ckEnabled > 0.5) {
                // Check if pixel color is within colorkey range (inclusive, with epsilon tolerance)
                let inRange = all(texColor.rgb >= ckLow - eps) && all(texColor.rgb <= ckHigh + eps);

                if (inRange) {
                    discard;
                }
            }

            return texColor;
        }
    `;
}

/**
 * Shader generator class for creating and caching shader modules
 */
export class ShaderGenerator {
    private device: GPUDevice;

    // Cache of shader modules by shader code hash
    private shaderCache = new Map<string, GPUShaderModule>();

    // Separate cache for MegaBatch shaders
    private megaBatchShaderCache = new Map<string, GPUShaderModule>();

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /**
     * Get or create a shader module for the given configuration
     */
    getOrCreateShader(config: ShaderConfig): GPUShaderModule {
        const code = generateShaderCode(config);

        // Use code as cache key (could use hash for better performance)
        let shader = this.shaderCache.get(code);
        if (shader) return shader;

        shader = this.device.createShaderModule({ code });
        this.shaderCache.set(code, shader);
        return shader;
    }

    /**
     * Get or create a MegaBatch shader module for the given configuration.
     * MegaBatch shaders use storage buffers for per-draw uniforms.
     */
    getOrCreateMegaBatchShader(config: ShaderConfig): GPUShaderModule {
        const code = generateMegaBatchShaderCode(config);

        let shader = this.megaBatchShaderCache.get(code);
        if (shader) return shader;

        shader = this.device.createShaderModule({ code });
        this.megaBatchShaderCache.set(code, shader);
        return shader;
    }

    /**
     * Create a clear shader module
     */
    createClearShader(): GPUShaderModule {
        const code = generateClearShaderCode();
        return this.device.createShaderModule({ code });
    }

    /**
     * Clear the shader cache
     */
    clearCache(): void {
        this.shaderCache.clear();
        this.megaBatchShaderCache.clear();
    }
}
