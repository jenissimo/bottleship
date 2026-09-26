/**
 * Threaded D3D9 frame hand-off (plan/d3d9-threaded/canvas-ownership.md, c1), GPU-free.
 *
 * The render side ships a pre-PostFx bitmap plus plain meta; the emulator side imports it and
 * runs the one D3D9 composite. What must hold, and what each case below can catch failing:
 * - the two RenderService edges are separable, and notifyPresent is still exactly both;
 * - a frame's overlays are decided and acknowledged where it ARRIVES, and the canvas edge fires
 *   once per frame that reached the canvas, never for a stale/mislabelled/undeliverable one;
 * - every bitmap is closed on every path (an unclosed one holds GPU memory until GC);
 * - the render-side ledger closes: every sink present is sent or a named vehicle failure.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { RenderService, type RenderActive } from "../../src/worker/runtime/runtime-services";
import {
    D3D9ScreenLayer, presentD3D9FrameToCanvas, type D3D9ScreenBackend, type D3D9ScreenHost,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-screen-layer";
import {
    D3D9FrameVehicle, d3d9BitmapPresentWanted, type D3D9FrameMeta,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-frame-handoff";
import { D3D9BackendExecutor } from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";
import type { OverlayCompositePlan } from "../../src/worker/modules/user32/dialog-overlay";
import type { VideoPlanePlan } from "../../src/worker/video/video-routing-types";

(globalThis as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage ??= {
    COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function bitmap(width: number, height: number) {
    return { width, height, closed: 0, close() { this.closed++; } };
}

function meta(serial: number, width: number, height: number, drawCount: number | null = 12): D3D9FrameMeta {
    return {
        serial, guestWidth: 640, guestHeight: 480, physicalWidth: width, physicalHeight: height,
        format: "bgra8unorm", drawCount, sentAt: performance.timeOrigin + performance.now(),
    };
}

/** Records, in order, every call the composite makes on the backend. */
function fakeBackend() {
    const calls: string[] = [];
    const log = {
        calls,
        imports: [] as Array<{ source: unknown; texture: Any; size: Any }>,
        submits: 0,
        textures: [] as Any[],
        drawTexture: [] as Any[][],
    };
    const canvasTexture = { width: 1600, height: 1200, createView: () => ({ canvasView: true }) };
    const makeDevice = (name: string) => {
        const device: Any = {
            name,
            queue: {
                copyExternalImageToTexture(src: Any, dst: Any, size: Any) {
                    calls.push("import");
                    log.imports.push({ source: src.source, texture: dst.texture, size });
                },
                submit() { calls.push("submit"); log.submits++; },
            },
            createTexture(desc: Any) {
                const t: Any = {
                    width: desc.size.width, height: desc.size.height, format: desc.format, usage: desc.usage,
                    destroyed: false, destroy() { t.destroyed = true; }, createView: () => ({ view: t }),
                };
                log.textures.push(t);
                return t;
            },
            createCommandEncoder: () => ({ finish: () => ({}) }),
        };
        return device;
    };
    let device: Any = makeDevice("A");
    let context: Any = { getCurrentTexture: () => canvasTexture };
    const backend = {
        getDevice: () => device,
        getQueue: () => device?.queue ?? null,
        getFormat: () => "bgra8unorm" as GPUTextureFormat,
        getContext: () => context,
        drawTexture: (...args: Any[]) => { calls.push("drawTexture"); log.drawTexture.push(args); },
        blit: (src: Any) => { calls.push(`blit:${src.tag}`); },
        blitRects: (src: Any, _t: Any, _e: Any, rects: Any[]) => { calls.push(`blitRects:${src.tag}:${rects.length}`); },
        updateStatsTexture: () => { calls.push("updateStats"); },
        renderStatsOverlay: () => { calls.push("renderStats"); },
    };
    return {
        backend: backend as unknown as D3D9ScreenBackend,
        log,
        replaceDevice() { device = makeDevice("B"); },
        dropDevice() { device = null; },
        dropContext() { context = null; },
    };
}

