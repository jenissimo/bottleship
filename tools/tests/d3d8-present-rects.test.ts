/**
 * IDirect3DDevice8::Present(pSourceRect, pDestRect, hDestWindowOverride, ...).
 *
 * A windowed title may keep a back buffer larger than its window and present only the
 * part it drew: source rectangle = the drawn part, destination rectangle = where it goes
 * in the window's client area. The host shows that client area, so presenting the whole
 * back buffer instead left the picture in a corner of it.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { createDeviceExports } from '../../src/worker/modules/d3d8/device';
import { devices } from '../../src/worker/modules/d3d8/shared-state';
import type { RenderSurface } from '../../src/worker/modules/ddraw/com-objects';
import {
    createPresentPlan, createPresentRegion, resolvePresentPlan, type PresentRegion,
} from '../../src/worker/backends/webgpu/shared/present-region';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const region = (src: ReturnType<typeof rect> | null, dst: ReturnType<typeof rect> | null, cw: number, ch: number): PresentRegion => {
    const r = createPresentRegion();
    if (src) { r.hasSrc = true; Object.assign(r.src, src); }
    if (dst) { r.hasDst = true; Object.assign(r.dst, dst); }
    r.clientWidth = cw; r.clientHeight = ch;
    return r;
};

describe('resolvePresentPlan', () => {
    test('whole back buffer onto the whole client area needs no composition', () => {
        const p = resolvePresentPlan(640, 480, region(null, null, 800, 600), createPresentPlan());
        expect(p.identity).toBe(true);
        expect(resolvePresentPlan(640, 480, region(rect(0, 0, 640, 480), rect(0, 0, 800, 600), 800, 600), createPresentPlan()).identity).toBe(true);
    });

    test('a source rectangle smaller than the back buffer is not the identity', () => {
        const p = resolvePresentPlan(640, 480, region(rect(0, 0, 560, 400), rect(0, 0, 560, 400), 560, 400), createPresentPlan());
        expect(p.identity).toBe(false);
        expect(p.covers).toBe(true);
        expect(p.src).toEqual(rect(0, 0, 560, 400));
        expect(p.dst).toEqual(rect(0, 0, 560, 400));
        expect([p.clientWidth, p.clientHeight]).toEqual([560, 400]);
    });

    test('a destination rectangle inside the client area leaves it uncovered', () => {
        const p = resolvePresentPlan(320, 240, region(null, rect(80, 0, 720, 480), 800, 480), createPresentPlan());
        expect(p.identity).toBe(false);
        expect(p.covers).toBe(false);
        expect(p.src).toEqual(rect(0, 0, 320, 240));
        expect(p.dst).toEqual(rect(80, 0, 720, 480));
    });

    test('clipping one rectangle moves the other by the scaled amount', () => {
        // 2x stretch; the source reaches 20 px past the back buffer's right edge.
        const a = resolvePresentPlan(100, 100, region(rect(60, 0, 120, 50), rect(0, 0, 120, 100), 200, 200), createPresentPlan());
        expect(a.src).toEqual(rect(60, 0, 100, 50));
        expect(a.dst).toEqual(rect(0, 0, 80, 100));
        // ... and the destination starts 40 px left of the client area.
        const b = resolvePresentPlan(100, 100, region(rect(0, 0, 100, 100), rect(-40, 0, 160, 200), 200, 200), createPresentPlan());
        expect(b.src).toEqual(rect(20, 0, 100, 100));
        expect(b.dst).toEqual(rect(0, 0, 160, 200));
    });

    test('an empty or fully clipped rectangle shows nothing', () => {
        expect(resolvePresentPlan(100, 100, region(rect(10, 10, 10, 50), null, 100, 100), createPresentPlan()).empty).toBe(true);
        expect(resolvePresentPlan(100, 100, region(null, rect(300, 0, 400, 100), 200, 200), createPresentPlan()).empty).toBe(true);
    });

    test('an unknown client size falls back to the back buffer size', () => {
        const p = resolvePresentPlan(640, 480, region(rect(0, 0, 320, 240), null, 0, 0), createPresentPlan());
        expect([p.clientWidth, p.clientHeight]).toEqual([640, 480]);
        expect(p.dst).toEqual(rect(0, 0, 640, 480));
    });
});

// The actual Present entry point of the adapter with a recording renderer.
async function presentWith(regions: Array<PresentRegion | undefined>) {
    const events: string[] = [];
    const backView = { name: 'back' };
    const back = {
        surfaceType: 'render_surface', width: 640, height: 480, pitch: 2560, surfacePtr: 0,
        format: { bpp: 32 }, caps: 0, mode: 'GPU_ONLY', gpuDirty: false, version: 0, lastUploadVersion: 0,
        gpuTexture: {}, gpuTextureView: backView,
    } as unknown as RenderSurface;
    const shown: Array<{ name: string; srcW: number; srcH: number }> = [];
    const destroyed: string[] = [];
    let made = 0;
    const encoder = { finish: () => ({}) };
    const backend = {
        kind: 'webgpu',
        getDevice: () => ({ createCommandEncoder: () => encoder }),
        getQueue: () => ({ submit: () => events.push('submit') }),
        getContext: () => ({ getCurrentTexture: () => ({ width: 1280, height: 960, createView: () => ({}) }) }),
        drawTexture: (source: { name: string }, _t: unknown, _e: unknown, _o: unknown, _w: unknown, _h: unknown, _c: unknown, _n: unknown,
            present: { srcW: number; srcH: number }) => {
            events.push('display');
            shown.push({ name: source.name, srcW: present.srcW, srcH: present.srcH });
        },
    };
    const fakeSystem = {
        services: { render: { getBackend: () => backend, getActive: () => adapter, notifyPresent: () => {} } },
        gdiContext: { getOverlayCanvas: () => null },
        videoRouting: { resolvePlanePlan: () => ({ onScreen: false }) },
    };
    const blits: Array<{ src: unknown; dst: unknown; to: string }> = [];
    const adapter = Object.assign(Object.create(D3D8DeviceAdapter.prototype), {
        drawDiagCount: 0, presentInterval: 0, presentCount: 20,
        renderTarget: back, frameSnapshot: {}, prevPresentTime: 0,
        presentComposite: null, presentPlan: createPresentPlan(),
        presentCompositeDst: { left: 0, top: 0, right: 0, bottom: 0 },
        flushProgrammablePending: () => {}, pumpLockReadbackPrefetch: () => {},
        renderer: {
            syncSurfaceFromMemory: () => {},
            flush: () => events.push('flush'),
            clear: (target: RenderSurface) => {
                if (!target.gpuTextureView) {
                    const name = `composite${++made}`;
                    target.gpuTexture = { destroy: () => destroyed.push(name) } as unknown as GPUTexture;
                    target.gpuTextureView = { name } as unknown as GPUTextureView;
                }
                events.push('clear');
            },
            invalidateSurfaceCache: () => events.push('invalidate'),
            blitWithShaderCopy: (src: RenderSurface, dst: RenderSurface, s: object, d: object) => {
                expect(src).toBe(back);
                if (!dst.gpuTextureView) {
                    const name = `composite${++made}`;
                    dst.gpuTexture = { destroy: () => destroyed.push(name) } as unknown as GPUTexture;
                    dst.gpuTextureView = { name } as unknown as GPUTextureView;
                }
                events.push('blit');
                blits.push({ src: { ...s }, dst: { ...d }, to: (dst.gpuTextureView as unknown as { name: string }).name });
            },
            finalizePendingDraws: () => null, flushVertexParams: () => {},
            ringBufferManager: { flushUniforms: () => {}, flushStorageBuffer: () => {}, nextFrame: () => {} },
            sampleFrameStats: () => {}, postSubmitCleanup: () => {},
        },
    }) as D3D8DeviceAdapter;
    const run = async (more: Array<PresentRegion | undefined>) => {
        const system = spyOn(System, 'getInstance').mockReturnValue(fakeSystem as unknown as System);
        try {
            for (const r of more) expect(await adapter.present(r)).toBe(0);
        } finally { system.mockRestore(); }
    };
    await run(regions);
    return { events, shown, blits, destroyed, made: () => made, adapter, run };
}

async function presentAgain(r: Awaited<ReturnType<typeof presentWith>>, regions: Array<PresentRegion | undefined>) {
    await r.run(regions);
    return r;
}

describe('D3D8 Present with rectangles', () => {
    test('without rectangles the back buffer is shown as before: no flush, no copy', async () => {
        const r = await presentWith([undefined]);
        expect(r.events).toEqual(['display', 'submit']);
        expect(r.shown).toEqual([{ name: 'back', srcW: 640, srcH: 480 }]);
    });

    test('rectangles that name the whole back buffer and client area change nothing either', async () => {
        const r = await presentWith([region(rect(0, 0, 640, 480), rect(0, 0, 800, 600), 800, 600)]);
        expect(r.events).toEqual(['display', 'submit']);
        expect(r.shown[0].name).toBe('back');
    });

    test('a source rectangle is composed at client size, after the pending draws', async () => {
        const r = await presentWith([region(rect(0, 0, 560, 400), rect(0, 0, 560, 400), 560, 400)]);
        expect(r.events).toEqual(['flush', 'blit', 'display', 'submit']);
        expect(r.blits[0]).toEqual({ src: rect(0, 0, 560, 400), dst: rect(0, 0, 560, 400), to: 'composite1' });
        expect(r.shown).toEqual([{ name: 'composite1', srcW: 560, srcH: 400 }]);
    });

    test('the composite is reused frame after frame and replaced when the client size changes', async () => {
        const a = region(rect(0, 0, 560, 400), rect(0, 0, 560, 400), 560, 400);
        const b = region(rect(0, 0, 560, 400), rect(0, 0, 1120, 800), 1120, 800);
        const frames: PresentRegion[] = [];
        for (let i = 0; i < 50; i++) frames.push(a);
        frames.push(b, b);
        const r = await presentWith(frames);
        expect(r.made()).toBe(2);
        expect(r.destroyed).toEqual(['composite1']);
        expect(r.shown.at(-1)).toEqual({ name: 'composite2', srcW: 1120, srcH: 800 });
    });

    const frame = (events: string[], n: number) => {
        const out: string[][] = [[]];
        for (const e of events) { out.at(-1)!.push(e); if (e === 'submit') out.push([]); }
        return out[n];
    };
    const sub = region(null, rect(0, 0, 400, 300), 800, 600);
    const moved = region(null, rect(100, 100, 500, 400), 800, 600);
    const full = region(rect(0, 0, 320, 240), rect(0, 0, 800, 600), 800, 600);
    const none = region(rect(10, 10, 10, 50), null, 800, 600);

    test('a destination rectangle that stays put on a fresh composite needs no clear', async () => {
        const r = await presentWith([sub, sub, sub]);
        expect(r.made()).toBe(1);
        expect(r.events.includes('clear')).toBe(false);
    });

    test('a destination rectangle that moves clears the composite once and keeps its texture', async () => {
        const r = await presentWith([sub, sub, moved, moved]);
        expect(r.made()).toBe(1);
        expect(r.destroyed).toEqual([]);
        expect(frame(r.events, 1)).toEqual(['flush', 'blit', 'display', 'submit']);
        expect(frame(r.events, 2)).toEqual(['clear', 'flush', 'blit', 'display', 'submit']);
        expect(frame(r.events, 3)).toEqual(['flush', 'blit', 'display', 'submit']);
    });

    test('an uncovered rectangle after a covering one starts from black again', async () => {
        const r = await presentWith([sub, full, sub, sub]);
        expect(r.made()).toBe(1);
        expect(frame(r.events, 1)).toEqual(['flush', 'blit', 'display', 'submit']);
        expect(frame(r.events, 2)).toEqual(['clear', 'flush', 'blit', 'display', 'submit']);
        expect(frame(r.events, 3)).toEqual(['flush', 'blit', 'display', 'submit']);
    });

    test('a present that lands nowhere shows a black client area, cleared once', async () => {
        const r = await presentWith([none, none, sub, none, none]);
        expect(r.made()).toBe(1);
        expect(frame(r.events, 0)).toEqual(['clear', 'display', 'submit']);
        expect(frame(r.events, 1)).toEqual(['display', 'submit']);
        expect(frame(r.events, 2)).toEqual(['flush', 'blit', 'display', 'submit']);
        expect(frame(r.events, 3)).toEqual(['clear', 'display', 'submit']);
        expect(frame(r.events, 4)).toEqual(['display', 'submit']);
        expect(r.shown.map(x => x.name)).toEqual(Array(5).fill('composite1'));
    });

    test('the composite is one of the surfaces the device owns, and comes back after a device loss', async () => {
        const r = await presentWith([sub]);
        const inner = r.adapter as unknown as {
            presentComposite: RenderSurface; rtOverride: null; texSurfaces: Map<number, RenderSurface>;
            ownedSurfaces(): Iterable<{ state: RenderSurface }>;
        };
        inner.rtOverride = null; inner.texSurfaces = new Map();
        const owned = [...inner.ownedSurfaces()].map(o => o.state);
        expect(owned).toContain(inner.presentComposite);
        // What the device-loss walk does to every owned surface.
        inner.presentComposite.gpuTexture = undefined;
        inner.presentComposite.gpuTextureView = undefined;
        const again = await presentAgain(r, [sub, none]);
        expect(again.blits.at(-1)!.to).toBe('composite2');
        expect(again.shown.map(x => x.name).slice(-2)).toEqual(['composite2', 'composite2']);
        inner.presentComposite.gpuTexture = undefined;
        inner.presentComposite.gpuTextureView = undefined;
        const blank = await presentAgain(r, [none]);
        expect(blank.shown.at(-1)!.name).toBe('composite3');
    });

    test('Reset drops the composite with the back buffer', async () => {
        const r = await presentWith([region(rect(0, 0, 560, 400), rect(0, 0, 560, 400), 560, 400)]);
        (r.adapter as unknown as { dropPresentComposite(): void }).dropPresentComposite();
        expect(r.destroyed).toEqual(['composite1']);
        expect((r.adapter as unknown as { presentComposite: unknown }).presentComposite).toBeNull();
    });
});

describe('IDirect3DDevice8_Present reads its rectangles', () => {
    const DEVICE = 0x7000;
    const memory = new Uint8Array(0x1000);
    afterEach(() => { devices.delete(DEVICE); });

    const call = (pSrc: number, pDst: number, hwnd: number, client: { w: number; h: number } | null, fullscreen = false) => {
        Mem.bind(() => memory);
        const seen: Array<PresentRegion | undefined> = [];
        devices.set(DEVICE, {
            presentWindow: 0x30,
            presentsExclusiveFullscreen: fullscreen,
            present: (r?: PresentRegion) => { seen.push(r ? JSON.parse(JSON.stringify(r)) : undefined); return Promise.resolve(0); },
        } as unknown as D3D8DeviceAdapter);
        const asked: number[] = [];
        const system = spyOn(System, 'getInstance').mockReturnValue({
            windowManager: { getWindow: (h: number) => { asked.push(h); return client ? { rect: { x: 40, y: 40, w: client.w, h: client.h } } : undefined; } },
        } as unknown as System);
        try { createDeviceExports().IDirect3DDevice8_Present({} as never, memory, [DEVICE, pSrc, pDst, hwnd, 0]); }
        finally { system.mockRestore(); }
        return { seen, asked };
    };
    const put = (at: number, l: number, t: number, r: number, b: number) => {
        const v = new DataView(memory.buffer);
        v.setInt32(at, l, true); v.setInt32(at + 4, t, true); v.setInt32(at + 8, r, true); v.setInt32(at + 12, b, true);
    };

    test('NULL rectangles present without a region', () => {
        const r = call(0, 0, 0, { w: 560, h: 400 });
        expect(r.seen).toEqual([undefined]);
        expect(r.asked).toEqual([]);
    });

    test('both rectangles and the override window reach the device', () => {
        put(0x100, 0, 0, 560, 400);
        put(0x200, -8, 4, 552, 404);
        const r = call(0x100, 0x200, 0x55, { w: 560, h: 400 });
        expect(r.asked).toEqual([0x55]);
        expect(r.seen[0]).toEqual({
            hasSrc: true, src: rect(0, 0, 560, 400), hasDst: true, dst: rect(-8, 4, 552, 404),
            clientWidth: 560, clientHeight: 400,
        });
    });

    test('without an override the device window supplies the client size; an unknown window gives none', () => {
        put(0x100, 0, 0, 320, 240);
        const a = call(0x100, 0, 0, { w: 800, h: 600 });
        expect(a.asked).toEqual([0x30]);
        expect(a.seen[0]).toMatchObject({ hasSrc: true, hasDst: false, clientWidth: 800, clientHeight: 600 });
        const b = call(0x100, 0, 0, null);
        expect(b.seen[0]).toMatchObject({ clientWidth: 0, clientHeight: 0 });
    });

    test('a fullscreen device presents onto its back buffer whatever size its window has', () => {
        put(0x100, 0, 0, 320, 240);
        const r = call(0x100, 0, 0x55, { w: 800, h: 600 }, true);
        expect(r.asked).toEqual([]);
        expect(r.seen[0]).toMatchObject({ hasSrc: true, hasDst: false, clientWidth: 0, clientHeight: 0 });
    });
});
