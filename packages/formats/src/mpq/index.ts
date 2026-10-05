// MoPaQ (MPQ) archive reader — Blizzard's container, and the payload appended to
// every Blizzard self-extracting installer of the Warcraft/Diablo/StarCraft era.
// Read-only, v0/v1 archives (the only kind those installers ship).

import { inflateZlibSync } from "../zip/inflate";
import {
    decryptBlock,
    fileKey,
    hashString,
    recoverSectorTableKey,
    HASH_FILE_KEY,
    HASH_NAME_A,
    HASH_NAME_B,
    HASH_TABLE_OFFSET,
} from "./crypt";
import { explode } from "./explode";

export { explode } from "./explode";
export { hashString } from "./crypt";

const SIGNATURE = 0x1a51504d; // 'MPQ\x1A'
const USER_DATA_SIGNATURE = 0x1b51504d; // 'MPQ\x1B'

const FLAG_IMPLODE = 0x00000100;
const FLAG_COMPRESS = 0x00000200;
const FLAG_ENCRYPTED = 0x00010000;
const FLAG_FIX_KEY = 0x00020000;
const FLAG_PATCH_FILE = 0x00100000;
const FLAG_SINGLE_UNIT = 0x01000000;
const FLAG_SECTOR_CRC = 0x04000000;
const FLAG_EXISTS = 0x80000000;

const HASH_ENTRY_EMPTY = 0xffffffff;
const HASH_ENTRY_DELETED = 0xfffffffe;

export interface MpqHeader {
    /** Absolute offset of the header — every table/block offset is relative to it. */
    base: number;
    headerSize: number;
    archiveSize: number;
    formatVersion: number;
    sectorSize: number;
    hashTablePos: number;
    blockTablePos: number;
    hashTableCount: number;
    blockTableCount: number;
}

export interface MpqEntry {
    name: string;
    size: number;
    compressedSize: number;
    flags: number;
    blockIndex: number;
    locale: number;
}

/** Scan for the archive header: installers prepend a full PE before it. */
export function findMpqHeader(data: Uint8Array): number {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 0; offset + 32 <= data.length; offset += 512) {
        const magic = view.getUint32(offset, true);
        if (magic === SIGNATURE) return offset;
        if (magic === USER_DATA_SIGNATURE) {
            // The real header sits at headerOffset from the user-data block. The offset is
            // archive-controlled, so a bogus one must keep the scan going, not throw.
            const headerOffset = view.getUint32(offset + 8, true);
            const at = offset + headerOffset;
            if (at + 32 <= data.length && view.getUint32(at, true) === SIGNATURE) return at;
        }
    }
    return -1;
}

export class MpqArchive {
    readonly header: MpqHeader;
    private readonly view: DataView;
    private readonly hashTable: Uint32Array;
    private readonly blockTable: Uint32Array;

    constructor(private readonly data: Uint8Array, base?: number) {
        const at = base ?? findMpqHeader(data);
        if (at < 0) throw new Error("not an MPQ archive (no header found)");
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const u32 = (o: number) => this.view.getUint32(at + o, true);
        const formatVersion = this.view.getUint16(at + 12, true);
        if (formatVersion > 1) throw new Error(`MPQ format version ${formatVersion} is not supported`);
        this.header = {
            base: at,
            headerSize: u32(4),
            archiveSize: u32(8),
            formatVersion,
            sectorSize: 512 << this.view.getUint16(at + 14, true),
            hashTablePos: u32(16),
            blockTablePos: u32(20),
            hashTableCount: u32(24),
            blockTableCount: u32(28),
        };

        this.hashTable = this.readTable(this.header.hashTablePos, this.header.hashTableCount * 4, "(hash table)");
        this.blockTable = this.readTable(this.header.blockTablePos, this.header.blockTableCount * 4, "(block table)");
    }

    private readTable(relPos: number, dwords: number, keyName: string): Uint32Array {
        const start = this.header.base + relPos;
        // Both the position and the count come from the header; refuse a table that does not
        // fit rather than allocating gigabytes and failing deep inside the read loop.
        if (start < 0 || dwords < 0 || start + dwords * 4 > this.data.length) {
            throw new Error(`MPQ: ${keyName} at +${relPos} (${dwords} dwords) does not fit in the archive`);
        }
        const table = new Uint32Array(dwords);
        for (let i = 0; i < dwords; i++) table[i] = this.view.getUint32(start + i * 4, true);
        decryptBlock(table, hashString(keyName, HASH_FILE_KEY));
        return table;
    }

    /** Hash-table lookup: index by one hash, disambiguate by the other two. Returns the
     *  DWORD offset of the matching hash entry, or -1. */
    private findHashSlot(name: string): number {
        const count = this.header.hashTableCount;
        if (count <= 0) return -1;
        const nameA = hashString(name, HASH_NAME_A);
        const nameB = hashString(name, HASH_NAME_B);
        const start = hashString(name, HASH_TABLE_OFFSET) % count;
        for (let i = 0; i < count; i++) {
            const slot = ((start + i) % count) * 4;
            const blockIndex = this.hashTable[slot + 3];
            if (blockIndex === HASH_ENTRY_EMPTY) return -1;
            if (blockIndex === HASH_ENTRY_DELETED) continue;
            if (this.hashTable[slot] === nameA && this.hashTable[slot + 1] === nameB) return slot;
        }
        return -1;
    }

