/**
 * shader-asm.ts — D3DX shader text ↔ DXSO bytecode (the engine behind
 * D3DXAssembleShader / D3DXDisassembleShader).
 *
 * The pairing exists for one real workload: D3D8→D3D9 wrappers disassemble a
 * D3D8 shader, rewrite the TEXT (version line, inserted `dcl_*`, ps_1_x→ps_1_4)
 * and assemble it back. So the two directions must be exact inverses over real
 * bytecode, and the assembler must accept text it did not itself produce —
 * foreign spellings (`texld` vs `tex`, `.rgb` masks, C block comments, CRLF)
 * all have to land on the same tokens.
 *
 * Decoding reuses the recompiler's parser (sm-parser.ts) rather than a second
 * token walker; encoding is the mirror of its bit layout. Both operate on the
 * SOURCE-ORDER stream, because dcl/def/instruction interleaving is part of the
 * program.
 */

import {
    DEFAULT_LEN, NO_DST, Op, RegType, SrcMod, TexType, Usage,
} from '../../backends/webgpu/d3d9/shader/sm-enums';
import {
    parseShader, SmDcl, SmDef, SmDest, SmInstruction, SmProgram, SmRegister, SmSource,
} from '../../backends/webgpu/d3d9/shader/sm-parser';

/** Bit 31 of every destination/source/dcl parameter token is reserved and set. */
const PARAM_TOKEN_BIT = 0x80000000;
const SWIZZLE_IDENTITY = 0xE4;
const END_TOKEN = 0x0000FFFF;
const INDENT = '    ';

/** Assembly failed with a source location the caller can hand back to the guest. */
export class ShaderAsmError extends Error {
    constructor(message: string, readonly line: number) {
        super(line > 0 ? `(${line}): error: ${message}` : `error: ${message}`);
        this.name = 'ShaderAsmError';
    }
}

interface ShaderCtx {
    isPixelShader: boolean;
    major: number;
    minor: number;
}

const isPs14 = (c: ShaderCtx) => c.isPixelShader && c.major === 1 && c.minor === 4;

// ── Opcode names ──────────────────────────────────────────────────────────────

const OPCODE_BY_NAME: Record<string, Op> = {
    nop: Op.NOP, mov: Op.MOV, add: Op.ADD, sub: Op.SUB, mad: Op.MAD, mul: Op.MUL,
    rcp: Op.RCP, rsq: Op.RSQ, dp3: Op.DP3, dp4: Op.DP4, min: Op.MIN, max: Op.MAX,
    slt: Op.SLT, sge: Op.SGE, exp: Op.EXP, log: Op.LOG, lit: Op.LIT, dst: Op.DST,
    lrp: Op.LRP, frc: Op.FRC, m4x4: Op.M4x4, m4x3: Op.M4x3, m3x4: Op.M3x4,
    m3x3: Op.M3x3, m3x2: Op.M3x2, call: Op.CALL, callnz: Op.CALLNZ, loop: Op.LOOP,
    ret: Op.RET, endloop: Op.ENDLOOP, label: Op.LABEL, pow: Op.POW, crs: Op.CRS,
    sgn: Op.SGN, abs: Op.ABS, nrm: Op.NRM, sincos: Op.SINCOS, rep: Op.REP,
    endrep: Op.ENDREP, if: Op.IF, else: Op.ELSE, endif: Op.ENDIF, break: Op.BREAK,
    mova: Op.MOVA, defb: Op.DEFB, defi: Op.DEFI, def: Op.DEF,
    texcoord: Op.TEXCOORD, texcrd: Op.TEXCOORD, texkill: Op.TEXKILL,
    tex: Op.TEX, texld: Op.TEX, texbem: Op.TEXBEM, texbeml: Op.TEXBEML,
    texreg2ar: Op.TEXREG2AR, texreg2gb: Op.TEXREG2GB, texm3x2pad: Op.TEXM3x2PAD,
    texm3x2tex: Op.TEXM3x2TEX, texm3x3pad: Op.TEXM3x3PAD, texm3x3tex: Op.TEXM3x3TEX,
    texm3x3spec: Op.TEXM3x3SPEC, texm3x3vspec: Op.TEXM3x3VSPEC, expp: Op.EXPP,
    logp: Op.LOGP, cnd: Op.CND, texreg2rgb: Op.TEXREG2RGB, texdp3tex: Op.TEXDP3TEX,
    texm3x2depth: Op.TEXM3x2DEPTH, texdp3: Op.TEXDP3, texm3x3: Op.TEXM3x3,
    texdepth: Op.TEXDEPTH, cmp: Op.CMP, bem: Op.BEM, dp2add: Op.DP2ADD,
    dsx: Op.DSX, dsy: Op.DSY, texldd: Op.TEXLDD, texldl: Op.TEXLDL,
    breakp: Op.BREAKP, phase: Op.PHASE,
};

/** First spelling wins, so aliases (`texld`, `texcrd`) never become the canonical name. */
const NAME_BY_OPCODE: Record<number, string> = (() => {
    const table: Record<number, string> = {};
    for (const [name, opcode] of Object.entries(OPCODE_BY_NAME)) {
        if (table[opcode] === undefined) table[opcode] = name;
    }
    return table;
})();

/** D3DSHADER_COMPARISON — the `_gt`/`_le`/… suffix on if/break/setp. */
const COMPARISON_NAMES = ['', 'gt', 'eq', 'ge', 'lt', 'ne', 'le'];

/** Opcodes whose comparison variant is a DIFFERENT opcode from the plain one. */
const COMPARISON_OPCODE: Record<string, Op> = { if: Op.IFC, break: Op.BREAKC, setp: Op.SETP };

/** texld modifier bits (SM2+): D3DSI_TEXLD_PROJECT / _BIAS live in specificData. */
const TEXLD_PROJECT = 0x1;
const TEXLD_BIAS = 0x2;

