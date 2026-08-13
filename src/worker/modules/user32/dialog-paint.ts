/**
 * User32 dialog overlay painting. Renders a dialog's chrome (gray face + NC
 * frame) and its OS-owned controls onto the GDI overlay canvas, and decides
 * when the guest owns the client pixels instead (guestCustomPaint → route
 * through the WM_PAINT chain).
 */
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { WindowInfo, windows, isEffectivelyVisible, getAbsoluteWindowPosition, getAncestorClipRect, ensureHostCursorForDialog, getChildrenInPaintOrder, hasSystemControlChildren } from './shared-state';
import { paintChildControls, repaintChildControls, restoreClientUnderStampedControls } from './controls';
import { registerOwnedPopupRestamper } from './paint-hooks';
import { registerFullDialogRepainter, registerOverlayRepairRepainter } from './control-interaction';
import { getWindowVisualBounds, eraseDialogOverlay, repairOverlayWindowsOverlappingRect } from './dialog-overlay';
import { invalidateWindow, hasPendingUpdate, type ClientRect } from './paint-region';
import type { GDIContext } from '../gdi32/context';
import { paintTraceEnabled, logPaintRequest, logOverlayMutation, logChromeStamp } from './paint-trace';
import { getSystemColorRef, COLOR_BTNFACE_INDEX } from './system';

/** Dialog face as COLORREF (0x00BBGGRR), from the live system palette. */
const dlgFaceColorRef = (): number => getSystemColorRef(COLOR_BTNFACE_INDEX);

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
 *
 * The INVALIDATE is half the request, not a detail: a bare WM_PAINT reaches BeginPaint
 * with an empty update region and fErase=FALSE, so the guest repaints over pixels USER
 * never erased. Every caller here is an exposure (a popup closed, a window was hidden,
 * the canvas was wiped), which is exactly the case Win32 invalidates WITH erase — and on
 * our flat overlay the exposed pixels are transparent, so skipping the erase publishes
 * the bare DirectDraw surface through the hole.
 */
export function requestGuestDialogPaint(dialogHwnd: number, rect: ClientRect | null = null): void {
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
    // Only SUPPLY an update region, never overwrite one: a caller that already invalidated
    // (InvalidateRect with a rect and bErase=FALSE is the whole point of the API) has said
    // exactly what to repaint, and widening that to the full client with an erase would
    // make every partial repaint a full one.
    if (!hasPendingUpdate(dialogHwnd)) invalidateWindow(dialogHwnd, rect, true);
    system.windowManager.postMessage(dialogHwnd, WM_PAINT, 0, 0);
    system.scheduler.wakeMessageWaiters();
    Logger.log(LogCategory.USER32,
        `requestGuestDialogPaint: posted WM_PAINT hwnd=0x${dialogHwnd.toString(16)}`);
}

/**
 * USER's default chrome — the COLOR_BTNFACE face plus the OS-drawn look of every control
 * — is the ELSE branch of a window's paint cycle: DefDlgProc answers WM_PAINT with
 * BeginPaint/EndPaint (runDefaultWindowPaint) and draws it only when the window's own
 * paint reached the overlay with nothing. Publishing it OUTSIDE that cycle, as a prologue,
 * shows default chrome for however long the guest's WM_PAINT takes to be pumped, and the
 * guest's art then replaces it — grey on every dialog/menu state change.
 *
 * So the two eager stampers below hold off while this is true: a dialog with a wndProc
 * that has never completed a paint cycle. `guestCustomPaint === false` cannot decide it —
 * the latch is set BY a paint, so before the first one it reads "never" for a window that
 * simply has not been asked yet. After that first cycle nothing changes: the latch is
 * authoritative and every repaint behaves exactly as before.
 */
function firstPaintCyclePending(win: WindowInfo): boolean {
    // A/B switch: restores the eager stamp, i.e. reproduces the flash on demand. The
    // regression for this is an ORDERING check, and an ordering check nobody has seen
    // fail is indistinguishable from one that cannot.
    if ((globalThis as { __noDeferDialogChrome?: boolean }).__noDeferDialogChrome) return false;
    return !win.paintCycleRan && !win.guestCustomPaint && !!getDialogProcedure(win);
}

/**
 * The paint we deferred to has to actually arrive. It comes off the message queue, so a
 * guest that stops pumping (or never starts) would leave the window unpainted forever —
 * and unlike the chrome we skipped, nothing else would ever draw it. If the update region
 * is still unconsumed after this long, USER's default paint runs anyway; the trace records
 * it, so a title that lives on this fallback is visible rather than silently late.
 */
const DEFAULT_CHROME_DEADLINE_MS = 250;
const chromeDeadlines = new Map<number, ReturnType<typeof setTimeout>>();

