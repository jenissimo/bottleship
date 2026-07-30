
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { registerPaintingDcStateExports } from './painting-dc-state';
import { registerPaintingMiscExports } from './painting-misc';
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import { Logger, LogCategory } from '../../core/logger';
import { profiler } from '../../core/profiler';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { SystemResourceProvider } from '../../core/resources/system-resource-provider';
import { toPlainGuestMemory } from '../../core/memory/guest-memory';
import { LOGPEN_OFFSETS, LOGPEN_SIZE } from './gdi-objects';
// Track GetPixel HDC usage for profiling
const getPixelHdcStats = new Map<number, { count: number; maxX: number; maxY: number }>();

// Store last GetDIBits output buffer address for texture loading workaround
let lastGetDIBitsBuffer: { address: number; width: number; height: number } | null = null;
let dibSectionSyncDiagCount = 0;
const pixelFormatByHdc = new Map<number, number>();

export function getLastGetDIBitsBuffer(): { address: number; width: number; height: number } | null {
    return lastGetDIBitsBuffer;
}

/** Allocation guard for a DIB claimed by guest-supplied header fields (~64 Mpx). */
const MAX_DIB_PIXELS = 1 << 26;

/** Optional scan-line window for SetDIBitsToDevice / StretchDIBits partial DIB copies. */
interface DibScanRange {
    uStartScan?: number;
    scanLines?: number;
}

/** DEBUG: encode a top-down RGBA buffer to PNG and post it to the main thread, which writes
 *  it to logs/debug/<name>.png. Used to SEE the actual bitmaps HL blends for owner-draw. */
function dumpRgbaToPng(name: string, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): void {
    try {
        if (w <= 0 || h <= 0 || rgba.length < w * h * 4) return;
        const cv = new OffscreenCanvas(w, h);
        const c = cv.getContext('2d');
        if (!c) return;
        c.putImageData(new ImageData(new Uint8ClampedArray(rgba.slice(0, w * h * 4)), w, h), 0, 0);
        cv.convertToBlob({ type: 'image/png' }).then(b => b.arrayBuffer()).then(ab => {
            const bytes = new Uint8Array(ab);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            (self as any).postMessage({ type: 'debug_png_dump', name, base64: btoa(bin) });
        }).catch(() => {});
    } catch { /* ignore */ }
}

/**
 * Decode a BI_RLE8 / BI_RLE4 compressed DIB pixel stream into a flat 8bpp
 * palette-index buffer of size absW*absH. Scanlines are stored bottom-up
 * (row 0 = bottom scanline), matching the on-disk DIB scanline convention, so
 * callers treat the result exactly like an uncompressed 8bpp DIB with
 * stride = absW. RLE DIBs are always bottom-up per the Win32 spec.
 *
 * Faithful to the documented RLE opcode grammar:
 *   [cnt>0][val]  encoded run of `cnt` pixels (RLE8: index `val`; RLE4: the two
 *                 nibbles of `val` alternating hi,lo).
 *   [0][0]        end of line   (advance to next scanline, x=0)
 *   [0][1]        end of bitmap
 *   [0][2][dx][dy] delta        (offset current position by dx,dy)
 *   [0][n>=3]     absolute run of `n` literal pixels; run is padded to a 16-bit
 *                 word boundary (RLE8: n bytes; RLE4: ceil(n/2) bytes).
 */
function decodeDibRle(
    mem: Uint8Array, dataOff: number, absW: number, absH: number, is4bit: boolean,
): Uint8Array {
    const out = new Uint8Array(absW * absH); // zero-filled → palette index 0
    const end = mem.length;
    let p = dataOff;
    let x = 0;
    let y = 0; // scanline from bottom (0 = bottom)

    const put = (idx: number): void => {
        if (x >= 0 && x < absW && y >= 0 && y < absH) out[y * absW + x] = idx;
        x++;
    };

    while (p + 1 < end && y < absH) {
        const cnt = mem[p++];
        const val = mem[p++];
        if (cnt > 0) {
            // Encoded mode
            if (!is4bit) {
                for (let i = 0; i < cnt; i++) put(val);
            } else {
                const hi = (val >> 4) & 0x0F;
                const lo = val & 0x0F;
                for (let i = 0; i < cnt; i++) put((i & 1) === 0 ? hi : lo);
            }
        } else if (val === 0) {        // end of line
            x = 0; y++;
        } else if (val === 1) {        // end of bitmap
            break;
        } else if (val === 2) {        // delta
            const dx = mem[p++] | 0;
            const dy = mem[p++] | 0;
            x += dx; y += dy;
        } else {                        // absolute mode: `val` literal pixels
            if (!is4bit) {
                for (let i = 0; i < val; i++) put(mem[p++]);
                if (val & 1) p++;       // pad to 16-bit word boundary
            } else {
                for (let i = 0; i < val; i++) {
                    const b = mem[p + (i >> 1)];
                    put((i & 1) === 0 ? ((b >> 4) & 0x0F) : (b & 0x0F));
                }
                const bytes = (val + 1) >> 1;
                p += bytes;
                if (bytes & 1) p++;     // pad to 16-bit word boundary
            }
        }
    }
    return out;
}

/**
 * Parse a DIB (BITMAPINFOHEADER + palette + pixels) from guest memory
 * and draw it onto a DC's canvas.
 */
function dibToCanvas(
    hdc: number, mem: Uint8Array, lpBmi: number, lpBits: number,
    xDest: number, yDest: number, wDest: number, hDest: number,
    xSrc: number, ySrc: number, wSrc: number, hSrc: number,
    scan?: DibScanRange,
): boolean {
    if (!lpBmi || !lpBits) return false;

    // Leaf hot loop: the per-pixel DIB→RGBA conversion below indexes guest memory a
    // million times per blit, and the dispatcher hands us v86's always-live Proxy
    // (which it must keep — see ThunkDispatcher.updateMemoryCache). Every `mem[i]`
    // through that Proxy is a trap V8 cannot JIT. Nothing here re-enters the guest,
    // so a plain view cannot go stale mid-call.
    mem = toPlainGuestMemory(mem);

    const gdi = System.getInstance().gdiContext;
    const dcCtx = (gdi as any).contexts?.get(hdc) as OffscreenCanvasRenderingContext2D | undefined;
    if (!dcCtx) {
        Logger.warn(LogCategory.GDI32, `dibToCanvas: Invalid HDC 0x${hdc.toString(16)}`);
        return false;
    }

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // Parse BITMAPINFOHEADER
    const biSize = view.getUint32(lpBmi, true);
    const biWidth = view.getInt32(lpBmi + 4, true);
    const biHeight = view.getInt32(lpBmi + 8, true);
    const biBitCount = view.getUint16(lpBmi + 14, true);
    const biCompression = view.getUint32(lpBmi + 16, true);
    const biClrUsed = view.getUint32(lpBmi + 32, true);

    // Absolute height, and whether top-down
    const isTopDown = biHeight < 0;
    const absHeight = isTopDown ? -biHeight : biHeight;
    const absWidth = biWidth > 0 ? biWidth : -biWidth;

    // Only reject what cannot be a DIB. A DIB is not bounded by any screen dimension —
    // a tall single-column strip atlas (button tiles stacked vertically) is perfectly
    // legal, and the scanline window drawn below is clamped to `scan` and bounds-checked
    // against guest memory, so the sole remaining hazard is an absurd allocation. That
    // is what the pixel-count cap covers; a resolution-shaped cap instead silently drops
    // a legal blit, and the guest sees a black tile it drew nothing into.
    if (absWidth <= 0 || absHeight <= 0
        || absWidth > 0xFFFF || absHeight > 0xFFFF
        || absWidth * absHeight > MAX_DIB_PIXELS) {
        Logger.warn(LogCategory.GDI32, `dibToCanvas: Invalid DIB dimensions ${absWidth}x${absHeight}`);
        return false;
    }

    // BI_RGB = 0, BI_BITFIELDS = 3, BI_RLE8 = 1 (8bpp), BI_RLE4 = 2 (4bpp)
    const isRle = (biCompression === 1 && biBitCount === 8) ||
                  (biCompression === 2 && biBitCount === 4);
    if (biCompression !== 0 && biCompression !== 3 && !isRle) {
        Logger.warn(LogCategory.GDI32, `dibToCanvas: Unsupported compression ${biCompression}`);
        return false;
    }

    // Read palette for <= 8bpp
    let palette: Uint8Array | null = null;
    if (biBitCount <= 8) {
        const paletteColors = biClrUsed || (1 << biBitCount);
        palette = new Uint8Array(paletteColors * 4);
        const palOffset = lpBmi + biSize;
        for (let i = 0; i < paletteColors; i++) {
            const off = palOffset + i * 4;
            palette[i * 4 + 0] = mem[off + 2]; // R (DIB stores BGR)
            palette[i * 4 + 1] = mem[off + 1]; // G
            palette[i * 4 + 2] = mem[off + 0]; // B
            palette[i * 4 + 3] = 255;          // A
        }
    }

    // For RLE, decompress the whole bitmap up front into a bottom-up 8bpp index
    // buffer (stride = absWidth); the per-row loop then reads it like an
    // uncompressed 8bpp DIB. RLE streams have no fixed row stride, so the
    // stride-based bounds check below is skipped for them.
    const rleIndices = isRle && palette
        ? decodeDibRle(mem, lpBits, absWidth, absHeight, biCompression === 2)
        : null;

    // Convert source DIB pixels to RGBA (honor uStartScan / scanLines for tile strips).
    const rowStride = rleIndices ? absWidth : Math.floor((absWidth * biBitCount + 31) / 32) * 4;
    const uStartScan = Math.max(0, scan?.uStartScan ?? (ySrc > 0 ? ySrc : 0));
    let drawHeight = scan?.scanLines ?? (hSrc > 0 ? hSrc : absHeight);
    if (uStartScan >= absHeight) {
        Logger.warn(LogCategory.GDI32, `dibToCanvas: uStartScan=${uStartScan} >= DIB height ${absHeight}`);
        return false;
    }
    drawHeight = Math.min(drawHeight, absHeight - uStartScan);
    if (drawHeight <= 0) {
        Logger.warn(LogCategory.GDI32, `dibToCanvas: no scan lines to draw (uStartScan=${uStartScan}, scanLines=${scan?.scanLines ?? hSrc})`);
        return false;
    }
    if (!rleIndices) {
        const requiredEnd = lpBits + rowStride * (uStartScan + drawHeight);
        if (requiredEnd > mem.length) {
            Logger.warn(LogCategory.GDI32, `dibToCanvas: lpBits 0x${lpBits.toString(16)} + scan ${uStartScan}+${drawHeight} exceeds guest memory (${mem.length})`);
            return false;
        }
    }
    const rgbaData = new Uint8Array(absWidth * drawHeight * 4);

    for (let row = 0; row < drawHeight; row++) {
        // Map output row (top-down ImageData) to DIB scan line index.
        const srcRow = isTopDown
            ? (uStartScan + row)
            : (uStartScan + (drawHeight - 1 - row));
        const srcOffset = lpBits + srcRow * rowStride;
        const dstOffset = row * absWidth * 4;

        if (rleIndices && palette) {
            const s = srcRow * absWidth;
            for (let x = 0; x < absWidth; x++) {
                const pi = rleIndices[s + x] * 4;
                const di = dstOffset + x * 4;
                rgbaData[di] = palette[pi];
                rgbaData[di + 1] = palette[pi + 1];
                rgbaData[di + 2] = palette[pi + 2];
                rgbaData[di + 3] = 255;
            }
        } else if (biBitCount === 8 && palette) {
            for (let x = 0; x < absWidth; x++) {
                const idx = mem[srcOffset + x];
                const pi = idx * 4;
                const di = dstOffset + x * 4;
                rgbaData[di] = palette[pi];
                rgbaData[di + 1] = palette[pi + 1];
                rgbaData[di + 2] = palette[pi + 2];
                rgbaData[di + 3] = 255;
            }
        } else if (biBitCount === 4 && palette) {
            for (let x = 0; x < absWidth; x++) {
                const byteVal = mem[srcOffset + (x >> 1)];
                const idx = (x & 1) === 0 ? (byteVal >> 4) : (byteVal & 0x0F);
                const pi = idx * 4;
                const di = dstOffset + x * 4;
                rgbaData[di] = palette[pi];
                rgbaData[di + 1] = palette[pi + 1];
                rgbaData[di + 2] = palette[pi + 2];
                rgbaData[di + 3] = 255;
            }
        } else if (biBitCount === 24) {
            for (let x = 0; x < absWidth; x++) {
                const si = srcOffset + x * 3;
                const di = dstOffset + x * 4;
                rgbaData[di] = mem[si + 2];     // R
                rgbaData[di + 1] = mem[si + 1]; // G
                rgbaData[di + 2] = mem[si];     // B
                rgbaData[di + 3] = 255;
            }
        } else if (biBitCount === 32) {
            // Fast path: Uint32Array BGRA→RGBA swizzle when 4-byte aligned
            if ((srcOffset & 3) === 0 && (dstOffset & 3) === 0) {
                const src32 = new Uint32Array(mem.buffer, mem.byteOffset + srcOffset, absWidth);
                const dst32 = new Uint32Array(rgbaData.buffer, dstOffset, absWidth);
                if (biCompression === 0) {
                    // BI_RGB: BGRX→RGBA with forced alpha=0xFF
                    for (let x = 0; x < absWidth; x++) {
                        const p = src32[x];
                        dst32[x] = ((p & 0xFF) << 16) | (p & 0xFF00) | ((p >> 16) & 0xFF) | 0xFF000000;
                    }
                } else {
                    // BI_BITFIELDS: BGRA→RGBA preserving alpha
                    for (let x = 0; x < absWidth; x++) {
                        const p = src32[x];
                        dst32[x] = ((p & 0xFF) << 16) | (p & 0xFF00FF00) | ((p >> 16) & 0xFF);
                    }
                }
            } else {
                for (let x = 0; x < absWidth; x++) {
                    const si = srcOffset + x * 4;
                    const di = dstOffset + x * 4;
                    rgbaData[di] = mem[si + 2];
                    rgbaData[di + 1] = mem[si + 1];
                    rgbaData[di + 2] = mem[si];
                    rgbaData[di + 3] = biCompression === 0 ? 255 : mem[si + 3];
                }
            }
        } else if (biBitCount === 1 && palette) {
            for (let x = 0; x < absWidth; x++) {
                const byteVal = mem[srcOffset + (x >> 3)];
                const bit = (byteVal >> (7 - (x & 7))) & 1;
                const pi = bit * 4;
                const di = dstOffset + x * 4;
                rgbaData[di] = palette[pi];
                rgbaData[di + 1] = palette[pi + 1];
                rgbaData[di + 2] = palette[pi + 2];
                rgbaData[di + 3] = 255;
            }
        } else {
            Logger.warn(LogCategory.GDI32, `dibToCanvas: Unsupported bpp=${biBitCount}`);
            return false;
        }
    }

    // Create ImageData from the selected scan-line window
    const imgData = new ImageData(new Uint8ClampedArray(rgbaData.buffer), absWidth, drawHeight);

    // If source and dest sizes match and no offset, use putImageData directly
    const srcW = wSrc > 0 ? wSrc : absWidth;
    const srcH = hSrc > 0 ? hSrc : drawHeight;
    if (srcW === wDest && srcH === hDest && xSrc === 0 && (ySrc === 0 || ySrc === uStartScan)) {
        dcCtx.putImageData(imgData, xDest, yDest, 0, 0, wDest, hDest);
    } else {
        // Need stretching: draw via temporary canvas
        const tmpCanvas = new OffscreenCanvas(absWidth, drawHeight);
        const tmpCtx = tmpCanvas.getContext('2d')!;
        tmpCtx.putImageData(imgData, 0, 0);
        dcCtx.drawImage(tmpCanvas, xSrc, 0, srcW, drawHeight, xDest, yDest, wDest, hDest);
    }

    // Keep the DC's selected-bitmap backing canvas in sync, mirroring the writeback
    // bitBlt already does (context.ts ~line 1219). GetDIBits on a compatible bitmap
    // reads that backing canvas via getBitmapRenderedPixels — without this writeback,
    // pixels drawn through SetDIBitsToDevice/StretchDIBits land only on the DC canvas
    // and the bitmap canvas stays at its creation-time fill (black). That made HL's
    // owner-draw blend read a black "background" (the splash it had just blitted into
    // its per-button DC via SetDIBitsToDevice) and composite opaque black buttons.
    const linkedBitmapCanvas = (dcCtx.canvas as { __bitmapCanvas?: OffscreenCanvas }).__bitmapCanvas;
    if (linkedBitmapCanvas) {
        const bmCtx = linkedBitmapCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
        if (bmCtx) {
            const cw = wDest > 0 ? wDest : absWidth;
            const ch = hDest > 0 ? hDest : drawHeight;
            try {
                bmCtx.drawImage(dcCtx.canvas, xDest, yDest, cw, ch, xDest, yDest, cw, ch);
            } catch { /* ignore writeback failures */ }
        }
    }

    // Mark DC state dirty (StretchDIBits / SetDIBitsToDevice drew real pixels).
    gdi.markDirty(hdc);
    const state = (gdi as any).hdcStates?.get(hdc);
    const overlayCanvas = gdi.getOverlayCanvas?.();
    if (overlayCanvas && dcCtx.canvas === overlayCanvas) {
        gdi.setOverlayDirty(true);
    }

    Logger.verbose(LogCategory.GDI32,
        `dibToCanvas: Drew ${absWidth}x${drawHeight}@${uStartScan}/${absHeight} ${biBitCount}bpp DIB to DC 0x${hdc.toString(16)} at (${xDest},${yDest})`);

    // If this HDC has a DIBSection selected, keep ppvBits memory in sync.
    // Some engines upload textures directly from CreateDIBSection bits instead of blitting the HDC.
    const linkedBitmap = ((dcCtx.canvas as any).__linkedBitmap as number | undefined) ||
        ((state as any)?.hBitmap as number | undefined);
    if (linkedBitmap && linkedBitmap !== 0x80000009) {
        const userObj = SystemResourceProvider.getInstance().getUserObject(linkedBitmap) as any;
        const bitsPtr = userObj?.bitsPtr as number | undefined;
        const dibBpp = userObj?.dibBpp as number | undefined;
        const dibStride = userObj?.dibStride as number | undefined;
        const dibTopDown = !!userObj?.dibTopDown;
        const w = userObj?.width as number | undefined;
        const h = userObj?.height as number | undefined;

        if (bitsPtr && dibBpp === 32 && dibStride && w && h && w > 0 && h > 0) {
            // Sync from decoded RGBA buffer directly (faster and avoids canvas readback path).
            const srcW = absWidth;
            const srcH = drawHeight;
            const copyW = Math.min(w, srcW);
            const copyH = Math.min(h, srcH);
            // Fast path: matching dimensions, stride=w*4, 4-byte aligned
            const canFast32 = dibStride === w * 4 && copyW === w && copyW === srcW &&
                (bitsPtr & 3) === 0;
            if (canFast32) {
                const dst32 = new Uint32Array(mem.buffer, mem.byteOffset + bitsPtr, w * h);
                const src32 = new Uint32Array(rgbaData.buffer, 0, srcW * srcH);
                for (let y = 0; y < copyH; y++) {
                    const srcRowBase = y * srcW;
                    const dstY = dibTopDown ? y : (h - 1 - y);
                    const dstRowBase = dstY * w;
                    for (let x = 0; x < copyW; x++) {
                        const p = src32[srcRowBase + x];
                        // RGBA → BGRA: swap R and B
                        dst32[dstRowBase + x] = ((p & 0xFF) << 16) | (p & 0xFF00FF00) | ((p >> 16) & 0xFF);
                    }
                }
                // Zero-fill remaining rows if h > copyH
                for (let y = copyH; y < h; y++) {
                    const dstY = dibTopDown ? y : (h - 1 - y);
                    const dstRowBase = dstY * w;
                    for (let x = 0; x < w; x++) dst32[dstRowBase + x] = 0xFF000000;
                }
            } else {
                for (let y = 0; y < h; y++) {
                    const srcY = y < copyH ? y : -1;
                    const dstY = dibTopDown ? y : (h - 1 - y);
                    let dstOff = bitsPtr + dstY * dibStride;
                    for (let x = 0; x < w; x++) {
                        if (srcY >= 0 && x < copyW) {
                            const srcOff = (srcY * srcW + x) * 4;
                            // RGBA -> BGRA
                            mem[dstOff] = rgbaData[srcOff + 2];
                            mem[dstOff + 1] = rgbaData[srcOff + 1];
                            mem[dstOff + 2] = rgbaData[srcOff];
                            mem[dstOff + 3] = rgbaData[srcOff + 3];
                        } else {
                            mem[dstOff] = 0;
                            mem[dstOff + 1] = 0;
                            mem[dstOff + 2] = 0;
                            mem[dstOff + 3] = 255;
                        }
                        dstOff += 4;
                    }
                }
            }
            if (dibSectionSyncDiagCount < 3) {
                const b = mem[bitsPtr];
                const gch = mem[bitsPtr + 1];
                const r = mem[bitsPtr + 2];
                const a = mem[bitsPtr + 3];
                const cX = Math.max(0, (w >> 1) - 1);
                const cY = Math.max(0, (h >> 1) - 1);
                const cOff = bitsPtr + (dibTopDown ? cY : (h - 1 - cY)) * dibStride + cX * 4;
                const cb = mem[cOff];
                const cg = mem[cOff + 1];
                const cr = mem[cOff + 2];
                const ca = mem[cOff + 3];
                Logger.log(
                    LogCategory.GDI32,
                    `dibToCanvas: DIBSection sync hbm=0x${linkedBitmap.toString(16)} bits=0x${bitsPtr.toString(16)} ` +
                    `sampleBGRA=[${b},${gch},${r},${a}] center=[${cb},${cg},${cr},${ca}] copy=${copyW}x${copyH}`
                );
                dibSectionSyncDiagCount++;
            }
        }
    }

    return true;
}

