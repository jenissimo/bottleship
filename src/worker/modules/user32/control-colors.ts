/**
 * WM_CTLCOLOR* query-and-cache.
 *
 * Real Windows sends WM_CTLCOLORSTATIC/EDIT/BTN/LISTBOX/SCROLLBAR to the parent
 * synchronously in the middle of painting each control; our control painting is
 * synchronous canvas code, so instead the queries ride the EndPaint guest-callback
 * chain (owner-draw.ts): first paint uses defaults, the query result (HBRUSH +
 * SetTextColor/SetBkColor recorded on the DC we hand the guest) is cached per
 * control hwnd, and one controls repaint applies it. Re-queried on every parent
 * EndPaint chain so dynamic color changes settle within a frame.
 */

import { System } from '../../core/system';
import { isStockObject, getStockObject } from '../gdi32/gdi-objects';
import { WindowInfo, windows, registerControlStatePurger } from './shared-state';
import { getSystemColorRef, COLOR_BTNFACE_INDEX } from './system';

export interface ControlColorOverride {
    /** CSS colors; undefined field = keep classic-theme default. */
    text?: string;
    bk?: string;
    /** Background the WM_CTLCOLOR* answer fills the control rect with.
     *  undefined = do NOT fill (the guest answered with a null/hollow brush, which is
     *  how a caption is drawn over a bitmap dialog background). */
    fill?: string;
}

const WM_CTLCOLOREDIT = 0x0133;
const WM_CTLCOLORLISTBOX = 0x0134;
const WM_CTLCOLORBTN = 0x0135;
const WM_CTLCOLORSCROLLBAR = 0x0137;
const WM_CTLCOLORSTATIC = 0x0138;

const ES_READONLY = 0x0800;
const WS_DISABLED = 0x08000000;

// Tri-state per control: absent = never queried (query on next EndPaint chain);
// present with no override = queried, guest didn't handle it (classic defaults);
// present with override = guest colors to apply.
const colorCache = new Map<number, { override?: ControlColorOverride }>();

// Registered lazily: shared-state sits in an import cycle with this module
// (shared-state → owner-draw → control-colors), so a top-level call would hit
// its consts in TDZ.
let purgerRegistered = false;
function ensurePurger(): void {
    if (purgerRegistered) return;
    purgerRegistered = true;
    registerControlStatePurger((hwnd) => colorCache.delete(hwnd));
}

/** Painter accessor: cached WM_CTLCOLOR* result for a control, if the guest answered. */
export function getControlColorOverride(hwnd: number): ControlColorOverride | undefined {
    return colorCache.get(hwnd)?.override;
}

/** Drop the cached answer so the next EndPaint chain re-queries (InvalidateRect). */
export function invalidateControlColors(hwnd: number): void {
    colorCache.delete(hwnd);
}

const BS_TYPEMASK = 0x0000000f;
/** BS_CHECKBOX/AUTOCHECKBOX/RADIOBUTTON/3STATE/AUTO3STATE, BS_GROUPBOX, BS_AUTORADIOBUTTON. */
const STATIC_LIKE_BUTTON_TYPES = new Set([0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x09]);

/**
 * A button's face is fixed (DrawFrameControl), so only the button types that draw a
 * label straight onto the parent's background ask for a background at all — and those
 * ask as STATICS, not as buttons: Wine button.c:847 (check boxes / radios) and :987
 * (group box, "GroupBox acts like static control"). Only the push/owner-draw family
 * sends WM_CTLCOLORBTN (button.c:221, :1039). Asking with the wrong message loses the
 * answer entirely — an app that gives its check-box labels a transparent background
 * over a bitmap dialog handles WM_CTLCOLORSTATIC and ignores WM_CTLCOLORBTN.
 */
function buttonCtlColorMessage(child: WindowInfo): number {
    return STATIC_LIKE_BUTTON_TYPES.has(child.style & BS_TYPEMASK)
        ? WM_CTLCOLORSTATIC : WM_CTLCOLORBTN;
}

/** WM_CTLCOLOR* message for a control class (null = class has no color query). */
export function ctlColorMessageFor(child: WindowInfo): number | null {
    switch ((child.systemControlClass ?? '').trim().toLowerCase()) {
        case 'static':
            return WM_CTLCOLORSTATIC;
        case 'edit':
            // Read-only/disabled edits are queried as statics (real user32 behavior).
            return (child.style & (ES_READONLY | WS_DISABLED)) !== 0
                ? WM_CTLCOLORSTATIC : WM_CTLCOLOREDIT;
        case 'button':
            return buttonCtlColorMessage(child);
        case 'listbox':
            return WM_CTLCOLORLISTBOX;
        case 'scrollbar':
            return WM_CTLCOLORSCROLLBAR;
        case 'msctls_trackbar32':
            // comctl32's trackbar erases its client with the parent's brush before
            // drawing channel/thumb/ticks (Wine trackbar.c:965) — a static query.
            return WM_CTLCOLORSTATIC;
        default:
            return null;
    }
}

