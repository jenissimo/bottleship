/**
 * Unreal Engine 1 compressed packages (`.uz`) — what `ucc compress` writes and `ucc decompress`
 * reads. Unreal Tournament ships its maps this way on the GOTY disc and its installer expands
 * them; a redirect server serves the same files.
 *
 * Layout: INT32 signature (1234 from early Unreal builds, 5678 from Unreal Tournament 4xx; the
 * body is identical), the original file name as an FString, then the payload run
 * through FCodecFull — RLE → BWT → MTF → RLE → Huffman on encode, so decode is the reverse.
 * Each stage consumes the WHOLE output of the previous one (no framing between stages); only
 * the BWT stage is blocked, at 256 KiB. All integers are little-endian.
 *
 * UT2003/2004 `.uz2` is a different, zlib-chunked format with no signature and is not read here.
 */

export const UZ1_SIGNATURE = 1234;
export const UZ_UT_SIGNATURE = 5678;
const RLE_LEAD = 5;
const BWT_MAX_BUFFER = 0x40000;

export class UzError extends Error {}

export interface UzFile {
    /** The name `ucc compress` recorded, e.g. "DM-Deck16][.unr". */
    readonly originalName: string;
    readonly data: Uint8Array;
}

/** A growable byte sink; the stage sizes are not known up front. */
class ByteSink {
    private buf: Uint8Array;
    length = 0;
    constructor(hint: number) { this.buf = new Uint8Array(Math.max(16, hint)); }
    private grow(min: number): void {
        let n = this.buf.length * 2;
        while (n < min) n *= 2;
        const next = new Uint8Array(n);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
    }
    push(b: number): void {
        if (this.length === this.buf.length) this.grow(this.length + 1);
        this.buf[this.length++] = b;
    }
    pushRun(b: number, n: number): void {
        if (n <= 0) return;
        if (this.length + n > this.buf.length) this.grow(this.length + n);
        this.buf.fill(b, this.length, this.length + n);
        this.length += n;
    }
    pushBytes(src: Uint8Array): void {
        if (this.length + src.length > this.buf.length) this.grow(this.length + src.length);
        this.buf.set(src, this.length);
        this.length += src.length;
    }
    bytes(): Uint8Array { return this.buf.subarray(0, this.length); }
}

const readI32 = (b: Uint8Array, at: number): number => {
    if (at + 4 > b.length) throw new UzError(`truncated INT32 at ${at}`);
    return b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24);
};

/** FArchive compact index (AR_INDEX): sign+continue+6 bits, then continue+7 bits per byte. */
function readCompactIndex(b: Uint8Array, at: number): { value: number; next: number } {
    let p = at;
    if (p >= b.length) throw new UzError("truncated compact index");
    const b0 = b[p++]!;
    let v = b0 & 0x3f;
    if (b0 & 0x40) {
        let shift = 6;
        for (let i = 0; i < 4; i++) {
            if (p >= b.length) throw new UzError("truncated compact index");
            const bx = b[p++]!;
            v |= (bx & 0x7f) << shift;
            shift += 7;
            if (!(bx & 0x80)) break;
        }
    }
    return { value: b0 & 0x80 ? -v : v, next: p };
}

/** FString: compact length counting the NUL; negative = UTF-16LE. */
function readFString(b: Uint8Array, at: number): { value: string; next: number } {
    const { value: len, next } = readCompactIndex(b, at);
    if (len === 0) return { value: "", next };
    const unicode = len < 0;
    const chars = Math.abs(len);
    const bytes = unicode ? chars * 2 : chars;
    if (next + bytes > b.length) throw new UzError("truncated file name");
    const raw = b.subarray(next, next + bytes - (unicode ? 2 : 1));
    const value = new TextDecoder(unicode ? "utf-16le" : "latin1").decode(raw);
    return { value, next: next + bytes };
}

