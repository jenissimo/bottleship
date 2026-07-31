/**
 * GDI blit engine — BitBlt/StretchBlt with ROP-code dispatch, the pristine-source
 * skip, the DDraw-surface fast path, linked-bitmap mirroring, and paired src/dest
 * rect clamping. Each function takes the owning GDIContext as `gdi` and
 * reads/writes its DC state. Pure per-pixel ROP math lives in gdi-raster.ts
 * (applyRopCode); this module is the DC-level orchestration.
 */
import { Logger, LogCategory } from "../../core/logger";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { System } from "../../core/system";
import type { DirectDrawSurfaceState } from "../ddraw/com-objects";
import { isRenderSurface } from "../ddraw/com-objects";
import { convertRGBAToSurface } from "../ddraw/gpu-texture-utils";
import { setAuthorityCpu, surfaceHasActiveWriteLease } from "../ddraw/surface-sync";
import { DDSCAPS_SYSTEMMEMORY, DDSCAPS_PRIMARYSURFACE, DDSCAPS_BACKBUFFER } from "../ddraw/constants";
import { applyRopCode } from './gdi-raster';
import { DEFAULT_BITMAP_HANDLE, cssToColor } from './gdi-objects';
import { resolveDibSectionRectRgba, writeBackDibSectionRect } from './bitmap-resolve';
import type { GDIContext } from './context';

/**
 * DIBSection bits live in guest memory and are written by the app directly
 * (no API call to observe) — re-mirror the blitted source rect into the source
 * DC canvas before the blit reads it. Rect-limited: full-bitmap conversion per
 * blit would dominate frame time on DIB-backbuffer engines. No-op for
 * non-DIBSection sources.
 */
function syncDibSourceDc(
    gdi: GDIContext,
    hdcSrc: number,
    srcCtx: OffscreenCanvasRenderingContext2D | undefined,
    srcState: { hBitmap?: number } | undefined,
    xSrc: number,
    ySrc: number,
    width: number,
    height: number,
): void {
    const hBmp = srcState?.hBitmap;
    if (!hBmp || hBmp === DEFAULT_BITMAP_HANDLE || !srcCtx) return;
    const mem = System.getInstance().process?.getCurrentMemory?.();
    if (!mem) return;
    const fresh = resolveDibSectionRectRgba(hBmp, mem, xSrc, ySrc, width, height);
    if (!fresh) return;
    srcCtx.putImageData(new (ImageData as any)(fresh.data, fresh.width, fresh.height), fresh.x, fresh.y);
    gdi.invalidateImageDataCache(hdcSrc);
}

/** DC color CSS → [r,g,b] via the shared parser (COLORREF is 0x00BBGGRR). */
function cssToRgb(css: string | undefined, fallback: string): [number, number, number] {
    const c = cssToColor(css ?? fallback);
    return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
}

/**
 * Real GDI color→mono (nt5src ylateobj.cxx): a source pixel equal to the
 * SOURCE DC's background color maps to 1 (white); all others map to 0 (black).
 * Our 1bpp bitmaps are RGBA canvases, so the conversion is emulated in RGB.
 */
