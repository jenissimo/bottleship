/// <reference types="@webgpu/types" />

/**
 * Read one mip level of a GPUTexture back to RGBA8, via copyTextureToBuffer + mapAsync.
 * Shared by every "dump a render target that has no guest-memory backing" harness route
 * (D3D9 TextureStore RTs, D3D8 surfaces) so the row-padding and BGRA normalization live
 * in one place instead of being re-derived per backend.
 */
export async function readGpuTextureRgba(
    device: GPUDevice,
    queue: GPUQueue,
    texture: GPUTexture,
    width: number,
    height: number,
    level = 0,
): Promise<Uint8Array> {
    const padded = Math.ceil(width * 4 / 256) * 256;
    const readback = device.createBuffer({
        size: padded * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture, mipLevel: level },
            { buffer: readback, bytesPerRow: padded },
            { width, height, depthOrArrayLayers: 1 },
        );
        queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const rgba = new Uint8Array(width * height * 4);
        const bgra = texture.format.startsWith("bgra");
        for (let y = 0; y < height; y++) {
            const srcRow = y * padded;
            const dstRow = y * width * 4;
            if (!bgra) {
                rgba.set(mapped.subarray(srcRow, srcRow + width * 4), dstRow);
                continue;
            }
            // A swap-chain/render-target allocated bgra8unorm reports B,G,R,A bytes from
            // copyTextureToBuffer; normalize to the canonical RGBA8 seam every caller expects.
            for (let x = 0; x < width; x++) {
                const s = srcRow + x * 4;
                const d = dstRow + x * 4;
                rgba[d] = mapped[s + 2]!;
                rgba[d + 1] = mapped[s + 1]!;
                rgba[d + 2] = mapped[s]!;
                rgba[d + 3] = mapped[s + 3]!;
            }
        }
        return rgba;
    } finally {
        readback.destroy();
    }
}
