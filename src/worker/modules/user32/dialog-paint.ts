/**
 * User32 dialog overlay painting. Renders a dialog's chrome (gray face + NC
 * frame) and its OS-owned controls onto the GDI overlay canvas, and decides
 * when the guest owns the client pixels instead (guestCustomPaint → route
 * through the WM_PAINT chain).
 */
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { WindowInfo, windows, isEffectivelyVisible, getAbsoluteWindowPosition, getAncestorClipRect, ensureHostCursorForDialog, getChildrenInPaintOrder } from './shared-state';
import { paintChildControls, repaintChildControls, paintDialogClientMessage, registerOwnedPopupRestamper } from './controls';
import { registerFullDialogRepainter, registerOverlayRepairRepainter } from './control-interaction';
import { getWindowVisualBounds } from './dialog-overlay';
import type { GDIContext } from '../gdi32/context';
import { paintTraceEnabled, logPaintRequest } from './paint-trace';

/** Win32 COLOR_BTNFACE as COLORREF (0x00BBGGRR). */
const COLOR_DLGFACE = 0x00C8D0D4;

const WM_PAINT = 0x000F;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;

/**
 * Owned popup dialogs (a #32770 whose owner is `hwnd` or one of its descendants)
 * sit ABOVE `hwnd` in Win32 Z-order — an owned window is always above its owner.
 * The GDI overlay is a single flat canvas with no per-window clip region, so a
 * repaint of the lower owner (its background, its own controls, a WM_PAINT burst)
 * bleeds over those popups. Windows avoids this by clipping the owner's DC to
 * exclude windows above it; we instead re-stamp the popups on top after the owner
 * paints. Returned bottom→top (owner-chain / creation order) so nested modal
 * stacks re-composite in the right order.
 */
function collectOwnedPopupsAbove(hwnd: number): number[] {
    const out: number[] = [];
    const visit = (h: number): void => {
        const w = windows.get(h);
        if (!w) return;
        for (const childHwnd of w.children) {
            const c = windows.get(childHwnd);
            if (!c) continue;
            if (c.visible && (c.style & WS_CHILD) === 0 && (c.style & WS_POPUP) !== 0) {
                out.push(childHwnd);
            }
            visit(childHwnd);
        }
    };
    visit(hwnd);
    return out;
}

/**
 * Paint a dialog and all its children directly to the GDI overlay canvas.
 * This provides immediate visual feedback without waiting for WM_PAINT dispatch.
 */

/**
 * Deprecated compatibility alias. Template shape never implies client ownership.
 * app uses to say "I own these buttons' pixels" — Windows' Button proc responds to
 * an owner-draw button by sending WM_DRAWITEM to the parent instead of self-painting.
 * It is NOT used to skip OS-owned controls (statics/edits) — those always paint, just
 * like Windows' own control procs do.
 */
/** Runtime: after guest actually painted the client, ask it to repaint that client. */
function shouldUseGuestDialogPaint(win: WindowInfo): boolean {
    return !!win.guestCustomPaint;
}

/** User dlgProc — stored in win.wndProc (NOT the guest-owned DWLP extra-byte area). */
function getDialogProcedure(win: WindowInfo): number {
    return win.wndProc ?? 0;
}

/**
 * Queue WM_PAINT for a dialog whose client was actually painted by the guest.
 * Guest must dispatch via PeekMessage/GetMessage → DispatchMessage.
 */
export function requestGuestDialogPaint(dialogHwnd: number): void {
    const win = windows.get(dialogHwnd);
    if (!win?.visible) {
        if (paintTraceEnabled) logPaintRequest(dialogHwnd, false, win ? 'not-visible' : 'no-window');
        return;
    }
    if (!shouldUseGuestDialogPaint(win)) {
        if (paintTraceEnabled) logPaintRequest(dialogHwnd, false, 'no-guestCustomPaint');
        return;
    }
    if (!getDialogProcedure(win)) {
        if (paintTraceEnabled) logPaintRequest(dialogHwnd, false, 'no-dlgProc');
        return;
    }
    if (paintTraceEnabled) logPaintRequest(dialogHwnd, true, 'posted');

    const system = System.getInstance();
    system.windowManager.postMessage(dialogHwnd, WM_PAINT, 0, 0);
    system.scheduler.wakeMessageWaiters();
    Logger.log(LogCategory.USER32,
        `requestGuestDialogPaint: posted WM_PAINT hwnd=0x${dialogHwnd.toString(16)}`);
}

