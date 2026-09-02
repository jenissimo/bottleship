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
import {
    SHIPPING_JIT, SUPPORTED_INDICES, REFERENCE_ALL_OFF, MIN_VALID, minValid,
    formatFlags, parseFlags, shippingWith, referenceWith,
} from "../jit-config/shipping.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../..");

// The production envelope, the all-off reference and the minima all come from
// tools/jit-config/shipping.mjs — the same list the AOT oracle arms and the AOT capture job
// apply.
const SHIPPING_FLAGS = formatFlags(SHIPPING_JIT);
const REFERENCE_FLAGS = formatFlags(REFERENCE_ALL_OFF);
const ship = (index) => SHIPPING_JIT.get(index);

const FORK = path.resolve(process.env.V86_ENGINE_DIR || path.join(REPO, "vendor/v86"));
const STOCK = path.join(__dirname, "engines/stock");

const shippingMinus = (feature, index, value = 0) => ({
    engine: FORK,
    flags: formatFlags(shippingWith([index, value])),
    relaxed: 1,
    role: `shipping-minus-one: ${feature}`,
    marginal: { feature, index, value },
});

/**
 * A reference add-one arm: the all-off reference plus the named feature.
 *
 * Every change is given explicitly, INCLUDING the feature's own budget indices at their
 * shipping value. The reference floors a budget at the smallest value the engine can work
 * with, and a feature switched on over a floored budget measures the flag rather than the
 * feature — tier-2 with a one-page module cap was exactly that.
 */
