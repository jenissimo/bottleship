#!/usr/bin/env bun
/**
 * Permission-bitmap differential.
 *
 * The bitmap is a MIRROR of `tlb_data`, and a mirror that has drifted does not crash: it
 * reads the wrong page, or misses a page fault, and the guest carries on with a plausible
 * wrong value. So this runs the feature OFF against ON on a guest that actually pages, and
 * asserts:
 *
 *   1. **Checksum parity** — the same code over the same paged memory gives the same answer.
 *   2. **Revocation parity** — the guest runs a hot loop over a page until it is COMPILED,
 *      then clears that page's PTE and INVLPGs it, then touches it again. The touch must
 *      fault in both arms, at the same point. This is the assertion the file exists for:
 *      the cheap failure of a permission cache is that a revoked page keeps being served
 *      out of the compiled fast path.
 *   3. **Mirror parity** — `perm_map_rebuild_and_diff()` recomputes every byte from
 *      `tlb_data` and counts disagreements. Checked after fills, invalidations and re-fills.
 *   4. **The path actually ran** — a hit count of zero would mean the whole comparison was
 *      between two identical interpreters.
 *
 * And it is made to fail on purpose: with a byte deliberately corrupted, the mirror check
 * must see it. A differential that cannot fail is not evidence.
 *
 * Sections 1-3 cover mode 1 (the probe in front of the TLB chain). Sections 4-7 cover mode 2,
 * where the byte is the ONLY inline check and the TLB is consulted only by the slow helper —
 * so a stale byte is no longer backstopped by a TLB check behind it. Those sections install
 * an IDT, so a revocation is observed as a #PF with its CR2/error code/EIP, and revoke the
 * page from INSIDE the compiled loop by every route that drops a translation: INVLPG, a CR3
 * reload, and the host route PageTableManager takes (PTE edit + full_clear_tlb from an OUT).
 * Every read width and a page-crossing read are exercised. Section 7 re-arms a stale byte
 * after the host flush and requires the comparison to report the divergence.
 *
 *   bun tools/perm-map-differential.mjs [--baseline <v86.wasm>] [--engine <v86.wasm>] [--dump-dir <dir>]
 *
 * --baseline: an engine built WITHOUT mode 2; mode 0 must emit byte-identical modules to it.
 * --engine:   run every section against this v86.wasm instead of vendor/v86/build's (how the
 *             deliberately-broken engine of a negative control is checked).
 * --dump-dir: write the control workload's compiled modules (mode 0, mode 2, baseline) there,
 *             for op counting or a diff when the identity check fails.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findTlbDataBase } from "./aot/lib/tlb-base.mjs";
import { Asm, mem, abs, reg, EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI } from "./guestbench/lib/asm.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBV86 = resolve(REPO, "vendor/v86/build/libv86.mjs");
if (!existsSync(LIBV86)) {
    console.log("perm-map-differential: SKIP — vendor/v86/build/libv86.mjs absent (run vendor/v86/build-wasm.sh)");
    process.exit(0);
}
const { V86 } = await import(LIBV86);
const baselineArg = process.argv.indexOf("--baseline");
const BASELINE_WASM = baselineArg > 0 ? resolve(process.argv[baselineArg + 1]) : null;
const engineArg = process.argv.indexOf("--engine");
const ENGINE_WASM = engineArg > 0 ? resolve(process.argv[engineArg + 1]) : null;
const dumpArg = process.argv.indexOf("--dump-dir");
const DUMP_DIR = dumpArg > 0 ? resolve(process.argv[dumpArg + 1]) : null;

const BASE = 0x100000, ENTRY_OFF = 0x40, IMG_SIZE = 0x20000;
const STACK_TOP = 0x200000;
const CHECKSUM = BASE + 0x1000;
const PROGRESS = BASE + 0x1010;     // 1 = in the hot loop, 2 = survived it, 3 = revoked, 4 = touched after
const DONE_PORT = 0x9999;

const PD = 0x300000;                // page directory
const PT0 = 0x301000;               // page table for 0..4 MiB, identity
const TEST_VA = 0x00280000;         // inside the identity map, well above the image
const TEST_PTE = PT0 + ((TEST_VA >>> 12) & 0x3ff) * 4;

/** Enough retired instructions to cross v86's JIT_THRESHOLD (200k) several times over. */
const HOT_ITERS = 400_000;

