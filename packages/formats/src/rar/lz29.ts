// RAR 2.9 LZ coding and standard-filter framing, adapted from bitjs (MIT).
// Attribution and license: ./LICENSE-bitjs.txt. Arbitrary VM programs are refused.
import { crc32 } from '../installer/binary';

class Bits {
    pos = 0;
    constructor(readonly bytes: Uint8Array) {}
    peek(n: number): number {
        let value = 0, pos = this.pos;
        for (let left = n; left > 0;) {
            const take = Math.min(left, 8 - (pos & 7));
            value = value * 2 ** take + (((this.bytes[pos >>> 3] ?? 0) >>> (8 - (pos & 7) - take)) & ((1 << take) - 1));
            pos += take; left -= take;
        }
        return value;
    }
    read(n: number): number {
        if (this.pos + n > this.bytes.length * 8) throw new Error('RAR29: truncated bitstream');
        const v = this.peek(n); this.pos += n; return v;
    }
    align(): void { this.read((8 - (this.pos & 7)) & 7); }
    data(): number {
        switch (this.read(2)) {
            case 0: return this.read(4);
            case 1:
                if (this.peek(4) === 0) { this.read(4); return (0xffffff00 | this.read(8)) >>> 0; }
                return this.read(8);
            case 2: return this.read(16);
            default: return (this.read(16) * 65536 + this.read(16)) >>> 0;
        }
    }
}

function table(lengths: Uint8Array): Uint16Array {
    const counts = new Uint16Array(16), next = new Uint16Array(16), out = new Uint16Array(32768);
    for (const len of lengths) counts[len]++;
    let code = 0;
    for (let len = 1; len < 16; len++) {
        code = (code + (len === 1 ? 0 : counts[len - 1])) * 2;
        if (code + counts[len] > 2 ** len) throw new Error('RAR29: oversubscribed Huffman table');
        next[len] = code;
    }
    for (let symbol = 0; symbol < lengths.length; symbol++) {
        const len = lengths[symbol]; if (!len) continue;
        const start = next[len]++ << (15 - len), span = 1 << (15 - len);
        out.fill((symbol << 5) | len, start, start + span);
    }
    return out;
}

function symbol(bits: Bits, codes: Uint16Array): number {
    const code = codes[bits.peek(15)];
    if (!code) throw new Error('RAR29: invalid Huffman symbol');
    bits.read(code & 31); return code >>> 5;
}

const LENGTH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224];
const LBITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5];
const DIST = new Uint32Array(60), DBITS = new Uint8Array(60);
let distanceBase = 0, slot = 0;
for (const [bits, count] of [4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 14, 0, 12].entries()) {
    for (let j = 0; j < count; j++) { DIST[slot] = distanceBase; DBITS[slot++] = bits; distanceBase += 2 ** bits; }
}
const SHORT_DIST = [0, 4, 8, 16, 32, 64, 128, 192], SHORT_BITS = [2, 2, 3, 4, 5, 6, 6, 6];
interface FilterDef { kind: number; length: number; }
interface Filter { start: number; length: number; kind: number; registers: Uint32Array; }
const FILTERS = [[53, 0xad576887, 1], [57, 0x3cd7e57e, 2], [149, 0x1c2c5dc8, 4], [216, 0xbc85e701, 5], [29, 0x0e06077d, 6]];

