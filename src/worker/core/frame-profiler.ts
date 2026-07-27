/**
 * Frame-level profiler for FPS breakdown.
 * Tracks time spent in key subsystems between presents.
 *
 * NOTE: This is lightweight and only active when enabled.
 */
import { frameVarianceDiagnostics } from './frame-variance-diagnostics';

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
    latest?: FrameSample;
    average?: FrameSample;
    samples: FrameSample[];
    badFrames?: BadFrameCapture[];
};

/**
 * Thunks whose per-frame time is a BLOCKING WAIT, not CPU work — they must be excluded
 * when attributing a stall's cause (e.g. the audio thread's GetMessageA park is summed
 * cross-thread into the frame and would otherwise dominate every classification).
 */
const PARK_THUNKS = new Set<string>([
    'user32:getmessagea', 'user32:getmessagew', 'user32:peekmessagea', 'user32:waitmessage',
    'ddraw:idirectdrawsurface7_flip', 'ddraw:idirectdrawsurface_flip',
    'kernel32:waitforsingleobject', 'kernel32:waitformultipleobjects', 'kernel32:sleep', 'kernel32:sleepex',
]);

interface StallBucket { count: number; sumMs: number; maxMs: number; sumExcessMs: number; }

export class FrameProfiler {
    private enabled = false;
    private readonly samples: FrameSampleInternal[];
    private sampleIndex = 0;
    private sampleCount = 0;
    private lastFrameTime = 0;
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

    // Track bad frames (spikes or slow frames)
    private badFrames: BadFrameCapture[] = [];
    private readonly MAX_BAD_FRAMES = 5;
    private nextBadFrameId = 1;

    // Track sliding average for spike detection
    private rollingAvgFrameMs = 16.67;
    private readonly ROLLING_AVG_ALPHA = 0.05; // Smoothing factor for average

    // Track frame switches per frame
    private currentThreadSwitchCount = 0;
    private currentActiveThreadCount = 0;

