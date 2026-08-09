/**
 * Classic scrollbar: metrics, geometry and painting.
 *
 * One definition serves the SCROLLBAR class, the bars a listbox/listview/edit/rich
 * edit draws inside its own client, and the hit testing in control-interaction —
 * so a click can never land on a part the painter drew somewhere else.
 *
 * Faithful details that matter:
 *  - The thumb spans the FULL width of the bar, exactly like the arrow buttons.
 *  - Windows greys a scrollbar only when there is nothing to scroll (page covers the
 *    whole range) or EnableScrollBar disabled it. Sitting at either end greys nothing.
 *  - A disabled arrow is an EMBOSSED GREY GLYPH on a normal button face, never a
 *    filled dark box.
 */

import {
    COLOR_BTNFACE,
    COLOR_BTNHILIGHT,
    COLOR_BTNSHADOW,
    COLOR_BTNTEXT,
    drawPressedEdge,
    drawRaisedEdge,
    type Ctx2D,
} from './classic-theme';

/** SM_CXVSCROLL / SM_CYHSCROLL — and the arrow button's extent along the bar. */
export const SB_WIDTH = 16;
/** Classic minimum thumb extent (SM_CYVTHUMB collapses to this in a short track). */
export const SB_THUMB_MIN = 8;

/** Arrow button extent along the bar: two of them must still fit. */
export function scrollArrowSize(extent: number): number {
    return Math.max(1, Math.min(SB_WIDTH, Math.floor(extent / 2)));
}

export interface ScrollRange {
    min: number;
    max: number;
    /** Visible units (SCROLLINFO.nPage). 0 means "no proportional thumb". */
    page: number;
    pos: number;
}

export interface ScrollMetrics {
    arrow: number;
    /** Track = the span between the two arrow buttons, in bar-local coordinates. */
    trackStart: number;
    trackSize: number;
    thumbStart: number;
    /** 0 for an empty range; the whole track when the page covers the range. */
    thumbSize: number;
    /** False when the thumb cannot move (page covers the range, or nMin == nMax). */
    scrollable: boolean;
    /** nMin == nMax — Win32 disables the bar outright: grey arrows, no thumb. */
    empty: boolean;
    /** Highest reachable pos. */
    maxPos: number;
}

/**
 * Geometry of a bar `extent` pixels long. Offsets are relative to the bar's start
 * (top for a vertical bar, left for a horizontal one).
 */
export function scrollMetrics(extent: number, r: ScrollRange): ScrollMetrics {
    const arrow = scrollArrowSize(extent);
    const trackStart = arrow;
    const trackSize = Math.max(0, extent - arrow * 2);

    const min = Math.min(r.min, r.max);
    const max = Math.max(r.min, r.max);
    const page = Math.max(0, r.page | 0);
    // Win32 ranges are inclusive, so nPage == nMax - nMin + 1 already covers everything.
    const units = max - min + 1;
    const maxPos = page > 0 ? Math.max(min, max - page + 1) : max;
    const empty = max <= min || trackSize <= 0;
    const scrollable = !empty && maxPos > min;

    let thumbSize = 0;
    let thumbStart = trackStart;
    if (!empty) {
        // A page that covers the range leaves the thumb filling the whole track —
        // Win32 keeps the bar live-looking there, it only greys an EMPTY range.
        thumbSize = !scrollable
            ? trackSize
            : Math.max(SB_THUMB_MIN, Math.min(trackSize, page > 0 ? Math.round(trackSize * page / units) : SB_WIDTH));
        if (scrollable) {
            const pos = Math.max(min, Math.min(maxPos, r.pos));
            thumbStart = trackStart + Math.round((trackSize - thumbSize) * (pos - min) / (maxPos - min));
        }
    }

    return { arrow, trackStart, trackSize, thumbStart, thumbSize, scrollable, empty, maxPos };
}

export type ScrollPart = 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown' | 'thumb';

/** Which part of the bar `offset` (bar-local) falls in. */
export function scrollHitTest(extent: number, offset: number, m: ScrollMetrics): ScrollPart {
    if (offset < m.arrow) return 'lineUp';
    if (offset >= extent - m.arrow) return 'lineDown';
    if (m.scrollable && offset >= m.thumbStart && offset < m.thumbStart + m.thumbSize) return 'thumb';
    return offset < m.thumbStart ? 'pageUp' : 'pageDown';
}

/** Pos that puts the thumb's TOP at `offset` (bar-local) — thumb drag / track jump. */
export function scrollPosFromOffset(offset: number, m: ScrollMetrics, r: ScrollRange): number {
    const min = Math.min(r.min, r.max);
    const span = m.trackSize - m.thumbSize;
    if (span <= 0) return min;
    const frac = Math.max(0, Math.min(1, (offset - m.trackStart) / span));
    return min + Math.round(frac * (m.maxPos - min));
}

