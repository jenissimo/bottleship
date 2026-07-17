/**
 * Native Win32 dialogs over an exclusive-fullscreen DirectDraw flip chain.
 *
 * Real Windows composites visible GDI windows OVER the DirectDraw primary even
 * in DDSCL_EXCLUSIVE|FULLSCREEN. Our presenter cannot composite the whole GDI
 * overlay there (gdiSurfaceVisible=false hides it) because windows left visible
 * from BEFORE the flip chain took the screen would bleed over the game (the
 * exclusive-fullscreen screen-ownership model; see gdi-visibility.ts).
 *
 * Generic discriminator between those two cases: WHEN the dialog became visible.
 * A dialog shown WHILE the flip chain owns the screen is live UI the game is
 * waiting on; one visible since before is leftover desktop state the flip chain
 * replaced. Live dialogs are flagged (WindowInfo.overlayOnFlipScreen) and the
 * presenter composites only their rects from the GDI overlay on top of every
 * flip; mouse routing prefers them (WindowManager mouse-target resolver).
 *
 * Examples: live — Tiberian Sun "Select Campaign" (shown over the menu's flip
 * chain); leftover — HL Day One's MFC launcher menu after the engine starts.
 */

import { System } from '../../core/system';
import type { RenderActive } from '../../runtime/runtime-services';
import { isGdiSurfaceHidden, isDDrawExclusiveFullscreen, shouldSuppress3DGdiOverlay } from '../ddraw/gdi-visibility';
import {
    windows,
    WindowInfo,
    getAbsoluteWindowPosition,
    listControlStates,
    isWindowUpdateLocked,
    hasSystemControlChildren,
} from './shared-state';
import { getComboDropdownRect } from './controls';
import { invokeOverlayRepairRepaint } from './control-interaction';

const WS_CHILD = 0x40000000;

function getDDrawContext(): any {
    return (System.getInstance().process?.getModule('ddraw') as any)?.context;
}

/** True while the DDraw flip chain owns the screen (GDI desktop hidden). */
export function isFlipScreenOwned(): boolean {
    return isGdiSurfaceHidden(getDDrawContext());
}

/**
 * True while the GAME (not the GDI desktop) owns the screen: DirectDraw exclusive
 * fullscreen OR a hardware-3D renderer (D3D8/D3D9/Glide/OpenGL) presenting to the
 * canvas. This is the "when did the dialog become visible" discriminator, generalized
 * beyond DDraw: a dialog shown WHILE the game owns the screen is live UI composited
 * over the frame; one visible from BEFORE (a UE2 loading splash) is occluded by the
 * opaque fullscreen game window on real Windows, so it must not cover our frame.
 */
export function isGameScreenOwned(renderActive?: RenderActive | null): boolean {
    const ddrawCtx = getDDrawContext();
    if (isDDrawExclusiveFullscreen(ddrawCtx)) return true;
    const active = renderActive ?? System.getInstance().services.render.getActive();
    return shouldSuppress3DGdiOverlay(active, ddrawCtx);
}

/**
 * Flag a dialog as a live game-screen overlay if it just became visible while the
 * game owns the screen (DDraw exclusive fullscreen OR a hardware-3D renderer is
 * presenting). Call on dialog creation and on ShowWindow.
 *
 * Gate is isGameScreenOwned (DDraw exclusive OR 3D-owned), NOT isFlipScreenOwned:
 * a single-buffered primary game (TS) calls FlipToGDISurface right before creating
 * its modal, which sets gdiSurfaceVisible=true → isFlipScreenOwned()=false → the live
 * dialog would never get flagged and would rely on the whole-overlay composite path
 * (which then leaves a ghost once the dialog closes). "Game owns the screen" is the
 * stable signal for "this dialog is composited over the game". Leftover pre-fullscreen
 * windows (HL Day One's MFC menu) and pre-device loading splashes (XIII's UE2 #32770
 * splash, shown while the presenter is still GDI) are created/shown BEFORE the game
 * takes the screen, so this call never flags them → they stay occluded by the game.
 *
 * No WS_CHILD filter: templates routinely declare in-game dialogs as WS_CHILD
 * of the fullscreen window (style 0x40000040 = WS_CHILD | DS_SETFONT); a child
 * dialog over the flip chain is exactly the case this mechanism exists for.
 */
