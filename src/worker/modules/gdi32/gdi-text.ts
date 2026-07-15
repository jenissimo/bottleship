/**
 * GDI text rendering — TextOut/DrawText canvas paths (escapement rotation,
 * OPAQUE background fills, DT_* alignment, linked-bitmap mirroring). Each
 * function takes the owning GDIContext as `gdi` and reads/writes its DC state.
 * Font/state selection stays in context.ts (SelectObject); this module only
 * renders with the already-selected state.
 */
import { Logger, LogCategory } from "../../core/logger";
import { drawTextPrefixOptions, fillTextWithMnemonic } from "../win32-text";
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

export function drawText(gdi: GDIContext, hdc: number, text: string, rect?: { left: number; top: number; right: number; bottom: number }, format?: number): boolean {
    if (!text) return false;
    const ctx = gdi.contexts.get(hdc);
    const state = gdi.hdcStates.get(hdc);
    if (!ctx || !state) {
        Logger.warn(LogCategory.GDI32, `drawText: Invalid HDC 0x${hdc.toString(16)} or state`);
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

    // Only draw background if OPAQUE mode (bkMode=2) and rect provided
    // TRANSPARENT = 1, OPAQUE = 2
    if (state.bkMode === 2 && rect) {
        ctx.fillStyle = state.bkColor;
        state.appliedFillStyle = state.bkColor;
        ctx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);

        // Restore text color
        ctx.fillStyle = state.textColor;
        state.appliedFillStyle = state.textColor;
    }

    ctx.textBaseline = 'top';

    // DrawText format flags
    const DT_CENTER = 0x01;
    const DT_RIGHT = 0x02;
    const DT_VCENTER = 0x04;
    const DT_BOTTOM = 0x08;
    const prefixOptions = drawTextPrefixOptions(format);

    let x = rect ? rect.left : 0;
    let y = rect ? rect.top : 0;

    // Handle horizontal alignment
    if (rect && format !== undefined) {
        if (format & DT_CENTER) {
            ctx.textAlign = 'center';
            x = rect.left + (rect.right - rect.left) / 2;
        } else if (format & DT_RIGHT) {
            ctx.textAlign = 'right';
            x = rect.right;
        } else {
            ctx.textAlign = 'left';
        }

        // Handle vertical alignment
        if (format & DT_VCENTER) {
            ctx.textBaseline = 'middle';
            y = rect.top + (rect.bottom - rect.top) / 2;
        } else if (format & DT_BOTTOM) {
            ctx.textBaseline = 'bottom';
            y = rect.bottom;
        }
    }

    fillTextWithMnemonic(ctx, text, x, y, prefixOptions);

    // Reset alignment
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // Mark as dirty for ReleaseDC optimization
    gdi.markDirty(hdc);

    // Invalidate image data cache after drawing
    gdi.invalidateImageDataCache(hdc);

    // If this is a memory DC with linked bitmap, update the bitmap canvas
    const linkedBitmap = (ctx.canvas as any).__bitmapCanvas;
    if (linkedBitmap) {
        const bitmapCtx = linkedBitmap.getContext('2d');
        if (bitmapCtx) {
            // Apply same settings and draw
            if (state.appliedFont !== state.font) {
                bitmapCtx.font = state.font;
            }
            if (state.appliedFillStyle !== state.textColor) {
                bitmapCtx.fillStyle = state.textColor;
            }
            bitmapCtx.textBaseline = 'top';
            bitmapCtx.textAlign = 'left';

            if (rect && format !== undefined) {
                if (format & DT_CENTER) {
                    bitmapCtx.textAlign = 'center';
                } else if (format & DT_RIGHT) {
                    bitmapCtx.textAlign = 'right';
                }
                if (format & DT_VCENTER) {
                    bitmapCtx.textBaseline = 'middle';
                } else if (format & DT_BOTTOM) {
                    bitmapCtx.textBaseline = 'bottom';
                }
            }

            if (state.bkMode === 2 && rect) {
                bitmapCtx.fillStyle = state.bkColor;
                bitmapCtx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
                bitmapCtx.fillStyle = state.textColor;
            }

            fillTextWithMnemonic(bitmapCtx, text, x, y, prefixOptions);
            bitmapCtx.textAlign = 'left';
            bitmapCtx.textBaseline = 'top';
        }
    }

    return true;
}
