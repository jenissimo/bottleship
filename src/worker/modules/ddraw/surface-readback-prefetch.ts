/**
 * Version-validated GPU→CPU readback prefetch (plan/surface-readback.md R-D).
 *
 * Surfaces that have been read-Locked become candidates. After a real GPU write,
 * kick syncToCPU without awaiting. On Lock, await the in-flight promise when its
 * captured version still matches — never serve a mismatched prefetch.
 *
 * Two kick points, because the right moment depends on how the title presents:
 * endFrame for a Blt-presenting surface, and immediately after a Flip rotated the chain
 * for a flip-chain member (see the two pump functions below).
 */
import type { DirectDrawSurfaceState } from "./com-objects";
import { isRenderSurface } from "./com-objects";
import { DDSCAPS_FLIP } from "./constants";
import { registerSurfaceTeardownHook } from "./surface-teardown";

const DECAY_FRAMES = 8;

/**
 * Frames elapsed, for the decay. Deliberately NOT a count of pump calls: endFrame runs
 * once per EndScene and a title issues a dozen of those per frame, so a pump-counted
 * decay expires a candidate inside the very frame it was read-Locked in. A Flip is the
 * real frame boundary and takes over the tick as soon as one happens; a title that
 * presents by Blt never flips, and for it the endFrame pump remains the only clock.
 */
let epoch = 0;
let flipDrivesEpoch = false;

interface InflightPrefetch {
    version: number;
    promise: Promise<boolean>;
}

/** Prefetch accounting. Without it the whole mechanism can be silently dead — a Lock
 *  still returns the right pixels, it just pays the full round trip, and every counter
 *  that exists here reads identically either way.
 *
 *  READ IT WITH `readbackStats`: a prefetch that finished in time is invisible in this
 *  table, because Lock's needsCPUSync then answers "already synced" and never enters
 *  syncToCPU at all — that win lands in `readbackStats.memoHits`. The rows below say what
 *  happened to the kicks themselves: `awaitedInflight` = started, but only in time to
 *  overlap rather than to hide; `versionMiss` = finished for a version the Lock no longer
 *  wants (pure waste); `skipped*` = which gate turned a kick away. */
export const prefetchCounters = {
    /** Surfaces on the candidate list right now. */
    candidates: 0,
    /** Prefetch round trips kicked off at endFrame. */
    started: 0,
    /** syncToCPU was entered for a version already in guest memory. Rare: the Lock path
     *  normally short-circuits earlier and scores a readbackStats.memoHit instead. */
    servedFresh: 0,
    /** Lock had to await a still-in-flight prefetch — partially hidden. */
    awaitedInflight: 0,
    /** Lock found an in-flight prefetch for a STALE version — it was wasted work. */
    versionMiss: 0,
    /** Pump skipped: the GPU has not written this version (a CPU write bumped it). */
    skippedNotGpuWritten: 0,
    /** Pump skipped: already synced at this version. */
    skippedAlreadySynced: 0,
    /** Pump skipped: a prefetch for this surface is still in flight. */
    skippedInflight: 0,
    /** Candidates dropped after DECAY_FRAMES with no read-Lock. */
    decayed: 0,
    /** endFrame pump passed over a flip-chain member — prefetchAfterFlip owns those. */
    skippedFlipMember: 0,
    reset(): void {
        this.started = 0;
        this.servedFresh = 0;
        this.awaitedInflight = 0;
        this.versionMiss = 0;
        this.skippedNotGpuWritten = 0;
        this.skippedAlreadySynced = 0;
        this.skippedInflight = 0;
        this.decayed = 0;
        this.skippedFlipMember = 0;
    },
};

const candidates = new Set<DirectDrawSurfaceState>();
/** Epoch of the last read-Lock, per candidate. */
const lastReadLockEpoch = new WeakMap<DirectDrawSurfaceState, number>();
const inflight = new WeakMap<DirectDrawSurfaceState, InflightPrefetch>();

registerSurfaceTeardownHook((state) => {
    candidates.delete(state);
    inflight.delete(state);
});

/** Guest read-Locked this surface — keep it on the prefetch list. */
export function noteReadLockCandidate(state: DirectDrawSurfaceState): void {
    if (!isRenderSurface(state) || !state.surfacePtr || !state.gpuTexture) return;
    candidates.add(state);
    lastReadLockEpoch.set(state, epoch);
}

/**
 * Await an in-flight prefetch for this exact version. Returns true when guest
 * memory already holds the pixels (prefetch completed markCpuSyncedFromGpu).
 */
