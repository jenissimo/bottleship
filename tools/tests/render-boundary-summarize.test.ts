/**
 * The render-boundary census exists to price the render-worker gate, and a census that
 * cannot say "I measured nothing" is worse than none (CLAUDE.md §3.4). Every test here
 * feeds `summarizeRenderBoundary` exactly the condition it is supposed to refuse, so the
 * refusals are proven rather than asserted in a comment.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
    summarizeRenderBoundary,
    type RenderBoundarySnapshot,
} from "../../src/worker/harness/cmds/render-boundary";
import {
    RENDER_FENCE_KINDS, STAGED_BYTE_KINDS,
    d3d9NoteFence, d3d9NoteStagedBytes, d3d9NoteFenceQueriesServed,
    d3d9NoteRenderFrameBoundary, d3d9NoteQueueWrite,
    readRenderBoundaryLedger, resetRenderBoundaryCensus,
} from "../../src/worker/modules/d3d9/d3d9-perf";

function snap(over: Partial<RenderBoundarySnapshot> = {}): RenderBoundarySnapshot {
    return {
        atMs: performance.now(),
        ledger: readRenderBoundaryLedger(),
        guestPresentSerial: 0,
        presentSerial: 0,
        apiDraws: 0,
        encodedDraws: 0,
        ddrawRoundTrips: 0,
        ddrawLockCalls: 0,
        ...over,
    };
}

/** Advance the snapshot clock without a real wait. */
function later(s: RenderBoundarySnapshot, ms = 100): RenderBoundarySnapshot {
    return { ...s, atMs: s.atMs + ms };
}

function frame(serial: number, fences: Partial<Record<string, number>> = {},
               bytes: Partial<Record<string, number>> = {}): void {
    for (const [k, n] of Object.entries(fences)) {
        for (let i = 0; i < (n ?? 0); i++) d3d9NoteFence(k as never);
    }
    for (const [k, n] of Object.entries(bytes)) d3d9NoteStagedBytes(k as never, n ?? 0);
    d3d9NoteRenderFrameBoundary(serial);
}

describe("render-boundary census refusals", () => {
    beforeEach(() => {
        delete (globalThis as { __noRenderBoundaryNote?: unknown }).__noRenderBoundaryNote;
        resetRenderBoundaryCensus();
    });

    test("an empty window is refused, not reported as a zero census", () => {
        const before = snap();
        const out = summarizeRenderBoundary(before, { ...before, ledger: readRenderBoundaryLedger() });
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.refuse).toContain("window is empty");
    });

    test("a reset inside the window is refused as a fragment", () => {
        const before = snap();
        frame(1, { presentPermit: 1 });
        resetRenderBoundaryCensus();
        const out = summarizeRenderBoundary(before, later(snap()));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.refuse).toContain("reset inside the window");
    });

    test("zero frames with zero counts says it recorded NOTHING", () => {
        const before = snap();
        const out = summarizeRenderBoundary(before, later(snap()));
        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.refuse).toContain("recorded NOTHING");
            expect(out.refuse).toContain("uninstrumented");
        }
    });

    test("fences over zero present boundaries refuse rather than divide by zero", () => {
        const before = snap();
        d3d9NoteFence("textureReadback");
        d3d9NoteFence("textureReadback");
        const out = summarizeRenderBoundary(before, later(snap()));
        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.refuse).toContain("2 fences");
            expect(out.refuse).toContain("no denominator");
            expect(out.refuse).not.toContain("Infinity");
            expect(out.refuse).not.toContain("NaN");
        }
    });

    test("a present serial that ran backwards is refused", () => {
        const before = snap({ guestPresentSerial: 900 });
        frame(1, { presentPermit: 1 });
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 3 })));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.refuse).toContain("BACKWARDS");
    });

    test("a window longer than the ring says its distribution is only the tail", () => {
        const before = snap();
        for (let i = 1; i <= 600; i++) frame(i, { presentPermit: 1 });
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 600 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.framesObserved).toBe(600);
        expect(r.distributionCoversAllFrames).toBe(false);
        expect(r.framesDroppedFromRing).toBeGreaterThan(0);
        expect(r.framesInDistribution).toBeLessThan(600);
        // The TOTAL still covers every frame — only the shape is truncated.
        expect(r.fences.totalAllKinds).toBe(600);
    });
});

