/**
 * Ogg container probe (Vorbis, Opus, FLAC-in-Ogg).
 *
 * Duration comes from the granule position of the LAST page of the logical
 * stream — the codec's own sample counter — so it is exact without decoding.
 * Only the head (codec identification header) and a tail window are read.
 */

import type { RandomAccessSource } from "../unpack/source";
import type { AudioProbe } from "./index";
import { readAt, readTail, samplesToMs, tagAt, u16be, u16le, u32le } from "./bytes";
import { parseStreamInfo, STREAMINFO_SIZE } from "./flac";

const HEAD_WINDOW = 8 * 1024;
const TAIL_WINDOW_FAST = 32 * 1024;
/** A legal Ogg page is at most 27 + 255 + 255*255 = 65307 bytes, so this window always holds a whole one. */
const TAIL_WINDOW_MAX = 128 * 1024;
const MIN_PAGE_HEADER = 27;

interface OggPage {
    headerType: number;
    /** End sample of the last packet finishing on this page; -1 when none does. */
    granule: number;
    serial: number;
    size: number;
    bodyOffset: number;
    bodySize: number;
    /** Packets that finish on this page (segment table entries < 255). */
    packetEnds: number;
}

interface CodecInfo {
    sampleRate: number;
    channels: number;
    /** Only FLAC-in-Ogg states one; 0 for Vorbis/Opus. */
    bitsPerSample: number;
    /** Packets belonging to the header; the page they finish on carries the stream's start granule. */
    headerPackets: number;
    /** Samples the decoder discards at the start (Opus); already counted in granulepos. */
    preSkip: number;
}

export function probeOgg(src: RandomAccessSource): AudioProbe | null {
    const head = readAt(src, 0, HEAD_WINDOW);
    const first = parsePage(head, 0);
    if (!first || first.headerType & 0x01 || first.bodySize === 0) return null;

    const codec = identifyCodec(head, first);
    if (!codec) return null;

    const last = findLastGranule(src, first.serial);
    if (last == null) return null;

    const samples = last - startGranule(head, codec.headerPackets) - codec.preSkip;
    if (samples < 0) return null;
    return {
        format: "ogg",
        sampleRate: codec.sampleRate,
        channels: codec.channels,
        bitsPerSample: codec.bitsPerSample,
        durationMs: samplesToMs(samples, codec.sampleRate),
        // Ogg interleaves headers and audio into pages; the payload is the whole file.
        dataStart: 0,
        dataEnd: src.size,
        formatTag: 0,
        blockAlign: 0,
        mpegLayer: 0,
    };
}

function identifyCodec(head: Uint8Array, first: OggPage): CodecInfo | null {
    const b = first.bodyOffset;
    const n = first.bodySize;

    // Vorbis I identification header: packet type 1, "vorbis", version, channels, rate.
    if (n >= 30 && head[b] === 0x01 && tagAt(head, b + 1, "vorbis") && u32le(head, b + 7) === 0) {
        const channels = head[b + 11]!;
        const sampleRate = u32le(head, b + 12);
        if (!channels || !sampleRate) return null;
        return { sampleRate, channels, bitsPerSample: 0, headerPackets: 3, preSkip: 0 };
    }

    // Opus always decodes at 48 kHz and its granulepos counts 48 kHz samples,
    // including the pre-skip; the "input sample rate" field is informational only.
    if (n >= 19 && tagAt(head, b, "OpusHead")) {
        const channels = head[b + 9]!;
        if (!channels) return null;
        return { sampleRate: 48000, channels, bitsPerSample: 0, headerPackets: 2, preSkip: u16le(head, b + 10) };
    }

    // FLAC-in-Ogg mapping: 0x7F "FLAC" major minor, u16be header-packet count, then the
    // native "fLaC" marker and the STREAMINFO block.
    if (n >= 13 + 4 + STREAMINFO_SIZE && head[b] === 0x7f && tagAt(head, b + 1, "FLAC") && tagAt(head, b + 9, "fLaC")) {
        const info = parseStreamInfo(head, b + 13 + 4);
        if (!info) return null;
        return { sampleRate: info.sampleRate, channels: info.channels, bitsPerSample: info.bitsPerSample, headerPackets: 1 + u16be(head, b + 7), preSkip: 0 };
    }

    return null; // Speex/Theora/unknown mapping — reporting Vorbis-shaped info would be a lie.
}

