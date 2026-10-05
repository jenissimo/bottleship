/**
 * Depth texture management for DirectDraw WebGPU backend.
 * Depth buffers are per render target surface, not global.
 * Each DirectDrawSurfaceState has its own depth buffer that persists across render passes.
 */

import { DirectDrawSurfaceState } from "../../../modules/ddraw/com-objects";
import { normalizePortableWebGpuSampleCount } from "../shared/msaa-policy";

/**
 * Depth texture entry for a specific render target
 */
type DepthEntry = {
    tex: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
    format: GPUTextureFormat;
    /** MSAA sample count this texture was created with. */
    sampleCount: number;
    /** Track if depth buffer has been used in current frame (for loadOp selection) */
    frameDirty: boolean;
    /** Set to true when D3D Clear with D3DCLEAR_ZBUFFER is called */
    needsClear: boolean;
    /** Set to true when D3D Clear with D3DCLEAR_STENCIL is called */
    needsStencilClear: boolean;
    /** Last depth clear value from D3D Clear call */
    lastClearDepth?: number;
    /** Last stencil clear value from D3D Clear call */
    lastClearStencil?: number;
};

/**
 * Configuration for depth format selection
 */
export interface DepthConfig {
    /** Depth format (default: "depth24plus-stencil8" for Shadow Volume / stencil games) */
    format?: GPUTextureFormat;
    /** Enable COPY_SRC usage for debug visualization (default: false) */
    enableDebugCopy?: boolean;
    /** MSAA sample count (default 1 = off). Must match the color attachment + pipeline. */
    sampleCount?: number;
}

/**
 * Manages depth texture lifecycle per render target surface.
 * Each surface maintains its own depth buffer that persists across render passes.
 */
export class DepthManager {
    private device: GPUDevice;
    private queue: GPUQueue;

    // Depth textures per render target. The key is the target's surfacePtr where it HAS one
    // (a DDraw surface), and a synthetic per-object id otherwise.
    //
    // A D3D8 render target has NO guest surface, so every one of them reports surfacePtr 0 and
    // they all collided on key 0: a title that alternates render targets within a frame failed
    // the size check on every switch, and the entry was destroyed and rebuilt. Coming back to
    // the first target therefore handed it a FRESH depth buffer — every depth value written
    // before the excursion was gone, so geometry drawn earlier stopped occluding geometry
    // drawn later. Object identity cannot collide; surfacePtr is kept as the key where it
    // exists so removeDepthForSurface() still finds a real surface's entry.
    private depthBySurface = new Map<number, DepthEntry>();

    /** Synthetic keys for targets with no guest surface (D3D8 render targets). Negative so they
     *  can never collide with a real surfacePtr, and WeakMap-held so a dead target's key dies
     *  with it. */
    private syntheticKeys = new WeakMap<DirectDrawSurfaceState, number>();
    private nextSyntheticKey = -1;

    private depthKeyFor(target: DirectDrawSurfaceState): number {
        const ptr = target.surfacePtr >>> 0;
        if (ptr !== 0) return ptr;
        let key = this.syntheticKeys.get(target);
        if (key === undefined) {
            key = this.nextSyntheticKey--;
            this.syntheticKeys.set(target, key);
        }
        return key;
    }

    // Garbage list for textures to be destroyed after queue.submit()
    private garbageList: GPUTexture[] = [];

    // Depth format configuration
    private depthFormat: GPUTextureFormat;
    private enableDebugCopy: boolean;
    // MSAA sample count (1 = off). Must equal the color attachment + pipeline sampleCount.
    private sampleCount: number;

    constructor(device: GPUDevice, queue: GPUQueue, config: DepthConfig = {}) {
        this.device = device;
        this.queue = queue;
        this.depthFormat = config.format || "depth24plus-stencil8";
        this.enableDebugCopy = config.enableDebugCopy || false;
        this.sampleCount = config.sampleCount && config.sampleCount > 1 ? config.sampleCount : 1;
    }

