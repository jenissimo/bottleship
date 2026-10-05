/**
 * A durable ring for the guest-side diagnostics v86 writes to `console.error` — the step
 * trace, the write-watch dumps, anything the wasm emits.
 *
 * Those lines are the only record of what the GUEST executed between two thunks, and that is
 * exactly the window a wild EIP lands in. They reached the browser console of the WORKER,
 * which no log stream, no archive and no harness verb could read: the evidence existed and was
 * unreachable. Keeping the last N here makes a trace answerable by `guestTrace()`.
 *
 * The hook CHAINS (it calls through to whatever console.error was), and re-arming replaces its
 * own previous generation rather than stacking, so eip-breaks' `<BP>` interceptor and this one
 * coexist however many times either is set up.
 */

const DEFAULT_CAPACITY = 4096;

class GuestTraceRing {
    private lines: string[] = [];
    private capacity = DEFAULT_CAPACITY;
    private dropped = 0;
    private hook: ((...args: unknown[]) => void) | null = null;
    private armed = false;

    /** Instructions the caller ASKED the wasm to trace, so an empty ring can say which
     *  half failed: nothing ran, or the wasm hook never emitted. */
    private requested = 0;

    noteRequested(n: number): void {
        this.requested += Math.max(0, n | 0);
    }

    /** Start capturing. Idempotent; safe to call before every trace. */
    start(capacity = DEFAULT_CAPACITY): void {
        this.capacity = Math.max(64, Math.min(capacity | 0, 200_000));
        this.armed = true;
        if (this.hook && console.error === this.hook) return;
        const orig = console.error.bind(console);
        const ring = this;
        const hook = (...args: unknown[]): void => {
            orig(...args);
            if (console.error !== hook) return;   // a later generation owns the tail
            if (!ring.armed) return;
            const first = args[0];
            if (typeof first !== "string") return;
            ring.push(args.length > 1 ? `${first} ${args.slice(1).join(" ")}` : first);
        };
        console.error = hook;
        this.hook = hook;
    }

    stop(): void {
        this.armed = false;
    }

    private push(line: string): void {
        if (this.lines.length >= this.capacity) {
            this.lines.shift();
            this.dropped++;
        }
        this.lines.push(line);
    }

    /** `filter` is a plain substring — the trace is hot, so no regex compile per line. */
    read(limit: number, filter?: string): {
        armed: boolean; requested: number; captured: number; dropped: number; lines: string[]; note?: string;
    } {
        const all = filter ? this.lines.filter((l) => l.indexOf(filter) !== -1) : this.lines;
        const n = Math.max(1, Math.min(limit | 0 || 200, 20_000));
        // An empty ring is two different findings and they must not read alike.
        const note = this.lines.length === 0
            ? this.requested === 0
                ? "nothing was requested — call step(n) first"
                : `${this.requested} instruction(s) were armed but the wasm emitted nothing: the guest ran none of them, or this v86 build's dbg_on_instruction hook is not reaching console.error`
            : undefined;
        return {
            armed: this.armed,
            requested: this.requested,
            captured: this.lines.length,
            dropped: this.dropped,
            lines: all.slice(Math.max(0, all.length - n)),
            ...(note ? { note } : {}),
        };
    }

    clear(): void {
        this.lines = [];
        this.dropped = 0;
    }
}

export const guestTrace = new GuestTraceRing();
