/**
 * GDI object store — brush/pen/font/bitmap object creation, GetObject queries,
 * DeleteObject, stock-object resolution and COLORREF↔CSS conversion. Each
 * function takes the owning GDIContext as `gdi` and operates on its
 * object/handle tables. DC/bitmap state relationships (SelectObject, memory-DC
 * canvas linking) stay in context.ts — this module is only the object registry.
 */
import { Logger, LogCategory } from "../../core/logger";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { System } from "../../core/system";
import { resolveWindowsFontName } from './font-map';
import type { GDIContext, GDIObject } from './context';

// Stock object IDs (Windows GDI constants)
export const STOCK_WHITE_BRUSH = 0;
export const STOCK_LTGRAY_BRUSH = 1;
export const STOCK_GRAY_BRUSH = 2;
export const STOCK_DKGRAY_BRUSH = 3;
export const STOCK_BLACK_BRUSH = 4;
export const STOCK_NULL_BRUSH = 5;
export const STOCK_WHITE_PEN = 6;
export const STOCK_BLACK_PEN = 7;
export const STOCK_NULL_PEN = 8;
export const STOCK_OEM_FIXED_FONT = 10;
export const STOCK_ANSI_FIXED_FONT = 11;
export const STOCK_ANSI_VAR_FONT = 12;
export const STOCK_SYSTEM_FONT = 13;
export const STOCK_DEVICE_DEFAULT_FONT = 14;
export const STOCK_DEFAULT_PALETTE = 15;
export const STOCK_SYSTEM_FIXED_FONT = 16;
export const STOCK_DEFAULT_GUI_FONT = 17;
// Default 1x1 monochrome bitmap selected into fresh memory DCs (Windows behavior)
export const STOCK_DEFAULT_BITMAP = 9;
export const DEFAULT_BITMAP_HANDLE = 0x80000000 | STOCK_DEFAULT_BITMAP;

// Pen styles (wingdi.h). PS_SOLID..PS_INSIDEFRAME are the CreatePen range; the
// PS_USERSTYLE/PS_ALTERNATE styles above it are ExtCreatePen-only. The geometry that
// consumes them lives in gdi-lines.ts.
export const PS_SOLID = 0;
export const PS_DASH = 1;
export const PS_DOT = 2;
export const PS_DASHDOT = 3;
export const PS_DASHDOTDOT = 4;
export const PS_NULL = 5;
export const PS_INSIDEFRAME = 6;
export const PS_STYLE_MASK = 0x0000000F;

// LOGPEN { UINT lopnStyle; POINT lopnWidth; COLORREF lopnColor } — 16 bytes.
// CreatePenIndirect reads it, GetObject(OBJ_PEN) writes it; checked in
// tools/validate-struct-offsets.ts.
export const LOGPEN_OFFSETS = {
    lopnStyle: 0x00,
    lopnWidth_x: 0x04,
    lopnWidth_y: 0x08,
    lopnColor: 0x0C,
} as const;
export const LOGPEN_SIZE = 0x10;

export interface PatternBrushData {
    kind: 'pattern';
    sourceBitmap: number;
    tileCanvas: OffscreenCanvas;
}

/**
 * Check if handle is a stock object
 */
export function isStockObject(handle: number): boolean {
    return (handle & 0x80000000) !== 0;
}

/**
 * Get stock object data by stock ID
 * Returns GDIObject for stock objects or null if invalid
 */
