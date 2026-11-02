/** Virtual IPv4 UDP multicast envelope; see plan/udp-multicast4-v1.md. */
export const WIRE_DGRAM_MULTICAST4 = 3;
export const MULTICAST4_DGRAM_HEADER = 20;
export interface UdpMulticast4Header {
    group: Uint8Array;
    interfaceIndex: 1 | 2;
    ttl: number;
}
export function isIpv4Multicast(address: Uint8Array): boolean {
    return address.length === 4 && address[0] >= 224 && address[0] <= 239;
}
export function isMulticastIpv4Node(node: Uint8Array): boolean {
    return node.length === 6 && node[0] === 2 && node[1] === 3 && isIpv4Multicast(node.subarray(2));
}
export function multicast4Node(group: Uint8Array): Uint8Array {
    if (!isIpv4Multicast(group)) throw new RangeError("Invalid IPv4 multicast group");
    return Uint8Array.of(2, 3, ...group);
}
export function validMulticast4Header(value: UdpMulticast4Header): boolean {
    return value !== null && typeof value === "object" && value.group instanceof Uint8Array
        && isIpv4Multicast(value.group) && (value.interfaceIndex === 1 || value.interfaceIndex === 2)
        && Number.isInteger(value.ttl) && value.ttl >= 0 && value.ttl <= 255;
}
