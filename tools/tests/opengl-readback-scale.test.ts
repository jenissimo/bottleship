import { describe, expect, test } from "bun:test";
import {
    readbackSourceRect, resolveReadback,
} from "../../src/worker/backends/webgpu/opengl/opengl-readback";

/**
 * glReadPixels owes the guest an image in the guest's OWN drawable pixels, whatever the
 * internal render scale is. The two failure modes this pins are the ones a screenshot
 * cannot tell apart: reading the un-scaled rect (a cropped CORNER of the picture) and
 * reading the scaled rect without resolving it back down (the wrong number of pixels).
 */

/**
 * What copyTextureToBuffer hands back for `rect`: only the rect's own texels, at index 0,
 * padded to `bytesPerRow` — `fn` is evaluated in ABSOLUTE render-target coordinates, so a
 * resolve that forgets the rect origin reads a visibly wrong colour.
 */
function makeMapped(
    rect: { x: number; y: number; width: number; height: number },
    bytesPerRow: number, fn: (x: number, y: number) => number[],
): Uint8Array {
    const buf = new Uint8Array(bytesPerRow * rect.height);
    for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
            const c = fn(rect.x + x, rect.y + y);
            const o = y * bytesPerRow + x * 4;
            buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = c[3];
        }
    }
    return buf;
}

describe("readbackSourceRect", () => {
    test("scale 1 is the guest rect, flipped to texture orientation", () => {
        // GL (10, 20) 30x40 in a 640x480 drawable → top = 480 - 60 = 420.
        expect(readbackSourceRect(10, 20, 30, 40, 480, 1, 640, 480))
            .toEqual({ x: 10, y: 420, width: 30, height: 40 });
    });

    test("scale 2 covers the same picture, at twice the samples", () => {
        expect(readbackSourceRect(10, 20, 30, 40, 480, 2, 1280, 960))
            .toEqual({ x: 20, y: 840, width: 60, height: 80 });
    });

    test("a fractional scale snaps outward so no guest pixel loses its footprint", () => {
        // 640x480 at 1.5 → 960x720. GL (1,1) 2x2 → top = 477, so rows 715.5..718.5.
        const r = readbackSourceRect(1, 1, 2, 2, 480, 1.5, 960, 720);
        expect(r.x).toBe(1);            // floor(1.5)
        expect(r.x + r.width).toBe(5);  // ceil(4.5)
        expect(r.y).toBe(715);          // floor(715.5)
        expect(r.y + r.height).toBe(719); // ceil(718.5)
    });

    test("the full-screen read is the whole target", () => {
        expect(readbackSourceRect(0, 0, 640, 480, 480, 2, 1280, 960))
            .toEqual({ x: 0, y: 0, width: 1280, height: 960 });
    });
});

