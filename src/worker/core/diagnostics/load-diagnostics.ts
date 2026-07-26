/**
 * Load diagnostics — what went wrong while LINKING the guest, before a single
 * guest instruction runs. The rest of the report machinery (backtrace, thunk
 * ring, stubs) is live-process telemetry and is uniformly empty when an import
 * can't be thunked, so a PE-load failure otherwise reads as "nothing happened".
 *
 * Two records, both survivors of the teardown that follows:
 *  - unknown-argcount imports: the API surface gap that PRECEDES the fatal throw
 *    (the missing name is the actionable part; the throw only names the first one),
 *  - the fatal crash payload itself, including crashes raised with no CPU context.
 */

export interface UnknownArgCount {
    /** "winmm:joySetCapture" */
    key: string;
    /** Set when the import came through a DLL alias (the raw name the guest asked for). */
    aliasedFrom: string | null;
    count: number;
}

export interface LoadFailure {
    reason: string;
    eip: number;
    faultAddr: number;
    threadId: number | null;
    lastThunk: string;
}

class LoadDiagnostics {
    private unknown = new Map<string, UnknownArgCount>();
    private failure: LoadFailure | null = null;

    /** One import the thunk generator has no arity for. Deduped; cheap to repeat. */
    noteUnknownArgCount(dll: string, func: string, aliasedFrom?: string | null): void {
        const key = `${dll || "?"}:${func}`;
        const existing = this.unknown.get(key);
        if (existing) {
            existing.count++;
            return;
        }
        this.unknown.set(key, { key, aliasedFrom: aliasedFrom ?? null, count: 1 });
    }

    /** The crash that ended the run (first one wins, like System's crash funnel). */
    noteFailure(f: LoadFailure): void {
        if (!this.failure) this.failure = f;
    }

    list(): UnknownArgCount[] {
        return Array.from(this.unknown.values());
    }

    lastFailure(): LoadFailure | null {
        return this.failure;
    }

    reset(): void {
        this.unknown.clear();
        this.failure = null;
    }
}

export const loadDiagnostics = new LoadDiagnostics();
