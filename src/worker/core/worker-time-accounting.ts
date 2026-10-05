/**
 * Where the worker's wall-clock actually goes, as a PARTITION of the window rather than
 * a set of summaries that each cover an unknown slice of it.
 *
 * The worker runs the guest inside v86's `do_tick`, and everything else — the rAF present
 * chain, host messages, timers — between ticks. A trace can say "12% of samples were
 * idle" but not which of the two candidate mechanisms produced them (a synchronous SAB
 * read parking the thread inside a tick, versus macrotask latency between ticks), and the
 * two have opposite fixes. So this ledger brackets the two regions separately and reports
 * what is left over as its own number instead of folding it into either.
 *
 * The partition is: window = inTick + attributed non-tick + unattributed. The last term
 * is the honest one — non-tick JS that nobody brackets plus true idle — and it is printed
 * as `unattributedMs`, never distributed across the other two. A NEGATIVE unattributed
 * value means the brackets are unbalanced (a throw escaping one of them) and no number
 * here is usable.
 *
 * Cost is two `performance.now()` calls per tick plus a handful of adds — ticks run at
 * ~10^2-10^3/s, not per guest instruction, so this is always on. Nothing here allocates.
 */

/** Non-tick regions worth naming. Anything unbracketed lands in `unattributedMs`. */
export type NonTickKind = "present" | "message";

const KINDS: readonly NonTickKind[] = ["present", "message"];

/** Tick-duration buckets, in ms. The last bucket is unbounded. */
const TICK_BUCKETS_MS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, Infinity];

export interface WorkerTimeSnapshot {
    /** performance.now() when the snapshot was taken. */
    atMs: number;
    /** performance.now() when accounting first observed a tick — a window that starts
     *  before this is not covered, and the report says so rather than reading as zero. */
    firstTickAtMs: number;
    ticks: number;
    /** Sum of (tick_hooks_after exit - tick_hooks_before entry) over the window. */
    inTickMs: number;
    /** Longest single tick, the tail this ledger can see without a trace. */
    maxTickMs: number;
    /** Sum of the delays v86's main_loop asked next_tick to sleep for. A gap that matches
     *  this is the loop sleeping ON PURPOSE, not scheduling latency. */
    requestedSleepMs: number;
    /** Per-kind attributed non-tick time. */
    nonTickMs: Record<NonTickKind, number>;
    nonTickCalls: Record<NonTickKind, number>;
    /** Bracket imbalance guard: a region entered and never exited (a throw escaped). */
    unbalancedExits: number;
    tickHistogram: number[];
}

class WorkerTimeAccounting {
    private ticks = 0;
    private inTickMs = 0;
    private maxTickMs = 0;
    private requestedSleepMs = 0;
    private firstTickAtMs = -1;
    private tickEnteredAt = -1;
    private unbalancedExits = 0;

    private readonly nonTickMs = new Float64Array(KINDS.length);
    private readonly nonTickCalls = new Float64Array(KINDS.length);
    private readonly nonTickEnteredAt = new Float64Array(KINDS.length).fill(-1);
    private readonly nonTickDepth = new Int32Array(KINDS.length);
    private readonly tickHistogram = new Float64Array(TICK_BUCKETS_MS.length);

    /** Called from v86's tick_hooks_before, i.e. at the top of do_tick. */
    noteTickEnter(): void {
        const now = performance.now();
        if (this.firstTickAtMs < 0) this.firstTickAtMs = now;
        this.tickEnteredAt = now;
    }

    /**
     * Called from v86's tick_hooks_after, i.e. after main_loop returned and before
     * next_tick arms the yield. `delayMs` is main_loop's return — the sleep v86 is about
     * to ask for, which is what separates "parked on purpose" from "scheduling latency".
     */
    noteTickExit(delayMs: number): void {
        if (this.tickEnteredAt < 0) return; // hook pair broken; do not invent a duration
        const dt = performance.now() - this.tickEnteredAt;
        this.tickEnteredAt = -1;
        this.ticks++;
        this.inTickMs += dt;
        if (dt > this.maxTickMs) this.maxTickMs = dt;
        if (delayMs > 0) this.requestedSleepMs += delayMs;
        let b = 0;
        while (b < TICK_BUCKETS_MS.length - 1 && dt > TICK_BUCKETS_MS[b]!) b++;
        this.tickHistogram[b]!++;
    }

    /** Bracket a named non-tick region. Re-entrant: only the outermost pair is timed. */
    enterNonTick(kind: NonTickKind): void {
        const i = KINDS.indexOf(kind);
        if (i < 0) return;
        if (this.nonTickDepth[i]!++ === 0) this.nonTickEnteredAt[i] = performance.now();
    }

    exitNonTick(kind: NonTickKind): void {
        const i = KINDS.indexOf(kind);
        if (i < 0) return;
        const depth = this.nonTickDepth[i]!;
        if (depth <= 0) { this.unbalancedExits++; return; }
        this.nonTickDepth[i] = depth - 1;
        if (depth === 1) {
            this.nonTickMs[i]! += performance.now() - this.nonTickEnteredAt[i]!;
            this.nonTickCalls[i]!++;
            this.nonTickEnteredAt[i] = -1;
        }
    }

    /** Run `fn` inside a bracket, keeping the ledger balanced even when it throws. */
    measure<T>(kind: NonTickKind, fn: () => T): T {
        this.enterNonTick(kind);
        try { return fn(); } finally { this.exitNonTick(kind); }
    }

    snapshot(): WorkerTimeSnapshot {
        const nonTickMs = {} as Record<NonTickKind, number>;
        const nonTickCalls = {} as Record<NonTickKind, number>;
        for (let i = 0; i < KINDS.length; i++) {
            nonTickMs[KINDS[i]!] = this.nonTickMs[i]!;
            nonTickCalls[KINDS[i]!] = this.nonTickCalls[i]!;
        }
        return {
            atMs: performance.now(),
            firstTickAtMs: this.firstTickAtMs,
            ticks: this.ticks,
            inTickMs: this.inTickMs,
            maxTickMs: this.maxTickMs,
            requestedSleepMs: this.requestedSleepMs,
            nonTickMs,
            nonTickCalls,
            unbalancedExits: this.unbalancedExits,
            tickHistogram: Array.from(this.tickHistogram),
        };
    }

    /** The histogram's axis, so a reader never has to guess the bucket edges. */
    static bucketsMs(): number[] { return TICK_BUCKETS_MS.slice(); }

    /** Test seam: forget everything. Never called in production — the report windows by
     *  differencing two snapshots, because a reset would race every other reader. */
    resetForTest(): void {
        this.ticks = 0; this.inTickMs = 0; this.maxTickMs = 0; this.requestedSleepMs = 0;
        this.firstTickAtMs = -1; this.tickEnteredAt = -1; this.unbalancedExits = 0;
        this.nonTickMs.fill(0); this.nonTickCalls.fill(0);
        this.nonTickEnteredAt.fill(-1); this.nonTickDepth.fill(0);
        this.tickHistogram.fill(0);
    }
}

export const workerTime = new WorkerTimeAccounting();
export const TICK_BUCKET_EDGES_MS = TICK_BUCKETS_MS;
export const NON_TICK_KINDS = KINDS;
