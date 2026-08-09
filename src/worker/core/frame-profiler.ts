/**
 * Frame-level profiler for FPS breakdown.
 * Tracks time spent in key subsystems between presents.
 *
 * NOTE: This is lightweight and only active when enabled.
 */
import { frameVarianceDiagnostics } from './frame-variance-diagnostics';
import { FrameTimeDistribution, type FrameTail } from './frame-time-distribution';
import { SpikeClassifier, PARK_THUNKS, type FrameFacts, type SpikeClassReport } from './frame-spike-classes';

export const FRAME_CATEGORIES = [
    "thunk",
    "gpu",
    "present",
    "audio",
    "scheduler",
    "v86",
    "idle",
] as const;

export type FrameCategory = typeof FRAME_CATEGORIES[number];

type FrameSampleInternal = {
    frameMs: number;
    timestamp: number;
    categories: Float64Array;
    threadSwitchCount: number;
    activeThreadCount: number;
};

const CATEGORY_COUNT = FRAME_CATEGORIES.length;

const CATEGORY_INDEX: Record<FrameCategory, number> = {
    thunk: 0,
    gpu: 1,
    present: 2,
    audio: 3,
    scheduler: 4,
    v86: 5,
    idle: 6,
};

export type FrameSample = {
    frameMs: number;
    fps: number;
    v86Ms: number;
    timestamp: number;
    categories: Record<FrameCategory, number>;
    threadSwitchCount?: number;
    activeThreadCount?: number;
};

export type ThunkAggregate = {
    count: number;
    totalMs: number;
    /** Of `totalMs`, the part spent in calls that never borrowed a plain guest-memory view
     *  (see recordThunk's `noBorrow`). High here = a leaf indexing v86's Proxy per element. */
    noBorrowMs: number;
    noBorrowCount: number;
    /** Of `totalMs`, the part that came from samples at or below the CLOCK's granularity.
     *  performance.now() is quantised (5 us under cross-origin isolation, coarser without),
     *  so a sub-microsecond call measures as 0 or one whole quantum — and a sampled thunk
     *  scales that quantum by its sampling weight. Time that is mostly this is noise wearing
     *  a number's clothes; getThunkReport marks such rows instead of printing an average
     *  the clock cannot support. */
    quantizedMs: number;
};

export type BadFrameCapture = {
    id: number;
    timestamp: number;
    frameMs: number;
    categories: Record<FrameCategory, number>;
    thunkAggregates: Record<string, ThunkAggregate>;
    threadSwitchCount: number;
    activeThreadCount: number;
    reason: "spike" | "threshold" | "manual";
};

export type FrameStatsSnapshot = {
    enabled: boolean;
    source: string | null;
    sampleCount: number;
    windowSize: number;
    /** Frames `average` was actually computed over. NOT sampleCount: getSnapshot(maxSamples)
     *  averages only the newest slice, so reporting the two as one number describes a mean
     *  over 60 frames as if it covered 120. */
    averageWindow: number;
    latest?: FrameSample;
    average?: FrameSample;
    samples: FrameSample[];
    badFrames?: BadFrameCapture[];
    /** True count of capture-worthy frames; `badFrames` is capped at the worst-N capacity. */
    badFramesSeen?: number;
};

export class FrameProfiler {
    private enabled = false;
    private readonly samples: FrameSampleInternal[];
    private sampleIndex = 0;
    private sampleCount = 0;
    private lastFrameTime = 0;
    /** Previous PRESENT (notifyPresent) timestamp — the distribution's clock, separate from
     *  markFrame's, because the two are different boundaries. */
    private lastPresentTime = 0;
    private currentSource: string | null = null;
    private readonly currentCategories = new Float64Array(CATEGORY_COUNT);

    // Track v86 execution time (time between thunks)
    private lastThunkEndTime = 0;

    // Track thunk aggregates for current frame
    private currentThunkAggregates = new Map<string, ThunkAggregate>();

    // Session-wide thunk aggregate. currentThunkAggregates is cleared every frame and
    // only survives in the 5-frame badFrames ring, so per-call cost of a thunk can only
    // be read off the WORST frames. This one spans the whole enabled window, which is
    // what an A/B on a single thunk's µs/call needs (see getThunkReport).
    private sessionThunkAggregates = new Map<string, ThunkAggregate>();
    private sessionFrames = 0;

