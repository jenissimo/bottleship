/**
 * Streaming Store-only ZIP writer (ZIP64 when sizes/offsets exceed 32 bits).
 *
 * A `.wgb` is this format, and bundles run to gigabytes: nothing here ever holds a whole
 * archive — or a whole member — in memory. Shared by wgb.ts (rebuild/replace) and
 * make-wgb.ts (pack a directory), because two writers of one container drift into two
 * different ideas of when ZIP64 kicks in.
 */

import { openSync, closeSync, writeSync, readSync, fstatSync } from "node:fs";

export const LFH_SIG = 0x04034b50;
export const CDH_SIG = 0x02014b50;
export const EOCD_SIG = 0x06054b50;
export const EOCD64_SIG = 0x06064b50;
export const EOCD64_LOC_SIG = 0x07064b50;
export const U32_MAX = 0xffffffff;
export const U16_MAX = 0xffff;
/** 16 MB streamed copy — bounded RAM regardless of member size. */
export const COPY_CHUNK = 16 * 1024 * 1024;

export interface OutEntry { nameBuf: Buffer; size: number; crc: number; offset: number }

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
    }
    return t;
})();

/** Running CRC32; pass the previous value to continue across chunks, then crc32Final(). */
export function crc32Update(data: Uint8Array, crc = 0xffffffff): number {
    let c = crc;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return c >>> 0;
}

