/**
 * Production A/B for the PTE-backed fastmem read map.
 *
 * Runs eight fresh boots in drift-resistant order ON, OFF, OFF, ON ×2. The
 * Linux/nbench runner is deliberately not used: its guest page tables are not
 * BottleShip's identity map, so a raw `mem8 + linear` read is unsound there.
 *
 * Usage: WGB=g:/WGB/running/harry-potter-cos.wgb OUT=fastmem-hpcos-ab.json
 *        bun tools/harness.ts run tools/examples/fastmem-reads-hpcos-ab.harness.ts
 */
import { harness } from "../harness";

const WGB = process.env.WGB ?? "g:/WGB/running/harry-potter-cos.wgb";
const OUT = process.env.OUT ?? "fastmem-hpcos-ab.json";
const ORDER = [true, false, false, true, true, false, false, true];
const STEP = 300;
const MILESTONES = 6;
const QUIET_FRAMES = 900;

const pick = (r: any, cmd: string): any =>
    (r?.steps ?? []).filter((s: any) => s.cmd === cmd).pop()?.result;
const stepMs = (r: any, cmd: string): number =>
    (r?.steps ?? []).filter((s: any) => s.cmd === cmd).pop()?.ms ?? -1;

async function runArm(index: number, on: boolean) {
    // Keep navigation, configuration and the click in ONE page-side chain. The existing
    // CoS probes use this shape: separating them into CDP evals races the app's reload.
    const open = await harness()
        .openWgb(WGB)
        .waitForControl("New Game", { timeoutMs: 300_000 })
        .sleep(1500)
        .call("dbgCall", "fastmemReads", on)
        .call("dbgCall", "jitConfig")
        .call("frameReport", { reset: true, budgetMs: 33.34 })
        .click("New Game")
        // CoS opens the save-slot page first. Starting the first empty slot is the
        // transition into the actual gameplay/render loop being benchmarked.
        .waitForControl("1 - Empty", { timeoutMs: 60_000 })
        .click("1 - Empty")
        .tickFrames(STEP)
        .run();
    const config = (open.steps ?? []).filter((s: any) => s.cmd === "dbgCall").map((s: any) => s.result)
        .find((x: any) => x && "fastmemReads" in x);
    if (config?.fastmemReads !== (on ? 1 : 0)) {
        throw new Error(`fastmemReads=${on} did not stick: ${JSON.stringify(config)}`);
    }

    const marks = [{ presents: STEP, ms: Math.round(stepMs(open, "tickFrames")) }];
    for (let m = 1; m < MILESTONES; m++) {
        const r = await harness().tickFrames(STEP).run();
        marks.push({ presents: (m + 1) * STEP, ms: Math.round(stepMs(r, "tickFrames")) });
    }
    const steady = await harness()
        .call("frameReport", { reset: true, budgetMs: 33.34 })
        .tickFrames(QUIET_FRAMES)
        .call("frameReport", { budgetMs: 33.34 })
        .call("dbgCall", "fastmemStats")
        .call("dbgCall", "fastmemReadAudit")
        .run();
    const report = pick(steady, "frameReport");
    const calls = (steady.steps ?? []).filter((s: any) => s.cmd === "dbgCall").map((s: any) => s.result);
    const stats = calls.find((x: any) => x && "speculatedLoadsCompiled" in x) ?? null;
    const audit = calls.find((x: any) => x && "readablePages" in x) ?? null;
    if (audit?.danger || audit?.missing) throw new Error(`read-map audit failed: ${JSON.stringify(audit)}`);
    return {
        index,
        arm: on ? "on" : "off",
        marks,
        totalMs: marks.reduce((sum, x) => sum + x.ms, 0),
        postFirstMs: marks.slice(1).reduce((sum, x) => sum + x.ms, 0),
        quietMs: Math.round(stepMs(steady, "tickFrames")),
        quiet: report?.tail ?? null,
        stats,
        audit,
    };
}

const runs: any[] = [];
for (let i = 0; i < ORDER.length; i++) runs.push(await runArm(i, ORDER[i]));

const values = (arm: string, key: string) => runs.filter(r => r.arm === arm).map(r => r[key] as number);
const mean = (v: number[]) => v.reduce((sum, n) => sum + n, 0) / v.length;
const spread = (v: number[]) => Math.max(...v) / Math.min(...v) - 1;
const verdict = (key: string) => {
    const on = values("on", key), off = values("off", key);
    const gain = off.length && on.length ? off.reduce((a, b) => a + b, 0) / on.reduce((a, b) => a + b, 0) - 1 : null;
    const noise = Math.max(spread(on), spread(off));
    return { on, off, onMeanMs: mean(on), offMeanMs: mean(off), onFasterByPct: gain === null ? null : Math.round(gain * 1000) / 10,
        withinArmSpreadPct: Math.round(noise * 1000) / 10,
        passes5PctGate: gain !== null && gain >= 0.05 && gain > noise };
};

const summary = {
    order: ORDER.map(on => on ? "on" : "off"),
    milestones: { step: STEP, count: MILESTONES, totalPresents: STEP * MILESTONES },
    total: verdict("totalMs"),
    postFirst: verdict("postFirstMs"),
    quiet: verdict("quietMs"),
    decision: "Keep/read-map-enable only when quiet.passes5PctGate is true and every read-map audit is clean.",
};
await Bun.write(OUT, JSON.stringify({ summary, runs }, null, 2));
console.log(JSON.stringify(summary, null, 2));
