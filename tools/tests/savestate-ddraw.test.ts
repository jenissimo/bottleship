import { describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { CaptureRefusal, newObjectGraph, restoreObjectGraph } from "../../src/worker/savestate/object-codecs";
import {
    BITMAP_TEXTURE_FIELDS, DirectDrawSurfaceObject, RENDER_SURFACE_FIELDS, SURFACE_FIELDS, awaitsTextureAfterRestore,
    captureSurfaceState, restoreSurfaceState, textureCreatedAfterRestore, type DirectDrawSurfaceState,
} from "../../src/worker/modules/ddraw/com-objects";
import { DirectDrawClipperObject, DirectDrawObject, DirectDrawPaletteObject } from "../../src/worker/modules/ddraw/com-objects-ddraw";
import { captureTearOffs, restoreTearOffs } from "../../src/worker/modules/ddraw/com-tearoff";
import {
    DDRAW_CONTEXT_FIELDS, DDRAW_SCHEMA, captureDDrawState, liveSurfaceStates, readBackGpuLatest, registerDDrawCodecs,
    restoreDDrawState, type DDrawHost, type DDrawState,
} from "../../src/worker/modules/ddraw/savestate";
import type { DDrawContext } from "../../src/worker/modules/ddraw/context";
import { BaseComObject } from "../../src/worker/core/com/base-com-object";
import { System } from "../../src/worker/core/system";
import { lostSurfaceCount, recountLostSurfaces } from "../../src/worker/core/gpu/gpu-device-loss-contract";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
};

type Fields = Record<string, unknown>;

function renderSurface(extra: Fields = {}): DirectDrawSurfaceState {
    return {
        surfaceType: "render_surface", width: 8, height: 4, pitch: 16, caps: 0x200, surfacePtr: 0x10000,
        format: { flags: 0x40, bpp: 16, rMask: 0xf800, gMask: 0x7e0, bMask: 0x1f, aMask: 0 },
        attachedSurfaceAddr: 0, mode: "CPU", version: 3, gpuDirty: false, everLocked: true, lastUploadVersion: 3,
        writeGeneration: 2, srcColorKey: { low: 1, high: 1 },
        privateData: new Map([["{guid}", { size: 4, bytes: new Uint8Array([1, 2, 3, 4]) }]]),
        ...extra,
    } as unknown as DirectDrawSurfaceState;
}

function bitmapTexture(extra: Fields = {}): DirectDrawSurfaceState {
    return {
        surfaceType: "bitmap_texture", width: 2, height: 2, pitch: 8, caps: 0x1000, surfacePtr: 0x20000,
        format: { flags: 0x40, bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff, aMask: 0xff000000 },
        attachedSurfaceAddr: 0, rgbaScratch: new Uint8Array(16).fill(3), gpuNeedsUpload: false, contentVersion: 2,
        d3dFormat: 21, dxtFormat: 0, palette: new Uint32Array([1, 2]), needsUVFlip: false,
        ...extra,
    } as unknown as DirectDrawSurfaceState;
}

function perturb(v: unknown): unknown {
    if (typeof v === "number") return v + 1;
    if (typeof v === "boolean") return !v;
    if (typeof v === "string") return "GPU_ONLY";
    if (v instanceof Uint8Array) return Uint8Array.from(v, b => b + 1);
    if (v instanceof Uint32Array) return Uint32Array.from(v, b => b + 1);
    if (Array.isArray(v)) return [...v, 9];
    return { ...(v as object), extra: 1 };
}

function withoutProcess<T>(run: () => T): T {
    const system = System.getInstance();
    const process = system.process;
    system.process = null;
    try {
        return run();
    } finally {
        system.process = process;
    }
}

function graphRoundTrip<T>(obj: T): { first: string; again: string; restored: T; objects: Array<[string, SaveValue]> } {
    registerDDrawCodecs();
    const g = newObjectGraph();
    const ref = g.ref(obj, "test");
    const first = bytes(g.objects);
    const ctx = restoreObjectGraph(structuredClone(g.objects));
    const restored = ctx.object(ref) as T;
    const g2 = newObjectGraph();
    g2.ref(restored, "test");
    return { first, again: bytes(g2.objects), restored, objects: g.objects };
}

const comBase = (o: BaseComObject) => BaseComObject.captureComBase(o);

