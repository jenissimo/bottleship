/**
 * DirectSound API Descriptor (minimal)
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
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
    async: overrides.async,
    category: overrides.category,
    description: overrides.description,
});

export const IDirectSound8: InterfaceDescriptor = {
    name: "IDirectSound8",
    inherits: "IUnknown",
    iid: "C50A7E93-F395-4834-9EF6-7FA99DE50966",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("CreateSoundBuffer", 4),
        makeMethod("GetCaps", 2),
        makeMethod("DuplicateSoundBuffer", 3),
        makeMethod("SetCooperativeLevel", 3),
        makeMethod("Compact", 1),
        makeMethod("GetSpeakerConfig", 2),
        makeMethod("SetSpeakerConfig", 2),
        makeMethod("Initialize", 2),
        makeMethod("VerifyCertification", 2),
    ],
};

const bufferMethodSpecs = [
    { name: "GetCaps", args: 2 },
    { name: "GetCurrentPosition", args: 3 },
    { name: "GetFormat", args: 4 },
    { name: "GetVolume", args: 2 },
    { name: "GetPan", args: 2 },
    { name: "GetFrequency", args: 2 },
    { name: "GetStatus", args: 2 },
    { name: "Initialize", args: 3 },
    { name: "Lock", args: 8 },
    { name: "Play", args: 4 },
    { name: "SetCurrentPosition", args: 2 },
    { name: "SetFormat", args: 2 },
    { name: "SetVolume", args: 2 },
    { name: "SetPan", args: 2 },
    { name: "SetFrequency", args: 2 },
    { name: "Stop", args: 1 },
    { name: "Unlock", args: 5 },
    { name: "Restore", args: 1 },
    { name: "SetFX", args: 4 },
    { name: "AcquireResources", args: 4 },
    { name: "GetObjectInPath", args: 5 },
];

export const IDirectSoundBuffer8: InterfaceDescriptor = {
    name: "IDirectSoundBuffer8",
    inherits: "IUnknown",
    iid: "6825A449-7524-4D82-920F-50E36AB3AB1E",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...bufferMethodSpecs.map(spec => makeMethod(spec.name, spec.args)),
    ],
};

export const IDirectSoundCapture: InterfaceDescriptor = {
    name: "IDirectSoundCapture",
    inherits: "IUnknown",
    iid: "B0210781-89CD-11D0-AF08-00A0C925CD16",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("CreateCaptureBuffer", 4),
        makeMethod("GetCaps", 2),
        makeMethod("Initialize", 2),
    ],
};

const captureBufferMethodSpecs = [
    { name: "GetCaps", args: 2 },
    { name: "GetCurrentPosition", args: 3 },
    { name: "GetFormat", args: 4 },
    { name: "GetStatus", args: 2 },
    { name: "Initialize", args: 3 },
    { name: "Lock", args: 8 },
    { name: "Start", args: 2 },
    { name: "Stop", args: 1 },
    { name: "Unlock", args: 5 },
    { name: "GetObjectInPath", args: 5 },
    { name: "GetFXStatus", args: 3 },
];

export const IDirectSoundCaptureBuffer8: InterfaceDescriptor = {
    name: "IDirectSoundCaptureBuffer8",
    inherits: "IUnknown",
    iid: "00990DF4-0DBB-4872-833E-6D303E80AEB6",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        ...captureBufferMethodSpecs.map(spec => makeMethod(spec.name, spec.args)),
    ],
};

export const IDirectSoundNotify: InterfaceDescriptor = {
    name: "IDirectSoundNotify",
    inherits: "IUnknown",
    iid: "B0210783-89CD-11D0-AF08-00A0C925CD16",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("SetNotificationPositions", 3),
    ],
};

export const IDirectSound3DListener: InterfaceDescriptor = {
    name: "IDirectSound3DListener",
    inherits: "IUnknown",
    iid: "279AFA84-4981-11CE-A521-0020AF0BE560",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetAllParameters", 2),
        makeMethod("GetDistanceFactor", 2),
        makeMethod("GetDopplerFactor", 2),
        // GetOrientation returns front and top as two SEPARATE D3DVECTOR out-pointers.
        makeMethod("GetOrientation", 3),
        makeMethod("GetPosition", 2),
        makeMethod("GetRolloffFactor", 2),
        makeMethod("GetVelocity", 2),
        makeMethod("SetAllParameters", 3),
        makeMethod("SetDistanceFactor", 3),
        makeMethod("SetDopplerFactor", 3),
        makeMethod("SetOrientation", 8),
        makeMethod("SetPosition", 5),
        makeMethod("SetRolloffFactor", 3),
        makeMethod("SetVelocity", 5),
        makeMethod("CommitDeferredSettings", 1),
    ],
};

export const IDirectSound3DBuffer: InterfaceDescriptor = {
    name: "IDirectSound3DBuffer",
    inherits: "IUnknown",
    iid: "279AFA86-4981-11CE-A521-0020AF0BE560",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("GetAllParameters", 2),
        makeMethod("GetConeAngles", 3),
        makeMethod("GetConeOrientation", 2),
        makeMethod("GetConeOutsideVolume", 2),
        makeMethod("GetMaxDistance", 2),
        makeMethod("GetMinDistance", 2),
        makeMethod("GetMode", 2),
        makeMethod("GetPosition", 2),
        makeMethod("GetVelocity", 2),
        makeMethod("SetAllParameters", 3),
        makeMethod("SetConeAngles", 4),
        makeMethod("SetConeOrientation", 5),
        makeMethod("SetConeOutsideVolume", 3),
        makeMethod("SetMaxDistance", 3),
        makeMethod("SetMinDistance", 3),
        makeMethod("SetMode", 3),
        makeMethod("SetPosition", 5),
        makeMethod("SetVelocity", 5),
    ],
};

export const dsoundModule: ModuleDescriptor = {
    name: "dsound",
    version: "8.0",
    description: "DirectSound audio stubs",
    functions: [
        {
            name: "DirectSoundCreate8",
            ordinal: 11, // ord_11 in dsound.dll
            params: [
                { name: "lpcGuidDevice", type: "ptr", optional: true },
                { name: "ppDS8", type: "ptr", direction: "out" },
                { name: "pUnkOuter", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectSoundCreate",
            ordinal: 1, // ord_1 in dsound.dll
            params: [
                { name: "lpcGuidDevice", type: "ptr", optional: true },
                { name: "ppDS", type: "ptr", direction: "out" },
                { name: "pUnkOuter", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectSoundCaptureCreate",
            ordinal: 6, // ord_6 in dsound.dll
            params: [
                { name: "lpcGuidDevice", type: "ptr", optional: true },
                { name: "ppDSC", type: "ptr", direction: "out" },
                { name: "pUnkOuter", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectSoundEnumerateA",
            ordinal: 2, // ord_2 in dsound.dll
            params: [
                { name: "lpDSEnumCallback", type: "ptr" },
                { name: "lpContext", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectSoundEnumerateW",
            ordinal: 3, // ord_3 in dsound.dll
            params: [
                { name: "lpDSEnumCallback", type: "ptr" },
                { name: "lpContext", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectSoundCaptureEnumerateA",
            ordinal: 7,
            params: [
                { name: "lpDSEnumCallback", type: "ptr" },
                { name: "lpContext", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectSoundCaptureEnumerateW",
            ordinal: 8,
            params: [
                { name: "lpDSEnumCallback", type: "ptr" },
                { name: "lpContext", type: "ptr", optional: true },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "GetDeviceID",
            ordinal: 9,
            params: [
                { name: "pGuidSrc", type: "ptr" },
                { name: "pGuidDest", type: "ptr", direction: "out" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
    ],
    interfaces: [
        IDirectSound8,
        IDirectSoundBuffer8,
        IDirectSoundNotify,
        IDirectSoundCapture,
        IDirectSoundCaptureBuffer8,
        IDirectSound3DListener,
        IDirectSound3DBuffer,
    ],
};
