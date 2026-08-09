/**
 * Resolve a GDI/user BITMAP handle to RGBA pixels for overlay painting.
 * Tries: stored pixels → live DC canvas → CreateDIBSection bitsPtr.
 *
 * Every exported entry unwraps its `mem` once (toPlainGuestMemory): callers hand us
 * v86's always-live Proxy, and the DIBSection readers below index it per pixel, which
 * that Proxy's get-trap makes ~140x slower than a typed array. The readers are pure —
 * they only fill a freshly allocated host buffer — so no plain view outlives a guest
 * re-entry or a WASM growth here.
 */

import { System } from '../../core/system';
import { SystemResourceProvider } from '../../core/resources/system-resource-provider';
import { asArrayBufferView } from '../../../dom-buffer';
import { toPlainGuestMemory } from '../../core/memory/guest-memory';

export interface ResolvedBitmapRgba {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

/** Win32 static SS_BITMAP / SS_ICON image placement (user32 Static control). */
export type StaticImageLayoutMode = 'stretch' | 'center';

export interface StaticImageLayout {
    mode: StaticImageLayoutMode;
    /** Destination rect in canvas space. */
    x: number;
    y: number;
    w: number;
    h: number;
}

interface BitmapUserObj {
    type: string;
    width?: number;
    height?: number;
    pixels?: Uint8Array | Uint8ClampedArray | null;
    bitsPtr?: number;
    dibBpp?: number;
    dibStride?: number;
    dibTopDown?: boolean;
    dibPalette?: Uint32Array;
    isTopDown?: boolean;
    loading?: boolean;
    compatibleBitmap?: boolean;
    compatibleEmpty?: boolean;
}

/** True when the JS RGBA shadow was filled by LoadImage/parseBMP (not a CreateDIBSection placeholder). */
export function bitmapPixelsPopulated(obj: BitmapUserObj): boolean {
    const w = obj.width ?? 0;
    const h = obj.height ?? 0;
    const p = obj.pixels;
    if (!p || w <= 0 || h <= 0 || p.length < w * h * 4) return false;
    const sample = Math.min(p.length, 4096);
    for (let i = 0; i < sample; i++) {
        if (p[i] !== 0) return true;
    }
    return false;
}

export function bitmapHasPixelSource(obj: BitmapUserObj): boolean {
    return bitmapPixelsPopulated(obj) || !!(obj.bitsPtr && obj.dibStride);
}

function unwrapBitmapObj(hBitmap: number): BitmapUserObj | null {
    const rp = SystemResourceProvider.getInstance();
    const raw = rp.getUserObject(hBitmap) ?? rp.getGdiObject(hBitmap);
    if (!raw) return null;
    if (raw.type === 'BITMAP') return raw as BitmapUserObj;
    if (raw.data?.type === 'BITMAP') return raw.data as BitmapUserObj;
    return null;
}

function pixelsValid(obj: BitmapUserObj): boolean {
    return bitmapPixelsPopulated(obj);
}

/** Read 32bpp BGRA from guest DIBSection bits into RGBA.
 *  rawAlpha=false coerces the DIB reserved byte to opaque (normal painting);
 *  rawAlpha=true returns it as-is (XP+ alpha-cursor detection). */
function readDibSectionRgba(
    mem: Uint8Array,
    bitsPtr: number,
    w: number,
    h: number,
    dibStride: number,
    dibTopDown: boolean,
    rawAlpha = false,
): Uint8ClampedArray | null {
    if (!bitsPtr || w <= 0 || h <= 0 || dibStride <= 0) return null;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const srcY = dibTopDown ? y : (h - 1 - y);
        let srcOff = bitsPtr + srcY * dibStride;
        const dstOff = y * w * 4;
        for (let x = 0; x < w; x++) {
            const di = dstOff + x * 4;
            out[di] = mem[srcOff + 2];
            out[di + 1] = mem[srcOff + 1];
            out[di + 2] = mem[srcOff];
            out[di + 3] = rawAlpha ? mem[srcOff + 3] : (mem[srcOff + 3] || 255);
            srcOff += 4;
        }
    }
    return out;
}

