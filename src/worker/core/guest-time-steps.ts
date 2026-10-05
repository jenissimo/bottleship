/**
 * GUEST-clock advance per frame — the dt the game itself observes, not the wall time we spent.
 *
 * `guestTime`/`virtualTimeSources` answer "is the guest clock running at the right RATE over a
 * window". That is a mean, and a mean of 1.000 is exactly what a stall produces: the clock is
 * faithful to wall time, and the guest still gets handed one enormous delta. CLAUDE.md §3.5 says
 * this in words ("the 16ms cap bounds ONE credit, NOT the delta a game observes between two clock
 * reads"); nothing measured it. A title that integrates `dt` per frame — an animation, a cutscene
 * timer, a physics step — advances by whatever single delta it is given, so the MAXIMUM step is
 * the quantity that decides whether it skips, and the mean cannot express it.
 *
 * Sampling boundary is the present, because that is where a frame-paced title reads its clock:
 * the delta between two consecutive presents' guest-clock values is (to within one frame's worth
 * of intra-frame reads) the dt the game's own timer computes.
 *
 * Both clocks are recorded per sample, so a large step reads as one of two different bugs:
 *   guestMs ~= wallMs   -> we really did stall that long; the guest was handed an honest delta.
 *   guestMs >> wallMs   -> we FABRICATED time (a credit path over-crediting).
 *
 * O(1) and allocation-free per present (the top-N list is a fixed array of preallocated rows),
 * and completely inert while disarmed — it runs on the guest's own worker thread.
 */

import { TimeService } from "../runtime/time";
import { frameBucketIndex, frameBucketLo, frameBucketHi, FRAME_BUCKET_COUNT } from "./frame-time-distribution";

const TOP_N = 8;

export type GuestStepRow = {
    /** Present serial the step ENDED on. */
    serial: number;
    /** Guest-clock advance across the frame — the dt a dt-driven title integrates. */
    guestMs: number;
    /** Wall-clock advance across the same frame. */
    wallMs: number;
    /** Guest clock at the end of the step (ms since boot of the virtual clock). */
    atGuestMs: number;
    /** Wall clock at the end of the step. */
    atWallMs: number;
};

export type GuestStepsReport =
    | {
        ok: false;
        status: "disabled" | "no-samples";
        note: string;
        sampleCount: number;
    }
    | {
        ok: true;
        status: "ok";
        sampleCount: number;
        /** Span of the window on each clock. */
        guestSpanMs: number;
        wallSpanMs: number;
        /** guestSpanMs / wallSpanMs — the RATE the mean-based verbs report. */
        rate: number;
        meanGuestMs: number;
        maxGuestMs: number;
        maxWallMs: number;
        /** Steps at/above these thresholds — a title's own dt sanity checks live here. */
        over100Ms: number;
        over250Ms: number;
        over1000Ms: number;
        /** Sum of (guestMs - budgetMs) over steps above the budget: how much game time was
         *  delivered in lumps rather than in frames. */
        lumpedMsOverBudget: number;
        budgetMs: number;
        /** The largest steps, worst first — each with its wall twin, so "we stalled" and
         *  "we invented time" are distinguishable without a second run. */
        top: GuestStepRow[];
        buckets: Array<{ loMs: number; hiMs: number; count: number }>;
    };

class GuestTimeSteps {
    private armed = false;
    private readonly counts = new Int32Array(FRAME_BUCKET_COUNT);
    private n = 0;
    private sumGuest = 0;
    private sumWall = 0;
    private maxGuest = 0;
    private maxWall = 0;
    private over100 = 0;
    private over250 = 0;
    private over1000 = 0;
    private budgetMs = 100;
    private lumped = 0;

    private prevGuest = 0;
    private prevWall = 0;

    /** Fixed top-N, kept sorted worst-first. Preallocated so the hot path never allocates. */
    private readonly top: GuestStepRow[] = Array.from({ length: TOP_N }, () => ({
        serial: 0, guestMs: 0, wallMs: 0, atGuestMs: 0, atWallMs: 0,
    }));
    private topUsed = 0;

    isArmed(): boolean {
        return this.armed;
    }

    /** Arm (and always start a fresh window — a window that spans a disarm is not a window). */
    arm(budgetMs?: number): void {
        this.reset();
        if (budgetMs !== undefined && budgetMs > 0) this.budgetMs = budgetMs;
        this.armed = true;
    }

    disarm(): void {
        this.armed = false;
    }

