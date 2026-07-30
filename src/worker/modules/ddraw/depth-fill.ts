/**
 * Depth-buffer clears expressed through DirectDraw.
 *
 * DirectDraw has no depth API: a DDSCAPS_ZBUFFER surface IS the depth memory, so an app
 * clears depth by DDBLT_DEPTHFILL, by an ordinary source-less fill of that surface, or —
 * just as legitimately — by Lock()ing it and writing the words itself. All three are the
 * same intent, and all three are invisible to a renderer whose depth attachment is a
 * separate GPU texture: the guest pixels get written, the attachment keeps the previous
 * frame's values, and from the second frame on the z-test rejects nearly everything.
 *
 * This module is the one place that turns "the guest wrote the z surface" into a clear of
 * the depth attachment behind it. The depth value follows ddraw's own conversion — the raw
 * word masked and normalised by the surface's dwZBitMask, stencil masked and shifted down.
 */

import { Logger, LogCategory } from "../../core/logger";
import type { DDrawContext } from "./context";
import type { DirectDrawSurfaceState } from "./com-objects";
import { DirectDrawSurfaceObject } from "./com-objects";
import { D3DCLEAR_STENCIL, D3DCLEAR_ZBUFFER, DDSCAPS_3DDEVICE, DDSCAPS_ZBUFFER } from "./constants";
import type { Rect } from "./helpers";
import { absToRel } from "./helpers";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";

const warnedNoTarget = new Set<number>();
const warnedNonUniform = new Set<number>();
const loggedFill = new Set<number>();

export const isZBufferSurface = (state: DirectDrawSurfaceState): boolean =>
    (state.caps & DDSCAPS_ZBUFFER) !== 0;

/** Bit mask a depth value occupies: the app's declared dwZBitMask, else the z bit depth
 *  (D16 / D24x8 / D32 — the ddraw z-format table). */
function zBitMaskOf(state: DirectDrawSurfaceState): number {
    const declared = state.format.zBitMask;
    if (declared) return declared >>> 0;
    const bits = state.format.bpp || 16;
    if (bits <= 16) return 0xffff;
    if (bits <= 24) return 0x00ffffff;
    return 0xffffffff;
}

function trailingZeros(mask: number): number {
    if (mask === 0) return 0;
    let n = 0;
    while (((mask >>> n) & 1) === 0) n++;
    return n;
}

/**
 * Render targets whose depth attachment this z surface backs. AddAttachedSurface records
 * them (that is exactly what attaching a z buffer to a render target means); the reverse
 * walk of the attachment links covers a chain that was wired before we started tracking.
 */
function resolveOwners(context: DDrawContext, zSurfaceAddr: number, zState: DirectDrawSurfaceState): DirectDrawSurfaceState[] {
    const owners: DirectDrawSurfaceState[] = [];
    const seen = new Set<number>();
    for (const addr of zState.zOwnerSurfaces ?? []) {
        const a = addr >>> 0;
        if (!a || seen.has(a)) continue;
        seen.add(a);
        const st = (context.resourceProvider.getComObjectByAddress(a) as DirectDrawSurfaceObject | null)?.getState?.();
        if (st && typeof st.surfacePtr === "number") owners.push(st);
    }
    if (owners.length > 0) return owners;

    const want = zSurfaceAddr >>> 0;
    for (const obj of context.resourceProvider.getAllComObjects()) {
        const st = (obj as DirectDrawSurfaceObject).getState?.();
        if (st && (st.attachedSurfaceAddr >>> 0) === want && (st.caps & DDSCAPS_3DDEVICE) !== 0) owners.push(st);
    }
    return owners;
}

/**
 * Clear the depth attachment behind `zState` to the raw z-format value `rawDepth`.
 * `dstRect` narrows the clear when the app asked for a sub-rectangle.
 */
export function clearDepthForZSurface(
    context: DDrawContext,
    zSurfaceAddr: number,
    zState: DirectDrawSurfaceState,
    dstRect: Rect,
    rawDepth: number,
): void {
    const executor = context.executor;
    if (!executor) return;

    const zMask = zBitMaskOf(zState);
    const depth = zMask === 0 ? 1.0 : ((rawDepth & zMask) >>> 0) / (zMask >>> 0);
    const stencilMask = (zState.format.stencilBitMask ?? 0) >>> 0;
    const stencil = stencilMask !== 0
        ? (((rawDepth & stencilMask) >>> 0) >>> trailingZeros(stencilMask))
        : undefined;
    const flags = D3DCLEAR_ZBUFFER | (stencilMask !== 0 ? D3DCLEAR_STENCIL : 0);

    const owners = resolveOwners(context, zSurfaceAddr, zState);
    if (owners.length === 0) {
        if (!warnedNoTarget.has(zState.surfacePtr)) {
            warnedNoTarget.add(zState.surfacePtr);
            Logger.warn(LogCategory.DDRAW,
                `depth clear on z surface 0x${zState.surfacePtr.toString(16)} (${zState.width}x${zState.height}): ` +
                `no render target claims it — depth stays stale, expect z-test failures`);
        }
        return;
    }

    if (!loggedFill.has(zState.surfacePtr)) {
        loggedFill.add(zState.surfacePtr);
        Logger.log(LogCategory.DDRAW,
            `depth clear via z surface 0x${zState.surfacePtr.toString(16)} ${zState.width}x${zState.height} ` +
            `bits=${zState.format.bpp} zMask=0x${zMask.toString(16)} raw=0x${(rawDepth >>> 0).toString(16)} ` +
            `-> depth=${depth} stencil=${stencil ?? "none"} targets=${owners.length}`);
    }

    const isFullSurface = dstRect.left <= 0 && dstRect.top <= 0
        && dstRect.right >= zState.width && dstRect.bottom >= zState.height;
    const viewport = isFullSurface ? undefined : {
        x: dstRect.left, y: dstRect.top,
        width: dstRect.right - dstRect.left, height: dstRect.bottom - dstRect.top,
    };

    for (const rt of owners) executor.clear(rt, flags, 0, depth, viewport, undefined, stencil);
}

