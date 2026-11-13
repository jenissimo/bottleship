/** Glyph metrics and bitmap packing, including explicit failures for unsupported formats. */
import { afterEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { getGlyphOutline } from "../../src/worker/modules/gdi32/gdi-text";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { createPaintingExports } from "../../src/worker/modules/gdi32/painting";

const GGO_METRICS = 0, GGO_BITMAP = 1, GGO_NATIVE = 2, GGO_BEZIER = 3, GGO_GRAY8_BITMAP = 6;
const GGO_GLYPH_INDEX = 0x0080;
const GDI_ERROR = 0xFFFFFFFF;

/** Mutable scenario the fake canvas's measureText/getImageData read on every call, so the
 *  module-level scratch-canvas singleton in gdi-text.ts can be reused across calls/tests
 *  without staling: behavior comes from this object, not from when the canvas was built.
 *  Each test replaces it via freshScenario(), never by spreading the PREVIOUS scenario — a
 *  flag like throwOnGetImageData must not survive into a test that didn't ask for it. */
function freshScenario() {
    return {
        width: 0,
        abLeft: 0, abRight: 0, abAscent: 0, abDescent: 0,
        /** alpha[y][x], exactly blackBoxY rows by blackBoxX columns for the format tests. */
        alpha: [] as number[][],
        throwOnGetImageData: false,
        getImageDataCalls: 0,
    };
}
let scenario = freshScenario();

class FakeContext {
    canvas: Record<string, unknown> = {};
    font = "";
    fillStyle: string = "";
    textBaseline: CanvasTextBaseline = "alphabetic";
    textAlign: CanvasTextAlign = "left";
    measureText(_text: string) {
        return {
            width: scenario.width,
            actualBoundingBoxLeft: scenario.abLeft,
            actualBoundingBoxRight: scenario.abRight,
            actualBoundingBoxAscent: scenario.abAscent,
            actualBoundingBoxDescent: scenario.abDescent,
        } as TextMetrics;
    }
    clearRect() {}
    fillText() {}
    getImageData(_x: number, _y: number, w: number, h: number) {
        scenario.getImageDataCalls++;
        if (scenario.throwOnGetImageData) throw new Error("readback failed");
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                data[(y * w + x) * 4 + 3] = scenario.alpha[y]?.[x] ?? 0;
            }
        }
        return { data, width: w, height: h } as ImageData;
    }
}

function installFakeOffscreenCanvas(): () => void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    class FakeOffscreenCanvas {
        width: number;
        height: number;
        private readonly ctx = new FakeContext();
        constructor(width: number, height: number) {
            this.width = width;
            this.height = height;
        }
        getContext() { return this.ctx; }
    }
    (globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;
    return () => {
        if (previous) Object.defineProperty(globalThis, 'OffscreenCanvas', previous);
        else delete (globalThis as any).OffscreenCanvas;
    };
}

function fakeGdi(fontSize = 16) {
    return {
        getMeasureContext() { return { font: "16px sans-serif" } as unknown as OffscreenCanvasRenderingContext2D; },
        hdcStates: new Map([[1, { fontSize } as any]]),
    } as unknown as GDIContext;
}

test("GGO_METRICS reports the glyph's ink box and advance without rasterizing", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { ...freshScenario(), width: 10, abLeft: 1, abRight: 5, abAscent: 8, abDescent: 2, alpha: [] };
        const r = getGlyphOutline(fakeGdi(), 1, 'A', GGO_METRICS);
        expect(r).not.toBeNull();
        expect(r!.blackBoxX).toBe(6);  // ceil(abLeft + abRight)
        expect(r!.blackBoxY).toBe(10); // ceil(abAscent + abDescent)
        expect(r!.originX).toBe(-1);   // -abLeft
        expect(r!.originY).toBe(8);    // abAscent
        expect(r!.cellIncX).toBe(10);  // advance width
        expect(r!.bitmap).toBeNull();
    } finally { restore(); }
});

