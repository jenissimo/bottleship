// x86 decoder for the AOT compiler's "integer-core" slice.
//
// Scope, stated as a rule rather than a list: 32-bit operand and address size, NO prefixes at
// all (a segment/opsize/addrsize/lock/rep prefix makes the instruction unsupported), and the
// mov / ALU / branch / memory core. Everything else returns `{kind:"unsupported"}` and the
// caller ends the unit there — contract §4.3, "degradation is in perf, never in bugs".
//
// ModRM decoding mirrors vendor/v86/src/rust/modrm.rs `decode32`/`decode_sib` exactly,
// including which forms carry an SS default segment, because the address expression an AOT
// unit emits must be the one the engine would have emitted.

import { REG } from "./abi.mjs";

const PREFIXES = new Set([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3]);
const SEG_DS = 3, SEG_SS = 2;

const s8 = (v) => (v << 24) >> 24;
const s32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
const u32 = (b, i) => s32(b, i) >>> 0;

/** @returns {{len:number, seg:number, base:number|null, index:number|null, shift:number, disp:number, isReg:boolean, rm:number}} */
function decodeModrm(bytes, i) {
    const m = bytes[i];
    const mod = m >> 6, rm = m & 7;
    let p = i + 1;
    if (mod === 3) return { len: 1, seg: SEG_DS, base: null, index: null, shift: 0, disp: 0, isReg: true, rm };

    let seg = SEG_DS, base = null, index = null, shift = 0, disp = 0;
    if (rm === 4) {
        const sib = bytes[p++];
        const r = sib & 7, ix = (sib >> 3) & 7;
        shift = (sib >> 6) & 3;
        index = ix === 4 ? null : ix;
        if (r === 4) { seg = SEG_SS; base = REG.ESP; }
        else if (r === 5) {
            if (mod === 0) {
                disp = s32(bytes, p); p += 4;
                return { len: p - i, seg: SEG_DS, base: null, index, shift, disp, isReg: false, rm };
            }
            seg = SEG_SS; base = REG.EBP;
        }
        else { seg = SEG_DS; base = r; }
    }
    else if (mod === 0 && rm === 5) {
        disp = s32(bytes, p); p += 4;
        return { len: p - i, seg: SEG_DS, base: null, index: null, shift: 0, disp, isReg: false, rm };
    }
    else {
        // mod==0 reaches here only for rm in {0,1,2,3,6,7} (rm 4 = SIB, rm 5 = disp32 above),
        // so rm==EBP implies mod 1 or 2 — modrm.rs's 0o105/0o205 SS default.
        base = rm;
        seg = rm === REG.EBP ? SEG_SS : SEG_DS;
    }
    if (mod === 1) { disp = s8(bytes[p]); p += 1; }
    else if (mod === 2) { disp = s32(bytes, p); p += 4; }
    return { len: p - i, seg, base, index, shift, disp, isReg: false, rm };
}

const ALU_BY_REG = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
/** opcode high bits 0x00/0x08/0x20/0x28/0x30/0x38 -> alu op */
const ALU_BY_OP = { 0x00: "add", 0x08: "or", 0x10: "adc", 0x18: "sbb", 0x20: "and", 0x28: "sub", 0x30: "xor", 0x38: "cmp" };
const SHIFT_BY_REG = { 4: "shl", 5: "shr", 6: "shl", 7: "sar" };

const un = (addr, why) => ({ addr, kind: "unsupported", why, len: 0 });

/**
 * Decode one instruction.
 * @param {Uint8Array} bytes page-local bytes
 * @param {number} off offset of the instruction inside `bytes`
 * @param {number} addr its guest address
 */
