import type { RandomAccessSource } from '../unpack/source';
import { BinaryReader, crc32, payloadPath } from '../installer/binary';
import { decodeRar29Solid, rar29OutputLimit, type RarPpmSession } from './lz29';
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

export interface Rar4Options {
    createPpmSession?: (input: Uint8Array) => RarPpmSession;
    /** Maximum decoded bytes per solid group or stored member; defaults to 512 MiB. */
    maxOutputBytes?: number;
    /** Publication filter only: all members still decode and pass CRC, including solid history. */
    wantFile?: (entry: Rar4Entry) => boolean;
}

export type Rar4Sink = (name: string, data: Uint8Array, entry: Rar4Entry) => void | Promise<void>;

/** Metadata-only preflight, shared with callers planning several sources before writing. */
export function assertRar4Extractable(archive: Rar4Archive, options: Rar4Options = {}): void {
    const limit = rar29OutputLimit(options), names = new Set<string>();
    let groupSize = 0, compressed = false;
    if (archive.multiVolume) throw new Error('RAR4: multi-volume decompression is unsupported');
    for (const e of archive.entries) {
        const key = e.name.toLowerCase();
        if (names.has(key)) throw new Error(`RAR4: duplicate destination ${e.name}`);
        names.add(key);
        if (e.flags & 4) throw new Error(`RAR4: encrypted file ${e.name}`);
        if (e.flags & 3) throw new Error(`RAR4: split file ${e.name}`);
        if (e.isDirectory) continue;
        if (!Number.isSafeInteger(e.unpackedSize) || e.unpackedSize < 0) throw new Error('RAR4: invalid output size');
        if (!(e.flags & 16)) { groupSize = 0; compressed = false; }
        if (e.method === 0x30) {
            if (e.flags & 16) throw new Error('RAR4: stored members in solid groups are unsupported');
            if (e.packedSize !== e.unpackedSize) throw new Error(`RAR4: size/CRC mismatch for ${e.name}`);
            groupSize = e.unpackedSize;
        } else if (e.method >= 0x31 && e.method <= 0x35 && e.version === 29) {
            if ((e.flags & 16) && !compressed) throw new Error(`RAR4: solid file without preceding compressed member ${e.name}`);
            groupSize += e.unpackedSize;
            compressed = true;
        } else throw new Error(`RAR4: unsupported coding ${e.version}/${e.method} for ${e.name}`);
        if (!Number.isSafeInteger(groupSize) || groupSize > limit) throw new Error('RAR4: output exceeds maxOutputBytes');
    }
}

interface DecodedEntry { name: string; data: Uint8Array; entry: Rar4Entry; }

function* decodedEntries(source: RandomAccessSource, offset: number, options: Rar4Options): Generator<DecodedEntry> {
    const archive = parseRar4(source, offset);
    assertRar4Extractable(archive, options);
    let group: Rar4Entry[] = [];
    const read = (e: Rar4Entry) => {
        const bytes = source.readRangeSync(e.dataOffset, e.dataOffset + e.packedSize);
        if (bytes.length !== e.packedSize) throw new Error(`RAR4: truncated data for ${e.name}`);
        return bytes;
    };
    const checked = (e: Rar4Entry, data: Uint8Array) => {
        if (data.length !== e.unpackedSize || crc32(data) !== e.crc32) throw new Error(`RAR4: size/CRC mismatch for ${e.name}`);
        return data;
    };
    const wanted = (e: Rar4Entry) => options.wantFile?.(e) ?? true;
    function* flush(): Generator<DecodedEntry> {
        const pending = group;
        group = [];
        const members = pending.filter(e => !e.isDirectory);
        const files = members.length ? decodeRar29Solid(members.map(e => ({ input: read(e), expectedSize: e.unpackedSize })),
            options.createPpmSession, options) : [];
        // Authenticate the complete group before exposing a view backed by its shared history.
        members.forEach((e, i) => checked(e, files[i]!));
        let i = 0;
        for (const entry of pending) {
            const data = entry.isDirectory ? new Uint8Array(0) : files[i++]!;
            if (wanted(entry)) yield { name: entry.isDirectory ? `${entry.name}/` : entry.name, data, entry };
        }
    }
    for (const entry of archive.entries) {
        if (entry.isDirectory) { group.push(entry); continue; }
        if (!(entry.flags & 16)) yield* flush();
        if (entry.method === 0x30) {
            const data = checked(entry, read(entry).slice());
            if (wanted(entry)) yield { name: entry.name, data, entry };
        } else group.push(entry);
    }
    yield* flush();
}

/**
 * Publishes CRC-verified members in archive order, awaiting the consumer before continuing.
 * Buffers are retained for one solid group only unless the consumer keeps them. A later
 * group's failure can follow earlier callbacks; the caller owns rollback of its destination.
 */
export async function extractRar4ToSink(source: RandomAccessSource, offset: number, options: Rar4Options, sink: Rar4Sink): Promise<void> {
    const entries = decodedEntries(source, offset, options);
    try {
        for (;;) {
            let result: IteratorResult<DecodedEntry> | undefined = entries.next();
            if (result.done) return;
            await sink(result.value.name, result.value.data, result.value.entry);
            // Drop the last view before advancing into the next independent group's allocation.
            result = undefined;
        }
    } finally { entries.return(undefined); }
}

/** Legacy collecting API; streaming callers should use extractRar4ToSink instead. */
export function extractRar4(source: RandomAccessSource, offset = 0, options: Rar4Options = {}): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const { name, data } of decodedEntries(source, offset, options)) out.set(name, data);
    return out;
}
