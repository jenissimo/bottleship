/**
 * Frame-time DISTRIBUTION over a resettable window — the tail, measured against the
 * title's own cadence.
 *
 * Mean fps answers the wrong question: a 2002 title that targets 30 fps gains nothing from
 * 60, while one 300ms hitch inside an otherwise-30fps session both feels broken and can
 * break the guest (a state machine handed a multi-second dt). So this keeps a fixed-bucket
 * histogram plus exact count/sum/min/max, and reports p50/p95/p99 RELATIVE TO A BUDGET that
 * is either given or derived from the observed cadence — never a hardcoded 16.7.
 *
 * O(1) and allocation-free per frame (`record` touches an Int32Array and 5 scalars): it runs
 * on the same worker thread as the guest CPU, so a growing array + sort per frame would make
 * the instrument part of what it measures.
 *
 * FAILING LOUDLY IS PART OF THE CONTRACT. `report()` returns a discriminated union: the
 * percentile fields exist ONLY on the `ok: true` shape, so no code path can print a p99 for
 * a window that was not measured. It demands the caller's arming state as a required
 * argument, and it refuses a percentile whose defining rank is not backed by an observation
 * (p99 needs >= 100 samples) instead of interpolating confidently. Two silent
 * window-invalidations that the profiler used to swallow are surfaced as states of their own:
 * a disarm mid-window, and the renderer-source switch that wipes the window from inside
 * markFrame.
 */

/** Three linear tiers: fine where cadences live, coarse where hitches live, then overflow.
 *  Piecewise-linear (not log) so the index is a divide and a truncate. */
const TIER_A_WIDTH = 0.25;
const TIER_A_N = 256;                                     // [0, 64)
const TIER_B_LO = TIER_A_WIDTH * TIER_A_N;                // 64
const TIER_B_WIDTH = 2;
const TIER_B_N = 128;                                     // [64, 320)
const TIER_C_LO = TIER_B_LO + TIER_B_WIDTH * TIER_B_N;    // 320
const TIER_C_WIDTH = 16;
const TIER_C_N = 128;                                     // [320, 2368)
const OVERFLOW_LO = TIER_C_LO + TIER_C_WIDTH * TIER_C_N;  // 2368

export const FRAME_BUCKET_COUNT = TIER_A_N + TIER_B_N + TIER_C_N + 1;
const OVERFLOW_INDEX = FRAME_BUCKET_COUNT - 1;

/** Bucket owning `ms`, half-open [lo, hi). Anything at/above OVERFLOW_LO lands in the last. */
export function frameBucketIndex(ms: number): number {
    if (!(ms > 0)) return 0;
    if (ms < TIER_B_LO) return (ms / TIER_A_WIDTH) | 0;
    if (ms < TIER_C_LO) return TIER_A_N + (((ms - TIER_B_LO) / TIER_B_WIDTH) | 0);
    if (ms < OVERFLOW_LO) return TIER_A_N + TIER_B_N + (((ms - TIER_C_LO) / TIER_C_WIDTH) | 0);
    return OVERFLOW_INDEX;
}

export function frameBucketLo(index: number): number {
    if (index < TIER_A_N) return index * TIER_A_WIDTH;
    if (index < TIER_A_N + TIER_B_N) return TIER_B_LO + (index - TIER_A_N) * TIER_B_WIDTH;
    if (index < OVERFLOW_INDEX) return TIER_C_LO + (index - TIER_A_N - TIER_B_N) * TIER_C_WIDTH;
    return OVERFLOW_LO;
}

export function frameBucketHi(index: number): number {
    if (index >= OVERFLOW_INDEX) return Infinity;
    return frameBucketLo(index + 1);
}

/** Percentiles we publish, with the sample count their defining rank needs to be a real
 *  observation (n * (1 - p) >= 1). Below it we say so rather than interpolate. */
const PERCENTILES = [
    { tag: "p50", p: 0.5, minSamples: 2 },
    { tag: "p95", p: 0.95, minSamples: 20 },
    { tag: "p99", p: 0.99, minSamples: 100 },
] as const;

export type FrameTailInvalidStatus =
    | "disabled"                  // profiler not armed — there is no window at all
    | "no-samples"                // armed, but nothing was recorded yet
    | "disarmed-mid-window"       // samples were dropped by a setEnabled(false)
    | "source-switched-mid-window"; // markFrame wiped the window on a DDraw<->D3D switch

