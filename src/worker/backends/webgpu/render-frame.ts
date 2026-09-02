import { PROG_BIND } from "./d3d9/shader";
import { FFP_MAX_STAGES } from "./d3d9/ffp-lighting";

/** Stage slots a pooled FfpDrawState carries — the FFP cap (d3d9 advertises 8 blend stages). */
const FFP_STAGE_SLOTS = FFP_MAX_STAGES;

export const enum RenderCommandType {
    SetPipeline = 1,
    SetVertexBuffer = 2,
    Draw = 3,
    SetIndexBuffer = 4,
    DrawIndexed = 5,
    BindProgrammable = 6,
    BindFfp = 7,
    SetScissor = 8,
    BeginOcclusionQuery = 9,
    EndOcclusionQuery = 10,
    TimestampQuery = 11,
    SetStencilReference = 12,
    SetBlendConstant = 13,
    SetViewport = 14,
    /** One host command replays an arena-resident alternating constant/indexed-draw run. */
    DrawIndexedArenaRun = 15,
}

/** Per-draw fixed-function state: a snapshot of the FFP uniform block (the guest
 *  changes transforms/stage-ops/TFACTOR between draws) + the stage-0 texture view. */
export interface FfpDrawState {
    block: Float32Array;
    blockLen: number;
    /** Per-texture-stage views + samplers (index = D3D stage). Entries past `stageCount`
     *  are stale and must not be read; the executor binds fallbacks for them. A null entry
     *  inside the range means nothing was bound at that stage. */
    textures: (GPUTextureView | null)[];
    samplers: (GPUSampler | null)[];
    /** Texture blend stages this draw's pipeline was generated for (>= 1). */
    stageCount: number;
}

export type RenderClear = {
    color: GPUColor;
    depth: number;
    stencil: number;
    flags: number;
};

/**
 * Link between a WASM-arena draw and the already-resolved RenderFrame draw.
 *
 * The arena deliberately stores only compact numeric state.  GPU object identity,
 * generation-safe buffer references, samplers and the complete programmable constant
 * snapshot remain owned by RenderFrame.  This link lets the executor use the arena's
 * pipeline identity/command arguments without reconstructing resources from stale store
 * indices.
 */
export interface ArenaDrawBinding {
    /** Index of the corresponding Draw/DrawIndexed command in this frame. */
    frameDrawCommand: number;
    /** Arena command index containing CMD_DRAW(_UP/_INDEXED[_UP]). */
    arenaDrawCommand: number;
    /** Compact arena pipeline bucket captured for diagnostics/identity selection. */
    arenaPipelineKey: number;
    /** Bump-arena offset of the corresponding CMD_SET_PIPELINE state capture. */
    arenaStateOffset: number;
    /** The exact 16-word identity written before recordDraw*. */
    /** Captured arena ABI identity; typed as ArrayLike so Uint32Array is zero-copy. */
    pipelineIdentity?: ArrayLike<number>;
    /** Collision-safe canonical identity used by the executor's pipeline registry. */
    pipelineIdentityKey?: string;
    /** Real executor pipeline id resolved from the full canonical identity. */
    pipelineId: number;
    /** RenderFrame programmable state slot for this draw. */
    bindStateIndex?: number;
    /** Arena command kind; executor uses arena arguments only for non-UP rows. */
    arenaCommandType: number;
}

export interface ArenaIndexedRun {
    /** Inclusive/exclusive arena command-row range produced by one atomic Rust transaction. */
    arenaCommandStart: number;
    arenaCommandEnd: number;
    /** Generation-safe resources and non-float-bank uniform tails shared by the run. */
    bindStateIndex: number;
    /** Resolved host pipeline; the run reasserts it instead of trusting recorder/executor memo parity. */
    pipelineId: number;
    expectedPairCount: number;
    /** Sparse-VS Compact MegaRun descriptor in the WASM bump arena; -1 for legacy runs. */
    compactDescriptorOffset: number;
    /** Sparse VS constant payload for a first draw separated from the exact pair run by
     * non-pipeline-breaking setters. It executes before descriptor instance zero. */
    prefixVsBits?: Uint32Array;
    prefixStartFloat: number;
}

/**
 * Per-draw uniform + texture snapshot for the programmable (VS/PS) path.
 * Captured at draw-record time so each draw replays with its own constants and
 * bound textures, rather than a single frame-wide snapshot.
 */
