/**
 * RIFF/WAVE container probe and writer.
 *
 * Duration comes from the `data` chunk size over the format's byte rate (PCM), or
 * from the `fact` chunk's sample count for compressed payloads where bytes and
 * samples are not proportional. Only the chunk headers are read, never the audio.
 */

import type { RandomAccessSource } from "../unpack/source";
import type { AudioProbe } from "./index";
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
    blockAlign: number;
    bitsPerSample: number;
}

export function probeWav(src: RandomAccessSource): AudioProbe | null {
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

    // Either half of the header alone is still a WAV its readers accept: a `fmt `-only
    // image states the real rate (with no derivable length), and a RIFF whose `fmt ` is a
    // stub or missing wraps an encoded `data` chunk a caller plays as its own stream.
    // Refusing either makes that caller substitute a device default for the whole file.
    const format = fmt && fmt.channels && fmt.sampleRate ? fmt : null;
    if (!format && dataOffset < 0) return null;

    // A declared size past EOF (streamed/truncated writers use 0xFFFFFFFF) means "to the end".
    const available = dataOffset < 0 ? 0 : src.size - dataOffset;
    const audioBytes = dataSize < 0 || dataSize > available ? available : dataSize;

    return {
        format: "wav",
        sampleRate: format?.sampleRate ?? 0,
        channels: format?.channels ?? 0,
        bitsPerSample: format?.bitsPerSample ?? 0,
        durationMs: format ? durationMs(format, audioBytes, factSamples) : 0,
        dataStart: dataOffset < 0 ? 0 : dataOffset,
        dataEnd: dataOffset < 0 ? 0 : dataOffset + audioBytes,
        formatTag: format?.formatTag ?? 0,
        blockAlign: format?.blockAlign ?? 0,
        mpegLayer: 0,
    };
}

/** 0 when the header states nothing a length can be derived from. */
function durationMs(fmt: WavFormat, audioBytes: number, factSamples: number): number {
    const compressed = fmt.formatTag !== WAVE_FORMAT_PCM && fmt.formatTag !== WAVE_FORMAT_FLOAT;
    if (compressed && factSamples > 0) return samplesToMs(factSamples, fmt.sampleRate);

    const byteRate = fmt.byteRate > 0 ? fmt.byteRate : (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
    if (byteRate <= 0) return 0;
    return Math.round((audioBytes * 1000) / byteRate);
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
        blockAlign: u16le(b, 12),
        bitsPerSample: u16le(b, 14),
    };
}

/**
 * Canonical 44-byte-header PCM RIFF/WAVE wrapper around already-decoded 16-bit
 * samples. Lives beside the probe so the two directions of the format share one
 * definition of where every field sits — and so a round trip is one test.
 */
export function buildPcmWavImage(pcm: Uint8Array, channels: number, sampleRate: number): Uint8Array {
    const ch = Math.max(1, channels | 0);
    const rate = Math.max(1, sampleRate | 0);
    const blockAlign = ch * 2;
    const image = new Uint8Array(44 + pcm.byteLength);
    const view = new DataView(image.buffer);
    const tag = (offset: number, text: string) => {
        for (let i = 0; i < 4; i++) image[offset + i] = text.charCodeAt(i);
    };
    tag(0, "RIFF");
    view.setUint32(4, 36 + pcm.byteLength, true);
    tag(8, "WAVE");
    tag(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, WAVE_FORMAT_PCM, true);
    view.setUint16(22, ch, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    tag(36, "data");
    view.setUint32(40, pcm.byteLength, true);
    image.set(pcm, 44);
    return image;
}