export function getStockObject(objectId: number): GDIObject | null {
    const stockId = objectId & 0x7FFFFFFF; // Remove stock object flag

    switch (stockId) {
        case STOCK_WHITE_BRUSH:
            return { handle: objectId, type: 'BRUSH', data: '#FFFFFF' };
        case STOCK_LTGRAY_BRUSH:
            return { handle: objectId, type: 'BRUSH', data: '#C0C0C0' };
        case STOCK_GRAY_BRUSH:
            return { handle: objectId, type: 'BRUSH', data: '#808080' };
        case STOCK_DKGRAY_BRUSH:
            return { handle: objectId, type: 'BRUSH', data: '#404040' };
        case STOCK_BLACK_BRUSH:
            return { handle: objectId, type: 'BRUSH', data: '#000000' };
        case STOCK_NULL_BRUSH:
            return { handle: objectId, type: 'BRUSH', data: 'transparent' };
        case STOCK_WHITE_PEN:
            return { handle: objectId, type: 'PEN', data: '#FFFFFF', penStyle: PS_SOLID, penWidth: 1, penColor: 0x00FFFFFF };
        case STOCK_BLACK_PEN:
            return { handle: objectId, type: 'PEN', data: '#000000', penStyle: PS_SOLID, penWidth: 1, penColor: 0 };
        case STOCK_NULL_PEN:
            return { handle: objectId, type: 'PEN', data: 'transparent', penStyle: PS_NULL, penWidth: 1, penColor: 0 };
        case STOCK_SYSTEM_FONT:
        case STOCK_DEFAULT_GUI_FONT:
        case STOCK_ANSI_VAR_FONT:
            return { handle: objectId, type: 'FONT', data: '16px sans-serif' };
        case STOCK_ANSI_FIXED_FONT:
        case STOCK_SYSTEM_FIXED_FONT:
        case STOCK_OEM_FIXED_FONT:
            return { handle: objectId, type: 'FONT', data: '16px monospace' };
        case STOCK_DEFAULT_BITMAP:
            return { handle: objectId, type: 'BITMAP', data: { width: 1, height: 1, pixels: null } };
        default:
            return null;
    }
}

export function colorToCss(gdi: GDIContext, color: number): string {
    // Fast lookup from cache
    const cached = gdi.colorCache.get(color);
    if (cached) return cached;

    // Parse color components
    const r = (color) & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = (color >> 16) & 0xFF;
    const css = `rgb(${r},${g},${b})`;

    // Limit cache size to avoid memory leaks
    if (gdi.colorCache.size >= gdi.MAX_COLOR_CACHE_SIZE) {
        gdi.colorCache.clear();
    }
    gdi.colorCache.set(color, css);

    return css;
}

export function cssToColor(css: string): number {
    const hexMatch = /^#([0-9a-f]{6})$/i.exec(css);
    if (hexMatch) {
        const hex = parseInt(hexMatch[1], 16);
        const r = (hex >> 16) & 0xFF;
        const g = (hex >> 8) & 0xFF;
        const b = hex & 0xFF;
        return (r | (g << 8) | (b << 16)) >>> 0;
    }

    const rgbMatch = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(css);
    if (rgbMatch) {
        const r = Math.min(255, Math.max(0, parseInt(rgbMatch[1], 10)));
        const g = Math.min(255, Math.max(0, parseInt(rgbMatch[2], 10)));
        const b = Math.min(255, Math.max(0, parseInt(rgbMatch[3], 10)));
        return (r | (g << 8) | (b << 16)) >>> 0;
    }

    // Default to white if parsing fails to keep text backgrounds readable.
    return 0x00FFFFFF;
}