function buildImage({ revoke }) {
    const buf = new Uint8Array(IMG_SIZE);
    const dv = new DataView(buf.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true);
    dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + IMG_SIZE, true);
    dv.setUint32(0x18, BASE + IMG_SIZE, true);
    dv.setUint32(0x1c, BASE + ENTRY_OFF, true);

    const a = new Asm(BASE + ENTRY_OFF);
    a.movImm(ESP, STACK_TOP);

    // Page directory: entry 0 -> PT0 (present|rw|user), rest zero.
    a.movImm(EDI, PD);
    a.movImm(EAX, PT0 | 7);
    a.movTo(mem({ base: EDI }), EAX);
    a.movImm(ECX, 1);
    a.movImm(EAX, 0);
    a.label("pd_zero");
    a.movTo(mem({ base: EDI, index: ECX, scale: 4 }), EAX);
    a.inc(reg(ECX));
    a.aluImm("cmp", reg(ECX), 1024);
    a.jcc("l", "pd_zero");

    // Page table 0: identity map 0..4 MiB (present|rw|user).
    a.movImm(EDI, PT0);
    a.movImm(ECX, 0);
    a.movImm(EAX, 7);
    a.label("pt_fill");
    a.movTo(mem({ base: EDI, index: ECX, scale: 4 }), EAX);
    a.aluImm("add", reg(EAX), 0x1000);
    a.inc(reg(ECX));
    a.aluImm("cmp", reg(ECX), 1024);
    a.jcc("l", "pt_fill");

    // Paging on.
    a.movImm(EAX, PD);
    a.movCrEax(3);
    a.movEaxCr(0);
    a.aluImm("or", reg(EAX), 0x80000000);
    a.movCrEax(0);

    a.movImm(EAX, 1);
    a.movTo(abs(PROGRESS), EAX);

    // Phase 1: hot loop over the test page, long enough that v86 compiles it. This is what
    // puts the bitmap probe into generated code — without it the comparison below would be
    // between two runs of the interpreter.
    a.movImm(ESI, 0);
    a.movImm(EDI, HOT_ITERS);
    a.label("hot");
    a.movImm(EBX, TEST_VA);
    a.movTo(mem({ base: EBX }), EDI);
    a.mov(EDX, mem({ base: EBX }));
    a.mov(ECX, mem({ base: EBX, disp: 0x40 }));
    a.alu("add", ESI, reg(EDX));
    a.alu("xor", ESI, reg(ECX));
    a.imulImm(ESI, reg(ESI), 0x01000193);
    a.dec(reg(EDI));
    a.jccShort("nz", "hot");

    a.movTo(abs(CHECKSUM), ESI);
    a.movImm(EAX, 2);
    a.movTo(abs(PROGRESS), EAX);

    // Phase 2: revoke the mapping the compiled code has been reading, the way a guest does.
    if (revoke) {
        a.movImm(EDI, TEST_PTE);
        a.mov(EAX, mem({ base: EDI }));
        a.aluImm("and", reg(EAX), 0xfffffffe);   // clear the present bit
        a.movTo(mem({ base: EDI }), EAX);
        a.invlpg(abs(TEST_VA));
    }
    a.movImm(EAX, 3);
    a.movTo(abs(PROGRESS), EAX);

    // Phase 3: touch it again. With the mapping revoked this must fault — in BOTH arms.
    a.movImm(EBX, TEST_VA);
    a.mov(EDX, mem({ base: EBX }));
    a.alu("add", ESI, reg(EDX));
    a.movTo(abs(CHECKSUM), ESI);
    a.movImm(EAX, 4);
    a.movTo(abs(PROGRESS), EAX);

    a.movImm(EDX, DONE_PORT);
    a.outDxAl();
    a.hlt();
    a.label("hang");
    a.jmpShort("hang");

    const code = a.link();
    if (ENTRY_OFF + code.length > CHECKSUM - BASE) throw new Error("image code overruns the data area");
    buf.set(code, ENTRY_OFF);
    return buf;
}

