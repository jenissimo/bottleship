/**
 * DirectMusic (dmusic.dll / dmime.dll) API descriptor.
 *
 * DX7/DX8-era engines create the loader, performance and the loadable objects through
 * CoCreateInstance and abort music init when any of it fails. Vtable SLOT ORDER is the contract here —
 * a method at the wrong index is a call to the wrong function with the wrong arity, so
 * every list below is the full inheritance chain in declaration order, never a subset.
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

/** argCount INCLUDES `this`; 64-bit args (REFERENCE_TIME) count as two. */
const m = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
});

const unknown = () => IUnknown.methods.map(x => ({ ...x }));

export const IDirectMusicLoader8: InterfaceDescriptor = {
    name: "IDirectMusicLoader8",
    inherits: "IUnknown",
    iid: "19e7c08c-0a44-4e6a-a116-595a7cd5de8c",
    methods: [
        ...unknown(),
        // IDirectMusicLoader
        m("GetObject", 4),
        m("SetObject", 2),
        m("SetSearchDirectory", 4),
        m("ScanDirectory", 4),
        m("CacheObject", 2),
        m("ReleaseObject", 2),
        m("ClearCache", 2),
        m("EnableCache", 3),
        m("EnumObject", 4),
        // IDirectMusicLoader8
        m("CollectGarbage", 1),
        m("ReleaseObjectByUnknown", 2),
        m("LoadObjectFromFile", 5),
    ],
};

export const IDirectMusicPerformance8: InterfaceDescriptor = {
    name: "IDirectMusicPerformance8",
    inherits: "IUnknown",
    iid: "679c4137-c62e-4147-b2b4-9d569acb254c",
    methods: [
        ...unknown(),
        // IDirectMusicPerformance
        m("Init", 4),
        m("PlaySegment", 6),          // i64StartTime occupies two slots
        m("Stop", 5),
        m("GetSegmentState", 3),
        m("SetPrepareTime", 2),
        m("GetPrepareTime", 2),
        m("SetBumperLength", 2),
        m("GetBumperLength", 2),
        m("SendPMsg", 2),
        m("MusicToReferenceTime", 3),
        m("ReferenceToMusicTime", 4),
        m("IsPlaying", 3),
        m("GetTime", 3),
        m("AllocPMsg", 3),
        m("FreePMsg", 2),
        m("GetGraph", 2),
        m("SetGraph", 2),
        m("SetNotificationHandle", 4),
        m("GetNotificationPMsg", 2),
        m("AddNotificationType", 2),
        m("RemoveNotificationType", 2),
        m("AddPort", 2),
        m("RemovePort", 2),
        m("AssignPChannelBlock", 4),
        m("AssignPChannel", 5),
        m("PChannelInfo", 5),
        m("DownloadInstrument", 9),
        m("Invalidate", 3),
        m("GetParam", 7),
        m("SetParam", 6),
        m("GetGlobalParam", 4),
        m("SetGlobalParam", 4),
        m("GetLatencyTime", 2),
        m("GetQueueTime", 2),
        m("AdjustTime", 3),
        m("CloseDown", 1),
        m("GetResolvedTime", 5),
        m("MIDIToMusic", 6),
        m("MusicToMIDI", 6),
        m("TimeToRhythm", 7),
        m("RhythmToTime", 7),
        // IDirectMusicPerformance8
        m("InitAudio", 8),
        m("PlaySegmentEx", 10),
        m("StopEx", 5),
        m("ClonePMsg", 3),
        m("CreateAudioPath", 4),
        m("CreateStandardAudioPath", 5),
        m("SetDefaultAudioPath", 2),
        m("GetDefaultAudioPath", 2),
        m("GetParamEx", 8),
    ],
};

