/**
 * SHCORE.DLL API descriptor — the Win8.1 shell-core DPI entry points.
 *
 * Arities are the stdcall argument counts of the real exports; the HRESULT returns
 * carry onUnimplemented so a missing handler can never read as S_OK.
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

export const shcoreModule: ModuleDescriptor = {
    name: "shcore",
    functions: [
        makeFunc("SetProcessDpiAwareness", 1, { onUnimplemented: "hresult" }),
        makeFunc("GetProcessDpiAwareness", 2, { onUnimplemented: "hresult" }),
        makeFunc("GetDpiForMonitor", 4, { onUnimplemented: "hresult" }),
    ],
};
