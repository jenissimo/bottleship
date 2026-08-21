/**
 * DirectDraw API Descriptor
 */

import {
    ModuleDescriptor,
    InterfaceDescriptor,
    FunctionDescriptor,
    ParameterDescriptor,
    IUnknown,
} from "./types";

import {
    IID_IDirect3D,
    IID_IDirect3D2,
    IID_IDirect3D3,
    IID_IDirect3D7,
    IID_IDirect3DDevice,
    IID_IDirect3DDevice2,
    IID_IDirect3DDevice3V5,
    IID_IDirect3DDevice7,
    IID_IDirect3DExecuteBuffer,
    IID_IDirect3DTexture,
    IID_IDirect3DTexture2,
    IID_IDirect3DViewport2,
    IID_IDirect3DViewport3,
    IID_IDirectDraw,
    IID_IDirectDraw2,
    IID_IDirectDraw4,
    IID_IDirectDraw7,
    IID_IDirectDrawPalette,
    IID_IDirectDrawSurface,
    IID_IDirectDrawSurface4,
    IID_IDirectDrawSurface7,
    IID_IDirectDrawGammaControl,
    IID_IDirect3DLight,
    IID_IDirect3DMaterial,
    IID_IDirect3DMaterial2,
    IID_IDirect3DMaterial3,
    IID_IDirect3DVertexBuffer,
    IID_IDirect3DVertexBuffer7,
} from "../modules/ddraw/constants";

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

// IDirectDraw (v1) interface - returned by DirectDrawCreate
// Method order must match ddraw.h exactly!
// argCount = cParams + 1 (for this pointer)
export const IDirectDraw: InterfaceDescriptor = {
    name: "IDirectDraw",
    inherits: "IUnknown",
    iid: IID_IDirectDraw,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Compact", 1),           // cParams=0, +1=1
        makeMethod("CreateClipper", 4),     // cParams=3, +1=4
        makeMethod("CreatePalette", 5),     // cParams=4, +1=5
        makeMethod("CreateSurface", 4),     // cParams=3, +1=4 (Takes LPDDSURFACEDESC v1)
        makeMethod("DuplicateSurface", 3),  // cParams=2, +1=3
        makeMethod("EnumDisplayModes", 5),  // cParams=4, +1=5
        makeMethod("EnumSurfaces", 5),      // cParams=4, +1=5
        makeMethod("FlipToGDISurface", 1),  // cParams=0, +1=1
        makeMethod("GetCaps", 3),           // cParams=2, +1=3
        makeMethod("GetDisplayMode", 2),    // cParams=1, +1=2
        makeMethod("GetFourCCCodes", 3),    // cParams=2, +1=3
        makeMethod("GetGDISurface", 2),     // cParams=1, +1=2
        makeMethod("GetMonitorFrequency", 2), // cParams=1, +1=2
        makeMethod("GetScanLine", 2),       // cParams=1, +1=2
        makeMethod("GetVerticalBlankStatus", 2), // cParams=1, +1=2
        makeMethod("Initialize", 2),        // cParams=1, +1=2
        makeMethod("RestoreDisplayMode", 1), // cParams=0, +1=1
        makeMethod("SetCooperativeLevel", 3), // cParams=2, +1=3
        makeMethod("SetDisplayMode", 4),    // cParams=3, +1=4 (v1: width, height, bpp)
        makeMethod("WaitForVerticalBlank", 3), // cParams=2, +1=3
    ],
};

// IDirectDraw2 interface - DirectX 2/3 era (adds GetAvailableVidMem over IDirectDraw v1)
// Method order must match ddraw.h exactly!
// argCount = cParams + 1 (for this pointer)
export const IDirectDraw2: InterfaceDescriptor = {
    name: "IDirectDraw2",
    inherits: "IUnknown",
    iid: IID_IDirectDraw2,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Compact", 1),           // cParams=0, +1=1
        makeMethod("CreateClipper", 4),     // cParams=3, +1=4
        makeMethod("CreatePalette", 5),     // cParams=4, +1=5
        makeMethod("CreateSurface", 4),     // cParams=3, +1=4 (Takes LPDDSURFACEDESC v1)
        makeMethod("DuplicateSurface", 3),  // cParams=2, +1=3
        makeMethod("EnumDisplayModes", 5),  // cParams=4, +1=5
        makeMethod("EnumSurfaces", 5),      // cParams=4, +1=5
        makeMethod("FlipToGDISurface", 1),  // cParams=0, +1=1
        makeMethod("GetCaps", 3),           // cParams=2, +1=3
        makeMethod("GetDisplayMode", 2),    // cParams=1, +1=2
        makeMethod("GetFourCCCodes", 3),    // cParams=2, +1=3
        makeMethod("GetGDISurface", 2),     // cParams=1, +1=2
        makeMethod("GetMonitorFrequency", 2), // cParams=1, +1=2
        makeMethod("GetScanLine", 2),       // cParams=1, +1=2
        makeMethod("GetVerticalBlankStatus", 2), // cParams=1, +1=2
        makeMethod("Initialize", 2),        // cParams=1, +1=2
        makeMethod("RestoreDisplayMode", 1), // cParams=0, +1=1
        makeMethod("SetCooperativeLevel", 3), // cParams=2, +1=3
        makeMethod("SetDisplayMode", 6),    // cParams=5, +1=6 (v2+: width, height, bpp, refreshRate, flags)
        makeMethod("WaitForVerticalBlank", 3), // cParams=2, +1=3
        makeMethod("GetAvailableVidMem", 4), // cParams=3, +1=4 (NEW in v2: lpDDSCaps, lpdwTotal, lpdwFree)
    ],
};

