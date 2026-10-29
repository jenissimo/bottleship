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

export const shlwapiModule: ModuleDescriptor = {
    name: "shlwapi",
    functions: [
        makeFunc("ord_66", 3, { ordinal: 66 }), // FindResourceW forwarder
        makeFunc("ord_52", 7, { ordinal: 52 }), // CreateFileW forwarder
        makeFunc("PathCreateFromUrlA", 4, { onUnimplemented: "hresult" }),
        makeFunc("PathCreateFromUrlW", 4, { onUnimplemented: "hresult" }),
        makeFunc("UrlCreateFromPathA", 4, { onUnimplemented: "hresult" }),
        makeFunc("UrlCreateFromPathW", 4, { onUnimplemented: "hresult" }),
        makeFunc("UrlIsA", 2),
        makeFunc("UrlIsW", 2),
        makeFunc("StrCmpNW", 3, { returnType: "i32" }),
        makeFunc("PathIsURLA", 1),
        makeFunc("PathIsURLW", 1),
        makeFunc("PathSearchAndQualifyA", 3),
        makeFunc("PathSearchAndQualifyW", 3),
        makeFunc("PathFindFileNameA", 1),
        makeFunc("PathFindFileNameW", 1),
        makeFunc("PathFindExtensionA", 1),
        makeFunc("PathFindExtensionW", 1),
        makeFunc("PathAppendA", 2),
        makeFunc("PathAppendW", 2),
        makeFunc("PathCanonicalizeA", 2),
        makeFunc("PathCanonicalizeW", 2),
        makeFunc("PathCombineA", 3),
        makeFunc("PathCombineW", 3),
        makeFunc("PathAddBackslashA", 1),
        makeFunc("PathAddBackslashW", 1),
        makeFunc("PathRemoveFileSpecA", 1),
        makeFunc("PathRemoveFileSpecW", 1),
        makeFunc("PathStripToRootA", 1),
        makeFunc("PathStripToRootW", 1),
        makeFunc("PathIsUNCA", 1),
        makeFunc("PathIsUNCW", 1),
        makeFunc("PathIsDirectoryA", 1),
        makeFunc("PathIsDirectoryW", 1),
        makeFunc("PathFileExistsA", 1),
        makeFunc("PathFileExistsW", 1),
        makeFunc("PathSkipRootA", 1),
        makeFunc("PathSkipRootW", 1),
        makeFunc("PathRelativePathToA", 5),
        makeFunc("PathRelativePathToW", 5),
        makeFunc("PathRemoveExtensionA", 1),
        makeFunc("PathRemoveExtensionW", 1),
        makeFunc("PathRenameExtensionA", 2), // pszPath, pszExt
        makeFunc("PathRenameExtensionW", 2),
        makeFunc("UrlUnescapeA", 4, { onUnimplemented: "hresult" }),
        makeFunc("UrlUnescapeW", 4, { onUnimplemented: "hresult" }),
        makeFunc("SHDeleteKeyW", 2, { onUnimplemented: "win32Status" }),
        makeFunc("PathMatchSpecA", 2), // pszFile, pszSpec -> BOOL
        makeFunc("PathMatchSpecW", 2),
        makeFunc("ColorHLSToRGB", 3),  // wHue, wLuminance, wSaturation -> COLORREF
        makeFunc("ColorRGBToHLS", 4),  // clrRGB, pwHue, pwLuminance, pwSaturation -> void
    ],
};