export function getObject(gdi: GDIContext, hgdiobj: number, cbBuffer: number, lpvObject: number, mem: Uint8Array, isUnicode: boolean = true): number {
    let obj = gdi.objects.get(hgdiobj);

    // Fallback: check SystemResourceProvider for user objects (e.g., LoadImageA bitmaps)
    if (!obj) {
        const userObj = SystemResourceProvider.getInstance().getUserObject(hgdiobj);
        if (userObj && userObj.type === 'BITMAP') {
            obj = { handle: hgdiobj, type: 'BITMAP', data: userObj };
        }
    }

    if (!obj && isStockObject(hgdiobj)) {
        obj = getStockObject(hgdiobj) ?? undefined;
    }

    if (!obj) {
        Logger.verbose(LogCategory.GDI32, `getObject: Unknown handle 0x${hgdiobj.toString(16)}`);
        return 0;
    }

    if (!lpvObject || cbBuffer === 0) {
        // Return required size
        if (obj.type === 'BITMAP') {
            return 24; // sizeof(BITMAP)
        } else if (obj.type === 'FONT') {
            return isUnicode ? 92 : 60; // sizeof(LOGFONTW) vs sizeof(LOGFONTA)
        } else if (obj.type === 'PEN') {
            return LOGPEN_SIZE;
        }
        return 0;
    }

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    if (obj.type === 'PEN' && cbBuffer >= LOGPEN_SIZE) {
        // LOGPEN { UINT lopnStyle; POINT lopnWidth; COLORREF lopnColor }. lopnWidth.y is
        // unused by GDI but must be written — callers round-trip the struct into
        // CreatePenIndirect.
        view.setUint32(lpvObject + LOGPEN_OFFSETS.lopnStyle, (obj.penStyle ?? PS_SOLID) >>> 0, true);
        view.setInt32(lpvObject + LOGPEN_OFFSETS.lopnWidth_x, obj.penWidth ?? 1, true);
        view.setInt32(lpvObject + LOGPEN_OFFSETS.lopnWidth_y, 0, true);
        view.setUint32(lpvObject + LOGPEN_OFFSETS.lopnColor, (obj.penColor ?? 0) >>> 0, true);
        return LOGPEN_SIZE;
    }

    // Palettized (≤8bpp) bitmap loaded with LR_CREATEDIBSECTION: expose a real
    // DIBSECTION so guest sprite loaders can read the 8-bit source + palette
    // (biBitCount, bmBits). GetObject(h, sizeof(DIBSECTION)=0x54) triggers this;
    // GetObject(h, sizeof(BITMAP)=24) still gets the plain BITMAP below.
    if (obj.type === 'BITMAP' && cbBuffer >= 0x54 && obj.data?.dibBits && (obj.data.bitCount ?? 32) <= 8) {
        const width = obj.data.width || 0;
        const height = obj.data.height || 0;
        const bitCount = obj.data.bitCount as number;
        const stride = (obj.data.dibStride as number) || (((width * bitCount + 31) >> 5) << 2);
        const dibBits = obj.data.dibBits as Uint8Array;
        // Materialize the DIB bits into guest memory once (cached on the object).
        let bmBitsPtr = obj.data.dibBitsPtr as number | undefined;
        if (!bmBitsPtr) {
            const proc = System.getInstance().process;
            bmBitsPtr = proc?.memory.alloc(dibBits.length, "HEAP", "rw") ?? 0;
            if (bmBitsPtr) {
                mem.set(dibBits, bmBitsPtr);
                obj.data.dibBitsPtr = bmBitsPtr;
            }
        }
        // The file rows are bottom-up unless top-down; report biHeight sign to match
        // so the loader walks rows in the right direction.
        const biHeight = obj.data.dibTopDown ? -height : height;
        // DIBSECTION: dsBm(24) + dsBmih(40) + dsBitfields(12) + dshSection(4) + dsOffset(4).
        view.setUint32(lpvObject + 0x00, 0, true);           // dsBm.bmType
        view.setInt32(lpvObject + 0x04, width, true);        // dsBm.bmWidth
        view.setInt32(lpvObject + 0x08, height, true);       // dsBm.bmHeight (always +ve here)
        view.setUint32(lpvObject + 0x0C, stride, true);      // dsBm.bmWidthBytes
        view.setUint16(lpvObject + 0x10, 1, true);           // dsBm.bmPlanes
        view.setUint16(lpvObject + 0x12, bitCount, true);    // dsBm.bmBitsPixel
        view.setUint32(lpvObject + 0x14, bmBitsPtr >>> 0, true); // dsBm.bmBits
        view.setUint32(lpvObject + 0x18, 40, true);          // dsBmih.biSize
        view.setInt32(lpvObject + 0x1C, width, true);        // biWidth
        view.setInt32(lpvObject + 0x20, biHeight, true);     // biHeight (sign = orientation)
        view.setUint16(lpvObject + 0x24, 1, true);           // biPlanes
        view.setUint16(lpvObject + 0x26, bitCount, true);    // biBitCount
        view.setUint32(lpvObject + 0x28, 0, true);           // biCompression = BI_RGB
        view.setUint32(lpvObject + 0x2C, stride * height, true); // biSizeImage
        view.setInt32(lpvObject + 0x30, 0, true);            // biXPelsPerMeter
        view.setInt32(lpvObject + 0x34, 0, true);            // biYPelsPerMeter
        view.setUint32(lpvObject + 0x38, obj.data.palette ? (obj.data.palette as Uint32Array).length : 0, true); // biClrUsed
        view.setUint32(lpvObject + 0x3C, 0, true);           // biClrImportant
        view.setUint32(lpvObject + 0x40, 0, true);           // dsBitfields[0]
        view.setUint32(lpvObject + 0x44, 0, true);           // dsBitfields[1]
        view.setUint32(lpvObject + 0x48, 0, true);           // dsBitfields[2]
        view.setUint32(lpvObject + 0x4C, 0, true);           // dshSection
        view.setUint32(lpvObject + 0x50, 0, true);           // dsOffset
        Logger.verbose(LogCategory.GDI32, `getObject DIBSECTION: ${width}x${height} ${bitCount}bpp stride=${stride} bmBits=0x${bmBitsPtr.toString(16)}`);
        return 0x54;
    }

    if (obj.type === 'BITMAP' && cbBuffer >= 24) {
        // Write BITMAP structure: bmType, bmWidth, bmHeight, bmWidthBytes, bmPlanes,
        // bmBitsPixel, bmBits.
        const width = obj.data?.width || 0;
        const height = obj.data?.height || 0;
        // A bitmap loaded as a DIBSECTION (LR_CREATEDIBSECTION) exposes its pixel bits:
        // Win32 GetObject(hDib, sizeof(BITMAP)) fills bmBits with the DIB rows and reports
        // the DIB's own depth (not a synthetic 32bpp). Sprite loaders that GetObject a DIB
        // and memcpy bmBits (e.g. WA's FUN_004cf820) get a zero-filled → black sprite if
        // bmBits is NULL. Materialize the palettized rows once (shared with the 0x54 path).
        if (obj.data?.dibBits && (obj.data.bitCount ?? 32) <= 8) {
            const bitCount = obj.data.bitCount as number;
            const stride = (obj.data.dibStride as number) || (((width * bitCount + 31) >> 5) << 2);
            const dibBits = obj.data.dibBits as Uint8Array;
            let bmBitsPtr = obj.data.dibBitsPtr as number | undefined;
            if (!bmBitsPtr) {
                const proc = System.getInstance().process;
                bmBitsPtr = proc?.memory.alloc(dibBits.length, "HEAP", "rw") ?? 0;
                if (bmBitsPtr) {
                    mem.set(dibBits, bmBitsPtr);
                    obj.data.dibBitsPtr = bmBitsPtr;
                }
            }
            view.setUint32(lpvObject, 0, true);                 // bmType
            view.setInt32(lpvObject + 4, width, true);          // bmWidth
            view.setInt32(lpvObject + 8, height, true);         // bmHeight
            view.setUint32(lpvObject + 12, stride, true);       // bmWidthBytes
            view.setUint16(lpvObject + 16, 1, true);            // bmPlanes
            view.setUint16(lpvObject + 18, bitCount, true);     // bmBitsPixel
            view.setUint32(lpvObject + 20, bmBitsPtr >>> 0, true); // bmBits
            Logger.verbose(LogCategory.GDI32, `getObject BITMAP(DIB): ${width}x${height} ${bitCount}bpp stride=${stride} bmBits=0x${(bmBitsPtr ?? 0).toString(16)}`);
            return 24;
        }
        const widthBytes = width * 4; // RGBA = 4 bytes per pixel
        view.setUint32(lpvObject, 0, true); // bmType = 0
        view.setUint32(lpvObject + 4, width, true); // bmWidth
        view.setUint32(lpvObject + 8, height, true); // bmHeight
        view.setUint32(lpvObject + 12, widthBytes, true); // bmWidthBytes
        view.setUint16(lpvObject + 16, 1, true); // bmPlanes
        view.setUint16(lpvObject + 18, 32, true); // bmBitsPixel
        view.setUint32(lpvObject + 20, 0, true); // bmBits (pointer)
        Logger.verbose(LogCategory.GDI32, `getObject BITMAP: ${width}x${height}, widthBytes=${widthBytes}, hasPixels=${!!obj.data?.pixels}, loading=${!!obj.data?.loading}`);
        return 24;
    } else if (obj.type === 'FONT') {
        // LOGFONTA = 60 bytes (CHAR lfFaceName[32]), LOGFONTW = 92 bytes (WCHAR lfFaceName[32]).
        // First 28 bytes are identical between A and W; only the trailing face-name array differs.
        const required = isUnicode ? 92 : 60;
        if (cbBuffer < required) return 0;
        const lfHeight = obj.lfHeight ?? obj.fontSize ?? 16;
        const lfWidth = obj.lfWidth ?? 0;
        const lfWeight = obj.lfWeight ?? 400; // FW_NORMAL
        const lfItalic = obj.lfItalic ?? 0;
        const faceName: string = obj.faceName ?? '';
        view.setInt32(lpvObject, lfHeight, true);            // +0  lfHeight
        view.setInt32(lpvObject + 4, lfWidth, true);          // +4  lfWidth
        view.setInt32(lpvObject + 8, obj.escapement || 0, true); // +8  lfEscapement
        view.setInt32(lpvObject + 12, 0, true);               // +12 lfOrientation
        view.setInt32(lpvObject + 16, lfWeight, true);        // +16 lfWeight
        mem[lpvObject + 20] = lfItalic;                       // +20 lfItalic
        mem[lpvObject + 21] = 0;                              // +21 lfUnderline
        mem[lpvObject + 22] = 0;                              // +22 lfStrikeOut
        mem[lpvObject + 23] = 0;                              // +23 lfCharSet (DEFAULT_CHARSET=1, ANSI=0)
        mem[lpvObject + 24] = 0;                              // +24 lfOutPrecision
        mem[lpvObject + 25] = 0;                              // +25 lfClipPrecision
        mem[lpvObject + 26] = obj.lfQuality ?? 0;             // +26 lfQuality
        mem[lpvObject + 27] = 0;                              // +27 lfPitchAndFamily (DEFAULT_PITCH | FF_DONTCARE)
        // Face name area starts at +28. Both A and W zero the entire array first
        // (LOGFONTA uses 32 bytes, LOGFONTW uses 64 bytes), then write the name.
        const faceBytes = isUnicode ? 64 : 32;
        for (let i = 0; i < faceBytes; i++) mem[lpvObject + 28 + i] = 0;
        const maxChars = Math.min(faceName.length, 31); // leave room for terminator
        if (isUnicode) {
            for (let i = 0; i < maxChars; i++) {
                view.setUint16(lpvObject + 28 + i * 2, faceName.charCodeAt(i), true);
            }
        } else {
            for (let i = 0; i < maxChars; i++) {
                mem[lpvObject + 28 + i] = faceName.charCodeAt(i) & 0xFF;
            }
        }
        Logger.verbose(LogCategory.GDI32, `getObject FONT (${isUnicode ? 'W' : 'A'}): h=${lfHeight} w=${lfWidth} weight=${lfWeight} italic=${lfItalic} face='${faceName}' wrote=${required}`);
        return required;
    }

    return 0;
}

