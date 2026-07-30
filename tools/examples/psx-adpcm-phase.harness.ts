/**
 * A/B for the PSX/VAG ADPCM hook over the phase where the codec actually runs.
 *
 * WHY NOT A STEADY-STATE WINDOW. A settled A/B (300 s settle, 3 x 30 s per arm) read
 * 697 vs 698 presents — a dead heat — because by then the decoder had STOPPED: the
 * hook's own counters were byte-identical across all three windows of the arm, and the
 * count-weighted census showed 0% for the loop in BOTH arms. This title decodes its
 * level audio in one burst during load / first play (26.3M samples measured), which is
 * the phase the original profile sampled. Measuring after it is measuring nothing.
 *
 * So the metric is TIME-TO-MILESTONE: wall-clock per 300 presents from the moment the
 * bundle is handed over, which traverses the same timeline in both arms and therefore
 * cannot be confounded by the warm-up ramp that makes fixed-duration windows useless
 * here. Reported alongside how many samples the hook served by each milestone, so a
 * delta can be attributed to the phase that produced it rather than to the run.
 *
 * RESULT so far (6 interleaved boots, Harry Potter: CoS): on 106798 ms vs off 103322 ms
 * total, i.e. the hook 3.3% SLOWER nominally, against a within-arm spread of 8-14% —
 * inconclusive, no effect either way. Consistent with the loop's real share measured by
 * psx-adpcm-share.harness.ts (4.7% of counted guest instructions while audio plays, absent
 * otherwise), which is at or below what presents can resolve on a shared machine.
 *
 * Usage: PSX_ADPCM=on|off|alt REPEATS=3 MILESTONES=6 OUT=<file>
 *        bun tools/harness.ts run tools/examples/psx-adpcm-phase.harness.ts
 */

import { harness } from "../harness";

const WGB = process.env.WGB ?? "g:/WGB/running/harry-potter-cos.wgb";
/** "on" | "off" | "alt" (default): alternate the arms run by run. Alternating is what
 *  makes the comparison robust to slow host drift — a block of ON runs followed by a
 *  block of OFF runs charges any drift entirely to the arm change. */
const MODE = (process.env.PSX_ADPCM ?? "alt") as "on" | "off" | "alt";
const REPEATS = Number(process.env.REPEATS ?? 2);
const MILESTONES = Number(process.env.MILESTONES ?? 6);
const STEP = Number(process.env.STEP ?? 300);
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 33.34);

const pick = (r: any, cmd: string): any =>
    (r?.steps ?? []).filter((s: any) => s.cmd === cmd).pop()?.result;
const stepMs = (r: any, cmd: string): number =>
    (r?.steps ?? []).filter((s: any) => s.cmd === cmd).pop()?.ms ?? -1;

