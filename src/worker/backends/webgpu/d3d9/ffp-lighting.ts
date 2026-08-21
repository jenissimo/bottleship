/**
 * Faithful D3D9 fixed-function (FFP) vertex lighting.
 *
 * Implements the documented Direct3D lighting model (ambient + diffuse + specular +
 * emissive, per-light directional / point / spot with range, distance attenuation,
 * spot-cone falloff, material colour sources and a global ambient). The math mirrors
 * wined3d's `shader_glsl_ffp_vertex_lighting` (non-legacy / D3D9 path) so behaviour
 * matches real hardware rather than an approximation.
 *
 * This module owns BOTH halves of the contract so they cannot drift:
 *   - the WGSL `Uniforms` struct + lighting function consumed by the FFP shader, and
 *   - `packFfpUniforms`, the JS writer that fills the matching uniform byte block.
 *
 * Lighting is computed in eye/view space: positions come from `worldView * pos`,
 * normals from `worldView * normal`, and lights are transformed world→view on the CPU
 * (see packFfpUniforms) using the same row-vector × row-major convention the shaders
 * use for the MVP. Up to FFP_MAX_LIGHTS enabled lights contribute.
 */

import { pixelCenterOffsetPx, writeMvpWithPixelCenter } from "../pixel-center";

// D3DLIGHTTYPE
export const D3DLIGHT_POINT = 1;
export const D3DLIGHT_SPOT = 2;
export const D3DLIGHT_DIRECTIONAL = 3;

// D3DMATERIALCOLORSOURCE
export const D3DMCS_MATERIAL = 0;
export const D3DMCS_COLOR1 = 1; // vertex diffuse
export const D3DMCS_COLOR2 = 2; // vertex specular

export const FFP_MAX_LIGHTS = 8;

// ── Uniform block layout (floats) ─────────────────────────────────────────────
// Header = 17 vec4 (68 floats); then array<FfpLight, 8>, each 7 vec4 (28 floats); then the
// tail block (world matrix + 6 user clip planes) appended AFTER the light array so the light
// offsets never shift. MUST stay byte-identical to FFP_UNIFORM_STRUCT_WGSL below.
const HEADER_FLOATS = 68;
const LIGHT_FLOATS = 28;
const OFF_LIGHTS = 68;         // array<FfpLight, 8>, 28 floats each
const TAIL_START = HEADER_FLOATS + LIGHT_FLOATS * FFP_MAX_LIGHTS; // 292
const OFF_WORLD = TAIL_START;      // mat4x4 — WORLD only (D3DTS_WORLD), for world-space clipping
const OFF_CLIP_PLANES = OFF_WORLD + 16; // 308: array<vec4, 6> = 24 floats (raw plane equations)
const CLIP_PLANE_COUNT = 6;
// Texture stage 0 ops/args + TEXTUREFACTOR (D3DTSS_* / D3DRS_TEXTUREFACTOR).
const OFF_TFACTOR = OFF_CLIP_PLANES + CLIP_PLANE_COUNT * 4; // 332: TEXTUREFACTOR rgba
/**
 * Texture blend stages. D3DCAPS9 advertises MaxTextureBlendStages = 8 (caps.ts ships a real
 * hardware dump), so the FFP must be able to honor 8 — same reasoning that pinned
 * MaxActiveLights to FFP_MAX_LIGHTS. Each stage is two vec4:
 *   a = colorOp, colorArg1, colorArg2, alphaOp
 *   b = alphaArg1, alphaArg2, texOpaqueAlpha, packedArg0
 * `packedArg0` carries D3DTSS_COLORARG0 | ALPHAARG0 << 8 | (RESULTARG == D3DTA_TEMP) << 16.
 * Three fields in one word because a D3DTA selector is 6 bits and a float32 holds an integer
 * of that width exactly — widening FfpStage to a third vec4 would move ffpStageOffset, which
 * callers index directly.
 * A shader is generated for only as many stages as the draw actually uses (D3D's cascade
 * stops at the first COLOROP=DISABLE), so the tail of this array is simply never read.
 */
