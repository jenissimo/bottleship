/**
 * The DC clip region — algebra, and the invariant that every render target a primitive
 * touches is bracketed by it.
 *
 * The bug this pins: a clip applied to the DC's own canvas at one call site while the
 * SAME primitive mirrored itself into the selected bitmap's canvas through a second
 * context that never saw it. So the interesting assertion is not "the region math is
 * right" (below, against a per-pixel oracle) but "fillRect clipped BOTH contexts" —
 * which is what a recording stub context can see and a screenshot cannot.
 */

import { expect, test } from "bun:test";
import {
    clipRegionFromRect,
    clipRegionFromEllipse,
    clipRegionFromRoundRect,
    clipRegionFromPolygon,
    combineClipRegions,
    intersectClipRegionRect,
    excludeClipRegionRect,
    offsetClipRegion,
    clipIntersectsRect,
    clampRectToClip,
    forEachClipRect,
    clipRegionType,
    applyClipToContext,
    makeClipRegion,
    NULLREGION,
    SIMPLEREGION,
    COMPLEXREGION,
    RGN_AND,
    RGN_OR,
    RGN_XOR,
    RGN_DIFF,
    type DcClipRegion,
} from "../../src/worker/modules/gdi32/dc-clip";

/** Per-pixel oracle: is (x,y) inside the region's rect list? */
function covers(region: DcClipRegion, x: number, y: number): boolean {
    for (let i = 0; i < region.rects.length; i += 4) {
        if (x >= region.rects[i] && x < region.rects[i + 2]
            && y >= region.rects[i + 1] && y < region.rects[i + 3]) return true;
    }
    return false;
}

const W = 24, H = 16;
function mask(region: DcClipRegion): string {
    let s = "";
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) s += covers(region, x, y) ? "1" : "0";
    return s;
}
function maskOf(fn: (x: number, y: number) => boolean): string {
    let s = "";
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) s += fn(x, y) ? "1" : "0";
    return s;
}

test("IntersectClipRect is a set intersection", () => {
    const base = clipRegionFromRect(2, 3, 20, 12);
    const got = intersectClipRegionRect(base, 5, 1, 30, 9);
    expect(mask(got)).toBe(maskOf((x, y) => covers(base, x, y) && x >= 5 && x < 30 && y >= 1 && y < 9));
});

test("ExcludeClipRect is a set difference, and the rect list stays disjoint", () => {
    const base = clipRegionFromRect(0, 0, W, H);
    const got = excludeClipRegionRect(base, 6, 4, 15, 11, W, H);
    expect(mask(got)).toBe(maskOf((x, y) =>
        !(x >= 6 && x < 15 && y >= 4 && y < 11)));
    // Disjointness matters: overlapping rects would double-count in any area/CombineRgn
    // use and would make the canvas path fill a seam twice with a translucent brush.
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let hits = 0;
            for (let i = 0; i < got.rects.length; i += 4) {
                if (x >= got.rects[i] && x < got.rects[i + 2]
                    && y >= got.rects[i + 1] && y < got.rects[i + 3]) hits++;
            }
            expect(hits).toBeLessThan(2);
        }
    }
});

test("Exclude then Intersect compose, in that order, like GDI", () => {
    const excluded = excludeClipRegionRect(clipRegionFromRect(0, 0, W, H), 4, 4, 12, 12, W, H);
    const both = intersectClipRegionRect(excluded, 2, 2, 14, 14);
    expect(mask(both)).toBe(maskOf((x, y) =>
        x >= 2 && x < 14 && y >= 2 && y < 14 && !(x >= 4 && x < 12 && y >= 4 && y < 12)));
});

test("OffsetClipRgn translates the whole region", () => {
    const base = excludeClipRegionRect(clipRegionFromRect(0, 0, W, H), 4, 4, 12, 12, W, H);
    const moved = offsetClipRegion(base, 3, -2);
    expect(mask(moved)).toBe(maskOf((x, y) => covers(base, x - 3, y + 2)));
});

test("region type follows GDI's NULL/SIMPLE/COMPLEX", () => {
    expect(clipRegionType(null)).toBe(SIMPLEREGION);            // unbounded DC
    expect(clipRegionType(clipRegionFromRect(0, 0, 0, 0))).toBe(NULLREGION); // empty
    expect(clipRegionType(clipRegionFromRect(1, 1, 5, 5))).toBe(SIMPLEREGION);
    expect(clipRegionType(excludeClipRegionRect(clipRegionFromRect(0, 0, W, H), 4, 4, 12, 12, W, H)))
        .toBe(COMPLEXREGION);
});

