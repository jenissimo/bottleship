/**
 * Differential: the WASM surface converter against the TypeScript converter that
 * is also its runtime fallback. Both variants of the kernel are checked, over
 * every 16-bit source value, so a rounding or masking drift cannot hide in a
 * value the sampling happened to miss.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextureKernel } from "../../src/worker/backends/webgpu/shared/dxt-kernel";
import { convertSurfaceToRGBACpu, PixelFormat, type FormatInfo } from "../../src/worker/modules/ddraw/gpu-texture-utils";

const asset = (name: string) => readFileSync(resolve(import.meta.dir, "../../public", name));
const variants = {
    scalar: new WebAssembly.Module(asset("dxt-kernel.wasm")),
    simd: new WebAssembly.Module(asset("dxt-kernel-simd.wasm")),
};

const formats: Array<{ kind: PixelFormat; name: string; info: FormatInfo }> = [
    { kind: PixelFormat.RGB565, name: "RGB565", info: { bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 } },
    { kind: PixelFormat.RGB555, name: "RGB555", info: { bpp: 16, rMask: 0x7c00, gMask: 0x03e0, bMask: 0x001f, aMask: 0 } },
    { kind: PixelFormat.ARGB1555, name: "ARGB1555", info: { bpp: 16, rMask: 0x7c00, gMask: 0x03e0, bMask: 0x001f, aMask: 0x8000 } },
    { kind: PixelFormat.ARGB8888, name: "ARGB8888", info: { bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0xff000000 } },
    { kind: PixelFormat.XRGB8888, name: "XRGB8888", info: { bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0 } },
];

const keys: Array<{ low: number; high: number } | undefined> = [
    undefined,
    { low: 0, high: 0 },
    { low: 0x0821, high: 0x0821 },
    { low: 0x4000, high: 0x8fff },
    { low: 0x00ff00, high: 0x00ffff },
];

/** A surface whose 16-bit words enumerate 0..65535, padded to `pitch`. */
function surface(bpp: number, width: number, height: number, pitch: number, offset: number): Uint8Array {
    const mem = new Uint8Array(offset + (height - 1) * pitch + width * (bpp >> 3));
    const step = bpp >> 3;
    let value = 0;
    for (let y = 0; y < height; y++) {
        let p = offset + y * pitch;
        for (let x = 0; x < width; x++, value++) {
            mem[p] = value & 0xff;
            mem[p + 1] = (value >> 8) & 0xff;
            if (step === 4) { mem[p + 2] = (value >> 3) & 0xff; mem[p + 3] = value & 0xff; }
            p += step;
        }
    }
    return mem;
}

test("both WASM variants agree byte-for-byte with the TS converter", () => {
    const width = 256, height = 256;
    for (const [name, module] of Object.entries(variants)) {
        const kernel = new TextureKernel(new WebAssembly.Instance(module));
        for (const format of formats) {
            const bytes = format.info.bpp >> 3;
            // pad exercises the row tail; offset exercises an unaligned base,
            // which the TS side answers with its bounds-checked byte loops.
            for (const [pad, offset] of [[0, 0], [6, 0], [2, 1], [0, 3]]) {
                const pitch = width * bytes + pad;
                const mem = surface(format.info.bpp, width, height, pitch, offset);
                for (const key of keys) {
                    const expected = convertSurfaceToRGBACpu(mem, offset, width, height, pitch, format.info, undefined, key);
                    const actual = new Uint8Array(width * height * 4);
                    assert.equal(
                        kernel.tryConvertPixels(format.kind, mem, offset, pitch, width, height, actual, key), true,
                        `${name} ${format.name} declined pad=${pad} offset=${offset}`);
                    assert.deepEqual(actual, expected,
                        `${name} ${format.name} pad=${pad} offset=${offset} key=${JSON.stringify(key)}`);
                }
            }
        }
    }
});

