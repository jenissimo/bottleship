/**
 * Midtown Madness 2 trial: boot to a race and drive.
 *
 * Judges three things a screenshot of "a city that renders" does not:
 *  - the level loading screen shows its artwork, not a progress bar on black (a partial GPU
 *    colour fill used to drop the CPU-blitted background under it),
 *  - the strided drawing path is exercised and is not answered by a silent stub;
 *    this is API coverage, not a visual comparison of every pedestrian with Windows,
 *  - the car moves under keyboard input.
 *
 * Use a dedicated BS_TAB and a disposable browser origin/profile. This scenario never
 * deletes a container or accepts a licence. Handle the trial's licence separately, then
 * run with MM2_AT_MENU=1; otherwise WGB loads the bundle and the scenario waits at the
 * licence for the operator. Selects Cruise explicitly instead of repeating the last race.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";
import { decodePng } from "../../png-diff";

const wgb = process.env.WGB;
const atMenu = process.env.MM2_AT_MENU === "1";
if (!atMenu && !wgb) throw new Error("Set WGB to a lawfully obtained trial, or MM2_AT_MENU=1 after loading it");
if (!process.env.BS_TAB) throw new Error("BS_TAB must identify a dedicated regression tab");
const out = resolve("logs", process.env.BS_TAB, "midtown-madness-2-demo");
mkdirSync(out, { recursive: true });

/** Menu and vehicle-select put their forward button here (640x480 guest pixels). */
const NEXT = { x: 525, y: 447 };
const MENU_WIDTH = 640;
const VK_UP = 0x26;
/** The loading screen presents when its bar advances, about once a second; a race presents every frame. */
const RACING_PRESENTS_PER_SECOND = 8;

interface Screen { width: number; height: number; presentSerial: number }

async function screen(): Promise<Screen> {
    const r = await harness().state(["screen"]).run();
    if (!r.ok) throw new Error(`state: ${JSON.stringify(r.error)}`);
    return (r.named.state as { screen: Screen }).screen;
}

