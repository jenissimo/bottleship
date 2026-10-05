/**
 * GPU→CPU readback memoisation (plan/surface-readback.md R-A).
 *
 * `needsCPUSync` is the ENTIRE readback trigger: every Lock of a surface the GPU wrote
 * last used to answer "yes" — including the Locks that follow a readback which already
 * copied that exact content into guest memory. N Locks between two GPU writes therefore
 * cost N full-surface GPU round trips.
 *
 * The rule these tests pin: a readback records the version it satisfied, and the trigger
 * stays quiet until a writer bumps `version`. That is safe only while EVERY writer bumps
 * it, so the tests cover both directions — the memo must suppress the repeat, and it must
 * NOT survive a GPU write, a CPU write, a reset, or a version assigned from another
 * surface (flip rotation / sibling propagation), which can move `version` backwards onto
 * a number this surface already read back.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
    setAuthorityCpu,
    setAuthorityGpu,
    setAuthorityNone,
    markCpuSyncedFromGpu,
    invalidateCpuSyncedVersion,
    surfaceSyncManager,
    readbackCounters,
} from "../../src/worker/modules/ddraw/surface-sync";
import { rotateFlipChain } from "../../src/worker/modules/ddraw/flip-chain";
import type { DirectDrawSurfaceState, RenderSurface } from "../../src/worker/modules/ddraw/com-objects";

/** A GPU-backed render surface: enough state for needsCPUSync, no GPU objects needed
 *  (it only checks for a truthy gpuTexture). */
function renderSurface(surfacePtr = 0x0100_0000): RenderSurface {
    return {
        surfaceType: "render_surface",
        width: 640,
        height: 480,
        pitch: 640 * 2,
        caps: 0,
        surfacePtr,
        surfacePtrAllocated: true,
        attachedSurfaceAddr: 0,
        format: { flags: 0x40, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 },
        gpuTexture: {} as GPUTexture,
        mode: "GPU_ONLY",
        version: 0,
        gpuDirty: false,
        everLocked: false,
        lastUploadVersion: -1,
        writeGeneration: 0,
    } as unknown as RenderSurface;
}

/** What a Lock would do: ask, and count the answer as a GPU round trip when it is "yes"
 *  (the readback then reports back through markCpuSyncedFromGpu, as all three completion
 *  points in syncToCPU do). */
function lockAndMaybeReadBack(state: DirectDrawSurfaceState): boolean {
    if (!surfaceSyncManager.needsCPUSync(state).needed) return false;
    markCpuSyncedFromGpu(state);
    return true;
}

describe("ddraw GPU→CPU readback memo", () => {
    beforeEach(() => {
        delete (globalThis as { __noReadbackMemo?: boolean }).__noReadbackMemo;
        readbackCounters.reset();
    });

    test("N Locks between two GPU writes cost ONE round trip", () => {
        const s = renderSurface();
        setAuthorityGpu(s); // EndScene / flushBatch: the GPU now owns this content

        let roundTrips = 0;
        for (let i = 0; i < 16; i++) if (lockAndMaybeReadBack(s)) roundTrips++;

        expect(roundTrips).toBe(1);
        expect(readbackCounters.memoHits).toBe(15);
    });

    test("without the memo the same sequence costs one round trip per Lock", () => {
        // The A/B arm: setWorkerFlag('__noReadbackMemo', true) reproduces the old cost,
        // so the saving above is measured rather than asserted.
        (globalThis as { __noReadbackMemo?: boolean }).__noReadbackMemo = true;
        const s = renderSurface();
        setAuthorityGpu(s);

        let roundTrips = 0;
        for (let i = 0; i < 16; i++) if (lockAndMaybeReadBack(s)) roundTrips++;

        expect(roundTrips).toBe(16);
    });

    test("every GPU write re-arms the readback", () => {
        const s = renderSurface();
        let roundTrips = 0;
        for (let frame = 0; frame < 4; frame++) {
            setAuthorityGpu(s);
            for (let lock = 0; lock < 5; lock++) if (lockAndMaybeReadBack(s)) roundTrips++;
        }
        // One per distinct (surface, version) that was read-locked — never per Lock.
        expect(roundTrips).toBe(4);
    });

    test("a CPU write leaves CPU memory authoritative — no readback at all", () => {
        const s = renderSurface();
        setAuthorityGpu(s);
        expect(lockAndMaybeReadBack(s)).toBe(true);

        setAuthorityCpu(s); // Unlock-with-writes / CPU Blt
        expect(surfaceSyncManager.needsCPUSync(s).needed).toBe(false);
        expect(s.cpuSyncedVersion).not.toBe(s.version);
    });

    test("the memo does not survive a GPU write that lands on a memoised version", () => {
        const s = renderSurface();
        setAuthorityGpu(s);
        markCpuSyncedFromGpu(s);
        const memoised = s.version;

        setAuthorityGpu(s);
        expect(s.version).toBeGreaterThan(memoised);
        expect(surfaceSyncManager.needsCPUSync(s).needed).toBe(true);
    });

    test("an async readback cannot bless a newer GPU version with older pixels", () => {
        const s = renderSurface();
        setAuthorityGpu(s);
        const copiedVersion = s.version;

        // mapAsync is still pending when the next draw advances the surface.
        setAuthorityGpu(s);
        expect(markCpuSyncedFromGpu(s, copiedVersion)).toBe(false);
        expect(s.cpuSyncedVersion).not.toBe(s.version);
        expect(surfaceSyncManager.needsCPUSync(s).needed).toBe(true);

        // A retry against the current texture is allowed to satisfy the Lock.
        expect(markCpuSyncedFromGpu(s, s.version)).toBe(true);
        expect(surfaceSyncManager.needsCPUSync(s).needed).toBe(false);
    });

    test("Flip moves the memo with the storage, not with the surface identity", () => {
        const front = renderSurface(0xa000);
        const back = renderSurface(0xb000);
        setAuthorityGpu(back);
        markCpuSyncedFromGpu(back);
        const backMemo = back.cpuSyncedVersion;

        rotateFlipChain([front, back]);

        // The image (surfacePtr + texture + version) moved to the front, so the record of
        // "this image is already in guest memory" has to move with it.
        expect(front.surfacePtr).toBe(0xb000);
        expect(front.cpuSyncedVersion).toBe(backMemo);
        expect(surfaceSyncManager.needsCPUSync(front).needed).toBe(false);
        // …and must not stay behind on the surface that now holds the other image.
        expect(back.cpuSyncedVersion).toBeUndefined();
    });

    test("a version assigned from a sibling drops the memo", () => {
        // Sibling propagation (surface.ts / texture-impl.ts) ASSIGNS version across
        // surfaces that share one surfacePtr; it can move backwards onto a number this
        // surface already recorded, which would memoise content it never read back.
        const s = renderSurface();
        setAuthorityGpu(s);
        setAuthorityGpu(s);
        markCpuSyncedFromGpu(s);
        expect(surfaceSyncManager.needsCPUSync(s).needed).toBe(false);

        invalidateCpuSyncedVersion(s);
        s.version = 1; // as if a sibling's older version were propagated in
        s.gpuWrittenVersion = 1;
        expect(surfaceSyncManager.needsCPUSync(s).needed).toBe(true);
    });

    test("LOST/Restore rewinds version to 0 and clears the memo", () => {
        const s = renderSurface();
        setAuthorityGpu(s);
        markCpuSyncedFromGpu(s);

        setAuthorityNone(s);
        expect(s.cpuSyncedVersion).toBeUndefined();
        expect(s.version).toBe(0);
    });
});
