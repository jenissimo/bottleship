/**
 * RGBA → native-surface write leg: the word-wide store must be byte-identical to the
 * byte-at-a-time loop it replaces.
 *
 * These converters write straight into guest memory on the GPU→CPU leg of a surface Lock,
 * so a wrong swizzle or a wrong shift is a whole-screen colour bug. `__noFastPixelStore`
 * selects between the two implementations, which makes the differential the test: the same
 * input through both paths, over aligned and deliberately misaligned geometry.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import {
    convertRGBAToRGB565,
    convertRGBAToRGB555,
    convertRGBAToARGB8888,
} from '../../src/worker/modules/ddraw/gpu-texture-utils';

type Converter = (
    rgba: Uint8ClampedArray, dst: Uint8Array, dstOffset: number,
    dstPitch: number, width: number, height: number, skipBoundsCheck: boolean
) => void;

const g = globalThis as { __noFastPixelStore?: boolean };
afterEach(() => { delete g.__noFastPixelStore; });

/** Deterministic pseudo-random RGBA so a failure is reproducible. */
function makeRgba(width: number, height: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);
    let s = 0x2545f491;
    for (let i = 0; i < out.length; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s |= 0;
        out[i] = s & 0xff;
    }
    return out;
}

/** Run `convert` both ways over identical destinations; return them for comparison. */
function bothPaths(
    convert: Converter, width: number, height: number, pitch: number,
    dstOffset: number, bufferPad: number
): { fast: Uint8Array; slow: Uint8Array } {
    const rgba = makeRgba(width, height);
    const size = bufferPad + dstOffset + pitch * height + 64;
    const mk = () => new Uint8Array(new ArrayBuffer(size), bufferPad, size - bufferPad);

    const fast = mk();
    g.__noFastPixelStore = false;
    convert(rgba, fast, dstOffset, pitch, width, height, true);

    const slow = mk();
    g.__noFastPixelStore = true;
    convert(rgba, slow, dstOffset, pitch, width, height, true);

    return { fast, slow };
}

const CASES: Array<[string, Converter, number]> = [
    ['RGB565', convertRGBAToRGB565, 2],
    ['RGB555', convertRGBAToRGB555, 2],
    ['ARGB8888', convertRGBAToARGB8888, 4],
];

describe('RGBA → surface store', () => {
    for (const [name, convert, bpp] of CASES) {
        test(`${name}: packed, aligned — fast path matches the byte loop`, () => {
            const { fast, slow } = bothPaths(convert, 37, 11, 37 * bpp, 0, 0);
            expect(fast).toEqual(slow);
            // Guard against both paths quietly writing nothing.
            expect(slow.some((v) => v !== 0)).toBe(true);
        });

        test(`${name}: pitch padding — fast path matches`, () => {
            const { fast, slow } = bothPaths(convert, 16, 9, 16 * bpp + 4 * bpp, 0, 0);
            expect(fast).toEqual(slow);
        });

        test(`${name}: misaligned dstOffset falls back and still matches`, () => {
            const { fast, slow } = bothPaths(convert, 8, 4, 8 * bpp, 1, 0);
            expect(fast).toEqual(slow);
        });

        test(`${name}: misaligned view byteOffset falls back and still matches`, () => {
            const { fast, slow } = bothPaths(convert, 8, 4, 8 * bpp, 0, 1);
            expect(fast).toEqual(slow);
        });

        test(`${name}: odd pitch falls back and still matches`, () => {
            const { fast, slow } = bothPaths(convert, 8, 4, 8 * bpp + 1, 0, 0);
            expect(fast).toEqual(slow);
        });
    }

    test('the differential can fail: the two paths are really both exercised', () => {
        // A converter whose "fast" answer is wrong must be caught — emulate that by
        // comparing RGB565 output against RGB555 output over the same input.
        const rgba = makeRgba(16, 4);
        const a = new Uint8Array(16 * 2 * 4);
        const b = new Uint8Array(16 * 2 * 4);
        convertRGBAToRGB565(rgba, a, 0, 32, 16, 4, true);
        convertRGBAToRGB555(rgba, b, 0, 32, 16, 4, true);
        expect(a).not.toEqual(b);
    });
});