export interface ProgrammableDrawState {
    /** Reused VS constant scratch (grows on demand); only the first `vsLen` floats are valid. */
    vsConst: Float32Array;
    /** Uint32 view over vsConst for bit-exact copy/hash without per-draw view allocation. */
    vsBits: Uint32Array;
    vsLen: number;
    /** Frame-local content key for the valid prefix. Undefined means "not cacheable". */
    vsVersion?: number;
    /** Reused PS constant scratch (grows on demand); only the first `psLen` floats are valid. */
    psConst: Float32Array;
    /** Uint32 view over psConst for bit-exact copy/hash without per-draw view allocation. */
    psBits: Uint32Array;
    psLen: number;
    /** Frame-local content key for the valid prefix. Undefined means "not cacheable". */
    psVersion?: number;
    /** Bound texture views per stage (length PROG_BIND.MAX_TEX; null → fallback). Reused in place. */
    textures: (GPUTextureView | null)[];
    /** Resolved GPU sampler for the shared programmable sampler binding.
     *  null → executor falls back to its default. */
    sampler: GPUSampler | null;
    /** Per-stage samplers for the programmable-VS / fixed-function-pixel hybrid path. */
    samplers: (GPUSampler | null)[];
    /** D3DVERTEXTEXTURESAMPLER0..3 views, mapped from API stages 257..260. */
    vertexTextures: (GPUTextureView | null)[];
    /** Resolved sampler state for API stages 257..260. */
    vertexSamplers: (GPUSampler | null)[];
    /** Bitmask of cube-sampler stages for this draw (matches the pipeline's bind-group layout). */
    cubeMask: number;
    /** Bitmask of fragment stages bound as 3-D volume textures. */
    volumeMask: number;
    /** Bitmask of vertex-texture stages bound as 3-D volume textures. */
    vertexVolumeMask: number;
    /** Bitmask of depth-texture stages using sampler_comparison. */
    comparisonMask: number;
    /**
     * Which resolution of the device's stage window filled `textures`/`samplers`/`sampler`.
     * Two draws sharing it hold the SAME view and sampler objects by construction, which is
     * what lets the executor skip re-deriving a 41-object bind-group key. -1 means "not
     * stamped": a consumer must fall back to comparing the objects themselves.
     */
    stageEpoch: number;
}

export class RenderFrame {
    hasClear = false;
    clear: RenderClear = { color: { r: 0, g: 0, b: 0, a: 1 }, depth: 1.0, stencil: 0, flags: 0 };

    commandTypes: number[] = [];
    commandA: number[] = [];
    commandB: number[] = [];
    commandC: number[] = [];
    /** Vertex-buffer slot for SetVertexBuffer commands (= D3D stream number); 0 otherwise. */
    commandD: number[] = [];

    bufferRefs: GPUBuffer[] = [];
    uploadBuffers: GPUBuffer[] = [];
    uploadData: Uint8Array[] = [];
    /** Destination byte offset per queued upload — a partial upload writes only the range
     *  the guest rewrote, so the flush cannot assume 0. Always a multiple of 4. */
    uploadOffsets: number[] = [];
    temporaryBuffers: GPUBuffer[] = [];
    /** Buffers acquired from a reuse pool (DrawPrimitiveUP vertex data). Unlike
     *  temporaryBuffers, these are NOT destroyed at frame end — the owner returns
     *  them to its pool after submit (see D3D9Device.submitFrame). */
    pooledBuffers: GPUBuffer[] = [];
    /** Pooled programmable draw-state slots. Length is the high-water mark; the
     *  live count for THIS frame is `drawStateCount`. Slots persist across frames
     *  so steady-state capture allocates nothing (see nextDrawState). */
    drawStates: ProgrammableDrawState[] = [];
    drawStateCount = 0;
    /** Pooled per-draw FFP state slots (same lifetime discipline as drawStates). */
    ffpStates: FfpDrawState[] = [];
    ffpStateCount = 0;
    /** Arena links for programmable draws recorded in this frame. */
    arenaDrawBindings: ArenaDrawBinding[] = [];
    arenaIndexedRuns: ArenaIndexedRun[] = [];
    /** Flat x,y,width,height,minZ,maxZ per SetViewport command; commandA holds the base index. */
    viewportData: number[] = [];