test("an empty clip rejects everything; an absent clip accepts everything", () => {
    const empty = makeClipRegion([]);
    expect(clipIntersectsRect(empty, 0, 0, W, H)).toBe(false);
    expect(clampRectToClip(empty, 0, 0, W, H)).toBeNull();
    expect(clipIntersectsRect(null, -50, -50, 1, 1)).toBe(true);
    expect(clampRectToClip(null, 3, 4, 5, 6)).toEqual({ x: 3, y: 4, w: 5, h: 6 });
});

test("forEachClipRect yields the REGION, where clampRectToClip yields its box", () => {
    // The putImageData paths write what this hands them, so a bounding box here is a
    // child window painted over: the hole below is exactly an ExcludeClipRect(childRect).
    const region = excludeClipRegionRect(clipRegionFromRect(0, 0, W, H), 6, 4, 15, 11, W, H);
    const painted = new Set<string>();
    let parts = 0;
    expect(forEachClipRect(region, 0, 0, W, H, (x, y, w, h) => {
        parts++;
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
            expect(painted.has(`${xx},${yy}`)).toBe(false); // parts are disjoint
            painted.add(`${xx},${yy}`);
        }
    })).toBe(true);
    expect(parts).toBeGreaterThan(1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        expect(painted.has(`${x},${y}`), `${x},${y}`).toBe(covers(region, x, y));
    }
    // The box would have admitted the hole; the region does not.
    expect(clampRectToClip(region, 6, 4, 9, 7)).toEqual({ x: 6, y: 4, w: 9, h: 7 });
    expect(forEachClipRect(region, 6, 4, 9, 7, () => { })).toBe(false);

    // An unbounded clip is one part, unchanged — the common case stays one putImageData.
    const seen: number[] = [];
    expect(forEachClipRect(null, 3, 4, 5, 6, (x, y, w, h) => seen.push(x, y, w, h))).toBe(true);
    expect(seen).toEqual([3, 4, 5, 6]);
    expect(forEachClipRect(makeClipRegion([]), 0, 0, W, H, () => { })).toBe(false);
    expect(forEachClipRect(null, 0, 0, 0, 5, () => { })).toBe(false);
});

test("clipIntersectsRect agrees with the per-pixel oracle (RectVisible)", () => {
    const region = excludeClipRegionRect(clipRegionFromRect(0, 0, W, H), 4, 4, 12, 12, W, H);
    for (let y = 0; y < H - 3; y++) {
        for (let x = 0; x < W - 3; x++) {
            let any = false;
            for (let dy = 0; dy < 3 && !any; dy++) {
                for (let dx = 0; dx < 3; dx++) if (covers(region, x + dx, y + dy)) { any = true; break; }
            }
            expect(clipIntersectsRect(region, x, y, 3, 3)).toBe(any);
        }
    }
});

// --- The mirror invariant -------------------------------------------------------------

interface Op { op: string; args: number[] }

/** Records the calls a primitive makes, enough to see save/clip/restore bracketing. */
function stubCtx(canvas: any) {
    const ops: Op[] = [];
    let fillStyle = "";
    return {
        ops,
        canvas,
        get fillStyle() { return fillStyle; },
        set fillStyle(v: string) { fillStyle = v; },
        save() { ops.push({ op: "save", args: [] }); },
        restore() { ops.push({ op: "restore", args: [] }); },
        beginPath() { ops.push({ op: "beginPath", args: [] }); },
        rect(x: number, y: number, w: number, h: number) { ops.push({ op: "rect", args: [x, y, w, h] }); },
        clip() { ops.push({ op: "clip", args: [] }); },
        fillRect(x: number, y: number, w: number, h: number) { ops.push({ op: "fillRect", args: [x, y, w, h] }); },
        createPattern() { return null; },
    } as any;
}

