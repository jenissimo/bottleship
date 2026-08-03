/**
 * In-race HP CoS A/B for an already loaded stable gameplay scene.
 *
 * Run after manually reaching the scene:
 *   BS_TAB=fastmem-ab OUT=C:/tmp/fastmem-hpcos-steady-ab.json
 *   bun tools/harness.ts run tools/examples/fastmem-reads-hpcos-steady-ab.harness.ts
 */
import { harness } from "../harness";

const OUT = process.env.OUT ?? "fastmem-hpcos-steady-ab.json";
const ORDER = [true, false, false, true, true, false, false, true];
const WARMUP = 300;
const WINDOW = 900;

const pickAll = (r: any, cmd: string) => (r?.steps ?? []).filter((s: any) => s.cmd === cmd).map((s: any) => s.result);
const stepMs = (r: any, cmd: string) => (r?.steps ?? []).filter((s: any) => s.cmd === cmd).map((s: any) => Math.round(s.ms));

let chain = harness().call("dbgCall", "fastmemReadAudit");
for (const on of ORDER) {
    chain = chain
        .call("dbgCall", "fastmemReads", on)
        .call("dbgCall", "jitConfig")
        .tickFrames(WARMUP, { timeoutMs: 600_000 })
        .call("frameReport", { reset: true, budgetMs: 33.34 })
        .tickFrames(WINDOW, { timeoutMs: 600_000 })
        .call("frameReport", { budgetMs: 33.34 })
        .call("dbgCall", "fastmemStats")
        .call("dbgCall", "fastmemReadAudit");
}

const raw = await chain.run();
const configs = pickAll(raw, "dbgCall").filter((x: any) => x && "fastmemReads" in x);
const reports = pickAll(raw, "frameReport");
const stats = pickAll(raw, "dbgCall").filter((x: any) => x && "speculatedLoadsCompiled" in x);
const audits = pickAll(raw, "dbgCall").filter((x: any) => x && "readablePages" in x);
const ticks = stepMs(raw, "tickFrames");
const runs = ORDER.map((on, i) => ({
    index: i,
    arm: on ? "on" : "off",
    config: configs[i] ?? null,
    warmupMs: ticks[i * 2] ?? null,
    windowMs: ticks[i * 2 + 1] ?? null,
    frameReport: reports[i * 2 + 1] ?? null,
    stats: stats[i] ?? null,
    audit: audits[i] ?? null,
}));
if (runs.some(r => r.config?.fastmemReads !== (r.arm === "on" ? 1 : 0))) throw new Error("JIT config readback mismatch");
if (runs.some(r => r.audit?.danger || r.audit?.missing)) throw new Error("read-map audit failed");

const byArm = (arm: string) => runs.filter(r => r.arm === arm).map(r => r.windowMs as number);
const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
const spread = (a: number[]) => Math.max(...a) / Math.min(...a) - 1;
const on = byArm("on"), off = byArm("off");
const gain = mean(off) / mean(on) - 1;
const noise = Math.max(spread(on), spread(off));
const summary = {
    order: ORDER.map(x => x ? "on" : "off"), warmupPresents: WARMUP, windowPresents: WINDOW,
    onMs: on, offMs: off, onMeanMs: mean(on), offMeanMs: mean(off),
    onFasterByPct: Math.round(gain * 1000) / 10, withinArmSpreadPct: Math.round(noise * 1000) / 10,
    verdict: gain >= 0.05 && gain > noise ? "keep candidate" : "does not clear 5%+noise gate",
};
await Bun.write(OUT, JSON.stringify({ summary, runs, raw }, null, 2));
console.log(JSON.stringify(summary, null, 2));
