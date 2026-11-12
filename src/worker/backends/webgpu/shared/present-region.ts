/**
 * Present(pSourceRect, pDestRect, hDestWindowOverride): which part of the back buffer goes
 * to which part of the destination window's client area.
 *
 * Direct3D stretches the source rectangle onto the destination rectangle; a NULL source is
 * the whole back buffer and a NULL destination the whole client area. Rectangles that reach
 * outside their surface are clipped, and the other rectangle shrinks in proportion so the
 * picture keeps its scale.
 *
 * The host shows the destination window's client area, so a present that is not "whole
 * back buffer onto whole client area" has to be composed at client size first. `identity`
 * says when that is unnecessary.
 */
export interface PresentRect { left: number; top: number; right: number; bottom: number }

export interface PresentRegion {
    hasSrc: boolean;
    src: PresentRect;
    hasDst: boolean;
    dst: PresentRect;
    clientWidth: number;
    clientHeight: number;
}

export interface PresentPlan {
    /** Whole back buffer onto the whole client area: present the back buffer as it is. */
    identity: boolean;
    /** Nothing of the source lands inside the client area. */
    empty: boolean;
    /** The destination rectangle covers the client area completely. */
    covers: boolean;
    src: PresentRect;
    dst: PresentRect;
    clientWidth: number;
    clientHeight: number;
}

export function createPresentRegion(): PresentRegion {
    return {
        hasSrc: false, src: { left: 0, top: 0, right: 0, bottom: 0 },
        hasDst: false, dst: { left: 0, top: 0, right: 0, bottom: 0 },
        clientWidth: 0, clientHeight: 0,
    };
}

export function createPresentPlan(): PresentPlan {
    return {
        identity: true, empty: false, covers: true,
        src: { left: 0, top: 0, right: 0, bottom: 0 },
        dst: { left: 0, top: 0, right: 0, bottom: 0 },
        clientWidth: 0, clientHeight: 0,
    };
}

/** Fills `out` (no allocation) and returns it. */
export function resolvePresentPlan(
    backWidth: number, backHeight: number, region: PresentRegion, out: PresentPlan,
): PresentPlan {
    const clientW = region.clientWidth > 0 ? region.clientWidth : backWidth;
    const clientH = region.clientHeight > 0 ? region.clientHeight : backHeight;
    let sl = 0, st = 0, sr = backWidth, sb = backHeight;
    if (region.hasSrc) { sl = region.src.left; st = region.src.top; sr = region.src.right; sb = region.src.bottom; }
    let dl = 0, dt = 0, dr = clientW, db = clientH;
    if (region.hasDst) { dl = region.dst.left; dt = region.dst.top; dr = region.dst.right; db = region.dst.bottom; }
    out.clientWidth = clientW;
    out.clientHeight = clientH;
    out.identity = false;
    out.covers = false;
    out.empty = !(sr > sl && sb > st && dr > dl && db > dt);
    if (!out.empty) {
        const kx = (dr - dl) / (sr - sl);
        const ky = (db - dt) / (sb - st);
        // Clip the source to the back buffer, then the destination to the client area;
        // each cut moves the matching edge of the other rectangle by the scaled amount.
        if (sl < 0) { dl -= sl * kx; sl = 0; }
        if (st < 0) { dt -= st * ky; st = 0; }
        if (sr > backWidth) { dr -= (sr - backWidth) * kx; sr = backWidth; }
        if (sb > backHeight) { db -= (sb - backHeight) * ky; sb = backHeight; }
        if (dl < 0) { sl -= dl / kx; dl = 0; }
        if (dt < 0) { st -= dt / ky; dt = 0; }
        if (dr > clientW) { sr -= (dr - clientW) / kx; dr = clientW; }
        if (db > clientH) { sb -= (db - clientH) / ky; db = clientH; }
        out.empty = !(sr > sl && sb > st && dr > dl && db > dt);
    }
    out.src.left = sl; out.src.top = st; out.src.right = sr; out.src.bottom = sb;
    out.dst.left = dl; out.dst.top = dt; out.dst.right = dr; out.dst.bottom = db;
    if (out.empty) return out;
    out.covers = dl <= 0 && dt <= 0 && dr >= clientW && db >= clientH;
    out.identity = out.covers && sl <= 0 && st <= 0 && sr >= backWidth && sb >= backHeight;
    return out;
}
