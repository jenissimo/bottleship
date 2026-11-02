import type {UdpHostOpenRequest, UdpHostOpenReply, UdpHostReady} from "./netplay-wire";
import {copyUdpHostReady, validBindingGeneration} from "./netplay-wire";
import {UdpBindingLeaseRpc, udpLeaseError} from "./udp-binding-lease-rpc";
export interface UdpHostFailure {code: number; message: string}
export type UdpHostMetadata = UdpHostReady & {isLive(): boolean; closed: Promise<UdpHostFailure>};
export type UdpHostLease = UdpHostMetadata & {release(): void};
function failure(value: unknown): UdpHostFailure {
    if (!value || typeof value !== "object") throw new Error("Invalid UDP Host failure");
    const {code, message} = value as UdpHostFailure;
    if (!Number.isInteger(code) || code < 10000 || code > 12000 || typeof message !== "string" || message.length > 256)
        throw new Error("Invalid UDP Host failure");
    return {code, message};
}
export class UdpHostLeaseRpc extends UdpBindingLeaseRpc<UdpHostOpenRequest, UdpHostMetadata> {
    constructor(wire: {
        connected(): boolean; request(id: number, request: UdpHostOpenRequest): boolean | void;
        cancel(id: number): void; release(leaseId: number): void;
    }) {
        const states = new WeakMap<UdpHostMetadata, {live: boolean; end(error: UdpHostFailure): void}>();
        super(wire, request => ({...request}), input => {
            const reply = input as UdpHostOpenReply;
            if (reply && "error" in reply && reply.error) return {error: failure(reply.error)};
            const ready = copyUdpHostReady(reply);
            let end!: (error: UdpHostFailure) => void;
            const closed = new Promise<UdpHostFailure>(resolve => {end = resolve;});
            const state = {live: true, end};
            const metadata = {...ready, isLive: () => state.live, closed};
            states.set(metadata, state);
            return {leaseId: reply && "leaseId" in reply ? reply.leaseId : 0, metadata};
        }, (metadata, error) => {
            const state = states.get(metadata); if (!state || !state.live) return;
            state.live = false; state.end({code: (error as Error & {code?: number}).code ?? 10050, message: error.message});
            states.delete(metadata);
        });
    }
    acceptClosed(requestId: number, leaseId: number, input: unknown): void {
        if (!validBindingGeneration(requestId) || !validBindingGeneration(leaseId)) return;
        try { const error = failure(input); this.closeLease(requestId, leaseId, udpLeaseError(error.code, error.message)); }
        catch { /* Malformed unsolicited events cannot retire a different lease. */ }
    }
}
