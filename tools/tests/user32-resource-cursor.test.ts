import { describe, expect, test } from "bun:test";
import { decodeCursorResource } from "../../src/worker/modules/user32/resource-cursor";

function monoCursor(xorBit: number, andBit: number): DataView {
    const w = 32, h = 32, stride = 4;
    const size = 4 + 40 + 8 + stride * h * 2;
    const v = new DataView(new ArrayBuffer(size));
    v.setUint16(0, 3, true);
    v.setUint16(2, 5, true);
    v.setUint32(4, 40, true);
    v.setInt32(8, w, true);
    v.setInt32(12, h * 2, true);
    v.setUint16(16, 1, true);
    v.setUint16(18, 1, true);
    v.setUint32(44, 0x000000, true);
    v.setUint32(48, 0xffffff, true);
    const xor = 4 + 40 + 8, and = xor + stride * h;
    for (let i = 0; i < stride * h; i++) {
        v.setUint8(xor + i, xorBit ? 0xff : 0);
        v.setUint8(and + i, andBit ? 0xff : 0);
    }
    return v;
}

const alphaCount = (p: Uint8Array) => p.filter((_, i) => i % 4 === 3 && p[i] > 0).length;

describe("application cursor resources", () => {
    test("a cursor whose AND mask covers everything is fully transparent", () => {
        const v = monoCursor(0, 1);
        const c = decodeCursorResource(v, 0, v.byteLength)!;
        expect([c.width, c.height, c.xHotspot, c.yHotspot]).toEqual([32, 32, 3, 5]);
        expect(alphaCount(c.pixels)).toBe(0);
    });

    test("negative control: an opaque white cursor stays visible", () => {
        const v = monoCursor(1, 0);
        const c = decodeCursorResource(v, 0, v.byteLength)!;
        expect(alphaCount(c.pixels)).toBe(32 * 32);
        expect(Array.from(c.pixels.slice(0, 4))).toEqual([255, 255, 255, 255]);
    });
});

describe("32bpp cursors", () => {
    function cursor32(alphaAt: (x: number, y: number) => number, andAll: boolean): DataView {
        const w = 4, h = 4;
        const buf = new Uint8Array(4 + 40 + w * h * 4 + 4 * h);
        const v = new DataView(buf.buffer);
        v.setUint32(4, 40, true);
        v.setInt32(8, w, true);
        v.setInt32(12, h * 2, true);
        v.setUint16(16, 1, true);
        v.setUint16(18, 32, true);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const p = 44 + (y * w + x) * 4;
            v.setUint8(p, 0x20); v.setUint8(p + 1, 0x40); v.setUint8(p + 2, 0x60); v.setUint8(p + 3, alphaAt(x, y));
        }
        if (andAll) for (let y = 0; y < h; y++) v.setUint8(44 + w * h * 4 + y * 4, 0xf0);
        return v;
    }
    const alphas = (px: Uint8Array) => [...px].filter((_, i) => i % 4 === 3);

    test("with any alpha set, the alpha channel decides and the AND mask is ignored", () => {
        const v = cursor32((x) => (x === 0 ? 0 : 0x80), true);
        const c = decodeCursorResource(v, 0, v.byteLength)!;
        expect(alphas(c.pixels)).toEqual([0, 0x80, 0x80, 0x80, 0, 0x80, 0x80, 0x80, 0, 0x80, 0x80, 0x80, 0, 0x80, 0x80, 0x80]);
        expect([...c.pixels.subarray(4, 7)]).toEqual([0x60, 0x40, 0x20]);
    });

    test("with every alpha zero, the AND mask applies as for older formats", () => {
        const opaque = decodeCursorResource(cursor32(() => 0, false), 0, cursor32(() => 0, false).byteLength)!;
        expect(alphas(opaque.pixels).every((a) => a === 255)).toBe(true);
        const masked = decodeCursorResource(cursor32(() => 0, true), 0, cursor32(() => 0, true).byteLength)!;
        expect([...masked.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    });
});
