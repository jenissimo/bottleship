// Quick one-shot readout of a single run (calibration aid, not a measurement):
//   node probe.mjs v86|em|native <workload> warm lo hi reps [--dispatch] [--census] [--flags ..] [--exe flat-llvm.exe]
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";
import { runV86 } from "./run-v86.mjs";
import { runEm } from "./run-em.mjs";
import { slopes, dispatchSlope, phases } from "./analyze.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const [arm, wl, warm, lo, hi, reps, ...rest] = process.argv.slice(2);
const o = { warm: +warm, lo: +lo, hi: +hi, reps: +reps, seed: 7 };
let exe = "flat.exe";
for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dispatch") o.dispatch = true;
    else if (rest[i] === "--census") o.census = true;
    else if (rest[i] === "--flags") o.flags = rest[++i];
    else if (rest[i] === "--switches") o.switches = rest[++i];
    else if (rest[i] === "--exe") exe = rest[++i];
}
const dir = path.join(here, "out", wl);
let r;
if (arm === "v86") r = await runV86({ ...o, exe: path.join(dir, exe) });
else if (arm === "em") r = await runEm({ ...o, mjs: path.join(dir, "flat.mjs") });
else {
    const s = execFileSync(path.join(dir, exe.replace(/\.exe$/, "") + (exe.includes("native") ? ".exe" : "-native.exe")), [warm, lo, hi, reps, "7"], { encoding: "utf8" });
    const j = JSON.parse(s);
    r = { input: [0, +warm, +lo, +hi, +reps, 7], marks: j.marks.map(([id, t]) => ({ id, t })), outs: j.outs, status: "ok" };
}
const s = slopes(r);
console.log(JSON.stringify({ status: r.status, outs: r.outs, jit: r.jit, slopes: s,
    phasesMs: phases(r).map((p) => [+(p.lo.t / 1e6).toFixed(2), +(p.hi.t / 1e6).toFixed(2)]),
    warmMs: (() => { const a = r.marks.find((m) => m.id === 1), b = r.marks.find((m) => m.id === 2); return +((b.t - a.t) / 1e6).toFixed(1); })(),
    dispatch: dispatchSlope(r),
    jitShare: (() => { const p = phases(r).at(-1); return p && p.hi.jr !== null ? +(((p.hi.jr - p.lo.jr) / (p.hi.ic - p.lo.ic)) * 100).toFixed(2) : null; })(),
}, null, 1));
process.exit(0);
