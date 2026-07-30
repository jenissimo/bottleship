/**
 * In-game differential gate for the PSX/VAG ADPCM inner-loop hook.
 *
 * Boots the bundle, lets audio run, and polls `dbg.hleHooks` until the hook leaves
 * 'shadowing'. 'active' with 0 mismatches means the kernel agreed with the guest's own
 * decoder on EAX and on every declared output byte for `n` consecutive calls (~1k
 * samples each); 'disabled' prints the first differing byte. The hook is only ever
 * exercised while sound is decoding, so a run that never leaves 'shadowing' means the
 * scene made no ADPCM audio — reported as NO-CALLS, not as a pass.
 *
 * Usage: WGB=<path-or-url> bun tools/harness.ts run tools/examples/psx-adpcm-validate.harness.ts
 */

import { harness } from "../harness";

interface HookStatus {
    libId: string;
    functionName: string;
    state: string;
    cleanCalls: number;
    targetCalls: number;
    guardFails: number;
    mismatches: number;
    lastMismatch?: string;
}

function grab(result: unknown, cmd: string): unknown {
    const steps = (result as { steps?: Array<{ cmd: string; result?: unknown }> }).steps ?? [];
    return steps.filter(s => s.cmd === cmd).pop()?.result;
}

const WGB = process.env.WGB ?? "g:/WGB/running/harry-potter-cos.wgb";

await harness().reload().run();
await harness()
    .streamLogs(["SYSTEM"])
    .openWgb(WGB)
    .tickFrames(120)
    .run();

const started = Date.now();
let hooks: HookStatus[] = [];
let verdict = "NO-CALLS";
while (Date.now() - started < 240_000) {
    const r = await harness()
        .tickFrames(60)
        .call("dbgCall", "hleHooks")
        .run();
    hooks = (grab(r, "dbgCall") as HookStatus[]) ?? [];
    const mine = hooks.filter(h => h.libId === "psx-adpcm");
    if (mine.length === 0) { verdict = "NOT-DETECTED"; continue; }
    if (mine.some(h => h.state === "disabled")) { verdict = "FAIL"; break; }
    if (mine.every(h => h.state === "active")) {
        verdict = mine.every(h => h.mismatches === 0) ? "PASS" : "FAIL";
        break;
    }
}

console.log(JSON.stringify({ verdict, hooks }, null, 2));
if (verdict !== "PASS") process.exitCode = 1;
