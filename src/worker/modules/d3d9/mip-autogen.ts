/**
 * Pure AUTOGENMIPMAP filtering used by the D3D9 resource shim.
 *
 * WebGPU does not expose a portable CPU-visible mip generator with D3D9's
 * filter selection. Keep the fallback deliberately narrow: POINT and LINEAR
 * have deterministic definitions here; the other D3DTEXF values require
 * kernels that this backend does not implement and are rejected by the caller.
 */

export const D3DTEXF_POINT = 1;
export const D3DTEXF_LINEAR = 2;

export interface AutogenMipLevel {
    data: Uint8Array;
    pitch: number;
    width: number;
    height: number;
}

/**
 * Generate the next 2-D mip level from an uncompressed byte-per-pixel source.
 *
 * The D3D9 resource path admits byte widths of 1, 2, 3, or 4. The 2-byte
 * A8L8 layout is averaged channel-wise (L then A), while the 3-byte R8G8B8
 * layout keeps its BGR byte order.
 * `destinationPitch` is accepted separately because level 0 may have a
 * guest lock pitch while generated levels use the format's canonical pitch.
 * Returns null for malformed layouts or filters without an implemented kernel.
 */
export function generateD3D9AutogenMipLevel(
    source: AutogenMipLevel,
    bytesPerPixel: number,
    filter: number,
    destinationPitch?: number,
): AutogenMipLevel | null {
    if (bytesPerPixel !== 1 && bytesPerPixel !== 2 && bytesPerPixel !== 3 && bytesPerPixel !== 4) return null;
    if (filter !== D3DTEXF_POINT && filter !== D3DTEXF_LINEAR) return null;
    if (!Number.isInteger(source.width) || !Number.isInteger(source.height)
        || source.width <= 0 || source.height <= 0 || source.pitch < source.width * bytesPerPixel
        || source.data.length < source.pitch * source.height) {
        return null;
    }

    const width = Math.max(1, source.width >>> 1);
    const height = Math.max(1, source.height >>> 1);
    const pitch = destinationPitch ?? width * bytesPerPixel;
    if (!Number.isInteger(pitch) || pitch < width * bytesPerPixel) return null;

    const out = new Uint8Array(pitch * height);
    const sample = (x: number, y: number, channel: number): number => {
        const sx = Math.min(source.width - 1, x);
        const sy = Math.min(source.height - 1, y);
        return source.data[sy * source.pitch + sx * bytesPerPixel + channel] ?? 0;
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dst = y * pitch + x * bytesPerPixel;
            for (let channel = 0; channel < bytesPerPixel; channel++) {
                if (filter === D3DTEXF_POINT) {
                    out[dst + channel] = sample(x * 2, y * 2, channel);
                    continue;
                }
                const sum = sample(x * 2, y * 2, channel)
                    + sample(x * 2 + 1, y * 2, channel)
                    + sample(x * 2, y * 2 + 1, channel)
                    + sample(x * 2 + 1, y * 2 + 1, channel);
                out[dst + channel] = Math.round(sum / 4);
            }
        }
    }
    return { data: out, pitch, width, height };
}