export function deleteObject(gdi: GDIContext, hgdiobj: number): boolean {
    // DeleteObject on a stock object is a successful no-op on Windows. It matters now that
    // CreatePen(PS_NULL) hands back the stock NULL_PEN: the guest deletes what it created
    // and must not see a failure.
    if (isStockObject(hgdiobj)) return true;

    const obj = gdi.objects.get(hgdiobj);

    // An HBITMAP lives in the SystemResourceProvider's user table, and the ones minted by
    // CreateCompatibleBitmap/CreateDIBSection/LoadBitmap have no gdi.objects entry at all —
    // keying the teardown off gdi.objects alone leaks every one of them (handle slot, pixel
    // buffer and guest DIB bits) for the life of the process.
    const provider = System.getInstance().resourceProvider;
    const bitmapUserObj = (obj?.type === 'BITMAP' ? obj.data : undefined)
        ?? (obj ? undefined : provider.getUserObject(hgdiobj));
    const isBitmap = obj?.type === 'BITMAP' || bitmapUserObj?.type === 'BITMAP';

    // Clear bitmap-related caches
    if (isBitmap) {
        // Check if bitmap is still loading (userObj stored in data field)
        const userObj = bitmapUserObj;
        if (userObj && userObj.loading) {
            Logger.warn(LogCategory.GDI32,
                `deleteObject: Deferred delete for loading HBITMAP 0x${hgdiobj.toString(16)}`);
            return false;
        }

        // Remove from ImageBitmap caches
        gdi.bitmapImageBitmapCache.delete(hgdiobj);
        gdi.bitmapImageBitmapReady.delete(hgdiobj);
        gdi.purgeBitmapDC(hgdiobj);

        // Free the guest-heap bmBits materialization (GetObject DIBSECTION path)
        if (userObj?.dibBitsPtr) {
            System.getInstance().process?.memory.free(userObj.dibBitsPtr);
            userObj.dibBitsPtr = 0;
        }

        // Notify DDraw to invalidate bitmapToSurfaceCache
        const system = System.getInstance();
        const ddraw = system.process?.getModule("ddraw") as any;
        if (ddraw?.invalidateBitmapCache) {
            ddraw.invalidateBitmapCache(hgdiobj);
        }

        // Clear from SystemResourceProvider (frees the handle slot for reuse)
        const removed = system.resourceProvider.unregisterUserObject(hgdiobj);
        // A provider-only bitmap has no gdi.objects entry, so the delete below would report
        // failure for a handle we did in fact destroy.
        if (!obj) return removed !== null && removed !== undefined;
    }

    if (obj && obj.type === 'FONT') {
        // Find and remove from cache
        for (const [key, handle] of gdi.fontCache.entries()) {
            if (handle === hgdiobj) {
                gdi.fontCache.delete(key);
                break;
            }
        }
    }
    return gdi.objects.delete(hgdiobj);
}

