/**
 * WASM texture kernels: S3TC block decode and DirectDraw surface conversion.
 *
 * This is a BULK CPU FALLBACK only. Hardware BC upload and the WebGPU compute
 * converters never come through here — the kernel exists for the paths that
 * already had to touch every texel in JS.
 *
 * NOT ZERO-COPY. The module owns a private linear memory that is not the guest
 * address space, so every call stages the source in and copies the RGBA result
 * back out. Two copies per surface is only worth paying when the per-pixel work
 * is large enough to dominate them, which is what `MIN_PIXELS` and the callers'
 * routing predicates decide. A path whose TypeScript form is already a single
 * lookup-table pass (unkeyed RGB565) measures SLOWER through here; it is
 * deliberately not routed, and `tools/tests/pixel-routing.test.ts` pins that.
 *
 * The kernels validate every span themselves (see `validate_spans` in
 * tools/build-dxt-kernel/lib.rs), so a caller bug cannot turn into an
 * out-of-bounds write — a rejected call writes nothing and returns non-zero.
 */

/** Matches the kernel's `--max-memory` link argument. */
const MAX_MEMORY = 64 * 1024 * 1024;
/** Below this the staging copies outweigh anything the kernel can win back. */
const MIN_PIXELS = 256;

export const DXT_KERNEL_URL = "/dxt-kernel.wasm";
export const DXT_KERNEL_SIMD_URL = "/dxt-kernel-simd.wasm";

export type KernelVariant = "scalar" | "simd" | "provided";

interface KernelExports extends WebAssembly.Exports {
    memory: WebAssembly.Memory;
    __heap_base: WebAssembly.Global;
    decode_dxt: (kind: number, src: number, srcLen: number, pitch: number,
        width: number, height: number, dst: number, dstLen: number) => number;
    convert_pixels: (kind: number, src: number, srcLen: number, pitch: number,
        width: number, height: number, dst: number, dstLen: number,
        keyed: number, low: number, high: number) => number;
}

export class TextureKernel {
    private readonly api: KernelExports;
    /** First address above the module's data segments and stack. */
    private readonly base: number;
    private bytes: Uint8Array;
    private output: Uint8Array = new Uint8Array(0);
    private outputOffset = -1;

    constructor(instance: WebAssembly.Instance) {
        this.api = instance.exports as KernelExports;
        if (!(this.api.memory instanceof WebAssembly.Memory) ||
            !(this.api.__heap_base instanceof WebAssembly.Global) ||
            typeof this.api.decode_dxt !== "function" ||
            typeof this.api.convert_pixels !== "function") {
            throw new Error("texture kernel: unexpected WASM ABI");
        }
        this.base = Number(this.api.__heap_base.value);
        this.bytes = new Uint8Array(this.api.memory.buffer);
    }

    /**
     * Lay input at `base` and output 16-byte aligned above it, growing once and
     * keeping the arena for the life of the module. Returns -1 when the layout
     * does not fit, which the callers treat as "decline", never as an error.
     */
    private reserve(inputBytes: number, outputBytes: number): number {
        const out = Math.ceil((this.base + inputBytes) / 16) * 16;
        const required = out + outputBytes;
        if (!Number.isSafeInteger(required) || inputBytes < 0 || outputBytes < 0 || required > MAX_MEMORY) return -1;
        if (required > this.api.memory.buffer.byteLength) {
            const size = Math.min(MAX_MEMORY, Math.max(required, this.api.memory.buffer.byteLength * 2));
            try {
                this.api.memory.grow(Math.ceil((size - this.api.memory.buffer.byteLength) / 65536));
            } catch (error) {
                if (error instanceof RangeError) return -1;
                throw error;
            }
        }
        // memory.grow detaches every view over the old buffer, so the cached
        // output view has to be re-derived rather than reused.
        if (this.bytes.buffer !== this.api.memory.buffer) {
            this.bytes = new Uint8Array(this.api.memory.buffer);
            this.outputOffset = -1;
        }
        if (this.outputOffset !== out || this.output.length !== outputBytes) {
            this.output = this.bytes.subarray(out, out + outputBytes);
            this.outputOffset = out;
        }
        return out;
    }

    /** `src`/`dst` extents are the caller's contract; the kernel re-checks them. */
    tryDecodeDxt(kind: number, src: Uint8Array, pitch: number, width: number,
        height: number, dst: Uint8Array, srcBytes: number): boolean {
        if (width * height < MIN_PIXELS) return false;
        const outputBytes = width * height * 4;
        const out = this.reserve(srcBytes, outputBytes);
        if (out < 0) return false;
        this.bytes.set(src.length === srcBytes ? src : src.subarray(0, srcBytes), this.base);
        const status = this.api.decode_dxt(kind, this.base, srcBytes, pitch, width, height, out, outputBytes);
        if (status !== 0) throw new Error(`texture kernel rejected a validated DXT decode (${status})`);
        dst.set(this.output);
        return true;
    }

