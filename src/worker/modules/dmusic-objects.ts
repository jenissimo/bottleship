/**
 * The COM objects behind the DirectMusic module: what each one holds, which interfaces it
 * answers for, and under which vtable. The methods themselves live in dmusic.ts.
 */
import type { Band } from "@bottleship/formats/dmusic/band";
import type { DlsCollection } from "@bottleship/formats/dmusic/dls";
import type { ObjectIdentity } from "@bottleship/formats/dmusic/reference";
import type { Segment } from "@bottleship/formats/dmusic/segment";
import type { Style } from "@bottleship/formats/dmusic/style";
import { BaseComObject } from "../core/com/base-com-object";
import type { LoadedBand, PerfSegment, PerfSegmentState, Performance } from "../core/audio/directmusic/performance";
import type { DlsSynth } from "../core/audio/directmusic/synth";
import type { DirectSoundSink } from "./dmusic-sink";

export const IID_IUnknown = "00000000-0000-0000-c000-000000000046";
export const IID_IPersist = "0000010c-0000-0000-c000-000000000046";
export const IID_IPersistStream = "00000109-0000-0000-c000-000000000046";

export const CLSID_DirectMusic = "636b9f10-0c7d-11d1-95b2-0020afdc7421";
export const CLSID_DirectMusicPerformance = "d2ac2881-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicSegment = "d2ac2882-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicStyle = "d2ac288a-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicComposer = "d2ac2890-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicLoader = "d2ac2892-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicBand = "79ba9e00-b6ee-11d1-86be-00c04fbf8fef";
export const CLSID_DirectMusicCollection = "480ff4b0-28b2-11d1-bef7-00c04fbf8fef";
/** The Microsoft software synthesizer, the one port the system offers. */
export const CLSID_DirectMusicSynth = "58c2b4d0-46e7-11d1-89ac-00a0c9054129";

export const IID_IDirectMusic = "6536115a-7b2d-11d2-ba18-0000f875ac12";
export const IID_IDirectMusic2 = "6fc2cae1-bc78-11d2-afa6-00aa0024d8b6";
export const IID_IDirectMusic8 = "2d3629f7-813d-4939-8508-f05c6b75fd97";
export const IID_IDirectMusicPort = "08f2d8c9-37c2-11d2-b9f9-0000f875ac12";
export const IID_IDirectMusicLoader = "2ffaaca2-5dca-11d2-afa6-00aa0024d8b6";
export const IID_IDirectMusicLoader8 = "19e7c08c-0a44-4e6a-a116-595a7cd5de8c";
export const IID_IDirectMusicGetLoader = "68a04844-d13d-11d1-afa6-00aa0024d8b6";
export const IID_IDirectMusicObject = "d2ac28b5-b39b-11d1-8704-00600893b1bd";
export const IID_IDirectMusicPerformance = "07d43d03-6523-11d2-871d-00600893b1bd";
export const IID_IDirectMusicPerformance2 = "6fc2cae0-bc78-11d2-afa6-00aa0024d8b6";
export const IID_IDirectMusicPerformance8 = "679c4137-c62e-4147-b2b4-9d569acb254c";
export const IID_IDirectMusicSegment = "f96029a2-4282-11d2-8717-00600893b1bd";
export const IID_IDirectMusicSegment2 = "d38894d1-c052-11d2-872f-00600893b1bd";
export const IID_IDirectMusicSegment8 = "c6784488-41a3-418f-aa15-b35093ba42d4";
export const IID_IDirectMusicSegmentState = "a3afdcc7-d3ee-11d1-bc8d-00a0c922e6eb";
export const IID_IDirectMusicSegmentState8 = "a50e4730-0ae4-48a7-9839-bc04bfe07772";
export const IID_IDirectMusicAudioPath = "c87631f5-23be-4986-8836-05832fcc48f9";
export const IID_IDirectMusicStyle = "d2ac28bd-b39b-11d1-8704-00600893b1bd";
export const IID_IDirectMusicStyle8 = "fd24ad8a-a260-453d-bf50-6f9384f70985";
export const IID_IDirectMusicComposer = "d2ac28bf-b39b-11d1-8704-00600893b1bd";
export const IID_IDirectMusicBand = "d2ac28c0-b39b-11d1-8704-00600893b1bd";
export const IID_IDirectMusicCollection = "d2ac287c-b39b-11d1-8704-00600893b1bd";
export const IID_IDirectMusicTrack = "f96029a1-4282-11d2-8717-00600893b1bd";

