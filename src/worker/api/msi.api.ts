import { FunctionDescriptor, ModuleDescriptor, ParameterDescriptor } from "./types";

const params = (count: number): ParameterDescriptor[] =>
    Array.from({ length: count }, (_, i) => ({ name: `arg${i}`, type: "u32" }));

const ordinal = (name: string, value: number, argCount: number): FunctionDescriptor => ({
    name,
    ordinal: value,
    params: params(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
    onUnimplemented: "win32Status",
});

export const msiModule: ModuleDescriptor = {
    name: "msi",
    functions: [
        ordinal("MsiGetProductInfoW", 70, 4),
        ordinal("MsiGetPropertyW", 74, 4),
        ordinal("MsiSetPropertyW", 145, 3),
    ],
};
