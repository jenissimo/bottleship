import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { DMusic } from "../../src/worker/modules/dmusic";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { CaptureRefusal, newObjectGraph, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import { BaseComObject } from "../../src/worker/core/com/base-com-object";
import {
    AudioPathObject, BandObject, CollectionObject, ComposerObject, DirectMusicObject, LoaderObject, PerformanceObject,
    PortObject, SegmentObject, SegmentStateObject, StyleObject, TrackObject,
} from "../../src/worker/modules/dmusic-objects";
import {
    DEFAULT_COLLECTION_FIELDS, DIRECTMUSIC_FIELDS, DMUSIC_MODULE_FIELDS, GUID_DEFAULT_GM_COLLECTION, LOADER_FIELDS,
    registerDMusicCodecs, type DMusicHost,
} from "../../src/worker/modules/dmusic-savestate";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Fields = Record<string, unknown>;

let comBefore = new Set<number>();
beforeEach(() => {
    comBefore = new Set(System.getInstance().resourceProvider.getAllComObjects().map(o => o.handle));
});
afterEach(() => {
    for (const o of System.getInstance().resourceProvider.getAllComObjects()) if (!comBefore.has(o.handle)) o.forceRelease();
});

function host(released: DirectMusicObject[] = []): DMusicHost {
    return {
        idleRefusal: () => null,
        defaultGmCollection: () => ({ identity: { objectId: GUID_DEFAULT_GM_COLLECTION, name: "GM", versionMS: 0, versionLS: 0, hasVersion: false }, instruments: [], waves: [] }),
        releaseDirectSound: (dm) => { released.push(dm); },
        wireLoader: (loader) => {
            loader.onDestroy = () => {
                loader.defaultCollection?.release();
                loader.defaultCollection = null;
            };
            return loader;
        },
        readFile: () => null,
        rebuildContents: () => false,
    };
}

function roundTrip(roots: unknown[], h: DMusicHost = host()): { first: string; restored: unknown[]; again: string } {
    registerDMusicCodecs(h);
    const g = newObjectGraph();
    const refs = roots.map((o, i) => g.ref(o, `root ${i}`));
    const first = bytes(g.objects);
    const ctx = restoreObjectGraph(structuredClone(g.objects));
    const restored = refs.map(r => ctx.object(r));
    const g2 = newObjectGraph();
    restored.forEach((o, i) => g2.ref(o, `root ${i}`));
    return { first, restored, again: bytes(g2.objects) };
}

function defaultCollection(): CollectionObject {
    const c = new CollectionObject();
    c.identity.objectId = GUID_DEFAULT_GM_COLLECTION;
    c.identity.name = "GM";
    c.collection = { identity: { ...c.identity }, instruments: [], waves: [] };
    c.loaded = true;
    return c;
}

describe("dmusic objects", () => {
    test("a loader keeps its search directory, interfaces and default collection, which is rebuilt from the system GM file", () => {
        const loader = new LoaderObject();
        loader.searchDirectory = "C:\\GAME\\MUSIC";
        loader.cacheDisabled.add("d2ac2882-b39b-11d1-8704-00600893b1bd");
        loader.addresses.set("IDirectMusicLoader8", 0x7000);
        const collection = defaultCollection();
        loader.defaultCollection = collection;
        (loader as unknown as Fields)._refCount = 2;
        const { first, again, restored } = roundTrip([loader]);
        expect(again).toBe(first);
        const back = restored[0] as LoaderObject;
        expect(back.searchDirectory).toBe("C:\\GAME\\MUSIC");
        expect([...back.cacheDisabled]).toEqual(["d2ac2882-b39b-11d1-8704-00600893b1bd"]);
        expect([...back.addresses]).toEqual([["IDirectMusicLoader8", 0x7000]]);
        expect(BaseComObject.captureComBase(back)).toEqual(BaseComObject.captureComBase(loader));
        expect(back.defaultCollection).toBeInstanceOf(CollectionObject);
        expect(back.defaultCollection!.collection).not.toBeNull();
        expect(back.defaultCollection!.handle).toBe(collection.handle);
        const restoredCollection = back.defaultCollection!;
        let released = 0;
        restoredCollection.release = () => ++released;
        back.onDestroy?.();
        expect(back.defaultCollection).toBeNull();
        expect(released).toBe(1);
    });

    test("DirectMusic keeps its DirectSound and releases it when it goes", () => {
        const dm = new DirectMusicObject();
        dm.directSound = 0x5000;
        const released: DirectMusicObject[] = [];
        const { first, again, restored } = roundTrip([dm], host(released));
        expect(again).toBe(first);
        const back = restored[0] as DirectMusicObject;
        expect(back.directSound).toBe(0x5000);
        back.onDestroy?.();
        expect(released).toEqual([back]);
    });

    test("the composer and an audio path round-trip", () => {
        const { first, again } = roundTrip([new ComposerObject(), new AudioPathObject()]);
        expect(again).toBe(first);
    });

    test("objects that play music are refused by name, and so is a loaded object without its source", () => {
        registerDMusicCodecs(host());
        const named: Array<[unknown, string]> = [
            [new PerformanceObject(), "a DirectMusic performance"], [new PortObject(), "a DirectMusic port"],
            [new SegmentStateObject(), "a DirectMusic segment state"],
        ];
        for (const [obj, what] of named) {
            expect(() => newObjectGraph().ref(obj, "x")).toThrow(CaptureRefusal);
            expect(() => newObjectGraph().ref(obj, "x")).toThrow(`dmusic: ${what} is not part of a v1 savestate`);
        }
        const loaded = new CollectionObject();
        loaded.fileName = "music.dls";
        loaded.loaded = true;
        expect(() => newObjectGraph().ref(loaded, "x")).toThrow("dmusic: a DLS collection that was not loaded from a stream, memory or a file");
        const dm = new DirectMusicObject();
        dm.ports.add(new PortObject());
        expect(() => newObjectGraph().ref(dm, "x")).toThrow("port");
        const cachingLoader = new LoaderObject();
        const cached = new SegmentObject();
        cached.loaded = true;
        cachingLoader.cache.set("c:\\game\\song.mid", cached);
        expect(() => newObjectGraph().ref(cachingLoader, "x")).toThrow("dmusic: a DirectMusic segment that was not loaded");
    });

    test("objects created but not loaded, and a track, round-trip", () => {
        const track = new TrackObject();
        track.classId = "d2ac2894-b39b-11d1-8704-00600893b1bd";
        const { first, again, restored } = roundTrip([new SegmentObject(), new StyleObject(), new BandObject(), new CollectionObject(), track]);
        expect(again).toBe(first);
        expect(restored.map(o => (o as object).constructor)).toEqual([SegmentObject, StyleObject, BandObject, CollectionObject, TrackObject]);
        expect((restored[4] as TrackObject).classId).toBe(track.classId);
    });

    test("every field of the saved objects has a policy", () => {
        class Plain extends BaseComObject {
            constructor() {
                super("00000000-0000-0000-c000-000000000046", 0);
            }

            protected destroy(): void {
                return;
            }
        }
        const baseKeys = new Set(Object.keys(new Plain()));
        const own = (o: object) => Object.keys(o).filter(k => !baseKeys.has(k)).sort();
        expect(own(new LoaderObject())).toEqual(Object.keys(LOADER_FIELDS).sort());
        expect(own(new DirectMusicObject())).toEqual(Object.keys(DIRECTMUSIC_FIELDS).sort());
        expect(own(new CollectionObject())).toEqual(Object.keys(DEFAULT_COLLECTION_FIELDS).sort());
    });
});

describe("dmusic module", () => {
    test("every instance field has a policy", () => {
        expect(Object.keys(new DMusic()).sort()).toEqual(Object.keys(DMUSIC_MODULE_FIELDS).sort());
    });

    test("a new loader's default collection and a restored one come from the same reader", () => {
        const d = new DMusic() as DMusic & Fields;
        d.readSystemFile = () => null;
        const fresh = (d.defaultCollection as (l: LoaderObject) => CollectionObject).call(d, new LoaderObject());
        const restored = (d.defaultGmCollection as () => unknown).call(d);
        expect(restored).toEqual(fresh.collection);
        expect(fresh.identity.objectId).toBe(GUID_DEFAULT_GM_COLLECTION);
    });

    test("an idle module saves; a performance, port, loading object, message or running pump refuses", () => {
        const d = new DMusic() as DMusic & Fields;
        expect(d.savestateRefusal()).toBeNull();
        (d.performances as Set<unknown>).add({});
        expect(d.savestateRefusal()).toContain("performance or port");
        (d.performances as Set<unknown>).clear();
        (d.ports as Set<unknown>).add({});
        expect(d.savestateRefusal()).toContain("performance or port");
        (d.ports as Set<unknown>).clear();
        (d.loading as Set<unknown>).add({});
        expect(d.savestateRefusal()).toContain("still loading");
        (d.loading as Set<unknown>).clear();
        (d.messages as Map<number, unknown>).set(1, null);
        expect(d.savestateRefusal()).toContain("messages");
        (d.messages as Map<number, unknown>).clear();
        d.pumpTimer = 3;
        expect(d.savestateRefusal()).toContain("pump");
    });
});
