// The SAB I/O channel: the async request path and the layout handshake that guards
// the shared arena.
//
// The concurrency assertions are the point. A channel that resolves promises is not
// automatically a channel that OVERLAPS: the fake-async version this replaced awaited
// a blocking round-trip, and a test that awaited its reads one at a time — or asserted
// on wall time — would have passed over it unchanged. So every case here drives a COLD
// source (nothing is served from a cache) and asserts on max-in-flight, and the
// sequential case is included precisely to show the metric goes to 1 when it should.

import { describe, it, expect } from "bun:test";
import { SabIoSource } from "../../src/worker/runtime/filesystem/sab-io-source";
import type { SabWorkerLike } from "../../src/worker/runtime/filesystem/sab-io-source";
import { SAB_TOTAL_BYTES, layoutMismatch, sabLayout } from "../../src/worker/runtime/filesystem/sab-io-protocol";

/**
 * Stands in for the I/O worker: answers `areq` after a macrotask, and records how many
 * requests were outstanding at once from its OWN side — an independent witness, so the
 * source's counter cannot pass by agreeing with itself.
 */
class StubIoWorker implements SabWorkerLike {
    onmessage: ((e: MessageEvent) => void) | null = null;
    outstanding = 0;
    peakOutstanding = 0;
    served = 0;
    /** Withhold responses until released, so overlap is observable at all. */
    private held: Array<() => void> = [];
    private holding = false;

    hold(): void { this.holding = true; }
    release(): void {
        this.holding = false;
        const pending = this.held;
        this.held = [];
        for (const f of pending) f();
    }

    postMessage(msg: unknown): void {
        const m = msg as { type?: string; id?: number; off?: number; len?: number };
        if (m?.type !== "areq") return;
        this.outstanding++;
        if (this.outstanding > this.peakOutstanding) this.peakOutstanding = this.outstanding;
        const respond = () => {
            this.outstanding--;
            this.served++;
            const buf = new Uint8Array(m.len!);
            for (let i = 0; i < buf.length; i++) buf[i] = (m.off! + i) & 0xff;
            this.onmessage?.({ data: { type: "aresp", id: m.id, ok: true, buf: buf.buffer } } as MessageEvent);
        };
        if (this.holding) this.held.push(respond);
        else setTimeout(respond, 0);
    }

    terminate(): void { /* nothing to tear down */ }
}

function attach(worker: SabWorkerLike): SabIoSource {
    return SabIoSource.attachForTest(worker, new SharedArrayBuffer(SAB_TOTAL_BYTES), 1 << 20);
}

describe("SabIoSource async channel", () => {
    it("keeps N reads in flight at once and serves the right bytes", async () => {
        const w = new StubIoWorker();
        const src = attach(w);
        w.hold();

        const N = 8;
        const reads = [];
        for (let i = 0; i < N; i++) reads.push(src.readRange(i * 4096, i * 4096 + 4096));
        // Nothing has been answered yet, so every one of them is genuinely outstanding.
        expect(w.outstanding).toBe(N);
        w.release();
        const bufs = await Promise.all(reads);

        expect(src.stats().async.maxInFlight).toBeGreaterThanOrEqual(N);
        expect(w.peakOutstanding).toBeGreaterThanOrEqual(N);
        for (let i = 0; i < N; i++) {
            expect(bufs[i].length).toBe(4096);
            expect(bufs[i][0]).toBe((i * 4096) & 0xff);
        }
    });

    it("reports max-in-flight 1 when the caller awaits sequentially", async () => {
        // The failure this instrument exists to catch: a test written this way passes
        // over a blocking channel while proving nothing about overlap.
        const w = new StubIoWorker();
        const src = attach(w);
        for (let i = 0; i < 6; i++) await src.readRange(i * 4096, i * 4096 + 4096);
        expect(src.stats().async.maxInFlight).toBe(1);
    });

    it("lets host macrotasks run while reads are outstanding", async () => {
        const w = new StubIoWorker();
        const src = attach(w);
        w.hold();
        let ticked = false;
        const tick = new Promise<void>((r) => setTimeout(() => { ticked = true; r(); }, 0));
        const reads = [src.readRange(0, 4096), src.readRange(4096, 8192)];
        await tick;
        expect(ticked).toBe(true); // the event loop ran with two reads still in flight
        expect(src.stats().async.inFlight).toBe(2);
        w.release();
        await Promise.all(reads);
        expect(src.stats().async.inFlight).toBe(0);
    });

    it("settles everything in flight on close instead of pinning the caller", async () => {
        const w = new StubIoWorker();
        const src = attach(w);
        w.hold();
        const p = src.readRange(0, 4096);
        src.close();
        await expect(p).rejects.toThrow(/closed/);
    });
});

describe("SAB layout handshake", () => {
    it("accepts this build's own layout", () => {
        expect(layoutMismatch(sabLayout())).toBeNull();
    });

    it("names the field a stale peer disagrees on", () => {
        // The bypass this guard exists for: a peer compiled against a different arena
        // does not crash, it reads bytes from the wrong offsets forever.
        for (const k of Object.keys(sabLayout())) {
            const bad = { ...sabLayout(), [k]: sabLayout()[k as keyof ReturnType<typeof sabLayout>] + 8 };
            expect(layoutMismatch(bad)).toContain(k);
        }
        expect(layoutMismatch(undefined)).not.toBeNull();
    });
});