export function createSolidBrush(gdi: GDIContext, color: number): number {
    const cssColor = colorToCss(gdi, color);

    const handle = gdi.nextHgdiobj++;
    gdi.objects.set(handle, {
        handle,
        type: 'BRUSH',
        data: cssColor
    });
    return handle;
}

export function createPatternBrush(gdi: GDIContext, hBitmap: number): number {
    const userObj = SystemResourceProvider.getInstance().getUserObject(hBitmap);
    if (!userObj || userObj.type !== 'BITMAP') {
        Logger.warn(LogCategory.GDI32, `createPatternBrush: invalid bitmap handle 0x${hBitmap.toString(16)}`);
        return 0;
    }

    const width = userObj.width | 0;
    const height = userObj.height | 0;
    if (width <= 0 || height <= 0) {
        Logger.warn(LogCategory.GDI32, `createPatternBrush: invalid bitmap dimensions ${width}x${height}`);
        return 0;
    }

    let srcPixels: Uint8Array | null = null;
    if (userObj.pixels instanceof Uint8Array || userObj.pixels instanceof Uint8ClampedArray) {
        srcPixels = new Uint8Array(userObj.pixels.buffer, userObj.pixels.byteOffset, userObj.pixels.byteLength);
    } else if (userObj.pixels instanceof ArrayBuffer) {
        srcPixels = new Uint8Array(userObj.pixels);
    }

    if (!srcPixels || srcPixels.length < width * height * 4) {
        Logger.warn(LogCategory.GDI32, `createPatternBrush: bitmap 0x${hBitmap.toString(16)} has no RGBA pixel data`);
        return 0;
    }

    const tileCanvas = new OffscreenCanvas(width, height);
    const tileCtx = tileCanvas.getContext('2d', { alpha: true });
    if (!tileCtx) {
        Logger.warn(LogCategory.GDI32, 'createPatternBrush: failed to create tile context');
        return 0;
    }

    const pixels = srcPixels.subarray(0, width * height * 4);
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
    tileCtx.putImageData(imageData, 0, 0);

    const handle = gdi.nextHgdiobj++;
    const data: PatternBrushData = {
        kind: 'pattern',
        sourceBitmap: hBitmap >>> 0,
        tileCanvas,
    };
    gdi.objects.set(handle, {
        handle,
        type: 'BRUSH',
        data,
    });

    Logger.verbose(
        LogCategory.GDI32,
        `createPatternBrush(bitmap=0x${hBitmap.toString(16)} ${width}x${height}) -> 0x${handle.toString(16)}`
    );
    return handle;
}

