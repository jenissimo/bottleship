#!/usr/bin/env node
/**
 * The A/B/C report: one baseline, one conservative unit, one unit per named pass set.
 *
 * Every arm is built from the SAME live capture and measured in the SAME session, because a
 * ratio quoted from two sessions is a ratio between two machine states. The oracle owns the
 * verdict — correctness gates, steady state and spread — and this tool refuses to print a ratio
 * the oracle withheld: a number the instrument declined to stand behind is not a measurement.
 *
 *   node tools/aot/opt/arm-report.mjs [--case k3] [--reps 9] [--outer 40000] [--warmup 200000]
 *                                     [--arms conservative,flag-liveness] [--out report.json]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";

const HERE = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const ORACLE = path.join(REPO, "tools", "aot-oracle");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
};
const CASE = argOf("case", "k3");
const REPS = argOf("reps", "9");
const OUTER = argOf("outer", "40000");
const WARMUP = argOf("warmup", "200000");
const OUT = argOf("out", null);
/**
 * Arm B is `conservative` (no passes); every other name is a comma-free pass list published as
 * its own artifact. `+` joins several passes into one arm.
 */
const ARMS = argOf("arms", "conservative,flag-liveness").split(",").map((a) => a.trim());
if (ARMS.some((a) => a.includes("+"))) {
    // `+` is how one arm names several passes, because `,` already separates arms.
}

