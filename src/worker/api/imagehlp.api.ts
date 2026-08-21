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

export const imagehlpModule: ModuleDescriptor = {
    name: "imagehlp",
    functions: [
        makeFunc("MapAndLoad", 5),
        makeFunc("UnMapAndLoad", 1),
        makeFunc("ImageRvaToVa", 4),

        // imagehlp.dll exports the dbghelp symbol/stack-walk surface too — NT builds the
        // two from one source and re-exports it here (imagehlp.src, XPSP1). GetProcAddress
        // is scoped by HMODULE, so these must be DECLARED under imagehlp as well or a
        // caller holding imagehlp's handle resolves nothing. Arities match dbghelp's: a
        // DWORD64 argument occupies two stack dwords, which is what makes the *64 forms
        // one dword wider than their 32-bit twins.
        makeFunc("SymInitialize", 3),
        makeFunc("SymCleanup", 1),
        makeFunc("SymSetOptions", 1),
        makeFunc("SymGetOptions", 0),
        makeFunc("SymGetModuleBase", 2),
        makeFunc("SymGetModuleBase64", 3),
        makeFunc("SymLoadModule", 6),
        makeFunc("SymLoadModule64", 7),
        makeFunc("SymFunctionTableAccess", 2),
        makeFunc("SymFunctionTableAccess64", 3),
        makeFunc("SymGetLineFromAddr", 4),
        makeFunc("SymGetLineFromAddr64", 5),
        makeFunc("SymGetSymFromAddr", 4),
        makeFunc("SymGetSymFromAddr64", 5),
        makeFunc("SymFromAddr", 5),
        makeFunc("StackWalk", 9),
        makeFunc("StackWalk64", 9),
        makeFunc("UnDecorateSymbolName", 4),
        makeFunc("MiniDumpWriteDump", 7),
        makeFunc("ImageNtHeader", 1),
        makeFunc("MakeSureDirectoryPathExists", 1),
        makeFunc("SearchTreeForFile", 3),
    ],
};

