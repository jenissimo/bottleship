import type {UdpPeerLeaseRequest, UdpPeerLeaseReply} from "./netplay-wire";
import {UdpBindingLeaseRpc} from "./udp-binding-lease-rpc";
export {udpLeaseError} from "./udp-binding-lease-rpc";
export class UdpPeerLeaseRpc extends UdpBindingLeaseRpc<UdpPeerLeaseRequest, object> {
    constructor(wire: {
        connected(): boolean; request(id: number, request: UdpPeerLeaseRequest): boolean | void;
        cancel(id: number): void; release(leaseId: number): void;
    }) {
        super(wire, request => ({...request, node: [...request.node]}), input => {
            const reply = input as UdpPeerLeaseReply;
            if (reply && "error" in reply && reply.error) return {error: reply.error};
            return {leaseId: reply && "leaseId" in reply ? reply.leaseId : 0, metadata: {}};
        });
    }
}
