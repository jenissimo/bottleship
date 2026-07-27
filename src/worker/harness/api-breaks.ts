/**
 * API breakpoints — break when the guest first calls a WinAPI, with NO
 * JIT-off requirement (this hooks the JS thunk-dispatch layer, not the wasm
 * interpreter). The single biggest bring-up lever ("where does it first touch
 * D3D?"), so it's preferred over EIP breakpoints.
 *
 * Zero-cost when disarmed: the dispatcher hot path checks `apiBreaks.active`
 * (one boolean) before calling check(). On a match it builds a call snapshot
 * (args + caller), emits the `apiBreak` event correlated to the arming run, and
 * resolves any awaiting breakOnApi handler.
 */

import { harnessBus } from "./event-bus";
import { readCallSnapshot } from "./serialize";

/** Break only when a stack argument equals a value — `{ index, value }`, index 0-based
 *  over the cdecl/stdcall args at [ESP+4].. . Without it a breakpoint on a hot API
 *  (LoadString, Blt, SendMessage) fires on the first of hundreds of uninteresting
 *  calls and never on the one you are actually hunting. */
export interface ApiArgFilter {
    index: number;
    value: number;
}

interface ApiBreakEntry {
    id: number;
    pattern: string;
    regex: RegExp;
    runId: number | null;
    continuous: boolean;
    hits: number;
    argEq?: ApiArgFilter;
    onHit?: (snapshot: unknown) => void;
}

/** Translate a glob-ish pattern ("d3d9.*", "*DrawPrimitive*", "Direct3DCreate9")
 *  into a case-insensitive RegExp matched against the thunk name. */
function toRegex(pattern: string): RegExp {
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
        const end = pattern.lastIndexOf("/");
        return new RegExp(pattern.slice(1, end), pattern.slice(end + 1) || "i");
    }
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(esc, "i");
}

class ApiBreakRegistry {
    /** Hot-path gate read by the dispatcher (thunk-dispatcher.ts). */
    active = false;
    private entries: ApiBreakEntry[] = [];
    private nextId = 1;

    arm(pattern: string, opts: { runId?: number | null; continuous?: boolean; argEq?: ApiArgFilter; onHit?: (s: unknown) => void } = {}): number {
        const id = this.nextId++;
        this.entries.push({
            id,
            pattern,
            regex: toRegex(pattern),
            runId: opts.runId ?? null,
            continuous: !!opts.continuous,
            hits: 0,
            argEq: opts.argEq,
            onHit: opts.onHit,
        });
        this.active = true;
        return id;
    }

    disarm(id: number): void {
        this.entries = this.entries.filter((e) => e.id !== id);
        if (!this.entries.length) this.active = false;
    }

    clear(): number {
        const n = this.entries.length;
        this.entries = [];
        this.active = false;
        return n;
    }

    list(): Array<{ id: number; pattern: string; hits: number; continuous: boolean }> {
        return this.entries.map((e) => ({ id: e.id, pattern: e.pattern, hits: e.hits, continuous: e.continuous }));
    }

    /**
     * Called from the dispatcher hot path ONLY when `active`. Matches the thunk
     * name and, on a hit, emits apiBreak + resolves a one-shot waiter.
     */
    check(thunkName: string, eip: number, esp: number): void {
        if (!this.entries.length) return;
        let snapshot: unknown | undefined;
        // Iterate a copy so a one-shot disarm during the loop is safe.
        for (const e of [...this.entries]) {
            if (!e.regex.test(thunkName)) continue;
            if (snapshot === undefined) snapshot = readCallSnapshot(thunkName, eip, esp);
            if (e.argEq) {
                const args = (snapshot as { args?: number[] }).args ?? [];
                if ((args[e.argEq.index] >>> 0) !== (e.argEq.value >>> 0)) continue;
            }
            e.hits++;
            harnessBus.emit("apiBreak", snapshot, e.runId);
            if (e.onHit) e.onHit(snapshot);
            if (!e.continuous) this.disarm(e.id);
        }
    }
}

/** Worker-wide singleton (imported by the dispatcher hot path + breakpoints cmd). */
export const apiBreaks = new ApiBreakRegistry();