function fakeHost() {
    const gdi = {
        content: false, dirty: false, canvas: { tag: "gdi" },
        hasOverlayContent() { return this.content; },
        getOverlayCanvas() { return this.canvas as unknown as OffscreenCanvas; },
        isOverlayDirty() { return this.dirty; },
        clearOverlayDirty() { this.dirty = false; log.push("gdiClean"); },
    };
    const log: string[] = [];
    const state = { videoOnScreen: false, plan: { mode: "full" } as OverlayCompositePlan, owners: [] as unknown[] };
    const videoCanvas = { tag: "video" } as unknown as OffscreenCanvas;
    let onVideoPlan: () => void = () => {};
    const host: D3D9ScreenHost = {
        videoPlan: (): VideoPlanePlan => {
            onVideoPlan();
            return state.videoOnScreen
                ? { onScreen: true, reason: "live", canvas: videoCanvas, ownerSessionKey: "s" }
                : { onScreen: false, reason: "no_content", canvas: null, ownerSessionKey: null };
        },
        videoComposited: () => { log.push("videoComposited"); },
        gdi: () => gdi,
        overlayPlan: (owner) => { state.owners.push(owner); return state.plan; },
        canvasPresented: () => { log.push("canvasPresented"); },
    };
    return { host, gdi, log, state, setOnVideoPlan(fn: () => void) { onVideoPlan = fn; } };
}

const owner = { presentsExclusiveFullscreen: true, suppressGdiOverlay: true } as unknown as RenderActive;

describe("RenderService present edges", () => {
    function service() {
        const svc = new RenderService();
        let mirrors = 0;
        svc.setBackend({
            kind: "fake", initialize() {}, composite() {},
            getScreenCanvas: () => ({ width: 100, height: 100 } as OffscreenCanvas),
            mirrorPresentedFrame: () => { mirrors++; return true; },
        });
        let firsts = 0;
        svc.onFirstPresent(() => { firsts++; });
        svc.armFirstPresent();
        return { svc, mirrors: () => mirrors, firsts: () => firsts };
    }

    test("notifyPresent is still both edges at once", () => {
        const s = service();
        s.svc.notifyPresent("d3d9");
        expect(s.svc.getPresentSerial()).toBe(1);
        expect(s.svc.getGuestPresentSerial()).toBe(1);
        expect(s.svc.getLastPresenterKind()).toBe("d3d9");
        expect(s.mirrors()).toBe(1);
        expect(s.firsts()).toBe(1);
        expect(s.svc.screenMirrorAge()).toBe(0);
        // Our own video composite is never a guest present.
        s.svc.notifyPresent("video");
        expect(s.svc.getPresentSerial()).toBe(2);
        expect(s.svc.getGuestPresentSerial()).toBe(1);
    });

    test("the guest edge alone touches nothing of the canvas", () => {
        const s = service();
        s.svc.notifyGuestPresent();
        expect(s.svc.getGuestPresentSerial()).toBe(1);
        expect(s.svc.getPresentSerial()).toBe(0);
        expect(s.svc.getLastPresenterKind()).toBeNull();
        expect(s.mirrors()).toBe(0);
        expect(s.firsts()).toBe(0);
        expect(s.svc.screenMirrorAge()).toBe(-1);
    });

    test("the canvas edge alone mirrors, fires first-present once, and leaves the guest serial", () => {
        const s = service();
        s.svc.notifyCanvasPresent("d3d9");
        s.svc.notifyCanvasPresent("d3d9");
        expect(s.svc.getPresentSerial()).toBe(2);
        expect(s.svc.getGuestPresentSerial()).toBe(0);
        expect(s.mirrors()).toBe(2);
        expect(s.firsts()).toBe(1);
        expect(s.svc.screenMirrorAge()).toBe(0);
    });
});

describe("presentD3D9FrameToCanvas — the one composite route", () => {
    test("PostFx at the source extent into the canvas, then video, then GDI", () => {
        const f = fakeBackend();
        const encoder = {} as GPUCommandEncoder;
        const src = {} as GPUTextureView;
        presentD3D9FrameToCanvas(f.backend, src, 1280, 960, encoder, {
            videoOverlayCanvas: { tag: "video" } as unknown as OffscreenCanvas,
            gdiOverlayCanvas: { tag: "gdi" } as unknown as OffscreenCanvas,
            gdiOverlayRects: [{ x: 0, y: 0, w: 10, h: 10 }],
        });
        expect(f.log.calls).toEqual(["drawTexture", "blit:video", "blitRects:gdi:1"]);
        const args = f.log.drawTexture[0]!;
        expect(args[0]).toBe(src);
        expect(args[3]).toBe(true); // opaque: the PostFx chain
        expect(args[8]).toEqual({ srcW: 1280, srcH: 960, outW: 1600, outH: 1200, toCanvas: true });
    });

    test("an empty rect list composites no GDI; no rect list composites all of it", () => {
        const f = fakeBackend();
        const gdi = { tag: "gdi" } as unknown as OffscreenCanvas;
        presentD3D9FrameToCanvas(f.backend, {} as GPUTextureView, 1, 1, {} as GPUCommandEncoder,
            { gdiOverlayCanvas: gdi, gdiOverlayRects: [] });
        presentD3D9FrameToCanvas(f.backend, {} as GPUTextureView, 1, 1, {} as GPUCommandEncoder,
            { gdiOverlayCanvas: gdi });
        expect(f.log.calls).toEqual(["drawTexture", "drawTexture", "blit:gdi"]);
    });
});

