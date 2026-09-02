/**
 * A small 32-bit x86 emitter, enough for the guestbench fixtures.
 *
 * The roadmap makes a synthetic perf fixture mandatory for every lever
 * (docs/performance/sota-roadmap/README.md, "Синтетические тесты: общая форма"), and the
 * fixtures have to be IN this repository — a demo living on one machine cannot compare two
 * branches. Emitting the guest code from JS is what makes that possible without a C++
 * toolchain in the loop: a fixture is a few dozen lines, its instruction mix is exact by
 * construction rather than by whatever the compiler decided, and the same source builds
 * the image on every machine.
 *
 * Correctness of THIS file is load-bearing for everything built on it — a wrong ModRM byte
 * would be a fixture measuring something other than its name — so every encoder it has is
 * pinned byte-for-byte in tools/tests/guestbench-asm.test.ts.
 */

export const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
export const REG_NAMES = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];

/** `[base + index*scale + disp]`. Pass base:null for a bare absolute address. */
export function mem({ base = null, index = null, scale = 1, disp = 0 } = {}) {
    return { mem: true, base, index, scale, disp };
}
/** `[disp32]` — the absolute form. */
export function abs(disp) { return mem({ base: null, disp }); }
/** A register operand. */
export function reg(r) { return { mem: false, r }; }

const SCALE_BITS = { 1: 0, 2: 1, 4: 2, 8: 3 };

export class Asm {
    /** @param base linear address the emitted bytes will live at (for label fixups). */
    constructor(base) {
        this.base = base >>> 0;
        this.bytes = [];
        this.labels = new Map();
        this.fixups = [];   // { at, size, label, nextAddr }
    }

    get pos() { return this.bytes.length; }
    get addr() { return (this.base + this.bytes.length) >>> 0; }

    db(...b) { for (const x of b) this.bytes.push(x & 0xff); return this; }
    dd(v) { const n = v >>> 0; return this.db(n, n >> 8, n >> 16, n >> 24); }
    dw(v) { const n = v & 0xffff; return this.db(n, n >> 8); }

    label(name) {
        if (this.labels.has(name)) throw new Error(`duplicate label ${name}`);
        this.labels.set(name, this.addr);
        return this;
    }

    /**
     * ModRM (+ SIB + displacement) for `reg` field `r` and an r/m operand.
     *
     * The encoding rules that actually bite: rm == 4 is the escape that ASKS for a SIB, so
     * an ESP base always needs one; and mod == 0 with rm == 5 (or a SIB base of 5) means
     * "no base, disp32 follows", so [ebp] and [ebp+esi*4] must use mod == 1 with a zero
     * displacement instead.
     */
    modrm(r, rm) {
        if (!rm.mem) return this.db(0xc0 | ((r & 7) << 3) | (rm.r & 7));

        const { base, index, scale, disp } = rm;
        if (base === null && index === null) return this.db(0x05 | ((r & 7) << 3)).dd(disp);

        const needsSib = index !== null || base === ESP;
        const forcedDisp8 = base === EBP && disp === 0;   // [ebp] has no mod-0 encoding
        let mod;
        // No base register is SIB base 5 under mod 0 (disp32 follows); mod 1/2 with base 5 is EBP.
        if (base === null || (disp === 0 && !forcedDisp8)) mod = 0;
        else if (disp >= -128 && disp <= 127) mod = 1;
        else mod = 2;

        if (!needsSib) {
            this.db((mod << 6) | ((r & 7) << 3) | (base & 7));
        } else {
            this.db((mod << 6) | ((r & 7) << 3) | 4);
            const idx = index === null ? 4 : index;      // 4 == "no index"
            if (index === ESP) throw new Error("ESP cannot be a SIB index");
            const b = base === null ? 5 : base;
            this.db((SCALE_BITS[scale] << 6) | ((idx & 7) << 3) | (b & 7));
            if (base === null) { this.dd(disp); return this; }
        }
        if (mod === 1) this.db(disp);
        else if (mod === 2) this.dd(disp);
        return this;
    }

