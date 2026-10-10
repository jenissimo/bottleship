import { afterEach, describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { System } from "../../src/worker/core/system";
import { createVolumeTextureResource, volumeTextureResources } from "../../src/worker/modules/d3d9/volume-resources";
import { attachD3D9Split, d3d9SplitFlush, d3d9SplitStats, resetD3D9SplitStreamForTests } from "../../src/worker/modules/d3d9/split";

const sys = System.getInstance() as any;
const savedProcess = sys.process;
const savedUsage = globalThis.GPUTextureUsage;
const PTR = 0x1000;
type Upload = { level: number; z: number; bytes: number[] };

afterEach(() => {
    sys.process = savedProcess;
    (globalThis as any).GPUTextureUsage = savedUsage;
    volumeTextureResources.clear();
    resetD3D9SplitStreamForTests();
});

function device(uploads: Upload[]): any {
    const d = Object.create(D3D9Device.prototype);
    Object.assign(d, {
        role: "both", isExtended: false, volumeByPointer: new Map(), volumeByIndex: new Map(),
        nextVolumeIndex: -1, arenaSamplerBankGeneration: 0,
        stateTracker: { getTexture: () => null },
        backend: {
            getDevice: () => ({ createTexture: () => ({ createView: () => ({}), destroy: () => {} }) }),
            getQueue: () => ({ writeTexture: (target: any, bytes: Uint8Array, layout: any, size: any) => {
                const tight: number[] = [];
                for (let row = 0; row < size.height; row++) {
                    tight.push(...bytes.subarray(row * layout.bytesPerRow, row * layout.bytesPerRow + size.width * 4));
                }
                uploads.push({ level: target.mipLevel, z: target.origin.z, bytes: tight });
            } }),
        },
    });
    return d;
}

function resource(memory: Uint8Array, width = 4, height = 4, depth = 3, levels = 3) {
    let ptr = 0x2000;
    const r = createVolumeTextureResource(width, height, depth, levels, 0, 1, 21, {
        alloc: bytes => { const start = ptr; ptr += bytes; return start; }, free: () => {},
    })!;
    for (let level = 0; level < r.levels; level++) {
        const mip = r.levelData[level]!;
        for (let i = 0; i < mip.bytes; i += 4) {
            memory.set([level + 1, (i / 4) % 256, 37, 255], mip.ptr + i);
        }
    }
    volumeTextureResources.set(PTR, r);
    sys.process = { getCurrentMemory: () => memory, addressSpace: { validateRange: () => true } };
    (globalThis as any).GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2, COPY_SRC: 1 };
    return r;
}

function stream(front: any, twin: any) {
    let handler: (mem: Uint8Array, words: Uint32Array, ptr: number) => void;
    let client: any;
    const packets: Uint8Array[] = [];
    const dispatcher = {
        registerQueuePayloadHandler: (h: typeof handler) => { handler = h; return 16300; },
        enqueuePayloadById: (_id: number, method: number, slot: number, h2: number, h3: number,
            src: Uint8Array, off: number, size: number) => {
            const bytes = new Uint8Array(20 + Math.ceil(size / 4) * 4);
            new Uint32Array(bytes.buffer).set([method, slot, h2, h3, size]);
            bytes.set(src.subarray(off, off + size), 20);
            packets.push(bytes);
            return true;
        },
        executeWbufQueue: () => {
            const original = volumeTextureResources.get(PTR);
            volumeTextureResources.delete(PTR);
            client.replayBegin();
            try {
                for (const packet of packets.splice(0)) handler(packet, new Uint32Array(packet.buffer), 0);
            } finally {
                client.replayEnd();
                if (original) volumeTextureResources.set(PTR, original);
            }
        },
        setWbufSplitClient: (c: any) => { client = c; },
    };
    attachD3D9Split(front, twin, dispatcher, null);
    Object.defineProperty(twin, "memory", { get: () => { throw new Error("render worker borrowed guest RAM"); } });
    return packets;
}

describe("D3D9 volume textures across the split stream", () => {
    test("all mip slices match direct uploads, preserving bytes at registration and dirty publication", () => {
        const memory = new Uint8Array(0x10000);
        const r = resource(memory);
        const directUploads: Upload[] = [], splitUploads: Upload[] = [];
        const direct = device(directUploads), front = device([]), twin = device(splitUploads);
        expect(direct.registerVolumeTexture(PTR)).toBe(true);
        direct.ensureVolumeTexture(-1);
        stream(front, twin);
        expect(front.registerVolumeTexture(PTR)).toBe(true);
        memory.fill(99, r.levelData[0]!.ptr, r.levelData[0]!.ptr + r.levelData[0]!.bytes);
        d3d9SplitFlush();
        twin.ensureVolumeTexture(-1);
        expect(splitUploads).toEqual(directUploads);
        expect(splitUploads).toHaveLength(5);
        expect(splitUploads[0]!.bytes.slice(0, 4)).toEqual([37, 0, 1, 255]);

        directUploads.length = 0; splitUploads.length = 0;
        const mip = r.levelData[1]!;
        memory.fill(17, mip.ptr, mip.ptr + mip.bytes);
        direct.markVolumeTextureDirty(PTR);
        direct.ensureVolumeTexture(-1);
        front.markVolumeTextureDirty(PTR);
        memory.fill(201, mip.ptr, mip.ptr + mip.bytes);
        d3d9SplitFlush();
        twin.ensureVolumeTexture(-1);
        expect(splitUploads).toEqual(directUploads);
        expect(splitUploads.find(x => x.level === 1)!.bytes.every(x => x === 17)).toBe(true);
        const stats = d3d9SplitStats()!;
        expect(stats.recorded).toBe(8);
        expect(stats.replayed).toBe(8);
        expect(stats.divergences).toEqual({});
        expect(stats.replayErrors).toEqual({});
        front.releaseVolumeTexture(PTR);
        d3d9SplitFlush();
        expect(twin.volumeByIndex.size).toBe(0);
        expect(twin.volumeByPointer.size).toBe(0);
    });

    test("large mip publication sends every byte in bounded chunks", () => {
        const memory = new Uint8Array(9 * 1024 * 1024);
        const r = resource(memory, 129, 128, 128, 1);
        const mip = r.levelData[0]!;
        memory.fill(113, mip.ptr, mip.ptr + mip.bytes);
        const front = device([]), twin = device([]);
        const packets = stream(front, twin);
        expect(front.registerVolumeTexture(PTR)).toBe(true);
        expect(packets).toHaveLength(4);
        expect(Math.max(...packets.map(p => p.length))).toBeLessThan(5 * 1024 * 1024);
        d3d9SplitFlush();
        const data = twin.volumeByIndex.get(-1).shadow.data[0] as Uint8Array;
        let sum = 0;
        for (const byte of data) sum += byte;
        expect(data.length).toBe(129 * 128 * 128 * 4);
        expect(sum).toBe(113 * 129 * 128 * 128 * 4);
        expect(d3d9SplitStats()!.recorded).toBe(4);
        expect(d3d9SplitStats()!.replayed).toBe(4);
        expect(d3d9SplitStats()!.divergences).toEqual({});
    });
});
