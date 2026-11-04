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
