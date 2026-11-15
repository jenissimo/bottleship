import { afterEach, expect, test } from 'bun:test';
import { createOpenGLContext, VERT_FLOATS, CI_VERT_COUNT, CMD_I32, CI_FLAGS, CMD_F32 } from '../../src/worker/modules/opengl32/context';
import { emitDrawCommandFlat, emitDrawCommandFromPrebaked } from '../../src/worker/modules/opengl32/immediate';
import { GL_TRIANGLES, GL_LIGHTING, GL_LIGHT0, GL_FOG, GL_COLOR_MATERIAL, GL_SELECT } from '../../src/worker/modules/opengl32/constants';
import { armGLFrameCapture, cancelGLFrameCapture, captureGLDrawEmissionIfArmed, captureGLFrameIfArmed,
    takeGLFrameCapture, summarizeGLComponents } from '../../src/worker/modules/opengl32/frame-capture';

import { describeGLDrawPacket } from '../../src/worker/harness/cmds/gl';

afterEach(cancelGLFrameCapture);
const context = () => createOpenGLContext({} as never);
function triangle(color = [0, 0, 0, 1]) {
    const vertices = new Float32Array(3 * VERT_FLOATS);
    for (let i = 0; i < 3; i++) {
        const b = i * VERT_FLOATS;
        vertices.set([i * 0.2, i * 0.1, -5, 1, ...color, 0.25, 0.5, 0.75, 0, 0, 1, 1], b);
    }
    return vertices;
}
test('draw state and normals are frozen at emission, before later UI state and fog overwrite', () => {
    const ctx = context();
    ctx.enableFlags.add(GL_LIGHTING); ctx.enableFlags.add(GL_LIGHT0); ctx.enableFlags.add(GL_FOG);
    ctx.enableFlags.add(GL_COLOR_MATERIAL);
    ctx.materialFrontDiffuse.set([0.4, 0.5, 0.6, 1]); ctx.lights[0]!.diffuse.set([0.7, 0.8, 0.9, 1]);
    ctx.colorArray.enabled = true; ctx.colorArray.pointer = 0x200;
    armGLFrameCapture({ drawState: true }, ctx);
    emitDrawCommandFlat(ctx, GL_TRIANGLES, triangle(), 3);
    ctx.enableFlags.clear(); ctx.materialFrontDiffuse.fill(0); ctx.lights[0]!.diffuse.fill(0);
    ctx.currentColor.fill(1); ctx.colorArray.pointer = 0x400;
    captureGLFrameIfArmed(ctx, 1024, 768);
    const capture = takeGLFrameCapture()!, emission = capture.drawEmissions[0]!;
    expect(capture.count).toBe(1);
    expect(emission.commandIndex).toBe(0);
    expect(emission.state.lighting).toBe(true);
    expect(emission.state.lights[0]!.enabled).toBe(true);
    expect(emission.state.material.diffuse).toEqual(Array.from(new Float32Array([0.4, 0.5, 0.6, 1])));
    expect(emission.state.lights[0]!.diffuse).toEqual(Array.from(new Float32Array([0.7, 0.8, 0.9, 1])));
    expect(emission.state.colorArray.pointer).toBe(0x200);
    expect(emission.color).toEqual({ min: [0, 0, 0, 1], max: [0, 0, 0, 1], nonFinite: [0, 0, 0, 0] });
    expect(emission.normal).toEqual({ min: [0.25, 0.5, 0.75], max: [0.25, 0.5, 0.75], nonFinite: [0, 0, 0] });
    expect(capture.verts[8]).toBe(5); // Completed arena holds eye distance here, not normal.x.
    ctx.vertArena.data.fill(77);
    expect(capture.verts[8]).toBe(5);
    expect(emission.normal.min[0]).toBe(0.25);
});
test('state-distinct emissions survive merged draw commands without changing command/vertex output', () => {
    function render(armed: boolean) {
        const ctx = context(); if (armed) armGLFrameCapture({ drawState: true }, ctx);
        ctx.enableFlags.add(GL_LIGHTING);
        emitDrawCommandFlat(ctx, GL_TRIANGLES, triangle(), 3);
        ctx.enableFlags.delete(GL_LIGHTING);
        emitDrawCommandFromPrebaked(ctx, GL_TRIANGLES, triangle([1, 0.5, 0.25, 1]), 3);
        return ctx;
    }
    const baseline = render(false), observed = render(true);
    expect(observed.commands.count).toBe(1); // Observer never disables normal draw merging.
    expect(observed.commands.i32[CI_VERT_COUNT]).toBe(6);
    expect(Array.from(observed.commands.i32.subarray(0, CMD_I32))).toEqual(Array.from(baseline.commands.i32.subarray(0, CMD_I32)));
    expect(Array.from(observed.vertArena.data.subarray(0, observed.vertArena.used))).toEqual(Array.from(baseline.vertArena.data.subarray(0, baseline.vertArena.used)));
    captureGLFrameIfArmed(observed, 800, 600);
    const entries = takeGLFrameCapture()!.drawEmissions;
    expect(entries.map(e => [e.commandIndex, e.vertexOffset, e.vertexCount, e.state.lighting])).toEqual([[0, 0, 3, true], [0, 3 * VERT_FLOATS, 3, false]]);
});
test('metadata off and unarmed hooks return before reading context or allocating a snapshot', () => {
    const trap = new Proxy({} as ReturnType<typeof context>, { get() { throw new Error('context was read'); } });
    expect(captureGLDrawEmissionIfArmed(trap, 0, 3)).toBeUndefined();
    armGLFrameCapture();
    expect(captureGLDrawEmissionIfArmed(trap, 0, 3)).toBeUndefined();
    cancelGLFrameCapture();
    expect(captureGLDrawEmissionIfArmed(trap, 0, 3)).toBeUndefined();
});
test('metadata is capped, omitted earlier draws are explicit and foreign contexts cannot consume the request', () => {
    const ctx = context();
    emitDrawCommandFlat(ctx, GL_TRIANGLES, triangle(), 3);
    armGLFrameCapture({ drawState: true, maxDrawStates: 1 }, ctx);
    emitDrawCommandFlat(ctx, GL_TRIANGLES, triangle(), 3);
    ctx.materialFrontDiffuse.fill(0.3);
    emitDrawCommandFlat(ctx, GL_TRIANGLES, triangle(), 3);
    captureGLFrameIfArmed(context(), 1, 1); expect(takeGLFrameCapture()).toBeNull();
    captureGLFrameIfArmed(ctx, 800, 600);
    const capture = takeGLFrameCapture()!;
    expect(capture.drawEmissions).toHaveLength(1);
    expect(capture.drawEmissions[0]!.vertexOffset).toBe(3 * VERT_FLOATS);
    expect(capture.emissionCoverage).toEqual({ enabled: true, limit: 1, dropped: 1, commandsBeforeArm: 1 });
});
test('range summary retains alpha, negative/HDR values and explicit nonfinite counts', () => {
    const vertices = triangle([0, 0.25, 2, 0.5]);
    vertices[4] = -1; vertices[VERT_FLOATS + 5] = NaN; vertices[VERT_FLOATS * 2 + 6] = Infinity;
    expect(summarizeGLComponents(vertices, 0, 3, 4, 4)).toEqual({
        min: [-1, 0.25, 2, 0.5], max: [0, 0.25, 2, 0.5], nonFinite: [0, 1, 1, 0],
    });
});
test('selection pass does not contribute raster draw metadata and cancelled requests stay disarmed', () => {
    const ctx = context();
    armGLFrameCapture({ drawState: true }, ctx);
    ctx.renderMode = GL_SELECT; emitDrawCommandFlat(ctx, GL_TRIANGLES, triangle(), 3);
    captureGLFrameIfArmed(ctx, 640, 480);
    expect(takeGLFrameCapture()!.drawEmissions).toEqual([]);
    expect(takeGLFrameCapture()!.i32[CI_FLAGS] ?? 0).toBe(0);
    armGLFrameCapture({ drawState: true }, ctx); cancelGLFrameCapture();
    captureGLFrameIfArmed(ctx, 640, 480); expect(takeGLFrameCapture()).toBeNull();
});

