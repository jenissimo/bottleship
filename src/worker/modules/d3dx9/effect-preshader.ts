/**
 * The PRESHADER an fx_2_0 effect attaches to a state assignment: a small bytecode program that
 * computes the assignment's value from the effect's parameters at apply time.
 *
 * `VertexShader = compile vs_2_0 VS_Array[expr];` compiles to an array selector carrying one of
 * these, so a title that ships shader permutations binds NO shader until the expression is
 * evaluated — the preshader is the pass, not a decoration on it.
 *
 * Container: a version word, then D3DSIO_COMMENT sections — CLIT (double literals), FXLC (the
 * instruction stream) and CTAB (the parameters it reads). Pure: no guest memory, no COM, no
 * device. Nothing here throws; a blob we do not recognise is null and a run we cannot complete
 * is false, with the reason available from {@link lastPreshaderError}.
 */

import {
    EffectParamClass,
    EffectParamType,
    findParameterIndex,
    type EffectModel,
    type EffectParameter,
} from "./effect-state";
import { ParameterClass, parseCtab, type CtabConstant, type CtabType } from "./ctab";

/** Register files, in the order the operand encoding numbers them. */
export const enum PresTable {
    Immed = 0, Const = 1, Input = 2, OConst = 3, OBConst = 4, OIConst = 5, Temp = 6,
}
const TABLE_COUNT = 7;

/** How a table stores a value, which decides the rounding a write through it applies. */
const enum ValueType { Double = 0, Float = 1, Int = 2, Bool = 3 }
const TABLE_TYPE: readonly ValueType[] = [
    ValueType.Double, ValueType.Float, ValueType.Float, ValueType.Float,
    ValueType.Bool, ValueType.Int, ValueType.Float,
];

const TABLE_SYMBOL: readonly string[] = ["imm", "c", "v", "oc", "ob", "oi", "r"];

/** Operand word 0..7 → table; 0 and anything above 7 are not a table we can address. */
const REG_TABLE: readonly number[] = [
    -1, PresTable.Immed, PresTable.Const, PresTable.Input,
    PresTable.OConst, PresTable.OBConst, PresTable.OIConst, PresTable.Temp,
];

/** D3DXRS_* → the table a PRESHADER's own inputs land in (a sampler cannot be one). */
const PRES_REGSET_TABLE: readonly number[] = [PresTable.OBConst, PresTable.OIConst, PresTable.Const, -1];

const FOURCC_CLIT = 0x54494c43;
const FOURCC_FXLC = 0x434c5846;
const FOURCC_CTAB = 0x42415443;
const FOURCC_PRES = 0x53455250;
/** A "tx_1_0" texture shader, the one other blob shape that carries a preshader directly. */
const FOURCC_TX_1 = 0x54580100;
const PRES_SIGN = 0x46580000;

const OP_COMMENT = 0xfffe;
const PRES_OPCODE_MASK = 0x7ff00000;
const PRES_SCALAR_FLAG = 0x80000000;
const PRES_NCOMP_MASK = 0x0000ffff;
const MAX_INPUTS = 8;

interface OpInfo {
    code: number;
    mnem: string;
    /** Operand count; it disambiguates the two opcodes that share a code. */
    inputs: number;
    /** The op consumes every component at once and writes a single one (dot products). */
    allComps: boolean;
}