function run({ revoke, permMap, corrupt = false, timeoutMs = 60_000 }) {
    return new Promise((res) => {
        const img = buildImage({ revoke });
        const emulator = new V86({ autostart: false, memory_size: 32 * 1024 * 1024, log_level: 0,
            ...(ENGINE_WASM ? { wasm_path: ENGINE_WASM } : {}) });
        let timer, cpu, w, reachedEnd = false, settled = false;
        const finish = (status) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const read32 = (addr) => {
                const b = emulator.read_memory(addr, 4);
                return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
            };
            const out = {
                status, revoke, permMap,
                checksum: read32(CHECKSUM),
                progress: read32(PROGRESS),
                reachedEnd,
                eip: cpu.instruction_pointer[0] >>> 0,
                permHit: Number(w.profiler_dispatch_stat_get(25)),
                permMiss: Number(w.profiler_dispatch_stat_get(26)),
                mirrorMismatches: -1,
            };
            if (corrupt) {
                // Deliberate desync, BEFORE the mirror is checked: it must be seen.
                const view = new Uint8Array(cpu.wasm_memory.buffer);
                view[w.perm_map_base() + (TEST_VA >>> 12)] ^= 0xff;
            }
            out.mirrorMismatches = w.perm_map_rebuild_and_diff() >>> 0;
            try { emulator.stop(); } catch { /* the run is over either way */ }
            res(out);
        };
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu;
            w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            cpu.load_multiboot(img.buffer);
            w.set_dispatch_stats(1);
            w.profiler_init();
            w.set_perm_map_reads(permMap ? 1 : 0);
            cpu.io.register_write(DONE_PORT, cpu, () => { reachedEnd = true; });
            timer = setTimeout(() => finish("stopped"), timeoutMs);
            // A revoked page with no IDT is a triple fault, which v86 surfaces by throwing
            // out of its tick. That IS the observable — both arms must die the same way —
            // so it is caught rather than allowed to kill the process.
            try { emulator.run(); } catch { finish("faulted"); }
            const origTick = emulator.v86.do_tick.bind(emulator.v86);
            emulator.v86.do_tick = () => { try { origTick(); } catch { finish("faulted"); } };
        });
    });
}

const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.log(`  FAIL ${msg}`); } };
const show = (label, r) => console.log(`  ${label.padEnd(12)} status=${r.status} progress=${r.progress} `
    + `checksum=0x${r.checksum.toString(16).padStart(8, "0")} eip=0x${r.eip.toString(16)} `
    + `mirror=${r.mirrorMismatches} hit=${r.permHit} miss=${r.permMiss}`);

console.log("1. control (mapping kept): OFF vs ON");
const ctlOff = await run({ revoke: false, permMap: false });
const ctlOn = await run({ revoke: false, permMap: true });
show("OFF", ctlOff); show("ON", ctlOn);
check(ctlOff.progress === 4 && ctlOn.progress === 4, "the control arms did not run to completion");
check(ctlOff.checksum === ctlOn.checksum,
    `checksum parity: OFF 0x${ctlOff.checksum.toString(16)} vs ON 0x${ctlOn.checksum.toString(16)} — `
    + "the bitmap path read different memory than the TLB path");
check(ctlOn.permHit > 0,
    "the ON arm never took the bitmap path (hit=0), so this comparison is between two identical runs. "
    + "Either the workload never got hot enough to compile, or the probe is not being emitted.");
check(ctlOn.mirrorMismatches === 0, `the bitmap disagrees with tlb_data on ${ctlOn.mirrorMismatches} pages`);
check(ctlOff.mirrorMismatches === 0, `the bitmap drifted with the feature OFF (${ctlOff.mirrorMismatches} pages)`);

console.log("\n2. revocation (PTE cleared + invlpg AFTER the page is compiled): OFF vs ON");
const revOff = await run({ revoke: true, permMap: false });
const revOn = await run({ revoke: true, permMap: true });
show("OFF", revOff); show("ON", revOn);
check(revOff.progress === 3,
    `the OFF arm reached progress=${revOff.progress}; expected 3 (revoked, then died on the touch). `
    + "If it reached 4 the fixture is not revoking anything and nothing below is tested.");
check(revOn.progress === revOff.progress,
    `REVOCATION PARITY BROKEN: OFF stopped at progress=${revOff.progress}, ON at ${revOn.progress}. `
    + "A page whose mapping was revoked is still being served out of the compiled bitmap path.");
check(revOn.eip === revOff.eip, `the arms died at different EIPs (OFF 0x${revOff.eip.toString(16)}, ON 0x${revOn.eip.toString(16)})`);
check(revOn.permHit > 0, "the ON revocation arm never took the bitmap path");
check(revOn.mirrorMismatches === 0, `the bitmap disagrees with tlb_data after a revocation (${revOn.mirrorMismatches} pages)`);

console.log("\n3. self-check: a deliberately corrupted byte must be seen");
const corrupted = await run({ revoke: false, permMap: true, corrupt: true });
show("CORRUPTED", corrupted);
check(corrupted.mirrorMismatches > 0,
    "the mirror check reported 0 mismatches on a map that was corrupted on purpose — it checks nothing");

// ---------------------------------------------------------------------------
// Mode 2 — the permission byte as the ONLY inline check
// ---------------------------------------------------------------------------

