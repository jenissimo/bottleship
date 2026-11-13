import { FunctionDescriptor, ModuleDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] =>
    Array.from({ length: count }, (_, i) => ({ name: `arg${i}`, type: "u32" as const }));

const makeFunc = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
    onUnimplemented: "zero",
});

/** Capture is unavailable; creation and driver enumeration report failure. */
export const avicap32Module: ModuleDescriptor = {
    name: "avicap32",
    description: "Video for Windows capture",
    functions: [
        // HWND capCreateCaptureWindow(LPCSTR, DWORD dwStyle, int x, int y, int cx, int cy, HWND parent, int nID)
        makeFunc("capCreateCaptureWindowA", 8),
        makeFunc("capCreateCaptureWindowW", 8),
        // BOOL capGetDriverDescription(UINT wDriverIndex, LPSTR name, int cbName, LPSTR ver, int cbVer)
        makeFunc("capGetDriverDescriptionA", 5),
        makeFunc("capGetDriverDescriptionW", 5),
    ],
};
