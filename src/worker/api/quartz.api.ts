/**
 * DirectShow (quartz.dll) API Descriptor — minimal FilterGraph for AVI cutscenes.
 *
 * Interfaces: IGraphBuilder, IMediaControl, IMediaPosition, IMediaEvent, IVideoWindow, IBasicAudio.
 * IMediaControl/IMediaPosition/IMediaEvent/IVideoWindow/IBasicAudio inherit from
 * IDispatch (IUnknown + 4 methods).
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
    description: overrides.description,
});

// IFilterGraph methods (vtable slots 3-10, after IUnknown)
// IFilterGraph: AddFilter, RemoveFilter, EnumFilters, FindFilterByName, ConnectDirect, Reconnect, Disconnect, SetDefaultSyncSource
// IGraphBuilder adds: Connect, Render, RenderFile, AddSourceFilter, SetLogFile, Abort, ShouldOperationContinue

export const IGraphBuilder: InterfaceDescriptor = {
    name: "IGraphBuilder",
    inherits: "IUnknown",
    iid: "56a868a9-0ad4-11ce-b03a-0020af0ba770",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IFilterGraph methods (slots 3-10)
        makeMethod("AddFilter", 3),
        makeMethod("RemoveFilter", 2),
        makeMethod("EnumFilters", 2),
        makeMethod("FindFilterByName", 3),
        makeMethod("ConnectDirect", 4),
        makeMethod("Reconnect", 2),
        makeMethod("Disconnect", 2),
        makeMethod("SetDefaultSyncSource", 1),
        // IGraphBuilder methods (slots 11-17)
        makeMethod("Connect", 3),
        makeMethod("Render", 2),
        makeMethod("RenderFile", 3, { async: true }),
        makeMethod("AddSourceFilter", 4),
        makeMethod("SetLogFile", 2),
        makeMethod("Abort", 1),
        makeMethod("ShouldOperationContinue", 1),
    ],
};

// IMediaControl VTable layout:
// 0-2: IUnknown (QI, AddRef, Release)
// 3-6: IDispatch (GetTypeInfoCount, GetTypeInfo, GetIDsOfNames, Invoke)
// 7+:  IMediaControl (Run, Pause, Stop, GetState, RenderFile, AddSourceFilter, get_FilterCollection, get_RegFilterCollection, StopWhenReady)
export const IMediaControl: InterfaceDescriptor = {
    name: "IMediaControl",
    inherits: "IUnknown",
    iid: "56a868b1-0ad4-11ce-b03a-0020af0ba770",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IDispatch methods (slots 3-6)
        makeMethod("GetTypeInfoCount", 2),
        makeMethod("GetTypeInfo", 4),
        makeMethod("GetIDsOfNames", 6),
        makeMethod("Invoke", 9),
        // IMediaControl methods (slots 7-15)
        makeMethod("Run", 1),
        makeMethod("Pause", 1),
        makeMethod("Stop", 1),
        makeMethod("GetState", 3),
        makeMethod("RenderFile", 2),
        makeMethod("AddSourceFilter", 3),
        makeMethod("get_FilterCollection", 2),
        makeMethod("get_RegFilterCollection", 2),
        makeMethod("StopWhenReady", 1),
    ],
};

// IMediaPosition VTable layout:
// 0-2: IUnknown
// 3-6: IDispatch
// 7-17: IMediaPosition
// REFTIME is a double passed by value, so put_* methods use 3 dwords:
// `this` + low/high dwords of the 8-byte double, i.e. RET 12.
export const IMediaPosition: InterfaceDescriptor = {
    name: "IMediaPosition",
    inherits: "IUnknown",
    iid: "56a868b2-0ad4-11ce-b03a-0020af0ba770",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IDispatch methods (slots 3-6)
        makeMethod("GetTypeInfoCount", 2),
        makeMethod("GetTypeInfo", 4),
        makeMethod("GetIDsOfNames", 6),
        makeMethod("Invoke", 9),
        // IMediaPosition methods (slots 7-17)
        makeMethod("get_Duration", 2),
        makeMethod("put_CurrentPosition", 3),
        makeMethod("get_CurrentPosition", 2),
        makeMethod("get_StopTime", 2),
        makeMethod("put_StopTime", 3),
        makeMethod("get_PrerollTime", 2),
        makeMethod("put_PrerollTime", 3),
        makeMethod("put_Rate", 3),
        makeMethod("get_Rate", 2),
        makeMethod("CanSeekForward", 2),
        makeMethod("CanSeekBackward", 2),
    ],
};

// IMediaEvent VTable layout:
// 0-2: IUnknown
// 3-6: IDispatch
// 7-12: IMediaEvent (GetEventHandle, GetEvent, WaitForCompletion, CancelDefaultHandling, RestoreDefaultHandling, FreeEventParams)
export const IMediaEvent: InterfaceDescriptor = {
    name: "IMediaEvent",
    inherits: "IUnknown",
    iid: "56a868b6-0ad4-11ce-b03a-0020af0ba770",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IDispatch methods (slots 3-6)
        makeMethod("GetTypeInfoCount", 2),
        makeMethod("GetTypeInfo", 4),
        makeMethod("GetIDsOfNames", 6),
        makeMethod("Invoke", 9),
        // IMediaEvent methods (slots 7-12)
        makeMethod("GetEventHandle", 2),
        makeMethod("GetEvent", 5),
        makeMethod("WaitForCompletion", 3, { async: true }),
        makeMethod("CancelDefaultHandling", 2),
        makeMethod("RestoreDefaultHandling", 2),
        makeMethod("FreeEventParams", 4),
    ],
};

// IBasicVideo VTable: IUnknown(3) + IDispatch(4) + IBasicVideo(32). Ground-truthed
// against the real DirectShow IDL (control.odl, IID confirmed at 56a868b5): AvgTimePerFrame
// is propget-only (no setter — frame rate isn't externally settable), which is why
// GetVideoSize lands at absolute slot 34 (7 + 27) instead of 35. Max Payne queries this
// directly off the FilterGraph (separately from IVideoWindow) to size its CWnd via
// GetVideoSize — verified live: MaxPayne.exe calls vtable+0x88 (slot 34) with exactly
// (this, long* pWidth, long* pHeight) right after querying this IID.
export const IBasicVideo: InterfaceDescriptor = {
    name: "IBasicVideo",
    inherits: "IUnknown",
    iid: "56a868b5-0ad4-11ce-b03a-0020af0ba770",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IDispatch methods (slots 3-6)
        makeMethod("GetTypeInfoCount", 2),
        makeMethod("GetTypeInfo", 4),
        makeMethod("GetIDsOfNames", 6),
        makeMethod("Invoke", 9),
        // IBasicVideo methods (slots 7-38)
        makeMethod("get_AvgTimePerFrame", 2), // REFTIME* out — no setter, unlike its siblings
        makeMethod("get_BitRate", 2),
        makeMethod("get_BitErrorRate", 2),
        makeMethod("get_VideoWidth", 2),
        makeMethod("get_VideoHeight", 2),
        makeMethod("put_SourceLeft", 2),
        makeMethod("get_SourceLeft", 2),
        makeMethod("put_SourceWidth", 2),
        makeMethod("get_SourceWidth", 2),
        makeMethod("put_SourceTop", 2),
        makeMethod("get_SourceTop", 2),
        makeMethod("put_SourceHeight", 2),
        makeMethod("get_SourceHeight", 2),
        makeMethod("put_DestinationLeft", 2),
        makeMethod("get_DestinationLeft", 2),
        makeMethod("put_DestinationWidth", 2),
        makeMethod("get_DestinationWidth", 2),
        makeMethod("put_DestinationTop", 2),
        makeMethod("get_DestinationTop", 2),
        makeMethod("put_DestinationHeight", 2),
        makeMethod("get_DestinationHeight", 2),
        makeMethod("SetSourcePosition", 5),
        makeMethod("GetSourcePosition", 5),
        makeMethod("SetDefaultSourcePosition", 1),
        makeMethod("SetDestinationPosition", 5),
        makeMethod("GetDestinationPosition", 5),
        makeMethod("SetDefaultDestinationPosition", 1),
        makeMethod("GetVideoSize", 3), // slot 34 (0x88) — see header comment
        makeMethod("GetVideoPaletteEntries", 5),
        makeMethod("GetCurrentImage", 3),
        makeMethod("IsUsingDefaultSource", 1),
        makeMethod("IsUsingDefaultDestination", 1),
    ],
};

// IMediaEventEx extends IMediaEvent with 3 more methods
export const IMediaEventEx: InterfaceDescriptor = {
    name: "IMediaEventEx",
    inherits: "IUnknown",
    iid: "56a868c0-0ad4-11ce-b03a-0020af0ba770",
    methods: [
        ...IMediaEvent.methods.map(m => ({ ...m, name: m.name })),
        // IMediaEventEx methods (slots 13-15)
        makeMethod("SetNotifyWindow", 4),
        makeMethod("SetNotifyFlags", 2),
        makeMethod("GetNotifyFlags", 2),
    ],
};

// IMediaSeeking VTable: IUnknown(3) + IMediaSeeking(17). Derives directly from
// IUnknown (NOT IDispatch). Positions are LONGLONG (REFERENCE_TIME, 8 bytes by value
// where passed by value); rate is a double passed by value.
export const IMediaSeeking: InterfaceDescriptor = {
    name: "IMediaSeeking",
    inherits: "IUnknown",
    iid: "36b73880-c2c8-11cf-8b46-00805f6cef60",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IMediaSeeking methods (slots 3-19)
        makeMethod("GetCapabilities", 2),
        makeMethod("CheckCapabilities", 2),
        makeMethod("IsFormatSupported", 2),
        makeMethod("QueryPreferredFormat", 2),
        makeMethod("GetTimeFormat", 2),
        makeMethod("IsUsingTimeFormat", 2),
        makeMethod("SetTimeFormat", 2),
        makeMethod("GetDuration", 2),
        makeMethod("GetStopPosition", 2),
        makeMethod("GetCurrentPosition", 2),
        // ConvertTimeFormat: this, pTarget, pTargetFormat, Source(LONGLONG=2), pSourceFormat
        makeMethod("ConvertTimeFormat", 6),
        // SetPositions: this, pCurrent(ptr), dwCurrentFlags, pStop(ptr), dwStopFlags
        makeMethod("SetPositions", 5),
        makeMethod("GetPositions", 3),
        makeMethod("GetAvailable", 3),
        // SetRate: this + double-by-value (2 dwords)
        makeMethod("SetRate", 3),
        makeMethod("GetRate", 2),
        makeMethod("GetPreroll", 2),
    ],
};

// IVideoWindow VTable: IUnknown(3) + IDispatch(4) + IVideoWindow(39)
export const IVideoWindow: InterfaceDescriptor = {
    name: "IVideoWindow",
    inherits: "IUnknown",
    iid: "56a868b4-0ad4-11ce-b03a-0020af0ba770",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IDispatch methods (slots 3-6)
        makeMethod("GetTypeInfoCount", 2),
        makeMethod("GetTypeInfo", 4),
        makeMethod("GetIDsOfNames", 6),
        makeMethod("Invoke", 9),
        // IVideoWindow methods (slots 7+)
        makeMethod("put_Caption", 2),
        makeMethod("get_Caption", 2),
        makeMethod("put_WindowStyle", 2),
        makeMethod("get_WindowStyle", 2),
        makeMethod("put_WindowStyleEx", 2),
        makeMethod("get_WindowStyleEx", 2),
        makeMethod("put_AutoShow", 2),
        makeMethod("get_AutoShow", 2),
        makeMethod("put_WindowState", 2),
        makeMethod("get_WindowState", 2),
        makeMethod("put_BackgroundPalette", 2),
        makeMethod("get_BackgroundPalette", 2),
        makeMethod("put_Visible", 2),
        makeMethod("get_Visible", 2),
        makeMethod("put_Left", 2),
        makeMethod("get_Left", 2),
        makeMethod("put_Width", 2),
        makeMethod("get_Width", 2),
        makeMethod("put_Top", 2),
        makeMethod("get_Top", 2),
        makeMethod("put_Height", 2),
        makeMethod("get_Height", 2),
        makeMethod("put_Owner", 2),
        makeMethod("get_Owner", 2),
        makeMethod("put_MessageDrain", 2),
        makeMethod("get_MessageDrain", 2),
        makeMethod("get_BorderColor", 2),
        makeMethod("put_BorderColor", 2),
        makeMethod("get_FullScreenMode", 2),
        makeMethod("put_FullScreenMode", 2),
        makeMethod("SetWindowForeground", 2),
        makeMethod("NotifyOwnerMessage", 5),
        makeMethod("SetWindowPosition", 5),
        makeMethod("GetWindowPosition", 5),
        makeMethod("GetMinIdealImageSize", 3),
        makeMethod("GetMaxIdealImageSize", 3),
        makeMethod("GetRestorePosition", 5),
        makeMethod("HideCursor", 2),
        makeMethod("IsCursorHidden", 2),
    ],
};

// IBasicAudio VTable: IUnknown(3) + IDispatch(4) + IBasicAudio(4)
export const IBasicAudio: InterfaceDescriptor = {
    name: "IBasicAudio",
    inherits: "IUnknown",
    iid: "56a868b3-0ad4-11ce-b03a-0020af0ba770",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IDispatch methods (slots 3-6)
        makeMethod("GetTypeInfoCount", 2),
        makeMethod("GetTypeInfo", 4),
        makeMethod("GetIDsOfNames", 6),
        makeMethod("Invoke", 9),
        // IBasicAudio methods (slots 7-10)
        makeMethod("put_Volume", 2),
        makeMethod("get_Volume", 2),
        makeMethod("put_Balance", 2),
        makeMethod("get_Balance", 2),
    ],
};

export const quartzModule: ModuleDescriptor = {
    name: "quartz",
    version: "1.0",
    description: "DirectShow FilterGraph stubs for AVI cutscene playback",
    functions: [],
    interfaces: [IGraphBuilder, IMediaControl, IMediaPosition, IMediaEvent, IMediaEventEx, IMediaSeeking, IVideoWindow, IBasicAudio, IBasicVideo],
};