export function crc32Final(crc: number): number {
    return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(data: Uint8Array): number {
    return crc32Final(crc32Update(data));
}

export function lfhFor(nameBuf: Buffer, size: number, crc: number): Buffer {
    const needsZip64 = size > U32_MAX;
    const extra = needsZip64 ? 20 : 0; // ZIP64 extra: header(4) + uncompressed(8) + compressed(8)
    const lfh = Buffer.alloc(30 + nameBuf.length + extra);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(needsZip64 ? 45 : 20, 4); // version needed (4.5 for ZIP64)
    lfh.writeUInt16LE(0, 8);                    // Store
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(needsZip64 ? U32_MAX : size, 18); // compressed
    lfh.writeUInt32LE(needsZip64 ? U32_MAX : size, 22); // uncompressed
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(extra, 28);
    nameBuf.copy(lfh, 30);
    if (needsZip64) {
        const e = 30 + nameBuf.length;
        lfh.writeUInt16LE(0x0001, e);
        lfh.writeUInt16LE(16, e + 2);
        lfh.writeBigUInt64LE(BigInt(size), e + 4);
        lfh.writeBigUInt64LE(BigInt(size), e + 12);
    }
    return lfh;
}

export function cdhFor(e: OutEntry): Buffer {
    const bigSize = e.size > U32_MAX;
    const bigOff = e.offset > U32_MAX;
    const zFields = (bigSize ? 16 : 0) + (bigOff ? 8 : 0);
    const extra = zFields ? 4 + zFields : 0;
    const cdh = Buffer.alloc(46 + e.nameBuf.length + extra);
    cdh.writeUInt32LE(CDH_SIG, 0);
    cdh.writeUInt16LE(bigSize || bigOff ? 45 : 20, 4); // version made by
    cdh.writeUInt16LE(bigSize || bigOff ? 45 : 20, 6); // version needed
    cdh.writeUInt16LE(0, 10); // Store
    cdh.writeUInt32LE(e.crc, 16);
    cdh.writeUInt32LE(bigSize ? U32_MAX : e.size, 20); // compressed
    cdh.writeUInt32LE(bigSize ? U32_MAX : e.size, 24); // uncompressed
    cdh.writeUInt16LE(e.nameBuf.length, 28);
    cdh.writeUInt16LE(extra, 30);
    cdh.writeUInt32LE(bigOff ? U32_MAX : e.offset, 42);
    e.nameBuf.copy(cdh, 46);
    if (extra) {
        let p = 46 + e.nameBuf.length;
        cdh.writeUInt16LE(0x0001, p);
        cdh.writeUInt16LE(zFields, p + 2);
        p += 4;
        if (bigSize) { cdh.writeBigUInt64LE(BigInt(e.size), p); cdh.writeBigUInt64LE(BigInt(e.size), p + 8); p += 16; }
        if (bigOff) { cdh.writeBigUInt64LE(BigInt(e.offset), p); p += 8; }
    }
    return cdh;
}

/** Writes members one at a time to an fd and closes with the central directory. */
export class ZipStoreWriter {
    private readonly fd: number;
    private readonly cd: OutEntry[] = [];
    private offset = 0;

    constructor(outPath: string) {
        this.fd = openSync(outPath, "w");
    }

    private raw(b: Buffer): void {
        writeSync(this.fd, b, 0, b.length);
        this.offset += b.length;
    }

    /** Add a member whose bytes are already in memory (manifest/registry-sized things). */
    addBuffer(name: string, data: Buffer): void {
        const nameBuf = Buffer.from(name, "utf8");
        const entryOffset = this.offset;
        const crc = crc32(data);
        this.raw(lfhFor(nameBuf, data.length, crc));
        this.raw(data);
        this.cd.push({ nameBuf, size: data.length, crc, offset: entryOffset });
    }

    /**
     * Add a member streamed from a file. The header declares the size we measured, so a short
     * read is fatal: writing fewer bytes than the LFH announces desynchronizes every reader
     * that trusts it, and the archive would still look well-formed.
     */
    addFile(name: string, path: string): void {
        const nameBuf = Buffer.from(name, "utf8");
        const src = openSync(path, "r");
        try {
            const size = Number(fstatSync(src, { bigint: true }).size);
            const entryOffset = this.offset;
            // The LFH carries the CRC, so hash first, then write. Two passes over the file is
            // the price of a Store entry without a data descriptor.
            const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(size, 1)));
            let crc = 0xffffffff;
            for (let pos = 0; pos < size;) {
                const n = readSync(src, buf, 0, Math.min(buf.length, size - pos), pos);
                if (n <= 0) throw new Error(`${path}: short read at ${pos}/${size} while hashing`);
                crc = crc32Update(buf.subarray(0, n), crc);
                pos += n;
            }
            this.raw(lfhFor(nameBuf, size, crc32Final(crc)));
            for (let pos = 0; pos < size;) {
                const n = readSync(src, buf, 0, Math.min(buf.length, size - pos), pos);
                if (n <= 0) throw new Error(`${path}: short read at ${pos}/${size} while packing`);
                writeSync(this.fd, buf, 0, n);
                this.offset += n;
                pos += n;
            }
            this.cd.push({ nameBuf, size, crc: crc32Final(crc), offset: entryOffset });
        } finally {
            closeSync(src);
        }
    }

    /** Write the central directory (+ ZIP64 records when needed) and close. */
    finish(): { bytes: number; entries: number } {
        try {
            const cdOffset = this.offset;
            for (const e of this.cd) this.raw(cdhFor(e));
            const cdSize = this.offset - cdOffset;

            if (cdOffset > U32_MAX || cdSize > U32_MAX || this.cd.length > U16_MAX) {
                const z = Buffer.alloc(56);
                z.writeUInt32LE(EOCD64_SIG, 0);
                z.writeBigUInt64LE(BigInt(44), 4); // size of remaining ZIP64 EOCD record
                z.writeUInt16LE(45, 12);
                z.writeUInt16LE(45, 14);
                z.writeBigUInt64LE(BigInt(this.cd.length), 24);
                z.writeBigUInt64LE(BigInt(this.cd.length), 32);
                z.writeBigUInt64LE(BigInt(cdSize), 40);
                z.writeBigUInt64LE(BigInt(cdOffset), 48);
                const eocd64Off = this.offset;
                this.raw(z);
                const loc = Buffer.alloc(20);
                loc.writeUInt32LE(EOCD64_LOC_SIG, 0);
                loc.writeBigUInt64LE(BigInt(eocd64Off), 8);
                loc.writeUInt32LE(1, 16);
                this.raw(loc);
            }

            const eocd = Buffer.alloc(22);
            eocd.writeUInt32LE(EOCD_SIG, 0);
            eocd.writeUInt16LE(this.cd.length > U16_MAX ? U16_MAX : this.cd.length, 8);
            eocd.writeUInt16LE(this.cd.length > U16_MAX ? U16_MAX : this.cd.length, 10);
            eocd.writeUInt32LE(cdSize > U32_MAX ? U32_MAX : cdSize, 12);
            eocd.writeUInt32LE(cdOffset > U32_MAX ? U32_MAX : cdOffset, 16);
            this.raw(eocd);

            return { bytes: this.offset, entries: this.cd.length };
        } finally {
            closeSync(this.fd);
        }
    }
}