const addOne = (feature, ...changes) => ({
    engine: FORK,
    flags: formatFlags(referenceWith(...changes)),
    relaxed: 1,
    role: `reference add-one (non-marginal): ${feature}`,
    reference: true,
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
    "shipping": { engine: FORK, flags: SHIPPING_FLAGS, relaxed: 1, role: "shipping baseline", reference: true },
    // Diagnostic/reference only: all production-controlled JIT features off (each at the
    // smallest value the engine still works at — see MIN_VALID), but the shipping relaxed-FPU
    // policy remains on. It is never a marginal comparison.
    "reference-all-off": { engine: FORK, flags: REFERENCE_FLAGS, relaxed: 1, role: "reference all-off (non-marginal)", reference: true },
    // Compatibility aliases retain existing CLI selections. An alias is asserted to be the
    // SAME command line as its target, so it can never quietly become a second data point.
    "fork-off": { engine: FORK, flags: REFERENCE_FLAGS, relaxed: 1, role: "reference all-off (legacy alias)", reference: true, aliasOf: "reference-all-off" },
    "fork-prod-lossless": { engine: FORK, flags: SHIPPING_FLAGS, relaxed: 0, role: "strict-FPU shipping-JIT reference (non-marginal)", reference: true },
    "fork-lossless": { engine: FORK, flags: SHIPPING_FLAGS, relaxed: 0, role: "strict-FPU reference (legacy alias)", reference: true, aliasOf: "fork-prod-lossless" },
    // True marginal contours: each differs from `shipping` in exactly one active supported JIT
    // feature. All other production values, including x87Locals=0 and relaxed FPU, stay fixed.
    "shipping-minus-deadflag": shippingMinus("dead-flag elision", 5),
    "shipping-minus-pushrun": shippingMinus("push-run coalescing", 11),
    "shipping-minus-retchain": shippingMinus("RET dynamic chaining", 12),
    "shipping-minus-retspec": shippingMinus("RET-target speculation", 13),
    "shipping-plus-tier2": { engine: FORK, flags: formatFlags(shippingWith([15, 19200000])), relaxed: 1,
        role: "shipping-plus-one: experimental tier-2", marginal: { feature: "tier-2 hotness", index: 15, value: 19200000 } },
    // Tier-2 is off in shipping, so this arm changes a budget nothing reads. Kept as a
    // marginal arm because that is what it structurally is (one index away from shipping),
    // and the role says what to expect from it.
    "shipping-minus-tier2-page-cap": {
        ...shippingMinus("tier-2 page cap", 17, minValid(17)),
        role: "shipping-minus-one: tier-2 page cap (inert while tier-2 is off)",
    },
    "shipping-minus-branch-hints": shippingMinus("wasm branch-hint group 0", 22),
    "shipping-minus-x87-pc-local": shippingMinus("x87 precision-control local", 31),
    // ── per-flag ablation: add ONE feature to the all-off reference ─────────
    // Reference probes only. Unlike `shipping-minus-*`, none is a marginal keep/drop
    // measurement: they answer "what does this feature do on its own", which a different
    // workload may answer differently from our games.
    "abl-deadflag":   addOne("dead-flag", [5, ship(5)]),
    "abl-x87locals":  addOne("x87 locals", [10, 1]),
    "abl-pushrun":    addOne("push-run", [11, ship(11)]),
    "abl-retchain":   addOne("RET chaining", [12, ship(12)]),
    "abl-retspec":    addOne("RET chain/spec", [12, ship(12)], [13, ship(13)], [14, ship(14)]),
    // OFF-in-BottleShip features — a different workload may disagree with our games verdict:
    "abl-fastmem-w":  addOne("fastmem writes", [19, 1]),
    "abl-flaglocals": addOne("flag locals", [21, 1]),
    "abl-tier2":      addOne("tier-2", [15, 19200000], [17, ship(17)]),
    "abl-indirect":   addOne("indirect regions", [6, 1], [7, ship(7)], [8, ship(8)]),
    // the whole superblock family together (RET chain+spec, tier-2, indirect regions)
    "abl-superblock": {
        ...addOne("superblock family", [12, ship(12)], [13, ship(13)], [14, ship(14)],
            [15, 19200000], [16, ship(16)], [17, ship(17)], [6, 1], [7, ship(7)], [8, ship(8)]),
        role: "reference add-many (non-marginal): superblock family",
    },
    // ── track 2 flavor (accuracy tradeoff, NOT for the upstream comparison) ─
    "fork-relaxed":   { engine: FORK, flags: SHIPPING_FLAGS, relaxed: 1, role: "shipping baseline (legacy alias)", reference: true, aliasOf: "shipping" },
};

const DEFAULT_CONFIGS = [
    "stock", "shipping",
    "shipping-minus-deadflag", "shipping-minus-pushrun", "shipping-minus-retchain",
    "shipping-minus-retspec", "shipping-plus-tier2",
    "shipping-minus-branch-hints",
    "shipping-minus-x87-pc-local",
    "reference-all-off",
].join(",");

/** The whole command line an arm runs, so two arms that differ in nothing are detectable. */
const armIdentity = (cfg) => `${cfg.engine}|${cfg.flags ?? "-"}|${cfg.relaxed ?? "-"}`;

function validateMatrixConfigs() {
    const shippingIndices = [...SHIPPING_JIT.keys()];
    if (shippingIndices.length !== SUPPORTED_INDICES.length
        || shippingIndices.some((index, i) => index !== SUPPORTED_INDICES[i])) {
        throw new Error(`shipping JIT envelope does not match supported ABI indices: ${shippingIndices.join(",")}`);
    }
    for (const [index, value] of REFERENCE_ALL_OFF) {
        if (value < minValid(index)) throw new Error(`all-off reference index ${index}=${value} is below the engine minimum ${minValid(index)}`);
    }
    const checked = [];
    for (const [name, cfg] of Object.entries(CONFIGS)) {
        if (!cfg.flags) {
            // An engine comparison carries no flag envelope, so it cannot be marginal in one.
            if (cfg.marginal) throw new Error(`${name} declares a marginal feature but sets no flags`);
            continue;
        }
        if (cfg.reference) {
            if (cfg.marginal) throw new Error(`${name} is declared both reference and marginal`);
            continue;
        }
        // Prove each marginal command line differs from the shipping command line in exactly
        // the declared feature. An arm that declares nothing is refused rather than skipped:
        // an arm this check cannot see is an inert arm in a benchmark run.
        if (!cfg.marginal) {
            throw new Error(`${name} sets JIT flags but declares neither \`marginal\` (a keep/drop arm) `
                + "nor `reference: true` (a diagnostic) — an undeclared arm is not checked against shipping");
        }
        const arm = parseFlags(cfg.flags);
        const changed = shippingIndices.filter(index => arm.get(index) !== SHIPPING_JIT.get(index));
        if (cfg.relaxed !== 1 || arm.size !== SHIPPING_JIT.size || changed.length !== 1
            || changed[0] !== cfg.marginal.index || arm.get(changed[0]) !== cfg.marginal.value) {
            throw new Error(`${name} does not change exactly one declared shipping feature`);
        }
        checked.push({ name, index: changed[0], from: SHIPPING_JIT.get(changed[0]), to: arm.get(changed[0]) });
    }
    // Two arms with the same engine, flags and FPU policy are ONE data point wearing two
    // names; averaging them reads as agreement between independent runs. An alias must say
    // so, and is then asserted to be exactly what it claims to alias.
    const byIdentity = new Map();
    for (const [name, cfg] of Object.entries(CONFIGS)) {
        if (cfg.aliasOf) {
            const target = CONFIGS[cfg.aliasOf];
            if (!target) throw new Error(`${name} aliases unknown config ${cfg.aliasOf}`);
            if (armIdentity(cfg) !== armIdentity(target)) {
                throw new Error(`${name} claims to alias ${cfg.aliasOf} but runs a different command line`);
            }
            continue;
        }
        const id = armIdentity(cfg);
        const first = byIdentity.get(id);
        if (first) throw new Error(`${name} and ${first} run identical command lines — declare one as \`aliasOf\` or delete it`);
        byIdentity.set(id, name);
    }
    return checked;
}
const MARGINAL_SELF_TEST = validateMatrixConfigs();

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
    console.log("usage: node bench-matrix.mjs [--runs N] [--configs names] [--tests names] [--timeout seconds] [--dry|--list|--self-test]");
    console.log(`default configs: ${DEFAULT_CONFIGS}`);
    process.exit(0);
}
if (args["self-test"]) {
    console.log(JSON.stringify({
        ok: true,
        shippingIndices: [...SHIPPING_JIT.keys()],
        referenceMinima: Object.fromEntries(MIN_VALID),
        aliases: Object.fromEntries(Object.entries(CONFIGS).filter(([, c]) => c.aliasOf).map(([n, c]) => [n, c.aliasOf])),
        marginalArms: MARGINAL_SELF_TEST,
    }));
    process.exit(0);
}
const names = (args.configs || DEFAULT_CONFIGS).split(",").map(s => s.trim());
for (const n of names) if (!CONFIGS[n]) { console.error(`unknown config ${n}; have: ${Object.keys(CONFIGS).join(", ")}`); process.exit(2); }

if (args.list) {
    for (const name of names) {
        const cfg = CONFIGS[name];
        console.log(JSON.stringify({ name, role: cfg.role ?? "engine comparison", flags: cfg.flags ?? null,
            relaxed: cfg.relaxed ?? null, marginal: cfg.marginal ?? null,
            reference: cfg.reference ?? false, aliasOf: cfg.aliasOf ?? null }));
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
// A refused or failed run is dropped from the medians above; the count is the only thing
// that distinguishes a one-survivor "median" from a real one.
md += `| valid runs | ${names.map(n => agg[n].n < runs ? `**${agg[n].n}/${runs}**` : `${agg[n].n}/${runs}`).join(" | ")} |\n`;

fs.writeFileSync(path.join(outDir, "summary.md"), md);
console.log("\n" + md);
console.log(`written: ${path.join(outDir, "summary.md")}`);