/**
 * Read a sub-rect of a DIBSection's guest bits as RGBA (blit-source liveness:
 * the app writes bits directly, so blits must see the CURRENT bytes, but only
 * the blitted rect needs converting — full-bitmap reads per blit are wasted).
 * Returns null (with the clamped rect untouched) for non-DIBSection bitmaps.
 */
export function resolveDibSectionRectRgba(
    hBitmap: number,
    mem: Uint8Array,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
): { data: Uint8ClampedArray; x: number; y: number; width: number; height: number } | null {
    mem = toPlainGuestMemory(mem);
    const obj = unwrapBitmapObj(hBitmap);
    if (!obj || !obj.bitsPtr || !obj.dibStride) return null;
    const bw = obj.width ?? 0, bh = obj.height ?? 0;
    const x = Math.max(0, rx | 0), y = Math.max(0, ry | 0);
    const w = Math.min(rw | 0, bw - x), h = Math.min(rh | 0, bh - y);
    if (w <= 0 || h <= 0) return null;
    const bpp = obj.dibBpp ?? 32;
    const out = new Uint8ClampedArray(w * h * 4);
    const palette = obj.dibPalette;
    for (let row = 0; row < h; row++) {
        const srcY = obj.dibTopDown ? y + row : bh - 1 - (y + row);
        const srcRow = obj.bitsPtr + srcY * obj.dibStride;
        const dstOff = row * w * 4;
        if (bpp === 32) {
            let so = srcRow + x * 4;
            for (let c = 0; c < w; c++, so += 4) {
                const di = dstOff + c * 4;
                out[di] = mem[so + 2];
                out[di + 1] = mem[so + 1];
                out[di + 2] = mem[so];
                out[di + 3] = mem[so + 3] || 255;
            }
        } else if (bpp === 24) {
            let so = srcRow + x * 3;
            for (let c = 0; c < w; c++, so += 3) {
                const di = dstOff + c * 4;
                out[di] = mem[so + 2];
                out[di + 1] = mem[so + 1];
                out[di + 2] = mem[so];
                out[di + 3] = 255;
            }
        } else if (bpp === 16) {
            for (let c = 0; c < w; c++) {
                const v = mem[srcRow + (x + c) * 2] | (mem[srcRow + (x + c) * 2 + 1] << 8);
                const di = dstOff + c * 4;
                out[di] = ((v >> 11) & 0x1F) * 255 / 31;
                out[di + 1] = ((v >> 5) & 0x3F) * 255 / 63;
                out[di + 2] = (v & 0x1F) * 255 / 31;
                out[di + 3] = 255;
            }
        } else if (bpp === 8 && palette && palette.length > 0) {
            for (let c = 0; c < w; c++) {
                const color = palette[mem[srcRow + x + c]] ?? 0xff000000;
                const di = dstOff + c * 4;
                out[di] = (color >> 16) & 0xff;
                out[di + 1] = (color >> 8) & 0xff;
                out[di + 2] = color & 0xff;
                out[di + 3] = (color >>> 24) & 0xff;
            }
        } else {
            return null;
        }
    }
    return { data: out, x, y, width: w, height: h };
}

/**
 * A DIBSection's pixel surface IS its guest bits — every GDI draw into a DC with one
 * selected must land there, because apps read the bits back and post-process them, and
 * because the canvas is re-materialized FROM those bits on the next SelectObject (a
 * draw that never wrote back is discarded there). Mirrors the canvas rect into 32bpp
 * bits as B,G,R, preserving the reserved/alpha byte the app owns. No-op for anything
 * that is not a 32bpp DIBSection.
 */
