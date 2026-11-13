import { describe, expect, test } from "bun:test";
import { RingBufferManager } from "../../src/worker/backends/webgpu/ddraw/ring-buffer-manager";
import { useWebGpuFlags } from "./helpers/scoped-globals";

useWebGpuFlags("GPUBufferUsage");

const STRIDE = 64;
const TRIANGLELIST = 4, TRIANGLESTRIP = 5, TRIANGLEFAN = 6;

interface FakeBuffer { id: number; size: number; bytes: Uint8Array; destroy(): void }

function fakeGpu() {
    let next = 1;
    const device = {
        limits: { minUniformBufferOffsetAlignment: 256 },
        createBuffer(desc: { size: number }): FakeBuffer {
            return { id: next++, size: desc.size, bytes: new Uint8Array(desc.size), destroy() { /* fake */ } };
        },
    };
    const queue = {
        writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBufferLike, dataOffset = 0, size?: number) {
            buffer.bytes.set(new Uint8Array(data as ArrayBuffer, dataOffset, size ?? (data.byteLength - dataOffset)), offset);
        },
    };
    return { device: device as unknown as GPUDevice, queue: queue as unknown as GPUQueue, newBuffer: (size: number) => device.createBuffer({ size }) };
}

/** Vertex data whose every vertex carries its own tag in its first byte. */
function vertices(count: number, tag: number): Uint8Array {
    const d = new Uint8Array(count * STRIDE);
    for (let i = 0; i < count; i++) d[i * STRIDE] = (tag + i) & 0xff;
    return d;
}

interface Draw { firstVertex: number; vertexCount: number; drawIndex: number; vertexBufferOffset?: number; vertexBufferSize?: number }
type Call = ["setVertexBuffer", FakeBuffer, number, number] | ["draw", number, number, number, number] | ["setBindGroup" | "setPipeline" | "setStencilReference", unknown];

function rig(skipMinIdx = 0) {
    const calls: Call[] = [];
    const stats = { batches: 0, batchedDraws: 0, megaDrawsEncoded: 0, vertexRangeBinds: 0 };
    let passes = 0;
    return import("../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor").then(async ({ DDrawWebGPUExecutor }) => {
        const { setAuthorityGpu } = await import("../../src/worker/modules/ddraw/surface-sync");
        const target = {
            surfaceType: "render_surface", width: 4, height: 2, pitch: 16, caps: 0, surfacePtr: 0, attachedSurfaceAddr: 0,
            format: { flags: 0x41, bpp: 32 }, mode: "GPU_ONLY", version: 0, gpuDirty: false, everLocked: false, lastUploadVersion: 0, writeGeneration: 0,
        };
        setAuthorityGpu(target as never);
        const ex = Object.create(DDrawWebGPUExecutor.prototype) as Record<string, unknown>;
        const fields: Record<string, unknown> = {
            debugFlags: skipMinIdx ? { skipMegaBatchDrawsRender: true, skipMegaBatchMinIdx: skipMinIdx } : {},
            opLogArmed: 0, renderStats: stats,
            opLog: () => {},
            ringBufferManager: { flushStorageBuffer: () => {} },
            ensureRenderPass: () => {
                passes++;
                ex.currentRenderPass = {
                    setPipeline: (p: unknown) => calls.push(["setPipeline", p]),
                    setStencilReference: (r: unknown) => calls.push(["setStencilReference", r]),
                    setBindGroup: (_i: number, g: unknown) => calls.push(["setBindGroup", g]),
                    setVertexBuffer: (_slot: number, b: FakeBuffer, off = 0, size?: number) => calls.push(["setVertexBuffer", b, off, size ?? b.size - off]),
                    draw: (vc: number, ic = 1, fv = 0, fi = 0) => calls.push(["draw", vc, ic, fv, fi]),
                };
            },
            resetBindFastPath: () => {}, currentRenderPass: null, currentBatch: null,
        };
        for (const [k, v] of Object.entries(fields)) Object.defineProperty(ex, k, { value: v, writable: true, configurable: true });
        const flush = (buffer: FakeBuffer, draws: Draw[], primitiveType = TRIANGLELIST) => {
            ex.currentBatch = {
                useMegaBatch: true, megaBatchBindGroup: { bg: 1 }, pipeline: {}, stencilRef: 0, target, viewport: {},
                vertexBuffer: buffer, vertexSize: STRIDE, primitiveType, draws,
            };
            (ex as unknown as { flushBatch(): void }).flushBatch.call(ex);
        };
        return { calls, stats, flush, passes: () => passes };
    });
}