/**
 * Drop a control's pixels before its new content is stamped.
 *
 * Only for a control whose parent GUEST-paints its client: there, 'controls' mode stamps
 * the control straight onto the flat overlay with no way to restore what was under it, so
 * a changed caption renders on top of the old one and both stay readable. Clearing first
 * makes the overlay repair (ancestor-aware) restore the background and the control is then
 * drawn once. A parent we paint ourselves needs none of this — its background is redrawn.
 */
/**
 * Put back the guest's OWN pixels for the rect `win` occupies, from the client image an
 * ancestor last flushed (captured before any control was stamped over it).
 *
 * Walk up: the backdrop under a window belongs to whichever ancestor painted that area — a
 * page dialog, or the frame behind it. Works for a control's rect and for a whole page being
 * hidden; the alternative, clearing to transparent, leaves a hole the guest never repaints
 * (a teal band across the dialog where the previous page was).
 */
export function restoreClientRectFromAncestors(win: WindowInfo): boolean {
    const gdi = System.getInstance().gdiContext;
    if (!gdi?.restoreWindowClientRect) return false;
    const origin = getAbsoluteWindowPosition(win);
    const w = Math.max(1, win.width);
    const h = Math.max(1, win.height);
    for (let anc = win.parent !== undefined ? windows.get(win.parent) : undefined; anc;
         anc = anc.parent !== undefined ? windows.get(anc.parent) : undefined) {
        if (gdi.restoreWindowClientRect(anc.handle, origin.x, origin.y, w, h)) return true;
    }
    return false;
}

export function eraseControlOverlayRect(child: WindowInfo): boolean {
    // System controls ONLY — the things WE stamp. A child WINDOW paints itself and can be
    // page-sized; flooding its whole rect with one sampled colour paints over everything it
    // covers (observed: hiding a menu page filled the screen area outside the frame grey).
    // Those go through eraseDialogOverlay's clear + repair instead.
    if (!child.isSystemControl) return false;
    const parent = child.parent !== undefined ? windows.get(child.parent) : undefined;
    if (!parent?.guestCustomPaint) return false;
    // ONLY erase when the exact pixels can be put back. Clearing as a fallback is worse
    // than leaving the old ones: the clear triggers the overlay repair, which repaints a
    // dialog in 'full' mode and stamps the standard grey COLOR_DLGFACE across the guest's
    // splash — a grey box, plus the caption drawn twice. And there is nothing stale to
    // remove in that case anyway: no backing exists precisely because the dialog has not
    // painted its client yet, so its captions are being set for the FIRST time.
    return restoreClientRectFromAncestors(child);
}

function paintDialogBackground(win: WindowInfo, hdc: number, gdi: GDIContext): void {
    // Fill the dialog's full VISUAL bounds (rect ∪ child rects), not just its own
    // rect: a game can size the dialog window smaller than its template-laid-out
    // children (DLU scale mismatch), and filling only win.width/height would leave
    // the overflowing children sitting on black instead of the gray dialog face.
    const bounds = getWindowVisualBounds(win.handle)
        ?? (() => { const { x, y } = getAbsoluteWindowPosition(win); return { x, y, w: win.width, h: win.height }; })();
    const hBrush = gdi.createSolidBrush(COLOR_DLGFACE);
    const prevBrush = gdi.selectObject(hdc, hBrush);
    gdi.fillRect(hdc, bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h);
    gdi.selectObject(hdc, prevBrush);
    gdi.deleteObject(hBrush);
}

