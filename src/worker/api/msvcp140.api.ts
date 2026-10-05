import { ModuleDescriptor } from "./types";

/**
 * The VS2015+ C++ standard library.
 *
 * Deliberately NOT aliased to msvcp90: std::basic_string's layout changed between
 * VC9 and VC14, so serving VC14's mangled string methods from the VC9 implementation
 * would write the right bytes at the wrong offsets. Only the container throw helpers
 * are declared — they are layout-free (they take a `char const*` and never return),
 * they are what a VS2015 binary imports even when it uses no other part of the
 * library, and without a descriptor for this DLL the whole image fails to load.
 *
 * `void __cdecl`, so the stub pops nothing whatever `params` says.
 */
export const msvcp140Module: ModuleDescriptor = {
    name: "msvcp140",
    functions: [
        { name: "?_Xlength_error@std@@YAXPBD@Z", params: [{ name: "message", type: "string" }], returnType: "void", callingConvention: "cdecl" },
        { name: "?_Xout_of_range@std@@YAXPBD@Z", params: [{ name: "message", type: "string" }], returnType: "void", callingConvention: "cdecl" },
        { name: "?_Xinvalid_argument@std@@YAXPBD@Z", params: [{ name: "message", type: "string" }], returnType: "void", callingConvention: "cdecl" },
        { name: "?_Xoverflow_error@std@@YAXPBD@Z", params: [{ name: "message", type: "string" }], returnType: "void", callingConvention: "cdecl" },
        { name: "?_Xruntime_error@std@@YAXPBD@Z", params: [{ name: "message", type: "string" }], returnType: "void", callingConvention: "cdecl" },
        { name: "?_Xbad_alloc@std@@YAXXZ", params: [], returnType: "void", callingConvention: "cdecl" },
    ],
};