const USAGE_NAMES: Record<number, string> = {
    [Usage.POSITION]: 'position', [Usage.BLENDWEIGHT]: 'blendweight',
    [Usage.BLENDINDICES]: 'blendindices', [Usage.NORMAL]: 'normal',
    [Usage.PSIZE]: 'psize', [Usage.TEXCOORD]: 'texcoord', [Usage.TANGENT]: 'tangent',
    [Usage.BINORMAL]: 'binormal', [Usage.TESSFACTOR]: 'tessfactor',
    [Usage.POSITIONT]: 'positiont', [Usage.COLOR]: 'color', [Usage.FOG]: 'fog',
    [Usage.DEPTH]: 'depth', [Usage.SAMPLE]: 'sample',
};
const USAGE_BY_NAME: Record<string, number> = Object.fromEntries(
    Object.entries(USAGE_NAMES).map(([value, name]) => [name, Number(value)]),
);

const TEXTYPE_NAMES: Record<number, string> = {
    [TexType.D2]: '2d', [TexType.CUBE]: 'cube', [TexType.VOLUME]: 'volume',
};
const TEXTYPE_BY_NAME: Record<string, number> = Object.fromEntries(
    Object.entries(TEXTYPE_NAMES).map(([value, name]) => [name, Number(value)]),
);

const SHIFT_NAMES: Record<number, string> = {
    1: 'x2', 2: 'x4', 3: 'x8', [-1]: 'd2', [-2]: 'd4', [-3]: 'd8',
};
const SHIFT_BY_NAME: Record<string, number> = {
    x2: 1, x4: 2, x8: 3, d2: -1, d4: -2, d8: -3,
};

/**
 * Instruction-slot cost for the trailing "approximately N instruction slots
 * used" line, calibrated against d3dx9_43 (tools/d3dx-oracle.ts). Everything
 * absent costs one slot; macro-ops expand, flow control carries setup, and
 * `nop`/`label`/`phase`/dcl/def are free. Microsoft's own hedge is the word
 * "approximately" — BREAKP is the one entry taken by analogy (with BREAKC)
 * rather than measured.
 */
const SLOT_COST: Record<number, number> = {
    [Op.NOP]: 0, [Op.LABEL]: 0, [Op.PHASE]: 0,
    [Op.LOOP]: 3, [Op.ENDLOOP]: 2, [Op.REP]: 3, [Op.ENDREP]: 2,
    [Op.IF]: 3, [Op.IFC]: 3, [Op.ELSE]: 1, [Op.ENDIF]: 1,
    [Op.CALL]: 2, [Op.CALLNZ]: 3, [Op.RET]: 1,
    [Op.BREAK]: 1, [Op.BREAKC]: 3, [Op.BREAKP]: 3,
    [Op.M4x4]: 4, [Op.M4x3]: 3, [Op.M3x4]: 4, [Op.M3x3]: 3, [Op.M3x2]: 2,
    [Op.SINCOS]: 8, [Op.NRM]: 3, [Op.CRS]: 2, [Op.POW]: 3, [Op.SGN]: 3,
    [Op.DP2ADD]: 2,
};

/**
 * SM1 vertex shaders expand three of these as macros that later models issue
 * natively (`expp`/`logp` are the one-slot partial-precision forms).
 */
const SLOT_COST_VS1: Record<number, number> = {
    [Op.FRC]: 3, [Op.EXP]: 10, [Op.LOG]: 10,
};

function slotCost(opcode: Op, ctx: ShaderCtx): number {
    if (!ctx.isPixelShader && ctx.major < 2) {
        const legacy = SLOT_COST_VS1[opcode];
        if (legacy !== undefined) return legacy;
    }
    return SLOT_COST[opcode] ?? 1;
}

/** Instructions that open a block; their bodies are indented two spaces further. */
const BLOCK_OPEN = new Set<number>([Op.IF, Op.IFC, Op.ELSE, Op.LOOP, Op.REP]);
const BLOCK_CLOSE = new Set<number>([Op.ELSE, Op.ENDIF, Op.ENDLOOP, Op.ENDREP]);

/** texkill is the one tex* opcode the slot summary counts as arithmetic. */
function isTextureOp(opcode: Op): boolean {
    if (opcode === Op.TEXKILL) return false;
    return (opcode >= Op.TEXCOORD && opcode <= Op.TEXDEPTH)
        || opcode === Op.TEXLDD || opcode === Op.TEXLDL;
}

// ── Register naming ───────────────────────────────────────────────────────────

function registerName(reg: SmRegister, ctx: ShaderCtx): string {
    const n = reg.num;
    switch (reg.type) {
        case RegType.TEMP: return `r${n}`;
        case RegType.INPUT: return `v${n}`;
        case RegType.CONST: return `c${n}`;
        // Numerically one type: a# in a vertex shader, t# in a pixel shader.
        case RegType.ADDR: return ctx.isPixelShader ? `t${n}` : `a${n}`;
        case RegType.RASTOUT:
            if (n === 0) return 'oPos';
            if (n === 1) return 'oFog';
            if (n === 2) return 'oPts';
            throw new Error(`unknown rasterizer output index ${n}`);
        case RegType.ATTROUT: return `oD${n}`;
        case RegType.TEXCRDOUT: return ctx.major >= 3 ? `o${n}` : `oT${n}`;
        case RegType.CONSTINT: return `i${n}`;
        case RegType.COLOROUT: return `oC${n}`;
        case RegType.DEPTHOUT: return 'oDepth';
        case RegType.SAMPLER: return `s${n}`;
        case RegType.CONSTBOOL: return `b${n}`;
        case RegType.LOOP: return 'aL';
        case RegType.MISCTYPE: return n === 0 ? 'vPos' : 'vFace';
        case RegType.LABEL: return `l${n}`;
        case RegType.PREDICATE: return `p${n}`;
        default:
            throw new Error(`register type ${reg.type} has no assembly spelling`);
    }
}

const EXACT_REGISTERS: Record<string, { type: RegType; num: number }> = {
    opos: { type: RegType.RASTOUT, num: 0 },
    ofog: { type: RegType.RASTOUT, num: 1 },
    opts: { type: RegType.RASTOUT, num: 2 },
    odepth: { type: RegType.DEPTHOUT, num: 0 },
    al: { type: RegType.LOOP, num: 0 },
    vpos: { type: RegType.MISCTYPE, num: 0 },
    vface: { type: RegType.MISCTYPE, num: 1 },
};

