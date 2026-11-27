import { crc32 } from "../wgb/zip-build";

export const WGB_AUDIO_INDEX_ENTRY = "wgb-audio.idx";
export const WGB_AUDIO_INDEX_VERSION = 1;
export const WGB_AUDIO_METHOD = 0x5741;
export const WGB_AUDIO_CODEC_VORBIS = 1;

const MAGIC = 0x41424757;
const HEADER_BYTES = 16;
const ROW_FIXED_BYTES = 8 + 8 + 8 + 4 + 1 + 2 + 2 + 4 + 8 + 4 + 4 + 4 + 4 + 4 + 4 + 4;

export interface ZipAudioMap {
    codec: number;
    channels: number;
    bitsPerSample: number;
    sampleRate: number;
    totalFrames: number;
    lead: number;
    prefixLen: number;
    suffixLen: number;
    idLen: number;
    commentLen: number;
    setupLen: number;
    chunkStart: Uint32Array;
    chunkEnd: Uint32Array;
    rawStart: Float64Array;
}

export interface AudioIndexRow extends Omit<ZipAudioMap, "chunkStart" | "chunkEnd" | "rawStart"> {
    name: string;
    localHeaderOffset: number;
    uncompressedSize: number;
    compressedSize: number;
    crc32: number;
    chunkStart: ArrayLike<number>;
    chunkEnd: ArrayLike<number>;
    rawStart: ArrayLike<number>;
}

interface AudioIndexTarget {
    name: string;
    compression: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    crc32?: number;
    audio?: ZipAudioMap;
}

export interface WgbAudioIndexRef {
    member: string;
    version: number;
}

export function audioBlockAlign(map: Pick<ZipAudioMap, "channels" | "bitsPerSample">): number {
    return map.channels * (map.bitsPerSample >> 3);
}

export function audioHeadBytes(map: Pick<ZipAudioMap, "prefixLen" | "suffixLen" | "idLen" | "commentLen" | "setupLen">): number {
    return map.prefixLen + map.suffixLen + map.idLen + map.commentLen + map.setupLen;
}

export function decodeAudioIndex(data: Uint8Array): AudioIndexRow[] {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < HEADER_BYTES || v.getUint32(0, true) !== MAGIC) throw new Error("audio index: bad magic");
    const version = v.getUint16(4, true);
    if (version !== WGB_AUDIO_INDEX_VERSION) throw new Error(`audio index: version ${version}, this engine reads v${WGB_AUDIO_INDEX_VERSION}`);
    if (crc32(data.subarray(HEADER_BYTES)) !== v.getUint32(12, true)) throw new Error("audio index: CRC mismatch");
    const count = v.getUint32(8, true);
    const dec = new TextDecoder("utf-8");
    const rows: AudioIndexRow[] = [];
    let p = HEADER_BYTES;
    const need = (n: number) => { if (p + n > data.byteLength) throw new Error("audio index: truncated"); };
    for (let i = 0; i < count; i++) {
        need(2);
        const nameLen = v.getUint16(p, true); p += 2;
        need(nameLen + ROW_FIXED_BYTES);
        const name = dec.decode(data.subarray(p, p + nameLen)); p += nameLen;
        const localHeaderOffset = Number(v.getBigUint64(p, true)); p += 8;
        const uncompressedSize = Number(v.getBigUint64(p, true)); p += 8;
        const compressedSize = Number(v.getBigUint64(p, true)); p += 8;
        const crc = v.getUint32(p, true); p += 4;
        const codec = data[p++];
        const channels = v.getUint16(p, true); p += 2;
        const bitsPerSample = v.getUint16(p, true); p += 2;
        const sampleRate = v.getUint32(p, true); p += 4;
        const totalFrames = Number(v.getBigUint64(p, true)); p += 8;
        const lead = v.getUint32(p, true); p += 4;
        const prefixLen = v.getUint32(p, true); p += 4;
        const suffixLen = v.getUint32(p, true); p += 4;
        const idLen = v.getUint32(p, true); p += 4;
        const commentLen = v.getUint32(p, true); p += 4;
        const setupLen = v.getUint32(p, true); p += 4;
        const n = v.getUint32(p, true); p += 4;
        need(12 * n + 4);
        const chunkStart = new Uint32Array(n);
        const chunkEnd = new Uint32Array(n);
        const rawStart = new Float64Array(n + 1);
        for (let c = 0; c < n; c++) {
            chunkStart[c] = v.getUint32(p, true);
            chunkEnd[c] = v.getUint32(p + 4, true);
            rawStart[c] = v.getUint32(p + 8, true);
            p += 12;
        }
        rawStart[n] = v.getUint32(p, true); p += 4;
        rows.push({
            name, localHeaderOffset, uncompressedSize, compressedSize, crc32: crc, codec, channels, bitsPerSample, sampleRate,
            totalFrames, lead, prefixLen, suffixLen, idLen, commentLen, setupLen, chunkStart, chunkEnd, rawStart,
        });
    }
    if (p !== data.byteLength) throw new Error("audio index: trailing bytes");
    return rows;
}

