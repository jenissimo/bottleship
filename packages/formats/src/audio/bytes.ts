/** Byte helpers shared by the container probes. */

import type { RandomAccessSource } from "../unpack/source";

/** Read `len` bytes at `start`. May come back short at EOF — callers must check `.length`. */
export function readAt(src: RandomAccessSource, start: number, len: number): Uint8Array {
    if (start < 0 || len <= 0 || start >= src.size) return EMPTY;
    return src.readRangeSync(start, Math.min(start + len, src.size));
}

/** Read the last `len` bytes; returns the window plus its absolute file offset. */
export function readTail(src: RandomAccessSource, len: number): { buf: Uint8Array; base: number } {
    const base = Math.max(0, src.size - len);
    return { buf: src.readRangeSync(base, src.size), base };
}

export const EMPTY = new Uint8Array(0);

/** ASCII tag compare (four-char chunk ids, magic words). */
export function tagAt(buf: Uint8Array, off: number, tag: string): boolean {
    if (off < 0 || off + tag.length > buf.length) return false;
    for (let i = 0; i < tag.length; i++) if (buf[off + i] !== tag.charCodeAt(i)) return false;
    return true;
}

export function u16be(b: Uint8Array, o: number): number {
    return (b[o]! << 8) | b[o + 1]!;
}

export function u24be(b: Uint8Array, o: number): number {
    return (b[o]! << 16) | (b[o + 1]! << 8) | b[o + 2]!;
}

export function u32be(b: Uint8Array, o: number): number {
    return ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
}

export function u16le(b: Uint8Array, o: number): number {
    return b[o]! | (b[o + 1]! << 8);
}

export function u32le(b: Uint8Array, o: number): number {
    return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | ((b[o + 3]! << 24) >>> 0)) >>> 0;
}

/**
 * Size of the ID3v2 tag at `off`, including header and optional footer; 0 if absent.
 * The length field is "syncsafe" — 7 usable bits per byte so a tag can never
 * contain a byte sequence a decoder would mistake for an MPEG frame sync.
 */
export function id3v2Size(buf: Uint8Array, off = 0): number {
    if (!tagAt(buf, off, "ID3") || off + 10 > buf.length) return 0;
    const flags = buf[off + 5]!;
    for (let i = 6; i < 10; i++) if (buf[off + i]! & 0x80) return 0;
    const size = (buf[off + 6]! << 21) | (buf[off + 7]! << 14) | (buf[off + 8]! << 7) | buf[off + 9]!;
    return 10 + size + (flags & 0x10 ? 10 : 0);
}

/** Samples → whole milliseconds; MCI reports integral ms, so round once at the source. */
export function samplesToMs(samples: number, sampleRate: number): number {
    return Math.round((samples * 1000) / sampleRate);
}
