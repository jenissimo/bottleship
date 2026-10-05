/**
 * The clip region of a device context.
 *
 * In Win32 clipping is DC STATE, not an argument to a primitive: every output call is
 * clipped by the DC's clip region, whatever surface sits underneath. Our DCs render onto
 * more than one target — the DC canvas, the selected bitmap's own canvas, and a
 * DIBSection's guest bits — so a clip applied at the primary call site and forgotten at
 * the mirror lets pixels land outside the region. This module is the single definition
 * every target is clipped by.
 *
 * The region is a rect LIST (as GDI's own regions are), kept in device coordinates and
 * carried on the DC state. Absence of a region means unbounded, which is the common case
 * and costs one null check per primitive.
 */

/** RegionType values returned by the clip APIs. */
export const NULLREGION = 1;
export const SIMPLEREGION = 2;
export const COMPLEXREGION = 3;

export interface DcClipRegion {
    /** Flat left,top,right,bottom quads in device coordinates. Empty = nothing draws. */
    rects: number[];
    /** Bounding box of `rects`; right/bottom exclusive. Zero-area when `rects` is empty. */
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/** A DC's clip slot. Absent region = unbounded. */
export interface DcClipState {
    region: DcClipRegion | null;
}

function boundsOf(rects: number[]): DcClipRegion {
    if (rects.length === 0) return { rects, x1: 0, y1: 0, x2: 0, y2: 0 };
    let x1 = rects[0], y1 = rects[1], x2 = rects[2], y2 = rects[3];
    for (let i = 4; i < rects.length; i += 4) {
        if (rects[i] < x1) x1 = rects[i];
        if (rects[i + 1] < y1) y1 = rects[i + 1];
        if (rects[i + 2] > x2) x2 = rects[i + 2];
        if (rects[i + 3] > y2) y2 = rects[i + 3];
    }
    return { rects, x1, y1, x2, y2 };
}

/** Build a region from a flat quad list, dropping empty rects. */
export function makeClipRegion(quads: readonly number[]): DcClipRegion {
    const rects: number[] = [];
    for (let i = 0; i + 3 < quads.length; i += 4) {
        const l = quads[i] | 0, t = quads[i + 1] | 0, r = quads[i + 2] | 0, b = quads[i + 3] | 0;
        if (r > l && b > t) rects.push(l, t, r, b);
    }
    return boundsOf(rects);
}

export function clipRegionFromRect(l: number, t: number, r: number, b: number): DcClipRegion {
    return makeClipRegion([l, t, r, b]);
}

export function cloneClipRegion(region: DcClipRegion | null): DcClipRegion | null {
    return region ? { rects: region.rects.slice(), x1: region.x1, y1: region.y1, x2: region.x2, y2: region.y2 } : null;
}

/** IntersectClipRect: the region becomes region ∩ rect (an absent region is unbounded). */
export function intersectClipRegionRect(
    region: DcClipRegion | null, l: number, t: number, r: number, b: number,
): DcClipRegion {
    if (!region) return clipRegionFromRect(l, t, r, b);
    const out: number[] = [];
    for (let i = 0; i < region.rects.length; i += 4) {
        const nl = Math.max(region.rects[i], l);
        const nt = Math.max(region.rects[i + 1], t);
        const nr = Math.min(region.rects[i + 2], r);
        const nb = Math.min(region.rects[i + 3], b);
        if (nr > nl && nb > nt) out.push(nl, nt, nr, nb);
    }
    return boundsOf(out);
}

/**
 * ExcludeClipRect: the region becomes region − rect. Subtracting from an unbounded
 * region needs a universe to subtract from, which is why callers pass the surface extent.
 */
export function excludeClipRegionRect(
    region: DcClipRegion | null,
    l: number, t: number, r: number, b: number,
    surfaceW: number, surfaceH: number,
): DcClipRegion {
    const base = region ?? clipRegionFromRect(0, 0, surfaceW, surfaceH);
    const out: number[] = [];
    for (let i = 0; i < base.rects.length; i += 4) {
        const rl = base.rects[i], rt = base.rects[i + 1], rr = base.rects[i + 2], rb = base.rects[i + 3];
        if (r <= rl || l >= rr || b <= rt || t >= rb) {
            out.push(rl, rt, rr, rb); // disjoint from the hole
            continue;
        }
        if (rt < t) out.push(rl, rt, rr, t);                       // above
        if (rb > b) out.push(rl, b, rr, rb);                       // below
        const my1 = Math.max(rt, t), my2 = Math.min(rb, b);
        if (my2 > my1) {
            if (rl < l) out.push(rl, my1, l, my2);                 // left
            if (rr > r) out.push(r, my1, rr, my2);                 // right
        }
    }
    return boundsOf(out);
}

/** OffsetClipRgn: move the whole region by (dx,dy). */
export function offsetClipRegion(region: DcClipRegion, dx: number, dy: number): DcClipRegion {
    const rects = region.rects.slice();
    for (let i = 0; i < rects.length; i += 4) {
        rects[i] += dx; rects[i + 1] += dy; rects[i + 2] += dx; rects[i + 3] += dy;
    }
    return boundsOf(rects);
}

/** CombineRgn / ExtSelectClipRgn modes. */
export const RGN_AND = 1;
export const RGN_OR = 2;
export const RGN_XOR = 3;
export const RGN_DIFF = 4;
export const RGN_COPY = 5;

/** Sorted, de-duplicated edge list. */
function edgeList(values: number[]): number[] {
    values.sort((a, b) => a - b);
    let n = 0;
    for (let i = 0; i < values.length; i++) {
        if (n === 0 || values[i] !== values[n - 1]) values[n++] = values[i];
    }
    values.length = n;
    return values;
}

/**
 * Merged x-spans of `rects` across the band [y1,y2). Bands are cut at every y edge of
 * both operands, so a rect either spans a band completely or misses it — which is what
 * lets the combine below work on one dimension at a time.
 */
function spansInBand(rects: number[], y1: number, y2: number, out: number[]): number[] {
    out.length = 0;
    for (let i = 0; i < rects.length; i += 4) {
        if (rects[i + 1] <= y1 && rects[i + 3] >= y2) out.push(rects[i], rects[i + 2]);
    }
    if (out.length <= 2) return out;
    // Sort span pairs by left edge, then coalesce overlaps.
    const pairs: number[][] = [];
    for (let i = 0; i < out.length; i += 2) pairs.push([out[i], out[i + 1]]);
    pairs.sort((a, b) => a[0] - b[0]);
    out.length = 0;
    for (const [l, r] of pairs) {
        if (out.length && l <= out[out.length - 1]) {
            if (r > out[out.length - 1]) out[out.length - 1] = r;
        } else {
            out.push(l, r);
        }
    }
    return out;
}

function spansContain(spans: number[], x: number): boolean {
    for (let i = 0; i < spans.length; i += 2) {
        if (x >= spans[i] && x < spans[i + 1]) return true;
    }
    return false;
}

function combineSpans(a: number[], b: number[], op: number, out: number[]): number[] {
    out.length = 0;
    const xs = edgeList(a.concat(b));
    for (let k = 0; k + 1 < xs.length; k++) {
        const x1 = xs[k], x2 = xs[k + 1];
        if (x2 <= x1) continue;
        const inA = spansContain(a, x1);
        const inB = spansContain(b, x1);
        const keep = op === RGN_AND ? (inA && inB)
            : op === RGN_OR ? (inA || inB)
                : op === RGN_XOR ? (inA !== inB)
                    : (inA && !inB); // RGN_DIFF
        if (!keep) continue;
        if (out.length && out[out.length - 1] === x1) out[out.length - 1] = x2;
        else out.push(x1, x2);
    }
    return out;
}

/**
 * CombineRgn's algebra over rect lists, in GDI's own band form: cut both operands at
 * every y edge, combine the x-spans of each band, then coalesce vertically adjacent
 * bands that came out identical. The result is canonical — disjoint, y-sorted, and no
 * more rects than the shape genuinely needs — which is what keeps a chain of combines
 * (a clip built up over a paint) from fragmenting without bound.
 */
export function combineClipRegions(a: DcClipRegion, b: DcClipRegion, op: number): DcClipRegion {
    if (op === RGN_COPY) return cloneClipRegion(a)!;
    const ys: number[] = [];
    for (let i = 0; i < a.rects.length; i += 4) ys.push(a.rects[i + 1], a.rects[i + 3]);
    for (let i = 0; i < b.rects.length; i += 4) ys.push(b.rects[i + 1], b.rects[i + 3]);
    edgeList(ys);

    const out: number[] = [];
    const sa: number[] = [], sb: number[] = [], sc: number[] = [];
    let pending: number[] | null = null;
    let pendingTop = 0, pendingBottom = 0;
    const flush = () => {
        if (!pending) return;
        for (let i = 0; i < pending.length; i += 2) {
            out.push(pending[i], pendingTop, pending[i + 1], pendingBottom);
        }
        pending = null;
    };
    for (let k = 0; k + 1 < ys.length; k++) {
        const y1 = ys[k], y2 = ys[k + 1];
        if (y2 <= y1) continue;
        spansInBand(a.rects, y1, y2, sa);
        spansInBand(b.rects, y1, y2, sb);
        combineSpans(sa, sb, op, sc);
        const same = pending !== null && pendingBottom === y1
            && pending.length === sc.length && pending.every((v, i) => v === sc[i]);
        if (same) {
            pendingBottom = y2;
            continue;
        }
        flush();
        if (sc.length === 0) continue;
        pending = sc.slice();
        pendingTop = y1;
        pendingBottom = y2;
    }
    flush();
    return boundsOf(out);
}

const EMPTY_CLIP_REGION: DcClipRegion = { rects: [], x1: 0, y1: 0, x2: 0, y2: 0 };

/** Canonical (disjoint, coalesced) form of a raw rect list — see combineClipRegions. */
export function normalizeClipRegion(region: DcClipRegion): DcClipRegion {
    return combineClipRegions(region, EMPTY_CLIP_REGION, RGN_OR);
}

/**
 * Scanline decomposition of an ellipse inscribed in the rect — GDI's own model of a
 * non-rectangular region, and the reason a region survives a round trip through
 * SelectClipRgn as a shape rather than as its bounding box.
 */
export function clipRegionFromEllipse(l: number, t: number, r: number, b: number): DcClipRegion {
    const w = r - l, h = b - t;
    if (w <= 0 || h <= 0) return { rects: [], x1: 0, y1: 0, x2: 0, y2: 0 };
    const cx = (l + r) / 2, cy = (t + b) / 2;
    const rx = w / 2, ry = h / 2;
    const rects: number[] = [];
    for (let y = t; y < b; y++) {
        // Sample the scanline centre, as GDI's own rasterizer does.
        const dy = (y + 0.5 - cy) / ry;
        const k = 1 - dy * dy;
        if (k <= 0) continue;
        const half = rx * Math.sqrt(k);
        const x1 = Math.round(cx - half), x2 = Math.round(cx + half);
        if (x2 > x1) rects.push(x1, y, x2, y + 1);
    }
    return normalizeClipRegion(boundsOf(rects));
}

/**
 * Scanline decomposition of a rectangle with elliptically rounded corners (w,h are the
 * full corner ellipse axes, as CreateRoundRectRgn documents them).
 */
export function clipRegionFromRoundRect(
    l: number, t: number, r: number, b: number, ellipseW: number, ellipseH: number,
): DcClipRegion {
    const w = r - l, h = b - t;
    if (w <= 0 || h <= 0) return { rects: [], x1: 0, y1: 0, x2: 0, y2: 0 };
    const rx = Math.min(Math.abs(ellipseW) / 2, w / 2);
    const ry = Math.min(Math.abs(ellipseH) / 2, h / 2);
    if (rx <= 0 || ry <= 0) return clipRegionFromRect(l, t, r, b);
    const rects: number[] = [];
    for (let y = t; y < b; y++) {
        const yc = y + 0.5;
        let inset = 0;
        if (yc < t + ry) {
            const dy = (t + ry - yc) / ry;
            inset = rx * (1 - Math.sqrt(Math.max(0, 1 - dy * dy)));
        } else if (yc > b - ry) {
            const dy = (yc - (b - ry)) / ry;
            inset = rx * (1 - Math.sqrt(Math.max(0, 1 - dy * dy)));
        }
        const x1 = Math.round(l + inset), x2 = Math.round(r - inset);
        if (x2 > x1) rects.push(x1, y, x2, y + 1);
    }
    return normalizeClipRegion(boundsOf(rects));
}

/** Scanline decomposition of a polygon (ALTERNATE=1 / WINDING=2 fill rule). */
export function clipRegionFromPolygon(points: readonly number[], mode: number): DcClipRegion {
    const n = points.length >> 1;
    if (n < 3) return { rects: [], x1: 0, y1: 0, x2: 0, y2: 0 };
    let top = Infinity, bottom = -Infinity;
    for (let i = 1; i < points.length; i += 2) {
        if (points[i] < top) top = points[i];
        if (points[i] > bottom) bottom = points[i];
    }
    const rects: number[] = [];
    const xs: { x: number; dir: number }[] = [];
    for (let y = Math.floor(top); y < bottom; y++) {
        const yc = y + 0.5;
        xs.length = 0;
        for (let i = 0; i < n; i++) {
            const x0 = points[i * 2], y0 = points[i * 2 + 1];
            const j = (i + 1) % n;
            const x1 = points[j * 2], y1 = points[j * 2 + 1];
            if (y0 === y1) continue;
            if ((yc >= y0 && yc < y1) || (yc >= y1 && yc < y0)) {
                xs.push({ x: x0 + (yc - y0) * (x1 - x0) / (y1 - y0), dir: y1 > y0 ? 1 : -1 });
            }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a.x - b.x);
        let winding = 0;
        for (let i = 0; i + 1 < xs.length; i++) {
            winding += mode === 2 ? xs[i].dir : 1;
            const inside = mode === 2 ? winding !== 0 : (i & 1) === 0;
            if (!inside) continue;
            const l = Math.round(xs[i].x), r = Math.round(xs[i + 1].x);
            if (r > l) rects.push(l, y, r, y + 1);
        }
    }
    return normalizeClipRegion(boundsOf(rects));
}

export function clipRegionType(region: DcClipRegion | null): number {
    if (!region) return SIMPLEREGION;
    if (region.rects.length === 0) return NULLREGION;
    return region.rects.length === 4 ? SIMPLEREGION : COMPLEXREGION;
}

/**
 * Apply a DC's clip to one render target. Returns whether a matching `ctx.restore()` is
 * owed — the caller keeps the pair tight around the primitive, so an unclipped DC pays a
 * single null test and no canvas state change.
 */
export function applyClipToContext(
    region: DcClipRegion | null,
    ctx: OffscreenCanvasRenderingContext2D,
): boolean {
    if (!region) return false;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < region.rects.length; i += 4) {
        ctx.rect(region.rects[i], region.rects[i + 1],
            region.rects[i + 2] - region.rects[i], region.rects[i + 3] - region.rects[i + 1]);
    }
    ctx.clip();
    return true;
}