describe("surface state", () => {
    test("capture → restore → capture is byte-identical for a render surface and a bitmap texture", () => {
        for (const st of [renderSurface(), bitmapTexture()]) {
            const first = captureSurfaceState(st);
            expect(bytes(captureSurfaceState(restoreSurfaceState(structuredClone(first))))).toBe(bytes(first));
        }
    });

    test("every saved base, render-surface and bitmap-texture field reaches the capture", () => {
        const cases: Array<[DirectDrawSurfaceState, Record<string, string>]> = [
            [renderSurface({
                caps2: 1, caps3: 1, caps4: 1, attachedSurfaceAddrs: [1], implicitChainMember: true, attachRefOwner: 1,
                zOwnerSurfaces: [1], surfacePtrAllocated: true, vidMemSize: 1, destColorKey: { low: 1, high: 1 }, mipMapCount: 1,
                textureStage: 1, alphaBitDepth: 1, paletteHandle: 1, clipperHandle: 1, needsColorClear: true, clearColor: 1,
                surfaceEverWritten: true, surfaceLost: false, lastLockReadOnly: true,
            }), { ...SURFACE_FIELDS, ...RENDER_SURFACE_FIELDS }],
            [bitmapTexture(), BITMAP_TEXTURE_FIELDS],
        ];
        for (const [base, fields] of cases) {
            const before = bytes(captureSurfaceState(base));
            for (const [field, policy] of Object.entries(fields)) {
                if (policy !== "save" || field === "surfaceType" || field === "mipSublevels" || field === "privateData") continue;
                const changed = { ...base, [field]: perturb((base as unknown as Fields)[field]) };
                expect({ field, same: bytes(captureSurfaceState(changed as unknown as DirectDrawSurfaceState)) === before }).toEqual({ field, same: false });
            }
        }
    });

    test("restore resets the derived GPU state and marks render surfaces for a texture on first present", () => {
        const render = restoreSurfaceState(captureSurfaceState(renderSurface({ mode: "GPU_ONLY", gpuTexture: {} }))) as unknown as Fields;
        expect(render.mode).toBe("CPU");
        expect(render.gpuDirty).toBe(true);
        expect(render.lastUploadVersion).toBe(-1);
        expect(render.gpuTexture).toBeUndefined();
        expect(awaitsTextureAfterRestore(render as never)).toBe(true);
        textureCreatedAfterRestore(render as never);
        expect(awaitsTextureAfterRestore(render as never)).toBe(false);
        const bitmap = restoreSurfaceState(captureSurfaceState(bitmapTexture())) as unknown as Fields;
        expect(bitmap.gpuNeedsUpload).toBe(true);
        expect(awaitsTextureAfterRestore(bitmap as never)).toBe(false);
        expect(awaitsTextureAfterRestore(renderSurface())).toBe(false);
    });

    test("a surface whose latest pixels exist only on the GPU refuses the capture", () => {
        const st = renderSurface({ gpuTexture: {}, gpuWrittenVersion: 3, cpuSyncedVersion: 2 });
        expect(() => captureSurfaceState(st)).toThrow(CaptureRefusal);
        expect(() => captureSurfaceState(st)).toThrow("only on the GPU");
    });

    test("a locked surface refuses the capture", () => {
        expect(() => captureSurfaceState(renderSurface({ activeLeaseId: 1 }))).toThrow(CaptureRefusal);
    });
});

