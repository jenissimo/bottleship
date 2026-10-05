/**
 * RAR 5 archive reader — layout only.
 *
 * Scope is deliberately narrow: RAR5 headers plus STORED (method 0) file data, which is
 * what the game-distribution `.rar` we actually meet contains (a store-only wrapper around
 * an installer, so the bytes are already there and only need to be sliced out). The RAR
 * compression methods are a separate LZSS/PPMd stack; this reader REFUSES them by name
 * rather than returning wrong bytes, and the same goes for RAR 1.5-4.x and for encryption
 * in either form — whole-archive (a CRYPT header) or per-file (`rar -p`, an extra-area
 * record behind otherwise readable headers). Multi-volume sets are enumerated per volume;
 * a file split across volumes is reported as such so a caller can concatenate its parts.
 *
 * Format reference: the RAR 5.0 archive format spec (rarlab), block layout
 *   CRC32 | HeadSize(vint) | HeadType(vint) | HeadFlags(vint) | [ExtraSize] | [DataSize] | body
 */

import type { RandomAccessSource } from "../unpack/source";

export const RAR5_SIGNATURE = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const RAR4_SIGNATURE = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

export class RarError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RarError";
    }
}

/** Header types (RAR5 §head type). */
const HEAD_MAIN = 1;
const HEAD_FILE = 2;
const HEAD_SERVICE = 3;
const HEAD_CRYPT = 4;
const HEAD_ENDARC = 5;

/** Generic header flags. */
const HFLAG_EXTRA = 0x0001;
const HFLAG_DATA = 0x0002;
const HFLAG_SPLIT_BEFORE = 0x0008;
const HFLAG_SPLIT_AFTER = 0x0010;

/** File header flags. */
const FFLAG_DIRECTORY = 0x0001;
const FFLAG_MTIME = 0x0002;
const FFLAG_CRC32 = 0x0004;
const FFLAG_UNKNOWN_SIZE = 0x0008;

/** Main archive header flags. */
const AFLAG_VOLUME = 0x0001;
const AFLAG_VOLNUM = 0x0002;
const AFLAG_SOLID = 0x0004;

/** Extra-area record types (file/service headers). */
const EXTRA_CRYPT = 0x01;
const EXTRA_REDIR = 0x05;

export interface RarEntry {
    /** Path with `/` separators, as stored. */
    name: string;
    isDirectory: boolean;
    /** Decompressed size as the header states it. Meaningless when `unknownSize` is set
     *  (RAR keeps the field but the writer did not know the size). */
    unpackedSize: number;
    /** Bytes of data present in THIS volume (the stored slice for method 0). */
    packedSize: number;
    /** Absolute offset of the data area in the source. */
    dataOffset: number;
    /** 0 = stored; 1-5 = the RAR LZSS/PPMd methods, which this reader cannot decode. */
    method: number;
    /** Part of a solid group — its data depends on preceding files' history. */
    solid: boolean;
    /** Continues from the previous volume / continues into the next one. */
    splitBefore: boolean;
    splitAfter: boolean;
    unknownSize: boolean;
    /** CRC32 of the unpacked file, when the header carries one. */
    crc32: number | null;
    /** DOS/Windows file attributes. */
    attributes: number;
    /** Per-file encryption (an extra-area CRYPT record). The data is AES; the layout this
     *  reader sees is honest but the bytes are not the file. */
    encrypted: boolean;
    /** A link/redirect (symlink, junction, hard link) whose "data" is its target string. */
    redirect: boolean;
    /** The extra area could not be walked, so `encrypted`/`redirect` are unknown, not false. */
    extraUnreadable: boolean;
    /** Unix mtime seconds, when the header carries one. */
    mtime: number | null;
    /** A service header (CMT/QO/ACL/STM…) rather than a real file. */
    service: boolean;
}

export interface RarArchive {
    entries: RarEntry[];
    /** Part of a multi-volume set. */
    multiVolume: boolean;
    /** Volume number from the main header (0-based), when present. */
    volumeNumber: number | null;
    /** The archive as a whole uses solid compression. */
    solid: boolean;
    /** True when an end-of-archive header said more volumes follow. */
    moreVolumes: boolean;
}

