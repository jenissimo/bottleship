// 32-bit x86 decoder for the integer subset compilers emit (plus IN/OUT/HLT). Anything else
// decodes as { m: "unsup" } with its best-effort length (so the walk can report it) and becomes
// an honest side exit in the translator. Lengths are cross-checked against dumpbin
// (check-decoder.mjs).
//
// Operand: { k:"r", r, sz }  (sz 8: r 0-3 = AL..BL, 4-7 = AH..BH)
//          { k:"m", base, idx, sc, disp, sz }  (base/idx = -1 when absent)
//          { k:"i", v, sz }   (v already sign/zero-extended to 32 bits, as an unsigned number)
export const REG = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
export const ALU = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
export const SHIFT = ["rol", "ror", "rcl", "rcr", "shl", "shr", "shl", "sar"];
export const CC = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];

export function decode(rd, addr) {
    let p = addr;
    let os = 32, rep = 0, seg = 0, lock = 0;
    const u8 = () => { const v = rd(p++); if (v < 0) throw new RangeError("decode past image"); return v; };
    const s8 = () => (u8() << 24) >> 24;
    const u16 = () => u8() | (u8() << 8);
    const u32 = () => (u8() | (u8() << 8) | (u8() << 16) | (u8() << 24)) >>> 0;
    const s32 = () => u32() | 0;
    for (;;) {
        const b = rd(p);
        if (b === 0x66) { os = 16; p++; } else if (b === 0xf3 || b === 0xf2) { rep = b; p++; }
        else if (b === 0x2e || b === 0x3e || b === 0x26 || b === 0x36) p++;
        else if (b === 0x64 || b === 0x65) { seg = b; p++; } else if (b === 0xf0) { lock = 1; p++; } else break;
        if (p - addr > 14) break;
    }
    const ins = { addr, os, rep, seg, lock };
    const fin = (o) => { Object.assign(ins, o); ins.len = p - addr; ins.next = (addr + ins.len) >>> 0; if (seg && ins.m !== "unsup") { ins.m = "unsup"; ins.why = "segment prefix"; } return ins; };
    const unsup = (why) => fin({ m: "unsup", why });
    let modrm = null;
    const rm = (sz) => {
        const m = u8();
        const mod = m >> 6, reg = (m >> 3) & 7, r = m & 7;
        modrm = { mod, reg };
        if (mod === 3) return { k: "r", r, sz };
        let base = -1, idx = -1, sc = 1, disp = 0;
        if (r === 4) {
            const sib = u8();
            sc = 1 << (sib >> 6);
            const i = (sib >> 3) & 7, bs = sib & 7;
            if (i !== 4) idx = i;
            if (bs === 5 && mod === 0) disp = s32(); else base = bs;
        } else if (r === 5 && mod === 0) disp = s32();
        else base = r;
        if (mod === 1) disp = (disp + s8()) | 0;
        else if (mod === 2) disp = (disp + s32()) | 0;
        return { k: "m", base, idx, sc, disp, sz };
    };
    const G = (sz) => ({ k: "r", r: modrm.reg, sz });
    const imm = (sz) => ({ k: "i", v: sz === 8 ? u8() : sz === 16 ? u16() : u32(), sz });
    const immS8 = (sz) => ({ k: "i", v: (s8() >>> 0) & (sz === 16 ? 0xffff : 0xffffffff), sz });
    const R = (r, sz) => ({ k: "r", r, sz });
    const rel8 = () => { const d = s8(); return (p + d) >>> 0; };
    const rel32 = () => { const d = s32(); return (p + d) >>> 0; };

    const op = u8();
    // ALU 00-3F block
    if (op < 0x40 && (op & 7) < 6) {
        const a = ALU[op >> 3], f = op & 7;
        if (f === 0) { const d = rm(8); return fin({ m: "alu", a, dst: d, src: G(8) }); }
        if (f === 1) { const d = rm(os); return fin({ m: "alu", a, dst: d, src: G(os) }); }
        if (f === 2) { const s = rm(8); return fin({ m: "alu", a, dst: G(8), src: s }); }
        if (f === 3) { const s = rm(os); return fin({ m: "alu", a, dst: G(os), src: s }); }
        if (f === 4) return fin({ m: "alu", a, dst: R(0, 8), src: imm(8) });
        return fin({ m: "alu", a, dst: R(0, os), src: imm(os) });
    }
    if (op >= 0x40 && op <= 0x47) return fin({ m: "inc", dst: R(op & 7, os) });
    if (op >= 0x48 && op <= 0x4f) return fin({ m: "dec", dst: R(op & 7, os) });
    if (op >= 0x50 && op <= 0x57) return fin({ m: "push", src: R(op & 7, os) });
    if (op >= 0x58 && op <= 0x5f) return fin({ m: "pop", dst: R(op & 7, os) });
    if (op >= 0x70 && op <= 0x7f) { const t = rel8(); return fin({ m: "jcc", cc: op & 15, target: t }); }
    if (op >= 0x91 && op <= 0x97) return fin({ m: "xchg", dst: R(0, os), src: R(op & 7, os) });
    if (op >= 0xb0 && op <= 0xb7) return fin({ m: "mov", dst: R(op & 7, 8), src: imm(8) });
    if (op >= 0xb8 && op <= 0xbf) return fin({ m: "mov", dst: R(op & 7, os), src: imm(os) });
    switch (op) {
        case 0x68: return fin({ m: "push", src: imm(os) });
        case 0x6a: return fin({ m: "push", src: immS8(os) });
        case 0x69: { const s = rm(os); return fin({ m: "imul3", dst: G(os), src: s, imm: imm(os) }); }
        case 0x6b: { const s = rm(os); return fin({ m: "imul3", dst: G(os), src: s, imm: immS8(os) }); }
        case 0x80: case 0x82: { const d = rm(8); return fin({ m: "alu", a: ALU[modrm.reg], dst: d, src: imm(8) }); }
        case 0x81: { const d = rm(os); return fin({ m: "alu", a: ALU[modrm.reg], dst: d, src: imm(os) }); }
        case 0x83: { const d = rm(os); return fin({ m: "alu", a: ALU[modrm.reg], dst: d, src: immS8(os) }); }
        case 0x84: { const d = rm(8); return fin({ m: "test", dst: d, src: G(8) }); }
        case 0x85: { const d = rm(os); return fin({ m: "test", dst: d, src: G(os) }); }
        case 0x86: { const d = rm(8); return fin({ m: "xchg", dst: d, src: G(8) }); }
        case 0x87: { const d = rm(os); return fin({ m: "xchg", dst: d, src: G(os) }); }
        case 0x88: { const d = rm(8); return fin({ m: "mov", dst: d, src: G(8) }); }
        case 0x89: { const d = rm(os); return fin({ m: "mov", dst: d, src: G(os) }); }
        case 0x8a: { const s = rm(8); return fin({ m: "mov", dst: G(8), src: s }); }
        case 0x8b: { const s = rm(os); return fin({ m: "mov", dst: G(os), src: s }); }
        case 0x8d: { const s = rm(os); if (s.k !== "m") return unsup("lea reg"); return fin({ m: "lea", dst: G(os), src: s }); }
        case 0x8f: { const d = rm(os); if (modrm.reg !== 0) return unsup("8f"); return fin({ m: "pop", dst: d }); }
        case 0x90: return fin({ m: rep === 0xf3 ? "pause" : "nop" });
        case 0x98: return fin({ m: os === 16 ? "cbw" : "cwde" });
        case 0x99: return fin({ m: os === 16 ? "cwd" : "cdq" });
        case 0xa0: { const a = u32(); return fin({ m: "mov", dst: R(0, 8), src: { k: "m", base: -1, idx: -1, sc: 1, disp: a | 0, sz: 8 } }); }
        case 0xa1: { const a = u32(); return fin({ m: "mov", dst: R(0, os), src: { k: "m", base: -1, idx: -1, sc: 1, disp: a | 0, sz: os } }); }
        case 0xa2: { const a = u32(); return fin({ m: "mov", src: R(0, 8), dst: { k: "m", base: -1, idx: -1, sc: 1, disp: a | 0, sz: 8 } }); }
        case 0xa3: { const a = u32(); return fin({ m: "mov", src: R(0, os), dst: { k: "m", base: -1, idx: -1, sc: 1, disp: a | 0, sz: os } }); }
        case 0xa4: case 0xa5: return fin({ m: "movs", sz: op === 0xa4 ? 8 : os });
        case 0xaa: case 0xab: return fin({ m: "stos", sz: op === 0xaa ? 8 : os });
        case 0xa8: return fin({ m: "test", dst: R(0, 8), src: imm(8) });
        case 0xa9: return fin({ m: "test", dst: R(0, os), src: imm(os) });
        case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
            const sz = op & 1 ? os : 8;
            const d = rm(sz);
            const a = SHIFT[modrm.reg];
            const cnt = op <= 0xc1 ? { k: "i", v: u8() & 31, sz: 8 } : op <= 0xd1 ? { k: "i", v: 1, sz: 8 } : R(1, 8);
            return fin({ m: "shift", a, dst: d, src: cnt });
        }
        case 0xc2: { const n = u16(); return fin({ m: "ret", pop: n }); }
        case 0xc3: return fin({ m: "ret", pop: 0 });
        case 0xc6: { const d = rm(8); if (modrm.reg !== 0) return unsup("c6"); return fin({ m: "mov", dst: d, src: imm(8) }); }
        case 0xc7: { const d = rm(os); if (modrm.reg !== 0) return unsup("c7"); return fin({ m: "mov", dst: d, src: imm(os) }); }
        case 0xc9: return fin({ m: "leave" });
        case 0xcc: return fin({ m: "int3" });
        case 0xe8: { const t = rel32(); return fin({ m: "call", target: t }); }
        case 0xe9: { const t = rel32(); return fin({ m: "jmp", target: t }); }
        case 0xeb: { const t = rel8(); return fin({ m: "jmp", target: t }); }
        case 0xe4: case 0xe5: { const port = u8(); return fin({ m: "in", sz: op === 0xe4 ? 8 : os, port }); }
        case 0xe6: case 0xe7: { const port = u8(); return fin({ m: "out", sz: op === 0xe6 ? 8 : os, port }); }
        case 0xec: case 0xed: return fin({ m: "in", sz: op === 0xec ? 8 : os, port: -1 });
        case 0xee: case 0xef: return fin({ m: "out", sz: op === 0xee ? 8 : os, port: -1 });
        case 0xf4: return fin({ m: "hlt" });
        case 0xf6: case 0xf7: {
            const sz = op === 0xf6 ? 8 : os;
            const d = rm(sz);
            switch (modrm.reg) {
                case 0: case 1: return fin({ m: "test", dst: d, src: imm(sz) });
                case 2: return fin({ m: "not", dst: d });
                case 3: return fin({ m: "neg", dst: d });
                case 4: return fin({ m: "mul1", src: d });
                case 5: return fin({ m: "imul1", src: d });
                case 6: return fin({ m: "div", src: d });
                default: return fin({ m: "idiv", src: d });
            }
        }
        case 0xf5: return fin({ m: "cmc" });
        case 0xf8: return fin({ m: "clc" });
        case 0xf9: return fin({ m: "stc" });
        case 0xfc: return fin({ m: "cld" });
        case 0xfe: { const d = rm(8); if (modrm.reg === 0) return fin({ m: "inc", dst: d }); if (modrm.reg === 1) return fin({ m: "dec", dst: d }); return unsup("fe"); }
        case 0xff: {
            const d = rm(os);
            switch (modrm.reg) {
                case 0: return fin({ m: "inc", dst: d });
                case 1: return fin({ m: "dec", dst: d });
                case 2: return fin({ m: "callind", src: d });
                case 4: return fin({ m: "jmpind", src: d });
                case 6: return fin({ m: "push", src: d });
                default: return unsup("ff /" + modrm.reg);
            }
        }
        case 0x0f: {
            const o2 = u8();
            if (o2 >= 0x80 && o2 <= 0x8f) { const t = rel32(); return fin({ m: "jcc", cc: o2 & 15, target: t }); }
            if (o2 >= 0x90 && o2 <= 0x9f) { const d = rm(8); return fin({ m: "setcc", cc: o2 & 15, dst: d }); }
            if (o2 >= 0x40 && o2 <= 0x4f) { const s = rm(os); return fin({ m: "cmov", cc: o2 & 15, dst: G(os), src: s }); }
            if (o2 >= 0xc8 && o2 <= 0xcf) return fin({ m: "bswap", dst: R(o2 & 7, 32) });
            switch (o2) {
                case 0x1f: rm(os); return fin({ m: "nop" });
                case 0xaf: { const s = rm(os); return fin({ m: "imul2", dst: G(os), src: s }); }
                case 0xb6: { const s = rm(8); return fin({ m: "movzx", dst: G(os), src: s }); }
                case 0xb7: { const s = rm(16); return fin({ m: "movzx", dst: G(os), src: s }); }
                case 0xbe: { const s = rm(8); return fin({ m: "movsx", dst: G(os), src: s }); }
                case 0xbf: { const s = rm(16); return fin({ m: "movsx", dst: G(os), src: s }); }
                case 0xa4: { const d = rm(os); const g = G(os); return fin({ m: "shld", dst: d, src: g, cnt: { k: "i", v: u8() & 31, sz: 8 } }); }
                case 0xa5: { const d = rm(os); return fin({ m: "shld", dst: d, src: G(os), cnt: R(1, 8) }); }
                case 0xac: { const d = rm(os); const g = G(os); return fin({ m: "shrd", dst: d, src: g, cnt: { k: "i", v: u8() & 31, sz: 8 } }); }
                case 0xad: { const d = rm(os); return fin({ m: "shrd", dst: d, src: G(os), cnt: R(1, 8) }); }
                case 0xa2: return fin({ m: "unsup", why: "cpuid" });
                default: return unsup("0f " + o2.toString(16));
            }
        }
        case 0x9b: return fin({ m: "nop" }); // fwait
        default:
            if (op >= 0xd8 && op <= 0xdf) return decodeX87(op);
            return unsup("op " + op.toString(16));
    }

    // x87 (stage 2). {m:"fpu", f, mem?:{...,ft}, i?, dst?, op?, pop}
    function decodeX87(op) {
        const ARITH = ["add", "mul", "com", "comp", "sub", "subr", "div", "divr"];
        const mo = rm(32);
        const r = modrm.reg;
        const X = (o) => fin({ m: "fpu", ...o });
        const M = (ft, sz) => { mo.sz = sz; mo.ft = ft; return mo; };
        const bad = () => unsup("x87 " + op.toString(16) + "/" + r + (mo.k === "r" ? " reg" + mo.r : ""));
        if (mo.k === "m") {
            switch (op) {
                case 0xd8: case 0xdc: case 0xda: case 0xde: {
                    const ft = op === 0xd8 ? "f32" : op === 0xdc ? "f64" : op === 0xda ? "i32" : "i16";
                    const sz = ft === "f64" ? 64 : ft === "i16" ? 16 : 32;
                    const a = ARITH[r];
                    if (a === "com" || a === "comp") return X({ f: "fcom", mem: M(ft, sz), pop: a === "comp" ? 1 : 0 });
                    return X({ f: "farith", op: a, mem: M(ft, sz), dst: 0, pop: 0 });
                }
                case 0xd9:
                    if (r === 0) return X({ f: "fld", mem: M("f32", 32) });
                    if (r === 2 || r === 3) return X({ f: "fst", mem: M("f32", 32), pop: r === 3 ? 1 : 0 });
                    if (r === 5) return X({ f: "fldcw", mem: M("i16", 16) });
                    if (r === 7) return X({ f: "fnstcw", mem: M("i16", 16) });
                    return bad();
                case 0xdb:
                    if (r === 0) return X({ f: "fild", mem: M("i32", 32) });
                    if (r === 1) return X({ f: "fist", mem: M("i32", 32), pop: 1, trunc: true });
                    if (r === 2 || r === 3) return X({ f: "fist", mem: M("i32", 32), pop: r === 3 ? 1 : 0 });
                    return bad();
                case 0xdd:
                    if (r === 0) return X({ f: "fld", mem: M("f64", 64) });
                    if (r === 1) return X({ f: "fist", mem: M("i64", 64), pop: 1, trunc: true });
                    if (r === 2 || r === 3) return X({ f: "fst", mem: M("f64", 64), pop: r === 3 ? 1 : 0 });
                    return bad();
                case 0xdf:
                    if (r === 0) return X({ f: "fild", mem: M("i16", 16) });
                    if (r === 1) return X({ f: "fist", mem: M("i16", 16), pop: 1, trunc: true });
                    if (r === 2 || r === 3) return X({ f: "fist", mem: M("i16", 16), pop: r === 3 ? 1 : 0 });
                    if (r === 5) return X({ f: "fild", mem: M("i64", 64) });
                    if (r === 7) return X({ f: "fist", mem: M("i64", 64), pop: 1 });
                    return bad();
            }
            return bad();
        }
        const i = mo.r;
        switch (op) {
            case 0xd8: {
                const a = ARITH[r];
                if (a === "com" || a === "comp") return X({ f: "fcom", i, pop: a === "comp" ? 1 : 0 });
                return X({ f: "farith", op: a, i, dst: 0, pop: 0 });
            }
            case 0xdc: case 0xde: {
                const pop = op === 0xde ? 1 : 0;
                if (r === 2 || r === 3) { if (op === 0xde && !(r === 3 && i === 1)) return bad(); return X({ f: "fcom", i, pop: op === 0xde ? 2 : r === 3 ? 1 : 0 }); }
                // dst = st(i), src = st0:  /4 st(i)=st0-st(i) (subr)  /5 st(i)=st(i)-st0 (sub)  /6 divr  /7 div
                // SDM: DC/DE E0+i = FSUBR(P) st(i),st0 (st(i) = st0 - st(i)), E8+i = FSUB(P), F0+i = FDIVR(P), F8+i = FDIV(P)
                return X({ f: "farith", op: ARITH[r >= 4 ? r ^ 1 : r], i, dst: i, pop });
            }
            case 0xd9:
                if (r === 0) return X({ f: "fldst", i });
                if (r === 1) return X({ f: "fxch", i });
                if (r === 4 && i === 0) return X({ f: "fchs" });
                if (r === 4 && i === 1) return X({ f: "fabs" });
                if (r === 5 && i === 0) return X({ f: "fldc", v: 1 });
                if (r === 5 && i === 6) return X({ f: "fldc", v: 0 });
                return bad();
            case 0xdb:
                if (r === 4 && i === 3) return X({ f: "fninit" });
                if (r === 4 && i === 2) return fin({ m: "nop" }); // fnclex
                return bad();
            case 0xdd:
                if (r === 0) return fin({ m: "nop" }); // ffree
                if (r === 2 || r === 3) return X({ f: "fstst", i, pop: r === 3 ? 1 : 0 });
                if (r === 4 || r === 5) return X({ f: "fcom", i, pop: r === 5 ? 1 : 0 });
                return bad();
            case 0xda:
                if (r === 5 && i === 1) return X({ f: "fcom", i: 1, pop: 2 }); // fucompp
                return bad();
            case 0xdf:
                if (r === 4 && i === 0) return X({ f: "fnstsw" });
                return bad();
        }
        return bad();
    }
}

