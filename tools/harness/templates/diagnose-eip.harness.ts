/**
 * Worked example — a harness script: "where does the guest first touch D3D,
 * and what's the CPU doing?".
 *
 * Demonstrates API breakpoints (no JIT-off — preferred for bring-up), a
 * worker-evaluated waitUntil predicate over guest memory, and a fault-grade
 * state snapshot. Run after `bun tools/harness.ts up`:
 *   bun tools/harness.ts run tools/harness/templates/diagnose-eip.harness.ts
 */

import { harness } from "../../harness";

const result = await harness()
    .openWgb("some-d3d-game")
    // Break the first time the guest calls any d3d9 export — resolves on hit with
    // {hit:{name,eip,eipSym,args,caller,threadId}}. JIT stays ON.
    .breakOnApi("d3d9.*", { /* continuous:false → resolve on first hit */ })
    // Spin-loop game with no event? Evaluate a predicate inside the worker:
    .waitUntil(() => read32(0x6b7bf8) === 0, { timeoutMs: 20000 })
    .state(["cpu", "threads", "modules"])
    .run();

console.log(JSON.stringify(result, null, 2));
