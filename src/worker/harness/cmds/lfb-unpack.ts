/**
 * lfbUnpackDiff — does the SHARED GPU unpacker agree with the scalar CPU decode?
 *
 * Moving the LFB conversion onto the GPU replaces one implementation of a pixel
 * layout with another. "The frame looks right" cannot separate the two: a channel
 * expansion off by one, an alpha lane taken from the wrong bit, a swap-chain
 * swizzle applied twice — every one of those still renders a plausible scene, and
 * a screenshot comparison has no resolution to see it. The only evidence that
 * settles it is the DATA: run both implementations over the same bytes and diff
 * the pixels.
 *
 * The 16-bit modes have exactly 65536 code points, so a 256x256 surface holding
 * `y*256+x` covers EVERY one of them, once, in a single dispatch — this is an
 * exhaustive proof for those, not a sample. The 32-bit modes cannot be exhausted
 * (2^32), so they get a stated sweep: every low-16 combination against a
 * deterministic high half, plus the per-channel extremes. The report says which
 * of the two it did, because "sampled" and "exhaustive" are different claims.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import { Mem } from "../../core/memory/mem-accessor";
import { readGpuTextureRgba } from "../../backends/webgpu/shared/gpu-readback";
import { TextureConverter } from "../../backends/webgpu/shared/texture-converter";
import { lfbFormatForGpuUnpack } from "../../backends/webgpu/glide/glide-lfb-format";
import { convertLfbToRgba } from "../../modules/glide2x/presenter";
import {
    GR_COLORFORMAT_ARGB,
    GR_LFBWRITEMODE_1555,
    GR_LFBWRITEMODE_555,
    GR_LFBWRITEMODE_565,
    GR_LFBWRITEMODE_8888,
    GR_LFBWRITEMODE_888,
} from "../../modules/glide2x/constants";
import type { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";

const SIDE = 256; // 256*256 == 65536 == every 16-bit code point, exactly once

type ModeSpec = { name: string; mode: number; bytesPerPixel: number; colorFormat: number };

const MODES: ModeSpec[] = [
    { name: "565", mode: GR_LFBWRITEMODE_565, bytesPerPixel: 2, colorFormat: GR_COLORFORMAT_ARGB },
    { name: "555", mode: GR_LFBWRITEMODE_555, bytesPerPixel: 2, colorFormat: GR_COLORFORMAT_ARGB },
    { name: "1555", mode: GR_LFBWRITEMODE_1555, bytesPerPixel: 2, colorFormat: GR_COLORFORMAT_ARGB },
    { name: "888", mode: GR_LFBWRITEMODE_888, bytesPerPixel: 4, colorFormat: GR_COLORFORMAT_ARGB },
    { name: "8888", mode: GR_LFBWRITEMODE_8888, bytesPerPixel: 4, colorFormat: GR_COLORFORMAT_ARGB },
];

/**
 * The source pixels for one mode. 2-byte modes get every code point; 4-byte modes
 * get all 65536 low halves against a deterministic high half, with the first row
 * overwritten by the per-channel extremes so 0x00/0xff lanes are never only
 * reachable by luck.
 */
function buildPattern(bytesPerPixel: number): { bytes: Uint8Array; exhaustive: boolean } {
    const count = SIDE * SIDE;
    const bytes = new Uint8Array(count * bytesPerPixel);
    if (bytesPerPixel === 2) {
        const u16 = new Uint16Array(bytes.buffer);
        for (let i = 0; i < count; i++) u16[i] = i;
        return { bytes, exhaustive: true };
    }
    const u32 = new Uint32Array(bytes.buffer);
    let s = 0x1234567 >>> 0;
    for (let i = 0; i < count; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        u32[i] = ((s & 0xffff0000) | i) >>> 0;
    }
    const extremes = [
        0x00000000, 0xffffffff, 0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000,
        0x00ffffff, 0xff00ffff, 0xffff00ff, 0xffffff00, 0x01020304, 0x80808080,
    ];
    for (let i = 0; i < SIDE; i++) u32[i] = extremes[i % extremes.length]! >>> 0;
    return { bytes, exhaustive: false };
}

