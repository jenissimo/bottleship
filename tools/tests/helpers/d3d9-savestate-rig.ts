import { System } from "../../../src/worker/core/system";
import { Mem } from "../../../src/worker/core/memory/mem-accessor";
import type { ThunkImplementation } from "../../../src/worker/core/thunking/thunk-dispatcher";
import { createDeviceExports } from "../../../src/worker/modules/d3d9/device";
import { createStateExports } from "../../../src/worker/modules/d3d9/state";
import { createResourcesExports } from "../../../src/worker/modules/d3d9/resources";
import { createSwapChainExports } from "../../../src/worker/modules/d3d9/swapchain";
import { createVolumeExports } from "../../../src/worker/modules/d3d9/volume";
import { createQueryExports } from "../../../src/worker/modules/d3d9/query";
import { createFactoryExports } from "../../../src/worker/modules/d3d9/factory";
import { createExExports } from "../../../src/worker/modules/d3d9/ex";
import { createShaderValidatorExports } from "../../../src/worker/modules/d3d9/shader-validator";
import { devices, restoreVTables, resetD3D9SharedState } from "../../../src/worker/modules/d3d9/shared-state";
import { resetSwapChainRegistry } from "../../../src/worker/modules/d3d9/swapchain";
import { savestateParticipants, type Participant } from "../../../src/worker/savestate/participant";
import { newObjectGraph, restoreObjectGraph, type ObjectGraph } from "../../../src/worker/savestate/object-codecs";
import { decodeValue, encodeValue, type SaveValue } from "../../../src/worker/savestate/value-codec";
import { registerD3D9Participant } from "../../../src/worker/modules/d3d9/savestate";
import { resetComMemory } from "../../../src/worker/core/com/com-memory";
import { D3D9Device } from "../../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { setD3D9VolumeCapabilityContract } from "../../../src/worker/backends/webgpu/shared/volume-policy";
import { d3d9SplitFlush, resetD3D9SplitStreamForTests } from "../../../src/worker/modules/d3d9/split";
import { afterAll } from "bun:test";
import { preserveGlobals, useWebGpuFlags } from "./scoped-globals";

export const IFACE_NAMES = [
    "IDirect3D9", "IDirect3D9Ex", "IDirect3DDevice9", "IDirect3DDevice9Ex", "IDirect3DSwapChain9", "IDirect3DSurface9",
    "IDirect3DTexture9", "IDirect3DCubeTexture9", "IDirect3DVolumeTexture9", "IDirect3DVolume9", "IDirect3DVertexBuffer9",
    "IDirect3DIndexBuffer9", "IDirect3DVertexShader9", "IDirect3DPixelShader9", "IDirect3DVertexDeclaration9",
    "IDirect3DStateBlock9", "IDirect3DQuery9", "IDirect3DShaderValidator9",
] as const;

export const FAKE_VTABLES: Array<[string, number, number]> = IFACE_NAMES.map((name, i) => [name, 0x1000 + i * 0x100, 16]);

export function scopeRigToFile(): void {
    useWebGpuFlags("GPUBufferUsage", "GPUTextureUsage", "GPUMapMode");
    preserveGlobals("__savestates", "__d3d9Split", "__d3d9SplitWorker", "__d3d9InternalBindingRefs", "__d3d9MirrorRefcount");
    const system = System.getInstance();
    const process = system.process;
    const backend = system.services.render.getBackend();
    const active = system.services.render.getActive();
    const mem = Mem as unknown as Record<string, unknown>;
    const binding = ["memoryGetter", "validateRange", "getRegion", "dataRoutes"].map(k => [k, mem[k]] as const);
    afterAll(() => {
        resetD3D9SharedState();
        resetSwapChainRegistry();
        resetComMemory();
        resetD3D9SplitStreamForTests();
        setD3D9VolumeCapabilityContract(null);
        system.process = process;
        system.services.render.setBackend(backend as never);
        system.services.render.setActive(active as never);
        for (const [k, v] of binding) mem[k] = v;
    });
}

export interface FakeTexture {
    width: number;
    height: number;
    layers: number;
    format: string;
    mipLevelCount: number;
    data: Uint8Array;
    destroyed: boolean;
    createView(): object;
    destroy(): void;
}