    reset(): void {
        this.hasClear = false;
        // A clear descriptor belongs to the submitted frame; do not carry its plane mask into
        // the next pooled RenderFrame.
        this.clear.flags = 0;
        this.commandTypes.length = 0;
        this.commandA.length = 0;
        this.commandB.length = 0;
        this.commandC.length = 0;
        this.commandD.length = 0;
        this.bufferRefs.length = 0;
        this.uploadBuffers.length = 0;
        this.uploadData.length = 0;
        this.uploadOffsets.length = 0;
        this.temporaryBuffers.length = 0;
        this.pooledBuffers.length = 0;
        // Rewind the draw-state pool without dropping the slots (keeps their
        // constant scratch + texture arrays for reuse). Stale texture refs in
        // slots beyond drawStateCount are overwritten on reuse by nextDrawState's filler.
        this.drawStateCount = 0;
        this.ffpStateCount = 0;
        this.arenaDrawBindings.length = 0;
        this.arenaIndexedRuns.length = 0;
        this.viewportData.length = 0;
    }

    setClear(color: GPUColor, depth: number, stencil: number, flags: number): void {
        this.clear.color = color;
        this.clear.depth = depth;
        this.clear.stencil = stencil >>> 0;
        // A frame carries the clear for ONE submission. Do not merge this with an earlier clear:
        // if a draw was recorded between the two API calls, OR-ing the flags would move the
        // later clear before that draw when the frame's hoisted loadOps are consumed. The D3D9
        // device flushes the pending frame before recording the next Clear; this assignment keeps
        // the descriptor faithful to that submission boundary.
        this.clear.flags = flags >>> 0;
        this.hasClear = true;
    }

