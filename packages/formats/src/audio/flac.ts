/**
 * FLAC container probe.
 *
 * STREAMINFO — the mandatory first metadata block — carries the total sample
 * count, so the whole probe is the first ~50 bytes of the file.
 */

import type { RandomAccessSource } from "../unpack/source";
import type { AudioStreamInfo } from "./index";
import { id3v2Size, readAt, samplesToMs, tagAt, u32be } from "./bytes";

export const STREAMINFO_SIZE = 34;
const HEAD_WINDOW = 128;

export interface FlacStreamInfo {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    /** 0 means "unknown" — a stream written without a known length. */
    totalSamples: number;
}

export function probeFlac(src: RandomAccessSource): AudioStreamInfo | null {
    const head = readAt(src, 0, HEAD_WINDOW);
    const start = id3v2Size(head, 0); // taggers happily prepend ID3v2 to FLAC
    if (!tagAt(head, start, "fLaC")) return null;

    // Metadata block header: last-block flag + 7-bit type, then a 24-bit length.
    // STREAMINFO (type 0) is required to be first, so no block walking is needed.
    const blockHeader = start + 4;
    if (blockHeader + 4 + STREAMINFO_SIZE > head.length) return null;
    if ((head[blockHeader]! & 0x7f) !== 0) return null;

    const info = parseStreamInfo(head, blockHeader + 4);
    if (!info || info.totalSamples === 0) return null; // unknown length: nothing to report honestly
    return {
        durationMs: samplesToMs(info.totalSamples, info.sampleRate),
        sampleRate: info.sampleRate,
        channels: info.channels,
        format: "flac",
    };
}

/** Decode a 34-byte STREAMINFO body (also used by the FLAC-in-Ogg mapping). */
export function parseStreamInfo(buf: Uint8Array, off: number): FlacStreamInfo | null {
    if (off + STREAMINFO_SIZE > buf.length) return null;

    // Bit-packed at byte 10: 20 bits rate, 3 bits channels-1, 5 bits bps-1, 36 bits total samples.
    const sampleRate = (buf[off + 10]! << 12) | (buf[off + 11]! << 4) | (buf[off + 12]! >> 4);
    if (sampleRate === 0) return null;
    const channels = ((buf[off + 12]! >> 1) & 0x07) + 1;
    const bitsPerSample = (((buf[off + 12]! & 0x01) << 4) | (buf[off + 13]! >> 4)) + 1;
    const totalSamples = (buf[off + 13]! & 0x0f) * 0x100000000 + u32be(buf, off + 14);
    return { sampleRate, channels, bitsPerSample, totalSamples };
}
