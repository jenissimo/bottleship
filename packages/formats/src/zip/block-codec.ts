import { Deflate, inflateRaw } from "pako";

const FINAL_EMPTY_FIXED_BLOCK = 0x03;
const Z_FULL_FLUSH = 3;

export function inflateRawBlock(src: Uint8Array, dst: Uint8Array): number {
    const s = new Uint8Array(src.length + 2);
    s.set(src);
    s[src.length] = FINAL_EMPTY_FIXED_BLOCK;
    let out: Uint8Array | undefined;
    try {
        out = inflateRaw(s);
    } catch (e) {
        throw new Error(`block inflate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!out || out.length > dst.length) throw new Error(`block inflate: got ${out?.length ?? 0} bytes, room for ${dst.length}`);
    dst.set(out);
    return out.length;
}

export function deflateRawBlock(src: Uint8Array, level: number): Uint8Array {
    const d = new Deflate({ raw: true, level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 });
    const chunks: Uint8Array[] = [];
    d.onData = (chunk) => { chunks.push(chunk as Uint8Array); };
    if (!d.push(src, Z_FULL_FLUSH) || d.err) throw new Error(`block deflate failed: ${d.msg}`);
    if (chunks.length === 1) return chunks[0];
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
}

export const BLOCK_STREAM_END = new Uint8Array([FINAL_EMPTY_FIXED_BLOCK, 0x00]);
