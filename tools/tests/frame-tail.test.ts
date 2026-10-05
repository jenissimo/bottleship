/**
 * Frame-time tail instrument — the properties that make it trustworthy.
 *
 * The bug class this guards against is not "wrong arithmetic", it is an instrument that
 * reports a plausible number for something other than its label: a p99 over a window the
 * profiler was not armed for, a percentile interpolated from four samples, a "worst frames"
 * list that is really the last five, a budget that silently means 60 fps. Each test below
 * names the invariant it protects.
 *
 * Pure logic (FrameTimeDistribution) runs with no worker at all; the integration block drives
 * the real `frameProfiler` singleton, which imports cleanly outside the browser.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
    FrameTimeDistribution,
    FRAME_BUCKET_COUNT,
    frameBucketIndex,
    frameBucketLo,
    frameBucketHi,
    type FrameTail,
    type FrameTailReport,
} from "../../src/worker/core/frame-time-distribution";
import { frameProfiler } from "../../src/worker/core/frame-profiler";
import { SpikeClassifier, type FrameFacts } from "../../src/worker/core/frame-spike-classes";

/** Narrow to the ok shape, failing the test with the status if the window was invalid. */
function ok(t: FrameTail): FrameTailReport {
    if (!t.ok) throw new Error(`expected a valid window, got status=${t.status}: ${t.note}`);
    return t;
}

const feed = (d: FrameTimeDistribution, ms: number, n = 1) => {
    // Timestamps must advance monotonically or windowMs is meaningless; the value is
    // irrelevant to the histogram itself.
    for (let i = 0; i < n; i++) d.record(ms, 1000 + i * ms);
};

describe("frame bucket layout", () => {
    // INVARIANT: buckets tile [0, inf) with no gap and no overlap — a frame time can never
    // fall between two buckets, so a count is never silently dropped.
    test("buckets are contiguous and the last one is unbounded", () => {
        for (let i = 0; i < FRAME_BUCKET_COUNT - 1; i++) {
            expect(frameBucketHi(i)).toBe(frameBucketLo(i + 1));
            expect(frameBucketHi(i)).toBeGreaterThan(frameBucketLo(i));
        }
        expect(frameBucketHi(FRAME_BUCKET_COUNT - 1)).toBe(Infinity);
    });

    // INVARIANT: a value lands in the bucket whose half-open [lo, hi) contains it, including
    // exactly at the tier seams — the seams are where an off-by-one would quietly move the
    // 33.3ms region into the coarse tier and blur every 30fps reading.
    test("index owns [lo, hi) at every tier seam", () => {
        for (const ms of [0.01, 0.24, 0.25, 16.66, 33.33, 63.99, 64, 64.01, 65.9, 319.9, 320, 320.1, 2367.9]) {
            const i = frameBucketIndex(ms);
            expect(frameBucketLo(i)).toBeLessThanOrEqual(ms);
            expect(frameBucketHi(i)).toBeGreaterThan(ms);
        }
        expect(frameBucketIndex(64)).toBe(256);
        expect(frameBucketIndex(320)).toBe(384);
    });

    // INVARIANT: no input can index outside the fixed array. A corrupt/absurd dt (paused tab,
    // negative clock delta) must be absorbed, not written out of bounds or dropped.
    test("absurd inputs clamp into range", () => {
        for (const ms of [-1, 0, NaN, 1e9, Infinity]) {
            const i = frameBucketIndex(ms);
            expect(i).toBeGreaterThanOrEqual(0);
            expect(i).toBeLessThan(FRAME_BUCKET_COUNT);
        }
        expect(frameBucketIndex(1e9)).toBe(FRAME_BUCKET_COUNT - 1);
        expect(frameBucketIndex(2368)).toBe(FRAME_BUCKET_COUNT - 1);
    });
});

