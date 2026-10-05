/**
 * Deferred Texture Upload Manager
 *
 * Batches texture uploads to end of frame (Present/Flip) instead of immediate upload during Blt.
 * This reduces GPU submission overhead and eliminates redundant uploads for surfaces modified multiple times per frame.
 *
 * GPU-First Mode Optimization:
 * - Surfaces in GPU_ONLY mode skip CPU→GPU sync entirely (GPU is authoritative)
 * - Read-only locks on GPU_ONLY surfaces don't demote to CPU mode
 * - Only write locks cause permanent demotion to CPU mode
 * - Eliminates expensive Convert (RGB565→RGBA) and Upload operations for pure GPU surfaces
 *
 * Performance impact:
 * - ~50% reduction in Blt:resync time (180ms savings)
 * - ~60% reduction in Upload time through partial updates (98-99% less data)
 * - GPU_ONLY surfaces: 100% reduction in Convert/Upload overhead
 */

import type { DirectDrawSurfaceState } from "./com-objects";
import { isRenderSurface, isBitmapTexture } from "./com-objects";
import { uploadToGPUTexture, resolvePalette } from "./gpu-texture-utils";
import { markGpuSyncedFromCpu } from "./surface-sync";
import { Logger, LogCategory } from "../../core/logger";
import { profiler } from "../../core/profiler";
import { decodeSurfaceFormatToRgba8 } from "../../backends/webgpu/shared/texture-formats";

export class DeferredUploadManager {
    private dirtySurfaces = new Set<DirectDrawSurfaceState>();
    private immediateUploadForPrimary = true; // Low-latency mode for primary surface

    // Frame diagnostics
    private frameStats = {
        lockCount: 0,
        lockWithRect: 0,
        lockFullSurface: 0,
        totalDirtyArea: 0,
    };

    /**
     * Mark surface as needing GPU upload (called from Blt, Lock/Unlock).
     * Upload will be deferred until flushAll() at Present/Flip.
     */
    markDirty(surface: DirectDrawSurfaceState, immediate = false): void {
        // GPU-First Mode: Skip GPU_ONLY surfaces (GPU is authoritative, no CPU→GPU sync needed)
        if (isRenderSurface(surface) && surface.mode === "GPU_ONLY") {
            return;
        }

        // Skip if already up-to-date
        if (isRenderSurface(surface)) {
            // Optimization: Skip if version hasn't changed since last upload
            if (surface.lastUploadVersion === surface.version) {
                return; // Already uploaded this version
            }
            if (!surface.gpuDirty) {
                return; // Not dirty
            }
        } else if (isBitmapTexture(surface)) {
            if (!surface.gpuNeedsUpload) {
                return; // Not dirty
            }
        }

        if (immediate) {
            // Immediate upload for edge cases (Blt chains in GPU path)
            this.dirtySurfaces.delete(surface); // Remove from batch if queued
        } else {
            this.dirtySurfaces.add(surface);
        }
    }

    /**
     * Check if surface needs immediate upload (for GPU fast path Blt chains).
     */
    needsImmediateUpload(surface: DirectDrawSurfaceState): boolean {
        if (isRenderSurface(surface)) {
            // GPU-First Mode: GPU_ONLY surfaces don't need CPU→GPU upload (GPU is authoritative)
            if (surface.mode === "GPU_ONLY") {
                return false;
            }
            return surface.gpuDirty && surface.lastUploadVersion !== surface.version;
        } else if (isBitmapTexture(surface)) {
            return surface.gpuNeedsUpload;
        }
        return false;
    }

