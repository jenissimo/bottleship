/**
 * IMM32.dll API descriptor.
 * Input Method Manager shims for legacy apps.
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

export const imm32Module: ModuleDescriptor = {
    name: "imm32",
    functions: [
        makeFunc("ImmDisableIME", 1),
        makeFunc("ImmIsIME", 1),
        makeFunc("ImmGetOpenStatus", 1),
        makeFunc("ImmSetOpenStatus", 2),
        makeFunc("ImmGetContext", 1),
        makeFunc("ImmReleaseContext", 2),

        makeFunc("ImmGetCompositionStringA", 4),
        makeFunc("ImmGetCompositionStringW", 4),
        makeFunc("ImmSetCompositionStringA", 6),
        makeFunc("ImmSetCompositionStringW", 6),

        makeFunc("ImmGetCandidateListA", 4),
        makeFunc("ImmGetCandidateListW", 4),
        makeFunc("ImmGetCandidateListCountA", 2),

        makeFunc("ImmGetConversionStatus", 3),
        makeFunc("ImmSetConversionStatus", 3),

        makeFunc("ImmGetIMEFileNameA", 3),
        makeFunc("ImmNotifyIME", 4),
        makeFunc("ImmSimulateHotKey", 2),
        makeFunc("ImmAssociateContext", 2),
        makeFunc("ImmSetCandidateWindow", 2),
        makeFunc("ImmSetCompositionWindow", 2),
    ],
};