/** True when any part of the device rect survives the clip. */
export function clipIntersectsRect(
    region: DcClipRegion | null, x: number, y: number, w: number, h: number,
): boolean {
    if (!region) return true;
    const r = x + w, b = y + h;
    if (r <= region.x1 || x >= region.x2 || b <= region.y1 || y >= region.y2) return false;
    for (let i = 0; i < region.rects.length; i += 4) {
        if (x < region.rects[i + 2] && r > region.rects[i]
            && y < region.rects[i + 3] && b > region.rects[i + 1]) return true;
    }
    return false;
}

/**
 * Clamp a device rect to the clip's bounding box, for the paths that COPY a RECT of
 * pixels rather than draw (DIBSection write-back, dirty tracking). The bbox — not the
 * exact region — is the right conservative answer there: those copies read back from the
 * already-clipped canvas, so a pixel the region excluded inside the box is unchanged.
 * A path that WRITES new pixels must use forEachClipRect instead.
 * Returns null when nothing survives.
 */
export function clampRectToClip(
    region: DcClipRegion | null, x: number, y: number, w: number, h: number,
): { x: number; y: number; w: number; h: number } | null {
    if (w <= 0 || h <= 0) return null;
    if (!region) return { x, y, w, h };
    const nx = Math.max(x, region.x1), ny = Math.max(y, region.y1);
    const nr = Math.min(x + w, region.x2), nb = Math.min(y + h, region.y2);
    if (nr <= nx || nb <= ny) return null;
    return { x: nx, y: ny, w: nr - nx, h: nb - ny };
}