export const FFP_MAX_STAGES = 8;
/** D3DTA_* argument selector: low 4 bits pick the register, the bits above are modifiers. */
export const D3DTA_SELECTMASK = 0xf;
export const D3DTA_TEMP = 5;
const STAGE_FLOATS = 8;
const OFF_STAGES = OFF_TFACTOR + 4;                        // 336
/** Float index of stage `s`'s first vec4 (a); its second vec4 (b) is +4. */
export const ffpStageOffset = (stage: number): number => OFF_STAGES + stage * STAGE_FLOATS;
// Fog: colour + (start, end, density, mode) — see ffp-fog.ts for the mode encoding.
const OFF_FOG_COLOR = OFF_STAGES + FFP_MAX_STAGES * STAGE_FLOATS; // 400
const OFF_FOG_PARAMS = OFF_FOG_COLOR + 4;                         // 404
// Normal matrix: the inverse-transpose of worldView (upper-left 3×3), so a non-uniform world
// scale rotates normals correctly instead of shearing them. Appended last for the same reason
// the tail block is: nothing before it (notably ffpStageOffset) may shift.
const OFF_NORMAL_MATRIX = OFF_FOG_PARAMS + 4;                     // 408
/**
 * Per-stage texture-coordinate generation: one vec4 holding the RAW D3DTSS_TEXCOORDINDEX and
 * D3DTSS_TEXTURETRANSFORMFLAGS. They live here rather than in FfpStage because FfpStage is the
 * fragment-side combiner and these are consumed by the vertex stage — and because widening
 * FfpStage would move ffpStageOffset, which callers index directly.
 */
const OFF_TEXGEN = OFF_NORMAL_MATRIX + 16;                        // 424
const TEXGEN_FLOATS = 4;
/**
 * D3DTS_TEXTURE0..7. One matrix per blend stage, unlike the DDraw backend's three: that cap is
 * a legacy uniform-slot budget, whereas this block is sized from FFP_MAX_STAGES, so no stage can
 * silently lose its transform. The cost is 512 bytes per FFP draw state.
 */
export const FFP_MAX_TEX_MATRICES = FFP_MAX_STAGES;
const OFF_TEX_MATRICES = OFF_TEXGEN + FFP_MAX_STAGES * TEXGEN_FLOATS; // 456
// Both totals are derived; ffp-lighting.test.ts pins them against the WGSL struct's own
// layout, which is the check a written-down number here would only pretend to be.
export const FFP_UNIFORM_FLOATS = OFF_TEX_MATRICES + FFP_MAX_TEX_MATRICES * 16;

/** Float index of stage `s`'s texgen vec4 (rawTexCoordIndex, textureTransformFlags, 0, 0). */
export const ffpTexGenOffset = (stage: number): number => OFF_TEXGEN + stage * TEXGEN_FLOATS;
/** Float index of stage `s`'s 4×4 texture matrix. */
export const ffpTexMatrixOffset = (stage: number): number => OFF_TEX_MATRICES + stage * 16;
export const FFP_UNIFORM_BYTES = FFP_UNIFORM_FLOATS * 4;

const OFF_VIEWPORT = 0;        // vec4: w, h, pixelCentreOffsetPx, 0
const OFF_MVP = 4;             // mat4x4
const OFF_WORLDVIEW = 20;      // mat4x4
const OFF_MAT_DIFFUSE = 36;    // vec4
const OFF_MAT_AMBIENT = 40;    // vec4
const OFF_MAT_SPECULAR = 44;   // vec4
const OFF_MAT_EMISSIVE = 48;   // vec4
const OFF_GLOBAL_AMBIENT = 52; // vec4
const OFF_CTRL0 = 56;          // power, lightingEnabled, specularEnable, localViewer
const OFF_CTRL1 = 60;          // diffuseSrc, ambientSrc, specularSrc, emissiveSrc
const OFF_CTRL2 = 64;          // numLights, hasNormal, clipPlaneEnable, normalizeNormals

// Per-light float offsets within a 28-float slot.
const L_DIFFUSE = 0;    // vec4
const L_SPECULAR = 4;   // vec4
const L_AMBIENT = 8;    // vec4
const L_POSITION = 12;  // vec4: xyz view-space pos, w = range
const L_DIRECTION = 16; // vec4: xyz dir (see below), w = falloff
const L_ATTEN = 20;     // vec4: c_att, l_att, q_att, type
const L_SPOT = 24;      // vec4: cos(theta/2), cos(phi/2), 0, 0

export interface FfpColor { r: number; g: number; b: number; a: number; }

/** A zeroed colour record, for the pools the per-draw gather reuses. */
export function newFfpColor(): FfpColor { return { r: 0, g: 0, b: 0, a: 0 }; }

/** Read one float RGBA quad at `off` into `c` (D3D order: r,g,b,a, little-endian). */
export function readFfpColor(dv: DataView, off: number, c: FfpColor): void {
    c.r = dv.getFloat32(off, true);
    c.g = dv.getFloat32(off + 4, true);
    c.b = dv.getFloat32(off + 8, true);
    c.a = dv.getFloat32(off + 12, true);
}

/** Unpack a D3DCOLOR (0xAARRGGBB) into `c` as floats. */
export function unpackD3dColor(argb: number, c: FfpColor): FfpColor {
    c.r = ((argb >> 16) & 0xff) / 255;
    c.g = ((argb >> 8) & 0xff) / 255;
    c.b = (argb & 0xff) / 255;
    c.a = ((argb >>> 24) & 0xff) / 255;
    return c;
}

