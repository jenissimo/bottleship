import type {TcpHostOpenRequest, TcpHostOpenReply, TcpHostReady} from "./netplay-wire";
import {copyTcpHostReady, validBindingGeneration, validTcpHostOpenRequest} from "./netplay-wire";
import {UdpBindingLeaseRpc, udpLeaseError} from "./udp-binding-lease-rpc";

export interface TcpHostFailure {code: number; message: string}
export type TcpHostMetadata = TcpHostReady & {isLive(): boolean; closed: Promise<TcpHostFailure>};
export type TcpHostLease = TcpHostMetadata & {release(): void};
function failure(value: unknown): TcpHostFailure {
    if (!value || typeof value !== "object") throw new Error("Invalid TCP Host failure");
    const {code, message} = value as TcpHostFailure;
    if (!Number.isInteger(code) || code < 10000 || code > 12000 ||
        typeof message !== "string" || message.length > 256)
        throw new Error("Invalid TCP Host failure");
    return {code,message};
}

/** Owns only RPC lifecycle. Its caller must reserve reliable cancel/release
 * queue slots before request admission and disconnect on failed cleanup. */
export class TcpHostLeaseRpc extends UdpBindingLeaseRpc<TcpHostOpenRequest, TcpHostMetadata> {
    constructor(wire: {
        connected(): boolean; request(id: number, request: TcpHostOpenRequest): boolean | void;
        cancel(id: number): void; release(leaseId: number): void;
    }) {
        const states = new WeakMap<TcpHostMetadata, {live: boolean; end(error: TcpHostFailure): void}>();
        super(wire, request => ({...request}), input => {
            if (!input || typeof input !== "object") throw new Error("Invalid TCP Host acknowledgement");
            const reply = input as TcpHostOpenReply;
            if ("error" in reply) {
                if ("leaseId" in reply || "address" in reply || "allowedNodes" in reply)
                    throw new Error("Ambiguous TCP Host acknowledgement");
                return {error: failure(reply.error)};
            }
            const ready = copyTcpHostReady(reply);
            let end!: (error: TcpHostFailure) => void;
            const closed = new Promise<TcpHostFailure>(resolve => {end = resolve;});
            const state = {live: true, end};
            const metadata = {...ready, isLive: () => state.live, closed};
            states.set(metadata,state);
            return {leaseId: "leaseId" in reply ? reply.leaseId : 0, metadata};
        }, (metadata,error) => {
            const state = states.get(metadata); if (!state || !state.live) return;
            state.live = false;
            state.end({code:(error as Error & {code?: number}).code ?? 10050,message:error.message});
            states.delete(metadata);
        });
    }
    override open(request: TcpHostOpenRequest, signal?: AbortSignal): Promise<TcpHostLease> {
        if (!validTcpHostOpenRequest(request))
            return Promise.reject(udpLeaseError(10022,"Invalid TCP Host request"));
        return super.open(request,signal);
    }
    acceptClosed(requestId: number, leaseId: number, input: unknown): void {
        if (!validBindingGeneration(requestId) || !validBindingGeneration(leaseId)) return;
        try {
            const error = failure(input);
            this.closeLease(requestId,leaseId,udpLeaseError(error.code,error.message));
        } catch { /* An invalid or foreign close cannot retire a lease. */ }
    }
}
