import type { RandomAccessSource } from '../unpack/source';
import { BinaryReader, crc32, payloadPath } from '../installer/binary';
import { decodeRar29Solid, type RarPpmSession } from './lz29';
import { decodeRar4Name } from './filename';

export interface Rar4Entry { name: string; dataOffset: number; packedSize: number; unpackedSize: number; crc32: number; version: number; method: number; flags: number; isDirectory: boolean; }
export interface Rar4Archive { entries: Rar4Entry[]; multiVolume: boolean; }

export function findRar4(bytes: Uint8Array): number | null {
    for (let i = 0; i + 7 <= Math.min(bytes.length, 1 << 20); i++) {
        if (bytes[i] === 0x52 && bytes[i + 1] === 0x61 && bytes[i + 2] === 0x72 && bytes[i + 3] === 0x21 &&
            bytes[i + 4] === 0x1a && bytes[i + 5] === 7 && bytes[i + 6] === 0) return i;
    }
    return null;
}

export function parseRar4(source: RandomAccessSource, offset = 0): Rar4Archive {
    if (findRar4(source.readRangeSync(offset, offset + 7)) !== 0) throw new Error('Not a RAR4 archive');
    const entries: Rar4Entry[] = [];
    let pos = offset + 7, main = false, multiVolume = false, end = false;
    while (pos + 7 <= source.size) {
        const fixed = new BinaryReader(source.readRangeSync(pos, pos + 7), 'RAR4');
        const checksum = fixed.u16(), type = fixed.u8(), flags = fixed.u16(), size = fixed.u16();
        if (size < 7 || pos + size > source.size) throw new Error('RAR4: invalid header extent');
        const bytes = source.readRangeSync(pos, pos + size), r = new BinaryReader(bytes, 'RAR4');
        if ((crc32(bytes.subarray(2)) & 65535) !== checksum) throw new Error(`RAR4: header CRC mismatch at ${pos}`);
        r.pos = 7;
        let dataSize = (flags & 0x8000) ? r.u32() : 0;
        if (type === 0x73) {
            if (main) throw new Error('RAR4: duplicate main header');
            main = true; multiVolume = !!(flags & 1);
            if (flags & 128) throw new Error('RAR4: encrypted headers are unsupported');
        } else if (type === 0x74) {
            if (!main) throw new Error('RAR4: file before main header');
            let unpackedSize = r.u32();
            const hostOS = r.u8(), checksum = r.u32(); r.skip(4);
            const version = r.u8(), method = r.u8(), nameSize = r.u16(), attributes = r.u32();
            if (flags & 256) { dataSize += r.u32() * 2 ** 32; unpackedSize += r.u32() * 2 ** 32; }
            r.check(r.pos, nameSize);
            const name = payloadPath(decodeRar4Name(bytes.subarray(r.pos, r.pos + nameSize), !!(flags & 512)));
            r.skip(nameSize);
            const isDirectory = (flags & 0xe0) === 0xe0 || (hostOS <= 2 && !!(attributes & 16));
            entries.push({ name, dataOffset: pos + size, packedSize: dataSize, unpackedSize, crc32: checksum, version, method, flags, isDirectory });
        } else if (type === 0x7b) { end = true; break; }
        if (!Number.isSafeInteger(dataSize) || pos + size + dataSize > source.size) throw new Error(`RAR4: truncated data at ${pos}`);
        pos += size + dataSize;
    }
    if (!main || !end) throw new Error('RAR4: missing main/end header');
    return { entries, multiVolume };
}

export interface Rar4Options { createPpmSession?: (input: Uint8Array) => RarPpmSession; }
export function extractRar4(source: RandomAccessSource, offset = 0, options: Rar4Options = {}): Map<string, Uint8Array> {
    const archive = parseRar4(source, offset), out = new Map<string, Uint8Array>();
    const names = new Set<string>(), decoded = new Map<Rar4Entry, Uint8Array>();
    let group: Rar4Entry[] = [];
    const read = (e: Rar4Entry) => {
        const bytes = source.readRangeSync(e.dataOffset, e.dataOffset + e.packedSize);
        if (bytes.length !== e.packedSize) throw new Error(`RAR4: truncated data for ${e.name}`);
        return bytes;
    };
    const flush = () => {
        if (!group.length) return;
        const files = decodeRar29Solid(group.map(e => ({ input: read(e), expectedSize: e.unpackedSize })), options.createPpmSession);
        group.forEach((e, i) => decoded.set(e, files[i]));
        group = [];
    };
    if (archive.multiVolume) throw new Error('RAR4: multi-volume decompression is unsupported');
    for (const e of archive.entries) {
        const key = e.name.toLowerCase();
        if (names.has(key)) throw new Error(`RAR4: duplicate destination ${e.name}`);
        names.add(key);
        if (e.flags & 4) throw new Error(`RAR4: encrypted file ${e.name}`);
        if (e.flags & 3) throw new Error(`RAR4: split file ${e.name}`);
        if (e.isDirectory) { decoded.set(e, new Uint8Array(0)); continue; }
        if (!(e.flags & 16)) flush();
        if (e.method === 0x30) {
            if (e.flags & 16) throw new Error('RAR4: stored members in solid groups are unsupported');
            decoded.set(e, read(e).slice());
        } else if (e.method >= 0x31 && e.method <= 0x35 && e.version === 29) {
            if ((e.flags & 16) && !group.length) throw new Error(`RAR4: solid file without preceding compressed member ${e.name}`);
            group.push(e);
        } else throw new Error(`RAR4: unsupported coding ${e.version}/${e.method} for ${e.name}`);
    }
    flush();
    for (const e of archive.entries) {
        const data = decoded.get(e)!;
        if (!e.isDirectory && (data.length !== e.unpackedSize || crc32(data) !== e.crc32)) throw new Error(`RAR4: size/CRC mismatch for ${e.name}`);
        out.set(e.isDirectory ? `${e.name}/` : e.name, data);
    }
    return out;
}
