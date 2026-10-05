/**
 * The JS-side 16-bit packers binkw32 uses for every BINKSURFACE the WASM 565 packer does not
 * cover (555 / 655 / 664 / 4444), with quality.videoDither on. The reference expansion is
 * the GPU's own (texture-converter.ts: k·255/max, rounded), so "the block mean lands on the
 * source" is measured against what actually reaches the screen.
 */

import { describe, expect, test } from "bun:test";
import { BinkSurface, pack16, pack16Dithered, quant } from "../../src/worker/modules/binkw32";

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const W = 64, H = 8;

/** The fixture ramp the WASM test uses too: 2x on even rows, 2x+24 on odd, grey. */
function source(): Uint8Array {
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = Math.min(255, x * 2 + 24 * (y & 1));
        px.set([v, v, v, 255], (y * W + x) * 4);
    }
    return px;
}

interface Layout { r: [shift: number, bits: number]; g: [number, number]; b: [number, number] }
const LAYOUT: Partial<Record<BinkSurface, Layout>> = {
    [BinkSurface.RGB565]:   { r: [11, 5], g: [5, 6], b: [0, 5] },
    [BinkSurface.XRGB1555]: { r: [10, 5], g: [5, 5], b: [0, 5] },
    [BinkSurface.RGB655]:   { r: [10, 6], g: [5, 5], b: [0, 5] },
    [BinkSurface.RGB664]:   { r: [10, 6], g: [4, 6], b: [0, 4] },
    [BinkSurface.ARGB4444]: { r: [8, 4],  g: [4, 4], b: [0, 4] },
};

const expand = (k: number, bits: number) => Math.floor((k * 255 + ((1 << bits) - 1) / 2) / ((1 << bits) - 1));
const field = (v: number, [shift, bits]: [number, number]) => (v >>> shift) & ((1 << bits) - 1);

function pack(src: Uint8Array, surf: BinkSurface, dither: boolean): Uint16Array {
    const out = new Uint16Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        out[y * W + x] = dither
            ? pack16Dithered(surf, src[i], src[i + 1], src[i + 2], src[i + 3], BAYER4[(y & 3) * 4 + (x & 3)])
            : pack16(surf, src[i], src[i + 1], src[i + 2], src[i + 3]);
    }
    return out;
}

function blockError(src: Uint8Array, out: Uint16Array, L: Layout): number {
    let sum = 0, n = 0;
    for (let by = 0; by + 4 <= H; by += 4) for (let bx = 0; bx + 4 <= W; bx += 4) {
        let s = 0, t = 0;
        for (let y = by; y < by + 4; y++) for (let x = bx; x < bx + 4; x++) {
            const i = y * W + x;
            s += src[i * 4] + src[i * 4 + 1] + src[i * 4 + 2];
            const v = out[i];
            t += expand(field(v, L.r), L.r[1]) + expand(field(v, L.g), L.g[1]) + expand(field(v, L.b), L.b[1]);
        }
        sum += Math.abs(s - t) / 16; n++;
    }
    return sum / n;
}

describe("binkw32 16-bit dither", () => {
    test("quant never leaves the level range and is monotone in the threshold", () => {
        for (const n of [4, 5, 6]) {
            const top = (1 << n) - 1;
            for (let v = 0; v < 256; v++) {
                let prev = -1;
                for (let t = 0; t < 16; t++) {
                    const k = quant(v, n, t);
                    expect(k).toBeGreaterThanOrEqual(0);
                    expect(k).toBeLessThanOrEqual(top);
                    expect(k).toBeGreaterThanOrEqual(prev);
                    prev = k;
                }
            }
            expect(quant(255, n, 15)).toBe(top);
            expect(quant(0, n, 0)).toBe(0);
        }
    });

    for (const [name, surf] of [["RGB565", BinkSurface.RGB565], ["XRGB1555", BinkSurface.XRGB1555],
        ["RGB655", BinkSurface.RGB655], ["RGB664", BinkSurface.RGB664], ["ARGB4444", BinkSurface.ARGB4444]] as const) {
        test(`${name}: dither halves the block error of truncation and moves no pixel more than one level`, () => {
            const src = source();
            const L = LAYOUT[surf]!;
            const plain = pack(src, surf, false);
            const dithered = pack(src, surf, true);
            // The rounded expansion already recovers most of truncation's half-step bias, so
            // what is left for dither to remove is the residual; measured 0.45–0.55 of it.
            expect(blockError(src, dithered, L)).toBeLessThan(blockError(src, plain, L) * 0.6);
            for (let i = 0; i < plain.length; i++) {
                for (const ch of [L.r, L.g, L.b]) {
                    expect(Math.abs(field(dithered[i], ch) - field(plain[i], ch))).toBeLessThanOrEqual(1);
                }
            }
        });
    }

    test("ARGB4444 / ARGB1555 alpha is never dithered", () => {
        for (let a = 0; a < 256; a += 5) {
            expect(pack16Dithered(BinkSurface.ARGB4444, 0, 0, 0, a, 15) >>> 12).toBe(a >> 4);
            expect(pack16Dithered(BinkSurface.ARGB1555, 0, 0, 0, a, 15) >>> 15).toBe(a >= 0x80 ? 1 : 0);
        }
    });
});
