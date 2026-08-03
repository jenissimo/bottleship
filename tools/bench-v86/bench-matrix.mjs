#!/usr/bin/env node
// Benchmark matrix driver: runs named configs × N runs sequentially (one emulator
// at a time — these are CPU-bound), aggregates medians, emits a markdown summary.
//
// Usage:
//   node bench-matrix.mjs [--runs 3] [--configs shipping,shipping-minus-pushrun]
//                         [--tests DONUMSORT,DOFOUR] [--timeout 90] [--dry|--list]
//
// Config definitions live in CONFIGS below. Results land in
// results/matrix-<stamp>/: per-run JSONs + summary.md.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../..");

// Supported production JIT indices only (vendor/v86 src/rust/jit.rs). Retired 4/9/18 must never
// return here. This is the one shipping baseline: it mirrors PreemptionManager defaults, including
// x87 locals OFF and branch-hint group 0 ON. `relaxed: 1` is explicit shipping policy too.
const SHIPPING_JIT = new Map([
    [5, 1], [10, 0], [11, 1], [12, 1], [13, 1], [15, 300000], [17, 8], [19, 0], [21, 0], [22, 1],
]);
const formatFlags = (flags) => [...flags.entries()].map(([index, value]) => `${index}=${value}`).join(",");
const withShippingChange = (index, value) => {
    const flags = new Map(SHIPPING_JIT);
    flags.set(index, value);
    return formatFlags(flags);
};
const SHIPPING_FLAGS = formatFlags(SHIPPING_JIT);
const REFERENCE_ALL_OFF = formatFlags(new Map([...SHIPPING_JIT.keys()].map(index => [index, 0])));
const LOSSLESS = withShippingChange(15, 0);
const OFF_ALL = REFERENCE_ALL_OFF; // legacy reference-ablation input, never a marginal baseline

const FORK = path.resolve(process.env.V86_ENGINE_DIR || path.join(REPO, "vendor/v86"));
const STOCK = path.join(__dirname, "engines/stock");

const shippingMinus = (feature, index, value = 0) => ({
    engine: FORK,
    flags: withShippingChange(index, value),
    relaxed: 1,
    role: `shipping-minus-one: ${feature}`,
    marginal: { feature, index, value },
});

