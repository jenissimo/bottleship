/**
 * Composition op ring for DDraw surfaces: every Blt/BltFast/Flip records WHICH
 * rectangle went WHERE and through WHICH path (GPU copy, CPU copy, colour fill,
 * skipped), plus the destination's CPU/GPU authority after the op.
 *
 * "Correctly positioned art with black gaps" is a compositing question, and the
 * log firehose cannot answer it — one op per line, thousands per second, and the
 * authority state that decides whether the pixels survive the next Flip is not in
 * the message. Off by default; the harness arms it for a window and takes the ring.
 */

import type { DirectDrawSurfaceState } from "./com-objects";
import { isRenderSurface } from "./com-objects";
import type { Rect } from "./helpers";

export interface SurfaceOpRecord {
    seq: number;
    /** blt | bltfast | fill | flip | present */
    op: string;
    /** Path actually taken — the load-bearing field (gpu vs cpu vs skip). */
    path: string;
    dst: string;
    src: string;
    /** [left, top, right, bottom] in destination pixels. */
    dstRect: [number, number, number, number] | null;
    srcRect: [number, number, number, number] | null;
    /** Destination mode/dirty state AFTER the op — shows the authority ping-pong. */
    dstMode: string;
    dstGpuDirty: boolean;
    dstVersion: number;
}

let capacity = 0;
let ring: SurfaceOpRecord[] = [];
let seq = 0;

/** Zero-cost guard for the hot paths: a single boolean test when disarmed. */
export function surfaceOpsArmed(): boolean {
    return capacity > 0;
}

export function armSurfaceOps(n: number): { armed: number } {
    capacity = Math.max(0, Math.min(n | 0, 200_000));
    ring = [];
    seq = 0;
    return { armed: capacity };
}

export function takeSurfaceOps(): SurfaceOpRecord[] {
    const out = ring;
    ring = [];
    return out;
}

const rectOf = (r: Rect | null | undefined): [number, number, number, number] | null =>
    r ? [r.left, r.top, r.right, r.bottom] : null;

const hex = (v: number | undefined): string => "0x" + ((v ?? 0) >>> 0).toString(16);

export function recordSurfaceOp(
    op: string,
    path: string,
    dst: DirectDrawSurfaceState,
    src: DirectDrawSurfaceState | null,
    dstRect: Rect | null,
    srcRect: Rect | null
): void {
    if (capacity <= 0) return;
    if (ring.length >= capacity) ring.shift();
    const render = isRenderSurface(dst);
    ring.push({
        seq: seq++,
        op,
        path,
        dst: hex(dst.surfacePtr),
        src: src ? hex(src.surfacePtr) : "-",
        dstRect: rectOf(dstRect),
        srcRect: rectOf(srcRect),
        dstMode: render ? dst.mode : "bitmap",
        dstGpuDirty: render ? dst.gpuDirty : false,
        dstVersion: render ? dst.version : -1,
    });
}
