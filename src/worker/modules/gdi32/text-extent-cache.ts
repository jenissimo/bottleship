/**
 * Prefix text widths without measuring every prefix.
 *
 * GetTextExtentExPoint needs the extent after EACH character. Measuring each prefix is n
 * canvas measureText calls over strings up to n long per call, and a text engine that lays
 * out paragraphs (Director's TextXtra) issues those calls in bulk. A prefix's width is the
 * sum of its characters' advances plus each adjacent pair's kerning, which is what the
 * browser computes for the whole string, so both are cached per canvas font and the
 * results match measuring the prefix directly.
 *
 * A canvas font string resolves through the FontFaceSet, so the cache is dropped whenever
 * a face is added or removed (font-resource.ts).
 */

/** The slice of the canvas API this needs; a structural type so tests can supply their own. */
export interface TextMeasurer {
    font: string;
    measureText(text: string): { width: number; fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number };
}

interface FontCache {
    advance: Map<number, number>;
    /** measure(ab) - advance(a) - advance(b), keyed a * 0x10000 + b. */
    kern: Map<number, number>;
    cellHeight: number | undefined;
}

const caches = new Map<string, FontCache>();

export function invalidateTextExtentCache(): void {
    caches.clear();
}

function cacheFor(font: string): FontCache {
    let c = caches.get(font);
    if (!c) {
        c = { advance: new Map(), kern: new Map(), cellHeight: undefined };
        caches.set(font, c);
    }
    return c;
}

function advanceOf(ctx: TextMeasurer, c: FontCache, code: number): number {
    let w = c.advance.get(code);
    if (w === undefined) {
        w = ctx.measureText(String.fromCharCode(code)).width;
        c.advance.set(code, w);
    }
    return w;
}

function kernOf(ctx: TextMeasurer, c: FontCache, a: number, b: number): number {
    const key = a * 0x10000 + b;
    let k = c.kern.get(key);
    if (k === undefined) {
        k = ctx.measureText(String.fromCharCode(a, b)).width - advanceOf(ctx, c, a) - advanceOf(ctx, c, b);
        c.kern.set(key, k);
    }
    return k;
}

/** out[i] = rounded width of text[0..i]; returns the full string's rounded width (0 for ""). */
export function prefixWidths(ctx: TextMeasurer, text: string, out: number[]): number {
    const c = cacheFor(ctx.font);
    let width = 0;
    let prev = -1;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        width += advanceOf(ctx, c, code);
        if (prev >= 0) width += kernOf(ctx, c, prev, code);
        out[i] = Math.round(width);
        prev = code;
    }
    return text.length > 0 ? out[text.length - 1]! : 0;
}

/** The font's cell height (ascent + descent of its bounding box), or undefined when the canvas can't say. */
export function fontCellHeight(ctx: TextMeasurer): number | undefined {
    const c = cacheFor(ctx.font);
    if (c.cellHeight === undefined) {
        const m = ctx.measureText("Wg");
        if (m.fontBoundingBoxAscent === undefined || m.fontBoundingBoxDescent === undefined) return undefined;
        c.cellHeight = Math.ceil(m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
    }
    return c.cellHeight;
}
