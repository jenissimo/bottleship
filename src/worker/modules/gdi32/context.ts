
import { LruCache } from "../../core/collections/lru-cache";
import { Logger, LogCategory } from "../../core/logger";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { System } from "../../core/system";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { gammaService } from "../../core/gamma-service";
import { resolveBitmapRgba, bitmapPixelsPopulated, writeBackDibSectionRect } from './bitmap-resolve';
import { asArrayBufferView } from '../../../dom-buffer';
// Sibling GDI modules take this GDIContext as their `gdi` host and operate on
// the shared (non-private) state fields.
import {
    STOCK_WHITE_BRUSH,
    STOCK_BLACK_PEN,
    STOCK_SYSTEM_FONT,
    DEFAULT_BITMAP_HANDLE as GDI_DEFAULT_BITMAP_HANDLE,
    isStockObject as isStockObjectImpl,
    getStockObject as getStockObjectImpl,
    colorToCss as colorToCssImpl,
    cssToColor as cssToColorImpl,
    getObject as getObjectImpl,
    deleteObject as deleteObjectImpl,
    createSolidBrush as createSolidBrushImpl,
    createPatternBrush as createPatternBrushImpl,
    createCompatibleBitmap as createCompatibleBitmapImpl,
    createPen as createPenImpl,
    getSelectedFontFace as getSelectedFontFaceImpl,
    createFont as createFontImpl,
    getFontCss as getFontCssImpl,
} from './gdi-objects';
import { strokePolyline as strokePolylineImpl, lineTo as lineToImpl } from './gdi-lines';
import { textOut as textOutImpl, drawText as drawTextImpl, type DrawTextLayout } from './gdi-text';
import { bitBlt as bitBltImpl, stretchBlt as stretchBltImpl } from './gdi-blit';
import {
    type DcClipRegion,
    type DcClipState,
    applyClipToContext,
    clampRectToClip,
    clipRegionFromRect,
    clipRegionType,
    cloneClipRegion,
    combineClipRegions,
    excludeClipRegionRect,
    forEachClipRect,
    intersectClipRegionRect,
    makeClipRegion,
    offsetClipRegion,
} from './dc-clip';
// A paint DC's clip IS the window's update region (Win32: BeginPaint hands back a DC
// clipped to it, and rcPaint is that region's bounding box). The region is USER state,
// so it is read from there rather than duplicated here.
import { getWindowUpdateRects } from '../user32/paint-region';

export interface GDIObject {
    handle: number;
    type: 'BRUSH' | 'PEN' | 'BITMAP' | 'FONT';
    data: any; // Context-dependent data (e.g. CSS color string or font string)
    escapement?: number; // For FONT: rotation angle in tenths of degrees
    fontSize?: number; // For FONT: cached font size to avoid regex parsing
    // For PEN: LOGPEN fields. `data` stays the CSS colour (SelectObject copies it into
    // strokeStyle); the rasteriser needs the style/width the colour cannot carry.
    penStyle?: number;
    penWidth?: number;
    penColor?: number;
    // For FONT: raw LOGFONT fields preserved so GetObjectA/W can round-trip them.
    lfHeight?: number;
    lfWidth?: number;
    lfWeight?: number;
    lfItalic?: number;
    lfQuality?: number;
    faceName?: string;
}

interface ScreenRect { x: number; y: number; w: number; h: number }

/**
 * `base` minus the UNION of `holes`, as a set of disjoint rectangles. Canvas has no
 * path boolean, and an even-odd stack of overlapping holes cancels itself back to
 * painted; splitting each survivor around each hole cannot.
 */
export function subtractRects(base: ScreenRect, holes: readonly ScreenRect[]): ScreenRect[] {
    let out: ScreenRect[] = [base];
    for (const h of holes) {
        if (h.w <= 0 || h.h <= 0) continue;
        const next: ScreenRect[] = [];
        for (const r of out) {
            const ix = Math.max(r.x, h.x), iy = Math.max(r.y, h.y);
            const ir = Math.min(r.x + r.w, h.x + h.w), ib = Math.min(r.y + r.h, h.y + h.h);
            if (ir <= ix || ib <= iy) { next.push(r); continue; }
            if (iy > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: iy - r.y });
            if (ib < r.y + r.h) next.push({ x: r.x, y: ib, w: r.w, h: r.y + r.h - ib });
            if (ix > r.x) next.push({ x: r.x, y: iy, w: ix - r.x, h: ib - iy });
            if (ir < r.x + r.w) next.push({ x: ir, y: iy, w: r.x + r.w - ir, h: ib - iy });
        }
        out = next;
        if (out.length === 0) break;
    }
    return out;
}

export interface ClearOverlayRectOptions {
    /** Do not repaint this hwnd after clear (it is being erased while still visible). */
    excludeRepairHwnd?: number;
    /** Caller handles overlap repair manually. */
    skipRepair?: boolean;
}

/**
 * One SaveDC level. Win32 saves the DC's whole attribute set as a unit; this is that set
 * restricted to what our DC state actually holds — the mapping mode, world transform and
 * viewport/window origins are not among them because nothing here stores or honours them,
 * and stacking a value no primitive reads would be a restore that restores nothing.
 */
interface SavedDcState {
    clip: DcClipRegion | null;
    hBrush: number;
    hPen: number;
    hFont: number;
    hBitmap: number;
    brushColor: string;
    textColor: string;
    textColorValue: number;
    bkMode: number;
    bkColor: string;
    font: string;
    fontSize: number;
    fontQuality: number;
    textEscapement: number;
    textAlign: number;
    posX: number;
    posY: number;
}

/**
 * Per-HDC state a sibling module owns (the coordinate mapping) has to die with the DC,
 * and the DC dies here. A hook keeps that module's map out of this class without
 * leaking an entry per BeginPaint.
 */
const dcTeardownHooks: ((hdc: number) => void)[] = [];
export function registerDcTeardown(fn: (hdc: number) => void): void {
    dcTeardownHooks.push(fn);
}

export class GDIContext {
    // Host-shared state: gdi-objects/gdi-text/gdi-blit access non-private
    // fields/methods of this class directly — treat them as module-private to gdi32.
    contexts: Map<number, OffscreenCanvasRenderingContext2D> = new Map();
    objects: Map<number, GDIObject> = new Map();
    private nextHdc = 0x20000;
    nextHgdiobj = 0x30000;

    hdcStates: Map<number, {
        brushColor: string;
        textColor: string;
        textColorValue: number;
        bkMode: number;
        bkColor: string;
        font: string;
        fontSize: number; // Cached font size to avoid regex parsing
        fontQuality: number; // LOGFONT lfQuality of the selected font
        textEscapement: number; // Rotation angle in tenths of degrees (Windows format)
        textAlign: number; // TA_* flags (SetTextAlign); 0 = TA_LEFT|TA_TOP|TA_NOUPDATECP
        appliedFont: string; // The font currently set on the canvas context
        appliedFillStyle: string; // The fillStyle currently set on the canvas context
        hBrush: number; // Current selected brush handle
        hPen: number; // Current selected pen handle
        hFont: number; // Current selected font handle
        hBitmap: number; // Current selected bitmap handle (for Memory DC)
        cachedImageData?: ImageData; // Cache for GetPixel
        cachedPixels32?: Uint32Array; // Uint32 view of cachedImageData for fast single-read access
        imageDataDirty: boolean; // Flag to invalidate cache
        dirty: boolean; // true if canvas has changes that need syncing to surface memory
        dirtyRect: { x1: number, y1: number, x2: number, y2: number } | null; // Bounding box of changed area for partial GPU uploads
        /** When set, this memory DC backs an HWND client area; flush to overlay on EndPaint/ReleaseDC. */
        windowBlit?: { absX: number; absY: number; width: number; height: number };
        /** HWND this DC was obtained for (GetDC/GetWindowDC/GetDCEx/BeginPaint). Absent on a
         *  memory/compatible DC, which is exactly the NULL that WindowFromDC must report. */
        hwnd?: number;
        /** True until guest draws on this DC (CreateCompatibleDC + untouched blit source). */
        pristine?: boolean;
        /** True when this surface DC's canvas was seeded from the surface's CPU pixels at GetDC
         *  (faithful DDraw GetDC: the DC draws over the surface's own bits). ReleaseDC then writes
         *  the full canvas back to CPU and keeps the surface CPU-authoritative (no GPU readback). */
        surfaceSeeded?: boolean;
        /** Skip next EndPaint flush — WM_PAINT had no real guest pixels (pristine BitBlt). */
        skipOverlayFlush?: boolean;
        /** BeginPaint DC: EndPaint owns its publish, so it is never auto-published mid-paint. */
        paintDc?: boolean;
        /** Clip region; absent means unbounded (see dc-clip.ts). */
        clip?: DcClipState;
        /** SaveDC levels, innermost last (see saveDcState). */
        saved?: SavedDcState[];
    }> = new Map();

    /** Current pen position per HDC (MoveToEx / LineTo). */
    private hdcCurrentPos = new Map<number, { x: number; y: number }>();

    private readonly MAX_FONT_CACHE_SIZE = 100;
    // LRU cache for fonts with max size limit
    fontCache = new LruCache<string, number>({ maxEntries: this.MAX_FONT_CACHE_SIZE }); // cacheKey -> handle
    private handleRefs: Map<number, number> = new Map(); // handle -> refCount for internal caching if needed, but let's keep it simple for now
    
    // Cache for ImageBitmaps created from BMP pixels (async loading)
    bitmapImageBitmapCache: Map<number, Promise<ImageBitmap>> = new Map(); // hbitmap -> Promise<ImageBitmap>
    bitmapImageBitmapReady: Map<number, ImageBitmap> = new Map(); // hbitmap -> ImageBitmap (when ready)

    // Cache for bitmap DCs to avoid recreating them on every SelectObject
    // Maps hbitmap -> hdc (the DC created for that bitmap)
    private bitmapDCCache: Map<number, number> = new Map();

    // PERFORMANCE OPTIMIZATION: Track bitmap version to skip redundant drawImage calls
    // Maps hbitmap -> version (incremented when bitmap content changes)
    private bitmapVersions: Map<number, number> = new Map();
    // Maps hdc -> {hbitmap, lastSyncVersion} for tracking when DC was last synced with bitmap
    private dcBitmapSyncState: Map<number, { hbitmap: number; version: number }> = new Map();

    // Color cache to avoid string allocations in hot path
    colorCache: Map<number, string> = new Map();
    readonly MAX_COLOR_CACHE_SIZE = 2000;

    // DEFAULT_BITMAP_HANDLE: default 1x1 monochrome bitmap selected into fresh
    // memory DCs (Windows behavior). Re-exposed as a class static for callers.
    // Stock object IDs (STOCK_*) and resolution live in gdi-objects.ts.
    static readonly DEFAULT_BITMAP_HANDLE = GDI_DEFAULT_BITMAP_HANDLE;

    // DC to DDraw surface mapping (for GetDC/ReleaseDC)
    private linkedSurfaces: Map<number, number> = new Map(); // hdc -> surfacePtr

    // Default objects
    private stockObjects: Map<number, number> = new Map(); // Stock ID -> Handle
    private screenCanvas: OffscreenCanvas | null = null;

    // Separate overlay canvas for GDI compositing over WebGPU
    private overlayCanvas: OffscreenCanvas | null = null;
    overlayCtx: OffscreenCanvasRenderingContext2D | null = null;
    private overlayDirty: boolean = false;
    private overlayHasContent: boolean = false; // True if overlay has any content to composite
    private overlayClearRepairFn: ((x: number, y: number, w: number, h: number, excludeHwnd: number) => void) | null = null;
    private overlayDirtyNotifyFn: (() => void) | null = null;

    /** After clearOverlayRect, repaint windows whose overlay pixels were cleared. */
    registerOverlayClearRepair(
        fn: (x: number, y: number, w: number, h: number, excludeHwnd: number) => void,
    ): void {
        this.overlayClearRepairFn = fn;
    }

    /** Wake the compositor when GDI publishes new screen-visible pixels. */
    registerOverlayDirtyNotifier(fn: (() => void) | null): void {
        this.overlayDirtyNotifyFn = fn;
    }

    constructor() {
        // Pre-populate common colors?
    }

    setCanvas(canvas: OffscreenCanvas) {
        this.screenCanvas = canvas;
        // Create overlay canvas with same dimensions
        // Use willReadFrequently: true for optimized getImageData operations in ReleaseDC
        this.overlayCanvas = new OffscreenCanvas(canvas.width, canvas.height);
        // Explicitly request alpha support for proper text antialiasing transparency
        this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
        this.initOverlayContext();
    }