function blitColorToMono(
    destCtx: OffscreenCanvasRenderingContext2D,
    srcCtx: OffscreenCanvasRenderingContext2D,
    x: number, y: number, width: number, height: number,
    xSrc: number, ySrc: number,
    srcBk: [number, number, number],
): boolean {
    try {
        const src = srcCtx.getImageData(xSrc, ySrc, width, height);
        const out = new ImageData(width, height);
        const s = src.data, d = out.data;
        for (let i = 0; i < s.length; i += 4) {
            const white = s[i] === srcBk[0] && s[i + 1] === srcBk[1] && s[i + 2] === srcBk[2];
            const v = white ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
        destCtx.putImageData(out, x, y);
        return true;
    } catch {
        return false;
    }
}

/**
 * Real GDI mono→color (nt5src ylateobj.cxx, the icon/mask path): a source 0 bit
 * (black) becomes the DESTINATION DC's text color and a 1 bit (white) its background
 * color. Copying the mono canvas through verbatim renders every masked sprite as hard
 * black/white whatever SetTextColor/SetBkColor said.
 */
function blitMonoToColor(
    destCtx: OffscreenCanvasRenderingContext2D,
    srcCtx: OffscreenCanvasRenderingContext2D,
    x: number, y: number, width: number, height: number,
    xSrc: number, ySrc: number,
    fg: [number, number, number],
    bg: [number, number, number],
): boolean {
    try {
        const src = srcCtx.getImageData(xSrc, ySrc, width, height);
        const out = new ImageData(width, height);
        const s = src.data, d = out.data;
        for (let i = 0; i < s.length; i += 4) {
            // The mono canvas stores 0/1 as black/white; anything not black is a 1 bit.
            const one = s[i] !== 0 || s[i + 1] !== 0 || s[i + 2] !== 0;
            const c = one ? bg : fg;
            d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
            d[i + 3] = 255;
        }
        destCtx.putImageData(out, x, y);
        return true;
    } catch {
        return false;
    }
}

/** Mirror a drawn rect of a DC into the DIBSection selected into it (see
 *  writeBackDibSectionRect); no-op for anything else. */
function writeBackDib32(
    destCtx: OffscreenCanvasRenderingContext2D,
    destState: { hBitmap?: number } | undefined,
    x: number, y: number, width: number, height: number,
): void {
    const hBmp = destState?.hBitmap;
    if (!hBmp || hBmp === DEFAULT_BITMAP_HANDLE) return;
    writeBackDibSectionRect(hBmp, destCtx, x, y, width, height);
}

export function bitBlt(gdi: GDIContext, hdcDest: number, x: number, y: number, width: number, height: number,
       hdcSrc: number, xSrc: number, ySrc: number, rop: number): boolean {

    // ROP codes (Raster Operation Codes)
    const SRCCOPY = 0x00CC0020;      // Source copy (simple copy)
    const SRCPAINT = 0x00EE0086;     // Source OR destination
    const SRCAND = 0x008800C6;       // Source AND destination
    const SRCINVERT = 0x00660046;    // Source XOR destination
    const BLACKNESS = 0x00000042;     // All black
    const WHITENESS = 0x00FF0062;    // All white
    const PATCOPY = 0x00F00021;      // Pattern copy (brush only)
    const PATINVERT = 0x005A0049;    // Pattern XOR destination
    const DSTINVERT = 0x00550009;    // Invert destination

    // Check if this ROP requires a source
    const needsSource = rop !== BLACKNESS && rop !== WHITENESS &&
                       rop !== PATCOPY && rop !== PATINVERT && rop !== DSTINVERT;

    const destCtx = gdi.contexts.get(hdcDest);
    const srcCtx = gdi.contexts.get(hdcSrc);

    // Validate HDCs - source is only required for ROPs that use it
    if (!destCtx || (needsSource && !srcCtx)) {
        Logger.warn(LogCategory.GDI32, `bitBlt: Invalid HDC (dest=0x${hdcDest.toString(16)}, src=0x${hdcSrc.toString(16)}, rop=0x${rop.toString(16)})`);
        return false;
    }

    const destState = gdi.hdcStates.get(hdcDest);
    const srcState = gdi.hdcStates.get(hdcSrc);
    if (needsSource) syncDibSourceDc(gdi, hdcSrc, srcCtx, srcState, xSrc, ySrc, width, height);
    // HL launcher: WM_PAINT BitBlt from fresh CreateCompatibleBitmap (all white, no art).
    const sourceHasSelectedBitmap = !!srcState?.hBitmap && srcState.hBitmap !== DEFAULT_BITMAP_HANDLE;
    if (rop === SRCCOPY && srcState?.pristine && destState?.windowBlit) {
        const wb = destState.windowBlit;
        if (width >= wb.width && height >= wb.height) {
            destState.skipOverlayFlush = true;
        }
        Logger.verbose(LogCategory.GDI32,
            `bitBlt: skip pristine src 0x${hdcSrc.toString(16)} -> window 0x${hdcDest.toString(16)} ` +
            `(${width}x${height}) selBmp=${sourceHasSelectedBitmap ? 1 : 0}`);
        return true;
    }

    // Handle source-less ROPs early if no source context
    if (!srcCtx) {
        if (rop === BLACKNESS) {
            destCtx.fillStyle = '#000000';
            destCtx.fillRect(x, y, width, height);
            writeBackDib32(destCtx, destState, x, y, width, height);
            gdi.expandDirtyRect(hdcDest, x, y, width, height);
            gdi.markDirty(hdcDest);
            gdi.invalidateImageDataCache(hdcDest);
            return true;
        } else if (rop === WHITENESS) {
            destCtx.fillStyle = '#FFFFFF';
            destCtx.fillRect(x, y, width, height);
            writeBackDib32(destCtx, destState, x, y, width, height);
            gdi.expandDirtyRect(hdcDest, x, y, width, height);
            gdi.markDirty(hdcDest);
            gdi.invalidateImageDataCache(hdcDest);
            return true;
        } else if (rop === DSTINVERT) {
            try {
                const imageData = destCtx.getImageData(x, y, width, height);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = 255 - data[i];
                    data[i + 1] = 255 - data[i + 1];
                    data[i + 2] = 255 - data[i + 2];
                }
                destCtx.putImageData(imageData, x, y);
                writeBackDib32(destCtx, destState, x, y, width, height);
                gdi.expandDirtyRect(hdcDest, x, y, width, height);
                gdi.markDirty(hdcDest);
                gdi.invalidateImageDataCache(hdcDest);
                return true;
            } catch (e) {
                Logger.warn(LogCategory.GDI32, `bitBlt: DSTINVERT failed: ${e}`);
                return false;
            }
        }
        Logger.warn(LogCategory.GDI32, `bitBlt: ROP 0x${rop.toString(16)} requires pattern/brush - not implemented`);
        return false;
    }

    try {
        const srcCanvas = srcCtx.canvas;
        if (!srcCanvas) return false;

        // Check if dest is overlay DC (linked to DDraw surface)
        const isOverlayDest = destCtx === gdi.overlayCtx;

        // Save current composite operation
        const savedCompositeOp = destCtx.globalCompositeOperation;

        // Format conversion, both directions: GDI translates through the DC colors
        // whenever exactly one side is 1bpp (CreateBitmap planes=1).
        const provider = SystemResourceProvider.getInstance();
        const destBmp = destState?.hBitmap ? provider.getUserObject(destState.hBitmap) : null;
        const srcBmp = srcState?.hBitmap ? provider.getUserObject(srcState.hBitmap) : null;
        const destIsMono = destBmp?.type === 'BITMAP' && destBmp.bmBpp === 1;
        const srcIsMono = srcBmp?.type === 'BITMAP' && srcBmp.bmBpp === 1;

        let monoConverted = false;
        if (rop === SRCCOPY && destIsMono && !srcIsMono) {
            monoConverted = blitColorToMono(destCtx, srcCtx, x, y, width, height, xSrc, ySrc,
                cssToRgb(srcState?.bkColor, '#ffffff'));
        } else if (rop === SRCCOPY && srcIsMono && !destIsMono) {
            monoConverted = blitMonoToColor(destCtx, srcCtx, x, y, width, height, xSrc, ySrc,
                cssToRgb(destState?.textColor, '#000000'),
                cssToRgb(destState?.bkColor, '#ffffff'));
        }

        if (monoConverted) {
            // handled above
        } else if (rop === SRCCOPY) {
            // Simple copy (default behavior)
            destCtx.drawImage(
                srcCanvas,
                xSrc, ySrc, width, height,  // Source rectangle
                x, y, width, height         // Destination rectangle
            );
        } else if (rop === SRCINVERT || rop === SRCAND || rop === SRCPAINT) {
            // Use pixel-perfect bitwise operations for critical ROP codes
            const clamped = clampRectPairForCanvas(srcCtx, destCtx, {
                xSrc,
                ySrc,
                wSrc: width,
                hSrc: height,
                xDest: x,
                yDest: y,
                wDest: width,
                hDest: height,
            });
            if (clamped) {
                applyRopCode(
                    destCtx,
                    srcCtx,
                    rop,
                    clamped.xDest,
                    clamped.yDest,
                    clamped.wDest,
                    clamped.hDest,
                    clamped.xSrc,
                    clamped.ySrc,
                    clamped.wSrc,
                    clamped.hSrc
                );
            }
        } else if (rop === BLACKNESS) {
            // Fill with black
            destCtx.fillStyle = '#000000';
            destCtx.fillRect(x, y, width, height);
        } else if (rop === WHITENESS) {
            // Fill with white
            destCtx.fillStyle = '#FFFFFF';
            destCtx.fillRect(x, y, width, height);
        } else {
            // Unknown ROP code - fallback to SRCCOPY
            Logger.warn(LogCategory.GDI32, `bitBlt: Unknown ROP code 0x${rop.toString(16)}, using SRCCOPY`);
            destCtx.drawImage(
                srcCanvas,
                xSrc, ySrc, width, height,
                x, y, width, height
            );
        }

        // Mark overlay as dirty if we're drawing to it
        if (isOverlayDest) {
            gdi.setOverlayDirty(true);
        }

        // Invalidate image data cache after drawing
        gdi.invalidateImageDataCache(hdcDest);

        writeBackDib32(destCtx, destState, x, y, width, height);

        // If dest is a memory DC with linked bitmap, update the bitmap canvas
        const linkedBitmap = (destCtx.canvas as any).__bitmapCanvas;
        if (linkedBitmap) {
            const bitmapCtx = linkedBitmap.getContext('2d');
            if (bitmapCtx) {
                // Apply same operation to bitmap canvas
                if (monoConverted) {
                    bitmapCtx.drawImage(destCtx.canvas, x, y, width, height, x, y, width, height);
                } else if (rop === SRCCOPY) {
                    bitmapCtx.drawImage(srcCanvas, xSrc, ySrc, width, height, x, y, width, height);
                } else if (rop === SRCINVERT || rop === SRCAND || rop === SRCPAINT) {
                    applyRopCode(
                        bitmapCtx as OffscreenCanvasRenderingContext2D,
                        srcCtx,
                        rop,
                        x, y, width, height,
                        xSrc, ySrc, width, height
                    );
                } else if (rop === BLACKNESS) {
                    bitmapCtx.fillStyle = '#000000';
                    bitmapCtx.fillRect(x, y, width, height);
                } else if (rop === WHITENESS) {
                    bitmapCtx.fillStyle = '#FFFFFF';
                    bitmapCtx.fillRect(x, y, width, height);
                }
            }
        }

        // Mark as dirty for ReleaseDC optimization
        gdi.expandDirtyRect(hdcDest, x, y, width, height);
        gdi.markDirty(hdcDest);

        Logger.verbose(LogCategory.GDI32, `bitBlt: (${xSrc},${ySrc}) ${width}x${height} -> (${x},${y}), rop=0x${rop.toString(16)}, overlay=${isOverlayDest}`);
        return true;
    } catch (e) {
        Logger.warn(LogCategory.GDI32, `bitBlt: Error: ${e}`);
        return false;
    }
}

