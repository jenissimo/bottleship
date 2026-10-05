/**
 * EA "BIG" archives — the container every SAGE title ships its data in (Generals, BFME, C&C3,
 * Red Alert 3, Kane's Wrath).
 *
 * A flat table of (offset, size, name) and nothing else: no per-entry compression flag, no
 * directory structure, no central-directory duplicate to cross-check against. Whether an entry is
 * RefPack-compressed is decided by LOOKING at its first bytes, which is what the games do too.
 *
 * Everything in the header is BIG-endian, including the offsets — the one thing that reliably
 * goes wrong when this format is re-implemented, because the payload it points at is a
 * little-endian x86 image.
 */
import { decodeRefPack, isRefPack, refPackSize } from "./refpack";

export { decodeRefPack, isRefPack, refPackSize, RefPackError } from "./refpack";

/** Bytes the reader may need out of the file. Sync, because every caller here has the whole
 *  archive on disk or in memory; a Range-served BIG would need its own source type. */
export interface BigSource {
    readonly size: number;
    readSync(start: number, end: number): Uint8Array;
}

export interface BigEntry {
    /** As stored — backslash-separated, and the case the archive chose. */
    readonly name: string;
    readonly offset: number;
    /** Stored size. For a RefPack entry this is the COMPRESSED size. */
    readonly size: number;
}

export class BigError extends Error {}

/** A whole archive already in memory. */
export function bigSourceFromBytes(bytes: Uint8Array): BigSource {
    return { size: bytes.length, readSync: (start, end) => bytes.subarray(start, Math.min(end, bytes.length)) };
}

const be32 = (b: Uint8Array, at: number): number =>
    ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

export class BigArchive {
    private readonly source: BigSource;
    private entries: BigEntry[] = [];
    /** BIGF (older) or BIG4 (SAGE 2). The tag says nothing about the entries; both parse alike. */
    private kindTag = "";

    constructor(source: BigSource) { this.source = source; }

    init(): void {
        const head = this.source.readSync(0, 16);
        if (head.length < 16) throw new BigError("file is too short to be a BIG archive");
        const tag = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!);
        if (tag !== "BIGF" && tag !== "BIG4") throw new BigError(`not a BIG archive (magic ${JSON.stringify(tag)})`);
        this.kindTag = tag;
        const count = be32(head, 8);
        const headerSize = be32(head, 12);
        if (headerSize < 16 || headerSize > this.source.size) {
            throw new BigError(`implausible header size 0x${headerSize.toString(16)}`);
        }
        const table = this.source.readSync(16, headerSize);
        const out: BigEntry[] = [];
        let at = 0;
        for (let i = 0; i < count; i++) {
            if (at + 8 > table.length) throw new BigError(`entry table ends after ${i} of ${count} entries`);
            const offset = be32(table, at);
            const size = be32(table, at + 4);
            at += 8;
            const start = at;
            while (at < table.length && table[at] !== 0) at++;
            if (at >= table.length) throw new BigError(`entry ${i}'s name is unterminated`);
            let name = "";
            for (let j = start; j < at; j++) name += String.fromCharCode(table[j]!);
            at++;
            out.push({ name, offset, size });
        }
        this.entries = out;
    }

    get kind(): string { return this.kindTag; }
    listEntries(): readonly BigEntry[] { return this.entries; }

    find(name: string): BigEntry | undefined {
        const want = name.toLowerCase().replace(/\//g, "\\");
        return this.entries.find((e) => e.name.toLowerCase().replace(/\//g, "\\") === want);
    }

    /** The entry's STORED bytes, compression and all. */
    readRaw(entry: BigEntry): Uint8Array {
        const end = entry.offset + entry.size;
        if (end > this.source.size) throw new BigError(`entry ${entry.name} runs past the archive`);
        const bytes = this.source.readSync(entry.offset, end);
        if (bytes.length !== entry.size) throw new BigError(`short read for ${entry.name}`);
        return bytes;
    }

    /** The entry's CONTENT: RefPack is unwrapped, anything else is returned as stored. */
    read(entry: BigEntry): Uint8Array {
        const raw = this.readRaw(entry);
        return isRefPack(raw) ? decodeRefPack(raw) : raw;
    }

    /** Uncompressed size without decoding — the header's promise for a RefPack entry. */
    contentSize(entry: BigEntry): number {
        const head = this.source.readSync(entry.offset, Math.min(entry.offset + 10, this.source.size));
        return isRefPack(head) ? refPackSize(head) : entry.size;
    }
}