export type FrameTailInvalid = {
    ok: false;
    status: FrameTailInvalidStatus;
    note: string;
    sampleCount: number;
    interruptions: { disarms: number; sourceSwitches: number };
};

export type FrameBudgetReport = {
    ms: number;
    /** `explicit` = caller's number; `derived-p50-bucket` = top of the median-interval
     *  bucket, i.e. the cadence the title actually sustained in this window. */
    source: "explicit" | "derived-p50-bucket";
    overFrames: number;
    overPct: number;
    /** Frames in the bucket the budget falls inside — neither over nor under can be decided
     *  for them. 0 for a derived budget (it is a bucket boundary by construction). */
    straddleFrames: number;
    /** Frames worse than twice the budget: the ones a player reads as a hitch. */
    over2xFrames: number;
    /** Bucket-quantized sum of (frameMs - budget) over the over-budget frames. */
    excessMsApprox: number;
    /** p99 / budget — "how bad is the tail in units of the title's own frame". */
    p99OverBudget: number | null;
};

export type FrameTailReport = {
    ok: true;
    status: "ok";
    sampleCount: number;
    /** Wall time spanned by the window (first→last recorded frame). */
    windowMs: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
    /** Percentiles are UPPER BOUNDS: "at least P% of frames were <= this", tightened to the
     *  observed max. `resolutionMs` is the width of the bucket each came from. */
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    resolutionMs: { p50: number | null; p95: number | null; p99: number | null };
    /** Why a percentile is null, in words. Empty when all are available. */
    unavailable: string[];
    budget: FrameBudgetReport | null;
    budgetNote?: string;
    buckets: Array<{ loMs: number; hiMs: number; count: number }>;
    /** Present only when `buckets` is a truncated view, so nobody reads the rows as a
     *  contiguous histogram when quiet buckets between them were dropped. */
    bucketsNote?: string;
};

export type FrameTail = FrameTailInvalid | FrameTailReport;

/** The arming fact the report needs. Required, so a caller cannot forget to pass it and
 *  accidentally publish percentiles for a disabled profiler. */
export type FrameTailQuery = {
    armed: boolean;
    budgetMs?: number;
    /** Cap on returned histogram rows (non-empty buckets, widest counts kept in order). */
    maxBuckets?: number;
};

export class FrameTimeDistribution {
    private readonly counts = new Int32Array(FRAME_BUCKET_COUNT);
    private n = 0;
    private sumMs = 0;
    private minMs = Infinity;
    private maxMs = 0;
    private firstTs = 0;
    private lastTs = 0;

    // Window-invalidation bookkeeping. Deliberately NOT cleared by clearSamples(): the whole
    // point is that a window which lost samples cannot report as if it had not.
    private disarms = 0;
    private sourceSwitches = 0;
    private lastSwitchNote = "";

    /** One frame interval. Hot path: no allocation, no branch on enablement (the caller's
     *  markFrame is already gated). */
    record(frameMs: number, timestamp: number): void {
        this.counts[frameBucketIndex(frameMs)]++;
        this.n++;
        this.sumMs += frameMs;
        if (frameMs < this.minMs) this.minMs = frameMs;
        if (frameMs > this.maxMs) this.maxMs = frameMs;
        if (this.firstTs === 0) this.firstTs = timestamp - frameMs;
        this.lastTs = timestamp;
    }

    /** A new window: samples AND the invalidation flags. This is the only thing that clears
     *  an interruption, so "arm + reset" is the incantation that makes a window trustworthy. */
    resetWindow(): void {
        this.clearSamples();
        this.disarms = 0;
        this.sourceSwitches = 0;
        this.lastSwitchNote = "";
    }

    private clearSamples(): void {
        this.counts.fill(0);
        this.n = 0;
        this.sumMs = 0;
        this.minMs = Infinity;
        this.maxMs = 0;
        this.firstTs = 0;
        this.lastTs = 0;
    }

    /**
     * The profiler was disarmed. Only counts as an interruption if a window was in progress
     * (`hadSamples`) — a boot-time or after-the-read disarm must not poison the next
     * measurement. Call AFTER the owner's reset(), passing the pre-reset sample count, since
     * resetWindow() is what clears an interruption.
     */
    noteDisarm(hadSamples: boolean): void {
        if (hadSamples) this.disarms++;
        this.clearSamples();
    }

