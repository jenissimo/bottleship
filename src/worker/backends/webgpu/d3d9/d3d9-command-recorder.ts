/**
 * D3D9CommandRecorder - Records draw commands into a RenderFrame
 *
 * Separated from D3D9Device to enable command batching,
 * multi-threading preparation, and cleaner separation of concerns.
 */

import { RenderFrame, RenderFramePool } from "../render-frame";

/** Extra vertex-stream binding (multi-stream D3D8 declarations): slot = stream number. */
export interface StreamVertexBinding {
    slot: number;
    buffer: GPUBuffer;
    offset: number;
    size: number;
}

export interface DrawCommand {
    pipelineId: number;
    gpuBuffer: GPUBuffer;
    bufferOffset: number;
    bufferSize: number;
    vertexCount: number;
    startVertex: number;
    /** Programmable (VS/PS) per-draw state index, or undefined for FFP. */
    bindStateIndex?: number;
    /** FFP per-draw state index (uniform block + stage-0 texture), or undefined. */
    ffpStateIndex?: number;
    /** Streams beyond 0 — bound with setVertexBuffer(slot, …) before the draw. */
    extraStreams?: StreamVertexBinding[];
}

export interface DrawIndexedCommand {
    pipelineId: number;
    vbGpuBuffer: GPUBuffer;
    vbOffset: number;
    vbSize: number;
    ibGpuBuffer: GPUBuffer;
    ibFormat: "uint16" | "uint32";
    indexCount: number;
    startIndex: number;
    baseVertex: number;
    bindStateIndex?: number;
    ffpStateIndex?: number;
    /** Streams beyond 0 — bound with setVertexBuffer(slot, …) before the draw. */
    extraStreams?: StreamVertexBinding[];
}

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
     * Queue a buffer upload for the current frame
     */
    queueUpload(buffer: GPUBuffer, data: Uint8Array): void {
        this.frame.queueUpload(buffer, data);
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
        this.frame.pushSetVertexBuffer(cmd.gpuBuffer, cmd.bufferOffset, cmd.bufferSize);
        if (cmd.extraStreams) {
            for (const s of cmd.extraStreams) {
                this.frame.pushSetVertexBuffer(s.buffer, s.offset, s.size, s.slot);
            }
        }
        this.frame.pushDraw(cmd.vertexCount, cmd.startVertex);
        this.drawCount++;
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
        this.frame.pushSetVertexBuffer(cmd.vbGpuBuffer, cmd.vbOffset, cmd.vbSize);
        if (cmd.extraStreams) {
            for (const s of cmd.extraStreams) {
                this.frame.pushSetVertexBuffer(s.buffer, s.offset, s.size, s.slot);
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
