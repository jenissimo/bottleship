/**
 * Device limits needed by the D3D capability writers.
 *
 * A D3D caps query can run before a D3D device is created, so the writers use
 * a conservative portable fallback until WebGPUBackend publishes the live
 * GPUDevice limits. This is module state, not a global opt-in switch: it is
 * cleared on device loss and replaced only for the current device.
 */
import { bumpCapabilityGeneration } from './capability-generation';

export interface D3D9WebGpuCapabilityLimits {
    maxTextureDimension2D: number;
    maxTextureDimension3D: number;
}

let activeLimits: D3D9WebGpuCapabilityLimits | null = null;

export function getD3D9WebGpuCapabilityLimits(): D3D9WebGpuCapabilityLimits | null {
    return activeLimits;
}

export function setD3D9WebGpuCapabilityLimits(
    limits: D3D9WebGpuCapabilityLimits | null,
): void {
    if (!limits || !Number.isSafeInteger(limits.maxTextureDimension2D) ||
        !Number.isSafeInteger(limits.maxTextureDimension3D) ||
        limits.maxTextureDimension2D <= 0 || limits.maxTextureDimension3D <= 0) {
        activeLimits = null;
        bumpCapabilityGeneration();
        return;
    }
    activeLimits = {
        maxTextureDimension2D: limits.maxTextureDimension2D,
        maxTextureDimension3D: limits.maxTextureDimension3D,
    };
    bumpCapabilityGeneration();
}
