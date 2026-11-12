import { afterEach, describe, expect, test } from "bun:test";
import { D3D9Device, d3d9BufferAlignment } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { IndexBufferStore, VertexBufferStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { System } from "../../src/worker/core/system";

const g = globalThis as { __d3d9BufferAlign?: number };

const MEM_SIZE = 0x40000000;
const realGetInstance = System.getInstance;

function deviceOverRealAllocator() {
    const mem = new Uint8Array(MEM_SIZE);
    const space = new AddressSpace(() => mem);
    space.initializeLayout(MEM_SIZE);
    const manager = new MemoryManager(space);
    manager.refreshLayoutBuckets();
    (System as unknown as { getInstance: () => unknown }).getInstance = () => ({
        process: { memory: manager, getCurrentMemory: () => mem },
    });
    return Object.assign(Object.create(D3D9Device.prototype), {
        role: "both",
        vertexBuffers: new VertexBufferStore(),
        indexBuffers: new IndexBufferStore(),
        writeCanary: () => {},
        dropBufferVersions: () => {},
        commandRecorder: { registerTemporaryBuffer: () => {} },
    }) as D3D9Device;
}

afterEach(() => {
    delete g.__d3d9BufferAlign;
    (System as unknown as { getInstance: unknown }).getInstance = realGetInstance;
});

describe("D3D9 vertex/index buffer guest storage alignment", () => {
    test("defaults to 16 bytes", () => {
        expect(d3d9BufferAlignment()).toBe(16);
    });

    test("8 and 32 are accepted, anything else falls back to 16", () => {
        g.__d3d9BufferAlign = 8;
        expect(d3d9BufferAlignment()).toBe(8);
        g.__d3d9BufferAlign = 32;
        expect(d3d9BufferAlignment()).toBe(32);
        for (const v of [0, 1, 4, 12, 24, 64, -16, NaN]) {
            g.__d3d9BufferAlign = v;
            expect(d3d9BufferAlignment()).toBe(16);
        }
    });

    test("createVertexBuffer and createIndexBuffer return 16-aligned pointers after odd-sized allocations", () => {
        const dev = deviceOverRealAllocator();
        const sizes = [1, 3, 13, 100, 4097, 7, 65, 31];
        let vb = 0x1000;
        let ib = 0x9000;
        for (const size of sizes) {
            const v = dev.createVertexBuffer(vb++, size, 0x112);
            const i = dev.createIndexBuffer(ib++, size, 101);
            expect(v).toBeGreaterThan(0);
            expect(i).toBeGreaterThan(0);
            expect(v % 16).toBe(0);
            expect(i % 16).toBe(0);
        }
    });

    test("pointers stay 16-aligned when freed blocks are reused", () => {
        const dev = deviceOverRealAllocator();
        const live: number[] = [];
        for (let n = 0; n < 24; n++) {
            live.push(dev.createVertexBuffer(0x2000 + n, 3 + n * 37, 0x112));
            dev.createIndexBuffer(0xa000 + n, 5 + n * 11, 101);
        }
        for (let n = 0; n < 24; n += 2) {
            dev.releaseVertexBuffer(0x2000 + n);
            dev.releaseIndexBuffer(0xa000 + n);
        }
        const reused: number[] = [];
        for (let n = 0; n < 24; n++) {
            const size = 1 + ((n * 53) % 400);
            reused.push(dev.createVertexBuffer(0x3000 + n, size, 0x112));
            reused.push(dev.createIndexBuffer(0xb000 + n, size, 101));
        }
        expect(reused.every((p) => p > 0 && p % 16 === 0)).toBe(true);
        const before = new Set(live);
        expect(reused.some((p) => before.has(p))).toBe(true);
    });
});
