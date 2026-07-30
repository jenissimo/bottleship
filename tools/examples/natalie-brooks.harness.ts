/**
 * Natalie Brooks: Secrets of Treasure House — boot + new-game regression script.
 *
 *   WGB=g:/WGB/running/NatalieBrooksSTH-nofpu.wgb \
 *   bun tools/harness.ts run tools/examples/natalie-brooks.harness.ts
 *
 * Doubles as the phase stopwatch for load-time work: it ticks SMALL frame batches
 * and prints the cost of each, so a loading phase (a few fps) separates itself from
 * an interactive one (~60 fps) without any extra instrumentation. A Chrome trace
 * mis-reads these stalls as mostly "idle" — that is JIT-boundary sampling noise, not
 * slack; use `.eipProfile()` when you need to know WHERE the guest is burning CPU.
 *
 * The menu button needs a HELD click: a bare `clickAt` (80 ms) is shorter than this
 * UI's own sampling tick and is dropped.
 */

import { harness } from "../harness";

const WGB = process.env.WGB ?? "g:/WGB/running/NatalieBrooksSTH-nofpu.wgb";
const BATCH = 30;
const MENU_BATCHES = 45;   // splash is a ~12 s timed logo at full frame rate
const LOAD_BATCHES = 30;
const NEW_GAME = { x: 215, y: 322 };

const c = harness()
    .openWgb(WGB)
    .watchFrames(true)
    .tickFrames(1, { timeoutMs: 300_000 });
for (let i = 0; i < MENU_BATCHES; i++) c.tickFrames(BATCH, { timeoutMs: 300_000 });
c.shot({ save: "natalie-menu.png" })
    .move(NEW_GAME.x, NEW_GAME.y)
    .tickFrames(BATCH)
    .clickHold(NEW_GAME.x, NEW_GAME.y, 300);
for (let i = 0; i < LOAD_BATCHES; i++) c.tickFrames(BATCH, { timeoutMs: 300_000 });
c.expectSurfaceNonBlack("primary")
    .shot({ save: "natalie-scene.png" })
    .state(["surfaces", "threads"]);

const r = await c.run();

let t = 0, clickAt = 0, bootStall = 0, loadStall = 0, afterClick = false;
for (const s of r.steps) {
    if (s.cmd === "clickHold") { clickAt = t; afterClick = true; continue; }
    if (s.cmd !== "tickFrames") continue;
    t += s.ms;
    if (s.ms < 700) continue;                     // a normal 30-frame batch is ~490 ms
    console.log(`  stall ${Math.round(s.ms)}ms at ${(t / 1000).toFixed(1)}s (${(BATCH / (s.ms / 1000)).toFixed(1)} fps)`);
    if (afterClick) loadStall += s.ms; else bootStall += s.ms;
}
console.log(`ok=${r.ok}  bootToSplash=${Math.round(bootStall)}ms  ` +
    `menuReachedBy=${(clickAt / 1000).toFixed(1)}s  newGameLoad=${Math.round(loadStall)}ms`);
if (!r.ok) console.log(JSON.stringify(r.error));
