/**
 * GDI32 device-context state: coordinate-space mapping, world transform, clipping
 * queries, and the printing/doc spool stubs. Mapping/clip/print handlers (mostly
 * faithful stubs) with no rendering.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { isValidAddress } from '../../core/memory/address-guard';
import { registerDcTeardown } from './context';
import {
    clipIntersectsRect,
    clipRegionFromRect,
    clipRegionFromEllipse,
    clipRegionFromRoundRect,
    clipRegionFromPolygon,
    cloneClipRegion,
    combineClipRegions,
    offsetClipRegion,
    clipRegionType,
    RGN_AND,
    RGN_COPY,
    NULLREGION,
    type DcClipRegion,
} from './dc-clip';

// ---------------------------------------------------------------------------
// Region handle store
// ---------------------------------------------------------------------------
// HRGN registry. A region is the same rect LIST a DC's clip is (dc-clip.ts), so a
// non-rectangular region survives the round trip through SelectClipRgn/CombineRgn as
// a shape: a box-only store would let output escape wherever the shape is concave, and
// leaves RGN_OR/RGN_XOR with no answer but "widen to the union's box".
const _regionStore = new Map<number, DcClipRegion>();
let _nextRgnHandle = 0x70000001; // distinct from HDC/HGDIOBJ/HPALETTE ranges

function _rgnAlloc(region: DcClipRegion): number {
    const h = _nextRgnHandle++;
    _regionStore.set(h, region);
    return h;
}

const ERROR_REGION = 0;

/** RECT is 16 bytes; a guest pointer is validated over that whole extent before use. */
const RECT_SIZE = 16;
/** POINT / SIZE are 8 bytes (two LONGs). */
const POINT_SIZE = 8;

// ---------------------------------------------------------------------------
// Per-DC coordinate mapping
// ---------------------------------------------------------------------------
// The window→viewport mapping a DC carries: map mode, the two origins, the two
// extents, and the graphics mode. DPtoLP/LPtoDP exist FOR this state — with none
// kept they can only answer "identity", which is a wrong answer the caller cannot
// detect (a dialog that measures a font through DPtoLP under a non-MM_TEXT mode
// gets a nonsense point size back and asks for a nonsense font).
//
// Only the coordinate queries consume it: our primitives draw in device space, so
// nothing here silently rescales existing output.

const MM_TEXT = 1;
const MM_LOMETRIC = 2;
const MM_HIMETRIC = 3;
const MM_LOENGLISH = 4;
const MM_HIENGLISH = 5;
const MM_TWIPS = 6;
const MM_ISOTROPIC = 7;
const MM_ANISOTROPIC = 8;

const GM_COMPATIBLE = 1;
const GM_ADVANCED = 2;

/** Device pixels per inch and screen size in millimetres — GetDeviceCaps' answers. */
const DC_LOGPIXELS = 96;
const MM_PER_INCH_X10 = 254;

export interface DcMapping {
    mapMode: number;
    graphicsMode: number;
    wndOrgX: number; wndOrgY: number;
    vportOrgX: number; vportOrgY: number;
    wndExtX: number; wndExtY: number;
    vportExtX: number; vportExtY: number;
}

const _dcMapping = new Map<number, DcMapping>();

/** Win32's DC defaults: MM_TEXT, GM_COMPATIBLE, both origins at 0, unit extents. */
export function defaultDcMapping(): DcMapping {
    return {
        mapMode: MM_TEXT, graphicsMode: GM_COMPATIBLE,
        wndOrgX: 0, wndOrgY: 0, vportOrgX: 0, vportOrgY: 0,
        wndExtX: 1, wndExtY: 1, vportExtX: 1, vportExtY: 1,
    };
}

/** Mutable mapping for a DC, created on first WRITE. */
function mappingFor(hdc: number): DcMapping {
    let m = _dcMapping.get(hdc);
    if (!m) {
        m = defaultDcMapping();
        _dcMapping.set(hdc, m);
    }
    return m;
}

/**
 * Read-only mapping. Queries take this instead of mappingFor: an HDC the guest passes to
 * GetMapMode/DPtoLP need not be one of ours, and inserting on read would grow the map by
 * one entry per bogus handle with no teardown to ever remove it.
 */