export function writeBackDibSectionRect(
    hBitmap: number,
    ctx: OffscreenCanvasRenderingContext2D,
    x: number, y: number, width: number, height: number,
): void {
    if (!hBitmap) return;
    const obj = unwrapBitmapObj(hBitmap);
    if (!obj || !obj.bitsPtr || !obj.dibStride || (obj.dibBpp ?? 32) !== 32) return;
    // Per-pixel write-back below; getCurrentMemory() hands out v86's Proxy, whose
    // per-element trap V8 cannot JIT. Nothing here re-enters the guest, so the plain
    // view cannot go stale mid-call.
    const mem = toPlainGuestMemory(System.getInstance().process?.getCurrentMemory?.());
    if (!mem) return;
    const bw = obj.width ?? 0, bh = obj.height ?? 0;
    const cx = Math.max(0, x | 0), cy = Math.max(0, y | 0);
    const cw = Math.min(width | 0, bw - cx), ch = Math.min(height | 0, bh - cy);
    if (cw <= 0 || ch <= 0) return;
    // Raw writes below — validate the whole section range once (§3.1).
    if (obj.bitsPtr + obj.dibStride * bh > mem.length) return;
    let img: ImageData;
    try { img = ctx.getImageData(cx, cy, cw, ch); } catch { return; }
    const src = img.data;
    for (let ry = 0; ry < ch; ry++) {
        const dibY = obj.dibTopDown ? cy + ry : bh - 1 - (cy + ry);
        let o = obj.bitsPtr + dibY * obj.dibStride + cx * 4;
        let si = ry * cw * 4;
        for (let rx = 0; rx < cw; rx++, o += 4, si += 4) {
            mem[o] = src[si + 2];
            mem[o + 1] = src[si + 1];
            mem[o + 2] = src[si];
        }
    }
}

/**
 * Raw-alpha 32bpp DIBSection read for XP+ alpha-cursor detection: returns the
 * pixels honoring the alpha byte, or null when the bits carry no alpha at all
 * (or the bitmap is not a 32bpp DIBSection).
 */
export function resolveDib32RawAlphaRgba(
    hBitmap: number,
    mem: Uint8Array,
): { data: Uint8ClampedArray; width: number; height: number } | null {
    mem = toPlainGuestMemory(mem);
    const obj = unwrapBitmapObj(hBitmap);
    if (!obj || !obj.bitsPtr || !obj.dibStride || (obj.dibBpp ?? 0) !== 32) return null;
    const w = obj.width ?? 0, h = obj.height ?? 0;
    if (w <= 0 || h <= 0) return null;
    let hasAlpha = false;
    for (let y = 0; y < h && !hasAlpha; y++) {
        let o = obj.bitsPtr + y * obj.dibStride + 3;
        for (let x = 0; x < w; x++, o += 4) {
            if (mem[o] !== 0) { hasAlpha = true; break; }
        }
    }
    if (!hasAlpha) return null;
    const data = readDibSectionRgba(mem, obj.bitsPtr, w, h, obj.dibStride, !!obj.dibTopDown, true);
    return data ? { data, width: w, height: h } : null;
}

/** Read 4/8/16/24/32 bpp DIBSection row data into RGBA (best-effort). */
function readDibSectionRgbaGeneric(
    mem: Uint8Array,
    bitsPtr: number,
    w: number,
    h: number,
    dibStride: number,
    dibTopDown: boolean,
    dibBpp: number,
    palette?: Uint32Array,
): Uint8ClampedArray | null {
    if (dibBpp === 32) {
        return readDibSectionRgba(mem, bitsPtr, w, h, dibStride, dibTopDown);
    }
    if (!bitsPtr || w <= 0 || h <= 0) return null;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const srcY = dibTopDown ? y : (h - 1 - y);
        const srcRow = bitsPtr + srcY * dibStride;
        const dstOff = y * w * 4;
        if (dibBpp === 24) {
            for (let x = 0; x < w; x++) {
                const si = srcRow + x * 3;
                const di = dstOff + x * 4;
                out[di] = mem[si + 2];
                out[di + 1] = mem[si + 1];
                out[di + 2] = mem[si];
                out[di + 3] = 255;
            }
        } else if (dibBpp === 16) {
            for (let x = 0; x < w; x++) {
                const v = mem[srcRow + x * 2] | (mem[srcRow + x * 2 + 1] << 8);
                const di = dstOff + x * 4;
                out[di] = ((v >> 11) & 0x1F) * 255 / 31;
                out[di + 1] = ((v >> 5) & 0x3F) * 255 / 63;
                out[di + 2] = (v & 0x1F) * 255 / 31;
                out[di + 3] = 255;
            }
        } else if (dibBpp === 8 && palette && palette.length > 0) {
            for (let x = 0; x < w; x++) {
                const idx = mem[srcRow + x];
                const color = palette[idx] ?? 0xff000000;
                const di = dstOff + x * 4;
                out[di] = (color >> 16) & 0xff;
                out[di + 1] = (color >> 8) & 0xff;
                out[di + 2] = color & 0xff;
                out[di + 3] = (color >>> 24) & 0xff;
            }
        } else if (dibBpp === 4 && palette && palette.length > 0) {
            for (let x = 0; x < w; x++) {
                const byte = mem[srcRow + (x >> 1)];
                const idx = (x & 1) === 0 ? (byte >> 4) : (byte & 0x0f);
                const color = palette[idx] ?? 0xff000000;
                const di = dstOff + x * 4;
                out[di] = (color >> 16) & 0xff;
                out[di + 1] = (color >> 8) & 0xff;
                out[di + 2] = color & 0xff;
                out[di + 3] = (color >>> 24) & 0xff;
            }
        } else {
            return null;
        }
    }
    return out;
}

