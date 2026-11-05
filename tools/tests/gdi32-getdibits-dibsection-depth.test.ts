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
