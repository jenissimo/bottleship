/**
 * D3D8 API Descriptor
 *
 * Describes the Direct3D 8 API for vtable generation.
 * Vtable ordering is ABI-critical — games call by index.
 *
 * D3D8 key differences from D3D9:
 * - SetVertexShader(DWORD) overloaded: FVF if < 0x10000, else shader handle
 * - SetStreamSource has no OffsetInBytes param
 * - SetIndices includes BaseVertexIndex
 * - CreateTexture has no pSharedHandle
 * - GetBackBuffer has no iSwapChain param
 * - No SetFVF/GetFVF (FVF via SetVertexShader)
 * - No SetSamplerState (sampler state via SetTextureStageState)
 */

import {
    ModuleDescriptor,
    InterfaceDescriptor,
    FunctionDescriptor,
    ParameterDescriptor,
    IUnknown,
} from "./types";

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
});

// =========================================================================
// IDirect3D8 — 13 own methods (vtable slots 3-15, after IUnknown 0-2)
// =========================================================================

export const IDirect3D8: InterfaceDescriptor = {
    name: "IDirect3D8",
    inherits: "IUnknown",
    iid: "1DD9E8DA-1C77-4D40-B0CF-98FEFDFF9512",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m })),
        // Order from d3d8.h — MUST match SDK vtable layout exactly
        makeMethod("RegisterSoftwareDevice", 2),
        makeMethod("GetAdapterCount", 1),
        makeMethod("GetAdapterIdentifier", 4),
        makeMethod("GetAdapterModeCount", 2),
        makeMethod("EnumAdapterModes", 4),
        makeMethod("GetAdapterDisplayMode", 3),
        makeMethod("CheckDeviceType", 6),
        makeMethod("CheckDeviceFormat", 7),
        makeMethod("CheckDeviceMultiSampleType", 6),
        makeMethod("CheckDepthStencilMatch", 6),
        makeMethod("GetDeviceCaps", 4),
        makeMethod("GetAdapterMonitor", 2, { returnType: "handle" }),
        makeMethod("CreateDevice", 7, { async: true, category: "device" }),
    ]
};

// =========================================================================
// IDirect3DDevice8 — 94 own methods (vtable slots 3-96)
// Ordering from d3d8.h SDK header. MUST be exact.
// =========================================================================

const deviceMethodOverrides: Record<string, FunctionDescriptor> = {
    Present: makeMethod("Present", 5, { async: true, category: "present" }),
    Clear: makeMethod("Clear", 7, { category: "draw" }),
    BeginScene: makeMethod("BeginScene", 1, { category: "draw" }),
    EndScene: makeMethod("EndScene", 1, { category: "draw" }),
    SetRenderState: makeMethod("SetRenderState", 3, { category: "state" }),
    GetRenderState: makeMethod("GetRenderState", 3, { category: "state" }),
    SetTextureStageState: makeMethod("SetTextureStageState", 4, { category: "state" }),
    GetTextureStageState: makeMethod("GetTextureStageState", 4, { category: "state" }),
    SetTransform: makeMethod("SetTransform", 3, { category: "state" }),
    GetTransform: makeMethod("GetTransform", 3, { category: "state" }),
    SetTexture: makeMethod("SetTexture", 3, { category: "state" }),
    GetTexture: makeMethod("GetTexture", 3, { category: "state" }),
    SetVertexShader: makeMethod("SetVertexShader", 2, { category: "state" }),
    GetVertexShader: makeMethod("GetVertexShader", 2, { category: "state" }),
    SetStreamSource: makeMethod("SetStreamSource", 4, { category: "state" }),  // this, stream, pVB, stride (NO offset)
    GetStreamSource: makeMethod("GetStreamSource", 4, { category: "state" }),
    SetIndices: makeMethod("SetIndices", 3, { category: "state" }),  // this, pIB, BaseVertexIndex
    GetIndices: makeMethod("GetIndices", 3, { category: "state" }),
    DrawPrimitive: makeMethod("DrawPrimitive", 4, { category: "draw" }),
    DrawIndexedPrimitive: makeMethod("DrawIndexedPrimitive", 6, { category: "draw" }),
    DrawPrimitiveUP: makeMethod("DrawPrimitiveUP", 5, { category: "draw" }),
    DrawIndexedPrimitiveUP: makeMethod("DrawIndexedPrimitiveUP", 9, { category: "draw" }),
    CreateTexture: makeMethod("CreateTexture", 8, { category: "resource" }),  // No pSharedHandle
    CreateVertexBuffer: makeMethod("CreateVertexBuffer", 6, { category: "resource" }),  // No pSharedHandle
    CreateIndexBuffer: makeMethod("CreateIndexBuffer", 6, { category: "resource" }),   // No pSharedHandle
    GetBackBuffer: makeMethod("GetBackBuffer", 4, { category: "device" }),  // No iSwapChain
    SetViewport: makeMethod("SetViewport", 2, { category: "state" }),
    GetViewport: makeMethod("GetViewport", 2, { category: "state" }),
};

