import { expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { decodeWave } from '../../src/worker/core/audio/directmusic/wave';

function syntheticGsmWave(): Uint8Array {
    const blocks = 8;
    const data = new Uint8Array(65 * blocks);
    let x = 1;
    for (let i = 0; i < data.length; i++) {
        x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
        data[i] = (x >>> 16) & 0xff;
    }
    const fmt = new Uint8Array(20);
    const f = new DataView(fmt.buffer);
    f.setUint16(0, 0x31, true); f.setUint16(2, 1, true); f.setUint32(4, 8000, true); f.setUint32(8, 1625, true);
    f.setUint16(12, 65, true); f.setUint16(14, 0, true); f.setUint16(16, 2, true); f.setUint16(18, 320, true);
    const out = new Uint8Array(12 + 8 + fmt.length + 8 + data.length);
    const v = new DataView(out.buffer);
    const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, out.length - 8, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, fmt.length, true); out.set(fmt, 20);
    tag(40, 'data'); v.setUint32(44, data.length, true); out.set(data, 48);
    return out;
}

test('GSM 6.10 (WAV49) decodes bit-exact to the libgsm reference', () => {
    const wave = decodeWave(syntheticGsmWave());
    expect(wave).not.toBeNull();
    expect(wave!.frames).toBe(2560);
    const pcm = new Int16Array(wave!.frames);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(wave!.left[i]! * 32768);
    expect(Array.from(pcm.slice(0, 12))).toEqual([0, 0, 0, 336, 424, 336, 136, 96, 112, 416, 448, 312]);
    expect(createHash('sha256').update(new Uint8Array(pcm.buffer)).digest('hex'))
        .toBe('0bd22b55c56db15dfc572c5423ba29632bb154c6a9e5c95a4df338e199a421cb');
});
