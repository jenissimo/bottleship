import { describe, expect, it } from "bun:test";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";

const W = 5, H = 3;
const BITS = 0x1000, OUT = 0x4000, BMI = 0x8000;

function stride(bpp: number): number {
    return ((W * bpp / 8) + 3) & ~3;
}

function pixel(x: number, y: number): [number, number, number] {
    return [(x * 40 + 10) & 0xff, (y * 70 + 20) & 0xff, (x * 13 + y * 29 + 1) & 0xff];
}

function setup(bpp: number, topDown: boolean, outBpp: number, outHeight: number) {
    const mem = new Uint8Array(0x10000);
    const s = stride(bpp);
    for (let y = 0; y < H; y++) {
        const row = BITS + (topDown ? y : H - 1 - y) * s;
        for (let x = 0; x < W; x++) {
            const [r, g, b] = pixel(x, y);
            const o = row + x * (bpp / 8);
            mem[o] = b; mem[o + 1] = g; mem[o + 2] = r;
            if (bpp === 32) mem[o + 3] = 0;
        }
    }
    const hbm = SystemResourceProvider.getInstance().registerUserObject({
        type: "BITMAP", width: W, height: H, bitsPtr: BITS, dibStride: s, dibBpp: bpp, dibTopDown: topDown,
    });
    const dv = new DataView(mem.buffer);
    dv.setUint32(BMI, 40, true);
    dv.setInt32(BMI + 4, W, true);
    dv.setInt32(BMI + 8, outHeight, true);
    dv.setUint16(BMI + 12, 1, true);
    dv.setUint16(BMI + 14, outBpp, true);
    return { mem, hbm };
}

function readOut(mem: Uint8Array, outBpp: number, topDown: boolean): Array<[number, number, number]> {
    const bpp = outBpp / 8, s = outBpp === 24 ? stride(24) : W * 4;
    const px: Array<[number, number, number]> = [];
    for (let y = 0; y < H; y++) {
        const row = OUT + (topDown ? y : H - 1 - y) * s;
        for (let x = 0; x < W; x++) {
            const o = row + x * bpp;
            px.push([mem[o + 2], mem[o + 1], mem[o]]);
        }
    }
    return px;
}

function expected(): Array<[number, number, number]> {
    const px: Array<[number, number, number]> = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.push(pixel(x, y));
    return px;
}

describe("GetDIBits reads a DIBSection's own bits at every source/destination depth", () => {
    const getDIBits = createPaintingExports()["GetDIBits"]!;
    for (const bpp of [24, 32]) {
        for (const outBpp of [24, 32]) {
            for (const srcTopDown of [false, true]) {
                for (const outTopDown of [false, true]) {
                    it(`${bpp}bpp ${srcTopDown ? "top-down" : "bottom-up"} section -> ${outBpp}bpp ${outTopDown ? "top-down" : "bottom-up"}`, () => {
                        const { mem, hbm } = setup(bpp, srcTopDown, outBpp, outTopDown ? -H : H);
                        const lines = getDIBits({} as any, mem, [0, hbm, 0, H, OUT, BMI, 0] as any);
                        expect(lines).toBe(H);
                        expect(readOut(mem, outBpp, outTopDown)).toEqual(expected());
                        expect(new DataView(mem.buffer).getUint16(BMI + 14, true)).toBe(outBpp);
                    });
                }
            }
        }
    }
});

describe("GetDIBits on DIBSections: other depths, partial reads, reserved byte", () => {
    const getDIBits = createPaintingExports()["GetDIBits"]!;
    const header = (mem: Uint8Array, outBpp: number, outHeight: number) => {
        const dv = new DataView(mem.buffer);
        dv.setUint32(BMI, 40, true); dv.setInt32(BMI + 4, W, true); dv.setInt32(BMI + 8, outHeight, true);
        dv.setUint16(BMI + 12, 1, true); dv.setUint16(BMI + 14, outBpp, true);
    };

    it("a 565 BI_BITFIELDS section converts to 24 bpp", () => {
        const mem = new Uint8Array(0x10000);
        const s = stride(16);
        const dv = new DataView(mem.buffer);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dv.setUint16(BITS + y * s + x * 2, (31 << 11) | (x << 5) | y, true);
        const hbm = SystemResourceProvider.getInstance().registerUserObject({
            type: "BITMAP", width: W, height: H, bitsPtr: BITS, dibStride: s, dibBpp: 16, dibTopDown: true,
            dibMasks: [0xF800, 0x07E0, 0x001F],
        });
        header(mem, 24, -H);
        expect(getDIBits({} as any, mem, [0, hbm, 0, H, OUT, BMI, 0] as any)).toBe(H);
        const o = OUT + 1 * stride(24) + 2 * 3;
        expect(mem[o + 2]).toBe(255);
        expect(mem[o + 1]).toBe(Math.round(2 * 255 / 63));
        expect(mem[o]).toBe(Math.round(1 * 255 / 31));
    });

    it("an 8 bpp palettised section converts through its colour table", () => {
        const mem = new Uint8Array(0x10000);
        const s = stride(8);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mem[BITS + y * s + x] = (x + y) & 3;
        const palette = new Uint32Array([0xff000000, 0xffff0000, 0xff00ff00, 0xff0000ff]);
        const hbm = SystemResourceProvider.getInstance().registerUserObject({
            type: "BITMAP", width: W, height: H, bitsPtr: BITS, dibStride: s, dibBpp: 8, dibTopDown: true, dibPalette: palette,
        });
        header(mem, 32, -H);
        expect(getDIBits({} as any, mem, [0, hbm, 0, H, OUT, BMI, 0] as any)).toBe(H);
        const px = (x: number, y: number) => Array.from(mem.subarray(OUT + (y * W + x) * 4, OUT + (y * W + x) * 4 + 4));
        expect(px(1, 0)).toEqual([0, 0, 255, 0]);
        expect(px(2, 0)).toEqual([0, 255, 0, 0]);
        expect(px(3, 0)).toEqual([255, 0, 0, 0]);
    });

    it("a partial read returns just the requested scan lines", () => {
        const { mem, hbm } = setup(24, false, 24, -H);
        expect(getDIBits({} as any, mem, [0, hbm, 1, 1, OUT, BMI, 0] as any)).toBe(1);
        const row: Array<[number, number, number]> = [];
        for (let x = 0; x < W; x++) row.push([mem[OUT + x * 3 + 2], mem[OUT + x * 3 + 1], mem[OUT + x * 3]]);
        expect(row).toEqual(Array.from({ length: W }, (_, x) => pixel(x, 1)));
    });

    it("converting a 24 bpp section to 32 bpp leaves the reserved byte 0", () => {
        const { mem, hbm } = setup(24, true, 32, -H);
        getDIBits({} as any, mem, [0, hbm, 0, H, OUT, BMI, 0] as any);
        for (let i = 0; i < W * H; i++) expect(mem[OUT + i * 4 + 3]).toBe(0);
    });
});
