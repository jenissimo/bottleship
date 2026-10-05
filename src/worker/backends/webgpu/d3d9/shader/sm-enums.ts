/**
 * sm-enums.ts — Direct3D 9 shader-model 1.x/2.x/3.x bytecode constants.
 *
 * Shared numeric tables for the DXSO (legacy D3D9 shader bytecode) token format,
 * used by the parser (sm-parser.ts) and the WGSL code generators.
 *
 * Reference: Microsoft d3d9types.h + DXVK's `dxso` module (commit 0d72ff05).
 * The single most important SM1.x detail: there is **no instruction-length
 * field** in the token — operand counts come from the fixed table below.
 */

// ── Opcodes (low 16 bits of an instruction token) ─────────────────────────────

export const enum Op {
    NOP = 0, MOV = 1, ADD = 2, SUB = 3, MAD = 4, MUL = 5, RCP = 6, RSQ = 7,
    DP3 = 8, DP4 = 9, MIN = 10, MAX = 11, SLT = 12, SGE = 13, EXP = 14, LOG = 15,
    LIT = 16, DST = 17, LRP = 18, FRC = 19,
    M4x4 = 20, M4x3 = 21, M3x4 = 22, M3x3 = 23, M3x2 = 24,
    CALL = 25, CALLNZ = 26, LOOP = 27, RET = 28, ENDLOOP = 29, LABEL = 30,
    DCL = 31, POW = 32, CRS = 33, SGN = 34, ABS = 35, NRM = 36, SINCOS = 37,
    REP = 38, ENDREP = 39, IF = 40, IFC = 41, ELSE = 42, ENDIF = 43,
    BREAK = 44, BREAKC = 45, MOVA = 46, DEFB = 47, DEFI = 48,

    TEXCOORD = 64, TEXKILL = 65, TEX = 66, TEXBEM = 67, TEXBEML = 68,
    TEXREG2AR = 69, TEXREG2GB = 70, TEXM3x2PAD = 71, TEXM3x2TEX = 72,
    TEXM3x3PAD = 73, TEXM3x3TEX = 74, RESERVED0 = 75, TEXM3x3SPEC = 76,
    TEXM3x3VSPEC = 77, EXPP = 78, LOGP = 79, CND = 80, DEF = 81,
    TEXREG2RGB = 82, TEXDP3TEX = 83, TEXM3x2DEPTH = 84, TEXDP3 = 85,
    TEXM3x3 = 86, TEXDEPTH = 87, CMP = 88, BEM = 89, DP2ADD = 90,
    DSX = 91, DSY = 92, TEXLDD = 93, SETP = 94, TEXLDL = 95, BREAKP = 96,

    PHASE = 0xFFFD, COMMENT = 0xFFFE, END = 0xFFFF,
}

// ── Register types (5-bit field split across token bits 28-30 + 11-12) ─────────

// ADDR/TEXTURE and TEXCRDOUT/OUTPUT are intentional D3D9 aliases: the same
// numeric register class has stage-specific names in the bytecode ABI.
/* eslint-disable @typescript-eslint/no-duplicate-enum-values */
export const enum RegType {
    TEMP = 0,        // r#
    INPUT = 1,       // v#  (vertex input / PS color iterator)
    CONST = 2,       // c#  (float constant)
    ADDR = 3,        // a0 (VS) — SAME numeric value is TEXTURE (t#) in PS
    TEXTURE = 3,
    RASTOUT = 4,     // oPos / oFog / oPts (VS)
    ATTROUT = 5,     // oD0 / oD1 (VS)
    TEXCRDOUT = 6,   // oT0-7 (VS<3) — also "output" o# in VS3
    OUTPUT = 6,
    CONSTINT = 7,    // i#
    COLOROUT = 8,    // oC# (PS)
    DEPTHOUT = 9,    // oDepth
    SAMPLER = 10,    // s#
    CONST2 = 11,
    CONST3 = 12,
    CONST4 = 13,
    CONSTBOOL = 14,  // b#
    LOOP = 15,       // aL
    TEMPFLOAT16 = 16,
    MISCTYPE = 17,   // vPos(0) / vFace(1)
    LABEL = 18,
    PREDICATE = 19,  // p0
}
/* eslint-enable @typescript-eslint/no-duplicate-enum-values */

