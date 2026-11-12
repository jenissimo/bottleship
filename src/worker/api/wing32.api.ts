/**
 * WING32.dll API descriptor — the 32-bit WinG 1.0 library.
 *
 * Arities follow Wine's dlls/wing32/wing32.spec (every export is stdcall).
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const wing32Module: ModuleDescriptor = {
    name: "wing32",
    functions: [
        makeFunc("WinGBitBlt", 8),                 // (hdcDst, xDst, yDst, width, height, hdcSrc, xSrc, ySrc)
        makeFunc("WinGCreateBitmap", 3),           // (hdc, const BITMAPINFO*, void** bits)
        makeFunc("WinGCreateDC", 0),
        makeFunc("WinGCreateHalftoneBrush", 3),    // (hdc, COLORREF, WING_DITHER_TYPE)
        makeFunc("WinGCreateHalftonePalette", 0),
        makeFunc("WinGGetDIBColorTable", 4),       // (hdc, start, count, RGBQUAD*)
        makeFunc("WinGGetDIBPointer", 2),          // (HBITMAP, BITMAPINFO*)
        makeFunc("WinGRecommendDIBFormat", 1),     // (BITMAPINFO*)
        makeFunc("WinGSetDIBColorTable", 4),       // (hdc, start, count, const RGBQUAD*)
        makeFunc("WinGStretchBlt", 10),            // (hdcDst, x, y, w, h, hdcSrc, x, y, w, h)
    ],
};