// D3D8 device vtable order (from d3d8.h, after IUnknown)
const deviceMethodSpecs = [
    // Device lifecycle & info
    { name: "TestCooperativeLevel", args: 1 },
    { name: "GetAvailableTextureMem", args: 1 },
    { name: "ResourceManagerDiscardBytes", args: 2 },
    { name: "GetDirect3D", args: 2 },
    { name: "GetDeviceCaps", args: 2 },
    { name: "GetDisplayMode", args: 2 },
    { name: "GetCreationParameters", args: 2 },
    { name: "SetCursorProperties", args: 4 },
    { name: "SetCursorPosition", args: 4 },
    { name: "ShowCursor", args: 2 },
    // Swap chain
    { name: "CreateAdditionalSwapChain", args: 3 },
    { name: "Reset", args: 2 },
    { name: "Present", args: 5 },
    { name: "GetBackBuffer", args: 4 },
    { name: "GetRasterStatus", args: 2 },
    // Gamma
    { name: "SetGammaRamp", args: 3 },
    { name: "GetGammaRamp", args: 2 },
    // Resource creation
    { name: "CreateTexture", args: 8 },
    { name: "CreateVolumeTexture", args: 9 },
    { name: "CreateCubeTexture", args: 7 },  // this + EdgeLength, Levels, Usage, Format, Pool, ppCubeTexture
    { name: "CreateVertexBuffer", args: 6 },
    { name: "CreateIndexBuffer", args: 6 },
    { name: "CreateRenderTarget", args: 7 },  // this + Width, Height, Format, MultiSample, Lockable, ppSurface
    { name: "CreateDepthStencilSurface", args: 6 },
    { name: "CreateImageSurface", args: 5 },
    // Copy/update
    { name: "CopyRects", args: 6 },  // this + pSrc, pSrcRects, cRects, pDest, pDestPoints
    { name: "UpdateTexture", args: 3 },
    { name: "GetFrontBuffer", args: 2 },
    // Render target
    { name: "SetRenderTarget", args: 3 },
    { name: "GetRenderTarget", args: 2 },
    { name: "GetDepthStencilSurface", args: 2 },
    // Scene
    { name: "BeginScene", args: 1 },
    { name: "EndScene", args: 1 },
    { name: "Clear", args: 7 },
    // Transform
    { name: "SetTransform", args: 3 },
    { name: "GetTransform", args: 3 },
    { name: "MultiplyTransform", args: 3 },
    // Viewport
    { name: "SetViewport", args: 2 },
    { name: "GetViewport", args: 2 },
    // Material & Lighting
    { name: "SetMaterial", args: 2 },
    { name: "GetMaterial", args: 2 },
    { name: "SetLight", args: 3 },
    { name: "GetLight", args: 3 },
    { name: "LightEnable", args: 3 },
    { name: "GetLightEnable", args: 3 },
    // Clip planes
    { name: "SetClipPlane", args: 3 },
    { name: "GetClipPlane", args: 3 },
    // Render state
    { name: "SetRenderState", args: 3 },
    { name: "GetRenderState", args: 3 },
    // State blocks (D3D8 uses DWORD handles, not COM objects)
    { name: "BeginStateBlock", args: 1 },
    { name: "EndStateBlock", args: 2 },
    { name: "ApplyStateBlock", args: 2 },
    { name: "CaptureStateBlock", args: 2 },
    { name: "DeleteStateBlock", args: 2 },
    { name: "CreateStateBlock", args: 3 },
    // Clip status
    { name: "SetClipStatus", args: 2 },
    { name: "GetClipStatus", args: 2 },
    // Texture
    { name: "GetTexture", args: 3 },
    { name: "SetTexture", args: 3 },
    { name: "GetTextureStageState", args: 4 },
    { name: "SetTextureStageState", args: 4 },
    // Validate
    { name: "ValidateDevice", args: 2 },
    // Misc device state
    { name: "GetInfo", args: 4 },
    { name: "SetPaletteEntries", args: 3 },
    { name: "GetPaletteEntries", args: 3 },
    { name: "SetCurrentTexturePalette", args: 2 },
    { name: "GetCurrentTexturePalette", args: 2 },
    // Draw
    { name: "DrawPrimitive", args: 4 },
    { name: "DrawIndexedPrimitive", args: 6 },  // this + PrimType, MinIndex, NumVertices, StartIndex, PrimCount (no BaseVertexIndex in D3D8)
    { name: "DrawPrimitiveUP", args: 5 },
    { name: "DrawIndexedPrimitiveUP", args: 9 },
    // Vertex processing
    { name: "ProcessVertices", args: 6 },
    // Vertex shaders (D3D8: DWORD handles, not COM)
    { name: "CreateVertexShader", args: 5 },
    { name: "SetVertexShader", args: 2 },
    { name: "GetVertexShader", args: 2 },
    { name: "DeleteVertexShader", args: 2 },
    { name: "SetVertexShaderConstant", args: 4 },
    { name: "GetVertexShaderConstant", args: 4 },
    { name: "GetVertexShaderDeclaration", args: 4 },
    { name: "GetVertexShaderFunction", args: 4 },
    // Stream source (D3D8 SDK: Set before Get)
    { name: "SetStreamSource", args: 4 },
    { name: "GetStreamSource", args: 4 },
    // Indices (D3D8 SDK: Set before Get)
    { name: "SetIndices", args: 3 },
    { name: "GetIndices", args: 3 },
    // Pixel shaders (D3D8: DWORD handles)
    { name: "CreatePixelShader", args: 3 },
    { name: "SetPixelShader", args: 2 },
    { name: "GetPixelShader", args: 2 },
    { name: "DeletePixelShader", args: 2 },
    { name: "SetPixelShaderConstant", args: 4 },
    { name: "GetPixelShaderConstant", args: 4 },
    { name: "GetPixelShaderFunction", args: 4 },
    // Patch
    { name: "DrawRectPatch", args: 4 },
    { name: "DrawTriPatch", args: 4 },
    { name: "DeletePatch", args: 2 },
];

