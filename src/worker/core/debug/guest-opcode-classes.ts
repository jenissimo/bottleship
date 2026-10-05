/**
 * The x86 semantics behind the guest census (roadmap 10): which class an opcode belongs
 * to, and which addressing form a ModRM/SIB encoding names.
 *
 * v86's side of the census is deliberately mechanical — it extracts bits and increments a
 * bucket. Every judgement ("this is an x87 store", "this is the stack class") lives HERE,
 * once, with a table-driven test (tools/tests/guest-opcode-census.test.ts), so the class
 * table an optimisation target is chosen from is validated and cannot drift between two
 * languages.
 *
 * Nothing here reads global state, so the whole file is testable without an emulator.
 */

/** Census key produced by v86's opcode buffer: is_0f<<12 | opcode<<4 | is_mem<<3 | fixed_g. */
export interface OpcodeKey {
    opcode: number;
    is0f: boolean;
    isMem: boolean;
    /** ModRM reg field, but only for the opcodes v86 records it for (group opcodes). */
    fixedG: number;
}

export type InstrClass =
    | "x87.load" | "x87.store" | "x87.arith" | "x87.compare" | "x87.control"
    | "simd.mov" | "simd.arith" | "simd.shuffle" | "simd.cvt" | "simd.compare" | "simd.other"
    | "branch.condDirect" | "branch.jmpDirect" | "branch.callDirect"
    | "branch.indirect" | "branch.ret" | "branch.far"
    | "string"
    | "stack"
    | "mem.mov" | "mem.alu"
    | "reg.mov" | "reg.alu"
    | "system" | "other";

/** The eight x87 escape opcodes. */
const X87_LO = 0xd8, X87_HI = 0xdf;

/**
 * x87 by (opcode, memory-or-register form, ModRM reg field). The escape opcodes reuse the
 * reg field for opposite meanings between the memory and register forms — DD /2 is
 * `fst m64` but DD C0+i is `ffree` — so the two forms are separate tables rather than one
 * table with exceptions.
 */
function classifyX87(k: OpcodeKey): InstrClass {
    const g = k.fixedG & 7;
    if (k.isMem) {
        switch (k.opcode) {
            case 0xd8: case 0xdc:            // m32fp / m64fp arithmetic
            case 0xda: case 0xde:            // m32int / m16int arithmetic
                return g === 2 || g === 3 ? "x87.compare" : "x87.arith";
            case 0xd9:
                if (g === 0) return "x87.load";                 // fld m32fp
                if (g === 2 || g === 3) return "x87.store";     // fst / fstp
                return "x87.control";                           // fldenv, fldcw, fnstenv, fnstcw
            case 0xdb:
                if (g === 0 || g === 5) return "x87.load";      // fild m32int, fld m80fp
                if (g === 1 || g === 2 || g === 3 || g === 7) return "x87.store";
                return "x87.control";
            case 0xdd:
                if (g === 0) return "x87.load";                 // fld m64fp
                if (g === 1 || g === 2 || g === 3) return "x87.store";
                return "x87.control";                           // frstor, fnsave, fnstsw m16
            case 0xdf:
                if (g === 0 || g === 4 || g === 5) return "x87.load";   // fild, fbld, fild m64
                return "x87.store";                             // fist/fistp/fbstp/fistp m64
            default: return "x87.arith";
        }
    }
    switch (k.opcode) {
        case 0xd8: case 0xdc:
            return g === 2 || g === 3 ? "x87.compare" : "x87.arith";
        case 0xde:
            // DE /2 fcomp, /3 fcompp.
            return g === 2 || g === 3 ? "x87.compare" : "x87.arith";
        case 0xd9:
            if (g === 0) return "x87.load";                     // fld st(i)
            if (g === 3) return "x87.store";                    // fstp st(i)
            if (g === 5) return "x87.load";                     // fld1/fldl2t/... constants
            // /1 fxch, /2 fnop, /4 fchs/fabs/ftst/fxam, /6-/7 transcendental+control mix.
            return g === 4 || g === 6 || g === 7 ? "x87.arith" : "x87.control";
        case 0xda:
            return g === 5 ? "x87.compare" : "x87.arith";       // /5 fucompp, else fcmovcc
        case 0xdb:
            if (g === 4) return "x87.control";                  // fnclex / fninit
            return g === 5 || g === 6 ? "x87.compare" : "x87.arith";
        case 0xdd:
            if (g === 2 || g === 3) return "x87.store";         // fst / fstp st(i)
            return g === 4 || g === 5 ? "x87.compare" : "x87.control"; // fucom/fucomp, ffree
        case 0xdf:
            if (g === 4) return "x87.control";                  // fnstsw ax
            return g === 5 || g === 6 ? "x87.compare" : "x87.arith";
        default: return "x87.arith";
    }
}

