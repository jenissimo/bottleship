// PKWARE Data Compression Library "implode" decoder (the DCL format, not PKZIP's
// deflate). Used by MPQ compression mask 0x08 and by every pre-2000 Blizzard
// installer archive. Port of the canonical blast algorithm.

const MAXBITS = 13;

interface Huffman {
    count: Int16Array; // number of symbols of each length
    symbol: Int16Array; // symbols sorted by length, then by symbol order
}

function construct(rep: readonly number[]): Huffman {
    // The tables are stored as compact repeat counts: (repeat-1) << 4 | bitlength.
    const length: number[] = [];
    for (const value of rep) {
        const len = value & 15;
        let left = (value >> 4) + 1;
        while (left--) length.push(len);
    }

    const count = new Int16Array(MAXBITS + 1);
    for (const len of length) count[len]++;

    const offs = new Int16Array(MAXBITS + 2);
    for (let len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + count[len];

    const symbol = new Int16Array(length.length);
    for (let s = 0; s < length.length; s++) {
        if (length[s] !== 0) symbol[offs[length[s]]++] = s;
    }
    // These three tables are compile-time constants copied from the DCL specification, and
    // a typo in one decodes plausible garbage rather than failing. Kraft equality is the
    // check that cannot be fooled: an incomplete or over-subscribed set is not a valid code.
    let left = 1;
    for (let len = 1; len <= MAXBITS; len++) left = (left << 1) - count[len];
    if (left !== 0) throw new Error(`DCL explode: malformed code table (${length.length} symbols, Kraft residue ${left})`);
    return { count, symbol };
}

const LIT_CODE = construct([
    11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8,
    23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11,
    8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253,
    253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173,
]);
const LEN_CODE = construct([2, 35, 36, 53, 38, 23]);
const DIST_CODE = construct([2, 20, 53, 230, 247, 151, 248]);

const LEN_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

class BitReader {
    private bitbuf = 0;
    private bitcnt = 0;
    private pos = 0;

    constructor(private readonly input: Uint8Array) {}

    bits(need: number): number {
        let val = this.bitbuf;
        while (this.bitcnt < need) {
            if (this.pos >= this.input.length) throw new Error("DCL explode: out of input");
            val |= this.input[this.pos++] << this.bitcnt;
            this.bitcnt += 8;
        }
        this.bitbuf = val >>> need;
        this.bitcnt -= need;
        return val & ((1 << need) - 1);
    }

    decode(h: Huffman): number {
        let code = 0;
        let first = 0;
        let index = 0;
        for (let len = 1; len <= MAXBITS; len++) {
            code |= this.bits(1) ^ 1; // codes are stored inverted
            const count = h.count[len];
            if (code - first < count) return h.symbol[index + (code - first)];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new Error("DCL explode: invalid code");
    }
}

export function explode(input: Uint8Array, expectedSize: number): Uint8Array {
    const reader = new BitReader(input);
    const lit = reader.bits(8);
    if (lit > 1) throw new Error(`DCL explode: bad literal mode ${lit}`);
    const dict = reader.bits(8);
    if (dict < 4 || dict > 6) throw new Error(`DCL explode: bad dictionary size ${dict}`);

    const out = new Uint8Array(expectedSize);
    let written = 0;
    const emit = (byte: number) => {
        if (written >= out.length) throw new Error("DCL explode: output overflow");
        out[written++] = byte;
    };

    for (;;) {
        if (reader.bits(1)) {
            const lenSymbol = reader.decode(LEN_CODE);
            const len = LEN_BASE[lenSymbol] + reader.bits(LEN_EXTRA[lenSymbol]);
            if (len === 519) break; // end of stream
            const shift = len === 2 ? 2 : dict;
            const dist = ((reader.decode(DIST_CODE) << shift) | reader.bits(shift)) + 1;
            if (dist > written) throw new Error("DCL explode: distance before start");
            for (let i = 0; i < len; i++) emit(out[written - dist]);
        } else {
            emit(lit ? reader.decode(LIT_CODE) : reader.bits(8));
        }
    }

    // The caller knows the exact uncompressed length (an MPQ sector's is implied by the
    // sector size). A stream that ends early is corrupt; handing back the short prefix
    // would be wrong bytes with nothing to signal it.
    if (written !== expectedSize) throw new Error(`DCL explode: stream ended after ${written} of ${expectedSize} bytes`);
    return out;
}