export interface FfpMaterial {
    diffuse: FfpColor;
    ambient: FfpColor;
    specular: FfpColor;
    emissive: FfpColor;
    power: number;
}

export interface FfpLightInput {
    type: number; // D3DLIGHT_*
    diffuse: FfpColor;
    specular: FfpColor;
    ambient: FfpColor;
    /** World-space position (point/spot). */
    position: [number, number, number];
    /** World-space direction the light travels (spot/directional). */
    direction: [number, number, number];
    range: number;
    falloff: number;
    att0: number;
    att1: number;
    att2: number;
    /** Spot inner / outer cone full angles, radians. */
    theta: number;
    phi: number;
}

export interface FfpUniformParams {
    viewportW: number;
    viewportH: number;
    /** world × view × projection (D3D row-major, as uploaded for the MVP). */
    mvp: Float32Array;
    /** world × view (D3D row-major). */
    worldView: Float32Array;
    /** Inverse-transpose of worldView's upper-left 3×3, widened to 4×4 (D3D row-major).
     *  Normals are transformed by this, not by worldView (DXVK D3D9FixedFunctionVS::NormalMatrix). */
    normalMatrix: Float32Array;
    /** view (D3D row-major) — used to transform lights world→view. */
    view: Float32Array;
    /** WORLD only (D3DTS_WORLD, D3D row-major) — used to evaluate FFP user clip planes in
     *  world space (DXVK d3d9_fixed_function_vert.vert emitVsClipping: worldPos = World·objPos). */
    world: Float32Array;
    /** Raw world-space user clip-plane equations, 6 × vec4 (24 floats). Slots for disabled
     *  planes are ignored by the shader (gated by clipPlaneEnable). Default all-zero. */
    clipPlanes: Float32Array;
    /** D3DRS_CLIPPLANEENABLE bitmask (bit N enables user clip plane N). 0 → clipping inert. */
    clipPlaneEnable: number;
    material: FfpMaterial;
    globalAmbient: FfpColor;
    lightingEnabled: boolean;
    specularEnable: boolean;
    localViewer: boolean;
    /** Effective material colour sources (already resolved for COLORVERTEX / present components). */
    diffuseSrc: number;
    ambientSrc: number;
    specularSrc: number;
    emissiveSrc: number;
    hasNormal: boolean;
    /** D3DRS_NORMALIZENORMALS. When false the transformed normal keeps its length, which
     *  scales the diffuse/specular term — games encode brightness that way. */
    normalizeNormals: boolean;
    /** Enabled lights, in ascending index order; only the first FFP_MAX_LIGHTS are used. */
    lights: FfpLightInput[];
    /** Texture stage 0 combiner (D3DTSS_COLOROP/COLORARG1/COLORARG2/ALPHAOP/ALPHAARG1/ALPHAARG2).
     *  The caller resolves the D3D stage-0 defaults. */
    /** Active texture blend stages, stage 0 first. Only these are written; the shader is
     *  generated for exactly this many stages, so the rest of the array is never read.
     *  `texCoordIndex` / `texTransformFlags` are the RAW D3DTSS_TEXCOORDINDEX and
     *  D3DTSS_TEXTURETRANSFORMFLAGS — the shader decodes the TCI_* generator and the
     *  D3DTTFF count/PROJECTED bits, so no CPU-side pre-resolution can lose information. */
    stages: Array<{
        colorOp: number; colorArg1: number; colorArg2: number;
        alphaOp: number; alphaArg1: number; alphaArg2: number;
        /** D3DTSS_COLORARG0 / D3DTSS_ALPHAARG0 — the third operand of MULTIPLYADD and LERP. */
        colorArg0: number; alphaArg0: number;
        /** D3DTSS_RESULTARG: D3DTA_CURRENT (default) or D3DTA_TEMP. */
        resultArg: number;
        texCoordIndex: number; texTransformFlags: number;
    }>;
    /** D3DTS_TEXTURE0..7 as one flat run of FFP_MAX_TEX_MATRICES × 16 floats (D3D row-major). */
    texMatrices: Float32Array;
    /** D3DRS_TEXTUREFACTOR, resolved to rgba. */
    tfactor: FfpColor;
    /** D3DRS_FOGCOLOR, resolved to rgb (alpha is never fogged). */
    fogColor: FfpColor;
    /** FOGSTART / FOGEND / FOGDENSITY as floats, plus the resolveFfpFogMode encoding. */
    fogStart: number;
    fogEnd: number;
    fogDensity: number;
    fogMode: number;
}

/** A params record with every field present, for the per-draw gather to overwrite in place.
 *  Every value here is replaced before packFfpUniforms sees it. */
