import { describe, expect, test } from 'bun:test';
import { registerWindowGeometryExports, clientSizeFromWindowSize } from '../../src/worker/modules/user32/window-geometry';
import { clientSizeFromCreateWindow } from '../../src/worker/modules/user32/window';

const WS_OVERLAPPED = 0x00000000;
const WS_CAPTION = 0x00C00000;
const WS_SYSMENU = 0x00080000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_OVERLAPPEDWINDOW =
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
const WS_POPUP = 0x80000000;
const WS_BORDER = 0x00800000;
const WS_EX_CLIENTEDGE = 0x00000200;

const RECT_PTR = 0x100;

/** Run AdjustWindowRectEx over a 0,0,w,h rect and return the resulting OUTER size. */
function adjust(
    api: Record<string, any>,
    style: number,
    exStyle: number,
    hasMenu: boolean,
    width: number,
    height: number,
): { width: number; height: number } {
    const mem = new Uint8Array(0x200);
    const view = new DataView(mem.buffer);
    view.setInt32(RECT_PTR + 0, 0, true);
    view.setInt32(RECT_PTR + 4, 0, true);
    view.setInt32(RECT_PTR + 8, width, true);
    view.setInt32(RECT_PTR + 12, height, true);
    const ok = api.AdjustWindowRectEx({} as any, mem, [RECT_PTR, style, hasMenu ? 1 : 0, exStyle]);
    expect(ok).toBe(1);
    return {
        width: view.getInt32(RECT_PTR + 8, true) - view.getInt32(RECT_PTR + 0, true),
        height: view.getInt32(RECT_PTR + 12, true) - view.getInt32(RECT_PTR + 4, true),
    };
}

describe('window client size', () => {
    const api: Record<string, any> = {};
    registerWindowGeometryExports(api);

    // The shape every windowed D3D app uses: expand an exact client rect, create the window
    // with that outer size, then read GetClientRect back for the backbuffer and the projection
    // aspect. WindowInfo stores the CLIENT size, so CreateWindowEx owes this conversion — and
    // getting it wrong is silent: the app renders for a client taller than the one presented
    // and loses the bottom rows.
    test('AdjustWindowRect and clientSizeFromWindowSize round-trip', () => {
        const cases: Array<{ style: number; exStyle: number; hasMenu: boolean; w: number; h: number }> = [
            { style: WS_OVERLAPPEDWINDOW, exStyle: 0, hasMenu: false, w: 800, h: 600 },
            { style: WS_OVERLAPPEDWINDOW, exStyle: 0, hasMenu: true, w: 640, h: 480 },
            { style: WS_OVERLAPPEDWINDOW, exStyle: WS_EX_CLIENTEDGE, hasMenu: false, w: 1024, h: 768 },
            { style: WS_CAPTION | WS_BORDER, exStyle: 0, hasMenu: false, w: 320, h: 240 },
            { style: WS_POPUP, exStyle: 0, hasMenu: false, w: 1280, h: 1024 },
        ];
        for (const c of cases) {
            const outer = adjust(api, c.style, c.exStyle, c.hasMenu, c.w, c.h);
            const client = clientSizeFromWindowSize(c.style, c.exStyle, c.hasMenu, outer.width, outer.height);
            expect({ ...client, style: c.style.toString(16) })
                .toEqual({ width: c.w, height: c.h, style: c.style.toString(16) });
        }
    });

    test('a framed window really is larger than its client, a borderless popup is not', () => {
        const framed = adjust(api, WS_OVERLAPPEDWINDOW, 0, false, 800, 600);
        expect(framed.width).toBeGreaterThan(800);
        expect(framed.height).toBeGreaterThan(600);

        // Without this the round-trip above would pass on an implementation that adjusts
        // nothing and converts nothing — two no-ops agree perfectly.
        const popup = adjust(api, WS_POPUP, 0, false, 800, 600);
        expect(popup).toEqual({ width: 800, height: 600 });
    });

    test('a child window keeps its size: no frame to subtract', () => {
        expect(clientSizeFromWindowSize(WS_POPUP, 0, false, 640, 480)).toEqual({ width: 640, height: 480 });
    });

    // The helper being right is not the same as the call site using it right: the menu bar
    // is 19px of client height, and hMenu is the only thing that says whether the window has
    // one. A create that hardcodes "no menu" is silent — GetClientRect is simply too tall.
    test('CreateWindowEx conversion honours hMenu on a top-level window', () => {
        const outer = adjust(api, WS_OVERLAPPEDWINDOW, 0, true, 640, 480);
        expect(clientSizeFromCreateWindow(WS_OVERLAPPEDWINDOW, 0, 0x2201, outer.width, outer.height))
            .toEqual({ width: 640, height: 480 });

        const noMenu = adjust(api, WS_OVERLAPPEDWINDOW, 0, false, 640, 480);
        expect(clientSizeFromCreateWindow(WS_OVERLAPPEDWINDOW, 0, 0, noMenu.width, noMenu.height))
            .toEqual({ width: 640, height: 480 });

        // Two menu states that convert identically would make the assertions above vacuous.
        expect(outer.height).not.toBe(noMenu.height);
    });

    test('CreateWindowEx conversion reads a child hMenu as a control id, not a menu', () => {
        // WS_CHILD: hMenu is the id; the child also has no frame to subtract.
        expect(clientSizeFromCreateWindow(0x40000000 | WS_BORDER, 0, 0x415, 200, 100))
            .toEqual({ width: 200, height: 100 });
    });

    test('the client size never collapses below one pixel', () => {
        const tiny = clientSizeFromWindowSize(WS_OVERLAPPEDWINDOW, 0, false, 2, 2);
        expect(tiny.width).toBeGreaterThanOrEqual(1);
        expect(tiny.height).toBeGreaterThanOrEqual(1);
    });
});
