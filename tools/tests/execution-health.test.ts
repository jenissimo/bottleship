import { describe, expect, test } from "bun:test";
import {
    ExecutionHealth, SlowExecutionDetector, effectiveJit, jitReason, measureWindow, smoothMips,
    SAMPLE_INTERVAL_MS, SLOW_MIPS_RECOVER, SLOW_MIPS_THRESHOLD, SLOW_SUSTAIN_MS, SLOW_WARMUP_MS,
    type ExecCounters, type ExecWindow, type PerfHintMessage,
} from "../../src/worker/core/execution-health";
import { StatsOverlay, formatJit, formatMips, type OverlayCtx } from "../../src/worker/core/stats-overlay";
import { perfHintText } from "../../src/app/perf-hint-text";

const c = (atMs: number, insns: number, inTickMs: number, sabWaitMs = 0): ExecCounters =>
    ({ atMs, insns, inTickMs, sabWaitMs });

/** A 500 ms window at `mips` busy MIPS and `busyShare`, no I/O. */
function win(mips: number, busyShare = 0.9, ioShare = 0): ExecWindow {
    const ms = SAMPLE_INTERVAL_MS;
    const busyMs = ms * busyShare;
    return { ms, busyMs, insns: mips * busyMs * 1000, busyShare, ioShare, busyMips: mips };
}

describe("measureWindow — MIPS per BUSY ms, not per wall ms", () => {
    test("instructions divided by in-tick time minus SAB wait", () => {
        // 500 ms window, 400 ms in tick of which 100 ms parked on SAB: 300 busy ms, 30M insns.
        const w = measureWindow(c(0, 0, 0, 0), c(500, 30_000_000, 400, 100))!;
        expect(w.busyMs).toBe(300);
        expect(w.busyMips).toBeCloseTo(100, 10);
        expect(w.ioShare).toBeCloseTo(0.2, 10);
    });

    test("an idle guest (Sleep/Wait) gives no MIPS rather than a low one", () => {
        // 5% of the window in tick: a sleeping guest says nothing about the host.
        const w = measureWindow(c(0, 0, 0), c(500, 100_000, 25))!;
        expect(w.busyMips).toBeNull();
    });

    test("the 32-bit counter wrapping inside a window is an unsigned delta", () => {
        const w = measureWindow(c(0, 0xFFFF_FF00, 0), c(500, 0x100, 400))!;
        expect(w.insns).toBe(0x200);
    });

    test("an empty or backwards window is refused", () => {
        expect(measureWindow(c(10, 0, 0), c(10, 5, 5))).toBeNull();
    });
});

describe("smoothMips", () => {
    test("first busy window seeds; idle windows leave the average alone", () => {
        let m = smoothMips(null, win(200));
        expect(m).toBe(200);
        m = smoothMips(m, { ...win(10), busyMips: null });
        expect(m).toBe(200);
    });

    test("moves toward the new value by busy time over the time constant", () => {
        const m = smoothMips(100, win(300, 0.8))!; // 400 busy ms of a 2000 ms constant: 20%
        expect(m).toBeCloseTo(140, 10);
    });
});

describe("JIT mode as the engine reports it", () => {
    const cfg = (slots: Record<number, number>) => (i: number) => slots[i] ?? 0;
    test("slot 0 set = off, slot 12 clear = notail, otherwise on", () => {
        expect(effectiveJit(cfg({ 0: 1, 12: 1 }))).toBe("off");
        expect(effectiveJit(cfg({ 0: 0, 12: 0 }))).toBe("notail");
        expect(effectiveJit(cfg({ 0: 0, 12: 1 }))).toBe("on");
        expect(effectiveJit(undefined)).toBe("unknown");
    });

    test("a mode the page did not choose is attributed to a runtime switch", () => {
        expect(jitReason("off", "query", "off")).toBe("query");
        expect(jitReason("notail", "ios-webkit-27", "notail")).toBe("ios-webkit-27");
        expect(jitReason("on", "default", "off")).toBe("runtime");
    });
});

describe("SlowExecutionDetector — sustained, busy, past warm-up, once", () => {
    const run = (d: SlowExecutionDetector, w: ExecWindow, n: number, since = 60_000): boolean => {
        let fired = false;
        for (let i = 0; i < n; i++) fired = d.feed(w, since) || fired;
        return fired;
    };
    const windowsFor = (ms: number) => Math.ceil(ms / SAMPLE_INTERVAL_MS);

    test("fires exactly when SLOW_SUSTAIN_MS of slow windows accumulate", () => {
        const d = new SlowExecutionDetector();
        expect(run(d, win(30), windowsFor(SLOW_SUSTAIN_MS) - 1)).toBe(false);
        expect(d.feed(win(30), 60_000)).toBe(true);
    });

    test("fires once per session", () => {
        const d = new SlowExecutionDetector();
        expect(run(d, win(30), windowsFor(SLOW_SUSTAIN_MS))).toBe(true);
        expect(run(d, win(30), windowsFor(SLOW_SUSTAIN_MS) * 3)).toBe(false);
    });

    test("never fires at JIT speeds", () => {
        const d = new SlowExecutionDetector();
        expect(run(d, win(SLOW_MIPS_THRESHOLD + 1), 10_000)).toBe(false);
    });

    test("idle, loading and pre-warm-up windows neither add nor clear", () => {
        const d = new SlowExecutionDetector();
        run(d, win(30), 10);
        const held = d.accumulatedSlowMs;
        run(d, { ...win(30), busyMips: null }, 50);       // guest asleep
        run(d, win(30, 0.3), 50);                          // mostly idle
        run(d, win(30, 0.9, 0.5), 50);                     // loading from the bundle
        run(d, win(30), 50, SLOW_WARMUP_MS - 1);           // still warming up
        run(d, win(30), 50, null as unknown as number);    // nothing presented yet
        expect(d.accumulatedSlowMs).toBe(held);
    });

    test("hysteresis: between threshold and recover holds, above recover clears", () => {
        const d = new SlowExecutionDetector();
        run(d, win(30), 10);
        run(d, win((SLOW_MIPS_THRESHOLD + SLOW_MIPS_RECOVER) / 2), 10);
        expect(d.accumulatedSlowMs).toBe(10 * SAMPLE_INTERVAL_MS);
        run(d, win(SLOW_MIPS_RECOVER), 1);
        expect(d.accumulatedSlowMs).toBe(0);
    });

    test("notail (the iOS policy) is judged against its own, lower line", () => {
        const on = new SlowExecutionDetector();
        const notail = new SlowExecutionDetector();
        for (let i = 0; i < 4; i++) { on.feed(win(55), 60_000, "on"); notail.feed(win(55), 60_000, "notail"); }
        expect(on.accumulatedSlowMs).toBe(4 * SAMPLE_INTERVAL_MS);
        expect(notail.accumulatedSlowMs).toBe(0);
        notail.feed(win(40), 60_000, "notail");
        expect(notail.accumulatedSlowMs).toBe(SAMPLE_INTERVAL_MS);
    });

    test("a spin-waiting guest (busy, high MIPS) clears rather than accumulates", () => {
        const d = new SlowExecutionDetector();
        run(d, win(30), 10);
        run(d, win(800, 1), 1);
        expect(d.accumulatedSlowMs).toBe(0);
    });
});