export function makeFfpParams(): FfpUniformParams {
    const m = new Float32Array(16);
    return {
        viewportW: 0, viewportH: 0,
        mvp: m, worldView: m, normalMatrix: m, view: m, world: m,
        clipPlanes: new Float32Array(24), clipPlaneEnable: 0,
        material: { diffuse: newFfpColor(), ambient: newFfpColor(), specular: newFfpColor(), emissive: newFfpColor(), power: 0 },
        globalAmbient: newFfpColor(),
        lightingEnabled: false, specularEnable: false, localViewer: false,
        diffuseSrc: 0, ambientSrc: 0, specularSrc: 0, emissiveSrc: 0,
        hasNormal: false, normalizeNormals: false,
        lights: [], stages: [],
        texMatrices: new Float32Array(FFP_MAX_TEX_MATRICES * 16),
        tfactor: newFfpColor(), fogColor: newFfpColor(),
        fogStart: 0, fogEnd: 0, fogDensity: 0, fogMode: 0,
    };
}

/** Transform a world-space point by a D3D row-major matrix (row-vector × matrix). */
function transformPoint(out: [number, number, number], x: number, y: number, z: number, m: Float32Array): void {
    out[0] = x * m[0] + y * m[4] + z * m[8] + m[12];
    out[1] = x * m[1] + y * m[5] + z * m[9] + m[13];
    out[2] = x * m[2] + y * m[6] + z * m[10] + m[14];
}

/** Transform a world-space direction by a D3D row-major matrix (no translation). */
function transformDir(out: [number, number, number], x: number, y: number, z: number, m: Float32Array): void {
    out[0] = x * m[0] + y * m[4] + z * m[8];
    out[1] = x * m[1] + y * m[5] + z * m[9];
    out[2] = x * m[2] + y * m[6] + z * m[10];
}

function normalize3(v: [number, number, number]): void {
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len > 1e-8) { v[0] /= len; v[1] /= len; v[2] /= len; }
}

/**
 * Fill `out` (length ≥ FFP_UNIFORM_FLOATS) with the FFP uniform block for one draw/frame.
 * Lights are transformed world→view here so the shader works purely in eye space.
 */
export function packFfpUniforms(out: Float32Array, p: FfpUniformParams): void {
    out.fill(0, 0, FFP_UNIFORM_FLOATS);

    out[OFF_VIEWPORT] = p.viewportW;
    out[OFF_VIEWPORT + 1] = p.viewportH;
    // viewport.z carries the pixel-centre offset in PIXELS for the pre-transformed branch
    // of the FFP vertex shader; the transformed branch gets the same shift folded into the
    // matrix below. Both come from webgpu/pixel-center.ts — see it for the equivalence.
    out[OFF_VIEWPORT + 2] = pixelCenterOffsetPx();
    writeMvpWithPixelCenter(out, OFF_MVP, p.mvp, p.viewportW, p.viewportH);
    out.set(p.worldView.subarray(0, 16), OFF_WORLDVIEW);

    const m = p.material;
    writeColor(out, OFF_MAT_DIFFUSE, m.diffuse);
    writeColor(out, OFF_MAT_AMBIENT, m.ambient);
    writeColor(out, OFF_MAT_SPECULAR, m.specular);
    writeColor(out, OFF_MAT_EMISSIVE, m.emissive);
    writeColor(out, OFF_GLOBAL_AMBIENT, p.globalAmbient);

    out[OFF_CTRL0] = m.power;
    out[OFF_CTRL0 + 1] = p.lightingEnabled ? 1 : 0;
    out[OFF_CTRL0 + 2] = p.specularEnable ? 1 : 0;
    out[OFF_CTRL0 + 3] = p.localViewer ? 1 : 0;

    out[OFF_CTRL1] = p.diffuseSrc;
    out[OFF_CTRL1 + 1] = p.ambientSrc;
    out[OFF_CTRL1 + 2] = p.specularSrc;
    out[OFF_CTRL1 + 3] = p.emissiveSrc;

    const count = Math.min(p.lights.length, FFP_MAX_LIGHTS);
    out[OFF_CTRL2] = count;
    out[OFF_CTRL2 + 1] = p.hasNormal ? 1 : 0;
    // clipPlaneEnable rides ctrl2.z (a formerly-spare word) so no vec4 is added for it.
    out[OFF_CTRL2 + 2] = p.clipPlaneEnable >>> 0;
    out[OFF_CTRL2 + 3] = p.normalizeNormals ? 1 : 0;

    for (let i = 0; i < count; i++) {
        writeLightInto(out, OFF_LIGHTS + i * LIGHT_FLOATS, p.lights[i], p.view);
    }

    // Tail block: WORLD matrix + raw user clip planes. Written unconditionally (cheap); the
    // shader reads them only when clipPlaneEnable != 0, so an all-zero default stays inert.
    out.set(p.world.subarray(0, 16), OFF_WORLD);
    out.set(p.clipPlanes.subarray(0, CLIP_PLANE_COUNT * 4), OFF_CLIP_PLANES);

    writeColor(out, OFF_TFACTOR, p.tfactor);

    writeColor(out, OFF_FOG_COLOR, p.fogColor);
    out[OFF_FOG_PARAMS] = p.fogStart;
    out[OFF_FOG_PARAMS + 1] = p.fogEnd;
    out[OFF_FOG_PARAMS + 2] = p.fogDensity;
    out[OFF_FOG_PARAMS + 3] = p.fogMode;

    out.set(p.normalMatrix.subarray(0, 16), OFF_NORMAL_MATRIX);
    out.set(p.texMatrices.subarray(0, FFP_MAX_TEX_MATRICES * 16), OFF_TEX_MATRICES);

    // Texture blend stages (the .z of each b — the alpha-less-format flag — is set by the
    // per-draw writer, which is the only place that knows the bound texture's D3D format).
    const n = Math.min(p.stages.length, FFP_MAX_STAGES);
    for (let s = 0; s < n; s++) {
        const st = p.stages[s];
        const a = ffpStageOffset(s), b = a + 4;
        out[a] = st.colorOp;
        out[a + 1] = st.colorArg1;
        out[a + 2] = st.colorArg2;
        out[a + 3] = st.alphaOp;
        out[b] = st.alphaArg1;
        out[b + 1] = st.alphaArg2;
        // b.z (texOpaqueAlpha) is written by the per-draw writer, which is the only place that
        // knows the bound texture's D3D format.
        out[b + 3] = (st.colorArg0 & 0xff) | ((st.alphaArg0 & 0xff) << 8)
            | ((st.resultArg & D3DTA_SELECTMASK) === D3DTA_TEMP ? 1 << 16 : 0);
        const g = ffpTexGenOffset(s);
        out[g] = st.texCoordIndex;
        out[g + 1] = st.texTransformFlags;
    }
}

