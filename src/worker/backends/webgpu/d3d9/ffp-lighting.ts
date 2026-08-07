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
 *   b = alphaArg1, alphaArg2, texOpaqueAlpha, coordSet
 * A shader is generated for only as many stages as the draw actually uses (D3D's cascade
 * stops at the first COLOROP=DISABLE), so the tail of this array is simply never read.
 */
export const FFP_MAX_STAGES = 8;
const STAGE_FLOATS = 8;
const OFF_STAGES = OFF_TFACTOR + 4;                        // 336
/** Float index of stage `s`'s first vec4 (a); its second vec4 (b) is +4. */
export const ffpStageOffset = (stage: number): number => OFF_STAGES + stage * STAGE_FLOATS;
export const FFP_UNIFORM_FLOATS = OFF_STAGES + FFP_MAX_STAGES * STAGE_FLOATS; // 400
export const FFP_UNIFORM_BYTES = FFP_UNIFORM_FLOATS * 4; // 1376

const OFF_VIEWPORT = 0;        // vec4: w, h, 0, 0
const OFF_MVP = 4;             // mat4x4
const OFF_WORLDVIEW = 20;      // mat4x4
const OFF_MAT_DIFFUSE = 36;    // vec4
const OFF_MAT_AMBIENT = 40;    // vec4
const OFF_MAT_SPECULAR = 44;   // vec4
const OFF_MAT_EMISSIVE = 48;   // vec4
const OFF_GLOBAL_AMBIENT = 52; // vec4
const OFF_CTRL0 = 56;          // power, lightingEnabled, specularEnable, localViewer
const OFF_CTRL1 = 60;          // diffuseSrc, ambientSrc, specularSrc, emissiveSrc
const OFF_CTRL2 = 64;          // numLights, hasNormal, clipPlaneEnable, 0

// Per-light float offsets within a 28-float slot.
const L_DIFFUSE = 0;    // vec4
const L_SPECULAR = 4;   // vec4
const L_AMBIENT = 8;    // vec4
const L_POSITION = 12;  // vec4: xyz view-space pos, w = range
const L_DIRECTION = 16; // vec4: xyz dir (see below), w = falloff
const L_ATTEN = 20;     // vec4: c_att, l_att, q_att, type
const L_SPOT = 24;      // vec4: cos(theta/2), cos(phi/2), 0, 0

export interface FfpColor { r: number; g: number; b: number; a: number; }

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
    /** Enabled lights, in ascending index order; only the first FFP_MAX_LIGHTS are used. */
    lights: FfpLightInput[];
    /** Texture stage 0 combiner (D3DTSS_COLOROP/COLORARG1/COLORARG2/ALPHAOP/ALPHAARG1/ALPHAARG2).
     *  The caller resolves the D3D stage-0 defaults. */
    /** Active texture blend stages, stage 0 first. Only these are written; the shader is
     *  generated for exactly this many stages, so the rest of the array is never read.
     *  `coordSet` is the D3DTSS_TEXCOORDINDEX set the stage samples. */
    stages: Array<{ colorOp: number; colorArg1: number; colorArg2: number; alphaOp: number; alphaArg1: number; alphaArg2: number; coordSet: number }>;
    /** D3DRS_TEXTUREFACTOR, resolved to rgba. */
    tfactor: FfpColor;
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
    out.set(p.mvp.subarray(0, 16), OFF_MVP);
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

    for (let i = 0; i < count; i++) {
        writeLightInto(out, OFF_LIGHTS + i * LIGHT_FLOATS, p.lights[i], p.view);
    }

    // Tail block: WORLD matrix + raw user clip planes. Written unconditionally (cheap); the
    // shader reads them only when clipPlaneEnable != 0, so an all-zero default stays inert.
    out.set(p.world.subarray(0, 16), OFF_WORLD);
    out.set(p.clipPlanes.subarray(0, CLIP_PLANE_COUNT * 4), OFF_CLIP_PLANES);

    writeColor(out, OFF_TFACTOR, p.tfactor);

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
        out[b + 3] = st.coordSet;
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
    b: vec4<f32>,      // alphaArg1, alphaArg2, texOpaqueAlpha, coordSet
}

struct Uniforms {
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
    ctrl2: vec4<f32>,      // numLights, hasNormal, clipPlaneEnable, 0
    lights: array<FfpLight, ${FFP_MAX_LIGHTS}>,
    // Tail block (appended after the light array so light offsets never shift):
    world: mat4x4<f32>,                 // WORLD only — FFP clip planes evaluate in world space
    clipPlanes: array<vec4<f32>, ${CLIP_PLANE_COUNT}>, // raw world-space plane equations
    tfactor: vec4<f32>,    // D3DRS_TEXTUREFACTOR rgba
    stages: array<FfpStage, ${FFP_MAX_STAGES}>,
}
`;

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
fn ffpComputeLighting(
    ecPos: vec3<f32>, ecNormalIn: vec3<f32>,
    matDiffuse: vec4<f32>, matAmbient: vec4<f32>, matSpecular: vec4<f32>, matEmissive: vec4<f32>,
    power: f32, specEnable: bool, localViewer: bool, hasNormal: bool,
    diffuseSrc: f32, ambientSrc: f32, specularSrc: f32, emissiveSrc: f32,
    globalAmbient: vec3<f32>, numLights: i32,
    vDiffuse: vec4<f32>, vSpecular: vec4<f32>
) -> array<vec4<f32>, 2> {
    let matDif = ffpSelectColor(diffuseSrc, matDiffuse, vDiffuse, vSpecular);
    let matAmb = ffpSelectColor(ambientSrc, matAmbient, vDiffuse, vSpecular);
    let matSpc = ffpSelectColor(specularSrc, matSpecular, vDiffuse, vSpecular);
    let matEms = ffpSelectColor(emissiveSrc, matEmissive, vDiffuse, vSpecular);

    let n = select(vec3<f32>(0.0, 0.0, 1.0), normalize(ecNormalIn), hasNormal);

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
            let denom = L.atten.x + L.atten.y * d + L.atten.z * d * d;
            att = 1.0 / max(denom, 1e-6);
            if (ltype == 2.0) {
                let rho = dot(-dir, L.direction.xyz);
                let cosHTheta = L.spot.x;
                let cosHPhi = L.spot.y;
                var spot: f32;
                if (rho > cosHTheta) {
                    spot = 1.0;
                } else if (rho <= cosHPhi) {
                    spot = 0.0;
                } else {
                    spot = pow((rho - cosHPhi) / max(cosHTheta - cosHPhi, 1e-6), L.direction.w);
                }
                att = att * spot;
            }
            ambient = ambient + L.ambient.xyz * att;
        }

        if (hasNormal) {
            let ndotl = clamp(dot(dir, n), 0.0, 1.0);
            diffuse = diffuse + ndotl * L.diffuse.xyz * att;
            if (specEnable && power > 0.0) {
                var halfDir: vec3<f32>;
                if (localViewer) {
                    halfDir = normalize(dir - normalize(ecPos));
                } else {
                    halfDir = normalize(dir + vec3<f32>(0.0, 0.0, -1.0));
                }
                let t = dot(n, halfDir);
                if (dot(dir, n) > 0.0 && t > 0.0) {
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