/** Opcode is (code, input count): 0x70e is two different ops distinguished only by arity. */
const PRES_OPS: readonly OpInfo[] = [
    { code: 0x000, mnem: "nop", inputs: 0, allComps: false },
    { code: 0x100, mnem: "mov", inputs: 1, allComps: false },
    { code: 0x101, mnem: "neg", inputs: 1, allComps: false },
    { code: 0x103, mnem: "rcp", inputs: 1, allComps: false },
    { code: 0x104, mnem: "frc", inputs: 1, allComps: false },
    { code: 0x105, mnem: "exp", inputs: 1, allComps: false },
    { code: 0x106, mnem: "log", inputs: 1, allComps: false },
    { code: 0x107, mnem: "rsq", inputs: 1, allComps: false },
    { code: 0x108, mnem: "sin", inputs: 1, allComps: false },
    { code: 0x109, mnem: "cos", inputs: 1, allComps: false },
    { code: 0x10a, mnem: "asin", inputs: 1, allComps: false },
    { code: 0x10b, mnem: "acos", inputs: 1, allComps: false },
    { code: 0x10c, mnem: "atan", inputs: 1, allComps: false },
    { code: 0x200, mnem: "min", inputs: 2, allComps: false },
    { code: 0x201, mnem: "max", inputs: 2, allComps: false },
    { code: 0x202, mnem: "lt", inputs: 2, allComps: false },
    { code: 0x203, mnem: "ge", inputs: 2, allComps: false },
    { code: 0x204, mnem: "add", inputs: 2, allComps: false },
    { code: 0x205, mnem: "mul", inputs: 2, allComps: false },
    { code: 0x206, mnem: "atan2", inputs: 2, allComps: false },
    { code: 0x208, mnem: "div", inputs: 2, allComps: false },
    { code: 0x300, mnem: "cmp", inputs: 3, allComps: false },
    { code: 0x500, mnem: "dot", inputs: 2, allComps: true },
    { code: 0x70e, mnem: "d3ds_dotswiz", inputs: 6, allComps: false },
    { code: 0x70e, mnem: "d3ds_dotswiz", inputs: 8, allComps: false },
];

const OP_DOTSWIZ6 = 23;
const OP_DOTSWIZ8 = 24;

export interface PreshaderOperand {
    table: PresTable;
    /** COMPONENT offset, not a register index — c3.y is 13, and confusing the two reads whole registers wrong. */
    offset: number;
    /** Table of the relative-addressing register, or -1 for a direct operand. */
    indexTable: number;
    indexOffset: number;
}

export interface PreshaderIns {
    /** Index into {@link PRES_OPS}. */
    op: number;
    mnem: string;
    /** The first input is scalar and its single component is broadcast to the rest. */
    scalarOp: boolean;
    componentCount: number;
    inputs: PreshaderOperand[];
    output: PreshaderOperand;
}

/** One effect parameter the program reads, and where its value has to be staged. */
export interface PreshaderInput {
    name: string;
    table: PresTable;
    registerIndex: number;
    /** Registers the whole binding covers, arrays included. */
    registerCount: number;
    elementCount: number;
    /** The shape the CONSTANT wants, which need not be the shape the parameter has. */
    constantClass: ParameterClass;
    /** The constant's full declared type — a STRUCT input is a tree, not one leaf. */
    type: CtabType;
}

export interface Preshader {
    /** The container's first word, e.g. 0x46580200 ('FX' + version) or FOURCC_TX_1. */
    version: number;
    instructions: PreshaderIns[];
    /** CLIT literals, one entry per COMPONENT; they are doubles, unlike every other table. */
    immediates: Float64Array;
    inputs: PreshaderInput[];
    /** Register (not component) count per table, indexed by {@link PresTable}. */
    tableSizes: number[];
    /**
     * The register files, sized once here so execution allocates nothing. Components, not
     * registers; IMMED arrives pre-filled and the rest are the program's scratch.
     */
    registers: Float64Array[];
}

let lastError: string | null = null;

/** Why the last parse returned null or the last run returned false. */
export function lastPreshaderError(): string | null {
    return lastError;
}

// ── component-vs-register indexing ───────────────────────────────────────────
// Every table but OBCONST is four components wide, so a register index and a component offset
// are different numbers and each has exactly one conversion.

function regComponents(table: number): number {
    return table === PresTable.OBConst ? 1 : 4;
}
function offsetOfReg(table: number, reg: number): number {
    return table === PresTable.OBConst ? reg : reg << 2;
}
function regOfOffset(table: number, offset: number): number {
    return table === PresTable.OBConst ? offset : offset >>> 2;
}

/** C's lrint: round half to even, which is not what Math.round does for a .5 index. */
function lrint(v: number): number {
    const r = Math.round(v);
    return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - Math.sign(v) : r;
}

// ── parsing ──────────────────────────────────────────────────────────────────

interface Section {
    /** Token index of the payload, past the comment token and the FourCC. */
    start: number;
    /** Payload length in tokens. */
    length: number;
}

/** Walk the comment chain from `from`, as d3dx does: it stops at the first non-comment token. */
function findComment(tokens: Uint32Array, from: number, end: number, fourcc: number): Section | null {
    let i = from;
    while (end - i > 2 && (tokens[i]! & 0xffff) === OP_COMMENT) {
        const size = tokens[i]! >>> 16;
        if (!size || i + size + 1 > end) break;
        if (tokens[i + 1]! === fourcc) return { start: i + 2, length: size - 1 };
        i += size + 1;
    }
    return null;
}

