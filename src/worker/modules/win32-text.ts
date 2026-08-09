/*
 * Win32 accelerator-prefix handling for control text and DrawText.
 *
 * A single '&' marks the following displayed character as the access key.
 * A doubled '&&' displays one literal ampersand. DT_NOPREFIX/SS_NOPREFIX keep
 * ampersands literal, while DT_HIDEPREFIX strips them without drawing the cue.
 */

export interface ParsedMnemonicText {
    /** Text as displayed after Win32 prefix handling. */
    display: string;
    /** UTF-16 index in display of the access-key character, or -1. */
    underlineIndex: number;
    /** Lowercase access-key code unit, or 0 when none. */
    mnemonicChar: number;
}

export type MnemonicTextContext =
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;

export interface DrawMnemonicTextOptions {
    /** Parse Win32 '&' prefixes. Defaults to true. */
    processPrefix?: boolean;
    /** Draw the access-key underline. Defaults to true. */
    drawUnderline?: boolean;
    /** Draw display text. DT_PREFIXONLY disables this. Defaults to true. */
    drawText?: boolean;
}

export const DT_NOPREFIX = 0x00000800;
export const DT_HIDEPREFIX = 0x00100000;
export const DT_PREFIXONLY = 0x00200000;

export function drawTextPrefixOptions(format?: number): DrawMnemonicTextOptions {
    if (format !== undefined && (format & DT_NOPREFIX) !== 0) {
        return { processPrefix: false, drawUnderline: false, drawText: true };
    }
    if (format !== undefined && (format & DT_PREFIXONLY) !== 0) {
        return { processPrefix: true, drawUnderline: true, drawText: false };
    }
    if (format !== undefined && (format & DT_HIDEPREFIX) !== 0) {
        return { processPrefix: true, drawUnderline: false, drawText: true };
    }
    return { processPrefix: true, drawUnderline: true, drawText: true };
}

export function parseMnemonicText(raw: string, processPrefix = true): ParsedMnemonicText {
    if (!raw || !processPrefix) {
        return { display: raw, underlineIndex: -1, mnemonicChar: 0 };
    }

    let display = "";
    let underlineIndex = -1;
    let mnemonicChar = 0;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch !== "&") {
            display += ch;
            continue;
        }

        const next = raw[i + 1];
        if (next === "&") {
            display += "&";
            i++;
            continue;
        }

        if (next !== undefined) {
            if (underlineIndex < 0) {
                underlineIndex = display.length;
                mnemonicChar = next.toLowerCase().charCodeAt(0);
            }
            display += next;
            i++;
        }
    }

    return { display, underlineIndex, mnemonicChar };
}

export function measureMnemonicText(
    ctx: MnemonicTextContext,
    raw: string,
    processPrefix = true,
): number {
    return ctx.measureText(parseMnemonicText(raw, processPrefix).display).width;
}

/** GDI TEXTMETRIC fields the control painters lay text out with. */
export interface GdiTextMetrics {
    /** tmAscent — baseline offset from the top of the text cell. */
    ascent: number;
    /** tmDescent. */
    descent: number;
    /** tmHeight — the cell DT_VCENTER centres and DrawText advances by per line. */
    height: number;
}

const gdiMetricsCache = new Map<string, GdiTextMetrics>();

/**
 * Private 1x1 context the metric probe measures on. The painter's own context is
 * never re-fonted for a measurement: it belongs to a DC whose font is guest state,
 * and a throw between the probe and the restore would leave the guest's DC drawing
 * at 100x.
 */
let metricProbeCtx: MnemonicTextContext | null | undefined;
function probeContext(): MnemonicTextContext | null {
    if (metricProbeCtx === undefined) {
        metricProbeCtx = typeof OffscreenCanvas === 'undefined'
            ? null
            : (new OffscreenCanvas(1, 1).getContext('2d') as MnemonicTextContext | null);
    }
    return metricProbeCtx;
}

/**
 * TEXTMETRIC of the context's current font, as GDI would report it.
 *
 * GDI derives tmAscent/tmDescent from the face's design ascent/descent scaled to
 * the requested em height, then rounds the CELL up: tmHeight = ceil(ascent +
 * descent), tmDescent = round(descent), tmAscent = the remainder. Canvas exposes
 * the same design metrics, but Skia hands them back already rounded to whole
 * pixels at UI sizes — 11px "Microsoft Sans Serif" reports 10 + 2 where GDI says
 * 11 + 2 — so the fraction is recovered by measuring the same face 100x larger,
 * where a rounding of the returned integer cannot hide it. Per font string, cached.
 */
export function gdiTextMetrics(ctx: MnemonicTextContext): GdiTextMetrics {
    const font = ctx.font;
    const cached = gdiMetricsCache.get(font);
    if (cached) return cached;

    const px = fontPixelSize(ctx);
    let ascent = px * 0.92;
    let descent = px * 0.21;
    const probeCtx = probeContext();
    const probe = font.replace(/(\d+(?:\.\d+)?)px/, (_m, n: string) => `${Number(n) * 100}px`);
    if (probeCtx && probe !== font) {
        probeCtx.font = probe;
        if (probeCtx.font === probe) {
            const m = probeCtx.measureText('x') as TextMetrics;
            if (typeof m.fontBoundingBoxAscent === 'number' && m.fontBoundingBoxAscent > 0) {
                ascent = m.fontBoundingBoxAscent / 100;
                descent = m.fontBoundingBoxDescent / 100;
            }
        }
    }

    const height = Math.ceil(ascent + descent);
    const tmDescent = Math.round(descent);
    const metrics: GdiTextMetrics = { ascent: height - tmDescent, descent: tmDescent, height };
    gdiMetricsCache.set(font, metrics);
    return metrics;
}

