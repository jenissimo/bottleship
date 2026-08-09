import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const psapiModule: ModuleDescriptor = {
    name: "psapi",
    functions: [
        makeFunc("GetModuleInformation", 4),
        makeFunc("GetModuleFileNameExA", 4),
        makeFunc("GetModuleFileNameExW", 4),
        makeFunc("GetModuleBaseNameA", 4),
        makeFunc("GetModuleBaseNameW", 4),
        makeFunc("EnumProcesses", 3),
        makeFunc("EnumProcessModules", 4),
        makeFunc("EnumProcessModulesEx", 5),
    ],
};
