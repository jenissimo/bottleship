/**
 * Stub registry — a deduplicated, queryable record of every UNIMPLEMENTED thunk
 * the guest has called (a vtable slot / export with no JS handler). The dispatcher
 * already logs each miss, but those drown in the multi-MB/s log firehose; this
 * keeps one entry per distinct stub with a hit count + the first/last guest caller,
 * so `harness.stubs()` answers "what under-implemented API did the game hit?" in a
 * single query — the fast path for the recurring bring-up loop where a game takes a
 * graceful "unsupported -> exit" branch on a missing method (e.g. NFSU's quality
 * slider calling the unimplemented IDirect3DDevice9::CreateCubeTexture).
 *
 * Zero-alloc on the hot repeat: a repeated stub just bumps a counter.
 */

import { TimeService } from "../../runtime/time";

export interface StubHit {
    /** Stable key: "dll:func" when known, else "id_0x<funcId>". */
    key: string;
    dll: string;
    func: string;
    functionId: number;
    count: number;
    firstCaller: number; // guest return address that first hit it (RE entry point)
    lastCaller: number;
    firstTs: number;
    lastTs: number;
}

class StubRegistry {
    private map = new Map<string, StubHit>();

    /** Record one missing-implementation dispatch — no handler at all, or a handler that
     *  returns the real API's success code without being able to fulfil its contract.
     *  Cheap; dedups by key. */
    record(dll: string, func: string, functionId: number, caller: number): void {
        const key = func ? `${dll || "?"}:${func}` : `id_0x${(functionId >>> 0).toString(16)}`;
        const ts = TimeService.getInstance().nowMs();
        const existing = this.map.get(key);
        if (existing) {
            existing.count++;
            existing.lastCaller = caller >>> 0;
            existing.lastTs = ts;
            return;
        }
        this.map.set(key, {
            key,
            dll: dll || "?",
            func: func || "",
            functionId: functionId >>> 0,
            count: 1,
            firstCaller: caller >>> 0,
            lastCaller: caller >>> 0,
            firstTs: ts,
            lastTs: ts,
        });
    }

    /** Distinct stubs, most-recently-first hit ordering by default. */
    list(): StubHit[] {
        return [...this.map.values()].sort((a, b) => b.lastTs - a.lastTs);
    }

    clear(): void {
        this.map.clear();
    }
}

/** Worker-wide singleton (dispatcher records into it, harness reads from it). */
export const stubRegistry = new StubRegistry();
