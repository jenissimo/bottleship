import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createDeviceExports } from "../../src/worker/modules/d3d8/device";
import { devices } from "../../src/worker/modules/d3d8/shared-state";
import { D3D8DeviceAdapter } from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";
import { clipClearRectsToViewport } from "../../src/worker/backends/webgpu/ddraw/clear-pipeline";

const DEVICE = 0xabc123, RECTS = 0x10000;
const api = createDeviceExports();
let mem: Uint8Array, calls: any[][], oldMem: any, oldProcess: unknown, oldDevice: any;
let denied: boolean;
beforeEach(() => {
    mem = new Uint8Array(0x20000); calls = []; denied = false;
    oldMem = (Mem as any).memoryGetter; oldProcess = System.getInstance().process;
    oldDevice = devices.get(DEVICE); Mem.bind(() => mem);
    System.getInstance().process = { addressSpace: { validateRange: () => !denied } } as never;
    devices.set(DEVICE, { clear: (...args: any[]) => calls.push(args) } as never);
});
afterEach(() => {
    if (oldDevice) devices.set(DEVICE, oldDevice); else devices.delete(DEVICE);
    System.getInstance().process = oldProcess as never; Mem.bind(oldMem);
});
function rect(values: number[], at = RECTS): void {
    const v = new DataView(mem.buffer); values.forEach((n, i) => v.setInt32(at + i * 4, n, true));
}
function clear(count: number, p = RECTS, flags = 7): number {
    return api.IDirect3DDevice8_Clear!({} as never, mem, [DEVICE, count, p, flags, 0xff123456, 0x3f000000, 11]) as number;
}
test("Clear forwards every rectangle and the color/depth/stencil values", () => {
    rect([1, 2, 20, 30, -5, -6, 4, 8]);
    expect(clear(2)).toBe(0);
    expect(calls).toEqual([[7, 0xff123456, 0.5, 11, [{ x1: 1, y1: 2, x2: 20, y2: 30 }, { x1: -5, y1: -6, x2: 4, y2: 8 }]]]);
});
test("NULL array clears the viewport regardless of count; a non-NULL zero-count array does nothing", () => {
    expect(clear(0, 0)).toBe(0); expect(clear(4, 0)).toBe(0); expect(calls.length).toBe(2);
    expect(calls[0]!.length).toBe(4);
    calls.length = 0; expect(clear(0)).toBe(0); expect(calls).toEqual([]);
});
test("empty rectangles do not turn into a full-target clear", () => {
    rect([1, 1, 1, 4, 10, 10, 5, 5]);
    expect(clear(2)).toBe(0); expect(calls).toEqual([]);
});
test("the whole guest array must be in bounds and readable", () => {
    expect(clear(2, mem.length - 16)).toBe(0x8876086c);
    expect(clear(0xffffffff)).toBe(0x8876086c);
    denied = true; expect(clear(1)).toBe(0x8876086c); expect(calls).toEqual([]);
});
test("the adapter preserves the viewport and rectangle list for the shared clear pipeline", () => {
    const target = { width: 100, height: 80 };
    const viewport = { x: 10, y: 20, width: 50, height: 40 };
    const rects = [{ x1: 0, y1: 0, x2: 30, y2: 40 }];
    let flushed = false;
    const adapter = Object.assign(Object.create(D3D8DeviceAdapter.prototype), {
        renderTarget: target, viewport,
        flushProgrammablePending: () => { flushed = true; },
        renderer: { clear: (...args: any[]) => { expect(flushed).toBe(true); calls.push(args); } },
    });
    adapter.clear(6, 0, 0.5, 11, rects);
    expect(calls[0]).toEqual([target, 6, 0, 0.5, expect.objectContaining(viewport), rects, 11]);
    expect(clipClearRectsToViewport(rects, viewport)).toEqual([{ x1: 10, y1: 20, x2: 30, y2: 40 }]);
});