export const IDirectMusicSegment8: InterfaceDescriptor = {
    name: "IDirectMusicSegment8",
    inherits: "IUnknown",
    iid: "c6784488-41a3-418f-aa15-b35093ba42d4",
    methods: [
        ...unknown(),
        // IDirectMusicSegment
        m("GetLength", 2),
        m("SetLength", 2),
        m("GetRepeats", 2),
        m("SetRepeats", 2),
        m("GetDefaultResolution", 2),
        m("SetDefaultResolution", 2),
        m("GetTrack", 5),
        m("GetTrackGroup", 3),
        m("InsertTrack", 3),
        m("RemoveTrack", 2),
        m("InitPlay", 4),
        m("GetGraph", 2),
        m("SetGraph", 2),
        m("AddNotificationType", 2),
        m("RemoveNotificationType", 2),
        m("GetParam", 7),
        m("SetParam", 6),
        m("Clone", 4),
        m("SetStartPoint", 2),
        m("GetStartPoint", 2),
        m("SetLoopPoints", 3),
        m("GetLoopPoints", 3),
        m("SetPChannelsUsed", 3),
        // IDirectMusicSegment8
        m("SetTrackConfig", 6),
        m("GetAudioPathConfig", 2),
        m("Compose", 5),
        m("Download", 2),
        m("Unload", 2),
    ],
};

export const IDirectMusicSegmentState8: InterfaceDescriptor = {
    name: "IDirectMusicSegmentState8",
    inherits: "IUnknown",
    iid: "a50e4730-0ae4-48a7-9839-bc04bfe07772",
    methods: [
        ...unknown(),
        // IDirectMusicSegmentState
        m("GetRepeats", 2),
        m("GetSegment", 2),
        m("GetStartTime", 2),
        m("GetSeek", 2),
        m("GetStartPoint", 2),
        // IDirectMusicSegmentState8
        m("SetTrackConfig", 6),
        m("GetObjectInPath", 8),
    ],
};

export const IDirectMusicAudioPath: InterfaceDescriptor = {
    name: "IDirectMusicAudioPath",
    inherits: "IUnknown",
    iid: "c87631f5-23be-4986-8836-05832fcc48f9",
    methods: [
        ...unknown(),
        m("GetObjectInPath", 8),
        m("Activate", 2),
        m("SetVolume", 3),
        m("ConvertPChannel", 3),
    ],
};

/** A tool graph: the performance's, a segment's or an audio path's chain of IDirectMusicTools. */
export const IDirectMusicGraph: InterfaceDescriptor = {
    name: "IDirectMusicGraph",
    inherits: "IUnknown",
    iid: "2befc277-5497-11d2-bccb-00a0c922e6eb",
    methods: [
        ...unknown(),
        m("StampPMsg", 2),
        m("InsertTool", 5),
        m("GetTool", 3),
        m("RemoveTool", 2),
    ],
};

export const IDirectMusicComposer8: InterfaceDescriptor = {
    name: "IDirectMusicComposer8",
    inherits: "IUnknown",
    iid: "d2ac28bf-b39b-11d1-8704-00600893b1bd",
    methods: [
        ...unknown(),
        m("ComposeSegmentFromTemplate", 6),
        m("ComposeSegmentFromShape", 9),
        m("ComposeTransition", 8),
        m("AutoTransition", 9),
        m("ComposeTemplateFromShape", 7),
        m("ChangeChordMap", 4),
    ],
};

/** The object IDirectMusicPerformance::Init hands back through its out-parameter. */
export const IDirectMusic8: InterfaceDescriptor = {
    name: "IDirectMusic8",
    inherits: "IUnknown",
    iid: "2d3629f7-813d-4939-8508-f05c6b75fd97",
    methods: [
        ...unknown(),
        // IDirectMusic
        m("EnumPort", 3),
        m("CreateMusicBuffer", 4),
        m("CreatePort", 5),
        m("EnumMasterClock", 3),
        m("GetMasterClock", 3),
        m("SetMasterClock", 2),
        m("Activate", 2),
        m("GetDefaultPort", 2),
        m("SetDirectSound", 3),
        // IDirectMusic8
        m("SetExternalMasterClock", 2),
    ],
};

