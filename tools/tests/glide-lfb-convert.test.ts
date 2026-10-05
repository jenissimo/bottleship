import { describe, expect, test } from "bun:test";
import { convertLfbToRgba } from "../../src/worker/modules/glide2x/presenter";
import { stageLfbRows } from "../../src/worker/backends/webgpu/glide/glide-backend-executor";
import {
    GR_COLORFORMAT_ABGR,
    GR_COLORFORMAT_ARGB,
    GR_COLORFORMAT_BGRA,
    GR_COLORFORMAT_RGBA,
    GR_LFBWRITEMODE_1555,
    GR_LFBWRITEMODE_1555_DEPTH,
    GR_LFBWRITEMODE_555,
    GR_LFBWRITEMODE_555_DEPTH,
    GR_LFBWRITEMODE_565,
    GR_LFBWRITEMODE_565_DEPTH,
    GR_LFBWRITEMODE_888,
    GR_LFBWRITEMODE_8888,
    GR_LFBWRITEMODE_ZA16,
} from "../../src/worker/modules/glide2x/constants";

// The scalar decode this file's fast path replaced, kept verbatim as the oracle.
// A LUT and a word store are only worth having if they are byte-identical to it.
const EXPAND_5 = new Uint8Array(32);
for (let i = 0; i < 32; i++) EXPAND_5[i] = Math.round(i * 255 / 31);
const EXPAND_6 = new Uint8Array(64);
for (let i = 0; i < 64; i++) EXPAND_6[i] = Math.round(i * 255 / 63);

function decodeLfb8888Pixel(raw32: number, colorFormat: number, out: Uint8Array, o: number): void {
    switch (colorFormat | 0) {
        case GR_COLORFORMAT_ABGR:
            out[o] = raw32 & 0xff;
            out[o + 1] = (raw32 >>> 8) & 0xff;
            out[o + 2] = (raw32 >>> 16) & 0xff;
            out[o + 3] = (raw32 >>> 24) & 0xff;
            return;
        case GR_COLORFORMAT_RGBA:
            out[o] = (raw32 >>> 24) & 0xff;
            out[o + 1] = (raw32 >>> 16) & 0xff;
            out[o + 2] = (raw32 >>> 8) & 0xff;
            out[o + 3] = raw32 & 0xff;
            return;
        case GR_COLORFORMAT_BGRA:
            out[o] = (raw32 >>> 8) & 0xff;
            out[o + 1] = (raw32 >>> 16) & 0xff;
            out[o + 2] = (raw32 >>> 24) & 0xff;
            out[o + 3] = raw32 & 0xff;
            return;
        case GR_COLORFORMAT_ARGB:
        default:
            out[o] = (raw32 >>> 16) & 0xff;
            out[o + 1] = (raw32 >>> 8) & 0xff;
            out[o + 2] = raw32 & 0xff;
            out[o + 3] = (raw32 >>> 24) & 0xff;
            return;
    }
}

function referenceConvert(
    src: Uint8Array, pitch: number, width: number, height: number,
    mode: number, lfbColorFormat: number, fourByte: boolean,
): Uint8Array {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const rowBase = y * pitch;
        let dst = y * width * 4;
        if (fourByte) {
            for (let x = 0; x < width; x++, dst += 4) {
                const s = rowBase + x * 4;
                const raw32 = (
                    (src[s] ?? 0) | ((src[s + 1] ?? 0) << 8) |
                    ((src[s + 2] ?? 0) << 16) | ((src[s + 3] ?? 0) << 24)
                ) >>> 0;
                switch (mode) {
                    case GR_LFBWRITEMODE_565_DEPTH: {
                        const raw = raw32 & 0xffff;
                        rgba[dst] = EXPAND_5[(raw >>> 11) & 0x1f]!;
                        rgba[dst + 1] = EXPAND_6[(raw >>> 5) & 0x3f]!;
                        rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                        rgba[dst + 3] = 255;
                        break;
                    }
                    case GR_LFBWRITEMODE_555_DEPTH: {
                        const raw = raw32 & 0xffff;
                        rgba[dst] = EXPAND_5[(raw >>> 10) & 0x1f]!;
                        rgba[dst + 1] = EXPAND_5[(raw >>> 5) & 0x1f]!;
                        rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                        rgba[dst + 3] = 255;
                        break;
                    }
                    case GR_LFBWRITEMODE_1555_DEPTH: {
                        const raw = raw32 & 0xffff;
                        rgba[dst] = EXPAND_5[(raw >>> 10) & 0x1f]!;
                        rgba[dst + 1] = EXPAND_5[(raw >>> 5) & 0x1f]!;
                        rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                        rgba[dst + 3] = (raw & 0x8000) ? 255 : 0;
                        break;
                    }
                    case GR_LFBWRITEMODE_888:
                        decodeLfb8888Pixel(raw32, lfbColorFormat, rgba, dst);
                        rgba[dst + 3] = 255;
                        break;
                    default:
                        decodeLfb8888Pixel(raw32, lfbColorFormat, rgba, dst);
                        break;
                }
            }
            continue;
        }
        for (let x = 0; x < width; x++, dst += 4) {
            const s = rowBase + x * 2;
            const raw = (src[s] ?? 0) | ((src[s + 1] ?? 0) << 8);
            switch (mode) {
                case GR_LFBWRITEMODE_555:
                    rgba[dst] = EXPAND_5[(raw >>> 10) & 0x1f]!;
                    rgba[dst + 1] = EXPAND_5[(raw >>> 5) & 0x1f]!;
                    rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                    rgba[dst + 3] = 255;
                    break;
                case GR_LFBWRITEMODE_1555:
                    rgba[dst] = EXPAND_5[(raw >>> 10) & 0x1f]!;
                    rgba[dst + 1] = EXPAND_5[(raw >>> 5) & 0x1f]!;
                    rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                    rgba[dst + 3] = (raw & 0x8000) ? 255 : 0;
                    break;
                case GR_LFBWRITEMODE_ZA16:
                    rgba[dst] = 0; rgba[dst + 1] = 0; rgba[dst + 2] = 0; rgba[dst + 3] = 255;
                    break;
                default:
                    rgba[dst] = EXPAND_5[(raw >>> 11) & 0x1f]!;
                    rgba[dst + 1] = EXPAND_6[(raw >>> 5) & 0x3f]!;
                    rgba[dst + 2] = EXPAND_5[raw & 0x1f]!;
                    rgba[dst + 3] = 255;
                    break;
            }
        }
    }
    return rgba;
}

