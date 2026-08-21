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

export const crypt32Module: ModuleDescriptor = {
    name: "crypt32",
    functions: [
        makeFunc("CertFreeCertificateContext", 1),
        makeFunc("CertFindCertificateInStore", 5),
        makeFunc("CryptMsgGetParam", 5),
        makeFunc("CryptQueryObject", 11),
        makeFunc("CertCloseStore", 2),
        makeFunc("CryptMsgClose", 1),
        makeFunc("CertGetNameStringA", 5),
        makeFunc("CertGetNameStringW", 5),
        makeFunc("CertGetNameString", 5),
    ],
};
