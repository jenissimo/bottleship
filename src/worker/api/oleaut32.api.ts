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
        makeFunc("ord_149", 1, { ordinal: 149 }), // SysStringByteLen(BSTR) -> UINT
        makeFunc("ord_150", 2, { ordinal: 150 }), // SysAllocStringByteLen(LPCSTR, UINT) -> BSTR

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
        makeFunc("ord_13", 4, { ordinal: 13 }),   // VariantTimeToDosDateTime(DATE, USHORT*, USHORT*)
        makeFunc("VariantChangeTypeEx", 5),

        // Active object registration (ordinal + named alias)
        makeFunc("ord_33", 4, { ordinal: 33 }),   // RegisterActiveObject
        makeFunc("RegisterActiveObject", 4),
        makeFunc("ord_34", 2, { ordinal: 34 }),   // RevokeActiveObject
        makeFunc("RevokeActiveObject", 2),

        // SafeArray. Ordinals 15-26 are contiguous in the export table and are all declared,
        // because one unbindable ordinal import fails the whole PE load. Each is aliased to the
        // named implementation in oleaut32-safearray.ts.
        makeFunc("ord_15", 3, { ordinal: 15 }),   // SafeArrayCreate
        makeFunc("ord_16", 1, { ordinal: 16 }),   // SafeArrayDestroy
        makeFunc("ord_17", 1, { ordinal: 17 }),   // SafeArrayGetDim
        makeFunc("ord_18", 1, { ordinal: 18 }),   // SafeArrayGetElemsize
        makeFunc("ord_19", 3, { ordinal: 19 }),   // SafeArrayGetUBound
        makeFunc("ord_20", 3, { ordinal: 20 }),   // SafeArrayGetLBound
        makeFunc("ord_21", 1, { ordinal: 21 }),   // SafeArrayLock
        makeFunc("ord_22", 1, { ordinal: 22 }),   // SafeArrayUnlock
        makeFunc("ord_23", 2, { ordinal: 23 }),   // SafeArrayAccessData
        makeFunc("ord_24", 1, { ordinal: 24 }),   // SafeArrayUnaccessData
        makeFunc("ord_25", 3, { ordinal: 25 }),   // SafeArrayGetElement
        makeFunc("ord_26", 3, { ordinal: 26 }),   // SafeArrayPutElement
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
        makeFunc("ord_162", 5, { ordinal: 162 }), // LoadRegTypeLib
        makeFunc("LoadRegTypeLib", 5),
        makeFunc("ord_163", 3, { ordinal: 163 }), // RegisterTypeLib
        makeFunc("RegisterTypeLib", 3),

        // Variant conversion functions
        makeFunc("VarI2FromStr", 4),
        makeFunc("VarI4FromStr", 4),
        makeFunc("VarR4FromStr", 4),
        makeFunc("VarR8FromStr", 4),
        makeFunc("VarBstrFromI2", 4),
        makeFunc("VarUI4FromStr", 4),
        makeFunc("VarUI1FromStr", 4),
        makeFunc("ord_30", 8, { ordinal: 30 }),   // DispInvoke
        makeFunc("ord_108", 4, { ordinal: 108 }), // VarBstrFromUI1
        makeFunc("ord_110", 4, { ordinal: 110 }), // VarBstrFromI4
        makeFunc("ord_114", 5, { ordinal: 114 }), // VarBstrFromDate(DATE, LCID, ULONG, BSTR*)

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
        makeFunc("ord_200", 2, { ordinal: 200 }), // GetErrorInfo
        makeFunc("GetErrorInfo", 2),
        makeFunc("ord_201", 2, { ordinal: 201 }), // SetErrorInfo
        makeFunc("SetErrorInfo", 2),
        makeFunc("ord_202", 1, { ordinal: 202 }), // CreateErrorInfo
        makeFunc("CreateErrorInfo", 1),

        // BSTR byte-length functions
        makeFunc("SysStringByteLen", 1),
        makeFunc("SysAllocStringByteLen", 2),

        // Dispatch
        makeFunc("DispGetParam", 5),
        makeFunc("DispInvoke", 8),
        makeFunc("DispCallFunc", 8),

        // OLE create helpers
        makeFunc("OleCreateFontIndirect", 3),
        makeFunc("OleCreatePictureIndirect", 4),
        makeFunc("OleCreatePropertyFrame", 11),
        makeFunc("OleLoadPicture", 5),
        makeFunc("OleLoadPictureEx", 8),
        makeFunc("OleSavePictureFile", 2),
        makeFunc("OleLoadPicturePath", 6),
        makeFunc("OleIconToCursor", 2),
        makeFunc("OleTranslateColor", 3),

        // Type info
        makeFunc("CreateDispTypeInfo", 3),
        makeFunc("CreateStdDispatch", 4),
        makeFunc("LoadTypeLibEx", 3),
        makeFunc("UnRegisterTypeLib", 5),
        makeFunc("QueryPathOfRegTypeLib", 5),

        // Misc
        makeFunc("DosDateTimeToVariantTime", 3),
        makeFunc("VariantTimeToDosDateTime", 4),
        makeFunc("SystemTimeToVariantTime", 2),
        makeFunc("VariantTimeToSystemTime", 3),
        makeFunc("VarDateFromStr", 4),
        makeFunc("VarBstrFromDate", 5),
        makeFunc("VarFormat", 6),
    ]
};
