/**
 * Template bring-up script. Copy this, rename it, and
 * adapt the bundle id + the dialog/expectation steps for a fresh game.
 *
 * Prereqs: `bun tools/harness.ts up` (launches/attaches Chrome with the autoplay
 * flag, opens ?game=dev, arms log streaming). Then:
 *   bun tools/harness.ts run tools/harness/templates/bringup.harness.ts
 *
 * Every verb is sugar over harness_rpc; `.run()` ships the whole chain to the
 * page in one CDP eval and returns one POJO (also written to logs/harness/).
 */

import { harness } from "../../harness";

const result = await harness()
    .streamLogs(["SYSTEM", "DDRAW", "USER32"])     // observe the worker log stream
    .openWgb(process.env.WGB ?? "/apps/external-wgb/my-game.wgb") // abs path (env) → streamed off disk; else drop-folder URL
    .waitForEvent("dialogShow", { timeoutMs: 60000 }) // wait for the launcher dialog
    .click("Play Game")                            // faithful click by label (global coords)
    .watchFrames(true)                             // enable frameRendered events
    .tickFrames(120)                               // wait for ~120 presents after the click
    .expectSurfaceNonBlack("primary")              // assert the screen isn't black (aborts on fail)
    .state(["surfaces", "threads", "screen"])      // structured snapshot
    .run();

console.log(JSON.stringify(result, null, 2));