describe("percentiles refuse to be confident", () => {
    let d: FrameTimeDistribution;
    beforeEach(() => { d = new FrameTimeDistribution(); });

    // INVARIANT: no samples means no statistic of any kind — not a zero, not a null-valued
    // percentile field. The failure shape does not even carry the keys.
    test("an empty window is a state, not a number", () => {
        const t = d.report({ armed: true });
        expect(t.ok).toBe(false);
        expect((t as any).status).toBe("no-samples");
        expect("p99Ms" in t).toBe(false);
        expect("budget" in t).toBe(false);
    });

    // INVARIANT: a percentile is published only when its defining rank is an actual
    // observation (n*(1-p) >= 1). Otherwise it says why, instead of interpolating.
    test("one sample yields exact min/max/mean but no percentiles", () => {
        feed(d, 17.2);
        const r = ok(d.report({ armed: true }));
        expect(r.sampleCount).toBe(1);
        expect(r.minMs).toBeCloseTo(17.2, 2);
        expect(r.maxMs).toBeCloseTo(17.2, 2);
        expect(r.meanMs).toBeCloseTo(17.2, 2);
        expect(r.p50Ms).toBeNull();
        expect(r.p95Ms).toBeNull();
        expect(r.p99Ms).toBeNull();
        expect(r.unavailable).toHaveLength(3);
        expect(r.unavailable.join(" ")).toContain("have 1");
    });

    test("two samples yield p50 only; p95/p99 still say they cannot", () => {
        feed(d, 16.6);
        feed(d, 40);
        const r = ok(d.report({ armed: true }));
        expect(r.p50Ms).not.toBeNull();
        expect(r.p95Ms).toBeNull();
        expect(r.p99Ms).toBeNull();
        expect(r.unavailable.some((u) => u.startsWith("p99"))).toBe(true);
    });

    // INVARIANT: percentiles are UPPER BOUNDS tightened to the observed max, so an all-equal
    // window reports the value itself rather than the bucket's ceiling. Bucket quantization
    // must never inflate a reading above something that was actually measured.
    test("an all-equal window reports the observed value, not the bucket ceiling", () => {
        feed(d, 16.6, 120);
        const r = ok(d.report({ armed: true }));
        expect(r.p50Ms).toBeCloseTo(16.6, 2);
        expect(r.p99Ms).toBeCloseTo(16.6, 2);
        expect(r.maxMs).toBeCloseTo(16.6, 2);
        expect(r.resolutionMs.p99!).toBeLessThanOrEqual(0.25);
    });

    // INVARIANT: an isolated hitch belongs to max, not to p99 — reporting both is what stops
    // "p99 is fine" from hiding a 500ms stall, and "max is awful" from hiding that it was one
    // frame out of a hundred.
    test("a single outlier moves max but not p99", () => {
        feed(d, 16.6, 99);
        feed(d, 500);
        const r = ok(d.report({ armed: true }));
        expect(r.sampleCount).toBe(100);
        expect(r.p99Ms!).toBeLessThan(17);
        expect(r.maxMs).toBeCloseTo(500, 0);
        expect(r.budget!.over2xFrames).toBe(1);
    });

    // INVARIANT: p99 needs 100 samples. At 99 it is withheld even though 95 is available —
    // the threshold is per-percentile, not one global "enough samples" flag.
    test("p99 appears exactly at 100 samples", () => {
        feed(d, 16.6, 99);
        expect(ok(d.report({ armed: true })).p99Ms).toBeNull();
        expect(ok(d.report({ armed: true })).p95Ms).not.toBeNull();
        feed(d, 16.6);
        expect(ok(d.report({ armed: true })).p99Ms).not.toBeNull();
    });

    // INVARIANT: the histogram output is bounded regardless of how spread the session was —
    // the instrument cannot become the reason a report is megabytes.
    test("returned buckets are capped", () => {
        for (let i = 0; i < 400; i++) feed(d, 1 + i * 0.7);
        const r = ok(d.report({ armed: true, maxBuckets: 10 }));
        expect(r.buckets.length).toBe(10);
        // A truncated view says so — otherwise the rows read as a contiguous histogram.
        expect(r.bucketsNote).toContain("TRUNCATED");
        // Still ordered by time, so the shape reads left-to-right.
        for (let i = 1; i < r.buckets.length; i++) expect(r.buckets[i].loMs).toBeGreaterThan(r.buckets[i - 1].loMs);
    });
});

