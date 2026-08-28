import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { BufferSource } from "@bottleship/formats/unpack/source";
import { probeAudio, probeAudioAt, type AudioProbe } from "@bottleship/formats/audio";
import { MSSContext } from "./context";
import { MSSSample, MSSStream } from "./types";
import { applyEncodedPcmLength, inspectEncodedAudio, isMp3, isOgg, refreshSampleLenDone, refreshStreamLenDone } from "./helpers";
import { playSample, playStream } from "./playback-engine";

// Decoded audio cache - avoids re-decoding same WAV files (significant perf win)
let decodedCache = new Map<string, { data: Float32Array; sampleRate: number; channels: number }>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 32 * 1024 * 1024; // 32MB max

/**
 * Compute fast hash key for audio data caching.
 * Uses first 32 bytes + last 16 bytes + length for quick uniqueness check.
 */
function computeCacheKey(data: Uint8Array): string {
    let hash = data.byteLength;
    const headLen = Math.min(32, data.byteLength);
    for (let i = 0; i < headLen; i++) {
        hash = ((hash << 5) - hash + data[i]) >>> 0;
    }
    if (data.byteLength > 48) {
        const tailStart = data.byteLength - 16;
        for (let i = 0; i < 16; i++) {
            hash = ((hash << 5) - hash + data[tailStart + i]) >>> 0;
        }
    }
    return `${hash.toString(16)}_${data.byteLength}`;
}

function addToCache(key: string, data: Float32Array, sampleRate: number, channels: number): void {
    const dataBytes = data.byteLength;
    if (dataBytes > MAX_CACHE_BYTES) return;
    while (cacheBytes + dataBytes > MAX_CACHE_BYTES && decodedCache.size > 0) {
        const firstKey = decodedCache.keys().next().value;
        if (!firstKey) break;
        const evicted = decodedCache.get(firstKey);
        if (evicted) {
            cacheBytes -= evicted.data.byteLength;
        }
        decodedCache.delete(firstKey);
    }
    decodedCache.set(key, { data, sampleRate, channels });
    cacheBytes += dataBytes;
}

/**
 * Decode audio file from memory (WAV or MP3).
 * @param formatHint Optional filename/extension hint (e.g. ".mp3", "frontend.mp3") from file_suffix arg.
 */
export function decodeAudioFile(ctx: MSSContext, sample: MSSSample, formatHint?: string): void {
    if (!sample.fileData || sample.fileData.length < 4) {
        Logger.warn(LogCategory.SYSTEM, 'MSS32: Invalid audio file (too small)');
        sample.fileFormat = "unknown";
        sample.decodedData = null;
        return;
    }

    sample.pcmBytes = undefined;
    sample.encodedDurationMs = undefined;

    const hintLower = formatHint?.toLowerCase() ?? '';
    const forceMp3 = hintLower.endsWith('.mp3') || hintLower === 'mp3';
    const forceOgg = hintLower.endsWith('.ogg') || hintLower === 'ogg';

    if (forceMp3 || isMp3(sample.fileData)) {
        const info = inspectEncodedAudio(sample.fileData, "mp3");
        sample.fileFormat = "mp3";
        sample.decodedData = null;
        sample.sampleRate = info.sampleRate ?? 44100;
        sample.channels = info.channels ?? 2;
        sample.bitsPerSample = 16;
        sample.blockAlign = sample.channels * 2;
        sample.encodedDurationMs = info.durationMs;
        applyEncodedPcmLength(ctx, sample);

        Logger.verbose(LogCategory.SYSTEM, "MSS32: Detected MP3 file, deferring decode to main thread");
        if (sample.pendingStart) {
            playSample(ctx, sample);
        }
        return;
    }

    if (forceOgg || isOgg(sample.fileData)) {
        const info = inspectEncodedAudio(sample.fileData, "ogg");
        sample.fileFormat = "ogg";
        sample.decodedData = null;
        sample.sampleRate = info.sampleRate ?? 44100;
        sample.channels = info.channels ?? 2;
        sample.bitsPerSample = 16;
        sample.blockAlign = sample.channels * 2;
        sample.encodedDurationMs = info.durationMs;
        applyEncodedPcmLength(ctx, sample);

        Logger.verbose(LogCategory.SYSTEM, "MSS32: Detected OGG file, deferring decode to main thread");
        if (sample.pendingStart) {
            playSample(ctx, sample);
        }
        return;
    }

    const cacheKey = computeCacheKey(sample.fileData);
    const cached = decodedCache.get(cacheKey);
    if (cached) {
        sample.fileFormat = "wav";
        sample.decodedData = cached.data;
        sample.sampleRate = cached.sampleRate;
        sample.channels = cached.channels;
        sample.pcmBytes = (cached.data.length / cached.channels) * 2;
        sample.bitsPerSample = 16;
        sample.formatTag = 1;
        sample.blockAlign = cached.channels * 2;

        refreshSampleLenDone(ctx, sample);
        if (sample.pendingStart && sample.decodedData.length > 0) {
            playSample(ctx, sample);
        }
        return;
    }

    const parsed = parseWav(sample.fileData);
    if (parsed) {
        sample.fileFormat = "wav";
        sample.pcmBytes = parsed.data.byteLength;
        sample.decodedData = convertToFloat(parsed.data, parsed.channels, parsed.bitsPerSample, parsed.formatTag, parsed.blockAlign);
        sample.sampleRate = parsed.sampleRate;
        sample.channels = parsed.channels;
        sample.bitsPerSample = parsed.bitsPerSample;
        sample.formatTag = parsed.formatTag;
        sample.blockAlign = parsed.blockAlign;

        addToCache(cacheKey, sample.decodedData, parsed.sampleRate, parsed.channels);

        refreshSampleLenDone(ctx, sample);
        const fmtName = parsed.formatTag === 17 ? 'IMA_ADPCM' : parsed.formatTag === 1 ? 'PCM' : `tag${parsed.formatTag}`;
        Logger.log(LogCategory.SYSTEM, `MSS32: Decoded WAV: ${fmtName} ${sample.channels}ch ${sample.sampleRate}Hz ${sample.decodedData.length} float samples (src ${sample.fileData.length}B) addr=0x${(sample.fileDataAddress ?? 0).toString(16)}`);
        if (sample.pendingStart && sample.decodedData.length > 0) {
            playSample(ctx, sample);
        }
        return;
    }

    sample.fileFormat = "unknown";
    Logger.warn(LogCategory.SYSTEM, "MSS32: Unsupported audio format");
}