    // Worst-N bad frames over the WINDOW (not the last N): a recency ring silently evicts the
    // session's real worst spike as soon as a few mild ones follow, while still being read as
    // a ranking. Capacity is configurable because "how many spikes do I need to see" is the
    // caller's question; `badFramesSeen` is the true count the held captures cannot express.
    private badFrames: BadFrameCapture[] = [];
    private badFrameCapacity = 8;
    private badFramesSeen = 0;
    private nextBadFrameId = 1;
    /** Per-capture thunk detail is bounded — a capture holds the top N by time, so N spikes
     *  cost O(capacity x N) entries regardless of how many distinct thunks a frame touched. */
    private static readonly MAX_CAPTURE_THUNKS = 16;
    /** Thunks the stall classifier keys on: never truncated away, or `io/stream` would
     *  silently stop being detectable on exactly the busiest frames. */
    private static readonly CLASSIFIER_THUNKS = ['kernel32:ReadFile', 'kernel32:ReadFileEx', 'kernel32:SetFilePointer'];

    // Frame-time distribution over the window (histogram + p50/p95/p99 + budget), the tail
    // statistic the 5-slot worst-frame ring and the mean cannot express.
    private readonly distribution = new FrameTimeDistribution();

    /** Smallest non-zero interval performance.now() can express here. Measured, not assumed:
     *  it is 5 us under cross-origin isolation and coarser without, and every per-call timing
     *  this class reports is meaningless below it. */
    get timerResolutionMs(): number {
        if (this._timerResolutionMs === 0) this._timerResolutionMs = FrameProfiler.measureTimerResolution();
        return this._timerResolutionMs;
    }
    private _timerResolutionMs = 0;

    /** Measured on FIRST READ, not at construction: this class is a module-level singleton
     *  and the probe busy-spins, so on a coarse-clock host it would block the worker's import
     *  path. Bounded in wall time as well — a host that never advances the clock must not
     *  spin forever. */
    private static measureTimerResolution(): number {
        let smallest = Infinity;
        const deadline = performance.now() + 2;
        for (let i = 0; i < 8; i++) {
            const a = performance.now();
            let b = a;
            while (b === a && b < deadline) b = performance.now();
            if (b > a && b - a < smallest) smallest = b - a;
            if (b >= deadline) break;
        }
        return Number.isFinite(smallest) ? smallest : 0.005;
    }

    /** Capture threshold. 33.33 (30fps) is the default, NOT a goal: a 60fps-target title
     *  wants ~20, and a budget-relative read wants it aligned with that budget. */
    private captureThresholdMs = 33.33;

    // Track sliding average for spike detection
    private rollingAvgFrameMs = 16.67;
    private readonly ROLLING_AVG_ALPHA = 0.05; // Smoothing factor for average

    // Track frame switches per frame
    private currentThreadSwitchCount = 0;
    private currentActiveThreadCount = 0;

    // Spike COALESCING: every frame above the classifier's threshold reduced to a
    // (dominant category x top contributor) class, ranked at read time by total time lost
    // against a budget — the frame analogue of logStats, and the single owner of that
    // classification (getStallReport is a view of it, not a second accumulator).
    private readonly spikeClasses = new SpikeClassifier<BadFrameCapture>();

    /** Reused FrameFacts view — the classifier reads it and never retains it, so a frame
     *  costs no allocation on the way in. `categoryMs`/`thunks` are stable references
     *  (cleared in place each frame, never replaced). */
    private readonly spikeFacts: FrameFacts = {
        frameMs: 0,
        categoryMs: this.currentCategories,
        categoryNames: FRAME_CATEGORIES,
        thunks: this.currentThunkAggregates,
        threadSwitchCount: 0,
    };
    // Representative-capture source: a stable bound factory, so ingest() takes no per-frame
    // closure. Reuses the capture the worst-N ring already built when there is one.
    private pendingCapture: BadFrameCapture | null = null;
    private pendingFrameMs = 0;
    private pendingTimestamp = 0;
    private readonly representativeFactory = (): BadFrameCapture =>
        this.pendingCapture ?? this.buildCapture(this.pendingFrameMs, this.pendingTimestamp, "threshold");

    // Support for measuring yield time (Idle)
    private isSuspended = false;
    private suspensionStartTime = 0;