function parseReg(tokens: Uint32Array, at: number, into: { table: number; offset: number }): boolean {
    const sel = tokens[at]!;
    const table = sel < REG_TABLE.length ? REG_TABLE[sel]! : -1;
    if (table < 0) {
        lastError = `preshader: unsupported register table ${sel}`;
        return false;
    }
    into.table = table;
    into.offset = tokens[at + 1]!;
    return true;
}

/** Words an operand occupies: 3, or 5 when it carries an index register. */
function argWords(tokens: Uint32Array, at: number): number {
    return tokens[at] ? 5 : 3;
}

function parseArg(tokens: Uint32Array, at: number, left: number, out: PreshaderOperand): boolean {
    if (left < 3 || (tokens[at] && left < 5)) {
        lastError = "preshader: byte code ends inside an operand";
        return false;
    }
    let p = at;
    if (tokens[p]) {
        if (tokens[p] !== 1) {
            lastError = `preshader: unknown relative addressing flag ${tokens[p]!.toString(16)}`;
            return false;
        }
        const idx = { table: -1, offset: 0 };
        if (!parseReg(tokens, p + 1, idx)) return false;
        out.indexTable = idx.table;
        out.indexOffset = idx.offset;
        p += 3;
    } else {
        out.indexTable = -1;
        out.indexOffset = 0;
        p += 1;
    }
    const reg = { table: -1, offset: 0 };
    if (!parseReg(tokens, p, reg)) return false;
    out.table = reg.table as PresTable;
    // A bool operand's offset is spelled in float-register components even though the table is one wide.
    out.offset = reg.table === PresTable.OBConst ? reg.offset >>> 2 : reg.offset;
    return true;
}

function emptyOperand(): PreshaderOperand {
    return { table: PresTable.Temp, offset: 0, indexTable: -1, indexOffset: 0 };
}

/** Returns the token count consumed, or -1 on a refusal. */
function parseIns(tokens: Uint32Array, at: number, left: number, ins: PreshaderIns): number {
    if (left < 2) {
        lastError = "preshader: byte code ends inside an instruction";
        return -1;
    }
    const raw = tokens[at]!;
    const code = (raw & PRES_OPCODE_MASK) >>> 20;
    ins.componentCount = raw & PRES_NCOMP_MASK;
    ins.scalarOp = (raw & PRES_SCALAR_FLAG) !== 0;
    if (ins.componentCount < 1 || ins.componentCount > 4) {
        lastError = `preshader: unsupported component count ${ins.componentCount}`;
        return -1;
    }
    const inputCount = tokens[at + 1]!;
    let op = -1;
    for (let i = 0; i < PRES_OPS.length; i++) {
        if (PRES_OPS[i]!.code === code && PRES_OPS[i]!.inputs === inputCount) { op = i; break; }
    }
    if (op < 0) {
        lastError = `preshader: unknown opcode ${code.toString(16)} with ${inputCount} inputs`;
        return -1;
    }
    if (inputCount > MAX_INPUTS) {
        lastError = `preshader: ${PRES_OPS[op]!.mnem} has ${inputCount} inputs`;
        return -1;
    }
    ins.op = op;
    ins.mnem = PRES_OPS[op]!.mnem;

    let p = at + 2;
    let rest = left - 2;
    ins.inputs = [];
    for (let i = 0; i < inputCount; i++) {
        const operand = emptyOperand();
        if (!parseArg(tokens, p, rest, operand)) return -1;
        const used = argWords(tokens, p);
        p += used;
        rest -= used;
        ins.inputs.push(operand);
    }
    if (!parseArg(tokens, p, rest, ins.output)) return -1;
    if (ins.output.indexTable >= 0) {
        lastError = "preshader: relative addressing in an output register";
        return -1;
    }
    const spanEnd = ins.output.offset + (PRES_OPS[op]!.allComps ? 0 : ins.componentCount - 1);
    if (regOfOffset(ins.output.table, spanEnd) !== regOfOffset(ins.output.table, ins.output.offset)) {
        lastError = `preshader: ${ins.mnem} writes across two registers`;
        return -1;
    }
    return p + argWords(tokens, p) - at;
}

