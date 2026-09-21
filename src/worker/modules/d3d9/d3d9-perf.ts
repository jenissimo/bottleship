/**
 * D3D9 API call-mix + skip counters for dbg.d3d9Perf().
 * Zero-alloc hot path: plain number fields, no Maps on the setter path.
 */
import {
    getDxFormatSupportCensus,
    resetDxFormatSupportCensus,
    getDxCreationRefusals,
} from "../../backends/webgpu/shared/dx-format-support";
import { Logger, LogCategory } from "../../core/logger";

export interface D3D9ArenaRunReconcile {
    producerRuns: number;
    executorCommands: number;
    runDelta: number;
    producerPairs: number;
    executorExpectedPairs: number;
    executorExecutedPairs: number;
    expectedDelta: number;
    executedDelta: number;
    apiDrawIndexed: number;
    backendDrawIndexed: number;
    apiDrawDelta: number;
    /**
     * Indexed API draws that provably never became an encoded drawIndexed AND said so: the
     * device-side fate ledger (`indexedDrawUnencoded`) plus the executor's own declines. An
     * indexed draw legitimately leaves this path — a fan is rewound into a non-indexed draw,
     * a lost device drops the frame — so `apiDrawIndexed === backendDrawIndexed` is the wrong
     * invariant. The right one is that every difference is NAMED.
     */
    apiDrawUnencoded: number;
    /** apiDrawIndexed - backendDrawIndexed - apiDrawUnencoded. Non-zero means draws went
     *  missing between the API and the encoder with nothing counting them. Must be 0. */
    apiDrawUnaccounted: number;
    healthy: boolean;
}

function sumRecord(src: Record<string, number> | undefined): number {
    if (!src) return 0;
    let total = 0;
    for (const key in src) total += src[key] ?? 0;
    return total;
}

export function reconcileD3D9ArenaRuns(
    wbuf: { pairRuns: number; pairs: number },
    api: Record<string, number>,
    backend: Record<string, number>,
    /** Device-side fates of an indexed API draw that did not reach the encoder, by reason.
     *  Defaults to this module's live ledger so a caller cannot reconcile against a
     *  half-supplied one; tests pass their own. */
    indexedUnencoded: Record<string, number> = indexedDrawUnencoded,
): D3D9ArenaRunReconcile {
    const producerRuns = wbuf.pairRuns;
    const executorCommands = backend.arenaRunCommands ?? 0;
    const producerPairs = wbuf.pairs;
    const executorExpectedPairs = backend.arenaRunExpectedPairs ?? 0;
    const executorExecutedPairs = backend.arenaRunExecutedPairs ?? 0;
    const apiDrawIndexed = api.drawIndexedPrimitive ?? 0;
    const backendDrawIndexed = backend.drawIndexedCalls ?? 0;
    // Pairs a discarded/aborted frame never handed to the encoder. They were recorded (so the
    // producer counted them) and never expected (execute() returned first), which is the one
    // way the pair identity can break without a single run misbehaving.
    const discardedPairs = backend.arenaRunPairsFrameDiscarded ?? 0;
    const runDelta = executorCommands - producerRuns;
    const expectedDelta = executorExpectedPairs + discardedPairs - producerPairs;
    const executedDelta = executorExecutedPairs - executorExpectedPairs;
    const apiDrawDelta = backendDrawIndexed - apiDrawIndexed;
    // An arena run whose command was seen but whose pairs were not all encoded reports the
    // shortfall itself; it is the same lost work expressed in logical draws.
    const arenaLogicalShortfall = Math.max(0,
        (backend.arenaRunExpectedLogicalDraws ?? 0) - (backend.arenaRunEncodedLogicalDraws ?? 0));
    const apiDrawUnencoded = sumRecord(indexedUnencoded)
        + (backend.drawIndexedSkippedNoPipeline ?? 0)
        + (backend.drawIndexedSkippedValidator ?? 0)
        + (backend.drawIndexedFrameDiscarded ?? 0)
        + arenaLogicalShortfall;
    const apiDrawUnaccounted = apiDrawIndexed - backendDrawIndexed - apiDrawUnencoded;
    return {
        producerRuns, executorCommands, runDelta,
        producerPairs, executorExpectedPairs, executorExecutedPairs,
        expectedDelta, executedDelta,
        apiDrawIndexed, backendDrawIndexed, apiDrawDelta,
        apiDrawUnencoded, apiDrawUnaccounted,
        healthy: runDelta === 0 && expectedDelta === 0 && executedDelta === 0
            && apiDrawUnaccounted === 0,
    };
}

