/**
 * Worker-side frame-time overlay: collects inter-present intervals and renders them to an
 * OffscreenCanvas (160×90) that the present paths composite at top-right.
 *
 * It is an INSTRUMENT, so the labels must be literally true:
 *  - ONE window backs both the numbers and the graph, and the panel prints its size and the
 *    wall time it spans — a spike cannot show in the graph but be missing from the numbers.
 *  - The window is exactly as wide as the plot in pixels, so every sample owns one column.
 *    Nothing is averaged, decimated or damped on the way to the screen; a frame that
 *    oscillates must look like it oscillates.
 *  - A percentile is printed only when its defining rank is an actual observation
 *    (n * (1 - p) >= 1), otherwise "n/a" — same rule and vocabulary as the frame-tail report
 *    in frame-time-distribution.ts / analyze-trace.ts. 0.1% would need 1000 samples, which a
 *    148-frame window cannot support, so the second slot reports the observed worst frame
 *    under its own name ("min") instead of a rank nothing stands behind.
 *  - The vertical scale is printed next to the graph, because an autoscaled trace with no
 *    axis is a picture that cannot be wrong.
 */

/** Panel geometry. WINDOW is derived from the plot width: one sample, one pixel column. */
const CANVAS_W = 160;
const CANVAS_H = 90;
const PLOT_X0 = 6;
const PLOT_X1 = 153;
const PLOT_Y0 = 44;
const PLOT_H = 42;
export const STATS_WINDOW_FRAMES = PLOT_X1 - PLOT_X0 + 1; // 148

/** The rank must be backed by an observation: n * (1 - p) >= 1. */
const P_LOW = 0.99;
const P_LOW_MIN_SAMPLES = Math.ceil(1 / (1 - P_LOW)); // 100

/** Redraw at most this often. The window advances one column per present, so at ordinary
 *  cadences this is "every present"; the cap only bites on a title running far above the
 *  refresh rate, where extra redraws would cost the guest and show nobody anything. */
const REDRAW_MIN_INTERVAL_MS = 16;

/** Monospace advance per px of font size — enough to right-align without measureText
 *  (which would force every test double to implement TextMetrics). */
const MONO_ADVANCE = 0.6;

const NICE_STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000];

export type OverlayCtx = Pick<
    OffscreenCanvasRenderingContext2D,
    | "clearRect" | "beginPath" | "roundRect" | "fill" | "fillRect" | "fillText"
    | "moveTo" | "lineTo" | "closePath" | "stroke" | "createLinearGradient"
    | "fillStyle" | "strokeStyle" | "lineWidth" | "font"
>;

export type OverlayStats = {
    /** Samples currently in the window. */
    n: number;
    /** Wall time the window spans, in ms (the sum of its intervals). */
    windowMs: number;
    meanMs: number | null;
    /** Worst frame in the window — an observation, not a rank. */
    maxMs: number | null;
    minMs: number | null;
    /** 99th-percentile frame time, or null when the window is too small for that rank. */
    p99Ms: number | null;
    /** Why p99 is null, in words. Empty when it is available. */
    unavailable: string[];
    /** Intervals refused as unusable (non-finite or <= 0). Never silently folded in. */
    rejected: number;
};

export class StatsOverlay {
    private enabled = false;
    private canvas: OffscreenCanvas | null = null;
    private ctx: OffscreenCanvasRenderingContext2D | null = null;
    private dirty = false;

    // Single ring of inter-present intervals (ms) behind both the numbers and the graph.
    private frameTimes = new Float64Array(STATS_WINDOW_FRAMES);
    private frameIdx = 0;
    private frameCount = 0;
    private rejected = 0;

    private lastRedrawTime = 0;
    private sortBuf = new Float64Array(STATS_WINDOW_FRAMES);

    // Axis kept across redraws so it only moves when the data leaves it — hysteresis on the
    // SCALE, never on the samples.
    private axisLo = 0;
    private axisHi = 0;

