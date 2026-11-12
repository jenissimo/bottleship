import type { DlsCollection } from "@bottleship/formats/dmusic/dls";
import type { ObjectIdentity } from "@bottleship/formats/dmusic/reference";
import {
    capturePerfSegmentState, linkPerfSegmentState, type Performance, PerfStateError, type PerformanceData, type PerfSegmentState, type PerfSegmentStateData,
    restorePerfSegmentState,
} from "../core/audio/directmusic/performance";
import { DlsSynth, SYNTH_STATE_KEYS, type SynthData } from "../core/audio/directmusic/synth";
import { BaseComObject, type ComBaseState } from "../core/com/base-com-object";
import { Logger, LogCategory } from "../core/logger";
import { CaptureRefusal, objectCodecs } from "../savestate/object-codecs";
import { savestateParticipants, stateKeys, type FieldPolicy, type RestoreContext } from "../savestate/participant";
import { sha256HexSync } from "../savestate/sha256";
import type { SaveValue } from "../savestate/value-codec";
import {
    AudioPathObject, BandObject, CollectionObject, ComposerObject, DirectMusicObject, type DMusicObject, LoadableObject, LoaderObject,
    type MadeSource, type ObjectSource, PerformanceObject, PortObject, SegmentObject, SegmentStateObject, StyleObject, TrackObject,
} from "./dmusic-objects";
import type { DirectSoundSink, SinkData } from "./dmusic-sink";

export const GUID_DEFAULT_GM_COLLECTION = "f17e8673-c3b4-11d1-870b-00600893b1bd";

export interface SavedDMusicBase { base: ComBaseState; addresses: Array<[string, number]> }
export interface SavedLoader extends SavedDMusicBase {
    searchDirectory: string;
    defaultCollection: number;
    cache: Array<[string, number]>;
    cacheDisabled: string[];
}
export interface SavedDirectMusic extends SavedDMusicBase { directSound: number; ports: number[] }

export const DMUSIC_OBJECT_FIELDS = {
    addresses: 'save', onDestroy: 'derive',
} as const satisfies Record<string, FieldPolicy>;

export const LOADER_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', defaultCollection: 'save', searchDirectory: 'save',
    cache: 'save', cacheDisabled: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const DIRECTMUSIC_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', directSound: 'save', ports: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const DEFAULT_COLLECTION_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', classId: 'derive', identity: 'derive',
    fileName: 'derive', loaded: 'derive', references: 'transient', source: 'transient', resolved: 'transient', collection: 'derive',
} as const satisfies Record<string, FieldPolicy>;

export type SavedSource = { blob: string } | { file: string; length: number; hash: string } | MadeSource;
export interface SavedLoadable extends SavedDMusicBase {
    fileName: string;
    identity: ObjectIdentity;
    source: SavedSource | null;
    resolved: number[];
}
export const SEGMENT_SETTINGS = ['length', 'playStart', 'loopStart', 'loopEnd', 'repeats', 'resolution'] as const;
export type SavedSegmentSettings = Record<typeof SEGMENT_SETTINGS[number], number>;
export interface SavedSegment extends SavedLoadable {
    settings: SavedSegmentSettings | null;
    commandEdits: Array<[number, number, number, number]>;
    tracks: Array<[number, number]>;
}
export interface SavedTrack extends SavedDMusicBase { classId: string }

export const LOADABLE_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', classId: 'derive', identity: 'save',
    fileName: 'save', loaded: 'derive', references: 'derive', source: 'save', resolved: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const COLLECTION_FIELDS = { ...LOADABLE_FIELDS, collection: 'derive' } as const satisfies Record<string, FieldPolicy>;
export const BAND_FIELDS = { ...LOADABLE_FIELDS, band: 'derive', file: 'derive' } as const satisfies Record<string, FieldPolicy>;
export const STYLE_FIELDS = { ...LOADABLE_FIELDS, style: 'derive', bands: 'derive' } as const satisfies Record<string, FieldPolicy>;
export const SEGMENT_FIELDS = {
    ...LOADABLE_FIELDS, segment: 'save', file: 'derive', tracks: 'save', commandEdits: 'save',
} as const satisfies Record<string, FieldPolicy>;
export const TRACK_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', owner: 'derive', classId: 'save',
} as const satisfies Record<string, FieldPolicy>;

