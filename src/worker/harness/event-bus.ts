/**
 * HarnessEventBus (worker side) — one normalized event channel.
 *
 * Today the worker has fragmented event paths: dbg_event carries only the three
 * dialog events (dialogShow/dlgList/dlgClick), the WASM trap goes out as its own
 * `wasm_trap` message, and most subsystems just console.log (invisible to the
 * page). This bus folds new harness emissions — frameRendered, modalShown,
 * fault, fileWritten, breakHit, apiBreak — into one `{event,runId,serial,ts,data}`
 * envelope posted to the page, where facade.ts buffers the latest
 * per event and resolves `waitForEvent` waiters.
 *
 * The bus is the ONLY new worker->page channel; legacy dbg_event producers stay
 * untouched (the facade also listens to dbg_event for back-compat), so this lands
 * with zero risk to existing window.dbg tooling.
 */

import { HARNESS_EVENT, type HarnessEventMsg } from "./rpc";

/** Small ring of recent events for post-hoc inspection (state(['events'])). */
const EVENT_RING_CAP = 256;

class HarnessEventBus {
    private serial = 0;
    /** Gate for the per-present frameRendered emission (default OFF — keeps the
     *  perf-critical present path zero-cost until a script opts in via watchFrames). */
    frameEvents = false;
    /** Gate for the per-write fileWritten emission (default OFF — the guest write
     *  path is hot; opt in via watchFiles). */
    fileEvents = false;
    /** Correlation id pushed by the service around a dispatch, so events emitted
     *  synchronously during a command carry that command's request id as runId. */
    private currentRunId: number | null = null;
    private ring: HarnessEventMsg[] = [];
    private localSubs = new Map<string, Array<(data: unknown) => void>>();

    /** Set/clear the ambient runId for the duration of a command dispatch. */
    setRunId(id: number | null): void {
        this.currentRunId = id;
    }

    getRunId(): number | null {
        return this.currentRunId;
    }

    /**
     * Emit a normalized event to the page. `runId` defaults to the ambient
     * dispatch id; producers that arm asynchronously (e.g. a breakpoint that
     * fires later) should capture the arming id and pass it explicitly.
     */
    emit(event: string, data: unknown, runId: number | null = this.currentRunId): void {
        const msg: HarnessEventMsg = {
            type: HARNESS_EVENT,
            event,
            runId,
            serial: ++this.serial,
            ts: performance.now(),
            data,
        };
        this.ring.push(msg);
        if (this.ring.length > EVENT_RING_CAP) this.ring.shift();
        try {
            (self as unknown as Worker).postMessage(msg);
        } catch {
            /* postMessage can throw if data isn't structured-cloneable; producers
               are responsible for passing POJOs. Swallow so a bad emit can't wedge
               the caller. */
        }
        for (const cb of this.localSubs.get(event) ?? []) {
            try { cb(data); } catch { /* a listener must never break the producer */ }
        }
    }

    /** Worker-side subscription — for reactions that must happen in the worker
     *  (the service aborting waiters on a crash), not just on the page. */
    onLocal(event: string, cb: (data: unknown) => void): () => void {
        const subs = this.localSubs.get(event) ?? [];
        subs.push(cb);
        this.localSubs.set(event, subs);
        return () => {
            const cur = this.localSubs.get(event);
            if (cur) this.localSubs.set(event, cur.filter((f) => f !== cb));
        };
    }

    /** Recent events (oldest..newest), optionally filtered by name. */
    recent(count = 64, eventName?: string): HarnessEventMsg[] {
        const src = eventName ? this.ring.filter((e) => e.event === eventName) : this.ring;
        return src.slice(Math.max(0, src.length - count));
    }
}

/** Worker-wide singleton. Import directly: `import { harnessBus } from '../harness/event-bus'`. */
export const harnessBus = new HarnessEventBus();
