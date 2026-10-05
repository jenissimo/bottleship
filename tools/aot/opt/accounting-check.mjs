#!/usr/bin/env node
/**
 * Check a case's declared instruction accounting against the engine's own counter.
 *
 * Plan §4.2 keeps two counters apart: the ENGINE counter, which is observable runtime state a
 * region must materialize correctly at every boundary, and the logical-work ledger, which is an
 * independent measurement of what actually completed. This tool checks that the corpus's
 * analytic number is the first one — by running the same case at two outer counts and taking the
 * slope, so every fixed setup cost cancels.
 *
 * A number derived from `expectedCount` and labelled "executed" is the failure CLAUDE.md §3.4
 * names outright; the only way a work ledger earns its label is a measurement like this.
 *
 *   node tools/aot/opt/accounting-check.mjs [--case k8] [--low 200] [--high 400] [--json out.json]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import path from "node:path";
import url from "node:url";

import { CASES } from "../../aot-oracle/corpus/cases.mjs";
import { insPerOuter } from "../../aot-oracle/corpus/image.mjs";

const HERE = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const ARM = path.join(REPO, "tools", "aot-oracle", "arms", "run-v86.mjs");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
};
const CASE_IDS = (argOf("case", "k3,k4,k5,k8")).split(",").map((s) => s.trim()).filter(Boolean);
const LOW = Number(argOf("low", 200));
const HIGH = Number(argOf("high", 400));
const WARMUP = Number(argOf("warmup", 50));
const JSON_OUT = argOf("json", null);

/**
 * One run's total outer iterations. The driver performs `warmup + n1 + n2` measured iterations
 * and then one further capture call, so a slope taken between two runs must use exactly this,
 * or the constant it fails to cancel shows up as a fractional instruction count.
 */
const totalOuter = (warmup, outer) => warmup + outer + outer * 2 + 1;

function run(caseId, outer) {
    const args = [ARM, "--case", caseId, "--outer", String(outer), "--warmup", String(WARMUP)];
    let out;
    try {
        out = execFileSync("node", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
    } catch (e) {
        out = String(e.stdout ?? "");
        if (!out.trim()) return { ok: false, error: String(e.stderr ?? e.message).slice(-300) };
    }
    try {
        const raw = JSON.parse(out.trim().split(new RegExp("\\r?\\n")).at(-1));
        if (raw.status !== "ok") return { ok: false, error: `arm status ${raw.status}` };
        const counter = raw.state?.instruction_counter;
        if (typeof counter !== "number") return { ok: false, error: "arm reported no instruction_counter" };
        return { ok: true, counter, outer: raw.outer };
    } catch (e) {
        return { ok: false, error: `unparseable arm output: ${String(e.message)}` };
    }
}

const results = [];
let allOk = true;
for (const caseId of CASE_IDS) {
    const c = CASES[caseId];
    if (!c) { console.log(`${caseId}: NO SUCH CASE`); allOk = false; continue; }
    const analytic = insPerOuter(c);
    const lo = run(caseId, LOW);
    const hi = run(caseId, HIGH);
    if (!lo.ok || !hi.ok) {
        console.log(`${caseId}: ARM_FAILED ${lo.error ?? hi.error}`);
        results.push({ case: caseId, ok: false, error: lo.error ?? hi.error });
        allOk = false;
        continue;
    }
    // The counter is a wrapping u32; these runs are far below 2^32, and a negative delta would
    // mean a wrap the slope cannot see, so it is reported rather than folded away.
    const deltaCounter = hi.counter - lo.counter;
    const deltaOuter = totalOuter(WARMUP, HIGH) - totalOuter(WARMUP, LOW);
    const measured = deltaCounter / deltaOuter;
    const ok = deltaCounter > 0 && measured === analytic;
    if (!ok) allOk = false;
    console.log(
        `${caseId}: ${ok ? "PASS" : "FAIL"}  analytic=${analytic}  measured=${measured}`
        + `  (counter ${lo.counter} -> ${hi.counter} over ${deltaOuter} outer iterations)`);
    results.push({
        case: caseId, ok, analytic, measured,
        counters: { low: lo.counter, high: hi.counter },
        outer: { low: totalOuter(WARMUP, LOW), high: totalOuter(WARMUP, HIGH), delta: deltaOuter },
        wrapped: deltaCounter <= 0,
    });
}

console.log(`\n=== ${allOk ? "PASS" : "FAIL"} — ${results.filter((r) => r.ok).length}/${results.length} cases ===`);
if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({ warmup: WARMUP, low: LOW, high: HIGH, results, passed: allOk }, null, 2));
    console.log(`written: ${JSON_OUT}`);
}
process.exit(allOk ? 0 : 1);
