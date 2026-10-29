/**
 * Fixed-function vertex processing expressed as vs_1_1 bytecode.
 *
 * D3D8 lets a draw pair a declaration-only vertex shader (fixed-function vertex
 * processing) with a programmable pixel shader. The programmable link needs a vertex
 * stage, so this module writes the one the fixed-function pipeline would run for the
 * current state — transform, vertex colours, vertex fog, and per-stage texture coordinate
 * processing (D3DTSS_TEXCOORDINDEX passthrough / D3DTSS_TCI_CAMERASPACE* generation,
 * then the D3DTS_TEXTUREn matrix per D3DTSS_TEXTURETRANSFORMFLAGS) — and the constant
 * bank that drives it. The program then links against the guest's pixel shader exactly
 * like a guest-supplied vs_1_1.
 *
 * Lighting, when requested, is emitted by the linker using the shared FFP equation.
 */
import { RegType, Op } from "../d3d9/shader/sm-enums";
import type { RawVertexElement } from "../d3d9/shader";
import { writeMvpWithPixelCenter } from "../pixel-center";
import { dwordToFloat } from "../ddraw/dword-float";

/** D3DVSDE_* input registers, which on a declaration-only shader carry FFP semantics. */
const VSDE_POSITION = 0;
const VSDE_NORMAL = 3;
const VSDE_DIFFUSE = 5;
const VSDE_SPECULAR = 6;
const VSDE_TEXCOORD0 = 7;

const TCI_PASSTHRU = 0;
const TCI_CAMERASPACENORMAL = 1;
const TCI_CAMERASPACEPOSITION = 2;

const TTFF_COUNT_MASK = 0xff;
export const TTFF_PROJECTED = 0x100;

const D3DTS_VIEW = 2;
const D3DTS_TEXTURE0 = 16;
const D3DTS_WORLD = 256;
const D3DRS_FOGSTART = 36;
const D3DRS_FOGEND = 37;
const D3DRS_FOGDENSITY = 38;

const D3DFOG_EXP = 1;
const D3DFOG_EXP2 = 2;
const D3DFOG_LINEAR = 3;

/** FfpVertexSpec.fog: no oFog — fog is off, or table fog evaluated per pixel from depth. */
export const FFP_FOG_OUT_NONE = 0;
/** FfpVertexSpec.fog: D3DRS_FOGVERTEXMODE NONE — the factor is the vertex's specular alpha. */
export const FFP_FOG_OUT_SPECULAR = 4;

/** D3DDECLTYPE component counts for the types a D3D8 declaration can produce. */
const DECLTYPE_COMPONENTS: Readonly<Record<number, number>> = {
    0: 1, 1: 2, 2: 3, 3: 4, // FLOAT1..FLOAT4
    4: 4,                   // D3DCOLOR
    5: 4,                   // UBYTE4
    6: 2, 7: 4,             // SHORT2, SHORT4
};

/** Constant bank layout: c0-3 MVP ROWS with the pixel centre folded in (the exact bits the
 *  fixed-function path uploads), c4 = (1, 0, 0, 0), c5 the vertex-fog coefficients, c6-8
 *  world×view columns, c9-11 the normal matrix (inverse-transpose of world×view) columns,
 *  c12+4n .. c15+4n the D3DTS_TEXTUREn columns. */
const C_MVP = 0;
const C_UNIT = 4;
const C_FOG = 5;
const C_WORLDVIEW = 6;
const C_NORMAL = 9;
const C_TEXMATRIX = 12;
/** The linker's fixedFunctionPosition slots for this bank (position input is v0). */
export const FFP_SYNTH_POSITION = { inputRegister: VSDE_POSITION, matrixSlot: C_MVP } as const;
export const FFP_SYNTH_MAX_TEXCOORDS = 8;
export const FFP_SYNTH_CONSTANT_COUNT = C_TEXMATRIX + FFP_SYNTH_MAX_TEXCOORDS * 4;
export const FFP_SYNTH_LIGHTING_SLOT = FFP_SYNTH_CONSTANT_COUNT;
export const FFP_SYNTH_LIGHTING = {
    constantSlot: FFP_SYNTH_LIGHTING_SLOT,
    worldViewSlot: C_WORLDVIEW,
    normalMatrixSlot: C_NORMAL,
    positionRegister: VSDE_POSITION,
    normalRegister: VSDE_NORMAL,
} as const;

