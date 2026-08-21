/**
 * VERSION.dll API descriptor.
 * VerQueryValueA, GetFileVersionInfoA, GetFileVersionInfoSizeA — stubs for PE import patching.
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

export const versionModule: ModuleDescriptor = {
    name: "version",
    functions: [
        makeFunc("VerQueryValueA", 4),
        makeFunc("VerQueryValueW", 4),
        makeFunc("GetFileVersionInfoA", 4),
        makeFunc("GetFileVersionInfoW", 4),
        makeFunc("GetFileVersionInfoExA", 5),
        makeFunc("GetFileVersionInfoExW", 5),
        makeFunc("GetFileVersionInfoSizeA", 2),
        makeFunc("GetFileVersionInfoSizeW", 2),
        makeFunc("GetFileVersionInfoSizeExA", 3),
        makeFunc("GetFileVersionInfoSizeExW", 3),
    ],
};
