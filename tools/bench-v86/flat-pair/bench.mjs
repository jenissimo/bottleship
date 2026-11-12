// Paired, interleaved measurement over prebuilt workloads (build.mjs first).
//
//   node bench.mjs --workloads tight,medium,flat --arms "v86 v86#aa em native" --rounds 4 [--tag main]
//
// Arm spec (space separated):
//   v86            MSVC PE under the current JIT, shipping config     v86[4=1,12=0]  same, config override
//   llvm-v86       clang i686 PE under the JIT                        v86{jit_guard_groups=0}  codegen switch
//   em             Emscripten Wasm in this Node                       native / llvm-native  host x86 exe
//   any arm may carry a "#label" suffix (e.g. v86#aa) — the identical-arm control.
// Every run is its own process. Arms run in ABBA order (the order reverses every round). One run's
// value = median of its per-rep lo/hi slopes, first rep dropped (it can still be warming in).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { slopes, median, spreadPct, dispatchSlope, phases } from "./analyze.mjs";
import { engineDir } from "./run-v86.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));

// Work per workload (driver steps). hi = 4 x lo; warm-up = `warm` x hi, long enough for every page
// to cross JIT_THRESHOLD (200k retired instructions) in the interpreter.
export const PLAN = {
    tight: { warm: 4, lo: 50000, hi: 200000, reps: 4 },
    medium: { warm: 4, lo: 20000, hi: 80000, reps: 4 },
    flat: { warm: 4, lo: 20000, hi: 80000, reps: 4 },
    default: { warm: 4, lo: 20000, hi: 80000, reps: 4 },
    lua: { warm: 3, lo: 500, hi: 2000, reps: 4 },
};

// `@tier` suffix: V8 flags for the arm's process, to see how much of a gap is V8's own tiering.
// (Measured: in Node 22 "--liftoff --no-wasm-tier-up" still tiers up; --liftoff-only does not.)
export const V8_TIERS = { tf: ["--no-liftoff"], liftoff: ["--liftoff-only"],
    // func-ceiling (additive): Node 22 / V8 12.4 has wasm branch hints and wasm inlining OFF by
    // default; current Chrome has both on.
    hint: ["--experimental-wasm-branch-hinting"], hintinl: ["--experimental-wasm-branch-hinting", "--experimental-wasm-inlining"],
    tfhint: ["--no-liftoff", "--experimental-wasm-branch-hinting"] };