export interface FfpTexcoordSpec {
    /** Output texcoord register n (= texture stage n). */
    output: number;
    /** D3DTSS_TCI_* mode (high word of D3DTSS_TEXCOORDINDEX). */
    mode: number;
    /** Vertex UV set (low word of D3DTSS_TEXCOORDINDEX). */
    set: number;
    /** D3DTSS_TEXTURETRANSFORMFLAGS. D3DTTFF_PROJECTED only when the pixel shader's `tex`
     *  honours it (ps_1_1-1_3) — the link then divides by .w. */
    transformFlags: number;
}

export interface FfpVertexSpec {
    lighting?: boolean;
    hasDiffuse: boolean;
    hasSpecular: boolean;
    /** Component count of each texcoord set present in the declaration (index = set). */
    texcoordComponents: (number | undefined)[];
    hasNormal: boolean;
    normalizeNormals: boolean;
    texcoords: FfpTexcoordSpec[];
    /** FFP_FOG_OUT_NONE, FFP_FOG_OUT_SPECULAR, or the D3DFOG_* vertex formula (ffpVertexFogOutput). */
    fog: number;
    /** D3DRS_RANGEFOGENABLE: the formula runs over eye distance instead of camera-space depth. */
    rangeFog: boolean;
}

/** What the declaration provides, keyed by D3DVSDE register. */
export function describeDeclInputs(decl: readonly RawVertexElement[]): {
    hasPosition: boolean; hasNormal: boolean; hasDiffuse: boolean; hasSpecular: boolean;
    texcoordComponents: (number | undefined)[];
} {
    const out = {
        hasPosition: false, hasNormal: false, hasDiffuse: false, hasSpecular: false,
        texcoordComponents: [] as (number | undefined)[],
    };
    for (const e of decl) {
        const reg = e.reg;
        if (reg === undefined) continue;
        if (reg === VSDE_POSITION) out.hasPosition = true;
        else if (reg === VSDE_NORMAL) out.hasNormal = true;
        else if (reg === VSDE_DIFFUSE) out.hasDiffuse = true;
        else if (reg === VSDE_SPECULAR) out.hasSpecular = true;
        else if (reg >= VSDE_TEXCOORD0 && reg < VSDE_TEXCOORD0 + 8) {
            out.texcoordComponents[reg - VSDE_TEXCOORD0] = DECLTYPE_COMPONENTS[e.type] ?? 4;
        }
    }
    return out;
}

/**
 * The fog value the fixed-function vertex stage owes the pixel stage. Table fog is evaluated
 * per pixel from depth and needs none; otherwise FOGVERTEXMODE's formula, or with it NONE the
 * specular alpha (ffp-fog.ts resolveFfpFogMode).
 */
export function ffpVertexFogOutput(fogEnable: number, fogTableMode: number, fogVertexMode: number): number {
    if (!fogEnable || fogTableMode !== 0) return FFP_FOG_OUT_NONE;
    return fogVertexMode >= D3DFOG_EXP && fogVertexMode <= D3DFOG_LINEAR ? fogVertexMode : FFP_FOG_OUT_SPECULAR;
}

/** Whether the fixed-function vertex stage for this spec can be expressed here. */
export function isFfpVertexSpecSupported(spec: FfpVertexSpec): boolean {
    for (const t of spec.texcoords) {
        if (t.output < 0 || t.output >= FFP_SYNTH_MAX_TEXCOORDS) return false;
        if (t.mode === TCI_CAMERASPACENORMAL && !spec.hasNormal) return false;
        if (t.mode !== TCI_PASSTHRU && t.mode !== TCI_CAMERASPACENORMAL
            && t.mode !== TCI_CAMERASPACEPOSITION) return false;
        const count = t.transformFlags & TTFF_COUNT_MASK;
        if (count > 4) return false;
    }
    return true;
}

