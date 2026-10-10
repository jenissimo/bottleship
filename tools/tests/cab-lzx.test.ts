import {describe, expect, test} from 'bun:test';
import {decompressLzx, extractCabToMap} from '@bottleship/formats/cab';

/**
 * No LZX cabinet we could redistribute is small enough to check in, so these
 * tests carry a minimal LZX ENCODER and decode what it writes. The encoder
 * takes a script of literals and matches, so the expected output comes from
 * replaying that script — not from the decoder under test.
 */

const FRAME = 32768;
const VERBATIM = 1;
const ALIGNED = 2;
const UNCOMPRESSED = 3;

const extraBits = (slot: number) => (slot < 4 ? 0 : Math.min(17, (slot >> 1) - 1));
const positionBase = (slot: number) => {
    let base = 0;
    for (let s = 0; s < slot; s++) base += 1 << extraBits(s);
    return base;
};
const slotsFor = (windowBits: number) => (windowBits === 21 ? 50 : windowBits === 20 ? 42 : windowBits * 2);

type Op = {lit: number} | {len: number; off: number};

interface Trees {
    main: number[];
    length: number[];
    aligned: number[];
}

function canonicalCodes(lengths: number[]): number[] {
    const codes = new Array<number>(lengths.length).fill(0);
    let code = 0;
    for (let len = 1; len <= 16; len++) {
        for (let s = 0; s < lengths.length; s++) if (lengths[s] === len) codes[s] = code++;
        code <<= 1;
    }
    return codes;
}

class LzxWriter {
    readonly bytes: number[] = [];
    /** Byte offsets at which a 32 KiB output frame ended — the CFDATA cut points. */
    readonly frameCuts: number[] = [];
    private acc = 0;
    private n = 0;
    private outPos = 0;
    private r = [1, 1, 1];
    private prevMain: number[];
    private prevLength = new Array<number>(249).fill(0);
    private readonly slots: number;

    constructor(readonly windowBits: number, e8Size = 0) {
        this.slots = slotsFor(windowBits);
        this.prevMain = new Array<number>(256 + this.slots * 8).fill(0);
        if (e8Size) {
            this.bits(1, 1);
            this.bits(e8Size >>> 16, 16);
            this.bits(e8Size & 0xffff, 16);
        } else {
            this.bits(0, 1);
        }
    }

    private bits(value: number, count: number): void {
        for (let i = count - 1; i >= 0; i--) {
            this.acc = (this.acc << 1) | ((value >>> i) & 1);
            if (++this.n === 16) {
                this.bytes.push(this.acc & 0xff, this.acc >>> 8);
                this.acc = 0;
                this.n = 0;
            }
        }
    }

    private advance(count: number): void {
        const before = Math.floor(this.outPos / FRAME);
        this.outPos += count;
        if (this.outPos % FRAME === 0) {
            if (this.n) this.bits(0, 16 - this.n);
            this.frameCuts.push(this.bytes.length);
        } else if (Math.floor(this.outPos / FRAME) !== before) {
            throw new Error('test script: a match crosses a frame boundary');
        }
    }

    private lengths(prev: number[], next: number[], first: number, last: number): void {
        // A complete 20-symbol pretree: twelve 4-bit codes and eight 5-bit ones.
        const pre = Array.from({length: 20}, (_, i) => (i < 12 ? 4 : 5));
        const codes = canonicalCodes(pre);
        for (const len of pre) this.bits(len, 4);
        const put = (sym: number) => this.bits(codes[sym]!, pre[sym]!);
        let x = first;
        while (x < last) {
            let run = 1;
            while (x + run < last && next[x + run] === next[x]) run++;
            if (next[x] === 0 && run >= 20) {
                run = Math.min(run, 51);
                put(18);
                this.bits(run - 20, 5);
            } else if (next[x] === 0 && run >= 4) {
                run = Math.min(run, 19);
                put(17);
                this.bits(run - 4, 4);
            } else if (run >= 4) {
                run = Math.min(run, 5);
                put(19);
                this.bits(run - 4, 1);
                put((prev[x]! - next[x]! + 17) % 17);
            } else {
                run = 1;
                put((prev[x]! - next[x]! + 17) % 17);
            }
            x += run;
        }
    }

