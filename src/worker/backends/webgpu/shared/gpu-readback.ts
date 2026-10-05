/// <reference types="@webgpu/types" />

/**
 * Read one mip level of a GPUTexture back to RGBA8, via copyTextureToBuffer + mapAsync.
 * Shared by every "dump a render target that has no guest-memory backing" harness route
 * (D3D9 TextureStore RTs, D3D8 surfaces) so the row-padding and BGRA normalization live
 * in one place instead of being re-derived per backend.
 */
/** Bytes per texel of the attachment formats this reader can copy out. */
function readbackTexelBytes(format: GPUTextureFormat): number | null {
    switch (format) {
        case "r16float": return 2;
        case "rg16float": return 4;
        case "rgba16float": return 8;
        case "r32float": return 4;
        case "rg32float": return 8;
        case "rgba32float": return 16;
        // Four-channel 8-bit only: the RGBA readers below index four bytes per texel, so
        // r8unorm/rg8unorm would be read at the wrong stride rather than refused.
        default: return /^(rgba|bgra)8unorm(-srgb)?$/.test(format) ? 4 : null;
    }
}

/** IEEE half → f32.  Subnormals and Inf/NaN included; the caller clamps for display. */
function halfToFloat(bits: number): number {
    const sign = (bits & 0x8000) ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
    return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

export async function readGpuTextureRgba(
    device: GPUDevice,
    queue: GPUQueue,
    texture: GPUTexture,
    width: number,
    height: number,
    level = 0,
): Promise<Uint8Array> {
    const texelBytes = readbackTexelBytes(texture.format);
    if (texelBytes === null) {
        throw new Error(`readGpuTextureRgba: no readback layout for ${texture.format}`);
    }
    const padded = Math.ceil(width * texelBytes / 256) * 256;
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
        if (texture.format.endsWith("float")) {
            // A float attachment carries values outside [0,1]; this seam is the 8-bit
            // RGBA one every caller consumes, so clamp rather than wrap.
            const wide = texture.format.endsWith("32float");
            const channels = wide ? texelBytes >> 2 : texelBytes >> 1;
            const words = wide
                ? new Float32Array(mapped.buffer, mapped.byteOffset, mapped.byteLength >> 2)
                : new Uint16Array(mapped.buffer, mapped.byteOffset, mapped.byteLength >> 1);
            const shift = wide ? 2 : 1;
            for (let y = 0; y < height; y++) {
                const srcRow = (y * padded) >> shift;
                const dstRow = y * width * 4;
                for (let x = 0; x < width; x++) {
                    const s = srcRow + x * channels;
                    const d = dstRow + x * 4;
                    for (let c = 0; c < 4; c++) {
                        if (c >= channels) { rgba[d + c] = c === 3 ? 255 : 0; continue; }
                        const raw = words[s + c]!;
                        const value = wide ? raw : halfToFloat(raw);
                        rgba[d + c] = Math.max(0, Math.min(255, Math.round((value || 0) * 255)));
                    }
                }
            }
            return rgba;
        }
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

/**
 * RAW statistics for one attachment, sampled on a coarse grid, in the texture's OWN value
 * space. An 8-bit RGBA dump of an HDR target cannot tell 0.0 from 0.001 (both round to 0)
 * nor 1.0 from 40.0 (both clamp to 255) — which is exactly the question a black frame with
 * a live frame graph asks: "which stage first goes dark, and is the next one saturating?"
 */
export async function readGpuTextureStats(
    device: GPUDevice,
    queue: GPUQueue,
    texture: GPUTexture,
    width: number,
    height: number,
    gridSteps = 48,
): Promise<{
    min: number; max: number; mean: number; nonZeroPct: number; nan: number; samples: number;
    channels: Array<{ min: number; max: number; mean: number; nonZeroPct: number }>;
    uniform: boolean;
}> {
    const texelBytes = readbackTexelBytes(texture.format);
    if (texelBytes === null) throw new Error(`readGpuTextureStats: no layout for ${texture.format}`);
    const bytesPerRow = Math.ceil(width * texelBytes / 256) * 256;
    const readback = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture },
            { buffer: readback, bytesPerRow },
            { width, height, depthOrArrayLayers: 1 },
        );
        queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const raw = new Uint8Array(readback.getMappedRange());
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const wide = texture.format.endsWith("32float");
        const half = texture.format.endsWith("16float");
        const stepY = Math.max(1, Math.floor(height / gridSteps));
        const stepX = Math.max(1, Math.floor(width / gridSteps));
        // EVERY channel, not just the first. Reading one channel and labelling the answer
        // "the texture" reports a black opaque frame as saturated (alpha) and a blue-tinted
        // one as empty (red) — a rendering verdict drawn from a number that never described
        // the image.
        const bytesPerChannel = wide ? 4 : half ? 2 : 1;
        const channelCount = Math.max(1, Math.min(4, Math.floor(texelBytes / bytesPerChannel)));
        const readChannel = (offset: number): number => (
            wide ? view.getFloat32(offset, true)
                : half ? halfToFloat(view.getUint16(offset, true))
                : raw[offset]! / 255
        );
        const chMin = new Array<number>(channelCount).fill(Infinity);
        const chMax = new Array<number>(channelCount).fill(-Infinity);
        const chSum = new Array<number>(channelCount).fill(0);
        const chNonZero = new Array<number>(channelCount).fill(0);
        let min = Infinity, max = -Infinity, sum = 0, samples = 0, nonZero = 0, nan = 0;
        let texels = 0;
        for (let y = 0; y < height; y += stepY) {
            for (let x = 0; x < width; x += stepX) {
                const texel = y * bytesPerRow + x * texelBytes;
                texels++;
                for (let c = 0; c < channelCount; c++) {
                    const value = readChannel(texel + c * bytesPerChannel);
                    if (Number.isNaN(value)) { nan++; continue; }
                    if (value < min) min = value;
                    if (value > max) max = value;
                    sum += value;
                    if (value !== 0) { nonZero++; chNonZero[c]!++; }
                    if (value < chMin[c]!) chMin[c] = value;
                    if (value > chMax[c]!) chMax[c] = value;
                    chSum[c]! += value;
                    samples++;
                }
            }
        }
        const channels = Array.from({ length: channelCount }, (_, c) => ({
            min: texels ? chMin[c]! : 0,
            max: texels ? chMax[c]! : 0,
            mean: texels ? chSum[c]! / texels : 0,
            nonZeroPct: texels ? (100 * chNonZero[c]!) / texels : 0,
        }));
        return {
            min: samples ? min : 0,
            max: samples ? max : 0,
            mean: samples ? sum / samples : 0,
            nonZeroPct: samples ? (100 * nonZero) / samples : 0,
            nan,
            samples,
            channels,
            // The one question a gallery row must answer honestly: did anything VARY across
            // the surface, or is this a clear nobody drew over?
            uniform: channels.every((ch) => ch.min === ch.max),
        };
    } finally {
        readback.destroy();
    }
}
