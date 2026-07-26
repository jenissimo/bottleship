#!/usr/bin/env node
// aot-oracle — the differential oracle for the AOT compiler (product B).
//
//   The same guest work, over the same memory image, at the same guest addresses, through
//   (a) our JIT and (b) a candidate AOT module. The guest memory AND the architectural
//   register file that come out must be byte-identical. Anything else is a bug report with
//   an address on it.
//
// Runs headless in Node: no Chrome, no harness, no dev server, no game, no bundle.
//
//   node oracle.mjs --candidate unit:auto --case k1 --check
//   node oracle.mjs --candidate unit:./units/k1.json --case k1 --reps 5
//   node oracle.mjs --candidate raw:../probes/aot-spike/variant-b/target/.../aot_spike_b.wasm#b1 --case k1,k2
//   node oracle.mjs --self-test
//
// Candidate specs:
//   unit:<manifest.json>  a contract-shaped AOT module (export f(i32)->(), imports from "e"),
//                         published into a real v86 with jit_register_aot_module and entered
//                         through wasm_table[idx+1024] — the production dispatch path.
//   unit:auto             capture the JIT's own module for the case's page in a reference
//                         run and re-publish THOSE bytes as the unit. This is the opt-0
//                         identity candidate: what a compiler at optimization level 0 must
//                         reproduce byte-for-byte (design §5.3, gate 2a). It is also the
//                         oracle's own positive control.
//   raw:<module.wasm>[#mode]  a foreign module doing the same guest work over its own linear
//                         memory (the spike's variant B). Not entered through the dispatcher;
//                         it satisfies the register half of the differential only by doing
//                         what the contract requires anyway — flushing the register file to
//                         guest memory at the exit.
//
// Exit codes: 0 VALID/CORRECT · 2 usage · 3 an arm failed · 4 INVALID (a gate failed) ·
//             5 DIVERGENT (the candidate computed something else).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { compareRegions, compareState, describeFirst } from "./lib/compare.mjs";
import { evaluateGates, median, spreadPct, steady } from "./lib/gates.mjs";
import { CASES } from "./corpus/cases.mjs";
import { runSelfTest } from "./lib/selftest.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { args[a.slice(2)] = next; i++; }
    else args[a.slice(2)] = "1";
}

if (args["self-test"]) {
    const r = runSelfTest();
    for (const t of r.tests) process.stderr.write(`${t.ok ? "pass" : "FAIL"}  ${t.name}${t.ok ? "" : " — " + t.detail}\n`);
    process.stderr.write(`\nself-test: ${r.passed}/${r.tests.length} passed\n`);
    console.log(JSON.stringify({ verdict: r.ok ? "SELFTEST_PASS" : "SELFTEST_FAIL", ...r }, null, 2));
    process.exit(r.ok ? 0 : 1);
}

const spec = args.candidate;
if (!spec) {
    process.stderr.write("usage: node oracle.mjs --candidate <unit:auto|unit:file.json|raw:file.wasm#mode> [--case k1,k2] [--check] [--reps N] [--fault name]\n");
    process.exit(2);
}
const m = /^(unit|raw):(.+)$/.exec(spec);
if (!m) { process.stderr.write(`bad --candidate "${spec}"\n`); process.exit(2); }
const candClass = m[1];
let candTarget = m[2];
let candMode = null;
if (candClass === "raw") {
    const hash = candTarget.lastIndexOf("#");
    if (hash > 0) { candMode = candTarget.slice(hash + 1); candTarget = candTarget.slice(0, hash); }
}