test("applyClipToContext brackets the target and emits every rect of the region", () => {
    const region = excludeClipRegionRect(clipRegionFromRect(0, 0, W, H), 4, 4, 12, 12, W, H);
    const ctx = stubCtx({});
    expect(applyClipToContext(region, ctx)).toBe(true);
    const names = ctx.ops.map((o: Op) => o.op);
    expect(names[0]).toBe("save");
    expect(names[1]).toBe("beginPath");
    expect(names[names.length - 1]).toBe("clip");
    expect(names.filter((n: string) => n === "rect").length).toBe(region.rects.length / 4);
    // An unbounded DC must not touch canvas state at all — that is what keeps the
    // common case free of a save/restore per primitive.
    const plain = stubCtx({});
    expect(applyClipToContext(null, plain)).toBe(false);
    expect(plain.ops.length).toBe(0);
});

test("fillRect clips the DC canvas AND the selected bitmap's canvas", async () => {
    const { GDIContext } = await import("../../src/worker/modules/gdi32/context");
    const gdi = new GDIContext();

    const bitmapCanvas: any = { width: W, height: H };
    const bitmapCtx = stubCtx(bitmapCanvas);
    bitmapCanvas.getContext = () => bitmapCtx;
    const dcCanvas: any = { width: W, height: H, __bitmapCanvas: bitmapCanvas };
    const dcCtx = stubCtx(dcCanvas);

    const hdc = 0x1234;
    gdi.contexts.set(hdc, dcCtx);
    gdi.hdcStates.set(hdc, {
        brushColor: "#ff0000", textColor: "#000", textColorValue: 0, bkMode: 1, bkColor: "#fff",
        font: "16px sans-serif", fontSize: 16, fontQuality: 0, textEscapement: 0, textAlign: 0,
        appliedFont: "", appliedFillStyle: "", hBrush: 0, hPen: 0, hFont: 0, hBitmap: 0,
        imageDataDirty: true, dirty: false, dirtyRect: null,
    } as any);

    // Unbounded: neither target is bracketed.
    expect(gdi.fillRect(hdc, 0, 0, 4, 4)).toBe(true);
    expect(dcCtx.ops.some((o: Op) => o.op === "clip")).toBe(false);
    expect(bitmapCtx.ops.some((o: Op) => o.op === "clip")).toBe(false);

    // The paint case: clip to the update strip, fill far outside it.
    dcCtx.ops.length = 0; bitmapCtx.ops.length = 0;
    gdi.intersectClipRect(hdc, 0, 0, 6, H);
    gdi.fillRect(hdc, 20, 0, 24, 8);

    for (const [name, ctx] of [["dc", dcCtx], ["mirror", bitmapCtx]] as const) {
        const names = ctx.ops.map((o: Op) => o.op);
        expect(names, name).toContain("clip");
        const fill = names.indexOf("fillRect");
        expect(names.lastIndexOf("clip"), name).toBeLessThan(fill);
        expect(names.indexOf("restore"), name).toBeGreaterThan(fill);
        const clipRect = ctx.ops.find((o: Op) => o.op === "rect");
        expect(clipRect!.args, name).toEqual([0, 0, 6, H]);
    }
});

test("SaveDC/RestoreDC stack the clip, by absolute and by relative level", async () => {
    const { GDIContext } = await import("../../src/worker/modules/gdi32/context");
    const gdi = new GDIContext();
    const hdc = 0x2345;
    gdi.contexts.set(hdc, stubCtx({ width: W, height: H }));
    gdi.hdcStates.set(hdc, { hBitmap: 0 } as any);

    expect(gdi.getClip(hdc)).toBeNull();
    expect(gdi.saveDcState(hdc)).toBe(1);
    gdi.intersectClipRect(hdc, 0, 0, 8, 8);
    expect(gdi.saveDcState(hdc)).toBe(2);
    gdi.intersectClipRect(hdc, 0, 0, 4, 4);
    expect(gdi.getClipBox(hdc).right).toBe(4);

    expect(gdi.restoreDcState(hdc, -1)).toBe(true);   // back to the 8x8 clip
    expect(gdi.getClipBox(hdc).right).toBe(8);
    expect(gdi.restoreDcState(hdc, 1)).toBe(true);    // back to unbounded
    expect(gdi.getClip(hdc)).toBeNull();
    expect(gdi.restoreDcState(hdc, -1)).toBe(false);  // nothing left to pop
});

