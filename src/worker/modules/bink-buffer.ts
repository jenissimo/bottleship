/**
 * BINKBUFFER — the guest-visible head of the struct BinkBufferOpen returns (RAD's public
 * bink.h). Apps read these fields directly: the canonical loop is
 * `BinkBufferLock(buf); BinkCopyToBuffer(bink, buf->Buffer, buf->BufferPitch, buf->Height,
 * 0, 0, buf->SurfaceType); BinkBufferUnlock(buf); BinkBufferBlit(buf, bink->FrameRects, n)`.
 * The private tail past StretchHeight is Bink's own; it is allocated zeroed.
 */
export const BB = {
    width: 0x00,
    height: 0x04,
    windowWidth: 0x08,
    windowHeight: 0x0c,
    surfaceType: 0x10,
    buffer: 0x14,
    bufferPitch: 0x18,
    clientOffsetX: 0x1c,
    clientOffsetY: 0x20,
    screenWidth: 0x24,
    screenHeight: 0x28,
    screenDepth: 0x2c,
    extraWindowWidth: 0x30,
    extraWindowHeight: 0x34,
    scaleFlags: 0x38,
    stretchWidth: 0x3c,
    stretchHeight: 0x40,
} as const;
export const BINKBUFFER_ALLOC_BYTES = 0x200;

/** BINKSURFACE* constant for a DirectDraw pixel format, or -1 when Bink has no such type. */
export function binkSurfaceForPixelFormat(bpp: number, rMask: number, gMask: number): number {
    switch (bpp) {
        case 8: return 0;                                 // BINKSURFACE8P
        case 16: return gMask === 0x3e0 ? 9 : 10;         // BINKSURFACE555 / BINKSURFACE565
        case 24: return rMask === 0xff ? 2 : 1;           // BINKSURFACE24R / BINKSURFACE24
        case 32: return rMask === 0xff ? 4 : 3;           // BINKSURFACE32R / BINKSURFACE32
        default: return -1;
    }
}

export interface BinkRect { left: number; top: number; width: number; height: number; }

/**
 * Copy the dirty rects of a BinkBuffer's pixels to a destination surface at (destX, destY),
 * clipped to both. Returns the union of what was written (destination coordinates), or null
 * when nothing landed. Both sides are the same pixel format; no conversion happens here.
 */
export function blitBinkRects(
    src: Uint8Array, srcPitch: number, srcW: number, srcH: number,
    dst: Uint8Array, dstPitch: number, dstW: number, dstH: number,
    bytesPerPixel: number, rects: readonly BinkRect[], destX: number, destY: number,
): { left: number; top: number; right: number; bottom: number } | null {
    let ul = Infinity, ut = Infinity, ur = -Infinity, ub = -Infinity;
    for (const r of rects) {
        let sx = Math.max(0, r.left), sy = Math.max(0, r.top);
        let ex = Math.min(srcW, r.left + r.width), ey = Math.min(srcH, r.top + r.height);
        // Clip against the destination in destination space, then map back.
        sx = Math.max(sx, -destX); sy = Math.max(sy, -destY);
        ex = Math.min(ex, dstW - destX); ey = Math.min(ey, dstH - destY);
        if (ex <= sx || ey <= sy) continue;
        const rowBytes = (ex - sx) * bytesPerPixel;
        for (let y = sy; y < ey; y++) {
            const s = y * srcPitch + sx * bytesPerPixel;
            dst.set(src.subarray(s, s + rowBytes), (y + destY) * dstPitch + (sx + destX) * bytesPerPixel);
        }
        ul = Math.min(ul, sx + destX); ut = Math.min(ut, sy + destY);
        ur = Math.max(ur, ex + destX); ub = Math.max(ub, ey + destY);
    }
    return ul === Infinity ? null : { left: ul, top: ut, right: ur, bottom: ub };
}