export function noteDialogOverlayCandidate(win: WindowInfo | undefined): void {
    if (!win || !win.visible || win.pendingDestroy) return;
    // #32770 dialogs, plus plain windows hosting JS system controls (a launcher /
    // options window built via CreateWindowEx("BUTTON"...) is real UI, not a stray
    // helper window) — both must composite over a game-owned screen.
    if (win.nativeClassName !== '#32770' && !hasSystemControlChildren(win)) return;
    if (!isGameScreenOwned()) return;
    if (!win.overlayOnFlipScreen) {
        win.overlayOnFlipScreen = true;
    }
}

export interface DialogOverlayRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Screen-space visual bounds of a window: the union of its own rect and ALL its
 * descendant control rects (plus any open combobox dropdowns). Dialog children are
 * laid out from the template and can extend past the dialog's own (game-resized)
 * rect; the union is the region the dialog actually occupies on screen. Used for the
 * background fill, overlay erase, compositing, and hit-test routing so all four agree
 * on one set of bounds — otherwise children overflow the frame, clicks outside the
 * frame miss, and erase leaves the overflow as a ghost.
 */
export function getWindowVisualBounds(hwnd: number): DialogOverlayRect | null {
    const root = windows.get(hwnd);
    if (!root) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visited = new Set<number>();
    const visit = (h: number): void => {
        if (visited.has(h)) return;
        visited.add(h);
        const w = windows.get(h);
        if (!w) return;
        // Skip invisible/being-destroyed descendants (but always include the root
        // itself). Our owned-popup dialogs (e.g. an "Advanced" sub-dialog) are linked
        // via the same parent/children[] fields as real template child controls, so an
        // owner's bounds would otherwise transiently swell to include a just-hidden or
        // mid-destroy child dialog — DestroyWindow erases+repaints the owner BEFORE
        // finalizeDestroy unlinks the child (see window.ts), so at that moment the
        // child is still structurally listed but already invisible. Nothing is drawn
        // there, so it must not stretch the background fill / erase rect either,
        // or a plain empty rect is left oversized until the next unrelated full repaint.
        if (h !== hwnd && (!w.visible || w.pendingDestroy)) return;
        const { x, y } = getAbsoluteWindowPosition(w);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w.width);
        maxY = Math.max(maxY, y + w.height);
        if (w.isSystemControl
            && (w.systemControlClass ?? '').toLowerCase() === 'combobox'
            && listControlStates.get(w.handle)?.dropdownOpen) {
            const r = getComboDropdownRect(w);
            maxX = Math.max(maxX, r.x + r.w);
            maxY = Math.max(maxY, r.y + r.h);
        }
        for (const c of w.children) visit(c);
    };
    visit(hwnd);
    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function overlayRectsOverlap(a: DialogOverlayRect, b: DialogOverlayRect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Z-rank for compositing / hit-test (higher = more front). */
function getOverlayWindowZRank(hwnd: number): number {
    const wm = System.getInstance().windowManager;
    let rank = 0;
    let depth = 0;
    let cur = hwnd;
    while (cur) {
        const win = windows.get(cur);
        if (!win) break;
        if (!win.parent) {
            const zIdx = wm.getZOrder().indexOf(cur);
            rank += (zIdx >= 0 ? zIdx : 0) * 1_000_000;
        } else {
            const parent = windows.get(win.parent);
            const childIdx = parent?.children.indexOf(cur) ?? 0;
            rank += childIdx * (10_000 ** depth);
        }
        depth++;
        cur = win.parent ?? 0;
    }
    return rank;
}

function needsOverlayRepaint(win: WindowInfo): boolean {
    if (!win.visible || win.pendingDestroy) return false;
    if (isWindowUpdateLocked(win.handle)) return false;
    if (win.nativeClassName === '#32770') return true;
    if (win.guestCustomPaint && !win.isSystemControl) return true;
    if (hasSystemControlChildren(win)) return true;
    return false;
}

/**
 * Repaint overlay-painted windows intersecting a cleared region (shared canvas).
 */
function repaintOverlayWindowsOverlappingRect(rect: DialogOverlayRect, excludeHwnd: number): void {
    const candidates: Array<{ hwnd: number; rank: number }> = [];
    for (const win of windows.values()) {
        if (win.handle === excludeHwnd) continue;
        if (!needsOverlayRepaint(win)) continue;
        const b = getWindowVisualBounds(win.handle);
        if (!b || !overlayRectsOverlap(rect, b)) continue;
        candidates.push({ hwnd: win.handle, rank: getOverlayWindowZRank(win.handle) });
    }
    candidates.sort((a, b) => a.rank - b.rank);
    for (const c of candidates) {
        invokeOverlayRepairRepaint(c.hwnd);
    }
}

/**
 * Wire GDI overlay clear → automatic repaint of stacked windows (general policy).
 */
export function registerOverlayPaintRepair(): void {
    const gdi = System.getInstance().gdiContext;
    if (!gdi?.registerOverlayClearRepair) return;
    gdi.registerOverlayClearRepair((x, y, w, h, excludeHwnd) => {
        repaintOverlayWindowsOverlappingRect({ x, y, w, h }, excludeHwnd);
    });
}

/**
 * Erase a dialog's pixels from the GDI overlay (transparent), covering the window
 * rect plus any open combobox dropdowns in its subtree. The overlay is a persistent
 * screen-space canvas, so this is required when a dialog closes (else it lingers as a
 * ghost over the game) or moves (else it smears its old position). Call BEFORE the
 * window is destroyed / repositioned, while its current rect is still known.
 */
export function eraseDialogOverlay(hwnd: number): void {
    const gdi = System.getInstance().gdiContext;
    if (!gdi?.clearOverlayRect) return;
    const win = windows.get(hwnd);
    const bounds = getWindowVisualBounds(hwnd);
    if (!bounds) return;

    // Stop compositing this dialog before erase (DestroyWindow path: still visible).
    if (win) {
        win.overlayOnFlipScreen = false;
    }

    // +2px margin to cover anti-aliased edges / the default 1px dialog border.
    const eraseRect: DialogOverlayRect = {
        x: bounds.x - 2,
        y: bounds.y - 2,
        w: bounds.w + 4,
        h: bounds.h + 4,
    };
    // excludeRepairHwnd: erase runs while the window is still visible — repair must
    // not repaint it (that was the "clearing doesn't happen" regression).
    gdi.clearOverlayRect(eraseRect.x, eraseRect.y, eraseRect.w, eraseRect.h, {
        excludeRepairHwnd: hwnd,
    });

    // Explicit parent repaint: launcher menu behind a modal child (e.g. BOD Setup).
    const parentHwnd = win?.parent;
    if (parentHwnd) {
        invokeOverlayRepairRepaint(parentHwnd);
    }
}

export type OverlayCompositePlan =
    | { mode: 'none' }
    | { mode: 'full' }
    | { mode: 'rects'; rects: DialogOverlayRect[] };

/**
 * Decide how the GDI overlay composites over the game frame. THE single source of
 * truth for EVERY GDI-over-frame compositor: the DDraw presenter (drawFrame, 2D
 * fallback, phase-blend), the standalone rAF gdiPresentLoop, and the D3D8/D3D9/Glide
 * present paths. They differ only in the low-level draw primitive (own-encoder blit
 * vs. blitRects into a shared encoder); the DECISION lives here, once.
 *
 *  - Game owns the screen (DDraw exclusive fullscreen OR a hardware-3D renderer
 *    presenting to the canvas — isGameScreenOwned): the fullscreen presentation owns
 *    the display and GDI window output is NOT visible on real Windows. Composite ONLY
 *    the rects of live modal dialogs flagged overlayOnFlipScreen (TS "Select Campaign",
 *    BOD Setup), never the whole overlay; with no live dialog, `none` and the game
 *    frame shows through. Deliberately INDEPENDENT of gdiSurfaceVisible: a single-
 *    buffered primary presents via Blt (not Flip), so gdiSurfaceVisible never clears
 *    and sticks `true` after FlipToGDISurface — gating on it left the menu background
 *    composited opaquely over the game.
 *  - Windowed / GDI desktop owns the screen: composite the whole overlay as usual.
 *
 * Pass the presenting renderActive (the device calling present) so the 3D-owned check
 * keys off the right presenter; omit it to fall back to the globally-active presenter
 * (correct for the DDraw presenter, whose case is caught by isDDrawExclusiveFullscreen
 * regardless).
 */
export function getOverlayCompositePlan(renderActive?: RenderActive | null): OverlayCompositePlan {
    if (isGameScreenOwned(renderActive)) {
        const rects = getLiveDialogOverlayRects();
        return rects.length ? { mode: 'rects', rects } : { mode: 'none' };
    }
    return { mode: 'full' };
}

/**
 * A flagged dialog that FILLS the entire exclusive display is the game's own
 * fullscreen frontend host (it hosts the flip chain), NOT a modal shown over the
 * game — its GDI paints (the plain WM_ERASEBKGND background) sit UNDER the flip
 * content on real Windows, never over it. Compositing its full-screen background
 * would blit an opaque rectangle over the whole DDraw frame (WA's frontend is a
 * 640x480 #32770 whose menu is drawn via DDraw sprites, with only a gray dialog
 * background in GDI). A genuine modal (TS "Select Campaign", BOD Setup) is a
 * sub-region of the screen, so it is NOT excluded. Bounds come from getWindowVisualBounds
 * (union of the dialog + all its child controls). This does NOT clear overlayOnFlipScreen
 * (mouse routing to the frontend dialog stays intact) — it only skips compositing.
 */
function dialogIsFullscreenFlipHost(hwnd: number, bounds: DialogOverlayRect): boolean {
    const ddrawCtx = getDDrawContext();
    const dw = ddrawCtx?.display?.width ?? 0;
    const dh = ddrawCtx?.display?.height ?? 0;
    if (dw <= 0 || dh <= 0) return false;
    return bounds.x <= 0 && bounds.y <= 0 && bounds.x + bounds.w >= dw && bounds.y + bounds.h >= dh;
}

/** True if any live dialog must be composited over the flip-chain frame. */
export function hasLiveDialogOverlay(): boolean {
    return getLiveDialogOverlayRects().length > 0;
}

/**
 * Visual-bounds rects of live overlay dialogs (composited from the GDI overlay
 * canvas onto a DDraw flip frame). Sorted back→front for correct stacking.
 */
export function getLiveDialogOverlayRects(): DialogOverlayRect[] {
    const entries: Array<{ rect: DialogOverlayRect; rank: number }> = [];
    for (const win of windows.values()) {
        if (!win.overlayOnFlipScreen || !win.visible || win.pendingDestroy) continue;
        const b = getWindowVisualBounds(win.handle);
        if (!b) continue;
        if (dialogIsFullscreenFlipHost(win.handle, b)) continue;
        entries.push({ rect: b, rank: getOverlayWindowZRank(win.handle) });
    }
    entries.sort((a, b) => a.rank - b.rank);
    return entries.map(e => e.rect);
}

/**
 * True when this dialog needs point-based mouse routing (InputManager asks the
 * resolver instead of always posting to the active window).
 *
 * NOT every visible #32770 qualifies: a launcher menu left visible=true after
 * exclusive fullscreen (HP/UE1) is stale desktop state — routing clicks to it
 * breaks in-game mouse while the flip chain owns the screen. Only live UI the
 * player is interacting with should participate.
 */
export function dialogNeedsPointMouseRouting(win: WindowInfo): boolean {
    if (!win.visible || win.pendingDestroy) return false;
    if (win.nativeClassName !== '#32770') {
        // Plain window hosting system controls: point-route only while it's the
        // live overlay over a game-owned screen (windowed mode routes normally).
        return !!win.overlayOnFlipScreen && hasSystemControlChildren(win);
    }

    if (win.overlayOnFlipScreen) return true;
    if (win.dialogInitInProgress) return true;

    const gdiHidden = isGdiSurfaceHidden(getDDrawContext());

    // Non-launcher modals (TS "Select Campaign"): windowed GDI or live flip overlay.
    if (!gdiHidden) return true;
    if (isFlipScreenOwned()) return true;

    return false;
}

function hasPointRoutedDialog(): boolean {
    for (const win of windows.values()) {
        if (dialogNeedsPointMouseRouting(win)) return true;
    }
    return false;
}

/**
 * Mouse-target resolver: frontmost visible dialog whose VISUAL BOUNDS contain the
 * cursor (Z-order aware). Falls back to top-level window under cursor.
 */
export function resolveMouseTargetHwnd(screenX: number, screenY: number): number {
    if (!hasPointRoutedDialog()) return 0;

    const candidates: Array<{ hwnd: number; rank: number }> = [];
    for (const win of windows.values()) {
        if (!dialogNeedsPointMouseRouting(win)) continue;
        const b = getWindowVisualBounds(win.handle);
        if (!b) continue;
        if (screenX >= b.x && screenY >= b.y && screenX < b.x + b.w && screenY < b.y + b.h) {
            candidates.push({ hwnd: win.handle, rank: getOverlayWindowZRank(win.handle) });
        }
    }
    if (candidates.length > 0) {
        candidates.sort((a, b) => b.rank - a.rank);
        return candidates[0]!.hwnd;
    }

    const wm = System.getInstance().windowManager;
    for (const hwnd of wm.getZOrder()) {
        const win = wm.getWindow(hwnd);
        if (!win?.visible || (win.style & WS_CHILD) !== 0) continue;
        const r = win.rect;
        if (screenX < r.x || screenY < r.y || screenX >= r.x + r.w || screenY >= r.y + r.h) continue;
        return hwnd;
    }
    return 0;
}
