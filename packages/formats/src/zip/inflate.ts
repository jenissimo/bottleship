/**
 * Synchronous DEFLATE (RFC 1951) + zlib (RFC 1950) decoder — dependency-free.
 *
 * Every other inflate in the tree is asynchronous (DecompressionStream, the
 * unpack-buffered wasm), which makes them unusable from a synchronous context
 * such as a guest OUT-trap handler. This one is also DIAGNOSTIC: it reports
 * WHERE and WHY a stream failed, a distinction zlib folds into one
 * Z_DATA_ERROR, so "the bytes are corrupt" can be told apart from "the stream
 * was cut short" and from "the destination was too small".
 *
 * Decoding is canonical-Huffman bit-at-a-time (the `puff` algorithm) rather
 * than table-driven: ~3x slower per symbol, a fraction of the code, and every
 * step maps to a line of RFC 1951 — the right trade for a correctness oracle.
 */

export type InflateStatus =
    /** Complete stream decoded and (for zlib) checksum-verified. */
    | 'ok'
    /** Input ended mid-stream — more bytes were needed. */
    | 'truncated'
    /** Destination filled before the stream ended; `out` holds what fit. */
    | 'output-full'
    /** Malformed stream or checksum mismatch. */
    | 'data-error'
    /** zlib header requests a preset dictionary (FDICT). */
    | 'need-dict';

export interface InflateOutcome {
    status: InflateStatus;
    /** Bytes written to `out`. Partial output is retained on failure. */
    written: number;
    /** Bytes of `src` consumed (for zlib, includes header + adler trailer). */
    consumed: number;
    /** Failure detail including position; undefined when status === 'ok'. */
    message?: string;
}

const MAXBITS = 15;

const LENGTH_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
    /** count[len] = number of symbols with code length `len`. */
    count: Int32Array;
    /** Symbols ordered by code length then value. */
    symbol: Int32Array;
}

/** Non-local exit carrying the outcome classification. */
class Bail {
    constructor(readonly status: InflateStatus, readonly message: string) {}
}

/**
 * Build a canonical Huffman decoding table.
 * `left` is 0 for a complete set, >0 incomplete, <0 over-subscribed.
 */
function construct(lengths: Uint8Array, n: number): { h: Huffman; left: number } {
    const count = new Int32Array(MAXBITS + 1);
    for (let s = 0; s < n; s++) count[lengths[s]]++;

    let left = 1;
    for (let len = 1; len <= MAXBITS; len++) {
        left = (left << 1) - count[len];
        if (left < 0) return { h: { count, symbol: new Int32Array(0) }, left };
    }

    const offs = new Int32Array(MAXBITS + 2);
    for (let len = 1; len <= MAXBITS; len++) offs[len + 1] = offs[len] + count[len];
    const symbol = new Int32Array(n);
    for (let s = 0; s < n; s++) if (lengths[s] !== 0) symbol[offs[lengths[s]]++] = s;

    return { h: { count, symbol }, left };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): { lit: Huffman; dist: Huffman } {
    if (!fixedLit || !fixedDist) {
        const litLen = new Uint8Array(288);
        litLen.fill(8, 0, 144);
        litLen.fill(9, 144, 256);
        litLen.fill(7, 256, 280);
        litLen.fill(8, 280, 288);
        fixedLit = construct(litLen, 288).h;
        const distLen = new Uint8Array(30).fill(5);
        fixedDist = construct(distLen, 30).h;
    }
    return { lit: fixedLit, dist: fixedDist };
}

class Inflater {
    private pos = 0;
    private bitbuf = 0;
    private bitcnt = 0;
    outPos = 0;

    constructor(
        private readonly src: Uint8Array,
        private readonly start: number,
        private readonly out: Uint8Array,
    ) {
        this.pos = start;
    }

    get consumed(): number { return this.pos - this.start; }

    private bits(need: number): number {
        let val = this.bitbuf;
        while (this.bitcnt < need) {
            if (this.pos >= this.src.length) {
                throw new Bail('truncated', `input ended after ${this.pos - this.start} bytes`);
            }
            val |= this.src[this.pos++] << this.bitcnt;
            this.bitcnt += 8;
        }
        this.bitbuf = val >>> need;
        this.bitcnt -= need;
        return val & ((1 << need) - 1);
    }

