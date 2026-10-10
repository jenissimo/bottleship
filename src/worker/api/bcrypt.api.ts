import type { ModuleDescriptor } from "./types";

export const bcryptModule: ModuleDescriptor = {
    name: "bcrypt",
    functions: [{
        name: "BCryptGenRandom",
        params: [
            { name: "hAlgorithm", type: "handle" },
            { name: "pbBuffer", type: "ptr", direction: "out" },
            { name: "cbBuffer", type: "u32" },
            { name: "dwFlags", type: "u32" },
        ],
        returnType: "i32",
        callingConvention: "stdcall",
        onUnimplemented: "ntstatus",
    }],
};
