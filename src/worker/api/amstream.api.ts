/**
 * DirectShow multimedia streaming (amstream.dll) API descriptor.
 *
 * CLSID_AMMultiMediaStream is how DX6/DX7-era titles pull movie frames into their own
 * DirectDraw surfaces. Vtable SLOT ORDER is the contract: every list is the full
 * inheritance chain in mmstream.h / amstream.h / ddstream.h declaration order.
 */

import { FunctionDescriptor, InterfaceDescriptor, IUnknown, ModuleDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: i === 0 ? "this" : `arg${i}`, type: i === 0 ? "ptr" : "u32" });
    }
    return params;
};

/** argCount INCLUDES `this`; a STREAM_TIME (LONGLONG) argument counts as two. */
const m = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
});

const unknown = () => IUnknown.methods.map(x => ({ ...x }));

const multiMediaStream = (): FunctionDescriptor[] => [
    ...unknown(),
    m("GetInformation", 3),
    m("GetMediaStream", 3),
    m("EnumMediaStreams", 3),
    m("GetState", 2),
    m("SetState", 2),
    m("GetTime", 2),
    m("GetDuration", 2),
    m("Seek", 3),
    m("GetEndOfStreamEventHandle", 2),
];

const mediaStream = (): FunctionDescriptor[] => [
    ...unknown(),
    m("GetMultiMediaStream", 2),
    m("GetInformation", 3),
    m("SetSameFormat", 3),
    m("AllocateSample", 3),
    m("CreateSharedSample", 4),
    m("SendEndOfStream", 2),
];

const streamSample = (): FunctionDescriptor[] => [
    ...unknown(),
    m("GetMediaStream", 2),
    m("GetSampleTimes", 4),
    m("SetSampleTimes", 3),
    m("Update", 5),
    m("CompletionStatus", 3),
];

export const IAMMultiMediaStream: InterfaceDescriptor = {
    name: "IAMMultiMediaStream",
    inherits: "IUnknown",
    iid: "bebe595c-9a6f-11d0-8fde-00c04fd9189d",
    methods: [
        ...multiMediaStream(),
        m("Initialize", 4),
        m("GetFilterGraph", 2),
        m("GetFilter", 2),
        m("AddMediaStream", 5),
        m("OpenFile", 3),
        m("OpenMoniker", 4),
        m("Render", 2),
    ],
};

export const IDirectDrawMediaStream: InterfaceDescriptor = {
    name: "IDirectDrawMediaStream",
    inherits: "IUnknown",
    iid: "f4104fce-9a70-11d0-8fde-00c04fd9189d",
    methods: [
        ...mediaStream(),
        m("GetFormat", 5),
        m("SetFormat", 3),
        m("GetDirectDraw", 2),
        m("SetDirectDraw", 2),
        m("CreateSample", 5),
        m("GetTimePerFrame", 2),
    ],
};

export const IDirectDrawStreamSample: InterfaceDescriptor = {
    name: "IDirectDrawStreamSample",
    inherits: "IUnknown",
    iid: "f4104fcf-9a70-11d0-8fde-00c04fd9189d",
    methods: [
        ...streamSample(),
        m("GetSurface", 3),
        m("SetRect", 2),
    ],
};

export const amstreamModule: ModuleDescriptor = {
    name: "amstream",
    version: "6.0",
    description: "DirectShow multimedia streaming: movie frames into application DirectDraw surfaces",
    functions: [],
    interfaces: [IAMMultiMediaStream, IDirectDrawMediaStream, IDirectDrawStreamSample],
};