/**
 * Resolve bitmap handle to RGBA for painting.
 * @param mem Guest memory (required for DIBSection bitsPtr reads).
 */
export function resolveBitmapRgba(hBitmap: number, mem?: Uint8Array): ResolvedBitmapRgba | null {
    if (!hBitmap) return null;
    mem = toPlainGuestMemory(mem);

    const obj = unwrapBitmapObj(hBitmap);
    if (!obj) return null;

    const w = obj.width ?? 0;
    const h = obj.height ?? 0;
    if (w <= 0 || h <= 0) return null;

    if (mem && obj.bitsPtr && obj.dibStride && !pixelsValid(obj)) {
        const bpp = obj.dibBpp ?? 32;
        const rgba = readDibSectionRgbaGeneric(
            mem, obj.bitsPtr, w, h, obj.dibStride, !!obj.dibTopDown, bpp, obj.dibPalette,
        );
        if (rgba) return { data: rgba, width: w, height: h };
    }

    // DDB (CreateCompatibleBitmap): stored pixels are only a birth snapshot —
    // everything drawn since lives on the rendered canvas, which is the truth.
    if (obj.compatibleBitmap) {
        const rendered = System.getInstance().gdiContext.getBitmapRenderedPixels(hBitmap);
        if (rendered && rendered.length >= w * h * 4) {
            return { data: rendered.subarray(0, w * h * 4), width: w, height: h };
        }
    }

    if (pixelsValid(obj)) {
        const p = obj.pixels!;
        const clamped = p instanceof Uint8ClampedArray
            ? p.subarray(0, w * h * 4)
            : new Uint8ClampedArray(p.buffer, p.byteOffset, Math.min(p.byteLength, w * h * 4));
        if (clamped.length >= w * h * 4) {
            return { data: clamped.subarray(0, w * h * 4), width: w, height: h };
        }
    }

    const gdi = System.getInstance().gdiContext;
    const rendered = gdi.getBitmapRenderedPixels(hBitmap);
    if (rendered && rendered.length >= w * h * 4) {
        return { data: rendered.subarray(0, w * h * 4), width: w, height: h };
    }

    if (mem && obj.bitsPtr && obj.dibStride) {
        const bpp = obj.dibBpp ?? 32;
        const rgba = readDibSectionRgbaGeneric(
            mem, obj.bitsPtr, w, h, obj.dibStride, !!obj.dibTopDown, bpp, obj.dibPalette,
        );
        if (rgba) return { data: rgba, width: w, height: h };
    }

    return null;
}

/** Bitmap dimensions from a GDI/user BITMAP handle (no pixel read). */
export function getBitmapObjectDimensions(hBitmap: number): { width: number; height: number } | null {
    const obj = unwrapBitmapObj(hBitmap);
    if (!obj) return null;
    const width = obj.width ?? 0;
    const height = obj.height ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
}

