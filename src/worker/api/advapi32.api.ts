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

export const advapi32Module: ModuleDescriptor = {
    name: "advapi32",
    functions: [
        makeFunc("RegOpenKeyEx", 5, { onUnimplemented: "win32Status" }),
        makeFunc("RegOpenKeyExA", 5),
        makeFunc("RegOpenKeyExW", 5),
        makeFunc("RegOpenKeyA", 3),
        makeFunc("RegOpenKeyW", 3),
        makeFunc("RegOpenKeyTransactedA", 7),
        makeFunc("RegOpenKeyTransactedW", 7),
        makeFunc("RegQueryValueEx", 6, { onUnimplemented: "win32Status" }),
        makeFunc("RegQueryValueExA", 6),
        makeFunc("RegQueryValueExW", 6),
        makeFunc("RegGetValueA", 7),
        makeFunc("RegGetValueW", 7),
        makeFunc("RegCloseKey", 1),
        makeFunc("RegFlushKey", 1),
        makeFunc("RegSetValueExA", 6),
        makeFunc("RegSetValueExW", 6),
        makeFunc("RegCreateKeyA", 3),
        makeFunc("RegCreateKeyW", 3),
        makeFunc("RegCreateKeyExA", 9),
        makeFunc("RegCreateKeyExW", 9),
        makeFunc("RegCreateKeyTransactedA", 11),
        makeFunc("RegCreateKeyTransactedW", 11),
        makeFunc("RegDeleteKeyA", 2),
        makeFunc("RegDeleteKeyW", 2),
        makeFunc("RegDeleteValueA", 2),
        makeFunc("RegDeleteValueW", 2),
        makeFunc("RegQueryInfoKeyA", 12),
        makeFunc("RegQueryInfoKeyW", 12),
        makeFunc("RegEnumKeyExA", 8),
        makeFunc("RegEnumKeyExW", 8),
        makeFunc("RegEnumValueA", 8),
        makeFunc("RegEnumValueW", 8),
        makeFunc("OpenSCManagerA", 3),
        makeFunc("CreateServiceA", 13),
        makeFunc("OpenServiceA", 3),
        makeFunc("CloseServiceHandle", 1),
        // Service control/query set — copy-protection drivers (SafeDisc's drvmgt.dll)
        // install and poke a kernel service through these, and one missing name fails
        // the whole DLL's load.
        makeFunc("StartServiceA", 3),                  // hService, dwNumServiceArgs, lpServiceArgVectors
        makeFunc("ControlService", 3),                 // hService, dwControl, lpServiceStatus
        makeFunc("DeleteService", 1),
        makeFunc("QueryServiceStatus", 2),             // hService, lpServiceStatus
        makeFunc("QueryServiceConfigA", 4),            // hService, lpServiceConfig, cbBufSize, pcbBytesNeeded
        makeFunc("ChangeServiceConfigA", 11),          // hService, type, start, error, path, group, tagId, deps, user, pw, display
        makeFunc("QueryServiceObjectSecurity", 5),     // hService, si, lpSecurityDescriptor, cbBufSize, pcbBytesNeeded
        makeFunc("SetServiceObjectSecurity", 3),       // hService, si, lpSecurityDescriptor
        makeFunc("LockServiceDatabase", 1),
        makeFunc("UnlockServiceDatabase", 1),
        // RtlGenRandom, exported only under this name — the CRT and mod code use it as
        // the system entropy source.
        makeFunc("SystemFunction036", 2),    // pbBuffer, ulLen
        makeFunc("StartServiceCtrlDispatcherA", 1),
        makeFunc("RegisterServiceCtrlHandlerA", 2),
        makeFunc("SetServiceStatus", 2),
        makeFunc("GetUserNameA", 2),
        makeFunc("GetUserNameW", 2),
        makeFunc("AllocateAndInitializeSid", 11),
        makeFunc("FreeSid", 1),
        makeFunc("CheckTokenMembership", 3),
        makeFunc("InitializeAcl", 3),
        makeFunc("AddAccessAllowedAce", 4),
        makeFunc("AddAccessDeniedAce", 4),
        makeFunc("OpenProcessToken", 3),
        makeFunc("OpenThreadToken", 4),
        makeFunc("GetTokenInformation", 5),
        makeFunc("RegEnumKeyA", 4),
        makeFunc("RegQueryValueA", 4),
        makeFunc("SetNamedSecurityInfoA", 7),
        // CryptoAPI
        makeFunc("CryptAcquireContextA", 5),
        makeFunc("CryptReleaseContext", 2),
        makeFunc("CryptGenRandom", 3),
        makeFunc("CryptCreateHash", 5),
        makeFunc("CryptHashData", 4),
        makeFunc("CryptGetHashParam", 5),
        makeFunc("CryptEncrypt", 7),
        makeFunc("CryptImportKey", 6),
        makeFunc("CryptVerifySignatureA", 6),
        makeFunc("CryptDestroyHash", 1),
        makeFunc("CryptDestroyKey", 1),
        makeFunc("IsValidSid", 1),
        makeFunc("IsTextUnicode", 3),
        makeFunc("RegQueryValueW", 4, { onUnimplemented: "win32Status" }),
        makeFunc("RegEnumKeyW", 4, { onUnimplemented: "win32Status" }),
        makeFunc("RegDeleteKeyExA", 4, { onUnimplemented: "win32Status" }),
        makeFunc("RegDeleteKeyExW", 4, { onUnimplemented: "win32Status" }),
        makeFunc("RegSetValueA", 5),
        makeFunc("RegSetValueW", 5),
        makeFunc("SetNamedSecurityInfoW", 7, { onUnimplemented: "win32Status" }),
        makeFunc("OpenSCManagerW", 3),
        makeFunc("OpenServiceW", 3),
        makeFunc("CryptAcquireContextW", 5, { onUnimplemented: "zero" }),
        makeFunc("CryptVerifySignatureW", 6),
        makeFunc("LookupAccountSidA", 7),
        makeFunc("LookupAccountSidW", 7),
        makeFunc("LookupPrivilegeValueA", 3),
        makeFunc("LookupPrivilegeValueW", 3),
        makeFunc("AdjustTokenPrivileges", 6),
        makeFunc("EqualSid", 2),
        makeFunc("CopySid", 3),
        makeFunc("GetLengthSid", 1),
        makeFunc("GetSidSubAuthority", 2),
        makeFunc("GetSidSubAuthorityCount", 1),
        makeFunc("InitializeSecurityDescriptor", 2),
        makeFunc("SetSecurityDescriptorDacl", 4),

        // Auto-generated from reference signatures
        makeFunc("ConvertFiberToThread", 0),
        makeFunc("RegisterApplicationRecoveryCallback", 4, { onUnimplemented: "hresult" }),
        makeFunc("RegisterApplicationRestart", 2, { onUnimplemented: "hresult" }),
        makeFunc("RegisterEventSourceA", 2, { onUnimplemented: "zero" }),
        makeFunc("RegisterEventSourceW", 2),
        makeFunc("RegisterWaitForSingleObject", 6),
        makeFunc("RegisterWaitForSingleObjectEx", 5),
    ]
};