    /** Conversion and colour keying fused into one pass over the source. */
    tryConvertPixels(kind: number, src: Uint8Array, srcOffset: number, pitch: number,
        width: number, height: number, dst: Uint8Array, key?: { low: number; high: number }): boolean {
        const bpp = kind === 1 || kind === 2 || kind === 3 ? 2 : kind === 6 || kind === 7 ? 4 : 0;
        if (!bpp || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
            !Number.isSafeInteger(pitch) || !Number.isSafeInteger(srcOffset) ||
            width <= 0 || height <= 0 || srcOffset < 0 || pitch < width * bpp ||
            width * height < MIN_PIXELS) return false;
        const inputBytes = (height - 1) * pitch + width * bpp;
        const outputBytes = width * height * 4;
        if (!Number.isSafeInteger(inputBytes) || !Number.isSafeInteger(outputBytes) ||
            srcOffset + inputBytes > src.length || outputBytes > dst.length) return false;
        const out = this.reserve(inputBytes, outputBytes);
        if (out < 0) return false;
        this.bytes.set(srcOffset === 0 && src.length === inputBytes ? src : src.subarray(srcOffset, srcOffset + inputBytes), this.base);
        const status = this.api.convert_pixels(kind, this.base, inputBytes, pitch, width, height,
            out, outputBytes, key ? 1 : 0, key?.low ?? 0, key?.high ?? 0);
        if (status !== 0) throw new Error(`texture kernel rejected a validated conversion (${status})`);
        dst.set(this.output.subarray(0, outputBytes));
        return true;
    }
}

let kernel: TextureKernel | null = null;
let initialization: Promise<boolean> | null = null;
let failure: string | null = null;
let variant: KernelVariant | null = null;

/** Validates a module whose only body is `v128.const ...; drop` — never executed. */
export function supportsTextureSimd(): boolean {
    return typeof WebAssembly !== "undefined" && WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 23, 1, 21, 0, 253, 12,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 11,
    ]));
}

async function fromUrl(url: string, request: typeof fetch): Promise<TextureKernel> {
    const response = await request(url);
    if (!response.ok) throw new Error(`texture kernel HTTP ${response.status}`);
    const result = await WebAssembly.instantiate(await response.arrayBuffer());
    return new TextureKernel(result.instance);
}

/** `request` is injectable for tests only; per-surface dispatch never touches it. */
export async function loadTextureKernel(request: typeof fetch = fetch, simd = supportsTextureSimd()): Promise<{
    kernel: TextureKernel; variant: "scalar" | "simd"; warning: string | null;
}> {
    let warning: string | null = null;
    if (simd) {
        try { return { kernel: await fromUrl(DXT_KERNEL_SIMD_URL, request), variant: "simd", warning }; }
        catch (error) { warning = `SIMD unavailable: ${String(error)}`; }
    }
    return { kernel: await fromUrl(DXT_KERNEL_URL, request), variant: "scalar", warning };
}

/**
 * Idempotent. A SIMD failure retries the scalar module; both failing leaves
 * every caller on its TypeScript path, which is always a complete implementation.
 */
export function initializeTextureKernel(bytes?: BufferSource): Promise<boolean> {
    if (initialization) return initialization;
    initialization = (async () => {
        try {
            if (typeof WebAssembly === "undefined") return false;
            if (bytes) {
                const result = await WebAssembly.instantiate(bytes);
                kernel = new TextureKernel(result.instance);
                variant = "provided";
            } else {
                const loaded = await loadTextureKernel();
                kernel = loaded.kernel;
                variant = loaded.variant;
                failure = loaded.warning;
            }
            return true;
        } catch (error) {
            failure = String(error);
            return false;
        }
    })();
    return initialization;
}

export function getTextureKernelStatus(): { ready: boolean; failure: string | null; variant: KernelVariant | null } {
    return { ready: kernel !== null, failure, variant };
}

export function tryDecodeDxtKernel(kind: number, src: Uint8Array, pitch: number,
    width: number, height: number, dst: Uint8Array, srcBytes: number): boolean {
    return kernel !== null && kernel.tryDecodeDxt(kind, src, pitch, width, height, dst, srcBytes);
}

export function tryConvertPixelKernel(kind: number, src: Uint8Array, srcOffset: number, pitch: number,
    width: number, height: number, dst: Uint8Array, key?: { low: number; high: number }): boolean {
    return kernel !== null && kernel.tryConvertPixels(kind, src, srcOffset, pitch, width, height, dst, key);
}

// Warm the kernel as soon as the worker module graph loads: the first texture
// upload is inside a frame, and an await there would stall it. Guarded on a
// served origin so test/tool imports never reach for an asset that isn't there.
if (typeof location !== "undefined" && (location.protocol === "https:" || location.protocol === "http:")) {
    void initializeTextureKernel();
}