/** Texture stages whose coordinate the link must divide by .w (ps_1_1-1_3 `tex`). */
export function ffpProjectedMask(spec: FfpVertexSpec): number {
    let mask = 0;
    for (const t of spec.texcoords) {
        if ((t.transformFlags & TTFF_PROJECTED) !== 0 && (t.transformFlags & TTFF_COUNT_MASK) !== 0) {
            mask |= 1 << t.output;
        }
    }
    return mask;
}

export function ffpVertexSpecKey(spec: FfpVertexSpec): string {
    const tc = spec.texcoords
        .map(t => `${t.output}.${t.mode}.${t.set}.${t.transformFlags}`)
        .join(",");
    const comps = spec.texcoordComponents.map(c => c ?? "-").join("");
    return `l${+!!spec.lighting}d${+spec.hasDiffuse}s${+spec.hasSpecular}n${+spec.hasNormal}${+spec.normalizeNormals}`
        + `f${spec.fog}${+spec.rangeFog}c${comps}t${tc}`;
}

// ── vs_1_1 token encoding ────────────────────────────────────────────────────

const SWZ_XYZW = 0xe4;
const SWZ_XXXX = 0x00;
const SWZ_YYYY = 0x55;
const SWZ_ZZZZ = 0xaa;
const SWZ_WWWW = 0xff;
const SRCMOD_NEG = 1 << 24;

function reg(type: number, num: number): number {
    return (0x80000000 | ((type & 0x7) << 28) | (((type >>> 3) & 0x3) << 11) | (num & 0x7ff)) >>> 0;
}
function dst(type: number, num: number, mask = 0xf): number {
    return (reg(type, num) | (mask << 16)) >>> 0;
}
function src(type: number, num: number, swizzle = SWZ_XYZW): number {
    return (reg(type, num) | (swizzle << 16)) >>> 0;
}

const MASK_X = 0x1, MASK_Y = 0x2, MASK_Z = 0x4, MASK_W = 0x8;
const COMPONENT_MASKS = [MASK_X, MASK_Y, MASK_Z, MASK_W] as const;

const R_CAMPOS = 0;
const R_CAMNORMAL = 1;
const R_SCRATCH = 2;
const R_SOURCE = 3;
const RASTOUT_FOG = 1;

/**
 * Assemble the fixed-function vertex stage for `spec`. Output registers follow D3D's
 * fixed-function results: oPos, oD0 (diffuse or opaque white), oD1 (specular or zero),
 * oFog when vertex fog is on, and oTn for every requested texcoord.
 */