// IDirectDrawSurface (v1) interface — also the table handed out for
// IID_IDirectDrawSurface2/3. v2 and v3 extend v1 by strict append and share the
// v1 semantics for slots 0..35 (all three marshal DDSURFACEDESC, not
// DDSURFACEDESC2), so the trailing v2/v3 slots must live here: a v1-created
// surface QI'd as v2 calls PageLock through THIS table.
// Method order must match ddraw.h exactly!
// argCount = cParams + 1 (for this pointer)
export const IDirectDrawSurface: InterfaceDescriptor = {
    name: "IDirectDrawSurface",
    inherits: "IUnknown",
    iid: IID_IDirectDrawSurface,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("AddAttachedSurface", 2),    // cParams=1, +1=2
        makeMethod("AddOverlayDirtyRect", 2),   // cParams=1, +1=2
        makeMethod("Blt", 6),                   // cParams=5, +1=6
        makeMethod("BltBatch", 4),              // cParams=3, +1=4
        makeMethod("BltFast", 6),               // cParams=5, +1=6
        makeMethod("DeleteAttachedSurface", 3), // cParams=2, +1=3
        makeMethod("EnumAttachedSurfaces", 3),  // cParams=2, +1=3
        makeMethod("EnumOverlayZOrders", 4),    // cParams=3, +1=4
        makeMethod("Flip", 3),                  // cParams=2, +1=3
        makeMethod("GetAttachedSurface", 3),    // cParams=2, +1=3
        makeMethod("GetBltStatus", 2),          // cParams=1, +1=2
        makeMethod("GetCaps", 2),               // cParams=1, +1=2
        makeMethod("GetClipper", 2),            // cParams=1, +1=2
        makeMethod("GetColorKey", 3),           // cParams=2, +1=3
        makeMethod("GetDC", 2),                 // cParams=1, +1=2
        makeMethod("GetFlipStatus", 2),         // cParams=1, +1=2
        makeMethod("GetOverlayPosition", 3),    // cParams=2, +1=3
        makeMethod("GetPalette", 2),            // cParams=1, +1=2
        makeMethod("GetPixelFormat", 2),        // cParams=1, +1=2
        makeMethod("GetSurfaceDesc", 2),        // cParams=1, +1=2 (Returns LPDDSURFACEDESC v1)
        makeMethod("Initialize", 3),            // cParams=2, +1=3
        makeMethod("IsLost", 1),                // cParams=0, +1=1
        makeMethod("Lock", 5),                  // cParams=4, +1=5 (Takes LPDDSURFACEDESC v1)
        makeMethod("ReleaseDC", 2),             // cParams=1, +1=2
        makeMethod("Restore", 1),               // cParams=0, +1=1
        makeMethod("SetClipper", 2),            // cParams=1, +1=2
        makeMethod("SetColorKey", 3),           // cParams=2, +1=3
        makeMethod("SetOverlayPosition", 3),    // cParams=2, +1=3
        makeMethod("SetPalette", 2),            // cParams=1, +1=2
        makeMethod("Unlock", 2),                // cParams=1, +1=2
        makeMethod("UpdateOverlay", 6),         // cParams=5, +1=6
        makeMethod("UpdateOverlayDisplay", 2),  // cParams=1, +1=2
        makeMethod("UpdateOverlayZOrder", 3),   // cParams=2, +1=3
        makeMethod("GetDDInterface", 2),        // Slot 36 — IDirectDrawSurface2
        makeMethod("PageLock", 2),              // Slot 37 — IDirectDrawSurface2
        makeMethod("PageUnlock", 2),            // Slot 38 — IDirectDrawSurface2
        makeMethod("SetSurfaceDesc", 3),        // Slot 39 — IDirectDrawSurface3 (LPDDSURFACEDESC v1)
    ],
};