/**
 * 0F-map SIMD by opcode. The mandatory prefix (none/66/F3/F2) decides MMX-vs-SSE and the
 * scalar-vs-packed form, NOT the class, so it is not consulted here — `simdFamily` below
 * is what answers "how much SSE2".
 */
function classify0f(k: OpcodeKey): InstrClass {
    const op = k.opcode;
    if (op === 0x10 || op === 0x11 || op === 0x12 || op === 0x13 || op === 0x16 || op === 0x17
        || op === 0x28 || op === 0x29 || op === 0x2b || op === 0x6e || op === 0x6f
        || op === 0x7e || op === 0x7f || op === 0xd6 || op === 0xe7) return "simd.mov";
    if (op === 0x14 || op === 0x15 || op === 0x70 || op === 0xc6
        || (op >= 0x60 && op <= 0x63) || (op >= 0x67 && op <= 0x6b)) return "simd.shuffle";
    if (op === 0x2a || op === 0x2c || op === 0x2d || op === 0x5a || op === 0x5b || op === 0xe6) return "simd.cvt";
    if (op === 0x2e || op === 0x2f || op === 0xc2
        || (op >= 0x64 && op <= 0x66) || (op >= 0x74 && op <= 0x76)) return "simd.compare";
    if (op === 0x51 || op === 0x52 || op === 0x53 || (op >= 0x54 && op <= 0x57)
        || (op >= 0x58 && op <= 0x5f)
        || (op >= 0x71 && op <= 0x73)
        || (op >= 0xd1 && op <= 0xd5) || (op >= 0xd8 && op <= 0xdf)
        || (op >= 0xe0 && op <= 0xe5) || (op >= 0xe8 && op <= 0xef)
        || (op >= 0xf1 && op <= 0xf6) || (op >= 0xf8 && op <= 0xfe)) return "simd.arith";
    if (op >= 0x80 && op <= 0x8f) return "branch.condDirect";   // jcc rel32
    if (op >= 0x90 && op <= 0x9f) return k.isMem ? "mem.mov" : "reg.mov"; // setcc
    if (op >= 0x40 && op <= 0x4f) return k.isMem ? "mem.mov" : "reg.mov"; // cmovcc
    if (op === 0xb6 || op === 0xb7 || op === 0xbe || op === 0xbf) return k.isMem ? "mem.mov" : "reg.mov";
    if (op === 0xaf || op === 0xa3 || op === 0xab || op === 0xb3 || op === 0xbb
        || op === 0xbc || op === 0xbd || op === 0xba || op === 0xc0 || op === 0xc1
        || op === 0xa4 || op === 0xa5 || op === 0xac || op === 0xad) {
        return k.isMem ? "mem.alu" : "reg.alu";
    }
    if (op === 0xa0 || op === 0xa1 || op === 0xa8 || op === 0xa9) return "stack"; // push/pop fs,gs
    if (op === 0x0b || op === 0x05 || op === 0x06 || op === 0x09 || op === 0x30 || op === 0x31
        || op === 0x32 || op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23
        || op === 0xa2 || op === 0xae || op === 0x01 || op === 0x00 || op === 0x18
        || op === 0x08 || op === 0x77 || op === 0x33 || op === 0x34 || op === 0x35) return "system";
    // Non-SIMD 0F-map integer instructions: cmpxchg, cmpxchg8b, bswap, movnti, hint nops.
    if (op === 0xb0 || op === 0xb1 || op === 0xc7 || (op >= 0xc8 && op <= 0xcf)) {
        return k.isMem ? "mem.alu" : "reg.alu";
    }
    if (op === 0xc3) return "mem.mov";
    if (op === 0x1f || op === 0x0d) return "other";
    return "simd.other";
}

