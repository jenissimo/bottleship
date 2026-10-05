import { describe, expect, test } from "bun:test";
import { StatsOverlay, STATS_WINDOW_FRAMES, type OverlayCtx } from "../../src/worker/core/stats-overlay";

/**
 * The overlay is an instrument, so these tests are oracles, not smoke: every expected value
 * is a percentile/mean computable by hand from the synthetic sequence that produced it.
 *
 * The drawing is checked through a recording context that keeps the path ACROSS calls, the
 * way a real 2D context does — that is the only way the "background fill inherits last
 * redraw's polyline" bug is visible to a test.
 */

type Op = { op: string; args: number[] };

class RecordingCtx {
    ops: Op[] = [];
    text: Array<{ s: string; x: number; y: number }> = [];
    /** Path as the real context keeps it: cleared only by beginPath. */
    path: Op[] = [];
    /** Path contents observed at each fill()/stroke(). */
    fills: Op[][] = [];
    strokes: Op[][] = [];

    fillStyle: unknown = "";
    strokeStyle: unknown = "";
    lineWidth = 1;
    font = "";

    clearRect(...a: number[]) { this.ops.push({ op: "clearRect", args: a }); }
    fillRect(...a: number[]) { this.ops.push({ op: "fillRect", args: a }); }
    beginPath() { this.ops.push({ op: "beginPath", args: [] }); this.path = []; }
    roundRect(...a: number[]) { this.push("roundRect", a); }
    moveTo(...a: number[]) { this.push("moveTo", a); }
    lineTo(...a: number[]) { this.push("lineTo", a); }
    closePath() { this.push("closePath", []); }
    fill() { this.ops.push({ op: "fill", args: [] }); this.fills.push(this.path.slice()); }
    stroke() { this.ops.push({ op: "stroke", args: [] }); this.strokes.push(this.path.slice()); }
    fillText(s: string, x: number, y: number) { this.text.push({ s, x, y }); }
    createLinearGradient() { return { addColorStop() { } }; }

    private push(op: string, args: number[]) {
        this.ops.push({ op, args });
        this.path.push({ op, args });
    }

    reset() { this.ops = []; this.text = []; this.fills = []; this.strokes = []; }
    asCtx(): OverlayCtx { return this as unknown as OverlayCtx; }
    /** The whole panel as one string, for label assertions. */
    label(): string { return this.text.map(t => t.s).join(" "); }
}

function feed(o: StatsOverlay, samples: number[]): void {
    for (const ms of samples) o.updateMetrics(ms);
}

function armed(): StatsOverlay {
    const o = new StatsOverlay();
    o.setEnabled(true); // no OffscreenCanvas under bun — enabling is canvas-free by design
    return o;
}

describe("window ranks — a percentile is printed only when its rank is an observation", () => {
    test("the window is exactly the plot width, one sample per pixel column", () => {
        expect(STATS_WINDOW_FRAMES).toBe(148);
    });

    test("p99 needs >= 100 samples; 99 is n/a", () => {
        const o = armed();
        feed(o, Array.from({ length: 99 }, (_, i) => i + 1));
        const s = o.stats();
        expect(s.n).toBe(99);
        expect(s.p99Ms).toBeNull();
        expect(s.unavailable[0]).toContain("needs >= 100 samples");
    });

    test("at exactly 100 samples p99 is the 99th smallest — an observation, not an interpolation", () => {
        const o = armed();
        // 1..100 ms: k = ceil(0.99 * 100) = 99 -> the 99th smallest is 99ms.
        feed(o, Array.from({ length: 100 }, (_, i) => i + 1));
        const s = o.stats();
        expect(s.p99Ms).toBe(99);
        expect(s.maxMs).toBe(100);
        expect(s.minMs).toBe(1);
        expect(s.meanMs).toBeCloseTo(50.5, 10);
        expect(s.unavailable).toEqual([]);
    });

    test("one hitch in a full window is below the 1% rank and must NOT move p99", () => {
        const o = armed();
        // 147 x 10ms + 1 x 100ms. k = ceil(0.99 * 148) = 147 -> 147th smallest = 10ms.
        feed(o, [...Array.from({ length: 147 }, () => 10), 100]);
        const s = o.stats();
        expect(s.n).toBe(STATS_WINDOW_FRAMES);
        expect(s.p99Ms).toBe(10);
        // ...but the worst frame is reported under its own name, so the hitch is not hidden.
        expect(s.maxMs).toBe(100);
        expect(s.meanMs).toBeCloseTo((146 * 10 + 10 + 100) / 148, 10);
    });

    test("two hitches cross the 1% rank and p99 reports the hitch", () => {
        const o = armed();
        feed(o, [...Array.from({ length: 146 }, () => 10), 100, 100]);
        const s = o.stats();
        expect(s.p99Ms).toBe(100);
    });

    test("the ring evicts: only the newest 148 samples are in the window", () => {
        const o = armed();
        feed(o, Array.from({ length: 300 }, () => 33)); // fill with a steady cadence
        feed(o, Array.from({ length: STATS_WINDOW_FRAMES }, () => 20)); // then replace it whole
        const s = o.stats();
        expect(s.n).toBe(STATS_WINDOW_FRAMES);
        expect(s.minMs).toBe(20);
        expect(s.maxMs).toBe(20);
        expect(s.meanMs).toBe(20);
    });

    test("unusable intervals are refused and counted, never averaged in", () => {
        const o = armed();
        feed(o, [10, 0, -5, NaN, Infinity, 10]);
        const s = o.stats();
        expect(s.n).toBe(2);
        expect(s.meanMs).toBe(10);
        expect(s.rejected).toBe(4);
    });

    test("an empty window reports n/a, never a number", () => {
        const o = armed();
        const s = o.stats();
        expect(s.meanMs).toBeNull();
        expect(s.p99Ms).toBeNull();
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        expect(ctx.label()).toContain("n/a");
    });

    test("disabling clears the window so two disjoint periods are never stitched together", () => {
        const o = armed();
        feed(o, Array.from({ length: 50 }, () => 100));
        o.setEnabled(false);
        o.setEnabled(true);
        expect(o.stats().n).toBe(0);
        feed(o, [10, 10]);
        expect(o.stats().meanMs).toBe(10);
    });
});

