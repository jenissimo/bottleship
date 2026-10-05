/**
 * Windowed DirectDraw and the GDI overlay: which window decides that the game's frame,
 * not the desktop, is what the display shows.
 *
 * `SetCooperativeLevel(NULL, DDSCL_NORMAL)` is legal — the hwnd argument is only required
 * for DDSCL_EXCLUSIVE — so a borderless-fullscreen app can name its window solely through
 * the clipper it attaches to the primary (which is what the blit is clipped against).
 * Deciding ownership on the cooperative window alone leaves that app's every presented
 * frame composited under its own opaque window background: a black screen over a game
 * that is rendering perfectly.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { ddrawShowsContent } from "../../src/worker/modules/ddraw/gdi-visibility";
import { DirectDrawClipperObject, DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { windows as sharedWindows } from "../../src/worker/modules/user32/shared-state";
import type { DDrawContext } from "../../src/worker/modules/ddraw/context";

const DDSCL_FULLSCREEN = 0x00000001;
const DDSCL_EXCLUSIVE = 0x00000010;
const DDSCL_NORMAL = 0x00000008;

const DISPLAY = { width: 1024, height: 768, bpp: 32, refresh: 60 };
const GAME_HWND = 0x10001;
const PRIMARY_ADDR = 0x1f300000;
const CLIPPER_HANDLE = 0x1050;

/** A stand-in for the primary surface: `surfaceAt` only needs the instanceof to hold and
 *  `getState()` to answer, so the real surface object — whose constructor reaches into
 *  System for the texture registry — stays out of here. */
class FakeSurface {
    constructor(private readonly clipperHandle: number | undefined) {}
    getState(): { clipperHandle?: number } {
        return { clipperHandle: this.clipperHandle };
    }
}
Object.setPrototypeOf(FakeSurface.prototype, DirectDrawSurfaceObject.prototype);

function context(opts: {
    coopHwnd: number;
    flags: number;
    clipperHwnd?: number;
    clipperAttached?: boolean;
    presented?: boolean;
}): DDrawContext {
    const clipper = new DirectDrawClipperObject(0);
    clipper.setHwnd(opts.clipperHwnd ?? 0);
    const surface = new FakeSurface(opts.clipperAttached === false ? undefined : CLIPPER_HANDLE);
    return {
        display: { ...DISPLAY },
        cooperative: { hwnd: opts.coopHwnd, flags: opts.flags },
        surfaces: { primary: PRIMARY_ADDR },
        presenter: { hasPresentedFrame: () => opts.presented !== false },
        resourceProvider: {
            getComObjectByAddress: (addr: number) => (addr === PRIMARY_ADDR ? surface : null),
            getComObject: (handle: number) => (handle === CLIPPER_HANDLE ? clipper : null),
        },
    } as unknown as DDrawContext;
}

describe("ddrawShowsContent", () => {
    beforeEach(() => {
        sharedWindows.clear();
    });

    /** `surfaceAt` resolves through instanceof DirectDrawSurfaceObject, and a fake that
     *  stopped passing it would make every case below answer false for the wrong reason —
     *  a green suite measuring nothing. Assert the seam instead of assuming it. */
    test("the fake primary is what surfaceAt accepts", () => {
        expect(new FakeSurface(CLIPPER_HANDLE)).toBeInstanceOf(DirectDrawSurfaceObject);
    });

    function addWindow(hwnd: number, width: number, height: number, visible = true): void {
        sharedWindows.set(hwnd, { hwnd, x: 0, y: 0, width, height, visible } as never);
    }

    test("exclusive fullscreen owns the screen regardless of any window", () => {
        addWindow(GAME_HWND, 640, 480);
        const ctx = context({ coopHwnd: GAME_HWND, flags: DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN });
        expect(ddrawShowsContent(ctx)).toBe(true);
    });

    test("windowed app whose clipper window covers the display owns the screen", () => {
        addWindow(GAME_HWND, 1280, 1024);
        const ctx = context({ coopHwnd: 0, flags: DDSCL_NORMAL, clipperHwnd: GAME_HWND });
        expect(ddrawShowsContent(ctx)).toBe(true);
    });

    test("windowed app with a window smaller than the display still composites GDI", () => {
        addWindow(GAME_HWND, 640, 480);
        const ctx = context({ coopHwnd: 0, flags: DDSCL_NORMAL, clipperHwnd: GAME_HWND });
        expect(ddrawShowsContent(ctx)).toBe(false);
    });

    test("no window to judge — neither cooperative hwnd nor clipper — composites GDI", () => {
        addWindow(GAME_HWND, 1280, 1024);
        const ctx = context({ coopHwnd: 0, flags: DDSCL_NORMAL, clipperAttached: false });
        expect(ddrawShowsContent(ctx)).toBe(false);
    });

    test("a primary that has never been presented holds nothing", () => {
        addWindow(GAME_HWND, 1280, 1024);
        const ctx = context({ coopHwnd: 0, flags: DDSCL_NORMAL, clipperHwnd: GAME_HWND, presented: false });
        expect(ddrawShowsContent(ctx)).toBe(false);
    });

    test("a hidden covering window is not on screen", () => {
        addWindow(GAME_HWND, 1280, 1024, false);
        const ctx = context({ coopHwnd: 0, flags: DDSCL_NORMAL, clipperHwnd: GAME_HWND });
        expect(ddrawShowsContent(ctx)).toBe(false);
    });
});
