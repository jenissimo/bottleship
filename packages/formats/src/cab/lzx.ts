/**
 * LZX decoder for Microsoft Cabinet folders (CFFOLDER.typeCompress method 3).
 *
 * Format reference: Microsoft's "LZX Data Compression Format" (Cabinet SDK
 * `LZXFMT.DOC`) and the LZX description in `[MS-PATCH]` §2. The cabinet flavour
 * is the plain one: no reference data, no reset interval — one LZX stream per
 * folder, cut into 32 KiB output FRAMES with one frame per CFDATA block.
 *
 * Bitstream: 16-bit little-endian words consumed MSB-first. The encoder pads to
 * a word boundary at the end of every frame, which is what makes each CFDATA
 * block start on a word; the decoder realigns there rather than trusting it.
 *
 * Stream  := e8Header frame*
 * e8Header:= 1 bit; when set, a 32-bit translation size follows (high word first)
 * block   := type:3 size:24 body          (blocks are independent of frames)
 *   1 VERBATIM      main tree, length tree, then symbols
 *   2 ALIGNED       aligned tree (8 x 3-bit lengths) first, then as VERBATIM
 *   3 UNCOMPRESSED  1..16 pad bits to a word, R0 R1 R2 as u32, raw bytes,
 *                   one pad byte when the size is odd
 * Tree lengths are delta-coded against the PREVIOUS block's lengths through a
 * 20-symbol pretree, so they persist for the life of the stream.
 */

const MIN_MATCH = 2;
const NUM_CHARS = 256;
const NUM_PRIMARY_LENGTHS = 7;
const NUM_SECONDARY_LENGTHS = 249;
const PRETREE_SYMBOLS = 20;
const ALIGNED_SYMBOLS = 8;
const MAX_CODE_LENGTH = 16;
const MAX_POSITION_SLOTS = 50;

export const LZX_FRAME_SIZE = 32768;

const BLOCK_VERBATIM = 1;
const BLOCK_ALIGNED = 2;
const BLOCK_UNCOMPRESSED = 3;

/** E8 call translation stops after this many frames (1 GiB of output). */
const E8_FRAME_LIMIT = 32768;

// Slot s covers offsets [POSITION_BASE[s], POSITION_BASE[s] + 2^EXTRA_BITS[s]).
const EXTRA_BITS = new Uint8Array(MAX_POSITION_SLOTS + 1);
const POSITION_BASE = new Int32Array(MAX_POSITION_SLOTS + 1);
for (let slot = 0, bits = 0, base = 0; slot <= MAX_POSITION_SLOTS; slot++) {
    EXTRA_BITS[slot] = bits;
    POSITION_BASE[slot] = base;
    base += 1 << bits;
    if (slot >= 3 && (slot & 1) === 1 && bits < 17) bits++;
}

/** Canonical Huffman code: a direct table for short codes, a length scan for the rest. */
class HuffmanTable {
    readonly lengths: Uint8Array;
    /** `(symbol << 5) | length` for every `fastBits`-bit prefix; 0 = not a short code. */
    readonly fast: Uint16Array;
    /** Exclusive upper bound of each length's codes, left-aligned to 16 bits. */
    readonly limit = new Int32Array(MAX_CODE_LENGTH + 1);
    readonly firstCode = new Int32Array(MAX_CODE_LENGTH + 1);
    readonly firstIndex = new Int32Array(MAX_CODE_LENGTH + 1);
    readonly symbols: Uint16Array;
    private readonly count = new Int32Array(MAX_CODE_LENGTH + 1);
    private readonly next = new Int32Array(MAX_CODE_LENGTH + 1);

    constructor(
        readonly name: string,
        readonly numSymbols: number,
        readonly fastBits: number,
    ) {
        this.lengths = new Uint8Array(numSymbols);
        this.symbols = new Uint16Array(numSymbols);
        this.fast = new Uint16Array(1 << fastBits);
    }

