// footprint/char-fp.mjs — ../characterize.mjs (instrumented, never timing) with results kept in
// footprint/out/results: exits per 1000 guest instructions, classes, compiled share, pages/modules.
//   node footprint/char-fp.mjs --affinity 0xF00000 --workloads flat,flat-sub1 [--arms "v86"] [--tag char]
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { PLAN, parseArm, runOne, pinSelf } from "../bench.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
let workloads = [], arms = ["v86"], tag = "char", census = true;
for (let i = 0; i < a.length; i++) {
    if (a[i] === "--workloads") workloads = a[++i].split(",");
    else if (a[i] === "--arms") arms = a[++i].split(/\s+/).filter(Boolean);
    else if (a[i] === "--tag") tag = a[++i];
    else if (a[i] === "--no-census") census = false;
    else if (a[i] === "--affinity") pinSelf(a[++i]);
}
const rows = [];
for (const wl of workloads) {
    const plan = { ...(PLAN[wl] || PLAN[wl.replace(/[-_].*$/, "")] || PLAN.default), reps: 2 };
    for (const spec of arms) {
        const arm = parseArm(spec);
        const d = runOne(arm, wl, plan, { dispatch: true });
        const c = census ? runOne(arm, wl, plan, { census: true }) : null;
        const row = {
            workload: wl, arm: spec, insPerStep: d.insPerStep,
            insPerBlock: d.dispatch.insPerBlock, exitsPerKiloInsn: d.dispatch.exitsPerKiloInsn, classesPct: d.dispatch.classesPct,
            pages: d.jit.pages, modules: d.jit.modules, compiles: d.jit.compiles, emittedWasmBytes: d.jit.emittedWasmBytes, textBytes: d.textBytes,
            measuredCompiles: d.measuredCompiles, compiledSharePct: c?.compiledSharePct ?? null, raw: d.dispatch.raw,
        };
        rows.push(row);
        console.log(JSON.stringify({ ...row, raw: undefined }));
    }
}
const dir = path.join(here, "out", "results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ rows }, null, 1));
console.log(`results: ${file}`);
