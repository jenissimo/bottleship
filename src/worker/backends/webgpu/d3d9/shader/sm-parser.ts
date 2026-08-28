/**
 * sm-parser.ts — Direct3D 9 shader bytecode (DXSO) → typed IR.
 *
 * Decodes the DWORD token stream produced by D3DXAssembleShader / fxc into a
 * structured program. Handles both vertex and pixel shaders, SM1.x (no length
 * field — walked via the fixed operand table) and SM2/3 (length field in token).
 *
 * The register-type field is split across two bit-fields per the D3D9 ABI:
 *   regType = ((token >> 28) & 0x7) | (((token >> 11) & 0x3) << 3)
 * (bits 28-30 are the LOW three bits, bits 11-12 the HIGH two). Getting this
 * wrong silently remaps every register class — see d3d9types.h D3DSP_REGTYPE_*.
 */

import {
    Op, RegType, DEFAULT_LEN, NO_DST, opName, cmpOpFromCode,
    type CmpOp,
} from "./sm-enums";

// ── IR types ──────────────────────────────────────────────────────────────────

export interface SmRegister {
    type: RegType;
    num: number;
    /** Constant-relative addressing (c[a0.x + num]) — SM1.x implies a0. */
    relative: boolean;
}

export interface SmDest {
    reg: SmRegister;
    writeMask: number;      // bit0=x … bit3=w
    shift: number;          // signed result shift: +1=_x2 … -3=_d8
    saturate: boolean;      // _sat
    partialPrecision: boolean;  // _pp
    centroid: boolean;          // _centroid
    /** SM3 destination-relative addressing index register (the extra token). */
    relReg?: SmRegister;
    /** Swizzle encoded in the SM3 destination-relative token. */
    relSwizzle?: number;
}

export interface SmSource {
    reg: SmRegister;
    swizzle: number;        // 8 bits, 2 per component
    modifier: number;       // SrcMod
    /**
     * SM2+ relative addressing carries the index register in a SECOND token
     * (SM1.x implies a0.x and has none). Kept so a disassembler can name the
     * actual register/component instead of assuming a0.
     */
    relReg?: SmRegister;
    relSwizzle?: number;
}

export interface SmInstruction {
    opcode: Op;
    coissue: boolean;       // "+" co-issued (ps_1_x .rgb/.a pairing)
    predicated: boolean;    // (p0) predicate prefix
    specificData: number;   // bits 16-23 (comparison / texld mode)
    /** Typed comparison carried by IFC, BREAKC and SETP; raw specificData is retained. */
    comparison?: CmpOp;
    /** Predicate source token, consumed immediately after dst (and dst-relative token). */
    predicate?: SmSource;
    dst: SmDest | null;
    src: SmSource[];
}

export interface SmDcl {
    usage: number;
    usageIndex: number;
    textureType: number;
    reg: SmRegister;
    /** The declared register's write mask — a partial dcl (`dcl_texcoord1 v3.xy`) is legal. */
    writeMask: number;
    /** Pixel-stage centroid interpolation qualifier carried by the register token. */
    centroid: boolean;
}

/** Parser/emitter capability shared with D3D9 caps advertising. */
export function supportsShaderPredication(major: number): boolean {
    return major >= 2;
}

export interface SmDef {
    reg: SmRegister;
    values: Float32Array;   // 4 floats (int defs reinterpreted as float bits → use rawInt)
    rawInt: Int32Array;     // 4 ints (for defi/defb)
    kind: "f" | "i" | "b";
}

/**
 * The program in SOURCE ORDER. `declarations`/`definitions`/`instructions` are
 * the code generators' view (grouped, order irrelevant); a disassembler needs
 * the original interleaving, so the walk records it here as it goes.
 */
export type SmStreamItem =
    | { kind: "instruction"; instruction: SmInstruction }
    | { kind: "dcl"; dcl: SmDcl }
    | { kind: "def"; def: SmDef }
    | { kind: "phase" };

