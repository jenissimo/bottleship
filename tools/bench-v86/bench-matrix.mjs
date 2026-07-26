#!/usr/bin/env node
// Benchmark matrix driver: runs named configs × N runs sequentially (one emulator
// at a time — these are CPU-bound), aggregates medians, emits a markdown summary.
//
// Usage:
//   node bench-matrix.mjs [--runs 3] [--configs stock,fork-off,fork-lossless]
//                         [--tests DONUMSORT,DOFOUR] [--timeout 90] [--dry]
//
// Config definitions live in CONFIGS below. Results land in
// results/matrix-<stamp>/: per-run JSONs + summary.md.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../..");

// idx map (vendor/v86 src/rust/jit.rs set_jit_config):
//  5 dead-flag elision | 9 fastmem reads | 10 x87 locals | 11 push-run coalescing
// 12 RET chaining | 13 RET speculation | 15 tier-2 threshold (0=off) | 17 tier-2 max pages
// 18 fastmem read split | 19 fastmem writes | 21 flag locals
const OFF_ALL = "5=0,9=0,10=0,11=0,12=0,13=0,15=0,18=0,19=0,21=0";
const LOSSLESS = "5=1,9=1,10=1,11=1,12=1,13=1,18=1,15=0,19=0,21=0"; // BottleShip prod set minus relaxed FPU

const FORK = path.join(REPO, "vendor/v86");
const STOCK = path.join(__dirname, "engines/stock");

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
    "fork-off":       { engine: FORK, flags: OFF_ALL },       // baked-in changes only
    "fork-lossless":  { engine: FORK, flags: LOSSLESS },      // shipping set minus tier-2, strict FPU
    "fork-prod-lossless": { engine: FORK, flags: LOSSLESS.replace("15=0", "15=300000") }, // actual prod lossless subset
    // ── per-flag ablation: add ONE feature to fork-off ──────────────────────
    "abl-deadflag":   { engine: FORK, flags: OFF_ALL.replace("5=0", "5=1") },
    "abl-fastmem-r":  { engine: FORK, flags: OFF_ALL.replace("9=0", "9=1").replace("18=0", "18=1") },
    "abl-x87locals":  { engine: FORK, flags: OFF_ALL.replace("10=0", "10=1") },
    "abl-pushrun":    { engine: FORK, flags: OFF_ALL.replace("11=0", "11=1") },
    "abl-retchain":   { engine: FORK, flags: OFF_ALL.replace("12=0", "12=1") },
    "abl-retspec":    { engine: FORK, flags: OFF_ALL.replace("12=0", "12=1").replace("13=0", "13=1") },
    // OFF-in-BottleShip features — different workload may disagree with our games verdict:
    "abl-fastmem-w":  { engine: FORK, flags: OFF_ALL.replace("19=0", "19=1") },
    "abl-flaglocals": { engine: FORK, flags: OFF_ALL.replace("21=0", "21=1") },
    "abl-tier2":      { engine: FORK, flags: OFF_ALL.replace("15=0", "15=300000") },
    "abl-indirect":   { engine: FORK, flags: OFF_ALL + ",6=1" },
    // the whole superblock family together (RET chain+spec, tier-2, indirect regions)
    "abl-superblock": { engine: FORK, flags: OFF_ALL.replace("12=0", "12=1").replace("13=0", "13=1").replace("15=0", "15=300000") + ",6=1" },
    // ── track 2 flavor (accuracy tradeoff, NOT for the upstream comparison) ─
    "fork-relaxed":   { engine: FORK, flags: LOSSLESS, relaxed: 1 },
};

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { args[a.slice(2)] = next; i++; }
    else args[a.slice(2)] = "1";
}

const runs = Number(args.runs) || 3;
const names = (args.configs || "stock,fork-off,fork-lossless").split(",").map(s => s.trim());
for (const n of names) if (!CONFIGS[n]) { console.error(`unknown config ${n}; have: ${Object.keys(CONFIGS).join(", ")}`); process.exit(2); }

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

const base = agg[names[0]];
const pct = (v, b) => (v != null && b != null && b > 0) ? ` (${v >= b ? "+" : ""}${((v / b - 1) * 100).toFixed(1)}%)` : "";

let md = `# v86 BYTEmark matrix — ${stamp}\n\n`;
md += `runs per config: ${runs}; medians; baseline for %: **${names[0]}**\n\n`;
md += `| test | ${names.join(" | ")} |\n|---|${names.map(() => "---").join("|")}|\n`;
for (const t of TESTS) {
    const row = names.map(n => {
        const v = agg[n].scores[t];
        return v == null ? "—" : `${v}${n === names[0] ? "" : pct(v, base.scores[t])}`;
    });
    md += `| ${t} | ${row.join(" | ")} |\n`;
}
for (const key of ["int_index", "fp_index"]) {
    const row = names.map(n => {
        const v = agg[n][key];
        return v == null ? "—" : `${v}${n === names[0] ? "" : pct(v, base[key])}`;
    });
    md += `| **${key}** | ${row.join(" | ")} |\n`;
}
md += `| clock ratio | ${names.map(n => agg[n].clock?.toFixed(4) ?? "—").join(" | ")} |\n`;

fs.writeFileSync(path.join(outDir, "summary.md"), md);
console.log("\n" + md);
console.log(`written: ${path.join(outDir, "summary.md")}`);
