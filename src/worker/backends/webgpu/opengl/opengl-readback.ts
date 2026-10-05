/**
 * glReadPixels across the internal-scale seam.
 *
 * The guest hands a rect in its OWN drawable pixels and expects exactly that many pixels
 * back; the colour target holds `drawable x renderScale` samples. So the rect is scaled up
 * to find the samples, and the samples are box-averaged back down to the guest image —
 * which is what makes a supersampled readback a sharper picture rather than a cropped
 * corner. At scale 1 every block is one texel, so the resolve is a plain copy and the bytes
 * are the ones the unscaled path produced.
 *
 * Pure and GPU-free on purpose: the arithmetic is the part that silently reads the wrong
 * rect, and it is the part a test can pin.
 */

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export interface ReadbackRect { x: number; y: number; width: number; height: number; }

/**
 * The render-space rect covering a guest-space read of `width x height` at GL's `(x, y)`
 * (origin bottom-left) inside a `guestH`-tall drawable, snapped outward so every guest
 * pixel's full footprint is copied, and clipped to the `texW x texH` target.
 */
export function readbackSourceRect(
    x: number, y: number, width: number, height: number,
    guestH: number, scale: number, texW: number, texH: number,
): ReadbackRect {
    const top = guestH - (y + height);
    const x0 = clampInt(Math.floor(x * scale), 0, Math.max(0, texW - 1));
    const y0 = clampInt(Math.floor(top * scale), 0, Math.max(0, texH - 1));
    return {
        x: x0,
        y: y0,
        width: clampInt(Math.ceil((x + width) * scale), x0 + 1, texW) - x0,
        height: clampInt(Math.ceil((top + height) * scale), y0 + 1, texH) - y0,
    };
}

/**
 * Box-resolve the mapped copy of `rect` down to the `width x height` RGBA8 image
 * glReadPixels owes its caller: row 0 is GL's BOTTOM row, `bgra` swizzles a bgra8unorm
 * target on the way out.
 */
export function resolveReadback(
    mapped: Uint8Array, bytesPerRow: number, rect: ReadbackRect,
    x: number, y: number, width: number, height: number,
    guestH: number, scale: number, bgra: boolean,
): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const top = guestH - (y + height);

    // Column blocks are the same for every row — resolve once, not width*height times.
    const colStart = new Int32Array(width);
    const colEnd = new Int32Array(width);
    for (let px = 0; px < width; px++) {
        const s = clampInt(Math.floor((x + px) * scale) - rect.x, 0, rect.width - 1);
        colStart[px] = s;
        colEnd[px] = clampInt(Math.ceil((x + px + 1) * scale) - rect.x, s + 1, rect.width);
    }

    const rIdx = bgra ? 2 : 0;
    const bIdx = bgra ? 0 : 2;
    for (let row = 0; row < height; row++) {
        // GL row 0 is the bottom; the texture's row 0 is the top of the read rect.
        const gy = top + (height - 1 - row);
        const ry0 = clampInt(Math.floor(gy * scale) - rect.y, 0, rect.height - 1);
        const ry1 = clampInt(Math.ceil((gy + 1) * scale) - rect.y, ry0 + 1, rect.height);
        const dstRow = row * width * 4;
        for (let px = 0; px < width; px++) {
            const cx0 = colStart[px], cx1 = colEnd[px];
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = ry0; sy < ry1; sy++) {
                const base = sy * bytesPerRow;
                for (let sx = cx0; sx < cx1; sx++) {
                    const s = base + sx * 4;
                    r += mapped[s + rIdx];
                    g += mapped[s + 1];
                    b += mapped[s + bIdx];
                    a += mapped[s + 3];
                }
            }
            const n = (ry1 - ry0) * (cx1 - cx0);
            const d = dstRow + px * 4;
            out[d] = (r / n + 0.5) | 0;
            out[d + 1] = (g / n + 0.5) | 0;
            out[d + 2] = (b / n + 0.5) | 0;
            out[d + 3] = (a / n + 0.5) | 0;
        }
    }
    return out;
}