/**
 * Run one mode against one destination format.
 *
 * BOTH formats are checked, deliberately. On a bgra8unorm target the converter
 * emits BGRA and the readback swizzles it back, so a swizzle that is wrong on
 * both sides cancels out and the diff passes on evidence it did not earn. The
 * rgba8unorm arm has no swizzle on either side, so a compensating pair cannot
 * survive it.
 */
async function diffOneMode(
    backend: WebGPUBackend,
    converter: TextureConverter,
    spec: ModeSpec,
    format: GPUTextureFormat,
): Promise<Record<string, unknown>> {
    const decision = lfbFormatForGpuUnpack(spec.mode, spec.colorFormat, spec.bytesPerPixel);
    if (!decision.ok) return { mode: spec.name, targetFormat: format, skipped: true, declined: decision.reason };

    const device = backend.getDevice();
    const queue = device?.queue;
    if (!device || !queue) throw new HarnessError("no GPU device", HarnessErrorCode.UNSUPPORTED);

    const pitch = SIDE * spec.bytesPerPixel;
    const { bytes, exhaustive } = buildPattern(spec.bytesPerPixel);

    const process = sys().process;
    if (!process) throw new HarnessError("no guest process to stage the source in", HarnessErrorCode.UNSUPPORTED);
    const addr = process.allocateSurface(bytes.length);
    if (!addr) throw new HarnessError("could not allocate a staging surface", HarnessErrorCode.INTERNAL);

    try {
        if (Mem.writeBytes(addr, bytes) !== bytes.length) {
            throw new HarnessError("could not write the source pattern into guest memory", HarnessErrorCode.INTERNAL);
        }

        // CPU oracle: the same decode the presenter has always used for this mode,
        // read back out of guest memory so both paths see identical bytes.
        const src = Mem.readBytes(addr, bytes.length);
        if (!src) throw new HarnessError("could not read the staged pattern back", HarnessErrorCode.INTERNAL);
        const expected = new Uint8Array(SIDE * SIDE * 4);
        convertLfbToRgba(
            src, pitch, SIDE, SIDE, spec.mode, spec.colorFormat, spec.bytesPerPixel === 4,
            new Uint32Array(expected.buffer),
        );

        const texture = device.createTexture({
            size: { width: SIDE, height: SIDE, depthOrArrayLayers: 1 },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        });
        try {
            const encoder = device.createCommandEncoder();
            converter.convertToTexture(
                encoder, Mem.getView()!, addr, SIDE, SIDE, pitch, decision.format, texture,
                undefined, format,
            );
            queue.submit([encoder.finish()]);
            converter.destroyPendingAfterSubmit();

            // readGpuTextureRgba normalizes a bgra8unorm target back to canonical RGBA,
            // so both arms are compared in the same seam the presenter produces.
            const actual = await readGpuTextureRgba(device, queue, texture, SIDE, SIDE);

            let mismatches = 0;
            let maxDelta = 0;
            let first: Record<string, unknown> | null = null;
            for (let i = 0; i < expected.length; i++) {
                const d = Math.abs(expected[i]! - actual[i]!);
                if (d === 0) continue;
                mismatches++;
                if (d > maxDelta) maxDelta = d;
                if (!first) {
                    const px = i >> 2;
                    const x = px % SIDE, y = (px / SIDE) | 0;
                    const o = px * 4;
                    first = {
                        pixel: px, x, y, channel: "rgba"[i & 3],
                        source: spec.bytesPerPixel === 2
                            ? `0x${((bytes[px * 2]! | (bytes[px * 2 + 1]! << 8))).toString(16).padStart(4, "0")}`
                            : `0x${(new Uint32Array(bytes.buffer)[px]! >>> 0).toString(16).padStart(8, "0")}`,
                        expectedRgba: [expected[o], expected[o + 1], expected[o + 2], expected[o + 3]],
                        actualRgba: [actual[o], actual[o + 1], actual[o + 2], actual[o + 3]],
                    };
                }
            }

            return {
                mode: spec.name,
                agree: mismatches === 0,
                coverage: exhaustive ? "exhaustive (every 16-bit code point, once)" : "sweep (all 65536 low halves + per-channel extremes)",
                pixels: SIDE * SIDE,
                mismatchedBytes: mismatches,
                maxChannelDelta: maxDelta,
                firstMismatch: first,
                targetFormat: format,
                // The masks that ACTUALLY ran, not the ones the source says. A harness
                // verb reads whatever code the worker last loaded, so an edit without a
                // reload is answered by the old build — which reports a clean pass on a
                // change that never ran. Printing the resolved descriptor makes that
                // visible instead of silent.
                sourceFormat: {
                    bpp: decision.format.bpp,
                    rMask: `0x${(decision.format.rMask >>> 0).toString(16)}`,
                    gMask: `0x${(decision.format.gMask >>> 0).toString(16)}`,
                    bMask: `0x${(decision.format.bMask >>> 0).toString(16)}`,
                    aMask: `0x${(decision.format.aMask >>> 0).toString(16)}`,
                },
            };
        } finally {
            texture.destroy();
        }
    } finally {
        process.memory.free(addr);
    }
}