/**
 * Create a compatible bitmap with the specified dimensions
 * Creates a bitmap object compatible with the device context
 */
export function createCompatibleBitmap(gdi: GDIContext, hdc: number, cx: number, cy: number): number {
    if (cx <= 0 || cy <= 0) {
        Logger.warn(LogCategory.GDI32, `createCompatibleBitmap: Invalid dimensions ${cx}x${cy}`);
        return 0;
    }

    // Get DC to determine color depth (for now, assume 32-bit RGBA)
    const ctx = gdi.contexts.get(hdc);
    const bitsPerPixel = 32; // RGBA = 32 bits per pixel
    const bytesPerPixel = 4;
    const widthBytes = cx * bytesPerPixel;
    const pixelDataSize = widthBytes * cy;

    // Create empty pixel buffer. Real Windows leaves contents undefined; zero-filled
    // opaque black matches typical GDI DDB behaviour on Win9x.
    const pixels = new Uint8Array(pixelDataSize);
    for (let i = 3; i < pixelDataSize; i += 4) pixels[i] = 0xFF;

    // Create bitmap object through SystemResourceProvider
    const resourceData: any = {
        type: 'BITMAP',
        name: 0, // No resource name
        width: cx,
        height: cy,
        loading: false,
        pixels: pixels,
        compatibleEmpty: true,
    };

    const handle = SystemResourceProvider.getInstance().registerUserObject(resourceData);
    if (cx >= 640 || cy >= 480) {
        Logger.log(LogCategory.GDI32, `createCompatibleBitmap(hdc=0x${hdc.toString(16)}, ${cx}x${cy}) -> 0x${handle.toString(16)}`);
    } else {
        Logger.verbose(LogCategory.GDI32, `createCompatibleBitmap(hdc=0x${hdc.toString(16)}, ${cx}x${cy}) -> 0x${handle.toString(16)}`);
    }
    return handle;
}

