/**
 * WM_CTLCOLOR* capture: which answer means "fill the control background" and which
 * means "leave it alone". The transparent-caption idiom (return GetStockObject
 * (NULL_BRUSH) + SetBkMode(TRANSPARENT) so the dialog's bitmap shows through) must
 * not come back as an opaque COLOR_BTNFACE rectangle.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import {
    captureCtlColorResult,
    getControlColorOverride,
    invalidateControlColors,
    presetCtlColorDC,
} from "../../src/worker/modules/user32/control-colors";
import type { WindowInfo } from "../../src/worker/modules/user32/shared-state";

const WM_CTLCOLORSTATIC = 0x0138;
const NULL_BRUSH = 0x80000000 | 5; // GetStockObject(NULL_BRUSH/HOLLOW_BRUSH)
const TRANSPARENT = 1;
const HDC = 0x2000;

let nextHandle = 0;
const staticControl = (): WindowInfo => ({
    handle: 0x400 + nextHandle++,
    title: "caption",
    style: 0,
    x: 0,
    y: 0,
    width: 80,
    height: 16,
    children: [],
    visible: true,
    wndProc: 0,
    isSystemControl: true,
    systemControlClass: "Static",
});

// The System singleton is shared with every other test file in this process.
let savedGdi: unknown;
afterEach(() => { (System.getInstance() as any).gdiContext = savedGdi; });

/** Minimal GDI stand-in: the DC state WM_CTLCOLOR* actually reads back. */
function installGdiStub(): { setBrush(handle: number, css: string | null): void } {
    const brushes = new Map<number, string>();
    let bkMode = 2;
    let textColor = "#000000";
    let bkColor = "#C8D0D4";
    savedGdi = (System.getInstance() as any).gdiContext;
    (System.getInstance() as any).gdiContext = {
        setTextColor: (_hdc: number, color: number) => { textColor = `#${color.toString(16)}`; },
        setBkColor: (_hdc: number, color: number) => { bkColor = `#${color.toString(16)}`; },
        setBkMode: (_hdc: number, mode: number) => { const previous = bkMode; bkMode = mode; return previous; },
        getTextColorCss: () => textColor,
        getBkColorCss: () => bkColor,
        getBrushCss: (handle: number) => brushes.get(handle) ?? null,
    };
    return { setBrush: (handle, css) => { if (css) brushes.set(handle, css); } };
}

describe("WM_CTLCOLORSTATIC capture", () => {
    test("a hollow brush means DO NOT fill, whatever bk color the DC carries", () => {
        installGdiStub();
        const child = staticControl();
        presetCtlColorDC(child, HDC, WM_CTLCOLORSTATIC);
        System.getInstance().gdiContext.setBkMode(HDC, TRANSPARENT);
        captureCtlColorResult(child, HDC, NULL_BRUSH);

        const colors = getControlColorOverride(child.handle);
        expect(colors).toBeDefined();
        expect(colors!.fill).toBeUndefined();
        expect(colors!.bk).toBeDefined(); // still recorded, just not painted
    });

    test("a real brush fills with the brush color", () => {
        const gdi = installGdiStub();
        const child = staticControl();
        gdi.setBrush(0x1234, "#204080");
        presetCtlColorDC(child, HDC, WM_CTLCOLORSTATIC);
        captureCtlColorResult(child, HDC, 0x1234);

        expect(getControlColorOverride(child.handle)?.fill).toBe("#204080");
    });

    test("an unresolvable brush falls back to the DC bk color only while OPAQUE", () => {
        installGdiStub();
        const opaque = staticControl();
        presetCtlColorDC(opaque, HDC, WM_CTLCOLORSTATIC);
        captureCtlColorResult(opaque, HDC, 0x9999);
        expect(getControlColorOverride(opaque.handle)?.fill).toBeDefined();

        const transparent = staticControl();
        presetCtlColorDC(transparent, HDC, WM_CTLCOLORSTATIC);
        System.getInstance().gdiContext.setBkMode(HDC, TRANSPARENT);
        captureCtlColorResult(transparent, HDC, 0x9999);
        expect(getControlColorOverride(transparent.handle)?.fill).toBeUndefined();
    });

    test("LRESULT 0 (guest did not handle it) records no override at all", () => {
        installGdiStub();
        const child = staticControl();
        presetCtlColorDC(child, HDC, WM_CTLCOLORSTATIC);
        captureCtlColorResult(child, HDC, 0);
        expect(getControlColorOverride(child.handle)).toBeUndefined();

        invalidateControlColors(child.handle);
        expect(getControlColorOverride(child.handle)).toBeUndefined();
    });
});
