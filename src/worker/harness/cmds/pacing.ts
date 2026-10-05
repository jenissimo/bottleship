/**
 * Frame-pacing readout: the inter-present intervals as a SEQUENCE, plus what that
 * sequence's shape implies.
 *
 * `frameReport` answers "how bad" — percentiles, buckets, frames over budget. It cannot
 * answer "in what pattern", because every summary in it destroys ordering. A pacing
 * oscillation is a property of the sequence: a beat between two clocks drifts and snaps
 * with a period, and that period is the fingerprint that says WHICH pair of our constants
 * produced it. So this verb hands back the raw series and a small amount of arithmetic
 * over it, and deliberately does not smooth anything.
 *
 * The series comes from the stats overlay's ring, which records one sample per present
 * with nothing decimated (`statsOverlay.samples()`), so it must be enabled to collect —
 * the report says so rather than returning an empty series that reads as "no jitter".
 */

import { statsOverlay } from "../../core/stats-overlay";
import type { HarnessService } from "../service";

/** Mean, and the mean absolute deviation from it — a jitter measure that does not assume a shape. */
function centre(xs: number[]): { meanMs: number; madMs: number; minMs: number; maxMs: number } {
    let sum = 0, min = Infinity, max = 0;
    for (const x of xs) { sum += x; if (x < min) min = x; if (x > max) max = x; }
    const meanMs = sum / xs.length;
    let dev = 0;
    for (const x of xs) dev += Math.abs(x - meanMs);
    return { meanMs, madMs: dev / xs.length, minMs: min, maxMs: max };
}

/**
 * Dominant period of the oscillation, in FRAMES, by autocorrelation of the mean-removed
 * series. Returns null when no lag beats the noise — an honest "no periodicity found"
 * rather than the argmax of a flat curve, which would always name something.
 */
function dominantPeriod(xs: number[], meanMs: number): { lagFrames: number; strength: number } | null {
    const n = xs.length;
    if (n < 16) return null;
    const d = xs.map((x) => x - meanMs);
    let energy = 0;
    for (const v of d) energy += v * v;
    if (energy <= 0) return null;

    const maxLag = Math.floor(n / 2);
    let bestLag = 0, bestR = 0;
    for (let lag = 2; lag <= maxLag; lag++) {
        let acc = 0;
        for (let i = 0; i + lag < n; i++) acc += d[i]! * d[i + lag]!;
        const r = acc / energy;
        if (r > bestR) { bestR = r; bestLag = lag; }
    }
    // A genuine beat correlates strongly with itself one period away. Below this the
    // "best" lag is just the largest of many equally meaningless numbers.
    return bestR >= 0.2 ? { lagFrames: bestLag, strength: +bestR.toFixed(3) } : null;
}

