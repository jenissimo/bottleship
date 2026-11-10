// footprint/fp-bench.mjs — ABBA ACROSS workloads (bench.mjs pairs arms within one workload; the
// footprint questions compare workloads, so the cells are interleaved instead).
//
//   node footprint/fp-bench.mjs --affinity 0xF00000 --cells "flat:v86 flat-sub1:v86 flat:v86#aa flat:em" --rounds 4 --tag sub
//
// A cell is <workload>:<arm spec> (arm spec as in bench.mjs, e.g. v86[1=1], v86@liftoff, em, v86#aa).
// Round r runs the cells in order, round r+1 reversed. Per cell: median ns/step and ns per guest
// instruction (v86 block credit of the SAME workload's v86 cell for em), (max-min)/median spread.
// --env K=V  sets an env var for the v86 child (e.g. V86_ENGINE_DIR=... for a lab engine build).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { PLAN, parseArm, runOne, pinSelf, V8_TIERS } from "../bench.mjs";

// Node 22.14 (V8 12.4) does NOT honour the Wasm branch-hints section by default; Chrome ships it.
// `@bh` = the JIT's hints honoured (TurboFan defers the hinted-cold blocks), i.e. production layout.
V8_TIERS.bh = ["--experimental-wasm-branch-hinting"];
import { median, spreadPct } from "../analyze.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const o = { cells: [], rounds: 4, tag: "fp", plan: null };
for (let i = 0; i < a.length; i++) {
    if (a[i] === "--cells") o.cells = a[++i].split(/\s+/).filter(Boolean);
    else if (a[i] === "--rounds") o.rounds = Number(a[++i]);
    else if (a[i] === "--tag") o.tag = a[++i];
    else if (a[i] === "--affinity") pinSelf(a[++i]);
    else if (a[i] === "--plan") o.plan = JSON.parse(a[++i]);
    else if (a[i] === "--env") { const [k, v] = a[++i].split("="); process.env[k] = v; }
    else { console.error(`unknown option ${a[i]}`); process.exit(2); }
}
const cells = o.cells.map((c) => {
    const j = c.indexOf(":");
    const wl = c.slice(0, j), spec = c.slice(j + 1);
    const plan = o.plan || PLAN[wl] || PLAN[wl.replace(/[-_].*$/, "")] || PLAN.default;
    return { key: c, wl, arm: parseArm(spec), plan };
});
const runs = [];
for (let r = 0; r < o.rounds; r++) {
    const order = r % 2 === 0 ? cells : [...cells].reverse();
    for (const c of order) {
        const x = runOne(c.arm, c.wl, c.plan);
        x.round = r; x.cell = c.key; x.wl = c.wl;
        runs.push(x);
        process.stderr.write(`r${r} ${c.key.padEnd(28)} ${x.nsPerStep.toFixed(1).padStart(9)} ns/step ins/step=${x.insPerStep?.toFixed(0) ?? "-"} status=${x.status} compiles=${x.measuredCompiles}\n`);
    }
}
const summary = {};
const insOf = {};
for (const c of cells) {
    const xs = runs.filter((x) => x.cell === c.key);
    const ins = xs.find((x) => x.insPerStep)?.insPerStep;
    if (ins && !insOf[c.wl]) insOf[c.wl] = ins;
}
for (const c of cells) {
    const xs = runs.filter((x) => x.cell === c.key);
    const ns = xs.map((x) => x.nsPerStep);
    const ins = insOf[c.wl];
    const sums = new Set(xs.map((x) => JSON.stringify(x.outs)));
    summary[c.key] = {
        nsPerStep: +median(ns).toFixed(1), spreadPct: +spreadPct(ns).toFixed(1), runs: ns.map((v) => +v.toFixed(1)),
        insPerStep: ins ?? null, nsPerIns: ins ? +(median(ns) / ins).toFixed(3) : null,
        nsPerInsRuns: ins ? ns.map((v) => +(v / ins).toFixed(3)) : null,
        measuredCompiles: xs.map((x) => x.measuredCompiles), checksumVariants: sums.size,
        jit: xs.at(-1).jit, textBytes: xs.at(-1).textBytes,
    };
}
// checksums must agree between arms of the same workload
const agree = {};
for (const wl of new Set(cells.map((c) => c.wl))) {
    agree[wl] = new Set(runs.filter((x) => x.wl === wl).map((x) => JSON.stringify(x.outs))).size === 1;
}
const res = { tag: o.tag, startedAt: new Date().toISOString(), affinity: process.env.FLATPAIR_AFFINITY || null, rounds: o.rounds, cells: o.cells, checksumsAgree: agree, summary, runs };
const dir = path.join(here, "out", "results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${o.tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(res, null, 1));
console.log(`checksums agree per workload: ${JSON.stringify(agree)}`);
console.log(`${"cell".padEnd(30)}${"ns/step".padStart(10)}${"spread%".padStart(9)}${"ins/step".padStart(9)}${"ns/ins".padStart(8)}  runs(ns/ins)`);
for (const [k, s] of Object.entries(summary)) {
    console.log(`${k.padEnd(30)}${String(s.nsPerStep).padStart(10)}${String(s.spreadPct).padStart(9)}${String(s.insPerStep ? s.insPerStep.toFixed(0) : "-").padStart(9)}${String(s.nsPerIns ?? "-").padStart(8)}  ${JSON.stringify(s.nsPerInsRuns)}`);
}
console.log(`results: ${file}`);