describe("D3D9ScreenLayer — the emulator side of the boundary", () => {
    test("a frame is imported, composited at its physical extent, closed, and makes one canvas edge", () => {
        const f = fakeBackend();
        const h = fakeHost();
        const layer = new D3D9ScreenLayer(f.backend, owner, h.host);
        const b = bitmap(1280, 960);
        layer.presentFrame(b as unknown as ImageBitmap, meta(1, 1280, 960));
        expect(f.log.calls).toEqual(["import", "drawTexture", "submit"]);
        expect(f.log.imports[0]!.source).toBe(b);
        expect(f.log.imports[0]!.size).toEqual({ width: 1280, height: 960 });
        const t = f.log.textures[0]!;
        expect(t.format).toBe("bgra8unorm");
        expect(t.usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
        expect(t.usage & GPUTextureUsage.COPY_DST).toBeTruthy();
        expect(t.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
        expect(f.log.drawTexture[0]![0]).toEqual({ view: t });
        expect(f.log.drawTexture[0]![8]).toMatchObject({ srcW: 1280, srcH: 960 });
        expect(b.closed).toBe(1);
        expect(h.log).toEqual(["canvasPresented"]);
        expect(layer.getStats()).toMatchObject({ received: 1, presented: 1, stale: 0, failed: 0, lastSerial: 1 });
    });

    test("overlays are decided at arrival and acknowledged after the submit", () => {
        const f = fakeBackend();
        const h = fakeHost();
        const layer = new D3D9ScreenLayer(f.backend, owner, h.host);
        h.state.videoOnScreen = true;
        h.gdi.content = true;
        h.gdi.dirty = true;
        h.state.plan = { mode: "rects", rects: [{ x: 1, y: 2, w: 3, h: 4 }, { x: 5, y: 6, w: 7, h: 8 }] };
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(1, 640, 480));
        expect(f.log.calls).toEqual(["import", "drawTexture", "blit:video", "blitRects:gdi:2", "submit"]);
        expect(h.state.owners).toEqual([owner]);
        expect(h.log).toEqual(["videoComposited", "gdiClean", "canvasPresented"]);

        // 'none' composites no GDI; a dirty overlay is still acknowledged, as an in-worker
        // present acknowledges it whether or not it drew it.
        h.state.videoOnScreen = false;
        h.state.plan = { mode: "none" };
        h.gdi.dirty = true;
        f.log.calls.length = 0;
        h.log.length = 0;
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(2, 640, 480));
        expect(f.log.calls).toEqual(["import", "drawTexture", "submit"]);
        expect(h.log).toEqual(["gdiClean", "canvasPresented"]);

        // 'full' composites the whole overlay.
        h.state.plan = { mode: "full" };
        f.log.calls.length = 0;
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(3, 640, 480));
        expect(f.log.calls).toEqual(["import", "drawTexture", "blit:gdi", "submit"]);
    });

    test("stale, mislabelled and undeliverable frames are closed unshown, with no canvas edge", () => {
        const f = fakeBackend();
        const h = fakeHost();
        const layer = new D3D9ScreenLayer(f.backend, owner, h.host);
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(5, 640, 480));
        const stale = bitmap(640, 480);
        layer.presentFrame(stale as unknown as ImageBitmap, meta(5, 640, 480));
        const mislabelled = bitmap(640, 480);
        layer.presentFrame(mislabelled as unknown as ImageBitmap, meta(6, 1280, 960));
        f.dropContext();
        const noCanvas = bitmap(640, 480);
        layer.presentFrame(noCanvas as unknown as ImageBitmap, meta(7, 640, 480));
        expect([stale.closed, mislabelled.closed, noCanvas.closed]).toEqual([1, 1, 1]);
        expect(h.log.filter((e) => e === "canvasPresented")).toHaveLength(1);
        const s = layer.getStats();
        expect(s).toMatchObject({ received: 4, presented: 1, stale: 1, failed: 2, lastSerial: 5 });
        expect(s.presented + s.stale + s.failed).toBe(s.received);
    });

    test("a throwing canvas edge leaves the ledger exact and the bitmap closed", () => {
        const f = fakeBackend();
        const h = fakeHost();
        h.host.canvasPresented = () => { throw new Error("edge"); };
        const layer = new D3D9ScreenLayer(f.backend, owner, h.host);
        const b = bitmap(640, 480);
        expect(() => layer.presentFrame(b as unknown as ImageBitmap, meta(1, 640, 480))).toThrow("edge");
        expect(b.closed).toBe(1);
        expect(layer.getStats()).toMatchObject({ received: 1, presented: 1, failed: 0 });
    });

    test("repaint re-presents the last import without overlays or a canvas edge", () => {
        const f = fakeBackend();
        const h = fakeHost();
        const layer = new D3D9ScreenLayer(f.backend, owner, h.host);
        layer.repaintLastFrame();
        expect(f.log.calls).toEqual([]); // nothing to repaint before the first frame

        h.gdi.content = true;
        layer.presentFrame(bitmap(800, 600) as unknown as ImageBitmap, meta(1, 800, 600));
        f.log.calls.length = 0;
        h.log.length = 0;
        layer.repaintLastFrame();
        expect(f.log.calls).toEqual(["drawTexture", "submit"]);
        expect(f.log.drawTexture.at(-1)![8]).toMatchObject({ srcW: 800, srcH: 600 });
        expect(h.log).toEqual([]);
        expect(layer.getStats().repaints).toBe(1);

        // A replacement device holds none of the old device's textures.
        f.replaceDevice();
        f.log.calls.length = 0;
        layer.repaintLastFrame();
        expect(f.log.calls).toEqual([]);
    });

    test("the import texture is reused at one extent and replaced on a resize", () => {
        const f = fakeBackend();
        const layer = new D3D9ScreenLayer(f.backend, owner, fakeHost().host);
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(1, 640, 480));
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(2, 640, 480));
        expect(f.log.textures).toHaveLength(1);
        layer.presentFrame(bitmap(1280, 960) as unknown as ImageBitmap, meta(3, 1280, 960));
        expect(f.log.textures).toHaveLength(2);
        expect(f.log.textures[0]!.destroyed).toBe(true);
        expect(f.log.imports[2]!.texture).toBe(f.log.textures[1]);
    });

    test("the draw count answers from the latest accepted frame, and is current when the video plane is decided", () => {
        const f = fakeBackend();
        const h = fakeHost();
        const layer = new D3D9ScreenLayer(f.backend, owner, h.host);
        const seen: Array<number | null> = [];
        h.setOnVideoPlan(() => seen.push(layer.getLastPresentDrawCount()));
        expect(layer.getLastPresentDrawCount()).toBeNull();
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(1, 640, 480, 3));
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(2, 640, 480, 250));
        // A stale frame does not overwrite what the screen shows.
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(2, 640, 480, 1));
        expect(seen).toEqual([3, 250]);
        expect(layer.getLastPresentDrawCount()).toBe(250);
        layer.presentFrame(bitmap(640, 480) as unknown as ImageBitmap, meta(3, 640, 480, null));
        expect(layer.getLastPresentDrawCount()).toBeNull();
    });
});