test("fractional Canvas bounds round outward to a box that fully encloses them", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        // abLeft=0.4/abRight=5.4 independently-rounded would give origin 0/width 6, clipping
        // the ink; the same floor/ceil edges must give origin -1/width 7 instead.
        scenario = { ...freshScenario(), width: 6, abLeft: 0.4, abRight: 5.4, abAscent: 7.2, abDescent: 1.1, alpha: [] };
        const r = getGlyphOutline(fakeGdi(), 1, 'g', GGO_METRICS);
        expect(r!.originX).toBe(-1);
        expect(r!.blackBoxX).toBe(7);
        expect(r!.originY).toBe(8);   // ceil(7.2)
        expect(r!.blackBoxY).toBe(10); // ceil(7.2) + ceil(1.1)
    } finally { restore(); }
});

test("a glyph with no ink (space) reports a zero-sized box and an empty raster without reading pixels", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { ...freshScenario(), width: 8, abLeft: 0, abRight: 0, abAscent: 0, abDescent: 0, alpha: [], getImageDataCalls: 0 };
        const metricsOnly = getGlyphOutline(fakeGdi(), 1, ' ', GGO_METRICS);
        expect(metricsOnly!.blackBoxX).toBe(0);
        expect(metricsOnly!.blackBoxY).toBe(0);
        expect(metricsOnly!.originX).toBe(0);
        expect(metricsOnly!.originY).toBe(0);

        const bitmapMode = getGlyphOutline(fakeGdi(), 1, ' ', GGO_BITMAP);
        expect(bitmapMode).not.toBeNull();
        expect(bitmapMode!.bitmap).not.toBeNull();
        expect(bitmapMode!.bitmap!.length).toBe(0);
        expect(scenario.getImageDataCalls).toBe(0);
    } finally { restore(); }
});

test("GGO_BITMAP packs 1bpp rows MSB-first, padded to a DWORD", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        // A 3x2 box: row0 = 1,0,1 ; row1 = 0,1,0 (coverage thresholded at >=128).
        scenario = {
            ...freshScenario(), width: 3, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0,
            alpha: [[255, 0, 255], [0, 255, 0]],
        };
        const r = getGlyphOutline(fakeGdi(), 1, 'x', GGO_BITMAP);
        expect(r).not.toBeNull();
        expect(r!.blackBoxX).toBe(3);
        expect(r!.blackBoxY).toBe(2);
        const bmp = r!.bitmap!;
        expect(bmp.length).toBe(8); // stride 4 (padded from 1 byte) * 2 rows
        expect(bmp[0]).toBe(0b10100000);
        expect(bmp[1]).toBe(0);
        expect(bmp[4]).toBe(0b01000000);
        expect(bmp[5]).toBe(0);
    } finally { restore(); }
});

test("GGO_GRAY8_BITMAP quantizes alpha coverage to 0..64", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = {
            ...freshScenario(), width: 2, abLeft: 0, abRight: 2, abAscent: 1, abDescent: 0,
            alpha: [[255, 128]],
        };
        const r = getGlyphOutline(fakeGdi(), 1, 'y', GGO_GRAY8_BITMAP);
        expect(r).not.toBeNull();
        const bmp = r!.bitmap!;
        expect(bmp.length).toBe(4); // stride 4 (2 bytes padded to a DWORD) * 1 row
        expect(bmp[0]).toBe(64);
        expect(bmp[1]).toBe(32);
    } finally { restore(); }
});

test("vector-outline formats (GGO_NATIVE, GGO_BEZIER) are not supported and fail cleanly", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { ...freshScenario(), width: 8, abLeft: 0, abRight: 6, abAscent: 8, abDescent: 2, alpha: [] };
        expect(getGlyphOutline(fakeGdi(), 1, 'A', GGO_NATIVE)).toBeNull();
        expect(getGlyphOutline(fakeGdi(), 1, 'A', GGO_BEZIER)).toBeNull();
    } finally { restore(); }
});

test("a failed pixel readback fails the whole call instead of returning an empty success", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = {
            ...freshScenario(), width: 5, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0,
            alpha: [[255, 255, 0], [0, 0, 0]], throwOnGetImageData: true,
        };
        expect(getGlyphOutline(fakeGdi(), 1, 'x', GGO_BITMAP)).toBeNull();
    } finally { restore(); }
});