/** Visible system-control children of parentHwnd eligible for a WM_CTLCOLOR* query. */
export function enumerateCtlColorChildren(parentHwnd: number): WindowInfo[] {
    const parent = windows.get(parentHwnd);
    if (!parent?.wndProc || parent.isSystemControl) return [];
    const out: WindowInfo[] = [];
    for (const childHwnd of parent.children) {
        const child = windows.get(childHwnd);
        if (!child || !child.visible || !child.isSystemControl) continue;
        if (colorCache.has(child.handle)) continue; // answered; InvalidateRect re-queries
        if (ctlColorMessageFor(child) !== null) out.push(child);
    }
    return out;
}

// COLORREF (0x00BBGGRR) class defaults preset on the query DC, mirroring the
// system-color state real user32 hands to the app (it may change only part of it).
const COLORREF_BLACK = 0x00000000;
const COLORREF_WHITE = 0x00FFFFFF;
/** WM_CTLCOLOR* bk colour: the same face the control is painted with, or opaque
 *  guest text lands on a rectangle of the wrong grey. */
const btnFaceColorRef = (): number => getSystemColorRef(COLOR_BTNFACE_INDEX);

const BKMODE_TRANSPARENT = 1;
const BKMODE_OPAQUE = 2;

/** Preset the query DC with the class's default text/bk colors before the guest sees it. */
export function presetCtlColorDC(child: WindowInfo, hdc: number, ctlColorMsg: number): void {
    const gdi = System.getInstance().gdiContext;
    const fieldBk = ctlColorMsg === WM_CTLCOLOREDIT || ctlColorMsg === WM_CTLCOLORLISTBOX;
    gdi.setTextColor(hdc, COLORREF_BLACK);
    gdi.setBkColor(hdc, fieldBk ? COLORREF_WHITE : btnFaceColorRef());
    // OPAQUE is the Win32 DC default; our memory DCs start TRANSPARENT, and the guest's
    // own SetBkMode is only readable as a CHANGE from a known starting point.
    gdi.setBkMode(hdc, BKMODE_OPAQUE);
}

/** CSS for an HBRUSH, resolving the stock handles gdiContext's object table never
 *  holds. 'transparent' is the stock NULL/HOLLOW brush; null = unresolvable. */
function brushCss(returnedBrush: number): string | null {
    const css = System.getInstance().gdiContext.getBrushCss(returnedBrush);
    if (css !== null) return css;
    if (!isStockObject(returnedBrush)) return null;
    const stock = getStockObject(returnedBrush);
    return stock?.type === 'BRUSH' && typeof stock.data === 'string' ? stock.data : null;
}

/**
 * Capture the guest's WM_CTLCOLOR* answer: hdcResult carries SetTextColor/SetBkColor
 * the guest applied; returnedBrush is the LRESULT (HBRUSH). Returns true when the
 * cached value changed (caller repaints controls once at chain end).
 */
export function captureCtlColorResult(
    child: WindowInfo, hdcResult: number, returnedBrush: number,
): boolean {
    ensurePurger();
    const gdi = System.getInstance().gdiContext;
    // LRESULT 0 = guest didn't handle it (DefWindowProc) — keep classic defaults,
    // but remember the answer so the chain doesn't re-ask every paint.
    if (!returnedBrush) {
        const hadOverride = !!colorCache.get(child.handle)?.override;
        colorCache.set(child.handle, {});
        return hadOverride;
    }
    // SetBkMode returns the PREVIOUS mode (Win32) — the only way to read back what the
    // guest set, gdiContext exposing no getter. Probe and restore.
    const bkMode = gdi.setBkMode(hdcResult, BKMODE_OPAQUE);
    gdi.setBkMode(hdcResult, bkMode);

    const css = brushCss(returnedBrush);
    const bk = gdi.getBkColorCss(hdcResult) ?? undefined;
    const next: ControlColorOverride = {
        text: gdi.getTextColorCss(hdcResult) ?? undefined,
        bk,
        // A hollow brush is an explicit "leave the background alone". An unresolvable
        // brush falls back to the DC's bk color, but only while the guest is painting
        // OPAQUE — under TRANSPARENT that color is not a background it wants filled.
        fill: css === 'transparent' ? undefined
            : (css ?? (bkMode === BKMODE_TRANSPARENT ? undefined : bk)),
    };
    const prev = colorCache.get(child.handle)?.override;
    colorCache.set(child.handle, { override: next });
    return !prev || prev.text !== next.text || prev.bk !== next.bk || prev.fill !== next.fill;
}
