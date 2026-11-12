import { crc32 } from "../wgb/zip-build";

export const WGB_BLOCK_INDEX_ENTRY = "wgb-blocks.idx";
export const WGB_BLOCK_INDEX_VERSION = 1;

const MAGIC = 0x4b424757;
const HEADER_BYTES = 16;
const ROW_FIXED_BYTES = 8 + 8 + 8 + 4 + 1 + 4;
const MIN_SHIFT = 12;
const BLOCK_STREAM_END_BYTES = 2;
const MAX_SHIFT = 24;

export interface ZipBlockMap {
    shift: number;
    offsets: Float64Array;
}

export interface BlockIndexRow {
    name: string;
    localHeaderOffset: number;
    uncompressedSize: number;
    compressedSize: number;
    crc32: number;
    shift: number;
    blockLengths: ArrayLike<number>;
}

export interface BlockIndexTarget {
    name: string;
    compression: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    crc32?: number;
    blocks?: ZipBlockMap;
}

export interface WgbBlockIndexRef {
    member: string;
    version: number;
}

export function encodeBlockIndex(rows: readonly BlockIndexRow[]): Uint8Array {
    const enc = new TextEncoder();
    const names = rows.map(r => enc.encode(r.name));
    let size = HEADER_BYTES;
    for (let i = 0; i < rows.length; i++) size += 2 + names[i].length + ROW_FIXED_BYTES + 4 * rows[i].blockLengths.length;
    const out = new Uint8Array(size);
    const v = new DataView(out.buffer);
    v.setUint32(0, MAGIC, true);
    v.setUint16(4, WGB_BLOCK_INDEX_VERSION, true);
    v.setUint16(6, 0, true);
    v.setUint32(8, rows.length, true);
    let p = HEADER_BYTES;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        v.setUint16(p, names[i].length, true); p += 2;
        out.set(names[i], p); p += names[i].length;
        v.setBigUint64(p, BigInt(r.localHeaderOffset), true); p += 8;
        v.setBigUint64(p, BigInt(r.uncompressedSize), true); p += 8;
        v.setBigUint64(p, BigInt(r.compressedSize), true); p += 8;
        v.setUint32(p, r.crc32 >>> 0, true); p += 4;
        out[p++] = r.shift;
        v.setUint32(p, r.blockLengths.length, true); p += 4;
        for (let b = 0; b < r.blockLengths.length; b++) { v.setUint32(p, r.blockLengths[b], true); p += 4; }
    }
    v.setUint32(12, crc32(out.subarray(HEADER_BYTES)), true);
    return out;
}

export function decodeBlockIndex(data: Uint8Array): BlockIndexRow[] {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < HEADER_BYTES || v.getUint32(0, true) !== MAGIC) throw new Error("block index: bad magic");
    const version = v.getUint16(4, true);
    if (version !== WGB_BLOCK_INDEX_VERSION) throw new Error(`block index: version ${version}, this engine reads v${WGB_BLOCK_INDEX_VERSION}`);
    if (crc32(data.subarray(HEADER_BYTES)) !== v.getUint32(12, true)) throw new Error("block index: CRC mismatch");
    const count = v.getUint32(8, true);
    const dec = new TextDecoder("utf-8");
    const rows: BlockIndexRow[] = [];
    let p = HEADER_BYTES;
    const need = (n: number) => { if (p + n > data.byteLength) throw new Error("block index: truncated"); };
    for (let i = 0; i < count; i++) {
        need(2);
        const nameLen = v.getUint16(p, true); p += 2;
        need(nameLen + ROW_FIXED_BYTES);
        const name = dec.decode(data.subarray(p, p + nameLen)); p += nameLen;
        const localHeaderOffset = Number(v.getBigUint64(p, true)); p += 8;
        const uncompressedSize = Number(v.getBigUint64(p, true)); p += 8;
        const compressedSize = Number(v.getBigUint64(p, true)); p += 8;
        const crc = v.getUint32(p, true); p += 4;
        const shift = data[p++];
        const n = v.getUint32(p, true); p += 4;
        need(4 * n);
        const blockLengths = new Uint32Array(n);
        for (let b = 0; b < n; b++) { blockLengths[b] = v.getUint32(p, true); p += 4; }
        rows.push({ name, localHeaderOffset, uncompressedSize, compressedSize, crc32: crc, shift, blockLengths });
    }
    if (p !== data.byteLength) throw new Error("block index: trailing bytes");
    return rows;
}

export function applyBlockIndex(rows: readonly BlockIndexRow[], lookup: (name: string) => BlockIndexTarget | undefined): number {
    let applied = 0;
    for (const r of rows) {
        const e = lookup(r.name);
        if (!e || e.compression !== 8 || e.localHeaderOffset !== r.localHeaderOffset) continue;
        if (e.uncompressedSize !== r.uncompressedSize || e.compressedSize !== r.compressedSize) continue;
        if (e.crc32 !== undefined && e.crc32 !== r.crc32) continue;
        if (r.shift < MIN_SHIFT || r.shift > MAX_SHIFT) continue;
        const blockSize = 2 ** r.shift;
        if (r.blockLengths.length !== Math.ceil(r.uncompressedSize / blockSize)) continue;
        const offsets = new Float64Array(r.blockLengths.length + 1);
        let ok = true;
        for (let b = 0; b < r.blockLengths.length; b++) {
            if (r.blockLengths[b] === 0) { ok = false; break; }
            offsets[b + 1] = offsets[b] + r.blockLengths[b];
        }
        if (!ok || offsets[r.blockLengths.length] + BLOCK_STREAM_END_BYTES !== r.compressedSize) continue;
        e.blocks = { shift: r.shift, offsets };
        applied++;
    }
    return applied;
}
