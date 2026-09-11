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
import * as MMU from "./mmu.mjs";

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
    pushEax() { return this.i().b(0x50); }
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
    /** push imm32 */
    pushImm32(v) { return this.i().b(0x68).u32(v); }
    /** push <address of label> — the stand-in return address for an inlined cdecl body. */
    pushLabelAddr(label) {
        this.i().b(0x68);
        this.patches.push({ at: this.o, sz: 4, end: this.o + 4, to: label, absolute: true });
        return this.b(0, 0, 0, 0);
    }
    /** lea esp, [esp+disp8] — cdecl cleanup that does NOT touch flags.
     *  `add esp, imm8` would, and the captured flags would then be the wrapper's rather than the
     *  kernel's, making them uncomparable against any arm that stops at the kernel's last
     *  instruction. */
    leaEspEspDisp8(v) {
        if (v < -128 || v > 127) throw new Error(`lea esp displacement ${v} does not fit in a byte`);
        return this.i().b(0x8D, 0x64, 0x24, v & 0xff);
    }

    // ── MMU-scenario ops (emitted only into an image built with a scenario) ──
    /** mov eax, esp */
    movEaxEsp() { return this.i().b(0x89, 0xE0); }
    /** mov eax, [esp+disp8] — the only way to read the frame the CPU pushed for an exception. */
    movEaxEspDisp8(disp) { return this.i().b(0x8B, 0x44, 0x24, disp & 0xff); }
    /** mov eax, cr2 — the faulting linear address. */
    movEaxCr2() { return this.i().b(0x0F, 0x20, 0xD0); }
    /** mov ax, imm16 */
    movAxImm16(v) { return this.i().b(0x66, 0xB8).u16(v); }
    /** mov <sreg>, ax */
    movSregAx(name) {
        const modrm = { es: 0xC0, cs: 0xC8, ss: 0xD0, ds: 0xD8, fs: 0xE0, gs: 0xE8 }[name];
        if (modrm === undefined) throw new Error(`bad sreg ${name}`);
        return this.i().b(0x8E, modrm);
    }
    lgdt(addr) { return this.i().b(0x0F, 0x01, 0x15).u32(addr); }
    lidt(addr) { return this.i().b(0x0F, 0x01, 0x1D).u32(addr); }
    invlpg(addr) { return this.i().b(0x0F, 0x01, 0x3D).u32(addr); }
    /** jmp far selector:label — an absolute far pointer, so the label is patched as an ADDRESS. */
    jmpFar(selector, label) {
        this.i().b(0xEA);
        this.patches.push({ at: this.o, sz: 4, end: this.o + 4, to: label, absolute: true });
        this.b(0, 0, 0, 0);
        return this.u16(selector);
    }

    finish() {
        for (const p of this.patches) {
            if (!this.labels.has(p.to)) throw new Error(`undefined label ${p.to}`);
            if (p.absolute) { this.dv.setUint32(p.at, this.labels.get(p.to) >>> 0, true); continue; }
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
 * @param {{warmup:number, n1:number, n2:number, oneCall?:boolean}} phases outer-iteration counts
 */
export function buildImage(c, { warmup, n1, n2, oneCall = false, mmu = null }) {
    // A scenario image is larger (descriptor tables, the #PF handler, the fault record) and a
    // baseline image must not be: an image built without `mmu` is byte-identical to what it
    // was before scenarios existed, so no timing arm silently moved onto a fault fixture.
    // Derived, not constant: a case whose code or data sits above the historical IMAGE_END
    // (k8 does) must still be inside the multiboot blob. Every pre-existing case is below it, so
    // their images stay byte-identical and no timing baseline moves because a case was added.
    const caseEnd = c.imageEnd ?? L.IMAGE_END;
    const imageEnd = Math.max(L.IMAGE_END, caseEnd, mmu ? L.MMU_IMAGE_END : 0);
    const size = imageEnd - L.CODE_BASE;
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
        if (call.stackArgs) {
            // A body extracted WITH its own prologue rebuilds EBP from ESP and reads its
            // arguments off the stack, so seeding registers cannot reach them. The wrapper
            // therefore builds a genuine cdecl frame: arguments pushed right-to-left, then a
            // stand-in return address, so [ebp+8] lands on the first argument exactly as it
            // would at the real call site. The body's own `ret` returns to `after`.
            const after = `${name}_after`;
            for (const v of [...call.stackArgs].reverse()) a.pushImm32(v);
            a.pushLabelAddr(after);
            a.raw(c.body);
            a.label(after);
            a.leaEspEspDisp8(call.stackArgs.length * 4);   // cdecl: the caller cleans up (lea, not add: see the op)
            a.ret();
        } else {
            for (const op of call.prologue) emitOp(a, op);
            a.raw(c.body);
            a.ret();
        }
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
    // A pre-paging patch has to land after the identity-map loops (which would overwrite it)
    // and before CR0.PG, so the mapping was never anything else as far as the CPU is concerned.
    if (mmu && mmu.scenario.when === "pre-paging") MMU.emitPatches(a, mmu.patches, { invalidate: false });
    a.movImm(REG.eax, L.PD_ADDR);
    a.movCr3Eax();
    a.movEaxCr0();
    a.orEaxImm(0x80000000);
    a.movCr0Eax();
    a.movEspImm(L.STACK_TOP);

    if (mmu) {
        // Descriptor tables first: without them a #PF has no gate to reach and triple-faults,
        // destroying the very state the scenario exists to read.
        MMU.emitInstallTables(a);
        if (mmu.scenario.wp) MMU.emitEnableWp(a);
        // `post-paging` patches run here, with paging live and the TLB already warm, which is
        // the mapping-CHANGED case; `pre-paging` ones were emitted before CR0.PG below.
        if (mmu.scenario.when === "post-paging") {
            // Touch first: a scenario about a mapping CHANGE needs a cached translation to
            // change, and without one it is indistinguishable from a page that was never mapped.
            MMU.emitTouch(a, mmu.touch);
            MMU.emitPatches(a, mmu.patches, { invalidate: mmu.scenario.invalidate !== false });
            // AFTER the change, so the entry that gets cached is the NEW mapping. That is the
            // difference between "the page is unmapped, decline for any reason" and "the page is
            // mapped, and only its permission refuses the access".
            MMU.emitTouch(a, mmu.touchAfter ?? []);
            MMU.emitTouchWrite(a, mmu.touchWriteAfter ?? []);
        }
    }

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

    if (!oneCall) {
        phase("warm", warmup);
        marker(1);
        phase("p1", n1);
        marker(2);
        phase("p2", n2);
        marker(3);
    }

    // ── capture point ──────────────────────────────────────────────────────
    // The normal driver performs one additional full outer iteration outside measured phases.
    // One-call conformance instead performs exactly the first wrapper call of the selected
    // case, after the identical paging/setup sequence. It intentionally emits no markers and
    // no timing phases: its only output is canonical architectural conformance data.
    if (oneCall) a.call(calls[0]);
    else for (const x of calls) a.call(x);
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

    // codeEnd bounds the DRIVER's code. The #PF handler deliberately sits outside it, on its
    // own page above the data image, so a scenario cannot move the driver's extent.
    const codeEnd = a.addr;
    if (mmu) MMU.emitFaultHandler(a);
    a.finish();

    // ── data ───────────────────────────────────────────────────────────────
    L.writeDataImage(new DataView(buf.buffer), L.CODE_BASE, imageEnd);
    if (mmu) MMU.writeMmuData(new DataView(buf.buffer), L.CODE_BASE, L.MMU_CODE);

    const oneCallWork = oneCall ? {
        calls: 1,
        body_iterations: c.iters,
        // The instructions ONE call of the body retires. `iters * insPerIter` is that only for a
        // body whose cost is a multiple of a per-iteration cost; a body carrying its own
        // prologue, loop guard and epilogue states `insPerCall`, and reporting the product for
        // it would put two disagreeing accountings in the same `work` object.
        body_instructions: callBodyIns(c),
        analytic_instructions: wrapperIns(c.calls[0]) + callBodyIns(c),
    } : null;
    return { buf, codeEnd, captureEip, insPerOuter: insPerOuter(c), oneCallWork, imageEnd, mmu };
}

/**
 * Guest instructions retired per outer iteration (analytic, exact).
 *
 * The default shape is "register prologue, straight-line body, ret", whose body retires
 * `iters * insPerIter`. A body extracted WITH its own prologue, loop guard and epilogue does not
 * fit that: its per-call cost is not a multiple of a per-iteration cost, and pretending it is
 * would put a wrong denominator under every rate and a wrong number in the work ledger. Such a
 * case states its own exact per-call count in `insPerCall`.
 */
export function insPerOuter(c) {
    let n = 0;
    for (const call of c.calls) n += wrapperIns(call) + callBodyIns(c);
    return n + c.calls.length + 4;   /* push + N*call + pop + dec + jnz */
}

/** Instructions the wrapper itself retires around the body. */
function wrapperIns(call) {
    return call.stackArgs
        ? call.stackArgs.length + 1 /* args + the stand-in return address */ + 2 /* lea esp, ret */
        : call.prologue.length + 1 /* ret */;
}

/** Instructions one call of the body retires, from its first byte to its last. */
function callBodyIns(c) {
    return c.insPerCall ?? c.iters * c.insPerIter;
}
