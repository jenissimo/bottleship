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

export const dbghelpModule: ModuleDescriptor = {
    name: "dbghelp",
    functions: [
        makeFunc("SymInitialize", 3),
        makeFunc("SymCleanup", 1),
        makeFunc("SymSetOptions", 1),
        makeFunc("SymGetOptions", 0),
        makeFunc("SymGetModuleBase", 2),
        // A DWORD64 argument occupies two stack dwords on x86 stdcall — the *64 variants
        // and SymFromAddr take one, so their RET N is one dword wider than the 32-bit form.
        makeFunc("SymGetModuleBase64", 3),
        makeFunc("SymLoadModule", 6),
        makeFunc("SymLoadModule64", 7),
        makeFunc("SymFunctionTableAccess", 2),
        makeFunc("SymFunctionTableAccess64", 3),
        makeFunc("SymGetLineFromAddr", 4),
        makeFunc("SymGetLineFromAddr64", 5),
        makeFunc("SymGetSymFromAddr", 4),
        makeFunc("SymGetSymFromAddr64", 5),
        makeFunc("StackWalk", 9),
        makeFunc("StackWalk64", 9),
        makeFunc("UnDecorateSymbolName", 4),
        makeFunc("ImageNtHeader", 1),
        makeFunc("MakeSureDirectoryPathExists", 1),
        makeFunc("SearchTreeForFile", 3),
        makeFunc("SymFromAddr", 5), // hProcess, Address (DWORD64), Displacement, Symbol
        // hProcess, ProcessId, hFile, DumpType, ExceptionParam, UserStreamParam, CallbackParam
        makeFunc("MiniDumpWriteDump", 7),
    ],
};
