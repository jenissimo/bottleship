export const LAN_IPV6_PREFIX = Uint8Array.of(0xfd, 0x42, 0x62, 0x73, 0x6c, 0x61, 0x6e, 0, 0, 0);
export function parseIpv4(address: string): Uint8Array | null {
    const parts = address.split(".");
    if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
    return Uint8Array.from(parts.map(Number));
}
export function parseIpv6(address: string): Uint8Array | null {
    const scope = address.split("%");
    if (scope.length > 2 || (scope.length === 2 && !/^[A-Za-z0-9_.-]+$/.test(scope[1]))) return null;
    const sections = scope[0].split("::");
    if (sections.length > 2 || (sections.length === 2 && sections[0].includes("."))) return null;
    const parse = (section: string): number[] | null => {
        if (!section) return [];
        const pieces = section.split(":"), words: number[] = [];
        for (let index = 0; index < pieces.length; index++) {
            const piece = pieces[index];
            if (piece.includes(".")) {
                if (index !== pieces.length - 1) return null;
                const ipv4 = parseIpv4(piece);
                if (!ipv4) return null;
                words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
            } else {
                if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
                words.push(parseInt(piece, 16));
            }
        }
        return words;
    };
    const left = parse(sections[0]), right = sections.length === 2 ? parse(sections[1]) : [];
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (sections.length === 1 ? missing !== 0 : missing < 1) return null;
    const words = [...left, ...new Array(missing).fill(0), ...right];
    const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
    words.forEach((word, index) => view.setUint16(index * 2, word));
    return bytes;
}
export function formatIpv6(bytes: Uint8Array): string {
    if (bytes.length !== 16) throw new RangeError("IPv6 address must contain 16 bytes");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const words = Array.from({ length: 8 }, (_, index) => view.getUint16(index * 2));
    let best = -1, count = 0;
    for (let index = 0; index < words.length;) {
        if (words[index]) { index++; continue; }
        let end = index;
        while (end < words.length && !words[end]) end++;
        if (end - index > count && end - index >= 2) { best = index; count = end - index; }
        index = end;
    }
    if (best < 0) return words.map(word => word.toString(16)).join(":");
    return words.slice(0, best).map(word => word.toString(16)).join(":") + "::"
        + words.slice(best + count).map(word => word.toString(16)).join(":");
}
