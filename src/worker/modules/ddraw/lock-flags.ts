/**
 * DirectDraw Lock flag algebra — 1:1 with wine
 * `wined3dmapflags_from_ddrawmapflags` (dlls/ddraw/utils.c:561-584).
 *
 * READ  is implied unless (NOOVERWRITE | DISCARDCONTENTS | WRITEONLY)
 * WRITE is implied unless READONLY
 * if neither results → both
 *
 * READ and WRITE are two separate verbs over one location word (wine
 * ddraw_private.h:660-680): READ means "make this location valid", WRITE means
 * "make this location exclusive". They are computed together and consumed apart.
 *
 * Flag literals are inlined (not imported from constants.ts) so this module
 * stays free of the ddraw/d3d circular init graph — which is also why the caller
 * passes the surface's shape rather than the surface.
 */
import { clipLockRect, type LockRect } from "./readback-region";

export type { LockRect };

const DDLOCK_WAIT = 0x00000001;
const DDLOCK_READONLY = 0x00000010;
const DDLOCK_WRITEONLY = 0x00000020;
const DDLOCK_NOOVERWRITE = 0x00001000;
const DDLOCK_DISCARDCONTENTS = 0x00002000;
const DDLOCK_DONOTWAIT = 0x00004000;

/** What the Lock prologue needs to know about the surface. `splitStorage` is true for a
 *  render surface, whose pixels live in guest memory AND in a GPU texture. */
export interface LockSurfaceShape {
    width: number;
    height: number;
    splitStorage: boolean;
}

export interface LockSyncDecision {
    /** Guest memory must hold the surface's current GPU bytes before Lock returns. */
    read: boolean;
    /** The app may write through the returned pointer. */
    write: boolean;
    /** `read` was forced by the preserve rule below, not asked for by the app. */
    preserveForWrite: boolean;
    /** Sub-rect to download, or null for the whole surface. */
    box: LockRect | null;
    /** The app passed DDLOCK_WAIT: it accepts blocking. Without it an acquire that cannot
     *  be satisfied immediately must answer DDERR_WASSTILLDRAWING rather than block
     *  (DXVK d3d9_device.cpp:5126-5127). */
    wait: boolean;
    /** Diagnostic switch: serve this read Lock from the CPU bytes we already have and
     *  measure the divergence instead of waiting for the round trip. */
    serveStale: boolean;
}

export function lockImpliesRead(flags: number): boolean {
    return (flags & (DDLOCK_NOOVERWRITE | DDLOCK_DISCARDCONTENTS | DDLOCK_WRITEONLY)) === 0;
}

export function lockImpliesWrite(flags: number): boolean {
    return (flags & DDLOCK_READONLY) === 0;
}

/** Wine: if neither READ nor WRITE survived, both are forced on. */
export function lockImpliesReadOrWrite(flags: number): { read: boolean; write: boolean } {
    let read = lockImpliesRead(flags);
    let write = lockImpliesWrite(flags);
    if (!read && !write) {
        read = true;
        write = true;
    }
    return { read, write };
}

/**
 * Whether our split CPU/GPU storage must preserve the current GPU bytes before exposing a
 * writable CPU pointer, even though the app said it will not read them.
 *
 * Native drivers may map WRITEONLY/NOOVERWRITE resource storage directly. We cannot: an
 * unchanged byte in stale guest memory is indistinguishable from a guest write that
 * restores that byte to the same value, so a diff-based partial upload leaves old GPU
 * pixels behind. Only DISCARDCONTENTS makes preservation unnecessary.
 */
function preserveGpuBytesForWrite(flags: number, splitStorage: boolean): boolean {
    return splitStorage && (flags & DDLOCK_DISCARDCONTENTS) === 0;
}

/**
 * The whole Lock prologue as one decision. It decides; the caller does the work, because
 * the tails differ per interface version (DDSURFACEDESC vs DDSURFACEDESC2, the z-buffer
 * branch) and only the decision is shared.
 */
export function decideLockSync(
    surface: LockSurfaceShape,
    flags: number,
    rect: LockRect | null
): LockSyncDecision {
    const { read: appReads, write } = lockImpliesReadOrWrite(flags);
    const preserveForWrite = !appReads && write && preserveGpuBytesForWrite(flags, surface.splitStorage);
    const read = appReads || preserveForWrite;

    // Box-scoping is confined to locks that cannot write. Unlock uploads the UNION of the
    // rects written since the last upload, and that bounding box covers pixels no lock
    // preserved — a rect-scoped preserve would push stale CPU pixels over good GPU ones.
    const box = read && !write ? clipLockRect(rect, surface.width, surface.height) : null;

    return {
        read,
        write,
        preserveForWrite,
        box,
        wait: (flags & DDLOCK_WAIT) !== 0,
        serveStale: read && readLockDivergenceEnabled(flags),
    };
}

// ============================================================================
// READ-LOCK DIVERGENCE INSTRUMENT
// ============================================================================

/**
 * `setWorkerFlag('__noReadLockReadback', true)` serves a READONLY Lock from the CPU bytes
 * we already hold instead of waiting for the GPU→CPU round trip — and then starts the
 * round trip anyway, so that when it lands we can say by how much the answer we gave was
 * wrong. DDLOCK_READONLY says the app will not write; it does not say it will read, and a
 * full-surface read Lock costs a whole round trip whether the app reads one pixel or none.
 *
 * Read the counters with the `readLockDivergence` harness verb. `framesDiverged === 0` is
 * evidence only when `readbacksCompared > 0`; otherwise the comparison never ran.
 */