function collectInputs(constants: readonly CtabConstant[]): PreshaderInput[] | null {
    const inputs: PreshaderInput[] = [];
    for (const c of constants) {
        const table = c.registerSet < PRES_REGSET_TABLE.length ? PRES_REGSET_TABLE[c.registerSet]! : -1;
        if (table < 0) {
            lastError = `preshader: input ${c.name} uses register set ${c.registerSet}`;
            return null;
        }
        inputs.push({
            name: c.name,
            table: table as PresTable,
            registerIndex: c.registerIndex,
            registerCount: c.registerCount,
            elementCount: Math.max(1, c.type.elements),
            constantClass: c.type.class,
            type: c.type,
        });
    }
    return inputs;
}

function growTable(sizes: number[], table: number, maxRegister: number): void {
    if (table >= 0 && table < TABLE_COUNT) sizes[table] = Math.max(sizes[table]!, maxRegister + 1);
}

/**
 * Parse a preshader blob. Accepts both shapes an effect object carries: the bare blob an array
 * selector holds, and shader bytecode with a PRES comment embedded in it.
 */
export function parsePreshader(bytes: Uint8Array): Preshader | null {
    lastError = null;
    try {
        if (bytes.length < 8) {
            lastError = "preshader: blob too short";
            return null;
        }
        const copy = bytes.slice(0, bytes.length & ~3);
        const tokens = new Uint32Array(copy.buffer, 0, copy.length >>> 2);
        const version = tokens[0]!;

        let base: number;
        let end: number;
        if (((version & 0xfffe0000) >>> 0) === 0xfffe0000) {
            const pres = findComment(tokens, 1, tokens.length, FOURCC_PRES);
            if (!pres) {
                lastError = "preshader: shader carries no PRES comment";
                return null;
            }
            base = pres.start;
            end = pres.start + pres.length;
        } else if (((version & 0xffff0000) >>> 0) === PRES_SIGN || version === FOURCC_TX_1) {
            base = 0;
            end = tokens.length;
        } else {
            lastError = `preshader: unrecognised magic ${version.toString(16)}`;
            return null;
        }

        // Every section sits in the comment chain that follows the version word.
        const clit = findComment(tokens, base + 1, end, FOURCC_CLIT);
        let constCount = 0;
        if (clit) {
            constCount = tokens[clit.start]!;
            if (constCount > (clit.length - 1) >>> 1) {
                lastError = "preshader: CLIT count overruns its section";
                return null;
            }
            if (constCount % regComponents(PresTable.Immed)) {
                lastError = `preshader: CLIT count ${constCount} is not a whole number of registers`;
                return null;
            }
        }
        const immediates = new Float64Array(constCount);
        if (clit && constCount) {
            const view = new DataView(copy.buffer);
            for (let i = 0; i < constCount; i++) {
                immediates[i] = view.getFloat64((clit.start + 1) * 4 + i * 8, true);
            }
        }

        const fxlc = findComment(tokens, base + 1, end, FOURCC_FXLC);
        if (!fxlc) {
            lastError = "preshader: no FXLC section";
            return null;
        }
        const insCount = tokens[fxlc.start]!;
        const instructions: PreshaderIns[] = [];
        let p = fxlc.start + 1;
        let rest = fxlc.length - 1;
        for (let i = 0; i < insCount; i++) {
            const ins: PreshaderIns = {
                op: 0, mnem: "nop", scalarOp: false, componentCount: 1,
                inputs: [], output: emptyOperand(),
            };
            const used = parseIns(tokens, p, rest, ins);
            if (used < 0) return null;
            p += used;
            rest -= used;
            instructions.push(ins);
        }

        // d3dx finds the preshader's own CTAB by pretending the version word is a comment header;
        // walking from the next token reaches the same section without editing the blob.
        const ctabSection = findComment(tokens, base + 1, end, FOURCC_CTAB);
        let inputs: PreshaderInput[] = [];
        if (ctabSection) {
            const raw = copy.slice(ctabSection.start * 4, (ctabSection.start + ctabSection.length) * 4);
            const table = parseCtab(raw);
            // A preshader with no readable constant table is legal; it just reads nothing.
            if (table) {
                const collected = collectInputs(table.constants);
                if (!collected) return null;
                inputs = collected;
            }
        }

        const tableSizes: number[] = new Array(TABLE_COUNT).fill(0);
        tableSizes[PresTable.Immed] = regOfOffset(PresTable.Immed, constCount);
        // A texture shader is handed position and psize in v0/v1 before it runs.
        if (version === FOURCC_TX_1) tableSizes[PresTable.Input] = 2;
        for (const inp of inputs) {
            if (inp.registerCount) growTable(tableSizes, inp.table, inp.registerIndex + inp.registerCount - 1);
        }

        for (const ins of instructions) {
            for (let j = 0; j < PRES_OPS[ins.op]!.inputs; j++) {
                const arg = ins.inputs[j]!;
                let table: number;
                let reg: number;
                if (arg.indexTable < 0) {
                    const last = ins.scalarOp && j === 0 ? 0 : ins.componentCount - 1;
                    table = arg.table;
                    reg = regOfOffset(table, arg.offset + last);
                } else {
                    table = arg.indexTable;
                    reg = regOfOffset(table, arg.indexOffset);
                }
                if (reg >= tableSizes[table]!) {
                    lastError = `preshader: ${ins.mnem} reads ${TABLE_SYMBOL[table]}${reg} past the end of its table`;
                    return null;
                }
            }
            growTable(tableSizes, ins.output.table, regOfOffset(ins.output.table, ins.output.offset));
        }

        const registers: Float64Array[] = [];
        for (let t = 0; t < TABLE_COUNT; t++) registers.push(new Float64Array(offsetOfReg(t, tableSizes[t]!)));
        registers[PresTable.Immed]!.set(immediates.subarray(0, registers[PresTable.Immed]!.length));

        return { version, instructions, immediates, inputs, tableSizes, registers };
    } catch (e) {
        lastError = `preshader: ${e instanceof Error ? e.message : String(e)}`;
        return null;
    }
}

