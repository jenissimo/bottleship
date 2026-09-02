/**
 * D3D9CommandRecorder - Records draw commands into a RenderFrame
 *
 * Separated from D3D9Device to enable command batching,
 * multi-threading preparation, and cleaner separation of concerns.
 */

import { RenderFrame, RenderFramePool, RenderCommandType, type ArenaDrawBinding } from "../render-frame";
import type { StreamBindingPlan, StreamVertexBinding } from "../shared/vertex-streams";

export type { StreamVertexBinding };

/**
 * Where a draw's vertex bindings come from. The two shapes are deliberately exclusive:
 *
 *  - `streams` — a plan covering EVERY slot the pipeline declares, slot 0 included, resolved
 *    once from the stream binding table (the D3D9 backend).
 *  - `gpuBuffer` + `extraStreams` — slot 0 passed separately from the rest, with the draw's
 *    base vertex already folded into the extra offsets (the D3D8 backend's convention).
 *
 * Mixing them is what let slot 0 and slots 1+ be computed by different rules, so the type
 * refuses the mixture rather than documenting against it.
 */
export interface PlannedVertexBindings {
    /** Every vertex slot this draw binds, slot 0 included. */
    streams: StreamBindingPlan;
}

export interface DrawViewport {
    x: number;
    y: number;
    width: number;
    height: number;
    minZ: number;
    maxZ: number;
}

export interface DrawScissorRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Slot0VertexBindings {
    gpuBuffer: GPUBuffer;
    bufferOffset: number;
    bufferSize: number;
    /** Streams beyond 0 — bound with setVertexBuffer(slot, …) before the draw. */
    extraStreams?: StreamVertexBinding[];
}

interface DrawCommandBase {
    pipelineId: number;
    vertexCount: number;
    startVertex: number;
    /** Programmable (VS/PS) per-draw state index, or undefined for FFP. */
    bindStateIndex?: number;
    /** FFP per-draw state index (uniform block + stage-0 texture), or undefined. */
    ffpStateIndex?: number;
    /** The guest's own stream-0 stride (diagnostic — see RenderFrame.pushDraw). */
    guestStride?: number;
    /** D3D9 hardware instancing count for non-indexed draws; 1 is ordinary rendering. */
    instanceCount?: number;
    /** Raster scissor snapshot for this draw. D3D9Device supplies a full-target rectangle when
     * SCISSORTESTENABLE is disabled so a prior enabled draw cannot leak its state. */
    scissorRect?: DrawScissorRect;
    /** Viewport snapshot for this draw. Per-draw state in D3D9, pass-level in WebGPU. */
    viewport?: DrawViewport;
    /** D3DRS_STENCILREF is dynamic render-pass state rather than pipeline state. */
    stencilReference?: number;
    /** D3DRS_BLENDFACTOR is dynamic render-pass state rather than pipeline state. */
    blendConstant?: number;
}

export type DrawCommand = DrawCommandBase & (PlannedVertexBindings | Slot0VertexBindings);

export interface IndexedSlot0VertexBindings {
    vbGpuBuffer: GPUBuffer;
    vbOffset: number;
    vbSize: number;
    /** Streams beyond 0 — bound with setVertexBuffer(slot, …) before the draw. */
    extraStreams?: StreamVertexBinding[];
}

interface DrawIndexedCommandBase {
    pipelineId: number;
    ibGpuBuffer: GPUBuffer;
    ibFormat: "uint16" | "uint32";
    indexCount: number;
    startIndex: number;
    baseVertex: number;
    /** D3D9 hardware instancing (SetStreamSourceFreq); 1 = an ordinary draw. */
    instanceCount?: number;
    bindStateIndex?: number;
    ffpStateIndex?: number;
    scissorRect?: DrawScissorRect;
    viewport?: DrawViewport;
    stencilReference?: number;
    blendConstant?: number;
}

export type DrawIndexedCommand =
    DrawIndexedCommandBase & (PlannedVertexBindings | IndexedSlot0VertexBindings);

