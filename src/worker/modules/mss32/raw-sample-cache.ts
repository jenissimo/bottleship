import { convertToFloat } from "./audio-decode";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";

/** A raw PCM sound image decoded once for one sample type. Shared, never mutated. */
export interface RawSampleImage {
    data: Uint8Array;
    decoded: Float32Array;
    pcmBytes: number;
}

/** How the voice's AIL_set_sample_type says the image is to be read. */
export interface RawSampleType {
    channels: number;
    bits: number;
    /** 8-bit data is signed (DIG_PCM_SIGN); MSS 8-bit data is unsigned otherwise. */
    signed8: boolean;
    /** DIG_F_ADPCM_*: not decoded here; the image plays as silence. */
    adpcm: boolean;
}

/**
 * One guest sound image (address, length): its bytes as last seen and every decode made
 * from them. The bytes AND the decodes count against the budget and leave together.
 */
interface ImageEntry {
    data: Uint8Array;
    decodes: Map<string, RawSampleImage>;
    bytes: number;
}

const CACHE_LIMIT_BYTES = 96 << 20;
// @transient(decode cache; every hit compares the image bytes, a miss decodes again)
const images = new Map<string, ImageEntry>();
// @transient(size of the decode cache)
let cachedBytes = 0;
// @transient(diagnostic counter)
let hits = 0;
// @transient(diagnostic counter)
let misses = 0;

/**
 * Exact comparison of the guest bytes with the cached copy. A sparse fingerprint misses a
 * rewrite between its sample points and then replays a stale sound, so the whole image is
 * compared, word-wide where alignment allows. That is still far cheaper than the copy and
 * float conversion the cache saves.
 */
function sameBytes(src: Uint8Array, offset: number, data: Uint8Array): boolean {
    const length = data.length;
    if (offset < 0 || offset + length > src.length) return false;
    if (src.buffer === data.buffer && src.byteOffset + offset === data.byteOffset) return true;
    const a = src.byteOffset + offset;
    const b = data.byteOffset;
    if (((a | b) & 3) === 0) {
        const words = length >>> 2;
        const x = new Uint32Array(src.buffer, a, words);
        const y = new Uint32Array(data.buffer, b, words);
        for (let i = 0; i < words; i++) if (x[i] !== y[i]) return false;
        for (let i = words << 2; i < length; i++) if (src[offset + i] !== data[i]) return false;
        return true;
    }
    for (let i = 0; i < length; i++) if (src[offset + i] !== data[i]) return false;
    return true;
}

function typeKey(t: RawSampleType): string {
    return `${t.channels}:${t.bits}:${t.signed8 ? 1 : 0}:${t.adpcm ? 1 : 0}`;
}

function decode(data: Uint8Array, t: RawSampleType): RawSampleImage {
    const bytesPerSample = Math.max(1, t.bits >> 3);
    const blockAlign = t.channels * bytesPerSample;
    const pcmBytes = data.length - (data.length % blockAlign);
    if (t.adpcm) {
        // Silence spanning the image as the voice's byte model counts it (position and
        // SMP_DONE stay consistent); never the ADPCM nibbles read as PCM, which is noise.
        return { data, decoded: new Float32Array(pcmBytes / bytesPerSample), pcmBytes };
    }
    let pcm = data;
    if (t.bits === 8 && t.signed8) {
        // convertToFloat reads 8-bit PCM as unsigned: flip the sign bit of a private copy.
        pcm = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) pcm[i] = data[i]! ^ 0x80;
    }
    return { data, decoded: convertToFloat(pcm, t.channels, t.bits, 1, blockAlign), pcmBytes };
}

function evict(keep: string): void {
    for (const [k, e] of images) {
        if (cachedBytes <= CACHE_LIMIT_BYTES) return;
        if (k === keep) continue;
        images.delete(k);
        cachedBytes -= e.bytes;
    }
}

/**
 * Decode `length` bytes of raw PCM at guest `address` (read from `src` at `offset`) with
 * the voice's type. Repeat calls for unchanged bytes return the same image without copying
 * or converting again; any change to the bytes discards every decode of that image.
 */
export function decodeRawSampleImage(
    address: number, src: Uint8Array, offset: number, length: number, type: RawSampleType,
): RawSampleImage {
    // Word views and a synchronous scan: no guest code runs while the plain view is held.
    src = toPlainGuestMemory(src);
    const imageKey = `${address}:${length}`;
    const tKey = typeKey(type);
    let entry = images.get(imageKey);
    if (entry && !sameBytes(src, offset, entry.data)) {
        images.delete(imageKey);
        cachedBytes -= entry.bytes;
        entry = undefined;
    }
    if (entry) {
        images.delete(imageKey);
        images.set(imageKey, entry);
        const hit = entry.decodes.get(tKey);
        if (hit) { hits++; return hit; }
    } else {
        const data = src.slice(offset, offset + length);
        entry = { data, decodes: new Map(), bytes: data.byteLength };
        images.set(imageKey, entry);
        cachedBytes += entry.bytes;
    }
    misses++;
    const image = decode(entry.data, type);
    entry.decodes.set(tKey, image);
    entry.bytes += image.decoded.byteLength;
    cachedBytes += image.decoded.byteLength;
    evict(imageKey);
    return image;
}

export function rawSampleCacheStats(): { hits: number; misses: number; entries: number; bytes: number } {
    return { hits, misses, entries: images.size, bytes: cachedBytes };
}

/** What the cache actually holds, recomputed from the entries (budget accounting check). */
export function rawSampleCacheHeldBytes(): number {
    let total = 0;
    for (const e of images.values()) {
        total += e.data.byteLength;
        for (const d of e.decodes.values()) total += d.decoded.byteLength;
    }
    return total;
}

export const RAW_SAMPLE_CACHE_LIMIT_BYTES = CACHE_LIMIT_BYTES;

export function resetRawSampleCache(): void {
    images.clear();
    cachedBytes = 0;
    hits = 0;
    misses = 0;
}