describe("DirectDraw COM objects", () => {
    test("a surface keeps handle, refcount, interface refs and caches without registering again", () => {
        withoutProcess(() => {
            const surface = new DirectDrawSurfaceObject(0x5000, renderSurface());
            const raw = surface as unknown as Fields;
            raw._refCount = 3;
            raw._ifaceRefs = new Map([[0x5004, 2]]);
            raw._liveIfaces = 2;
            surface.setCachedTextureHandle(7);
            surface.setCachedTexture2Handle(9);
            surface.setDDrawOwnerAddr(0x6000);
            const handles = System.getInstance().resourceProvider.getAllComObjects().length;
            const { first, again, restored } = graphRoundTrip(surface);
            expect(again).toBe(first);
            expect(comBase(restored)).toEqual(comBase(surface));
            expect(restored.getCachedTextureHandle()).toBe(7);
            expect(restored.getCachedTexture2Handle()).toBe(9);
            expect(System.getInstance().resourceProvider.getAllComObjects().length).toBe(handles);
        });
    });

    test("a destroyed object stays destroyed", () => {
        const palette = new DirectDrawPaletteObject(0x5100);
        (palette as unknown as Fields)._destroyed = true;
        const { restored } = graphRoundTrip(palette);
        expect(comBase(restored).destroyed).toBe(true);
    });

    test("palette entries and caps, the clip list and the DirectDraw object's tear-offs come back", () => {
        const palette = new DirectDrawPaletteObject(0x5100);
        const p = palette as unknown as Fields;
        p.entriesRaw = new Uint8Array([1, 2, 3, 4]);
        p.paletteRGBA = new Uint32Array([0xff010203]);
        p.caps = 0x44;
        p.version = 5;
        const clipper = new DirectDrawClipperObject(0x5200);
        clipper.setHwnd(0x20001);
        (clipper as unknown as Fields).clipListData = new Uint8Array([9, 8, 7]);
        const dd = new DirectDrawObject(0x5300);
        restoreTearOffs(dd, [["IDirectDraw2", 0x7000]]);
        const pal = graphRoundTrip(palette);
        expect(pal.again).toBe(pal.first);
        const back = pal.restored as unknown as Fields;
        expect([...(back.entriesRaw as Uint8Array)]).toEqual([1, 2, 3, 4]);
        expect(back.caps).toBe(0x44);
        expect(back.version).toBe(5);
        const clip = graphRoundTrip(clipper);
        expect(clip.again).toBe(clip.first);
        expect([...((clip.restored as unknown as Fields).clipListData as Uint8Array)]).toEqual([9, 8, 7]);
        const ddraw = graphRoundTrip(dd);
        expect(ddraw.again).toBe(ddraw.first);
        expect(captureTearOffs(ddraw.restored)).toEqual([["IDirectDraw2", 0x7000]]);
    });

    test("a mip level owned by its own surface object is saved once and shared again after the restore", () => {
        withoutProcess(() => {
            registerDDrawCodecs();
            const provider = System.getInstance().resourceProvider;
            const table = (provider as unknown as { comObjects: { create(h: number, o: unknown): void } }).comObjects;
            const mipState = renderSurface({ surfacePtr: 0x30000, width: 4, height: 2, surfaceLost: true });
            const root = new DirectDrawSurfaceObject(0x5400, renderSurface({ mipSublevels: [mipState], mipMapCount: 2 }));
            const mip = new DirectDrawSurfaceObject(0x5400, mipState);
            const g = newObjectGraph();
            const rootRef = g.ref(root, "root");
            const mipRef = g.ref(mip, "mip");
            expect(g.objects.length).toBe(2);
            const first = bytes(g.objects);
            const ctx = restoreObjectGraph(structuredClone(g.objects));
            const restoredRoot = ctx.object(rootRef) as DirectDrawSurfaceObject;
            const restoredMip = ctx.object(mipRef) as DirectDrawSurfaceObject;
            expect(restoredRoot.getState().mipSublevels![0]).toBe(restoredMip.getState());
            provider.unregisterComObject(root.handle);
            provider.unregisterComObject(mip.handle);
            table.create(restoredRoot.handle, restoredRoot);
            table.create(restoredMip.handle, restoredMip);
            try {
                const g2 = newObjectGraph();
                g2.ref(restoredRoot, "root");
                g2.ref(restoredMip, "mip");
                expect(bytes(g2.objects)).toBe(first);
                recountLostSurfaces(liveSurfaceStates([restoredRoot, restoredMip]));
                expect(lostSurfaceCount()).toBe(1);
            } finally {
                provider.unregisterComObject(restoredRoot.handle);
                provider.unregisterComObject(restoredMip.handle);
                recountLostSurfaces([]);
            }
        });
    });
});

