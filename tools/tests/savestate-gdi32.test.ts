import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { captureUserImage, restoreUserImage, type UserImageRecord } from "../../src/worker/modules/gdi32/savestate";
import { captureDcRegionState, restoreDcRegionState } from "../../src/worker/modules/gdi32/painting-dc-state";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return { json: e.json, blobs: e.blobs.map(b => [...b]) };
};

class FakeImageData {
    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
}

class FakeContext {
    fillStyle = "#000";
    strokeStyle = "#000";
    textBaseline = "alphabetic";
    font = "10px sans-serif";
    pixels: Uint8ClampedArray;
    constructor(readonly canvas: FakeCanvas) { this.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4); }
    resized() { this.pixels = new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4); }
    getImageData(x: number, y: number, w: number, h: number) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
            const from = ((y + row) * this.canvas.width + x) * 4;
            out.set(this.pixels.subarray(from, from + w * 4), row * w * 4);
        }
        return new FakeImageData(out, w, h);
    }
    putImageData(img: FakeImageData, x: number, y: number) {
        for (let row = 0; row < img.height; row++) {
            const to = ((y + row) * this.canvas.width + x) * 4;
            this.pixels.set(img.data.subarray(row * img.width * 4, (row + 1) * img.width * 4), to);
        }
    }
    clearRect() { this.pixels.fill(0); }
    drawImage() { /* not used */ }
    save() { /* not used */ }
    restore() { /* not used */ }
}

class FakeCanvas {
    private ctx: FakeContext | null = null;
    private w: number;
    private h: number;
    constructor(width: number, height: number) { this.w = width; this.h = height; }
    get width() { return this.w; }
    set width(v: number) { this.w = v; this.ctx?.resized(); }
    get height() { return this.h; }
    set height(v: number) { this.h = v; this.ctx?.resized(); }
    getContext() { return (this.ctx ??= new FakeContext(this)); }
}

const globals = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeAll(() => {
    for (const name of ["OffscreenCanvas", "ImageData"]) saved[name] = globals[name];
    globals.OffscreenCanvas = FakeCanvas;
    globals.ImageData = FakeImageData;
});
afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete globals[name]; else globals[name] = value;
    }
});

function populated(): GDIContext {
    const gdi = new GDIContext();
    gdi.setCanvas(new FakeCanvas(64, 48) as unknown as OffscreenCanvas);
    const mem = gdi.createSizedMemoryDC(8, 4);
    const ctx = gdi.contexts.get(mem)!;
    const img = ctx.getImageData(0, 0, 8, 4);
    img.data[0] = 200; img.data[3] = 255; img.data[127] = 9;
    ctx.putImageData(img, 0, 0);
    const brush = gdi.createSolidBrush(0x00336699);
    gdi.selectObject(mem, brush);
    gdi.setTextColor(mem, 0x00112233);
    gdi.setCurrentPosition(mem, 3, 4);
    const overlay = gdi.createOverlayDC();
    gdi.overlayCtx!.putImageData(new FakeImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1) as unknown as ImageData, 5, 5);
    gdi.setTextColor(overlay, 0x00ff0000);
    return gdi;
}

describe("GDI context", () => {
    test("capture → restore → capture is byte-identical, pixels included", () => {
        const first = populated().captureState();
        expect(first.dcs.length).toBe(2);
        expect(first.dcs.find(d => d.canvas)?.canvas?.pixels[0]).toBe(200);
        const fresh = new GDIContext();
        fresh.setCanvas(new FakeCanvas(32, 32) as unknown as OffscreenCanvas);
        fresh.restoreState(structuredClone(first));
        expect(bytes(fresh.captureState())).toEqual(bytes(first));
    });

    test("a restored DC draws on its own canvas, an overlay DC on the overlay", () => {
        const first = populated().captureState();
        const fresh = new GDIContext();
        fresh.setCanvas(new FakeCanvas(64, 48) as unknown as OffscreenCanvas);
        fresh.restoreState(structuredClone(first));
        const [memDc, overlayDc] = first.dcs;
        expect(fresh.contexts.get(memDc!.hdc)).not.toBe(fresh.overlayCtx);
        expect(fresh.contexts.get(overlayDc!.hdc)).toBe(fresh.overlayCtx!);
        expect(fresh.hdcStates.get(memDc!.hdc)!.appliedFont).toBe("");
    });

    test("refuses while a bitmap is still being decoded", () => {
        const gdi = populated();
        gdi.bitmapImageBitmapCache.set(0x30001, new Promise(() => undefined));
        expect(() => gdi.captureState()).toThrow("still being decoded");
    });

    test("refuses a DirectDraw surface DC", () => {
        const gdi = populated();
        const hdc = gdi.createSurfaceDC(4, 4);
        gdi.linkDCToSurface(hdc, 0x10000);
        expect(() => gdi.captureState()).toThrow("DirectDraw surface DC");
    });
});

describe("regions and mappings", () => {
    test("round-trip", () => {
        const first = captureDcRegionState();
        restoreDcRegionState(structuredClone(first));
        expect(bytes(captureDcRegionState())).toEqual(bytes(first));
    });
});

describe("user images", () => {
    const icon = (): UserImageRecord => ({
        type: "CURSOR", width: 2, height: 1, pixels: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), loading: false, xHotspot: 1, yHotspot: 0,
    });

    test("keep their field types, clamped pixels included", () => {
        const clamped: UserImageRecord = { ...icon(), type: "BITMAP", pixels: new Uint8ClampedArray([9, 8, 7, 6]), dibMasks: [1, 2, 3] };
        for (const record of [icon(), clamped]) {
            const back = restoreUserImage(structuredClone(captureUserImage(record)));
            expect(back).toEqual(record);
            expect(Object.getPrototypeOf(back.pixels)).toBe(Object.getPrototypeOf(record.pixels));
        }
    });

    test("refuse a field without a policy and an image still loading", () => {
        expect(() => captureUserImage({ ...icon(), mystery: 1 } as unknown as UserImageRecord)).toThrow(CaptureRefusal);
        expect(() => captureUserImage({ ...icon(), loading: true })).toThrow("still loading");
    });
});