    private decode(h: Huffman): number {
        let code = 0;
        let first = 0;
        let index = 0;
        for (let len = 1; len <= MAXBITS; len++) {
            code |= this.bits(1);
            const count = h.count[len];
            if (code - first < count) return h.symbol[index + (code - first)];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new Bail('data-error', `invalid Huffman code at in+${this.pos - this.start}`);
    }

    private emit(byte: number): void {
        if (this.outPos >= this.out.length) {
            throw new Bail('output-full', `destination full after ${this.outPos} bytes`);
        }
        this.out[this.outPos++] = byte;
    }

    private stored(): void {
        // Discard the partial byte, then LEN / ~LEN.
        this.bitbuf = 0;
        this.bitcnt = 0;
        if (this.pos + 4 > this.src.length) {
            throw new Bail('truncated', `stored-block header at in+${this.pos - this.start}`);
        }
        const len = this.src[this.pos] | (this.src[this.pos + 1] << 8);
        const nlen = this.src[this.pos + 2] | (this.src[this.pos + 3] << 8);
        this.pos += 4;
        if (len !== (~nlen & 0xffff)) {
            throw new Bail('data-error', `stored-block length complement mismatch at in+${this.pos - this.start - 4}`);
        }
        if (this.pos + len > this.src.length) {
            throw new Bail('truncated', `stored block of ${len} bytes at in+${this.pos - this.start}`);
        }
        if (this.outPos + len > this.out.length) {
            const fits = this.out.length - this.outPos;
            this.out.set(this.src.subarray(this.pos, this.pos + fits), this.outPos);
            this.outPos += fits;
            throw new Bail('output-full', `destination full after ${this.outPos} bytes`);
        }
        this.out.set(this.src.subarray(this.pos, this.pos + len), this.outPos);
        this.outPos += len;
        this.pos += len;
    }

    private codes(lit: Huffman, dist: Huffman): void {
        for (;;) {
            const sym = this.decode(lit);
            if (sym < 256) {
                this.emit(sym);
                continue;
            }
            if (sym === 256) return;
            const li = sym - 257;
            if (li >= LENGTH_BASE.length) {
                throw new Bail('data-error', `invalid length symbol ${sym} at in+${this.pos - this.start}`);
            }
            const len = LENGTH_BASE[li] + this.bits(LENGTH_EXTRA[li]);
            const ds = this.decode(dist);
            if (ds >= DIST_BASE.length) {
                throw new Bail('data-error', `invalid distance symbol ${ds} at in+${this.pos - this.start}`);
            }
            const d = DIST_BASE[ds] + this.bits(DIST_EXTRA[ds]);
            if (d > this.outPos) {
                throw new Bail('data-error',
                    `distance ${d} too far back (only ${this.outPos} bytes out) at in+${this.pos - this.start}`);
            }
            let from = this.outPos - d;
            for (let i = 0; i < len; i++) this.emit(this.out[from++]);
        }
    }

    private dynamicTables(): { lit: Huffman; dist: Huffman } {
        const nlen = this.bits(5) + 257;
        const ndist = this.bits(5) + 1;
        const ncode = this.bits(4) + 4;
        if (nlen > 286 || ndist > 30) {
            throw new Bail('data-error', `too many length or distance codes at in+${this.pos - this.start}`);
        }

        const lengths = new Uint8Array(286 + 30);
        for (let i = 0; i < ncode; i++) lengths[CLEN_ORDER[i]] = this.bits(3);
        for (let i = ncode; i < 19; i++) lengths[CLEN_ORDER[i]] = 0;

        const cl = construct(lengths, 19);
        if (cl.left !== 0) {
            throw new Bail('data-error', `incomplete code-length code set at in+${this.pos - this.start}`);
        }

        let idx = 0;
        while (idx < nlen + ndist) {
            const sym = this.decode(cl.h);
            if (sym < 16) {
                lengths[idx++] = sym;
                continue;
            }
            let len = 0;
            let repeat: number;
            if (sym === 16) {
                if (idx === 0) {
                    throw new Bail('data-error', `repeat with no previous length at in+${this.pos - this.start}`);
                }
                len = lengths[idx - 1];
                repeat = 3 + this.bits(2);
            } else if (sym === 17) {
                repeat = 3 + this.bits(3);
            } else {
                repeat = 11 + this.bits(7);
            }
            if (idx + repeat > nlen + ndist) {
                throw new Bail('data-error', `code-length repeat overruns at in+${this.pos - this.start}`);
            }
            while (repeat-- > 0) lengths[idx++] = len;
        }
        if (lengths[256] === 0) {
            throw new Bail('data-error', 'no end-of-block code');
        }

        // An incomplete set is legal only when it holds at most one code
        // (matches zlib/puff, which accept a lone distance code).
        const lit = construct(lengths, nlen);
        if (lit.left !== 0 && (lit.left < 0 || nlen !== lit.h.count[0] + lit.h.count[1])) {
            throw new Bail('data-error', 'invalid literal/length code set');
        }
        const distLengths = lengths.subarray(nlen, nlen + ndist);
        const dist = construct(distLengths, ndist);
        if (dist.left !== 0 && (dist.left < 0 || ndist !== dist.h.count[0] + dist.h.count[1])) {
            throw new Bail('data-error', 'invalid distance code set');
        }
        return { lit: lit.h, dist: dist.h };
    }

    run(): void {
        let last = 0;
        do {
            last = this.bits(1);
            const type = this.bits(2);
            if (type === 0) {
                this.stored();
            } else if (type === 1) {
                const t = fixedTables();
                this.codes(t.lit, t.dist);
            } else if (type === 2) {
                const t = this.dynamicTables();
                this.codes(t.lit, t.dist);
            } else {
                throw new Bail('data-error', `reserved block type at in+${this.pos - this.start}`);
            }
        } while (!last);
    }
}

/** Decode a raw DEFLATE stream (no zlib/gzip wrapper) into `out`. */
export function inflateRawSync(src: Uint8Array, out: Uint8Array, srcStart = 0): InflateOutcome {
    const inf = new Inflater(src, srcStart, out);
    try {
        inf.run();
    } catch (e) {
        if (e instanceof Bail) {
            return { status: e.status, written: inf.outPos, consumed: inf.consumed, message: e.message };
        }
        throw e;
    }
    return { status: 'ok', written: inf.outPos, consumed: inf.consumed };
}

/** Adler-32 over `data[0..len)` (RFC 1950). */
export function adler32(data: Uint8Array, len: number): number {
    let a = 1;
    let b = 0;
    let i = 0;
    // 5552 is the largest run of bytes that cannot overflow a 32-bit `b`.
    while (i < len) {
        const end = Math.min(i + 5552, len);
        for (; i < end; i++) {
            a += data[i];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

/**
 * Decode a zlib stream (RFC 1950: 2-byte header, DEFLATE body, Adler-32
 * trailer) into `out`. Trailing bytes after the stream are ignored, as zlib's
 * own `uncompress` ignores them.
 */
export function inflateZlibSync(src: Uint8Array, out: Uint8Array): InflateOutcome {
    if (src.length < 2) {
        return { status: 'truncated', written: 0, consumed: src.length, message: 'zlib header incomplete' };
    }
    const cmf = src[0];
    const flg = src[1];
    if ((cmf & 0x0f) !== 8) {
        return { status: 'data-error', written: 0, consumed: 2, message: `unknown compression method ${cmf & 0x0f}` };
    }
    if ((cmf >> 4) > 7) {
        return { status: 'data-error', written: 0, consumed: 2, message: `invalid window size (cinfo ${cmf >> 4})` };
    }
    if ((((cmf << 8) | flg) % 31) !== 0) {
        return {
            status: 'data-error', written: 0, consumed: 2,
            message: `incorrect header check (cmf=0x${cmf.toString(16)} flg=0x${flg.toString(16)})`,
        };
    }
    if (flg & 0x20) {
        return { status: 'need-dict', written: 0, consumed: 6, message: 'preset dictionary required' };
    }

    const body = inflateRawSync(src, out, 2);
    if (body.status !== 'ok') {
        return { ...body, consumed: 2 + body.consumed };
    }

    const trailer = 2 + body.consumed;
    if (trailer + 4 > src.length) {
        return {
            status: 'truncated', written: body.written, consumed: src.length,
            message: `Adler-32 trailer incomplete (${src.length - trailer} of 4 bytes)`,
        };
    }
    const want = ((src[trailer] << 24) | (src[trailer + 1] << 16) | (src[trailer + 2] << 8) | src[trailer + 3]) >>> 0;
    const got = adler32(out, body.written);
    if (want !== got) {
        return {
            status: 'data-error', written: body.written, consumed: trailer + 4,
            message: `incorrect data check (adler stored=0x${want.toString(16)} computed=0x${got.toString(16)})`,
        };
    }
    return { status: 'ok', written: body.written, consumed: trailer + 4 };
}