    compressed(type: typeof VERBATIM | typeof ALIGNED, trees: Trees, ops: Op[]): void {
        let size = 0;
        for (const op of ops) size += 'lit' in op ? 1 : op.len;
        this.bits(type, 3);
        this.bits(size >>> 8, 16);
        this.bits(size & 0xff, 8);
        if (type === ALIGNED) for (const len of trees.aligned) this.bits(len, 3);
        this.lengths(this.prevMain, trees.main, 0, 256);
        this.lengths(this.prevMain, trees.main, 256, trees.main.length);
        this.lengths(this.prevLength, trees.length, 0, 249);
        this.prevMain = trees.main.slice();
        this.prevLength = trees.length.slice();

        const mainCodes = canonicalCodes(trees.main);
        const lengthCodes = canonicalCodes(trees.length);
        const alignedCodes = canonicalCodes(trees.aligned);
        const r = this.r;
        for (const op of ops) {
            if ('lit' in op) {
                this.bits(mainCodes[op.lit]!, trees.main[op.lit]!);
                this.advance(1);
                continue;
            }
            let slot: number;
            if (op.off === r[0]) {
                slot = 0;
            } else if (op.off === r[1]) {
                slot = 1;
                [r[0], r[1]] = [r[1]!, r[0]!];
            } else if (op.off === r[2]) {
                slot = 2;
                [r[0], r[2]] = [r[2]!, r[0]!];
            } else {
                slot = 3;
                while (positionBase(slot + 1) <= op.off + 2) slot++;
                r[2] = r[1]!;
                r[1] = r[0]!;
                r[0] = op.off;
            }
            const header = Math.min(op.len - 2, 7);
            const sym = 256 + ((slot << 3) | header);
            if (!trees.main[sym]) throw new Error(`test script: main symbol ${sym} has no code`);
            this.bits(mainCodes[sym]!, trees.main[sym]!);
            if (header === 7) {
                const footer = op.len - 9;
                if (!trees.length[footer]) throw new Error(`test script: length ${op.len} has no code`);
                this.bits(lengthCodes[footer]!, trees.length[footer]!);
            }
            if (slot >= 3) {
                const extra = extraBits(slot);
                const v = op.off + 2 - positionBase(slot);
                if (type === ALIGNED && extra >= 3) {
                    this.bits(v >>> 3, extra - 3);
                    this.bits(alignedCodes[v & 7]!, trees.aligned[v & 7]!);
                } else {
                    this.bits(v, extra);
                }
            }
            this.advance(op.len);
        }
    }

    uncompressed(data: number[]): void {
        this.bits(UNCOMPRESSED, 3);
        this.bits(data.length >>> 8, 16);
        this.bits(data.length & 0xff, 8);
        this.bits(0, 16 - this.n);
        for (const v of this.r) this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
        for (let i = 0; i < data.length; ) {
            const take = Math.min(data.length - i, FRAME - (this.outPos % FRAME));
            for (let k = 0; k < take; k++) this.bytes.push(data[i + k]!);
            i += take;
            this.advance(take);
        }
        if (data.length & 1) this.bytes.push(0);
    }

    finish(): Uint8Array {
        if (this.n) this.bits(0, 16 - this.n);
        return Uint8Array.from(this.bytes);
    }
}

/** Trees that give every symbol a code, with main codes on both sides of the decoder's direct table. */
function wideTrees(windowBits: number): Trees {
    const matchSymbols = slotsFor(windowBits) * 8;
    const main = new Array<number>(256).fill(9);
    for (let i = 0; i < matchSymbols; i++) main.push(i < matchSymbols - 32 ? 10 : i < matchSymbols - 16 ? 13 : 16);
    return {main, length: new Array<number>(249).fill(8), aligned: [1, 2, 3, 4, 5, 6, 7, 7]};
}

/** Different lengths everywhere (so the delta coding has deltas) and long zero runs. */
function sparseTrees(windowBits: number): Trees {
    const main = new Array<number>(256 + slotsFor(windowBits) * 8).fill(10);
    const length = new Array<number>(249).fill(0).fill(7, 0, 120);
    return {main, length, aligned: [3, 3, 3, 3, 3, 3, 3, 3]};
}

function replay(ops: Op[], into: number[] = []): number[] {
    for (const op of ops) {
        if ('lit' in op) into.push(op.lit);
        else for (let i = 0; i < op.len; i++) into.push(into[into.length - op.off]!);
    }
    return into;
}

/** A deterministic literal/match script of exactly `size` bytes that never crosses a frame. */
function script(size: number, seed: number, startPos: number, maxLen: number, maxOffset: number): Op[] {
    let state = seed >>> 0;
    const rand = (n: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return Math.floor((state / 0x100000000) * n);
    };
    const ops: Op[] = [];
    const recent: number[] = [];
    let pos = startPos;
    const end = startPos + size;
    while (pos < end) {
        const room = Math.min(end - pos, FRAME - (pos % FRAME));
        const limit = Math.min(pos, maxOffset);
        if (limit < 1 || room < 2 || rand(3) === 0) {
            ops.push({lit: rand(256)});
            pos++;
            continue;
        }
        // Reuse a recent offset now and then so all three repeat slots are taken.
        const off = recent.length && rand(3) === 0 ? recent[rand(recent.length)]! : 1 + rand(rand(4) === 0 ? limit : Math.min(limit, 64));
        const len = Math.min(room, 2 + rand(rand(4) === 0 ? maxLen - 1 : 12));
        ops.push({len, off});
        recent.unshift(off);
        recent.length = Math.min(recent.length, 3);
        pos += len;
    }
    return ops;
}

