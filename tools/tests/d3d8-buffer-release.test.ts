import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { D3D8DeviceAdapter } from "../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter";
import { createResourcesExports } from "../../src/worker/modules/d3d8/resources";
import { registerFastPathD3D8Functions } from "../../src/worker/modules/d3d8/fast-path";
import { KeyedStateBlockRecorder } from "../../src/worker/backends/webgpu/shared/state-block-recorder";
import { d3d8EntryKey, type D3D8StateBlockEntry } from "../../src/worker/backends/webgpu/d3d8/d3d8-state-block";
import { createComTripleStubs, createStateExports } from "../../src/worker/modules/d3d8/state";
import { createComObject, addComRef, getComRefCount, devices, resourceToDevice, forgetComObject } from "../../src/worker/modules/d3d8/shared-state";

const api = { ...createComTripleStubs(), ...createResourcesExports(), ...createStateExports() };
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
        stateBlockRecorder: new KeyedStateBlockRecorder<D3D8StateBlockEntry>(d3d8EntryKey),
        stateBlocks: new Map(), nextStateBlockToken: 1,
        indexIB: 0, baseVertexIndex: 0, flushProgrammablePending: () => events.push("submit"),
    });
});
afterEach(() => {
    devices.delete(0xabc);
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
        expect(release(p, kind)).toBe(1); expect(events).toEqual([]);
    });
    test(`${kind}: repeated create/release leaves no live buffer bookkeeping`, () => {
        for (let i = 0; i < 50; i++) expect(release(buffer(kind), kind)).toBe(0);
        expect(adapter[kind + "Data"].size).toBe(0);
        expect(adapter[kind + "GpuBuffers"].size).toBe(0);
        expect(adapter[kind + "Dirty"].size).toBe(0);
        expect(events.filter(e => e === "GPU destroy").length).toBe(50);
    });
}

