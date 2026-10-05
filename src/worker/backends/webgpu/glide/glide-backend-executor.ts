/// <reference types="@webgpu/types" />

import { WebGPUBackend } from "../webgpu-backend";
import { Legacy3DCommandType } from "../legacy3d/types";
import {
    LEGACY3D_CMD_STRIDE, LEGACY3D_VERTEX_BYTES,
    CI_TYPE, CI_A, CI_B, CI_C, CI_D, CI_E, CI_F, CI_G, CI_H, CI_I, CI_J, CI_K, CI_L, CI_M,
    CI_CLIP_X0, CI_CLIP_Y0, CI_CLIP_X1, CI_CLIP_Y1,
} from "../legacy3d/command-stream";
import { Legacy3DExecutor } from "../legacy3d/executor";
import type { LegacyPrimitiveTopology } from "../legacy3d/types";
import { GlidePipelineFactory } from "./glide-pipeline-factory";
import { GlideExecutorMetrics, GlideFrameInput, GlideGpuTexture, GlidePipelineConfig } from "./glide-types";
import { glideTexCoordScale } from "./glide-texture-decoder";
import { Logger, LogCategory } from "../../../core/logger";
import { statsOverlay } from "../../../core/stats-overlay";
import { EmulatorConfig } from "../../../core/emulator-config-manager";
import { registerBackendQualitySupport } from "../shared/quality-capabilities";
import { resolveInternalScaleFactor } from "../shared/internal-resolution";

function unpackColorU32(color: number): { r: number; g: number; b: number; a: number } {
    const c = color >>> 0;
    return {
        r: ((c >>> 16) & 0xff) / 255,
        g: ((c >>> 8) & 0xff) / 255,
        b: (c & 0xff) / 255,
        a: ((c >>> 24) & 0xff) / 255,
    };
}

function normalizeDepth(depth: number): number {
    const d = depth >>> 0;
    if (d > 0xffff) {
        return Math.max(0, Math.min(1, d / 0xffffffff));
    }
    return Math.max(0, Math.min(1, d / 0xffff));
}

// Globals uniform layout (std140), bytes — must match `struct Globals` in WGSL:
//   resolution vec2f @0, alphaRef f32 @8, alphaTestFunc u32 @12,
//   constantColor vec4f @16, chromaKey vec4f @32,
//   texCoordScale vec2f @48, chromaEnabled u32 @56, fogMode u32 @60,
//   fogColor vec4f @64, colorCombine u32 @80, alphaCombine u32 @84,
//   gammaCorrection f32 @88, _pad0 u32 @92,
//   fogTable array<vec4f,16> @96 (entry k at 96 + 4*k).
const TOPOLOGY_BY_ID: Record<number, LegacyPrimitiveTopology> = {
    1: "point-list",
    2: "line-list",
    3: "triangle-list",
};

const GLIDE_UNIFORM_FOGTABLE_OFFSET = 96;
const GLIDE_UNIFORM_SIZE = GLIDE_UNIFORM_FOGTABLE_OFFSET + 64 * 4; // 352

/**
 * Copy the presenter's RGBA8 LFB image into the upload staging buffer, swapping
 * R and B when the swap chain is BGRA and inserting the 256-byte row padding
 * WebGPU demands.
 *
 * A whole pixel per load/store: the channel swap is one word permutation, and
 * doing it a byte at a time is four times the memory traffic over 307k pixels of
 * every present. Both buffers are our own allocations, so both are word-aligned;
 * both row pitches are multiples of four (width*4, and paddedRow is 256-aligned).
 */
export function stageLfbRows(
    pixels: Uint8Array,
    staged: Uint8Array,
    srcRowBytes: number,
    dstRowBytes: number,
    height: number,
    bgra: boolean,
): void {
    const src32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2);
    const staged32 = new Uint32Array(staged.buffer, staged.byteOffset, staged.byteLength >>> 2);
    const rowWords = srcRowBytes >>> 2;
    const dstWords = dstRowBytes >>> 2;
    for (let y = 0; y < height; y++) {
        const src = y * rowWords;
        const dst = y * dstWords;
        if (!bgra) {
            staged32.set(src32.subarray(src, src + rowWords), dst);
            continue;
        }
        for (let x = 0; x < rowWords; x++) {
            const v = src32[src + x]!;
            staged32[dst + x] = (((v >>> 16) & 0xff) | (v & 0xff00ff00) | ((v & 0xff) << 16)) >>> 0;
        }
    }
}

export class GlideBackendExecutor extends Legacy3DExecutor {
    private offscreenTexture: GPUTexture | null = null;
    private offscreenView: GPUTextureView | null = null;
    private depthTexture: GPUTexture | null = null;
    private depthView: GPUTextureView | null = null;
    private offscreenSize: { width: number; height: number } | null = null;
    /**
     * Internal render scale — what nGlide's "screen resolution" setting is. A Glide
     * title always asks grSstWinOpen for its own mode (Carmageddon 2: 640x480) and
     * reads it back with grSstScreenWidth/Height, so the resolution is the WRAPPER's
     * property, not the game's: render the same geometry into a larger target and the
     * guest never notices. The vertex shader normalises by the LOGICAL size, so the
     * geometry needs no change — only the target, the scissor and the LFB blit scale.
     * Textures do not gain detail; edges and the triangle-drawn HUD do.
     *
     * Set every frame by resolveInternalScaleFactor() (shared/internal-resolution.ts):
     * either the user's fixed 2x/4x multiplier, or — the default — a continuous "auto"
     * factor that fits the offscreen to the canvas's own physical-pixel size, so the
     * present pass (which blits offscreen -> canvas via the srcW/srcH/outW/outH it is
     * now given) is close to 1:1 instead of permanently downsampling a fixed-size render.
     */
    private renderScale = 1;
    private lfbScaleTexture: GPUTexture | null = null;
    private lfbScaleView: GPUTextureView | null = null;
    private lfbScaleSize: { width: number; height: number } | null = null;

    private vertexBuffer: GPUBuffer | null = null;
    private vertexBufferSize = 0;
    private uniformBuffer: GPUBuffer | null = null;
    private uniformStride = 0;
    private uniformStaging: ArrayBuffer | null = null;
    private uniformStagingView: DataView | null = null;
    /** Per-command uniform slice index, indexed by stream command index. */
    private drawSliceIndex = new Int32Array(0);

