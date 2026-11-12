// Characterise a workload UNDER the JIT (instrumented runs; never timing numbers):
//   node characterize.mjs --workloads tight,medium,flat [--arms "v86 v86[4=1]"]
// Per arm: one --dispatch run (block length, module exits per 1000 instructions and their classes,
// over the lo/hi slope) and one --census run (share of retired instructions credited by compiled
// modules = 1 - interpreter share), plus pages/modules compiled.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { PLAN, parseArm, runOne, pinSelf } from "./bench.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
let workloads = ["tight", "medium", "flat"], arms = ["v86"], tag = "char";
for (let i = 0; i < a.length; i++) {
    if (a[i] === "--workloads") workloads = a[++i].split(",");
    else if (a[i] === "--arms") arms = a[++i].split(/\s+/).filter(Boolean);
    else if (a[i] === "--tag") tag = a[++i];
    else if (a[i] === "--affinity") pinSelf(a[++i]);
}
const HL2 = { insPerBlock: 5.9, exitsPerKiloInsn: 46, classesPct: { chained: 74, constantTargetUnchained: 18, dynamic: 6, indirect: 1.5 }, nsPerIns: 4 };
const rows = [];
for (const wl of workloads) {
    const plan = { ...(PLAN[wl] || PLAN[wl.replace(/[-_].*$/, "")] || PLAN.default), reps: 2 };
    for (const spec of arms) {
        const arm = parseArm(spec);
        const d = runOne(arm, wl, plan, { dispatch: true });
        const c = runOne(arm, wl, plan, { census: true });
        const row = {
            workload: wl, arm: spec, insPerStep: d.insPerStep,
            insPerBlock: d.dispatch.insPerBlock, exitsPerKiloInsn: d.dispatch.exitsPerKiloInsn, classesPct: d.dispatch.classesPct,
            retMemo: { hit: d.dispatch.raw.retMemoHit, alias: d.dispatch.raw.retMemoAlias, cold: d.dispatch.raw.retMemoCold, metaHit: d.dispatch.raw.retMetaHit },
            pages: d.jit.pages, modules: d.jit.modules, compiles: d.jit.compiles, emittedWasmBytes: d.jit.emittedWasmBytes, textBytes: d.textBytes,
            measuredCompiles: d.measuredCompiles,
            compiledSharePct: c.compiledSharePct,
            raw: d.dispatch.raw,
        };
        rows.push(row);
        console.log(JSON.stringify({ ...row, raw: undefined }));
    }
}
const dir = path.join(here, "out", "results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ hl2: HL2, rows }, null, 1));
console.log(`results: ${file}`);