/** Longest prefix first — `oD0` must not be read as `o` + "D0". */
const REGISTER_PREFIXES: Array<[string, RegType]> = [
    ['od', RegType.ATTROUT], ['ot', RegType.TEXCRDOUT], ['oc', RegType.COLOROUT],
    ['o', RegType.TEXCRDOUT /* vs_3_0 o# shares TEXCRDOUT's numeric type */],
    ['r', RegType.TEMP], ['v', RegType.INPUT], ['c', RegType.CONST],
    ['t', RegType.TEXTURE], ['a', RegType.ADDR], ['s', RegType.SAMPLER],
    ['i', RegType.CONSTINT], ['b', RegType.CONSTBOOL], ['p', RegType.PREDICATE],
    ['l', RegType.LABEL],
];

function parseRegisterName(name: string, ctx: ShaderCtx, line: number): { type: RegType; num: number } {
    const lower = name.toLowerCase();
    const exact = EXACT_REGISTERS[lower];
    if (exact) return exact;
    for (const [prefix, type] of REGISTER_PREFIXES) {
        if (!lower.startsWith(prefix)) continue;
        const digits = lower.slice(prefix.length);
        if (!/^[0-9]+$/.test(digits)) continue;
        // t#/a# are one numeric encoding (RegType.TEXTURE === RegType.ADDR); the
        // SPELLING disambiguates it, and each spelling is only legal in the stage
        // it names — `t0` in a vertex shader and `a0` in a pixel shader are both
        // unknown registers to the real assembler, not a type coerced the other way.
        if (prefix === 't' && !ctx.isPixelShader) continue;
        if (prefix === 'a' && ctx.isPixelShader) continue;
        const num = Number(digits);
        if (num > 0x7FF) throw new ShaderAsmError(`register index ${num} out of range`, line);
        return { type, num };
    }
    throw new ShaderAsmError(`unknown register '${name}'`, line);
}

// ── Swizzles and masks ────────────────────────────────────────────────────────

const COMPONENTS = 'xyzw';

function swizzleSuffix(swizzle: number): string {
    if (swizzle === SWIZZLE_IDENTITY) return '';
    const c = [0, 1, 2, 3].map((i) => COMPONENTS[(swizzle >>> (2 * i)) & 3]);
    if (c[0] === c[1] && c[1] === c[2] && c[2] === c[3]) return `.${c[0]}`;
    return `.${c.join('')}`;
}

function componentIndex(ch: string, line: number): number {
    const i = 'xyzwrgba'.indexOf(ch.toLowerCase());
    if (i < 0) throw new ShaderAsmError(`invalid component '${ch}'`, line);
    return i & 3;
}

/** Fewer than four components replicate the last one, as the D3D assembler does. */
function parseSwizzle(text: string | undefined, line: number): number {
    if (!text) return SWIZZLE_IDENTITY;
    if (text.length < 1 || text.length > 4) throw new ShaderAsmError(`invalid swizzle '.${text}'`, line);
    const idx = [...text].map((ch) => componentIndex(ch, line));
    while (idx.length < 4) idx.push(idx[idx.length - 1]);
    return (idx[0] | (idx[1] << 2) | (idx[2] << 4) | (idx[3] << 6)) >>> 0;
}

function maskSuffix(writeMask: number): string {
    if (writeMask === 0xF) return '';
    let out = '.';
    for (let i = 0; i < 4; i++) if (writeMask & (1 << i)) out += COMPONENTS[i];
    return out; // A zero mask prints as a bare '.', which parses back to zero.
}

function parseMask(text: string | undefined, line: number): number {
    if (text === undefined) return 0xF;
    let mask = 0;
    for (const ch of text) mask |= 1 << componentIndex(ch, line);
    return mask;
}

// ── Source modifiers ──────────────────────────────────────────────────────────

interface SrcModSpelling { prefix: string; suffix: string }

const SRC_MOD_SPELLING: Record<number, SrcModSpelling> = {
    [SrcMod.NONE]: { prefix: '', suffix: '' },
    [SrcMod.NEG]: { prefix: '-', suffix: '' },
    [SrcMod.BIAS]: { prefix: '', suffix: '_bias' },
    [SrcMod.BIASNEG]: { prefix: '-', suffix: '_bias' },
    [SrcMod.SIGN]: { prefix: '', suffix: '_bx2' },
    [SrcMod.SIGNNEG]: { prefix: '-', suffix: '_bx2' },
    [SrcMod.COMP]: { prefix: '1-', suffix: '' },
    [SrcMod.X2]: { prefix: '', suffix: '_x2' },
    [SrcMod.X2NEG]: { prefix: '-', suffix: '_x2' },
    [SrcMod.DZ]: { prefix: '', suffix: '_dz' },
    [SrcMod.DW]: { prefix: '', suffix: '_dw' },
    [SrcMod.ABS]: { prefix: '', suffix: '_abs' },
    [SrcMod.ABSNEG]: { prefix: '-', suffix: '_abs' },
    [SrcMod.NOT]: { prefix: '!', suffix: '' },
};

function srcModifierFrom(negated: boolean, complement: boolean, not: boolean, suffix: string, line: number): SrcMod {
    if (not) {
        if (suffix || negated || complement) throw new ShaderAsmError('invalid source modifier combination', line);
        return SrcMod.NOT;
    }
    if (complement) {
        if (suffix || negated) throw new ShaderAsmError('invalid source modifier combination', line);
        return SrcMod.COMP;
    }
    switch (suffix) {
        case '': return negated ? SrcMod.NEG : SrcMod.NONE;
        case '_bias': return negated ? SrcMod.BIASNEG : SrcMod.BIAS;
        case '_bx2': return negated ? SrcMod.SIGNNEG : SrcMod.SIGN;
        case '_x2': return negated ? SrcMod.X2NEG : SrcMod.X2;
        case '_dz': case '_db':
            if (negated) throw new ShaderAsmError('_dz cannot be negated', line);
            return SrcMod.DZ;
        case '_dw': case '_da':
            if (negated) throw new ShaderAsmError('_dw cannot be negated', line);
            return SrcMod.DW;
        case '_abs': return negated ? SrcMod.ABSNEG : SrcMod.ABS;
        default: throw new ShaderAsmError(`unknown source modifier '${suffix}'`, line);
    }
}

