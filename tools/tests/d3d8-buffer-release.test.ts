import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { D3D8DeviceAdapter } from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";
import { createResourcesExports } from "../../src/worker/modules/d3d8/resources";
import { createComTripleStubs } from "../../src/worker/modules/d3d8/state";
import { createComObject, addComRef, resourceToDevice, forgetComObject } from "../../src/worker/modules/d3d8/shared-state";

const api = { ...createComTripleStubs(), ...createResourcesExports() };
let oldProcess: unknown, oldMem: any, mem: Uint8Array, adapter: any;
let events: string[], next: number, created: number[];
beforeEach(() => {
    oldProcess = System.getInstance().process; oldMem = (Mem as any).memoryGetter;
    mem = new Uint8Array(0x20000); Mem.bind(() => mem); events = []; next = 0x1000; created = [];
    System.getInstance().process = {
        getCurrentMemory: () => mem,
        memory: {
            allocSystemBlock: (size: number) => { const p = next; next += size; return p; },
            freeSystemBlock: () => events.push("COM free"),
            free: () => events.push("guest free"),
        },
    } as never;
    adapter = Object.assign(Object.create(D3D8DeviceAdapter.prototype), {
        vbData: new Map(), ibData: new Map(), vbGpuBuffers: new Map(), ibGpuBuffers: new Map(),
        vbDirty: new Map(), ibDirty: new Map(), streamSources: [{ vb: 0, stride: 16 }, { vb: 0, stride: 32 }],
        indexIB: 0, flushProgrammablePending: () => events.push("submit"),
    });
});
afterEach(() => {
    for (const p of created) { resourceToDevice.delete(p); forgetComObject(p); }
    System.getInstance().process = oldProcess as never; Mem.bind(oldMem);
});
function buffer(kind: "vb" | "ib"): number {
    const p = createComObject(0x10000); created.push(p);
    resourceToDevice.set(p, adapter);
    adapter[kind + "Data"].set(p, { guestPtr: 0x18000, size: 64 });
    adapter[kind + "GpuBuffers"].set(p, { destroy: () => events.push("GPU destroy") });
    adapter[kind + "Dirty"].set(p, { start: 0, end: 64 });
    return p;
}
function release(p: number, kind: string): number {
    return api[`IDirect3D${kind === "vb" ? "Vertex" : "Index"}Buffer8_Release`]!({} as never, mem, [p]) as number;
}
for (const kind of ["vb", "ib"] as const) {
    test(`${kind}: final Release submits pending work before freeing GPU, guest and COM storage`, () => {
        const p = buffer(kind);
        if (kind === "vb") { adapter.streamSources[0].vb = p; adapter.streamSources[1].vb = p; }
        else adapter.indexIB = p;
        expect(addComRef(p)).toBe(2);
        expect(release(p, kind)).toBe(1); expect(events).toEqual([]);
        expect(adapter[kind + "Data"].has(p)).toBe(true);
        expect(release(p, kind)).toBe(0);
        expect(events).toEqual(["submit", "GPU destroy", "guest free", "COM free"]);
        expect(adapter[kind + "Data"].has(p)).toBe(false);
        expect(adapter[kind + "GpuBuffers"].has(p)).toBe(false);
        expect(adapter[kind + "Dirty"].has(p)).toBe(false);
        expect(resourceToDevice.has(p)).toBe(false);
        if (kind === "vb") expect(adapter.streamSources.map((s: any) => s.vb)).toEqual([0, 0]);
        else expect(adapter.indexIB).toBe(0);
        events.length = 0;
        expect(release(p, kind)).toBe(0); expect(events).toEqual([]);
    });
    test(`${kind}: repeated create/release leaves no live buffer bookkeeping`, () => {
        for (let i = 0; i < 50; i++) expect(release(buffer(kind), kind)).toBe(0);
        expect(adapter[kind + "Data"].size).toBe(0);
        expect(adapter[kind + "GpuBuffers"].size).toBe(0);
        expect(adapter[kind + "Dirty"].size).toBe(0);
        expect(events.filter(e => e === "GPU destroy").length).toBe(50);
    });
}
