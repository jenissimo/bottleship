/**
 * Crimson Skies trial: boot to the first campaign mission and fly.
 *
 * Judges what a screenshot of "a hangar that renders" does not:
 *  - the Flight Check clipboard shows the mission objectives as ink on its note, which
 *    needs the game's own fonts, DrawTextEx's line accounting and the text texture's
 *    power-of-two upload all working,
 *  - the view answers keyboard input in flight: rolling moves the scene well beyond what
 *    level flight does,
 *  - nothing on the way is answered by an unimplemented export or a ddraw stub.
 *
 * Use a dedicated BS_TAB and a disposable browser origin/profile. This scenario never
 * deletes a container or accepts a licence: the trial shows its licence before the video
 * device dialog, so handle it separately once and rerun. The game draws its own cursor
 * from DirectInput deltas, so the menus are driven by relative moves from where it parks
 * the cursor on each screen. CRIMSON_START_AT=campaign or flight-check resumes from a
 * manually opened checkpoint; position the relative cursor for the following menu move.
 * The campaign check edits a pilot name and verifies visible
 * text before continuing, so a broken DrawText measurement cannot pass as working input.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";
import { decodePng } from "../../png-diff";

const wgb = process.env.WGB;
if (!wgb) throw new Error("Set WGB to a lawfully obtained Crimson Skies trial bundle");
if (!process.env.BS_TAB) throw new Error("BS_TAB must identify a dedicated regression tab");
const out = resolve("logs", process.env.BS_TAB, "crimson-skies-demo");
mkdirSync(out, { recursive: true });

const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;

type Chain = ReturnType<typeof harness>;
interface Report {
    crash: unknown;
    stubs: Array<{ api: string }>;
    silentStubs: Array<{ api: string; count: number }>;
    gpuErrors: { total: number };
}

function moves(h: Chain, dx: number, dy: number, n: number): Chain {
    for (let i = 0; i < n; i++) h = h.moveRelative(dx, dy).sleep(50);
    return h;
}

async function step(label: string, h: Chain): Promise<void> {
    const r = await h.run();
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error)}`);
}

/** The screen as the user sees it, saved as evidence. */
async function capture(label: string): Promise<ReturnType<typeof decodePng>> {
    const r = await harness().shot().run();
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error)}`);
    const bytes = Buffer.from((r.named.shot as { base64: string }).base64, "base64");
    await Bun.write(resolve(out, `${label}.png`), bytes);
    return decodePng(new Uint8Array(bytes));
}

/** Share of dark pixels in a rect given as fractions of the screen. */
function ink(png: ReturnType<typeof decodePng>, x0: number, y0: number, x1: number, y1: number): number {
    let dark = 0, n = 0;
    for (let y = Math.floor(y0 * png.height); y < y1 * png.height; y++) {
        for (let x = Math.floor(x0 * png.width); x < x1 * png.width; x++) {
            const i = (y * png.width + x) * 4;
            if (0.3 * png.data[i]! + 0.59 * png.data[i + 1]! + 0.11 * png.data[i + 2]! < 64) dark++;
            n++;
        }
    }
    return dark / n;
}

/** The objectives note on the right of the Flight Check clipboard: written lines over blank parchment. */
function objectives(png: ReturnType<typeof decodePng>): { written: number; blank: number } {
    return { written: ink(png, 0.69, 0.19, 0.95, 0.42), blank: ink(png, 0.69, 0.45, 0.95, 0.8) };
}

async function motion(h: Chain = harness()): Promise<number> {
    const r = await h.call("sceneProbe").run();
    if (!r.ok) throw new Error(`sceneProbe: ${JSON.stringify(r.error)}`);
    return (r.named.sceneProbe as { motion: number }).motion;
}

async function startupStage(): Promise<'device' | 'game' | 'waiting'> {
    const r = await harness().state(["windows", "screen"]).run();
    if (!r.ok) throw new Error(`state: ${JSON.stringify(r.error)}`);
    const state = r.named.state as { windows: Array<{ title: string; visible: boolean }>; screen?: {presenter?: string; presentSerial?: number} };
    if (state.windows.some(w => w.visible && w.title === "Select Video Device")) return 'device';
    if (state.windows.some(w => w.visible && w.title === "End User License Agreement")) return 'waiting';
    if (state.screen?.presenter === 'ddraw' && (state.screen.presentSerial ?? 0) > 0) return 'game';
    return 'waiting';
}

try {
    let note = { written: 0, blank: 1 };
    if (process.env.CRIMSON_START_AT !== "flight-check" && process.env.CRIMSON_START_AT !== "flight") {
        if (process.env.CRIMSON_START_AT !== "campaign") {
            await step("boot", harness().openWgb(wgb).sleep(8000));
            // Per-frame verbose streaming can overwhelm the diagnostic channel.
            // Crash, stub and GPU validation below uses report counters directly.
            await step("bound diagnostic logging", harness().call("stopLogs")
                .call("logLevel", "KERNEL32", "WARN").call("logLevel", "USER32", "WARN")
                .call("logLevel", "GDI32", "WARN"));
            const deadline = Date.now() + 90_000;
            let stage = await startupStage();
            while (stage === 'waiting') {
                if (Date.now() > deadline) {
                    await capture("no-video-dialog");
                    throw new Error("the video device dialog never appeared; if the licence is showing, handle it separately and rerun");
                }
                await harness().sleep(1000).run();
                stage = await startupStage();
            }
            if (stage === 'device') await step("pick the video device", harness().click("OK").sleep(25_000));
            else await step("wait for the menu", harness().sleep(25_000));

            // Campaign: text must remain visible when the caret is at the end, without Home.
            await step("campaign", moves(harness(), -16, -10, 5).sleep(300).clickHere(150).sleep(6000));
        }
        const initialPilot = await capture("pilot-default");
        let black = 0, fieldArea = 0;
        for (let y = Math.floor(initialPilot.height * 0.50); y < initialPilot.height * 0.53; y++) {
            for (let x = Math.floor(initialPilot.width * 0.31); x < initialPilot.width * 0.57; x++) {
                const i = (y * initialPilot.width + x) * 4;
                if (initialPilot.data[i]! < 30 && initialPilot.data[i + 1]! < 30 && initialPilot.data[i + 2]! < 30) black++;
                fieldArea++;
            }
        }
        if (black / fieldArea < 0.65) throw new Error("Campaign pilot field is not open; calibrate the relative menu move");

        let nameInput = harness().key("Home");
        for (let i = 0; i < 16; i++) nameInput = nameInput.key("Delete");
        await step("enter pilot name", nameInput.type("crimson33").sleep(1000));
        const pilot = await capture("pilot-name");
        let red = 0, area = 0;
        for (let y = Math.floor(pilot.height * 0.495); y < pilot.height * 0.533; y++) {
            for (let x = Math.floor(pilot.width * 0.30); x < pilot.width * 0.58; x++) {
                const i = (y * pilot.width + x) * 4;
                if (pilot.data[i]! > 100 && pilot.data[i]! > pilot.data[i + 1]! * 1.5 && pilot.data[i]! > pilot.data[i + 2]! * 1.5) red++;
                area++;
            }
        }
        if (red / area < 0.01) throw new Error("the entered pilot name is not visible");
        const found = await harness().call("memoryFind", "crimson33", {limit: 4, context: 8}).run();
        if (!found.ok || !(found.named.memoryFind as {hits: unknown[]}).hits.length) throw new Error("pilot name did not reach the guest");
        console.log("pilot name entered and visible");
        await step("continue", moves(harness(), 16, 0, 6).sleep(400).clickHere(150).sleep(45_000));
        await capture("hangar");

        // Next Mission opens the voiced briefing; Go To Flight Check answers once it may.
        await step("next mission", moves(harness(), -16, 10, 16).sleep(400).clickHere(150).sleep(20_000));
        await step("aim at flight check", moves(harness(), 15, 1, 26).moveRelative(0, 4).sleep(400));
        for (let waited = 0; ; waited += 10_000) {
            await step("go to flight check", harness().clickHere(150).sleep(10_000));
            note = objectives(await capture("flight-check"));
            if (note.written > 0.08 && note.blank < 0.01) break;
            if (waited >= 180_000) {
                throw new Error(`no objectives on the Flight Check note after 3 min of briefing ` +
                `(ink ${note.written.toFixed(3)} written / ${note.blank.toFixed(3)} blank)`);
            }
        }

    }
    if (process.env.CRIMSON_START_AT !== "flight") {
        note = objectives(await capture("flight-check-verified"));
        if (note.written <= 0.08 || note.blank >= 0.01) throw new Error("Flight Check objectives are not legible");

        // The cursor hotspot must reach the button below the clipboard.
        await step("fly mission", moves(harness(), -14, 4, 5).sleep(400).clickHere(300));
    }
    // The opening camera move is letterboxed; it must not count as keyboard flight.
    for (let waited = 0; ; waited += 1000) {
        await harness().sleep(1000).run();
        const frame = await capture("flight-entry");
        let black = 0, pixels = 0;
        for (const y of [Math.floor(frame.height * 0.03), Math.floor(frame.height * 0.97)]) {
            for (let x = 0; x < frame.width; x += 8) {
                const i = (y * frame.width + x) * 4;
                if (frame.data[i]! < 10 && frame.data[i + 1]! < 10 && frame.data[i + 2]! < 10) black++;
                pixels++;
            }
        }
        if (black / pixels < 0.8) break;
        if (waited >= 120000) throw new Error("the flight introduction never ended");
    }
    let level = 0;
    for (let waited = 0; level < 5; waited += 2000) {
        if (waited > 120_000) throw new Error("flight never started presenting a moving view");
        await harness().sleep(2000).run();
        level = await motion();
    }
    await harness().sleep(3000).run();
    level = await motion();
    let rolling = 0;
    for (const vk of [VK_LEFT, VK_RIGHT]) {
        rolling = await motion(harness().key(vk, { down: true }).sleep(1000));
        await step("release", harness().key(vk, { up: true }));
        if (rolling > level * 1.5) break;
    }
    const flight = await capture("flight");
    let failureText = 0;
    for (let y = Math.floor(flight.height * 0.19); y < flight.height * 0.22; y++) {
        for (let x = Math.floor(flight.width * 0.44); x < flight.width * 0.56; x++) {
            const i = (y * flight.width + x) * 4;
            if (flight.data[i]! < 30 && flight.data[i + 1]! < 30 && flight.data[i + 2]! > 150) failureText++;
        }
    }
    if (failureText > 6) throw new Error("the pilot crashed: the blue Fatal Crash overlay is visible");

    const done = await harness().call("report").run();
    if (!done.ok) throw new Error(`report: ${JSON.stringify(done.error)}`);
    const report = done.named.report as Report;
    await Bun.write(resolve(out, "report.json"), JSON.stringify(report, null, 2));
    if (report.crash) throw new Error(`guest crash: ${JSON.stringify(report.crash).slice(0, 400)}`);
    if (report.stubs.length) throw new Error(`unimplemented API: ${report.stubs.map(s => s.api).join(", ")}`);
    const stubbedDraws = report.silentStubs.filter(s => s.api.startsWith("ddraw:"));
    if (stubbedDraws.length) {
        throw new Error(`ddraw calls answered by a stub: ${stubbedDraws.map(s => `${s.api} x${s.count}`).join(", ")}`);
    }
    if (report.gpuErrors.total) throw new Error(`${report.gpuErrors.total} GPU error(s)`);
    if (rolling <= level * 1.5) {
        throw new Error(`the view did not answer the roll keys (motion ${rolling.toFixed(1)} rolling, ${level.toFixed(1)} level)`);
    }

    console.log(`OK — Crimson Skies trial flew (motion ${level.toFixed(1)} level, ${rolling.toFixed(1)} rolling); ` +
    (process.env.CRIMSON_START_AT === "flight" ? "" : `Flight Check ink ${note.written.toFixed(2)}; `) +
    `evidence: ${out}`);
} finally {
    try {
        await harness().key(VK_LEFT, { up: true }).key(VK_RIGHT, { up: true }).pause().run();
    } finally {
        closeHarnessConnection();
    }
}
