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
    }],
};
