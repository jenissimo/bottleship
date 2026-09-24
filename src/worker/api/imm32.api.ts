/**
 * IMM32.dll API descriptor.
 * Input Method Manager of a system with no IME installed.
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
        makeFunc("ImmCreateContext", 0),
        makeFunc("ImmDestroyContext", 1),
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
        makeFunc("ImmAssociateContextEx", 3),
        makeFunc("ImmSetCandidateWindow", 2),
        makeFunc("ImmSetCompositionWindow", 2),
        makeFunc("ImmGetDefaultIMEWnd", 1),

        // immdev.h: the INPUTCONTEXT and its IMCC component blocks.
        makeFunc("ImmLockIMC", 1),
        makeFunc("ImmUnlockIMC", 1),
        makeFunc("ImmGetIMCLockCount", 1),
        makeFunc("ImmCreateIMCC", 1),
        makeFunc("ImmDestroyIMCC", 1),
        makeFunc("ImmLockIMCC", 1),
        makeFunc("ImmUnlockIMCC", 1),
        makeFunc("ImmGetIMCCLockCount", 1),
        makeFunc("ImmGetIMCCSize", 1),
        makeFunc("ImmReSizeIMCC", 2),
    ],
};