const dir = mkdtempSync(path.join(tmpdir(), "aot-opt-report-"));
const run = (args, cwd = REPO) =>
    execFileSync("node", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
/** The oracle EXITS non-zero on an invalid run, and an invalid run is a result to report. */
const runTolerating = (args, cwd) => {
    try {
        return run(args, cwd);
    } catch (e) {
        return String(e.stdout ?? "");
    }
};

/**
 * How many times one arm may be re-measured when the SESSION was unstable.
 *
 * Spread and steady state are properties of the machine, not of the arm, so a run they reject is
 * a measurement that did not happen. A correctness gate is the opposite: it is about the arm, and
 * retrying one would be looking for a run that agrees with us. Only the first kind is retried,
 * and the attempt count is reported.
 */
const ATTEMPTS = Number(argOf("attempts", "3"));
const STABILITY_GATES = new Set(["spread_pct.reference", "spread_pct.candidate",
    "steady_state.reference", "steady_state.candidate"]);

const job = path.join(dir, `job-${CASE}.json`);
console.log(`### arms — case ${CASE}, ${REPS} reps of ${OUTER} outer after ${WARMUP} warmup\n`);
run([path.join(REPO, "tools/aot/capture-job.mjs"), "--case", CASE, "--out", job, "--warmup", "20000"]);

/** Publish one arm and return what the artifact says about itself. */
function publish(name) {
    const passes = name === "conservative" ? "" : name.split("+").join(",");
    const out = path.join(dir, `arm-${name}`);
    const args = [path.join(REPO, "tools/aot/opt/publish.mjs"), "--job", job, "--case", CASE, "--out", out];
    if (passes) args.push("--passes", passes);
    const out_text = run(args);
    const r = JSON.parse(out_text.slice(out_text.indexOf("{")));
    return {
        name,
        manifest: `${out}.json`,
        diagnostic: r.diagnostic === true,
        passes: r.passes,
        bytes: r.bytes,
        instructions: r.instructions_lifted,
        contract_checks: r.verifier_checks_passed,
    };
}

/** Static code shape, which explains a ratio without being evidence for one. */
async function codeShape(manifest) {
    const { parseModule, bodyStats } = await import(url.pathToFileURL(
        path.join(REPO, "tools/aot/lib/wdis.mjs")).href);
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    const wasm = new Uint8Array(readFileSync(path.join(path.dirname(manifest), m.units[0].file)));
    const parsed = parseModule(wasm);
    const stats = bodyStats(wasm, parsed.code.instrStart, parsed.code.instrEnd);
    return { wasm_ops: stats.instructions, body_bytes: parsed.code.instrEnd - parsed.code.instrStart };
}

const rows = [];
for (const name of ARMS) {
    const arm = publish(name);
    let one = null;
    let attempt = 0;
    while (attempt < ATTEMPTS) {
        attempt += 1;
        const timings = path.join(dir, `timing-${name}-${attempt}.json`);
        runTolerating([path.join(ORACLE, "oracle.mjs"), "--case", CASE,
            "--candidate", `unit:${arm.manifest}`, "--reps", REPS, "--outer", OUTER,
            "--warmup", WARMUP, "--out", timings], ORACLE);
        one = JSON.parse(readFileSync(timings, "utf8")).cases[CASE];
        const failed = (one.gates ?? []).filter((g) => !g.ok).map((g) => g.id);
        if (!failed.length || !failed.every((id) => STABILITY_GATES.has(id))) break;
        console.log(`  ${name}: attempt ${attempt} rejected by the machine (${failed.join(", ")})`);
    }
    const failed = (one.gates ?? []).filter((g) => !g.ok)
        .map((g) => `${g.id}=${JSON.stringify(g.value)}`);
    rows.push({
        ...arm,
        ...(await codeShape(arm.manifest)),
        verdict: one.verdict,
        // The oracle withholds the whole measurement it does not stand behind; reprinting the raw
        // samples as if it had would be the arm reporting on its own measurement.
        measurement: one.measurement,
        ratio: one.measurement?.ratio ?? null,
        attempts: attempt,
        gates_failed: failed,
    });
}

const A = "reference (v86 JIT)";
const refNs = rows.find((r) => r.measurement)?.measurement?.ns_per_outer?.reference;
console.log(`  ${"arm".padEnd(18)} ${"ops".padStart(5)} ${"bytes".padStart(6)} `
    + `${"ns/outer".padStart(9)} ${"MIPS".padStart(6)} ${"vs A".padStart(8)}  verdict`);
console.log(`  ${A.padEnd(18)} ${"—".padStart(5)} ${"—".padStart(6)} `
    + `${(refNs ? refNs.toFixed(1) : "—").padStart(9)} `
    + `${"—".padStart(6)} ${"1.00x".padStart(8)}  baseline`);
for (const r of rows) {
    const ratio = r.ratio ? `${(1 / r.ratio).toFixed(2)}x` : "withheld";
    const note = (r.attempts > 1 ? `  [${r.attempts} attempts]` : "")
        + (r.diagnostic ? "  DIAGNOSTIC — not an accepted gain" : "");
    const ns = r.measurement?.ns_per_outer?.candidate;
    const mips = r.measurement?.guest_mips?.candidate;
    console.log(`  ${r.name.padEnd(18)} ${String(r.wasm_ops).padStart(5)} ${String(r.body_bytes).padStart(6)} `
        + `${(ns ? ns.toFixed(1) : "—").padStart(9)} ${(mips ? mips.toFixed(0) : "—").padStart(6)} `
        + `${ratio.padStart(8)}  ${r.verdict}${note}`
        + `${r.gates_failed.length ? `  (${r.gates_failed.join(", ")})` : ""}`);
}
console.log("\n  'vs A' is how much SLOWER than the baseline: 1.00x is parity, 2.00x is half the speed.");
console.log("  A ratio is printed only when the oracle validated the run; correctness gates, steady");
console.log("  state and spread are its own, and a withheld ratio means the session was not stable.");

if (OUT) {
    writeFileSync(OUT, JSON.stringify({
        tool: "aot/opt/arm-report", case: CASE,
        params: { reps: Number(REPS), outer: Number(OUTER), warmup: Number(WARMUP) },
        arms: rows, artifacts: dir,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
}
const invalid = rows.filter((r) => r.verdict !== "VALID");
process.exit(invalid.length ? 1 : 0);
