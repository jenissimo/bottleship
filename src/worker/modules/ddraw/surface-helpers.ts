/**
 * Shared helpers for surface operations (Blt, Flip, copy regions).
 */
import type { Rect } from "./helpers";
import type { DirectDrawSurfaceState } from "./com-objects";
import { absToRel } from "./helpers";
import { isValidAddress } from "../../core/memory/address-guard";
import { toPlainGuestMemory } from "../../core/memory/guest-memory";
import { RectPool } from "./rect-pool";

// Module-level rect pool to reduce allocations in hot paths
const rectPool = new RectPool(8);

export const clipRect = (rect: Rect, width: number, height: number): Rect | null => {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(width, rect.right);
    const bottom = Math.min(height, rect.bottom);
    if (left >= right || top >= bottom) {
        return null;
    }
    return { left, top, right, bottom };
};

/**
 * Copy pixel data between two DirectDraw surfaces.
 */
export const copySurfaceRegion = (
    mem: Uint8Array,
    src: DirectDrawSurfaceState,
    dst: DirectDrawSurfaceState,
    srcRectInput: Rect,
    dstRectInput: Rect
): void => {
    // Unwrap v86's per-element Proxy to a plain (JIT-fast) view for the duration of this
    // synchronous copy. Safe: a pure pixel-copy loop executes no guest code, so the WASM
    // buffer cannot grow/detach mid-loop. This is what kills the ~50× proxy tax on Blt
    // (IDirectDrawSurface7_Blt spike: ~154ms/call → single-digit ms). Same pattern as the
    // colour-key readback fix; the always-live Proxy stays for views held across re-entry.
    mem = toPlainGuestMemory(mem);

    // First take copies we can mutate for coordinated clipping (using pool to reduce allocations)
    const srcRect = rectPool.acquireCopy(srcRectInput);
    const dstRect = rectPool.acquireCopy(dstRectInput);

    // Align rectangles when source starts before surface (negative coords)
    if (srcRect.left < 0) {
        const delta = -srcRect.left;
        srcRect.left = 0;
        srcRect.right += delta;
        dstRect.left += delta;
        dstRect.right += delta;
    }
    if (srcRect.top < 0) {
        const delta = -srcRect.top;
        srcRect.top = 0;
        srcRect.bottom += delta;
        dstRect.top += delta;
        dstRect.bottom += delta;
    }

    // Align when destination starts before surface
    if (dstRect.left < 0) {
        const delta = -dstRect.left;
        dstRect.left = 0;
        dstRect.right += delta;
        srcRect.left += delta;
        srcRect.right += delta;
    }
    if (dstRect.top < 0) {
        const delta = -dstRect.top;
        dstRect.top = 0;
        dstRect.bottom += delta;
        srcRect.top += delta;
        srcRect.bottom += delta;
    }

    // Detect stretch before coordinated clipping (which forces 1:1 dimensions)
    const preSrcW = srcRect.right - srcRect.left;
    const preSrcH = srcRect.bottom - srcRect.top;
    const preDstW = dstRect.right - dstRect.left;
    const preDstH = dstRect.bottom - dstRect.top;

    if ((preSrcW !== preDstW || preSrcH !== preDstH) && preSrcW > 0 && preSrcH > 0 && preDstW > 0 && preDstH > 0) {
        // Nearest-neighbor stretch path — clip each rect independently
        srcRect.right = Math.min(srcRect.right, src.width);
        srcRect.bottom = Math.min(srcRect.bottom, src.height);
        dstRect.right = Math.min(dstRect.right, dst.width);
        dstRect.bottom = Math.min(dstRect.bottom, dst.height);

        const srcW = srcRect.right - srcRect.left;
        const srcH = srcRect.bottom - srcRect.top;
        const dstW = dstRect.right - dstRect.left;
        const dstH = dstRect.bottom - dstRect.top;

        if (srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0) {
            const srcBpp = Math.max(1, Math.floor(src.format.bpp / 8));
            const dstBpp = Math.max(1, Math.floor(dst.format.bpp / 8));
            const copyBpp = Math.min(srcBpp, dstBpp);
            const memSize = mem.length;

            for (let dy = 0; dy < dstH; dy++) {
                const sy = (dy * srcH / dstH) | 0;
                const srcRowBase = src.surfacePtr + (srcRect.top + sy) * src.pitch + srcRect.left * srcBpp;
                const dstRowBase = dst.surfacePtr + (dstRect.top + dy) * dst.pitch + dstRect.left * dstBpp;

                if (!isValidAddress(mem, srcRowBase, srcW * srcBpp) ||
                    !isValidAddress(mem, dstRowBase, dstW * dstBpp)) continue;

                const srcRowRel = absToRel(mem, srcRowBase);
                const dstRowRel = absToRel(mem, dstRowBase);
                if (srcRowRel < 0 || dstRowRel < 0 ||
                    srcRowRel + srcW * srcBpp > memSize ||
                    dstRowRel + dstW * dstBpp > memSize) continue;

                if (copyBpp === 2) {
                    for (let dx = 0; dx < dstW; dx++) {
                        const sx = (dx * srcW / dstW) | 0;
                        const si = srcRowRel + sx * 2;
                        const di = dstRowRel + dx * 2;
                        mem[di] = mem[si];
                        mem[di + 1] = mem[si + 1];
                    }
                } else if (copyBpp === 4) {
                    for (let dx = 0; dx < dstW; dx++) {
                        const sx = (dx * srcW / dstW) | 0;
                        const si = srcRowRel + sx * 4;
                        const di = dstRowRel + dx * 4;
                        mem[di] = mem[si];
                        mem[di + 1] = mem[si + 1];
                        mem[di + 2] = mem[si + 2];
                        mem[di + 3] = mem[si + 3];
                    }
                } else {
                    for (let dx = 0; dx < dstW; dx++) {
                        const sx = (dx * srcW / dstW) | 0;
                        const si = srcRowRel + sx * copyBpp;
                        const di = dstRowRel + dx * copyBpp;
                        for (let b = 0; b < copyBpp; b++) {
                            mem[di + b] = mem[si + b];
                        }
                    }
                }
            }
        }

        rectPool.release(srcRect);
        rectPool.release(dstRect);
        return;
    }

    // 1:1 copy path — clip right/bottom edges against source and destination bounds,
    // keeping rectangles the same size after clipping.
    const maxWidth = Math.min(src.width - srcRect.left, dst.width - dstRect.left);
    const maxHeight = Math.min(src.height - srcRect.top, dst.height - dstRect.top);
    if (maxWidth <= 0 || maxHeight <= 0) {
        rectPool.release(srcRect);
        rectPool.release(dstRect);
        return;
    }

    srcRect.right = Math.min(srcRect.right, srcRect.left + maxWidth);
    dstRect.right = dstRect.left + (srcRect.right - srcRect.left);

    srcRect.bottom = Math.min(srcRect.bottom, srcRect.top + maxHeight);
    dstRect.bottom = dstRect.top + (srcRect.bottom - srcRect.top);

    const bytesPerPixel = Math.max(1, Math.floor(src.format.bpp / 8));
    const width = Math.min(srcRect.right - srcRect.left, dstRect.right - dstRect.left);
    const height = Math.min(srcRect.bottom - srcRect.top, dstRect.bottom - dstRect.top);
    if (width <= 0 || height <= 0) {
        rectPool.release(srcRect);
        rectPool.release(dstRect);
        return;
    }

    const rowBytes = width * bytesPerPixel;
    const memSize = mem.length;

    // Detect same-surface overlap and choose copy direction
    const isSameSurface = src.surfacePtr === dst.surfacePtr;
    const srcBaseY = srcRect.top;
    const dstBaseY = dstRect.top;
    const srcYEnd = srcRect.top + height;
    const dstYEnd = dstRect.top + height;
    const overlapsVertically = isSameSurface && !(srcYEnd <= dstBaseY || dstYEnd <= srcBaseY);
    const copyBottomToTop = isSameSurface && overlapsVertically && dstBaseY > srcBaseY;

    if (copyBottomToTop) {
        for (let y = height - 1; y >= 0; y--) {
            const srcAbsOffset = src.surfacePtr + (srcRect.top + y) * src.pitch + srcRect.left * bytesPerPixel;
            const dstAbsOffset = dst.surfacePtr + (dstRect.top + y) * dst.pitch + dstRect.left * bytesPerPixel;

            if (!isValidAddress(mem, srcAbsOffset, rowBytes) || !isValidAddress(mem, dstAbsOffset, rowBytes)) {
                continue;
            }

            const srcRelOffset = absToRel(mem, srcAbsOffset);
            const dstRelOffset = absToRel(mem, dstAbsOffset);

            if (srcRelOffset < 0 || srcRelOffset + rowBytes > memSize || dstRelOffset < 0 || dstRelOffset + rowBytes > memSize) {
                continue;
            }

            if (dstRelOffset >= srcRelOffset && dstRelOffset < srcRelOffset + rowBytes) {
                for (let i = rowBytes - 1; i >= 0; i--) {
                    mem[dstRelOffset + i] = mem[srcRelOffset + i];
                }
            } else {
                mem.set(mem.subarray(srcRelOffset, srcRelOffset + rowBytes), dstRelOffset);
            }
        }
    } else {
        for (let y = 0; y < height; y++) {
            const srcAbsOffset = src.surfacePtr + (srcRect.top + y) * src.pitch + srcRect.left * bytesPerPixel;
            const dstAbsOffset = dst.surfacePtr + (dstRect.top + y) * dst.pitch + dstRect.left * bytesPerPixel;

            if (!isValidAddress(mem, srcAbsOffset, rowBytes) || !isValidAddress(mem, dstAbsOffset, rowBytes)) {
                continue;
            }

            const srcRelOffset = absToRel(mem, srcAbsOffset);
            const dstRelOffset = absToRel(mem, dstAbsOffset);

            if (srcRelOffset < 0 || srcRelOffset + rowBytes > memSize || dstRelOffset < 0 || dstRelOffset + rowBytes > memSize) {
                continue;
            }

            if (dstRelOffset >= srcRelOffset && dstRelOffset < srcRelOffset + rowBytes) {
                for (let i = rowBytes - 1; i >= 0; i--) {
                    mem[dstRelOffset + i] = mem[srcRelOffset + i];
                }
            } else {
                mem.set(mem.subarray(srcRelOffset, srcRelOffset + rowBytes), dstRelOffset);
            }
        }
    }

    // Release pooled rects
    rectPool.release(srcRect);
    rectPool.release(dstRect);
};