const cases = (args.case || "k1,k2").split(",").map((s) => s.trim()).filter(Boolean);
for (const k of cases) if (!CASES[k]) { process.stderr.write(`unknown case ${k}\n`); process.exit(2); }
const check = !!args.check;
const reps = Number(args.reps || (check ? 1 : 5));
// Correctness needs no big N; a number does. The measurement defaults are the spike's,
// including the warm-up large enough for tier-2 promotion to land OUTSIDE a measured phase.
const outer = Number(args.outer || (check ? 2000 : 40000));
const warmup = Number(args.warmup || (check ? 2000 : 200000));
const warmupCalls = Number(args["warmup-calls"] || (check ? 2000 : 50000));
const fault = args.fault || null;
const workdir = args.workdir || fs.mkdtempSync(path.join(os.tmpdir(), "aot-oracle-"));
fs.mkdirSync(workdir, { recursive: true });

const nodeFlags = args.v8 ? String(args.v8).split(/[, ]+/).filter(Boolean).map((f) => (f.startsWith("--") ? f : "--" + f)) : [];

function run(script, extra) {
    const out = execFileSync(process.execPath, [...nodeFlags, path.join(__dirname, script), ...extra],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const line = out.trim().split("\n").pop();
    return JSON.parse(line);
}

const report = {
    tool: "aot-oracle", started_at: new Date().toISOString(), node: process.version,
    candidate: { class: candClass, target: candTarget, mode: candMode },
    params: { cases, reps, outer, warmup, warmupCalls, check, fault, workdir },
    cases: {}, verdict: null,
};

let anyDivergent = false, anyInvalid = false, anyArmFailed = false;

/** A unit manifest is bound to the case it was captured from — publishing it into another
 *  case's image is refused by the content hash, which turns the run into JIT-vs-JIT. Catch
 *  it here, where the message can say why, instead of leaving it to a gate. */
function assertManifestCase(file, caseId) {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    if (m.case && m.case !== caseId) {
        process.stderr.write(`candidate manifest ${file} was captured for case "${m.case}", not "${caseId}" — its pages cannot exist in this image\n`);
        process.exit(2);
    }
}

for (const caseId of cases) {
    const refArgs = ["--case", caseId, "--outer", String(outer), "--warmup", String(warmup)];
    const candArgsBase = candClass === "unit"
        ? ["--case", caseId, "--outer", String(outer), "--warmup", String(warmup)]
        : ["--case", caseId, "--candidate", candTarget, "--mode", String(candMode ?? "b1"),
            "--outer", String(outer), "--warmup-calls", String(warmupCalls)];
    // The fault, when asked for, is injected into the CANDIDATE arm only: it is the negative
    // control that proves the oracle detects a divergence it did not create itself.
    const candArgs = fault ? [...candArgsBase, "--fault", fault] : candArgsBase;

    let unitManifest = candTarget;
    if (candClass === "unit" && candTarget === "auto") {
        const prefix = path.join(workdir, `${caseId}-unit`);
        const capture = run("arms/run-v86.mjs", [...refArgs, "--capture", prefix]);
        if (capture.status !== "ok" || !capture.capture?.units) {
            process.stderr.write(`capture run failed for ${caseId}: ${capture.status}\n`);
            anyArmFailed = true; continue;
        }
        unitManifest = capture.capture.file;
        process.stderr.write(`${caseId}: captured ${capture.capture.units} unit(s) from the JIT -> ${unitManifest}\n`);
    }
    if (candClass === "unit") assertManifestCase(unitManifest, caseId);

    const reps_ = [];
    for (let rep = 0; rep < reps; rep++) {
        // Interleaved, one child process each, strictly sequential: drift hits both arms.
        const ref = run("arms/run-v86.mjs", refArgs);
        const cand = candClass === "unit"
            ? run("arms/run-v86.mjs", [...candArgs, "--aot", unitManifest])
            : run("arms/run-raw.mjs", candArgs);
        if (ref.status !== "ok" || cand.status !== "ok") {
            anyArmFailed = true;
            process.stderr.write(`rep ${rep} ${caseId}: arm failed (ref=${ref.status} cand=${cand.status})\n`);
            reps_.push({ rep, ref, cand, arm_failed: true });
            continue;
        }
        const regionCmp = compareRegions(ref.regions, cand.regions);
        const stateCmp = compareState(ref.state, cand.state);
        reps_.push({ rep, ref, cand, regionCmp, stateCmp });
        process.stderr.write(
            `rep ${rep} ${caseId}: ref ${ref.ns_per_outer.toFixed(0)} ns/outer | cand ${cand.ns_per_outer.toFixed(0)}` +
            ` | ratio ${(ref.ns_per_outer / cand.ns_per_outer).toFixed(2)}x` +
            ` | mem ${regionCmp.identical ? "identical" : "DIVERGENT"}` +
            ` | state ${stateCmp.available ? (stateCmp.identical ? "identical" : "DIVERGENT") : "uncompared"}\n`);
    }

    const good = reps_.filter((r) => !r.arm_failed);
    if (!good.length) { report.cases[caseId] = { verdict: "ARM_FAILED", reps: reps_.map(stripBytes) }; continue; }

    const memDiverged = good.filter((r) => !r.regionCmp.identical);
    const stateDiverged = good.filter((r) => r.stateCmp.available && !r.stateCmp.identical);
    const stateUncompared = good.some((r) => !r.stateCmp.available);
    const uncomparedFields = new Set();
    for (const r of good) {
        if (!r.stateCmp.available) uncomparedFields.add("(all host-side state)");
        for (const f of r.stateCmp.uncompared ?? []) uncomparedFields.add(f);
    }

    const refNs = good.map((r) => r.ref.ns_per_outer);
    const candNs = good.map((r) => r.cand.ns_per_outer);
    const reportsNumber = !check && memDiverged.length === 0 && stateDiverged.length === 0;
    const gateResult = evaluateGates({
        refRuns: good.map((r) => r.ref), candRuns: good.map((r) => r.cand),
        candClass, reportsNumber,
    });

    const divergent = memDiverged.length > 0 || stateDiverged.length > 0;
    // Two classes, two meanings. A failed DIFFERENTIAL gate says the candidate arm did not
    // run the candidate — identical output then proves nothing (a unit refused for a
    // content-hash mismatch compares the JIT with itself), so --check must not report CORRECT.
    // Failed MEASUREMENT gates are reported always and decide the verdict only when a number
    // is being claimed.
    const diffGatesFailed = gateResult.failedDifferential.length > 0;
    const measGatesFailed = gateResult.failedMeasurement.length > 0;
    let verdict;
    if (divergent) verdict = "DIVERGENT";
    else if (diffGatesFailed) verdict = "INVALID";
    else if (check) verdict = "CORRECT";
    else verdict = measGatesFailed ? "INVALID" : "VALID";
    if (divergent) anyDivergent = true;
    if (diffGatesFailed || (!check && measGatesFailed)) anyInvalid = true;

    const first = memDiverged[0]?.regionCmp.first ?? null;
    const firstState = stateDiverged[0]?.stateCmp.first ?? null;

    report.cases[caseId] = {
        verdict,
        differential: {
            memory_identical: memDiverged.length === 0,
            state_identical: stateDiverged.length === 0 ? (stateUncompared ? null : true) : false,
            state_compared: !stateUncompared,
            state_not_compared: [...uncomparedFields],
            first_divergence: first ?? firstState,
            first_divergence_human: divergent ? describeFirst(first, firstState) : null,
            regions: good[0].regionCmp.regions,
            state_diffs: stateDiverged[0]?.stateCmp.diffs ?? [],
            diverging_reps: { memory: memDiverged.map((r) => r.rep), state: stateDiverged.map((r) => r.rep) },
        },
        gates: gateResult.gates,
        gates_enforced: { differential: "always", measurement: gateResult.measurementEnforced },
        // A number is published only when nothing diverged AND every gate passed. Otherwise
        // the raw timings stay here, under a name that cannot be mistaken for a result.
        measurement: (verdict === "VALID") ? {
            ns_per_outer: { reference: median(refNs), candidate: median(candNs) },
            ratio: median(refNs) / median(candNs),
            guest_ins_per_outer: good[0].ref.guest_ins_per_outer,
            guest_mips: { reference: median(good.map((r) => r.ref.guest_mips)), candidate: median(good.map((r) => r.cand.guest_mips)) },
            spread_pct: { reference: spreadPct(refNs), candidate: spreadPct(candNs) },
        } : null,
        withheld_timings: (verdict === "VALID") ? null : {
            why: divergent ? "the arms computed different things" : (check ? "correctness-only run (--check): no number is claimed" : "a validity gate failed"),
            ns_per_outer: { reference: median(refNs), candidate: median(candNs) },
            steady: { reference: good.map((r) => steady(r.ref)), candidate: good.map((r) => steady(r.cand)) },
        },
        jit: good[0].ref.jit,
        aot: good[0].cand.aot ?? null,
        fault: good[0].cand.fault ?? null,
        reps: reps_.map(stripBytes),
    };
}

/** Region hex is megabytes over many reps; keep the hashes and the diffs, drop the payload. */
function stripBytes(r) {
    const lean = (x) => x && ({ ...x, regions: x.regions?.map(({ hex, ...rest }) => rest) });
    return { rep: r.rep, ref: lean(r.ref), cand: lean(r.cand),
        memory_identical: r.regionCmp?.identical ?? null,
        state_identical: r.stateCmp?.identical ?? null };
}

report.verdict = anyArmFailed ? "ARM_FAILED"
    : anyDivergent ? "DIVERGENT"
    : anyInvalid ? "INVALID"
    : check ? "CORRECT" : "VALID";
report.finished_at = new Date().toISOString();

const outPath = args.out || path.join(workdir, `oracle-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

process.stderr.write("\n");
for (const [k, r] of Object.entries(report.cases)) {
    const d = r.differential;
    process.stderr.write(`${k}: ${r.verdict}\n`);
    if (d) {
        process.stderr.write(`  memory ${d.memory_identical ? "identical" : "DIVERGENT"}` +
            `  registers/eflags (guest STATE spill) ${d.regions.find((x) => x.name === "STATE")?.status ?? "?"}` +
            `  host-state ${d.state_compared ? (d.state_identical ? "identical" : "DIVERGENT") : "UNCOMPARED"}\n`);
        if (!d.state_compared) {
            process.stderr.write(`  NOT COMPARED (candidate publishes no host-side state): ${d.state_not_compared.join(", ")}\n`);
        }
        if (d.first_divergence_human) process.stderr.write(`  first divergence: ${d.first_divergence_human}\n`);
    }
    for (const g of r.gates ?? []) if (!g.ok) process.stderr.write(`  gate FAILED ${g.id} = ${JSON.stringify(g.value)} — ${g.why}\n`);
    if (r.measurement) {
        process.stderr.write(`  ratio ${r.measurement.ratio.toFixed(2)}x` +
            ` (ref ${r.measurement.ns_per_outer.reference.toFixed(0)} ns/outer, cand ${r.measurement.ns_per_outer.candidate.toFixed(0)})\n`);
    } else if (r.withheld_timings) {
        process.stderr.write(`  no number reported: ${r.withheld_timings.why}\n`);
    }
}
process.stderr.write(`verdict: ${report.verdict}\nwrote ${outPath}\n`);

console.log(JSON.stringify({
    verdict: report.verdict,
    cases: Object.fromEntries(Object.entries(report.cases).map(([k, v]) => [k, {
        verdict: v.verdict,
        memory_identical: v.differential?.memory_identical ?? null,
        state_compared: v.differential?.state_compared ?? null,
        state_identical: v.differential?.state_identical ?? null,
        first_divergence: v.differential?.first_divergence_human ?? null,
        gates_failed: (v.gates ?? []).filter((g) => !g.ok).map((g) => g.id),
        ratio: v.measurement?.ratio ?? null,
    }])),
    file: outPath,
}, null, 2));

process.exit(report.verdict === "VALID" || report.verdict === "CORRECT" ? 0
    : report.verdict === "DIVERGENT" ? 5
    : report.verdict === "ARM_FAILED" ? 3 : 4);