/**
 * Decode audio for a stream, using cache.
 * Returns true if file was decoded/cached successfully.
 */
export function decodeStreamFile(ctx: MSSContext, stream: MSSStream): boolean {
    if (!stream.fileData) return false;

    stream.pcmBytes = undefined;
    stream.encodedDurationMs = undefined;

    if (isMp3(stream.fileData)) {
        const info = inspectEncodedAudio(stream.fileData, "mp3");
        stream.fileFormat = "mp3";
        stream.decodedData = null;
        stream.sampleRate = info.sampleRate ?? 44100;
        stream.channels = info.channels ?? 2;
        stream.bitsPerSample = 16;
        stream.blockAlign = stream.channels * 2;
        stream.encodedDurationMs = info.durationMs;
        applyEncodedPcmLength(ctx, stream);
        Logger.log(LogCategory.SYSTEM, `MSS32: Stream loaded as MP3: "${stream.filename}"`);
        if (stream.pendingStart) {
            playStream(ctx, stream);
        }
        return true;
    }

    if (isOgg(stream.fileData)) {
        const info = inspectEncodedAudio(stream.fileData, "ogg");
        stream.fileFormat = "ogg";
        stream.decodedData = null;
        stream.sampleRate = info.sampleRate ?? 44100;
        stream.channels = info.channels ?? 2;
        stream.bitsPerSample = 16;
        stream.blockAlign = stream.channels * 2;
        stream.encodedDurationMs = info.durationMs;
        applyEncodedPcmLength(ctx, stream);
        Logger.log(LogCategory.SYSTEM, `MSS32: Stream loaded as OGG: "${stream.filename}"`);
        if (stream.pendingStart) {
            playStream(ctx, stream);
        }
        return true;
    }

    const cacheKey = computeCacheKey(stream.fileData);
    const cached = decodedCache.get(cacheKey);
    if (cached) {
        stream.fileFormat = "wav";
        stream.decodedData = cached.data;
        stream.sampleRate = cached.sampleRate;
        stream.channels = cached.channels;
        stream.pcmBytes = (cached.data.length / cached.channels) * 2;
        stream.bitsPerSample = 16;
        stream.formatTag = 1;
        stream.blockAlign = cached.channels * 2;
        Logger.log(LogCategory.SYSTEM, `MSS32: Stream loaded from cache: "${stream.filename}" (${stream.pcmBytes} bytes)`);
        refreshStreamLenDone(ctx, stream);
        if (stream.pendingStart) {
            playStream(ctx, stream);
        }
        return true;
    }

    const parsed = parseWav(stream.fileData);
    if (parsed) {
        stream.fileFormat = "wav";
        stream.pcmBytes = parsed.data.byteLength;
        stream.decodedData = convertToFloat(parsed.data, parsed.channels, parsed.bitsPerSample, parsed.formatTag, parsed.blockAlign);
        stream.sampleRate = parsed.sampleRate;
        stream.channels = parsed.channels;
        stream.bitsPerSample = parsed.bitsPerSample;
        stream.formatTag = parsed.formatTag;
        stream.blockAlign = parsed.blockAlign;

        addToCache(cacheKey, stream.decodedData, stream.sampleRate, stream.channels);

        Logger.log(LogCategory.SYSTEM,
            `MSS32: Stream decoded: "${stream.filename ?? '(memory)'}" (${stream.decodedData.length} samples, ${stream.channels} ch, ${stream.sampleRate} Hz)`);
        refreshStreamLenDone(ctx, stream);
        if (stream.pendingStart) {
            playStream(ctx, stream);
        }
        return true;
    }

    Logger.error(LogCategory.SYSTEM, `MSS32: Failed to parse stream file: "${stream.filename ?? '(memory)'}"`);
    return false;
}