/**
 * Copy pixel data between two DirectDraw surfaces with source colorkey transparency.
 * Pixels matching the colorkey range are skipped (not copied).
 */
export const copySurfaceRegionWithColorKey = (
    mem: Uint8Array,
    src: DirectDrawSurfaceState,
    dst: DirectDrawSurfaceState,
    srcRectInput: Rect,
    dstRectInput: Rect,
    colorKey: { low: number; high: number }
): void => {
    // Plain (JIT-fast) view for this synchronous copy — see copySurfaceRegion note.
    mem = toPlainGuestMemory(mem);

    // Same clipping logic as copySurfaceRegion
    let srcRect = { ...srcRectInput };
    let dstRect = { ...dstRectInput };

    if (srcRect.left < 0) {
        const delta = -srcRect.left;
        srcRect.left = 0;
        srcRect.right += delta;
        dstRect.left += delta;
        dstRect.right += delta;
    }
    if (srcRect.top < 0) {
        const delta = -srcRect.top;
        srcRect.top = 0;
        srcRect.bottom += delta;
        dstRect.top += delta;
        dstRect.bottom += delta;
    }
    if (dstRect.left < 0) {
        const delta = -dstRect.left;
        dstRect.left = 0;
        dstRect.right += delta;
        srcRect.left += delta;
        srcRect.right += delta;
    }
    if (dstRect.top < 0) {
        const delta = -dstRect.top;
        dstRect.top = 0;
        dstRect.bottom += delta;
        srcRect.top += delta;
        srcRect.bottom += delta;
    }

    const maxWidth = Math.min(src.width - srcRect.left, dst.width - dstRect.left);
    const maxHeight = Math.min(src.height - srcRect.top, dst.height - dstRect.top);
    if (maxWidth <= 0 || maxHeight <= 0) return;

    srcRect.right = Math.min(srcRect.right, srcRect.left + maxWidth);
    dstRect.right = dstRect.left + (srcRect.right - srcRect.left);
    srcRect.bottom = Math.min(srcRect.bottom, srcRect.top + maxHeight);
    dstRect.bottom = dstRect.top + (srcRect.bottom - srcRect.top);

    const bytesPerPixel = Math.max(1, Math.floor(src.format.bpp / 8));
    const width = Math.min(srcRect.right - srcRect.left, dstRect.right - dstRect.left);
    const height = Math.min(srcRect.bottom - srcRect.top, dstRect.bottom - dstRect.top);
    if (width <= 0 || height <= 0) return;

    const memSize = mem.length;
    // The key is expressed in the surface's pixel format and only its COLOUR bits are
    // significant — the padding/alpha bits of an X8R8G8B8 or X1R5G5B5 surface are
    // don't-care. Games write SetColorKey(0x00ff00ff) while the surface holds
    // 0xffff00ff, so a raw full-DWORD compare never matches and the "transparent"
    // texels are copied opaque. Paletted formats carry no RGB masks; there the key IS
    // the raw index, so fall back to the full value.
    const ckMask = ((src.format.rMask | src.format.gMask | src.format.bMask) >>> 0) || 0xffffffff;
    const ckLow = ((colorKey.low >>> 0) & ckMask) >>> 0;
    const ckHigh = ((colorKey.high >>> 0) & ckMask) >>> 0;

    for (let y = 0; y < height; y++) {
        const srcAbsOffset = src.surfacePtr + (srcRect.top + y) * src.pitch + srcRect.left * bytesPerPixel;
        const dstAbsOffset = dst.surfacePtr + (dstRect.top + y) * dst.pitch + dstRect.left * bytesPerPixel;

        const srcRelOffset = absToRel(mem, srcAbsOffset);
        const dstRelOffset = absToRel(mem, dstAbsOffset);

        if (srcRelOffset < 0 || dstRelOffset < 0) continue;
        if (srcRelOffset + width * bytesPerPixel > memSize) continue;
        if (dstRelOffset + width * bytesPerPixel > memSize) continue;

        for (let x = 0; x < width; x++) {
            const srcPixelOffset = srcRelOffset + x * bytesPerPixel;
            const dstPixelOffset = dstRelOffset + x * bytesPerPixel;

            // Read source pixel
            let pixel = 0;
            if (bytesPerPixel === 2) {
                pixel = mem[srcPixelOffset] | (mem[srcPixelOffset + 1] << 8);
            } else if (bytesPerPixel === 4) {
                pixel = mem[srcPixelOffset] | (mem[srcPixelOffset + 1] << 8) |
                        (mem[srcPixelOffset + 2] << 16) | (mem[srcPixelOffset + 3] << 24);
                pixel >>>= 0; // Ensure unsigned
            } else if (bytesPerPixel === 3) {
                pixel = mem[srcPixelOffset] | (mem[srcPixelOffset + 1] << 8) | (mem[srcPixelOffset + 2] << 16);
            } else {
                pixel = mem[srcPixelOffset];
            }

            // Check colorkey - skip if pixel matches colorkey range
            const pixelKeyBits = (pixel & ckMask) >>> 0;
            if (pixelKeyBits >= ckLow && pixelKeyBits <= ckHigh) {
                continue; // Transparent - don't copy
            }

            // Copy pixel to destination
            if (bytesPerPixel === 2) {
                mem[dstPixelOffset] = pixel & 0xff;
                mem[dstPixelOffset + 1] = (pixel >> 8) & 0xff;
            } else if (bytesPerPixel === 4) {
                mem[dstPixelOffset] = pixel & 0xff;
                mem[dstPixelOffset + 1] = (pixel >> 8) & 0xff;
                mem[dstPixelOffset + 2] = (pixel >> 16) & 0xff;
                mem[dstPixelOffset + 3] = (pixel >> 24) & 0xff;
            } else if (bytesPerPixel === 3) {
                mem[dstPixelOffset] = pixel & 0xff;
                mem[dstPixelOffset + 1] = (pixel >> 8) & 0xff;
                mem[dstPixelOffset + 2] = (pixel >> 16) & 0xff;
            } else {
                mem[dstPixelOffset] = pixel & 0xff;
            }
        }
    }
};