const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const _lightTmp: [number, number, number] = [0, 0, 0];

/**
 * Write one FfpLight (28 floats) at `base`, transforming its position/direction by `view`
 * (the world→view matrix; pass an identity matrix to keep the light in world space). The
 * directional light is stored as the normalized toward-light vector (−Direction); a spot
 * light keeps its travel-direction axis for the cone test.
 */
function writeLightInto(out: Float32Array, base: number, L: FfpLightInput, view: Float32Array): void {
    const tmp = _lightTmp;
    writeColor(out, base + L_DIFFUSE, L.diffuse);
    writeColor(out, base + L_SPECULAR, L.specular);
    writeColor(out, base + L_AMBIENT, L.ambient);

    transformPoint(tmp, L.position[0], L.position[1], L.position[2], view);
    out[base + L_POSITION] = tmp[0];
    out[base + L_POSITION + 1] = tmp[1];
    out[base + L_POSITION + 2] = tmp[2];
    out[base + L_POSITION + 3] = L.range;

    if (L.type === D3DLIGHT_DIRECTIONAL) {
        transformDir(tmp, -L.direction[0], -L.direction[1], -L.direction[2], view);
    } else {
        transformDir(tmp, L.direction[0], L.direction[1], L.direction[2], view);
    }
    normalize3(tmp);
    out[base + L_DIRECTION] = tmp[0];
    out[base + L_DIRECTION + 1] = tmp[1];
    out[base + L_DIRECTION + 2] = tmp[2];
    out[base + L_DIRECTION + 3] = L.falloff;

    out[base + L_ATTEN] = L.att0;
    out[base + L_ATTEN + 1] = L.att1;
    out[base + L_ATTEN + 2] = L.att2;
    out[base + L_ATTEN + 3] = L.type;

    out[base + L_SPOT] = Math.cos(L.theta * 0.5);
    out[base + L_SPOT + 1] = Math.cos(L.phi * 0.5);
}

// ── Shared light-set buffer (DDraw/D3D8 MegaBatch + non-batch path) ──────────────
// The lights are device-global state; the DDraw backend keeps per-draw material/world in
// its uniform slot and binds this separate light-set buffer once. Layout: count (vec4<f32>,
// x = numLights) then array<FfpLight, FFP_MAX_LIGHTS>. Lights are transformed by `view`
// (world→view) so they share the shader's view-space lighting frame; pass identity (the
// default) to keep them in world space.
export const FFP_LIGHTSET_FLOATS = 4 + LIGHT_FLOATS * FFP_MAX_LIGHTS; // 228
export const FFP_LIGHTSET_BYTES = FFP_LIGHTSET_FLOATS * 4; // 912