function matches(buf: Uint8Array, sig: Uint8Array): boolean {
    if (buf.length < sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
    return true;
}

/** Cheap probe for callers dispatching on container type. */
export function isRar(head: Uint8Array): boolean {
    return matches(head, RAR5_SIGNATURE) || matches(head, RAR4_SIGNATURE);
}

/**
 * Windowed reader over a RandomAccessSource. Headers are small and clustered, so one
 * sliding window keeps a multi-GB archive off the heap while still letting the vint
 * decoder walk byte by byte.
 */
class Cursor {
    private buf: Uint8Array = new Uint8Array(0);
    private bufPos = 0;

    constructor(private readonly src: RandomAccessSource, public pos: number) {}

    private window(offset: number, length: number): Uint8Array {
        if (offset >= this.bufPos && offset + length <= this.bufPos + this.buf.length) {
            const start = offset - this.bufPos;
            return this.buf.subarray(start, start + length);
        }
        const span = Math.max(length, 1 << 16);
        this.buf = this.src.readRangeSync(offset, Math.min(offset + span, this.src.size));
        this.bufPos = offset;
        if (this.buf.length < length) throw new RarError(`truncated archive at offset ${offset}`);
        return this.buf.subarray(0, length);
    }

    bytes(length: number): Uint8Array {
        // Copy: the window is reused, so a caller holding the subarray would see it change.
        const out = this.window(this.pos, length).slice();
        this.pos += length;
        return out;
    }

    byte(): number {
        const b = this.window(this.pos, 1)[0]!;
        this.pos += 1;
        return b;
    }

    u32(): number {
        const b = this.window(this.pos, 4);
        this.pos += 4;
        return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
    }

    /** RAR5 variable-length integer: 7 bits per byte, high bit = continue. */
    vint(): number {
        let value = 0;
        let shift = 1;
        for (let i = 0; i < 10; i++) {
            const b = this.byte();
            value += (b & 0x7f) * shift;
            if ((b & 0x80) === 0) {
                if (!Number.isSafeInteger(value)) throw new RarError("vint exceeds safe integer range");
                return value;
            }
            shift *= 128;
        }
        throw new RarError("malformed vint (no terminator in 10 bytes)");
    }
}

interface ExtraFlags { encrypted: boolean; redirect: boolean; unreadable: boolean }
const EXTRA_NONE: ExtraFlags = { encrypted: false, redirect: false, unreadable: false };

/**
 * Walk the extra area's `[size][type][payload]` records for the ones that change what the
 * DATA is. A walk that cannot finish reports `unreadable` rather than a clean
 * `encrypted: false` — "I could not check" and "it is not encrypted" must not look alike,
 * because only the first is a reason to refuse the bytes.
 */
function readExtraRecords(cur: Cursor, start: number, end: number): ExtraFlags {
    const saved = cur.pos;
    const out: ExtraFlags = { encrypted: false, redirect: false, unreadable: false };
    try {
        cur.pos = start;
        while (cur.pos < end) {
            const recStart = cur.pos;
            const size = cur.vint();
            const recEnd = cur.pos + size;
            if (size <= 0 || recEnd > end || recEnd <= recStart) { out.unreadable = true; break; }
            const type = cur.vint();
            if (type === EXTRA_CRYPT) out.encrypted = true;
            else if (type === EXTRA_REDIR) out.redirect = true;
            cur.pos = recEnd;
        }
    } catch {
        out.unreadable = true;
    }
    cur.pos = saved;
    return out;
}

/**
 * Parse one RAR5 volume's headers. `startOffset` lets a caller skip an SFX stub; omit it
 * and the signature must be at byte 0.
 */
export function parseRar(src: RandomAccessSource, startOffset = 0): RarArchive {
    const head = src.readRangeSync(startOffset, startOffset + 8);
    if (matches(head, RAR4_SIGNATURE)) {
        throw new RarError("RAR 1.5-4.x archive: only the RAR5 format is supported");
    }
    if (!matches(head, RAR5_SIGNATURE)) throw new RarError("not a RAR archive (bad signature)");

    const cur = new Cursor(src, startOffset + RAR5_SIGNATURE.length);
    const entries: RarEntry[] = [];
    let multiVolume = false;
    let volumeNumber: number | null = null;
    let archiveSolid = false;
    let moreVolumes = false;

    while (cur.pos < src.size) {
        cur.u32(); // header CRC32 — the payload is what we verify, not the header
        const headerBodyStart = cur.pos;
        const headSize = cur.vint();
        const bodyStart = cur.pos;
        const headerEnd = bodyStart + headSize;
        if (headSize === 0 || headerEnd > src.size) throw new RarError(`bad header size at ${headerBodyStart}`);

        const type = cur.vint();
        const flags = cur.vint();
        const extraSize = flags & HFLAG_EXTRA ? cur.vint() : 0;
        const dataSize = flags & HFLAG_DATA ? cur.vint() : 0;

        if (type === HEAD_CRYPT) {
            throw new RarError("encrypted RAR archive (headers are encrypted): not supported");
        }
        if (type === HEAD_MAIN) {
            const archiveFlags = cur.vint();
            multiVolume = (archiveFlags & AFLAG_VOLUME) !== 0;
            archiveSolid = (archiveFlags & AFLAG_SOLID) !== 0;
            if (archiveFlags & AFLAG_VOLNUM) volumeNumber = cur.vint();
        } else if (type === HEAD_FILE || type === HEAD_SERVICE) {
            const fileFlags = cur.vint();
            const unpackedSize = cur.vint();
            const attributes = cur.vint();
            const mtime = fileFlags & FFLAG_MTIME ? cur.u32() : null;
            const crc32 = fileFlags & FFLAG_CRC32 ? cur.u32() : null;
            const compInfo = cur.vint();
            cur.vint(); // host OS
            const nameLength = cur.vint();
            const name = new TextDecoder().decode(cur.bytes(nameLength));
            // The extra area is where per-file ENCRYPTION lives (`rar -p`, which leaves the
            // headers readable), so skipping it wholesale would let an AES-encrypted stored
            // entry look like plain bytes and be "extracted" as ciphertext.
            const extra = extraSize > 0 ? readExtraRecords(cur, headerEnd - extraSize, headerEnd) : EXTRA_NONE;

            entries.push({
                name,
                isDirectory: (fileFlags & FFLAG_DIRECTORY) !== 0,
                unpackedSize,
                packedSize: dataSize,
                dataOffset: headerEnd,
                method: (compInfo >> 7) & 0x07,
                solid: ((compInfo >> 6) & 1) === 1,
                splitBefore: (flags & HFLAG_SPLIT_BEFORE) !== 0,
                splitAfter: (flags & HFLAG_SPLIT_AFTER) !== 0,
                unknownSize: (fileFlags & FFLAG_UNKNOWN_SIZE) !== 0,
                crc32,
                attributes,
                encrypted: extra.encrypted,
                redirect: extra.redirect,
                extraUnreadable: extra.unreadable,
                mtime,
                service: type === HEAD_SERVICE,
            });
        } else if (type === HEAD_ENDARC) {
            const endFlags = cur.vint();
            moreVolumes = (endFlags & 0x0001) !== 0;
            break;
        }

        cur.pos = headerEnd + dataSize;
    }

    return { entries, multiVolume, volumeNumber, solid: archiveSolid, moreVolumes };
}

/**
 * Reject what the layout reader can enumerate but not reproduce, so a caller never writes
 * bytes it could not actually decode.
 */
export function assertExtractable(entry: RarEntry): void {
    if (entry.method !== 0) {
        throw new RarError(
            `"${entry.name}": RAR compression method ${entry.method} is not implemented (stored only)`,
        );
    }
    if (entry.solid) throw new RarError(`"${entry.name}": solid archives are not supported`);
    if (entry.unknownSize) throw new RarError(`"${entry.name}": unknown unpacked size is not supported`);
    if (entry.encrypted) throw new RarError(`"${entry.name}": encrypted entry (password-protected): not supported`);
    if (entry.redirect) throw new RarError(`"${entry.name}": link/redirect entries are not supported`);
    if (entry.extraUnreadable) {
        throw new RarError(`"${entry.name}": unreadable extra area — cannot rule out encryption`);
    }
}

/** Volume filenames for a multi-volume set: `name.part1.rar` → `name.part2.rar`, … */
export function volumeName(firstVolume: string, index: number): string | null {
    const m = /^(.*\.part)(\d+)(\.rar)$/i.exec(firstVolume);
    if (!m) return null;
    const digits = m[2]!;
    const next = String(Number(digits) + index);
    return m[1]! + next.padStart(digits.length, "0") + m[3]!;
}
