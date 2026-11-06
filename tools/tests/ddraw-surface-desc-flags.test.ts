/**
 * DDSURFACEDESC/DDSURFACEDESC2 members are only valid when their DDSD_ flag is set
 * (DDSURFACEDESC2.dwFlags, ddraw.h). Uninitialised members must not leak into the parsed desc.
 */
import { describe, expect, test } from "bun:test";
import { readSurfaceDesc, readSurfaceDescV1 } from "../../src/worker/modules/ddraw/structs";

const DDSD_CAPS = 0x00000001;
const DDSD_BACKBUFFERCOUNT = 0x00000020;
const DDSCAPS_FLIP = 0x00000010;
const DDSCAPS_COMPLEX = 0x00000008;
const DDSCAPS_PRIMARYSURFACE = 0x00000200;

const ADDR = 0x10000;

function makeDesc(size: number, capsOffset: number, flags: number, caps: number, backBufferCount: number): Uint8Array {
    const mem = new Uint8Array(ADDR + 0x100);
    const view = new DataView(mem.buffer);
    view.setUint32(ADDR + 0, size, true);
    view.setUint32(ADDR + 4, flags, true);
    view.setUint32(ADDR + 20, backBufferCount, true);
    view.setUint32(ADDR + capsOffset, caps, true);
    return mem;
}

describe("DDSURFACEDESC dwBackBufferCount honours DDSD_BACKBUFFERCOUNT", () => {
    test("v1: garbage count without the flag is ignored", () => {
        const mem = makeDesc(108, 104, DDSD_CAPS, DDSCAPS_PRIMARYSURFACE, 480);
        expect(readSurfaceDescV1(mem, ADDR)?.backBufferCount).toBe(0);
    });

    test("v1: count is read when the flag is set", () => {
        const mem = makeDesc(108, 104, DDSD_CAPS | DDSD_BACKBUFFERCOUNT,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_FLIP | DDSCAPS_COMPLEX, 1);
        expect(readSurfaceDescV1(mem, ADDR)?.backBufferCount).toBe(1);
    });

    test("v2: garbage count without the flag is ignored", () => {
        const mem = makeDesc(124, 104, DDSD_CAPS, DDSCAPS_PRIMARYSURFACE, 480);
        expect(readSurfaceDesc(mem, ADDR)?.backBufferCount).toBe(0);
    });

    test("v2: count is read when the flag is set", () => {
        const mem = makeDesc(124, 104, DDSD_CAPS | DDSD_BACKBUFFERCOUNT,
            DDSCAPS_PRIMARYSURFACE | DDSCAPS_FLIP | DDSCAPS_COMPLEX, 2);
        expect(readSurfaceDesc(mem, ADDR)?.backBufferCount).toBe(2);
    });
});

describe("DDSURFACEDESC lPitch honours DDSD_PITCH", () => {
    const DDSD_HEIGHT = 0x2, DDSD_WIDTH = 0x4, DDSD_PITCH = 0x8;
    const DDSCAPS_OFFSCREENPLAIN = 0x40, DDSCAPS_SYSTEMMEMORY = 0x800;
    /** Half-Life sw.dll: 320x240 sysmem offscreen, DDSD_CAPS|HEIGHT|WIDTH, a code pointer in lPitch. */
    function hlDesc(size: number, flags: number): Uint8Array {
        const mem = makeDesc(size, 104, flags, DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, 0);
        const view = new DataView(mem.buffer);
        view.setUint32(ADDR + 8, 240, true);
        view.setUint32(ADDR + 12, 320, true);
        view.setUint32(ADDR + 16, 0x240a6ed0, true);
        return mem;
    }

    test("garbage pitch without the flag is ignored (v1 and v2 readers)", () => {
        const flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH;
        expect(readSurfaceDescV1(hlDesc(108, flags), ADDR)?.pitch).toBe(0);
        expect(readSurfaceDesc(hlDesc(108, flags), ADDR)?.pitch).toBe(0);
        expect(readSurfaceDesc(hlDesc(124, flags), ADDR)?.pitch).toBe(0);
    });

    test("pitch is read when the flag is set", () => {
        const flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH;
        expect(readSurfaceDescV1(hlDesc(108, flags), ADDR)?.pitch).toBe(0x240a6ed0);
        expect(readSurfaceDesc(hlDesc(124, flags), ADDR)?.pitch).toBe(0x240a6ed0);
    });
});
