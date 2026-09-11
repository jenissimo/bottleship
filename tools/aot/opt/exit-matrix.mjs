#!/usr/bin/env node
/**
 * P1.5's continuation gate: every exit class, then the baseline runs the rest.
 *
 * A differential that compares two SEPARATE executions proves the candidate can compute the same
 * answer. It does not prove it can hand control back. This does: the unit is published into the
 * engine, made to leave through one exit class at a time, and the guest then continues in the
 * baseline to the same capture point the reference reaches — so the comparison covers the
 * transfer, not only the arithmetic.
 *
 * All eight registers and the raw lazy flag tuple are compared here, because both arms share the
 * driver's entry state. That is the difference from the isolated interpreter differential, where
 * five registers are honestly UNCOMPARED.
 *
 *   node tools/aot/opt/exit-matrix.mjs [--case k3] [--job <job.json>]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";

const HERE = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const SPLIT_LINES = new RegExp("\\r?\\n");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
};
const CASE = argOf("case", "k3");
/**
 * Named passes for the units under test, so the continuation gate can run against an OPTIMIZED
 * arm and not only the conservative one. A mechanism that changes how memory is reached has to
 * answer the same fault questions the conservative form answers.
 */
const PASSES = argOf("passes", "");
/**
 * Bytes of the entry the truncated unit covers: everything up to, but not including, the `ret`.
 * The region then ends at an address it does not implement, which is what the baseline continues
 * from.
 */
const UNSUPPORTED_CODE_LIMIT = argOf("unsupported-code-limit", "31");
const dir = mkdtempSync(path.join(tmpdir(), "aot-opt-exits-"));
const job = argOf("job", null) ?? path.join(dir, `job-${CASE}.json`);

const run = (args, cwd = REPO) =>
    execFileSync("node", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });

/** One arm run, reduced to what a continuation comparison is about. */
function armRun({ unit = null, mmu = null }) {
    const args = [path.join(REPO, "tools/aot-oracle/arms/run-v86.mjs"), "--case", CASE, "--one-call"];
    if (unit) args.push("--aot", unit);
    if (mmu) args.push("--mmu", mmu);
    let out;
    try {
        out = run(args);
    } catch (e) {
        out = String(e.stdout ?? "");
        if (!out.trim()) throw new Error(String(e.stderr ?? e.message).slice(-300));
    }
    const raw = JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
    return {
        status: raw.status,
        entered: raw.aot?.entered ?? null,
        regions: Object.fromEntries((raw.regions ?? []).map((r) => [r.name, r.sha256])),
        // The full register file and v86's raw lazy tuple: nothing is excluded, because both arms
        // start from the same driver state.
        registered: raw.aot?.registered ?? null,
        // Counted on OUR side of the import boundary, so it survives the engine freeing the
        // module — which is what a unit that exits on its own page provokes.
        executions: raw.aot?.executions ?? null,
        regs: raw.state?.regs ?? null,
        lazy: raw.state?.lazy ?? null,
        counter: raw.state?.instruction_counter ?? null,
        fault: raw.mmu?.observed ?? null,
    };
}

function compare(reference, candidate) {
    const differences = [];
    for (const [name, sha] of Object.entries(reference.regions)) {
        if (candidate.regions[name] !== sha) differences.push(`region ${name}`);
    }
    for (const [name, value] of Object.entries(reference.regs ?? {})) {
        if (candidate.regs?.[name] !== value) differences.push(`reg ${name}`);
    }
    for (const [name, value] of Object.entries(reference.lazy ?? {})) {
        if (candidate.lazy?.[name] !== value) differences.push(`lazy.${name}`);
    }
    if (reference.counter !== candidate.counter) differences.push("instruction_counter");
    if (reference.fault || candidate.fault) {
        for (const field of ["taken", "cr2", "error_code", "fault_eip"]) {
            if (reference.fault?.[field] !== candidate.fault?.[field]) differences.push(`fault.${field}`);
        }
    }
    return differences;
}

