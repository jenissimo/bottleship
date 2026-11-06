import { PNG } from "pngjs";
import { harness } from "../../harness";
import {
    SAVESTATE_FIXTURE_BLUE, SAVESTATE_FIXTURE_COUNTER_VA, SAVESTATE_FIXTURE_GREEN, SAVESTATE_FIXTURE_TICK_MS,
    SAVESTATE_FIXTURE_KEYBOARD_BUFFER, savestateFixtureRed, savestateFixtureWgb, type SavestateFixtureMode,
} from "../fixtures/savestate-ddraw-pe";

const SLOT = "acceptance";
const MIN_TICKS = 3;
const STAGE7 = ["window-manager", "message-queue", "user32", "user32-timers", "user32-input", "user32-system", "gdi32", "gdi32-palettes", "ddraw", "dsound", "dinput", "winmm"];
const SIZE_SLACK = 64;
const MODES: SavestateFixtureMode[] = process.env.MODE ? [process.env.MODE as SavestateFixtureMode] : ["windowed", "flip"];

const step = (r: any, cmd: string): any => {
    const s = r.steps?.find((x: any) => x.cmd === cmd);
    if (!s) throw new Error(`${cmd}: no result`);
    if (s.ok === false) throw new Error(`${cmd}: ${s.error?.message ?? JSON.stringify(s.error)}`);
    return s.result;
};

const counter = async (): Promise<number> =>
    Number(step(await harness().call("evalWorker", `return dbg.read(${SAVESTATE_FIXTURE_COUNTER_VA})`).run(), "evalWorker"));

const shownRed = async (): Promise<number[]> => {
    const shot = step(await harness().call("shot").run(), "shot");
    const png = PNG.sync.read(Buffer.from(shot.base64, "base64"));
    const reds = new Map<number, number>();
    for (let i = 0; i < png.data.length; i += 4) {
        if (Math.abs(png.data[i + 1]! - SAVESTATE_FIXTURE_GREEN) > 2 || Math.abs(png.data[i + 2]! - SAVESTATE_FIXTURE_BLUE) > 2) continue;
        reds.set(png.data[i]!, (reds.get(png.data[i]!) ?? 0) + 1);
    }
    return [...reds].sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 100).map(([r]) => r);
};

const devices = async (): Promise<{ keyboardBuffer: number; loopingSound: boolean }> =>
    step(await harness().call("evalWorker", `
        const sys = System.getInstance();
        const dsound = sys.process.getModule("dsound");
        const loopingSound = [...dsound.objects.values()].some(o => o.buffer && o.buffer.isPlaying && o.buffer.isLooping);
        return { keyboardBuffer: sys.inputManager.getDInputKeyboardBufferSize(), loopingSound };
    `).run(), "evalWorker");

const waitTicks = async (atLeast: number, timeoutMs: number): Promise<number> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const n = await counter();
        if (n >= atLeast) return n;
        if (Date.now() > end) throw new Error(`the fixture counted ${n} ticks, expected at least ${atLeast}; it is not running`);
        await Bun.sleep(250);
    }
};

