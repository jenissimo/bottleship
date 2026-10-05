/**
 * Geometry shared by the Lock prologue and the GPU→CPU readback: which rect of a surface
 * a download covers, and how its tightly packed rows land in pitch-strided guest memory.
 *
 * Leaf module by design — no imports, so both lock-flags.ts (which must stay out of the
 * ddraw/d3d circular init graph) and the sync manager can use one definition of the box.
 */

export interface LockRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** A download's extent in texture space. */
export interface ReadbackRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Clip a Lock rect to the surface. Returns null — meaning "the whole surface" — for a
 * missing rect, a rect that already covers the surface, and a degenerate one: a rect that
 * clips to nothing says nothing about what the app will touch, and downloading nothing
 * while calling the result valid is the failure mode this whole box has to avoid.
 */
export function clipLockRect(
    rect: LockRect | null | undefined,
    width: number,
    height: number
): LockRect | null {
    if (!rect) return null;
    const left = Math.max(0, Math.min(width, rect.left));
    const top = Math.max(0, Math.min(height, rect.top));
    const right = Math.max(left, Math.min(width, rect.right));
    const bottom = Math.max(top, Math.min(height, rect.bottom));
    if (right <= left || bottom <= top) return null;
    if (left === 0 && top === 0 && right === width && bottom === height) return null;
    return { left, top, right, bottom };
}

/** The box as a texture-space region; null box ⇒ the whole surface. */
export function regionOfBox(
    box: LockRect | null,
    width: number,
    height: number
): ReadbackRegion {
    if (!box) return { x: 0, y: 0, width, height };
    return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
}

/**
 * Copy `rows` tightly packed rows of `rowBytes` into `dest` at `destPtr`, strided by
 * `pitch`. A single copy is only correct when the destination stride equals the source
 * stride; otherwise every row must be placed individually or the image shears.
 */
export function landRegionRows(
    mapped: Uint8Array,
    rowBytes: number,
    rows: number,
    dest: Uint8Array,
    destPtr: number,
    pitch: number
): void {
    if (pitch === rowBytes) {
        dest.set(mapped.subarray(0, rowBytes * rows), destPtr);
        return;
    }
    for (let y = 0; y < rows; y++) {
        const srcOff = y * rowBytes;
        dest.set(mapped.subarray(srcOff, srcOff + rowBytes), destPtr + y * pitch);
    }
}
