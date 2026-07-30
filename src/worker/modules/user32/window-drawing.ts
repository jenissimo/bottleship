/**
 * User32 drawing / RECT-op / icon handlers. Self-contained: rect math + GDI
 * text/icon draw stubs that use only module imports (no window-manager state).
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import { loadBitmapFromPeResource } from '../kernel32/bitmap-extractor';
import { loadIconFromPeResource } from '../kernel32/icon-extractor';
import { resolveBitmapRgba, resolveIconRgba, resolveDib32RawAlphaRgba } from '../gdi32/bitmap-resolve';
import { desktopBackground } from '../../runtime/desktop-background';
import { asArrayBufferView } from '../../../dom-buffer';

const DT_CALCRECT = 0x00000400;
const DT_SINGLELINE = 0x00000020;

/**
 * Shared body of DrawTextA/W and DrawTextEx*: read the RECT, lay the text out, and give
 * the API its documented return value (the height of the drawn text). DT_CALCRECT writes
 * the measured extent back into the caller's RECT and draws nothing — a guest that sizes
 * a control or a dialog from that call gets a garbage layout if the RECT is not updated.
 */
function drawTextCommon(hdc: number, text: string, mem: Uint8Array, lpRect: number, format: number): number {
    let rect: { left: number; top: number; right: number; bottom: number } | undefined;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (lpRect && lpRect + 16 <= mem.length) {
        rect = {
            left: view.getInt32(lpRect, true),
            top: view.getInt32(lpRect + 4, true),
            right: view.getInt32(lpRect + 8, true),
            bottom: view.getInt32(lpRect + 12, true),
        };
    }

    const layout = System.getInstance().gdiContext.drawText(hdc, text, rect, format);
    if (!layout) return 0;

    if (rect && lpRect && (format & DT_CALCRECT) !== 0) {
        // A wrapped calc keeps the caller's width (it is the wrap limit); an unwrapped one
        // reports the widest line.
        const wrapped = (format & 0x10 /* DT_WORDBREAK */) !== 0 && (format & DT_SINGLELINE) === 0;
        if (!wrapped) view.setInt32(lpRect + 8, rect.left + layout.width, true);
        view.setInt32(lpRect + 12, rect.top + layout.height, true);
    }
    return layout.height;
}

function drawIconToHdc(
    hdc: number,
    hIcon: number,
    x: number,
    y: number,
    cx: number,
    cy: number,
): boolean {
    const resolved = resolveIconRgba(hIcon);
    if (!resolved) return false;

    const gdi = System.getInstance().gdiContext;
    const ctx = gdi.getDC(hdc);
    if (!ctx) return false;

    const { data, width: iconW, height: iconH } = resolved;
    const destW = cx > 0 ? cx : iconW;
    const destH = cy > 0 ? cy : iconH;

    try {
        const frame = new OffscreenCanvas(iconW, iconH);
        const frameCtx = frame.getContext('2d');
        if (!frameCtx) return false;
        frameCtx.putImageData(
            new ImageData(asArrayBufferView(new Uint8ClampedArray(data.buffer, data.byteOffset, iconW * iconH * 4)), iconW, iconH),
            0, 0,
        );
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(frame, 0, 0, iconW, iconH, x, y, destW, destH);
        gdi.setOverlayDirty(true);
        return true;
    } catch {
        return false;
    }
}

