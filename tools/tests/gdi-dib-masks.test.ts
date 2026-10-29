/**
 * A 16-bit DIB section is 5-5-5 under BI_RGB and whatever its BI_BITFIELDS masks say
 * otherwise. Reading every 16-bit DIB as 5-6-5 shifts green into red for a BI_RGB one.
 */
import { expect, test } from "bun:test";
import { dibColorMasks, resolveDibSectionRectRgba } from "../../src/worker/modules/gdi32/bitmap-resolve";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";

const BITS_PTR = 0x800;

function readPixel(word: number, dibMasks?: number[]): number[] {
    const mem = new Uint8Array(BITS_PTR + 4);
    mem[BITS_PTR] = word & 0xff;
    mem[BITS_PTR + 1] = word >> 8;
    const hBitmap = SystemResourceProvider.getInstance().registerUserObject({
        type: "BITMAP", width: 1, height: 1,
        bitsPtr: BITS_PTR, dibBpp: 16, dibStride: 4, dibTopDown: true, dibMasks,
    } as never);
    return [...resolveDibSectionRectRgba(hBitmap, mem, 0, 0, 1, 1)!.data];
}

test("BI_RGB 16-bit is 5-5-5", () => {
    expect(readPixel(0x7c00)).toEqual([255, 0, 0, 255]);
    expect(readPixel(0x03e0)).toEqual([0, 255, 0, 255]);
    expect(readPixel(0x001f)).toEqual([0, 0, 255, 255]);
});

test("BI_BITFIELDS 16-bit follows its masks", () => {
    const rgb565 = [0xf800, 0x07e0, 0x001f];
    expect(readPixel(0xf800, rgb565)).toEqual([255, 0, 0, 255]);
    expect(readPixel(0x07e0, rgb565)).toEqual([0, 255, 0, 255]);
    expect(readPixel(0x0400, rgb565)).toEqual([0, 130, 0, 255]);
});

test("dibColorMasks defaults per depth", () => {
    expect(dibColorMasks(16)).toEqual([0x7c00, 0x03e0, 0x001f]);
    expect(dibColorMasks(32)).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
    expect(dibColorMasks(16, [0xf800, 0x07e0, 0x001f])).toEqual([0xf800, 0x07e0, 0x001f]);
});
