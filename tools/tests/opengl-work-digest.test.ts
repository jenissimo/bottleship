import { expect, test, afterEach } from 'bun:test';
import { GLCommandStream, GLVertexArena, GLDrawCommandType, VERT_FLOATS,
    CI_MODE, CI_VERT_OFFSET, CI_VERT_COUNT, CI_FLAGS, CI_VP_W, CI_VP_H, CI_SCISSOR_X, DF_FOG,
    type OpenGLContext } from '../../src/worker/modules/opengl32/context';
import { GLWorkWindow, armGLWorkDigest, readGLWorkDigest, offGLWorkDigest,
    beginGLWorkPresent, finishGLWorkPresent, compareGLWorkDigests } from '../../src/worker/modules/opengl32/work-digest';
import { OpenGLBackendExecutor } from '../../src/worker/backends/webgpu/opengl/opengl-backend-executor';
import { OpenGLPresenter } from '../../src/worker/modules/opengl32/presenter';
import { System } from '../../src/worker/core/system';
import { GL_TRIANGLES } from '../../src/worker/modules/opengl32/constants';
import type { GLWorkExecutorAudit } from '../../src/worker/modules/opengl32/work-digest';

afterEach(() => { offGLWorkDigest(); });
function context(offsetVertices = 0): OpenGLContext {
    const ctx = { frameId: 10, commands: new GLCommandStream(), vertArena: new GLVertexArena(16) } as OpenGLContext;
    const c = ctx.commands.alloc(GLDrawCommandType.DRAW), i = c * 37;
    ctx.commands.i32[i + CI_MODE] = GL_TRIANGLES;
    ctx.commands.i32[i + CI_VERT_OFFSET] = offsetVertices * VERT_FLOATS;
    ctx.commands.i32[i + CI_VERT_COUNT] = 3;
    ctx.commands.i32[i + CI_VP_W] = 640; ctx.commands.i32[i + CI_VP_H] = 480;
    ctx.vertArena.used = (offsetVertices + 3) * VERT_FLOATS;
    for (let v = 0; v < 3; v++) ctx.vertArena.data.set([v, 2, 3, 1, .2, .4, .6, .8, 7, 8, 9, .1, .2, .3, .4, 0, 0, 0], (offsetVertices + v) * VERT_FLOATS);
    return ctx;
}
function submitted(row: GLWorkExecutorAudit & { executorCalled: boolean; returned: boolean }) {
    row.executorCalled = true; row.returned = true; row.encodedDraws++; row.encodedVertices += 3; row.submissions++;
}
function fingerprint(ctx: OpenGLContext) { return new GLWorkWindow(9).begin(ctx, 20)!.digest; }

