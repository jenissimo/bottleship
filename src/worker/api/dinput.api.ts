/**
 * DirectInput API Descriptor
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

const makeFunc = (
    name: string,
    argCount: number,
    overrides: Partial<FunctionDescriptor> = {}
): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
    async: overrides.async,
    category: overrides.category,
    description: overrides.description,
});

const makeMethod = (
    name: string,
    argCount: number,
    overrides: Partial<FunctionDescriptor> = {}
): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
    async: overrides.async,
    category: overrides.category,
    description: overrides.description,
});

// IDirectInputA interface - based on DirectInput 8 SDK
// Method order must match dinput.h exactly!
export const IDirectInputA: InterfaceDescriptor = {
    name: "IDirectInputA",
    inherits: "IUnknown",
    iid: "89521360-AA8A-11CF-BFC7-444553540000",
    methods: [
        ...IUnknown.methods,
        makeMethod("CreateDevice", 4),
        makeMethod("EnumDevices", 5),
        makeMethod("GetDeviceStatus", 2),
        makeMethod("RunControlPanel", 3),
        makeMethod("Initialize", 3),
    ],
};

// IDirectInput7A — what a DX7 title asks DirectInputCreateEx for. Extends IDirectInputA
// with FindDevice (IDirectInput2, index 8) and CreateDeviceEx (IDirectInput7, index 9).
// Handing back the shorter IDirectInputA vtable for this IID is the same defect the
// IDirectInput8A comment below describes, one interface generation earlier.
export const IDirectInput7A: InterfaceDescriptor = {
    name: "IDirectInput7A",
    inherits: "IUnknown",
    iid: "9a4cb684-236d-11d3-8e9d-00c04f6844ae",
    methods: [
        ...IUnknown.methods,
        makeMethod("CreateDevice", 4),
        makeMethod("EnumDevices", 5),
        makeMethod("GetDeviceStatus", 2),
        makeMethod("RunControlPanel", 3),
        makeMethod("Initialize", 3),
        makeMethod("FindDevice", 4),
        makeMethod("CreateDeviceEx", 5),
    ],
};

// IDirectInput8A interface — DirectInput8Create returns this. Method order must match
// dinput.h's IDirectInput8 vtable EXACTLY. It extends the IDirectInput7/A layout with
// three DX8-only methods (FindDevice, EnumDevicesBySemantics, ConfigureDevices). A game
// that calls one of those (e.g. EnumDevicesBySemantics at vtable index 9 / offset 0x24)
// on a too-short DX7 vtable reads past its end → wild indirect call (NFSU freeze/OOB).
export const IDirectInput8A: InterfaceDescriptor = {
    name: "IDirectInput8A",
    inherits: "IUnknown",
    iid: "bf798030-483a-4da2-aa99-5d64ed369700",
    methods: [
        ...IUnknown.methods,
        makeMethod("CreateDevice", 4),
        makeMethod("EnumDevices", 5),
        makeMethod("GetDeviceStatus", 2),
        makeMethod("RunControlPanel", 3),
        makeMethod("Initialize", 3),
        makeMethod("FindDevice", 4),
        makeMethod("EnumDevicesBySemantics", 6),
        makeMethod("ConfigureDevices", 5),
    ],
};

// IDirectInput8W — UNICODE build / CoCreateInstance(CLSID_DirectInput8, IID_IDirectInput8W).
// Vtable layout is identical to IDirectInput8A; only string parameters differ (LPCWSTR vs LPCSTR).
export const IDirectInput8W: InterfaceDescriptor = {
    name: "IDirectInput8W",
    inherits: "IUnknown",
    iid: "bf798031-483a-4da2-aa99-5d64ed369700",
    methods: IDirectInput8A.methods.map(m => ({ ...m, name: m.name })),
};

// IDirectInputDeviceA interface
export const IDirectInputDeviceA: InterfaceDescriptor = {
    name: "IDirectInputDeviceA",
    inherits: "IUnknown",
    iid: "5944e680-c92e-11cf-bfc7-444553540000",
    methods: [
        ...IUnknown.methods,
        makeMethod("GetCapabilities", 2),
        makeMethod("EnumObjects", 4),
        makeMethod("GetProperty", 3),
        makeMethod("SetProperty", 3),
        makeMethod("Acquire", 1),
        makeMethod("Unacquire", 1),
        makeMethod("GetDeviceState", 3),
        makeMethod("GetDeviceData", 5),
        makeMethod("SetDataFormat", 2),
        makeMethod("SetEventNotification", 2),
        makeMethod("SetCooperativeLevel", 3),
        makeMethod("GetObjectInfo", 4),
        makeMethod("GetDeviceInfo", 2),
        makeMethod("RunControlPanel", 3),
        makeMethod("Initialize", 4),
    ],
};

// IDirectInputDevice2A interface
export const IDirectInputDevice2A: InterfaceDescriptor = {
    name: "IDirectInputDevice2A",
    inherits: "IDirectInputDeviceA",
    iid: "5944e682-c92e-11cf-bfc7-444553540000",
    methods: [
        ...IDirectInputDeviceA.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("CreateEffect", 5),
        makeMethod("EnumEffects", 4),
        makeMethod("GetEffectInfo", 3),
        makeMethod("GetForceFeedbackState", 2),
        makeMethod("SendForceFeedbackCommand", 2),
        makeMethod("EnumCreatedEffectObjects", 4),
        makeMethod("Escape", 2),
        makeMethod("Poll", 1),
        makeMethod("SendDeviceData", 5),
    ],
};

// IDirectInputDevice8A interface — returned by IDirectInput8::CreateDevice and synthesized
// by EnumDevicesBySemantics. Extends the IDirectInputDevice2A vtable (which already ends at
// Poll/SendDeviceData) with the DI7 file-effect methods and the three DI8 action-mapping
// methods. Method order must match dinput.h's IDirectInputDevice8 vtable EXACTLY:
//   ...SendDeviceData(26), EnumEffectsInFile(27), WriteEffectToFile(28),
//   BuildActionMap(29 / +0x74), SetActionMap(30 / +0x78), GetImageInfo(31 / +0x7c).
// A game that calls BuildActionMap/SetActionMap on a too-short DX7/Device2A vtable reads past
// its end → wild indirect call (the same failure class as the IDirectInput8A EnumDevicesBySemantics
// gap). NFSU's keyboard setup is exactly Build×N + SetActionMap on this interface.
export const IDirectInputDevice8A: InterfaceDescriptor = {
    name: "IDirectInputDevice8A",
    inherits: "IDirectInputDevice7A",
    iid: "54d41080-dc15-4833-a41b-748f73a38179",
    methods: [
        ...IDirectInputDevice2A.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("EnumEffectsInFile", 5),
        makeMethod("WriteEffectToFile", 5),
        makeMethod("BuildActionMap", 4),
        makeMethod("SetActionMap", 4),
        makeMethod("GetImageInfo", 2),
    ],
};

// IDirectInputDevice8W — returned by IDirectInput8W::CreateDevice / EnumDevicesBySemantics.
// Vtable layout is identical to the A form; the ANSI/UNICODE families are separate inheritance
// chains (…DeviceW → …Device2W → …Device7W → …Device8W), so the parent must stay W-side.
export const IDirectInputDevice8W: InterfaceDescriptor = {
    name: "IDirectInputDevice8W",
    inherits: "IDirectInputDevice7W",
    iid: "54d41081-dc15-4833-a41b-748f73a38179",
    methods: IDirectInputDevice8A.methods.map(m => ({ ...m, name: m.name })),
};

export const dinputModule: ModuleDescriptor = {
    name: "dinput",
    version: "8.0",
    description: "DirectInput input stubs",
    functions: [
        // DirectInputCreateA: HRESULT DirectInputCreateA(HINSTANCE hinst, DWORD dwVersion, LPDIRECTINPUTA *ppDI, LPUNKNOWN punkOuter)
        makeFunc("DirectInputCreateA", 4, {
            params: [
                { name: "hinst", type: "u32" },
                { name: "dwVersion", type: "u32" },
                { name: "ppDI", type: "ptr" },
                { name: "punkOuter", type: "ptr" },
            ],
            category: "DirectInput",
            description: "Creates a DirectInput object",
        }),
        // DirectInputCreateEx: HRESULT DirectInputCreateEx(HINSTANCE hinst, DWORD dwVersion, REFIID riid, LPVOID *ppvOut, LPUNKNOWN punkOuter)
        makeFunc("DirectInputCreateEx", 5, {
            params: [
                { name: "hinst", type: "u32" },
                { name: "dwVersion", type: "u32" },
                { name: "riid", type: "ptr" },
                { name: "ppvOut", type: "ptr" },
                { name: "punkOuter", type: "ptr" },
            ],
            category: "DirectInput",
            description: "Creates a DirectInput object with specific IID",
        }),
        // DirectInput8Create: HRESULT DirectInput8Create(HINSTANCE hinst, DWORD dwVersion, REFIID riidltf, LPVOID *ppvOut, LPUNKNOWN punkOuter)
        makeFunc("DirectInput8Create", 5, {
            params: [
                { name: "hinst", type: "u32" },
                { name: "dwVersion", type: "u32" },
                { name: "riidltf", type: "ptr" },
                { name: "ppvOut", type: "ptr" },
                { name: "punkOuter", type: "ptr" },
            ],
            category: "DirectInput",
            description: "Creates a DirectInput8 object",
        }),
    ],
    interfaces: [
        IDirectInputA,
        IDirectInput7A,
        IDirectInput8A,
        IDirectInput8W,
        IDirectInputDeviceA,
        IDirectInputDevice2A,
        IDirectInputDevice8A,
        IDirectInputDevice8W,
    ],
};