export function synthesizeFfpVertexShader(spec: FfpVertexSpec): Uint32Array {
    const t: number[] = [0xfffe0101];
    const emit = (op: number, ...params: number[]): void => { t.push(op, ...params); };
    const unit = (swz: number): number => src(RegType.CONST, C_UNIT, swz);
    const scratchX = dst(RegType.TEMP, R_SCRATCH, MASK_X);
    const scratch = (swz: number): number => src(RegType.TEMP, R_SCRATCH, swz);
    const fogC = (swz: number): number => src(RegType.CONST, C_FOG, swz);

    // v × M over the row bank. The link replaces this oPos with d3dTransformPosition on the
    // same rows (FFP_SYNTH_POSITION); computing it here keeps the program complete and keeps
    // c0-c4 inside the bank the linker sizes from the instructions.
    const position = (swz: number): number => src(RegType.INPUT, VSDE_POSITION, swz);
    emit(Op.MUL, dst(RegType.TEMP, R_SCRATCH), position(SWZ_XXXX), src(RegType.CONST, C_MVP));
    emit(Op.MAD, dst(RegType.TEMP, R_SCRATCH), position(SWZ_YYYY), src(RegType.CONST, C_MVP + 1), scratch(SWZ_XYZW));
    emit(Op.MAD, dst(RegType.TEMP, R_SCRATCH), position(SWZ_ZZZZ), src(RegType.CONST, C_MVP + 2), scratch(SWZ_XYZW));
    emit(Op.ADD, dst(RegType.TEMP, R_SCRATCH), scratch(SWZ_XYZW), src(RegType.CONST, C_MVP + 3));
    emit(Op.MUL, dst(RegType.RASTOUT, 0), scratch(SWZ_XYZW), unit(SWZ_XXXX));
    emit(Op.MOV, dst(RegType.ATTROUT, 0),
        spec.hasDiffuse ? src(RegType.INPUT, VSDE_DIFFUSE) : unit(SWZ_XXXX));
    emit(Op.MOV, dst(RegType.ATTROUT, 1),
        spec.hasSpecular ? src(RegType.INPUT, VSDE_SPECULAR) : unit(SWZ_YYYY));

    const fogFormula = spec.fog >= D3DFOG_EXP && spec.fog <= D3DFOG_LINEAR;
    const needsCamPos = fogFormula || spec.texcoords.some(x => x.mode === TCI_CAMERASPACEPOSITION);
    const needsCamNormal = spec.texcoords.some(x => x.mode === TCI_CAMERASPACENORMAL);
    if (needsCamPos) {
        for (let i = 0; i < 3; i++) {
            emit(Op.DP4, dst(RegType.TEMP, R_CAMPOS, COMPONENT_MASKS[i]),
                src(RegType.INPUT, VSDE_POSITION), src(RegType.CONST, C_WORLDVIEW + i));
        }
        emit(Op.MOV, dst(RegType.TEMP, R_CAMPOS, MASK_W), unit(SWZ_XXXX));
    }
    if (needsCamNormal) {
        for (let i = 0; i < 3; i++) {
            emit(Op.DP3, dst(RegType.TEMP, R_CAMNORMAL, COMPONENT_MASKS[i]),
                src(RegType.INPUT, VSDE_NORMAL), src(RegType.CONST, C_NORMAL + i));
        }
        if (spec.normalizeNormals) {
            emit(Op.DP3, scratchX, src(RegType.TEMP, R_CAMNORMAL), src(RegType.TEMP, R_CAMNORMAL));
            emit(Op.RSQ, scratchX, scratch(SWZ_XXXX));
            emit(Op.MUL, dst(RegType.TEMP, R_CAMNORMAL, MASK_X | MASK_Y | MASK_Z),
                src(RegType.TEMP, R_CAMNORMAL), scratch(SWZ_XXXX));
        }
        emit(Op.MOV, dst(RegType.TEMP, R_CAMNORMAL, MASK_W), unit(SWZ_XXXX));
    }

    const oFog = dst(RegType.RASTOUT, RASTOUT_FOG, MASK_X);
    if (spec.fog === FFP_FOG_OUT_SPECULAR) {
        // No specular in the vertex leaves the pixel unfogged (factor 1).
        emit(Op.MOV, oFog, spec.hasSpecular ? src(RegType.INPUT, VSDE_SPECULAR, SWZ_WWWW) : unit(SWZ_XXXX));
    } else if (fogFormula) {
        if (spec.rangeFog) {
            emit(Op.DP3, scratchX, src(RegType.TEMP, R_CAMPOS), src(RegType.TEMP, R_CAMPOS));
            emit(Op.RSQ, scratchX, scratch(SWZ_XXXX));
            emit(Op.RCP, scratchX, scratch(SWZ_XXXX));
        } else {
            emit(Op.MAX, scratchX, src(RegType.TEMP, R_CAMPOS, SWZ_ZZZZ),
                (src(RegType.TEMP, R_CAMPOS, SWZ_ZZZZ) | SRCMOD_NEG) >>> 0);
        }
        if (spec.fog === D3DFOG_LINEAR) {
            // (end - d) / (end - start); oFog saturates.
            emit(Op.MAD, oFog, scratch(SWZ_XXXX), fogC(SWZ_YYYY), fogC(SWZ_XXXX));
        } else {
            // e^-x = 2^(-x·log2 e), x = density·d (EXP) or (density·d)² (EXP2).
            emit(Op.MUL, scratchX, scratch(SWZ_XXXX), fogC(SWZ_ZZZZ));
            if (spec.fog === D3DFOG_EXP2) emit(Op.MUL, scratchX, scratch(SWZ_XXXX), scratch(SWZ_XXXX));
            emit(Op.MUL, scratchX, scratch(SWZ_XXXX), fogC(SWZ_WWWW));
            emit(Op.EXP, oFog, scratch(SWZ_XXXX));
        }
    }

    for (const tc of spec.texcoords) {
        const out = dst(RegType.TEXCRDOUT, tc.output);
        const count = tc.transformFlags & TTFF_COUNT_MASK;
        let source: number;
        if (tc.mode === TCI_CAMERASPACEPOSITION) {
            source = src(RegType.TEMP, R_CAMPOS);
        } else if (tc.mode === TCI_CAMERASPACENORMAL) {
            source = src(RegType.TEMP, R_CAMNORMAL);
        } else {
            const components = spec.texcoordComponents[tc.set];
            if (components === undefined) {
                // A stage reading a set the declaration does not supply sees zeros.
                emit(Op.MOV, out, unit(SWZ_YYYY));
                continue;
            }
            source = src(RegType.INPUT, VSDE_TEXCOORD0 + tc.set);
            if (count !== 0 && components < 4) {
                // A texture matrix sees an n-component coordinate padded with a 1 right
                // after its last component and zeros beyond it, so a 2D coordinate's
                // translation lives in the matrix's third row.
                emit(Op.MOV, dst(RegType.TEMP, R_SOURCE), source);
                for (let c = components; c < 4; c++) {
                    emit(Op.MOV, dst(RegType.TEMP, R_SOURCE, COMPONENT_MASKS[c]),
                        unit(c === components ? SWZ_XXXX : SWZ_YYYY));
                }
                source = src(RegType.TEMP, R_SOURCE);
            }
        }
        if (count === 0) {
            emit(Op.MOV, out, source);
            continue;
        }
        const matrix = C_TEXMATRIX + tc.output * 4;
        const projected = (tc.transformFlags & TTFF_PROJECTED) !== 0;
        for (let i = 0; i < 4; i++) {
            // The link's projective fetch (ffpProjectedMask) divides by .w; D3D divides by
            // the last counted component, so that column feeds .w.
            const column = projected && i === 3 ? count - 1 : i;
            emit(Op.DP4, dst(RegType.TEXCRDOUT, tc.output, COMPONENT_MASKS[i]),
                source, src(RegType.CONST, matrix + column));
        }
    }
    t.push(Op.END);
    return Uint32Array.from(t, v => v >>> 0);
}