// ── staging the input parameters ─────────────────────────────────────────────

/** Read component `i` of a parameter's value block as a double, per the parameter's own type. */
function paramComponent(param: EffectParameter, view: DataView, i: number): number {
    const at = i * 4;
    if (at + 4 > view.byteLength) return 0;
    switch (param.type) {
        case EffectParamType.Float:
        case EffectParamType.Void:
            return view.getFloat32(at, true);
        case EffectParamType.Int:
            return view.getInt32(at, true);
        case EffectParamType.Bool:
            return view.getInt32(at, true) !== 0 ? 1 : 0;
        default:
            return 0;
    }
}

/** Stage a value in a table, rounding the way that table's storage does. */
function storeConstant(file: Float64Array, offset: number, table: number, v: number): boolean {
    if (offset < 0 || offset >= file.length) {
        lastError = `preshader: register component ${offset} is outside the ${file.length}-component table`;
        return false;
    }
    switch (TABLE_TYPE[table]) {
        // The staging path truncates toward zero; the EXECUTION path rounds. They are not the same write.
        case ValueType.Int: file[offset] = Math.trunc(v); break;
        case ValueType.Bool: file[offset] = v !== 0 ? 1 : 0; break;
        case ValueType.Float: file[offset] = Math.fround(v); break;
        default: file[offset] = v; break;
    }
    return true;
}

/**
 * One LEAF constant (scalar, vector or matrix) staged into its register range.
 *
 * Split out of setInput because a STRUCT constant is not a leaf: d3dx recurses into its
 * members and uploads each of those, and the recursion needs to name the register range per
 * member rather than per input.
 */
