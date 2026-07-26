/**
 * D3D9BackendExecutor - Executes render frames on the WebGPU backend
 *
 * Separated from D3D9Device to isolate GPU-specific code
 * and enable potential backend switching in the future.
 */

import { WebGPUBackend } from "../webgpu-backend";
import { RenderFrame, RenderCommandType, ProgrammableDrawState, FfpDrawState } from "../render-frame";
import { frameProfiler } from "../../../core/frame-profiler";
import { statsOverlay } from "../../../core/stats-overlay";
import { PROG_BIND } from "./shader";
import { d3d9WasmArena, ArenaCommandType } from "./d3d9-wasm-arena";
import { FFP_UNIFORM_BYTES } from "./ffp-lighting";

export interface PipelineInfo {
    pipeline: GPURenderPipeline;
    hasTexture: boolean;
    /** Programmable (VS/PS) pipelines bind via per-draw BindProgrammable. */
    programmable: boolean;
}

const UNIFORM_ALIGN = 256;
function alignUp(n: number, a: number): number { return Math.ceil(n / a) * a; }

// Fixed binding window for the dynamic-offset programmable uniform bindings.
// Sized to the worst case (VS: 256 vec4, PS: 224 vec4). A draw's actual block is
// usually far smaller; the shader reads only the constants it declares from the
// front of the window, so over-binding is harmless. Fixing the window size lets a
// single cached bind group serve every draw of a material — only the dynamic
// offset varies per draw (see bindProgrammable / acquireProgBindGroup).
const VS_BIND_SIZE = 256 * 4 * 4; // 4096 bytes
const PS_BIND_SIZE = 224 * 4 * 4; // 3584 bytes
// Material-keyed programmable bind-group cache slots (default; __progCacheN overrides).
// Sized to hold a full track/level material working set: slots grow on demand
// (progCacheLen), so small sets scan short regardless of the cap; an undersized cap
// round-robin-thrashes and pays createBindGroup + GC on every evicted re-reference.
const PROG_CACHE_N = 1024;
const PROG_CONST_CACHE_N = 64;    // frame-local per-draw constant dynamic-offset cache slots

// FFP per-draw binding, dynamic-offset shape (boot flag __ffpDynOffset).
// The FFP uniform block is a fixed-layout struct (ffp-lighting.ts owns it), so the
// binding window is exactly its size and never varies per draw — which is what lets a
// bind group be cached across draws with only the offset supplied at setBindGroup,
// exactly as the programmable path does. Without it the FFP pipeline uses an implicit
// ("auto") layout, where hasDynamicOffset cannot be declared and every FFP draw must
// therefore build a throwaway bind group.
const FFP_BIND_SIZE = FFP_UNIFORM_BYTES;
const FFP_CACHE_N = 256;          // (sampler, texture) pairs — an FFP frame's material set is small

/** A growable per-frame uniform ring written at 256-aligned offsets. */
class UniformArena {
    buffer: GPUBuffer | null = null;
    private capacity = 0;
    private cursor = 0;

    constructor(private device: GPUDevice, private label: string) {}