/**
 * Granule at the end of the header packets. Zero for a normal stream; a stream cut
 * out of a longer one starts at a non-zero position and must not count it as audio.
 */
function startGranule(head: Uint8Array, headerPackets: number): number {
    let off = 0;
    let ends = 0;
    for (;;) {
        const page = parsePage(head, off);
        if (!page) return 0;
        ends += page.packetEnds;
        if (ends >= headerPackets) return page.granule > 0 ? page.granule : 0;
        off += page.size;
    }
}

function findLastGranule(src: RandomAccessSource, serial: number): number | null {
    const fast = scanTailForGranule(src, serial, TAIL_WINDOW_FAST);
    if (fast != null) return fast;
    if (src.size <= TAIL_WINDOW_FAST) return null;
    return scanTailForGranule(src, serial, TAIL_WINDOW_MAX);
}

/**
 * Last page of `serial` in the trailing window. 'OggS' also occurs inside compressed
 * audio, so every candidate is validated by its own CRC before its granule is trusted.
 */
function scanTailForGranule(src: RandomAccessSource, serial: number, windowLen: number): number | null {
    const { buf, base } = readTail(src, windowLen);
    for (let i = buf.length - MIN_PAGE_HEADER; i >= 0; i--) {
        if (buf[i] !== 0x4f || buf[i + 1] !== 0x67 || buf[i + 2] !== 0x67 || buf[i + 3] !== 0x53) continue;
        const page = parsePage(buf, i);
        if (!page || base + i + page.size > src.size) continue;
        if (!crcOk(buf, i, page.size)) continue;
        if (page.serial !== serial || page.granule < 0) continue;
        return page.granule;
    }
    return null;
}

function parsePage(buf: Uint8Array, off: number): OggPage | null {
    if (off < 0 || off + MIN_PAGE_HEADER > buf.length) return null;
    if (!tagAt(buf, off, "OggS") || buf[off + 4] !== 0x00) return null;

    const segments = buf[off + 26]!;
    const bodyOffset = off + MIN_PAGE_HEADER + segments;
    if (bodyOffset > buf.length) return null;

    let bodySize = 0;
    let packetEnds = 0;
    for (let i = 0; i < segments; i++) {
        const lace = buf[off + MIN_PAGE_HEADER + i]!;
        bodySize += lace;
        if (lace < 255) packetEnds++;
    }
    if (bodyOffset + bodySize > buf.length) return null;

    // granulepos is 64-bit; a 32-bit read overflows ~27 h into a 44.1 kHz stream.
    const lo = u32le(buf, off + 6);
    const hi = u32le(buf, off + 10);
    const granule = hi & 0x80000000 ? -1 : hi * 0x100000000 + lo;

    return {
        headerType: buf[off + 5]!,
        granule,
        serial: u32le(buf, off + 14),
        size: MIN_PAGE_HEADER + segments + bodySize,
        bodyOffset,
        bodySize,
        packetEnds,
    };
}

let crcTable: Uint32Array | null = null;

/** Ogg uses a non-reflected CRC-32/0x04c11db7 with zero init and no final xor. */
function crcOk(buf: Uint8Array, off: number, size: number): boolean {
    if (!crcTable) {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let r = i << 24;
            for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
            t[i] = r >>> 0;
        }
        crcTable = t;
    }
    let crc = 0;
    for (let i = 0; i < size; i++) {
        const b = i >= 22 && i < 26 ? 0 : buf[off + i]!; // the CRC field reads as zero
        crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
    }
    return crc === u32le(buf, off + 22);
}