    /**
     * Get depth texture format
     */
    getDepthFormat(): GPUTextureFormat {
        return this.depthFormat;
    }

    /**
     * Set the MSAA sample count (from quality.msaa). Clamps to {1,4}. On change, all existing
     * depth textures are retired (they carry the old sampleCount) so the next ensure rebuilds
     * them to match the new color attachment. Returns true if the count actually changed.
     */
    setSampleCount(n: number): boolean {
        const clamped = normalizePortableWebGpuSampleCount(n);
        if (clamped === this.sampleCount) return false;
        this.sampleCount = clamped;
        for (const entry of this.depthBySurface.values()) {
            this.garbageList.push(entry.tex);
        }
        this.depthBySurface.clear();
        return true;
    }

    getSampleCount(): number {
        return this.sampleCount;
    }

    /**
     * Ensure depth texture exists for the given render target.
     * Creates or reuses depth texture per surface, maintaining persistence across render passes.
     *
     * @param target - DirectDrawSurfaceState render target
     * @returns true if texture was created or recreated
     */
    ensureDepthForTarget(target: DirectDrawSurfaceState): boolean {
        const surfacePtr = this.depthKeyFor(target);
        const entry = this.depthBySurface.get(surfacePtr);

        // Check if existing entry matches required size and format
        if (
            entry &&
            entry.width === target.width &&
            entry.height === target.height &&
            entry.format === this.depthFormat &&
            entry.sampleCount === this.sampleCount
        ) {
            return false; // Already exists and matches
        }

        // Mark old texture for garbage collection (if exists)
        if (entry) {
            this.garbageList.push(entry.tex);
            this.depthBySurface.delete(surfacePtr);
        }

        // Determine usage flags
        let usage = GPUTextureUsage.RENDER_ATTACHMENT;
        if (this.enableDebugCopy) {
            usage |= GPUTextureUsage.COPY_SRC;
        }

        // Create new depth texture. sampleCount>1 makes it a multisample depth buffer that
        // MUST match the color attachment + pipeline sampleCount (WebGPU rejects a mismatch).
        const depthTexture = this.device.createTexture({
            size: [target.width, target.height],
            format: this.depthFormat,
            sampleCount: this.sampleCount,
            usage,
        });
        const depthView = depthTexture.createView();

        // Store entry
        this.depthBySurface.set(surfacePtr, {
            tex: depthTexture,
            view: depthView,
            width: target.width,
            height: target.height,
            format: this.depthFormat,
            sampleCount: this.sampleCount,
            frameDirty: false, // New texture starts clean
            // New depth/stencil attachments must not be loaded before first clear/write.
            needsClear: true,
            needsStencilClear: true,
            lastClearDepth: 1.0,
            lastClearStencil: 0,
        });

        return true;
    }

    /**
     * Get depth texture view for the given render target.
     *
     * @param target - DirectDrawSurfaceState render target
     * @returns depth view or null if not created
     */
    getDepthViewForTarget(
        target: DirectDrawSurfaceState
    ): GPUTextureView | null {
        const entry = this.depthBySurface.get(this.depthKeyFor(target));
        return entry ? entry.view : null;
    }

    /**
     * Check if depth texture exists for the given target
     */
    hasDepthForTarget(target: DirectDrawSurfaceState): boolean {
        return this.depthBySurface.has(this.depthKeyFor(target));
    }