/** Source modifiers that differ only by sign; anything else cannot be negated. */
const NEGATED_MOD: Record<number, SrcMod> = {
    [SrcMod.NONE]: SrcMod.NEG, [SrcMod.NEG]: SrcMod.NONE,
    [SrcMod.BIAS]: SrcMod.BIASNEG, [SrcMod.BIASNEG]: SrcMod.BIAS,
    [SrcMod.SIGN]: SrcMod.SIGNNEG, [SrcMod.SIGNNEG]: SrcMod.SIGN,
    [SrcMod.X2]: SrcMod.X2NEG, [SrcMod.X2NEG]: SrcMod.X2,
    [SrcMod.ABS]: SrcMod.ABSNEG, [SrcMod.ABSNEG]: SrcMod.ABS,
};

// ── Numeric literals ──────────────────────────────────────────────────────────

const FLOAT_PRECISION = 9;

function stripTrailingZeros(text: string): string {
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * D3DX prints constants with MSVC's `%.9g`: nine significant digits, trailing
 * zeros stripped, scientific notation outside [1e-4, 1e9) and a three-digit
 * exponent (`1.00000001e-007`). JS `toPrecision` agrees on the digits but not
 * on when to switch notation or how wide the exponent is.
 */
function formatFloat(value: number): string {
    if (!Number.isFinite(value)) {
        // No assembly spelling exists for inf/NaN constants; refusing beats
        // emitting text that assembles back to a different bit pattern.
        throw new Error('shader defines a non-finite constant');
    }
    if (value === 0) return Object.is(value, -0) ? '-0' : '0';

    const exponent = Number(value.toExponential(FLOAT_PRECISION - 1).split('e')[1]);
    if (exponent < -4 || exponent >= FLOAT_PRECISION) {
        const [mantissa, exp] = value.toExponential(FLOAT_PRECISION - 1).split('e');
        const sign = exp.startsWith('-') ? '-' : '+';
        const digits = exp.replace(/^[-+]/, '').padStart(3, '0');
        return `${stripTrailingZeros(mantissa)}e${sign}${digits}`;
    }
    return stripTrailingZeros(value.toFixed(Math.max(0, FLOAT_PRECISION - 1 - exponent)));
}

// ── Disassembly ───────────────────────────────────────────────────────────────

function sourceText(src: SmSource, ctx: ShaderCtx): string {
    const spelling = SRC_MOD_SPELLING[src.modifier];
    if (!spelling) throw new Error(`unknown source modifier ${src.modifier}`);

    let base: string;
    if (src.reg.relative) {
        // D3DX spells this `c3[a0.x]` — base register indexed by the address
        // register, NOT the `c[a0.x + 3]` form it also accepts as input.
        const index = src.relReg
            ? `${registerName(src.relReg, ctx)}${swizzleSuffix(src.relSwizzle ?? SWIZZLE_IDENTITY)}`
            : 'a0.x';
        base = `${registerName({ ...src.reg, relative: false }, ctx)}[${index}]`;
    } else {
        base = registerName(src.reg, ctx);
    }
    return `${spelling.prefix}${base}${spelling.suffix}${swizzleSuffix(src.swizzle)}`;
}

function destText(dst: SmDest, ctx: ShaderCtx): string {
    if (dst.reg.relative) throw new Error('relative addressing on a destination is not supported');
    return `${registerName(dst.reg, ctx)}${maskSuffix(dst.writeMask)}`;
}

function destModifiers(dst: SmDest): string {
    let out = '';
    if (dst.shift !== 0) {
        const name = SHIFT_NAMES[dst.shift];
        if (!name) throw new Error(`unknown result shift ${dst.shift}`);
        out += `_${name}`;
    }
    if (dst.saturate) out += '_sat';
    if (dst.partialPrecision) out += '_pp';
    if (dst.centroid) out += '_centroid';
    return out;
}

function mnemonicText(ins: SmInstruction, ctx: ShaderCtx): string {
    const ps14 = isPs14(ctx);
    switch (ins.opcode) {
        case Op.TEX: {
            if (ctx.major >= 2) {
                if (ins.specificData === TEXLD_PROJECT) return 'texldp';
                if (ins.specificData === TEXLD_BIAS) return 'texldb';
                if (ins.specificData !== 0) throw new Error(`unknown texld modifier 0x${ins.specificData.toString(16)}`);
                return 'texld';
            }
            return ps14 ? 'texld' : 'tex';
        }
        case Op.TEXCOORD: return ps14 ? 'texcrd' : 'texcoord';
        case Op.IFC: case Op.BREAKC: case Op.SETP: {
            const suffix = COMPARISON_NAMES[ins.specificData];
            if (!suffix) throw new Error(`unknown comparison mode ${ins.specificData}`);
            const base = ins.opcode === Op.IFC ? 'if' : ins.opcode === Op.BREAKC ? 'break' : 'setp';
            return `${base}_${suffix}`;
        }
        default: {
            const name = NAME_BY_OPCODE[ins.opcode];
            if (!name) throw new Error(`opcode 0x${ins.opcode.toString(16)} has no assembly spelling`);
            if (ins.specificData !== 0) {
                throw new Error(`opcode ${name} carries unsupported control bits 0x${ins.specificData.toString(16)}`);
            }
            return name;
        }
    }
}

function dclText(dcl: SmDcl, ctx: ShaderCtx): string {
    let mnemonic = 'dcl';
    if (dcl.reg.type === RegType.SAMPLER) {
        const texType = TEXTYPE_NAMES[dcl.textureType];
        if (texType) mnemonic += `_${texType}`;
    } else if (dcl.reg.type === RegType.MISCTYPE) {
        // vPos / vFace name their own semantic; the usage field is unused.
    } else if (!(ctx.isPixelShader && ctx.major === 2)) {
        // ps_2_0 declares inputs without a semantic; every other model has one.
        const usage = USAGE_NAMES[dcl.usage];
        if (usage === undefined) throw new Error(`unknown dcl usage ${dcl.usage}`);
        mnemonic += `_${usage}${dcl.usageIndex ? dcl.usageIndex : ''}`;
    }
    return `${mnemonic} ${registerName(dcl.reg, ctx)}${maskSuffix(dcl.writeMask)}`;
}

function defText(def: SmDef, ctx: ShaderCtx): string {
    const reg = registerName(def.reg, ctx);
    if (def.kind === 'f') {
        return `def ${reg}, ${[...def.values].map(formatFloat).join(', ')}`;
    }
    if (def.kind === 'i') {
        return `defi ${reg}, ${[...def.rawInt].join(', ')}`;
    }
    const value = def.rawInt[0];
    const spelling = value === 0 ? 'false' : value === 1 ? 'true' : String(value);
    return `defb ${reg}, ${spelling}`;
}

/**
 * Bytecode → assembly text, spelled exactly as d3dx9 spells it: four-space
 * indent, two more per open block, `  + ` for a co-issued instruction, and the
 * trailing slot summary. The wrapper that consumes this drives regexes over the
 * indentation — it rewrites the four-space-indented `ps_1_[0-3]` line in place —
 * so the layout is contract, not cosmetics.
 *
 * Throws on anything it cannot spell exactly rather than emitting text that
 * would assemble back to different tokens.
 */
export function disassembleShader(tokens: Uint32Array): string {
    const program: SmProgram = parseShader(tokens);
    if (!program.terminated) throw new Error('shader bytecode has no END token');
    const ctx: ShaderCtx = {
        isPixelShader: program.isPixelShader,
        major: program.major,
        minor: program.minor,
    };

    const lines: string[] = [`${INDENT}${ctx.isPixelShader ? 'ps' : 'vs'}_${ctx.major}_${ctx.minor}`];
    let depth = 0;
    let textureSlots = 0;
    let arithmeticSlots = 0;
    const indentAt = () => INDENT + '  '.repeat(depth);

    for (const item of program.stream) {
        if (item.kind === 'dcl') { lines.push(`${indentAt()}${dclText(item.dcl, ctx)}`); continue; }
        if (item.kind === 'def') { lines.push(`${indentAt()}${defText(item.def, ctx)}`); continue; }
        if (item.kind === 'phase') { lines.push(`${indentAt()}phase`); continue; }

        const ins = item.instruction;
        if (ins.predicated) throw new Error('predicated instructions are not supported');

        const slots = ins.coissue ? 0 : slotCost(ins.opcode, ctx);
        if (isTextureOp(ins.opcode)) textureSlots += slots; else arithmeticSlots += slots;

        if (BLOCK_CLOSE.has(ins.opcode) && depth > 0) depth--;
        const operands: string[] = [];
        if (ins.dst) operands.push(destText(ins.dst, ctx));
        for (const src of ins.src) operands.push(sourceText(src, ctx));
        const mods = ins.dst ? destModifiers(ins.dst) : '';
        const head = `${mnemonicText(ins, ctx)}${mods}`;
        const body = `${head}${operands.length ? ` ${operands.join(', ')}` : ''}`;
        // A co-issued instruction hangs its '+' two columns left of the block.
        lines.push(ins.coissue ? `${indentAt().slice(2)}+ ${body}` : `${indentAt()}${body}`);
        if (BLOCK_OPEN.has(ins.opcode)) depth++;
    }

    const total = textureSlots + arithmeticSlots;
    const noun = total === 1 ? 'slot' : 'slots';
    const breakdown = ctx.isPixelShader && textureSlots > 0
        ? ` (${textureSlots} texture, ${arithmeticSlots} arithmetic)`
        : '';
    lines.push('', `// approximately ${total} instruction ${noun} used${breakdown}`, '');
    return lines.join('\n');
}

// ── Assembly ──────────────────────────────────────────────────────────────────

interface SourceLine { line: number; text: string }

/**
 * Strip `//`, `;` and `/* … *​/` comments while preserving line numbers, so an
 * error can point at the guest's own line.
 */
function stripComments(source: string): SourceLine[] {
    const out: SourceLine[] = [];
    let current = '';
    let line = 1;
    let inBlock = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        const next = source[i + 1];
        if (inBlock) {
            if (ch === '*' && next === '/') { inBlock = false; i++; continue; }
            if (ch === '\n') { out.push({ line, text: current }); current = ''; line++; }
            continue;
        }
        if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
        if ((ch === '/' && next === '/') || ch === ';') {
            while (i < source.length && source[i] !== '\n') i++;
            i--;
            continue;
        }
        if (ch === '\n') { out.push({ line, text: current }); current = ''; line++; continue; }
        if (ch === '\r') continue;
        current += ch;
    }
    if (current.length > 0) out.push({ line, text: current });
    return out;
}

