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

const ops: string[] = [];
const names = new Map<GPUTexture, string>();

function tex(name: string): GPUTexture {
    const t = { format: "rgba8unorm", label: name } as unknown as GPUTexture;
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
        gpuTexture: texture, gpuTextureView: {} as GPUTextureView, gpuTextureFormat: "rgba8unorm",
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
        opLogArmed: 0, queue,
        device: { createCommandEncoder: () => ({ finish: () => ({}) }) },
        renderStats: { flushes: 0, queueWriteSubmits: 0, clears: 0 },
        surfacesNeedingClear: new Set(),
        flushBatch: () => {}, resetBindFastPath: () => {}, ensureSurfaceGPUResources: () => {},
        vertexConverter: { flushParams: () => {}, destroyPendingAfterSubmit: () => {}, startFrame: () => {} },
        ringBufferManager: { flushGeometry: () => {}, flushUniforms: () => {}, flushLights: () => {}, flushStorageBuffer: () => {} },
        clearPipeline: { destroyPendingAfterSubmit: () => {} },
        depthManager: { flushGarbage: () => {} },
        msaaColorManager: { flushGarbage: () => {} },
        textureConverter: { destroyPendingAfterSubmit: () => {} },
        colorKeyBlitPipeline: { blit: () => { ops.push("blit"); } },
    };
    for (const [k, value] of Object.entries(fields)) {
        Object.defineProperty(e, k, { value, writable: true, configurable: true });
    }
    return e as DDrawWebGPUExecutor;
}

const RECT = { left: 0, top: 0, right: 4, bottom: 2 };
const KEY = { low: 0, high: 0 };
const PIXELS = new Uint8Array(4 * 2 * 4);

let ex: DDrawWebGPUExecutor;
beforeEach(() => {
    ops.length = 0;
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
});