/**
 * Copy pixel data between two DirectDraw surfaces using a simple ROP3 operation.
 * Supports common cursor ops (SRCCOPY, SRCAND, SRCPAINT, SRCINVERT, DSTINVERT).
 */
export const copySurfaceRegionWithRop = (
    mem: Uint8Array,
    src: DirectDrawSurfaceState,
    dst: DirectDrawSurfaceState,
    srcRectInput: Rect,
    dstRectInput: Rect,
    rop3: number
): void => {
    // Plain (JIT-fast) view for this synchronous copy — see copySurfaceRegion note.
    mem = toPlainGuestMemory(mem);

    let srcRect = { ...srcRectInput };
    let dstRect = { ...dstRectInput };

    if (srcRect.left < 0) {
        const delta = -srcRect.left;
        srcRect.left = 0;
        srcRect.right += delta;
        dstRect.left += delta;
        dstRect.right += delta;
    }
    if (srcRect.top < 0) {
        const delta = -srcRect.top;
        srcRect.top = 0;
        srcRect.bottom += delta;
        dstRect.top += delta;
        dstRect.bottom += delta;
    }
    if (dstRect.left < 0) {
        const delta = -dstRect.left;
        dstRect.left = 0;
        dstRect.right += delta;
        srcRect.left += delta;
        srcRect.right += delta;
    }
    if (dstRect.top < 0) {
        const delta = -dstRect.top;
        dstRect.top = 0;
        dstRect.bottom += delta;
        srcRect.top += delta;
        srcRect.bottom += delta;
    }

    const maxWidth = Math.min(src.width - srcRect.left, dst.width - dstRect.left);
    const maxHeight = Math.min(src.height - srcRect.top, dst.height - dstRect.top);
    if (maxWidth <= 0 || maxHeight <= 0) return;

    srcRect.right = Math.min(srcRect.right, srcRect.left + maxWidth);
    dstRect.right = dstRect.left + (srcRect.right - srcRect.left);
    srcRect.bottom = Math.min(srcRect.bottom, srcRect.top + maxHeight);
    dstRect.bottom = dstRect.top + (srcRect.bottom - srcRect.top);

    const bytesPerPixel = Math.max(1, Math.floor(src.format.bpp / 8));
    const width = Math.min(srcRect.right - srcRect.left, dstRect.right - dstRect.left);
    const height = Math.min(srcRect.bottom - srcRect.top, dstRect.bottom - dstRect.top);
    if (width <= 0 || height <= 0) return;

    const memSize = mem.length;
    const mask = bytesPerPixel === 4 ? 0xffffffff : (1 << (bytesPerPixel * 8)) - 1;

    const applyRop = (s: number, d: number): number => {
        switch (rop3 & 0xff) {
            case 0xcc: return s & mask;           // SRCCOPY
            case 0x88: return (s & d) & mask;     // SRCAND
            case 0xee: return (s | d) & mask;     // SRCPAINT
            case 0x66: return (s ^ d) & mask;     // SRCINVERT
            case 0x55: return (~d) & mask;        // DSTINVERT
            case 0x00: return 0;                  // BLACKNESS
            case 0xff: return mask;               // WHITENESS
            case 0xaa: return d & mask;           // DST (NOP)
            default: return s & mask;             // Fallback to SRCCOPY
        }
    };

    for (let y = 0; y < height; y++) {
        const srcAbsOffset = src.surfacePtr + (srcRect.top + y) * src.pitch + srcRect.left * bytesPerPixel;
        const dstAbsOffset = dst.surfacePtr + (dstRect.top + y) * dst.pitch + dstRect.left * bytesPerPixel;

        const srcRelOffset = absToRel(mem, srcAbsOffset);
        const dstRelOffset = absToRel(mem, dstAbsOffset);

        if (srcRelOffset < 0 || dstRelOffset < 0) continue;
        if (srcRelOffset + width * bytesPerPixel > memSize) continue;
        if (dstRelOffset + width * bytesPerPixel > memSize) continue;

        for (let x = 0; x < width; x++) {
            const srcPixelOffset = srcRelOffset + x * bytesPerPixel;
            const dstPixelOffset = dstRelOffset + x * bytesPerPixel;

            let s = 0;
            let d = 0;
            if (bytesPerPixel === 2) {
                s = mem[srcPixelOffset] | (mem[srcPixelOffset + 1] << 8);
                d = mem[dstPixelOffset] | (mem[dstPixelOffset + 1] << 8);
            } else if (bytesPerPixel === 4) {
                s = mem[srcPixelOffset] | (mem[srcPixelOffset + 1] << 8) |
                    (mem[srcPixelOffset + 2] << 16) | (mem[srcPixelOffset + 3] << 24);
                d = mem[dstPixelOffset] | (mem[dstPixelOffset + 1] << 8) |
                    (mem[dstPixelOffset + 2] << 16) | (mem[dstPixelOffset + 3] << 24);
                s >>>= 0; d >>>= 0;
            } else if (bytesPerPixel === 3) {
                s = mem[srcPixelOffset] | (mem[srcPixelOffset + 1] << 8) | (mem[srcPixelOffset + 2] << 16);
                d = mem[dstPixelOffset] | (mem[dstPixelOffset + 1] << 8) | (mem[dstPixelOffset + 2] << 16);
            } else {
                s = mem[srcPixelOffset];
                d = mem[dstPixelOffset];
            }

            const out = applyRop(s, d);
            if (bytesPerPixel === 2) {
                mem[dstPixelOffset] = out & 0xff;
                mem[dstPixelOffset + 1] = (out >> 8) & 0xff;
            } else if (bytesPerPixel === 4) {
                mem[dstPixelOffset] = out & 0xff;
                mem[dstPixelOffset + 1] = (out >> 8) & 0xff;
                mem[dstPixelOffset + 2] = (out >> 16) & 0xff;
                mem[dstPixelOffset + 3] = (out >> 24) & 0xff;
            } else if (bytesPerPixel === 3) {
                mem[dstPixelOffset] = out & 0xff;
                mem[dstPixelOffset + 1] = (out >> 8) & 0xff;
                mem[dstPixelOffset + 2] = (out >> 16) & 0xff;
            } else {
                mem[dstPixelOffset] = out & 0xff;
            }
        }
    }
};

export const buildFullRect = (surface: DirectDrawSurfaceState): Rect => ({
    left: 0,
    top: 0,
    right: surface.width,
    bottom: surface.height,
});