function regBits(reg: SmRegister): number {
    return (((reg.type & 0x7) << 28)
        | (((reg.type >>> 3) & 0x3) << 11)
        | (reg.num & 0x7FF)
        | (reg.relative ? (1 << 13) : 0)
        | PARAM_TOKEN_BIT) >>> 0;
}

function encodeDst(dst: SmDest): number {
    return (regBits(dst.reg)
        | ((dst.writeMask & 0xF) << 16)
        | ((dst.shift & 0xF) << 24)
        | (dst.saturate ? (1 << 20) : 0)
        | (dst.partialPrecision ? (1 << 21) : 0)
        | (dst.centroid ? (1 << 22) : 0)) >>> 0;
}

function encodeSrc(src: SmSource): number[] {
    const token = (regBits(src.reg) | ((src.swizzle & 0xFF) << 16) | ((src.modifier & 0xF) << 24)) >>> 0;
    if (!src.reg.relative || !src.relReg) return [token];
    return [token, (regBits(src.relReg) | ((src.relSwizzle ?? SWIZZLE_IDENTITY) << 16)) >>> 0];
}

const OPERAND_SPLIT = /\s*,\s*/;

/** `c[a0.x + 3]`, `c[a0.x]`, `c3[a0.x]` — the three spellings of relative addressing. */
const RELATIVE_RE = /^([a-z]+)([0-9]*)\[\s*([a-z]+[0-9]*)\s*(?:\.\s*([xyzwrgba]))?\s*(?:\+\s*([0-9]+)\s*)?\]$/i;

