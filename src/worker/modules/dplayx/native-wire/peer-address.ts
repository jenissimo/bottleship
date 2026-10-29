import type {LanNetwork} from "../../../net/lan-network";
import {isExternalIpv4Node, validPort} from "../../../net/netplay-wire";
import type {WsaAddress} from "../../wsa-network";

/** NT5 wsock/dpsp.c:1136-1169 and winsock.c:882-896:
 * retain advertised port; replace only a zero IP with the accepted TCP peer.
 * Routing checks here are local safety policy, not gateway authorization or native receiver behavior. */
export function nativeDiscoveryOwner(
    wire: Uint8Array, peer: WsaAddress, version: number, network: LanNetwork,
): {sockaddr: Uint8Array; peer: WsaAddress; version: number; address: {node: number[]; port: number}} | undefined {
    if (!(wire instanceof Uint8Array) || wire.length !== 16 || wire[0] !== 2 || wire[1] !== 0 ||
        !Number.isInteger(version) || version < 0 || version > 0xffff || peer.family !== 2 ||
        !(peer.node instanceof Uint8Array) || !isExternalIpv4Node(peer.node) ||
        !(peer.ip instanceof Uint8Array) || peer.ip.length !== 4 ||
        !peer.ip.every((value, i) => value === peer.node[i + 2]) || !validPort(peer.port)) return;
    const sockaddr = Uint8Array.from(wire), port = new DataView(sockaddr.buffer, sockaddr.byteOffset, sockaddr.byteLength).getUint16(2);
    if (!validPort(port)) return;
    if (sockaddr.subarray(4,8).every(value => value === 0)) sockaddr.set(peer.ip,4);
    const ip = Uint8Array.from(sockaddr.subarray(4,8));
    if (ip.every(value=>value===0) || ip[0]>=224) return;
    let node: Uint8Array;
    try { node=network.routeIpv4(ip); } catch { return; }
    if (!isExternalIpv4Node(node)) return;
    return {sockaddr, version, peer:{family:2,node:Uint8Array.from(peer.node),ip:Uint8Array.from(peer.ip),port:peer.port},
        address:{node:Array.from(node),port}};
}
