import { isIP } from "node:net";
import { parseIpv6, formatIpv6 } from "./ip-address";

/** Private protocol for the separate ordinary bound-UDP helper. */
export const UDP_BOUND = Object.freeze({
    version: 1, header: 16, address: 24, txRecords: 256, bytes: 262144,
    rxRecords: 256, controls: 64, peers: 128, maxPayload: 65527,
    maxFrame: 16 + 32 + 65527, capabilities: 0x3f,
    bind: 1, peer: 2, send: 3, credit: 4, retire: 5, close: 6, status: 7,
    orderedStatus: 9, abort: 10,
    ready: 101, peerReady: 102, sendResult: 103, creditApplied: 104, retired: 105,
    closed: 106, receive: 107, peerError: 108, losses: 109, failure: 110,
    snapshot: 111, controlCancelled: 114,
});
export interface NativeUdpEndpoint { family: 4 | 6; address: string; port: number; }
export interface NativeUdpPeerError {
    peerId: number; epoch: number; endpoint: NativeUdpEndpoint; code: number;
    nativeCode: number; origin: number; type: number; icmpCode: number; occurrences: number;
}
export interface NativeUdpLossCounters {
    rxPackets: bigint; rxBytes: bigint; errorRecords: bigint; unattributedErrors: bigint;
}
export type NativeUdpFailureKind = "binding" | "send" | "control" | "peer";
export function udpFailure(code: number, message: string, kind: NativeUdpFailureKind = "binding", nativeCode = 0): Error & {
    code: number; kind: NativeUdpFailureKind; nativeCode: number;
} {
    return Object.assign(new Error(message), { code, kind, nativeCode });
}
function ipv4Bytes(host: string): number[] | null {
    return isIP(host) === 4 ? host.split(".").map(Number) : null;
}
/** Supported ordinary unicast endpoints. Zone/mapped/multicast paths retain their existing backend. */
export function supportsBoundUdpHost(host: string): boolean {
    if (host.includes("%")) return false;
    const v4 = ipv4Bytes(host);
    if (v4) return v4[0] < 224;
    const v6 = parseIpv6(host);
    if (!v6 || v6[0] === 255 || (v6[0] === 254 && (v6[1] & 192) === 128)) return false;
    return !(v6.subarray(0, 10).every(n => n === 0) && v6[10] === 255 && v6[11] === 255);
}
export function nativeUdpEndpoint(host: string, port: number, family?: 4 | 6): NativeUdpEndpoint {
    const actual = isIP(host);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !actual || (family && family !== actual))
        throw udpFailure(10022, "Invalid native UDP endpoint", "control");
    if (!supportsBoundUdpHost(host)) throw udpFailure(10045, "Native UDP endpoint requires another backend", "control");
    const v6 = actual === 6 ? parseIpv6(host)! : undefined;
    if (v6?.every(n => n === 0)) v6[15] = 1;
    return { family: actual as 4 | 6, port,
        address: v6 ? formatIpv6(v6) : host === "0.0.0.0" ? "127.0.0.1" : host };
}
export function nativeUdpEndpointKey(endpoint: NativeUdpEndpoint): string {
    return endpoint.family + ":" + endpoint.address + ":" + endpoint.port;
}
export function encodeUdpAddress(endpoint: NativeUdpEndpoint, bind = false): Buffer {
    const { family, port } = endpoint;
    if (!Number.isInteger(port) || port < (bind ? 0 : 1) || port > 65535 || isIP(endpoint.address) !== family)
        throw udpFailure(10022, "Invalid bound UDP address", "control");
    const raw = Buffer.alloc(UDP_BOUND.address);
    raw[0] = family; raw.writeUInt16BE(port, 2);
    if (family === 4) Buffer.from(ipv4Bytes(endpoint.address)!).copy(raw, 8);
    else Buffer.from(parseIpv6(endpoint.address)!).copy(raw, 8);
    return raw;
}
export function decodeUdpAddress(bytes: Uint8Array): NativeUdpEndpoint {
    if (bytes.length !== UDP_BOUND.address) throw udpFailure(10022, "Invalid UDP address length");
    const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const family = raw[0];
    if ((family !== 4 && family !== 6) || raw[1] || raw.readUInt32LE(4))
        throw udpFailure(10022, "Unsupported UDP address family or scope");
    if (family === 4 && raw.subarray(12).some(n => n !== 0)) throw udpFailure(10022, "Invalid IPv4 padding");
    const address = family === 4 ? [...raw.subarray(8, 12)].join(".") : formatIpv6(raw.subarray(8, 24));
    return { family, address, port: raw.readUInt16BE(2) };
}
export function encodeUdpFrame(opcode: number, id: number, generation: number, payload: Buffer = Buffer.alloc(0)): Buffer {
    if (!Number.isInteger(id) || id < 1 || id > 0xffffffff ||
        !Number.isInteger(generation) || generation < 1 || generation > 0xffffffff ||
        payload.length > UDP_BOUND.maxPayload + 8)
        throw udpFailure(10022, "Invalid UDP helper command", "control");
    const frame = Buffer.allocUnsafe(UDP_BOUND.header + payload.length);
    frame.writeUInt32LE(frame.length); frame[4] = UDP_BOUND.version; frame[5] = opcode;
    frame.writeUInt16LE(0, 6); frame.writeUInt32LE(id, 8); frame.writeUInt32LE(generation, 12);
    payload.copy(frame, UDP_BOUND.header); return frame;
}
