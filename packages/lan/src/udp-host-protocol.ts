/** Optional LAN v1 capability for an actual physical UDP Host listener. */
export interface UdpHostListenerInfo { id: string; allowedNodes: number[][] }
export interface UdpHostListenCapability { listeners: UdpHostListenerInfo[] }
export interface UdpHostOpenRequest { proto: 1; localPort: number; bindingGeneration: number; listenerId: string }
export interface UdpHostAddress { node: number[]; port: number }
export interface UdpHostReady { address: UdpHostAddress; allowedNodes: number[][] }
export type UdpHostOpenReply = ({leaseId: number} & UdpHostReady) | {error: {code: number; message: string}};
const uint = (n: unknown, max: number, min = 0): n is number => Number.isInteger(n) && Number(n) >= min && Number(n) <= max;
export function validHostIpv4Node(value: unknown): value is number[] {
    if (!Array.isArray(value) || value.length !== 6 || !value.every(n => uint(n, 255)) || value[0] !== 2 || value[1] !== 1) return false;
    // Physical listener/ACL destinations must be unicast, including loopback.
    return value[2] !== 0 && value[2] < 224 && value.slice(2).some(n => n !== 255);
}
export function validUdpHostOpenRequest(value: unknown): value is UdpHostOpenRequest {
    if (!value || typeof value !== "object") return false;
    const r = value as UdpHostOpenRequest;
    return r.proto === 1 && uint(r.localPort, 65535, 1) && uint(r.bindingGeneration, 0xffffffff, 1) &&
        typeof r.listenerId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.listenerId);
}
export function copyUdpHostReady(value: unknown): UdpHostReady {
    if (!value || typeof value !== "object") throw new Error("Invalid UDP Host reply");
    const r = value as UdpHostReady;
    if (!r.address || !validHostIpv4Node(r.address.node) || !uint(r.address.port, 65535, 1) ||
        !Array.isArray(r.allowedNodes) || !r.allowedNodes.length || r.allowedNodes.length > 32 ||
        !r.allowedNodes.every(validHostIpv4Node) || new Set(r.allowedNodes.map(n => n.join("."))).size !== r.allowedNodes.length)
        throw new Error("Invalid UDP Host endpoint or ingress ACL");
    return {address: {node: [...r.address.node], port: r.address.port}, allowedNodes: r.allowedNodes.map(n => [...n])};
}
export function copyUdpHostCapability(value: unknown): UdpHostListenCapability {
    if (!value || typeof value !== "object") throw new Error("Invalid UDP Host capability");
    const listeners = (value as UdpHostListenCapability).listeners;
    if (!Array.isArray(listeners) || listeners.length > 32) throw new Error("Invalid UDP Host listener list");
    const ids = new Set<string>();
    return {listeners: listeners.map(listener => {
        if (!listener || typeof listener.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(listener.id) ||
            ids.has(listener.id) || !Array.isArray(listener.allowedNodes) || !listener.allowedNodes.length ||
            listener.allowedNodes.length > 32 || !listener.allowedNodes.every(validHostIpv4Node) ||
            new Set(listener.allowedNodes.map(n => n.join("."))).size !== listener.allowedNodes.length)
            throw new Error("Invalid UDP Host listener");
        ids.add(listener.id); return {id: listener.id, allowedNodes: listener.allowedNodes.map(n => [...n])};
    })};
}
