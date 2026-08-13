/**
 * The guest-visible half of device loss: what d3d9/d3d8/DirectDraw are allowed to answer.
 *
 * The APIs disagree about spelling but not about mechanism. Direct3D 9 makes the DEVICE the
 * unit — TestCooperativeLevel goes D3DERR_DEVICELOST (nothing can be done yet) →
 * D3DERR_DEVICENOTRESET (a device exists again; release your D3DPOOL_DEFAULT resources and
 * call Reset) → D3D_OK. DirectDraw makes the SURFACE the unit — the surface methods fail with
 * DDERR_SURFACELOST and the app calls Restore()/RestoreAllSurfaces().
 *
 * Both reduce to one question — "is what you are holding older than the current device?" —
 * so both are answered from `gpuDeviceLifecycle.generation()` and nothing else. A device or
 * surface acknowledges a generation; anything acknowledging an older one is lost.
 *
 * WHAT SURVIVES A LOSS, and why the two APIs answer differently:
 *   - d3d9/d3d8 textures and vertex/index buffers keep a CPU shadow in their stores, so we
 *     re-upload them ourselves. Real D3D9 only promises that for D3DPOOL_MANAGED; restoring
 *     more than the contract requires is invisible to a correct app, which releases and
 *     re-creates its default-pool resources after Reset anyway.
 *   - A DirectDraw surface whose pixels live in guest memory (mode "CPU", and every
 *     bitmap_texture, which owns an rgbaScratch) is a SYSTEM-MEMORY surface in DirectDraw's
 *     own terms, and system-memory surfaces are never lost. We drop its GPU texture and
 *     re-upload from the pixels the guest still owns.
 *   - A "GPU_ONLY" surface — a pure 3D render target — had exactly one copy and it was on the
 *     lost device. Its contents are GONE. That is also what real hardware does: Restore()
 *     reallocates the surface and its contents are undefined. We report it lost until the app
 *     restores it, and it comes back cleared rather than as garbage.
 */

import { gpuDeviceLifecycle } from "./gpu-device-lifecycle";

/** What TestCooperativeLevel should say about one device. */
export type CooperativeLevel =
    /** Usable. */
    | "ok"
    /** No device yet — a Reset now cannot succeed. */
    | "lost"
    /** A device exists; the app must release default-pool resources and Reset. */
    | "notreset";

/** deviceKey (the guest COM pointer) -> the generation that device last acknowledged. */
const acknowledged = new Map<number, number>();

/** Called when a device object is created, so it starts life current. */
export function registerLossTrackedDevice(deviceKey: number): void {
    acknowledged.set(deviceKey >>> 0, gpuDeviceLifecycle.generation());
}

export function forgetLossTrackedDevice(deviceKey: number): void {
    acknowledged.delete(deviceKey >>> 0);
}

export function deviceCooperativeLevel(deviceKey: number): CooperativeLevel {
    const key = deviceKey >>> 0;
    // A device we never tracked is treated as current: reporting DEVICELOST for a device we
    // simply failed to register would send a correct app into a Reset loop it cannot leave.
    const ack = acknowledged.get(key);
    if (ack === undefined) return "ok";
    if (ack === gpuDeviceLifecycle.generation() && gpuDeviceLifecycle.isUsable()) return "ok";
    return gpuDeviceLifecycle.isUsable() ? "notreset" : "lost";
}

/**
 * The device is being Reset. Returns false while there is no device to reset onto — the
 * caller must then fail the Reset with D3DERR_DEVICELOST, which is what tells a correct app
 * to keep polling instead of proceeding onto a device that does not exist.
 */
export function acknowledgeDeviceReset(deviceKey: number): boolean {
    if (!gpuDeviceLifecycle.isUsable()) return false;
    acknowledged.set(deviceKey >>> 0, gpuDeviceLifecycle.generation());
    return true;
}

/**
 * Whether a surface's video memory is gone lives ON THE SURFACE, not in a side table keyed by
 * its guest address: COM blocks are recycled from a shared pool, so an address-keyed "lost" set
 * would hand the flag to whichever unrelated interface reused the block. Structural type so
 * this file stays free of a DirectDraw import.
 */
export interface LossTrackedSurface { surfaceLost?: boolean }

/** How many surfaces are lost right now. The hot IsLost fast path reads only this. */
let lostCount = 0;

export function markSurfaceLost(state: LossTrackedSurface): void {
    if (state.surfaceLost) return;
    state.surfaceLost = true;
    lostCount++;
}

export function isSurfaceLost(state: LossTrackedSurface): boolean {
    return state.surfaceLost === true;
}

/** Restore() succeeded — the surface is valid again (with undefined, i.e. cleared, contents). */
export function markSurfaceRestored(state: LossTrackedSurface): void {
    if (!state.surfaceLost) return;
    state.surfaceLost = false;
    lostCount--;
}

/** A surface being destroyed while lost must not leave the count (and the fast path's
 *  deferral) raised forever. */
export function forgetLossTrackedSurface(state: LossTrackedSurface): void {
    markSurfaceRestored(state);
}

export function lostSurfaceCount(): number {
    return lostCount;
}

/** Bundle load — a previous run's lost devices are not this run's state. Surfaces clear
 *  themselves with their states; the count is zeroed so a leaked flag cannot outlive the run. */
export function resetDeviceLossContract(): void {
    acknowledged.clear();
    lostCount = 0;
}