async function workerEval(expr: string): Promise<any> {
    const p = Bun.spawn(["bun", "tools/harness.ts", "worker-eval", expr], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    await p.exited;
    try { return JSON.parse(JSON.parse(out.trim())); }
    catch { throw new Error(`worker-eval failed for ${expr.slice(0, 60)}…: ${(out + err).slice(0, 300)}`); }
}

/** Turn the descriptor off for this boot, and PROVE it took: a config write that silently
 *  did nothing would give an OFF arm that is really a second ON arm — which is exactly
 *  what the first attempt at this produced (identical sample counts in both arms). */
async function disableDescriptor(): Promise<void> {
    for (let i = 0; i < 30; i++) {
        try {
            const cfg = await workerEval(
                "JSON.stringify((()=>{const E=globalThis.EmulatorConfig;if(!E)return null;"
                + "const c=E.getInstance().hleLibs;c['psx-adpcm']={enable:false};return c;})())");
            if (cfg?.["psx-adpcm"]?.enable === false) return;
        } catch { /* worker not up yet */ }
        await Bun.sleep(500);
    }
    throw new Error("could not disable the psx-adpcm descriptor — refusing to report an OFF arm that is really ON");
}

const stats = async () => {
    try { return await workerEval("JSON.stringify(globalThis.__psxAdpcmStats?globalThis.__psxAdpcmStats():null)"); }
    catch { return null; }
};

async function runOnce(i: number, OFF: boolean) {
    await harness().reload().run();
    if (OFF) await disableDescriptor();
    const load = await harness()
        .call("frameReport", { reset: true, budgetMs: BUDGET_MS })
        // reload:false is load-bearing — openWgb reloads the page by default, which
        // recreates the worker and with it the config singleton, silently discarding the
        // opt-out written above.
        .openWgb(WGB, { reload: false })
        .tickFrames(STEP)
        .run();
    const marks: any[] = [{ upTo: STEP, ms: Math.round(stepMs(load, "tickFrames")), openWgbMs: Math.round(stepMs(load, "openWgb")), samples: (await stats())?.samples ?? null }];
    for (let m = 1; m < MILESTONES; m++) {
        const r = await harness().tickFrames(STEP).run();
        marks.push({ upTo: (m + 1) * STEP, ms: Math.round(stepMs(r, "tickFrames")), samples: (await stats())?.samples ?? null });
    }
    const fr = pick(await harness().call("frameReport", { budgetMs: BUDGET_MS }).run(), "frameReport");
    const t = fr?.tail ?? {};
    // Count-weighted census LAST: arming trace2 slows the guest, so it must not precede a
    // timed milestone. It is the channel that never looks at time, so it says whether the
    // guest stopped executing the loop independently of any timing above.
    const gb = pick(await harness().call("guestBlocks", { ms: 6000, top: 12 }).run(), "guestBlocks");
    const rows = gb?.counted?.available ? (gb.counted.rows ?? []) : null;
    const census = rows
        ? {
            adpcmSharePct: Math.round(rows.filter((x: any) => /^core[^+]*\+0x7a[bc]/i.test(String(x.module))).reduce((s: number, x: any) => s + x.sharePct, 0) * 10) / 10,
            adpcmRows: rows.filter((x: any) => /^core[^+]*\+0x7a[bc]/i.test(String(x.module))).map((x: any) => ({ module: x.module, exec: x.exec, ins: x.ins, sharePct: x.sharePct })),
            elapsedMs: gb.counted.window.elapsedMs, watchedPages: gb.counted.window.watchedPages,
        }
        : { refused: gb?.counted?.note ?? gb?.armRefused };
    const hooks = (pick(await harness().call("dbgCall", "hleHooks").run(), "dbgCall") ?? [])
        .filter((h: any) => h.libId === "psx-adpcm");
    if (OFF && hooks.length > 0) throw new Error("OFF arm still has a patched hook — the arms are not different");
    if (!OFF && hooks.length === 0) throw new Error("ON arm has no hook — nothing was measured");
    return {
        run: i, arm: OFF ? "off" : "on",
        marks,
        totalMs: marks.reduce((s, x) => s + x.ms, 0),
        postLoadMs: marks.slice(1).reduce((s, x) => s + x.ms, 0),
        tail: t.ok
            ? { presents: fr?.counters?.presents, samples: t.sampleCount, meanMs: t.meanMs, p50Ms: t.p50Ms, p95Ms: t.p95Ms, p99Ms: t.p99Ms, maxMs: t.maxMs, overBudgetPct: t.budget?.overPct }
            : { status: t.status },
        finalStats: await stats(),
        census,
        hooks,
    };
}

const order: boolean[] = [];
for (let i = 0; i < REPEATS; i++) {
    if (MODE === "alt") { order.push(false, true); } else order.push(MODE === "off");
}

const runs: any[] = [];
for (let i = 0; i < order.length; i++) runs.push(await runOnce(i, order[i]));

const mean = (v: number[]) => Math.round(v.reduce((a, b) => a + b, 0) / v.length);
const spreadPct = (v: number[]) => (v.length < 2 ? null : Math.round((Math.max(...v) / Math.min(...v) - 1) * 1000) / 10);
const arm = (want: string) => runs.filter(r => r.arm === want);
const stat = (want: string, key: string) => {
    const v = arm(want).map(r => r[key] as number);
    return v.length ? { runs: v, mean: mean(v), min: Math.min(...v), max: Math.max(...v), withinArmSpreadPct: spreadPct(v) } : null;
};

const onTotal = stat("on", "totalMs"), offTotal = stat("off", "totalMs");
const onPost = stat("on", "postLoadMs"), offPost = stat("off", "postLoadMs");
const gain = (a: any, b: any) => (a && b ? Math.round((b.mean / a.mean - 1) * 1000) / 10 : null);

const summary = {
    mode: MODE, order: order.map(o => (o ? "off" : "on")), step: STEP, milestones: MILESTONES,
    metric: "wall-clock ms to advance N presents from bundle hand-over; lower is faster. "
        + "totalMs includes the first STEP presents (bundle load); postLoadMs excludes them.",
    totalMs: { on: onTotal, off: offTotal, onFasterByPct: gain(onTotal, offTotal) },
    postLoadMs: { on: onPost, off: offPost, onFasterByPct: gain(onPost, offPost) },
    verdict: onTotal && offTotal
        ? (Math.abs(gain(onTotal, offTotal)!) <= Math.max(onTotal.withinArmSpreadPct ?? 0, offTotal.withinArmSpreadPct ?? 0)
            ? "INCONCLUSIVE: the arm delta does not exceed the within-arm spread"
            : "delta exceeds the within-arm spread of both arms")
        : "single-arm run",
    perMilestoneMs: runs.map(r => ({ arm: r.arm, ms: r.marks.map((m: any) => m.ms) })),
    samplesAtMilestone: runs.map(r => ({ arm: r.arm, samples: r.marks.map((m: any) => m.samples) })),
    census: runs.map(r => ({ arm: r.arm, ...r.census })),
    hooks: runs.map(r => ({ arm: r.arm, hooks: r.hooks })),
};
await Bun.write(process.env.OUT ?? "psx-adpcm-phase.json", JSON.stringify({ summary, runs }, null, 2));
console.log(JSON.stringify(summary, null, 2));