function stampDefaultChromeIfPaintNeverCame(hwnd: number): void {
    chromeDeadlines.delete(hwnd);
    const win = windows.get(hwnd);
    // A net that declines has to say so: "it never fired" and "it fired and found the
    // paint had landed" are the same silence otherwise, and only the second is healthy.
    const reason = !win ? 'gone'
        : win.pendingDestroy ? 'destroying'
        : !isEffectivelyVisible(win) ? 'not-visible'
        : win.guestCustomPaint ? 'guest-painted'
        : win.paintCycleRan ? 'paint-cycle-ran'
        : null;
    if (paintTraceEnabled) {
        logOverlayMutation('defaultChromeDeadline', hwnd,
            reason ? `declined: ${reason}` : `fired: no paint cycle in ${DEFAULT_CHROME_DEADLINE_MS}ms`);
    }
    if (reason) return;
    paintDialogToOverlay(hwnd, 'full');
}

/**
 * Ask the window for the paint whose default branch draws the chrome. Win32's own
 * UpdateWindow/InvalidateRect do exactly this — mark invalid, let WM_PAINT reach the
 * window procedure — and DefDlgProc is where the class background and the controls
 * come from.
 */
function requestDefaultDialogPaint(win: WindowInfo): void {
    const system = System.getInstance();
    if (!hasPendingUpdate(win.handle)) invalidateWindow(win.handle, null, true);
    system.windowManager.postMessage(win.handle, WM_PAINT, 0, 0);
    system.scheduler.wakeMessageWaiters();
    if (paintTraceEnabled) logPaintRequest(win.handle, true, 'default-paint (chrome deferred to its else-branch)');
    if (!chromeDeadlines.has(win.handle)) {
        chromeDeadlines.set(win.handle,
            setTimeout(() => stampDefaultChromeIfPaintNeverCame(win.handle), DEFAULT_CHROME_DEADLINE_MS));
    }
}

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
        if (gdi.restoreWindowClientRect(anc.handle, origin.x, origin.y, w, h)) {
            Logger.verbose(LogCategory.USER32,
                `restoreClientRectFromAncestors: hwnd=0x${win.handle.toString(16)} from=0x${anc.handle.toString(16)}`);
            return true;
        }
    }
    Logger.verbose(LogCategory.USER32,
        `restoreClientRectFromAncestors: no backing for hwnd=0x${win.handle.toString(16)}`);
    return false;
}

/**
 * After a window is marked hidden, remove its pixels from the flat overlay.
 *
 * Win32 invalidates the uncovered parent region; on our shared overlay that means
 * putting the ancestor's retained client back (exact), or — when no backing exists
 * yet — invalidating the parent so its next paint owns the hole. Top-level #32770
 * keeps the clear+repair fallback (a dialog has no parent client to restore from).
 *
 * Overlay repair excludes `win`, so this is safe both before a move and after a hide.
 */
export function eraseHiddenWindowPixels(win: WindowInfo): void {
    const bounds = getWindowVisualBounds(win.handle);
    if (restoreClientRectFromAncestors(win)) {
        if (bounds) repairOverlayWindowsOverlappingRect(bounds, win.handle);
        return;
    }

    if ((win.style & WS_CHILD) === 0) {
        eraseDialogOverlay(win.handle);
        return;
    }

    if ((win.style & WS_CHILD) === 0 || win.parent === undefined) return;
    // No retained ancestor owns these pixels. Remove the hidden subtree from the
    // flat overlay now; leaving it in place makes the next transparent sibling
    // inherit stale buttons/text. eraseDialogOverlay repairs all still-visible
    // overlapping windows back-to-front and excludes this now-hidden subtree.
    eraseDialogOverlay(win.handle);
    const parentHwnd = win.parent;
    invalidateWindow(parentHwnd, {
        left: win.x | 0,
        top: win.y | 0,
        right: (win.x + Math.max(1, win.width)) | 0,
        bottom: (win.y + Math.max(1, win.height)) | 0,
    }, true);

    const parent = windows.get(parentHwnd);
    if (!parent || !isEffectivelyVisible(parent)) return;
    if (parent.guestCustomPaint) {
        requestGuestDialogPaint(parentHwnd);
    } else {
        System.getInstance().windowManager.postMessage(parentHwnd, WM_PAINT, 0, 0);
        if (hasSystemControlChildren(parent)) {
            repaintDialogAfterContentChange(parentHwnd);
        }
    }
    if (bounds) repairOverlayWindowsOverlappingRect(bounds, win.handle);
}

/**
 * Drop a control's pixels before its new content is stamped.
 *
 * Only for a control whose parent GUEST-paints its client: there the control is stamped
 * straight onto the flat overlay with no way to restore what was under it, so a changed
 * caption renders on top of the old one and both stay readable.
 */
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

