/**
 * D3DX9.dll API descriptor.
 * Versioned redist names (d3dx9_24 … d3dx9_43) alias to this module via dll-aliases.ts.
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

export const d3dx9Module: ModuleDescriptor = {
    name: "d3dx9",
    functions: [
        makeFunc("DebugSetMute", 1),
        makeFunc("D3DXDebugMute", 1),
        makeFunc("D3DXCheckVersion", 4),
        // System Shock 2 startup probes these via GetProcAddress after LoadLibrary.
        makeFunc("D3DXLoadSurfaceFromSurface", 8),
        makeFunc("D3DXCreateEffect", 9),
        makeFunc("D3DXFilterTexture", 4),
        makeFunc("D3DXPlaneIntersectLine", 4),
        makeFunc("D3DXTessellateNPatches", 7),
        makeFunc("D3DXSavePRTCompBufferToFileW", 3),
        makeFunc("D3DXMatrixIdentity", 1),
        makeFunc("D3DXMatrixMultiply", 3),
        makeFunc("D3DXMatrixTranslation", 4),
        makeFunc("D3DXMatrixRotationY", 2),
        makeFunc("D3DXMatrixPerspectiveFovLH", 5),
        makeFunc("D3DXMatrixLookAtLH", 4),
        makeFunc("D3DXVec3Normalize", 2),
        makeFunc("D3DXVec3TransformCoord", 3),
        makeFunc("D3DXCreateTextureFromFileA", 4),
        makeFunc("D3DXCreateTextureFromFileW", 4),
        makeFunc("D3DXCreateTextureFromFileInMemory", 5),
        makeFunc("D3DXCreateTextureFromFileExA", 14),
        makeFunc("D3DXCreateTextureFromFileExW", 14),
        makeFunc("D3DXCreateTextureFromFileInMemoryEx", 15),
        makeFunc("D3DXGetImageInfoFromFileA", 3),
        makeFunc("D3DXGetImageInfoFromFileW", 3),
        makeFunc("D3DXCreateFontA", 7, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateFontW", 7, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateFontIndirectA", 4, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateFontIndirectW", 4, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateSprite", 2, { onUnimplemented: "hresult" }),
        // D3D8→D3D9 wrappers resolve the assemble/disassemble pair by GetProcAddress and
        // translate every D3D8 shader through it (disassemble → patch text → assemble);
        // both hand back the ID3DXBuffer that D3DXCreateBuffer also produces.
        makeFunc("D3DXAssembleShader", 7),
        makeFunc("D3DXDisassembleShader", 4),
        makeFunc("D3DXCreateBuffer", 2),
    ],
};
