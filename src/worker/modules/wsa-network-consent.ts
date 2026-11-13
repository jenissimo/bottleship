/**
 * Which Winsock destinations leave this guest session. Loopback, the guest's own address
 * and the unspecified address stay local (a launcher talking to its game, a single-player
 * game talking to its own server); everything else — another host, a broadcast, a
 * multicast group — needs the relay, and therefore the user's permission.
 */
import type { WsaAddress } from "./wsa-network";
import { formatIpv6 } from "../net/netplay-wire";

export interface LocalIdentity { node: Uint8Array; ipv4: Uint8Array; ipv6: Uint8Array }

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const zeros = (a: Uint8Array) => a.every(v => v === 0);
function mapped(ip: Uint8Array): Uint8Array | undefined {
    return ip.length === 16 && ip.subarray(0, 10).every(v => v === 0) && ip[10] === 255 && ip[11] === 255 ? ip.subarray(12) : undefined;
}
function ipv4Local(ip: Uint8Array, self: LocalIdentity): boolean {
    return ip[0] === 127 || zeros(ip) || same(ip, self.ipv4);
}
function ipv6Local(ip: Uint8Array, self: LocalIdentity): boolean {
    const v4 = mapped(ip);
    if (v4) return ipv4Local(v4, self);
    const loopback = ip.subarray(0, 15).every(v => v === 0) && ip[15] === 1;
    return loopback || zeros(ip) || same(ip, self.ipv6);
}

/** True when sending to / connecting to `peer` would need the relay. */
export function wsaDestinationLeavesSession(peer: WsaAddress, self: LocalIdentity): boolean {
    if (peer.family === 2) return !!peer.ip && !ipv4Local(peer.ip, self);
    if (peer.family === 23) return !!peer.ip6 && !ipv6Local(peer.ip6, self);
    if (peer.family === 6) return !zeros(peer.node) && !same(peer.node, self.node);
    return false;
}

/** A listening socket is reachable from outside unless it is bound to a loopback address. */
export function wsaListenerLeavesSession(local: WsaAddress | null, af: number): boolean {
    if (af === 2) return !(local?.ip && local.ip[0] === 127);
    if (af === 23) {
        const ip = local?.ip6;
        if (!ip) return true;
        const v4 = mapped(ip);
        if (v4) return v4[0] !== 127;
        return !(ip.subarray(0, 15).every(v => v === 0) && ip[15] === 1);
    }
    return false;
}

export function describeWsaAddress(peer: WsaAddress): string {
    if (peer.family === 2 && peer.ip) return `${[...peer.ip].join(".")}:${peer.port}`;
    if (peer.family === 23 && peer.ip6) return `[${formatIpv6(peer.ip6)}]:${peer.port}`;
    if (peer.family === 6) return `IPX ${[...peer.node].map(v => v.toString(16).padStart(2, "0")).join("")}:${peer.port}`;
    return "";
}