interface RegisterRef {
    reg: SmRegister;
    relReg?: SmRegister;
    relSwizzle?: number;
}

function parseRegisterRef(text: string, ctx: ShaderCtx, line: number): RegisterRef {
    const relative = RELATIVE_RE.exec(text);
    if (relative) {
        const [, kind, baseDigits, indexName, component, offsetDigits] = relative;
        const base = parseRegisterName(`${kind}0`, ctx, line);
        // The base index is spelled EITHER before the bracket or as the addend inside it;
        // one token holds it, so `c3[a0.x + 2]` has no encoding. Taking one and dropping the
        // other would assemble a shader that reads a different constant than it says.
        if (baseDigits && offsetDigits) {
            const idx = component ? `${indexName}.${component}` : indexName;
            const sum = Number(baseDigits) + Number(offsetDigits);
            throw new ShaderAsmError(
                `relative address '${text}' gives the base index twice — `
                + `write ${kind}${sum}[${idx}] or ${kind}[${idx} + ${sum}]`,
                line);
        }
        const num = Number(baseDigits || offsetDigits || 0);
        const indexReg = parseRegisterName(indexName, ctx, line);
        const reg: SmRegister = { type: base.type, num, relative: true };
        // SM1.x has no relative-address token: a0.x is implied by the flag alone.
        if (ctx.major < 2) return { reg };
        // No component means the whole register (`c1[aL]`), i.e. the identity swizzle.
        const swizzle = component === undefined
            ? SWIZZLE_IDENTITY
            : (componentIndex(component, line) * 0x55) >>> 0;
        return {
            reg,
            relReg: { type: indexReg.type, num: indexReg.num, relative: false },
            relSwizzle: swizzle,
        };
    }
    const parsed = parseRegisterName(text, ctx, line);
    return { reg: { type: parsed.type, num: parsed.num, relative: false } };
}

const OPERAND_RE = /^([a-z]+[0-9]*(?:\[[^\]]*\])?)((?:_[a-z0-9]+)?)(?:\.([xyzwrgba]{0,4}))?$/i;

function splitOperand(text: string, line: number): { body: string; suffix: string; components?: string } {
    const match = OPERAND_RE.exec(text);
    if (!match) throw new ShaderAsmError(`cannot parse operand '${text}'`, line);
    return { body: match[1], suffix: match[2].toLowerCase(), components: match[3] };
}

function parseDest(text: string, ctx: ShaderCtx, line: number): SmDest {
    const { body, suffix, components } = splitOperand(text, line);
    if (suffix) throw new ShaderAsmError(`'${suffix}' is not valid on a destination`, line);
    const ref = parseRegisterRef(body, ctx, line);
    if (ref.reg.relative) throw new ShaderAsmError('relative addressing is not supported on a destination', line);
    return {
        reg: ref.reg,
        writeMask: parseMask(components, line),
        shift: 0,
        saturate: false,
        partialPrecision: false,
        centroid: false,
    };
}

/** def/defi/defb write directly into constant-register FILE storage, not the
 *  general register space — the real assembler rejects any other destination
 *  register kind, and rejects a write mask (the constant is always written
 *  whole; a mask has no encoding to fall back to). */
const DEF_DEST: Record<number, { type: RegType; letter: string }> = {
    [Op.DEF]: { type: RegType.CONST, letter: 'c' },
    [Op.DEFI]: { type: RegType.CONSTINT, letter: 'i' },
    [Op.DEFB]: { type: RegType.CONSTBOOL, letter: 'b' },
};

function checkDefDest(opcode: Op, dest: SmDest, mnemonic: string, line: number): void {
    const expected = DEF_DEST[opcode];
    if (dest.reg.type !== expected.type || dest.writeMask !== 0xF) {
        throw new ShaderAsmError(
            `destination for ${mnemonic} must be an unmasked ${expected.letter}# register`, line);
    }
}

function parseSource(text: string, ctx: ShaderCtx, line: number): SmSource {
    let rest = text;
    let complement = false;
    let negated = false;
    let not = false;
    if (rest.startsWith('1-')) { complement = true; rest = rest.slice(2).trim(); }
    else if (rest.startsWith('-')) { negated = true; rest = rest.slice(1).trim(); }
    else if (rest.startsWith('!')) { not = true; rest = rest.slice(1).trim(); }

    const { body, suffix, components } = splitOperand(rest, line);
    const ref = parseRegisterRef(body, ctx, line);
    const source: SmSource = {
        reg: ref.reg,
        swizzle: parseSwizzle(components, line),
        modifier: srcModifierFrom(negated, complement, not, suffix, line),
    };
    if (ref.reg.relative && ctx.major >= 2) {
        source.relReg = ref.relReg ?? { type: RegType.ADDR, num: 0, relative: false };
        source.relSwizzle = ref.relSwizzle ?? SWIZZLE_IDENTITY;
    }
    return source;
}

interface Mnemonic {
    opcode: Op;
    shift: number;
    saturate: boolean;
    partialPrecision: boolean;
    centroid: boolean;
    specificData: number;
}

interface OpcodeAvailability { minMajor: number; stage?: 'vs' | 'ps' }

/**
 * Opcodes introduced after SM1.x that DEFAULT_LEN (sm-enums.ts) still lists —
 * that table exists for SM1.x bytecode DECODING and is not an SM1.x legality
 * gate, so an opcode having an entry there says nothing about which shader
 * models may assemble it. Recorded against the real assembler (tools/d3dx-oracle.ts):
 * without an extended `_x` profile (which this assembler's version grammar
 * doesn't accept), predicate/derivative ops need major 3, not 2.
 */
