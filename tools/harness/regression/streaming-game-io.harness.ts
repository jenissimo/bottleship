/** Cold/sparse-resume/full-cache game acceptance; no timing speedup is inferred. */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";
import type { WgbIoMode } from "@bottleship/formats/wgb/io-profile";

const wgb = process.env.WGB;
if (!wgb) throw new Error("WGB is required (URL or absolute disk path)");
const mode = (process.env.IO_MODE ?? "stream+fill") as WgbIoMode;
if (!["stream", "stream+fill"].includes(mode)) throw new Error("IO_MODE must be stream or stream+fill");
const caseId = process.env.IO_CASE ?? `acceptance-${Date.now()}`;
const port = process.env.BS_SIDECAR_PORT ?? "3001";
const gameUrl = (path: string) => /^[A-Za-z]:[\\/]/.test(path)
    ? `http://localhost:${port}/wgb?ioCase=${encodeURIComponent(caseId)}&path=${encodeURIComponent(path)}`
    : path;
const url = gameUrl(wgb);
const root = resolve("logs", process.env.BS_TAB ?? "streaming-game-io");
mkdirSync(root, { recursive: true });
const evidence: unknown[] = [];

async function snapshot(label: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
        const sample = await harness().call("sceneProbe", { samples: 2, gapMs: 300 }).run();
        if (!sample.ok) throw new Error(`${label}: ${JSON.stringify(sample.error)}`);
        if ((sample.named.sceneProbe as any).brightness > 1) break;
        if (Date.now() > deadline) throw new Error(`${label}: scene remained black for 60s`);
        await Bun.sleep(1000);
    }
    const result = await harness().state(["screen", "threads", "audio"])
        .callRoot("ioReport").callRoot("asyncParkReport")
        .call("asyncParkReport").call("sceneProbe", { samples: 2, gapMs: 300 })
        .call("stubs").run();
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    const state = result.named.state as any;
    const io = result.named.ioReport as any;
    const scene = result.named.sceneProbe as any;
    evidence.push({ label, result });
    await Bun.write(resolve(root, `${caseId}.game-io.json`), JSON.stringify({ url, mode, evidence }, null, 2));
    const shot = await harness().shot().run();
    if (!shot.ok) throw new Error(`${label}: screenshot failed: ${JSON.stringify(shot.error)}`);
    const png = shot.named.shot as { base64: string };
    await Bun.write(resolve(root, `${caseId}.${label}.png`), Buffer.from(png.base64, "base64"));
    if (!(state.screen?.presentSerial > 0) || !(scene.brightness > 1)) throw new Error(`${label}: no rendered scene`);
    if (io.armed && (!io.ioWorker.chunkOutcomesSumOk || io.asyncChannel.failed || io.guest.timeouts || io.ioWorker.diskWriteFailures)) {
        throw new Error(`${label}: invalid I/O ledger or failed reads: ${JSON.stringify(io)}`);
    }
    const stubs = result.named.stubs as any[];
    if (stubs.length) throw new Error(`${label}: unimplemented APIs: ${stubs.map(s => s.api).join(", ")}`);
    console.log(JSON.stringify({ label, presenter: state.screen.presenter, presentSerial: state.screen.presentSerial,
        brightness: scene.brightness, motion: scene.motion, streamed: io.armed, diskComplete: io.ioWorker?.diskComplete,
        diskChunks: io.ioWorker?.diskChunks, coldChunks: io.ioWorker?.chunksFetchedCold, asyncFailed: io.asyncChannel?.failed }));
    return io;
}

try {
    const boot = await harness().openWgb(url, { io: { mode }, args: process.env.GAME_ARGS })
        .tickFrames(30, { timeoutMs: 180_000 }).run();
    if (!boot.ok) throw new Error(`cold boot: ${JSON.stringify(boot.error)}`);
    const cold = await snapshot("cold");
    if (!cold.armed || !cold.ioWorker.diskArmed || !cold.ioWorker.chunksFetchedCold) throw new Error("Cold run did not exercise persistent streaming");

    if (process.env.GAME_INPUT) {
        const input = JSON.parse(process.env.GAME_INPUT) as Array<{ cmd: string; args: unknown[] }>;
        const chain = harness().callRoot("ioPhase", "first-level");
        for (const step of input) chain.call(step.cmd, ...step.args);
        const driven = await chain.tickFrames(60, { timeoutMs: 180_000 }).run();
        if (!driven.ok) throw new Error(`gameplay: ${JSON.stringify(driven.error)}`);
        await snapshot("after-input");
    }

    if (mode === "stream+fill") {
        const deadline = Date.now() + 180_000;
        for (;;) {
            const result = await harness().callRoot("ioReport").sleep(1000).run();
            if (!result.ok) throw new Error(JSON.stringify(result.error));
            const io = result.named.ioReport as any;
            if (io.ioWorker?.diskComplete) break;
            if (Date.now() > deadline) throw new Error("Full disk promotion did not complete within 180s");
        }
        await snapshot("filled");
    }
    const reopened = await harness().openWgb(url, { io: { mode }, args: process.env.GAME_ARGS })
        .tickFrames(30, { timeoutMs: 180_000 }).run();
    if (!reopened.ok) throw new Error(`reopen: ${JSON.stringify(reopened.error)}`);
    const warm = await snapshot("reopened");
    if (mode === "stream+fill" && warm.armed) throw new Error("Full cache reopen still uses network streaming");
    if (mode === "stream" && (!warm.armed || !warm.ioWorker.chunksDiskHit)) throw new Error("Sparse reopen did not serve persisted chunks");
    if (process.env.SWITCH_WGB) {
        const switched = await harness().evalPage("window.__ioSwitchMarker = 1")
            .openWgb(gameUrl(process.env.SWITCH_WGB), { reload: false, io: { mode: "stream" } })
            .tickFrames(30, { timeoutMs: 180_000 })
            .evalPage("window.__ioSwitchMarker === 1").run();
        if (!switched.ok || switched.named.evalPage !== true) throw new Error(`Game switch reloaded the page or failed: ${JSON.stringify(switched.error)}`);
        await snapshot("switched");
    }
    console.log("PASS: cold game I/O, valid ledgers, persistent reopen, rendered scenes and requested inputs/switch");
} finally {
    closeHarnessConnection();
}
