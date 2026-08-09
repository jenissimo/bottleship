/**
 * SHELL32.dll API descriptor.
 * ShellExecuteA — stub for PE import patching (e.g. "open URL" from games).
 */

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

export const shell32Module: ModuleDescriptor = {
    name: "shell32",
    functions: [
        makeFunc("ShellExecuteA", 6), // hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShowCmd
        makeFunc("ShellExecuteW", 6), // hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShowCmd
        makeFunc("ShellExecuteExA", 1), // lpExecInfo
        makeFunc("ShellExecuteExW", 1), // lpExecInfo
        makeFunc("Shell_NotifyIconA", 2), // dwMessage, lpData
        makeFunc("Shell_NotifyIconW", 2), // dwMessage, lpData
        makeFunc("DragQueryFileA", 4), // hDrop, iFile, lpszFile, cch
        makeFunc("DragQueryFileW", 4), // hDrop, iFile, lpszFile, cch
        makeFunc("DragFinish", 1), // hDrop
        makeFunc("FindExecutableA", 3), // lpFile, lpDirectory, lpResult
        makeFunc("SHGetSpecialFolderLocation", 3), // hwnd, csidl, ppidl
        makeFunc("SHGetPathFromIDListA", 2), // pidl, pszPath
        makeFunc("SHGetPathFromIDListW", 2), // pidl, pszPath
        makeFunc("SHGetSpecialFolderPathA", 4), // hwnd, pszPath, csidl, fCreate
        makeFunc("SHGetSpecialFolderPathW", 4), // hwnd, pszPath, csidl, fCreate
        makeFunc("SHAppBarMessage", 2), // dwMessage, pData
        makeFunc("SHGetFolderPathA", 5), // hwnd, csidl, hToken, dwFlags, pszPath
        makeFunc("SHGetFolderPathW", 5),
        makeFunc("SHGetKnownFolderPath", 4), // rfid, dwFlags, hToken, ppszPath
        makeFunc("CommandLineToArgvW", 2), // lpCmdLine, pNumArgs
        makeFunc("DragAcceptFiles", 2), // hWnd, fAccept
        makeFunc("IsUserAnAdmin", 0),
        makeFunc("SHBrowseForFolderA", 1),
        makeFunc("SHBrowseForFolderW", 1),
        makeFunc("SHGetDesktopFolder", 1),
        makeFunc("SHCreateDirectoryExA", 3),
        makeFunc("SHCreateDirectoryExW", 3),
        makeFunc("SHFileOperationA", 1),
        makeFunc("SHFileOperationW", 1),
        makeFunc("ExtractAssociatedIconA", 3),
        makeFunc("ExtractIconA", 3),
        makeFunc("ExtractIconW", 3),
        makeFunc("ExtractIconExA", 5),
        makeFunc("ExtractIconExW", 5),
    ],
};
