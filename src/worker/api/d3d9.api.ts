/**
 * D3D9 API Descriptor
 *
 * Describes the Direct3D 9 API for code generation.
 * This is a pilot implementation - the first module to use the descriptor system.
 */

import {
    ModuleDescriptor,
    InterfaceDescriptor,
    FunctionDescriptor,
    ParameterDescriptor,
    IUnknown,
} from "./types";

// D3D9 Constants
export const D3D9_CONSTANTS = {
    D3D_OK: 0,
    D3DERR_INVALIDCALL: 0x8876086c,
    D3DERR_NOTFOUND: 0x88760866,
    D3DERR_DEVICELOST: 0x88760868,
    /** MAKE_D3DHRESULT(2153) — a device exists again; release D3DPOOL_DEFAULT and Reset(). */
    D3DERR_DEVICENOTRESET: 0x88760869,

    // Primitive types
    D3DPT_POINTLIST: 1,
    D3DPT_LINELIST: 2,
    D3DPT_LINESTRIP: 3,
    D3DPT_TRIANGLELIST: 4,
    D3DPT_TRIANGLESTRIP: 5,
    D3DPT_TRIANGLEFAN: 6,

    // FVF flags
    D3DFVF_XYZ: 0x002,
    D3DFVF_XYZRHW: 0x004,
    D3DFVF_DIFFUSE: 0x040,
    D3DFVF_TEX1: 0x100,

    // Render states
    D3DRS_ZENABLE: 7,
    D3DRS_ZWRITEENABLE: 14,
    D3DRS_CULLMODE: 22,
    D3DRS_ALPHABLENDENABLE: 27,
    D3DRS_SRCBLEND: 19,
    D3DRS_DESTBLEND: 20,
    D3DRS_LIGHTING: 137,

    // Transform states
    D3DTS_WORLD: 0x100,
    D3DTS_VIEW: 2,
    D3DTS_PROJECTION: 3,

    // Index formats
    D3DFMT_INDEX16: 101,
    D3DFMT_INDEX32: 102,
};

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: i === 0 ? "this" : `arg${i}`, type: i === 0 ? "ptr" : "u32" });
    }
    return params;
};

const makeMethod = (
    name: string,
    argCount: number,
    overrides: Partial<FunctionDescriptor> = {}
): FunctionDescriptor => ({
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
    async: overrides.async,
    category: overrides.category,
    description: overrides.description,
});

// IDirect3D9 interface
export const IDirect3D9: InterfaceDescriptor = {
    name: "IDirect3D9",
    inherits: "IUnknown",
    iid: "81BDCBCA-64D4-426d-AE8D-AD0147F4275C",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        {
            name: "RegisterSoftwareDevice",
            params: [
                { name: "this", type: "ptr" },
                { name: "pInitializeFunction", type: "ptr" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "GetAdapterCount",
            params: [{ name: "this", type: "ptr" }],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "GetAdapterIdentifier",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "Flags", type: "u32" },
                { name: "pIdentifier", type: "ptr", direction: "out" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "GetAdapterModeCount",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "Format", type: "u32" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "EnumAdapterModes",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "Format", type: "u32" },
                { name: "Mode", type: "u32" },
                { name: "pMode", type: "ptr", direction: "out" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "GetAdapterDisplayMode",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "pMode", type: "ptr", direction: "out" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "CheckDeviceType",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "DevType", type: "u32" },
                { name: "AdapterFormat", type: "u32" },
                { name: "BackBufferFormat", type: "u32" },
                { name: "bWindowed", type: "u32" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "CheckDeviceFormat",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "DeviceType", type: "u32" },
                { name: "AdapterFormat", type: "u32" },
                { name: "Usage", type: "u32" },
                { name: "RType", type: "u32" },
                { name: "CheckFormat", type: "u32" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "CheckDeviceMultiSampleType",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "DeviceType", type: "u32" },
                { name: "SurfaceFormat", type: "u32" },
                { name: "Windowed", type: "u32" },
                { name: "MultiSampleType", type: "u32" },
                { name: "pQualityLevels", type: "ptr", direction: "out" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "CheckDepthStencilMatch",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "DeviceType", type: "u32" },
                { name: "AdapterFormat", type: "u32" },
                { name: "RenderTargetFormat", type: "u32" },
                { name: "DepthStencilFormat", type: "u32" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "CheckDeviceFormatConversion",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "DeviceType", type: "u32" },
                { name: "SourceFormat", type: "u32" },
                { name: "TargetFormat", type: "u32" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "GetDeviceCaps",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "DeviceType", type: "u32" },
                { name: "pCaps", type: "ptr", direction: "out" }
            ],
            returnType: "u32",
            callingConvention: "stdcall"
        },
        {
            name: "GetAdapterMonitor",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" }
            ],
            returnType: "handle",
            callingConvention: "stdcall"
        },
        {
            name: "CreateDevice",
            params: [
                { name: "this", type: "ptr" },
                { name: "Adapter", type: "u32" },
                { name: "DeviceType", type: "u32" },
                { name: "hFocusWindow", type: "handle" },
                { name: "BehaviorFlags", type: "u32" },
                { name: "pPresentationParameters", type: "ptr" },
                { name: "ppReturnedDeviceInterface", type: "ptr", direction: "out" }
            ],
            returnType: "u32",
            callingConvention: "stdcall",
            async: true,
            category: "device"
        }
    ]
};