// --- Thunk-level: GetGlyphOutlineA/W and GetKerningPairsA/W -----------------------------

type Thunk = (c: unknown, m: Uint8Array, a: number[]) => number;

const savedInstance = (System as unknown as { instance: unknown }).instance;
afterEach(() => { (System as unknown as { instance: unknown }).instance = savedInstance; });

function setupThunks() {
    const mem = new Uint8Array(0x1000);
    (System as unknown as { instance: unknown }).instance = { gdiContext: new GDIContext(), process: { getCurrentMemory: () => mem } };
    return { mem, exports: createPaintingExports() as Record<string, Thunk> };
}

test("GetGlyphOutlineA fills GLYPHMETRICS and returns the raster size", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = {
            ...freshScenario(), width: 5, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0,
            alpha: [[255, 255, 0], [0, 0, 0]],
        };
        const { mem, exports } = setupThunks();
        const lpgm = 0x100, lpvBuffer = 0x200, cbBuffer = 0x100;
        const required = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_BITMAP, lpgm, cbBuffer, lpvBuffer, 0]);
        expect(required).toBeGreaterThan(0);
        expect(required).not.toBe(GDI_ERROR);

        const dv = new DataView(mem.buffer);
        expect(dv.getUint32(lpgm, true)).toBe(3);      // gmBlackBoxX
        expect(dv.getUint32(lpgm + 4, true)).toBe(2);  // gmBlackBoxY
        expect(dv.getInt16(lpgm + 16, true)).toBe(5);  // gmCellIncX

        // 3 columns -> stride 4; row0 bits 110..., row1 all zero.
        expect(mem[lpvBuffer]).toBe(0b11000000);
        expect(mem[lpvBuffer + 4]).toBe(0);
        expect(required).toBe(8);
    } finally { restore(); }
});

test("a too-small buffer fails without a partial write, and a NULL buffer queries the size", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { ...freshScenario(), width: 5, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0, alpha: [[255, 255, 0], [0, 0, 0]] };
        const { mem, exports } = setupThunks();
        const lpgm = 0x100, lpvBuffer = 0x200;

        mem.fill(0xAA, lpvBuffer, lpvBuffer + 16);
        const tooSmall = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_BITMAP, lpgm, 1, lpvBuffer, 0]);
        expect(tooSmall).toBe(GDI_ERROR);
        expect(mem[lpvBuffer]).toBe(0xAA); // untouched

        const queried = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_BITMAP, lpgm, 0, 0, 0]);
        expect(queried).toBe(8);
    } finally { restore(); }
});

test("cbBuffer=0 is a size query even with a non-NULL buffer, and leaves it untouched", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { ...freshScenario(), width: 5, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0, alpha: [[255, 255, 0], [0, 0, 0]] };
        const { mem, exports } = setupThunks();
        const lpgm = 0x100, lpvBuffer = 0x200;
        mem.fill(0xAA, lpvBuffer, lpvBuffer + 16);

        const queried = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_BITMAP, lpgm, 0, lpvBuffer, 0]);
        expect(queried).toBe(8);
        expect(mem[lpvBuffer]).toBe(0xAA); // untouched
    } finally { restore(); }
});

test("a rasterization failure returns GDI_ERROR, not a successful empty result", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = {
            ...freshScenario(), width: 5, abLeft: 0, abRight: 3, abAscent: 2, abDescent: 0,
            alpha: [[255, 255, 0], [0, 0, 0]], throwOnGetImageData: true,
        };
        const { mem, exports } = setupThunks();
        const r = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_BITMAP, 0x100, 0x100, 0x200, 0]);
        expect(r).toBe(GDI_ERROR);
    } finally { restore(); }
});

test("GetGlyphOutlineW takes uChar as a UTF-16 code unit, not an ANSI byte", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { ...freshScenario(), width: 4, abLeft: 0, abRight: 2, abAscent: 2, abDescent: 0, alpha: [[0, 0], [0, 0]] };
        const { mem, exports } = setupThunks();
        // 0x20AC (€) has no single-byte Windows-1252 representation; the W entry must not
        // try to decode it as one.
        const r = exports['GetGlyphOutlineW']!({}, mem, [0, 0x20AC, GGO_METRICS, 0x100, 0, 0, 0]);
        expect(r).toBe(0);
    } finally { restore(); }
});