/**
 * Populate a TEXTMETRICA structure in guest memory using actual Canvas TextMetrics
 * from the current font selected into the given HDC.
 *
 * TEXTMETRICA layout (offsets in bytes):
 *   +0  tmHeight            +4  tmAscent         +8  tmDescent
 *   +12 tmInternalLeading   +16 tmExternalLeading
 *   +20 tmAveCharWidth      +24 tmMaxCharWidth    +28 tmWeight
 *   +32 tmOverhang          +36 tmDigitizedAspectX +40 tmDigitizedAspectY
 *   +44 tmFirstChar (byte)  +45 tmLastChar        +46 tmDefaultChar  +47 tmBreakChar
 *   +48 tmItalic (byte)     +49 tmUnderlined      +50 tmStruckOut
 *   +51 tmPitchAndFamily    +52 tmCharSet
 */
/**
 * Measure text extent using the DC's current font, writing SIZE struct (cx, cy)
 */
function measureTextExtent(hdc: number, text: string, lpSize: number, mem: Uint8Array): void {
    const gdi = System.getInstance().gdiContext;
    const dcCtx = gdi.getMeasureContext(hdc);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    let cx = text.length * 8; // fallback: 8px per char
    let cy = 16;              // fallback: 16px height

    if (dcCtx) {
        try {
            const metrics = dcCtx.measureText(text);
            cx = Math.round(metrics.width);
            if (metrics.fontBoundingBoxAscent !== undefined) {
                cy = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
            }
        } catch (_) {
            // keep defaults
        }
    }

    view.setInt32(lpSize, cx, true);     // SIZE.cx
    view.setInt32(lpSize + 4, cy, true); // SIZE.cy
}

function writeTextMetrics(hdc: number, lptm: number, mem: Uint8Array): void {
    const gdi = System.getInstance().gdiContext;
    const dcCtx = gdi.getMeasureContext(hdc);

    // Defaults (fallback when no DC / measureText unavailable)
    let ascent = 13;
    let descent = 3;
    let aveWidth = 8;
    let maxWidth = 12;

    if (dcCtx) {
        try {
            const m = dcCtx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
            if (m.fontBoundingBoxAscent !== undefined) {
                ascent   = Math.ceil(m.fontBoundingBoxAscent);
                descent  = Math.ceil(m.fontBoundingBoxDescent);
            }
            aveWidth = Math.round(dcCtx.measureText('x').width);
            maxWidth = Math.round(dcCtx.measureText('W').width);
        } catch (_) {
            // keep defaults
        }
    }

    const height = ascent + descent;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    view.setInt32(lptm,      height,  true); // tmHeight
    view.setInt32(lptm +  4, ascent,  true); // tmAscent
    view.setInt32(lptm +  8, descent, true); // tmDescent
    view.setInt32(lptm + 12, 0,       true); // tmInternalLeading
    view.setInt32(lptm + 16, Math.round(ascent * 0.15), true); // tmExternalLeading
    view.setInt32(lptm + 20, aveWidth, true); // tmAveCharWidth
    view.setInt32(lptm + 24, maxWidth, true); // tmMaxCharWidth
    view.setInt32(lptm + 28, 400,      true); // tmWeight (FW_NORMAL)
    view.setInt32(lptm + 32, 0,        true); // tmOverhang
    view.setInt32(lptm + 36, 96,       true); // tmDigitizedAspectX (96 dpi)
    view.setInt32(lptm + 40, 96,       true); // tmDigitizedAspectY (96 dpi)
    view.setUint8(lptm + 44, 0x20);           // tmFirstChar (space)
    view.setUint8(lptm + 45, 0xFF);           // tmLastChar
    view.setUint8(lptm + 46, 0x20);           // tmDefaultChar
    view.setUint8(lptm + 47, 0x20);           // tmBreakChar (space)
    view.setUint8(lptm + 48, 0);              // tmItalic
    view.setUint8(lptm + 49, 0);              // tmUnderlined
    view.setUint8(lptm + 50, 0);              // tmStruckOut
    view.setUint8(lptm + 51, 0x22);           // tmPitchAndFamily: VARIABLE_PITCH | FF_SWISS
    view.setUint8(lptm + 52, 0);              // tmCharSet: ANSI_CHARSET
}