function setLeaf(
    pres: Preshader,
    inp: PreshaderInput,
    registerIndex: number,
    registerCount: number,
    elementCount: number,
    constantClass: ParameterClass,
    param: EffectParameter,
): boolean {
    const file = pres.registers[inp.table]!;
    const view = new DataView(param.value.buffer, param.value.byteOffset, param.value.byteLength);
    const components = regComponents(inp.table);
    const start = offsetOfReg(inp.table, registerIndex);

    if (constantClass === ParameterClass.Scalar || constantClass === ParameterClass.Vector) {
        const count = Math.max(param.rows, param.columns);
        if (count >= components) {
            for (let i = 0; i < count * elementCount; i++) {
                if (!storeConstant(file, start + i, inp.table, paramComponent(param, view, i))) return false;
            }
        } else {
            for (let e = 0; e < elementCount; e++) {
                const dst = start + offsetOfReg(inp.table, e);
                for (let i = 0; i < count; i++) {
                    if (!storeConstant(file, dst + i, inp.table, paramComponent(param, view, e * count + i))) return false;
                }
            }
        }
        return true;
    }

    if (constantClass !== ParameterClass.MatrixRows && constantClass !== ParameterClass.MatrixColumns) {
        lastError = `preshader: input ${inp.name} has unsupported constant class ${constantClass}`;
        return false;
    }

    const columnMajorConst = constantClass === ParameterClass.MatrixColumns;
    const transpose = columnMajorConst
        ? param.paramClass === EffectParamClass.MatrixRows
        : param.paramClass === EffectParamClass.MatrixColumns;
    const major = columnMajorConst ? param.columns : param.rows;
    const minor = columnMajorConst ? param.rows : param.columns;
    if (!major || !minor) return true;

    const perElement = Math.max(1, Math.floor(registerCount / elementCount));
    let majorStride: number;
    let majorCount: number;
    let minorRemainder: number;
    if (components === 1) {
        const length = offsetOfReg(inp.table, perElement);
        majorStride = minor;
        majorCount = Math.floor(length / majorStride);
        minorRemainder = length % majorStride;
    } else {
        majorStride = components;
        majorCount = perElement;
        minorRemainder = 0;
    }

    let dst = start;
    let src = 0;
    for (let e = 0; e < elementCount; e++) {
        if (transpose) {
            for (let i = 0; i < majorCount; i++) {
                for (let j = 0; j < minor; j++) {
                    const v = paramComponent(param, view, src + i + j * major);
                    if (!storeConstant(file, dst + i * majorStride + j, inp.table, v)) return false;
                }
            }
            for (let j = 0; j < minorRemainder; j++) {
                const v = paramComponent(param, view, src + majorCount + j * major);
                if (!storeConstant(file, dst + majorCount * majorStride + j, inp.table, v)) return false;
            }
        } else {
            for (let i = 0; i < majorCount; i++) {
                for (let j = 0; j < minor; j++) {
                    const v = paramComponent(param, view, src + i * minor + j);
                    if (!storeConstant(file, dst + i * majorStride + j, inp.table, v)) return false;
                }
            }
        }
        dst += offsetOfReg(inp.table, perElement);
        src += param.rows * param.columns;
    }
    return true;
}


/**
 * Registers one constant occupies, by the rule d3dx lays constants out with
 * (parse_ctab_constant_type, Wine dlls/d3dx9_36/shader.c): a struct or array is the sum of
 * what its members/elements take, and a leaf depends on its class and register file.
 */
function registerCountOfType(type: CtabType, table: PresTable): number {
    const elements = Math.max(1, type.elements);
    if (type.class === ParameterClass.Struct && type.members.length) {
        let size = 0;
        for (const m of type.members) size += registerCountOfType(m.type, table);
        return size * elements;
    }
    if (TABLE_TYPE[table] === ValueType.Bool) return type.rows * type.columns * elements;
    switch (type.class) {
        case ParameterClass.Vector: return elements;
        case ParameterClass.MatrixRows: return type.rows * elements;
        case ParameterClass.MatrixColumns: return type.columns * elements;
        case ParameterClass.Object: return elements;
        default: return type.rows * type.columns * elements;
    }
}

/**
 * Stage one effect parameter into the preshader's register file.
 *
 * A constant is a TREE: d3dx walks a struct's members and an array's elements and uploads only
 * the leaves, each at its own register offset (init_set_constants_param, Wine
 * dlls/d3dx9_36/preshader.c). Refusing a struct outright loses the whole expression — and when
 * that expression picks which shader of an array a pass uses, the pass binds NO shader and the
 * draw silently falls back to the fixed function.
 */
function setInput(pres: Preshader, inp: PreshaderInput, param: EffectParameter): boolean {
    // The register file is sized from the constant's DECLARED registerCount, and d3dx clamps
    // every sub-constant to that same bound — `RegisterCount = max(0, min(max_index - index,
    // size))` (parse_ctab_constant_type). A struct declared wider than the shader actually uses
    // therefore has trailing members with zero registers, which d3dx skips rather than writes.
    const maxRegister = inp.registerIndex + inp.registerCount;
    return setConstantTree(pres, inp, inp.registerIndex, maxRegister, inp.type, param);
}

