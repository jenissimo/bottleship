import type { FunctionDescriptor, ModuleDescriptor, ParameterDescriptor } from "./types";

type WNetFailure = "win32NotConnected" | "win32NoNetwork" | "win32InvalidHandle";

function wnet(name: string, onUnimplemented: WNetFailure, params: ParameterDescriptor[]): FunctionDescriptor {
    return { name, params, returnType: "u32", callingConvention: "stdcall", onUnimplemented };
}

function ansiAndWide(name: string, failure: WNetFailure, params: ParameterDescriptor[]): FunctionDescriptor[] {
    return [wnet(name + "A", failure, params), wnet(name + "W", failure, params)];
}

export const mprModule: ModuleDescriptor = {
    name: "mpr",
    functions: [
        ...ansiAndWide("WNetGetConnection", "win32NotConnected", [
            { name: "lpLocalName", type: "ptr" },
            { name: "lpRemoteName", type: "ptr", direction: "out" },
            { name: "lpnLength", type: "ptr", direction: "inout" },
        ]),
        ...ansiAndWide("WNetGetUniversalName", "win32NotConnected", [
            { name: "lpLocalPath", type: "ptr" },
            { name: "dwInfoLevel", type: "u32" },
            { name: "lpBuffer", type: "ptr", direction: "out" },
            { name: "lpBufferSize", type: "ptr", direction: "inout" },
        ]),
        ...ansiAndWide("WNetAddConnection", "win32NoNetwork", [
            { name: "lpRemoteName", type: "ptr" },
            { name: "lpPassword", type: "ptr", optional: true },
            { name: "lpLocalName", type: "ptr", optional: true },
        ]),
        ...ansiAndWide("WNetAddConnection2", "win32NoNetwork", [
            { name: "lpNetResource", type: "ptr" },
            { name: "lpPassword", type: "ptr", optional: true },
            { name: "lpUserName", type: "ptr", optional: true },
            { name: "dwFlags", type: "u32" },
        ]),
        ...ansiAndWide("WNetCancelConnection", "win32NotConnected", [
            { name: "lpName", type: "ptr" },
            { name: "fForce", type: "i32" },
        ]),
        ...ansiAndWide("WNetCancelConnection2", "win32NotConnected", [
            { name: "lpName", type: "ptr" },
            { name: "dwFlags", type: "u32" },
            { name: "fForce", type: "i32" },
        ]),
        ...ansiAndWide("WNetOpenEnum", "win32NoNetwork", [
            { name: "dwScope", type: "u32" },
            { name: "dwType", type: "u32" },
            { name: "dwUsage", type: "u32" },
            { name: "lpNetResource", type: "ptr", optional: true },
            { name: "lphEnum", type: "ptr", direction: "out" },
        ]),
        ...ansiAndWide("WNetEnumResource", "win32InvalidHandle", [
            { name: "hEnum", type: "handle" },
            { name: "lpcCount", type: "ptr", direction: "inout" },
            { name: "lpBuffer", type: "ptr", direction: "out" },
            { name: "lpBufferSize", type: "ptr", direction: "inout" },
        ]),
        wnet("WNetCloseEnum", "win32NoNetwork", [{ name: "hEnum", type: "handle" }]),
    ],
};
