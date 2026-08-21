/**
 * MSACM32.dll API descriptor — the Audio Compression Manager.
 *
 * Ships on every Windows install, so callers resolve its exports with LoadLibrary +
 * GetProcAddress and skip the NULL check (FMOD does). A missing name there is a call
 * through NULL, not a graceful fallback — the whole documented surface is declared.
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

export const msacm32Module: ModuleDescriptor = {
    name: "msacm32",
    functions: [
        makeFunc("acmGetVersion", 0),
        makeFunc("acmMetrics", 3, { onUnimplemented: "mmresult" }),

        makeFunc("acmDriverAddA", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverAddW", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverClose", 2, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverDetailsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverDetailsW", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverEnum", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverID", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverMessage", 4),
        makeFunc("acmDriverOpen", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverPriority", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmDriverRemove", 2, { onUnimplemented: "mmresult" }),

        makeFunc("acmFormatChooseA", 1, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatChooseW", 1, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatDetailsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatDetailsW", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatEnumA", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatEnumW", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatSuggest", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatTagDetailsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatTagDetailsW", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatTagEnumA", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmFormatTagEnumW", 5, { onUnimplemented: "mmresult" }),

        makeFunc("acmFilterChooseA", 1, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterChooseW", 1, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterDetailsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterDetailsW", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterEnumA", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterEnumW", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterTagDetailsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterTagDetailsW", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterTagEnumA", 5, { onUnimplemented: "mmresult" }),
        makeFunc("acmFilterTagEnumW", 5, { onUnimplemented: "mmresult" }),

        makeFunc("acmStreamClose", 2, { onUnimplemented: "mmresult" }),
        makeFunc("acmStreamConvert", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmStreamMessage", 4, { onUnimplemented: "mmresult" }),
        makeFunc("acmStreamOpen", 8, { onUnimplemented: "mmresult" }),
        makeFunc("acmStreamPrepareHeader", 3, { onUnimplemented: "mmresult" }),
        makeFunc("acmStreamReset", 2, { onUnimplemented: "mmresult" }),
        makeFunc("acmStreamSize", 4, { onUnimplemented: "mmresult" }),
        makeFunc("acmStreamUnprepareHeader", 3, { onUnimplemented: "mmresult" }),
    ],
};