export function stretchBlt(gdi: GDIContext, hdcDest: number, xDest: number, yDest: number, wDest: number, hDest: number,
           hdcSrc: number, xSrc: number, ySrc: number, wSrc: number, hSrc: number, rop: number): boolean {

    // ROP codes that don't require a source HDC
    const BLACKNESS = 0x00000042;     // All black
    const WHITENESS = 0x00FF0062;    // All white
    const PATCOPY = 0x00F00021;      // Pattern copy (brush only)
    const PATINVERT = 0x005A0049;    // Pattern XOR destination
    const DSTINVERT = 0x00550009;    // Invert destination

    // Check if this ROP requires a source
    const needsSource = rop !== BLACKNESS && rop !== WHITENESS &&
                       rop !== PATCOPY && rop !== PATINVERT && rop !== DSTINVERT;

    let destCtx = gdi.contexts.get(hdcDest);
    const srcCtx = gdi.contexts.get(hdcSrc);

    // If destCtx is not found, try to get it via linkedSurface (for DDraw surfaces)
    if (!destCtx) {
        const linkedSurfacePtr = gdi.getLinkedSurface(hdcDest);
        if (linkedSurfacePtr) {
            // Try to find the HDC that's linked to this surface
            // This can happen if HDC was recreated but the link still exists
            for (const [hdc, ctx] of gdi.contexts.entries()) {
                if (gdi.getLinkedSurface(hdc) === linkedSurfacePtr) {
                    destCtx = ctx;
                    Logger.verbose(LogCategory.GDI32, `stretchBlt: Found destCtx via linkedSurface: hdcDest=0x${hdcDest.toString(16)} -> hdc=0x${hdc.toString(16)}`);
                    break;
                }
            }
        }
    }

    // Validate HDCs - source is only required for ROPs that use it
    if (!destCtx || (needsSource && !srcCtx)) {
        const destValid = !!destCtx;
        const srcValid = !!srcCtx;
        const allHdcs = Array.from(gdi.contexts.keys()).map(h => `0x${h.toString(16)}`).join(', ');
        Logger.warn(LogCategory.GDI32,
            `stretchBlt: Invalid HDC - hdcDest=0x${hdcDest.toString(16)} (${destValid ? 'valid' : 'INVALID'}) ` +
            `hdcSrc=0x${hdcSrc.toString(16)} (${srcValid ? 'valid' : 'INVALID'}) rop=0x${rop.toString(16)} ` +
            `registered HDCs: [${allHdcs}]`
        );

        // WORKAROUND: If hdcSrc=0 with SRCCOPY, fill destination with black and return success
        // This helps games that don't check return values to continue past loading screens
        const SRCCOPY = 0x00CC0020;
        if (hdcSrc === 0 && rop === SRCCOPY && destCtx) {
            Logger.warn(LogCategory.GDI32,
                `stretchBlt: WORKAROUND - hdcSrc=0 with SRCCOPY, filling dest with black`);
            destCtx.fillStyle = '#000000';
            destCtx.fillRect(xDest, yDest, wDest, hDest);
            writeBackDib32(destCtx, gdi.hdcStates.get(hdcDest), xDest, yDest, wDest, hDest);
            gdi.markDirty(hdcDest);
            gdi.invalidateImageDataCache(hdcDest);
            return true; // Pretend success to unblock the game
        }

        return false;
    }

    if (needsSource) syncDibSourceDc(gdi, hdcSrc, srcCtx, gdi.hdcStates.get(hdcSrc), xSrc, ySrc, wSrc, hSrc);

    // Handle source-less ROPs early if no source context
    if (!srcCtx) {
        if (rop === BLACKNESS) {
            destCtx.fillStyle = '#000000';
            destCtx.fillRect(xDest, yDest, wDest, hDest);
            writeBackDib32(destCtx, gdi.hdcStates.get(hdcDest), xDest, yDest, wDest, hDest);
            gdi.markDirty(hdcDest);
            gdi.invalidateImageDataCache(hdcDest);
            return true;
        } else if (rop === WHITENESS) {
            destCtx.fillStyle = '#FFFFFF';
            destCtx.fillRect(xDest, yDest, wDest, hDest);
            writeBackDib32(destCtx, gdi.hdcStates.get(hdcDest), xDest, yDest, wDest, hDest);
            gdi.markDirty(hdcDest);
            gdi.invalidateImageDataCache(hdcDest);
            return true;
        } else if (rop === DSTINVERT) {
            // Invert destination - need to read, invert, write
            try {
                const imageData = destCtx.getImageData(xDest, yDest, wDest, hDest);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = 255 - data[i];       // R
                    data[i + 1] = 255 - data[i + 1]; // G
                    data[i + 2] = 255 - data[i + 2]; // B
                    // Alpha stays the same
                }
                destCtx.putImageData(imageData, xDest, yDest);
                writeBackDib32(destCtx, gdi.hdcStates.get(hdcDest), xDest, yDest, wDest, hDest);
                gdi.markDirty(hdcDest);
                gdi.invalidateImageDataCache(hdcDest);
                return true;
            } catch (e) {
                Logger.warn(LogCategory.GDI32, `stretchBlt: DSTINVERT failed: ${e}`);
                return false;
            }
        }
        // PATCOPY and PATINVERT would need brush handling - stub for now
        Logger.warn(LogCategory.GDI32, `stretchBlt: ROP 0x${rop.toString(16)} requires pattern/brush - not implemented`);
        return false;
    }

    try {
        const srcCanvas = srcCtx.canvas;
        if (!srcCanvas) {
            return false;
        }

        const isOverlayDest = destCtx === gdi.overlayCtx;

        // OPTIMIZATION: Skip slow "fast-path" for overlay destinations during splash screens.
        // Canvas API's native drawImage() with scaling is MUCH faster than our manual
        // nearest-neighbor loop. Only use fast-path for actual DirectDraw surfaces.
        if (isOverlayDest) {
            // Use native Canvas scaling (much faster!)
            if (rop === 0x00CC0020) { // SRCCOPY
                destCtx.drawImage(srcCanvas, xSrc, ySrc, wSrc, hSrc, xDest, yDest, wDest, hDest);
                gdi.setOverlayDirty(true);
                const destState = gdi.hdcStates.get(hdcDest);
                if (destState) {
                    destState.dirty = true;
                    destState.imageDataDirty = true;
                }
                Logger.verbose(LogCategory.GDI32, `stretchBlt: Overlay fast-path with native scaling src(${xSrc},${ySrc}) ${wSrc}x${hSrc} -> dest(${xDest},${yDest}) ${wDest}x${hDest}`);
                return true;
            }
            // Fall through to normal path for complex ROPs
        }

        // FAST-PATH: Direct pixel blitting to DirectDraw surface memory
        // Bypass Canvas API for non-overlay destinations
        const linkedSurfacePtr = gdi.getLinkedSurface(hdcDest);

        // Try to find bitmap handle from memory DC
        // Bitmap can be stored in:
        // 1. __bitmapHandle (if srcCtx is bitmapDC)
        // 2. __linkedBitmap (if srcCtx is memory DC with selected bitmap)
        // 3. state.hBitmap (from hdcStates)
        let srcBitmapHandle = (srcCtx.canvas as any).__bitmapHandle;
        if (!srcBitmapHandle) {
            srcBitmapHandle = (srcCtx.canvas as any).__linkedBitmap;
        }
        if (!srcBitmapHandle) {
            const srcState = gdi.hdcStates.get(hdcSrc);
            if (srcState) {
                srcBitmapHandle = srcState.hBitmap;
            }
        }

        if (linkedSurfacePtr && rop === 0x00CC0020) { // SRCCOPY only for now
            if (srcBitmapHandle && srcBitmapHandle !== 0) {
                const userObj = SystemResourceProvider.getInstance().getUserObject(srcBitmapHandle);

                // Only use fast-path if bitmap is fully loaded
                if (userObj && userObj.type === 'BITMAP' && userObj.pixels && !userObj.loading) {
                    const fastPathStartTime = performance.now();
                    Logger.verbose(LogCategory.GDI32,
                        `stretchBlt: Using FAST-PATH (Canvas scaling) for bitmap→surface ` +
                        `src=${wSrc}x${hSrc} → dest=${wDest}x${hDest} linkedSurface=0x${linkedSurfacePtr.toString(16)}`
                    );
                    try {
                        const system = System.getInstance();
                        const resourceProvider = system.resourceProvider;
                        const surfaceObj = resourceProvider.getComObjectByAddress(linkedSurfacePtr) as any;
                        if (surfaceObj && surfaceObj.getState) {
                            const surfaceState = surfaceObj.getState() as DirectDrawSurfaceState;
                            // Get memory from process (same way as in ddraw-backend-executor.ts)
                            const process = system.process;
                            if (!process) {
                                throw new Error("No process available");
                            }
                            const mem = process.getCurrentMemory();

                            if (mem && surfaceState.surfacePtr && surfaceState.format) {
                                // OPTIMIZATION: Different strategies for backbuffer vs textures
                                // Backbuffer: canvas only (ReleaseDC → GPU upload)
                                // Textures: canvas + CPU memory (may be read via Lock/Unlock)

                                // Update dest canvas directly with scaled source (always fast!)
                                destCtx.drawImage(srcCanvas, xSrc, ySrc, wSrc, hSrc, xDest, yDest, wDest, hDest);

                                const isSysMem = (surfaceState.caps & DDSCAPS_SYSTEMMEMORY) !== 0;
                                const isPrimary = (surfaceState.caps & DDSCAPS_PRIMARYSURFACE) !== 0;
                                const isBackBuffer = (surfaceState.caps & DDSCAPS_BACKBUFFER) !== 0;
                                const needsCpuCopy = isSysMem;
                                if (needsCpuCopy && surfaceHasActiveWriteLease(surfaceState)) {
                                    // Lease guard: the SYSMEM CPU copy writes surface pixel
                                    // memory. Skip while the guest holds a writable Lock lease on
                                    // the destination surface to avoid racing its own writes.
                                    Logger.warn(LogCategory.GDI32,
                                        `stretchBlt: SKIP CPU copy - surface 0x${surfaceState.surfacePtr.toString(16)} is locked for writing (active write lease)`);
                                } else if (needsCpuCopy) {
                                    // Get RGBA data from source bitmap
                                    const userObj = SystemResourceProvider.getInstance().getUserObject(srcBitmapHandle);
                                    if (userObj && userObj.pixels) {
                                        const rgbaData = new Uint8ClampedArray(userObj.pixels.buffer, userObj.pixels.byteOffset, userObj.pixels.length);

                                        // DEBUG: Find pixel where R != B to detect RGB/BGR swap
                                        const totalPixels = rgbaData.length / 4;
                                        let debugPixelFound = false;
                                        for (let i = 0; i < rgbaData.length - 3; i += 4) {
                                            const r = rgbaData[i], g = rgbaData[i+1], b = rgbaData[i+2];
                                            // Find pixel where R and B differ significantly
                                            if (Math.abs(r - b) > 30 && (r > 20 || b > 20)) {
                                                const pixelIdx = i / 4;
                                                Logger.warn(LogCategory.GDI32,
                                                    `stretchBlt: userObj.pixels pixel[${pixelIdx}] RGBA = [${r}, ${g}, ${b}, ${rgbaData[i+3]}] ` +
                                                    `(R-B diff=${r-b}) bitmap=0x${srcBitmapHandle.toString(16)} size=${userObj.width}x${userObj.height}`);
                                                debugPixelFound = true;
                                                break;
                                            }
                                        }
                                        if (!debugPixelFound) {
                                            Logger.warn(LogCategory.GDI32,
                                                `stretchBlt: No R!=B pixel found, totalPixels=${totalPixels}`);
                                        }

                                        // Convert and copy to surface CPU memory (RGBA32 -> RGB565 or whatever format)
                                        convertRGBAToSurface(rgbaData, mem, surfaceState.surfacePtr, surfaceState.width, surfaceState.height, surfaceState.pitch, surfaceState.format, { clearAlphaBit: true });

                                        // Mark CPU authority FIRST to prevent race condition
                                        setAuthorityCpu(surfaceState);

                                        // Update rgbaScratch with source RGBA data for GPU sync
                                        // Without this, GPU sync may use stale cached rgbaScratch or convert
                                        // from guest memory (RGB565), both of which can cause color issues.
                                        // Note: This copies the ORIGINAL bitmap size - if surface size differs,
                                        // syncActiveGdiContext will update with scaled Canvas data on ReleaseDC.
                                        const expectedSize = surfaceState.width * surfaceState.height * 4;
                                        if (rgbaData.length >= expectedSize) {
                                            // Must copy, not view - userObj.pixels may be reused
                                            const newScratch = new Uint8Array(expectedSize);
                                            newScratch.set(new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, expectedSize));
                                            surfaceState.rgbaScratch = newScratch;
                                            if (isRenderSurface(surfaceState)) {
                                                surfaceState.rgbaScratchVersion = surfaceState.version; // Now matches version from setAuthorityCpu
                                            }
                                            Logger.log(LogCategory.GDI32,
                                                `stretchBlt: Updated rgbaScratch (${expectedSize} bytes) from userObj.pixels`);
                                        } else {
                                            // Bitmap smaller than surface - invalidate to force Canvas-based sync
                                            surfaceState.rgbaScratch = undefined;
                                            if (isRenderSurface(surfaceState)) {
                                                surfaceState.rgbaScratchVersion = undefined;
                                            }
                                            Logger.log(LogCategory.GDI32,
                                                `stretchBlt: Invalidated rgbaScratch (bitmap ${rgbaData.length} < surface ${expectedSize})`);
                                        }
                                        Logger.verbose(LogCategory.GDI32,
                                            `stretchBlt: Copied bitmap 0x${srcBitmapHandle.toString(16)} to SYSMEM texture CPU memory ` +
                                            `surfacePtr=0x${surfaceState.surfacePtr.toString(16)} format=${surfaceState.format.bpp}bpp`
                                        );
                                    }
                                } else {
                                    Logger.verbose(LogCategory.GDI32,
                                        `stretchBlt: Canvas-only path (deferred GPU sync via ReleaseDC) ` +
                                        `${isBackBuffer ? 'BACKBUFFER' : isPrimary ? 'PRIMARY' : 'TEXTURE'}`
                                    );
                                }

                                // Mark surface state to track canvas changes
                                const destState = gdi.hdcStates.get(hdcDest);
                                if (destState) {
                                    gdi.expandDirtyRect(hdcDest, xDest, yDest, wDest, hDest);
                                    destState.dirty = true;
                                    destState.imageDataDirty = true;
                                }

                                if (isOverlayDest) {
                                    gdi.setOverlayDirty(true);
                                }

                                // Canvas changed, invalidate cache even if we skip ReleaseDC sync.
                                gdi.invalidateImageDataCache(hdcDest);

                                const fastPathTime = performance.now() - fastPathStartTime;
                                Logger.verbose(LogCategory.GDI32,
                                    `stretchBlt: FAST-PATH completed in ${fastPathTime.toFixed(2)}ms ` +
                                    `(Canvas only - deferred GPU sync via ReleaseDC)`
                                );
                                return true; // Success - bypass Canvas API
                            }
                        }
                    } catch (e) {
                        Logger.warn(LogCategory.GDI32, `stretchBlt: Fast-path failed, falling back to Canvas: ${e}`);
                    }
                }
            }
        }

        // FALLBACK PATH: Use Canvas API for non-surface destinations or when fast-path unavailable
        const fallbackStartTime = performance.now();
        Logger.verbose(LogCategory.GDI32,
            `stretchBlt: Using FALLBACK (Canvas API) src=${wSrc}x${hSrc} → dest=${wDest}x${hDest} ` +
            `isOverlay=${isOverlayDest} linkedSurface=${linkedSurfacePtr ? '0x' + linkedSurfacePtr.toString(16) : 'none'}`
        );

        // ROP codes (Raster Operation Codes)
        const SRCCOPY = 0x00CC0020;      // Source copy (simple copy)
        const SRCPAINT = 0x00EE0086;     // Source OR destination
        const SRCAND = 0x008800C6;       // Source AND destination
        const SRCINVERT = 0x00660046;    // Source XOR destination
        const BLACKNESS = 0x00000042;     // All black
        const WHITENESS = 0x00FF0062;    // All white

        // Save current composite operation
        const savedCompositeOp = destCtx.globalCompositeOperation;

        if (rop === SRCCOPY) {
            // Simple copy (default behavior)
            destCtx.drawImage(
                srcCanvas,
                xSrc, ySrc, wSrc, hSrc,  // Source rectangle
                xDest, yDest, wDest, hDest // Destination rectangle
            );

        } else if (rop === SRCINVERT || rop === SRCAND || rop === SRCPAINT) {
            // Use pixel-perfect bitwise operations for critical ROP codes
            const clamped = clampRectPairForCanvas(srcCtx, destCtx, {
                xSrc,
                ySrc,
                wSrc,
                hSrc,
                xDest,
                yDest,
                wDest,
                hDest,
            });
            if (clamped) {
                applyRopCode(
                    destCtx,
                    srcCtx,
                    rop,
                    clamped.xDest,
                    clamped.yDest,
                    clamped.wDest,
                    clamped.hDest,
                    clamped.xSrc,
                    clamped.ySrc,
                    clamped.wSrc,
                    clamped.hSrc
                );
            }
        } else if (rop === BLACKNESS) {
            // Fill with black
            destCtx.fillStyle = '#000000';
            destCtx.fillRect(xDest, yDest, wDest, hDest);
        } else if (rop === WHITENESS) {
            // Fill with white
            destCtx.fillStyle = '#FFFFFF';
            destCtx.fillRect(xDest, yDest, wDest, hDest);
        } else {
            // Unknown ROP code - fallback to SRCCOPY
            Logger.warn(LogCategory.GDI32, `stretchBlt: Unknown ROP code 0x${rop.toString(16)}, using SRCCOPY`);
            destCtx.drawImage(
                srcCanvas,
                xSrc, ySrc, wSrc, hSrc,
                xDest, yDest, wDest, hDest
            );
        }

        // Mark overlay as dirty if we're drawing to it
        if (isOverlayDest) {
            gdi.setOverlayDirty(true);
        }

        writeBackDib32(destCtx, gdi.hdcStates.get(hdcDest), xDest, yDest, wDest, hDest);

        // Mark as dirty for ReleaseDC optimization
        gdi.expandDirtyRect(hdcDest, xDest, yDest, wDest, hDest);
        gdi.markDirty(hdcDest);

        // Invalidate image data cache after drawing
        gdi.invalidateImageDataCache(hdcDest);

        // If dest is a memory DC with linked bitmap, update the bitmap canvas
        const linkedBitmap = (destCtx.canvas as any).__bitmapCanvas;
        if (linkedBitmap) {
            const bitmapCtx = linkedBitmap.getContext('2d');
            if (bitmapCtx) {
                // Apply same operation to bitmap canvas
                if (rop === SRCCOPY) {
                    bitmapCtx.drawImage(srcCanvas, xSrc, ySrc, wSrc, hSrc, xDest, yDest, wDest, hDest);
                } else if (rop === SRCINVERT || rop === SRCAND || rop === SRCPAINT) {
                    applyRopCode(
                        bitmapCtx as OffscreenCanvasRenderingContext2D,
                        srcCtx,
                        rop,
                        xDest, yDest, wDest, hDest,
                        xSrc, ySrc, wSrc, hSrc
                    );
                } else if (rop === BLACKNESS) {
                    bitmapCtx.fillStyle = '#000000';
                    bitmapCtx.fillRect(xDest, yDest, wDest, hDest);
                } else if (rop === WHITENESS) {
                    bitmapCtx.fillStyle = '#FFFFFF';
                    bitmapCtx.fillRect(xDest, yDest, wDest, hDest);
                }
            }
        }

        const fallbackTime = performance.now() - fallbackStartTime;
        Logger.log(LogCategory.GDI32,
            `stretchBlt: FALLBACK completed in ${fallbackTime.toFixed(2)}ms ` +
            `(Canvas API) src(${xSrc},${ySrc}) ${wSrc}x${hSrc} → dest(${xDest},${yDest}) ${wDest}x${hDest} ` +
            `rop=0x${rop.toString(16)} overlay=${isOverlayDest}`
        );
        return true;
    } catch (e) {
        Logger.warn(LogCategory.GDI32, `stretchBlt: Error: ${e}`);
        return false;
    }
}

