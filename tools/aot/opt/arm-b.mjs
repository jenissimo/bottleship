#!/usr/bin/env node
/**
 * Arm B end to end: capture, lower, publish, and prove the unit against the reference.
 *
 * This is the whole P1.5/P1.6 loop in one command, because every step depends on the live engine
 * the previous one measured. It captures a job (table slot, page hash, engine SHA, TLB base),
 * lowers the code AT THAT ENTRY, verifies the artifact against the unit contract, stages it
 * through the engine's own dispatch, and runs the oracle's positive AND negative controls.
 *
 * What it proves: the new compiler's conservative unit computes what the baseline computes —
 * guest memory, the architectural register file, v86's raw lazy flag tuple and the instruction
 * counter — and the oracle can still tell a wrong one apart.
 *
 * What it does NOT prove: anything about speed. The timing gates need a warmup this run does not
 * pay for, and Arm B is conservative by construction.
 *
 *   node tools/aot/opt/arm-b.mjs [--case k3] [--keep <dir>]
 */

import { execFileSync } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
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
const WARMUP = argOf("warmup", "20000");
/**
 * Long enough that the engine dispatches into the middle of the page.
 *
 * A unit can own its page for tens of thousands of calls and lose it later, so a shorter check
 * reports a liveness the workload never tested.
 */
const LIVENESS_WARMUP = argOf("liveness-warmup", "200000");
/**
 * Bytes of the entry the hazard artifact covers: everything up to, but not including, the
 * terminator. The region then ends at an address on its own page that it cannot serve.
 */
const HAZARD_CODE_LIMIT = argOf("hazard-code-limit", "31");
const dir = argOf("keep", null) ?? mkdtempSync(path.join(tmpdir(), "aot-opt-armb-"));

const run = (cmd, args, cwd = REPO) =>
    execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
const lastJson = (out) => JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
/** Parse a pretty-printed object that starts partway through the output. */
const firstJson = (out) => JSON.parse(out.slice(out.indexOf("{")));

const steps = [];
function step(name, fn) {
    try {
        const detail = fn();
        steps.push({ name, ok: true, detail });
        console.log(`  PASS  ${name}${detail ? `  ${detail}` : ""}`);
        return true;
    } catch (e) {
        const why = String(e.stdout ?? "").trim() || String(e.stderr ?? e.message).slice(-400);
        steps.push({ name, ok: false, why });
        console.log(`  FAIL  ${name}\n        ${why.split("\n").slice(-4).join("\n        ")}`);
        return false;
    }
}

console.log(`### Arm B — case ${CASE}\n`);
const job = path.join(dir, `job-${CASE}.json`);
const unit = path.join(dir, `opt-${CASE}`);

let ok = step("capture a live job (table slot, page hash, engine identity)", () => {
    run("node", [path.join(REPO, "tools/aot/capture-job.mjs"), "--case", CASE, "--out", job, "--warmup", WARMUP]);
    return `job at ${path.basename(job)}`;
});

if (ok) {
    ok = step("lower the code AT THE ENTRY and verify the artifact", () => {
        const r = firstJson(run("node", [path.join(REPO, "tools/aot/opt/publish.mjs"), "--job", job, "--out", unit, "--case", CASE]));
        return `${r.instructions_lifted} instructions, ${r.bytes} bytes, `
            + `${r.verifier_checks_passed} contract checks, slot ${r.tableIndex}`;
    });
}

if (ok) {
    ok = step("the engine enters the unit through its own dispatch", () => {
        const r = lastJson(run("node", [
            path.join(REPO, "tools/aot-oracle/arms/run-v86.mjs"),
            "--case", CASE, "--one-call", "--aot", `${unit}.json`,
        ]));
        const a = r.aot;
        if (!a?.registered || !a.entered || !a.sameFn || !a.ownsPage) {
            throw new Error(`publication or entry refused: ${JSON.stringify(a)}`);
        }
        if (r.aot_relocations?.ok !== true) {
            throw new Error(`relocations not re-derived from the live instance: ${JSON.stringify(r.aot_relocations)}`);
        }
        return "registered, entered, owns the page, relocations re-derived";
    });
}