describe("ddraw participant", () => {
    function host(extra: Partial<DDrawContext> = {}, states: DirectDrawSurfaceState[] = []): DDrawHost & { ctx: DDrawContext } {
        const ctx = {
            display: { width: 640, height: 480, bpp: 16, refresh: 60 },
            desktopMode: { width: 1024, height: 768, bpp: 32, refresh: 60 },
            cooperative: { hwnd: 0x20001, flags: 0x11, exclusive: true },
            gdiSurfaceVisible: false, surfaces: { primary: 0x8000, backBuffer: 0x8100 }, ddraw7ObjectAddr: 0x9000,
            usedVidMem: 1234, textureHandles: new Map(), nextTextureHandle: 5, suppressPresent: false,
            deferredSurfacePtrFrees: [0x100],
            ...extra,
        } as unknown as DDrawContext;
        const bitmaps = new Map([[0x30001, 0x8200]]);
        return { ctx, context: () => ctx, bitmapSurfaces: () => bitmaps, surfaceStates: () => states };
    }

    function fresh(states: DirectDrawSurfaceState[] = []): ReturnType<typeof host> {
        const h = host({ display: { width: 800, height: 600, bpp: 32, refresh: 60 }, usedVidMem: 0, surfaces: { primary: 0, backBuffer: 0 } }, states);
        h.bitmapSurfaces().clear();
        return h;
    }

    test("capture → restore → capture is byte-identical", () => {
        const first = captureDDrawState(host());
        const h = fresh();
        restoreDDrawState(h, structuredClone(first));
        expect(bytes(captureDDrawState(h))).toBe(bytes(first));
    });

    test("the context field table covers DDrawContext and names exactly the saved state", () => {
        const saved = Object.entries(DDRAW_CONTEXT_FIELDS).filter(([, p]) => p === "save").map(([k]) => k);
        expect([...saved, "bitmapSurfaces"].sort()).toEqual([...DDRAW_SCHEMA.state].sort());
    });

    test("every saved field survives a restore into a reset context", () => {
        const values: Record<keyof DDrawState, unknown> = {
            display: { width: 320, height: 200, bpp: 8, refresh: 70 },
            desktopMode: { width: 1280, height: 1024, bpp: 16, refresh: 75 },
            cooperative: { hwnd: 0x20003, flags: 0x8, exclusive: false },
            gdiSurfaceVisible: true,
            surfaces: { primary: 0x8800, backBuffer: 0x8900 },
            ddraw7ObjectAddr: 0x9100,
            usedVidMem: 4321,
            nextTextureHandle: 9,
            suppressPresent: true,
            gammaRamp: { red: new Float32Array([0.5]), green: new Float32Array([0.25]), blue: new Float32Array([0.125]), isIdentity: false },
            deferredSurfacePtrFrees: [0x200, 0x300],
            bitmapSurfaces: [[0x30002, 0x8a00]],
        };
        expect(Object.keys(values).sort()).toEqual([...DDRAW_SCHEMA.state].sort());
        for (const [field, value] of Object.entries(values) as Array<[keyof DDrawState, unknown]>) {
            const saved = { ...captureDDrawState(host()), [field]: value } as DDrawState;
            const h = fresh();
            restoreDDrawState(h, structuredClone(saved));
            expect({ field, value: bytes(captureDDrawState(h)[field]) }).toEqual({ field, value: bytes(value) });
        }
    });

    test("restore tells the host the display mode once", () => {
        const system = System.getInstance() as unknown as { requestHostResize: (...a: unknown[]) => void };
        const original = system.requestHostResize;
        const calls: unknown[][] = [];
        system.requestHostResize = (...a: unknown[]) => { calls.push(a); };
        try {
            restoreDDrawState(fresh(), structuredClone(captureDDrawState(host())));
        } finally {
            system.requestHostResize = original;
        }
        expect(calls).toEqual([[640, 480, { modeSet: true, bpp: 16, refreshRate: 60 }]]);
    });

    test("restore recounts lost surfaces from the restored set", () => {
        const states = [renderSurface({ surfaceLost: true }), renderSurface(), bitmapTexture({ surfaceLost: true })];
        restoreDDrawState(fresh(states), structuredClone(captureDDrawState(host())));
        expect(lostSurfaceCount()).toBe(2);
        recountLostSurfaces([]);
        expect(lostSurfaceCount()).toBe(0);
    });

    test("restore refuses a context that DirectDraw already used", () => {
        const saved = captureDDrawState(host());
        expect(() => restoreDDrawState(host(), structuredClone(saved))).toThrow("fresh worker");
        const used = fresh();
        used.ctx.textureHandles.set(1, {} as never);
        expect(() => restoreDDrawState(used, structuredClone(saved))).toThrow("fresh worker");
    });

    test("GPU-only pixels are read back before the capture; without a device the capture refuses", async () => {
        const gpuLatest = () => renderSurface({ gpuTexture: {}, gpuWrittenVersion: 3, cpuSyncedVersion: 2 });
        const st = gpuLatest();
        const synced: DirectDrawSurfaceState[] = [];
        const executor = { syncSurfaceToMemory: async (s: DirectDrawSurfaceState) => { synced.push(s); (s as unknown as Fields).cpuSyncedVersion = 3; } };
        expect(await readBackGpuLatest(host({ executor } as never, [st, renderSurface()]))).toBe(1);
        expect(synced).toEqual([st]);
        expect(() => captureSurfaceState(st)).not.toThrow();
        const stuck = gpuLatest();
        expect(await readBackGpuLatest(host({}, [stuck]))).toBe(0);
        expect(() => captureSurfaceState(stuck)).toThrow("only on the GPU");
    });

    test("refuses Direct3D texture handles", () => {
        expect(() => captureDDrawState(host({ textureHandles: new Map([[1, {} as never]]) }))).toThrow("texture handles");
    });
});
