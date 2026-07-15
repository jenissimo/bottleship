/**
 * Sea Dogs bring-up: boot to the main menu, open Options, snapshot the screen.
 *
 * Pass the bundle location via env (absolute path is streamed off disk):
 *   WGB=<path-to>\seadogs.wgb bun tools/harness.ts run tools/examples/seadogs.harness.ts
 * Falls back to the /apps/external-wgb drop-folder convention.
 */

import { harness } from "../harness";

const wgb = process.env.WGB ?? "/apps/external-wgb/seadogs.wgb";

const result = await harness()
    .streamLogs(["SYSTEM", "DDRAW"])
    .openWgb(wgb)
    .watchFrames(true)
    .tickFrames(1000, { timeoutMs: 180000 })  // boot → main menu (covers cold worker rebuild)
    .shot({ save: "seadogs-menu" })
    .clickAt(400, 410)                        // "Options" button (guest px)
    .tickFrames(200, { timeoutMs: 60000 })
    .shot({ save: "seadogs-options" })
    .expectSurfaceNonBlack("backbuffer", 30)
    .state(["surfaces", "screen"])
    .run();

console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null }, null, 2));