export function createPaintingExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['GetStockObject'] = (ctx, mem, args): number => {
        const objectId = args[0];
        return 0x80000000 | objectId;
    };

    exports['GdiSetBatchLimit'] = (ctx, mem, args): number => {
        const limit = args[0];
        void limit;
        return 0; // Stub: no batching, return previous limit (0)
    };

    // GetDeviceCaps(HDC hdc, int index) – return capability; common indices from wingdi.h
    const DEVICE_CAPS_STATIC: Record<number, number> = {
        0: 0x0600,           // DRIVERVERSION
        2: 0,                 // TECHNOLOGY = DT_RASDISPLAY
        14: 1,                // PLANES
        16: 16,               // NUMBRUSHES
        18: 3,                // NUMPENS
        20: 0,                // NUMMARKERS
        22: 0,                // NUMFONTS
        24: 0,                // NUMCOLORS
        26: 0,                // PDEVICESIZE
        28: 0,                // CURVECAPS
        30: 0,                // LINECAPS
        32: 0,                // POLYGONALCAPS
        34: 0,                // TEXTCAPS
        36: 0,                // CLIPCAPS
        38: 0x7E99,           // RASTERCAPS = RC_BITBLT|RC_BITMAP64|RC_GDI20_OUTPUT|RC_DI_BITMAP|RC_DIBTODEV|RC_PALETTE|RC_STRETCHBLT|RC_STRETCHDIB|RC_OP_DX_OUTPUT
        40: 0,                // ASPECTX
        42: 0,                // ASPECTY
        44: 0,                // ASPECTXY
        48: 0,                // SIZEPALETTE
        88: 96,               // LOGPIXELSX
        90: 96,               // LOGPIXELSY
        104: 0,               // PHYSICALWIDTH
        106: 0,               // PHYSICALHEIGHT
    };
    exports['GetDeviceCaps'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const index = args[1];
        void hdc;
        let result: number;
        const screenRes = EmulatorConfig.getInstance().screenResolution;
        if (index === 8) result = screenRes.width;           // HORZRES
        else if (index === 10) result = screenRes.height;    // VERTRES
        else if (index === 12 || index === 116) result = screenRes.bpp; // BITSPIXEL
        else result = DEVICE_CAPS_STATIC[index] ?? 0;
        Logger.log(LogCategory.GDI32, `GetDeviceCaps(hdc=0x${hdc.toString(16)}, index=${index}) -> ${result}`);
        return result;
    };

    // int ChoosePixelFormat(HDC hdc, const PIXELFORMATDESCRIPTOR *ppfd)
    exports['ChoosePixelFormat'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const ppfd = args[1] >>> 0;
        // Minimal Win32-compatible behavior for legacy OpenGL bootstrap.
        // Return a stable, valid (>0) pixel format index.
        Logger.verbose(LogCategory.GDI32, `ChoosePixelFormat(hdc=0x${hdc.toString(16)}, ppfd=0x${ppfd.toString(16)}) -> 1`);
        return 1;
    };

    // BOOL SetPixelFormat(HDC hdc, int format, const PIXELFORMATDESCRIPTOR *ppfd)
    exports['SetPixelFormat'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const format = args[1] | 0;
        const ppfd = args[2] >>> 0;
        if (format <= 0) {
            Logger.warn(LogCategory.GDI32, `SetPixelFormat(hdc=0x${hdc.toString(16)}, format=${format}, ppfd=0x${ppfd.toString(16)}) -> FALSE`);
            return 0;
        }
        pixelFormatByHdc.set(hdc, format);
        Logger.verbose(LogCategory.GDI32, `SetPixelFormat(hdc=0x${hdc.toString(16)}, format=${format}, ppfd=0x${ppfd.toString(16)}) -> TRUE`);
        return 1;
    };

    // int DescribePixelFormat(HDC hdc, int iPixelFormat, UINT nBytes, LPPIXELFORMATDESCRIPTOR ppfd)
    exports['DescribePixelFormat'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const iPixelFormat = args[1] | 0;
        const nBytes = args[2] >>> 0;
        const ppfd = args[3] >>> 0;

        // Single emulated pixel format for legacy OpenGL bootstrap.
        const maxFormats = 1;
        if (iPixelFormat <= 0 || iPixelFormat > maxFormats) {
            Logger.verbose(
                LogCategory.GDI32,
                `DescribePixelFormat(hdc=0x${hdc.toString(16)}, fmt=${iPixelFormat}, nBytes=${nBytes}, ppfd=0x${ppfd.toString(16)}) -> 0`
            );
            return 0;
        }

        if (ppfd && nBytes >= 40 && ppfd + 40 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // PIXELFORMATDESCRIPTOR (40 bytes)
            view.setUint16(ppfd + 0, 40, true);      // nSize
            view.setUint16(ppfd + 2, 1, true);       // nVersion
            view.setUint32(ppfd + 4, 0x00000025, true); // PFD_DRAW_TO_WINDOW|PFD_SUPPORT_OPENGL|PFD_DOUBLEBUFFER
            view.setUint8(ppfd + 8, 0);              // iPixelType = PFD_TYPE_RGBA
            view.setUint8(ppfd + 9, 32);             // cColorBits
            view.setUint8(ppfd + 10, 8);             // cRedBits
            view.setUint8(ppfd + 11, 16);            // cRedShift
            view.setUint8(ppfd + 12, 8);             // cGreenBits
            view.setUint8(ppfd + 13, 8);             // cGreenShift
            view.setUint8(ppfd + 14, 8);             // cBlueBits
            view.setUint8(ppfd + 15, 0);             // cBlueShift
            view.setUint8(ppfd + 16, 8);             // cAlphaBits
            view.setUint8(ppfd + 17, 24);            // cAlphaShift
            view.setUint8(ppfd + 23, 24);            // cDepthBits
            view.setUint8(ppfd + 24, 8);             // cStencilBits
            view.setUint8(ppfd + 25, 0);             // cAuxBuffers
            view.setUint8(ppfd + 26, 0);             // iLayerType = PFD_MAIN_PLANE
        }

        Logger.verbose(
            LogCategory.GDI32,
            `DescribePixelFormat(hdc=0x${hdc.toString(16)}, fmt=${iPixelFormat}, nBytes=${nBytes}, ppfd=0x${ppfd.toString(16)}) -> ${maxFormats}`
        );
        return maxFormats;
    };

    // int GetPixelFormat(HDC hdc)
    exports['GetPixelFormat'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const format = pixelFormatByHdc.get(hdc) ?? 1;
        Logger.verbose(LogCategory.GDI32, `GetPixelFormat(hdc=0x${hdc.toString(16)}) -> ${format}`);
        return format;
    };

    // BOOL SwapBuffers(HDC hdc)
    exports['SwapBuffers'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        // Delegate to OpenGL presenter if an OpenGL context is current
        const gl32 = System.getInstance().process?.getModule("opengl32") as any;
        if (gl32) {
            const glCtx = gl32.getContext?.();
            if (glCtx?.presenter) {
                Logger.verbose(LogCategory.GDI32, `SwapBuffers(hdc=0x${hdc.toString(16)}) -> GL present`);
                glCtx.presenter.present();
                return 1;
            }
        }
        Logger.log(LogCategory.GDI32, `SwapBuffers(hdc=0x${hdc.toString(16)}) -> TRUE (no GL ctx)`);
        return 1;
    };

    exports['CreateSolidBrush'] = (ctx, mem, args): number => {
        const color = args[0]; // 0x00BBGGRR
        Logger.verbose(LogCategory.GDI32, `CreateSolidBrush color=0x${color.toString(16)}`);
        return System.getInstance().gdiContext.createSolidBrush(color);
    };

    exports['CreatePatternBrush'] = (ctx, mem, args): number => {
        const hBitmap = args[0] >>> 0;
        Logger.verbose(LogCategory.GDI32, `CreatePatternBrush(hBitmap=0x${hBitmap.toString(16)})`);
        return System.getInstance().gdiContext.createPatternBrush(hBitmap);
    };

    exports['SelectObject'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hgdiobj = args[1];
        const result = System.getInstance().gdiContext.selectObject(hdc, hgdiobj);
        // Log to help diagnose hdcSrc=0 issues - show when bitmaps are selected
        if (hgdiobj > 0x30000 || hgdiobj < 0x80000000) {
            Logger.verbose(LogCategory.GDI32, `SelectObject(hdc=0x${hdc.toString(16)}, obj=0x${hgdiobj.toString(16)}) -> 0x${result.toString(16)}`);
        }
        return result;
    };

    exports['DeleteObject'] = (ctx, mem, args): number => {
        const hgdiobj = args[0];
        return System.getInstance().gdiContext.deleteObject(hgdiobj) ? 1 : 0;
    };

    exports['Rectangle'] = (ctx, mem, args): number => {
        const hdc = args[0];
        // Note: Coordinates are SIGNED int32 in Win32!
        // args[] contains unsigned values, so -50 becomes 0xFFFFFFCE (4294967246)
        // Use | 0 to reinterpret as signed
        const left = args[1] | 0;
        const top = args[2] | 0;
        const right = args[3] | 0;
        const bottom = args[4] | 0;

        Logger.verbose(LogCategory.GDI32, `Rectangle: (${left},${top}) - (${right},${bottom})`);
        // Border with the PEN, interior with the BRUSH. GDI's right/bottom are exclusive:
        // the outline runs along left..right-1 / top..bottom-1 and the brush fills what is
        // left inside it, so filling the whole rect and then stroking the outline on top
        // gives the identical footprint for a 1px pen (dibdrv_Rectangle).
        const gdi = System.getInstance().gdiContext;
        const filled = gdi.fillRect(hdc, left, top, right, bottom);
        if (right - left >= 1 && bottom - top >= 1) {
            const r = right - 1, b = bottom - 1;
            gdi.strokePolyline(hdc, [left, top, r, top, r, b, left, b], true);
        }
        return filled ? 1 : 0;
    };

    exports['TextOutA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0; // signed
        const y = args[2] | 0; // signed
        const lpString = args[3];
        const c = args[4];

        const text = Marshaler.readString(mem, lpString).substring(0, c);
        Logger.verbose(LogCategory.GDI32, `TextOutA: '${text}' at (${x},${y})`);

        const success = System.getInstance().gdiContext.textOut(hdc, x, y, text);
        return success ? 1 : 0;
    };

    exports['TextOutW'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0; // signed
        const y = args[2] | 0; // signed
        const lpString = args[3];
        const c = args[4];

        const text = Marshaler.readWideString(mem, lpString);
        // Limit to c characters if specified
        const limitedText = c > 0 ? text.substring(0, c) : text;
        Logger.verbose(LogCategory.GDI32, `TextOutW: '${limitedText}' at (${x},${y})`);

        const success = System.getInstance().gdiContext.textOut(hdc, x, y, limitedText);
        return success ? 1 : 0;
    };

    exports['SetBkMode'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const mode = args[1];
        return System.getInstance().gdiContext.setBkMode(hdc, mode);
    };

    exports['SetBkColor'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const color = args[1];
        Logger.verbose(LogCategory.GDI32, `SetBkColor(hdc=0x${hdc.toString(16)}, color=0x${(color >>> 0).toString(16)})`);
        return System.getInstance().gdiContext.setBkColor(hdc, color);
    };

    exports['GetBkColor'] = (ctx, mem, args): number => {
        const hdc = args[0];
        return System.getInstance().gdiContext.getBkColor(hdc);
    };

    exports['SetTextColor'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const color = args[1];
        return System.getInstance().gdiContext.setTextColor(hdc, color);
    };

    exports['SetTextAlign'] = (ctx, mem, args): number => {
        return System.getInstance().gdiContext.setTextAlign(args[0], args[1]);
    };

    exports['GetTextAlign'] = (ctx, mem, args): number => {
        return System.getInstance().gdiContext.getTextAlign(args[0]);
    };

    exports['CreateFontW'] = (ctx, mem, args): number => {
        const height = args[0];
        const width = args[1];
        const weight = args[4];
        const italic = args[5];
        const faceNamePtr = args[13];

        const faceName = Marshaler.readWideString(mem, faceNamePtr);
        const hFont = System.getInstance().gdiContext.createFont(
            height, width, weight, italic !== 0, faceName
        );

        Logger.verbose(LogCategory.GDI32, `CreateFontW height=${height} weight=${weight} face='${faceName}' -> 0x${hFont.toString(16)}`);
        return hFont;
    };

    exports['CreateFontA'] = (ctx, mem, args): number => {
        const height = args[0];
        const width = args[1];
        const escapement = args[2];
        const weight = args[4];
        const italic = args[5];
        const quality = args[11];
        const faceNamePtr = args[13];

        const faceName = Marshaler.readString(mem, faceNamePtr);
        const hFont = System.getInstance().gdiContext.createFont(
            height, width, weight, italic !== 0, faceName, escapement, quality
        );

        Logger.verbose(LogCategory.GDI32, `CreateFontA height=${height} weight=${weight} face='${faceName}' -> 0x${hFont.toString(16)}`);
        return hFont;
    };

    exports['CreateFontIndirectW'] = (ctx, mem, args): number => {
        const lplf = args[0]; // Pointer to LOGFONTW structure

        if (!lplf) {
            Logger.warn(LogCategory.GDI32, 'CreateFontIndirectW: NULL pointer');
            return 0;
        }

        // Read LOGFONTW structure from memory
        // LOGFONTW structure layout (92 bytes):
        //   lfHeight: LONG (i32) - offset 0
        //   lfWidth: LONG (i32) - offset 4
        //   lfEscapement: LONG (i32) - offset 8
        //   lfOrientation: LONG (i32) - offset 12
        //   lfWeight: LONG (i32) - offset 16
        //   lfItalic: BYTE (u8) - offset 20
        //   lfUnderline: BYTE (u8) - offset 21
        //   lfStrikeOut: BYTE (u8) - offset 22
        //   lfCharSet: BYTE (u8) - offset 23
        //   lfOutPrecision: BYTE (u8) - offset 24
        //   lfClipPrecision: BYTE (u8) - offset 25
        //   lfQuality: BYTE (u8) - offset 26
        //   lfPitchAndFamily: BYTE (u8) - offset 27
        //   lfFaceName: WCHAR[32] (64 bytes) - offset 28

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const lfHeight = view.getInt32(lplf, true);
        const lfWidth = view.getInt32(lplf + 4, true);
        const lfEscapement = view.getInt32(lplf + 8, true);
        const lfWeight = view.getInt32(lplf + 16, true);
        const lfItalic = mem[lplf + 20] !== 0;
        const lfQuality = mem[lplf + 26];
        const lfFaceNamePtr = lplf + 28;

        // Read face name (wide string, max 32 characters = 64 bytes)
        const faceName = Marshaler.readWideString(mem, lfFaceNamePtr);

        Logger.verbose(LogCategory.GDI32, `CreateFontIndirectW: height=${lfHeight} width=${lfWidth} weight=${lfWeight} italic=${lfItalic} escapement=${lfEscapement} face='${faceName}'`);

        const hFont = System.getInstance().gdiContext.createFont(
            lfHeight, lfWidth, lfWeight, lfItalic, faceName, lfEscapement, lfQuality
        );

        return hFont;
    };

    // CreateFontIndirect (without W) - in Unicode builds, this is a macro that expands to CreateFontIndirectW
    exports['CreateFontIndirect'] = exports['CreateFontIndirectW'];

    // CreateFontIndirectA — LOGFONTA: identical numeric fields, but lfFaceName is CHAR[32]
    // (ANSI) at offset 28 (struct is 60 bytes vs 92 for W). MFC ANSI builds use this.
    exports['CreateFontIndirectA'] = (ctx, mem, args): number => {
        const lplf = args[0];
        if (!lplf) {
            Logger.warn(LogCategory.GDI32, 'CreateFontIndirectA: NULL pointer');
            return 0;
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const lfHeight = view.getInt32(lplf, true);
        const lfWidth = view.getInt32(lplf + 4, true);
        const lfEscapement = view.getInt32(lplf + 8, true);
        const lfWeight = view.getInt32(lplf + 16, true);
        const lfItalic = mem[lplf + 20] !== 0;
        const lfQuality = mem[lplf + 26];
        const faceName = Marshaler.readString(mem, lplf + 28);
        Logger.verbose(LogCategory.GDI32, `CreateFontIndirectA: height=${lfHeight} width=${lfWidth} weight=${lfWeight} italic=${lfItalic} escapement=${lfEscapement} face='${faceName}'`);
        return System.getInstance().gdiContext.createFont(
            lfHeight, lfWidth, lfWeight, lfItalic, faceName, lfEscapement, lfQuality
        );
    };

    // DeleteDC - delete device context
    exports['DeleteDC'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `DeleteDC called: hdc=0x${hdc.toString(16)}`);
        const success = System.getInstance().gdiContext.deleteDC(hdc);
        return success ? 1 : 0;
    };

    // CreateCompatibleDC - create memory device context
    exports['CreateCompatibleDC'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const newHdc = System.getInstance().gdiContext.createCompatibleDC(hdc);
        // Log at higher level to help diagnose hdcSrc=0 issues
        Logger.verbose(LogCategory.GDI32, `CreateCompatibleDC(hdc=0x${hdc.toString(16)}) -> 0x${newHdc.toString(16)}`);
        return newHdc;
    };

    // GetObjectA - for fonts writes LOGFONTA (60 bytes, CHAR lfFaceName[32])
    exports['GetObjectA'] = (ctx, mem, args): number => {
        const hgdiobj = args[0];
        const cbBuffer = args[1];
        const lpvObject = args[2];

        Logger.verbose(LogCategory.GDI32, `GetObjectA called: hgdiobj=0x${hgdiobj.toString(16)}, cbBuffer=${cbBuffer}, lpvObject=0x${lpvObject.toString(16)}`);

        const result = System.getInstance().gdiContext.getObject(hgdiobj, cbBuffer, lpvObject, mem, /*isUnicode*/ false);
        Logger.verbose(LogCategory.GDI32, `GetObjectA -> ${result}`);
        return result;
    };

    // GetObjectW - for fonts writes LOGFONTW (92 bytes, WCHAR lfFaceName[32])
    exports['GetObjectW'] = (ctx, mem, args): number => {
        const hgdiobj = args[0];
        const cbBuffer = args[1];
        const lpvObject = args[2];

        Logger.verbose(LogCategory.GDI32, `GetObjectW called: hgdiobj=0x${hgdiobj.toString(16)}, cbBuffer=${cbBuffer}, lpvObject=0x${lpvObject.toString(16)}`);

        const result = System.getInstance().gdiContext.getObject(hgdiobj, cbBuffer, lpvObject, mem, /*isUnicode*/ true);
        Logger.verbose(LogCategory.GDI32, `GetObjectW -> ${result}`);
        return result;
    };

    // GetPixel - get pixel color
    exports['GetPixel'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0; // signed
        const y = args[2] | 0; // signed

        // Track HDC usage for profiling
        if (profiler.isEnabled()) {
            let stats = getPixelHdcStats.get(hdc);
            if (!stats) {
                stats = { count: 0, maxX: 0, maxY: 0 };
                getPixelHdcStats.set(hdc, stats);
                profiler.increment('GetPixel', 'uniqueHDCs', 1);
            }
            stats.count++;
            stats.maxX = Math.max(stats.maxX, x);
            stats.maxY = Math.max(stats.maxY, y);
        }

        return System.getInstance().gdiContext.getPixel(hdc, x, y);
    };

    // BitBlt - copy bitmap
    exports['BitBlt'] = (ctx, mem, args): number => {
        const hdcDest = args[0];
        const x = args[1] | 0;      // signed
        const y = args[2] | 0;      // signed
        const width = args[3] | 0;  // signed (can be negative for mirroring)
        const height = args[4] | 0; // signed (can be negative for mirroring)
        const hdcSrc = args[5];
        const xSrc = args[6] | 0;   // signed
        const ySrc = args[7] | 0;   // signed
        const rop = args[8];

        const absW = Math.abs(width);
        const absH = Math.abs(height);
        if (absW >= 640 && absH >= 480) {
            Logger.log(LogCategory.GDI32, `BitBlt: hdcDest=0x${hdcDest.toString(16)} hdcSrc=0x${hdcSrc.toString(16)} (${xSrc},${ySrc}) ${width}x${height} -> (${x},${y}) rop=0x${rop.toString(16)}`);
        } else if (width > 0 || height > 0) {
            Logger.verbose(LogCategory.GDI32, `BitBlt: hdcDest=0x${hdcDest.toString(16)} hdcSrc=0x${hdcSrc.toString(16)} (${xSrc},${ySrc}) ${width}x${height} -> (${x},${y}) rop=0x${rop.toString(16)}`);
        } else {
            Logger.verbose(LogCategory.GDI32, `BitBlt called: hdcDest=0x${hdcDest.toString(16)}, hdcSrc=0x${hdcSrc.toString(16)}, (${xSrc},${ySrc}) ${width}x${height} -> (${x},${y}), rop=0x${rop.toString(16)}`);
        }

        const success = System.getInstance().gdiContext.bitBlt(
            hdcDest, x, y, width, height,
            hdcSrc, xSrc, ySrc, rop
        );

        return success ? 1 : 0;
    };

    // StretchBlt - stretch bitmap
    exports['StretchBlt'] = (ctx, mem, args): number => {
        const hdcDest = args[0];
        const xDest = args[1] | 0;  // signed
        const yDest = args[2] | 0;  // signed
        const wDest = args[3] | 0;  // signed (negative = mirror)
        const hDest = args[4] | 0;  // signed (negative = mirror)
        const hdcSrc = args[5];
        const xSrc = args[6] | 0;   // signed
        const ySrc = args[7] | 0;   // signed
        const wSrc = args[8] | 0;   // signed
        const hSrc = args[9] | 0;   // signed
        const rop = args[10];
        
        const linkedSurface = System.getInstance().gdiContext.getLinkedSurface(hdcDest);
        const linkInfo = linkedSurface ? ` linkedSurface=0x${linkedSurface.toString(16)}` : " linkedSurface=none";
        const success = System.getInstance().gdiContext.stretchBlt(
            hdcDest, xDest, yDest, wDest, hDest,
            hdcSrc, xSrc, ySrc, wSrc, hSrc, rop
        );

        Logger.log(LogCategory.GDI32, `StretchBlt: hdcDest=0x${hdcDest.toString(16)}, hdcSrc=0x${hdcSrc.toString(16)}, src(${xSrc},${ySrc}) ${wSrc}x${hSrc} -> dest(${xDest},${yDest}) ${wDest}x${hDest}, rop=0x${rop.toString(16)}${linkInfo} -> ${success}`);

        return success ? 1 : 0;
    };

    // GetDIBits - retrieve bitmap bits in DIB format
    exports['GetDIBits'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hbm = args[1]; // Bitmap handle
        const start = args[2]; // First scan line
        const cLines = args[3]; // Number of scan lines
        const lpvBits = args[4]; // Output buffer for bits (can be NULL)
        const lpbmi = args[5]; // BITMAPINFO structure
        const usage = args[6]; // DIB_RGB_COLORS (0) or DIB_PAL_COLORS (1)

        Logger.verbose(LogCategory.GDI32, `GetDIBits called: hdc=0x${hdc.toString(16)}, hbm=0x${hbm.toString(16)}, start=${start}, cLines=${cLines}, lpvBits=0x${lpvBits.toString(16)}, lpbmi=0x${lpbmi.toString(16)}, usage=${usage}`);

        if (!lpbmi) {
            Logger.warn(LogCategory.GDI32, 'GetDIBits: NULL lpbmi pointer');
            return 0;
        }

        // Get bitmap from SystemResourceProvider
        const gdiCtx = System.getInstance().gdiContext;
        let userObj = SystemResourceProvider.getInstance().getUserObject(hbm) as any;

        // Self-surface read: when the caller reads a SEEDED window/client memory DC's own
        // drawing surface (its selected bitmap is the DC's implicit/default handle), the truth
        // is the DC's canvas, not the stock default bitmap (which getUserObject resolves to a
        // black object). This is how an owner-draw parent reads the just-painted background
        // (the splash we seeded into the drawitem child DC) for its transparent
        // max(face,background) composite — without it the dest read is black and the buttons
        // render as opaque black blocks over the splash. Gated on hasWindowBlit so it only
        // affects our seeded window DCs, not ordinary CreateCompatibleDC face bitmaps.
        if (hbm === gdiCtx.getDCSelectedBitmap(hdc) && gdiCtx.hasWindowBlit(hdc)) {
            const surface = gdiCtx.getDCSurfacePixels(hdc);
            if (surface) {
                Logger.verbose(LogCategory.GDI32,
                    `GetDIBits: self-surface read hdc=0x${hdc.toString(16)} hbm=0x${hbm.toString(16)} ${surface.width}x${surface.height}`);
                userObj = { type: 'BITMAP', width: surface.width, height: surface.height, pixels: surface.data };
            }
        }

        if (!userObj || userObj.type !== 'BITMAP') {
            Logger.warn(LogCategory.GDI32, `GetDIBits: Invalid bitmap handle 0x${hbm.toString(16)}`);
            return 0;
        }

        const width = userObj.width || 0;
        const height = userObj.height || 0;
        if (width <= 0 || height <= 0) {
            Logger.warn(LogCategory.GDI32, `GetDIBits: Invalid bitmap dimensions ${width}x${height}`);
            return 0;
        }

        // Leaf hot loop: the RGBA→DIB write-back below stores 3-4 bytes per pixel through
        // `mem`, which the dispatcher hands us as v86's always-live Proxy. Nothing between
        // here and the loop re-enters the guest, so a plain view cannot go stale.
        mem = toPlainGuestMemory(mem);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Read requested biHeight from caller's BITMAPINFO
        // If biHeight is negative, caller wants top-down DIB (no Y flip)
        // If biHeight is positive or zero, caller wants bottom-up DIB (Y flip needed)
        const requestedBiHeight = view.getInt32(lpbmi + 8, true);
        const wantsTopDown = requestedBiHeight < 0;

        // Honor the caller's requested colour depth. Apps that build their own BITMAPINFO with
        // biBitCount=24 (HL's owner-draw button compositor FUN_0041a360 / FUN_00431850) size the
        // destination buffer at a 24bpp (3-byte, DWORD-padded) stride; writing 32bpp into it
        // misaligns every pixel and the app's subsequent blend renders as multicolour confetti.
        // Default to 32bpp for any other request (preserves prior behaviour for 32bpp callers).
        const requestedBiBitCount = view.getUint16(lpbmi + 14, true);
        const outBpp = requestedBiBitCount === 24 ? 24 : 32;
        const outBytesPerPixel = outBpp === 24 ? 3 : 4;
        const outStride = outBpp === 24 ? (((width * 3) + 3) & ~3) : (width * 4);

        // Fill BITMAPINFOHEADER structure (40 bytes)
        // biSize
        view.setUint32(lpbmi, 40, true);
        // biWidth
        view.setInt32(lpbmi + 4, width, true);
        // biHeight - preserve sign from caller's request
        view.setInt32(lpbmi + 8, wantsTopDown ? -height : height, true);
        // biPlanes
        view.setUint16(lpbmi + 12, 1, true);
        // biBitCount - honor the requested depth (24 or 32)
        view.setUint16(lpbmi + 14, outBpp, true);
        // biCompression (BI_RGB = 0)
        view.setUint32(lpbmi + 16, 0, true);
        // biSizeImage (stride * height)
        const imageSize = outStride * height;
        view.setUint32(lpbmi + 20, imageSize, true);
        // biXPelsPerMeter
        view.setInt32(lpbmi + 24, 0, true);
        // biYPelsPerMeter
        view.setInt32(lpbmi + 28, 0, true);
        // biClrUsed
        view.setUint32(lpbmi + 32, 0, true);
        // biClrImportant
        view.setUint32(lpbmi + 36, 0, true);

        Logger.verbose(LogCategory.GDI32, `GetDIBits: requestedBiHeight=${requestedBiHeight} wantsTopDown=${wantsTopDown}`);

        // If lpvBits is NULL, just fill BITMAPINFO and return
        if (!lpvBits) {
            Logger.verbose(LogCategory.GDI32, `GetDIBits: lpvBits is NULL, filled BITMAPINFO only`);
            return cLines > 0 ? cLines : height; // Return number of lines
        }

        // DIBSection path: prefer the real section memory over shadow RGBA cache.
        const dibBitsPtr = (userObj as any).bitsPtr as number | undefined;
        const dibBpp = (userObj as any).dibBpp as number | undefined;
        const dibStride = (userObj as any).dibStride as number | undefined;
        const dibTopDown = !!(userObj as any).dibTopDown;
        if (dibBitsPtr && dibBpp === 32 && dibStride && dibStride > 0) {
            const actualStart = Math.max(0, start);
            const actualEnd = Math.min(height, actualStart + (cLines > 0 ? cLines : height));
            const linesToCopy = actualEnd - actualStart;
            if (linesToCopy <= 0) return 0;

            const bytesPerLine = width * 4;
            const copyBytes = Math.min(bytesPerLine, dibStride);
            for (let i = 0; i < linesToCopy; i++) {
                const logicalSrcLine = actualStart + i; // top-down logical space
                const srcPhysicalLine = dibTopDown ? logicalSrcLine : (height - 1 - logicalSrcLine);
                const dstLine = wantsTopDown ? i : (linesToCopy - 1 - i);
                const srcOff = dibBitsPtr + srcPhysicalLine * dibStride;
                const dstOff = lpvBits + dstLine * bytesPerLine;
                mem.set(mem.subarray(srcOff, srcOff + copyBytes), dstOff);
                if (copyBytes < bytesPerLine) {
                    mem.fill(0, dstOff + copyBytes, dstOff + bytesPerLine);
                }
            }
            Logger.verbose(LogCategory.GDI32, `GetDIBits: copied ${linesToCopy} lines from DIBSection bits=0x${dibBitsPtr.toString(16)}`);
            return linesToCopy;
        }

        // Copy pixel data to output buffer
        if (!userObj.pixels) {
            Logger.warn(LogCategory.GDI32, 'GetDIBits: Bitmap has no pixel data');
            return 0;
        }

        // Calculate actual lines to copy
        const actualStart = Math.max(0, start);
        const actualEnd = Math.min(height, actualStart + (cLines > 0 ? cLines : height));
        const linesToCopy = actualEnd - actualStart;

        if (linesToCopy <= 0) {
            Logger.verbose(LogCategory.GDI32, 'GetDIBits: No lines to copy');
            return 0;
        }

        // Get source pixels (RGBA format, top-down).
        // For a compatible bitmap the raw `pixels` buffer is just the creation-time fill;
        // the real content lives in its backing canvas (kept current by BitBlt writeback).
        // HL builds its owner-draw button faces by compositing btns_main tiles into a
        // compatible bitmap then GetDIBits-ing it back, so we must read the canvas here —
        // reading `pixels` returned the init colour (the buttons rendered as solid blocks).
        let sourcePixels: Uint8Array | Uint8ClampedArray;
        const renderedPixels = (userObj as any).compatibleEmpty
            ? System.getInstance().gdiContext.getBitmapRenderedPixels(hbm)
            : null;
        if (renderedPixels) {
            sourcePixels = renderedPixels;
        } else if (userObj.pixels instanceof Uint8ClampedArray || userObj.pixels instanceof Uint8Array) {
            sourcePixels = userObj.pixels;
        } else if (userObj.pixels instanceof ArrayBuffer) {
            sourcePixels = new Uint8Array(userObj.pixels);
        } else {
            Logger.warn(LogCategory.GDI32, 'GetDIBits: Unsupported pixel format');
            return 0;
        }

        // DEBUG (opt-in): set `(globalThis as any).__gdibDumpName` to a prefix to dump the next
        // GetDIBits source bitmap to logs/debug/<prefix>.png (see dumpRgbaToPng). Off by default.
        const dumpName = (globalThis as any).__gdibDumpName;
        if (dumpName) {
            (globalThis as any).__gdibDumpName = undefined;
            dumpRgbaToPng(`${dumpName}_${width}x${height}_hbm${hbm.toString(16)}`, sourcePixels, width, height);
        }

        // DIB format depends on biHeight sign:
        // - Positive biHeight = bottom-up DIB (need to flip Y)
        // - Negative biHeight = top-down DIB (no flip needed)
        // Source canvas pixels are always RGBA (4-byte) top-down; the destination stride/depth
        // is whatever the caller asked for (outStride/outBytesPerPixel, 24 or 32bpp).
        const srcStride = width * 4;

        for (let i = 0; i < linesToCopy; i++) {
            const srcLine = actualStart + i; // Source line (top-down, 0 = top)
            // Destination line depends on requested format
            const dstLine = wantsTopDown ? i : (linesToCopy - 1 - i);

            // Source: top-down RGBA; Destination: caller's stride/depth (BGR or BGRA)
            const srcOffset = srcLine * srcStride;
            const dstOffset = dstLine * outStride;

            for (let x = 0; x < width; x++) {
                const srcPixel = srcOffset + (x * 4);
                const dstPixel = dstOffset + (x * outBytesPerPixel);

                // Windows DIB uses BGR(A) byte order; canvas uses RGBA
                const r = sourcePixels[srcPixel];
                const g = sourcePixels[srcPixel + 1];
                const b = sourcePixels[srcPixel + 2];

                mem[lpvBits + dstPixel] = b;     // Blue
                mem[lpvBits + dstPixel + 1] = g; // Green
                mem[lpvBits + dstPixel + 2] = r; // Red
                if (outBytesPerPixel === 4) {
                    mem[lpvBits + dstPixel + 3] = sourcePixels[srcPixel + 3]; // Alpha
                }
            }
        }

        Logger.verbose(LogCategory.GDI32, `GetDIBits: Copied ${linesToCopy} lines (${width}x${height} bitmap) ${outBpp}bpp wantsTopDown=${wantsTopDown}`);

        // Debug: Sample some pixels from the output buffer to verify data was written
        if (linesToCopy > 0 && lpvBits) {
            const firstPixel = [mem[lpvBits], mem[lpvBits + 1], mem[lpvBits + 2], mem[lpvBits + 3]];
            const midOffset = Math.floor(linesToCopy / 2) * outStride + Math.floor(width / 2) * outBytesPerPixel;
            const midPixel = [mem[lpvBits + midOffset], mem[lpvBits + midOffset + 1], mem[lpvBits + midOffset + 2], mem[lpvBits + midOffset + 3]];
            const anyNonZero = firstPixel.some(v => v !== 0) || midPixel.some(v => v !== 0);
            Logger.verbose(LogCategory.GDI32, `GetDIBits DIAGNOSTIC: lpvBits=0x${lpvBits.toString(16)} firstPixel=[${firstPixel.join(',')}] midPixel=[${midPixel.join(',')}] anyNonZero=${anyNonZero}`);
        }

        // Store buffer address for potential texture loading workaround
        if (linesToCopy > 0 && lpvBits) {
            lastGetDIBitsBuffer = { address: lpvBits, width, height };
        }
        
        
        return linesToCopy;
    };

    // GetDIBColorTable - get DIB color table
    exports['GetDIBColorTable'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const uStartIndex = args[1];
        const cEntries = args[2];
        const pColors = args[3];
        
        Logger.log(LogCategory.GDI32, `GetDIBColorTable called: hdc=0x${hdc.toString(16)}, uStartIndex=${uStartIndex}, cEntries=${cEntries}, pColors=0x${pColors.toString(16)}`);
        
        if (!pColors) {
            Logger.warn(LogCategory.GDI32, 'GetDIBColorTable: NULL pColors pointer');
            return 0;
        }

        // Get bitmap handle from HDC
        const gdiContext = System.getInstance().gdiContext;
        const hdcState = (gdiContext as any).hdcStates?.get(hdc);
        if (!hdcState) {
            Logger.warn(LogCategory.GDI32, `GetDIBColorTable: Invalid HDC 0x${hdc.toString(16)}`);
            return 0;
        }

        // Get bitmap handle from HDC state
        const hdcCtx = (gdiContext as any).contexts?.get(hdc);
        const hBitmap = hdcState.hBitmap || (hdcCtx?.canvas as any)?.__bitmapHandle;
        if (!hBitmap) {
            Logger.verbose(LogCategory.GDI32, `GetDIBColorTable: HDC 0x${hdc.toString(16)} has no bitmap selected`);
            return 0;
        }

        // Get bitmap from SystemResourceProvider. DIBSections carry dibPalette
        // (0xAARRGGBB — the SetDIBColorTable/resolveBitmapRgba layout); LoadImage
        // bitmaps may carry the legacy palette field (0xAABBGGRR) instead.
        const userObj = SystemResourceProvider.getInstance().getUserObject(hBitmap);
        const dibPalette = userObj?.type === 'BITMAP' ? userObj.dibPalette as Uint32Array | undefined : undefined;
        const legacyPalette = userObj?.type === 'BITMAP' ? userObj.palette as Uint32Array | undefined : undefined;
        const palette = dibPalette ?? legacyPalette;
        if (!palette) {
            Logger.verbose(LogCategory.GDI32, `GetDIBColorTable: Bitmap 0x${hBitmap.toString(16)} has no color table (type=${userObj?.type})`);
            return 0;
        }
        const paletteSize = palette.length;

        // Validate indices
        if (uStartIndex >= paletteSize) {
            Logger.warn(LogCategory.GDI32, `GetDIBColorTable: Start index ${uStartIndex} >= palette size ${paletteSize}`);
            return 0;
        }

        const actualCount = Math.min(cEntries, paletteSize - uStartIndex);
        if (actualCount <= 0) {
            Logger.warn(LogCategory.GDI32, `GetDIBColorTable: Invalid count ${cEntries}, start=${uStartIndex}, palette size=${paletteSize}`);
            return 0;
        }

        // Write RGBQUAD entries (B, G, R, reserved).
        const isArgb = palette === dibPalette; // 0xAARRGGBB; legacy is 0xAABBGGRR
        for (let i = 0; i < actualCount; i++) {
            const color = palette[uStartIndex + i];
            const r = (isArgb ? color >> 16 : color) & 0xFF;
            const g = (color >> 8) & 0xFF;
            const b = (isArgb ? color : color >> 16) & 0xFF;
            const offset = pColors + i * 4;
            mem[offset] = b;
            mem[offset + 1] = g;
            mem[offset + 2] = r;
            mem[offset + 3] = 0;
        }

        Logger.verbose(LogCategory.GDI32, `GetDIBColorTable: Returned ${actualCount} palette entries (start=${uStartIndex}, total=${paletteSize})`);
        return actualCount;
    };

    // SetDIBColorTable - set DIB color table entries
    exports['SetDIBColorTable'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const uStartIndex = args[1];
        const cEntries = args[2];
        const pColors = args[3];

        Logger.log(LogCategory.GDI32, `SetDIBColorTable(hdc=0x${hdc.toString(16)}, start=${uStartIndex}, count=${cEntries})`);

        if (!pColors || cEntries <= 0) return 0;

        const gdiContext = System.getInstance().gdiContext;
        const hdcState = (gdiContext as any).hdcStates?.get(hdc);
        if (!hdcState) return 0;

        const hdcCtx = (gdiContext as any).contexts?.get(hdc);
        const hBitmap = hdcState.hBitmap || (hdcCtx?.canvas as any)?.__bitmapHandle;
        if (!hBitmap) return 0;

        const userObj = SystemResourceProvider.getInstance().getUserObject(hBitmap);
        if (!userObj || userObj.type !== 'BITMAP') {
            return cEntries;
        }
        const palette = userObj.dibPalette as Uint32Array | undefined;
        if (!palette) {
            return cEntries; // 16/24/32bpp DIBs have no color table — report success
        }
        if (uStartIndex >= palette.length) return 0;

        const actualCount = Math.min(cEntries, palette.length - uStartIndex);

        // Same 0xAARRGGBB layout resolveBitmapRgba decodes.
        for (let i = 0; i < actualCount; i++) {
            const offset = pColors + i * 4;
            const b = mem[offset];
            const g = mem[offset + 1];
            const r = mem[offset + 2];
            palette[uStartIndex + i] = 0xff000000 | (r << 16) | (g << 8) | b;
        }

        // The bitmap may already be selected into this DC — re-materialize so
        // reads through the DC see the new color table.
        gdiContext.refreshDibSectionCanvas(hBitmap);
        const dcCtx = (gdiContext as any).contexts?.get(hdc);
        const bmpDC = (gdiContext as any).bitmapDCCache?.get(hBitmap);
        const bmpCtx = bmpDC !== undefined ? (gdiContext as any).contexts?.get(bmpDC) : undefined;
        if (dcCtx && bmpCtx && hdcState.hBitmap === hBitmap) {
            dcCtx.clearRect(0, 0, dcCtx.canvas.width, dcCtx.canvas.height);
            dcCtx.drawImage(bmpCtx.canvas, 0, 0);
            (gdiContext as any).invalidateImageDataCache?.(hdc);
        }

        return actualCount;
    };

    // SetPixel - set a single pixel color
    exports['SetPixel'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0; // signed
        const y = args[2] | 0; // signed
        const color = args[3];
        Logger.verbose(LogCategory.GDI32, `SetPixel(hdc=0x${hdc.toString(16)}, x=${x}, y=${y}, color=0x${color.toString(16)})`);
        // Stub: return the color (success)
        return color;
    };

    // SetStretchBltMode - sets bitmap stretching mode
    exports['SetStretchBltMode'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const mode = args[1];
        Logger.verbose(LogCategory.GDI32, `SetStretchBltMode(hdc=0x${hdc.toString(16)}, mode=${mode})`);
        // Return previous mode (stub: return BLACKONWHITE=1)
        return 1;
    };

    // PatBlt - pattern block transfer
    exports['PatBlt'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0; // signed
        const y = args[2] | 0; // signed
        const w = args[3] | 0; // signed
        const h = args[4] | 0; // signed
        const rop = args[5];
        Logger.verbose(LogCategory.GDI32, `PatBlt(hdc=0x${hdc.toString(16)}, x=${x}, y=${y}, w=${w}, h=${h}, rop=0x${rop.toString(16)})`);
        const PATCOPY = 0x00F00021;
        if (rop === PATCOPY) {
            return System.getInstance().gdiContext.fillRect(hdc, x, y, x + w, y + h) ? 1 : 0;
        }
        // Keep compatibility: unknown ROPs are accepted but logged.
        Logger.warn(LogCategory.GDI32, `PatBlt: unsupported ROP 0x${rop.toString(16)}, treating as success`);
        return 1;
    };

    // --- Palette management ---
    // Store palette entries keyed by handle
    const paletteStore = new Map<number, Uint8Array>(); // handle -> PALETTEENTRY[256] (4 bytes each)
    let nextPaletteHandle = 0x50000001;
    const dcPalette = new Map<number, number>(); // hdc -> hPal

    // CreatePalette - creates a logical palette
    exports['CreatePalette'] = (ctx, mem, args): number => {
        const plpal = args[0]; // pointer to LOGPALETTE
        // LOGPALETTE: WORD palVersion (offset 0), WORD palNumEntries (offset 2), PALETTEENTRY[] (offset 4)
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const numEntries = view.getUint16(plpal + 2, true);
        const entries = new Uint8Array(256 * 4); // max 256 entries, 4 bytes each (RGBF)
        const count = Math.min(numEntries, 256);
        // Copy entries from guest memory
        entries.set(mem.subarray(plpal + 4, plpal + 4 + count * 4), 0);
        const handle = nextPaletteHandle++;
        paletteStore.set(handle, entries);
        Logger.verbose(LogCategory.GDI32, `CreatePalette(plpal=0x${plpal.toString(16)}, ${count} entries) -> 0x${handle.toString(16)}`);
        return handle;
    };

    // SelectPalette - selects a palette into a device context
    exports['SelectPalette'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hPal = args[1];
        const bForceBkgd = args[2];
        const prev = dcPalette.get(hdc) || 0;
        dcPalette.set(hdc, hPal);
        Logger.verbose(LogCategory.GDI32, `SelectPalette(hdc=0x${hdc.toString(16)}, hPal=0x${hPal.toString(16)}) -> prev=0x${prev.toString(16)}`);
        return prev;
    };

    // RealizePalette - maps palette entries to system palette
    exports['RealizePalette'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hPal = dcPalette.get(hdc) || 0;
        const entries = hPal ? paletteStore.get(hPal) : undefined;
        const count = entries ? 256 : 0;
        Logger.verbose(LogCategory.GDI32, `RealizePalette(hdc=0x${hdc.toString(16)}) -> ${count}`);
        return count;
    };

    // SetPaletteEntries - sets entries in a logical palette
    exports['SetPaletteEntries'] = (ctx, mem, args): number => {
        const hPal = args[0];
        const iStart = args[1];
        const cEntries = args[2];
        const pPalEntries = args[3]; // pointer to PALETTEENTRY array
        Logger.verbose(LogCategory.GDI32, `SetPaletteEntries(hPal=0x${hPal.toString(16)}, start=${iStart}, count=${cEntries}, ptr=0x${pPalEntries.toString(16)})`);

        let entries = paletteStore.get(hPal);
        if (!entries) {
            // Palette not created by us — create storage lazily
            entries = new Uint8Array(256 * 4);
            paletteStore.set(hPal, entries);
        }

        const end = Math.min(iStart + cEntries, 256);
        const count = end - iStart;
        if (count > 0 && pPalEntries) {
            entries.set(mem.subarray(pPalEntries, pPalEntries + count * 4), iStart * 4);
        }
        return count > 0 ? count : 0;
    };

    // GetPaletteEntries - retrieves entries from a logical palette
    exports['GetPaletteEntries'] = (ctx, mem, args): number => {
        const hPal = args[0];
        const iStart = args[1];
        const cEntries = args[2];
        const pPalEntries = args[3]; // pointer to PALETTEENTRY array (output)
        Logger.verbose(LogCategory.GDI32, `GetPaletteEntries(hPal=0x${hPal.toString(16)}, start=${iStart}, count=${cEntries})`);

        const entries = paletteStore.get(hPal);
        if (!entries) {
            return 0;
        }

        // If pPalEntries is NULL, return the number of entries in the palette
        if (!pPalEntries) {
            return 256;
        }

        const end = Math.min(iStart + cEntries, 256);
        const count = end - iStart;
        if (count > 0) {
            mem.set(entries.subarray(iStart * 4, iStart * 4 + count * 4), pPalEntries);
        }
        return count > 0 ? count : 0;
    };

    // GetNearestPaletteIndex - index of palette entry closest to a COLORREF
    exports['GetNearestPaletteIndex'] = (ctx, mem, args): number => {
        const hPal = args[0];
        const colorRef = args[1] >>> 0;
        const targetR = colorRef & 0xff;
        const targetG = (colorRef >> 8) & 0xff;
        const targetB = (colorRef >> 16) & 0xff;

        const entries = paletteStore.get(hPal);
        if (!entries) {
            Logger.verbose(LogCategory.GDI32,
                `GetNearestPaletteIndex(hPal=0x${hPal.toString(16)}, color=0x${colorRef.toString(16)}) -> CLR_INVALID`);
            return 0xffffffff;
        }

        let bestIndex = 0;
        let bestDist = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < 256; i++) {
            const off = i * 4;
            const dr = entries[off] - targetR;
            const dg = entries[off + 1] - targetG;
            const db = entries[off + 2] - targetB;
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) {
                bestDist = dist;
                bestIndex = i;
            }
        }

        Logger.verbose(LogCategory.GDI32,
            `GetNearestPaletteIndex(hPal=0x${hPal.toString(16)}, color=0x${colorRef.toString(16)}) -> ${bestIndex}`);
        return bestIndex;
    };

    // GetSystemPaletteUse - gets system palette usage
    exports['GetSystemPaletteUse'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `GetSystemPaletteUse(hdc=0x${hdc.toString(16)})`);
        // SYSPAL_STATIC = 1 (static colors used)
        return 1;
    };

    // GetSystemPaletteEntries - retrieves system palette entries
    exports['GetSystemPaletteEntries'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const iStart = args[1];
        const cEntries = args[2];
        const pPalEntries = args[3];
        Logger.verbose(LogCategory.GDI32, `GetSystemPaletteEntries(hdc=0x${hdc.toString(16)}, start=${iStart}, count=${cEntries})`);
        // Return 0 (no palette entries for non-paletted display)
        return 0;
    };

    // CreateCompatibleBitmap - creates a bitmap compatible with a device context
    exports['CreateCompatibleBitmap'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const cx = args[1];
        const cy = args[2];
        if (cx >= 640 || cy >= 480) {
            Logger.log(LogCategory.GDI32, `CreateCompatibleBitmap(hdc=0x${hdc.toString(16)}, cx=${cx}, cy=${cy})`);
        } else {
            Logger.verbose(LogCategory.GDI32, `CreateCompatibleBitmap(hdc=0x${hdc.toString(16)}, cx=${cx}, cy=${cy})`);
        }
        // Create a bitmap through GDI context
        return System.getInstance().gdiContext.createCompatibleBitmap(hdc, cx, cy);
    };

    // StretchDIBits - copies DIB rectangle using stretching
    exports['StretchDIBits'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const xDest = args[1] | 0;
        const yDest = args[2] | 0;
        const wDest = args[3] | 0;
        const hDest = args[4] | 0;
        const xSrc = args[5] | 0;
        const ySrc = args[6] | 0;
        const wSrc = args[7] | 0;
        const hSrc = args[8] | 0;
        const lpBits = args[9];
        const lpBmi = args[10];
        const iUsage = args[11];
        const rop = args[12];
        Logger.log(LogCategory.GDI32, `StretchDIBits: hdc=0x${hdc.toString(16)} dest=(${xDest},${yDest},${wDest}x${hDest}) src=(${xSrc},${ySrc},${wSrc}x${hSrc}) lpBits=0x${lpBits.toString(16)} lpBmi=0x${lpBmi.toString(16)}`);

        const result = dibToCanvas(hdc, mem, lpBmi, lpBits, xDest, yDest, wDest, hDest, xSrc, ySrc, wSrc, hSrc);
        return result ? (hSrc > 0 ? hSrc : hDest) : 0;
    };

    // CreateDIBSection - creates a DIB that applications can write to directly
    exports['CreateDIBSection'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const pbmi = args[1];
        const usage = args[2];
        const ppvBits = args[3];
        const hSection = args[4];
        const offset = args[5];
        Logger.verbose(LogCategory.GDI32, `CreateDIBSection(hdc=0x${hdc.toString(16)}, pbmi=0x${pbmi.toString(16)})`);
        void usage;
        void hSection;
        void offset;

        if (!pbmi) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const biWidth = view.getInt32(pbmi + 4, true);
        const biHeight = view.getInt32(pbmi + 8, true);
        const biBitCount = view.getUint16(pbmi + 14, true);
        const biCompression = view.getUint32(pbmi + 16, true);

        const width = Math.abs(biWidth);
        const height = Math.abs(biHeight);
        if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
            Logger.warn(LogCategory.GDI32, `CreateDIBSection: invalid dimensions ${width}x${height}`);
            return 0;
        }

        if (biCompression !== 0 && biCompression !== 3) {
            Logger.warn(LogCategory.GDI32, `CreateDIBSection: unsupported compression=${biCompression}`);
            return 0;
        }

        const biSize = view.getUint32(pbmi, true);
        const biClrUsed = view.getUint32(pbmi + 32, true);

        // Guest-visible DIB memory backing (what app writes through *ppvBits).
        const bpp = biBitCount > 0 ? biBitCount : 32;
        const rowStride = Math.floor((width * bpp + 31) / 32) * 4;
        const bitsSize = rowStride * height;
        const process = System.getInstance().process;
        if (!process) return 0;
        const bitsPtr = process.memory.alloc(bitsSize, "HEAP", "rw");
        mem.fill(0, bitsPtr, bitsPtr + bitsSize);

        if (ppvBits) {
            view.setUint32(ppvBits, bitsPtr >>> 0, true);
        }

        // Real DIBSections have a fixed-size color table (1 << bpp); biClrUsed only
        // bounds how many entries the caller's BITMAPINFO initializes.
        let dibPalette: Uint32Array | undefined;
        if (bpp <= 8) {
            dibPalette = new Uint32Array(1 << bpp);
            const numColors = biClrUsed === 0 ? (1 << bpp) : Math.min(biClrUsed, 1 << bpp);
            const paletteOffset = pbmi + biSize;
            if (paletteOffset + numColors * 4 <= mem.length) {
                for (let i = 0; i < numColors; i++) {
                    const co = paletteOffset + i * 4;
                    const b = mem[co];
                    const g = mem[co + 1];
                    const r = mem[co + 2];
                    dibPalette[i] = 0xff000000 | (r << 16) | (g << 8) | b;
                }
            }
        }

        // No RGBA shadow — Lead Tools / decoders write guest bitsPtr; resolveBitmapRgba reads it.
        const handle = SystemResourceProvider.getInstance().registerUserObject({
            type: 'BITMAP',
            name: 0,
            width,
            height,
            loading: false,
            pixels: null,
            bitsPtr,
            bitsSize,
            dibBpp: bpp,
            dibStride: rowStride,
            dibTopDown: biHeight < 0,
            dibPalette,
        } as any);

        Logger.log(
            LogCategory.GDI32,
            `CreateDIBSection(${width}x${height}, bpp=${bpp}) -> hbm=0x${handle.toString(16)} bits=0x${bitsPtr.toString(16)}`
        );
        return handle;
    };

    // SetDIBitsToDevice - sets DIB pixels directly to device
    exports['SetDIBitsToDevice'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const xDest = args[1] | 0;
        const yDest = args[2] | 0;
        const w = args[3] | 0;
        const h = args[4] | 0;
        const xSrc = args[5] | 0;
        const ySrc = args[6] | 0;
        const StartScan = args[7];
        const cLines = args[8];
        const lpvBits = args[9];
        const lpbmi = args[10];
        const ColorUse = args[11];
        // Win32: ySrc is the source-rect origin within the DIB (measured from the BOTTOM for a
        // bottom-up biHeight>0 DIB); the scanlines present in lpvBits begin at StartScan. So the
        // lpvBits-relative row base of the rect is (ySrc - StartScan). The old code used StartScan
        // alone and ignored ySrc — so a small tile blitted out of a tall atlas (HL btns_main: 26
        // rows out of a 2184-row strip, selected via ySrc with StartScan=0/cLines=2184) always
        // read the bottom band, and every owner-draw menu button drew the same garbled strip.
        // Honoring ySrc makes each sub-region select its own rows. (dibToCanvas already maps
        // uStartScan + (drawHeight-1-row) for bottom-up and uStartScan + row for top-down.)
        const uStartScan = Math.max(0, (ySrc | 0) - (StartScan >>> 0));
        const scanLines = h > 0 ? h : (cLines >>> 0);
        Logger.verbose(LogCategory.GDI32,
            `SetDIBitsToDevice: hdc=0x${hdc.toString(16)} dest=(${xDest},${yDest}) size=${w}x${h} ` +
            `xSrc=${xSrc} ySrc=${ySrc} StartScan=${StartScan >>> 0} cLines=${cLines} uStartScan=${uStartScan} scanLines=${scanLines}`);

        const result = dibToCanvas(hdc, mem, lpbmi, lpvBits, xDest, yDest, w, h, xSrc, ySrc, w, h, {
            uStartScan,
            scanLines,
        });
        return result ? (cLines >>> 0) : 0;
    };

    // Text and font metrics
    exports['GetTextMetricsA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lptm = args[1];
        Logger.verbose(LogCategory.GDI32, `GetTextMetricsA(hdc=0x${hdc.toString(16)})`);
        if (lptm) {
            writeTextMetrics(hdc, lptm, mem);
        }
        return 1; // success
    };

    exports['GetTextMetricsW'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lptm = args[1];
        Logger.verbose(LogCategory.GDI32, `GetTextMetricsW(hdc=0x${hdc.toString(16)})`);
        if (lptm) {
            writeTextMetrics(hdc, lptm, mem);
        }
        return 1; // success
    };

    exports['GetTextExtentPointA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lpString = args[1];
        const c = args[2];
        const lpsz = args[3];
        const text = Marshaler.readString(mem, lpString).substring(0, c);
        Logger.verbose(LogCategory.GDI32, `GetTextExtentPointA: '${text}'`);
        if (lpsz) {
            measureTextExtent(hdc, text, lpsz, mem);
        }
        return 1; // success
    };

    exports['GetTextExtentPoint32A'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lpString = args[1];
        const c = args[2];
        const lpSize = args[3];
        const text = Marshaler.readString(mem, lpString).substring(0, c);
        Logger.verbose(LogCategory.GDI32, `GetTextExtentPoint32A: hdc=0x${hdc.toString(16)}, '${text}', len=${c}`);
        if (lpSize) {
            measureTextExtent(hdc, text, lpSize, mem);
        }
        return 1; // success
    };

    exports['GetTextExtentPoint32W'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lpString = args[1];
        const c = args[2];
        const lpSize = args[3];
        const text = Marshaler.readWideString(mem, lpString).substring(0, c);
        Logger.verbose(LogCategory.GDI32, `GetTextExtentPoint32W: hdc=0x${hdc.toString(16)}, '${text}', len=${c}`);
        if (lpSize) {
            measureTextExtent(hdc, text, lpSize, mem);
        }
        return 1; // success
    };

    exports['GetTextExtentExPointA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lpString = args[1];
        const cchString = args[2];
        const nMaxExtent = args[3];
        const lpnFit = args[4];
        const lpDx = args[5];
        const lpSize = args[6];
        const text = Marshaler.readString(mem, lpString).substring(0, cchString);
        const gdi = System.getInstance().gdiContext;
        const dcCtx = gdi.getMeasureContext(hdc);

        // Cumulative width after each character (honors the DC's selected font).
        const cum: number[] = new Array(text.length);
        let cy = 16;
        if (dcCtx) {
            try {
                for (let i = 0; i < text.length; i++) {
                    cum[i] = Math.round(dcCtx.measureText(text.substring(0, i + 1)).width);
                }
                const fm = dcCtx.measureText(text || 'Wg');
                if (fm.fontBoundingBoxAscent !== undefined) {
                    cy = Math.ceil(fm.fontBoundingBoxAscent + fm.fontBoundingBoxDescent);
                }
            } catch (_) { /* fall through to 8px/char fallback below */ }
        }
        for (let i = 0; i < text.length; i++) {
            if (cum[i] === undefined) cum[i] = (i + 1) * 8; // fallback
        }

        const cx = text.length > 0 ? cum[text.length - 1] : 0;
        // fitCount = how many leading chars fit within nMaxExtent
        let fitCount = text.length;
        if (nMaxExtent > 0) {
            fitCount = 0;
            for (let i = 0; i < text.length; i++) {
                if (cum[i] <= nMaxExtent) fitCount = i + 1; else break;
            }
        }
        Logger.verbose(LogCategory.GDI32, `GetTextExtentExPointA: '${text}' cx=${cx} fit=${fitCount}`);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (lpnFit) {
            view.setInt32(lpnFit, fitCount, true);
        }
        if (lpDx) {
            for (let i = 0; i < text.length; i++) {
                view.setInt32(lpDx + i * 4, cum[i], true);
            }
        }
        if (lpSize) {
            view.setInt32(lpSize, cx, true);
            view.setInt32(lpSize + 4, cy, true);
        }
        return 1;
    };

    exports['GetCharWidthA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const iFirst = args[1];
        const iLast = args[2];
        const lpBuffer = args[3];
        Logger.verbose(LogCategory.GDI32, `GetCharWidthA(hdc=0x${hdc.toString(16)}, ${iFirst}-${iLast})`);
        if (lpBuffer) {
            const gdi = System.getInstance().gdiContext;
            const dcCtx = gdi.getMeasureContext(hdc);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const count = iLast - iFirst + 1;
            for (let i = 0; i < count; i++) {
                const ch = String.fromCharCode(iFirst + i);
                let width = 8;
                if (dcCtx) {
                    try {
                        width = Math.round(dcCtx.measureText(ch).width);
                        if (width < 1) width = 1;
                    } catch (_) { /* keep fallback */ }
                }
                view.setInt32(lpBuffer + i * 4, width, true);
            }
        }
        return 1; // success
    };

    exports['ExtTextOutA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const options = args[3];
        const lprect = args[4];
        const lpString = args[5];
        const c = args[6];
        const lpDx = args[7];
        const text = Marshaler.readString(mem, lpString).substring(0, c);
        Logger.verbose(LogCategory.GDI32, `ExtTextOutA: '${text}' at (${x},${y}) options=0x${options.toString(16)} lpDx=0x${lpDx.toString(16)}`);

        const gdi = System.getInstance().gdiContext;
        if (lpDx && c > 0) {
            // Per-character spacing: draw each character at explicit X offset
            const dxView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            let curX = x;
            for (let i = 0; i < c; i++) {
                gdi.textOut(hdc, curX, y, text[i]);
                curX += dxView.getInt32(lpDx + i * 4, true);
            }
        } else {
            gdi.textOut(hdc, x, y, text);
        }
        return 1;
    };

    // Bitmap creation
    exports['CreateDIBitmap'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const pbmih = args[1];
        const flInit = args[2];
        const pjBits = args[3];
        const pbmi = args[4];
        const iUsage = args[5];

        Logger.log(LogCategory.GDI32, `CreateDIBitmap: hdc=0x${hdc.toString(16)} pbmih=0x${pbmih.toString(16)} flInit=0x${flInit.toString(16)} pjBits=0x${pjBits.toString(16)} pbmi=0x${pbmi.toString(16)} iUsage=${iUsage}`);

        // Read dimensions from BITMAPINFOHEADER if provided
        let width = 1, height = 1;
        if (pbmih) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            width = view.getInt32(pbmih + 4, true);   // biWidth
            height = Math.abs(view.getInt32(pbmih + 8, true)); // biHeight (can be negative for top-down)
        }
        if (width <= 0) width = 1;
        if (height <= 0) height = 1;

        let pixels = new Uint8Array(width * height * 4);
        pixels.fill(0xFF); // white opaque by default

        // CBM_INIT = 0x04: initialize bitmap pixels from pjBits using pbmi layout
        if ((flInit & 4) && pjBits && pbmi) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const biSize      = view.getUint32(pbmi, true);
            const biWidth     = view.getInt32(pbmi + 4, true);
            const biHeight    = view.getInt32(pbmi + 8, true);
            const biBitCount  = view.getUint16(pbmi + 14, true);
            const biCompression = view.getUint32(pbmi + 16, true);
            const biClrUsed   = view.getUint32(pbmi + 32, true);
            const isTopDown   = biHeight < 0;
            const absH = isTopDown ? -biHeight : biHeight;
            const absW = biWidth > 0 ? biWidth : -biWidth;

            // BI_RLE8 = 1 (8bpp), BI_RLE4 = 2 (4bpp) — run-length encoded scanlines.
            const isRle = (biCompression === 1 && biBitCount === 8) ||
                          (biCompression === 2 && biBitCount === 4);

            if (absW > 0 && absH > 0 && absW <= 4096 && absH <= 4096) {
                // Read palette for <= 8bpp
                let palette: Uint8Array | null = null;
                if (biBitCount <= 8) {
                    const nc = biClrUsed || (1 << biBitCount);
                    palette = new Uint8Array(nc * 4);
                    const palOff = pbmi + biSize;
                    for (let i = 0; i < nc; i++) {
                        const o = palOff + i * 4;
                        palette[i * 4 + 0] = mem[o + 2]; // R (DIB stores BGR)
                        palette[i * 4 + 1] = mem[o + 1]; // G
                        palette[i * 4 + 2] = mem[o + 0]; // B
                        palette[i * 4 + 3] = 255;
                    }
                }

                const rgba = new Uint8Array(absW * absH * 4);

                if (isRle && palette) {
                    // Decompress to a bottom-up 8bpp index buffer, then map through
                    // the palette. RLE DIBs are always bottom-up.
                    const idx = decodeDibRle(mem, pjBits, absW, absH, biCompression === 2);
                    for (let row = 0; row < absH; row++) {
                        const srcScan = absH - 1 - row; // top-down output ← bottom-up scanline
                        const s = srcScan * absW;
                        const dstOff = row * absW * 4;
                        for (let x = 0; x < absW; x++) {
                            const pi = idx[s + x] * 4, di = dstOff + x * 4;
                            rgba[di] = palette[pi]; rgba[di+1] = palette[pi+1];
                            rgba[di+2] = palette[pi+2]; rgba[di+3] = 255;
                        }
                    }
                    width = absW; height = absH; pixels = rgba;
                    const handle = SystemResourceProvider.getInstance().registerUserObject({
                        type: 'BITMAP', name: 0, width, height, loading: false, pixels,
                    });
                    Logger.verbose(LogCategory.GDI32, `CreateDIBitmap(hdc=0x${hdc.toString(16)}, init=0x${flInit.toString(16)}, ${width}x${height}, RLE${biCompression === 2 ? 4 : 8}) -> 0x${handle.toString(16)}`);
                    return handle;
                }

                const rowStride = Math.floor((absW * biBitCount + 31) / 32) * 4;

                for (let row = 0; row < absH; row++) {
                    const srcRow = isTopDown ? row : (absH - 1 - row);
                    const srcOff = pjBits + srcRow * rowStride;
                    const dstOff = row * absW * 4;

                    if (biBitCount === 8 && palette) {
                        for (let x = 0; x < absW; x++) {
                            const idx = mem[srcOff + x];
                            const pi = idx * 4, di = dstOff + x * 4;
                            rgba[di] = palette[pi]; rgba[di+1] = palette[pi+1]; rgba[di+2] = palette[pi+2]; rgba[di+3] = 255;
                        }
                    } else if (biBitCount === 4 && palette) {
                        for (let x = 0; x < absW; x++) {
                            const byteVal = mem[srcOff + (x >> 1)];
                            const idx = (x & 1) === 0 ? (byteVal >> 4) : (byteVal & 0x0F);
                            const pi = idx * 4, di = dstOff + x * 4;
                            rgba[di] = palette[pi]; rgba[di+1] = palette[pi+1]; rgba[di+2] = palette[pi+2]; rgba[di+3] = 255;
                        }
                    } else if (biBitCount === 1 && palette) {
                        for (let x = 0; x < absW; x++) {
                            const byteVal = mem[srcOff + (x >> 3)];
                            const bit = (byteVal >> (7 - (x & 7))) & 1;
                            const pi = bit * 4, di = dstOff + x * 4;
                            rgba[di] = palette[pi]; rgba[di+1] = palette[pi+1]; rgba[di+2] = palette[pi+2]; rgba[di+3] = 255;
                        }
                    } else if (biBitCount === 16) {
                        for (let x = 0; x < absW; x++) {
                            const v = mem[srcOff + x * 2] | (mem[srcOff + x * 2 + 1] << 8);
                            const di = dstOff + x * 4;
                            rgba[di] = ((v >> 11) & 0x1F) * 255 / 31;
                            rgba[di + 1] = ((v >> 5) & 0x3F) * 255 / 63;
                            rgba[di + 2] = (v & 0x1F) * 255 / 31;
                            rgba[di + 3] = 255;
                        }
                    } else if (biBitCount === 24) {
                        for (let x = 0; x < absW; x++) {
                            const si = srcOff + x * 3, di = dstOff + x * 4;
                            rgba[di] = mem[si+2]; rgba[di+1] = mem[si+1]; rgba[di+2] = mem[si]; rgba[di+3] = 255;
                        }
                    } else if (biBitCount === 32) {
                        for (let x = 0; x < absW; x++) {
                            const si = srcOff + x * 4, di = dstOff + x * 4;
                            rgba[di] = mem[si+2]; rgba[di+1] = mem[si+1]; rgba[di+2] = mem[si]; rgba[di+3] = mem[si+3];
                        }
                    } else {
                        Logger.warn(LogCategory.GDI32, `CreateDIBitmap: CBM_INIT unsupported bpp=${biBitCount}`);
                    }
                }
                width = absW; height = absH; pixels = rgba;
            }
        }

        const handle = SystemResourceProvider.getInstance().registerUserObject({
            type: 'BITMAP',
            name: 0,
            width,
            height,
            loading: false,
            pixels,
        });
        Logger.verbose(LogCategory.GDI32, `CreateDIBitmap(hdc=0x${hdc.toString(16)}, init=0x${flInit.toString(16)}, ${width}x${height}) -> 0x${handle.toString(16)}`);
        return handle;
    };

    exports['CreateBitmap'] = (ctx, mem, args): number => {
        const nWidth = args[0];
        const nHeight = args[1];
        const nPlanes = args[2];
        const nBitCount = args[3];
        const lpBits = args[4];
        Logger.log(LogCategory.GDI32, `CreateBitmap(${nWidth}x${nHeight}, planes=${nPlanes}, bpp=${nBitCount})`);

        if (nWidth <= 0 || nHeight <= 0) return 0;

        // Internally we always use 32-bit RGBA regardless of requested bpp
        const pixelDataSize = nWidth * nHeight * 4;
        const pixels = new Uint8Array(pixelDataSize);
        // Initialize to black (0x000000FF = opaque black in RGBA)
        for (let i = 0; i < pixelDataSize; i += 4) {
            pixels[i + 3] = 0xFF; // alpha
        }

        // Initial bits: 1bpp is the canonical case (masks/patterns); rows are
        // WORD-aligned, bit 7 = leftmost pixel, 1 = white.
        let initialized = false;
        if (lpBits && nPlanes === 1 && nBitCount === 1) {
            const stride = ((nWidth + 15) >> 4) * 2;
            if (lpBits + stride * nHeight <= mem.length) {
                for (let y = 0; y < nHeight; y++) {
                    for (let x = 0; x < nWidth; x++) {
                        const bit = (mem[lpBits + y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
                        if (bit) {
                            const o = (y * nWidth + x) * 4;
                            pixels[o] = pixels[o + 1] = pixels[o + 2] = 0xFF;
                        }
                    }
                }
                initialized = true;
            }
        } else if (lpBits) {
            Logger.warn(LogCategory.GDI32, `CreateBitmap: initial bits for ${nBitCount}bpp not decoded`);
        }

        const handle = SystemResourceProvider.getInstance().registerUserObject({
            type: 'BITMAP',
            name: 0,
            width: nWidth,
            height: nHeight,
            loading: false,
            pixels,
            bmBpp: nBitCount,
            // Without initial bits the contents are undefined at birth (like a
            // DDB); the drawn canvas is then the truth for reads
            // (resolveBitmapRgba compatibleEmpty path).
            compatibleEmpty: !initialized,
        });
        Logger.verbose(LogCategory.GDI32, `CreateBitmap(${nWidth}x${nHeight}) -> 0x${handle.toString(16)}`);
        return handle;
    };

    // GetBitmapBits - copies bitmap pixel data into a caller buffer (device format = BGRA for 32-bit)
    exports['GetBitmapBits'] = (ctx, mem, args): number => {
        const hbit = args[0];
        const cb = args[1];       // byte count requested
        const lpvBits = args[2];  // destination buffer in guest memory

        if (!hbit || !lpvBits || cb <= 0) return 0;

        const userObj = SystemResourceProvider.getInstance().getUserObject(hbit);
        if (!userObj || userObj.type !== 'BITMAP') {
            Logger.warn(LogCategory.GDI32, `GetBitmapBits: invalid bitmap 0x${hbit.toString(16)}`);
            return 0;
        }

        // DIBSection path: return raw section bytes (device format in memory).
        const dibBitsPtr = (userObj as any).bitsPtr as number | undefined;
        const dibBitsSize = (userObj as any).bitsSize as number | undefined;
        if (dibBitsPtr && dibBitsSize && dibBitsSize > 0) {
            const toCopy = Math.min(cb, dibBitsSize);
            mem.set(mem.subarray(dibBitsPtr, dibBitsPtr + toCopy), lpvBits);
            Logger.verbose(LogCategory.GDI32, `GetBitmapBits(0x${hbit.toString(16)}, cb=${cb}) [DIBSection] -> ${toCopy}`);
            return toCopy;
        }

        if (!userObj.pixels) {
            Logger.warn(LogCategory.GDI32, `GetBitmapBits: bitmap 0x${hbit.toString(16)} has no pixels`);
            return 0;
        }

        // pixels is RGBA internally; Windows GetBitmapBits returns device bits (BGRA for 32bpp)
        const src = userObj.pixels as Uint8Array;
        const toCopy = Math.min(cb, src.length);
        for (let i = 0; i < toCopy; i += 4) {
            mem[lpvBits + i + 0] = src[i + 2]; // B
            mem[lpvBits + i + 1] = src[i + 1]; // G
            mem[lpvBits + i + 2] = src[i + 0]; // R
            mem[lpvBits + i + 3] = src[i + 3]; // A
        }

        Logger.verbose(LogCategory.GDI32, `GetBitmapBits(0x${hbit.toString(16)}, cb=${cb}) -> ${toCopy}`);
        return toCopy;
    };

    // Device context management
    exports['CreateDCA'] = (ctx, mem, args): number => {
        const pwszDriver = args[0];
        const pwszDevice = args[1];
        const driver = pwszDriver ? Marshaler.readString(mem, pwszDriver) : '';
        const device = pwszDevice ? Marshaler.readString(mem, pwszDevice) : '';
        // Create a standalone memory DC (not tied to screen/overlay canvas) so it's deletable.
        // Games use CreateDCA('DISPLAY') for font metrics, off-screen drawing, then DeleteDC.
        const hdc = System.getInstance().gdiContext.createCompatibleDC(0);
        Logger.verbose(LogCategory.GDI32, `CreateDCA(driver='${driver}', device='${device}') -> 0x${hdc.toString(16)}`);
        return hdc;
    };

    exports['CreateDCW'] = (ctx, mem, args): number => {
        const pwszDriver = args[0];
        const pwszDevice = args[1];
        const driver = pwszDriver ? Marshaler.readWideString(mem, pwszDriver) : '';
        const device = pwszDevice ? Marshaler.readWideString(mem, pwszDevice) : '';
        const hdc = System.getInstance().gdiContext.createCompatibleDC(0);
        Logger.verbose(LogCategory.GDI32, `CreateDCW(driver='${driver}', device='${device}') -> 0x${hdc.toString(16)}`);
        return hdc;
    };

    exports['CreateICA'] = (ctx, mem, args): number => {
        const pwszDriver = args[0];
        const pwszDevice = args[1];
        const driver = pwszDriver ? Marshaler.readString(mem, pwszDriver) : '';
        const device = pwszDevice ? Marshaler.readString(mem, pwszDevice) : '';
        // IC (information context) is used for device caps queries. Create a memory DC
        // so the handle is registered and deletable.
        const hdc = System.getInstance().gdiContext.createCompatibleDC(0);
        Logger.verbose(LogCategory.GDI32, `CreateICA(driver='${driver}', device='${device}') -> 0x${hdc.toString(16)}`);
        return hdc;
    };

    exports['SaveDC'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `SaveDC(hdc=0x${hdc.toString(16)})`);
        // Stub: return saved state ID
        return 1;
    };

    exports['RestoreDC'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const nSavedDC = args[1] | 0; // signed
        Logger.verbose(LogCategory.GDI32, `RestoreDC(hdc=0x${hdc.toString(16)}, savedDC=${nSavedDC})`);
        // Stub: return success
        return 1;
    };

    exports['GetCurrentObject'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const type = args[1];
        const h = System.getInstance().gdiContext.getCurrentObjectHandle(hdc, type);
        Logger.verbose(LogCategory.GDI32,
            `GetCurrentObject(hdc=0x${hdc.toString(16)}, type=${type}) -> 0x${h.toString(16)}`);
        return h >>> 0;
    };

    // BOOL MoveToEx(HDC hdc, int x, int y, LPPOINT lpPoint)
    exports['MoveToEx'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const x = args[1] | 0;
        const y = args[2] | 0;
        const lpPoint = args[3] >>> 0;
        const gdi = System.getInstance().gdiContext;
        if (!gdi.getMeasureContext(hdc)) return 0;
        const old = gdi.setCurrentPosition(hdc, x, y);
        if (lpPoint && lpPoint + 8 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lpPoint, old.x, true);
            view.setInt32(lpPoint + 4, old.y, true);
        }
        return 1;
    };

    // BOOL GetCurrentPositionEx(HDC hdc, LPPOINT lpPoint)
    exports['GetCurrentPositionEx'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const lpPoint = args[1] >>> 0;
        if (!lpPoint || lpPoint + 8 > mem.length) return 0;
        const gdi = System.getInstance().gdiContext;
        if (!gdi.getMeasureContext(hdc)) return 0;
        const pos = gdi.getCurrentPosition(hdc);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt32(lpPoint, pos.x, true);
        view.setInt32(lpPoint + 4, pos.y, true);
        return 1;
    };

    // HPEN CreatePen(int iStyle, int cWidth, COLORREF color)
    exports['CreatePen'] = (ctx, mem, args): number => {
        const style = args[0] | 0;
        const width = args[1] | 0;
        const color = args[2] >>> 0;
        return System.getInstance().gdiContext.createPen(style, width, color) >>> 0;
    };

    // HPEN CreatePenIndirect(const LOGPEN *plpen)
    exports['CreatePenIndirect'] = (ctx, mem, args): number => {
        const plpen = args[0] >>> 0;
        if (!plpen || plpen + LOGPEN_SIZE > mem.length) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return System.getInstance().gdiContext.createPen(
            view.getInt32(plpen + LOGPEN_OFFSETS.lopnStyle, true),
            view.getInt32(plpen + LOGPEN_OFFSETS.lopnWidth_x, true),
            view.getUint32(plpen + LOGPEN_OFFSETS.lopnColor, true),
        ) >>> 0;
    };

    // BOOL LineTo(HDC hdc, int x, int y)
    exports['LineTo'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        return System.getInstance().gdiContext.lineTo(hdc, args[1] | 0, args[2] | 0) ? 1 : 0;
    };

    /** Read cPoints POINTs (2 signed LONGs each) into a flat x,y,... list. */
    const readPoints = (mem: Uint8Array, apt: number, cPoints: number): number[] | null => {
        if (!apt || cPoints <= 0 || apt + cPoints * 8 > mem.length) return null;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const pts = new Array<number>(cPoints * 2);
        for (let i = 0; i < cPoints; i++) {
            pts[i * 2] = view.getInt32(apt + i * 8, true);
            pts[i * 2 + 1] = view.getInt32(apt + i * 8 + 4, true);
        }
        return pts;
    };

    // BOOL Polyline(HDC hdc, const POINT *apt, int cpt) — does NOT use or move the
    // current position; PolylineTo starts at it and leaves it at the last point.
    exports['Polyline'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const pts = readPoints(mem, args[1] >>> 0, args[2] | 0);
        if (!pts || pts.length < 4) return 0;
        return System.getInstance().gdiContext.strokePolyline(hdc, pts) ? 1 : 0;
    };

    exports['PolylineTo'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const gdi = System.getInstance().gdiContext;
        const pts = readPoints(mem, args[1] >>> 0, args[2] | 0);
        if (!pts || pts.length < 2) return 0;
        const from = gdi.getCurrentPosition(hdc);
        const ok = gdi.strokePolyline(hdc, [from.x, from.y, ...pts]);
        gdi.setCurrentPosition(hdc, pts[pts.length - 2], pts[pts.length - 1]);
        return ok ? 1 : 0;
    };

    // BOOL PolyPolyline(HDC hdc, const POINT *apt, const DWORD *asz, DWORD csz) —
    // csz independent polylines laid end to end in apt.
    exports['PolyPolyline'] = (ctx, mem, args): number => {
        const hdc = args[0] >>> 0;
        const apt = args[1] >>> 0;
        const asz = args[2] >>> 0;
        const csz = args[3] >>> 0;
        if (!apt || !asz || !csz || asz + csz * 4 > mem.length) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const gdi = System.getInstance().gdiContext;
        let offset = apt;
        let ok = true;
        for (let i = 0; i < csz; i++) {
            const count = view.getUint32(asz + i * 4, true);
            const pts = readPoints(mem, offset, count);
            if (!pts) return 0;
            if (pts.length >= 4) ok = gdi.strokePolyline(hdc, pts) && ok;
            offset += count * 8;
        }
        return ok ? 1 : 0;
    };

    registerPaintingDcStateExports(exports);
    registerPaintingMiscExports(exports);

    exports['GetCharABCWidthsA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const wFirst = args[1];
        const wLast = args[2];
        const lpABC = args[3];

        Logger.verbose(LogCategory.GDI32, `GetCharABCWidthsA(hdc=0x${hdc.toString(16)}, first=${wFirst}, last=${wLast})`);

        if (!lpABC) return 0;

        const gdi = System.getInstance().gdiContext;
        const dcCtx = gdi.getMeasureContext(hdc);
        const count = wLast - wFirst + 1;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < count; i++) {
            const charCode = wFirst + i;
            const ch = String.fromCharCode(charCode);
            let width = 8; // fallback
            if (dcCtx) {
                try {
                    width = Math.round(dcCtx.measureText(ch).width);
                    if (width < 1) width = 1;
                } catch (_) { /* keep fallback */ }
            }
            const offset = lpABC + i * 12;
            view.setInt32(offset, 0, true);       // abcA (left bearing)
            view.setInt32(offset + 4, width, true); // abcB (character width)
            view.setInt32(offset + 8, 0, true);   // abcC (right bearing)
        }

        return 1; // TRUE
    };

    exports['GetCharABCWidthsW'] = exports['GetCharABCWidthsA'];

    return exports;
}

