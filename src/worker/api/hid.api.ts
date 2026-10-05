/**
 * HID.DLL API descriptor — the user-mode half of the Windows HID class driver.
 *
 * Arities are the stdcall argument counts of the real exports (each `ptr`/`long` is one
 * 32-bit slot); a wrong count misaligns ESP on RET N, so they are not guessed.
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

export const hidModule: ModuleDescriptor = {
    name: "hid",
    functions: [
        // HidD_* — device access. Every one of these takes a handle to an open HID device
        // interface, which is reachable only through SetupAPI enumeration.
        makeFunc("HidD_FlushQueue", 1),
        makeFunc("HidD_FreePreparsedData", 1),
        makeFunc("HidD_GetAttributes", 2),
        makeFunc("HidD_GetFeature", 3),
        makeFunc("HidD_GetHidGuid", 1),
        makeFunc("HidD_GetIndexedString", 4),
        makeFunc("HidD_GetInputReport", 3),
        makeFunc("HidD_GetManufacturerString", 3),
        makeFunc("HidD_GetNumInputBuffers", 2),
        makeFunc("HidD_GetPhysicalDescriptor", 3),
        makeFunc("HidD_GetPreparsedData", 2),
        makeFunc("HidD_GetProductString", 3),
        makeFunc("HidD_GetSerialNumberString", 3),
        makeFunc("HidD_SetFeature", 3),
        makeFunc("HidD_SetNumInputBuffers", 2),
        makeFunc("HidD_SetOutputReport", 3),
        // HidP_* — report-descriptor parsing. These take PHIDP_PREPARSED_DATA, which only
        // HidD_GetPreparsedData can hand out, so they are unreachable for the same reason.
        makeFunc("HidP_GetButtonCaps", 4),
        makeFunc("HidP_GetCaps", 2),
        makeFunc("HidP_GetData", 6),
        makeFunc("HidP_GetLinkCollectionNodes", 3),
        makeFunc("HidP_GetScaledUsageValue", 8),
        makeFunc("HidP_GetSpecificButtonCaps", 7),
        makeFunc("HidP_GetSpecificValueCaps", 7),
        makeFunc("HidP_GetUsageValue", 8),
        makeFunc("HidP_GetUsageValueArray", 9),
        makeFunc("HidP_GetUsages", 8),
        makeFunc("HidP_GetUsagesEx", 7),
        makeFunc("HidP_GetValueCaps", 4),
        makeFunc("HidP_InitializeReportForID", 5),
        makeFunc("HidP_MaxDataListLength", 2),
        makeFunc("HidP_MaxUsageListLength", 3),
        makeFunc("HidP_SetData", 6),
        makeFunc("HidP_SetScaledUsageValue", 8),
        makeFunc("HidP_SetUsageValue", 8),
        makeFunc("HidP_SetUsageValueArray", 9),
        makeFunc("HidP_SetUsages", 8),
        makeFunc("HidP_TranslateUsagesToI8042ScanCodes", 6),
        makeFunc("HidP_UnsetUsages", 8),
    ],
};
