// Build every rung for the given workloads (flat-pair/out/<wl>/flat.exe must exist).
//   node build-fc.mjs [--workloads tight-int,medium-int,flat-int] [--variants F0,RC,RT,LZ,S,Sb,...] [--exec]
// --exec also builds the executed-only twins (S-exec, F0-exec): a profile build of S is run with
// the bench plan, blocks never executed become side exits, never-executed functions get no code.
// Before that, run-time discovery: S runs once; an indirect-call miss records the target and the
// module is rebuilt (until no miss) — the count is reported (0 = static discovery was complete).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { loadPE } from "./discover.mjs";
import { translate, parseVariant } from "./translate.mjs";
import { runFc } from "./run-fc.mjs";
import { PLAN } from "../flat-pair/bench.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const o = { workloads: "tight-int,medium-int,flat-int", variants: "F0,F0b,RC,RT,LZ,S,Sb", exec: false };
for (let i = 0; i < a.length; i++) { const k = a[i].replace(/^--/, ""); if (k === "exec") o.exec = true; else o[k] = a[++i]; }
const fname = (v) => v.replace(/[+,=]/g, "_");
export const planFor = (wl) => PLAN[wl] || PLAN[wl.replace(/[-_].*$/, "")] || PLAN.default;

for (const wl of o.workloads.split(",")) {
    const exe = path.join(here, "../flat-pair/out", wl, "flat.exe");
    const dir = path.join(here, "out", wl);
    fs.mkdirSync(dir, { recursive: true });
    const pe = loadPE(fs.readFileSync(exe));
    const plan = planFor(wl);
    const summary = { wl, plan, variants: {} };
    const write = (name, r, extra = {}) => {
        const f = path.join(dir, fname(name) + ".wasm");
        fs.writeFileSync(f, r.bytes);
        fs.writeFileSync(f.replace(/\.wasm$/, ".json"), JSON.stringify({ variant: name, stats: r.stats, layout: r.layout, profMap: r.profMap.length ? r.profMap : undefined, ...extra }));
        summary.variants[name] = { file: path.relative(here, f), ...r.stats, unsupKinds: undefined, entriesBy: r.stats.entriesBy };
        return f;
    };
    // run-time discovery of indirect-call targets (S has the checked table)
    const observedFile = path.join(dir, "observed.json");
    let observed = fs.existsSync(observedFile) ? JSON.parse(fs.readFileSync(observedFile, "utf8")) : [];
    for (let it = 0; it < 10; it++) {
        const f = write("S", translate(pe, { ...parseVariant("S"), observed }));
        // the full bench plan: a shorter run need not reach every indirect target
        const x = await runFc({ wasm: f, exe, ...plan });
        if (x.exit && x.exit.reason === "INDMISS") { observed.push(parseInt(x.exit.eip, 16)); console.log(`${wl}: run-time indirect target ${x.exit.eip} (not found statically) -> rebuild`); continue; }
        if (x.status !== "ok") throw Error(`${wl} S: ${x.status} ${JSON.stringify(x.exit)} ${x.error || ""}`);
        break;
    }
    fs.writeFileSync(observedFile, JSON.stringify(observed));
    summary.observedIndirectTargets = observed.length;
    for (const v of o.variants.split(",")) {
        const t0 = Date.now();
        write(v, translate(pe, { ...parseVariant(v), observed }));
        summary.variants[v].translateMs = Date.now() - t0;
    }
    if (o.exec) {
        const pf = write("S+profile", translate(pe, { ...parseVariant("S"), observed, profile: true }));
        const prof = path.join(dir, "executed.json");
        const x = await runFc({ wasm: pf, exe, ...plan, profileOut: prof });
        if (x.status !== "ok") throw Error(`${wl} profile: ${x.status}`);
        summary.profile = x.profile;
        const cold = new Set(JSON.parse(fs.readFileSync(prof, "utf8")).executed);
        for (const v of ["S", "F0"]) write(v + "-exec", translate(pe, { ...parseVariant(v), observed, cold }));
        delete summary.variants["S+profile"];
    }
    fs.writeFileSync(path.join(dir, "build-summary.json"), JSON.stringify(summary, null, 1));
    console.log(`== ${wl}  observed indirect targets added at run time: ${observed.length}${summary.profile ? `  executed blocks ${summary.profile.executedBlocks}/${summary.profile.totalBlocks}` : ""}`);
    for (const [k, s] of Object.entries(summary.variants)) {
        console.log(`${k.padEnd(10)} funcs ${String(s.emittedFunctions).padStart(5)} blocks ${String(s.emittedBlocks).padStart(6)} x86B ${String(s.x86BytesEmitted).padStart(8)} code ${String(s.codeSectionBytes).padStart(9)} wasm/x86 ${String(s.wasmPerX86Byte).padStart(6)} unresolvedFlags ${s.flagConsumersUnresolved} irreducible ${s.irreducible} unsup ${s.unsupSites} indJmpUnknown ${s.indirectJmpUnknown}`);
    }
}