function bind(kind: "vb" | "ib", ptr: number, stream = 0) {
    if (kind === "vb") adapter.setStreamSource(stream, ptr, 16);
    else adapter.setIndices(ptr, 7);
}
for (const kind of ["vb", "ib"] as const) {
    test(`${kind}: binding retains storage without adding a public COM reference`, () => {
        const p = buffer(kind);
        bind(kind, p); bind(kind, p);
        expect(getComRefCount(p)).toBe(1);
        expect(release(p, kind)).toBe(0);
        expect(adapter[kind + "Data"].has(p)).toBe(true);
        expect(kind === "vb" ? adapter.streamSources[0].vb : adapter.indexIB).toBe(p);
        expect(events).not.toContain("COM free");
        bind(kind, 0);
        expect(adapter[kind + "Data"].has(p)).toBe(false);
        expect(events.filter(e => e === "COM free")).toHaveLength(1);
    });
    test(`${kind}: replacement and Get recover a public reference from a bound buffer`, () => {
        const p = buffer(kind), q = buffer(kind);
        devices.set(0xabc, adapter);
        bind(kind, p); release(p, kind);
        const getter = kind === "vb" ? "GetStreamSource" : "GetIndices";
        const args = kind === "vb" ? [0xabc, 0, 0x100, 0x104] : [0xabc, 0x100, 0x104];
        expect(api["IDirect3DDevice8_" + getter]!({} as never, mem, args)).toBe(0);
        expect(Mem.readUint32(0x100)).toBe(p);
        expect(getComRefCount(p)).toBe(1);
        bind(kind, q);
        expect(adapter[kind + "Data"].has(p)).toBe(true);
        expect(release(p, kind)).toBe(0);
        expect(adapter[kind + "Data"].has(p)).toBe(false);
        bind(kind, 0); release(q, kind);
    });
    test(`${kind}: recorded state owns the buffer until delete, and Apply acquires binding ownership`, () => {
        const p = buffer(kind);
        adapter.beginStateBlock(); bind(kind, p);
        const token = adapter.endStateBlock().token;
        release(p, kind);
        expect(adapter[kind + "Data"].has(p)).toBe(true);
        expect(adapter.applyStateBlock(token)).toBe(0);
        expect(kind === "vb" ? adapter.streamSources[0].vb : adapter.indexIB).toBe(p);
        adapter.deleteStateBlock(token);
        expect(adapter[kind + "Data"].has(p)).toBe(true);
        bind(kind, 0);
        expect(adapter[kind + "Data"].has(p)).toBe(false);
    });
    test(`${kind}: recording dedup and Capture release replaced buffers without a leak`, () => {
        const p = buffer(kind), q = buffer(kind);
        adapter.beginStateBlock(); bind(kind, p); release(p, kind);
        bind(kind, q); bind(kind, q);
        expect(adapter[kind + "Data"].has(p)).toBe(false);
        const token = adapter.endStateBlock().token;
        release(q, kind);
        // Capture replaces the recorded binding with the currently unbound state.
        expect(adapter.captureStateBlock(token)).toBe(0);
        expect(adapter[kind + "Data"].has(q)).toBe(false);
        expect(adapter.deleteStateBlock(token)).toBe(0);
    });
    for (const tier of ["slow", "fast", "wbuf"] as const) {
        test(`${kind}: ${tier} binding/unbinding preserves lifetime`, () => {
            const p = buffer(kind);
            devices.set(0xabc, adapter);
            const fast = new Map<string, Function>(), wbuf = new Map<string, Function>();
            registerFastPathD3D8Functions({
                registerFastPath: (_dll: string, name: string, fn: Function) => fast.set(name, fn),
                registerWriteBufferFunction: (_dll: string, name: string, _argc: number, fn: Function) => wbuf.set(name, fn),
            } as never);
            const name = "IDirect3DDevice8_" + (kind === "vb" ? "SetStreamSource" : "SetIndices");
            const set = (ptr: number) => {
                const args = kind === "vb" ? [0xabc, 0, ptr, 16] : [0xabc, ptr, 7];
                args.forEach((n, i) => Mem.writeUint32(0x200 + i * 4, n));
                if (tier === "slow") expect(api[name]!({} as never, mem, args)).toBe(0);
                else if (tier === "fast") expect(fast.get(name)!(0x1fc, new DataView(mem.buffer), mem)).toBe(0);
                else wbuf.get(name)!(mem, new Uint32Array(mem.buffer), 0x200);
            };
            set(p); release(p, kind);
            expect(adapter[kind + "Data"].has(p)).toBe(true);
            set(0);
            expect(adapter[kind + "Data"].has(p)).toBe(false);
        });
    }
}
test("a buffer bound to multiple streams survives until the last binding is removed", () => {
    const p = buffer("vb");
    bind("vb", p, 0); bind("vb", p, 1); release(p, "vb");
    bind("vb", 0, 0);
    expect(adapter.vbData.has(p)).toBe(true);
    bind("vb", 0, 1);
    expect(adapter.vbData.has(p)).toBe(false);
});
test("device teardown drops active recording, state-block and binding references", () => {
    const vb = buffer("vb"), ib = buffer("ib");
    bind("vb", vb);
    adapter.beginStateBlock(); bind("ib", ib);
    adapter.endStateBlock();
    adapter.beginStateBlock(); bind("vb", vb);
    release(vb, "vb"); release(ib, "ib");
    adapter.clearBufferReferences();
    expect(adapter.vbData.size).toBe(0); expect(adapter.ibData.size).toBe(0);
    expect(events.filter(e => e === "COM free")).toHaveLength(2);
});
test("CreateStateBlock ALL retains captured buffers after unbinding and app Release", () => {
    Object.assign(adapter, {
        getRenderState: () => 0, getTextureStageState: () => 0, getTextureComPtr: () => 0,
        getPixelShaderHandle: () => 0, getActiveVertexToken: () => 0,
        getAllLights: () => [], getEnabledLightIndices: () => [], getAllTransforms: () => [],
        getAllClipPlanes: () => [], getMaterial: () => ({}),
        shaders: { psConstants: new Float32Array(32), vsConstants: new Float32Array(96) },
        viewport: { x: 0, y: 0, width: 10, height: 10, minZ: 0, maxZ: 1 },
    });
    const vb = buffer("vb"), ib = buffer("ib");
    bind("vb", vb); bind("ib", ib);
    const result = adapter.createStateBlock(1);
    expect(result.hr).toBe(0);
    bind("vb", 0); bind("ib", 0);
    release(vb, "vb"); release(ib, "ib");
    expect(adapter.vbData.has(vb)).toBe(true); expect(adapter.ibData.has(ib)).toBe(true);
    adapter.deleteStateBlock(result.token);
    expect(adapter.vbData.size).toBe(0); expect(adapter.ibData.size).toBe(0);
});
test("multiple state blocks keep a shared buffer alive until the last block is deleted", () => {
    const p = buffer("vb");
    adapter.beginStateBlock(); bind("vb", p); const first = adapter.endStateBlock().token;
    adapter.beginStateBlock(); bind("vb", p); const second = adapter.endStateBlock().token;
    release(p, "vb");
    adapter.deleteStateBlock(first);
    expect(adapter.vbData.has(p)).toBe(true);
    adapter.deleteStateBlock(second);
    expect(adapter.vbData.has(p)).toBe(false);
});