const R = {
    DATA: BASE + 0x8000, SCRATCH: BASE + 0x8100,
    GDT: BASE + 0x9000, GDTR: BASE + 0x9040, IDTR: BASE + 0x9048, IDT: BASE + 0x9100,
    PAGE_A: 0x00280000,            // every width is read from here
    CROSS: 0x00290000,             // a dword at CROSS+0xFFE spans CROSS and CROSS+0x1000
    HOST_PORT: 0x9998,
    REVOKE_AT: 1000,               // the loop counts DOWN from HOT_ITERS: long after compile
};
const D = { CHECKSUM: 0x0, PROGRESS: 0x4, ITER: 0x8, VEC: 0xC, CR2: 0x10, ERR: 0x14, EIP: 0x18 };
const pteOf = (va) => PT0 + ((va >>> 12) & 0x3ff) * 4;

function buildReplaceImage({ revoke }) {
    const buf = new Uint8Array(IMG_SIZE);
    const dv = new DataView(buf.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true);
    dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + IMG_SIZE, true);
    dv.setUint32(0x18, BASE + IMG_SIZE, true);
    dv.setUint32(0x1c, BASE + ENTRY_OFF, true);

    const a = new Asm(BASE + ENTRY_OFF);
    const d = (off) => abs(R.DATA + off);
    a.movImm(ESP, STACK_TOP);
    // A real GDT and IDT: multiboot leaves CS with no descriptor behind it, and a #PF needs one.
    a.db(0x0f, 0x01, 0x15).dd(R.GDTR);                  // lgdt [GDTR]
    const farNext = a.addr + 7;                          // jmp 0x08:next (7-byte ptr16:32)
    a.db(0xea).dd(farNext).dw(0x08);
    a.movImm(EAX, 0x10);
    a.db(0x8e, 0xd8, 0x8e, 0xc0, 0x8e, 0xd0, 0x8e, 0xe0, 0x8e, 0xe8); // ds es ss fs gs = 0x10
    a.db(0x0f, 0x01, 0x1d).dd(R.IDTR);                  // lidt [IDTR]
    a.enableFpuAndSse();

    // Identity page tables, as sections 1-3.
    a.movImm(EDI, PD);
    a.movImm(EAX, PT0 | 7);
    a.movTo(mem({ base: EDI }), EAX);
    a.movImm(ECX, 1);
    a.movImm(EAX, 0);
    a.label("pd_zero");
    a.movTo(mem({ base: EDI, index: ECX, scale: 4 }), EAX);
    a.inc(reg(ECX));
    a.aluImm("cmp", reg(ECX), 1024);
    a.jcc("l", "pd_zero");
    a.movImm(EDI, PT0);
    a.movImm(ECX, 0);
    a.movImm(EAX, 7);
    a.label("pt_fill");
    a.movTo(mem({ base: EDI, index: ECX, scale: 4 }), EAX);
    a.aluImm("add", reg(EAX), 0x1000);
    a.inc(reg(ECX));
    a.aluImm("cmp", reg(ECX), 1024);
    a.jcc("l", "pt_fill");
    a.movImm(EAX, PD);
    a.movCrEax(3);
    a.movEaxCr(0);
    a.aluImm("or", reg(EAX), 0x80000000);
    a.movCrEax(0);

    a.movMemImm(d(D.PROGRESS), 1);
    a.movImm(ESI, 0);
    a.movImm(EDI, HOT_ITERS);
    a.movImm(EBX, R.PAGE_A);
    a.movImm(EBP, R.CROSS);
    a.label("hot");
    a.mov(EDX, mem({ base: EBX }));                                   // dword
    a.mov(ECX, mem({ base: EBX, disp: 0x40 }));                       // dword
    a.db(0x0f, 0xb6).modrm(EAX, mem({ base: EBX, disp: 0x81 }));      // movzx eax, byte
    a.alu("add", ESI, reg(EAX));
    a.db(0x0f, 0xb7).modrm(EAX, mem({ base: EBX, disp: 0x102 }));     // movzx eax, word
    a.alu("add", ESI, reg(EAX));
    a.db(0xf3, 0x0f, 0x7e).modrm(0, mem({ base: EBX, disp: 0x200 })); // movq xmm0, qword
    a.movups(1, mem({ base: EBX, disp: 0x301 }));                     // movups xmm1, dqword
    a.movupsTo(abs(R.SCRATCH), 0);
    a.movupsTo(abs(R.SCRATCH + 0x10), 1);
    for (let i = 0; i < 0x20; i += 4) a.alu("xor", ESI, abs(R.SCRATCH + i));
    a.mov(EAX, mem({ base: EBP, disp: 0xffe }));                      // page-crossing dword
    a.alu("add", ESI, reg(EDX));
    a.alu("xor", ESI, reg(ECX));
    a.alu("add", ESI, reg(EAX));
    a.imulImm(ESI, reg(ESI), 0x01000193);
    a.movTo(d(D.CHECKSUM), ESI);
    a.movTo(d(D.ITER), EDI);
    a.aluImm("cmp", reg(EDI), R.REVOKE_AT);
    a.jcc("ne", "skip");
    const clearPresent = (va) => {
        a.mov(EAX, abs(pteOf(va)));
        a.aluImm("and", reg(EAX), 0xfffffffe);
        a.movTo(abs(pteOf(va)), EAX);
    };
    if (revoke === "invlpg") { clearPresent(R.PAGE_A); a.invlpg(abs(R.PAGE_A)); }
    if (revoke === "cr3") { clearPresent(R.PAGE_A); a.movEaxCr(3); a.movCrEax(3); }
    if (revoke === "cross") { clearPresent(R.CROSS + 0x1000); a.invlpg(abs(R.CROSS + 0x1000)); }
    if (revoke === "host" || revoke === "host-stale") { a.movImm(EDX, R.HOST_PORT); a.outDxAl(); }
    a.label("skip");
    a.dec(reg(EDI));
    a.jcc("nz", "hot");

    a.movMemImm(d(D.PROGRESS), 4);
    a.movImm(EDX, DONE_PORT);
    a.outDxAl();
    a.hlt();
    a.label("hang");
    a.jmpShort("hang");

    // Exception handlers: record, then stop. Vector 14 pushes an error code.
    a.label("pf");
    a.movEaxCr(2);
    a.movTo(d(D.CR2), EAX);
    a.mov(EAX, mem({ base: ESP }));
    a.movTo(d(D.ERR), EAX);
    a.mov(EAX, mem({ base: ESP, disp: 4 }));
    a.movTo(d(D.EIP), EAX);
    a.movMemImm(d(D.VEC), 14);
    a.movImm(EDX, DONE_PORT);
    a.outDxAl();
    a.hlt();
    a.label("other");
    a.movMemImm(d(D.VEC), 0xee);
    a.movImm(EDX, DONE_PORT);
    a.outDxAl();
    a.hlt();

    const code = a.link();
    if (ENTRY_OFF + code.length > 0x1000) throw new Error("code must stay on the first image page");
    buf.set(code, ENTRY_OFF);

    const o = (addr) => addr - BASE;
    dv.setUint32(o(R.GDT) + 8, 0x0000ffff, true);  dv.setUint32(o(R.GDT) + 12, 0x00cf9a00, true);
    dv.setUint32(o(R.GDT) + 16, 0x0000ffff, true); dv.setUint32(o(R.GDT) + 20, 0x00cf9200, true);
    dv.setUint16(o(R.GDTR), 23, true); dv.setUint32(o(R.GDTR) + 2, R.GDT, true);
    dv.setUint16(o(R.IDTR), 32 * 8 - 1, true); dv.setUint32(o(R.IDTR) + 2, R.IDT, true);
    for (let v = 0; v < 32; v++) {
        const h = a.labels.get(v === 14 ? "pf" : "other");
        dv.setUint32(o(R.IDT) + v * 8, (h & 0xffff) | (0x08 << 16), true);
        dv.setUint32(o(R.IDT) + v * 8 + 4, (h & 0xffff0000) | 0x8e00, true);
    }
    return buf;
}

