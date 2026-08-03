// aot-oracle — multiboot image builder (a.out kludge, v86 cpu.js load_multiboot).
//
// v86 enters the image in 32-bit flat protected mode, CPL0, paging OFF, IF=0. The driver
// then builds a 4KB-page identity map of 0..8MB and turns CR0.PG on, because v86 only
// compiles the fastmem read fast path when (is_32 && protected_mode && CR0.PG) —
// jit.rs fastmem_reads_compile_enabled(). Without paging we would be measuring the TLB shape,
// which BottleShip does NOT run in production.
//
// Promoted from tools/probes/aot-spike/image.mjs. Two differences, both load-bearing for an
// oracle rather than a stopwatch:
//   1. the image is built from a CASE DESCRIPTOR (corpus/cases.mjs), so adding a case is
//      adding a data entry, not editing this file;
//   2. after the last measured phase the driver executes ONE more call (the capture call)
//      and then spills the architectural register file to L.STATE before halting. The
//      capture point is therefore "immediately after the kernel's ret", identical for every
//      arm, and the register file is guest-visible memory that the differential compares
//      like any other region.

import * as L from "./layout.mjs";

class Asm {
    constructor(buf, origin) {
        this.buf = buf;
        this.dv = new DataView(buf.buffer);
        this.origin = origin;
        this.o = 0;
        this.labels = new Map();
        this.patches = [];
        this.count = 0;             // instructions emitted (bookkeeping only)
    }
    at(addr) { this.o = addr - this.origin; return this; }
    get addr() { return this.origin + this.o; }
    label(n) { this.labels.set(n, this.addr); return this; }
    b(...bytes) { for (const x of bytes) this.buf[this.o++] = x & 0xff; return this; }
    u32(v) { this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; return this; }
    u16(v) { this.dv.setUint16(this.o, v & 0xffff, true); this.o += 2; return this; }
    rel8(n) { this.patches.push({ at: this.o, sz: 1, end: this.o + 1, to: n }); return this.b(0); }
    rel32(n) { this.patches.push({ at: this.o, sz: 4, end: this.o + 4, to: n }); return this.b(0, 0, 0, 0); }
    raw(bytes) { for (const x of bytes) this.buf[this.o++] = x; return this; }

    // ── instruction helpers (only what the driver needs) ────────────────────
    i() { this.count++; return this; }
    cld() { return this.i().b(0xFC); }
    fninit() { return this.i().b(0xDB, 0xE3); }
    movImm(reg, v) { return this.i().b(0xB8 + reg).u32(v); }        // reg: 0=eax..7=edi
    movEspImm(v) { return this.movImm(4, v); }
    stosd() { return this.i().b(0xAB); }
    repStosd() { return this.i().b(0xF3, 0xAB); }
    addEaxImm(v) { return this.i().b(0x05).u32(v); }
    orEaxImm(v) { return this.i().b(0x0D).u32(v); }
    xorEaxEax() { return this.i().b(0x31, 0xC0); }
    loopTo(n) { return this.i().b(0xE2).rel8(n); }
    movMemImm32(addr, v) { return this.i().b(0xC7, 0x05).u32(addr).u32(v); }
    movCr3Eax() { return this.i().b(0x0F, 0x22, 0xD8); }
    movEaxCr0() { return this.i().b(0x0F, 0x20, 0xC0); }
    movCr0Eax() { return this.i().b(0x0F, 0x22, 0xC0); }
    movEbpDisp8Imm32(disp, v) { return this.i().b(0xC7, 0x45, disp & 0xff).u32(v); }
    pushEcx() { return this.i().b(0x51); }
    popEcx() { return this.i().b(0x59); }
    popEax() { return this.i().b(0x58); }
    pushfd() { return this.i().b(0x9C); }
    decEcx() { return this.i().b(0x49); }
    call(n) { return this.i().b(0xE8).rel32(n); }
    ret() { return this.i().b(0xC3); }
    jnz8(n) { return this.i().b(0x75).rel8(n); }
    movDxImm16(v) { return this.i().b(0x66, 0xBA).u16(v); }
    movAlImm8(v) { return this.i().b(0xB0, v & 0xff); }
    outDxAl() { return this.i().b(0xEE); }
    hlt() { return this.i().b(0xF4); }
    jmpSelf() { return this.i().b(0xEB, 0xFE); }
    /** mov [disp32], r32 — 0x89 /r, mod=00 rm=101. Clobbers nothing. */
    movMemReg(addr, reg) { return this.i().b(0x89, 0x05 | (reg << 3)).u32(addr); }
    /** mov eax, [disp32] */
    movEaxMem(addr) { return this.i().b(0xA1).u32(addr); }

    finish() {
        for (const p of this.patches) {
            if (!this.labels.has(p.to)) throw new Error(`undefined label ${p.to}`);
            const d = this.labels.get(p.to) - (this.origin + p.end);
            if (p.sz === 1) {
                if (d < -128 || d > 127) throw new Error(`rel8 out of range to ${p.to}: ${d}`);
                this.buf[p.at] = d & 0xff;
            } else {
                this.dv.setInt32(p.at, d, true);
            }
        }
    }
}

export const REG = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };

/** Emit one prologue op of a case's call wrapper. */
function emitOp(a, op) {
    const [kind, x, y] = op;
    if (kind === "mov") { const r = REG[x]; if (r === undefined) throw new Error(`bad reg ${x}`); return a.movImm(r, y); }
    if (kind === "xor" && x === "eax") return a.xorEaxEax();
    if (kind === "mov32") return a.movMemImm32(x, y);
    if (kind === "movEbp8") return a.movEbpDisp8Imm32(x, y);
    throw new Error(`unknown prologue op ${kind}`);
}

