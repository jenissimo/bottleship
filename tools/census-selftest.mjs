#!/usr/bin/env bun
/**
 * demo_census_probe — the census's own self-test (docs/performance/sota-roadmap/10).
 *
 * A class table is only worth the decision it steers, and the way this project has been
 * burned before is a table that reports a plausible share of something other than its
 * label. So the probe is a guest image whose instruction mix is known EXACTLY by
 * construction: one loop body with a designed number of x87 loads, x87 stores, SSE moves,
 * stack-relative accesses, absolute accesses and base+index accesses, run a known number
 * of times. The census has to reproduce those numbers.
 *
 * What it proves, in order of importance:
 *   1. Each class is counted, and counted as ITSELF — an undercounted class is a share
 *      silently moved to another row, which is exactly how a wrong optimisation target
 *      gets chosen.
 *   2. The addressing census and the opcode census agree on how many memory operands ran
 *      (two independently produced numbers, so agreement is evidence).
 *   3. MMX and SSE2 stay apart under the prefix key.
 *   4. With the switch OFF, everything reads zero — so a zero table is diagnosable as
 *      "not armed" rather than being mistaken for "this workload runs no x87".
 *
 * Coverage is not 100% by design: v86 runs a page interpreted until it is hot, and those
 * instructions carry no counters. The assertions are therefore bounded — never above the
 * designed count, and within a small margin below it — and the RATIOS between classes,
 * which the interpreted prefix cannot skew, are checked tightly.
 *
 *   bun tools/census-selftest.mjs [--iterations N]
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBV86 = resolve(REPO, "vendor/v86/build/libv86.mjs");

if (!existsSync(LIBV86)) {
    console.log("census-selftest: SKIP — vendor/v86/build/libv86.mjs absent (run vendor/v86/build-wasm.sh)");
    process.exit(0);
}

const { classifyOpcode, classGroup, classifyAddrKey, simdFamily } =
    await import(resolve(REPO, "src/worker/core/debug/guest-opcode-classes.ts"));
const { V86 } = await import(LIBV86);

const argIters = process.argv.indexOf("--iterations");
const ITERATIONS = argIters > 0 ? Number(process.argv[argIters + 1]) : 200_000;

const BASE = 0x100000, ENTRY_OFF = 0x40, IMG_SIZE = 0x8000;
const DATA = BASE + 0x2000;      // scratch the frame pointer looks into
const ABS = BASE + 0x2100;       // the absolute-addressed dword
const TABLE = BASE + 0x2200;     // base for the base+index access
const RET_STUB = BASE + 0x3000;  // an indirect call target
const RESET_PORT = 0x8888;       // first OUT: the host zeroes the census (see below)

/**
 * Per iteration of the loop body, by class. This table IS the specification: the image
 * below emits exactly these instructions and the assertions read from here, so a change
 * to one without the other fails rather than drifts.
 */
const PER_ITERATION = {
    "x87.load": 1,        // fld  dword [ebp-8]
    "x87.arith": 1,       // fadd dword [ebp-8]
    "x87.store": 1,       // fstp dword [ebp-8]
    "simd.mov": 1,        // movups xmm0, [ebp-0x20]
    "simd.arith": 1,      // addps  xmm0, xmm0
    "mem.mov": 3,         // mov eax,[ebp-4] ; mov ebx,[abs] ; mov ecx,[edx+esi*4]
    "mem.alu": 2,         // add eax,[esp+8] ; dec dword [ebp-0x10]
    "stack": 2,           // push eax ; pop eax
    "branch.indirect": 1, // call edi
    "branch.ret": 1,      // ret (inside the stub)
    "branch.condDirect": 1, // jnz loop
};
/** Addressing form of every memory operand in one iteration. */
const PER_ITERATION_ADDR = {
    stackConst: 7,   // fld, fadd, fstp, movups[ebp-0x20], mov[ebp-4], add[esp+8], dec[ebp-0x10]
    absolute: 1,     // mov ebx,[ABS]
    baseIndex: 1,    // mov ecx,[edx+esi*4]
};
const MEM_OPS_PER_ITERATION = Object.values(PER_ITERATION_ADDR).reduce((a, b) => a + b, 0);