/** What the GPU fetches: for every encoded draw, its instance and the tag of each vertex it reads. Throws on a read outside the bound range. */
function execute(calls: Call[]): Array<{ instance: number; tags: number[] }> {
    let bound: { b: FakeBuffer; off: number; size: number } | null = null;
    const out: Array<{ instance: number; tags: number[] }> = [];
    for (const c of calls) {
        if (c[0] === "setVertexBuffer") bound = { b: c[1], off: c[2], size: c[3] };
        if (c[0] !== "draw") continue;
        const [, vc, ic, fv, fi] = c;
        expect(ic).toBe(1);
        expect(Number.isInteger(fv)).toBe(true);
        const tags: number[] = [];
        for (let i = 0; i < vc; i++) {
            const at = (fv + i) * STRIDE;
            if (!bound || at < 0 || at + STRIDE > bound.size) throw new Error(`vertex ${fv + i} outside the bound range`);
            tags.push(bound.b.bytes[bound.off + at]!);
        }
        out.push({ instance: fi, tags });
    }
    return out;
}

/** The existing path's output: each draw reads exactly its own allocation. */
function expected(buffer: FakeBuffer, draws: Draw[]): Array<{ instance: number; tags: number[] }> {
    return draws.filter(d => d.vertexCount > 0).map(d => {
        const off = d.vertexBufferOffset ?? d.firstVertex * STRIDE;
        return { instance: d.drawIndex, tags: Array.from({ length: d.vertexCount }, (_, i) => buffer.bytes[off + i * STRIDE]!) };
    });
}

const vbBinds = (calls: Call[]) => calls.filter(c => c[0] === "setVertexBuffer") as Array<["setVertexBuffer", FakeBuffer, number, number]>;
const drawsOf = (calls: Call[]) => calls.filter(c => c[0] === "draw") as Array<["draw", number, number, number, number]>;

/** Allocate through the real ring, the way drawPrimitive's CPU path does. */
function cpuDraws(rbm: RingBufferManager, counts: number[], firstIndex: number, between?: (i: number) => void): Draw[] {
    return counts.map((n, i) => {
        between?.(i);
        const data = vertices(n, 16 * (i + 1));
        const a = rbm.allocateVertexData(data);
        return { firstVertex: a.offset / STRIDE, vertexCount: n, drawIndex: firstIndex + i, vertexBufferOffset: a.offset, vertexBufferSize: data.length };
    });
}