/** FCodecHuffman: INT32 symbol count, then an LSB-first bitstream: the tree, then the codes. */
export function huffmanDecode(input: Uint8Array): Uint8Array {
    let total = readI32(input, 0);
    if (total < 0) throw new UzError(`huffman: negative length ${total}`);
    const bits = input.subarray(4);
    const nbits = bits.length * 8;
    let pos = 0;
    const bit = (): number => {
        if (pos >= nbits) throw new UzError("huffman: bitstream exhausted");
        const v = (bits[pos >> 3]! >> (pos & 7)) & 1;
        pos++;
        return v;
    };
    // Flat tree: child0/child1 per internal node, symbol per leaf (-1 = internal).
    const sym: number[] = [];
    const c0: number[] = [];
    const c1: number[] = [];
    const readNode = (depth: number): number => {
        if (depth > 300) throw new UzError("huffman: tree too deep");
        const id = sym.length;
        sym.push(-1); c0.push(-1); c1.push(-1);
        if (bit()) {
            c0[id] = readNode(depth + 1);
            c1[id] = readNode(depth + 1);
        } else {
            let ch = 0;
            for (let i = 0; i < 8; i++) ch |= bit() << i;
            sym[id] = ch;
        }
        return id;
    };
    readNode(0);
    const out = new Uint8Array(total);
    let o = 0;
    while (total-- > 0) {
        let n = 0;
        while (sym[n] === -1) n = bit() ? c1[n]! : c0[n]!;
        out[o++] = sym[n]!;
    }
    return out;
}

/** FCodecRLE: a run of RLE_LEAD equal bytes is followed by the full run length. */
export function rleDecode(input: Uint8Array): Uint8Array {
    const out = new ByteSink(input.length * 2);
    let count = 0;
    let prev = 0;
    for (let i = 0; i < input.length; i++) {
        const b = input[i]!;
        out.push(b);
        if (b !== prev) {
            prev = b;
            count = 1;
        } else if (++count === RLE_LEAD) {
            if (++i >= input.length) throw new UzError("rle: run length missing");
            const c = input[i]!;
            if (c < 2) throw new UzError(`rle: bad run length ${c}`);
            out.pushRun(b, c - RLE_LEAD);
            count = 0;
        }
    }
    return out.bytes();
}

/** FCodecMTF: move-to-front over a 256-entry list starting as the identity. */
export function mtfDecode(input: Uint8Array): Uint8Array {
    const list = new Uint8Array(256);
    for (let i = 0; i < 256; i++) list[i] = i;
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const idx = input[i]!;
        const c = list[idx]!;
        out[i] = c;
        list.copyWithin(1, 0, idx);
        list[0] = c;
    }
    return out;
}

/**
 * FCodecBWT: blocks of (INT32 length, INT32 first, INT32 last, length+1 bytes). Row `last` is
 * the end-of-block sentinel, which sorts after every byte value.
 */
export function bwtDecode(input: Uint8Array): Uint8Array {
    const out = new ByteSink(input.length);
    const count = new Int32Array(257);
    const running = new Int32Array(257);
    const temp = new Int32Array(BWT_MAX_BUFFER + 1);
    let p = 0;
    while (p < input.length) {
        const len = readI32(input, p);
        const first = readI32(input, p + 4);
        const last = readI32(input, p + 8);
        p += 12;
        const n = len + 1;
        if (len < 0 || n > BWT_MAX_BUFFER + 1 || p + n > input.length) throw new UzError(`bwt: bad block length ${len}`);
        if (first < 0 || first >= n || last < 0 || last >= n) throw new UzError("bwt: bad block index");
        const block = input.subarray(p, p + n);
        p += n;
        count.fill(0);
        for (let i = 0; i < n; i++) count[i !== last ? block[i]! : 256]!++;
        let sum = 0;
        for (let i = 0; i < 257; i++) {
            running[i] = sum;
            sum += count[i]!;
            count[i] = 0;
        }
        for (let i = 0; i < n; i++) {
            const idx = i !== last ? block[i]! : 256;
            temp[running[idx]! + count[idx]!++] = i;
        }
        const start = out.length;
        out.pushRun(0, len);
        const dst = out.bytes();
        for (let i = first, j = 0; j < len; i = temp[i]!, j++) dst[start + j] = block[i]!;
    }
    return out.bytes();
}

export function isUz(bytes: Uint8Array): boolean {
    if (bytes.length < 5) return false;
    const sig = readI32(bytes, 0);
    return sig === UZ1_SIGNATURE || sig === UZ_UT_SIGNATURE;
}

export function decodeUz(bytes: Uint8Array): UzFile {
    if (!isUz(bytes)) throw new UzError(`not a .uz file (signature ${bytes.length >= 4 ? readI32(bytes, 0) : "truncated"})`);
    const name = readFString(bytes, 4);
    const payload = bytes.subarray(name.next);
    const data = rleDecode(bwtDecode(mtfDecode(rleDecode(huffmanDecode(payload)))));
    return { originalName: name.value, data };
}

// ---------------------------------------------------------------------------
// Encoder — the inverse of every stage, kept so the decoder can be tested without game data.
// ---------------------------------------------------------------------------