/**
 * A dialog's fill covers its rect UNION its children's (see paintDialogBackground), so it
 * SHRINKS whenever the guest moves template-positioned controls back inside the client —
 * which every launcher does in WM_INITDIALOG, between two of our repaints. On a flat
 * overlay the vacated ring is nobody's pixels afterwards and survives the whole session
 * as a gray halo around the dialog. Clear it before the smaller fill lands; the clear's
 * repair hook redraws whatever else overlapped it, and this window is excluded because
 * it is about to repaint itself.
 */
function dropVacatedOverlayFill(hwnd: number): void {
    const win = windows.get(hwnd);
    if (!win) return;
    const previous = win.lastOverlayFillBounds;
    const next = getWindowVisualBounds(hwnd);
    if (!next) return;
    win.lastOverlayFillBounds = next;
    if (!previous) return;
    const contained = previous.x >= next.x && previous.y >= next.y
        && previous.x + previous.w <= next.x + next.w
        && previous.y + previous.h <= next.y + next.h;
    if (contained) return;
    System.getInstance().gdiContext.clearOverlayRect?.(
        previous.x - 2, previous.y - 2, previous.w + 4, previous.h + 4,
        { excludeRepairHwnd: hwnd },
    );
}

function paintDialogBackground(win: WindowInfo, hdc: number, gdi: GDIContext): void {
    // Fill the dialog's full VISUAL bounds (rect ∪ child rects), not just its own
    // rect: a game can size the dialog window smaller than its template-laid-out
    // children (DLU scale mismatch), and filling only win.width/height would leave
    // the overflowing children sitting on black instead of the gray dialog face.
    const bounds = getWindowVisualBounds(win.handle)
        ?? (() => { const { x, y } = getAbsoluteWindowPosition(win); return { x, y, w: win.width, h: win.height }; })();
    const hBrush = gdi.createSolidBrush(dlgFaceColorRef());
    const prevBrush = gdi.selectObject(hdc, hBrush);
    gdi.fillRect(hdc, bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h);
    gdi.selectObject(hdc, prevBrush);
    gdi.deleteObject(hBrush);
    if (paintTraceEnabled) logChromeStamp(win.handle, `dlgface ${bounds.w}x${bounds.h}`);
}

/** Non-client dialog frame (WM_NCPAINT approximation for #32770). */
function paintDialogNcFrame(win: WindowInfo, hdc: number, gdi: GDIContext): void {
    if (win.nativeClassName !== '#32770') return;
    const WS_BORDER = 0x00800000;
    const WS_CAPTION = 0x00c00000;
    const WS_THICKFRAME = 0x00040000;
    const WS_EX_DLGMODALFRAME = 0x00000001;
    const WS_EX_WINDOWEDGE = 0x00000100;
    const WS_EX_CLIENTEDGE = 0x00000200;
    const edgeExStyle = (win.exStyle ?? 0)
        & (WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE);
    const framedStyle = win.style & (WS_BORDER | WS_CAPTION | WS_THICKFRAME);
    if (!framedStyle && !edgeExStyle) {
        return;
    }
    const bounds = getWindowVisualBounds(win.handle)
        ?? (() => { const { x, y } = getAbsoluteWindowPosition(win); return { x, y, w: win.width, h: win.height }; })();
    const ctx = gdi.getDC(hdc);
    if (!ctx) return;
    const x0 = bounds.x;
    const y0 = bounds.y;
    const x1 = bounds.x + bounds.w;
    const y1 = bounds.y + bounds.h;
    ctx.lineWidth = 1;

    // A plain WS_BORDER is the flat COLOR_WINDOWFRAME border. It must not get
    // the raised highlight used for dialog-modal/window/client edge styles.
    if ((win.style & (WS_CAPTION | WS_THICKFRAME)) === 0 && !edgeExStyle) {
        ctx.strokeStyle = '#000000';
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, bounds.w - 1, bounds.h - 1);
        gdi.setOverlayDirty(true);
        return;
    }

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
        const parent = win.parent !== undefined ? windows.get(win.parent) : undefined;
        const parentStaticType = (parent?.style ?? 0) & 0x001f;
        const hostedByStaticFrame = (win.style & WS_CHILD) !== 0
            && parent?.isSystemControl
            && parent.systemControlClass?.toLowerCase() === 'static'
            && parentStaticType >= 0x0004 && parentStaticType <= 0x0009;
        const guestPaintsClient = !!win.guestCustomPaint || !!hostedByStaticFrame;
        const WS_EX_TRANSPARENT = 0x00000020;
        if (guestPaintsClient) {
            // Restore the guest's retained client before its controls — in BOTH modes.
            // 'full' needs it so a lower owner's freshly-painted menu cannot leak through
            // transparent parts of an owned popup. 'controls' needs it because stamping a
            // control over whatever is already on the flat overlay cannot restore the
            // background UNDER it: changed text lands on the old string (glyphs stack and
            // read as bold) and a moved trackbar thumb leaves its predecessor behind. The
            // retained client IS that background, exactly, and restoring is a no-op when
            // no backing exists yet.
            //
            // 'controls' restores ONLY under the controls it is about to stamp. The
            // retained client holds the guest's WM_PAINT output and nothing else, so a
            // whole-client restore also deletes the pixels only the guest can produce —
            // its owner-draw buttons' WM_DRAWITEM tiles — and this path has no way to ask
            // for them back (Win32 repaints the invalidated CONTROL, never its parent's
            // client). That is the launcher whose art survives and whose labels vanish.
            const origin = getAbsoluteWindowPosition(win);
            if (mode === 'full') {
                if (paintTraceEnabled) logOverlayMutation('restoreClient', win.handle, 'whole-client');
                gdi.restoreWindowClientRect?.(
                    win.handle, origin.x, origin.y,
                    Math.max(1, win.width), Math.max(1, win.height),
                );
            } else {
                restoreClientUnderStampedControls(win, gdi);
            }
        } else if (mode === 'full' && !((win.exStyle ?? 0) & WS_EX_TRANSPARENT)) {
            paintDialogBackground(win, hdc, gdi);
            paintDialogNcFrame(win, hdc, gdi);
        }
        // OS-owned child controls (statics, edits, non-owner-draw buttons) always paint,
        // exactly like Windows' own control window-procs. Owner-draw buttons early-out
        // inside paintChildControls — the guest paints those via the WM_DRAWITEM chain.
        paintChildControls(win.handle, hdc, gdi);
    }

    if (clip && ctx) ctx.restore();

    for (const childHwnd of getChildrenInPaintOrder(win.handle)) {
        paintWindowSubtreeToOverlay(childHwnd, hdc, visited, mode);
    }

}

