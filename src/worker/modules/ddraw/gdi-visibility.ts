/**
 * DirectDraw cooperative-level GDI visibility (exclusive fullscreen semantics).
 */

import type { DDrawContext } from './context';
import type { RenderActive } from '../../runtime/runtime-services';
import { surfaceAt } from './helpers';

export const DDSCL_NORMAL = 0x00000000;
export const DDSCL_FULLSCREEN = 0x00000001;
export const DDSCL_EXCLUSIVE = 0x00000010;
export const DDSCL_EXCLUSIVE_FULLSCREEN = DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE;

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
    return ddrawOwnsScreen(ddrawCtx) && !!ddrawCtx?.presenter?.hasPresentedFrame?.();
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