/**
 * @param {import("./cases.mjs").Case} c
 * @param {{warmup:number, n1:number, n2:number}} phases outer-iteration counts
 */
export function buildImage(c, { warmup, n1, n2 }) {
    const size = L.IMAGE_END - L.CODE_BASE;
    const buf = new Uint8Array(size);
    const a = new Asm(buf, L.CODE_BASE);

    // ── multiboot header (a.out kludge) ────────────────────────────────────
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    a.at(L.CODE_BASE);
    a.u32(MAGIC); a.u32(FLAGS); a.u32((-(MAGIC + FLAGS)) >>> 0);
    a.u32(L.CODE_BASE);                 // header_addr
    a.u32(L.CODE_BASE);                 // load_addr
    a.u32(L.CODE_BASE + size);          // load_end_addr
    a.u32(L.CODE_BASE + size);          // bss_end_addr
    a.u32(L.CODE_BASE + L.ENTRY_OFF);   // entry_addr

    // ── call wrappers (each case body on its own page, like real .text pages) ─
    const calls = [];
    for (const [i, call] of c.calls.entries()) {
        const name = `${c.id}_${i}`;
        a.at(c.codeAddr + call.off).label(name);
        for (const op of call.prologue) emitOp(a, op);
        a.raw(c.body);
        a.ret();
        calls.push(name);
    }

    // ── driver ─────────────────────────────────────────────────────────────
    a.at(L.CODE_BASE + L.ENTRY_OFF);
    a.cld();
    a.fninit();

    // identity map 0..4MB
    a.movImm(REG.edi, L.PT0_ADDR);
    a.movImm(REG.eax, 0x00000003);
    a.movImm(REG.ecx, 1024);
    a.label("pt0");
    a.stosd(); a.addEaxImm(0x1000); a.loopTo("pt0");
    // identity map 4..8MB
    a.movImm(REG.edi, L.PT1_ADDR);
    a.movImm(REG.eax, 0x00400003);
    a.movImm(REG.ecx, 1024);
    a.label("pt1");
    a.stosd(); a.addEaxImm(0x1000); a.loopTo("pt1");
    // zero the page directory, install both tables
    a.movImm(REG.edi, L.PD_ADDR);
    a.xorEaxEax();
    a.movImm(REG.ecx, 1024);
    a.repStosd();
    a.movMemImm32(L.PD_ADDR + 0, (L.PT0_ADDR | 3) >>> 0);
    a.movMemImm32(L.PD_ADDR + 4, (L.PT1_ADDR | 3) >>> 0);
    a.movImm(REG.eax, L.PD_ADDR);
    a.movCr3Eax();
    a.movEaxCr0();
    a.orEaxImm(0x80000000);
    a.movCr0Eax();
    a.movEspImm(L.STACK_TOP);

    const phase = (label, n) => {
        a.movImm(REG.ecx, n);
        a.label(label);
        a.pushEcx();
        for (const x of calls) a.call(x);
        a.popEcx();
        a.decEcx();
        a.jnz8(label);
    };
    const marker = (v) => {
        a.movDxImm16(L.PORT);   // the kernels clobber edx — reload every time
        a.movAlImm8(v);
        a.outDxAl();
    };

    phase("warm", warmup);
    marker(1);
    phase("p1", n1);
    marker(2);
    phase("p2", n2);
    marker(3);

    // ── capture point ──────────────────────────────────────────────────────
    // One more full outer iteration OUTSIDE any measured phase, so the architectural state
    // at the spill is "right after the kernel's ret" and not "right after an OUT marker
    // clobbered edx/eax". Kernels are idempotent over this image (every call recomputes the
    // same destination bytes from the same source bytes), so the memory image is unchanged.
    for (const x of calls) a.call(x);
    const captureEip = a.addr;
    a.movMemReg(L.STATE + 0x00, REG.eax);
    a.movMemReg(L.STATE + 0x04, REG.ecx);
    a.movMemReg(L.STATE + 0x08, REG.edx);
    a.movMemReg(L.STATE + 0x0c, REG.ebx);
    a.movMemReg(L.STATE + 0x10, REG.esp);
    a.movMemReg(L.STATE + 0x14, REG.ebp);
    a.movMemReg(L.STATE + 0x18, REG.esi);
    a.movMemReg(L.STATE + 0x1c, REG.edi);
    a.pushfd();
    a.popEax();
    a.movMemReg(L.STATE + 0x20, REG.eax);
    a.movEaxMem(L.STATE + 0x00);   // restore eax; neither this nor push/pop touches flags,
    a.hlt();                       // so the host-side snapshot at HLT == the capture point
    a.jmpSelf();

    const codeEnd = a.addr;
    a.finish();

    // ── data ───────────────────────────────────────────────────────────────
    L.writeDataImage(new DataView(buf.buffer), L.CODE_BASE);

    return { buf, codeEnd, captureEip, insPerOuter: insPerOuter(c) };
}

/** Guest instructions retired per outer iteration (analytic, exact). */
export function insPerOuter(c) {
    let n = 0;
    for (const call of c.calls) n += call.prologue.length + c.iters * c.insPerIter + 1 /* ret */;
    return n + c.calls.length + 4;   /* push + N*call + pop + dec + jnz */
}