    setEnabled(on: boolean): void {
        if (on === this.enabled) return;
        this.enabled = on;
        // A window must describe one continuous period: never stitch across a disable.
        this.reset();
        if (on) this.ensureCanvas();
        else this.dirty = false;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    getCanvas(): OffscreenCanvas | null {
        if (this.enabled) this.ensureCanvas();
        return this.canvas;
    }

    isDirty(): boolean {
        return this.dirty;
    }

    clearDirty(): void {
        this.dirty = false;
    }

    reset(): void {
        this.frameIdx = 0;
        this.frameCount = 0;
        this.rejected = 0;
        this.lastRedrawTime = 0;
        this.axisLo = 0;
        this.axisHi = 0;
    }

    private ensureCanvas(): void {
        if (this.canvas || typeof OffscreenCanvas === "undefined") return;
        this.canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
        this.ctx = this.canvas.getContext("2d");
        this.dirty = true;
    }

    /** Called once per present with the interval since the previous present, in ms. */
    updateMetrics(frameMs: number): void {
        if (!this.enabled) return;

        if (!(frameMs > 0) || !Number.isFinite(frameMs)) {
            // 0 would be an infinite fps and a negative/NaN interval is a caller bug; either
            // way it is not a frame, so it is counted and shown, never averaged in.
            this.rejected++;
            return;
        }

        this.frameTimes[this.frameIdx] = frameMs;
        this.frameIdx = (this.frameIdx + 1) % STATS_WINDOW_FRAMES;
        if (this.frameCount < STATS_WINDOW_FRAMES) this.frameCount++;

        const now = performance.now();
        if (now - this.lastRedrawTime >= REDRAW_MIN_INTERVAL_MS) {
            this.lastRedrawTime = now;
            this.redraw();
        }
    }

    /** The window as reported — same numbers the panel prints. */
    /**
     * The window's inter-present intervals in CHRONOLOGICAL order.
     *
     * stats() answers "how bad", which a histogram can do; this answers "in what pattern",
     * which it cannot. A frame-pacing oscillation is a property of the SEQUENCE — period and
     * phase — and every summary in this file destroys exactly that. The ring is already one
     * sample per present with nothing decimated, so it is the raw series; this just unrolls
     * it oldest-first so a caller does not have to know where the write head is.
     */
    samples(): number[] {
        const n = this.frameCount;
        if (n === 0) return [];
        const out: number[] = new Array(n);
        // Once the ring is full the oldest sample sits AT the write head; before that the
        // buffer is still linear from 0.
        const start = n < STATS_WINDOW_FRAMES ? 0 : this.frameIdx;
        for (let i = 0; i < n; i++) out[i] = this.frameTimes[(start + i) % STATS_WINDOW_FRAMES];
        return out;
    }

    /** Last band per colour slot, so the choice is sticky across redraws. */
    private bands: Record<string, number> = {};

    /**
     * Which band `value` falls in, with a dead zone around every threshold.
     *
     * Moving UP requires exceeding the threshold by `margin`; moving DOWN requires falling
     * below it by the same. A value parked on a boundary therefore keeps whichever band it
     * already had instead of alternating. This is presentation only — no sample is altered,
     * smoothed or withheld, so a real change of regime still changes the colour, one frame
     * of margin later.
     */
    private band(slot: string, value: number, thresholds: number[], margin = 1): number {
        const prev = this.bands[slot] ?? -1;
        let next = 0;
        for (let i = 0; i < thresholds.length; i++) {
            const t = thresholds[i]!;
            // Already at or above this band: hold it until the value drops a full margin below.
            const cutoff = prev > i ? t - margin : t + margin;
            if (value >= cutoff) next = i + 1;
        }
        this.bands[slot] = next;
        return next;
    }

    stats(): OverlayStats {
        const n = this.frameCount;
        if (n === 0) {
            return {
                n: 0, windowMs: 0, meanMs: null, maxMs: null, minMs: null, p99Ms: null,
                unavailable: ["no samples in the window"], rejected: this.rejected,
            };
        }

        const buf = this.sortBuf;
        let sum = 0, min = Infinity, max = 0;
        for (let i = 0; i < n; i++) {
            const v = this.frameTimes[i];
            buf[i] = v;
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
        }

        const unavailable: string[] = [];
        let p99Ms: number | null = null;
        if (n < P_LOW_MIN_SAMPLES) {
            unavailable.push(
                `p99: needs >= ${P_LOW_MIN_SAMPLES} samples for its rank to be an observation, have ${n}`,
            );
        } else {
            const slice = buf.subarray(0, n);
            slice.sort(); // Float64Array.sort IS numeric — no comparator needed.
            // Nearest rank, 1-based: the k-th smallest sample, k = ceil(p * n).
            p99Ms = slice[Math.ceil(P_LOW * n) - 1];
        }

        return {
            n, windowMs: sum, meanMs: sum / n, maxMs: max, minMs: min, p99Ms,
            unavailable, rejected: this.rejected,
        };
    }

    private redraw(): void {
        if (!this.ctx) this.ensureCanvas();
        if (!this.ctx) return;
        this.drawInto(this.ctx);
        this.dirty = true;
    }

    /**
     * Render the panel. Every redraw starts a fresh path before the first fill: a path left
     * over from the previous redraw joins the background subpath, and under the nonzero
     * winding rule an opposite-wound leftover punches a HOLE through the panel.
     */
    drawInto(ctx: OverlayCtx): void {
        const s = this.stats();
        const fpsMean = s.meanMs !== null ? 1000 / s.meanMs : null;
        const fpsLow = s.p99Ms !== null ? 1000 / s.p99Ms : null;
        const fpsMin = s.maxMs !== null ? 1000 / s.maxMs : null;

        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

        ctx.beginPath();
        ctx.roundRect(0, 0, CANVAS_W, CANVAS_H, 4);
        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
        ctx.fill();

        // Hysteresis on the COLOUR, never on the samples. A title pinned at its own 30 fps
        // cadence sits exactly on the 30 threshold — 33.3 ms reads 30.03 fps and 33.4 ms reads
        // 29.94 — so a bare comparison repaints a different colour every redraw and the panel
        // strobes while nothing is wrong. Widening the band a value must cross to change
        // colour costs nothing in fidelity: the number beside it still moves, and the graph
        // still shows every excursion.
        const fpsColor = fpsMean === null ? "#94a3b8"
            : ["#f87171", "#facc15", "#4ade80"][this.band("mean", fpsMean, [30, 55])]!;

        // Row 1 — mean fps and the mean frame time it is the reciprocal of.
        ctx.font = "bold 11px monospace";
        ctx.fillStyle = "#94a3b8";
        ctx.fillText("FPS", 6, 15);
        ctx.font = "bold 15px monospace";
        ctx.fillStyle = fpsColor;
        ctx.fillText(fpsMean === null ? "n/a" : Math.round(fpsMean).toString(), 34, 15);

        ctx.font = "11px monospace";
        ctx.fillStyle = "#94a3b8";
        ctx.fillText("ft", 88, 15);
        ctx.fillStyle = "#e2e8f0";
        ctx.fillText(s.meanMs === null ? "n/a" : s.meanMs.toFixed(1) + "ms", 104, 15);

        // Row 2 — the tail. "1%" is the p99 frame time; "min" is the observed worst frame,
        // named for what it is because no rank finer than 1% fits this window.
        ctx.font = "11px monospace";
        ctx.fillStyle = "#94a3b8";
        ctx.fillText("1%", 6, 30);
        ctx.fillStyle = fpsLow === null ? "#64748b" : (this.band("low", fpsLow, [30]) ? "#86efac" : "#fca5a5");
        ctx.fillText(fpsLow === null ? "n/a" : Math.round(fpsLow).toString(), 26, 30);

        ctx.fillStyle = "#94a3b8";
        ctx.fillText("min", 62, 30);
        ctx.fillStyle = fpsMin === null ? "#64748b" : fpsMin >= 20 ? "#86efac" : "#fca5a5";
        ctx.fillText(fpsMin === null ? "n/a" : Math.round(fpsMin).toString(), 88, 30);

        // Row 3 — the window the two rows above and the graph below all describe.
        ctx.font = "9px monospace";
        ctx.fillStyle = "#64748b";
        ctx.fillText(`${s.n}f ${(s.windowMs / 1000).toFixed(1)}s`, 6, 40);

        if (s.rejected > 0) {
            ctx.fillStyle = "#f87171";
            ctx.fillText(`!${s.rejected}`, 6 + 10 * 9 * MONO_ADVANCE, 40);
        }

        this.drawGraph(ctx, fpsColor);
    }

    private drawGraph(ctx: OverlayCtx, strokeColor: string): void {
        const n = this.frameCount;
        const bottom = PLOT_Y0 + PLOT_H;

        // Baseline: without it an empty or one-sample graph is indistinguishable from a
        // panel that failed to draw.
        ctx.fillStyle = "rgba(148, 163, 184, 0.25)";
        ctx.fillRect(PLOT_X0, bottom, PLOT_X1 - PLOT_X0 + 1, 1);

        if (n < 2) return;

        let lo = Infinity, hi = -Infinity, sum = 0;
        for (let i = 0; i < n; i++) {
            const fps = 1000 / this.frameTimes[i];
            if (fps < lo) lo = fps;
            if (fps > hi) hi = fps;
            sum += fps;
        }
        const [axisLo, axisHi] = this.updateAxis(lo, hi, sum / n);
        const range = axisHi - axisLo;

        // Newest sample is pinned to the right edge and the trace grows leftwards, so a point
        // never moves horizontally as the window fills — a left-anchored trace with a
        // full-window step marches across the panel for its first 148 frames.
        const startIdx = (this.frameIdx - n + STATS_WINDOW_FRAMES) % STATS_WINDOW_FRAMES;
        const xOf = (i: number) => PLOT_X1 - (n - 1 - i);
        const yOf = (i: number) => {
            const fps = 1000 / this.frameTimes[(startIdx + i) % STATS_WINDOW_FRAMES];
            const t = Math.min(1, Math.max(0, (fps - axisLo) / range));
            return bottom - t * PLOT_H;
        };

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = xOf(i), y = yOf(i);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineTo(xOf(n - 1), bottom);
        ctx.lineTo(xOf(0), bottom);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, PLOT_Y0, 0, bottom);
        grad.addColorStop(0, "rgba(74, 222, 128, 0.3)");
        grad.addColorStop(1, "rgba(74, 222, 128, 0.02)");
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = xOf(i), y = yOf(i);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1;
        ctx.stroke();

        // The axis in numbers: an autoscaled trace without one cannot misreport magnitude
        // because it claims no magnitude at all.
        const label = `${fmtScale(axisLo)}-${fmtScale(axisHi)}`;
        ctx.font = "9px monospace";
        ctx.fillStyle = "#64748b";
        ctx.fillText(label, PLOT_X1 + 1 - label.length * 9 * MONO_ADVANCE, 40);
    }

