/** ICMP echo identifier translation keeps native raw replies within their participant. */
export function internetChecksum(bytes: Uint8Array): number {
    let sum = 0;
    for (let index = 0; index < bytes.length; index += 2) sum += (bytes[index] << 8) | (bytes[index + 1] ?? 0);
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
    return (~sum) & 0xffff;
}
export function icmpOffset(packet: Uint8Array, family: 4 | 6, headerIncluded: boolean): number | null {
    if (!headerIncluded) return packet.length >= 8 ? 0 : null;
    if (family === 4) {
        const header = (packet[0] & 15) * 4;
        return packet[0] >>> 4 === 4 && header >= 20 && packet.length >= header + 8 && packet[9] === 1 ? header : null;
    }
    return packet[0] >>> 4 === 6 && packet.length >= 48 && packet[6] === 58 ? 40 : null;
}
export function echoIdentifier(packet: Uint8Array, family: 4 | 6, headerIncluded: boolean, reply: boolean): number | null {
    const offset = icmpOffset(packet, family, headerIncluded);
    if (offset === null || packet[offset] !== (family === 4 ? (reply ? 0 : 8) : reply ? 129 : 128) || packet[offset + 1] !== 0) return null;
    return (packet[offset + 4] << 8) | packet[offset + 5];
}
export function translateEcho(packet: Uint8Array, family: 4 | 6, headerIncluded: boolean, id: number): Uint8Array<ArrayBuffer> {
    const bytes = packet.slice(), offset = icmpOffset(bytes, family, headerIncluded);
    if (offset === null) throw new RangeError("Invalid ICMP echo packet");
    bytes[offset + 4] = id >>> 8; bytes[offset + 5] = id;
    // IPv6 checksum includes the actual native source/destination; its kernel sets it.
    if (family === 4) {
        bytes[offset + 2] = bytes[offset + 3] = 0;
        const checksum = internetChecksum(bytes.subarray(offset)); bytes[offset + 2] = checksum >>> 8; bytes[offset + 3] = checksum;
    }
    return bytes;
}
export function setIcmpv6Checksum(packet: Uint8Array, source: Uint8Array, destination: Uint8Array): void {
    if (source.length !== 16 || destination.length !== 16 || packet.length < 8) throw new RangeError("Invalid ICMPv6 checksum inputs");
    packet[2] = packet[3] = 0;
    const pseudo = new Uint8Array(40 + packet.length); pseudo.set(source); pseudo.set(destination, 16);
    new DataView(pseudo.buffer).setUint32(32, packet.length); pseudo[39] = 58; pseudo.set(packet, 40);
    const sum = internetChecksum(pseudo); packet[2] = sum >>> 8; packet[3] = sum;
}
export function rewriteIpv4Header(packet: Uint8Array, source: Uint8Array, destination: Uint8Array): void {
    const header = (packet[0] & 15) * 4;
    if (packet[0] >>> 4 !== 4 || header < 20 || packet.length < header || source.length !== 4 || destination.length !== 4) throw new RangeError("Invalid IPv4 raw header");
    packet.set(source, 12); packet.set(destination, 16); packet[10] = packet[11] = 0;
    const checksum = internetChecksum(packet.subarray(0, header)); packet[10] = checksum >>> 8; packet[11] = checksum;
}
