/**
 * The D3D9 lock/readback census — read it with the `d3d9LockStats` harness verb.
 *
 * Serving a Lock correctly now costs work that used to not happen at all, so the counters have
 * to be able to say WHICH work: a `publishes` that climbs is a memcpy per lock, a
 * `lockReadbacks` that climbs is a GPU round trip per lock, and those have very different
 * prices. A zero here while pixels are visibly correct is the shape of an unwired census, not
 * of a free fix — `locks` and `downloads` together say which it is.
 *
 * Leaf module: no imports beyond the shared census factory, so both the backend and the module
 * layer can reach it without a cycle.
 */
import { makeLockCensus } from "../d3d-common/lock-flags";

/** Flag-algebra census, populated at the LockRect decision point. */
export const d3d9LockCounters = makeLockCensus();

export const d3d9ReadbackCounters = {
    /** GPU→CPU downloads performed (from either entry point below). */
    downloads: 0,
    /** Pixels moved by those downloads — the size, not just the count. */
    downloadedPixels: 0,
    /** Of `downloads`, the ones GetRenderTargetData asked for. */
    getRenderTargetData: 0,
    /** Of `downloads`, the ones a LockRect of a renderable image asked for. */
    lockReadbacks: 0,
    /** Locks that copied the CPU copy into the guest buffer (no GPU involved). */
    publishes: 0,
    reset(): void {
        this.downloads = 0;
        this.downloadedPixels = 0;
        this.getRenderTargetData = 0;
        this.lockReadbacks = 0;
        this.publishes = 0;
    },
};