describe("drawing — no path state leaks between redraws", () => {
    test("the background fill sees ONLY the background subpath, on every redraw", () => {
        const o = armed();
        feed(o, Array.from({ length: 148 }, (_, i) => 33 + (i % 7)));
        const ctx = new RecordingCtx();
        // Three redraws through ONE context: the bug only appears from the second onward,
        // because the first starts with an empty path.
        for (let pass = 0; pass < 3; pass++) {
            ctx.reset();
            o.drawInto(ctx.asCtx());
            expect(ctx.fills.length).toBeGreaterThanOrEqual(2);
            expect(ctx.fills[0]).toEqual([{ op: "roundRect", args: [0, 0, 160, 90, 4] }]);
        }
    });

    test("every fill and stroke is preceded by a beginPath with no foreign path ops", () => {
        const o = armed();
        feed(o, Array.from({ length: 60 }, (_, i) => 20 + (i % 3)));
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        o.drawInto(ctx.asCtx());
        // Walk the op log: after each fill/stroke the next path-building op must be preceded
        // by a beginPath.
        let sawPathOpSincePaint = false;
        let sawBeginSincePaint = true;
        for (const { op } of ctx.ops) {
            if (op === "beginPath") { sawBeginSincePaint = true; sawPathOpSincePaint = false; continue; }
            if (op === "fill" || op === "stroke") {
                expect(sawBeginSincePaint).toBe(true);
                sawBeginSincePaint = false;
                sawPathOpSincePaint = false;
                continue;
            }
            if (op === "roundRect" || op === "moveTo" || op === "lineTo" || op === "closePath") {
                expect(sawBeginSincePaint).toBe(true);
                sawPathOpSincePaint = true;
            }
        }
        expect(sawPathOpSincePaint).toBe(false);
    });
});

describe("graph geometry — the newest sample never moves", () => {
    const newestX = (o: StatsOverlay): number => {
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        const stroke = ctx.strokes[ctx.strokes.length - 1];
        return stroke[stroke.length - 1].args[0];
    };

    test("the trace is pinned to the right edge at every fill level", () => {
        const o = armed();
        const seen = new Set<number>();
        for (let i = 0; i < STATS_WINDOW_FRAMES + 40; i++) {
            o.updateMetrics(33);
            if (o.stats().n >= 2) seen.add(newestX(o));
        }
        // One and only one x for the newest sample, whatever the fill level: a left-anchored
        // trace would walk it across the panel while the window fills.
        expect([...seen]).toEqual([153]);
    });

    test("the oldest sample walks in from the right as the window fills, one column per frame", () => {
        const o = armed();
        const oldestX = () => {
            const ctx = new RecordingCtx();
            o.drawInto(ctx.asCtx());
            return ctx.strokes[ctx.strokes.length - 1][0].args[0];
        };
        feed(o, [33, 33]);
        expect(oldestX()).toBe(152);
        feed(o, Array.from({ length: 10 }, () => 33));
        expect(oldestX()).toBe(142);
        feed(o, Array.from({ length: 500 }, () => 33));
        expect(oldestX()).toBe(153 - (STATS_WINDOW_FRAMES - 1)); // 6 = the plot's left edge
    });

    test("all n samples are plotted — nothing is decimated or smoothed", () => {
        const o = armed();
        feed(o, Array.from({ length: 40 }, (_, i) => 20 + i));
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        expect(ctx.strokes[ctx.strokes.length - 1].length).toBe(40);
    });
});