function validAudioRow(r: AudioIndexRow): boolean {
    if (r.codec !== WGB_AUDIO_CODEC_VORBIS || r.bitsPerSample !== 16 || r.channels < 1 || r.channels > 16 || r.sampleRate <= 0) return false;
    if (r.idLen <= 0 || r.commentLen <= 0 || r.setupLen <= 0) return false;
    if (r.prefixLen + r.totalFrames * audioBlockAlign(r) + r.suffixLen !== r.uncompressedSize) return false;
    const n = r.chunkStart.length;
    if (n === 0 || r.chunkEnd.length !== n || r.rawStart.length !== n + 1) return false;
    if (r.chunkStart[0] !== audioHeadBytes(r) || r.chunkEnd[n - 1] !== r.compressedSize) return false;
    if (r.rawStart[0] !== 0 || r.rawStart[n] - r.lead < r.totalFrames) return false;
    for (let c = 0; c < n; c++) {
        if (r.chunkEnd[c] <= r.chunkStart[c] || r.rawStart[c + 1] < r.rawStart[c]) return false;
        if (c > 0 && (r.chunkStart[c] <= r.chunkStart[c - 1] || r.chunkStart[c] >= r.chunkEnd[c - 1] || r.chunkEnd[c] <= r.chunkEnd[c - 1])) return false;
    }
    return true;
}

export function applyAudioIndex(rows: readonly AudioIndexRow[], lookup: (name: string) => AudioIndexTarget | undefined): number {
    let applied = 0;
    for (const r of rows) {
        const e = lookup(r.name);
        if (!e || e.compression !== WGB_AUDIO_METHOD || e.localHeaderOffset !== r.localHeaderOffset) continue;
        if (e.uncompressedSize !== r.uncompressedSize || e.compressedSize !== r.compressedSize) continue;
        if (e.crc32 !== undefined && e.crc32 !== r.crc32) continue;
        if (!validAudioRow(r)) continue;
        e.audio = {
            codec: r.codec, channels: r.channels, bitsPerSample: r.bitsPerSample, sampleRate: r.sampleRate,
            totalFrames: r.totalFrames, lead: r.lead, prefixLen: r.prefixLen, suffixLen: r.suffixLen,
            idLen: r.idLen, commentLen: r.commentLen, setupLen: r.setupLen,
            chunkStart: Uint32Array.from(r.chunkStart), chunkEnd: Uint32Array.from(r.chunkEnd), rawStart: Float64Array.from(r.rawStart),
        };
        applied++;
    }
    return applied;
}

export function audioChunkRange(map: ZipAudioMap, c: number): { first: number; last: number } {
    const first = Math.max(0, map.rawStart[c] - map.lead);
    const last = Math.min(map.totalFrames, map.rawStart[c + 1] - map.lead);
    return { first, last: Math.max(first, last) };
}

export function audioChunkAt(map: ZipAudioMap, frame: number): number {
    const target = frame + map.lead;
    let lo = 0, hi = map.chunkStart.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (map.rawStart[mid] <= target) lo = mid; else hi = mid - 1;
    }
    while (lo < map.chunkStart.length - 1 && map.rawStart[lo + 1] <= target) lo++;
    return lo;
}

export function audioUnitEnd(map: ZipAudioMap, position: number, length: number): number {
    const ba = audioBlockAlign(map);
    const pcmEnd = map.prefixLen + map.totalFrames * ba;
    const last = position + Math.max(1, length) - 1;
    if (last < map.prefixLen || last >= pcmEnd) return Math.max(position + length, last + 1);
    const c = audioChunkAt(map, Math.floor((last - map.prefixLen) / ba));
    return map.prefixLen + audioChunkRange(map, c).last * ba;
}
