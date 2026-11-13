import { ModuleDescriptor } from "./types";

export const oledlgModule: ModuleDescriptor = {
    name: "oledlg",
    description: "OLE User Interface Support",
    functions: [{
        name: "OleUIAddVerbMenuA",
        ordinal: 1,
        params: [
            { name: "lpOleObj", type: "ptr", direction: "in", optional: true },
            { name: "lpszShortType", type: "string", direction: "in", optional: true },
            { name: "hMenu", type: "handle", direction: "in" },
            { name: "uPos", type: "u32", direction: "in" },
            { name: "uIDVerbMin", type: "u32", direction: "in" },
            { name: "uIDVerbMax", type: "u32", direction: "in" },
            { name: "bAddConvert", type: "u32", direction: "in" },
            { name: "idConvert", type: "u32", direction: "in" },
            { name: "lphMenu", type: "ptr", direction: "out" },
        ],
        returnType: "u32", // BOOL
        callingConvention: "stdcall",
        description: "Add an IOleObject verb menu to an HMENU",
    },
    // Variadic exports use cdecl: the caller owns stack cleanup.
    ...(["OleUIPromptUserA", "OleUIPromptUserW"] as const).map((name) => ({
        name,
        params: [
            { name: "nTemplate", type: "i32" as const, direction: "in" as const },
            { name: "hwndParent", type: "handle" as const, direction: "in" as const },
        ],
        returnType: "i32" as const,
        callingConvention: "cdecl" as const,
        description: "Show an OLE prompt dialog built from a template resource",
    }))],
};
