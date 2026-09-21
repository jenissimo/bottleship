import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

// Every iphlpapi entry point answers with a Win32 error code, where 0 is NO_ERROR —
// so the default "zero" would report SUCCESS and hand the caller an untouched out-buffer
// to walk. ERROR_CALL_NOT_IMPLEMENTED is the honest answer for one we have not written.
const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    onUnimplemented: "win32Status",
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const iphlpapiModule: ModuleDescriptor = {
    name: "iphlpapi",
    functions: [
        makeFunc("GetAdaptersInfo", 2),
    ],
};