describe('LZX', () => {
    test('verbatim blocks: literals, repeat offsets, both tree paths, trees delta-coded across blocks', () => {
        const w = new LzxWriter(16);
        const first = script(40000, 1, 0, 257, 65533);
        const second = script(50000, 2, 40000, 128, 65533);
        w.compressed(VERBATIM, wideTrees(16), first);
        w.compressed(VERBATIM, sparseTrees(16), second);
        const expected = replay(second, replay(first));
        expect(expected.length).toBe(90000);
        expect(decompressLzx(w.finish(), 16, expected.length)).toEqual(Uint8Array.from(expected));
    });

    test('aligned-offset blocks', () => {
        const w = new LzxWriter(17);
        const ops = script(70000, 3, 0, 257, 131069);
        w.compressed(ALIGNED, wideTrees(17), ops);
        const expected = replay(ops);
        expect(decompressLzx(w.finish(), 17, expected.length)).toEqual(Uint8Array.from(expected));
    });

    test('matches reach back across the window wrap', () => {
        const w = new LzxWriter(15);
        const ops = script(5 * FRAME + 1234, 4, 0, 257, 32765);
        w.compressed(VERBATIM, wideTrees(15), ops);
        const expected = replay(ops);
        expect(decompressLzx(w.finish(), 15, expected.length)).toEqual(Uint8Array.from(expected));
    });

    test('uncompressed blocks: odd size pad, repeat offsets carried in the header, frame straddle', () => {
        const w = new LzxWriter(15);
        const lead = script(1001, 5, 0, 257, 32765);
        w.compressed(VERBATIM, wideTrees(15), lead);
        const out = replay(lead);
        const raw = Array.from({length: FRAME + 777}, (_, i) => (i * 7 + 3) & 0xff);
        w.uncompressed(raw);
        out.push(...raw);
        const tail = script(3000, 6, out.length, 128, 32765);
        w.compressed(ALIGNED, sparseTrees(15), tail);
        replay(tail, out);
        expect(decompressLzx(w.finish(), 15, out.length)).toEqual(Uint8Array.from(out));
    });

    test('an uncompressed header that ends on a word boundary still pads a full word', () => {
        // 1 header bit + 27 block-header bits leave 4 bits in the word; a
        // verbatim block first moves the next block header onto a boundary.
        for (let lits = 1; lits <= 16; lits++) {
            const w = new LzxWriter(15);
            const ops: Op[] = Array.from({length: lits}, (_, i) => ({lit: i}));
            w.compressed(VERBATIM, wideTrees(15), ops);
            const raw = [9, 8, 7, 6, 5];
            w.uncompressed(raw);
            const expected = [...replay(ops), ...raw];
            expect(decompressLzx(w.finish(), 15, expected.length)).toEqual(Uint8Array.from(expected));
        }
    });

    test('E8 call translation', () => {
        const size = 0x4000;
        const data = new Array<number>(FRAME + 200).fill(0x90);
        const put = (pos: number, abs: number) => {
            data[pos] = 0xe8;
            for (let i = 0; i < 4; i++) data[pos + 1 + i] = (abs >>> (8 * i)) & 0xff;
        };
        put(100, 0x200);                 // in range: becomes target - position
        put(300, -50 >>> 0);             // -position <= abs < 0: becomes abs + size
        put(500, size);                  // one past the range: untouched
        put(700, -701 >>> 0);            // below -position: untouched
        put(900, 0x10);
        put(901, 0x7fffffff);            // inside the operand of the E8 at 900: not an opcode
        put(FRAME - 9, 0x20);            // within the last 10 bytes of a frame: untouched
        put(FRAME + 50, 0x30);           // second frame: position counts from the stream start
        const w = new LzxWriter(15, size);
        w.uncompressed(data);

        const expected = data.slice();
        const fix = (pos: number, rel: number) => {
            for (let i = 0; i < 4; i++) expected[pos + 1 + i] = (rel >>> (8 * i)) & 0xff;
        };
        fix(100, 0x200 - 100);
        fix(300, -50 + size);
        fix(FRAME + 50, (0x30 - (FRAME + 50)) >>> 0);
        // 900's operand is overwritten by the E8 planted at 901 (0xE8 then 0xFF 0xFF 0xFF):
        // abs = 0xFFFFFFE8 = -24, in range, so it becomes -24 + size.
        fix(900, -24 + size);
        expect(decompressLzx(w.finish(), 15, expected.length)).toEqual(Uint8Array.from(expected));

        const plain = new LzxWriter(15);
        plain.uncompressed(data);
        expect(decompressLzx(plain.finish(), 15, data.length)).toEqual(Uint8Array.from(data));
    });

    test('corrupt streams are refused, not decoded to garbage', () => {
        const w = new LzxWriter(15);
        const ops = script(5000, 7, 0, 257, 32765);
        w.compressed(VERBATIM, wideTrees(15), ops);
        const good = w.finish();
        expect(() => decompressLzx(good.subarray(0, good.length >> 1), 15, 5000)).toThrow(/LZX/);
        expect(() => decompressLzx(good, 14, 5000)).toThrow(/window/);
        expect(() => decompressLzx(good, 22, 5000)).toThrow(/window/);

        // Block type 0 is not defined.
        expect(() => decompressLzx(new Uint8Array(16), 15, 10)).toThrow(/block type/);

        // Pretree with all twenty lengths = 1 is over-subscribed.
        const bad = new LzxWriter(15);
        (bad as unknown as {bits(v: number, n: number): void}).bits(VERBATIM, 3);
        (bad as unknown as {bits(v: number, n: number): void}).bits(100, 24);
        for (let i = 0; i < 20; i++) (bad as unknown as {bits(v: number, n: number): void}).bits(1, 4);
        expect(() => decompressLzx(bad.finish(), 15, 100)).toThrow(/over-subscribed/);
    });
});

