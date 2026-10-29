import { test, expect } from 'bun:test';
import { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';
import { ClearPipeline } from '../../src/worker/backends/webgpu/ddraw/clear-pipeline';
import { System } from '../../src/worker/core/system';
import { framePacer } from '../../src/worker/core/frame-pacer';
test('D3D8 failure after detached draw encoder retires its clear buffers', async () => {
    const globals = ['GPUBufferUsage', 'GPUShaderStage'];
    const prior = Object.fromEntries(globals.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    Object.assign(globalThis, {
        GPUBufferUsage: { VERTEX: 1, COPY_DST: 2, UNIFORM: 4 },
        GPUShaderStage: { VERTEX: 1 },
    });
    const buffers: any[] = [];
    const device: any = {
        createBuffer() {
            const b = {
                destroyed: 0,
                destroy() {
                    this.destroyed++;
                },
            };
            buffers.push(b);
            return b;
        },
        createBindGroupLayout: () => ({}),
        createBindGroup: () => ({}),
        createShaderModule: () => ({}),
        createPipelineLayout: () => ({}),
        createRenderPipeline: () => ({}),
    };
    const pipeline = new ClearPipeline(device, { writeBuffer() {} } as any);
    const encoder: any = {
        beginRenderPass() {
            return {
                setBindGroup() {},
                setPipeline() {},
                setVertexBuffer() {},
                setScissorRect() {},
                setViewport() {},
                draw() {},
                end() {},
            };
        },
    };
    pipeline.clear(
        encoder,
        {} as any,
        4,
        2,
        {} as any,
        { flags: 2, depth: 0.25, rects: [{ x1: 0, y1: 0, x2: 2, y2: 2 }] },
        'rgba8unorm'
    );
    const render = System.getInstance().services.render as any,
        oldBackend = render.getBackend;
    const paced = ['waitForPresentInterval', 'reserveFrameSlot', 'releaseFrameSlot'];
    const oldPace = Object.fromEntries(paced.map(k => [k, (framePacer as any)[k]]));
    const backend = {
        kind: 'webgpu',
        getDevice: () => device,
        getQueue: () => ({}),
        getContext: () => ({
            getCurrentTexture() {
                throw Error('synthetic swapchain failure');
            },
        }),
    };
    render.getBackend = () => backend;
    Object.assign(framePacer, {
        waitForPresentInterval: async () => {},
        reserveFrameSlot() {},
        releaseFrameSlot() {},
    });
    const adapter: any = Object.assign(Object.create(D3D8DeviceAdapter.prototype), {
        drawDiagCount: 0,
        flushProgrammablePending() {},
        presentCount: 11,
        renderTarget: { gpuTextureView: {} },
        renderer: {
            syncSurfaceFromMemory() {},
            finalizePendingDraws: () => encoder,
            postSubmitCleanup(e: any) {
                pipeline.destroyPendingAfterSubmit(e);
            },
            discardPendingDraws(e: any) {
                pipeline.destroyPendingAfterSubmit(e);
            },
            clearPipeline: pipeline,
        },
    });
    try {
        await expect(adapter.present()).rejects.toThrow('synthetic swapchain failure');
        expect(buffers[1].destroyed).toBe(1);
    } finally {
        render.getBackend = oldBackend;
        Object.assign(framePacer, oldPace);
        pipeline.destroy();
        for (const k of globals) {
            if (prior[k]) Object.defineProperty(globalThis, k, prior[k]!);
            else delete (globalThis as any)[k];
        }
    }
});
