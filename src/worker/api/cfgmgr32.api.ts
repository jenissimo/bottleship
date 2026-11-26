import type { FunctionDescriptor, ModuleDescriptor, ParameterDescriptor } from "./types";

const configRet = (
    name: string,
    params: ParameterDescriptor[],
    onUnimplemented: "zero" | "configret" = "configret",
): FunctionDescriptor => ({
    name,
    params,
    returnType: "u32",
    callingConvention: "stdcall",
    onUnimplemented,
});

// Windows SDK cfgmgr32.h. Without an emulated configuration store, there are no
// logical configuration handles to free and no device/resource data to return.
export const cfgmgr32Module: ModuleDescriptor = {
    name: "cfgmgr32",
    functions: [
        configRet("CM_Free_Log_Conf_Handle", [
            { name: "lcLogConf", type: "u32" },
        ], "zero"),
        configRet("CM_Get_Res_Des_Data", [
            { name: "rdResDes", type: "u32" },
            { name: "Buffer", type: "ptr", direction: "out" },
            { name: "BufferLen", type: "u32" },
            { name: "ulFlags", type: "u32" },
        ]),
        configRet("CM_Get_Res_Des_Data_Size", [
            { name: "pulSize", type: "ptr", direction: "out" },
            { name: "rdResDes", type: "u32" },
            { name: "ulFlags", type: "u32" },
        ]),
        configRet("CM_Get_First_Log_Conf", [
            { name: "plcLogConf", type: "ptr", direction: "out", optional: true },
            { name: "dnDevInst", type: "u32" },
            { name: "ulFlags", type: "u32" },
        ]),
        configRet("CM_Get_Next_Res_Des", [
            { name: "prdResDes", type: "ptr", direction: "out" },
            { name: "rdResDes", type: "u32" },
            { name: "ForResource", type: "u32" },
            { name: "pResourceID", type: "ptr", direction: "out", optional: true },
            { name: "ulFlags", type: "u32" },
        ]),
        configRet("CM_Locate_DevNodeA", [
            { name: "pdnDevInst", type: "ptr", direction: "out" },
            { name: "pDeviceID", type: "ptr", optional: true },
            { name: "ulFlags", type: "u32" },
        ]),
    ],
};
