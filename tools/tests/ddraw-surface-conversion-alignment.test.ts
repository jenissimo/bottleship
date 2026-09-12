import { describe, test, expect } from 'bun:test';
import { convertSurfaceToRGBA, type FormatInfo } from '../../src/worker/modules/ddraw/gpu-texture-utils';

// An app-supplied lpSurface and an app-supplied lPitch are both accepted on extent checks alone
// (CLAUDE.md §3.1 sanctions borrowed pointers), so the converter must survive a base or pitch that
// is not a multiple of the pixel size, and an output buffer that is not word-aligned.

const F565: FormatInfo = { bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 };
const F8888: FormatInfo = { bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0xff000000 };
const FX888: FormatInfo = { bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0 };

const W = 8;
const H = 4;

/** Deterministic, non-uniform pixel values so a wrong path shows up as a diff, not as zeros. */
function pixelAt(x: number, y: number, bytesPerPixel: number): number {
    const v = (y * W + x) * 2654435761;
    return bytesPerPixel === 2 ? (v >>> 3) & 0xffff : v >>> 0;
}

/** Lay the same pixels into `dst` at `offset` with `pitch`, little-endian. */
function paint(dst: Uint8Array, offset: number, pitch: number, bytesPerPixel: number): void {
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const p = pixelAt(x, y, bytesPerPixel);
            const o = offset + y * pitch + x * bytesPerPixel;
            for (let b = 0; b < bytesPerPixel; b++) dst[o + b] = (p >>> (b * 8)) & 0xff;
        }
    }
}

/** Same pixels, packed at offset 0 of a fresh word-aligned buffer — the reference layout. */
function reference(format: FormatInfo): Uint8Array {
    const bpp = format.bpp >> 3;
    const packed = new Uint8Array(W * H * bpp);
    paint(packed, 0, W * bpp, bpp);
    return convertSurfaceToRGBA(packed, 0, W, H, W * bpp, format);
}

function laidOut(format: FormatInfo, opts: { memSkew?: number; offset?: number; pad?: number }): {
    mem: Uint8Array; offset: number; pitch: number;
} {
    const bpp = format.bpp >> 3;
    const offset = opts.offset ?? 0;
    const pitch = W * bpp + (opts.pad ?? 0);
    const backing = new Uint8Array((opts.memSkew ?? 0) + offset + pitch * H + 16);
    const mem = opts.memSkew ? backing.subarray(opts.memSkew) : backing;
    paint(mem, offset, pitch, bpp);
    return { mem, offset, pitch };
}

describe('convertSurfaceToRGBA alignment', () => {
    const cases: Array<[string, FormatInfo, { memSkew?: number; offset?: number; pad?: number }]> = [
        ['RGB565 packed, odd surfacePtr', F565, { offset: 1 }],
        ['RGB565 odd pitch', F565, { pad: 1 }],
        ['RGB565 odd mem.byteOffset', F565, { memSkew: 1 }],
        ['ARGB8888 packed, surfacePtr % 4 === 2', F8888, { offset: 2 }],
        ['ARGB8888 pitch % 4 === 2', F8888, { pad: 2 }],
        ['XRGB8888 packed, surfacePtr % 4 === 1', FX888, { offset: 1 }],
        ['XRGB8888 pitch % 4 === 3', FX888, { pad: 3 }],
    ];

    for (const [name, format, opts] of cases) {
        test(name, () => {
            const { mem, offset, pitch } = laidOut(format, opts);
            const out = convertSurfaceToRGBA(mem, offset, W, H, pitch, format);
            expect(Array.from(out)).toEqual(Array.from(reference(format)));
        });
    }

    test('unaligned outBuffer receives the full result', () => {
        const bpp = 2;
        const packed = new Uint8Array(W * H * bpp);
        paint(packed, 0, W * bpp, bpp);
        const pool = new Uint8Array(W * H * 4 + 8);
        const view = pool.subarray(1, 1 + W * H * 4);
        const out = convertSurfaceToRGBA(packed, 0, W, H, W * bpp, F565, view);
        expect(out).toBe(view);
        expect(Array.from(view)).toEqual(Array.from(reference(F565)));
    });

    test('unaligned outBuffer receives the full result for a byte-addressed format', () => {
        // RGB888 writes through the Uint8Array, not the Uint32Array view — the scratch must
        // stand in for both or half the output lands in the wrong buffer.
        const F888: FormatInfo = { bpp: 24, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff, aMask: 0 };
        const packed = new Uint8Array(W * H * 3);
        paint(packed, 0, W * 3, 3);
        const pool = new Uint8Array(W * H * 4 + 8);
        const view = pool.subarray(1, 1 + W * H * 4);
        const out = convertSurfaceToRGBA(packed, 0, W, H, W * 3, F888, view);
        expect(out).toBe(view);
        expect(Array.from(view)).toEqual(Array.from(reference(F888)));
    });
});
