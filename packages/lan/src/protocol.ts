// Wire layout derived from cszackrison/bottleship, Apache-2.0; see NOTICE.
export const PROTOCOL_VERSION = 1;
export const SOCKET_PATH = "/socket.io";
export const WIRE_DGRAM = 2;
export const PROTO_IPX = 0;
export const PROTO_UDP = 1;
export const PROTO_TCP = 2;
export const PROTO_DIRECTPLAY = 3;
export const PROTO_UDP6 = 4;
export const PROTO_TCP6 = 5;
export const PROTO_RAW4 = 6;
export const PROTO_RAW6 = 7;
export const NODE_LEN = 6;
export const DGRAM_HEADER = 12;
export const IPX_MAX_PAYLOAD = 546;
export const IPX_FRAME_MAX_PAYLOAD = IPX_MAX_PAYLOAD + 2;
export const UDP_MAX_PAYLOAD = 65507;
export const UDP6_MAX_PAYLOAD = 65527;
export const DIRECTPLAY_MAX_PAYLOAD = UDP_MAX_PAYLOAD;
export const RAW_MAX_PACKET = 65535;
export const RAW_HEADER = 2;
export const RAW_OPTIONS_HEADER = 5;
export const RAW_FLAG_HDRINCL = 1, RAW_FLAG_OPTIONS = 2;
export const RAW_FRAME_MAX_PAYLOAD = RAW_MAX_PACKET + RAW_OPTIONS_HEADER;
export function rawHeaderLength(payload: Uint8Array): number { return payload[1] & RAW_FLAG_OPTIONS ? RAW_OPTIONS_HEADER : RAW_HEADER; }
export function validRawPayload(payload: Uint8Array): boolean {
    const header = rawHeaderLength(payload);
    if (payload.length < header || payload.length - header > RAW_MAX_PACKET || (payload[1] & ~3)) return false;
    if (header === RAW_OPTIONS_HEADER) { const ttl = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt16(2, true); if (ttl < -1 || ttl > 255) return false; }
    return true;
}
export const MAX_FRAME_SIZE = DGRAM_HEADER + RAW_FRAME_MAX_PAYLOAD;
export const BROADCAST_NODE = new Uint8Array([255, 255, 255, 255, 255, 255]);