export function parseArm(spec) {
    const m = /^([a-z0-9-]+)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?(?:@(\w+))?(?:#(\S+))?$/.exec(spec);
    if (!m) throw Error(`bad arm ${spec}`);
    const v8 = m[4] ? V8_TIERS[m[4]] : [];
    if (!v8) throw Error(`unknown V8 tier ${m[4]} (have ${Object.keys(V8_TIERS)})`);
    return { spec, kind: m[1], flags: m[2] || "", switches: m[3] || "", v8 };
}

export function runOne(arm, wl, plan, extra = {}) {
    const dir = path.join(here, "out", wl);
    const tmp = path.join(here, "out", "tmp-" + crypto.randomBytes(4).toString("hex") + ".json");
    const common = ["--warm", plan.warm, "--lo", plan.lo, "--hi", plan.hi, "--reps", plan.reps, "--seed", 7].map(String);
    let r;
    if (arm.kind === "v86" || arm.kind === "llvm-v86") {
        const exe = path.join(dir, arm.kind === "v86" ? "flat.exe" : "flat-llvm.exe");
        const args = [path.join(here, "run-v86.mjs"), "--exe", exe, ...common, "--out", tmp, "--label", arm.spec];
        if (arm.flags) args.push("--flags", arm.flags);
        if (arm.switches) args.push("--switches", arm.switches);
        if (extra.dispatch) args.push("--dispatch");
        if (extra.census) args.push("--census");
        try { execFileSync(process.execPath, [...arm.v8, ...args], { stdio: ["ignore", "ignore", "inherit"], maxBuffer: 1 << 28 }); }
        catch (e) { if (!fs.existsSync(tmp)) throw e; }
        r = JSON.parse(fs.readFileSync(tmp, "utf8"));
        fs.unlinkSync(tmp);
    } else if (arm.kind === "em") {
        execFileSync(process.execPath, [...arm.v8, path.join(here, "run-em.mjs"), "--mjs", path.join(dir, "flat.mjs"), ...common, "--out", tmp, "--label", arm.spec],
            { stdio: ["ignore", "ignore", "inherit"] });
        r = JSON.parse(fs.readFileSync(tmp, "utf8"));
        fs.unlinkSync(tmp);
    } else if (arm.kind === "native" || arm.kind === "llvm-native") {
        const exe = path.join(dir, arm.kind === "native" ? "flat-native.exe" : "flat-llvm-native.exe");
        const j = JSON.parse(execFileSync(exe, [plan.warm, plan.lo, plan.hi, plan.reps, 7].map(String), { encoding: "utf8" }));
        r = { arm: arm.spec, status: "ok", input: [0xF1A7, plan.warm, plan.lo, plan.hi, plan.reps, 7], marks: j.marks.map(([id, t]) => ({ id, t })), outs: j.outs };
    } else throw Error(`unknown arm kind ${arm.kind}`);
    const sl = slopes(r);
    const use = sl.length > 1 ? sl.slice(1) : sl;
    return {
        arm: arm.spec, status: r.status, outs: r.outs, jit: r.jit, shape: r.shape, engine: r.engine,
        textBytes: r.sections ? r.sections.find((s) => s.name === ".text")?.vsize : undefined,
        perRepNsPerStep: sl.map((s) => +s.nsPerStep.toFixed(2)),
        nsPerStep: median(use.map((s) => s.nsPerStep)),
        insPerStep: sl[0]?.insPerStep ?? null,
        hiLoRatio: median(use.map((s) => s.ratioHiLo)),
        // JIT compiles inside the reps that are used (should be ~0: steady state).
        measuredCompiles: r.jit ? phases(r).slice(sl.length > 1 ? 1 : 0).reduce((s, p) => s + (p.lo.compiles ?? 0) + (p.hi.compiles ?? 0), 0) : null,
        dispatch: extra.dispatch ? dispatchSlope(r) : undefined,
        compiledSharePct: extra.census ? (() => {
            const p = phases(r).at(-1);
            return +(((p.hi.jr - p.lo.jr) / (p.hi.ic - p.lo.ic)) * 100).toFixed(2);
        })() : undefined,
    };
}

/** Pin this process (and therefore every child run) to a CPU mask, e.g. 0xF0. On a two-CCD
 *  part (7900X3D: one CCD with 3D V-cache) an unpinned run migrates between 32 and 96 MiB of L3,
 *  which for the big-code workloads is a large run-to-run swing. */
export function pinSelf(mask) {
    const m = Number(mask);
    const got = execFileSync("powershell", ["-NoProfile", "-Command",
        `$p = Get-Process -Id ${process.pid}; $p.ProcessorAffinity = ${m}; [int64]$p.ProcessorAffinity`], { encoding: "utf8" }).trim();
    if (Number(got) !== m) throw Error(`affinity readback ${got} != ${m}`);
    process.env.FLATPAIR_AFFINITY = "0x" + m.toString(16);
}

export function bench({ workloads, arms, rounds, tag = "run", dispatch = false }) {
    const parsed = arms.map(parseArm);
    const results = { tag, startedAt: new Date().toISOString(), node: process.version, rounds, arms, affinity: process.env.FLATPAIR_AFFINITY || null, workloads: {} };
    const eng = engineDir();
    results.engine = { dir: eng, wasmSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(eng, "build/v86.wasm"))).digest("hex") };
    for (const wl of workloads) {
        const plan = PLAN[wl] || PLAN[wl.replace(/[-_].*$/, "")] || PLAN.default;
        const build = JSON.parse(fs.readFileSync(path.join(here, "out", wl, "build.json"), "utf8"));
        const runs = [];
        for (let r = 0; r < rounds; r++) {
            const order = r % 2 === 0 ? parsed : [...parsed].reverse();
            for (const a of order) {
                const x = runOne(a, wl, plan);
                x.round = r;
                runs.push(x);
                process.stderr.write(`[${wl}] r${r} ${a.spec.padEnd(28)} ${x.nsPerStep.toFixed(1)} ns/step  status=${x.status}  outs=${x.outs.slice(-2).join(",")}\n`);
            }
        }
        // Checksums: every run of every arm must report the same outs.
        const ref = JSON.stringify(runs[0].outs);
        const checksumsAgree = runs.every((x) => JSON.stringify(x.outs) === ref);
        const summary = {};
        const em = runs.filter((x) => x.arm === "em");
        const emNs = em.length ? median(em.map((x) => x.nsPerStep)) : null;
        const insMsvc = runs.find((x) => x.insPerStep && x.arm.startsWith("v86"))?.insPerStep ?? null;
        for (const a of parsed) {
            const xs = runs.filter((x) => x.arm === a.spec);
            const ns = xs.map((x) => x.nsPerStep);
            const ins = xs.find((x) => x.insPerStep)?.insPerStep ?? null;
            summary[a.spec] = {
                nsPerStep: +median(ns).toFixed(2), spreadPct: +spreadPct(ns).toFixed(1), runs: ns.map((v) => +v.toFixed(1)),
                guestInsPerStep: ins,
                nsPerGuestIns: ins ? +(median(ns) / ins).toFixed(3) : null,
                // Normalised to the MSVC instruction count, so every arm shares one denominator.
                nsPerMsvcIns: insMsvc ? +(median(ns) / insMsvc).toFixed(3) : null,
                vsEm: emNs ? +(median(ns) / emNs).toFixed(2) : null,
                measuredCompiles: xs.map((x) => x.measuredCompiles),
                jit: xs[xs.length - 1].jit, shape: xs[0].shape ? { flags: xs[0].shape.flags, switches: xs[0].shape.switches } : undefined,
            };
        }
        results.workloads[wl] = { plan, params: build.params, meta: build.meta, versions: build.versions, artifacts: build.artifacts, checksumsAgree, checksums: runs[0].outs, summary, runs };
        console.log(`\n== ${wl}  plan ${JSON.stringify(plan)}  checksums ${checksumsAgree ? "AGREE" : "*** DISAGREE ***"} (${runs[0].outs.slice(-2).join(",")})`);
        console.log(`${"arm".padEnd(30)} ${"ns/step".padStart(10)} ${"spread%".padStart(8)} ${"ins/step".padStart(9)} ${"ns/ins".padStart(7)} ${"ns/msvcIns".padStart(10)} ${"vs em".padStart(6)}`);
        for (const [k, s] of Object.entries(summary)) {
            console.log(`${k.padEnd(30)} ${s.nsPerStep.toFixed(1).padStart(10)} ${s.spreadPct.toFixed(1).padStart(8)} ${String(s.guestInsPerStep ? s.guestInsPerStep.toFixed(0) : "-").padStart(9)} `
                + `${String(s.nsPerGuestIns ?? "-").padStart(7)} ${String(s.nsPerMsvcIns ?? "-").padStart(10)} ${String(s.vsEm ?? "-").padStart(6)}`);
        }
    }
    const resDir = path.join(here, "out", "results");
    fs.mkdirSync(resDir, { recursive: true });
    const file = path.join(resDir, `${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(results, null, 1));
    console.log(`\nresults: ${file}`);
    return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
    const a = process.argv.slice(2);
    const o = { workloads: ["tight", "medium", "flat"], arms: ["v86", "v86#aa", "em", "native"], rounds: 4, tag: "run" };
    for (let i = 0; i < a.length; i++) {
        if (a[i] === "--workloads") o.workloads = a[++i].split(",");
        else if (a[i] === "--arms") o.arms = a[++i].split(/\s+/).filter(Boolean);
        else if (a[i] === "--rounds") o.rounds = Number(a[++i]);
        else if (a[i] === "--tag") o.tag = a[++i];
        else if (a[i] === "--affinity") o.affinity = a[++i];
        else { console.error(`unknown option ${a[i]}`); process.exit(2); }
    }
    if (o.affinity) pinSelf(o.affinity);
    bench(o);
}
