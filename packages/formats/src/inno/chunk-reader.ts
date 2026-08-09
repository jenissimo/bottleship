/**
 * Slice + chunk framing — ported from innoextract stream/slice.cpp + stream/chunk.cpp + stream/lzma.cpp.
 */

import { CompressionMethod } from "./header";
import type { DataEntry } from "./entries/data";
import { InnoFormatError } from "./errors";
import { readU32At } from "./binary-reader";
import {
    UNPACK_LZMA1,
    UNPACK_LZMA2,
    UNPACK_STORE,
    type UnpackDecoder,
} from "../unpack";
import { BufferSource, type RandomAccessSource } from "../unpack/source";

/** chunk.cpp:51 */
export const CHUNK_MAGIC = new Uint8Array([0x7a, 0x6c, 0x62, 0x1a]); // 'zlb\x1a'

/**
 * Reads `length` bytes of chunk-stream data starting at (slice, offset). Embedded setups
 * have a single slice (the exe tail); multi-part setups span external `.bin` files, so a
 * single chunk's bytes can cross slice boundaries — the reader stitches them transparently
 * (slice.cpp `slice_reader::read`).
 */
export interface SliceSource {
    readSpan(firstSlice: number, offset: number, length: number): Uint8Array;
}

/** slice.cpp:53-66 — embedded slice: data at dataOffset, size = file_size - dataOffset */
export class EmbeddedSliceReader implements SliceSource {
    readonly sliceSize: number;

    constructor(
        private readonly source: RandomAccessSource,
        readonly dataOffset: number,
    ) {
        if (dataOffset >= source.size) {
            throw new InnoFormatError("invalid embedded data offset", dataOffset);
        }
        this.sliceSize = source.size - dataOffset;
    }

    readAt(offset: number, length: number): Uint8Array {
        if (offset < 0 || offset > this.sliceSize) {
            throw new InnoFormatError(`slice read out of bounds @ ${offset}`, this.dataOffset + offset);
        }
        const end = Math.min(offset + length, this.sliceSize);
        return this.source.readRangeSync(this.dataOffset + offset, this.dataOffset + end);
    }

    readSpan(firstSlice: number, offset: number, length: number): Uint8Array {
        if (firstSlice !== 0) {
            throw new InnoFormatError(
                `external slice ${firstSlice} referenced but installer is embedded (single-file)`,
                offset,
            );
        }
        return this.readAt(offset, length);
    }
}

/** slice.cpp:46-49 — external slice magics; both carry a u32 size after an 8-byte id. */
const SLICE_IDS: ReadonlyArray<ReadonlyArray<number>> = [
    [0x69, 0x64, 0x73, 0x6b, 0x61, 0x31, 0x36, 0x1a], // "idska16\x1a"
    [0x69, 0x64, 0x73, 0x6b, 0x61, 0x33, 0x32, 0x1a], // "idska32\x1a"
];
/** 8-byte magic + u32 slice size (slice.cpp open_file). */
export const SLICE_HEADER_SIZE = 12;

export interface SliceData {
    /** The `.bin` file's bytes — random-access so a slice never has to be resident. */
    source: RandomAccessSource;
    /** Declared slice size from the header — valid data region is [SLICE_HEADER_SIZE, sliceSize). */
    sliceSize: number;
}

/** slice.cpp open_file — validate an external `.bin` slice header and its declared size. */
export function parseSliceSource(source: RandomAccessSource): SliceData {
    if (source.size < SLICE_HEADER_SIZE) {
        throw new InnoFormatError("slice file too small for header");
    }
    const head = source.readRangeSync(0, SLICE_HEADER_SIZE);
    const magicOk = SLICE_IDS.some((id) => id.every((b, i) => head[i] === b));
    if (!magicOk) {
        throw new InnoFormatError("bad slice magic number (not an Inno .bin data slice)");
    }
    const sliceSize = readU32At(head, 8);
    if (sliceSize > source.size) {
        throw new InnoFormatError(`bad slice size: ${sliceSize} > file ${source.size}`);
    }
    if (sliceSize < SLICE_HEADER_SIZE) {
        throw new InnoFormatError(`bad slice size: ${sliceSize} < header ${SLICE_HEADER_SIZE}`);
    }
    return { source, sliceSize };
}

export function parseSliceFile(bytes: Uint8Array): SliceData {
    return parseSliceSource(new BufferSource(bytes));
}

/**
 * Multi-part reader over external `.bin` slices (slice.cpp `slice_reader::read`):
 * data in slice N lives at [SLICE_HEADER_SIZE, sliceSize); when a span exhausts the
 * current slice it continues at the data start (after the header) of slice N+1.
 */
export class MultiSliceReader implements SliceSource {
    constructor(private readonly slices: SliceData[]) {}

