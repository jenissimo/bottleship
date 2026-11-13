/**
 * An implicit present of the primary (Unlock, Blt, BltFast) is drawn at the next refresh, but
 * the pixels it shows are the ones the guest committed at that call. A guest that keeps
 * writing the front outside any lock (a pointer cached before a Flip) must not be sampled
 * half-way through by the refresh. Flip, explicit presents and the scanout poller still read
 * guest memory when they draw.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { DDrawPresenter, type PresentClock } from "../../src/worker/modules/ddraw/presenter";
import { createSurfaceExports } from "../../src/worker/modules/ddraw/surface";
import { createSurfaceBltFlipExports } from "../../src/worker/modules/ddraw/surface-blt-flip";
import { DirectDrawSurfaceObject, type DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";
import { DeferredUploadManager } from "../../src/worker/modules/ddraw/deferred-upload-manager";
import { System } from "../../src/worker/core/system";
import { useWebGpuFlags } from "./helpers/scoped-globals";

class ManualClock implements PresentClock {
    t = 0;
    private refresh = new Set<() => void>();
    private timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    now(): number { return this.t; }
    onRefresh(callback: () => void): () => void {
        this.refresh.add(callback);
        return () => this.refresh.delete(callback);
    }
    setTimer(callback: () => void, ms: number): () => void {
        const timer = { at: this.t + ms, fn: callback, live: true };
        this.timers.push(timer);
        return () => { timer.live = false; };
    }
    async advance(ms: number, refreshEveryMs = 0): Promise<void> {
        const end = this.t + ms;
        let nextRefresh = refreshEveryMs > 0 ? Math.floor(this.t / refreshEveryMs + 1) * refreshEveryMs : Infinity;
        while (true) {
            const timer = this.timers.filter(x => x.live).sort((a, b) => a.at - b.at)[0];
            const next = Math.min(nextRefresh, timer?.at ?? Infinity);
            if (next > end) break;
            this.t = next;
            if (timer && timer.at === next) { timer.live = false; timer.fn(); }
            else { nextRefresh += refreshEveryMs; for (const cb of [...this.refresh]) cb(); }
            await flush();
        }
        this.t = end;
        await flush();
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

const REFRESH = 1000 / 60;
const BITS = 0x4000;
const PITCH = 16;
const HEIGHT = 4;
const SIZE = PITCH * HEIGHT;

let guest: Uint8Array;

function presenterWithDrawLog() {
    const clock = new ManualClock();
    const presenter = Object.create(DDrawPresenter.prototype) as any;
    Object.assign(presenter, {
        process: { getCurrentMemory: () => guest },
        presentCallCount: 0, pendingSurface: null, pendingOptions: null, pendingResolvers: [],
        pendingCommit: null, commitBuffers: [null, null], commitInFlight: null,
        pumpRunning: false, pumpQueued: false, presentClock: clock, latchedSince: -1,
        refreshUnregister: null, backstopCancel: null, lastFlipAt: -Infinity, flipIntervalMs: 0,
        lockedSince: -1, holdUntilFlip: () => false,
    });
    const drawn: Array<{ options: any; at: number; surface: any; shown: number[] }> = [];
    presenter.drawFrame = async (surface: DirectDrawSurfaceState, options: unknown, commit: Uint8Array | null) => {
        const src = commit ? commit.subarray(0, SIZE) : guest.subarray(surface.surfacePtr, surface.surfacePtr + SIZE);
        drawn.push({ surface, options, at: clock.t, shown: [...src] });
    };
    return { presenter: presenter as DDrawPresenter, drawn, clock };
}

function primarySurface(extra: Record<string, unknown> = {}): DirectDrawSurfaceState {
    return {
        surfaceType: "render_surface", surfacePtr: BITS, pitch: PITCH, width: PITCH / 2, height: HEIGHT,
        gpuDirty: true, format: { bpp: 16 }, ...extra,
    } as unknown as DirectDrawSurfaceState;
}

const fill = (value: number, from = 0, to = SIZE) => guest.fill(value, BITS + from, BITS + to);
const all = (value: number, from = 0, to = SIZE) => Array.from({ length: to - from }, () => value);
const implicit = { throttle: true };
const commit = { throttle: true, commit: true };
const flip = { throttle: true, frameAlreadyMarked: true, flip: true };

beforeEach(() => { guest = new Uint8Array(0x10000); });

describe("presenter: an implicit present draws the pixels of its commit point", () => {
    test("a write to half the front after the commit is not drawn at the refresh", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface();
        fill(0x11);
        void presenter.present(s, guest, commit);
        fill(0x22, 0, SIZE / 2);
        await clock.advance(REFRESH, REFRESH);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]!.shown).toEqual(all(0x11, 0, SIZE));
    });

    test("two commits within one refresh: one draw, of the second", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface();
        fill(0x11);
        void presenter.present(s, guest, commit);
        fill(0x33);
        void presenter.present(s, guest, commit);
        fill(0x44);
        await clock.advance(REFRESH, REFRESH);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]!.shown).toEqual(all(0x33));
    });

    test("a Flip, then one committed update per frame: 30 Flips and 30 updates are drawn, each update as committed", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface();
        for (let frame = 0; frame < 30; frame++) {
            void presenter.present(s, guest, flip);
            await clock.advance(2, REFRESH);
            fill(frame + 1);
            void presenter.present(s, guest, commit);
            fill(0xee);
            await clock.advance(1000 / 30 - 2, REFRESH);
        }
        const updates = drawn.filter(d => d.options.flip !== true);
        expect(drawn.filter(d => d.options.flip === true)).toHaveLength(30);
        expect(updates).toHaveLength(30);
        expect(updates.map(d => d.shown[0])).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    });

    test("a Flip, the scanout poller and explicit presents still draw guest memory as it is when drawn", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface();
        fill(0x11);
        void presenter.present(s, guest, flip);
        await clock.advance(1);
        fill(0x55);
        void presenter.present(s, guest, implicit);
        fill(0x66);
        await clock.advance(REFRESH, REFRESH);
        await presenter.present(s, guest, { throttle: false });
        expect(drawn.map(d => d.shown[0])).toEqual([0x11, 0x66, 0x66]);
    });

    test("a poller present while locked is drawn from the copy made at the Unlock that ends the lock", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface({ activeLeaseId: 7 }) as DirectDrawSurfaceState & { activeLeaseId?: number };
        void presenter.present(s, guest, implicit);
        await clock.advance(10, REFRESH);
        expect(drawn).toHaveLength(0);
        fill(0x77);
        s.activeLeaseId = undefined;
        void presenter.present(s, guest, commit);
        fill(0x78, 0, SIZE / 2);
        await clock.advance(REFRESH, REFRESH);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]!.shown).toEqual(all(0x77));
    });

    test("a primary that stays locked is drawn live at least 55 times a second after the hold", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface({ activeLeaseId: 3 });
        let v = 0;
        for (let t = 0; t < 1000; t += REFRESH) {
            fill(++v & 0xff);
            void presenter.present(s, guest, implicit);
            await clock.advance(REFRESH, REFRESH);
        }
        expect(drawn.length).toBeGreaterThanOrEqual(55);
        expect(drawn.at(-1)!.shown[0]).toBe(v & 0xff);
    });

    test("an unlocked 8 bpp scanout writer polled every refresh is drawn live every refresh", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface({ format: { bpp: 8 } });
        for (let i = 1; i <= 30; i++) {
            fill(i);
            void presenter.present(s, guest, implicit);
            fill(i + 100);
            await clock.advance(REFRESH, REFRESH);
        }
        await clock.advance(REFRESH, REFRESH);
        expect(drawn.length).toBeGreaterThanOrEqual(29);
        expect(drawn.every(d => d.shown[0]! > 100)).toBe(true);
    });

    test("a poller present after a commit within the same refresh draws live: the latest present decides", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface({ format: { bpp: 8 } });
        fill(0x11);
        void presenter.present(s, guest, commit);
        fill(0x12);
        void presenter.present(s, guest, implicit);
        fill(0x13);
        await clock.advance(REFRESH, REFRESH);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]!.shown).toEqual(all(0x13));
    });

    test("a palette change after a commit of the same surface keeps the copy; one of another surface does not", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const s = primarySurface({ format: { bpp: 8 } });
        fill(0x11);
        void presenter.present(s, guest, commit);
        fill(0x12);
        void presenter.present(s, guest, { throttle: true, palette: true });
        await clock.advance(REFRESH, REFRESH);
        expect(drawn.at(-1)!.shown).toEqual(all(0x11));
        void presenter.present(s, guest, commit);
        fill(0x13);
        void presenter.present(primarySurface({ format: { bpp: 8 }, surfacePtr: BITS }), guest, { throttle: true, palette: true });
        await clock.advance(REFRESH, REFRESH);
        expect(drawn.at(-1)!.shown).toEqual(all(0x13));
    });

    test("a surface the draw does not upload from guest memory is not copied", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        fill(0x11);
        void presenter.present(primarySurface({ gpuDirty: false }), guest, commit);
        expect((presenter as any).pendingCommit).toBeNull();
        void presenter.present(primarySurface({ surfaceType: "texture" }), guest, commit);
        expect((presenter as any).pendingCommit).toBeNull();
        await clock.advance(REFRESH, REFRESH);
        expect(drawn).toHaveLength(1);
    });

    test("a commit that arrives while a draw reads the previous copy does not overwrite it", async () => {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const p = presenter as any;
        const record = p.drawFrame;
        let release!: () => void;
        let seenLater: number[] = [];
        p.drawFrame = (surface: DirectDrawSurfaceState, options: unknown, copy: Uint8Array | null) => new Promise<void>(r => {
            release = () => { seenLater = [...copy!.subarray(0, SIZE)]; void record(surface, options, copy).then(r); };
        });
        const s = primarySurface();
        fill(0x11);
        void presenter.present(s, guest, commit);
        await clock.advance(REFRESH, REFRESH);
        p.drawFrame = record;
        fill(0x22);
        void presenter.present(s, guest, commit);
        fill(0x33);
        void presenter.present(s, guest, commit);
        release();
        await clock.advance(REFRESH, REFRESH);
        expect(seenLater).toEqual(all(0x11));
        expect(drawn.map(d => d.shown[0])).toEqual([0x11, 0x33]);
    });

    test("the copy buffers are reused, not allocated per commit", async () => {
        const { presenter, clock } = presenterWithDrawLog();
        const s = primarySurface();
        const p = presenter as any;
        void presenter.present(s, guest, commit);
        await clock.advance(REFRESH, REFRESH);
        const first = p.commitBuffers.slice();
        for (let i = 0; i < 50; i++) {
            void presenter.present(s, guest, commit);
            await clock.advance(REFRESH, REFRESH);
        }
        expect(p.commitBuffers[0]).toBe(first[0]);
        expect(p.commitBuffers.filter(Boolean).length).toBeLessThanOrEqual(2);
    });
});

describe("thunks: v1, v4 and v7 Unlock of the primary feed the commit copy", () => {
    const SURFACE_PTR = 0x1000;
    const OUT = 0x2000;
    const DDSCAPS_PRIMARYSURFACE = 0x200;

    beforeEach(() => EmulatorConfig.getInstance().reset());
    afterEach(() => EmulatorConfig.getInstance().reset());

    function harness() {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const state: any = {
            surfaceType: "render_surface", caps: DDSCAPS_PRIMARYSURFACE, caps2: 0, width: PITCH / 2, height: HEIGHT,
            pitch: PITCH, surfacePtr: BITS,
            format: { size: 32, flags: 0x40, fourCC: 0, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 },
            mode: "CPU", version: 1, gpuDirty: false, everLocked: true, lastUploadVersion: 1, writeGeneration: 0,
        };
        const surface: any = { getState: () => state, handle: 0x11, addRef: () => 2, release: () => 0 };
        const context: any = {
            display: { width: 640, height: 480, bpp: 16, refresh: 60 },
            surfaces: { primary: SURFACE_PTR },
            cooperative: {},
            presenter,
            process: { memory: {}, dispatcher: {} },
            resourceProvider: {
                getComObjectByAddress: (a: number) => (a === SURFACE_PTR ? surface : null),
                getComObject: () => null,
                getAddressForHandle: () => 0,
                getAllComObjects: () => [],
            },
        };
        const surf = createSurfaceExports(context);
        Mem.bind(() => guest);
        const view = new DataView(guest.buffer);
        view.setUint32(OUT, 108, true);
        const call = async (name: string, ...args: number[]): Promise<number> => {
            const r = await (surf as any)[name]!({ esp: 0 } as any, guest, args as any);
            return typeof r === "number" ? r : r.value;
        };
        return { call, drawn, clock, state };
    }

    for (const v of ["", "4", "7"]) {
        test(`IDirectDrawSurface${v}: Lock(NULL)/Unlock, then an out-of-lease write to half the front: the refresh draws the content at Unlock`, async () => {
            const h = harness();
            expect(await h.call(`IDirectDrawSurface${v}_Lock`, SURFACE_PTR, 0, OUT, 1, 0)).toBe(0);
            fill(0x5a);
            expect(await h.call(`IDirectDrawSurface${v}_Unlock`, SURFACE_PTR, v === "" ? BITS : 0)).toBe(0);
            fill(0xa5, 0, SIZE / 2);
            await h.clock.advance(REFRESH, REFRESH);
            expect(h.drawn.length).toBeGreaterThanOrEqual(1);
            expect(h.drawn.at(-1)!.shown).toEqual(all(0x5a));
        });
    }
});

describe("thunks: Blt and BltFast into the primary feed the commit copy", () => {
    const PRIMARY = 0x1000, SOURCE = 0x1100, SRC_BITS = 0x6000;
    const DDSCAPS_PRIMARYSURFACE = 0x200;
    beforeEach(() => EmulatorConfig.getInstance().reset());
    afterEach(() => EmulatorConfig.getInstance().reset());

    function harness() {
        const { presenter, drawn, clock } = presenterWithDrawLog();
        const fmt = { size: 32, flags: 0x40, fourCC: 0, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 };
        const state = (ptr: number, caps: number): any => ({
            surfaceType: "render_surface", caps, caps2: 0, width: PITCH / 2, height: HEIGHT, pitch: PITCH, surfacePtr: ptr,
            format: fmt, mode: "CPU", version: 1, gpuDirty: false, everLocked: true, lastUploadVersion: 1, writeGeneration: 0,
        });
        const dst = state(BITS, DDSCAPS_PRIMARYSURFACE), src = state(SRC_BITS, 0);
        const obj = (st: unknown, _h: number): any => new DirectDrawSurfaceObject(0, st as DirectDrawSurfaceState);
        const objs = new Map<number, any>([[PRIMARY, obj(dst, 0x11)], [SOURCE, obj(src, 0x12)]]);
        const context: any = {
            display: { width: 640, height: 480, bpp: 16, refresh: 60 },
            surfaces: { primary: PRIMARY }, cooperative: {}, presenter,
            process: { memory: {}, dispatcher: {} },
            deferredUploadManager: { markDirty: () => {} },
            resourceProvider: {
                getComObjectByAddress: (a: number) => objs.get(a) ?? null,
                getComObject: () => null, getAddressForHandle: () => 0, getAllComObjects: () => [...objs.values()],
            },
        };
        const blt = createSurfaceBltFlipExports(context);
        Mem.bind(() => guest);
        const call = async (name: string, ...args: number[]): Promise<number> => {
            const r = await (blt as any)[name]!({ esp: 0 } as any, guest, args as any);
            return typeof r === "number" ? r : r.value;
        };
        return { call, drawn, clock };
    }

    for (const [name, args] of [
        ["IDirectDrawSurface7_Blt", [PRIMARY, 0, SOURCE, 0, 0, 0]],
        ["IDirectDrawSurface7_BltFast", [PRIMARY, 0, 0, SOURCE, 0, 0]],
    ] as const) {
        test(`${name} of a CPU source into the primary, then an out-of-lease write to half of it: the refresh draws the blit result`, async () => {
            const h = harness();
            guest.fill(0x5a, SRC_BITS, SRC_BITS + SIZE);
            expect(await h.call(name, ...args)).toBe(0);
            expect([...guest.subarray(BITS, BITS + SIZE)]).toEqual(all(0x5a));
            fill(0xa5, 0, SIZE / 2);
            await h.clock.advance(REFRESH, REFRESH);
            expect(h.drawn.length).toBeGreaterThanOrEqual(1);
            expect(h.drawn.at(-1)!.shown).toEqual(all(0x5a));
        });
    }
});

describe("drawFrame uploads the committed bytes, not guest memory at draw time", () => {
    useWebGpuFlags("GPUTextureUsage", "GPUBufferUsage");
    const system = System.getInstance() as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    let uploaded: number[][];
    let ddrawContext: Record<string, unknown>;

    const bytesOf = (src: ArrayBufferView, offset: number, n: number) =>
        [...new Uint8Array(src.buffer, src.byteOffset + offset, n)];

    beforeEach(() => {
        for (const k of ["services", "process", "gdiContext"]) saved[k] = system[k];
        uploaded = [];
        const texture = () => ({ width: PITCH / 2, height: HEIGHT, createView: () => ({}), destroy: () => {} });
        const queue = {
            writeTexture: (_d: unknown, data: ArrayBufferView, layout: { offset?: number }) => { uploaded.push(bytesOf(data, layout.offset ?? 0, SIZE)); },
            submit: () => {},
        };
        const device = {
            createTexture: texture,
            createCommandEncoder: () => ({ finish: () => ({}) }),
            pushErrorScope: () => {}, popErrorScope: async () => null,
        };
        const backend = {
            kind: "webgpu", getDevice: () => device, getQueue: () => queue, getContext: () => ({}), getFormat: () => "bgra8unorm",
            convertRGB565ToRGBA: () => {},
        };
        ddrawContext = {
            executor: {
                flush: () => {}, endFrameForPresent: () => {}, invalidateSurfaceCache: () => {},
                getTextureConverter: () => ({
                    convertToTexture: (_e: unknown, mem: Uint8Array, ptr: number) => { uploaded.push(bytesOf(mem, ptr, SIZE)); },
                }),
            },
            deferredUploadManager: new DeferredUploadManager(),
        };
        system.services = { render: { getBackend: () => backend } };
        system.process = { getCurrentMemory: () => guest, getModule: (n: string) => (n === "ddraw" ? { context: ddrawContext } : undefined) };
        system.gdiContext = { getOverlayCanvas: () => null };
    });
    afterEach(() => { Object.assign(system, saved); });

    function presenter(): any {
        const p = new DDrawPresenter({ getCurrentMemory: () => guest } as any) as any;
        p.ensureCanvas = () => { p.canvas = {}; p.ctx = {}; };
        return p;
    }

    const cases = [
        ["RGB565", { bpp: 16, flags: 0x40, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 }],
        ["PALETTE8", { bpp: 8, flags: 0x20 | 0x40, rMask: 0, gMask: 0, bMask: 0, aMask: 0 }],
        ["X1R5G5B5 (deferred upload)", { bpp: 16, flags: 0x40, rMask: 0x7c00, gMask: 0x03e0, bMask: 0x001f, aMask: 0 }],
    ] as const;

    function drawSurface(name: string, format: Record<string, number>): any {
        const s = primarySurface({
            format, mode: "CPU", version: 2, lastUploadVersion: 1, everLocked: true, caps: 0x200,
            gpuTexture: { width: PITCH / 2, height: HEIGHT, destroy: () => {} }, gpuTextureView: {},
            gpuTextureFormat: name.startsWith("X1R5G5B5") ? "bgra8unorm" : "rgba8unorm",
            paletteEntries: new Uint32Array(256),
        }) as any;
        if (name.startsWith("X1R5G5B5")) (ddrawContext.deferredUploadManager as DeferredUploadManager).markDirty(s);
        return s;
    }

    async function upload(name: string, format: Record<string, number>, committed: number | null, atDraw: number): Promise<number[]> {
        uploaded = [];
        const s = drawSurface(name, format);
        const p = presenter();
        let copy: Uint8Array | null = null;
        if (committed !== null) {
            fill(committed);
            copy = p.copyCommittedPixels(s);
            expect(copy).not.toBeNull();
        }
        fill(atDraw);
        await p.drawFrame(s, { throttle: true }, copy).catch(() => {});
        expect(uploaded.length).toBeGreaterThanOrEqual(1);
        return uploaded[0]!.slice(0, PITCH);
    }

    for (const [name, format] of cases) {
        test(`${name}: the committed pixels are uploaded after guest memory changed`, async () => {
            const fromCopy = await upload(name, format, 0x41, 0x42);
            const live41 = await upload(name, format, null, 0x41);
            const live42 = await upload(name, format, null, 0x42);
            expect(live41).not.toEqual(live42);
            expect(fromCopy).toEqual(live41);
        });
    }
});
