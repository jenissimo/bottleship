/**
 * CreateSurface refuses what the advertised hardware cannot do: an overlay without
 * DDCAPS_OVERLAY, and a FourCC that GetFourCCCodes does not list. A movie player probes
 * exactly these and blits RGB itself once the create fails; a DD_OK here commits it to a
 * plane nothing ever shows.
 */
import { expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createDirectDrawExports } from "../../src/worker/modules/ddraw/directdraw";
import {
    DDERR_INVALIDPIXELFORMAT, DDERR_NOOVERLAYHW,
    DDSCAPS_OFFSCREENPLAIN, DDSCAPS_OVERLAY, DDSCAPS_VIDEOMEMORY,
    DDSD_CAPS, DDSD_HEIGHT, DDSD_WIDTH, DDSD_PIXELFORMAT, DDPF_FOURCC,
    DDSURFACEDESC2_OFFSETS, DDPIXELFORMAT_OFFSETS,
} from "../../src/worker/modules/ddraw/constants";

const fourCC = (s: string): number =>
    (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;

const DESC = 0x11000;
const OUT = 0x12000;

function createSurface(caps: number, code: string): { hr: number; out: number } {
    const mem = new Uint8Array(0x20000);
    Mem.bind(() => mem);
    const view = new DataView(mem.buffer);
    const context: any = {
        display: { width: 640, height: 480, bpp: 16 },
        vtables: { IDirectDrawSurface7: { address: 0x3000 } },
        surfaces: {},
        usedVidMem: 0,
    };
    const O = DDSURFACEDESC2_OFFSETS;
    view.setUint32(DESC, 124, true);
    view.setUint32(DESC + O.flags, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT, true);
    view.setUint32(DESC + O.height, 176, true);
    view.setUint32(DESC + O.width, 320, true);
    view.setUint32(DESC + O.caps, caps, true);
    view.setUint32(DESC + O.pixelFormat, 32, true);
    view.setUint32(DESC + O.pixelFormat + DDPIXELFORMAT_OFFSETS.flags, DDPF_FOURCC, true);
    view.setUint32(DESC + O.pixelFormat + DDPIXELFORMAT_OFFSETS.fourCC, fourCC(code), true);
    view.setUint32(OUT, 0xdeadbeef, true);
    const dd = createDirectDrawExports(context);
    const hr = dd.IDirectDraw7_CreateSurface!({ esp: 0 } as any, mem, [0, DESC, OUT, 0]) as number;
    return { hr: hr >>> 0, out: view.getUint32(OUT, true) };
}

test("an overlay surface is refused with DDERR_NOOVERLAYHW when DDCAPS_OVERLAY is not advertised", () => {
    const r = createSurface(DDSCAPS_OVERLAY | DDSCAPS_VIDEOMEMORY, "YUY2");
    expect(r.hr).toBe(DDERR_NOOVERLAYHW);
    expect(r.out).toBe(0);
});

test("a FourCC outside GetFourCCCodes is refused with DDERR_INVALIDPIXELFORMAT", () => {
    const r = createSurface(DDSCAPS_OFFSCREENPLAIN, "UYVY");
    expect(r.hr).toBe(DDERR_INVALIDPIXELFORMAT);
    expect(r.out).toBe(0);
});