// --- Region algebra -------------------------------------------------------------------
//
// A region is a rect LIST, so every one of these asserts the SHAPE (per-pixel, against
// the oracle) rather than a bounding box: a box-only region is exactly the bug, and a
// box-only assertion would pass over it.

const OPS: [number, string, (a: boolean, b: boolean) => boolean][] = [
    [RGN_AND, "AND", (a, b) => a && b],
    [RGN_OR, "OR", (a, b) => a || b],
    [RGN_XOR, "XOR", (a, b) => a !== b],
    [RGN_DIFF, "DIFF", (a, b) => a && !b],
];

test("CombineRgn's four set operations agree with the per-pixel oracle", () => {
    // Left operand is deliberately COMPLEX (a rect with a hole punched in it) — the box
    // approximation and the real answer only differ where an operand is not a rectangle.
    const a = excludeClipRegionRect(clipRegionFromRect(2, 2, 20, 14), 6, 5, 14, 10, W, H);
    const b = clipRegionFromRect(10, 0, 24, 8);
    for (const [op, name, fn] of OPS) {
        const got = combineClipRegions(a, b, op);
        expect(mask(got), name).toBe(maskOf((x, y) => fn(covers(a, x, y), covers(b, x, y))));
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let hits = 0;
                for (let i = 0; i < got.rects.length; i += 4) {
                    if (x >= got.rects[i] && x < got.rects[i + 2]
                        && y >= got.rects[i + 1] && y < got.rects[i + 3]) hits++;
                }
                expect(hits, `${name} @${x},${y}`).toBeLessThan(2);
            }
        }
    }
});

test("a combined region is canonical, so a chain of combines cannot fragment", () => {
    const r = clipRegionFromRect(3, 4, 12, 10);
    // Idempotent operations collapse back to ONE rect rather than accumulating bands.
    expect(combineClipRegions(r, r, RGN_OR).rects).toEqual([3, 4, 12, 10]);
    expect(combineClipRegions(r, r, RGN_AND).rects).toEqual([3, 4, 12, 10]);
    expect(combineClipRegions(r, r, RGN_XOR).rects).toEqual([]);
    // Adjacent bands with the same spans coalesce; adjacent columns do too.
    const stacked = combineClipRegions(
        clipRegionFromRect(3, 4, 12, 7), clipRegionFromRect(3, 7, 12, 10), RGN_OR);
    expect(stacked.rects).toEqual([3, 4, 12, 10]);
    const sideBySide = combineClipRegions(
        clipRegionFromRect(3, 4, 7, 10), clipRegionFromRect(7, 4, 12, 10), RGN_OR);
    expect(sideBySide.rects).toEqual([3, 4, 12, 10]);
    // Repeated OR of an ellipse with itself must not grow the rect list.
    const e = clipRegionFromEllipse(0, 0, 21, 15);
    let acc = e;
    for (let i = 0; i < 5; i++) acc = combineClipRegions(acc, e, RGN_OR);
    expect(acc.rects.length).toBe(e.rects.length);
});

test("an elliptic region is its scanline decomposition, not its bounding box", () => {
    const e = clipRegionFromEllipse(0, 0, 20, 16);
    expect(e.x1).toBe(0); expect(e.y1).toBe(0);
    expect(e.x2).toBe(20); expect(e.y2).toBe(16);
    expect(clipRegionType(e)).toBe(COMPLEXREGION);
    expect(covers(e, 10, 8)).toBe(true);     // centre
    expect(covers(e, 0, 0)).toBe(false);     // corner of the box, outside the ellipse
    expect(covers(e, 19, 15)).toBe(false);
    expect(covers(e, 10, 0)).toBe(true);     // top edge midpoint
    expect(covers(e, 0, 8)).toBe(true);      // left edge midpoint
    // Its area is the ellipse's, not the box's (π/4 ≈ 0.785 of it).
    let area = 0;
    for (let i = 0; i < e.rects.length; i += 4) {
        area += (e.rects[i + 2] - e.rects[i]) * (e.rects[i + 3] - e.rects[i + 1]);
    }
    expect(area / (20 * 16)).toBeCloseTo(Math.PI / 4, 1);
});