    /** Ensure capacity (recreate if needed) and reset the write cursor. */
    begin(needed: number): void {
        const want = Math.max(needed, 256);
        if (!this.buffer || this.capacity < want) {
            this.buffer?.destroy();
            this.capacity = alignUp(want * 2, UNIFORM_ALIGN);
            this.buffer = this.device.createBuffer({
                label: this.label,
                size: this.capacity,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }
        this.cursor = 0;
    }

    /** Bump-write the first `floatLen` floats of `data` (zero-alloc), returning the
     *  256-aligned byte offset used as the per-draw dynamic offset. */
    write(queue: GPUQueue, data: Float32Array, floatLen: number): number {
        const size = Math.max(16, floatLen * 4);
        const offset = this.cursor;
        if (floatLen > 0) {
            // Typed-array overload: dataOffset and size are in ELEMENTS, not bytes.
            queue.writeBuffer(this.buffer!, offset, data, 0, floatLen);
        }
        this.cursor = alignUp(offset + size, UNIFORM_ALIGN);
        return offset;
    }
}

export interface UniformData {
    viewportWidth: number;
    viewportHeight: number;
    mvp: Float32Array;
    /** Expanded fixed-function uniform block (viewport + MVP + worldView + material/lights +
     *  global ambient + control flags). Layout owned by d3d9/ffp-lighting.ts. The FFP shader
     *  path binds this whole block at @binding(0); the programmable path ignores it. */
    ffpBlock?: Float32Array;
    /** When a vertex shader is active, this contains c0..cN constant registers */
    vsConstants?: Float32Array;
    /** Number of vec4 constant registers to upload (determines buffer size) */
    vsConstantCount?: number;
}

export class D3D9BackendExecutor {
    private backend: WebGPUBackend;
    private pipelines: GPURenderPipeline[] = [];
    private pipelineInfo: PipelineInfo[] = [];

    // Optimization caches
    private currentPipelineId: number | null = null;
    private bindGroupCache: Map<string, { bindGroup: GPUBindGroup; textureView: GPUTextureView | null }> = new Map();
    private uniformBuffer: GPUBuffer | null = null;
    private uniformBufferSize = 0;
    private uniformData: Float32Array = new Float32Array(20);
    private sampler: GPUSampler | null = null;

    // Offscreen rendering
    private offscreenTexture: GPUTexture | null = null;
    private offscreenView: GPUTextureView | null = null;
    private depthTexture: GPUTexture | null = null;
    private depthView: GPUTextureView | null = null;
    private offscreenSize: { width: number; height: number } | null = null;
    // Snapshot of the last COMPLETE presented frame. The offscreen is rendered incrementally
    // across a game frame's multiple submitFrame() passes (a backbuffer clear flushes to it
    // before the scene is redrawn — e.g. when render-to-texture passes sit between the clear and
    // the scene), so mid-frame the offscreen is transiently black. repaintLastFrame() re-presents
    // THIS snapshot (updated only at actual present) instead of the work-in-progress offscreen, so
    // the canvas never flashes the black intermediate at the RAF rate. See NFSU cube-reflection flicker.
    private presentedTexture: GPUTexture | null = null;
    private hasPresented = false;

    // Fallback texture for when no texture is bound
    private fallbackTexture: GPUTexture | null = null;
    private fallbackTextureView: GPUTextureView | null = null;
    // Cube fallback (1×1×6) for cube-sampler stages with no bound texture.
    private fallbackCubeTexture: GPUTexture | null = null;
    private fallbackCubeView: GPUTextureView | null = null;

    // Performance metrics
    public metrics = {
        pipelineSets: 0,
        bindGroupSets: 0,
        bindGroupSetSkips: 0,
        bindGroupCacheHits: 0,
        drawCalls: 0,
        clearCalls: 0,
        progConstWrites: 0,
        progConstReuseHits: 0,
    };

    constructor(backend: WebGPUBackend) {
        this.backend = backend;
    }

    /**
     * Register a pipeline and return its ID
     */
    registerPipeline(pipeline: GPURenderPipeline, hasTexture: boolean, programmable = false): number {
        const id = this.pipelines.length;
        this.pipelines.push(pipeline);
        this.pipelineInfo.push({ pipeline, hasTexture, programmable });
        return id;
    }

    // ── Programmable (VS/PS) path ─────────────────────────────────────────
    // Bind-group/pipeline layouts vary only by the cube-sampler mask (which stages are
    // viewDimension:"cube" vs "2d"); cached per mask (mask 0 = the common all-2D layout).
    private progLayouts: Map<number, { bindGroupLayout: GPUBindGroupLayout; pipelineLayout: GPUPipelineLayout }> = new Map();
    private vsArena: UniformArena | null = null;
    private psArena: UniformArena | null = null;
    private ffpArena: UniformArena | null = null;

    // Material-keyed programmable bind-group cache. With dynamic offsets, the only
    // per-draw-varying part of the bind group is the uniform offset (passed at
    // setBindGroup), so a bind group can be reused across every draw sharing the
    // same (sampler + bound texture views). Direct compare on object identity →
    // correct-by-construction (a recreated view is a new object → miss → rebuild).
    // Invalidated only when an arena buffer is recreated (cached groups bind it).
    // Slot count is boot-time tunable (harness setWorkerFlag('__progCacheN', N) before
    // load_bundle) so capacity A/Bs need a reload, not a rebuild. Read once per executor.
    private readonly progCacheN = ((globalThis as Record<string, unknown>).__progCacheN as number >>> 0) || PROG_CACHE_N;
    private progCacheSampler: (GPUSampler | null)[] = [];
    private progCacheViews: (GPUTextureView | null)[] = new Array(this.progCacheN * PROG_BIND.MAX_TEX).fill(null);
    private progCacheGroup: GPUBindGroup[] = [];
    // Per-slot cube mask: a bind group built for one layout (cube mask) is incompatible with a
    // pipeline using a different mask, so the mask is part of the cache identity.
    private progCacheCubeMask: number[] = [];
    private progCacheLen = 0;
    private progCacheCursor = 0;
    // Hash index over the slots. Without it the lookup is a linear scan, so raising the slot
    // cap to fix the HIT RATE just converts the cost into scan length — at ~2k draws/frame
    // against a full 1024-slot cache that is millions of identity compares per frame, and it
    // made acquireProgBindGroup the hottest JS function in the worker.
    private progCacheHash: number[] = [];
    private progCacheIndex = new Map<number, number[]>();
    private gpuIds = new WeakMap<object, number>();
    private nextGpuId = 1;
    private progCacheVsBuffer: GPUBuffer | null = null;
    private progCachePsBuffer: GPUBuffer | null = null;
    /** Reused [vsOffset, psOffset] dynamic-offset scratch (avoids a per-draw array alloc). */
    private dynOffsets: number[] = [0, 0];
    private progVsConstVersion: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progVsConstLen: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progVsConstOffset: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progVsConstCount = 0;
    private progVsConstCursor = 0;
    private progPsConstVersion: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progPsConstLen: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progPsConstOffset: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progPsConstCount = 0;
    private progPsConstCursor = 0;
    private lastBoundBindGroup: GPUBindGroup | null = null;
    private lastBindOffset0 = -1;
    private lastBindOffset1 = -1;
    /** How many dynamic offsets the last bind carried (0/1/2). Part of the bind identity:
     *  an FFP bind (1 offset) must never false-hit a programmable one (2) on the same group. */
    private lastBindDynCount = 0;

    // ── FFP per-draw path, dynamic-offset shape ───────────────────────────
    // Boot-time flag (harness setWorkerFlag('__ffpDynOffset', true) before load_bundle): the
    // choice is baked into every FFP pipeline at creation, so it must not change while
    // pipelines are cached. Read once, like __progCacheN.
    private readonly ffpDynOffsetEnabled = (globalThis as Record<string, unknown>).__ffpDynOffset === true;
    private ffpLayout: { bindGroupLayout: GPUBindGroupLayout; pipelineLayout: GPUPipelineLayout } | null = null;
    private ffpCacheSampler: (GPUSampler | null)[] = [];
    private ffpCacheView: (GPUTextureView | null)[] = [];
    private ffpCacheGroup: GPUBindGroup[] = [];
    private ffpCacheLen = 0;
    private ffpCacheCursor = 0;
    private ffpCacheBuffer: GPUBuffer | null = null;
    /** Reused single-element dynamic-offset scratch (avoids a per-draw array alloc). */
    private ffpDynOffsets: number[] = [0];

    /**
     * Shared, explicit bind-group/pipeline layout for programmable pipelines, parameterised by
     * the cube-sampler mask. Fixed slots: vs-uniform, ps-uniform, sampler, MAX_TEX textures —
     * each texture slot is viewDimension:"cube" when its bit is set in cubeMask, else "2d".
     * Cached per mask (mask 0 is the common all-2D case).
     */
    getProgrammableLayout(cubeMask: number = 0): { bindGroupLayout: GPUBindGroupLayout; pipelineLayout: GPUPipelineLayout } {
        let layout = this.progLayouts.get(cubeMask);
        if (!layout) {
            const device = this.backend.getDevice()!;
            const entries: GPUBindGroupLayoutEntry[] = [
                { binding: PROG_BIND.VS_UNIFORM, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", hasDynamicOffset: true } },
                { binding: PROG_BIND.PS_UNIFORM, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
                { binding: PROG_BIND.SAMPLER, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ];
            for (let n = 0; n < PROG_BIND.MAX_TEX; n++) {
                entries.push({
                    binding: PROG_BIND.TEX_BASE + n,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float", viewDimension: ((cubeMask >> n) & 1) ? "cube" : "2d" },
                });
            }
            const bindGroupLayout = device.createBindGroupLayout({ entries });
            const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
            layout = { bindGroupLayout, pipelineLayout };
            this.progLayouts.set(cubeMask, layout);
        }
        return layout;
    }

    /**
     * Shared, explicit bind-group/pipeline layout for FFP pipelines. One layout serves every
     * FFP shader variant: binding 0 is the fixed-size uniform block with a dynamic offset,
     * bindings 1/2 are the stage-0 sampler + texture. Variants that sample no texture simply
     * do not declare 1/2 — a pipeline layout may be a superset of what the shader uses, and
     * the bind group supplies fallbacks. Because the layout is shared (not per-pipeline as
     * with "auto"), one cached bind group is compatible with all FFP pipelines.
     */
    private getFfpLayout(): { bindGroupLayout: GPUBindGroupLayout; pipelineLayout: GPUPipelineLayout } {
        if (!this.ffpLayout) {
            const device = this.backend.getDevice()!;
            const bindGroupLayout = device.createBindGroupLayout({
                entries: [
                    // Read by both stages (vertex: transform/lighting; fragment: stage-0 ops, fog, clip).
                    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
                ],
            });
            const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
            this.ffpLayout = { bindGroupLayout, pipelineLayout };
        }
        return this.ffpLayout;
    }

    /** Layout for FFP render pipelines: the shared explicit one when the dynamic-offset shape
     *  is enabled, else WebGPU's implicit per-pipeline layout (the historical behaviour). */
    getFfpPipelineLayout(): GPUPipelineLayout | GPUAutoLayoutMode {
        return this.ffpDynOffsetEnabled ? this.getFfpLayout().pipelineLayout : "auto";
    }

    /**
     * Get-or-build the FFP bind group for a (sampler, stage-0 texture) pair. Same shape as
     * acquireProgBindGroup: object-identity compare over a small ring, zero-alloc on a hit,
     * correct-by-construction (a recreated texture yields a new view → miss → rebuild). The
     * uniform binding covers the fixed FFP_BIND_SIZE window at offset 0; the per-draw offset
     * is supplied as a dynamic offset by the caller.
     */
    private acquireFfpBindGroup(sampler: GPUSampler, view: GPUTextureView): GPUBindGroup {
        for (let s = 0; s < this.ffpCacheLen; s++) {
            if (this.ffpCacheSampler[s] === sampler && this.ffpCacheView[s] === view) {
                this.metrics.bindGroupCacheHits++;
                return this.ffpCacheGroup[s];
            }
        }
        const device = this.backend.getDevice()!;
        const bindGroup = device.createBindGroup({
            layout: this.getFfpLayout().bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.ffpArena!.buffer!, offset: 0, size: FFP_BIND_SIZE } },
                { binding: 1, resource: sampler },
                { binding: 2, resource: view },
            ],
        });
        const slot = this.ffpCacheLen < FFP_CACHE_N
            ? this.ffpCacheLen++
            : (this.ffpCacheCursor = (this.ffpCacheCursor + 1) % FFP_CACHE_N);
        this.ffpCacheSampler[slot] = sampler;
        this.ffpCacheView[slot] = view;
        this.ffpCacheGroup[slot] = bindGroup;
        return bindGroup;
    }

    /**
     * Get pipeline by ID
     */
    getPipeline(id: number): GPURenderPipeline | null {
        return this.pipelines[id] ?? null;
    }

    /**
     * Get pipeline info by ID
     */
    getPipelineInfo(id: number): PipelineInfo | null {
        return this.pipelineInfo[id] ?? null;
    }

    /**
     * Get performance metrics
     */
    getMetrics(): typeof this.metrics {
        return { ...this.metrics };
    }

    /**
     * Reset performance metrics
     */
    resetMetrics(): void {
        this.metrics.pipelineSets = 0;
        this.metrics.bindGroupSets = 0;
        this.metrics.bindGroupSetSkips = 0;
        this.metrics.bindGroupCacheHits = 0;
        this.metrics.drawCalls = 0;
        this.metrics.clearCalls = 0;
        this.metrics.progConstWrites = 0;
        this.metrics.progConstReuseHits = 0;
    }

    // ── WASM arena verify-only drain (dual-run scope cut) ────────────────────
    // Counters exposed via dbg.d3dArenaStats().
    private arenaDrainStats = {
        setPipelineCount: 0,
        pipelineHits: 0,
        pipelineMisses: 0,
        bindProgrammableCount: 0,
        drawCount: 0,
        drawIndexedCount: 0,
        drawUPCount: 0,
        drawIndexedUPCount: 0,
    };
    // Verify-only bookkeeping only: which arena pipelineKeys have been observed. This is
    // NOT a real GPURenderPipeline cache — the legacy caches (D3D9Device.progPipelineCache:
    // Map<string,number> + this.pipelines: GPURenderPipeline[] indexed by a sequential id)
    // are keyed by an entirely different id space than the arena's FNV-hashed pipelineKey,
    // so there is no existing Map<number, GPURenderPipeline> to look this hash up in. A real
    // (non-verify-only) bypass would need a NEW cache keyed on the arena's pipelineKey,
    // populated via the same pipeline-build code resolveProgrammablePipeline/registerPipeline
    // already use — deferred, out of scope here.
    private arenaSeenPipelineKeys = new Set<number>();

    getArenaDrainStats(): typeof this.arenaDrainStats {
        return { ...this.arenaDrainStats };
    }

    resetArenaDrainStats(): void {
        this.arenaDrainStats = {
            setPipelineCount: 0, pipelineHits: 0, pipelineMisses: 0,
            bindProgrammableCount: 0, drawCount: 0, drawIndexedCount: 0,
            drawUPCount: 0, drawIndexedUPCount: 0,
        };
        this.arenaSeenPipelineKeys.clear();
    }

    /**
     * Verify-only drain of the WASM arena's command SoA. Walks the same command shapes the
     * legacy RenderFrame consumer (execute() below) does, but NEVER touches a real
     * GPUCommandEncoder/pipeline/bind-group — it only proves out the lookup/decode path and
     * counts what it finds. Safe to call any time; flipping the kill switch that gates this
     * call (see D3D9Device.submitFrame) can never affect what actually renders.
     *
     * NOTE (gap, see report): readDrawState() doesn't currently return VS/PS shader handles,
     * only declHandle — a real bypass would need those too (resolveProgrammablePipeline needs
     * the CompiledVs/CompiledPs, not just a vertex declaration) to actually build a pipeline
     * on a miss. Deferred; out of scope for this verify-only pass.
     */
    drainArenaVerifyOnly(): void {
        const count = d3d9WasmArena.getCommandCount();
        if (count === 0) return;
        const types = d3d9WasmArena.getCommandTypes();
        const a = d3d9WasmArena.getCommandA();
        const b = d3d9WasmArena.getCommandB();
        for (let i = 0; i < count; i++) {
            switch (types[i]) {
                case ArenaCommandType.SetPipeline: {
                    this.arenaDrainStats.setPipelineCount++;
                    const pipelineKey = a[i]!;
                    if (this.arenaSeenPipelineKeys.has(pipelineKey)) {
                        this.arenaDrainStats.pipelineHits++;
                    } else {
                        this.arenaSeenPipelineKeys.add(pipelineKey);
                        this.arenaDrainStats.pipelineMisses++;
                        // Miss: pull the raw ingredients back (a real impl would build a
                        // GPURenderPipeline from these) — verify-only, just confirm they decode.
                        d3d9WasmArena.readDrawState(b[i]!);
                    }
                    break;
                }
                case ArenaCommandType.BindProgrammable: {
                    this.arenaDrainStats.bindProgrammableCount++;
                    d3d9WasmArena.readDrawState(a[i]!);
                    break;
                }
                case ArenaCommandType.Draw:
                    this.arenaDrainStats.drawCount++;
                    break;
                case ArenaCommandType.DrawIndexed:
                    this.arenaDrainStats.drawIndexedCount++;
                    break;
                case ArenaCommandType.DrawUP:
                    this.arenaDrainStats.drawUPCount++;
                    break;
                case ArenaCommandType.DrawIndexedUP:
                    this.arenaDrainStats.drawIndexedUPCount++;
                    break;
                // SetVertexBuffer / SetIndexBuffer: raw bufferId/offset/stride, no lookup to verify.
            }
        }
    }

    /**
     * Execute a render frame
     */
    execute(
        frame: RenderFrame,
        uniforms: UniformData,
        textureView: GPUTextureView | null,
        present: boolean,
        overlays?: {
            videoOverlayCanvas?: OffscreenCanvas | null;
            gdiOverlayCanvas?: OffscreenCanvas | null;
            // undefined = composite the whole GDI overlay (windowed / GDI desktop owns screen);
            // a rect list = 3D renderer owns the screen, composite only these live-dialog rects
            // ([] → nothing, so an occluded loading splash cannot cover the frame).
            gdiOverlayRects?: Array<{ x: number; y: number; w: number; h: number }>;
        },
        /** Render-to-texture target. When set, the pass renders into these views instead of the
         *  swap-chain offscreen and the canvas-copy / overlay compositing is skipped (RT passes
         *  never present). */
        target?: {
            colorView: GPUTextureView;
            depthView?: GPUTextureView;
            /** When set, used directly (shared FFP depth with stencil load/clear semantics). */
            depthStencil?: GPURenderPassDepthStencilAttachment;
        } | null,
    ): void {
        const device = this.backend.getDevice()!;
        const queue = this.backend.getQueue()!;

        // Reset state tracking for the new frame/renderPass
        this.currentPipelineId = null;
        this.resetProgConstOffsetCache();
        this.resetRenderPassBindCache();

        try {
            // Upload queued data
            for (let i = 0; i < frame.uploadBuffers.length; i++) {
                queue.writeBuffer(frame.uploadBuffers[i], 0, frame.uploadData[i] as any);
            }

            // Pre-size the programmable per-draw uniform arenas for this frame.
            if (frame.drawStateCount > 0) {
                let vsNeeded = 0, psNeeded = 0;
                for (let i = 0; i < frame.drawStateCount; i++) {
                    const ds = frame.drawStates[i];
                    vsNeeded += alignUp(Math.max(16, ds.vsLen * 4), UNIFORM_ALIGN);
                    psNeeded += alignUp(Math.max(16, ds.psLen * 4), UNIFORM_ALIGN);
                }
                if (!this.vsArena) this.vsArena = new UniformArena(device, "vs-const-arena");
                if (!this.psArena) this.psArena = new UniformArena(device, "ps-const-arena");
                // Pad by one full binding window so the last block's dynamic-offset
                // range [offset, offset + *_BIND_SIZE) stays within the buffer.
                this.vsArena.begin(vsNeeded + VS_BIND_SIZE);
                this.psArena.begin(psNeeded + PS_BIND_SIZE);

                // Cached programmable bind groups bind the arena buffers; if begin()
                // recreated either buffer, the cache is stale → drop it.
                if (this.vsArena.buffer !== this.progCacheVsBuffer || this.psArena.buffer !== this.progCachePsBuffer) {
                    this.progCacheLen = 0;
                    this.progCacheCursor = 0;
                    this.progCacheIndex.clear();
                    this.progCacheHash.length = 0;
                    this.progCacheVsBuffer = this.vsArena.buffer;
                    this.progCachePsBuffer = this.psArena.buffer;
                }
            }

            // Pre-size the per-draw FFP uniform arena for this frame.
            if (frame.ffpStateCount > 0) {
                if (!this.ffpArena) this.ffpArena = new UniformArena(device, "ffp-draw-arena");
                const blockBytes = alignUp(Math.max(16, frame.ffpStates[0].blockLen * 4), UNIFORM_ALIGN);
                // With the dynamic-offset shape, pad by one full binding window so the last
                // block's range [offset, offset + FFP_BIND_SIZE) stays inside the buffer.
                this.ffpArena.begin(blockBytes * frame.ffpStateCount
                    + (this.ffpDynOffsetEnabled ? FFP_BIND_SIZE : UNIFORM_ALIGN));

                // Cached FFP bind groups bind the arena buffer; if begin() recreated it, the
                // cache is stale → drop it (mirrors the programmable arenas above).
                if (this.ffpArena.buffer !== this.ffpCacheBuffer) {
                    this.ffpCacheLen = 0;
                    this.ffpCacheCursor = 0;
                    this.ffpCacheBuffer = this.ffpArena.buffer;
                }
            }

            // Ensure offscreen target (swap-chain path only; RT passes bring their own views).
            if (!target) this.ensureOffscreenTarget();

            // Create command encoder
            const encoder = device.createCommandEncoder();

            const clearTarget = (frame.clear.flags & 1) !== 0; // D3DCLEAR_TARGET
            const clearZ = (frame.clear.flags & 2) !== 0; // D3DCLEAR_ZBUFFER

            const colorAttachments: GPURenderPassColorAttachment[] = [{
                view: target ? target.colorView : this.offscreenView!,
                clearValue: frame.clear.color,
                loadOp: (frame.hasClear && clearTarget) ? "clear" : "load",
                storeOp: "store",
            }];

            const depthStencilAttachment: GPURenderPassDepthStencilAttachment = target?.depthStencil ?? {
                view: target ? target.depthView! : this.depthView!,
                depthClearValue: frame.clear.depth,
                depthLoadOp: (frame.hasClear && clearZ) ? "clear" : "load",
                depthStoreOp: "store",
            };

            const renderPass = encoder.beginRenderPass({
                colorAttachments,
                depthStencilAttachment,
            });

            // Execute commands
            for (let i = 0; i < frame.commandTypes.length; i++) {
                const type = frame.commandTypes[i];
                switch (type) {
                    case RenderCommandType.SetPipeline: {
                        const newPipelineId = frame.commandA[i];
                        if (this.currentPipelineId !== newPipelineId) {
                            this.currentPipelineId = newPipelineId;
                            const pipeline = this.pipelines[newPipelineId];
                            renderPass.setPipeline(pipeline);
                            this.resetRenderPassBindCache();
                            this.metrics.pipelineSets++;
                        }
                        // Programmable pipelines bind per-draw via BindProgrammable.
                        if (!this.pipelineInfo[newPipelineId]?.programmable) {
                            this.bindUniforms(renderPass, newPipelineId, uniforms, textureView);
                        }
                        break;
                    }

                    case RenderCommandType.BindProgrammable: {
                        const ds = frame.drawStates[frame.commandA[i]];
                        if (ds) this.bindProgrammable(renderPass, queue, ds);
                        break;
                    }

                    case RenderCommandType.BindFfp: {
                        const fs = frame.ffpStates[frame.commandA[i]];
                        if (fs) this.bindFfpDrawState(renderPass, queue, device, fs);
                        break;
                    }

                    case RenderCommandType.SetVertexBuffer: {
                        const vbIndex = frame.commandA[i];
                        const vbOffset = frame.commandB[i];
                        const vbSize = frame.commandC[i];
                        // commandD = vertex-buffer slot (D3D stream number); 0 for single-stream.
                        renderPass.setVertexBuffer(frame.commandD[i] | 0, frame.bufferRefs[vbIndex], vbOffset, vbSize);
                        break;
                    }

                    case RenderCommandType.SetIndexBuffer: {
                        const ibIndex = frame.commandA[i];
                        const ibFormatFlag = frame.commandB[i];
                        const ibFormat = ibFormatFlag === 16 ? "uint16" : "uint32";
                        renderPass.setIndexBuffer(frame.bufferRefs[ibIndex], ibFormat);
                        break;
                    }

                    case RenderCommandType.Draw: {
                        const vertexCount = frame.commandA[i];
                        const startVertex = frame.commandB[i];
                        renderPass.draw(vertexCount, 1, startVertex, 0);
                        this.metrics.drawCalls++;
                        break;
                    }

                    case RenderCommandType.DrawIndexed: {
                        const indexCount = frame.commandA[i];
                        const startIndex = frame.commandB[i];
                        const baseVertex = frame.commandC[i];
                        renderPass.drawIndexed(indexCount, 1, startIndex, baseVertex, 0);
                        this.metrics.drawCalls++;
                        break;
                    }
                }
            }

            renderPass.end();

            // Composite overlays on top of the main scene: video plane first, then GDI.
            // (Swap-chain path only — RT passes never composite overlays or present.)
            if (present && !target && overlays?.videoOverlayCanvas) {
                this.backend.blit(overlays.videoOverlayCanvas, this.offscreenView!, encoder);
            }
            if (present && !target && overlays?.gdiOverlayCanvas) {
                const rects = overlays.gdiOverlayRects;
                if (rects) {
                    // 3D renderer owns the screen: composite only live-dialog rects (never the
                    // whole overlay). An empty list intentionally composites nothing.
                    if (rects.length) this.backend.blitRects(overlays.gdiOverlayCanvas, this.offscreenView!, encoder, rects);
                } else {
                    this.backend.blit(overlays.gdiOverlayCanvas, this.offscreenView!, encoder);
                }
            }

            // Copy to canvas if presenting
            if (present && !target) {
                const context = this.backend.getContext()!;
                const currentTexture = context.getCurrentTexture();
                const size = this.getCanvasSize();

                // Stats overlay — composite onto the OFFSCREEN texture (before the canvas copy),
                // exactly like the video/GDI overlays above. The GDI present loop re-presents the
                // offscreen via repaintLastFrame() between actual presents; if we drew the overlay
                // straight onto the canvas it would only appear on real presents and vanish on every
                // repaint → visible flicker. Baking it into the offscreen makes it persist on both.
                if (statsOverlay.isEnabled()) {
                    const statsCanvas = statsOverlay.getCanvas();
                    if (statsCanvas) {
                        if (statsOverlay.isDirty()) {
                            this.backend.updateStatsTexture(statsCanvas);
                            statsOverlay.clearDirty();
                        }
                        this.backend.renderStatsOverlay(this.offscreenView!, encoder, size.width, size.height);
                    }
                }

                // The canvas can be resized (async from the main thread) AFTER
                // ensureOffscreenTarget sized the offscreen this frame, so copy at most
                // what both textures hold — else copyTextureToTexture throws "touches
                // outside" and the present (and guest) dies on a resolution change.
                const off = this.offscreenTexture!;
                encoder.copyTextureToTexture(
                    { texture: off },
                    { texture: currentTexture },
                    {
                        width: Math.min(off.width, currentTexture.width),
                        height: Math.min(off.height, currentTexture.height),
                        depthOrArrayLayers: 1,
                    }
                );
                // Snapshot this COMPLETE frame so repaintLastFrame re-presents it (not the
                // work-in-progress offscreen, which is transiently black mid-frame).
                if (this.presentedTexture) {
                    encoder.copyTextureToTexture(
                        { texture: off },
                        { texture: this.presentedTexture },
                        {
                            width: Math.min(off.width, this.presentedTexture.width),
                            height: Math.min(off.height, this.presentedTexture.height),
                            depthOrArrayLayers: 1,
                        }
                    );
                    this.hasPresented = true;
                }
            }

            const submitStart = frameProfiler.startTimer();
            queue.submit([encoder.finish()]);
            frameProfiler.endTimer("gpu", submitStart);
        } finally {
            frame.releaseTemporaryBuffers();
        }
    }

    /**
     * Re-present the last rendered offscreen frame to the canvas without re-rendering.
     * Used by the GDI present loop when a hardware-3D presenter owns the screen: the
     * device presents at low fps, so the canvas would otherwise go black between presents.
     */
    repaintLastFrame(): void {
        // Re-present the last COMPLETE frame, not the live offscreen (which is transiently black
        // between a frame's backbuffer clear and its scene redraw — pronounced when render-to-
        // texture passes sit in that gap). Until the first present, nothing valid exists → skip,
        // leaving the canvas showing whatever was last committed.
        const source = this.hasPresented ? this.presentedTexture : null;
        if (!source) return;
        const device = this.backend.getDevice();
        const context = this.backend.getContext();
        if (!device || !context) return;
        const dest = context.getCurrentTexture();
        const encoder = device.createCommandEncoder();
        // Clamp to both textures — the canvas may have resized since `source` was
        // captured (resolution change), and an oversized copy throws "touches outside".
        encoder.copyTextureToTexture(
            { texture: source },
            { texture: dest },
            {
                width: Math.min(source.width, dest.width),
                height: Math.min(source.height, dest.height),
                depthOrArrayLayers: 1,
            },
        );
        device.queue.submit([encoder.finish()]);
    }

    /**
     * Capture the current offscreen texture to a blob
     */
    async captureFrame(): Promise<Blob> {
        const device = this.backend.getDevice()!;
        const queue = this.backend.getQueue()!;
        const size = this.getCanvasSize();
        const width = size.width;
        const height = size.height;

        const bytesPerPixel = 4;
        const unpaddedBytesPerRow = width * bytesPerPixel;
        const align = 256;
        const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / align) * align;
        const bufferSize = paddedBytesPerRow * height;

        const readback = device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        // Read the last COMPLETE presented frame when available (the live offscreen is transiently
        // black mid-frame), so screenshots/readback match what the user actually sees on the canvas.
        const captureSrc = (this.hasPresented && this.presentedTexture) ? this.presentedTexture : this.offscreenTexture!;
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: captureSrc },
            { buffer: readback, bytesPerRow: paddedBytesPerRow },
            { width, height, depthOrArrayLayers: 1 }
        );
        const submitStart = frameProfiler.startTimer();
        queue.submit([encoder.finish()]);
        frameProfiler.endTimer("gpu", submitStart);
        await queue.onSubmittedWorkDone();

        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const pixels = new Uint8ClampedArray(width * height * bytesPerPixel);
        for (let row = 0; row < height; row++) {
            const srcStart = row * paddedBytesPerRow;
            const srcEnd = srcStart + unpaddedBytesPerRow;
            pixels.set(mapped.subarray(srcStart, srcEnd), row * unpaddedBytesPerRow);
        }
        readback.unmap();

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("Failed to get 2D context for capture.");
        }

        const imageData = new ImageData(pixels, width, height);
        ctx.putImageData(imageData, 0, 0);
        return canvas.convertToBlob({ type: "image/png" });
    }

    /**
     * Get the canvas size
     */
    getCanvasSize(): { width: number; height: number } {
        const context = this.backend.getContext()!;
        const canvas = context.canvas as OffscreenCanvas;
        return { width: canvas.width, height: canvas.height };
    }

    private ensureOffscreenTarget(): void {
        const device = this.backend.getDevice()!;
        const format = this.backend.getFormat()!;
        const size = this.getCanvasSize();

        if (this.offscreenTexture &&
            this.offscreenSize &&
            this.offscreenSize.width === size.width &&
            this.offscreenSize.height === size.height) {
            return;
        }

        if (this.offscreenTexture) {
            this.offscreenTexture.destroy();
        }
        if (this.depthTexture) {
            this.depthTexture.destroy();
        }

        this.offscreenTexture = device.createTexture({
            size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        this.offscreenView = this.offscreenTexture.createView();

        // Last-complete-frame snapshot for repaintLastFrame (see field comment).
        this.presentedTexture?.destroy();
        this.presentedTexture = device.createTexture({
            size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.hasPresented = false;

        this.depthTexture = device.createTexture({
            size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthView = this.depthTexture.createView();

        this.offscreenSize = size;
    }

    // VS uniform buffer (larger, for vertex shader constants)
    private vsUniformBuffer: GPUBuffer | null = null;
    private vsUniformBufferSize: number = 0;
    private vsUniformData: Float32Array | null = null;

    private bindUniforms(
        renderPass: GPURenderPassEncoder,
        pipelineId: number,
        uniforms: UniformData,
        textureView: GPUTextureView | null
    ): void {
        const device = this.backend.getDevice()!;
        const queue = this.backend.getQueue()!;

        const isVsPath = uniforms.vsConstants && uniforms.vsConstantCount && uniforms.vsConstantCount > 0;
        let activeBuffer: GPUBuffer;

        if (isVsPath) {
            // VS path: viewport (vec2) + pad (vec2) + N vec4 constants
            const constCount = uniforms.vsConstantCount!;
            const bufferFloats = 4 + constCount * 4; // viewport+pad + constants
            const bufferBytes = bufferFloats * 4;

            // Ensure buffer is large enough
            if (!this.vsUniformBuffer || this.vsUniformBufferSize < bufferBytes) {
                this.vsUniformBuffer?.destroy();
                this.vsUniformBuffer = device.createBuffer({
                    size: bufferBytes,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                this.vsUniformBufferSize = bufferBytes;
                this.vsUniformData = new Float32Array(bufferFloats);
                // Invalidate bind group cache since buffer changed
                this.bindGroupCache.clear();
            }

            const data = this.vsUniformData!;
            data[0] = uniforms.viewportWidth;
            data[1] = uniforms.viewportHeight;
            data[2] = 0;
            data[3] = 0;
            // Copy constant registers
            data.set(uniforms.vsConstants!.subarray(0, constCount * 4), 4);
            queue.writeBuffer(this.vsUniformBuffer, 0, data.buffer, 0, bufferBytes);
            activeBuffer = this.vsUniformBuffer;
        } else {
            // FFP path: the expanded uniform block (viewport + MVP + worldView + material/lights;
            // layout owned by d3d9/ffp-lighting.ts). NO TRANSPOSE needed — WebGPU's column-major
            // read of D3D row-major bytes effectively transposes, matching M * v in the shader.
            const block = uniforms.ffpBlock;
            if (block) {
                if (!this.uniformBuffer || this.uniformBufferSize < block.byteLength) {
                    this.uniformBuffer?.destroy();
                    this.uniformBuffer = device.createBuffer({
                        size: block.byteLength,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    this.uniformBufferSize = block.byteLength;
                    // Cached FFP bind groups reference the old buffer — drop them.
                    this.bindGroupCache.clear();
                }
                queue.writeBuffer(this.uniformBuffer, 0, block);
            } else {
                // Defensive fallback: viewport (vec2) + pad (vec2) + mat4x4 MVP only.
                if (!this.uniformBuffer) {
                    this.uniformBuffer = device.createBuffer({
                        size: 80,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    this.uniformBufferSize = 80;
                }
                this.uniformData[0] = uniforms.viewportWidth;
                this.uniformData[1] = uniforms.viewportHeight;
                this.uniformData[2] = 0;
                this.uniformData[3] = 0;
                this.uniformData.set(uniforms.mvp, 4);
                queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer);
            }
            activeBuffer = this.uniformBuffer;
        }

        // Create cache key for bind group
        const info = this.pipelineInfo[pipelineId];
        const bufferKey = isVsPath ? 'vs' : 'ffp';
        const cacheKey = `${pipelineId}-${bufferKey}`;

        // Check cache first — texture view identity must match (same pipeline + different
        // bound texture would otherwise reuse a stale bind group).
        const cached = this.bindGroupCache.get(cacheKey);
        let bindGroup: GPUBindGroup;
        if (cached && cached.textureView === textureView) {
            bindGroup = cached.bindGroup;
            this.metrics.bindGroupCacheHits++;
        } else {
            // Build bind group
            const pipeline = this.pipelines[pipelineId];
            // Under the shared FFP layout the group must fill every declared slot — including
            // the sampler/texture a textureless variant never samples; with "auto" only the
            // slots the shader itself declares exist, so filling them would be invalid.
            const shared = this.ffpDynOffsetEnabled;
            const layout = shared ? this.getFfpLayout().bindGroupLayout : pipeline.getBindGroupLayout(0);
            const entries: GPUBindGroupEntry[] = [
                { binding: 0, resource: { buffer: activeBuffer } }
            ];

            if (shared || info?.hasTexture) {
                const texture = textureView ?? this.getFallbackTextureView();
                entries.push({ binding: 1, resource: this.getSampler() });
                entries.push({ binding: 2, resource: texture });
            }

            bindGroup = device.createBindGroup({ layout, entries });
            this.bindGroupCache.set(cacheKey, { bindGroup, textureView });
        }

        // Binding 0 carries a dynamic offset under the shared layout. This frame-level bind
        // always addresses the head of its buffer; per-draw offsets arrive via BindFfp.
        if (this.ffpDynOffsetEnabled) this.setBindGroup0(renderPass, bindGroup, 0, -1, 1);
        else this.setBindGroup0(renderPass, bindGroup);
    }

    /**
     * Build and bind the programmable bind group for one draw: per-draw VS/PS
     * constant blocks (written into the frame arenas) plus bound textures.
     */
    /** Bind one FFP draw's uniform block + stage-0 texture. The block is bump-written
     *  into a per-frame arena and bound as an explicit-range buffer entry; overrides
     *  the frame-level FFP bind that SetPipeline installed. */
    private bindFfpDrawState(
        renderPass: GPURenderPassEncoder,
        queue: GPUQueue,
        device: GPUDevice,
        fs: FfpDrawState,
    ): void {
        if (this.currentPipelineId === null || !this.ffpArena) return;
        const info = this.pipelineInfo[this.currentPipelineId];
        const offset = this.ffpArena.write(queue, fs.block, fs.blockLen);

        if (this.ffpDynOffsetEnabled) {
            // Shared explicit layout ⇒ the group depends only on (sampler, texture); the
            // per-draw block is reached by the dynamic offset. Textureless variants bind the
            // fallback view: the layout declares slot 2 even where the shader ignores it.
            const bindGroup = this.acquireFfpBindGroup(
                fs.sampler ?? this.getSampler(),
                fs.texture ?? this.getFallbackTextureView(),
            );
            this.setBindGroup0(renderPass, bindGroup, offset, -1, 1);
            return;
        }

        const pipeline = this.pipelines[this.currentPipelineId];
        const layout = pipeline.getBindGroupLayout(0);
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: this.ffpArena.buffer!, offset, size: Math.max(16, fs.blockLen * 4) } },
        ];
        if (info?.hasTexture) {
            entries.push({ binding: 1, resource: fs.sampler ?? this.getSampler() });
            entries.push({ binding: 2, resource: fs.texture ?? this.getFallbackTextureView() });
        }
        const bindGroup = device.createBindGroup({ layout, entries });
        this.setBindGroup0(renderPass, bindGroup);
    }

    private bindProgrammable(
        renderPass: GPURenderPassEncoder,
        queue: GPUQueue,
        ds: ProgrammableDrawState,
    ): void {
        // Per-draw: bump constants into arenas unless this exact bank version/length
        // was already written in this frame. Dynamic offsets are frame-local because
        // UniformArena.begin() rewinds each execute() call.
        const vsOff = this.writeProgrammableConstants(this.vsArena!, queue, ds.vsConst, ds.vsLen, ds.vsVersion, true);
        const psOff = this.writeProgrammableConstants(this.psArena!, queue, ds.psConst, ds.psLen, ds.psVersion, false);

        const sampler = ds.sampler ?? this.getSampler();
        const bindGroup = this.acquireProgBindGroup(sampler, ds.textures, ds.cubeMask);

        this.setBindGroup0(renderPass, bindGroup, vsOff, psOff);
    }

    private resetRenderPassBindCache(): void {
        this.lastBoundBindGroup = null;
        this.lastBindOffset0 = -1;
        this.lastBindOffset1 = -1;
    }

    private setBindGroup0(
        renderPass: GPURenderPassEncoder,
        bindGroup: GPUBindGroup,
        offset0 = -1,
        offset1 = -1,
        dynCount = offset0 >= 0 ? 2 : 0,
    ): void {
        if (
            this.lastBoundBindGroup === bindGroup &&
            this.lastBindOffset0 === offset0 &&
            this.lastBindOffset1 === offset1 &&
            this.lastBindDynCount === dynCount
        ) {
            this.metrics.bindGroupSetSkips++;
            return;
        }

        if (dynCount === 1) {
            this.ffpDynOffsets[0] = offset0;
            renderPass.setBindGroup(0, bindGroup, this.ffpDynOffsets);
        } else if (dynCount === 2) {
            this.dynOffsets[0] = offset0;
            this.dynOffsets[1] = offset1;
            renderPass.setBindGroup(0, bindGroup, this.dynOffsets);
        } else {
            renderPass.setBindGroup(0, bindGroup);
        }
        this.lastBoundBindGroup = bindGroup;
        this.lastBindOffset0 = offset0;
        this.lastBindOffset1 = offset1;
        this.lastBindDynCount = dynCount;
        this.metrics.bindGroupSets++;
    }

    private resetProgConstOffsetCache(): void {
        this.progVsConstCount = 0;
        this.progVsConstCursor = 0;
        this.progPsConstCount = 0;
        this.progPsConstCursor = 0;
    }

    private findProgConstOffset(version: number, floatLen: number, vertex: boolean): number {
        const versions = vertex ? this.progVsConstVersion : this.progPsConstVersion;
        const lens = vertex ? this.progVsConstLen : this.progPsConstLen;
        const offsets = vertex ? this.progVsConstOffset : this.progPsConstOffset;
        const count = vertex ? this.progVsConstCount : this.progPsConstCount;
        for (let i = 0; i < count; i++) {
            if (versions[i] === version && lens[i] === floatLen) {
                return offsets[i]!;
            }
        }
        return -1;
    }

    private rememberProgConstOffset(version: number, floatLen: number, offset: number, vertex: boolean): void {
        const versions = vertex ? this.progVsConstVersion : this.progPsConstVersion;
        const lens = vertex ? this.progVsConstLen : this.progPsConstLen;
        const offsets = vertex ? this.progVsConstOffset : this.progPsConstOffset;

        let slot: number;
        if (vertex) {
            slot = this.progVsConstCount < PROG_CONST_CACHE_N
                ? this.progVsConstCount++
                : (this.progVsConstCursor = (this.progVsConstCursor + 1) % PROG_CONST_CACHE_N);
        } else {
            slot = this.progPsConstCount < PROG_CONST_CACHE_N
                ? this.progPsConstCount++
                : (this.progPsConstCursor = (this.progPsConstCursor + 1) % PROG_CONST_CACHE_N);
        }

        versions[slot] = version;
        lens[slot] = floatLen;
        offsets[slot] = offset;
    }

    private writeProgrammableConstants(
        arena: UniformArena,
        queue: GPUQueue,
        data: Float32Array,
        floatLen: number,
        version: number | undefined,
        vertex: boolean,
    ): number {
        if (version !== undefined) {
            const cached = this.findProgConstOffset(version, floatLen, vertex);
            if (cached >= 0) {
                this.metrics.progConstReuseHits++;
                return cached;
            }
        }

        const offset = arena.write(queue, data, floatLen);
        this.metrics.progConstWrites++;
        if (version !== undefined) {
            this.rememberProgConstOffset(version, floatLen, offset, vertex);
        }
        return offset;
    }

    /**
     * Get-or-build the programmable bind group for a material (sampler + bound
     * texture views). Direct object-identity compare against a small ring of cached
     * slots — zero-alloc on a hit, and correct-by-construction (the cached group
     * binds the exact view objects; a recreated texture yields a new view → miss →
     * rebuild). The VS/PS uniform bindings use the fixed *_BIND_SIZE window at
     * offset 0; the per-draw offset is supplied as a dynamic offset by the caller.
     */
    /** Drop `slot` from its hash bucket (no-op for a slot that was never indexed). */
    private unindexProgSlot(slot: number): void {
        const prev = this.progCacheHash[slot];
        if (prev === undefined) return;
        const bucket = this.progCacheIndex.get(prev);
        if (bucket === undefined) return;
        const at = bucket.indexOf(slot);
        if (at >= 0) bucket.splice(at, 1);
        if (bucket.length === 0) this.progCacheIndex.delete(prev);
    }

    /** Stable small integer per GPU object, so a bind-group key can be hashed instead of
     *  compared. WeakMap rather than a stamped property: these are host objects and must not
     *  be mutated. */
    private gpuId(o: object | null): number {
        if (o === null) return 0;
        let id = this.gpuIds.get(o);
        if (id === undefined) { id = this.nextGpuId++; this.gpuIds.set(o, id); }
        return id;
    }

    private progKeyHash(sampler: GPUSampler, textures: (GPUTextureView | null)[], cubeMask: number): number {
        // FNV-1a over the identity ids. Collisions are fine — the bucket is verified by
        // identity below, so the hash only has to be cheap and well-spread.
        let h = 0x811c9dc5;
        h = Math.imul(h ^ this.gpuId(sampler), 0x01000193);
        h = Math.imul(h ^ cubeMask, 0x01000193);
        for (let n = 0; n < PROG_BIND.MAX_TEX; n++) {
            h = Math.imul(h ^ this.gpuId(textures[n] ?? null), 0x01000193);
        }
        return h >>> 0;
    }

    private acquireProgBindGroup(sampler: GPUSampler, textures: (GPUTextureView | null)[], cubeMask: number = 0): GPUBindGroup {
        const MAX = PROG_BIND.MAX_TEX;
        const hash = this.progKeyHash(sampler, textures, cubeMask);
        const bucket = this.progCacheIndex.get(hash);
        if (bucket !== undefined) {
            for (let i = 0; i < bucket.length; i++) {
                const s = bucket[i]!;
                if (this.progCacheSampler[s] !== sampler || this.progCacheCubeMask[s] !== cubeMask) continue;
                const base = s * MAX;
                let match = true;
                for (let n = 0; n < MAX; n++) {
                    if (this.progCacheViews[base + n] !== (textures[n] ?? null)) { match = false; break; }
                }
                if (match) { this.metrics.bindGroupCacheHits++; return this.progCacheGroup[s]; }
            }
        }

        // Miss → build a new bind group and insert it (append, then round-robin evict). The
        // layout (and per-stage fallback dimension) is selected by cubeMask so the group stays
        // compatible with the cube-aware pipeline layout.
        const device = this.backend.getDevice()!;
        const { bindGroupLayout } = this.getProgrammableLayout(cubeMask);
        const fallback2d = this.getFallbackTextureView();
        const fallbackCube = cubeMask ? this.getFallbackCubeView() : fallback2d;
        const entries: GPUBindGroupEntry[] = [
            { binding: PROG_BIND.VS_UNIFORM, resource: { buffer: this.vsArena!.buffer!, offset: 0, size: VS_BIND_SIZE } },
            { binding: PROG_BIND.PS_UNIFORM, resource: { buffer: this.psArena!.buffer!, offset: 0, size: PS_BIND_SIZE } },
            { binding: PROG_BIND.SAMPLER, resource: sampler },
        ];
        for (let n = 0; n < MAX; n++) {
            const fallback = ((cubeMask >> n) & 1) ? fallbackCube : fallback2d;
            entries.push({ binding: PROG_BIND.TEX_BASE + n, resource: textures[n] ?? fallback });
        }
        const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries });

        const slot = this.progCacheLen < this.progCacheN
            ? this.progCacheLen++
            : (this.progCacheCursor = (this.progCacheCursor + 1) % this.progCacheN);
        // Round-robin eviction reuses a live slot — unindex it first or the old hash keeps
        // pointing at a slot that now holds a different material.
        this.unindexProgSlot(slot);
        this.progCacheHash[slot] = hash;
        const b = this.progCacheIndex.get(hash);
        if (b === undefined) this.progCacheIndex.set(hash, [slot]); else b.push(slot);
        this.progCacheSampler[slot] = sampler;
        this.progCacheCubeMask[slot] = cubeMask;
        const base = slot * MAX;
        for (let n = 0; n < MAX; n++) this.progCacheViews[base + n] = textures[n] ?? null;
        this.progCacheGroup[slot] = bindGroup;
        return bindGroup;
    }

    /** Fallback sampler for draws without resolved per-draw sampler state (e.g. the non-programmable
     *  path). Uses the faithful D3D9 default: linear filtering + WRAP addressing (NOT WebGPU's
     *  clamp-to-edge default). Per-draw programmable samplers come from the device (see ds.sampler). */
    private getSampler(): GPUSampler {
        if (!this.sampler) {
            this.sampler = this.backend.getDevice()!.createSampler({
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "repeat",
                addressModeV: "repeat",
                addressModeW: "repeat",
            });
        }
        return this.sampler;
    }

    private getFallbackTextureView(): GPUTextureView {
        if (!this.fallbackTexture) {
            const device = this.backend.getDevice()!;
            this.fallbackTexture = device.createTexture({
                size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.fallbackTextureView = this.fallbackTexture.createView();
            this.backend.getQueue()!.writeTexture(
                { texture: this.fallbackTexture },
                new Uint8Array([255, 255, 255, 255]),
                { bytesPerRow: 4 },
                { width: 1, height: 1, depthOrArrayLayers: 1 }
            );
        }
        return this.fallbackTextureView!;
    }

    /** 1×1×6 white cube for cube-sampler stages with no bound texture (keeps the bind group
     *  valid against a cube-dimension layout slot). */
    private getFallbackCubeView(): GPUTextureView {
        if (!this.fallbackCubeView) {
            const device = this.backend.getDevice()!;
            this.fallbackCubeTexture = device.createTexture({
                size: { width: 1, height: 1, depthOrArrayLayers: 6 },
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            const white = new Uint8Array([255, 255, 255, 255]);
            for (let face = 0; face < 6; face++) {
                this.backend.getQueue()!.writeTexture(
                    { texture: this.fallbackCubeTexture, origin: { x: 0, y: 0, z: face } },
                    white,
                    { bytesPerRow: 4 },
                    { width: 1, height: 1, depthOrArrayLayers: 1 }
                );
            }
            this.fallbackCubeView = this.fallbackCubeTexture.createView({ dimension: "cube", arrayLayerCount: 6 });
        }
        return this.fallbackCubeView;
    }
}

function transposeMatrix(m: Float32Array): Float32Array {
    return m; // Unused, just cleanup
}