test("GetGlyphOutlineA decodes a packed two-byte DBCS character on a multi-byte code page", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        let seenChar = "";
        scenario = { ...freshScenario(), width: 4, abLeft: 0, abRight: 2, abAscent: 2, abDescent: 0, alpha: [[0, 0], [0, 0]] };
        const { mem, exports } = setupThunks();
        const gdi = (System.getInstance() as unknown as { gdiContext: GDIContext }).gdiContext;
        const real = gdi.getGlyphOutline.bind(gdi);
        gdi.getGlyphOutline = (hdc, char, uFormat) => { seenChar = char; return real(hdc, char, uFormat); };

        const cfg = EmulatorConfig.getInstance();
        const savedCp = cfg.ansiCodePage;
        cfg.ansiCodePage = 932; // Shift-JIS
        try {
            // CP932 0x82A0 = bytes 0x82,0xA0 = "あ" (HIRAGANA LETTER A), lead byte packed in
            // the high byte of uChar. Masking to the low byte alone would decode the lead
            // byte (0xA0) on its own instead.
            exports['GetGlyphOutlineA']!({}, mem, [0, 0x82A0, GGO_METRICS, 0x100, 0, 0, 0]);
            expect(seenChar).toBe('あ');
        } finally {
            cfg.ansiCodePage = savedCp;
        }
    } finally { restore(); }
});

test("GGO_GLYPH_INDEX is rejected: this emulator has no glyph-index table", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { ...freshScenario(), width: 4, abLeft: 0, abRight: 2, abAscent: 2, abDescent: 0, alpha: [[0, 0], [0, 0]] };
        const { mem, exports } = setupThunks();
        const r = exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_METRICS | GGO_GLYPH_INDEX, 0x100, 0, 0, 0]);
        expect(r).toBe(GDI_ERROR);
    } finally { restore(); }
});

test("a non-identity MAT2 is rejected; the identity matrix and a NULL pointer are accepted", () => {
    const restore = installFakeOffscreenCanvas();
    try {
        scenario = { ...freshScenario(), width: 4, abLeft: 0, abRight: 2, abAscent: 2, abDescent: 0, alpha: [[0, 0], [0, 0]] };
        const { mem, exports } = setupThunks();
        const dv = new DataView(mem.buffer);
        const lpmat2 = 0x300;

        // Identity: eM11=1.0, eM12=0, eM21=0, eM22=1.0 (FIXED: low word fract, high word value).
        dv.setUint16(lpmat2, 0, true); dv.setInt16(lpmat2 + 2, 1, true);
        dv.setUint16(lpmat2 + 4, 0, true); dv.setInt16(lpmat2 + 6, 0, true);
        dv.setUint16(lpmat2 + 8, 0, true); dv.setInt16(lpmat2 + 10, 0, true);
        dv.setUint16(lpmat2 + 12, 0, true); dv.setInt16(lpmat2 + 14, 1, true);
        expect(exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_METRICS, 0x100, 0, 0, lpmat2])).not.toBe(GDI_ERROR);
        expect(exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_METRICS, 0x100, 0, 0, 0])).not.toBe(GDI_ERROR);

        // A 2x scale on eM11 is not the identity.
        dv.setInt16(lpmat2 + 2, 2, true);
        expect(exports['GetGlyphOutlineA']!({}, mem, [0, 0x41, GGO_METRICS, 0x100, 0, 0, lpmat2])).toBe(GDI_ERROR);
    } finally { restore(); }
});

test("GetKerningPairsA/W report zero kerning pairs instead of failing", () => {
    const { mem, exports } = setupThunks();
    expect(exports['GetKerningPairsA']!({}, mem, [0, 0, 0])).toBe(0);
    expect(exports['GetKerningPairsW']!({}, mem, [0, 0, 0])).toBe(0);
});