export function packFfpLightSet(out: Float32Array, lights: FfpLightInput[], view: Float32Array = IDENTITY4): void {
    out.fill(0, 0, FFP_LIGHTSET_FLOATS);
    const count = Math.min(lights.length, FFP_MAX_LIGHTS);
    out[0] = count;
    for (let i = 0; i < count; i++) {
        writeLightInto(out, 4 + i * LIGHT_FLOATS, lights[i], view);
    }
}

function writeColor(out: Float32Array, off: number, c: FfpColor): void {
    out[off] = c.r;
    out[off + 1] = c.g;
    out[off + 2] = c.b;
    out[off + 3] = c.a;
}

// ── WGSL ───────────────────────────────────────────────────────────────────────

/**
 * The per-light struct, shared verbatim by every FFP backend (D3D9 uniform, DDraw/D3D8
 * MegaBatch light-set). Keep this the single definition so the `packFfpUniforms` byte
 * layout and `emitFfpComputeLighting` access pattern stay in lockstep.
 */
export const FFP_LIGHT_STRUCT_WGSL = `
struct FfpLight {
    diffuse: vec4<f32>,
    specular: vec4<f32>,
    ambient: vec4<f32>,
    position: vec4<f32>,   // xyz = view-space position, w = range
    direction: vec4<f32>,  // xyz = view-space dir (toward-light for directional, spot axis for spot), w = falloff
    atten: vec4<f32>,      // c_att, l_att, q_att, type
    spot: vec4<f32>,       // cos(theta/2), cos(phi/2), 0, 0
}`;

/** The D3D9 per-frame FFP uniform struct (consumed by packFfpUniforms). Includes FfpLight. */
export const FFP_UNIFORM_STRUCT_WGSL = `
${FFP_LIGHT_STRUCT_WGSL}

struct FfpStage {
    a: vec4<f32>,      // colorOp, colorArg1, colorArg2, alphaOp
    b: vec4<f32>,      // alphaArg1, alphaArg2, texOpaqueAlpha, colorArg0 | alphaArg0<<8 | resultIsTemp<<16
}

struct Uniforms {
    // x,y = viewport width/height; z = pixel-centre offset in pixels (see pixel-center.ts).
    viewport: vec4<f32>,
    mvp: mat4x4<f32>,
    worldView: mat4x4<f32>,
    matDiffuse: vec4<f32>,
    matAmbient: vec4<f32>,
    matSpecular: vec4<f32>,
    matEmissive: vec4<f32>,
    globalAmbient: vec4<f32>,
    ctrl0: vec4<f32>,      // power, lightingEnabled, specularEnable, localViewer
    ctrl1: vec4<f32>,      // diffuseSrc, ambientSrc, specularSrc, emissiveSrc
    ctrl2: vec4<f32>,      // numLights, hasNormal, clipPlaneEnable, normalizeNormals
    lights: array<FfpLight, ${FFP_MAX_LIGHTS}>,
    // Tail block (appended after the light array so light offsets never shift):
    world: mat4x4<f32>,                 // WORLD only — FFP clip planes evaluate in world space
    clipPlanes: array<vec4<f32>, ${CLIP_PLANE_COUNT}>, // raw world-space plane equations
    tfactor: vec4<f32>,    // D3DRS_TEXTUREFACTOR rgba
    stages: array<FfpStage, ${FFP_MAX_STAGES}>,
    fogColor: vec4<f32>,   // D3DRS_FOGCOLOR rgb
    fogParams: vec4<f32>,  // start, end, density, mode (ffp-fog.ts encoding)
    normalMatrix: mat4x4<f32>, // inverse-transpose of worldView (3×3 part), for normals
    texGen: array<vec4<f32>, ${FFP_MAX_STAGES}>,          // raw TEXCOORDINDEX, raw TEXTURETRANSFORMFLAGS
    texMatrices: array<mat4x4<f32>, ${FFP_MAX_TEX_MATRICES}>, // D3DTS_TEXTURE0..7
}
`;

/**
 * Fixed-function texture-coordinate generation + transform, evaluated in the vertex stage.
 *
 * `ffpTexCoordSrc` picks a stage's PRE-matrix coordinate from the raw D3DTSS_TEXCOORDINDEX:
 * the high 16 bits are a D3DTSS_TCI_* generator, the low 16 pick a vertex UV set otherwise.
 *   0 PASSTHRU               → vertex UV as (u, v, 1, 0)
 *   1 CAMERASPACENORMAL      → view-space normal,             (x, y, z, 1)
 *   2 CAMERASPACEPOSITION    → view-space position,           (x, y, z, 1)
 *   3 CAMERASPACEREFLECTION  → view-space eye-reflection,     (x, y, z, 1)
 *   4 SPHEREMAP              → sphere-map UV already in [0,1] range
 * A generated 3-vector pads w with 1 so the matrix's translation row applies (env-map bias);
 * passthrough keeps the (u, v, 1, 0) convention, which is what makes a 2D texture matrix's
 * third row behave as the translation D3D documents.
 *
 * `ffpTexTransform` applies D3DTSS_TEXTURETRANSFORMFLAGS + the stage's D3DTS_TEXTURE matrix.
 * The transform runs only for D3DTTFF_COUNT2..COUNT4 — DISABLE and COUNT1 leave the coordinate
 * alone (DXVK `applyTransform = flags > D3DTTFF_COUNT1 && flags <= D3DTTFF_COUNT4`). Our
 * mat4x4 uniforms hold the D3D row-major bytes read column-major by WGSL, so `m * v` is exactly
 * the row-vector product D3D specifies, same convention as `mvp`.
 *
 * D3DTTFF_PROJECTED divides by output component `count-1`. Our varyings are vec2, so the divide
 * happens per VERTEX here while real hardware interpolates the full coordinate and divides per
 * pixel — the same approximation the DDraw backend documents, exact only for affine cases.
 */