test('packet diagnostics distinguish shadow write masks and preserve blend/alpha/depth/stencil after ctx changes', () => {
    const ctx = context();
    ctx.colorMaskR = ctx.colorMaskG = ctx.colorMaskB = ctx.colorMaskA = false;
    ctx.enableFlags.add(0x0B90); ctx.enableFlags.add(0x0B71); // STENCIL_TEST, DEPTH_TEST
    ctx.stencilFunc = 0x0202; ctx.stencilRef = 7; ctx.stencilMask = 0xff00ff00;
    ctx.stencilFail = 0x1e00; ctx.stencilZFail = 0x1e02; ctx.stencilZPass = 0x1e03; ctx.stencilWriteMask = 0xffffffff;
    armGLFrameCapture({}, ctx);
    emitDrawCommandFlat(ctx, GL_TRIANGLES, triangle(), 3);
    ctx.colorMaskR = ctx.colorMaskG = ctx.colorMaskB = ctx.colorMaskA = true;
    ctx.enableFlags.add(0x0BE2); ctx.enableFlags.add(0x0BC0); // BLEND, ALPHA_TEST
    ctx.blendSrc = 0x0302; ctx.blendDst = 0x0303; ctx.alphaFunc = 0x0204; ctx.alphaRef = 0.25;
    ctx.depthFunc = 0x0203; ctx.depthMask = false;
    emitDrawCommandFlat(ctx, GL_TRIANGLES, triangle([1, 1, 1, 1]), 3);
    captureGLFrameIfArmed(ctx, 800, 600);
    ctx.stencilRef = 99; ctx.blendSrc = 0; ctx.alphaRef = 0.9;
    const cap = takeGLFrameCapture()!;
    expect(cap.count).toBe(2);
    const shadow = describeGLDrawPacket(cap.i32, cap.f32, 0, 0);
    expect(shadow.colorMask).toEqual({r:false,g:false,b:false,a:false});
    expect(shadow.stencil).toEqual({ enabled:true,func:0x0202,ref:7,mask:0xff00ff00,
        fail:0x1e00,zfail:0x1e02,zpass:0x1e03,writeMask:0xffffffff });
    const color = describeGLDrawPacket(cap.i32, cap.f32, CMD_I32, CMD_F32);
    expect(color.colorMask).toEqual({r:true,g:true,b:true,a:true});
    expect(color.blend).toEqual({enabled:true,src:0x0302,dst:0x0303});
    expect(color.alphaTest).toEqual({enabled:true,func:0x0204,ref:0.25});
    expect(color.depthFunc).toBe(0x0203); expect(color.depthTest).toBe(true); expect(color.depthWrite).toBe(false);
    expect(color.stencil.ref).toBe(7);
});
