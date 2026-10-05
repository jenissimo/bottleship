#!/usr/bin/env bun
/**
 * Flag-helper contracts (vendor/v86 gen/generate_flag_contracts.js → src/rust/gen/flag_contracts.rs).
 *
 * With flag locals on (jit idx 21) and set_flag_helper_contract(1), a helper call syncs only
 * the lazy-flag words its table row says it may read or write. A wrong row does not crash:
 * the guest branches on stale flags. Every row is DERIVED from the Rust sources, so the rules
 * that keep a row honest are:
 *
 *   1. Freshness — the generated file equals what the current sources derive. A helper edited
 *      to touch flags after the last regeneration keeps its old, now-wrong, row otherwise.
 *   2. Not a negative-control table — FLAG_CONTRACT_MUTATED is false.
 *   3. Anchors — known writers/readers/host-reaching helpers are classified as such, and the
 *      helpers audited by hand in docs/performance/v86-flag-helper-contract-2026-09-05.md come
 *      out flag-neutral. The first half is what stops the analysis silently degrading to
 *      "everything is neutral"; the second stops it silently degrading to "nothing is".
 *   4. Self-test — a table generated with --mutate fpu_fcomi must FAIL rule 3.
 *
 * Absent from the table = full sync, the pre-contract behaviour; that default needs no rule.
 *
 * Run: bun tools/validate-flag-helper-contracts.mjs
 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO = resolve(import.meta.dir, "..");
const V86 = resolve(REPO, "vendor/v86");
const GEN = resolve(V86, "gen/generate_flag_contracts.js");
const TABLE = resolve(V86, "src/rust/gen/flag_contracts.rs");

if (!existsSync(GEN)) {
    console.log("validate-flag-helper-contracts: SKIP — vendor/v86 not checked out");
    process.exit(0);
}

// Slot order is wasm_builder.rs flag-local order.
const LAST_OP1 = 1, LAST_RESULT = 2, LAST_OP_SIZE = 4, FLAGS_CHANGED = 8, FLAGS = 16, ALL = 0x1f;

// Audited by hand (17 x87 + 2 SSE); the derivation must agree they touch no flag word.
const AUDITED_NEUTRAL = [
    "fpu_get_sti_jit", "f32_to_f80_jit", "f64_to_f80_jit", "i32_to_f80_jit", "i64_to_f80_jit",
    "f80_to_f32", "f80_to_f64", "fpu_fadd", "fpu_fmul", "fpu_fsub", "fpu_fsubr", "fpu_fdiv",
    "fpu_fdivr", "fpu_push", "fpu_pop", "instr16_D9_6_reg", "instr16_D9_7_reg", "instr_0F16",
    "instr_660F59",
];

function parse(text) {
    const rows = new Map();
    for (const m of text.matchAll(/\("([^"]+)", 0x([0-9a-f]{2}), 0x([0-9a-f]{2})\)/g)) {
        rows.set(m[1], { r: parseInt(m[2], 16), w: parseInt(m[3], 16) });
    }
    const mutated = /FLAG_CONTRACT_MUTATED: bool = true/.test(text);
    return { rows, mutated };
}
const effect = (t, name) => t.rows.get(name) ?? { r: ALL, w: ALL };

function anchorFailures(t) {
    const out = [];
    const need = (ok, msg) => { if (!ok) out.push(msg); };
    const fcomi = effect(t, "fpu_fcomi");
    need((fcomi.w & FLAGS) && (fcomi.w & FLAGS_CHANGED), `fpu_fcomi must WRITE flags+flags_changed (got w=0x${fcomi.w.toString(16)})`);
    const fcmovb = effect(t, "instr_DA_0_reg");
    need((fcmovb.r & ALL) === ALL, `instr_DA_0_reg (FCMOVB, reads CF) must READ all five words (got r=0x${fcmovb.r.toString(16)})`);
    const eflags = effect(t, "get_eflags");
    need(eflags.r === ALL, `get_eflags must READ all five words (got r=0x${eflags.r.toString(16)})`);
    const upd = effect(t, "update_eflags");
    need((upd.w & FLAGS) && (upd.w & FLAGS_CHANGED), `update_eflags must WRITE flags+flags_changed (got w=0x${upd.w.toString(16)})`);
    const add = effect(t, "add16");
    need((add.w & (LAST_OP1 | LAST_RESULT | LAST_OP_SIZE | FLAGS_CHANGED)) === 0xf, `add16 must WRITE the lazy tuple (got w=0x${add.w.toString(16)})`);
    need(!t.rows.has("instr_E6"), "instr_E6 (OUT imm8 → host io_port_write8) must be absent = full sync");
    for (const name of AUDITED_NEUTRAL) {
        const e = effect(t, name);
        need(e.r === 0 && e.w === 0, `${name} was audited flag-neutral but derives r=0x${e.r.toString(16)} w=0x${e.w.toString(16)}`);
    }
    return out;
}

let failed = 0;
const fail = (msg) => { console.error(`  FAIL: ${msg}`); failed++; };

// 1. freshness
const check = spawnSync(process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe") ? "node" : process.execPath,
    [GEN, "--check"], { encoding: "utf8" });
if (check.status !== 0) fail((check.stderr || check.stdout || "generator --check failed").trim());
else console.log(`  ${check.stdout.trim()}`);

// 2 + 3. the table the build links
if (!existsSync(TABLE)) {
    fail(`${TABLE} missing — run node vendor/v86/gen/generate_flag_contracts.js`);
} else {
    const t = parse(readFileSync(TABLE, "utf8"));
    if (t.mutated) fail("FLAG_CONTRACT_MUTATED is true — a negative-control table is in the source tree");
    if (t.rows.size < 100) fail(`only ${t.rows.size} rows — the analysis has degraded to "everything is full"`);
    for (const f of anchorFailures(t)) fail(f);
}

// 4. self-test: the anchors must reject a table that calls FCOMI neutral.
const dir = mkdtempSync(join(tmpdir(), "flagcontract-"));
try {
    const out = join(dir, "mutated.rs");
    const r = spawnSync("node", [GEN, "--mutate", "fpu_fcomi", "--out", out], { encoding: "utf8" });
    if (r.status !== 0) fail(`could not generate the mutated self-test table: ${r.stderr}`);
    else {
        const t = parse(readFileSync(out, "utf8"));
        const f = anchorFailures(t);
        if (!t.mutated) fail("the --mutate table does not declare itself mutated");
        if (!f.some(x => x.startsWith("fpu_fcomi"))) fail("SELF-TEST: a table declaring FCOMI flag-neutral passed the anchors — this validator cannot fail");
        else console.log("  self-test: a table declaring FCOMI flag-neutral is rejected");
    }
} finally {
    rmSync(dir, { recursive: true, force: true });
}

if (failed) {
    console.error(`validate-flag-helper-contracts: FAIL (${failed})`);
    process.exit(1);
}
console.log("validate-flag-helper-contracts: OK");