// RASTOUT sub-indices
export const RASTOUT_POS = 0;
export const RASTOUT_FOG = 1;
export const RASTOUT_PTS = 2;

// ── Source modifiers (token bits 24-27) ───────────────────────────────────────

export const enum SrcMod {
    NONE = 0, NEG = 1, BIAS = 2, BIASNEG = 3, SIGN = 4, SIGNNEG = 5,
    COMP = 6, X2 = 7, X2NEG = 8, DZ = 9, DW = 10, ABS = 11, ABSNEG = 12, NOT = 13,
}

/** D3DSHADER_COMPARISON values carried by IFC, BREAKC and SETP. */
export type CmpOp = "gt" | "eq" | "ge" | "lt" | "ne" | "le";

/** Raw D3DSHADER_COMPARISON code to its typed assembly comparison suffix. */
export const CMP_OP_BY_CODE: Readonly<Partial<Record<number, CmpOp>>> = {
    1: "gt",
    2: "eq",
    3: "ge",
    4: "lt",
    5: "ne",
    6: "le",
};

export function cmpOpFromCode(code: number): CmpOp | undefined {
    return CMP_OP_BY_CODE[code];
}

// ── D3DDECLUSAGE (dcl usage + vertex declaration usage) ───────────────────────

export const enum Usage {
    POSITION = 0, BLENDWEIGHT = 1, BLENDINDICES = 2, NORMAL = 3, PSIZE = 4,
    TEXCOORD = 5, TANGENT = 6, BINORMAL = 7, TESSFACTOR = 8, POSITIONT = 9,
    COLOR = 10, FOG = 11, DEPTH = 12, SAMPLE = 13,
}

// ── DCL texture type (dcl token bits 27-30) — starts at 2 ──────────────────────

export const enum TexType { UNKNOWN = 0, D2 = 2, CUBE = 3, VOLUME = 4 }

// ── Per-opcode operand-DWORD count for SM1.x (no length field in token) ────────
//
// Count = number of operand tokens that FOLLOW the instruction token
// (dst + sources + any inline payload). For ps_1_4, TEX and TEXCOORD gain +1
// (handled in the parser). Values are the SM1.x token ABI, cross-checked against
// DXVK dxso_tables.cpp.

