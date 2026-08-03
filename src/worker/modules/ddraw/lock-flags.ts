/**
 * DirectDraw Lock flag algebra — 1:1 with wine
 * `wined3dmapflags_from_ddrawmapflags` (dlls/ddraw/utils.c).
 *
 * READ  is implied unless (NOOVERWRITE | DISCARDCONTENTS | WRITEONLY)
 * WRITE is implied unless READONLY
 * if neither results → both
 *
 * Flag literals are inlined (not imported from constants.ts) so this module
 * stays free of the ddraw/d3d circular init graph.
 */
const DDLOCK_READONLY = 0x00000010;
const DDLOCK_WRITEONLY = 0x00000020;
const DDLOCK_NOOVERWRITE = 0x00001000;
const DDLOCK_DISCARDCONTENTS = 0x00002000;

export function lockImpliesRead(flags: number): boolean {
    return (flags & (DDLOCK_NOOVERWRITE | DDLOCK_DISCARDCONTENTS | DDLOCK_WRITEONLY)) === 0;
}

/**
 * Whether our split CPU/GPU storage must preserve the current GPU bytes before
 * exposing a writable CPU pointer.
 *
 * Native drivers may map WRITEONLY/NOOVERWRITE resource storage directly. We
 * cannot: an unchanged byte in stale guest memory is indistinguishable from a
 * guest write that restores that byte to the same value. Diff-based partial
 * upload therefore leaves old GPU sprites behind. Only DISCARDCONTENTS makes
 * preservation unnecessary for a GPU render surface.
 */
export function lockNeedsGpuReadback(flags: number, splitGpuStorage: boolean): boolean {
    if (lockImpliesRead(flags)) return true;
    return splitGpuStorage && (flags & DDLOCK_DISCARDCONTENTS) === 0;
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
