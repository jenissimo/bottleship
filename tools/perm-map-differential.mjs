#!/usr/bin/env bun
/**
 * Permission-bitmap differential (docs/performance/sota-roadmap/03).
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
 *   bun tools/perm-map-differential.mjs
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Asm, mem, abs, reg, EAX, ECX, EDX, EBX, ESP, ESI, EDI } from "./guestbench/lib/asm.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBV86 = resolve(REPO, "vendor/v86/build/libv86.mjs");
if (!existsSync(LIBV86)) {
    console.log("perm-map-differential: SKIP — vendor/v86/build/libv86.mjs absent (run vendor/v86/build-wasm.sh)");
    process.exit(0);
}
const { V86 } = await import(LIBV86);

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
        const emulator = new V86({ autostart: false, memory_size: 32 * 1024 * 1024, log_level: 0 });
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

if (failures.length > 0) {
    console.log(`\nperm-map differential: FAIL (${failures.length})`);
    process.exit(1);
}
console.log("\nperm-map differential: OK");