    /** markFrame observed a renderer-source change and wiped the window. Same rule and same
     *  ordering requirement as noteDisarm. */
    noteSourceSwitch(from: string | null, to: string, hadSamples: boolean): void {
        if (hadSamples) {
            this.sourceSwitches++;
            this.lastSwitchNote = `${from ?? "?"} -> ${to}`;
        }
        this.clearSamples();
    }

    sampleCount(): number {
        return this.n;
    }

    report(q: FrameTailQuery): FrameTail {
        const interruptions = { disarms: this.disarms, sourceSwitches: this.sourceSwitches };
        if (!q.armed) {
            return {
                ok: false, status: "disabled", sampleCount: this.n, interruptions,
                note: "frame profiler is not armed — no window exists. perfProfile({enable:true,reset:true}) first.",
            };
        }
        if (this.disarms > 0) {
            return {
                ok: false, status: "disarmed-mid-window", sampleCount: this.n, interruptions,
                note: `profiler was disarmed ${this.disarms}x since the window began; those frames are gone. `
                    + "Re-scope with perfProfile({enable:true,reset:true}) before reading a tail.",
            };
        }
        if (this.sourceSwitches > 0) {
            return {
                ok: false, status: "source-switched-mid-window", sampleCount: this.n, interruptions,
                note: `markFrame reset the window on a renderer-source switch (${this.lastSwitchNote}); `
                    + "the samples before it were discarded. Re-scope after the title settles on one presenter.",
            };
        }
        if (this.n === 0) {
            return {
                ok: false, status: "no-samples", sampleCount: 0, interruptions,
                note: "armed but no frames recorded — the title may not be presenting (check flipCadence/present path).",
            };
        }

        const unavailable: string[] = [];
        const pctIndex: Record<string, number | null> = {};
        for (const { tag, p, minSamples } of PERCENTILES) {
            if (this.n < minSamples) {
                pctIndex[tag] = null;
                unavailable.push(`${tag}: needs >= ${minSamples} samples for its rank to be an observation, have ${this.n}`);
            } else {
                pctIndex[tag] = this.bucketAtRank(Math.max(1, Math.ceil(p * this.n)));
            }
        }
        const bound = (i: number | null) => (i === null ? null : Math.min(frameBucketHi(i), this.maxMs));
        const width = (i: number | null) => (i === null ? null : Math.min(frameBucketHi(i), this.maxMs) - frameBucketLo(i));

        const p50i = pctIndex["p50"], p95i = pctIndex["p95"], p99i = pctIndex["p99"];
        const p50Ms = bound(p50i), p95Ms = bound(p95i), p99Ms = bound(p99i);

        let budget: FrameBudgetReport | null = null;
        let budgetNote: string | undefined;
        if (q.budgetMs !== undefined && q.budgetMs > 0) {
            budget = this.buildBudget(q.budgetMs, "explicit", p99Ms);
        } else if (p50i !== null) {
            // Top of the median bucket: a bucket boundary, so nothing straddles it.
            budget = this.buildBudget(frameBucketHi(p50i), "derived-p50-bucket", p99Ms);
            budgetNote = "budget derived from the observed cadence (top of the median-interval bucket), not a hardcoded target";
        } else {
            budgetNote = "no budget: none given and the window is too small to derive a cadence (needs >= 2 samples)";
        }

        return {
            ok: true, status: "ok",
            sampleCount: this.n,
            windowMs: round2(this.lastTs > this.firstTs ? this.lastTs - this.firstTs : 0),
            meanMs: round2(this.sumMs / this.n),
            minMs: round2(this.minMs),
            maxMs: round2(this.maxMs),
            p50Ms: round2n(p50Ms), p95Ms: round2n(p95Ms), p99Ms: round2n(p99Ms),
            resolutionMs: { p50: round2n(width(p50i)), p95: round2n(width(p95i)), p99: round2n(width(p99i)) },
            unavailable,
            budget,
            ...(budgetNote ? { budgetNote } : {}),
            ...this.bucketView(q.maxBuckets ?? 24),
        };
    }

    /** 1-based nearest-rank lookup: the bucket holding the k-th smallest sample. */
    private bucketAtRank(k: number): number {
        let cum = 0;
        for (let i = 0; i < FRAME_BUCKET_COUNT; i++) {
            cum += this.counts[i];
            if (cum >= k) return i;
        }
        return OVERFLOW_INDEX;
    }

