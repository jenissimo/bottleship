/** Store-only ZIP64 writer. Payloads are copied by range; only directory records stay in RAM. */
import { Crc32 } from "../unpack/checksums";
import type { ZipSource } from "../zip";

export interface ZipWriteSink {
    write(bytes: Uint8Array, at: number): void | Promise<void>;
}

export interface ZipStreamEntry {
    name: string;
    source: ZipSource;
}

const BLOCK = 256 * 1024;
const U32 = 0xffffffff;

/** ZIP64 is used consistently so size/offset crossings never require moving a payload. */
export async function writeZipStream(
    entries: Iterable<ZipStreamEntry>, sink: ZipWriteSink,
    onProgress?: (bytes: number) => void,
): Promise<number> {
    const directory: { name: Uint8Array; size: number; offset: number; crc: number }[] = [];
    let offset = 0;
    const append = async (bytes: Uint8Array) => {
        if (!Number.isSafeInteger(offset + bytes.length)) throw new Error("ZIP output exceeds supported size");
        await sink.write(bytes, offset); offset += bytes.length;
    };
    for (const entry of entries) {
        const name = new TextEncoder().encode(entry.name);
        const size = entry.source.size;
        if (name.length > 0xffff || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid ZIP entry name or size");
        const start = offset;
        const header = new Uint8Array(30 + name.length + 20);
        const v = new DataView(header.buffer);
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, 45, true);
        v.setUint16(6, 0x800, true);
        v.setUint32(18, U32, true); v.setUint32(22, U32, true);
        v.setUint16(26, name.length, true); v.setUint16(28, 20, true);
        header.set(name, 30);
        const extra = 30 + name.length;
        v.setUint16(extra, 1, true); v.setUint16(extra + 2, 16, true);
        v.setBigUint64(extra + 4, BigInt(size), true); v.setBigUint64(extra + 12, BigInt(size), true);
        await append(header);
        const hash = new Crc32();
        for (let at = 0; at < size; at += BLOCK) {
            const end = Math.min(size, at + BLOCK);
            const bytes = await entry.source.readRange(at, end);
            if (bytes.length !== end - at) throw new Error(`Truncated ZIP input: ${entry.name}`);
            hash.update(bytes);
            await append(bytes);
            onProgress?.(offset);
        }
        const crc = hash.finalize();
        const crcBytes = new Uint8Array(4);
        new DataView(crcBytes.buffer).setUint32(0, crc, true);
        await sink.write(crcBytes, start + 14);
        directory.push({ name, size, offset: start, crc });
    }
    const cdStart = offset;
    for (const entry of directory) {
        const header = new Uint8Array(46 + entry.name.length + 28);
        const v = new DataView(header.buffer);
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 45, true); v.setUint16(6, 45, true); v.setUint16(8, 0x800, true);
        v.setUint32(16, entry.crc, true);
        v.setUint32(20, U32, true); v.setUint32(24, U32, true); v.setUint32(42, U32, true);
        v.setUint16(28, entry.name.length, true); v.setUint16(30, 28, true);
        header.set(entry.name, 46);
        const extra = 46 + entry.name.length;
        v.setUint16(extra, 1, true); v.setUint16(extra + 2, 24, true);
        v.setBigUint64(extra + 4, BigInt(entry.size), true);
        v.setBigUint64(extra + 12, BigInt(entry.size), true);
        v.setBigUint64(extra + 20, BigInt(entry.offset), true);
        await append(header);
    }
    const cdSize = offset - cdStart;
    const endStart = offset;
    const end64 = new Uint8Array(56);
    const v = new DataView(end64.buffer);
    v.setUint32(0, 0x06064b50, true); v.setBigUint64(4, 44n, true);
    v.setUint16(12, 45, true); v.setUint16(14, 45, true);
    v.setBigUint64(24, BigInt(directory.length), true); v.setBigUint64(32, BigInt(directory.length), true);
    v.setBigUint64(40, BigInt(cdSize), true); v.setBigUint64(48, BigInt(cdStart), true);
    await append(end64);
    const locator = new Uint8Array(20);
    const l = new DataView(locator.buffer);
    l.setUint32(0, 0x07064b50, true); l.setBigUint64(8, BigInt(endStart), true); l.setUint32(16, 1, true);
    await append(locator);
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, 0xffff, true); e.setUint16(10, 0xffff, true);
    e.setUint32(12, U32, true); e.setUint32(16, U32, true);
    await append(end);
    return offset;
}