    readSpan(firstSlice: number, offset: number, length: number): Uint8Array {
        const out = new Uint8Array(length);
        let written = 0;
        let slice = firstSlice;
        let pos = offset;
        while (written < length) {
            const s = this.slices[slice];
            if (!s) {
                throw new InnoFormatError(
                    `missing data slice ${slice} (drop all installer parts: setup.exe + every setup-*.bin)`,
                );
            }
            if (pos > s.sliceSize) {
                throw new InnoFormatError(`slice read out of bounds: ${pos} > ${s.sliceSize} (slice ${slice})`);
            }
            const remaining = s.sliceSize - pos;
            if (remaining <= 0) {
                slice++;
                pos = SLICE_HEADER_SIZE;
                continue;
            }
            const take = Math.min(remaining, length - written);
            out.set(s.source.readRangeSync(pos, pos + take), written);
            written += take;
            pos += take;
        }
        return out;
    }
}

export interface ChunkDescriptor {
    firstSlice: number;
    sortOffset: number;
    chunkSize: number;
    compression: number;
    encrypted: boolean;
}

const OPT_CHUNK_ENCRYPTED = 1 << 7; // setup/data.cpp — ChunkEncrypted

/** setup/data.cpp:276-291 — compression selection from header + chunkCompressed flag */
export function describeChunk(data: DataEntry, headerCompression: number): ChunkDescriptor {
    const encrypted = (data.options & OPT_CHUNK_ENCRYPTED) !== 0;
    const compression = data.chunkCompressed ? headerCompression : CompressionMethod.Stored;
    return {
        firstSlice: data.firstSlice,
        sortOffset: data.sortOffset,
        chunkSize: Number(data.chunkSize),
        compression,
        encrypted,
    };
}

export function chunkMapKey(chunk: ChunkDescriptor): string {
    return `${chunk.firstSlice}:${chunk.sortOffset}:${chunk.chunkSize}:${chunk.compression}:${chunk.encrypted ? 1 : 0}`;
}

function verifyMagic(magic: Uint8Array, absOffset: number): void {
    if (magic.byteLength < 4 ||
        magic[0] !== CHUNK_MAGIC[0] || magic[1] !== CHUNK_MAGIC[1] ||
        magic[2] !== CHUNK_MAGIC[2] || magic[3] !== CHUNK_MAGIC[3]) {
        throw new InnoFormatError(
            `bad chunk magic at slice+0x${absOffset.toString(16)} (expected zlb\\x1a)`,
            absOffset,
        );
    }
}

/** lzma.cpp:119-145 — LZMA2 dict size from 1-byte prop */
function lzma2DictSize(prop: number): number {
    if (prop > 40) {
        throw new InnoFormatError(`inno lzma2 property error: ${prop}`);
    }
    if (prop === 40) return 0xffffffff;
    return ((2 | (prop & 1)) << ((prop / 2) + 11)) >>> 0;
}

/**
 * Decompress one chunk payload, streaming output through `onWrite`.
 * Does not buffer the whole decompressed chunk.
 */
export function decompressChunkStream(
    slice: SliceSource,
    chunk: ChunkDescriptor,
    lzma: UnpackDecoder,
    onWrite: (bytes: Uint8Array) => boolean,
): void {
    if (chunk.encrypted) {
        throw new InnoFormatError(
            "encrypted installer — this GOG build uses encryption which is not supported in the browser",
            chunk.sortOffset,
        );
    }

    const absBase = chunk.sortOffset;
    verifyMagic(slice.readSpan(chunk.firstSlice, chunk.sortOffset, 4), absBase);

    const payload = slice.readSpan(chunk.firstSlice, chunk.sortOffset + 4, chunk.chunkSize);
    if (payload.byteLength !== chunk.chunkSize) {
        throw new InnoFormatError(
            `truncated chunk payload (got ${payload.byteLength}, expected ${chunk.chunkSize})`,
            absBase + 4,
        );
    }

    switch (chunk.compression) {
        case CompressionMethod.Stored: {
            if (!onWrite(payload)) {
                throw new InnoFormatError("output aborted during stored chunk decode", absBase);
            }
            break;
        }
        case CompressionMethod.LZMA1: {
            if (payload.byteLength < 5) {
                throw new InnoFormatError("LZMA1 chunk header too short", absBase + 4);
            }
            const props = payload.subarray(0, 5);
            const compressed = payload.subarray(5);
            try {
                lzma.decodeToCallback(UNPACK_LZMA1, compressed, onWrite, props);
            } catch (e) {
                throw new InnoFormatError(
                    `LZMA1 decode failed @ slice+0x${chunk.sortOffset.toString(16)}: ${e}`,
                    absBase,
                );
            }
            break;
        }
        case CompressionMethod.LZMA2: {
            if (payload.byteLength < 1) {
                throw new InnoFormatError("LZMA2 chunk header too short", absBase + 4);
            }
            const prop = payload[0]!;
            const dictSize = lzma2DictSize(prop);
            const props = new Uint8Array(4);
            new DataView(props.buffer).setUint32(0, dictSize, true);
            const compressed = payload.subarray(1);
            try {
                lzma.decodeToCallback(UNPACK_LZMA2, compressed, onWrite, props);
            } catch (e) {
                throw new InnoFormatError(
                    `LZMA2 decode failed @ slice+0x${chunk.sortOffset.toString(16)}: ${e}`,
                    absBase,
                );
            }
            break;
        }
        default:
            throw new InnoFormatError(
                `unsupported chunk compression method ${chunk.compression} @ slice+0x${chunk.sortOffset.toString(16)}`,
                absBase,
            );
    }
}