function buildImage() {
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

    dv.setFloat32(DATA - BASE - 8, 1.5, true);   // [ebp-8], the x87 operand

    let o = ENTRY_OFF;
    const emit = (...b) => { for (const x of b) buf[o++] = x & 0xff; };
    const imm32 = (v) => { dv.setUint32(o, v >>> 0, true); o += 4; };

    // --- prologue (executed once; negligible against ITERATIONS) ---
    emit(0xBC); imm32(0x200000);                 // mov esp, 0x200000
    emit(0xBD); imm32(DATA);                     // mov ebp, DATA
    emit(0xBA); imm32(TABLE);                    // mov edx, TABLE
    emit(0xBE); imm32(1);                        // mov esi, 1
    emit(0xBF); imm32(RET_STUB);                 // mov edi, RET_STUB
    // CR0: clear EM|TS so x87 and SSE do not trap; CR4: set OSFXSR|OSXMMEXCPT.
    emit(0x0F, 0x20, 0xC0);                      // mov eax, cr0
    emit(0x25); imm32(0xFFFFFFF3);               // and eax, ~(EM|TS)
    emit(0x0F, 0x22, 0xC0);                      // mov cr0, eax
    emit(0x0F, 0x20, 0xE0);                      // mov eax, cr4
    emit(0x0D); imm32(0x00000600);               // or eax, OSFXSR|OSXMMEXCPT
    emit(0x0F, 0x22, 0xE0);                      // mov cr4, eax
    emit(0xDB, 0xE3);                            // fninit
    emit(0xC7, 0x45, 0xEC); imm32(2);            // mov dword [ebp-0x14], 2   (two passes)
    // TWO passes over the SAME loop body, with the census zeroed between them.
    //
    // v86 promotes a page after JIT_THRESHOLD retired instructions, so a single-pass probe
    // spends its first ~30k iterations in the interpreter — which carries no counters and
    // would show up here as a uniform 10% shortfall in EVERY class. That is warm-up, not a
    // census defect, and the way to tell the two apart is to measure a window that is
    // entirely warm. The first OUT hands the host that boundary.
    const outerStart = o;
    emit(0xC7, 0x45, 0xF0); imm32(ITERATIONS);   // mov dword [ebp-0x10], ITERATIONS

    // --- loop body ---
    const loopStart = o;
    emit(0xD9, 0x45, 0xF8);                      // fld    dword [ebp-8]      x87.load
    emit(0xD8, 0x45, 0xF8);                      // fadd   dword [ebp-8]      x87.arith
    emit(0xD9, 0x5D, 0xF8);                      // fstp   dword [ebp-8]      x87.store
    emit(0x0F, 0x10, 0x45, 0xE0);                // movups xmm0, [ebp-0x20]   simd.mov
    emit(0x0F, 0x58, 0xC0);                      // addps  xmm0, xmm0         simd.arith
    emit(0x8B, 0x45, 0xFC);                      // mov    eax, [ebp-4]       mem.mov  stackConst
    emit(0x8B, 0x1D); imm32(ABS);                // mov    ebx, [ABS]         mem.mov  absolute
    emit(0x8B, 0x0C, 0xB2);                      // mov    ecx, [edx+esi*4]   mem.mov  baseIndex
    emit(0x03, 0x44, 0x24, 0x08);                // add    eax, [esp+8]       mem.alu  stackConst
    emit(0x50);                                  // push   eax                stack
    emit(0x58);                                  // pop    eax                stack
    emit(0xFF, 0xD7);                            // call   edi                branch.indirect
    emit(0xFF, 0x4D, 0xF0);                      // dec    dword [ebp-0x10]   mem.alu  stackConst
    const rel = loopStart - (o + 2);
    emit(0x75, rel & 0xff);                      // jnz    loopStart          branch.condDirect

    emit(0xBA); imm32(RESET_PORT);               // mov edx, RESET_PORT
    emit(0xEE);                                  // out dx, al  -> host zeroes the census
    emit(0xFF, 0x4D, 0xEC);                      // dec dword [ebp-0x14]
    const relOuter = outerStart - (o + 2);
    emit(0x0F, 0x85); dv.setInt32(o, outerStart - (o + 4), true); o += 4;  // jnz outerStart (rel32)
    void relOuter;

    emit(0xF4);                                  // hlt
    emit(0xEB, 0xFE);

    let s = RET_STUB - BASE;
    buf[s] = 0xC3;                               // ret                       branch.ret
    return buf;
}

