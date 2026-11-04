import { convertToFloat } from "./audio-decode";

/** A raw PCM sound image decoded once for one sample type. Shared, never mutated. */
export interface RawSampleImage {
    data: Uint8Array;
    decoded: Float32Array;
    pcmBytes: number;
}

interface Entry { image: RawSampleImage; check: number; bytes: number }

const CACHE_LIMIT_BYTES = 96 << 20;
const SPARSE_POINTS = 1024;
const cache = new Map<string, Entry>();
const dataByImage = new Map<string, { data: Uint8Array; check: number }>();
let cachedBytes = 0;
let hits = 0;
let misses = 0;

/**
 * Content fingerprint: the length, ~1024 evenly spaced bytes and the last 64 bytes. Sound
 * banks are static, and a sound loaded over an old one at the same address changes the
 * sampled bytes, so this detects a rewrite without hashing megabytes per AIL call.
 */
export function rawImageChecksum(src: Uint8Array, offset: number, length: number): number {
    let h = (0x811c9dc5 ^ length) >>> 0;
    const step = Math.max(1, Math.floor(length / SPARSE_POINTS));
    for (let i = 0; i < length; i += step) h = Math.imul(h ^ src[offset + i]!, 0x01000193);
    for (let i = Math.max(0, length - 64); i < length; i++) h = Math.imul(h ^ src[offset + i]!, 0x01000193);
    return h >>> 0;
}

/**
 * Decode `length` bytes of raw PCM at guest `address` (read from `src` at `offset`) as
 * `channels` × `bits`. Repeat calls for unchanged bytes return the same image without
 * copying or converting again; only the first call per (address, length, type) and per
 * content change pays for the copy and the float conversion.
 */
export function decodeRawSampleImage(
    address: number, src: Uint8Array, offset: number, length: number, channels: number, bits: number,
): RawSampleImage {
    const check = rawImageChecksum(src, offset, length);
    const key = `${address}:${length}:${channels}:${bits}`;
    const hit = cache.get(key);
    if (hit && hit.check === check) {
        cache.delete(key);
        cache.set(key, hit);
        hits++;
        return hit.image;
    }
    misses++;
    if (hit) { cache.delete(key); cachedBytes -= hit.bytes; }
    const dataKey = `${address}:${length}`;
    const known = dataByImage.get(dataKey);
    const data = known && known.check === check ? known.data : src.slice(offset, offset + length);
    dataByImage.set(dataKey, { data, check });
    const blockAlign = channels * Math.max(1, bits >> 3);
    const image: RawSampleImage = {
        data,
        decoded: convertToFloat(data, channels, bits, 1, blockAlign),
        pcmBytes: length - (length % blockAlign),
    };
    const bytes = image.decoded.byteLength + data.byteLength;
    cache.set(key, { image, check, bytes });
    cachedBytes += bytes;
    for (const [k, e] of cache) {
        if (cachedBytes <= CACHE_LIMIT_BYTES || k === key) break;
        cache.delete(k);
        cachedBytes -= e.bytes;
    }
    if (dataByImage.size > 4096) dataByImage.clear();
    return image;
}

export function rawSampleCacheStats(): { hits: number; misses: number; entries: number; bytes: number } {
    return { hits, misses, entries: cache.size, bytes: cachedBytes };
}

export function resetRawSampleCache(): void {
    cache.clear();
    dataByImage.clear();
    cachedBytes = 0;
    hits = 0;
    misses = 0;
}