function readLockDivergenceEnabled(flags: number): boolean {
    return (flags & DDLOCK_READONLY) !== 0
        && (globalThis as { __noReadLockReadback?: boolean }).__noReadLockReadback === true;
}

export const readLockDivergenceCounters = {
    /** Locks answered from CPU bytes without waiting for the readback. */
    locksServedStale: 0,
    /** Readbacks that reached the comparison — the denominator of every row below. */
    readbacksCompared: 0,
    /** A stale serve whose readback landed on a path that cannot compare (CPU slow path,
     *  where the incoming bytes are RGBA, not surface format). Non-zero means the sample
     *  is smaller than `locksServedStale` suggests. */
    comparisonsSkipped: 0,
    /** Comparisons in which at least one byte differed. */
    framesDiverged: 0,
    /** Pixels that differed, summed over all comparisons. */
    pixelsDiverged: 0,
    /** Largest absolute per-BYTE difference seen. For a 32-bit surface a byte is one
     *  channel; for a packed 16-bit surface it is half a pixel, so read it with the
     *  `bytesPerPixel` the verb reports. */
    maxChannelDelta: 0,
    reset(): void {
        this.locksServedStale = 0;
        this.readbacksCompared = 0;
        this.comparisonsSkipped = 0;
        this.framesDiverged = 0;
        this.pixelsDiverged = 0;
        this.maxChannelDelta = 0;
    },
};

/** Surfaces served stale, with the version they were served at. A later guest write bumps
 *  `version`, and a comparison across that would measure the guest's own writes. */
const pendingStaleServe = new WeakMap<object, number>();

/** A Lock was answered without waiting; the readback it kicked owes us a comparison. */
export function noteReadLockServedStale(surface: object, version: number): void {
    readLockDivergenceCounters.locksServedStale++;
    pendingStaleServe.set(surface, version);
}

/** True while a stale serve of `version` is still owed its comparison. */
function hasPendingStaleServe(surface: object, version: number): boolean {
    return pendingStaleServe.get(surface) === version;
}

/** Drop the debt without counting a comparison (readback landed on a path whose bytes are
 *  not in surface format). */
export function skipStaleServeComparison(surface: object): void {
    if (!pendingStaleServe.delete(surface)) return;
    readLockDivergenceCounters.comparisonsSkipped++;
}

/**
 * Compare the bytes we served (still in guest memory, about to be overwritten) against the
 * GPU truth that just landed. Rows are compared tightly: `served` is strided by `pitch`
 * from `servedOffset`, `truth` by `rowBytes`.
 */
export function compareStaleServe(
    surface: object,
    version: number,
    served: Uint8Array,
    servedOffset: number,
    pitch: number,
    truth: Uint8Array,
    rowBytes: number,
    rows: number,
    bytesPerPixel: number
): void {
    if (!hasPendingStaleServe(surface, version)) return;
    pendingStaleServe.delete(surface);
    readLockDivergenceCounters.readbacksCompared++;

    let pixelsDiverged = 0;
    let maxDelta = 0;
    for (let y = 0; y < rows; y++) {
        const s = servedOffset + y * pitch;
        const t = y * rowBytes;
        for (let x = 0; x < rowBytes; x += bytesPerPixel) {
            let pixelDiffers = false;
            for (let b = 0; b < bytesPerPixel; b++) {
                const delta = Math.abs(served[s + x + b]! - truth[t + x + b]!);
                if (delta === 0) continue;
                pixelDiffers = true;
                if (delta > maxDelta) maxDelta = delta;
            }
            if (pixelDiffers) pixelsDiverged++;
        }
    }

    if (pixelsDiverged > 0) readLockDivergenceCounters.framesDiverged++;
    readLockDivergenceCounters.pixelsDiverged += pixelsDiverged;
    if (maxDelta > readLockDivergenceCounters.maxChannelDelta) {
        readLockDivergenceCounters.maxChannelDelta = maxDelta;
    }
}

/** The app opted out of blocking, so an acquire that would block must answer
 *  DDERR_WASSTILLDRAWING (DXVK d3d9_device.cpp:5126-5127). DXVK warns that apps pass this
 *  and ignore the result (:4959-4961), so it is only ever reported for an acquire that
 *  really cannot be satisfied now — never invented from the flags alone.
 *
 *  DDLOCK_DONOTWAIT is the ONLY opt-out. DDLOCK_WAIT is not its inverse: Wine strips it as
 *  a no-op (utils.c:578) and the conformance suite locks with a bare DDLOCK_READONLY and
 *  asserts success (ddraw7.c:461-462), so reading "WAIT absent" as "do not wait" fails
 *  every get_surface_color-shaped probe in the suite. */
export function lockMustNotBlock(_decision: LockSyncDecision, flags: number): boolean {
    if ((globalThis as { __noLockDoNotWait?: boolean }).__noLockDoNotWait === true) return false;
    return (flags & DDLOCK_DONOTWAIT) !== 0;
}
