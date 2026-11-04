/**
 * GPU allocation census — an ESTIMATE of the bytes live GPUBuffers and GPUTextures hold,
 * for the harness `footprint` verb (memory diagnosis on devices where no OS counter is
 * readable, i.e. iOS).
 *
 * Installed on a device by wrapping `createBuffer` / `createTexture`; each created object's
 * `destroy()` is wrapped to retire its bytes once. Objects dropped without `destroy()` stay
 * counted until garbage collection would have reclaimed them, which WebGPU does not report —
 * so `live*` is an upper bound for leaked-by-GC objects and exact for destroyed ones.
 * Texture sizes are computed from format/extent/mips/samples; driver padding is not visible.
 */

interface Census { buffers: number; bufferBytes: number; textures: number; textureBytes: number;
    createdBuffers: number; createdTextures: number; destroyedBuffers: number; destroyedTextures: number }

const census: Census = { buffers: 0, bufferBytes: 0, textures: 0, textureBytes: 0,
    createdBuffers: 0, createdTextures: 0, destroyedBuffers: 0, destroyedTextures: 0 };
const instrumented = new WeakSet<GPUDevice>();
/** Live buffers of at least LARGE_BUFFER bytes, by label — the usual suspects of a bloat. */
const LARGE_BUFFER = 4 * 1024 * 1024;
const largeBuffers = new Set<{ label: string; bytes: number; usage: number }>();

/** Bytes per texel (or per 4x4 block / 16 for block-compressed formats). */
function bytesPerTexel(format: string): number {
    if (format.startsWith('bc1') || format.startsWith('bc4') || format.startsWith('etc2-rgb8') || format.startsWith('eac-r11')) return 0.5;
    if (format.startsWith('bc') || format.startsWith('etc2') || format.startsWith('eac') || format.startsWith('astc-4x4')) return 1;
    if (format.startsWith('astc')) return 1; // coarse: larger ASTC blocks are smaller
    if (format.startsWith('rgba32') ) return 16;
    if (format.startsWith('rg32') || format.startsWith('rgba16')) return 8;
    if (format === 'depth32float-stencil8') return 5;
    if (format.startsWith('r8') || format === 'stencil8') return 1;
    if (format.startsWith('rg8') || format.startsWith('r16') || format === 'depth16unorm') return 2;
    return 4;
}

function textureBytes(d: GPUTextureDescriptor): number {
    const size = d.size as GPUExtent3DDict | number[];
    const w = Array.isArray(size) ? (size[0] ?? 1) : (size.width ?? 1);
    const h = Array.isArray(size) ? (size[1] ?? 1) : (size.height ?? 1);
    const layers = Array.isArray(size) ? (size[2] ?? 1) : (size.depthOrArrayLayers ?? 1);
    const is3d = d.dimension === '3d';
    const bpt = bytesPerTexel(String(d.format));
    let total = 0;
    let lw = w, lh = h, ld = is3d ? layers : 1;
    const levels = Math.max(1, d.mipLevelCount ?? 1);
    for (let i = 0; i < levels; i++) {
        total += Math.max(1, lw) * Math.max(1, lh) * Math.max(1, ld) * bpt;
        lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1); if (is3d) ld = Math.max(1, ld >> 1);
    }
    return Math.ceil(total * (is3d ? 1 : layers) * Math.max(1, d.sampleCount ?? 1));
}

/** Wrap a device's resource constructors so the census sees them. Idempotent per device. */
export function instrumentGpuDeviceCensus(device: GPUDevice): void {
    if (instrumented.has(device)) return;
    instrumented.add(device);
    const createBuffer = device.createBuffer.bind(device);
    const createTexture = device.createTexture.bind(device);
    device.createBuffer = (desc: GPUBufferDescriptor): GPUBuffer => {
        const buf = createBuffer(desc);
        const bytes = Number(desc.size) || 0;
        census.buffers++; census.bufferBytes += bytes; census.createdBuffers++;
        const big = bytes >= LARGE_BUFFER ? { label: desc.label ?? '', bytes, usage: desc.usage } : null;
        if (big) largeBuffers.add(big);
        const destroy = buf.destroy.bind(buf);
        let live = true;
        buf.destroy = () => {
            if (live) {
                live = false; census.buffers--; census.bufferBytes -= bytes; census.destroyedBuffers++;
                if (big) largeBuffers.delete(big);
            }
            return destroy();
        };
        return buf;
    };
    device.createTexture = (desc: GPUTextureDescriptor): GPUTexture => {
        const tex = createTexture(desc);
        const bytes = textureBytes(desc);
        census.textures++; census.textureBytes += bytes; census.createdTextures++;
        const destroy = tex.destroy.bind(tex);
        let live = true;
        tex.destroy = () => {
            if (live) { live = false; census.textures--; census.textureBytes -= bytes; census.destroyedTextures++; }
            return destroy();
        };
        return tex;
    };
}

/** Snapshot (this realm's devices only). */
export function gpuMemoryCensus(): Census & { largeBuffers: Array<{ label: string; bytes: number; usage: number }> } {
    return { ...census, largeBuffers: [...largeBuffers].sort((a, b) => b.bytes - a.bytes).slice(0, 16) };
}