export interface SmProgram {
    isPixelShader: boolean;
    major: number;
    minor: number;
    instructions: SmInstruction[];
    declarations: SmDcl[];
    definitions: SmDef[];
    /** Highest temp register index referenced (-1 if none). */
    maxTemp: number;
    /** Highest float-constant register index referenced (-1 if none). */
    maxConst: number;
    /** Highest boolean-constant register index referenced (-1 if none). */
    maxBool: number;
    /** Texture/sampler stages referenced (PS) or input regs (VS). */
    samplersUsed: Set<number>;
    inputRegs: Set<number>;
    /** True if any constant source uses relative (a0) addressing. */
    usesRelativeConst: boolean;
    /** Everything above, in bytecode order. */
    stream: SmStreamItem[];
    /** DWORDs consumed, including the version token and the trailing END. */
    tokenCount: number;
    /** False if the stream ran out before an END token — i.e. truncated input. */
    terminated: boolean;
}

/**
 * A bytecode stream is guest input, not a trusted compiler buffer.  Keep
 * malformed/truncated streams distinguishable from valid-but-unsupported
 * instructions so shader creation can fail before an emitter starts reading
 * undefined DWORDs.  `terminated === false` remains available to the SWVP
 * caller (which uses it for an atomic refusal), while the link/compiler entry
 * points reject that program explicitly.
 */
export class ShaderParseError extends Error {
    constructor(
        readonly code: "truncated" | "invalid-length" | "unknown-opcode" | "invalid-register" | "unsupported-version",
        readonly offset: number,
        message: string,
    ) {
        super(message);
        this.name = "ShaderParseError";
    }
}

/**
 * SM2/3 instruction tokens carry a caller-provided length nibble.  That nibble
 * is not a trust boundary: an unknown opcode or an operand block with a
 * missing source must be rejected before the emitter sees a partial IR.  Keep
 * the small fixed arity table here (variable-arity legacy texture/control
 * instructions are intentionally validated by their dedicated emitters).
 */
const REQUIRED_SOURCES: Readonly<Partial<Record<number, number>>> = {
    [Op.NOP]: 0, [Op.MOV]: 1, [Op.ADD]: 2, [Op.SUB]: 2, [Op.MAD]: 3, [Op.MUL]: 2,
    [Op.RCP]: 1, [Op.RSQ]: 1, [Op.DP3]: 2, [Op.DP4]: 2, [Op.MIN]: 2, [Op.MAX]: 2,
    [Op.SLT]: 2, [Op.SGE]: 2, [Op.EXP]: 1, [Op.LOG]: 1, [Op.LIT]: 1, [Op.DST]: 2,
    [Op.LRP]: 3, [Op.FRC]: 1, [Op.M4x4]: 2, [Op.M4x3]: 2, [Op.M3x4]: 2,
    [Op.M3x3]: 2, [Op.M3x2]: 2, [Op.CALL]: 1, [Op.CALLNZ]: 2, [Op.LOOP]: 2,
    [Op.RET]: 0, [Op.ENDLOOP]: 0, [Op.LABEL]: 1, [Op.POW]: 2, [Op.CRS]: 2,
    [Op.ABS]: 1, [Op.NRM]: 1, [Op.REP]: 1, [Op.ENDREP]: 0, [Op.IF]: 1,
    [Op.IFC]: 2, [Op.ELSE]: 0, [Op.ENDIF]: 0, [Op.BREAK]: 0, [Op.BREAKC]: 2,
    [Op.MOVA]: 1, [Op.DEFB]: 1, [Op.DEFI]: 4, [Op.TEXKILL]: 0,
    [Op.TEXDEPTH]: 0, [Op.EXPP]: 1, [Op.LOGP]: 1, [Op.CND]: 3, [Op.TEXREG2AR]: 1,
    [Op.TEXREG2GB]: 1, [Op.TEXREG2RGB]: 1, [Op.TEXM3x2PAD]: 1, [Op.TEXM3x2TEX]: 1,
    [Op.TEXM3x3PAD]: 1, [Op.TEXM3x3TEX]: 1, [Op.TEXM3x3SPEC]: 2,
    [Op.TEXM3x3VSPEC]: 1, [Op.TEXDP3TEX]: 1, [Op.TEXM3x2DEPTH]: 1,
    [Op.TEXDP3]: 1, [Op.TEXM3x3]: 1, [Op.CMP]: 3, [Op.BEM]: 2, [Op.DP2ADD]: 3,
    [Op.TEXCOORD]: 1, [Op.TEX]: 2,
    [Op.TEXBEM]: 1, [Op.TEXBEML]: 1, [Op.TEXLDD]: 4, [Op.TEXLDL]: 2,
    [Op.DSX]: 1, [Op.DSY]: 1, [Op.SETP]: 2, [Op.BREAKP]: 1,
};

