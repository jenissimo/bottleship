/**
 * Hooks run when a DirectDrawSurface is destroyed.
 *
 * Some per-surface caches live outside the state object and are keyed by it (the GPU
 * readback staging pool, for one) — nothing else owns them, so they need a teardown
 * signal. The registry lives in its own module so the owner of a cache and the surface
 * object never import each other.
 */
import type { DirectDrawSurfaceState } from "./com-objects";

const hooks: ((state: DirectDrawSurfaceState) => void)[] = [];

export function registerSurfaceTeardownHook(hook: (state: DirectDrawSurfaceState) => void): void {
    hooks.push(hook);
}

export function runSurfaceTeardownHooks(state: DirectDrawSurfaceState): void {
    for (const hook of hooks) hook(state);
}