    getCanvas(): OffscreenCanvas | null {
        return this.screenCanvas;
    }

    /**
     * The overlay plane as compositors must SEE it — the live canvas, except while a
     * multi-step guest paint sequence is mid-flight, when it is the last complete frame
     * (see beginOverlayPublish).
     */
    getOverlayCanvas(): OffscreenCanvas | null {
        return this.overlayPublishHeld() ? this.overlayPublished : this.overlayCanvas;
    }

    // --- Atomic publication of a guest paint sequence -------------------------------
    //
    // A Win32 repaint is a SEQUENCE: erase/background, then each child control on top.
    // On real hardware the whole sequence lands between two scanouts, so the display
    // never shows the half of it where the background has covered the controls and they
    // have not been redrawn yet. Here the sequence is driven by guest callbacks
    // (WM_DRAWITEM / WM_PAINT per control), so it spans many JS turns and milliseconds of
    // guest execution, and every compositor — the rAF GDI loop and each presenter — is
    // free to sample the plane in the middle of it. That is a visible one-frame flash of
    // controls disappearing, at whatever rate the app repaints.
    //
    // So the plane is double-buffered ACROSS a sequence: opening one snapshots the live
    // plane (which, by induction, is the last COMPLETE state) into a front buffer that
    // consumers read until the sequence closes. One canvas copy per sequence, not per
    // frame, and no copy at all when nothing is painting.
    //
    // The dirty bookkeeping has to follow the buffer the consumer actually reads, or the
    // screen starves: repaints arrive back-to-back (hover timers, animated menus), so a
    // "sequence in flight" is very nearly always true, and reporting the plane clean for
    // its duration means the compositor never gets a frame to publish. Hence two flags —
    // `overlayDirty` for the live plane, `overlayFrontDirty` for the front buffer — with
    // the front inheriting the live flag at each snapshot.
    //
    // The DEADLINE is not optional: a guest that never completes a chain (crash, lost
    // callback) must not be able to freeze the plane, so the hold fails OPEN.
    private overlayPublished: OffscreenCanvas | null = null;
    private overlayPublishedCtx: OffscreenCanvasRenderingContext2D | null = null;
    private overlayPublishDepth = 0;
    private overlayPublishDeadline = 0;
    private overlayFrontDirty = false;
    private overlayPublishCounters = { begins: 0, ends: 0, expiries: 0 };
    private static readonly OVERLAY_PUBLISH_MAX_MS = 250;

    /**
     * Fail open. A sequence that never closed must not be able to freeze the plane, so
     * the hold is abandoned WHOLE — depth included, so the next sequence snapshots
     * afresh instead of nesting under a corpse; endOverlayPublish() on the lost
     * sequence then no-ops.
     */
    private abandonOverlayPublish(): void {
        this.overlayPublishCounters.expiries++;
        Logger.warn(LogCategory.GDI32,
            `overlay publish barrier expired after ${GDIContext.OVERLAY_PUBLISH_MAX_MS}ms ` +
            `(depth=${this.overlayPublishDepth}) — a guest paint sequence never completed`);
        this.overlayPublishDepth = 0;
        this.overlayPublished = null;
        this.overlayDirty = this.overlayDirty || this.overlayFrontDirty;
        this.overlayFrontDirty = false;
        if (this.overlayDirty) this.overlayDirtyNotifyFn?.();
    }

    private overlayPublishHeld(): boolean {
        if (this.overlayPublishDepth <= 0) return false;
        if (performance.now() > this.overlayPublishDeadline) {
            this.abandonOverlayPublish();
            return false;
        }
        // depth>0 with no front buffer (opened before setCanvas) withholds nothing, but
        // still has to age out through the deadline above or the depth leaks forever.
        return !!this.overlayPublished;
    }

    /**
     * Bracket internals, for diagnostics. Deliberately does NOT evaluate the deadline:
     * an instrument that expires the thing it measures can never show the deadline
     * firing, and "is the fail-open alive?" is exactly the question asked here.
     */
    overlayPublishStats(): {
        depth: number; holding: boolean; msToDeadline: number;
        begins: number; ends: number; expiries: number;
        frontDirty: boolean; liveDirty: boolean;
    } {
        return {
            depth: this.overlayPublishDepth,
            holding: this.overlayPublishDepth > 0 && !!this.overlayPublished,
            msToDeadline: this.overlayPublishDepth > 0
                ? Math.round(this.overlayPublishDeadline - performance.now()) : 0,
            ...this.overlayPublishCounters,
            frontDirty: this.overlayFrontDirty,
            liveDirty: this.overlayDirty,
        };
    }

    /** Open a paint sequence whose intermediate states must not reach the screen. */
    beginOverlayPublish(): void {
        // Age out a stale hold BEFORE nesting under it: otherwise one leaked bracket
        // holds every later sequence hostage to a snapshot nobody will release, and the
        // deadline — only ever renewed on the 0→1 transition — never comes up again.
        this.overlayPublishHeld();
        this.overlayPublishCounters.begins++;
        if (this.overlayPublishDepth++ > 0) return;
        this.overlayPublishDeadline = performance.now() + GDIContext.OVERLAY_PUBLISH_MAX_MS;
        if (!this.overlayCanvas) return;
        const { width, height } = this.overlayCanvas;
        if (!this.overlayPublished || this.overlayPublished.width !== width || this.overlayPublished.height !== height) {
            this.overlayPublished = new OffscreenCanvas(width, height);
            this.overlayPublishedCtx = this.overlayPublished.getContext('2d', { alpha: true });
        }
        if (!this.overlayPublishedCtx) { this.overlayPublished = null; return; }
        this.overlayPublishedCtx.clearRect(0, 0, width, height);
        this.overlayPublishedCtx.drawImage(this.overlayCanvas, 0, 0);
        // The snapshot carries whatever the live plane owed a compositor.
        this.overlayFrontDirty = this.overlayFrontDirty || this.overlayDirty;
        this.overlayDirty = false;
    }

    /** Close it — the sequence's pixels become visible in one step. */
    endOverlayPublish(): void {
        if (this.overlayPublishDepth === 0) return;
        this.overlayPublishCounters.ends++;
        if (--this.overlayPublishDepth > 0) return;
        this.overlayPublished = null;
        // Anything the sequence painted already set overlayDirty on the live plane, which
        // is what consumers read again from here.
        this.overlayDirty = this.overlayDirty || this.overlayFrontDirty;
        this.overlayFrontDirty = false;
    }

    /** True while a paint sequence is being withheld (diagnostics). */
    isOverlayPublishHeld(): boolean {
        return this.overlayPublishHeld();
    }

    isOverlayDirty(): boolean {
        return this.overlayPublishHeld() ? this.overlayFrontDirty : this.overlayDirty;
    }

    clearOverlayDirty(): void {
        if (this.overlayPublishHeld()) {
            this.overlayFrontDirty = false;
            return;
        }
        if (this.overlayDirty) {
            Logger.verbose(LogCategory.GDI32, `GDIContext.clearOverlayDirty: Clearing overlay dirty flag`);
        }
        this.overlayDirty = false;
    }

    setOverlayDirty(dirty: boolean): void {
        const becameDirty = dirty && !this.overlayDirty;
        if (becameDirty) {
            Logger.verbose(LogCategory.GDI32, `GDIContext.setOverlayDirty: Setting overlay dirty flag`);
        }
        this.overlayDirty = dirty;
        // If marking dirty, also mark as having content
        if (dirty) {
            this.overlayHasContent = true;
            if (becameDirty) this.overlayDirtyNotifyFn?.();
        }
    }

    /**
     * Check if overlay has any content that needs to be composited.
     * This is separate from dirty flag - overlay may have content even if not dirty
     * (content was drawn previously and hasn't changed).
     */
    hasOverlayContent(): boolean {
        return this.overlayHasContent;
    }

    /**
     * Clear the overlay content flag.
     * Called when overlay is cleared (e.g., clearOverlay()).
     */
    clearOverlayContent(): void {
        this.overlayHasContent = false;
    }

    clearOverlay(): void {
        if (this.overlayCtx && this.overlayCanvas) {
            this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        }
        this.overlayDirty = true; // Mark as dirty to clear the GPU texture as well
        this.overlayHasContent = false; // No content after clear
    }

    /**
     * Clear a single screen rect of the overlay (transparent), leaving the rest intact.
     * Used to erase a dialog's pixels when it closes or moves — the overlay is a
     * persistent screen-space canvas, so without this a destroyed dialog lingers as a
     * ghost and a moved one smears its old position. Marks the overlay dirty so the
     * presenter re-composites; does NOT clear overlayHasContent (other regions remain).
     */
    clearOverlayRect(
        x: number, y: number, w: number, h: number,
        options?: ClearOverlayRectOptions,
    ): void {
        if (!this.overlayCtx || !this.overlayCanvas || w <= 0 || h <= 0) return;
        const cw = this.overlayCanvas.width;
        const ch = this.overlayCanvas.height;
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(cw, Math.ceil(x + w));
        const y1 = Math.min(ch, Math.ceil(y + h));
        if (x1 <= x0 || y1 <= y0) return;
        this.overlayCtx.clearRect(x0, y0, x1 - x0, y1 - y0);
        this.overlayDirty = true;
        if (!options?.skipRepair) {
            this.overlayClearRepairFn?.(
                x0, y0, x1 - x0, y1 - y0,
                options?.excludeRepairHwnd ?? 0,
            );
        }
    }

    /**
     * The last client image each guest-painted window flushed, kept so a rect of it can be
     * put BACK later.
     *
     * A control we stamp onto the flat overlay destroys whatever the guest had drawn under
     * it, and nothing can re-derive those pixels: the overlay repair only re-stamps OS
     * controls, and the guest repaints on its own schedule (measured: it does not come).
     * Snapshotting the window DC at flush time — before any control is drawn over it — makes
     * the restore EXACT, where sampling a neighbouring pixel was a guess that reproduced a
     * flat backdrop and flooded a textured one with the wrong colour.
     */
    private windowClientBacking = new Map<number, {
        canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D;
        x: number; y: number; w: number; h: number;
    }>();

    private retainWindowClientBacking(
        hwnd: number, src: OffscreenCanvas, x: number, y: number, w: number, h: number,
    ): void {
        if (w <= 0 || h <= 0) return;
        let entry = this.windowClientBacking.get(hwnd);
        if (!entry || entry.w !== w || entry.h !== h) {
            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
            if (!ctx) return;
            entry = { canvas, ctx, x, y, w, h };
            this.windowClientBacking.set(hwnd, entry);
        }
        entry.x = x;
        entry.y = y;
        entry.ctx.clearRect(0, 0, w, h);
        try {
            entry.ctx.drawImage(src, 0, 0, w, h, 0, 0, w, h);
        } catch {
            this.windowClientBacking.delete(hwnd);
        }
    }

    /** Put back a screen-space rect of `hwnd`'s retained client. False if not covered. */
    restoreWindowClientRect(hwnd: number, x: number, y: number, w: number, h: number): boolean {
        const entry = this.windowClientBacking.get(hwnd);
        if (!entry || !this.overlayCtx || w <= 0 || h <= 0) return false;
        const sx = Math.floor(x - entry.x);
        const sy = Math.floor(y - entry.y);
        const sw = Math.ceil(w);
        const sh = Math.ceil(h);
        if (sx < 0 || sy < 0 || sx + sw > entry.w || sy + sh > entry.h) return false;
        this.overlayCtx.clearRect(x, y, sw, sh);
        try {
            this.overlayCtx.drawImage(entry.canvas, sx, sy, sw, sh, x, y, sw, sh);
        } catch {
            return false;
        }
        // setOverlayDirty, not the flag: presenters gate compositing on overlayHasContent.
        this.setOverlayDirty(true);
        return true;
    }

    /**
     * Seed a window memory DC from `ownerHwnd`'s retained client image (the guest's own
     * backdrop) for the screen rect the DC blits to. False when that image does not cover
     * the rect, so the caller can fall back to seeding from the overlay.
     */
    seedMemoryDCFromClientBacking(hdc: number, ownerHwnd: number): boolean {
        const state = this.hdcStates.get(hdc);
        const ctx = this.contexts.get(hdc);
        const entry = this.windowClientBacking.get(ownerHwnd);
        if (!state?.windowBlit || !ctx || !entry) return false;
        const { absX, absY, width, height } = state.windowBlit;
        const sx = Math.floor(absX - entry.x);
        const sy = Math.floor(absY - entry.y);
        if (sx < 0 || sy < 0 || sx + width > entry.w || sy + height > entry.h) return false;
        try {
            ctx.drawImage(entry.canvas, sx, sy, width, height, 0, 0, width, height);
        } catch {
            return false;
        }
        return true;
    }

