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
//   node oracle.mjs --candidate unit:../aot/units/k3.json --case k3 --check
//   node oracle.mjs --candidate unit:auto --case k1 --check --flags "5=0"   # an ablation, gated
//   node oracle.mjs --candidate unit:auto --case k1 --reps 5 --outer 40000 --warmup 200000
//   node oracle.mjs --self-test      the comparator and the gates, in-process
//   node oracle.mjs --shape-check    proof that --flags reaches the emitter (needs the engine)
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
import crypto from "node:crypto";
import { compareRegions, compareState, describeFirst } from "./lib/compare.mjs";
import { evaluateGates, median, spreadPct, steady, timingProblems } from "./lib/gates.mjs";
import { CASES } from "./corpus/cases.mjs";
import { runSelfTest } from "./lib/selftest.mjs";
import { parseArgs, parseFlagOverrides, usageExit } from "./lib/args.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const KNOWN = ["self-test", "shape-check", "prove", "candidate", "case", "check", "reps", "outer",
    "warmup", "warmup-calls", "fault", "flags", "relaxed", "workdir", "out", "v8", "baseline-flags"];
let args;
try { args = parseArgs(process.argv, KNOWN); } catch (e) { usageExit(e); }

if (args["self-test"]) {
    const r = runSelfTest();
    for (const t of r.tests) process.stderr.write(`${t.ok ? "pass" : "FAIL"}  ${t.name}${t.ok ? "" : " — " + t.detail}\n`);
    process.stderr.write(`\nself-test: ${r.passed}/${r.tests.length} passed\n`);
    process.stderr.write("(the shape knob's plumbing needs the engine: node oracle.mjs --shape-check)\n");
    console.log(JSON.stringify({ verdict: r.ok ? "SELFTEST_PASS" : "SELFTEST_FAIL", ...r }, null, 2));
    process.exit(r.ok ? 0 : 1);
}

const workdir = args.workdir || fs.mkdtempSync(path.join(os.tmpdir(), "aot-oracle-"));
fs.mkdirSync(workdir, { recursive: true });

const nodeFlags = args.v8 ? String(args.v8).split(/[, ]+/).filter(Boolean).map((f) => (f.startsWith("--") ? f : "--" + f)) : [];

// An arm that refuses — a shape knob that did not take, a manifest that does not match the live
// engine, a missing engine build — has already printed WHY on its own stderr. Surface that as the
// documented "an arm failed" exit code (3) rather than letting execFileSync throw: a Node stack
// trace and an undocumented exit 1 is not a verdict a caller can act on.
function run(script, extra) {
    const argv = [...nodeFlags, path.join(__dirname, script), ...extra];
    const fail = (why, detail) => {
        process.stderr.write(`arm ${script} ${why}\n  ${argv.slice(nodeFlags.length + 1).join(" ")}\n`
            + (detail ? `${String(detail).trim()}\n` : ""));
        process.exit(3);
    };
    let out;
    try { out = execFileSync(process.execPath, argv, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); }
    catch (e) { fail(`failed (exit ${e.status ?? "?"}${e.signal ? ", signal " + e.signal : ""})`, e.stderr); }
    const line = out.trim().split("\n").pop();
    try { return JSON.parse(line); }
    catch { fail("produced no JSON result on its last stdout line", line?.slice(0, 400)); }
}