    reset(): void {
        this.counts.fill(0);
        this.n = 0;
        this.sumGuest = 0;
        this.sumWall = 0;
        this.maxGuest = 0;
        this.maxWall = 0;
        this.over100 = 0;
        this.over250 = 0;
        this.over1000 = 0;
        this.lumped = 0;
        this.topUsed = 0;
        this.prevGuest = 0;
        this.prevWall = 0;
    }

    /** One present boundary. Called unconditionally from the present path; returns immediately
     *  when disarmed so the instrument costs a load and a branch. */
    markPresent(serial: number): void {
        if (!this.armed) return;
        const g = TimeService.getInstance().nowMs();
        const w = performance.now();
        if (this.prevWall !== 0) {
            const dg = g - this.prevGuest;
            const dw = w - this.prevWall;
            // A negative guest delta means the clock was re-anchored backwards (pause/resume);
            // it is not a step the guest integrates, so it is not a sample.
            if (dg >= 0) this.record(serial, dg, dw, g, w);
        }
        this.prevGuest = g;
        this.prevWall = w;
    }

    private record(serial: number, dg: number, dw: number, atG: number, atW: number): void {
        this.counts[frameBucketIndex(dg)]++;
        this.n++;
        this.sumGuest += dg;
        this.sumWall += dw;
        if (dg > this.maxGuest) this.maxGuest = dg;
        if (dw > this.maxWall) this.maxWall = dw;
        if (dg >= 100) this.over100++;
        if (dg >= 250) this.over250++;
        if (dg >= 1000) this.over1000++;
        if (dg > this.budgetMs) this.lumped += dg - this.budgetMs;

        if (this.topUsed < TOP_N) {
            this.insertTop(this.topUsed++, serial, dg, dw, atG, atW);
        } else if (dg > this.top[TOP_N - 1].guestMs) {
            this.insertTop(TOP_N - 1, serial, dg, dw, atG, atW);
        }
    }

    /** Write into slot `slot` then bubble it up to keep the list sorted worst-first. */
    private insertTop(slot: number, serial: number, dg: number, dw: number, atG: number, atW: number): void {
        const row = this.top[slot];
        row.serial = serial; row.guestMs = dg; row.wallMs = dw; row.atGuestMs = atG; row.atWallMs = atW;
        for (let i = slot; i > 0 && this.top[i].guestMs > this.top[i - 1].guestMs; i--) {
            const t = this.top[i]; this.top[i] = this.top[i - 1]; this.top[i - 1] = t;
        }
    }

    report(maxBuckets = 24): GuestStepsReport {
        if (!this.armed) {
            return {
                ok: false, status: "disabled", sampleCount: this.n,
                note: "guest-step recorder is not armed — no window exists. guestSteps({arm:true}) first.",
            };
        }
        if (this.n === 0) {
            return {
                ok: false, status: "no-samples", sampleCount: 0,
                note: "armed but no presents recorded — the title may not be presenting (check flipCadence).",
            };
        }
        const rows: Array<{ loMs: number; hiMs: number; count: number }> = [];
        for (let i = 0; i < FRAME_BUCKET_COUNT; i++) {
            if (this.counts[i] === 0) continue;
            rows.push({ loMs: r2(frameBucketLo(i)), hiMs: frameBucketHi(i), count: this.counts[i] });
        }
        let buckets = rows;
        if (rows.length > maxBuckets) {
            buckets = rows.slice().sort((a, b) => b.count - a.count).slice(0, maxBuckets).sort((a, b) => a.loMs - b.loMs);
        }
        return {
            ok: true, status: "ok",
            sampleCount: this.n,
            guestSpanMs: r2(this.sumGuest),
            wallSpanMs: r2(this.sumWall),
            rate: r2(this.sumWall > 0 ? this.sumGuest / this.sumWall : 0),
            meanGuestMs: r2(this.sumGuest / this.n),
            maxGuestMs: r2(this.maxGuest),
            maxWallMs: r2(this.maxWall),
            over100Ms: this.over100,
            over250Ms: this.over250,
            over1000Ms: this.over1000,
            lumpedMsOverBudget: r2(this.lumped),
            budgetMs: this.budgetMs,
            top: this.top.slice(0, this.topUsed).map((r) => ({
                serial: r.serial,
                guestMs: r2(r.guestMs),
                wallMs: r2(r.wallMs),
                atGuestMs: r2(r.atGuestMs),
                atWallMs: r2(r.atWallMs),
            })),
            buckets,
        };
    }
}

function r2(v: number): number {
    return Math.round(v * 100) / 100;
}

export const guestTimeSteps = new GuestTimeSteps();