/**
 * CreatePen/ExtCreatePen pen object.
 *
 * Style handling is gdi32's: a style outside the CreatePen range degrades to PS_SOLID
 * (gdi32/objects.c CreatePen) and PS_NULL resolves to the stock NULL_PEN rather than a
 * new object (win32u/pen.c NtGdiCreatePen), so a PS_NULL pen is shareable and compares
 * equal to GetStockObject(NULL_PEN). Width is |width| and 0 means one device pixel
 * (get_pen_device_width).
 */
export function createPen(gdi: GDIContext, style: number, width: number, color: number): number {
    const penStyle = (style | 0) & PS_STYLE_MASK;
    if (penStyle === PS_NULL) return (0x80000000 | STOCK_NULL_PEN) >>> 0;

    const cssColor = colorToCss(gdi, color);
    const handle = gdi.nextHgdiobj++;
    gdi.objects.set(handle, {
        handle,
        type: 'PEN',
        data: cssColor,
        penStyle: penStyle <= PS_INSIDEFRAME ? penStyle : PS_SOLID,
        penWidth: Math.max(1, Math.abs(width | 0)),
        penColor: color >>> 0,
    });
    Logger.verbose(
        LogCategory.GDI32,
        `createPen(style=${penStyle}, width=${width}, color=0x${(color >>> 0).toString(16)}) -> 0x${handle.toString(16)}`,
    );
    return handle;
}