    pushSetPipeline(pipelineId: number): void {
        this.commandTypes.push(RenderCommandType.SetPipeline);
        this.commandA.push(pipelineId);
        this.commandB.push(0);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    pushSetVertexBuffer(buffer: GPUBuffer, offset: number, size: number, slot = 0): void {
        const index = this.bufferRefs.length;
        this.bufferRefs.push(buffer);
        this.commandTypes.push(RenderCommandType.SetVertexBuffer);
        this.commandA.push(index);
        this.commandB.push(offset);
        this.commandC.push(size);
        this.commandD.push(slot);
    }

    /** commandC carries the guest's SetStreamSource stride for slot 0 — diagnostic only, but
     *  it is the one number the encoder cannot recover, and a refused draw needs BOTH it and
     *  the pipeline's arrayStride to say which of the two is wrong. */
    pushDraw(vertexCount: number, startVertex: number, guestStride = 0, instanceCount = 1): void {
        this.commandTypes.push(RenderCommandType.Draw);
        this.commandA.push(vertexCount);
        this.commandB.push(startVertex);
        this.commandC.push(guestStride);
        this.commandD.push(Math.max(0, instanceCount | 0));
    }

    /** Set the raster scissor for the following draw. Coordinates are already clamped to the
     * active render target by the D3D9 device; keeping them in the compact command lanes avoids
     * allocating a per-draw object in the frame recorder. */
    pushSetScissor(left: number, top: number, width: number, height: number): void {
        this.commandTypes.push(RenderCommandType.SetScissor);
        this.commandA.push(left | 0);
        this.commandB.push(top | 0);
        this.commandC.push(width | 0);
        this.commandD.push(height | 0);
    }

    /** Set the viewport for the following draws. D3D9 viewport is per-draw state while a
     * WebGPU pass carries one default, so a guest change inside a pass has to be a command:
     * a pass-level snapshot takes whatever the viewport happened to be at flush time. */
    pushSetViewport(x: number, y: number, width: number, height: number, minZ: number, maxZ: number): void {
        const base = this.viewportData.length;
        this.viewportData.push(x, y, width, height, minZ, maxZ);
        this.commandTypes.push(RenderCommandType.SetViewport);
        this.commandA.push(base);
        this.commandB.push(0); this.commandC.push(0); this.commandD.push(0);
    }

    pushBeginOcclusionQuery(queryPtr: number): void {
        this.commandTypes.push(RenderCommandType.BeginOcclusionQuery);
        this.commandA.push(queryPtr >>> 0);
        this.commandB.push(0); this.commandC.push(0); this.commandD.push(0);
    }

    pushEndOcclusionQuery(queryPtr: number): void {
        this.commandTypes.push(RenderCommandType.EndOcclusionQuery);
        this.commandA.push(queryPtr >>> 0);
        this.commandB.push(0); this.commandC.push(0); this.commandD.push(0);
    }

    pushTimestampQuery(queryPtr: number): void {
        this.commandTypes.push(RenderCommandType.TimestampQuery);
        this.commandA.push(queryPtr >>> 0);
        this.commandB.push(0); this.commandC.push(0); this.commandD.push(0);
    }

    pushSetStencilReference(reference: number): void {
        this.commandTypes.push(RenderCommandType.SetStencilReference);
        this.commandA.push(reference & 0xff);
        this.commandB.push(0); this.commandC.push(0); this.commandD.push(0);
    }

    pushSetBlendConstant(color: number): void {
        this.commandTypes.push(RenderCommandType.SetBlendConstant);
        this.commandA.push(color >>> 0);
        this.commandB.push(0); this.commandC.push(0); this.commandD.push(0);
    }

    pushSetIndexBuffer(buffer: GPUBuffer, format: "uint16" | "uint32"): void {
        const index = this.bufferRefs.length;
        this.bufferRefs.push(buffer);
        this.commandTypes.push(RenderCommandType.SetIndexBuffer);
        this.commandA.push(index);
        this.commandB.push(format === "uint16" ? 16 : 32);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    /** `instanceCount` is D3D9 hardware instancing (SetStreamSourceFreq); 1 = ordinary draw. */
    pushDrawIndexed(indexCount: number, startIndex: number, baseVertex: number, instanceCount = 1): void {
        this.commandTypes.push(RenderCommandType.DrawIndexed);
        this.commandA.push(indexCount);
        this.commandB.push(startIndex);
        this.commandC.push(baseVertex);
        this.commandD.push(instanceCount);
    }

    pushDrawIndexedArenaRun(
        arenaCommandStart: number, arenaCommandEnd: number, bindStateIndex: number,
        pipelineId: number, expectedPairCount: number, compactDescriptorOffset = -1,
        prefixVsBits?: Uint32Array, prefixStartFloat = 0,
    ): void {
        const runIndex = this.arenaIndexedRuns.length;
        this.arenaIndexedRuns.push({
            arenaCommandStart, arenaCommandEnd, bindStateIndex, pipelineId, expectedPairCount,
            compactDescriptorOffset, prefixVsBits, prefixStartFloat,
        });
        this.commandTypes.push(RenderCommandType.DrawIndexedArenaRun);
        this.commandA.push(runIndex);
        this.commandB.push(0);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    /**
     * Acquire a pooled programmable draw-state slot, sized for `vsLen`/`psLen`
     * floats of constants. Slots persist across frames (reset() only rewinds the
     * count), so steady-state capture does zero per-draw allocation: the constant
     * scratch buffers grow on demand and the texture array is reused in place.
     * The caller fills the returned slot; its frame-local index is `drawStateCount`
     * read BEFORE this call (or drawStateCount-1 after).
     */
    nextDrawState(vsLen: number, psLen: number): ProgrammableDrawState {
        let s = this.drawStates[this.drawStateCount];
        if (!s) {
            const vsConst = new Float32Array(Math.max(4, vsLen));
            const psConst = new Float32Array(Math.max(4, psLen));
            s = {
                vsConst,
                vsBits: new Uint32Array(vsConst.buffer),
                vsLen: 0,
                vsVersion: undefined,
                psConst,
                psBits: new Uint32Array(psConst.buffer),
                psLen: 0,
                psVersion: undefined,
                textures: new Array(PROG_BIND.MAX_TEX).fill(null),
                sampler: null,
                samplers: new Array(PROG_BIND.MAX_TEX).fill(null),
                vertexTextures: new Array(4).fill(null),
                vertexSamplers: new Array(4).fill(null),
                cubeMask: 0,
                volumeMask: 0,
                vertexVolumeMask: 0,
                comparisonMask: 0,
                stageEpoch: -1,
            };
            this.drawStates[this.drawStateCount] = s;
        }
        if (s.vsConst.length < vsLen) {
            s.vsConst = new Float32Array(vsLen);
            s.vsBits = new Uint32Array(s.vsConst.buffer);
        }
        if (s.psConst.length < psLen) {
            s.psConst = new Float32Array(psLen);
            s.psBits = new Uint32Array(s.psConst.buffer);
        }
        s.vsLen = vsLen;
        s.psLen = psLen;
        s.vsVersion = undefined;
        s.psVersion = undefined;
        this.drawStateCount++;
        return s;
    }

    /** Undo the most recent nextDrawState() (identical-consecutive-state elision,
     *  wasm-resident-d3d-command-path Phase C). The slot stays pooled and is handed
     *  out again on the next capture — the earlier, still-referenced slots are untouched. */
    rollbackDrawState(): void {
        if (this.drawStateCount > 0) this.drawStateCount--;
    }

    pushBindProgrammable(stateIndex: number): void {
        this.commandTypes.push(RenderCommandType.BindProgrammable);
        this.commandA.push(stateIndex);
        this.commandB.push(0);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    /** Acquire a pooled FFP draw-state slot; caller fills block/texture.
     *  Returns the slot's frame-local index. */
    nextFfpState(blockLen: number): number {
        let s = this.ffpStates[this.ffpStateCount];
        if (!s) {
            s = {
                block: new Float32Array(Math.max(4, blockLen)), blockLen: 0,
                textures: new Array(FFP_STAGE_SLOTS).fill(null),
                samplers: new Array(FFP_STAGE_SLOTS).fill(null),
                stageCount: 1,
            };
            this.ffpStates[this.ffpStateCount] = s;
        }
        if (s.block.length < blockLen) s.block = new Float32Array(blockLen);
        s.blockLen = blockLen;
        // Only [0, stageCount) is read, and captureFfpDrawState fills exactly that range —
        // clearing all eight per draw would be pure hot-path cost for slots nobody looks at.
        s.stageCount = 1;
        s.textures[0] = null;
        s.samplers[0] = null;
        return this.ffpStateCount++;
    }

    pushBindFfp(stateIndex: number): void {
        this.commandTypes.push(RenderCommandType.BindFfp);
        this.commandA.push(stateIndex);
        this.commandB.push(0);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    /** `dstOffset` is where `data` lands in the target buffer; it must be 4-aligned and the
     *  padded length must still fit, which `alignUploadRange` guarantees for its callers. */
    queueUpload(buffer: GPUBuffer, data: Uint8Array, dstOffset = 0): void {
        this.uploadBuffers.push(buffer);
        this.uploadOffsets.push(dstOffset);
        // IMPORTANT: Make a copy! The source data may be a view into a shared
        // conversion buffer that gets overwritten by subsequent DrawPrimitiveUP calls,
        // or into a store shadow a later Unlock in this same frame refills.
        // The copy is padded to a 4-byte multiple: GPUQueue.writeBuffer THROWS an
        // OperationError on any other size (a 16-bit index buffer with an odd index
        // count is 2 mod 4), and one throw at flush time abandons every upload queued
        // after it — permanently, since their dirty flags were already cleared.
        const padded = new Uint8Array((data.byteLength + 3) & ~3);
        padded.set(data);
        this.uploadData.push(padded);
    }

    registerTemporaryBuffer(buffer: GPUBuffer): void {
        this.temporaryBuffers.push(buffer);
    }

    /** Track a pooled buffer for post-submit reclaim (returned to the pool, not destroyed). */
    registerPooledBuffer(buffer: GPUBuffer): void {
        this.pooledBuffers.push(buffer);
    }

    releaseTemporaryBuffers(): void {
        for (const buffer of this.temporaryBuffers) {
            buffer.destroy();
        }
        this.temporaryBuffers.length = 0;
    }

    hasWork(): boolean {
        return this.hasClear || this.commandTypes.length > 0 || this.uploadBuffers.length > 0;
    }
}

export class RenderFramePool {
    private frames: RenderFrame[] = [];
    private nextIndex = 0;

    constructor(size: number = 2) {
        for (let i = 0; i < size; i++) {
            this.frames.push(new RenderFrame());
        }
    }

    acquire(): RenderFrame {
        const frame = this.frames[this.nextIndex];
        this.nextIndex = (this.nextIndex + 1) % this.frames.length;
        frame.reset();
        return frame;
    }
}