async function acceptance(mode: SavestateFixtureMode): Promise<void> {
    let wgb = MODES.length === 1 ? process.env.WGB : undefined;
    if (!wgb) {
        await Bun.write(`public/apps/savestate-ddraw-${mode}-fixture.wgb`, await savestateFixtureWgb(mode));
        wgb = `/apps/savestate-ddraw-${mode}-fixture.wgb`;
    }
    await harness().openWgb(wgb).run();
    await harness().call("savestateDelete", SLOT).call("savestateDelete", `${SLOT}-again`).run().catch(() => null);
    await waitTicks(MIN_TICKS, 60_000);
    const set = await devices();
    if (set.keyboardBuffer !== SAVESTATE_FIXTURE_KEYBOARD_BUFFER || !set.loopingSound) {
        throw new Error(`the fixture did not set up its devices: ${JSON.stringify(set)}`);
    }

    let saved = -1;
    let report: any = null;
    for (let attempt = 0; attempt < 3 && saved < 0; attempt++) {
        const before = await counter();
        report = step(await harness().call("savestateSave", SLOT).run(), "savestateSave");
        if (await counter() === before) saved = before;
    }
    if (saved < 0) throw new Error("the counter moved during every save attempt; the tick is too fast for this check");
    console.log(`[savestate-ddraw-2d ${mode}] saved at counter ${saved}: ${JSON.stringify({ bytes: report.bytes, ms: report.ms })}`);
    console.log(`[savestate-ddraw-2d ${mode}] bytes per participant: ${JSON.stringify(report.sections)}`);
    console.log(`[savestate-ddraw-2d ${mode}] capture ms per participant (gdi32 includes reading back DCs and client backings): ${JSON.stringify(report.captureMs)}`);

    await waitTicks(saved + 2, 30_000);
    step(await harness().call("savestateLoadOnNextBoot", SLOT).run(), "savestateLoadOnNextBoot");
    await harness().reload().openWgb(wgb).run();

    const load = step(await harness().call("savestateLastLoad").run(), "savestateLastLoad");
    if (load?.kind !== "restored") throw new Error(`the load did not restore the slot: ${JSON.stringify(load)}`);
    const resumed = await counter();
    console.log(`[savestate-ddraw-2d ${mode}] restored in ${load.ms} ms, counter ${resumed}`);
    if (resumed < saved || resumed > saved + 1) {
        throw new Error(`after the load the counter is ${resumed}, expected ${saved} or ${saved + 1}: the guest state was not restored`);
    }

    const after = await devices();
    if (after.keyboardBuffer !== SAVESTATE_FIXTURE_KEYBOARD_BUFFER || !after.loopingSound) {
        throw new Error(`after the load buffered DirectInput or the looping sound is gone: ${JSON.stringify(after)}`);
    }

    const frameBefore = await counter();
    const restoredReds = await shownRed();
    const frameAfter = await counter();
    const restoredExpected = [savestateFixtureRed(frameBefore), savestateFixtureRed(frameAfter)];
    if (!restoredReds.some((r) => restoredExpected.includes(r))) {
        throw new Error(`right after the load the screen shows red ${JSON.stringify(restoredReds)}, expected ${restoredExpected[0]} for counter ${frameBefore}: the restored frame is not presented`);
    }
    console.log(`[savestate-ddraw-2d ${mode}] the first frame after the load shows counter ${frameBefore} (red ${restoredReds[0]})`);

    const next = await waitTicks(frameAfter + 1, SAVESTATE_FIXTURE_TICK_MS * 4);
    await Bun.sleep(300);
    const reds = await shownRed();
    const now = await counter();
    const expected = [savestateFixtureRed(now), savestateFixtureRed(now - 1)];
    if (!reds.some((r) => expected.includes(r))) {
        throw new Error(`the screen shows red ${JSON.stringify(reds)}, expected ${expected[0]} for counter ${now}: presents do not continue after the load`);
    }
    console.log(`[savestate-ddraw-2d ${mode}] ticking again (${next}), screen red ${reds[0]} matches counter ${now}`);

    const again = step(await harness().call("savestateSave", `${SLOT}-again`).run(), "savestateSave");
    console.log(`[savestate-ddraw-2d ${mode}] the restored session saves again: ${JSON.stringify({ bytes: again.bytes, ms: again.ms })}`);
    const ids = (r: any) => Object.keys(r.sections).sort().join(",");
    if (ids(again) !== ids(report)) throw new Error(`the second save has other participants: ${ids(again)} vs ${ids(report)}`);
    const drift = STAGE7.map(id => [id, again.sections[id] - report.sections[id]] as const).filter(([, d]) => Math.abs(d) > SIZE_SLACK);
    if (drift.length) throw new Error(`stage 7 sections changed size between the save and the save after the load: ${JSON.stringify(drift)}`);
    await harness().call("savestateDelete", SLOT).call("savestateDelete", `${SLOT}-again`).run();
}

await harness().call("setWorkerFlag", "__savestates", true).run();
for (const mode of MODES) await acceptance(mode);
console.log(`OK — 2D DirectDraw (${MODES.join(", ")}) saves, loads into a fresh worker, keeps its state and presents again`);