function lzxCabinet(files: Array<{name: string; data: Uint8Array}>, windowBits: number, blocks: Array<{data: Uint8Array; size: number}>): Uint8Array {
    const enc = new TextEncoder();
    const names = files.map(f => enc.encode(f.name + '\0'));
    const filesOffset = 36 + 8;
    const dataOffset = filesOffset + names.reduce((n, name) => n + 16 + name.length, 0);
    const total = dataOffset + blocks.reduce((n, b) => n + 8 + b.data.length, 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x4643534d, true);
    dv.setUint32(8, total, true);
    dv.setUint32(16, filesOffset, true);
    dv.setUint8(24, 3);
    dv.setUint8(25, 1);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, files.length, true);
    dv.setUint32(36, dataOffset, true);
    dv.setUint16(40, blocks.length, true);
    dv.setUint16(42, 3 | (windowBits << 8), true);
    let p = filesOffset;
    let fileOffset = 0;
    files.forEach((f, i) => {
        dv.setUint32(p, f.data.length, true);
        dv.setUint32(p + 4, fileOffset, true);
        out.set(names[i]!, p + 16);
        p += 16 + names[i]!.length;
        fileOffset += f.data.length;
    });
    for (const b of blocks) {
        dv.setUint16(p + 4, b.data.length, true);
        dv.setUint16(p + 6, b.size, true);
        out.set(b.data, p + 8);
        p += 8 + b.data.length;
    }
    return out;
}

describe('LZX cabinet folder', () => {
    function build() {
        const w = new LzxWriter(16);
        const ops = script(2 * FRAME + 4321, 8, 0, 257, 65533);
        w.compressed(VERBATIM, wideTrees(16), ops);
        const stream = w.finish();
        const plain = Uint8Array.from(replay(ops));
        const cuts = [0, ...w.frameCuts, stream.length];
        const blocks = [0, 1, 2].map(i => ({
            data: stream.subarray(cuts[i]!, cuts[i + 1]!),
            size: Math.min(FRAME, plain.length - i * FRAME),
        }));
        return {plain, blocks};
    }

    test('one frame per CFDATA block; files are slices of the folder stream', async () => {
        const {plain, blocks} = build();
        const a = plain.subarray(0, 40000);
        const b = plain.subarray(40000);
        const cab = lzxCabinet([{name: 'bin\\a.dat', data: a}, {name: 'b.dat', data: b}], 16, blocks);
        const files = await extractCabToMap(cab);
        expect([...files.keys()]).toEqual(['bin/a.dat', 'b.dat']);
        expect(files.get('bin/a.dat')).toEqual(a);
        expect(files.get('b.dat')).toEqual(b);
    });

    test('a block that is not one frame is refused', async () => {
        const {plain, blocks} = build();
        blocks[0] = {data: blocks[0]!.data, size: FRAME - 1};
        const cab = lzxCabinet([{name: 'a.dat', data: plain}], 16, blocks);
        expect(extractCabToMap(cab)).rejects.toThrow(/frame/);
    });
});