describe("ExecutionHealth — sampling cadence and the hint message", () => {
    test("samples once per interval and posts one hint with the live JIT mode", () => {
        const h = new ExecutionHealth();
        const hints: PerfHintMessage[] = [];
        h.setSinks((m) => hints.push(m), () => {});
        h.setPolicy("off", "query");
        let insns = 0, inTick = 0;
        h.attach({
            readInsns: () => insns, readInTickMs: () => inTick, readSabWaitMs: () => 0,
            getJitConfig: (i) => (i === 0 ? 1 : 1),
        });
        h.noteFirstPresent(0);
        let reads = 0;
        // 30 s of ticks every 5 ms at 25 busy MIPS, 90% busy.
        for (let t = 0; t <= 30_000; t += 5) {
            inTick += 4.5;
            insns = (insns + 4.5 * 25_000) >>> 0;
            const before = h.snapshot().busyShare;
            h.maybeSample(t);
            if (h.snapshot().busyShare !== before) reads++;
        }
        expect(hints.length).toBe(1);
        expect(hints[0]).toMatchObject({ type: "perf_hint", jit: "off", reason: "query" });
        expect(hints[0]!.mips).toBe(25);
        expect(h.snapshot().mips).toBeCloseTo(25, 6);
        expect(reads).toBeLessThanOrEqual(30_000 / SAMPLE_INTERVAL_MS + 1);
    });

    test("a gap far longer than the interval (pause, hidden tab) is not a window", () => {
        const h = new ExecutionHealth();
        let insns = 0, inTick = 0;
        h.attach({ readInsns: () => insns, readInTickMs: () => inTick, readSabWaitMs: () => 0 });
        h.maybeSample(0);
        insns = 1_000; inTick = 1_000;
        h.maybeSample(60_000);
        expect(h.snapshot().mips).toBeNull();
    });
});

describe("overlay fps row and hint text", () => {
    test("MIPS and JIT formatting", () => {
        expect(formatMips(412.4)).toBe("412 MIPS");
        expect(formatMips(4.26)).toBe("4.3 MIPS");
        expect(formatMips(null)).toBe("-- MIPS");
        expect(formatJit("on")).toBe("JIT");
        expect(formatJit("off")).toBe("JIT off");
        expect(formatJit("notail")).toBe("JIT notail");
    });

    test("the fps row carries fps, MIPS and JIT, inside the panel", () => {
        const o = new StatsOverlay();
        o.setEnabled(true);
        for (let i = 0; i < 50; i++) o.updateMetrics(200); // 5 fps, three digits never needed
        for (let i = 0; i < 50; i++) o.updateMetrics(8.3); // ~120 fps: widest fps text
        o.setExecHealth({ mips: 1234, jit: "notail" });
        const text: Array<{ s: string; x: number; y: number }> = [];
        let font = "";
        const ctx = new Proxy({}, {
            get: (_t, k) => k === "fillText" ? (s: string, x: number, y: number) => text.push({ s: `${font}|${s}`, x, y })
                : k === "createLinearGradient" ? () => ({ addColorStop() {} })
                : () => {},
            set: (_t, k, v) => { if (k === "font") font = v; return true; },
        }) as unknown as OverlayCtx;
        o.drawInto(ctx);
        const row = text.filter(t => t.y === 15);
        expect(row.map(t => t.s.split("|")[1]).join("")).toMatch(/^\d+fps · 1234 MIPS · JIT notail$/);
        // Right edge of the last segment, at the 0.6 monospace advance the panel lays out with.
        const last = row[row.length - 1]!;
        const size = Number(/(\d+)px/.exec(last.s)![1]);
        expect(last.x + last.s.split("|")[1]!.length * size * 0.6).toBeLessThanOrEqual(216 - 6);
    });

    test("hint text names the cause", () => {
        expect(perfHintText({ jit: "off", reason: "query", mips: 20 }).body).toContain("?jit=0");
        expect(perfHintText({ jit: "off", reason: "runtime", mips: 20 }).title).toContain("JIT is off");
        const slow = perfHintText({ jit: "on", reason: "default", mips: 30 });
        expect(slow.body).toContain("Enhance your security");
        expect(slow.body).toContain("30 MIPS");
    });
});