/**
 * Visit the parts of a device rect the clip admits — for the primitives that WRITE
 * pixels through putImageData, the one canvas call a clip does not reach. They need the
 * REGION, not its bounding box: an ExcludeClipRect hole or a non-rectangular HRGN lies
 * inside the box, and painting it over is exactly what the guest asked us not to do.
 * Unbounded and single-rect clips emit one part, so the common case stays one
 * putImageData; nothing here allocates.
 * Returns false when nothing survives.
 */
export function forEachClipRect(
    region: DcClipRegion | null,
    x: number, y: number, w: number, h: number,
    fn: (x: number, y: number, w: number, h: number) => void,
): boolean {
    if (w <= 0 || h <= 0) return false;
    if (!region) { fn(x, y, w, h); return true; }
    const r = x + w, b = y + h;
    if (r <= region.x1 || x >= region.x2 || b <= region.y1 || y >= region.y2) return false;
    let any = false;
    for (let i = 0; i < region.rects.length; i += 4) {
        const nx = Math.max(x, region.rects[i]), ny = Math.max(y, region.rects[i + 1]);
        const nr = Math.min(r, region.rects[i + 2]), nb = Math.min(b, region.rects[i + 3]);
        if (nr <= nx || nb <= ny) continue;
        any = true;
        fn(nx, ny, nr - nx, nb - ny);
    }
    return any;
}
