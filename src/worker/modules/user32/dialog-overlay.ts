/**
 * Native Win32 dialogs over an exclusive-fullscreen DirectDraw flip chain.
 *
 * In DDSCL_EXCLUSIVE|FULLSCREEN a GDI window shows over the DirectDraw primary only
 * while the GDI surface is the buffer on screen: true for a single-buffered primary
 * (GDI paints straight into the displayed memory), false once the app Flips its
 * primary chain (see gdi-visibility.ts and dialogOverlayComposites). Even then our
 * presenter cannot composite the WHOLE GDI overlay, because windows left visible from
 * BEFORE the game took the screen would bleed over it.
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
import { isGdiSurfaceHidden, ddrawOwnsScreen, ddrawShowsContent, shouldSuppress3DGdiOverlay } from '../ddraw/gdi-visibility';
import {
    windows,
    WindowInfo,
    getAbsoluteWindowPosition,
    listControlStates,
    isWindowUpdateLocked,
    hasSystemControlChildren,
    isEffectivelyVisible,
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
 *
 * The DDraw arm is ddrawOwnsScreen, not the cooperative level alone: exclusive-fullscreen
 * rights with no primary surface leave the desktop on screen (see gdi-visibility.ts).
 */
export function isGameScreenOwned(renderActive?: RenderActive | null): boolean {
    const ddrawCtx = getDDrawContext();
    if (ddrawOwnsScreen(ddrawCtx)) return true;
    const active = renderActive ?? System.getInstance().services.render.getActive();
    return shouldSuppress3DGdiOverlay(active, ddrawCtx);
}

/**
 * True while what the game RENDERED is actually on the display — isGameScreenOwned plus,
 * for the DirectDraw arm, the requirement that a frame was presented. Suppressing the GDI
 * overlay is only correct when there is a rendered frame underneath it to reveal; an app
 * that takes exclusive fullscreen and creates a primary but paints its UI with GDI (a
 * launcher that switches the desktop to its game resolution and hands the primary to the
 * engine later) has an EMPTY primary, so suppressing the overlay shows a blank screen
 * instead of its entire UI. A 3D presenter is only "active" once it renders, so its arm
 * needs no extra test.
 */
function isGameContentOnScreen(renderActive?: RenderActive | null): boolean {
    const ddrawCtx = getDDrawContext();
    const active = renderActive ?? System.getInstance().services.render.getActive();
    if (shouldSuppress3DGdiOverlay(active, ddrawCtx)) return true;
    return ddrawShowsContent(ddrawCtx);
}

/**
 * True for the window that OWNS the screen — the one passed to
 * SetCooperativeLevel(DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN). In exclusive fullscreen its
 * client area IS the primary surface: GDI painting of that window lands in the primary
 * the game renders into, it is not a plane layered over the frame. So it can never be
 * an overlay composited on top of the game — it is the game. Games whose fullscreen
 * window happens to host a system-control child (a Static/Button the engine parents to
 * the main window) would otherwise be mistaken for live UI, and their WM_ERASEBKGND
 * background fill would cover every frame.
 */