const READONLY_DEFAULT_MAPPING: Readonly<DcMapping> = Object.freeze(defaultDcMapping());
function readMapping(hdc: number): Readonly<DcMapping> {
    return _dcMapping.get(hdc) ?? READONLY_DEFAULT_MAPPING;
}

/** Screen extent in device pixels — the "virtual resolution" Wine's set_map_mode reads. */
function screenRes(): { cx: number; cy: number } {
    const canvas = System.getInstance().gdiContext.getOverlayCanvas?.();
    return { cx: Math.max(1, canvas?.width ?? 640), cy: Math.max(1, canvas?.height ?? 480) };
}

const muldiv = (a: number, b: number, c: number): number => Math.round((a * b) / c);

/**
 * Apply a map mode's fixed window/viewport extents (Wine win32u/mapping.c:113-178).
 * The metric modes derive theirs from the display's size and resolution; only
 * MM_ISOTROPIC / MM_ANISOTROPIC leave the app's own Set*ExtEx values in place.
 * Returns false for a mode outside the enum, exactly as set_map_mode does.
 */
export function applyMapMode(m: DcMapping, mode: number, res = screenRes()): boolean {
    if (mode === m.mapMode && (mode === MM_ISOTROPIC || mode === MM_ANISOTROPIC)) return true;
    // Physical size in tenths of a millimetre, from resolution and dots-per-inch.
    const sizeX = muldiv(res.cx, MM_PER_INCH_X10, DC_LOGPIXELS);
    const sizeY = muldiv(res.cy, MM_PER_INCH_X10, DC_LOGPIXELS);
    switch (mode) {
        case MM_TEXT:
            m.wndExtX = 1; m.wndExtY = 1; m.vportExtX = 1; m.vportExtY = 1;
            break;
        case MM_LOMETRIC:
        case MM_ISOTROPIC:
            m.wndExtX = sizeX * 10; m.wndExtY = sizeY * 10;
            m.vportExtX = res.cx; m.vportExtY = -res.cy;
            break;
        case MM_HIMETRIC:
            m.wndExtX = sizeX * 100; m.wndExtY = sizeY * 100;
            m.vportExtX = res.cx; m.vportExtY = -res.cy;
            break;
        case MM_LOENGLISH:
            m.wndExtX = muldiv(1000, sizeX, 254); m.wndExtY = muldiv(1000, sizeY, 254);
            m.vportExtX = res.cx; m.vportExtY = -res.cy;
            break;
        case MM_HIENGLISH:
            m.wndExtX = muldiv(10000, sizeX, 254); m.wndExtY = muldiv(10000, sizeY, 254);
            m.vportExtX = res.cx; m.vportExtY = -res.cy;
            break;
        case MM_TWIPS:
            m.wndExtX = muldiv(14400, sizeX, 254); m.wndExtY = muldiv(14400, sizeY, 254);
            m.vportExtX = res.cx; m.vportExtY = -res.cy;
            break;
        case MM_ANISOTROPIC:
            break;
        default:
            return false;
    }
    m.mapMode = mode;
    return true;
}

/** Logical → device (Wine's construct_window_to_viewport, win32u/dc.c:417). */
export function lpToDp(m: DcMapping, x: number, y: number): { x: number; y: number } {
    const scaleX = m.vportExtX / m.wndExtX;
    const scaleY = m.vportExtY / m.wndExtY;
    return {
        x: Math.round(x * scaleX + (m.vportOrgX - scaleX * m.wndOrgX)),
        y: Math.round(y * scaleY + (m.vportOrgY - scaleY * m.wndOrgY)),
    };
}

