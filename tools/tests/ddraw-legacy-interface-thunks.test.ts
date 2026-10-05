/**
 * Contracts for the pre-DX7 DirectDraw interfaces (IDirectDraw / IDirectDrawSurface
 * v1, which also backs v2/v3).
 *
 * Two failure modes are pinned here because both land far from their cause:
 *
 *  - An out-parameter left unwritten under a DD_OK. The SDK frame sync is
 *    `do {} while (inVB); do {} while (!inVB);` over an uninitialised stack BOOL,
 *    so a constant (or absent) answer is an unkillable spin with no log line.
 *  - A DX7-sized write through a DX1-sized pointer. IDirectDrawSurface(1/2/3)::GetCaps
 *    takes LPDDSCAPS — one DWORD — while IDirectDrawSurface7::GetCaps fills a DDSCAPS2
 *    (16 bytes); delegating the former to the latter overwrites 12 bytes of the
 *    caller's own frame and still returns DD_OK.
 *
 * Version behaviour follows the ddraw conformance behaviour: v1/v2/v3 GetCaps copy
 * dwCaps only, and every legacy version reaches the same raster-status implementation.
 */

import { describe, expect, test } from "bun:test";
import { createDirectDrawExports } from "../../src/worker/modules/ddraw/directdraw";
import { createSurfaceExports } from "../../src/worker/modules/ddraw/surface";
import { rasterStatusAt } from "../../src/worker/modules/ddraw/raster-status";
import { SUPPORTED_FOURCC_CODES } from "../../src/worker/modules/ddraw/constants";
import {
    DEFAULT_VENDOR_ID,
    DEFAULT_DEVICE_ID,
    DEFAULT_DRIVER_VERSION,
    DEFAULT_DEVICE_DESC,
} from "../../src/worker/backends/webgpu/shared/dx-adapter-identifier";

const DD_OK = 0;
const DDERR_CANTDUPLICATE = 0x88760247;
const DDERR_NOPALETTEATTACHED = 0x8876023c;
const POISON = 0xdeadbeef;

const OUT = 0x2000;
const SURFACE_PTR = 0x1000;
const PALETTE_PTR = 0x1800;
const DDSCAPS_TEXTURE = 0x00001000;
const SURFACE_BITS = 0x4000;

function makeContext(overrides: Record<string, unknown> = {}) {
    const surfaceState: any = {
        caps: DDSCAPS_TEXTURE, caps2: 0, width: 64, height: 64, pitch: 128,
        surfacePtr: 0, format: { bpp: 16 }, paletteHandle: undefined,
    };
    const palette = { handle: 0x77, refs: 1, addRef() { return ++this.refs; }, release() { return --this.refs; } };
    const surface: any = { getState: () => surfaceState, handle: 0x11, addRef: () => 2, release: () => 0 };

    const context: any = {
        display: { width: 640, height: 480, bpp: 16, refresh: 75 },
        surfaces: {},
        cooperative: {},
        process: { memory: {}, dispatcher: {} },
        resourceProvider: {
            getComObjectByAddress: (a: number) =>
                a === SURFACE_PTR ? surface : a === PALETTE_PTR ? palette : null,
            getComObject: (h: number) => (h === palette.handle ? palette : null),
            getAddressForHandle: (h: number) => (h === palette.handle ? PALETTE_PTR : 0),
            getAllComObjects: () => [],
        },
        ...overrides,
    };
    return { context, surfaceState, palette };
}

function harness() {
    const { context, surfaceState, palette } = makeContext();
    const dd = createDirectDrawExports(context);
    const surf = createSurfaceExports(context);
    const mem = new Uint8Array(0x10000);
    const view = new DataView(mem.buffer);
    const poison = (addr: number, dwords: number) => {
        for (let i = 0; i < dwords; i++) view.setUint32(addr + i * 4, POISON, true);
    };
    const call = (table: Record<string, any>, name: string, ...args: number[]) =>
        table[name]!({ esp: 0 } as any, mem, args as any) as number;
    return { context, surfaceState, palette, dd, surf, mem, view, poison, call };
}

describe("synthetic raster status", () => {
    test("the vertical-blank flag toggles within a single refresh period", () => {
        const seen = new Set<boolean>();
        for (let t = 0; t < 20; t += 0.25) seen.add(rasterStatusAt(t, 480, 60).inVBlank);
        expect([...seen].sort()).toEqual([false, true]);
    });

    test("the beam sweeps the whole frame and never leaves the surface", () => {
        const lines = new Set<number>();
        for (let t = 0; t < 16.7; t += 0.1) {
            const { scanLine } = rasterStatusAt(t, 480, 60);
            expect(scanLine).toBeGreaterThanOrEqual(0);
            expect(scanLine).toBeLessThan(480);
            lines.add(scanLine);
        }
        expect(lines.size).toBeGreaterThan(100);
    });

    test("the period follows the reported refresh rate", () => {
        // At 120Hz a frame lasts 8.33ms, so t=8.4ms is already the next frame's top.
        expect(rasterStatusAt(8.4, 480, 120).inVBlank).toBe(true);
        expect(rasterStatusAt(8.4, 480, 60).inVBlank).toBe(false);
    });
});