describe("resolveReadback", () => {
    test("scale 1 returns the source bytes, bottom row first", () => {
        const bytesPerRow = 256;
        // 4x3 guest drawable; colour encodes the texture row so the flip is observable.
        const rect = readbackSourceRect(0, 0, 4, 3, 3, 1, 4, 3);
        const src = makeMapped(rect, bytesPerRow, (x, y) => [x * 10, y * 10, 7, 255]);
        const out = resolveReadback(src, bytesPerRow, rect, 0, 0, 4, 3, 3, 1, false);
        expect(out.length).toBe(4 * 3 * 4);
        // GL row 0 is the BOTTOM = texture row 2.
        expect([...out.subarray(0, 4)]).toEqual([0, 20, 7, 255]);
        expect([...out.subarray(2 * 4 * 4, 2 * 4 * 4 + 4)]).toEqual([0, 0, 7, 255]); // GL row 2 = tex row 0
        // …and the columns keep their order.
        expect([...out.subarray(3 * 4, 3 * 4 + 4)]).toEqual([30, 20, 7, 255]);
    });

    test("scale 1 with a sub-rect reads that rect, not the corner", () => {
        const bytesPerRow = 256;
        // GL (2,1) 3x2 in an 8-tall drawable → texture rows 5..6, cols 2..4.
        const rect = readbackSourceRect(2, 1, 3, 2, 8, 1, 8, 8);
        const src = makeMapped(rect, bytesPerRow, (x, y) => [x, y, 0, 255]);
        const out = resolveReadback(src, bytesPerRow, rect, 2, 1, 3, 2, 8, 1, false);
        expect([...out.subarray(0, 4)]).toEqual([2, 6, 0, 255]);   // GL row 0 = tex row 6
        expect([...out.subarray(3 * 4, 3 * 4 + 4)]).toEqual([2, 5, 0, 255]); // GL row 1 = tex row 5
    });

    test("bgra targets are swizzled on the way out", () => {
        const bytesPerRow = 256;
        const rect = readbackSourceRect(0, 0, 1, 1, 1, 1, 1, 1);
        const src = makeMapped(rect, bytesPerRow, () => [1, 2, 3, 4]); // B=1 G=2 R=3 A=4
        const out = resolveReadback(src, bytesPerRow, rect, 0, 0, 1, 1, 1, 1, true);
        expect([...out]).toEqual([3, 2, 1, 4]);
    });

    test("scale 2 resolves 2x2 blocks down to the guest image the caller asked for", () => {
        const bytesPerRow = 256;
        // 2x2 guest → 4x4 render. Each guest pixel's 2x2 block is one flat colour, so the
        // box average is exact and the expected bytes are unambiguous.
        const block = [[10, 20], [30, 40]];
        const rect = readbackSourceRect(0, 0, 2, 2, 2, 2, 4, 4);
        expect(rect).toEqual({ x: 0, y: 0, width: 4, height: 4 });
        const src = makeMapped(rect, bytesPerRow, (x, y) => {
            const v = block[y >> 1][x >> 1];
            return [v, v, v, 255];
        });
        const out = resolveReadback(src, bytesPerRow, rect, 0, 0, 2, 2, 2, 2, false);
        expect(out.length).toBe(2 * 2 * 4);
        // GL row 0 = the BOTTOM guest row = texture block row 1 → [30, 40].
        expect([...out.subarray(0, 4)]).toEqual([30, 30, 30, 255]);
        expect([...out.subarray(4, 8)]).toEqual([40, 40, 40, 255]);
        expect([...out.subarray(8, 12)]).toEqual([10, 10, 10, 255]);
        expect([...out.subarray(12, 16)]).toEqual([20, 20, 20, 255]);
    });

    test("scale 2 averages within a block rather than point-sampling a corner", () => {
        const bytesPerRow = 256;
        // One guest pixel over a 2x2 render block of 0/100/100/200 → 100.
        const vals = [[0, 100], [100, 200]];
        const rect = readbackSourceRect(0, 0, 1, 1, 1, 2, 2, 2);
        const src = makeMapped(rect, bytesPerRow, (x, y) => {
            const v = vals[y][x];
            return [v, v, v, 255];
        });
        const out = resolveReadback(src, bytesPerRow, rect, 0, 0, 1, 1, 1, 2, false);
        expect([...out]).toEqual([100, 100, 100, 255]);
    });

    test("a supersampled sub-rect reads the right part of the picture", () => {
        const bytesPerRow = 512;
        // 8x8 guest, scale 2 → 16x16 render. Each render texel names the GUEST pixel it
        // belongs to, so a wrong source rect shows up as a wrong guest coordinate.
        const rect = readbackSourceRect(3, 2, 2, 2, 8, 2, 16, 16);
        expect(rect).toEqual({ x: 6, y: 8, width: 4, height: 4 });
        const src = makeMapped(rect, bytesPerRow, (x, y) => [x >> 1, y >> 1, 0, 255]);
        const out = resolveReadback(src, bytesPerRow, rect, 3, 2, 2, 2, 8, 2, false);
        // GL (3,2) is guest column 3, and GL row 0 = guest row from top 8-(2+2)+1 = 5.
        expect([...out.subarray(0, 4)]).toEqual([3, 5, 0, 255]);
        expect([...out.subarray(4, 8)]).toEqual([4, 5, 0, 255]);
        expect([...out.subarray(8, 12)]).toEqual([3, 4, 0, 255]);
        expect([...out.subarray(12, 16)]).toEqual([4, 4, 0, 255]);
    });

    test("a fractional scale still returns exactly the guest extent asked for", () => {
        const bytesPerRow = 512;
        const rect = readbackSourceRect(0, 0, 10, 10, 10, 1.5, 15, 15);
        const src = makeMapped(rect, bytesPerRow, () => [50, 60, 70, 255]);
        const out = resolveReadback(src, bytesPerRow, rect, 0, 0, 10, 10, 10, 1.5, false);
        expect(out.length).toBe(10 * 10 * 4);
        for (let i = 0; i < out.length; i += 4) {
            expect([...out.subarray(i, i + 4)]).toEqual([50, 60, 70, 255]);
        }
    });
});
