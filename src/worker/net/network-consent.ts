/**
 * Network permission: the guest's first operation that needs the relay asks the host, and
 * nothing reaches the relay server before the user agreed.
 *
 * The decision is made by the HOST page (it owns the dialog and the relay settings). The
 * worker parks the calling thread on a restartable Promise and, once answered, re-issues
 * the call (ThunkResult.reissue), so the API runs exactly once, synchronously, on its own
 * thread and with its own frame — granted, over the connected relay; denied, as on a PC
 * without a network.
 *
 * Mode "off" (the default) is the embedding contract from before: no prompt, the network
 * follows `set_network` alone. The app switches to "ask".
 */
import { markRestartable } from "../core/thunking/restartable";
import type { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";

export type NetworkConsentMode = "off" | "ask";
export type NetworkConsentDecision = "undecided" | "granted" | "denied";
export type NetworkConsentApi = "winsock" | "directplay" | "directplay8";
export interface NetworkConsentReason { api: NetworkConsentApi; operation: string; target?: string }
export interface NetworkConsentRequest extends NetworkConsentReason { id: number }
/** What a gate tells its caller: run the real call, refuse it, or wait for the host. */
export type NetworkConsentVerdict = "allow" | "deny" | Promise<ThunkResult>;

interface Pending { id: number; reason: NetworkConsentReason; resolve: () => void; released: Promise<void>; settled: boolean }

export class NetworkConsent {
    private mode: NetworkConsentMode = "off";
    private decision: NetworkConsentDecision = "undecided";
    private pending: Pending | null = null;
    private nextId = 1;
    private readonly listeners = new Set<(waiting: boolean) => void>();
    /** Host channel; the app installs it with mode "ask". */
    post: (request: NetworkConsentRequest) => void = () => {};
    /** Runs before parked callers are released (e.g. wait for the relay to be ready). */
    beforeRelease: () => Promise<void> = () => Promise.resolve();

    configure(mode: NetworkConsentMode): void {
        this.mode = mode;
        if (mode === "off") this.release();
    }
    get state(): { mode: NetworkConsentMode; decision: NetworkConsentDecision; waiting: NetworkConsentRequest | null } {
        return { mode: this.mode, decision: this.decision,
            waiting: this.pending && !this.pending.settled ? { id: this.pending.id, ...this.pending.reason } : null };
    }
    /** An explicit host action (Connect / Disconnect, `set_network`) is a decision. */
    decide(decision: Exclude<NetworkConsentDecision, "undecided">): void {
        this.decision = decision;
        this.release();
    }
    /** The host's answer to one request; a stale id is ignored. */
    answer(id: number, granted: boolean): void {
        if (!this.pending || this.pending.id !== id) return;
        this.decide(granted ? "granted" : "denied");
    }
    /** Called by the waiting-state listeners (the worker pauses the guest meanwhile). */
    onWaitingChange(listener: (waiting: boolean) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    check(reason: NetworkConsentReason): NetworkConsentVerdict {
        if (this.mode === "off" || this.decision === "granted") return "allow";
        if (this.decision === "denied") return "deny";
        if (this.pending && !this.pending.settled) return this.park(this.pending);
        let resolve!: () => void;
        const released = new Promise<void>(done => { resolve = done; });
        const entry: Pending = { id: this.nextId++, reason: { ...reason }, resolve, released, settled: false };
        this.pending = entry;
        for (const listener of this.listeners) listener(true);
        this.post({ id: entry.id, ...reason });
        return this.park(entry);
    }
    /** One Promise per parked thread: the dispatcher keys its parks by Promise identity.
     *  Always restartable: the only result is "run the call again", which a savestate
     *  rewind is too. */
    private park(entry: Pending): Promise<ThunkResult> {
        return markRestartable(entry.released.then((): ThunkResult => ({ value: 0, reissue: true })));
    }
    private release(): void {
        const entry = this.pending;
        if (!entry || entry.settled) return;
        entry.settled = true;
        const finish = () => {
            if (this.pending === entry) this.pending = null;
            entry.resolve();
            for (const listener of this.listeners) listener(false);
        };
        void this.beforeRelease().then(finish, finish);
    }
    /** Tests and worker reset. */
    reset(): void {
        this.release();
        this.mode = "off"; this.decision = "undecided"; this.pending = null;
    }
}

// @transient(page-session permission owned by the host page; a savestate re-issues a parked call and asks again)
export const networkConsent = new NetworkConsent();

/**
 * Wrap a thunk so that `classify` decides, before the real implementation runs, whether
 * the call needs the relay. `classify` returns null for traffic that stays inside this
 * guest session; it must not throw or touch guest state beyond reading the arguments.
 * `deny` produces the API's own failure once the user said no; undefined runs the real
 * call, which then behaves as without a network.
 */
export function gateNetworkThunk(impl: ThunkImplementation,
    classify: (args: number[]) => NetworkConsentReason | null,
    deny?: (args: number[]) => number | ThunkResult,
    consent: NetworkConsent = networkConsent): ThunkImplementation {
    return (ctx, mem, args) => {
        let reason: NetworkConsentReason | null = null;
        try { reason = classify(args); } catch { reason = null; }
        if (!reason) return impl(ctx, mem, args);
        const verdict = consent.check(reason);
        if (verdict === "allow") return impl(ctx, mem, args);
        if (verdict === "deny") return deny ? deny(args.slice()) : impl(ctx, mem, args);
        return verdict;
    };
}