// Miles DIG_F_* format flags. We hold no Miles header — this bit layout is OUR
// reconstruction from what guests hand us (a mono-16 sample arrives as format=1) and
// is consistent with every AILSOUNDINFO seen so far. Treat it as convention, not spec.
export const DIG_F_16BITS_MASK = 1;
export const DIG_F_STEREO_MASK = 2;
export const DIG_F_ADPCM_MASK = 4;
export const DIG_F_MONO_8 = 0;
export const DIG_F_MONO_16 = DIG_F_16BITS_MASK;
export const DIG_F_STEREO_8 = DIG_F_STEREO_MASK;
export const DIG_F_STEREO_16 = DIG_F_STEREO_MASK | DIG_F_16BITS_MASK;
export const DIG_F_ADPCM_MONO_16 = DIG_F_ADPCM_MASK | DIG_F_16BITS_MASK;
export const DIG_F_ADPCM_STEREO_16 = DIG_F_ADPCM_MASK | DIG_F_16BITS_MASK | DIG_F_STEREO_MASK;

/** Classic 36-byte AILSOUNDINFO (no channel_mask field). */
export const AILSOUNDINFO_SIZE = 36;

export interface WavChunkInfo {
    formatTag: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    blockAlign: number;
    dataChunkOffset: number;
    dataChunkSize: number;
}

/**
 * Miles view of a RIFF/WAVE image: the shared probe's fields under the names the
 * ADPCM/PCM decode paths use. A zero format tag is rejected here and not in the
 * probe — the tag selects the decoder, so "WAVE with no usable fmt" is not a WAV
 * this module can do anything with.
 */
function toWavChunkInfo(probe: AudioProbe | null): WavChunkInfo | null {
    if (!probe || probe.format !== "wav" || !probe.formatTag) return null;
    return {
        formatTag: probe.formatTag,
        channels: probe.channels,
        sampleRate: probe.sampleRate,
        bitsPerSample: probe.bitsPerSample,
        blockAlign: probe.blockAlign,
        dataChunkOffset: probe.dataStart,
        dataChunkSize: probe.dataEnd - probe.dataStart,
    };
}

export function scanWavChunks(data: Uint8Array): WavChunkInfo | null {
    return toWavChunkInfo(probeAudio(new BufferSource(data)));
}

export function inspectWavImage(mem: Uint8Array, wavPtr: number): (WavChunkInfo & { wavPtr: number; dataGuestPtr: number }) | null {
    if (!wavPtr || !MemoryGuard.isValidRange(mem, wavPtr, 12)) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const riffSize = view.getUint32(wavPtr + 4, true) + 8;
    const scanLen = Math.min(riffSize, mem.length - wavPtr);
    if (scanLen < 44) return null;
    const info = toWavChunkInfo(probeAudioAt(mem, wavPtr, scanLen));
    if (!info) return null;
    return {
        ...info,
        wavPtr,
        dataGuestPtr: wavPtr + info.dataChunkOffset,
    };
}

