// Print markdown tables from the newest out/results/<tag>-*.json of each tag.
//   node summarize.mjs [tag ...]        default: main lua cfg sweep char char-sweep
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const dir = path.join(here, "out", "results");
const tags = process.argv.slice(2).length ? process.argv.slice(2) : ["main", "lua", "cfg", "sweep", "char", "char-sweep"];
const newest = (tag) => {
    const f = fs.readdirSync(dir).filter((n) => n.startsWith(tag + "-2") && n.endsWith(".json")).sort().pop();
    return f ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : null;
};
for (const tag of tags) {
    const r = newest(tag);
    if (!r) { console.log(`\n(no results for ${tag})`); continue; }
    if (r.rows) {
        console.log(`\n### ${tag}\n\n| workload | arm | ins/step | ins/block | exits/1000 ins | chained % | const-unchained % | dynamic % | indirect % | pages | modules | emitted Wasm MB | .text KB | Wasm B per x86 B | compiled % |`);
        console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
        for (const x of r.rows) {
            const c = x.classesPct;
            console.log(`| ${x.workload} | ${x.arm} | ${x.insPerStep.toFixed(0)} | ${x.insPerBlock} | ${x.exitsPerKiloInsn} | ${c.chained} | ${c.constantTargetUnchained} | ${c.dynamic} | ${c.indirect} | ${x.pages} | ${x.modules} | ${(x.emittedWasmBytes / 1e6).toFixed(1)} | ${(x.textBytes / 1024).toFixed(0)} | ${(x.emittedWasmBytes / x.textBytes).toFixed(1)} | ${x.compiledSharePct} |`);
        }
        console.log(`| HL2 (given) | | | ${r.hl2.insPerBlock} | ${r.hl2.exitsPerKiloInsn} | ${r.hl2.classesPct.chained} | ${r.hl2.classesPct.constantTargetUnchained} | ${r.hl2.classesPct.dynamic} | ${r.hl2.classesPct.indirect} | hundreds | | | | | |`);
        continue;
    }
    console.log(`\n### ${tag}  (rounds ${r.rounds}, affinity ${r.affinity}, engine v86.wasm ${r.engine.wasmSha256.slice(0, 12)}, node ${r.node})`);
    for (const [wl, w] of Object.entries(r.workloads)) {
        console.log(`\n**${wl}** — plan ${JSON.stringify(w.plan)}, checksums ${w.checksumsAgree ? "agree" : "DISAGREE"}\n`);
        console.log("| arm | ns/step (median) | spread % | runs | guest ins/step | ns/guest ins | ns/MSVC ins | × em |");
        console.log("|---|---|---|---|---|---|---|---|");
        for (const [arm, s] of Object.entries(w.summary)) {
            console.log(`| ${arm} | ${s.nsPerStep.toFixed(1)} | ${s.spreadPct} | ${s.runs.map((v) => v.toFixed(0)).join(" / ")} | ${s.guestInsPerStep ? s.guestInsPerStep.toFixed(0) : "-"} | ${s.nsPerGuestIns ?? "-"} | ${s.nsPerMsvcIns ?? "-"} | ${s.vsEm ?? "-"} |`);
        }
        const a = w.summary.v86, b = w.summary["v86#aa"];
        if (a && b) console.log(`\nA/A (v86#aa / v86): ${(b.nsPerStep / a.nsPerStep).toFixed(3)}`);
    }
}