    build(): void {
        const {lengths, count, next, firstCode, firstIndex, limit, fast, fastBits} = this;
        count.fill(0);
        for (let s = 0; s < this.numSymbols; s++) count[lengths[s]!]!++;
        fast.fill(0);
        let code = 0;
        let index = 0;
        for (let len = 1; len <= MAX_CODE_LENGTH; len++) {
            firstCode[len] = code;
            firstIndex[len] = index;
            next[len] = index;
            code += count[len]!;
            index += count[len]!;
            if (code > 1 << len) throw new Error(`LZX: ${this.name} tree is over-subscribed`);
            limit[len] = code << (MAX_CODE_LENGTH - len);
            code <<= 1;
        }
        for (let s = 0; s < this.numSymbols; s++) {
            const len = lengths[s]!;
            if (len === 0) continue;
            const i = next[len]!++;
            this.symbols[i] = s;
            if (len <= fastBits) {
                const lo = (firstCode[len]! + i - firstIndex[len]!) << (fastBits - len);
                fast.fill((s << 5) | len, lo, lo + (1 << (fastBits - len)));
            }
        }
    }
}

class BitReader {
    /** Unread bits, left-aligned in 32. */
    private buf = 0;
    private count = 0;
    private pos = 0;
    private padded = false;

    constructor(private readonly data: Uint8Array) {}

    private fill(): void {
        const d = this.data;
        const p = this.pos;
        let word: number;
        if (p + 1 < d.length) {
            word = d[p]! | (d[p + 1]! << 8);
        } else {
            // The last symbol may be peeked through bits the encoder never wrote.
            if (this.padded) throw new Error("LZX: compressed data is truncated");
            this.padded = true;
            word = p < d.length ? d[p]! : 0;
        }
        this.pos = p + 2;
        this.buf |= word << (16 - this.count);
        this.count += 16;
    }

    /** 1 <= n <= 17. */
    peek(n: number): number {
        while (this.count < n) this.fill();
        return this.buf >>> (32 - n);
    }

    skip(n: number): void {
        this.buf <<= n;
        this.count -= n;
    }

    read(n: number): number {
        if (n === 0) return 0;
        const v = this.peek(n);
        this.skip(n);
        return v;
    }

    decode(t: HuffmanTable): number {
        const v = this.peek(MAX_CODE_LENGTH);
        const e = t.fast[v >>> (MAX_CODE_LENGTH - t.fastBits)]!;
        if (e !== 0) {
            this.skip(e & 31);
            return e >>> 5;
        }
        for (let len = t.fastBits + 1; len <= MAX_CODE_LENGTH; len++) {
            if (v < t.limit[len]!) {
                this.skip(len);
                return t.symbols[t.firstIndex[len]! + (v >>> (MAX_CODE_LENGTH - len)) - t.firstCode[len]!]!;
            }
        }
        throw new Error(`LZX: invalid ${t.name} tree code`);
    }

    /** Frame boundary: drop the remainder of a partly consumed word. */
    alignToWord(): void {
        this.skip(this.count & 15);
    }

    /**
     * Uncompressed-block header: the pad is 1..16 bits, so a header that ends
     * exactly on a word boundary still discards a whole word. Leaves the reader
     * byte-addressed at the first raw byte.
     */
    enterRaw(): void {
        const partial = this.count & 15;
        if (partial !== 0) this.skip(partial);
        else if (this.count === 0) this.pos += 2;
        else this.skip(16);
        this.pos -= this.count >> 3;
        this.buf = 0;
        this.count = 0;
    }

    rawU32(): number {
        const d = this.data;
        const p = this.pos;
        if (p + 4 > d.length) throw new Error("LZX: compressed data is truncated");
        this.pos = p + 4;
        return (d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24)) >>> 0;
    }

    rawCopy(dst: Uint8Array, dstPos: number, n: number): void {
        if (this.pos + n > this.data.length) throw new Error("LZX: compressed data is truncated");
        dst.set(this.data.subarray(this.pos, this.pos + n), dstPos);
        this.pos += n;
    }

    rawSkip(n: number): void {
        this.pos += n;
    }
}