export type DrawIndexedArenaRunCommand = {
    pipelineId: number;
    ibGpuBuffer: GPUBuffer;
    ibFormat: "uint16" | "uint32";
    bindStateIndex: number;
    arenaCommandStart: number;
    arenaCommandEnd: number;
    pairCount: number;
    compactDescriptorOffset?: number;
    prefixVsBits?: Uint32Array;
    prefixStartFloat?: number;
    scissorRect?: DrawScissorRect;
    viewport?: DrawViewport;
    stencilReference?: number;
    blendConstant?: number;
} & (PlannedVertexBindings | IndexedSlot0VertexBindings);

export class D3D9CommandRecorder {
    private frame: RenderFrame;
    private currentPipelineId: number | null = null;
    /** Last-emitted BindProgrammable state index (Phase C elision). Consecutive draws that
     *  captured the identical state share one slot (see D3D9Device.captureDrawState) — the
     *  redundant re-bind command is skipped. Reset on pipeline change (bind-group layout may
     *  differ per pipeline) and at finalize (executor bind caches reset per pass/frame). */
    private currentBindStateIndex: number | null = null;
    /** Dynamic render-pass state is emitted only when its value changes. These keys live for
     * the current frame because the executor keeps the same render pass state between draws. */
    /** Last recorded scissor, compared field-wise: building a `l|t|w|h` string to compare
     *  allocated one throwaway per DRAW (the viewport check right beside it already avoids
     *  exactly that). `width < 0` means "none recorded yet". */
    private currentScissor = { left: 0, top: 0, width: -1, height: 0 };
    /** Last viewport recorded into the current frame; width -1 means "none recorded yet". */
    private currentViewport = { x: 0, y: 0, width: -1, height: 0, minZ: 0, maxZ: 0 };
    private currentStencilReference: number | null = null;
    private currentBlendConstant: number | null = null;
    private drawCount = 0;

    constructor(private framePool: RenderFramePool) {
        this.frame = framePool.acquire();
    }

    /**
     * Set clear color for the frame
     */
    setClear(color: GPUColor, depth: number, stencil: number, flags: number): void {
        this.frame.setClear(color, depth, stencil, flags);
    }

    recordBeginOcclusionQuery(queryPtr: number): void {
        this.frame.pushBeginOcclusionQuery(queryPtr);
    }

    recordEndOcclusionQuery(queryPtr: number): void {
        this.frame.pushEndOcclusionQuery(queryPtr);
    }

    recordTimestampQuery(queryPtr: number): void {
        this.frame.pushTimestampQuery(queryPtr);
    }

    /**
     * Queue a buffer upload for the current frame. `dstOffset` is where `data` lands in the
     * target — a ranged upload writes only the bytes the guest rewrote.
     */
    queueUpload(buffer: GPUBuffer, data: Uint8Array, dstOffset = 0): void {
        this.frame.queueUpload(buffer, data, dstOffset);
    }

    /** Emit a SetViewport command when this draw's viewport differs from the one already
     *  recorded. Compared field-wise so the per-draw check allocates nothing. */
    private recordViewport(v: DrawViewport | undefined): void {
        if (!v) return;
        const c = this.currentViewport;
        if (c.width === v.width && c.height === v.height && c.x === v.x && c.y === v.y
            && c.minZ === v.minZ && c.maxZ === v.maxZ) return;
        this.frame.pushSetViewport(v.x, v.y, v.width, v.height, v.minZ, v.maxZ);
        c.x = v.x; c.y = v.y; c.width = v.width; c.height = v.height; c.minZ = v.minZ; c.maxZ = v.maxZ;
    }

    /**
     * Record a non-indexed draw call
     */
    recordDraw(cmd: DrawCommand): void {
        if (this.currentPipelineId !== cmd.pipelineId) {
            this.frame.pushSetPipeline(cmd.pipelineId);
            this.currentPipelineId = cmd.pipelineId;
            this.currentBindStateIndex = null;
        }

        if (cmd.bindStateIndex !== undefined && cmd.bindStateIndex !== this.currentBindStateIndex) {
            this.frame.pushBindProgrammable(cmd.bindStateIndex);
            this.currentBindStateIndex = cmd.bindStateIndex;
        }
        if (cmd.ffpStateIndex !== undefined) {
            this.frame.pushBindFfp(cmd.ffpStateIndex);
        }
        this.recordViewport(cmd.viewport);
        if (cmd.scissorRect) {
            const r = cmd.scissorRect;
            const c = this.currentScissor;
            if (c.width !== r.width || c.height !== r.height || c.left !== r.left || c.top !== r.top) {
                this.frame.pushSetScissor(r.left, r.top, r.width, r.height);
                c.left = r.left; c.top = r.top; c.width = r.width; c.height = r.height;
            }
        }
        if (cmd.stencilReference !== undefined && cmd.stencilReference !== this.currentStencilReference) {
            this.frame.pushSetStencilReference(cmd.stencilReference);
            this.currentStencilReference = cmd.stencilReference;
        }
        if (cmd.blendConstant !== undefined && cmd.blendConstant !== this.currentBlendConstant) {
            this.frame.pushSetBlendConstant(cmd.blendConstant);
            this.currentBlendConstant = cmd.blendConstant;
        }
        this.bindVertexBuffers(cmd);
        this.frame.pushDraw(cmd.vertexCount, cmd.startVertex, cmd.guestStride ?? 0, cmd.instanceCount ?? 1);
        this.drawCount++;
    }

