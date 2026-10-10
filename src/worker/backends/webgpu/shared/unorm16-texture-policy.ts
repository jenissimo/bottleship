const expanded = { gpuFormat: 'rgba32float' as GPUTextureFormat, bytesPerTexel: 16 };

export function normalized16TexturePolicy(features?: ReadonlySet<string>): typeof expanded | null {
    // WebGPU's normalized 16-bit formats are unfilterable, including with texture format tiers.
    if (features?.has('float32-filterable')) return expanded;
    return null;
}

export function makeD3D9Unorm16Upload(
    source: Uint8Array, width: number, height: number, pitch: number, format: GPUTextureFormat,
): { data: Uint8Array; bytesPerRow: number } | null {
    if (format !== 'rgba32float' || width <= 0 || height <= 0 || pitch < width * 8
        || (height - 1) * pitch + width * 8 > source.byteLength) return null;
    const bytesPerRow = Math.ceil(width * 16 / 256) * 256;
    const data = new Uint8Array(bytesPerRow * height);
    const input = new DataView(source.buffer, source.byteOffset, source.byteLength);
    const output = new Float32Array(data.buffer);
    for (let y = 0; y < height; y++) {
        for (let channel = 0; channel < width * 4; channel++) {
            output[y * bytesPerRow / 4 + channel] = input.getUint16(y * pitch + channel * 2, true) / 65535;
        }
    }
    return { data, bytesPerRow };
}