    // --- Frame-buffer mirror -------------------------------------------------
    // On real hardware the linear frame buffer IS the render target: a title that
    // locks it for READING sees what the rasterizer just drew. Our LFB is a separate
    // guest-side buffer, so without this mirror a read lock hands back only whatever
    // the guest itself last wrote — black — and a full-screen post-process (Carmageddon
    // 2's underwater pass) renders a black screen. Armed lazily on the first read lock
    // so titles that never read the frame buffer pay nothing.
    private mirrorEnabled = false;
    private mirrorBuffer: GPUBuffer | null = null;
    private mirrorBufferBytes = 0;
    private mirrorRgba: Uint8Array | null = null;
    private mirrorSize: { width: number; height: number } | null = null;
    private mirrorInFlight = false;
    // Bumped by dispose(); an in-flight readback compares against it so a mapAsync
    // that resolves after teardown cannot resurrect mirror state or leak its buffer.
    private disposeGeneration = 0;

    /** Staging for an LFB image composited AFTER the pass (encoder-ordered copy). */
    private lfbStagingBuffer: GPUBuffer | null = null;
    private lfbStagingBytes = 0;
    private lfbOverlayScratch: Uint8Array | null = null;
    /** LFB image already staged in the offscreen's byte order, and its version. */
    private lfbUploadedVersion = -1;
    // The layout the staged copy was built at — see uploadLfbBackground.
    private lfbStagedWidth = -1;
    private lfbStagedHeight = -1;
    private lfbStagedPitch = -1;
    private lfbStagedBgra = false;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private pipelineLayout: GPUPipelineLayout | null = null;
    private readonly samplers = new Map<number, GPUSampler>();

    private whiteTexture: GPUTexture | null = null;
    private whiteTextureView: GPUTextureView | null = null;

    private readonly textures = new Map<number, GlideGpuTexture>();
    private pipelineFactory: GlidePipelineFactory | null = null;
    // One explicit bind group layout means one cache for every pipeline, keyed by what
    // the group actually holds (texture + sampler) rather than by the pipeline object.
    private bindGroupCache = new Map<number, GPUBindGroup>();
    private hasRenderedFrame = false;
    private lfbUploadScratch: Uint8Array | null = null;
    private textureUploadScratch: Uint8Array | null = null;

    private readonly metrics: GlideExecutorMetrics = {
        frames: 0,
        draws: 0,
        pipelineSets: 0,
        textureUploads: 0,
        bindGroupHits: 0,
        bindGroupMisses: 0,
        mergedDraws: 0,
        uniformSlices: 0,
    };

    constructor(private readonly backend: WebGPUBackend) {
        super("glide");
        // Glide has no sampler-state or MSAA knobs of its own (fixed-function combine,
        // no D3D-style D3DSAMP_* — see glide2x); internalScale is the one GPU-resident
        // quality key this backend implements.
        registerBackendQualitySupport("glide", ["internalScale"]);
    }

    /** Start keeping a CPU copy of the rendered frame (first LFB read lock). */
    enableFramebufferMirror(): void {
        this.mirrorEnabled = true;
    }

    /** The most recently completed frame as RGBA8, or null before the first lands. */
    getFramebufferMirror(): { rgba: Uint8Array; width: number; height: number } | null {
        if (!this.mirrorRgba || !this.mirrorSize) return null;
        return { rgba: this.mirrorRgba, width: this.mirrorSize.width, height: this.mirrorSize.height };
    }

    getMetrics(): GlideExecutorMetrics {
        return { ...this.metrics };
    }

    getPipelineCacheStats(): { hits: number; misses: number; size: number } {
        return this.pipelineFactory?.getStats() ?? { hits: 0, misses: 0, size: 0 };
    }

    /**
     * Upload one texture, LOD 0 first, then any smaller levels the guest downloaded.
     *
     * Glide's grTexDownloadMipMap carries the whole chain in one call; ignoring
     * everything past level 0 leaves minified geometry sampling a full-resolution
     * texture, which is the aliasing (and the wasted bandwidth) mipmaps exist to avoid.
     * The GPU texture is REUSED when its shape is unchanged — Glide titles re-download
     * constantly, and destroy+create per download costs an allocation and a bind-group
     * rebuild every time.
     */
    uploadTexture(handle: number, width: number, height: number, format: number, levels: Uint8Array[]): void {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!device || !queue || width <= 0 || height <= 0 || levels.length === 0) return;

        // Only count the levels that can actually be uploaded. Declaring a level and
        // then skipping it leaves it zero-filled, so minified geometry samples black
        // and nothing reports it.
        let usableLevels = 0;
        while (usableLevels < levels.length) {
            const lw = Math.max(1, width >> usableLevels);
            const lh = Math.max(1, height >> usableLevels);
            const rgba = levels[usableLevels];
            if (!rgba || rgba.length < lw * lh * 4) break;
            usableLevels++;
        }
        if (usableLevels === 0) {
            Logger.warn(LogCategory.SYSTEM,
                `[Glide] uploadTexture handle=${handle}: level 0 is short (${levels[0]?.length ?? 0} bytes for ${width}x${height})`);
            return;
        }
        if (usableLevels < levels.length) {
            Logger.warn(LogCategory.SYSTEM,
                `[Glide] uploadTexture handle=${handle}: mip chain truncated to ${usableLevels}/${levels.length} levels`);
        }

        const mipLevelCount = usableLevels;
        let entry = this.textures.get(handle);
        if (entry && (entry.width !== width || entry.height !== height || entry.mipLevelCount !== mipLevelCount)) {
            entry.texture.destroy();
            this.textures.delete(handle);
            entry = undefined;
        }

        if (!entry) {
            const texture = device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                mipLevelCount,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            entry = {
                handle, texture, view: texture.createView(),
                width, height, format, mipLevelCount,
            };
            this.textures.set(handle, entry);
            this.invalidateBindGroupsFor(handle);
        } else {
            entry.format = format;
        }

        for (let level = 0; level < mipLevelCount; level++) {
            const lw = Math.max(1, width >> level);
            const lh = Math.max(1, height >> level);
            const rgba = levels[level]!;
            const unpaddedRow = lw * 4;
            const paddedRow = (unpaddedRow + 255) & ~255;
            if (paddedRow === unpaddedRow || lh === 1) {
                queue.writeTexture(
                    { texture: entry.texture, mipLevel: level }, rgba,
                    { bytesPerRow: unpaddedRow },
                    { width: lw, height: lh, depthOrArrayLayers: 1 },
                );
                continue;
            }
            const padded = paddedRow * lh;
            if (!this.textureUploadScratch || this.textureUploadScratch.length < padded) {
                this.textureUploadScratch = new Uint8Array(padded);
            }
            for (let y = 0; y < lh; y++) {
                this.textureUploadScratch.set(rgba.subarray(y * unpaddedRow, (y + 1) * unpaddedRow), y * paddedRow);
            }
            queue.writeTexture(
                { texture: entry.texture, mipLevel: level }, this.textureUploadScratch,
                { bytesPerRow: paddedRow },
                { width: lw, height: lh, depthOrArrayLayers: 1 },
            );
        }

