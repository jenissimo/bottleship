/**
 * Block-compressed DirectDraw surfaces: the descriptor contract and the same-format copy.
 *
 * lPitch and dwLinearSize are a union and DDSD_LINEARSIZE selects between them. A texture
 * loader commonly branches on exactly that flag, and its row-copy fallback computes
 * `width * dwRGBBitCount / 8`, which is 0 for DDPF_FOURCC — so a desc reporting DDSD_PITCH
 * leaves every texture silently empty.
 */

import { describe, expect, test } from "bun:test";
import {
    DDSD_LINEARSIZE,
    DDSD_PITCH,
    DDSURFACEDESC2_OFFSETS,
    DDSURFACEDESC2_SIZE,
    DDSURFACEDESC_OFFSETS,
    DDSURFACEDESC_SIZE,
} from "../../src/worker/modules/ddraw/constants";
import {
    normalizeSurfaceDesc,
    writeSurfaceDesc,
    writeSurfaceDescV1,
} from "../../src/worker/modules/ddraw/structs";
import { copySurfaceRegion } from "../../src/worker/modules/ddraw/surface-helpers";
import type { DirectDrawSurfaceState, SurfaceFormat } from "../../src/worker/modules/ddraw/com-objects";

const fourCC = (s: string): number =>
    (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
const DDPF_FOURCC = 0x4;
const format = (code: string): SurfaceFormat =>
    ({ flags: DDPF_FOURCC, bpp: 0, rMask: 0, gMask: 0, bMask: 0, aMask: 0, fourCC: fourCC(code) }) as SurfaceFormat;
const RGB565 = { flags: 0x40, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 } as SurfaceFormat;

const DESC = 0x1000;
function writeDesc(pixelFormat: SurfaceFormat, width: number, height: number, pitch: number) {
    const mem = new Uint8Array(0x10000);
    const view = new DataView(mem.buffer);
    view.setUint32(DESC, DDSURFACEDESC2_SIZE, true);
    const desc = { size: DDSURFACEDESC2_SIZE, flags: 0, width, height, pitch, backBufferCount: 0, caps: 0x1000, surfacePtr: 0x4000, pixelFormat };
    writeSurfaceDesc(mem, DESC, desc as never);
    return {
        flags: view.getUint32(DESC + DDSURFACEDESC2_OFFSETS.flags, true),
        union: view.getUint32(DESC + DDSURFACEDESC2_OFFSETS.pitch, true),
    };
}

function surface(ptr: number, width: number, height: number, pixelFormat: SurfaceFormat, pitch: number): DirectDrawSurfaceState {
    return { surfaceType: "render_surface", width, height, pitch, surfacePtr: ptr, format: pixelFormat } as unknown as DirectDrawSurfaceState;
}
const full = (w: number, h: number) => ({ left: 0, top: 0, right: w, bottom: h });

describe("compressed surface descriptors", () => {
    test("DXT5 reports its total bytes under DDSD_LINEARSIZE, not a pitch", () => {
        const { flags, union } = writeDesc(format("DXT5"), 256, 64, 1024);
        expect(flags & DDSD_LINEARSIZE).toBe(DDSD_LINEARSIZE);
        expect(flags & DDSD_PITCH).toBe(0);
        expect(union).toBe(64 * 16 * 16);
    });

    test("DXT1 uses 8-byte blocks and rounds partial blocks up", () => {
        expect(writeDesc(format("DXT1"), 256, 256, 512).union).toBe(64 * 64 * 8);
        expect(writeDesc(format("DXT1"), 6, 6, 16).union).toBe(2 * 2 * 8);
    });

    test("the DDSURFACEDESC (v1) writer agrees", () => {
        const mem = new Uint8Array(0x10000);
        const view = new DataView(mem.buffer);
        view.setUint32(DESC, DDSURFACEDESC_SIZE, true);
        const desc = { size: DDSURFACEDESC_SIZE, flags: 0, width: 16, height: 16, pitch: 64, backBufferCount: 0, caps: 0x1000, surfacePtr: 0x4000, pixelFormat: format("DXT5") };
        writeSurfaceDescV1(mem, DESC, desc as never);
        const flags = view.getUint32(DESC + DDSURFACEDESC_OFFSETS.flags, true);
        expect(flags & (DDSD_LINEARSIZE | DDSD_PITCH)).toBe(DDSD_LINEARSIZE);
        expect(view.getUint32(DESC + DDSURFACEDESC_OFFSETS.pitch, true)).toBe(4 * 4 * 16);
    });

    test("an uncompressed surface keeps DDSD_PITCH", () => {
        const { flags, union } = writeDesc(RGB565, 640, 480, 1280);
        expect(flags & (DDSD_LINEARSIZE | DDSD_PITCH)).toBe(DDSD_PITCH);
        expect(union).toBe(1280);
    });

    test("CreateSurface never takes a stride from dwLinearSize", () => {
        const input = { flags: DDSD_LINEARSIZE, width: 256, height: 64, pitch: 0x4000, backBufferCount: 0, caps: 0x1000, surfacePtr: 0, pixelFormat: format("DXT5") };
        expect(normalizeSurfaceDesc(input as never, 640, 480, 16).pitch).toBe(64 * 16);
    });

    test("a linear surface still honors an explicit pitch", () => {
        const input = { flags: DDSD_PITCH, width: 100, height: 10, pitch: 256, backBufferCount: 0, caps: 0x840, surfacePtr: 0, pixelFormat: RGB565 };
        expect(normalizeSurfaceDesc(input as never, 640, 480, 16).pitch).toBe(256);
    });
});

describe("same-format compressed copy", () => {
    const WIDTH = 16, HEIGHT = 16, PITCH = 64, BYTES = PITCH * 4;

    test("moves every block of the level", () => {
        const mem = new Uint8Array(0x20000);
        for (let i = 0; i < BYTES; i++) mem[0x4000 + i] = (i % 251) + 1;
        const src = surface(0x4000, WIDTH, HEIGHT, format("DXT5"), PITCH);
        const dst = surface(0x8000, WIDTH, HEIGHT, format("DXT5"), PITCH);
        copySurfaceRegion(mem, src, dst, full(WIDTH, HEIGHT), full(WIDTH, HEIGHT));
        expect(mem.subarray(0x8000, 0x8000 + BYTES)).toEqual(mem.subarray(0x4000, 0x4000 + BYTES));
    });

    test("stops at the level's last block row", () => {
        const mem = new Uint8Array(0x20000);
        mem.fill(0xee, 0x8000 + BYTES, 0x8000 + BYTES + 64);
        const src = surface(0x4000, WIDTH, HEIGHT, format("DXT5"), PITCH);
        const dst = surface(0x8000, WIDTH, HEIGHT, format("DXT5"), PITCH);
        copySurfaceRegion(mem, src, dst, full(WIDTH, HEIGHT), full(WIDTH, HEIGHT));
        expect(mem[0x8000 + BYTES]).toBe(0xee);
    });

    test("copies a block-aligned sub-rect to the right blocks", () => {
        const mem = new Uint8Array(0x20000);
        mem.fill(7, 0x4000, 0x4000 + BYTES);
        const src = surface(0x4000, WIDTH, HEIGHT, format("DXT5"), PITCH);
        const dst = surface(0x8000, WIDTH, HEIGHT, format("DXT5"), PITCH);
        copySurfaceRegion(mem, src, dst, full(4, 4), { left: 4, top: 4, right: 8, bottom: 8 });
        expect(mem[0x8000 + PITCH + 15]).toBe(0);
        expect(mem[0x8000 + PITCH + 16]).toBe(7);
        expect(mem[0x8000 + PITCH + 31]).toBe(7);
        expect(mem[0x8000 + PITCH + 32]).toBe(0);
    });

    test("a copy that needs a block encoder leaves the destination alone", () => {
        const mem = new Uint8Array(0x20000);
        mem.fill(9, 0x4000, 0x4000 + 256);
        const src = surface(0x4000, WIDTH, HEIGHT, RGB565, 32);
        const dst = surface(0x8000, WIDTH, HEIGHT, format("DXT5"), PITCH);
        copySurfaceRegion(mem, src, dst, full(WIDTH, HEIGHT), full(WIDTH, HEIGHT));
        expect(mem.subarray(0x8000, 0x8000 + BYTES).every((b) => b === 0)).toBe(true);
    });

    test("a linear destination is untouched by the compressed leg", () => {
        const mem = new Uint8Array(0x20000);
        mem.fill(3, 0x4000, 0x4000 + 32 * 16);
        const src = surface(0x4000, WIDTH, HEIGHT, RGB565, 32);
        const dst = surface(0x8000, WIDTH, HEIGHT, RGB565, 32);
        copySurfaceRegion(mem, src, dst, full(WIDTH, HEIGHT), full(WIDTH, HEIGHT));
        expect(mem[0x8000 + 32 * 16 - 1]).toBe(3);
    });
});