test('unarmed fast path never reads even a poisoned context', () => {
    const poisoned = new Proxy({}, { get() { throw new Error('unarmed context read'); } }) as OpenGLContext;
    for (let i = 0; i < 100; i++) expect(beginGLWorkPresent(poisoned, 123)).toBeUndefined();
});
test('absolute future bounds capture exact frames, no RPC endpoint overshoot', () => {
    const ctx = context(); armGLWorkDigest(ctx, { startFrame: 12, frames: 2 });
    ctx.frameId = 11; expect(beginGLWorkPresent(ctx, 20)).toBeUndefined();
    for (let f = 12; f <= 13; f++) { ctx.frameId = f; const row = beginGLWorkPresent(ctx, f + 8)!; submitted(row); finishGLWorkPresent(row, f + 9); }
    ctx.frameId = 14; expect(beginGLWorkPresent(ctx, 22)).toBeUndefined();
    const report = readGLWorkDigest(ctx); expect(report.status).toBe('complete');
    expect(report.frames.map(r => r.frame)).toEqual([12, 13]);
    expect(report.frames.map(r => [r.hostSerialBefore, r.hostSerialAfter])).toEqual([[20, 21], [21, 22]]);
    report.frames[0]!.types[1] = 99; expect(readGLWorkDigest(ctx).frames[0]!.types[1]).toBe(1); // copies are immutable evidence
});
test('past targets, invalid bound and silently lost/repeated presents are refused', () => {
    expect(() => new GLWorkWindow(10, { startFrame: 10 })).toThrow();
    expect(() => new GLWorkWindow(10, { frames: 4097 })).toThrow();
    const ctx = context(), w = new GLWorkWindow(9, { frames: 2 });
    const row = w.begin(ctx, 20)!; submitted(row); w.finish(row, 21);
    ctx.frameId = 12; expect(w.begin(ctx, 21)).toBeUndefined(); expect(w.status).toBe('failed');
});
test('omitted command and changed color/state are caught, allocation offsets are normalized', () => {
    const a = context(), moved = context(5), expected = fingerprint(a);
    expect(fingerprint(moved)).toBe(expected);
    a.vertArena.data[4] = .3; expect(fingerprint(a)).not.toBe(expected);
    a.vertArena.data[4] = moved.vertArena.data[5 * VERT_FLOATS + 4]!;
    expect(fingerprint(a)).toBe(expected);
    a.commands.i32[CI_VP_W] = 639; expect(fingerprint(a)).not.toBe(expected);
    a.commands.i32[CI_VP_W] = 640; a.commands.count = 0; expect(fingerprint(a)).not.toBe(expected);
});
test('SCISSOR command fingerprints its own payload rather than recycled viewport slots', () => {
    const ctx = context(); ctx.commands.i32[0] = GLDrawCommandType.SCISSOR;
    const expected = fingerprint(ctx);
    ctx.commands.i32[CI_SCISSOR_X] = 7; expect(fingerprint(ctx)).not.toBe(expected);
    ctx.commands.i32[CI_SCISSOR_X] = 0; ctx.commands.i32[CI_VP_W] = 123; expect(fingerprint(ctx)).toBe(expected);
});
test('hash uses exact float bits, ignores non-rendered normals, and includes fog distance when active', () => {
    const ctx = context(), expected = fingerprint(ctx);
    ctx.vertArena.data[9] = 999; expect(fingerprint(ctx)).toBe(expected);
    ctx.vertArena.data[8] = 50; expect(fingerprint(ctx)).toBe(expected);
    ctx.commands.i32[CI_FLAGS] |= DF_FOG; const fog = fingerprint(ctx);
    ctx.vertArena.data[8] = 51; expect(fingerprint(ctx)).not.toBe(fog);
    ctx.commands.i32[CI_FLAGS] = 0; ctx.vertArena.data[0] = -0; expect(fingerprint(ctx)).not.toBe(expected);
});
test('missing executor, skipped submission, or a host-serial jump never becomes complete', () => {
    for (const mode of ['missing', 'submission', 'serial']) {
        const ctx = context(), w = new GLWorkWindow(9), row = w.begin(ctx, 20)!;
        if (mode !== 'missing') submitted(row);
        if (mode === 'submission') row.submissions = 0;
        w.finish(row, mode === 'serial' ? 22 : 21); expect(w.status).toBe('failed');
    }
});
test('malformed vertex extent fails closed before hashing recycled arena bytes', () => {
    const ctx = context(); ctx.commands.i32[CI_VERT_COUNT] = 9;
    const w = new GLWorkWindow(9); expect(w.begin(ctx, 20)).toBeUndefined(); expect(w.status).toBe('failed');
});
test('count-only mode exposes observer mode and leaves digest absent', () => {
    const ctx = context(), w = new GLWorkWindow(9, { hash: false }), row = w.begin(ctx, 20)!;
    expect(row.digest).toBeNull(); expect(row.vertices).toBe(3); expect(row.types).toEqual([0, 1, 0, 0]);
    submitted(row); w.finish(row, 21); expect(w.read().hashing).toBe(false);
});