    dropWindowClientBacking(hwnd: number): void {
        this.windowClientBacking.delete(hwnd);
    }

    /** Scratch RGBA buffer reused by drawBgraToOverlayRect. */
    private overlayBgraScratch: Uint8Array | null = null;
    private overlayFrameCanvas: OffscreenCanvas | null = null;
    private overlayFrameCtx: OffscreenCanvasRenderingContext2D | null = null;

    /**
     * Blit a decoded BGRA video frame into the GDI overlay at screen coordinates.
     * Used by SysAnimate32 to paint AVI frames into the control's client area.
     */
    drawBgraToOverlayRect(
        destX: number, destY: number, destW: number, destH: number,
        srcBgra: Uint8Array, srcW: number, srcH: number,
    ): boolean {
        if (!this.overlayCtx || !this.overlayCanvas || srcW <= 0 || srcH <= 0 || destW <= 0 || destH <= 0) {
            return false;
        }

        const byteCount = srcW * srcH * 4;
        if (srcBgra.length < byteCount) return false;

        if (!this.overlayBgraScratch || this.overlayBgraScratch.length < byteCount) {
            this.overlayBgraScratch = new Uint8Array(byteCount);
        }
        const rgba = this.overlayBgraScratch.subarray(0, byteCount);
        for (let i = 0; i < byteCount; i += 4) {
            rgba[i] = srcBgra[i + 2];
            rgba[i + 1] = srcBgra[i + 1];
            rgba[i + 2] = srcBgra[i];
            rgba[i + 3] = srcBgra[i + 3] ?? 255;
        }

        if (!this.overlayFrameCanvas || this.overlayFrameCanvas.width !== srcW || this.overlayFrameCanvas.height !== srcH) {
            this.overlayFrameCanvas = new OffscreenCanvas(srcW, srcH);
            this.overlayFrameCtx = this.overlayFrameCanvas.getContext('2d', { alpha: true });
            if (!this.overlayFrameCtx) return false;
            this.overlayFrameCtx.imageSmoothingEnabled = false;
        }

        const frameCtx = this.overlayFrameCtx!;
        const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, byteCount);
        frameCtx.putImageData(new ImageData(asArrayBufferView(clamped), srcW, srcH), 0, 0);
        this.overlayCtx.imageSmoothingEnabled = false;
        this.overlayCtx.drawImage(this.overlayFrameCanvas, 0, 0, srcW, srcH, destX, destY, destW, destH);
        this.setOverlayDirty(true);
        return true;
    }

    getOverlayCtx(): OffscreenCanvasRenderingContext2D | null {
        return this.overlayCtx;
    }

    resizeOverlay(width: number, height: number): void {
        if (!this.overlayCanvas) {
            this.overlayCanvas = new OffscreenCanvas(width, height);
            this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
            this.initOverlayContext();
            return;
        }

        const oldW = this.overlayCanvas.width;
        const oldH = this.overlayCanvas.height;
        if (oldW === width && oldH === height) return;

        // Canvas dimension change clears pixels — preserve existing overlay art.
        let snapshot: OffscreenCanvas | null = null;
        if (this.overlayHasContent && this.overlayCtx && oldW > 0 && oldH > 0) {
            snapshot = new OffscreenCanvas(oldW, oldH);
            const snapCtx = snapshot.getContext('2d');
            if (snapCtx) {
                snapCtx.drawImage(this.overlayCanvas, 0, 0);
            } else {
                snapshot = null;
            }
        }

        this.overlayCanvas.width = width;
        this.overlayCanvas.height = height;
        this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
        this.initOverlayContext();

        if (snapshot && this.overlayCtx) {
            this.overlayCtx.drawImage(snapshot, 0, 0, oldW, oldH, 0, 0, width, height);
            this.overlayHasContent = true;
            this.overlayDirty = true;
        } else {
            this.overlayHasContent = false;
            this.overlayDirty = true;
        }
    }

    private initOverlayContext(): void {
        if (this.overlayCtx) {
            this.overlayCtx.textBaseline = 'top';
            this.overlayCtx.imageSmoothingEnabled = true;
            this.overlayCtx.imageSmoothingQuality = 'high';
        }
    }

    createDC(canvas?: OffscreenCanvas): number {
        // If no canvas provided, we target the screen.
        // On systems with WebGPU support, we MUST use the overlay canvas for GDI 
        // to avoid locking the main screen canvas into a '2d' context, 
        // which would prevent WebGPU from initializing later.
        const canWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
        const targetCanvas = canvas || (canWebGpu ? (this.overlayCanvas || this.screenCanvas) : this.screenCanvas);

        if (!targetCanvas) {
            Logger.error(LogCategory.GDI32, "createDC: No target canvas available!");
            return 0;
        }

        // If using overlay canvas, use the existing overlay context
        const isOverlay = targetCanvas === this.overlayCanvas;
        let ctx: OffscreenCanvasRenderingContext2D;
        
        if (isOverlay) {
            if (!this.overlayCtx) {
                Logger.error(LogCategory.GDI32, "createDC: Overlay canvas exists but context is null!");
                return 0;
            }
            ctx = this.overlayCtx;
        } else {
            // Use willReadFrequently for screen/custom canvas as it may be used for GetPixel
            const newCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
            if (!newCtx) {
                Logger.error(LogCategory.GDI32, `createDC: Failed to get 2d context from ${canvas ? 'custom' : 'screen'} canvas! (Is it already used by WebGL/WebGPU?)`);
                return 0;
            }
            ctx = newCtx as OffscreenCanvasRenderingContext2D;
        }

        const hdc = this.nextHdc++;
        this.contexts.set(hdc, ctx);

        // Setup defaults
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#000000';
        ctx.textBaseline = 'top';

        // Default stock objects: WHITE_BRUSH, BLACK_PEN, SYSTEM_FONT
        const defaultBrush = 0x80000000 | STOCK_WHITE_BRUSH;
        const defaultPen = 0x80000000 | STOCK_BLACK_PEN;
        const defaultFont = 0x80000000 | STOCK_SYSTEM_FONT;
        
        this.hdcStates.set(hdc, {
            brushColor: '#FFFFFF',
            textColor: '#000000',
            textColorValue: 0,
            bkMode: 1, // TRANSPARENT for overlay, OPAQUE for screen
            bkColor: '#FFFFFF',
            font: '16px sans-serif',
            fontSize: 16,
            fontQuality: 0,
            textEscapement: 0,
            textAlign: 0,
            appliedFont: '',
            appliedFillStyle: '',
            hBrush: defaultBrush,
            hPen: defaultPen,
            hFont: defaultFont,
            hBitmap: 0,
            imageDataDirty: true,
            dirty: false,
            dirtyRect: null,
        });

        return hdc;
    }

    /**
     * Create a DC on the overlay canvas (for D3D9 Surface GetDC)
     * This allows GDI text to be composited over WebGPU rendering
     */
    createOverlayDC(): number {
        if (!this.overlayCanvas || !this.overlayCtx) return 0;

        // Ensure overlay matches screen canvas size
        if (this.screenCanvas &&
            (this.overlayCanvas.width !== this.screenCanvas.width ||
             this.overlayCanvas.height !== this.screenCanvas.height)) {
            // Changing canvas size resets the context state
            this.overlayCanvas.width = this.screenCanvas.width;
            this.overlayCanvas.height = this.screenCanvas.height;
            // Re-acquire context with alpha support after resize
            this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
            if (!this.overlayCtx) return 0;
        }

        const hdc = this.nextHdc++;
        this.contexts.set(hdc, this.overlayCtx);

        // Setup defaults
        this.overlayCtx.fillStyle = '#FFFFFF';
        this.overlayCtx.strokeStyle = '#000000';
        this.overlayCtx.textBaseline = 'top';
        this.overlayCtx.font = '16px sans-serif';

        // Default stock objects: WHITE_BRUSH, BLACK_PEN, SYSTEM_FONT
        const defaultBrush = 0x80000000 | STOCK_WHITE_BRUSH;
        const defaultPen = 0x80000000 | STOCK_BLACK_PEN;
        const defaultFont = 0x80000000 | STOCK_SYSTEM_FONT;
        
        this.hdcStates.set(hdc, {
            brushColor: '#FFFFFF',
            textColor: '#000000',
            textColorValue: 0,
            bkMode: 1, // TRANSPARENT (1) for overlay
            bkColor: '#FFFFFF',
            font: '16px sans-serif',
            fontSize: 16,
            fontQuality: 0,
            textEscapement: 0,
            textAlign: 0,
            appliedFont: '',
            appliedFillStyle: '',
            hBrush: defaultBrush,
            hPen: defaultPen,
            hFont: defaultFont,
            hBitmap: 0,
            imageDataDirty: true,
            dirty: false,
            dirtyRect: null,
        });

        return hdc;
    }

    /**
     * Create a DC with a specific size for DirectDraw surface GetDC
     * Used for SYSMEM/TEXTURE surfaces that need a canvas matching surface dimensions
     */
    createSurfaceDC(width: number, height: number): number {
        const surfaceCanvas = new OffscreenCanvas(width, height);
        const surfaceCtx = surfaceCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
        if (!surfaceCtx) {
            Logger.error(LogCategory.GDI32, `createSurfaceDC: Failed to get 2d context for ${width}x${height}`);
            return 0;
        }

        const hdc = this.nextHdc++;
        this.contexts.set(hdc, surfaceCtx);

        // Setup defaults
        surfaceCtx.fillStyle = '#FFFFFF';
        surfaceCtx.strokeStyle = '#000000';
        surfaceCtx.textBaseline = 'top';
        surfaceCtx.font = '16px sans-serif';

        // Default stock objects
        const defaultBrush = 0x80000000 | STOCK_WHITE_BRUSH;
        const defaultPen = 0x80000000 | STOCK_BLACK_PEN;
        const defaultFont = 0x80000000 | STOCK_SYSTEM_FONT;

        this.hdcStates.set(hdc, {
            brushColor: '#FFFFFF',
            textColor: '#000000',
            textColorValue: 0,
            bkMode: 1, // TRANSPARENT
            bkColor: '#FFFFFF',
            font: '16px sans-serif',
            fontSize: 16,
            fontQuality: 0,
            textEscapement: 0,
            textAlign: 0,
            appliedFont: '',
            appliedFillStyle: '',
            hBrush: defaultBrush,
            hPen: defaultPen,
            hFont: defaultFont,
            hBitmap: 0,
            imageDataDirty: true,
            dirty: false,
            dirtyRect: null,
        });

        Logger.verbose(LogCategory.GDI32, `createSurfaceDC: Created ${width}x${height} canvas DC 0x${hdc.toString(16)}`);
        return hdc;
    }

    releaseDC(hdc: number): boolean {
        this.hdcStates.delete(hdc);
        dcTeardownHooks.forEach((fn) => fn(hdc));
        return this.contexts.delete(hdc);
    }

    /** Memory DC sized for HWND client-area painting (BeginPaint / GetDC). */
    createSizedMemoryDC(width: number, height: number): number {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        const memoryCanvas = new OffscreenCanvas(w, h);
        const memoryCtx = memoryCanvas.getContext('2d', { willReadFrequently: true });
        if (!memoryCtx) {
            Logger.error(LogCategory.GDI32, `createSizedMemoryDC: Failed to get 2d context for ${w}x${h}`);
            return 0;
        }

        const hdc = this.nextHdc++;
        this.contexts.set(hdc, memoryCtx);
        memoryCtx.fillStyle = '#FFFFFF';
        memoryCtx.strokeStyle = '#000000';
        memoryCtx.textBaseline = 'top';

        const defaultBrush = 0x80000000 | STOCK_WHITE_BRUSH;
        const defaultPen = 0x80000000 | STOCK_BLACK_PEN;
        const defaultFont = 0x80000000 | STOCK_SYSTEM_FONT;

        this.hdcStates.set(hdc, {
            brushColor: '#FFFFFF',
            textColor: '#000000',
            textColorValue: 0,
            bkMode: 1,
            bkColor: '#FFFFFF',
            font: '16px sans-serif',
            fontSize: 16,
            fontQuality: 0,
            textEscapement: 0,
            textAlign: 0,
            appliedFont: '',
            appliedFillStyle: '',
            hBrush: defaultBrush,
            hPen: defaultPen,
            hFont: defaultFont,
            hBitmap: GDIContext.DEFAULT_BITMAP_HANDLE,
            imageDataDirty: true,
            dirty: false,
            dirtyRect: null,
        });
        return hdc;
    }

    attachWindowBlit(hdc: number, absX: number, absY: number, width: number, height: number): void {
        const state = this.hdcStates.get(hdc);
        if (!state) return;
        state.windowBlit = { absX, absY, width, height };
    }

    /**
     * Mark a window DC as belonging to a BeginPaint/EndPaint bracket, and give it the
     * clip such a DC has in Win32: the window's update region. Everything drawn through
     * the DC — the class-brush erase, the guest's own primitives, the child restamps —
     * is then confined to the region the guest was told to repaint.
     */
    markPaintDC(hdc: number): void {
        const state = this.hdcStates.get(hdc);
        if (!state) return;
        state.paintDc = true;
        const hwnd = state.hwnd;
        if (!hwnd) return;
        const update = getWindowUpdateRects(hwnd);
        // No update region is our own artifact (a directly posted WM_PAINT); it means
        // "repaint everything", which is an unbounded clip, not an empty one.
        if (update.length === 0) return;
        const quads: number[] = [];
        for (const r of update) quads.push(r.left, r.top, r.right, r.bottom);
        this.setClipRegion(hdc, makeClipRegion(quads));
    }

    // --- Clip region (see dc-clip.ts) -------------------------------------------------

    /** The DC's current clip, or null when unbounded. */
    getClip(hdc: number): DcClipRegion | null {
        return this.hdcStates.get(hdc)?.clip?.region ?? null;
    }

    /** SelectClipRgn: replace the clip wholesale (null restores the unbounded default). */
    setClipRegion(hdc: number, region: DcClipRegion | null): number {
        const state = this.hdcStates.get(hdc);
        if (!state) return 0;
        const clip = state.clip ?? (state.clip = { region: null });
        clip.region = region;
        return clipRegionType(region);
    }

    intersectClipRect(hdc: number, l: number, t: number, r: number, b: number): number {
        const state = this.hdcStates.get(hdc);
        if (!state) return 0;
        return this.setClipRegion(hdc, intersectClipRegionRect(state.clip?.region ?? null, l, t, r, b));
    }

    excludeClipRect(hdc: number, l: number, t: number, r: number, b: number): number {
        const state = this.hdcStates.get(hdc);
        const canvas = this.contexts.get(hdc)?.canvas;
        if (!state || !canvas) return 0;
        return this.setClipRegion(hdc,
            excludeClipRegionRect(state.clip?.region ?? null, l, t, r, b, canvas.width, canvas.height));
    }

    /**
     * ExtSelectClipRgn's non-COPY half: combine the DC's clip with a region.
     * An absent clip is unbounded, and "unbounded" only has an answer against a
     * universe — the surface extent, the same one ExcludeClipRect subtracts from.
     */
    combineClipWithRegion(hdc: number, region: DcClipRegion, mode: number): number {
        const state = this.hdcStates.get(hdc);
        const canvas = this.contexts.get(hdc)?.canvas;
        if (!state || !canvas) return 0;
        const current = state.clip?.region
            ?? clipRegionFromRect(0, 0, canvas.width, canvas.height);
        return this.setClipRegion(hdc, combineClipRegions(current, region, mode));
    }

    offsetClipRgn(hdc: number, dx: number, dy: number): number {
        const region = this.getClip(hdc);
        if (!region) return clipRegionType(null);
        return this.setClipRegion(hdc, offsetClipRegion(region, dx, dy));
    }

    /** SaveDC: push the DC's attribute state, returning the new level. */
    saveDcState(hdc: number): number {
        const state = this.hdcStates.get(hdc);
        if (!state) return 0;
        const stack = state.saved ?? (state.saved = []);
        const pos = this.getCurrentPosition(hdc);
        stack.push({
            clip: cloneClipRegion(state.clip?.region ?? null),
            hBrush: state.hBrush, hPen: state.hPen, hFont: state.hFont, hBitmap: state.hBitmap,
            brushColor: state.brushColor, textColor: state.textColor,
            textColorValue: state.textColorValue,
            bkMode: state.bkMode, bkColor: state.bkColor,
            font: state.font, fontSize: state.fontSize, fontQuality: state.fontQuality,
            textEscapement: state.textEscapement, textAlign: state.textAlign,
            posX: pos.x, posY: pos.y,
        });
        return stack.length;
    }

    /**
     * RestoreDC. `level` follows Win32: positive = absolute, negative = relative, and the
     * levels above the target are discarded with it.
     *
     * The saved objects are RE-SELECTED rather than assigned, because selection has
     * consequences beyond the handle field — a bitmap re-materializes the DC canvas, a pen
     * sets strokeStyle — and a restore that only rewrote the field would leave the DC
     * drawing with the object the guest thought it had put back.
     */
    restoreDcState(hdc: number, level: number): boolean {
        const state = this.hdcStates.get(hdc);
        const stack = state?.saved;
        if (!state || !stack || stack.length === 0) return false;
        const target = level < 0 ? stack.length + level : level - 1;
        if (target < 0 || target >= stack.length) return false;
        const saved = stack[target];
        stack.length = target;

        if (state.clip) state.clip.region = saved.clip;
        else if (saved.clip) state.clip = { region: saved.clip };

        if (saved.hBitmap && saved.hBitmap !== state.hBitmap) this.selectObject(hdc, saved.hBitmap);
        if (saved.hBrush && saved.hBrush !== state.hBrush) this.selectObject(hdc, saved.hBrush);
        if (saved.hPen && saved.hPen !== state.hPen) this.selectObject(hdc, saved.hPen);
        if (saved.hFont && saved.hFont !== state.hFont) this.selectObject(hdc, saved.hFont);

        state.brushColor = saved.brushColor;
        state.textColor = saved.textColor;
        state.textColorValue = saved.textColorValue;
        state.bkMode = saved.bkMode;
        state.bkColor = saved.bkColor;
        state.font = saved.font;
        state.fontSize = saved.fontSize;
        state.fontQuality = saved.fontQuality;
        state.textEscapement = saved.textEscapement;
        state.textAlign = saved.textAlign;
        // The canvas still carries the font/fill of the state being discarded; clearing the
        // "already applied" markers is what makes the next primitive re-apply these.
        state.appliedFont = '';
        state.appliedFillStyle = '';
        this.setCurrentPosition(hdc, saved.posX, saved.posY);
        return true;
    }

    /**
     * Bracket one primitive on one render target with the DC's clip. The pair is what
     * makes the clip a property of the DC rather than of a call site: every target a
     * primitive touches (DC canvas, the selected bitmap's canvas) is wrapped in it.
     * Returns whether a `ctx.restore()` is owed.
     */
    beginClipOn(hdc: number, ctx: OffscreenCanvasRenderingContext2D): boolean {
        const region = this.hdcStates.get(hdc)?.clip?.region;
        return region ? applyClipToContext(region, ctx) : false;
    }

    /** Clamp a pixel-copy rect (DIB write-back, dirty tracking) to the clip; null = nothing left. */
    clipCopyRect(hdc: number, x: number, y: number, w: number, h: number):
        { x: number; y: number; w: number; h: number } | null {
        return clampRectToClip(this.hdcStates.get(hdc)?.clip?.region ?? null, x, y, w, h);
    }

    /** Visit the parts of a rect a putImageData path may write (see forEachClipRect). */
    forEachClipPart(
        hdc: number, x: number, y: number, w: number, h: number,
        fn: (x: number, y: number, w: number, h: number) => void,
    ): boolean {
        return forEachClipRect(this.hdcStates.get(hdc)?.clip?.region ?? null, x, y, w, h, fn);
    }

    /** GetClipBox: the clip's bounding box, or the whole surface when unbounded. */
    getClipBox(hdc: number): { left: number; top: number; right: number; bottom: number; type: number } {
        const region = this.getClip(hdc);
        const canvas = this.contexts.get(hdc)?.canvas;
        if (!region) {
            return { left: 0, top: 0, right: canvas?.width ?? 0, bottom: canvas?.height ?? 0, type: clipRegionType(null) };
        }
        return { left: region.x1, top: region.y1, right: region.x2, bottom: region.y2, type: clipRegionType(region) };
    }

    /** Build a region from a device rect (SelectClipRgn's HRGN bounding box). */
    clipRegionFromRect(l: number, t: number, r: number, b: number): DcClipRegion {
        return clipRegionFromRect(l, t, r, b);
    }

    /**
     * Window DCs holding unpublished guest pixels, i.e. every DC the guest drew on and
     * has not released. Real GDI has no publish step — output through a window DC is on
     * screen the moment it is drawn — so a DC held across frames (the classic
     * GetDC-once + BitBlt-every-frame software renderer) must reach the screen without
     * waiting for a ReleaseDC that may never come. BeginPaint DCs are excluded: EndPaint
     * publishes those as one atomic sequence.
     */
    heldDirtyWindowDCs(): { hdc: number; hwnd: number }[] {
        const out: { hdc: number; hwnd: number }[] = [];
        for (const [hdc, state] of this.hdcStates) {
            if (!state.windowBlit || !state.dirty || state.paintDc) continue;
            out.push({ hdc, hwnd: state.hwnd ?? 0 });
        }
        return out;
    }

    /** Copy existing overlay pixels into a window memory DC before BeginPaint. */
    seedMemoryDCFromOverlay(hdc: number): void {
        const state = this.hdcStates.get(hdc);
        const ctx = this.contexts.get(hdc);
        if (!state?.windowBlit || !ctx || !this.overlayCtx || !this.overlayCanvas) return;
        if (!this.hasOverlayContent()) return;
        const { absX, absY, width, height } = state.windowBlit;
        try {
            ctx.drawImage(this.overlayCanvas, absX, absY, width, height, 0, 0, width, height);
        } catch {
            // ignore seed failures
        }
    }

    /**
     * Copy a window memory DC to the GDI overlay at its screen position.
     *
     * `excludeRects` (screen space) are punched out of the blit: they are the child
     * WINDOWS whose pixels this window does not own (see getChildWindowExclusions).
     * The caller supplies them because window parentage lives in user32, not here.
     */
    flushWindowMemoryDCToOverlay(
        hdc: number,
        excludeRects?: readonly { x: number; y: number; w: number; h: number }[],
        retainForHwnd?: number,
        clipRect?: { x: number; y: number; w: number; h: number } | null,
    ): boolean {
        const state = this.hdcStates.get(hdc);
        const ctx = this.contexts.get(hdc);
        if (!state?.windowBlit || !ctx || !this.overlayCtx) return false;

        if (state.skipOverlayFlush) {
            state.skipOverlayFlush = false;
            Logger.verbose(LogCategory.GDI32,
                `flushWindowMemoryDCToOverlay: skip hdc=0x${hdc.toString(16)} (pristine WM_PAINT)`);
            return false;
        }

        if (!state.dirty) {
            return false;
        }

        const { absX, absY, width, height } = state.windowBlit;
        const canvas = ctx.canvas;
        if (!canvas) return false;

        // A WS_CHILD's pixels are confined to its ancestors' client areas — Win32 clips them
        // there, and a flat overlay must do it explicitly or a child window that extends past
        // its parent (a page template larger than the placeholder hosting it) paints straight
        // over the desktop outside the dialog.
        const clipped = clipRect && clipRect.w > 0 && clipRect.h > 0;
        const holes = excludeRects && excludeRects.length > 0;
        if (clipped || holes) this.overlayCtx.save();
        if (clipped) {
            this.overlayCtx.beginPath();
            this.overlayCtx.rect(clipRect!.x, clipRect!.y, clipRect!.w, clipRect!.h);
            this.overlayCtx.clip();
        }
        let paint = true;
        if (holes) {
            // Subtract the UNION of the child rects: stacking them even-odd would turn
            // the intersection of two OVERLAPPING siblings back into painted area.
            const keep = subtractRects({ x: absX, y: absY, w: width, h: height }, excludeRects!);
            if (keep.length === 0) {
                paint = false;
            } else {
                const path = new Path2D();
                for (const r of keep) path.rect(r.x, r.y, r.w, r.h);
                this.overlayCtx.clip(path);
            }
        }
        if (paint) {
            this.overlayCtx.drawImage(canvas, 0, 0, width, height, absX, absY, width, height);
        }
        if (clipped || holes) this.overlayCtx.restore();
        // Snapshot from the DC, not the overlay: this is the guest's client alone, before
        // any control is stamped over it (see windowClientBacking).
        if (retainForHwnd !== undefined) {
            this.retainWindowClientBacking(retainForHwnd, canvas, absX, absY, width, height);
        }
        this.setOverlayDirty(true);
        state.dirty = false;
        state.dirtyRect = null;
        return true;
    }

    getDC(hdc: number): OffscreenCanvasRenderingContext2D | undefined {
        return this.contexts.get(hdc);
    }

    /**
     * Return the DC's canvas context with its SELECTED font applied, so measureText()
     * matches what textOut()/fillText() will actually render. Without this, a
     * GetTextExtentPoint or GetTextMetrics issued before any TextOut on the DC measures
     * against the default canvas font ('16px sans-serif'), not the game's selected font —
     * yielding a too-small width. Games that size a layout/copy rect to that measurement
     * then clip the wider rendered text (Sea Dogs menu labels: centered text center-cropped).
     * Mirrors the lazy font-apply in textOut().
     */
    getMeasureContext(hdc: number): OffscreenCanvasRenderingContext2D | undefined {
        const ctx = this.contexts.get(hdc);
        const state = this.hdcStates.get(hdc);
        if (!ctx || !state) return ctx;
        if (state.appliedFont !== state.font) {
            ctx.font = state.font;
            state.appliedFont = state.font;
        }
        return ctx;
    }

    /**
     * Read a bitmap's CURRENT rendered pixels (RGBA, top-down) from its backing canvas.
     * BitBlt-into-a-selected-bitmap keeps that canvas up to date (see the __bitmapCanvas
     * writeback in bitBlt), whereas the raw `pixels` buffer stays at the creation-time fill.
     * GetDIBits on a composited compatible bitmap (e.g. HL's owner-draw button faces built
     * from btns_main tiles) must therefore read the canvas, not `pixels`. Returns null if
     * the bitmap has no usable backing DC/canvas.
     */
    getBitmapRenderedPixels(hbitmap: number): Uint8ClampedArray | null {
        // While an HBITMAP is selected into a memory DC, that DC is the live Win32
        // drawing surface. Some GDI operations update it without mirroring every pixel
        // into our separate bitmap cache canvas, so prefer the selected surface. The
        // cache remains the post-deselect/source-only fallback.
        for (const [hdc, state] of this.hdcStates) {
            if (state.hBitmap !== hbitmap) continue;
            const selectedCtx = this.contexts.get(hdc);
            if (!selectedCtx) continue;
            const sw = selectedCtx.canvas.width, sh = selectedCtx.canvas.height;
            if (sw <= 0 || sh <= 0) continue;
            try {
                return selectedCtx.getImageData(0, 0, sw, sh).data;
            } catch {
                // Try another selected DC or the persistent bitmap canvas below.
            }
        }
        const dc = this.createBitmapDC(hbitmap);
        if (dc === null) return null;
        const ctx = this.contexts.get(dc);
        if (!ctx) return null;
        const cw = ctx.canvas.width, ch = ctx.canvas.height;
        if (cw <= 0 || ch <= 0) return null;
        try {
            return ctx.getImageData(0, 0, cw, ch).data;
        } catch {
            return null;
        }
    }

    /**
     * Read the live RGBA pixels of a memory DC's own drawing surface (its canvas).
     * Used by GetDIBits when the caller asks for the DC's currently-selected surface but that
     * surface is the implicit/default bitmap (no separately-registered HBITMAP) — e.g. our
     * owner-draw drawitem child DC, which is a createSizedMemoryDC seeded with the splash
     * background. Without this the dest-background read returns black and the guest's
     * max(face,background) composite renders opaque black blocks instead of letting the splash
     * show through. Returns null if the hdc has no canvas context.
     */
    getDCSurfacePixels(hdc: number): { data: Uint8ClampedArray; width: number; height: number } | null {
        const ctx = this.contexts.get(hdc);
        if (!ctx) return null;
        const cw = ctx.canvas.width, ch = ctx.canvas.height;
        if (cw <= 0 || ch <= 0) return null;
        try {
            return { data: ctx.getImageData(0, 0, cw, ch).data, width: cw, height: ch };
        } catch {
            return null;
        }
    }

    /**
     * Seed a surface DC's canvas with the surface's current pixels (RGBA, top-down) so that GDI
     * drawing composites onto the existing content — the faithful DDraw GetDC behavior (the DC is
     * a view over the surface's own bits; see Wine wined3d_texture_get_dc). Marks the DC seeded so
     * ReleaseDC writes the full canvas back to CPU and keeps the surface CPU-authoritative,
     * eliminating the GPU→CPU readback that an otherwise GPU-authored canvas would force at Lock.
     */
    seedSurfaceDC(hdc: number, rgba: Uint8Array, width: number, height: number): boolean {
        const ctx = this.contexts.get(hdc);
        const state = this.hdcStates.get(hdc);
        if (!ctx || !state || width <= 0 || height <= 0) return false;
        if (rgba.length < width * height * 4) return false;
        try {
            const img = new ImageData(asArrayBufferView(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4)), width, height);
            ctx.putImageData(img, 0, 0);
            state.surfaceSeeded = true;
            return true;
        } catch {
            return false;
        }
    }

    /** True if this DC's canvas was seeded from surface pixels at GetDC (see seedSurfaceDC). */
    wasSurfaceSeeded(hdc: number): boolean {
        return !!this.hdcStates.get(hdc)?.surfaceSeeded;
    }

    /** The bitmap handle a DC reports as currently selected (for GetDIBits self-surface reads). */
    getDCSelectedBitmap(hdc: number): number {
        return this.hdcStates.get(hdc)?.hBitmap ?? 0;
    }

    /** True if this DC is a window/client memory DC seeded from the overlay (attachWindowBlit). */
    hasWindowBlit(hdc: number): boolean {
        return !!this.hdcStates.get(hdc)?.windowBlit;
    }

    /** True while some DC has this bitmap selected. Win32 FAILS DeleteObject on such a
     *  bitmap and keeps it alive; the cached bitmap DC itself does not count (its own
     *  hBitmap stays 0) or nothing would ever be deletable. */
    isBitmapSelected(hbitmap: number): boolean {
        for (const state of this.hdcStates.values()) {
            if (state.hBitmap === hbitmap) return true;
        }
        return false;
    }

    /** Drop the memory DC (and version counter) SelectObject cached for this bitmap. The cache
     *  is keyed by HBITMAP and never expires on its own, so DeleteObject must retire the entry
     *  or every deleted bitmap keeps a canvas alive for the life of the process. */
    purgeBitmapDC(hbitmap: number): void {
        const hdc = this.bitmapDCCache.get(hbitmap);
        this.bitmapDCCache.delete(hbitmap);
        this.bitmapVersions.delete(hbitmap);
        if (hdc !== undefined && this.contexts.has(hdc)) this.deleteDC(hdc);
    }

    /** Bind a DC to the window it was obtained for — what WindowFromDC reports back. */
    setDCWindow(hdc: number, hwnd: number): void {
        const state = this.hdcStates.get(hdc);
        if (state) state.hwnd = hwnd >>> 0;
    }

    /** Owning HWND of a window DC, 0 for a memory/compatible/info DC. */
    getDCWindow(hdc: number): number {
        return this.hdcStates.get(hdc)?.hwnd ?? 0;
    }

    createCompatibleDC(hdc: number): number {
        const sourceCtx = this.contexts.get(hdc);
        const srcState = this.hdcStates.get(hdc);
        let width = 800;
        let height = 600;
        if (srcState?.windowBlit) {
            width = srcState.windowBlit.width;
            height = srcState.windowBlit.height;
        } else if (sourceCtx?.canvas) {
            width = sourceCtx.canvas.width || 800;
            height = sourceCtx.canvas.height || 600;
        }

        const newHdc = this.createSizedMemoryDC(width, height);
        if (newHdc) {
            const st = this.hdcStates.get(newHdc);
            if (st) st.pristine = true;
            Logger.verbose(LogCategory.GDI32, `createCompatibleDC(0x${hdc.toString(16)}) -> 0x${newHdc.toString(16)} (${width}x${height})`);
        }
        return newHdc;
    }

    /**
     * Re-materialize a DIBSection-backed bitmap's canvas from live guest bits.
     * The app writes DIB bits directly in guest memory (no API call to observe),
     * so any read of the bitmap through GDI must see the CURRENT bits — real GDI
     * has no copy at all; the canvas is our mirror and must be refreshed at use.
     * Returns the refreshed pixels, or null when not DIBSection-backed.
     */
    refreshDibSectionCanvas(hbitmap: number): { data: Uint8ClampedArray; width: number; height: number } | null {
        const userObj = SystemResourceProvider.getInstance().getUserObject(hbitmap);
        if (!userObj || userObj.type !== 'BITMAP' || !userObj.bitsPtr || !userObj.dibStride) return null;
        const mem = System.getInstance().process?.v86?.mem8
            ?? System.getInstance().process?.v86?.v86?.cpu?.mem8;
        if (!mem) return null;
        const fresh = resolveBitmapRgba(hbitmap, mem);
        if (!fresh) return null;
        const data = fresh.data.buffer instanceof ArrayBuffer
            ? fresh.data
            : new Uint8ClampedArray(fresh.data);
        const bitmapDC = this.bitmapDCCache.get(hbitmap);
        const bitmapCtx = bitmapDC !== undefined ? this.contexts.get(bitmapDC) : undefined;
        if (bitmapCtx) {
            bitmapCtx.putImageData(new (ImageData as any)(data, fresh.width, fresh.height), 0, 0);
            this.invalidateImageDataCache(bitmapDC!);
        }
        this.bitmapImageBitmapReady.delete(hbitmap);
        this.bitmapVersions.set(hbitmap, (this.bitmapVersions.get(hbitmap) || 0) + 1);
        return { data, width: fresh.width, height: fresh.height };
    }

    /**
     * Create a memory DC with a BITMAP object loaded from SystemResourceProvider
     * Used when SelectObject is called with a bitmap handle from LoadImageA
     * OPTIMIZATION: Results are cached in bitmapDCCache to avoid recreation on every SelectObject
     */
    createBitmapDC(hbitmap: number): number | null {
        // OPTIMIZATION: Check cache first - reuse existing DC for this bitmap
        const cachedDC = this.bitmapDCCache.get(hbitmap);
        if (cachedDC !== undefined && this.contexts.has(cachedDC)) {
            return cachedDC;
        }

        // Check if hbitmap is a BITMAP from SystemResourceProvider
        const userObj = SystemResourceProvider.getInstance().getUserObject(hbitmap);
        if (!userObj || userObj.type !== 'BITMAP') {
            Logger.verbose(LogCategory.GDI32, `createBitmapDC: Invalid bitmap handle 0x${hbitmap.toString(16)}`);
            return null;
        }

        // Wait for async loading if needed
        if (userObj.loading) {
            Logger.verbose(LogCategory.GDI32, `createBitmapDC: Bitmap 0x${hbitmap.toString(16)} still loading, cannot create DC yet (width=${userObj.width || 0}, height=${userObj.height || 0}, hasPixels=${!!userObj.pixels})`);
            return null;
        }

        // DIBSection truth lives in guest memory — read it for the canvas but do
        // NOT persist into userObj.pixels: a snapshot taken before the app writes
        // the bits would shadow every later guest write.
        let seededPixels: Uint8ClampedArray | null = null;
        if (!bitmapPixelsPopulated(userObj)) {
            const mem = System.getInstance().process?.v86?.mem8
                ?? System.getInstance().process?.v86?.v86?.cpu?.mem8;
            if (mem && userObj.bitsPtr && userObj.dibStride) {
                seededPixels = resolveBitmapRgba(hbitmap, mem)?.data ?? null;
            }
        }

        if (!userObj.pixels && !(userObj.bitsPtr && userObj.dibStride)) {
            Logger.verbose(LogCategory.GDI32, `createBitmapDC: Bitmap 0x${hbitmap.toString(16)} has no pixels (width=${userObj.width || 0}, height=${userObj.height || 0}, loading=${userObj.loading})`);
            return null;
        }

        const width = userObj.width || 0;
        const height = userObj.height || 0;
        if (width <= 0 || height <= 0) {
            Logger.warn(LogCategory.GDI32, `createBitmapDC: Invalid bitmap dimensions ${width}x${height}`);
            return null;
        }

        // Create memory canvas with bitmap dimensions
        const memoryCanvas = new OffscreenCanvas(width, height);
        // Use willReadFrequently as bitmap DCs may be used for GetPixel
        const memoryCtx = memoryCanvas.getContext('2d', { willReadFrequently: true });
        if (!memoryCtx) {
            Logger.error(LogCategory.GDI32, 'createBitmapDC: Failed to get 2d context');
            return null;
        }


        // Create ImageData from RGBA pixels
        // Try using the original buffer directly first, only copy if needed
        let pixelsArray: Uint8ClampedArray;
        const sourcePixels = userObj.pixels ?? seededPixels ?? new Uint8ClampedArray(width * height * 4);

        if (sourcePixels instanceof Uint8ClampedArray) {
            // Already Uint8ClampedArray - use directly if buffer is ArrayBuffer
            if (sourcePixels.buffer instanceof ArrayBuffer) {
                pixelsArray = sourcePixels;
            } else {
                // SharedArrayBuffer - need to copy
                const newBuffer = new ArrayBuffer(sourcePixels.byteLength);
                const newArray = new Uint8ClampedArray(newBuffer);
                newArray.set(sourcePixels);
                pixelsArray = newArray;
            }
        } else if (sourcePixels instanceof Uint8Array) {
            // Uint8Array - check buffer type
            if (sourcePixels.buffer instanceof ArrayBuffer) {
                // Can use directly by creating Uint8ClampedArray view
                pixelsArray = new Uint8ClampedArray(sourcePixels.buffer, sourcePixels.byteOffset, sourcePixels.byteLength);
            } else {
                // SharedArrayBuffer - need to copy
                const newBuffer = new ArrayBuffer(sourcePixels.byteLength);
                const newArray = new Uint8ClampedArray(newBuffer);
                newArray.set(sourcePixels);
                pixelsArray = newArray;
            }
        } else if (sourcePixels instanceof ArrayBuffer) {
            pixelsArray = new Uint8ClampedArray(sourcePixels);
        } else {
            // Fallback: try to convert
            const sourceArray = sourcePixels as any;
            if (sourceArray.buffer && sourceArray.buffer instanceof ArrayBuffer) {
                pixelsArray = new Uint8ClampedArray(sourceArray.buffer, sourceArray.byteOffset, sourceArray.byteLength);
            } else {
                // Last resort: copy to new ArrayBuffer
                const newBuffer = new ArrayBuffer(sourceArray.length || 0);
                pixelsArray = new Uint8ClampedArray(newBuffer);
                if (sourceArray.length) {
                    pixelsArray.set(sourceArray);
                }
            }
        }
        
        
        // Prefer ImageBitmap when available; avoid blocking the event loop.
        try {
            // Check if we already have a ready ImageBitmap
            let imageBitmap = this.bitmapImageBitmapReady.get(hbitmap);
            
            if (imageBitmap) {
                // Use cached ImageBitmap - this should work!
                memoryCtx.drawImage(imageBitmap, 0, 0);
            } else {
                // Create ImageData first (type assertion needed for ArrayBufferLike)
                const imageData = new (ImageData as any)(pixelsArray, width, height);
                if (!this.bitmapImageBitmapCache.has(hbitmap)) {
                    try {
                        const bitmapPromise = createImageBitmap(imageData);
                        this.bitmapImageBitmapCache.set(hbitmap, bitmapPromise);
                        bitmapPromise.then((bm) => {
                            this.bitmapImageBitmapReady.set(hbitmap, bm);
                            this.bitmapImageBitmapCache.delete(hbitmap);
                        }).catch((e) => {
                            Logger.warn(LogCategory.GDI32, `createBitmapDC: Failed to cache ImageBitmap: ${e}`);
                            this.bitmapImageBitmapCache.delete(hbitmap);
                        });
                    } catch (e) {
                        Logger.warn(LogCategory.GDI32, `createBitmapDC: createImageBitmap failed: ${e}`);
                    }
                }

                // Immediate fallback to avoid blocking; keeps DC usable even if ImageBitmap isn't ready.
                memoryCtx.putImageData(imageData, 0, 0);
            }
            
        } catch (e) {
            Logger.error(LogCategory.GDI32, `createBitmapDC: Failed to create ImageData or drawImage: ${e}`);
            return null;
        }

        const newHdc = this.nextHdc++;
        this.contexts.set(newHdc, memoryCtx);

        // Store bitmap handle for reference
        (memoryCtx as any).__bitmapHandle = hbitmap;

        // Default stock objects: WHITE_BRUSH, BLACK_PEN, SYSTEM_FONT
        const defaultBrush = 0x80000000 | STOCK_WHITE_BRUSH;
        const defaultPen = 0x80000000 | STOCK_BLACK_PEN;
        const defaultFont = 0x80000000 | STOCK_SYSTEM_FONT;
        
        // Setup defaults
        this.hdcStates.set(newHdc, {
            brushColor: '#FFFFFF',
            textColor: '#000000',
            textColorValue: 0,
            bkMode: 1, // TRANSPARENT
            bkColor: '#FFFFFF',
            font: '16px sans-serif',
            fontSize: 16,
            fontQuality: 0,
            textEscapement: 0,
            textAlign: 0,
            appliedFont: '',
            appliedFillStyle: '',
            hBrush: defaultBrush,
            hPen: defaultPen,
            hFont: defaultFont,
            hBitmap: 0,
            imageDataDirty: true,
            dirty: false,
            dirtyRect: null,
        });

        // OPTIMIZATION: Cache the DC for future SelectObject calls
        this.bitmapDCCache.set(hbitmap, newHdc);

        Logger.verbose(LogCategory.GDI32, `createBitmapDC: Created DC 0x${newHdc.toString(16)} for bitmap 0x${hbitmap.toString(16)} (${width}x${height})`);
        return newHdc;
    }

    getCurrentPosition(hdc: number): { x: number; y: number } {
        return this.hdcCurrentPos.get(hdc) ?? { x: 0, y: 0 };
    }

    setCurrentPosition(hdc: number, x: number, y: number): { x: number; y: number } {
        const old = this.getCurrentPosition(hdc);
        this.hdcCurrentPos.set(hdc, { x, y });
        return old;
    }

    deleteDC(hdc: number): boolean {
        const ctx = this.contexts.get(hdc);
        if (!ctx) {
            Logger.warn(LogCategory.GDI32, `deleteDC: Invalid HDC 0x${hdc.toString(16)}`);
            return false;
        }

        // Only delete memory DCs, not screen DCs
        // Screen DCs should be released with ReleaseDC
        const isMemoryDC = ctx.canvas !== this.screenCanvas && ctx.canvas !== this.overlayCanvas;

        if (isMemoryDC) {
            this.hdcStates.delete(hdc);
            this.hdcCurrentPos.delete(hdc);
            this.contexts.delete(hdc);
            dcTeardownHooks.forEach((fn) => fn(hdc));
            // OPTIMIZATION: Clean up bitmap sync state when DC is deleted
            this.dcBitmapSyncState.delete(hdc);
            Logger.verboseLazy(LogCategory.GDI32, () => `deleteDC(0x${hdc.toString(16)}) -> TRUE`);
            return true;
        }

        Logger.warn(LogCategory.GDI32, `deleteDC: Attempted to delete screen DC 0x${hdc.toString(16)}`);
        return false;
    }

    /**
     * Increment the version counter for a bitmap.
     * Call this when the bitmap content is modified (e.g., after drawing to a bitmap DC).
     * This enables the optimization in selectObject to skip redundant drawImage calls.
     */
    invalidateBitmapVersion(hbitmap: number): void {
        const currentVersion = this.bitmapVersions.get(hbitmap) || 0;
        this.bitmapVersions.set(hbitmap, currentVersion + 1);
    }

    /** True if a bitmap handle still resolves to a real object (live, user, or stock).
     *  Used to avoid handing back a dangling handle whose GetObject would fail — Windows
     *  keeps a selected bitmap alive (DeleteObject on it returns FALSE), but our object
     *  pool may have dropped it, leaving a DC's hBitmap stale. */
    private isResolvableBitmap(handle: number): boolean {
        if (!handle) return false;
        if (this.objects.has(handle)) return true;
        if (this.isStockObject(handle)) return true;
        const userObj = SystemResourceProvider.getInstance().getUserObject(handle);
        return !!userObj && userObj.type === 'BITMAP';
    }

    /** Return the GDI object handle currently selected into hdc (GetCurrentObject). */
    getCurrentObjectHandle(hdc: number, objectType: number): number {
        const state = this.hdcStates.get(hdc);
        if (!state) return 0;
        const stock = (id: number) => 0x80000000 | id;
        switch (objectType) {
            case 7: // OBJ_BITMAP
                // Never return a dangling handle: callers (e.g. HL's owner-draw glow blend
                // FUN_0041a360) immediately GetObject it and throw a CMemoryException if it
                // returns 0. Fall back to the default 1×1 bitmap, which always resolves.
                return this.isResolvableBitmap(state.hBitmap)
                    ? state.hBitmap
                    : GDIContext.DEFAULT_BITMAP_HANDLE;
            case 2: // OBJ_BRUSH
                return state.hBrush || stock(STOCK_WHITE_BRUSH);
            case 1: // OBJ_PEN
                return state.hPen || stock(STOCK_BLACK_PEN);
            case 6: // OBJ_FONT
                return state.hFont || stock(STOCK_SYSTEM_FONT);
            case 5: // OBJ_PAL
                return 0;
            default:
                return 0;
        }
    }

    /** GetObjectA/W struct write-back. */
    getObject(hgdiobj: number, cbBuffer: number, lpvObject: number, mem: Uint8Array, isUnicode: boolean = true): number {
        return getObjectImpl(this, hgdiobj, cbBuffer, lpvObject, mem, isUnicode);
    }

    getPixel(hdc: number, x: number, y: number): number {
        // OPTIMIZED: Combined state lookup with context, use Uint32Array for single read
        const state = this.hdcStates.get(hdc);
        if (!state) return 0xFFFFFFFF; // CLR_INVALID

        const ctx = this.contexts.get(hdc);
        if (!ctx?.canvas) return 0xFFFFFFFF;

        const { width, height } = ctx.canvas;

        // Bounds check (fast path - use unsigned comparison trick)
        if ((x >>> 0) >= width || (y >>> 0) >= height) {
            return 0xFFFFFFFF; // CLR_INVALID
        }

        // If cache is dirty or missing, read ENTIRE canvas and create Uint32 view
        // For high-frequency GetPixel calls (1.1M+), this is MUCH faster
        if (state.imageDataDirty || !state.cachedImageData) {
            state.cachedImageData = ctx.getImageData(0, 0, width, height);
            state.imageDataDirty = false;
            // Create Uint32Array view for fast single-read pixel access
            // Format is RGBA in memory, which is 0xAABBGGRR in little-endian
            state.cachedPixels32 = new Uint32Array(
                state.cachedImageData.data.buffer,
                state.cachedImageData.data.byteOffset,
                width * height
            );
        }

        // FAST PATH: Single Uint32 read instead of 3 byte reads
        if (state.cachedPixels32) {
            const pixel = state.cachedPixels32[y * width + x];
            // pixel is 0xAABBGGRR, need to return 0x00BBGGRR (COLORREF)
            return pixel & 0x00FFFFFF;
        }

        // Fallback to byte access (shouldn't happen)
        const offset = (y * width + x) * 4;
        const data = state.cachedImageData!.data;
        return (data[offset + 2] << 16) | (data[offset + 1] << 8) | data[offset];
    }

    /**
     * Get pixel buffer for HDC - used by FastPath to avoid Map lookups on every call.
     * Returns cached Uint32Array pixel data and dimensions.
     */
    getPixelBuffer(hdc: number): { pixels32: Uint32Array; width: number; height: number } | null {
        const state = this.hdcStates.get(hdc);
        if (!state) return null;

        const ctx = this.contexts.get(hdc);
        if (!ctx?.canvas) return null;

        const { width, height } = ctx.canvas;

        // Ensure cache is populated
        if (state.imageDataDirty || !state.cachedImageData) {
            state.cachedImageData = ctx.getImageData(0, 0, width, height);
            state.imageDataDirty = false;
            state.cachedPixels32 = new Uint32Array(
                state.cachedImageData.data.buffer,
                state.cachedImageData.data.byteOffset,
                width * height
            );
        }

        if (!state.cachedPixels32) return null;

        return { pixels32: state.cachedPixels32, width, height };
    }

    /**
     * Get ImageData for a DC (used for ReleaseDC optimization)
     */
    getImageData(hdc: number): ImageData | undefined {
        const ctx = this.contexts.get(hdc);
        if (!ctx) return undefined;

        const state = this.hdcStates.get(hdc);
        if (!state) return undefined;

        if (state.imageDataDirty || !state.cachedImageData) {
            state.cachedImageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
            state.imageDataDirty = false;
        }

        return state.cachedImageData;
    }

    bitBlt(hdcDest: number, x: number, y: number, width: number, height: number,
           hdcSrc: number, xSrc: number, ySrc: number, rop: number): boolean {
        return bitBltImpl(this, hdcDest, x, y, width, height, hdcSrc, xSrc, ySrc, rop);
    }

    stretchBlt(hdcDest: number, xDest: number, yDest: number, wDest: number, hDest: number,
               hdcSrc: number, xSrc: number, ySrc: number, wSrc: number, hSrc: number, rop: number): boolean {
        return stretchBltImpl(this, hdcDest, xDest, yDest, wDest, hDest, hdcSrc, xSrc, ySrc, wSrc, hSrc, rop);
    }

    deleteObject(hgdiobj: number): boolean {
        return deleteObjectImpl(this, hgdiobj);
    }

    createSolidBrush(color: number): number {
        return createSolidBrushImpl(this, color);
    }

    createPatternBrush(hBitmap: number): number {
        return createPatternBrushImpl(this, hBitmap);
    }

    createCompatibleBitmap(hdc: number, cx: number, cy: number): number {
        return createCompatibleBitmapImpl(this, hdc, cx, cy);
    }

    selectObject(hdc: number, hgdiobj: number): number {
        const ctx = this.contexts.get(hdc);
        if (!ctx) {
            Logger.warn(LogCategory.GDI32, `selectObject: Invalid HDC 0x${hdc.toString(16)}`);
            return 0;
        }

        const state = this.ensureState(hdc);
        let obj: GDIObject | null = null;
        let previousHandle = 0;

        // Check if it's a stock object
        if (this.isStockObject(hgdiobj)) {
            obj = this.getStockObject(hgdiobj);
            if (!obj) {
                Logger.warn(LogCategory.GDI32, `selectObject: Unknown stock object 0x${hgdiobj.toString(16)}`);
                return 0;
            }
        } else {
            // Try to get from objects map
            obj = this.objects.get(hgdiobj) || null;

            // Fallback: check SystemResourceProvider for BITMAP objects from LoadImageA
            if (!obj) {
                const userObj = SystemResourceProvider.getInstance().getUserObject(hgdiobj);
                if (userObj && userObj.type === 'BITMAP') {
                    obj = { handle: hgdiobj, type: 'BITMAP', data: userObj };
                }
            }
        }

        if (!obj) {
            Logger.verbose(LogCategory.GDI32, `selectObject: Unknown object handle 0x${hgdiobj.toString(16)}`);
            return 0;
        }

        // Handle BITMAP selection for memory DCs
        if (obj.type === 'BITMAP') {
            const isMemoryDC = ctx.canvas !== this.screenCanvas && ctx.canvas !== this.overlayCanvas;
            if (isMemoryDC) {
                // Save previous bitmap handle
                previousHandle = state.hBitmap;

                // OPTIMIZATION: Early exit if same bitmap already selected
                // Return the previous handle (same as hgdiobj in this case) per Windows API spec
                if (state.hBitmap === hgdiobj) {
                    return previousHandle; // Already selected, return previous handle
                }

                // Stock default bitmap = deselect current bitmap
                if (hgdiobj === GDIContext.DEFAULT_BITMAP_HANDLE) {
                    state.hBitmap = hgdiobj;
                    (ctx.canvas as any).__linkedBitmap = undefined;
                    (ctx.canvas as any).__bitmapCanvas = undefined;
                    return previousHandle;
                }

                // For memory DC, we need to link the bitmap to the DC
                // Create or reuse bitmap DC (now cached via bitmapDCCache)
                const bitmapDC = this.createBitmapDC(hgdiobj);
                if (bitmapDC) {
                    const bitmapCtx = this.contexts.get(bitmapDC);
                    if (bitmapCtx) {
                        const userObj = obj.data;
                        const bitmapWidth = userObj.width || bitmapCtx.canvas.width;
                        const bitmapHeight = userObj.height || bitmapCtx.canvas.height;

                        // Resize memory DC canvas if needed
                        let needsRedraw = false;
                        if (ctx.canvas.width !== bitmapWidth || ctx.canvas.height !== bitmapHeight) {
                            ctx.canvas.width = bitmapWidth;
                            ctx.canvas.height = bitmapHeight;
                            this.invalidateImageDataCache(hdc);
                            needsRedraw = true;
                        }

                        // DIBSection bits are written directly by the guest (no API to
                        // observe, no version bump) — re-materialize from live memory
                        // on every select so reads see the current surface.
                        const isDibSection = !!(userObj.bitsPtr && userObj.dibStride);
                        const dibPixels = isDibSection ? this.refreshDibSectionCanvas(hgdiobj) : null;

                        // PERFORMANCE OPTIMIZATION: Track bitmap versions to skip redundant drawImage
                        // Only copy bitmap content if the bitmap has changed since last sync
                        const bitmapVersion = this.bitmapVersions.get(hgdiobj) || 0;
                        const syncState = this.dcBitmapSyncState.get(hdc);
                        const needsSync = needsRedraw ||
                            isDibSection ||
                            !syncState ||
                            syncState.hbitmap !== hgdiobj ||
                            syncState.version !== bitmapVersion;

                        if (dibPixels) {
                            // The refresh already converted the whole bitmap; going through
                            // the bitmap canvas again would be a second full-surface copy.
                            ctx.putImageData(
                                new (ImageData as any)(dibPixels.data, dibPixels.width, dibPixels.height), 0, 0);
                            this.invalidateImageDataCache(hdc);
                            this.dcBitmapSyncState.set(hdc, { hbitmap: hgdiobj, version: bitmapVersion });
                        } else if (needsSync) {
                            // Copy bitmap content to memory DC
                            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
                            ctx.drawImage(bitmapCtx.canvas, 0, 0);
                            this.invalidateImageDataCache(hdc);
                            // Update sync state
                            this.dcBitmapSyncState.set(hdc, { hbitmap: hgdiobj, version: bitmapVersion });
                        }

                        // Store bitmap handle and link bitmap canvas to DC
                        state.hBitmap = hgdiobj;
                        const isEmptyCompatible = !!(userObj as { compatibleEmpty?: boolean }).compatibleEmpty;
                        if (!isEmptyCompatible) {
                            state.pristine = false;
                            state.skipOverlayFlush = false;
                        }
                        (ctx.canvas as any).__linkedBitmap = hgdiobj;
                        (ctx.canvas as any).__bitmapCanvas = bitmapCtx.canvas;

                        Logger.verboseLazy(LogCategory.GDI32, () =>
                            `selectObject: Selected BITMAP 0x${hgdiobj.toString(16)} (${bitmapWidth}x${bitmapHeight}) into memory DC 0x${hdc.toString(16)} needsSync=${needsSync}`
                        );
                        return previousHandle;
                    }
                }
                return previousHandle;
            }
            // For non-memory DCs, bitmap selection is not supported
            return previousHandle;
        }

        // Handle BRUSH selection
        // NOTE: No invalidateImageDataCache here - selecting a brush doesn't change pixels
        if (obj.type === 'BRUSH') {
            previousHandle = state.hBrush;
            state.hBrush = hgdiobj;
            if (typeof obj.data === 'string') {
                state.brushColor = obj.data;
            }
            return previousHandle;
        }

        // Handle PEN selection
        // NOTE: No invalidateImageDataCache here - selecting a pen doesn't change pixels
        if (obj.type === 'PEN') {
            previousHandle = state.hPen;
            state.hPen = hgdiobj;
            ctx.strokeStyle = obj.data;
            return previousHandle;
        }

        // Handle FONT selection
        // NOTE: No invalidateImageDataCache here - selecting a font doesn't change pixels
        if (obj.type === 'FONT') {
            previousHandle = state.hFont;
            state.hFont = hgdiobj;
            state.font = obj.data;
            state.textEscapement = obj.escapement || 0;
            // Use cached font size from object (parsed once in createFont)
            // Fallback to 16 if not cached (shouldn't happen, but safety check)
            state.fontSize = obj.fontSize ?? 16;
            state.fontQuality = obj.lfQuality ?? 0;
            // Mark font as not applied so it will be applied on next textOut
            state.appliedFont = '';
            return previousHandle;
        }

        return 0;
    }

    createPen(style: number, width: number, color: number): number {
        return createPenImpl(this, style, width, color);
    }

    /** Stroke a flat x,y,... point list with hdc's pen (LineTo/Polyline/Rectangle border). */
    strokePolyline(hdc: number, pts: readonly number[], closed = false): boolean {
        return strokePolylineImpl(this, hdc, pts, closed);
    }

    lineTo(hdc: number, x: number, y: number): boolean {
        return lineToImpl(this, hdc, x, y);
    }

    /** Face name of the font selected into hdc. */
    getSelectedFontFace(hdc: number): string {
        return getSelectedFontFaceImpl(this, hdc);
    }

    createFont(height: number, width: number, weight: number, italic: boolean, faceName: string, escapement?: number, quality?: number): number {
        return createFontImpl(this, height, width, weight, italic, faceName, escapement, quality);
    }

    /** CSS font string for an HFONT. */
    getFontCss(hFont: number): string | null {
        return getFontCssImpl(this, hFont);
    }

    fillRect(hdc: number, left: number, top: number, right: number, bottom: number): boolean {
        const ctx = this.contexts.get(hdc);
        const state = this.hdcStates.get(hdc);
        if (!ctx || !state) {
            Logger.warn(LogCategory.GDI32, `fillRect: HDC ${hdc} not found`);
            return false;
        }

        // Mark overlay as dirty if we're drawing to it
        const isOverlay = ctx === this.overlayCtx;
        if (isOverlay) {
            this.setOverlayDirty(true);
            Logger.verbose(LogCategory.GDI32, `fillRect: Drawing to overlay canvas, marked dirty. Rect: (${left}, ${top}) ${right-left}x${bottom-top}`);
        }

        // Resolve current brush style (solid or bitmap pattern).
        let fillStyle: string | CanvasPattern = state.brushColor;
        let patternTile: OffscreenCanvas | null = null;
        const brushObj = this.isStockObject(state.hBrush)
            ? this.getStockObject(state.hBrush)
            : (this.objects.get(state.hBrush) ?? null);
        if (brushObj && brushObj.type === 'BRUSH') {
            if (typeof brushObj.data === 'string') {
                fillStyle = brushObj.data;
            } else if (brushObj.data && brushObj.data.kind === 'pattern' && brushObj.data.tileCanvas) {
                patternTile = brushObj.data.tileCanvas as OffscreenCanvas;
                const pattern = ctx.createPattern(patternTile, 'repeat');
                if (pattern) {
                    fillStyle = pattern;
                }
            }
        }
        ctx.fillStyle = fillStyle;
        state.appliedFillStyle = typeof fillStyle === 'string' ? fillStyle : '__pattern__';

        const w = right - left;
        const h = bottom - top;
        Logger.verbose(LogCategory.GDI32, `fillRect: HDC ${hdc} (${left}, ${top}) ${w}x${h} color=${ctx.fillStyle}`);
        const clipped = this.beginClipOn(hdc, ctx);
        ctx.fillRect(left, top, w, h);
        if (clipped) ctx.restore();

        // A DIBSection's guest bits are its pixel surface, so the fill has to land there
        // too — the next SelectObject re-materializes the canvas from those bits.
        const back = this.clipCopyRect(hdc, left, top, w, h);
        if (back) writeBackDibSectionRect(state.hBitmap, ctx, back.x, back.y, back.w, back.h);

        // Mark as dirty for ReleaseDC optimization
        this.expandDirtyRect(hdc, left, top, w, h);
        this.markDirty(hdc);
        
        // Invalidate image data cache after drawing
        this.invalidateImageDataCache(hdc);
        
        // If this is a memory DC with linked bitmap, update the bitmap canvas
        const linkedBitmap = (ctx.canvas as any).__bitmapCanvas;
        if (linkedBitmap) {
            const bitmapCtx = linkedBitmap.getContext('2d');
            if (bitmapCtx) {
                if (patternTile) {
                    const bitmapPattern = bitmapCtx.createPattern(patternTile, 'repeat');
                    bitmapCtx.fillStyle = bitmapPattern ?? '#000000';
                } else {
                    bitmapCtx.fillStyle = fillStyle as string;
                }
                const mirrorClipped = this.beginClipOn(hdc, bitmapCtx);
                bitmapCtx.fillRect(left, top, w, h);
                if (mirrorClipped) bitmapCtx.restore();
            }
        }
        
        return true;
    }

    setTextColor(hdc: number, color: number): number {
        const state = this.ensureState(hdc);
        const previous = state.textColorValue;
        state.textColorValue = color;
        state.textColor = this.colorToCss(color);
        return previous;
    }

    setBkColor(hdc: number, color: number): number {
        const ctx = this.contexts.get(hdc);
        const state = this.hdcStates.get(hdc);
        if (!ctx || !state) {
            Logger.warn(LogCategory.GDI32, `setBkColor: Invalid HDC 0x${hdc.toString(16)}`);
            return 0xFFFFFFFF; // CLR_INVALID
        }

        const previous = this.cssToColor(state.bkColor);
        state.bkColor = this.colorToCss(color);
        return previous;
    }

    getBkColor(hdc: number): number {
        const state = this.hdcStates.get(hdc);
        if (!state) {
            return 0xFFFFFFFF; // CLR_INVALID
        }
        return this.cssToColor(state.bkColor);
    }

    /** CSS text color set on hdc (WM_CTLCOLOR* capture). */
    getTextColorCss(hdc: number): string | null {
        return this.hdcStates.get(hdc)?.textColor ?? null;
    }

    /** CSS background color set on hdc (WM_CTLCOLOR* capture). */
    getBkColorCss(hdc: number): string | null {
        return this.hdcStates.get(hdc)?.bkColor ?? null;
    }

    /** Solid-brush CSS color for an HBRUSH; null for patterns/unknown handles. */
    getBrushCss(hBrush: number): string | null {
        const obj = this.objects.get(hBrush);
        return obj?.type === 'BRUSH' && typeof obj.data === 'string' ? obj.data : null;
    }

    setBkMode(hdc: number, mode: number): number {
        const state = this.ensureState(hdc);
        const previous = state.bkMode;
        state.bkMode = mode;
        return previous;
    }

    setTextAlign(hdc: number, align: number): number {
        if (!this.contexts.has(hdc)) return 0xFFFFFFFF; // GDI_ERROR
        const state = this.ensureState(hdc);
        const previous = state.textAlign;
        state.textAlign = align >>> 0;
        return previous;
    }

    getTextAlign(hdc: number): number {
        if (!this.contexts.has(hdc)) return 0xFFFFFFFF; // GDI_ERROR
        return this.ensureState(hdc).textAlign;
    }

    textOut(hdc: number, x: number, y: number, text: string): boolean {
        return textOutImpl(this, hdc, x, y, text);
    }

    drawText(hdc: number, text: string, rect?: { left: number; top: number; right: number; bottom: number }, format?: number): DrawTextLayout | null {
        return drawTextImpl(this, hdc, text, rect, format);
    }

    private ensureState(hdc: number): {
        brushColor: string;
        textColor: string;
        textColorValue: number;
        bkMode: number;
        bkColor: string;
        font: string;
        fontSize: number;
        fontQuality: number;
        textEscapement: number;
        textAlign: number;
        appliedFont: string;
        appliedFillStyle: string;
        hBrush: number;
        hPen: number;
        hFont: number;
        hBitmap: number;
        cachedImageData?: ImageData;
        imageDataDirty: boolean;
        dirty: boolean;
        dirtyRect: { x1: number, y1: number, x2: number, y2: number } | null;
        windowBlit?: { absX: number; absY: number; width: number; height: number };
        pristine?: boolean;
        skipOverlayFlush?: boolean;
    } {
        let state = this.hdcStates.get(hdc);
        if (!state) {
            // Default stock objects: WHITE_BRUSH, BLACK_PEN, SYSTEM_FONT
            const defaultBrush = 0x80000000 | STOCK_WHITE_BRUSH;
            const defaultPen = 0x80000000 | STOCK_BLACK_PEN;
            const defaultFont = 0x80000000 | STOCK_SYSTEM_FONT;
            
            state = {
                brushColor: '#FFFFFF',
                textColor: '#000000',
                textColorValue: 0,
                bkMode: 1,
                bkColor: '#FFFFFF',
                font: '16px sans-serif',
                fontSize: 16,
                fontQuality: 0,
                textEscapement: 0,
                textAlign: 0,
                appliedFont: '',
                appliedFillStyle: '',
                hBrush: defaultBrush,
                hPen: defaultPen,
                hFont: defaultFont,
                hBitmap: 0,
                imageDataDirty: true,
                dirty: false,
                dirtyRect: null,
            };
            this.hdcStates.set(hdc, state);
        }
        return state;
    }

    /** COLORREF → cached CSS color string. */
    private colorToCss(color: number): string {
        return colorToCssImpl(this, color);
    }

    /** CSS → COLORREF. */
    private cssToColor(css: string): number {
        return cssToColorImpl(css);
    }

    /** Stock-object resolution by stock ID. */
    private getStockObject(objectId: number): GDIObject | null {
        return getStockObjectImpl(objectId);
    }

    /** True if handle is a stock object. */
    private isStockObject(handle: number): boolean {
        return isStockObjectImpl(handle);
    }

    /**
     * Invalidate image data cache for a DC
     */
    invalidateImageDataCache(hdc: number): void {
        const state = this.hdcStates.get(hdc);
        if (state) {
            state.imageDataDirty = true;
            state.cachedImageData = undefined;
        }
    }

    /**
     * Mark DC as needing a canvas -> surface memory sync.
     * Used to optimize ReleaseDC - skip sync if nothing was drawn on canvas only.
     */
    markDirty(hdc: number): void {
        const state = this.hdcStates.get(hdc);
        if (state) {
            state.dirty = true;
            state.pristine = false;
            // Real drawing after a no-op pristine BitBlt must flush to overlay.
            state.skipOverlayFlush = false;
            // CreateCompatibleBitmap starts compatibleEmpty; once drawn, the canvas is
            // truth and a later SelectObject must clear pristine (see selectObject BITMAP).
            const hBmp = state.hBitmap;
            if (hBmp && hBmp !== GDIContext.DEFAULT_BITMAP_HANDLE) {
                const obj = SystemResourceProvider.getInstance().getUserObject(hBmp) as
                    { compatibleEmpty?: boolean } | undefined;
                if (obj?.compatibleEmpty) obj.compatibleEmpty = false;
            }
        }
    }

    /**
     * Check if DC needs a canvas -> surface memory sync.
     */
    isDirty(hdc: number): boolean {
        const state = this.hdcStates.get(hdc);
        return state?.dirty ?? false;
    }

    /**
     * Clear dirty flag (called after ReleaseDC sync)
     */
    clearDirty(hdc: number): void {
        const state = this.hdcStates.get(hdc);
        if (state) {
            state.dirty = false;
            state.dirtyRect = null; // Reset dirty rectangle
        }
    }

    /**
     * Expand dirty rectangle to include the specified area
     */
    expandDirtyRect(hdc: number, x: number, y: number, w: number, h: number): void {
        const state = this.hdcStates.get(hdc);
        if (!state) return;

        // Handle negative dimensions
        let realX = x;
        let realY = y;
        let realW = w;
        let realH = h;
        if (realW < 0) { realX += realW; realW = Math.abs(realW); }
        if (realH < 0) { realY += realH; realH = Math.abs(realH); }

        const x2 = realX + realW;
        const y2 = realY + realH;

        if (!state.dirtyRect) {
            state.dirtyRect = { 
                x1: Math.floor(realX), 
                y1: Math.floor(realY), 
                x2: Math.ceil(x2), 
                y2: Math.ceil(y2) 
            };
        } else {
            state.dirtyRect.x1 = Math.min(state.dirtyRect.x1, Math.floor(realX));
            state.dirtyRect.y1 = Math.min(state.dirtyRect.y1, Math.floor(realY));
            state.dirtyRect.x2 = Math.max(state.dirtyRect.x2, Math.ceil(x2));
            state.dirtyRect.y2 = Math.max(state.dirtyRect.y2, Math.ceil(y2));
        }
        
        state.dirty = true;
    }

    /**
     * Get the OffscreenCanvas for an HDC (for direct GPU-to-GPU copy)
     */
    getCanvasForHDC(hdc: number): OffscreenCanvas | null {
        const ctx = this.contexts.get(hdc);
        return ctx ? ctx.canvas : null;
    }

    /**
     * Get the dirty rectangle bounds for partial GPU uploads
     */
    getDirtyRect(hdc: number): { x: number, y: number, width: number, height: number } | null {
        const state = this.hdcStates.get(hdc);
        if (!state || !state.dirtyRect) return null;

        const ctx = this.contexts.get(hdc);
        if (!ctx) return null;

        // Clamp to canvas bounds
        const x = Math.max(0, state.dirtyRect.x1);
        const y = Math.max(0, state.dirtyRect.y1);
        const w = Math.min(ctx.canvas.width, state.dirtyRect.x2) - x;
        const h = Math.min(ctx.canvas.height, state.dirtyRect.y2) - y;

        if (w <= 0 || h <= 0) return null;

        return { x, y, width: w, height: h };
    }

    /**
     * Reset GDI context state - clear all contexts, objects, and states
     */
    /**
     * Link a DC to a DDraw surface (called from IDirectDrawSurface7_GetDC)
     */
    linkDCToSurface(hdc: number, surfacePtr: number): void {
        this.linkedSurfaces.set(hdc, surfacePtr);
        Logger.verbose(LogCategory.GDI32, `linkDCToSurface: DC 0x${hdc.toString(16)} linked to surface 0x${surfacePtr.toString(16)}`);
    }

    /**
     * Get the DDraw surface pointer linked to a DC (called from IDirectDrawSurface7_ReleaseDC)
     */
    getLinkedSurface(hdc: number): number | undefined {
        return this.linkedSurfaces.get(hdc);
    }

    /**
     * Unlink a DC from a DDraw surface (called when DC is released)
     */
    unlinkDCFromSurface(hdc: number): void {
        const surfacePtr = this.linkedSurfaces.get(hdc);
        if (surfacePtr !== undefined) {
            this.linkedSurfaces.delete(hdc);
            Logger.verbose(LogCategory.GDI32, `unlinkDCFromSurface: DC 0x${hdc.toString(16)} unlinked from surface 0x${surfacePtr.toString(16)}`);
        }
    }

    /**
     * Get the HDC linked to a specific DDraw surface.
     * When a game leaks GetDC without ReleaseDC, multiple HDCs may be linked;
     * return the most recently allocated one (highest handle) — that's where
     * the latest StretchDIBits/BitBlt drew.
     */
    getHDCBySurface(surfacePtr: number): number | undefined {
        let latest: number | undefined;
        for (const [hdc, sPtr] of this.linkedSurfaces.entries()) {
            if (sPtr === surfacePtr && (latest === undefined || hdc > latest)) {
                latest = hdc;
            }
        }
        return latest;
    }

    reset(): void {
        this.contexts.clear();
        this.objects.clear();
        this.hdcStates.clear();
        this.hdcCurrentPos.clear();
        this.stockObjects.clear();
        this.linkedSurfaces.clear();
        this.colorCache.clear();
        this.fontCache.clear();
        this.handleRefs.clear();
        for (const bm of this.bitmapImageBitmapReady.values()) {
            try { bm.close(); } catch { /* ImageBitmap may already be closed */ }
        }
        this.bitmapImageBitmapReady.clear();
        this.bitmapImageBitmapCache.clear();
        this.bitmapDCCache.clear();
        this.bitmapVersions.clear();
        this.dcBitmapSyncState.clear();
        this.windowClientBacking.clear();
        this.nextHdc = 0x20000;
        this.nextHgdiobj = 0x30000;
        this.clearOverlay();
        this.overlayDirty = false;
        this.overlayHasContent = false;
        Logger.log(LogCategory.GDI32, 'GDIContext reset');
    }
}

export function createContextExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // SetDeviceGammaRamp(hdc, lpRamp) / GetDeviceGammaRamp(hdc, lpRamp) — the GDI path that GoldSrc/
    // GoldSrc-style engines use for the brightness slider. Routed to the shared RAMDAC LUT sink.
    exports["SetDeviceGammaRamp"] = (_ctx, mem, args) => {
        return gammaService.applyFromGuest(mem, args[1]) ? 1 : 0;
    };
    exports["GetDeviceGammaRamp"] = (_ctx, mem, args) => {
        return gammaService.writeToGuest(mem, args[1]) ? 1 : 0;
    };

    return exports;
}
