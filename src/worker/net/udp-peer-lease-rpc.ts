import {validBindingGeneration,type UdpPeerLeaseRequest,type UdpPeerLeaseReply} from "./netplay-wire";
export function udpLeaseError(code: number, message = "UDP peer lease failed"): Error & {code: number} {
    return Object.assign(new Error(message), {code});
}
type Entry = {request: UdpPeerLeaseRequest; leaseId?: number; timer?: ReturnType<typeof setTimeout>;
    signal?: AbortSignal; abort: () => void; resolve: (lease: {release(): void}) => void; reject: (error: Error) => void};
export class UdpPeerLeaseRpc {
    private serial = 0;
    private readonly entries = new Map<number, Entry>();
    constructor(private readonly wire: {
        connected(): boolean;
        request(id: number, request: UdpPeerLeaseRequest): boolean | void;
        cancel(id: number): void;
        release(leaseId: number): void;
    }) {}
    get controlReservations(): number { return this.entries.size; }
    open(request: UdpPeerLeaseRequest, signal?: AbortSignal): Promise<{release(): void}> {
        if (signal?.aborted) return Promise.reject(udpLeaseError(995, "UDP peer lease cancelled"));
        if (!this.wire.connected()) return Promise.reject(udpLeaseError(10050, "Network unavailable"));
        const pending = [...this.entries.values()].filter(entry => entry.leaseId === undefined).length;
        if (pending >= 16 || this.entries.size >= 128 || this.serial >= 0xffffffff) return Promise.reject(udpLeaseError(10055, "UDP peer lease capacity"));
        const id = ++this.serial;
        return new Promise((resolve, reject) => {
            const entry: Entry = {request: {...request, node: [...request.node]}, signal, resolve, reject,
                abort: () => this.finish(id, udpLeaseError(995, "UDP peer lease cancelled"), true)};
            entry.timer = setTimeout(() => this.finish(id, udpLeaseError(10060, "UDP peer lease timed out"), true), 5000);
            this.entries.set(id, entry);
            signal?.addEventListener("abort", entry.abort, {once: true});
            try { if (this.wire.request(id, entry.request) === false) this.finish(id, udpLeaseError(10055, "UDP control backpressure"), false); }
            catch (error) { this.finish(id, error instanceof Error ? error : udpLeaseError(10050), true); }
        });
    }
    accept(id: number, reply: UdpPeerLeaseReply): void {
        const entry = this.entries.get(id), leaseId = reply && "leaseId" in reply ? reply.leaseId : undefined;
        // cancel(requestId) owns cleanup even after its ACK was queued. An
        // unknown ACK may belong to an older connection that reused lease IDs.
        if (!entry || entry.leaseId !== undefined) return;
        if (reply && "error" in reply && reply.error) {
            this.finish(id, udpLeaseError(reply.error.code, reply.error.message), false); return;
        }
        if (!validBindingGeneration(leaseId) || [...this.entries.values()].some(other => other.leaseId === leaseId)) {
            this.finish(id, udpLeaseError(10022, "Invalid UDP peer lease acknowledgement"), true); return;
        }
        clearTimeout(entry.timer);entry.timer = undefined;entry.leaseId = leaseId;
        entry.resolve({release: () => this.finish(id, udpLeaseError(995), true)});
    }
    retire(port?: number, proto?: number, generation?: number): void {
        for (const [id, entry] of this.entries) if ((port === undefined || entry.request.localPort === port) &&
            (proto === undefined || entry.request.proto === proto) &&
            (generation === undefined || entry.request.bindingGeneration === generation)) {
            this.finish(id, udpLeaseError(10050, "UDP peer binding closed"), true);
        }
    }
    disconnect(): void {
        for (const id of this.entries.keys()) this.finish(id, udpLeaseError(10050, "Network unavailable"), false);
    }
    private finish(id: number, error: Error, emit: boolean): void {
        const entry = this.entries.get(id);if (!entry) return;
        this.entries.delete(id);clearTimeout(entry.timer);entry.signal?.removeEventListener("abort", entry.abort);
        if (emit && this.wire.connected()) {
            if (entry.leaseId === undefined) this.wire.cancel(id);else this.wire.release(entry.leaseId);
        }
        if (entry.leaseId === undefined) entry.reject(error);
    }
}
