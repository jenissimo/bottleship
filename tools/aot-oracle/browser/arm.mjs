import { prepareUnit, runV86Arm } from "./fixed-work.mjs";

const params = new URLSearchParams(location.search);
const caseId = params.get("case") ?? "k3";
const outer = Number(params.get("outer") ?? 1_000_000);
const warmup = Number(params.get("warmup") ?? 1_000_000);
const unitUrl = params.get("unit");
const rounds = Number(params.get("rounds") ?? 1);
const engineSha = params.get("engineSha") ?? "";
const engineDir = params.get("engineDir") ?? "/vendor/v86/build";
const report = (o) => { window.__ORACLE_RESULT__ = o; };

async function main() {
    const { V86 } = await import(`${engineDir}/libv86.mjs`);
    const unit = unitUrl ? await prepareUnit(unitUrl) : null;
    const samples = [];
    const run = (u) => runV86Arm({ V86, caseId, outer, warmup, engineDir, engineSha, unit: u });
    for (let round = 0; round < rounds; round++) {
        let reference, candidate;
        // Each pair reverses order, so startup and host drift land on both arms.
        if (unit && round % 2) { candidate = await run(unit); reference = await run(null); }
        else { reference = await run(null); candidate = unit ? await run(unit) : null; }
        for (const sample of [reference, candidate].filter(Boolean)) {
            if (sample.status !== "ok") return report({ impl: "v86-browser", case: caseId, ...sample });
        }
        samples.push({ reference, unit: candidate });
        window.__ORACLE_PROGRESS__ = round + 1;
    }
    report({ impl: "v86-browser", case: caseId, status: "ok", rounds: samples });
}

main().catch((e) => report({ impl: "v86-browser", case: caseId, status: "ARM_ERROR",
    why: String(e?.stack ?? e) }));