        this.metrics.textureUploads++;
    }

    deleteTexture(handle: number): void {
        const existing = this.textures.get(handle);
        if (!existing) return;
        existing.texture.destroy();
        this.textures.delete(handle);
        this.invalidateBindGroupsFor(handle);
    }

    clearTextures(): void {
        for (const tex of this.textures.values()) {
            tex.texture.destroy();
        }
        this.textures.clear();
        this.bindGroupCache.clear();
    }

    executeFrame(input: GlideFrameInput): void {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        const context = this.backend.getContext();

        if (!device || !queue || !context) return;
        if (input.width <= 0 || input.height <= 0) return;

        // Fetched once and reused for both sizing (below) and the present blit (end of this
        // method) — getCurrentTexture() is meant to be called at most once per frame.
        const currentTexture = context.getCurrentTexture();
        const canvasW = currentTexture.width;
        const canvasH = currentTexture.height;

        this.renderScale = resolveInternalScaleFactor(
            EmulatorConfig.getInstance().quality.internalScale,
            input.width, input.height, canvasW, canvasH,
        );
        const scale = this.renderScale;
        // Rounded to integers: WebGPU texture/scissor extents are integer coordinates, and
        // "auto" (see resolveInternalScaleFactor) is a continuous best-fit, not a power of 2.
        const targetW = Math.round(input.width * scale);
        const targetH = Math.round(input.height * scale);
        this.ensureTargets(device, targetW, targetH);
        this.ensureGlobals(device);

        if (!this.offscreenTexture || !this.offscreenView || !this.depthView || !this.uniformBuffer) {
            return;
        }

        const encoder = device.createCommandEncoder();
        const stream = input.stream;

        const hasLfbPixels = !!input.lfbPixels && !input.lfbAfterDraws;
        let clearColor = unpackColorU32(input.clearColor);
        let clearDepth = normalizeDepth(input.clearDepth);
        let shouldClearColor = !this.hasRenderedFrame && !hasLfbPixels;
        let shouldClearDepth = true;

        const lfbOverFrame = !!input.lfbPixels && !!input.lfbAfterDraws;

        if (input.lfbPixels && !lfbOverFrame) {
            this.uploadLfbBackground(device, queue, encoder, input.lfbPixels, input.width, input.height, input.lfbVersion ?? -1, scale, targetW, targetH);
            shouldClearColor = false;
        }

        for (let i = 0; i < stream.commandCount; i++) {
            if (stream.commandTypeAt(i) !== Legacy3DCommandType.Clear) continue;
            const clearCmd = stream.getClearCommand(i);
            if (!clearCmd) continue;
            clearColor = unpackColorU32(clearCmd.color);
            clearDepth = normalizeDepth(clearCmd.depth);
            if (!hasLfbPixels) {
                shouldClearColor = clearCmd.clearColor || shouldClearColor;
            }
            shouldClearDepth = clearCmd.clearDepth;
            if (hasLfbPixels && clearCmd.clearColor) {
                if (this.metrics.frames < 240 || ((this.metrics.frames & 63) === 0)) {
                    Logger.warn(
                        LogCategory.SYSTEM,
                        `[Glide] executeFrame: ignoring color clear because LFB pixels are present (${input.width}x${input.height})`
                    );
                }
            }
            break;
        }

        const vertexCount = stream.getVertexCount();
        if (input.lfbPixels && vertexCount === 0 && shouldClearColor) {
            // In LFB-only video paths a queued clear is often intended to happen before CPU writes.
            // Clearing here would wipe the uploaded LFB frame and present black.
            Logger.warn(
                LogCategory.SYSTEM,
                `[Glide] executeFrame: suppressing clear over LFB-only frame (${input.width}x${input.height})`
            );
            shouldClearColor = false;
        }
        if (vertexCount > 0) {
            this.uploadVertices(queue, stream);
        }

        this.prepareUniformSlices(device, queue, input);

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.offscreenView,
                    clearValue: clearColor,
                    loadOp: shouldClearColor ? "clear" : "load",
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: this.depthView,
                depthClearValue: clearDepth,
                depthLoadOp: shouldClearDepth ? "clear" : "load",
                depthStoreOp: "store",
            },
        });

        if (this.vertexBuffer && vertexCount > 0) {
            renderPass.setVertexBuffer(0, this.vertexBuffer, 0, vertexCount * LEGACY3D_VERTEX_BYTES);

            const stride = this.uniformStride;
            const slice = this.drawSliceIndex;
            let curPipeline: GPURenderPipeline | null = null;
            let curBind: GPUBindGroup | null = null;
            let curSlice = -1;
            let curClipX0 = -1, curClipY0 = -1, curClipX1 = -1, curClipY1 = -1;
            let pendingFirst = -1;
            let pendingCount = 0;

            const lanes = stream.commands;
            for (let i = 0; i < stream.commandCount; i++) {
                const c = i * LEGACY3D_CMD_STRIDE;
                if (lanes[c + CI_TYPE] !== Legacy3DCommandType.Draw) continue;
                const first = lanes[c + CI_A] | 0;
                const count = lanes[c + CI_B] | 0;
                if (count <= 0) continue;

                const flags = lanes[c + CI_E] >>> 0;
                const useTexture = (flags & 1) !== 0;
                const cfg: GlidePipelineConfig = {
                    topology: TOPOLOGY_BY_ID[lanes[c + CI_C] | 0] ?? "triangle-list",
                    useTexture,
                    blendEnabled: (flags & (1 << 1)) !== 0,
                    blend: lanes[c + CI_K] >>> 0,
                    depthTestEnabled: (flags & (1 << 2)) !== 0,
                    depthWriteEnabled: (flags & (1 << 3)) !== 0,
                    depthFunction: (flags >>> 8) & 0x7,
                    cullMode: lanes[c + CI_G] >>> 0,
                    colorWriteMask:
                        ((flags & (1 << 11)) !== 0 ? (GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE) : 0) |
                        ((flags & (1 << 12)) !== 0 ? GPUColorWrite.ALPHA : 0),
                };

                const pipeline = this.getPipeline(device, cfg);
                const bindGroup = this.getBindGroup(
                    device,
                    lanes[c + CI_D] | 0,
                    useTexture,
                    (flags & (1 << 5)) !== 0,
                    (flags & (1 << 6)) !== 0,
                    (flags & (1 << 7)) !== 0,
                    (flags & (1 << 13)) !== 0,
                );
                const sliceIndex = slice[i];

                // grClipWindow is a rasterizer clip, not a transform: pixels outside it are
                // simply not written. Compared field by field — a 640x480 window does not
                // fit four values into one 32-bit key, and a colliding key would silently
                // merge draws that clip differently.
                const clipX0 = Math.max(0, Math.min(input.width, lanes[c + CI_CLIP_X0] | 0));
                const clipY0 = Math.max(0, Math.min(input.height, lanes[c + CI_CLIP_Y0] | 0));
                const clipX1 = Math.max(clipX0, Math.min(input.width, lanes[c + CI_CLIP_X1] | 0));
                const clipY1 = Math.max(clipY0, Math.min(input.height, lanes[c + CI_CLIP_Y1] | 0));
                const clipSame = clipX0 === curClipX0 && clipY0 === curClipY0
                    && clipX1 === curClipX1 && clipY1 === curClipY1;

                // Glide titles emit one triangle per grDrawTriangle, so a frame is thousands
                // of 3-vertex draws that differ in nothing. Vertices already sit contiguously
                // in the order they were pushed, so an identical (pipeline, bind group,
                // uniform slice) run is one draw call.
                if (
                    pipeline === curPipeline && bindGroup === curBind && sliceIndex === curSlice &&
                    clipSame && first === pendingFirst + pendingCount
                ) {
                    pendingCount += count;
                    this.metrics.mergedDraws++;
                    continue;
                }

                if (pendingCount > 0) {
                    renderPass.draw(pendingCount, 1, pendingFirst, 0);
                    this.metrics.draws++;
                }

                if (pipeline !== curPipeline) {
                    renderPass.setPipeline(pipeline);
                    curPipeline = pipeline;
                    this.metrics.pipelineSets++;
                }
                if (bindGroup !== curBind || sliceIndex !== curSlice) {
                    renderPass.setBindGroup(0, bindGroup, [sliceIndex * stride]);
                    curBind = bindGroup;
                    curSlice = sliceIndex;
                }
                if (!clipSame) {
                    // A degenerate window would be a validation error, and Glide's own
                    // default is the whole screen — fall back to it rather than refuse.
                    const w = clipX1 - clipX0, h = clipY1 - clipY0;
                    if (w > 0 && h > 0) {
                        // Rounded independently per edge (not derived from a single rounded
                        // w/h) — a non-integer "auto" scale can then leave neighbouring clip
                        // rects up to 1px apart, an acceptable seam for a scissor edge.
                        renderPass.setScissorRect(
                            Math.round(clipX0 * scale), Math.round(clipY0 * scale),
                            Math.round(w * scale), Math.round(h * scale));
                    } else {
                        renderPass.setScissorRect(0, 0, targetW, targetH);
                    }
                    curClipX0 = clipX0; curClipY0 = clipY0; curClipX1 = clipX1; curClipY1 = clipY1;
                }
                pendingFirst = first;
                pendingCount = count;
            }

            if (pendingCount > 0) {
                renderPass.draw(pendingCount, 1, pendingFirst, 0);
                this.metrics.draws++;
            }
        }

        renderPass.end();

        if (lfbOverFrame && input.lfbPixels) {
            this.copyLfbOverFrame(device, queue, encoder, input.lfbPixels, input.width, input.height, scale, targetW, targetH);
        }

        // currentTexture was fetched once at the top of this method (see there for why).
        const targetView = currentTexture.createView();
        // No explicit viewport: leaving it undefined makes WebGPU use the render target's
        // own full extent (the canvas), matching the canonical present call every other
        // backend uses (ddraw/presenter.ts) instead of clipping to the GUEST's logical size.
        // `present:{srcW,srcH,outW,outH}` is what lets PostFxChain's aspectMode/integerScale
        // (and FXAA texel sizing) do real work here — offscreen (targetW x targetH, which
        // may now be supersampled) fit into the canvas (canvasW x canvasH), rather than
        // src===out always making that scaling math a no-op.
        this.backend.drawTexture(
            this.offscreenView,
            targetView,
            encoder,
            true,
            undefined,
            undefined,
            { r: 0, g: 0, b: 0, a: 1 },
            undefined,
            { srcW: targetW, srcH: targetH, outW: canvasW, outH: canvasH, toCanvas: true },
        );

        if (input.videoOverlayCanvas) {
            this.backend.blit(input.videoOverlayCanvas, targetView, encoder);
        }

        // GDI overlay per the shared plan (input.gdiOverlayRects): undefined = whole overlay
        // (windowed); [] = nothing (game owns screen, no live dialog); [rects] = only live
        // modal dialog rects composited over the Glide frame.
        if (input.gdiOverlayCanvas) {
            const rects = input.gdiOverlayRects;
            if (rects === undefined) {
                this.backend.blit(input.gdiOverlayCanvas, targetView, encoder);
            } else if (rects.length) {
                this.backend.blitRects(input.gdiOverlayCanvas, targetView, encoder, rects);
            }
        }

        // Stats overlay
        if (statsOverlay.isEnabled()) {
            const statsCanvas = statsOverlay.getCanvas();
            if (statsCanvas) {
                if (statsOverlay.isDirty()) {
                    this.backend.updateStatsTexture(statsCanvas);
                    statsOverlay.clearDirty();
                }
                this.backend.renderStatsOverlay(targetView, encoder);
            }
        }

        queue.submit([encoder.finish()]);
        this.captureFramebufferMirror(device, queue);

        this.metrics.frames++;
        this.hasRenderedFrame = true;
    }

    /**
     * Upload the LFB image as the frame's background.
     *
     * The presenter hands us logical RGBA and the offscreen is usually bgra8unorm,
     * so the bytes need a channel swap — 307k pixels of it, every present. The LFB
     * image changes far less often than the frame does (a title that writes it once
     * a scene still gets a fresh 3D frame drawn over it), so stage the swapped copy
     * and re-swap only when the guest actually changed the image.
     */
    private uploadLfbBackground(
        device: GPUDevice,
        queue: GPUQueue,
        encoder: GPUCommandEncoder,
        pixels: Uint8Array,
        width: number,
        height: number,
        version: number,
        scale: number,
        targetW: number,
        targetH: number,
    ): void {
        if (!this.offscreenTexture) return;
        // At scale 1 the LFB IS the target's size, so it goes straight in — the byte
        // path below is unchanged. Scaled, it must be resampled instead of landing in
        // the target's top-left corner, so it lands in a guest-sized texture first.
        const dest = scale === 1 ? this.offscreenTexture : this.ensureLfbScaleTexture(device, width, height);
        if (!dest) return;
        const format = this.backend.getFormat() ?? "bgra8unorm";
        const bgra = format === "bgra8unorm";
        const unpaddedRow = width * 4;
        const paddedRow = (unpaddedRow + 255) & ~255;
        const needsPadding = paddedRow !== unpaddedRow && height > 1;

        if (!bgra && !needsPadding) {
            queue.writeTexture({ texture: dest }, pixels,
                { bytesPerRow: unpaddedRow }, { width, height, depthOrArrayLayers: 1 });
            this.lfbUploadedVersion = -1; // nothing staged
            this.blitLfbScaled(encoder, scale, targetW, targetH);
            return;
        }

        const stagedBytes = needsPadding ? paddedRow * height : width * height * 4;
        if (!this.lfbUploadScratch || this.lfbUploadScratch.length < stagedBytes) {
            this.lfbUploadScratch = new Uint8Array(stagedBytes);
            this.lfbUploadedVersion = -1;
        }
        const staged = this.lfbUploadScratch;

        // The cache key is the version AND the layout it was staged at. A version alone
        // is not enough: a resolution change can keep the version while changing the
        // pitch, and shrinking reuses an oversized scratch, so the stale large-pitch
        // image would be re-uploaded as though it were the new small one.
        const layoutChanged = width !== this.lfbStagedWidth
            || height !== this.lfbStagedHeight
            || paddedRow !== this.lfbStagedPitch
            || bgra !== this.lfbStagedBgra;

        if (version < 0 || layoutChanged || version !== this.lfbUploadedVersion) {
            stageLfbRows(pixels, staged, unpaddedRow, needsPadding ? paddedRow : unpaddedRow, height, bgra);
            this.lfbUploadedVersion = version;
            this.lfbStagedWidth = width;
            this.lfbStagedHeight = height;
            this.lfbStagedPitch = paddedRow;
            this.lfbStagedBgra = bgra;
        }

        queue.writeTexture({ texture: dest }, staged,
            { bytesPerRow: needsPadding ? paddedRow : unpaddedRow },
            { width, height, depthOrArrayLayers: 1 });
        this.blitLfbScaled(encoder, scale, targetW, targetH);
    }

    /** Guest-sized staging for a scaled LFB image; null when the device refuses it. */
    private ensureLfbScaleTexture(device: GPUDevice, width: number, height: number): GPUTexture | null {
        if (this.lfbScaleSize?.width === width && this.lfbScaleSize.height === height && this.lfbScaleTexture) {
            return this.lfbScaleTexture;
        }
        this.lfbScaleTexture?.destroy();
        this.lfbScaleTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: this.backend.getFormat() ?? "bgra8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.lfbScaleView = this.lfbScaleTexture.createView();
        this.lfbScaleSize = { width, height };
        return this.lfbScaleTexture;
    }

    /** Resample the staged LFB image over the whole target. No-op at scale 1, where the
     *  image was written into the target directly. `targetW`/`targetH` are the SAME rounded
     *  extent ensureTargets() sized the offscreen texture to (executeFrame's targetW/targetH)
     *  — recomputing width*scale here instead would drift from that by a sub-pixel rounding
     *  delta at non-integer "auto" factors and leave a seam along one edge. */
    private blitLfbScaled(encoder: GPUCommandEncoder, scale: number, targetW: number, targetH: number): void {
        if (scale === 1 || !this.lfbScaleView || !this.offscreenView) return;
        this.backend.drawTexture(this.lfbScaleView, this.offscreenView, encoder, true, targetW, targetH);
    }

    /**
     * Replace the frame the pass just rendered with a post-process LFB image.
     *
     * This is a full-extent overwrite, not a blend: the guest's post-process owns
     * every pixel it locked, and Glide has no notion of compositing an LFB write
     * against the rasterizer's output.
     *
     * queue.writeTexture cannot express this: every queue write runs BEFORE the
     * submitted command buffer, so a writeTexture issued here would still land under
     * the draws. copyBufferToTexture is encoded, so it keeps its place in the stream.
     */
    private copyLfbOverFrame(
        device: GPUDevice,
        queue: GPUQueue,
        encoder: GPUCommandEncoder,
        pixels: Uint8Array,
        width: number,
        height: number,
        scale: number,
        targetW: number,
        targetH: number,
    ): void {
        if (!this.offscreenTexture) return;
        const dest = scale === 1 ? this.offscreenTexture : this.ensureLfbScaleTexture(device, width, height);
        if (!dest) return;
        const paddedRow = Math.ceil(width * 4 / 256) * 256;
        const bytes = paddedRow * height;
        if (!this.lfbStagingBuffer || this.lfbStagingBytes < bytes) {
            this.lfbStagingBuffer?.destroy();
            this.lfbStagingBuffer = device.createBuffer({
                size: bytes,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });
            this.lfbStagingBytes = bytes;
        }
        // Its own staging: the background path caches a swizzled copy across frames
        // and keys a version off it, so sharing one buffer would silently invalidate it.
        if (!this.lfbOverlayScratch || this.lfbOverlayScratch.length < bytes) {
            this.lfbOverlayScratch = new Uint8Array(bytes);
        }
        const staging = this.lfbOverlayScratch;
        const bgra = (this.backend.getFormat() ?? "bgra8unorm").startsWith("bgra");
        for (let y = 0; y < height; y++) {
            const src = y * width * 4;
            const dst = y * paddedRow;
            if (!bgra) {
                staging.set(pixels.subarray(src, src + width * 4), dst);
                continue;
            }
            for (let x = 0; x < width; x++) {
                const s = src + x * 4;
                const d = dst + x * 4;
                staging[d] = pixels[s + 2] ?? 0;
                staging[d + 1] = pixels[s + 1] ?? 0;
                staging[d + 2] = pixels[s] ?? 0;
                staging[d + 3] = 255;
            }
        }
        queue.writeBuffer(this.lfbStagingBuffer, 0, staging, 0, bytes);
        encoder.copyBufferToTexture(
            { buffer: this.lfbStagingBuffer, bytesPerRow: paddedRow },
            { texture: dest },
            { width, height, depthOrArrayLayers: 1 },
        );
        this.blitLfbScaled(encoder, scale, targetW, targetH);
    }

    private captureFramebufferMirror(device: GPUDevice, queue: GPUQueue): void {
        if (!this.mirrorEnabled || this.mirrorInFlight) return;
        if (!this.offscreenTexture || !this.offscreenSize) return;

        const { width, height } = this.offscreenSize;
        const paddedRow = Math.ceil(width * 4 / 256) * 256;
        const bytes = paddedRow * height;
        if (!this.mirrorBuffer || this.mirrorBufferBytes < bytes) {
            this.mirrorBuffer?.destroy();
            this.mirrorBuffer = device.createBuffer({
                size: bytes,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            this.mirrorBufferBytes = bytes;
        }
        const buffer = this.mirrorBuffer;

        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: this.offscreenTexture },
            { buffer, bytesPerRow: paddedRow },
            { width, height, depthOrArrayLayers: 1 },
        );
        queue.submit([encoder.finish()]);

        this.mirrorInFlight = true;
        const bgra = (this.backend.getFormat() ?? "bgra8unorm").startsWith("bgra");
        const gen = this.disposeGeneration;
        void buffer.mapAsync(GPUMapMode.READ).then(() => {
            if (gen !== this.disposeGeneration) {
                // Disposed while this was in flight: dispose() deliberately left the
                // buffer alone because it was mapped, so destroying it is ours to do.
                buffer.unmap();
                buffer.destroy();
                return;
            }
            const mapped = new Uint8Array(buffer.getMappedRange());
            if (!this.mirrorRgba || this.mirrorRgba.length !== width * height * 4) {
                this.mirrorRgba = new Uint8Array(width * height * 4);
            }
            const out = this.mirrorRgba;
            for (let y = 0; y < height; y++) {
                const src = y * paddedRow;
                const dst = y * width * 4;
                if (!bgra) {
                    out.set(mapped.subarray(src, src + width * 4), dst);
                    continue;
                }
                for (let x = 0; x < width; x++) {
                    const s = src + x * 4;
                    const d = dst + x * 4;
                    out[d] = mapped[s + 2]!;
                    out[d + 1] = mapped[s + 1]!;
                    out[d + 2] = mapped[s]!;
                    out[d + 3] = 255;
                }
            }
            this.mirrorSize = { width, height };
            buffer.unmap();
        }).catch(() => {
            // A lost device or a destroyed buffer: the mirror simply stays at its
            // last good frame rather than taking the frame loop down with it.
        }).finally(() => {
            // Only the generation that started this readback owns the flag; a later
            // executor must not have its in-flight state cleared by an old callback.
            if (gen === this.disposeGeneration) this.mirrorInFlight = false;
        });
    }

    async captureFrame(): Promise<Blob> {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!device || !queue || !this.offscreenTexture || !this.offscreenSize) {
            return new Blob();
        }

        const width = this.offscreenSize.width;
        const height = this.offscreenSize.height;
        const bytesPerPixel = 4;
        const rowBytes = width * bytesPerPixel;
        const paddedRowBytes = Math.ceil(rowBytes / 256) * 256;
        const readbackSize = paddedRowBytes * height;

        const readback = device.createBuffer({
            size: readbackSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: this.offscreenTexture },
            { buffer: readback, bytesPerRow: paddedRowBytes },
            { width, height, depthOrArrayLayers: 1 },
        );

        queue.submit([encoder.finish()]);
        await queue.onSubmittedWorkDone();

        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const pixels = new Uint8ClampedArray(width * height * bytesPerPixel);
        // The offscreen carries the canvas's preferred format (bgra8unorm on most desktops)
        // while ImageData is always RGBA — copying rows straight through hands back a
        // red/blue-swapped frame that still looks plausible. Same swizzle the screen route
        // (WebGPUBackend.captureScreen) applies; the two must not disagree about colour.
        // Alpha forced opaque, as on the screen route (WebGPUBackend.captureMirroredFrame):
        // this offscreen is the swap-chain image and the canvas is alphaMode:"opaque", so its
        // alpha is not coverage. Carried into ImageData it premultiplies the picture away and
        // the capture returns a transparent PNG that reads as a plausible black frame.
        const swapRB = (this.backend.getFormat() ?? "bgra8unorm") === "bgra8unorm";
        for (let y = 0; y < height; y++) {
            const src = y * paddedRowBytes;
            const dst = y * rowBytes;
            for (let x = 0, s = src, d = dst; x < width; x++, s += 4, d += 4) {
                pixels[d] = mapped[s + (swapRB ? 2 : 0)]!;
                pixels[d + 1] = mapped[s + 1]!;
                pixels[d + 2] = mapped[s + (swapRB ? 0 : 2)]!;
                pixels[d + 3] = 255;
            }
        }
        readback.unmap();
        readback.destroy();

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return new Blob();
        }
        ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
        return canvas.convertToBlob({ type: "image/png" });
    }

    destroy(): void {
        this.clearTextures();

        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
            this.vertexBuffer = null;
            this.vertexBufferSize = 0;
        }

        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
            this.uniformBuffer = null;
        }

        if (this.whiteTexture) {
            this.whiteTexture.destroy();
            this.whiteTexture = null;
            this.whiteTextureView = null;
        }

        if (this.offscreenTexture) {
            this.offscreenTexture.destroy();
            this.offscreenTexture = null;
            this.offscreenView = null;
        }

        if (this.depthTexture) {
            this.depthTexture.destroy();
            this.depthTexture = null;
            this.depthView = null;
        }

        if (this.lfbScaleTexture) {
            this.lfbScaleTexture.destroy();
            this.lfbScaleTexture = null;
            this.lfbScaleView = null;
            this.lfbScaleSize = null;
        }

        this.samplers.clear();

        // An in-flight readback still holds the buffer mapped; its callback sees the
        // bumped generation and destroys it there.
        this.disposeGeneration++;
        if (this.mirrorBuffer && !this.mirrorInFlight) {
            this.mirrorBuffer.destroy();
        }
        this.mirrorInFlight = false;
        this.lfbStagingBuffer?.destroy();
        this.lfbStagingBuffer = null;
        this.lfbStagingBytes = 0;
        this.mirrorBuffer = null;
        this.mirrorBufferBytes = 0;
        this.mirrorRgba = null;
        this.mirrorSize = null;

        this.uniformStaging = null;
        this.uniformStagingView = null;
        this.bindGroupLayout = null;
        this.pipelineLayout = null;
        this.uniformStride = 0;

        this.offscreenSize = null;
        this.pipelineFactory?.clear();
        this.pipelineFactory = null;
        this.bindGroupCache.clear();
    }

    private ensureTargets(device: GPUDevice, width: number, height: number): void {
        const sameSize = this.offscreenSize && this.offscreenSize.width === width && this.offscreenSize.height === height;
        if (sameSize && this.offscreenTexture && this.depthTexture) {
            return;
        }

        if (this.offscreenTexture) this.offscreenTexture.destroy();
        if (this.depthTexture) this.depthTexture.destroy();

        this.offscreenTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: this.backend.getFormat() ?? "bgra8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.offscreenView = this.offscreenTexture.createView();

        this.depthTexture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthView = this.depthTexture.createView();

        this.offscreenSize = { width, height };
        // The new offscreen holds none of the staged LFB image.
        this.lfbUploadedVersion = -1;
    }

    private ensureGlobals(device: GPUDevice): void {
        if (!this.uniformStride) {
            const align = device.limits.minUniformBufferOffsetAlignment || 256;
            this.uniformStride = Math.ceil(GLIDE_UNIFORM_SIZE / align) * align;
        }
        if (!this.bindGroupLayout) {
            // Binding 1/2 stay declared even for the untextured shader variant: a bind group
            // layout may carry entries the shader does not read, and one layout is what lets
            // a single bind group cache serve every pipeline.
            this.bindGroupLayout = device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: GLIDE_UNIFORM_SIZE },
                    },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                ],
            });
            this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
        }
        // executeFrame bails when the uniform buffer is missing, so it must exist before
        // the first frame — prepareUniformSlices only ever GROWS it.
        this.ensureUniformCapacity(device, 256);

        // Ensure default sampler (clamp, clamp, linear) exists; other variants created lazily.
        this.getSampler(device, true, true, true);

        if (!this.whiteTexture) {
            this.whiteTexture = device.createTexture({
                size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.backend.getQueue()?.writeTexture(
                { texture: this.whiteTexture },
                new Uint8Array([255, 255, 255, 255]),
                { bytesPerRow: 4 },
                { width: 1, height: 1, depthOrArrayLayers: 1 },
            );
            this.whiteTextureView = this.whiteTexture.createView();
        }
    }

    private getPipeline(device: GPUDevice, config: GlidePipelineConfig): GPURenderPipeline {
        const format = this.backend.getFormat() ?? "bgra8unorm";
        if (!this.pipelineFactory) {
            this.pipelineFactory = new GlidePipelineFactory(device, format, this.pipelineLayout!);
        }
        return this.pipelineFactory.getOrCreate(config);
    }

    private uploadVertices(queue: GPUQueue, stream: GlideFrameInput["stream"]): void {
        const required = stream.vertexBytesUsed();
        if (required <= 0) return;

        const device = this.backend.getDevice();
        if (!device) return;

        if (!this.vertexBuffer || this.vertexBufferSize < required) {
            if (this.vertexBuffer) {
                this.vertexBuffer.destroy();
            }
            this.vertexBufferSize = Math.max(required, 64 * 1024);
            this.vertexBuffer = device.createBuffer({
                size: this.vertexBufferSize,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }

        // The stream already stages vertices in the buffer's own layout, so the
        // upload is a straight copy — no repack, no scratch.
        // The view, not its ArrayBuffer: writing the buffer is only correct while
        // vertexFloats happens to start at offset 0, and nothing here can see that.
        queue.writeBuffer(this.vertexBuffer, 0, stream.vertexFloats, 0, required / 4);
    }

    /**
     * Build one uniform slice per DISTINCT per-draw state and upload them all with a
     * single writeBuffer, before the pass is encoded.
     *
     * A queue.writeBuffer issued between two encoded draws does NOT land between them:
     * every queue write runs before the submitted command buffer, so a single-offset
     * uniform buffer written per draw hands the WHOLE frame the LAST draw's combine,
     * constant colour, alpha test and fog. The dynamic-offset slice is what makes
     * per-draw state actually per-draw.
     */
    private prepareUniformSlices(device: GPUDevice, queue: GPUQueue, input: GlideFrameInput): void {
        const stream = input.stream;
        const cmdCount = stream.commandCount;
        if (this.drawSliceIndex.length < cmdCount) {
            this.drawSliceIndex = new Int32Array(Math.max(cmdCount, 1024));
        }

        const stride = this.uniformStride;
        let slices = 0;
        let pAlphaRef = -1, pAlphaFunc = -1, pConst = -1, pFogMode = -1, pFogColor = -1;
        let pColorCombine = -1, pAlphaCombine = -1, pTexture = -2;

        const lanes = stream.commands;
        for (let i = 0; i < cmdCount; i++) {
            const c = i * LEGACY3D_CMD_STRIDE;
            if (lanes[c + CI_TYPE] !== Legacy3DCommandType.Draw) continue;
            if ((lanes[c + CI_B] | 0) <= 0) continue;

            const alphaRef = lanes[c + CI_F] >>> 0;
            const constantColor = lanes[c + CI_H] >>> 0;
            const colorCombine = lanes[c + CI_I] >>> 0;
            const alphaCombine = lanes[c + CI_J] >>> 0;
            const fogColor = lanes[c + CI_L] >>> 0;
            const fogPacked = lanes[c + CI_M] >>> 0;
            const fogMode = fogPacked & 0xffff;
            const alphaFunc = (fogPacked >>> 16) & 0x7;
            // The bound texture selects texCoordScale: Glide's s spans 0..255 across the
            // LONG axis whatever the LOD, so a non-square texture needs the short axis
            // scaled by the aspect ratio.
            const texture = (lanes[c + CI_E] & 1) !== 0 ? (lanes[c + CI_D] | 0) : -1;

            const same =
                slices > 0 &&
                alphaRef === pAlphaRef && alphaFunc === pAlphaFunc && constantColor === pConst &&
                fogMode === pFogMode && fogColor === pFogColor &&
                colorCombine === pColorCombine && alphaCombine === pAlphaCombine &&
                texture === pTexture;

            if (!same) {
                this.ensureUniformCapacity(device, slices + 1);
                this.fillUniformSlice(slices * stride, input, {
                    alphaRef, alphaTestFunc: alphaFunc, constantColor,
                    fogMode, fogColor, colorCombine, alphaCombine, textureHandle: texture,
                });
                slices++;
                pAlphaRef = alphaRef; pAlphaFunc = alphaFunc; pConst = constantColor;
                pFogMode = fogMode; pFogColor = fogColor;
                pColorCombine = colorCombine; pAlphaCombine = alphaCombine;
                pTexture = texture;
            }
            this.drawSliceIndex[i] = slices - 1;
        }

        this.metrics.uniformSlices = slices;
        if (slices > 0 && this.uniformBuffer && this.uniformStaging) {
            queue.writeBuffer(this.uniformBuffer, 0, this.uniformStaging, 0, slices * stride);
        }
    }

    private ensureUniformCapacity(device: GPUDevice, slices: number): void {
        const stride = this.uniformStride;
        const required = slices * stride;
        if (!this.uniformStaging || this.uniformStaging.byteLength < required) {
            const grown = Math.max(required, (this.uniformStaging?.byteLength ?? 0) * 2, stride * 256);
            const next = new ArrayBuffer(grown);
            if (this.uniformStaging) {
                new Uint8Array(next).set(new Uint8Array(this.uniformStaging));
            }
            this.uniformStaging = next;
            this.uniformStagingView = new DataView(next);
        }
        if (!this.uniformBuffer || this.uniformBuffer.size < required) {
            this.uniformBuffer?.destroy();
            this.uniformBuffer = device.createBuffer({
                size: Math.max(required, this.uniformStaging.byteLength),
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            // The buffer object changed identity — every cached bind group still points at
            // the old one.
            this.bindGroupCache.clear();
        }
    }

    private fillUniformSlice(
        base: number,
        input: GlideFrameInput,
        draw: {
            alphaRef: number;
            alphaTestFunc: number;
            constantColor: number;
            fogMode: number;
            fogColor: number;
            colorCombine: number;
            alphaCombine: number;
            textureHandle: number;
        },
    ): void {
        const v = this.uniformStagingView;
        if (!v) return;

        const c = unpackColorU32(draw.constantColor);
        const k = unpackColorU32(input.chromaKey);
        const fog = unpackColorU32(draw.fogColor);

        // Glide texel-center convention: for an N-texel LOD, texel k's center sits at
        // sow = (k + 0.5) * (256/N). Normalizing by 1/256 makes every sow hit a texel
        // center cleanly; 1/255 would bleed past the last texel and wrap, seaming tiles.
        //
        // That 1/256 is the LONG axis. Glide's s/t span 0..255 across the longer side
        // regardless of LOD, and the shorter side is scaled by the aspect ratio (see the
        // 3dfx SDK's view3df.c, whose smult/tmult depend on aspect and not on size), so a
        // 64x16 texture takes t only up to 63. One scale for both axes stretches every
        // non-square texture by its aspect ratio.
        const tex = draw.textureHandle >= 0 ? this.textures.get(draw.textureHandle) : undefined;
        const scale = tex ? glideTexCoordScale(tex.width, tex.height) : { x: 1 / 256, y: 1 / 256 };

        v.setFloat32(base + 0, input.width, true);
        v.setFloat32(base + 4, input.height, true);
        v.setFloat32(base + 8, Math.max(0, Math.min(255, draw.alphaRef >>> 0)), true);
        v.setUint32(base + 12, draw.alphaTestFunc >>> 0, true);
        v.setFloat32(base + 16, c.r, true);
        v.setFloat32(base + 20, c.g, true);
        v.setFloat32(base + 24, c.b, true);
        v.setFloat32(base + 28, c.a, true);
        v.setFloat32(base + 32, k.r, true);
        v.setFloat32(base + 36, k.g, true);
        v.setFloat32(base + 40, k.b, true);
        v.setFloat32(base + 44, k.a, true);
        v.setFloat32(base + 48, scale.x, true);
        v.setFloat32(base + 52, scale.y, true);
        v.setUint32(base + 56, input.chromaKeyEnabled ? 1 : 0, true);
        v.setUint32(base + 60, draw.fogMode >>> 0, true);
        v.setFloat32(base + 64, fog.r, true);
        v.setFloat32(base + 68, fog.g, true);
        v.setFloat32(base + 72, fog.b, true);
        v.setFloat32(base + 76, fog.a, true);
        v.setUint32(base + 80, draw.colorCombine >>> 0, true);
        v.setUint32(base + 84, draw.alphaCombine >>> 0, true);
        const gamma = Number.isFinite(input.gammaCorrection) ? Math.max(0.01, input.gammaCorrection) : 1.0;
        v.setFloat32(base + 88, gamma, true);
        v.setUint32(base + 92, 0, true);

        const table = input.fogTable;
        for (let i = 0; i < 64; i++) {
            v.setFloat32(base + GLIDE_UNIFORM_FOGTABLE_OFFSET + i * 4, (table[i] ?? 0) / 255, true);
        }
    }

    private getSampler(
        device: GPUDevice, clampS: boolean, clampT: boolean, linear: boolean, mipMap = false,
    ): GPUSampler {
        const key = (clampS ? 1 : 0) | (clampT ? 2 : 0) | (linear ? 4 : 0) | (mipMap ? 8 : 0);
        let sampler = this.samplers.get(key);
        if (sampler) return sampler;
        const filter: GPUFilterMode = linear ? "linear" : "nearest";
        sampler = device.createSampler({
            magFilter: filter,
            minFilter: filter,
            mipmapFilter: filter,
            // GR_MIPMAP_DISABLE pins the TMU to the largest LOD, whatever levels are resident.
            lodMinClamp: 0,
            lodMaxClamp: mipMap ? 32 : 0,
            addressModeU: clampS ? "clamp-to-edge" : "repeat",
            addressModeV: clampT ? "clamp-to-edge" : "repeat",
        });
        this.samplers.set(key, sampler);
        return sampler;
    }

    /**
     * Drop only the bind groups that name this texture. A blanket clear here would
     * re-create EVERY bind group on every grTexDownloadMipMap, and Glide titles
     * re-download textures continuously — the cache would never hit.
     */
    private invalidateBindGroupsFor(handle: number): void {
        // Must mirror bindGroupCacheKey's arithmetic exactly, or a texture's entries
        // survive its deletion and the next draw samples a destroyed texture.
        const base = (handle + 2) * 16;
        for (let sampler = 0; sampler < 16; sampler++) {
            this.bindGroupCache.delete(base + sampler);
        }
    }

    private getBindGroup(
        device: GPUDevice,
        textureHandle: number,
        useTexture: boolean,
        clampS: boolean,
        clampT: boolean,
        filterLinear: boolean,
        mipMap: boolean,
    ): GPUBindGroup {
        if (!this.uniformBuffer || !this.bindGroupLayout) {
            throw new Error("GlideBackendExecutor: uniform buffer is not initialized");
        }

        const samplerKey = (clampS ? 1 : 0) | (clampT ? 2 : 0) | (filterLinear ? 4 : 0) | (mipMap ? 8 : 0);
        // Untextured draws still bind the white 1x1 through the shared layout, so they
        // collapse onto one cache entry whatever sampler state the guest left behind.
        const textureKey = useTexture && this.textures.has(textureHandle) ? textureHandle : -1;
        // Multiply rather than shift: a handle only has to reach 2^27 for `<< 4` to
        // wrap into the sign bit and alias two textures onto one entry. Slot 0 is
        // reserved for the untextured case so it cannot collide with a textured draw
        // whose handle went missing.
        const cacheKey = useTexture ? (textureKey + 2) * 16 + samplerKey : 0;

        const cached = this.bindGroupCache.get(cacheKey);
        if (cached) {
            this.metrics.bindGroupHits++;
            return cached;
        }
        this.metrics.bindGroupMisses++;

        const view = (textureKey >= 0 ? this.textures.get(textureHandle)?.view : null) ?? this.whiteTextureView;
        if (!view) {
            throw new Error("GlideBackendExecutor: texture resources are not initialized");
        }
        const sampler = this.getSampler(device, clampS, clampT, useTexture && filterLinear, useTexture && mipMap);

        const bindGroup = device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: GLIDE_UNIFORM_SIZE } },
                { binding: 1, resource: sampler },
                { binding: 2, resource: view },
            ],
        });
        this.bindGroupCache.set(cacheKey, bindGroup);
        return bindGroup;
    }
}
