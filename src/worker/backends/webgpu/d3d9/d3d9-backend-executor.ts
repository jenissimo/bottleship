/**
 * D3D9BackendExecutor - Executes render frames on the WebGPU backend
 *
 * Separated from D3D9Device to isolate GPU-specific code
 * and enable potential backend switching in the future.
 */

import { WebGPUBackend } from "../webgpu-backend";
import { RenderFrame, RenderCommandType, ProgrammableDrawState, FfpDrawState, type ArenaDrawBinding } from "../render-frame";
import { Logger, LogCategory } from "../../../core/logger";
import { recordGpuError } from "../../../core/gpu-error-log";
import { d3d9PerfVertexRangeOOB } from "../../../modules/d3d9/d3d9-perf";
import { frameProfiler } from "../../../core/frame-profiler";
import { statsOverlay } from "../../../core/stats-overlay";
import { PROG_BIND } from "./shader";
import { PS_PROGRAMMABLE_BIND_BYTES, VS_PROGRAMMABLE_BIND_BYTES, VS_HIDDEN_VEC4_COUNT } from "./shader/link/uniforms";
import { padRegion, vertexRangeEndBytes, zeroStreamBuffer } from "../shared/vertex-streams";
import { noteBufferUpload } from "../buffer-upload";
import { d3d9WasmArena, ArenaCommandType, D3D9_ARENA_BUMP_CAP, D3D9_ARENA_CMD_CAP } from "./d3d9-wasm-arena";
import { FFP_UNIFORM_BYTES, FFP_MAX_STAGES } from "./ffp-lighting";
import { ColorKeyBlitPipeline } from "../ddraw/colorkey-blit-pipeline";
import { dxSrgbViewFormat, dxSrgbViewFormats } from "../shared/dx-sampler";
import type { D3D9QueryManager, QueryResolveBatch, QueryCommandEncoder } from "../../../modules/d3d9/query-manager";
import {
    beginD3D9MultisampleRenderPass,
    D3D9MultisampleTargetCache,
    type D3D9MsaaAdapterProbe,
    type D3D9MultisampleTarget,
} from "./multisample";
import { validateD3D9RasterDrawCommand } from "./raster-emulation";
import { d3dColorToGpu } from "./d3d9-blend";

export interface PipelineInfo {
    pipeline: GPURenderPipeline;
    hasTexture: boolean;
    /** Programmable (VS/PS) pipelines bind via per-draw BindProgrammable. */
    programmable: boolean;
    /** FFP texture blend stages this pipeline's shader declares bindings for. The BIND side
     *  must supply exactly this many (sampler, texture) pairs — the pipeline owns the number
     *  because its shader is what the implicit layout is derived from, and a bind group built
     *  from a differently-counted per-draw snapshot is a WebGPU validation error, not a
     *  degraded picture. */
    ffpStageCount: number;
    /** arrayStride of every vertex-buffer slot this pipeline declares (index = slot, 0 = no
     *  layout there). The encoder sizes each draw against these — see planVertexRangePadding. */
    strides: number[];
    /** End offset of the furthest attribute in each slot's layout — the second half of
     *  WebGPU's non-indexed draw rule, which sizes the LAST vertex by its final attribute and
     *  not by a whole stride. Empty (or 0 for a slot) falls back to the stride. */
    attrEnds: number[];
    /** Optional exact-instancing variant. It differs only in binding 0 (VS constants in
     * instance-indexed read-only storage); the recorder continues to name the normal id. */
    megaBatch?: { pipeline: GPURenderPipeline; vsSlotBytes: number };
}

/** Vertex-buffer slots the encoder tracks; D3D9 advertises 16 streams. */
const MAX_VB_SLOTS = 16;

/** Stable W16 binding window. D3DVERTEXTEXTURESAMPLER0..3 are API stages
 * 257..260, while the shader register names are s0..s3. These slots are
 * deliberately outside the existing PS texture/hybrid windows. */
const VERTEX_TEXTURE_SAMPLER_COUNT = 4;
const VERTEX_TEXTURE_BASE = PROG_BIND.FRAGMENT_SAMPLER_BASE + PROG_BIND.MAX_TEX - 1;
const VERTEX_SAMPLER_BASE = VERTEX_TEXTURE_BASE + VERTEX_TEXTURE_SAMPLER_COUNT;

/** Ceiling on one frame's robustness padding. A pathological frame asks for zeros, not for a
 *  buffer the size of its own geometry. */
const PAD_BUFFER_BUDGET = 32 * 1024 * 1024;

const UNIFORM_ALIGN = 256;
function alignUp(n: number, a: number): number { return Math.ceil(n / a) * a; }

type ArenaRunLogicalShape = Pick<RenderFrame["arenaIndexedRuns"][number],
    "expectedPairCount" | "prefixVsBits">;

/** Logical draws owned by the run itself. A fused adjacent RenderFrame draw is deliberately
 * excluded: it has its own API/accounting row even when MegaBatch encodes it as instance zero. */
export function arenaRunExpectedLogicalDraws(run: ArenaRunLogicalShape): number {
    return run.expectedPairCount + (run.prefixVsBits ? 1 : 0);
}

/** The invariant deliberately accepts independently observed encoded counts.  In particular,
 * callers must not make a failed MegaBatch/bundle look healthy by copying expected into actual. */
export function arenaRunEncodingComplete(
    run: ArenaRunLogicalShape,
    encodedPairs: number,
    encodedLogicalDraws: number,
): boolean {
    return encodedPairs === run.expectedPairCount
        && encodedLogicalDraws === arenaRunExpectedLogicalDraws(run);
}

/** One dynamic-offset slot for a constant bank of `floatLen` floats. */
export function uniformBlockBytes(floatLen: number): number {
    return alignUp(Math.max(16, floatLen * 4), UNIFORM_ALIGN);
}

/** Bytes an arena run's per-draw VS blocks occupy — one block per LOGICAL draw, the fused
 *  prefix included. Single definition: the frame estimator below and the pre-encode capacity
 *  preflight must agree exactly, or a run is budgeted for one number of arena writes and
 *  replayed with another. */
export function arenaRunVsBudgetBytes(templateVsLen: number, logicalDraws: number): number {
    return uniformBlockBytes(templateVsLen) * logicalDraws;
}

/**
 * Conservative byte budget for the programmable uniform arenas. An arena run owns one
 * RenderFrame draw-state template, but replays a distinct captured VS constant bank for every
 * pair. Counting drawStateCount alone therefore under-sizes the VS arena and can abort encoding
 * in the middle of a frame. The full pair count is deliberately added on top of the template's
 * ordinary allocation: one block of over-allocation per run is cheaper than relying on draw-state
 * pooling details for correctness.
 */
export function estimateProgrammableArenaNeeds(
    frame: Pick<RenderFrame, "drawStateCount" | "drawStates" | "arenaIndexedRuns">,
): { vsNeeded: number; psNeeded: number } {
    let vsNeeded = 0;
    let psNeeded = 0;
    for (let i = 0; i < frame.drawStateCount; i++) {
        const ds = frame.drawStates[i];
        vsNeeded += uniformBlockBytes(ds.vsLen);
        psNeeded += uniformBlockBytes(ds.psLen);
    }
    for (const run of frame.arenaIndexedRuns) {
        const template = frame.drawStates[run.bindStateIndex];
        if (!template || run.expectedPairCount <= 0) continue;
        vsNeeded += arenaRunVsBudgetBytes(template.vsLen, arenaRunExpectedLogicalDraws(run));
    }
    return { vsNeeded, psNeeded };
}

/** A run's replay decision. `decline` never reaches UniformArena.write: a shortfall must not
 *  throw out of encode, because that discards the whole frame's already-queued uploads. */
export type ArenaRunReplayPlan = {
    fits: boolean;
    neededBytes: number;
    /** Bytes the arena is short for this run; 0 when it fits. Drives next frame's growth. */
    shortfallBytes: number;
};

export function planArenaRunUniformReplay(
    run: ArenaRunLogicalShape,
    templateVsLen: number,
    remainingBytes: number,
): ArenaRunReplayPlan {
    const neededBytes = arenaRunVsBudgetBytes(templateVsLen, arenaRunExpectedLogicalDraws(run));
    const fits = neededBytes <= remainingBytes;
    return { fits, neededBytes, shortfallBytes: fits ? 0 : neededBytes - remainingBytes };
}

/** The instance count the encoder actually received, split back into the run's own logical
 *  draws and the fused adjacent draw that keeps its own API accounting row. Deriving the
 *  ledger here — rather than from the plan's pair count — is what lets a dropped prefix
 *  instance reach reconcileD3D9ArenaRuns instead of reading as a complete run. */
export function arenaRunLedgerFromIssuedInstances(
    run: ArenaRunLogicalShape,
    issuedInstances: number,
    fusedInstances: number,
): { encodedPairs: number; encodedRunLogicalDraws: number } {
    const encodedRunLogicalDraws = Math.max(0, issuedInstances - fusedInstances);
    return {
        encodedPairs: Math.max(0, encodedRunLogicalDraws - (run.prefixVsBits ? 1 : 0)),
        encodedRunLogicalDraws,
    };
}

/** Minimal encoder surface the MegaBatch draw needs; keeps the encode+account pair testable
 *  against a recorded transcript without a GPU device. */
export interface IndexedDrawEncoder {
    drawIndexed(indexCount: number, instanceCount: number, firstIndex: number,
        baseVertex: number, firstInstance: number): void;
}

/** Encode one MegaBatch run and report what was issued. The instance count is chosen ONCE
 *  and both the encoder and the ledger read that single value. `packConsistent` is the
 *  independent half: the pairs the planner packed into the storage bank must equal the pairs
 *  the draw actually issued, which neither side can witness alone. */
export function encodeMegaBatchRunDraw(
    encoder: IndexedDrawEncoder,
    plan: Pick<MegaBatchRunPlan, "indexCount" | "instanceCount" | "startIndex" | "baseVertex"
        | "firstSlot" | "encodedPairCount" | "fusedDrawCommand">,
    run: ArenaRunLogicalShape,
): {
    issuedInstances: number; encodedPairs: number;
    encodedRunLogicalDraws: number; packConsistent: boolean;
} {
    const issuedInstances = plan.instanceCount;
    encoder.drawIndexed(plan.indexCount, issuedInstances, plan.startIndex,
        plan.baseVertex, plan.firstSlot);
    // A prefix run never fuses an adjacent draw, so at most one of the two owns instance zero.
    const fusedInstances = plan.fusedDrawCommand >= 0 && !run.prefixVsBits ? 1 : 0;
    const ledger = arenaRunLedgerFromIssuedInstances(run, issuedInstances, fusedInstances);
    return {
        issuedInstances, ...ledger,
        packConsistent: ledger.encodedPairs === plan.encodedPairCount,
    };
}

// Fixed binding window for the dynamic-offset programmable uniform bindings.
// Sized to the worst case (VS: 256 vec4, PS: 224 vec4). A draw's actual block is
// usually far smaller; the shader reads only the constants it declares from the
// front of the window, so over-binding is harmless. Fixing the window size lets a
// single cached bind group serve every draw of a material — only the dynamic
// offset varies per draw (see bindProgrammable / acquireProgBindGroup).
// Full current VS bank window plus hidden pixel-centre, point-size, and six clip-plane vec4s.
const VS_BIND_SIZE = VS_PROGRAMMABLE_BIND_BYTES + VS_HIDDEN_VEC4_COUNT * 4 * 4;
// 224 float vec4 registers followed by 16 packed boolean vec4 registers. Legacy
// ps_1_x TEXBEM/TEXBEML appends two vec4 texture-stage-state records for each
// of the eight stages, so reserve the full 256-vec4 WebGPU binding window.
const PS_BIND_SIZE = PS_PROGRAMMABLE_BIND_BYTES;
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
// "auto"-layout FFP per-draw bind-group cache slots (default; __ffpAutoCacheN overrides).
// The group encodes the arena RANGE, so its identity carries the offset — which makes a slot
// per DRAW, not per material, and the working set is therefore a whole frame's draw list.
// Undersized, it round-robins away entries that the next frame re-references at the same
// offset and every draw pays createBindGroup + GC again.
const FFP_AUTO_CACHE_N = 1024;
/** Verify-only fingerprints are diagnostics, not a process-lifetime cache. */
const ARENA_SEEN_PIPELINE_KEYS_MAX = 4096;
/** Bind-group census: distinct programmable keys remembered, so "this material came back"
 *  is answerable without an unbounded set. */
const CENSUS_SEEN_HASH_MAX = 65536;

/** A growable per-frame uniform ring written at 256-aligned offsets. */
class UniformArenaCapacityError extends Error {
    constructor(label: string, required: number, capacity: number) {
        super(`${label} capacity exceeded: required=${required} capacity=${capacity}`);
        this.name = "UniformArenaCapacityError";
    }
}