const OPCODE_AVAILABILITY: Record<number, OpcodeAvailability> = {
    [Op.MOVA]: { minMajor: 2, stage: 'vs' },
    [Op.SETP]: { minMajor: 3 },
    [Op.BREAKP]: { minMajor: 3 },
    [Op.TEXLDD]: { minMajor: 3, stage: 'ps' },
    [Op.TEXLDL]: { minMajor: 3 },
};

function checkInstructionAvailability(opcode: Op, ctx: ShaderCtx, line: number): void {
    const avail = OPCODE_AVAILABILITY[opcode];
    if (!avail) return;
    const wrongStage = (avail.stage === 'vs' && ctx.isPixelShader) || (avail.stage === 'ps' && !ctx.isPixelShader);
    if (ctx.major < avail.minMajor || wrongStage) {
        const name = NAME_BY_OPCODE[opcode] ?? `op_0x${opcode.toString(16)}`;
        throw new ShaderAsmError(`'${name}' is not available in this shader version`, line);
    }
}

function parseMnemonic(raw: string, ctx: ShaderCtx, line: number): Mnemonic {
    let name = raw.toLowerCase();
    let shift = 0;
    let saturate = false;
    let partialPrecision = false;
    let centroid = false;
    let comparison = 0;

    for (;;) {
        const underscore = name.lastIndexOf('_');
        if (underscore <= 0) break;
        const tail = name.slice(underscore + 1);
        if (tail === 'sat') saturate = true;
        else if (tail === 'pp') partialPrecision = true;
        else if (tail === 'centroid') centroid = true;
        else if (SHIFT_BY_NAME[tail] !== undefined) shift = SHIFT_BY_NAME[tail];
        else if (COMPARISON_NAMES.indexOf(tail) > 0) comparison = COMPARISON_NAMES.indexOf(tail);
        else break;
        name = name.slice(0, underscore);
    }

    if (comparison) {
        const opcode = COMPARISON_OPCODE[name];
        if (opcode === undefined) throw new ShaderAsmError(`'${raw}' does not take a comparison suffix`, line);
        return { opcode, shift, saturate, partialPrecision, centroid, specificData: comparison };
    }
    if (name === 'setp') throw new ShaderAsmError('setp requires a comparison suffix (setp_gt, setp_le, …)', line);

    let specificData = 0;
    if (name === 'texldp' || name === 'texldb') {
        if (ctx.major < 2) throw new ShaderAsmError(`'${name}' requires shader model 2.0 or later`, line);
        specificData = name === 'texldp' ? TEXLD_PROJECT : TEXLD_BIAS;
        name = 'texld';
    }

    const opcode = OPCODE_BY_NAME[name];
    if (opcode === undefined) throw new ShaderAsmError(`unknown instruction '${raw}'`, line);
    return { opcode, shift, saturate, partialPrecision, centroid, specificData };
}

function parseVersion(text: string, line: number): ShaderCtx {
    const match = /^(vs|ps)_([0-9]+)_([0-9]+)$/i.exec(text.trim());
    if (!match) {
        throw new ShaderAsmError(`expected a shader version (vs_1_1, ps_2_0, …) but found '${text.trim()}'`, line);
    }
    const ctx = {
        isPixelShader: match[1].toLowerCase() === 'ps',
        major: Number(match[2]),
        minor: Number(match[3]),
    };
    if (ctx.major < 1 || ctx.major > 3) {
        throw new ShaderAsmError(`unsupported shader version '${text.trim()}'`, line);
    }
    return ctx;
}

function parseIntLiteral(text: string, line: number): number {
    const value = Number(text);
    if (!Number.isInteger(value)) throw new ShaderAsmError(`expected an integer, found '${text}'`, line);
    return value | 0;
}

function parseFloatLiteral(text: string, line: number): number {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new ShaderAsmError(`expected a number, found '${text}'`, line);
    return value;
}

function floatBits(value: number): number {
    const buffer = new Float32Array(1);
    buffer[0] = value;
    return new Uint32Array(buffer.buffer)[0] >>> 0;
}

function encodeDcl(mnemonic: string, operand: string, ctx: ShaderCtx, line: number): number[] {
    const suffix = mnemonic.slice(3).replace(/^_/, '');
    const dest = parseDest(operand, ctx, line);
    let dclToken = PARAM_TOKEN_BIT;

    if (dest.reg.type === RegType.SAMPLER) {
        if (suffix) {
            const texType = TEXTYPE_BY_NAME[suffix];
            if (texType === undefined) throw new ShaderAsmError(`unknown sampler type 'dcl_${suffix}'`, line);
            dclToken |= texType << 27;
        }
    } else if (suffix) {
        const match = /^([a-z]+)([0-9]*)$/.exec(suffix);
        const usage = match ? USAGE_BY_NAME[match[1]] : undefined;
        if (usage === undefined) throw new ShaderAsmError(`unknown declaration usage 'dcl_${suffix}'`, line);
        const index = Number(match![2] || 0);
        if (index > 0xF) throw new ShaderAsmError(`usage index ${index} out of range`, line);
        dclToken |= usage | (index << 16);
    }

    return [instructionToken(Op.DCL, 2, ctx), dclToken >>> 0, encodeDst(dest)];
}

function instructionToken(opcode: Op, operandCount: number, ctx: ShaderCtx, coissue = false, specificData = 0): number {
    let token = (opcode & 0xFFFF) | ((specificData & 0xFF) << 16);
    if (ctx.major >= 2) token |= (operandCount & 0xF) << 24;
    if (coissue) token |= 0x40000000;
    return token >>> 0;
}

