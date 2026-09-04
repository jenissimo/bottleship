/**
 * Present geometry — where the guest picture lands inside the host canvas.
 *
 * The canvas backing buffer is sized from the HOST container, not from the guest mode, so
 * "canvas pixels" and "guest screen pixels" are two different spaces. Everything that is
 * drawn ON TOP of the presented frame (the GDI/window plane, live dialog rects, the video
 * plane) has to land in exactly the rect the frame itself landed in, and the host has to be
 * able to invert that rect to map a pointer back into guest space. One definition, one
 * published value — duplicating the arithmetic is how the two silently drift apart.
 */

import { QualityConfig } from "../../../core/quality-config";

export interface PresentRect { x: number; y: number; w: number; h: number; }

/**
 * The destination rect for a `srcW x srcH` picture inside a `outW x outH` target, or null
 * when the picture covers the whole target (plain stretch — the common case, and the one
 * that must stay allocation- and branch-free).
 *
 * `srcW/srcH` are the PRESENTED TEXTURE's extent, which is the guest's own only at
 * internalScale Native — every backend that supersamples (Glide, D3D9) presents its
 * physical offscreen. Aspect ratio is unaffected (the scale is uniform), but integer
 * scaling is: an offscreen already fitted to the canvas floors to 1, so `integerScale`
 * quietly does nothing above Native. One rule for both backends, deliberately — a second
 * policy measuring the guest extent here would make the two disagree about where the same
 * picture lands, and every overlay is placed in this rect.
 */
export function computePresentDestRect(
    srcW: number, srcH: number, outW: number, outH: number, q: QualityConfig,
): PresentRect | null {
    if (srcW <= 0 || srcH <= 0 || outW <= 0 || outH <= 0) return null;
    if (q.aspectMode === "stretch" && !q.integerScale) return null;

    if (q.integerScale || q.aspectMode === "integer") {
        const scale = Math.max(1, Math.floor(Math.min(outW / srcW, outH / srcH)));
        const w = srcW * scale, h = srcH * scale;
        return { x: Math.floor((outW - w) / 2), y: Math.floor((outH - h) / 2), w, h };
    }
    // pillarbox: preserve source AR, fit inside output.
    const ar = srcW / srcH;
    let w = outW, h = Math.round(outW / ar);
    if (h > outH) { h = outH; w = Math.round(outH * ar); }
    return { x: Math.floor((outW - w) / 2), y: Math.floor((outH - h) / 2), w, h };
}

/** The published content rect plus the target it was measured against. */
export interface PublishedPresentRect extends PresentRect {
    outW: number;
    outH: number;
    /**
     * Size of the PRESENTED TEXTURE the rect was computed from. It is not a guest pointer
     * space — a supersampled Glide offscreen presents at its own resolution — so it is only
     * change-detection input here, never part of a coordinate map.
     */
    srcW: number;
    srcH: number;
}

let published: PublishedPresentRect | null = null;
let onChange: ((rect: PublishedPresentRect) => void) | null = null;

/**
 * Record where the guest picture just went. Called by the present path (and, in GDI-only
 * mode where nothing presents a 3D frame, by the overlay compositor) — never by a consumer.
 */
export function publishPresentRect(
    srcW: number, srcH: number, outW: number, outH: number, rect: PresentRect | null,
): void {
    if (outW <= 0 || outH <= 0) return;
    const r = rect ?? { x: 0, y: 0, w: outW, h: outH };
    const prev = published;
    if (prev && prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h &&
        prev.outW === outW && prev.outH === outH && prev.srcW === srcW && prev.srcH === srcH) {
        return;
    }
    published = { ...r, outW, outH, srcW, srcH };
    onChange?.(published);
}

/** Compute and publish in one step, returning the rect consumers should draw into. */
export function publishComputedPresentRect(
    srcW: number, srcH: number, outW: number, outH: number, q: QualityConfig,
): PresentRect {
    const rect = computePresentDestRect(srcW, srcH, outW, outH, q);
    publishPresentRect(srcW, srcH, outW, outH, rect);
    return rect ?? { x: 0, y: 0, w: outW, h: outH };
}

/** The last published rect, or null before the first present. */
export function getPresentRect(): PublishedPresentRect | null {
    return published;
}

/**
 * Where an overlay should be drawn on a `outW x outH` target: the published rect when it was
 * measured against that same target, else the whole target. The size check is what stops a
 * rect from a previous canvas size being applied to the current one.
 */
export function overlayDestRect(outW: number, outH: number): PresentRect {
    const p = published;
    if (p && p.outW === outW && p.outH === outH) return { x: p.x, y: p.y, w: p.w, h: p.h };
    return { x: 0, y: 0, w: outW, h: outH };
}

/**
 * True when `dest` covers the whole target, allowing the ONE pixel an aspect fit can lose:
 * the host sizes the backing buffer with Math.floor and the fit rounds, so a canvas already
 * cut to the guest aspect can miss by 1 — and treating that as a letterbox leaves a visible
 * bar where the intent was "exactly full".
 */
export function coversTarget(dest: PresentRect, outW: number, outH: number): boolean {
    return Math.abs(dest.x) <= 1 && Math.abs(dest.y) <= 1 &&
        Math.abs(dest.w - outW) <= 1 && Math.abs(dest.h - outH) <= 1;
}

// ---- the host side of the same map -------------------------------------------------
//
// The host inverts this rect to turn a pointer event back into a guest coordinate. It lives
// here, not in App.tsx, so the forward and the inverse cannot drift.

/** A CSS-space rectangle; DOMRect satisfies it. */
export interface HostRect {
    left: number; top: number; width: number; height: number; right: number; bottom: number;
}

/**
 * `rect` (the canvas element's CSS box) narrowed to the presented picture.
 *
 * Falls back to the whole box unless the publication was measured against the backing size
 * the host currently has: applying the rect's FRACTIONS across a resize is scale-invariant
 * under stretch/pillarbox but not under integer, where the scale itself is a floor of the
 * ratio — so a stale publication would silently mis-place every pointer event until the
 * next present, which for a paused or sparse presenter is never.
 */
export function contentRectFromPresentRect(
    rect: HostRect | null,
    published: PublishedPresentRect | null,
    backingW: number, backingH: number,
): HostRect | null {
    if (!rect || rect.width <= 0 || rect.height <= 0) return rect;
    const p = published;
    if (!p || p.w <= 0 || p.h <= 0 || p.outW <= 0 || p.outH <= 0) return rect;
    if (p.outW !== backingW || p.outH !== backingH) return rect;
    const sx = rect.width / p.outW;
    const sy = rect.height / p.outH;
    const left = rect.left + p.x * sx, top = rect.top + p.y * sy;
    const width = p.w * sx, height = p.h * sy;
    return { left, top, width, height, right: left + width, bottom: top + height };
}

/** A client/CSS point mapped into a `spaceW x spaceH` guest space through the content rect. */
export function clientToGuestPoint(
    content: HostRect, clientX: number, clientY: number, spaceW: number, spaceH: number,
): { x: number; y: number } {
    return {
        x: (clientX - content.left) * (spaceW / Math.max(1, content.width)),
        y: (clientY - content.top) * (spaceH / Math.max(1, content.height)),
    };
}

/** Notify the host when the content rect moves (pointer inversion depends on it). */
export function setPresentRectListener(fn: ((rect: PublishedPresentRect) => void) | null): void {
    onChange = fn;
    if (fn && published) fn(published);
}
