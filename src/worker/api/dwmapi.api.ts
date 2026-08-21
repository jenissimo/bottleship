/**
 * DWMAPI.dll API descriptor.
 * Minimal Desktop Window Manager imports used by some D3D9-era titles.
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

export const dwmapiModule: ModuleDescriptor = {
    name: "dwmapi",
    functions: [
        makeFunc("DwmIsCompositionEnabled", 1),
        makeFunc("DwmSetWindowAttribute", 4),
        // Seen in older binaries as import-by-ordinal; maps to DwmEnableComposition on Vista-era systems.
        makeFunc("ord_102", 1, { ordinal: 102 }),
    ],
};