export function isScreenOwnerWindow(hwnd: number): boolean {
    const ddrawCtx = getDDrawContext();
    // No primary surface ⇒ nothing of DirectDraw is on screen, so this window's client
    // area is not "the primary" and its GDI paints are ordinary window output.
    if (!hwnd || !ddrawOwnsScreen(ddrawCtx)) return false;
    return (ddrawCtx?.cooperative?.hwnd ?? 0) === hwnd;
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
    if (isScreenOwnerWindow(win.handle)) return;
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
    /**
     * `clip` is the intersection of the client rects of the ancestors BELOW the root —
     * the Win32 clip a descendant is already painted with (see getAncestorClipRect).
     * A nested child dialog therefore cannot stretch these bounds past the root, while
     * the root's OWN controls stay unclipped (clip=null at the first level): those are
     * the ones our approximate DLU→px can push a few pixels past the root's rect, and
     * they are genuinely drawn there, so the fill/erase must still cover them.
     */
    const visit = (h: number, clip: DialogOverlayRect | null): void => {
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
        const own: DialogOverlayRect = { x, y, w: w.width, h: w.height };
        const drawn = clip ? intersectOverlayRects(own, clip) : own;
        if (drawn.w > 0 && drawn.h > 0) {
            minX = Math.min(minX, drawn.x);
            minY = Math.min(minY, drawn.y);
            maxX = Math.max(maxX, drawn.x + drawn.w);
            maxY = Math.max(maxY, drawn.y + drawn.h);
        }
        // An open drop-down is its own ComboLBox popup — never clipped by the parent.
        if (w.isSystemControl
            && (w.systemControlClass ?? '').toLowerCase() === 'combobox'
            && listControlStates.get(w.handle)?.dropdownOpen) {
            const r = getComboDropdownRect(w);
            maxX = Math.max(maxX, r.x + r.w);
            maxY = Math.max(maxY, r.y + r.h);
        }
        const childClip = h === hwnd ? null : (clip ? intersectOverlayRects(own, clip) : own);
        for (const c of w.children) visit(c, childClip);
    };
    visit(hwnd, null);
    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Rect intersection; a non-positive w/h means "empty". */
function intersectOverlayRects(a: DialogOverlayRect, b: DialogOverlayRect): DialogOverlayRect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return {
        x, y,
        w: Math.min(a.x + a.w, b.x + b.w) - x,
        h: Math.min(a.y + a.h, b.y + b.h) - y,
    };
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
    // Ancestor-aware: a child of a hidden page keeps WS_VISIBLE, and repainting it here
    // would redraw a page that was switched away (see isEffectivelyVisible).
    if (!isEffectivelyVisible(win) || win.pendingDestroy) return false;
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
 *  - Game content is on the screen (a presented DDraw exclusive-fullscreen frame OR a
 *    hardware-3D renderer presenting to the canvas — isGameContentOnScreen): the
 *    fullscreen presentation owns
 *    the display, so the whole overlay is never composited — stale pre-fullscreen GDI
 *    would cover the game. Only the rects of live dialogs survive, and only those the
 *    DirectDraw ownership model says are actually on screen (dialogOverlayComposites);
 *    with none, `none` and the game frame shows through. WHICH dialogs is decided
 *    there; whether to consider any at all is decided here.
 *  - Windowed / GDI desktop owns the screen: composite the whole overlay as usual.
 *
 * Pass the presenting renderActive (the device calling present) so the 3D-owned check
 * keys off the right presenter; omit it to fall back to the globally-active presenter
 * (correct for the DDraw presenter, whose case is caught by isDDrawExclusiveFullscreen
 * regardless).
 */
export function getOverlayCompositePlan(renderActive?: RenderActive | null): OverlayCompositePlan {
    if (isGameContentOnScreen(renderActive)) {
        const rects = getLiveDialogOverlayRects();
        return rects.length ? { mode: 'rects', rects } : { mode: 'none' };
    }
    return { mode: 'full' };
}

/** True if any live dialog must be composited over the flip-chain frame. */
export function hasLiveDialogOverlay(): boolean {
    return getLiveDialogOverlayRects().length > 0;
}

/**
 * The dialog root a control belongs to: climb while the parent is itself part of
 * the dialog (another overlay window or a #32770). Stops at the game's own
 * top-level window (e.g. the DDraw Afx main window), which is the parent of the
 * dialog but not part of it.
 */
function getDialogRoot(hwnd: number): number {
    let cur = hwnd;
    const seen = new Set<number>();
    while (!seen.has(cur)) {
        seen.add(cur);
        const p = windows.get(cur)?.parent ?? 0;
        const pw = p ? windows.get(p) : undefined;
        if (!pw || (pw.nativeClassName !== '#32770' && !pw.overlayOnFlipScreen)) return cur;
        cur = p;
    }
    return cur;
}

const WS_CAPTION = 0x00c00000;

/**
 * True if the overlay actually holds pixels for this dialog group: an OS-drawn
 * control, guest GDI output flushed into the overlay, or a caption bar we draw.
 *
 * A #32770 with none of those is a message-routing shell — a window the game
 * creates for focus/modality while painting the visuals itself into the game's
 * own surface (TLJ's "#dialog"). All our overlay render can contribute there is
 * the invented dialog face, so compositing it over a game-owned screen is pure
 * occlusion: it hides the frame and shows an empty gray box.
 */
function dialogGroupHasOverlayContent(root: number): boolean {
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length) {
        const h = stack.pop()!;
        if (seen.has(h)) continue;
        seen.add(h);
        const w = windows.get(h);
        if (!w) continue;
        if (w.isSystemControl || w.guestCustomPaint) return true;
        if ((w.style & WS_CAPTION) === WS_CAPTION) return true;
        for (const c of w.children) stack.push(c);
    }
    return false;
}