function runReplace({ revoke, mode, stats = true, wasmPath = null, dump = false, timeoutMs = 60_000, arm = false }) {
    return new Promise((res) => {
        const img = buildReplaceImage({ revoke });
        const opts = { autostart: false, memory_size: 32 * 1024 * 1024, log_level: 0 };
        if (wasmPath || ENGINE_WASM) opts.wasm_path = wasmPath || ENGINE_WASM;
        const emulator = new V86(opts);
        let timer, cpu, w, settled = false, hostFlushes = 0, staleByte = -1;
        if (dump) globalThis.__wasmDump = { out: [] };
        const read32 = (addr) => {
            const b = emulator.read_memory(addr, 4);
            return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
        };
        const finish = (status) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const out = { status, revoke, mode, hostFlushes, staleByte, cpuEip: cpu.instruction_pointer[0] >>> 0 };
            for (const [k, off] of Object.entries(D)) out[k.toLowerCase()] = read32(R.DATA + off);
            out.hit = stats ? Number(w.profiler_dispatch_stat_get(25)) : -1;
            out.miss = stats ? Number(w.profiler_dispatch_stat_get(26)) : -1;
            out.mirror = w.perm_map_rebuild_and_diff() >>> 0;
            out.ablationMisses = typeof w.perm_ablation_misses === "function" ? w.perm_ablation_misses() : -1;
            if (dump) {
                out.modules = globalThis.__wasmDump.out;
                delete globalThis.__wasmDump;
                // tlb_data is placed by the linker, and every module bakes its address: two
                // engine builds can only be compared once that one relocation is known.
                out.tlbBase = findTlbDataBase(cpu.wasm_memory, cpu.mem8.byteOffset,
                    [0x100, 0x108, 0x280, 0x290, 0x291, 0x300, 0x301]).base;
            }
            try { emulator.stop(); } catch { /* the run is over either way */ }
            res(out);
        };
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", () => {
            cpu = emulator.v86.cpu;
            w = cpu.wm.exports;
            cpu.reboot_internal(); cpu.reset_memory();
            cpu.load_multiboot(img.buffer);
            // Distinct bytes wherever a read lands, so a wrong or stale read moves the checksum.
            const pat = new Uint8Array(0x3000);
            for (let i = 0; i < pat.length; i++) pat[i] = (i * 131 + 17) ^ (i >> 8);
            emulator.write_memory(pat.subarray(0, 0x1000), R.PAGE_A);
            emulator.write_memory(pat.subarray(0x1000), R.CROSS);
            if (stats) { w.set_dispatch_stats(1); w.profiler_init(); }
            if (arm) w.arm_perm_map_unsound_ablation(1);
            w.set_perm_map_reads(mode);
            if ((w.get_perm_map_reads() >>> 0) !== mode) throw new Error(`engine refused perm mode ${mode}`);
            cpu.io.register_write(DONE_PORT, cpu, () => {});
            // PageTableManager.decommitPages in shape: clear Present in the PTE from the host,
            // then full_clear_tlb. The guest never executes an INVLPG for it.
            cpu.io.register_write(R.HOST_PORT, cpu, () => {
                const pte = pteOf(R.PAGE_A);
                const permAt = w.perm_map_base() + (R.PAGE_A >>> 12);
                const before = new Uint8Array(cpu.wasm_memory.buffer)[permAt];
                const v = read32(pte) & ~1;
                emulator.write_memory(new Uint8Array([v, v >> 8, v >> 16, v >>> 24]), pte);
                w.full_clear_tlb();
                hostFlushes++;
                if (revoke === "host-stale") {
                    // NEGATIVE CONTROL: the mirror "forgets" to drop the byte on this flush.
                    new Uint8Array(cpu.wasm_memory.buffer)[permAt] = before;
                    staleByte = before;
                }
            });
            timer = setTimeout(() => finish("stopped"), timeoutMs);
            try { emulator.run(); } catch { finish("threw"); }
            const origTick = emulator.v86.do_tick.bind(emulator.v86);
            emulator.v86.do_tick = () => { try { origTick(); } catch { finish("threw"); } };
        });
    });
}

