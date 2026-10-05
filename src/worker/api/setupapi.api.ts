/**
 * SETUPAPI.dll API descriptor — device enumeration / Configuration Manager.
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

export const setupapiModule: ModuleDescriptor = {
    name: "setupapi",
    functions: [
        makeFunc("SetupDiGetClassDevsA", 4),
        makeFunc("SetupDiGetClassDevsW", 4),
        makeFunc("SetupDiEnumDeviceInfo", 3),
        makeFunc("SetupDiEnumDeviceInterfaces", 5),
        makeFunc("SetupDiGetDeviceInterfaceDetailA", 6),
        makeFunc("SetupDiGetDeviceInterfaceDetailW", 6),
        makeFunc("SetupDiGetDeviceRegistryPropertyA", 7),
        makeFunc("SetupDiGetDeviceRegistryPropertyW", 7),
        makeFunc("SetupDiDestroyDeviceInfoList", 1),
        makeFunc("CM_Get_Device_IDA", 4),
        makeFunc("CM_Get_Device_IDW", 4),
        makeFunc("CM_Get_Parent", 3),
        makeFunc("CM_Locate_DevNodeA", 3),
        makeFunc("CM_Locate_DevNodeW", 3),
    ],
};