const CONFIGS = {
    // ── headline ────────────────────────────────────────────────────────────
    "stock":          { engine: STOCK },
    // upstream at the fork's merge-base (11cf7dd9), built by the mergebase agent
    "mergebase":      { engine: "C:/Users/jenis/AppData/Local/Temp/claude/C--Projects-bottleship-oss/bb69cc5a-a26b-46b6-85b8-af517684f3db/scratchpad/v86-mergebase" },
    // frozen pre-picks fork build (TSC fix included) — A/B "before" snapshot
    "fork-tscfix":    { engine: path.join(__dirname, "engines/fork-tscfix") },
    // fork + upstream-picks-2026-07 batch (current vendor/v86 build)
    "fork-picks":     { engine: FORK },
    "fork-picks-relaxed":  { engine: FORK, relaxed: 1 },
    // picks + adapted a4ec212b/51de3af0 port (isolated clone, TSC fix applied)
    "fork-a4ec":      { engine: "C:/Users/jenis/AppData/Local/Temp/claude/C--Projects-bottleship-oss/bb69cc5a-a26b-46b6-85b8-af517684f3db/scratchpad/v86-regmove" },
    // upstream master built with our toolchain (attribution third point)
    "master-ourbuild": { engine: "C:/Users/jenis/AppData/Local/Temp/claude/C--Projects-bottleship-oss/bb69cc5a-a26b-46b6-85b8-af517684f3db/scratchpad/v86-master-ourbuild" },
    // current fork wasm passed through wasm-opt -O2 --strip-debug (upstream release step we lack)
    "fork-wasmopt":   { engine: path.join(__dirname, "engines/fork-wasmopt") },
    "fork-tscfix-relaxed": { engine: path.join(__dirname, "engines/fork-tscfix"), relaxed: 1 },
    // Exact current BottleShip defaults; this is the only baseline for keep/drop percentage.
    "shipping": { engine: FORK, flags: SHIPPING_FLAGS, relaxed: 1, role: "shipping baseline" },
    // Diagnostic/reference only: all production-controlled JIT features off, but the shipping
    // relaxed-FPU policy remains on. It is never a marginal comparison.
    "reference-all-off": { engine: FORK, flags: REFERENCE_ALL_OFF, relaxed: 1, role: "reference all-off (non-marginal)" },
    // Compatibility aliases retain existing CLI selections but carry the same reference semantics.
    "fork-off": { engine: FORK, flags: REFERENCE_ALL_OFF, relaxed: 1, role: "reference all-off (non-marginal; legacy alias)" },
    "fork-lossless": { engine: FORK, flags: LOSSLESS, relaxed: 0, role: "strict-FPU/tier-2-off reference (non-marginal)" },
    "fork-prod-lossless": { engine: FORK, flags: SHIPPING_FLAGS, relaxed: 0, role: "strict-FPU shipping-JIT reference (non-marginal)" },
    // True marginal contours: each differs from `shipping` in exactly one active supported JIT
    // feature. All other production values, including x87Locals=0 and relaxed FPU, stay fixed.
    "shipping-minus-deadflag": shippingMinus("dead-flag elision", 5),
    "shipping-minus-pushrun": shippingMinus("push-run coalescing", 11),
    "shipping-minus-retchain": shippingMinus("RET dynamic chaining", 12),
    "shipping-minus-retspec": shippingMinus("RET-target speculation", 13),
    "shipping-minus-tier2": shippingMinus("tier-2 hotness", 15),
    "shipping-minus-tier2-page-cap": shippingMinus("tier-2 page cap", 17),
    "shipping-minus-branch-hints": shippingMinus("wasm branch-hint group 0", 22),
    // ── reference-only add-one probes (not marginal) ───────────────────────
    // Legacy add-one-to-all-off reference probes. They are retained for compatibility and
    // diagnostics only; unlike `shipping-minus-*`, none is a marginal keep/drop measurement.
    // ── per-flag ablation: add ONE feature to fork-off ──────────────────────
    "abl-deadflag":   { engine: FORK, flags: OFF_ALL.replace("5=0", "5=1"), relaxed: 1, role: "reference add-one (non-marginal): dead-flag" },
    "abl-x87locals":  { engine: FORK, flags: OFF_ALL.replace("10=0", "10=1"), relaxed: 1, role: "reference add-one (non-marginal): x87 locals" },
    "abl-pushrun":    { engine: FORK, flags: OFF_ALL.replace("11=0", "11=1"), relaxed: 1, role: "reference add-one (non-marginal): push-run" },
    "abl-retchain":   { engine: FORK, flags: OFF_ALL.replace("12=0", "12=1"), relaxed: 1, role: "reference add-one (non-marginal): RET chaining" },
    "abl-retspec":    { engine: FORK, flags: OFF_ALL.replace("12=0", "12=1").replace("13=0", "13=1"), relaxed: 1, role: "reference add-one (non-marginal): RET chain/spec" },
    // OFF-in-BottleShip features — different workload may disagree with our games verdict:
    "abl-fastmem-w":  { engine: FORK, flags: OFF_ALL.replace("19=0", "19=1"), relaxed: 1, role: "reference add-one (non-marginal): fastmem writes" },
    "abl-flaglocals": { engine: FORK, flags: OFF_ALL.replace("21=0", "21=1"), relaxed: 1, role: "reference add-one (non-marginal): flag locals" },
    "abl-tier2":      { engine: FORK, flags: OFF_ALL.replace("15=0", "15=300000"), relaxed: 1, role: "reference add-one (non-marginal): tier-2" },
    "abl-indirect":   { engine: FORK, flags: OFF_ALL + ",6=1", relaxed: 1, role: "reference add-one (non-marginal): indirect regions" },
    // the whole superblock family together (RET chain+spec, tier-2, indirect regions)
    "abl-superblock": { engine: FORK, flags: OFF_ALL.replace("12=0", "12=1").replace("13=0", "13=1").replace("15=0", "15=300000") + ",6=1", relaxed: 1, role: "reference add-many (non-marginal): superblock family" },
    // ── track 2 flavor (accuracy tradeoff, NOT for the upstream comparison) ─
    "fork-relaxed":   { engine: FORK, flags: LOSSLESS, relaxed: 1 },
};

const DEFAULT_CONFIGS = [
    "stock", "shipping",
    "shipping-minus-deadflag", "shipping-minus-pushrun", "shipping-minus-retchain",
    "shipping-minus-retspec", "shipping-minus-tier2", "shipping-minus-tier2-page-cap",
    "shipping-minus-branch-hints",
    "reference-all-off",
].join(",");

const parseFlags = (text) => new Map(String(text || "").split(",").filter(Boolean).map(pair => {
    const [index, value] = pair.split("=").map(Number);
    return [index, value];
}));

// Fail at matrix construction time if someone accidentally turns a marginal arm back into an
// add-one/all-off experiment, changes x87Locals, or slips an unsupported/retired index into it.
for (const [name, cfg] of Object.entries(CONFIGS)) {
    if (!cfg.marginal) continue;
    const arm = parseFlags(cfg.flags);
    const changed = [...SHIPPING_JIT.keys()].filter(index => arm.get(index) !== SHIPPING_JIT.get(index));
    if (cfg.relaxed !== 1 || arm.size !== SHIPPING_JIT.size || changed.length !== 1
        || changed[0] !== cfg.marginal.index || arm.get(changed[0]) !== cfg.marginal.value) {
        throw new Error(`${name} is not a one-feature shipping-minus arm`);
    }
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { args[a.slice(2)] = next; i++; }
    else args[a.slice(2)] = "1";
}