// The classic track is a 2x2 checkerboard, not a flat grey: white over button face
// normally, and button face over shadow while that half of the track is held down.
const trackPatternSource: { normal: OffscreenCanvas | null; pressed: OffscreenCanvas | null } = {
    normal: null,
    pressed: null,
};

function checkerboard(light: string, dark: string): OffscreenCanvas | null {
    const c = new OffscreenCanvas(2, 2);
    const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!g) return null;
    g.fillStyle = light;
    g.fillRect(0, 0, 2, 2);
    g.fillStyle = dark;
    g.fillRect(0, 0, 1, 1);
    g.fillRect(1, 1, 1, 1);
    return c;
}

function trackFill(ctx: Ctx2D, pressed: boolean): string | CanvasPattern {
    const fallback = pressed ? '#AAA8A4' : '#E8E8E8';
    if (typeof OffscreenCanvas === 'undefined') return fallback;
    const key = pressed ? 'pressed' : 'normal';
    if (!trackPatternSource[key]) {
        trackPatternSource[key] = pressed
            ? checkerboard(COLOR_BTNFACE, COLOR_BTNSHADOW)
            : checkerboard(COLOR_BTNHILIGHT, COLOR_BTNFACE);
    }
    const source = trackPatternSource[key];
    return source ? (ctx.createPattern(source, 'repeat') ?? fallback) : fallback;
}

/**
 * Arrow glyph, classic 7x4 triangle centred in its button. Drawn as rows of
 * fillRects so it stays crisp at 1:1 instead of an antialiased path.
 */
function drawArrowGlyph(
    ctx: Ctx2D,
    bx: number, by: number, bw: number, bh: number,
    dir: 'up' | 'down' | 'left' | 'right',
    enabled: boolean,
): void {
    const rows = 4;
    const span = 7;
    const vertical = dir === 'up' || dir === 'down';
    const glyphW = vertical ? span : rows;
    const glyphH = vertical ? rows : span;
    const gx = bx + Math.floor((bw - glyphW) / 2);
    const gy = by + Math.floor((bh - glyphH) / 2);

    const paint = (dx: number, dy: number, color: string) => {
        ctx.fillStyle = color;
        for (let i = 0; i < rows; i++) {
            // Row i counted from the tip: 1, 3, 5, 7 pixels wide.
            const len = 1 + i * 2;
            const off = (span - len) / 2;
            switch (dir) {
                case 'up':
                    ctx.fillRect(gx + off + dx, gy + i + dy, len, 1);
                    break;
                case 'down':
                    ctx.fillRect(gx + off + dx, gy + (rows - 1 - i) + dy, len, 1);
                    break;
                case 'left':
                    ctx.fillRect(gx + i + dx, gy + off + dy, 1, len);
                    break;
                case 'right':
                    ctx.fillRect(gx + (rows - 1 - i) + dx, gy + off + dy, 1, len);
                    break;
            }
        }
    };

    if (enabled) {
        paint(0, 0, COLOR_BTNTEXT);
    } else {
        // DFCS_INACTIVE: white shadow offset by one, then the grey glyph over it.
        paint(1, 1, COLOR_BTNHILIGHT);
        paint(0, 0, COLOR_BTNSHADOW);
    }
}

/**
 * A raised button carrying a classic arrow glyph. Exported because a combobox's
 * drop button IS this button — Win32 draws it with DrawFrameControl(DFC_SCROLL,
 * DFCS_SCROLLCOMBOBOX), the same primitive as a scrollbar's arrow — so the two must
 * not have separate triangles that drift apart.
 */
export function drawArrowButton(
    ctx: Ctx2D,
    x: number, y: number, w: number, h: number,
    dir: 'up' | 'down' | 'left' | 'right',
    enabled: boolean,
    pressed: boolean,
): void {
    ctx.fillStyle = COLOR_BTNFACE;
    ctx.fillRect(x, y, w, h);
    if (pressed) {
        // Held down: the bevel collapses to a single shadow outline and the glyph
        // shifts one pixel down-right with it.
        drawPressedEdge(ctx, x, y, w, h);
        drawArrowGlyph(ctx, x + 1, y + 1, w, h, dir, enabled);
    } else {
        drawRaisedEdge(ctx, x, y, w, h);
        drawArrowGlyph(ctx, x, y, w, h, dir, enabled);
    }
}

export interface ScrollBarPaintOptions extends ScrollRange {
    vertical: boolean;
    /** EnableScrollBar: ESB_DISABLE_LTUP / ESB_DISABLE_RTDN, applied on top of the range. */
    upEnabled?: boolean;
    downEnabled?: boolean;
    /** The part held down by the mouse, drawn depressed until the button is released. */
    pressed?: ScrollPart | null;
}

/**
 * Paint a whole scrollbar into the rect. Returns the metrics used, so a caller that
 * also hit-tests does not recompute them.
 */
