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
    callingConvention: overrides.callingConvention ?? "cdecl",
});

export const crtdllModule: ModuleDescriptor = {
    name: "crtdll",
    functions: [
        // Memory functions
        makeFunc("malloc", 1),
        makeFunc("free", 1),
        makeFunc("calloc", 2),
        makeFunc("realloc", 2),
        makeFunc("memset", 3),
        makeFunc("memcpy", 3),
        makeFunc("memmove", 3),

        // String functions
        makeFunc("strlen", 1),
        makeFunc("strcpy", 2),
        makeFunc("strncpy", 3),
        makeFunc("strcat", 2),
        makeFunc("strncat", 3),
        makeFunc("strcmp", 2),
        makeFunc("strncmp", 3),
        makeFunc("_strcmpi", 2),
        makeFunc("_stricmp", 2),
        makeFunc("_strnicmp", 3),
        makeFunc("strchr", 2),
        makeFunc("strrchr", 2),
        makeFunc("strstr", 2),
        makeFunc("strpbrk", 2),
        makeFunc("_strlwr", 1),
        makeFunc("_strupr", 1),
        makeFunc("_strdup", 1),

        // Wide string functions
        makeFunc("wcslen", 1),
        makeFunc("wcstombs", 3),

        // Formatting
        makeFunc("sprintf", 16),
        makeFunc("printf", 16),
        makeFunc("vsprintf", 16),
        makeFunc("_vsnprintf", 4),
        makeFunc("sscanf", 16),

        // Conversion functions
        makeFunc("atoi", 1),
        makeFunc("atol", 1),
        makeFunc("strtol", 3),
        makeFunc("strtoul", 3),
        makeFunc("_ltoa", 3),
        makeFunc("toupper", 1),
        makeFunc("tolower", 1),

        // Random/time
        makeFunc("srand", 1),
        makeFunc("rand", 0),
        makeFunc("time", 1),
        makeFunc("_ftime", 1),

        // Character type
        makeFunc("_errno", 0),
        makeFunc("__p__pctype", 0),
        makeFunc("__p___mb_cur_max", 0),
        makeFunc("_isctype", 2),
        makeFunc("setlocale", 2),

        // Runtime
        makeFunc("_adjust_fdiv", 0),
        makeFunc("_initterm", 2),
        makeFunc("_purecall", 0),

        // FPU intrinsics
        makeFunc("_ftol", 0),
        makeFunc("_CItan", 0),
        makeFunc("_CIatan2", 0),
        makeFunc("_CIpow", 0),

        // File I/O
        makeFunc("_open", 2),
        makeFunc("_close", 1),
        makeFunc("_read", 3),
        makeFunc("_write", 3),
        makeFunc("_lseek", 3),
        makeFunc("_tell", 1),
        makeFunc("_filelength", 1),
        makeFunc("_eof", 1),
        makeFunc("_commit", 1),
        makeFunc("_access", 2),
        makeFunc("_chmod", 2),
        makeFunc("_mkdir", 1),
        makeFunc("_rmdir", 1),
        makeFunc("_unlink", 1),
        makeFunc("_splitpath", 5),
        makeFunc("_fullpath", 3),
        makeFunc("_stat", 2),

        // Misc
        makeFunc("qsort", 4),
        makeFunc("bsearch", 5),
        makeFunc("abs", 1),
        makeFunc("labs", 1),
    ]
};