// IDirectDraw4 interface - DirectX 6 era (critical for Re-Volt)
// Method order must match ddraw.h exactly!
export const IDirectDraw4: InterfaceDescriptor = {
    name: "IDirectDraw4",
    inherits: "IUnknown",
    iid: IID_IDirectDraw4,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Compact", 1),
        makeMethod("CreateClipper", 4),
        makeMethod("CreatePalette", 5),
        makeMethod("CreateSurface", 4), // Takes LPDDSURFACEDESC2 (v2 structure)
        makeMethod("DuplicateSurface", 3),
        makeMethod("EnumDisplayModes", 5),
        makeMethod("EnumSurfaces", 5),
        makeMethod("FlipToGDISurface", 1),
        makeMethod("GetCaps", 3),
        makeMethod("GetDisplayMode", 2),
        makeMethod("GetFourCCCodes", 3),
        makeMethod("GetGDISurface", 2),
        makeMethod("GetMonitorFrequency", 2),
        makeMethod("GetScanLine", 2),
        makeMethod("GetVerticalBlankStatus", 2),
        makeMethod("Initialize", 2),
        makeMethod("RestoreDisplayMode", 1),
        makeMethod("SetCooperativeLevel", 3),
        makeMethod("SetDisplayMode", 6), // v2+/v4: 5 args (width, height, bpp, refresh, flags) + this = 6
        makeMethod("WaitForVerticalBlank", 3),
        makeMethod("GetAvailableVidMem", 4),
        makeMethod("GetSurfaceFromDC", 3),
        makeMethod("RestoreAllSurfaces", 1),
        makeMethod("TestCooperativeLevel", 1),
        makeMethod("GetDeviceIdentifier", 3),
    ],
};

// IDirectDrawSurface4 interface - DirectX 6 era (critical for Re-Volt)
// Method order must match ddraw.h exactly!
export const IDirectDrawSurface4: InterfaceDescriptor = {
    name: "IDirectDrawSurface4",
    inherits: "IUnknown",
    iid: IID_IDirectDrawSurface4,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("AddAttachedSurface", 2),
        makeMethod("AddOverlayDirtyRect", 2),
        makeMethod("Blt", 6),
        makeMethod("BltBatch", 4),
        makeMethod("BltFast", 6),
        makeMethod("DeleteAttachedSurface", 3),
        makeMethod("EnumAttachedSurfaces", 3),
        makeMethod("EnumOverlayZOrders", 4),
        makeMethod("Flip", 3),
        makeMethod("GetAttachedSurface", 3),
        makeMethod("GetBltStatus", 2),
        makeMethod("GetCaps", 2),
        makeMethod("GetClipper", 2),
        makeMethod("GetColorKey", 3),
        makeMethod("GetDC", 2),
        makeMethod("GetFlipStatus", 2),
        makeMethod("GetOverlayPosition", 3),
        makeMethod("GetPalette", 2),
        makeMethod("GetPixelFormat", 2),
        makeMethod("GetSurfaceDesc", 2), // Returns LPDDSURFACEDESC2 (v2 structure)
        makeMethod("Initialize", 3),
        makeMethod("IsLost", 1),
        makeMethod("Lock", 5), // Takes LPDDSURFACEDESC2 (v2 structure)
        makeMethod("ReleaseDC", 2),
        makeMethod("Restore", 1),
        makeMethod("SetClipper", 2),
        makeMethod("SetColorKey", 3),
        makeMethod("SetOverlayPosition", 3),
        makeMethod("SetPalette", 2),
        makeMethod("Unlock", 2),
        makeMethod("UpdateOverlay", 6),
        makeMethod("UpdateOverlayDisplay", 2),
        makeMethod("UpdateOverlayZOrder", 3),
        makeMethod("GetDDInterface", 2),
        makeMethod("PageLock", 2),
        makeMethod("PageUnlock", 2),
        makeMethod("SetSurfaceDesc", 3),
        makeMethod("SetPrivateData", 5),    // cParams=4, +1=5
        makeMethod("GetPrivateData", 4),    // cParams=3, +1=4
        makeMethod("FreePrivateData", 2),
        makeMethod("GetUniquenessValue", 2),
        makeMethod("ChangeUniquenessValue", 1),
    ],
};

// IDirectDrawPalette interface
export const IDirectDrawPalette: InterfaceDescriptor = {
    name: "IDirectDrawPalette",
    inherits: "IUnknown",
    iid: IID_IDirectDrawPalette,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetCaps", 2),
        makeMethod("GetEntries", 5),
        makeMethod("Initialize", 4),
        makeMethod("SetEntries", 5),
    ],
};

// IDirectDraw7 interface - based on DirectX 7 SDK
// Method order must match ddraw.h exactly!
export const IDirectDraw7: InterfaceDescriptor = {
    name: "IDirectDraw7",
    inherits: "IUnknown",
    iid: IID_IDirectDraw7,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Compact", 1),
        makeMethod("CreateClipper", 4),
        makeMethod("CreatePalette", 5),
        makeMethod("CreateSurface", 4),
        makeMethod("DuplicateSurface", 3),
        makeMethod("EnumDisplayModes", 5),
        makeMethod("EnumSurfaces", 5),
        makeMethod("FlipToGDISurface", 1),
        makeMethod("GetCaps", 3),
        makeMethod("GetDisplayMode", 2),
        makeMethod("GetFourCCCodes", 3),
        makeMethod("GetGDISurface", 2),
        makeMethod("GetMonitorFrequency", 2),
        makeMethod("GetScanLine", 2),
        makeMethod("GetVerticalBlankStatus", 2),
        makeMethod("Initialize", 2),
        makeMethod("RestoreDisplayMode", 1),
        makeMethod("SetCooperativeLevel", 3),
        makeMethod("SetDisplayMode", 6),
        makeMethod("WaitForVerticalBlank", 3),
        makeMethod("GetAvailableVidMem", 4),
        makeMethod("GetSurfaceFromDC", 3),
        makeMethod("RestoreAllSurfaces", 1),
        makeMethod("TestCooperativeLevel", 1),
        makeMethod("GetDeviceIdentifier", 3),
        makeMethod("StartModeTest", 4),
        makeMethod("EvaluateMode", 3),
    ],
};