// The codegen shape (`--flags`) reaches the emitter, or this tool says so.
//
// An ablation is only an ablation if the knob changed the produced code. This mode captures the
// JIT's own module for one case under two shapes and asserts (a) each arm read its shape back
// out of the engine, (b) the two recorded shapes differ in the requested index, and (c) the
// module BYTES differ. Design F-d is what it regression-tests.
//
//   node oracle.mjs --shape-check [--case k1] [--flags 5=0] [--baseline-flags ""]
if (args["shape-check"]) {
    const caseId = args.case || "k1";
    if (!CASES[caseId]) usageExit(new Error(`unknown case ${caseId}`));
    if (args.flags === "1") usageExit(new Error('--flags needs a value, e.g. --flags "5=0"'));
    const ablation = args.flags ?? "5=0";
    let overrides;
    try { overrides = parseFlagOverrides(ablation); } catch (e) { usageExit(e); }
    const baseline = args["baseline-flags"] === "1" ? "" : (args["baseline-flags"] ?? "");
    const outerN = String(Number(args.outer || 2000)), warmupN = String(Number(args.warmup || 2000));

    const capture = (label, flags) => {
        const prefix = path.join(workdir, `shape-${label}`);
        const a = ["--case", caseId, "--outer", outerN, "--warmup", warmupN, "--capture", prefix];
        if (flags) a.push("--flags", flags);
        const r = run("arms/run-v86.mjs", a);
        if (r.status !== "ok" || !r.capture?.units) throw new Error(`capture "${label}" produced no unit (status ${r.status})`);
        const manifest = JSON.parse(fs.readFileSync(r.capture.file, "utf8"));
        const bytes = fs.readFileSync(path.join(path.dirname(prefix), manifest.units[0].file));
        return { flags_requested: flags || null, jit_flags: manifest.jit_flags, bytes: bytes.length,
            sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    };

    const problems = [];
    let A, B;
    try { A = capture("base", baseline); B = capture("ablated", ablation); }
    catch (e) { process.stderr.write(`${e.message}\n`); process.exit(3); }

    for (const [i, v] of overrides) {
        if (B.jit_flags[i] !== v) problems.push(`the ablated arm read flag ${i} back as ${B.jit_flags[i]}, not the requested ${v} — the knob never reached the engine`);
        if (A.jit_flags[i] === v) problems.push(`the baseline arm already had flag ${i} = ${v} — this pair is not an ablation; pick a knob the default shape does not already set`);
    }
    if (A.sha256 === B.sha256) {
        problems.push(`both shapes produced the SAME module bytes (${A.sha256.slice(0, 16)}, ${A.bytes} B) — either the knob does not change this case's codegen (pick another --case/--flags) or the shape is not being applied`);
    }
    const ok = problems.length === 0;
    for (const p of problems) process.stderr.write(`FAIL  ${p}\n`);
    process.stderr.write(`${ok ? "pass" : "FAIL"}  shape-check ${caseId}: base ${A.bytes} B ${A.sha256.slice(0, 12)} vs `
        + `${ablation} ${B.bytes} B ${B.sha256.slice(0, 12)}\n`);
    console.log(JSON.stringify({ verdict: ok ? "SHAPE_CHECK_PASS" : "SHAPE_CHECK_FAIL",
        case: caseId, baseline: A, ablated: B, problems }, null, 2));
    process.exit(ok ? 0 : 1);
}

// Prove the ORACLE, not a candidate: for every case, the opt-0 identity candidate must come out
// CORRECT, and every fault the case declares must come out DIVERGENT with a named first
// divergence. Both halves are needed. A case that only ever agrees has never been shown to be
// able to fail; a comparator that only ever disagrees would also "pass" a negative control.
//
//   node oracle.mjs --prove [--case k1,k7] [--candidate unit:../aot/units/{case}.json]
//
// `--candidate` defaults to `unit:auto` (the capture-and-republish producer, design S-1), which
// proves the ORACLE. Pass a template containing `{case}` to prove a real PRODUCER instead: the
// same two halves are then asserted about the compiler's own units, which is the artifact a slice
// report has to carry. Without it a report can only quote hand-assembled per-case runs, and a
// missing negative control is invisible.
if (args.prove) {
    const ids = (args.case || Object.keys(CASES).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
    // `--case ,` filters to nothing and every assertion below quantifies over `ids`: 0/0 rows
    // is a PROVE_PASS that proved nothing.
    if (ids.length === 0) usageExit(new Error(`--case selected no case (have: ${Object.keys(CASES).join(", ")})`));
    for (const k of ids) if (!CASES[k]) usageExit(new Error(`unknown case ${k}`));
    // The default candidate republishes the JIT's own bytes: that proves the ORACLE and says
    // nothing about a compiler, so it has to be asked for by name rather than fallen into.
    if (!args.candidate) {
        usageExit(new Error("--prove needs --candidate. Use `--candidate unit:auto` to prove the ORACLE "
            + "(the JIT's own bytes republished — the opt-0 identity control), or a template such as "
            + "`--candidate unit:../aot/units/{case}.json` to prove a PRODUCER."));
    }
    const outerN = String(Number(args.outer || 2000)), warmupN = String(Number(args.warmup || 2000));

    /**
     * Run one --check through a child oracle and return its per-case summary.
     *
     * DIVERGENT (exit 5) and INVALID (exit 4) are RESULTS here, not crashes, so the child's
     * nonzero status must not be read as a failure — its JSON verdict is. The child prints one
     * pretty-printed JSON document on stdout, so the whole stream is parsed; taking the last
     * line (which is what the ARM protocol uses) yields a bare "}".
     */
    const candTemplate = args.candidate;
    const candFor = (caseId) => candTemplate.replace(/\{case\}/g, caseId);
    const once = (caseId, faultName) => {
        const shown = ["--check", "--case", caseId, "--candidate", candFor(caseId),
            ...(faultName ? ["--fault", faultName] : [])];
        const a = [...shown, "--outer", outerN, "--warmup", warmupN,
            "--workdir", path.join(workdir, `prove-${caseId}-${faultName ?? "clean"}`)];
        let stdout;
        try {
            stdout = execFileSync(process.execPath, [...nodeFlags, path.join(__dirname, "oracle.mjs"), ...a],
                { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) { stdout = String(e.stdout ?? ""); if (!stdout.trim()) throw e; }
        const per = JSON.parse(stdout).cases?.[caseId];
        if (!per) throw new Error(`child reported no result for ${caseId}`);
        return { cmd: shown.join(" "), ...per };
    };
    const rows = [];
    const attempt = (caseId, faultName) => {
        try { return once(caseId, faultName); }
        catch (e) {
            return { verdict: "ARM_FAILED", cmd: `--check --case ${caseId} --candidate ${candFor(caseId)}`
                + (faultName ? ` --fault ${faultName}` : ""), why: String(e.stderr ?? e.message ?? e).slice(-400) };
        }
    };
    for (const caseId of ids) {
        const clean = attempt(caseId, null);
        rows.push({ case: caseId, kind: `positive control (${candFor(caseId)})`, expected: "CORRECT", ...clean,
            ok: clean.verdict === "CORRECT" });
        for (const faultName of Object.keys(CASES[caseId].faults ?? {})) {
            const r = attempt(caseId, faultName);
            rows.push({ case: caseId, kind: `negative control (--fault ${faultName})`, expected: "DIVERGENT", ...r,
                // A divergence with no named address would be a hash comparison wearing a diff's
                // name, and one that never reached `output_identical` would mean the gate list
                // does not carry it — so both are part of the pass condition.
                ok: r.verdict === "DIVERGENT" && !!r.first_divergence
                    && (r.gates_failed ?? []).includes("output_identical") });
        }
    }
    const failed = rows.filter((r) => !r.ok);
    if (rows.length === 0) {
        process.stderr.write("prove: 0 checks — nothing was proved\n");
        console.log(JSON.stringify({ verdict: "PROVE_FAIL", candidate: candTemplate, checks: 0,
            failed: 0, rows, why: "no case produced a check" }, null, 2));
        process.exit(1);
    }
    for (const r of rows) {
        process.stderr.write(`${r.ok ? "pass" : "FAIL"}  ${r.case.padEnd(3)} ${r.kind.padEnd(34)} `
            + `${String(r.verdict).padEnd(9)} ${r.first_divergence ?? ""}\n`);
    }
    process.stderr.write(`\nprove: ${rows.length - failed.length}/${rows.length} — every case shown to AGREE and to be able to FAIL\n`);
    console.log(JSON.stringify({ verdict: failed.length ? "PROVE_FAIL" : "PROVE_PASS",
        candidate: candTemplate, checks: rows.length, failed: failed.length, rows }, null, 2));
    process.exit(failed.length ? 1 : 0);
}

const spec = args.candidate;
if (!spec) {
    process.stderr.write("usage: node oracle.mjs --candidate <unit:auto|unit:file.json|raw:file.wasm#mode> [--case k1,k2] [--check] [--reps N] [--fault name] [--flags 5=0] [--relaxed 0]\n"
        + "       node oracle.mjs --self-test          the oracle's own logic (no engine)\n"
        + "       node oracle.mjs --shape-check        prove --flags reaches the emitter\n");
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
// Zero cases and zero reps are the same bug at two scales: every verdict below is a
// quantifier over them, so an empty selection reports CORRECT having compared nothing.
if (cases.length === 0) {
    process.stderr.write(`--case selected no case (have: ${Object.keys(CASES).join(", ")})\n`);
    process.exit(2);
}
for (const k of cases) if (!CASES[k]) { process.stderr.write(`unknown case ${k}\n`); process.exit(2); }
const check = !!args.check;
const reps = Number(args.reps || (check ? 1 : 5));
if (!Number.isInteger(reps) || reps < 1) {
    process.stderr.write(`--reps must be a positive integer, got ${args.reps}\n`);
    process.exit(2);
}
// Correctness needs no big N; a number does. The measurement defaults are the spike's,
// including the warm-up large enough for tier-2 promotion to land OUTSIDE a measured phase.
const outer = Number(args.outer || (check ? 2000 : 40000));
const warmup = Number(args.warmup || (check ? 2000 : 200000));
const warmupCalls = Number(args["warmup-calls"] || (check ? 2000 : 50000));
const fault = args.fault || null;

// The codegen shape is FORWARDED to both v86 arms and gated afterwards (shape.as_requested /
// shape.arms_agree). It used to be parsed here and dropped, so every `--flags` run measured the
// default shape while the report called it an ablation (design F-d).
if (args.flags === "1") usageExit(new Error('--flags needs a value, e.g. --flags "5=0"'));
const flags = args.flags ?? null;
let flagOverrides = new Map();
try { flagOverrides = parseFlagOverrides(flags); } catch (e) { usageExit(e); }
const relaxed = args.relaxed === undefined ? null : Number(args.relaxed);
if (relaxed !== null && relaxed !== 0 && relaxed !== 1) usageExit(new Error(`--relaxed must be 0 or 1, got ${args.relaxed}`));
if (candClass === "raw" && (flags || relaxed !== null)) {
    // A raw module has no codegen shape: applying one would move the REFERENCE arm only, and the
    // ratio would be a shape difference wearing a candidate's name.
    usageExit(new Error("--flags/--relaxed cannot be used with a raw: candidate — the shape would apply to the reference arm only"));
}
const shapeArgs = [
    ...(flags ? ["--flags", flags] : []),
    ...(relaxed !== null ? ["--relaxed", String(relaxed)] : []),
];

const report = {
    tool: "aot-oracle", started_at: new Date().toISOString(), node: process.version,
    candidate: { class: candClass, target: candTarget, mode: candMode },
    params: { cases, reps, outer, warmup, warmupCalls, check, fault, workdir,
        flags, flag_overrides: Object.fromEntries([...flagOverrides]), relaxed },
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
    const refArgs = ["--case", caseId, "--outer", String(outer), "--warmup", String(warmup), ...shapeArgs];
    const candArgsBase = candClass === "unit"
        ? ["--case", caseId, "--outer", String(outer), "--warmup", String(warmup), ...shapeArgs]
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
            report.cases[caseId] = { verdict: "ARM_FAILED", why: `capture run failed (${capture.status})`, reps: [] };
            continue;
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
        // A per-rep progress line, before any gate has run. It is the one place a raw ratio is
        // printed, so it says so: an ungated number copied out of a scrolling log is how a run
        // that ends INVALID still gets quoted as a result. `timingProblems` is named here rather
        // than left to the gate summary because a negative or non-finite slope makes the printed
        // ratio meaningless on its face.
        const nonRate = [...timingProblems(ref).map((p) => `ref.${p.field}=${p.value}`),
            ...timingProblems(cand).map((p) => `cand.${p.field}=${p.value}`)];
        process.stderr.write(
            `rep ${rep} ${caseId}: ref ${ref.ns_per_outer.toFixed(0)} ns/outer | cand ${cand.ns_per_outer.toFixed(0)}` +
            (nonRate.length
                ? ` | NOT A RATE (${nonRate.join(" ")}): ratio withheld`
                : ` | ratio ${(ref.ns_per_outer / cand.ns_per_outer).toFixed(2)}x (ungated)`) +
            ` | mem ${regionCmp.identical ? "identical" : "DIVERGENT"}` +
            ` | state ${stateCmp.available ? (stateCmp.identical ? "identical" : "DIVERGENT") : "uncompared"}\n`);
    }

    const good = reps_.filter((r) => !r.arm_failed);
    if (!good.length) { report.cases[caseId] = { verdict: "ARM_FAILED", reps: reps_.map(stripBytes) }; continue; }
    if (good.length < reps_.length) {
        process.stderr.write(`${caseId}: ${reps_.length - good.length}/${reps_.length} rep(s) failed; verdict is taken from the rest\n`);
    }

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
    const divergent = memDiverged.length > 0 || stateDiverged.length > 0;
    const first = memDiverged[0]?.regionCmp.first ?? null;
    const firstState = stateDiverged[0]?.stateCmp.first ?? null;
    const gateResult = evaluateGates({
        refRuns: good.map((r) => r.ref), candRuns: good.map((r) => r.cand),
        candClass, reportsNumber,
        // The comparator's result is a GATE, not only the verdict: `gates_failed` has to name the
        // equality failure, or a consumer reading that array calls a divergent run fully gated.
        comparison: {
            memory_identical: memDiverged.length === 0,
            state_compared: !stateUncompared,
            state_identical: stateDiverged.length === 0 ? (stateUncompared ? null : true) : false,
            state_uncompared: [...uncomparedFields],
            first: divergent ? describeFirst(first, firstState) : null,
        },
        requestedFlags: Object.fromEntries([...flagOverrides]), requestedRelaxed: relaxed,
    });

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
        // What the arms actually ran, read back from the engine — never a copy of the request.
        shape: {
            reference: { jit_flags: good[0].ref.jit_flags ?? null, relaxed_fpu: good[0].ref.relaxed_fpu ?? null },
            candidate: { jit_flags: good[0].cand.jit_flags ?? null, relaxed_fpu: good[0].cand.relaxed_fpu ?? null },
        },
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

// The worst PER-CASE verdict wins, with the run-level flags folded in at the same severity.
// Reading only the flags reported CORRECT for a run whose every rep failed: the flags are set
// inside the per-rep loop, and the all-reps-failed path takes an early-out that never enters
// it. A summary that does not consult the results it summarises is not one.
{
    const severity = { ARM_FAILED: 3, DIVERGENT: 2, INVALID: 1 };
    const seen = [
        ...cases.map((id) => report.cases[id]?.verdict ?? "ARM_FAILED"),
        ...(anyArmFailed ? ["ARM_FAILED"] : []),
        ...(anyDivergent ? ["DIVERGENT"] : []),
        ...(anyInvalid ? ["INVALID"] : []),
    ];
    const worst = seen.reduce((a, v) => ((severity[v] ?? 0) > (severity[a] ?? 0) ? v : a), null);
    report.verdict = severity[worst] ? worst : (check ? "CORRECT" : "VALID");
}
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