test("a keyed texel loses only its alpha, never its colour", () => {
    // The key is a per-operation modifier: the blit and COLORKEYENABLE shaders
    // still compare against the source colour, so zeroing RGB would make the
    // key unmatchable and the region would blit as opaque black.
    const kernel = new TextureKernel(new WebAssembly.Instance(variants.simd));
    const width = 32, height = 16, pitch = width * 2;
    const mem = new Uint8Array(pitch * height);
    for (let i = 0; i < width * height; i++) { mem[i * 2] = 0x21; mem[i * 2 + 1] = 0x08; }
    const info: FormatInfo = { bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 };
    const out = new Uint8Array(width * height * 4);
    assert.equal(kernel.tryConvertPixels(PixelFormat.RGB565, mem, 0, pitch, width, height, out, { low: 0x0821, high: 0x0821 }), true);
    const opaque = new Uint8Array(width * height * 4);
    convertSurfaceToRGBACpu(mem, 0, width, height, pitch, info, opaque);
    for (let i = 0; i < width * height; i++) {
        assert.equal(out[i * 4 + 3], 0, "keyed alpha must be cleared");
        assert.notEqual(opaque[i * 4] | opaque[i * 4 + 1] | opaque[i * 4 + 2], 0, "test pixel must be non-black");
        assert.deepEqual(out.subarray(i * 4, i * 4 + 3), opaque.subarray(i * 4, i * 4 + 3), "keyed RGB must survive");
    }
});

test("the kernel declines what it has no arm for, rather than answering wrongly", () => {
    const kernel = new TextureKernel(new WebAssembly.Instance(variants.scalar));
    const mem = new Uint8Array(64 * 64 * 4);
    const out = new Uint8Array(64 * 64 * 4);
    const declined: Array<[PixelFormat, number, number, number, number]> = [
        [PixelFormat.PALETTE8, 0, 64, 64, 64],       // no palettised arm
        [PixelFormat.ARGB4444, 0, 128, 64, 64],      // no 4444 arm
        [PixelFormat.RGB888, 0, 192, 64, 64],        // no 24-bit arm
        [PixelFormat.UNKNOWN, 0, 128, 64, 64],       // unclassified format
        [PixelFormat.RGB565, 0, 32, 8, 8],           // under the staging-cost floor
        [PixelFormat.RGB565, 0, 100, 64, 64],        // pitch under one row
        [PixelFormat.RGB565, 0, 128, 64, 65],        // source span past the buffer
        [PixelFormat.RGB565, -1, 128, 64, 64],       // negative offset
        [PixelFormat.RGB565, 0, 128, 64.5, 64],      // non-integral geometry
    ];
    for (const [kind, offset, pitch, width, height] of declined) {
        assert.equal(kernel.tryConvertPixels(kind, mem, offset, pitch, width, height, out), false,
            `kind=${kind} offset=${offset} pitch=${pitch} ${width}x${height}`);
    }
    assert.ok(out.every(x => x === 0), "a declined call must not write");
});

test("the raw Rust ABI independently rejects bad spans and overlap", () => {
    const wasm = new WebAssembly.Instance(variants.scalar);
    const memory = wasm.exports.memory as WebAssembly.Memory;
    const base = Number((wasm.exports.__heap_base as WebAssembly.Global).value);
    memory.grow(2);
    const bytes = new Uint8Array(memory.buffer);
    const convert = wasm.exports.convert_pixels as (...args: number[]) => number;
    const dst = base + 8192;
    bytes.fill(173, dst, dst + 1024);
    const rejected = [
        [4, base, 512, 32, 16, 16, dst, 1024, 0, 0, 0],       // ARGB4444 has no arm
        [1, base, 512, 30, 16, 16, dst, 1024, 0, 0, 0],       // pitch under one row
        [1, base, 511, 32, 16, 16, dst, 1024, 0, 0, 0],       // declared source too short
        [1, base, 512, 32, 16, 16, dst, 1023, 0, 0, 0],       // declared output too short
        [1, base, 512, 32, 16, 16, dst, 1024, 2, 0, 0],       // keyed flag out of range
        [1, 0, 512, 32, 16, 16, dst, 1024, 0, 0, 0],          // source below __heap_base
        [1, base, 512, 32, 16, 16, base + 4, 1024, 0, 0, 0],  // overlap
        [6, base, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, dst, 0xffffffff, 0, 0, 0], // overflow
    ];
    for (const args of rejected) {
        assert.notEqual(convert(...args), 0, JSON.stringify(args));
        assert.ok(bytes.subarray(dst, dst + 1024).every(x => x === 173), JSON.stringify(args));
    }
    assert.equal(convert(1, base + 1, 512, 32, 16, 16, dst + 1, 1024, 0, 0, 0), 0, "unaligned byte spans are legal");
});