if (ok) {
    ok = step("positive and negative controls against the reference", () => {
        const out = run("node", [path.join(REPO, "tools/aot-oracle/oracle.mjs"),
            "--prove", "--case", CASE, "--candidate", `unit:${unit}.json`],
            path.join(REPO, "tools/aot-oracle"));
        const r = JSON.parse(out.slice(out.indexOf("{")));
        if (r.verdict !== "PROVE_PASS") {
            throw new Error(`${r.verdict}: ${JSON.stringify(r.rows?.map((c) => [c.kind, c.verdict]))}`);
        }
        // A positive control alone proves nothing: the negative one is what shows the oracle can
        // still tell a wrong unit apart.
        const kinds = (r.rows ?? []).map((c) => `${c.expected}->${c.verdict}`);
        return kinds.join(", ");
    });
}

if (ok) {
    // A short run cannot see this. A unit owns its guest page, and an engine dispatch to an
    // address on that page the unit does not claim makes the engine compile the page itself,
    // which frees the owning module. The manifest still reads "published", the arm still
    // produces the right answer — because the JIT finished the workload — and a timing number
    // taken there would be the JIT's. So the claim is checked under load, and against the
    // engine's own entry counter: every call must have entered the unit.
    ok = step("the unit still owns its page after a long run (not handed back to the JIT)", () => {
        const outer = 4000;
        const r = lastJson(run("node", [
            path.join(REPO, "tools/aot-oracle/arms/run-v86.mjs"),
            "--case", CASE, "--outer", String(outer), "--warmup", LIVENESS_WARMUP,
            "--aot", `${unit}.json`,
        ]));
        const a = r.aot;
        if (!a?.sameFn || !a.ownsPage) {
            throw new Error(`page was taken back: ${JSON.stringify(a)}`);
        }
        // phase1 is `outer`, phase2 is twice that (run-v86's outer schedule), plus the warmup
        // and the single trailing call the driver makes.
        const calls = Number(LIVENESS_WARMUP) + outer * 3 + 1;
        if (a.entries !== calls) {
            throw new Error(`entered ${a.entries} times, expected ${calls}: some calls ran elsewhere`);
        }
        return `${a.entries} entries over ${calls} calls, page still ours`;
    });
}

if (ok) {
    // The control for the check above, in two legs: the publisher must REFUSE a unit that hands
    // control back on its own page, and that refusal must be about a real consequence — so the
    // refused artifact is built deliberately and shown to lose the page.
    ok = step("CONTROL: a unit that exits on its own page is refused, and would lose the page", () => {
        const hazardOut = path.join(dir, `hazard-${CASE}`);
        const publishArgs = [
            path.join(REPO, "tools/aot/opt/publish.mjs"), "--job", job, "--case", CASE,
            "--out", hazardOut, "--code-limit", String(HAZARD_CODE_LIMIT),
        ];
        let refused = false;
        try {
            run("node", publishArgs);
        } catch (e) {
            refused = /hand control back at page offsets/.test(String(e.stderr ?? ""));
            if (!refused) throw e;
        }
        if (!refused) throw new Error("the publisher accepted a unit that exits on its own page");

        run("node", [...publishArgs, "--prove-on-page-exit-hazard"]);
        const manifest = JSON.parse(fs.readFileSync(`${hazardOut}.json`, "utf8"));
        if (!manifest.on_page_exit_hazard?.length) {
            throw new Error("the hazard artifact is not stamped as one");
        }
        const r = lastJson(run("node", [
            path.join(REPO, "tools/aot-oracle/arms/run-v86.mjs"),
            "--case", CASE, "--outer", "4000", "--warmup", LIVENESS_WARMUP,
            "--aot", `${hazardOut}.json`,
        ]));
        const a = r.aot;
        if (a?.sameFn && a.ownsPage) {
            throw new Error(`the hazard unit kept the page, so the rule describes nothing: `
                + JSON.stringify(a));
        }
        return `refused, and when forced it lost the page (offsets `
            + `[${manifest.on_page_exit_hazard.join(", ")}], entries=${a?.entries})`;
    });
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n=== ${failed.length === 0 ? "PASS" : "FAIL"} — ${steps.length - failed.length}/${steps.length} steps ===`);
if (!argOf("keep", null)) console.log(`artifacts: ${dir}`);
console.log("NOTE: correctness only. Arm B is conservative by construction and this run pays no "
    + "warmup, so nothing here is a timing result.");
process.exit(failed.length === 0 ? 0 : 1);
