/**
 * CTAB — the constant table the HLSL compiler embeds in shader bytecode.
 *
 * `fxc` emits it as a D3DSIO_COMMENT block whose payload starts with the FourCC 'CTAB';
 * `D3DXGetShaderConstantTable` is nothing more than "find that block and describe it".
 * The layout is the one d3dx9shader.h publishes (D3DXSHADER_CONSTANTTABLE and friends),
 * with every offset measured from the START of the table header — not from the comment,
 * and not from the shader.
 *
 * Parsing is pure: no guest memory, no COM. constant-table.ts owns the ABI.
 */

/** D3DSIO_COMMENT. The DWORD count lives in bits 16..30. */
const OP_COMMENT = 0xfffe;
const OP_END = 0xffff;
/** 'CTAB' little-endian. */
const FOURCC_CTAB = 0x42415443;

/** D3DXREGISTER_SET */
export const enum RegisterSet { Bool = 0, Int4 = 1, Float4 = 2, Sampler = 3 }

/** D3DXPARAMETER_CLASS */
export const enum ParameterClass {
    Scalar = 0, Vector = 1, MatrixRows = 2, MatrixColumns = 3, Object = 4, Struct = 5,
}

/** D3DXPARAMETER_TYPE — only the members a constant table can carry are named. */
export const enum ParameterType {
    Void = 0, Bool = 1, Int = 2, Float = 3, String = 4,
    Texture = 5, Texture1D = 6, Texture2D = 7, Texture3D = 8, TextureCube = 9,
    Sampler = 10, Sampler1D = 11, Sampler2D = 12, Sampler3D = 13, SamplerCube = 14,
    PixelShader = 15, VertexShader = 16,
}

export interface CtabStructMember {
    name: string;
    type: CtabType;
}

export interface CtabType {
    class: ParameterClass;
    type: ParameterType;
    rows: number;
    columns: number;
    /** 0 in the file means "not an array"; D3DX reports it as 1. */
    elements: number;
    members: CtabStructMember[];
}

export interface CtabConstant {
    name: string;
    registerSet: RegisterSet;
    registerIndex: number;
    registerCount: number;
    type: CtabType;
    /** Default value bytes, or null when the constant has none. */
    defaultValue: Uint8Array | null;
    /** Where those bytes sit inside {@link CtabTable.raw} — what D3DXCONSTANT_DESC's
     *  `DefaultValue` points at, so the caller need not re-walk the table to find it. */
    defaultValueOffset: number;
}

export interface CtabTable {
    creator: string;
    /** The shader version DWORD: 0xFFFE0300 = vs_3_0, 0xFFFF0200 = ps_2_0, … */
    version: number;
    target: string;
    constants: CtabConstant[];
    /** The raw table bytes, which ID3DXConstantTable::GetBufferPointer hands out verbatim. */
    raw: Uint8Array;
}

/** True when this table belongs to a pixel shader (0xFFFF) rather than a vertex one. */
export function isPixelShaderVersion(version: number): boolean {
    return (version >>> 16) === 0xffff;
}

/**
 * Byte size of one element of `t` as D3DXCONSTANT_DESC.Bytes counts it.
 *
 * Registers are 4 floats wide, but `Bytes` is the size of the DATA, not of the registers
 * it occupies — a float3x3 is 36 bytes even though it costs three registers. Getting this
 * wrong makes SetValue copy the wrong amount, which is silent and looks like bad art.
 */
function elementBytes(t: CtabType): number {
    if (t.class === ParameterClass.Struct) {
        let total = 0;
        for (const m of t.members) total += typeBytes(m.type);
        return total;
    }
    if (t.class === ParameterClass.Object) return 4;
    return t.rows * t.columns * 4;
}

/** Byte size of the whole constant, arrays included. */
export function typeBytes(t: CtabType): number {
    return elementBytes(t) * Math.max(1, t.elements);
}

/** Locate the CTAB comment payload in a shader token stream; null when there is none. */
export function findCtabBytes(tokens: Uint32Array): Uint8Array | null {
    // Token 0 is the version; comments may appear anywhere before END.
    for (let i = 1; i < tokens.length;) {
        const tok = tokens[i]! >>> 0;
        const op = tok & 0xffff;
        if (op === OP_END) break;
        if (op !== OP_COMMENT) {
            // fxc writes CTAB as the first comment, before any instruction, so this walk
            // normally finds it on the first step. Keep going for a hand-assembled shader
            // that orders them differently: the SM2+ length nibble is right often enough
            // to land on the next token boundary, and `1 +` guarantees progress either way.
            i += 1 + ((tok >>> 24) & 0x0f);
            continue;
        }
        const dwords = (tok >>> 16) & 0x7fff;
        if (dwords === 0 || i + 1 + dwords > tokens.length) break;
        if ((tokens[i + 1]! >>> 0) === FOURCC_CTAB) {
            // The table starts AFTER the FourCC and runs to the end of the comment.
            const start = (i + 2) * 4;
            const end = (i + 1 + dwords) * 4;
            const bytes = new Uint8Array(tokens.buffer, tokens.byteOffset + start, end - start);
            return bytes.slice();
        }
        i += 1 + dwords;
    }
    return null;
}

