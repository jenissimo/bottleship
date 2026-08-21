/**
 * Video for Windows (msvfw32.dll) API Descriptor
 *
 * Provides DrawDib functions used by games to render AVI frames to screen.
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

export const msvfw32Module: ModuleDescriptor = {
    name: "msvfw32",
    functions: [
        // DrawDib API
        makeFunc("DrawDibOpen", 0),              // → HDRAWDIB
        makeFunc("DrawDibClose", 1),             // hdd
        makeFunc("DrawDibDraw", 13),             // hdd, hdc, xDst, yDst, dxDst, dyDst, lpbi, lpBits, xSrc, ySrc, dxSrc, dySrc, wFlags
    ]
};
