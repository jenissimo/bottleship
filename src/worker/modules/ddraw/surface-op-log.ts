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
import { System } from "../../core/system";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";

/** Per-texel alpha-bit tally of a 1-bit-alpha (ARGB1555) surface. */
export interface AlphaCensus {
    texels: number;
    /** bit15 == 0 — the masked/transparent texels. */
    clear: number;
    /** bit15 == 1 — opaque. */
    set: number;
}

export interface SurfaceOpRecord {
    seq: number;
    /** blt | bltfast | fill | flip | present | load */
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
    /** Source colour key in effect for THIS op ("none" when the blit is opaque).
     *  A keyed op reads the source's ORIGINAL texels; an opaque one does not — so
     *  "correct art, black rectangle" is unanswerable without it. */
    key: string;
    /** Source authority at the time of the op — which representation was sampled. */
    srcVersion: number;
    srcGpuDirty: boolean;
    /** ARGB1555 alpha-bit tally of source and destination, taken AT the op — only when the
     *  ring was armed with `alpha`. This is what separates "the game uploaded an opaque
     *  texture" from "we lost the alpha bit in transit": a masked texture arriving with
     *  clear > 0 and leaving with clear === 0 names the op that dropped it. `null` means
     *  not measured (disarmed, not 16-bit, or no alpha mask) — never "no transparency". */
    srcAlpha: AlphaCensus | null;
    dstAlpha: AlphaCensus | null;
}

// A real ring: fixed slots plus a write index. The obvious `push` + `shift` costs O(n)
// per record once full, and at 200k slots and thousands of ops per second that makes the
// instrument dominate the frame it is supposed to be measuring — the timing it reports
// would be its own.
let capacity = 0;
let ring: (SurfaceOpRecord | undefined)[] = [];
let head = 0;
let filled = 0;
let seq = 0;

/** Zero-cost guard for the hot paths: a single boolean test when disarmed. */
export function surfaceOpsArmed(): boolean {
    return capacity > 0;
}

/** Whole-surface alpha census per op — O(w*h) per record, so opt-in and armed-only. */
let censusEnabled = false;

export function armSurfaceOps(n: number, opts?: { alpha?: boolean }): { armed: number; alpha: boolean } {
    capacity = Math.max(0, Math.min(n | 0, 200_000));
    ring = new Array<SurfaceOpRecord | undefined>(capacity);
    head = 0;
    filled = 0;
    seq = 0;
    censusEnabled = !!opts?.alpha;
    return { armed: capacity, alpha: censusEnabled };
}

/** Count bit15 over a surface's guest pixels. Returns null when the question does not apply
 *  (not armed for it, not a 16-bit surface with an alpha mask, or the extent is out of
 *  bounds) — the caller must not read a null as "fully opaque". */
function censusOf(s: DirectDrawSurfaceState | null | undefined, mem: Uint8Array | null): AlphaCensus | null {
    if (!censusEnabled || !mem || !s) return null;
    const fmt = s.format;
    if (!fmt || fmt.bpp !== 16 || !fmt.aMask) return null;
    const base = (s.surfacePtr ?? 0) >>> 0;
    const w = s.width | 0, h = s.height | 0;
    if (!base || w <= 0 || h <= 0) return null;
    const pitch = s.pitch && s.pitch >= w * 2 ? s.pitch : w * 2;
    if (base + (h - 1) * pitch + w * 2 > mem.length) return null;
    let set = 0, clear = 0;
    for (let y = 0; y < h; y++) {
        let o = base + y * pitch + 1;   // high byte carries bit15
        for (let x = 0; x < w; x++, o += 2) {
            if (mem[o]! & 0x80) set++; else clear++;
        }
    }
    return { texels: set + clear, clear, set };
}

/** Oldest-first, so a caller reads the window in the order the ops happened. */
export function takeSurfaceOps(): SurfaceOpRecord[] {
    const out: SurfaceOpRecord[] = [];
    const start = filled === capacity ? head : 0;
    for (let i = 0; i < filled; i++) {
        const r = ring[(start + i) % capacity];
        if (r) out.push(r);
    }
    ring = new Array<SurfaceOpRecord | undefined>(capacity);
    head = 0;
    filled = 0;
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
    srcRect: Rect | null,
    colorKey?: { low: number; high: number }
): void {
    if (capacity <= 0) return;
    const render = isRenderSurface(dst);
    const srcRender = src ? isRenderSurface(src) : false;
    // Re-derived per record, never held: a plain guest view detaches the instant WASM
    // memory grows (CLAUDE.md §3.1).
    const mem = censusEnabled
        ? (toPlainGuestMemory(System.getInstance()?.process?.getCurrentMemory()) ?? null)
        : null;
    ring[head] = {
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
        key: colorKey ? `${hex(colorKey.low)}-${hex(colorKey.high)}` : "none",
        srcVersion: srcRender ? (src as { version: number }).version : -1,
        srcGpuDirty: srcRender ? (src as { gpuDirty: boolean }).gpuDirty : false,
        srcAlpha: censusOf(src, mem),
        dstAlpha: censusOf(dst, mem),
    };
    head = (head + 1) % capacity;
    if (filled < capacity) filled++;
}