    /** Bind every vertex slot the draw declares, whichever shape it supplied them in. */
    private bindVertexBuffers(cmd: PlannedVertexBindings | Slot0VertexBindings): void {
        if ("streams" in cmd) {
            const plan = cmd.streams;
            for (let i = 0; i < plan.count; i++) {
                const b = plan.at(i);
                this.frame.pushSetVertexBuffer(b.buffer, b.offset, b.size, b.slot);
            }
            return;
        }
        this.frame.pushSetVertexBuffer(cmd.gpuBuffer, cmd.bufferOffset, cmd.bufferSize);
        if (cmd.extraStreams) {
            for (const s of cmd.extraStreams) {
                this.frame.pushSetVertexBuffer(s.buffer, s.offset, s.size, s.slot);
            }
        }
    }

    /**
     * Record an indexed draw call
     */
    recordDrawIndexed(cmd: DrawIndexedCommand): void {
        if (this.currentPipelineId !== cmd.pipelineId) {
            this.frame.pushSetPipeline(cmd.pipelineId);
            this.currentPipelineId = cmd.pipelineId;
            this.currentBindStateIndex = null;
        }

        if (cmd.bindStateIndex !== undefined && cmd.bindStateIndex !== this.currentBindStateIndex) {
            this.frame.pushBindProgrammable(cmd.bindStateIndex);
            this.currentBindStateIndex = cmd.bindStateIndex;
        }
        if (cmd.ffpStateIndex !== undefined) {
            this.frame.pushBindFfp(cmd.ffpStateIndex);
        }
        this.recordViewport(cmd.viewport);
        if (cmd.scissorRect) {
            const r = cmd.scissorRect;
            const c = this.currentScissor;
            if (c.width !== r.width || c.height !== r.height || c.left !== r.left || c.top !== r.top) {
                this.frame.pushSetScissor(r.left, r.top, r.width, r.height);
                c.left = r.left; c.top = r.top; c.width = r.width; c.height = r.height;
            }
        }
        if (cmd.stencilReference !== undefined && cmd.stencilReference !== this.currentStencilReference) {
            this.frame.pushSetStencilReference(cmd.stencilReference);
            this.currentStencilReference = cmd.stencilReference;
        }
        if (cmd.blendConstant !== undefined && cmd.blendConstant !== this.currentBlendConstant) {
            this.frame.pushSetBlendConstant(cmd.blendConstant);
            this.currentBlendConstant = cmd.blendConstant;
        }
        if ("streams" in cmd) this.bindVertexBuffers(cmd);
        else {
            this.frame.pushSetVertexBuffer(cmd.vbGpuBuffer, cmd.vbOffset, cmd.vbSize);
            if (cmd.extraStreams) {
                for (const s of cmd.extraStreams) {
                    this.frame.pushSetVertexBuffer(s.buffer, s.offset, s.size, s.slot);
                }
            }
        }
        this.frame.pushSetIndexBuffer(cmd.ibGpuBuffer, cmd.ibFormat);
        this.frame.pushDrawIndexed(cmd.indexCount, cmd.startIndex, cmd.baseVertex, cmd.instanceCount ?? 1);
        this.drawCount++;
    }