export interface JoinRequest {
    version: number;
    room: string;
    clientId: string;
    node: number[];
}
export interface GatewayIpv6Address { address: number[]; node: number[]; scopeId?: number }
export interface LanReady {
    version: number;
    node: number[];
    ipv4: number[];
    gatewayIpv4?: number[][];
    gatewayIpv6?: GatewayIpv6Address[];
}
export function validBindingGeneration(value:unknown):value is number{return Number.isInteger(value)&&Number(value)>=1&&Number(value)<=0xffffffff;}
export interface DecodedDatagram {
    bindingGeneration?:number;
    proto: number;
    node: Uint8Array;
    dstPort: number;
    srcPort: number;
    payload: Uint8Array;
}
import type { ResolveRequest, ResolveReply } from "./resolve";
export interface ClientEvents {
    frame: (frame: Uint8Array, bindingGeneration?:number) => void;
    releasePort:(proto:number,port:number,bindingGeneration:number)=>void;
    resolve: (id: number, request: ResolveRequest) => void;
    cancelResolve: (id: number) => void;
}
export interface ServerEvents {
    resolved: (id: number, reply: ResolveReply) => void;
    ready: (info: LanReady) => void;
    frame: (frame: Uint8Array,bindingGeneration?:number) => void;
    peerLeft: (peer: { node: number[] }) => void;
    socketError: (error: { node: number[]; localPort: number; remotePort: number; proto: number; code: number; wireId?: number;bindingGeneration?:number }) => void;
}
export function isBroadcastNode(node: Uint8Array): boolean {
    return node.length === NODE_LEN && node.every(value => value === 255);
}
export function nodeKey(node: Uint8Array): string {
    return Array.from(node, value => value.toString(16).padStart(2, "0")).join("");
}
export function isLanNode(node: Uint8Array): boolean {
    return node.length === NODE_LEN && node[0] === 2 && node[1] === 0 && node[2] === 0
        && (node[3] | node[4] | node[5]) !== 0 && (node[3] & node[4] & node[5]) !== 255;
}
export function isExternalIpv4Node(node: Uint8Array): boolean { return node.length === NODE_LEN && node[0] === 2 && node[1] === 1; }
export function isExternalIpv6Node(node: Uint8Array): boolean { return node.length === NODE_LEN && node[0] === 2 && node[1] === 2; }
export function isExternalNode(node: Uint8Array): boolean { return isExternalIpv4Node(node) || isExternalIpv6Node(node); }
export function isAddressNode(node: Uint8Array): boolean { return isLanNode(node) || isExternalNode(node); }
export function isProtocol(proto: number): boolean {
    return Number.isInteger(proto) && proto >= PROTO_IPX && proto <= PROTO_RAW6;
}
export function isDatagramProtocol(proto: number): boolean { return proto === PROTO_IPX || proto === PROTO_UDP || proto === PROTO_UDP6 || isRawProtocol(proto); }
export function isRawProtocol(proto: number): boolean { return proto === PROTO_RAW4 || proto === PROTO_RAW6; }
export function isTcpProtocol(proto: number): boolean { return proto === PROTO_TCP || proto === PROTO_TCP6; }
export function maxPayload(proto: number): number {
    return isRawProtocol(proto) ? RAW_FRAME_MAX_PAYLOAD : proto === PROTO_IPX ? IPX_FRAME_MAX_PAYLOAD : proto === PROTO_UDP6 ? UDP6_MAX_PAYLOAD : UDP_MAX_PAYLOAD;
}
export function nodeToIpv4(node: Uint8Array): Uint8Array {
    return isExternalIpv4Node(node) ? node.slice(2, 6) : new Uint8Array([10, node[3], node[4], node[5]]);
}
export function ipv4ToNode(ip: Uint8Array, external = false): Uint8Array {
    if (ip.length !== 4) throw new RangeError("IPv4 address must have four bytes");
    if (ip[0] === 255 && ip[1] === 255 && ip[2] === 255 && ip[3] === 255) return BROADCAST_NODE.slice();
    if (ip[0] === 10 && ip[1] === 255 && ip[2] === 255 && ip[3] === 255) return BROADCAST_NODE.slice();
    return !external && (ip[0] === 10 || ip[0] === 0 || ip[0] === 127)
        ? new Uint8Array([2, 0, 0, ip[1], ip[2], ip[3]])
        : new Uint8Array([2, 1, ip[0], ip[1], ip[2], ip[3]]);
}
export function asBytes(input: unknown): Uint8Array | null {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
}
export function encodeDatagram(proto: number, node: Uint8Array, dstPort: number, srcPort: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
    if (!isProtocol(proto) || node.length !== NODE_LEN || !validPort(srcPort) || !validPort(dstPort)
        || payload.length > maxPayload(proto) || (proto === PROTO_IPX && payload.length < 2)
        || (isRawProtocol(proto) && (!validRawPayload(payload) || dstPort > 256 || srcPort > 256))) throw new RangeError("Invalid LAN datagram");
    const frame = new Uint8Array(DGRAM_HEADER + payload.length);
    frame[0] = WIRE_DGRAM;
    frame[1] = proto;
    frame.set(node, 2);
    const view = new DataView(frame.buffer);
    view.setUint16(8, dstPort);
    view.setUint16(10, srcPort);
    frame.set(payload, DGRAM_HEADER);
    return frame;
}
export function validPort(port: number): boolean {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}
export function decodeDatagram(frame: Uint8Array): DecodedDatagram | null {
    if (frame.length < DGRAM_HEADER || frame.length > MAX_FRAME_SIZE
        || frame[0] !== WIRE_DGRAM || !isProtocol(frame[1])
        || frame.length - DGRAM_HEADER > maxPayload(frame[1])
        || (frame[1] === PROTO_IPX && frame.length < DGRAM_HEADER + 2)) return null;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const dstPort = view.getUint16(8), srcPort = view.getUint16(10);
    if (!validPort(dstPort) || !validPort(srcPort)
        || (isRawProtocol(frame[1]) && (!validRawPayload(frame.subarray(DGRAM_HEADER)) || dstPort > 256 || srcPort > 256))) return null;
    return { proto: frame[1], node: frame.subarray(2, 8), dstPort, srcPort, payload: frame.subarray(DGRAM_HEADER) };
}