export interface D3D9PerfSnapshot {
    api: Record<string, number>;
    skip: Record<string, number>;
    backend: Record<string, number>;
    stateTracker: Record<string, number>;
    /** Draws the device dropped, keyed by reason. Empty is the healthy state. */
    droppedDraws: Record<string, number>;
    /** Batched counter increments refused as out-of-domain. Empty is the healthy state. */
    counterRejections: Record<string, number>;
    /**
     * Fate of every indexed API draw that did NOT produce an encoded indexed draw, by reason.
     * `apiDrawIndexed - backendDrawIndexed` is not a defect on its own — the device rewinds a
     * fan into a non-indexed draw, drops a draw it cannot represent, or loses a frame with the
     * GPU device — but an UNNAMED difference is. `unclassified` is the honest bucket: it means
     * this ledger itself failed to attribute the draw, and is never 0 by construction.
     */
    indexedDrawUnencoded: Record<string, number>;
    /** Query lifecycle ledger; filled by dbg.d3d9Perf from the query module + managers. */
    queries?: Record<string, number> | null;
    /**
     * Reset refusals, keyed by the exact precondition that failed (with its counts spelled
     * into the key). A refused Reset is INVISIBLE otherwise: the app latches "device lost",
     * every later frame is discarded before a single draw, and the screen simply holds the
     * last image — no GPU error, no dropped draw, nothing in the frame log. Empty is the
     * healthy state.
     */
    resetRefusals: Record<string, number>;
    /** FFP state a draw needed and the shader does not implement. Empty is the healthy state. */
    ffpUnimplemented: Record<string, number>;
    /** Fixed-function pipelines BUILT, keyed by the sampler dimensions their shader declared
     *  ("2d" / "cube:<mask>"). The counterpart to ffpUnimplemented's cubeTextureStage*: a
     *  scene with env-mapping and no cube pipelines here never reached the cube path, and
     *  nothing else distinguishes that from a scene that simply binds no cube. */
    ffpSamplerDims: Record<string, number>;
    /** SetTexture outcome census — see d3d9NoteTextureBind. */
    textureBindOutcome: Record<string, number>;
    /** FFP state the shader lowers deliberately but without a native WebGPU equivalent. */
    approximated: Record<string, number>;
    /** Resource CONSTRUCTORS that refused a format, keyed `${reason}:${format}`. The other
     *  half of formatSupport: that one says what we declined to advertise, this says what we
     *  declined to build. A non-empty entry whose format the query ADVERTISES is a lie the
     *  caller cannot detect — it holds a NULL resource. Empty is the healthy state. */
    creationRefusals: Record<string, number>;
    /** FourCC capability probes refused because no decoder/storage path is shipped. */
    formatSupport: {
        refusedFormat: Record<string, number>;
        refusedFourCC: Record<string, number>;
    };
    /** Full D3DTSS_COLOROP/ALPHAOP distribution — the context ffpUnimplemented needs. */
    ffpOps: Record<string, number>;
    /** Has SetMaterial ever been called? If not, the default material is what lit every draw. */
    materialEverSet: boolean;
    wbuf: {
        hits: number; outTrapHits: number; coalescedSkips: number; barrierEntries: number;
        pairRuns: number; pairs: number; pairFallbacks: number; registered: number;
    } | null;
    /** Same-window producer/executor reconciliation for arena-authoritative indexed runs. */
    arenaRunReconcile?: D3D9ArenaRunReconcile | null;
    /** Guest-side setter-shadow skip counters per shadowed setter (filled by dbg.d3d9Perf). */
    setterShadow?: Record<string, number> | null;
    /** State-block type/coverage distribution. liveBlocks filled by dbg.d3d9Perf. */
    stateBlocks: D3D9StateBlockPerf;
    /** VB/IB lock-flag mix and the per-frame buffer-reuse census. */
    buffers: D3D9BufferPerf;
    devices: number;
}

/**
 * The frame's queued buffer uploads all run before its render pass, so a GPU buffer written
 * twice in one frame serves BOTH draws whatever the last upload wrote. An upload carries the
 * range the guest rewrote (see buffer-upload.ts), which is what makes the three cases differ:
 *
 * - after D3DLOCK_NOOVERWRITE the guest promised not to touch bytes an earlier draw reads,
 *   so the earlier draw reads what it asked for (`overwriteNoOverwrite`, benign);
 * - after D3DLOCK_DISCARD that promise is off, and a fresh ring slot is what keeps the
 *   earlier draw correct (`overwriteRenamed`);
 * - after a PLAIN lock it is off too and nothing covers it (`overwriteUnhandled`) — the
 *   earlier draw silently renders the later object's vertices wherever the ranges overlap.
 *
 * `lockDiscard` vs `lockPlain` is what says which of those a fix must target: keying renaming
 * on DISCARD cannot help a guest that re-fills with plain locks.
 */
export interface D3D9BufferPerf {
    lockDiscard: number;
    lockNoOverwrite: number;
    lockPlain: number;
    uploads: number;
    overwriteRenamed: number;
    overwriteNoOverwrite: number;
    overwriteUnhandled: number;
    /** Highest number of uploads any single buffer took in one frame. */
    maxUploadsPerBufferPerFrame: number;
    /**
     * Indexed draws whose vertex range (base+min+num, per the app's own promise) falls
     * outside the bound vertex buffer. WebGPU cannot validate this for an indexed draw, so
     * robust access hands the shader ZEROS instead of raising an error: every vertex lands
     * on the origin, the triangle is degenerate, and the surface is simply absent — with no
     * warning, no dropped draw and a perfectly correct texture bound. Must be 0.
     */
    indexedVertexRangeOOB: number;
    /** Worst overshoot in bytes, for sizing the miss. */
    indexedVertexRangeOOBMaxBytes: number;
    /** The most recent refused draw, spelled out. A count alone cannot say WHETHER the
     *  binding is too small or the stride is wrong, and those need opposite fixes. */
    lastVertexRangeReject: string;
    /**
     * Indexed draws whose INDEX range runs past the bound index buffer — a separate counter
     * from the vertex one because the failure mode is the opposite: WebGPU does raise this,
     * and the rejection invalidates the whole frame's command buffer rather than one draw.
     * Must be 0.
     */
    indexRangeOOB: number;
    /** Worst overshoot in bytes, for sizing the miss. */
    indexRangeOOBMaxBytes: number;
}

