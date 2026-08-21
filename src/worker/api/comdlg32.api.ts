/**
 * COMDLG32.dll API descriptor.
 * Common Dialog Box Library - file open/save, print, find/replace text dialogs.
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
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const comdlg32Module: ModuleDescriptor = {
    name: "comdlg32",
    description: "Common Dialog Box Library",
    functions: [
        // File dialogs
        makeFunc("GetOpenFileNameA", 1),      // LPOPENFILENAMEA lpofn
        makeFunc("GetOpenFileNameW", 1),      // LPOPENFILENAMEW lpofn
        makeFunc("GetSaveFileNameA", 1),      // LPOPENFILENAMEA lpofn
        makeFunc("GetSaveFileNameW", 1),      // LPOPENFILENAMEW lpofn
        makeFunc("GetFileTitleA", 3),         // LPCSTR lpszFile, LPSTR lpszTitle, WORD cbBuf
        makeFunc("GetFileTitleW", 3),         // LPCWSTR lpszFile, LPWSTR lpszTitle, WORD cbBuf

        // Find/Replace dialogs
        makeFunc("FindTextA", 1),             // LPFINDREPLACEA lpfr
        makeFunc("FindTextW", 1),             // LPFINDREPLACEW lpfr
        makeFunc("ReplaceTextA", 1),          // LPFINDREPLACEA lpfr
        makeFunc("ReplaceTextW", 1),          // LPFINDREPLACEW lpfr

        // Print dialog
        makeFunc("PrintDlgA", 1),             // LPPRINTDLGA lppd
        makeFunc("PrintDlgW", 1),             // LPPRINTDLGW lppd
        makeFunc("PrintDlgExA", 1),           // LPPRINTDLGEXA lppd
        makeFunc("PrintDlgExW", 1),           // LPPRINTDLGEXW lppd

        // Color picker
        makeFunc("ChooseColorA", 1),          // LPCHOOSECOLORA lpcc
        makeFunc("ChooseColorW", 1),          // LPCHOOSECOLORW lpcc

        // Font picker
        makeFunc("ChooseFontA", 1),           // LPCHOOSEFONTA lpcf
        makeFunc("ChooseFontW", 1),           // LPCHOOSEFONTW lpcf

        // Error handling
        makeFunc("CommDlgExtendedError", 0),  // void - returns DWORD error code
    ],
};