/**
 * SINCOS and SGN are the two opcodes whose arity is a function of the shader
 * model: vs_2_0/ps_2_0/ps_2_x require two extra scratch/constant sources
 * (`sincos dst, src0, src1, src2`), which SM3 dropped.  DEFAULT_LEN carries the
 * matching SM2 token length.
 */
function requiredSourceCount(opcode: Op, major: number): number | undefined {
    if (opcode === Op.SINCOS || opcode === Op.SGN) return major === 2 ? 3 : 1;
    return REQUIRED_SOURCES[opcode];
}

function validateRegister(programIsPixel: boolean, major: number, reg: SmRegister, offset: number): void {
    const reject = (message: string): never => {
        throw new ShaderParseError("invalid-register", offset, message);
    };

    // These bounds are part of the SM2/SM3 token contract, independent of the
    // current emitter.  Letting an out-of-range register through is dangerous:
    // the backend's robust array fallback can turn malformed bytecode into a
    // valid shader which reads/writes a different register than the guest did.
    switch (reg.type) {
        case RegType.TEMP:
            if (reg.num > 31) reject(`temporary register r${reg.num} exceeds the 32-register SM3 limit`);
            break;
        case RegType.INPUT:
            if (reg.num > 15) reject(`input register v${reg.num} is outside the D3D9 vertex-input range`);
            break;
        case RegType.CONST:
            if (reg.num > (programIsPixel ? 223 : 255)) {
                reject(`${programIsPixel ? "pixel" : "vertex"} constant c${reg.num} is outside the register file`);
            }
            break;
        case RegType.CONSTINT:
        case RegType.CONSTBOOL:
            if (reg.num > 15) reject(`constant register ${reg.type === RegType.CONSTINT ? "i" : "b"}${reg.num} exceeds the 16-register limit`);
            break;
        case RegType.SAMPLER:
            if (reg.num > 15) reject(`sampler s${reg.num} is outside the D3D9 s0-s15 range`);
            break;
        case RegType.PREDICATE:
            if (reg.num !== 0) reject(`predicate register p${reg.num} is invalid; D3D9 exposes only p0`);
            break;
        case RegType.MISCTYPE:
            // vPos/vFace are pixel-shader 3.0 inputs only.  The same numeric
            // register class is invalid in vertex shaders, in ps_1/2, and for
            // any index beyond the two D3D9-defined values.  Do this in the
            // parser instead of letting emitters silently substitute zero.
            if (!programIsPixel) reject(`miscellaneous register vMisc${reg.num} is invalid in a vertex shader`);
            if (major < 3) reject(`miscellaneous register vMisc${reg.num} requires a pixel shader 3.0 stream`);
            if (reg.num > 1) reject(`pixel miscellaneous register vMisc${reg.num} is outside the vPos/vFace range`);
            break;
        case RegType.ADDR:
            // RegType.ADDR and RegType.TEXTURE share the bytecode value 3;
            // decode it as t# in PS and a0 in VS.
            if (programIsPixel) {
                if (reg.num > 15) reject(`texture register t${reg.num} is outside the D3D9 t0-t15 range`);
            } else if (reg.num !== 0) {
                reject(`address register a${reg.num} is not valid for a vertex shader`);
            }
            break;
        case RegType.LOOP:
            if (reg.num !== 0) reject(`loop register aL${reg.num} is invalid; D3D9 exposes only aL`);
            break;
        case RegType.COLOROUT:
            if (!programIsPixel) reject(`pixel color output oC${reg.num} is invalid in a vertex shader`);
            break;
        case RegType.DEPTHOUT:
            if (!programIsPixel) reject(`pixel depth output oDepth${reg.num} is invalid in a vertex shader`);
            break;
        case RegType.RASTOUT:
        case RegType.ATTROUT:
            if (programIsPixel) reject(`vertex raster/attribute output register ${reg.num} is invalid in a pixel shader`);
            break;
        case RegType.TEXCRDOUT:
            if (programIsPixel) reject(`vertex generic output register o${reg.num} is invalid in a pixel shader`);
            break;
        default:
            // The extended CONST2/3/4 and TEXCRDOUT/OUTPUT aliases are valid
            // SM3 encodings and are checked by their stage-specific emitters.
            break;
    }

    if (programIsPixel) {
        if (reg.type === RegType.COLOROUT && reg.num > 3) {
            throw new ShaderParseError("invalid-register", offset,
                `pixel shader color output oC${reg.num} is outside the D3D9 MRT range`);
        }
        if (reg.type === RegType.DEPTHOUT && reg.num !== 0) {
            throw new ShaderParseError("invalid-register", offset,
                `pixel shader depth output oDepth${reg.num} is invalid`);
        }
    } else {
        if (reg.type === RegType.RASTOUT && reg.num > 2) {
            throw new ShaderParseError("invalid-register", offset,
                `vertex shader raster output index ${reg.num} is invalid`);
        }
        if (reg.type === RegType.ATTROUT && reg.num > 1) {
            throw new ShaderParseError("invalid-register", offset,
                `vertex shader attribute output index ${reg.num} is invalid`);
        }
        if (reg.type === RegType.OUTPUT && major < 3 && reg.num > 7) {
            throw new ShaderParseError("invalid-register", offset,
                `SM${major} vertex output o${reg.num} is outside the SM2 range`);
        }
        if (reg.type === RegType.OUTPUT && major >= 3 && reg.num > 11) {
            throw new ShaderParseError("invalid-register", offset,
                `vertex shader output o${reg.num} is outside the D3D9 SM3 range`);
        }
    }
}