export interface D3D9StateBlockPerf {
    creates: number;
    applies: number;
    captures: number;
    /** Applies/Captures served by the arena block slot (WASM diff/memcpy path). */
    wasmApplies: number;
    wasmCaptures: number;
    coverableBlocks: number;
    fallbackBlocks: number;
    coverableApplies: number;
    fallbackApplies: number;
    coverableCaptures: number;
    fallbackCaptures: number;
    maxEntries: number;
    maxVsConstRanges: number;
    maxPsConstRanges: number;
    /** blockType → count (0 = Begin/End, 1 = D3DSBT_ALL, 2 = PIXELSTATE, 3 = VERTEXSTATE). */
    byBlockType: Record<string, number>;
    /** Entry-op histogram summed over created blocks. */
    entryOps: Record<string, number>;
    liveBlocks: number;
}

const API_KEYS = [
    "setRenderState",
    "setTransform",
    "setFVF",
    "setSamplerState",
    "setTexture",
    "setTextureStageState",
    "setStreamSource",
    "setIndices",
    "setVertexShader",
    "setPixelShader",
    "setVertexDeclaration",
    "setVertexShaderConstantF",
    "setPixelShaderConstantF",
    "setMaterial",
    "setLight",
    "lightEnable",
    "drawPrimitive",
    "drawIndexedPrimitive",
    "drawPrimitiveUP",
    "drawIndexedPrimitiveUP",
    "clear",
    "present",
] as const;

const SKIP_KEYS = [
    "setRenderState",
    "setTransform",
    "setFVF",
    "setSamplerState",
    "setTexture",
    "setTextureStageState",
    "setStreamSource",
    "setIndices",
    "setVertexShader",
    "setPixelShader",
    "setVertexDeclaration",
    "vsConstantUnchanged",
    "psConstantUnchanged",
] as const;

const BACKEND_KEYS = [
    "pipelineCacheHits",
    "pipelineCacheMisses",
    "pipelineSets",
    "bindGroupSets",
    "bindGroupSetSkips",
    "bindGroupSetSameGroup",
    "bindGroupCacheHits",
    "bindGroupBuilds",
    "progConstWrites",
    "progConstReuseHits",
    "bindStateElided",
    "drawCalls",
    "clearCalls",
    "progPipelineCacheHits",
    "progPipelineCacheMisses",
    // Draw-state capture memo + the work its misses do. The constant-bank content hash is the
    // hottest JS leaf in a race trace (4.7% of busy), and whether that is worth attacking
    // depends on the MISS rate and on how many words a miss walks — neither was counted.
    "captureMemoHits",
    "captureMemoMisses",
    "captureHashedWords",
    // Non-zero means a constant-bank write bypassed the block-hash invalidation, i.e. a draw
    // was keyed by a STALE content hash. Any non-zero value invalidates a timing arm.
    "captureBankHashMismatch",
    // Consecutive-draw runs sharing (pipeline, bindState): the upper bound on batching.
    "batchRuns",
    "batchRunDraws",
    "batchRunsGe4",
    // Draws where only the shader constants differ from the previous draw.
    "captureConstOnly",
    "captureConstOnlyHits",
    "captureConstOnlyChecked",
    "captureConstOnlyMismatch",
    // Stage-window resolution: a miss re-resolves 16 texture views and 16 samplers for a bank
    // in which typically one stage changed. Hits/misses size that loop independently of the
    // constant copy the capture memo also covers.
    "stageWindowHits",
    "stageWindowMisses",
    // Inside a stage-window miss: stages reused from their own cached inputs vs re-resolved.
    "stageReuse",
    "stageResolve",
    // Non-zero means a reused stage view differs from the long resolution: a silent wrong
    // texture. Any non-zero value invalidates a timing arm and the feature.
    "stageReuseMismatch",
] as const;
type ApiKey = typeof API_KEYS[number];
type SkipKey = typeof SKIP_KEYS[number];
type BackendKey = typeof BACKEND_KEYS[number];

const api: Record<ApiKey, number> = {
    setRenderState: 0,
    setTransform: 0,
    setFVF: 0,
    setSamplerState: 0,
    setTexture: 0,
    setTextureStageState: 0,
    setStreamSource: 0,
    setIndices: 0,
    setVertexShader: 0,
    setPixelShader: 0,
    setVertexDeclaration: 0,
    setVertexShaderConstantF: 0,
    setPixelShaderConstantF: 0,
    setMaterial: 0,
    setLight: 0,
    lightEnable: 0,
    drawPrimitive: 0,
    drawIndexedPrimitive: 0,
    drawPrimitiveUP: 0,
    drawIndexedPrimitiveUP: 0,
    clear: 0,
    present: 0,
};

const skip: Record<SkipKey, number> = {
    setRenderState: 0,
    setTransform: 0,
    setFVF: 0,
    setSamplerState: 0,
    setTexture: 0,
    setTextureStageState: 0,
    setStreamSource: 0,
    setIndices: 0,
    setVertexShader: 0,
    setPixelShader: 0,
    setVertexDeclaration: 0,
    vsConstantUnchanged: 0,
    psConstantUnchanged: 0,
};

/** reason -> count; keys are free-form so a new early-out needs no schema edit. */
const droppedDraws: Record<string, number> = {};

