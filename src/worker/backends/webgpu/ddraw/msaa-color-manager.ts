/**
 * Per-render-target multisample (MSAA) COLOR texture management for the DirectDraw /
 * Direct3D WebGPU backend — the color-side twin of DepthManager.
 *
 * When `quality.msaa > 1`, every render pass that targets a surface must render into a
 * multisampled color texture and RESOLVE into that surface's single-sample GPU texture
 * (the one the present / Blt path samples). This manager owns one persistent multisampled
 * color texture per surface, sized/formatted to match the surface, recreated only when the
 * surface's dimensions, format, or the active sample count change.
 *
 * Lifecycle mirrors DepthManager exactly (per-surfacePtr map, deferred-destroy garbage list,
 * removeForSurface on surface destruction) so the two stay in lockstep — a render pass'
 * color and depth attachments MUST share the same sampleCount or WebGPU rejects the pass.
 *
 * GUARD: sampleCount === 1 means MSAA is OFF. Callers must NOT create/attach any texture
 * from this manager in that case — the single-sample path is byte-identical to pre-MSAA.
 */

import { DirectDrawSurfaceState } from "../../../modules/ddraw/com-objects";
import { normalizePortableWebGpuSampleCount } from "../shared/msaa-policy";

interface ColorEntry {
    tex: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
    format: GPUTextureFormat;
    sampleCount: number;
}

export class MsaaColorManager {
    private device: GPUDevice;

    // Multisampled color textures per render-target surface (key = surfacePtr).
    private bySurface = new Map<number, ColorEntry>();

    // Textures to destroy after queue.submit() (same deferral discipline as DepthManager).
    private garbageList: GPUTexture[] = [];

    // Active sample count (1 = MSAA off). WebGPU's portable set is {1,4}.
    private sampleCount = 1;

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /** MSAA on when sampleCount > 1. */
    isEnabled(): boolean {
        return this.sampleCount > 1;
    }

    getSampleCount(): number {
        return this.sampleCount;
    }

    /**
     * Set the active sample count (from quality.msaa). Clamps to {1,4}. On change, all existing
     * multisample textures are retired (they carry the old sampleCount) so the next
     * ensureForTarget rebuilds them. Returns true if the count actually changed.
     */
    setSampleCount(n: number): boolean {
        const clamped = normalizePortableWebGpuSampleCount(n);
        if (clamped === this.sampleCount) return false;
        this.sampleCount = clamped;
        for (const entry of this.bySurface.values()) {
            this.garbageList.push(entry.tex);
        }
        this.bySurface.clear();
        return true;
    }

    /**
     * Ensure a multisampled color texture exists for `target`, matching its size + GPU format
     * and the active sampleCount. No-op (returns false) when MSAA is off. Recreates on any
     * size/format/sampleCount mismatch.
     *
     * @returns true if a texture was created or recreated.
     */
    ensureForTarget(target: DirectDrawSurfaceState): boolean {
        if (this.sampleCount <= 1) return false;

        const format = target.gpuTextureFormat;
        if (!format) return false;

        const surfacePtr = target.surfacePtr;
        const entry = this.bySurface.get(surfacePtr);
        if (
            entry &&
            entry.width === target.width &&
            entry.height === target.height &&
            entry.format === format &&
            entry.sampleCount === this.sampleCount
        ) {
            return false; // matches
        }

        if (entry) {
            this.garbageList.push(entry.tex);
            this.bySurface.delete(surfacePtr);
        }

        const tex = this.device.createTexture({
            size: [target.width, target.height],
            format,
            sampleCount: this.sampleCount,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.bySurface.set(surfacePtr, {
            tex,
            view: tex.createView(),
            width: target.width,
            height: target.height,
            format,
            sampleCount: this.sampleCount,
        });
        return true;
    }

    /**
     * The multisampled color view to use as the render pass' `view`, with the surface's
     * single-sample texture as the `resolveTarget`. Null when MSAA is off or no texture exists
     * (caller falls back to the plain single-sample attachment).
     */
    getColorViewForTarget(target: DirectDrawSurfaceState): GPUTextureView | null {
        if (this.sampleCount <= 1) return null;
        return this.bySurface.get(target.surfacePtr)?.view ?? null;
    }

    /** Drop the multisample texture for a surface (call on surface destruction). */
    removeForSurface(surfacePtr: number): void {
        const entry = this.bySurface.get(surfacePtr);
        if (entry) {
            this.garbageList.push(entry.tex);
            this.bySurface.delete(surfacePtr);
        }
    }

    /** Destroy retired textures. Call after queue.submit() (same timing as DepthManager). */
    flushGarbage(): void {
        for (const tex of this.garbageList) tex.destroy();
        this.garbageList = [];
    }

    /** Destroy all textures and clear state. */
    destroy(): void {
        for (const entry of this.bySurface.values()) this.garbageList.push(entry.tex);
        this.bySurface.clear();
        this.flushGarbage();
    }
}