export function registerLfbUnpackCommands(svc: HarnessService): void {
    /**
     * lfbUnpackDiff({ mode? }) — hold the shared GPU unpacker against the scalar CPU
     * decode, pixel for pixel, and say which modes agree.
     *
     * `agree:false` with a `firstMismatch` naming the source code point and both
     * RGBA values is the whole point: it localizes a divergence to one lane of one
     * layout, which no screenshot can do. A mode the mapping DECLINES reports
     * `skipped` with the reason rather than passing vacuously.
     */
    svc.register("lfbUnpackDiff", async (args) => {
        const opts = (args[0] ?? {}) as { mode?: string; format?: string };
        const backend = sys().services?.render?.getBackend?.() as WebGPUBackend | null;
        if (!backend || backend.kind !== "webgpu") {
            throw new HarnessError("no WebGPU backend (no render device created yet)", HarnessErrorCode.UNSUPPORTED);
        }
        const device = backend.getDevice();
        if (!device) throw new HarnessError("no GPU device", HarnessErrorCode.UNSUPPORTED);

        const wanted = opts.mode ? MODES.filter((m) => m.name === opts.mode) : MODES;
        if (!wanted.length) {
            throw new HarnessError(`unknown mode '${opts.mode}' (have ${MODES.map((m) => m.name).join(", ")})`, HarnessErrorCode.BAD_ARGS);
        }

        const formats: GPUTextureFormat[] = opts.format
            ? [opts.format as GPUTextureFormat]
            : ["rgba8unorm", "bgra8unorm"];

        const converter = new TextureConverter(device, device.queue);
        const results: Array<Record<string, unknown>> = [];
        try {
            for (const spec of wanted) {
                for (const format of formats) results.push(await diffOneMode(backend, converter, spec, format));
            }
        } finally {
            converter.destroy();
        }

        const checked = results.filter((r) => !r.skipped);
        return {
            allAgree: checked.length > 0 && checked.every((r) => r.agree === true),
            checked: checked.length,
            declined: results.filter((r) => r.skipped).length,
            results,
            formats,
            swapChainFormat: backend.getFormat() ?? null,
            note: "agree:true over an exhaustive coverage is a proof for that mode+format, not a sample. "
                + "A declined mode keeps the CPU decode and is NOT evidence either way. Both destination "
                + "formats are checked so a swizzle wrong on both the write and the readback cannot cancel out. "
                + "`sourceFormat` is the descriptor that RAN: after editing the mapping, reload the page or "
                + "this verb answers from the build the worker already had.",
        };
    });
}