export function paintScrollBarRect(
    ctx: Ctx2D,
    x: number, y: number, w: number, h: number,
    o: ScrollBarPaintOptions,
): ScrollMetrics {
    const extent = o.vertical ? h : w;
    const m = scrollMetrics(extent, o);
    const upOk = !m.empty && o.upEnabled !== false;
    const downOk = !m.empty && o.downEnabled !== false;
    // EnableScrollBar(ESB_DISABLE_BOTH) takes the thumb away too, as Win32 does.
    const showThumb = m.thumbSize > 0 && (upOk || downOk);

    const pressed = o.pressed ?? null;
    ctx.fillStyle = trackFill(ctx, false);
    ctx.fillRect(x, y, w, h);

    // Only the half of the track the mouse is holding darkens, so the pressed region
    // runs from the arrow button to the thumb — not the whole track.
    if (pressed === 'pageUp' || pressed === 'pageDown') {
        const start = pressed === 'pageUp' ? m.trackStart : m.thumbStart + m.thumbSize;
        const size = pressed === 'pageUp'
            ? m.thumbStart - m.trackStart
            : m.trackStart + m.trackSize - (m.thumbStart + m.thumbSize);
        if (size > 0) {
            ctx.fillStyle = trackFill(ctx, true);
            if (o.vertical) ctx.fillRect(x, y + start, w, size);
            else ctx.fillRect(x + start, y, size, h);
        }
    }

    if (o.vertical) {
        drawArrowButton(ctx, x, y, w, m.arrow, 'up', upOk, pressed === 'lineUp');
        drawArrowButton(ctx, x, y + h - m.arrow, w, m.arrow, 'down', downOk, pressed === 'lineDown');
        if (showThumb) {
            ctx.fillStyle = COLOR_BTNFACE;
            ctx.fillRect(x, y + m.thumbStart, w, m.thumbSize);
            drawRaisedEdge(ctx, x, y + m.thumbStart, w, m.thumbSize);
        }
    } else {
        drawArrowButton(ctx, x, y, m.arrow, h, 'left', upOk, pressed === 'lineUp');
        drawArrowButton(ctx, x + w - m.arrow, y, m.arrow, h, 'right', downOk, pressed === 'lineDown');
        if (showThumb) {
            ctx.fillStyle = COLOR_BTNFACE;
            ctx.fillRect(x + m.thumbStart, y, m.thumbSize, h);
            drawRaisedEdge(ctx, x + m.thumbStart, y, m.thumbSize, h);
        }
    }
    return m;
}

/**
 * Live interaction feedback the painter cannot derive: which part the mouse holds
 * down, and where a thumb is being DRAGGED to. A SCROLLBAR control's committed
 * position only moves when its owner answers WM_VSCROLL, so without the tracked
 * position the thumb would sit still under the cursor for the whole drag.
 *
 * The interaction layer registers the provider (it owns the state); a slot rather
 * than a direct import because control-interaction.ts already imports the painters.
 */
export interface ScrollFeedback {
    pressed: ScrollPart | null;
    trackPos: number | null;
}

const NO_FEEDBACK: ScrollFeedback = { pressed: null, trackPos: null };
let feedbackProvider: ((hwnd: number, bar: number) => ScrollFeedback) | null = null;

export function setScrollFeedbackProvider(fn: ((hwnd: number, bar: number) => ScrollFeedback) | null): void {
    feedbackProvider = fn;
}

export function scrollFeedbackFor(hwnd: number, bar: number): ScrollFeedback {
    return feedbackProvider?.(hwnd, bar) ?? NO_FEEDBACK;
}

/**
 * The bar rect a list-shaped control paints inside its own client, at the right
 * edge. Exported so the hit test cannot drift from the painter by a pixel.
 */
export function listBarRect(x: number, y: number, w: number, h: number, inset: number): {
    x: number; y: number; w: number; h: number;
} {
    return {
        x: x + w - inset - SB_WIDTH,
        y: y + inset,
        w: SB_WIDTH,
        h: Math.max(1, h - inset * 2),
    };
}

/**
 * The horizontal twin of listBarRect, along the bottom of the client. `bodyW` is the
 * width left of any vertical bar — the two never overlap.
 */
export function bottomBarRect(x: number, y: number, bodyW: number, h: number, inset: number): {
    x: number; y: number; w: number; h: number;
} {
    return {
        x: x + inset,
        y: y + h - inset - SB_WIDTH,
        w: Math.max(1, bodyW - inset * 2),
        h: SB_WIDTH,
    };
}

/** The range a list-shaped control (listbox/listview/rich edit) scrolls over. */
export function listScrollRange(topIndex: number, visibleCount: number, itemCount: number): ScrollRange {
    return { min: 0, max: Math.max(0, itemCount - 1), page: Math.max(1, visibleCount), pos: topIndex };
}
