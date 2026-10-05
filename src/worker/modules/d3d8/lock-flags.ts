/**
 * D3D8's half of the LockRect decision: the shared D3DLOCK_* algebra (`d3d-common/lock-flags`)
 * plus what D3D8's split CPU/GPU storage must do about it.
 *
 * The strip rules and the census live in the shared module because D3D9 spells the same flags
 * against the same driver contract; what stays here is the storage model — native drivers hand
 * back the resource's own memory, we hand back a separate guest copy, so anything the app does
 * not overwrite must already be in it.
 */
import {
    D3DLOCK_DISCARD, D3DLOCK_DONOTWAIT,
    decideLockFlags, locksFullResource, makeLockCensus, noteLock,
    type LockRect,
} from "../d3d-common/lock-flags";

export type { LockRect };
export {
    D3DLOCK_READONLY, D3DLOCK_NOOVERWRITE, D3DLOCK_DISCARD, D3DLOCK_DONOTWAIT,
    locksFullResource,
} from "../d3d-common/lock-flags";

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

/**
 * Whether our split CPU/GPU storage must preserve the current GPU bytes before exposing a
 * writable CPU pointer. Only a surviving DISCARD makes preservation unnecessary.
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
    const f = decideLockFlags(flags, rect, surface.width, surface.height, surface.poolDefault);

    const write = f.write;
    const preserveForWrite = write && preserveGpuBytesForWrite(f.discard, surface.splitStorage);
    const read = !f.discard && (f.readOnly || preserveForWrite);

    // Box-scoping is confined to locks that cannot write. A writable lock's Unlock uploads
    // a bounding box that covers pixels no lock preserved, so a rect-scoped preserve would
    // push stale CPU pixels back over good GPU ones.
    const box = read && !write ? f.box : null;

    return { read, write, discard: f.discard, preserveForWrite, box, invalid: f.invalid };
}

/** D3D8 Lock census — read it with the `d3d8LockStats` harness verb. */
export const d3d8LockCounters = makeLockCensus();

/** Record one Lock decision in the census. */
export function noteD3D8Lock(
    surface: D3D8LockSurfaceShape,
    flags: number,
    rect: LockRect | null,
    decision: D3D8LockSyncDecision
): void {
    const f = decideLockFlags(flags, rect, surface.width, surface.height, surface.poolDefault);
    noteLock(d3d8LockCounters, surface, f, {
        discard: (flags & D3DLOCK_DISCARD) !== 0,
        read: decision.read,
        scopable: decision.read && !decision.write,
    });
}

/**
 * DXVK strips DONOTWAIT for image-backed resources (d3d9_device.cpp:4960-4962): apps pass it
 * and then spin on Map until it succeeds, so answering D3DERR_WASSTILLDRAWING deadlocks them.
 * Named rather than inlined so the kill switch can restore the pre-change behaviour of never
 * consulting the flag at all.
 */
export function d3d8LockMustNotBlock(flags: number): boolean {
    if ((globalThis as { __d3d8LockDoNotWait?: boolean }).__d3d8LockDoNotWait !== true) {
        return false;
    }
    return (flags & D3DLOCK_DONOTWAIT) !== 0;
}