/** Everything the guest can observe. An empty list is parity. */
function divergences(off, on) {
    const keys = ["status", "progress", "checksum", "iter", "vec", "cr2", "err", "eip"];
    return keys.filter(k => off[k] !== on[k]).map(k => `${k}: OFF=${off[k]} ON=${on[k]}`);
}
const showR = (label, r) => console.log(`  ${label.padEnd(16)} ${r.status}@0x${r.cpuEip.toString(16)} progress=${r.progress} iter=${r.iter} `
    + `vec=${r.vec} cr2=0x${r.cr2.toString(16)} err=${r.err} eip=0x${r.eip.toString(16)} `
    + `checksum=0x${r.checksum.toString(16).padStart(8, "0")} mirror=${r.mirror} hit=${r.hit} miss=${r.miss}`);

console.log("\n4. mode 2 control (no revocation; every width + a page-crossing read): OFF vs REPLACE");
const r2Off = await runReplace({ revoke: "none", mode: 0 });
const r2On = await runReplace({ revoke: "none", mode: 2 });
showR("OFF", r2Off); showR("REPLACE", r2On);
check(r2Off.progress === 4 && r2Off.vec === 0,
    `the OFF control did not run to completion (progress=${r2Off.progress}, vec=${r2Off.vec})`);
for (const x of divergences(r2Off, r2On)) check(false, `mode 2 control diverges — ${x}`);
check(r2On.hit > 1_000_000, `the mode 2 fast arm ran only ${r2On.hit} times — the comparison does not exercise it`);
check(r2On.miss > HOT_ITERS / 2, `the mode 2 slow arm ran ${r2On.miss} times; the page-crossing read alone takes it every compiled iteration`);
check(r2Off.hit === 0 && r2Off.miss === 0, `mode 0 emitted replacement counters (hit=${r2Off.hit} miss=${r2Off.miss})`);
check(r2On.mirror === 0, `the bitmap disagrees with tlb_data in mode 2 (${r2On.mirror} pages)`);

