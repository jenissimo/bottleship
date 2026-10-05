/**
 * xz container (`.xz`, and the `.tar.xz` a Linux game drop arrives as).
 *
 * The compression itself is LZMA2, which the shared native backend already decodes
 * (`unpack/`, kind UNPACK_LZMA2) — this module is only the container: stream header,
 * the block list recovered from the trailing index, per-block filter flags, and the
 * integrity checks. Blocks are independent, so a multi-block stream (what `xz -T`
 * writes) is decoded one block at a time and never needs the whole file resident.
 *
 * Refs: xz file-format spec 1.2.0 (`doc/xz-file-format.txt`).
 */

import type { RandomAccessSource } from "../unpack/source";
import { Crc32 } from "../unpack/checksums";
import { UNPACK_LZMA2, type UnpackDecoder } from "../unpack/unpack";
import { Crc64 } from "./crc64";

export class XzError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "XzError";
    }
}

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const FOOTER_MAGIC = [0x59, 0x5a]; // "YZ"
const FILTER_LZMA2 = 0x21;

/** Check sizes by check-type id (spec §2.1.1.2); an id absent here is unsupported. */
const CHECK_SIZE: Record<number, number> = { 0x00: 0, 0x01: 4, 0x04: 8, 0x0a: 32 };

export interface XzBlock {
    /** Absolute offset of the block header. */
    readonly offset: number;
    /** Absolute offset of the compressed data. */
    readonly dataOffset: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    /** LZMA2 dictionary size, from the filter props byte. */
    readonly dictSize: number;
}

export interface XzStream {
    readonly checkType: number;
    readonly checkSize: number;
    readonly blocks: readonly XzBlock[];
    readonly uncompressedSize: number;
}

export function detectXz(head: Uint8Array): boolean {
    return MAGIC.every((b, i) => head[i] === b);
}

function u32le(b: Uint8Array, off: number): number {
    return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

/** Multibyte integer (spec §1.2): 7 bits per byte, little-endian, high bit = continue. */
function readVarint(b: Uint8Array, pos: number): { value: number; next: number } {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 9; i++) {
        const byte = b[pos + i];
        if (byte === undefined) throw new XzError("truncated multibyte integer");
        // Multiply rather than shift — a size past 2^31 is ordinary in a multi-GB stream.
        value += (byte & 0x7f) * Math.pow(2, shift);
        if (!(byte & 0x80)) return { value, next: pos + i + 1 };
        shift += 7;
    }
    throw new XzError("multibyte integer too long");
}

/** LZMA2 dictionary size from the one-byte filter property (spec §5.3.1). */
function dictSizeFromProps(prop: number): number {
    if (prop > 40) throw new XzError(`invalid LZMA2 dictionary property 0x${prop.toString(16)}`);
    if (prop === 40) return 0xffffffff;
    return (2 | (prop & 1)) * Math.pow(2, (prop >> 1) + 11);
}

function crc32Of(bytes: Uint8Array): number {
    const c = new Crc32();
    c.update(bytes);
    return c.finalize();
}

/**
 * Parse the stream header, the trailing index and every block header.
 *
 * The index is authoritative for where blocks are: a block header need not carry its own
 * sizes, and trusting a header that does while the index disagrees is how a truncated
 * stream extracts "successfully".
 */
export function parseXz(src: RandomAccessSource): XzStream {
    const header = src.readRangeSync(0, 12);
    if (header.length < 12 || !detectXz(header)) throw new XzError("not an xz stream (bad magic)");
    if (crc32Of(header.subarray(6, 8)) !== u32le(header, 8)) throw new XzError("stream header CRC32 mismatch");
    const checkType = header[7]! & 0x0f;
    const checkSize = CHECK_SIZE[checkType];
    if (checkSize === undefined) throw new XzError(`unsupported check type 0x${checkType.toString(16)}`);

    const footer = src.readRangeSync(src.size - 12, src.size);
    if (footer[10] !== FOOTER_MAGIC[0] || footer[11] !== FOOTER_MAGIC[1]) {
        throw new XzError("not an xz stream (bad footer magic; concatenated or truncated?)");
    }
    if (crc32Of(footer.subarray(4, 10)) !== u32le(footer, 0)) throw new XzError("stream footer CRC32 mismatch");
    const indexSize = (u32le(footer, 4) + 1) * 4;

    const indexStart = src.size - 12 - indexSize;
    if (indexStart < 12) throw new XzError("index does not fit the stream");
    const index = src.readRangeSync(indexStart, indexStart + indexSize);
    if (index[0] !== 0x00) throw new XzError("index indicator missing");
    if (crc32Of(index.subarray(0, indexSize - 4)) !== u32le(index, indexSize - 4)) {
        throw new XzError("index CRC32 mismatch");
    }

    let p = 1;
    const count = readVarint(index, p);
    p = count.next;
    const blocks: XzBlock[] = [];
    let offset = 12;
    let uncompressedTotal = 0;
    for (let i = 0; i < count.value; i++) {
        const unpadded = readVarint(index, p);
        p = unpadded.next;
        const uncompressed = readVarint(index, unpadded.next);
        p = uncompressed.next;
        blocks.push(readBlockHeader(src, offset, unpadded.value, uncompressed.value, checkSize));
        uncompressedTotal += uncompressed.value;
        offset += (unpadded.value + 3) & ~3; // blocks are padded to a 4-byte boundary
    }
    if (offset !== indexStart) throw new XzError("block sizes do not add up to the index offset");

    return { checkType, checkSize, blocks, uncompressedSize: uncompressedTotal };
}