/**
 * Clamp paired source/destination rectangles to canvas bounds while keeping sizes in sync.
 */
function clampRectPairForCanvas(
    srcCtx: OffscreenCanvasRenderingContext2D,
    destCtx: OffscreenCanvasRenderingContext2D,
    rect: { xSrc: number; ySrc: number; wSrc: number; hSrc: number; xDest: number; yDest: number; wDest: number; hDest: number; }
): { xSrc: number; ySrc: number; wSrc: number; hSrc: number; xDest: number; yDest: number; wDest: number; hDest: number; } | null {
    let { xSrc, ySrc, wSrc, hSrc, xDest, yDest, wDest, hDest } = rect;

    // Normalize negative source coords by shifting both rects
    if (xSrc < 0) {
        const d = -xSrc;
        xSrc = 0; xDest += d; wSrc -= d; wDest -= d;
    }
    if (ySrc < 0) {
        const d = -ySrc;
        ySrc = 0; yDest += d; hSrc -= d; hDest -= d;
    }
    // Normalize negative dest coords
    if (xDest < 0) {
        const d = -xDest;
        xDest = 0; xSrc += d; wSrc -= d; wDest -= d;
    }
    if (yDest < 0) {
        const d = -yDest;
        yDest = 0; ySrc += d; hSrc -= d; hDest -= d;
    }

    // Clip to right/bottom bounds
    wSrc = Math.min(wSrc, srcCtx.canvas.width - xSrc);
    hSrc = Math.min(hSrc, srcCtx.canvas.height - ySrc);
    wDest = Math.min(wDest, destCtx.canvas.width - xDest);
    hDest = Math.min(hDest, destCtx.canvas.height - yDest);

    // Keep rectangles size-aligned
    const w = Math.min(wSrc, wDest);
    const h = Math.min(hSrc, hDest);

    if (w <= 0 || h <= 0) return null;

    return {
        xSrc,
        ySrc,
        wSrc: w,
        hSrc: h,
        xDest,
        yDest,
        wDest: w,
        hDest: h
    };
}
