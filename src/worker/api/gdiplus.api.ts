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

export const gdiplusModule: ModuleDescriptor = {
    name: "gdiplus",
    functions: [
        makeFunc("GdiplusStartup", 3),
        makeFunc("GdiplusShutdown", 1),
        makeFunc("GdipAlloc", 1),
        makeFunc("GdipFree", 1),
        makeFunc("GdipCreateBitmapFromFile", 2),
        makeFunc("GdipCloneImage", 2),
        makeFunc("GdipDisposeImage", 1),
        makeFunc("GdipGetImageWidth", 2),
        makeFunc("GdipGetImageHeight", 2),
        makeFunc("GdipGetImagePixelFormat", 2),
        makeFunc("GdipGetImagePaletteSize", 2),
        makeFunc("GdipGetImagePalette", 3),
        makeFunc("GdipCreateBitmapFromScan0", 6),
        makeFunc("GdipBitmapLockBits", 5),
        makeFunc("GdipBitmapUnlockBits", 2),
        makeFunc("GdipGetImageGraphicsContext", 2),
        makeFunc("GdipDrawImageI", 4),
        makeFunc("GdipDeleteGraphics", 1),
    ]
};