function readBlockHeader(
    src: RandomAccessSource,
    offset: number,
    unpaddedSize: number,
    uncompressedSize: number,
    checkSize: number,
): XzBlock {
    const first = src.readRangeSync(offset, offset + 1);
    if (first.length < 1 || first[0] === 0x00) throw new XzError(`block header missing at ${offset}`);
    const headerSize = (first[0]! + 1) * 4;
    const hdr = src.readRangeSync(offset, offset + headerSize);
    if (hdr.length < headerSize) throw new XzError(`truncated block header at ${offset}`);
    if (crc32Of(hdr.subarray(0, headerSize - 4)) !== u32le(hdr, headerSize - 4)) {
        throw new XzError(`block header CRC32 mismatch at ${offset}`);
    }

    const flags = hdr[1]!;
    const filterCount = (flags & 0x03) + 1;
    if (filterCount !== 1) {
        throw new XzError(`${filterCount} filters in one block — only a bare LZMA2 filter is supported`);
    }
    let p = 2;
    if (flags & 0x40) p = readVarint(hdr, p).next; // compressed size (the index already told us)
    if (flags & 0x80) p = readVarint(hdr, p).next; // uncompressed size

    const filterId = readVarint(hdr, p);
    if (filterId.value !== FILTER_LZMA2) {
        // BCJ/delta filters would need their own decoders; refuse by name rather than
        // hand back plausible-looking garbage.
        throw new XzError(`unsupported xz filter 0x${filterId.value.toString(16)} (only LZMA2 is implemented)`);
    }
    const propsLen = readVarint(hdr, filterId.next);
    if (propsLen.value !== 1) throw new XzError("LZMA2 filter properties must be one byte");
    const dictSize = dictSizeFromProps(hdr[propsLen.next]!);

    const dataOffset = offset + headerSize;
    const compressedSize = unpaddedSize - headerSize - checkSize;
    if (compressedSize <= 0) throw new XzError(`block at ${offset} has no data`);
    return { offset, dataOffset, compressedSize, uncompressedSize, dictSize };
}

/**
 * Decode the whole stream, handing decompressed bytes to `onWrite` in order.
 *
 * Every block's integrity check is verified (CRC32/CRC64) unless `verify` is false, and a
 * block whose output length disagrees with the index is a hard error — a decoder that
 * stops early otherwise looks exactly like a short file.
 */
export function decodeXz(
    src: RandomAccessSource,
    decoder: UnpackDecoder,
    stream: XzStream,
    onWrite: (bytes: Uint8Array) => void,
    opts: { verify?: boolean; onBlock?: (index: number, block: XzBlock) => void } = {},
): void {
    const verify = opts.verify !== false;
    const props = new Uint8Array(4);
    for (let i = 0; i < stream.blocks.length; i++) {
        const block = stream.blocks[i]!;
        opts.onBlock?.(i, block);
        new DataView(props.buffer).setUint32(0, block.dictSize, true);
        const compressed = src.readRangeSync(block.dataOffset, block.dataOffset + block.compressedSize);
        if (compressed.length !== block.compressedSize) throw new XzError(`truncated block ${i}`);

        let produced = 0;
        const crc32 = verify && stream.checkSize === 4 ? new Crc32() : null;
        const crc64 = verify && stream.checkSize === 8 ? new Crc64() : null;
        decoder.decodeToCallback(
            UNPACK_LZMA2,
            compressed,
            (bytes) => {
                produced += bytes.length;
                crc32?.update(bytes);
                crc64?.update(bytes);
                onWrite(bytes);
                return true;
            },
            props,
        );
        if (produced !== block.uncompressedSize) {
            throw new XzError(`block ${i}: decoded ${produced} bytes, index says ${block.uncompressedSize}`);
        }
        if (verify && stream.checkSize > 0) {
            // Block Padding sits between the compressed data and the check (spec §3.3):
            // Unpadded Size counts header+data+check, so the pad is invisible in the index.
            const end = block.dataOffset + block.compressedSize;
            const checkAt = end + ((-(end - block.offset) % 4) + 4) % 4;
            const stored = src.readRangeSync(checkAt, checkAt + stream.checkSize);
            const actual = crc32 ? le32(crc32.finalize()) : crc64 ? crc64.digestBytes() : null;
            if (actual && !bytesEqual(actual, stored)) throw new XzError(`block ${i}: integrity check mismatch`);
        }
    }
}

function le32(v: number): Uint8Array {
    return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export { Crc64 } from "./crc64";
