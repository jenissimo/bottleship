/**
 * The D3DLOCK_* flag algebra, shared by D3D8 and D3D9.
 *
 * Both APIs spell the flags identically and both are implemented over the same driver
 * contract, so the strip rules belong in one place. They come from DXVK's `LockImage`
 * (`src/d3d9/d3d9_device.cpp`), the closest thing to a written-down driver contract:
 *
 *   - DISCARD | READONLY on POOL_DEFAULT is invalid outright (:4956-4958).
 *   - DONOTWAIT is stripped for images (:4960-4962) — apps pass it and then spin on Map
 *     until it succeeds, so answering D3DERR_WASSTILLDRAWING deadlocks them.
 *   - DISCARD | NOOVERWRITE is contradictory; DISCARD loses (:4964-4965).
 *   - DISCARD is honoured only for a FULL-resource lock on POOL_DEFAULT (:5026-5027).
 *     Wiping a whole surface because the app discarded a sub-rect destroys pixels it
 *     never named.
 *   - WRITEONLY strips READONLY (:5029-5030).
 *
 * What each API's storage model then DOES with the decision differs, so this module stops
 * at the flags: it says what the app asked for after the contradictions are resolved, and
 * the caller decides which of its copies must move.
 *
 * Leaf module: imports only the geometry helper, so it stays out of the d3d8/d3d9/ddraw
 * circular init graph and takes the resource's shape rather than the resource.
 */
import { clipLockRect, type LockRect } from "../ddraw/readback-region";

export type { LockRect };

export const D3DLOCK_READONLY = 0x00000010;
export const D3DLOCK_NOOVERWRITE = 0x00001000;
export const D3DLOCK_DISCARD = 0x00002000;
export const D3DLOCK_DONOTWAIT = 0x20000000;

/** True when the rect names every pixel — the only extent DISCARD may be honoured at. */
export function locksFullResource(
    rect: LockRect | null,
    width: number,
    height: number
): boolean {
    return clipLockRect(rect, width, height) === null;
}

export interface LockFlagDecision {
    /** The app may write through the returned pointer (READONLY was not set). */
    write: boolean;
    /** READONLY as the app passed it — the flag that also means "do not accumulate a dirty box". */
    readOnly: boolean;
    /** DISCARD survived the strip rules: the old contents need not be produced at all. */
    discard: boolean;
    /** DISCARD was asked for and stripped — the census distinguishes this from never asking. */
    discardStripped: boolean;
    /** Sub-rect the lock named, or null for the whole resource. */
    box: LockRect | null;
    /** The flag combination is illegal and Lock must fail with D3DERR_INVALIDCALL. */
    invalid: boolean;
}

/**
 * Resolve one D3DLOCK_* flag word against the resource's shape.
 *
 * `poolDefault` is D3DPOOL_DEFAULT: DISCARD is a POOL_DEFAULT-only renaming hint, and it is
 * also the pool the illegal DISCARD|READONLY combination is rejected for.
 */
export function decideLockFlags(
    flags: number,
    rect: LockRect | null,
    width: number,
    height: number,
    poolDefault: boolean,
): LockFlagDecision {
    const readOnly = (flags & D3DLOCK_READONLY) !== 0;
    const requestedDiscard = (flags & D3DLOCK_DISCARD) !== 0;
    const fullResource = locksFullResource(rect, width, height);

    let discard = requestedDiscard;
    const invalid = discard && readOnly && poolDefault;
    if (discard && (flags & D3DLOCK_NOOVERWRITE) !== 0) discard = false;
    if (!fullResource || !poolDefault) discard = false;

    return {
        write: !readOnly,
        readOnly,
        discard,
        discardStripped: requestedDiscard && !discard,
        box: clipLockRect(rect, width, height),
        invalid,
    };
}

/**
 * A Lock census, recorded at the decision point.
 *
 * It measures the OPPORTUNITY independently of whether the download is scoped yet:
 * `requestedPixels` against `surfacePixels` says how much of each locked resource the app
 * actually named, so "scoping the readback would pay" is a measurement rather than an
 * inference. `locks: 0` while a readback counter climbs means the census is not wired — a
 * different statement from "no locks happened", which is what a bare zero would be.
 */
export interface LockCensus {
    /** Lock decisions taken (GPU-backed resources and CPU-only ones alike). */
    locks: number;
    /** Of `locks`, the ones on a resource whose pixels also live on the GPU. */
    renderSurfaceLocks: number;
    /** Locks that named a strict sub-rect. */
    partialRectLocks: number;
    /** Locks whose decision asked for a GPU→CPU read. */
    readLocks: number;
    /** Read locks that are box-scopable (read and not write) — the addressable population. */
    scopableLocks: number;
    /** Pixels the app actually named, summed over GPU-backed locks. */
    requestedPixels: number;
    /** Pixels those resources hold in full — `requestedPixels/surfacePixels` is the ceiling
     *  on what scoping can save. Equal totals mean the locks cover the resource anyway. */
    surfacePixels: number;
    /** Locks that arrived with DISCARD set. */
    discardRequested: number;
    /** Of those, the ones the strip rules rejected (partial rect, non-DEFAULT pool, or
     *  NOOVERWRITE). Honouring these would wipe the whole resource. */
    discardStripped: number;
    /** DISCARD|READONLY on POOL_DEFAULT — rejected as D3DERR_INVALIDCALL. */
    invalidCombos: number;
    reset(): void;
}

export function makeLockCensus(): LockCensus {
    return {
        locks: 0,
        renderSurfaceLocks: 0,
        partialRectLocks: 0,
        readLocks: 0,
        scopableLocks: 0,
        requestedPixels: 0,
        surfacePixels: 0,
        discardRequested: 0,
        discardStripped: 0,
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
}

/** Record one Lock decision in a census. */
export function noteLock(
    census: LockCensus,
    shape: { width: number; height: number; splitStorage: boolean },
    decision: { box: LockRect | null; discardStripped: boolean; invalid: boolean },
    asked: { discard: boolean; read: boolean; scopable: boolean },
): void {
    census.locks++;
    if (decision.box) census.partialRectLocks++;
    if (asked.read) census.readLocks++;
    if (asked.scopable) census.scopableLocks++;
    if (asked.discard) {
        census.discardRequested++;
        if (decision.discardStripped) census.discardStripped++;
    }
    if (decision.invalid) census.invalidCombos++;
    if (!shape.splitStorage) return;
    census.renderSurfaceLocks++;
    census.surfacePixels += shape.width * shape.height;
    census.requestedPixels += decision.box
        ? (decision.box.right - decision.box.left) * (decision.box.bottom - decision.box.top)
        : shape.width * shape.height;
}