/** Icon dimensions from a user ICON handle. */
export function getIconObjectDimensions(hIcon: number): { width: number; height: number } | null {
    const rp = SystemResourceProvider.getInstance();
    const raw = rp.getUserObject(hIcon) ?? rp.getGdiObject(hIcon);
    if (!raw || raw.type !== 'ICON') return null;
    const width = raw.width ?? 0;
    const height = raw.height ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Win32 Static control image layout for SS_BITMAP / SS_ICON.
 *
 * STM_SETIMAGE on SS_BITMAP (without SS_CENTERIMAGE) auto-sizes the control to the
 * bitmap first; paint then maps image 1:1 into that rect (stretch with equal dims).
 * With SS_CENTERIMAGE: control keeps template size; image drawn at natural size, centered.
 */
export function layoutStaticControlImage(
    destX: number,
    destY: number,
    destW: number,
    destH: number,
    imageW: number,
    imageH: number,
    style: number,
    SS_CENTERIMAGE: number,
): StaticImageLayout {
    if ((style & SS_CENTERIMAGE) !== 0) {
        return {
            mode: 'center',
            x: destX + Math.max(0, Math.floor((destW - imageW) / 2)),
            y: destY + Math.max(0, Math.floor((destH - imageH) / 2)),
            w: imageW,
            h: imageH,
        };
    }
    return {
        mode: 'stretch',
        x: destX,
        y: destY,
        w: destW,
        h: destH,
    };
}

/** @deprecated Use layoutStaticControlImage */
export function layoutBitmapDestRect(
    destX: number,
    destY: number,
    destW: number,
    destH: number,
    bmpW: number,
    bmpH: number,
    style: number,
    SS_CENTERIMAGE: number,
    _SS_REALSIZEIMAGE: number,
): { x: number; y: number; w: number; h: number; srcW: number; srcH: number } {
    const layout = layoutStaticControlImage(destX, destY, destW, destH, bmpW, bmpH, style, SS_CENTERIMAGE);
    if (layout.mode === 'stretch') {
        return { x: layout.x, y: layout.y, w: layout.w, h: layout.h, srcW: bmpW, srcH: bmpH };
    }
    return { x: layout.x, y: layout.y, w: layout.w, h: layout.h, srcW: bmpW, srcH: bmpH };
}

/**
 * Blit RGBA into an HDC per Win32 static control rules.
 *
 * The control rect is only half of what confines this image: output through a DC obeys
 * the DC's clip region too (a BeginPaint DC carries the window's update region), so the
 * blit is bracketed by it exactly like every other primitive — otherwise a control's
 * image repaints in full during a partial update and overwrites pixels outside it.
 */
export function blitStaticControlImage(
    hdc: number,
    ctx: OffscreenCanvasRenderingContext2D,
    data: Uint8ClampedArray,
    imageW: number,
    imageH: number,
    clipX: number,
    clipY: number,
    clipW: number,
    clipH: number,
    layout: StaticImageLayout,
): void {
    if (imageW <= 0 || imageH <= 0 || clipW <= 0 || clipH <= 0) return;

    const frame = new OffscreenCanvas(imageW, imageH);
    const frameCtx = frame.getContext('2d');
    if (!frameCtx) return;
    frameCtx.putImageData(new ImageData(asArrayBufferView(data), imageW, imageH), 0, 0);

    const dcClipped = System.getInstance().gdiContext.beginClipOn(hdc, ctx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, clipY, clipW, clipH);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;

    if (layout.mode === 'stretch') {
        ctx.drawImage(frame, 0, 0, imageW, imageH, layout.x, layout.y, layout.w, layout.h);
    } else {
        ctx.drawImage(frame, 0, 0, imageW, imageH, layout.x, layout.y, imageW, imageH);
    }
    ctx.restore();
    if (dcClipped) ctx.restore();
}

/** Resolve ICON user object to RGBA (same layout as bitmap). */
export function resolveIconRgba(hIcon: number): ResolvedBitmapRgba | null {
    if (!hIcon) return null;
    const rp = SystemResourceProvider.getInstance();
    const raw = rp.getUserObject(hIcon) ?? rp.getGdiObject(hIcon);
    if (!raw || raw.type !== 'ICON') return null;
    const w = raw.width ?? 0;
    const h = raw.height ?? 0;
    const p = raw.pixels as Uint8Array | undefined;
    if (w <= 0 || h <= 0 || !p || p.length < w * h * 4) return null;
    const clamped = new Uint8ClampedArray(p.buffer, p.byteOffset, w * h * 4);
    return { data: clamped, width: w, height: h };
}
