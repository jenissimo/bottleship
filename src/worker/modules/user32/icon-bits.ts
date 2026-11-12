const STATIC_COLORS: readonly number[] = [
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
    0xc0dcc0, 0xa6caf0,
    0xfffbf0, 0xa0a0a4, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];

const VGA16: readonly number[] = [
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
    0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];

export function ddbRowBytes(width: number, bitsPerPixel: number): number {
    return ((width * bitsPerPixel + 15) >> 4) << 1;
}

function indexedRgb(index: number, bitsPerPixel: number): number {
    if (bitsPerPixel === 1) return index ? 0xffffff : 0x000000;
    if (bitsPerPixel === 4) return VGA16[index & 15];
    if (index < 10) return STATIC_COLORS[index];
    if (index >= 246) return STATIC_COLORS[index - 236];
    return (index << 16) | (index << 8) | index;
}

function readPixelRgb(bits: Uint8Array, rowOffset: number, x: number, bitsPerPixel: number): number {
    switch (bitsPerPixel) {
        case 1: return indexedRgb((bits[rowOffset + (x >> 3)] >> (7 - (x & 7))) & 1, 1);
        case 4: return indexedRgb((bits[rowOffset + (x >> 1)] >> ((x & 1) ? 0 : 4)) & 15, 4);
        case 8: return indexedRgb(bits[rowOffset + x], 8);
        case 16: {
            const v = bits[rowOffset + x * 2] | (bits[rowOffset + x * 2 + 1] << 8);
            const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
            return (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((b << 3) | (b >> 2));
        }
        case 24: {
            const o = rowOffset + x * 3;
            return (bits[o + 2] << 16) | (bits[o + 1] << 8) | bits[o];
        }
        default: {
            const o = rowOffset + x * 4;
            return (bits[o + 2] << 16) | (bits[o + 1] << 8) | bits[o];
        }
    }
}

export function iconBitsLength(width: number, height: number, bitsPerPixel: number): number {
    return ddbRowBytes(width, bitsPerPixel) * height;
}

export function composeIconFromBits(
    andBits: Uint8Array,
    xorBits: Uint8Array,
    width: number,
    height: number,
    xorBitsPerPixel: number,
): Uint8Array {
    const pixels = new Uint8Array(width * height * 4);
    const andStride = ddbRowBytes(width, 1);
    const xorStride = ddbRowBytes(width, xorBitsPerPixel);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const andOn = ((andBits[y * andStride + (x >> 3)] >> (7 - (x & 7))) & 1) !== 0;
            const rgb = readPixelRgb(xorBits, y * xorStride, x, xorBitsPerPixel);
            const p = (y * width + x) * 4;
            if (andOn && rgb === 0) continue;
            if (andOn) {
                pixels[p + 3] = 255;
                continue;
            }
            pixels[p] = (rgb >> 16) & 255;
            pixels[p + 1] = (rgb >> 8) & 255;
            pixels[p + 2] = rgb & 255;
            pixels[p + 3] = 255;
        }
    }
    return pixels;
}