/** What the composite decision needs to know about one live dialog group. */
export interface DialogOverlayFacts {
    /**
     * GDI window output reaches the display. False while a DirectDraw flip chain
     * owns the screen — see isGdiOutputOnScreen.
     */
    gdiOutputOnScreen: boolean;
    /** This window is the DDSCL_EXCLUSIVE|FULLSCREEN cooperative-level window. */
    isScreenOwnerWindow: boolean;
    /** This window is the root of its dialog group (not a descendant control). */
    isDialogRoot: boolean;
    /** The overlay plane holds real pixels for this group (control / guest paint / caption). */
    hasOverlayContent: boolean;
}

/**
 * Whether a live dialog group's GDI pixels are composited over the game frame.
 * The whole rule in one place, in terms of the Win32/DirectDraw contract:
 *
 *  1. GDI output must reach the display at all. In DDSCL_EXCLUSIVE|FULLSCREEN a
 *     Flip of the primary chain puts the flip chain on screen and GDI keeps
 *     painting into the GDI surface, which is now an OFF-SCREEN buffer — no
 *     window, dialog included, is visible until FlipToGDISurface / RestoreDisplayMode
 *     / DDSCL_NORMAL. A single-buffered primary never Flips: there is no separate
 *     GDI surface, GDI paints land in the memory being displayed, so its output
 *     is on screen (TS shows its "Select Campaign" modal exactly this way).
 *  2. The screen-owner window is never an overlay — in exclusive fullscreen its
 *     client area IS the primary, so it is the game, not a plane above it.
 *  3. Only the group ROOT contributes a rect; its visual bounds already cover
 *     every descendant, and compositing a child separately would blit our render
 *     of a control over the game's own render of it.
 *  4. The overlay must actually hold pixels for the group — a control-less,
 *     caption-less #32770 with no guest GDI paint is a focus/modality shell whose
 *     visuals the game draws itself, so our render is pure occlusion.
 */
export function dialogOverlayComposites(f: DialogOverlayFacts): boolean {
    return f.gdiOutputOnScreen && !f.isScreenOwnerWindow && f.isDialogRoot && f.hasOverlayContent;
}

/**
 * True while GDI window output reaches the display (rule 1 above). Reads the
 * DirectDraw cooperative level + `gdiSurfaceVisible`, which is cleared ONLY by a
 * primary-chain Flip and restored by FlipToGDISurface — so it doubles as the
 * "does this app have a flip chain on screen" test.
 */
export function isGdiOutputOnScreen(): boolean {
    return !isFlipScreenOwned();
}

/**
 * Visual-bounds rects of live overlay dialogs (composited from the GDI overlay
 * canvas onto a DDraw flip frame). Sorted back→front for correct stacking.
 */
export function getLiveDialogOverlayRects(): DialogOverlayRect[] {
    return getLiveDialogOverlays().map(e => e.rect);
}

/** getLiveDialogOverlayRects with the owning window — the diagnostic form (harness `overlay`). */
export function getLiveDialogOverlays(): Array<{ hwnd: number; title: string; cls: string; rect: DialogOverlayRect }> {
    const gdiOutputOnScreen = isGdiOutputOnScreen();
    const entries: Array<{ hwnd: number; title: string; cls: string; rect: DialogOverlayRect; rank: number }> = [];
    for (const win of windows.values()) {
        if (!win.overlayOnFlipScreen || !win.visible || win.pendingDestroy) continue;
        // A window flagged before the app took exclusive fullscreen can become the
        // screen owner afterwards; re-check here, the one place the rects are consumed.
        if (!dialogOverlayComposites({
            gdiOutputOnScreen,
            isScreenOwnerWindow: isScreenOwnerWindow(win.handle),
            isDialogRoot: getDialogRoot(win.handle) === win.handle,
            hasOverlayContent: dialogGroupHasOverlayContent(win.handle),
        })) continue;
        const b = getWindowVisualBounds(win.handle);
        if (!b) continue;
        entries.push({
            hwnd: win.handle,
            title: win.title ?? '',
            cls: win.nativeClassName ?? '',
            rect: b,
            rank: getOverlayWindowZRank(win.handle),
        });
    }
    entries.sort((a, b) => a.rank - b.rank);
    return entries.map(({ hwnd, title, cls, rect }) => ({ hwnd, title, cls, rect }));
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
