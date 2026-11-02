import { test, expect } from "bun:test";
import { DirectPlaySendOperationPool } from "../../src/worker/modules/dpnet/send-operations";

const delivered = (flags: number) => ({ firstFrameRtt: 0, firstFrameRetries: 0, flags });
test("metadata cache stays finite while admitted operations and callbacks own their leases", () => {
    const pool = new DirectPlaySendOperationPool(4), pending = [];
    for (let i = 0; i < 256; i++) {
        const op = pool.begin(true)!; op.delivered(delivered(1)); pending.push(op);
        expect(pool.activeLeases).toBe((i + 1) * 2);
    }
    expect(pending[0].metadata()).toEqual({ firstFrameRtt: 0xffffffff, firstFrameRetries: 0, flags: 0 });
    expect(pending[255].metadata().flags).toBe(1);
    for (const op of pending) op.release();
    expect(pool.activeLeases).toBe(0); expect(pool.cachedNodes).toBe(4);
    for (const op of pending) op.release();
    expect(pool.cachedNodes).toBe(4);
});
test("retained callback metadata is immutable during reentrant allocation and released only once", () => {
    const pool = new DirectPlaySendOperationPool(), active = pool.begin(false)!;
    active.delivered(delivered(1)); expect(pool.activeLeases).toBe(2);
    const reentrant = pool.begin(true)!; reentrant.delivered(delivered(1));
    expect(pool.activeLeases).toBe(4); expect(active.metadata().flags).toBe(1);
    expect(reentrant.metadata().flags).toBe(0);
    active.release(); expect(pool.activeLeases).toBe(2);
    reentrant.release(); expect(pool.activeLeases).toBe(0);
});
test("old process delivery and callback return cannot acquire or release a new epoch's metadata", () => {
    const pool = new DirectPlaySendOperationPool(), stale = pool.begin(true)!;
    pool.reset(); const current = pool.begin(true)!; expect(pool.activeLeases).toBe(3);
    stale.delivered(delivered(1)); stale.release(); stale.rollback();
    expect(pool.activeLeases).toBe(3); expect(pool.cachedNodes).toBe(0);
    expect(current.metadata()).toEqual({ firstFrameRtt: 0xffffffff, firstFrameRetries: 0, flags: 0 });
    current.delivered(delivered(1)); current.release();
    expect(pool.activeLeases).toBe(0);
});
test("rejected admission restores the reusable metadata order without manufacturing a delivery", () => {
    const pool = new DirectPlaySendOperationPool(), prior = pool.begin(false)!;
    prior.delivered(delivered(1)); prior.release();
    const rejected = pool.begin(true)!; rejected.rollback();
    const next = pool.begin(true)!; expect(next.metadata().flags).toBe(1); next.release();
    expect(pool.activeLeases).toBe(0);
});

test("aggregate metadata admission reserves every role before ownership changes and rejects atomically", () => {
    const pool = new DirectPlaySendOperationPool(4, 4), first = pool.begin(true)!;
    expect(pool.activeLeases).toBe(3); first.delivered(delivered(1)); expect(pool.activeLeases).toBe(2);
    const cached = pool.cachedNodes;
    expect(pool.begin(true)).toBeNull(); expect(pool.activeLeases).toBe(2); expect(pool.cachedNodes).toBe(cached);
    const callback = pool.begin(false)!; expect(pool.activeLeases).toBe(4);
    expect(pool.begin(false)).toBeNull(); expect(pool.activeLeases).toBe(4);
    callback.release(); first.release(); expect(pool.activeLeases).toBe(0);
    const last = pool.begin(true); expect(last).not.toBeNull(); last!.release(); expect(pool.activeLeases).toBe(0);
});
