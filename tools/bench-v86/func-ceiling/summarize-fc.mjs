// Markdown ladder table from one or more bench-fc results files.
//   node summarize-fc.mjs out/results/ladder-hint-*.json
import fs from "node:fs";
import { median, spreadPct } from "../flat-pair/analyze.mjs";

for (const file of process.argv.slice(2)) {
    const R = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`\n### ${file}  (affinity ${R.affinity}, rounds ${R.rounds}, node ${R.node})\n`);
    for (const [wl, W] of Object.entries(R.workloads)) {
        const arms = R.arms;
        const med = (a) => median(W.runs.filter((x) => x.arm === a).map((x) => x.nsPerStep));
        const v86 = arms.find((s) => /^v86(@\w+)?$/.test(s)), em = arms.find((s) => /^em(@\w+)?$/.test(s));
        const ins = W.msvcInsPerStep;
        console.log(`**${wl}** — MSVC ins/step ${ins.toFixed(1)}, checksums ${W.checksumsAgree ? "agree" : "DISAGREE"} (${W.checksum})\n`);
        console.log(`| arm | ns/step | spread % | ns/ins | × v86 | ÷ em |`);
        console.log(`|---|---:|---:|---:|---:|---:|`);
        for (const a of arms) {
            const ns = W.runs.filter((x) => x.arm === a).map((x) => x.nsPerStep);
            const m = median(ns);
            console.log(`| ${a} | ${m.toFixed(1)} | ${spreadPct(ns).toFixed(1)} | ${(m / ins).toFixed(3)} | ${v86 ? (med(v86) / m).toFixed(2) : "-"} | ${em ? (m / med(em)).toFixed(2) : "-"} |`);
        }
        console.log("");
    }
}