const COLOR_FORMATS = [GR_COLORFORMAT_ARGB, GR_COLORFORMAT_ABGR, GR_COLORFORMAT_RGBA, GR_COLORFORMAT_BGRA];
const NARROW_MODES = [GR_LFBWRITEMODE_565, GR_LFBWRITEMODE_555, GR_LFBWRITEMODE_1555, GR_LFBWRITEMODE_ZA16];
const WIDE_MODES = [
    GR_LFBWRITEMODE_8888, GR_LFBWRITEMODE_888,
    GR_LFBWRITEMODE_565_DEPTH, GR_LFBWRITEMODE_555_DEPTH, GR_LFBWRITEMODE_1555_DEPTH,
];

const WIDTH = 37;   // deliberately not a multiple of anything
const HEIGHT = 11;

/** Deterministic pseudo-random bytes — the same source for both implementations. */
function fill(bytes: Uint8Array, seed: number): void {
    let s = seed >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        bytes[i] = (s >>> 16) & 0xff;
    }
}

function run(mode: number, fmt: number, fourByte: boolean, byteOffset: number): void {
    const bpp = fourByte ? 4 : 2;
    const pitch = WIDTH * bpp + bpp * 3; // padded rows, as a real surface has
    const size = pitch * HEIGHT;
    const backing = new ArrayBuffer(size + byteOffset);
    const src = new Uint8Array(backing, byteOffset, size);
    fill(src, (mode * 31 + fmt * 7 + bpp) >>> 0);

    const expected = referenceConvert(src, pitch, WIDTH, HEIGHT, mode, fmt, fourByte);
    const actualBytes = new Uint8Array(WIDTH * HEIGHT * 4);
    convertLfbToRgba(src, pitch, WIDTH, HEIGHT, mode, fmt, fourByte,
        new Uint32Array(actualBytes.buffer, 0, WIDTH * HEIGHT));

    expect(Array.from(actualBytes)).toEqual(Array.from(expected));
}

describe("glide LFB -> RGBA conversion", () => {
    test("16-bit modes match the scalar decode, byte for byte", () => {
        for (const mode of NARROW_MODES) {
            for (const fmt of COLOR_FORMATS) run(mode, fmt, false, 0);
        }
    });

    test("32-bit modes match the scalar decode, byte for byte", () => {
        for (const mode of WIDE_MODES) {
            for (const fmt of COLOR_FORMATS) run(mode, fmt, true, 0);
        }
    });

    // The typed-array fast path needs element alignment; an unaligned span must take
    // the byte-assembly fallback and still produce the same pixels, not throw.
    test("unaligned source spans agree with the aligned ones", () => {
        for (const mode of NARROW_MODES) run(mode, GR_COLORFORMAT_ARGB, false, 1);
        for (const mode of WIDE_MODES) run(mode, GR_COLORFORMAT_ARGB, true, 2);
    });

    test("upload staging swaps R/B and pads rows exactly as a byte copy would", () => {
        for (const bgra of [false, true]) {
            for (const [w, h] of [[37, 11], [64, 5], [640, 3]] as const) {
                const srcRow = w * 4;
                const dstRow = (srcRow + 255) & ~255;
                const pixels = new Uint8Array(srcRow * h);
                fill(pixels, w * 7 + (bgra ? 1 : 0));

                const expected = new Uint8Array(dstRow * h);
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < srcRow; x += 4) {
                        const s = y * srcRow + x, d = y * dstRow + x;
                        expected[d] = bgra ? pixels[s + 2]! : pixels[s]!;
                        expected[d + 1] = pixels[s + 1]!;
                        expected[d + 2] = bgra ? pixels[s]! : pixels[s + 2]!;
                        expected[d + 3] = pixels[s + 3]!;
                    }
                }

                const actual = new Uint8Array(dstRow * h);
                stageLfbRows(pixels, actual, srcRow, dstRow, h, bgra);
                expect(Array.from(actual)).toEqual(Array.from(expected));
            }
        }
    });

    test("every 16-bit code point round-trips, not just the sampled ones", () => {
        for (const mode of NARROW_MODES) {
            const src = new Uint8Array(65536 * 2);
            for (let raw = 0; raw < 65536; raw++) {
                src[raw * 2] = raw & 0xff;
                src[raw * 2 + 1] = raw >>> 8;
            }
            const expected = referenceConvert(src, 65536 * 2, 65536, 1, mode, GR_COLORFORMAT_ARGB, false);
            const actual = new Uint8Array(65536 * 4);
            convertLfbToRgba(src, 65536 * 2, 65536, 1, mode, GR_COLORFORMAT_ARGB, false,
                new Uint32Array(actual.buffer));
            expect(actual).toEqual(expected);
        }
    });
});