describe("render-boundary census report", () => {
    beforeEach(() => {
        delete (globalThis as { __noRenderBoundaryNote?: unknown }).__noRenderBoundaryNote;
        resetRenderBoundaryCensus();
    });

    test("reports a per-frame distribution, not just a total", () => {
        const before = snap();
        frame(1, { presentPermit: 1, textureReadback: 1 }, { texture: 1000 });
        frame(2, { presentPermit: 1 }, { texture: 3000 });
        frame(3, { presentPermit: 1, queryBatch: 2 }, { texture: 2000 });
        d3d9NoteFenceQueriesServed(7);
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 3, presentSerial: 3 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.framesObserved).toBe(3);
        expect(r.fences.totalAllKinds).toBe(6);
        expect(r.fences.perPresent).toBe(2);
        expect(r.stagedBytes.byKind.texture.perFrame.min).toBe(1000);
        expect(r.stagedBytes.byKind.texture.perFrame.max).toBe(3000);
        expect(r.stagedBytes.byKind.texture.perFrame.median).toBe(2000);
        expect(r.stagedBytes.byKind.texture.total).toBe(6000);
    });

    test("names every uninstrumented fence path so a 0 is readable", () => {
        const before = snap();
        frame(1, { presentPermit: 1 });
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 1 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.uninstrumented).toEqual(["glideMirrorPump", "openglReadPixels"]);
        // Every counted kind names its increment site, so "0" can be told from "uncounted".
        for (const k of RENDER_FENCE_KINDS) expect(typeof r.fences.byKind[k].site).toBe("string");
        for (const k of STAGED_BYTE_KINDS) expect(typeof r.stagedBytes.byKind[k].site).toBe("string");
    });

    test("a present the census never saw is named, not absorbed", () => {
        const before = snap({ guestPresentSerial: 10 });
        frame(11, { presentPermit: 1 });
        frame(13, { presentPermit: 1 });   // serial 12 presented through another presenter
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 13 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.presentsWithoutCensusFrame).toBe(1);
        expect(r.serialGaps).toEqual([{ afterSerial: 11, jump: 2 }]);
    });

    test("the §5 marginal-copy split separates already-staged bytes from direct ones", () => {
        const before = snap();
        frame(1, {}, { vertexIndexCopied: 4096, vertexIndexDirect: 256, constants: 64 });
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 1 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.stagedBytes.plan5AlreadyCopiedBytes).toBe(4096);
        expect(r.stagedBytes.plan5MarginalCopyBytes).toBe(320);
    });

    test("without the audit armed the byte section says nothing cross-checks it", () => {
        const before = snap();
        frame(1, {}, { texture: 10 });
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 1 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.stagedBytes.audit.armed).toBe(false);
        expect(r.stagedBytes.audit.note).toContain("Treat the byte totals as a floor");
    });

    test("a refused counter increment is rejected, never added as NaN", () => {
        const before = snap();
        d3d9NoteStagedBytes("texture", Number.NaN);
        d3d9NoteStagedBytes("texture", -5);
        frame(1, {}, { texture: 8 });
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 1 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect((out.report as Record<string, any>).stagedBytes.byKind.texture.total).toBe(8);
    });

    test("BYPASS: gagging a FENCE kind marks the fence section unusable", () => {
        const before = snap();
        (globalThis as { __noRenderBoundaryNote?: unknown }).__noRenderBoundaryNote = "queryBatch";
        d3d9NoteFence("queryBatch");
        d3d9NoteFence("queryBatch");
        frame(1, { presentPermit: 1 });
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 1 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        // The number itself stays perfectly plausible — which is why the verdict, not the
        // number, is what a reader has to look at.
        expect(r.fences.byKind.queryBatch.total).toBe(0);
        expect(r.fences.usable).toBe(false);
        expect(r.fences.suppressedKind).toBe("queryBatch");
        expect(r.suppressedKind).toBe("queryBatch");
    });

    test("the GPU round-trip rate excludes the presentPermit that is 1/frame by construction", () => {
        const before = snap();
        frame(1, { presentPermit: 1 });
        frame(2, { presentPermit: 1, textureReadback: 1 });
        const out = summarizeRenderBoundary(before, later(snap({ guestPresentSerial: 2 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.fences.perPresent).toBe(1.5);          // the misleading headline
        expect(r.fences.gpuRoundTrips.perPresent).toBe(0.5);
        expect(r.fences.gpuRoundTrips.perFrame.max).toBe(1);
        expect(r.fences.presentPermitVsFrames).toBe(0);
    });

    test("DDraw counters reset inside the window are refused, not subtracted", () => {
        const before = snap({ ddrawRoundTrips: 500, ddrawLockCalls: 900 });
        frame(1, { presentPermit: 1 });
        // readbackStats({reset:true}) zeroed them mid-window; 3 round trips accrued after.
        const out = summarizeRenderBoundary(before,
            later(snap({ guestPresentSerial: 1, ddrawRoundTrips: 3, ddrawLockCalls: 5 })));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.ddrawLockFences.usable).toBe(false);
        expect(r.ddrawLockFences.roundTrips).toBe(null);
        expect(r.ddrawLockFences.perGuestPresent).toBe(null);
        expect(r.ddrawLockFences.note).toContain("BACKWARDS");
        expect(r.ddrawLockFences.note).toContain("readbackStats");
    });

    test("the queue shim's bytes are independent of the classified ledger", () => {
        const before = snap();
        d3d9NoteQueueWrite(4096);
        frame(1, {}, { texture: 4096 });
        const l = readRenderBoundaryLedger();
        expect(l.audit.queueBytes - before.ledger.audit.queueBytes).toBe(4096);
        expect(l.ledgerBytes - before.ledger.ledgerBytes).toBe(4096);
    });
});
