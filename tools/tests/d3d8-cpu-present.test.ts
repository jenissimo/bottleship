import { describe, expect, spyOn, test } from 'bun:test';
import { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';
import { System } from '../../src/worker/core/system';
import { surfaceSyncManager } from '../../src/worker/modules/ddraw/surface-sync';
import type { RenderSurface } from '../../src/worker/modules/ddraw/com-objects';

// The actual Present entry point, with a one-pixel GPU transport. CPU and GPU start
// with different frames. No primitive is drawn between a CPU write and Present.
async function presentCpuFrame(dirty: boolean, hasView = true, presents = 1) {
    const events: string[] = [];
    const view = { pixel: 0x112233ff };
    const surface = {
        surfaceType: 'render_surface', width: 1, height: 1, pitch: 4,
        surfacePtr: 4096, format: { bpp: 32 }, caps: 0,
        mode: dirty ? 'CPU' : 'GPU_ONLY', gpuDirty: dirty,
        version: 2, lastUploadVersion: dirty ? 1 : 2, everLocked: dirty,
        gpuTexture: {}, gpuTextureView: hasView ? view : undefined,
    } as unknown as RenderSurface;
    let displayed = 0;
    let uploads = 0;
    const encoder = { finish: () => ({}) };
    const backend = {
        kind: 'webgpu',
        getDevice: () => ({ createCommandEncoder: () => encoder }),
        getQueue: () => ({ submit: () => events.push('submit') }),
        getContext: () => ({ getCurrentTexture: () => ({ width: 1, height: 1, createView: () => ({}) }) }),
        drawTexture: (source: typeof view) => { events.push('display'); displayed = source.pixel; },
    };
    const fakeSystem = {
        services: { render: { getBackend: () => backend, getActive: () => adapter, notifyPresent: () => {} } },
        gdiContext: { getOverlayCanvas: () => null },
        videoRouting: { resolvePlanePlan: () => ({ onScreen: false }) },
    };
    const adapter = Object.assign(Object.create(D3D8DeviceAdapter.prototype), {
        drawDiagCount: 0, presentInterval: 0, presentCount: 20,
        renderTarget: surface, frameSnapshot: {}, prevPresentTime: 0,
        flushProgrammablePending: () => {}, pumpLockReadbackPrefetch: () => {},
        renderer: {
            syncSurfaceFromMemory: (target: RenderSurface) => {
                events.push('sync');
                expect(target).toBe(surface);
                if (surfaceSyncManager.needsGPUSync(target).needed) {
                    uploads++;
                    view.pixel = 0xaabbccff;
                    target.gpuTextureView = view as unknown as GPUTextureView;
                    target.gpuDirty = false;
                    target.lastUploadVersion = target.version;
                }
            },
            finalizePendingDraws: () => null, flushVertexParams: () => {},
            ringBufferManager: { flushUniforms: () => {}, flushStorageBuffer: () => {}, nextFrame: () => {} },
            sampleFrameStats: () => {}, postSubmitCleanup: () => {},
        },
    }) as D3D8DeviceAdapter;
    const system = spyOn(System, 'getInstance').mockReturnValue(fakeSystem as unknown as System);
    try {
        for (let i = 0; i < presents; i++) expect(await adapter.present()).toBe(0);
    }
    finally { system.mockRestore(); }
    return { displayed, uploads, events };
}

describe('D3D8 CPU-written backbuffer presentation', () => {
    test('presents a CPU-written frame without requiring a later draw call', async () => {
        const result = await presentCpuFrame(true);
        expect(result.displayed).toBe(0xaabbccff);
        expect(result.uploads).toBe(1);
        expect(result.events).toEqual(['sync', 'display', 'submit']);
    });
    test('preserves a GPU-authored frame without uploading stale CPU memory', async () => {
        const result = await presentCpuFrame(false);
        expect(result.displayed).toBe(0x112233ff);
        expect(result.uploads).toBe(0);
    });
    test('reads the texture view after synchronization has supplied it', async () => {
        const result = await presentCpuFrame(true, false);
        expect(result.displayed).toBe(0xaabbccff);
        expect(result.events).toEqual(['sync', 'display', 'submit']);
    });
    test('a second Present without another CPU write does not upload again', async () => {
        const result = await presentCpuFrame(true, true, 2);
        expect(result.displayed).toBe(0xaabbccff);
        expect(result.uploads).toBe(1);
    });
});