    constructor(private readonly windowSize: number = 120) {
        this.samples = new Array(windowSize);
        for (let i = 0; i < windowSize; i++) {
            this.samples[i] = {
                frameMs: 0,
                timestamp: 0,
                categories: new Float64Array(CATEGORY_COUNT),
                threadSwitchCount: 0,
                activeThreadCount: 0,
            };
        }
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            // A disarm destroys the window. Record that BEFORE it can be mistaken for a
            // complete measurement (reset() clears the flag, so note it afterwards).
            const hadSamples = this.distribution.sampleCount() > 0;
            this.reset();
            this.distribution.noteDisarm(hadSamples);
        }
    }

    /**
     * Worst-frame ring capacity, the frame time that counts as a capture-worthy stall, and
     * the frame time above which a frame gets COALESCED into a spike class. All three are
     * questions about the title being measured, so they belong to the caller.
     *
     * `classifyOverMs` should be the BUDGET: below it, over-budget frames exist that the
     * classifier never saw, and its coverage verdict says so rather than implying it saw all.
     */
    configureCapture(opts: { worstN?: number; captureOverMs?: number; classifyOverMs?: number }):
        { worstN: number; captureOverMs: number; classifyOverMs: number } {
        if (opts.worstN !== undefined && opts.worstN > 0) {
            this.badFrameCapacity = Math.min(64, Math.floor(opts.worstN));
            if (this.badFrames.length > this.badFrameCapacity) {
                this.badFrames.sort((a, b) => b.frameMs - a.frameMs);
                this.badFrames.length = this.badFrameCapacity;
            }
        }
        if (opts.captureOverMs !== undefined && opts.captureOverMs > 0) {
            this.captureThresholdMs = opts.captureOverMs;
            this.spikeClasses.setThreshold(opts.captureOverMs);
        }
        if (opts.classifyOverMs !== undefined && opts.classifyOverMs > 0) {
            this.spikeClasses.setThreshold(opts.classifyOverMs);
        }
        return {
            worstN: this.badFrameCapacity,
            captureOverMs: this.captureThresholdMs,
            classifyOverMs: this.spikeClasses.getThreshold(),
        };
    }

    /**
     * Budget-missing frames coalesced into classes, ranked by total time lost. `budgetMs`
     * defaults to the cadence the window itself observed (never a hardcoded target), and the
     * over-budget frame count comes from the distribution — which sees EVERY frame — so the
     * report can tell whether the classes cover all of them.
     */
    getSpikeClasses(opts: { budgetMs?: number; top?: number } = {}): SpikeClassReport<BadFrameCapture> & { armed: boolean } {
        const tail = this.getTail({ budgetMs: opts.budgetMs });
        const budgetMs = opts.budgetMs
            ?? (tail.ok && tail.budget ? tail.budget.ms : this.captureThresholdMs);

        // The coverage verdict compares classifiedFrames (markFrame) against overFrames
        // (markPresent) — two DIFFERENT boundaries, and ddraw's frameAlreadyMarked can skip
        // markFrame. While their totals disagree the comparison is between two populations,
        // so the count is withheld: `unknown` plus the divergence beats "complete" for a
        // window whose over-budget presents the classifier never saw.
        const presentFrames = this.getPresentFrameCount();
        const markFrames = this.getMarkFrameCount();
        const boundariesAgree = presentFrames === markFrames;
        const report = this.spikeClasses.report({
            budgetMs,
            top: opts.top,
            categoryNames: FRAME_CATEGORIES,
            overBudgetFrames: (boundariesAgree && tail.ok && tail.budget) ? tail.budget.overFrames : undefined,
        });
        if (!boundariesAgree) {
            const note = `the classifier counted ${markFrames} markFrame frames while the budget verdict `
                + `is over ${presentFrames} present frames — different boundaries, so coverage against `
                + `over-budget presents cannot be established.`;
            report.coverageNote = report.coverageNote ? `${report.coverageNote} ${note}` : note;
        }
        return { armed: this.enabled, ...report };
    }

    /**
     * Frame-time tail over the window: histogram + p50/p95/p99 + frames over budget.
     * Returns a discriminated union — the percentile fields exist only on the `ok` shape, and
     * the arming state comes from this.enabled, so a p99 for a disabled profiler is not
     * representable rather than merely unlikely.
     */
    getTail(opts: { budgetMs?: number; maxBuckets?: number } = {}): FrameTail {
        return this.distribution.report({
            armed: this.enabled,
            budgetMs: opts.budgetMs,
            maxBuckets: opts.maxBuckets,
        });
    }

    /** True number of capture-worthy frames in the window (the held captures are capped). */
    getBadFramesSeen(): number {
        return this.badFramesSeen;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    reset(): void {
        this.sampleIndex = 0;
        this.sampleCount = 0;
        this.lastFrameTime = 0;
        this.lastPresentTime = 0;
        this.currentSource = null;
        this.currentCategories.fill(0);
        this.currentThunkAggregates.clear();
        this.badFrames = [];
        this.badFramesSeen = 0;
        this.distribution.resetWindow();
        this.spikeClasses.reset();
        this.rollingAvgFrameMs = 16.67;
        this.lastThunkEndTime = 0;
        this.sessionThunkAggregates.clear();
        this.sessionFrames = 0;
        this.currentThreadSwitchCount = 0;
        this.currentActiveThreadCount = 0;
        for (const sample of this.samples) {
            sample.frameMs = 0;
            sample.timestamp = 0;
            sample.categories.fill(0);
            sample.threadSwitchCount = 0;
            sample.activeThreadCount = 0;
        }
    }

    /**
     * Returns a timestamp if enabled, otherwise 0.
     * This avoids performance.now() overhead when disabled.
     */
    startTimer(): number {
        return this.enabled ? performance.now() : 0;
    }

    endTimer(category: FrameCategory, startTime: number): number {
        if (!this.enabled || startTime === 0) return 0;
        const delta = performance.now() - startTime;
        if (delta > 0) {
            this.addTime(category, delta);
            return delta;
        }
        return 0;
    }

    addTime(category: FrameCategory, ms: number): void {
        if (!this.enabled || !(ms > 0)) return;
        this.currentCategories[CATEGORY_INDEX[category]] += ms;
    }

    /**
     * Call when a thunk starts. Records time spent in v86 since last thunk ended.
     */
    markThunkStart(): void {
        if (!this.enabled) return;
        const now = performance.now();
        if (this.lastThunkEndTime > 0) {
            const delta = now - this.lastThunkEndTime;
            if (delta > 0) {
                // If we just came back from suspension, this delta is Idle time
                if (this.isSuspended) {
                    this.currentCategories[CATEGORY_INDEX.idle] += delta;
                    this.isSuspended = false;
                } else {
                    this.currentCategories[CATEGORY_INDEX.v86] += delta;
                }
            }
        }
    }

    /**
     * Records an individual thunk call's duration and count.
     *
     * `noBorrow` marks a call that ran without borrowing a plain guest-memory view. A thunk
     * that is BOTH slow and never borrowed is the signature of a leaf indexing v86's Proxy
     * per element (~140x the cost of a typed array) — getThunkReport ranks those so the
     * class gets re-found by measurement instead of by another manual audit.
     */
    recordThunk(name: string, ms: number, countWeight: number = 1, noBorrow: boolean = false,
                sampleMs: number = ms): void {
        if (!this.enabled || ms < 0) return;
        // `sampleMs` is the raw measured interval before any sampling scale-up; comparing
        // THAT (not the scaled total) against the clock's granularity is what says whether
        // the measurement carried information.
        const quantized = sampleMs <= this.timerResolutionMs * 1.5;
        let agg = this.currentThunkAggregates.get(name);
        if (!agg) {
            agg = { count: 0, totalMs: 0, noBorrowMs: 0, noBorrowCount: 0, quantizedMs: 0 };
            this.currentThunkAggregates.set(name, agg);
        }
        agg.count += countWeight;
        agg.totalMs += ms;
        if (quantized) agg.quantizedMs += ms;

        let sess = this.sessionThunkAggregates.get(name);
        if (!sess) {
            sess = { count: 0, totalMs: 0, noBorrowMs: 0, noBorrowCount: 0, quantizedMs: 0 };
            this.sessionThunkAggregates.set(name, sess);
        }
        sess.count += countWeight;
        sess.totalMs += ms;
        if (quantized) sess.quantizedMs += ms;
        if (noBorrow) {
            agg.noBorrowMs += ms; agg.noBorrowCount += countWeight;
            sess.noBorrowMs += ms; sess.noBorrowCount += countWeight;
        }
    }

    /**
     * Call when a thunk ends. Records timestamp for next v86 time calculation.
     */
    markThunkEnd(): void {
        if (!this.enabled) return;
        this.lastThunkEndTime = performance.now();
    }

    /**
     * Call when emulator is about to YIELD to host (busy-wait mitigation).
     */
    markSuspensionStart(): void {
        if (!this.enabled) return;
        // The time from now until the next thunk starts will be counted as Idle
        this.isSuspended = true;
        this.lastThunkEndTime = performance.now();
    }

    /**
     * Increment thread switch counter for current frame
     */
    incrementThreadSwitch(): void {
        if (!this.enabled) return;
        this.currentThreadSwitchCount++;
    }

    /**
     * Set active thread count for current frame
     */
    setActiveThreadCount(count: number): void {
        if (!this.enabled) return;
        this.currentActiveThreadCount = count;
    }

    /**
     * PRESENT boundary — the frame-time distribution's only input.
     *
     * Called from RenderService.notifyPresent, the funnel that also emits the
     * `bottleship.flip` trace mark and feeds getFlipCadence, so the live tail, the flip
     * cadence and `analyze-trace.ts` all measure the SAME event. markFrame is a different
     * boundary (presenter-labelled, and ddraw's `frameAlreadyMarked` can skip it), which is
     * why the category/spike-class side is reported against its own frame count and any
     * divergence between the two is published rather than averaged away.
     */
    markPresent(): void {
        if (!this.enabled) return;
        const now = performance.now();
        if (this.lastPresentTime > 0) {
            const dt = now - this.lastPresentTime;
            if (dt > 0) this.distribution.record(dt, now);
        }
        this.lastPresentTime = now;
    }

    /** Frames seen at the markFrame boundary (the category/spike-class denominator). */
    getMarkFrameCount(): number {
        return this.sessionFrames;
    }

    /** Frames seen at the present boundary (the distribution's denominator). */
    getPresentFrameCount(): number {
        return this.distribution.sampleCount();
    }

    /**
     * Mark the end of a frame (typically at present).
     * Computes frame duration since last mark and stores a sample.
     */
    markFrame(source: string): void {
        if (!this.enabled) return;
        const now = performance.now();

        if (this.currentSource && source !== this.currentSource) {
            // Renderer switched (DDraw <-> D3D9). Reset to avoid mixing sources — and RECORD
            // it: this wipes a window from inside the present path, so a tail read afterwards
            // would otherwise describe a few frames while looking like a full session.
            const prev = this.currentSource;
            const hadSamples = this.distribution.sampleCount() > 0;
            this.reset();
            this.distribution.noteSourceSwitch(prev, source, hadSamples);
        }
        this.currentSource = source;

        // Update active thread count from Scheduler
        try {
            const system = (globalThis as any).System?.getInstance?.();
            const scheduler = system?.scheduler;
            if (scheduler) {
                this.currentActiveThreadCount = scheduler.getThreadCount();
            }
        } catch {
            // Ignore errors if System not initialized yet
        }

        if (this.lastFrameTime === 0) {
            this.lastFrameTime = now;
            this.currentCategories.fill(0);
            this.currentThunkAggregates.clear();
            return;
        }

        const frameMs = now - this.lastFrameTime;
        this.lastFrameTime = now;

        if (!(frameMs > 0)) {
            this.currentCategories.fill(0);
            this.currentThunkAggregates.clear();
            return;
        }

        // --- SPIKE DETECTION ---
        const isSlow = frameMs > this.captureThresholdMs;
        const isSpike = frameMs > this.rollingAvgFrameMs * 2.0 && frameMs > 10; // 2x average and not tiny

        this.pendingCapture = (isSlow || isSpike)
            ? this.captureBadFrame(frameMs, now, isSpike ? "spike" : "threshold")
            : null;

        // Coalesce into a spike class. Its threshold is independent of the capture ring's, so
        // a budget lower than captureOverMs still gets every over-budget frame classified.
        this.pendingFrameMs = frameMs;
        this.pendingTimestamp = now;
        this.spikeFacts.frameMs = frameMs;
        this.spikeFacts.threadSwitchCount = this.currentThreadSwitchCount;
        this.spikeClasses.ingest(this.spikeFacts, this.representativeFactory);
        this.pendingCapture = null;

        // Update rolling average (only for "normal" frames to avoid skewing)
        if (!isSpike) {
            this.rollingAvgFrameMs = this.rollingAvgFrameMs * (1 - this.ROLLING_AVG_ALPHA) + frameMs * this.ROLLING_AVG_ALPHA;
        }

        const slot = this.samples[this.sampleIndex];
        slot.frameMs = frameMs;
        slot.timestamp = now;
        slot.categories.set(this.currentCategories);
        slot.threadSwitchCount = this.currentThreadSwitchCount;
        slot.activeThreadCount = this.currentActiveThreadCount;

        this.sampleIndex = (this.sampleIndex + 1) % this.samples.length;
        this.sampleCount = Math.min(this.sampleCount + 1, this.samples.length);
        this.sessionFrames++;
        this.currentCategories.fill(0);
        this.currentThunkAggregates.clear();
        this.currentThreadSwitchCount = 0;
        // Note: activeThreadCount is NOT reset - it persists until next update
        // Reset lastThunkEndTime to avoid counting inter-frame time as V86
        // Without this, time between last thunk of frame N and first thunk of frame N+1
        // (including present time!) would be added to V86 of frame N+1
        this.lastThunkEndTime = 0;

        // Trigger variance diagnostics frame marker
        if (frameVarianceDiagnostics.isEnabled()) {
            frameVarianceDiagnostics.markFrameEnd(frameMs);
        }
    }

    /** One frame's full evidence: category split + bounded hot-thunk detail. */
    private buildCapture(frameMs: number, timestamp: number, reason: "spike" | "threshold" | "manual"): BadFrameCapture {
        return {
            id: this.nextBadFrameId++,
            timestamp,
            frameMs,
            categories: this.buildCategoryObject(this.currentCategories),
            thunkAggregates: this.snapshotFrameThunks(),
            threadSwitchCount: this.currentThreadSwitchCount,
            activeThreadCount: this.currentActiveThreadCount,
            reason,
        };
    }

    private captureBadFrame(frameMs: number, timestamp: number, reason: "spike" | "threshold" | "manual"): BadFrameCapture {
        const capture = this.buildCapture(frameMs, timestamp, reason);

        this.badFramesSeen++;
        // Worst-N by frameMs. O(capacity) and only on a frame that is already slow.
        if (this.badFrames.length < this.badFrameCapacity) {
            this.badFrames.push(capture);
        } else {
            let weakest = 0;
            for (let i = 1; i < this.badFrames.length; i++) {
                if (this.badFrames[i].frameMs < this.badFrames[weakest].frameMs) weakest = i;
            }
            if (capture.frameMs > this.badFrames[weakest].frameMs) this.badFrames[weakest] = capture;
        }
        return capture;
    }

    /** Current frame's thunk detail, bounded to the top MAX_CAPTURE_THUNKS by time plus the
     *  names the stall classifier needs, so a capture cannot grow with the guest's API variety. */
    private snapshotFrameThunks(): Record<string, ThunkAggregate> {
        const out: Record<string, ThunkAggregate> = {};
        const entries = Array.from(this.currentThunkAggregates.entries());
        entries.sort((a, b) => b[1].totalMs - a[1].totalMs);
        const keep = Math.min(entries.length, FrameProfiler.MAX_CAPTURE_THUNKS);
        for (let i = 0; i < keep; i++) out[entries[i][0]] = { ...entries[i][1] };
        for (const name of FrameProfiler.CLASSIFIER_THUNKS) {
            if (out[name]) continue;
            const agg = this.currentThunkAggregates.get(name);
            if (agg) out[name] = { ...agg };
        }
        return out;
    }

    /**
     * Console view (`stallReport()`) of the ONE spike-class accumulator: classes ranked by
     * time lost against the budget, plus each class's representative frame with its hot
     * thunks. Budget defaults to the cadence the window observed.
     */
    getStallReport(opts: { budgetMs?: number; top?: number } = {}) {
        const report = this.getSpikeClasses({ budgetMs: opts.budgetMs, top: opts.top ?? 12 });
        return {
            armed: report.armed,
            budgetMs: report.budgetMs,
            classifyOverMs: report.classifyOverMs,
            coverage: report.coverage,
            coverageNote: report.coverageNote,
            stallFramesSeen: report.classifiedFrames,
            totalMsLost: report.totalMsLost,
            rollingAvgMs: +this.rollingAvgFrameMs.toFixed(1),
            classes: report.classes.map((c) => ({
                signature: c.signature,
                count: c.count,
                totalMsLost: c.totalMsLost,
                sharePct: c.shareOfLostPct,
                avgMs: c.avgMs,
                maxMs: c.worstMs,
                exact: c.exact,
                worstFrame: c.representative ? summarizeCapture(c.representative) : null,
            })),
            remainder: report.remainder,
        };
    }

    /**
     * Session-wide per-thunk cost, ranked by total time — the A/B instrument for
     * "is this thunk cheaper now?".
     *
     * `avgUs` is real µs per call. Cheap calls are sampled (1 in 16 generic, 1 in 32 fast
     * path) but the dispatcher scales BOTH the recorded ms and the count by the stride, so
     * the ratio is unbiased; calls at/above HEAVY_THUNK_MS are recorded exactly, which is
     * what keeps a rare multi-ms blit from being averaged out of existence. Per-call
     * figures are far less contention-sensitive than FPS, which is why an A/B belongs here
     * rather than in a frame-rate comparison.
     */
    getThunkReport(top: number = 20, filter?: string) {
        let totalMs = 0;
        for (const agg of this.sessionThunkAggregates.values()) totalMs += agg.totalMs;
        const rows = Array.from(this.sessionThunkAggregates.entries())
            .filter(([name]) => !filter || name.toLowerCase().includes(filter.toLowerCase()))
            .map(([name, agg]) => ({
                name,
                count: agg.count,
                totalMs: +agg.totalMs.toFixed(2),
                avgUs: agg.count > 0 ? +((agg.totalMs * 1000) / agg.count).toFixed(1) : 0,
                msPerFrame: this.sessionFrames > 0 ? +(agg.totalMs / this.sessionFrames).toFixed(3) : 0,
                shareOfThunkPct: totalMs > 0 ? +((agg.totalMs / totalMs) * 100).toFixed(1) : 0,
                // Slow AND never borrowed a plain view ⇒ prime suspect for a Proxy-indexed leaf.
                noBorrowMs: +agg.noBorrowMs.toFixed(2),
                noBorrowAvgUs: agg.noBorrowCount > 0 ? +((agg.noBorrowMs * 1000) / agg.noBorrowCount).toFixed(1) : 0,
                // How much of this row's time came from samples the clock could not resolve.
                // At 100% the totalMs is an artefact of quantisation scaled by the sampling
                // weight — the call count is real, the time is not.
                quantizedPct: agg.totalMs > 0 ? +((agg.quantizedMs / agg.totalMs) * 100).toFixed(0) : 0,
                timeUnreliable: agg.totalMs > 0 && agg.quantizedMs / agg.totalMs > 0.5,
            }))
            .sort((a, b) => b.totalMs - a.totalMs)
            .slice(0, top);
        const unreliable = rows.filter(r => r.timeUnreliable).map(r => r.name);
        return {
            enabled: this.enabled,
            frames: this.sessionFrames,
            thunkTotalMs: +totalMs.toFixed(2),
            timerResolutionMs: +this.timerResolutionMs.toFixed(4),
            // Naming them here, not only per row: a reader scanning for the biggest totalMs
            // is exactly the reader who will not notice a per-row flag.
            unreliableRows: unreliable.length > 0 ? unreliable : undefined,
            note: unreliable.length > 0
                ? `time for ${unreliable.length} row(s) came from samples at or below the ${(this.timerResolutionMs * 1000).toFixed(0)}us clock granularity `
                  + `and is quantisation noise scaled by the sampling weight — trust their COUNT, not their ms`
                : undefined,
            rows,
        };
    }

    resetStallStats(): void {
        this.spikeClasses.reset();
    }

    getSnapshot(maxSamples: number = 60): FrameStatsSnapshot {
        if (!this.enabled || this.sampleCount === 0) {
            return {
                enabled: this.enabled,
                source: this.currentSource,
                sampleCount: this.sampleCount,
                windowSize: this.samples.length,
                averageWindow: 0,
                samples: [],
            };
        }

        const orderedSamples: FrameSampleInternal[] = [];
        const total = this.sampleCount;
        const len = this.samples.length;
        const start = (this.sampleIndex - total + len) % len;
        for (let i = 0; i < total; i++) {
            orderedSamples.push(this.samples[(start + i) % len]);
        }

        const windowed = orderedSamples.slice(Math.max(0, orderedSamples.length - maxSamples));
        const summarySamples: FrameSample[] = windowed.map((sample) => this.buildSample(sample));

        const average = this.computeAverage(windowed);
        const latest = summarySamples[summarySamples.length - 1];

        return {
            enabled: this.enabled,
            source: this.currentSource,
            sampleCount: this.sampleCount,
            windowSize: this.samples.length,
            averageWindow: windowed.length,
            latest,
            average,
            samples: summarySamples,
            badFrames: [...this.badFrames].sort((a, b) => b.frameMs - a.frameMs),
            badFramesSeen: this.badFramesSeen,
        };
    }

    private buildSample(sample: FrameSampleInternal): FrameSample {
        const categories = this.buildCategoryObject(sample.categories);
        const sum = this.sumCategories(sample.categories);
        const v86Ms = Math.max(0, sample.frameMs - sum);
        const fps = sample.frameMs > 0 ? 1000 / sample.frameMs : 0;
        return {
            frameMs: sample.frameMs,
            fps,
            v86Ms,
            timestamp: sample.timestamp,
            categories,
            threadSwitchCount: sample.threadSwitchCount,
            activeThreadCount: sample.activeThreadCount,
        };
    }

    private computeAverage(samples: FrameSampleInternal[]): FrameSample {
        const count = Math.max(1, samples.length);
        let totalFrameMs = 0;
        let totalThreadSwitches = 0;
        let totalActiveThreads = 0;
        const totals = new Float64Array(CATEGORY_COUNT);

        for (const sample of samples) {
            totalFrameMs += sample.frameMs;
            totalThreadSwitches += sample.threadSwitchCount;
            totalActiveThreads += sample.activeThreadCount;
            const cats = sample.categories;
            for (let i = 0; i < CATEGORY_COUNT; i++) {
                totals[i] += cats[i];
            }
        }

        const avgFrameMs = totalFrameMs / count;
        const categories = this.buildCategoryObject(totals, count);
        const sum = this.sumCategories(totals) / count;
        const v86Ms = Math.max(0, avgFrameMs - sum);
        const fps = avgFrameMs > 0 ? 1000 / avgFrameMs : 0;

        return {
            frameMs: avgFrameMs,
            fps,
            v86Ms,
            timestamp: samples[samples.length - 1]?.timestamp ?? 0,
            categories,
            threadSwitchCount: totalThreadSwitches / count,
            activeThreadCount: totalActiveThreads / count,
        };
    }

    private buildCategoryObject(values: Float64Array, divisor: number = 1): Record<FrameCategory, number> {
        return {
            thunk: values[CATEGORY_INDEX.thunk] / divisor,
            gpu: values[CATEGORY_INDEX.gpu] / divisor,
            present: values[CATEGORY_INDEX.present] / divisor,
            audio: values[CATEGORY_INDEX.audio] / divisor,
            scheduler: values[CATEGORY_INDEX.scheduler] / divisor,
            v86: values[CATEGORY_INDEX.v86] / divisor,
            idle: values[CATEGORY_INDEX.idle] / divisor,
        };
    }

    private sumCategories(values: Float64Array): number {
        let sum = 0;
        for (let i = 0; i < CATEGORY_COUNT; i++) {
            sum += values[i];
        }
        return sum;
    }
}

/**
 * A capture reduced to the evidence a reader acts on: the frame's cost, its category split,
 * scheduler churn, io volume, and the hot NON-park thunks (a park is a cross-thread wait, so
 * it would top every list without naming a cause).
 */
export function summarizeCapture(c: BadFrameCapture) {
    return {
        frame: c.id,
        ms: +c.frameMs.toFixed(2),
        reason: c.reason,
        switches: c.threadSwitchCount,
        threads: c.activeThreadCount,
        io: (c.thunkAggregates['kernel32:ReadFile']?.count ?? 0) + (c.thunkAggregates['kernel32:SetFilePointer']?.count ?? 0),
        categories: Object.fromEntries(
            Object.entries(c.categories).filter(([, v]) => v > 0.05).map(([k, v]) => [k, +v.toFixed(2)]),
        ),
        topThunks: Object.entries(c.thunkAggregates)
            .filter(([n]) => !PARK_THUNKS.has(n.toLowerCase()))
            .sort((a, b) => b[1].totalMs - a[1].totalMs)
            .slice(0, 6)
            .map(([n, a]) => `${n}x${a.count}=${a.totalMs.toFixed(2)}ms`),
    };
}

export const frameProfiler = new FrameProfiler();