console.log("\n5. mode 2 revocation from INSIDE the compiled loop, by every route that drops a translation");
for (const revoke of ["invlpg", "cr3", "host", "cross"]) {
    const off = await runReplace({ revoke, mode: 0 });
    const on = await runReplace({ revoke, mode: 2 });
    showR(`${revoke} OFF`, off); showR(`${revoke} REPLACE`, on);
    const wantPage = revoke === "cross" ? R.CROSS + 0x1000 : R.PAGE_A;
    check(off.vec === 14 && ((off.cr2 & ~0xfff) >>> 0) === wantPage,
        `${revoke}: OFF did not #PF on the revoked page (vec=${off.vec} cr2=0x${off.cr2.toString(16)}) — the fixture revokes nothing`);
    check(off.iter === R.REVOKE_AT, `${revoke}: OFF faulted at iter=${off.iter}, not in the iteration after ${R.REVOKE_AT}`);
    for (const x of divergences(off, on)) check(false, `${revoke}: REVOCATION PARITY BROKEN — ${x}`);
    check(on.hit > 1_000_000, `${revoke}: the mode 2 fast arm ran only ${on.hit} times before the revocation`);
    check(on.mirror === 0, `${revoke}: the bitmap disagrees with tlb_data after the revocation (${on.mirror} pages)`);
    if (revoke === "host") check(on.hostFlushes === 1, `host: the decommit port fired ${on.hostFlushes} times`);
}