/**
 * What each SetTexture actually DID: "bound" (a new texture reached the stage), "redundant"
 * (already there), "unbound" (the guest passed NULL), "unknownPointer" (a pointer this store
 * does not know — the stage is unbound and the call fails).
 *
 * `skip.setTexture` collapses the last three into one number, and a title binding nothing at
 * all then looks exactly like one binding efficiently: RA3 reported 160 096 calls and 160 096
 * skips, which is either perfect redundancy elision or a renderer sampling no textures, and
 * nothing in the census could say which.
 */
const textureBindOutcome: Record<string, number> = {};

export function d3d9NoteTextureBind(outcome: "bound" | "redundant" | "unbound" | "unknownPointer"): void {
    textureBindOutcome[outcome] = (textureBindOutcome[outcome] ?? 0) + 1;
}

/** API key -> refused batched increments (non-integer/negative counts). Empty is healthy. */
const counterRejections: Record<string, number> = {};

/** reason -> indexed API draws that never became an encoded indexed draw. See the snapshot. */
const indexedDrawUnencoded: Record<string, number> = {};

export function d3d9NoteIndexedDrawUnencoded(reason: string, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) {
        counterRejections[`indexedDrawUnencoded:${reason}`] =
            (counterRejections[`indexedDrawUnencoded:${reason}`] ?? 0) + 1;
        return;
    }
    indexedDrawUnencoded[reason] = (indexedDrawUnencoded[reason] ?? 0) + count;
}

/**
 * FFP state a draw ASKED for that the D3D9 fixed-function shader does not implement.
 * `stubs()` names an unimplemented ENTRY POINT; this names unimplemented fixed-function
 * STATE, which is invisible by comparison — the draw records, nothing is dropped and no
 * WebGPU error fires, so only the counter distinguishes it from a correctly-drawn frame.
 */
const ffpUnimplemented: Record<string, number> = {};

export function d3d9PerfFfpUnimplemented(feature: string): void {
    ffpUnimplemented[feature] = (ffpUnimplemented[feature] ?? 0) + 1;
}

/** One FFP pipeline built, named by the sampler dimensions baked into its shader. */
const ffpSamplerDims: Record<string, number> = {};

export function d3d9NoteFfpSamplerDims(cubeMask: number): void {
    const key = cubeMask === 0 ? "2d" : `cube:${(cubeMask >>> 0).toString(16)}`;
    ffpSamplerDims[key] = (ffpSamplerDims[key] ?? 0) + 1;
}

/** Record shader-side semantic lowerings whose result is intentionally approximate. */
const approximated: Record<string, number> = {};

export function d3d9PerfApproximation(feature: string): void {
    approximated[feature] = (approximated[feature] ?? 0) + 1;
}

/**
 * D3DTSS_COLOROP/ALPHAOP histogram over EVERY draw, not just the ops we cannot do: an
 * "unimplemented" count of zero only means something next to the distribution it was read
 * from, which is what shows whether the title uses solely implemented ops or the census is
 * reading the wrong state.
 *
 * Counted into fixed arrays (op is a D3DTEXTUREOP, 0..31) because this runs per stage per
 * draw; the names exist only in the snapshot.
 */
const FFP_OP_SLOTS = 32;
const ffpColorOps = new Int32Array(FFP_OP_SLOTS);
const ffpAlphaOps = new Int32Array(FFP_OP_SLOTS);

export function d3d9PerfFfpOp(kind: "color" | "alpha", op: number): void {
    if (op < 0 || op >= FFP_OP_SLOTS) return;
    const bins = kind === "color" ? ffpColorOps : ffpAlphaOps;
    bins[op]++;
}

function ffpOpsSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let op = 0; op < FFP_OP_SLOTS; op++) {
        if (ffpColorOps[op]) out[`color${op}`] = ffpColorOps[op]!;
        if (ffpAlphaOps[op]) out[`alpha${op}`] = ffpAlphaOps[op]!;
    }
    return out;
}

/** Whether the guest has ever called SetMaterial. False means every lit draw so far used the
 *  device's initial material, which makes its value load-bearing rather than incidental. */
let materialEverSet = false;
export function d3d9PerfMaterialSet(): void { materialEverSet = true; }

const backend: Record<BackendKey, number> = {
    pipelineCacheHits: 0,
    pipelineCacheMisses: 0,
    pipelineSets: 0,
    bindGroupSets: 0,
    bindGroupSetSkips: 0,
    bindGroupSetSameGroup: 0,
    bindGroupCacheHits: 0,
    bindGroupBuilds: 0,
    progConstWrites: 0,
    progConstReuseHits: 0,
    bindStateElided: 0,
    drawCalls: 0,
    clearCalls: 0,
    progPipelineCacheHits: 0,
    progPipelineCacheMisses: 0,
    captureMemoHits: 0,
    captureMemoMisses: 0,
    captureHashedWords: 0,
    captureBankHashMismatch: 0,
    batchRuns: 0,
    batchRunDraws: 0,
    batchRunsGe4: 0,
    captureConstOnly: 0,
    captureConstOnlyHits: 0,
    captureConstOnlyChecked: 0,
    captureConstOnlyMismatch: 0,
    stageWindowHits: 0,
    stageWindowMisses: 0,
    stageReuse: 0,
    stageResolve: 0,
    stageReuseMismatch: 0,
};

const stateBlock = {
    creates: 0,
    applies: 0,
    captures: 0,
    wasmApplies: 0,
    wasmCaptures: 0,
    coverableBlocks: 0,
    fallbackBlocks: 0,
    coverableApplies: 0,
    fallbackApplies: 0,
    coverableCaptures: 0,
    fallbackCaptures: 0,
    maxEntries: 0,
    maxVsConstRanges: 0,
    maxPsConstRanges: 0,
};
let stateBlockByType: Record<string, number> = {};
let stateBlockOps: Record<string, number> = {};

