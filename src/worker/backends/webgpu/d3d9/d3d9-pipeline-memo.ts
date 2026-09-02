/**
 * Flags + differential-oracle counters for the programmable-pipeline prologue memo.
 *
 * A leaf module on purpose: the harness verb and D3D9Device both need these, and
 * d3d9-device.ts is not importable from a harness command without dragging the whole
 * backend graph in.
 *
 * WHAT THE MEMO CLAIMS. resolveProgrammablePipeline already ends in a numeric
 * "last-resolve" compare that reuses the previous draw's pipeline id. That compare is
 * gated behind ~25 derived values (raster support, sampler support, shader lookups,
 * bound-bank masks, sampler key, stream hash, state-key fragments), which is where its
 * ~2 us/call goes. The prologue memo asserts one thing: given the same explicit
 * arguments, the same bound shader/declaration/FVF/stream identity, and no movement in
 * the four generations those derived values are functions of, that compare WOULD have
 * succeeded — so the derived values need not be recomputed to find out.
 *
 * The memo does NOT skip the tail. It runs the same reuse tail the last-resolve hit
 * runs (arena record, counters, noteProgrammableDraw), from one shared definition, so
 * the side effects cannot drift from the path being reproduced.
 *
 * The oracle (`__d3d9PipelineMemoVerify`) runs the FULL prologue on every call the memo
 * would have short-circuited and checks that the last-resolve compare really did
 * succeed and that no earlier bail fired. Because both paths end in the same tail, that
 * predicate is the whole claim — verifying it verifies the side effects too.
 */

interface PipelineMemoFlags {
    /** Take the prologue shortcut (default on; explicit false is the A/B kill switch). */
    __d3d9PipelineMemo?: boolean;
    /** Run the full prologue anyway and check the memo's prediction (default off). */
    __d3d9PipelineMemoVerify?: boolean;
    /** Accumulate per-stage timings for the guard and the reuse tail (default off). */
    __d3d9PipelineMemoProfile?: boolean;
    /** Existing A/B that forces every per-draw key fragment to be rebuilt. */
    __noD3D9KeyMemo?: boolean;
}
const flags = globalThis as PipelineMemoFlags;

/** Live-read: an A/B switches storage mid-run without a reboot. `__noD3D9KeyMemo`
 *  disables the memo outright — that flag exists to make the derived-key memos
 *  recompute, and a memo that skips them would silently defeat it. */
export function pipelineMemoEnabled(): boolean {
    return flags.__d3d9PipelineMemo !== false && !flags.__noD3D9KeyMemo;
}

export function pipelineMemoVerifying(): boolean {
    return !!flags.__d3d9PipelineMemoVerify && !flags.__noD3D9KeyMemo;
}

export function pipelineMemoProfiling(): boolean {
    return !!flags.__d3d9PipelineMemoProfile;
}

let hits = 0;
let checked = 0;
let mismatch = 0;
let firstMismatch: string | null = null;

export function notePipelineMemoHit(): void { hits++; }

/** Oracle: the memo predicted a reuse and the full prologue agreed. */
export function notePipelineMemoAgree(): void { checked++; }

/** Oracle: the memo predicted a reuse the full prologue would NOT have taken. */
export function notePipelineMemoMismatch(reason: string): void {
    checked++;
    mismatch++;
    if (firstMismatch === null) firstMismatch = reason;
}

// ── Stage profile ────────────────────────────────────────────────────────────────────
//
// performance.now() is clamped (5 us in a cross-origin-isolated worker), so a single call's
// delta is noise; only the SUM over hundreds of thousands of calls means anything, and even
// that has to be read against the instrument's own floor. `clockUs` is that floor, measured
// the same way from two adjacent clock reads — a bucket at or below it is not a measurement.
export const PROF_GUARD = 0, PROF_HASH = 1, PROF_TAIL = 2, PROF_HIT = 3, PROF_CLOCK = 4,
    PROF_NOTE = 5;
const profMs = [0, 0, 0, 0, 0, 0];
const profN = [0, 0, 0, 0, 0, 0];

export function notePipelineMemoProf(bucket: number, ms: number): void {
    profMs[bucket]! += ms;
    profN[bucket]! += 1;
}

/**
 * Where a memo HIT spends its time. `guard` is the match test, `hash` the marginal cost of one
 * extra `streamHash` (the suspected hot part of it), `tail` the shared reuse work a hit and a
 * last-resolve hit both perform, `hit` the whole call. tail is NOT guard overhead: it is the
 * work being reproduced, and it is the floor under any memo.
 */
export function d3d9PipelineMemoProfileStats(reset = false): {
    on: boolean;
    calls: number;
    guardUs: number | null;
    hashUs: number | null;
    tailUs: number | null;
    noteDrawUs: number | null;
    hitUs: number | null;
    clockUs: number | null;
    verdict: string;
} {
    const us = (i: number): number | null => (profN[i]! > 0 ? (profMs[i]! * 1000) / profN[i]! : null);
    const guardUs = us(PROF_GUARD);
    const clockUs = us(PROF_CLOCK);
    const out = {
        on: pipelineMemoProfiling(),
        calls: profN[PROF_HIT]!,
        guardUs,
        hashUs: us(PROF_HASH),
        tailUs: us(PROF_TAIL),
        // Inside the tail: the per-draw shader-attribution bookkeeping, which builds two
        // template-literal map keys on every programmable draw.
        noteDrawUs: us(PROF_NOTE),
        hitUs: us(PROF_HIT),
        clockUs,
        verdict: profN[PROF_GUARD] === 0
            ? "profile did not run"
            : (guardUs !== null && clockUs !== null && guardUs <= 2 * clockUs
                ? "guard is at the clock floor — do not size a fix off it"
                : "measured"),
    };
    if (reset) { for (let i = 0; i < profMs.length; i++) { profMs[i] = 0; profN[i] = 0; } }
    return out;
}

/**
 * `checked: 0` means the oracle never ran — not that it passed. A run is evidence only
 * when `checked` is large AND `mismatch` is 0.
 */
export function d3d9PipelineMemoStats(reset = false): {
    on: boolean;
    verify: boolean;
    hits: number;
    checked: number;
    mismatch: number;
    firstMismatch: string | null;
    verdict: string;
} {
    const out = {
        on: pipelineMemoEnabled(),
        verify: pipelineMemoVerifying(),
        hits,
        checked,
        mismatch,
        firstMismatch,
        verdict: checked === 0
            ? "oracle did not run"
            : (mismatch === 0 ? "agree" : "DISAGREE"),
    };
    if (reset) { hits = 0; checked = 0; mismatch = 0; firstMismatch = null; }
    return out;
}