function fakeCanvasFactory(opts: { noContext?: boolean } = {}) {
    const log = { configures: [] as Any[], transfers: 0, created: 0, copies: [] as Any[] };
    let current: Any = { id: 0 };
    const factory = (w: number, h: number): OffscreenCanvas => {
        log.created++;
        const canvas: Any = {
            width: w, height: h,
            getContext: () => (opts.noContext ? null : context),
            transferToImageBitmap: () => {
                log.transfers++;
                const b = bitmap(canvas.width, canvas.height);
                current = { id: current.id + 1 };
                return b;
            },
        };
        const context: Any = { configure: (c: Any) => log.configures.push(c), getCurrentTexture: () => current };
        return canvas as OffscreenCanvas;
    };
    const encoder = {
        copyTextureToTexture: (src: Any, dst: Any, size: Any) => log.copies.push({ src, dst, size }),
    } as unknown as GPUCommandEncoder;
    return { factory, log, encoder, current: () => current };
}

describe("D3D9FrameVehicle — the render side of the boundary", () => {
    const deviceA = { name: "A" } as unknown as GPUDevice;
    const deviceB = { name: "B" } as unknown as GPUDevice;

    test("copies the whole backbuffer into an opaque canvas and transfers it once", () => {
        const c = fakeCanvasFactory();
        const v = new D3D9FrameVehicle(c.factory);
        const source = { width: 1280, height: 960 } as GPUTexture;
        expect(v.encode(deviceA, "bgra8unorm", c.encoder, source)).toBe(true);
        expect(c.log.configures).toHaveLength(1);
        expect(c.log.configures[0]).toMatchObject({ device: deviceA, format: "bgra8unorm", alphaMode: "opaque" });
        expect(c.log.configures[0].usage & GPUTextureUsage.COPY_DST).toBeTruthy();
        expect(c.log.copies[0]).toEqual({
            src: { texture: source }, dst: { texture: { id: 0 } }, size: { width: 1280, height: 960, depthOrArrayLayers: 1 },
        });
        const b = v.transfer();
        expect(b).toMatchObject({ width: 1280, height: 960 });
        expect(v.transfer()).toBeNull();
    });

    test("a resize or a new device reconfigures; the same extent and device do not", () => {
        const c = fakeCanvasFactory();
        const v = new D3D9FrameVehicle(c.factory);
        v.encode(deviceA, "bgra8unorm", c.encoder, { width: 640, height: 480 } as GPUTexture);
        v.encode(deviceA, "bgra8unorm", c.encoder, { width: 640, height: 480 } as GPUTexture);
        expect(c.log.configures).toHaveLength(1);
        v.encode(deviceA, "bgra8unorm", c.encoder, { width: 1280, height: 960 } as GPUTexture);
        expect(c.log.configures).toHaveLength(2);
        expect(v.transfer()).toMatchObject({ width: 1280, height: 960 });
        v.encode(deviceB, "bgra8unorm", c.encoder, { width: 1280, height: 960 } as GPUTexture);
        expect(c.log.configures).toHaveLength(3);
        expect(c.log.created).toBe(1);
    });

    test("no WebGPU context: nothing is copied and nothing transfers", () => {
        const c = fakeCanvasFactory({ noContext: true });
        const v = new D3D9FrameVehicle(c.factory);
        expect(v.encode(deviceA, "bgra8unorm", c.encoder, { width: 640, height: 480 } as GPUTexture)).toBe(false);
        expect(c.log.copies).toHaveLength(0);
        expect(v.transfer()).toBeNull();
    });
});