export function rleEncode(input: Uint8Array): Uint8Array {
    const out = new ByteSink(input.length + 16);
    const emit = (ch: number, n: number): void => {
        out.pushRun(ch, Math.min(n, RLE_LEAD));
        if (n >= RLE_LEAD) out.push(n);
    };
    let prev = 0;
    let n = 0;
    for (let i = 0; i < input.length; i++) {
        const b = input[i]!;
        if (b !== prev || n === 255) {
            emit(prev, n);
            prev = b;
            n = 0;
        }
        n++;
    }
    emit(prev, n);
    return out.bytes();
}

export function mtfEncode(input: Uint8Array): Uint8Array {
    const list = new Uint8Array(256);
    for (let i = 0; i < 256; i++) list[i] = i;
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const c = input[i]!;
        const idx = list.indexOf(c);
        out[i] = idx;
        list.copyWithin(1, 0, idx);
        list[0] = c;
    }
    return out;
}

/** Suffix order with a shorter (sentinel-terminated) suffix sorting after a longer equal one. */
export function bwtEncode(input: Uint8Array): Uint8Array {
    const out = new ByteSink(input.length + 64);
    const i32 = (v: number): void => { out.push(v & 0xff); out.push((v >> 8) & 0xff); out.push((v >> 16) & 0xff); out.push((v >>> 24) & 0xff); };
    for (let base = 0; base < input.length || (base === 0 && input.length === 0); base += BWT_MAX_BUFFER) {
        if (input.length === 0) break;
        const buf = input.subarray(base, Math.min(input.length, base + BWT_MAX_BUFFER));
        const len = buf.length;
        const pos = Array.from({ length: len + 1 }, (_, i) => i);
        pos.sort((a, b) => {
            for (let k = 0, n = len - Math.max(a, b); k < n; k++) {
                const d = buf[a + k]! - buf[b + k]!;
                if (d) return d;
            }
            return a - b;
        });
        let first = 0;
        let last = 0;
        for (let i = 0; i <= len; i++) {
            if (pos[i] === 1) first = i;
            else if (pos[i] === 0) last = i;
        }
        i32(len); i32(first); i32(last);
        for (let i = 0; i <= len; i++) out.push(buf[pos[i]! ? pos[i]! - 1 : 0]!);
    }
    return out.bytes();
}

export function huffmanEncode(input: Uint8Array): Uint8Array {
    interface Node { ch: number; count: number; kids?: [Node, Node] }
    const counts = new Array<number>(256).fill(0);
    for (const b of input) counts[b]!++;
    let nodes: Node[] = counts.map((count, ch) => ({ ch, count })).filter(n => n.count > 0);
    if (nodes.length === 0) nodes = [{ ch: 0, count: 0 }];
    while (nodes.length > 1) {
        nodes.sort((a, b) => b.count - a.count);
        const a = nodes.pop()!;
        const b = nodes.pop()!;
        nodes.push({ ch: -1, count: a.count + b.count, kids: [a, b] });
    }
    const codes = new Map<number, number[]>();
    const bitsOut: number[] = [];
    const writeTable = (n: Node, path: number[]): void => {
        bitsOut.push(n.kids ? 1 : 0);
        if (n.kids) {
            writeTable(n.kids[0], [...path, 0]);
            writeTable(n.kids[1], [...path, 1]);
        } else {
            for (let i = 0; i < 8; i++) bitsOut.push((n.ch >> i) & 1);
            codes.set(n.ch, path);
        }
    };
    writeTable(nodes[0]!, []);
    for (const b of input) bitsOut.push(...codes.get(b)!);
    const out = new Uint8Array(4 + ((bitsOut.length + 7) >> 3));
    new DataView(out.buffer).setInt32(0, input.length, true);
    bitsOut.forEach((v, i) => { if (v) out[4 + (i >> 3)]! |= 1 << (i & 7); });
    return out;
}

export function encodeUz(originalName: string, data: Uint8Array, signature = UZ_UT_SIGNATURE): Uint8Array {
    const name = new TextEncoder().encode(originalName);
    if (name.length + 1 >= 0x40) throw new UzError("encodeUz: name longer than one compact-index byte");
    const payload = huffmanEncode(rleEncode(mtfEncode(bwtEncode(rleEncode(data)))));
    const out = new Uint8Array(4 + 1 + name.length + 1 + payload.length);
    new DataView(out.buffer).setInt32(0, signature, true);
    out[4] = name.length + 1;
    out.set(name, 5);
    out.set(payload, 6 + name.length);
    return out;
}