    /** Frames strictly above `ms`, plus the ones in the bucket `ms` falls inside (which the
     *  histogram cannot decide). Reporting the ambiguity is the point. */
    private countAbove(ms: number): { over: number; straddle: number } {
        const bi = frameBucketIndex(ms);
        // A budget ON a bucket boundary owns nothing ambiguous: [ms, hi) is entirely over.
        const onBoundary = frameBucketLo(bi) >= ms;
        let over = 0;
        for (let i = onBoundary ? bi : bi + 1; i < FRAME_BUCKET_COUNT; i++) over += this.counts[i];
        return { over, straddle: onBoundary ? 0 : this.counts[bi] };
    }

    private buildBudget(budgetMs: number, source: FrameBudgetReport["source"], p99Ms: number | null): FrameBudgetReport {
        const { over, straddle } = this.countAbove(budgetMs);
        const twice = this.countAbove(budgetMs * 2);
        let excess = 0;
        const bi = frameBucketIndex(budgetMs);
        for (let i = bi; i < FRAME_BUCKET_COUNT; i++) {
            const c = this.counts[i];
            if (c === 0) continue;
            const lo = frameBucketLo(i);
            if (lo < budgetMs) continue;                        // straddling bucket: not attributable
            const hi = Math.min(frameBucketHi(i), this.maxMs);
            excess += c * Math.max(0, (lo + hi) / 2 - budgetMs);
        }
        return {
            ms: round2(budgetMs),
            source,
            overFrames: over,
            overPct: round2((over / this.n) * 100),
            straddleFrames: straddle,
            over2xFrames: twice.over,
            excessMsApprox: round2(excess),
            p99OverBudget: p99Ms === null ? null : round2(p99Ms / budgetMs),
        };
    }

    private bucketView(max: number): { buckets: Array<{ loMs: number; hiMs: number; count: number }>; bucketsNote?: string } {
        let nonEmpty = 0;
        for (let i = 0; i < FRAME_BUCKET_COUNT; i++) if (this.counts[i] !== 0) nonEmpty++;
        const buckets = this.compactBuckets(max);
        return nonEmpty > buckets.length
            ? {
                buckets,
                bucketsNote: `TRUNCATED view: the ${buckets.length} most populated of ${nonEmpty} non-empty buckets, in time order. `
                    + "Not contiguous — quieter buckets between these rows were dropped. Raise maxBuckets for the full shape.",
            }
            : { buckets };
    }

    /** Non-empty buckets, biggest counts first, capped — the shape of the distribution
     *  without shipping 513 mostly-zero rows. */
    private compactBuckets(max: number): Array<{ loMs: number; hiMs: number; count: number }> {
        const rows: Array<{ loMs: number; hiMs: number; count: number }> = [];
        for (let i = 0; i < FRAME_BUCKET_COUNT; i++) {
            if (this.counts[i] === 0) continue;
            rows.push({ loMs: round2(frameBucketLo(i)), hiMs: frameBucketHi(i), count: this.counts[i] });
        }
        if (rows.length <= max) return rows;
        const kept = rows.slice().sort((a, b) => b.count - a.count).slice(0, max);
        kept.sort((a, b) => a.loMs - b.loMs);
        return kept;
    }
}

/**
 * Offline entry point — `tools/analyze-trace.ts` computing the same statistic from
 * `bottleship.flip` trace marks. It feeds the SAME distribution rather than re-deriving
 * percentiles from a sorted array, so a live window and a captured trace of that window can
 * only disagree because the world disagreed, never because two files rounded differently.
 *
 * Arming is implicit here: a trace either carries the boundary marks or the report says
 * `no-samples`. Timestamps are synthesized by accumulating the intervals, which is exactly
 * the span the marks describe.
 */
export function frameTailFromSamples(
    samplesMs: readonly number[],
    opts: { budgetMs?: number; maxBuckets?: number } = {},
): FrameTail {
    const d = new FrameTimeDistribution();
    let t = 0;
    for (const ms of samplesMs) {
        t += ms;
        d.record(ms, t);
    }
    return d.report({ armed: true, budgetMs: opts.budgetMs, maxBuckets: opts.maxBuckets });
}

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}
function round2n(v: number | null): number | null {
    return v === null ? null : round2(v);
}
