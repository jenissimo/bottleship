#!/usr/bin/env node
/**
 * Split Arm A's per-call cost into a per-ELEMENT slope and a fixed intercept.
 *
 * The phase slope the runner already takes gives nanoseconds per CALL. That number cannot say
 * whether a mechanism aimed at the body would pay off, because it bundles the body with the call
 * frame, the wrapper and the driver's loop. Running the same case at two element counts and
 * taking a second slope separates them:
 *
 *     ns_per_call(n) = intercept + slope * n
 *
 * `slope` is what a per-access mechanism (a scoped memory proof, load forwarding) can attack;
 * `intercept` is what it cannot, and is therefore the ceiling on any such mechanism's share.
 *
 * This works only for a case whose element count is a PARAMETER. `k8`'s trip count is baked into
 * the kernel (`cmp [ebp-4], 8`), so its per-call cost cannot be swept without modifying guest
 * code — which is not a thing we do. That limitation is reported, not worked around.
 *
 *   node tools/aot/opt/element-sweep.mjs --case k3 --counts 64,256,512 --reps 5
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import path from "node:path";
import url from "node:url";

import { CASES } from "../../aot-oracle/corpus/cases.mjs";

const HERE = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const ARM = path.join(REPO, "tools", "aot-oracle", "arms", "run-v86.mjs");
const SPLIT_LINES = new RegExp("\\r?\\n");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
};
const CASE = argOf("case", "k3");
const COUNTS = argOf("counts", "64,256,512").split(",").map((s) => Number(s.trim()));
const REPS = Number(argOf("reps", 5));
const OUTER = Number(argOf("outer", 20000));
const WARMUP = Number(argOf("warmup", 4000));
const JSON_OUT = argOf("json", null);

/**
 * Cases whose inner element count is a parameter of the IMAGE rather than of the kernel. A case
 * not listed here cannot be swept, and saying so is the point: quoting a slope for a kernel whose
 * trip count is a constant would be quoting a line through one point.
 */
const SWEEPABLE = {
    k3: { env: "AOT_ORACLE_COUNT", why: "COUNT is the element count k3's wrapper passes in EAX" },
};

function runOnce(count) {
    const env = { ...process.env, [SWEEPABLE[CASE].env]: String(count) };
    const args = [ARM, "--case", CASE, "--outer", String(OUTER), "--warmup", String(WARMUP)];
    let out;
    try {
        out = execFileSync("node", args, { cwd: REPO, encoding: "utf8", env, maxBuffer: 64 << 20 });
    } catch (e) {
        out = String(e.stdout ?? "");
        if (!out.trim()) return { ok: false, error: String(e.stderr ?? e.message).slice(-300) };
    }
    try {
        const raw = JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
        if (raw.status !== "ok") return { ok: false, error: `arm status ${raw.status}` };
        return { ok: true, ns_per_outer: raw.ns_per_outer, guest_ins_per_outer: raw.guest_ins_per_outer };
    } catch (e) {
        return { ok: false, error: `unparseable arm output: ${e.message}` };
    }
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Ordinary least squares through (count, ns) — the two quantities the split needs. */
function fit(points) {
    const n = points.length;
    const sx = points.reduce((a, p) => a + p.count, 0);
    const sy = points.reduce((a, p) => a + p.ns, 0);
    const sxx = points.reduce((a, p) => a + p.count * p.count, 0);
    const sxy = points.reduce((a, p) => a + p.count * p.ns, 0);
    const denominator = n * sxx - sx * sx;
    if (denominator === 0) return null;
    const slope = (n * sxy - sx * sy) / denominator;
    const intercept = (sy - slope * sx) / n;
    // R^2, so a fit that is not a line reports as one instead of yielding a confident slope.
    const mean = sy / n;
    const ssTot = points.reduce((a, p) => a + (p.ns - mean) ** 2, 0);
    const ssRes = points.reduce((a, p) => a + (p.ns - (intercept + slope * p.count)) ** 2, 0);
    return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

if (!SWEEPABLE[CASE]) {
    console.log(JSON.stringify({
        case: CASE,
        status: "NOT_SWEEPABLE",
        why: `${CASE}'s element count is not an image parameter — it is fixed by the kernel's own `
            + "code, so ns/call cannot be separated into a slope and an intercept by varying it. "
            + `Sweepable cases: ${Object.keys(SWEEPABLE).join(", ")}.`,
    }, null, 2));
    process.exit(2);
}
if (COUNTS.length < 3) {
    console.error("need at least three counts: two points always fit a line exactly, so R^2 "
        + "would be 1 whether or not the cost is linear in the element count");
    process.exit(2);
}

console.log(`### element sweep — case ${CASE}, counts ${COUNTS.join(", ")}, ${REPS} reps each\n`);
const points = [];
let failed = null;
for (const count of COUNTS) {
    const samples = [];
    for (let rep = 0; rep < REPS; rep++) {
        const r = runOnce(count);
        if (!r.ok) { failed = `count ${count}: ${r.error}`; break; }
        samples.push(r.ns_per_outer);
    }
    if (failed) break;
    const ns = median(samples);
    const spread = Math.max(...samples) - Math.min(...samples);
    points.push({ count, ns, samples, spread_ns: spread });
    console.log(`  count=${String(count).padStart(5)}  median=${ns.toFixed(2)} ns/call  `
        + `spread=${spread.toFixed(2)} (${((spread / ns) * 100).toFixed(1)}%)  n=${samples.length}`);
}

if (failed) {
    console.log(`\n=== FAILED — ${failed} ===`);
    process.exit(1);
}

const model = fit(points);
const total = points.at(-1).ns;
const bodyShare = model ? (model.slope * points.at(-1).count) / total : null;
console.log(`\nfit: ns_per_call = ${model.intercept.toFixed(2)} + ${model.slope.toFixed(4)} * elements`
    + `   R^2 = ${model.r2.toFixed(5)}`);
console.log(`at ${points.at(-1).count} elements: body ${(bodyShare * 100).toFixed(1)}%, `
    + `fixed ${(100 - bodyShare * 100).toFixed(1)}%`);
// A spread comparable to the difference between the points makes the slope directional at best.
const worstSpread = Math.max(...points.map((p) => p.spread_ns / p.ns));
if (model.r2 < 0.99 || worstSpread > 0.1) {
    console.log(`  CAUTION: R^2 ${model.r2.toFixed(4)}, worst per-point spread `
        + `${(worstSpread * 100).toFixed(1)}% — treat the split as directional, not as a measurement.`);
}

const result = {
    case: CASE,
    status: "ok",
    counts: COUNTS,
    reps: REPS,
    outer: OUTER,
    warmup: WARMUP,
    points,
    model,
    buckets_at_max_count: {
        elements: points.at(-1).count,
        total_ns: total,
        body_ns: model.slope * points.at(-1).count,
        fixed_ns: model.intercept,
        body_share: bodyShare,
    },
    caveats: [
        "Only the two buckets a count sweep can separate. dispatch/guard/memory_preparation/"
            + "materialization stay unmeasured: Arm A does not instrument them.",
        "The intercept bundles the driver loop, the call, the wrapper and the kernel's own "
            + "prologue and epilogue. It is an upper bound on fixed cost, not the call frame alone.",
        "Both numbers are from the isolated node stand, not the browser.",
    ],
};
if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    console.log(`written: ${JSON_OUT}`);
}
void CASES;