export abstract class DMusicObject extends BaseComObject {
    /** Guest address of each interface handed out so far, by vtable name. */
    readonly addresses = new Map<string, number>();
    /** Vtable of the interface the object is created as. */
    abstract readonly primaryVtable: string;
    /** IID to vtable name, for every interface the object answers QueryInterface for. */
    abstract readonly interfaces: Readonly<Record<string, string>>;
    /** Run once when the last reference goes. */
    onDestroy: (() => void) | null = null;

    constructor() {
        // The vtable is fixed by where the module publishes the object, not by the base.
        super(IID_IUnknown, 0);
    }

    protected destroy(): void {
        this.onDestroy?.();
        this.onDestroy = null;
        this.addresses.clear();
    }
}

export type MadeSource =
    | { made: "motif"; index: number }
    | { made: "band-segment" }
    | { made: "style-band"; index: number }
    | { made: "transition"; style: number; tempo: number; command: number; grooveLevel: number };

export type ObjectSource =
    | { bytes: Uint8Array }
    | { file: string; length: number; hash: string }
    | (MadeSource & { of: ObjectSource | null });

const LOADABLE = { [IID_IDirectMusicObject]: "IDirectMusicObject", [IID_IPersistStream]: "IDirectMusicPersistStream", [IID_IPersist]: "IDirectMusicPersistStream" };

/** A segment, style, band or collection: created empty, filled by IPersistStream::Load. */
export abstract class LoadableObject extends DMusicObject {
    abstract readonly classId: string;
    identity: ObjectIdentity = { objectId: "", name: "", versionMS: 0, versionLS: 0, hasVersion: false };
    /** What SetDescriptor or the loader's reference said the file is called. */
    fileName = "";
    loaded = false;
    /** Objects this one refers to, held for as long as it lives. */
    readonly references: DMusicObject[] = [];
    source: ObjectSource | null = null;
    resolved: Array<DMusicObject | null> = [];
}

export class LoaderObject extends DMusicObject {
    readonly primaryVtable = "IDirectMusicLoader8";
    readonly interfaces = { [IID_IDirectMusicLoader]: "IDirectMusicLoader8", [IID_IDirectMusicLoader8]: "IDirectMusicLoader8" };
    /** The default GM collection, one per loader, made on first request. */
    defaultCollection: CollectionObject | null = null;
    searchDirectory = "";
    readonly cache = new Map<string, LoadableObject>();
    readonly cacheDisabled = new Set<string>();
}

export interface PendingNotification {
    type: number;
    state: SegmentStateObject;
    musicTime: number;
    queuedAtMs: number;
}

export class PerformanceObject extends DMusicObject {
    readonly primaryVtable = "IDirectMusicPerformance8";
    readonly interfaces = {
        [IID_IDirectMusicPerformance]: "IDirectMusicPerformance8",
        [IID_IDirectMusicPerformance2]: "IDirectMusicPerformance8",
        [IID_IDirectMusicPerformance8]: "IDirectMusicPerformance8",
    };
    directMusic: DirectMusicObject | null = null;
    port: PortObject | null = null;
    /** Null until a port has been added: there is nothing to play on. */
    engine: Performance | null = null;
    notificationHandle = 0;
    notifySegments = false;
    readonly notifications: PendingNotification[] = [];
    /** Segment states handed to the guest or carried by a notification, by engine state. */
    readonly stateObjects = new Map<PerfSegmentState, SegmentStateObject>();
    masterVolume = 0;
    masterTempo = 1;
    defaultAudioPath: AudioPathObject | null = null;
}

/** One track of a segment, as IDirectMusicSegment::GetTrack hands it out. */
export interface SegmentTrackInfo {
    classId: string;
    group: number;
    object: TrackObject | null;
}

