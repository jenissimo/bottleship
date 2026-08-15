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

const makeFunc = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
});

export const msacm32Module: ModuleDescriptor = {
    name: "msacm32",
    functions: [
        makeFunc("acmGetVersion", 0),
        makeFunc("acmMetrics", 3),

        makeFunc("acmDriverAddA", 5),
        makeFunc("acmDriverAddW", 5),
        makeFunc("acmDriverClose", 2),
        makeFunc("acmDriverDetailsA", 3),
        makeFunc("acmDriverDetailsW", 3),
        makeFunc("acmDriverEnum", 3),
        makeFunc("acmDriverID", 3),
        makeFunc("acmDriverMessage", 4),
        makeFunc("acmDriverOpen", 3),
        makeFunc("acmDriverPriority", 3),
        makeFunc("acmDriverRemove", 2),

        makeFunc("acmFormatChooseA", 1),
        makeFunc("acmFormatChooseW", 1),
        makeFunc("acmFormatDetailsA", 3),
        makeFunc("acmFormatDetailsW", 3),
        makeFunc("acmFormatEnumA", 5),
        makeFunc("acmFormatEnumW", 5),
        makeFunc("acmFormatSuggest", 5),
        makeFunc("acmFormatTagDetailsA", 3),
        makeFunc("acmFormatTagDetailsW", 3),
        makeFunc("acmFormatTagEnumA", 5),
        makeFunc("acmFormatTagEnumW", 5),

        makeFunc("acmFilterChooseA", 1),
        makeFunc("acmFilterChooseW", 1),
        makeFunc("acmFilterDetailsA", 3),
        makeFunc("acmFilterDetailsW", 3),
        makeFunc("acmFilterEnumA", 5),
        makeFunc("acmFilterEnumW", 5),
        makeFunc("acmFilterTagDetailsA", 3),
        makeFunc("acmFilterTagDetailsW", 3),
        makeFunc("acmFilterTagEnumA", 5),
        makeFunc("acmFilterTagEnumW", 5),

        makeFunc("acmStreamClose", 2),
        makeFunc("acmStreamConvert", 3),
        makeFunc("acmStreamMessage", 4),
        makeFunc("acmStreamOpen", 8),
        makeFunc("acmStreamPrepareHeader", 3),
        makeFunc("acmStreamReset", 2),
        makeFunc("acmStreamSize", 4),
        makeFunc("acmStreamUnprepareHeader", 3),
    ],
};