describe("budget-relative classification", () => {
    let d: FrameTimeDistribution;
    beforeEach(() => { d = new FrameTimeDistribution(); });

    // INVARIANT: "over budget" counts against the budget the caller named, and 16.7 is never
    // assumed. At a 30fps budget a steady 30fps session has zero over-budget frames even
    // though every frame is twice 16.7ms.
    test("a steady 30fps session is not over a 30fps budget", () => {
        feed(d, 32.5, 200);
        const r = ok(d.report({ armed: true, budgetMs: 33.34 }));
        expect(r.budget!.source).toBe("explicit");
        expect(r.budget!.overFrames).toBe(0);
        expect(r.budget!.overPct).toBe(0);
        expect(r.budget!.excessMsApprox).toBe(0);
    });

    test("frames over the budget are counted, with 2x tracked separately", () => {
        feed(d, 16.6, 90);
        feed(d, 40, 8);
        feed(d, 120, 2);
        const r = ok(d.report({ armed: true, budgetMs: 33.34 }));
        expect(r.budget!.overFrames).toBe(10);
        expect(r.budget!.overPct).toBeCloseTo(10, 1);
        expect(r.budget!.over2xFrames).toBe(2);            // > 66.68ms
        expect(r.budget!.excessMsApprox).toBeGreaterThan(0);
        expect(r.budget!.p99OverBudget!).toBeGreaterThan(1); // the tail misses the cadence
    });

    // INVARIANT: the DERIVED budget is a bucket boundary by construction, so it can never
    // create an ambiguous "straddling" bucket — a derived reading is exact about what it
    // classified.
    test("a derived budget never straddles a bucket", () => {
        feed(d, 16.6, 80);
        feed(d, 50, 20);
        const r = ok(d.report({ armed: true }));
        expect(r.budget!.source).toBe("derived-p50-bucket");
        expect(r.budget!.straddleFrames).toBe(0);
        expect(r.budgetNote).toContain("observed cadence");
        // The derived cadence is the median frame, not the display refresh.
        expect(r.budget!.ms).toBeGreaterThan(16.6);
        expect(r.budget!.ms).toBeLessThan(17);
        expect(r.budget!.overFrames).toBe(20);
    });

    // INVARIANT: with an explicit budget inside a populated bucket, the frames the histogram
    // cannot classify are REPORTED as straddling rather than assigned to whichever side would
    // look better.
    test("an explicit mid-bucket budget discloses the frames it cannot classify", () => {
        feed(d, 16.6, 100);
        const r = ok(d.report({ armed: true, budgetMs: 16.55 }));
        expect(r.budget!.straddleFrames).toBe(100);
        expect(r.budget!.overFrames).toBe(0);
    });

    // INVARIANT: a window too small to derive a cadence gets no budget at all, with the reason
    // stated — not a fallback constant standing in for a measurement.
    test("no budget is invented when the cadence cannot be observed", () => {
        feed(d, 20);
        const r = ok(d.report({ armed: true }));
        expect(r.budget).toBeNull();
        expect(r.budgetNote).toContain("too small");
    });
});

describe("window integrity states", () => {
    let d: FrameTimeDistribution;
    beforeEach(() => { d = new FrameTimeDistribution(); });

    // INVARIANT: no percentile can be produced for a disarmed profiler. The arming state is a
    // required argument and the failure shape has no percentile fields — it is not
    // representable, not merely guarded.
    test("armed:false is a state even when samples exist", () => {
        feed(d, 16.6, 500);
        const t = d.report({ armed: false });
        expect(t.ok).toBe(false);
        expect((t as any).status).toBe("disabled");
        expect("p99Ms" in t).toBe(false);
    });

    // INVARIANT: a window that lost samples to a disarm reports that, and keeps reporting it
    // until the caller explicitly re-scopes. Silently resuming would present a 2-second window
    // as a full session.
    test("a disarm mid-window poisons the window until an explicit reset", () => {
        feed(d, 16.6, 200);
        d.noteDisarm(true);
        feed(d, 16.6, 200);
        const t = d.report({ armed: true });
        expect(t.ok).toBe(false);
        expect((t as any).status).toBe("disarmed-mid-window");
        expect((t as any).interruptions.disarms).toBe(1);
        d.resetWindow();
        feed(d, 16.6, 200);
        expect(ok(d.report({ armed: true })).sampleCount).toBe(200);
    });

    // INVARIANT: a disarm with nothing measured yet is not an interruption. Boot-time or
    // after-the-read disarms must not cry wolf on the next measurement.
    test("a disarm with an empty window is not an interruption", () => {
        d.noteDisarm(false);
        feed(d, 16.6, 200);
        expect(ok(d.report({ armed: true })).sampleCount).toBe(200);
    });

    // INVARIANT: the renderer-source switch inside markFrame wipes the window — that wipe is
    // now visible instead of leaving a plausible tail over whatever frames came after it.
    test("a source switch mid-window is reported, with both sources named", () => {
        feed(d, 16.6, 200);
        d.noteSourceSwitch("ddraw", "d3d9", true);
        feed(d, 16.6, 50);
        const t = d.report({ armed: true });
        expect(t.ok).toBe(false);
        expect((t as any).status).toBe("source-switched-mid-window");
        expect((t as any).note).toContain("ddraw -> d3d9");
    });

    // INVARIANT: reset means reset — samples AND integrity flags — so "arm + reset" always
    // yields a window that can be trusted or a state that explains itself.
    test("resetWindow clears samples and flags together", () => {
        feed(d, 16.6, 10);
        d.noteDisarm(true);
        d.resetWindow();
        const t = d.report({ armed: true });
        expect(t.ok).toBe(false);
        expect((t as any).status).toBe("no-samples");
        expect((t as any).interruptions).toEqual({ disarms: 0, sourceSwitches: 0 });
    });
});