export const FFP_TEXGEN_WGSL = `
fn ffpTexCoordSrc(raw: u32, uv0: vec2<f32>, uv1: vec2<f32>,
                  ecPos: vec3<f32>, ecNormal: vec3<f32>) -> vec4<f32> {
    let mode = (raw >> 16u) & 0xffffu;
    if (mode == 1u) { return vec4<f32>(ecNormal, 1.0); }
    if (mode == 2u) { return vec4<f32>(ecPos, 1.0); }
    if (mode == 3u) { return vec4<f32>(reflect(normalize(ecPos), ecNormal), 1.0); }
    if (mode == 4u) {
        let r = reflect(normalize(ecPos), ecNormal);
        let m = length(r + vec3<f32>(0.0, 0.0, 1.0)) * 2.0;
        return vec4<f32>(r.x / m + 0.5, r.y / m + 0.5, 0.0, 1.0);
    }
    // Only UV sets 0 and 1 are carried as vertex attributes; a stage naming any other set
    // falls back to set 0. Real D3D hands a stage an absent set as zeros; which of the two
    // this shader does is decided by what the caller passes as uv1.
    return vec4<f32>(select(uv0, uv1, (raw & 0xffffu) == 1u), 1.0, 0.0);
}

fn ffpTexTransform(src: vec4<f32>, m: mat4x4<f32>, flags: u32) -> vec2<f32> {
    let count = flags & 0x7u;
    if (count < 2u || count > 4u) { return src.xy; }
    let v = m * src;
    if ((flags & 256u) != 0u) {
        let p = v[count - 1u];
        if (abs(p) > 1e-6) { return v.xy / p; }
    }
    return v.xy;
}`;

/**
 * The DDraw/D3D8 shared light-set uniform struct (matches packFfpLightSet). Includes FfpLight.
 * Bind as e.g. `ffpLightSet`; pass "ffpLightSet.lights" to emitFfpComputeLighting.
 */
export const FFP_LIGHTSET_STRUCT_WGSL = `
${FFP_LIGHT_STRUCT_WGSL}

struct FfpLightSet {
    count: vec4<f32>,   // x = numLights
    lights: array<FfpLight, ${FFP_MAX_LIGHTS}>,
}
`;

/** Shared colour-source selector (MATERIAL / COLOR1 / COLOR2). */
export const FFP_SELECT_COLOR_WGSL = `
fn ffpSelectColor(src: f32, matCol: vec4<f32>, vDiff: vec4<f32>, vSpec: vec4<f32>) -> vec4<f32> {
    if (src == 1.0) { return vDiff; }
    if (src == 2.0) { return vSpec; }
    return matCol;
}`;

/**
 * Emit the shared `ffpComputeLighting` WGSL — the single home of the D3D FFP lighting math
 * (ambient + diffuse + specular + emissive over up to FFP_MAX_LIGHTS dir/point/spot lights).
 * Every input except the light array is passed as a parameter, so different backends can keep
 * their own bindings; only the light-array access differs and is templated via `lightsExpr`
 * (e.g. "u.lights" for the D3D9 uniform, "ffpLightSet.lights" for the DDraw MegaBatch light-set).
 *
 * Returns out[0] = lit diffuse rgba, out[1].xyz = specular rgb. Inputs must all be in one space
 * (the backend computes positions/normals and supplies lights pre-transformed into that space —
 * view space in both current callers, so the non-local-viewer direction is (0,0,-1) and the eye
 * is the origin). Depends on ffpSelectColor (FFP_SELECT_COLOR_WGSL) and FfpLight being in scope.
 */
