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

export const oleaccModule: ModuleDescriptor = {
    name: "oleacc",
    functions: [
        makeFunc("LresultFromObject", 3),
        makeFunc("AccessibleObjectFromWindow", 4, { onUnimplemented: "hresult" }),
        makeFunc("CreateStdAccessibleObject", 4, { onUnimplemented: "hresult" }),
    ]
};
