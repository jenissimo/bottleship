/**
 * MPEG audio (MP1/MP2/MP3) probe.
 *
 * MPEG has no container header, so exactness depends on what the encoder left
 * behind: a Xing/Info or VBRI header in the first frame states the frame count
 * (exact for VBR and CBR alike). Without one the only option is the CBR estimate
 * from the first frame's bitrate over the audio byte range.
 */

import type { RandomAccessSource } from "../unpack/source";
import type { AudioStreamInfo } from "./index";
import { id3v2Size, readAt, readTail, samplesToMs, tagAt, u32be, u32le } from "./bytes";

const SEARCH_WINDOW = 8 * 1024;
const TRAILER_WINDOW = 192;

// Bitrate tables in kbps, indexed by the 4-bit field (0 = free, 15 = invalid).
const BITRATES_V1: readonly number[][] = [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0], // Layer I
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0], //    Layer II
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0], //     Layer III
];
const BITRATES_V2: readonly number[][] = [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0], // Layer I
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], //      Layer II
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], //      Layer III
];
const SAMPLE_RATES: Record<number, readonly number[]> = {
    1: [44100, 48000, 32000], // MPEG 1
    2: [22050, 24000, 16000], // MPEG 2
    25: [11025, 12000, 8000], // MPEG 2.5
};

interface FrameHeader {
    offset: number;
    version: 1 | 2 | 25;
    layer: 1 | 2 | 3;
    bitrate: number; // bits/s
    sampleRate: number;
    channels: number;
    samplesPerFrame: number;
    frameSize: number;
}

export function probeMp3(src: RandomAccessSource): AudioStreamInfo | null {
    const tagSize = id3v2Size(readAt(src, 0, 10), 0);
    const window = readAt(src, tagSize, SEARCH_WINDOW);
    const frame = findFrame(window, tagSize);
    if (!frame) return null;

    const samples = samplesFromVbrHeader(window, frame, tagSize);
    const durationMs = samples != null ? samplesToMs(samples, frame.sampleRate) : cbrDurationMs(src, frame);
    if (durationMs == null) return null;

    return { durationMs, sampleRate: frame.sampleRate, channels: frame.channels, format: "mp3" };
}

/** First frame whose successor lands exactly where its own size says it should. */
function findFrame(window: Uint8Array, windowBase: number): FrameHeader | null {
    for (let i = 0; i + 4 <= window.length; i++) {
        if (window[i] !== 0xff || (window[i + 1]! & 0xe0) !== 0xe0) continue;
        const frame = parseFrameHeader(window, i, windowBase);
        if (!frame) continue;
        const next = i + frame.frameSize;
        if (next + 4 > window.length) return frame; // no room to confirm; header was self-consistent
        const follower = parseFrameHeader(window, next, windowBase);
        if (follower && follower.version === frame.version && follower.layer === frame.layer && follower.sampleRate === frame.sampleRate) {
            return frame;
        }
    }
    return null;
}

function parseFrameHeader(b: Uint8Array, o: number, windowBase: number): FrameHeader | null {
    if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1]! & 0xe0) !== 0xe0) return null;

    const versionBits = (b[o + 1]! >> 3) & 0x03;
    const layerBits = (b[o + 1]! >> 1) & 0x03;
    if (versionBits === 1 || layerBits === 0) return null; // reserved
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
    const layer = (4 - layerBits) as 1 | 2 | 3;

    const rateIndex = (b[o + 2]! >> 2) & 0x03;
    if (rateIndex === 3) return null;
    const sampleRate = SAMPLE_RATES[version]![rateIndex]!;

    const bitrateKbps = (version === 1 ? BITRATES_V1 : BITRATES_V2)[layer - 1]![(b[o + 2]! >> 4) & 0x0f]!;
    if (bitrateKbps === 0) return null; // free-format or invalid — frame size is not derivable
    const bitrate = bitrateKbps * 1000;

    const padding = (b[o + 2]! >> 1) & 0x01;
    const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
    const frameSize =
        layer === 1
            ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
            : Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;

    return {
        offset: windowBase + o,
        version,
        layer,
        bitrate,
        sampleRate,
        channels: ((b[o + 3]! >> 6) & 0x03) === 3 ? 1 : 2,
        samplesPerFrame,
        frameSize,
    };
}

/**
 * Xing/Info (LAME et al.) or VBRI (Fraunhofer) header carried in the first frame.
 * Returns the decoded sample count, gapless-trimmed when LAME states the encoder
 * delay/padding — that trim is what a decoder actually emits.
 */
function samplesFromVbrHeader(window: Uint8Array, frame: FrameHeader, windowBase: number): number | null {
    const start = frame.offset - windowBase;

    // Fixed slot, MPEG 1 only.
    const vbri = start + 4 + 32;
    if (tagAt(window, vbri, "VBRI") && vbri + 18 <= window.length) {
        return u32be(window, vbri + 14) * frame.samplesPerFrame;
    }

    const sideInfo = frame.version === 1 ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17;
    const xing = start + 4 + sideInfo;
    if (!tagAt(window, xing, "Xing") && !tagAt(window, xing, "Info")) return null;
    if (xing + 8 > window.length) return null;

    const flags = u32be(window, xing + 4);
    if ((flags & 0x01) === 0) return null; // no frame count: the header tells us nothing about length
    // bytes.ts yields 0 for an out-of-range read, so a Xing block near the end of the 8 KB
    // search window would otherwise report "0 frames" as a FACT and win over the CBR
    // fallback — 0 ms, which breaks the caller's MCI_STATUS_LENGTH arithmetic outright.
    if (xing + 12 > window.length) return null;
    let p = xing + 8;
    const frames = u32be(window, p);
    p += 4;
    if (frames <= 0) return null; // the flag is set but the count is empty: estimate instead
    if (flags & 0x02) p += 4; // byte count
    if (flags & 0x04) p += 100; // seek TOC
    if (flags & 0x08) p += 4; // quality

    let samples = frames * frame.samplesPerFrame;
    if ((tagAt(window, p, "LAME") || tagAt(window, p, "Lavf") || tagAt(window, p, "Lavc")) && p + 24 <= window.length) {
        const delay = (window[p + 21]! << 4) | (window[p + 22]! >> 4);
        const padding = ((window[p + 22]! & 0x0f) << 8) | window[p + 23]!;
        if (delay + padding < samples) samples -= delay + padding;
    }
    return samples;
}

/** Bitrate over the audio byte range, with head/tail metadata excluded. */
function cbrDurationMs(src: RandomAccessSource, frame: FrameHeader): number | null {
    const audioBytes = src.size - frame.offset - trailerSize(src);
    if (audioBytes <= 0) return null;
    return Math.round((audioBytes * 8000) / frame.bitrate);
}

/** Bytes of appended metadata (ID3v1, APEv2) that are not MPEG frames. */
function trailerSize(src: RandomAccessSource): number {
    const { buf } = readTail(src, TRAILER_WINDOW);
    let size = 0;
    if (buf.length >= 128 && tagAt(buf, buf.length - 128, "TAG")) size = 128;

    const apeFooter = buf.length - size - 32;
    if (apeFooter >= 0 && tagAt(buf, apeFooter, "APETAGEX")) {
        // APEv2 footer: magic(8) version(8) size(12) ITEM COUNT(16) FLAGS(20) reserved(24).
        const tagBytes = u32le(buf, apeFooter + 12); // footer + items, header excluded
        const hasHeader = (u32le(buf, apeFooter + 20) & 0x80000000) !== 0;
        size += tagBytes + (hasHeader ? 32 : 0);
    }
    return Math.min(size, src.size);
}
