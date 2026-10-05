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
        // Video Compression Manager. A title links these to look for an installed
        // codec; the stack metadata has to be right even when the answer is "none",
        // because the import is bound and called before the answer is read.
        makeFunc("ICLocate", 5),                 // fccType, fccHandler, lpbiIn, lpbiOut, wFlags → HIC
        makeFunc("ICOpen", 3),                   // fccType, fccHandler, wMode → HIC
        makeFunc("ICInfo", 3),                   // fccType, fccHandler, lpicinfo → BOOL
        makeFunc("ICClose", 1),                  // hic → LRESULT
        makeFunc("ICSendMessage", 4),            // hic, msg, dw1, dw2 → LRESULT
        makeFunc("ICDecompress", 6),             // hic, dwFlags, lpbiFormat, lpData, lpbi, lpBits → LRESULT

        // VideoForWindowsVersion() — exported by name and at ordinal 2.
        makeFunc("VideoForWindowsVersion", 0),
        makeFunc("ord_2", 0, { ordinal: 2 }),

        // DrawDib API
        makeFunc("DrawDibOpen", 0),              // → HDRAWDIB
        makeFunc("DrawDibClose", 1),             // hdd
        makeFunc("DrawDibDraw", 13),             // hdd, hdc, xDst, yDst, dxDst, dyDst, lpbi, lpBits, xSrc, ySrc, dxSrc, dySrc, wFlags
    ]
};