function composeIconFromBitmaps(
    mem: Uint8Array,
    hbmColor: number,
    hbmMask: number,
): { width: number; height: number; pixels: Uint8Array } | null {
    // XP+ per-pixel-alpha cursor (nt5src curseng.cxx): a 32bpp color DIBSection
    // whose guest bits carry any nonzero alpha is drawn alpha-blended, mask
    // ignored (apps write the alpha into the bits directly over GDI-blitted RGB).
    if (hbmColor) {
        const alphaCursor = resolveDib32RawAlphaRgba(hbmColor, mem);
        if (alphaCursor) {
            return {
                width: alphaCursor.width,
                height: alphaCursor.height,
                pixels: new Uint8Array(alphaCursor.data.buffer, alphaCursor.data.byteOffset, alphaCursor.data.byteLength),
            };
        }
    }

    const color = hbmColor ? resolveBitmapRgba(hbmColor, mem) : null;
    const mask = hbmMask ? resolveBitmapRgba(hbmMask, mem) : null;

    if (color) {
        const pixels = new Uint8Array(color.data);
        // AND-mask semantics (nt5src sprite.cxx): screen = (screen AND mask) XOR
        // color — mask 1 (white) keeps the screen (transparent), 0 shows the
        // color pixel. A double-height mask stacks AND on TOP, XOR below
        // (ICONINFO layout); a same-size mask is the AND plane alone.
        const isDouble = !!mask && mask.height >= color.height * 2 && mask.width >= color.width;
        if (mask && (isDouble || (mask.width >= color.width && mask.height >= color.height))) {
            const w = color.width;
            const h = color.height;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const mi = (y * mask.width + x) * 4;
                    const pi = (y * w + x) * 4;
                    if (mask.data[mi] >= 128) pixels[pi + 3] = 0;
                }
            }
        }
        return { width: color.width, height: color.height, pixels };
    }

    if (mask && mask.height >= 2 && mask.width > 0) {
        // B/W icon: double-height 1bpp mask, AND on TOP, XOR below (ICONINFO).
        // and=1,xor=0 → transparent; and=1,xor=1 → screen-invert (approximated
        // opaque black); and=0 → xor value paints white/black directly.
        const w = mask.width;
        const h = Math.floor(mask.height / 2);
        const pixels = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const andI = (y * w + x) * 4;
                const xorI = ((h + y) * w + x) * 4;
                const pi = (y * w + x) * 4;
                const andOn = mask.data[andI] > 128;
                const xorOn = mask.data[xorI] > 128;
                if (andOn && !xorOn) {
                    pixels[pi + 3] = 0;
                } else {
                    const v = !andOn && xorOn ? 255 : 0;
                    pixels[pi] = pixels[pi + 1] = pixels[pi + 2] = v;
                    pixels[pi + 3] = 255;
                }
            }
        }
        return { width: w, height: h, pixels };
    }

    return null;
}