export async function awaitInflightPrefetch(state: DirectDrawSurfaceState): Promise<boolean> {
    if (!isRenderSurface(state)) return false;
    if (state.cpuSyncedVersion === state.version) {
        prefetchCounters.servedFresh++;
        return true;
    }
    const slot = inflight.get(state);
    if (!slot || slot.version !== state.version) {
        if (slot) prefetchCounters.versionMiss++;
        return false;
    }
    prefetchCounters.awaitedInflight++;
    try {
        await slot.promise;
    } finally {
        const cur = inflight.get(state);
        if (cur && cur.version === slot.version) inflight.delete(state);
    }
    return state.cpuSyncedVersion === state.version;
}

/** Gates + kick, shared by both pump phases. */
function startPrefetch(
    state: DirectDrawSurfaceState,
    sync: (state: DirectDrawSurfaceState) => Promise<boolean>
): void {
    if (!isRenderSurface(state)) return;
    if (state.gpuWrittenVersion !== state.version) { prefetchCounters.skippedNotGpuWritten++; return; }
    if (state.cpuSyncedVersion === state.version) { prefetchCounters.skippedAlreadySynced++; return; }
    if (inflight.has(state)) { prefetchCounters.skippedInflight++; return; }

    prefetchCounters.started++;
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

/**
 * After EndScene/endFrame flush: start readbacks for candidates the GPU just wrote.
 * `sync` must be the real syncToCPU (not syncSurfaceToMemory — that re-flushes).
 *
 * Flip-chain members ARE included: a title that read-Locks the finished frame does so
 * between the last draw and the Flip, and this is the only kick point early enough to
 * cover it. A kick still in flight when the Flip arrives is wasted (Flip rotates STORAGE
 * between slots and `version` travels with the pixels, so the record no longer matches
 * the slot) — that waste is counted as `versionMiss`, not assumed away. The complementary
 * kick for the write-Lock that FOLLOWS a Flip is prefetchAfterFlip().
 *
 * Kill switch for the A/B: setWorkerFlag('__noEndFramePrefetch', true).
 */
export function pumpReadbackPrefetch(
    sync: (state: DirectDrawSurfaceState) => Promise<boolean>
): void {
    prefetchCounters.candidates = candidates.size;
    if (!flipDrivesEpoch) epoch++;
    if (candidates.size === 0) return;
    const skipFlipMembers = !!(globalThis as { __noEndFramePrefetch?: boolean }).__noEndFramePrefetch;

    for (const state of [...candidates]) {
        if (!isRenderSurface(state) || !state.gpuTexture || !state.surfacePtr) {
            candidates.delete(state);
            continue;
        }

        if (epoch - (lastReadLockEpoch.get(state) ?? epoch) > DECAY_FRAMES) {
            candidates.delete(state);
            prefetchCounters.decayed++;
            continue;
        }

        if (skipFlipMembers && (state.caps & DDSCAPS_FLIP) !== 0) {
            prefetchCounters.skippedFlipMember++;
            continue;
        }

        startPrefetch(state, sync);
    }
}

/**
 * Right after a Flip rotated the chain: start the readback for the members the guest
 * read-Locks. This is the moment the pixels and their version have settled and nothing
 * will move them until the next Flip, and the caller then spends the frame-pacer wait —
 * otherwise dead time — with the copy already in flight.
 */
export function prefetchAfterFlip(
    states: readonly DirectDrawSurfaceState[],
    sync: (state: DirectDrawSurfaceState) => Promise<boolean>
): void {
    flipDrivesEpoch = true;
    epoch++;
    if (candidates.size === 0) return;
    if ((globalThis as { __noPostFlipPrefetch?: boolean }).__noPostFlipPrefetch) return;

    // A read-Lock candidate anywhere in the chain makes the WHOLE chain worth prefetching.
    // The app read-Locks a SLOT, but Flip rotates storage through it, so the pixels it will
    // read next are the ones sitting in a sibling slot right now. Reading them here buys a
    // full frame of lead instead of the few microseconds between this Flip and the Lock that
    // follows it — and the memo (`cpuSyncedVersion`) is part of the storage, so it travels
    // with the pixels through the rotation and is still valid when they arrive.
    if (!states.some((s) => candidates.has(s))) return;
    for (const state of states) {
        if (!isRenderSurface(state) || !state.gpuTexture || !state.surfacePtr) continue;
        startPrefetch(state, sync);
    }
}