export interface FakeBuffer {
    size: number;
    usage: number;
    data: Uint8Array;
    destroyed: boolean;
    mapAsync(): Promise<void>;
    getMappedRange(): ArrayBuffer;
    unmap(): void;
    destroy(): void;
}

export class FakeGpu {
    textures: FakeTexture[] = [];
    buffers: FakeBuffer[] = [];
    writes: Array<{ texture: FakeTexture; width: number; height: number }> = [];
    lost = false;
    failMap = false;
    readonly limits = { maxTextureDimension2D: 8192, maxBufferSize: 1 << 28 };

    readonly device = {
        limits: this.limits,
        createTexture: (desc: { size: { width: number; height: number; depthOrArrayLayers?: number }; format: string; mipLevelCount?: number }): FakeTexture => {
            const layers = desc.size.depthOrArrayLayers ?? 1;
            const t: FakeTexture = {
                width: desc.size.width, height: desc.size.height, layers, format: desc.format,
                mipLevelCount: desc.mipLevelCount ?? 1,
                data: new Uint8Array(desc.size.width * desc.size.height * layers * 4), destroyed: false,
                createView: () => ({}),
                destroy: () => { t.destroyed = true; },
            };
            this.textures.push(t);
            return t;
        },
        createBuffer: (desc: { size: number; usage: number }): FakeBuffer => {
            const b: FakeBuffer = {
                size: desc.size, usage: desc.usage, data: new Uint8Array(desc.size), destroyed: false,
                mapAsync: async () => { if (this.failMap) throw new Error("the GPU device was lost during the readback"); },
                getMappedRange: () => b.data.buffer as ArrayBuffer,
                unmap: () => undefined,
                destroy: () => { b.destroyed = true; },
            };
            this.buffers.push(b);
            return b;
        },
        createCommandEncoder: () => ({
            copyTextureToBuffer: (
                src: { texture: FakeTexture; origin?: { z?: number } },
                dst: { buffer: FakeBuffer; bytesPerRow: number },
                size: { width: number; height: number },
            ) => {
                const layer = src.origin?.z ?? 0;
                const plane = src.texture.width * src.texture.height * 4;
                for (let y = 0; y < size.height; y++) {
                    const from = layer * plane + y * src.texture.width * 4;
                    dst.buffer.data.set(src.texture.data.subarray(from, from + size.width * 4), y * dst.bytesPerRow);
                }
            },
            finish: () => ({}),
        }),
    };

    readonly queue = {
        writeTexture: (
            dst: { texture: FakeTexture; origin?: { z?: number } },
            data: Uint8Array,
            layout: { bytesPerRow: number },
            size: { width: number; height: number },
        ) => {
            const layer = dst.origin?.z ?? 0;
            const plane = dst.texture.width * dst.texture.height * 4;
            for (let y = 0; y < size.height; y++) {
                const to = layer * plane + y * dst.texture.width * 4;
                dst.texture.data.set(data.subarray(y * layout.bytesPerRow, y * layout.bytesPerRow + size.width * 4), to);
            }
            this.writes.push({ texture: dst.texture, width: size.width, height: size.height });
        },
        writeBuffer: (buffer: FakeBuffer, offset: number, data: Uint8Array) => { buffer.data.set(data, offset); },
        submit: () => undefined,
        onSubmittedWorkDone: async () => undefined,
    };

    liveTextures(): number {
        return this.textures.filter(t => !t.destroyed).length;
    }

    liveBuffers(): number {
        return this.buffers.filter(b => !b.destroyed).length;
    }

    backend() {
        return {
            kind: "webgpu",
            initialize: async () => undefined,
            getDevice: () => (this.lost ? null : this.device),
            getQueue: () => (this.lost ? null : this.queue),
            getFormat: () => "bgra8unorm",
            getContext: () => ({ canvas: { width: 640, height: 480 } }),
            getScreenCanvas: () => null,
        };
    }
}