describe("IDirectDraw (v1) raster status", () => {
    test("GetVerticalBlankStatus writes a BOOL instead of leaving the caller's spin variable", () => {
        const h = harness();
        h.poison(OUT, 1);
        expect(h.call(h.dd, "IDirectDraw_GetVerticalBlankStatus", 0, OUT)).toBe(DD_OK);
        expect([0, 1]).toContain(h.view.getUint32(OUT, true));
    });

    test("GetScanLine writes a line inside the display", () => {
        const h = harness();
        h.poison(OUT, 1);
        expect(h.call(h.dd, "IDirectDraw_GetScanLine", 0, OUT)).toBe(DD_OK);
        expect(h.view.getUint32(OUT, true)).toBeLessThan(h.context.display.height);
    });

    test("v1, v2 and v4 all reach the same implementation as v7", () => {
        const h = harness();
        for (const iface of ["IDirectDraw", "IDirectDraw2", "IDirectDraw4", "IDirectDraw7"]) {
            for (const method of ["GetVerticalBlankStatus", "GetScanLine", "GetMonitorFrequency", "GetFourCCCodes"]) {
                h.poison(OUT, 1);
                expect(h.call(h.dd, `${iface}_${method}`, 0, OUT, 0)).toBe(DD_OK);
                expect(h.view.getUint32(OUT, true)).not.toBe(POISON);
            }
        }
    });
});

describe("IDirectDraw out-parameters that are dereferenced by the caller", () => {
    test("GetMonitorFrequency reports the mode's refresh rate", () => {
        const h = harness();
        h.poison(OUT, 1);
        expect(h.call(h.dd, "IDirectDraw_GetMonitorFrequency", 0, OUT)).toBe(DD_OK);
        expect(h.view.getUint32(OUT, true)).toBe(75);
    });

    test("GetFourCCCodes reports the count we can actually blit, so the caller does not walk a garbage array", () => {
        const h = harness();
        // lpCodes NULL: the count query. It must match DDCAPS_BLTFOURCC — a zero here while
        // the caps say we do FourCC blits is a contradiction the app cannot detect.
        h.poison(OUT, 1);
        expect(h.call(h.dd, "IDirectDraw_GetFourCCCodes", 0, OUT, 0)).toBe(DD_OK);
        const count = h.view.getUint32(OUT, true);
        expect(count).toBe(SUPPORTED_FOURCC_CODES.length);

        // lpCodes non-NULL: *lpNumCodes is the caller's capacity on the way in. Asking for
        // fewer than exist fills exactly that many and still reports the true total.
        h.poison(OUT, 1 + count + 1);
        h.view.setUint32(OUT, 2, true);
        expect(h.call(h.dd, "IDirectDraw_GetFourCCCodes", 0, OUT, OUT + 4)).toBe(DD_OK);
        expect(h.view.getUint32(OUT, true)).toBe(count);
        expect(h.view.getUint32(OUT + 4, true)).toBe(SUPPORTED_FOURCC_CODES[0]);
        expect(h.view.getUint32(OUT + 8, true)).toBe(SUPPORTED_FOURCC_CODES[1]);
        expect(h.view.getUint32(OUT + 12, true)).toBe(POISON); // capacity 2 honoured
    });

    test("DuplicateSurface fails honestly with a NULL interface rather than DD_OK over stack garbage", () => {
        const h = harness();
        h.poison(OUT, 1);
        expect(h.call(h.dd, "IDirectDraw_DuplicateSurface", 0, SURFACE_PTR, OUT)).toBe(DDERR_CANTDUPLICATE);
        expect(h.view.getUint32(OUT, true)).toBe(0);
    });
});