function setConstantTree(
    pres: Preshader,
    inp: PreshaderInput,
    registerIndex: number,
    maxRegister: number,
    type: CtabType,
    param: EffectParameter,
): boolean {
    // Past the declared extent this constant contributes nothing; d3dx skips it.
    if (registerIndex >= maxRegister) return true;
    const isStruct = type.class === ParameterClass.Struct && type.members.length > 0;
    if (!isStruct) {
        const count = Math.min(registerCountOfType(type, inp.table), maxRegister - registerIndex);
        if (count <= 0) return true;
        return setLeaf(pres, inp, registerIndex, count,
            Math.max(1, type.elements), type.class, param);
    }

    // An ARRAY of structs: each element repeats the whole member layout.
    const elements = Math.max(1, type.elements);
    const perElement = registerCountOfType({ ...type, elements: 1 }, inp.table);
    const elementParams: EffectParameter[] = elements > 1
        ? (param.elementsList ?? param.members)
        : [param];
    for (let e = 0; e < elements; e++) {
        const elementParam = elements > 1 ? elementParams[e] : param;
        if (!elementParam) {
            lastError = `preshader: input ${inp.name} element ${e} has no parameter`;
            return false;
        }
        let reg = registerIndex + e * perElement;
        for (let i = 0; i < type.members.length; i++) {
            const member = type.members[i]!;
            const memberParam = elementParam.members[i];
            if (!memberParam) {
                // d3dx refuses the whole evaluation when the shapes disagree
                // ("Number of elements or struct members differs"); a silently skipped member
                // would leave a stale register feeding the expression.
                lastError = `preshader: input ${inp.name} struct member ${member.name} has no parameter`;
                return false;
            }
            if (!setConstantTree(pres, inp, reg, maxRegister, member.type, memberParam)) return false;
            reg += registerCountOfType(member.type, inp.table);
        }
    }
    return true;
}

// ── execution ────────────────────────────────────────────────────────────────

function readReg(pres: Preshader, table: number, offset: number): number {
    // Only the float and double tables can be read back; d3dx has no conversion for the others.
    const type = TABLE_TYPE[table];
    if (type !== ValueType.Float && type !== ValueType.Double) return NaN;
    const file = pres.registers[table]!;
    return offset < file.length ? file[offset]! : 0;
}

function getArg(pres: Preshader, opr: PreshaderOperand, comp: number): number {
    const table = opr.table;
    const base = opr.indexTable < 0 ? 0 : lrint(readReg(pres, opr.indexTable, opr.indexOffset));
    let offset = offsetOfReg(table, base) + opr.offset + comp;
    let reg = regOfOffset(table, offset);
    const size = pres.tableSizes[table]!;

    if (reg >= size) {
        let wrap: number;
        if (table === PresTable.Const) {
            // The float constant file wraps to the next power of two, not to its actual size.
            wrap = 1;
            while (wrap < size) wrap <<= 1;
        } else {
            wrap = size;
        }
        if (!wrap) return 0;
        reg %= wrap;
        if (reg >= size) return 0;
        offset = offsetOfReg(table, reg) + (offset % regComponents(table));
    }
    return readReg(pres, table, offset);
}

function setArg(pres: Preshader, opr: PreshaderOperand, comp: number, v: number): boolean {
    const file = pres.registers[opr.table]!;
    const offset = opr.offset + comp;
    if (offset < 0 || offset >= file.length) {
        lastError = `preshader: write to ${TABLE_SYMBOL[opr.table]}${regOfOffset(opr.table, offset)} past the end of its table`;
        return false;
    }
    switch (TABLE_TYPE[opr.table]) {
        case ValueType.Int: file[offset] = lrint(v); break;
        case ValueType.Bool: file[offset] = v !== 0 ? 1 : 0; break;
        case ValueType.Float: file[offset] = Math.fround(v); break;
        default: file[offset] = v; break;
    }
    return true;
}