/**
 * Re-establish the depth attachment from the guest's depth surface. Called when the app takes
 * a WRITABLE Lock on it — the point at which DirectDraw hands the app ownership of the depth
 * contents, and the only signal an app that clears depth this way ever gives us.
 *
 * Our depth attachment is a GPU-side cache of that surface; the GPU has been writing it behind
 * the app's back, so at this boundary the guest side is authoritative again. A CPU-authored
 * depth buffer is in practice a uniform fill (the app clearing to its far value), which maps
 * exactly onto a depth clear. A genuinely non-uniform CPU depth image would need a
 * depth-writing pass (WebGPU cannot writeTexture into depth24plus); we do not reproduce that,
 * and say so once rather than silently rendering against stale depth.
 *
 * Read at LOCK rather than Unlock because engines of this era routinely keep the lpSurface
 * pointer and fill after Unlock has returned — at Lock the previous cycle has definitely
 * landed, and a per-frame clear value is constant, so the value is still the app's own.
 */
export function syncZBufferWriteToDepth(
    context: DDrawContext,
    zSurfaceAddr: number,
    zState: DirectDrawSurfaceState,
    mem: Uint8Array,
): void {
    if (!isZBufferSurface(zState) || !context.executor) return;

    // Read the LIVE guest view, not the array handed to the thunk: that one can predate a
    // WASM memory growth, and a stale view reads as zeros — which would report the app's
    // far-value clear as a clear to near and z-fail the whole scene.
    mem = toPlainGuestMemory(context.process.getCurrentMemory?.() ?? mem);

    const bytesPerPixel = Math.max(1, Math.floor((zState.format.bpp || 16) / 8));
    const rowBytes = zState.width * bytesPerPixel;
    const base = absToRel(mem, zState.surfacePtr);
    if (base < 0 || rowBytes <= 0) return;
    if (base + (zState.height - 1) * zState.pitch + rowBytes > mem.length) return;

    const uniform = uniformValueOf(mem, base, zState.pitch, zState.height, rowBytes, bytesPerPixel);
    if (uniform === null) {
        if (!warnedNonUniform.has(zState.surfacePtr)) {
            warnedNonUniform.add(zState.surfacePtr);
            Logger.warn(LogCategory.DDRAW,
                `z surface 0x${zState.surfacePtr.toString(16)} holds non-uniform CPU depth — ` +
                `only a uniform fill maps onto a depth clear, so it does not reach the depth attachment`);
        }
        return;
    }

    // A uniform 0 is the surface as we allocated it, not depth the app authored: under any
    // LESS-family compare a near-plane depth buffer rejects every fragment, which is never
    // what taking write access to the depth surface means. We cannot tell "app cleared to 0"
    // from "never touched", so 0 reads as untouched and the buffer is (re)initialised to far.
    const raw = uniform === 0 ? zBitMaskOf(zState) : uniform;
    clearDepthForZSurface(context, zSurfaceAddr, zState, {
        left: 0, top: 0, right: zState.width, bottom: zState.height,
    }, raw);
}

/** The single value every pixel holds, or null if they differ. */
function uniformValueOf(
    mem: Uint8Array,
    base: number,
    pitch: number,
    height: number,
    rowBytes: number,
    bytesPerPixel: number,
): number | null {
    // 32-bit compares when the layout allows it: a 640x480x16 scan is 150k words, not 600k bytes.
    const wordAligned = bytesPerPixel <= 4 && (base & 3) === 0 && (pitch & 3) === 0 && (rowBytes & 3) === 0;
    if (wordAligned) {
        const words = new Uint32Array(mem.buffer, mem.byteOffset + base, ((height - 1) * pitch + rowBytes) >> 2);
        const wordsPerRow = rowBytes >> 2;
        const strideWords = pitch >> 2;
        const first = words[0];
        // Every row, every 4th word, plus each row's last word. This runs twice a frame on a
        // full-screen buffer, so a dense compare would cost more than the clear it detects —
        // and the thing being detected is a memset of the WHOLE surface, which cannot leave a
        // strided subset behind. (Sub-rect CPU depth authoring is the non-uniform case and is
        // reported, not silently accepted.)
        for (let y = 0; y < height; y++) {
            const rowStart = y * strideWords;
            for (let x = 0; x < wordsPerRow; x += 4) {
                if (words[rowStart + x] !== first) return null;
            }
            if (words[rowStart + wordsPerRow - 1] !== first) return null;
        }
        // A 16-bpp fill repeats the value in both halves; hand back one pixel's worth.
        return bytesPerPixel === 2 ? (first & 0xffff) : first >>> 0;
    }

    const read = (off: number): number => {
        if (bytesPerPixel === 1) return mem[off];
        if (bytesPerPixel === 2) return mem[off] | (mem[off + 1] << 8);
        if (bytesPerPixel === 3) return mem[off] | (mem[off + 1] << 8) | (mem[off + 2] << 16);
        return (mem[off] | (mem[off + 1] << 8) | (mem[off + 2] << 16) | (mem[off + 3] << 24)) >>> 0;
    };
    const first = read(base);
    for (let y = 0; y < height; y++) {
        const rowStart = base + y * pitch;
        for (let x = 0; x < rowBytes; x += bytesPerPixel) {
            if (read(rowStart + x) !== first) return null;
        }
    }
    return first;
}
