/** IP headers at the Winsock RAW boundary. All integers on the wire use network byte order. */
export interface RawIpPacket { protocol: number; headerLength: number; packet: Uint8Array; source: Uint8Array; destination: Uint8Array; }
export function ipChecksum(bytes: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] ?? 0);
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
    return (~sum) & 0xffff;
}
export function parseRawIp(bytes: Uint8Array, family: number): RawIpPacket | null {
    if (family === 2) {
        if (bytes.length < 20 || bytes.length > 65535 || bytes[0] >>> 4 !== 4) return null;
        const headerLength = (bytes[0] & 15) * 4, total = (bytes[2] << 8) | bytes[3];
        if (headerLength < 20 || headerLength > bytes.length || (total !== 0 && total !== bytes.length)) return null;
        return { protocol: bytes[9], headerLength, packet: bytes.slice(), source: bytes.slice(12, 16), destination: bytes.slice(16, 20) };
    }
    if (family === 23) {
        if (bytes.length < 40 || bytes.length > 65535 || bytes[0] >>> 4 !== 6) return null;
        if (((bytes[4] << 8) | bytes[5]) !== bytes.length - 40) return null;
        return { protocol: bytes[6], headerLength: 40, packet: bytes.slice(), source: bytes.slice(8, 24), destination: bytes.slice(24, 40) };
    }
    return null;
}
export function ipv4RawPacket(payload: Uint8Array, protocol: number, source: Uint8Array, destination: Uint8Array,
    identification: number, ttl = 128, tos = 0): Uint8Array {
    const result = new Uint8Array(payload.length + 20), view = new DataView(result.buffer);
    result[0] = 0x45; result[1] = tos; view.setUint16(2, result.length); view.setUint16(4, identification);
    result[8] = ttl; result[9] = protocol; result.set(source, 12); result.set(destination, 16);
    view.setUint16(10, ipChecksum(result.subarray(0, 20))); result.set(payload, 20);
    return result;
}