function readLengths(bits: BitReader, pretree: HuffmanTable, lengths: Uint8Array, first: number, last: number): void {
    for (let i = 0; i < PRETREE_SYMBOLS; i++) pretree.lengths[i] = bits.read(4);
    pretree.build();
    let x = first;
    while (x < last) {
        let sym = bits.decode(pretree);
        let run = 1;
        let value: number;
        if (sym === 17) {
            run = bits.read(4) + 4;
            value = 0;
        } else if (sym === 18) {
            run = bits.read(5) + 20;
            value = 0;
        } else {
            if (sym === 19) {
                run = bits.read(1) + 4;
                sym = bits.decode(pretree);
                if (sym > 16) throw new Error("LZX: run code inside a same-length run");
            }
            value = (lengths[x]! + 17 - sym) % 17;
        }
        if (x + run > last) throw new Error("LZX: tree length run overflows the tree");
        lengths.fill(value, x, x + run);
        x += run;
    }
}

/** Number of position slots for a window of 2^windowBits bytes. */
function positionSlotsFor(windowBits: number): number {
    if (windowBits === 21) return 50;
    if (windowBits === 20) return 42;
    return windowBits << 1;
}

/**
 * Decompress one cabinet LZX stream (a whole folder's CFDATA payloads, in
 * order, concatenated) into `outputSize` bytes.
 */
