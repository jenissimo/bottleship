/**
 * COMBASE.DLL API descriptor — the Windows Runtime entry points (Ro*) and HSTRING.
 * Also reached through api-ms-win-core-winrt[-string]-l1-1-0, the API sets the static
 * UCRT probes before touching the runtime.
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
});

export const combaseModule: ModuleDescriptor = {
    name: "combase",
    functions: [
        makeFunc("RoInitialize", 1, { onUnimplemented: "hresult" }),
        makeFunc("RoUninitialize", 0),
        makeFunc("RoGetActivationFactory", 3, { onUnimplemented: "hresult" }),
        makeFunc("RoActivateInstance", 2, { onUnimplemented: "hresult" }),

        makeFunc("WindowsCreateString", 3, { onUnimplemented: "hresult" }),
        makeFunc("WindowsCreateStringReference", 4, { onUnimplemented: "hresult" }),
        makeFunc("WindowsDeleteString", 1, { onUnimplemented: "hresult" }),
        makeFunc("WindowsDuplicateString", 2, { onUnimplemented: "hresult" }),
        makeFunc("WindowsGetStringRawBuffer", 2),
        makeFunc("WindowsGetStringLen", 1),
        makeFunc("WindowsIsStringEmpty", 1),
    ],
};