/** Register effects for the ABI-b liveness/validity analysis: bitmasks over the 8 GPRs. */
export function regEffects(ins) {
    let use = 0, def = 0;
    const r32 = (o) => (o.sz === 8 ? o.r & 3 : o.r);
    const useOp = (o) => { if (!o) return; if (o.k === "r") use |= 1 << r32(o); else if (o.k === "m") { if (o.base >= 0) use |= 1 << o.base; if (o.idx >= 0) use |= 1 << o.idx; } };
    const defOp = (o, partial) => { if (o && o.k === "r") { def |= 1 << r32(o); if (partial || o.sz !== 32) use |= 1 << r32(o); } else useOp(o); };
    const ESP = 1 << 4;
    switch (ins.m) {
        case "mov": case "movzx": case "movsx": useOp(ins.src); defOp(ins.dst); break;
        case "lea": useOp(ins.src); defOp(ins.dst); break;
        case "alu": useOp(ins.src); useOp(ins.dst); if (ins.a !== "cmp") defOp(ins.dst, true);
            if ((ins.a === "xor" || ins.a === "sub") && ins.src.k === "r" && ins.dst.k === "r" && ins.src.r === ins.dst.r && ins.src.sz === 32) use &= ~(1 << ins.src.r);
            break;
        case "test": useOp(ins.src); useOp(ins.dst); break;
        case "inc": case "dec": case "not": case "neg": useOp(ins.dst); defOp(ins.dst, true); break;
        case "shift": useOp(ins.src); useOp(ins.dst); defOp(ins.dst, true); break;
        case "shld": case "shrd": useOp(ins.src); useOp(ins.cnt); useOp(ins.dst); defOp(ins.dst, true); break;
        case "imul2": useOp(ins.src); useOp(ins.dst); defOp(ins.dst); break;
        case "imul3": useOp(ins.src); defOp(ins.dst); break;
        case "mul1": case "imul1": useOp(ins.src); use |= 1; def |= 1 | 4; break;
        case "div": case "idiv": useOp(ins.src); use |= 1 | 4; def |= 1 | 4; break;
        case "cdq": use |= 1; def |= 4; break;
        case "cwde": use |= 1; def |= 1; break;
        case "xchg": useOp(ins.src); useOp(ins.dst); defOp(ins.src, true); defOp(ins.dst, true); break;
        case "setcc": defOp(ins.dst, true); break;
        case "cmov": useOp(ins.src); use |= 1 << ins.dst.r; def |= 1 << ins.dst.r; break;
        case "bswap": use |= 1 << ins.dst.r; def |= 1 << ins.dst.r; break;
        case "push": useOp(ins.src); use |= ESP; def |= ESP; break;
        case "pop": use |= ESP; def |= ESP; defOp(ins.dst); break;
        case "leave": use |= 1 << 5; def |= ESP | (1 << 5); break;
        case "call": case "callind": useOp(ins.src); use |= ESP; def |= ESP; break;
        case "ret": use |= ESP; def |= ESP; break;
        case "jmpind": useOp(ins.src); break;
        case "in": use |= 4; def |= 1; break;
        case "out": use |= 4 | 1; break;
        case "movs": use |= (1 << 6) | (1 << 7) | (ins.rep ? 2 : 0); def |= (1 << 6) | (1 << 7) | (ins.rep ? 2 : 0); break;
        case "stos": use |= 1 | (1 << 7) | (ins.rep ? 2 : 0); def |= (1 << 7) | (ins.rep ? 2 : 0); break;
        case "fpu": useOp(ins.mem); if (ins.f === "fnstsw") { use |= 1; def |= 1; } break;
        default: break;
    }
    return { use, def };
}
