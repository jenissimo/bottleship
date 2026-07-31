/**
 * GDI pen geometry — the line rasteriser behind LineTo / Polyline / PolylineTo /
 * PolyPolyline and the border half of Rectangle. Pen OBJECTS live in gdi-objects.ts
 * (the handle registry); this module owns only "given the pen selected into hdc, put
 * these segments on its canvas".
 *
 * Endpoint semantics are GDI's, not a path library's: a segment paints its start pixel
 * and NOT its end pixel (win32u/dibdrv/objects.c solid_pen_line drops the final pixel of
 * every run). Chained segments therefore paint each joint exactly once and a polyline's
 * last point stays unpainted — a control drawn as chained grooves is off by one pixel per
 * segment if the endpoint is drawn inclusively. A CLOSED figure needs no shortening: its
 * closing segment ends at the first point, which the first segment already painted.
 *
 * DCs are canvas-2D backed, and canvas has no unantialiased primitive. Stroking on the
 * half-pixel grid (see penPathOffset) makes axis-aligned lines land exactly on pixel rows
 * at any width, which is the case UI code depends on being crisp; diagonals get canvas
 * antialiasing instead of GDI's hard Bresenham edge, which we accept rather than
 * round-trip ImageData per segment.
 */
import { Logger, LogCategory } from "../../core/logger";
import { writeBackDibSectionRect } from './bitmap-resolve';
import type { GDIContext } from './context';
import {
    isStockObject,
    getStockObject,
    STOCK_NULL_PEN,
    PS_SOLID,
    PS_DASH,
    PS_DOT,
    PS_DASHDOT,
    PS_DASHDOTDOT,
    PS_NULL,
    PS_STYLE_MASK,
} from './gdi-objects';

/** Cosmetic dash runs in device pixels (dibdrv/objects.c dash_patterns_cosmetic). */
const COSMETIC_DASHES: Record<number, number[]> = {
    [PS_DASH]: [18, 6],
    [PS_DOT]: [3, 3],
    [PS_DASHDOT]: [9, 6, 3, 6],
    [PS_DASHDOTDOT]: [9, 3, 3, 3, 3, 3],
};

export interface SelectedPen {
    /** PS_* style, ExtCreatePen type/endcap/join bits already masked off. */
    style: number;
    /** Device width in pixels, always >= 1 (a 0-width cosmetic pen is 1 device pixel). */
    width: number;
    css: string;
    dashes: number[] | null;
}

/**
 * The pen selected into hdc, or null when it would paint nothing (PS_NULL / no DC).
 * PS_NULL still has to reach the caller as "no paint" rather than "failure": LineTo
 * updates the current position either way.
 */
export function getSelectedPen(gdi: GDIContext, hdc: number): SelectedPen | null {
    const state = gdi.hdcStates.get(hdc);
    if (!state) return null;
    const handle = state.hPen;
    const obj = isStockObject(handle) ? getStockObject(handle) : (gdi.objects.get(handle) ?? null);
    if (!obj || obj.type !== 'PEN') return null;
    if (handle === ((0x80000000 | STOCK_NULL_PEN) >>> 0)) return null;

    const style = (obj.penStyle ?? PS_SOLID) & PS_STYLE_MASK;
    if (style === PS_NULL) return null;
    const width = Math.max(1, obj.penWidth ?? 1);
    // Wide cosmetic pens are not dashed (dibdrv/objects.c dibdrv_SelectPen).
    const dashes = width === 1 ? (COSMETIC_DASHES[style] ?? null) : null;
    return { style, width, css: typeof obj.data === 'string' ? obj.data : '#000000', dashes };
}

/**
 * Half-pixel bias that centres a stroke of the given width the way GDI centres a pen:
 * odd widths straddle the pixel centre (+0.5), even widths grow toward +x/+y (+1), so a
 * width-2 pen on row y covers rows y..y+1 exactly as dibdrv's wide-pen outline does.
 */
function penPathOffset(width: number): number {
    return (width & 1) ? 0.5 : 1;
}

/** Pull the endpoint back one device pixel along the segment's major axis. */
function shortenEnd(x0: number, y0: number, x1: number, y1: number): { x: number; y: number } {
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (dx === 0 && dy === 0) return { x: x1, y: y1 };
    if (Math.abs(dx) >= Math.abs(dy)) {
        return { x: x1 - Math.sign(dx), y: y1 - Math.round(Math.sign(dx) * dy / Math.abs(dx)) };
    }
    return { x: x1 - Math.round(Math.sign(dy) * dx / Math.abs(dy)), y: y1 - Math.sign(dy) };
}

