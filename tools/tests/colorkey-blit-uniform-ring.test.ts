/**
 * ColorKeyBlitPipeline: every blit reads its own uniforms, and a blit costs no typed array
 * and no bind group once its source view has been seen.
 *
 * The pipeline used to keep one 48-byte uniform buffer for all blits. queue.writeBuffer
 * takes effect at once, so two blits recorded into one encoder both drew with the second
 * one's source rect and colour key - which is why every caller submits after each blit.
 * With a ring slot per blit, addressed by dynamic offset, recorded blits stay independent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ColorKeyBlitPipeline, type ColorKeyBlitConfig } from "../../src/worker/backends/webgpu/ddraw/colorkey-blit-pipeline";

const globals = ["GPUBufferUsage", "GPUShaderStage"] as const;
const saved: Record<string, unknown> = {};
beforeAll(() => {
    for (const g of globals) saved[g] = (globalThis as Record<string, unknown>)[g];
    Object.assign(globalThis, {
        GPUBufferUsage: { VERTEX: 1, COPY_DST: 2, UNIFORM: 4 },
        GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
    });
});
afterAll(() => { for (const g of globals) (globalThis as Record<string, unknown>)[g] = saved[g]; });

interface Write { buffer: object; offset: number; data: number[]; sameArray: boolean }

function makeHarness(alignment = 256) {
    const writes: Write[] = [];
    const draws: Array<{ bindGroup: any; offsets: number[] }> = [];
    const bindGroupsCreated: any[] = [];
    const buffers: Array<{ size: number; usage: number; destroyed: boolean }> = [];
    let layout: any = null;
    let lastArray: unknown = null;
    const device: any = {
        limits: { minUniformBufferOffsetAlignment: alignment },
        createShaderModule: () => ({}),
        createBindGroupLayout: (d: any) => (layout = d),
        createPipelineLayout: () => ({}),
        createSampler: (d: any) => ({ sampler: d.magFilter }),
        createBuffer: (d: any) => { const b = { size: d.size, usage: d.usage, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; },
        createRenderPipeline: () => ({}),
        createBindGroup: (d: any) => { bindGroupsCreated.push(d); return d; },
    };
    const queue: any = {
        writeBuffer: (buffer: object, offset: number, data: Float32Array) => {
            writes.push({ buffer, offset, data: [...data], sameArray: data === lastArray });
            lastArray = data;
        },
    };
    const encoder: any = {
        beginRenderPass: () => ({
            setPipeline() {}, setVertexBuffer() {}, setViewport() {}, setScissorRect() {}, draw() {}, end() {},
            setBindGroup(_i: number, bindGroup: any, offsets: number[]) { draws.push({ bindGroup, offsets: [...offsets] }); },
        }),
    };
    const pipeline = new ColorKeyBlitPipeline(device, queue);
    const uniformWrites = () => writes.filter((w) => w.data.length === 12);
    return { pipeline, encoder, writes, uniformWrites, draws, bindGroupsCreated, buffers, layout: () => layout };
}

const view = (name: string) => ({ name }) as unknown as GPUTextureView;
function config(srcView: GPUTextureView, left: number, key: number, over: Partial<ColorKeyBlitConfig> = {}): ColorKeyBlitConfig {
    return {
        srcView, srcWidth: 100, srcHeight: 50, dstView: view("dst"), dstFormat: "rgba8unorm", dstWidth: 640, dstHeight: 480,
        srcRect: { left, top: 5, right: left + 10, bottom: 15 }, dstRect: { left: 0, top: 0, right: 10, bottom: 10 },
        colorKeyLow: { r: key, g: 0, b: 0, a: 0 }, colorKeyHigh: { r: key, g: 0, b: 0, a: 0 }, ...over,
    };
}

describe("ColorKeyBlitPipeline uniform ring", () => {
    test("two blits recorded into one encoder each draw with their own uniforms", () => {
        const h = makeHarness();
        const src = view("glyphs");
        h.pipeline.blit(h.encoder, config(src, 10, 0.25));
        h.pipeline.blit(h.encoder, config(src, 40, 0.75));
        const [a, b] = h.uniformWrites();
        expect(a!.offset).not.toBe(b!.offset);
        expect(h.draws.map((d) => d.offsets)).toEqual([[a!.offset], [b!.offset]]);
        // Source rect as UVs, then the key; slot one still holds the first blit's values.
        expect(a!.data.slice(0, 5)).toEqual([0.1, 0.1, 0.2, 0.3, 0.25].map(Math.fround));
        expect(b!.data.slice(0, 5)).toEqual([0.4, 0.1, 0.5, 0.3, 0.75].map(Math.fround));
        expect(a!.data[11]).toBe(1);
    });

    test("slots are an aligned stride apart and the buffer holds the whole ring", () => {
        const h = makeHarness(64);
        const src = view("glyphs");
        for (let i = 0; i < 3; i++) h.pipeline.blit(h.encoder, config(src, i, 0));
        expect(h.uniformWrites().map((w) => w.offset)).toEqual([0, 64, 128]);
        const ring = h.buffers.find((b) => b.usage === (4 | 2))!;
        expect(ring.size).toBe(64 * 256);
        const entry = h.layout().entries[0].buffer;
        expect(entry.hasDynamicOffset).toBe(true);
        expect(h.bindGroupsCreated[0].entries[0].resource.size).toBe(48);
    });

    test("the ring wraps after 256 blits", () => {
        const h = makeHarness();
        const src = view("glyphs");
        for (let i = 0; i < 258; i++) h.pipeline.blit(h.encoder, config(src, 0, 0));
        const offsets = h.uniformWrites().map((w) => w.offset);
        expect(offsets[255]).toBe(255 * 256);
        expect(offsets[256]).toBe(0);
        expect(offsets[257]).toBe(256);
    });

    test("one bind group per source view and sampler, one typed array for all blits", () => {
        const h = makeHarness();
        const glyphs = view("glyphs"), tiles = view("tiles");
        for (let i = 0; i < 100; i++) h.pipeline.blit(h.encoder, config(glyphs, i % 50, 0));
        expect(h.bindGroupsCreated.length).toBe(1);
        expect(h.uniformWrites().slice(1).every((w) => w.sameArray)).toBe(true);
        h.pipeline.blit(h.encoder, config(tiles, 0, 0));
        h.pipeline.blit(h.encoder, config(glyphs, 0, 0, { filter: "linear" }));
        h.pipeline.blit(h.encoder, config(glyphs, 0, 0, { filter: "linear" }));
        h.pipeline.blit(h.encoder, config(tiles, 0, 0));
        expect(h.bindGroupsCreated.length).toBe(3);
        expect(h.bindGroupsCreated.map((d) => [d.entries[1].resource.name, d.entries[2].resource.sampler]))
            .toEqual([["glyphs", "nearest"], ["tiles", "nearest"], ["glyphs", "linear"]]);
        expect(h.draws[100]!.bindGroup).toBe(h.draws[103]!.bindGroup);
    });

    test("destroy releases the ring and a destroyed pipeline records nothing", () => {
        const h = makeHarness();
        h.pipeline.blit(h.encoder, config(view("glyphs"), 0, 0));
        h.pipeline.destroy();
        expect(h.buffers.every((b) => b.destroyed)).toBe(true);
        const before = h.draws.length;
        h.pipeline.blit(h.encoder, config(view("glyphs"), 0, 0));
        expect(h.draws.length).toBe(before);
    });
});