export function paintDialogToOverlay(dialogHwnd: number, mode: 'full' | 'controls' = 'full'): void {
    const system = System.getInstance();
    const gdi = system.gdiContext;
    if (paintTraceEnabled) logOverlayMutation('paintDialogToOverlay', dialogHwnd, mode);
    if (mode === 'full') dropVacatedOverlayFill(dialogHwnd);
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
        // Exposure is independent of activation. Native USER invalidates an uncovered
        // window and its normal message pump later delivers WM_PAINT even while another
        // top-level window is active. Using activation as a paint gate left an owned
        // launcher page with only its stale retained background after its child closed.
        requestGuestDialogPaint(dialogHwnd);
        return;
    }
    if (firstPaintCyclePending(win)) {
        requestDefaultDialogPaint(win);
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
        // 'controls' stamps each control over the flat overlay; the background UNDER one
        // comes from the guest's retained client, which paintWindowSubtreeToOverlay now
        // restores first (see there). Without a retained backing it degrades to the old
        // stamp-over-stale behaviour rather than clearing — only the guest may redraw its
        // own client, so inventing a fill there would erase its art.
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
    // 'full' here is the same default chrome DefDlgProc draws; the WM_PAINT queued below
    // is what asks for it. Stamping it first only makes it visible until the guest answers.
    if (mode === 'controls' || !win || !firstPaintCyclePending(win)) {
        paintDialogToOverlay(dialogHwnd, mode);
    } else {
        requestDefaultDialogPaint(win);
    }

    // Creation-time fallback painting is not the final Win32 paint. WM_INITDIALOG
    // commonly installs bitmaps, subclasses owner-draw controls, and changes text;
    // USER subsequently validates those results through WM_PAINT/WM_DRAWITEM.
    // Queue that real paint after init instead of freezing the pre-init fallback.
    if (win && isEffectivelyVisible(win) && !win.pendingDestroy) {
        const queueGuestPaint = (): void => {
            const live = windows.get(dialogHwnd);
            if (!live || !isEffectivelyVisible(live) || live.pendingDestroy) return;
            invalidateWindow(dialogHwnd, null, true);
            System.getInstance().windowManager.postMessage(dialogHwnd, WM_PAINT, 0, 0);
            System.getInstance().scheduler.wakeMessageWaiters();
        };
        // WS_EX_TRANSPARENT is painted after siblings beneath it. Deferring one host
        // turn preserves that ordering when parent and child finish initialization in
        // the same callback chain.
        if ((win.exStyle ?? 0) & 0x00000020) {
            if (win.parent) requestGuestDialogPaint(win.parent);
            setTimeout(queueGuestPaint, 0);
        } else queueGuestPaint();
    }
}
