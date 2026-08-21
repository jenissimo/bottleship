/**
 * WTSAPI32.dll API descriptor.
 * Terminal Services session queries used by launchers / updaters.
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

export const wtsapi32Module: ModuleDescriptor = {
    name: "wtsapi32",
    functions: [
        makeFunc("WTSFreeMemory", 1),
        makeFunc("WTSQuerySessionInformationA", 5),
        makeFunc("WTSQuerySessionInformationW", 5),
        makeFunc("WTSEnumerateSessionsA", 5),
        makeFunc("WTSEnumerateSessionsW", 5),
        makeFunc("WTSRegisterSessionNotification", 2),
        makeFunc("WTSUnRegisterSessionNotification", 1),
        makeFunc("WTSGetActiveConsoleSessionId", 0),
        makeFunc("WTSOpenServerA", 1),
        makeFunc("WTSOpenServerW", 1),
        makeFunc("WTSCloseServer", 1),
        makeFunc("WTSQueryUserToken", 3),
        makeFunc("WTSDisconnectSession", 3),
        makeFunc("WTSWaitSystemEvent", 3),
        makeFunc("WTSEnumerateProcessesW", 5),
    ],
};
