import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";

const wgb = process.env.WGB;
if (!wgb) throw new Error("WGB must point to the repacked original Thief Gold demo");
const out = resolve("logs", process.env.BS_TAB ?? "thief-gold-demo", "thief-gold-demo");
mkdirSync(out, { recursive: true });

async function snapshot(label: string) {
    const result = await harness().expectSurfaceNonBlack("primary")
        .shot().call("report").call("fsIoReport", { top: 200 }).run();
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    const shot = result.named.shot as { base64: string };
    const report = result.named.report as { crash: unknown; stubs: unknown[] };
    const io = result.named.fsIoReport as { enabled: boolean; top: Array<{ path: string; reads: number; bytes: number }> };
    await Bun.write(resolve(out, `${label}.png`), Buffer.from(shot.base64, "base64"));
    await Bun.write(resolve(out, `${label}.json`), JSON.stringify(report, null, 2));
    await Bun.write(resolve(out, `${label}-io.json`), JSON.stringify(io, null, 2));
    if (report.crash || report.stubs.length) throw new Error(`${label}: guest crash or unimplemented API`);
    if (!io.enabled) throw new Error(`${label}: file I/O census is disabled`);
    if (label !== "menu" && !io.top.some(f => /(?:^|[\\/])miss15\.mis$/i.test(f.path) && f.reads > 0 && f.bytes > 0)) {
        throw new Error(`${label}: Thieves' Guild mission was never read; navigation is still in the menus`);
    }
}

try {
    const boot = await harness().openWgb(wgb).sleep(5000)
        .keyHold("escape", 500).sleep(2000)
        .keyHold("escape", 500).sleep(2000).run();
    if (!boot.ok) throw new Error(JSON.stringify(boot.error));
    await snapshot("menu");

    const mission = await harness().clickHold(315, 240, 700).sleep(2000)
        .clickHold(325, 240, 700).sleep(2000)
        .clickHold(390, 442, 700).sleep(4000)
        .clickHold(530, 455, 700).sleep(5000)
        .moveRelative(0, -35).sleep(400).run();
    if (!mission.ok) throw new Error(JSON.stringify(mission.error));
    await snapshot("mission");

    const controls = await harness().keyHold("w", 800).sleep(1000)
        .moveRelative(45, -25).sleep(400).run();
    if (!controls.ok) throw new Error(JSON.stringify(controls.error));
    await snapshot("controls");
    console.log(`OK — Thief Gold demo loaded Thieves' Guild and accepted movement/mouselook; evidence: ${out}`);
} finally {
    closeHarnessConnection();
}