    /**
     * Axis for [lo, hi]. Snapped outward to a round step and never narrower than a quarter of
     * the mean, so a sub-frame wobble is not stretched over the full height — but it is only
     * ever WIDENED to fit the data, never clipped to hide an excursion.
     */
    private updateAxis(lo: number, hi: number, mean: number): [number, number] {
        const [a, b] = this.computeAxis(lo, hi, mean);
        // Keep the standing axis while it still contains the data and is not grossly wider
        // than the one the data now asks for: an axis recomputed every redraw jitters by a
        // step and reads as movement that is not in the samples.
        const cur = this.axisHi - this.axisLo;
        if (cur > 0 && lo >= this.axisLo && hi <= this.axisHi && cur <= 2 * (b - a)) {
            return [this.axisLo, this.axisHi];
        }
        this.axisLo = a;
        this.axisHi = b;
        return [a, b];
    }

    private computeAxis(lo: number, hi: number, mean: number): [number, number] {
        const need = Math.max(hi - lo, mean * 0.25, 1);
        const step = niceStep(need / 4);
        let a = Math.max(0, Math.floor(lo / step) * step);
        let b = Math.ceil(hi / step) * step;
        while (b - a < need) {
            b += step;
            if (b - a < need && a > 0) a = Math.max(0, a - step);
        }
        if (b <= a) b = a + step;
        return [a, b];
    }
}

function niceStep(x: number): number {
    for (const s of NICE_STEPS) if (s >= x) return s;
    // Past the ladder, keep growing by decades: a step that stops growing turns the axis
    // walk into thousands of iterations on an absurd (but finite) interval.
    return Math.pow(10, Math.ceil(Math.log10(x)));
}

function fmtScale(v: number): string {
    return Number.isInteger(v) ? v.toString() : v.toFixed(1);
}

export const statsOverlay = new StatsOverlay();