/** Output rows (= consecutive const regs read) for matrix-multiply macro ops. */
const MATRIX_ROWS: Record<number, number> = {
    [Op.M4x4]: 4, [Op.M4x3]: 3, [Op.M3x4]: 4, [Op.M3x3]: 3, [Op.M3x2]: 2,
};

// ── Bit decoders ──────────────────────────────────────────────────────────────

function decodeRegType(token: number): RegType {
    return (((token >>> 28) & 0x7) | (((token >>> 11) & 0x3) << 3)) as RegType;
}

function decodeRegNum(token: number): number {
    return token & 0x7FF;
}

function makeRegister(token: number): SmRegister {
    return {
        type: decodeRegType(token),
        num: decodeRegNum(token),
        relative: (token & (1 << 13)) !== 0,
    };
}

function decodeDst(token: number): SmDest {
    let shift = (token >>> 24) & 0xF;
    if (shift & 0x8) shift -= 16; // sign-extend 4-bit two's complement
    return {
        reg: makeRegister(token),
        writeMask: (token >>> 16) & 0xF,
        shift,
        saturate: (token & (1 << 20)) !== 0,
        partialPrecision: (token & (1 << 21)) !== 0,
        centroid: (token & (1 << 22)) !== 0,
    };
}

function decodeSrc(token: number): SmSource {
    return {
        reg: makeRegister(token),
        swizzle: (token >>> 16) & 0xFF,
        modifier: (token >>> 24) & 0xF,
    };
}

function decodeComparison(opcode: Op, specificData: number): CmpOp | undefined {
    if (opcode !== Op.IFC && opcode !== Op.BREAKC && opcode !== Op.SETP) return undefined;
    return cmpOpFromCode(specificData & 0x7);
}

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a D3D9 shader bytecode token stream.
 * @param tokens Uint32Array of DWORD tokens read from guest memory.
 */
