import { ModuleDescriptor } from "./types";

export const winhttpModule: ModuleDescriptor = {
    name: "winhttp",
    description: "Windows HTTP Services",
    functions: [{
        name: "WinHttpGetIEProxyConfigForCurrentUser",
        params: [{ name: "pProxyConfig", type: "ptr", direction: "out" }],
        returnType: "u32",
        callingConvention: "stdcall",
        description: "BOOL; FALSE with nothing written, so the caller uses no proxy",
    }],
};