// IDirectDrawClipper interface - clipper for windowed Blt (ddraw.h order)
export const IDirectDrawClipper: InterfaceDescriptor = {
    name: "IDirectDrawClipper",
    inherits: "IUnknown",
    iid: "6c14db85-a733-11ce-a521-0020af0be560",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetClipList", 4),
        makeMethod("GetHWnd", 2),
        makeMethod("Initialize", 3),
        makeMethod("IsClipListChanged", 2),
        makeMethod("SetClipList", 3),
        makeMethod("SetHWnd", 3),
    ],
};

// IDirectDrawSurface7 interface - based on DirectX 7 SDK
// Method order must match ddraw.h exactly!
export const IDirectDrawSurface7: InterfaceDescriptor = {
    name: "IDirectDrawSurface7",
    inherits: "IUnknown",
    iid: IID_IDirectDrawSurface7,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("AddAttachedSurface", 2),
        makeMethod("AddOverlayDirtyRect", 2),
        makeMethod("Blt", 6),
        makeMethod("BltBatch", 4),
        makeMethod("BltFast", 6),
        makeMethod("DeleteAttachedSurface", 3),
        makeMethod("EnumAttachedSurfaces", 3),
        makeMethod("EnumOverlayZOrders", 4),
        makeMethod("Flip", 3),
        makeMethod("GetAttachedSurface", 3),
        makeMethod("GetBltStatus", 2),
        makeMethod("GetCaps", 2),
        makeMethod("GetClipper", 2),
        makeMethod("GetColorKey", 3),
        makeMethod("GetDC", 2),
        makeMethod("GetFlipStatus", 2),
        makeMethod("GetOverlayPosition", 3),
        makeMethod("GetPalette", 2),
        makeMethod("GetPixelFormat", 2),
        makeMethod("GetSurfaceDesc", 2),
        makeMethod("Initialize", 3),
        makeMethod("IsLost", 1),
        makeMethod("Lock", 5),
        makeMethod("ReleaseDC", 2),
        makeMethod("Restore", 1),
        makeMethod("SetClipper", 2),
        makeMethod("SetColorKey", 3),
        makeMethod("SetOverlayPosition", 3),
        makeMethod("SetPalette", 2),
        makeMethod("Unlock", 2),
        makeMethod("UpdateOverlay", 6),
        makeMethod("UpdateOverlayDisplay", 2),
        makeMethod("UpdateOverlayZOrder", 3),
        makeMethod("GetDDInterface", 2),
        makeMethod("PageLock", 2),
        makeMethod("PageUnlock", 2),
        makeMethod("SetSurfaceDesc", 3),
        makeMethod("SetPrivateData", 5),
        makeMethod("GetPrivateData", 4),
        makeMethod("FreePrivateData", 2),
        makeMethod("GetUniquenessValue", 2),
        makeMethod("ChangeUniquenessValue", 1),
        makeMethod("SetPriority", 2),
        makeMethod("GetPriority", 2),
        makeMethod("SetLOD", 2),
        makeMethod("GetLOD", 2),
    ],
};

// IDirect3D interface - based on DirectX 3 SDK
// Vtable: QI, AddRef, Release, Initialize, EnumDevices, CreateLight, CreateMaterial, CreateViewport, FindDevice
export const IDirect3D: InterfaceDescriptor = {
    name: "IDirect3D",
    inherits: "IUnknown",
    iid: IID_IDirect3D,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 2),          // Slot 3: (this, lpDirect3D)
        makeMethod("EnumDevices", 3),          // Slot 4
        makeMethod("CreateLight", 3),          // Slot 5
        makeMethod("CreateMaterial", 3),       // Slot 6
        makeMethod("CreateViewport", 3),       // Slot 7
        makeMethod("FindDevice", 3),           // Slot 8
    ],
};

// IDirect3D2 interface - based on DirectX 5 SDK
// Vtable: QI, AddRef, Release, EnumDevices, CreateLight, CreateMaterial, CreateViewport, FindDevice, CreateDevice
export const IDirect3D2: InterfaceDescriptor = {
    name: "IDirect3D2",
    inherits: "IUnknown",
    iid: IID_IDirect3D2,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("EnumDevices", 3),          // Slot 3
        makeMethod("CreateLight", 3),          // Slot 4
        makeMethod("CreateMaterial", 3),       // Slot 5
        makeMethod("CreateViewport", 3),       // Slot 6
        makeMethod("FindDevice", 3),           // Slot 7
        makeMethod("CreateDevice", 4),         // Slot 8: (this, rclsid, lpDDS, lplpD3DDevice)
    ],
};