describe("spike coalescing into classes", () => {
    const CATS = ["thunk", "gpu", "present", "audio", "scheduler", "v86", "idle"] as const;

    /** One frame's facts. `cats` is a partial ms-by-category map; the rest is 0. */
    function frame(frameMs: number, opts: {
        cats?: Partial<Record<typeof CATS[number], number>>;
        thunks?: Record<string, { count: number; totalMs: number }>;
        switches?: number;
    } = {}): FrameFacts {
        const categoryMs = CATS.map((c) => opts.cats?.[c] ?? 0);
        return {
            frameMs,
            categoryMs,
            categoryNames: CATS,
            thunks: new Map(Object.entries(opts.thunks ?? {})),
            threadSwitchCount: opts.switches ?? 0,
        };
    }
    const rep = () => ({ tag: "rep" });
    const clf = () => new SpikeClassifier<{ tag: string }>();

    // INVARIANT: a frame at or below the threshold costs one compare and is not classified —
    // the coalescing engine must not become part of what it measures on a healthy title.
    test("frames at or below the threshold are rejected", () => {
        const c = clf();
        c.setThreshold(20);
        expect(c.ingest(frame(20), rep)).toBe(false);
        expect(c.ingest(frame(19.9), rep)).toBe(false);
        expect(c.ingest(frame(20.1), rep)).toBe(true);
        expect(c.report({ budgetMs: 20, categoryNames: CATS }).classifiedFrames).toBe(1);
    });

    // INVARIANT: ranking is by TOTAL time lost, so many small hiccups outrank one big stall.
    // This is the whole reason for coalescing instead of printing a worst-frame list.
    test("40 small hiccups outrank one large stall", () => {
        const c = clf();
        c.setThreshold(16);
        for (let i = 0; i < 40; i++) c.ingest(frame(25, { cats: { thunk: 20 }, thunks: { "ddraw:Blt": { count: 4, totalMs: 20 } } }), rep);
        c.ingest(frame(120, { cats: { v86: 110 } }), rep);
        const r = c.report({ budgetMs: 16.7, categoryNames: CATS });
        expect(r.classes).toHaveLength(2);
        expect(r.classes[0]!.count).toBe(40);
        expect(r.classes[0]!.signature).toBe("thunk | ddraw:Blt");
        expect(r.classes[0]!.totalMsLost).toBeGreaterThan(r.classes[1]!.totalMsLost);
        expect(r.classes[0]!.shareOfLostPct + r.classes[1]!.shareOfLostPct).toBeCloseTo(100, 1);
    });

    // INVARIANT: lost-ms is derived at READ time from count/sum, so the same window can be
    // re-judged at another budget without re-measuring — and each class states whether every
    // frame in it was really over that budget.
    test("the same window can be judged against two budgets", () => {
        const c = clf();
        c.setThreshold(16);
        for (let i = 0; i < 10; i++) c.ingest(frame(20, { cats: { v86: 18 } }), rep);
        const at17 = c.report({ budgetMs: 17, categoryNames: CATS });
        const at33 = c.report({ budgetMs: 33, categoryNames: CATS });
        expect(at17.totalMsLost).toBeCloseTo(30, 1);
        expect(at17.classes[0]!.exact).toBe(true);
        expect(at33.totalMsLost).toBe(0);
        expect(at33.classes[0]!.exact).toBe(false);   // 20ms frames are UNDER a 33ms budget
        expect(at33.coverageNote).toContain("exact:false");
    });

    // INVARIANT: the representative is the class's WORST frame and is built only when that
    // worst changes — a per-frame capture would allocate on every slow frame.
    test("representative tracks the class worst and is built lazily", () => {
        const c = clf();
        c.setThreshold(10);
        let built = 0;
        const factory = () => { built++; return { tag: `f${built}` }; };
        for (const ms of [20, 15, 60, 22, 18]) c.ingest(frame(ms, { cats: { v86: ms - 1 } }), factory);
        const r = c.report({ budgetMs: 16.7, categoryNames: CATS });
        expect(r.classes[0]!.worstMs).toBe(60);
        expect(r.classes[0]!.representative!.tag).toBe("f2");   // 20 then 60; 15/22/18 never won
        expect(built).toBe(2);
    });

    // INVARIANT: a blocking wait can never be named as the cause. The audio thread's
    // GetMessage park is summed cross-thread into the frame and would win every stall.
    test("park thunks are never the contributor", () => {
        const c = clf();
        c.setThreshold(10);
        c.ingest(frame(50, {
            cats: { thunk: 45 },
            thunks: {
                "user32:GetMessageA": { count: 1, totalMs: 44 },
                "ddraw:Blt": { count: 2, totalMs: 16 },
            },
        }), rep);
        expect(c.report({ budgetMs: 16.7, categoryNames: CATS }).classes[0]!.contributor).toBe("ddraw:Blt");
    });

    // INVARIANT: the shape of the stall beats the hottest name — a streaming stall is
    // "io/stream", not "ReadFile", and scheduler churn is named as churn.
    test("io volume and scheduler churn outrank a thunk name", () => {
        const io = clf(); io.setThreshold(10);
        io.ingest(frame(90, { cats: { thunk: 80 }, thunks: { "kernel32:ReadFile": { count: 64, totalMs: 80 } } }), rep);
        expect(io.report({ budgetMs: 16.7, categoryNames: CATS }).classes[0]!.contributor).toBe("io/stream");

        const sched = clf(); sched.setThreshold(10);
        sched.ingest(frame(90, { cats: { scheduler: 40 }, thunks: { "ddraw:Blt": { count: 1, totalMs: 40 } }, switches: 12 }), rep);
        expect(sched.report({ budgetMs: 16.7, categoryNames: CATS }).classes[0]!.contributor).toBe("sched-churn");
    });

    // INVARIANT: a thunk is only blamed when it owns a real share of the frame; otherwise the
    // frame is guest CPU. A 5%-of-frame thunk is not the cause of a stall.
    test("a minor thunk does not get blamed", () => {
        const c = clf(); c.setThreshold(10);
        c.ingest(frame(100, { cats: { v86: 90 }, thunks: { "ddraw:Blt": { count: 1, totalMs: 5 } } }), rep);
        const cls = c.report({ budgetMs: 16.7, categoryNames: CATS }).classes[0]!;
        expect(cls.contributor).toBe("guest-cpu");
        expect(cls.dominantCategory).toBe("v86");
    });

    // INVARIANT: when no category owns a meaningful share, the class says "unattributed"
    // rather than picking the largest crumb and implying an answer.
    test("time we do not measure is named unattributed", () => {
        const c = clf(); c.setThreshold(10);
        c.ingest(frame(100, { cats: { gpu: 3, thunk: 2 } }), rep);
        expect(c.report({ budgetMs: 16.7, categoryNames: CATS }).classes[0]!.dominantCategory).toBe("unattributed");
    });

    // INVARIANT: coverage is a verdict, not an assumption. The classifier only sees frames
    // above its threshold, so when the distribution counted more over-budget frames than were
    // classified, the report says partial AND how to fix the arming.
    test("coverage reports partial when the threshold hid over-budget frames", () => {
        const c = clf();
        c.setThreshold(33.33);
        for (let i = 0; i < 3; i++) c.ingest(frame(40, { cats: { v86: 38 } }), rep);
        const partial = c.report({ budgetMs: 16.7, categoryNames: CATS, overBudgetFrames: 50 });
        expect(partial.coverage).toBe("partial");
        expect(partial.coverageNote).toContain("47 of 50");
        expect(partial.coverageNote).toContain("captureOverMs");

        expect(c.report({ budgetMs: 16.7, categoryNames: CATS, overBudgetFrames: 3 }).coverage).toBe("complete");
        expect(c.report({ budgetMs: 16.7, categoryNames: CATS }).coverage).toBe("unknown");
    });

    // INVARIANT: reset scopes a window for the classes exactly as it does for the histogram.
    test("reset clears the classes", () => {
        const c = clf(); c.setThreshold(10);
        c.ingest(frame(50, { cats: { v86: 45 } }), rep);
        c.reset();
        const r = c.report({ budgetMs: 16.7, categoryNames: CATS, overBudgetFrames: 0 });
        expect(r.classifiedFrames).toBe(0);
        expect(r.classes).toHaveLength(0);
        expect(r.totalMsLost).toBe(0);
    });

    // INVARIANT: memory is bounded — a chaotic session folds into an overflow class and says
    // so, instead of growing a map per distinct contributor forever.
    test("the class table is capped and the overflow is disclosed", () => {
        const c = clf(); c.setThreshold(10);
        for (let i = 0; i < 300; i++) {
            c.ingest(frame(50, { cats: { thunk: 45 }, thunks: { [`mod:fn${i}`]: { count: 1, totalMs: 45 } } }), rep);
        }
        const r = c.report({ budgetMs: 16.7, top: 500, categoryNames: CATS, overBudgetFrames: 300 });
        expect(r.classes.length).toBeLessThanOrEqual(65);
        expect(r.coverage).toBe("partial");
        expect(r.coverageNote).toContain("overflow class");
        // Every frame still accounted for, capped or not.
        expect(r.classes.reduce((s, x) => s + x.count, 0)).toBe(300);
    });
});

