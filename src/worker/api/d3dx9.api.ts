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

/**
 * D3DX answers with an HRESULT almost everywhere, and the UNIMPLEMENTED default of zero IS
 * S_OK under that convention — a caller told its texture loaded reads an out-parameter nobody
 * filled. So every HRESULT entry point below declares its failure answer explicitly.
 */
export const d3dx9Module: ModuleDescriptor = {
    name: "d3dx9",
    functions: [
        makeFunc("DebugSetMute", 1),
        makeFunc("D3DXDebugMute", 1),
        makeFunc("D3DXCheckVersion", 2),
        // System Shock 2 startup probes these via GetProcAddress after LoadLibrary.
        makeFunc("D3DXLoadSurfaceFromSurface", 8, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateEffect", 9, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateEffectEx", 10, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateEffectFromFileA", 8, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateEffectFromFileW", 8, { onUnimplemented: "hresult" }),
        // The storage a `shared` effect parameter lives in. An engine with one effect per
        // material sets its globals through ONE effect and expects every other to see them.
        makeFunc("D3DXCreateEffectPool", 1, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateEffectFromFileExA", 9, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateEffectFromFileExW", 9, { onUnimplemented: "hresult" }),
        makeFunc("D3DXFilterTexture", 4, { onUnimplemented: "hresult" }),
        makeFunc("D3DXPlaneIntersectLine", 4),
        makeFunc("D3DXTessellateNPatches", 6, { onUnimplemented: "hresult" }),
        makeFunc("D3DXSavePRTCompBufferToFileW", 3, { onUnimplemented: "hresult" }),
        makeFunc("D3DXMatrixIdentity", 1),
        makeFunc("D3DXMatrixMultiply", 3),
        makeFunc("D3DXMatrixTranslation", 4),
        makeFunc("D3DXMatrixRotationY", 2),
        makeFunc("D3DXMatrixPerspectiveFovLH", 5),
        makeFunc("D3DXMatrixLookAtLH", 4),
        makeFunc("D3DXVec3Normalize", 2),
        makeFunc("D3DXVec3TransformCoord", 3),
        makeFunc("D3DXCreateTextureFromFileA", 3, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateTextureFromFileW", 3, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateTextureFromFileInMemory", 4, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateTextureFromFileExA", 14, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateTextureFromFileExW", 14, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateTextureFromFileInMemoryEx", 15, { onUnimplemented: "hresult" }),
        // Declared even where the body is not written yet: an undeclared import is not a stub
        // that returns an error, it is an IAT slot the guest calls into. Arg counts come from
        // the curated reference, so the RET N is right either way.
        makeFunc("D3DXCreateVolumeTextureFromFileInMemoryEx", 16, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateCubeTextureFromFileInMemoryEx", 14, { onUnimplemented: "hresult" }),
        makeFunc("D3DXLoadSurfaceFromMemory", 10, { onUnimplemented: "hresult" }),
        makeFunc("D3DXVec3CatmullRom", 6),
        makeFunc("D3DXGetImageInfoFromFileInMemory", 3, { onUnimplemented: "hresult" }),
        makeFunc("D3DXGetImageInfoFromFileA", 2, { onUnimplemented: "hresult" }),
        makeFunc("D3DXGetImageInfoFromFileW", 2, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateFontA", 12, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateFontW", 12, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateFontIndirectA", 3, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateFontIndirectW", 3, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateSprite", 2, { onUnimplemented: "hresult" }),
        // D3D8→D3D9 wrappers resolve the assemble/disassemble pair by GetProcAddress and
        // translate every D3D8 shader through it (disassemble → patch text → assemble);
        // both hand back the ID3DXBuffer that D3DXCreateBuffer also produces.
        makeFunc("D3DXAssembleShader", 7, { onUnimplemented: "hresult" }),
        makeFunc("D3DXDisassembleShader", 4, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCreateBuffer", 2, { onUnimplemented: "hresult" }),
        // Reflection over the CTAB block in compiled bytecode — on the path of every
        // SetMatrix/SetVector a title that ships precompiled shaders makes.
        makeFunc("D3DXGetShaderConstantTable", 2, { onUnimplemented: "hresult" }),
        makeFunc("D3DXGetShaderConstantTableEx", 3, { onUnimplemented: "hresult" }),
        // In/out sizing queries a title runs before CreateTexture and then trusts.
        makeFunc("D3DXCheckTextureRequirements", 7, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCheckCubeTextureRequirements", 6, { onUnimplemented: "hresult" }),
        makeFunc("D3DXCheckVolumeTextureRequirements", 8, { onUnimplemented: "hresult" }),
    ],
};
