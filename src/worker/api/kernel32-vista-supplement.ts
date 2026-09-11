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

/** Vista+ kernel32 exports resolved only via GetProcAddress — statically merged into APIRegistry. */
export const kernel32VistaSupplement: ModuleDescriptor = {
    name: "kernel32",
    functions: [
        makeFunc("InitOnceExecuteOnce", 4),
        makeFunc("InitializeConditionVariable", 1),
        makeFunc("InitializeSRWLock", 1),
        makeFunc("WakeConditionVariable", 1),
        makeFunc("SleepConditionVariableCS", 3),
        makeFunc("FlushProcessWriteBuffers", 0),
        makeFunc("FreeLibraryWhenCallbackReturns", 2),
        makeFunc("GetCurrentProcessorNumber", 0),
        makeFunc("GetCurrentPackageId", 2),
        makeFunc("GetSystemTimePreciseAsFileTime", 1),
        makeFunc("CreateSymbolicLinkW", 3),
        makeFunc("GetFileInformationByHandleEx", 4),
        makeFunc("SetFileInformationByHandle", 4),
        makeFunc("CreateThreadpoolTimer", 3),
        makeFunc("SetThreadpoolTimer", 4),
        makeFunc("WaitForThreadpoolTimerCallbacks", 2),
        makeFunc("CloseThreadpoolTimer", 1),
        makeFunc("CreateThreadpoolWait", 3),
        makeFunc("SetThreadpoolWait", 3),
        makeFunc("CloseThreadpoolWait", 1),
        makeFunc("CreateThreadpoolWork", 3),
        makeFunc("SubmitThreadpoolWork", 1),
        makeFunc("CloseThreadpoolWork", 1),
    ],
};

export const KERNEL32_VISTA_WARMUP_EXPORTS: Array<{ dll: string; name: string }> =
    kernel32VistaSupplement.functions.map((f) => ({ dll: "kernel32", name: f.name }));
