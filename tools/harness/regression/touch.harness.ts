/**
 * Template touch/mobile script — the P3 acceptance shape from docs/mobile-touch-plan.md.
 *
 * Prereqs: `bun tools/harness.ts up`. Then:
 *   WGB=/apps/<bundle>.wgb bun tools/harness.ts run tools/harness/regression/touch.harness.ts
 *
 * `device` + the gesture verbs execute CLI-side over CDP (Emulation.* /
 * Input.dispatchTouchEvent) and splice back into the same ordered result as the
 * page steps — so keep them in ONE chain: the emulation override belongs to the CDP
 * session, and a separate CLI invocation reconnects without it.
 *
 * All coordinates are GUEST pixels (same space as clickAt / gridShot labels).
 */

import { harness } from "../../harness";

const result = await harness()
    .device("phone-landscape")                       // 844x390 dpr3, maxTouchPoints 5
    .openWgb(process.env.WGB ?? "/apps/overboard-demo.wgb")
    .waitForEvent("dialogShow", { timeoutMs: 60_000 })
    .tickFrames(60)
    .wmTrace("start")
    .tap(320, 240)                                   // finger down/up on the guest surface
    .sleep(400)
    .longPress(320, 240, 600)                        // → RMB once the recognizer lands
    .sleep(400)
    .touchDrag(200, 200, 400, 300, 250)              // interpolated motion trail
    .wmTrace("read")
    .state(["screen"])
    .device("desktop")                               // clear the override for the next run
    .run();

console.log(JSON.stringify(result, null, 2));