export function getSelectedFontFace(gdi: GDIContext, hdc: number): string {
    const state = gdi.hdcStates.get(hdc);
    if (!state) return 'System';

    let obj = gdi.objects.get(state.hFont);
    if (!obj && isStockObject(state.hFont)) {
        obj = getStockObject(state.hFont) ?? undefined;
    }
    if (obj?.type === 'FONT' && obj.faceName) {
        return obj.faceName;
    }
    return 'System';
}

export function createFont(gdi: GDIContext, height: number, width: number, weight: number, italic: boolean, faceName: string, escapement?: number, quality?: number): number {
    // lfHeight/lfWidth are signed LONGs. CreateFontA/W pass the raw (unsigned) thunk
    // arg, so a negative em-height (e.g. -11) arrives as 0xFFFFFFF5 — coerce to signed
    // or `height < 0` fails and the size balloons to billions of px (off-canvas text).
    height = height | 0;
    width = width | 0;
    const resolvedName = resolveWindowsFontName(faceName);
    const cacheKey = `${height}-${width}-${weight}-${italic}-${resolvedName}-${escapement || 0}-${quality || 0}`;

    // Check cache with LRU tracking
    const cachedHandle = gdi.fontCache.get(cacheKey);
    if (cachedHandle !== undefined) {
        if (gdi.objects.has(cachedHandle)) {
            return cachedHandle;
        }
        gdi.fontCache.delete(cacheKey);
    }

    // Convert Windows lfHeight to CSS em-height (px):
    //   lfHeight < 0 : abs(lfHeight) is the em-height (character height) directly
    //   lfHeight > 0 : cell height (em + internal leading); scale by ~0.85 to get em
    //   lfHeight == 0: use default
    const fontSize = height < 0 ? -height : height > 0 ? Math.round(height * 0.85) : 16;

    // Weight: 400 = normal, 700 = bold
    const fontWeight = weight >= 600 ? 'bold' : 'normal';
    const fontStyle = italic ? 'italic' : 'normal';

    // Build CSS font string using Liberation fonts
    const cssFont = `${fontStyle} ${fontWeight} ${fontSize}px "${resolvedName}", sans-serif`;

    const handle = gdi.nextHgdiobj++;
    gdi.objects.set(handle, {
        handle,
        type: 'FONT',
        data: cssFont,
        escapement: escapement || 0, // Store rotation angle in tenths of degrees
        fontSize: fontSize, // Cache font size to avoid regex parsing in selectObject
        // Raw LOGFONT fields preserved so GetObjectA/GetObjectW can round-trip them.
        // Without this, downstream helpers like D3DXCreateFontIndirect (which reads
        // the LOGFONT back out of the HFONT) get zeroed/missing data and fail.
        lfHeight: height,
        lfWidth: width,
        lfWeight: weight,
        lfItalic: italic ? 1 : 0,
        lfQuality: quality ?? 0,
        faceName: resolvedName,
    });

    gdi.fontCache.set(cacheKey, handle);
    return handle;
}

export function getFontCss(gdi: GDIContext, hFont: number): string | null {
    if (!hFont) return null;
    const obj = isStockObject(hFont)
        ? getStockObject(hFont)
        : (gdi.objects.get(hFont) ?? null);
    return obj?.type === 'FONT' && typeof obj.data === 'string' ? obj.data : null;
}