export const DEFAULT_LEN: Record<number, number> = {
    [Op.NOP]: 0, [Op.MOV]: 2, [Op.ADD]: 3, [Op.SUB]: 3, [Op.MAD]: 4, [Op.MUL]: 3,
    [Op.RCP]: 2, [Op.RSQ]: 2, [Op.DP3]: 3, [Op.DP4]: 3, [Op.MIN]: 3, [Op.MAX]: 3,
    [Op.SLT]: 3, [Op.SGE]: 3, [Op.EXP]: 2, [Op.LOG]: 2, [Op.LIT]: 2, [Op.DST]: 3,
    [Op.LRP]: 4, [Op.FRC]: 2, [Op.M4x4]: 3, [Op.M4x3]: 3, [Op.M3x4]: 3,
    [Op.M3x3]: 3, [Op.M3x2]: 3, [Op.CALL]: 1, [Op.CALLNZ]: 2, [Op.LOOP]: 2,
    [Op.RET]: 0, [Op.ENDLOOP]: 0, [Op.LABEL]: 1, [Op.DCL]: 2, [Op.POW]: 3,
    [Op.CRS]: 3, [Op.SGN]: 4, [Op.ABS]: 2, [Op.NRM]: 2, [Op.SINCOS]: 4,
    [Op.REP]: 1, [Op.ENDREP]: 0, [Op.IF]: 1, [Op.IFC]: 2, [Op.ELSE]: 0,
    [Op.ENDIF]: 0, [Op.BREAK]: 0, [Op.BREAKC]: 2, [Op.MOVA]: 2, [Op.DEFB]: 2,
    [Op.DEFI]: 5,
    [Op.TEXCOORD]: 1, [Op.TEXKILL]: 1, [Op.TEX]: 1, [Op.TEXBEM]: 2,
    [Op.TEXBEML]: 2, [Op.TEXREG2AR]: 2, [Op.TEXREG2GB]: 2, [Op.TEXM3x2PAD]: 2,
    [Op.TEXM3x2TEX]: 2, [Op.TEXM3x3PAD]: 2, [Op.TEXM3x3TEX]: 2,
    [Op.TEXM3x3SPEC]: 3, [Op.TEXM3x3VSPEC]: 2, [Op.EXPP]: 2, [Op.LOGP]: 2,
    [Op.CND]: 4, [Op.DEF]: 5, [Op.TEXREG2RGB]: 2, [Op.TEXDP3TEX]: 2,
    [Op.TEXM3x2DEPTH]: 2, [Op.TEXDP3]: 2, [Op.TEXM3x3]: 2, [Op.TEXDEPTH]: 1,
    [Op.CMP]: 4, [Op.BEM]: 3, [Op.DP2ADD]: 4, [Op.DSX]: 2, [Op.DSY]: 2,
    [Op.TEXLDD]: 5, [Op.SETP]: 3, [Op.TEXLDL]: 3, [Op.BREAKP]: 2,
};

/** Opcodes that have no destination operand (flow control + nop). */
export const NO_DST = new Set<number>([
    Op.NOP, Op.CALL, Op.CALLNZ, Op.LOOP, Op.RET, Op.ENDLOOP, Op.LABEL,
    Op.REP, Op.ENDREP, Op.IF, Op.IFC, Op.ELSE, Op.ENDIF, Op.BREAK,
    Op.BREAKC, Op.BREAKP, Op.PHASE,
]);

/** Human-readable opcode name (for logs / generated comments). */
export function opName(op: number): string {
    return OP_NAMES[op] ?? `op_0x${op.toString(16)}`;
}

const OP_NAMES: Record<number, string> = {
    0: "nop", 1: "mov", 2: "add", 3: "sub", 4: "mad", 5: "mul", 6: "rcp",
    7: "rsq", 8: "dp3", 9: "dp4", 10: "min", 11: "max", 12: "slt", 13: "sge",
    14: "exp", 15: "log", 16: "lit", 17: "dst", 18: "lrp", 19: "frc",
    20: "m4x4", 21: "m4x3", 22: "m3x4", 23: "m3x3", 24: "m3x2", 25: "call",
    26: "callnz", 27: "loop", 28: "ret", 29: "endloop", 30: "label", 31: "dcl",
    32: "pow", 33: "crs", 34: "sgn", 35: "abs", 36: "nrm", 37: "sincos",
    38: "rep", 39: "endrep", 40: "if", 41: "ifc", 42: "else", 43: "endif",
    44: "break", 45: "breakc", 46: "mova", 47: "defb", 48: "defi",
    64: "texcoord", 65: "texkill", 66: "tex", 67: "texbem", 68: "texbeml",
    69: "texreg2ar", 70: "texreg2gb", 71: "texm3x2pad", 72: "texm3x2tex",
    73: "texm3x3pad", 74: "texm3x3tex", 76: "texm3x3spec", 77: "texm3x3vspec",
    78: "expp", 79: "logp", 80: "cnd", 81: "def", 82: "texreg2rgb",
    83: "texdp3tex", 84: "texm3x2depth", 85: "texdp3", 86: "texm3x3",
    87: "texdepth", 88: "cmp", 89: "bem", 90: "dp2add", 91: "dsx", 92: "dsy",
    93: "texldd", 94: "setp", 95: "texldl", 96: "breakp",
    0xFFFD: "phase", 0xFFFE: "comment", 0xFFFF: "end",
};