class Reader {
    constructor(private readonly b: Uint8Array, private readonly v: DataView) {}
    static of(b: Uint8Array): Reader {
        return new Reader(b, new DataView(b.buffer, b.byteOffset, b.byteLength));
    }
    u32(off: number): number {
        if (off + 4 > this.b.length) throw new RangeError(`CTAB u32 at ${off} past end (${this.b.length})`);
        return this.v.getUint32(off, true);
    }
    u16(off: number): number {
        if (off + 2 > this.b.length) throw new RangeError(`CTAB u16 at ${off} past end (${this.b.length})`);
        return this.v.getUint16(off, true);
    }
    /** NUL-terminated ASCII at `off`; "" for the null offset D3DX uses to mean "absent". */
    str(off: number): string {
        if (off === 0 || off >= this.b.length) return '';
        let end = off;
        while (end < this.b.length && this.b[end] !== 0) end++;
        let s = '';
        for (let i = off; i < end; i++) s += String.fromCharCode(this.b[i]!);
        return s;
    }
    bytes(off: number, len: number): Uint8Array | null {
        if (off === 0 || len <= 0 || off + len > this.b.length) return null;
        return this.b.slice(off, off + len);
    }
}

/** Struct members read across one table. A corrupt tree is bounded by COUNT, not only depth:
 *  8 levels of a plausible member count is a hang, and every level's reads stay in bounds. */
const MAX_TYPE_NODES = 4096;

function readType(r: Reader, off: number, depth: number, budget: { left: number }): CtabType {
    // D3DXSHADER_TYPEINFO: Class, Type, Rows, Columns, Elements, StructMembers (WORDs),
    // then a DWORD offset to D3DXSHADER_STRUCTMEMBERINFO[].
    const cls = r.u16(off) as ParameterClass;
    const type = r.u16(off + 2) as ParameterType;
    const rows = r.u16(off + 4);
    const columns = r.u16(off + 6);
    const elements = r.u16(off + 8);
    const memberCount = r.u16(off + 10);
    const memberInfo = r.u32(off + 12);

    const members: CtabStructMember[] = [];
    // A struct that contains itself cannot exist in HLSL, but a corrupt offset can claim
    // one — bound the recursion rather than trust the file.
    if (memberCount > 0 && memberInfo !== 0 && depth < 8) {
        for (let i = 0; i < memberCount && budget.left > 0; i++) {
            const e = memberInfo + i * 8;
            budget.left--;
            members.push({ name: r.str(r.u32(e)), type: readType(r, r.u32(e + 4), depth + 1, budget) });
        }
    }
    return { class: cls, type, rows, columns, elements, members };
}

/**
 * Parse a CTAB payload. Returns null when the bytes are not a constant table — a shader
 * with no constants legitimately has none, and that must read as "no table", not as a
 * parse we pretend succeeded.
 */
export function parseCtab(raw: Uint8Array): CtabTable | null {
    if (raw.length < 28) return null;
    const r = Reader.of(raw);
    try {
        const size = r.u32(0);
        if (size < 28) return null;
        const creator = r.str(r.u32(4));
        const version = r.u32(8);
        const count = r.u32(12);
        const infoOff = r.u32(16);
        const target = r.str(r.u32(24));

        // 20-byte D3DXSHADER_CONSTANTINFO each; a count that cannot fit is a bad table.
        if (count > 0 && infoOff + count * 20 > raw.length) return null;

        const constants: CtabConstant[] = [];
        const budget = { left: MAX_TYPE_NODES };
        for (let i = 0; i < count; i++) {
            const e = infoOff + i * 20;
            const type = readType(r, r.u32(e + 12), 0, budget);
            const defaultOff = r.u32(e + 16);
            constants.push({
                name: r.str(r.u32(e)),
                registerSet: r.u16(e + 4) as RegisterSet,
                registerIndex: r.u16(e + 6),
                registerCount: r.u16(e + 8),
                type,
                defaultValue: defaultOff ? r.bytes(defaultOff, typeBytes(type)) : null,
                defaultValueOffset: defaultOff,
            });
        }
        return { creator, version, target, constants, raw };
    } catch {
        return null;
    }
}

/** Find the constant table embedded in shader bytecode, parsed. */
export function parseShaderConstantTable(tokens: Uint32Array): CtabTable | null {
    const raw = findCtabBytes(tokens);
    return raw ? parseCtab(raw) : null;
}