export function wavFormatToDigF(formatTag: number, channels: number, bitsPerSample: number): number {
    const stereo = channels >= 2;
    if (formatTag === 17 || formatTag === 2) {
        return stereo ? DIG_F_ADPCM_STEREO_16 : DIG_F_ADPCM_MONO_16;
    }
    if (bitsPerSample === 16 || formatTag === 3) {
        return stereo ? DIG_F_STEREO_16 : DIG_F_MONO_16;
    }
    return stereo ? DIG_F_STEREO_8 : DIG_F_MONO_8;
}

export function ailBitsForWav(formatTag: number, bitsPerSample: number): number {
    if (formatTag === 17 || formatTag === 2) return 4;
    return bitsPerSample || 16;
}

export function countWavSampleFrames(info: WavChunkInfo): number {
    const { formatTag, channels, bitsPerSample, blockAlign, dataChunkSize } = info;
    if (formatTag === 17) {
        return countImaAdpcmFrames(dataChunkSize, blockAlign, channels);
    }
    if (formatTag === 2) {
        // MS ADPCM: 2 samples in 7-byte mono header, then 2 bits per sample in remainder
        const header = channels >= 2 ? 14 : 7;
        const samplesPerBlock = channels >= 2 ? 7 : 3;
        const extra = Math.max(0, blockAlign - header);
        const perBlock = samplesPerBlock + extra * 2;
        return Math.floor(dataChunkSize / blockAlign) * perBlock;
    }
    const bytesPerFrame = channels * Math.max(1, (bitsPerSample || 16) >> 3);
    return bytesPerFrame > 0 ? Math.floor(dataChunkSize / bytesPerFrame) : 0;
}

function countImaAdpcmFrames(dataLen: number, blockAlign: number, channels: number): number {
    if (blockAlign <= 0 || dataLen <= 0) return 0;
    const blocks = Math.floor(dataLen / blockAlign);
    if (channels > 1) {
        const headerBytes = channels * 4;
        const samplesPerBlock = 1 + Math.floor(((blockAlign - headerBytes) * 2) / channels);
        return blocks * samplesPerBlock;
    }
    const samplesPerBlock = 1 + (blockAlign - 4) * 2;
    return blocks * samplesPerBlock;
}

export function decodeAdpcmToS16(
    data: Uint8Array,
    formatTag: number,
    channels: number,
    blockAlign: number,
): Int16Array {
    if (formatTag === 17) {
        return decodeImaAdpcmToS16(data, channels, blockAlign);
    }
    if (formatTag === 2) {
        return decodeMsAdpcmToS16(data, channels, blockAlign);
    }
    throw new Error(`Unsupported ADPCM format tag ${formatTag}`);
}

export function decodeImaAdpcmToS16(data: Uint8Array, channels: number, blockAlign: number): Int16Array {
    const floats = decodeImaAdpcm(data, channels, blockAlign);
    const out = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
        const sample = Math.round(floats[i] * 32768);
        out[i] = sample < -32768 ? -32768 : sample > 32767 ? 32767 : sample;
    }
    return out;
}

function decodeMsAdpcmToS16(data: Uint8Array, channels: number, blockAlign: number): Int16Array {
    const adapt = [
        230, 230, 230, 230, 307, 409, 512, 614,
        768, 614, 512, 409, 307, 230, 230, 230,
    ];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const samples: number[] = [];

    const decodeNibble = (nibble: number, predictor: number, delta: number, sample1: number, sample2: number) => {
        const signed = (nibble & 8) ? (nibble - 16) : nibble;
        let v = ((sample1 * adapt[predictor]) + (sample2 * (64 - adapt[predictor]))) / 64;
        v += signed * delta;
        v = Math.max(-32768, Math.min(32767, Math.round(v)));
        return v | 0;
    };

    if (channels === 1) {
        for (let off = 0; off + blockAlign <= data.length; off += blockAlign) {
            const predictor = data[off];
            let delta = view.getInt16(off + 2, true);
            let s1 = view.getInt16(off + 4, true);
            let s2 = view.getInt16(off + 6, true);
            samples.push(s2, s1);
            let prev = s1;
            let cur = s2;
            for (let i = 8; i < blockAlign; i++) {
                const byte = data[off + i];
                for (const nibble of [byte & 0x0f, (byte >> 4) & 0x0f]) {
                    const next = decodeNibble(nibble, predictor, delta, cur, prev);
                    samples.push(next);
                    prev = cur;
                    cur = next;
                    delta = Math.max(16, Math.min(32767, (adapt[nibble] * delta) >> 8));
                }
            }
        }
    } else {
        // Stereo MS ADPCM: interleaved L/R blocks (7-byte header per channel)
        for (let off = 0; off + blockAlign <= data.length; off += blockAlign) {
            const lPred = data[off];
            const rPred = data[off + 1];
            let lDelta = view.getInt16(off + 2, true);
            let rDelta = view.getInt16(off + 4, true);
            let l1 = view.getInt16(off + 6, true);
            let r1 = view.getInt16(off + 8, true);
            let l2 = view.getInt16(off + 10, true);
            let r2 = view.getInt16(off + 12, true);
            samples.push(l2, r2, l1, r1);
            let lPrev = l1;
            let lCur = l2;
            let rPrev = r1;
            let rCur = r2;
            for (let i = 14; i < blockAlign; i++) {
                const byte = data[off + i];
                const ln = byte & 0x0f;
                const rn = (byte >> 4) & 0x0f;
                const lNext = decodeNibble(ln, lPred, lDelta, lCur, lPrev);
                const rNext = decodeNibble(rn, rPred, rDelta, rCur, rPrev);
                samples.push(lNext, rNext);
                lPrev = lCur;
                lCur = lNext;
                rPrev = rCur;
                rCur = rNext;
                lDelta = Math.max(16, Math.min(32767, (adapt[ln] * lDelta) >> 8));
                rDelta = Math.max(16, Math.min(32767, (adapt[rn] * rDelta) >> 8));
            }
        }
    }

    return Int16Array.from(samples);
}