export interface Rig {
    mem: Uint8Array;
    gpu: FakeGpu;
    exports: Record<string, ThunkImplementation>;
    allocator: { next: number };
    participant: Participant;
    devicePtr: number;
    device: D3D9Device;
    call(name: string, ...args: number[]): number | Promise<number>;
    u32(addr: number): number;
    off(): void;
}

const OUT = 0x300;
const PRESENT_PARAMS = 0x400;

export function writePresentParams(mem: Uint8Array, at: number, w: number, h: number, depth = false): void {
    const dv = new DataView(mem.buffer);
    mem.fill(0, at, at + 56);
    dv.setUint32(at + 0, w, true);
    dv.setUint32(at + 4, h, true);
    dv.setUint32(at + 8, 22, true);
    dv.setUint32(at + 12, 1, true);
    dv.setUint32(at + 24, 1, true);
    dv.setUint32(at + 28, 0x5000, true);
    dv.setUint32(at + 32, 1, true);
    dv.setUint32(at + 36, depth ? 1 : 0, true);
    dv.setUint32(at + 40, depth ? 75 : 0, true);
}

export function assembleExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    for (const part of [
        createFactoryExports(), createDeviceExports(), createStateExports(), createResourcesExports(), createSwapChainExports(),
        createVolumeExports(), createQueryExports(), createShaderValidatorExports(),
    ]) Object.assign(exports, part);
    Object.assign(exports, createExExports(exports));
    return exports;
}

export function fakeSplitDispatcher(): { packets: Uint8Array[]; dispatcher: object } {
    let handler: ((mem: Uint8Array, words: Uint32Array, ptr: number) => void) | null = null;
    let client: { replayBegin(): void; replayEnd(): void } | null = null;
    const packets: Uint8Array[] = [];
    const dispatcher = {
        registerQueuePayloadHandler: (h: typeof handler) => { handler = h; return 16300; },
        enqueuePayloadById: (_id: number, method: number, slot: number, h2: number, h3: number,
            src: Uint8Array, off: number, head: number, tail: Uint8Array | null = null) => {
            const size = head + (tail ? tail.length : 0);
            const bytes = new Uint8Array(20 + Math.ceil(size / 4) * 4);
            new Uint32Array(bytes.buffer).set([method, slot, h2, h3, size]);
            bytes.set(src.subarray(off, off + head), 20);
            if (tail) bytes.set(tail, 20 + head);
            packets.push(bytes);
            return true;
        },
        executeWbufQueue: () => {
            client!.replayBegin();
            try {
                for (const packet of packets.splice(0)) handler!(packet, new Uint32Array(packet.buffer), 0);
            } finally {
                client!.replayEnd();
            }
        },
        setWbufSplitClient: (c: typeof client) => { client = c; },
    };
    return { packets, dispatcher };
}

export function forbidTwinRam(device: D3D9Device): void {
    const twin = device.renderTwin;
    if (twin) Object.defineProperty(twin, "memory", { get: () => { throw new Error("the render twin read guest RAM"); } });
}

export function installProcess(mem: Uint8Array, allocator: { next: number }, gpu: FakeGpu, split = false): void {
    const system = System.getInstance();
    const bump = (size: number, align = 16): number => {
        allocator.next = (allocator.next + align - 1) & ~(align - 1);
        const at = allocator.next;
        allocator.next += Math.max(16, size);
        return at;
    };
    system.process = {
        memory: {
            alloc: (size: number, _tag?: string, _x?: unknown, alignment?: number) => bump(size, alignment ?? 16),
            free: () => undefined,
            allocSystemBlock: (size: number) => bump(size, 16),
            freeSystemBlock: () => undefined,
        },
        getCurrentMemory: () => mem,
        canvas: {},
        getModule: () => undefined,
        dispatcher: split ? fakeSplitDispatcher().dispatcher : undefined,
    } as never;
    Mem.bind(() => mem, (address, size) => address >= 0 && address + size <= mem.length);
    system.services.render.setBackend(gpu.backend() as never);
}

/** @transient(test switch: the whole suite of a file runs with split devices when set) */
let splitByDefault = false;
export function runRigsSplit(on: boolean): void { splitByDefault = on; }


