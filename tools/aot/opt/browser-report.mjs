#!/usr/bin/env node
/**
 * The browser A/C report: the run the plan accepts a performance result from.
 *
 * Node runs are for correctness and diagnostic attribution; a performance result is accepted from
 * an uninstrumented fixed-work run in a stock browser. This is that run.
 *
 * The arms ALTERNATE inside one browser. A machine drifts, and a block of reference samples
 * followed by a block of candidate samples turns that drift into a ratio; separate browsers turn
 * the difference between two processes into one. Each round still builds a fresh emulator per arm.
 *
 *   node tools/aot/opt/browser-report.mjs --unit <manifest> [--rounds 5] [--outer 1000000]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { steady } from "../../aot-oracle/lib/gates.mjs";
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
 * Judge a run recorded earlier instead of launching one.
 *
 * The gates below decide whether a number may be quoted, and a gate whose failure has never been
 * seen is an assurance nobody checked. Replay is what lets the shapes it refuses be fed to it —
 * see `browser-gate-selftest.mjs` — without a browser and without waiting for the machine to
 * misbehave on its own.
 */
const REPLAY = argOf("replay", null);
const UNIT = argOf("unit", null);
const ROUNDS = argOf("rounds", "5");
const OUTER = argOf("outer", "1000000");
const WARMUP = argOf("warmup", "1000000");
/** The spread the machine must stay inside — the same rule the Node oracle applies. */
const MAX_SPREAD_PCT = Number(argOf("max-spread", "10"));
/** Steady rounds required before a ratio is reported at all. */
const MIN_ROUNDS = Number(argOf("min-rounds", "5"));

if (!UNIT && !REPLAY) {
    console.error("usage: browser-report.mjs --unit <manifest.json> [--rounds 5]");
    console.error("       browser-report.mjs --replay <run.json>");
    process.exit(2);
}

let out;
if (REPLAY) {
    out = fs.readFileSync(REPLAY, "utf8");
} else try {
    out = execFileSync("bun", [
        path.join(REPO, "tools/aot-oracle/arms/run-browser.ts"),
        "--case", CASE, "--outer", OUTER, "--warmup", WARMUP,
        "--rounds", ROUNDS, "--unit", UNIT, "--timeout", "900000",
    ], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
    out = String(e.stdout ?? "");
}
const r = JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
if (r.status !== "ok") {
    console.error(`browser arm failed: ${r.status} ${JSON.stringify(r.errors ?? r.why ?? "")}`);
    process.exit(3);
}

console.log(`### browser arms — case ${CASE}, ${r.rounds.length} alternating rounds of ${OUTER} outer\n`);
const ns = { reference: [], unit: [] };
const kept = [];
const dropped = [];
for (const [i, round] of r.rounds.entries()) {
    // The SAME validity rule the Node oracle applies to every rep: phase 2 does twice the work,
    // so its wall time must be about twice phase 1's. A round in which the engine was still
    // compiling during phase 1 fails it, and such a sample is not a measurement of steady-state
    // speed — for either arm. Dropping it is not retrying until a number appears: the rule is
    // fixed, applied to both arms, and decided before any ratio is looked at.
    const st = { reference: steady(round.reference), unit: steady(round.unit) };
    const ok = st.reference.ok && st.unit.ok;
    console.log(`  round ${i}  reference ${round.reference.ns_per_outer.toFixed(1)}`
        + `   unit ${round.unit.ns_per_outer.toFixed(1)} ns/outer`
        + `   steady ${st.reference.ratio.toFixed(2)}/${st.unit.ratio.toFixed(2)}`
        + `${ok ? "" : "   DROPPED (not steady)"}`);
    if (!ok) { dropped.push(i); continue; }
    kept.push(round);
    for (const name of ["reference", "unit"]) ns[name].push(round[name].ns_per_outer);
}
if (kept.length < MIN_ROUNDS) {
    console.log(`\n=== WITHHELD — only ${kept.length} steady rounds of ${r.rounds.length} `
        + `(need ${MIN_ROUNDS}); raise --warmup or quiet the machine ===`);
    process.exit(1);
}

const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const median = s[(s.length - 1) >> 1];
    return { median, spread: ((s.at(-1) - s[0]) / median) * 100 };
};
const a = stats(ns.reference);
const c = stats(ns.unit);
console.log(`\n  reference  ${a.median.toFixed(1)} ns/outer   spread ${a.spread.toFixed(1)}%`);
console.log(`  unit       ${c.median.toFixed(1)} ns/outer   spread ${c.spread.toFixed(1)}%`);

