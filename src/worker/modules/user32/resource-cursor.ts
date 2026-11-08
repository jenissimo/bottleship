import { System } from '../../core/system';
import { findResourceInPE } from '../kernel32/resource';

const RT_CURSOR = 1;
const RT_GROUP_CURSOR = 12;

// @transient(cursor images are re-decoded from the module resources on demand)
const resourceCursorHandles = new Map<string, number>();

export function resetResourceCursorHandles(): void {
    resourceCursorHandles.clear();
}

export interface DecodedCursor {
    width: number;
    height: number;
    pixels: Uint8Array;
    xHotspot: number;
    yHotspot: number;
}

export function decodeCursorResource(view: DataView, at: number, size: number): DecodedCursor | null {
    if (size < 4 + 40) return null;
    const xHotspot = view.getUint16(at, true);
    const yHotspot = view.getUint16(at + 2, true);
    const bi = at + 4;
    const headerSize = view.getUint32(bi, true);
    const width = view.getInt32(bi + 4, true);
    const height = Math.abs(view.getInt32(bi + 8, true)) >> 1;
    const bpp = view.getUint16(bi + 14, true);
    if (width <= 0 || height <= 0 || width > 256 || height > 256) return null;
    if (![1, 4, 8, 24, 32].includes(bpp)) return null;
    const clrUsed = view.getUint32(bi + 32, true);
    const paletteCount = bpp <= 8 ? (clrUsed || (1 << bpp)) : 0;
    const palette = bi + headerSize;
    const xorBase = palette + paletteCount * 4;
    const xorStride = ((width * bpp + 31) >> 5) << 2;
    const andBase = xorBase + xorStride * height;
    const andStride = ((width + 31) >> 5) << 2;
    if (andBase + andStride * height > at + size) return null;
    const pixels = new Uint8Array(width * height * 4);
    let hasAlpha = false;
    if (bpp === 32) {
        for (let y = 0; y < height && !hasAlpha; y++) {
            for (let x = 0; x < width; x++) {
                if (view.getUint8(xorBase + y * xorStride + x * 4 + 3) !== 0) { hasAlpha = true; break; }
            }
        }
    }
    for (let y = 0; y < height; y++) {
        const srcRow = height - 1 - y;
        const xorRow = xorBase + srcRow * xorStride;
        const andRow = andBase + srcRow * andStride;
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 255;
            if (bpp <= 8) {
                const bitPos = x * bpp;
                const byte = view.getUint8(xorRow + (bitPos >> 3));
                const index = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
                const p = palette + index * 4;
                b = view.getUint8(p); g = view.getUint8(p + 1); r = view.getUint8(p + 2);
            } else {
                const p = xorRow + x * (bpp >> 3);
                b = view.getUint8(p); g = view.getUint8(p + 1); r = view.getUint8(p + 2);
                if (hasAlpha) a = view.getUint8(p + 3);
            }
            const masked = hasAlpha ? 0 : (view.getUint8(andRow + (x >> 3)) >> (7 - (x & 7))) & 1;
            if (masked) {
                if (r === 0 && g === 0 && b === 0) a = 0;
                else { r = 0; g = 0; b = 0; }
            }
            const o = (y * width + x) * 4;
            pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = a;
        }
    }
    return { width, height, pixels, xHotspot, yHotspot };
}

export function loadResourceCursor(mem: Uint8Array, hInstance: number, name: number | string): number {
    const key = `${hInstance >>> 0}:${name}`;
    const cached = resourceCursorHandles.get(key);
    const provider = System.getInstance().resourceProvider;
    if (cached && provider.getUserObject?.(cached)) return cached;
    const group = findResourceInPE(mem, hInstance, RT_GROUP_CURSOR, name);
    if (!group || group.size < 6) return 0;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const dir = group.moduleBase + group.dataRVA;
    const count = view.getUint16(dir + 4, true);
    if (count === 0 || group.size < 6 + count * 14) return 0;
    const id = view.getUint16(dir + 6 + 12, true);
    const entry = findResourceInPE(mem, hInstance, RT_CURSOR, id);
    if (!entry) return 0;
    const cursor = decodeCursorResource(view, entry.moduleBase + entry.dataRVA, entry.size);
    if (!cursor) return 0;
    const handle = provider.registerUserObject({
        type: 'CURSOR',
        width: cursor.width,
        height: cursor.height,
        pixels: cursor.pixels,
        loading: false,
        xHotspot: cursor.xHotspot,
        yHotspot: cursor.yHotspot,
    });
    resourceCursorHandles.set(key, handle);
    return handle;
}
