import { validBindingGeneration } from "./netplay-wire";
export function udpLeaseError(code: number, message = "UDP binding lease failed"): Error & {code: number} {
    return Object.assign(new Error(message), {code});
}
export interface UdpBindingRequest { proto: number; localPort: number; bindingGeneration: number }
export type UdpBindingLease<M extends object> = M & {release(): void};
type Reply<M> = {leaseId: number; metadata: M} | {error: {code: number; message: string}};
type Entry<R, M extends object> = {request: R; leaseId?: number; metadata?: M; timer?: ReturnType<typeof setTimeout>;
    signal?: AbortSignal; abort(): void; resolve(lease: UdpBindingLease<M>): void; reject(error: Error): void};
/** Shared request/lease lifetime for UDP permissions and physical Host listeners.
 * Each instance has its own wire ID namespace and reserves its cleanup controls. */
export class UdpBindingLeaseRpc<R extends UdpBindingRequest, M extends object> {
    private serial = 0;
    private readonly entries = new Map<number, Entry<R, M>>();
    constructor(private readonly wire: {
        connected(): boolean; request(id: number, request: R): boolean | void;
        cancel(id: number): void; release(leaseId: number): void;
    }, private readonly copy: (request: R) => R, private readonly decode: (reply: unknown) => Reply<M>,
        private readonly ended?: (metadata: M, error: Error) => void) {}
    get controlReservations(): number { return this.entries.size; }
    open(request: R, signal?: AbortSignal): Promise<UdpBindingLease<M>> {
        if (signal?.aborted) return Promise.reject(udpLeaseError(995, "UDP binding lease cancelled"));
        if (!this.wire.connected()) return Promise.reject(udpLeaseError(10050, "Network unavailable"));
        let pending = 0;
        for (const entry of this.entries.values()) if (entry.leaseId === undefined) pending++;
        if (pending >= 16 || this.entries.size >= 128 || this.serial >= 0xffffffff)
            return Promise.reject(udpLeaseError(10055, "UDP binding lease capacity"));
        const id = ++this.serial;
        return new Promise((resolve, reject) => {
            const entry: Entry<R, M> = {request: this.copy(request), signal, resolve, reject,
                abort: () => this.finish(id, udpLeaseError(995, "UDP binding lease cancelled"), true)};
            entry.timer = setTimeout(() => this.finish(id, udpLeaseError(10060, "UDP binding lease timed out"), true), 5000);
            this.entries.set(id, entry);
            signal?.addEventListener("abort", entry.abort, {once: true});
            try {
                if (this.wire.request(id, entry.request) === false)
                    this.finish(id, udpLeaseError(10055, "UDP control backpressure"), false);
            } catch (error) {
                this.finish(id, error instanceof Error ? error : udpLeaseError(10050), true);
            }
        });
    }
    accept(id: number, input: unknown): void {
        const entry = this.entries.get(id);
        // Cancellation owns a queued late ACK; unknown IDs may belong to an old
        // connection whose server-side lease identity has since been reused.
        if (!entry || entry.leaseId !== undefined) return;
        let reply: Reply<M>;
        try { reply = this.decode(input); }
        catch { this.finish(id, udpLeaseError(10022, "Invalid UDP lease acknowledgement"), true); return; }
        if ("error" in reply) {
            this.finish(id, udpLeaseError(reply.error.code, reply.error.message), false); return;
        }
        if (!validBindingGeneration(reply.leaseId) ||
            [...this.entries.values()].some(other => other.leaseId === reply.leaseId)) {
            this.finish(id, udpLeaseError(10022, "Invalid UDP lease acknowledgement"), true); return;
        }
        clearTimeout(entry.timer); entry.timer = undefined; entry.leaseId = reply.leaseId; entry.metadata = reply.metadata;
        entry.resolve(Object.assign({}, reply.metadata, {release: () => this.finish(id, udpLeaseError(995), true)}));
    }
    protected closeLease(requestId: number, leaseId: number, error: Error): void {
        const entry = this.entries.get(requestId);
        if (entry?.leaseId === leaseId) this.finish(requestId, error, false);
    }
    retire(port?: number, proto?: number, generation?: number): void {
        for (const [id, entry] of this.entries)
            if ((port === undefined || entry.request.localPort === port) &&
                (proto === undefined || entry.request.proto === proto) &&
                (generation === undefined || entry.request.bindingGeneration === generation))
                this.finish(id, udpLeaseError(10050, "UDP binding closed"), true);
    }
    disconnect(): void {
        for (const id of this.entries.keys()) this.finish(id, udpLeaseError(10050, "Network unavailable"), false);
    }
    private finish(id: number, error: Error, emit: boolean): void {
        const entry = this.entries.get(id); if (!entry) return;
        this.entries.delete(id); clearTimeout(entry.timer); entry.signal?.removeEventListener("abort", entry.abort);
        if (entry.metadata !== undefined) this.ended?.(entry.metadata, error);
        if (emit && this.wire.connected()) {
            if (entry.leaseId === undefined) this.wire.cancel(id); else this.wire.release(entry.leaseId);
        }
        if (entry.leaseId === undefined) entry.reject(error);
    }
}
