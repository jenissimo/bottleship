export interface OggPacket {
    data: Uint8Array;
    granule: number;
}

export function oggPackets(buf: Uint8Array): OggPacket[] {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const packets: OggPacket[] = [];
    let serial: number | null = null;
    let pending: Uint8Array[] = [];
    for (let o = 0; o + 27 <= buf.length;) {
        if (buf[o] !== 0x4f || buf[o + 1] !== 0x67 || buf[o + 2] !== 0x67 || buf[o + 3] !== 0x53) break;
        const granuleLow = view.getUint32(o + 6, true);
        const granuleHigh = view.getInt32(o + 10, true);
        const granule = granuleHigh * 0x100000000 + granuleLow;
        const pageSerial = view.getUint32(o + 14, true);
        const segments = buf[o + 26]!;
        const tableEnd = o + 27 + segments;
        if (tableEnd > buf.length) break;
        let body = tableEnd;
        let bodySize = 0;
        for (let i = 0; i < segments; i++) bodySize += buf[o + 27 + i]!;
        if (body + bodySize > buf.length) break;
        if (serial === null) serial = pageSerial;
        if (pageSerial === serial) {
            let finishedOnPage = 0;
            for (let i = 0; i < segments; i++) if (buf[o + 27 + i]! < 255) finishedOnPage++;
            let seen = 0;
            let start = body;
            for (let i = 0; i < segments; i++) {
                const lace = buf[o + 27 + i]!;
                body += lace;
                if (lace === 255) continue;
                pending.push(buf.subarray(start, body));
                const size = pending.reduce((n, p) => n + p.length, 0);
                const data = pending.length === 1 ? pending[0]! : new Uint8Array(size);
                if (pending.length > 1) {
                    let at = 0;
                    for (const p of pending) { data.set(p, at); at += p.length; }
                }
                seen++;
                packets.push({ data, granule: seen === finishedOnPage ? granule : -1 });
                pending = [];
                start = body;
            }
            if (start < body) pending.push(buf.subarray(start, body));
        }
        o = tableEnd + bodySize;
    }
    return packets;
}

export function xiphLacedHeaders(headers: Uint8Array[]): Uint8Array {
    const lacing: number[] = [headers.length - 1];
    for (let i = 0; i < headers.length - 1; i++) {
        let n = headers[i]!.length;
        while (n >= 255) { lacing.push(255); n -= 255; }
        lacing.push(n);
    }
    const total = lacing.length + headers.reduce((n, h) => n + h.length, 0);
    const out = new Uint8Array(total);
    out.set(lacing, 0);
    let at = lacing.length;
    for (const h of headers) { out.set(h, at); at += h.length; }
    return out;
}