/** Burn wall-clock so markFrame observes a real interval of at least `ms`. */
function spin(ms: number): void {
    const t = performance.now();
    while (performance.now() - t < ms) { /* the frame profiler measures real time */ }
}

describe("frameProfiler integration", () => {
    beforeEach(() => {
        frameProfiler.setEnabled(false);
        frameProfiler.setEnabled(true);
        frameProfiler.reset();
        frameProfiler.configureCapture({ worstN: 8, captureOverMs: 33.33 });
    });

    // INVARIANT: the arming state the tail reports is the profiler's own, so an agent cannot
    // read a tail out of a profiler that was never turned on.
    test("a disabled profiler has no tail", () => {
        frameProfiler.setEnabled(false);
        const t = frameProfiler.getTail();
        expect(t.ok).toBe(false);
        expect((t as any).status).toBe("disabled");
    });

    // INVARIANT: the distribution is fed by the PRESENT boundary (markPresent, called from
    // notifyPresent alongside the bottleship.flip mark and the flip-cadence ring), not by
    // markFrame — otherwise the live tail and the trace/flipCadence measure different events
    // and the cross-check fires on every run.
    test("markPresent populates the distribution; markFrame alone does not", () => {
        for (let i = 0; i < 6; i++) { spin(1); frameProfiler.markFrame("ddraw"); }
        expect(frameProfiler.getTail().sampleCount).toBe(0);
        for (let i = 0; i < 5; i++) { spin(1); frameProfiler.markPresent(); }
        const r = ok(frameProfiler.getTail());
        // 5 presents => 4 intervals (the first only starts the clock).
        expect(r.sampleCount).toBe(4);
        expect(r.maxMs).toBeGreaterThan(0.9);
        // The two boundaries are counted separately so a divergence is visible.
        expect(frameProfiler.getPresentFrameCount()).toBe(4);
        expect(frameProfiler.getMarkFrameCount()).toBe(5);
    });

    test("a renderer switch surfaces as an invalid window, not a short one", () => {
        for (let i = 0; i < 3; i++) { spin(1); frameProfiler.markFrame("ddraw"); frameProfiler.markPresent(); }
        frameProfiler.markFrame("d3d9");
        const t = frameProfiler.getTail();
        expect(t.ok).toBe(false);
        expect((t as any).status).toBe("source-switched-mid-window");
    });

    // INVARIANT: the retained captures are the WORST of the window, not the most recent. A
    // recency ring evicts the session's real spike as soon as a few mild ones follow it, while
    // still being presented (and sorted) as a ranking.
    test("worst-N keeps the biggest spike after smaller ones follow it", () => {
        frameProfiler.configureCapture({ worstN: 2, captureOverMs: 5 });
        frameProfiler.markFrame("ddraw");          // start the clock
        for (const ms of [40, 8, 8, 8, 8]) { spin(ms); frameProfiler.markFrame("ddraw"); }
        const snap = frameProfiler.getSnapshot();
        expect(snap.badFrames!.length).toBe(2);
        expect(snap.badFramesSeen!).toBeGreaterThanOrEqual(5);   // more seen than held
        expect(snap.badFrames![0].frameMs).toBeGreaterThan(35);  // the 40ms frame survived
    });

    // INVARIANT: the capture threshold is configurable, because "slow" is relative to the
    // title's cadence — 33.33 is a default, not the goal.
    test("captureOverMs decides what counts as a stall", () => {
        frameProfiler.configureCapture({ worstN: 4, captureOverMs: 500 });
        frameProfiler.markFrame("ddraw");
        for (let i = 0; i < 4; i++) { spin(40); frameProfiler.markFrame("ddraw"); }
        // 40ms frames are stalls at a 30fps budget and unremarkable at a 500ms one; only the
        // rolling-average spike rule may still fire, so assert on the threshold's own effect.
        const held = frameProfiler.getSnapshot().badFrames!;
        expect(held.every((c) => c.reason === "spike")).toBe(true);
    });

    // INVARIANT: the coverage verdict compares classifiedFrames (markFrame) against
    // overFrames (markPresent). While those two boundaries disagree on their totals the
    // comparison is between two different populations, so the report must NOT be able to say
    // "complete" — the whole point of the module is that an instrument cannot report a
    // plausible verdict about something other than its label.
    test("coverage is never 'complete' while the two frame boundaries disagree", () => {
        frameProfiler.configureCapture({ worstN: 4, captureOverMs: 5, classifyOverMs: 5 });
        // markFrame only: the classifier sees frames the distribution never will.
        for (let i = 0; i < 6; i++) { spin(8); frameProfiler.markFrame("ddraw"); }
        for (let i = 0; i < 4; i++) { spin(8); frameProfiler.markPresent(); }

        expect(frameProfiler.getMarkFrameCount()).not.toBe(frameProfiler.getPresentFrameCount());
        const spikes = frameProfiler.getSpikeClasses({ budgetMs: 5 });
        expect(spikes.coverage).not.toBe("complete");
        expect(spikes.coverageNote).toContain("different boundaries");
        // The divergence is named with both counts, not averaged away.
        expect(spikes.coverageNote).toContain(String(frameProfiler.getMarkFrameCount()));
        expect(spikes.coverageNote).toContain(String(frameProfiler.getPresentFrameCount()));
    });

    test("coverage can still reach 'complete' when the boundaries agree", () => {
        frameProfiler.configureCapture({ worstN: 4, captureOverMs: 5, classifyOverMs: 5 });
        // One markFrame and one markPresent per frame: the counts converge (both drop the
        // first observation, which only starts their clocks).
        for (let i = 0; i < 8; i++) { spin(8); frameProfiler.markFrame("ddraw"); frameProfiler.markPresent(); }
        expect(frameProfiler.getMarkFrameCount()).toBe(frameProfiler.getPresentFrameCount());
        const spikes = frameProfiler.getSpikeClasses({ budgetMs: 5 });
        expect(spikes.coverage).toBe("complete");
    });

    // INVARIANT: `average` and `sampleCount` describe the same frames or say they do not.
    // getSnapshot averages only the newest slice, and reporting the window size next to it
    // described a 60-frame mean as a 120-frame one.
    test("averageWindow states how many frames the mean covers", () => {
        for (let i = 0; i < 12; i++) { spin(1); frameProfiler.markFrame("ddraw"); }
        const snap = frameProfiler.getSnapshot(5);
        expect(snap.sampleCount).toBe(11);
        expect(snap.averageWindow).toBe(5);
    });
});
