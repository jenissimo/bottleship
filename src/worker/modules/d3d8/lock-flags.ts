/**
 * D3D8 LockRect flag algebra.
 *
 * Analogous to the DirectDraw one, not identical: D3D8 spells its flags D3DLOCK_* and
 * decides DISCARD on the extent of the lock, which DDLOCK_DISCARDCONTENTS does not.
 * The rules come from DXVK's `LockImage` (d3d9_device.cpp), which is the same flag set
 * D3D8 uses and the closest thing to a written-down driver contract:
 *
 *   - DISCARD is honoured only for a FULL-resource lock on POOL_DEFAULT; a partial or
 *     managed lock has it stripped (:5025-5026). Wiping a whole surface because the app
 *     discarded a sub-rect destroys pixels it never named.
 *   - DISCARD | NOOVERWRITE is contradictory; DISCARD loses (:4965-4966).
 *   - DISCARD | READONLY on POOL_DEFAULT is invalid outright (:4955-4957).
 *   - READONLY narrows which pending GPU work must finish (WaitForResource :4878-4880),
 *     not whether the readback happens: a render target is read back unconditionally
 *     because it is `renderable` (:5033-5041).
 *   - DONOTWAIT is stripped for images (:4959-4961) — DXVK notes apps spin on Map until
 *     it succeeds, so a texture Lock never answers D3DERR_WASSTILLDRAWING.
 *
 * Leaf module: it imports only the geometry helpers, so it stays out of the
 * d3d8/ddraw circular init graph and takes the surface's shape rather than the surface.
 */
import { clipLockRect, type LockRect } from "../ddraw/readback-region";

export type { LockRect };

export const D3DLOCK_READONLY = 0x00000010;
export const D3DLOCK_NOOVERWRITE = 0x00001000;
export const D3DLOCK_DISCARD = 0x00002000;
export const D3DLOCK_DONOTWAIT = 0x20000000;

/** What the Lock prologue needs to know about the surface it is acquiring. */
export interface D3D8LockSurfaceShape {
    width: number;
    height: number;
    /** Pixels live in guest memory AND in a GPU texture — true for a render surface. */
    splitStorage: boolean;
    /** D3DPOOL_DEFAULT. DISCARD is a POOL_DEFAULT-only renaming hint. */
    poolDefault: boolean;
}

export interface D3D8LockSyncDecision {
    /** Guest memory must hold the surface's current GPU bytes before Lock returns. */
    read: boolean;
    /** The app may write through the returned pointer. */
    write: boolean;
    /** DISCARD survived the strip rules: the old contents need not be produced at all. */
    discard: boolean;
    /** `read` was forced to preserve GPU bytes under a partial write, not asked for. */
    preserveForWrite: boolean;
    /** Sub-rect to download, or null for the whole surface. */
    box: LockRect | null;
    /** The flag combination is illegal and Lock must fail. */
    invalid: boolean;
}

/** True when the rect names every pixel — the only extent DISCARD may be honoured at. */
export function locksFullResource(
    rect: LockRect | null,
    width: number,
    height: number
): boolean {
    return clipLockRect(rect, width, height) === null;
}

/**
 * Whether our split CPU/GPU storage must preserve the current GPU bytes before exposing a
 * writable CPU pointer. Native drivers hand back the resource's own storage; we hand back
 * a separate guest copy, so anything the app does not overwrite must already be there.
 * Only a surviving DISCARD makes preservation unnecessary.
 */
function preserveGpuBytesForWrite(discard: boolean, splitStorage: boolean): boolean {
    return splitStorage && !discard;
}

/**
 * The whole D3D8 Lock prologue as one decision. It decides; the caller does the work,
 * because the tails differ (render surface vs CPU bitmap) and only the decision is shared.
 */
export function decideD3D8LockSync(
    surface: D3D8LockSurfaceShape,
    flags: number,
    rect: LockRect | null
): D3D8LockSyncDecision {
    const readOnly = (flags & D3DLOCK_READONLY) !== 0;
    const fullResource = locksFullResource(rect, surface.width, surface.height);

    let discard = (flags & D3DLOCK_DISCARD) !== 0;
    const invalid = discard && readOnly && surface.poolDefault;
    if (discard && (flags & D3DLOCK_NOOVERWRITE) !== 0) discard = false;
    if (!fullResource || !surface.poolDefault) discard = false;

    const write = !readOnly;
    const preserveForWrite = write && preserveGpuBytesForWrite(discard, surface.splitStorage);
    const read = !discard && (readOnly || preserveForWrite);

    // Box-scoping is confined to locks that cannot write. A writable lock's Unlock uploads
    // a bounding box that covers pixels no lock preserved, so a rect-scoped preserve would
    // push stale CPU pixels back over good GPU ones.
    const box = read && !write ? clipLockRect(rect, surface.width, surface.height) : null;

    return { read, write, discard, preserveForWrite, box, invalid };
}