/** tmHeight of the current font — DrawText's per-line advance. */
export function textCellHeight(ctx: MnemonicTextContext): number {
    return gdiTextMetrics(ctx).height;
}

/**
 * Baseline for DT_TOP text whose cell starts at `y` — use with textBaseline
 * "alphabetic".
 *
 * Canvas's "top" baseline is Skia's rounded ascent, which is not GDI's tmAscent
 * (it is a pixel short for the stock GUI font), so every painter positions the
 * ALPHABETIC baseline — the one place canvas measurement and canvas rendering
 * agree by definition — and derives it from the TEXTMETRIC above.
 */
export function topTextBaseline(ctx: MnemonicTextContext, y: number): number {
    return y + gdiTextMetrics(ctx).ascent;
}

/**
 * Baseline for text vertically centred in a rect, Win32-style.
 *
 * DT_VCENTER centres the text CELL: `top + (height - tmHeight) / 2`, truncated,
 * with the baseline tmAscent below that.
 */
export function vcenterTextBaseline(ctx: MnemonicTextContext, y: number, h: number): number {
    const m = gdiTextMetrics(ctx);
    return y + Math.floor((h - m.height) / 2) + m.ascent;
}

function fontPixelSize(ctx: MnemonicTextContext): number {
    const match = /(\d+(?:\.\d+)?)px\b/.exec(ctx.font);
    return match ? Number(match[1]) : 11;
}

function underlineY(ctx: MnemonicTextContext, y: number): number {
    const size = fontPixelSize(ctx);
    switch (ctx.textBaseline) {
        case "top":
        case "hanging":
            return y + Math.max(1, Math.round(size - 1));
        case "middle":
            return y + Math.max(1, Math.round(size * 0.42));
        case "bottom":
        case "ideographic":
            return y - 1;
        case "alphabetic":
        default:
            return y + 1;
    }
}

function leftAlignedX(ctx: MnemonicTextContext, display: string, x: number): number {
    switch (ctx.textAlign) {
        case "center":
            return x - ctx.measureText(display).width / 2;
        case "right":
        case "end":
            return x - ctx.measureText(display).width;
        case "left":
        case "start":
        default:
            return x;
    }
}

function drawMnemonicUnderline(
    ctx: MnemonicTextContext,
    display: string,
    underlineIndex: number,
    x: number,
    y: number,
): void {
    if (underlineIndex < 0 || underlineIndex >= display.length) return;

    const beforeWidth = ctx.measureText(display.slice(0, underlineIndex)).width;
    const throughWidth = ctx.measureText(display.slice(0, underlineIndex + 1)).width;
    const underlineX = Math.round(leftAlignedX(ctx, display, x) + beforeWidth);
    const underlineTop = Math.round(underlineY(ctx, y));
    const underlineW = Math.max(1, Math.round(throughWidth - beforeWidth));

    ctx.fillRect(underlineX, underlineTop, underlineW, 1);
}

export function fillTextWithMnemonic(
    ctx: MnemonicTextContext,
    raw: string,
    x: number,
    y: number,
    processPrefixOrOptions: boolean | DrawMnemonicTextOptions = true,
    drawUnderlineLegacy = true,
): ParsedMnemonicText {
    const options = typeof processPrefixOrOptions === "boolean"
        ? { processPrefix: processPrefixOrOptions, drawUnderline: drawUnderlineLegacy, drawText: true }
        : processPrefixOrOptions;
    const processPrefix = options.processPrefix ?? true;
    const drawUnderline = options.drawUnderline ?? true;
    const drawText = options.drawText ?? true;
    const parsed = parseMnemonicText(raw, processPrefix);

    if (drawText && parsed.display) {
        ctx.fillText(parsed.display, x, y);
    }
    if (processPrefix && drawUnderline && parsed.underlineIndex >= 0) {
        drawMnemonicUnderline(ctx, parsed.display, parsed.underlineIndex, x, y);
    }
    return parsed;
}

/**
 * DrawState(DSS_DISABLED) — the embossed grey label a BUTTON draws when disabled:
 * a highlight-coloured copy offset one pixel down-right, then the shadow-coloured
 * text over it. The STATIC class does not do this; it just recolours to GRAYTEXT.
 */
export function fillDisabledTextWithMnemonic(
    ctx: MnemonicTextContext,
    raw: string,
    x: number,
    y: number,
    highlight: string,
    shadow: string,
    options?: boolean | DrawMnemonicTextOptions,
): ParsedMnemonicText {
    ctx.fillStyle = highlight;
    fillTextWithMnemonic(ctx, raw, x + 1, y + 1, options);
    ctx.fillStyle = shadow;
    return fillTextWithMnemonic(ctx, raw, x, y, options);
}
