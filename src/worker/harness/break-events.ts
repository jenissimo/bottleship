/**
 * Worker-side ring of breakpoint hits.
 *
 * WHY a ring and not "print as you go": a continuous breakpoint produces its
 * evidence over minutes, while every reader of it — pageEval, an RPC step, a
 * .harness.ts script — dies at a timeout (60s by default). A script that
 * accumulates hits in the PAGE and prints at the end loses everything the run
 * produced when that deadline lands, including the iterations that already
 * succeeded. Hits therefore land here, in the worker, the instant they happen,
 * and are read back by a separate short verb (`breakEvents`). The death of a
 * reader now costs nothing.
 *
 * The ring is bounded, so it CAN lose data — and says so: `evicted` counts
 * records overwritten before anyone read them, and a read whose `since` is
 * older than the oldest retained record reports an explicit `gap`, never a
 * silently shorter list.
 */

export interface BreakEventRecord {
    seq: number;
    t: number;
    kind: "eip" | "api";
    /** Registry id of the breakpoint that produced this record. */
    id: number;
    /** Armed eip (hex) for an eip break, thunk name for an api break. */
    at: string;
    data: unknown;
}

class BreakEventRing {
    private buf: BreakEventRecord[] = [];
    private capacity = 2048;
    private seq = 0;
    private evicted = 0;

    push(kind: "eip" | "api", id: number, at: string, data: unknown): number {
        const rec: BreakEventRecord = { seq: ++this.seq, t: Math.round(performance.now()), kind, id, at, data };
        this.buf.push(rec);
        while (this.buf.length > this.capacity) {
            this.buf.shift();
            this.evicted++;
        }
        return rec.seq;
    }

    setCapacity(n: number): number {
        this.capacity = Math.min(Math.max(n | 0, 16), 100_000);
        while (this.buf.length > this.capacity) { this.buf.shift(); this.evicted++; }
        return this.capacity;
    }

    clear(): number {
        const n = this.buf.length;
        this.buf = [];
        // seq keeps counting: a reader holding `since` from before the clear must
        // not be handed the SAME seq numbers for different hits.
        return n;
    }

    read(opts: { since?: number; limit?: number } = {}): {
        events: BreakEventRecord[];
        total: number; retained: number; capacity: number; evicted: number;
        firstSeq: number | null; lastSeq: number | null;
        gap?: { since: number; oldestRetained: number; missed: number };
        truncated?: { matched: number; returned: number; note: string };
        note?: string;
    } {
        const since = opts.since != null ? Number(opts.since) : null;
        const limit = Math.min(Math.max((opts.limit ?? 200) | 0, 1), 5000);
        const oldest = this.buf.length ? this.buf[0]!.seq : null;
        const newest = this.buf.length ? this.buf[this.buf.length - 1]!.seq : null;
        const matched = since == null ? this.buf : this.buf.filter((e) => e.seq > since);
        // Newest wins on overflow — the tail is what a reader following a live run wants.
        const events = matched.length > limit ? matched.slice(matched.length - limit) : matched;
        const out = {
            events,
            total: this.seq, retained: this.buf.length, capacity: this.capacity, evicted: this.evicted,
            firstSeq: oldest, lastSeq: newest,
        } as ReturnType<BreakEventRing["read"]>;
        // A reader that asked for everything after `since` but whose window already
        // rolled out of the ring gets told how much it will never see.
        if (since != null && oldest != null && since + 1 < oldest) {
            out.gap = { since, oldestRetained: oldest, missed: oldest - since - 1 };
        }
        if (matched.length > events.length) {
            out.truncated = { matched: matched.length, returned: events.length, note: "older matches dropped by `limit` — raise limit or read more often" };
        }
        if (!this.buf.length) {
            out.note = "no breakpoint hits recorded. An EIP breakpoint fires ONLY at a v86 BLOCK ENTRY " +
                "(function entry / after a call or ret) — 0 events is not evidence the code did not run; " +
                "check `breaks()` hits and arm the enclosing function entry.";
        }
        return out;
    }
}

/** Worker-wide singleton — written by eip-breaks/api-breaks, read by `breakEvents`. */
export const breakEvents = new BreakEventRing();