/**
 * D3D8 Lock census, recorded at the decision point.
 *
 * It measures the OPPORTUNITY independently of whether the download is scoped yet:
 * `requestedPixels` against `surfacePixels` says how much of each locked surface the app
 * actually named, so "scoping the readback would pay" is a measurement rather than an
 * inference from the ddraw result. Read it with the `d3d8LockStats` harness verb.
 *
 * `locks: 0` while `readbackStats` counts round trips means this census is not wired —
 * a different statement from "no locks happened", which is what a bare zero would be.
 */
export const d3d8LockCounters = {
    /** Lock decisions taken (render surfaces and CPU bitmaps alike). */
    locks: 0,
    /** Of `locks`, the ones on a render surface — the only ones that can cost a round trip. */
    renderSurfaceLocks: 0,
    /** Locks that named a strict sub-rect. */
    partialRectLocks: 0,
    /** Locks whose decision asked for a GPU→CPU read. */
    readLocks: 0,
    /** Read locks that are box-scopable (read and not write) — the addressable population. */
    scopableLocks: 0,
    /** Pixels the app actually named, summed over render-surface locks. */
    requestedPixels: 0,
    /** Pixels those surfaces hold in full — `requestedPixels/surfacePixels` is the ceiling
     *  on what scoping can save. Equal totals mean the locks cover the surface anyway. */
    surfacePixels: 0,
    /** Locks that arrived with DISCARD set. */
    discardRequested: 0,
    /** Of those, the ones the strip rules rejected (partial rect, non-DEFAULT pool, or
     *  NOOVERWRITE). Before the strip rules these wiped the whole surface. */
    discardStripped: 0,
    /** DISCARD|READONLY on POOL_DEFAULT — rejected as D3DERR_INVALIDCALL. */
    invalidCombos: 0,
    reset(): void {
        this.locks = 0;
        this.renderSurfaceLocks = 0;
        this.partialRectLocks = 0;
        this.readLocks = 0;
        this.scopableLocks = 0;
        this.requestedPixels = 0;
        this.surfacePixels = 0;
        this.discardRequested = 0;
        this.discardStripped = 0;
        this.invalidCombos = 0;
    },
};

/** Record one Lock decision in the census. */
export function noteD3D8Lock(
    surface: D3D8LockSurfaceShape,
    flags: number,
    rect: LockRect | null,
    decision: D3D8LockSyncDecision
): void {
    const c = d3d8LockCounters;
    c.locks++;
    const clipped = clipLockRect(rect, surface.width, surface.height);
    if (clipped) c.partialRectLocks++;
    if (decision.read) c.readLocks++;
    if (decision.read && !decision.write) c.scopableLocks++;
    if ((flags & D3DLOCK_DISCARD) !== 0) {
        c.discardRequested++;
        if (!decision.discard) c.discardStripped++;
    }
    if (decision.invalid) c.invalidCombos++;
    if (!surface.splitStorage) return;
    c.renderSurfaceLocks++;
    c.surfacePixels += surface.width * surface.height;
    c.requestedPixels += clipped
        ? (clipped.right - clipped.left) * (clipped.bottom - clipped.top)
        : surface.width * surface.height;
}

/**
 * DXVK strips DONOTWAIT for image-backed resources (:4959-4961): apps pass it and then
 * spin on Map until it succeeds, so answering D3DERR_WASSTILLDRAWING deadlocks them.
 * Named rather than inlined so the kill switch can restore the pre-change behaviour of
 * never consulting the flag at all.
 */
export function d3d8LockMustNotBlock(flags: number): boolean {
    if ((globalThis as { __d3d8LockDoNotWait?: boolean }).__d3d8LockDoNotWait !== true) {
        return false;
    }
    return (flags & D3DLOCK_DONOTWAIT) !== 0;
}
