import type { DlsCollection } from "@bottleship/formats/dmusic/dls";
import { BaseComObject, type ComBaseState } from "../core/com/base-com-object";
import { CaptureRefusal, objectCodecs } from "../savestate/object-codecs";
import { savestateParticipants, stateKeys, type FieldPolicy } from "../savestate/participant";
import type { SaveValue } from "../savestate/value-codec";
import {
    AudioPathObject, BandObject, CollectionObject, ComposerObject, DirectMusicObject, type DMusicObject, type LoadableObject, LoaderObject,
    PerformanceObject, PortObject, SegmentObject, SegmentStateObject, StyleObject, TrackObject,
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
    fileName: 'derive', loaded: 'derive', references: 'transient', collection: 'derive',
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
    base: stateKeys<SavedDMusicBase>({ base: true, addresses: true }),
    addressRow: ['vtableName', 'guestAddress'],
    cacheRow: ['fullPathLowerCase', 'object'],
} as const;

export interface DMusicHost {
    idleRefusal(): string | null;
    defaultGmCollection(): DlsCollection;
    releaseDirectSound(dm: DirectMusicObject): void;
    wireLoader(loader: LoaderObject): LoaderObject;
}

const base = (o: DMusicObject): SavedDMusicBase => ({ base: BaseComObject.captureComBase(o), addresses: [...o.addresses] });

function rebuild<T extends DMusicObject>(make: () => T, d: SavedDMusicBase): T {
    const o = BaseComObject.restoreComBase(make, d.base);
    for (const [name, address] of d.addresses) o.addresses.set(name, address);
    return o;
}

export function isDefaultGmCollection(o: CollectionObject): boolean {
    return o.identity.objectId === GUID_DEFAULT_GM_COLLECTION && o.fileName === "";
}

const REFUSED: Array<[string, new (...a: never[]) => DMusicObject, string]> = [
    ['performance', PerformanceObject, 'a DirectMusic performance'],
    ['port', PortObject, 'a DirectMusic port'],
    ['segment', SegmentObject, 'a DirectMusic segment'],
    ['segment-state', SegmentStateObject, 'a DirectMusic segment state'],
    ['style', StyleObject, 'a DirectMusic style'],
    ['band', BandObject, 'a DirectMusic band'],
    ['track', TrackObject, 'a DirectMusic track'],
];

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
        matches: (o): o is CollectionObject => o instanceof CollectionObject,
        capture: (o) => {
            if (!isDefaultGmCollection(o)) throw new CaptureRefusal('dmusic: a loaded DLS collection is not part of a v1 savestate');
            return base(o);
        },
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
        capture: (o) => base(o),
        restore: (d: SavedDMusicBase) => rebuild(() => new AudioPathObject(), d),
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
        id: 'dmusic', version: 2, order: 64, covers: ['dmusic'], schema: DMUSIC_SCHEMA as unknown as SaveValue,
        capture: () => {
            const refusal = host.idleRefusal();
            if (refusal) throw new CaptureRefusal(refusal);
            return {};
        },
        restore: () => undefined,
    });
}