export function d3d9PerfStateBlockCreated(
    blockType: number,
    entryCount: number,
    coverable: boolean,
    opCounts: Record<string, number>,
    vsConstRanges: number,
    psConstRanges: number,
): void {
    stateBlock.creates++;
    if (coverable) stateBlock.coverableBlocks++;
    else stateBlock.fallbackBlocks++;
    if (entryCount > stateBlock.maxEntries) stateBlock.maxEntries = entryCount;
    if (vsConstRanges > stateBlock.maxVsConstRanges) stateBlock.maxVsConstRanges = vsConstRanges;
    if (psConstRanges > stateBlock.maxPsConstRanges) stateBlock.maxPsConstRanges = psConstRanges;
    stateBlockByType[blockType] = (stateBlockByType[blockType] ?? 0) + 1;
    for (const op in opCounts) {
        stateBlockOps[op] = (stateBlockOps[op] ?? 0) + opCounts[op]!;
    }
}

export function d3d9PerfStateBlockApply(coverable: boolean): void {
    stateBlock.applies++;
    if (coverable) stateBlock.coverableApplies++;
    else stateBlock.fallbackApplies++;
}

export function d3d9PerfStateBlockCapture(coverable: boolean): void {
    stateBlock.captures++;
    if (coverable) stateBlock.coverableCaptures++;
    else stateBlock.fallbackCaptures++;
}

export function d3d9PerfStateBlockWasmApply(): void {
    stateBlock.wasmApplies++;
}

export function d3d9PerfStateBlockWasmCapture(): void {
    stateBlock.wasmCaptures++;
}

export function d3d9PerfInc(key: ApiKey): void {
    api[key]++;
}

/** Account for an already-validated fused API run without replaying the hot counter
 *  function once per logical call. The caller still publishes the exact logical count. */
export function d3d9PerfAdd(key: ApiKey, count: number): void {
    // A fused run's count comes from guest-supplied arena data. A NaN poisons the counter
    // for the whole session and a negative one hides work that really happened — both make
    // the reconcile read healthy while the ledger is wrong. Refusing silently would do the
    // same, so the refusal is itself counted.
    if (!Number.isSafeInteger(count) || count < 0) {
        counterRejections[key] = (counterRejections[key] ?? 0) + 1;
        return;
    }
    api[key] += count;
}

export function d3d9PerfSkip(key: SkipKey): void {
    skip[key]++;
}

/**
 * Census of draws the device DROPPED, by reason — the counterpart to the api/skip counters,
 * which only ever count work that happened.
 *
 * A dropped draw is silent by construction: no warning, no log line, no fault. It surfaces as
 * geometry that simply is not there, which reads as a shading or texture bug and sends you
 * hunting through render state. (Indexed triangle strips were dropped outright for the life of
 * the D3D9 backend and showed up as "flat grey surfaces" — the fog seen through the hole.)
 *
 * Returns 0 so a call site reads `return d3d9DropDraw("reason")` and cannot count and return
 * as two separable steps that drift apart.
 */
/** Record why a Reset was refused. The reason string carries the failing numbers, because
 *  "some precondition" is not actionable and this path is exercised once per game. */
const resetRefusals: Record<string, number> = {};

export function d3d9NoteResetRefusal(reason: string): void {
    resetRefusals[reason] = (resetRefusals[reason] ?? 0) + 1;
}

/** Reasons already announced during the current frame. A counter nobody reads is not a
 *  diagnostic: a whole set of geometry can go missing without a single log line, so the
 *  FIRST drop of each new reason in a frame is announced. One line per reason per frame
 *  keeps a per-draw failure out of the log firehose while still naming it every frame it
 *  happens. */
const warnedDropReasons = new Set<string>();

/** Total drops, in any reason. Lets a caller ask "did a drop happen inside this call?" without
 *  re-summing the reason map or teaching every early-out site about a second counter. */
let droppedDrawTotal = 0;
export function d3d9DroppedDrawTotal(): number { return droppedDrawTotal; }

export function d3d9DropDraw(reason: string): number {
    const seen = (droppedDraws[reason] ?? 0) + 1;
    droppedDraws[reason] = seen;
    droppedDrawTotal++;
    if (!warnedDropReasons.has(reason)) {
        warnedDropReasons.add(reason);
        Logger.warn(LogCategory.D3D9,
            `[D3D9] draw dropped: ${reason} (${seen} this session) — geometry is missing from this frame`);
    }
    return 0;
}

/** Frame boundary for the drop announcer: a reason that persists frame after frame keeps
 *  reporting itself once per frame rather than falling silent after the first one. */
export function d3d9ResetDropDrawWarnings(): void {
    warnedDropReasons.clear();
}

const buffers: D3D9BufferPerf = {
    lockDiscard: 0,
    lockNoOverwrite: 0,
    lockPlain: 0,
    uploads: 0,
    overwriteRenamed: 0,
    overwriteNoOverwrite: 0,
    overwriteUnhandled: 0,
    maxUploadsPerBufferPerFrame: 0,
    indexedVertexRangeOOB: 0,
    indexedVertexRangeOOBMaxBytes: 0,
    lastVertexRangeReject: "",
    indexRangeOOB: 0,
    indexRangeOOBMaxBytes: 0,
};