/** Non-client dialog frame (WM_NCPAINT approximation for #32770). */
function paintDialogNcFrame(win: WindowInfo, hdc: number, gdi: GDIContext): void {
    if (win.nativeClassName !== '#32770') return;
    const bounds = getWindowVisualBounds(win.handle)
        ?? (() => { const { x, y } = getAbsoluteWindowPosition(win); return { x, y, w: win.width, h: win.height }; })();
    const ctx = gdi.getDC(hdc);
    if (!ctx) return;
    const x0 = bounds.x;
    const y0 = bounds.y;
    const x1 = bounds.x + bounds.w;
    const y1 = bounds.y + bounds.h;
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#808080';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, bounds.w - 1, bounds.h - 1);
    ctx.strokeStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y1 - 0.5);
    ctx.lineTo(x0 + 0.5, y0 + 0.5);
    ctx.lineTo(x1 - 0.5, y0 + 0.5);
    ctx.stroke();
    gdi.setOverlayDirty(true);
}

function paintWindowSubtreeToOverlay(
    hwnd: number,
    hdc: number,
    visited: Set<number>,
    mode: 'full' | 'controls',
): void {
    if (visited.has(hwnd)) return;
    visited.add(hwnd);

    const system = System.getInstance();
    const gdi = system.gdiContext;
    const win = windows.get(hwnd);
    if (!win || !isEffectivelyVisible(win)) return;

    // Win32 clips a child window's pixels to every ancestor's client area; the overlay
    // is one flat canvas, so apply that clip ourselves for the whole of this window's
    // paint (its face, its frame and its controls all go through the same ctx).
    const clip = getAncestorClipRect(win);
    const ctx = clip ? gdi.getDC(hdc) : undefined;
    if (clip && ctx) {
        if (clip.w <= 0 || clip.h <= 0) return; // fully outside an ancestor
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
    }

    // Background and controls for dialog/custom windows.
    // System controls are painted by paintChildControls(parent).
    if (!win.isSystemControl) {
        // The guest owns the client area when it declares owner-draw buttons or has
        // custom-painted (its WM_PAINT/WM_ERASEBKGND draws the background, e.g. a splash).
        const guestPaintsClient = !!win.guestCustomPaint;
        if (mode === 'full' && !guestPaintsClient) {
            paintDialogBackground(win, hdc, gdi);
            paintDialogNcFrame(win, hdc, gdi);
        }
        // OS-owned child controls (statics, edits, non-owner-draw buttons) always paint,
        // exactly like Windows' own control window-procs. Owner-draw buttons early-out
        // inside paintChildControls — the guest paints those via the WM_DRAWITEM chain.
        paintChildControls(win.handle, hdc, gdi);
        paintDialogClientMessage(hdc, gdi, win);
    }

    if (clip && ctx) ctx.restore();

    for (const childHwnd of getChildrenInPaintOrder(win.handle)) {
        paintWindowSubtreeToOverlay(childHwnd, hdc, visited, mode);
    }
}

export function paintDialogToOverlay(dialogHwnd: number, mode: 'full' | 'controls' = 'full'): void {
    const system = System.getInstance();
    const gdi = system.gdiContext;
    const hdc = gdi.createOverlayDC();
    if (!hdc) return;

    ensureHostCursorForDialog();
    paintWindowSubtreeToOverlay(dialogHwnd, hdc, new Set<number>(), mode);

    // Restore Z-order on the flat overlay: re-stamp any owned popup dialogs that
    // float above this window so an owner repaint never bleeds over its modal.
    for (const popup of collectOwnedPopupsAbove(dialogHwnd)) {
        paintWindowSubtreeToOverlay(popup, hdc, new Set<number>(), 'full');
    }

    gdi.releaseDC(hdc);
    Logger.log(LogCategory.USER32,
        `paintDialogToOverlay: painted dialog 0x${dialogHwnd.toString(16)} to overlay (${mode})`);
}

/**
 * Re-stamp owned popup dialogs above `hwnd` on top of the overlay. For repaint
 * paths that draw only a lower window's controls (repaintChildControls) rather
 * than routing through paintDialogToOverlay — without this, a control-only
 * repaint of an owner would leave its modal partially overpainted.
 */