function run({ censusOn }) {
    return new Promise((res) => {
        const img = buildImage();
        const emulator = new V86({ autostart: false, memory_size: 16 * 1024 * 1024, log_level: 0 });
        let timer;
        let retiredAtReset = 0;
        const finish = (status) => {
            clearTimeout(timer);
            const cpu = emulator.v86.cpu;
            const w = cpu.wm.exports;
            const out = {
                status,
                enabled: w.get_opstats() >>> 0,
                // Retired inside the MEASURED window only. Against the whole run this
                // would report 50% coverage for a census that saw every instruction of
                // the window it actually covers.
                retired: (((cpu.instruction_counter[0] >>> 0) - retiredAtReset) >>> 0),
                opcode: new Float64Array(0x2000),
                addr: new Float64Array(256),
                simd: new Float64Array(1024),
            };
            for (let op = 0; op < 0x100; op++) {
                for (let is0f = 0; is0f < 2; is0f++) {
                    for (let isMem = 0; isMem < 2; isMem++) {
                        for (let g = 0; g < 8; g++) {
                            out.opcode[(is0f << 12) | (op << 4) | (isMem << 3) | g] =
                                w.get_opstats_buffer(0, 0, 0, 0, op, is0f, isMem, g);
                        }
                    }
                }
            }
            for (let i = 0; i < 256; i++) out.addr[i] = w.get_opstats_addr(i);
            for (let i = 0; i < 1024; i++) out.simd[i] = w.get_opstats_simd(i);
            try { emulator.stop(); } catch { /* the run is over either way */ }
            res(out);
        };
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", () => {
            const cpu = emulator.v86.cpu;
            cpu.reboot_internal(); cpu.reset_memory();
            cpu.load_multiboot(img.buffer);
            // Armed BEFORE anything is compiled, so every block carries the counters.
            cpu.wm.exports.opstats_reset();
            cpu.wm.exports.set_opstats(censusOn ? 1 : 0);
            // The warm-up boundary. Zeroing here (rather than at load) is what makes the
            // measured window entirely JIT-compiled, so a shortfall in a class means the
            // census misses that class rather than that the page was still cold.
            let resets = 0;
            cpu.io.register_write(RESET_PORT, cpu, () => {
                if (resets++ === 0) {
                    cpu.wm.exports.opstats_reset();
                    retiredAtReset = cpu.instruction_counter[0] >>> 0;
                }
            });
            timer = setTimeout(() => finish("HANG"), 120_000);
            emulator.run();
        });
    });
}

const PREFIX_BYTES = new Set([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3]);

function rollup(s) {
    const byClass = new Map(), byGroup = new Map();
    let counted = 0, memoryOps = 0;
    for (let op = 0; op < 0x100; op++) {
        for (let is0f = 0; is0f < 2; is0f++) {
            if (!is0f && PREFIX_BYTES.has(op)) continue;
            for (let isMem = 0; isMem < 2; isMem++) {
                for (let g = 0; g < 8; g++) {
                    const n = s.opcode[(is0f << 12) | (op << 4) | (isMem << 3) | g];
                    if (!n) continue;
                    counted += n;
                    if (isMem) memoryOps += n;
                    const c = classifyOpcode({ opcode: op, is0f: !!is0f, isMem: !!isMem, fixedG: g });
                    byClass.set(c, (byClass.get(c) ?? 0) + n);
                    byGroup.set(classGroup(c), (byGroup.get(classGroup(c)) ?? 0) + n);
                }
            }
        }
    }
    const byAddr = new Map();
    let addrTotal = 0;
    for (let k = 0; k < 256; k++) {
        const n = s.addr[k];
        if (!n) continue;
        addrTotal += n;
        const f = classifyAddrKey(k);
        byAddr.set(f, (byAddr.get(f) ?? 0) + n);
    }
    const bySimd = new Map();
    for (let k = 0; k < 1024; k++) {
        const n = s.simd[k];
        if (!n) continue;
        const f = simdFamily(k);
        if (f === "other") continue;
        bySimd.set(f, (bySimd.get(f) ?? 0) + n);
    }
    return { counted, memoryOps, byClass, byGroup, byAddr, addrTotal, bySimd };
}

// ---------------------------------------------------------------------------

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

console.log(`census-selftest: running demo_census_probe, ${ITERATIONS} iterations`);
const on = await run({ censusOn: true });
if (on.status !== "halt") {
    console.error(`census-selftest: FAIL — probe did not halt (${on.status})`);
    process.exit(1);
}
const r = rollup(on);

