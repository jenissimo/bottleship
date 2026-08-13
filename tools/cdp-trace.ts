/**
 * cdp-trace.ts — capture a Chrome performance trace at the BROWSER level (via the
 * CDP Tracing domain) and write it as a .json.gz consumable by analyze-trace.ts.
 *
 * Unlike the harness perf verbs, this needs NO worker RPC cooperation — it works
 * even when the worker message pump is starved (long synchronous guest-load
 * bursts, livelocks), which is precisely when the in-worker profiler can't answer.
 *
 * The capture itself is cdp-core's `captureTrace`: one implementation, so this entry point
 * cannot drift back into the two shapes that make a long trace fatal — `push(...batch)`
 * (a RangeError inside the event callback, losing the recording) and a whole-document
 * JSON.stringify + gzipSync, which holds the event array, a multi-hundred-MB string and the
 * compressed buffer at once.
 *
 * Usage:
 *   bun tools/cdp-trace.ts [seconds] [out.json.gz]
 * Then:
 *   bun tools/analyze-trace.ts <out.json.gz> --thread worker
 */

import { captureTrace } from "./cdp-core";

const seconds = Number(process.argv[2] ?? 8);
const outPath = process.argv[3] ?? "logs/harness/cdp-trace.json.gz";

console.log(`[cdp-trace] starting trace for ${seconds}s…`);
const r = await captureTrace(outPath, seconds, {
    categories: [
        "devtools.timeline",
        "v8",
        "v8.execute",
        "disabled-by-default-v8.cpu_profiler",
        "toplevel",
        "blink.user_timing",
    ],
});
console.log(`[cdp-trace] ${r.events} events -> ${r.file} (${(r.bytes / 1e6).toFixed(1)} MB gzipped)`);
process.exit(0);