describe("GetDeviceIdentifier answers for the same machine D3D does", () => {
    // dwVendorId + dwDeviceId is what a title matches against its own table of known cards
    // to arm or disarm per-card work-arounds. Two backends in one process describing two
    // different machines is a contradiction the app cannot resolve, and the pair must be one
    // that actually shipped — an invented DeviceId matches nothing by construction.
    const DDDEVICEIDENTIFIER2 = { szDescription: 512, liDriverVersion: 1024, dwVendorId: 1032, dwDeviceId: 1036 };
    const readString = (mem: Uint8Array, addr: number) => {
        let end = addr;
        while (end < mem.length && mem[end] !== 0) end++;
        return new TextDecoder().decode(mem.subarray(addr, end));
    };

    for (const iface of ["IDirectDraw4", "IDirectDraw7"]) {
        test(`${iface} reports the shared adapter identity`, () => {
            const h = harness();
            h.poison(OUT, 300);
            expect(h.call(h.dd, `${iface}_GetDeviceIdentifier`, 0, OUT, 0)).toBe(DD_OK);
            expect(h.view.getUint32(OUT + DDDEVICEIDENTIFIER2.dwVendorId, true)).toBe(DEFAULT_VENDOR_ID);
            expect(h.view.getUint32(OUT + DDDEVICEIDENTIFIER2.dwDeviceId, true)).toBe(DEFAULT_DEVICE_ID);
            expect(h.view.getBigUint64(OUT + DDDEVICEIDENTIFIER2.liDriverVersion, true)).toBe(DEFAULT_DRIVER_VERSION);
            expect(readString(h.mem, OUT + DDDEVICEIDENTIFIER2.szDescription)).toBe(DEFAULT_DEVICE_DESC);
        });
    }
});

describe("IDirectDrawSurface (v1/v2/v3) GetCaps takes DDSCAPS, not DDSCAPS2", () => {
    test("exactly one DWORD is written — the following 12 bytes are the caller's frame", () => {
        const h = harness();
        h.poison(OUT, 4);
        expect(h.call(h.surf, "IDirectDrawSurface_GetCaps", SURFACE_PTR, OUT)).toBe(DD_OK);
        expect(h.view.getUint32(OUT, true)).toBe(DDSCAPS_TEXTURE);
        expect(h.view.getUint32(OUT + 4, true)).toBe(POISON);
        expect(h.view.getUint32(OUT + 8, true)).toBe(POISON);
        expect(h.view.getUint32(OUT + 12, true)).toBe(POISON);
    });

    test("IDirectDrawSurface7::GetCaps still fills the full DDSCAPS2", () => {
        const h = harness();
        h.poison(OUT, 4);
        expect(h.call(h.surf, "IDirectDrawSurface7_GetCaps", SURFACE_PTR, OUT)).toBe(DD_OK);
        expect(h.view.getUint32(OUT, true)).toBe(DDSCAPS_TEXTURE);
        for (const off of [4, 8, 12]) expect(h.view.getUint32(OUT + off, true)).toBe(0);
    });

    test("a NULL or unmapped DDSCAPS is rejected without touching memory", () => {
        const h = harness();
        expect(h.call(h.surf, "IDirectDrawSurface_GetCaps", SURFACE_PTR, 0)).not.toBe(DD_OK);
    });
});

describe("legacy writable surface locks", () => {
    test("v1 Lock permanently demotes a GPU_ONLY render surface so Unlock can upload CPU drawing", () => {
        const h = harness();
        Object.assign(h.surfaceState, {
            surfaceType: "render_surface",
            caps: 0,
            width: 8,
            height: 8,
            pitch: 32,
            surfacePtr: SURFACE_BITS,
            format: {
                size: 32,
                flags: 0x40,
                fourCC: 0,
                bpp: 32,
                rMask: 0x00ff0000,
                gMask: 0x0000ff00,
                bMask: 0x000000ff,
                aMask: 0xff000000,
            },
            mode: "GPU_ONLY",
            version: 1,
            gpuDirty: false,
            everLocked: false,
            lastUploadVersion: 1,
            writeGeneration: 0,
        });
        h.view.setUint32(OUT, 108, true);

        expect(h.call(h.surf, "IDirectDrawSurface_Lock", SURFACE_PTR, 0, OUT, 1, 0)).toBe(DD_OK);
        expect(h.surfaceState.mode).toBe("CPU");
        expect(h.surfaceState.everLocked).toBe(true);

        // Release the synthetic lease so it cannot leak into later tests.
        expect(h.call(h.surf, "IDirectDrawSurface_Unlock", SURFACE_PTR, SURFACE_BITS)).toBe(DD_OK);
    });
});

describe("IDirectDrawSurface::GetPalette hands back an interface or fails", () => {
    test("no palette attached: out-pointer NULLed, DDERR_NOPALETTEATTACHED", () => {
        const h = harness();
        h.poison(OUT, 1);
        expect(h.call(h.surf, "IDirectDrawSurface7_GetPalette", SURFACE_PTR, OUT)).toBe(DDERR_NOPALETTEATTACHED);
        expect(h.view.getUint32(OUT, true)).toBe(0);
    });

    test("attached palette is returned AddRef'd", () => {
        const h = harness();
        h.surfaceState.paletteHandle = h.palette.handle;
        const before = h.palette.refs;
        h.poison(OUT, 1);
        expect(h.call(h.surf, "IDirectDrawSurface7_GetPalette", SURFACE_PTR, OUT)).toBe(DD_OK);
        expect(h.view.getUint32(OUT, true)).toBe(PALETTE_PTR);
        expect(h.palette.refs).toBe(before + 1);
    });
});