/** Write `count` columns of a row-major D3D matrix into consecutive vec4 constants. */
function writeColumns(out: Float32Array, register: number, m: ArrayLike<number> | null, count = 4): void {
    for (let col = 0; col < count; col++) {
        for (let row = 0; row < 4; row++) {
            out[(register + col) * 4 + row] = m ? m[row * 4 + col]! : (row === col ? 1 : 0);
        }
    }
}

/** The state writeFfpVertexConstants reads (D3D8DeviceAdapter). */
export interface FfpVertexStateSource {
    readonly renderStates: ArrayLike<number>;
    getMVP(): Float32Array | null;
    getTransform(type: number): Float32Array | null;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const worldViewScratch = new Float32Array(16);

/** World × View into `out` (row-major), or null when neither is set (identity). */
function worldViewInto(out: Float32Array, world: Float32Array | null, view: Float32Array | null): Float32Array | null {
    if (!world && !view) return null;
    const a = world ?? IDENTITY;
    const b = view ?? IDENTITY;
    for (let r = 0; r < 4; r++) {
        const a0 = a[r * 4]!, a1 = a[r * 4 + 1]!, a2 = a[r * 4 + 2]!, a3 = a[r * 4 + 3]!;
        for (let c = 0; c < 4; c++) {
            out[r * 4 + c] = a0 * b[c]! + a1 * b[4 + c]! + a2 * b[8 + c]! + a3 * b[12 + c]!;
        }
    }
    return out;
}

/**
 * The columns of the normal matrix — the inverse-transpose of world×view's 3×3, which is
 * what D3D transforms normals by (world×view itself is only right for rigid transforms).
 * A singular 3×3 has no inverse; it falls back to the 3×3 itself, as d3d9-device does.
 */
function writeNormalColumns(out: Float32Array, register: number, wv: Float32Array | null): void {
    const m = wv ?? IDENTITY;
    const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!;
    const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!;
    const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!;
    const c00 = a11 * a22 - a12 * a21;
    const c01 = a12 * a20 - a10 * a22;
    const c02 = a10 * a21 - a11 * a20;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    const base = register * 4;
    if (det === 0 || !Number.isFinite(det)) {
        // n' = n × A: column i of A.
        out[base + 0] = a00; out[base + 1] = a10; out[base + 2] = a20; out[base + 3] = 0;
        out[base + 4] = a01; out[base + 5] = a11; out[base + 6] = a21; out[base + 7] = 0;
        out[base + 8] = a02; out[base + 9] = a12; out[base + 10] = a22; out[base + 11] = 0;
        return;
    }
    // N = cofactor(A) / det = (A⁻¹)ᵀ; n' = n × N, so constant i holds column i of N.
    const inv = 1 / det;
    out[base + 0] = c00 * inv;
    out[base + 1] = (a02 * a21 - a01 * a22) * inv;
    out[base + 2] = (a01 * a12 - a02 * a11) * inv;
    out[base + 3] = 0;
    out[base + 4] = c01 * inv;
    out[base + 5] = (a00 * a22 - a02 * a20) * inv;
    out[base + 6] = (a02 * a10 - a00 * a12) * inv;
    out[base + 7] = 0;
    out[base + 8] = c02 * inv;
    out[base + 9] = (a01 * a20 - a00 * a21) * inv;
    out[base + 10] = (a00 * a11 - a01 * a10) * inv;
    out[base + 11] = 0;
}

/** Fill the constant bank `synthesizeFfpVertexShader` reads. The viewport extent is the
 *  sanitized one the draw rasterizes into (its pixel centre). Allocates nothing. */
export function writeFfpVertexConstants(
    out: Float32Array,
    state: FfpVertexStateSource,
    viewportWidth: number,
    viewportHeight: number,
): void {
    // The fixed-function uniform writer folds the pixel centre into a real MVP only and
    // uploads a missing one as plain identity; the bits must match it either way.
    const mvp = state.getMVP();
    if (mvp) writeMvpWithPixelCenter(out, C_MVP * 4, mvp, viewportWidth, viewportHeight);
    else out.set(IDENTITY, C_MVP * 4);
    out[C_UNIT * 4 + 0] = 1;
    out[C_UNIT * 4 + 1] = 0;
    out[C_UNIT * 4 + 2] = 0;
    out[C_UNIT * 4 + 3] = 0;

    // Same clamp as ffpFogFactor's LINEAR denominator.
    const rs = state.renderStates;
    const fogStart = dwordToFloat(rs[D3DRS_FOGSTART]! | 0);
    const fogEnd = dwordToFloat(rs[D3DRS_FOGEND]! | 0);
    const range = Math.max(fogEnd - fogStart, 0.0001);
    out[C_FOG * 4 + 0] = fogEnd / range;
    out[C_FOG * 4 + 1] = -1 / range;
    out[C_FOG * 4 + 2] = dwordToFloat(rs[D3DRS_FOGDENSITY]! | 0);
    out[C_FOG * 4 + 3] = -Math.LOG2E;

    const worldView = worldViewInto(worldViewScratch,
        state.getTransform(D3DTS_WORLD), state.getTransform(D3DTS_VIEW));
    writeColumns(out, C_WORLDVIEW, worldView, 3);
    writeNormalColumns(out, C_NORMAL, worldView);
    for (let stage = 0; stage < FFP_SYNTH_MAX_TEXCOORDS; stage++) {
        writeColumns(out, C_TEXMATRIX + stage * 4, state.getTransform(D3DTS_TEXTURE0 + stage));
    }
}