test("a round-rect region loses its corners and keeps its edges", () => {
    const rr = clipRegionFromRoundRect(0, 0, 20, 16, 10, 10);
    expect(covers(rr, 0, 0)).toBe(false);    // corner cut away
    expect(covers(rr, 19, 15)).toBe(false);
    expect(covers(rr, 10, 0)).toBe(true);    // straight top edge
    expect(covers(rr, 0, 8)).toBe(true);     // straight left edge
    expect(clipRegionType(rr)).toBe(COMPLEXREGION);
    // A zero corner axis degenerates to the plain rectangle, as GDI's does.
    expect(clipRegionFromRoundRect(0, 0, 20, 16, 0, 0).rects).toEqual([0, 0, 20, 16]);
});

test("a polygon region follows the fill rule into its concavities", () => {
    // L shape: the notch in the top-right must be OUTSIDE the region.
    const l = clipRegionFromPolygon([0, 0, 10, 0, 10, 6, 20, 6, 20, 14, 0, 14], 1);
    expect(covers(l, 5, 2)).toBe(true);
    expect(covers(l, 15, 2)).toBe(false);    // the notch
    expect(covers(l, 15, 10)).toBe(true);
    expect(l.x2).toBe(20);
});

// --- HRGN handles: the round trip through gdi32's own exports ---------------------------

async function regionExports() {
    const { registerPaintingDcStateExports } =
        await import("../../src/worker/modules/gdi32/painting-dc-state");
    const exports: Record<string, any> = {};
    registerPaintingDcStateExports(exports);
    return exports;
}

test("a complex region survives SelectClipRgn as a shape, not as its box", async () => {
    const api = await regionExports();
    const { System } = await import("../../src/worker/core/system");
    const gdi = System.getInstance().gdiContext;
    const mem = new Uint8Array(4096);

    const hdc = 0x3456;
    gdi.contexts.set(hdc, stubCtx({ width: W, height: H }));
    gdi.hdcStates.set(hdc, { hBitmap: 0 } as any);

    const hRgn = api['CreateEllipticRgn'](null, mem, [0, 0, 20, 16]);
    expect(api['SelectClipRgn'](null, mem, [hdc, hRgn])).toBe(COMPLEXREGION);
    const clip = gdi.getClip(hdc)!;
    expect(covers(clip, 10, 8)).toBe(true);
    expect(covers(clip, 0, 0)).toBe(false);   // a box clip would admit this pixel
    // GetRgnBox still reports the bounding box — the box is a QUERY, not the region.
    expect(api['GetRgnBox'](null, mem, [hRgn, 64])).toBe(COMPLEXREGION);
    const view = new DataView(mem.buffer);
    expect([view.getInt32(64, true), view.getInt32(68, true),
        view.getInt32(72, true), view.getInt32(76, true)]).toEqual([0, 0, 20, 16]);
});

test("PtInRegion and RectInRegion answer from the shape", async () => {
    const api = await regionExports();
    const mem = new Uint8Array(4096);
    const hRgn = api['CreateEllipticRgn'](null, mem, [0, 0, 20, 16]);
    expect(api['PtInRegion'](null, mem, [hRgn, 10, 8])).toBe(1);
    expect(api['PtInRegion'](null, mem, [hRgn, 0, 0])).toBe(0);
    const view = new DataView(mem.buffer);
    const writeRect = (at: number, l: number, t: number, r: number, b: number) => {
        view.setInt32(at, l, true); view.setInt32(at + 4, t, true);
        view.setInt32(at + 8, r, true); view.setInt32(at + 12, b, true);
    };
    writeRect(64, 8, 6, 12, 10);
    expect(api['RectInRegion'](null, mem, [hRgn, 64])).toBe(1);
    writeRect(64, -30, -30, -10, -10);       // wholly outside — a stub would say TRUE
    expect(api['RectInRegion'](null, mem, [hRgn, 64])).toBe(0);
});