// IDirect3D7 interface - based on DirectX 7 SDK
export const IDirect3D7: InterfaceDescriptor = {
    name: "IDirect3D7",
    inherits: "IUnknown",
    iid: IID_IDirect3D7,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("EnumDevices", 3),
        makeMethod("CreateDevice", 4),
        makeMethod("CreateVertexBuffer", 4),
        makeMethod("EnumZBufferFormats", 4),
        makeMethod("EvictManagedTextures", 1),
    ],
};

// IDirect3D3 interface - based on DirectX 5/6 SDK
// Method order MUST match d3d.h vtable exactly!
export const IDirect3D3: InterfaceDescriptor = {
    name: "IDirect3D3",
    inherits: "IUnknown",
    iid: IID_IDirect3D3,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("EnumDevices", 3),        // Slot 3
        makeMethod("CreateLight", 3),        // Slot 4
        makeMethod("CreateMaterial", 3),     // Slot 5
        makeMethod("CreateViewport", 3),     // Slot 6
        makeMethod("FindDevice", 3),         // Slot 7
        makeMethod("CreateDevice", 5),       // Slot 8
        makeMethod("CreateVertexBuffer", 5), // Slot 9
        makeMethod("EnumZBufferFormats", 4), // Slot 10
        makeMethod("EvictManagedTextures", 1), // Slot 11
    ],
};

// IDirect3DLight interface
// Vtable: QI, AddRef, Release, Initialize, SetLight, GetLight
export const IDirect3DLight: InterfaceDescriptor = {
    name: "IDirect3DLight",
    inherits: "IUnknown",
    iid: IID_IDirect3DLight,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 2),    // Slot 3
        makeMethod("SetLight", 2),       // Slot 4
        makeMethod("GetLight", 2),       // Slot 5
    ],
};

// IDirect3DMaterial (v1) interface — DirectX 2/3.
// NOT prefix-compatible with Material2/3: v1 carries Initialize at slot 3, so every
// later method sits one slot higher. Handing a Material3 vtable to a v1 client turns
// SetMaterial into GetMaterial and runs GetHandle off the end of the table.
export const IDirect3DMaterial: InterfaceDescriptor = {
    name: "IDirect3DMaterial",
    inherits: "IUnknown",
    iid: IID_IDirect3DMaterial,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 2),     // Slot 3
        makeMethod("SetMaterial", 2),    // Slot 4
        makeMethod("GetMaterial", 2),    // Slot 5
        makeMethod("GetHandle", 3),      // Slot 6
        makeMethod("Reserve", 1),        // Slot 7 — never implemented, DDERR_UNSUPPORTED
        makeMethod("Unreserve", 1),      // Slot 8 — never implemented, DDERR_UNSUPPORTED
    ],
};

// IDirect3DMaterial2 interface — DirectX 5. Same shape as Material3 (GetHandle
// takes an IDirect3DDevice2 instead of a Device3; identical ABI), but a distinct
// IID, so it needs its own table for QueryInterface to hand back.
export const IDirect3DMaterial2: InterfaceDescriptor = {
    name: "IDirect3DMaterial2",
    inherits: "IUnknown",
    iid: IID_IDirect3DMaterial2,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("SetMaterial", 2),    // Slot 3
        makeMethod("GetMaterial", 2),    // Slot 4
        makeMethod("GetHandle", 3),      // Slot 5
    ],
};

// IDirect3DMaterial3 interface
// Vtable: QI, AddRef, Release, SetMaterial, GetMaterial, GetHandle
export const IDirect3DMaterial3: InterfaceDescriptor = {
    name: "IDirect3DMaterial3",
    inherits: "IUnknown",
    iid: IID_IDirect3DMaterial3,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("SetMaterial", 2),    // Slot 3
        makeMethod("GetMaterial", 2),    // Slot 4
        makeMethod("GetHandle", 3),      // Slot 5
    ],
};

// IDirect3DVertexBuffer interface (DX6)
export const IDirect3DVertexBuffer: InterfaceDescriptor = {
    name: "IDirect3DVertexBuffer",
    inherits: "IUnknown",
    iid: IID_IDirect3DVertexBuffer,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Lock", 4),
        makeMethod("Unlock", 1),
        makeMethod("ProcessVertices", 8),
        makeMethod("GetVertexBufferDesc", 2),
        makeMethod("Optimize", 3),
    ],
};

// IDirect3DVertexBuffer7 interface (DX7). Slots 0-7 match the DX6 buffer, but the
// table is one longer — ProcessVerticesStrided is only on v7.
export const IDirect3DVertexBuffer7: InterfaceDescriptor = {
    name: "IDirect3DVertexBuffer7",
    inherits: "IUnknown",
    iid: IID_IDirect3DVertexBuffer7,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Lock", 4),
        makeMethod("Unlock", 1),
        makeMethod("ProcessVertices", 8),
        makeMethod("GetVertexBufferDesc", 2),
        makeMethod("Optimize", 3),
        makeMethod("ProcessVerticesStrided", 8), // Slot 8
    ],
};