const deviceMethods = deviceMethodSpecs.map((spec) =>
    deviceMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

export const IDirect3DDevice8: InterfaceDescriptor = {
    name: "IDirect3DDevice8",
    inherits: "IUnknown",
    iid: "7385E5DF-8FE8-41D5-86B6-D7B48547B6CF",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m })),
        ...deviceMethods,
    ]
};

// =========================================================================
// IDirect3DTexture8
// Inheritance: IUnknown → IDirect3DResource8 → IDirect3DBaseTexture8 → IDirect3DTexture8
// =========================================================================

const textureMethodOverrides: Record<string, FunctionDescriptor> = {
    LockRect: makeMethod("LockRect", 5, { category: "lock" }),
    UnlockRect: makeMethod("UnlockRect", 2, { category: "lock" }),
};

const textureMethodSpecs = [
    // IDirect3DResource8 methods
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    // IDirect3DBaseTexture8 methods
    { name: "SetLOD", args: 2 },
    { name: "GetLOD", args: 1 },
    { name: "GetLevelCount", args: 1 },
    // IDirect3DTexture8 own methods
    { name: "GetLevelDesc", args: 3 },
    { name: "GetSurfaceLevel", args: 3 },
    { name: "LockRect", args: 5 },
    { name: "UnlockRect", args: 2 },
    { name: "AddDirtyRect", args: 2 },
];

const textureMethods = textureMethodSpecs.map((spec) =>
    textureMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)
);

export const IDirect3DTexture8: InterfaceDescriptor = {
    name: "IDirect3DTexture8",
    inherits: "IDirect3DBaseTexture8",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m })),
        ...textureMethods,
    ]
};

// =========================================================================
// IDirect3DSurface8 — derives straight from IUnknown (it is NOT an
// IDirect3DResource8: it repeats the private-data methods but has no
// SetPriority/PreLoad/GetType). 11 slots, ending at UnlockRect —
// GetDC/ReleaseDC are D3D9-era additions and must not appear here.
// =========================================================================

