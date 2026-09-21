import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { frameTailFromSamples } from "../../src/worker/core/frame-time-distribution";
import {
    buildFlipSeries, computeFlipLedger, extractPresentLedger, extractThreadNames,
    reportFlipLedger, reportRenderFrames,
} from "../analyze-trace";

const FIXTURES = {
    twoThread: "tools/tests/fixtures/analyze-trace-two-thread-flip.json",
    dropped: "tools/tests/fixtures/analyze-trace-dropped-present.json",
};

/** A fixture read through a path that can come back empty makes every assertion below vacuous,
 *  so its existence and its mark population are asserted before anything is measured. */
function loadFixture(path: string, expectFlips: number) {
    expect(existsSync(path)).toBe(true);
    const events = JSON.parse(readFileSync(path, "utf8")).traceEvents as any[];
    expect(events.filter(e => e.name === "bottleship.flip").length).toBe(expectFlips);
    return events;
}

const buildFrom = (events: any[]) => buildFlipSeries(events, extractThreadNames(events));

describe("analyze-trace two-thread frame accounting", () => {
    test("a well-formed two-thread trace keeps one series per thread and never merges them", () => {
        const events = loadFixture(FIXTURES.twoThread, 18);
        const series = buildFrom(events);

        expect(series.map(s => s.tid).sort()).toEqual([10, 20]);
        for (const s of series) expect(s.marks.length).toBe(9);

        const guest = series.find(s => s.tid === 10)!.analysis!;
        const render = series.find(s => s.tid === 20)!.analysis!;
        expect(guest.intervals.map(i => i.frameMs)).toEqual([16, 16, 16, 16, 16, 16, 16, 16]);
        expect(render.intervals.map(i => i.frameMs)).toEqual([16, 16, 24, 8, 16, 16, 20, 12]);

        // The merged path both series exist to prevent: 18 marks sorted into one list read as
        // ~8ms frames, i.e. double the FPS, with a perfectly plausible distribution.
        const mergedTs = events.filter(e => e.name === "bottleship.flip").map(e => e.ts).sort((a, b) => a - b);
        const mergedIntervals: number[] = [];
        for (let i = 1; i < mergedTs.length; i++) mergedIntervals.push((mergedTs[i]! - mergedTs[i - 1]!) / 1000);
        const merged = frameTailFromSamples(mergedIntervals, { maxBuckets: 24 });
        expect(merged.ok && merged.meanMs).toBeLessThan(10);
        expect(guest.stats.ok && guest.stats.meanMs).toBe(16);
        expect(render.stats.ok && render.stats.meanMs).toBe(16);
    });

    test("percentiles come from the shared distribution, on ONE budget for both threads", () => {
        const series = buildFrom(loadFixture(FIXTURES.twoThread, 18));
        const presenter = series[0]!;
        const budget = presenter.analysis!.budgetMs!;
        for (const s of series) {
            const own = frameTailFromSamples(s.analysis!.intervals.map(i => i.frameMs), { budgetMs: budget, maxBuckets: 24 });
            // The presenting series derives the budget; every other series is judged against it.
            const expected = s === presenter
                ? frameTailFromSamples(s.analysis!.intervals.map(i => i.frameMs), { maxBuckets: 24 })
                : own;
            expect(s.analysis!.stats).toEqual(expected);
            expect(s.analysis!.budgetMs).toBe(budget);
        }
    });

    test("the report names both threads and says which one it treated as presenting", () => {
        const text = reportRenderFrames(buildFrom(loadFixture(FIXTURES.twoThread, 18)))!;
        expect(text).toContain("[PRESENTED]");
        expect(text).toContain("[also flipping]");
        expect(text).toContain("(tid 10)");
        expect(text).toContain("(tid 20)");
        // Equal mark counts carry no evidence of who owned the screen; the tool must say so.
        expect(text).toContain("tie on mark count");
    });

    test("a well-formed trace produces NO ledger divergence (the check is not always-on)", () => {
        const events = loadFixture(FIXTURES.twoThread, 18);
        const ledger = computeFlipLedger(buildFrom(events), extractPresentLedger(events));
        expect(ledger.divergences).toEqual([]);
        expect(ledger.unavailable).toBeNull();
        expect(reportFlipLedger(ledger)).toContain("LEDGER OK");
    });
});