export function d3d9PerfVertexRangeOOB(overshootBytes: number, detail = ""): void {
    buffers.indexedVertexRangeOOB++;
    if (overshootBytes > buffers.indexedVertexRangeOOBMaxBytes) {
        buffers.indexedVertexRangeOOBMaxBytes = overshootBytes;
    }
    if (detail) buffers.lastVertexRangeReject = detail;
}

export function d3d9PerfIndexRangeOOB(overshootBytes: number): void {
    buffers.indexRangeOOB++;
    if (overshootBytes > buffers.indexRangeOOBMaxBytes) {
        buffers.indexRangeOOBMaxBytes = overshootBytes;
    }
}

export function d3d9PerfBufferLock(flags: number): void {
    if (flags & 0x2000) buffers.lockDiscard++;
    else if (flags & 0x1000) buffers.lockNoOverwrite++;
    else buffers.lockPlain++;
}

export function d3d9PerfBufferUpload(
    renamed: boolean,
    overwrote: boolean,
    lastLockFlags: number,
    uploadsThisFrame: number,
): void {
    buffers.uploads++;
    if (overwrote) {
        if (renamed) buffers.overwriteRenamed++;
        else if (lastLockFlags & 0x1000) buffers.overwriteNoOverwrite++;
        else buffers.overwriteUnhandled++;
    }
    if (uploadsThisFrame > buffers.maxUploadsPerBufferPerFrame) {
        buffers.maxUploadsPerBufferPerFrame = uploadsThisFrame;
    }
}

export function d3d9PerfBackendInc(key: BackendKey): void {
    backend[key]++;
}

/** Bulk form for a counter that measures WORK rather than events (e.g. words walked). A NaN or
 *  a negative would poison the counter for the session, so both are refused rather than added. */
export function d3d9PerfBackendAdd(key: BackendKey, count: number): void {
    if (!Number.isFinite(count) || count < 0) {
        counterRejections[key] = (counterRejections[key] ?? 0) + 1;
        return;
    }
    backend[key] += count;
}

/* ── Render-boundary census (render-worker plan §8.0, censuses A and C) ────────────────
 *
 * Two quantities the existing counters cannot answer, both needed BEFORE the render-worker
 * is built: how often a GPU round trip parks the guest per presented frame, and how many
 * dirty bytes cross to the GPU per frame. Both are per-FRAME questions — a session total
 * hides the shape, and the shape is what the stop condition is about — so the counts live
 * in a ring indexed by present boundary, not in scalars.
 *
 * The ledger is leaf: it records, it never judges. Every refusal and every ratio lives in
 * harness/cmds/render-boundary.ts, where it is a pure function with a test.
 */

/** A GPU round trip that PARKS the guest thread (CLAUDE.md §3.5). A non-blocking pump (the
 *  glide mirror) is deliberately not in this list: merging the two makes a per-present
 *  fence budget unfalsifiable. */
export const RENDER_FENCE_KINDS = [
    "presentPermit",
    "textureReadback",
    "backbufferReadback",
    "rtRgbaReadback",
    "queryBatch",
] as const;
export type RenderFenceKind = typeof RENDER_FENCE_KINDS[number];

/**
 * Dirty bytes by kind, split on the one axis the plan's §5 cost model turns on: whether the
 * bytes were ALREADY staged into a per-frame copy before reaching the queue. The recorder's
 * queueUpload already copies (render-frame.ts), so for that class an off-thread staging copy
 * is zero marginal cost; a direct write out of the shadow buffer is where §5 would add one.
 */
export const STAGED_BYTE_KINDS = [
    "vertexIndexCopied",
    "vertexIndexDirect",
    "texture",
    "constants",
] as const;
export type StagedByteKind = typeof STAGED_BYTE_KINDS[number];

const RB_RING = 512;
const RB_F = RENDER_FENCE_KINDS.length;
const RB_B = STAGED_BYTE_KINDS.length;
const RB_STRIDE = RB_F + RB_B;

const rbFenceIdx: Record<string, number> = {};
RENDER_FENCE_KINDS.forEach((k, i) => { rbFenceIdx[k] = i; });
const rbByteIdx: Record<string, number> = {};
STAGED_BYTE_KINDS.forEach((k, i) => { rbByteIdx[k] = RB_F + i; });

const rbRing = new Float64Array(RB_RING * RB_STRIDE);
const rbRingSerial = new Float64Array(RB_RING);
const rbTotals = new Float64Array(RB_STRIDE);
/** Slot accumulating the frame that has not reached its present boundary yet. */
let rbSlot = 0;
/** Present boundaries seen since the last reset. Frames older than RB_RING are gone from the
 *  ring but still in rbTotals, which is what lets the report say a distribution is partial
 *  instead of quietly describing the tail as the whole window. */
let rbFrames = 0;
let rbQueriesServed = 0;
let rbEpoch = 0;
let rbLedgerBytes = 0;
let rbLedgerWrites = 0;
let rbQueueBytes = 0;
let rbQueueWrites = 0;
let rbAuditArmed = false;

type QueueWriteFn = (...args: never[]) => unknown;
let rbPatchedWriteBuffer: QueueWriteFn | null = null;
let rbPatchedWriteTexture: QueueWriteFn | null = null;

/** The bypass that proves the byte census can fail: when set to a kind name, notes of that
 *  kind are dropped on the floor. With the queue audit armed, the report must then say the
 *  byte section is unusable rather than print a smaller, plausible number. */
function rbSuppressedKind(): string {
    const v = (globalThis as { __noRenderBoundaryNote?: unknown }).__noRenderBoundaryNote;
    return typeof v === "string" ? v : "";
}

