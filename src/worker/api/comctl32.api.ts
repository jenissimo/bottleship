/**

 * COMCTL32.dll API descriptor.

 * Common Controls and ImageList helpers.

 */



import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";



const buildParams = (count: number): ParameterDescriptor[] => {

    const params: ParameterDescriptor[] = [];

    for (let i = 0; i < count; i++) {

        params.push({ name: `arg${i}`, type: "u32" });

    }

    return params;

};



const makeFunc = (

    name: string,

    argCount: number,

    overrides: Partial<FunctionDescriptor> = {}

): FunctionDescriptor => ({

    name,

    params: overrides.params ?? buildParams(argCount),

    returnType: overrides.returnType ?? "u32",

    callingConvention: overrides.callingConvention ?? "stdcall",

    ordinal: overrides.ordinal

});



/** Full ImageList export surface — games that bind comctl32 via GetProcAddress probe the whole set. */

const imageListFuncs = [

    makeFunc("ImageList_Create", 5),

    makeFunc("ImageList_Destroy", 1),

    makeFunc("ImageList_Add", 3),

    makeFunc("ImageList_AddIcon", 3),

    makeFunc("ImageList_AddMasked", 3),

    makeFunc("ImageList_Remove", 2),

    makeFunc("ImageList_Replace", 4),

    makeFunc("ImageList_ReplaceIcon", 3),

    makeFunc("ImageList_GetImageCount", 1),

    makeFunc("ImageList_SetImageCount", 2),

    makeFunc("ImageList_SetBkColor", 2),

    makeFunc("ImageList_GetBkColor", 1),

    makeFunc("ImageList_SetOverlayImage", 3),

    makeFunc("ImageList_SetIconSize", 3),

    makeFunc("ImageList_GetIconSize", 3),

    makeFunc("ImageList_GetIcon", 3),

    makeFunc("ImageList_Draw", 6),

    makeFunc("ImageList_DrawEx", 10),

    makeFunc("ImageList_DrawIndirect", 1),

    makeFunc("ImageList_Copy", 5),

    makeFunc("ImageList_Merge", 6),

    makeFunc("ImageList_Duplicate", 1),

    makeFunc("ImageList_GetImageInfo", 3),

    makeFunc("ImageList_LoadImage", 7),

    makeFunc("ImageList_LoadImageA", 7),

    makeFunc("ImageList_LoadImageW", 7),

    makeFunc("ImageList_Read", 1),

    makeFunc("ImageList_Write", 2),

    makeFunc("ImageList_ReadEx", 4),

    makeFunc("ImageList_WriteEx", 3),

    makeFunc("ImageList_BeginDrag", 4),

    makeFunc("ImageList_EndDrag", 0),

    makeFunc("ImageList_DragEnter", 3),

    makeFunc("ImageList_DragLeave", 1),

    makeFunc("ImageList_DragMove", 2),

    makeFunc("ImageList_DragShowNolock", 1),

    makeFunc("ImageList_SetDragCursorImage", 4),

    makeFunc("ImageList_GetDragImage", 2),

];



export const comctl32Module: ModuleDescriptor = {

    name: "comctl32",

    description: "Common Controls Library",

    functions: [

        makeFunc("InitCommonControls", 0, { ordinal: 17 }),

        makeFunc("InitCommonControlsEx", 1),

        // Ordinal import alias for InitCommonControls

        makeFunc("ord_17", 0, { ordinal: 17 }),



        ...imageListFuncs,



        makeFunc("_TrackMouseEvent", 1),

        makeFunc("TrackMouseEvent", 1),



        // Version query

        makeFunc("DllGetVersion", 1),



        // Property Sheet
        makeFunc("PropertySheetA", 1),
        makeFunc("PropertySheetW", 1),
        // The sheet frame's DLGPROC. Not a real comctl32 export — it exists so the
        // thunk generator hands out a code address for DWLP_DLGPROC (see propsheet.ts).
        makeFunc("PropertySheetDlgProc", 4),
        makeFunc("CreatePropertySheetPageA", 1),
        makeFunc("CreatePropertySheetPageW", 1),
        makeFunc("DestroyPropertySheetPage", 1),

        // Flat scroll bars (comctl32 v4.71+)
        makeFunc("InitializeFlatSB", 1),
        makeFunc("UninitializeFlatSB", 1),
        makeFunc("FlatSB_EnableScrollBar", 3),
        makeFunc("FlatSB_ShowScrollBar", 3),
        makeFunc("FlatSB_GetScrollRange", 4),
        makeFunc("FlatSB_SetScrollRange", 5),
        makeFunc("FlatSB_GetScrollPos", 2),
        makeFunc("FlatSB_SetScrollPos", 4),
        makeFunc("FlatSB_GetScrollInfo", 3),
        makeFunc("FlatSB_SetScrollInfo", 4),
        makeFunc("FlatSB_GetScrollProp", 3),
        makeFunc("FlatSB_SetScrollProp", 4),

    ],

};