    // --- data movement ----------------------------------------------------
    movImm(r, imm) { return this.db(0xb8 + (r & 7)).dd(imm); }
    /** mov r32, r/m32 */
    mov(r, rm) { return this.db(0x8b).modrm(r, rm); }
    /** mov r/m32, r32 */
    movTo(rm, r) { return this.db(0x89).modrm(r, rm); }
    /** mov r/m32, imm32 */
    movMemImm(rm, imm) { return this.db(0xc7).modrm(0, rm).dd(imm); }
    lea(r, rm) { return this.db(0x8d).modrm(r, rm); }
    push(r) { return this.db(0x50 + (r & 7)); }
    pop(r) { return this.db(0x58 + (r & 7)); }

    // --- integer ALU ------------------------------------------------------
    // `op r32, r/m32` uses the 0x03-column of each group; `op r/m32, r32` the 0x01-column.
    alu(name, r, rm) {
        const OPS = { add: 0x03, or: 0x0b, and: 0x23, sub: 0x2b, xor: 0x33, cmp: 0x3b, adc: 0x13, sbb: 0x1b };
        return this.db(OPS[name]).modrm(r, rm);
    }
    aluTo(name, rm, r) {
        const OPS = { add: 0x01, or: 0x09, and: 0x21, sub: 0x29, xor: 0x31, cmp: 0x39 };
        return this.db(OPS[name]).modrm(r, rm);
    }
    /** op r/m32, imm32 (group 81 /digit) */
    aluImm(name, rm, imm) {
        const DIGIT = { add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7 };
        return this.db(0x81).modrm(DIGIT[name], rm).dd(imm);
    }
    imul(r, rm) { return this.db(0x0f, 0xaf).modrm(r, rm); }
    /** imul r32, r/m32, imm32 (69 /r id) — the mixing step the fixtures' checksums use. */
    imulImm(r, rm, imm) { return this.db(0x69).modrm(r, rm).dd(imm); }
    inc(rm) { return this.db(0xff).modrm(0, rm); }
    dec(rm) { return this.db(0xff).modrm(1, rm); }
    shl(rm, imm8) { return this.db(0xc1).modrm(4, rm).db(imm8); }
    shr(rm, imm8) { return this.db(0xc1).modrm(5, rm).db(imm8); }
    test(rm, r) { return this.db(0x85).modrm(r, rm); }
    ror(rm, imm8) { return this.db(0xc1).modrm(1, rm).db(imm8); }

    // --- control flow -----------------------------------------------------
    /** A rel32 branch to a (possibly forward) label. */
    _rel32(label) {
        this.fixups.push({ at: this.bytes.length, size: 4, label, nextAddr: this.addr + 4 });
        return this.dd(0);
    }
    _rel8(label) {
        this.fixups.push({ at: this.bytes.length, size: 1, label, nextAddr: this.addr + 1 });
        return this.db(0);
    }
    jmp(label) { return this.db(0xe9)._rel32(label); }
    jmpShort(label) { return this.db(0xeb)._rel8(label); }
    /** jcc rel32. cc: e,ne,l,le,g,ge,b,be,a,ae,s,ns,z,nz */
    jcc(cc, label) {
        const CC = { o: 0, no: 1, b: 2, ae: 3, e: 4, z: 4, ne: 5, nz: 5, be: 6, a: 7, s: 8, ns: 9, l: 12, ge: 13, le: 14, g: 15 };
        if (!(cc in CC)) throw new Error(`unknown condition ${cc}`);
        return this.db(0x0f, 0x80 + CC[cc])._rel32(label);
    }
    /** jcc rel8 — the encoding a compiler emits for a tight loop's back edge. */
    jccShort(cc, label) {
        const CC = { o: 0, no: 1, b: 2, ae: 3, e: 4, z: 4, ne: 5, nz: 5, be: 6, a: 7, s: 8, ns: 9, l: 12, ge: 13, le: 14, g: 15 };
        if (!(cc in CC)) throw new Error(`unknown condition ${cc}`);
        return this.db(0x70 + CC[cc])._rel8(label);
    }
    callRel(label) { return this.db(0xe8)._rel32(label); }
    callIndirect(rm) { return this.db(0xff).modrm(2, rm); }
    jmpIndirect(rm) { return this.db(0xff).modrm(4, rm); }
    ret() { return this.db(0xc3); }
    hlt() { return this.db(0xf4); }