function applyOp(op: number, args: Float64Array, n: number): number {
    switch (op) {
        case 1: return args[0]!;
        case 2: return -args[0]!;
        case 3: return 1.0 / args[0]!;
        case 4: return args[0]! - Math.floor(args[0]!);
        case 5: return Math.pow(2.0, args[0]!);
        case 6: { const v = Math.abs(args[0]!); return v === 0 ? 0 : Math.log2(v); }
        case 7: { const v = Math.abs(args[0]!); return v === 0 ? Infinity : 1.0 / Math.sqrt(v); }
        case 8: return Math.sin(args[0]!);
        case 9: return Math.cos(args[0]!);
        case 10: return Math.asin(args[0]!);
        case 11: return Math.acos(args[0]!);
        case 12: return Math.atan(args[0]!);
        case 13: return Math.min(args[0]!, args[1]!);
        case 14: return Math.max(args[0]!, args[1]!);
        case 15: return args[0]! < args[1]! ? 1.0 : 0.0;
        case 16: return args[0]! >= args[1]! ? 1.0 : 0.0;
        case 17: return args[0]! + args[1]!;
        case 18: return args[0]! * args[1]!;
        case 19: return Math.atan2(args[0]!, args[1]!);
        // Native d3dx never emits 'div' (it uses rcp+mul) and answers 0 when one is present.
        case 20: return 0.0;
        case 21: return args[0]! >= 0.0 ? args[1]! : args[2]!;
        case 22: return dot(args, n);
        case OP_DOTSWIZ6: return dot(args, 3);
        case OP_DOTSWIZ8: return dot(args, 4);
        default: return 0.0;
    }
}

function dot(args: Float64Array, n: number): number {
    let sum = 0.0;
    for (let i = 0; i < n; i++) sum += args[i]! * args[i + n]!;
    return sum;
}

/** One scratch array for the whole module: execution must not allocate per instruction. */
const argScratch = new Float64Array(MAX_INPUTS);
const indexScratch = new Float32Array(1);

/**
 * Run `pres` over `params` and write its OCONST result into `out`. False when an input
 * parameter is missing, a constant has a shape we cannot stage, or a register index lands
 * outside its file; {@link lastPreshaderError} names which.
 */
export function evaluatePreshader(
    pres: Preshader,
    params: readonly EffectParameter[],
    out: Float32Array,
): boolean {
    lastError = null;
    try {
        const model: EffectModel = { creator: "", parameters: params as EffectParameter[], techniques: [], objects: [] };
        for (const inp of pres.inputs) {
            const index = findParameterIndex(model, inp.name);
            if (index < 0) {
                lastError = `preshader: input parameter "${inp.name}" not found`;
                return false;
            }
            if (!setInput(pres, inp, params[index]!)) {
                if (!lastError) lastError = `preshader: could not stage input "${inp.name}"`;
                return false;
            }
        }

        for (const ins of pres.instructions) {
            const info = PRES_OPS[ins.op]!;
            if (info.allComps) {
                if (info.inputs * ins.componentCount > MAX_INPUTS) {
                    lastError = `preshader: ${ins.mnem} needs ${info.inputs * ins.componentCount} arguments`;
                    return false;
                }
                for (let k = 0; k < info.inputs; k++) {
                    for (let j = 0; j < ins.componentCount; j++) {
                        argScratch[k * ins.componentCount + j] =
                            getArg(pres, ins.inputs[k]!, ins.scalarOp && k === 0 ? 0 : j);
                    }
                }
                if (!setArg(pres, ins.output, 0, applyOp(ins.op, argScratch, ins.componentCount))) return false;
            } else {
                for (let j = 0; j < ins.componentCount; j++) {
                    for (let k = 0; k < info.inputs; k++) {
                        argScratch[k] = getArg(pres, ins.inputs[k]!, ins.scalarOp && k === 0 ? 0 : j);
                    }
                    if (!setArg(pres, ins.output, j, applyOp(ins.op, argScratch, ins.componentCount))) return false;
                }
            }
        }

        const oc = pres.registers[PresTable.OConst]!;
        const n = Math.min(out.length, oc.length);
        for (let i = 0; i < n; i++) out[i] = Math.fround(oc[i]!);
        return true;
    } catch (e) {
        lastError = `preshader: ${e instanceof Error ? e.message : String(e)}`;
        return false;
    }
}

/**
 * Evaluate an array selector's index. Null when the program could not be run or produced no
 * usable number; the caller still has to range-check against the array it is selecting from.
 */
export function evaluateIndex(pres: Preshader, params: readonly EffectParameter[]): number | null {
    indexScratch[0] = 0;
    if (!evaluatePreshader(pres, params, indexScratch)) return null;
    const v = indexScratch[0]!;
    if (!Number.isFinite(v)) {
        lastError = `preshader: index evaluated to ${v}`;
        return null;
    }
    const index = (Math.trunc(v) | 0) >>> 0;
    // d3dx treats an index of -1 as element 0 rather than an error; apps rely on it.
    return index === 0xffffffff ? 0 : index;
}
