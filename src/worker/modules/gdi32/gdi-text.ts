/**
 * GDI text rendering — TextOut/DrawText canvas paths (escapement rotation,
 * OPAQUE background fills, DT_* alignment, linked-bitmap mirroring). Each
 * function takes the owning GDIContext as `gdi` and reads/writes its DC state.
 * Font/state selection stays in context.ts (SelectObject); this module only
 * renders with the already-selected state.
 */
import { Logger, LogCategory } from "../../core/logger";
import { drawTextPrefixOptions, fillTextWithMnemonic, parseMnemonicText } from "../win32-text";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { Mem } from "../../core/memory/mem-accessor";
import type { GDIContext } from './context';

const NONANTIALIASED_QUALITY = 3;
const ANTIALIASED_QUALITY = 4;

// SetTextAlign flags (wingdi.h)
const TA_UPDATECP = 0x01;
const TA_RIGHT = 0x02;
const TA_CENTER = 0x06;
const TA_BOTTOM = 0x08;
const TA_BASELINE = 0x18;

/** GDI renders small sizes from embedded bitmap strikes — hard-edged, no gray
 *  fringe — and games colorkey that output. Canvas fillText always antialiases,
 *  so its edge pixels survive the colorkey as grime around every glyph. */
function wantsAliasedText(state: { fontQuality: number; fontSize: number }): boolean {
    if (state.fontQuality === NONANTIALIASED_QUALITY) return true;
    if (state.fontQuality >= ANTIALIASED_QUALITY) return false;
    return state.fontSize <= 20;
}

let aliasScratch: OffscreenCanvas | null = null;
let aliasScratchCtx: OffscreenCanvasRenderingContext2D | null = null;

/** Binary (alpha-thresholded) glyph fill: rasterize to a scratch canvas, then
 *  composite fully-opaque textColor pixels where coverage >= 50%. */
function fillTextAliased(
    ctx: OffscreenCanvasRenderingContext2D,
    state: { fontSize: number; textColorValue: number },
    text: string,
    x: number,
    y: number
): void {
    const pad = 2;
    const w = Math.max(1, Math.ceil(ctx.measureText(text).width) + pad * 2);
    const h = Math.max(1, Math.ceil(state.fontSize * 1.7) + pad * 2);
    if (!aliasScratch || aliasScratch.width < w || aliasScratch.height < h) {
        aliasScratch = new OffscreenCanvas(Math.max(w, aliasScratch?.width ?? 0), Math.max(h, aliasScratch?.height ?? 0));
        aliasScratchCtx = aliasScratch.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    }
    const s = aliasScratchCtx;
    if (!s) { ctx.fillText(text, x, y); return; }
    s.clearRect(0, 0, w, h);
    s.font = ctx.font;
    s.textBaseline = 'top';
    s.textAlign = 'left';
    s.fillStyle = '#fff';
    s.fillText(text, pad, pad);
    const mask = s.getImageData(0, 0, w, h).data;
    const x0 = Math.round(x) - pad, y0 = Math.round(y) - pad;
    const img = ctx.getImageData(x0, y0, w, h);
    const t = img.data;
    const cv = state.textColorValue >>> 0; // COLORREF 0x00BBGGRR
    const r = cv & 0xff, g = (cv >> 8) & 0xff, b = (cv >> 16) & 0xff;
    for (let i = 3; i < mask.length; i += 4) {
        if (mask[i] >= 128) { t[i - 3] = r; t[i - 2] = g; t[i - 1] = b; t[i] = 255; }
    }
    ctx.putImageData(img, x0, y0);
}

/** After drawing on a DC with a selected DIBSection, mirror the drawn rect into the
 *  guest bits (ppvBits). Engines read those bytes directly (e.g. font-atlas builders
 *  rasterize glyphs via ExtTextOut and upload the DIB memory as a texture) — without
 *  this the guest sees the zero-fill. GDI-faithful 32bpp layout: [B,G,R,0] with the
 *  reserved byte 0; untouched pixels stay 0x00000000. */