    /**
     * Force immediate upload for a single surface (used in GPU Blt chains).
     */
    async uploadImmediate(
        surface: DirectDrawSurfaceState,
        queue: GPUQueue,
        mem: Uint8Array
    ): Promise<void> {
        if (!surface.gpuTexture) return;
        if (!this.needsImmediateUpload(surface)) return;

        profiler.start("DeferredUpload:immediate");

        profiler.start("DeferredUpload:immediate:convert");
        const palette = resolvePalette(surface);
        const rgbaData = decodeSurfaceFormatToRgba8(
            mem,
            surface.surfacePtr,
            surface.width,
            surface.height,
            surface.pitch,
            surface.format,
            surface.rgbaScratch,
            surface.srcColorKey,
            palette
        );
        profiler.end("DeferredUpload:immediate:convert");

        // Cache for next time
        if (isRenderSurface(surface)) {
            surface.rgbaScratch = rgbaData;
            surface.rgbaScratchVersion = surface.version;
        }

        profiler.start("DeferredUpload:immediate:upload");
        // Prepare scratch buffer for padding/swizzling
        const unpaddedBPR = surface.width * 4;
        const alignedBPR = (unpaddedBPR + 255) & ~255;
        const needsPadding = alignedBPR !== unpaddedBPR && surface.height > 1;
        const format = surface.gpuTextureFormat ?? "rgba8unorm";
        const needsSwizzle = format === "bgra8unorm";
        if (needsPadding || needsSwizzle) {
            const requiredBytes = alignedBPR * surface.height;
            if (!surface.rgbaPaddedScratch || surface.rgbaPaddedScratch.length < requiredBytes) {
                surface.rgbaPaddedScratch = new Uint8Array(requiredBytes);
            }
        }

        const dirtyRegion = isRenderSurface(surface) ? surface.dirtyRegion : undefined;
        uploadToGPUTexture(
            queue,
            surface.gpuTexture,
            rgbaData,
            surface.width,
            surface.height,
            surface.rgbaPaddedScratch,
            format,
            dirtyRegion
        );
        profiler.end("DeferredUpload:immediate:upload");

        // Clear dirty region after upload
        if (isRenderSurface(surface)) {
            surface.dirtyRegion = undefined;
        }

        markGpuSyncedFromCpu(surface);
        this.dirtySurfaces.delete(surface); // Remove from deferred batch

        profiler.end("DeferredUpload:immediate");

        Logger.verbose(LogCategory.DDRAW,
            `DeferredUpload: Immediate upload for surface 0x${surface.surfacePtr.toString(16)}`);
    }