export function parseShader(tokens: Uint32Array): SmProgram {
    if (tokens.length < 2) throw new Error("Shader bytecode too short");

    const version = tokens[0] >>> 0;
    const progType = (version >>> 16) & 0xFFFF;
    const isPixelShader = progType === 0xFFFF;
    if (progType !== 0xFFFF && progType !== 0xFFFE) {
        throw new Error(`Not a shader: version 0x${version.toString(16)}`);
    }
    const major = (version >>> 8) & 0xFF;
    const minor = version & 0xFF;
    // D3D9/D3D8 bytecode is limited to shader-model 1.x–3.x.  Letting a
    // forged SM4+ token stream reach the legacy emitters can produce valid
    // WGSL for semantics the guest runtime never requested, so reject it at
    // the parser boundary and map it to the normal shader INVALIDCALL path.
    if (major < 1 || major > 3) {
        throw new ShaderParseError(
            "unsupported-version",
            0,
            `unsupported shader model ${isPixelShader ? "ps" : "vs"}_${major}_${minor}`,
        );
    }

    const instructions: SmInstruction[] = [];
    const declarations: SmDcl[] = [];
    const definitions: SmDef[] = [];
    const stream: SmStreamItem[] = [];
    let terminated = false;
    let maxTemp = -1;
    let maxConst = -1;
    let maxBool = -1;
    let usesRelativeConst = false;
    const samplersUsed = new Set<number>();
    const inputRegs = new Set<number>();

    const trackReg = (reg: SmRegister) => {
        // SM1.x/D3D8 streams may carry byte-swapped legacy comment payloads
        // which the fixed-table walk treats as opaque operands; register-range
        // legality starts with the versioned SM2+ token contract.
        if (major >= 2) validateRegister(isPixelShader, major, reg, i);
        if (reg.type === RegType.TEMP && reg.num > maxTemp) maxTemp = reg.num;
        if (reg.type === RegType.CONST) {
            if (reg.num > maxConst) maxConst = reg.num;
            if (reg.relative) usesRelativeConst = true;
        }
        if (reg.type === RegType.CONSTBOOL && reg.num > maxBool) maxBool = reg.num;
        if (reg.type === RegType.INPUT) inputRegs.add(reg.num);
    };

    let i = 1; // skip version token
    let guard = 0;
    const ps14 = isPixelShader && major === 1 && minor === 4;

    const requireRange = (start: number, count: number, what: string): void => {
        if (count < 0 || start < 0 || start + count > tokens.length) {
            throw new ShaderParseError(
                "truncated",
                Math.max(0, start),
                `${what} at token ${start} needs ${count} DWORD${count === 1 ? "" : "s"}, ` +
                `but the shader ends at token ${tokens.length}`,
            );
        }
    };

    const requireInstructionRange = (start: number, end: number, what: string): void => {
        if (end < start || end > tokens.length) {
            throw new ShaderParseError(
                "truncated",
                Math.max(0, start),
                `${what} at token ${start} extends past the shader buffer ` +
                `(declared end ${end}, buffer length ${tokens.length})`,
            );
        }
    };

    while (i < tokens.length) {
        if (++guard > 100000) throw new Error("Shader parse runaway");
        const instrToken = tokens[i] >>> 0;
        const opcode = (instrToken & 0xFFFF) as Op;

        if (opcode === Op.END || instrToken === 0x0000FFFF) { i += 1; terminated = true; break; }

        if (opcode === Op.COMMENT) {
            const len = (instrToken >>> 16) & 0x7FFF;
            requireRange(i + 1, len, `comment payload`);
            i += 1 + len;
            continue;
        }
        if (opcode === Op.PHASE) {
            // ps_1_4 phase separator — no operands, no emitted code.
            i += 1;
            stream.push({ kind: "phase" });
            continue;
        }

        // The low 16 bits are an enum, not an opaque operation identifier.
        // Without this guard a forged SM2/3 length nibble can turn an unknown
        // opcode into a partial instruction which later emits ``UNSUPPORTED``
        // WGSL and is incorrectly accepted by Create*Shader.
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_LEN, opcode)) {
            throw new ShaderParseError(
                "unknown-opcode",
                i,
                `unknown shader opcode ${opName(opcode)} (0x${opcode.toString(16)}) at token ${i}`,
            );
        }

        i += 1; // consume instruction token

        // Operand length
        let length: number;
        if (major >= 2) {
            length = (instrToken >>> 24) & 0xF;
        } else {
            const base = DEFAULT_LEN[opcode];
            if (base === undefined) {
                throw new Error(`Unknown opcode ${opName(opcode)} (0x${opcode.toString(16)}) at token ${i - 1}`);
            }
            length = base;
            if (ps14 && (opcode === Op.TEX || opcode === Op.TEXCOORD)) length += 1;
        }

        const operandStart = i;
        const operandEnd = i + length;
        requireInstructionRange(operandStart, operandEnd, `${opName(opcode)} operands`);

        // DCL — [dcl token][dst token]
        if (opcode === Op.DCL) {
            if (length !== 2) {
                throw new ShaderParseError(
                    "invalid-length",
                    operandStart,
                    `dcl at token ${i - 1} declares ${length} operand DWORDs; expected 2`,
                );
            }
            requireRange(i, 2, "dcl operands");
            const dclToken = tokens[i++] >>> 0;
            const regToken = tokens[i++] >>> 0;
            const reg = makeRegister(regToken);
            const decl: SmDcl = {
                usage: dclToken & 0xF,
                usageIndex: (dclToken >>> 16) & 0xF,
                textureType: (dclToken >>> 27) & 0xF,
                reg,
                // A zero declaration mask is the assembler's omitted-mask form;
                // explicit xy/xyz masks remain observable by the stage emitters.
                writeMask: (regToken >>> 16) & 0xF || 0xF,
                centroid: (regToken & (1 << 22)) !== 0,
            };
            declarations.push(decl);
            stream.push({ kind: "dcl", dcl: decl });
            if (reg.type === RegType.SAMPLER) samplersUsed.add(reg.num);
            trackReg(reg);
            continue;
        }

        // DEF / DEFI — [dst token][4 value tokens]; DEFB — [dst token][1 value]
        if (opcode === Op.DEF || opcode === Op.DEFI || opcode === Op.DEFB) {
            const expectedLength = opcode === Op.DEFB ? 2 : 5;
            if (length !== expectedLength) {
                throw new ShaderParseError(
                    "invalid-length",
                    operandStart,
                    `${opName(opcode)} at token ${i - 1} declares ${length} operand DWORDs; ` +
                    `expected ${expectedLength}`,
                );
            }
            requireRange(i, expectedLength, `${opName(opcode)} operands`);
            const regToken = tokens[i++] >>> 0;
            const reg = makeRegister(regToken);
            const valueCount = opcode === Op.DEFB ? 1 : 4;
            const raw = new Uint32Array(4);
            for (let v = 0; v < valueCount; v++) raw[v] = tokens[i++] >>> 0;
            const definition: SmDef = {
                reg,
                values: new Float32Array(raw.buffer.slice(0)),
                rawInt: new Int32Array(raw.buffer.slice(0)),
                kind: opcode === Op.DEF ? "f" : opcode === Op.DEFI ? "i" : "b",
            };
            trackReg(reg);
            definitions.push(definition);
            stream.push({ kind: "def", def: definition });
            if (reg.type === RegType.CONST && reg.num > maxConst) maxConst = reg.num;
            if (reg.type === RegType.CONSTBOOL && reg.num > maxBool) maxBool = reg.num;
            continue;
        }

        // Generic instruction: optional dst + source operands. `length` is a DWORD
        // count, not a source count — an SM2+ relative source spends two of them —
        // so the operand walk is bounded by the end of the operand block.
        const hasDst = !NO_DST.has(opcode);
        let dst: SmDest | null = null;
        // The predicate bit is part of every SM2+ instruction token. Legacy
        // D3D8 comment tokens are consumed above before this path is reached.
        const predicated = supportsShaderPredication(major) && (instrToken & 0x10000000) !== 0;
        let predicate: SmSource | undefined;

        if (hasDst) {
            requireRange(i, 1, `${opName(opcode)} destination`);
            dst = decodeDst(tokens[i++] >>> 0);
            trackReg(dst.reg);
            // SM3 destination-relative addressing has its index register in an
            // extra token immediately after the destination token.
            if (major >= 3 && dst.reg.relative) {
                requireInstructionRange(i, i + 1, `${opName(opcode)} destination-relative index`);
                const relToken = tokens[i++] >>> 0;
                dst.relReg = makeRegister(relToken);
                dst.relSwizzle = (relToken >>> 16) & 0xFF;
            }
            if (dst.reg.type === RegType.SAMPLER) samplersUsed.add(dst.reg.num);
            // ps_1_1-1_3 implicit sampler = texture-coord register number for tex.
            if (isPixelShader && major === 1 && !ps14 &&
                (opcode === Op.TEX || opcode === Op.TEXCOORD) &&
                dst.reg.type === RegType.TEXTURE) {
                samplersUsed.add(dst.reg.num);
            }
        }

        // The predicate token is part of the instruction's operand length and
        // comes before all ordinary sources (after a possible SM3 dst-relative
        // token). It is not a source-relative operand itself.
        if (predicated) {
            requireInstructionRange(i, i + 1, `${opName(opcode)} predicate`);
            predicate = decodeSrc(tokens[i++] >>> 0);
            // D3D9 predication is carried by the dedicated p0 register.  Treating
            // an arbitrary source register as a predicate shifts the operand stream
            // while still producing apparently valid IR, so reject it at decode time
            // before any emitter or SWVP path can observe the malformed instruction.
            if (predicate.reg.type !== RegType.PREDICATE || predicate.reg.num !== 0) {
                throw new ShaderParseError(
                    "invalid-register",
                    i - 1,
                    `${opName(opcode)} predicate must be p0`,
                );
            }
        }

        const src: SmSource[] = [];
        while (i < operandEnd) {
            requireRange(i, 1, `${opName(opcode)} source`);
            const srcToken = tokens[i++] >>> 0;
            const operand = decodeSrc(srcToken);
            // SM2+ relative addressing consumes an extra token (the rel register).
            if (major >= 2 && operand.reg.relative) {
                requireInstructionRange(i, i + 1, `${opName(opcode)} source-relative index`);
                const relToken = tokens[i++] >>> 0;
                operand.relReg = makeRegister(relToken);
                operand.relSwizzle = (relToken >>> 16) & 0xFF;
            }
            trackReg(operand.reg);
            if (operand.reg.type === RegType.SAMPLER) samplersUsed.add(operand.reg.num);
            src.push(operand);
        }

        // ps_1_4 texld / SM2+ texld: sampler is an explicit source register.
        if (opcode === Op.TEX && isPixelShader) {
            if (ps14 && src.length >= 1 && dst) samplersUsed.add(dst.reg.num);
            if (major >= 2 && src.length >= 2) samplersUsed.add(src[1].reg.num);
        }

        // Matrix-multiply macro ops read N consecutive constant registers from
        // the base in src[1]; extend maxConst so the WGSL array covers them.
        const rows = MATRIX_ROWS[opcode];
        if (rows && src.length >= 2 && src[1].reg.type === RegType.CONST && !src[1].reg.relative) {
            const top = src[1].reg.num + rows - 1;
            if (top > maxConst) maxConst = top;
        }

        const specificData = (instrToken >>> 16) & 0xFF;
        const instruction: SmInstruction = {
            opcode,
            coissue: (instrToken & 0x40000000) !== 0,
            predicated,
            specificData,
            dst,
            src,
        };
        const requiredSources = requiredSourceCount(opcode, major);
        // SM1.x streams include legacy comment/phase encodings which do not use
        // the SM2/3 length-nibble contract; retain their fixed-table walk and
        // apply strict source arity to the length-tagged SM2+ family.
        if (major >= 2 && requiredSources !== undefined && src.length !== requiredSources) {
            throw new ShaderParseError(
                "invalid-length",
                operandStart,
                `${opName(opcode)} supplied ${src.length} source operand${src.length === 1 ? "" : "s"}; ` +
                `expected ${requiredSources}`,
            );
        }
        const comparison = decodeComparison(opcode, specificData);
        if (comparison !== undefined) instruction.comparison = comparison;
        if (predicate !== undefined) instruction.predicate = predicate;
        instructions.push(instruction);
        stream.push({ kind: "instruction", instruction });
    }

    return {
        isPixelShader,
        major,
        minor,
        instructions,
        declarations,
        definitions,
        maxTemp,
        maxConst,
        maxBool,
        samplersUsed,
        inputRegs,
        usesRelativeConst,
        stream,
        tokenCount: i,
        terminated,
    };
}