function filterBlock(data: Uint8Array, f: Filter): Uint8Array {
    const out = data.slice();
    if (f.kind === 1 || f.kind === 2) {
        const view = new DataView(out.buffer);
        for (let i = 0; i < out.length - 4; i++) {
            if (out[i] !== 0xe8 && (f.kind !== 2 || out[i] !== 0xe9)) continue;
            const offset = f.start + ++i, address = view.getInt32(i, true);
            if (address < 0) { if (address + offset >= 0) view.setInt32(i, address + 0x1000000, true); }
            else if (address < 0x1000000) view.setInt32(i, address - offset, true);
            i += 3;
        }
    } else if (f.kind === 4) {
        const width = f.registers[0] - 3, red = f.registers[1];
        if (width < 0 || red > 2) throw new Error('RAR29: invalid RGB parameters');
        let src = 0;
        for (let channel = 0; channel < 3; channel++) {
            let previous = 0;
            for (let i = channel; i < out.length; i += 3) {
                let predicted = previous;
                if (i - width >= 3) {
                    const upper = out[i - width], left = out[i - width - 3], p = previous + upper - left;
                    const a = Math.abs(p - previous), b = Math.abs(p - upper), c = Math.abs(p - left);
                    predicted = a <= b && a <= c ? previous : b <= c ? upper : left;
                }
                out[i] = previous = (predicted - data[src++]) & 255;
            }
        }
        for (let i = red; i < out.length - 2; i += 3) { out[i] += out[i + 1]; out[i + 2] += out[i + 1]; }
    } else if (f.kind === 5) {
        const channels = f.registers[0];
        if (!channels || channels > 1024) throw new Error('RAR29: invalid audio channels');
        let src = 0;
        for (let channel = 0; channel < channels; channel++) {
            let previous = 0, delta = 0, d1 = 0, d2 = 0, k1 = 0, k2 = 0, k3 = 0, count = 0;
            const dif = new Float64Array(7);
            for (let i = channel; i < out.length; i += channels, count++) {
                const d3 = d2; d2 = delta - d1; d1 = delta;
                const current = data[src++];
                const predicted = ((((8 * previous + k1 * d1 + k2 * d2 + k3 * d3) >>> 3) & 255) - current) >>> 0;
                out[i] = predicted;
                delta = ((predicted - previous) << 24) >> 24; previous = predicted;
                const d = (current << 24) >> 21;
                dif[0] += Math.abs(d); dif[1] += Math.abs(d - d1); dif[2] += Math.abs(d + d1);
                dif[3] += Math.abs(d - d2); dif[4] += Math.abs(d + d2); dif[5] += Math.abs(d - d3); dif[6] += Math.abs(d + d3);
                if ((count & 31) === 0) {
                    let best = 0; for (let j = 1; j < 7; j++) if (dif[j] < dif[best]) best = j;
                    dif.fill(0);
                    if (best === 1 && k1 >= -16) k1--; else if (best === 2 && k1 < 16) k1++;
                    else if (best === 3 && k2 >= -16) k2--; else if (best === 4 && k2 < 16) k2++;
                    else if (best === 5 && k3 >= -16) k3--; else if (best === 6 && k3 < 16) k3++;
                }
            }
        }
    } else if (f.kind === 6) {
        const channels = f.registers[0];
        if (!channels || channels > 1024) throw new Error('RAR29: invalid delta channels');
        let src = 0;
        for (let channel = 0; channel < channels; channel++) {
            let previous = 0;
            for (let i = channel; i < out.length; i += channels) out[i] = previous = (previous - data[src++]) & 255;
        }
    } else throw new Error(`RAR29: unsupported standard filter ${f.kind}`);
    return out;
}

export interface RarPpmSession {
    decodeBlock(offset: number, output: Uint8Array, base: number): { written: number; consumed: number; ended: boolean };
    close(): void;
}