test("ExtSelectClipRgn RGN_OR widens the clip instead of refusing", async () => {
    const api = await regionExports();
    const { System } = await import("../../src/worker/core/system");
    const gdi = System.getInstance().gdiContext;
    const mem = new Uint8Array(4096);

    const hdc = 0x3457;
    gdi.contexts.set(hdc, stubCtx({ width: W, height: H }));
    gdi.hdcStates.set(hdc, { hBitmap: 0 } as any);

    gdi.intersectClipRect(hdc, 0, 0, 6, H);
    const hRgn = api['CreateRectRgn'](null, mem, [16, 0, 22, H]);
    expect(api['ExtSelectClipRgn'](null, mem, [hdc, hRgn, RGN_OR])).toBe(COMPLEXREGION);
    const clip = gdi.getClip(hdc)!;
    expect(mask(clip)).toBe(maskOf((x, y) => (x < 6 || (x >= 16 && x < 22)) && y < H));

    // RGN_XOR against the same region removes what OR just added.
    expect(api['ExtSelectClipRgn'](null, mem, [hdc, hRgn, RGN_XOR])).toBe(SIMPLEREGION);
    expect(mask(gdi.getClip(hdc)!)).toBe(maskOf((x) => x < 6));
});

test("CombineRgn stores a real region, so a chain of them stays exact", async () => {
    const api = await regionExports();
    const mem = new Uint8Array(4096);
    const big = api['CreateRectRgn'](null, mem, [0, 0, 20, 12]);
    const hole = api['CreateRectRgn'](null, mem, [6, 4, 14, 8]);
    const dst = api['CreateRectRgn'](null, mem, [0, 0, 0, 0]);
    expect(api['CombineRgn'](null, mem, [dst, big, hole, RGN_DIFF])).toBe(COMPLEXREGION);
    expect(api['PtInRegion'](null, mem, [dst, 10, 6])).toBe(0);   // inside the hole
    expect(api['PtInRegion'](null, mem, [dst, 2, 6])).toBe(1);
    // OR the hole back in: the result is the original rectangle again, one rect.
    expect(api['CombineRgn'](null, mem, [dst, dst, hole, RGN_OR])).toBe(SIMPLEREGION);
    expect(api['PtInRegion'](null, mem, [dst, 10, 6])).toBe(1);
    // OffsetRgn moves the shape, not just a box.
    api['OffsetRgn'](null, mem, [dst, 4, 0]);
    expect(api['PtInRegion'](null, mem, [dst, 2, 6])).toBe(0);
    expect(api['PtInRegion'](null, mem, [dst, 22, 6])).toBe(1);
});

test("a static control's image is bracketed by the DC clip, not only by its own rect", async () => {
    // Minimal host stand-ins: the blit builds a source frame off-screen, which in a test
    // only has to accept the pixels — the assertion is about the TARGET's bracketing.
    // They are REMOVED again at the end: a half-built OffscreenCanvas left on the global
    // is inherited by every later test file in the same run, and the next module that
    // asks it for a measuring context (the edit control's word wrap does) gets a context
    // with no measureText and fails for a reason that has nothing to do with itself.
    const hadImageData = "ImageData" in globalThis;
    const hadOffscreen = "OffscreenCanvas" in globalThis;
    (globalThis as any).ImageData ??= class { constructor(public data: any, public width: number, public height: number) { } };
    (globalThis as any).OffscreenCanvas ??= class {
        constructor(public width: number, public height: number) { }
        getContext() { return { putImageData() { } }; }
    };
    try {
    const { blitStaticControlImage, layoutStaticControlImage } =
        await import("../../src/worker/modules/gdi32/bitmap-resolve");
    const { System } = await import("../../src/worker/core/system");
    const gdi = System.getInstance().gdiContext;

    const hdc = 0x5678;
    const ctx = stubCtx({ width: W, height: H });
    ctx.drawImage = (...args: number[]) => ctx.ops.push({ op: "drawImage", args });
    gdi.contexts.set(hdc, ctx);
    gdi.hdcStates.set(hdc, { hBitmap: 0 } as any);
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    const layout = layoutStaticControlImage(0, 0, 4, 4, 4, 4, 0, 0x200);

    // Unbounded DC: one bracket only (the control rect).
    blitStaticControlImage(hdc, ctx as any, pixels, 4, 4, 0, 0, 4, 4, layout);
    expect(ctx.ops.filter((o: Op) => o.op === "clip").length).toBe(1);

    // Partial update: the DC's clip must be on the target before the draw, and the draw
    // must sit inside BOTH brackets.
    ctx.ops.length = 0;
    gdi.intersectClipRect(hdc, 0, 0, 6, H);
    blitStaticControlImage(hdc, ctx as any, pixels, 4, 4, 0, 0, 40, 40, layout);
    const names = ctx.ops.map((o: Op) => o.op);
    const draw = names.indexOf("drawImage");
    expect(draw).toBeGreaterThan(-1);
    expect(names.filter((n: string) => n === "clip").length).toBe(2);
    expect(names.lastIndexOf("clip")).toBeLessThan(draw);
    expect(names.filter((n: string, i: number) => n === "restore" && i > draw).length).toBe(2);
    // The DC's clip rect is the FIRST one pushed — the control rect narrows it, never widens it.
    expect(ctx.ops.find((o: Op) => o.op === "rect")!.args).toEqual([0, 0, 6, H]);
    } finally {
        if (!hadImageData) delete (globalThis as any).ImageData;
        if (!hadOffscreen) delete (globalThis as any).OffscreenCanvas;
    }
});