describe("scale — legible, and never clipping a real excursion", () => {
    const scaleLabel = (o: StatsOverlay): string => {
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        return ctx.text.map(t => t.s).find(s => /^\d/.test(s) && s.includes("-")) ?? "";
    };
    const bounds = (o: StatsOverlay): [number, number] => {
        const [a, b] = scaleLabel(o).split("-");
        return [Number(a), Number(b)];
    };

    test("a sub-frame wobble at 30fps is not stretched over the full height", () => {
        const o = armed();
        for (let i = 0; i < 148; i++) o.updateMetrics(i % 2 === 0 ? 33.3 : 33.4);
        const [lo, hi] = bounds(o);
        // Data spans ~0.03 fps; the axis must be far wider than that, and printed.
        expect(hi - lo).toBeGreaterThanOrEqual(30 * 0.25);
        expect(lo).toBeLessThanOrEqual(30);
        expect(hi).toBeGreaterThanOrEqual(30);
    });

    test("a real hitch widens the axis to contain it — the excursion is never clipped", () => {
        const o = armed();
        feed(o, Array.from({ length: 100 }, () => 33.3));
        const steady = bounds(o);
        o.updateMetrics(200); // 5 fps
        const hitched = bounds(o);
        expect(hitched[0]).toBeLessThanOrEqual(5);
        expect(hitched[1]).toBeGreaterThanOrEqual(30);
        expect(hitched[1] - hitched[0]).toBeGreaterThan(steady[1] - steady[0]);
    });

    test("the axis is stable while the data stays inside it (hysteresis on the SCALE only)", () => {
        const o = armed();
        feed(o, Array.from({ length: 148 }, () => 33.3));
        const first = scaleLabel(o);
        for (let i = 0; i < 20; i++) {
            o.updateMetrics(33.3 + (i % 5) * 0.05);
            expect(scaleLabel(o)).toBe(first);
        }
    });
});

describe("panel labels", () => {
    test("the printed window matches the sample count and the wall time it spans", () => {
        const o = armed();
        feed(o, Array.from({ length: 100 }, () => 20)); // exactly 2.0 s
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        expect(ctx.text.some(t => t.s === "100f 2.0s")).toBe(true);
    });

    test("the tail row is labelled 1% / min, and 1% reads n/a below its rank", () => {
        const o = armed();
        feed(o, Array.from({ length: 50 }, () => 25));
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        const labels = ctx.text.map(t => t.s);
        expect(labels).toContain("1%");
        expect(labels).toContain("min");
        expect(labels).not.toContain("0.1%");
        // 50 samples: 1% is n/a, min is the observed worst frame (40 fps from 25ms).
        expect(labels.filter(s => s === "n/a").length).toBe(1);
        expect(labels).toContain("40");
    });

    test("rejected intervals are surfaced on the panel, not swallowed", () => {
        const o = armed();
        feed(o, [10, 0, 10]);
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        expect(ctx.text.some(t => t.s === "!1")).toBe(true);
    });
});

describe("degenerate inputs cannot wedge the axis walk", () => {
    test("a sub-microsecond interval (millions of fps) still terminates and prints a scale", () => {
        const o = new StatsOverlay();
        o.setEnabled(true);
        feed(o, [0.0001, 16.6, 0.0002, 16.6]);
        const ctx = new RecordingCtx();
        o.drawInto(ctx.asCtx());
        const scale = ctx.text.map(t => t.s).find(s => /^\d/.test(s) && s.includes("-"));
        expect(scale).toBeDefined();
        expect(Number(scale!.split("-")[1])).toBeGreaterThanOrEqual(1e7);
    });
});

describe("colour banding", () => {
    // A title pinned at its own 30fps cadence lands on 30.03 / 29.94 fps from one frame to
    // the next. Without hysteresis that repaints a different colour every redraw.
    test("a value parked on a threshold does not change band", () => {
        const o = armed();
        const band = (v: number) => (o as any).band("t", v, [30]);
        const seen = new Set<number>();
        for (const v of [30.03, 29.94, 30.03, 29.94, 30.01, 29.97]) seen.add(band(v));
        expect(seen.size).toBe(1);
    });

    test("a real change of regime still changes band", () => {
        const o = armed();
        const band = (v: number) => (o as any).band("t", v, [30]);
        expect(band(29.9)).toBe(0);
        expect(band(45)).toBe(1);   // well clear of the threshold
        expect(band(20)).toBe(0);   // and back
    });
});