function syncTextRectToDibSection(
    state: { hBitmap: number },
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number
): void {
    const hbm = state.hBitmap;
    if (!hbm) return;
    if ((ctx.canvas as any).__linkedBitmap !== hbm) return;
    const obj = SystemResourceProvider.getInstance().getUserObject(hbm) as {
        bitsPtr?: number; dibStride?: number; dibBpp?: number; dibTopDown?: boolean;
        width?: number; height?: number;
    } | null;
    const bitsPtr = obj?.bitsPtr ?? 0;
    const stride = obj?.dibStride ?? 0;
    if (!bitsPtr || !stride) return;
    if (obj!.dibBpp !== 32) {
        Logger.verbose(LogCategory.GDI32, `syncTextRectToDibSection: unsupported dibBpp=${obj!.dibBpp}`);
        return;
    }
    const bw = obj!.width ?? 0, bh = obj!.height ?? 0;
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(bw, Math.ceil(x + w)), y1 = Math.min(bh, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const iw = x1 - x0, ih = y1 - y0;
    const d = ctx.getImageData(x0, y0, iw, ih).data;
    const topDown = !!obj!.dibTopDown;
    const row = new Uint8Array(iw * 4);
    for (let yy = 0; yy < ih; yy++) {
        const dy = y0 + yy;
        let si = yy * iw * 4;
        for (let xx = 0, ri = 0; xx < iw; xx++, si += 4, ri += 4) {
            row[ri] = d[si + 2];
            row[ri + 1] = d[si + 1];
            row[ri + 2] = d[si];
            row[ri + 3] = 0;
        }
        Mem.writeBytes(bitsPtr + (topDown ? dy : (bh - 1 - dy)) * stride + x0 * 4, row);
    }
}

/** fillText honoring the selected font's GDI quality (aliased for small/bitmap-era fonts). */
function fillTextGdi(
    ctx: OffscreenCanvasRenderingContext2D,
    state: { fontQuality: number; fontSize: number; textColorValue: number },
    text: string,
    x: number,
    y: number
): void {
    if (wantsAliasedText(state)) fillTextAliased(ctx, state, text, x, y);
    else ctx.fillText(text, x, y);
}

export function textOut(gdi: GDIContext, hdc: number, x: number, y: number, text: string): boolean {
    if (!text) return false;
    const ctx = gdi.contexts.get(hdc);
    const state = gdi.hdcStates.get(hdc);
    if (!ctx || !state) {
        Logger.warn(LogCategory.GDI32, `textOut: Invalid HDC 0x${hdc.toString(16)} or state`);
        return false;
    }

    // Mark overlay as dirty if we're drawing to it
    const isOverlay = ctx === gdi.overlayCtx;
    if (isOverlay) {
        gdi.setOverlayDirty(true);
    }

    // Lazy apply font and text color
    if (state.appliedFont !== state.font) {
        ctx.font = state.font;
        state.appliedFont = state.font;
    }
    if (state.appliedFillStyle !== state.textColor) {
        ctx.fillStyle = state.textColor;
        state.appliedFillStyle = state.textColor;
    }

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Single measure shared by alignment, OPAQUE fill, DIB sync and dirty rect.
    const metrics = ctx.measureText(text);

    // SetTextAlign: resolve TA_* flags to a left/top origin up front so the OPAQUE
    // fill, aliased path, DIB sync and dirty-rect code below all share one space.
    const align = state.textAlign;
    const updateCp = (align & TA_UPDATECP) !== 0;
    if (updateCp) {
        const cp = gdi.getCurrentPosition(hdc);
        x = cp.x;
        y = cp.y;
    }
    if (align !== 0) {
        const refY = y;
        const hAlign = align & TA_CENTER;
        if (hAlign === TA_CENTER) x -= metrics.width / 2;
        else if (hAlign === TA_RIGHT) x -= metrics.width;
        const vAlign = align & TA_BASELINE;
        if (vAlign === TA_BASELINE) y -= metrics.fontBoundingBoxAscent ?? state.fontSize * 0.8;
        else if (vAlign === TA_BOTTOM) y -= state.fontSize;
        if (updateCp) gdi.setCurrentPosition(hdc, x + metrics.width, refY);
    }

    // Apply rotation if escapement is set
    // lfEscapement is in tenths of degrees (0.1 degree units)
    // Convert to radians: angle_rad = (escapement / 10) * (π / 180)
    const hasRotation = state.textEscapement !== 0;

    if (hasRotation) {
        // Save transform instead of using save/restore to avoid resetting font/fillStyle
        const savedTransform = ctx.getTransform();

        // Move to text position and rotate
        ctx.translate(x, y);
        const angleRad = (state.textEscapement / 10) * (Math.PI / 180);
        ctx.rotate(angleRad);

        // Only draw background if OPAQUE mode (bkMode=2)
        // TRANSPARENT = 1, OPAQUE = 2
        if (state.bkMode === 2) {
            // Use cached font size to avoid regex parsing
            ctx.fillStyle = state.bkColor;
            state.appliedFillStyle = state.bkColor; // Mark fillStyle as changed
            ctx.fillRect(0, 0, metrics.width, state.fontSize);

            // Restore text color
            ctx.fillStyle = state.textColor;
            state.appliedFillStyle = state.textColor;
        }

        // Draw text at origin (0, 0) after rotation
        ctx.fillText(text, 0, 0);

        // Restore transform manually (doesn't reset font/fillStyle)
        ctx.setTransform(savedTransform);
    } else {
        // No rotation - draw normally
        // Only draw background if OPAQUE mode (bkMode=2)
        // TRANSPARENT = 1, OPAQUE = 2
        if (state.bkMode === 2) {
            // Use cached font size to avoid regex parsing
            ctx.fillStyle = state.bkColor;
            state.appliedFillStyle = state.bkColor;
            ctx.fillRect(x, y, metrics.width, state.fontSize);

            // Restore text color
            ctx.fillStyle = state.textColor;
            state.appliedFillStyle = state.textColor;
        }

        fillTextGdi(ctx, state, text, x, y);
        syncTextRectToDibSection(state, ctx, x - 2, y - 2, metrics.width + 4, state.fontSize * 1.7 + 4);
    }

    // Mark as dirty for ReleaseDC optimization
    // Approximate text bounds for dirty rect tracking
    const width = metrics.width;
    const height = state.fontSize * 1.5; // Safe margin

    if (state.textEscapement !== 0) {
        // Rotated text: use bounding box
        const radius = Math.max(width, height);
        gdi.expandDirtyRect(hdc, x - radius, y - radius, radius * 2, radius * 2);
    } else {
        gdi.expandDirtyRect(hdc, x, y, width, height);
    }
    gdi.markDirty(hdc);

    // Invalidate image data cache after drawing
    gdi.invalidateImageDataCache(hdc);

    // If this is a memory DC with linked bitmap, update the bitmap canvas
    const linkedBitmap = (ctx.canvas as any).__bitmapCanvas;
    if (linkedBitmap) {
        const bitmapCtx = linkedBitmap.getContext('2d');
        if (bitmapCtx) {
            // Apply same font and color
            if (state.appliedFont !== state.font) {
                bitmapCtx.font = state.font;
            }
            if (state.appliedFillStyle !== state.textColor) {
                bitmapCtx.fillStyle = state.textColor;
            }
            bitmapCtx.textBaseline = 'top';
            bitmapCtx.textAlign = 'left';

            if (hasRotation) {
                bitmapCtx.save();
                bitmapCtx.translate(x, y);
                const angleRad = (state.textEscapement / 10) * (Math.PI / 180);
                bitmapCtx.rotate(angleRad);
                if (state.bkMode === 2) {
                    const metrics = bitmapCtx.measureText(text);
                    bitmapCtx.fillStyle = state.bkColor;
                    bitmapCtx.fillRect(0, 0, metrics.width, state.fontSize);
                    bitmapCtx.fillStyle = state.textColor;
                }
                bitmapCtx.fillText(text, 0, 0);
                bitmapCtx.restore();
            } else {
                if (state.bkMode === 2) {
                    const metrics = bitmapCtx.measureText(text);
                    bitmapCtx.fillStyle = state.bkColor;
                    bitmapCtx.fillRect(x, y, metrics.width, state.fontSize);
                    bitmapCtx.fillStyle = state.textColor;
                }
                fillTextGdi(bitmapCtx, state, text, x, y);
            }
        }
    }

    return true;
}

// DrawText/DrawTextEx format flags (winuser.h).
const DT_CENTER = 0x00000001;
const DT_RIGHT = 0x00000002;
const DT_VCENTER = 0x00000004;
const DT_BOTTOM = 0x00000008;
const DT_WORDBREAK = 0x00000010;
const DT_SINGLELINE = 0x00000020;
const DT_EXPANDTABS = 0x00000040;
const DT_TABSTOP = 0x00000080;
const DT_NOCLIP = 0x00000100;
const DT_EXTERNALLEADING = 0x00000200;
const DT_CALCRECT = 0x00000400;
const DT_PATH_ELLIPSIS = 0x00004000;
const DT_END_ELLIPSIS = 0x00008000;
const DT_WORD_ELLIPSIS = 0x00040000;

export interface DrawTextLayout {
    /** DrawText's return value: height of the laid-out text in logical units. */
    height: number;
    /** Width of the widest line — what DT_CALCRECT reports as right - left. */
    width: number;
}

type TextCtx = OffscreenCanvasRenderingContext2D;

/** One laid-out line: display text plus the index of its access-key character (-1 if none). */
interface LaidOutLine {
    text: string;
    underline: number;
}

/** tmHeight (plus tmExternalLeading under DT_EXTERNALLEADING) of the DC's selected font —
 *  the per-line advance GDI uses. Same ascent/descent source as GetTextMetrics so a guest
 *  that sizes its own rects from tmHeight agrees with what we lay out. */
function lineAdvance(ctx: TextCtx, fontSize: number, externalLeading: boolean): number {
    let ascent = fontSize * 0.8;
    let descent = fontSize * 0.2;
    try {
        const m = ctx.measureText('ABCgjpqy');
        if (m.fontBoundingBoxAscent !== undefined) {
            ascent = m.fontBoundingBoxAscent;
            descent = m.fontBoundingBoxDescent;
        }
    } catch { /* keep the font-size estimate */ }
    const height = Math.max(1, Math.ceil(ascent + descent));
    return externalLeading ? height + Math.round(ascent * 0.15) : height;
}

/** Longest prefix of `s` (from `from`) that fits `maxWidth`, at least one character. */
function fitPrefix(ctx: TextCtx, s: string, from: number, maxWidth: number): number {
    let lo = 1;
    let hi = s.length - from;
    let fit = 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ctx.measureText(s.slice(from, from + mid)).width <= maxWidth) {
            fit = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return fit;
}

/** Greedy DT_WORDBREAK wrap: break at the last space that fits, and mid-word when a single
 *  word is wider than the rect (GDI does the same). Segment starts are kept so the access-key
 *  index can be mapped onto the segment that ends up holding it. */
function wrapLine(ctx: TextCtx, line: string, maxWidth: number): Array<{ text: string; start: number }> {
    if (!line || maxWidth <= 0 || ctx.measureText(line).width <= maxWidth) {
        return [{ text: line, start: 0 }];
    }
    const segs: Array<{ text: string; start: number }> = [];
    let start = 0;
    while (start < line.length) {
        let end = start + fitPrefix(ctx, line, start, maxWidth);
        let next = end;
        if (end < line.length) {
            const brk = line.lastIndexOf(' ', end);
            if (brk > start) {
                end = brk;
                next = brk + 1; // GDI swallows the break space
            }
        }
        segs.push({ text: line.slice(start, end), start });
        start = next > start ? next : start + 1;
    }
    return segs;
}

/** DT_*_ELLIPSIS: shorten an over-wide line to fit, marking the cut with "...". */
function ellipsize(ctx: TextCtx, line: string, maxWidth: number, path: boolean): string {
    if (maxWidth <= 0 || ctx.measureText(line).width <= maxWidth) return line;
    const dots = '...';
    const dotsWidth = ctx.measureText(dots).width;
    const budget = maxWidth - dotsWidth;
    if (budget <= 0) return dots;
    if (!path) {
        const keep = fitPrefix(ctx, line, 0, budget);
        return line.slice(0, keep) + dots;
    }
    // DT_PATH_ELLIPSIS keeps the file name: cut from the middle of the path.
    let head = Math.max(0, fitPrefix(ctx, line, 0, budget / 2));
    let tail = line.length;
    while (tail > head && ctx.measureText(line.slice(0, head) + dots + line.slice(tail - 1)).width <= maxWidth) tail--;
    return line.slice(0, head) + dots + line.slice(tail);
}

/** Render one laid-out line through fillTextWithMnemonic, which owns the underline
 *  geometry. The access-key index is re-encoded as a '&' prefix string so there is
 *  no second copy of that logic. */
function drawLaidOutLine(
    ctx: TextCtx,
    line: LaidOutLine,
    x: number,
    y: number,
    opts: ReturnType<typeof drawTextPrefixOptions>,
): void {
    if (line.underline < 0 || !opts.drawUnderline) {
        fillTextWithMnemonic(ctx, line.text, x, y, { ...opts, processPrefix: false });
        return;
    }
    const esc = (s: string) => s.replace(/&/g, '&&');
    const encoded = esc(line.text.slice(0, line.underline)) + '&' + esc(line.text.slice(line.underline));
    fillTextWithMnemonic(ctx, encoded, x, y, opts);
}

/**
 * DrawText/DrawTextEx layout + render. Unlike TextOut this owns LINE BREAKING: GDI breaks
 * on CR/LF, wraps at word boundaries under DT_WORDBREAK, clips to the rectangle unless
 * DT_NOCLIP, and under DT_CALCRECT measures without drawing. Ignoring DT_WORDBREAK renders
 * a message as one over-wide line that the rect then clips at BOTH ends when it is centred,
 * which is how a dialog loses the head and the tail of its own error text.
 *
 * Returns null only for an unusable HDC; the layout it returns is what the API must report
 * (height, and the measured width DT_CALCRECT writes back into the caller's RECT).
 */
export function drawText(
    gdi: GDIContext,
    hdc: number,
    text: string,
    rect?: { left: number; top: number; right: number; bottom: number },
    format?: number,
): DrawTextLayout | null {
    const ctx = gdi.contexts.get(hdc) as TextCtx | undefined;
    const state = gdi.hdcStates.get(hdc);
    if (!ctx || !state) {
        Logger.warn(LogCategory.GDI32, `drawText: Invalid HDC 0x${hdc.toString(16)} or state`);
        return null;
    }

    const f = format ?? 0;
    const singleLine = (f & DT_SINGLELINE) !== 0;
    const calcOnly = (f & DT_CALCRECT) !== 0;
    const wordBreak = (f & DT_WORDBREAK) !== 0 && !singleLine;
    const prefixOptions = drawTextPrefixOptions(format);

    // Font must be applied before anything is measured.
    if (state.appliedFont !== state.font) {
        ctx.font = state.font;
        state.appliedFont = state.font;
    }

    // --- Layout -----------------------------------------------------------------
    let source = text ?? '';
    if ((f & (DT_EXPANDTABS | DT_TABSTOP)) !== 0) {
        // DT_TABSTOP puts the tab length in bits 15..8; default is 8 characters.
        const tabLen = (f & DT_TABSTOP) !== 0 ? (((f >> 8) & 0xff) || 8) : 8;
        source = source.replace(/\t/g, ' '.repeat(tabLen));
    }
    // GDI treats CR/LF as part of the line in DT_SINGLELINE mode; they render as nothing.
    const rawLines = singleLine ? [source.replace(/[\r\n]/g, '')] : source.split(/\r\n|[\r\n]/);

    const boxWidth = rect ? Math.max(0, rect.right - rect.left) : 0;
    const advance = lineAdvance(ctx, state.fontSize, (f & DT_EXTERNALLEADING) !== 0);
    const ellipsis = (f & (DT_END_ELLIPSIS | DT_WORD_ELLIPSIS | DT_PATH_ELLIPSIS)) !== 0;

    const lines: LaidOutLine[] = [];
    let maxWidth = 0;
    for (const raw of rawLines) {
        const parsed = parseMnemonicText(raw, prefixOptions.processPrefix ?? true);
        const segs = wordBreak && rect
            ? wrapLine(ctx, parsed.display, boxWidth)
            : [{ text: parsed.display, start: 0 }];
        for (const seg of segs) {
            let display = seg.text;
            if (ellipsis && rect && segs.length === 1) {
                display = ellipsize(ctx, display, boxWidth, (f & DT_PATH_ELLIPSIS) !== 0);
            }
            const underline = parsed.underlineIndex >= seg.start && parsed.underlineIndex < seg.start + seg.text.length
                ? parsed.underlineIndex - seg.start
                : -1;
            lines.push({ text: display, underline });
            maxWidth = Math.max(maxWidth, ctx.measureText(display).width);
        }
    }
    const layout: DrawTextLayout = { height: lines.length * advance, width: Math.ceil(maxWidth) };

    // DT_CALCRECT measures only — no pixels, no dirty marking.
    if (calcOnly) return layout;

    const isOverlay = ctx === gdi.overlayCtx;
    if (isOverlay) {
        gdi.setOverlayDirty(true);
    }
    if (state.appliedFillStyle !== state.textColor) {
        ctx.fillStyle = state.textColor;
        state.appliedFillStyle = state.textColor;
    }

    // --- Render -----------------------------------------------------------------
    // Horizontal origin per line; DT_VCENTER/DT_BOTTOM apply only to a single line
    // (Win32 ignores them for wrapped text, which always starts at the top).
    const originX = rect
        ? ((f & DT_CENTER) !== 0 ? rect.left + boxWidth / 2 : (f & DT_RIGHT) !== 0 ? rect.right : rect.left)
        : 0;
    const align: CanvasTextAlign = (f & DT_CENTER) !== 0 ? 'center' : (f & DT_RIGHT) !== 0 ? 'right' : 'left';
    let originY = rect ? rect.top : 0;
    if (rect && singleLine) {
        if ((f & DT_VCENTER) !== 0) originY = rect.top + (rect.bottom - rect.top - advance) / 2;
        else if ((f & DT_BOTTOM) !== 0) originY = rect.bottom - advance;
    }

    const paint = (target: TextCtx): void => {
        target.textBaseline = 'top';
        target.textAlign = align;
        // Clipped to the rect unless DT_NOCLIP — GDI never spills DrawText outside it.
        const clipped = !!rect && (f & DT_NOCLIP) === 0;
        if (clipped) {
            target.save();
            target.beginPath();
            target.rect(rect!.left, rect!.top, boxWidth, Math.max(0, rect!.bottom - rect!.top));
            target.clip();
        }
        // OPAQUE background covers the whole rect, matching what a control's erase does.
        if (state.bkMode === 2 && rect) {
            target.fillStyle = state.bkColor;
            target.fillRect(rect.left, rect.top, boxWidth, rect.bottom - rect.top);
            target.fillStyle = state.textColor;
        }
        for (let i = 0; i < lines.length; i++) {
            drawLaidOutLine(target, lines[i], originX, originY + i * advance, prefixOptions);
        }
        if (clipped) target.restore();
        target.textAlign = 'left';
        target.textBaseline = 'top';
    };

    paint(ctx);
    if (state.bkMode === 2) state.appliedFillStyle = state.textColor;

    // Mark as dirty for ReleaseDC optimization
    gdi.markDirty(hdc);

    // Invalidate image data cache after drawing
    gdi.invalidateImageDataCache(hdc);

    // If this is a memory DC with linked bitmap, update the bitmap canvas
    const linkedBitmap = (ctx.canvas as any).__bitmapCanvas;
    if (linkedBitmap) {
        const bitmapCtx = linkedBitmap.getContext('2d') as TextCtx | null;
        if (bitmapCtx) {
            bitmapCtx.font = state.font;
            bitmapCtx.fillStyle = state.textColor;
            paint(bitmapCtx);
        }
    }

    return layout;
}