export interface SavedAudioPath extends SavedDMusicBase {
    pathType: number;
    performance: number;
    buffer: number;
    channels: number;
    sink: SinkData | null;
}

export const AUDIO_PATH_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', pathType: 'save', performance: 'save',
    buffer: 'save', sink: 'save', channels: 'save',
} as const satisfies Record<string, FieldPolicy>;

export interface SavedPort extends SavedDMusicBase {
    sampleRate: number;
    audioChannels: number;
    voices: number;
    channelGroups: number;
    directSound: number;
    buffer: number;
    ownsBuffer: boolean;
    active: boolean;
    owner: number;
    performance: number;
    synth: SynthData;
    sink: SinkData | null;
}

export const PORT_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', synth: 'save', sampleRate: 'save', audioChannels: 'save',
    voices: 'save', channelGroups: 'save', directSound: 'save', buffer: 'save', ownsBuffer: 'save', sink: 'save', active: 'save',
    performance: 'save', owner: 'save',
} as const satisfies Record<string, FieldPolicy>;

export interface SavedPerformance extends SavedDMusicBase {
    directMusic: number;
    port: number;
    engine: PerformanceData | null;
    notificationHandle: number;
    notifySegments: boolean;
    notifications: Array<[type: number, state: number, musicTime: number, ageMs: number]>;
    stateObjects: number[];
    masterVolume: number;
    masterTempo: number;
    defaultAudioPath: number;
}

export const PERFORMANCE_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', directMusic: 'save', port: 'save', engine: 'save',
    notificationHandle: 'save', notifySegments: 'save', notifications: 'save', stateObjects: 'save', masterVolume: 'save',
    masterTempo: 'save', defaultAudioPath: 'save',
} as const satisfies Record<string, FieldPolicy>;

export interface SavedSegmentState extends SavedDMusicBase {
    performance: number;
    segment: number;
    state: PerfSegmentStateData | null;
}