// --- SaveDC/RestoreDC: the whole attribute set ------------------------------------------

test("RestoreDC puts back the selected objects and the attributes, not just the clip", async () => {
    const { GDIContext } = await import("../../src/worker/modules/gdi32/context");
    const gdi = new GDIContext();
    const hdc = 0x4567;
    const ctx = stubCtx({ width: W, height: H });
    gdi.contexts.set(hdc, ctx);
    gdi.hdcStates.set(hdc, {
        brushColor: "#ffffff", textColor: "#000000", textColorValue: 0, bkMode: 1,
        bkColor: "#ffffff", font: "16px sans-serif", fontSize: 16, fontQuality: 0,
        textEscapement: 0, textAlign: 0, appliedFont: "", appliedFillStyle: "",
        hBrush: 0, hPen: 0, hFont: 0, hBitmap: 0,
        imageDataDirty: true, dirty: false, dirtyRect: null,
    } as any);
    const state = gdi.hdcStates.get(hdc)!;

    const redBrush = gdi.createSolidBrush(0x0000ff);
    const bluePen = gdi.createPen(0, 1, 0xff0000);
    const bigFont = gdi.createFont(24, 0, 400, false, "Arial");
    gdi.selectObject(hdc, redBrush);
    gdi.selectObject(hdc, bluePen);
    gdi.selectObject(hdc, bigFont);
    state.textColor = "#00ff00";
    state.textColorValue = 0x00ff00;
    state.bkMode = 2;
    state.bkColor = "#123456";
    state.textAlign = 6;
    gdi.setCurrentPosition(hdc, 7, 9);
    gdi.intersectClipRect(hdc, 0, 0, 8, 8);

    expect(gdi.saveDcState(hdc)).toBe(1);

    const otherBrush = gdi.createSolidBrush(0x00ff00);
    const otherPen = gdi.createPen(0, 3, 0x00ffff);
    const otherFont = gdi.createFont(10, 0, 400, false, "Courier");
    gdi.selectObject(hdc, otherBrush);
    gdi.selectObject(hdc, otherPen);
    gdi.selectObject(hdc, otherFont);
    state.textColor = "#ff0000";
    state.textColorValue = 0xff0000;
    state.bkMode = 1;
    state.bkColor = "#abcdef";
    state.textAlign = 0;
    gdi.setCurrentPosition(hdc, 1, 2);
    gdi.intersectClipRect(hdc, 0, 0, 2, 2);

    expect(gdi.restoreDcState(hdc, -1)).toBe(true);

    expect(state.hBrush).toBe(redBrush);
    expect(state.brushColor).toBe(gdi.objects.get(redBrush)!.data);
    expect(state.hPen).toBe(bluePen);
    expect(state.hFont).toBe(bigFont);
    expect(state.fontSize).toBe(gdi.objects.get(bigFont)!.fontSize);
    expect(state.font).toBe(gdi.objects.get(bigFont)!.data);
    expect(state.textColor).toBe("#00ff00");
    expect(state.textColorValue).toBe(0x00ff00);
    expect(state.bkMode).toBe(2);
    expect(state.bkColor).toBe("#123456");
    expect(state.textAlign).toBe(6);
    expect(gdi.getCurrentPosition(hdc)).toEqual({ x: 7, y: 9 });
    expect(gdi.getClipBox(hdc).right).toBe(8);
    // Re-selected, not merely re-assigned: the pen's colour is back on the canvas, and
    // the font is marked un-applied so the next primitive sets it.
    expect(ctx.strokeStyle).toBe(gdi.objects.get(bluePen)!.data);
    expect(state.appliedFont).toBe("");
});