export const IDirectMusicPort: InterfaceDescriptor = {
    name: "IDirectMusicPort",
    inherits: "IUnknown",
    iid: "08f2d8c9-37c2-11d2-b9f9-0000f875ac12",
    methods: [
        ...unknown(),
        m("PlayBuffer", 2),
        m("SetReadNotificationHandle", 2),
        m("Read", 2),
        m("DownloadInstrument", 5),
        m("UnloadInstrument", 2),
        m("GetLatencyClock", 2),
        m("GetRunningStats", 2),
        m("Compact", 1),
        m("GetCaps", 2),
        m("DeviceIoControl", 8),
        m("SetNumChannelGroups", 2),
        m("GetNumChannelGroups", 2),
        m("Activate", 2),
        m("SetChannelPriority", 4),
        m("GetChannelPriority", 4),
        m("SetDirectSound", 3),
        m("GetFormat", 4),
    ],
};

// The interfaces below are reached only through QueryInterface or a method of another
// DirectMusic object, never by IID through CoCreateInstance's generic path, so they carry
// no `iid`: the module answers for them itself.

/** Every loadable DirectMusic object (segment, style, band, collection) is one of these. */
export const IDirectMusicObject: InterfaceDescriptor = {
    name: "IDirectMusicObject",
    inherits: "IUnknown",
    methods: [
        ...unknown(),
        m("GetDescriptor", 2),
        m("SetDescriptor", 2),
        m("ParseDescriptor", 3),
    ],
};

/** IPersistStream as the loadable objects expose it: a loader hands Load the file's stream. */
export const IDirectMusicPersistStream: InterfaceDescriptor = {
    name: "IDirectMusicPersistStream",
    inherits: "IUnknown",
    methods: [
        ...unknown(),
        m("GetClassID", 2),
        m("IsDirty", 1),
        m("Load", 2),
        m("Save", 3),
        m("GetSizeMax", 2),
    ],
};

export const IDirectMusicStyle8: InterfaceDescriptor = {
    name: "IDirectMusicStyle8",
    inherits: "IUnknown",
    methods: [
        ...unknown(),
        // IDirectMusicStyle
        m("GetBand", 3),
        m("EnumBand", 3),
        m("GetDefaultBand", 2),
        m("EnumMotif", 3),
        m("GetMotif", 3),
        m("GetDefaultChordMap", 2),
        m("EnumChordMap", 3),
        m("GetChordMap", 3),
        m("GetTimeSignature", 2),
        m("GetEmbellishmentLength", 5),
        m("GetTempo", 2),
        // IDirectMusicStyle8
        m("EnumPattern", 5),
    ],
};

export const IDirectMusicBand: InterfaceDescriptor = {
    name: "IDirectMusicBand",
    inherits: "IUnknown",
    methods: [
        ...unknown(),
        m("CreateSegment", 2),
        m("Download", 2),
        m("Unload", 2),
    ],
};

export const IDirectMusicCollection: InterfaceDescriptor = {
    name: "IDirectMusicCollection",
    inherits: "IUnknown",
    methods: [
        ...unknown(),
        m("GetInstrument", 3),
        m("EnumInstrument", 5),
    ],
};

export const IDirectMusicTrack: InterfaceDescriptor = {
    name: "IDirectMusicTrack",
    inherits: "IUnknown",
    methods: [
        ...unknown(),
        m("Init", 2),
        m("InitPlay", 6),
        m("EndPlay", 2),
        m("Play", 9),
        m("GetParam", 5),
        m("SetParam", 4),
        m("IsParamSupported", 2),
        m("AddNotificationType", 2),
        m("RemoveNotificationType", 2),
        m("Clone", 4),
    ],
};

export const dmusicModule: ModuleDescriptor = {
    name: "dmusic",
    version: "8.0",
    description: "DirectMusic: loader, performance, composer, style playback over a DLS synthesizer",
    functions: [],
    interfaces: [
        IDirectMusicLoader8,
        IDirectMusicPerformance8,
        IDirectMusicSegment8,
        IDirectMusicSegmentState8,
        IDirectMusicAudioPath,
        IDirectMusicGraph,
        IDirectMusicComposer8,
        IDirectMusic8,
        IDirectMusicPort,
        IDirectMusicObject,
        IDirectMusicPersistStream,
        IDirectMusicStyle8,
        IDirectMusicBand,
        IDirectMusicCollection,
        IDirectMusicTrack,
    ],
};