const surfaceMethodSpecs = [
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "GetContainer", args: 3 },
    { name: "GetDesc", args: 2 },
    { name: "LockRect", args: 4 },  // this, pLockedRect, pRect, Flags
    { name: "UnlockRect", args: 1 },
];

export const IDirect3DSurface8: InterfaceDescriptor = {
    name: "IDirect3DSurface8",
    inherits: "IUnknown",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m })),
        ...surfaceMethodSpecs.map((spec) => makeMethod(spec.name, spec.args)),
    ]
};

// =========================================================================
// IDirect3DVertexBuffer8
// Inheritance: IUnknown → IDirect3DResource8 → IDirect3DVertexBuffer8
// =========================================================================

const vbMethodOverrides: Record<string, FunctionDescriptor> = {
    Lock: makeMethod("Lock", 5, { category: "lock" }),
    Unlock: makeMethod("Unlock", 1, { category: "lock" }),
};

const vbMethodSpecs = [
    // IDirect3DResource8 methods
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    // IDirect3DVertexBuffer8 own methods
    { name: "Lock", args: 5 },
    { name: "Unlock", args: 1 },
    { name: "GetDesc", args: 2 },
];

export const IDirect3DVertexBuffer8: InterfaceDescriptor = {
    name: "IDirect3DVertexBuffer8",
    inherits: "IDirect3DResource8",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m })),
        ...vbMethodSpecs.map((spec) => vbMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)),
    ]
};

// =========================================================================
// IDirect3DIndexBuffer8
// Inheritance: IUnknown → IDirect3DResource8 → IDirect3DIndexBuffer8
// =========================================================================

const ibMethodSpecs = [
    // IDirect3DResource8 methods
    { name: "GetDevice", args: 2 },
    { name: "SetPrivateData", args: 5 },
    { name: "GetPrivateData", args: 4 },
    { name: "FreePrivateData", args: 2 },
    { name: "SetPriority", args: 2 },
    { name: "GetPriority", args: 1 },
    { name: "PreLoad", args: 1 },
    { name: "GetType", args: 1 },
    // IDirect3DIndexBuffer8 own methods
    { name: "Lock", args: 5 },
    { name: "Unlock", args: 1 },
    { name: "GetDesc", args: 2 },
];

export const IDirect3DIndexBuffer8: InterfaceDescriptor = {
    name: "IDirect3DIndexBuffer8",
    inherits: "IDirect3DResource8",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m })),
        ...ibMethodSpecs.map((spec) => vbMethodOverrides[spec.name] ?? makeMethod(spec.name, spec.args)),
    ]
};

// =========================================================================
// Module descriptor
// =========================================================================

export const d3d8Module: ModuleDescriptor = {
    name: "d3d8",
    version: "8.0",
    description: "Direct3D 8 Graphics API",
    functions: [
        {
            name: "Direct3DCreate8",
            params: [{ name: "SDKVersion", type: "u32" }],
            returnType: "ptr",
            callingConvention: "stdcall",
        },
        {
            name: "DebugSetMute",
            params: [{ name: "bMute", type: "u32" }],
            returnType: "void",
            callingConvention: "cdecl",
        },
        // HRESULT WINAPI ValidateVertexShader(DWORD* pVertexShader, DWORD* pVertexDecl,
        //   const D3DCAPS8* pCaps, BOOL ReturnError, char** ppErrorString)
        {
            name: "ValidateVertexShader",
            params: [
                { name: "pVertexShader", type: "ptr" },
                { name: "pVertexDecl", type: "ptr" },
                { name: "pCaps", type: "ptr" },
                { name: "ReturnError", type: "u32" },
                { name: "ppErrorString", type: "ptr" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        // HRESULT WINAPI ValidatePixelShader(DWORD* pPixelShader, const D3DCAPS8* pCaps,
        //   BOOL ReturnError, char** ppErrorString)
        {
            name: "ValidatePixelShader",
            params: [
                { name: "pPixelShader", type: "ptr" },
                { name: "pCaps", type: "ptr" },
                { name: "ReturnError", type: "u32" },
                { name: "ppErrorString", type: "ptr" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
    ],
    interfaces: [
        IDirect3D8,
        IDirect3DDevice8,
        IDirect3DTexture8,
        IDirect3DSurface8,
        IDirect3DVertexBuffer8,
        IDirect3DIndexBuffer8,
    ],
};