/**
 * Register high-frequency GDI functions to the Fast Path table.
 * This avoids the overhead of creating X86Context and stack manipulation.
 */
export function registerFastPathGdiFunctions(dispatcher: any): void {
    if (dispatcher && typeof dispatcher.registerFastPath === 'function') {
        // OPTIMIZATION: Cache GDIContext reference to avoid System.getInstance() on every call
        let cachedGdiContext: ReturnType<typeof System.getInstance>['gdiContext'] | null = null;

        // SUPER-FAST PATH: Cache last HDC's pixel buffer to avoid Map lookups on sequential reads
        // Games often scan entire textures: (0,0), (1,0), (2,0)... (255,255)
        // This eliminates Map.get() overhead for 99%+ of calls
        let lastHdc = 0;
        let lastPixels32: Uint32Array | null = null;
        let lastWidth = 0;
        let lastHeight = 0;

        // FastPathImplementation = (cpu, memory) => number
        dispatcher.registerFastPath('gdi32', 'GetPixel', (cpu: any, mem: Uint8Array): number => {
            const esp = cpu.reg32[4];

            // Read arguments directly from stack
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const hdc = view.getUint32(esp + 4, true);
            const x = view.getUint32(esp + 8, true); // Use unsigned for faster bounds check
            const y = view.getUint32(esp + 12, true);

            // Track HDC usage for profiling
            if (profiler.isEnabled()) {
                let stats = getPixelHdcStats.get(hdc);
                if (!stats) {
                    stats = { count: 0, maxX: 0, maxY: 0 };
                    getPixelHdcStats.set(hdc, stats);
                    profiler.increment('GetPixel', 'uniqueHDCs', 1);
                }
                stats.count++;
                if (x > stats.maxX) stats.maxX = x;
                if (y > stats.maxY) stats.maxY = y;
            }

            // SUPER-FAST PATH: Same HDC as last call (99%+ of sequential scans)
            if (hdc === lastHdc && lastPixels32) {
                // Bounds check using unsigned comparison (no branch for negative)
                if (x < lastWidth && y < lastHeight) {
                    return lastPixels32[y * lastWidth + x] & 0x00FFFFFF;
                }
                return 0xFFFFFFFF; // CLR_INVALID
            }

            // Cache miss - need to lookup HDC (happens ~7 times for 7 textures)
            if (!cachedGdiContext) {
                cachedGdiContext = System.getInstance().gdiContext;
            }

            // Get pixel buffer and cache it
            const result = cachedGdiContext.getPixelBuffer(hdc);
            if (result) {
                lastHdc = hdc;
                lastPixels32 = result.pixels32;
                lastWidth = result.width;
                lastHeight = result.height;

                if (x < lastWidth && y < lastHeight) {
                    return lastPixels32[y * lastWidth + x] & 0x00FFFFFF;
                }
            }

            return 0xFFFFFFFF; // CLR_INVALID
        });
    }
}

/**
 * Get detailed GetPixel usage statistics per HDC.
 * Useful for understanding which surfaces are being queried pixel-by-pixel.
 */
export function getGetPixelStats(): Array<{ hdc: number; count: number; maxX: number; maxY: number; estimatedSize: string }> {
    const result: Array<{ hdc: number; count: number; maxX: number; maxY: number; estimatedSize: string }> = [];
    for (const [hdc, stats] of getPixelHdcStats.entries()) {
        result.push({
            hdc,
            count: stats.count,
            maxX: stats.maxX,
            maxY: stats.maxY,
            estimatedSize: `${stats.maxX + 1}x${stats.maxY + 1}`
        });
    }
    // Sort by count descending
    result.sort((a, b) => b.count - a.count);
    return result;
}

/**
 * Clear GetPixel stats (call on profiler reset)
 */
export function clearGetPixelStats(): void {
    getPixelHdcStats.clear();
}