export function decompressLzx(input: Uint8Array, windowBits: number, outputSize: number): Uint8Array {
    if (windowBits < 15 || windowBits > 21) {
        throw new Error(`LZX: window of 2^${windowBits} bytes is outside the cabinet range 2^15..2^21`);
    }
    const windowSize = 1 << windowBits;
    const windowMask = windowSize - 1;
    const mainSymbols = NUM_CHARS + (positionSlotsFor(windowBits) << 3);

    const window = new Uint8Array(windowSize);
    const out = new Uint8Array(outputSize);
    const bits = new BitReader(input);

    const pretree = new HuffmanTable("pre", PRETREE_SYMBOLS, 6);
    const mainTree = new HuffmanTable("main", mainSymbols, 11);
    const lengthTree = new HuffmanTable("length", NUM_SECONDARY_LENGTHS, 9);
    const alignedTree = new HuffmanTable("aligned", ALIGNED_SYMBOLS, 7);

    let r0 = 1;
    let r1 = 1;
    let r2 = 1;
    let blockType = 0;
    let blockLength = 0;
    let blockRemaining = 0;

    let e8Size = 0;
    if (bits.read(1) !== 0) {
        const hi = bits.read(16);
        e8Size = ((hi << 16) | bits.read(16)) | 0;
    }

    let windowPos = 0;
    let outPos = 0;
    for (let frame = 0; outPos < outputSize; frame++) {
        const frameSize = Math.min(LZX_FRAME_SIZE, outputSize - outPos);
        const frameStart = windowPos;
        const frameEnd = frameStart + frameSize;

        while (windowPos < frameEnd) {
            if (blockRemaining === 0) {
                if (blockType === BLOCK_UNCOMPRESSED && (blockLength & 1) !== 0) bits.rawSkip(1);
                blockType = bits.read(3);
                if (blockType < BLOCK_VERBATIM || blockType > BLOCK_UNCOMPRESSED) {
                    throw new Error(`LZX: invalid block type ${blockType}`);
                }
                const hi = bits.read(16);
                blockLength = (hi << 8) | bits.read(8);
                blockRemaining = blockLength;
                if (blockLength === 0) throw new Error("LZX: empty block");
                switch (blockType) {
                    case BLOCK_ALIGNED:
                        for (let i = 0; i < ALIGNED_SYMBOLS; i++) alignedTree.lengths[i] = bits.read(3);
                        alignedTree.build();
                    // falls through: the rest of the header is the verbatim one
                    case BLOCK_VERBATIM:
                        readLengths(bits, pretree, mainTree.lengths, 0, NUM_CHARS);
                        readLengths(bits, pretree, mainTree.lengths, NUM_CHARS, mainSymbols);
                        mainTree.build();
                        readLengths(bits, pretree, lengthTree.lengths, 0, NUM_SECONDARY_LENGTHS);
                        lengthTree.build();
                        break;
                    case BLOCK_UNCOMPRESSED:
                        bits.enterRaw();
                        r0 = bits.rawU32();
                        r1 = bits.rawU32();
                        r2 = bits.rawU32();
                        break;
                }
            }

            const run = Math.min(blockRemaining, frameEnd - windowPos);
            blockRemaining -= run;

            if (blockType === BLOCK_UNCOMPRESSED) {
                bits.rawCopy(window, windowPos, run);
                windowPos += run;
                continue;
            }

            const aligned = blockType === BLOCK_ALIGNED;
            const runEnd = windowPos + run;
            while (windowPos < runEnd) {
                const sym = bits.decode(mainTree);
                if (sym < NUM_CHARS) {
                    window[windowPos++] = sym;
                    continue;
                }
                const m = sym - NUM_CHARS;
                let length = m & NUM_PRIMARY_LENGTHS;
                if (length === NUM_PRIMARY_LENGTHS) length += bits.decode(lengthTree);
                length += MIN_MATCH;

                const slot = m >>> 3;
                let offset: number;
                if (slot === 0) {
                    offset = r0;
                } else if (slot === 1) {
                    offset = r1;
                    r1 = r0;
                    r0 = offset;
                } else if (slot === 2) {
                    offset = r2;
                    r2 = r0;
                    r0 = offset;
                } else {
                    const extra = EXTRA_BITS[slot]!;
                    if (slot === 3) {
                        offset = 1;
                    } else if (aligned && extra >= 3) {
                        // The low three offset bits come from the aligned tree.
                        offset = POSITION_BASE[slot]! - 2 + (bits.read(extra - 3) << 3);
                        offset += bits.decode(alignedTree);
                    } else {
                        offset = POSITION_BASE[slot]! - 2 + bits.read(extra);
                    }
                    r2 = r1;
                    r1 = r0;
                    r0 = offset;
                }

                if (offset > windowSize) throw new Error("LZX: match offset exceeds the window");
                if (windowPos + length > windowSize) throw new Error("LZX: match runs past the window");
                let src = (windowPos - offset) & windowMask;
                if (src + length <= windowSize && offset >= length) {
                    window.copyWithin(windowPos, src, src + length);
                    windowPos += length;
                } else {
                    // Overlapping (run-length) or wrapping source: byte order matters.
                    for (let i = 0; i < length; i++) {
                        window[windowPos++] = window[src]!;
                        src = (src + 1) & windowMask;
                    }
                }
            }
            // A match may end past the run it started in, but only inside its own block.
            const over = windowPos - runEnd;
            if (over > blockRemaining) throw new Error("LZX: match runs past the end of its block");
            blockRemaining -= over;
        }
        if (windowPos !== frameEnd) throw new Error("LZX: match runs past the end of its frame");

        out.set(window.subarray(frameStart, frameEnd), outPos);
        if (e8Size !== 0 && frame < E8_FRAME_LIMIT) translateE8(out, outPos, frameSize, e8Size);
        outPos += frameSize;
        windowPos &= windowMask;
        bits.alignToWord();
    }
    return out;
}

/**
 * Undo the encoder's x86 CALL preprocessing on one output frame. The encoder
 * rewrote each `E8 rel32` whose target lies inside [0, e8Size) to an absolute
 * stream offset so that calls to one function compress alike. The last 10 bytes
 * of a frame are never translated, and an E8 consumes its 4 operand bytes.
 */
function translateE8(out: Uint8Array, frameOffset: number, frameSize: number, e8Size: number): void {
    const end = frameOffset + frameSize - 10;
    let p = frameOffset;
    while (p < end) {
        if (out[p] !== 0xe8) {
            p++;
            continue;
        }
        const pos = p;
        const abs = out[p + 1]! | (out[p + 2]! << 8) | (out[p + 3]! << 16) | (out[p + 4]! << 24);
        if (abs >= -pos && abs < e8Size) {
            const rel = abs >= 0 ? abs - pos : abs + e8Size;
            out[p + 1] = rel;
            out[p + 2] = rel >>> 8;
            out[p + 3] = rel >>> 16;
            out[p + 4] = rel >>> 24;
        }
        p += 5;
    }
}
