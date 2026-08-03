import { expect, test } from "bun:test";
import { drawText } from "../../src/worker/modules/gdi32/gdi-text";

class FakeContext {
    canvas: Record<string, unknown> = {};
    font = "12px sans-serif";
    fillStyle: string | CanvasGradient | CanvasPattern = "#000";
    textBaseline: CanvasTextBaseline = "top";
    textAlign: CanvasTextAlign = "left";
    directFillTextCalls = 0;
    putImageDataCalls = 0;
    lastGetImageDataX: number | null = null;

    measureText(text: string) {
        return {
            width: text.length * 6,
            fontBoundingBoxAscent: 9,
            fontBoundingBoxDescent: 3,
        } as TextMetrics;
    }
    fillText() { this.directFillTextCalls++; }
    clearRect() {}
    save() {}
    restore() {}
    beginPath() {}
    rect() {}
    clip() {}
    fillRect() {}
    getImageData(x: number, _y: number, w: number, h: number) {
        this.lastGetImageDataX = x;
        const data = new Uint8ClampedArray(w * h * 4);
        // The scratch glyph has solid coverage at one pixel.
        if (this.canvas.__scratch) data[3] = 255;
        return { data, width: w, height: h } as ImageData;
    }
    putImageData() { this.putImageDataCalls++; }
}

test("DrawText keeps font smoothing for DEFAULT_QUALITY", () => {
    const previous = globalThis.OffscreenCanvas;
    class FakeOffscreenCanvas {
        width: number;
        height: number;
        private readonly ctx = new FakeContext();
        constructor(width: number, height: number) {
            this.width = width;
            this.height = height;
            this.ctx.canvas = { __scratch: true };
        }
        getContext() { return this.ctx; }
    }
    (globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;

    try {
        const target = new FakeContext();
        const state = {
            font: "12px sans-serif",
            appliedFont: "",
            fontQuality: 0,
            fontSize: 12,
            textColorValue: 0x00332211,
            textColor: "#112233",
            appliedFillStyle: "",
            bkMode: 1,
            bkColor: "#ff00ff",
            hBitmap: 0,
        };
        const gdi = {
            contexts: new Map([[1, target]]),
            hdcStates: new Map([[1, state]]),
            overlayCtx: null,
            setOverlayDirty() {},
            markDirty() {},
            invalidateImageDataCache() {},
        };

        expect(drawText(gdi as any, 1, "Begin the Journey", {
            left: 0, top: 0, right: 200, bottom: 30,
        }, 0x21)).not.toBeNull(); // DT_SINGLELINE | DT_CENTER

        expect(target.directFillTextCalls).toBe(1);
        expect(target.putImageDataCalls).toBe(0);
    } finally {
        (globalThis as any).OffscreenCanvas = previous;
    }
});

test("DrawText thresholds only explicitly NONANTIALIASED_QUALITY fonts", () => {
    const previous = globalThis.OffscreenCanvas;
    class FakeOffscreenCanvas {
        width: number;
        height: number;
        private readonly ctx = new FakeContext();
        constructor(width: number, height: number) {
            this.width = width;
            this.height = height;
            this.ctx.canvas = { __scratch: true };
        }
        getContext() { return this.ctx; }
    }
    (globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;

    try {
        const target = new FakeContext();
        const state = {
            font: "12px sans-serif", appliedFont: "", fontQuality: 3, fontSize: 12,
            textColorValue: 0x00332211, textColor: "#112233", appliedFillStyle: "",
            bkMode: 1, bkColor: "#ff00ff", hBitmap: 0,
        };
        const gdi = {
            contexts: new Map([[1, target]]), hdcStates: new Map([[1, state]]),
            overlayCtx: null, setOverlayDirty() {}, markDirty() {}, invalidateImageDataCache() {},
        };

        expect(drawText(gdi as any, 1, "Begin the Journey", {
            left: 0, top: 0, right: 200, bottom: 30,
        }, 0x21)).not.toBeNull(); // DT_SINGLELINE | DT_CENTER
        expect(target.directFillTextCalls).toBe(0);
        expect(target.putImageDataCalls).toBe(1);
        expect(target.lastGetImageDataX).toBe(47);
    } finally {
        (globalThis as any).OffscreenCanvas = previous;
    }
});
