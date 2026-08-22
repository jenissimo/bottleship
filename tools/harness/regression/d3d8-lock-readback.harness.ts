/**
 * Price the D3D8 LockRect readback on whatever title is currently loaded.
 *
 * A rate is only a rate over a KNOWN window, so every counter is reset and read inside one
 * chained run — reading them from separate CLI invocations measures an unknown window and
 * reports a plausible number for it.
 *
 *   bun tools/harness.ts run tools/harness/regression/d3d8-lock-readback.harness.ts
 *   FRAMES=300 …                 longer window
 *   FLAG=__noD3D8LockPrefetch …  measure with a kill switch set, for an A/B
 *
 * Reads together, because either alone misleads:
 *   d3d8LockStats     who locked, and how much of the surface they actually named
 *   readbackStats     how many GPU round trips those locks cost
 *   readbackPrefetch  how many were started early, and how many Locks still blocked
 *   lockCost          where the time inside a Lock went
 */
import { harness } from "../../harness";

const FRAMES = Number(process.env["FRAMES"] ?? 240);
const FLAG = process.env["FLAG"] ?? "";

const step = (r: any, cmd: string): any =>
    r.steps?.filter((s: any) => s.cmd === cmd).pop()?.result;

let h = harness();
if (FLAG) h = h.call("setWorkerFlag", FLAG, true) as any;
const r: any = await h
    .call("lockCost", { enable: true, reset: true })
    .call("d3d8LockStats", { reset: true })
    .call("readbackStats", { reset: true })
    .call("readbackPrefetch", { reset: true })
    .call("frameReport", { reset: true })
    .tickFrames(FRAMES)
    .call("d3d8LockStats", {})
    .call("readbackStats", {})
    .call("readbackPrefetch", {})
    .call("lockCost", {})
    .call("frameReport", {})
    .run();

const locks = step(r, "d3d8LockStats");
const rb = step(r, "readbackStats");
const pf = step(r, "readbackPrefetch");
const lc = step(r, "lockCost");
const fr = step(r, "frameReport");

const tail = fr?.tail ?? {};
const frames = tail.sampleCount ?? 0;
const per = (n: number): string => (frames > 0 ? (n / frames).toFixed(2) : "n/a");

console.log(`[d3d8-readback] flag=${FLAG || "(none)"} frames=${frames} window=${tail.windowMs ?? "?"}ms`);
console.log(`  frame     p50=${tail.p50Ms ?? "n/a"}ms p95=${tail.p95Ms ?? "n/a"}ms p99=${tail.p99Ms ?? "n/a"}ms max=${tail.maxMs ?? "n/a"}ms`);

if (!locks || locks.locks === 0) {
    console.log(`  locks     NONE — either the title is not on the D3D8 lock path, or the census is not wired.`);
} else {
    console.log(`  locks     ${locks.locks} (${per(locks.locks)}/frame), renderSurface=${locks.renderSurfaceLocks} readOnly-scopable=${locks.scopableLocks}`);
    console.log(`  rects     partial=${locks.partialRectLocks} requestedFraction=${locks.requestedFraction} ` +
        `— scoping the download can save at most ${(100 * (1 - (locks.requestedFraction ?? 1))).toFixed(1)}%`);
    console.log(`  discard   requested=${locks.discardRequested} stripped=${locks.discardStripped} invalidCombos=${locks.invalidCombos}`);
}

if (rb) {
    console.log(`  roundtrip ${rb.roundTrips} (${per(rb.roundTrips)}/frame) full=${rb.fullRoundTrips} partial=${rb.partialRoundTrips}`);
    console.log(`  hidden    startedByLock=${rb.roundTripsStartedByLock} fromPrefetch=${rb.callsFromPrefetch} ` +
        `awaitedInflight=${pf?.awaitedInflight ?? "n/a"} memoHits=${rb.memoHits} scratchHits=${rb.scratchHits} redundant=${rb.redundant}`);
    console.log(`  pixels    downloaded=${(rb.pixelsDownloaded / 1e6).toFixed(1)}Mpx avoided=${(rb.pixelsAvoided / 1e6).toFixed(1)}Mpx`);
}

for (const c of lc?.classes ?? []) {
    if (!c.locks && !c.unlocks) continue;
    console.log(`  lockCost  class=${c.class} locks=${c.locks} unlocks=${c.unlocks} ` +
        `total=${c.measuredMs?.toFixed?.(1)}ms (${frames > 0 ? (c.measuredMs / frames).toFixed(2) : "n/a"}ms/frame) perCall=${c.perCallUs?.toFixed?.(0)}us`);
    for (const p of c.phases ?? []) {
        if (!p.calls) continue;
        console.log(`              ${String(p.phase).padEnd(9)} calls=${String(p.calls).padEnd(6)} perCall=${p.perCallUs?.toFixed?.(1)}us`);
    }
}

// The one row that says the whole story: a readback the guest WAITED for is the cost;
// a readback started early and finished before the Lock is not.
if (rb && frames > 0) {
    const onPath = rb.roundTripsStartedByLock + (pf?.awaitedInflight ?? 0);
    console.log(`[d3d8-readback] round trips ON the Lock critical path: ${onPath} (${(onPath / frames).toFixed(2)}/frame)`);
}