    private findBlockIndex(name: string): number {
        const slot = this.findHashSlot(name);
        return slot < 0 ? -1 : this.hashTable[slot + 3];
    }

    has(name: string): boolean {
        return this.findBlockIndex(name) >= 0;
    }

    /**
     * MPQ stores no names — only hashes. The listfile is the archive's own record
     * of them; without it the contents are unrecoverable by name.
     */
    listFiles(): MpqEntry[] {
        // An archive that HAS a listfile we cannot read is not the same thing as one that has
        // none: swallowing both would report a corrupt archive as a nameless installer payload.
        if (!this.has("(listfile)")) return [];
        const listing = new TextDecoder("latin1").decode(this.readFile("(listfile)"));
        const entries: MpqEntry[] = [];
        for (const raw of listing.split(/\r?\n/)) {
            const name = raw.trim();
            if (!name) continue;
            const slot = this.findHashSlot(name);
            if (slot < 0) continue;
            const blockIndex = this.hashTable[slot + 3];
            const b = blockIndex * 4;
            entries.push({
                name,
                size: this.blockTable[b + 2],
                compressedSize: this.blockTable[b + 1],
                flags: this.blockTable[b + 3],
                blockIndex,
                locale: this.hashTable[slot + 2] & 0xffff,
            });
        }
        return entries;
    }

    readFile(name: string): Uint8Array {
        const blockIndex = this.findBlockIndex(name);
        if (blockIndex < 0) throw new Error(`MPQ: no such file: ${name}`);
        return this.readBlock(blockIndex, name, true);
    }

    /**
     * Read a block by table index. An archive with no (listfile) — every Blizzard
     * installer payload — is otherwise unreadable, but only files WITHOUT
     * MPQ_FILE_ENCRYPTED can be recovered this way: the key is derived from the
     * name we don't have.
     */
    readBlockByIndex(blockIndex: number, name?: string): Uint8Array {
        if (blockIndex < 0 || blockIndex >= this.header.blockTableCount) throw new Error(`MPQ: block ${blockIndex} out of range`);
        // No name given means we are guessing one, and a guessed name hashes to the wrong
        // key — say so, so readBlock refuses the shapes where a wrong key is undetectable.
        return this.readBlock(blockIndex, name ?? `block${blockIndex}`, name !== undefined);
    }

    blockInfo(blockIndex: number): { offset: number; compressedSize: number; size: number; flags: number } {
        if (blockIndex < 0 || blockIndex >= this.header.blockTableCount) throw new Error(`MPQ: block ${blockIndex} out of range`);
        const b = blockIndex * 4;
        return {
            offset: this.blockTable[b],
            compressedSize: this.blockTable[b + 1],
            size: this.blockTable[b + 2],
            flags: this.blockTable[b + 3] >>> 0,
        };
    }

