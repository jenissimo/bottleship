/**
 * Interleaved A/B of the D3D8 Lock readback kill switches, in ONE session.
 *
 * Two runs of the same scene minutes apart are not an A/B — the title's own state moves.
 * Repeats are interleaved (A B A B) so a drift in the scene shows up as spread WITHIN a
 * variant rather than as a difference BETWEEN them.
 *
 *   bun tools/harness.ts run tools/harness/regression/d3d8-lock-ab.harness.ts
 *   FRAMES=240 REPEATS=2 …
 *
 * Prints, per variant, the frame tail and the two rows that separate a hidden readback
 * from a merely relocated one: `memoHits` (the Lock never entered syncToCPU at all) and
 * `awaitedInflight` (it did, and blocked).
 */
import { harness } from "../../harness";

const FRAMES = Number(process.env["FRAMES"] ?? 240);
const REPEATS = Number(process.env["REPEATS"] ?? 2);

/** The prefetch is opt-in, so the A/B toggles the opt-in rather than a kill switch. */
const PREFETCH_ON = "__d3d8LockPrefetch";

interface Sample { p50: number; p95: number; p99: number; lockMsPerFrame: number; memoHits: number; awaited: number; roundTrips: number; frames: number }

const step = (r: any, cmd: string): any => r.steps?.filter((s: any) => s.cmd === cmd).pop()?.result;

const measure = async (prefetchOff: boolean): Promise<Sample> => {
    const r: any = await harness()
        .call("setWorkerFlag", PREFETCH_ON, !prefetchOff)
        .call("lockCost", { enable: true, reset: true })
        .call("readbackStats", { reset: true })
        .call("readbackPrefetch", { reset: true })
        .call("frameReport", { reset: true })
        .tickFrames(FRAMES)
        .call("readbackStats", {})
        .call("readbackPrefetch", {})
        .call("lockCost", {})
        .call("frameReport", {})
        .run();
    const tail = step(r, "frameReport")?.tail ?? {};
    const rb = step(r, "readbackStats") ?? {};
    const pf = step(r, "readbackPrefetch") ?? {};
    const lc = step(r, "lockCost") ?? {};
    const read = (lc.classes ?? []).find((c: any) => c.class === "read") ?? { measuredMs: 0 };
    const frames = tail.sampleCount ?? 0;
    return {
        p50: tail.p50Ms ?? NaN, p95: tail.p95Ms ?? NaN, p99: tail.p99Ms ?? NaN,
        lockMsPerFrame: frames > 0 ? read.measuredMs / frames : NaN,
        memoHits: rb.memoHits ?? 0, awaited: pf.awaitedInflight ?? 0,
        roundTrips: rb.roundTrips ?? 0, frames,
    };
};

const on: Sample[] = [];
const off: Sample[] = [];
for (let i = 0; i < REPEATS; i++) {
    off.push(await measure(true));   // OLD behaviour: no prefetch
    on.push(await measure(false));   // NEW behaviour: prefetch kicked
}

const show = (label: string, xs: Sample[]): void => {
    const med = (f: (s: Sample) => number): string => {
        const v = xs.map(f).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)]!.toFixed(2) : "n/a";
    };
    console.log(`  ${label.padEnd(22)} p50=${med((s) => s.p50)}ms p95=${med((s) => s.p95)}ms p99=${med((s) => s.p99)}ms ` +
        `lock=${med((s) => s.lockMsPerFrame)}ms/frame roundTrips=${med((s) => s.roundTrips)} ` +
        `memoHits=${med((s) => s.memoHits)} awaitedInflight=${med((s) => s.awaited)}`);
    console.log(`      raw p50: ${xs.map((s) => s.p50).join(", ")}`);
};

console.log(`[d3d8-lock-ab] ${REPEATS} interleaved repeats of ${FRAMES} frames`);
show("prefetch OFF (old)", off);
show("prefetch ON (new)", on);
console.log(`[d3d8-lock-ab] memoHits is the row that says a readback was HIDDEN; awaitedInflight says it was only moved.`);

// Leave the guest in the default (opt-in off) state, not whatever the last variant set.
await harness().call("setWorkerFlag", PREFETCH_ON, false).run();