    /**
     * Upload all dirty surfaces in one batch (called from Present/Flip).
     * This is the main optimization - batches all texture uploads together.
     */
    async flushAll(queue: GPUQueue, mem: Uint8Array): Promise<void> {
        if (this.dirtySurfaces.size === 0) return;

        profiler.start("DeferredUpload:batch");
        const count = this.dirtySurfaces.size;

        // Per-frame diagnostics
        let uploadedCount = 0;
        let skippedCount = 0;
        let totalDirtyAreaPx = 0;
        let totalBytesUploaded = 0;
        let fullUploads = 0;
        let partialUploads = 0;

        for (const surface of this.dirtySurfaces) {
            if (!surface.gpuTexture) {
                skippedCount++;
                continue;
            }

            // Double-check still dirty (might have been uploaded immediately in GPU path)
            if (!this.needsImmediateUpload(surface)) {
                skippedCount++;
                continue;
            }

            profiler.start("DeferredUpload:batch:convert");
            const palette = resolvePalette(surface);
            const rgbaData = decodeSurfaceFormatToRgba8(
                mem,
                surface.surfacePtr,
                surface.width,
                surface.height,
                surface.pitch,
                surface.format,
                surface.rgbaScratch,
                surface.srcColorKey,
                palette
            );
            profiler.end("DeferredUpload:batch:convert");

            // Cache for next time
            if (isRenderSurface(surface)) {
                surface.rgbaScratch = rgbaData;
                surface.rgbaScratchVersion = surface.version;
            }

            profiler.start("DeferredUpload:batch:upload");
            // Prepare scratch buffer for padding/swizzling
            const unpaddedBPR = surface.width * 4;
            const alignedBPR = (unpaddedBPR + 255) & ~255;
            const needsPadding = alignedBPR !== unpaddedBPR && surface.height > 1;
            const format = surface.gpuTextureFormat ?? "rgba8unorm";
            const needsSwizzle = format === "bgra8unorm";
            if (needsPadding || needsSwizzle) {
                const requiredBytes = alignedBPR * surface.height;
                if (!surface.rgbaPaddedScratch || surface.rgbaPaddedScratch.length < requiredBytes) {
                    surface.rgbaPaddedScratch = new Uint8Array(requiredBytes);
                }
            }

            const dirtyRegion = isRenderSurface(surface) ? surface.dirtyRegion : undefined;

            // Track diagnostics
            let dirtyAreaPx: number;
            if (dirtyRegion) {
                dirtyAreaPx = (dirtyRegion.right - dirtyRegion.left) * (dirtyRegion.bottom - dirtyRegion.top);
                const fullAreaPx = surface.width * surface.height;
                if (dirtyAreaPx < fullAreaPx * 0.3) {
                    partialUploads++;
                } else {
                    fullUploads++;
                }
            } else {
                dirtyAreaPx = surface.width * surface.height;
                fullUploads++;
            }
            totalDirtyAreaPx += dirtyAreaPx;
            totalBytesUploaded += dirtyAreaPx * 4; // RGBA = 4 bytes per pixel

            uploadToGPUTexture(
                queue,
                surface.gpuTexture,
                rgbaData,
                surface.width,
                surface.height,
                surface.rgbaPaddedScratch,
                format,
                dirtyRegion
            );
            profiler.end("DeferredUpload:batch:upload");

            // Clear dirty region after upload
            if (isRenderSurface(surface)) {
                surface.dirtyRegion = undefined;
            }

            markGpuSyncedFromCpu(surface);
            uploadedCount++;
        }

        this.dirtySurfaces.clear();
        profiler.end("DeferredUpload:batch");

        // Log detailed per-frame diagnostics
        const totalKB = (totalBytesUploaded / 1024).toFixed(1);
        const avgAreaPx = uploadedCount > 0 ? Math.round(totalDirtyAreaPx / uploadedCount) : 0;
        Logger.verbose(LogCategory.DDRAW,
            `DeferredUpload FRAME: surfaces=${uploadedCount}/${count} (skipped=${skippedCount}) ` +
            `uploads=${fullUploads}full+${partialUploads}partial dirtyArea=${totalDirtyAreaPx}px (avg=${avgAreaPx}px/surf) ` +
            `bytes=${totalKB}KB | ` +
            `locks=${this.frameStats.lockCount} (withRect=${this.frameStats.lockWithRect}, full=${this.frameStats.lockFullSurface})`);

        // Reset frame stats for next frame
        this.frameStats = {
            lockCount: 0,
            lockWithRect: 0,
            lockFullSurface: 0,
            totalDirtyArea: 0,
        };
    }

    /**
     * Get current batch size (for debugging).
     */
    getPendingCount(): number {
        return this.dirtySurfaces.size;
    }

    /**
     * Track Lock call for frame diagnostics.
     */
    trackLock(hasRect: boolean, rectArea?: number): void {
        this.frameStats.lockCount++;
        if (hasRect && rectArea !== undefined) {
            this.frameStats.lockWithRect++;
            this.frameStats.totalDirtyArea += rectArea;
        } else {
            this.frameStats.lockFullSurface++;
        }
    }

    /**
     * Remove a specific surface from the pending upload batch.
     * Called from surface destroy() to prevent reading freed/reused surfacePtr memory.
     */
    removeDirty(surface: DirectDrawSurfaceState): void {
        this.dirtySurfaces.delete(surface);
    }

    /** Membership describes the IMAGE, so a Flip must carry it with the storage it
     *  renames — otherwise the batch uploads whichever buffer now sits in that slot. */
    isPendingUpload(surface: DirectDrawSurfaceState): boolean {
        return this.dirtySurfaces.has(surface);
    }

    setPendingUpload(surface: DirectDrawSurfaceState, pending: boolean): void {
        if (pending) this.dirtySurfaces.add(surface);
        else this.dirtySurfaces.delete(surface);
    }

    /**
     * Clear all pending uploads without uploading (for emergency cleanup).
     */
    clear(): void {
        this.dirtySurfaces.clear();
    }
}