export const SEGMENT_STATE_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', state: 'save', segment: 'save', performance: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const ENGINE_FIELDS = {
    synth: 'derive', random: 'derive', randomState: 'save', onNotification: 'derive', defaultCollection: 'save', now: 'save',
    tempo: 'save', masterTempo: 'save', states: 'save', events: 'save', transpose: 'save', drumChannels: 'save', installed: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const ENGINE_STATE_FIELDS = {
    segment: 'save', primary: 'save', startTime: 'save', base: 'save', repeatsLeft: 'save', started: 'save', ended: 'save',
    queued: 'save', fresh: 'save', stopAt: 'save', pattern: 'save', patternStyle: 'save', patternStart: 'save', patternEnd: 'save',
    parts: 'save', sequentialVariation: 'save', grooveLevel: 'save', wavePosition: 'save', output: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const SYNTH_FIELDS = {
    sampleRate: 'derive', voices: 'save', channels: 'save', masterGain: 'save', noteCounter: 'save', stats: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const SYNTH_CHANNEL_FIELDS = {
    instrument: 'derive', collection: 'save', patch: 'save', pendingDecode: 'transient', volume: 'save', expression: 'save',
    pan: 'save', modWheel: 'save', sustain: 'save', pitchBend: 'save', bendRangeCents: 'save', rpn: 'save', gain: 'derive',
    panPosition: 'derive',
} as const satisfies Record<string, FieldPolicy>;

export const SYNTH_VOICE_FIELDS = {
    active: 'derive', channelId: 'save', channel: 'derive', key: 'save', region: 'save', collection: 'save', patch: 'save',
    position: 'save', baseStep: 'save', velocityGain: 'save', age: 'save', held: 'save', releasePending: 'save', stage: 'save',
    attackLevel: 'save', attenuationDb: 'save', attackRate: 'save', decayRate: 'save', sustainDb: 'save', releaseRate: 'save',
    eg2Stage: 'save', eg2Level: 'save', eg2AttackRate: 'save', eg2DecayRate: 'save', eg2ReleaseRate: 'save', lfoPhase: 'save',
    lfoDelayFrames: 'save', gainLeft: 'save', gainRight: 'save', started: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const SINK_FIELDS = {
    process: 'host', buffer: 'derive', blockAlign: 'derive', bytesPerSecond: 'derive', bufferBytes: 'save', scratch: 'save',
    writeOffset: 'save', playing: 'save', pcm: 'transient', silentBytes: 'save',
} as const satisfies Record<string, FieldPolicy>;

export interface SavedModule {
    performances: number[];
    ports: number[];
    pathOutputs: number[];
    messages: Array<[address: number, state: number]>;
    pumpTimer: number;
}

export interface DMusicModuleState {
    performances: PerformanceObject[];
    ports: PortObject[];
    pathOutputs: AudioPathObject[];
    messages: Array<[number, SegmentStateObject | null]>;
    pumpTimer: number | null;
}

export const DMUSIC_MODULE_FIELDS = {
    name: 'transient', exports: 'host', vtables: 'derive', process: 'host', ports: 'save', performances: 'save',
    loading: 'transient', pumpTimer: 'save', collectionObjects: 'derive', mixLeft: 'transient', mixRight: 'transient',
    messages: 'save', pathOutputs: 'save', decodedWaves: 'transient',
} as const satisfies Record<string, FieldPolicy>;

export const DMUSIC_SCHEMA = {
    module: DMUSIC_MODULE_FIELDS,
    object: DMUSIC_OBJECT_FIELDS,
    loader: LOADER_FIELDS,
    directMusic: DIRECTMUSIC_FIELDS,
    defaultCollection: DEFAULT_COLLECTION_FIELDS,
    audioPath: AUDIO_PATH_FIELDS,
    port: PORT_FIELDS,
    performance: PERFORMANCE_FIELDS,
    segmentState: SEGMENT_STATE_FIELDS,
    engine: ENGINE_FIELDS,
    engineState: ENGINE_STATE_FIELDS,
    synth: SYNTH_FIELDS,
    synthChannel: SYNTH_CHANNEL_FIELDS,
    synthVoice: SYNTH_VOICE_FIELDS,
    sink: SINK_FIELDS,
    savedModule: stateKeys<SavedModule>({ performances: true, ports: true, pathOutputs: true, messages: true, pumpTimer: true }),
    messageRow: ['address', 'segment state or -1'],
    savedPort: stateKeys<SavedPort>({
        base: true, addresses: true, sampleRate: true, audioChannels: true, voices: true, channelGroups: true, directSound: true,
        buffer: true, ownsBuffer: true, active: true, owner: true, performance: true, synth: true, sink: true,
    }),
    savedPerformance: stateKeys<SavedPerformance>({
        base: true, addresses: true, directMusic: true, port: true, engine: true, notificationHandle: true, notifySegments: true,
        notifications: true, stateObjects: true, masterVolume: true, masterTempo: true, defaultAudioPath: true,
    }),
    notificationRow: ['type', 'state', 'musicTime', 'ageMs'],
    savedSegmentState: stateKeys<SavedSegmentState>({ base: true, addresses: true, performance: true, segment: true, state: true }),
    savedAudioPath: stateKeys<SavedAudioPath>({ base: true, addresses: true, pathType: true, performance: true, buffer: true, channels: true, sink: true }),
    savedEngine: stateKeys<PerformanceData>({
        now: true, tempo: true, masterTempo: true, randomState: true, states: true, events: true, transpose: true, drumChannels: true,
        installed: true, defaultCollection: true,
    }),
    eventRow: ['time', 'kind', 'channel', 'a', 'b', 'owner state or -1'],
    installedRow: ['channel', 'collection or -1', 'patch'],
    savedEngineState: stateKeys<PerfSegmentStateData>({
        primary: true, startTime: true, base: true, repeatsLeft: true, started: true, ended: true, queued: true, fresh: true, stopAt: true,
        patternStyle: true, pattern: true, patternStart: true, patternEnd: true, variations: true, sequentialVariation: true,
        grooveLevel: true, wavePosition: true, output: true,
    }),
    patternIndex: '-1 none, -2 the segment\'s fixed pattern, else an index into the segment\'s styles / the style\'s patterns',
    savedSynth: stateKeys<SynthData>({ masterGain: true, noteCounter: true, stats: true, channels: true, voices: true }),
    synthRows: SYNTH_STATE_KEYS,
    savedSink: stateKeys<SinkData>({ bufferBytes: true, scratch: true, writeOffset: true, playing: true, silentBytes: true }),
    collection: COLLECTION_FIELDS,
    band: BAND_FIELDS,
    style: STYLE_FIELDS,
    segment: SEGMENT_FIELDS,
    track: TRACK_FIELDS,
    base: stateKeys<SavedDMusicBase>({ base: true, addresses: true }),
    addressRow: ['vtableName', 'guestAddress'],
    cacheRow: ['fullPathLowerCase', 'object'],
    loadable: stateKeys<SavedLoadable>({ base: true, addresses: true, fileName: true, identity: true, source: true, resolved: true }),
    identity: stateKeys<ObjectIdentity>({ objectId: true, name: true, versionMS: true, versionLS: true, hasVersion: true }),
    sourceBlob: ['blob'],
    sourceFile: ['file', 'length', 'hash'],
    sourceMade: {
        'motif': ['made', 'index'], 'band-segment': ['made'], 'style-band': ['made', 'index'],
        'transition': ['made', 'style', 'tempo', 'command', 'grooveLevel'],
    },
    resolvedRow: 'object or -1, styles first, then collections, in file order',
    savedSegment: stateKeys<Omit<SavedSegment, keyof SavedLoadable>>({ settings: true, commandEdits: true, tracks: true }),
    segmentSettings: [...SEGMENT_SETTINGS],
    commandEditRow: ['time', 'command', 'grooveLevel', 'grooveRange'],
    trackRow: ['index', 'object'],
    savedTrack: stateKeys<SavedTrack>({ base: true, addresses: true, classId: true }),
} as const;

export interface DMusicHost {
    idleRefusal(): string | null;
    defaultGmCollection(): DlsCollection;
    releaseDirectSound(dm: DirectMusicObject): void;
    wireLoader(loader: LoaderObject): LoaderObject;
    readFile(path: string): Uint8Array | null;
    rebuildContents(obj: LoadableObject, source: ObjectSource, bytes: Uint8Array, resolved: Array<DMusicObject | null>): boolean;
    rebuildMade(obj: LoadableObject, origin: DMusicObject | null, made: MadeSource): boolean;
    adoptCollection(obj: CollectionObject): void;
    collectionObject(collection: DlsCollection): CollectionObject | null;
    wirePerformance(perf: PerformanceObject): void;
    wirePort(port: PortObject): void;
    wireState(obj: SegmentStateObject): void;
    wirePath(path: AudioPathObject): void;
    newSink(buffer: number, channels: number, sampleRate?: number): DirectSoundSink;
    newEngine(perf: PerformanceObject, port: PortObject): Performance;
    moduleState(): DMusicModuleState;
    restoreModuleState(state: DMusicModuleState): void;
}

const base = (o: DMusicObject): SavedDMusicBase => ({ base: BaseComObject.captureComBase(o), addresses: [...o.addresses] });

function rebuild<T extends DMusicObject>(make: () => T, d: SavedDMusicBase): T {
    const o = BaseComObject.restoreComBase(make, d.base);
    for (const [name, address] of d.addresses) o.addresses.set(name, address);
    return o;
}

export function isDefaultGmCollection(o: CollectionObject): boolean {
    return o.identity.objectId === GUID_DEFAULT_GM_COLLECTION && o.fileName === "" && o.loaded && !o.source;
}

const NONE = -1;

type Ref = (o: unknown, where: string) => number;

const optional = (o: DMusicObject | null, ref: Ref, where: string): number => o ? ref(o, where) : NONE;

function named<T>(run: () => T): T {
    try {
        return run();
    } catch (e) {
        throw e instanceof PerfStateError ? new CaptureRefusal(`dmusic: ${e.message}`) : e;
    }
}

const LOADABLE: Array<[string, new () => LoadableObject, string, (o: never) => unknown]> = [
    ['collection', CollectionObject, 'a DLS collection', (o: CollectionObject) => o.collection],
    ['band', BandObject, 'a DirectMusic band', (o: BandObject) => o.band ?? o.file],
    ['style', StyleObject, 'a DirectMusic style', (o: StyleObject) => o.style],
    ['segment', SegmentObject, 'a DirectMusic segment', (o: SegmentObject) => o.segment ?? o.file],
];

type ReadSource = Exclude<ObjectSource, { made: string }>;

function sourceBytes(host: DMusicHost, source: ReadSource, what: string): Uint8Array {
    if (!('file' in source)) return source.bytes;
    const bytes = host.readFile(source.file);
    if (!bytes) throw new Error(`dmusic: ${source.file} is missing; ${what} was loaded from it`);
    if (bytes.length !== source.length || sha256HexSync(bytes) !== source.hash) {
        throw new Error(`dmusic: ${source.file} changed since ${what} was loaded from it`);
    }
    return bytes;
}

export function registerDMusicCodecs(host: DMusicHost): void {
    objectCodecs.add<LoaderObject>({
        tag: 'dmusic-loader',
        matches: (o): o is LoaderObject => o instanceof LoaderObject,
        capture: (o, ref) => ({
            ...base(o), searchDirectory: o.searchDirectory,
            defaultCollection: o.defaultCollection ? ref(o.defaultCollection, 'default collection') : -1,
            cache: [...o.cache].map(([key, obj]) => [key, ref(obj, `cached ${key}`)] as [string, number]),
            cacheDisabled: [...o.cacheDisabled],
        }),
        restore: (d: SavedLoader) => {
            const loader = host.wireLoader(rebuild(() => new LoaderObject(), d));
            loader.searchDirectory = d.searchDirectory;
            for (const classId of d.cacheDisabled) loader.cacheDisabled.add(classId);
            return loader;
        },
        link: (loader, d: SavedLoader, ctx) => {
            if (d.defaultCollection >= 0) loader.defaultCollection = ctx.object(d.defaultCollection) as CollectionObject;
            for (const [key, r] of d.cache) loader.cache.set(key, ctx.object(r) as LoadableObject);
        },
    });
    objectCodecs.add<CollectionObject>({
        tag: 'dmusic-default-collection',
        matches: (o): o is CollectionObject => o instanceof CollectionObject && isDefaultGmCollection(o),
        capture: (o) => base(o),
        restore: (d: SavedDMusicBase) => {
            const o = rebuild(() => new CollectionObject(), d);
            o.identity.objectId = GUID_DEFAULT_GM_COLLECTION;
            o.identity.name = "GM";
            o.collection = host.defaultGmCollection();
            host.adoptCollection(o);
            o.loaded = true;
            return o;
        },
    });
    objectCodecs.add<DirectMusicObject>({
        tag: 'dmusic-directmusic',
        matches: (o): o is DirectMusicObject => o instanceof DirectMusicObject,
        capture: (o, ref): SavedDirectMusic => ({
            ...base(o), directSound: o.directSound, ports: [...o.ports].map((port, i) => ref(port, `port ${i}`)),
        }),
        restore: (d: SavedDirectMusic) => {
            const dm = rebuild(() => new DirectMusicObject(), d);
            dm.directSound = d.directSound;
            dm.onDestroy = () => host.releaseDirectSound(dm);
            return dm;
        },
        link: (dm, d: SavedDirectMusic, ctx) => {
            for (const r of d.ports) dm.ports.add(ctx.object(r) as PortObject);
        },
    });
    objectCodecs.add<ComposerObject>({
        tag: 'dmusic-composer',
        matches: (o): o is ComposerObject => o instanceof ComposerObject,
        capture: (o) => base(o),
        restore: (d: SavedDMusicBase) => rebuild(() => new ComposerObject(), d),
    });
    objectCodecs.add<AudioPathObject>({
        tag: 'dmusic-audiopath',
        matches: (o): o is AudioPathObject => o instanceof AudioPathObject,
        capture: (o, ref): SavedAudioPath => ({
            ...base(o), pathType: o.pathType, performance: optional(o.performance, ref, 'performance'), buffer: o.buffer,
            channels: o.channels, sink: o.sink?.captureState() ?? null,
        }),
        restore: (d: SavedAudioPath) => {
            const path = rebuild(() => new AudioPathObject(), d);
            path.pathType = d.pathType;
            path.buffer = d.buffer;
            path.channels = d.channels;
            if (d.sink) {
                path.sink = host.newSink(d.buffer, d.channels);
                path.sink.restoreState(d.sink);
                host.wirePath(path);
            }
            return path;
        },
        link: (path, d: SavedAudioPath, ctx) => {
            path.performance = d.performance === NONE ? null : ctx.object(d.performance) as PerformanceObject;
        },
    });
    const collectionRef = (ref: Ref) => (collection: DlsCollection | null): number => {
        const obj = collection ? host.collectionObject(collection) : null;
        return obj ? ref(obj, 'instrument collection') : NONE;
    };
    const collectionOf = (ctx: RestoreContext) => (r: number): DlsCollection | null =>
        r === NONE ? null : (ctx.object(r) as CollectionObject).collection;
    objectCodecs.add<PortObject>({
        tag: 'dmusic-port',
        matches: (o): o is PortObject => o instanceof PortObject,
        capture: (o, ref): SavedPort => {
            const synth = o.synth.captureState(collectionRef(ref));
            const unsaved = o.synth.activeVoiceCount - synth.voices.length;
            if (unsaved > 0) Logger.warn(LogCategory.COM, `[DMusic] savestate: ${unsaved} sounding voice(s) have no instrument to name and are not saved`);
            return {
                ...base(o), sampleRate: o.sampleRate, audioChannels: o.audioChannels, voices: o.voices, channelGroups: o.channelGroups,
                directSound: o.directSound, buffer: o.buffer, ownsBuffer: o.ownsBuffer, active: o.active,
                owner: optional(o.owner, ref, 'DirectMusic'), performance: optional(o.performance, ref, 'performance'),
                synth, sink: o.sink?.captureState() ?? null,
            };
        },
        restore: (d: SavedPort) => {
            const port = rebuild(() => new PortObject(), d);
            port.sampleRate = d.sampleRate;
            port.audioChannels = d.audioChannels;
            port.voices = d.voices;
            port.channelGroups = d.channelGroups;
            port.directSound = d.directSound;
            port.buffer = d.buffer;
            port.ownsBuffer = d.ownsBuffer;
            port.active = d.active;
            port.synth = new DlsSynth(d.sampleRate, d.voices);
            if (d.sink) {
                port.sink = host.newSink(d.buffer, d.audioChannels, d.sampleRate);
                port.sink.restoreState(d.sink);
            }
            host.wirePort(port);
            return port;
        },
        link: (port, d: SavedPort, ctx) => {
            port.owner = d.owner === NONE ? null : ctx.object(d.owner) as DirectMusicObject;
            port.performance = d.performance === NONE ? null : ctx.object(d.performance) as PerformanceObject;
            const dropped = port.synth.restoreState(d.synth, collectionOf(ctx));
            if (dropped > 0) Logger.warn(LogCategory.COM, `[DMusic] savestate: ${dropped} saved voice(s) dropped, their instrument is not ready`);
        },
    });
    objectCodecs.add<SegmentStateObject>({
        tag: 'dmusic-segment-state',
        matches: (o): o is SegmentStateObject => o instanceof SegmentStateObject,
        capture: (o, ref): SavedSegmentState => {
            const state = o.state;
            if (state && o.segment?.segment !== state.segment) {
                throw new CaptureRefusal('dmusic: a segment state whose segment was released or loaded again is not part of a savestate');
            }
            const stateRef = (s: PerfSegmentState): number => {
                const obj = o.performance?.stateObjects.get(s);
                if (!obj) throw new CaptureRefusal('dmusic: a queued segment state without its object is not part of a savestate');
                return ref(obj, 'queued state');
            };
            return {
                ...base(o), performance: optional(o.performance, ref, 'performance'), segment: optional(o.segment, ref, 'segment'),
                state: state ? named(() => capturePerfSegmentState(state, stateRef, (output) => ref(output, 'audio path'))) : null,
            };
        },
        restore: (d: SavedSegmentState) => {
            const obj = rebuild(() => new SegmentStateObject(), d);
            host.wireState(obj);
            return obj;
        },
        link: (obj, d: SavedSegmentState, ctx) => {
            obj.segment = d.segment === NONE ? null : ctx.object(d.segment) as SegmentObject;
            if (d.state) {
                const segment = obj.segment?.segment;
                if (!segment) throw new Error('dmusic: a saved segment state has no segment');
                obj.state = restorePerfSegmentState(segment, d.state);
                linkPerfSegmentState(obj.state, d.state, (r) => {
                    const queued = (ctx.object(r) as SegmentStateObject).state;
                    if (!queued) throw new Error('dmusic: a saved segment state queues an empty one');
                    return queued;
                }, (r) => ctx.object(r) as object);
            }
            obj.performance = d.performance === NONE ? null : ctx.object(d.performance) as PerformanceObject;
        },
    });
    objectCodecs.add<PerformanceObject>({
        tag: 'dmusic-performance',
        matches: (o): o is PerformanceObject => o instanceof PerformanceObject,
        capture: (o, ref): SavedPerformance => {
            const stateRef = (s: PerfSegmentState): number => {
                const obj = o.stateObjects.get(s);
                if (!obj) throw new CaptureRefusal('dmusic: a playing segment state without its object is not part of a savestate');
                return ref(obj, 'segment state');
            };
            const now = performance.now();
            return {
                ...base(o), directMusic: optional(o.directMusic, ref, 'DirectMusic'), port: optional(o.port, ref, 'port'),
                engine: o.engine ? named(() => o.engine!.captureState(stateRef, collectionRef(ref))) : null,
                notificationHandle: o.notificationHandle, notifySegments: o.notifySegments,
                notifications: o.notifications.map((n, i) => [n.type, ref(n.state, `notification ${i}`), n.musicTime, now - n.queuedAtMs]),
                stateObjects: [...o.stateObjects.values()].map((obj, i) => ref(obj, `state ${i}`)),
                masterVolume: o.masterVolume, masterTempo: o.masterTempo,
                defaultAudioPath: optional(o.defaultAudioPath, ref, 'default audio path'),
            };
        },
        restore: (d: SavedPerformance) => {
            const perf = rebuild(() => new PerformanceObject(), d);
            perf.notificationHandle = d.notificationHandle;
            perf.notifySegments = d.notifySegments;
            perf.masterVolume = d.masterVolume;
            perf.masterTempo = d.masterTempo;
            host.wirePerformance(perf);
            return perf;
        },
        link: (perf, d: SavedPerformance, ctx) => {
            const stateObject = (r: number): SegmentStateObject => ctx.object(r) as SegmentStateObject;
            const stateOf = (r: number): PerfSegmentState => {
                const state = stateObject(r).state;
                if (!state) throw new Error('dmusic: a saved performance plays an empty segment state');
                return state;
            };
            perf.directMusic = d.directMusic === NONE ? null : ctx.object(d.directMusic) as DirectMusicObject;
            perf.port = d.port === NONE ? null : ctx.object(d.port) as PortObject;
            perf.defaultAudioPath = d.defaultAudioPath === NONE ? null : ctx.object(d.defaultAudioPath) as AudioPathObject;
            for (const r of d.stateObjects) perf.stateObjects.set(stateOf(r), stateObject(r));
            if (d.engine) {
                if (!perf.port) throw new Error('dmusic: a saved performance has an engine but no port');
                perf.engine = host.newEngine(perf, perf.port);
                perf.engine.restoreState(d.engine, stateOf, collectionOf(ctx));
            }
            const now = performance.now();
            for (const [type, state, musicTime, ageMs] of d.notifications) {
                perf.notifications.push({ type, state: stateObject(state), musicTime, queuedAtMs: now - ageMs });
            }
        },
    });
    for (const [tag, type, what, content] of LOADABLE) {
        objectCodecs.add<LoadableObject>({
            tag: `dmusic-${tag}`,
            matches: (o): o is LoadableObject => o instanceof type,
            capture: (o, ref, blob): SavedLoadable | SavedSegment => {
                if (!o.source && o.loaded) {
                    throw new CaptureRefusal(`dmusic: ${what} that was not loaded from a stream, memory or a file is not part of a savestate`);
                }
                if (!o.source && (content as (o: LoadableObject) => unknown)(o)) {
                    throw new CaptureRefusal(`dmusic: ${what} whose load failed is not part of a savestate`);
                }
                let source: SavedSource | null = null;
                if (o.source && 'made' in o.source) {
                    const { of, ...made } = o.source;
                    const origin = o.resolved[0];
                    if (!(origin instanceof LoadableObject) || origin.source !== of) {
                        throw new CaptureRefusal(`dmusic: ${what} made from an object that was loaded again since is not part of a savestate`);
                    }
                    source = made;
                } else if (o.source) {
                    source = 'file' in o.source ? { ...o.source } : { blob: blob(o.source.bytes) };
                }
                const saved: SavedLoadable = {
                    ...base(o), fileName: o.fileName, identity: { ...o.identity }, source,
                    resolved: o.resolved.map((target, i) => target ? ref(target, `reference ${i}`) : -1),
                };
                if (!(o instanceof SegmentObject)) return saved;
                const segment = o.segment;
                return {
                    ...saved,
                    settings: segment ? Object.fromEntries(SEGMENT_SETTINGS.map(key => [key, segment[key]])) as SavedSegmentSettings : null,
                    commandEdits: [...o.commandEdits].map(([time, edit]) => [time, ...edit] as [number, number, number, number]),
                    tracks: o.tracks.flatMap((info, i) => info.object && info.object.refCount > 0 ? [[i, ref(info.object, `track ${i}`)] as [number, number]] : []),
                };
            },
            restore: (d: SavedLoadable) => {
                const o = rebuild(() => new type(), d);
                o.fileName = d.fileName;
                return o;
            },
            link: (o, d: SavedLoadable | SavedSegment, ctx) => {
                if (d.source && 'made' in d.source) {
                    const origin = d.resolved[0] === undefined || d.resolved[0] < 0 ? null : ctx.object(d.resolved[0]) as DMusicObject;
                    if (!host.rebuildMade(o, origin, d.source)) throw new Error(`dmusic: ${what} can no longer be made from its origin (${d.source.made})`);
                } else if (d.source) {
                    const source: ReadSource = 'file' in d.source ? { ...d.source } : { bytes: ctx.blob(d.source.blob) };
                    const from = 'file' in d.source ? d.source.file : `blob ${d.source.blob}`;
                    const resolved = d.resolved.map(r => r < 0 ? null : ctx.object(r) as DMusicObject);
                    if (!host.rebuildContents(o, source, sourceBytes(host, source, what), resolved)) {
                        throw new Error(`dmusic: ${what} no longer parses from ${from}`);
                    }
                    o.source = source;
                }
                Object.assign(o.identity, d.identity);
                if (!(o instanceof SegmentObject) || !('tracks' in d)) return;
                if (o.segment && d.settings) Object.assign(o.segment, d.settings);
                for (const [time, ...edit] of d.commandEdits) {
                    o.segment?.setCommand(time, ...edit);
                    o.commandEdits.set(time, edit);
                }
                for (const [index, r] of d.tracks) {
                    const info = o.tracks[index], track = ctx.object(r);
                    if (!info || !(track instanceof TrackObject)) throw new Error(`dmusic: a DirectMusic segment has no track ${index}`);
                    info.object = track;
                    track.owner = o;
                }
            },
        });
    }
    objectCodecs.add<TrackObject>({
        tag: 'dmusic-track',
        matches: (o): o is TrackObject => o instanceof TrackObject,
        capture: (o): SavedTrack => ({ ...base(o), classId: o.classId }),
        restore: (d: SavedTrack) => {
            const track = rebuild(() => new TrackObject(), d);
            track.classId = d.classId;
            return track;
        },
    });
}

export function registerDMusicParticipant(host: DMusicHost): () => void {
    registerDMusicCodecs(host);
    return savestateParticipants.add({
        id: 'dmusic', version: 5, order: 64, covers: ['dmusic'], schema: DMUSIC_SCHEMA as unknown as SaveValue,
        capture: (ctx): SaveValue => {
            const refusal = host.idleRefusal();
            if (refusal) throw new CaptureRefusal(refusal);
            const state = host.moduleState();
            const saved: SavedModule = {
                performances: state.performances.map((o, i) => ctx.ref(o, `dmusic performance ${i}`)),
                ports: state.ports.map((o, i) => ctx.ref(o, `dmusic port ${i}`)),
                pathOutputs: state.pathOutputs.map((o, i) => ctx.ref(o, `dmusic audio path ${i}`)),
                messages: state.messages.map(([address, obj]) => [address, obj ? ctx.ref(obj, `dmusic message 0x${address.toString(16)}`) : NONE]),
                pumpTimer: state.pumpTimer ?? NONE,
            };
            return saved as unknown as SaveValue;
        },
        restore: (value, ctx) => {
            const saved = value as unknown as SavedModule;
            host.restoreModuleState({
                performances: saved.performances.map(r => ctx.object(r) as PerformanceObject),
                ports: saved.ports.map(r => ctx.object(r) as PortObject),
                pathOutputs: saved.pathOutputs.map(r => ctx.object(r) as AudioPathObject),
                messages: saved.messages.map(([address, r]) => [address, r === NONE ? null : ctx.object(r) as SegmentStateObject]),
                pumpTimer: saved.pumpTimer === NONE ? null : saved.pumpTimer,
            });
        },
    });
}
