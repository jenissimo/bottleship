#!/usr/bin/env bun
/**
 * guestbench — run a synthetic guest fixture and print its ledgers.
 *
 * The roadmap requires a perf fixture per lever, with "фиксированная работа,
 * детерминированный checksum, без sleep и frame limiter", a SCALE knob to check the model
 * `ms = fixed + k x SCALE`, and the fixtures living IN this repository so two branches can
 * be compared. That is what this is.
 *
 * What it deliberately does NOT do is declare a winner. `--ab` runs two parameter sets in
 * alternating order and prints both medians and the spread; whether a difference is a
 * result is a judgement against a noise floor measured on the same machine in the same
 * session, which is what `--ab base base` (an A/A run) is for. A delta smaller than that is
 * a direction, not a number.
 *
 *   bun tools/guestbench/run.mjs list
 *   bun tools/guestbench/run.mjs stack_mix --mix 80 --iterations 200000 --repeat 5
 *   bun tools/guestbench/run.mjs x87_chain --scale chain=2,4,8,16 --repeat 3
 *   bun tools/guestbench/run.mjs stack_mix --census
 *   bun tools/guestbench/run.mjs vcall_dense --dispatch
 *   bun tools/guestbench/run.mjs stack_mix --ab mix=20 mix=80 --repeat 5
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixture, rollupCensus, LIBV86 } from "./lib/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "fixtures");

async function loadFixtures() {
    const out = new Map();
    for (const f of readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".mjs"))) {
        const mod = await import(resolve(FIXTURE_DIR, f));
        out.set(mod.default.name, mod.default);
    }
    return out;
}

function parseArgs(argv) {
    const out = { _: [], params: {}, repeat: 1, iterations: 200_000, census: false, dispatch: false, json: false, scale: null, ab: null, jit: true, stackRaw: 0, permMap: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--census") out.census = true;
        else if (a === "--dispatch") out.dispatch = true;
        else if (a === "--json") out.json = true;
        else if (a === "--no-jit") out.jit = false;
        else if (a === "--stack-raw") out.stackRaw = 1;
        else if (a === "--raw-all") out.stackRaw = 2;
        else if (a === "--perm-map") out.permMap = true;
        else if (a === "--repeat") out.repeat = Number(argv[++i]);
        else if (a === "--iterations") out.iterations = Number(argv[++i]);
        else if (a === "--scale") out.scale = argv[++i];
        else if (a === "--ab") { out.ab = [argv[++i], argv[++i]]; }
        else if (a.startsWith("--")) out.params[a.slice(2)] = Number(argv[++i]);
        else out._.push(a);
    }
    return out;
}

/** "mix=20,chain=4" -> { mix: 20, chain: 4 } */
function parseParamSpec(spec) {
    const out = {};
    if (!spec) return out;
    for (const kv of spec.split(",")) {
        const [k, v] = kv.split("=");
        out[k.trim()] = Number(v);
    }
    return out;
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Interquartile range over the median. A max-minus-min spread reads 200% off ONE OS
 *  hiccup in seven samples while the median moves 0.4%, which makes every A/B look
 *  unreadable; the range is still printed next to it so an outlier stays visible. */
const spread = (xs) => {
    if (xs.length < 4) return xs.length < 2 ? 0 : (Math.max(...xs) - Math.min(...xs)) / median(xs);
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return (q(0.75) - q(0.25)) / median(xs);
};

async function repeat(fixture, opts, n) {
    const runs = [];
    for (let i = 0; i < n; i++) runs.push(await runFixture(fixture, opts));
    const checksums = new Set(runs.map((r) => r.checksum));
    const statuses = new Set(runs.map((r) => r.status));
    return {
        runs,
        ms: runs.map((r) => r.measured.ms),
        checksum: runs[0].checksum,
        checksumStable: checksums.size === 1,
        status: statuses.size === 1 ? runs[0].status : [...statuses].join("/"),
        retired: runs[0].measured.retired,
        warmupMs: median(runs.map((r) => r.warmup.ms)),
    };
}

function printArm(label, r) {
    const med = median(r.ms);
    console.log(`  ${label.padEnd(28)} median ${med.toFixed(2)} ms   iqr ${(spread(r.ms) * 100).toFixed(1)}%   `
        + `min/max ${Math.min(...r.ms).toFixed(1)}/${Math.max(...r.ms).toFixed(1)}   `
        + `retired ${r.retired}   ${(med * 1e6 / r.retired).toFixed(2)} ns/insn`);
    console.log(`  ${"".padEnd(28)} checksum 0x${r.checksum.toString(16).padStart(8, "0")}`
        + `${r.checksumStable ? "" : "  *** UNSTABLE ACROSS REPEATS ***"}   status ${r.status}   `
        + `raw [${r.ms.map((v) => v.toFixed(1)).join(", ")}]`);
}

async function printCensus(census) {
    const r = await rollupCensus(census);
    console.log(`\n  census: ${r.counted} instructions counted, ${r.memoryOps} with a memory operand`);
    const rows = (m, total) => [...m.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v} (${((v / total) * 100).toFixed(1)}%)`).join("  ");
    console.log(`    classes:   ${rows(r.byClass, r.counted)}`);
    console.log(`    addressing:${rows(r.byAddr, r.addrTotal)}`);
    if (r.bySimd.size) console.log(`    simd:      ${rows(r.bySimd, r.counted)}`);
    if (r.addrTotal !== r.memoryOps) {
        console.log(`    *** the addressing census (${r.addrTotal}) and opcode census (${r.memoryOps}) disagree ***`);
    }
}

function printEntryEip(e) {
    if (!e) { console.log("    entry-EIP census unavailable (rebuild vendor/v86)"); return; }
    console.log(`    entry EIPs: ${e.samples} dispatcher entries, ${e.evictions} unattributed `
        + `(${e.evictionPct}%)${e.evictionPct > 5 ? "  <-- top is a SAMPLE, not the distribution" : ""}`);
    for (const r of e.top.slice(0, 8)) {
        console.log(`      0x${r.eip.toString(16).padStart(8, "0")}  ${r.hits}`);
    }
}

function printDispatch(d) {
    const exits = d.moduleReentry + d.moduleChainedEdge;
    const pct = (n) => (exits > 0 ? `${((n / exits) * 100).toFixed(1)}%` : "n/a");
    console.log(`\n  dispatch: ${exits} module exits (${d.blockExecution} block executions)`);
    console.log(`    chained=${d.moduleChainedEdge} (${pct(d.moduleChainedEdge)})  `
        + `constantTargetUnchained=${d.moduleExitChainable} (${pct(d.moduleExitChainable)})  `
        + `dynamic=${d.moduleExitDynamic} (${pct(d.moduleExitDynamic)})  `
        + `indirect=${d.moduleExitIndirect} (${pct(d.moduleExitIndirect)})`);
    console.log(`    absEip=${d.abseipDispatch}  memo hit/alias/cold=${d.retMemoHit}/${d.retMemoAlias}/${d.retMemoCold}  `
        + `metaHit=${d.retMetaHit}  chain hit/miss=${d.retChainHit}/${d.retChainMiss}`);
}

async function main() {
    const argv = process.argv.slice(2);
    const opts = parseArgs(argv);
    const fixtures = await loadFixtures();
    const name = opts._[0];

    if (!name || name === "list") {
        console.log("guestbench fixtures:");
        for (const f of fixtures.values()) {
            console.log(`  ${f.name.padEnd(14)} ${f.describe}`);
            const d = Object.entries(f.defaults ?? {});
            if (d.length) console.log(`  ${"".padEnd(14)} params: ${d.map(([k, v]) => `${k}=${v}`).join(" ")}`);
        }
        console.log("\nusage: bun tools/guestbench/run.mjs <fixture> [--iterations N] [--repeat N] "
            + "[--<param> V] [--scale p=a,b,c] [--ab 'p=a' 'p=b'] [--census] [--dispatch] [--no-jit] [--json]");
        return;
    }
    if (!existsSync(LIBV86)) {
        console.error("guestbench: vendor/v86/build/libv86.mjs absent — run vendor/v86/build-wasm.sh");
        process.exit(1);
    }
    const fixture = fixtures.get(name);
    if (!fixture) {
        console.error(`guestbench: no fixture named '${name}' (try 'list')`);
        process.exit(1);
    }

    const base = { ...(fixture.defaults ?? {}), ...opts.params };
    const common = { iterations: opts.iterations, census: opts.census, dispatch: opts.dispatch, jit: opts.jit, stackRaw: opts.stackRaw, permMap: opts.permMap };
    console.log(`guestbench ${fixture.name}: ${opts.iterations} iterations x ${opts.repeat} repeat(s), `
        + `jit=${opts.jit ? "on" : "off"}${opts.permMap ? ", PERM-MAP reads ON" : ""}${opts.stackRaw ? `, RAW MODE ${opts.stackRaw} (unsound ceiling experiment: ${opts.stackRaw === 1 ? "ESP/EBP+const reads" : "all flat 32-bit reads"})` : ""}`);

    // --scale p=a,b,c — the model check. A fixture whose ms/iteration is not affine in its
    // scale parameter is not measuring what its name says.
    if (opts.scale) {
        const [key, values] = opts.scale.split("=");
        const results = [];
        for (const v of values.split(",").map(Number)) {
            const r = await repeat(fixture, { ...common, params: { ...base, [key]: v } }, opts.repeat);
            results.push([v, r]);
            printArm(`${key}=${v}`, r);
        }
        console.log(`\n  model ms/iteration = fixed + k x ${key}:`);
        for (let i = 1; i < results.length; i++) {
            const [v0, r0] = results[i - 1], [v1, r1] = results[i];
            const k = (median(r1.ms) - median(r0.ms)) / (v1 - v0) / opts.iterations * 1e6;
            console.log(`    ${key} ${v0} -> ${v1}: k = ${k.toFixed(3)} ns per unit per iteration`);
        }
        return;
    }

    // --ab: alternating order, so a drift in machine state hits both arms alike.
    if (opts.ab) {
        const specs = opts.ab.map(parseParamSpec);
        const arms = [[], []];
        for (let i = 0; i < opts.repeat; i++) {
            for (const armIdx of (i % 2 === 0 ? [0, 1] : [1, 0])) {
                const r = await runFixture(fixture, { ...common, params: { ...base, ...specs[armIdx] } });
                arms[armIdx].push(r);
            }
        }
        for (const i of [0, 1]) {
            const ms = arms[i].map((r) => r.measured.ms);
            const checksums = new Set(arms[i].map((r) => r.checksum));
            printArm(opts.ab[i], {
                ms, checksum: arms[i][0].checksum, checksumStable: checksums.size === 1,
                status: arms[i][0].status, retired: arms[i][0].measured.retired,
            });
        }
        const m0 = median(arms[0].map((r) => r.measured.ms)), m1 = median(arms[1].map((r) => r.measured.ms));
        console.log(`\n  B/A = ${(m1 / m0).toFixed(4)}  (spread A ${(spread(arms[0].map((r) => r.measured.ms)) * 100).toFixed(1)}%, `
            + `B ${(spread(arms[1].map((r) => r.measured.ms)) * 100).toFixed(1)}%)`);
        console.log("  A delta inside the spread is a direction, not a result. Run --ab with the SAME spec twice "
            + "to measure this machine's noise floor before reading it as one.");
        if (arms[0][0].checksum !== arms[1][0].checksum) {
            console.log("  NOTE: the arms have different checksums. That is expected when the parameter changes the "
                + "work, and fatal when it is supposed not to.");
        }
        return;
    }

    const r = await repeat(fixture, { ...common, params: base }, opts.repeat);
    printArm(Object.entries(base).map(([k, v]) => `${k}=${v}`).join(" ") || "default", r);
    console.log(`  warm-up pass: ${r.warmupMs.toFixed(1)} ms (excluded from the numbers above)`);

    const last = r.runs[r.runs.length - 1];
    if (opts.census) await printCensus(last.census);
    if (opts.dispatch) { printDispatch(last.dispatch); printEntryEip(last.entryEip); }
    if (opts.json) console.log(`\n${JSON.stringify({ ...last, census: undefined }, null, 2)}`);
}

await main();
