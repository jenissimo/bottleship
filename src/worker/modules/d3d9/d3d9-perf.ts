/**
 * D3D9 API call-mix + skip counters for dbg.d3d9Perf().
 * Zero-alloc hot path: plain number fields, no Maps on the setter path.
 */

export interface D3D9PerfSnapshot {
    api: Record<string, number>;
    skip: Record<string, number>;
    backend: Record<string, number>;
    stateTracker: Record<string, number>;
    /** Draws the device dropped, keyed by reason. Empty is the healthy state. */
    droppedDraws: Record<string, number>;
    /** FFP state a draw needed and the shader does not implement. Empty is the healthy state. */
    ffpUnimplemented: Record<string, number>;
    /** Full D3DTSS_COLOROP/ALPHAOP distribution — the context ffpUnimplemented needs. */
    ffpOps: Record<string, number>;
    /** Has SetMaterial ever been called? If not, the default material is what lit every draw. */
    materialEverSet: boolean;
    wbuf: { hits: number; outTrapHits: number; coalescedSkips: number; registered: number } | null;
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
 * twice in one frame serves BOTH draws whatever the last upload wrote. Each upload snapshots
 * the WHOLE guest-side buffer, which is what makes the three re-upload cases differ:
 *
 * - after D3DLOCK_NOOVERWRITE the later snapshot still carries the earlier bytes unchanged,
 *   so the earlier draw reads what it asked for (`overwriteNoOverwrite`, benign);
 * - after D3DLOCK_DISCARD it does not, and a fresh ring slot is what keeps the earlier draw
 *   correct (`overwriteRenamed`);
 * - after a PLAIN lock it does not either, and nothing covers it (`overwriteUnhandled`) —
 *   the earlier draw silently renders the later object's vertices.
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
    "bindGroupCacheHits",
    "progConstWrites",
    "progConstReuseHits",
    "bindStateElided",
    "drawCalls",
    "clearCalls",
    "progPipelineCacheHits",
    "progPipelineCacheMisses",
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
 * FFP state a draw ASKED for that the D3D9 fixed-function shader does not implement.
 * `stubs()` names an unimplemented ENTRY POINT; this names unimplemented fixed-function
 * STATE, which is invisible by comparison — the draw records, nothing is dropped and no
 * WebGPU error fires, so only the counter distinguishes it from a correctly-drawn frame.
 */
const ffpUnimplemented: Record<string, number> = {};

export function d3d9PerfFfpUnimplemented(feature: string): void {
    ffpUnimplemented[feature] = (ffpUnimplemented[feature] ?? 0) + 1;
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
    bindGroupCacheHits: 0,
    progConstWrites: 0,
    progConstReuseHits: 0,
    bindStateElided: 0,
    drawCalls: 0,
    clearCalls: 0,
    progPipelineCacheHits: 0,
    progPipelineCacheMisses: 0,
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
export function d3d9DropDraw(reason: string): number {
    droppedDraws[reason] = (droppedDraws[reason] ?? 0) + 1;
    return 0;
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

export function resetD3D9Perf(): void {
    for (const k of API_KEYS) api[k] = 0;
    for (const k of SKIP_KEYS) skip[k] = 0;
    for (const k of BACKEND_KEYS) backend[k] = 0;
    for (const k in stateBlock) (stateBlock as Record<string, number>)[k] = 0;
    for (const k in droppedDraws) delete droppedDraws[k];
    for (const k in ffpUnimplemented) delete ffpUnimplemented[k];
    ffpColorOps.fill(0);
    ffpAlphaOps.fill(0);
    materialEverSet = false;
    for (const k in buffers) (buffers as unknown as Record<string, number>)[k] = 0;
    stateBlockByType = {};
    stateBlockOps = {};
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
        ffpUnimplemented: { ...ffpUnimplemented },
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