const runs = Number(args.runs) || 3;
if (args.help) {
    console.log("usage: node bench-matrix.mjs [--runs N] [--configs names] [--tests names] [--timeout seconds] [--dry|--list]");
    console.log(`default configs: ${DEFAULT_CONFIGS}`);
    process.exit(0);
}
const names = (args.configs || DEFAULT_CONFIGS).split(",").map(s => s.trim());
for (const n of names) if (!CONFIGS[n]) { console.error(`unknown config ${n}; have: ${Object.keys(CONFIGS).join(", ")}`); process.exit(2); }

if (args.list) {
    for (const name of names) {
        const cfg = CONFIGS[name];
        console.log(JSON.stringify({ name, role: cfg.role ?? "engine comparison", flags: cfg.flags ?? null,
            relaxed: cfg.relaxed ?? null, marginal: cfg.marginal ?? null }));
    }
    process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(__dirname, "results", `matrix-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

function runOne(name, cfg, runIdx) {
    return new Promise((resolve) => {
        const outFile = path.join(outDir, `${name}-r${runIdx}.json`);
        const argv = [
            path.join(__dirname, "run-bytemark.mjs"),
            "--engine", cfg.engine,
            "--label", `${name}-r${runIdx}`,
            "--out", outFile,
            "--timeout", args.timeout || "90",
        ];
        if (cfg.flags) argv.push("--flags", cfg.flags);
        if (cfg.relaxed !== undefined) argv.push("--relaxed", String(cfg.relaxed));
        if (args.tests) argv.push("--tests", args.tests);
        console.log(`\n=== ${name} run ${runIdx + 1}/${runs} ===`);
        if (args.dry) { console.log("node", argv.join(" ")); return resolve(null); }
        const child = spawn(process.execPath, argv, { stdio: ["ignore", "ignore", "inherit"] });
        child.on("exit", (code) => {
            if (code !== 0) { console.error(`${name} r${runIdx} FAILED (exit ${code})`); return resolve(null); }
            resolve(JSON.parse(fs.readFileSync(outFile, "utf8")));
        });
    });
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

const all = {};
for (const name of names) {
    all[name] = [];
    for (let r = 0; r < runs; r++) {
        const res = await runOne(name, CONFIGS[name], r);
        if (res) all[name].push(res);
    }
}
if (args.dry) process.exit(0);

// ── summary ─────────────────────────────────────────────────────────────────
const TESTS = ["NUMERIC SORT", "STRING SORT", "BITFIELD", "FP EMULATION", "FOURIER",
    "ASSIGNMENT", "IDEA", "HUFFMAN", "NEURAL NET", "LU DECOMPOSITION"];

const agg = {};
for (const name of names) {
    const rs = all[name];
    agg[name] = {
        n: rs.length,
        clock: median(rs.map(r => r.clock?.ratio).filter(Boolean)),
        int_index: median(rs.map(r => r.int_index).filter(Boolean)),
        fp_index: median(rs.map(r => r.fp_index).filter(Boolean)),
        scores: Object.fromEntries(TESTS.map(t =>
            [t, median(rs.map(r => r.scores?.[t]).filter(v => v != null))])),
    };
}

const baseName = names.includes("shipping") ? "shipping" : names[0];
const base = agg[baseName];
const pct = (v, b) => (v != null && b != null && b > 0) ? ` (${v >= b ? "+" : ""}${((v / b - 1) * 100).toFixed(1)}%)` : "";

let md = `# v86 BYTEmark matrix — ${stamp}\n\n`;
md += `runs per config: ${runs}; medians; baseline for %: **${baseName}**\n\n`;
md += `config roles: ${names.map(name => `\`${name}\` = ${CONFIGS[name].role ?? "engine comparison"}`).join("; ")}\n\n`;
md += `| test | ${names.join(" | ")} |\n|---|${names.map(() => "---").join("|")}|\n`;
for (const t of TESTS) {
    const row = names.map(n => {
        const v = agg[n].scores[t];
        return v == null ? "—" : `${v}${n === baseName ? "" : pct(v, base.scores[t])}`;
    });
    md += `| ${t} | ${row.join(" | ")} |\n`;
}
for (const key of ["int_index", "fp_index"]) {
    const row = names.map(n => {
        const v = agg[n][key];
        return v == null ? "—" : `${v}${n === baseName ? "" : pct(v, base[key])}`;
    });
    md += `| **${key}** | ${row.join(" | ")} |\n`;
}
md += `| clock ratio | ${names.map(n => agg[n].clock?.toFixed(4) ?? "—").join(" | ")} |\n`;

fs.writeFileSync(path.join(outDir, "summary.md"), md);
console.log("\n" + md);
console.log(`written: ${path.join(outDir, "summary.md")}`);