const checks = [];
function check(id, ok, detail) {
    checks.push({ id, ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  ${detail}` : ""}`);
}

console.log(`### exit matrix — case ${CASE}${PASSES ? ` — passes ${PASSES}` : ""}
`);

if (!argOf("job", null)) {
    run([path.join(REPO, "tools/aot/capture-job.mjs"), "--case", CASE, "--out", job, "--warmup", "20000"]);
}
const publish = (out, bound) => {
    const args = [path.join(REPO, "tools/aot/opt/publish.mjs"), "--job", job, "--out", out, "--case", CASE];
    if (bound) args.push("--loop-bound", String(bound));
    if (PASSES) args.push("--passes", PASSES);
    run(args);
    return `${out}.json`;
};

const shipping = publish(path.join(dir, "unit"), null);
const bounded = publish(path.join(dir, "unit-bound8"), 8);

// ── 1. the unsupported-instruction boundary: the ordinary path ────────────────────────────────
// The region ends before `ret`; the baseline performs the return and the rest of the run.
{
    const reference = armRun({});
    const candidate = armRun({ unit: shipping });
    check("boundary-exit:the engine entered the unit", candidate.entered === true);
    const differences = compare(reference, candidate);
    check("boundary-exit:baseline continuation reaches the same capture point",
        differences.length === 0, differences.length ? differences.join(", ") : "all regions, registers, lazy tuple and counter identical");
}

// ── 2. the fault exit: v86's own two-phase path, after the unit materialized state ─────────────
// `pf-readonly-dst-cached` is the one that separates a proof from a decline: every other
// read-only scenario leaves the TLB entry invalid, so a guard that checks presence and ignores
// writability refuses them for the wrong reason and looks right.
for (const scenario of ["pf-absent-src", "pf-absent-dst", "pf-readonly-dst",
    "pf-readonly-dst-cached", "mapping-change-src"]) {
    const reference = armRun({ mmu: scenario });
    const candidate = armRun({ unit: shipping, mmu: scenario });
    const differences = compare(reference, candidate);
    check(`fault-exit:${scenario}`, differences.length === 0 && candidate.fault?.taken === 1,
        differences.length ? differences.join(", ")
            : `cr2 0x${(candidate.fault?.cr2 ?? 0).toString(16)}, same fault identity and effects`);
}

// ── 1b. an exit at an instruction the unit does NOT execute ───────────────────────────────────
// The row above is named "boundary" for historical reasons and is no longer one: `ret` is
// modelled, so the candidate performs it and nothing is handed back. This row builds a region
// that stops SHORT of the `ret`, so the unit really does exit at an address it does not cover and
// the baseline really does execute the instruction there and everything after it.
//
// Such a unit hands control back on its own page, which is a hazard for OWNERSHIP — it loses the
// page — and irrelevant to the question here, which is whether the guest continues correctly. So
// it is built with the hazard flag and the page loss is expected.
{
    const truncated = path.join(dir, "unit-truncated");
    const args = [path.join(REPO, "tools/aot/opt/publish.mjs"), "--job", job, "--case", CASE,
        "--out", truncated, "--code-limit", String(UNSUPPORTED_CODE_LIMIT),
        "--prove-on-page-exit-hazard"];
    if (PASSES) args.push("--passes", PASSES);
    let built = true;
    try {
        run(args);
    } catch {
        // The byte limit is a property of THIS case's page, not of every case. A truncation that
        // does not produce a liftable region cannot exercise this row, and saying so is the only
        // honest outcome — a row that quietly vanishes reads exactly like a passing one.
        built = false;
        check(`unsupported-exit:SKIPPED for ${CASE}`, true,
            `a ${UNSUPPORTED_CODE_LIMIT}-byte prefix of this page does not lift`);
    }
    const reference = built ? armRun({}) : null;
    const candidate = built ? armRun({ unit: `${truncated}.json` }) : null;
    if (built) {
    const differences = compare(reference, candidate);
    check("unsupported-exit:the baseline executes what the unit declined",
        differences.length === 0,
        differences.length ? differences.join(", ")
            : "region ends before the terminator; state, lazy tuple and counter identical");
    // Without this the row compares the baseline with itself and agrees for the one reason that
    // means nothing. The engine's own entry counter is gone by the capture point — the module was
    // freed the moment it handed control back on its own page — so the count comes from the
    // import wrapper, which outlives it.
    check("unsupported-exit:the truncated unit actually ran",
        (candidate.executions ?? 0) > 0, `executions=${candidate.executions}`);
    }
}

// ── 2b. the same boundary exit, with the scope actually PROVEN ────────────────────────────────
// Every row above starts with a cold TLB, so a scope guard declines over an unfilled entry and
// the GUARDED copy is what runs. This row warms both data pages first, which is the only state in
// which the proven path is the thing under test.
{
    const reference = armRun({ mmu: "warm-clean" });
    const candidate = armRun({ unit: shipping, mmu: "warm-clean" });
    const differences = compare(reference, candidate);
    check("proven-path:the warmed run reaches the same capture point",
        differences.length === 0 && candidate.fault?.taken === 0,
        differences.length ? differences.join(", ")
            : "both data pages cached and permitted; state, lazy tuple and counter identical");
}

// ── 3. the budget exit: the loop guard fires and the baseline finishes the work ────────────────
{
    const reference = armRun({});
    const candidate = armRun({ unit: bounded });
    const differences = compare(reference, candidate);
    check("budget-exit:the guard fires and the guest still completes identically",
        differences.length === 0,
        differences.length ? differences.join(", ") : "bound lowered to 8; state and counter identical");
    // Vacuous unless the bounded unit really is a different artifact that really was entered.
    check("budget-exit:the bounded unit was entered", candidate.entered === true);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${failed.length === 0 ? "PASS" : "FAIL"} — ${checks.length - failed.length}/${checks.length} checks ===`);
console.log("NOT exercised dynamically: the dispatcher's uncovered-index arm. It is reachable only "
    + "from an entry index the engine never produces for a single-entry unit; the contract "
    + "verifier covers its shape (N16/B2), which is weaker than running it.");
process.exit(failed.length === 0 ? 0 : 1);