/** The screen as the user sees it, saved as evidence; returns the share of non-black pixels. */
async function litFraction(label: string): Promise<number> {
    const r = await harness().shot().run();
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error)}`);
    const bytes = Buffer.from((r.named.shot as { base64: string }).base64, "base64");
    await Bun.write(resolve(out, `${label}.png`), bytes);
    const png = decodePng(new Uint8Array(bytes));
    let lit = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i]! + png.data[i + 1]! + png.data[i + 2]! > 24) lit++;
    }
    return lit / (png.width * png.height);
}

async function waitFor(what: string, timeoutMs: number, test: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await test()) return;
        await harness().sleep(100).run();
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

try {
    const boot = atMenu
        ? await harness().resume().run()
        : await harness().reload().sleep(1500).openWgb(wgb!).sleep(8000).run();
    if (!boot.ok) throw new Error(`boot: ${JSON.stringify(boot.error)}`);

    await waitFor("the main menu", 60_000, async () => (await screen()).width === MENU_WIDTH);
    await harness().sleep(4000).run();
    if (await litFraction("menu") < 0.5) throw new Error("main menu is mostly black");

    // Races -> Cruise -> Select Vehicle, independent of the saved last race.
    const toVehicle = await harness().clickHold(530, 330, 250).sleep(2500)
        .clickHold(150, 75, 250).sleep(800).clickHold(NEXT.x, NEXT.y, 250).sleep(4000).run();
    if (!toVehicle.ok) throw new Error(`select Cruise: ${JSON.stringify(toVehicle.error)}`);
    if (await litFraction("vehicle") < 0.5) throw new Error("vehicle select is mostly black");
    const go = await harness().clickHold(NEXT.x, NEXT.y, 250).run();
    if (!go.ok) throw new Error(`go drive: ${JSON.stringify(go.error)}`);

    // The load starts with the switch out of the menu's display mode.
    await waitFor("the loading screen", 30_000, async () => (await screen()).width !== MENU_WIDTH);
    // SetDisplayMode changes worker state before the new frame reaches the host. A shot
    // taken on the mode change alone can still show vehicle select and falsely pass.
    const modeSwitch = await screen();
    await waitFor("a frame presented in the loading mode", 30_000,
        async () => (await screen()).presentSerial > modeSwitch.presentSerial);
    await harness().sleep(300).run();
    const loading = await litFraction("loading");
    const during = await screen();
    await harness().sleep(1000).run();
    const presentsPerSecond = (await screen()).presentSerial - during.presentSerial;
    if (presentsPerSecond > RACING_PRESENTS_PER_SECOND) {
        throw new Error("the level loaded before the loading screen could be captured; nothing was judged — rerun");
    }
    if (loading < 0.5) {
        throw new Error(`loading screen is ${(loading * 100).toFixed(1)}% lit: the background artwork is missing`);
    }

    let before = (await screen()).presentSerial;
    await waitFor("the race to start presenting", 120_000, async () => {
        await harness().sleep(1000).run();
        const now = (await screen()).presentSerial;
        const racing = now - before > RACING_PRESENTS_PER_SECOND;
        before = now;
        return racing;
    });
    // The city's traffic and pedestrians are still being set up for a while after the first frame.
    await harness().sleep(10_000).run();

    // Pedestrians are spawned around the car as it moves, so driving is also what brings the
    // strided draws into the frame. How soon depends on where the nearest one is.
    // Motion is read early: a car held at full throttle from the start line soon meets a wall.
    const start = await harness().perfProfile({ reset: true }).key(VK_UP, { down: true }).sleep(1500)
        .call("sceneProbe").run();
    if (!start.ok) throw new Error(`drive: ${JSON.stringify(start.error)}`);
    const motion = (start.named.sceneProbe as { motion: number }).motion;
    let strided = 0;
    for (let waited = 2500; strided === 0 && waited < 30_000; waited += 1500) {
        const poll = await harness().sleep(1500).perfThunks({ top: 4, filter: "PrimitiveStrided" }).run();
        if (!poll.ok) throw new Error(`perfThunks: ${JSON.stringify(poll.error)}`);
        strided = (poll.named.perfThunks as { rows: Array<{ count: number }> }).rows.reduce((n, row) => n + row.count, 0);
    }
    const drive = await harness().key(VK_UP, { up: true }).perfProfile({ enable: false }).call("report").run();
    if (!drive.ok) throw new Error(`drive: ${JSON.stringify(drive.error)}`);
    const report = drive.named.report as {
        crash: unknown;
        stubs: Array<{ api: string }>;
        silentStubs: Array<{ api: string; count: number }>;
        gpuErrors: { total: number };
    };
    await Bun.write(resolve(out, "report.json"), JSON.stringify(report, null, 2));
    if (await litFraction("race") < 0.5) throw new Error("the race view is mostly black");

    if (report.crash) throw new Error(`guest crash: ${JSON.stringify(report.crash).slice(0, 400)}`);
    if (report.stubs.length) throw new Error(`unimplemented API: ${report.stubs.map(s => s.api).join(", ")}`);
    const stubbedDraws = report.silentStubs.filter(s => s.api.startsWith("ddraw:"));
    if (stubbedDraws.length) {
        throw new Error(`ddraw calls answered by a stub: ${stubbedDraws.map(s => `${s.api} x${s.count}`).join(", ")}`);
    }
    if (report.gpuErrors.total) throw new Error(`${report.gpuErrors.total} GPU error(s)`);
    // A parked view reads about 0.2 (traffic alone); the first seconds of acceleration read 13 or more.
    if (motion < 5) throw new Error(`the view did not move under acceleration (motion ${motion.toFixed(2)})`);
    if (strided === 0) {
        throw new Error("no strided draw was issued in 30 s of driving, so that API path was not exercised — rerun");
    }

    console.log(`OK — Midtown Madness 2 trial showed its loading artwork ` +
        `(${(loading * 100).toFixed(0)}% lit), entered Cruise, drove (motion ${motion.toFixed(1)}) and issued ` +
        `${strided} strided draw calls; evidence: ${out}`);
} finally {
    try {
        await harness().key(VK_UP, { down: false, up: true }).perfProfile({ enable: false }).pause().run();
    } finally {
        closeHarnessConnection();
    }
}
