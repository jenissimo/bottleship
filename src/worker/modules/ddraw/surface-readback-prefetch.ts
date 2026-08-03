/**
 * Version-validated GPU→CPU readback prefetch (plan/surface-readback.md R-D).
 *
 * Surfaces that have been read-Locked become candidates. After a real GPU write,
 * kick syncToCPU without awaiting. On Lock, await the in-flight promise when its
 * captured version still matches — never serve a mismatched prefetch.
 */
import type { DirectDrawSurfaceState } from "./com-objects";
import { isRenderSurface } from "./com-objects";
import { registerSurfaceTeardownHook } from "./surface-teardown";

const DECAY_FRAMES = 8;

interface InflightPrefetch {
    version: number;
    promise: Promise<boolean>;
}

const candidates = new Set<DirectDrawSurfaceState>();
const idleFrames = new WeakMap<DirectDrawSurfaceState, number>();
const inflight = new WeakMap<DirectDrawSurfaceState, InflightPrefetch>();

registerSurfaceTeardownHook((state) => {
    candidates.delete(state);
    inflight.delete(state);
});

/** Guest read-Locked this surface — keep it on the prefetch list. */
export function noteReadLockCandidate(state: DirectDrawSurfaceState): void {
    if (!isRenderSurface(state) || !state.surfacePtr || !state.gpuTexture) return;
    candidates.add(state);
    idleFrames.set(state, 0);
}

/**
 * Await an in-flight prefetch for this exact version. Returns true when guest
 * memory already holds the pixels (prefetch completed markCpuSyncedFromGpu).
 */
export async function awaitInflightPrefetch(state: DirectDrawSurfaceState): Promise<boolean> {
    if (!isRenderSurface(state)) return false;
    const slot = inflight.get(state);
    if (!slot || slot.version !== state.version) return false;
    try {
        await slot.promise;
    } finally {
        const cur = inflight.get(state);
        if (cur && cur.version === slot.version) inflight.delete(state);
    }
    return state.cpuSyncedVersion === state.version;
}

/**
 * After EndScene/endFrame flush: start readbacks for candidates the GPU just wrote.
 * `sync` must be the real syncToCPU (not syncSurfaceToMemory — that re-flushes).
 */
export function pumpReadbackPrefetch(
    sync: (state: DirectDrawSurfaceState) => Promise<boolean>
): void {
    if (candidates.size === 0) return;

    for (const state of [...candidates]) {
        if (!isRenderSurface(state) || !state.gpuTexture || !state.surfacePtr) {
            candidates.delete(state);
            continue;
        }

        const idle = (idleFrames.get(state) ?? 0) + 1;
        idleFrames.set(state, idle);
        if (idle > DECAY_FRAMES) {
            candidates.delete(state);
            continue;
        }

        if (state.gpuWrittenVersion !== state.version) continue;
        if (state.cpuSyncedVersion === state.version) continue;
        if (inflight.has(state)) continue;

        const version = state.version;
        const promise = sync(state)
            .then((ok) => ok)
            .catch(() => false)
            .finally(() => {
                const cur = inflight.get(state);
                if (cur && cur.version === version) inflight.delete(state);
            });
        inflight.set(state, { version, promise });
    }
}
