import { BinaryReader, crc32, payloadPath } from '../installer/binary';
import { inflateViseSync } from '../zip/inflate';

export interface ViseEntry { name: string; dataOffset: number; packedSize: number; unpackedSize: number; service: boolean; crc32?: number; }
export interface ViseArchive { entries: ViseEntry[]; directories: string[]; objectCount: number; }

export function isVise(bytes: Uint8Array): boolean {
    return bytes.length >= 8 && bytes[bytes.length - 8] === 0x45 && bytes[bytes.length - 7] === 0x53 &&
        bytes[bytes.length - 6] === 0x49 && bytes[bytes.length - 5] === 0x56;
}

/** VISE 3's ESIV trailer points at a service header followed by its static object table. */
export function parseVise(bytes: Uint8Array, trace?: (label: string, offset: number, value?: number) => void): ViseArchive {
    if (!isVise(bytes)) throw new Error('Not a VISE installer');
    const r = new BinaryReader(bytes, 'VISE');
    const dataStart = r.view.getUint32(bytes.length - 4, true);
    r.pos = dataStart;
    if (r.text(4) !== 'ESIV') throw new Error('VISE: invalid data header');
    r.skip(12);
    for (let size; (size = r.u8()) !== 0;) r.skip(size & 0x7f);
    const entries: ViseEntry[] = [];
    const services = () => {
        const count = r.u16();
        trace?.('service-count', r.pos - 2, count);
        if (!count || count > 32767) throw new Error('VISE: invalid service file count');
        for (let i = 0; i < count; i++) {
            const name = r.text(r.u8());
            r.skip(12);
            const packedSize = r.u32(), dataOffset = r.pos;
            trace?.(name, dataOffset, packedSize);
            r.skip(packedSize);
            entries.push({ name, packedSize, dataOffset, unpackedSize: 0, service: true });
        }
    };
    services();
    r.skip(4); r.string16(); r.string16(); r.skip(2); r.string16(); r.string16(); r.skip(2);
    const serviceSize = r.u32();
    trace?.('service-data', r.pos, serviceSize);
    r.skip(serviceSize); r.skip(1);
    const counted = (visit: () => void) => {
        const count = r.u32();
        trace?.('table-count', r.pos - 4, count);
        if (count > bytes.length / 2) throw new Error(`VISE: invalid table count ${count} at ${r.pos - 4}`);
        for (let i = 0; i < count; i++) visit();
    };
    counted(() => { r.skip(104); r.string16(); r.skip(14); });
    counted(() => { r.string16(); r.string16(); });
    counted(() => { r.skip(16); r.string16(); r.string16(); });
    counted(() => { r.skip(16); for (let i = 0; i < 5; i++) r.string16(); r.skip(2); });
    services();
    const setupCount = r.u16();
    for (let i = 0; i < setupCount; i++) {
        r.string16(); r.skip(2); r.string16(); r.skip(3); r.string16(); r.skip(71);
        r.skip(r.u16() * 5); r.skip(2); r.string16();
    }
    const objectCount = r.u32();
    const folders = new Map<number, string>();
    if (objectCount > bytes.length / 4) throw new Error('VISE: invalid object count');
    for (let i = 0; i < objectCount; i++) {
        const at = r.pos, type = r.u32();
        trace?.('object', at, type);
        switch (type) {
            case 1: {
                r.check(r.pos, 100);
                const id = r.view.getUint32(r.pos, true), parent = r.view.getUint32(r.pos + 4, true);
                if (folders.has(id) || (parent && !folders.has(parent))) throw new Error('VISE: duplicate folder or unknown parent');
                r.skip(100);
                const name = r.string16(); r.skip(25);
                const path = [folders.get(parent), name].filter(Boolean).join('/');
                folders.set(id, path);
                break;
            }
            case 2: {
                r.check(r.pos, 100);
                const parent = r.view.getUint32(r.pos + 4, true);
                if (parent && !folders.has(parent)) throw new Error(`VISE: unknown parent object ${parent}`);
                r.skip(100);
                const filename = r.string16();
                r.skip(4);
                const unpackedSize = r.u32(), packedSize = r.u32();
                r.skip(4);
                const dataOffset = dataStart + r.u32();
                r.skip(37);
                r.string16();
                r.skip(14); const checksum = r.u32(); r.skip(22);
                r.check(dataOffset, packedSize);
                entries.push({ name: [folders.get(parent), filename].filter(Boolean).join('/'), packedSize, unpackedSize, dataOffset, service: false, crc32: checksum });
                break;
            }
            case 3:
                r.skip(100); r.string16(); r.skip(2);
                for (let j = 0; j < 6; j++) r.string16();
                r.skip(7); break;
            case 11:
                r.skip(100); r.string16(); r.skip(2);
                for (let j = 0; j < 4; j++) r.string16();
                r.skip(12); break;
            default: throw new Error(`VISE: unsupported object 0x${type.toString(16)} at ${at} (${i}/${objectCount})`);
        }
    }
    return { entries, directories: [...folders.values()].filter(Boolean).map(payloadPath), objectCount };
}

export function decodeViseEntry(bytes: Uint8Array, e: ViseEntry): Uint8Array {
    const input = bytes.slice(e.dataOffset, e.dataOffset + e.packedSize);
    if (input.length !== e.packedSize) throw new Error(`VISE: truncated ${e.name}`);
    // Compressed streams are stored as little-endian words with the two bytes reversed.
    for (let i = 0; i + 1 < input.length; i += 2) { const b = input[i]; input[i] = input[i + 1]; input[i + 1] = b; }
    const knownSize = !e.service;
    let size = knownSize ? e.unpackedSize : 65536;
    for (;;) {
        if (size > 512 * 1024 * 1024) throw new Error(`VISE: output limit exceeded for ${e.name}`);
        const out = new Uint8Array(size), result = inflateViseSync(input, out);
        if (result.status === 'output-full' && !knownSize) { size *= 2; continue; }
        if (result.status !== 'ok' || (knownSize && result.written !== e.unpackedSize)) {
            throw new Error(`VISE: invalid DEFLATE for ${e.name}: ${result.status}, ${result.written}/${e.unpackedSize}`);
        }
        const data = out.subarray(0, result.written);
        if (e.crc32 !== undefined && crc32(data) !== e.crc32) throw new Error(`VISE: CRC mismatch for ${e.name}`);
        return data;
    }
}

export function extractVise(bytes: Uint8Array): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    const names = new Set<string>();
    const archive = parseVise(bytes);
    for (const dir of archive.directories) out.set(`${dir}/`, new Uint8Array());
    for (const e of archive.entries) {
        if (e.service) continue;
        const path = payloadPath(e.name);
        if (names.has(path.toLowerCase())) throw new Error(`VISE: duplicate destination ${path}`);
        names.add(path.toLowerCase());
        out.set(path, decodeViseEntry(bytes, e));
    }
    return out;
}