describe("non-indexed MegaBatch binds one vertex range for all its draws", () => {
    test("nonzero start, mixed sizes and gaps from other allocations: one bind, same fetched vertices and instances", async () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue);
        rbm.allocateVertexData(vertices(5, 200));
        const draws = cpuDraws(rbm, [3, 6, 4, 12, 3], 7, i => { if (i === 2) rbm.allocateVertexData(vertices(9, 100)); });
        rbm.flushGeometry();
        const buffer = draws.length ? (rbm as unknown as { vertexRingBuffers: FakeBuffer[] }).vertexRingBuffers[(rbm as unknown as { currentFrameIndex: number }).currentFrameIndex]! : null!;
        const r = await rig();
        r.flush(buffer, draws);
        const binds = vbBinds(r.calls);
        expect(binds).toHaveLength(1);
        expect(binds[0]![2]).toBe(5 * STRIDE);
        const last = draws.at(-1)!;
        expect(binds[0]![3]).toBe(last.vertexBufferOffset! + last.vertexBufferSize! - 5 * STRIDE);
        expect(drawsOf(r.calls).map(d => d[3])).toEqual(draws.map(d => (d.vertexBufferOffset! - 5 * STRIDE) / STRIDE));
        expect(execute(r.calls)).toEqual(expected(buffer, draws));
        expect(r.stats.vertexRangeBinds).toBe(1);
        expect(r.stats.megaDrawsEncoded).toBe(draws.length);
        expect(r.stats.batchedDraws).toBe(draws.length);
    });

    test("triangle list, strip and fan-expanded batches fetch exactly what the per-draw path fetched", async () => {
        for (const [prim, counts] of [[TRIANGLELIST, [3, 6, 9]], [TRIANGLESTRIP, [4, 5, 8]], [TRIANGLEFAN, [3, 6, 12]]] as const) {
            const { device, queue } = fakeGpu();
            const rbm = new RingBufferManager(device, queue);
            rbm.allocateVertexData(vertices(1, 1));
            const draws = cpuDraws(rbm, [...counts], 3);
            rbm.flushGeometry();
            const buffer = (rbm as unknown as { vertexRingBuffers: FakeBuffer[] }).vertexRingBuffers[0]!;
            const r = await rig();
            r.flush(buffer, draws, prim);
            expect(vbBinds(r.calls)).toHaveLength(1);
            expect(execute(r.calls)).toEqual(expected(buffer, draws));
        }
    });

    test("GPU-converted offsets (whole-vertex steps in their own buffer) take the one-range path too", async () => {
        const { newBuffer } = fakeGpu();
        const buffer = newBuffer(64 * 64);
        const draws: Draw[] = [];
        let at = 2 * STRIDE;
        for (const [i, n] of [5, 3, 7].entries()) {
            buffer.bytes.set(vertices(n, 40 * (i + 1)), at);
            draws.push({ firstVertex: at / STRIDE, vertexCount: n, drawIndex: i, vertexBufferOffset: at, vertexBufferSize: n * STRIDE });
            at += Math.ceil((n * STRIDE) / STRIDE) * STRIDE;
        }
        const r = await rig();
        r.flush(buffer, draws);
        expect(vbBinds(r.calls)).toEqual([["setVertexBuffer", buffer, 2 * STRIDE, 15 * STRIDE]]);
        expect(execute(r.calls)).toEqual(expected(buffer, draws));
    });

    test("an offset that is not a whole vertex from the others keeps one binding per draw", async () => {
        const { device, queue } = fakeGpu();
        const rbm = new RingBufferManager(device, queue);
        const draws = cpuDraws(rbm, [3, 3, 3], 0, i => { if (i === 1) rbm.allocateVertexData(new Uint8Array(36)); });
        rbm.flushGeometry();
        const buffer = (rbm as unknown as { vertexRingBuffers: FakeBuffer[] }).vertexRingBuffers[0]!;
        expect((draws[1]!.vertexBufferOffset! - draws[0]!.vertexBufferOffset!) % STRIDE).not.toBe(0);
        const r = await rig();
        r.flush(buffer, draws);
        expect(vbBinds(r.calls).map(b => [b[2], b[3]])).toEqual(draws.map(d => [d.vertexBufferOffset, d.vertexBufferSize]));
        expect(drawsOf(r.calls).every(d => d[3] === 0)).toBe(true);
        expect(execute(r.calls)).toEqual(expected(buffer, draws));
        expect(r.stats.vertexRangeBinds).toBe(0);
    });

    test("a draw that reads past its own allocation keeps one binding per draw", async () => {
        const { newBuffer } = fakeGpu();
        const buffer = newBuffer(64 * 32);
        const draws: Draw[] = [
            { firstVertex: 0, vertexCount: 3, drawIndex: 0, vertexBufferOffset: 0, vertexBufferSize: 3 * STRIDE },
            { firstVertex: 3, vertexCount: 6, drawIndex: 1, vertexBufferOffset: 3 * STRIDE, vertexBufferSize: 3 * STRIDE },
        ];
        const r = await rig();
        r.flush(buffer, draws);
        expect(vbBinds(r.calls)).toHaveLength(2);
        expect(r.stats.vertexRangeBinds).toBe(0);
    });

    test("offsets that wrap below the first draw bind from the lowest one", async () => {
        const { newBuffer } = fakeGpu();
        const buffer = newBuffer(64 * 64);
        const place = [[40, 4], [2, 3], [20, 6]] as const;
        const draws: Draw[] = place.map(([v, n], i) => {
            buffer.bytes.set(vertices(n, 30 * (i + 1)), v * STRIDE);
            return { firstVertex: v, vertexCount: n, drawIndex: 10 + i, vertexBufferOffset: v * STRIDE, vertexBufferSize: n * STRIDE };
        });
        const r = await rig();
        r.flush(buffer, draws);
        expect(vbBinds(r.calls)).toEqual([["setVertexBuffer", buffer, 2 * STRIDE, 42 * STRIDE]]);
        expect(drawsOf(r.calls).map(d => d[3])).toEqual([38, 0, 18]);
        expect(execute(r.calls)).toEqual(expected(buffer, draws));
    });

    test("empty draws do not widen the range, and a batch of only empty draws binds nothing", async () => {
        const { newBuffer } = fakeGpu();
        const buffer = newBuffer(64 * 64);
        buffer.bytes.set(vertices(3, 9), 10 * STRIDE);
        const draws: Draw[] = [
            { firstVertex: 1, vertexCount: 0, drawIndex: 0, vertexBufferOffset: 1 * STRIDE, vertexBufferSize: 0 },
            { firstVertex: 10, vertexCount: 3, drawIndex: 1, vertexBufferOffset: 10 * STRIDE, vertexBufferSize: 3 * STRIDE },
        ];
        const r = await rig();
        r.flush(buffer, draws);
        expect(vbBinds(r.calls)).toEqual([["setVertexBuffer", buffer, 10 * STRIDE, 3 * STRIDE]]);
        expect(execute(r.calls)).toEqual(expected(buffer, draws));
        const r2 = await rig();
        r2.flush(buffer, [draws[0]!]);
        expect(vbBinds(r2.calls)).toHaveLength(0);
        expect(drawsOf(r2.calls)).toHaveLength(0);
    });

    test("each batch binds its own buffer in its own pass: a replaced ring and a new pass bind again", async () => {
        const { newBuffer } = fakeGpu();
        const a = newBuffer(64 * 16), b = newBuffer(64 * 16);
        a.bytes.set(vertices(3, 1), 0); b.bytes.set(vertices(3, 50), 0);
        const d = (n: number): Draw[] => [{ firstVertex: 0, vertexCount: 3, drawIndex: n, vertexBufferOffset: 0, vertexBufferSize: 3 * STRIDE }];
        const r = await rig();
        r.flush(a, d(0));
        r.flush(b, d(1));
        expect(r.passes()).toBe(2);
        expect(vbBinds(r.calls).map(c => c[1])).toEqual([a, b]);
        expect(execute(r.calls)).toEqual([...expected(a, d(0)), ...expected(b, d(1))]);
    });

    test("the skip-draw diagnostic keeps the per-draw path", async () => {
        const { newBuffer } = fakeGpu();
        const buffer = newBuffer(64 * 16);
        const draws: Draw[] = [
            { firstVertex: 0, vertexCount: 3, drawIndex: 0, vertexBufferOffset: 0, vertexBufferSize: 3 * STRIDE },
            { firstVertex: 3, vertexCount: 6, drawIndex: 1, vertexBufferOffset: 3 * STRIDE, vertexBufferSize: 6 * STRIDE },
        ];
        const r = await rig(6);
        r.flush(buffer, draws);
        expect(vbBinds(r.calls).map(c => [c[2], c[3]])).toEqual([[0, 3 * STRIDE]]);
        expect(r.stats.vertexRangeBinds).toBe(0);
        expect(drawsOf(r.calls).map(c => c[1])).toEqual([3]);
    });
});
