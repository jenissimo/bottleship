/**
 * NetAPI32 (netapi32.dll) — legacy NetBIOS/LAN manager APIs.
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
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const netapi32Module: ModuleDescriptor = {
    name: "netapi32",
    functions: [
        makeFunc("Netbios", 1),          // PNCB pncb
        makeFunc("NetWkstaGetInfo", 3),  // LMSTR servername, DWORD level, LPBYTE *bufptr
        makeFunc("NetApiBufferFree", 1), // LPVOID Buffer
    ],
};