export function emitFfpComputeLighting(lightsExpr: string): string {
    return `
const FFP_FLOAT_MAX: f32 = 3.4028234e38;

fn ffpComputeLighting(
    ecPos: vec3<f32>, ecNormalIn: vec3<f32>,
    matDiffuse: vec4<f32>, matAmbient: vec4<f32>, matSpecular: vec4<f32>, matEmissive: vec4<f32>,
    power: f32, specEnable: bool, localViewer: bool, hasNormal: bool,
    normalizeNormals: bool,
    diffuseSrc: f32, ambientSrc: f32, specularSrc: f32, emissiveSrc: f32,
    globalAmbient: vec3<f32>, numLights: i32,
    vDiffuse: vec4<f32>, vSpecular: vec4<f32>
) -> array<vec4<f32>, 2> {
    let matDif = ffpSelectColor(diffuseSrc, matDiffuse, vDiffuse, vSpecular);
    let matAmb = ffpSelectColor(ambientSrc, matAmbient, vDiffuse, vSpecular);
    let matSpc = ffpSelectColor(specularSrc, matSpecular, vDiffuse, vSpecular);
    let matEms = ffpSelectColor(emissiveSrc, matEmissive, vDiffuse, vSpecular);

    // D3DRS_NORMALIZENORMALS off means the normal keeps whatever length the world/view
    // transform gave it, and the saturated N·L then scales with it. A zero normal is left
    // alone rather than normalized into NaN.
    var n = ecNormalIn;
    if (normalizeNormals && any(n != vec3<f32>(0.0))) {
        n = normalize(n);
    }

    var ambient = globalAmbient;
    var diffuse = vec3<f32>(0.0);
    var specular = vec3<f32>(0.0);

    for (var i = 0; i < numLights; i = i + 1) {
        let L = ${lightsExpr}[i];
        let ltype = L.atten.w;
        var dir: vec3<f32>;
        var att = 1.0;
        if (ltype == 3.0) {
            // Directional: direction.xyz is the normalized toward-light vector.
            dir = L.direction.xyz;
            ambient = ambient + L.ambient.xyz;
        } else {
            // Point / spot.
            let toLight = L.position.xyz - ecPos;
            let d = length(toLight);
            if (d > L.position.w) { continue; }
            dir = toLight / max(d, 1e-6);
            // 1 / (att0 + att1·d + att2·d²). An all-zero attenuation is a legal D3DLIGHT9 and
            // means "no falloff": the reciprocal is +inf on hardware, so take the finite max and
            // let the saturating multiply below land on full brightness instead of NaN.
            let denom = L.atten.x + L.atten.y * d + L.atten.z * d * d;
            att = FFP_FLOAT_MAX;
            if (denom != 0.0) { att = min(1.0 / denom, FFP_FLOAT_MAX); }
            if (ltype == 2.0) {
                // Spot cone: full inside cos(theta/2), zero outside cos(phi/2), (rho-cosPhi)/
                // (cosTheta-cosPhi) raised to Falloff between them. Clamping the ratio before
                // pow() keeps the base non-negative (pow of a negative base is undefined) and
                // is what makes a degenerate theta == phi a hard-edged cone rather than a NaN.
                let rho = dot(-dir, L.direction.xyz);
                let cosHTheta = L.spot.x;
                let cosHPhi = L.spot.y;
                var spot = 1.0;
                if (rho <= cosHPhi) {
                    spot = 0.0;
                } else if (rho <= cosHTheta) {
                    let width = cosHTheta - cosHPhi;
                    let t = select(1.0, clamp((rho - cosHPhi) / width, 0.0, 1.0), width > 0.0);
                    spot = pow(t, L.direction.w);
                }
                att = att * spot;
            }
            ambient = ambient + L.ambient.xyz * att;
        }

        if (hasNormal) {
            let ndotl = clamp(dot(dir, n), 0.0, 1.0);
            diffuse = diffuse + ndotl * L.diffuse.xyz * att;
            // No power > 0 guard: D3DMATERIAL9.Power == 0 is legal and means pow(x, 0) == 1,
            // i.e. a flat specular term over the whole lit hemisphere.
            if (specEnable) {
                var halfDir: vec3<f32>;
                if (localViewer) {
                    halfDir = normalize(dir - normalize(ecPos));
                } else {
                    halfDir = normalize(dir + vec3<f32>(0.0, 0.0, -1.0));
                }
                // Saturated before pow(): with NORMALIZENORMALS off the normal may be longer
                // than unit, and an unclamped base raised to a large Power runs away.
                let t = clamp(dot(n, halfDir), 0.0, 1.0);
                if (ndotl > 0.0 && t > 0.0) {
                    specular = specular + pow(t, power) * L.specular.xyz * att;
                }
            }
        }
    }

    var out: array<vec4<f32>, 2>;
    let litRgb = matAmb.xyz * ambient + matDif.xyz * diffuse + matEms.xyz;
    out[0] = vec4<f32>(clamp(litRgb, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(matDif.w, 0.0, 1.0));
    out[1] = vec4<f32>(clamp(matSpc.xyz * specular, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);
    return out;
}`;
}