    /**
     * Create depth stencil attachment for render pass
     *
     * @param target - DirectDrawSurfaceState render target
     * @param depthLoadOp - Depth load operation (default: auto-select based on needsClear/frameDirty)
     *                     If explicitly set to "clear", always clears (frameDirty is ignored).
     * @param stencilLoadOp - Stencil load operation (default: auto-select based on needsStencilClear/frameDirty)
     *                      If explicitly set to "clear", always clears (frameDirty is ignored).
     * @param storeOp - Store operation (default: "store")
     * @param depthClearValue - Clear value if depthLoadOp is "clear" (default: from last Clear() call or 1.0)
     * @param stencilClearValue - Clear value if stencilLoadOp is "clear" (default: from last Clear() call or 0)
     * @returns depth stencil attachment or undefined if no depth buffer
     */
    createDepthStencilAttachmentForTarget(
        target: DirectDrawSurfaceState,
        depthLoadOp?: GPULoadOp,
        stencilLoadOp?: GPULoadOp,
        storeOp: GPUStoreOp = "store",
        depthClearValue?: number,
        stencilClearValue?: number
    ): GPURenderPassDepthStencilAttachment | undefined {
        const entry = this.depthBySurface.get(this.depthKeyFor(target));
        if (!entry) {
            return undefined;
        }

        let effectiveDepthLoadOp: GPULoadOp;
        if (depthLoadOp !== undefined) {
            effectiveDepthLoadOp = depthLoadOp;
        } else {
            // An explicit D3D Clear request must win even if this target was already drawn
            // earlier in the frame. Otherwise mid-frame Clear(TARGET|ZBUFFER) silently keeps
            // stale depth, which shows up as flicker / Z-fight on subsequent passes.
            effectiveDepthLoadOp = entry.needsClear ? "clear" : "load";
        }

        let effectiveStencilLoadOp: GPULoadOp;
        if (stencilLoadOp !== undefined) {
            effectiveStencilLoadOp = stencilLoadOp;
        } else {
            effectiveStencilLoadOp = entry.needsStencilClear ? "clear" : "load";
        }

        entry.frameDirty = true;

        if (effectiveDepthLoadOp === "clear") {
            entry.needsClear = false;
        }
        if (effectiveStencilLoadOp === "clear") {
            entry.needsStencilClear = false;
        }

        const attachment: GPURenderPassDepthStencilAttachment = {
            view: entry.view,
            depthLoadOp: effectiveDepthLoadOp,
            depthStoreOp: storeOp,
            stencilLoadOp: effectiveStencilLoadOp,
            stencilStoreOp: storeOp,
        };

        if (effectiveDepthLoadOp === "clear") {
            const clearValue = depthClearValue !== undefined && !isNaN(depthClearValue)
                ? depthClearValue
                : (entry.lastClearDepth !== undefined ? entry.lastClearDepth : 1.0);
            attachment.depthClearValue = clearValue;
        }

        if (effectiveStencilLoadOp === "clear") {
            const clearValue = stencilClearValue !== undefined && !isNaN(stencilClearValue)
                ? stencilClearValue
                : (entry.lastClearStencil !== undefined ? entry.lastClearStencil : 0);
            attachment.stencilClearValue = clearValue;
        }

        return attachment;
    }

    /**
     * Remove depth buffer for a surface (e.g., when surface is destroyed)
     *
     * @param surfacePtr - Surface pointer to remove depth buffer for
     */
    removeDepthForSurface(surfacePtr: number): void {
        const entry = this.depthBySurface.get(surfacePtr);
        if (entry) {
            this.garbageList.push(entry.tex);
            this.depthBySurface.delete(surfacePtr);
        }
    }

    /**
     * Set needsClear flag for a surface (called when D3D Clear with D3DCLEAR_ZBUFFER is invoked)
     *
     * @param target - DirectDrawSurfaceState render target
     * @param depthValue - Depth clear value (default: 1.0)
     */
    setNeedsClear(target: DirectDrawSurfaceState, depthValue: number = 1.0): void {
        const entry = this.depthBySurface.get(this.depthKeyFor(target));
        if (entry) {
            entry.needsClear = true;
            entry.lastClearDepth = depthValue;
        }
    }

