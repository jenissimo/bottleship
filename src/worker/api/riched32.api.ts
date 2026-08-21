/**
 * RICHED32.dll API descriptor.
 * Rich Edit 1.x loader — registers RICHEDIT window classes on init.
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
    ordinal: overrides.ordinal,
});

export const riched32Module: ModuleDescriptor = {
    name: "riched32",
    functions: [
        // Primary Rich Edit factory (ordinal 4 on legacy builds).
        makeFunc("CreateTextServices", 3, { ordinal: 4 }),
        makeFunc("DllGetClassObject", 3),
        makeFunc("DllCanUnloadNow", 0),
    ],
};
