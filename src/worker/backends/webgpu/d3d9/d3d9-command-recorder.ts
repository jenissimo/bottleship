/**
 * D3D9CommandRecorder - Records draw commands into a RenderFrame
 *
 * Separated from D3D9Device to enable command batching,
 * multi-threading preparation, and cleaner separation of concerns.
 */

import { RenderFrame, RenderFramePool } from "../render-frame";
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
    bindStateIndex?: number;
    ffpStateIndex?: number;
}

export type DrawIndexedCommand =
    DrawIndexedCommandBase & (PlannedVertexBindings | IndexedSlot0VertexBindings);

export class D3D9CommandRecorder {
    private frame: RenderFrame;
    private currentPipelineId: number | null = null;
    /** Last-emitted BindProgrammable state index (Phase C elision). Consecutive draws that
     *  captured the identical state share one slot (see D3D9Device.captureDrawState) — the
     *  redundant re-bind command is skipped. Reset on pipeline change (bind-group layout may
     *  differ per pipeline) and at finalize (executor bind caches reset per pass/frame). */
    private currentBindStateIndex: number | null = null;
    private drawCount = 0;

    constructor(private framePool: RenderFramePool) {
        this.frame = framePool.acquire();
    }

    /**
     * Set clear color for the frame
     */
    setClear(color: GPUColor, depth: number, flags: number): void {
        this.frame.setClear(color, depth, flags);
    }

    /**
     * Queue a buffer upload for the current frame. `dstOffset` is where `data` lands in the
     * target — a ranged upload writes only the bytes the guest rewrote.
     */
    queueUpload(buffer: GPUBuffer, data: Uint8Array, dstOffset = 0): void {
        this.frame.queueUpload(buffer, data, dstOffset);
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
        this.bindVertexBuffers(cmd);
        this.frame.pushDraw(cmd.vertexCount, cmd.startVertex, cmd.guestStride ?? 0);
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
        this.frame.pushDrawIndexed(cmd.indexCount, cmd.startIndex, cmd.baseVertex);
        this.drawCount++;
    }

    /**
     * Finalize the current frame and prepare for the next one
     */
    finalize(): RenderFrame {
        const completedFrame = this.frame;
        this.frame = this.framePool.acquire();
        this.currentPipelineId = null;
        this.currentBindStateIndex = null;
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