// IDirect3DDevice (v1) interface - DirectX 2/3 SDK, still the device DX5-era titles
// get from IDirectDrawSurface::QueryInterface(IID_IDirect3D*Device). Execute-buffer
// era: no DrawPrimitive, and matrices are device-side handles.
// Method order MUST match d3d.h vtable exactly!
export const IDirect3DDevice: InterfaceDescriptor = {
    name: "IDirect3DDevice",
    inherits: "IUnknown",
    iid: IID_IDirect3DDevice,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 4),           // Slot 3: (this, lpD3D, lpGUID, lpd3ddvdesc)
        makeMethod("GetCaps", 3),              // Slot 4
        makeMethod("SwapTextureHandles", 3),   // Slot 5
        makeMethod("CreateExecuteBuffer", 4),  // Slot 6
        makeMethod("GetStats", 2),             // Slot 7
        makeMethod("Execute", 4),              // Slot 8
        makeMethod("AddViewport", 2),          // Slot 9
        makeMethod("DeleteViewport", 2),       // Slot 10
        makeMethod("NextViewport", 4),         // Slot 11
        makeMethod("Pick", 5),                 // Slot 12
        makeMethod("GetPickRecords", 3),       // Slot 13
        makeMethod("EnumTextureFormats", 3),   // Slot 14
        makeMethod("CreateMatrix", 2),         // Slot 15
        makeMethod("SetMatrix", 3),            // Slot 16
        makeMethod("GetMatrix", 3),            // Slot 17
        makeMethod("DeleteMatrix", 2),         // Slot 18
        makeMethod("BeginScene", 1),           // Slot 19
        makeMethod("EndScene", 1),             // Slot 20
        makeMethod("GetDirect3D", 2),          // Slot 21
    ],
};

// IDirect3DExecuteBuffer interface - DirectX 2/3 SDK
export const IDirect3DExecuteBuffer: InterfaceDescriptor = {
    name: "IDirect3DExecuteBuffer",
    inherits: "IUnknown",
    iid: IID_IDirect3DExecuteBuffer,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 3),      // Slot 3
        makeMethod("Lock", 2),            // Slot 4
        makeMethod("Unlock", 1),          // Slot 5
        makeMethod("SetExecuteData", 2),  // Slot 6
        makeMethod("GetExecuteData", 2),  // Slot 7
        makeMethod("Validate", 5),        // Slot 8: (this, lpdwOffset, lpFunc, lpUserArg, dwReserved)
        makeMethod("Optimize", 2),        // Slot 9
    ],
};

// IDirect3DDevice2 interface - based on DirectX 5 SDK
// Key difference from Device3: has SwapTextureHandles at index 4, no strided/VB draw methods
export const IDirect3DDevice2: InterfaceDescriptor = {
    name: "IDirect3DDevice2",
    inherits: "IUnknown",
    iid: IID_IDirect3DDevice2,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetCaps", 3),
        makeMethod("SwapTextureHandles", 3),    // Device2 only — absent in Device3
        makeMethod("GetStats", 2),
        makeMethod("AddViewport", 2),
        makeMethod("DeleteViewport", 2),
        makeMethod("NextViewport", 4),
        makeMethod("EnumTextureFormats", 3),
        makeMethod("BeginScene", 1),
        makeMethod("EndScene", 1),
        makeMethod("GetDirect3D", 2),
        makeMethod("SetCurrentViewport", 2),
        makeMethod("GetCurrentViewport", 2),
        makeMethod("SetRenderTarget", 3),
        makeMethod("GetRenderTarget", 2),
        makeMethod("Begin", 4),
        makeMethod("BeginIndexed", 6),
        makeMethod("Vertex", 2),
        makeMethod("Index", 2),
        makeMethod("End", 2),
        makeMethod("GetRenderState", 3),
        makeMethod("SetRenderState", 3),
        makeMethod("GetLightState", 3),
        makeMethod("SetLightState", 3),
        makeMethod("SetTransform", 3),
        makeMethod("GetTransform", 3),
        makeMethod("MultiplyTransform", 3),
        makeMethod("DrawPrimitive", 6),
        makeMethod("DrawIndexedPrimitive", 8),
        makeMethod("SetClipStatus", 2),
        makeMethod("GetClipStatus", 2),
    ],
};