export function restampOwnedPopupsAbove(hwnd: number): void {
    const popups = collectOwnedPopupsAbove(hwnd);
    if (popups.length === 0) return;
    const gdi = System.getInstance().gdiContext;
    const hdc = gdi.createOverlayDC();
    if (!hdc) return;
    for (const popup of popups) {
        paintWindowSubtreeToOverlay(popup, hdc, new Set<number>(), 'full');
    }
    gdi.releaseDC(hdc);
}

/** Repaint a visible dialog after DDraw SetDisplayMode / overlay resize wiped the canvas. */
export function repaintDialogOverlayIfVisible(dialogHwnd: number): void {
    const win = windows.get(dialogHwnd);
    if (!win?.visible) return;
    if (shouldUseGuestDialogPaint(win)) {
        requestGuestDialogPaint(dialogHwnd);
        return;
    }
    paintDialogToOverlay(dialogHwnd, 'full');
}

/** After overlay pixels were cleared (dialog close/move), repaint any exposed dialog. */
function repaintOverlayWindowAfterErase(dialogHwnd: number): void {
    repaintDialogOverlayIfVisible(dialogHwnd);
}

// control-interaction.ts needs a full-dialog repaint after a combobox dropdown
// closes (the dropdown overpainted sibling controls); registered as a hook to
// avoid a dialog.ts <-> control-interaction.ts import cycle at module load.
registerFullDialogRepainter(repaintDialogOverlayIfVisible);
registerOverlayRepairRepainter(repaintOverlayWindowAfterErase);
registerOwnedPopupRestamper(restampOwnedPopupsAbove);

/**
 * Repaint after a control's content changed. For a standard dialog composited
 * over a DDraw flip chain (overlayOnFlipScreen), repaint the FULL dialog so the
 * gray face + every control are re-laid each time — the overlay canvas can be
 * wiped by a DDraw display-mode change between frames, and a controls-only
 * repaint would then leave the background and dark-text statics missing. For an
 * ordinary GDI dialog, a controls-only repaint is enough (and cheaper).
 */
export function repaintDialogAfterContentChange(parentHwnd: number): void {
    const win = windows.get(parentHwnd);
    // Guest already drew the dialog client (WM_PAINT flush). Only repaint OS controls.
    if (win?.guestCustomPaint) {
        // NOTE: 'controls' stamps each control over whatever is already on the flat overlay;
        // it cannot restore the background UNDER one. A control whose text changed keeps the
        // old string showing through the new one, and a hidden control keeps its pixels.
        // Neither requesting a guest WM_PAINT here nor erasing the rect in ShowWindow fixes
        // it (measured: the first changes nothing, the second resurrects hidden pages via the
        // overlay repair) — the real fix is ancestor-aware visibility in the painters plus a
        // retained per-window backing store.
        paintDialogToOverlay(parentHwnd, 'controls');
        return;
    }
    let cur = win;
    const visited = new Set<number>();
    while (cur && !visited.has(cur.handle)) {
        if (cur.overlayOnFlipScreen) {
            repaintDialogOverlayIfVisible(cur.handle);
            return;
        }
        visited.add(cur.handle);
        cur = cur.parent ? windows.get(cur.parent) : undefined;
    }
    repaintChildControls(parentHwnd);
}

/** After WM_INITDIALOG: repaint without wiping guest GDI draws on custom-painted dialogs. */
export function finalizeDialogPaint(dialogHwnd: number): void {
    const win = windows.get(dialogHwnd);
    // A dialog whose guest paints its own client area (FillRect/blits in WM_PAINT)
    // must keep that art — only refresh the OS-drawn controls on top ('controls').
    // A standard #32770 dialog draws no client of its own; it needs the full chrome
    // (gray dialog face + every control), or its background and any control with
    // dark text on the default theme (statics) is invisible on the cleared canvas.
    // The previous child-count<=4 heuristic mislabeled larger standard dialogs (e.g.
    // Tiberian Sun's 7-control "Select Campaign") as custom-painted.
    const mode = win?.guestCustomPaint ? 'controls' : 'full';
    paintDialogToOverlay(dialogHwnd, mode);
}