    private readBlock(blockIndex: number, name: string, nameIsReal: boolean): Uint8Array {
        // The hash table can name a block index the block table does not have.
        if (blockIndex < 0 || blockIndex >= this.header.blockTableCount) {
            throw new Error(`MPQ: ${name} points at block ${blockIndex}, outside the block table`);
        }
        const b = blockIndex * 4;
        const filePos = this.header.base + this.blockTable[b];
        const compressedSize = this.blockTable[b + 1];
        const fileSize = this.blockTable[b + 2];
        const flags = this.blockTable[b + 3];

        if (!(flags & FLAG_EXISTS)) throw new Error(`MPQ: ${name} has no data`);
        if (flags & FLAG_PATCH_FILE) throw new Error(`MPQ: ${name} is an incremental patch file`);
        const compressed = (flags & (FLAG_COMPRESS | FLAG_IMPLODE)) !== 0;
        const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
        const storedSize = compressed ? compressedSize : Math.max(compressedSize, fileSize);
        if (filePos < 0 || filePos + storedSize > this.data.length) {
            throw new Error(`MPQ: ${name} extends past the end of the archive (+${this.blockTable[b]}, ${storedSize} bytes)`);
        }
        // Only the multi-sector compressed layout can prove a key right (its sector table has
        // known plaintext). Every other encrypted shape would decrypt a guessed name's wrong
        // key into plausible bytes with nothing to check them against — refuse instead.
        if (encrypted && !nameIsReal && (!compressed || (flags & FLAG_SINGLE_UNIT) !== 0)) {
            throw new Error(`MPQ: ${name} is encrypted and its key cannot be recovered without the real file name`);
        }
        const key = encrypted ? fileKey(name, this.blockTable[b], fileSize, (flags & FLAG_FIX_KEY) !== 0) : 0;

        if (flags & FLAG_SINGLE_UNIT) {
            let raw = this.data.subarray(filePos, filePos + compressedSize);
            if (encrypted) raw = this.decryptBytes(raw, key);
            return compressed && compressedSize < fileSize ? this.decompress(raw, fileSize, flags) : raw.slice(0, fileSize);
        }

        const sectorSize = this.header.sectorSize;
        const sectorCount = Math.ceil(fileSize / sectorSize);

        if (!compressed) {
            const raw = this.data.subarray(filePos, filePos + fileSize);
            if (!encrypted) return raw.slice();
            // Uncompressed-but-encrypted files are still keyed per sector.
            const out = new Uint8Array(fileSize);
            for (let s = 0; s < sectorCount; s++) {
                const start = s * sectorSize;
                const chunk = raw.subarray(start, Math.min(start + sectorSize, fileSize));
                out.set(this.decryptBytes(chunk, (key + s) >>> 0), start);
            }
            return out;
        }

        const tableEntries = sectorCount + 1 + ((flags & FLAG_SECTOR_CRC) ? 1 : 0);
        if (tableEntries * 4 > compressedSize) {
            throw new Error(`MPQ: ${name} claims ${sectorCount} sectors, more than its ${compressedSize} stored bytes hold`);
        }
        const rawOffsets = new Uint32Array(tableEntries);
        for (let i = 0; i < tableEntries; i++) rawOffsets[i] = this.view.getUint32(filePos + i * 4, true);
        const offsets = rawOffsets.slice();
        let sectorKey = key;
        if (encrypted) {
            decryptBlock(offsets, (key - 1) >>> 0);
            if (offsets[0] !== tableEntries * 4) {
                // The name we were given is not the name the file was keyed with
                // (an archive with no listfile has none). Recover it — the table's first
                // entry IS its own byte size, and the second confirms the candidate.
                if (tableEntries < 2) throw new Error(`MPQ: cannot decrypt ${name} (no sector table to recover a key from)`);
                const tableKey = recoverSectorTableKey(rawOffsets[0], rawOffsets[1], tableEntries * 4, compressedSize);
                if (tableKey < 0) throw new Error(`MPQ: cannot decrypt ${name} (wrong key, unrecoverable)`);
                sectorKey = (tableKey + 1) >>> 0;
                offsets.set(rawOffsets);
                decryptBlock(offsets, tableKey);
            }
        }
        // Every sector bound below comes from the archive. Reject a table that is not
        // monotonic or runs past the block: unchecked, a corrupt one silently reads a
        // clamped/empty subarray and we hand back zero-filled "data".
        for (let i = 1; i < tableEntries; i++) {
            if (offsets[i] < offsets[i - 1] || offsets[i] > compressedSize) {
                throw new Error(`MPQ: ${name} has a corrupt sector table (entry ${i} = ${offsets[i]}, of ${compressedSize})`);
            }
        }

        const out = new Uint8Array(fileSize);
        for (let s = 0; s < sectorCount; s++) {
            const start = filePos + offsets[s];
            const end = filePos + offsets[s + 1];
            const outStart = s * sectorSize;
            const outSize = Math.min(sectorSize, fileSize - outStart);
            let sector = this.data.subarray(start, end);
            if (encrypted) sector = this.decryptBytes(sector, (sectorKey + s) >>> 0);
            // A sector compression did not shrink is stored raw — that is the ONLY reason
            // its stored length may reach the uncompressed size.
            out.set(sector.length >= outSize ? sector.subarray(0, outSize) : this.decompress(sector, outSize, flags), outStart);
        }
        return out;
    }

    private decryptBytes(bytes: Uint8Array, key: number): Uint8Array {
        const copy = bytes.slice();
        const dwords = new Uint32Array(copy.buffer, 0, copy.length >>> 2);
        decryptBlock(dwords, key);
        return copy;
    }

    private decompress(data: Uint8Array, outSize: number, flags: number): Uint8Array {
        // MPQ_FILE_IMPLODE is the old single-method form: no mask byte at all.
        if (flags & FLAG_IMPLODE && !(flags & FLAG_COMPRESS)) return explode(data, outSize);

        const mask = data[0];
        const body = data.subarray(1);
        switch (mask) {
            case 0x02: {
                const out = new Uint8Array(outSize);
                const result = inflateZlibSync(body, out);
                if (result.status !== "ok") throw new Error(`MPQ: zlib sector failed (${result.status}: ${result.message})`);
                // outSize is the sector's exact uncompressed length, so a short stream is
                // corruption; returning what fit would be wrong bytes with no error.
                if (result.written !== outSize) throw new Error(`MPQ: zlib sector produced ${result.written} of ${outSize} bytes`);
                return out;
            }
            case 0x08:
                return explode(body, outSize);
            default:
                throw new Error(`MPQ: unsupported compression mask 0x${mask.toString(16)}`);
        }
    }
}