export function decodeOne(bytes, off, addr) {
    const b = bytes;
    let i = off;
    if (PREFIXES.has(b[i])) return un(addr, `prefix 0x${b[i].toString(16)}`);
    const op = b[i++];
    const fin = (o) => ({ ...o, addr, len: i - off, opcode: o.opcode ?? op });

    // ── ALU r/m,r and r,r/m ────────────────────────────────────────────────
    if (op < 0x40 && (op & 7) < 4) {
        const alu = ALU_BY_OP[op & 0x38];
        if (alu === "adc" || alu === "sbb") return un(addr, `${alu} not in slice`);
        const dir = (op >> 1) & 1;       // 0: r/m <- r ; 1: r <- r/m
        const size = (op & 1) ? 32 : 8;
        if (size === 8) return un(addr, "8-bit ALU not in slice");
        const regField = (b[i] >> 3) & 7;
        const m = decodeModrm(b, i); i += m.len;
        return fin({ kind: dir ? "alu_r_rm" : "alu_rm_r", alu, size, m, reg: regField });
    }
    // ── ALU acc,imm ────────────────────────────────────────────────────────
    if ((op & 7) === 4 || (op & 7) === 5) {
        const alu = ALU_BY_OP[op & 0x38];
        if (op < 0x40 && alu !== undefined) {
            if (alu === "adc" || alu === "sbb") return un(addr, `${alu} not in slice`);
            const size = (op & 1) ? 32 : 8;
            if (size === 8) return un(addr, "8-bit ALU not in slice");
            const imm = s32(b, i); i += 4;
            return fin({ kind: "alu_acc_imm", alu, size, imm });
        }
    }
    // ── INC/DEC r32 ────────────────────────────────────────────────────────
    if (op >= 0x40 && op <= 0x4F) return fin({ kind: op < 0x48 ? "inc_r" : "dec_r", reg: op & 7 });
    // ── PUSH/POP r32 ───────────────────────────────────────────────────────
    if (op >= 0x50 && op <= 0x57) return fin({ kind: "push_r", reg: op & 7 });
    if (op >= 0x58 && op <= 0x5F) return fin({ kind: "pop_r", reg: op & 7 });
    // ── PUSH imm ───────────────────────────────────────────────────────────
    if (op === 0x68) { const imm = s32(b, i); i += 4; return fin({ kind: "push_imm", imm }); }
    if (op === 0x6A) { const imm = s8(b[i]); i += 1; return fin({ kind: "push_imm", imm }); }
    // ── Jcc rel8 ───────────────────────────────────────────────────────────
    if (op >= 0x70 && op <= 0x7F) {
        const rel = s8(b[i]); i += 1;
        return fin({ kind: "jcc", cond: op & 0xF, target: addr + (i - off) + rel, rel, rel32: false });
    }
    // ── Group 1: ALU r/m, imm ──────────────────────────────────────────────
    if (op === 0x80 || op === 0x81 || op === 0x83) {
        const regField = (b[i] >> 3) & 7;
        const alu = ALU_BY_REG[regField];
        const m = decodeModrm(b, i); i += m.len;
        if (alu === "adc" || alu === "sbb") return un(addr, `${alu} imm not in slice`);
        const size = op === 0x80 ? 8 : 32;
        if (size === 8) return un(addr, "8-bit ALU not in slice");
        let imm;
        if (op === 0x81) { imm = s32(b, i); i += 4; }
        else { imm = s8(b[i]); i += 1; if (size === 8) imm &= 0xFF; }
        return fin({ kind: "alu_rm_imm", alu, size, m, imm });
    }
    // ── TEST r/m,r ─────────────────────────────────────────────────────────
    if (op === 0x84 || op === 0x85) {
        const regField = (b[i] >> 3) & 7;
        if (op === 0x84) return un(addr, "8-bit TEST not in slice");
        const m = decodeModrm(b, i); i += m.len;
        return fin({ kind: "test_rm_r", size: 32, m, reg: regField });
    }
    // ── MOV r/m <-> r ──────────────────────────────────────────────────────
    if (op >= 0x88 && op <= 0x8B) {
        const regField = (b[i] >> 3) & 7;
        const m = decodeModrm(b, i); i += m.len;
        const dir = (op >> 1) & 1;
        return fin({ kind: dir ? "mov_r_rm" : "mov_rm_r", size: (op & 1) ? 32 : 8, m, reg: regField });
    }
    // ── LEA ────────────────────────────────────────────────────────────────
    if (op === 0x8D) {
        const regField = (b[i] >> 3) & 7;
        const m = decodeModrm(b, i); i += m.len;
        if (m.isReg) return un(addr, "lea with register operand");
        return fin({ kind: "lea", m, reg: regField });
    }
    if (op === 0x90) return fin({ kind: "nop" });
    // ── MOV r8/r32, imm ────────────────────────────────────────────────────
    if (op >= 0xB0 && op <= 0xB7) { const imm = b[i]; i += 1; return fin({ kind: "mov_r8_imm", reg: op & 7, imm }); }
    if (op >= 0xB8 && op <= 0xBF) { const imm = s32(b, i); i += 4; return fin({ kind: "mov_r32_imm", reg: op & 7, imm }); }
    // ── Shift group ────────────────────────────────────────────────────────
    if (op === 0xC0 || op === 0xC1 || op === 0xD0 || op === 0xD1 || op === 0xD2 || op === 0xD3) {
        const regField = (b[i] >> 3) & 7;
        const sh = SHIFT_BY_REG[regField];
        const m = decodeModrm(b, i); i += m.len;
        if (!sh) return un(addr, `shift /${regField} not in slice`);
        const size = (op & 1) ? 32 : 8;
        if (size !== 32) return un(addr, "8-bit shift not in slice");
        let count = null;
        if (op === 0xC0 || op === 0xC1) { count = { imm: b[i] & 31 }; i += 1; }
        else if (op === 0xD0 || op === 0xD1) count = { imm: 1 };
        else count = { cl: true };
        return fin({ kind: "shift", sh, size, m, count });
    }
    // ── RET ────────────────────────────────────────────────────────────────
    if (op === 0xC3) return fin({ kind: "ret", pop: 0 });
    if (op === 0xC2) { const n = b[i] | (b[i + 1] << 8); i += 2; return fin({ kind: "ret", pop: n }); }
    // ── MOV r/m, imm ───────────────────────────────────────────────────────
    if (op === 0xC6 || op === 0xC7) {
        const regField = (b[i] >> 3) & 7;
        const m = decodeModrm(b, i); i += m.len;
        if (regField !== 0) return un(addr, `C${op === 0xC6 ? 6 : 7} /${regField}`);
        const size = op === 0xC7 ? 32 : 8;
        let imm;
        if (size === 32) { imm = s32(b, i); i += 4; } else { imm = b[i]; i += 1; }
        return fin({ kind: "mov_rm_imm", size, m, imm });
    }
    // ── JMP rel ────────────────────────────────────────────────────────────
    if (op === 0xE9) { const rel = s32(b, i); i += 4; return fin({ kind: "jmp", target: addr + (i - off) + rel, rel, rel32: true }); }
    if (op === 0xEB) { const rel = s8(b[i]); i += 1; return fin({ kind: "jmp", target: addr + (i - off) + rel, rel, rel32: false }); }
    // ── Group 3 ────────────────────────────────────────────────────────────
    if (op === 0xF6 || op === 0xF7) {
        const regField = (b[i] >> 3) & 7;
        const m = decodeModrm(b, i); i += m.len;
        const size = op === 0xF7 ? 32 : 8;
        if (regField === 0) {
            if (size === 8) return un(addr, "8-bit TEST not in slice");
            const imm = s32(b, i); i += 4;
            return fin({ kind: "test_rm_imm", size, m, imm });
        }
        if (regField === 2) {
            if (size === 8) return un(addr, "8-bit NOT not in slice");
            return fin({ kind: "not", size, m });
        }
        if (regField === 3 && size === 32) return fin({ kind: "neg", size, m });
        return un(addr, `F${op === 0xF6 ? 6 : 7} /${regField} not in slice`);
    }
    // ── Group 4/5 (INC/DEC r/m) ────────────────────────────────────────────
    if (op === 0xFE || op === 0xFF) {
        const regField = (b[i] >> 3) & 7;
        const m = decodeModrm(b, i); i += m.len;
        const size = op === 0xFF ? 32 : 8;
        if (size === 8) return un(addr, "8-bit INC/DEC not in slice");
        if (regField === 0) return fin({ kind: "inc_rm", size, m });
        if (regField === 1) return fin({ kind: "dec_rm", size, m });
        return un(addr, `F${op === 0xFE ? "E" : "F"} /${regField} not in slice`);
    }
    // ── 0F escape ──────────────────────────────────────────────────────────
    if (op === 0x0F) {
        const op2 = b[i++];
        if (op2 >= 0x80 && op2 <= 0x8F) {
            const rel = s32(b, i); i += 4;
            return fin({ kind: "jcc", cond: op2 & 0xF, target: addr + (i - off) + rel, rel, rel32: true, opcode: 0x100 | op2 });
        }
        if (op2 >= 0x90 && op2 <= 0x9F) {
            const m = decodeModrm(b, i); i += m.len;
            return fin({ kind: "setcc", cond: op2 & 0xF, m, opcode: 0x100 | op2 });
        }
        if (op2 === 0xB6 || op2 === 0xB7 || op2 === 0xBE || op2 === 0xBF) {
            const regField = (b[i] >> 3) & 7;
            const m = decodeModrm(b, i); i += m.len;
            return fin({
                kind: "movx", srcSize: (op2 & 1) ? 16 : 8, signed: op2 >= 0xBE, m, reg: regField,
                opcode: 0x100 | op2,
            });
        }
        return un(addr, `0f ${op2.toString(16)}`);
    }
    return un(addr, `opcode 0x${op.toString(16)}`);
}

/** Control-flow classification, used by block discovery. */
export function terminator(ins) {
    switch (ins.kind) {
        case "jcc": return { type: "cond", target: ins.target };
        case "jmp": return { type: "jmp", target: ins.target };
        case "ret": return { type: "absolute" };
        default: return null;
    }
}
