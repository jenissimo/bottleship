import { describe, expect, test } from 'bun:test';
import { D3D9Device } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';

const D3DRS_SCISSORTESTENABLE = 174;

function makeDevice(opts: {
    preTransformed: boolean;
    viewport: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number };
    scissor?: { left: number; top: number; right: number; bottom: number };
}): any {
    const d: any = Object.create(D3D9Device.prototype);
    const scissorDrawRect = { left: 0, top: 0, width: 0, height: 0 };
    Object.assign(d, {
        viewport: opts.viewport,
        scissorDrawRect,
        rhwDrawViewport: { x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1 },
        drawRects: { scissorRect: scissorDrawRect, viewport: opts.viewport },
        activeDeclIsPreTransformed: () => opts.preTransformed,
        getCurrentTargetSize: () => ({ w: 640, h: 480 }),
        getRS: (k: number) => (k === D3DRS_SCISSORTESTENABLE && opts.scissor ? 1 : 0),
        effectiveScissorRect: () => opts.scissor ?? { left: 0, top: 0, right: 640, bottom: 480 },
    });
    return d;
}

const sub = { x: 100, y: 50, width: 200, height: 120, minZ: 0.25, maxZ: 0.75 };
const full = { x: 0, y: 0, width: 640, height: 480, minZ: 0.1, maxZ: 0.9 };

describe('D3D9 pre-transformed draws in a sub-viewport', () => {
    test('scissor disabled: whole-target viewport, clipped to the guest viewport', () => {
        const d = makeDevice({ preTransformed: true, viewport: { ...sub } });
        expect(d.getViewportForDraw()).toEqual({ x: 0, y: 0, width: 640, height: 480, minZ: 0.25, maxZ: 0.75 });
        expect(d.getScissorRectForDraw()).toEqual({ left: 100, top: 50, width: 200, height: 120 });
    });

    test('scissor enabled inside the viewport: the scissor wins', () => {
        const d = makeDevice({ preTransformed: true, viewport: { ...sub }, scissor: { left: 150, top: 60, right: 250, bottom: 100 } });
        expect(d.getViewportForDraw()).toEqual({ x: 0, y: 0, width: 640, height: 480, minZ: 0.25, maxZ: 0.75 });
        expect(d.getScissorRectForDraw()).toEqual({ left: 150, top: 60, width: 100, height: 40 });
    });

    test('scissor overlapping the viewport: the intersection is used', () => {
        const d = makeDevice({ preTransformed: true, viewport: { ...sub }, scissor: { left: 50, top: 100, right: 180, bottom: 400 } });
        expect(d.getScissorRectForDraw()).toEqual({ left: 100, top: 100, width: 80, height: 70 });
    });

    test('scissor disjoint from the viewport: empty rectangle', () => {
        const d = makeDevice({ preTransformed: true, viewport: { ...sub }, scissor: { left: 400, top: 300, right: 500, bottom: 400 } });
        const r = d.getScissorRectForDraw();
        expect(r.width * r.height).toBe(0);
    });

    test('fractional viewport edges round outwards', () => {
        const d = makeDevice({ preTransformed: true, viewport: { x: 10.5, y: 20.5, width: 100, height: 50, minZ: 0, maxZ: 1 } });
        expect(d.getScissorRectForDraw()).toEqual({ left: 10, top: 20, width: 101, height: 51 });
    });

    test('full-target viewport keeps the guest viewport object and depth range', () => {
        const viewport = { ...full };
        const d = makeDevice({ preTransformed: true, viewport });
        expect(d.getViewportForDraw()).toBe(viewport);
        expect(d.getScissorRectForDraw()).toEqual({ left: 0, top: 0, width: 640, height: 480 });
    });

    test('transformed draws keep the sub-viewport and are not clipped by it', () => {
        const viewport = { ...sub };
        const d = makeDevice({ preTransformed: false, viewport });
        expect(d.getViewportForDraw()).toBe(viewport);
        expect(d.getScissorRectForDraw()).toEqual({ left: 0, top: 0, width: 640, height: 480 });
        const s = makeDevice({ preTransformed: false, viewport, scissor: { left: 50, top: 100, right: 180, bottom: 400 } });
        expect(s.getScissorRectForDraw()).toEqual({ left: 50, top: 100, width: 130, height: 300 });
    });

    test('both rectangles come from a single resolve', () => {
        const d = makeDevice({ preTransformed: true, viewport: { ...sub } });
        let calls = 0;
        const inner = d.activeDeclIsPreTransformed;
        d.activeDeclIsPreTransformed = () => { calls++; return inner(); };
        const rects = d.resolveDrawRects();
        expect(calls).toBe(1);
        expect(rects.viewport.width).toBe(640);
        expect(rects.scissorRect).toEqual({ left: 100, top: 50, width: 200, height: 120 });
    });
});
