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
    ordinal: overrides.ordinal,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

// oleaut32.dll — OLE Automation (exports by ordinal)
// Ordinal mappings from Windows NT/2000 oleaut32.dll export table
export const oleaut32Module: ModuleDescriptor = {
    name: "oleaut32",
    functions: [
        // BSTR functions (ordinal + named alias)
        makeFunc("ord_2", 1, { ordinal: 2 }),     // SysAllocString(LPCOLESTR) -> BSTR
        makeFunc("SysAllocString", 1),
        makeFunc("ord_4", 2, { ordinal: 4 }),     // SysAllocStringLen(LPCOLESTR, UINT) -> BSTR
        makeFunc("SysAllocStringLen", 2),
        makeFunc("ord_5", 3, { ordinal: 5 }),     // SysReAllocStringLen(BSTR*, LPCOLESTR, UINT) -> BOOL
        makeFunc("SysReAllocStringLen", 3),
        makeFunc("ord_6", 1, { ordinal: 6 }),     // SysFreeString(BSTR)
        makeFunc("SysFreeString", 1),
        makeFunc("ord_7", 1, { ordinal: 7 }),     // SysStringLen(BSTR) -> UINT
        makeFunc("SysStringLen", 1),

        // VARIANT functions (ordinal + named alias)
        makeFunc("ord_8", 1, { ordinal: 8 }),     // VariantInit(VARIANT*)
        makeFunc("VariantInit", 1),
        makeFunc("ord_9", 1, { ordinal: 9 }),     // VariantClear(VARIANT*)
        makeFunc("VariantClear", 1),
        makeFunc("ord_10", 2, { ordinal: 10 }),   // VariantCopy(VARIANT*, VARIANT*)
        makeFunc("VariantCopy", 2),
        makeFunc("ord_11", 2, { ordinal: 11 }),   // VariantCopyInd(VARIANT*, VARIANT*)
        makeFunc("VariantCopyInd", 2),
        makeFunc("ord_12", 4, { ordinal: 12 }),   // VariantChangeType
        makeFunc("VariantChangeType", 4),
        makeFunc("ord_13", 6, { ordinal: 13 }),   // VariantChangeTypeEx
        makeFunc("VariantChangeTypeEx", 6),

        // Active object registration (ordinal + named alias)
        makeFunc("ord_33", 3, { ordinal: 33 }),   // RegisterActiveObject
        makeFunc("RegisterActiveObject", 3),
        makeFunc("ord_34", 1, { ordinal: 34 }),   // RevokeActiveObject
        makeFunc("RevokeActiveObject", 1),

        // SafeArray
        makeFunc("SafeArrayCreate", 3),
        makeFunc("SafeArrayDestroy", 1),
        makeFunc("SafeArrayGetDim", 1),
        makeFunc("SafeArrayGetLBound", 3),
        makeFunc("SafeArrayGetUBound", 3),
        makeFunc("SafeArrayAccessData", 2),
        makeFunc("SafeArrayUnaccessData", 1),
        makeFunc("SafeArrayGetElement", 3),
        makeFunc("SafeArrayPutElement", 3),
        makeFunc("ord_148", 3, { ordinal: 148 }), // SafeArrayPtrOfIndex
        makeFunc("SafeArrayPtrOfIndex", 3),

        // Type library (ordinal + named alias)
        makeFunc("ord_161", 2, { ordinal: 161 }), // LoadTypeLib
        makeFunc("LoadTypeLib", 2),
        makeFunc("ord_162", 3, { ordinal: 162 }), // RegisterTypeLib
        makeFunc("RegisterTypeLib", 3),
        makeFunc("ord_163", 5, { ordinal: 163 }), // LoadRegTypeLib
        makeFunc("LoadRegTypeLib", 5),

        // Variant conversion functions
        makeFunc("ord_18", 4, { ordinal: 18 }),   // VarI2FromStr
        makeFunc("VarI2FromStr", 4),
        makeFunc("ord_20", 4, { ordinal: 20 }),   // VarI4FromStr
        makeFunc("VarI4FromStr", 4),
        makeFunc("ord_22", 4, { ordinal: 22 }),   // VarR4FromStr
        makeFunc("VarR4FromStr", 4),
        makeFunc("ord_24", 4, { ordinal: 24 }),   // VarR8FromStr
        makeFunc("VarR8FromStr", 4),
        makeFunc("ord_30", 4, { ordinal: 30 }),   // VarBstrFromI2
        makeFunc("VarBstrFromI2", 4),
        makeFunc("ord_110", 4, { ordinal: 110 }), // VarUI4FromStr
        makeFunc("VarUI4FromStr", 4),
        makeFunc("ord_108", 4, { ordinal: 108 }), // VarUI1FromStr
        makeFunc("VarUI1FromStr", 4),

        // Variant arithmetic / comparison
        makeFunc("VarAdd", 3),
        makeFunc("VarSub", 3),
        makeFunc("VarMul", 3),
        makeFunc("VarDiv", 3),
        makeFunc("VarMod", 3),
        makeFunc("VarIdiv", 3),
        makeFunc("VarAnd", 3),
        makeFunc("VarOr", 3),
        makeFunc("VarXor", 3),
        makeFunc("VarNeg", 2),
        makeFunc("VarNot", 2),
        makeFunc("VarCmp", 4),
        makeFunc("VarBstrFromBool", 4),
        makeFunc("VarBoolFromStr", 4),
        makeFunc("VarCyFromStr", 4),
        makeFunc("VarBstrFromCy", 5),

        // Error info (ordinal + named alias)
        makeFunc("ord_200", 1, { ordinal: 200 }), // GetErrorInfo
        makeFunc("GetErrorInfo", 1),
        makeFunc("ord_201", 1, { ordinal: 201 }), // SetErrorInfo
        makeFunc("SetErrorInfo", 1),
        makeFunc("ord_202", 1, { ordinal: 202 }), // CreateErrorInfo
        makeFunc("CreateErrorInfo", 1),

        // SysStringByteLen
        makeFunc("SysStringByteLen", 1),
        makeFunc("SysAllocStringByteLen", 2),

        // Dispatch
        makeFunc("DispGetParam", 5),
        makeFunc("DispInvoke", 8),
        makeFunc("DispCallFunc", 8),

        // OLE create helpers
        makeFunc("OleCreateFontIndirect", 3),
        makeFunc("OleCreatePictureIndirect", 4),
        makeFunc("OleCreatePropertyFrame", 10),
        makeFunc("OleLoadPicture", 5),
        makeFunc("OleLoadPictureEx", 8),
        makeFunc("OleSavePictureFile", 2),
        makeFunc("OleLoadPicturePath", 6),
        makeFunc("OleIconToCursor", 3),
        makeFunc("OleTranslateColor", 3),

        // Type info
        makeFunc("CreateDispTypeInfo", 3),
        makeFunc("CreateStdDispatch", 4),
        makeFunc("LoadTypeLibEx", 3),
        makeFunc("UnRegisterTypeLib", 5),
        makeFunc("QueryPathOfRegTypeLib", 5),

        // Misc
        makeFunc("DosDateTimeToVariantTime", 3),
        makeFunc("VariantTimeToDosDateTime", 3),
        makeFunc("SystemTimeToVariantTime", 2),
        makeFunc("VariantTimeToSystemTime", 2),
        makeFunc("VarDateFromStr", 4),
        makeFunc("VarBstrFromDate", 4),
        makeFunc("VarFormat", 6),
    ]
};