export function d3d9NoteFence(kind: RenderFenceKind, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) {
        counterRejections[`fence:${kind}`] = (counterRejections[`fence:${kind}`] ?? 0) + 1;
        return;
    }
    if (rbSuppressedKind() === kind) return;
    const i = rbFenceIdx[kind];
    if (i === undefined) return;
    rbRing[rbSlot * RB_STRIDE + i]! += count;
    rbTotals[i]! += count;
}

/** Occlusion queries a single resolve fence answered — the fence is per batch, so the count
 *  of queries it served is the only thing that says whether one fence is cheap or dear. */
export function d3d9NoteFenceQueriesServed(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
        counterRejections["fence:queriesServed"] = (counterRejections["fence:queriesServed"] ?? 0) + 1;
        return;
    }
    rbQueriesServed += count;
}

export function d3d9NoteStagedBytes(kind: StagedByteKind, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
        counterRejections[`stagedBytes:${kind}`] = (counterRejections[`stagedBytes:${kind}`] ?? 0) + 1;
        return;
    }
    if (bytes === 0) return;
    if (rbSuppressedKind() === kind) return;
    const i = rbByteIdx[kind];
    if (i === undefined) return;
    rbRing[rbSlot * RB_STRIDE + i]! += bytes;
    rbTotals[i]! += bytes;
    rbLedgerBytes += bytes;
    rbLedgerWrites++;
}

/** Close the current frame at a present boundary and open the next one. */
export function d3d9NoteRenderFrameBoundary(presentSerial: number): void {
    rbRingSerial[rbSlot] = Number.isFinite(presentSerial) ? presentSerial : -1;
    rbFrames++;
    rbSlot = (rbSlot + 1) % RB_RING;
    const base = rbSlot * RB_STRIDE;
    for (let i = 0; i < RB_STRIDE; i++) rbRing[base + i] = 0;
    rbRingSerial[rbSlot] = -1;
}

/** Called by the armed queue shim for every byte WebGPU actually received. Independent of
 *  the classified notes above; the two are compared, never reconciled. */
export function d3d9NoteQueueWrite(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    rbQueueBytes += bytes;
    rbQueueWrites++;
}

/**
 * Arm/disarm the queue-byte audit. Patches GPUQueue.prototype, because the classified notes
 * sit at ~30 call sites and a site added later would otherwise go uncounted in silence —
 * which is the whole failure mode this census exists to avoid. Default OFF and identity-cost
 * while off; an armed shim must never be left on across a timing arm.
 *
 * Returns whether a shim is installed. `false` with `on === true` means the environment has
 * no GPUQueue (a unit test, a headless worker) — the caller reports that, it is not a no-op.
 */
export function setRenderBoundaryQueueAudit(on: boolean): boolean {
    const proto = (globalThis as unknown as { GPUQueue?: { prototype: Record<string, unknown> } })
        .GPUQueue?.prototype;
    if (on) {
        rbAuditArmed = true;
        if (!proto || rbPatchedWriteBuffer) return !!rbPatchedWriteBuffer;
        const origBuffer = proto["writeBuffer"] as QueueWriteFn;
        const origTexture = proto["writeTexture"] as QueueWriteFn;
        if (typeof origBuffer !== "function" || typeof origTexture !== "function") return false;
        rbPatchedWriteBuffer = origBuffer;
        rbPatchedWriteTexture = origTexture;
        proto["writeBuffer"] = function (this: unknown, ...args: unknown[]) {
            d3d9NoteQueueWrite(queueWriteBufferBytes(args));
            return (origBuffer as unknown as (...a: unknown[]) => unknown).apply(this, args);
        };
        proto["writeTexture"] = function (this: unknown, ...args: unknown[]) {
            d3d9NoteQueueWrite(byteLengthOfSource(args[1]));
            return (origTexture as unknown as (...a: unknown[]) => unknown).apply(this, args);
        };
        return true;
    }
    rbAuditArmed = false;
    if (proto && rbPatchedWriteBuffer && rbPatchedWriteTexture) {
        proto["writeBuffer"] = rbPatchedWriteBuffer;
        proto["writeTexture"] = rbPatchedWriteTexture;
    }
    rbPatchedWriteBuffer = null;
    rbPatchedWriteTexture = null;
    return false;
}

function byteLengthOfSource(src: unknown): number {
    const v = src as { byteLength?: number; BYTES_PER_ELEMENT?: number } | undefined;
    return typeof v?.byteLength === "number" ? v.byteLength : 0;
}

/** writeBuffer(buffer, offset, data, dataOffset?, size?) — dataOffset/size are in ELEMENTS
 *  for a typed array and in bytes for an ArrayBuffer, which is why this cannot be one rule. */
function queueWriteBufferBytes(args: unknown[]): number {
    const data = args[2] as { byteLength?: number; BYTES_PER_ELEMENT?: number } | undefined;
    const size = args[4];
    if (typeof size === "number") {
        const el = typeof data?.BYTES_PER_ELEMENT === "number" ? data.BYTES_PER_ELEMENT : 1;
        return size * el;
    }
    const total = byteLengthOfSource(data);
    const off = args[3];
    if (typeof off === "number") {
        const el = typeof data?.BYTES_PER_ELEMENT === "number" ? data.BYTES_PER_ELEMENT : 1;
        return Math.max(0, total - off * el);
    }
    return total;
}

