import type { DlsCollection } from "@bottleship/formats/dmusic/dls";
import type { ObjectIdentity } from "@bottleship/formats/dmusic/reference";
import { BaseComObject, type ComBaseState } from "../core/com/base-com-object";
import { CaptureRefusal, objectCodecs } from "../savestate/object-codecs";
import { savestateParticipants, stateKeys, type FieldPolicy } from "../savestate/participant";
import { sha256HexSync } from "../savestate/sha256";
import type { SaveValue } from "../savestate/value-codec";
import {
    AudioPathObject, BandObject, CollectionObject, ComposerObject, DirectMusicObject, type DMusicObject, LoadableObject, LoaderObject,
    type MadeSource, type ObjectSource, PerformanceObject, PortObject, SegmentObject, SegmentStateObject, StyleObject, TrackObject,
} from "./dmusic-objects";

export const GUID_DEFAULT_GM_COLLECTION = "f17e8673-c3b4-11d1-870b-00600893b1bd";

export interface SavedDMusicBase { base: ComBaseState; addresses: Array<[string, number]> }
export interface SavedLoader extends SavedDMusicBase {
    searchDirectory: string;
    defaultCollection: number;
    cache: Array<[string, number]>;
    cacheDisabled: string[];
}
export interface SavedDirectMusic extends SavedDMusicBase { directSound: number }

export const DMUSIC_OBJECT_FIELDS = {
    addresses: 'save', onDestroy: 'derive',
} as const satisfies Record<string, FieldPolicy>;

export const LOADER_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', defaultCollection: 'save', searchDirectory: 'save',
    cache: 'save', cacheDisabled: 'save',
} as const satisfies Record<string, FieldPolicy>;

export const DIRECTMUSIC_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', directSound: 'save', ports: 'transient',
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

export interface SavedAudioPath extends SavedDMusicBase { pathType: number }

export const AUDIO_PATH_FIELDS = {
    ...DMUSIC_OBJECT_FIELDS, primaryVtable: 'derive', interfaces: 'derive', pathType: 'save', performance: 'transient',
    buffer: 'transient', sink: 'transient', channels: 'derive',
} as const satisfies Record<string, FieldPolicy>;

export const DMUSIC_MODULE_FIELDS = {
    name: 'transient', exports: 'host', vtables: 'derive', process: 'host', ports: 'transient', performances: 'transient',
    loading: 'transient', pumpTimer: 'transient', mixLeft: 'transient', mixRight: 'transient', messages: 'transient',
    pathOutputs: 'transient', decodedWaves: 'transient',
} as const satisfies Record<string, FieldPolicy>;

export const DMUSIC_SCHEMA = {
    module: DMUSIC_MODULE_FIELDS,
    object: DMUSIC_OBJECT_FIELDS,
    loader: LOADER_FIELDS,
    directMusic: DIRECTMUSIC_FIELDS,
    defaultCollection: DEFAULT_COLLECTION_FIELDS,
    audioPath: AUDIO_PATH_FIELDS,
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

const REFUSED: Array<[string, new (...a: never[]) => DMusicObject, string]> = [
    ['performance', PerformanceObject, 'a DirectMusic performance'],
    ['port', PortObject, 'a DirectMusic port'],
    ['segment-state', SegmentStateObject, 'a DirectMusic segment state'],
];

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
            o.loaded = true;
            return o;
        },
    });
    objectCodecs.add<DirectMusicObject>({
        tag: 'dmusic-directmusic',
        matches: (o): o is DirectMusicObject => o instanceof DirectMusicObject,
        capture: (o) => {
            if (o.ports.size > 0) throw new CaptureRefusal('dmusic: a DirectMusic port is not part of a v1 savestate');
            return { ...base(o), directSound: o.directSound };
        },
        restore: (d: SavedDirectMusic) => {
            const dm = rebuild(() => new DirectMusicObject(), d);
            dm.directSound = d.directSound;
            dm.onDestroy = () => host.releaseDirectSound(dm);
            return dm;
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
        capture: (o): SavedAudioPath => ({ ...base(o), pathType: o.pathType }),
        restore: (d: SavedAudioPath) => {
            const path = rebuild(() => new AudioPathObject(), d);
            path.pathType = d.pathType ?? 0;
            return path;
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
    for (const [tag, type, what] of REFUSED) {
        objectCodecs.add<DMusicObject>({
            tag: `dmusic-refused-${tag}`,
            matches: (o): o is DMusicObject => o instanceof type,
            capture: () => { throw new CaptureRefusal(`dmusic: ${what} is not part of a v1 savestate`); },
            restore: () => { throw new Error(`dmusic: ${what} cannot be restored`); },
        });
    }
}

export function registerDMusicParticipant(host: DMusicHost): () => void {
    registerDMusicCodecs(host);
    return savestateParticipants.add({
        id: 'dmusic', version: 5, order: 64, covers: ['dmusic'], schema: DMUSIC_SCHEMA as unknown as SaveValue,
        capture: () => {
            const refusal = host.idleRefusal();
            if (refusal) throw new CaptureRefusal(refusal);
            return {};
        },
        restore: () => undefined,
    });
}