    // --- x87 --------------------------------------------------------------
    fninit() { return this.db(0xdb, 0xe3); }
    fldM32(rm) { return this.db(0xd9).modrm(0, rm); }
    fldM64(rm) { return this.db(0xdd).modrm(0, rm); }
    fstpM32(rm) { return this.db(0xd9).modrm(3, rm); }
    fstpM64(rm) { return this.db(0xdd).modrm(3, rm); }
    fistpM32(rm) { return this.db(0xdb).modrm(3, rm); }
    fildM32(rm) { return this.db(0xdb).modrm(0, rm); }
    /** fadd/fmul/fsub/fdiv dword [m] */
    farithM32(name, rm) {
        const DIGIT = { add: 0, mul: 1, com: 2, comp: 3, sub: 4, subr: 5, div: 6, divr: 7 };
        return this.db(0xd8).modrm(DIGIT[name], rm);
    }
    /** fld st(i) */
    fldSt(i) { return this.db(0xd9, 0xc0 + (i & 7)); }
    /** st(0) op= st(i) — the register form (D8 C0+i etc). */
    farithSt(name, i) {
        const DIGIT = { add: 0, mul: 1, sub: 4, subr: 5, div: 6, divr: 7 };
        return this.db(0xd8, 0xc0 + (DIGIT[name] << 3) + (i & 7));
    }
    fxch(i = 1) { return this.db(0xd9, 0xc8 + (i & 7)); }
    fstpSt(i) { return this.db(0xdd, 0xd8 + (i & 7)); }

    // --- SSE --------------------------------------------------------------
    movups(r, rm) { return this.db(0x0f, 0x10).modrm(r, rm); }
    movupsTo(rm, r) { return this.db(0x0f, 0x11).modrm(r, rm); }
    /** addps/mulps/subps/divps/minps/maxps xmm_r, xmm/m */
    sseArith(name, r, rm) {
        const OPS = { sqrt: 0x51, and: 0x54, or: 0x56, xor: 0x57, add: 0x58, mul: 0x59, sub: 0x5c, min: 0x5d, div: 0x5e, max: 0x5f };
        return this.db(0x0f, OPS[name]).modrm(r, rm);
    }
    /** pxor mm/xmm — unprefixed here, i.e. the MMX form. */
    pxorMmx(r, rm) { return this.db(0x0f, 0xef).modrm(r, rm); }
    emms() { return this.db(0x0f, 0x77); }

    // --- system -----------------------------------------------------------
    /** invlpg m — 0F 01 /7. Drops one page's TLB entry; the guest's own way of saying
     *  "the mapping I just changed is now visible". */
    invlpg(rm) { return this.db(0x0f, 0x01).modrm(7, rm); }
    movEaxCr(n) { return this.db(0x0f, 0x20, 0xc0 | ((n & 7) << 3)); }
    movCrEax(n) { return this.db(0x0f, 0x22, 0xc0 | ((n & 7) << 3)); }
    outDxAl() { return this.db(0xee); }
    /** Enable x87 and SSE from a bare multiboot start: CR0 &= ~(EM|TS), CR4 |= OSFXSR|OSXMMEXCPT. */
    enableFpuAndSse() {
        this.movEaxCr(0);
        this.db(0x25).dd(0xfffffff3);            // and eax, ~(EM|TS)
        this.movCrEax(0);
        this.movEaxCr(4);
        this.db(0x0d).dd(0x00000600);            // or eax, OSFXSR|OSXMMEXCPT
        this.movCrEax(4);
        return this.fninit();
    }

    /** Resolve label references. Throws on an unknown label or an out-of-range rel8. */
    link() {
        for (const f of this.fixups) {
            const target = this.labels.get(f.label);
            if (target === undefined) throw new Error(`unresolved label ${f.label}`);
            const delta = (target | 0) - (f.nextAddr | 0);
            if (f.size === 1) {
                if (delta < -128 || delta > 127) {
                    throw new Error(`short branch to ${f.label} is ${delta} bytes away — use the rel32 form`);
                }
                this.bytes[f.at] = delta & 0xff;
            } else {
                for (let i = 0; i < 4; i++) this.bytes[f.at + i] = (delta >> (i * 8)) & 0xff;
            }
        }
        this.fixups = [];
        return Uint8Array.from(this.bytes);
    }
}
