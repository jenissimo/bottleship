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

export const wininetModule: ModuleDescriptor = {
    name: "wininet",
    functions: [
        makeFunc("InternetOpenA", 5),
        makeFunc("InternetOpenW", 5),
        makeFunc("InternetOpenUrlA", 6),
        makeFunc("InternetOpenUrlW", 6),
        makeFunc("InternetConnectA", 8),
        makeFunc("InternetConnectW", 8),
        makeFunc("HttpOpenRequestA", 8),
        makeFunc("HttpOpenRequestW", 8),
        makeFunc("HttpSendRequestA", 5),
        makeFunc("HttpSendRequestW", 5),
        makeFunc("HttpQueryInfoA", 5),
        makeFunc("HttpQueryInfoW", 5),
        makeFunc("InternetReadFile", 4),
        makeFunc("InternetCloseHandle", 1),
        makeFunc("InternetSetOptionA", 4),
        makeFunc("InternetSetOptionW", 4),
        makeFunc("InternetQueryOptionA", 4),
        makeFunc("InternetQueryOptionW", 4),
        makeFunc("InternetGetConnectedState", 2),
        makeFunc("InternetCheckConnectionA", 3),
        makeFunc("InternetCheckConnectionW", 3),
        makeFunc("InternetSetOptionExA", 5),
        makeFunc("InternetSetStatusCallback", 2),
        makeFunc("InternetWriteFile", 4),
        makeFunc("InternetSetFilePointer", 5),
        makeFunc("InternetQueryDataAvailable", 4),
        makeFunc("InternetCanonicalizeUrlA", 4),
        makeFunc("InternetGetLastResponseInfoA", 3),
        makeFunc("InternetCrackUrlA", 4),
    ]
};
