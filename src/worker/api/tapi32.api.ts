/**
 * TAPI 2.x (tapi32.dll) API descriptor — modem/voice line APIs used by EA online titles.
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

export const tapi32Module: ModuleDescriptor = {
    name: "tapi32",
    functions: [
        makeFunc("lineInitialize", 5),
        makeFunc("lineShutdown", 1),
        makeFunc("lineOpen", 9),
        makeFunc("lineClose", 1),
        makeFunc("lineGetDevCaps", 5),
        makeFunc("lineNegotiateAPIVersion", 6),
        makeFunc("lineAnswer", 3),
        makeFunc("lineMakeCall", 5),
        makeFunc("lineGetID", 6),
    ],
};
