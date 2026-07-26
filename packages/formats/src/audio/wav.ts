/**
 * RIFF/WAVE container probe.
 *
 * Duration comes from the `data` chunk size over the format's byte rate (PCM), or
 * from the `fact` chunk's sample count for compressed payloads where bytes and
 * samples are not proportional. Only the chunk headers are read, never the audio.
 */

import type { RandomAccessSource } from "../unpack/source";
import type { AudioStreamInfo } from "./index";
import { readAt, samplesToMs, tagAt, u16le, u32le } from "./bytes";

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** Chunk walking is bounded: fmt/data sit near the front, anything further is metadata. */
const MAX_CHUNKS = 128;

interface WavFormat {
    formatTag: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    bitsPerSample: number;
}

export function probeWav(src: RandomAccessSource): AudioStreamInfo | null {
    const head = readAt(src, 0, 12);
    if (head.length < 12 || !tagAt(head, 8, "WAVE")) return null;
    const rf64 = tagAt(head, 0, "RF64");
    if (!rf64 && !tagAt(head, 0, "RIFF")) return null;

    let fmt: WavFormat | null = null;
    let dataOffset = -1;
    let dataSize = -1;
    let factSamples = -1;

    let off = 12;
    for (let i = 0; i < MAX_CHUNKS && off + 8 <= src.size; i++) {
        const h = readAt(src, off, 8);
        if (h.length < 8) break;
        const size = u32le(h, 4);
        const body = off + 8;

        if (tagAt(h, 0, "fmt ")) {
            fmt = parseFormat(readAt(src, body, Math.min(size, 40)));
        } else if (tagAt(h, 0, "data")) {
            dataOffset = body;
            dataSize = size;
        } else if (tagAt(h, 0, "fact")) {
            const b = readAt(src, body, 4);
            if (b.length >= 4) factSamples = u32le(b, 0);
        } else if (rf64 && tagAt(h, 0, "ds64")) {
            // RF64 parks the real 64-bit sizes here; the RIFF fields read 0xFFFFFFFF.
            const b = readAt(src, body, 24);
            if (b.length >= 16) dataSize = u32le(b, 8) + u32le(b, 12) * 0x100000000;
            if (b.length >= 24) factSamples = u32le(b, 16) + u32le(b, 20) * 0x100000000;
        }

        off = body + size + (size & 1); // chunks are word-aligned; odd sizes carry a pad byte
    }

    if (!fmt || !fmt.channels || !fmt.sampleRate || dataOffset < 0) return null;

    // A declared size past EOF (streamed/truncated writers use 0xFFFFFFFF) means "to the end".
    const available = src.size - dataOffset;
    const audioBytes = dataSize < 0 || dataSize > available ? available : dataSize;

    const compressed = fmt.formatTag !== WAVE_FORMAT_PCM && fmt.formatTag !== WAVE_FORMAT_FLOAT;
    if (compressed && factSamples > 0) {
        return info(samplesToMs(factSamples, fmt.sampleRate), fmt);
    }

    const byteRate = fmt.byteRate > 0 ? fmt.byteRate : (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
    if (byteRate <= 0) return null;
    return info(Math.round((audioBytes * 1000) / byteRate), fmt);
}

function info(durationMs: number, fmt: WavFormat): AudioStreamInfo {
    return { durationMs, sampleRate: fmt.sampleRate, channels: fmt.channels, format: "wav" };
}

function parseFormat(b: Uint8Array): WavFormat | null {
    if (b.length < 16) return null;
    let formatTag = u16le(b, 0);
    // WAVE_FORMAT_EXTENSIBLE hides the real tag in the first two bytes of the SubFormat GUID.
    if (formatTag === WAVE_FORMAT_EXTENSIBLE && b.length >= 26) formatTag = u16le(b, 24);
    return {
        formatTag,
        channels: u16le(b, 2),
        sampleRate: u32le(b, 4),
        byteRate: u32le(b, 8),
        bitsPerSample: u16le(b, 14),
    };
}