export async function makeRig(opts: { mem?: Uint8Array; allocator?: { next: number }; gpu?: FakeGpu; device?: boolean; split?: boolean; depth?: boolean } = {}): Promise<Rig> {
    const split = opts.split ?? splitByDefault;
    (globalThis as { __savestates?: boolean }).__savestates = true;
    (globalThis as { __d3d9Split?: boolean }).__d3d9Split = split;
    (globalThis as { __d3d9SplitWorker?: boolean }).__d3d9SplitWorker = false;
    if (!opts.mem) resetD3D9SplitStreamForTests();
    const mem = opts.mem ?? new Uint8Array(1 << 22);
    if (!opts.mem) {
        resetD3D9SharedState();
        resetSwapChainRegistry();
    }
    const allocator = opts.allocator ?? { next: 0x10000 };
    const gpu = opts.gpu ?? new FakeGpu();
    installProcess(mem, allocator, gpu, split);
    setD3D9VolumeCapabilityContract({
        supportsTexture3D: () => true, maxExtent: 2048, filterCaps: 0x100, addressCaps: 0x1, supportsAutoGenMipmaps: () => true,
    } as never);
    restoreVTables(FAKE_VTABLES);
    const exports = assembleExports();
    const unregister = registerD3D9Participant();
    const off = (): void => {
        unregister();
        setD3D9VolumeCapabilityContract(null);
    };
    const participant = savestateParticipants.all().find(p => p.id === "d3d9")!;
    const dv = new DataView(mem.buffer);
    const rig: Rig = {
        mem, gpu, exports, allocator, participant, devicePtr: 0, device: undefined as never, off,
        call: (name, ...args) => exports[name]!({ esp: 0x2000 } as never, mem, args as never) as number | Promise<number>,
        u32: (addr) => dv.getUint32(addr, true),
    };
    if (opts.device !== false) {
        const parent = await rig.call("Direct3DCreate9", 32) as number;
        writePresentParams(mem, PRESENT_PARAMS, 64, 48, opts.depth === true);
        const hr = await rig.call("IDirect3D9_CreateDevice", parent, 0, 1, 0x5000, 0x40, PRESENT_PARAMS, OUT);
        if (hr !== 0) throw new Error(`CreateDevice failed with 0x${(hr >>> 0).toString(16)}`);
        rig.devicePtr = dv.getUint32(OUT, true);
        rig.device = devices.get(rig.devicePtr)!;
        forbidTwinRam(rig.device);
    }
    return rig;
}

export function throughCodec(v: SaveValue): SaveValue {
    return decodeValue(encodeValue(v));
}

export function bytes(v: unknown): string {
    const e = encodeValue(v as SaveValue);
    return JSON.stringify({ json: e.json, blobs: e.blobs.map(b => [...b]) });
}

export async function capture(rig: Rig, graph: ObjectGraph = newObjectGraph()): Promise<{ saved: SaveValue; graph: ObjectGraph }> {
    await rig.participant.prepare?.();
    const saved = rig.participant.capture(graph as never);
    return { saved: throughCodec(saved), graph };
}

export async function restoreInto(rig: Rig, saved: SaveValue, graph: ObjectGraph): Promise<void> {
    const ctx = restoreObjectGraph([], graph.blobs);
    const value = throughCodec(saved);
    await rig.participant.verify?.(value, (hash) => ctx.blob(hash));
    await rig.participant.restore(value, ctx);
    rig.device = devices.get(rig.devicePtr) ?? rig.device;
    forbidTwinRam(rig.device);
}

export function freshWorker(rig: Rig, ram: Uint8Array): void {
    resetD3D9SharedState();
    d3d9SplitFlush();
    resetSwapChainRegistry();
    resetComMemory();
    rig.mem.set(ram);
    if ((globalThis as { __d3d9Split?: boolean }).__d3d9Split === true) {
        resetD3D9SplitStreamForTests();
        (System.getInstance().process as unknown as { dispatcher: object }).dispatcher = fakeSplitDispatcher().dispatcher;
    }
}

export function snapshotRam(rig: Rig): Uint8Array {
    return rig.mem.slice();
}

export const OUT_ADDR = OUT;
