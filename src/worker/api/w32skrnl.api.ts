/**
 * W32SKRNL.DLL — Win9x kernel shim exports.
 * Dark Engine titles (e.g. System Shock 2) call these via GetProcAddress when
 * GetVersion() reports Win9x (high bit set) to resolve a module image base before
 * VirtualProtect on the PE code section (lg.ini AppCore MakeAllCodeWritable).
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
    stackCleanupBytes: overrides.stackCleanupBytes ?? argCount * 4,
});

export const w32skrnlModule: ModuleDescriptor = {
    name: "w32skrnl",
    functions: [
        makeFunc("_ImteFromHModule@4", 1),
        makeFunc("_BaseAddrFromImte@4", 1),
    ],
};