export function registerPacingCommands(svc: HarnessService): void {
    /**
     * framePacing() — the raw inter-present series and its shape.
     *
     * Read `series` when you want to plot or fit it yourself; read `period` when you want
     * the beat's fingerprint. `armed:false` means the overlay was not collecting, which is
     * NOT the same as "the pacing was smooth".
     */
    svc.register("framePacing", () => {
        if (!statsOverlay.isEnabled()) {
            return {
                armed: false,
                reason: "stats overlay is off, so no per-present samples are being recorded — "
                    + "enable it and let the window fill before reading. An empty series here "
                    + "means 'not measured', never 'no jitter'.",
                series: [],
            };
        }
        const series = statsOverlay.samples().map((v) => +v.toFixed(3));
        if (series.length === 0) {
            return { armed: true, n: 0, reason: "overlay armed but no presents recorded yet", series };
        }
        const c = centre(series);
        const period = dominantPeriod(series, c.meanMs);
        return {
            armed: true,
            n: series.length,
            windowMs: +series.reduce((a, b) => a + b, 0).toFixed(1),
            meanMs: +c.meanMs.toFixed(3),
            /** Mean absolute deviation: how far a typical frame sits from the mean. */
            jitterMadMs: +c.madMs.toFixed(3),
            minMs: +c.minMs.toFixed(3),
            maxMs: +c.maxMs.toFixed(3),
            /** Peak-to-peak of the whole window; with a beat this is the swing, not an outlier. */
            spreadMs: +(c.maxMs - c.minMs).toFixed(3),
            period,
            periodNote: period
                ? `dominant lag ${period.lagFrames} frames (~${(period.lagFrames * c.meanMs).toFixed(0)} ms), autocorrelation ${period.strength}`
                : "no lag correlated above 0.2 — the variation is not periodic at this window length, or the window is too short to see its period",
            series,
        };
    });

    /**
     * presentAudit({frames}) — who presents the WebGPU canvas, and how often per display refresh.
     *
     * The swap chain is the one resource every presenter shares, and nothing in the frame
     * accounting counts a presentation: the categories say "present: 33ms" whether that is one
     * honest vsync wait or two presentations per refresh serializing against each other. This
     * verb counts them at the only chokepoint they all pass through — getCurrentTexture() — and
     * names the caller, so "we present the canvas twice per refresh" is a reading rather than a
     * deduction from a stack trace taken by hand.
     *
     * `rafIntervalsMs` is the worker's OWN animation-frame delivery over the same window. A
     * worker rAF that drops vsyncs while the worker is idle is the signature of canvas
     * back-pressure, and it is invisible to every present-side instrument.
     */
    svc.register("presentAudit", async (args) => {
        const opts = (args[0] ?? {}) as { frames?: number };
        const frames = Math.max(4, Math.min(240, Math.floor(opts.frames ?? 60)));
        const ctxProto = (globalThis as { GPUCanvasContext?: { prototype: GPUCanvasContext } }).GPUCanvasContext?.prototype;
        if (!ctxProto) throw new Error("presentAudit: no GPUCanvasContext in this worker");

        const perFrame: number[] = [];
        const byCaller = new Map<string, number>();
        let inFrame = 0;
        const orig = ctxProto.getCurrentTexture;
        ctxProto.getCurrentTexture = function (this: GPUCanvasContext) {
            inFrame++;
            // Frame 3 of the stack is getCurrentTexture's caller; a presenter is identified by
            // its method, not its file, so the label survives a bundler renaming chunks.
            const line = (new Error().stack ?? "").split("\n")[2] ?? "?";
            const name = line.trim().replace(/^at\s+/, "").replace(/\s*\(.*$/, "") || "?";
            byCaller.set(name, (byCaller.get(name) ?? 0) + 1);
            return orig.apply(this) as GPUTexture;
        };

        const rafMs: number[] = [];
        try {
            await new Promise<void>((resolve) => {
                let n = 0;
                let last = 0;
                const tick = () => {
                    const now = performance.now();
                    if (last > 0) { rafMs.push(+(now - last).toFixed(2)); perFrame.push(inFrame); }
                    last = now;
                    inFrame = 0;
                    if (++n <= frames) requestAnimationFrame(tick); else resolve();
                };
                requestAnimationFrame(tick);
            });
        } finally {
            ctxProto.getCurrentTexture = orig;
        }

        const refreshMs = rafMs.length ? rafMs.slice().sort((a, b) => a - b)[rafMs.length >> 1]! : 0;
        const dropped = rafMs.filter((ms) => ms > refreshMs * 1.5).length;
        const total = perFrame.reduce((a, b) => a + b, 0);
        return {
            frames: perFrame.length,
            /** Canvas presentations per animation frame. >1 means presenters are competing for the swap chain. */
            presentsPerFrame: perFrame.length ? +(total / perFrame.length).toFixed(2) : 0,
            presentsTotal: total,
            byCaller: Object.fromEntries([...byCaller].sort((a, b) => b[1] - a[1])),
            rafMedianMs: +refreshMs.toFixed(2),
            rafDroppedFrames: dropped,
            rafIntervalsMs: rafMs,
            note: "getCurrentTexture() is counted, not presentations the compositor accepted: two calls in ONE "
                + "task are one presentation. Read it with the callers — separate presenters are separate tasks.",
        };
    });
}
