/**
 * MSIMG32.dll API descriptor.
 * GDI image helpers frequently imported by legacy apps. 
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

export const msimg32Module: ModuleDescriptor = {
    name: "msimg32",
    functions: [
        makeFunc("GradientFill", 6),
        makeFunc("AlphaBlend", 11),
        makeFunc("TransparentBlt", 11),
    ],
};