console.log("\n6. mode 0 emits the same modules as an engine without mode 2");
if (!BASELINE_WASM) {
    console.log("  skipped — pass --baseline <v86.wasm built without mode 2>");
} else if (!existsSync(BASELINE_WASM)) {
    check(false, `--baseline ${BASELINE_WASM} does not exist`);
} else {
    const base = await runReplace({ revoke: "none", mode: 0, stats: false, wasmPath: BASELINE_WASM, dump: true });
    const cur = await runReplace({ revoke: "none", mode: 0, stats: false, dump: true });
    // The only constant allowed to differ is tlb_data's link address: rewrite the baseline's
    // `i32.load offset=<tlb_data>` immediates to the current build's and require equality.
    const leb = (v) => { const o = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
    const relocate = (bytes, from, to) => {
        const f = leb(from), t = leb(to), out = Uint8Array.from(bytes);
        if (f.length !== t.length) return null;
        let n = 0;
        for (let i = 0; i + f.length <= out.length; i++) {
            if (f.every((b, k) => out[i + k] === b)) { out.set(t, i); n++; i += f.length - 1; }
        }
        return { out, n };
    };
    const hex = (m) => Buffer.from(m).toString("base64");
    const strict = base.modules.length === cur.modules.length
        && base.modules.every((m, i) => m.start === cur.modules[i].start && hex(m.bytes) === hex(cur.modules[i].bytes));
    let relocated = 0;
    const same = base.modules.length === cur.modules.length && base.modules.every((m, i) => {
        if (m.start !== cur.modules[i].start) return false;
        const r = base.tlbBase === cur.tlbBase ? { out: m.bytes, n: 0 } : relocate(m.bytes, base.tlbBase, cur.tlbBase);
        if (!r) return false;
        relocated += r.n;
        return hex(r.out) === hex(cur.modules[i].bytes);
    });
    if (DUMP_DIR) {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(DUMP_DIR, { recursive: true });
        const on = await runReplace({ revoke: "none", mode: 2, stats: false, dump: true });
        for (const [arm, run] of [["baseline", base], ["mode0", cur], ["mode2", on]]) {
            run.modules.forEach((m, i) => writeFileSync(resolve(DUMP_DIR, `${arm}-${i}-${m.start.toString(16)}.wasm`), m.bytes));
        }
        console.log(`  modules written to ${DUMP_DIR}`);
    }
    const bytes = (m) => m.reduce((n, r) => n + r.len, 0);
    console.log(`  baseline ${base.modules.length} modules / ${bytes(base.modules)} B, `
        + `mode 0 ${cur.modules.length} modules / ${bytes(cur.modules)} B — `
        + (strict ? "IDENTICAL" : same
            ? `IDENTICAL after relocating tlb_data 0x${base.tlbBase.toString(16)} -> 0x${cur.tlbBase.toString(16)} (${relocated} immediates)`
            : "DIFFERENT"));
    check(base.modules.length > 0, "the baseline run compiled nothing — the identity check compares two empty sets");
    check(same, "mode 0 does not emit byte-identical modules to the baseline engine");
    check(base.checksum === cur.checksum, "mode 0 and the baseline engine disagree on the checksum");
}

console.log("\n7. self-check: a byte left stale across the host flush MUST be reported");
const staleOff = await runReplace({ revoke: "host-stale", mode: 0 });
const staleOn = await runReplace({ revoke: "host-stale", mode: 2 });
showR("stale OFF", staleOff); showR("stale REPLACE", staleOn);
const staleDiv = divergences(staleOff, staleOn);
console.log(`  detected: ${staleDiv.length ? staleDiv.join("; ") : "NOTHING"} (re-armed byte=0x${staleOn.staleByte.toString(16)})`);
check(staleOff.vec === 14, "the stale-byte OFF arm did not fault — mode 0 must not consult the byte at all");
check(staleOn.staleByte > 0, "the negative control did not re-arm a FAST byte, so it injects nothing");
check(staleDiv.length > 0, "a stale FAST byte after the host decommit went UNDETECTED — sections 4-5 cannot fail");

console.log("\n8. mode 3 (UNSOUND call-free slow arm, measurement only): gated, and does not trap");
{
    const gate = await new Promise((res) => {
        const emulator = new V86({ autostart: false, memory_size: 32 * 1024 * 1024, log_level: 0,
            ...(ENGINE_WASM ? { wasm_path: ENGINE_WASM } : {}) });
        emulator.add_listener("emulator-loaded", () => {
            const w = emulator.v86.cpu.wm.exports;
            w.set_perm_map_reads(3);
            const unarmed = w.get_perm_map_reads() >>> 0;
            w.arm_perm_map_unsound_ablation(1); w.set_perm_map_reads(3);
            const armed = w.get_perm_map_reads() >>> 0;
            w.arm_perm_map_unsound_ablation(0);
            const disarmed = w.get_perm_map_reads() >>> 0;
            emulator.destroy();
            res({ unarmed, armed, disarmed });
        });
    });
    console.log(`  gate: unarmed set(3) -> ${gate.unarmed}, armed -> ${gate.armed}, disarm -> ${gate.disarmed}`);
    check(gate.unarmed === 0, "set_perm_map_reads(3) was accepted without arm_perm_map_unsound_ablation(1)");
    check(gate.armed === 3, "an armed set_perm_map_reads(3) did not take effect");
    check(gate.disarmed === 0, "disarming did not drop an active mode 3");

    const r3 = await runReplace({ revoke: "none", mode: 3, arm: true, dump: true });
    const r2 = await runReplace({ revoke: "none", mode: 2, dump: true });
    showR("REPLACE", r2); showR("ABLATE", r3);
    console.log(`  mode 3 call-free misses: ${r3.ablationMisses} (each one skipped the translation the slow helper does)`);
    check(r3.status === "halt" && r3.progress === 4, `mode 3 did not run to completion (status=${r3.status}, progress=${r3.progress})`);
    check(r3.hit > 1_000_000, `the mode 3 fast arm ran only ${r3.hit} times`);
    check(r3.ablationMisses > 0, "the mode 3 slow arm never ran — the page-crossing read should take it every iteration");
    const slowReads = ["safe_read8_slow_jit", "safe_read16_slow_jit", "safe_read32s_slow_jit", "safe_read64s_slow_jit", "safe_read128s_slow_jit"];
    const slowImports = (mods) => mods.reduce((n, m) => n + WebAssembly.Module.imports(new WebAssembly.Module(m.bytes))
        .filter(x => slowReads.includes(x.name)).length, 0);
    const bytes = (m) => m.reduce((n, r) => n + r.len, 0);
    console.log(`  emitted: mode 2 ${r2.modules.length} modules / ${bytes(r2.modules)} B (${slowImports(r2.modules)} slow-read imports), `
        + `mode 3 ${r3.modules.length} modules / ${bytes(r3.modules)} B (${slowImports(r3.modules)} slow-read imports)`);
    check(slowImports(r2.modules) > 0, "mode 2 imported no slow-read helper — the comparison below is vacuous");
    check(slowImports(r3.modules) === 0, "a mode 3 module still imports a safe_read*_slow_jit helper");
    if (DUMP_DIR) {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(DUMP_DIR, { recursive: true });
        for (const [armName, run] of [["mode2", r2], ["mode3", r3]]) {
            run.modules.forEach((m, i) => writeFileSync(resolve(DUMP_DIR, `${armName}-${i}-${m.start.toString(16)}.wasm`), m.bytes));
        }
    }
}

if (failures.length > 0) {
    console.log(`\nperm-map differential: FAIL (${failures.length})`);
    process.exit(1);
}
console.log("\nperm-map differential: OK");
