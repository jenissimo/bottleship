/**
 * Pins a measured negative result: unkeyed RGB565 is one lookup-table pass, and
 * the kernel's copy-in/copy-out costs more than its inner loop saves, so that
 * one case must never be routed to WASM. Keyed RGB565 must be, because the
 * TypeScript alternative is two passes over the surface.
 *
 * Without this test the routing predicate is a comment nobody can enforce.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextureKernel, initializeTextureKernel } from "../../src/worker/backends/webgpu/shared/dxt-kernel";
import { convertSurfaceToRGBA, convertSurfaceToRGBACpu, type FormatInfo } from "../../src/worker/modules/ddraw/gpu-texture-utils";

const rgb565: FormatInfo = { bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 };
const xrgb8888: FormatInfo = { bpp: 32, rMask: 0x00ff0000, gMask: 0x0000ff00, bMask: 0x000000ff, aMask: 0 };

test("unkeyed RGB565 stays on the LUT path; keying and 32-bit use the kernel", async () => {
    assert.equal(await initializeTextureKernel(readFileSync(resolve(import.meta.dir, "../../public/dxt-kernel-simd.wasm"))), true);
    const original = TextureKernel.prototype.tryConvertPixels;
    let calls = 0;
    TextureKernel.prototype.tryConvertPixels = function (...args) { calls++; return original.apply(this, args); };
    try {
        const width = 32, height = 32;
        const mem = new Uint8Array(width * height * 4);
        for (let i = 0; i < mem.length; i++) mem[i] = (i * 37) & 0xff;
        const out = new Uint8Array(width * height * 4);

        convertSurfaceToRGBA(mem, 0, width, height, width * 2, rgb565, out);
        assert.equal(calls, 0, "unkeyed RGB565 must not reach the kernel");
        assert.deepEqual(out, convertSurfaceToRGBACpu(mem, 0, width, height, width * 2, rgb565));

        const key = { low: 0, high: 0x0821 };
        convertSurfaceToRGBA(mem, 0, width, height, width * 2, rgb565, out, key);
        assert.equal(calls, 1, "keyed RGB565 must reach the kernel");
        assert.deepEqual(out, convertSurfaceToRGBACpu(mem, 0, width, height, width * 2, rgb565, undefined, key));

        convertSurfaceToRGBA(mem, 0, width, height, width * 4, xrgb8888, out);
        assert.equal(calls, 2, "unkeyed 32-bit must reach the kernel");
        assert.deepEqual(out, convertSurfaceToRGBACpu(mem, 0, width, height, width * 4, xrgb8888));
    } finally {
        TextureKernel.prototype.tryConvertPixels = original;
    }
});