    // Stall accumulator: every slow frame classified into a (magnitude × cause) signature,
    // accumulated unbounded (vs the 5-frame badFrames ring) so we collect ALL slowdowns over
    // a session. Read via stallReport(); scope a window with stallReset().
    private stallStats = new Map<string, StallBucket>();
    private worstStalls: BadFrameCapture[] = [];
    private stallFramesSeen = 0;

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
            this.reset();
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    reset(): void {
        this.sampleIndex = 0;
        this.sampleCount = 0;
        this.lastFrameTime = 0;
        this.currentSource = null;
        this.currentCategories.fill(0);
        this.currentThunkAggregates.clear();
        this.badFrames = [];
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
    recordThunk(name: string, ms: number, countWeight: number = 1, noBorrow: boolean = false): void {
        if (!this.enabled || ms < 0) return;
        let agg = this.currentThunkAggregates.get(name);
        if (!agg) {
            agg = { count: 0, totalMs: 0, noBorrowMs: 0, noBorrowCount: 0 };
            this.currentThunkAggregates.set(name, agg);
        }
        agg.count += countWeight;
        agg.totalMs += ms;

        let sess = this.sessionThunkAggregates.get(name);
        if (!sess) {
            sess = { count: 0, totalMs: 0, noBorrowMs: 0, noBorrowCount: 0 };
            this.sessionThunkAggregates.set(name, sess);
        }
        sess.count += countWeight;
        sess.totalMs += ms;
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
     * Mark the end of a frame (typically at present).
     * Computes frame duration since last mark and stores a sample.
     */
    markFrame(source: string): void {
        if (!this.enabled) return;
        const now = performance.now();

        if (this.currentSource && source !== this.currentSource) {
            // Renderer switched (DDraw <-> D3D9). Reset to avoid mixing sources.
            this.reset();
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
        const isSlow = frameMs > 33.33; // > 33ms (missed 30fps)
        const isSpike = frameMs > this.rollingAvgFrameMs * 2.0 && frameMs > 10; // 2x average and not tiny

        if (isSlow || isSpike) {
            this.captureBadFrame(frameMs, now, isSpike ? "spike" : "threshold");
        }

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

    private captureBadFrame(frameMs: number, timestamp: number, reason: "spike" | "threshold" | "manual"): void {
        const categories = this.buildCategoryObject(this.currentCategories);

        // Convert map to plain object for easy serialization to UI
        const thunkAggregates: Record<string, ThunkAggregate> = {};
        for (const [name, agg] of this.currentThunkAggregates) {
            thunkAggregates[name] = { ...agg };
        }

        const capture: BadFrameCapture = {
            id: this.nextBadFrameId++,
            timestamp,
            frameMs,
            categories,
            thunkAggregates,
            threadSwitchCount: this.currentThreadSwitchCount,
            activeThreadCount: this.currentActiveThreadCount,
            reason
        };

        this.badFrames.push(capture);
        if (this.badFrames.length > this.MAX_BAD_FRAMES) {
            this.badFrames.shift();
        }

        this.accumulateStall(capture);
    }

    /** Classify a slow frame into a (magnitude × cause) signature and accumulate it. */
    private accumulateStall(c: BadFrameCapture): void {
        this.stallFramesSeen++;
        const agg = c.thunkAggregates;
        const ms = c.frameMs;

        const readOps =
            (agg['kernel32:ReadFile']?.count ?? 0) +
            (agg['kernel32:ReadFileEx']?.count ?? 0) +
            (agg['kernel32:SetFilePointer']?.count ?? 0);

        // Dominant NON-park thunk by total time (parks are cross-thread waits, not CPU).
        let topName = '', topMs = 0;
        for (const name in agg) {
            if (PARK_THUNKS.has(name.toLowerCase())) continue;
            const t = agg[name].totalMs;
            if (t > topMs) { topMs = t; topName = name; }
        }

        let cause: string;
        if (readOps >= 32) cause = 'io/stream';
        else if (c.threadSwitchCount >= 10) cause = 'sched-churn';
        else if (topName && topMs >= ms * 0.30) cause = `thunk:${topName}`;
        else cause = 'guest-cpu';

        const bucket = ms > 300 ? '4_hang(>300ms)'
            : ms > 100 ? '3_stall(100-300)'
            : ms > 60 ? '2_spike(60-100)'
            : '1_base(33-60)';
        const sig = `${bucket} | ${cause}`;

        let b = this.stallStats.get(sig);
        if (!b) { b = { count: 0, sumMs: 0, maxMs: 0, sumExcessMs: 0 }; this.stallStats.set(sig, b); }
        b.count++;
        b.sumMs += ms;
        if (ms > b.maxMs) b.maxMs = ms;
        b.sumExcessMs += Math.max(0, ms - this.rollingAvgFrameMs);

        // Keep the worst dozen frames (by frameMs) for inspection.
        this.worstStalls.push(c);
        this.worstStalls.sort((x, y) => y.frameMs - x.frameMs);
        if (this.worstStalls.length > 12) this.worstStalls.length = 12;
    }

    /** Summary of all accumulated stalls, grouped by signature and ranked by total excess time. */
    getStallReport() {
        const classes = Array.from(this.stallStats.entries()).map(([signature, b]) => ({
            signature,
            count: b.count,
            avgMs: +(b.sumMs / b.count).toFixed(1),
            maxMs: +b.maxMs.toFixed(1),
            totalExcessMs: Math.round(b.sumExcessMs),
        })).sort((a, b) => b.totalExcessMs - a.totalExcessMs);

        const worst = this.worstStalls.map((c) => ({
            frame: c.id,
            ms: +c.frameMs.toFixed(1),
            reason: c.reason,
            switches: c.threadSwitchCount,
            io: (c.thunkAggregates['kernel32:ReadFile']?.count ?? 0) + (c.thunkAggregates['kernel32:SetFilePointer']?.count ?? 0),
            topThunks: Object.entries(c.thunkAggregates)
                .filter(([n]) => !PARK_THUNKS.has(n.toLowerCase()))
                .sort((a, b) => b[1].totalMs - a[1].totalMs)
                .slice(0, 4)
                .map(([n, a]) => `${n}×${a.count}=${a.totalMs.toFixed(2)}ms`),
        }));

        return {
            stallFramesSeen: this.stallFramesSeen,
            rollingAvgMs: +this.rollingAvgFrameMs.toFixed(1),
            classes,
            worst,
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
            }))
            .sort((a, b) => b.totalMs - a.totalMs)
            .slice(0, top);
        return {
            enabled: this.enabled,
            frames: this.sessionFrames,
            thunkTotalMs: +totalMs.toFixed(2),
            rows,
        };
    }

    resetStallStats(): void {
        this.stallStats.clear();
        this.worstStalls = [];
        this.stallFramesSeen = 0;
    }

    getSnapshot(maxSamples: number = 60): FrameStatsSnapshot {
        if (!this.enabled || this.sampleCount === 0) {
            return {
                enabled: this.enabled,
                source: this.currentSource,
                sampleCount: this.sampleCount,
                windowSize: this.samples.length,
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
            latest,
            average,
            samples: summarySamples,
            badFrames: [...this.badFrames],
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

export const frameProfiler = new FrameProfiler();