describe("analyze-trace ledger can fail loudly", () => {
    test("a render thread dropping every second present diverges from the guest-side count", () => {
        const events = loadFixture(FIXTURES.dropped, 9);
        const series = buildFrom(events);
        const stats = series[0]!.analysis!.stats;

        // The trap: the surviving marks are evenly spaced, so the distribution looks healthy.
        expect(stats.ok && stats.meanMs).toBe(33);

        const ledger = computeFlipLedger(series, extractPresentLedger(events));
        expect(ledger.rows[0]!.markCount).toBe(9);
        expect(ledger.rows[0]!.serialSpan).toBe(17);
        expect(ledger.rows[0]!.missing).toBe(8);
        expect(ledger.divergences.length).toBe(2);
        expect(ledger.divergences.join("\n")).toContain("never reached this thread");
        expect(ledger.divergences.join("\n")).toContain("unaccounted for");

        const text = reportFlipLedger(ledger);
        expect(text).toContain("!!! LEDGER DIVERGENCE");
        expect(text).toContain("REFUSED");
    });

    test("a window that opens mid-session is not a divergence (serials are not counts)", () => {
        // A real capture never starts at present serial 1. Reading the ledger's absolute serial
        // as a frame count turns every healthy trace into "N frames unaccounted for" and makes
        // the instrument refuse a number it should have printed.
        const base = JSON.parse(readFileSync(FIXTURES.twoThread, "utf8")).traceEvents as any[];
        const shifted = base.map(e => {
            const s = e.args?.data;
            if (!s) return e;
            const bump = (v: any) => (typeof v === "number" ? v + 5000 : v);
            return { ...e, args: { data: { ...s, ...("serial" in s ? { serial: bump(s.serial) } : {}),
                ...("presentSerial" in s ? { presentSerial: bump(s.presentSerial) } : {}),
                ...("guestPresentSerial" in s ? { guestPresentSerial: bump(s.guestPresentSerial) } : {}) } } };
        });
        const ledger = computeFlipLedger(buildFrom(shifted), extractPresentLedger(shifted));
        expect(ledger.divergences).toEqual([]);
        expect(ledger.guest!.guestSpan).toBe(9);
        expect(reportFlipLedger(ledger)).toContain("LEDGER OK");
    });

    test("a ledger mark whose field names drifted is NOT CHECKED, never OK", () => {
        // The emitter does not exist yet, so the first thing this check can meet is a mark
        // carrying its count under a name the tool does not read. Answering OK to that is the
        // false assurance the whole section exists to prevent.
        const events = loadFixture(FIXTURES.dropped, 9)
            .map(e => (e.name === "bottleship.flip" ? { ...e, args: {} } : e))
            .map(e => (e.name === "bottleship.present.ledger" ? { ...e, args: { data: { presentCount: 18 } } } : e));
        const ledger = computeFlipLedger(buildFrom(events), extractPresentLedger(events));
        const text = reportFlipLedger(ledger);
        expect(text).not.toContain("LEDGER OK");
        expect(ledger.unavailable).toContain("no present count under any name this tool reads");
        expect(text).toContain("LEDGER UNAVAILABLE");
    });

    test("a single ledger sample cannot be compared, and says so next to the verdict", () => {
        const events = loadFixture(FIXTURES.twoThread, 18)
            .filter(e => !(e.name === "bottleship.present.ledger" && e.ts < 1000000));
        const ledger = computeFlipLedger(buildFrom(events), extractPresentLedger(events));
        expect(ledger.guest!.guestSpan).toBeNull();
        expect(ledger.notes.join("\n")).toContain("single sample");
        const text = reportFlipLedger(ledger);
        expect(text).toContain("NOT CHECKED");
        // The per-thread serial spans were still checked, so this is agreement about LESS.
        expect(text).toContain("per-thread serial spans");
        expect(text).not.toContain("the ledger mark's present count");
    });

    test("a trace with no ledger source says so instead of reporting agreement", () => {
        const events = loadFixture(FIXTURES.dropped, 9)
            .map(e => (e.name === "bottleship.flip" ? { ...e, args: {} } : e))
            .filter(e => e.name !== "bottleship.present.ledger");
        const ledger = computeFlipLedger(buildFrom(events), extractPresentLedger(events));
        expect(ledger.unavailable).toContain("no guest-side present count");
        expect(reportFlipLedger(ledger)).toContain("LEDGER UNAVAILABLE");
    });

    test("end to end: the CLI prints the divergence for one fixture and agreement for the other", () => {
        const run = (f: string) => {
            const r = spawnSync("bun", ["tools/analyze-trace.ts", f], { encoding: "utf8", shell: true });
            expect(r.status).toBe(0);
            return r.stdout;
        };
        const dropped = run(FIXTURES.dropped);
        expect(dropped).toContain("!!! LEDGER DIVERGENCE");
        expect(dropped).toContain("8 present(s) never reached this thread");
        expect(run(FIXTURES.twoThread)).toContain("LEDGER OK");
    });
});
