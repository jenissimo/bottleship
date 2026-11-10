// Paired ABBA measurement: func-ceiling rungs next to the flat-pair arms (v86, em, native), same
// PE, same plan, same slope protocol (flat-pair/analyze.mjs).
//   node bench-fc.mjs --workloads tight-int,medium-int,flat-int --arms "v86 em native fc:F0 fc:S fc:S#aa" --rounds 4 --affinity 0xF000 --tag ladder
// fc:<file-stem> runs out/<wl>/<stem>.wasm in its own Node process. "#label" = identical A/A arm.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { slopes, median, spreadPct } from "../flat-pair/analyze.mjs";
import { runOne, parseArm, pinSelf, PLAN, V8_TIERS } from "../flat-pair/bench.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const planFor = (wl) => PLAN[wl] || PLAN[wl.replace(/[-_].*$/, "")] || PLAN.default;

function runFcArm(spec, wl, plan) {
    const tier = /@(\w+)/.exec(spec)?.[1];
    const v8 = tier ? V8_TIERS[tier] : [];
    if (!v8) throw Error("unknown V8 tier " + tier);
    const stem = spec.replace(/^fc:/, "").replace(/#.*$/, "").replace(/@\w+/, "");
    const wasm = path.join(here, "out", wl, stem.replace(/[+,=]/g, "_") + ".wasm");
    const exe = path.join(here, "../flat-pair/out", wl, "flat.exe");
    const tmp = path.join(here, "out", "tmp-" + crypto.randomBytes(4).toString("hex") + ".json");
    const args = [path.join(here, "run-fc.mjs"), "--wasm", wasm, "--exe", exe, "--out", tmp, "--label", spec,
        ...["--warm", plan.warm, "--lo", plan.lo, "--hi", plan.hi, "--reps", plan.reps, "--seed", 7].map(String)];
    try { execFileSync(process.execPath, [...v8, ...args], { stdio: ["ignore", "ignore", "inherit"], maxBuffer: 1 << 28 }); }
    catch (e) { if (!fs.existsSync(tmp)) throw e; }
    const r = JSON.parse(fs.readFileSync(tmp, "utf8"));
    fs.unlinkSync(tmp);
    const sl = slopes(r);
    const use = sl.length > 1 ? sl.slice(1) : sl;
    return { arm: spec, status: r.status, exit: r.exit, outs: r.outs, perRepNsPerStep: sl.map((s) => +s.nsPerStep.toFixed(2)),
        nsPerStep: median(use.map((s) => s.nsPerStep)), insPerStep: r.marks[0]?.ic !== undefined ? sl[0]?.insPerStep : null, wasmBytes: fs.statSync(wasm).size };
}

const a = process.argv.slice(2);
const o = { workloads: "tight-int,medium-int,flat-int", arms: "v86 em native fc:F0 fc:S fc:S#aa", rounds: 4, tag: "fc" };
for (let i = 0; i < a.length; i++) o[a[i].replace(/^--/, "")] = a[++i];
if (o.affinity) pinSelf(o.affinity);
const arms = o.arms.split(/\s+/).filter(Boolean);
const results = { tag: o.tag, startedAt: new Date().toISOString(), node: process.version, affinity: process.env.FLATPAIR_AFFINITY || null, rounds: Number(o.rounds), arms, workloads: {} };
for (const wl of o.workloads.split(",")) {
    const plan = planFor(wl);
    const runs = [];
    for (let r = 0; r < Number(o.rounds); r++) {
        const order = r % 2 === 0 ? arms : [...arms].reverse();
        for (const spec of order) {
            let x;
            if (spec.startsWith("fc:")) x = runFcArm(spec, wl, plan);
            else { x = runOne(parseArm(spec), wl, plan); x.arm = spec; }
            x.round = r;
            runs.push(x);
            process.stderr.write(`[${wl}] r${r} ${spec.padEnd(16)} ${x.nsPerStep.toFixed(1).padStart(9)} ns/step  ${x.status}  ${x.outs.slice(-1)}\n`);
        }
    }
    const ref = JSON.stringify(runs[0].outs);
    const agree = runs.every((x) => JSON.stringify(x.outs) === ref && x.status === "ok");
    const ins = runs.find((x) => x.arm.startsWith("v86") && x.insPerStep)?.insPerStep ?? runs.find((x) => x.insPerStep)?.insPerStep;
    const med = (spec) => median(runs.filter((x) => x.arm === spec).map((x) => x.nsPerStep));
    const v86Arm = arms.find((s) => /^v86(@\w+)?$/.test(s)), emArm = arms.find((s) => /^em(@\w+)?$/.test(s));
    const v86 = v86Arm ? med(v86Arm) : null, em = emArm ? med(emArm) : null;
    const summary = {};
    for (const spec of arms) {
        const xs = runs.filter((x) => x.arm === spec);
        const ns = xs.map((x) => x.nsPerStep);
        const m = median(ns);
        summary[spec] = { nsPerStep: +m.toFixed(2), spreadPct: +spreadPct(ns).toFixed(1), runs: ns.map((v) => +v.toFixed(1)), nsPerMsvcIns: ins ? +(m / ins).toFixed(3) : null,
            speedupVsV86: v86 ? +(v86 / m).toFixed(2) : null, vsEm: em ? +(m / em).toFixed(2) : null,
            insPerStepOwn: xs.find((x) => x.insPerStep)?.insPerStep ?? null, wasmBytes: xs[0].wasmBytes ?? null };
    }
    results.workloads[wl] = { plan, msvcInsPerStep: ins, checksumsAgree: agree, checksum: runs[0].outs.slice(-1)[0], summary, runs };
    console.log(`\n== ${wl}  plan ${JSON.stringify(plan)}  MSVC ins/step ${ins}  checksums ${agree ? "AGREE" : "*** DISAGREE ***"}`);
    console.log(`${"arm".padEnd(16)} ${"ns/step".padStart(9)} ${"spread%".padStart(8)} ${"ns/ins".padStart(7)} ${"x v86".padStart(6)} ${"vs em".padStart(6)} ${"ownIns".padStart(8)}`);
    for (const [k, s] of Object.entries(summary)) {
        console.log(`${k.padEnd(16)} ${s.nsPerStep.toFixed(1).padStart(9)} ${s.spreadPct.toFixed(1).padStart(8)} ${String(s.nsPerMsvcIns).padStart(7)} ${String(s.speedupVsV86).padStart(6)} ${String(s.vsEm).padStart(6)} ${String(s.insPerStepOwn ?? "-").padStart(8)}`);
    }
}
const resDir = path.join(here, "out", "results");
fs.mkdirSync(resDir, { recursive: true });
const file = path.join(resDir, `${o.tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 1));
console.log(`\nresults: ${file}`);
