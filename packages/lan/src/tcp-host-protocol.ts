import {validHostIpv4Node} from "./udp-host-protocol";

/** Optional v1 listener capability; defining this type does not enable it. */
export interface TcpHostListenerInfo { id: string; allowedNodes: number[][] }
export interface TcpHostListenCapability { listeners: TcpHostListenerInfo[] }
export interface TcpHostOpenRequest { proto: 2; localPort: number; bindingGeneration: number; listenerId: string }
export interface TcpHostAddress { node: number[]; port: number }
export interface TcpHostReady { address: TcpHostAddress; allowedNodes: number[][] }
export type TcpHostOpenReply = ({leaseId: number} & TcpHostReady) | {error: {code: number; message: string}};

const uint = (v: unknown, max: number, min = 0): v is number =>
    Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
const idValid = (id: unknown): id is string =>
    typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
function copyAcl(value: unknown): number[][] {
    if (!Array.isArray(value) || !value.length || value.length > 32 ||
        !value.every(validHostIpv4Node) || new Set(value.map(n => n.join("."))).size !== value.length)
        throw new Error("Invalid TCP Host ingress ACL");
    return value.map(n => [...n]);
}
export function validTcpHostOpenRequest(value: unknown): value is TcpHostOpenRequest {
    if (!value || typeof value !== "object") return false;
    const r = value as TcpHostOpenRequest;
    return r.proto === 2 && uint(r.localPort,65535,1) &&
        uint(r.bindingGeneration,0xffffffff,1) && idValid(r.listenerId);
}
export function copyTcpHostReady(value: unknown): TcpHostReady {
    if (!value || typeof value !== "object") throw new Error("Invalid TCP Host reply");
    const r = value as TcpHostReady;
    if (!r.address || !validHostIpv4Node(r.address.node) || !uint(r.address.port,65535,1))
        throw new Error("Invalid TCP Host endpoint");
    return {address:{node:[...r.address.node],port:r.address.port},allowedNodes:copyAcl(r.allowedNodes)};
}
export function copyTcpHostCapability(value: unknown): TcpHostListenCapability {
    if (!value || typeof value !== "object") throw new Error("Invalid TCP Host capability");
    const listeners = (value as TcpHostListenCapability).listeners;
    if (!Array.isArray(listeners) || listeners.length > 32) throw new Error("Invalid TCP Host listeners");
    const ids = new Set<string>();
    return {listeners:listeners.map(listener => {
        if (!listener || !idValid(listener.id) || ids.has(listener.id)) throw new Error("Invalid TCP Host listener");
        ids.add(listener.id);
        return {id:listener.id,allowedNodes:copyAcl(listener.allowedNodes)};
    })};
}