/** Trace pts (flat x,y pairs) into ctx honouring the GDI exclusive endpoint. */
function tracePath(
    ctx: OffscreenCanvasRenderingContext2D,
    pts: readonly number[],
    closed: boolean,
    pen: SelectedPen,
): void {
    const n = pts.length >> 1;
    const off = penPathOffset(pen.width);
    ctx.strokeStyle = pen.css;
    ctx.lineWidth = pen.width;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.setLineDash(pen.dashes ?? []);
    ctx.beginPath();
    ctx.moveTo(pts[0] + off, pts[1] + off);
    // Set when the exclusive endpoint consumes the whole final segment: one device pixel
    // long, so GDI still paints its start pixel and a bare moveTo would paint nothing.
    let startPixel: { x: number; y: number } | null = null;
    for (let i = 1; i < n; i++) {
        let x = pts[i * 2];
        let y = pts[i * 2 + 1];
        if (!closed && i === n - 1) {
            const px = pts[(i - 1) * 2], py = pts[(i - 1) * 2 + 1];
            const cut = shortenEnd(px, py, x, y);
            if (cut.x === px && cut.y === py) {
                // A zero-length final segment paints nothing at all in GDI.
                if (x !== px || y !== py) startPixel = { x: px, y: py };
                break;
            }
            x = cut.x;
            y = cut.y;
        }
        ctx.lineTo(x + off, y + off);
    }
    if (closed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    if (startPixel) {
        const half = pen.width / 2;
        ctx.fillStyle = pen.css;
        ctx.fillRect(startPixel.x + off - half, startPixel.y + off - half, pen.width, pen.width);
    }
}

/**
 * Stroke a polyline with hdc's current pen. `pts` is a flat x0,y0,x1,y1,... list in
 * device coordinates; `closed` joins the last point back to the first (Rectangle's
 * border). Returns false only when the HDC itself is unusable — a PS_NULL pen is a
 * successful no-paint.
 */
export function strokePolyline(
    gdi: GDIContext,
    hdc: number,
    pts: readonly number[],
    closed: boolean,
): boolean {
    const ctx = gdi.contexts.get(hdc);
    if (!ctx || pts.length < 4) return !!ctx;

    const pen = getSelectedPen(gdi, hdc);
    if (!pen) return true;

    if (ctx === gdi.overlayCtx) gdi.setOverlayDirty(true);

    tracePath(ctx, pts, closed, pen);

    // Memory DCs mirror into the bitmap's own canvas, same as fillRect/textOut.
    const linkedBitmap = (ctx.canvas as { __bitmapCanvas?: OffscreenCanvas }).__bitmapCanvas;
    if (linkedBitmap) {
        const bitmapCtx = linkedBitmap.getContext('2d');
        if (bitmapCtx) tracePath(bitmapCtx as OffscreenCanvasRenderingContext2D, pts, closed, pen);
    }

    let minX = pts[0], maxX = pts[0], minY = pts[1], maxY = pts[1];
    for (let i = 1; i < (pts.length >> 1); i++) {
        const x = pts[i * 2], y = pts[i * 2 + 1];
        if (x < minX) minX = x; else if (x > maxX) maxX = x;
        if (y < minY) minY = y; else if (y > maxY) maxY = y;
    }
    const pad = pen.width;
    // A DIBSection's guest bits are its pixel surface — the stroke has to land there too.
    writeBackDibSectionRect(gdi.hdcStates.get(hdc)?.hBitmap ?? 0, ctx,
        minX - pad, minY - pad, (maxX - minX) + pad * 2 + 1, (maxY - minY) + pad * 2 + 1);
    gdi.expandDirtyRect(hdc, minX - pad, minY - pad, (maxX - minX) + pad * 2 + 1, (maxY - minY) + pad * 2 + 1);
    gdi.markDirty(hdc);
    gdi.invalidateImageDataCache(hdc);

    Logger.verboseLazy(LogCategory.GDI32, () =>
        `strokePolyline(hdc=0x${hdc.toString(16)}, ${pts.length >> 1} pts, closed=${closed}) `
        + `style=${pen.style} w=${pen.width} ${pen.css}`);
    return true;
}

/** LineTo: stroke from the DC's current position and adopt the endpoint as the new one. */
export function lineTo(gdi: GDIContext, hdc: number, x: number, y: number): boolean {
    if (!gdi.contexts.has(hdc)) return false;
    const from = gdi.getCurrentPosition(hdc);
    const ok = strokePolyline(gdi, hdc, [from.x, from.y, x, y], false);
    // The current position moves even for a PS_NULL pen or a failed clip — callers chain
    // segments off it (win32u keeps cur_pos in the DC attributes, not in the driver).
    gdi.setCurrentPosition(hdc, x, y);
    return ok;
}
