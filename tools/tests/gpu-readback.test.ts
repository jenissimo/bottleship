/**
 * Shared GPU→RGBA8 readback (copyTextureToBuffer -> mapAsync -> normalize), used by the
 * D3D9 render-target dump route AND the new D3D8 one (dumpSurface/dumpTexture with
 * `from:"gpu"`, textures.ts). A D3D8 render-target texture has no guest pixel backing by
 * construction, so this IS the only route into it — these tests pin the row-padding and
 * BGRA-normalization behavior it depends on, and that a GPU failure propagates as a
 * rejection (the caller turns it into a named `{err}`), never a plausible blank buffer.
 */
import { describe, expect, test } from "bun:test";

// bun:test runs outside a browser/worker context, so the WebGPU enum globals the browser
// injects (used only as bitflag constants — createBuffer(usage) — never inspected by our
// fakes below) don't exist. Real workers always have them; this just fills the gap so the
// module under test can be imported and exercised the same way its real callers use it.
(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage ??= { COPY_DST: 1, MAP_READ: 2 };
(globalThis as unknown as { GPUMapMode: unknown }).GPUMapMode ??= { READ: 1 };

import { readGpuTextureRgba } from "../../src/worker/backends/webgpu/shared/gpu-readback";

/** A minimal GPUDevice/GPUQueue stand-in. `mapped` is the raw padded-row buffer the "GPU"
 *  claims to hold; `format` drives the BGRA branch exactly like a real GPUTexture.format. */
function fakeDeviceReading(mapped: Uint8Array, opts?: { failMapAsync?: boolean }) {
    let capturedMipLevel: number | undefined;
    const buffer = {
        mapAsync: async () => {
            if (opts?.failMapAsync) throw new Error("device lost mid-readback");
        },
        getMappedRange: () => mapped.buffer,
        destroy: () => {},
    } as unknown as GPUBuffer;
    const device = {
        createBuffer: () => buffer,
        createCommandEncoder: () => ({
            copyTextureToBuffer: (src: { mipLevel?: number }) => { capturedMipLevel = src.mipLevel; },
            finish: () => ({}) as GPUCommandBuffer,
        }),
    } as unknown as GPUDevice;
    const queue = { submit: () => {} } as unknown as GPUQueue;
    return { device, queue, mipLevelOf: () => capturedMipLevel };
}

describe("readGpuTextureRgba", () => {
    test("rgba8 format copies each row verbatim, dropping 256-byte alignment padding", async () => {
        const w = 3, h = 2;
        const padded = Math.ceil(w * 4 / 256) * 256; // 256 (well under one row's real width)
        const mapped = new Uint8Array(padded * h);
        // Row 0: pixels (10,11,12,13) (20,21,22,23) (30,31,32,33); row 1: (40..) (50..) (60..)
        const rows = [[10, 20, 30], [40, 50, 60]];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const base = rows[y]![x]!;
                const o = y * padded + x * 4;
                mapped.set([base, base + 1, base + 2, base + 3], o);
            }
        }
        const { device, queue } = fakeDeviceReading(mapped);
        const tex = { format: "rgba8unorm" } as unknown as GPUTexture;
        const rgba = await readGpuTextureRgba(device, queue, tex, w, h);
        expect(Array.from(rgba.subarray(0, 4))).toEqual([10, 11, 12, 13]);
        expect(Array.from(rgba.subarray(4, 8))).toEqual([20, 21, 22, 23]);
        expect(Array.from(rgba.subarray(w * 4, w * 4 + 4))).toEqual([40, 41, 42, 43]); // row 1 start
    });

    test("bgra8 format swaps R and B so the result is canonical RGBA (never left silently swapped)", async () => {
        const w = 1, h = 1;
        const padded = 256;
        const mapped = new Uint8Array(padded);
        mapped.set([0x10 /*B*/, 0x20 /*G*/, 0x30 /*R*/, 0x40 /*A*/], 0);
        const { device, queue } = fakeDeviceReading(mapped);
        const tex = { format: "bgra8unorm" } as unknown as GPUTexture;
        const rgba = await readGpuTextureRgba(device, queue, tex, w, h);
        expect(Array.from(rgba)).toEqual([0x30, 0x20, 0x10, 0x40]); // R,G,B,A
    });

    test("the requested mip level reaches copyTextureToBuffer's source origin", async () => {
        const mapped = new Uint8Array(256);
        const { device, queue, mipLevelOf } = fakeDeviceReading(mapped);
        const tex = { format: "rgba8unorm" } as unknown as GPUTexture;
        await readGpuTextureRgba(device, queue, tex, 1, 1, 3);
        expect(mipLevelOf()).toBe(3);
    });

    test("a GPU failure (mapAsync rejects) propagates as a rejection, never a blank buffer", async () => {
        const mapped = new Uint8Array(256);
        const { device, queue } = fakeDeviceReading(mapped, { failMapAsync: true });
        const tex = { format: "rgba8unorm" } as unknown as GPUTexture;
        // This is exactly what dumpD3d8Gpu/readRenderTargetRgba catch and turn into a named
        // {err: "..."} — the loud-failure contract this helper must uphold for both callers.
        await expect(readGpuTextureRgba(device, queue, tex, 1, 1)).rejects.toThrow(/device lost/);
    });
});