    /** Record one compact host command for an arena-authoritative indexed pair run. */
    recordDrawIndexedArenaRun(cmd: DrawIndexedArenaRunCommand): void {
        if (this.currentPipelineId !== cmd.pipelineId) {
            this.frame.pushSetPipeline(cmd.pipelineId);
            this.currentPipelineId = cmd.pipelineId;
            this.currentBindStateIndex = null;
        }
        this.recordViewport(cmd.viewport);
        if (cmd.scissorRect) {
            const r = cmd.scissorRect;
            const c = this.currentScissor;
            if (c.width !== r.width || c.height !== r.height || c.left !== r.left || c.top !== r.top) {
                this.frame.pushSetScissor(r.left, r.top, r.width, r.height);
                c.left = r.left; c.top = r.top; c.width = r.width; c.height = r.height;
            }
        }
        if (cmd.stencilReference !== undefined && cmd.stencilReference !== this.currentStencilReference) {
            this.frame.pushSetStencilReference(cmd.stencilReference);
            this.currentStencilReference = cmd.stencilReference;
        }
        if (cmd.blendConstant !== undefined && cmd.blendConstant !== this.currentBlendConstant) {
            this.frame.pushSetBlendConstant(cmd.blendConstant);
            this.currentBlendConstant = cmd.blendConstant;
        }
        if ("streams" in cmd) this.bindVertexBuffers(cmd);
        else {
            this.frame.pushSetVertexBuffer(cmd.vbGpuBuffer, cmd.vbOffset, cmd.vbSize);
            if (cmd.extraStreams) {
                for (const s of cmd.extraStreams) {
                    this.frame.pushSetVertexBuffer(s.buffer, s.offset, s.size, s.slot);
                }
            }
        }
        this.frame.pushSetIndexBuffer(cmd.ibGpuBuffer, cmd.ibFormat);
        this.frame.pushDrawIndexedArenaRun(
            cmd.arenaCommandStart, cmd.arenaCommandEnd, cmd.bindStateIndex,
            cmd.pipelineId, cmd.pairCount, cmd.compactDescriptorOffset ?? -1,
            cmd.prefixVsBits, cmd.prefixStartFloat ?? 0,
        );
        // MegaBatch binds the storage-VS group, while the exact fallback repeatedly binds
        // ordinary dynamic-offset groups.  Neither execution shape gives the recorder a
        // normal-group invariant it may carry across this opaque command.  Force the next
        // ordinary draw to publish BindProgrammable even when it reuses the same state slot.
        this.currentBindStateIndex = null;
        this.drawCount += cmd.pairCount + (cmd.prefixVsBits ? 1 : 0);
    }

    /** Associate the just-recorded RenderFrame draw with its WASM-arena command. */
    recordArenaBinding(binding: Omit<ArenaDrawBinding, "frameDrawCommand">): void {
        const drawCommand = this.frame.commandTypes.length - 1;
        if (drawCommand < 0 || (this.frame.commandTypes[drawCommand] !== RenderCommandType.Draw
            && this.frame.commandTypes[drawCommand] !== RenderCommandType.DrawIndexed)) return;
        this.frame.arenaDrawBindings.push({ ...binding, frameDrawCommand: drawCommand });
    }

    /**
     * Finalize the current frame and prepare for the next one
     */
    finalize(): RenderFrame {
        const completedFrame = this.frame;
        this.frame = this.framePool.acquire();
        this.currentPipelineId = null;
        this.currentBindStateIndex = null;
        this.currentScissor.width = -1;
        this.currentViewport.width = -1;
        this.currentStencilReference = null;
        this.currentBlendConstant = null;
        return completedFrame;
    }

    /**
     * Check if the current frame has any work to do
     */
    hasWork(): boolean {
        return this.frame.hasWork();
    }

    registerTemporaryBuffer(buffer: GPUBuffer): void {
        this.frame.registerTemporaryBuffer(buffer);
    }

    registerPooledBuffer(buffer: GPUBuffer): void {
        this.frame.registerPooledBuffer(buffer);
    }

    /**
     * Get the number of draw calls recorded in the current frame
     */
    getDrawCount(): number {
        return this.drawCount;
    }

    /**
     * Reset draw count (call after present)
     */
    resetDrawCount(): void {
        this.drawCount = 0;
    }

    /**
     * Get the current frame for direct manipulation (advanced use)
     */
    getCurrentFrame(): RenderFrame {
        return this.frame;
    }
}
