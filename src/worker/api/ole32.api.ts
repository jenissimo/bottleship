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
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const ole32Module: ModuleDescriptor = {
    name: "ole32",
    functions: [
        makeFunc("CoInitialize", 1),
        makeFunc("CoInitializeEx", 2),
        makeFunc("CoUninitialize", 0),
        makeFunc("CoCreateInstance", 5),
        makeFunc("CoCreateGuid", 1),
        makeFunc("StringFromGUID2", 3),
        makeFunc("CLSIDFromString", 2),
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
        makeFunc("CoRegisterClassObject", 5),
        makeFunc("CoRevokeClassObject", 1),
        // Object lifecycle
        makeFunc("CoDisconnectObject", 2),
        makeFunc("OleRun", 1),
        // Storage
        makeFunc("StgCreateDocfile", 4),
        makeFunc("StgOpenStorage", 6),
        // Time
        makeFunc("CoFileTimeNow", 1),
        // String/GUID
        makeFunc("StringFromCLSID", 2),
        // Stream persistence
        makeFunc("OleSaveToStream", 2),
        makeFunc("OleLoadFromStream", 3),

        // Auto-generated from reference signatures
        makeFunc("CoAddRefServerProcess", 0),
        makeFunc("CoAllowSetForegroundWindow", 2),
        makeFunc("CoBuildVersion", 0),
        makeFunc("CoCopyProxy", 2),
        makeFunc("CoCreateFreeThreadedMarshaler", 2),
        makeFunc("CoDosDateTimeToFileTime", 3),
        makeFunc("CoFileTimeToDosDateTime", 3),
        makeFunc("CoFreeAllLibraries", 0),
        makeFunc("CoFreeLibrary", 1),
        makeFunc("CoFreeUnusedLibraries", 0),
        makeFunc("CoFreeUnusedLibrariesEx", 2),
        makeFunc("CoGetApartmentType", 2),
        makeFunc("CoGetCallContext", 2),
        makeFunc("CoGetClassObject", 5),
        makeFunc("CoGetCurrentLogicalThreadId", 1),
        makeFunc("CoGetCurrentProcess", 0),
        makeFunc("CoGetInterfaceAndReleaseStream", 3),
        makeFunc("CoGetMalloc", 2),
        makeFunc("CoGetMarshalSizeMax", 6),
        makeFunc("CoGetObject", 4),
        makeFunc("CoGetObjectContext", 2),
        makeFunc("CoGetPSClsid", 2),
        makeFunc("CoGetStandardMarshal", 6),
        makeFunc("CoGetTreatAsClass", 2),
        makeFunc("CoIsHandlerConnected", 1),
        makeFunc("CoIsOle1Class", 1),
        makeFunc("CoLoadLibrary", 2),
        makeFunc("CoLockObjectExternal", 3),
        makeFunc("CoMarshalHresult", 2),
        makeFunc("CoMarshalInterface", 6),
        makeFunc("CoMarshalInterThreadInterfaceInStream", 3),
        makeFunc("CoQueryClientBlanket", 7),
        makeFunc("CoQueryProxyBlanket", 8),
        makeFunc("CoRegisterChannelHook", 2),
        makeFunc("CoRegisterInitializeSpy", 2),
        makeFunc("CoRegisterMallocSpy", 1),
        makeFunc("CoRegisterMessageFilter", 2),
        makeFunc("CoRegisterPSClsid", 2),
        makeFunc("CoReleaseServerProcess", 0),
        makeFunc("CoRevokeInitializeSpy", 1),
        makeFunc("CoRevokeMallocSpy", 0),
        makeFunc("CoSetProxyBlanket", 8),
        makeFunc("CoSwitchCallContext", 2),
        makeFunc("CoTreatAsClass", 2),
        makeFunc("CoUnmarshalHresult", 2),
        makeFunc("CoUnmarshalInterface", 3),
    ]
};
