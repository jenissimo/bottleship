export interface WaveData {
    left: Float32Array;
    right: Float32Array;
    rate: number;
    frames: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_ADPCM = 2;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_IMA_ADPCM = 0x11;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const MS_COEF1 = [256, 512, 0, 192, 240, 460, 392];
const MS_COEF2 = [0, -256, 0, 64, 0, -208, -232];
const MS_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
    107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428,
    4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350,
    22385, 24623, 27086, 29794, 32767,
];

interface Format {
    tag: number;
    channels: number;
    rate: number;
    blockAlign: number;
    bits: number;
    coefs: Array<[number, number]>;
}

export function isRiffWave(bytes: Uint8Array): boolean {
    return bytes.length >= 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}

function clamp16(v: number): number {
    return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

function decodeMsAdpcm(data: Uint8Array, f: Format, out: Float32Array[]): number {
    const ch = f.channels;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let frame = 0;
    const pred = new Int32Array(ch), delta = new Int32Array(ch), s1 = new Int32Array(ch), s2 = new Int32Array(ch);
    for (let off = 0; off + 7 * ch <= data.length; off += f.blockAlign) {
        const blockEnd = Math.min(off + f.blockAlign, data.length);
        const perBlock = Math.floor(((blockEnd - off - 7 * ch) * 2) / ch) + 2;
        let p = off;
        for (let c = 0; c < ch; c++) pred[c] = Math.min(data[p++]!, f.coefs.length - 1);
        for (let c = 0; c < ch; c++) { delta[c] = view.getInt16(p, true); p += 2; }
        for (let c = 0; c < ch; c++) { s1[c] = view.getInt16(p, true); p += 2; }
        for (let c = 0; c < ch; c++) { s2[c] = view.getInt16(p, true); p += 2; }
        for (let c = 0; c < ch; c++) out[c]![frame] = s2[c]! / 32768;
        for (let c = 0; c < ch; c++) out[c]![frame + 1] = s1[c]! / 32768;
        let n = 0;
        const end = blockEnd;
        for (; p < end; p++) {
            const byte = data[p]!;
            for (const nibble of [byte >> 4, byte & 0x0f]) {
                const c = n % ch;
                const [c1, c2] = f.coefs[pred[c]!]!;
                const signed = nibble & 8 ? nibble - 16 : nibble;
                const value = clamp16(((s1[c]! * c1 + s2[c]! * c2) >> 8) + signed * delta[c]!);
                s2[c] = s1[c]!;
                s1[c] = value;
                delta[c] = Math.max(16, (MS_ADAPT[nibble]! * delta[c]!) >> 8);
                out[c]![frame + 2 + Math.floor(n / ch)] = value / 32768;
                n++;
            }
        }
        frame += perBlock;
    }
    return frame;
}

function decodeImaAdpcm(data: Uint8Array, f: Format, out: Float32Array[]): number {
    const ch = f.channels;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let frame = 0;
    for (let off = 0; off + 4 * ch <= data.length; off += f.blockAlign) {
        const blockEnd = Math.min(off + f.blockAlign, data.length);
        const perBlock = Math.floor(((blockEnd - off - 4 * ch) * 8) / (4 * ch)) + 1;
        const sample = new Int32Array(ch), index = new Int32Array(ch);
        for (let c = 0; c < ch; c++) {
            sample[c] = view.getInt16(off + c * 4, true);
            index[c] = Math.min(88, data[off + c * 4 + 2]!);
            out[c]![frame] = sample[c]! / 32768;
        }
        const pos = new Int32Array(ch).fill(1);
        let p = off + 4 * ch;
        const end = blockEnd;
        while (p < end) {
            for (let c = 0; c < ch && p < end; c++) {
                for (let k = 0; k < 4 && p < end; k++, p++) {
                    const byte = data[p]!;
                    for (const nibble of [byte & 0x0f, byte >> 4]) {
                        const step = IMA_STEP[index[c]!]!;
                        let diff = step >> 3;
                        if (nibble & 4) diff += step;
                        if (nibble & 2) diff += step >> 1;
                        if (nibble & 1) diff += step >> 2;
                        sample[c] = clamp16(nibble & 8 ? sample[c]! - diff : sample[c]! + diff);
                        index[c] = Math.max(0, Math.min(88, index[c]! + IMA_INDEX[nibble]!));
                        out[c]![frame + pos[c]!] = sample[c]! / 32768;
                        pos[c]!++;
                    }
                }
                if (ch === 1) break;
            }
        }
        frame += perBlock;
    }
    return frame;
}

export function decodeWave(bytes: Uint8Array): WaveData | null {
    if (!isRiffWave(bytes)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let format: Format | null = null;
    let data: Uint8Array | null = null;
    for (let p = 12; p + 8 <= bytes.length;) {
        const id = String.fromCharCode(bytes[p]!, bytes[p + 1]!, bytes[p + 2]!, bytes[p + 3]!);
        const size = view.getUint32(p + 4, true);
        const body = p + 8;
        const end = Math.min(bytes.length, body + size);
        if (id === "fmt " && end - body >= 16) {
            const tag = view.getUint16(body, true);
            const coefs: Array<[number, number]> = MS_COEF1.map((c, i) => [c, MS_COEF2[i]!]);
            if (tag === WAVE_FORMAT_ADPCM && end - body >= 22) {
                const count = view.getUint16(body + 20, true);
                if (count > 0 && body + 22 + count * 4 <= end) {
                    coefs.length = 0;
                    for (let i = 0; i < count; i++) coefs.push([view.getInt16(body + 22 + i * 4, true), view.getInt16(body + 24 + i * 4, true)]);
                }
            }
            const subFormat = tag === WAVE_FORMAT_EXTENSIBLE && end - body >= 40 ? view.getUint16(body + 24, true) : tag;
            format = {
                tag: subFormat, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true),
                blockAlign: view.getUint16(body + 12, true), bits: view.getUint16(body + 14, true), coefs,
            };
        } else if (id === "data") {
            data = bytes.subarray(body, end);
        }
        p = body + size + (size & 1);
    }
    if (!format || !data || format.channels < 1 || format.channels > 2 || format.rate <= 0) return null;
    const ch = format.channels;
    let tag = format.tag;
    if (tag === WAVE_FORMAT_EXTENSIBLE) return null;
    let capacity: number;
    if (tag === WAVE_FORMAT_ADPCM || tag === WAVE_FORMAT_IMA_ADPCM) {
        if (format.blockAlign <= (tag === WAVE_FORMAT_ADPCM ? 7 : 4) * ch) return null;
        const per = tag === WAVE_FORMAT_ADPCM
            ? ((format.blockAlign - 7 * ch) * 2) / ch + 2
            : ((format.blockAlign - 4 * ch) * 8) / (4 * ch) + 1;
        const whole = Math.floor(data.length / format.blockAlign);
        const rest = data.length - whole * format.blockAlign;
        const header = (tag === WAVE_FORMAT_ADPCM ? 7 : 4) * ch;
        const partial = rest < header ? 0 : tag === WAVE_FORMAT_ADPCM
            ? Math.floor(((rest - header) * 2) / ch) + 2
            : Math.floor(((rest - header) * 8) / (4 * ch)) + 1;
        capacity = whole * per + partial;
    } else if ((tag === WAVE_FORMAT_PCM && (format.bits === 8 || format.bits === 16 || format.bits === 24 || format.bits === 32))
        || (tag === WAVE_FORMAT_IEEE_FLOAT && format.bits === 32)) {
        capacity = Math.floor(data.length / ((format.bits >> 3) * ch));
    } else {
        return null;
    }
    const channels = Array.from({ length: ch }, () => new Float32Array(capacity));
    let frames = capacity;
    if (tag === WAVE_FORMAT_ADPCM) frames = decodeMsAdpcm(data, format, channels);
    else if (tag === WAVE_FORMAT_IMA_ADPCM) frames = decodeImaAdpcm(data, format, channels);
    else {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let f = 0; f < capacity; f++) {
            for (let c = 0; c < ch; c++) {
                const i = f * ch + c;
                channels[c]![f] = format.bits === 8 ? (data[i]! - 128) / 128
                    : format.bits === 16 ? dv.getInt16(i * 2, true) / 32768
                    : format.bits === 24 ? (((data[i * 3 + 2]! << 24) | (data[i * 3 + 1]! << 16) | (data[i * 3]! << 8)) >> 8) / 8388608
                    : tag === WAVE_FORMAT_PCM ? dv.getInt32(i * 4, true) / 2147483648 : dv.getFloat32(i * 4, true);
            }
        }
    }
    const left = channels[0]!;
    return { left, right: ch > 1 ? channels[1]! : left, rate: format.rate, frames };
}