// Real executeFrame loop, with only device/resource creation replaced. This proves that
// counters advance at actual pass.draw / successful queue.submit, not from expected input.
function executorProbe(dropDraw = false) {
    let draws = 0, submits = 0;
    const pass = { setViewport() {}, setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() { draws++; }, end() {} };
    const encoder = { beginRenderPass() { return pass; }, finish() { return {}; } };
    const device = { limits: { maxTextureDimension2D: 8192 }, createCommandEncoder() { return encoder; } };
    const queue = { submit() { submits++; } };
    const backend = { getDevice: () => device, getQueue: () => queue, getContext: () => ({ canvas: { width: 640, height: 480 }, getCurrentTexture: () => ({ createView: () => ({}) }) }), getFormat: () => 'bgra8unorm' };
    const e = Object.assign(Object.create(OpenGLBackendExecutor.prototype), {
        backend, offscreenView: {}, depthView: {}, uniformBuffer: {}, vertexBuffer: {},
        depthRangeMin: 0, depthRangeMax: 1, getDrawableSize: () => [640, 480], resolveRenderScale: () => 1,
        ensureStaticResources() {}, ensureTargets() {}, pruneTextureCache() {}, ensureUniformCapacity() {}, ensureVertexBufferCapacity() {},
        applyColorSeed() {}, prepareDrawData: () => dropDraw ? null : ({ data: new Float32Array(48), byteLength: 192, vertexCount: 3, topology: 'triangle-list' }),
        uploadVertices: () => 0, resolveTexture: () => null, getDefaultSampler: () => ({}), getWhiteTextureView: () => ({}),
        allocateUniformSlot: () => 0, writeUniforms() {}, getOrCreatePipeline: () => ({}), getOrCreateBindGroup: () => ({}),
        applyScissor: () => true, resolveFallbackPresentTexture: () => null, encodeClearPass: () => true,
        blitOffscreenToCanvas() {}, compositeStatsOverlay() {},
    }) as OpenGLBackendExecutor;
    return { e, draws: () => draws, submits: () => submits };
}
test('real presenter records before arena reset, seals after notify, and observer does not change submitted work', () => {
    const original = System.getInstance;
    try {
        const runs: number[][] = [];
        for (const armed of [false, true]) {
            let serial = 20;
            System.getInstance = () => ({ services: { render: { setActive() {}, getPresentSerial: () => serial, notifyPresent() { serial++; } } } }) as unknown as System;
            const ctx = context(), p = executorProbe();
            ctx.executor = p.e; ctx.textures = new Map(); ctx.drawableDC = 0;
            ctx.frameSnapshot = { presents: 0, drawCalls: 1, clearCalls: 0, texUploads: 0, vertexCount: 3 };
            if (armed) armGLWorkDigest(ctx);
            new OpenGLPresenter(ctx).present();
            runs.push([p.draws(), p.submits(), ctx.commands.count, ctx.vertArena.used, serial]);
            if (armed) {
                const report = readGLWorkDigest(ctx); expect(report.status).toBe('complete');
                expect(report.frames[0]!.vertices).toBe(3); expect(report.frames[0]!.commands).toBe(1);
                expect(report.frames[0]!.encodedDraws).toBe(1); expect(report.frames[0]!.submissions).toBe(1);
                expect([report.frames[0]!.hostSerialBefore, report.frames[0]!.hostSerialAfter]).toEqual([20, 21]);
            }
            offGLWorkDigest();
        }
        expect(runs[0]).toEqual([1, 1, 0, 0, 21]); expect(runs[1]).toEqual(runs[0]);
    } finally { System.getInstance = original; }
});

test('actual executor proves encoded vs submitted and catches an internally dropped draw', () => {
    const windows: ReturnType<GLWorkWindow['read']>[] = [];
    for (const drop of [false, true]) {
        const ctx = context(), p = executorProbe(drop), audit = { encodedDraws: 0, encodedVertices: 0, submissions: 0, fallback: false };
        p.e.executeFrame({ commands: ctx.commands, vertArena: ctx.vertArena.data, textures: new Map() }, audit);
        expect(audit.encodedDraws).toBe(p.draws()); expect(audit.submissions).toBe(p.submits());
        expect(audit.encodedDraws).toBe(drop ? 0 : 1); expect(audit.encodedVertices).toBe(drop ? 0 : 3);
        expect(audit.submissions).toBe(1); // a submitted blank frame is not an encoded draw
        const window = new GLWorkWindow(9), row = window.begin(ctx, 20)!;
        Object.assign(row, audit, { executorCalled: true, returned: true }); window.finish(row, 21);
        windows.push(window.read());
    }
    expect(compareGLWorkDigests(windows[0]!, windows[0]!).equal).toBe(true);
    const negative = compareGLWorkDigests(windows[0]!, windows[1]!);
    expect(negative.equal).toBe(false); expect(negative.failures).toContain('frame 0: encodedDraws differs');
});
