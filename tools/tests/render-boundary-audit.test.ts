/**
 * Census C's byte totals are only trustworthy because something independent counts the same
 * bytes. This file proves that cross-check can FAIL: it gags one ledger site with
 * `__noRenderBoundaryNote` (the `__noCodeInvalidate` pattern) and requires the report to
 * mark the byte section unusable rather than print the smaller, entirely plausible number.
 *
 * The GPUQueue shim is exercised against a stub prototype, which is also what pins its byte
 * arithmetic for the typed-array overload (dataOffset/size are ELEMENTS, not bytes).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    summarizeRenderBoundary,
    type RenderBoundarySnapshot,
} from "../../src/worker/harness/cmds/render-boundary";
import {
    d3d9NoteStagedBytes, d3d9NoteRenderFrameBoundary,
    readRenderBoundaryLedger, resetRenderBoundaryCensus, setRenderBoundaryQueueAudit,
} from "../../src/worker/modules/d3d9/d3d9-perf";

const written: Array<{ kind: string; args: unknown[] }> = [];

class StubQueue {
    writeBuffer(...args: unknown[]): void { written.push({ kind: "buffer", args }); }
    writeTexture(...args: unknown[]): void { written.push({ kind: "texture", args }); }
}

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

const g = globalThis as { GPUQueue?: unknown; __noRenderBoundaryNote?: unknown };

describe("render-boundary queue audit", () => {
    beforeEach(() => {
        written.length = 0;
        delete g.__noRenderBoundaryNote;
        g.GPUQueue = StubQueue;
        resetRenderBoundaryCensus();
    });

    afterEach(() => {
        setRenderBoundaryQueueAudit(false);
        delete g.GPUQueue;
        delete g.__noRenderBoundaryNote;
    });

    test("arming installs a shim and disarming restores the original methods", () => {
        const original = StubQueue.prototype.writeBuffer;
        expect(setRenderBoundaryQueueAudit(true)).toBe(true);
        expect(StubQueue.prototype.writeBuffer).not.toBe(original);
        new StubQueue().writeBuffer({}, 0, new Uint8Array(64));
        expect(written.length).toBe(1);            // the real method still ran
        expect(readRenderBoundaryLedger().audit.queueBytes).toBe(64);
        setRenderBoundaryQueueAudit(false);
        expect(StubQueue.prototype.writeBuffer).toBe(original);
    });

    test("the shim measures the typed-array overload in elements, not bytes", () => {
        setRenderBoundaryQueueAudit(true);
        const q = new StubQueue();
        // writeBuffer(buffer, offset, data, dataOffset, size): 16 Float32 elements = 64 bytes.
        q.writeBuffer({}, 0, new Float32Array(256), 0, 16);
        expect(readRenderBoundaryLedger().audit.queueBytes).toBe(64);
        q.writeTexture({}, new Uint8Array(1024), {}, {});
        expect(readRenderBoundaryLedger().audit.queueBytes).toBe(64 + 1024);
    });

    test("a matching ledger reports the byte section as usable", () => {
        setRenderBoundaryQueueAudit(true);
        const before = snap();
        const q = new StubQueue();
        d3d9NoteStagedBytes("texture", 4096);
        q.writeTexture({}, new Uint8Array(4096), {}, {});
        d3d9NoteRenderFrameBoundary(1);
        const out = summarizeRenderBoundary(before,
            { ...snap({ guestPresentSerial: 1 }), atMs: before.atMs + 50 });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.stagedBytes.usable).toBe(true);
        expect(r.stagedBytes.audit.uncoveredBytes).toBe(0);
    });

    test("BYPASS: gagging one ledger site makes the report call the byte section unusable", () => {
        setRenderBoundaryQueueAudit(true);
        const before = snap();
        const q = new StubQueue();
        g.__noRenderBoundaryNote = "texture";
        d3d9NoteStagedBytes("texture", 4096);        // suppressed — the bypass
        q.writeTexture({}, new Uint8Array(4096), {}, {});   // the GPU still got the bytes
        d3d9NoteStagedBytes("constants", 256);
        q.writeBuffer({}, 0, new Uint8Array(256));
        d3d9NoteRenderFrameBoundary(1);
        const out = summarizeRenderBoundary(before,
            { ...snap({ guestPresentSerial: 1 }), atMs: before.atMs + 50 });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.stagedBytes.usable).toBe(false);
        expect(r.stagedBytes.audit.uncoveredBytes).toBe(4096);
        expect(r.stagedBytes.audit.suppressedKind).toBe("texture");
        // The number that WOULD have been quoted is still printed, and is wrong by exactly
        // the gagged site — which is the point: it looks perfectly plausible on its own.
        expect(r.stagedBytes.byKind.texture.total).toBe(0);
    });

    test("an uncounted write site surfaces as uncoveredBytes even with no bypass flag", () => {
        setRenderBoundaryQueueAudit(true);
        const before = snap();
        // A site that reaches the GPU without a d3d9NoteStagedBytes call — exactly what a new
        // upload path added later looks like.
        new StubQueue().writeBuffer({}, 0, new Uint8Array(2048));
        d3d9NoteRenderFrameBoundary(1);
        const out = summarizeRenderBoundary(before,
            { ...snap({ guestPresentSerial: 1 }), atMs: before.atMs + 50 });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const r = out.report as Record<string, any>;
        expect(r.stagedBytes.audit.uncoveredBytes).toBe(2048);
        expect(r.stagedBytes.usable).toBe(false);
        expect(r.stagedBytes.audit.note).toContain("MISMATCH");
    });
});