/** Device → logical: the inverse transform. Null when it has no inverse (zero extent). */
export function dpToLp(m: DcMapping, x: number, y: number): { x: number; y: number } | null {
    const scaleX = m.vportExtX / m.wndExtX;
    const scaleY = m.vportExtY / m.wndExtY;
    if (!scaleX || !scaleY || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return null;
    return {
        x: Math.round((x - (m.vportOrgX - scaleX * m.wndOrgX)) / scaleX),
        y: Math.round((y - (m.vportOrgY - scaleY * m.wndOrgY)) / scaleY),
    };
}

/** Transform `count` POINTs in place. False (and no writes) on a bad guest pointer. */
function transformPoints(
    mem: Uint8Array, lppt: number, count: number,
    map: (x: number, y: number) => { x: number; y: number } | null,
): boolean {
    if (count <= 0) return count === 0;
    if (!lppt || !isValidAddress(mem, lppt, POINT_SIZE * count, "rw")) return false;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    for (let i = 0; i < count; i++) {
        const at = lppt + i * POINT_SIZE;
        const out = map(view.getInt32(at, true), view.getInt32(at + 4, true));
        if (!out) return false;
        view.setInt32(at, out.x, true);
        view.setInt32(at + 4, out.y, true);
    }
    return true;
}

/** Store a POINT/SIZE out-param, when the caller asked for one. */
function writePair(mem: Uint8Array, ptr: number, a: number, b: number): void {
    if (!ptr || !isValidAddress(mem, ptr, POINT_SIZE, "rw")) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setInt32(ptr, a, true);
    view.setInt32(ptr + 4, b, true);
}

// DeleteDC/ReleaseDC drop the mapping with the DC — BeginPaint makes one per paint.
registerDcTeardown((hdc) => { _dcMapping.delete(hdc); });

export function registerPaintingDcStateExports(exports: Record<string, ThunkImplementation>): void {
    // Coordinate transformations and mapping
    exports['SetMapMode'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const iMode = args[1] | 0;
        const m = mappingFor(hdc);
        const prev = m.mapMode;
        Logger.verbose(LogCategory.GDI32, `SetMapMode(hdc=0x${hdc.toString(16)}, mode=${iMode})`);
        return applyMapMode(m, iMode) ? prev : 0;
    };

    exports['GetMapMode'] = (ctx, mem, args): number => readMapping(args[0]).mapMode;

    // int SetGraphicsMode(HDC, int) — GM_COMPATIBLE / GM_ADVANCED. Returns the PREVIOUS
    // mode, 0 for a mode outside the enum (Wine win32u/dc.c:892-907, :970). GM_ADVANCED
    // only unlocks the world transform; it does not reset one already set.
    exports['SetGraphicsMode'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const mode = args[1] | 0;
        const m = mappingFor(hdc);
        const prev = m.graphicsMode;
        Logger.verbose(LogCategory.GDI32, `SetGraphicsMode(hdc=0x${hdc.toString(16)}, ${mode}) -> ${prev}`);
        if (mode === prev) return prev;
        if (mode < GM_COMPATIBLE || mode > GM_ADVANCED) return 0;
        m.graphicsMode = mode;
        return prev;
    };

    exports['GetGraphicsMode'] = (ctx, mem, args): number => readMapping(args[0]).graphicsMode;

    // BOOL ModifyWorldTransform(HDC hdc, const XFORM *lpXform, DWORD iMode)
    // MWT_IDENTITY=1, MWT_LEFTMULTIPLY=2, MWT_RIGHTMULTIPLY=3
    exports['ModifyWorldTransform'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const iMode = args[2];
        Logger.verbose(LogCategory.GDI32, `ModifyWorldTransform(hdc=0x${hdc.toString(16)}, mode=${iMode}) — stub`);
        return 1; // success
    };

    // The origin/extent setters all follow the same Win32 shape: hand back the PREVIOUS
    // value through the out-param, then install the new one (Wine gdi32/dc.c:1205-1217).
    exports['SetViewportOrgEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const m = mappingFor(hdc);
        Logger.verbose(LogCategory.GDI32, `SetViewportOrgEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        writePair(mem, args[3], m.vportOrgX, m.vportOrgY);
        m.vportOrgX = x; m.vportOrgY = y;
        return 1;
    };

    // BOOL SetWindowOrgEx(HDC, int X, int Y, LPPOINT) — the LOGICAL point that maps to
    // the viewport origin. Half of what DPtoLP subtracts; unimplemented, every logical
    // coordinate a shifted-origin DC produced was off by the shift.
    exports['SetWindowOrgEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const m = mappingFor(hdc);
        Logger.verbose(LogCategory.GDI32, `SetWindowOrgEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        writePair(mem, args[3], m.wndOrgX, m.wndOrgY);
        m.wndOrgX = x; m.wndOrgY = y;
        return 1;
    };

    exports['SetViewportExtEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const m = mappingFor(hdc);
        Logger.verbose(LogCategory.GDI32, `SetViewportExtEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        writePair(mem, args[3], m.vportExtX, m.vportExtY);
        // Only the two scalable modes accept app extents; the metric modes own theirs and
        // the call is a documented no-op that still SUCCEEDS (Wine NtGdiSetViewportExtEx
        // jumps to `done` and returns TRUE). A zero extent is the one real failure.
        if (!x || !y) return 0;
        if (m.mapMode === MM_ISOTROPIC || m.mapMode === MM_ANISOTROPIC) {
            m.vportExtX = x; m.vportExtY = y;
        }
        return 1;
    };

    exports['SetWindowExtEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const m = mappingFor(hdc);
        Logger.verbose(LogCategory.GDI32, `SetWindowExtEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        writePair(mem, args[3], m.wndExtX, m.wndExtY);
        // Same shape as SetViewportExtEx: a fixed map mode ignores the request and still
        // succeeds; only a zero extent fails.
        if (!x || !y) return 0;
        if (m.mapMode === MM_ISOTROPIC || m.mapMode === MM_ANISOTROPIC) {
            m.wndExtX = x; m.wndExtY = y;
        }
        return 1;
    };

    exports['GetViewportOrgEx'] = (ctx, mem, args): number => {
        const m = readMapping(args[0]);
        writePair(mem, args[1], m.vportOrgX, m.vportOrgY);
        return 1;
    };

    exports['GetWindowOrgEx'] = (ctx, mem, args): number => {
        const m = readMapping(args[0]);
        writePair(mem, args[1], m.wndOrgX, m.wndOrgY);
        return 1;
    };

    exports['GetViewportExtEx'] = (ctx, mem, args): number => {
        const m = readMapping(args[0]);
        writePair(mem, args[1], m.vportExtX, m.vportExtY);
        return 1;
    };

    exports['GetWindowExtEx'] = (ctx, mem, args): number => {
        const m = readMapping(args[0]);
        writePair(mem, args[1], m.wndExtX, m.wndExtY);
        return 1;
    };

    exports['OffsetViewportOrgEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const m = mappingFor(hdc);
        Logger.verbose(LogCategory.GDI32, `OffsetViewportOrgEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        writePair(mem, args[3], m.vportOrgX, m.vportOrgY);
        m.vportOrgX += x; m.vportOrgY += y;
        return 1;
    };

    exports['ScaleViewportExtEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const xNum = args[1] | 0;
        const xDenom = args[2] | 0;
        const yNum = args[3] | 0;
        const yDenom = args[4] | 0;
        const lpsz = args[5];
        Logger.verbose(LogCategory.GDI32, `ScaleViewportExtEx(hdc=0x${hdc.toString(16)}, ${xNum}/${xDenom}, ${yNum}/${yDenom})`);
        if (lpsz) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lpsz, 640, true);     // old cx
            view.setInt32(lpsz + 4, 480, true); // old cy
        }
        return 1; // success
    };

    exports['ScaleWindowExtEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const xNum = args[1] | 0;
        const xDenom = args[2] | 0;
        const yNum = args[3] | 0;
        const yDenom = args[4] | 0;
        const lpsz = args[5];
        Logger.verbose(LogCategory.GDI32, `ScaleWindowExtEx(hdc=0x${hdc.toString(16)}, ${xNum}/${xDenom}, ${yNum}/${yDenom})`);
        if (lpsz) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lpsz, 640, true);     // old cx
            view.setInt32(lpsz + 4, 480, true); // old cy
        }
        return 1; // success
    };

    // DPtoLP / LPtoDP are the coordinate mapping's whole reason to exist: device pixels
    // ↔ the logical space the window/viewport origins and extents define (Wine
    // win32u/mapping.c:185-203 and :219-248). Under the default MM_TEXT with unit
    // extents and both origins at 0 both are the identity — which is why answering
    // "identity" unconditionally looked right until a DC actually had a mapping.
    exports['DPtoLP'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const m = readMapping(hdc);
        Logger.verbose(LogCategory.GDI32, `DPtoLP(hdc=0x${hdc.toString(16)}, count=${args[2] | 0})`);
        return transformPoints(mem, args[1], args[2] | 0, (x, y) => dpToLp(m, x, y)) ? 1 : 0;
    };

    exports['LPtoDP'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const m = readMapping(hdc);
        Logger.verbose(LogCategory.GDI32, `LPtoDP(hdc=0x${hdc.toString(16)}, count=${args[2] | 0})`);
        return transformPoints(mem, args[1], args[2] | 0, (x, y) => lpToDp(m, x, y)) ? 1 : 0;
    };

    // Clipping and visibility — all of these read or write the one clip region the DC
    // carries (GDIContext / dc-clip.ts), which is what every drawing primitive obeys.
    exports['GetClipBox'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lprect = args[1];
        // A RECT the guest cannot legally be given 16 writable bytes at is ERROR, not a
        // blind store: the region map is the only thing that knows the target is not
        // THUNK_CODE or a red zone, and an identity map faults on neither.
        if (!lprect || !isValidAddress(mem, lprect, RECT_SIZE, "rw")) return ERROR_REGION;
        const box = System.getInstance().gdiContext.getClipBox(hdc);
        Logger.verbose(LogCategory.GDI32,
            `GetClipBox(hdc=0x${hdc.toString(16)}) -> ${box.left},${box.top},${box.right},${box.bottom}`);
        {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lprect, box.left, true);
            view.setInt32(lprect + 4, box.top, true);
            view.setInt32(lprect + 8, box.right, true);
            view.setInt32(lprect + 12, box.bottom, true);
        }
        return box.type;
    };

    exports['IntersectClipRect'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const left = args[1] | 0;
        const top = args[2] | 0;
        const right = args[3] | 0;
        const bottom = args[4] | 0;
        Logger.verbose(LogCategory.GDI32, `IntersectClipRect(hdc=0x${hdc.toString(16)}, ${left},${top},${right},${bottom})`);
        return System.getInstance().gdiContext.intersectClipRect(hdc, left, top, right, bottom);
    };

    exports['ExcludeClipRect'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const left = args[1] | 0;
        const top = args[2] | 0;
        const right = args[3] | 0;
        const bottom = args[4] | 0;
        Logger.verbose(LogCategory.GDI32, `ExcludeClipRect(hdc=0x${hdc.toString(16)}, ${left},${top},${right},${bottom})`);
        return System.getInstance().gdiContext.excludeClipRect(hdc, left, top, right, bottom);
    };

    // SelectClipRgn(hdc, NULL) removes the clip; otherwise the DC takes a COPY of the
    // region, so later edits to the HRGN do not reach it.
    const selectClipRgn = (hdc: number, hRgn: number): number => {
        const gdi = System.getInstance().gdiContext;
        if (!hRgn) return gdi.setClipRegion(hdc, null);
        const r = _regionStore.get(hRgn);
        if (!r) return 0; // ERROR
        return gdi.setClipRegion(hdc, cloneClipRegion(r));
    };

    exports['SelectClipRgn'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hRgn = args[1];
        Logger.verbose(LogCategory.GDI32, `SelectClipRgn(hdc=0x${hdc.toString(16)}, hRgn=0x${hRgn.toString(16)})`);
        return selectClipRgn(hdc, hRgn);
    };

    exports['ExtSelectClipRgn'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hRgn = args[1];
        const mode = args[2] | 0;
        const gdi = System.getInstance().gdiContext;
        const r = hRgn ? _regionStore.get(hRgn) : undefined;
        Logger.verbose(LogCategory.GDI32,
            `ExtSelectClipRgn(hdc=0x${hdc.toString(16)}, hRgn=0x${hRgn.toString(16)}, mode=${mode})`);
        // Only RGN_COPY accepts a NULL region (the documented "remove the clip" spelling).
        if (mode === RGN_COPY) return selectClipRgn(hdc, hRgn);
        if (!r) return ERROR_REGION;
        return gdi.combineClipWithRegion(hdc, r, mode);
    };

    exports['PtVisible'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const visible = clipIntersectsRect(System.getInstance().gdiContext.getClip(hdc), x, y, 1, 1);
        Logger.verbose(LogCategory.GDI32, `PtVisible(hdc=0x${hdc.toString(16)}, ${x}, ${y}) -> ${visible}`);
        return visible ? 1 : 0;
    };

    exports['RectVisible'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lprect = args[1];
        // Unreadable RECT -> FALSE. A bare DataView over an unvalidated pointer throws
        // out of the thunk once the RECT straddles the end of guest memory.
        if (!lprect || !isValidAddress(mem, lprect, RECT_SIZE, "r")) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const l = view.getInt32(lprect, true), t = view.getInt32(lprect + 4, true);
        const r = view.getInt32(lprect + 8, true), b = view.getInt32(lprect + 12, true);
        const visible = clipIntersectsRect(System.getInstance().gdiContext.getClip(hdc), l, t, r - l, b - t);
        Logger.verbose(LogCategory.GDI32, `RectVisible(hdc=0x${hdc.toString(16)}, ${l},${t},${r},${b}) -> ${visible}`);
        return visible ? 1 : 0;
    };

    // Printing support
    exports['StartDocA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lpdi = args[1];
        Logger.verbose(LogCategory.GDI32, `StartDocA(hdc=0x${hdc.toString(16)})`);
        // Stub: return positive job ID
        return 1;
    };

    exports['EndDoc'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `EndDoc(hdc=0x${hdc.toString(16)})`);
        return 1; // success
    };

    exports['AbortDoc'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `AbortDoc(hdc=0x${hdc.toString(16)})`);
        return 1; // success
    };

    exports['StartPage'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `StartPage(hdc=0x${hdc.toString(16)})`);
        return 1; // success
    };

    exports['EndPage'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `EndPage(hdc=0x${hdc.toString(16)})`);
        return 1; // success
    };

    exports['SetAbortProc'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const proc = args[1];
        Logger.verbose(LogCategory.GDI32, `SetAbortProc(hdc=0x${hdc.toString(16)}, proc=0x${proc.toString(16)})`);
        return 1; // success
    };

    exports['Escape'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const iEscape = args[1];
        const cjIn = args[2];
        const pvIn = args[3];
        const pvOut = args[4];
        Logger.verbose(LogCategory.GDI32, `Escape(hdc=0x${hdc.toString(16)}, escape=${iEscape})`);
        // Stub: return 0 (not supported for most escape codes)
        return 0;
    };

    exports['GdiFlush'] = (ctx, mem, args): number => {
        // Flush GDI batched operations - always succeeds in our emulator
        Logger.verbose(LogCategory.GDI32, 'GdiFlush()');
        return 1; // TRUE
    };

    exports['RectInRegion'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const lprc = args[1];
        const r = _regionStore.get(hRgn);
        if (!r || !lprc || !isValidAddress(mem, lprc, RECT_SIZE, "r")) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const l = view.getInt32(lprc, true), t = view.getInt32(lprc + 4, true);
        const rt = view.getInt32(lprc + 8, true), b = view.getInt32(lprc + 12, true);
        const hit = clipIntersectsRect(r, l, t, rt - l, b - t);
        Logger.verbose(LogCategory.GDI32,
            `RectInRegion(hRgn=0x${hRgn.toString(16)}, ${l},${t},${rt},${b}) -> ${hit}`);
        return hit ? 1 : 0;
    };

    exports['PtInRegion'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const r = _regionStore.get(hRgn);
        if (!r) return 0;
        const hit = clipIntersectsRect(r, x, y, 1, 1);
        Logger.verbose(LogCategory.GDI32, `PtInRegion(hRgn=0x${hRgn.toString(16)}, ${x}, ${y}) -> ${hit}`);
        return hit ? 1 : 0;
    };

    exports['OffsetClipRgn'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        Logger.verbose(LogCategory.GDI32, `OffsetClipRgn(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        return System.getInstance().gdiContext.offsetClipRgn(hdc, x, y);
    };

    exports['OffsetWindowOrgEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const m = mappingFor(hdc);
        Logger.verbose(LogCategory.GDI32, `OffsetWindowOrgEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        writePair(mem, args[3], m.wndOrgX, m.wndOrgY);
        m.wndOrgX += x; m.wndOrgY += y;
        return 1;
    };

    exports['SetRectRgn'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const left  = args[1] | 0;
        const top   = args[2] | 0;
        const right = args[3] | 0;
        const bottom = args[4] | 0;
        Logger.verbose(
            LogCategory.GDI32,
            `SetRectRgn(hRgn=0x${hRgn.toString(16)}, ${left},${top},${right},${bottom})`,
        );
        // Update the stored region if we own this handle, otherwise accept silently.
        if (_regionStore.has(hRgn)) {
            _regionStore.set(hRgn, clipRegionFromRect(left, top, right, bottom));
        }
        return 1;
    };

    // -----------------------------------------------------------------------
    // Region creation / combination / query
    // -----------------------------------------------------------------------

    // HRGN CreateRectRgn(int x1, int y1, int x2, int y2)
    exports['CreateRectRgn'] = (ctx, mem, args): number => {
        const left   = args[0] | 0;
        const top    = args[1] | 0;
        const right  = args[2] | 0;
        const bottom = args[3] | 0;
        const h = _rgnAlloc(clipRegionFromRect(left, top, right, bottom));
        Logger.verbose(LogCategory.GDI32,
            `CreateRectRgn(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreateRectRgnIndirect(const RECT *lprect)
    exports['CreateRectRgnIndirect'] = (ctx, mem, args): number => {
        const lprect = args[0];
        if (!lprect || !isValidAddress(mem, lprect, RECT_SIZE, "r")) return 0;
        const view   = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left   = view.getInt32(lprect,      true);
        const top    = view.getInt32(lprect +  4, true);
        const right  = view.getInt32(lprect +  8, true);
        const bottom = view.getInt32(lprect + 12, true);
        const h = _rgnAlloc(clipRegionFromRect(left, top, right, bottom));
        Logger.verbose(LogCategory.GDI32,
            `CreateRectRgnIndirect(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)
    exports['CreateRoundRectRgn'] = (ctx, mem, args): number => {
        const left   = args[0] | 0;
        const top    = args[1] | 0;
        const right  = args[2] | 0;
        const bottom = args[3] | 0;
        const h = _rgnAlloc(clipRegionFromRoundRect(left, top, right, bottom, args[4] | 0, args[5] | 0));
        Logger.verbose(LogCategory.GDI32,
            `CreateRoundRectRgn(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreateEllipticRgn(int x1, int y1, int x2, int y2)
    exports['CreateEllipticRgn'] = (ctx, mem, args): number => {
        const left   = args[0] | 0;
        const top    = args[1] | 0;
        const right  = args[2] | 0;
        const bottom = args[3] | 0;
        const h = _rgnAlloc(clipRegionFromEllipse(left, top, right, bottom));
        Logger.verbose(LogCategory.GDI32,
            `CreateEllipticRgn(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreateEllipticRgnIndirect(const RECT *lprect)
    exports['CreateEllipticRgnIndirect'] = (ctx, mem, args): number => {
        const lprect = args[0];
        if (!lprect || !isValidAddress(mem, lprect, RECT_SIZE, "r")) return 0;
        const view   = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left   = view.getInt32(lprect,      true);
        const top    = view.getInt32(lprect +  4, true);
        const right  = view.getInt32(lprect +  8, true);
        const bottom = view.getInt32(lprect + 12, true);
        const h = _rgnAlloc(clipRegionFromEllipse(left, top, right, bottom));
        Logger.verbose(LogCategory.GDI32,
            `CreateEllipticRgnIndirect(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreatePolygonRgn(const POINT *pptl, int cPoint, int iMode)
    // iMode: ALTERNATE = 1, WINDING = 2.
    exports['CreatePolygonRgn'] = (ctx, mem, args): number => {
        const pptl   = args[0];
        const cPoint = args[1] | 0;
        const iMode  = args[2] | 0;
        if (!pptl || cPoint <= 0 || !isValidAddress(mem, pptl, cPoint * 8, "r")) {
            return _rgnAlloc(clipRegionFromRect(0, 0, 0, 0));
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const pts: number[] = [];
        for (let i = 0; i < cPoint; i++) {
            pts.push(view.getInt32(pptl + i * 8, true), view.getInt32(pptl + i * 8 + 4, true));
        }
        const region = clipRegionFromPolygon(pts, iMode);
        const h = _rgnAlloc(region);
        Logger.verbose(LogCategory.GDI32,
            `CreatePolygonRgn(${cPoint} pts, mode=${iMode}) -> 0x${h.toString(16)}`);
        return h;
    };

    // int CombineRgn(HRGN hrgnDst, HRGN hrgnSrc1, HRGN hrgnSrc2, int fnCombineMode)
    exports['CombineRgn'] = (ctx, mem, args): number => {
        const hrgnDst  = args[0];
        const hrgnSrc1 = args[1];
        const hrgnSrc2 = args[2];
        const fnMode   = args[3] | 0;

        const empty = clipRegionFromRect(0, 0, 0, 0);
        const src1 = _regionStore.get(hrgnSrc1) ?? empty;
        const src2 = _regionStore.get(hrgnSrc2) ?? empty;
        if (fnMode < RGN_AND || fnMode > RGN_COPY) return ERROR_REGION;
        const dst = combineClipRegions(src1, src2, fnMode);

        // Some callers pass an hRgn created via CreateRectRgn(0,0,0,0); register it lazily.
        _regionStore.set(hrgnDst, dst);

        const result = clipRegionType(dst);
        Logger.verbose(LogCategory.GDI32,
            `CombineRgn(dst=0x${hrgnDst.toString(16)}, src1=0x${hrgnSrc1.toString(16)}, src2=0x${hrgnSrc2.toString(16)}, mode=${fnMode}) -> ${result}`);
        return result;
    };

    // int OffsetRgn(HRGN hrgn, int x, int y)
    exports['OffsetRgn'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const x    = args[1] | 0;
        const y    = args[2] | 0;
        const r = _regionStore.get(hRgn);
        if (!r) {
            Logger.verbose(LogCategory.GDI32, `OffsetRgn(0x${hRgn.toString(16)}, ${x}, ${y}) — unknown handle`);
            return ERROR_REGION;
        }
        const moved = offsetClipRegion(r, x, y);
        _regionStore.set(hRgn, moved);
        const result = clipRegionType(moved);
        Logger.verbose(LogCategory.GDI32,
            `OffsetRgn(0x${hRgn.toString(16)}, ${x}, ${y}) -> ${result} [${moved.x1},${moved.y1},${moved.x2},${moved.y2}]`);
        return result;
    };

    // int GetRgnBox(HRGN hrgn, LPRECT lprc)
    // Returns the bounding rectangle of a region into *lprc.
    // Return value: NULLREGION (1), SIMPLEREGION (2), COMPLEXREGION (3), or 0 on error.
    exports['GetRgnBox'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const lprc = args[1];

        if (!hRgn || !lprc || !isValidAddress(mem, lprc, RECT_SIZE, "rw")) {
            Logger.verbose(LogCategory.GDI32,
                `GetRgnBox(0x${hRgn.toString(16)}, 0x${lprc.toString(16)}) -> ERROR (null/unwritable)`);
            return ERROR_REGION;
        }

        const r = _regionStore.get(hRgn);
        if (!r) {
            // Unknown handle — write a zeroed RECT and return NULLREGION.
            Logger.verbose(LogCategory.GDI32,
                `GetRgnBox(0x${hRgn.toString(16)}) — unknown handle, returning NULLREGION`);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lprc,      0, true);
            view.setInt32(lprc +  4, 0, true);
            view.setInt32(lprc +  8, 0, true);
            view.setInt32(lprc + 12, 0, true);
            return NULLREGION;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt32(lprc,      r.x1, true);
        view.setInt32(lprc +  4, r.y1, true);
        view.setInt32(lprc +  8, r.x2, true);
        view.setInt32(lprc + 12, r.y2, true);

        const result = clipRegionType(r);
        Logger.verbose(LogCategory.GDI32,
            `GetRgnBox(0x${hRgn.toString(16)}) -> ${result} [${r.x1},${r.y1},${r.x2},${r.y2}]`);
        return result;
    };

    exports['SetColorAdjustment'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `SetColorAdjustment(hdc=0x${hdc.toString(16)}) — stub`);
        return 1;
    };

    exports['SetMapperFlags'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const flags = args[1] >>> 0;
        Logger.verbose(LogCategory.GDI32, `SetMapperFlags(hdc=0x${hdc.toString(16)}, flags=0x${flags.toString(16)}) — stub`);
        return 0; // previous flags
    };
}
