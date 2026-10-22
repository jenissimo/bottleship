import type { ModuleDescriptor, InterfaceDescriptor, FunctionDescriptor } from "./types";
import { IUnknown } from "./types";
import { hleClassFactoryInterface, hleComServerFunctions } from "./com-server";
const method = (name: string, count: number): FunctionDescriptor => ({
    name, params: Array.from({ length: count }, (_, i) => ({ name: i ? "arg" + i : "this", type: "u32" as const })),
    returnType: "u32", callingConvention: "stdcall", onUnimplemented: "hresult",
});
export const IDirectPlay8LobbyClient: InterfaceDescriptor = {
    name: "IDirectPlay8LobbyClient", iid: "819074a2-016c-11d3-ae14-006097b01411", inherits: "IUnknown",
    methods: [...IUnknown.methods.map(m => ({ ...m })), method("Initialize", 4), method("EnumLocalPrograms", 6),
        method("ConnectApplication", 6), method("Send", 5), method("ReleaseApplication", 3), method("Close", 2),
        method("GetConnectionSettings", 5), method("SetConnectionSettings", 4)],
};
export const IDirectPlay8LobbiedApplication: InterfaceDescriptor = {
    name: "IDirectPlay8LobbiedApplication", iid: "819074a3-016c-11d3-ae14-006097b01411", inherits: "IUnknown",
    methods: [...IUnknown.methods.map(m => ({ ...m })), method("Initialize", 5), method("RegisterProgram", 3),
        method("UnRegisterProgram", 3), method("Send", 5), method("SetAppAvailable", 3), method("UpdateStatus", 4),
        method("Close", 2), method("GetConnectionSettings", 5), method("SetConnectionSettings", 4)],
};
export const dpnlobbyModule: ModuleDescriptor = {
    name: "dpnlobby", version: "8.1", description: "DirectPlay 8 same-machine lobby and application activation",
    interfaces: [IDirectPlay8LobbyClient, IDirectPlay8LobbiedApplication, hleClassFactoryInterface],
    functions: [...hleComServerFunctions, { name: "DirectPlay8LobbyCreate", ordinal: 1,
        params: [{ name: "iid", type: "u32" }, { name: "output", type: "u32" }, { name: "outer", type: "u32" }],
        returnType: "u32", callingConvention: "stdcall", onUnimplemented: "hresult" }],
};
export default dpnlobbyModule;
