import { ModuleDescriptor } from "./types";

// mscoree is stubbed (no CLR). A managed assembly loaded with LoadLibrary has _CorDllMain
// as its entry point, so the stub is entered as DllMain(hinstDLL, fdwReason, lpvReserved)
// for every process and thread notification and must clean those 12 bytes.
export const mscoreeModule: ModuleDescriptor = {
    name: "mscoree",
    description: ".NET runtime host (stub)",
    functions: [{
        name: "_CorDllMain",
        params: [
            { name: "hinstDLL", type: "u32" },
            { name: "fdwReason", type: "u32" },
            { name: "lpvReserved", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        description: "BOOL; answered FALSE as before, the stdcall frame is what matters",
    }],
};