/**
 * The PAIRED ratio is the statistic this design is for.
 *
 * The arms alternate inside a round, so an event that slows the machine slows both of that
 * round's samples and cancels in their ratio. Comparing two medians instead lets such an event
 * land on one arm and become a result — which is the same reason the rounds alternate at all.
 * The absolute spreads stay reported, because they say how quiet the machine was.
 */
const ratios = kept.map((round) => round.reference.ns_per_outer / round.unit.ns_per_outer);
const paired = stats(ratios);
console.log(`  paired     ${paired.median.toFixed(3)}x per-round ratio   spread ${paired.spread.toFixed(1)}%`);

const shape = (x) => JSON.stringify({ regions: x.regions, state: x.state });
const entries = kept.reduce((n, round) => n + (round.unit.aot?.entries ?? 0), 0);
const problems = [];
// The two arms must have computed the same thing, or the ratio is between two different jobs.
for (const [i, round] of kept.entries()) {
    if (shape(round.reference) !== shape(round.unit)) problems.push(`kept round ${i} arms disagree`);
}
/**
 * The candidate arm must have been the candidate for the WHOLE of every round it contributes.
 *
 * A total entry count cannot see a unit that ran once, was freed, and left the rest of the round
 * to the ordinary JIT: the count is positive and the time is the baseline's, which is exactly the
 * false PASS this gate exists to refuse. So the demand is per round and end-of-round — the slot
 * still holds OUR function, the unit still owns its page, and the engine's own per-slot counter
 * says it was entered.
 */
for (const [i, round] of kept.entries()) {
    const live = round.unit.aot;
    if (!live) {
        problems.push(`kept round ${i}: the candidate arm published no unit`);
        continue;
    }
    const missing = ["registered", "sameFn", "ownsPage", "entered"].filter((k) => live[k] !== true);
    if (missing.length) {
        problems.push(`kept round ${i}: unit not ${missing.join("/")}`
            + `${live.why ? ` (${live.why})` : ""}`);
    }
    if (!(live.entries > 0)) {
        problems.push(`kept round ${i}: the unit was never entered (entries=${live.entries})`);
    }
    // And the reference arm must be the reference: a round that published a unit on both sides
    // has no baseline in it.
    if (round.reference.aot) problems.push(`kept round ${i}: the reference arm published a unit`);
}
// The gate is on the RATIOS: absolute spread measures the machine, and a machine that wandered
// while both arms wandered with it has not invalidated the comparison between them.
if (paired.spread > MAX_SPREAD_PCT) {
    problems.push(`paired-ratio spread ${paired.spread.toFixed(1)}%`
        + ` (absolute: reference ${a.spread.toFixed(1)}%, unit ${c.spread.toFixed(1)}%)`);
}

if (problems.length) {
    console.log(`\n=== WITHHELD — ${problems.join("; ")} ===`);
    process.exit(1);
}
const ratio = paired.median;
console.log(`\n  unit runs at ${ratio.toFixed(3)}x the baseline's speed `
    + `(${ratio > 1 ? `${((ratio - 1) * 100).toFixed(1)}% faster` : `${((1 - ratio) * 100).toFixed(1)}% slower`})`);
console.log(`  the unit was entered ${entries} times and still owned its page at the end of every`
    + ` kept round, so the candidate arm is not the baseline twice`);
console.log(`  ${kept.length} steady rounds kept, ${dropped.length} dropped`
    + `${dropped.length ? ` (${dropped.join(", ")})` : ""}`);
// Uninstrumented in the sense the plan means: neither arm carries measurement work the other
// does not. The entry counter the Node arms wrap around an import is off here (see
// `publishUnit`), so what is timed is the unit itself.
console.log("\n=== PASS — uninstrumented fixed work, stock browser ===");
