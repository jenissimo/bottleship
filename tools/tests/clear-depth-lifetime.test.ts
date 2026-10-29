// Deferred queue consumption retains each encoded clear value until submission.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ClearPipeline } from '../../src/worker/backends/webgpu/ddraw/clear-pipeline';
const globals = ['GPUBufferUsage', 'GPUShaderStage'] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
beforeEach(() => {
    previous = Object.fromEntries(globals.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    Object.assign(globalThis, {
        GPUBufferUsage: { VERTEX: 1, COPY_DST: 2, UNIFORM: 4 },
        GPUShaderStage: { VERTEX: 1 },
    });
});
afterEach(() => {
    for (const key of globals) {
        const prior = previous[key];
        if (prior) Object.defineProperty(globalThis, key, prior);
        else delete (globalThis as any)[key];
    }
});
function setup() {
    const buffers: any[] = [],
        writes: any[] = [];
    let fail: '' | 'allocation' | 'upload' | 'binding' = '';
    const queue = {
        writeBuffer(b: any, _offset: number, data: Float32Array) {
            if (fail === 'upload') throw Error('upload failed');
            b.value = data[0];
            writes.push(b);
        },
    };
    const device: any = {
        createBuffer() {
            if (fail === 'allocation') throw Error('allocation failed');
            const b = {
                value: 0,
                destroyed: 0,
                destroy() {
                    this.destroyed++;
                },
            };
            buffers.push(b);
            return b;
        },
        createBindGroupLayout: () => ({}),
        createBindGroup: (d: any) => {
            if (fail === 'binding') throw Error('binding failed');
            return d.entries[0].resource.buffer;
        },
        createShaderModule: () => ({}),
        createPipelineLayout: () => ({}),
        createRenderPipeline: () => ({}),
    };
    const pipeline = new ClearPipeline(device, queue as any);
    function encoder() {
        const draws: any[] = [],
            passes: any[] = [];
        return {
            draws,
            passes,
            beginRenderPass(d: any) {
                let binding: any;
                passes.push(d);
                return {
                    setBindGroup(_i: number, b: any) {
                        binding = b;
                    },
                    setPipeline() {},
                    setVertexBuffer() {},
                    setBlendConstant() {},
                    setStencilReference() {},
                    setScissorRect() {},
                    setViewport() {},
                    draw() {
                        draws.push(binding);
                    },
                    end() {},
                };
            },
        };
    }
    const clear = (e: any, depth: number, flags = 2) =>
        pipeline.clear(
            e,
            {} as any,
            4,
            2,
            {} as any,
            { flags, color: 0, depth, rects: [{ x1: 0, y1: 0, x2: 2, y2: 2 }] },
            'rgba8unorm'
        );
    return { pipeline, buffers, writes, encoder, clear, setFailure: (f: typeof fail) => (fail = f) };
}
test('one queued encoder preserves independent depth1 and depth0 clears', () => {
    const x = setup(),
        e = x.encoder();
    x.clear(e, 1);
    x.clear(e, 0);
    expect(e.draws.map(b => b.value)).toEqual([1, 0]);
    expect(e.draws.every(b => b.destroyed === 0)).toBe(true);
    const n = x.buffers.length;
    x.clear(e, 1);
    x.clear(e, 0);
    expect(x.buffers.length).toBe(n);
    x.pipeline.destroy();
});
test('fractional values survive later clears and are retired only for their submitted encoder', () => {
    const x = setup(),
        a = x.encoder(),
        b = x.encoder();
    x.clear(a, 0.25);
    x.clear(a, 0.75);
    x.clear(b, 0.25);
    x.clear(b, 1);
    expect(a.draws.map(d => d.value)).toEqual([0.25, 0.75]);
    expect(b.draws.map(d => d.value)).toEqual([0.25, 1]);
    x.pipeline.destroyPendingAfterSubmit(a as any);
    expect(a.draws.map(d => d.destroyed)).toEqual([1, 1]);
    expect(b.draws.map(d => d.destroyed)).toEqual([0, 0]);
    x.pipeline.destroyPendingAfterSubmit(a as any);
    expect(a.draws.map(d => d.destroyed)).toEqual([1, 1]);
    x.pipeline.destroyPendingAfterSubmit(b as any);
    expect(b.draws.map(d => d.destroyed)).toEqual([1, 0]);
    x.pipeline.destroy();
});
test('empty or unrelated encoder retirement cannot destroy pending clear values', () => {
    const x = setup(),
        a = x.encoder(),
        unsubmitted = x.encoder();
    x.clear(a, 0.375);
    x.clear(unsubmitted, 0.625);
    x.pipeline.destroyPendingAfterSubmit(x.encoder() as any);
    expect(a.draws[0].destroyed).toBe(0);
    expect(unsubmitted.draws[0].destroyed).toBe(0);
    x.pipeline.destroyPendingAfterSubmit(a as any);
    x.clear(unsubmitted, 0.125);
    expect(unsubmitted.draws.map(d => d.value)).toEqual([0.625, 0.125]);
    x.pipeline.destroy();
});
test('reset/device-loss destruction releases common and unsubmitted bindings exactly once', () => {
    const x = setup(),
        a = x.encoder(),
        b = x.encoder();
    x.clear(a, 0);
    x.clear(a, 1);
    x.clear(a, 0.25);
    x.clear(b, 0.75);
    x.pipeline.destroy();
    expect(x.buffers.map(b => b.destroyed)).toEqual(x.buffers.map(() => 1));
    x.pipeline.destroy();
    expect(x.buffers.every(b => b.destroyed === 1)).toBe(true);
});
test('color or stencil-only clears bind a valid clip-space depth independent of preceding depth', () => {
    const x = setup(),
        e = x.encoder();
    x.clear(e, 0.75);
    x.clear(e, 99, 1);
    x.clear(e, 99, 4);
    expect(e.draws.map(b => b.value)).toEqual([0.75, 0, 0]);
    x.pipeline.destroy();
});
for (const failure of ['upload', 'binding'] as const)
    test(failure + ' failure propagates, destroys allocation and leaves no open render pass', () => {
        const x = setup(),
            e = x.encoder();
        x.setFailure(failure);
        expect(() => x.clear(e, 0.25)).toThrow(failure + ' failed');
        expect(e.passes.length).toBe(0);
        expect(x.buffers.at(-1).destroyed).toBe(1);
        x.setFailure('');
        x.clear(e, 0.25);
        expect(e.draws[0].value).toBe(0.25);
        expect(e.draws[0].destroyed).toBe(0);
        x.pipeline.destroy();
        expect(x.buffers.every(b => b.destroyed === 1)).toBe(true);
    });

// Host-only deferred-command model: draw keeps a binding reference; values are
// consumed at queue submission, after both queue writes have occurred.
test('deferred queue consumption sees first requested depth after the second clear is encoded', () => {
    const x = setup(),
        e = x.encoder();
    x.clear(e, 0.125);
    x.clear(e, 0.875);
    const execute = (encoder: any) =>
        encoder.draws.map((buffer: any) => {
            if (buffer.destroyed) throw Error('destroyed before submission');
            return buffer.value;
        });
    expect(execute(e)).toEqual([0.125, 0.875]);
    x.pipeline.destroyPendingAfterSubmit(e as any);
    expect(e.draws.every((b: any) => b.destroyed === 1)).toBe(true);
    x.pipeline.destroy();
});

import { DDrawWebGPUExecutor } from '../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor';
for (const failure of ['none', 'finish', 'submit'] as const)
    test('actual executor clear ownership on ' + failure, () => {
        const x = setup(),
            e: any = x.encoder(),
            pending = x.encoder();
        x.clear(e, 0.25);
        x.clear(pending, 0.75);
        let submissions = 0;
        e.finish = () => {
            if (failure === 'finish') throw Error('controlled finish rejection');
            return e;
        };
        const instance: any = {
            deviceLost: false,
            renderStats: { flushes: 0 },
            flushBatch() {},
            vertexConverter: { flushParams() {}, destroyPendingAfterSubmit() {}, startFrame() {} },
            ringBufferManager: {
                flushGeometry() {},
                flushUniforms() {},
                flushLights() {},
                flushStorageBuffer() {},
            },
            surfacesNeedingClear: new Set(),
            currentRenderPass: null,
            currentEncoder: e,
            depthManager: { flushGarbage() {} },
            msaaColorManager: { flushGarbage() {} },
            textureConverter: { destroyPendingAfterSubmit() {} },
            clearPipeline: x.pipeline,
            encoderEpoch: 0,
            resetBindFastPath() {},
            queue: {
                submit(command: any[]) {
                    submissions++;
                    expect(command[0].draws[0].value).toBe(0.25);
                    expect(command[0].draws[0].destroyed).toBe(0);
                    if (failure === 'submit') throw Error('controlled submit rejection');
                },
            },
        };
        DDrawWebGPUExecutor.prototype.flush.call(instance); // Preserve inherited submit-error policy.
        expect(submissions).toBe(failure === 'finish' ? 0 : 1);
        expect(e.draws[0].destroyed).toBe(1);
        expect(pending.draws[0].destroyed).toBe(0);
        expect(instance.currentEncoder).toBeNull();
        DDrawWebGPUExecutor.prototype.flush.call(instance);
        expect(pending.draws[0].destroyed).toBe(0);
        x.pipeline.destroy();
    });
test('actual detached-encoder cleanup affects only its encoder and is idempotent', () => {
    const x = setup(),
        a = x.encoder(),
        b = x.encoder();
    x.clear(a, 0.25);
    x.clear(b, 0.75);
    const i: any = {
        clearPipeline: x.pipeline,
        depthManager: { flushGarbage() {}, resetFrameDirtyFlags() {} },
        msaaColorManager: { flushGarbage() {} },
        textureConverter: { destroyPendingAfterSubmit() {} },
        vertexConverter: { destroyPendingAfterSubmit() {}, startFrame() {} },
        applyMsaaAtFrameBoundary() {},
    };
    DDrawWebGPUExecutor.prototype.postSubmitCleanup.call(i, a as any);
    expect(a.draws[0].destroyed).toBe(1);
    expect(b.draws[0].destroyed).toBe(0);
    DDrawWebGPUExecutor.prototype.discardPendingDraws.call(i, a as any);
    expect(a.draws[0].destroyed).toBe(1);
    DDrawWebGPUExecutor.prototype.discardPendingDraws.call(i, b as any);
    expect(b.draws[0].destroyed).toBe(1);
    x.pipeline.destroy();
});
test('full depth clear retains descriptor value without a shader uniform allocation', () => {
    const x = setup(),
        e = x.encoder(),
        before = x.buffers.length;
    x.pipeline.clear(e as any, {} as any, 4, 2, {} as any, { flags: 2, depth: 0.375 }, 'rgba8unorm');
    expect(e.draws).toEqual([]);
    expect(e.passes.length).toBe(1);
    expect(e.passes[0].depthStencilAttachment.depthClearValue).toBe(0.375);
    expect(x.buffers.length).toBe(before);
    x.pipeline.destroy();
});

test('allocation failure precedes render-pass creation and leaves no retained binding', () => {
    const x = setup(),
        e = x.encoder(),
        before = x.buffers.length;
    x.setFailure('allocation');
    expect(() => x.clear(e, 0.125)).toThrow('allocation failed');
    expect(x.buffers.length).toBe(before);
    expect(e.passes.length).toBe(0);
    x.setFailure('');
    x.clear(e, 0.125);
    expect(e.draws[0].value).toBe(0.125);
    x.pipeline.destroy();
    expect(x.buffers.every(b => b.destroyed === 1)).toBe(true);
});
