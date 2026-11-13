/**
 * Queue-level texture writes are ordered after the executor's recorded work that uses the
 * texture (queue-write-guard.ts): a write to a texture a recorded blit, clear or draw reads
 * or writes submits that work first, and a write to any other texture submits nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DDrawWebGPUExecutor } from "../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor";
import {
    beforeQueueWrite, registerQueueWriteGuard, unregisterQueueWriteGuard,
} from "../../src/worker/backends/webgpu/shared/queue-write-guard";
import { uploadToGPUTexture, uploadRGB565ToGPU } from "../../src/worker/modules/ddraw/gpu-texture-utils";
import { setAuthorityGpu } from "../../src/worker/modules/ddraw/surface-sync";
import type { RenderSurface } from "../../src/worker/modules/ddraw/com-objects";
import { useWebGpuFlags } from "./helpers/scoped-globals";

const ops: string[] = [];
const names = new Map<GPUTexture, string>();

function tex(name: string, width = 4, height = 2): GPUTexture {
    const t = { format: "rgba8unorm", label: name, width, height } as unknown as GPUTexture;
    names.set(t, name);
    return t;
}

const queue = {
    submit: () => { ops.push("submit"); },
    writeTexture: (dst: { texture: GPUTexture }) => { ops.push(`write:${names.get(dst.texture)}`); },
} as unknown as GPUQueue;

function surface(texture: GPUTexture): RenderSurface {
    const s = {
        surfaceType: "render_surface", width: 4, height: 2, pitch: 16, caps: 0, surfacePtr: 0,
        surfacePtrAllocated: false, attachedSurfaceAddr: 0,
        format: { flags: 0x41, bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 0xff, aMask: 0xff000000 },
        gpuTexture: texture, gpuTextureView: { n: names.get(texture) } as unknown as GPUTextureView, gpuTextureFormat: "rgba8unorm",
        mode: "GPU_ONLY", version: 0, gpuDirty: false, everLocked: false, lastUploadVersion: 0, writeGeneration: 0,
    } as unknown as RenderSurface;
    setAuthorityGpu(s);
    return s;
}

function executor(): DDrawWebGPUExecutor {
    const e = Object.create(DDrawWebGPUExecutor.prototype) as object;
    const fields: Record<string, unknown> = {
        deviceLost: false, flushing: false, encoderEpoch: 1, textureEpochs: new WeakMap(),
        currentEncoder: null, currentRenderPass: null, currentRenderTarget: null, currentBatch: null,
        opLogArmed: 0, queue, debugFlags: { disableTextureOverwriteSubmit: false },
        device: {
            createCommandEncoder: () => ({
                finish: () => ({}),
                copyTextureToTexture: (a: { texture: GPUTexture; origin: { x: number; y: number } }, b: { texture: { label: string }; origin: { x: number; y: number } }, size: { width: number; height: number }) => {
                    ops.push(`copy:${names.get(a.texture)}@${a.origin.x},${a.origin.y}->${b.texture.label}@${b.origin.x},${b.origin.y}:${size.width}x${size.height}`);
                },
            }),
            createTexture: (d: { size: [number, number]; format: string }) => {
                scratchCreated++;
                const label = `scratch${scratchCreated}`;
                return { label, format: d.format, width: d.size[0], height: d.size[1], destroy: () => { ops.push(`destroy:${label}`); }, createView: () => ({ n: label }) };
            },
        },
        blitScratchGarbage: [], blitScratch: null, blitScratchView: null, blitPass: null, blitPassView: null,
        renderStats: { flushes: 0, queueWriteSubmits: 0, blitRingSubmits: 0, clears: 0, blits: 0, blitPasses: 0, blitSelfCopies: 0 },
        surfacesNeedingClear: new Set(),
        flushBatch: () => {}, resetBindFastPath: () => {}, ensureSurfaceGPUResources: () => {},
        vertexConverter: { flushParams: () => {}, destroyPendingAfterSubmit: () => {}, startFrame: () => {} },
        ringBufferManager: { flushGeometry: () => {}, flushUniforms: () => {}, flushLights: () => {}, flushStorageBuffer: () => {} },
        clearPipeline: { destroyPendingAfterSubmit: () => {}, clear: (_e: unknown, v: { n: string }) => { ops.push(`clear:${v.n}`); } },
        depthManager: { flushGarbage: () => {}, getDepthViewForTarget: () => undefined },
        msaaColorManager: { flushGarbage: () => {}, getColorViewForTarget: () => null },
        textureConverter: { destroyPendingAfterSubmit: () => {} },
        colorKeyBlitPipeline: {
            beginPass: (_e: unknown, view: unknown) => {
                passes.push(`load:${(view as { n: string }).n}`);
                return { end: () => { passes.push("end"); } };
            },
            encode: (_p: unknown, cfg: { srcView: { n: string } }) => { ops.push("blit"); sampled.push(cfg.srcView.n); pending++; },
            hasFreeSlot: () => pending < 256,
            slotsSubmitted: () => { pending = 0; },
        },
    };
    for (const [k, value] of Object.entries(fields)) {
        Object.defineProperty(e, k, { value, writable: true, configurable: true });
    }
    return e as DDrawWebGPUExecutor;
}

let pending = 0;
let scratchCreated = 0;
const passes: string[] = [];
const sampled: string[] = [];
const RECT = { left: 0, top: 0, right: 4, bottom: 2 };
const KEY = { low: 0, high: 0 };
const PIXELS = new Uint8Array(4 * 2 * 4);

let ex: DDrawWebGPUExecutor;
beforeEach(() => {
    ops.length = 0;
    passes.length = 0;
    sampled.length = 0;
    pending = 0;
    scratchCreated = 0;
    ex = executor();
    registerQueueWriteGuard(ex);
});
afterEach(() => unregisterQueueWriteGuard(ex));

describe("a queue write to a texture that recorded work uses submits that work first", () => {
    test("the source and the destination of a recorded colour-key blit", () => {
        const glyphs = tex("glyphs"), back = tex("back");
        ex.blitWithColorKey(surface(glyphs), surface(back), RECT, RECT, KEY);
        uploadToGPUTexture(queue, glyphs, PIXELS, 4, 2);
        expect(ops).toEqual(["blit", "submit", "write:glyphs"]);
        ex.blitWithColorKey(surface(glyphs), surface(back), RECT, RECT, KEY);
        uploadToGPUTexture(queue, back, PIXELS, 4, 2, undefined, undefined, { left: 0, top: 0, right: 2, bottom: 1 });
        expect(ops).toEqual(["blit", "submit", "write:glyphs", "blit", "submit", "write:back"]);
        expect(ex.renderStats.queueWriteSubmits).toBe(2);
    });

    test("a recorded shader copy, and the RGB565 upload helper", () => {
        const a = tex("a"), b = tex("b");
        ex.blitWithShaderCopy(surface(a), surface(b), RECT, RECT);
        const mem = new Uint8Array(64);
        uploadRGB565ToGPU(queue, b, mem, 0, 4, 2, 8);
        expect(ops).toEqual(["blit", "submit", "write:b"]);
    });

    test("the target of a recorded render pass (draws, a consumed deferred clear)", () => {
        const back = tex("back");
        const stub = (o: Record<string, unknown>) => { for (const [k, value] of Object.entries(o)) Object.defineProperty(ex, k, { value, writable: true, configurable: true }); };
        stub({
            syncMsaaSampleCount: () => {}, applyPassViewport: () => {},
            depthManager: { ensureDepthForTarget: () => {}, createDepthStencilAttachmentForTarget: () => undefined, flushGarbage: () => {} },
            msaaColorManager: { ensureForTarget: () => {}, isEnabled: () => false, flushGarbage: () => {} },
            pipelineFactory: { setColorTargetFormat: () => {} },
            device: { createCommandEncoder: () => ({ finish: () => ({}), beginRenderPass: () => { ops.push("pass"); return { end: () => {} }; } }) },
            renderStats: { flushes: 0, queueWriteSubmits: 0, passes: 0 },
        });
        (ex as unknown as { ensureRenderPass: (t: unknown) => void }).ensureRenderPass(surface(back));
        uploadToGPUTexture(queue, back, PIXELS, 4, 2);
        expect(ops).toEqual(["pass", "submit", "write:back"]);
    });

    test("a write to a texture no recorded work uses submits nothing", () => {
        const glyphs = tex("glyphs"), back = tex("back"), other = tex("other");
        ex.blitWithColorKey(surface(glyphs), surface(back), RECT, RECT, KEY);
        uploadToGPUTexture(queue, other, PIXELS, 4, 2);
        expect(ops).toEqual(["blit", "write:other"]);
        expect(ex.hasRecordedWork()).toBe(true);
    });

    test("after a submit the texture is free again: no second submit for the next write", () => {
        const glyphs = tex("glyphs"), back = tex("back");
        ex.blitWithColorKey(surface(glyphs), surface(back), RECT, RECT, KEY);
        ex.flush(false);
        uploadToGPUTexture(queue, glyphs, PIXELS, 4, 2);
        expect(ops).toEqual(["blit", "submit", "write:glyphs"]);
    });

    test("after a submit, unrelated recorded work does not make the old texture a hazard again", () => {
        const glyphs = tex("glyphs"), back = tex("back"), a = tex("a"), b = tex("b");
        ex.blitWithColorKey(surface(glyphs), surface(back), RECT, RECT, KEY);
        ex.flush(false);
        ex.blitWithShaderCopy(surface(a), surface(b), RECT, RECT);
        uploadToGPUTexture(queue, glyphs, PIXELS, 4, 2);
        expect(ops).toEqual(["blit", "submit", "blit", "write:glyphs"]);
        expect(ex.hasRecordedWork()).toBe(true);
    });

    test("the debug switch that disables the early submit disables the write guard too", () => {
        const glyphs = tex("glyphs"), back = tex("back");
        (ex as unknown as { debugFlags: { disableTextureOverwriteSubmit: boolean } }).debugFlags = { disableTextureOverwriteSubmit: true };
        ex.blitWithColorKey(surface(glyphs), surface(back), RECT, RECT, KEY);
        uploadToGPUTexture(queue, glyphs, PIXELS, 4, 2);
        expect(ops).toEqual(["blit", "write:glyphs"]);
    });

    test("a write made from inside flush() does not re-enter it, and a lost device submits nothing", () => {
        const glyphs = tex("glyphs"), back = tex("back");
        ex.blitWithColorKey(surface(glyphs), surface(back), RECT, RECT, KEY);
        (ex as unknown as { flushBatch: () => void }).flushBatch = () => uploadToGPUTexture(queue, glyphs, PIXELS, 4, 2);
        ex.flush(false);
        expect(ops).toEqual(["blit", "write:glyphs", "submit"]);
        ops.length = 0;
        ex.blitWithColorKey(surface(glyphs), surface(back), RECT, RECT, KEY);
        (ex as unknown as { deviceLost: boolean }).deviceLost = true;
        beforeQueueWrite(glyphs);
        expect(ops).toEqual(["blit"]);
    });

    test("flushPending submits only when something is recorded", () => {
        ex.flushPending();
        expect(ops).toEqual([]);
        ex.blitWithShaderCopy(surface(tex("a")), surface(tex("b")), RECT, RECT);
        ex.flushPending();
        expect(ops).toEqual(["blit", "submit"]);
    });
});

describe("a blit keeps its place after draws prepared before it", () => {
    test("batched draws are encoded before the blit, for both blit kinds", () => {
        const set = (k: string, v: unknown) => Object.defineProperty(ex, k, { value: v, writable: true, configurable: true });
        set("flushBatch", () => { ops.push("draws"); set("currentBatch", null); });
        set("currentBatch", {});
        ex.blitWithColorKey(surface(tex("a")), surface(tex("b")), RECT, RECT, KEY);
        set("currentBatch", {});
        ex.blitWithShaderCopy(surface(tex("c")), surface(tex("d")), RECT, RECT);
        expect(ops).toEqual(["draws", "blit", "draws", "blit"]);
    });
});

describe("a deferred clear of either surface is encoded before the blit", () => {
    const pendingClear = (state: RenderSurface): RenderSurface => {
        const s = state as unknown as { needsColorClear: boolean; clearColor: unknown };
        s.needsColorClear = true;
        s.clearColor = { r: 0, g: 0, b: 0, a: 1 };
        (ex as unknown as { surfacesNeedingClear: Set<unknown> }).surfacesNeedingClear.add(state);
        return state;
    };
    const blits = [
        ["colour-key", (s: RenderSurface, d: RenderSurface) => ex.blitWithColorKey(s, d, RECT, RECT, KEY)],
        ["shader copy", (s: RenderSurface, d: RenderSurface) => ex.blitWithShaderCopy(s, d, RECT, RECT)],
    ] as const;

    for (const [kind, blit] of blits) {
        test(`${kind}: a pending clear of the destination runs first, not dropped`, () => {
            const dst = pendingClear(surface(tex("back")));
            blit(surface(tex("glyphs")), dst);
            expect(ops).toEqual(["clear:back", "blit"]);
            expect((dst as unknown as { needsColorClear: boolean }).needsColorClear).toBe(false);
            expect((ex as unknown as { surfacesNeedingClear: Set<unknown> }).surfacesNeedingClear.has(dst)).toBe(false);
        });

        test(`${kind}: a pending clear of the source runs before the blit reads it`, () => {
            const src = pendingClear(surface(tex("fade")));
            blit(src, surface(tex("back")));
            expect(ops).toEqual(["clear:fade", "blit"]);
        });
    }

    test("the encoded clear marks its texture: an upload to it (a source sync) submits the clear first", () => {
        const fade = tex("fade");
        (ex as unknown as { encodePendingClear(s: RenderSurface): void }).encodePendingClear(pendingClear(surface(fade)));
        uploadToGPUTexture(queue, fade, PIXELS, 4, 2);
        expect(ops).toEqual(["clear:fade", "submit", "write:fade"]);
    });
});

describe("consecutive blits to one destination share one pass", () => {
    test("a hundred blits onto one surface open one pass; another destination opens the next", () => {
        const glyphs = tex("glyphs"), back = tex("back"), other = tex("other");
        const dst = surface(back);
        for (let i = 0; i < 100; i++) ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        expect(passes).toEqual(["load:back"]);
        ex.blitWithShaderCopy(surface(glyphs), surface(other), RECT, RECT);
        ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        expect(passes).toEqual(["load:back", "end", "load:other", "end", "load:back"]);
        expect(ex.renderStats.blits).toBe(102);
        expect(ex.renderStats.blitPasses).toBe(3);
    });

    test("a submit, or a pass someone else opened, ends the blit pass", () => {
        const glyphs = tex("glyphs"), back = tex("back");
        const dst = surface(back);
        ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        ex.flush(false);
        ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        (ex as unknown as { currentRenderPass: unknown }).currentRenderPass = { end: () => { passes.push("end-draw"); } };
        ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        expect(passes).toEqual(["load:back", "end", "load:back", "end-draw", "load:back"]);
    });

    test("a pending deferred clear of the destination ends the shared pass and is encoded before the next blit", () => {
        const glyphs = tex("glyphs"), back = tex("back");
        const dst = surface(back) as RenderSurface & { needsColorClear?: boolean; clearColor?: unknown };
        ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        dst.needsColorClear = true; dst.clearColor = { r: 0, g: 0, b: 0, a: 1 };
        (ex as unknown as { surfacesNeedingClear: Set<unknown> }).surfacesNeedingClear.add(dst);
        ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        expect(passes).toEqual(["load:back", "end", "load:back"]);
        expect(ops).toEqual(["blit", "clear:back", "blit", "blit"]);
        expect(dst.needsColorClear).toBe(false);
        expect((ex as unknown as { surfacesNeedingClear: Set<unknown> }).surfacesNeedingClear.size).toBe(0);
    });
});

describe("a blit whose source is its destination samples a scratch copy (#327)", () => {
    useWebGpuFlags("GPUTextureUsage");
    const blits = [
        ["colour-key", (s: RenderSurface, d: RenderSurface, r: typeof RECT) => ex.blitWithColorKey(s, d, r, RECT, KEY)],
        ["shader copy", (s: RenderSurface, d: RenderSurface, r: typeof RECT) => ex.blitWithShaderCopy(s, d, r, RECT)],
    ] as const;
    for (const [kind, blit] of blits) {
        test(`${kind}: the source rect is copied outside the pass and the blit never samples the destination's own view`, () => {
            const back = tex("back", 8, 4);
            const s = surface(back);
            blit(s, s, { left: 1, top: 1, right: 5, bottom: 3 });
            expect(ops).toEqual(["copy:back@1,1->scratch1@1,1:4x2", "blit"]);
            expect(sampled).toEqual(["scratch1"]);
            expect(passes).toEqual(["load:back"]);
            expect(ex.renderStats.blitSelfCopies).toBe(1);
        });
    }

    test("the scratch is reused, a different source size replaces it, and the old one is destroyed after the next submit", () => {
        const a = tex("a", 8, 4), b = tex("b", 16, 8), other = tex("other");
        const sa = surface(a), sb = surface(b);
        ex.blitWithColorKey(sa, sa, RECT, RECT, KEY);
        ex.blitWithColorKey(sa, sa, RECT, RECT, KEY);
        expect(scratchCreated).toBe(1);
        ex.blitWithColorKey(sb, sb, RECT, RECT, KEY);
        expect(scratchCreated).toBe(2);
        expect(ops).not.toContain("destroy:scratch1");
        ex.flush(false);
        expect(ops.at(-1)).toBe("destroy:scratch1");
        ex.blitWithColorKey(surface(other), sb, RECT, RECT, KEY);
        expect(sampled.at(-1)).toBe("other");
    });

    test("a copy into the scratch ends a shared blit pass on that surface", () => {
        const glyphs = tex("glyphs"), back = tex("back", 8, 4);
        const dst = surface(back);
        ex.blitWithColorKey(surface(glyphs), dst, RECT, RECT, KEY);
        ex.blitWithColorKey(dst, dst, RECT, RECT, KEY);
        expect(passes).toEqual(["load:back", "end", "load:back"]);
        expect(sampled).toEqual(["glyphs", "scratch1"]);
    });
});

describe("unsubmitted blits are bounded by the colour-key uniform ring", () => {
    test("shader copies share the ring: the 257th submits the first 256 first", () => {
        const a = tex("a"), b = tex("b");
        for (let i = 0; i < 257; i++) ex.blitWithShaderCopy(surface(a), surface(b), RECT, RECT);
        expect(ops.filter((o) => o === "submit")).toHaveLength(1);
        expect(ops.indexOf("submit")).toBe(256);
    });

    test("the 257th blit in one encoder submits the first 256 first; a submit frees the ring", () => {
        const a = tex("a"), b = tex("b");
        for (let i = 0; i < 257; i++) ex.blitWithColorKey(surface(a), surface(b), RECT, RECT, KEY);
        expect(ops.filter((o) => o === "submit")).toHaveLength(1);
        expect(ops.indexOf("submit")).toBe(256);
        expect(ex.renderStats.blitRingSubmits).toBe(1);
        ex.flush(false);
        expect(pending).toBe(0);
    });
});

describe("validate-queue-writes", () => {
    const ROOT = join(import.meta.dir, "..", "..");
    const SCOPE = [
        "src/worker/backends/webgpu/ddraw", "src/worker/modules/ddraw",
        "src/worker/backends/webgpu/shared/texture-converter.ts",
    ];

    function copyScope(to: string): void {
        const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
        const copy = (rel: string): void => {
            const from = join(ROOT, rel);
            if (statSync(from).isDirectory()) {
                for (const e of readdirSync(from)) copy(join(rel, e));
            } else if (rel.endsWith(".ts")) {
                mkdirSync(dirname(join(to, rel)), { recursive: true });
                writeFileSync(join(to, rel), readFileSync(from));
            }
        };
        for (const rel of SCOPE) copy(rel);
    }

    function run(root: string): number {
        const r = Bun.spawnSync(["bun", join(ROOT, "tools", "validate-queue-writes.ts"), "--root", root], { stdout: "pipe", stderr: "pipe" });
        return r.exitCode ?? -1;
    }

    test("passes on the tree and fails on a planted unguarded write", () => {
        const dir = mkdtempSync(join(tmpdir(), "queue-writes-"));
        try {
            copyScope(dir);
            expect(run(dir)).toBe(0);
            const victim = join(dir, "src/worker/modules/ddraw/surface-sync.ts");
            writeFileSync(victim, readFileSync(victim, "utf8") +
                "\nexport function planted(q: GPUQueue, t: GPUTexture, d: Uint8Array): void {\n" +
                "    q.writeTexture({ texture: t }, d, { bytesPerRow: 4 }, { width: 1, height: 1 });\n}\n");
            expect(run(dir)).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("fails when the guard before a pinned submit is removed, or replaced by an unrelated flush()", () => {
        for (const [file, guard, replacement] of [
            ["src/worker/modules/ddraw/presenter.ts", "beforeQueueWrite(surface.gpuTexture);", ""],
            ["src/worker/backends/webgpu/ddraw/mip-generator.ts", "beforeQueueWrite(texture);", "stream.flush();"],
        ] as const) {
            const dir = mkdtempSync(join(tmpdir(), "queue-writes-"));
            try {
                copyScope(dir);
                const victim = join(dir, file);
                const text = readFileSync(victim, "utf8");
                expect(text.includes(guard)).toBe(true);
                writeFileSync(victim, text.replace(guard, replacement));
                expect(run(dir)).toBe(1);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });
});

describe("ColorKeyBlitPipeline", () => {
    useWebGpuFlags("GPUShaderStage", "GPUBufferUsage");
    test("differential: the pass commands are identical apart from begin/end", async () => {
        const { ColorKeyBlitPipeline } = await import("../../src/worker/backends/webgpu/ddraw/colorkey-blit-pipeline");
        const record = (log: string[]) => ({
            setPipeline() { log.push("pipeline"); },
            setBindGroup(_i: number, _g: unknown, off: number[]) { log.push(`bind ${off[0]}`); },
            setVertexBuffer() { log.push("vb"); },
            setViewport(x: number, y: number, w: number, h: number) { log.push(`vp ${x},${y},${w},${h}`); },
            setScissorRect(x: number, y: number, w: number, h: number) { log.push(`sc ${x},${y},${w},${h}`); },
            draw(n: number) { log.push(`draw ${n}`); },
            end() { log.push("end"); },
        });
        const device = {
            limits: { minUniformBufferOffsetAlignment: 256 },
            createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
            createSampler: () => ({}), createBuffer: () => ({ destroy() {} }), createRenderPipeline: () => ({}),
            createBindGroup: () => ({}),
        } as unknown as GPUDevice;
        const writes: number[][] = [[], []];
        const configs = [0, 1, 2].map((i) => ({
            srcView: {} as GPUTextureView, srcWidth: 64, srcHeight: 64, dstView: {} as GPUTextureView,
            dstFormat: "rgba8unorm" as GPUTextureFormat, dstWidth: 640, dstHeight: 480,
            srcRect: { left: 8 * i, top: 0, right: 8 * i + 8, bottom: 8 },
            dstRect: { left: 100 + 9 * i, top: 50, right: 108 + 9 * i, bottom: 58 },
            colorKeyLow: { r: 0, g: 0, b: 0, a: 0 }, colorKeyHigh: { r: 0, g: 0, b: 0, a: 0 }, enableColorKey: true,
        }));
        const logs: string[][] = [[], []];
        for (const k of [0, 1]) {
            const q = { writeBuffer(_b: unknown, off: number, data: Float32Array) { writes[k].push(off, ...Array.from(data)); } } as unknown as GPUQueue;
            const p = new ColorKeyBlitPipeline(device, q);
            const encoder = { beginRenderPass: () => { logs[k].push("begin"); return record(logs[k]); } } as unknown as GPUCommandEncoder;
            if (k === 0) for (const c of configs) p.blit(encoder, c);
            else { const pass = p.beginPass(encoder, configs[0].dstView); for (const c of configs) p.encode(pass, c); pass.end(); }
        }
        const body = (log: string[]) => log.filter((l) => l !== "begin" && l !== "end");
        expect(body(logs[1])).toEqual(body(logs[0]));
        expect(writes[1]).toEqual(writes[0]);
        expect(logs[0].filter((l) => l === "begin")).toHaveLength(3);
        expect(logs[1].filter((l) => l === "begin")).toHaveLength(1);
    });

    test("hasFreeSlot turns false after RING_SLOTS blits and true again after slotsSubmitted", async () => {
        const { ColorKeyBlitPipeline } = await import("../../src/worker/backends/webgpu/ddraw/colorkey-blit-pipeline");
        const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setViewport() {}, setScissorRect() {}, draw() {}, end() {} };
        const device = {
            limits: { minUniformBufferOffsetAlignment: 256 },
            createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
            createSampler: () => ({}), createBuffer: () => ({ destroy() {} }), createRenderPipeline: () => ({}),
            createBindGroup: () => ({}),
        } as unknown as GPUDevice;
        const q = { writeBuffer() {} } as unknown as GPUQueue;
        const p = new ColorKeyBlitPipeline(device, q);
        const encoder = { beginRenderPass: () => pass } as unknown as GPUCommandEncoder;
        const config = {
            srcView: {} as GPUTextureView, srcWidth: 4, srcHeight: 2, dstView: {} as GPUTextureView,
            dstFormat: "rgba8unorm" as GPUTextureFormat, dstWidth: 4, dstHeight: 2, srcRect: RECT, dstRect: RECT,
            colorKeyLow: { r: 0, g: 0, b: 0, a: 0 }, colorKeyHigh: { r: 0, g: 0, b: 0, a: 0 }, enableColorKey: true,
        };
        for (let i = 0; i < 255; i++) p.blit(encoder, config);
        expect(p.hasFreeSlot()).toBe(true);
        p.blit(encoder, config);
        expect(p.hasFreeSlot()).toBe(false);
        p.slotsSubmitted();
        expect(p.hasFreeSlot()).toBe(true);
    });
});
