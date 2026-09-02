/**
 * The worker-time ledger behind `idleReport` (roadmap 08).
 *
 * The instrument's whole value is that its three buckets PARTITION the window, so the
 * tests below assert the partition itself and then break it deliberately: an unbalanced
 * bracket, a tick exit with no enter, and a window opened before the first tick each have
 * to be seen. A ledger that silently absorbs those would report a confident idle figure
 * for time it never measured — the failure mode this whole file exists to prevent.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { workerTime } from "../../src/worker/core/worker-time-accounting";
import { computeIdlePartition } from "../../src/worker/harness/cmds/idle";

/** Deterministic clock: performance.now() is what the ledger reads. */
let clock = 0;
const realNow = performance.now;

beforeEach(() => {
    clock = 0;
    (performance as unknown as { now: () => number }).now = () => clock;
    workerTime.resetForTest();
});
afterEach(() => {
    (performance as unknown as { now: () => number }).now = realNow;
});

/** One tick occupying [clock, clock+ms], then advance to the tick's end. */
function tick(ms: number, requestedDelayMs = 0): void {
    workerTime.noteTickEnter();
    clock += ms;
    workerTime.noteTickExit(requestedDelayMs);
}

function armed(p: ReturnType<typeof computeIdlePartition>): Record<string, any> {
    expect(p.ok).toBe(true);
    expect((p as any).armed).toBe(true);
    return (p as any).report;
}

describe("worker-time ledger", () => {
    test("the three buckets partition the window exactly", () => {
        clock = 100;
        tick(4);                       // 100 -> 104
        const before = workerTime.snapshot();

        clock += 1;                    // 105: unbracketed gap
        tick(6);                       // 105 -> 111
        workerTime.enterNonTick("present");
        clock += 3;                    // 111 -> 114
        workerTime.exitNonTick("present");
        clock += 2;                    // 114 -> 116: unbracketed gap
        tick(4, 8);                    // 116 -> 120, main_loop asked for 8 ms
        clock += 10;                   // 120 -> 130: unbracketed gap

        const r = armed(computeIdlePartition(before, workerTime.snapshot(), null));
        expect(r.windowMs).toBe(26);   // 104 -> 130
        expect(r.ticks).toBe(2);
        expect(r.inTick.ms).toBe(10);
        expect(r.nonTick.present).toEqual({ ms: 3, calls: 1 });
        expect(r.unattributedMs).toBe(13);           // 1 + 2 + 10
        expect(r.inTick.ms + r.nonTick.present.ms + r.unattributedMs).toBe(r.windowMs);
        expect(r.requestedSleepMs).toBe(8);
    });

    test("SAB wait is a slice of inTick, never a fourth term", () => {
        clock = 0;
        tick(1);
        const before = workerTime.snapshot();
        tick(40);                      // a tick that mostly sat in Atomics.wait
        clock += 10;
        const r = armed(computeIdlePartition(before, workerTime.snapshot(), { waitMs: 30, requests: 12 }));
        expect(r.inTick.ms).toBe(40);
        expect(r.inTick.sabWaitMs).toBe(30);
        expect(r.inTick.ms + r.unattributedMs).toBe(r.windowMs);
        expect(r.verdict).toBe("sab-io");
    });

    test("no SAB source reports null, not zero", () => {
        clock = 0; tick(1);
        const before = workerTime.snapshot();
        tick(5); clock += 20;
        const r = armed(computeIdlePartition(before, workerTime.snapshot(), null));
        expect(r.inTick.sabWaitMs).toBeNull();
        expect(r.inTick.sabRequests).toBeNull();
        expect(r.verdict).toBe("between-ticks");
    });

    test("measure() closes the bracket when the body throws", () => {
        clock = 0; tick(1);
        const before = workerTime.snapshot();
        expect(() => workerTime.measure("present", () => { clock += 5; throw new Error("boom"); })).toThrow("boom");
        clock += 1;
        tick(1);
        const r = armed(computeIdlePartition(before, workerTime.snapshot(), null));
        expect(r.nonTick.present.ms).toBe(5);
        expect(r.unattributedMs).toBe(1);
    });

    test("a nested bracket is timed once, by the outermost pair", () => {
        clock = 0; tick(1);
        const before = workerTime.snapshot();
        workerTime.enterNonTick("message");
        clock += 2;
        workerTime.enterNonTick("message");
        clock += 3;
        workerTime.exitNonTick("message");
        clock += 4;
        workerTime.exitNonTick("message");
        tick(1);
        const r = armed(computeIdlePartition(before, workerTime.snapshot(), null));
        expect(r.nonTick.message).toEqual({ ms: 9, calls: 1 });
    });
});

describe("the ledger refuses rather than inventing a number", () => {
    test("an unbalanced exit is refused, not absorbed", () => {
        clock = 0; tick(1);
        const before = workerTime.snapshot();
        workerTime.exitNonTick("present");     // never entered
        clock += 5; tick(1);
        const p = computeIdlePartition(before, workerTime.snapshot(), null);
        expect(p.ok).toBe(false);
        expect((p as any).refuse).toContain("bracket imbalance");
    });

    test("a tick exit with no enter contributes no duration", () => {
        clock = 0; tick(1);
        const before = workerTime.snapshot();
        clock += 50;
        workerTime.noteTickExit(0);            // hook pair broken
        tick(2);
        const r = armed(computeIdlePartition(before, workerTime.snapshot(), null));
        // The 50 ms is unattributed, NOT credited to a phantom tick.
        expect(r.ticks).toBe(1);
        expect(r.inTick.ms).toBe(2);
        expect(r.unattributedMs).toBe(50);
    });

    test("a window opened before the first tick is refused", () => {
        clock = 0;
        const before = workerTime.snapshot();  // nothing has ticked yet
        clock += 10; tick(1);
        const p = computeIdlePartition(before, workerTime.snapshot(), null);
        expect(p.ok).toBe(false);
        expect((p as any).refuse).toContain("predates the first v86 tick");
    });

    test("a window with no completed tick is armed:false, not a zero report", () => {
        clock = 0; tick(1);
        const before = workerTime.snapshot();
        clock += 500;                          // paused emulator
        const p = computeIdlePartition(before, workerTime.snapshot(), null);
        expect(p.ok).toBe(true);
        expect((p as any).armed).toBe(false);
        expect((p as any).reason).toContain("no v86 tick completed");
    });

    test("an empty window is refused", () => {
        clock = 0; tick(1);
        const s = workerTime.snapshot();
        const p = computeIdlePartition(s, s, null);
        expect(p.ok).toBe(false);
        expect((p as any).refuse).toContain("window is empty");
    });
});

describe("self-check: the partition test can actually fail", () => {
    test("dropping a bracket moves its time into the idle residual", () => {
        clock = 0; tick(1);
        const before = workerTime.snapshot();
        // Simulating the defect this instrument guards against: present work that nobody
        // brackets. It must show up as idle, which is what makes a missing bracket
        // detectable as an implausibly large residual rather than invisible.
        clock += 7;                            // present ran, unbracketed
        tick(1);
        const r = armed(computeIdlePartition(before, workerTime.snapshot(), null));
        expect(r.nonTick.present.ms).toBe(0);
        expect(r.unattributedMs).toBe(7);
    });
});