class UniformArena {
    buffer: GPUBuffer | null = null;
    private capacity = 0;
    private cursor = 0;
    private staging = new Float32Array(0);
    private dirty = false;
    private bulkUpload = true;

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
            this.staging = new Float32Array(this.capacity >>> 2);
        }
        this.cursor = 0;
        this.lastOffset = -1;
        this.dirty = false;
        this.bulkUpload = (globalThis as { __noD3D9BulkUniformUpload?: boolean })
            .__noD3D9BulkUniformUpload !== true;
    }

    /** Offset the most recent write() landed at, -1 before the first write of a frame.
     *  A caller whose block is byte-identical to the previous one re-points at that block
     *  instead of uploading a duplicate. */
    lastOffset = -1;

    /** Current byte cursor. Bundle fast-hit plans use this as a transactional precondition:
     *  fixed dynamic offsets are safe only when every preceding segment consumed the same
     *  arena layout as the frame that built the bundle. */
    position(): number { return this.cursor; }

    /** Bytes still writable this frame. The arena-run preflight measures against this, not
     *  against the frame estimate: begin() over-allocates, and an estimate that is short by a
     *  block must not cost the run its replay. */
    remaining(): number { return this.buffer ? this.capacity - this.cursor : 0; }

    /** Roll back speculative fixed-offset staging. Bytes need not be cleared: subsequent writes
     *  overwrite the rewound range before flush, while already-accepted earlier offsets remain. */
    rewindTo(cursor: number): void {
        if (cursor < 0 || cursor > this.cursor || (cursor & (UNIFORM_ALIGN - 1)) !== 0) {
            throw new UniformArenaCapacityError(this.label, cursor, this.capacity);
        }
        this.cursor = cursor;
        this.lastOffset = -1;
    }

    /** Bump-write the first `floatLen` floats of `data` (zero-alloc), returning the
     *  256-aligned byte offset used as the per-draw dynamic offset. */
    write(data: Float32Array, floatLen: number, tolerateFull = false): number {
        const size = Math.max(16, floatLen * 4);
        const offset = this.cursor;
        const nextCursor = alignUp(offset + size, UNIFORM_ALIGN);
        // Growing here would replace a GPUBuffer after cached bind groups and possibly earlier
        // commands already referenced it. Callers that can decline their run pass tolerateFull
        // and get -1; the rest fail synchronously into executeFrame's arena-run guard.
        if (!this.buffer || nextCursor > this.capacity) {
            if (tolerateFull) return -1;
            throw new UniformArenaCapacityError(this.label, nextCursor, this.capacity);
        }
        if (floatLen > 0) {
            if (this.bulkUpload) {
                this.staging.set(data.subarray(0, floatLen), offset >>> 2);
                this.dirty = true;
            } else {
                // Diagnostic OFF arm for an apples-to-apples A/B on one build.
                this.device.queue.writeBuffer(this.buffer!, offset, data, 0, floatLen);
            }
        }
        this.cursor = nextCursor;
        this.lastOffset = offset;
        return offset;
    }

    /** Publish all per-draw blocks with one queue operation. Queue order keeps this write
     *  after the previous pass submit and before the submit that consumes these offsets. */
    flush(queue: GPUQueue): void {
        if (!this.bulkUpload || !this.dirty || !this.buffer || this.cursor === 0) return;
        // Typed-array overload: dataOffset and size are in elements, not bytes.
        queue.writeBuffer(this.buffer, 0, this.staging, 0, this.cursor >>> 2);
        this.dirty = false;
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

type BundleVertexBinding = {
    slot: number;
    buffer: GPUBuffer;
    offset: number;
    size: number;
};

type PreparedBundleDraw = {
    pipelineId: number;
    pipeline: GPURenderPipeline;
    bindGroup: GPUBindGroup;
    vsOffset: number;
    psOffset: number;
    vertexBindings: BundleVertexBinding[];
    indexBuffer: GPUBuffer;
    indexFormat: GPUIndexFormat;
    indexCount: number;
    startIndex: number;
    baseVertex: number;
};

type RenderBundleSignature = {
    device: GPUDevice;
    colorFormats: Array<GPUTextureFormat | null>;
    depthFormat: GPUTextureFormat;
    sampleCount: number;
    dynamicState: number[];
    objects: object[];
    words: number[];
};

type PreparedBundleSegment = {
    startCommand: number;
    endCommand: number;
    draws: PreparedBundleDraw[];
    arenaRuns: number;
    arenaExpectedPairs: number;
    /** Count derived from PreparedBundleDraw rows actually encoded into the bundle. */
    arenaEncodedPairs: number;
    signature: RenderBundleSignature;
    cacheKey: string;
};

type BundleRawDraw = {
    command: number;
    pipelineId: number;
    bindStateIndex: number;
    vertexBindings: BundleVertexBinding[];
    indexBuffer: GPUBuffer;
    indexFormat: GPUIndexFormat;
    indexCount?: number;
    startIndex?: number;
    baseVertex?: number;
    run?: RenderFrame["arenaIndexedRuns"][number];
};

type BundleCandidate = {
    start: number;
    end: number;
    dynamicState: number[];
    draws: BundleRawDraw[];
    logicalDraws: number;
};

type RenderBundleCacheEntry = {
    signature: RenderBundleSignature;
    bundle: GPURenderBundle;
};

type RenderBundleMaterialProof = {
    stageEpoch: number;
    sampler: GPUSampler | null;
    cubeMask: number;
    comparisonMask: number;
    volumeMask: number;
    vertexVolumeMask: number;
    textures: (GPUTextureView | null)[];
    samplers: (GPUSampler | null)[];
    vertexTextures: (GPUTextureView | null)[];
    vertexSamplers: (GPUSampler | null)[];
};

type RenderBundleFastRawPlan = {
    command: number;
    pipelineId: number;
    bindStateIndex: number;
    pipeline: GPURenderPipeline;
    material: RenderBundleMaterialProof;
    vertexBindings: BundleVertexBinding[];
    indexBuffer: GPUBuffer;
    indexFormat: GPUIndexFormat;
    indexCount?: number;
    startIndex?: number;
    baseVertex?: number;
    expectedPairCount: number;
    /** Arena row/state identities are exact layout guards and point at live WASM memory. */
    arenaRows: number[];
    arenaStateOffsets: number[];
    capturedVs: Float32Array[];
};

type RenderBundleFastDrawPlan = {
    rawIndex: number;
    runRow: number;
    vsLen: number;
    psLen: number;
};

type RenderBundleFastPlan = {
    lookupKey: string;
    cacheKey: string;
    cacheEntry: RenderBundleCacheEntry;
    device: GPUDevice;
    colorFormats: Array<GPUTextureFormat | null>;
    depthFormat: GPUTextureFormat;
    sampleCount: number;
    dynamicState: number[];
    startCommand: number;
    endCommand: number;
    logicalDraws: number;
    vsBuffer: GPUBuffer;
    psBuffer: GPUBuffer;
    vsStart: number;
    psStart: number;
    vsEnd: number;
    psEnd: number;
    /** All arena typed views are over this buffer. A memory.grow detaches/replaces it and
     *  therefore rejects the fast path before a cached Float32Array is read. */
    arenaMemory: ArrayBufferLike;
    raws: RenderBundleFastRawPlan[];
    draws: RenderBundleFastDrawPlan[];
    segment: PreparedBundleSegment;
};

type RenderBundleFastRejectReason =
    | "noPlan" | "planShape" | "attachment" | "cursor" | "cacheEntry"
    | "arenaMemory" | "rawShape" | "material" | "arenaLayout" | "constants";

type RenderBundleFastConstantRejectReason = "length" | "vsOffset" | "psOffset" | "endCursor";

type MegaBatchRunPlan = {
    pipeline: GPURenderPipeline;
    bindGroup: GPUBindGroup;
    psOffset: number;
    firstSlot: number;
    instanceCount: number;
    /** Captured pairs packed into the storage bank; excludes an adjacent fused ordinary draw.
     *  Cross-checked against the instances the draw issues, never used as the executed count. */
    encodedPairCount: number;
    indexCount: number;
    startIndex: number;
    baseVertex: number;
    packedBytes: number;
    /** Exact ordinary DrawIndexed command folded into instance zero, or -1. */
    fusedDrawCommand: number;
    /** BindProgrammable command owned solely by fusedDrawCommand, or -1. */
    fusedBindCommand: number;
};

type MegaBatchFusionCandidate = {
    drawCommand: number;
    bindCommand: number;
    bindStateIndex: number;
    pipelineId: number;
    indexCount: number;
    startIndex: number;
    baseVertex: number;
    instanceCount: number;
    vbRefs: Int32Array;
    vbOffsets: Int32Array;
    vbSizes: Int32Array;
    ibRef: number;
    ibFormat: number;
};

export class D3D9BackendExecutor {
    private backend: WebGPUBackend;
    private pipelines: GPURenderPipeline[] = [];
    private pipelineInfo: PipelineInfo[] = [];
    /** Full canonical arena identities are registered alongside pipelines. The compact
     * Rust hash is only a bucket; this map lets the executor independently resolve the
     * identity carried by an arena binding instead of trusting a device-supplied id. */
    private arenaPipelinesByIdentity = new Map<string, number>();
    /** Throws caught in executeFrame; drives the log throttle there. */
    private executeFrameThrows = 0;
    /** Monotonic local id used to attribute asynchronous validation back to a submitted frame. */
    private executeFrameSerial = 0;
    /** Query manager currently attached to the D3D9 device. Helper submits share its serial
     * domain with execute() so SetRenderTarget/Clear/StretchRect cannot strand an open query. */
    private activeQueryManager: D3D9QueryManager | null = null;

    /** [diag] queue.submit census (harness submitCensus verb). Measures the SUBMIT, not the
     *  frame: `nfsu-submit-cost` times the whole `submitFrame()` (finalize + execute + submit)
     *  and its 166 us/call was read as the submit's price — it is ~13 us. A lever sized off
     *  the wrong one of those is 35x out. */
    private submitCount = 0;
    private presentCount = 0;
    private submitMs = 0;

    getSubmitStats(reset = false): {
        submits: number; presents: number; submitsPerPresent: number | null;
        submitMsPerPresent: number | null; usPerSubmit: number | null;
    } {
        const out = {
            submits: this.submitCount,
            presents: this.presentCount,
            submitsPerPresent: this.presentCount > 0 ? this.submitCount / this.presentCount : null,
            submitMsPerPresent: this.presentCount > 0 ? this.submitMs / this.presentCount : null,
            usPerSubmit: this.submitCount > 0 ? (this.submitMs * 1000) / this.submitCount : null,
        };
        if (reset) { this.submitCount = 0; this.presentCount = 0; this.submitMs = 0; }
        return out;
    }

    /**
     * [diag] Bind-group census (harness `d3d9BindGroupCensus`). Answers per cache: how often it
     * was asked, how often it answered, and — for the programmable one, the only one a
     * VS+PS title uses — whether a build was a returning material (capacity) or a new one.
     *
     * `presents` is in the same window, so every rate here is per FRAME without a second
     * snapshot from a different clock. `perFrameBuilds: null` means no frame was presented in
     * the window: no denominator, so no rate, rather than a number divided by zero draws.
     */
    getBindGroupCensus(reset = false): Record<string, number | string | null | boolean> {
        const c = this.census;
        // The census owns its own frame counter: `presentCount` belongs to submitCensus, and a
        // probe that resets that one would silently leave this rate dividing by the wrong window.
        const frames = this.censusPresents;
        const progAsked = c.progAcquires;
        const builds = c.progBuilds + c.ffpAutoBuilds + c.ffpSharedBuilds + c.frameLevelBuilds;
        const out: Record<string, number | string | null | boolean> = {
            frames,
            ...c,
            progHitRate: progAsked > 0 ? c.progHits / progAsked : null,
            perFrameProgBuilds: frames > 0 ? c.progBuilds / frames : null,
            perFrameBuilds: frames > 0 ? builds / frames : null,
            // Distinct GPU objects the programmable key has ever had to name. In a steady scene
            // this must be flat; growth in step with progBuilds means the views/samplers are
            // being recreated upstream and the cache cannot be the fix.
            gpuIdsAssigned: this.nextGpuId - 1,
            progCacheLen: this.progCacheLen,
            progCacheN: this.progCacheN,
            ffpAutoLen: this.ffpAutoLen,
            ffpAutoCacheN: this.ffpAutoCacheN,
            seenHashes: this.censusSeenProgHashes.size,
            seenSaturated: this.censusSeenSaturated,
            bindGroupSets: this.metrics.bindGroupSets,
            bindGroupSetSkips: this.metrics.bindGroupSetSkips,
            drawCalls: this.metrics.drawCalls,
            // us/call for acquireProgBindGroup, by outcome. null = the profile never ran
            // (`__d3d9BindGroupProfile`), which is not the same as "it was free".
            profiling: this.bgProfiling(),
            // Front-memo oracle. `fastKeyChecked: 0` says it never ran, not that it agreed.
            fastKeyOn: this.fastKeyEnabled(),
            fastKeyVerify: this.fastKeyVerifying(),
            fastKeyChecked: this.fastKeyChecked,
            fastKeyUnsafe: this.fastKeyUnsafe,
            fastKeyConservative: this.fastKeyConservative,
            fastKeyVerdict: this.fastKeyChecked === 0
                ? "front-memo oracle did not run"
                : (this.fastKeyUnsafe === 0 ? "safe" : "UNSAFE"),
            hitUs: this.bgProfN[0]! > 0 ? (this.bgProfMs[0]! * 1000) / this.bgProfN[0]! : null,
            missUs: this.bgProfN[1]! > 0 ? (this.bgProfMs[1]! * 1000) / this.bgProfN[1]! : null,
            clockUs: this.bgProfN[2]! > 0 ? (this.bgProfMs[2]! * 1000) / this.bgProfN[2]! : null,
            // us/call for a front-memo hit — the same span as `hitUs`, so the two are directly
            // comparable and the saving is (hitUs - fastUs) x progFastKeyHits.
            fastUs: this.bgProfN[3]! > 0 ? (this.bgProfMs[3]! * 1000) / this.bgProfN[3]! : null,
        };
        if (reset) {
            c.progAcquires = 0; c.progHits = 0; c.progBuilds = 0; c.progRebuiltHash = 0;
            c.progEvictLive = 0; c.progFastKeyHits = 0; c.ffpAutoAcquires = 0; c.ffpAutoHits = 0; c.ffpAutoBuilds = 0;
            c.ffpAutoEvictLive = 0; c.ffpSharedBuilds = 0; c.frameLevelBuilds = 0;
            this.censusPresents = 0;
            this.fastKeyChecked = 0; this.fastKeyUnsafe = 0; this.fastKeyConservative = 0;
            for (let i = 0; i < this.bgProfMs.length; i++) { this.bgProfMs[i] = 0; this.bgProfN[i] = 0; }
            // drawCalls/bindGroupSets are shared with other verbs; leave them to their owners.
        }
        return out;
    }

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
    private offscreenSrgbView: GPUTextureView | null = null;
    private depthTexture: GPUTexture | null = null;
    private depthView: GPUTextureView | null = null;
    /** Opt-in D3D9 backbuffer MSAA resources; null until an adapter probe accepts a count. */
    private d3d9MsaaCache: D3D9MultisampleTargetCache | null = null;
    private d3d9MsaaTarget: D3D9MultisampleTarget | null = null;
    private d3d9MsaaSampleCount = 1;
    private d3d9MsaaProbe: D3D9MsaaAdapterProbe | null = null;
    private offscreenSize: { width: number; height: number } | null = null;
    // Snapshot of the last COMPLETE presented frame. The offscreen is rendered incrementally
    // across a game frame's multiple submitFrame() passes (a backbuffer clear flushes to it
    // before the scene is redrawn — e.g. when render-to-texture passes sit between the clear and
    // the scene), so mid-frame the offscreen is transiently black. repaintLastFrame() re-presents
    // THIS snapshot (updated only at actual present) instead of the work-in-progress offscreen, so
    // the canvas never flashes the black intermediate at the RAF rate. See NFSU cube-reflection flicker.
    private presentedTexture: GPUTexture | null = null;
    private hasPresented = false;
    /** Shared textured-quad copier used by D3D9 StretchRect. */
    private stretchRectPipeline: ColorKeyBlitPipeline | null = null;
    /** Solid fill pipelines used by ColorFill on GPU render-target sub-rectangles, keyed
     *  `format:sampleCount`: a WebGPU pipeline's sample count must equal its attachment's,
     *  so a rectangle Clear of an MSAA target needs its own variant. */
    private solidFillPipelines = new Map<string, GPURenderPipeline>();
    private solidFillBindGroupLayout: GPUBindGroupLayout | null = null;
    private solidFillUniform: GPUBuffer | null = null;
    /** Pipelines used by attachment-specific depth/stencil rectangle clears.  A D3D9 rect
     * clear cannot be represented by a render-pass loadOp (loadOp ignores scissor), so these
     * variants draw a fullscreen triangle under a scissor while keeping the attachment loaded. */
    private depthStencilClearPipelines: Map<string, {
        pipeline: GPURenderPipeline;
        bindGroupLayout: GPUBindGroupLayout;
        uniform: GPUBuffer;
        hasStencil: boolean;
    }> = new Map();

    private noteQuerySubmission(): void {
        const manager = this.activeQueryManager;
        if (!manager) return;
        const serial = manager.allocateSubmissionSerial();
        manager.notifySubmitted(serial);
    }

    // Fallback texture for when no texture is bound
    private fallbackTexture: GPUTexture | null = null;
    private fallbackTextureView: GPUTextureView | null = null;
    // Cube fallback (1×1×6) for cube-sampler stages with no bound texture.
    private fallbackCubeTexture: GPUTexture | null = null;
    private fallbackCubeView: GPUTextureView | null = null;
    // 1×1×1 fallback for programmable volume-sampler slots.
    private fallbackVolumeTexture: GPUTexture | null = null;
    private fallbackVolumeView: GPUTextureView | null = null;
    private fallbackDepthTexture: GPUTexture | null = null;
    private fallbackDepthView: GPUTextureView | null = null;
    private comparisonSampler: GPUSampler | null = null;

    // Performance metrics
    public metrics = {
        pipelineSets: 0,
        bindGroupSets: 0,
        bindGroupSetSkips: 0,
        bindGroupCacheHits: 0,
        // Bind groups actually built. The hit count alone cannot say whether a cache is
        // working — a path that never hits and a path that never runs read the same.
        bindGroupBuilds: 0,
        drawCalls: 0,
        /** Indexed draws actually encoded, including every pair replayed by an arena run. */
        drawIndexedCalls: 0,
        renderBundleHits: 0,
        renderBundleMisses: 0,
        renderBundleBuilds: 0,
        renderBundleEvictions: 0,
        renderBundleExecutions: 0,
        renderBundleDraws: 0,
        renderBundleFailures: 0,
        renderBundleSignatureMismatches: 0,
        renderBundleFastHits: 0,
        renderBundleFastFallbacks: 0,
        renderBundleFastPlanBuilds: 0,
        renderBundleFastGuardMs: 0,
        renderBundleFastStageMs: 0,
        renderBundlePrepareMs: 0,
        renderBundleFastRejectNoPlan: 0,
        renderBundleFastRejectPlanShape: 0,
        renderBundleFastRejectAttachment: 0,
        renderBundleFastRejectCursor: 0,
        renderBundleFastRejectCacheEntry: 0,
        renderBundleFastRejectArenaMemory: 0,
        renderBundleFastRejectRawShape: 0,
        renderBundleFastRejectMaterial: 0,
        renderBundleFastRejectArenaLayout: 0,
        renderBundleFastRejectConstants: 0,
        renderBundleFastRejectConstantLength: 0,
        renderBundleFastRejectConstantVsOffset: 0,
        renderBundleFastRejectConstantPsOffset: 0,
        renderBundleFastRejectConstantEndCursor: 0,
        megaBatchPipelineBuilds: 0,
        megaBatchBatches: 0,
        megaBatchLogicalDraws: 0,
        megaBatchPhysicalDraws: 0,
        megaBatchPackedBytes: 0,
        megaBatchFallbacks: 0,
        megaBatchRejectShape: 0,
        megaBatchRejectLimits: 0,
        megaBatchRejectConstants: 0,
        megaBatchRejectVsLength: 0,
        megaBatchRejectPsLength: 0,
        megaBatchRejectPsValue: 0,
        megaBatchPrepareCalls: 0,
        megaBatchCandidateRuns: 0,
        megaBatchRunsWithoutPipeline: 0,
        megaBatchRejectDisabled: 0,
        megaBatchRejectNoRuns: 0,
        megaBatchRejectNoArenas: 0,
        megaBatchPrepareMs: 0,
        /** Time spent finding the one ordinary draw that can be fused into each arena run. */
        megaBatchFusionMs: 0,
        /** First pass over run metadata used to size the shared VS storage upload. */
        megaBatchSizingMs: 0,
        /** Second pass: arena-row validation, material resolution and instance packing. */
        megaBatchPlanPackMs: 0,
        megaBatchUploadMs: 0,
        megaBatchNormalPipelineSkips: 0,
        megaBatchFusedOrdinaryDraws: 0,
        megaBatchFusionAdjacentBefore: 0,
        megaBatchFusionAdjacentAfter: 0,
        megaBatchFusionRejectBarrier: 0,
        megaBatchFusionRejectPipeline: 0,
        megaBatchFusionRejectIndex: 0,
        megaBatchFusionRejectVertex: 0,
        compactMegaRunsPlanned: 0,
        compactMegaRunFallbacks: 0,
        compactMegaRunDecodeFailures: 0,
        clearCalls: 0,
        progConstWrites: 0,
        progConstReuseHits: 0,
    };

    /** Full-pass render bundles are experimental and default OFF until host A/B validates them. */
    private renderBundleCache = new Map<string, RenderBundleCacheEntry>();
    /** Exact, bounded front plans. The short lookup key is only a bucket selector; a hit is
     *  authoritative only after the plan's device/resources/commands/materials all match. */
    private renderBundleFastPlans = new Map<string, RenderBundleFastPlan[]>();
    private renderBundleFastPlanCount = 0;
    private renderBundleDevice: GPUDevice | null = null;
    private renderBundleVsBuffer: GPUBuffer | null = null;
    private renderBundlePsBuffer: GPUBuffer | null = null;
    private megaVsBuffer: GPUBuffer | null = null;
    private megaVsSlotBytes = 0;
    private megaVsCapacitySlots = 0;
    private megaVsStagingBits = new Uint32Array(0);
    /** Reused scan scratch. One arena command can contribute at most one captured draw slot. */
    private megaCapturedStateOffsets = new Uint32Array(D3D9_ARENA_CMD_CAP);
    /** The ordinary bind group is a collision-safe material identity. A nested pipeline map
     * yields the corresponding storage-VS group without re-hashing 41 GPU objects per run. */
    private megaBindGroups = new WeakMap<GPUBindGroup, Map<number, {
        storage: GPUBuffer; ps: GPUBuffer; group: GPUBindGroup;
    }>>();
    private megaBatchEnabled(): boolean {
        return (globalThis as { __d3d9MegaBatch?: boolean }).__d3d9MegaBatch !== false;
    }
    private megaBatchFusionEnabled(): boolean {
        return (globalThis as { __d3d9MegaBatchFusion?: boolean }).__d3d9MegaBatchFusion !== false;
    }
    private compactMegaRunEnabled(): boolean {
        return (globalThis as { __d3d9CompactMegaRun?: boolean }).__d3d9CompactMegaRun !== false;
    }
    private renderBundlesEnabled(): boolean {
        return (globalThis as { __d3d9RenderBundles?: boolean }).__d3d9RenderBundles === true;
    }
    private renderBundleFastHitsEnabled(): boolean {
        return (globalThis as { __d3d9RenderBundleFastHits?: boolean }).__d3d9RenderBundleFastHits === true;
    }
    private renderBundleProfiling(): boolean {
        return (globalThis as { __d3d9RenderBundleProfile?: boolean }).__d3d9RenderBundleProfile === true;
    }
    private renderBundleCacheCapacity(): number {
        const raw = Number((globalThis as { __d3d9RenderBundleCacheN?: number }).__d3d9RenderBundleCacheN ?? 64);
        return Number.isFinite(raw) ? Math.max(1, Math.min(256, raw | 0)) : 64;
    }
    private renderBundleMinDraws(): number {
        const raw = Number((globalThis as { __d3d9RenderBundleMinDraws?: number }).__d3d9RenderBundleMinDraws ?? 32);
        return Number.isFinite(raw) ? Math.max(2, Math.min(4096, raw | 0)) : 32;
    }
    private clearRenderBundleCache(): void {
        this.renderBundleCache.clear();
        this.renderBundleFastPlans.clear();
        this.renderBundleFastPlanCount = 0;
    }

    /**
     * [diag] Why a bind-group build happened — the question `bindGroupBuilds` alone cannot
     * answer, and the one a fix has to be sized off.
     *
     * `rebuiltHash` is a key that HAS been built before: the material came back and the cache
     * no longer had it, i.e. capacity/eviction. `evictLive` is the ring overwriting an occupied
     * slot, the mechanism behind that. `gpuIdsAssigned` is the count of distinct GPU objects the
     * key has ever seen — if it climbs in step with the builds in a steady scene, the views and
     * samplers themselves are being recreated upstream and no cache sizing can help.
     *
     * A build that is neither a rebuiltHash nor accompanied by gpuId growth is a genuinely new
     * material, which is the case where the cache is simply right.
     */
    private census = {
        progAcquires: 0, progHits: 0, progBuilds: 0, progRebuiltHash: 0, progEvictLive: 0,
        progFastKeyHits: 0,
        ffpAutoAcquires: 0, ffpAutoHits: 0, ffpAutoBuilds: 0, ffpAutoEvictLive: 0,
        ffpSharedBuilds: 0, frameLevelBuilds: 0,
    };
    /** Hashes ever built, so a returning material is distinguishable from a new one. Bounded:
     *  a diagnostic must not be able to grow without limit in a long session. */
    private censusSeenProgHashes = new Set<number>();
    private censusSeenSaturated = false;
    private censusPresents = 0;

    /**
     * [diag] What `acquireProgBindGroup` costs, split by outcome. Default off (live flag
     * `__d3d9BindGroupProfile`), because the clock reads it needs are comparable to what it
     * measures — `clockMs/clockN` is that floor and the verb reports it beside the buckets.
     *
     * The split matters because the two answers point at opposite fixes: if the HIT is
     * expensive the lever is the key (41 WeakMap lookups and 40 identity compares per draw,
     * paid whether or not the group is found), if the MISS is the lever is the cache.
     */
    private bgProfMs = [0, 0, 0, 0];
    private bgProfN = [0, 0, 0, 0];
    private bgProfiling(): boolean {
        return (globalThis as { __d3d9BindGroupProfile?: boolean }).__d3d9BindGroupProfile === true;
    }

    /**
     * Front memo for `acquireProgBindGroup`, default ON (live kill switch
     * `__d3d9ProgBindFastKey = false`).
     *
     * The full key names 41 GPU objects through a WeakMap and verifies up to 40 of them by
     * identity, on EVERY draw — and the census says the cache never misses in a steady scene,
     * so that is the whole cost. The device stamps each draw state with the epoch of the stage
     * window that filled it; equal epochs mean the SAME view and sampler objects, not merely
     * equal ones, so with the sampler and the four masks the group is decided. Anything that
     * moves the window bumps the epoch, and a miss falls through to the full path unchanged —
     * this can only skip re-deriving a key, never invent a group.
     *
     * It is a front memo, not a replacement cache: it never inserts, so it cannot spray
     * duplicate groups into the ring the way a widened cache key would.
     */
    private fastKeyEpoch = -1;
    private fastKeySampler: GPUSampler | null = null;
    private fastKeyCube = -1;
    private fastKeyComparison = -1;
    private fastKeyVolume = -1;
    private fastKeyVertexVolume = -1;
    private fastKeyGroup: GPUBindGroup | null = null;
    private fastKeyChecked = 0;
    private fastKeyUnsafe = 0;
    private fastKeyConservative = 0;
    private fastKeyEnabled(): boolean {
        return (globalThis as { __d3d9ProgBindFastKey?: boolean }).__d3d9ProgBindFastKey !== false;
    }
    private fastKeyVerifying(): boolean {
        return (globalThis as { __d3d9ProgBindFastKeyVerify?: boolean }).__d3d9ProgBindFastKeyVerify === true;
    }
    /** Invalidate the front memo. Anything that can retire a cached group must call this. */
    private dropProgBindFastKey(): void {
        this.fastKeyEpoch = -1;
        this.fastKeySampler = null;
        this.fastKeyGroup = null;
    }
    /**
     * Publish the front memo and, while verifying, compare its prediction against the group the
     * full path actually returned. `unsafe` is a predicted group the full path disagrees with
     * and must stay 0; `conservative` is a prediction declined where the full path returned the
     * same group anyway — a lost skip, a cost rather than a bug.
     */
    private finishProgAcquire(
        group: GPUBindGroup, armed: boolean, verifying: boolean,
        predicted: boolean, stageEpoch: number, sampler: GPUSampler,
        cubeMask: number, comparisonMask: number, volumeMask: number, vertexVolumeMask: number,
    ): GPUBindGroup {
        // Publish nothing while disarmed: the OFF arm of an A/B must be the code that shipped
        // before the flag existed, or the comparison quietly favours the change.
        if (!armed) return group;
        if (verifying) {
            this.fastKeyChecked++;
            if (predicted) { if (group !== this.fastKeyGroup) this.fastKeyUnsafe++; }
            else if (this.fastKeyGroup !== null && group === this.fastKeyGroup) this.fastKeyConservative++;
        }
        this.fastKeyEpoch = stageEpoch;
        this.fastKeySampler = sampler;
        this.fastKeyCube = cubeMask;
        this.fastKeyComparison = comparisonMask;
        this.fastKeyVolume = volumeMask;
        this.fastKeyVertexVolume = vertexVolumeMask;
        this.fastKeyGroup = group;
        return group;
    }

    constructor(backend: WebGPUBackend) {
        this.backend = backend;
    }

    /** Configure the implicit D3D9 backbuffer MSAA path from an explicit adapter probe. */
    configureD3D9BackbufferMsaa(sampleCount: number, probe: D3D9MsaaAdapterProbe | null): boolean {
        const normalized = sampleCount === 2 || sampleCount === 4 ? sampleCount : 1;
        if (normalized > 1) {
            // Keep the probe contract narrowed to the only sample counts D3D9 exposes here.
            // TypeScript cannot retain the ternary narrowing through the short-circuit above.
            const msaaCount = normalized === 2 || normalized === 4 ? normalized : null;
            if (!probe || msaaCount === null || !probe.supportsSampleCount(msaaCount)) return false;
        }
        if (normalized === this.d3d9MsaaSampleCount && probe === this.d3d9MsaaProbe) return true;
        this.d3d9MsaaSampleCount = normalized;
        this.d3d9MsaaProbe = normalized > 1 ? probe : null;
        this.d3d9MsaaTarget = null;
        this.d3d9MsaaCache?.destroy();
        this.d3d9MsaaCache = null;
        return true;
    }

    /**
     * Every handle here is device-derived and rebuilt lazily from CPU-side state (pipelines
     * from their descriptors, bind groups from the views they cache, the ring/uniform buffers
     * on first use), so recovery is exactly "forget all of it". `pipelines` is INDEX-addressed
     * by the pipeline cache in D3D9Device — dropping the array without dropping that cache
     * would leave live ids pointing past the end, so the two are cleared together (see
     * D3D9Device.onDeviceLost).
     */
    dropDeviceResources(): void {
        this.clearRenderBundleCache();
        this.renderBundleDevice = null;
        this.renderBundleVsBuffer = null;
        this.renderBundlePsBuffer = null;
        this.pipelines = [];
        this.pipelineInfo = [];
        this.arenaPipelinesByIdentity.clear();
        this.currentPipelineId = null;
        this.bindGroupCache.clear();
        this.uniformBuffer = null;
        this.uniformBufferSize = 0;
        this.vsUniformBuffer = null;
        this.sampler = null;
        this.offscreenTexture = null;
        this.offscreenView = null;
        this.offscreenSrgbView = null;
        this.depthTexture = null;
        this.depthView = null;
        this.d3d9MsaaCache = null;
        this.d3d9MsaaTarget = null;
        this.presentedTexture = null;
        this.hasPresented = false;
        // Holds buffers created on the lost device — rebuilt lazily on the next StretchRect.
        this.stretchRectPipeline?.destroy();
        this.stretchRectPipeline = null;
        this.solidFillPipelines.clear();
        this.solidFillBindGroupLayout = null;
        this.solidFillUniform?.destroy();
        this.solidFillUniform = null;
        for (const resources of this.depthStencilClearPipelines.values()) {
            resources.uniform.destroy();
        }
        this.depthStencilClearPipelines.clear();
        this.paddedVb = null;
        this.paddedVbSize = 0;
        this.padCount = 0;
        this.padCursor = 0;
        this.boundVbBuffer.fill(null);
        this.fallbackTexture = null;
        this.fallbackTextureView = null;
        this.fallbackCubeTexture = null;
        this.fallbackCubeView = null;
        this.fallbackVolumeTexture = null;
        this.fallbackVolumeView = null;
        this.fallbackDepthTexture = null;
        this.fallbackDepthView = null;
        this.comparisonSampler = null;
        this.megaVsBuffer = null;
        this.megaVsSlotBytes = 0;
        this.megaVsCapacitySlots = 0;
        this.megaVsStagingBits = new Uint32Array(0);
        this.megaBindGroups = new WeakMap();
        this.progLayouts.clear();
        this.progCacheSampler = [];
        this.dropProgBindFastKey();
        this.progCacheViews = new Array(this.progCacheN * PROG_BIND.MAX_TEX).fill(null);
        this.progCacheStageSamplers = new Array(this.progCacheN * PROG_BIND.MAX_TEX).fill(null);
        this.progCacheVertexViews = new Array(this.progCacheN * VERTEX_TEXTURE_SAMPLER_COUNT).fill(null);
        this.progCacheVertexSamplers = new Array(this.progCacheN * VERTEX_TEXTURE_SAMPLER_COUNT).fill(null);
        this.progCacheGroup = [];
        this.progCacheCubeMask = [];
        this.progCacheComparisonMask = [];
        this.progCacheVolumeMask = [];
        this.progCacheVertexVolumeMask = [];
        this.progCacheHash = [];
        this.progCacheIndex.clear();
        this.progCacheLen = 0;
        this.progCacheCursor = 0;
        this.progCacheVsBuffer = null;
        this.progCachePsBuffer = null;
        this.vsArena = null;
        this.psArena = null;
        this.ffpArena = null;
        this.ffpLayout = null;
        this.ffpCacheSampler = [];
        this.ffpCacheView = [];
        this.ffpCacheStages = [];
        this.ffpCacheGroup = [];
        this.ffpCacheLen = 0;
        this.ffpCacheCursor = 0;
        this.ffpCacheBuffer = null;
        this.lastBoundBindGroup = null;
        this.resetFfpAutoCache();
        this.ffpAutoBuffer = null;
        this.autoLayouts = [];
    }

    /**
     * Register a pipeline and return its ID
     */
    registerPipeline(
        pipeline: GPURenderPipeline,
        hasTexture: boolean,
        programmable = false,
        ffpStageCount = 1,
        strides: number[] = [],
        attrEnds: number[] = [],
        arenaIdentity?: string,
    ): number {
        const id = this.pipelines.length;
        this.pipelines.push(pipeline);
        this.pipelineInfo.push({ pipeline, hasTexture, programmable, ffpStageCount, strides, attrEnds });
        if (programmable && arenaIdentity !== undefined) {
            this.arenaPipelinesByIdentity.set(arenaIdentity, id);
        }
        return id;
    }

    /** Attach a canonical arena identity to a pipeline that was first built through the
     * legacy programmable cache. This closes the ordering hole where the first draw of a
     * material did not carry an arena key but a later arena draw still needs executor-side
     * identity resolution. */
    registerArenaPipelineIdentity(identity: string, pipelineId: number): void {
        if (identity.length > 0 && pipelineId >= 0 && pipelineId < this.pipelines.length
            && this.pipelineInfo[pipelineId]?.programmable) {
            this.arenaPipelinesByIdentity.set(identity, pipelineId);
        }
    }

    attachMegaBatchPipeline(pipelineId: number, pipeline: GPURenderPipeline, vsSlotBytes: number): void {
        const info = this.pipelineInfo[pipelineId];
        if (!info?.programmable || vsSlotBytes <= 0 || (vsSlotBytes & 15) !== 0) return;
        info.megaBatch = { pipeline, vsSlotBytes };
        this.metrics.megaBatchPipelineBuilds++;
    }

    /** Discard frame-local arena identity links when submitFrame refuses before execute(). */
    clearArenaPipelineIdentities(): void {
        this.arenaPipelinesByIdentity.clear();
    }

    /**
     * The bindings each slot carries, as the last SetVertexBuffer left them. The padding path
     * puts the guest's own binding back after a substituted draw, so all three numbers are
     * kept, not just the size.
     */
    private boundVbSize = new Float64Array(MAX_VB_SLOTS);
    private boundVbOffset = new Float64Array(MAX_VB_SLOTS);
    private boundVbBuffer: (GPUBuffer | null)[] = new Array(MAX_VB_SLOTS).fill(null);

    // ── Robustness padding for a slot a draw outruns ──────────────────────
    //
    // WebGPU sizes a NON-indexed draw exactly as
    //   (firstVertex + vertexCount - 1) * arrayStride + <end of the slot's last attribute>
    // and refuses an overrun — and the refusal invalidates the WHOLE command buffer, so one
    // short slot costs every other draw in the frame. Hardware does not refuse: Vulkan/D3D9
    // robust buffer access hands the shader zeros for what lies PAST the end and rasterizes
    // everything before it normally. Zeroing the whole slot instead (which is all a bare
    // substitution can do) blanks the vertices that WERE in range too, and a sprite whose
    // colours and UVs all read zero is a very different picture from one missing its tail.
    //
    // Reproducing hardware needs the real bytes copied into a longer buffer with a zeroed
    // tail, and a copy is legal only OUTSIDE a render pass while the draw is encoded inside
    // one. So the frame's commands are walked once before the pass opens: the walk replays the
    // binding state the encode loop will see, applies the rule above, and stages the copies on
    // the frame's own encoder. Encoding then only swaps the padded binding in for that one
    // draw and swaps the guest's binding back after it.
    private padCmd = new Int32Array(32);
    private padSlot = new Int32Array(32);
    private padSrcRef = new Int32Array(32);
    private padSrcOffset = new Float64Array(32);
    private padCopyBytes = new Float64Array(32);
    /** Offset into the padded buffer, or -1 for an entry that could not be copied and falls
     *  back to the zero-filled stand-in for the whole slot. */
    private padDstOffset = new Float64Array(32);
    private padSize = new Float64Array(32);
    private padCount = 0;
    private padCursor = 0;
    private paddedVb: GPUBuffer | null = null;
    private paddedVbSize = 0;
    // The plan walk's own copy of the binding state (it runs before any of it is encoded).
    private planVbSize = new Float64Array(MAX_VB_SLOTS);
    private planVbOffset = new Float64Array(MAX_VB_SLOTS);
    private planVbRef = new Int32Array(MAX_VB_SLOTS);

    /** Draws whose vertex range overran a bound slot and were padded (or zeroed) for it. */
    vertexRangeRejects = 0;

    private growPadPlan(): void {
        if (this.padCount < this.padCmd.length) return;
        const n = this.padCmd.length * 2;
        const growI = (a: Int32Array) => { const b = new Int32Array(n); b.set(a); return b; };
        const growF = (a: Float64Array) => { const b = new Float64Array(n); b.set(a); return b; };
        this.padCmd = growI(this.padCmd);
        this.padSlot = growI(this.padSlot);
        this.padSrcRef = growI(this.padSrcRef);
        this.padSrcOffset = growF(this.padSrcOffset);
        this.padCopyBytes = growF(this.padCopyBytes);
        this.padDstOffset = growF(this.padDstOffset);
        this.padSize = growF(this.padSize);
    }

    /**
     * Walk the frame's commands, size every non-indexed draw by WebGPU's rule, and stage the
     * copies that make a short slot behave like hardware robustness. Runs on the frame's
     * encoder BEFORE its render pass opens — the only place a buffer copy is legal.
     */
    private planVertexRangePadding(frame: RenderFrame, device: GPUDevice, encoder: GPUCommandEncoder): void {
        this.padCount = 0;
        this.padCursor = 0;
        this.planVbSize.fill(0);
        this.planVbOffset.fill(0);
        this.planVbRef.fill(-1);
        let pipelineId = -1;
        let padBytes = 0;

        for (let i = 0; i < frame.commandTypes.length; i++) {
            const type = frame.commandTypes[i];
            if (type === RenderCommandType.SetPipeline) {
                pipelineId = frame.commandA[i];
                continue;
            }
            if (type === RenderCommandType.SetVertexBuffer) {
                const slot = frame.commandD[i] | 0;
                if (slot < MAX_VB_SLOTS) {
                    this.planVbRef[slot] = frame.commandA[i];
                    this.planVbOffset[slot] = frame.commandB[i];
                    this.planVbSize[slot] = frame.commandC[i];
                }
                continue;
            }
            // Indexed draws are deliberately absent: WebGPU cannot bound an index-driven
            // vertex range and validates nothing, so there is no rejection to pre-empt.
            if (type !== RenderCommandType.Draw) continue;
            // A malformed command must not reach vertexRangeEndBytes: its bitwise
            // padding path can turn a NaN/negative count into an enormous region,
            // and a later WebGPU validation error would poison the whole frame.
            if (validateD3D9RasterDrawCommand({
                kind: "non-indexed",
                count: frame.commandA[i]!,
                start: frame.commandB[i]!,
                instanceCount: frame.commandD[i]!,
            }) !== null) continue;
            const info = pipelineId >= 0 ? this.pipelineInfo[pipelineId] : undefined;
            const strides = info?.strides;
            if (!strides) continue;
            const vertexCount = frame.commandA[i];
            const firstVertex = frame.commandB[i];
            const slots = Math.min(strides.length, MAX_VB_SLOTS);
            for (let slot = 0; slot < slots; slot++) {
                const stride = strides[slot]!;
                if (stride <= 0) continue;
                const need = vertexRangeEndBytes(firstVertex, vertexCount, stride,
                    info!.attrEnds[slot] ?? 0);
                const have = this.planVbSize[slot]!;
                if (need <= have) continue;

                this.vertexRangeRejects++;
                // Both the detail string and the warn are sampled: this runs per rejected slot of
                // every draw, and the sink keeps the last non-empty detail either way.
                const sample = this.vertexRangeRejects % 500 === 1;
                d3d9PerfVertexRangeOOB(need - have, !sample ? "" :
                    `slot=${slot} first=${firstVertex} count=${vertexCount} stride=${stride} `
                    + `need=${need} bound=${have} guestStride=${frame.commandC[i]} `
                    + `pipeline=${pipelineId} programmable=${info!.programmable} `
                    + `pipelineStrides=[${strides.join(",")}]`);
                if (sample) {
                    Logger.warn(LogCategory.D3D9,
                        `[D3D9] slot ${slot} short for this draw: needs ${need}B (first=${firstVertex} `
                        + `count=${vertexCount} stride=${stride}), ${have}B bound — padding with zeros`);
                }
                padBytes = this.addPadEntry(frame, i, slot, need, have, padBytes);
            }
        }

        if (this.padCount === 0) return;
        this.ensurePaddedBuffer(device, padBytes);
        for (let k = 0; k < this.padCount; k++) {
            const dst = this.padDstOffset[k]!;
            if (dst < 0) continue;
            const copyBytes = this.padCopyBytes[k]!;
            if (copyBytes > 0) {
                encoder.copyBufferToBuffer(frame.bufferRefs[this.padSrcRef[k]!], this.padSrcOffset[k]!,
                    this.paddedVb!, dst, copyBytes);
            }
            // The region is reused across draws and frames, so the tail must be zeroed, not
            // merely left alone.
            const tail = this.padSize[k]! - copyBytes;
            if (tail > 0) encoder.clearBuffer(this.paddedVb!, dst + copyBytes, tail);
        }
    }

    /** Record one short slot, as a padded copy where the source allows one. Returns the new
     *  padded-buffer high-water mark. */
    private addPadEntry(
        frame: RenderFrame, cmdIndex: number, slot: number, need: number, have: number, padBytes: number,
    ): number {
        const ref = this.planVbRef[slot]!;
        const src = ref >= 0 ? frame.bufferRefs[ref] : undefined;
        const srcOffset = this.planVbOffset[slot]!;
        // Only a COPY_SRC buffer can be read at all, and copyBufferToBuffer's source offset is
        // a 4-byte multiple. Anything else falls back to the whole-slot zero binding.
        const readable = src && (src.usage & GPUBufferUsage.COPY_SRC) !== 0 && (srcOffset & 3) === 0
            ? Math.min(have, src.size - srcOffset)
            : 0;
        const { size, copyBytes } = padRegion(need, readable);
        const canCopy = copyBytes > 0 && padBytes + size <= PAD_BUFFER_BUDGET;

        this.growPadPlan();
        const k = this.padCount++;
        this.padCmd[k] = cmdIndex;
        this.padSlot[k] = slot;
        this.padSrcRef[k] = ref;
        this.padSrcOffset[k] = srcOffset;
        this.padCopyBytes[k] = copyBytes;
        this.padSize[k] = size;
        if (!canCopy) {
            this.padDstOffset[k] = -1;
            return padBytes;
        }
        this.padDstOffset[k] = padBytes;
        return padBytes + size;
    }

    /** Grow-on-demand home for the padded copies. Never destroys the old buffer: command
     *  buffers already submitted still reference it. */
    private ensurePaddedBuffer(device: GPUDevice, bytes: number): void {
        if (bytes <= 0 || (this.paddedVb && this.paddedVbSize >= bytes)) return;
        const size = Math.max(bytes, this.paddedVbSize * 2, 256 * 1024);
        this.paddedVb = device.createBuffer({
            label: "d3d9-vertex-pad",
            size,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.paddedVbSize = size;
    }

    /** Bind the padded (or zero) stand-in for every slot this draw outran. Returns the plan
     *  index the draw's entries start at, for the restore afterwards. */
    private applyVertexPadding(
        renderPass: GPURenderPassEncoder, cmdIndex: number, device: GPUDevice,
    ): number {
        while (this.padCursor < this.padCount && this.padCmd[this.padCursor]! < cmdIndex) this.padCursor++;
        const start = this.padCursor;
        while (this.padCursor < this.padCount && this.padCmd[this.padCursor] === cmdIndex) {
            const k = this.padCursor++;
            const slot = this.padSlot[k]!;
            const size = this.padSize[k]!;
            const dst = this.padDstOffset[k]!;
            if (dst >= 0 && this.paddedVb) {
                renderPass.setVertexBuffer(slot, this.paddedVb, dst, size);
            } else {
                const zeros = zeroStreamBuffer(device, size);
                renderPass.setVertexBuffer(slot, zeros, 0, Math.min(zeros.size, size));
            }
        }
        return start;
    }

    /** Put the guest's own bindings back, so the next draw sees the state it recorded. */
    private restoreVertexPadding(renderPass: GPURenderPassEncoder, start: number): void {
        for (let k = start; k < this.padCursor; k++) {
            const slot = this.padSlot[k]!;
            const buffer = this.boundVbBuffer[slot];
            if (buffer) renderPass.setVertexBuffer(slot, buffer, this.boundVbOffset[slot], this.boundVbSize[slot]);
        }
    }

    // ── Programmable (VS/PS) path ─────────────────────────────────────────
    // Bind-group/pipeline layouts vary only by the cube-sampler mask (which stages are
    // viewDimension:"cube" vs "2d"); cached per mask (mask 0 = the common all-2D layout).
    private progLayouts: Map<string, { bindGroupLayout: GPUBindGroupLayout; pipelineLayout: GPUPipelineLayout }> = new Map();
    private vsArena: UniformArena | null = null;
    private psArena: UniformArena | null = null;
    private ffpArena: UniformArena | null = null;
    /** Worst shortfall a declined arena run reported. The live buffer is already referenced by
     *  encoded commands and cached bind groups, so growth can only take effect at the NEXT
     *  begin(); the floor stays sticky so the same frame shape does not decline twice. */
    private arenaVsGrowthReserve = 0;
    /** Scratch for the exact VS window a fused prefix overlays on the template. */
    private arenaPrefixRestore = new Uint32Array(0);

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
    private progCacheStageSamplers: (GPUSampler | null)[] = new Array(this.progCacheN * PROG_BIND.MAX_TEX).fill(null);
    private progCacheViews: (GPUTextureView | null)[] = new Array(this.progCacheN * PROG_BIND.MAX_TEX).fill(null);
    private progCacheVertexViews: (GPUTextureView | null)[] = new Array(this.progCacheN * VERTEX_TEXTURE_SAMPLER_COUNT).fill(null);
    private progCacheVertexSamplers: (GPUSampler | null)[] = new Array(this.progCacheN * VERTEX_TEXTURE_SAMPLER_COUNT).fill(null);
    private progCacheGroup: GPUBindGroup[] = [];
    // Per-slot cube mask: a bind group built for one layout (cube mask) is incompatible with a
    // pipeline using a different mask, so the mask is part of the cache identity.
    private progCacheCubeMask: number[] = [];
    private progCacheComparisonMask: number[] = [];
    private progCacheVolumeMask: number[] = [];
    private progCacheVertexVolumeMask: number[] = [];
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
    // Flat per-slot stage arrays: slot s occupies [s*FFP_MAX_STAGES, +FFP_MAX_STAGES).
    private ffpCacheSampler: (GPUSampler | null)[] = [];
    private ffpCacheView: (GPUTextureView | null)[] = [];
    private ffpCacheStages: number[] = [];
    private ffpCacheGroup: GPUBindGroup[] = [];
    private ffpCacheLen = 0;
    private ffpCacheCursor = 0;
    private ffpCacheBuffer: GPUBuffer | null = null;
    /** Reused single-element dynamic-offset scratch (avoids a per-draw array alloc). */
    private ffpDynOffsets: number[] = [0];

    // ── FFP per-draw path, "auto" (implicit per-pipeline layout) shape ─────
    // Without hasDynamicOffset the arena RANGE is baked into the bind group, so its identity is
    // (pipeline, offset, size, per-stage sampler+view). That is a per-draw identity, but it
    // RECURS: the arena rewinds every frame and the draw list is largely stable, so the same
    // draw lands at the same offset with the same textures frame after frame and the previous
    // frame's group is bindable as-is. A cached group names a buffer range, not a snapshot of
    // its bytes, so cross-frame reuse is correct exactly when this draw's block really is at
    // that offset — which the offset being part of the key is what guarantees.
    // Hash-indexed like the programmable cache: at a frame's worth of slots a linear scan is
    // what makes the lookup the new hot spot.
    private readonly ffpAutoCacheN = ((globalThis as Record<string, unknown>).__ffpAutoCacheN as number >>> 0) || FFP_AUTO_CACHE_N;
    private ffpAutoGroup: GPUBindGroup[] = [];
    private ffpAutoPipeline: number[] = [];
    private ffpAutoOffset: number[] = [];
    private ffpAutoSize: number[] = [];
    private ffpAutoStages: number[] = [];
    private ffpAutoSampler: (GPUSampler | null)[] = new Array(this.ffpAutoCacheN * FFP_MAX_STAGES).fill(null);
    private ffpAutoView: (GPUTextureView | null)[] = new Array(this.ffpAutoCacheN * FFP_MAX_STAGES).fill(null);
    private ffpAutoHash: number[] = [];
    private ffpAutoIndex = new Map<number, number[]>();
    private ffpAutoLen = 0;
    private ffpAutoCursor = 0;
    private ffpAutoBuffer: GPUBuffer | null = null;
    /** Reused descriptor + entry objects for the miss path: createBindGroup copies what it is
     *  given synchronously, so one long-lived set can serve every build. */
    private ffpAutoEntries: GPUBindGroupEntry[] = [];
    private ffpAutoEntryPool: { binding: number; resource: GPUBindingResource }[] = [];
    private ffpAutoBufferBinding: GPUBufferBinding = { buffer: undefined as unknown as GPUBuffer, offset: 0, size: 0 };
    private ffpAutoDesc: GPUBindGroupDescriptor = {
        layout: undefined as unknown as GPUBindGroupLayout,
        entries: this.ffpAutoEntries,
    };

    /**
     * Shared, explicit bind-group/pipeline layout for programmable pipelines, parameterised by
     * the cube-sampler mask. Fixed slots: vs-uniform, ps-uniform, sampler, MAX_TEX textures —
     * each texture slot is viewDimension:"cube" when its bit is set in cubeMask, else "2d".
     * The four extra W16 texture/sampler pairs are vertex-visible and map to
     * D3DVERTEXTEXTURESAMPLER0..3 (257..260).
     * Cached per mask (mask 0 is the common all-2D case).
     */
    getProgrammableLayout(
        cubeMask: number = 0,
        comparisonMask: number = 0,
        volumeMask: number = 0,
        vertexVolumeMask: number = 0,
        vsStorage = false,
    ): { bindGroupLayout: GPUBindGroupLayout; pipelineLayout: GPUPipelineLayout } {
        // Keep all four masks in a string key; bit-packing four 16-bit masks into a JS number
        // would lose precision and let a 3-D view reuse a 2-D bind-group layout.
        const layoutKey = `${vsStorage ? "mega:" : "uniform:"}${cubeMask & 0xffff}:${comparisonMask & 0xffff}:${volumeMask & 0xffff}:${vertexVolumeMask & 0xf}`;
        let layout = this.progLayouts.get(layoutKey);
        if (!layout) {
            const device = this.backend.getDevice()!;
            const entries: GPUBindGroupLayoutEntry[] = [
                { binding: PROG_BIND.VS_UNIFORM, visibility: GPUShaderStage.VERTEX, buffer: vsStorage
                    ? { type: "read-only-storage", hasDynamicOffset: false }
                    : { type: "uniform", hasDynamicOffset: true } },
                { binding: PROG_BIND.PS_UNIFORM, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
                { binding: PROG_BIND.SAMPLER, visibility: GPUShaderStage.FRAGMENT, sampler: { type: (comparisonMask & 1) !== 0 ? "comparison" : "filtering" } },
            ];
            for (let n = 0; n < PROG_BIND.MAX_TEX; n++) {
                entries.push({
                    binding: PROG_BIND.TEX_BASE + n,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: ((volumeMask >> n) & 1) !== 0
                        ? { sampleType: "float", viewDimension: "3d" }
                        : ((comparisonMask >> n) & 1) !== 0
                        ? { sampleType: "depth", viewDimension: "2d" }
                        : { sampleType: "float", viewDimension: ((cubeMask >> n) & 1) ? "cube" : "2d" },
                });
            }
            for (let n = 0; n < VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
                entries.push({
                    binding: VERTEX_TEXTURE_BASE + n,
                    visibility: GPUShaderStage.VERTEX,
                    texture: { sampleType: "float", viewDimension: ((vertexVolumeMask >> n) & 1) ? "3d" : "2d" },
                });
                entries.push({
                    binding: VERTEX_SAMPLER_BASE + n,
                    visibility: GPUShaderStage.VERTEX,
                    sampler: { type: "filtering" },
                });
            }
            // Used by programmable-VS + fixed-function-pixel (hybrid) shaders. Keeping these
            // in the shared layout makes their per-stage filter/address state bindable per draw.
            for (let n = 1; n < PROG_BIND.MAX_TEX; n++) {
                entries.push({ binding: PROG_BIND.FRAGMENT_SAMPLER_BASE + n - 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: ((comparisonMask >> n) & 1) !== 0 ? "comparison" : "filtering" } });
            }
            const bindGroupLayout = device.createBindGroupLayout({ entries });
            const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
            layout = { bindGroupLayout, pipelineLayout };
            this.progLayouts.set(layoutKey, layout);
        }
        return layout;
    }

    private ensureMegaVsBuffer(device: GPUDevice, slotBytes: number, slots: number): boolean {
        if (slotBytes <= 0 || slots <= 0 || (slotBytes & 15) !== 0) return false;
        let capacitySlots = 1;
        while (capacitySlots < slots && capacitySlots < 0x40000000) capacitySlots *= 2;
        const bytes = capacitySlots * slotBytes;
        const maxStorage = Number(device.limits.maxStorageBufferBindingSize);
        const maxBuffer = Number(device.limits.maxBufferSize);
        if (!Number.isSafeInteger(bytes) || bytes <= 0
            || bytes > maxStorage || bytes > maxBuffer) return false;
        if (this.megaVsBuffer && this.megaVsSlotBytes === slotBytes
            && this.megaVsCapacitySlots >= slots) return true;
        try { this.megaVsBuffer?.destroy(); } catch { /* device-loss cleanup is best effort */ }
        this.megaVsBuffer = device.createBuffer({
            size: Math.max(16, bytes),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.megaVsSlotBytes = slotBytes;
        this.megaVsCapacitySlots = capacitySlots;
        this.megaVsStagingBits = new Uint32Array(bytes >>> 2);
        this.megaBindGroups = new WeakMap();
        return true;
    }

    private acquireMegaProgBindGroup(
        ordinaryGroup: GPUBindGroup,
        pipelineId: number,
        ds: ProgrammableDrawState,
    ): GPUBindGroup | null {
        if (!this.megaVsBuffer || !this.psArena?.buffer) return null;
        let byPipeline = this.megaBindGroups.get(ordinaryGroup);
        const cached = byPipeline?.get(pipelineId);
        if (cached && cached.storage === this.megaVsBuffer && cached.ps === this.psArena.buffer) {
            this.metrics.bindGroupCacheHits++;
            return cached.group;
        }
        const device = this.backend.getDevice();
        if (!device) return null;
        const { bindGroupLayout } = this.getProgrammableLayout(
            ds.cubeMask, ds.comparisonMask, ds.volumeMask, ds.vertexVolumeMask, true,
        );
        const fallback2d = this.getFallbackTextureView();
        const fallbackCube = ds.cubeMask ? this.getFallbackCubeView() : fallback2d;
        const fallbackVolume = ds.volumeMask || ds.vertexVolumeMask
            ? this.getFallbackVolumeView() : fallback2d;
        const fallbackDepth = ds.comparisonMask ? this.getFallbackDepthView() : fallback2d;
        const sampler = ds.sampler ?? ((ds.comparisonMask & 1) !== 0
            ? this.getComparisonSampler() : this.getSampler());
        const ordinaryFallbackSampler = (ds.comparisonMask & 1) !== 0
            ? this.getSampler() : sampler;
        const entries: GPUBindGroupEntry[] = [
            { binding: PROG_BIND.VS_UNIFORM, resource: {
                buffer: this.megaVsBuffer, offset: 0,
                size: this.megaVsCapacitySlots * this.megaVsSlotBytes,
            } },
            { binding: PROG_BIND.PS_UNIFORM, resource: {
                buffer: this.psArena.buffer, offset: 0, size: PS_BIND_SIZE,
            } },
            { binding: PROG_BIND.SAMPLER, resource: sampler },
        ];
        for (let n = 0; n < PROG_BIND.MAX_TEX; n++) {
            const fallback = ((ds.volumeMask >> n) & 1) ? fallbackVolume
                : ((ds.comparisonMask >> n) & 1) ? fallbackDepth
                : ((ds.cubeMask >> n) & 1) ? fallbackCube : fallback2d;
            entries.push({ binding: PROG_BIND.TEX_BASE + n, resource: ds.textures[n] ?? fallback });
        }
        for (let n = 1; n < PROG_BIND.MAX_TEX; n++) {
            const fallback = ((ds.comparisonMask >> n) & 1)
                ? this.getComparisonSampler() : ordinaryFallbackSampler;
            entries.push({
                binding: PROG_BIND.FRAGMENT_SAMPLER_BASE + n - 1,
                resource: ds.samplers[n] ?? fallback,
            });
        }
        for (let n = 0; n < VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            entries.push({
                binding: VERTEX_TEXTURE_BASE + n,
                resource: ds.vertexTextures[n] ?? (((ds.vertexVolumeMask >> n) & 1)
                    ? fallbackVolume : fallback2d),
            });
            entries.push({
                binding: VERTEX_SAMPLER_BASE + n,
                resource: ds.vertexSamplers[n] ?? ordinaryFallbackSampler,
            });
        }
        const group = device.createBindGroup({ layout: bindGroupLayout, entries });
        this.metrics.bindGroupBuilds++;
        if (!byPipeline) {
            byPipeline = new Map();
            this.megaBindGroups.set(ordinaryGroup, byPipeline);
        }
        byPipeline.set(pipelineId, { storage: this.megaVsBuffer, ps: this.psArena.buffer, group });
        return group;
    }

    /** Find only the immediately preceding ordinary indexed draw whose complete fixed GPU
     * state still matches an arena run. Dynamic-state/query barriers invalidate the candidate;
     * programmable constants are checked bit-exactly later, after the run is decoded. */
    private findMegaBatchFusionCandidates(frame: RenderFrame): Map<number, MegaBatchFusionCandidate> {
        const result = new Map<number, MegaBatchFusionCandidate>();
        const vbRefs = new Int32Array(MAX_VB_SLOTS); vbRefs.fill(-1);
        const vbOffsets = new Int32Array(MAX_VB_SLOTS);
        const vbSizes = new Int32Array(MAX_VB_SLOTS);
        let pipelineId = -1;
        let bindStateIndex = -1;
        let bindCommand = -1;
        let ibRef = -1;
        let ibFormat = 0;
        let candidate: MegaBatchFusionCandidate | null = null;
        let lastDrawType = 0;

        for (let command = 0; command < frame.commandTypes.length; command++) {
            const type = frame.commandTypes[command];
            if (type === RenderCommandType.SetPipeline) {
                pipelineId = frame.commandA[command] | 0;
                bindCommand = -1;
                candidate = null;
            } else if (type === RenderCommandType.BindProgrammable) {
                bindStateIndex = frame.commandA[command] | 0;
                bindCommand = command;
            } else if (type === RenderCommandType.BindFfp) {
                bindStateIndex = -1;
                candidate = null;
            } else if (type === RenderCommandType.SetVertexBuffer) {
                const slot = frame.commandD[command] | 0;
                if (slot >= 0 && slot < MAX_VB_SLOTS) {
                    vbRefs[slot] = frame.commandA[command] | 0;
                    vbOffsets[slot] = frame.commandB[command] | 0;
                    vbSizes[slot] = frame.commandC[command] | 0;
                }
            } else if (type === RenderCommandType.SetIndexBuffer) {
                ibRef = frame.commandA[command] | 0;
                ibFormat = frame.commandB[command] | 0;
            } else if (type === RenderCommandType.DrawIndexed) {
                if (lastDrawType === RenderCommandType.DrawIndexedArenaRun) {
                    this.metrics.megaBatchFusionAdjacentAfter++;
                }
                candidate = {
                    drawCommand: command,
                    bindCommand,
                    bindStateIndex,
                    pipelineId,
                    indexCount: frame.commandA[command] | 0,
                    startIndex: frame.commandB[command] | 0,
                    baseVertex: frame.commandC[command] | 0,
                    instanceCount: frame.commandD[command] | 0,
                    vbRefs: vbRefs.slice(), vbOffsets: vbOffsets.slice(), vbSizes: vbSizes.slice(),
                    ibRef, ibFormat,
                };
                bindCommand = -1;
                lastDrawType = type;
            } else if (type === RenderCommandType.DrawIndexedArenaRun) {
                if (lastDrawType === RenderCommandType.DrawIndexed) {
                    this.metrics.megaBatchFusionAdjacentBefore++;
                }
                const runIndex = frame.commandA[command] >>> 0;
                const run = frame.arenaIndexedRuns[runIndex];
                if (!candidate && lastDrawType === RenderCommandType.DrawIndexed) {
                    this.metrics.megaBatchFusionRejectBarrier++;
                } else if (candidate && run && (candidate.pipelineId !== run.pipelineId
                    || candidate.bindStateIndex < 0 || candidate.instanceCount !== 1)) {
                    this.metrics.megaBatchFusionRejectPipeline++;
                } else if (candidate && run
                    && (candidate.ibFormat !== ibFormat
                        || candidate.ibRef < 0 || ibRef < 0
                        || frame.bufferRefs[candidate.ibRef] !== frame.bufferRefs[ibRef])) {
                    this.metrics.megaBatchFusionRejectIndex++;
                } else if (candidate && run) {
                    let resourcesMatch = true;
                    for (let slot = 0; slot < MAX_VB_SLOTS; slot++) {
                        const candidateRef = candidate.vbRefs[slot]!;
                        const currentRef = vbRefs[slot]!;
                        const sameBuffer = candidateRef === currentRef
                            || (candidateRef >= 0 && currentRef >= 0
                                && frame.bufferRefs[candidateRef] === frame.bufferRefs[currentRef]);
                        if (!sameBuffer
                            || candidate.vbOffsets[slot] !== vbOffsets[slot]
                            || candidate.vbSizes[slot] !== vbSizes[slot]) {
                            resourcesMatch = false;
                            break;
                        }
                    }
                    if (resourcesMatch) result.set(runIndex, candidate);
                    else this.metrics.megaBatchFusionRejectVertex++;
                }
                candidate = null;
                bindCommand = -1;
                lastDrawType = type;
            } else if (type === RenderCommandType.Draw
                || type === RenderCommandType.SetViewport || type === RenderCommandType.SetScissor
                || type === RenderCommandType.SetStencilReference || type === RenderCommandType.SetBlendConstant
                || type === RenderCommandType.BeginOcclusionQuery || type === RenderCommandType.EndOcclusionQuery
                || type === RenderCommandType.TimestampQuery) {
                candidate = null;
                if (type === RenderCommandType.Draw) {
                    bindCommand = -1;
                    lastDrawType = type;
                }
            }
        }
        return result;
    }

    /** Build complete, all-or-nothing plans before the render pass opens. The plan consumes
     * no RenderFrame rows: a rejected run remains available to the exact legacy loop. */
    private prepareMegaBatchRuns(
        frame: RenderFrame,
        device: GPUDevice,
        queue: GPUQueue,
    ): Map<number, MegaBatchRunPlan> {
        const prepareStarted = performance.now();
        const plans = new Map<number, MegaBatchRunPlan>();
        this.metrics.megaBatchPrepareCalls++;
        if (!this.megaBatchEnabled()) {
            this.metrics.megaBatchRejectDisabled++;
            return plans;
        }
        if (frame.arenaIndexedRuns.length === 0) {
            this.metrics.megaBatchRejectNoRuns++;
            return plans;
        }
        if (!this.vsArena || !this.psArena) {
            this.metrics.megaBatchRejectNoArenas++;
            return plans;
        }
        this.metrics.megaBatchCandidateRuns += frame.arenaIndexedRuns.length;
        const fusionStarted = performance.now();
        const fusionCandidates = this.megaBatchFusionEnabled()
            ? this.findMegaBatchFusionCandidates(frame)
            : new Map<number, MegaBatchFusionCandidate>();
        this.metrics.megaBatchFusionMs += performance.now() - fusionStarted;

        const sizingStarted = performance.now();
        let slotBytes = 0;
        let requestedSlots = 0;
        for (let runIndex = 0; runIndex < frame.arenaIndexedRuns.length; runIndex++) {
            const run = frame.arenaIndexedRuns[runIndex]!;
            const mega = this.pipelineInfo[run.pipelineId]?.megaBatch;
            if (!mega) {
                this.metrics.megaBatchRunsWithoutPipeline++;
                continue;
            }
            if (run.expectedPairCount < 2) continue;
            if (slotBytes === 0) slotBytes = mega.vsSlotBytes;
            if (mega.vsSlotBytes === slotBytes) {
                requestedSlots += run.expectedPairCount
                    + (run.prefixVsBits ? 1 : fusionCandidates.has(runIndex) ? 1 : 0);
            }
        }
        this.metrics.megaBatchSizingMs += performance.now() - sizingStarted;
        if (slotBytes === 0 || requestedSlots === 0
            || !this.ensureMegaVsBuffer(device, slotBytes, requestedSlots)) {
            if (requestedSlots > 0) this.metrics.megaBatchRejectLimits++;
            return plans;
        }

        const arenaCount = d3d9WasmArena.getCommandCount();
        const types = d3d9WasmArena.getCommandTypes();
        const a = d3d9WasmArena.getCommandA();
        const b = d3d9WasmArena.getCommandB();
        const c = d3d9WasmArena.getCommandC();
        const slotWords = slotBytes >>> 2;
        let usedSlots = 0;

        const planPackStarted = performance.now();
        for (let runIndex = 0; runIndex < frame.arenaIndexedRuns.length; runIndex++) {
            const run = frame.arenaIndexedRuns[runIndex]!;
            const info = this.pipelineInfo[run.pipelineId];
            const mega = info?.megaBatch;
            const template = frame.drawStates[run.bindStateIndex];
            let compact: ReturnType<typeof d3d9WasmArena.readCompactWbufRun> | null = null;
            if (this.compactMegaRunEnabled() && run.compactDescriptorOffset >= 0) {
                try {
                    compact = d3d9WasmArena.readCompactWbufRun(run.compactDescriptorOffset);
                } catch {
                    this.metrics.compactMegaRunDecodeFailures++;
                }
            }
            const legacyRowsValid = run.arenaCommandStart >= 0
                && run.arenaCommandEnd <= arenaCount
                && run.arenaCommandStart < run.arenaCommandEnd;
            if (!mega || mega.vsSlotBytes !== slotBytes || !template
                || template.vsLen < slotWords || run.expectedPairCount < 2
                || (!compact && !legacyRowsValid)) {
                if (mega) { this.metrics.megaBatchFallbacks++; this.metrics.megaBatchRejectShape++; }
                continue;
            }

            let capturedCount = 0;
            let stateOffset = -1;
            let indexCount = -1;
            let startIndex = -1;
            let baseVertex = 0;
            let rejected = false;
            if (compact) {
                const floatStart = compact.startRegister * 4;
                rejected = compact.pairCount !== run.expectedPairCount
                    || floatStart > slotWords
                    || compact.floatCount > slotWords - floatStart
                    || (compact.storageReady && compact.payloadStrideWords !== slotWords);
                if (!rejected) {
                    capturedCount = compact.pairCount;
                    indexCount = compact.indexCount;
                    startIndex = compact.startIndex;
                    baseVertex = compact.baseVertex;
                    this.metrics.compactMegaRunsPlanned++;
                }
            } else {
                try {
                    for (let row = run.arenaCommandStart; row < run.arenaCommandEnd; row++) {
                        const type = types[row];
                        if (type === ArenaCommandType.BindProgrammable) {
                            stateOffset = a[row]! >>> 0;
                            continue;
                        }
                        if (type !== ArenaCommandType.DrawIndexed) continue;
                        if (stateOffset < 0) { rejected = true; break; }
                        const drawA = a[row]! >>> 0;
                        const drawB = b[row]! >>> 0;
                        const drawC = c[row]! | 0;
                        if (indexCount < 0) {
                            indexCount = drawA; startIndex = drawB; baseVertex = drawC;
                        } else if (indexCount !== drawA || startIndex !== drawB || baseVertex !== drawC) {
                            rejected = true;
                            break;
                        }
                        if (capturedCount >= this.megaCapturedStateOffsets.length) {
                            rejected = true;
                            this.metrics.megaBatchRejectConstants++;
                            this.metrics.megaBatchRejectVsLength++;
                            break;
                        }
                        this.megaCapturedStateOffsets[capturedCount++] = stateOffset;
                    }
                } catch {
                    rejected = true;
                    this.metrics.megaBatchRejectShape++;
                }
            }
            let fusedCandidate = fusionCandidates.get(runIndex);
            if (run.prefixVsBits) fusedCandidate = undefined;
            let fusedState = fusedCandidate
                ? frame.drawStates[fusedCandidate.bindStateIndex]
                : undefined;
            if (fusedCandidate && (fusedCandidate.indexCount !== indexCount
                || fusedCandidate.startIndex !== startIndex
                || fusedCandidate.baseVertex !== baseVertex)) {
                fusedCandidate = undefined;
                fusedState = undefined;
            }
            if (fusedState && (fusedState.vsLen < slotWords || fusedState.psLen !== template.psLen)) {
                fusedCandidate = undefined;
                fusedState = undefined;
            }
            if (fusedState) {
                for (let word = 0; word < template.psLen; word++) {
                    if (fusedState.psBits[word] !== template.psBits[word]) {
                        fusedCandidate = undefined;
                        fusedState = undefined;
                        break;
                    }
                }
            }
            const prefixValid = !run.prefixVsBits
                || (run.prefixStartFloat >= 0
                    && run.prefixStartFloat <= slotWords
                    && run.prefixVsBits.length <= slotWords - run.prefixStartFloat);
            let totalInstances = capturedCount + (run.prefixVsBits ? 1 : fusedState ? 1 : 0);
            if (rejected || capturedCount !== run.expectedPairCount || indexCount <= 0
                || !prefixValid
                || validateD3D9RasterDrawCommand({
                    kind: "indexed", count: indexCount, start: startIndex,
                    baseVertex, instanceCount: totalInstances,
                }) !== null
                || usedSlots + totalInstances > this.megaVsCapacitySlots) {
                this.metrics.megaBatchFallbacks++;
                if (!rejected) this.metrics.megaBatchRejectShape++;
                continue;
            }

            // Resolve the exact material through the ordinary collision-safe cache, but do
            // not emit it. Its object identity keys the matching storage-VS bind group.
            const ordinary = this.prepareProgrammableBinding(template);
            if (fusedState) {
                const fusedOrdinary = this.prepareProgrammableBinding(fusedState);
                if (fusedOrdinary.bindGroup !== ordinary.bindGroup) {
                    fusedCandidate = undefined;
                    fusedState = undefined;
                    totalInstances--;
                }
            }
            const bindGroup = this.acquireMegaProgBindGroup(ordinary.bindGroup, run.pipelineId, template);
            if (!bindGroup) {
                this.metrics.megaBatchFallbacks++;
                this.metrics.megaBatchRejectLimits++;
                continue;
            }
            const firstSlot = usedSlots;
            if (run.prefixVsBits) {
                const slotBase = usedSlots * slotWords;
                this.megaVsStagingBits.set(template.vsBits.subarray(0, slotWords), slotBase);
                this.megaVsStagingBits.set(run.prefixVsBits, slotBase + run.prefixStartFloat);
            } else if (fusedState) {
                this.megaVsStagingBits.set(
                    fusedState.vsBits.subarray(0, slotWords), usedSlots * slotWords,
                );
            }
            let writeSlot = usedSlots + (run.prefixVsBits || fusedState ? 1 : 0);
            if (compact?.storageReady) {
                this.megaVsStagingBits.set(compact.payloadBits, writeSlot * slotWords);
                writeSlot += capturedCount;
            } else {
                for (let captured = 0; captured < capturedCount; captured++, writeSlot++) {
                    const slotBase = writeSlot * slotWords;
                    this.megaVsStagingBits.set(template.vsBits.subarray(0, slotWords), slotBase);
                    // A sparse WBUF pair owns only its changed VS float-register prefix.
                    if (compact) {
                        const source = captured * compact.floatCount;
                        this.megaVsStagingBits.set(
                            compact.payloadBits.subarray(source, source + compact.floatCount),
                            slotBase + compact.startRegister * 4,
                        );
                    } else if (d3d9WasmArena.copyDrawStateVsBits(
                        this.megaCapturedStateOffsets[captured]!,
                        this.megaVsStagingBits,
                        slotBase,
                        slotWords,
                    ) < 0) {
                        rejected = true;
                        this.metrics.megaBatchRejectConstants++;
                        this.metrics.megaBatchRejectVsLength++;
                        break;
                    }
                }
            }
            if (rejected) {
                this.metrics.megaBatchFallbacks++;
                continue;
            }
            usedSlots += totalInstances;
            plans.set(runIndex, {
                pipeline: mega.pipeline,
                bindGroup,
                psOffset: ordinary.psOffset,
                firstSlot,
                instanceCount: totalInstances,
                encodedPairCount: capturedCount,
                indexCount,
                startIndex,
                baseVertex,
                packedBytes: totalInstances * slotBytes,
                fusedDrawCommand: fusedCandidate?.drawCommand ?? -1,
                fusedBindCommand: fusedCandidate?.bindCommand ?? -1,
            });
        }
        this.metrics.megaBatchPlanPackMs += performance.now() - planPackStarted;

        if (usedSlots > 0 && this.megaVsBuffer) {
            const uploadStarted = performance.now();
            queue.writeBuffer(this.megaVsBuffer, 0, this.megaVsStagingBits, 0, usedSlots * slotWords);
            this.metrics.megaBatchUploadMs += performance.now() - uploadStarted;
        }
        this.metrics.megaBatchPrepareMs += performance.now() - prepareStarted;
        return plans;
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
            const entries: GPUBindGroupLayoutEntry[] = [
                // Read by both stages (vertex: transform/lighting; fragment: stage ops, fog, clip).
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
            ];
            // One (sampler, texture) pair per blend stage. Declared for ALL stages regardless of
            // how many a given shader uses — a pipeline layout may be a superset of the shader's
            // bindings, and one shared layout is what lets a single cached bind group serve every
            // FFP pipeline.
            for (let s = 0; s < FFP_MAX_STAGES; s++) {
                entries.push({ binding: 1 + s * 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } });
                entries.push({ binding: 2 + s * 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } });
            }
            const bindGroupLayout = device.createBindGroupLayout({ entries });
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
    private acquireFfpBindGroup(
        samplers: (GPUSampler | null)[],
        views: (GPUTextureView | null)[],
        stageCount: number,
        validStages: number,
        fallbackSampler: GPUSampler,
        fallbackView: GPUTextureView,
    ): GPUBindGroup {
        // `validStages` is how far the arrays were actually written this draw; entries past it
        // are stale (render-frame only clears slot 0). They are non-null, so the `?? fallback`
        // does NOT catch them — an earlier, deeper draw's sampler/view would be bound, and a
        // view can outlive its texture. The "auto" branch already honours this; both must.
        const live = (n: number) => n < validStages;
        // Compare only the stages this pipeline uses: the rest bind fallbacks, so two draws with
        // the same used stages share a group whatever stale values sit in the tail.
        for (let s = 0; s < this.ffpCacheLen; s++) {
            if (this.ffpCacheStages[s] !== stageCount) continue;
            const base = s * FFP_MAX_STAGES;
            let match = true;
            for (let n = 0; n < stageCount; n++) {
                if (this.ffpCacheSampler[base + n] !== ((live(n) ? samplers[n] : null) ?? fallbackSampler)
                    || this.ffpCacheView[base + n] !== ((live(n) ? views[n] : null) ?? fallbackView)) { match = false; break; }
            }
            if (match) {
                this.metrics.bindGroupCacheHits++;
                return this.ffpCacheGroup[s];
            }
        }
        const device = this.backend.getDevice()!;
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: this.ffpArena!.buffer!, offset: 0, size: FFP_BIND_SIZE } },
        ];
        for (let n = 0; n < FFP_MAX_STAGES; n++) {
            const inRange = n < stageCount && live(n);
            entries.push({ binding: 1 + n * 2, resource: (inRange ? samplers[n] : null) ?? fallbackSampler });
            entries.push({ binding: 2 + n * 2, resource: (inRange ? views[n] : null) ?? fallbackView });
        }
        const bindGroup = device.createBindGroup({ layout: this.getFfpLayout().bindGroupLayout, entries });
        this.metrics.bindGroupBuilds++;
        this.census.ffpSharedBuilds++;
        const slot = this.ffpCacheLen < FFP_CACHE_N
            ? this.ffpCacheLen++
            : (this.ffpCacheCursor = (this.ffpCacheCursor + 1) % FFP_CACHE_N);
        this.ffpCacheStages[slot] = stageCount;
        const base = slot * FFP_MAX_STAGES;
        for (let n = 0; n < stageCount; n++) {
            this.ffpCacheSampler[base + n] = (live(n) ? samplers[n] : null) ?? fallbackSampler;
            this.ffpCacheView[base + n] = (live(n) ? views[n] : null) ?? fallbackView;
        }
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
    getMetrics(): typeof this.metrics & {
        megaBatchRuntimeEnabled: number;
        megaBatchPipelinesLive: number;
        arenaRunCommands: number;
        arenaRunExpectedPairs: number;
        arenaRunExecutedPairs: number;
        arenaRunExpectedLogicalDraws: number;
        arenaRunEncodedLogicalDraws: number;
        arenaRunInvariantFailures: number;
        arenaRunDecodeFailures: number;
        arenaRunValidatorSkips: number;
        arenaRunCapacityFailures: number;
        arenaRunCapacityDeclines: number;
        arenaRunBudgetOverruns: number;
    } {
        return {
            ...this.metrics,
            megaBatchRuntimeEnabled: this.megaBatchEnabled() ? 1 : 0,
            megaBatchPipelinesLive: this.pipelineInfo.reduce(
                (count, info) => count + (info.megaBatch ? 1 : 0), 0,
            ),
            arenaRunCommands: this.arenaDrainStats.arenaRunCommands,
            arenaRunExpectedPairs: this.arenaDrainStats.arenaRunExpectedPairs,
            arenaRunExecutedPairs: this.arenaDrainStats.arenaRunExecutedPairs,
            arenaRunExpectedLogicalDraws: this.arenaDrainStats.arenaRunExpectedLogicalDraws,
            arenaRunEncodedLogicalDraws: this.arenaDrainStats.arenaRunEncodedLogicalDraws,
            arenaRunInvariantFailures: this.arenaDrainStats.arenaRunInvariantFailures,
            arenaRunDecodeFailures: this.arenaDrainStats.arenaRunDecodeFailures,
            arenaRunValidatorSkips: this.arenaDrainStats.arenaRunValidatorSkips,
            arenaRunCapacityFailures: this.arenaDrainStats.arenaRunCapacityFailures,
            arenaRunCapacityDeclines: this.arenaDrainStats.arenaRunCapacityDeclines,
            arenaRunBudgetOverruns: this.arenaDrainStats.arenaRunBudgetOverruns,
        };
    }

    /**
     * Reset performance metrics
     */
    resetMetrics(): void {
        this.metrics.pipelineSets = 0;
        this.metrics.bindGroupSets = 0;
        this.metrics.bindGroupSetSkips = 0;
        this.metrics.bindGroupCacheHits = 0;
        this.metrics.bindGroupBuilds = 0;
        this.metrics.drawCalls = 0;
        this.metrics.drawIndexedCalls = 0;
        this.metrics.renderBundleHits = 0;
        this.metrics.renderBundleMisses = 0;
        this.metrics.renderBundleBuilds = 0;
        this.metrics.renderBundleEvictions = 0;
        this.metrics.renderBundleExecutions = 0;
        this.metrics.renderBundleDraws = 0;
        this.metrics.renderBundleFailures = 0;
        this.metrics.renderBundleSignatureMismatches = 0;
        this.metrics.renderBundleFastHits = 0;
        this.metrics.renderBundleFastFallbacks = 0;
        this.metrics.renderBundleFastPlanBuilds = 0;
        this.metrics.renderBundleFastGuardMs = 0;
        this.metrics.renderBundleFastStageMs = 0;
        this.metrics.renderBundlePrepareMs = 0;
        this.metrics.renderBundleFastRejectNoPlan = 0;
        this.metrics.renderBundleFastRejectPlanShape = 0;
        this.metrics.renderBundleFastRejectAttachment = 0;
        this.metrics.renderBundleFastRejectCursor = 0;
        this.metrics.renderBundleFastRejectCacheEntry = 0;
        this.metrics.renderBundleFastRejectArenaMemory = 0;
        this.metrics.renderBundleFastRejectRawShape = 0;
        this.metrics.renderBundleFastRejectMaterial = 0;
        this.metrics.renderBundleFastRejectArenaLayout = 0;
        this.metrics.renderBundleFastRejectConstants = 0;
        this.metrics.renderBundleFastRejectConstantLength = 0;
        this.metrics.renderBundleFastRejectConstantVsOffset = 0;
        this.metrics.renderBundleFastRejectConstantPsOffset = 0;
        this.metrics.renderBundleFastRejectConstantEndCursor = 0;
        this.metrics.megaBatchPipelineBuilds = 0;
        this.metrics.megaBatchBatches = 0;
        this.metrics.megaBatchLogicalDraws = 0;
        this.metrics.megaBatchPhysicalDraws = 0;
        this.metrics.megaBatchPackedBytes = 0;
        this.metrics.megaBatchFallbacks = 0;
        this.metrics.megaBatchRejectShape = 0;
        this.metrics.megaBatchRejectLimits = 0;
        this.metrics.megaBatchRejectConstants = 0;
        this.metrics.megaBatchRejectVsLength = 0;
        this.metrics.megaBatchRejectPsLength = 0;
        this.metrics.megaBatchRejectPsValue = 0;
        this.metrics.megaBatchPrepareCalls = 0;
        this.metrics.megaBatchCandidateRuns = 0;
        this.metrics.megaBatchRunsWithoutPipeline = 0;
        this.metrics.megaBatchRejectDisabled = 0;
        this.metrics.megaBatchRejectNoRuns = 0;
        this.metrics.megaBatchRejectNoArenas = 0;
        this.metrics.megaBatchPrepareMs = 0;
        this.metrics.megaBatchFusionMs = 0;
        this.metrics.megaBatchSizingMs = 0;
        this.metrics.megaBatchPlanPackMs = 0;
        this.metrics.megaBatchUploadMs = 0;
        this.metrics.megaBatchNormalPipelineSkips = 0;
        this.metrics.megaBatchFusedOrdinaryDraws = 0;
        this.metrics.megaBatchFusionAdjacentBefore = 0;
        this.metrics.megaBatchFusionAdjacentAfter = 0;
        this.metrics.megaBatchFusionRejectBarrier = 0;
        this.metrics.megaBatchFusionRejectPipeline = 0;
        this.metrics.megaBatchFusionRejectIndex = 0;
        this.metrics.megaBatchFusionRejectVertex = 0;
        this.metrics.compactMegaRunsPlanned = 0;
        this.metrics.compactMegaRunFallbacks = 0;
        this.metrics.compactMegaRunDecodeFailures = 0;
        this.metrics.clearCalls = 0;
        this.metrics.progConstWrites = 0;
        this.metrics.progConstReuseHits = 0;
        this.resetArenaDrainStats();
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
        upUploadFailures: 0,
        arenaRunCommands: 0,
        arenaRunExpectedPairs: 0,
        arenaRunExecutedPairs: 0,
        arenaRunExpectedLogicalDraws: 0,
        arenaRunEncodedLogicalDraws: 0,
        arenaRunInvariantFailures: 0,
        arenaRunDecodeFailures: 0,
        arenaRunValidatorSkips: 0,
        arenaRunCapacityFailures: 0,
        arenaRunCapacityDeclines: 0,
        arenaRunBudgetOverruns: 0,
    };
    // Diagnostic bookkeeping for unlinked arena rows: compact pipelineKeys are buckets while
    // the executor's actual GPURenderPipeline objects remain indexed by the device-resolved
    // pipeline id.  Linked rows (frame.arenaDrawBindings) carry that id and are consumed by
    // execute() on the authoritative arena path; this map is only for optional diagnostics.
    /** Compact Rust keys are only buckets; retain the captured 16-word identity so a
     *  hash collision is visible to the verify drain instead of being reported as a hit. */
    private arenaSeenPipelineKeys = new Map<number, string>();
    private arenaRunInvariantLogs = 0;

    getArenaDrainStats(): typeof this.arenaDrainStats {
        return { ...this.arenaDrainStats };
    }

    resetArenaDrainStats(): void {
        this.arenaDrainStats = {
            setPipelineCount: 0, pipelineHits: 0, pipelineMisses: 0,
            bindProgrammableCount: 0, drawCount: 0, drawIndexedCount: 0,
            drawUPCount: 0, upUploadFailures: 0,
            arenaRunCommands: 0, arenaRunExpectedPairs: 0,
            arenaRunExecutedPairs: 0, arenaRunExpectedLogicalDraws: 0,
            arenaRunEncodedLogicalDraws: 0, arenaRunInvariantFailures: 0,
            arenaRunDecodeFailures: 0, arenaRunValidatorSkips: 0,
            arenaRunCapacityFailures: 0, arenaRunCapacityDeclines: 0,
            arenaRunBudgetOverruns: 0,
        };
        this.arenaSeenPipelineKeys.clear();
        this.arenaRunInvariantLogs = 0;
    }

    private renderBundleSignaturesEqual(a: RenderBundleSignature, b: RenderBundleSignature): boolean {
        if (a.device !== b.device || a.depthFormat !== b.depthFormat || a.sampleCount !== b.sampleCount
            || a.colorFormats.length !== b.colorFormats.length
            || a.dynamicState.length !== b.dynamicState.length
            || a.objects.length !== b.objects.length || a.words.length !== b.words.length) return false;
        for (let i = 0; i < a.colorFormats.length; i++) if (a.colorFormats[i] !== b.colorFormats[i]) return false;
        for (let i = 0; i < a.dynamicState.length; i++) {
            if (!Object.is(a.dynamicState[i], b.dynamicState[i])) return false;
        }
        for (let i = 0; i < a.objects.length; i++) if (a.objects[i] !== b.objects[i]) return false;
        for (let i = 0; i < a.words.length; i++) if (a.words[i] !== b.words[i]) return false;
        return true;
    }

    private renderBundleSignatureKey(signature: RenderBundleSignature): string {
        let hash = 0x811c9dc5;
        const mix = (word: number): void => {
            hash ^= word | 0;
            hash = Math.imul(hash, 0x01000193);
        };
        for (const format of signature.colorFormats) {
            const value = format ?? "-";
            for (let i = 0; i < value.length; i++) mix(value.charCodeAt(i));
        }
        for (let i = 0; i < signature.depthFormat.length; i++) mix(signature.depthFormat.charCodeAt(i));
        mix(signature.sampleCount);
        for (const value of signature.dynamicState) {
            // Dynamic state is exact-compared below; this coercion is only a lookup bucket.
            mix(Number.isInteger(value) ? value : Math.fround(value) * 0x100000);
        }
        for (const object of signature.objects) mix(this.gpuId(object));
        for (const word of signature.words) mix(word);
        return `${hash >>> 0}:${signature.objects.length}:${signature.words.length}`;
    }

    private getOrCreateRenderBundle(device: GPUDevice, segment: PreparedBundleSegment): GPURenderBundle {
        const cached = this.renderBundleCache.get(segment.cacheKey);
        if (cached && this.renderBundleSignaturesEqual(cached.signature, segment.signature)) {
            this.renderBundleCache.delete(segment.cacheKey);
            this.renderBundleCache.set(segment.cacheKey, cached);
            this.metrics.renderBundleHits++;
            return cached.bundle;
        }
        if (cached) {
            // A lookup hash is never an authority. A collision replaces the bucket only after
            // exact object/scalar comparison refused it.
            this.metrics.renderBundleSignatureMismatches++;
            this.renderBundleCache.delete(segment.cacheKey);
        }
        this.metrics.renderBundleMisses++;
        const encoder = device.createRenderBundleEncoder({
            colorFormats: segment.signature.colorFormats,
            depthStencilFormat: segment.signature.depthFormat,
            sampleCount: segment.signature.sampleCount,
        });
        for (const draw of segment.draws) {
            encoder.setPipeline(draw.pipeline);
            for (const vb of draw.vertexBindings) {
                encoder.setVertexBuffer(vb.slot, vb.buffer, vb.offset, vb.size);
            }
            encoder.setIndexBuffer(draw.indexBuffer, draw.indexFormat);
            encoder.setBindGroup(0, draw.bindGroup, [draw.vsOffset, draw.psOffset]);
            encoder.drawIndexed(draw.indexCount, 1, draw.startIndex, draw.baseVertex, 0);
        }
        const bundle = encoder.finish();
        this.metrics.renderBundleBuilds++;
        this.renderBundleCache.set(segment.cacheKey, { signature: segment.signature, bundle });
        const capacity = this.renderBundleCacheCapacity();
        while (this.renderBundleCache.size > capacity) {
            const oldest = this.renderBundleCache.keys().next().value;
            if (oldest === undefined) break;
            this.renderBundleCache.delete(oldest);
            this.metrics.renderBundleEvictions++;
        }
        return bundle;
    }

    private renderBundleFastLookupKey(frame: RenderFrame, candidate: BundleCandidate): string {
        const first = candidate.draws[0]!;
        const last = candidate.draws[candidate.draws.length - 1]!;
        const state = frame.drawStates[first.bindStateIndex];
        // A deliberately cheap bucket, never an authority. Including one material identity keeps
        // query-delimited passes with otherwise identical command counts from thrashing one slot.
        const samplerId = state?.sampler ? this.gpuId(state.sampler) : 0;
        const textureId = state?.textures[0] ? this.gpuId(state.textures[0]) : 0;
        return `${candidate.start}:${candidate.end}:${candidate.draws.length}:${candidate.logicalDraws}`
            + `:${first.pipelineId}:${last.pipelineId}:${this.gpuId(first.indexBuffer)}`
            + `:${samplerId}:${textureId}`;
    }

    private renderBundleMaterialProof(state: ProgrammableDrawState): RenderBundleMaterialProof {
        return {
            stageEpoch: state.stageEpoch,
            sampler: state.sampler,
            cubeMask: state.cubeMask,
            comparisonMask: state.comparisonMask,
            volumeMask: state.volumeMask,
            vertexVolumeMask: state.vertexVolumeMask,
            textures: state.textures.slice(),
            samplers: state.samplers.slice(),
            vertexTextures: state.vertexTextures.slice(),
            vertexSamplers: state.vertexSamplers.slice(),
        };
    }

    private renderBundleObjectArraysEqual(a: readonly (object | null)[], b: readonly (object | null)[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    /** stageEpoch is a collision-free device generation: equality means captureDrawState copied
     *  the same resolved object window. A new epoch takes the exact identity path once and then
     *  refreshes the proof for another O(1) hit in the same window. */
    private renderBundleMaterialMatches(proof: RenderBundleMaterialProof, state: ProgrammableDrawState): boolean {
        if (proof.cubeMask !== state.cubeMask || proof.comparisonMask !== state.comparisonMask
            || proof.volumeMask !== state.volumeMask || proof.vertexVolumeMask !== state.vertexVolumeMask) return false;
        if (proof.stageEpoch > 0 && proof.stageEpoch === state.stageEpoch) return true;
        if (proof.sampler !== state.sampler
            || !this.renderBundleObjectArraysEqual(proof.textures, state.textures)
            || !this.renderBundleObjectArraysEqual(proof.samplers, state.samplers)
            || !this.renderBundleObjectArraysEqual(proof.vertexTextures, state.vertexTextures)
            || !this.renderBundleObjectArraysEqual(proof.vertexSamplers, state.vertexSamplers)) return false;
        proof.stageEpoch = state.stageEpoch;
        return true;
    }

    private renderBundleVertexBindingsEqual(a: BundleVertexBinding[], b: BundleVertexBinding[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const x = a[i]!, y = b[i]!;
            if (x.slot !== y.slot || x.buffer !== y.buffer || x.offset !== y.offset || x.size !== y.size) return false;
        }
        return true;
    }

    private noteRenderBundleFastReject(reason: RenderBundleFastRejectReason): void {
        this.metrics.renderBundleFastFallbacks++;
        switch (reason) {
            case "noPlan": this.metrics.renderBundleFastRejectNoPlan++; break;
            case "planShape": this.metrics.renderBundleFastRejectPlanShape++; break;
            case "attachment": this.metrics.renderBundleFastRejectAttachment++; break;
            case "cursor": this.metrics.renderBundleFastRejectCursor++; break;
            case "cacheEntry": this.metrics.renderBundleFastRejectCacheEntry++; break;
            case "arenaMemory": this.metrics.renderBundleFastRejectArenaMemory++; break;
            case "rawShape": this.metrics.renderBundleFastRejectRawShape++; break;
            case "material": this.metrics.renderBundleFastRejectMaterial++; break;
            case "arenaLayout": this.metrics.renderBundleFastRejectArenaLayout++; break;
            case "constants": this.metrics.renderBundleFastRejectConstants++; break;
        }
    }

    private noteRenderBundleFastConstantReject(reason: RenderBundleFastConstantRejectReason): void {
        this.noteRenderBundleFastReject("constants");
        switch (reason) {
            case "length": this.metrics.renderBundleFastRejectConstantLength++; break;
            case "vsOffset": this.metrics.renderBundleFastRejectConstantVsOffset++; break;
            case "psOffset": this.metrics.renderBundleFastRejectConstantPsOffset++; break;
            case "endCursor": this.metrics.renderBundleFastRejectConstantEndCursor++; break;
        }
    }

    /**
     * Try the allocation-free steady-state path. The plan is addressed by a cheap bucket but
     * accepted only after exact attachment, GPU-object, scalar-command, WASM-memory and arena
     * cursor checks. Constants are then restaged through the ordinary versioned writers and
     * must land at the bundle's original offsets; otherwise the caller rebuilds structurally.
     */
    private tryRenderBundleFastHit(
        frame: RenderFrame,
        candidate: BundleCandidate,
        device: GPUDevice,
        colorFormats: Array<GPUTextureFormat | null>,
        depthFormat: GPUTextureFormat,
        sampleCount: number,
    ): { segment: PreparedBundleSegment; bundle: GPURenderBundle } | null {
        if (!this.renderBundleFastHitsEnabled() || !this.vsArena || !this.psArena) return null;
        const profile = this.renderBundleProfiling();
        const guardStart = profile ? performance.now() : 0;
        const lookupKey = this.renderBundleFastLookupKey(frame, candidate);
        const bucket = this.renderBundleFastPlans.get(lookupKey);
        const reject = (reason: RenderBundleFastRejectReason): null => {
            this.noteRenderBundleFastReject(reason);
            if (profile) this.metrics.renderBundleFastGuardMs += performance.now() - guardStart;
            return null;
        };
        if (!bucket || bucket.length === 0) return reject("noPlan");

        let types: Uint32Array, a: Uint32Array, b: Uint32Array, c: Uint32Array;
        let arenaCount: number;
        try {
            arenaCount = d3d9WasmArena.getCommandCount();
            types = d3d9WasmArena.getCommandTypes();
            a = d3d9WasmArena.getCommandA();
            b = d3d9WasmArena.getCommandB();
            c = d3d9WasmArena.getCommandC();
        } catch { return reject("arenaMemory"); }

        let plan: RenderBundleFastPlan | null = null;
        let liveEntry: RenderBundleCacheEntry | null = null;
        let rejected: RenderBundleFastRejectReason = "planShape";
        planSearch: for (const proposed of bucket) {
            if (proposed.lookupKey !== lookupKey || proposed.device !== device
                || proposed.startCommand !== candidate.start || proposed.endCommand !== candidate.end
                || proposed.logicalDraws !== candidate.logicalDraws
                || proposed.raws.length !== candidate.draws.length
                || proposed.draws.length !== proposed.segment.draws.length) {
                rejected = "planShape";
                continue;
            }
            if (proposed.colorFormats.length !== colorFormats.length || proposed.depthFormat !== depthFormat
                || proposed.sampleCount !== sampleCount
                || proposed.dynamicState.length !== candidate.dynamicState.length) {
                rejected = "attachment";
                continue;
            }
            for (let i = 0; i < colorFormats.length; i++) {
                if (proposed.colorFormats[i] !== colorFormats[i]) { rejected = "attachment"; continue planSearch; }
            }
            for (let i = 0; i < candidate.dynamicState.length; i++) {
                if (!Object.is(proposed.dynamicState[i], candidate.dynamicState[i])) {
                    rejected = "attachment";
                    continue planSearch;
                }
            }
            if (proposed.vsBuffer !== this.vsArena.buffer || proposed.psBuffer !== this.psArena.buffer
                || proposed.vsStart !== this.vsArena.position() || proposed.psStart !== this.psArena.position()) {
                rejected = "cursor";
                continue;
            }
            const entry = this.renderBundleCache.get(proposed.cacheKey);
            if (entry !== proposed.cacheEntry) { rejected = "cacheEntry"; continue; }
            if (types.buffer !== proposed.arenaMemory || types.byteLength === 0) {
                rejected = "arenaMemory";
                continue;
            }

            let logical = 0;
            for (let rawIndex = 0; rawIndex < candidate.draws.length; rawIndex++) {
                const raw = candidate.draws[rawIndex]!;
                const expected = proposed.raws[rawIndex]!;
                const state = frame.drawStates[raw.bindStateIndex];
                // bindStateIndex is a frame-local pool slot, not bundle identity. The sequence's
                // exact material proof below is authoritative even if capture pooling shifted it.
                if (!state || raw.command !== expected.command || raw.pipelineId !== expected.pipelineId
                    || this.pipelines[raw.pipelineId] !== expected.pipeline
                    || raw.indexBuffer !== expected.indexBuffer || raw.indexFormat !== expected.indexFormat
                    || !this.renderBundleVertexBindingsEqual(raw.vertexBindings, expected.vertexBindings)) {
                    rejected = "rawShape";
                    continue planSearch;
                }
                if (!this.renderBundleMaterialMatches(expected.material, state)) {
                    rejected = "material";
                    continue planSearch;
                }
                if (!raw.run) {
                    const draw = proposed.segment.draws[logical++];
                    if (expected.expectedPairCount !== 0 || !draw
                        || raw.indexCount !== expected.indexCount || raw.startIndex !== expected.startIndex
                        || raw.baseVertex !== expected.baseVertex || raw.indexCount !== draw.indexCount
                        || raw.startIndex !== draw.startIndex || raw.baseVertex !== draw.baseVertex) {
                        rejected = "rawShape";
                        continue planSearch;
                    }
                    continue;
                }
                if (raw.run.expectedPairCount !== expected.expectedPairCount
                    || raw.run.arenaCommandStart < 0 || raw.run.arenaCommandEnd > arenaCount
                    || raw.run.arenaCommandStart >= raw.run.arenaCommandEnd) {
                    rejected = "arenaLayout";
                    continue planSearch;
                }
                let stateOffset = -1;
                let runRow = 0;
                for (let row = raw.run.arenaCommandStart; row < raw.run.arenaCommandEnd; row++) {
                    if (types[row] === ArenaCommandType.BindProgrammable) {
                        stateOffset = a[row] >>> 0;
                        continue;
                    }
                    if (types[row] !== ArenaCommandType.DrawIndexed || stateOffset < 0) continue;
                    const draw = proposed.segment.draws[logical++];
                    if (!draw || runRow >= expected.expectedPairCount
                        // Absolute command-row numbers are recorder-local; state offset + exact
                        // arguments are what name the live capture and encoded draw.
                        || stateOffset !== expected.arenaStateOffsets[runRow]
                        || expected.capturedVs[runRow]?.buffer !== proposed.arenaMemory
                        || expected.capturedVs[runRow]?.byteLength === 0
                        || (a[row] >>> 0) !== draw.indexCount || (b[row] >>> 0) !== draw.startIndex
                        || (c[row] | 0) !== draw.baseVertex) {
                        rejected = "arenaLayout";
                        continue planSearch;
                    }
                    runRow++;
                }
                if (runRow !== expected.expectedPairCount) {
                    rejected = "arenaLayout";
                    continue planSearch;
                }
            }
            if (logical !== proposed.draws.length || logical !== proposed.segment.draws.length) {
                rejected = "rawShape";
                continue;
            }
            plan = proposed;
            liveEntry = entry;
            break;
        }
        if (!plan || !liveEntry) return reject(rejected);
        if (profile) this.metrics.renderBundleFastGuardMs += performance.now() - guardStart;

        const stageStart = profile ? performance.now() : 0;
        const stageFail = (reason: RenderBundleFastConstantRejectReason): null => {
            // Structural proof passed but the frame-local constant dedupe schedule changed.
            // Rewind speculative bytes and rebuild through the exact path. Dropping the tiny
            // memo is conservative: earlier encoded draws retain their offsets and later draws
            // merely upload duplicate blocks instead of observing stale aliases.
            this.vsArena!.rewindTo(plan.vsStart);
            this.psArena!.rewindTo(plan.psStart);
            this.resetProgConstOffsetCache();
            const at = bucket.indexOf(plan);
            if (at >= 0) { bucket.splice(at, 1); this.renderBundleFastPlanCount--; }
            if (bucket.length === 0) this.renderBundleFastPlans.delete(lookupKey);
            this.noteRenderBundleFastConstantReject(reason);
            if (profile) this.metrics.renderBundleFastStageMs += performance.now() - stageStart;
            return null;
        };
        for (let drawIndex = 0; drawIndex < plan.draws.length; drawIndex++) {
            const drawPlan = plan.draws[drawIndex]!;
            const raw = candidate.draws[drawPlan.rawIndex]!;
            const state = frame.drawStates[raw.bindStateIndex]!;
            const draw = plan.segment.draws[drawIndex]!;
            if (state.vsLen !== drawPlan.vsLen || state.psLen !== drawPlan.psLen) return stageFail("length");
            if (drawPlan.runRow >= 0) {
                const captured = plan.raws[drawPlan.rawIndex]!.capturedVs[drawPlan.runRow]!;
                const prefix = Math.min(state.vsLen, captured.length);
                if (prefix === captured.length) state.vsConst.set(captured, 0);
                else state.vsConst.set(captured.subarray(0, prefix), 0);
                state.vsVersion = undefined;
            }
            const vsOffset = this.writeProgrammableConstants(
                this.vsArena, state.vsConst, state.vsLen, state.vsVersion, true,
            );
            const psOffset = this.writeProgrammableConstants(
                this.psArena, state.psConst, state.psLen, state.psVersion, false,
            );
            if (vsOffset !== draw.vsOffset) return stageFail("vsOffset");
            if (psOffset !== draw.psOffset) return stageFail("psOffset");
        }
        if (this.vsArena.position() !== plan.vsEnd || this.psArena.position() !== plan.psEnd) {
            return stageFail("endCursor");
        }
        if (profile) this.metrics.renderBundleFastStageMs += performance.now() - stageStart;

        // Refresh LRU only after every guard and offset invariant succeeded.
        this.renderBundleCache.delete(plan.cacheKey);
        this.renderBundleCache.set(plan.cacheKey, liveEntry);
        const at = bucket.indexOf(plan);
        if (at >= 0 && at !== bucket.length - 1) {
            bucket.splice(at, 1);
            bucket.push(plan);
        }
        this.renderBundleFastPlans.delete(lookupKey);
        this.renderBundleFastPlans.set(lookupKey, bucket);
        this.metrics.renderBundleHits++;
        this.metrics.renderBundleFastHits++;
        return { segment: plan.segment, bundle: liveEntry.bundle };
    }

    /**
     * Turn maximal indexed programmable clusters into self-contained bundle plans. Query and
     * dynamic render-pass commands terminate a cluster and remain in the ordinary command loop.
     * Both the single legacy draw that starts a material block and its following arena pair-run
     * are accepted, so a cluster spans material blocks instead of one pair-run each.
     */
    private prepareRenderBundleSegments(
        frame: RenderFrame,
        device: GPUDevice,
        colorFormats: Array<GPUTextureFormat | null>,
        depthFormat: GPUTextureFormat,
        sampleCount: number,
        fusedDrawSkips: ReadonlySet<number>,
    ): Map<number, { segment: PreparedBundleSegment; bundle: GPURenderBundle }> {
        const out = new Map<number, { segment: PreparedBundleSegment; bundle: GPURenderBundle }>();
        if (!this.renderBundlesEnabled() || frame.arenaIndexedRuns.length === 0
            || !this.vsArena || !this.psArena) return out;
        const profile = this.renderBundleProfiling();
        const prepareStart = profile ? performance.now() : 0;

        const vbBuffer: Array<GPUBuffer | null> = new Array(MAX_VB_SLOTS).fill(null);
        const vbOffset = new Float64Array(MAX_VB_SLOTS);
        const vbSize = new Float64Array(MAX_VB_SLOTS);
        let indexBuffer: GPUBuffer | null = null;
        let indexFormat: GPUIndexFormat = "uint16";
        let pipelineId = -1;
        let bindStateIndex = -1;
        const dynamicState = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
        let candidate: BundleCandidate | null = null;
        const candidates: BundleCandidate[] = [];
        const closeCandidate = (): void => {
            if (candidate && candidate.logicalDraws >= this.renderBundleMinDraws()) candidates.push(candidate);
            candidate = null;
        };
        const activeVertexBindings = (id: number): BundleVertexBinding[] | null => {
            const info = this.pipelineInfo[id];
            if (!info?.programmable) return null;
            const bindings: BundleVertexBinding[] = [];
            for (let slot = 0; slot < info.strides.length; slot++) {
                if ((info.strides[slot] ?? 0) <= 0) continue;
                const buffer = vbBuffer[slot];
                if (!buffer || vbSize[slot] <= 0) return null;
                bindings.push({ slot, buffer, offset: vbOffset[slot], size: vbSize[slot] });
            }
            return bindings.length > 0 ? bindings : null;
        };
        const append = (raw: BundleRawDraw, logicalDraws: number): void => {
            if (!candidate) {
                candidate = {
                    start: raw.command, end: raw.command,
                    dynamicState: [...dynamicState], draws: [], logicalDraws: 0,
                };
            }
            candidate.end = raw.command;
            candidate.draws.push(raw);
            candidate.logicalDraws += logicalDraws;
        };

        for (let i = 0; i < frame.commandTypes.length; i++) {
            const type = frame.commandTypes[i];
            if (type === RenderCommandType.SetPipeline) {
                pipelineId = frame.commandA[i] | 0;
                continue;
            }
            if (type === RenderCommandType.BindProgrammable) {
                bindStateIndex = frame.commandA[i] | 0;
                continue;
            }
            if (type === RenderCommandType.SetVertexBuffer) {
                const slot = frame.commandD[i] | 0;
                if (slot >= 0 && slot < MAX_VB_SLOTS) {
                    vbBuffer[slot] = frame.bufferRefs[frame.commandA[i] >>> 0] ?? null;
                    vbOffset[slot] = frame.commandB[i] ?? 0;
                    vbSize[slot] = frame.commandC[i] ?? 0;
                }
                continue;
            }
            if (type === RenderCommandType.SetIndexBuffer) {
                indexBuffer = frame.bufferRefs[frame.commandA[i] >>> 0] ?? null;
                indexFormat = frame.commandB[i] === 16 ? "uint16" : "uint32";
                continue;
            }
            if (type === RenderCommandType.DrawIndexed) {
                // A draw fused into the following MegaBatch run is issued there as instance
                // zero; a bundle that also carried it would draw it twice.
                if (fusedDrawSkips.has(i)) {
                    closeCandidate();
                    continue;
                }
                const bindings = activeVertexBindings(pipelineId);
                const ds = frame.drawStates[bindStateIndex];
                const indexCount = frame.commandA[i] >>> 0;
                const startIndex = frame.commandB[i] >>> 0;
                const baseVertex = frame.commandC[i] | 0;
                if (!bindings || !ds || !indexBuffer || (frame.commandD[i] ?? 1) !== 1
                    || validateD3D9RasterDrawCommand({ kind: "indexed", count: indexCount,
                        start: startIndex, baseVertex, instanceCount: 1 }) !== null) {
                    closeCandidate();
                    continue;
                }
                append({ command: i, pipelineId, bindStateIndex, vertexBindings: bindings,
                    indexBuffer, indexFormat, indexCount, startIndex, baseVertex }, 1);
                continue;
            }
            if (type === RenderCommandType.DrawIndexedArenaRun) {
                const run = frame.arenaIndexedRuns[frame.commandA[i] >>> 0];
                const bindings = run ? activeVertexBindings(run.pipelineId) : null;
                if (!run || !bindings || !indexBuffer || pipelineId !== run.pipelineId
                    || !frame.drawStates[run.bindStateIndex] || run.expectedPairCount <= 0
                    // Bundle staging only decodes legacy arena rows. Compact descriptors and
                    // prefix draws stay on the exact executor/MegaBatch paths until the bundle
                    // ABI can represent both without silently reducing logical work.
                    || run.compactDescriptorOffset >= 0 || !!run.prefixVsBits) {
                    closeCandidate();
                    continue;
                }
                bindStateIndex = run.bindStateIndex;
                append({ command: i, pipelineId: run.pipelineId, bindStateIndex: run.bindStateIndex,
                    vertexBindings: bindings, indexBuffer, indexFormat, run }, run.expectedPairCount);
                continue;
            }

            // Dynamic/query/UP/non-indexed/FFP commands remain outside bundles. Snapshot their
            // values so a later cluster's exact signature also names its external pass state.
            closeCandidate();
            if (type === RenderCommandType.SetViewport) {
                const base = frame.commandA[i] >>> 0;
                for (let word = 0; word < 6; word++) dynamicState[word] = frame.viewportData[base + word] ?? 0;
            } else if (type === RenderCommandType.SetScissor) {
                dynamicState[6] = frame.commandA[i] | 0;
                dynamicState[7] = frame.commandB[i] | 0;
                dynamicState[8] = frame.commandC[i] | 0;
                dynamicState[9] = frame.commandD[i] | 0;
            } else if (type === RenderCommandType.SetStencilReference) {
                dynamicState[10] = frame.commandA[i] & 0xff;
            } else if (type === RenderCommandType.SetBlendConstant) {
                dynamicState[11] = frame.commandA[i] >>> 0;
            }
        }
        closeCandidate();

        for (const rawSegment of candidates) {
            const fast = this.tryRenderBundleFastHit(
                frame, rawSegment, device, colorFormats, depthFormat, sampleCount,
            );
            if (fast) {
                out.set(fast.segment.startCommand, fast);
                continue;
            }
            const vsStart = this.vsArena.position();
            const psStart = this.psArena.position();
            const decodedRuns = new Map<BundleRawDraw, Array<{
                captured: ReturnType<typeof d3d9WasmArena.readDrawState>;
                arenaRow: number; stateOffset: number;
                indexCount: number; startIndex: number; baseVertex: number;
            }>>();
            let valid = true;
            for (const raw of rawSegment.draws) {
                if (!raw.run) continue;
                const rows: Array<{ captured: ReturnType<typeof d3d9WasmArena.readDrawState>;
                    arenaRow: number; stateOffset: number;
                    indexCount: number; startIndex: number; baseVertex: number }> = [];
                let stateOffset = -1;
                try {
                    const count = d3d9WasmArena.getCommandCount();
                    if (raw.run.arenaCommandStart < 0 || raw.run.arenaCommandEnd > count
                        || raw.run.arenaCommandStart >= raw.run.arenaCommandEnd) { valid = false; break; }
                    const types = d3d9WasmArena.getCommandTypes();
                    const a = d3d9WasmArena.getCommandA();
                    const b = d3d9WasmArena.getCommandB();
                    const c = d3d9WasmArena.getCommandC();
                    for (let row = raw.run.arenaCommandStart; row < raw.run.arenaCommandEnd; row++) {
                        if (types[row] === ArenaCommandType.BindProgrammable) {
                            stateOffset = a[row] >>> 0;
                            continue;
                        }
                        if (types[row] !== ArenaCommandType.DrawIndexed || stateOffset < 0) continue;
                        const indexCount = a[row] >>> 0;
                        const startIndex = b[row] >>> 0;
                        const baseVertex = c[row] | 0;
                        if (validateD3D9RasterDrawCommand({ kind: "indexed", count: indexCount,
                            start: startIndex, baseVertex, instanceCount: 1 }) !== null) { valid = false; break; }
                        rows.push({ captured: d3d9WasmArena.readDrawState(stateOffset), arenaRow: row, stateOffset,
                            indexCount, startIndex, baseVertex });
                    }
                } catch { valid = false; }
                if (!valid || rows.length !== raw.run.expectedPairCount) { valid = false; break; }
                decodedRuns.set(raw, rows);
            }
            if (!valid) {
                this.metrics.renderBundleFailures++;
                continue;
            }

            const draws: PreparedBundleDraw[] = [];
            const drawPlans: RenderBundleFastDrawPlan[] = [];
            let arenaRuns = 0;
            let arenaExpectedPairs = 0;
            let arenaEncodedPairs = 0;
            for (let rawIndex = 0; rawIndex < rawSegment.draws.length; rawIndex++) {
                const raw = rawSegment.draws[rawIndex]!;
                const pipeline = this.pipelines[raw.pipelineId];
                const template = frame.drawStates[raw.bindStateIndex];
                if (!pipeline || !template) { valid = false; break; }
                if (!raw.run) {
                    const binding = this.prepareProgrammableBinding(template);
                    draws.push({ pipelineId: raw.pipelineId, pipeline, ...binding,
                        vertexBindings: raw.vertexBindings, indexBuffer: raw.indexBuffer,
                        indexFormat: raw.indexFormat, indexCount: raw.indexCount!,
                        startIndex: raw.startIndex!, baseVertex: raw.baseVertex! });
                    drawPlans.push({ rawIndex, runRow: -1, vsLen: template.vsLen, psLen: template.psLen });
                    continue;
                }
                arenaRuns++;
                const rows = decodedRuns.get(raw)!;
                arenaExpectedPairs += raw.run.expectedPairCount;
                for (let runRow = 0; runRow < rows.length; runRow++) {
                    const row = rows[runRow]!;
                    const prefix = Math.min(template.vsLen, row.captured.vsConstants.length);
                    template.vsConst.set(row.captured.vsConstants.subarray(0, prefix), 0);
                    template.vsVersion = undefined;
                    const binding = this.prepareProgrammableBinding(template);
                    draws.push({ pipelineId: raw.pipelineId, pipeline, ...binding,
                        vertexBindings: raw.vertexBindings, indexBuffer: raw.indexBuffer,
                        indexFormat: raw.indexFormat, indexCount: row.indexCount,
                        startIndex: row.startIndex, baseVertex: row.baseVertex });
                    arenaEncodedPairs++;
                    drawPlans.push({ rawIndex, runRow, vsLen: template.vsLen, psLen: template.psLen });
                }
            }
            if (!valid || draws.length !== rawSegment.logicalDraws) {
                this.metrics.renderBundleFailures++;
                (globalThis as { __d3d9RenderBundles?: boolean }).__d3d9RenderBundles = false;
                throw new Error("D3D9 render-bundle staging invariant failed");
            }

            const objects: object[] = [];
            const words: number[] = [];
            for (const draw of draws) {
                objects.push(draw.pipeline, draw.bindGroup, draw.indexBuffer);
                words.push(draw.pipelineId, draw.vsOffset, draw.psOffset,
                    draw.indexFormat === "uint32" ? 32 : 16,
                    draw.indexCount, draw.startIndex, draw.baseVertex, draw.vertexBindings.length);
                for (const vb of draw.vertexBindings) {
                    objects.push(vb.buffer);
                    words.push(vb.slot, vb.offset, vb.size);
                }
            }
            const signature: RenderBundleSignature = {
                device, colorFormats: [...colorFormats], depthFormat, sampleCount,
                dynamicState: rawSegment.dynamicState, objects, words,
            };
            const segment: PreparedBundleSegment = {
                startCommand: rawSegment.start, endCommand: rawSegment.end,
                draws, arenaRuns, arenaExpectedPairs, arenaEncodedPairs, signature,
                cacheKey: this.renderBundleSignatureKey(signature),
            };
            const bundle = this.getOrCreateRenderBundle(device, segment);
            out.set(segment.startCommand, { segment, bundle });

            if (this.renderBundleFastHitsEnabled()) {
                const cacheEntry = this.renderBundleCache.get(segment.cacheKey);
                if (cacheEntry) {
                    const lookupKey = this.renderBundleFastLookupKey(frame, rawSegment);
                    const raws: RenderBundleFastRawPlan[] = rawSegment.draws.map(raw => {
                        const rows = raw.run ? decodedRuns.get(raw)! : [];
                        return {
                            command: raw.command,
                            pipelineId: raw.pipelineId,
                            bindStateIndex: raw.bindStateIndex,
                            pipeline: this.pipelines[raw.pipelineId]!,
                            material: this.renderBundleMaterialProof(frame.drawStates[raw.bindStateIndex]!),
                            vertexBindings: raw.vertexBindings.map(v => ({ ...v })),
                            indexBuffer: raw.indexBuffer,
                            indexFormat: raw.indexFormat,
                            indexCount: raw.indexCount,
                            startIndex: raw.startIndex,
                            baseVertex: raw.baseVertex,
                            expectedPairCount: raw.run?.expectedPairCount ?? 0,
                            arenaRows: rows.map(row => row.arenaRow),
                            arenaStateOffsets: rows.map(row => row.stateOffset),
                            capturedVs: rows.map(row => row.captured.vsConstants),
                        };
                    });
                    const arenaMemory = d3d9WasmArena.getCommandTypes().buffer;
                    const plan: RenderBundleFastPlan = {
                        lookupKey,
                        cacheKey: segment.cacheKey,
                        cacheEntry,
                        device,
                        colorFormats: [...colorFormats],
                        depthFormat,
                        sampleCount,
                        dynamicState: [...rawSegment.dynamicState],
                        startCommand: segment.startCommand,
                        endCommand: segment.endCommand,
                        logicalDraws: rawSegment.logicalDraws,
                        vsBuffer: this.vsArena.buffer!,
                        psBuffer: this.psArena.buffer!,
                        vsStart,
                        psStart,
                        vsEnd: this.vsArena.position(),
                        psEnd: this.psArena.position(),
                        arenaMemory,
                        raws,
                        draws: drawPlans,
                        segment,
                    };
                    let bucket = this.renderBundleFastPlans.get(lookupKey);
                    if (!bucket) bucket = [];
                    const sameEntry = bucket.findIndex(previous => previous.cacheEntry === cacheEntry);
                    if (sameEntry >= 0) bucket[sameEntry] = plan;
                    else { bucket.push(plan); this.renderBundleFastPlanCount++; }
                    this.renderBundleFastPlans.delete(lookupKey);
                    this.renderBundleFastPlans.set(lookupKey, bucket);
                    const capacity = this.renderBundleCacheCapacity();
                    while (this.renderBundleFastPlanCount > capacity) {
                        const oldestKey = this.renderBundleFastPlans.keys().next().value;
                        if (oldestKey === undefined) break;
                        const oldestBucket = this.renderBundleFastPlans.get(oldestKey)!;
                        oldestBucket.shift();
                        this.renderBundleFastPlanCount--;
                        if (oldestBucket.length === 0) this.renderBundleFastPlans.delete(oldestKey);
                    }
                    this.metrics.renderBundleFastPlanBuilds++;
                }
            }
        }
        if (profile) this.metrics.renderBundlePrepareMs += performance.now() - prepareStart;
        return out;
    }

    /**
     * Verify-only drain of unlinked WASM-arena rows.  The normal authoritative path is in
     * execute(): it uses frame.arenaDrawBindings to select the already-built pipeline and
     * bind state.  This diagnostic walk intentionally remains side-effect-free and is useful
     * for checking raw SoA integrity without submitting a second set of draws.
     *
     * NOTE: readDrawState() is not used to reconstruct resources.  The linked path deliberately
     * uses RenderFrame's generation-safe ProgrammableDrawState and pipeline id, so missing
     * shader handles or texture generations in the compact snapshot cannot alias a live GPU
     * object.
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
                    const state = d3d9WasmArena.readDrawState(b[i]!);
                    const fingerprint = Array.from(state.pipelineIdentity, word => word.toString(16).padStart(8, "0")).join("");
                    const previous = this.arenaSeenPipelineKeys.get(pipelineKey);
                    if (previous === undefined) {
                        if (this.arenaSeenPipelineKeys.size >= ARENA_SEEN_PIPELINE_KEYS_MAX) {
                            const oldest = this.arenaSeenPipelineKeys.keys().next().value;
                            if (oldest !== undefined) this.arenaSeenPipelineKeys.delete(oldest);
                        }
                        this.arenaSeenPipelineKeys.set(pipelineKey, fingerprint);
                        this.arenaDrainStats.pipelineMisses++;
                    } else if (previous === fingerprint) {
                        this.arenaDrainStats.pipelineHits++;
                    } else {
                        // Compact-hash collision or an ABI/state capture mismatch. Keep
                        // this diagnostic-only; the legacy recorder remains authoritative.
                        this.arenaDrainStats.pipelineMisses++;
                        d3d9WasmArena.incrementMismatchCount();
                        this.arenaSeenPipelineKeys.set(pipelineKey, fingerprint);
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
            /** Sparse attachment list: null preserves a D3D9-disabled MRT slot. */
            colorViews: Array<GPUTextureView | null>;
            /** Exact sparse format layout used by pipelines and render bundles. */
            colorFormats?: Array<GPUTextureFormat | null>;
            depthView?: GPUTextureView;
            /** When set, used directly (shared FFP depth with stencil load/clear semantics). */
            depthStencil?: GPURenderPassDepthStencilAttachment;
            /** Color attachment is still the swap-chain offscreen; only depth is overridden. */
            backbuffer?: boolean;
            /** Format of the depth attachment; used to avoid supplying stencil ops to a
             * depth-only WebGPU view. */
            depthFormat?: GPUTextureFormat;
            stencilReference?: number;
            /** Optional adapter-probed MSAA target. When present it owns color/depth views and
             * WebGPU resolves color into its single-sample target at pass end. */
            multisample?: D3D9MultisampleTarget;
            /** Optional standalone D3D9 depth surface for the implicit MSAA backbuffer. */
            multisampleDepth?: { texture: GPUTexture; view: GPUTextureView };
            /** Use an sRGB view of the offscreen attachment for D3DRS_SRGBWRITEENABLE. */
            srgbWrite?: boolean;
        } | null,
        /** DISCARD swap chains expose undefined backbuffer contents after Present. */
        discardBackbufferAfterPresent = false,
        /** Optional WebGPU query manager. Query commands are ignored when unavailable. */
        queryManager?: D3D9QueryManager,
        /** Monotonic submission serial corresponding to this command buffer. */
        submissionSerial = 0,
        /** Viewport in effect when the pass opens. Per-draw changes arrive as SetViewport
         * commands; this only covers draws recorded before the first one (and clear-only
         * passes), since WebGPU's own default is the full attachment. */
        viewport?: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number },
        /**
         * When enabled, programmable draws linked to the WASM arena use the arena's
         * identity-resolved pipeline id and (for direct draws) its compact draw arguments.
         * RenderFrame remains the resource/state authority; an incomplete or malformed link
         * simply falls back to the ordinary command fields for that draw.
         */
        arenaAuthoritative = false,
    ): void {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        // No device: every handle this frame would reference is dead and `submit` is a
        // validated no-op. Discard the frame rather than build it against nothing.
        if (!device || !queue) {
            this.arenaPipelinesByIdentity.clear();
            frame.releaseTemporaryBuffers();
            return;
        }
        if (this.renderBundleDevice !== device) {
            this.clearRenderBundleCache();
            this.renderBundleDevice = device;
            this.renderBundleVsBuffer = null;
            this.renderBundlePsBuffer = null;
        }
        this.notePass(frame, target, present, viewport);
        this.activeQueryManager = queryManager ?? null;
        // frameCount is a D3D9 bookkeeping value, not a queue-submit count: helper paths can
        // submit additional command buffers between two execute() calls. Allocate the serial
        // from the manager so every real submission uses one domain.
        const querySubmissionSerial = queryManager?.allocateSubmissionSerial();
        let queryBatch: QueryResolveBatch | null = null;

        // Reset state tracking for the new frame/renderPass
        this.currentPipelineId = null;
        this.resetProgConstOffsetCache();
        this.resetRenderPassBindCache();
        // A fresh pass inherits no vertex bindings; every recorded draw sets its own first.
        this.boundVbSize.fill(0);
        this.boundVbOffset.fill(0);
        this.boundVbBuffer.fill(null);

        // UP rows can carry their own capture bytes in the WASM bump arena. Build temporary
        // vertex buffers before opening the render pass so the arena's captured payload, rather
        // than a separately pooled RenderFrame copy, is the authoritative input for linked
        // DrawUP rows. Invalid rows simply remain on the frame buffer path.
        const arenaUpBuffers = new Map<number, { buffer: GPUBuffer; size: number }>();
        const arenaUpUploadFailures = new Set<number>();
        let arenaUpUploadScratch = new Uint8Array(0);
        const arenaIdentityChecks = new Map<number, { identityKey: string; match: boolean }>();
        const frameSerial = ++this.executeFrameSerial;
        let commandIndex = -1;
        let validationScopePushed = false;
        let renderBundlesUsed = false;
        const renderBundlesAttempted = this.renderBundlesEnabled() && frame.arenaIndexedRuns.length > 0;
        const finishValidationScope = (): void => {
            if (!validationScopePushed) return;
            validationScopePushed = false;
            void device.popErrorScope().then((error) => {
                if (!error) return;
                if (renderBundlesUsed) {
                    this.metrics.renderBundleFailures++;
                    (globalThis as { __d3d9RenderBundles?: boolean }).__d3d9RenderBundles = false;
                }
                recordGpuError(
                    "scope",
                    "d3d9Executor.executeFrame",
                    `frame=${frameSerial} command=${commandIndex}: ${error.message}`,
                );
                Logger.error(
                    LogCategory.D3D9,
                    `executeFrame validation error frame=${frameSerial} command=${commandIndex}: ${error.message}`,
                );
            }).catch((error) => {
                recordGpuError(
                    "throw",
                    "d3d9Executor.executeFrame",
                    `frame=${frameSerial} command=${commandIndex}: ${String(error)}`,
                );
                Logger.error(
                    LogCategory.D3D9,
                    `executeFrame validation scope failed frame=${frameSerial} command=${commandIndex}: ${error}`,
                );
            });
        };
        const arenaIdentityMatches = (binding: ArenaDrawBinding): boolean => {
            if (!binding.pipelineIdentity || binding.pipelineIdentity.length !== 16
                || binding.arenaStateOffset < 0 || !binding.pipelineIdentityKey) return false;
            const stateOffset = binding.arenaStateOffset;
            const cached = arenaIdentityChecks.get(stateOffset);
            if (cached?.identityKey === binding.pipelineIdentityKey) return cached.match;
            // execute() is one synchronous turn: the cached WASM views cannot be invalidated by
            // a memory-growing call between these reads, while ensureFresh() remains defensive.
            let match = false;
            try {
                const captured = d3d9WasmArena.readDrawState(binding.arenaStateOffset).pipelineIdentity;
                match = true;
                for (let word = 0; word < 16; word++) {
                    if (captured[word] !== (binding.pipelineIdentity[word]! >>> 0)) {
                        match = false;
                        break;
                    }
                }
            } catch {
                match = false;
            }
            arenaIdentityChecks.set(stateOffset, { identityKey: binding.pipelineIdentityKey, match });
            return match;
        };
        const arenaBindingPreflight = (binding: ArenaDrawBinding): boolean =>
            binding.pipelineId >= 0
            && !!this.pipelines[binding.pipelineId]
            && !!binding.pipelineIdentityKey
            && this.arenaPipelinesByIdentity.get(binding.pipelineIdentityKey) === binding.pipelineId
            && arenaIdentityMatches(binding);

        try {
            // WebGPU validation is asynchronous and does not throw from queue.submit. Keep one
            // frame-level scope around uploads, pass encoding and submit so a failure that is not
            // attributable to a pipeline scope still names this frame and its last command.
            device.pushErrorScope("validation");
            validationScopePushed = true;

            // Upload queued data
            for (let i = 0; i < frame.uploadBuffers.length; i++) {
                const bytes = frame.uploadData[i] as Uint8Array;
                queue.writeBuffer(frame.uploadBuffers[i], frame.uploadOffsets[i] ?? 0, bytes as any);
                noteBufferUpload("d3d9", bytes.byteLength, (frame.uploadOffsets[i] ?? 0) === 0
                    && bytes.byteLength >= frame.uploadBuffers[i]!.size);
            }

            // Pre-size the programmable per-draw uniform arenas for this frame.
            if (frame.drawStateCount > 0) {
                const { vsNeeded, psNeeded } = estimateProgrammableArenaNeeds(frame);
                if (!this.vsArena) this.vsArena = new UniformArena(device, "vs-const-arena");
                if (!this.psArena) this.psArena = new UniformArena(device, "ps-const-arena");
                // Pad by one full binding window so the last block's dynamic-offset
                // range [offset, offset + *_BIND_SIZE) stays within the buffer.
                this.vsArena.begin(vsNeeded + VS_BIND_SIZE + this.arenaVsGrowthReserve);
                this.psArena.begin(psNeeded + PS_BIND_SIZE);

                // Cached programmable bind groups bind the arena buffers; if begin()
                // recreated either buffer, the cache is stale → drop it.
                if (this.vsArena.buffer !== this.progCacheVsBuffer || this.psArena.buffer !== this.progCachePsBuffer) {
                    // Render bundles retain bind groups, which in turn retain these arena
                    // buffers. A grow/recreate is a hard generation boundary for the cache.
                    this.clearRenderBundleCache();
                    this.renderBundleVsBuffer = this.vsArena.buffer;
                    this.renderBundlePsBuffer = this.psArena.buffer;
                    this.dropProgBindFastKey();
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
                // The "auto" path's groups bind a buffer RANGE of this arena, so a recreated
                // buffer invalidates them all. The rewind itself does NOT: a cached group is
                // re-bound only for a draw whose block is at that same offset now.
                if (this.ffpArena.buffer !== this.ffpAutoBuffer) {
                    this.resetFfpAutoCache();
                    this.ffpAutoBuffer = this.ffpArena.buffer;
                }
                // The identical-block memo does die with the rewind: its offset no longer
                // names the bytes it recorded.
                this.lastBlockLen = -1;
            }

            // Ensure offscreen target for the swap-chain path, including the legal D3D9 case
            // where RT0 is the backbuffer and only an MRT slot > 0 is explicit.
            if (!target || target.colorViews[0] === null) this.ensureOffscreenTarget();

            // Create command encoder
            const encoder = device.createCommandEncoder();
            // WBUF pair-runs are arena-authoritative commands even when the broader per-draw
            // identity bypass is disabled, so MegaBatch is not gated on d3dWasmPath.
            const megaBatchPlans = this.megaBatchEnabled() && frame.arenaIndexedRuns.length > 0
                ? this.prepareMegaBatchRuns(frame, device, queue)
                : new Map<number, MegaBatchRunPlan>();
            // Recorder emits SetPipeline(normal) before each compact arena run. A successful
            // plan replaces that run with its storage-VS companion, so binding the normal
            // pipeline first is pure driver work. Prove the SetPipeline reaches a planned run
            // before any intervening draw, then suppress only that exact command.
            const megaBatchSetPipelineSkips = new Set<number>();
            const megaBatchRestoreNormal = new Set<number>();
            const megaBatchFusedDrawSkips = new Set<number>();
            const megaBatchFusedBindSkips = new Set<number>();
            for (const plan of megaBatchPlans.values()) {
                if (plan.fusedDrawCommand >= 0) megaBatchFusedDrawSkips.add(plan.fusedDrawCommand);
                if (plan.fusedBindCommand >= 0) megaBatchFusedBindSkips.add(plan.fusedBindCommand);
            }
            if (megaBatchPlans.size > 0) {
                let pendingPipelineCommand = -1;
                let pendingMegaRun = -1;
                for (let scan = 0; scan < frame.commandTypes.length; scan++) {
                    const type = frame.commandTypes[scan];
                    if (type === RenderCommandType.SetPipeline) {
                        pendingMegaRun = -1;
                        pendingPipelineCommand = scan;
                    } else if (type === RenderCommandType.DrawIndexedArenaRun) {
                        const runIndex = frame.commandA[scan] >>> 0;
                        if (pendingPipelineCommand >= 0 && megaBatchPlans.has(runIndex)) {
                            megaBatchSetPipelineSkips.add(pendingPipelineCommand);
                        }
                        if (!megaBatchPlans.has(runIndex) && pendingMegaRun >= 0) {
                            megaBatchRestoreNormal.add(pendingMegaRun);
                        }
                        pendingMegaRun = megaBatchPlans.has(runIndex) ? runIndex : -1;
                        pendingPipelineCommand = -1;
                    } else if (type === RenderCommandType.DrawIndexed
                        && megaBatchFusedDrawSkips.has(scan)) {
                        // Instance zero of the following planned run replaces this draw.
                    } else if (type === RenderCommandType.Draw || type === RenderCommandType.DrawIndexed) {
                        if (pendingMegaRun >= 0) megaBatchRestoreNormal.add(pendingMegaRun);
                        pendingMegaRun = -1;
                        pendingPipelineCommand = -1;
                    }
                }
            }

            if (arenaAuthoritative && frame.arenaDrawBindings.length > 0) {
                const arenaTypes = d3d9WasmArena.getCommandTypes();
                const arenaB = d3d9WasmArena.getCommandB();
                const arenaC = d3d9WasmArena.getCommandC();
                let arenaUpBytes = 0;
                const failArenaUpUpload = (row: number): void => {
                    if (arenaUpUploadFailures.has(row)) return;
                    arenaUpUploadFailures.add(row);
                    this.arenaDrainStats.upUploadFailures++;
                };
                const pooledVertexBufferForDraw = (drawCommand: number): GPUBuffer | null => {
                    for (let command = drawCommand - 1; command >= 0; command--) {
                        const type = frame.commandTypes[command];
                        if (type === RenderCommandType.SetVertexBuffer
                            && (frame.commandD[command] ?? 0) === 0) {
                            const buffer = frame.bufferRefs[frame.commandA[command]!];
                            return frame.pooledBuffers.includes(buffer) ? buffer : null;
                        }
                        if (type === RenderCommandType.Draw || type === RenderCommandType.DrawIndexed) break;
                    }
                    return null;
                };
                for (const binding of frame.arenaDrawBindings) {
                    if (binding.arenaCommandType !== ArenaCommandType.DrawUP) continue;
                    const row = binding.arenaDrawCommand;
                    if (row < 0 || row >= arenaTypes.length || arenaTypes[row] !== ArenaCommandType.DrawUP) {
                        failArenaUpUpload(row);
                        continue;
                    }
                    // Validate the link and captured draw-state before allocating any GPU
                    // memory. A stale/malformed binding must drop this draw: the producer
                    // intentionally suppressed the RenderFrame upload for an arena-authoritative
                    // row, so falling through would bind uninitialised pooled bytes.
                    if (!arenaBindingPreflight(binding)) {
                        failArenaUpUpload(row);
                        continue;
                    }
                    const buffer = pooledVertexBufferForDraw(binding.frameDrawCommand);
                    const byteLen = arenaC[row] >>> 0;
                    const offset = arenaB[row] >>> 0;
                    const uploadSize = Math.ceil(byteLen / 4) * 4;
                    if (byteLen === 0 || uploadSize < byteLen
                        || uploadSize > D3D9_ARENA_BUMP_CAP || !buffer
                        || buffer.size < Math.max(16, uploadSize)
                        || arenaUpBytes > D3D9_ARENA_BUMP_CAP - uploadSize) {
                        failArenaUpUpload(row);
                        continue;
                    }
                    try {
                        const bytes = d3d9WasmArena.readBumpBytes(offset, byteLen);
                        // queue.writeBuffer requires a 4-byte data extent even though D3D9
                        // vertex strides are byte-granular. Pad the upload, while retaining
                        // the original byte length for WebGPU's vertex-range validation.
                        if (arenaUpUploadScratch.byteLength < uploadSize) {
                            arenaUpUploadScratch = new Uint8Array(uploadSize);
                        }
                        const upload = arenaUpUploadScratch.subarray(0, uploadSize);
                        upload.fill(0);
                        upload.set(bytes);
                        queue.writeBuffer(buffer, 0, upload);
                        arenaUpBuffers.set(row, { buffer, size: byteLen });
                        arenaUpBytes += uploadSize;
                    } catch {
                        // Bounds/memory-growth or queue failures are draw-local. The producer
                        // suppressed its legacy upload, so skip the row rather than sampling
                        // stale pooled contents.
                        failArenaUpUpload(row);
                    }
                }
            }

            // Robustness padding is staged here, before the pass opens — a buffer copy inside
            // a render pass is not legal (see planVertexRangePadding).
            this.planVertexRangePadding(frame, device, encoder);

            const clearTarget = (frame.clear.flags & 1) !== 0; // D3DCLEAR_TARGET
            const clearZ = (frame.clear.flags & 2) !== 0; // D3DCLEAR_ZBUFFER
            // An explicitly bound D3D9 depth surface can change the pipeline depth format
            // while the backbuffer MSAA color target remains the same. Re-key the paired MSAA
            // depth texture before opening the pass so WebGPU's pipeline/attachment formats
            // stay identical.
            if (!target?.multisample && target?.backbuffer && this.d3d9MsaaSampleCount > 1) {
                this.ensureD3d9MsaaTarget(target.depthFormat ?? "depth24plus-stencil8", target.multisampleDepth);
            }
            const baseMultisample = target?.multisample ?? (target?.backbuffer ? this.d3d9MsaaTarget : null);
            // The pipeline/resolve view format must agree when SRGBWRITEENABLE
            // selects an sRGB view of the single-sample backbuffer.
            const srgbMsaaFormat = baseMultisample && target?.srgbWrite
                ? dxSrgbViewFormat(baseMultisample.colorFormat)
                : null;
            const srgbResolveView = target?.backbuffer
                ? this.offscreenSrgbView
                : target?.colorViews[0] ?? baseMultisample?.resolveView;
            const passMultisample = baseMultisample && srgbMsaaFormat && srgbResolveView
                ? {
                    ...baseMultisample,
                    colorFormat: srgbMsaaFormat,
                    colorView: baseMultisample.colorTexture.createView({ format: srgbMsaaFormat }),
                    resolveView: srgbResolveView,
                }
                : baseMultisample;

            const offscreenColorView = target?.srgbWrite
                ? (this.offscreenSrgbView ?? this.offscreenView)
                : this.offscreenView;
            const colorAttachments: Array<GPURenderPassColorAttachment | null> = target
                ? target.colorViews.map((view, index) => (view ?? (index === 0 ? offscreenColorView : null)) ? ({
                    view: (view ?? (index === 0 ? offscreenColorView : null))!,
                    clearValue: frame.clear.color,
                    loadOp: (frame.hasClear && clearTarget) ? "clear" : "load",
                    storeOp: "store",
                }) : null)
                : [{
                    view: this.offscreenView!,
                    clearValue: frame.clear.color,
                    loadOp: (frame.hasClear && clearTarget) ? "clear" : "load",
                    storeOp: "store",
                }];

            const depthFormat = passMultisample?.depthFormat ?? target?.depthFormat ?? "depth24plus-stencil8";
            const hasStencil = depthFormat === "depth24plus-stencil8" || depthFormat === "depth32float-stencil8";
            // A WebGPU render pass may reference only one occlusion query set. Resolve
            // the set before opening the pass so beginOcclusionQuery is valid for the
            // manager-owned slots. If a frame spans multiple pools the manager returns
            // null; its begin/end hooks then fail explicitly and GetData reports
            // NOTAVAILABLE instead of leaving a permanently pending query.
            const occlusionQueryIds: number[] = [];
            if (queryManager) {
                for (let i = 0; i < frame.commandTypes.length; i++) {
                    const type = frame.commandTypes[i];
                    if (type === RenderCommandType.BeginOcclusionQuery || type === RenderCommandType.EndOcclusionQuery) {
                        occlusionQueryIds.push(frame.commandA[i] >>> 0);
                    }
                }
            }
            const occlusionQuerySet = queryManager?.getOcclusionQuerySet(occlusionQueryIds) ?? undefined;
            const depthStencilAttachment: GPURenderPassDepthStencilAttachment = target?.depthStencil ?? {
                view: target?.depthView ?? this.depthView!,
                depthClearValue: frame.clear.depth,
                depthLoadOp: (frame.hasClear && clearZ) ? "clear" : "load",
                depthStoreOp: "store",
                ...(hasStencil ? {
                    stencilClearValue: frame.clear.stencil,
                    stencilLoadOp: (frame.hasClear && (frame.clear.flags & 4) !== 0) ? "clear" : "load",
                    stencilStoreOp: "store",
                } : {}),
            };

            const bundleColorFormats = passMultisample
                ? [passMultisample.colorFormat]
                : (target?.colorFormats ?? [this.backend.getFormat()!]);
            const renderBundleSegments = this.prepareRenderBundleSegments(
                frame, device, bundleColorFormats, depthFormat, passMultisample?.sampleCount ?? 1,
                megaBatchFusedDrawSkips,
            );

            const renderPass = passMultisample
                ? beginD3D9MultisampleRenderPass(encoder, passMultisample, {
                    clearColor: frame.clear.color,
                    colorLoadOp: (frame.hasClear && clearTarget) ? "clear" : "load",
                    depthLoadOp: (frame.hasClear && clearZ) ? "clear" : "load",
                     clearDepth: frame.clear.depth,
                     stencilLoadOp: (frame.hasClear && (frame.clear.flags & 4) !== 0) ? "clear" : "load",
                     clearStencil: frame.clear.stencil,
                     occlusionQuerySet,
                 })
                 : encoder.beginRenderPass({
                     colorAttachments,
                     depthStencilAttachment,
                     ...(occlusionQuerySet ? { occlusionQuerySet } : {}),
                 });
            if (viewport && typeof renderPass.setViewport === "function") {
                renderPass.setViewport(
                    viewport.x, viewport.y, viewport.width, viewport.height,
                    viewport.minZ, viewport.maxZ,
                );
            }
            if (hasStencil) renderPass.setStencilReference(target?.stencilReference ?? 0);

            // Execute commands. Query commands are recorded in the same render pass/encoder
            // as their surrounding D3D9 draws, preserving occlusion boundaries and timestamp
            // ordering instead of submitting a detached query buffer.
            const queryIds: number[] = [];
            const arenaByFrameDraw = arenaAuthoritative && frame.arenaDrawBindings.length > 0
                ? new Map(frame.arenaDrawBindings.map(binding => [binding.frameDrawCommand, binding] as const))
                : null;
            const arenaCommandA = arenaByFrameDraw ? d3d9WasmArena.getCommandA() : null;
            const arenaCommandB = arenaByFrameDraw ? d3d9WasmArena.getCommandB() : null;
            const arenaCommandC = arenaByFrameDraw ? d3d9WasmArena.getCommandC() : null;
            const arenaPipelineKeys = arenaByFrameDraw ? d3d9WasmArena.getPipelineKeys() : null;
            for (let i = 0; i < frame.commandTypes.length; i++) {
                commandIndex = i;
                const preparedBundle = renderBundleSegments.get(i);
                if (preparedBundle) {
                    const { segment, bundle } = preparedBundle;
                    renderPass.executeBundles([bundle]);
                    renderBundlesUsed = true;
                    this.metrics.renderBundleExecutions++;
                    this.metrics.renderBundleDraws += segment.draws.length;
                    this.metrics.drawCalls += segment.draws.length;
                    this.metrics.drawIndexedCalls += segment.draws.length;
                    this.arenaDrainStats.arenaRunCommands += segment.arenaRuns;
                    this.arenaDrainStats.arenaRunExpectedPairs += segment.arenaExpectedPairs;
                    this.arenaDrainStats.arenaRunExecutedPairs += segment.arenaEncodedPairs;
                    this.arenaDrainStats.arenaRunExpectedLogicalDraws += segment.arenaExpectedPairs;
                    this.arenaDrainStats.arenaRunEncodedLogicalDraws += segment.arenaEncodedPairs;
                    // Bundle staging refuses prefix runs, so the segment aggregate carries no
                    // prefix draw — it is still the shared rule that decides, not a local copy.
                    if (!arenaRunEncodingComplete(
                        { expectedPairCount: segment.arenaExpectedPairs, prefixVsBits: undefined },
                        segment.arenaEncodedPairs, segment.arenaEncodedPairs,
                    )) {
                        this.arenaDrainStats.arenaRunInvariantFailures++;
                        (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                    }

                    // executeBundles clears pipeline/bind/VB/IB state. Restore the final
                    // logical state immediately because the recorder may elide matching setup
                    // on the following non-bundled draw.
                    const last = segment.draws[segment.draws.length - 1]!;
                    this.currentPipelineId = last.pipelineId;
                    renderPass.setPipeline(last.pipeline);
                    this.metrics.pipelineSets++;
                    this.resetRenderPassBindCache();
                    this.setBindGroup0(renderPass, last.bindGroup, last.vsOffset, last.psOffset);
                    this.boundVbBuffer.fill(null);
                    this.boundVbOffset.fill(0);
                    this.boundVbSize.fill(0);
                    for (const vb of last.vertexBindings) {
                        renderPass.setVertexBuffer(vb.slot, vb.buffer, vb.offset, vb.size);
                        this.boundVbBuffer[vb.slot] = vb.buffer;
                        this.boundVbOffset[vb.slot] = vb.offset;
                        this.boundVbSize[vb.slot] = vb.size;
                    }
                    renderPass.setIndexBuffer(last.indexBuffer, last.indexFormat);
                    commandIndex = segment.endCommand;
                    i = segment.endCommand;
                    continue;
                }
                const type = frame.commandTypes[i];
                switch (type) {
                    case RenderCommandType.BeginOcclusionQuery: {
                        const id = frame.commandA[i] >>> 0;
                        if (queryManager) queryManager.beginOcclusion(id, renderPass);
                        queryIds.push(id);
                        break;
                    }

                    case RenderCommandType.EndOcclusionQuery: {
                        const id = frame.commandA[i] >>> 0;
                        if (queryManager) queryManager.endOcclusion(id, renderPass);
                        queryIds.push(id);
                        break;
                    }

                    case RenderCommandType.TimestampQuery: {
                        const id = frame.commandA[i] >>> 0;
                        if (queryManager) queryManager.writeTimestamp(id, encoder as unknown as QueryCommandEncoder);
                        queryIds.push(id);
                        break;
                    }

                    case RenderCommandType.SetStencilReference:
                        if (hasStencil) renderPass.setStencilReference(frame.commandA[i] & 0xff);
                        break;

                    case RenderCommandType.SetBlendConstant:
                        // D3DRS_BLENDFACTOR is a D3DCOLOR (0xAARRGGBB), not an ABGR word.
                        renderPass.setBlendConstant(d3dColorToGpu(frame.commandA[i]! >>> 0));
                        break;

                    case RenderCommandType.SetPipeline: {
                        if (megaBatchSetPipelineSkips.has(i)) {
                            this.currentPipelineId = null;
                            this.metrics.megaBatchNormalPipelineSkips++;
                            break;
                        }
                        const newPipelineId = frame.commandA[i];
                        const pipeline = this.pipelines[newPipelineId];
                        if (!pipeline) {
                            // An invalid pipeline id is draw-local input corruption. Keep
                            // the pass alive so subsequent valid SetPipeline commands still
                            // render; calling setPipeline(undefined) would invalidate the
                            // entire command buffer.
                            this.currentPipelineId = null;
                            break;
                        }
                        if (this.currentPipelineId !== newPipelineId) {
                            this.currentPipelineId = newPipelineId;
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
                        if (megaBatchFusedBindSkips.has(i)) break;
                        const ds = frame.drawStates[frame.commandA[i]];
                        if (ds) this.bindProgrammable(renderPass, ds);
                        break;
                    }

                    case RenderCommandType.BindFfp: {
                        const fs = frame.ffpStates[frame.commandA[i]];
                        if (fs) this.bindFfpDrawState(renderPass, device, fs);
                        break;
                    }

                    case RenderCommandType.SetVertexBuffer: {
                        const vbIndex = frame.commandA[i];
                        const vbOffset = frame.commandB[i];
                        const vbSize = frame.commandC[i];
                        // commandD = vertex-buffer slot (D3D stream number); 0 for single-stream.
                        const slot = frame.commandD[i] | 0;
                        renderPass.setVertexBuffer(slot, frame.bufferRefs[vbIndex], vbOffset, vbSize);
                        if (slot < MAX_VB_SLOTS) {
                            this.boundVbBuffer[slot] = frame.bufferRefs[vbIndex];
                            this.boundVbOffset[slot] = vbOffset;
                            this.boundVbSize[slot] = vbSize;
                        }
                        break;
                    }

                    case RenderCommandType.SetIndexBuffer: {
                        const ibIndex = frame.commandA[i];
                        const ibFormatFlag = frame.commandB[i];
                        const ibFormat = ibFormatFlag === 16 ? "uint16" : "uint32";
                        renderPass.setIndexBuffer(frame.bufferRefs[ibIndex], ibFormat);
                        break;
                    }

                    case RenderCommandType.SetViewport: {
                        const base = frame.commandA[i];
                        const v = frame.viewportData;
                        renderPass.setViewport(v[base], v[base + 1], v[base + 2], v[base + 3], v[base + 4], v[base + 5]);
                        break;
                    }

                    case RenderCommandType.SetScissor: {
                        renderPass.setScissorRect(
                            Math.max(0, frame.commandA[i] | 0),
                            Math.max(0, frame.commandB[i] | 0),
                            Math.max(0, frame.commandC[i] | 0),
                            Math.max(0, frame.commandD[i] | 0),
                        );
                        break;
                    }

                    case RenderCommandType.Draw: {
                        const arenaBinding = arenaByFrameDraw?.get(i);
                        if (arenaBinding?.arenaCommandType === ArenaCommandType.DrawUP
                            && arenaUpUploadFailures.has(arenaBinding.arenaDrawCommand)) break;
                        const arenaUsable = !!arenaBinding && arenaBinding.pipelineId >= 0
                            && !!this.pipelines[arenaBinding.pipelineId]
                            && !!arenaBinding.pipelineIdentityKey
                            && this.arenaPipelinesByIdentity.get(arenaBinding.pipelineIdentityKey) === arenaBinding.pipelineId
                            && !!arenaPipelineKeys
                            && arenaPipelineKeys[arenaBinding.arenaDrawCommand] === (arenaBinding.arenaPipelineKey >>> 0)
                            && arenaIdentityMatches(arenaBinding);
                        let vertexCount = frame.commandA[i];
                        let startVertex = frame.commandB[i];
                        if (arenaUsable && arenaBinding!.arenaCommandType === ArenaCommandType.Draw
                            && arenaCommandA && arenaCommandB) {
                            const n = arenaCommandA[arenaBinding!.arenaDrawCommand] >>> 0;
                            const start = arenaCommandB[arenaBinding!.arenaDrawCommand] >>> 0;
                            // Direct arena rows carry the same logical draw arguments as the
                            // RenderFrame row.  Keep the latter on malformed values so one
                            // corrupt WASM word cannot invalidate the whole command buffer.
                            if (n > 0 && n <= 0x7fffffff) {
                                vertexCount = n;
                                startVertex = start;
                            }
                        }
                        if (arenaUsable && arenaBinding!.arenaCommandType === ArenaCommandType.DrawUP
                            && arenaCommandA && arenaUpBuffers.has(arenaBinding!.arenaDrawCommand)) {
                            const n = arenaCommandA[arenaBinding!.arenaDrawCommand] >>> 0;
                            const up = arenaUpBuffers.get(arenaBinding!.arenaDrawCommand)!;
                            if (n > 0 && n <= 0x7fffffff) vertexCount = n;
                            renderPass.setVertexBuffer(0, up.buffer, 0, up.size);
                            this.boundVbBuffer[0] = up.buffer;
                            this.boundVbOffset[0] = 0;
                            this.boundVbSize[0] = up.size;
                        }
                        if (arenaUsable && this.currentPipelineId !== arenaBinding!.pipelineId) {
                            const arenaPipeline = this.pipelines[arenaBinding!.pipelineId]!;
                            this.currentPipelineId = arenaBinding!.pipelineId;
                            renderPass.setPipeline(arenaPipeline);
                            this.resetRenderPassBindCache();
                            this.metrics.pipelineSets++;
                        }
                        if (arenaUsable && arenaBinding!.bindStateIndex !== undefined) {
                            const arenaState = frame.drawStates[arenaBinding!.bindStateIndex];
                            if (arenaState) this.bindProgrammable(renderPass, arenaState);
                        }
                        if (this.currentPipelineId === null) break;
                        const instanceCount = frame.commandD[i] ?? 1;
                        if (validateD3D9RasterDrawCommand({
                            kind: "non-indexed",
                            count: vertexCount,
                            start: startVertex,
                            instanceCount,
                        }) !== null) break;
                        const padStart = this.applyVertexPadding(renderPass, i, device);
                        renderPass.draw(vertexCount, instanceCount, startVertex, 0);
                        this.metrics.drawCalls++;
                        if (this.padCursor > padStart) this.restoreVertexPadding(renderPass, padStart);
                        break;
                    }

                    case RenderCommandType.DrawIndexed: {
                        if (megaBatchFusedDrawSkips.has(i)) break;
                        const arenaBinding = arenaByFrameDraw?.get(i);
                        const arenaUsable = !!arenaBinding && arenaBinding.pipelineId >= 0
                            && !!this.pipelines[arenaBinding.pipelineId]
                            && !!arenaBinding.pipelineIdentityKey
                            && this.arenaPipelinesByIdentity.get(arenaBinding.pipelineIdentityKey) === arenaBinding.pipelineId
                            && !!arenaPipelineKeys
                            && arenaPipelineKeys[arenaBinding.arenaDrawCommand] === (arenaBinding.arenaPipelineKey >>> 0)
                            && arenaIdentityMatches(arenaBinding);
                        let indexCount = frame.commandA[i];
                        let startIndex = frame.commandB[i];
                        let baseVertex = frame.commandC[i];
                        if (arenaUsable && arenaBinding!.arenaCommandType === ArenaCommandType.DrawIndexed
                            && arenaCommandA && arenaCommandB && arenaCommandC) {
                            const n = arenaCommandA[arenaBinding!.arenaDrawCommand] >>> 0;
                            const start = arenaCommandB[arenaBinding!.arenaDrawCommand] >>> 0;
                            const rawBase = arenaCommandC[arenaBinding!.arenaDrawCommand] >>> 0;
                            const base = rawBase | 0;
                            if (n > 0 && n <= 0x7fffffff && rawBase <= 0x7fffffff) {
                                indexCount = n;
                                startIndex = start;
                                baseVertex = base;
                            }
                        }
                        if (arenaUsable && this.currentPipelineId !== arenaBinding!.pipelineId) {
                            const arenaPipeline = this.pipelines[arenaBinding!.pipelineId]!;
                            this.currentPipelineId = arenaBinding!.pipelineId;
                            renderPass.setPipeline(arenaPipeline);
                            this.resetRenderPassBindCache();
                            this.metrics.pipelineSets++;
                        }
                        if (arenaUsable && arenaBinding!.bindStateIndex !== undefined) {
                            const arenaState = frame.drawStates[arenaBinding!.bindStateIndex];
                            if (arenaState) this.bindProgrammable(renderPass, arenaState);
                        }
                        // commandD = instance count (SetStreamSourceFreq); 1 for an ordinary draw.
                        if (this.currentPipelineId === null) break;
                        if (validateD3D9RasterDrawCommand({
                            kind: "indexed",
                            count: indexCount,
                            start: startIndex,
                            baseVertex,
                            instanceCount: frame.commandD[i]!,
                        }) !== null) break;
                        renderPass.drawIndexed(indexCount, frame.commandD[i], startIndex, baseVertex, 0);
                        this.metrics.drawCalls++;
                        this.metrics.drawIndexedCalls++;
                        break;
                    }

                    case RenderCommandType.DrawIndexedArenaRun: {
                        const run = frame.arenaIndexedRuns[frame.commandA[i] >>> 0];
                        if (!run) {
                            this.arenaDrainStats.arenaRunInvariantFailures++;
                            (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                            break;
                        }
                        this.arenaDrainStats.arenaRunCommands++;
                        this.arenaDrainStats.arenaRunExpectedPairs += run.expectedPairCount;
                        this.arenaDrainStats.arenaRunExpectedLogicalDraws +=
                            arenaRunExpectedLogicalDraws(run);
                        const template = frame.drawStates[run.bindStateIndex];
                        if (!template) {
                            this.arenaDrainStats.arenaRunInvariantFailures++;
                            (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                            break;
                        }
                        const megaPlan = megaBatchPlans.get(frame.commandA[i] >>> 0);
                        if (megaPlan) {
                            renderPass.setPipeline(megaPlan.pipeline);
                            this.metrics.pipelineSets++;
                            this.resetRenderPassBindCache();
                            // The storage VS binding is non-dynamic; binding 1 (PS) is the
                            // sole dynamic entry, so its offset is the only array element.
                            this.setBindGroup0(renderPass, megaPlan.bindGroup, megaPlan.psOffset, -1, 1);
                            // Encode and account in one place: the ledger below counts the
                            // instances the encoder received, never the pair count the planner
                            // hoped for.
                            const issued = encodeMegaBatchRunDraw(renderPass, megaPlan, run);
                            const logical = issued.issuedInstances;
                            this.metrics.drawCalls += logical;
                            this.metrics.drawIndexedCalls += logical;
                            this.arenaDrainStats.drawIndexedCount += issued.encodedPairs;
                            this.arenaDrainStats.arenaRunExecutedPairs += issued.encodedPairs;
                            this.arenaDrainStats.arenaRunEncodedLogicalDraws +=
                                issued.encodedRunLogicalDraws;
                            if (!issued.packConsistent
                                || !arenaRunEncodingComplete(run, issued.encodedPairs,
                                    issued.encodedRunLogicalDraws)) {
                                this.arenaDrainStats.arenaRunInvariantFailures++;
                                (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                            }
                            this.metrics.megaBatchBatches++;
                            this.metrics.megaBatchLogicalDraws += logical;
                            this.metrics.megaBatchPhysicalDraws++;
                            this.metrics.megaBatchPackedBytes += megaPlan.packedBytes;
                            if (megaPlan.fusedDrawCommand >= 0 || run.prefixVsBits) {
                                this.metrics.megaBatchFusedOrdinaryDraws++;
                            }
                            if (megaBatchRestoreNormal.has(frame.commandA[i] >>> 0)) {
                                const normalPipeline = this.pipelines[run.pipelineId];
                                if (normalPipeline) {
                                    renderPass.setPipeline(normalPipeline);
                                    this.metrics.pipelineSets++;
                                    this.resetRenderPassBindCache();
                                    this.currentPipelineId = run.pipelineId;
                                } else {
                                    this.currentPipelineId = null;
                                }
                            } else {
                                // The next RenderFrame SetPipeline names the normal variant.
                                // Never let its integer-id memo suppress that rebind.
                                this.currentPipelineId = null;
                            }
                            break;
                        }
                        const runPipeline = this.pipelines[run.pipelineId];
                        if (!runPipeline) {
                            this.arenaDrainStats.arenaRunInvariantFailures++;
                            (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                            if (this.arenaRunInvariantLogs++ < 5) Logger.error(LogCategory.D3D9,
                                `[D3D9 arena-run] missing pipeline ${run.pipelineId}; expected ${run.expectedPairCount} draws`);
                            break;
                        }
                        if (this.currentPipelineId !== run.pipelineId) {
                            this.currentPipelineId = run.pipelineId;
                            renderPass.setPipeline(runPipeline);
                            this.resetRenderPassBindCache();
                            this.metrics.pipelineSets++;
                        }
                        // Both per-pair replays below write one uniform block per logical draw.
                        // Prove the whole run fits BEFORE the first write: a shortfall found
                        // mid-run would throw out of encode and take every upload this frame
                        // already queued with it.
                        const runBudget = planArenaRunUniformReplay(
                            run, template.vsLen, this.vsArena?.remaining() ?? 0,
                        );
                        if (!runBudget.fits) {
                            this.arenaDrainStats.arenaRunCapacityDeclines++;
                            this.arenaDrainStats.arenaRunInvariantFailures++;
                            this.arenaVsGrowthReserve = Math.max(
                                this.arenaVsGrowthReserve, runBudget.shortfallBytes,
                            );
                            (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                            if (this.arenaRunInvariantLogs++ < 5) Logger.error(LogCategory.D3D9,
                                `[D3D9 arena-run] declined ${run.expectedPairCount} pairs: needs `
                                + `${runBudget.neededBytes} VS bytes, ${this.vsArena?.remaining() ?? 0} left`);
                            break;
                        }
                        // Budget vs actual consumption. A replay that binds more times than the
                        // estimator reserved is exactly how the arena runs out mid-frame, and
                        // nothing else can witness it: both paths look complete on their own.
                        const runVsCursor = this.vsArena?.position() ?? 0;
                        if (this.compactMegaRunEnabled() && run.compactDescriptorOffset >= 0) {
                            let executedPairs = 0;
                            let encodedLogicalDraws = 0;
                            this.metrics.compactMegaRunFallbacks++;
                            try {
                                const compact = d3d9WasmArena.readCompactWbufRun(
                                    run.compactDescriptorOffset,
                                );
                                const floatStart = compact.startRegister * 4;
                                if (compact.pairCount !== run.expectedPairCount
                                    || floatStart > template.vsLen
                                    || compact.floatCount > template.vsLen - floatStart
                                    || (run.prefixVsBits
                                        && (run.prefixStartFloat > template.vsLen
                                            || run.prefixVsBits.length > template.vsLen - run.prefixStartFloat))
                                    || (compact.storageReady
                                        && compact.payloadStrideWords > template.vsLen)) {
                                    throw new RangeError("compact run does not fit its programmable template");
                                }
                                if (run.prefixVsBits) {
                                    template.vsBits.set(run.prefixVsBits, run.prefixStartFloat);
                                    template.vsVersion = undefined;
                                    if (!this.tryBindProgrammable(renderPass, template)) {
                                        this.arenaDrainStats.arenaRunCapacityFailures++;
                                    } else if (validateD3D9RasterDrawCommand({
                                        kind: "indexed", count: compact.indexCount,
                                        start: compact.startIndex, baseVertex: compact.baseVertex,
                                        instanceCount: 1,
                                    }) === null) {
                                        renderPass.drawIndexed(
                                            compact.indexCount, 1, compact.startIndex,
                                            compact.baseVertex, 0,
                                        );
                                        this.metrics.drawCalls++;
                                        this.metrics.drawIndexedCalls++;
                                        encodedLogicalDraws++;
                                    } else {
                                        this.arenaDrainStats.arenaRunValidatorSkips++;
                                    }
                                }
                                for (let pair = 0; pair < compact.pairCount; pair++) {
                                    const source = pair * compact.floatCount;
                                    if (compact.storageReady) {
                                        const slotSource = pair * compact.payloadStrideWords;
                                        template.vsBits.set(compact.payloadBits.subarray(
                                            slotSource, slotSource + compact.payloadStrideWords,
                                        ), 0);
                                    } else {
                                        template.vsBits.set(
                                            compact.payloadBits.subarray(
                                                source, source + compact.floatCount,
                                            ),
                                            floatStart,
                                        );
                                    }
                                    template.vsVersion = undefined;
                                    if (!this.tryBindProgrammable(renderPass, template)) {
                                        this.arenaDrainStats.arenaRunCapacityFailures++;
                                        break;
                                    }
                                    if (validateD3D9RasterDrawCommand({
                                        kind: "indexed",
                                        count: compact.indexCount,
                                        start: compact.startIndex,
                                        baseVertex: compact.baseVertex,
                                        instanceCount: 1,
                                    }) !== null) {
                                        this.arenaDrainStats.arenaRunValidatorSkips++;
                                        continue;
                                    }
                                    renderPass.drawIndexed(
                                        compact.indexCount, 1, compact.startIndex,
                                        compact.baseVertex, 0,
                                    );
                                    this.metrics.drawCalls++;
                                    this.metrics.drawIndexedCalls++;
                                    this.arenaDrainStats.drawIndexedCount++;
                                    executedPairs++;
                                    encodedLogicalDraws++;
                                }
                            } catch {
                                this.metrics.compactMegaRunDecodeFailures++;
                                this.arenaDrainStats.arenaRunDecodeFailures++;
                            }
                            this.arenaDrainStats.arenaRunExecutedPairs += executedPairs;
                            this.arenaDrainStats.arenaRunEncodedLogicalDraws += encodedLogicalDraws;
                            this.noteArenaRunUniformSpend(runVsCursor, runBudget.neededBytes);
                            if (!arenaRunEncodingComplete(run, executedPairs, encodedLogicalDraws)) {
                                this.arenaDrainStats.arenaRunInvariantFailures++;
                                (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                            }
                            break;
                        }
                        const arenaCount = d3d9WasmArena.getCommandCount();
                        if (run.arenaCommandStart < 0 || run.arenaCommandEnd > arenaCount
                            || run.arenaCommandStart >= run.arenaCommandEnd) {
                            this.arenaDrainStats.arenaRunInvariantFailures++;
                            (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                            break;
                        }
                        const types = d3d9WasmArena.getCommandTypes();
                        const a = d3d9WasmArena.getCommandA();
                        const b = d3d9WasmArena.getCommandB();
                        const c = d3d9WasmArena.getCommandC();
                        let stateOffset = -1;
                        let executedPairs = 0;
                        let encodedLogicalDraws = 0;
                        const prefixShapeValid = !run.prefixVsBits
                            || (run.prefixStartFloat >= 0
                                && run.prefixStartFloat <= template.vsLen
                                && run.prefixVsBits.length <= template.vsLen - run.prefixStartFloat);
                        // The fused prefix overlays the PRISTINE template — the same base the
                        // MegaBatch and compact paths use — so which pair the run happens to
                        // replay first is not load-bearing. It is emitted before the loop, which
                        // also makes the run's arena writes exactly the pairs+1 the budget
                        // reserves. Draw parameters come from the run's first DrawIndexed row.
                        let firstDrawRow = -1;
                        if (run.prefixVsBits && prefixShapeValid) {
                            for (let row = run.arenaCommandStart; row < run.arenaCommandEnd; row++) {
                                if (types[row] === ArenaCommandType.DrawIndexed) { firstDrawRow = row; break; }
                            }
                        }
                        if (firstDrawRow >= 0) {
                            const indexCount = a[firstDrawRow] >>> 0;
                            const startIndex = b[firstDrawRow] >>> 0;
                            const baseVertex = c[firstDrawRow] | 0;
                            const overlaid = run.prefixVsBits!.length;
                            if (this.arenaPrefixRestore.length < overlaid) {
                                this.arenaPrefixRestore = new Uint32Array(overlaid);
                            }
                            this.arenaPrefixRestore.set(template.vsBits.subarray(
                                run.prefixStartFloat, run.prefixStartFloat + overlaid), 0);
                            template.vsBits.set(run.prefixVsBits!, run.prefixStartFloat);
                            template.vsVersion = undefined;
                            if (!this.tryBindProgrammable(renderPass, template)) {
                                this.arenaDrainStats.arenaRunCapacityFailures++;
                            } else if (validateD3D9RasterDrawCommand({
                                kind: "indexed", count: indexCount, start: startIndex,
                                baseVertex, instanceCount: 1,
                            }) === null) {
                                renderPass.drawIndexed(indexCount, 1, startIndex, baseVertex, 0);
                                this.metrics.drawCalls++;
                                this.metrics.drawIndexedCalls++;
                                encodedLogicalDraws++;
                            } else {
                                this.arenaDrainStats.arenaRunValidatorSkips++;
                            }
                            // Restore the exact overlaid window, not a fixed head of the bank:
                            // a prefix reaching past the pairs' own copy length would otherwise
                            // leak into every following draw of the run.
                            template.vsBits.set(
                                this.arenaPrefixRestore.subarray(0, overlaid), run.prefixStartFloat);
                            template.vsVersion = undefined;
                        }
                        for (let row = run.arenaCommandStart; row < run.arenaCommandEnd; row++) {
                            const arenaType = types[row];
                            if (arenaType === ArenaCommandType.BindProgrammable) {
                                stateOffset = a[row] >>> 0;
                                continue;
                            }
                            if (arenaType !== ArenaCommandType.DrawIndexed || stateOffset < 0) continue;
                            let captured: ReturnType<typeof d3d9WasmArena.readDrawState>;
                            try {
                                captured = d3d9WasmArena.readDrawState(stateOffset);
                            } catch {
                                // The Rust transaction validated/captured this row. A later
                                // malformed cursor is isolated to the run rather than poisoning
                                // the WebGPU command buffer.
                                this.arenaDrainStats.arenaRunDecodeFailures++;
                                break;
                            }
                            const prefix = Math.min(template.vsLen, captured.vsConstants.length);
                            template.vsConst.set(captured.vsConstants.subarray(0, prefix), 0);
                            template.vsVersion = undefined;
                            if (!this.tryBindProgrammable(renderPass, template)) {
                                this.arenaDrainStats.arenaRunCapacityFailures++;
                                break;
                            }
                            const indexCount = a[row] >>> 0;
                            const startIndex = b[row] >>> 0;
                            const baseVertex = c[row] | 0;
                            if (validateD3D9RasterDrawCommand({
                                kind: "indexed", count: indexCount, start: startIndex,
                                baseVertex, instanceCount: 1,
                            }) !== null) {
                                this.arenaDrainStats.arenaRunValidatorSkips++;
                                continue;
                            }
                            renderPass.drawIndexed(indexCount, 1, startIndex, baseVertex, 0);
                            this.metrics.drawCalls++;
                            this.metrics.drawIndexedCalls++;
                            this.arenaDrainStats.drawIndexedCount++;
                            executedPairs++;
                            encodedLogicalDraws++;
                        }
                        this.arenaDrainStats.arenaRunExecutedPairs += executedPairs;
                        this.arenaDrainStats.arenaRunEncodedLogicalDraws += encodedLogicalDraws;
                        this.noteArenaRunUniformSpend(runVsCursor, runBudget.neededBytes);
                        if (!arenaRunEncodingComplete(run, executedPairs, encodedLogicalDraws)) {
                            this.arenaDrainStats.arenaRunInvariantFailures++;
                            // Fail closed for every subsequent drain. The current run has
                            // already reached encode time, so keeping the optimization armed
                            // would turn a malformed range into a misleading high-FPS mode.
                            (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                            if (this.arenaRunInvariantLogs++ < 5) Logger.error(LogCategory.D3D9,
                                `[D3D9 arena-run] executed ${executedPairs}/${run.expectedPairCount} draws `
                                + `from rows ${run.arenaCommandStart}..${run.arenaCommandEnd}/${arenaCount}`);
                        }
                        break;
                    }
                }
            }

            renderPass.end();
            if (queryManager && querySubmissionSerial !== undefined && queryIds.length > 0) {
                queryBatch = queryManager.encodeResolves(
                    encoder as unknown as QueryCommandEncoder,
                    [...new Set(queryIds)],
                    querySubmissionSerial,
                );
            }

            // Composite overlays on top of the main scene: video plane first, then GDI.
            // (Swap-chain path only — RT passes never composite overlays or present.)
            const rendersToBackbuffer = !target || target.backbuffer === true;
            if (present && rendersToBackbuffer && overlays?.videoOverlayCanvas) {
                this.backend.blit(overlays.videoOverlayCanvas, this.offscreenView!, encoder);
            }
            if (present && rendersToBackbuffer && overlays?.gdiOverlayCanvas) {
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
            if (present && rendersToBackbuffer) {
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

                // The single offscreen texture otherwise has COPY semantics. DISCARD
                // must not feed the previous presented image into the next frame.
                if (discardBackbufferAfterPresent) {
                    const discardPass = encoder.beginRenderPass({
                        colorAttachments: [{
                            view: this.offscreenView!,
                            clearValue: { r: 0, g: 0, b: 0, a: 0 },
                            loadOp: "clear",
                            storeOp: "store",
                        }],
                    });
                    discardPass.end();
                }
            }

            const submitStart = frameProfiler.startTimer();
            // All dynamic offsets are now known. One upload per active arena replaces
            // hundreds/thousands of small queue.writeBuffer calls in draw order.
            this.vsArena?.flush(queue);
            this.psArena?.flush(queue);
            this.ffpArena?.flush(queue);
            this.submitCount++;
            if (present) { this.presentCount++; this.censusPresents++; }
            const submitT0 = performance.now();
            queue.submit([encoder.finish()]);
            this.submitMs += performance.now() - submitT0;
            if (queryManager && queryBatch?.status === "encoded") {
                queryManager.markSubmitted(queryBatch);
            } else if (queryManager && querySubmissionSerial !== undefined) {
                // A query-free submission is still a boundary for a BEGIN-only occlusion
                // interval and must advance the same domain used by GetData.
                queryManager.notifySubmitted(querySubmissionSerial);
            }
            frameProfiler.endTimer("gpu", submitStart);
        } catch (e) {
            if (renderBundlesAttempted) {
                this.metrics.renderBundleFailures++;
                (globalThis as { __d3d9RenderBundles?: boolean }).__d3d9RenderBundles = false;
            }
            if (e instanceof UniformArenaCapacityError) {
                // The arena-run replays preflight their own capacity, so a throw that still
                // reaches here came from a path the frame estimate under-sized. Reserve a
                // block for the next begin() so the same frame shape cannot repeat it.
                this.arenaVsGrowthReserve += VS_BIND_SIZE;
                if (frame.commandTypes[commandIndex] === RenderCommandType.DrawIndexedArenaRun) {
                    this.arenaDrainStats.arenaRunCapacityFailures++;
                    this.arenaDrainStats.arenaRunInvariantFailures++;
                    (globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns = true;
                }
            }
            if (queryManager && queryBatch?.status === "encoded") {
                queryManager.abandon(queryBatch, `execute-frame-aborted:${frameSerial}:${commandIndex}`);
            }
            // A synchronous throw here (e.g. a misaligned writeBuffer) discards the ENTIRE
            // frame, and every upload queued after it is lost permanently — the producers
            // already cleared their dirty flags. Never quiet, but never a firehose either:
            // the condition usually persists, so log the first of each run and then thin out.
            // recordGpuError keeps the full census regardless of the log throttle.
            recordGpuError(
                "throw",
                "d3d9Executor.executeFrame",
                `frame=${frameSerial} command=${commandIndex}: ${String(e)}`,
            );
            this.executeFrameThrows = (this.executeFrameThrows + 1) >>> 0;
            if (this.executeFrameThrows % 200 === 1) {
                Logger.error(LogCategory.D3D9,
                    `executeFrame aborted mid-flush — frame discarded, queued uploads lost `
                    + `(frame=${frameSerial} command=${commandIndex}, ${this.executeFrameThrows} so far): ${e}`);
            }
        } finally {
            finishValidationScope();
            // Identities are frame links, not a lifetime cache. Pipelines themselves remain
            // indexed in `pipelines`; only this frame's identity-to-pipeline associations expire.
            this.arenaPipelinesByIdentity.clear();
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
        this.noteQuerySubmission();
    }

    /**
     * Read the last completed presented image as tightly packed RGBA8 pixels.
     * Refuses instead of answering when no complete frame exists yet: with a DISCARD swap
     * chain the live offscreen is deliberately cleared after every present, so reading it
     * hands back a plausible black image that no caller can tell from a black game.
     */
    async readPresentedRgba(
        opts?: { live?: boolean },
    ): Promise<{ rgba: Uint8Array; width: number; height: number }> {
        const device = this.backend.getDevice()!;
        const queue = this.backend.getQueue()!;
        // Read the last COMPLETE presented frame when available (the live offscreen is transiently
        // black mid-frame), so screenshots/readback match what the user actually sees on the canvas.
        //
        // `live` asks for the BACK BUFFER AS IT STANDS instead, which is what
        // GetRenderTargetData owes its caller: a guest reads back the frame it just drew and
        // has not presented yet, so answering with the last presented image is one frame
        // stale — invisible while consecutive frames are identical, and wrong the moment one
        // differs.
        const captureSrc = opts?.live
            ? this.offscreenTexture
            : ((this.hasPresented && this.presentedTexture) ? this.presentedTexture : this.offscreenTexture);
        if (!captureSrc) {
            throw new Error("d3d9 presenter has no frame to capture — nothing has been rendered yet");
        }
        if (!this.hasPresented && !opts?.live) {
            throw new Error("d3d9 presenter has not completed a frame yet — the live offscreen is"
                + " cleared after a DISCARD present, so it would read black whatever the game drew");
        }
        // The SOURCE's extent, not the canvas's: a resize between the last present and this
        // readback leaves the two disagreeing, and a mismatched copyTextureToBuffer is a
        // WebGPU validation error — which never throws, it just leaves the buffer zeroed.
        const width = captureSrc.width;
        const height = captureSrc.height;

        const bytesPerPixel = 4;
        const unpaddedBytesPerRow = width * bytesPerPixel;
        const align = 256;
        const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / align) * align;
        const bufferSize = paddedBytesPerRow * height;

        const readback = device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture: captureSrc },
                { buffer: readback, bytesPerRow: paddedBytesPerRow },
                { width, height, depthOrArrayLayers: 1 }
            );
            const submitStart = frameProfiler.startTimer();
            queue.submit([encoder.finish()]);
            this.noteQuerySubmission();
            this.d3d9MsaaCache?.flushGarbage();
            frameProfiler.endTimer("gpu", submitStart);
            await queue.onSubmittedWorkDone();

            await readback.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(readback.getMappedRange());
            const pixels = new Uint8Array(width * height * bytesPerPixel);
        // Swizzle AND alpha exactly as the screen route does (WebGPUBackend.captureMirroredFrame),
        // because both routes must agree about the same pixels. The offscreen carries the
        // canvas's preferred format (bgra8unorm on most desktops) while ImageData is RGBA; and
        // the canvas is alphaMode:"opaque", so this swap-chain image's alpha is not coverage —
        // D3D9 apps routinely leave it 0, and carrying that into ImageData makes putImageData
        // premultiply the picture away, yielding a transparent PNG that reads as a plausible
        // black frame and is byte-identical every time.
        const swapRB = this.backend.getFormat() === "bgra8unorm";
        for (let row = 0; row < height; row++) {
            const srcStart = row * paddedBytesPerRow;
            const dstStart = row * unpaddedBytesPerRow;
            for (let x = 0, s = srcStart, d = dstStart; x < width; x++, s += 4, d += 4) {
                pixels[d] = mapped[s + (swapRB ? 2 : 0)]!;
                pixels[d + 1] = mapped[s + 1]!;
                pixels[d + 2] = mapped[s + (swapRB ? 0 : 2)]!;
                pixels[d + 3] = 255;
            }
        }
            readback.unmap();
            return { rgba: pixels, width, height };
        } finally {
            try { readback.destroy(); } catch { /* best effort */ }
        }
    }

    async captureFrame(): Promise<Blob> {
        const { rgba, width, height } = await this.readPresentedRgba();

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("Failed to get 2D context for capture.");
        }

        const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageData, 0, 0);
        return canvas.convertToBlob({ type: "image/png" });
    }

    /** [diag] Ring of the last passes submitted (harness passCensus verb). */
    private passRing: Array<{ commands: number; draws: number; target: string; present: boolean; viewport: string }> = [];

    /** Record one submitted pass. A frame is many passes and each carries ONE opening
     *  viewport/target, so a per-draw census cannot say what a pass was actually given —
     *  the two disagreeing is precisely how a stale pass-level snapshot hides. */
    private notePass(
        frame: RenderFrame,
        target: { colorViews: Array<GPUTextureView | null>; backbuffer?: boolean } | null | undefined,
        present: boolean,
        viewport?: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number },
    ): void {
        let draws = 0;
        for (const type of frame.commandTypes) {
            if (type === RenderCommandType.Draw || type === RenderCommandType.DrawIndexed) draws++;
        }
        this.passRing.push({
            commands: frame.commandTypes.length,
            draws,
            target: !target ? "offscreen" : target.backbuffer ? "backbuffer" : "rendertarget",
            present,
            viewport: viewport
                ? `${viewport.x},${viewport.y} ${viewport.width}x${viewport.height} z=${viewport.minZ}..${viewport.maxZ}`
                : "default",
        });
        if (this.passRing.length > 64) this.passRing.shift();
    }

    /** HARNESS passCensus verb: the passes of the last frames, newest last. */
    getPassDebug(): Array<{ commands: number; draws: number; target: string; present: boolean; viewport: string }> {
        return [...this.passRing];
    }

    /**
     * Get the canvas size
     */
    getCanvasSize(): { width: number; height: number } {
        const context = this.backend.getContext()!;
        const canvas = context.canvas as OffscreenCanvas;
        return { width: canvas.width, height: canvas.height };
    }

    /**
     * D3D9 StretchRect GPU blit. A missing endpoint denotes the implicit backbuffer;
     * explicit endpoints are render-target/plain-surface texture views supplied by
     * D3D9Device. The shader path intentionally handles both scaling and format
     * conversion, which copyTextureToTexture cannot do.
     */
    stretchRect(
        src: { view: GPUTextureView; width: number; height: number } | null,
        dst: { view: GPUTextureView; width: number; height: number } | null,
        srcRect: { left: number; top: number; right: number; bottom: number },
        dstRect: { left: number; top: number; right: number; bottom: number },
        linear: boolean,
    ): boolean {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        const format = this.backend.getFormat();
        if (!device || !queue || !format) return false;

        this.ensureOffscreenTarget();
        const source = src ?? {
            view: this.offscreenView!,
            width: this.offscreenSize!.width,
            height: this.offscreenSize!.height,
        };
        const destination = dst ?? {
            view: this.offscreenView!,
            width: this.offscreenSize!.width,
            height: this.offscreenSize!.height,
        };

        if (!this.stretchRectPipeline) {
            this.stretchRectPipeline = new ColorKeyBlitPipeline(device, queue);
        }
        const zero = { r: 0, g: 0, b: 0, a: 0 };
        const encoder = device.createCommandEncoder();
        this.stretchRectPipeline.blit(encoder, {
            srcView: source.view,
            srcWidth: source.width,
            srcHeight: source.height,
            dstView: destination.view,
            dstFormat: format,
            dstWidth: destination.width,
            dstHeight: destination.height,
            srcRect,
            dstRect,
            colorKeyLow: zero,
            colorKeyHigh: zero,
            enableColorKey: false,
            filter: linear ? "linear" : "nearest",
        });
        queue.submit([encoder.finish()]);
        this.noteQuerySubmission();
        return true;
    }

    /** Fill a rectangle of an existing color attachment without disturbing pixels outside it. */
    colorFillRect(
        view: GPUTextureView,
        format: GPUTextureFormat,
        width: number,
        height: number,
        rect: { left: number; top: number; right: number; bottom: number },
        color: GPUColor,
        sampleCount = 1,
    ): boolean {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!device || !queue || width <= 0 || height <= 0) return false;
        const left = Math.max(0, Math.min(width, rect.left | 0));
        const top = Math.max(0, Math.min(height, rect.top | 0));
        const right = Math.max(left, Math.min(width, rect.right | 0));
        const bottom = Math.max(top, Math.min(height, rect.bottom | 0));
        if (right <= left || bottom <= top) return true;

        const fillKey = `${format}:${sampleCount}`;
        let fillPipeline = this.solidFillPipelines.get(fillKey);
        if (!fillPipeline) {
            this.solidFillBindGroupLayout ??= device.createBindGroupLayout({
                entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
            });
            const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.solidFillBindGroupLayout] });
            const module = device.createShaderModule({ code: `
struct FillUniforms { color: vec4<f32> };
@group(0) @binding(0) var<uniform> fill: FillUniforms;
struct VsOut { @builtin(position) position: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VsOut {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var out: VsOut;
    out.position = vec4<f32>(positions[index], 0.0, 1.0);
    return out;
}
@fragment fn fs() -> @location(0) vec4<f32> { return fill.color; }
` });
            fillPipeline = device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format }] },
                primitive: { topology: "triangle-list", cullMode: "none" },
                multisample: { count: sampleCount },
            });
            this.solidFillPipelines.set(fillKey, fillPipeline);
        }
        this.solidFillUniform ??= device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const rgba = Array.isArray(color)
            ? new Float32Array([color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, color[3] ?? 0])
            : new Float32Array([color.r, color.g, color.b, color.a]);
        queue.writeBuffer(this.solidFillUniform!, 0, rgba);
        const bindGroup = device.createBindGroup({
            layout: this.solidFillBindGroupLayout!,
            entries: [{ binding: 0, resource: { buffer: this.solidFillUniform! } }],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
        });
        pass.setPipeline(fillPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setScissorRect(left, top, right - left, bottom - top);
        pass.draw(3);
        pass.end();
        queue.submit([encoder.finish()]);
        this.noteQuerySubmission();
        return true;
    }

    /** ColorFill helper for the implicit D3D9 backbuffer/offscreen presentation target.
     *  Under backbuffer MSAA the fill must land in the MULTISAMPLE image the draws render
     *  into — filling the resolve target instead is overwritten by the next pass's resolve. */
    colorFillBackbufferRect(
        rect: { left: number; top: number; right: number; bottom: number },
        color: GPUColor,
    ): boolean {
        this.ensureOffscreenTarget();
        const size = this.offscreenSize;
        const format = this.backend.getFormat();
        if (!this.offscreenView || !size || !format) return false;
        this.ensureD3d9MsaaTarget();
        const msaa = this.d3d9MsaaTarget;
        if (msaa) {
            return this.colorFillRect(msaa.colorView, msaa.colorFormat, msaa.width, msaa.height,
                rect, color, msaa.sampleCount);
        }
        return this.colorFillRect(this.offscreenView, format, size.width, size.height, rect, color);
    }

    /** Depth attachment paired with the implicit backbuffer, and the sample count a
     *  rectangle-clear pipeline must be built at. Under backbuffer MSAA that is the
     *  multisample depth image the frame's passes actually use. */
    getBackbufferDepthAttachment(): {
        view: GPUTextureView;
        format: GPUTextureFormat;
        width: number;
        height: number;
        sampleCount: number;
    } | null {
        const device = this.backend.getDevice();
        if (!device) return null;
        this.ensureOffscreenTarget();
        this.ensureD3d9MsaaTarget();
        const msaa = this.d3d9MsaaTarget;
        if (msaa) {
            return {
                view: msaa.depthView,
                format: msaa.depthFormat,
                width: msaa.width,
                height: msaa.height,
                sampleCount: msaa.sampleCount,
            };
        }
        if (!this.depthView || !this.offscreenSize) return null;
        return {
            view: this.depthView,
            format: "depth24plus-stencil8",
            width: this.offscreenSize.width,
            height: this.offscreenSize.height,
            sampleCount: 1,
        };
    }

    /**
     * Clear a rectangle of a depth/stencil attachment without touching pixels outside it.
     *
     * WebGPU's attachment `loadOp: "clear"` always covers the whole attachment and ignores
     * scissor.  A fullscreen triangle under a scissor, with depth/stencil load/store, is the
     * faithful lowering for D3D9 Clear(rects, ZBUFFER/STENCIL).  The caller has already
     * flushed the ordinary command frame, so queue submission ordering keeps this operation
     * between the commands that precede and follow the guest Clear call.
     */
    clearDepthStencilRect(
        view: GPUTextureView,
        format: GPUTextureFormat,
        width: number,
        height: number,
        rect: { left: number; top: number; right: number; bottom: number },
        depth: number,
        stencil: number,
        flags: number,
        sampleCount = 1,
    ): boolean {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!device || !queue || width <= 0 || height <= 0) return false;
        const depthWrite = (flags & 2) !== 0; // D3DCLEAR_ZBUFFER
        const stencilWrite = (flags & 4) !== 0; // D3DCLEAR_STENCIL
        if (!depthWrite && !stencilWrite) return false;
        const hasStencil = format === "depth24plus-stencil8" || format === "depth32float-stencil8";
        if (stencilWrite && !hasStencil) return false;
        // D3D9 ignores the Z parameter for a stencil-only clear.  Do not reject a
        // stencil operation because its unused Z argument is NaN/otherwise out of range.
        if (depthWrite && (!Number.isFinite(depth) || depth < 0 || depth > 1)) return false;

        const left = Math.max(0, Math.min(width, rect.left | 0));
        const top = Math.max(0, Math.min(height, rect.top | 0));
        const right = Math.max(left, Math.min(width, rect.right | 0));
        const bottom = Math.max(top, Math.min(height, rect.bottom | 0));
        if (right <= left || bottom <= top) return true;

        const key = `${format}:${depthWrite ? 1 : 0}:${stencilWrite ? 1 : 0}:${sampleCount}`;
        let resources = this.depthStencilClearPipelines.get(key);
        if (!resources) {
            const bindGroupLayout = device.createBindGroupLayout({
                entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
            });
            const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
            const module = device.createShaderModule({ code: `
struct ClearUniforms { depth: f32 };
@group(0) @binding(0) var<uniform> clear: ClearUniforms;
struct VsOut { @builtin(position) position: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VsOut {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var out: VsOut;
    // WebGPU's clip-space depth range is 0..1 (unlike OpenGL's -1..1).  Keep the
    // D3D9 Z value unchanged so the depth attachment receives the requested value.
    out.position = vec4<f32>(positions[index], clear.depth, 1.0);
    return out;
}
@fragment fn fs() {}
` });
            const depthStencil: GPUDepthStencilState = {
                format,
                depthWriteEnabled: depthWrite,
                depthCompare: "always",
            };
            if (hasStencil) {
                depthStencil.stencilFront = {
                    compare: "always",
                    failOp: "keep",
                    depthFailOp: "keep",
                    passOp: stencilWrite ? "replace" : "keep",
                };
                depthStencil.stencilBack = {
                    compare: "always",
                    failOp: "keep",
                    depthFailOp: "keep",
                    passOp: stencilWrite ? "replace" : "keep",
                };
                depthStencil.stencilReadMask = 0xff;
                depthStencil.stencilWriteMask = stencilWrite ? 0xff : 0;
            }
            const pipeline = device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [] },
                primitive: { topology: "triangle-list", cullMode: "none" },
                depthStencil,
                multisample: { count: sampleCount },
            });
            resources = {
                pipeline,
                bindGroupLayout,
                uniform: device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                }),
                hasStencil,
            };
            this.depthStencilClearPipelines.set(key, resources);
        }

        queue.writeBuffer(resources.uniform, 0, new Float32Array([depthWrite ? depth : 0]));
        const bindGroup = device.createBindGroup({
            layout: resources.bindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: resources.uniform } }],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
                view,
                depthLoadOp: "load",
                depthStoreOp: "store",
                ...(hasStencil ? { stencilLoadOp: "load", stencilStoreOp: "store" } : {}),
            },
        });
        pass.setPipeline(resources.pipeline);
        pass.setBindGroup(0, bindGroup);
        if (hasStencil) pass.setStencilReference(stencil & 0xff);
        pass.setScissorRect(left, top, right - left, bottom - top);
        pass.draw(3);
        pass.end();
        queue.submit([encoder.finish()]);
        this.noteQuerySubmission();
        return true;
    }

    private ensureOffscreenTarget(): void {
        const device = this.backend.getDevice()!;
        const format = this.backend.getFormat()!;
        const size = this.getCanvasSize();

        if (this.offscreenTexture &&
            this.offscreenSize &&
            this.offscreenSize.width === size.width &&
            this.offscreenSize.height === size.height) {
            this.ensureD3d9MsaaTarget();
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
            viewFormats: dxSrgbViewFormats(format),
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.offscreenView = this.offscreenTexture.createView();
        const srgbFormat = dxSrgbViewFormat(format);
        this.offscreenSrgbView = srgbFormat
            ? this.offscreenTexture.createView({ format: srgbFormat })
            : null;

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
            format: "depth24plus-stencil8",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthView = this.depthTexture.createView();

        this.offscreenSize = size;
        this.ensureD3d9MsaaTarget();
    }

    /** Lazily pair the single-sample offscreen image with an MSAA color/depth target. */
    private ensureD3d9MsaaTarget(
        depthFormat: GPUTextureFormat = "depth24plus-stencil8",
        externalDepth?: { texture: GPUTexture; view: GPUTextureView },
    ): void {
        if (this.d3d9MsaaSampleCount <= 1 || !this.d3d9MsaaProbe || !this.offscreenTexture || !this.offscreenView) {
            this.d3d9MsaaTarget = null;
            return;
        }
        const device = this.backend.getDevice();
        const format = this.backend.getFormat();
        if (!device || !format || !this.offscreenSize) return;
        if (!this.d3d9MsaaCache) this.d3d9MsaaCache = new D3D9MultisampleTargetCache(device, this.d3d9MsaaProbe);
        this.d3d9MsaaTarget = this.d3d9MsaaCache.acquire({
            key: "d3d9-backbuffer",
            width: this.offscreenSize.width,
            height: this.offscreenSize.height,
            colorFormat: format,
            // Keep the backbuffer MSAA depth attachment identical to the active
            // depth/stencil format used by the D3D9 pipeline state. A mismatch makes
            // WebGPU reject the render pass before any draw reaches the guest frame.
            depthFormat,
            sampleCount: this.d3d9MsaaSampleCount,
            colorViewFormats: dxSrgbViewFormats(format),
            resolveTexture: this.offscreenTexture,
            resolveView: this.offscreenView,
            depthTexture: externalDepth?.texture,
            depthView: externalDepth?.view,
        });
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
                // No pixel-centre offset here (uniformData[2] stays 0, MVP goes in raw) —
                // this path has no packFfpUniforms behind it, so it is legacy-convention.
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
                // One pair per stage the PIPELINE declares. This frame-level bind knows only a
                // single texture (stage 0's); the stages above it get fallbacks — their ops are
                // read from the uniform and a stage the guest did not enable is DISABLE anyway.
                // Under "auto" the count must match the shader exactly, or the whole bind group
                // is invalid and every draw in the pass is dropped.
                const stages = shared ? FFP_MAX_STAGES : Math.max(1, info?.ffpStageCount ?? 1);
                const fallback = this.getFallbackTextureView();
                for (let n = 0; n < stages; n++) {
                    entries.push({ binding: 1 + n * 2, resource: this.getSampler() });
                    entries.push({ binding: 2 + n * 2, resource: (n === 0 ? textureView : null) ?? fallback });
                }
            }

            bindGroup = device.createBindGroup({ layout, entries });
            this.metrics.bindGroupBuilds++;
            this.census.frameLevelBuilds++;
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
        device: GPUDevice,
        fs: FfpDrawState,
    ): void {
        if (this.currentPipelineId === null || !this.ffpArena) return;
        const info = this.pipelineInfo[this.currentPipelineId];
        // Consecutive draws routinely share their entire FFP state (one object split across
        // several materials keeps the same transform, material, lights and stage ops). Writing
        // the same 1.6 KB again would cost a queue.writeBuffer AND force a new bind group on the
        // "auto" path, where the offset is baked into the group. Re-point at the previous block
        // instead — byte-compared, so a block that differs anywhere still gets its own copy.
        const sameBlock = this.sameAsLastBlock(fs);
        const offset = sameBlock
            ? this.ffpArena.lastOffset
            : this.ffpArena.write(fs.block, fs.blockLen);
        // On a hit the remembered copy already IS this block; re-copying it would put the
        // ~1.6 KB memcpy back on the path whose whole point is to avoid one.
        if (!sameBlock) this.rememberBlock(fs);

        const fallbackSampler = this.getSampler();
        const fallbackView = this.getFallbackTextureView();
        // The PIPELINE decides how many stage pairs to bind, not the draw snapshot: the two are
        // computed from the same state and normally agree, but only the pipeline's number
        // matches the layout its shader produced. A stage the snapshot did not fill binds the
        // fallbacks — which the shader ignores anyway, since its op is DISABLE.
        const stageCount = Math.max(1, Math.min(info?.ffpStageCount ?? 1, FFP_MAX_STAGES));

        if (this.ffpDynOffsetEnabled) {
            // Shared explicit layout ⇒ the group depends only on the per-stage (sampler,
            // texture) set; the per-draw block is reached by the dynamic offset. Stages the
            // shader ignores still bind the fallbacks: the layout declares every slot.
            const bindGroup = this.acquireFfpBindGroup(
                fs.samplers, fs.textures, stageCount, fs.stageCount, fallbackSampler, fallbackView,
            );
            this.setBindGroup0(renderPass, bindGroup, offset, -1, 1);
            return;
        }

        // "auto" layout: the bind group encodes the buffer RANGE (no hasDynamicOffset), so its
        // identity includes the arena offset — see acquireFfpAutoBindGroup for why that is
        // still cacheable, and for the reused descriptor the miss path builds from.
        const bindGroup = this.acquireFfpAutoBindGroup(
            device, this.currentPipelineId, offset, Math.max(16, fs.blockLen * 4),
            info?.hasTexture === true ? stageCount : 0, fs, fallbackSampler, fallbackView,
        );
        this.setBindGroup0(renderPass, bindGroup);
    }

    /**
     * Get-or-build the "auto"-layout FFP bind group for one draw, keyed by everything the group
     * is built from: pipeline (which picks the implicit layout), the arena range, and each
     * stage's (sampler, view). `stages` is 0 for a textureless pipeline — under "auto" the
     * entries must match the shader's declared bindings exactly, so a stage pair it never
     * declared cannot be supplied.
     */
    private acquireFfpAutoBindGroup(
        device: GPUDevice,
        pipelineId: number,
        offset: number,
        size: number,
        stages: number,
        fs: FfpDrawState,
        fallbackSampler: GPUSampler,
        fallbackView: GPUTextureView,
    ): GPUBindGroup {
        // FNV-1a over the identity ids; collisions are fine, the bucket is verified below.
        this.census.ffpAutoAcquires++;
        let hash = 0x811c9dc5;
        hash = Math.imul(hash ^ pipelineId, 0x01000193);
        hash = Math.imul(hash ^ offset, 0x01000193);
        hash = Math.imul(hash ^ size, 0x01000193);
        hash = Math.imul(hash ^ stages, 0x01000193);
        for (let n = 0; n < stages; n++) {
            hash = Math.imul(hash ^ this.gpuId(this.stageSampler(fs, n, fallbackSampler)), 0x01000193);
            hash = Math.imul(hash ^ this.gpuId(this.stageView(fs, n, fallbackView)), 0x01000193);
        }
        hash >>>= 0;

        const bucket = this.ffpAutoIndex.get(hash);
        if (bucket !== undefined) {
            for (let i = 0; i < bucket.length; i++) {
                const s = bucket[i]!;
                if (this.ffpAutoPipeline[s] !== pipelineId || this.ffpAutoOffset[s] !== offset
                    || this.ffpAutoSize[s] !== size || this.ffpAutoStages[s] !== stages) continue;
                const base = s * FFP_MAX_STAGES;
                let match = true;
                for (let n = 0; n < stages; n++) {
                    if (this.ffpAutoSampler[base + n] !== this.stageSampler(fs, n, fallbackSampler)
                        || this.ffpAutoView[base + n] !== this.stageView(fs, n, fallbackView)) { match = false; break; }
                }
                if (match) { this.metrics.bindGroupCacheHits++; this.census.ffpAutoHits++; return this.ffpAutoGroup[s]!; }
            }
        }

        // Miss → build from the reused descriptor. createBindGroup validates and copies what it
        // is handed synchronously, so mutating these objects again on the next miss is safe.
        const buf = this.ffpAutoBufferBinding;
        buf.buffer = this.ffpArena!.buffer!;
        buf.offset = offset;
        buf.size = size;
        const entries = this.ffpAutoEntries;
        entries.length = 0;
        entries.push(this.ffpAutoEntry(0, buf));
        for (let n = 0; n < stages; n++) {
            entries.push(this.ffpAutoEntry(1 + n * 2, this.stageSampler(fs, n, fallbackSampler)));
            entries.push(this.ffpAutoEntry(2 + n * 2, this.stageView(fs, n, fallbackView)));
        }
        this.ffpAutoDesc.layout = this.getAutoLayout(pipelineId);
        const bindGroup = device.createBindGroup(this.ffpAutoDesc);
        this.metrics.bindGroupBuilds++;
        this.census.ffpAutoBuilds++;
        if (this.ffpAutoLen >= this.ffpAutoCacheN) this.census.ffpAutoEvictLive++;

        const slot = this.ffpAutoLen < this.ffpAutoCacheN
            ? this.ffpAutoLen++
            : (this.ffpAutoCursor = (this.ffpAutoCursor + 1) % this.ffpAutoCacheN);
        // Round-robin eviction reuses a live slot — unindex it first or the old hash keeps
        // pointing at a slot that now holds a different draw.
        this.unindexFfpAutoSlot(slot);
        this.ffpAutoHash[slot] = hash;
        const b = this.ffpAutoIndex.get(hash);
        if (b === undefined) this.ffpAutoIndex.set(hash, [slot]); else b.push(slot);
        this.ffpAutoPipeline[slot] = pipelineId;
        this.ffpAutoOffset[slot] = offset;
        this.ffpAutoSize[slot] = size;
        this.ffpAutoStages[slot] = stages;
        const base = slot * FFP_MAX_STAGES;
        for (let n = 0; n < stages; n++) {
            this.ffpAutoSampler[base + n] = this.stageSampler(fs, n, fallbackSampler);
            this.ffpAutoView[base + n] = this.stageView(fs, n, fallbackView);
        }
        this.ffpAutoGroup[slot] = bindGroup;
        return bindGroup;
    }

    /** Entry object `i` of the reused pool, re-pointed at `resource`. */
    private ffpAutoEntry(binding: number, resource: GPUBindingResource): GPUBindGroupEntry {
        const i = this.ffpAutoEntries.length;
        let e = this.ffpAutoEntryPool[i];
        if (e === undefined) { e = { binding, resource }; this.ffpAutoEntryPool[i] = e; }
        e.binding = binding;
        e.resource = resource;
        return e;
    }

    /** Drop `slot` from its hash bucket (no-op for a slot that was never indexed). */
    private unindexFfpAutoSlot(slot: number): void {
        const prev = this.ffpAutoHash[slot];
        if (prev === undefined) return;
        const bucket = this.ffpAutoIndex.get(prev);
        if (bucket === undefined) return;
        const at = bucket.indexOf(slot);
        if (at >= 0) bucket.splice(at, 1);
        if (bucket.length === 0) this.ffpAutoIndex.delete(prev);
    }

    /** Forget every cached "auto" FFP bind group (they bind the arena buffer / pipeline ids). */
    private resetFfpAutoCache(): void {
        this.ffpAutoGroup = [];
        this.ffpAutoPipeline = [];
        this.ffpAutoOffset = [];
        this.ffpAutoSize = [];
        this.ffpAutoStages = [];
        this.ffpAutoSampler = new Array(this.ffpAutoCacheN * FFP_MAX_STAGES).fill(null);
        this.ffpAutoView = new Array(this.ffpAutoCacheN * FFP_MAX_STAGES).fill(null);
        this.ffpAutoHash = [];
        this.ffpAutoIndex.clear();
        this.ffpAutoLen = 0;
        this.ffpAutoCursor = 0;
    }

    // Copy of the FFP block the arena last actually uploaded, for the identical-block test.
    // Grown, never reallocated per draw.
    private lastBlock = new Float32Array(0);
    private lastBlockLen = -1;

    /** True when this draw's block is byte-identical to the one already at
     *  `ffpArena.lastOffset` — i.e. the upload and a new bind group can both be skipped. */
    private sameAsLastBlock(fs: FfpDrawState): boolean {
        if (this.ffpArena!.lastOffset < 0 || this.lastBlockLen !== fs.blockLen) return false;
        const a = this.lastBlock, b = fs.block;
        for (let i = 0; i < fs.blockLen; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    private rememberBlock(fs: FfpDrawState): void {
        if (this.lastBlock.length < fs.blockLen) this.lastBlock = new Float32Array(fs.blockLen);
        this.lastBlock.set(fs.block.subarray(0, fs.blockLen));
        this.lastBlockLen = fs.blockLen;
    }

    /** WebGPU's implicit bind-group layout for one pipeline. `getBindGroupLayout` mints a new
     *  JS object per call, so on a per-draw path it is pure allocation — the layout itself is
     *  immutable for the life of the pipeline. */
    private autoLayouts: (GPUBindGroupLayout | null)[] = [];
    private getAutoLayout(pipelineId: number): GPUBindGroupLayout {
        let l = this.autoLayouts[pipelineId];
        if (!l) {
            l = this.pipelines[pipelineId].getBindGroupLayout(0);
            this.autoLayouts[pipelineId] = l;
        }
        return l;
    }

    private stageSampler(fs: FfpDrawState, n: number, fallback: GPUSampler): GPUSampler {
        return (n < fs.stageCount ? fs.samplers[n] : null) ?? fallback;
    }

    private stageView(fs: FfpDrawState, n: number, fallback: GPUTextureView): GPUTextureView {
        return (n < fs.stageCount ? fs.textures[n] : null) ?? fallback;
    }

    private bindProgrammable(
        renderPass: GPURenderPassEncoder,
        ds: ProgrammableDrawState,
    ): void {
        const binding = this.prepareProgrammableBinding(ds);
        this.setBindGroup0(renderPass, binding.bindGroup, binding.vsOffset, binding.psOffset);
    }

    /** Reconcile one arena run's actual VS arena spend against what the estimator reserved
     *  for it. Over-spending is what exhausts the arena mid-frame, and neither the budget nor
     *  the replay can see it alone. */
    private noteArenaRunUniformSpend(cursorAtRunStart: number, budgetBytes: number): void {
        const spent = (this.vsArena?.position() ?? 0) - cursorAtRunStart;
        if (spent > budgetBytes) {
            this.arenaDrainStats.arenaRunBudgetOverruns++;
            if (this.arenaRunInvariantLogs++ < 5) Logger.error(LogCategory.D3D9,
                `[D3D9 arena-run] spent ${spent} VS bytes against a ${budgetBytes} budget`);
        }
    }

    /** Non-throwing twin for the arena-run replay loops. A shortfall the per-run preflight
     *  could not predict (a PS bank the frame estimate never saw) declines the rest of the run
     *  instead of unwinding executeFrame and discarding the frame's queued uploads. */
    private tryBindProgrammable(
        renderPass: GPURenderPassEncoder,
        ds: ProgrammableDrawState,
    ): boolean {
        const binding = this.prepareProgrammableBinding(ds, true);
        if (binding.vsOffset < 0 || binding.psOffset < 0) return false;
        this.setBindGroup0(renderPass, binding.bindGroup, binding.vsOffset, binding.psOffset);
        return true;
    }

    /** Stage current constant bytes and resolve the generation-safe material bind group without
     * emitting encoder commands. Render-bundle preparation uses this every frame so a cached
     * bundle reads fresh contents from the same dynamic offsets. */
    private prepareProgrammableBinding(ds: ProgrammableDrawState, tolerateFull = false): {
        bindGroup: GPUBindGroup;
        /** -1 only when `tolerateFull` and the arena is exhausted. */
        vsOffset: number;
        psOffset: number;
    } {
        // Per-draw: bump constants into arenas unless this exact bank version/length
        // was already written in this frame. Dynamic offsets are frame-local because
        // UniformArena.begin() rewinds each execute() call.
        const vsOffset = this.writeProgrammableConstants(
            this.vsArena!, ds.vsConst, ds.vsLen, ds.vsVersion, true, tolerateFull);
        const psOffset = this.writeProgrammableConstants(
            this.psArena!, ds.psConst, ds.psLen, ds.psVersion, false, tolerateFull);

        const sampler = ds.sampler ?? ((ds.comparisonMask & 1) !== 0
            ? this.getComparisonSampler() : this.getSampler());
        const bindGroup = this.acquireProgBindGroup(
            sampler, ds.textures, ds.samplers, ds.vertexTextures, ds.vertexSamplers,
            ds.cubeMask, ds.comparisonMask, ds.volumeMask, ds.vertexVolumeMask, ds.stageEpoch,
        );
        return { bindGroup, vsOffset, psOffset };
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
        data: Float32Array,
        floatLen: number,
        version: number | undefined,
        vertex: boolean,
        tolerateFull = false,
    ): number {
        if (version !== undefined) {
            const cached = this.findProgConstOffset(version, floatLen, vertex);
            if (cached >= 0) {
                this.metrics.progConstReuseHits++;
                return cached;
            }
        }

        const offset = arena.write(data, floatLen, tolerateFull);
        if (offset < 0) return -1;
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

    private progKeyHash(
        sampler: GPUSampler,
        textures: (GPUTextureView | null)[],
        samplers: (GPUSampler | null)[],
        vertexTextures: (GPUTextureView | null)[],
        vertexSamplers: (GPUSampler | null)[],
        cubeMask: number,
        comparisonMask: number,
        volumeMask: number,
        vertexVolumeMask: number,
    ): number {
        // FNV-1a over the identity ids. Collisions are fine — the bucket is verified by
        // identity below, so the hash only has to be cheap and well-spread.
        let h = 0x811c9dc5;
        h = Math.imul(h ^ this.gpuId(sampler), 0x01000193);
        h = Math.imul(h ^ cubeMask, 0x01000193);
        h = Math.imul(h ^ comparisonMask, 0x01000193);
        h = Math.imul(h ^ volumeMask, 0x01000193);
        h = Math.imul(h ^ vertexVolumeMask, 0x01000193);
        for (let n = 0; n < PROG_BIND.MAX_TEX; n++) {
            h = Math.imul(h ^ this.gpuId(textures[n] ?? null), 0x01000193);
            h = Math.imul(h ^ this.gpuId(samplers[n] ?? null), 0x01000193);
        }
        for (let n = 0; n < VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            h = Math.imul(h ^ this.gpuId(vertexTextures[n] ?? null), 0x01000193);
            h = Math.imul(h ^ this.gpuId(vertexSamplers[n] ?? null), 0x01000193);
        }
        return h >>> 0;
    }

    private acquireProgBindGroup(
        sampler: GPUSampler,
        textures: (GPUTextureView | null)[],
        samplers: (GPUSampler | null)[],
        vertexTextures: (GPUTextureView | null)[],
        vertexSamplers: (GPUSampler | null)[],
        cubeMask: number = 0,
        comparisonMask: number = 0,
        volumeMask: number = 0,
        vertexVolumeMask: number = 0,
        stageEpoch = -1,
    ): GPUBindGroup {
        const MAX = PROG_BIND.MAX_TEX;
        this.census.progAcquires++;
        const prof = this.bgProfiling();
        let t0 = 0;
        if (prof) {
            const c0 = performance.now();
            const c1 = performance.now();
            this.bgProfMs[2]! += c1 - c0; this.bgProfN[2]! += 1;
            t0 = performance.now();
        }
        const fastVerify = this.fastKeyVerifying();
        const fastArmed = this.fastKeyEnabled() || fastVerify;
        const predicted = fastArmed
            && stageEpoch > 0 && stageEpoch === this.fastKeyEpoch
            && sampler === this.fastKeySampler && cubeMask === this.fastKeyCube
            && comparisonMask === this.fastKeyComparison && volumeMask === this.fastKeyVolume
            && vertexVolumeMask === this.fastKeyVertexVolume && this.fastKeyGroup !== null;
        if (predicted && !fastVerify) {
            this.metrics.bindGroupCacheHits++;
            this.census.progHits++;
            this.census.progFastKeyHits++;
            if (prof) { this.bgProfMs[3]! += performance.now() - t0; this.bgProfN[3]! += 1; }
            return this.fastKeyGroup!;
        }
        const hash = this.progKeyHash(sampler, textures, samplers, vertexTextures, vertexSamplers, cubeMask, comparisonMask, volumeMask, vertexVolumeMask);
        const bucket = this.progCacheIndex.get(hash);
        if (bucket !== undefined) {
            for (let i = 0; i < bucket.length; i++) {
                const s = bucket[i]!;
                if (this.progCacheSampler[s] !== sampler || this.progCacheCubeMask[s] !== cubeMask
                    || this.progCacheComparisonMask[s] !== comparisonMask
                    || this.progCacheVolumeMask[s] !== volumeMask
                    || this.progCacheVertexVolumeMask[s] !== vertexVolumeMask) continue;
                const base = s * MAX;
                let match = true;
                for (let n = 0; n < MAX; n++) {
                    if (this.progCacheViews[base + n] !== (textures[n] ?? null)
                        || this.progCacheStageSamplers[base + n] !== (samplers[n] ?? null)) { match = false; break; }
                }
                if (match) {
                    const vertexBase = s * VERTEX_TEXTURE_SAMPLER_COUNT;
                    for (let n = 0; n < VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
                        if (this.progCacheVertexViews[vertexBase + n] !== (vertexTextures[n] ?? null)
                            || this.progCacheVertexSamplers[vertexBase + n] !== (vertexSamplers[n] ?? null)) {
                            match = false;
                            break;
                        }
                    }
                }
                if (match) {
                    this.metrics.bindGroupCacheHits++;
                    this.census.progHits++;
                    if (prof) { this.bgProfMs[0]! += performance.now() - t0; this.bgProfN[0]! += 1; }
                    return this.finishProgAcquire(this.progCacheGroup[s], fastArmed, fastVerify,
                        predicted, stageEpoch, sampler, cubeMask, comparisonMask, volumeMask,
                        vertexVolumeMask);
                }
            }
        }

        // Miss → build a new bind group and insert it (append, then round-robin evict). The
        // layout (and per-stage fallback dimension) is selected by cubeMask so the group stays
        // compatible with the cube-aware pipeline layout.
        const device = this.backend.getDevice()!;
        const { bindGroupLayout } = this.getProgrammableLayout(cubeMask, comparisonMask, volumeMask, vertexVolumeMask);
        const fallback2d = this.getFallbackTextureView();
        const fallbackCube = cubeMask ? this.getFallbackCubeView() : fallback2d;
        const fallbackVolume = volumeMask ? this.getFallbackVolumeView() : fallback2d;
        const fallbackDepth = comparisonMask ? this.getFallbackDepthView() : fallback2d;
        const ordinaryFallbackSampler = (comparisonMask & 1) !== 0 ? this.getSampler() : sampler;
        const entries: GPUBindGroupEntry[] = [
            { binding: PROG_BIND.VS_UNIFORM, resource: { buffer: this.vsArena!.buffer!, offset: 0, size: VS_BIND_SIZE } },
            { binding: PROG_BIND.PS_UNIFORM, resource: { buffer: this.psArena!.buffer!, offset: 0, size: PS_BIND_SIZE } },
            { binding: PROG_BIND.SAMPLER, resource: sampler },
        ];
        for (let n = 0; n < MAX; n++) {
            const fallback = ((volumeMask >> n) & 1) ? fallbackVolume
                : ((comparisonMask >> n) & 1) ? fallbackDepth
                : ((cubeMask >> n) & 1) ? fallbackCube : fallback2d;
            entries.push({ binding: PROG_BIND.TEX_BASE + n, resource: textures[n] ?? fallback });
        }
        for (let n = 1; n < MAX; n++) {
            const fallback = ((comparisonMask >> n) & 1) ? this.getComparisonSampler() : ordinaryFallbackSampler;
            entries.push({ binding: PROG_BIND.FRAGMENT_SAMPLER_BASE + n - 1, resource: samplers[n] ?? fallback });
        }
        // Separate vertex-texture window: API stages 257..260 never alias pixel stages 0..3.
        for (let n = 0; n < VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            entries.push({ binding: VERTEX_TEXTURE_BASE + n, resource: vertexTextures[n] ?? (((vertexVolumeMask >> n) & 1) ? fallbackVolume : fallback2d) });
            entries.push({ binding: VERTEX_SAMPLER_BASE + n, resource: vertexSamplers[n] ?? ordinaryFallbackSampler });
        }
        const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries });
        this.metrics.bindGroupBuilds++;
        this.census.progBuilds++;
        if (this.censusSeenProgHashes.has(hash)) this.census.progRebuiltHash++;
        else if (this.censusSeenProgHashes.size < CENSUS_SEEN_HASH_MAX) this.censusSeenProgHashes.add(hash);
        else this.censusSeenSaturated = true;

        const evicting = this.progCacheLen >= this.progCacheN;
        if (evicting) this.census.progEvictLive++;
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
        this.progCacheComparisonMask[slot] = comparisonMask;
        this.progCacheVolumeMask[slot] = volumeMask;
        this.progCacheVertexVolumeMask[slot] = vertexVolumeMask;
        const base = slot * MAX;
        for (let n = 0; n < MAX; n++) {
            this.progCacheViews[base + n] = textures[n] ?? null;
            this.progCacheStageSamplers[base + n] = samplers[n] ?? null;
        }
        const vertexBase = slot * VERTEX_TEXTURE_SAMPLER_COUNT;
        for (let n = 0; n < VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            this.progCacheVertexViews[vertexBase + n] = vertexTextures[n] ?? null;
            this.progCacheVertexSamplers[vertexBase + n] = vertexSamplers[n] ?? null;
        }
        this.progCacheGroup[slot] = bindGroup;
        if (prof) { this.bgProfMs[1]! += performance.now() - t0; this.bgProfN[1]! += 1; }
        return this.finishProgAcquire(bindGroup, fastArmed, fastVerify, predicted, stageEpoch,
            sampler, cubeMask, comparisonMask, volumeMask, vertexVolumeMask);
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

    private getComparisonSampler(): GPUSampler {
        if (!this.comparisonSampler) {
            this.comparisonSampler = this.backend.getDevice()!.createSampler({
                compare: "less-equal",
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge",
            });
        }
        return this.comparisonSampler;
    }

    private getFallbackDepthView(): GPUTextureView {
        if (!this.fallbackDepthView) {
            this.fallbackDepthTexture = this.backend.getDevice()!.createTexture({
                size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                format: "depth32float",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.fallbackDepthView = this.fallbackDepthTexture.createView();
        }
        return this.fallbackDepthView;
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

    /** 1×1×1 white fallback for a texture_3d binding. A 2-D fallback is not
     * compatible with a 3-D bind-group layout, even when the shader never samples it. */
    private getFallbackVolumeView(): GPUTextureView {
        if (!this.fallbackVolumeView) {
            const device = this.backend.getDevice()!;
            this.fallbackVolumeTexture = device.createTexture({
                size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.backend.getQueue()!.writeTexture(
                { texture: this.fallbackVolumeTexture },
                new Uint8Array([255, 255, 255, 255]),
                { bytesPerRow: 4, rowsPerImage: 1 },
                { width: 1, height: 1, depthOrArrayLayers: 1 },
            );
            this.fallbackVolumeView = this.fallbackVolumeTexture.createView({ dimension: "3d" });
        }
        return this.fallbackVolumeView;
    }
}

function transposeMatrix(m: Float32Array): Float32Array {
    return m; // Unused, just cleanup
}