export function decodeRar29(input: Uint8Array, expectedSize: number, createPpm?: (input: Uint8Array) => RarPpmSession): Uint8Array {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 512 * 1024 * 1024) throw new Error('RAR29: invalid output size');
    const bits = new Bits(input), out = new Uint8Array(expectedSize), old = new Uint8Array(404);
    let lit!: Uint16Array, dist!: Uint16Array, low!: Uint16Array, rep!: Uint16Array;
    let pos = 0, lastLength = 0, lastDistance = 0, lowRepeat = 0, previousLow = 0;
    const distances = new Uint32Array(4), definitions: FilterDef[] = [], filters: Filter[] = [];
    let lastFilter = 0, ended = false;
    let ppm: RarPpmSession | undefined;
    const readTables = () => {
        for (;;) {
            bits.align();
            if (bits.peek(1)) {
                if (!createPpm) throw new Error('RAR29: PPMd codec required');
                ppm ??= createPpm(input);
                const result = ppm.decodeBlock(bits.pos / 8, out, pos);
                pos = result.written; bits.pos = result.consumed * 8; ended = result.ended;
                if (ended) return;
                continue;
            }
            bits.read(1);
            if (!bits.read(1)) old.fill(0);
            const bl = new Uint8Array(20);
            for (let i = 0; i < bl.length; i++) {
                const len = bits.read(4);
                if (len === 15) {
                    const zeros = bits.read(4);
                    if (!zeros) bl[i] = 15;
                    else { const end = Math.min(bl.length, i + zeros + 2); bl.fill(0, i, end); i = end - 1; }
                } else bl[i] = len;
            }
            const bc = table(bl), lengths = new Uint8Array(404);
            for (let i = 0; i < lengths.length;) {
                const n = symbol(bits, bc);
                if (n < 16) { lengths[i] = (n + old[i]) & 15; i++; }
                else {
                    const count = (n === 16 || n === 18) ? bits.read(3) + 3 : bits.read(7) + 11;
                    if (n < 18 && !i) throw new Error('RAR29: repeat before table start');
                    const end = Math.min(lengths.length, i + count);
                    lengths.fill(n < 18 ? lengths[i - 1] : 0, i, end); i = end;
                }
            }
            lit = table(lengths.subarray(0, 299)); dist = table(lengths.subarray(299, 359));
            low = table(lengths.subarray(359, 376)); rep = table(lengths.subarray(376)); old.set(lengths);
            lowRepeat = previousLow = 0;
            return;
        }
    };
    const copy = (length: number, distance: number) => {
        if (!distance || distance > pos || pos + length > out.length) throw new Error(`RAR29: invalid match ${pos}+${length} distance ${distance}`);
        for (let i = 0; i < length; i++) { out[pos] = out[pos - distance]; pos++; }
    };
    const remember = (distance: number) => { distances.copyWithin(1, 0, 3); distances[0] = distance; };
    const vm = () => {
        const flags = bits.read(8);
        let length = (flags & 7) + 1;
        if (length === 7) length = bits.read(8) + 7;
        else if (length === 8) length = bits.read(16);
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) bytes[i] = bits.read(8);
        const v = new Bits(bytes);
        let index = lastFilter;
        if (flags & 128) {
            index = v.data();
            if (index === 0) { definitions.length = 0; lastFilter = 0; }
            else index--;
        }
        if (index > definitions.length || index > 1024) throw new Error('RAR29: invalid filter index');
        lastFilter = index;
        const fresh = index === definitions.length;
        const start = pos + v.data() + ((flags & 64) ? 258 : 0);
        const blockLength = (flags & 32) ? v.data() : (definitions[index]?.length ?? 0);
        const registers = new Uint32Array(7); registers[4] = blockLength;
        if (flags & 16) {
            const mask = v.read(7);
            for (let i = 0; i < 7; i++) if (mask & (1 << i)) registers[i] = v.data();
        }
        let kind = definitions[index]?.kind ?? 0;
        if (fresh) {
            const size = v.data();
            if (!size || size >= 65536) throw new Error('RAR29: invalid VM program size');
            const code = new Uint8Array(size);
            for (let i = 0; i < size; i++) code[i] = v.read(8);
            let xor = 0; for (const b of code) xor ^= b;
            if (xor) throw new Error('RAR29: VM checksum mismatch');
            kind = FILTERS.find(f => f[0] === size && f[1] === crc32(code))?.[2] ?? 0;
            if (!kind) throw new Error(`RAR29: unsupported VM program (${size}, CRC ${crc32(code).toString(16)})`);
            definitions.push({ kind, length: blockLength });
        } else definitions[index].length = blockLength;
        if (flags & 8) throw new Error('RAR29: VM global data is unsupported');
        if (start + blockLength > out.length || !blockLength) throw new Error('RAR29: invalid filter extent');
        filters.push({ start, length: blockLength, kind, registers });
    };
    try {
        readTables();
        while (!ended) {
            const n = symbol(bits, lit);
            if (n < 256) {
                if (pos >= out.length) throw new Error('RAR29: output overflow');
                out[pos++] = n; continue;
            }
            if (n === 256) {
                if (bits.read(1)) { readTables(); continue; }
                bits.read(1); break;
            }
            if (n === 257) { vm(); continue; }
            if (n === 258) { if (lastLength) copy(lastLength, lastDistance); continue; }
            let length: number, distance: number;
            if (n >= 271) {
                const l = n - 271;
                length = LENGTH[l] + 3 + bits.read(LBITS[l]);
                const d = symbol(bits, dist), count = DBITS[d];
                distance = DIST[d] + 1;
                if (count) {
                    if (d > 9) {
                        if (count > 4) distance += bits.read(count - 4) * 16;
                        if (lowRepeat) { lowRepeat--; distance += previousLow; }
                        else {
                            const lo = symbol(bits, low);
                            if (lo === 16) { lowRepeat = 15; distance += previousLow; }
                            else { distance += lo; previousLow = lo; }
                        }
                    } else distance += bits.read(count);
                }
                if (distance >= 8192) { length++; if (distance >= 262144) length++; }
                remember(distance);
            } else if (n < 263) {
                const d = n - 259; distance = distances[d];
                distances.copyWithin(1, 0, d); distances[0] = distance;
                const l = symbol(bits, rep); length = LENGTH[l] + 2 + bits.read(LBITS[l]);
            } else {
                const d = n - 263; distance = SHORT_DIST[d] + 1 + bits.read(SHORT_BITS[d]); length = 2; remember(distance);
            }
            lastLength = length; lastDistance = distance; copy(length, distance);
        }
        if (pos !== expectedSize) throw new Error(`RAR29: size mismatch ${pos}/${expectedSize}`);
        // Keep LZ history unfiltered until decoding ends; filters change output, never the dictionary.
        for (const f of filters) out.set(filterBlock(out.subarray(f.start, f.start + f.length), f), f.start);
        return out;
    } finally { ppm?.close(); }
}
