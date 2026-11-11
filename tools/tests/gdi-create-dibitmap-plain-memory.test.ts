import { afterEach, describe, expect, it } from "bun:test";
import { setGuestMemoryBorrowBypass } from "../../src/worker/core/memory/guest-memory";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";

const BMI = 0x100;
const BITS = 0x1000;
const W = 37;
const H = 11;

function countingProxy(view: Uint8Array): { mem: Uint8Array; indexReads: () => number } {
    let reads = 0;
    const mem = new Proxy(view, {
        get(target, prop) {
            if (typeof prop === "string" && prop.length > 0 && prop.charCodeAt(0) >= 48 && prop.charCodeAt(0) <= 57) reads++;
            const x = Reflect.get(target, prop);
            return typeof x === "function" ? x.bind(target) : x;
        },
    }) as unknown as Uint8Array;
    return { mem, indexReads: () => reads };
}

function guestDib(bpp: number, topDown: boolean): Uint8Array {
    const stride = Math.floor((W * bpp + 31) / 32) * 4;
    const mem = new Uint8Array(BITS + stride * H + 64);
    const dv = new DataView(mem.buffer);
    dv.setUint32(BMI, 40, true);
    dv.setInt32(BMI + 4, W, true);
    dv.setInt32(BMI + 8, topDown ? -H : H, true);
    dv.setUint16(BMI + 12, 1, true);
    dv.setUint16(BMI + 14, bpp, true);
    dv.setUint32(BMI + 16, 0, true);
    dv.setUint32(BMI + 32, 0, true);
    if (bpp <= 8) {
        for (let i = 0; i < (1 << bpp); i++) {
            mem[BMI + 40 + i * 4] = (i * 13) & 0xff;
            mem[BMI + 40 + i * 4 + 1] = (255 - i) & 0xff;
            mem[BMI + 40 + i * 4 + 2] = (i * 7 + 3) & 0xff;
        }
    }
    for (let i = BITS; i < mem.length; i++) mem[i] = (i * 37 + (i >> 5) * 11) & 0xff;
    return mem;
}

function createDib(mem: Uint8Array): Uint8Array {
    const create = createPaintingExports()["CreateDIBitmap"] as (ctx: unknown, mem: Uint8Array, args: number[]) => number;
    const handle = create({}, mem, [0, BMI, 4, BITS, BMI, 0]);
    const obj = SystemResourceProvider.getInstance().getUserObject(handle) as { width: number; height: number; pixels: Uint8Array };
    expect(obj.width).toBe(W);
    expect(obj.height).toBe(H);
    return obj.pixels;
}

afterEach(() => setGuestMemoryBorrowBypass(false));

describe("CreateDIBitmap reads CBM_INIT bits from a plain guest-memory view", () => {
    for (const [label, bpp, topDown] of [["32bpp", 32, false], ["24bpp", 24, true], ["16bpp", 16, false], ["8bpp", 8, false], ["4bpp", 4, true], ["1bpp", 1, false]] as const) {
        it(`${label}: same pixels, no per-pixel Proxy reads`, () => {
            const plain = createDib(guestDib(bpp, topDown));
            const fast = countingProxy(guestDib(bpp, topDown));
            const viaUnwrap = createDib(fast.mem);
            setGuestMemoryBorrowBypass(true);
            const slow = countingProxy(guestDib(bpp, topDown));
            const viaProxy = createDib(slow.mem);
            setGuestMemoryBorrowBypass(false);
            expect(Buffer.from(viaUnwrap).equals(Buffer.from(plain))).toBe(true);
            expect(Buffer.from(viaProxy).equals(Buffer.from(plain))).toBe(true);
            expect(fast.indexReads()).toBe(0);
            expect(slow.indexReads()).toBeGreaterThan(W * H / 8);
        });
    }
});
