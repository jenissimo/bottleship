/**
 * Load diagnostics — what went wrong while LINKING the guest, before a single
 * guest instruction runs. The rest of the report machinery (backtrace, thunk
 * ring, stubs) is live-process telemetry and is uniformly empty when an import
 * can't be thunked, so a PE-load failure otherwise reads as "nothing happened".
 *
 * Records survive the teardown that follows:
 *  - unknown-argcount imports: the API surface gap that PRECEDES the fatal throw
 *    (the missing name is the actionable part; the throw only names the first one),
 *  - DLL load failures and their search context,
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

export interface DllLoadFailure {
    name: string;
    path: string;
    searchDirectories: readonly string[];
    reason: string;
}

class LoadDiagnostics {
    private unknown = new Map<string, UnknownArgCount>();
    private failure: LoadFailure | null = null;
    private dllFailures: DllLoadFailure[] = [];
    /** How each imported DLL name was bound so far: HLE module or the real file. */
    private bindings = new Map<string, { thunked: boolean; mixed: boolean }>();

    /**
     * One import descriptor's binding. Windows maps ONE module per name per process, so an
     * image bound to our HLE module while another is bound to the shipped real DLL runs two
     * independent copies of that library — for a CRT that means two heaps, two FILE tables
     * and two locales, and every pointer that crosses between the importers is foreign to the
     * side that receives it. Returns true the first time a name ends up bound both ways.
     */
    noteImportBinding(dll: string, thunked: boolean): boolean {
        const key = dll.toLowerCase().replace(/\.dll$/, "");
        const seen = this.bindings.get(key);
        if (!seen) {
            this.bindings.set(key, { thunked, mixed: false });
            return false;
        }
        if (seen.thunked === thunked || seen.mixed) return false;
        seen.mixed = true;
        return true;
    }

    /** DLL names this process bound both to the HLE module and to a real file. */
    listMixedBindings(): string[] {
        return [...this.bindings].filter(([, b]) => b.mixed).map(([name]) => name);
    }

    noteDllFailure(failure: DllLoadFailure): void {
        if (this.dllFailures.length === 16) this.dllFailures.shift();
        this.dllFailures.push({ ...failure, searchDirectories: [...failure.searchDirectories] });
    }

    listDllFailures(): DllLoadFailure[] {
        return this.dllFailures.slice();
    }

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
        this.dllFailures.length = 0;
        this.bindings.clear();
    }
}

export const loadDiagnostics = new LoadDiagnostics();