describe("D3D9BackendExecutor frame sink", () => {
    const savedFlag = (globalThis as Any).__d3d9BitmapPresent;
    const hadCanvas = "OffscreenCanvas" in globalThis;
    const savedCanvas = (globalThis as Any).OffscreenCanvas;
    afterEach(() => {
        (globalThis as Any).__d3d9BitmapPresent = savedFlag;
        // Delete rather than assign undefined: later suites test `"OffscreenCanvas" in
        // globalThis` to decide whether a stub of theirs is theirs to remove.
        if (hadCanvas) (globalThis as Any).OffscreenCanvas = savedCanvas;
        else delete (globalThis as Any).OffscreenCanvas;
    });

    function executor(canvas = fakeCanvasFactory()) {
        const backend = { getFormat: () => "bgra8unorm", getDevice: () => null, getQueue: () => null, getContext: () => null };
        const exec = new D3D9BackendExecutor(backend as never);
        exec.setGuestBackbufferSize(640, 480);
        (exec as Any).offscreenSize = { width: 1280, height: 960 };
        return { exec, canvas };
    }
    const device = {} as GPUDevice;
    const source = { width: 1280, height: 960 } as GPUTexture;

    function presentOnce(exec: D3D9BackendExecutor, encoder: GPUCommandEncoder): void {
        if ((exec as Any).encodeFrameForSink(device, encoder, source)) (exec as Any).shipFrameToSink();
    }

    test("each present ships one bitmap with the guest and physical extent, serial and draw count", () => {
        const { exec, canvas } = executor();
        const got: Array<{ b: Any; m: D3D9FrameMeta }> = [];
        exec.setFrameSink((b, m) => got.push({ b, m }));
        (exec as Any).frameVehicle = new D3D9FrameVehicle(canvas.factory);
        exec.setPresentDrawCount(37);
        presentOnce(exec, canvas.encoder);
        presentOnce(exec, canvas.encoder);
        expect(got).toHaveLength(2);
        expect(got[0]!.m).toMatchObject({
            serial: 1, guestWidth: 640, guestHeight: 480, physicalWidth: 1280, physicalHeight: 960,
            format: "bgra8unorm", drawCount: 37,
        });
        expect(got[0]!.b).toMatchObject({ width: 1280, height: 960 });
        // The draw count belongs to one present: the next one without it is unknown, not stale.
        expect(got[1]!.m).toMatchObject({ serial: 2, drawCount: null });
        // Meta is plain data: it must survive a structured clone unchanged.
        expect(structuredClone(got[0]!.m)).toEqual(got[0]!.m);
        expect(exec.getFrameHandoffStats()).toMatchObject({ sink: true, inProcess: false, presents: 2, sent: 2, vehicleFailures: 0 });
    });

    test("a vehicle that cannot take the frame is a named failure, and the sink is not called", () => {
        const { exec } = executor();
        let calls = 0;
        exec.setFrameSink(() => { calls++; });
        const broken = fakeCanvasFactory({ noContext: true });
        (exec as Any).frameVehicle = new D3D9FrameVehicle(broken.factory);
        presentOnce(exec, broken.encoder);
        expect(calls).toBe(0);
        const s = exec.getFrameHandoffStats();
        expect(s).toMatchObject({ presents: 1, sent: 0, vehicleFailures: 1 });
        expect(s.presents).toBe(s.sent + s.vehicleFailures);
    });

    test("a throwing sink is counted, not propagated into the frame", () => {
        const { exec, canvas } = executor();
        exec.setFrameSink(() => { throw new Error("sink"); });
        (exec as Any).frameVehicle = new D3D9FrameVehicle(canvas.factory);
        expect(() => presentOnce(exec, canvas.encoder)).not.toThrow();
        expect(exec.getFrameHandoffStats()).toMatchObject({ presents: 1, sent: 1, sinkErrors: 1 });
    });

    test("in-process: the layer answers repaint, and detaching returns to the canvas", () => {
        const { exec } = executor();
        exec.useInProcessScreenLayer(owner);
        expect(exec.hasFrameSink()).toBe(true);
        const layer = (exec as Any).inProcessScreen as D3D9ScreenLayer;
        expect(layer.owner).toBe(owner);
        let repaints = 0;
        layer.repaintLastFrame = () => { repaints++; };
        exec.repaintLastFrame();
        expect(repaints).toBe(1);
        // Same owner: the layer (and the frame it holds) survives.
        exec.useInProcessScreenLayer(owner);
        expect((exec as Any).inProcessScreen).toBe(layer);
        exec.useInProcessScreenLayer(null);
        expect(exec.hasFrameSink()).toBe(false);
        expect(exec.getFrameHandoffStats().inProcess).toBe(false);
    });

    test("the flag attaches only where transferToImageBitmap exists", () => {
        const { exec } = executor();
        (globalThis as Any).__d3d9BitmapPresent = true;
        (globalThis as Any).OffscreenCanvas = undefined;
        expect(d3d9BitmapPresentWanted()).toBe(false);
        exec.syncInProcessScreenLayer(owner);
        expect(exec.hasFrameSink()).toBe(false);

        (globalThis as Any).OffscreenCanvas = class { transferToImageBitmap() { return null; } };
        expect(d3d9BitmapPresentWanted()).toBe(true);
        exec.syncInProcessScreenLayer(owner);
        expect(exec.hasFrameSink()).toBe(true);

        (globalThis as Any).__d3d9BitmapPresent = false;
        exec.syncInProcessScreenLayer(owner);
        expect(exec.hasFrameSink()).toBe(false);
    });

    test("an explicitly set sink survives the in-process attach and detach", () => {
        const { exec, canvas } = executor();
        let calls = 0;
        exec.setFrameSink(() => { calls++; });
        (exec as Any).frameVehicle = new D3D9FrameVehicle(canvas.factory);
        exec.useInProcessScreenLayer(null);
        // A render worker that mirrors __d3d9BitmapPresent must keep shipping to its own sink.
        exec.useInProcessScreenLayer(owner);
        expect(exec.getFrameHandoffStats().inProcess).toBe(false);
        presentOnce(exec, canvas.encoder);
        expect(calls).toBe(1);
    });
});