export class SegmentObject extends LoadableObject {
    readonly primaryVtable = "IDirectMusicSegment8";
    readonly classId = CLSID_DirectMusicSegment;
    readonly interfaces = {
        ...LOADABLE,
        [IID_IDirectMusicSegment]: "IDirectMusicSegment8",
        [IID_IDirectMusicSegment2]: "IDirectMusicSegment8",
        [IID_IDirectMusicSegment8]: "IDirectMusicSegment8",
    };
    /** Null until loaded (or made by a style, a band or the composer). */
    segment: PerfSegment | null = null;
    file: Segment | null = null;
    tracks: SegmentTrackInfo[] = [];
    readonly commandEdits = new Map<number, [command: number, grooveLevel: number, grooveRange: number]>();
}

export class SegmentStateObject extends DMusicObject {
    readonly primaryVtable = "IDirectMusicSegmentState8";
    readonly interfaces = {
        [IID_IDirectMusicSegmentState]: "IDirectMusicSegmentState8",
        [IID_IDirectMusicSegmentState8]: "IDirectMusicSegmentState8",
    };
    state: PerfSegmentState | null = null;
    segment: SegmentObject | null = null;
    performance: PerformanceObject | null = null;
}

export class AudioPathObject extends DMusicObject {
    readonly primaryVtable = "IDirectMusicAudioPath";
    readonly interfaces = { [IID_IDirectMusicAudioPath]: "IDirectMusicAudioPath" };
    performance: PerformanceObject | null = null;
    pathType = 0;
    buffer = 0;
    sink: DirectSoundSink | null = null;
    channels = 2;
}

export class ComposerObject extends DMusicObject {
    readonly primaryVtable = "IDirectMusicComposer8";
    readonly interfaces = { [IID_IDirectMusicComposer]: "IDirectMusicComposer8" };
}

export class DirectMusicObject extends DMusicObject {
    readonly primaryVtable = "IDirectMusic8";
    readonly interfaces = {
        [IID_IDirectMusic]: "IDirectMusic8", [IID_IDirectMusic2]: "IDirectMusic8", [IID_IDirectMusic8]: "IDirectMusic8",
    };
    /** The application's IDirectSound, when it gave the performance one. */
    directSound = 0;
    readonly ports = new Set<PortObject>();
}

export class PortObject extends DMusicObject {
    readonly primaryVtable = "IDirectMusicPort";
    readonly interfaces = { [IID_IDirectMusicPort]: "IDirectMusicPort" };
    synth!: DlsSynth;
    sampleRate = 22050;
    audioChannels = 2;
    voices = 32;
    channelGroups = 1;
    directSound = 0;
    /** The DirectSound buffer the port renders into; 0 until one is set or made. */
    buffer = 0;
    ownsBuffer = false;
    sink: DirectSoundSink | null = null;
    active = false;
    performance: PerformanceObject | null = null;
    owner: DirectMusicObject | null = null;
}

export class StyleObject extends LoadableObject {
    readonly primaryVtable = "IDirectMusicStyle8";
    readonly classId = CLSID_DirectMusicStyle;
    readonly interfaces = { ...LOADABLE, [IID_IDirectMusicStyle]: "IDirectMusicStyle8", [IID_IDirectMusicStyle8]: "IDirectMusicStyle8" };
    style: Style | null = null;
    /** The style's own bands, collections resolved, parallel to `style.bands`. */
    bands: LoadedBand[] = [];
}

export class BandObject extends LoadableObject {
    readonly primaryVtable = "IDirectMusicBand";
    readonly classId = CLSID_DirectMusicBand;
    readonly interfaces = { ...LOADABLE, [IID_IDirectMusicBand]: "IDirectMusicBand" };
    band: LoadedBand | null = null;
    file: Band | null = null;
}

export class CollectionObject extends LoadableObject {
    readonly primaryVtable = "IDirectMusicCollection";
    readonly classId = CLSID_DirectMusicCollection;
    readonly interfaces = { ...LOADABLE, [IID_IDirectMusicCollection]: "IDirectMusicCollection" };
    collection: DlsCollection | null = null;
}

export class TrackObject extends DMusicObject {
    readonly primaryVtable = "IDirectMusicTrack";
    readonly interfaces = { [IID_IDirectMusicTrack]: "IDirectMusicTrack" };
    owner: SegmentObject | null = null;
    classId = "";
}