export function registerWindowDrawingExports(exports: Record<string, ThunkImplementation>): void {
    let desktopBrush = 0;
    let desktopBrushColorRef = 0;

    // COLOR_* → COLORREF (0x00BBGGRR), aligned with user32/system.ts defaults.
    const systemColors: Record<number, number> = {
        0: 0x00C0C0C0,  // COLOR_SCROLLBAR
        1: 0x00C0DCC0,  // COLOR_BACKGROUND
        5: 0x00000080,  // COLOR_WINDOW
        15: 0x00C0C0C0, // COLOR_BTNFACE
        16: 0x00808080, // COLOR_BTNSHADOW
    };
    const systemBrushCache = new Map<number, number>();

    function getSysColor(colorIndex: number): number {
        return systemColors[colorIndex] ?? 0x00FFFFFF;
    }

    function resolveBrushHandle(hbr: number): number {
        if (hbr === 0) return 0;

        // Win32 FillRect accepts COLOR_* + 1 pseudo-brush values.
        let colorIndex: number | null = null;
        if (hbr > 0 && hbr <= 0x1F) {
            colorIndex = (hbr - 1) | 0;
        } else if (hbr >= 0x1000 && hbr <= 0x101F) {
            // Compatibility with our current GetSysColorBrush stub handles.
            colorIndex = (hbr - 0x1000) | 0;
        }

        if (colorIndex === null) return hbr;

        const cached = systemBrushCache.get(colorIndex);
        if (cached) return cached;

        const brush = System.getInstance().gdiContext.createSolidBrush(getSysColor(colorIndex));
        if (brush) {
            systemBrushCache.set(colorIndex, brush);
            return brush;
        }
        return hbr;
    }

    exports['EqualRect'] = (ctx, mem, args) => {
        const lprc1 = args[0];
        const lprc2 = args[1];
        if (!lprc1 || !lprc2) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const l1 = view.getInt32(lprc1, true);
        const t1 = view.getInt32(lprc1 + 4, true);
        const r1 = view.getInt32(lprc1 + 8, true);
        const b1 = view.getInt32(lprc1 + 12, true);
        const l2 = view.getInt32(lprc2, true);
        const t2 = view.getInt32(lprc2 + 4, true);
        const r2 = view.getInt32(lprc2 + 8, true);
        const b2 = view.getInt32(lprc2 + 12, true);
        const equal = (l1 === l2 && t1 === t2 && r1 === r2 && b1 === b2) ? 1 : 0;
        Logger.verbose(LogCategory.USER32, `EqualRect -> ${equal}`);
        return equal;
    };

    exports['PtInRect'] = (ctx, mem, args) => {
        const lprc = args[0];
        const x = args[1];
        const y = args[2];
        if (!lprc) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left = view.getInt32(lprc, true);
        const top = view.getInt32(lprc + 4, true);
        const right = view.getInt32(lprc + 8, true);
        const bottom = view.getInt32(lprc + 12, true);
        const inside = (x >= left && x < right && y >= top && y < bottom) ? 1 : 0;
        Logger.verbose(LogCategory.USER32, `PtInRect(${x}, ${y}) -> ${inside}`);
        return inside;
    };

    exports['FrameRect'] = (ctx, mem, args) => {
        const hdc = args[0];
        const lprc = args[1];
        const hbr = args[2];
        Logger.verbose(LogCategory.USER32, `FrameRect(0x${hdc.toString(16)}, 0x${lprc.toString(16)}, 0x${hbr.toString(16)})`);
        return 1; // TRUE
    };

    exports['InflateRect'] = (ctx, mem, args) => {
        const lprc = args[0];
        const dx = args[1] | 0; // Sign-extend
        const dy = args[2] | 0;
        if (!lprc) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left = view.getInt32(lprc, true);
        const top = view.getInt32(lprc + 4, true);
        const right = view.getInt32(lprc + 8, true);
        const bottom = view.getInt32(lprc + 12, true);
        view.setInt32(lprc, left - dx, true);
        view.setInt32(lprc + 4, top - dy, true);
        view.setInt32(lprc + 8, right + dx, true);
        view.setInt32(lprc + 12, bottom + dy, true);
        Logger.verbose(LogCategory.USER32, `InflateRect(0x${lprc.toString(16)}, ${dx}, ${dy})`);
        return 1; // TRUE
    };

    exports['DrawFocusRect'] = (ctx, mem, args) => {
        const hdc = args[0];
        const lprc = args[1];
        Logger.verbose(LogCategory.USER32, `DrawFocusRect(0x${hdc.toString(16)}, 0x${lprc.toString(16)})`);
        return 1; // TRUE
    };

    exports['DrawTextExA'] = (ctx, mem, args) => {
        const hdc = args[0];
        const lpchText = args[1];
        const cchText = args[2] | 0;
        const lprc = args[3];
        const format = args[4];

        let text = Marshaler.readString(mem, lpchText);
        if (cchText >= 0) text = text.substring(0, cchText);

        Logger.verbose(LogCategory.USER32,
            `DrawTextExA(0x${hdc.toString(16)}, fmt=0x${(format >>> 0).toString(16)}, "${text}")`);
        return drawTextCommon(hdc, text, mem, lprc, format);
    };

    exports['TabbedTextOutA'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `TabbedTextOutA(...)`);
        return 0;
    };

    exports['GrayStringA'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `GrayStringA(...)`);
        return 1; // TRUE
    };

    exports['GetTabbedTextExtentA'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `GetTabbedTextExtentA(...)`);
        return 0; // Size as DWORD (loword=width, hiword=height)
    };

    exports['LoadBitmapA'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpBitmapName = args[1];

        const resourceId = lpBitmapName < 0x10000 ? lpBitmapName : Marshaler.readString(mem, lpBitmapName);
        const moduleBase = hInstance || 0x00400000;

        Logger.verbose(LogCategory.USER32,
            `LoadBitmapA(hInst=0x${hInstance.toString(16)}, name=${resourceId}, moduleBase=0x${moduleBase.toString(16)})`);

        return loadBitmapFromPeResource(mem, moduleBase, resourceId);
    };

    exports['LoadBitmapW'] = (ctx, mem, args) => {
        const hInstance = args[0];
        const lpBitmapName = args[1];

        const resourceId = lpBitmapName < 0x10000
            ? lpBitmapName
            : Marshaler.readWideString(mem, lpBitmapName);
        const moduleBase = hInstance || 0x00400000;

        Logger.verbose(LogCategory.USER32,
            `LoadBitmapW(hInst=0x${hInstance.toString(16)}, name=${resourceId}, moduleBase=0x${moduleBase.toString(16)})`);

        return loadBitmapFromPeResource(mem, moduleBase, resourceId);
    };

    exports['PaintDesktop'] = (ctx, mem, args) => {
        const hdc = args[0] >>> 0;
        const gdi = System.getInstance().gdiContext;
        const dc = gdi.getDC(hdc);
        if (!dc) {
            Logger.warn(LogCategory.USER32, `PaintDesktop: invalid HDC 0x${hdc.toString(16)}`);
            return 0;
        }

        const colorRef = desktopBackground.getSolidColorRef();
        if (!desktopBrush || desktopBrushColorRef !== colorRef) {
            desktopBrush = gdi.createSolidBrush(colorRef);
            desktopBrushColorRef = colorRef;
        }

        const previousBrush = gdi.selectObject(hdc, desktopBrush);
        const ok = gdi.fillRect(hdc, 0, 0, dc.canvas.width, dc.canvas.height);
        if (previousBrush) {
            gdi.selectObject(hdc, previousBrush);
        }

        Logger.verbose(LogCategory.USER32, `PaintDesktop(0x${hdc.toString(16)}) -> ${ok ? "teal" : "failed"}`);
        return ok ? 1 : 0;
    };

    exports['DrawTextExW'] = exports['DrawTextExA'];
    exports['TabbedTextOutW'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.USER32, `TabbedTextOutW(...)`);
        return args[1] | 0;
    };
    exports['DrawStateA'] = () => 1;
    exports['DrawStateW'] = () => 1;
    exports['GrayStringW'] = () => 1;
    exports['DrawIcon'] = (ctx, mem, args) => {
        const hdc = args[0];
        const hIcon = args[1];
        const x = args[2] | 0;
        const y = args[3] | 0;
        return drawIconToHdc(hdc, hIcon, x, y, 0, 0) ? 1 : 0;
    };
    exports['DrawCaption'] = () => 1;
    exports['DrawFrameControl'] = () => 1;
    exports['DrawEdge'] = () => 1;
    exports['DrawIconEx'] = (ctx, mem, args) => {
        const hdc = args[0];
        const hIcon = args[1];
        const x = args[2] | 0;
        const y = args[3] | 0;
        const cx = args[4] | 0;
        const cy = args[5] | 0;
        return drawIconToHdc(hdc, hIcon, x, y, cx, cy) ? 1 : 0;
    };

    exports['CreateIconIndirect'] = (ctx, mem, args) => {
        const piconinfo = args[0] >>> 0;
        if (!piconinfo || piconinfo + 20 > mem.length) return 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const fIcon = view.getUint32(piconinfo + 0, true) !== 0;
        const xHotspot = view.getUint32(piconinfo + 4, true);
        const yHotspot = view.getUint32(piconinfo + 8, true);
        const hbmMask = view.getUint32(piconinfo + 12, true);
        const hbmColor = view.getUint32(piconinfo + 16, true);

        const composed = composeIconFromBitmaps(mem, hbmColor, hbmMask);
        const width = composed?.width ?? 32;
        const height = composed?.height ?? 32;
        const pixels = composed?.pixels ?? new Uint8Array(width * height * 4);

        const handle = System.getInstance().resourceProvider.registerUserObject({
            type: fIcon ? 'ICON' : 'CURSOR',
            width,
            height,
            pixels,
            loading: false,
            ...(fIcon ? {} : { xHotspot, yHotspot }),
        });

        Logger.verboseLazy(LogCategory.USER32, () => {
            let opaque = 0, lit = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 3] > 0) { opaque++; if (pixels[i] | pixels[i + 1] | pixels[i + 2]) lit++; }
            }
            return `CreateIconIndirect(${fIcon ? 'icon' : 'cursor'}, ${width}x${height}, color=0x${hbmColor.toString(16)}, mask=0x${hbmMask.toString(16)}, hot=${xHotspot},${yHotspot}, composed=${!!composed}, opaque=${opaque}, lit=${lit}) -> 0x${handle.toString(16)}`;
        });
        return handle;
    };

    exports['OffsetRect'] = (ctx, mem, args) => {
        const lpRect = args[0];
        // Fix: dx/dy must be interpreted as SIGNED int32, not unsigned!
        // args[] contains unsigned values, but offset can be negative.
        // Use | 0 to force signed int32 interpretation.
        const dx = args[1] | 0; // signed offset X (e.g., 0xFFFFFD6F = -657)
        const dy = args[2] | 0; // signed offset Y (e.g., 0xFFFFFF5D = -163)

        // Debug: Log stack addresses that might overlap with return addresses
        const isStackAddr = lpRect >= 0x80000 && lpRect < 0x100000;
        if (isStackAddr) {
            Logger.verbose(LogCategory.USER32,
                `OffsetRect(0x${lpRect.toString(16)}, ${dx}, ${dy}) ESP=0x${ctx.esp.toString(16)} stackRect=1`);
        } else {
            Logger.verbose(LogCategory.USER32, `OffsetRect(0x${lpRect.toString(16)}, ${dx}, ${dy})`)
        }

        if (!lpRect || lpRect + 16 > mem.length) {
            return 0; // FALSE - invalid pointer
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Read current RECT values (signed int32)
        const left = view.getInt32(lpRect, true);
        const top = view.getInt32(lpRect + 4, true);
        const right = view.getInt32(lpRect + 8, true);
        const bottom = view.getInt32(lpRect + 12, true);

        // Offset all coordinates (now correctly handles negative offsets!)
        const newLeft = left + dx;
        const newTop = top + dy;
        const newRight = right + dx;
        const newBottom = bottom + dy;

        view.setInt32(lpRect, newLeft, true);      // left
        view.setInt32(lpRect + 4, newTop, true);   // top
        view.setInt32(lpRect + 8, newRight, true); // right
        view.setInt32(lpRect + 12, newBottom, true); // bottom

        return 1; // TRUE
    };

    exports['UnionRect'] = (ctx, mem, args) => {
        const lprcDst = args[0];
        const lprcSrc1 = args[1];
        const lprcSrc2 = args[2];
        if (!lprcDst || lprcDst + 16 > mem.length || !lprcSrc1 || lprcSrc1 + 16 > mem.length || !lprcSrc2 || lprcSrc2 + 16 > mem.length) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const l1 = view.getInt32(lprcSrc1, true);
        const t1 = view.getInt32(lprcSrc1 + 4, true);
        const r1 = view.getInt32(lprcSrc1 + 8, true);
        const b1 = view.getInt32(lprcSrc1 + 12, true);
        const l2 = view.getInt32(lprcSrc2, true);
        const t2 = view.getInt32(lprcSrc2 + 4, true);
        const r2 = view.getInt32(lprcSrc2 + 8, true);
        const b2 = view.getInt32(lprcSrc2 + 12, true);
        const l = Math.min(l1, l2);
        const t = Math.min(t1, t2);
        const r = Math.max(r1, r2);
        const b = Math.max(b1, b2);
        view.setInt32(lprcDst, l, true);
        view.setInt32(lprcDst + 4, t, true);
        view.setInt32(lprcDst + 8, r, true);
        view.setInt32(lprcDst + 12, b, true);
        return (l < r && t < b) ? 1 : 0;
    };

    exports['IsRectEmpty'] = (ctx, mem, args) => {
        const lpRect = args[0];
        if (!lpRect || lpRect + 16 > mem.length) return 1; // TRUE = empty
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left = view.getInt32(lpRect, true);
        const top = view.getInt32(lpRect + 4, true);
        const right = view.getInt32(lpRect + 8, true);
        const bottom = view.getInt32(lpRect + 12, true);
        const empty = (left >= right || top >= bottom) ? 1 : 0;

        // Debug: Log stack addresses that might overlap with return addresses
        const isStackAddr = lpRect >= 0x80000 && lpRect < 0x100000;
        if (isStackAddr) {
            Logger.verbose(LogCategory.USER32,
                `IsRectEmpty(0x${lpRect.toString(16)}) ESP=0x${ctx.esp.toString(16)} rect=[${left},${top},${right},${bottom}] -> ${empty} stackRect=1`);
        } else {
            Logger.verbose(LogCategory.USER32, `IsRectEmpty(0x${lpRect.toString(16)}) -> ${empty}`);
        }
        return empty;
    };

    exports['DrawTextW'] = (ctx, mem, args) => {
        const hdc = args[0];
        const lpString = args[1];
        const cchText = args[2] | 0;
        const lpRect = args[3];
        const uFormat = args[4];

        let text = Marshaler.readWideString(mem, lpString);
        if (cchText >= 0) text = text.substring(0, cchText);

        Logger.verbose(LogCategory.USER32,
            `DrawTextW(0x${hdc.toString(16)}, fmt=0x${(uFormat >>> 0).toString(16)}, "${text}")`);
        return drawTextCommon(hdc, text, mem, lpRect, uFormat);
    };

    exports['DrawTextA'] = (ctx, mem, args) => {
        const hdc = args[0];
        const lpString = args[1];
        const cchText = args[2] | 0;
        const lpRect = args[3];
        const uFormat = args[4];

        let text = Marshaler.readString(mem, lpString);
        if (cchText >= 0) text = text.substring(0, cchText);

        Logger.verbose(LogCategory.USER32,
            `DrawTextA(0x${hdc.toString(16)}, fmt=0x${(uFormat >>> 0).toString(16)}, "${text}")`);
        return drawTextCommon(hdc, text, mem, lpRect, uFormat);
    };

    exports['FillRect'] = (ctx, mem, args) => {
        const hdc = args[0];
        const lprc = args[1];
        const hbr = args[2]; // Brush to fill with

        if (!lprc || lprc + 16 > mem.length) {
            Logger.warn(LogCategory.USER32, `FillRect: Invalid RECT pointer 0x${lprc.toString(16)}`);
            return 0;
        }

        const gdiContext = System.getInstance().gdiContext;
        if (!gdiContext.getDC(hdc)) {
            Logger.warn(LogCategory.USER32, `FillRect: Invalid HDC 0x${hdc.toString(16)}`);
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left = view.getInt32(lprc, true);
        const top = view.getInt32(lprc + 4, true);
        const right = view.getInt32(lprc + 8, true);
        const bottom = view.getInt32(lprc + 12, true);

        // Select brush temporarily and restore previous selection to avoid mutating DC state.
        const resolvedBrush = resolveBrushHandle(hbr);
        let previousBrush = 0;
        if (resolvedBrush) {
            previousBrush = gdiContext.selectObject(hdc, resolvedBrush);
        }

        const res = gdiContext.fillRect(hdc, left, top, right, bottom);

        if (previousBrush) {
            gdiContext.selectObject(hdc, previousBrush);
        }

        Logger.verbose(LogCategory.USER32, `FillRect: (${left},${top}) - (${right},${bottom})`);
        return res ? 1 : 0;
    };

    exports['CopyImage'] = (ctx, mem, args) => args[0] >>> 0;
    exports['GetIconInfo'] = (ctx, mem, args) => {
        const piconinfo = args[1] >>> 0;
        if (piconinfo && piconinfo + 20 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(piconinfo + 0, 0, true); // fIcon = FALSE
            view.setUint32(piconinfo + 4, 0, true); // xHotspot
            view.setUint32(piconinfo + 8, 0, true); // yHotspot
            view.setUint32(piconinfo + 12, 0, true); // hbmMask
            view.setUint32(piconinfo + 16, 0, true); // hbmColor
        }
        return 1;
    };
}