/** The one-byte map. */
function classify1byte(k: OpcodeKey): InstrClass {
    const op = k.opcode;
    if (op >= X87_LO && op <= X87_HI) return classifyX87(k);

    // String primitives: implicit ESI/EDI, no ModRM.
    if ((op >= 0xa4 && op <= 0xa7) || (op >= 0xaa && op <= 0xaf) || (op >= 0x6c && op <= 0x6f)) return "string";

    if (op >= 0x70 && op <= 0x7f) return "branch.condDirect";
    if (op >= 0xe0 && op <= 0xe3) return "branch.condDirect";      // loop/loopz/loopnz/jecxz
    if (op === 0xeb || op === 0xe9) return "branch.jmpDirect";
    if (op === 0xea) return "branch.far";
    if (op === 0xe8) return "branch.callDirect";
    if (op === 0xc2 || op === 0xc3) return "branch.ret";
    if (op === 0xca || op === 0xcb || op === 0xcf) return "branch.far";
    if (op === 0xff) {
        switch (k.fixedG & 7) {
            case 2: return "branch.indirect";   // call r/m32
            case 3: return "branch.far";        // callf m16:32
            case 4: return "branch.indirect";   // jmp r/m32
            case 5: return "branch.far";        // jmpf m16:32
            case 6: return "stack";             // push r/m32
            default: return k.isMem ? "mem.alu" : "reg.alu";  // inc/dec
        }
    }

    if ((op >= 0x50 && op <= 0x5f) || op === 0x60 || op === 0x61 || op === 0x68 || op === 0x6a
        || op === 0x9c || op === 0x9d || op === 0xc8 || op === 0xc9
        || op === 0x06 || op === 0x07 || op === 0x0e || op === 0x16 || op === 0x17
        || op === 0x1e || op === 0x1f || op === 0x8f) return "stack";

    if (op === 0xcc || op === 0xcd || op === 0xce || op === 0xf4 || op === 0xfa || op === 0xfb
        || op === 0x9b || op === 0xf0 || op === 0x0f) return "system";
    if (op >= 0xe4 && op <= 0xe7) return "system";                  // in/out imm
    if (op === 0xec || op === 0xed || op === 0xee || op === 0xef) return "system";

    // mov family.
    if ((op >= 0x88 && op <= 0x8b) || op === 0x8c || op === 0x8e || (op >= 0xa0 && op <= 0xa3)
        || (op >= 0xb0 && op <= 0xbf) || op === 0xc6 || op === 0xc7 || op === 0x8d) {
        return k.isMem ? "mem.mov" : "reg.mov";
    }
    return k.isMem ? "mem.alu" : "reg.alu";
}

export function classifyOpcode(k: OpcodeKey): InstrClass {
    return k.is0f ? classify0f(k) : classify1byte(k);
}

/** Rolled-up group a class belongs to — the row a census table prints. */
export type ClassGroup = "x87" | "simd" | "branch" | "string" | "stack" | "memory" | "register" | "system" | "other";

export function classGroup(c: InstrClass): ClassGroup {
    if (c.startsWith("x87.")) return "x87";
    if (c.startsWith("simd.")) return "simd";
    if (c.startsWith("branch.")) return "branch";
    if (c === "string") return "string";
    if (c === "stack") return "stack";
    if (c.startsWith("mem.")) return "memory";
    if (c.startsWith("reg.")) return "register";
    if (c === "system") return "system";
    return "other";
}

// ---------------------------------------------------------------------------
// Addressing forms
// ---------------------------------------------------------------------------