// IDirect3DDevice3 interface - based on DirectX 5 SDK
export const IDirect3DDevice3: InterfaceDescriptor = {
    name: "IDirect3DDevice3",
    inherits: "IUnknown",
    iid: IID_IDirect3DDevice3V5,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetCaps", 3),
        makeMethod("GetStats", 2),
        makeMethod("AddViewport", 2),
        makeMethod("DeleteViewport", 2),
        makeMethod("NextViewport", 4),
        makeMethod("EnumTextureFormats", 3),
        makeMethod("BeginScene", 1),
        makeMethod("EndScene", 1),
        makeMethod("GetDirect3D", 2),
        makeMethod("SetCurrentViewport", 2),
        makeMethod("GetCurrentViewport", 2),
        makeMethod("SetRenderTarget", 3),
        makeMethod("GetRenderTarget", 2),
        makeMethod("Begin", 4),
        makeMethod("BeginIndexed", 6),
        makeMethod("Vertex", 2),
        makeMethod("Index", 2),
        makeMethod("End", 2),
        makeMethod("GetRenderState", 3),
        makeMethod("SetRenderState", 3),
        makeMethod("GetLightState", 3),
        makeMethod("SetLightState", 3),
        makeMethod("SetTransform", 3),
        makeMethod("GetTransform", 3),
        makeMethod("MultiplyTransform", 3),
        makeMethod("DrawPrimitive", 6),
        makeMethod("DrawIndexedPrimitive", 8),
        makeMethod("SetClipStatus", 2),
        makeMethod("GetClipStatus", 2),
        makeMethod("DrawPrimitiveStrided", 6),
        makeMethod("DrawIndexedPrimitiveStrided", 8),
        makeMethod("DrawPrimitiveVB", 6),
        makeMethod("DrawIndexedPrimitiveVB", 6),
        makeMethod("ComputeSphereVisibility", 6),
        makeMethod("GetTexture", 3),
        makeMethod("SetTexture", 3),
        makeMethod("GetTextureStageState", 4),
        makeMethod("SetTextureStageState", 4),
        makeMethod("ValidateDevice", 2),
    ],
};

// IDirect3DViewport3 interface - based on DirectX 6 SDK
export const IDirect3DViewport3: InterfaceDescriptor = {
    name: "IDirect3DViewport3",
    inherits: "IUnknown",
    iid: IID_IDirect3DViewport3,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 2),
        makeMethod("GetViewport", 2),
        makeMethod("SetViewport", 2),
        makeMethod("TransformVertices", 5),
        makeMethod("LightElements", 3),
        makeMethod("SetBackground", 2),
        makeMethod("GetBackground", 3),
        makeMethod("SetBackgroundDepth", 2),
        makeMethod("GetBackgroundDepth", 3),
        makeMethod("Clear", 4),
        makeMethod("AddLight", 2),
        makeMethod("DeleteLight", 2),
        makeMethod("NextLight", 4),
        makeMethod("GetViewport2", 2),
        makeMethod("SetViewport2", 2),
        makeMethod("SetBackgroundDepth2", 2),
        makeMethod("GetBackgroundDepth2", 3),
        makeMethod("Clear2", 7),
    ],
};

// IDirect3DViewport2 interface - based on DirectX 5 SDK
export const IDirect3DViewport2: InterfaceDescriptor = {
    name: "IDirect3DViewport2",
    inherits: "IUnknown",
    iid: IID_IDirect3DViewport2,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 2),
        makeMethod("GetViewport", 2),
        makeMethod("SetViewport", 2),
        makeMethod("TransformVertices", 5),
        makeMethod("LightElements", 3),
        makeMethod("SetBackground", 2),
        makeMethod("GetBackground", 3),
        makeMethod("SetBackgroundDepth", 2),
        makeMethod("GetBackgroundDepth", 3),
        makeMethod("Clear", 4),
        makeMethod("AddLight", 2),
        makeMethod("DeleteLight", 2),
        makeMethod("NextLight", 4),
        makeMethod("GetViewport2", 2),
        makeMethod("SetViewport2", 2),
    ],
};

// IDirect3DTexture interface - based on DirectX 5 SDK
export const IDirect3DTexture: InterfaceDescriptor = {
    name: "IDirect3DTexture",
    inherits: "IUnknown",
    iid: IID_IDirect3DTexture,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 3),
        makeMethod("GetHandle", 3),
        makeMethod("PaletteChanged", 3),
        makeMethod("Load", 2),
        makeMethod("Unload", 1),
    ],
};

// IDirect3DTexture2 interface - based on DirectX 6 SDK
export const IDirect3DTexture2: InterfaceDescriptor = {
    name: "IDirect3DTexture2",
    inherits: "IUnknown",
    iid: IID_IDirect3DTexture2,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetHandle", 3),
        makeMethod("PaletteChanged", 3),
        makeMethod("Load", 2),
    ],
};