export function writeAilSoundInfo(
    mem: Uint8Array,
    infoPtr: number,
    fields: {
        format: number;
        dataPtr: number;
        dataLen: number;
        rate: number;
        bits: number;
        channels: number;
        samples: number;
        blockSize: number;
        initialPtr: number;
    },
): void {
    if (!MemoryGuard.isValidRange(mem, infoPtr, AILSOUNDINFO_SIZE)) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setInt32(infoPtr, fields.format, true);
    view.setUint32(infoPtr + 4, fields.dataPtr >>> 0, true);
    view.setUint32(infoPtr + 8, fields.dataLen >>> 0, true);
    view.setUint32(infoPtr + 12, fields.rate >>> 0, true);
    view.setInt32(infoPtr + 16, fields.bits, true);
    view.setInt32(infoPtr + 20, fields.channels, true);
    view.setUint32(infoPtr + 24, fields.samples >>> 0, true);
    view.setUint32(infoPtr + 28, fields.blockSize >>> 0, true);
    view.setUint32(infoPtr + 32, fields.initialPtr >>> 0, true);
}

export function readAilSoundInfo(mem: Uint8Array, infoPtr: number): {
    format: number;
    dataPtr: number;
    dataLen: number;
    rate: number;
    bits: number;
    channels: number;
    samples: number;
    blockSize: number;
    initialPtr: number;
} | null {
    if (!infoPtr || !MemoryGuard.isValidRange(mem, infoPtr, AILSOUNDINFO_SIZE)) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        format: view.getInt32(infoPtr, true),
        dataPtr: view.getUint32(infoPtr + 4, true),
        dataLen: view.getUint32(infoPtr + 8, true),
        rate: view.getUint32(infoPtr + 12, true),
        bits: view.getInt32(infoPtr + 16, true),
        channels: view.getInt32(infoPtr + 20, true),
        samples: view.getUint32(infoPtr + 24, true),
        blockSize: view.getUint32(infoPtr + 28, true),
        initialPtr: view.getUint32(infoPtr + 32, true),
    };
}

