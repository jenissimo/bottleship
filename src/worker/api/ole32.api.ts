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

export const ole32Module: ModuleDescriptor = {
    name: "ole32",
    functions: [
        makeFunc("CoInitialize", 1),
        makeFunc("CoInitializeEx", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoUninitialize", 0),
        makeFunc("CoCreateInstance", 5),
        makeFunc("CoCreateGuid", 1),
        makeFunc("StringFromGUID2", 3),
        makeFunc("CLSIDFromString", 2),
        makeFunc("CLSIDFromProgID", 2),
        makeFunc("CoTaskMemAlloc", 1),
        makeFunc("CoTaskMemFree", 1),
        makeFunc("IsEqualGUID", 2),
        // PropVariant
        makeFunc("PropVariantClear", 1),
        // OLE initialization
        makeFunc("OleInitialize", 1),
        makeFunc("OleUninitialize", 0),
        makeFunc("RegisterDragDrop", 2, {
            params: [
                { name: "hwnd", type: "handle", direction: "in" },
                { name: "pDropTarget", type: "ptr", direction: "in" },
            ],
            description: "Register an IDropTarget for an OLE drag-and-drop window",
        }),
        makeFunc("RevokeDragDrop", 1, {
            params: [{ name: "hwnd", type: "handle", direction: "in" }],
            description: "Revoke a window's OLE drag-and-drop target registration",
        }),
        // Class registration
        makeFunc("CoRegisterClassObject", 5, { onUnimplemented: "hresult" }),
        makeFunc("CoRevokeClassObject", 1, { onUnimplemented: "hresult" }),
        // Object lifecycle
        makeFunc("CoDisconnectObject", 2, { onUnimplemented: "hresult" }),
        makeFunc("OleRun", 1),
        // Storage
        makeFunc("StgCreateDocfile", 4),
        makeFunc("StgOpenStorage", 6),
        // Time
        makeFunc("CoFileTimeNow", 1, { onUnimplemented: "hresult" }),
        // String/GUID
        makeFunc("StringFromCLSID", 2),
        // Stream persistence
        makeFunc("OleSaveToStream", 2),
        makeFunc("OleLoadFromStream", 3),
        makeFunc("CreateStreamOnHGlobal", 3, { onUnimplemented: "hresult" }),

        // Auto-generated from reference signatures
        makeFunc("CoAddRefServerProcess", 0),
        makeFunc("CoAllowSetForegroundWindow", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoBuildVersion", 0),
        makeFunc("CoCopyProxy", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoCreateFreeThreadedMarshaler", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoDosDateTimeToFileTime", 3),
        makeFunc("CoFileTimeToDosDateTime", 3),
        makeFunc("CoFreeAllLibraries", 0),
        makeFunc("CoFreeLibrary", 1),
        makeFunc("CoFreeUnusedLibraries", 0),
        makeFunc("CoFreeUnusedLibrariesEx", 2),
        makeFunc("CoGetApartmentType", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoGetCallContext", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoGetClassObject", 5, { onUnimplemented: "hresult" }),
        makeFunc("CoGetCurrentLogicalThreadId", 1, { onUnimplemented: "hresult" }),
        makeFunc("CoGetCurrentProcess", 0),
        makeFunc("CoGetInterfaceAndReleaseStream", 3, { onUnimplemented: "hresult" }),
        makeFunc("CoGetMalloc", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoGetMarshalSizeMax", 6, { onUnimplemented: "hresult" }),
        makeFunc("CoGetObject", 4, { onUnimplemented: "hresult" }),
        makeFunc("CoGetObjectContext", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoGetPSClsid", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoGetStandardMarshal", 6, { onUnimplemented: "hresult" }),
        makeFunc("CoGetTreatAsClass", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoIsHandlerConnected", 1),
        makeFunc("CoIsOle1Class", 1),
        makeFunc("CoLoadLibrary", 2),
        makeFunc("CoLockObjectExternal", 3, { onUnimplemented: "hresult" }),
        makeFunc("CoMarshalHresult", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoMarshalInterface", 6, { onUnimplemented: "hresult" }),
        makeFunc("CoMarshalInterThreadInterfaceInStream", 3, { onUnimplemented: "hresult" }),
        makeFunc("CoQueryClientBlanket", 7, { onUnimplemented: "hresult" }),
        makeFunc("CoQueryProxyBlanket", 8, { onUnimplemented: "hresult" }),
        makeFunc("CoRegisterChannelHook", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoRegisterInitializeSpy", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoRegisterMallocSpy", 1, { onUnimplemented: "hresult" }),
        makeFunc("CoRegisterMessageFilter", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoRegisterPSClsid", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoReleaseServerProcess", 0),
        makeFunc("CoRevokeInitializeSpy", 1, { onUnimplemented: "hresult" }),
        makeFunc("CoRevokeMallocSpy", 0, { onUnimplemented: "hresult" }),
        makeFunc("CoSetProxyBlanket", 8, { onUnimplemented: "hresult" }),
        makeFunc("CoSwitchCallContext", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoTreatAsClass", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoUnmarshalHresult", 2, { onUnimplemented: "hresult" }),
        makeFunc("CoUnmarshalInterface", 3, { onUnimplemented: "hresult" }),
    ]
};