/**
 * Addressing form of a ModRM/SIB encoding, from v86's mechanical key:
 * bit 7 addr16 | bit 6 has_sib | bits 5-4 mod | bits 3-1 base (SIB base, else rm) |
 * bit 0 index present.
 *
 * `stackConst` is the class roadmap 02 is about: a base of ESP or EBP with a constant
 * displacement and no index, which a single per-unit guard can cover. A stack base WITH an
 * index (`[esp+eax*4]`) is deliberately NOT in it — the guard would have to bound a
 * runtime value — but it gets its own bucket rather than vanishing into `baseIndex`,
 * because the two answer different questions about the same ceiling.
 */
export type AddrForm = "stackConst" | "stackIndex" | "baseConst" | "baseIndex" | "absolute" | "addr16";

const REG_ESP = 4, REG_EBP = 5;

export function classifyAddrKey(key: number): AddrForm {
    if (key & 0x80) return "addr16";
    const hasSib = (key & 0x40) !== 0;
    const mod = (key >> 4) & 3;
    const base = (key >> 1) & 7;
    const indexPresent = (key & 1) !== 0;

    if (hasSib) {
        // base == 5 with mod == 0 is "no base register, disp32 follows".
        if (base === REG_EBP && mod === 0) return indexPresent ? "baseIndex" : "absolute";
        const stackBase = base === REG_ESP || base === REG_EBP;
        if (indexPresent) return stackBase ? "stackIndex" : "baseIndex";
        return stackBase ? "stackConst" : "baseConst";
    }
    // Without a SIB, rm == 4 cannot occur (it is what asks for one) and rm == 5 with
    // mod == 0 is the bare disp32 form.
    if (base === REG_EBP) return mod === 0 ? "absolute" : "stackConst";
    return "baseConst";
}

// ---------------------------------------------------------------------------
// SIMD families
// ---------------------------------------------------------------------------

/**
 * SIMD family from v86's prefix-keyed buffer: prefix<<8 | opcode, prefix being
 * 0 = none, 1 = 0x66, 2 = 0xF3, 3 = 0xF2.
 *
 * The distinction the plain opcode census cannot make: an unprefixed 0F EF is MMX PXOR
 * over an x87-aliased register, while 66 0F EF is SSE2 PXOR over XMM. Rolling those into
 * one "SSE" row would answer "does this game use SSE2" with a number that also contains
 * MMX — and MMX aliasing the x87 stack is exactly the state a context switch has to save.
 */
export type SimdFamily = "mmx" | "sse.ps" | "sse2.pd" | "sse.ss" | "sse2.sd" | "sse2.int" | "x87-map" | "other";

/** Opcodes on the 0F map that are NOT SIMD at all (jcc, setcc, cpuid, …). */
function isNonSimd0f(op: number): boolean {
    return (op >= 0x80 && op <= 0x9f) || (op >= 0x40 && op <= 0x4f)
        || (op >= 0xa0 && op <= 0xad) || (op >= 0xb0 && op <= 0xbf)
        || (op >= 0x00 && op <= 0x09) || (op >= 0x18 && op <= 0x27)
        || op === 0x30 || op === 0x31 || op === 0x32 || op === 0x77 || op === 0xc7
        || (op >= 0xc8 && op <= 0xcf) || op === 0xae || op === 0x0d || op === 0x1f
        || op === 0x33 || op === 0x34 || op === 0x35;
}

export function simdFamily(key: number): SimdFamily {
    const prefix = (key >> 8) & 3;
    const op = key & 0xff;
    if (isNonSimd0f(op)) return "other";
    // The MMX/SSE integer opcodes: D0-FF, the 60-6F pack/unpack block, 70-76, the 7E/7F
    // integer moves and C4/C5 pinsrw/pextrw. An F3/F2 prefix on one of these selects an
    // XMM integer form (movdqu, movq, pshufhw/pshuflw), not a scalar float op.
    const integerOp = (op >= 0x60 && op <= 0x76) || op === 0x7e || op === 0x7f
        || op === 0xc4 || op === 0xc5 || op >= 0xd0;
    if (prefix === 2) return integerOp ? "sse2.int" : "sse.ss";
    if (prefix === 3) return integerOp ? "sse2.int" : "sse2.sd";
    if (prefix === 1) return integerOp ? "sse2.int" : "sse2.pd";
    return integerOp ? "mmx" : "sse.ps";
}