export function parseWav(data: Uint8Array): { data: Uint8Array; channels: number; sampleRate: number; bitsPerSample: number; formatTag: number; blockAlign: number } | null {
    const info = scanWavChunks(data);
    if (!info) {
        // Name what we actually saw: "not a WAV" over a buffer whose first bytes are a WAV
        // header means the caller handed us the wrong pointer, and over zeros it means the
        // producer never filled it — two different bugs that read identically without this.
        let head = "";
        for (let i = 0; i < Math.min(12, data.length); i++) head += data[i]!.toString(16).padStart(2, "0");
        Logger.warn(LogCategory.SYSTEM, `MSS32: not a decodable RIFF/WAVE file (${data.length}B, head=${head})`);
        return null;
    }

    if (!info.bitsPerSample) {
        Logger.warn(LogCategory.SYSTEM, "MSS32: WAV missing required chunks");
        return null;
    }

    if (info.formatTag !== 1 && info.formatTag !== 17 && !(info.formatTag === 3 && info.bitsPerSample === 32)) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: Unsupported WAV format tag ${info.formatTag}`);
        return null;
    }

    if (info.formatTag === 17) {
        Logger.log(LogCategory.SYSTEM, `MSS32: IMA ADPCM detected (tag 17) - attempting decode`);
    }

    const audioData = data.slice(info.dataChunkOffset, info.dataChunkOffset + info.dataChunkSize);
    return {
        data: audioData,
        channels: info.channels,
        sampleRate: info.sampleRate,
        bitsPerSample: info.bitsPerSample,
        formatTag: info.formatTag,
        blockAlign: info.blockAlign,
    };
}

/**
 * Convert audio data to Float32Array
 */
export function convertToFloat(data: Uint8Array, channels: number, bitsPerSample: number, formatTag: number, blockAlign: number): Float32Array {
    // Format tag 17 = IMA ADPCM - decode to PCM first
    if (formatTag === 17) {
        return decodeImaAdpcm(data, channels, blockAlign);
    }

    const bytesPerSample = Math.max(1, bitsPerSample >> 3);
    const frameBytes = blockAlign > 0 ? blockAlign : (bytesPerSample * channels);
    if (frameBytes <= 0 || channels <= 0) {
        return new Float32Array(0);
    }
    const frames = Math.floor(data.byteLength / frameBytes);
    const totalSamples = frames * channels;
    const out = new Float32Array(totalSamples);

    // Fast path for 16-bit PCM (most common format)
    if (bitsPerSample === 16 && formatTag !== 3) {
        const isPacked = frameBytes === bytesPerSample * channels;
        if (isPacked && (data.byteOffset & 1) === 0) {
            const int16View = new Int16Array(data.buffer, data.byteOffset, totalSamples);
            const scale = 1 / 32768;
            for (let i = 0; i < totalSamples; i++) {
                out[i] = int16View[i] * scale;
            }
            return out;
        }
        for (let i = 0; i < totalSamples; i++) {
            const frame = (i / channels) | 0;
            const ch = i % channels;
            const byteOffset = frame * frameBytes + ch * 2;
            if (byteOffset + 2 > data.byteLength) break;
            const lo = data[byteOffset];
            const hi = data[byteOffset + 1];
            let sample = lo | (hi << 8);
            if (sample & 0x8000) sample |= 0xFFFF0000;
            out[i] = sample / 32768;
        }
        return out;
    }

    // Fast path for 8-bit PCM (unsigned)
    if (bitsPerSample === 8) {
        const isPacked = frameBytes === channels;
        if (isPacked) {
            const scale = 1 / 128;
            for (let i = 0; i < totalSamples; i++) {
                out[i] = (data[i] - 128) * scale;
            }
            return out;
        }
        for (let i = 0; i < totalSamples; i++) {
            const frame = (i / channels) | 0;
            const ch = i % channels;
            const byteOffset = frame * frameBytes + ch;
            if (byteOffset >= data.byteLength) break;
            out[i] = (data[byteOffset] - 128) / 128;
        }
        return out;
    }

    // Fast path for 32-bit float (IEEE)
    if (formatTag === 3 && bitsPerSample === 32) {
        const isPacked = frameBytes === 4 * channels;
        if (isPacked && (data.byteOffset & 3) === 0) {
            const float32View = new Float32Array(data.buffer, data.byteOffset, totalSamples);
            out.set(float32View);
            return out;
        }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i < totalSamples; i++) {
            const frame = (i / channels) | 0;
            const ch = i % channels;
            const byteOffset = frame * frameBytes + ch * 4;
            if (byteOffset + 4 > data.byteLength) break;
            out[i] = view.getFloat32(byteOffset, true);
        }
        return out;
    }

    // Fast path for 32-bit PCM (signed integer)
    if (bitsPerSample === 32) {
        const isPacked = frameBytes === 4 * channels;
        if (isPacked && (data.byteOffset & 3) === 0) {
            const int32View = new Int32Array(data.buffer, data.byteOffset, totalSamples);
            const scale = 1 / 2147483648;
            for (let i = 0; i < totalSamples; i++) {
                out[i] = int32View[i] * scale;
            }
            return out;
        }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i < totalSamples; i++) {
            const frame = (i / channels) | 0;
            const ch = i % channels;
            const byteOffset = frame * frameBytes + ch * 4;
            if (byteOffset + 4 > data.byteLength) break;
            out[i] = view.getInt32(byteOffset, true) / 2147483648;
        }
        return out;
    }

    // 24-bit PCM
    if (bitsPerSample === 24) {
        for (let i = 0; i < totalSamples; i++) {
            const frame = (i / channels) | 0;
            const ch = i % channels;
            const byteOffset = frame * frameBytes + ch * 3;
            if (byteOffset + 3 > data.byteLength) break;
            const b0 = data[byteOffset];
            const b1 = data[byteOffset + 1];
            const b2 = data[byteOffset + 2];
            let sample = (b2 << 16) | (b1 << 8) | b0;
            if (sample & 0x800000) {
                sample |= 0xff000000;
            }
            out[i] = sample / 8388608;
        }
        return out;
    }

    // Fallback for unknown formats
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let frame = 0; frame < frames; frame++) {
        for (let ch = 0; ch < channels; ch++) {
            const byteOffset = frame * frameBytes + ch * bytesPerSample;
            if (byteOffset + bytesPerSample > data.byteLength) break;

            let value = 0;
            if (bitsPerSample === 16) {
                value = view.getInt16(byteOffset, true) / 32768;
            } else if (bitsPerSample === 8) {
                value = (data[byteOffset] - 128) / 128;
            }

            const idx = frame * channels + ch;
            out[idx] = Math.max(-1, Math.min(1, value));
        }
    }

    return out;
}

/**
 * Decode IMA ADPCM to Float32Array
 */
function decodeImaAdpcm(data: Uint8Array, channels: number, blockAlign: number): Float32Array {
    const stepTable = [
        7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
        50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
        253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
        1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
        3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
        12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
    ];

    const indexTable = [-1, -1, -1, -1, 2, 4, 6, 8];

    if (blockAlign <= 0 || channels <= 0 || data.length === 0) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: Invalid IMA ADPCM parameters - blockAlign=${blockAlign}, channels=${channels}`);
        return new Float32Array(0);
    }

    // Stereo/multichannel WAV IMA ADPCM stores one block for all channels with interleaved
    // 4-byte payload chunks per channel. The mono path below assumes per-channel blocks.
    if (channels > 1) {
        return decodeImaAdpcmInterleaved(data, channels, blockAlign, stepTable);
    }

    const totalBlocks = Math.floor(data.length / blockAlign);
    const samplesPerBlock = 1 + (blockAlign - 4) * 2;
    const blocksPerChannel = Math.floor(totalBlocks / channels);
    const totalSamples = blocksPerChannel * samplesPerBlock * channels;

    if (totalSamples === 0) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: IMA ADPCM would produce 0 samples - blockAlign=${blockAlign}, channels=${channels}, dataLen=${data.length}`);
        return new Float32Array(0);
    }

    const output = new Float32Array(totalSamples);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    for (let block = 0; block < blocksPerChannel; block++) {
        for (let ch = 0; ch < channels; ch++) {
            const blockOffset = (block * channels + ch) * blockAlign;

            if (blockOffset + blockAlign > data.length) {
                Logger.warn(LogCategory.SYSTEM, `MSS32: IMA ADPCM block out of range - block=${block}, ch=${ch}, offset=${blockOffset}`);
                break;
            }

            let predictor = view.getInt16(blockOffset, true);
            let stepIndex = data[blockOffset + 2];

            predictor = Math.max(-32768, Math.min(32767, predictor));
            stepIndex = Math.max(0, Math.min(88, stepIndex));

            const baseIdx = (block * samplesPerBlock) * channels + ch;
            output[baseIdx] = predictor / 32768.0;

            let dataOffset = blockOffset + 4;
            const nibbleCount = (blockAlign - 4) * 2;

            for (let i = 0; i < nibbleCount && dataOffset < blockOffset + blockAlign; i++) {
                const byte = data[dataOffset];
                const nibble = (i & 1) ? (byte >> 4) : (byte & 0x0F);
                if (i & 1) dataOffset++;

                const step = stepTable[stepIndex];
                let diff = step >> 3;

                if (nibble & 4) diff += step;
                if (nibble & 2) diff += step >> 1;
                if (nibble & 1) diff += step >> 2;
                if (nibble & 8) diff = -diff;

                predictor += diff;
                predictor = Math.max(-32768, Math.min(32767, predictor));

                stepIndex += indexTable[nibble & 7];
                stepIndex = Math.max(0, Math.min(88, stepIndex));

                const outIdx = baseIdx + ((i + 1) * channels);
                if (outIdx < output.length) {
                    output[outIdx] = predictor / 32768.0;
                }
            }
        }
    }

    Logger.log(LogCategory.SYSTEM,
        `MSS32: IMA ADPCM decoded ${data.length} bytes → ${totalSamples} samples (${channels} ch, blockAlign=${blockAlign})`);
    return output;
}

function decodeImaAdpcmInterleaved(
    data: Uint8Array,
    channels: number,
    blockAlign: number,
    stepTable: number[],
): Float32Array {
    const headerBytesPerBlock = channels * 4;
    if (blockAlign <= headerBytesPerBlock) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: Invalid interleaved IMA ADPCM blockAlign=${blockAlign}, channels=${channels}`);
        return new Float32Array(0);
    }

    const totalBlocks = Math.floor(data.length / blockAlign);
    const samplesPerBlock = 1 + Math.floor(((blockAlign - headerBytesPerBlock) * 2) / channels);
    const totalFrames = totalBlocks * samplesPerBlock;
    const totalSamples = totalFrames * channels;
    if (totalSamples <= 0) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: Interleaved IMA ADPCM would produce 0 samples - blockAlign=${blockAlign}, channels=${channels}, dataLen=${data.length}`);
        return new Float32Array(0);
    }

    const indexTable = [
        -1, -1, -1, -1, 2, 4, 6, 8,
        -1, -1, -1, -1, 2, 4, 6, 8,
    ];

    const output = new Float32Array(totalSamples);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    for (let block = 0; block < totalBlocks; block++) {
        const blockOffset = block * blockAlign;
        const blockEnd = blockOffset + blockAlign;
        if (blockEnd > data.length) break;

        const frameBase = block * samplesPerBlock;
        const predictors = new Int32Array(channels);
        const stepIndices = new Int32Array(channels);
        const framePos = new Int32Array(channels);

        for (let ch = 0; ch < channels; ch++) {
            const headerOffset = blockOffset + ch * 4;
            let predictor = view.getInt16(headerOffset, true);
            let stepIndex = data[headerOffset + 2];

            predictor = Math.max(-32768, Math.min(32767, predictor));
            stepIndex = Math.max(0, Math.min(88, stepIndex));

            predictors[ch] = predictor;
            stepIndices[ch] = stepIndex;
            framePos[ch] = 1;

            const firstSample = frameBase * channels + ch;
            if (firstSample < output.length) {
                output[firstSample] = predictor / 32768.0;
            }
        }

        let payloadOffset = blockOffset + headerBytesPerBlock;
        while (payloadOffset < blockEnd) {
            const chunkBytes = channels * 4;
            const chunkEnd = Math.min(blockEnd, payloadOffset + chunkBytes);

            // Layout: 4-byte ADPCM packet per channel, interleaved by channel.
            for (let ch = 0; ch < channels; ch++) {
                let predictor = predictors[ch];
                let stepIndex = stepIndices[ch];
                const channelChunkStart = payloadOffset + ch * 4;
                if (channelChunkStart >= chunkEnd) {
                    continue;
                }

                for (let byteInChunk = 0; byteInChunk < 4; byteInChunk++) {
                    const byteOffset = channelChunkStart + byteInChunk;
                    if (byteOffset >= chunkEnd) {
                        break;
                    }

                    const byte = data[byteOffset];
                    const low = byte & 0x0F;
                    const high = (byte >>> 4) & 0x0F;

                    for (let nibblePass = 0; nibblePass < 2; nibblePass++) {
                        const nibble = nibblePass === 0 ? low : high;
                        const step = stepTable[stepIndex];
                        let diff = step >> 3;

                        if (nibble & 4) diff += step;
                        if (nibble & 2) diff += step >> 1;
                        if (nibble & 1) diff += step >> 2;
                        if (nibble & 8) diff = -diff;

                        predictor += diff;
                        predictor = Math.max(-32768, Math.min(32767, predictor));

                        stepIndex += indexTable[nibble];
                        stepIndex = Math.max(0, Math.min(88, stepIndex));

                        const frame = framePos[ch];
                        if (frame < samplesPerBlock) {
                            const outIdx = (frameBase + frame) * channels + ch;
                            if (outIdx < output.length) {
                                output[outIdx] = predictor / 32768.0;
                            }
                            framePos[ch] = frame + 1;
                        }
                    }
                }

                predictors[ch] = predictor;
                stepIndices[ch] = stepIndex;
            }

            payloadOffset += chunkBytes;
        }
    }

    Logger.log(LogCategory.SYSTEM,
        `MSS32: IMA ADPCM decoded ${data.length} bytes -> ${totalSamples} samples (${channels} ch, blockAlign=${blockAlign}, interleaved)`);
    return output;
}