export interface RenderBoundaryLedger {
    atMs: number;
    /** Bumped by resetRenderBoundaryCensus(). A window spanning two epochs is a fragment. */
    epoch: number;
    /** Present boundaries closed since the reset. */
    frames: number;
    ringCapacity: number;
    /** Global frame index of `perFrame[0]`; frames below it have left the ring. */
    frameIndexBase: number;
    /** Chronological, one row per retained CLOSED frame, RENDER_FENCE_KINDS then
     *  STAGED_BYTE_KINDS. */
    perFrame: number[][];
    /** Present serial recorded at each retained frame's boundary. */
    serials: number[];
    totals: Record<string, number>;
    queriesServed: number;
    ledgerBytes: number;
    ledgerWrites: number;
    audit: { armed: boolean; installed: boolean; queueBytes: number; queueWrites: number };
    /** Echo of __noRenderBoundaryNote so a gagged site cannot read as a clean census. */
    suppressedKind: string;
}

export function readRenderBoundaryLedger(): RenderBoundaryLedger {
    const retained = Math.min(rbFrames, RB_RING - 1);
    const perFrame: number[][] = [];
    const serials: number[] = [];
    for (let n = retained; n >= 1; n--) {
        const slot = (rbSlot - n + RB_RING * 2) % RB_RING;
        const base = slot * RB_STRIDE;
        const row = new Array<number>(RB_STRIDE);
        for (let i = 0; i < RB_STRIDE; i++) row[i] = rbRing[base + i]!;
        perFrame.push(row);
        serials.push(rbRingSerial[slot]!);
    }
    const totals: Record<string, number> = {};
    RENDER_FENCE_KINDS.forEach((k, i) => { totals[k] = rbTotals[i]!; });
    STAGED_BYTE_KINDS.forEach((k, i) => { totals[k] = rbTotals[RB_F + i]!; });
    return {
        atMs: performance.now(),
        epoch: rbEpoch,
        frames: rbFrames,
        ringCapacity: RB_RING - 1,
        frameIndexBase: rbFrames - retained,
        perFrame,
        serials,
        totals,
        queriesServed: rbQueriesServed,
        ledgerBytes: rbLedgerBytes,
        ledgerWrites: rbLedgerWrites,
        audit: {
            armed: rbAuditArmed,
            installed: rbPatchedWriteBuffer !== null,
            queueBytes: rbQueueBytes,
            queueWrites: rbQueueWrites,
        },
        suppressedKind: rbSuppressedKind(),
    };
}

export function resetRenderBoundaryCensus(): void {
    rbRing.fill(0);
    rbRingSerial.fill(-1);
    rbTotals.fill(0);
    rbSlot = 0;
    rbFrames = 0;
    rbQueriesServed = 0;
    rbLedgerBytes = 0;
    rbLedgerWrites = 0;
    rbQueueBytes = 0;
    rbQueueWrites = 0;
    rbEpoch++;
}

export function resetD3D9Perf(): void {
    for (const k of API_KEYS) api[k] = 0;
    for (const k of SKIP_KEYS) skip[k] = 0;
    for (const k of BACKEND_KEYS) backend[k] = 0;
    for (const k in stateBlock) (stateBlock as Record<string, number>)[k] = 0;
    for (const k in droppedDraws) delete droppedDraws[k];
    droppedDrawTotal = 0;
    for (const k in indexedDrawUnencoded) delete indexedDrawUnencoded[k];
    warnedDropReasons.clear();
    for (const k in counterRejections) delete counterRejections[k];
    for (const k in resetRefusals) delete resetRefusals[k];
    for (const k in ffpUnimplemented) delete ffpUnimplemented[k];
    for (const k in ffpSamplerDims) delete ffpSamplerDims[k];
    for (const k in textureBindOutcome) delete textureBindOutcome[k];
    for (const k in approximated) delete approximated[k];
    resetDxFormatSupportCensus();
    ffpColorOps.fill(0);
    ffpAlphaOps.fill(0);
    materialEverSet = false;
    for (const k in buffers) (buffers as unknown as Record<string, number>)[k] = 0;
    stateBlockByType = {};
    stateBlockOps = {};
    // Same reset boundary, so a render-boundary window can never span a d3d9Perf reset
    // without saying so — the epoch bump is what makes the fragment visible.
    resetRenderBoundaryCensus();
}

function pickRecord<T extends string>(src: Record<T, number>, keys: readonly T[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = src[k];
    return out;
}

export function getD3D9PerfSnapshot(): D3D9PerfSnapshot {
    return {
        api: pickRecord(api, API_KEYS),
        skip: pickRecord(skip, SKIP_KEYS),
        backend: pickRecord(backend, BACKEND_KEYS),
        stateTracker: {},
        droppedDraws: { ...droppedDraws },
        counterRejections: { ...counterRejections },
        indexedDrawUnencoded: { ...indexedDrawUnencoded },
        resetRefusals: { ...resetRefusals },
        ffpUnimplemented: { ...ffpUnimplemented },
        ffpSamplerDims: { ...ffpSamplerDims },
        textureBindOutcome: { ...textureBindOutcome },
        approximated: { ...approximated },
        creationRefusals: getDxCreationRefusals(),
        formatSupport: getDxFormatSupportCensus(),
        ffpOps: ffpOpsSnapshot(),
        materialEverSet,
        wbuf: null,
        stateBlocks: {
            ...stateBlock,
            byBlockType: { ...stateBlockByType },
            entryOps: { ...stateBlockOps },
            liveBlocks: 0,
        },
        buffers: { ...buffers },
        devices: 0,
    };
}
