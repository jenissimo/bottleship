import { BinaryReader, crc32, payloadPath, peOverlay } from '../installer/binary';
import { inflateRawSync } from '../zip/inflate';

export interface WiseEntry { name: string; dataOffset: number; packedSize: number; unpackedSize: number; crc32: number; service: boolean; data: Uint8Array; }
export interface WiseArchive { entries: WiseEntry[]; script: Uint8Array; }

export function isWise(bytes: Uint8Array): boolean {
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
    const end = Math.min(bytes.length, 1 << 20);
    return new TextDecoder('latin1').decode(bytes.subarray(0, end)).includes('WiseMain');
}

function inflateMember(bytes: Uint8Array, offset: number, expected = 0) {
    let size = expected || 65536;
    for (;;) {
        if (size > 512 * 1024 * 1024) throw new Error('Wise: output limit exceeded');
        const out = new Uint8Array(size), result = inflateRawSync(bytes, out, offset);
        if (result.status === 'output-full' && !expected) { size *= 2; continue; }
        if (result.status !== 'ok' || (expected && expected !== result.written)) throw new Error(`Wise: invalid stream at ${offset}: ${result.status}`);
        const data = out.subarray(0, result.written), crc = crc32(data);
        const r = new BinaryReader(bytes, 'Wise');
        // Some Wise writers word-align the checksum after the final DEFLATE byte.
        for (let padding = 0; padding < 8; padding++) {
            const tail = offset + result.consumed + padding;
            if (tail + 4 > bytes.length) break;
            if (r.view.getUint32(tail, true) === crc) return { data, crc, end: tail + 4 };
        }
        throw new Error(`Wise: CRC mismatch at ${offset}`);
    }
}

/** Each Wise stream is authenticated by its trailing CRC; script file records bind names to extents. */
export function parseWise(bytes: Uint8Array, onMember?: (e: WiseEntry) => void): WiseArchive {
    if (!isWise(bytes)) throw new Error('Not a Wise installer');
    const overlay = peOverlay(bytes);
    if (overlay === null) throw new Error('Wise: unsupported executable stub');
    let first = -1;
    for (let p = overlay; p < Math.min(bytes.length, overlay + 4096); p++) {
        try { const m = inflateMember(bytes.subarray(0, Math.min(bytes.length, p + (1 << 20))), p); if (m.data.length) { first = p; break; } } catch { /* CRC-anchored candidate probe. */ }
    }
    if (first < 0) throw new Error('Wise: no CRC-verified DEFLATE payload');
    const entries: WiseEntry[] = [];
    let script: Uint8Array | null = null, p = first;
    while (p < bytes.length) {
        const m = inflateMember(bytes, p);
        const isScript = m.data[1] === 0 && [4, 8, 20, 23].includes(m.data[0]);
        if (isScript && !script) script = m.data;
        entries.push({ name: isScript ? 'script.bin' : `service-${entries.length}.bin`, dataOffset: p,
            packedSize: m.end - p, unpackedSize: m.data.length, crc32: m.crc, data: m.data, service: true });
        onMember?.(entries[entries.length - 1]);
        p = m.end;
    }
    if (!script) throw new Error('Wise: unsupported install script');
    const s = new BinaryReader(script, 'Wise script');
    const records: { start: number; end: number; size: number; crc: number; name: string }[] = [];
    for (let at = 0; at + 44 < script.length; at++) {
        if (script[at] !== 0) continue;
        const start = s.view.getUint32(at + 3, true), end = s.view.getUint32(at + 7, true);
        const size = s.view.getUint32(at + 15, true), crc = s.view.getUint32(at + 39, true);
        if (end <= start || end - start > bytes.length || size > 512 * 1024 * 1024) continue;
        let tail = at + 43;
        while (tail < script.length && script[tail] !== 0) tail++;
        if (tail === script.length || tail - at > 4096 || script[at + 43] <= 32) continue;
        s.pos = at + 43;
        const name = s.text(tail - s.pos);
        if (!/^%[A-Za-z0-9_]+%[\\/]/.test(name) || /[\x01-\x1f\x7f]/.test(name)) continue;
        records.push({ start, end, size, crc, name });
    }
    const bases = new Map<number, number>();
    for (const r of records) for (const e of entries) {
        if (r.size === e.unpackedSize && r.end - r.start === e.packedSize && (!r.crc || r.crc === e.crc32)) {
            const base = e.dataOffset - r.start;
            bases.set(base, (bases.get(base) ?? 0) + 1);
        }
    }
    const base = [...bases].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (base === undefined) throw new Error('Wise: no file records match the payload');
    for (const r of records) {
        const e = entries.find(e => e.dataOffset === base + r.start && e.packedSize === r.end - r.start && e.unpackedSize === r.size && (!r.crc || r.crc === e.crc32));
        if (!e) throw new Error(`Wise: file record does not match a verified payload: ${r.name}`);
        if (!e.service && e.name !== r.name) throw new Error(`Wise: ambiguous destination for ${e.dataOffset}`);
        e.name = r.name;
        e.service = false;
    }
    return { entries, script };
}

export function extractWise(bytes: Uint8Array, rootVariable = 'MAINDIR'): Map<string, Uint8Array> {
    const archive = parseWise(bytes), out = new Map<string, Uint8Array>();
    const names = new Set<string>();
    const prefix = `%${rootVariable.toUpperCase()}%/`;
    for (const e of archive.entries) {
        const name = e.name.replace(/\\/g, '/');
        if (e.service || !name.toUpperCase().startsWith(prefix)) continue;
        const path = payloadPath(name.slice(prefix.length));
        if (names.has(path.toLowerCase())) throw new Error(`Wise: duplicate destination ${path}`);
        names.add(path.toLowerCase());
        out.set(path, e.data);
    }
    if (!out.size) throw new Error(`Wise: no files under %${rootVariable}%`);
    return out;
}
