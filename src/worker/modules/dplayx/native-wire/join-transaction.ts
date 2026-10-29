/**
 * Isolated local ownership primitive for a future native DP4 Join.
 * This does not perform I/O, publish a session, or authorize a gateway route.
 * The caller must check exact cache, process, transport and lease ownership in
 * the supplied liveness function, including after each async/reentrant step.
 */
export interface DirectPlay4JoinLease { release(): void; }
export type DirectPlay4JoinStage = "lease" | "player-id" | "name-table" | "ready" | "committed" | "cancelled";

export class DirectPlay4JoinTransaction {
    private state: DirectPlay4JoinStage = "lease";
    private lease?: DirectPlay4JoinLease;
    private transferred?: DirectPlay4JoinLease;
    private readonly released = new WeakSet<DirectPlay4JoinLease>();
    private readonly aborter = new AbortController();
    readonly signal = this.aborter.signal;
    constructor(private readonly ownsEpochs: () => boolean) {}

    get stage(): DirectPlay4JoinStage { return this.state; }

    /** A liveness check can synchronously cancel/reenter this transaction. */
    current(): boolean {
        if (this.state === "cancelled" || this.state === "committed") return false;
        let owned = false;
        try { owned = this.ownsEpochs(); } catch { /* fail closed */ }
        if (!owned) { this.cancel(); return false; }
        return this.isPending();
    }
    private isPending(): boolean { return this.state !== "cancelled" && this.state !== "committed"; }

    private release(resource: DirectPlay4JoinLease): void {
        if (this.released.has(resource)) return;
        this.released.add(resource);
        try { resource.release(); } catch { /* release remains owned by its provider */ }
    }

    /** Adopt an asynchronously acquired lease, or retire that exact late lease. */
    adopt(resource: DirectPlay4JoinLease): boolean {
        if (!resource || typeof resource.release !== "function") throw new TypeError("invalid Join lease");
        if (resource === this.lease || resource === this.transferred) return false;
        if (this.state !== "lease" || !this.current() || this.state !== "lease") {
            // Liveness can reenter and adopt or transfer this very resource.
            if (resource !== this.lease && resource !== this.transferred) this.release(resource);
            return false;
        }
        this.lease = resource;
        this.state = "player-id";
        return true;
    }

    playerIdReceived(): boolean { return this.advance("player-id", "name-table"); }
    nameTableReceived(): boolean { return this.advance("name-table", "ready"); }
    private advance(from: DirectPlay4JoinStage, to: DirectPlay4JoinStage): boolean {
        if (this.state !== from || !this.current() || this.state !== from) return false;
        this.state = to; return true;
    }

    /** Transfer the exact lease to the caller; publication still needs its own fence. */
    commit(): DirectPlay4JoinLease | undefined {
        if (this.state !== "ready" || !this.current() || this.state !== "ready") return;
        const lease = this.lease;
        if (!lease) { this.cancel(); return; }
        this.lease = undefined; this.transferred = lease; this.state = "committed";
        return lease;
    }

    /** Idempotent: committed leases have already been transferred to the caller. */
    cancel(): void {
        if (this.state === "cancelled" || this.state === "committed") return;
        this.state = "cancelled";
        const lease = this.lease; this.lease = undefined;
        this.aborter.abort();
        if (lease) this.release(lease);
    }
}
