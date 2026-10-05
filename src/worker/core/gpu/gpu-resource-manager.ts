import { Logger, LogCategory } from "../logger";
import { returnGPUTextureToPool, clearGPUTexturePool } from "../../modules/ddraw/gpu-texture-utils";
import { registerGpuDeviceObserver } from "./gpu-device-lifecycle";

/**
 * GPU Resource Manager for deferred destruction of GPU textures.
 * Prevents race conditions where textures are destroyed before GPU finishes executing commands.
 *
 * WebGPU commands are asynchronous - queue.submit() only sends commands but doesn't guarantee completion.
 * This manager queues textures for destruction and destroys them at the end of frame presentation,
 * ensuring GPU has finished reading them before they are destroyed.
 *
 * Textures are returned to the GPU texture pool when possible for reuse,
 * reducing allocation overhead for games with high surface churn.
 */
export class GpuResourceManager {
    private pendingDestruction: GPUTexture[] = [];

    constructor() {
        // Textures queued for deferred destruction belong to the dead device. Recycling them
        // into the pool would hand a dead handle back to a caller that asked for a live one;
        // destroying them is meaningless. Drop the queue (and the pool) instead.
        registerGpuDeviceObserver("gpu-resource-manager", { onDeviceLost: () => this.clear() });
    }

    /**
     * Enqueue a GPU texture for deferred destruction (or pool return).
     * The texture will be recycled/destroyed at the end of the next frame presentation.
     */
    enqueueForDestruction(texture: GPUTexture): void {
        this.pendingDestruction.push(texture);
    }

    /**
     * Flush all pending texture destructions.
     * Tries to return textures to the pool for reuse; destroys if pool is full.
     * Should be called once per frame at the end of frame presentation (after queue.submit()).
     */
    flushPendingDestruction(): void {
        for (const texture of this.pendingDestruction) {
            try {
                // Try to recycle into pool (uses texture.width/height/format/usage)
                const pooled = returnGPUTextureToPool(
                    texture,
                    texture.width,
                    texture.height,
                    texture.format,
                    texture.usage
                );
                if (!pooled) {
                    texture.destroy();
                }
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `Error recycling/destroying deferred GPU texture: ${e}`);
            }
        }
        this.pendingDestruction = [];
    }

    /**
     * Get the number of textures pending destruction (for diagnostics).
     */
    getPendingCount(): number {
        return this.pendingDestruction.length;
    }

    /**
     * Clear all pending destructions without destroying textures.
     * Also clears the GPU texture pool.
     * Useful for reset/cleanup scenarios.
     */
    clear(): void {
        this.pendingDestruction = [];
        clearGPUTexturePool();
    }
}