// IDirect3DDevice7 interface - based on DirectX 7 SDK
export const IDirect3DDevice7: InterfaceDescriptor = {
    name: "IDirect3DDevice7",
    inherits: "IUnknown",
    iid: IID_IDirect3DDevice7,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetCaps", 2),
        makeMethod("EnumTextureFormats", 3),
        makeMethod("BeginScene", 1),
        makeMethod("EndScene", 1),
        makeMethod("GetDirect3D", 2),
        makeMethod("SetRenderTarget", 3),
        makeMethod("GetRenderTarget", 2),
        makeMethod("Clear", 7),
        makeMethod("SetTransform", 3),
        makeMethod("GetTransform", 3),
        makeMethod("SetViewport", 2),
        makeMethod("MultiplyTransform", 3),
        makeMethod("GetViewport", 2),
        makeMethod("SetMaterial", 2),
        makeMethod("GetMaterial", 2),
        makeMethod("SetLight", 3),
        makeMethod("GetLight", 3),
        makeMethod("SetRenderState", 3),
        makeMethod("GetRenderState", 3),
        makeMethod("BeginStateBlock", 1),
        makeMethod("EndStateBlock", 2),
        makeMethod("PreLoad", 2),
        makeMethod("DrawPrimitive", 6),
        makeMethod("DrawIndexedPrimitive", 8),
        makeMethod("SetClipStatus", 2),
        makeMethod("GetClipStatus", 2),
        makeMethod("DrawPrimitiveStrided", 6),
        makeMethod("DrawIndexedPrimitiveStrided", 8),
        makeMethod("DrawPrimitiveVB", 6),
        makeMethod("DrawIndexedPrimitiveVB", 8),
        makeMethod("ComputeSphereVisibility", 6),
        makeMethod("GetTexture", 3),
        makeMethod("SetTexture", 3),
        makeMethod("GetTextureStageState", 4),
        makeMethod("SetTextureStageState", 4),
        makeMethod("ValidateDevice", 2),
        makeMethod("ApplyStateBlock", 2),
        makeMethod("CaptureStateBlock", 2),
        makeMethod("DeleteStateBlock", 2),
        makeMethod("CreateStateBlock", 3),
        makeMethod("Load", 6),
        makeMethod("LightEnable", 3),
        makeMethod("GetLightEnable", 3),
        makeMethod("SetClipPlane", 3),
        makeMethod("GetClipPlane", 3),
        makeMethod("GetInfo", 4),
    ],
};

// IDirectDrawGammaControl interface - gamma ramp control for primary surfaces
export const IDirectDrawGammaControl: InterfaceDescriptor = {
    name: "IDirectDrawGammaControl",
    inherits: "IUnknown",
    iid: IID_IDirectDrawGammaControl,
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetGammaRamp", 3),    // cParams=2 (dwFlags, lpRampData) +1=3
        makeMethod("SetGammaRamp", 3),    // cParams=2 (dwFlags, lpRampData) +1=3
    ],
};

export const ddrawModule: ModuleDescriptor = {
    name: "ddraw",
    version: "7.0",
    description: "DirectDraw graphics stubs",
    functions: [
        {
            name: "DirectDrawEnumerateA",
            params: [
                { name: "lpCallback", type: "ptr", direction: "in" },
                { name: "lpContext", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
            description: "Enumerate DirectDraw devices",
        },
        {
            name: "DirectDrawEnumerateExA",
            params: [
                { name: "lpCallback", type: "ptr", direction: "in" },
                { name: "lpContext", type: "ptr", optional: true },
                { name: "dwFlags", type: "u32" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
            description: "Enumerate DirectDraw devices (extended)",
        },
        {
            name: "DirectDrawCreate",
            params: [
                { name: "lpGUID", type: "ptr", optional: true },
                { name: "lplpDD", type: "ptr", direction: "out" },
                { name: "pUnkOuter", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectDrawCreateEx",
            params: [
                { name: "lpGUID", type: "ptr", optional: true },
                { name: "lplpDD", type: "ptr", direction: "out" },
                { name: "iid", type: "ptr", direction: "in" },
                { name: "pUnkOuter", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectDrawCreateClipper",
            params: [
                { name: "dwFlags", type: "u32" },
                { name: "lplpDDClipper", type: "ptr", direction: "out" },
                { name: "pUnkOuter", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "SetAppCompatData",
            params: [
                { name: "dwType", type: "u32" },
                { name: "dwData", type: "u32" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
            description: "Undocumented DirectDraw app compatibility hook (ordinal 22)",
        },
    ],
    interfaces: [
        IDirectDraw,
        IDirectDraw2,
        IDirectDrawSurface,
        IDirectDraw4,
        IDirectDrawSurface4,
        IDirectDraw7,
        IDirectDrawSurface7,
        IDirectDrawClipper,
        IDirectDrawPalette,
        IDirect3D,
        IDirect3D2,
        IDirect3D3,
        IDirect3DDevice,
        IDirect3DDevice2,
        IDirect3DDevice3,
        IDirect3DExecuteBuffer,
        IDirect3DViewport3,
        IDirect3DViewport2,
        IDirect3DTexture,
        IDirect3DTexture2,
        IDirect3D7,
        IDirect3DDevice7,
        IDirectDrawGammaControl,
        IDirect3DLight,
        IDirect3DMaterial,
        IDirect3DMaterial2,
        IDirect3DMaterial3,
        IDirect3DVertexBuffer,
        IDirect3DVertexBuffer7,
    ],
};
