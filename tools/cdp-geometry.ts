/**
 * cdp-geometry.ts — the ONE guest-px ↔ CSS-px conversion for CDP-side tooling.
 *
 * Every host-side verb that aims at something the guest drew (gridShot's labels,
 * the touch verbs' contact positions) needs the same two facts: where the canvas
 * sits in the viewport, and how many CSS px one guest px is worth. A second copy
 * of that math drifts the instant device emulation, DPR or the letterbox rules
 * change — so it lives here and both callers import it.
 */

import { pageEval, type CdpSession } from "./cdp-core";

/** Page expression yielding the canvas rect (viewport CSS px) + guest surface dims.
 *  The class name is CSS-Modules-hashed at build time, so match the substring and
 *  fall back to the sole <canvas> rather than a literal `.app__canvas`. */
const CANVAS_GEOMETRY_EXPR = `(() => {
    const cv = document.querySelector('canvas[class*="app__canvas"]') || document.querySelector('.app__canvas') || document.querySelector('canvas');
    if (!cv) return { error: 'no guest canvas element (is a bundle loaded?)' };
    const r = cv.getBoundingClientRect();
    // Guest surface dims (the space clickAt/tap inject into). Prefer the explicit
    // global; fall back to the inline style.width/height App sets to guest px
    // (a transferred OffscreenCanvas reports width=0 on the main thread).
    const styW = parseFloat(cv.style.width) || 0, styH = parseFloat(cv.style.height) || 0;
    const gr = (window.__BS__ && window.__BS__.guestResolution) || (styW && styH ? { width: styW, height: styH } : { width: cv.width || 1024, height: cv.height || 768 });
    return {
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        guest: { w: Math.max(1, gr.width), h: Math.max(1, gr.height) },
        dpr: window.devicePixelRatio || 1,
    };
})()`;

export interface CanvasGeometry {
    /** Canvas bounding box in viewport CSS px — the space CDP Input events use. */
    rect: { x: number; y: number; w: number; h: number };
    /** Guest surface dimensions in guest px. */
    guest: { w: number; h: number };
    /** CSS px per guest px, per axis (letterboxing makes them differ). */
    scale: { x: number; y: number };
    dpr: number;
}

/** Read the live canvas geometry. Re-read after anything that reflows the page
 *  (device emulation, fullscreen, a resolution switch) — the rect moves. */
export async function readCanvasGeometry(session: CdpSession): Promise<CanvasGeometry> {
    const g = (await pageEval(session, CANVAS_GEOMETRY_EXPR, { timeoutMs: 10_000 })) as
        | { error?: string; rect: CanvasGeometry["rect"]; guest: CanvasGeometry["guest"]; dpr: number }
        | null;
    if (!g || g.error) throw new Error(`canvas geometry: ${g?.error ?? "page eval returned nothing"}`);
    return { ...g, scale: { x: g.rect.w / g.guest.w, y: g.rect.h / g.guest.h } };
}

/** Guest pixel → viewport CSS px (what Input.dispatch* consumes). */
export function guestToClient(geo: CanvasGeometry, gx: number, gy: number): { x: number; y: number } {
    return { x: geo.rect.x + gx * geo.scale.x, y: geo.rect.y + gy * geo.scale.y };
}