/*
 * D3D9Ex keeps the complete IDirect3D9 prefix and appends five methods.  The
 * descriptor generator intentionally does not expand `inherits`, so spell the
 * prefix out here.  This is ABI-significant: handing an Ex caller a shorter
 * base vtable makes every Ex call after CreateDevice read the wrong slot.
 */
const d3d9ExMethods: FunctionDescriptor[] = [
    {
        name: "GetAdapterModeCountEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "Adapter", type: "u32" },
            { name: "pFilter", type: "ptr", optional: true },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
    {
        name: "EnumAdapterModesEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "Adapter", type: "u32" },
            { name: "pFilter", type: "ptr", optional: true },
            { name: "Mode", type: "u32" },
            { name: "pMode", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
    {
        name: "GetAdapterDisplayModeEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "Adapter", type: "u32" },
            { name: "pMode", type: "ptr", direction: "out" },
            { name: "pRotation", type: "ptr", direction: "out", optional: true },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
    {
        name: "CreateDeviceEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "Adapter", type: "u32" },
            { name: "DeviceType", type: "u32" },
            { name: "hFocusWindow", type: "handle" },
            { name: "BehaviorFlags", type: "u32" },
            { name: "pPresentationParameters", type: "ptr" },
            { name: "pFullscreenDisplayMode", type: "ptr", optional: true },
            { name: "ppReturnedDeviceInterface", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        async: true,
        category: "device",
    },
    {
        name: "GetAdapterLUID",
        params: [
            { name: "this", type: "ptr" },
            { name: "Adapter", type: "u32" },
            { name: "pLUID", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
];

export const IDirect3D9Ex: InterfaceDescriptor = {
    name: "IDirect3D9Ex",
    inherits: "IDirect3D9",
    iid: "02177241-69FC-400C-8FF1-93A44DF6861D",
    methods: [...IDirect3D9.methods, ...d3d9ExMethods],
};

const deviceMethodOverrides: Record<string, FunctionDescriptor> = {
    Present: {
        name: "Present",
        params: [
            { name: "this", type: "ptr" },
            { name: "pSourceRect", type: "ptr", optional: true },
            { name: "pDestRect", type: "ptr", optional: true },
            { name: "hDestWindowOverride", type: "handle", optional: true },
            { name: "pDirtyRegion", type: "ptr", optional: true },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        async: true,
        category: "present",
    },
    CreateVertexBuffer: {
        name: "CreateVertexBuffer",
        params: [
            { name: "this", type: "ptr" },
            { name: "Length", type: "u32" },
            { name: "Usage", type: "u32" },
            { name: "FVF", type: "u32" },
            { name: "Pool", type: "u32" },
            { name: "ppVertexBuffer", type: "ptr", direction: "out" },
            { name: "pSharedHandle", type: "ptr", optional: true },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "resource",
    },
    CreateIndexBuffer: {
        name: "CreateIndexBuffer",
        params: [
            { name: "this", type: "ptr" },
            { name: "Length", type: "u32" },
            { name: "Usage", type: "u32" },
            { name: "Format", type: "u32" },
            { name: "Pool", type: "u32" },
            { name: "ppIndexBuffer", type: "ptr", direction: "out" },
            { name: "pSharedHandle", type: "ptr", optional: true },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "resource",
    },
    CreateTexture: {
        name: "CreateTexture",
        params: [
            { name: "this", type: "ptr" },
            { name: "Width", type: "u32" },
            { name: "Height", type: "u32" },
            { name: "Levels", type: "u32" },
            { name: "Usage", type: "u32" },
            { name: "Format", type: "u32" },
            { name: "Pool", type: "u32" },
            { name: "ppTexture", type: "ptr", direction: "out" },
            { name: "pSharedHandle", type: "ptr", optional: true },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "resource",
    },
    SetRenderState: {
        name: "SetRenderState",
        params: [
            { name: "this", type: "ptr" },
            { name: "State", type: "u32" },
            { name: "Value", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "state",
    },
    SetTransform: {
        name: "SetTransform",
        params: [
            { name: "this", type: "ptr" },
            { name: "State", type: "u32" },
            { name: "pMatrix", type: "ptr" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "state",
    },
    SetFVF: {
        name: "SetFVF",
        params: [
            { name: "this", type: "ptr" },
            { name: "FVF", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "state",
    },
    SetStreamSource: {
        name: "SetStreamSource",
        params: [
            { name: "this", type: "ptr" },
            { name: "StreamNumber", type: "u32" },
            { name: "pStreamData", type: "ptr" },
            { name: "OffsetInBytes", type: "u32" },
            { name: "Stride", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "state",
    },
    SetIndices: {
        name: "SetIndices",
        params: [
            { name: "this", type: "ptr" },
            { name: "pIndexData", type: "ptr" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "state",
    },
    SetTexture: {
        name: "SetTexture",
        params: [
            { name: "this", type: "ptr" },
            { name: "Stage", type: "u32" },
            { name: "pTexture", type: "ptr" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "state",
    },
    Clear: {
        name: "Clear",
        params: [
            { name: "this", type: "ptr" },
            { name: "Count", type: "u32" },
            { name: "pRects", type: "ptr", optional: true },
            { name: "Flags", type: "u32" },
            { name: "Color", type: "u32" },
            { name: "Z", type: "f32" },
            { name: "Stencil", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "draw",
    },
    BeginScene: {
        name: "BeginScene",
        params: [{ name: "this", type: "ptr" }],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "draw",
    },
    EndScene: {
        name: "EndScene",
        params: [{ name: "this", type: "ptr" }],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "draw",
    },
    DrawPrimitive: {
        name: "DrawPrimitive",
        params: [
            { name: "this", type: "ptr" },
            { name: "PrimitiveType", type: "u32" },
            { name: "StartVertex", type: "u32" },
            { name: "PrimitiveCount", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "draw",
    },
    DrawIndexedPrimitive: {
        name: "DrawIndexedPrimitive",
        params: [
            { name: "this", type: "ptr" },
            { name: "PrimitiveType", type: "u32" },
            { name: "BaseVertexIndex", type: "i32" },
            { name: "MinVertexIndex", type: "u32" },
            { name: "NumVertices", type: "u32" },
            { name: "StartIndex", type: "u32" },
            { name: "PrimitiveCount", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "draw",
    },
};

const deviceMethodSpecs = [
    { name: "TestCooperativeLevel", args: 1 },
    { name: "GetAvailableTextureMem", args: 1 },
    { name: "EvictManagedResources", args: 1 },
    { name: "GetDirect3D", args: 2 },
    { name: "GetDeviceCaps", args: 2 },
    { name: "GetDisplayMode", args: 3 },
    { name: "GetCreationParameters", args: 2 },
    { name: "SetCursorProperties", args: 4 },
    { name: "SetCursorPosition", args: 4 },
    { name: "ShowCursor", args: 2 },
    { name: "CreateAdditionalSwapChain", args: 3 },
    { name: "GetSwapChain", args: 3 },
    { name: "GetNumberOfSwapChains", args: 1 },
    { name: "Reset", args: 2 },
    { name: "Present", args: 5 },
    { name: "GetBackBuffer", args: 5 },
    { name: "GetRasterStatus", args: 3 },
    { name: "SetDialogBoxMode", args: 2 },
    { name: "SetGammaRamp", args: 4 },
    { name: "GetGammaRamp", args: 3 },
    { name: "CreateTexture", args: 9 },
    { name: "CreateVolumeTexture", args: 10 },
    { name: "CreateCubeTexture", args: 8 },
    { name: "CreateVertexBuffer", args: 7 },
    { name: "CreateIndexBuffer", args: 7 },
    { name: "CreateRenderTarget", args: 9 },
    { name: "CreateDepthStencilSurface", args: 9 },
    { name: "UpdateSurface", args: 5 },
    { name: "UpdateTexture", args: 3 },
    { name: "GetRenderTargetData", args: 3 },
    { name: "GetFrontBufferData", args: 3 },
    { name: "StretchRect", args: 6 },
    { name: "ColorFill", args: 4 },
    { name: "CreateOffscreenPlainSurface", args: 7 },
    { name: "SetRenderTarget", args: 3 },
    { name: "GetRenderTarget", args: 3 },
    { name: "SetDepthStencilSurface", args: 2 },
    { name: "GetDepthStencilSurface", args: 2 },
    { name: "BeginScene", args: 1 },
    { name: "EndScene", args: 1 },
    { name: "Clear", args: 7 },
    { name: "SetTransform", args: 3 },
    { name: "GetTransform", args: 3 },
    { name: "MultiplyTransform", args: 3 },
    { name: "SetViewport", args: 2 },
    { name: "GetViewport", args: 2 },
    { name: "SetMaterial", args: 2 },
    { name: "GetMaterial", args: 2 },
    { name: "SetLight", args: 3 },
    { name: "GetLight", args: 3 },
    { name: "LightEnable", args: 3 },
    { name: "GetLightEnable", args: 3 },
    { name: "SetClipPlane", args: 3 },
    { name: "GetClipPlane", args: 3 },
    { name: "SetRenderState", args: 3 },
    { name: "GetRenderState", args: 3 },
    { name: "CreateStateBlock", args: 3 },
    { name: "BeginStateBlock", args: 1 },
    { name: "EndStateBlock", args: 2 },
    { name: "SetClipStatus", args: 2 },
    { name: "GetClipStatus", args: 2 },
    { name: "GetTexture", args: 3 },
    { name: "SetTexture", args: 3 },
    { name: "GetTextureStageState", args: 4 },
    { name: "SetTextureStageState", args: 4 },
    { name: "GetSamplerState", args: 4 },
    { name: "SetSamplerState", args: 4 },
    { name: "ValidateDevice", args: 2 },
    { name: "SetPaletteEntries", args: 3 },
    { name: "GetPaletteEntries", args: 3 },
    { name: "SetCurrentTexturePalette", args: 2 },
    { name: "GetCurrentTexturePalette", args: 2 },
    { name: "SetScissorRect", args: 2 },
    { name: "GetScissorRect", args: 2 },
    { name: "SetSoftwareVertexProcessing", args: 2 },
    { name: "GetSoftwareVertexProcessing", args: 1 },
    { name: "SetNPatchMode", args: 2 },
    { name: "GetNPatchMode", args: 1 },
    { name: "DrawPrimitive", args: 4 },
    { name: "DrawIndexedPrimitive", args: 7 },
    { name: "DrawPrimitiveUP", args: 5 },
    { name: "DrawIndexedPrimitiveUP", args: 9 },
    { name: "ProcessVertices", args: 7 },
    { name: "CreateVertexDeclaration", args: 3 },
    { name: "SetVertexDeclaration", args: 2 },
    { name: "GetVertexDeclaration", args: 2 },
    { name: "SetFVF", args: 2 },
    { name: "GetFVF", args: 2 },
    { name: "CreateVertexShader", args: 3 },
    { name: "SetVertexShader", args: 2 },
    { name: "GetVertexShader", args: 2 },
    { name: "SetVertexShaderConstantF", args: 4 },
    { name: "GetVertexShaderConstantF", args: 4 },
    { name: "SetVertexShaderConstantI", args: 4 },
    { name: "GetVertexShaderConstantI", args: 4 },
    { name: "SetVertexShaderConstantB", args: 4 },
    { name: "GetVertexShaderConstantB", args: 4 },
    { name: "SetStreamSource", args: 5 },
    { name: "GetStreamSource", args: 5 },
    { name: "SetStreamSourceFreq", args: 3 },
    { name: "GetStreamSourceFreq", args: 3 },
    { name: "SetIndices", args: 2 },
    { name: "GetIndices", args: 2 },
    { name: "CreatePixelShader", args: 3 },
    { name: "SetPixelShader", args: 2 },
    { name: "GetPixelShader", args: 2 },
    { name: "SetPixelShaderConstantF", args: 4 },
    { name: "GetPixelShaderConstantF", args: 4 },
    { name: "SetPixelShaderConstantI", args: 4 },
    { name: "GetPixelShaderConstantI", args: 4 },
    { name: "SetPixelShaderConstantB", args: 4 },
    { name: "GetPixelShaderConstantB", args: 4 },
    { name: "DrawRectPatch", args: 4 },
    { name: "DrawTriPatch", args: 4 },
    { name: "DeletePatch", args: 2 },
    { name: "CreateQuery", args: 3 },
];

const deviceMethods = deviceMethodSpecs.map((spec) =>
    deviceMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

// IDirect3DDevice9 interface
export const IDirect3DDevice9: InterfaceDescriptor = {
    name: "IDirect3DDevice9",
    inherits: "IUnknown",
    iid: "D0223B96-BF7A-43fd-92BD-A43B0D82B9EB",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...deviceMethods,
    ]
};

/* IDirect3DDevice9Ex is an append-only extension of IDirect3DDevice9.  Keep
 * this list in the exact order from d3d9.h; these are vtable slots, not a
 * discoverable name lookup. */
const d3dDevice9ExMethods: FunctionDescriptor[] = [
    {
        name: "SetConvolutionMonoKernel",
        params: [
            { name: "this", type: "ptr" },
            { name: "width", type: "u32" },
            { name: "height", type: "u32" },
            { name: "rows", type: "ptr" },
            { name: "columns", type: "ptr" },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "ComposeRects",
        params: [
            { name: "this", type: "ptr" },
            { name: "pSrc", type: "ptr" },
            { name: "pDst", type: "ptr" },
            { name: "pSrcRectDescs", type: "ptr" },
            { name: "NumRects", type: "u32" },
            { name: "pDstRectDescs", type: "ptr" },
            { name: "Operation", type: "u32" },
            { name: "Xoffset", type: "i32" },
            { name: "Yoffset", type: "i32" },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "PresentEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "pSourceRect", type: "ptr", optional: true },
            { name: "pDestRect", type: "ptr", optional: true },
            { name: "hDestWindowOverride", type: "handle", optional: true },
            { name: "pDirtyRegion", type: "ptr", optional: true },
            { name: "dwFlags", type: "u32" },
        ],
        returnType: "u32", callingConvention: "stdcall", async: true, category: "present",
    },
    {
        name: "GetGPUThreadPriority",
        params: [{ name: "this", type: "ptr" }, { name: "pPriority", type: "ptr", direction: "out" }],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "SetGPUThreadPriority",
        params: [{ name: "this", type: "ptr" }, { name: "Priority", type: "i32" }],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "WaitForVBlank",
        params: [{ name: "this", type: "ptr" }, { name: "iSwapChain", type: "u32" }],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "CheckResourceResidency",
        params: [
            { name: "this", type: "ptr" },
            { name: "pResourceArray", type: "ptr" },
            { name: "NumResources", type: "u32" },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "SetMaximumFrameLatency",
        params: [{ name: "this", type: "ptr" }, { name: "MaxLatency", type: "u32" }],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "GetMaximumFrameLatency",
        params: [{ name: "this", type: "ptr" }, { name: "pMaxLatency", type: "ptr", direction: "out" }],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "CheckDeviceState",
        params: [{ name: "this", type: "ptr" }, { name: "hDestinationWindow", type: "handle", optional: true }],
        returnType: "u32", callingConvention: "stdcall",
    },
    {
        name: "CreateRenderTargetEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "Width", type: "u32" }, { name: "Height", type: "u32" },
            { name: "Format", type: "u32" }, { name: "MultiSample", type: "u32" },
            { name: "MultisampleQuality", type: "u32" }, { name: "Lockable", type: "u32" },
            { name: "ppSurface", type: "ptr", direction: "out" },
            { name: "pSharedHandle", type: "ptr", direction: "out", optional: true },
            { name: "Usage", type: "u32" },
        ],
        returnType: "u32", callingConvention: "stdcall", category: "resource",
    },
    {
        name: "CreateOffscreenPlainSurfaceEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "Width", type: "u32" }, { name: "Height", type: "u32" },
            { name: "Format", type: "u32" }, { name: "Pool", type: "u32" },
            { name: "ppSurface", type: "ptr", direction: "out" },
            { name: "pSharedHandle", type: "ptr", direction: "out", optional: true },
            { name: "Usage", type: "u32" },
        ],
        returnType: "u32", callingConvention: "stdcall", category: "resource",
    },
    {
        name: "CreateDepthStencilSurfaceEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "Width", type: "u32" }, { name: "Height", type: "u32" },
            { name: "Format", type: "u32" }, { name: "MultiSample", type: "u32" },
            { name: "MultisampleQuality", type: "u32" }, { name: "Discard", type: "u32" },
            { name: "ppSurface", type: "ptr", direction: "out" },
            { name: "pSharedHandle", type: "ptr", direction: "out", optional: true },
            { name: "Usage", type: "u32" },
        ],
        returnType: "u32", callingConvention: "stdcall", category: "resource",
    },
    {
        name: "ResetEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "pPresentationParameters", type: "ptr" },
            { name: "pFullscreenDisplayMode", type: "ptr", optional: true },
        ],
        returnType: "u32", callingConvention: "stdcall", category: "device",
    },
    {
        name: "GetDisplayModeEx",
        params: [
            { name: "this", type: "ptr" },
            { name: "iSwapChain", type: "u32" },
            { name: "pMode", type: "ptr", direction: "out" },
            { name: "pRotation", type: "ptr", direction: "out", optional: true },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
];

export const IDirect3DDevice9Ex: InterfaceDescriptor = {
    name: "IDirect3DDevice9Ex",
    inherits: "IDirect3DDevice9",
    iid: "B18B10CE-2649-405A-870F-95F777D4313A",
    methods: [...IDirect3DDevice9.methods, ...d3dDevice9ExMethods],
};

const vertexBufferMethodOverrides: Record<string, FunctionDescriptor> = {
    GetDevice: {
        name: "GetDevice",
        params: [
            { name: "this", type: "ptr" },
            { name: "ppDevice", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
    Lock: {
        name: "Lock",
        params: [
            { name: "this", type: "ptr" },
            { name: "OffsetToLock", type: "u32" },
            { name: "SizeToLock", type: "u32" },
            { name: "ppbData", type: "ptr", direction: "out" },
            { name: "Flags", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "lock",
    },
    Unlock: {
        name: "Unlock",
        params: [{ name: "this", type: "ptr" }],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "lock",
    },
    GetDesc: {
        name: "GetDesc",
        params: [
            { name: "this", type: "ptr" },
            { name: "pDesc", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
};

const vertexBufferMethodSpecs = [
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    { name: "Lock", args: 5 },
    { name: "Unlock", args: 1 },
    { name: "GetDesc", args: 2 },
];

// IDirect3DResource9::PreLoad is STDMETHOD_(void), not an HRESULT.  Keeping
// the correct return ABI matters to callers that use a hand-written vtable
// declaration (the thunk still accepts the `this` argument and pops the same
// stack; only the return register is intentionally ignored).
const resourceMethodOverrides: Record<string, FunctionDescriptor> = {
    PreLoad: makeMethod("PreLoad", 1, { returnType: "void" }),
};

const vertexBufferMethods = vertexBufferMethodSpecs.map((spec) =>
    vertexBufferMethodOverrides[spec.name] ?? resourceMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

// IDirect3DVertexBuffer9 interface
export const IDirect3DVertexBuffer9: InterfaceDescriptor = {
    name: "IDirect3DVertexBuffer9",
    inherits: "IDirect3DResource9",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...vertexBufferMethods,
    ]
};

const indexBufferMethodOverrides: Record<string, FunctionDescriptor> = {
    GetDevice: {
        name: "GetDevice",
        params: [
            { name: "this", type: "ptr" },
            { name: "ppDevice", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
    Lock: {
        name: "Lock",
        params: [
            { name: "this", type: "ptr" },
            { name: "OffsetToLock", type: "u32" },
            { name: "SizeToLock", type: "u32" },
            { name: "ppbData", type: "ptr", direction: "out" },
            { name: "Flags", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "lock",
    },
    Unlock: {
        name: "Unlock",
        params: [{ name: "this", type: "ptr" }],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "lock",
    },
    GetDesc: {
        name: "GetDesc",
        params: [
            { name: "this", type: "ptr" },
            { name: "pDesc", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
};

const indexBufferMethodSpecs = [
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    { name: "Lock", args: 5 },
    { name: "Unlock", args: 1 },
    { name: "GetDesc", args: 2 },
];

const indexBufferMethods = indexBufferMethodSpecs.map((spec) =>
    indexBufferMethodOverrides[spec.name] ?? resourceMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

// IDirect3DIndexBuffer9 interface
export const IDirect3DIndexBuffer9: InterfaceDescriptor = {
    name: "IDirect3DIndexBuffer9",
    inherits: "IDirect3DResource9",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...indexBufferMethods,
    ]
};

const textureMethodOverrides: Record<string, FunctionDescriptor> = {
    GetDevice: {
        name: "GetDevice",
        params: [
            { name: "this", type: "ptr" },
            { name: "ppDevice", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
    LockRect: {
        name: "LockRect",
        params: [
            { name: "this", type: "ptr" },
            { name: "Level", type: "u32" },
            { name: "pLockedRect", type: "ptr", direction: "out" },
            { name: "pRect", type: "ptr", optional: true },
            { name: "Flags", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "lock",
    },
    UnlockRect: {
        name: "UnlockRect",
        params: [
            { name: "this", type: "ptr" },
            { name: "Level", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "lock",
    },
};

const textureMethodSpecs = [
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    { name: "SetLOD", args: 2 },
    { name: "GetLOD", args: 1 },
    { name: "GetLevelCount", args: 1 },
    { name: "SetAutoGenFilterType", args: 2 },
    { name: "GetAutoGenFilterType", args: 1 },
    { name: "GenerateMipSubLevels", args: 1 },
    { name: "GetLevelDesc", args: 3 },
    { name: "GetSurfaceLevel", args: 3 },
    { name: "LockRect", args: 5 },
    { name: "UnlockRect", args: 2 },
    { name: "AddDirtyRect", args: 2 },
];

const textureMethods = textureMethodSpecs.map((spec) =>
    textureMethodOverrides[spec.name] ?? resourceMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

// IDirect3DTexture9 interface
export const IDirect3DTexture9: InterfaceDescriptor = {
    name: "IDirect3DTexture9",
    inherits: "IDirect3DBaseTexture9",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...textureMethods,
    ]
};

// IDirect3DCubeTexture9 — same IDirect3DBaseTexture9 vtable as IDirect3DTexture9,
// but the per-image accessors take a CubeMapFace selector: GetCubeMapSurface
// (replaces GetSurfaceLevel), and LockRect/UnlockRect/AddDirtyRect gain a FaceType
// arg. Used for environment/reflection cube maps (e.g. NFSU car reflections).
const cubeMethodOverrides: Record<string, FunctionDescriptor> = {
    GetDevice: textureMethodOverrides.GetDevice,
    LockRect: {
        name: "LockRect",
        params: [
            { name: "this", type: "ptr" },
            { name: "FaceType", type: "u32" },
            { name: "Level", type: "u32" },
            { name: "pLockedRect", type: "ptr", direction: "out" },
            { name: "pRect", type: "ptr", optional: true },
            { name: "Flags", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "lock",
    },
    UnlockRect: {
        name: "UnlockRect",
        params: [
            { name: "this", type: "ptr" },
            { name: "FaceType", type: "u32" },
            { name: "Level", type: "u32" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
        category: "lock",
    },
};

const cubeMethodSpecs = [
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    { name: "SetLOD", args: 2 },
    { name: "GetLOD", args: 1 },
    { name: "GetLevelCount", args: 1 },
    { name: "SetAutoGenFilterType", args: 2 },
    { name: "GetAutoGenFilterType", args: 1 },
    { name: "GenerateMipSubLevels", args: 1 },
    { name: "GetLevelDesc", args: 3 },
    { name: "GetCubeMapSurface", args: 4 },
    { name: "LockRect", args: 6 },
    { name: "UnlockRect", args: 3 },
    { name: "AddDirtyRect", args: 3 },
];

const cubeMethods = cubeMethodSpecs.map((spec) =>
    cubeMethodOverrides[spec.name] ?? resourceMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

export const IDirect3DCubeTexture9: InterfaceDescriptor = {
    name: "IDirect3DCubeTexture9",
    inherits: "IDirect3DBaseTexture9",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...cubeMethods,
    ]
};

// IDirect3DVolumeTexture9 — IDirect3DBaseTexture9 prefix followed by the
// volume-specific mip/LockBox accessors.  Keep the prefix explicit, as the
// descriptor generator does not expand `inherits` into vtable slots.
const volumeTextureMethodOverrides: Record<string, FunctionDescriptor> = {
    GetDevice: textureMethodOverrides.GetDevice,
    GetLevelDesc: {
        name: "GetLevelDesc",
        params: [
            { name: "this", type: "ptr" },
            { name: "Level", type: "u32" },
            { name: "pDesc", type: "ptr", direction: "out" },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
    GetVolumeLevel: {
        name: "GetVolumeLevel",
        params: [
            { name: "this", type: "ptr" },
            { name: "Level", type: "u32" },
            { name: "ppVolumeLevel", type: "ptr", direction: "out" },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
    LockBox: {
        name: "LockBox",
        params: [
            { name: "this", type: "ptr" },
            { name: "Level", type: "u32" },
            { name: "pLockedVolume", type: "ptr", direction: "out" },
            { name: "pBox", type: "ptr", optional: true },
            { name: "Flags", type: "u32" },
        ],
        returnType: "u32", callingConvention: "stdcall", category: "lock",
    },
    UnlockBox: {
        name: "UnlockBox",
        params: [
            { name: "this", type: "ptr" },
            { name: "Level", type: "u32" },
        ],
        returnType: "u32", callingConvention: "stdcall", category: "lock",
    },
    AddDirtyBox: {
        name: "AddDirtyBox",
        params: [
            { name: "this", type: "ptr" },
            { name: "pDirtyBox", type: "ptr", optional: true },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
};

const volumeTextureMethodSpecs = [
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    { name: "SetLOD", args: 2 },
    { name: "GetLOD", args: 1 },
    { name: "GetLevelCount", args: 1 },
    { name: "SetAutoGenFilterType", args: 2 },
    { name: "GetAutoGenFilterType", args: 1 },
    { name: "GenerateMipSubLevels", args: 1 },
    { name: "GetLevelDesc", args: 3 },
    { name: "GetVolumeLevel", args: 3 },
    { name: "LockBox", args: 5 },
    { name: "UnlockBox", args: 2 },
    { name: "AddDirtyBox", args: 2 },
];

const volumeTextureMethods = volumeTextureMethodSpecs.map((spec) =>
    volumeTextureMethodOverrides[spec.name] ?? resourceMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

export const IDirect3DVolumeTexture9: InterfaceDescriptor = {
    name: "IDirect3DVolumeTexture9",
    inherits: "IDirect3DBaseTexture9",
    iid: "2518526C-E789-4111-A7B9-47EF328D13E6",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...volumeTextureMethods,
    ],
};

// IDirect3DVolume9 is the 3-D analogue of IDirect3DSurface9.  Its descriptor
// is intentionally independent of IDirect3DSurface9: the two interfaces have
// different Lock* ABI and different GetDesc structures.
const volumeMethodOverrides: Record<string, FunctionDescriptor> = {
    GetDevice: textureMethodOverrides.GetDevice,
    GetDesc: {
        name: "GetDesc",
        params: [
            { name: "this", type: "ptr" },
            { name: "pDesc", type: "ptr", direction: "out" },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
    LockBox: {
        name: "LockBox",
        params: [
            { name: "this", type: "ptr" },
            { name: "pLockedVolume", type: "ptr", direction: "out" },
            { name: "pBox", type: "ptr", optional: true },
            { name: "Flags", type: "u32" },
        ],
        returnType: "u32", callingConvention: "stdcall", category: "lock",
    },
    UnlockBox: {
        name: "UnlockBox",
        params: [{ name: "this", type: "ptr" }],
        returnType: "u32", callingConvention: "stdcall", category: "lock",
    },
    GetContainer: {
        name: "GetContainer",
        params: [
            { name: "this", type: "ptr" },
            { name: "riid", type: "ptr" },
            { name: "ppContainer", type: "ptr", direction: "out" },
        ],
        returnType: "u32", callingConvention: "stdcall",
    },
};

const volumeMethodSpecs = [
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "GetContainer", args: 3 },
    { name: "GetDesc", args: 2 },
    { name: "LockBox", args: 4 },
    { name: "UnlockBox", args: 1 },
];

const volumeMethods = volumeMethodSpecs.map((spec) =>
    volumeMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

export const IDirect3DVolume9: InterfaceDescriptor = {
    name: "IDirect3DVolume9",
    inherits: "IUnknown",
    iid: "24F416E6-1F67-4AA7-B88E-D33F6F3128A1",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...volumeMethods,
    ],
};

const surfaceMethodOverrides: Record<string, FunctionDescriptor> = {
    GetDevice: {
        name: "GetDevice",
        params: [
            { name: "this", type: "ptr" },
            { name: "ppDevice", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
    GetDesc: {
        name: "GetDesc",
        params: [
            { name: "this", type: "ptr" },
            { name: "pDesc", type: "ptr", direction: "out" },
        ],
        returnType: "u32",
        callingConvention: "stdcall",
    },
};

const surfaceMethodSpecs = [
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    // IDirect3DSurface9 derives from IDirect3DResource9, so these four sit BETWEEN
    // FreePrivateData and GetContainer (d3d9.h). Dropping them shifts every slot from
    // GetContainer on by four, and the shift is silent: the guest's
    // GetContainer(riid, ppContainer) lands in GetDC(phdc), writes an HDC over its own
    // REFIID constant and leaves ppContainer untouched — a NULL vcall far from here.
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    { name: "GetContainer", args: 3 },
    { name: "GetDesc", args: 2 },
    { name: "LockRect", args: 4 },
    { name: "UnlockRect", args: 1 },
    { name: "GetDC", args: 2 },
    { name: "ReleaseDC", args: 2 },
];

const surfaceMethods = surfaceMethodSpecs.map((spec) =>
    surfaceMethodOverrides[spec.name] ?? resourceMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

export const IDirect3DSurface9: InterfaceDescriptor = {
    name: "IDirect3DSurface9",
    inherits: "IUnknown",
    iid: "0cfbaf3a-9ff6-429a-99b3-a2796af8b89b",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...surfaceMethods,
    ]
};

/**
 * IDirect3DSwapChain9 is a child COM object of IDirect3DDevice9.  The order is
 * taken verbatim from d3d9.h; in particular Present comes before GetDevice.
 * Keeping this as a separate descriptor is important because a swap-chain
 * pointer is not a device pointer and callers routinely QI/GetContainer it.
 */
export const IDirect3DSwapChain9: InterfaceDescriptor = {
    name: "IDirect3DSwapChain9",
    inherits: "IUnknown",
    iid: "794950F2-ADFC-458a-905E-10A10B0B503B",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        {
            name: "Present",
            params: [
                { name: "this", type: "ptr" },
                { name: "pSourceRect", type: "ptr", optional: true },
                { name: "pDestRect", type: "ptr", optional: true },
                { name: "hDestWindowOverride", type: "handle", optional: true },
                { name: "pDirtyRegion", type: "ptr", optional: true },
                { name: "dwFlags", type: "u32" },
            ],
            returnType: "u32", callingConvention: "stdcall", async: true, category: "present",
        },
        { name: "GetFrontBufferData", params: [{ name: "this", type: "ptr" }, { name: "pDestSurface", type: "ptr" }], returnType: "u32", callingConvention: "stdcall", category: "present" },
        { name: "GetBackBuffer", params: [{ name: "this", type: "ptr" }, { name: "iBackBuffer", type: "u32" }, { name: "Type", type: "u32" }, { name: "ppBackBuffer", type: "ptr", direction: "out" }], returnType: "u32", callingConvention: "stdcall", category: "resource" },
        { name: "GetRasterStatus", params: [{ name: "this", type: "ptr" }, { name: "pRasterStatus", type: "ptr", direction: "out" }], returnType: "u32", callingConvention: "stdcall" },
        { name: "GetDisplayMode", params: [{ name: "this", type: "ptr" }, { name: "pMode", type: "ptr", direction: "out" }], returnType: "u32", callingConvention: "stdcall" },
        { name: "GetDevice", params: [{ name: "this", type: "ptr" }, { name: "ppDevice", type: "ptr", direction: "out" }], returnType: "u32", callingConvention: "stdcall" },
        { name: "GetPresentParameters", params: [{ name: "this", type: "ptr" }, { name: "pPresentationParameters", type: "ptr", direction: "out" }], returnType: "u32", callingConvention: "stdcall" },
    ],
};

// IDirect3DStateBlock9 interface (vtable: QI, AddRef, Release, GetDevice, Capture, Apply)
export const IDirect3DStateBlock9: InterfaceDescriptor = {
    name: "IDirect3DStateBlock9",
    inherits: "IUnknown",
    iid: "B07C4FE5-310D-4BA8-A23C-4F0F206F218B",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        {
            name: "GetDevice",
            params: [
                { name: "this", type: "ptr" },
                { name: "ppDevice", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        { name: "Capture", params: [{ name: "this", type: "ptr" }], returnType: "u32", callingConvention: "stdcall" },
        { name: "Apply", params: [{ name: "this", type: "ptr" }], returnType: "u32", callingConvention: "stdcall" },
    ],
};

export const IDirect3DVertexDeclaration9: InterfaceDescriptor = {
    name: "IDirect3DVertexDeclaration9",
    inherits: "IUnknown",
    iid: "DD13C59C-36FA-4098-A8FB-C7ED39DC8546",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        {
            name: "GetDevice",
            params: [
                { name: "this", type: "ptr" },
                { name: "ppDevice", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "GetDeclaration",
            params: [
                { name: "this", type: "ptr" },
                { name: "pElement", type: "ptr", direction: "out" },
                { name: "pNumElements", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
    ],
};

export const IDirect3DVertexShader9: InterfaceDescriptor = {
    name: "IDirect3DVertexShader9",
    inherits: "IUnknown",
    iid: "EFC5557E-6265-4613-8A94-43857889EB36",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        {
            name: "GetDevice",
            params: [
                { name: "this", type: "ptr" },
                { name: "ppDevice", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "GetFunction",
            params: [
                { name: "this", type: "ptr" },
                { name: "pData", type: "ptr", direction: "out" },
                { name: "pSizeOfData", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
    ],
};

export const IDirect3DPixelShader9: InterfaceDescriptor = {
    name: "IDirect3DPixelShader9",
    inherits: "IUnknown",
    iid: "6D3BDBDC-5B02-4415-B852-CE5E8BCCB289",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        {
            name: "GetDevice",
            params: [
                { name: "this", type: "ptr" },
                { name: "ppDevice", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "GetFunction",
            params: [
                { name: "this", type: "ptr" },
                { name: "pData", type: "ptr", direction: "out" },
                { name: "pSizeOfData", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
    ],
};

// IDirect3DQuery9 (vtable: QI, AddRef, Release, GetDevice, GetType, GetDataSize, Issue, GetData)
export const IDirect3DQuery9: InterfaceDescriptor = {
    name: "IDirect3DQuery9",
    inherits: "IUnknown",
    iid: "D9771460-A695-4F26-BBD3-27B840B541CC",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        {
            name: "GetDevice",
            params: [
                { name: "this", type: "ptr" },
                { name: "ppDevice", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        // GetType returns D3DQUERYTYPE and GetDataSize a DWORD — neither is an HRESULT.
        makeMethod("GetType", 1),
        makeMethod("GetDataSize", 1),
        makeMethod("Issue", 2),
        {
            name: "GetData",
            params: [
                { name: "this", type: "ptr" },
                { name: "pData", type: "ptr", direction: "out" },
                { name: "dwSize", type: "u32" },
                { name: "dwGetDataFlags", type: "u32" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
    ],
};

export const IDirect3DShaderValidator9: InterfaceDescriptor = {
    name: "IDirect3DShaderValidator9",
    inherits: "IUnknown",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Begin", 4),
        makeMethod("Instruction", 5),
        makeMethod("End", 1),
    ],
};

// Complete D3D9 module descriptor
export const d3d9Module: ModuleDescriptor = {
    name: "d3d9",
    version: "9.0c",
    description: "Direct3D 9 Graphics API",
    functions: [
        {
            name: "Direct3DCreate9",
            params: [
                { name: "SDKVersion", type: "u32" }
            ],
            returnType: "ptr",
            callingConvention: "stdcall",
            description: "Create a Direct3D 9 object"
        },
        {
            name: "Direct3DCreate9Ex",
            params: [
                { name: "SDKVersion", type: "u32" },
                { name: "ppD3D9Ex", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
            description: "Create a Direct3D 9Ex object"
        },
        {
            name: "Direct3DShaderValidatorCreate9",
            params: [],
            returnType: "ptr",
            callingConvention: "stdcall",
            description: "Create D3DX shader bytecode validator (undocumented export)"
        },
        {
            name: "DebugSetMute",
            params: [{ name: "Mute", type: "u32" }],
            returnType: "u32",
            callingConvention: "cdecl",
            description: "Mute D3D debug spew (undocumented export, used via GetProcAddress)"
        }
    ],
    interfaces: [
        IDirect3D9,
        IDirect3D9Ex,
        IDirect3DDevice9,
        IDirect3DDevice9Ex,
        IDirect3DVertexBuffer9,
        IDirect3DIndexBuffer9,
        IDirect3DTexture9,
        IDirect3DCubeTexture9,
        IDirect3DVolumeTexture9,
        IDirect3DVolume9,
        IDirect3DSurface9,
        IDirect3DSwapChain9,
        IDirect3DStateBlock9,
        IDirect3DVertexDeclaration9,
        IDirect3DVertexShader9,
        IDirect3DPixelShader9,
        IDirect3DQuery9,
        IDirect3DShaderValidator9,
    ],
    constants: D3D9_CONSTANTS,
};