// The measured window is entirely warm, so the counts should BE the designed ones. Two
// small, named sources of slack remain, and nothing else: the outer loop's own pass
// counter and branch run once inside the window (+), and the ret stub — on its own page,
// reached only through an indirect call — finishes warming a few iterations in (-). A
// tolerance of 0.1% floored at 64 covers both and stays far below a missed class, which
// would be a whole multiple of ITERATIONS.
const hi = (n) => n * ITERATIONS;
const slack = (want) => Math.max(64, Math.round(want * 0.001));

console.log("\n  class                 counted        designed   ratio");
for (const [cls, per] of Object.entries(PER_ITERATION)) {
    const got = r.byClass.get(cls) ?? 0;
    const want = hi(per);
    console.log(`  ${cls.padEnd(20)} ${String(got).padStart(10)} ${String(want).padStart(15)}   ${(got / want).toFixed(4)}`);
    check(Math.abs(got - want) <= slack(want),
        `${cls}: counted ${got}, designed ${want} (tolerance ${slack(want)}). A gap this size is not warm-up or `
        + "the outer loop: it is a class the census counts as something else, or counts twice.");
}

// Ratios: the interpreted prefix scales every class alike, so these are exact-ish even
// though the absolute counts are not. A misclassified instruction moves one ratio.
const x87 = r.byGroup.get("x87") ?? 0;
check(Math.abs((r.byClass.get("x87.load") ?? 0) / Math.max(1, x87) - 1 / 3) < 0.01,
    `x87.load should be a third of all x87 work, got ${(r.byClass.get("x87.load") ?? 0)} of ${x87}`);

// The two memory feeds are produced independently; agreement is evidence, not identity.
check(r.addrTotal === r.memoryOps,
    `addressing census (${r.addrTotal}) and opcode census (${r.memoryOps}) disagree on memory operands`);
console.log(`\n  memory operands: opcode census ${r.memoryOps}, addressing census ${r.addrTotal} `
    + `(${r.addrTotal === r.memoryOps ? "agree" : "DISAGREE"})`);

console.log("\n  addressing form       counted        designed   ratio");
for (const [form, per] of Object.entries(PER_ITERATION_ADDR)) {
    const got = r.byAddr.get(form) ?? 0;
    const want = hi(per);
    console.log(`  ${form.padEnd(20)} ${String(got).padStart(10)} ${String(want).padStart(15)}   ${(got / want).toFixed(4)}`);
    check(Math.abs(got - want) <= slack(want), `addr ${form}: counted ${got}, designed ${want} (tolerance ${slack(want)})`);
}
check((r.byAddr.get("stackIndex") ?? 0) === 0, "no instruction in the probe is stack+index; a non-zero count means "
    + "the SIB base/index fields are being read from the wrong bits");
check((r.byAddr.get("addr16") ?? 0) === 0, "the probe emits no 16-bit addressing");

// SSE, not MMX: the probe's SIMD is unprefixed packed-single.
const simdPs = r.bySimd.get("sse.ps") ?? 0;
check(Math.abs(simdPs - hi(2)) <= slack(hi(2)),
    `sse.ps family counted ${simdPs}, expected about ${hi(2)}`);
check((r.bySimd.get("mmx") ?? 0) === 0, `the probe emits no MMX, yet the family table shows ${r.bySimd.get("mmx")}`);
console.log(`\n  simd families: ${[...r.bySimd].map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`);

console.log(`\n  coverage: counted ${r.counted} of ${on.retired} retired in the measured window `
    + `(${((r.counted / on.retired) * 100).toFixed(2)}%)`);
check(r.counted <= on.retired, "the census counted more instructions than the CPU retired");
check(r.counted / on.retired > 0.99, `coverage ${(r.counted / on.retired * 100).toFixed(2)}% — the measured window is `
    + "supposed to be entirely compiled, so anything meaningfully below 100% means blocks ran without counters "
    + "and every share above is a share of a subset");

// The switch OFF must produce a zero table, so an unarmed census is diagnosable rather
// than being read as "this workload runs no x87".
const off = rollup(await run({ censusOn: false }));
check(off.counted === 0, `with the census switch off the table must be empty, got ${off.counted}`);
check(off.addrTotal === 0, `with the census switch off the addressing table must be empty, got ${off.addrTotal}`);
console.log(`  switch off: counted ${off.counted} (must be 0)`);

if (failures.length > 0) {
    console.error("\ncensus-selftest: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log("\ncensus-selftest: OK");
