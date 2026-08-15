/**
 * DirectDraw cooperative-level GDI visibility (exclusive fullscreen semantics).
 */

import type { DDrawContext } from './context';
import type { RenderActive } from '../../runtime/runtime-services';
import { surfaceAt } from './helpers';
import { DirectDrawClipperObject } from './com-objects';
import { windows as sharedWindows } from '../user32/shared-state';

import { DDSCL_FULLSCREEN, DDSCL_EXCLUSIVE } from './constants';

const DDSCL_EXCLUSIVE_FULLSCREEN = DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE;

export function isDDrawExclusiveFullscreen(ddrawCtx: DDrawContext | null | undefined): boolean {
    if (!ddrawCtx) return false;
    return ((ddrawCtx.cooperative?.flags ?? 0) & DDSCL_EXCLUSIVE_FULLSCREEN) === DDSCL_EXCLUSIVE_FULLSCREEN;
}

/**
 * A DirectDraw primary surface exists — DirectDraw has something to put on the display.
 *
 * `surfaces.primary` is a CACHED ADDRESS, and COM object addresses are recycled: an app that
 * releases its primary and creates another DirectDraw object gets that same block back for a
 * DirectDrawObject while the cache still points at it. Resolving through surfaceAt makes the
 * predicate answer from an object it can confirm is a surface, so the whole GDI-overlay
 * ownership rule below can never be decided by a dangling pointer.
 */
export function ddrawHasPrimary(ddrawCtx: DDrawContext | null | undefined): boolean {
    const addr = ddrawCtx?.surfaces?.primary ?? 0;
    if (!addr || !ddrawCtx?.resourceProvider) return false;
    return !!surfaceAt(ddrawCtx.resourceProvider, addr);
}

/**
 * DirectDraw owns the display: exclusive-fullscreen mode AND a primary surface.
 *
 * SetCooperativeLevel(DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN) grants exclusive *rights* (mode
 * changes, sole access to the primary) — it does not put DirectDraw on screen. Until a
 * primary surface exists the desktop is still what the display shows and GDI window
 * output is visible as usual. Apps that take exclusive mode only to force a display mode
 * and then draw with GDI (a Win32 launcher that switches the desktop to 640x480 and paints
 * its menu into its own window) never create a primary, so treating the cooperative level
 * alone as ownership blanks their entire UI.
 */
export function ddrawOwnsScreen(ddrawCtx: DDrawContext | null | undefined): boolean {
    return isDDrawExclusiveFullscreen(ddrawCtx) && ddrawHasPrimary(ddrawCtx);
}

/**
 * DirectDraw has actually put a frame on the display (not merely owns the right to).
 * A primary surface that was never presented holds nothing, so the GDI surface is still
 * what the display shows — the single-buffered-primary case of the exclusive-fullscreen
 * contract, where GDI and DirectDraw write the same memory and the last writer wins.
 */
export function ddrawShowsContent(ddrawCtx: DDrawContext | null | undefined): boolean {
    if (!ddrawHasPrimary(ddrawCtx) || !ddrawCtx?.presenter?.hasPresentedFrame?.()) return false;
    return isDDrawExclusiveFullscreen(ddrawCtx) || ddrawWindowCoversDisplay(ddrawCtx);
}

/**
 * The cooperative-level window covers the whole display mode — a borderless-fullscreen app
 * that took DDSCL_NORMAL.
 *
 * Windowed DirectDraw has no layering: the Blt lands in the same primary pixels the window's
 * WM_ERASEBKGND fill lands in and the last writer wins, so a game repainting a display's
 * worth of frame every frame is always the last writer, and compositing the GDI overlay over
 * it shows a one-time black background instead of the frame.
 *
 * The test is the WINDOW, not the primary: in DirectDraw the primary surface IS the display
 * (CreateSurface normalises it to the display mode for every cooperative level), so a primary
 * size test is true for every app and would suppress GDI for genuinely windowed ones — whose
 * blits are clipped to their window and which must keep compositing menus, dialogs and the
 * desktop around them (Wine: ddraw_surface_blt honours the attached clipper's window region).
 */
function ddrawWindowCoversDisplay(ddrawCtx: DDrawContext | null | undefined): boolean {
    const hwnd = ddrawTargetWindow(ddrawCtx);
    const mode = ddrawCtx?.display;
    if (!hwnd || !mode?.width || !mode?.height) return false;
    const win = sharedWindows.get(hwnd);
    if (!win || !win.visible) return false;
    return win.width >= mode.width && win.height >= mode.height;
}

/**
 * The window a windowed primary blit lands in.
 *
 * `SetCooperativeLevel(NULL, DDSCL_NORMAL)` is legal — the hwnd argument is only required
 * for DDSCL_EXCLUSIVE — and an app that passes NULL names its window the other way DirectDraw
 * offers: an IDirectDrawClipper with SetHWnd attached to the primary, which is what the blit
 * is clipped against in the first place (Wine: ddraw_surface_blt honours the attached
 * clipper's window region). So the clipper answers first and the cooperative window is the
 * fallback; for the usual app that sets both they are the same window.
 */
function ddrawTargetWindow(ddrawCtx: DDrawContext | null | undefined): number {
    const coop = ddrawCtx?.cooperative?.hwnd ?? 0;
    const provider = ddrawCtx?.resourceProvider;
    const primary = provider ? surfaceAt(provider, ddrawCtx?.surfaces?.primary ?? 0) : null;
    const clipperHandle = primary?.getState().clipperHandle;
    if (clipperHandle === undefined || !provider) return coop;
    const clipper = provider.getComObject(clipperHandle);
    if (!(clipper instanceof DirectDrawClipperObject)) return coop;
    return clipper.getHwnd() || coop;
}

/** GDI desktop surface hidden while the flip chain owns the screen. */
export function isGdiSurfaceHidden(ddrawCtx: DDrawContext | null | undefined): boolean {
    return isDDrawExclusiveFullscreen(ddrawCtx) && ddrawCtx!.gdiSurfaceVisible === false;
}

/** A hardware-3D presenter owns the screen, so GDI overlay compositing (window-background
 *  paints, etc.) must not black out the rendered frame. Two cases:
 *   - Pure D3D8/D3D9/Glide/OpenGL game with NO DirectDraw 2D primary in play → the 3D
 *     renderer always owns the screen (no DDraw surface to compose with).
 *   - A 3D renderer layered over a DirectDraw primary (D3D7-era) → only owns the screen in
 *     DDraw exclusive fullscreen; windowed DDraw still composes GDI.
 *  Without this, a fullscreen D3D9 game (which never sets a DDraw cooperative level) had its
 *  frame clobbered every other present by the GDI loop compositing a black bg paint → flicker. */
export function shouldSuppress3DGdiOverlay(
    renderActive: RenderActive | null,
    ddrawCtx: DDrawContext | null | undefined,
): boolean {
    if (!(renderActive as { suppressGdiOverlay?: boolean } | null)?.suppressGdiOverlay) return false;
    if (!ddrawHasPrimary(ddrawCtx)) return true; // pure 3D presenter — it owns the canvas outright
    return ddrawOwnsScreen(ddrawCtx);
}
