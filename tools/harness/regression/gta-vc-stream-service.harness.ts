/**
 * GTA Vice City — an app-backed Miles stream keeps being serviced.
 *
 * Regresses the class "a stream fed through the app's own file callbacks stops
 * being topped up". Real MSS services its streams from a thread it starts itself,
 * so a title need never call AIL_serve; ours can only do that work from a guest
 * entry point (a refill runs the app's file callbacks, which is guest code and
 * needs a thunk to park). If that servicing regresses, a stream plays until its
 * ring drains and then stops mid-file forever — and any title whose script is
 * timed to a dialogue line hangs there, rendering happily at full frame rate.
 *
 * The stall is invisible from outside: presents keep coming, the day/night cycle
 * keeps running, pixels keep changing. The only thing that stops is one stream's
 * byte position, which is what this asserts on.
 *
 *   WGB=G:/WGB/todo/gta-vice-city.wgb bun tools/harness.ts run \
 *     tools/harness/regression/gta-vc-stream-service.harness.ts
 */

import { harness } from "../../harness";

const WGB = process.env.WGB ?? "/apps/external-wgb/gta-vice-city.wgb";

/** Menu hit points as a fraction of the screen — the bundle picks its own resolution. */
const NEW_GAME_MENU = { x: 0.502, y: 0.397 };   // "Начать игру" on the main menu
const NEW_GAME_ITEM = { x: 0.496, y: 0.366 };   // "Новая игра" on the sub-menu

/** The level load before the intro dialogue is minutes on a cold cache, not seconds. */
const WAIT_FOR_DIALOGUE_MS = 240_000;
/** Once a dialogue line exists, this is the window the assertions run over. */
const WATCH_MS = 45_000;
const POLL_MS = 1500;

interface StreamRow {
    filename: string;
    isPlaying: boolean;
    position: number;
    source: { kind: string | null } | null;
    ring: { used?: number } | null;
}
interface Snap { streams: StreamRow[]; engine: Record<string, number> }

function fail(why: string): never {
    console.error(`FAIL — ${why}`);
    process.exitCode = 1;
    throw new Error(why);
}

const sample = async (): Promise<Snap> => {
    const r: any = await harness().call("mssStreams").sleep(POLL_MS).run();
    const res = (r.steps ?? []).find((s: any) => s.cmd === "mssStreams")?.result;
    return { streams: res?.streams ?? [], engine: res?.engine ?? {} };
};
const appStreams = (s: Snap) => s.streams.filter(x => x.source?.kind === "app");

// ---- boot to the main menu --------------------------------------------------
const boot: any = await harness()
    .openWgb(WGB)
    .watchFrames(true)
    .tickFrames(250, { timeoutMs: 300_000 })
    .sleep(2000)
    .state(["screen"])
    .run();

const screen = (boot.steps ?? []).find((s: any) => s.cmd === "state")?.result?.screen;
const w = screen?.width ?? 0;
const h = screen?.height ?? 0;
if (!w || !h) fail(`no screen geometry after boot (state.screen = ${JSON.stringify(screen)})`);

const at = (p: { x: number; y: number }) => ({ x: Math.round(w * p.x), y: Math.round(h * p.y) });
const menu = at(NEW_GAME_MENU);
const item = at(NEW_GAME_ITEM);

await harness()
    .move(menu.x, menu.y).sleep(400).clickAt(menu.x, menu.y).sleep(2500)
    .move(item.x, item.y).sleep(400).clickAt(item.x, item.y)
    .run();

// ---- wait for the intro dialogue, however long the level load takes ---------
const deadline = Date.now() + WAIT_FOR_DIALOGUE_MS;
let snap = await sample();
while (appStreams(snap).length === 0) {
    if (Date.now() > deadline) {
        fail(`no app-backed stream appeared within ${WAIT_FOR_DIALOGUE_MS / 1000}s of starting a new `
            + `game — the run never reached the intro dialogue, so it proves nothing about servicing `
            + `(check the menu hit points and the bundle)`);
    }
    snap = await sample();
}

// ---- assert it stays serviced ----------------------------------------------
// STALLED = claims to be playing, ring empty, byte position pinned. One sample of
// that is a scheduling hiccup; three in a row is the bug — a dry ring cannot refill
// itself, and nothing else will ever move that position again.
const stalledFor = new Map<string, number>();
const lastPos = new Map<string, number>();
let sawProgress = false;

const until = Date.now() + WATCH_MS;
while (Date.now() < until) {
    for (const s of appStreams(snap)) {
        const prev = lastPos.get(s.filename);
        if (prev !== undefined && s.position !== prev) sawProgress = true;

        const dry = (s.ring?.used ?? 1) === 0;
        const frozen = prev !== undefined && s.position === prev;
        const n = s.isPlaying && dry && frozen ? (stalledFor.get(s.filename) ?? 0) + 1 : 0;
        stalledFor.set(s.filename, n);
        lastPos.set(s.filename, s.position);

        if (n >= 3) {
            fail(`app-backed stream "${s.filename}" stalled: playing, ring empty, position pinned at `
                + `${s.position} across ${n + 1} samples (~${((n + 1) * POLL_MS) / 1000}s). Nothing is `
                + `servicing it — see MSS32.installStreamServicePoints.`);
        }
    }
    snap = await sample();
}

const engine = snap.engine;

if (!sawProgress) {
    fail(`an app-backed stream existed but never advanced its position over ${WATCH_MS / 1000}s — `
        + `servicing is dead (engine=${JSON.stringify(engine)})`);
}
if ((engine.servicePoints ?? 0) === 0) {
    fail(`streams advanced but engine.servicePoints is 0 — no mss32 export ever ran the service `
        + `check, so the progress came from somewhere else and this assertion is not measuring `
        + `what it claims (engine=${JSON.stringify(engine)})`);
}
if ((engine.wanted ?? 0) === 0) {
    fail(`service points ran but never found a stream wanting data, yet a stream advanced — `
        + `the refill path is not what fed it (engine=${JSON.stringify(engine)})`);
}
if ((engine.ringBytes ?? 0) === 0) {
    fail(`no decoded bytes ever reached a ring — whatever advanced the position, it was not a `
        + `refill (engine=${JSON.stringify(engine)})`);
}
if ((engine.errors ?? 0) > 0) {
    fail(`stream engine reported ${engine.errors} error(s): ${JSON.stringify(engine)}`);
}

console.log(`OK — app-backed Miles streams stayed serviced across ${WATCH_MS / 1000}s of intro `
    + `dialogue; engine=${JSON.stringify(engine)}`);