    /**
     * Set needsStencilClear flag for a surface (called when D3D Clear with D3DCLEAR_STENCIL is invoked)
     *
     * @param target - DirectDrawSurfaceState render target
     * @param stencilValue - Stencil clear value (default: 0)
     */
    setNeedsStencilClear(target: DirectDrawSurfaceState, stencilValue: number = 0): void {
        const entry = this.depthBySurface.get(this.depthKeyFor(target));
        if (entry) {
            entry.needsStencilClear = true;
            entry.lastClearStencil = stencilValue;
        }
    }

    /**
     * Mark that an explicit Clear (Clear2) with depth/stencil was performed.
     * Resets needsClear/needsStencilClear so subsequent passes use load, not clear.
     */
    markExplicitClearDone(target: DirectDrawSurfaceState): void {
        const entry = this.depthBySurface.get(this.depthKeyFor(target));
        if (entry) {
            entry.needsClear = false;
            entry.needsStencilClear = false;
        }
    }

    /**
     * Mark that depth buffer was used in current frame (e.g., after Clear() or render pass).
     */
    markUsedThisFrame(target: DirectDrawSurfaceState): void {
        const entry = this.depthBySurface.get(this.depthKeyFor(target));
        if (entry) {
            entry.frameDirty = true;
        }
    }

    /**
     * Reset frame dirty flags for all depth buffers (call at start of new frame)
     */
    resetFrameDirtyFlags(): void {
        for (const entry of this.depthBySurface.values()) {
            entry.frameDirty = false;
        }
    }

    /**
     * Flush garbage list - destroy textures that are no longer in use.
     * Call this after queue.submit() to safely destroy textures.
     * Note: WebGPU allows destroy() immediately; GPU retains until done. For async
     * reuse across frames, consider deferring until queue.onSubmittedWorkDone().
     */
    flushGarbage(): void {
        for (const tex of this.garbageList) {
            tex.destroy();
        }
        this.garbageList = [];
    }

    /**
     * Destroy all depth textures and clear state
     */
    destroy(): void {
        // Add all textures to garbage list
        for (const entry of this.depthBySurface.values()) {
            this.garbageList.push(entry.tex);
        }
        this.depthBySurface.clear();

        // Destroy immediately (caller should ensure no pending operations)
        this.flushGarbage();
    }

    // ===== Legacy API (deprecated, for backward compatibility) =====

    /**
     * @deprecated Use ensureDepthForTarget() instead
     */
    ensureDepthTexture(width: number, height: number): boolean {
        // This method is deprecated - it doesn't know which surface to use
        // Return false to indicate no change (legacy code should migrate)
        return false;
    }

    /**
     * @deprecated Use getDepthViewForTarget() instead
     */
    getDepthView(): GPUTextureView | null {
        // Return first available depth view (legacy fallback)
        // This is incorrect for per-surface model, but maintains compatibility
        const firstEntry = this.depthBySurface.values().next().value;
        return firstEntry ? firstEntry.view : null;
    }

    /**
     * @deprecated Use createDepthStencilAttachmentForTarget() instead
     */
    createDepthStencilAttachment(
        loadOp: GPULoadOp = "load",
        storeOp: GPUStoreOp = "store",
        depthClearValue?: number
    ): GPURenderPassDepthStencilAttachment | undefined {
        const view = this.getDepthView();
        if (!view) {
            return undefined;
        }

        const attachment: GPURenderPassDepthStencilAttachment = {
            view,
            depthLoadOp: loadOp,
            depthStoreOp: storeOp,
            stencilLoadOp: loadOp,
            stencilStoreOp: storeOp,
        };

        if (loadOp === "clear" && depthClearValue !== undefined) {
            attachment.depthClearValue = depthClearValue;
        }
        if (loadOp === "clear") {
            attachment.stencilClearValue = 0;
        }

        return attachment;
    }

    /**
     * @deprecated Use hasDepthForTarget() instead
     */
    hasDepthTexture(): boolean {
        return this.depthBySurface.size > 0;
    }
}