/** SM1.x has no length field, so operand counts must match the fixed table exactly. */
function checkSm1OperandCount(opcode: Op, count: number, ctx: ShaderCtx, line: number): void {
    if (ctx.major >= 2) return;
    let expected = DEFAULT_LEN[opcode];
    if (expected === undefined) {
        throw new ShaderAsmError(`instruction is not available in shader model 1.x`, line);
    }
    if (isPs14(ctx) && (opcode === Op.TEX || opcode === Op.TEXCOORD)) expected += 1;
    if (count !== expected) {
        throw new ShaderAsmError(
            `instruction takes ${expected} operand(s) in this shader model, found ${count}`, line);
    }
}

/**
 * Assembly text → bytecode. Throws ShaderAsmError (carrying the source line) on
 * anything malformed — a silent S_OK with an empty buffer would be a wrong
 * answer the caller cannot detect.
 */
export function assembleShader(source: string): Uint32Array {
    const lines = stripComments(source).filter((entry) => entry.text.trim().length > 0);
    if (lines.length === 0) throw new ShaderAsmError('shader source is empty', 0);

    // This is an assembler, not a compiler: silently ignoring a directive would
    // hand back tokens that do not implement the source the caller wrote.
    const directive = lines.find((entry) => /^\s*#/.test(entry.text));
    if (directive) {
        throw new ShaderAsmError(
            `preprocessor directives (#include / #define / …) are not supported by the D3DX HLE assembler`,
            directive.line);
    }

    const ctx = parseVersion(lines[0].text, lines[0].line);
    const tokens: number[] = [
        (((ctx.isPixelShader ? 0xFFFF : 0xFFFE) << 16) | (ctx.major << 8) | ctx.minor) >>> 0,
    ];

    for (const entry of lines.slice(1)) {
        const line = entry.line;
        let text = entry.text.trim();
        let coissue = false;
        if (text.startsWith('+')) { coissue = true; text = text.slice(1).trim(); }
        if (text.startsWith('(')) throw new ShaderAsmError('predicated instructions are not supported', line);

        const split = text.search(/\s/);
        const rawMnemonic = split < 0 ? text : text.slice(0, split);
        const operandText = split < 0 ? '' : text.slice(split).trim();
        const operands = operandText.length > 0 ? operandText.split(OPERAND_SPLIT) : [];
        const lower = rawMnemonic.toLowerCase();

        if (lower === 'end') break;

        if (lower === 'dcl' || lower.startsWith('dcl_')) {
            if (operands.length !== 1) throw new ShaderAsmError('dcl takes exactly one register', line);
            tokens.push(...encodeDcl(lower, operands[0], ctx, line));
            continue;
        }

        const mnemonic = parseMnemonic(rawMnemonic, ctx, line);
        checkInstructionAvailability(mnemonic.opcode, ctx, line);

        if (mnemonic.opcode === Op.PHASE) {
            if (operands.length) throw new ShaderAsmError('phase takes no operands', line);
            tokens.push(0xFFFD);
            continue;
        }

        if (mnemonic.opcode === Op.DEF || mnemonic.opcode === Op.DEFI || mnemonic.opcode === Op.DEFB) {
            const valueCount = mnemonic.opcode === Op.DEFB ? 1 : 4;
            if (operands.length !== valueCount + 1) {
                throw new ShaderAsmError(`${lower} takes a register and ${valueCount} value(s)`, line);
            }
            const dest = parseDest(operands[0], ctx, line);
            checkDefDest(mnemonic.opcode, dest, lower, line);
            const payload: number[] = [];
            for (let i = 0; i < valueCount; i++) {
                const raw = operands[i + 1];
                if (mnemonic.opcode === Op.DEF) payload.push(floatBits(parseFloatLiteral(raw, line)));
                else if (mnemonic.opcode === Op.DEFI) payload.push(parseIntLiteral(raw, line) >>> 0);
                else {
                    const lowered = raw.toLowerCase();
                    const value = lowered === 'true' ? 1 : lowered === 'false' ? 0 : parseIntLiteral(raw, line);
                    payload.push(value >>> 0);
                }
            }
            tokens.push(
                instructionToken(mnemonic.opcode, payload.length + 1, ctx),
                encodeDst(dest),
                ...payload,
            );
            continue;
        }

        const hasDst = !NO_DST.has(mnemonic.opcode);
        if (hasDst && operands.length === 0) {
            throw new ShaderAsmError(`${lower} requires a destination register`, line);
        }
        if (!hasDst && (mnemonic.shift !== 0 || mnemonic.saturate)) {
            throw new ShaderAsmError(`${lower} has no destination to modify`, line);
        }

        // A vertex shader has no SUB opcode of its own: D3DX expands `sub a, b`
        // into `add a, -b` (folding an existing sign), and pixel shaders keep
        // their native sub. Assembling it literally would emit an instruction
        // the vertex pipeline never sees from the reference assembler.
        let opcode = mnemonic.opcode;
        let negateSecondSource = false;
        if (opcode === Op.SUB && !ctx.isPixelShader) {
            opcode = Op.ADD;
            negateSecondSource = true;
        }

        const operandTokens: number[] = [];
        let operandCount = 0;
        if (hasDst) {
            const dest = parseDest(operands[0], ctx, line);
            dest.shift = mnemonic.shift;
            dest.saturate = mnemonic.saturate;
            dest.partialPrecision = mnemonic.partialPrecision;
            dest.centroid = mnemonic.centroid;
            operandTokens.push(encodeDst(dest));
            operandCount += 1;
        }
        const sources = operands.slice(hasDst ? 1 : 0);
        for (let s = 0; s < sources.length; s++) {
            const src = parseSource(sources[s], ctx, line);
            if (negateSecondSource && s === 1) {
                const negated = NEGATED_MOD[src.modifier];
                if (negated === undefined) {
                    throw new ShaderAsmError('sub cannot negate this source modifier', line);
                }
                src.modifier = negated;
            }
            operandTokens.push(...encodeSrc(src));
            operandCount += 1;
        }

        checkSm1OperandCount(opcode, operandCount, ctx, line);
        tokens.push(
            instructionToken(opcode, operandTokens.length, ctx, coissue, mnemonic.specificData),
            ...operandTokens,
        );
    }

    tokens.push(END_TOKEN);
    return new Uint32Array(tokens);
}
