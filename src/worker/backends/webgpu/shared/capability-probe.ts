import {
    D3DFMT_A16B16G16R16F,
    D3DFMT_G16R16F,
    D3DFMT_R16F,
    setD3D9FloatCapabilityContract,
} from "./float-format-policy";
import {
    D3D9_VOLUME_ADDRESS_CAPS_MASK,
    D3D9_VOLUME_FILTER_CAPS_MASK,
    D3DPTADDRESSCAPS_BORDER,
    D3DPTADDRESSCAPS_CLAMP,
    D3DPTADDRESSCAPS_MIRROR,
    D3DPTADDRESSCAPS_MIRRORONCE,
    D3DPTADDRESSCAPS_WRAP,
    D3DPTFILTERCAPS_MAGFLINEAR,
    D3DPTFILTERCAPS_MAGFPOINT,
    D3DPTFILTERCAPS_MINFLINEAR,
    D3DPTFILTERCAPS_MINFPOINT,
    D3DPTFILTERCAPS_MIPFLINEAR,
    D3DPTFILTERCAPS_MIPFPOINT,
    D3D9_VOLUME_UPLOAD_FORMATS,
    setD3D9VolumeCapabilityContract,
} from "./volume-policy";
import {
    D3D9_MSAA_SAMPLE_COUNTS,
    setD3D9MsaaCapabilityContract,
    type D3D9MsaaSampleCount,
} from "../d3d9/multisample";
import { setD3D9WebGpuCapabilityLimits } from "./webgpu-capability-limits";

type ProbeResult = {
    texture: boolean;
    upload: boolean;
    sampling: boolean;
    readback: boolean;
};

const FLOAT_FORMATS = [
    [D3DFMT_R16F, "r16float", 2],
    [D3DFMT_G16R16F, "rg16float", 4],
    [D3DFMT_A16B16G16R16F, "rgba16float", 8],
] as const;

// WebGPU constants are globals in a browser, but numeric fallbacks keep the
// probe deterministic in worker bootstrap tests and headless harnesses.
const COPY_SRC = 0x0001;
const COPY_DST = 0x0002;
const MAP_READ = 0x0001;
const TEXTURE_BINDING = 0x0004;
const RENDER_ATTACHMENT = 0x0010;

function textureUsage(name: "COPY_SRC" | "COPY_DST" | "TEXTURE_BINDING" | "RENDER_ATTACHMENT", fallback: number): number {
    const usage = (globalThis as typeof globalThis & { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage;
    return usage?.[name] ?? fallback;
}

function bufferUsage(name: "COPY_DST" | "MAP_READ", fallback: number): number {
    const usage = (globalThis as typeof globalThis & { GPUBufferUsage?: Record<string, number> }).GPUBufferUsage;
    return usage?.[name] ?? fallback;
}

function alignment256(value: number): number {
    return Math.ceil(value / 256) * 256;
}

function hasCompilationError(info: GPUCompilationInfo): boolean {
    return info.messages.some(message => message.type === "error");
}

function samplingShader(dimension: GPUTextureDimension): string {
    const coordType = dimension === "3d" ? "vec3<f32>" : "vec2<f32>";
    const coord = dimension === "3d" ? "vec3<f32>(0.5, 0.5, 0.5)" : "vec2<f32>(0.5, 0.5)";
    const textureType = dimension === "3d" ? "texture_3d<f32>" : "texture_2d<f32>";
    return `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: ${coordType},
}
@group(0) @binding(0) var sampledTexture: ${textureType};
@group(0) @binding(1) var linearSampler: sampler;
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var out: VertexOutput;
    out.position = vec4<f32>(positions[index], 0.0, 1.0);
    out.uv = ${coord};
    return out;
}
@fragment fn fs(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(sampledTexture, linearSampler, in.uv);
}`;
}

/**
 * The MSAA contract is about attachments and a matching multisample pipeline, not about
 * sampling: a shader with bindings would need a bind group set before the draw, and a
 * missing one is a validation error that reads exactly like "this adapter refuses 4x".
 */
function attachmentShader(): string {
    return `
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}`;
}

async function probeSampling(device: GPUDevice, texture: GPUTexture, dimension: GPUTextureDimension): Promise<boolean> {
    let target: GPUTexture | null = null;
    try {
        const shader = device.createShaderModule({ code: samplingShader(dimension) });
        if (typeof shader.getCompilationInfo === "function") {
            const info = await shader.getCompilationInfo();
            if (hasCompilationError(info)) return false;
        }
        const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
        target = device.createTexture({
            size: { width: 1, height: 1 },
            format: "rgba8unorm",
            usage: textureUsage("RENDER_ATTACHMENT", RENDER_ATTACHMENT),
        });
        device.pushErrorScope("validation");
        const pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module: shader, entryPoint: "vs" },
            fragment: { module: shader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
            primitive: { topology: "triangle-list" },
        });
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: texture.createView({ dimension }) },
                { binding: 1, resource: sampler },
            ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store" }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        if (typeof device.queue.onSubmittedWorkDone === "function") await device.queue.onSubmittedWorkDone();
        return !(await device.popErrorScope());
    } catch {
        try { await device.popErrorScope(); } catch { /* already popped or device lost */ }
        return false;
    } finally {
        target?.destroy();
    }
}

/**
 * Probe a format through the operations used by the D3D9 resource path.
 * WebGPU reports most validation failures asynchronously, so each operation
 * is wrapped in an error scope and every result fails closed.
 */
async function probeTexture(
    device: GPUDevice,
    format: GPUTextureFormat,
    dimension: GPUTextureDimension,
    bytesPerTexel: number,
): Promise<ProbeResult> {
    const result: ProbeResult = { texture: false, upload: false, sampling: false, readback: false };
    let texture: GPUTexture | null = null;
    let buffer: GPUBuffer | null = null;
    try {
        const size = dimension === "3d"
            ? { width: 1, height: 1, depthOrArrayLayers: 1 }
            : { width: 1, height: 1 };
        device.pushErrorScope("validation");
        texture = device.createTexture({
            size,
            dimension,
            format,
            usage: textureUsage("TEXTURE_BINDING", TEXTURE_BINDING) |
                textureUsage("COPY_DST", COPY_DST) |
                textureUsage("COPY_SRC", COPY_SRC),
        });
        texture.createView({ dimension });
        result.texture = !(await device.popErrorScope());
        if (!result.texture || !texture) return result;

        const bytesPerRow = alignment256(bytesPerTexel);
        const data = new Uint8Array(bytesPerRow);
        for (let i = 0; i < bytesPerTexel; i++) data[i] = (i + 1) & 0xff;
        device.pushErrorScope("validation");
        device.queue.writeTexture(
            { texture },
            data,
            { bytesPerRow, rowsPerImage: 1 },
            size,
        );
        result.upload = !(await device.popErrorScope());
        if (!result.upload) return result;

        result.sampling = await probeSampling(device, texture, dimension);

        device.pushErrorScope("validation");
        buffer = device.createBuffer({
            size: bytesPerRow,
            usage: bufferUsage("COPY_DST", 0x0008) | bufferUsage("MAP_READ", MAP_READ),
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture },
            { buffer, bytesPerRow, rowsPerImage: 1 },
            size,
        );
        device.queue.submit([encoder.finish()]);
        if (typeof device.queue.onSubmittedWorkDone !== "function") {
            await device.popErrorScope();
            return result;
        }
        await device.queue.onSubmittedWorkDone();
        result.readback = !(await device.popErrorScope());
        if (result.readback) {
            const mapMode = (globalThis as typeof globalThis & { GPUMapMode?: { READ: number } }).GPUMapMode?.READ ?? 1;
            if (typeof buffer.mapAsync !== "function") {
                result.readback = false;
            } else {
                await buffer.mapAsync(mapMode);
                const mapped = new Uint8Array(buffer.getMappedRange());
                result.readback = mapped.byteLength >= bytesPerTexel &&
                    data.subarray(0, bytesPerTexel).every((value, index) => mapped[index] === value);
                buffer.unmap();
            }
        }
    } catch {
        // A rejected mapAsync/getMappedRange is a readback refusal even if the
        // preceding copy scope had no validation error.
        result.readback = false;
        try { await device.popErrorScope(); } catch { /* already popped or device lost */ }
    } finally {
        buffer?.destroy();
        texture?.destroy();
    }
    return result;
}

async function probeMsaaSampleCount(device: GPUDevice, sampleCount: D3D9MsaaSampleCount): Promise<boolean> {
    let color: GPUTexture | null = null;
    let depth: GPUTexture | null = null;
    try {
        device.pushErrorScope("validation");
        const usage = textureUsage("RENDER_ATTACHMENT", RENDER_ATTACHMENT);
        color = device.createTexture({
            size: { width: 1, height: 1 },
            format: "rgba8unorm",
            sampleCount,
            usage,
        });
        depth = device.createTexture({
            size: { width: 1, height: 1 },
            format: "depth24plus-stencil8",
            sampleCount,
            usage,
        });
        color.createView();
        depth.createView();

        // Texture allocation alone is insufficient: D3D9's path binds both
        // attachments in one render pass and creates a matching multisample
        // pipeline. Exercise that complete contract so a count is not
        // advertised when only the descriptor happens to be accepted.
        const shader = device.createShaderModule({ code: attachmentShader() });
        if (typeof shader.getCompilationInfo === "function" &&
            hasCompilationError(await shader.getCompilationInfo())) {
            await device.popErrorScope();
            return false;
        }
        const pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module: shader, entryPoint: "vs" },
            fragment: { module: shader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
            primitive: { topology: "triangle-list" },
            depthStencil: {
                format: "depth24plus-stencil8",
                depthWriteEnabled: true,
                depthCompare: "always",
            },
            multisample: { count: sampleCount },
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: color.createView(), loadOp: "clear", storeOp: "store" }],
            depthStencilAttachment: {
                view: depth.createView(),
                depthLoadOp: "clear",
                depthStoreOp: "discard",
                depthClearValue: 1,
                stencilLoadOp: "clear",
                stencilStoreOp: "discard",
                stencilClearValue: 0,
            },
        });
        pass.setPipeline(pipeline);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        if (typeof device.queue.onSubmittedWorkDone === "function") {
            await device.queue.onSubmittedWorkDone();
        }
        return !(await device.popErrorScope());
    } catch {
        try { await device.popErrorScope(); } catch { /* already popped or device lost */ }
        return false;
    } finally {
        color?.destroy();
        depth?.destroy();
    }
}

/**
 * Install conservative, device-specific D3D9 capability contracts. The
 * caller supplies the exact device identity so a late probe from a lost device
 * cannot publish stale capabilities over a replacement device.
 */
export async function probeD3D9WebGpuCapabilities(
    device: GPUDevice,
    isCurrent: () => boolean = () => true,
): Promise<void> {
    if (!isCurrent()) return;
    const limits = device.limits;
    if (isCurrent() && Number.isSafeInteger(limits.maxTextureDimension2D) && Number.isSafeInteger(limits.maxTextureDimension3D)) {
        setD3D9WebGpuCapabilityLimits({
            maxTextureDimension2D: limits.maxTextureDimension2D,
            maxTextureDimension3D: limits.maxTextureDimension3D,
        });
    }

    const msaaResults = new Map<D3D9MsaaSampleCount, boolean>();
    for (const sampleCount of D3D9_MSAA_SAMPLE_COUNTS) {
        msaaResults.set(sampleCount, await probeMsaaSampleCount(device, sampleCount));
    }
    if (!isCurrent()) return;
    setD3D9MsaaCapabilityContract({
        supportsSampleCount: (sampleCount) => msaaResults.get(sampleCount) === true,
    });

    const floatResults = new Map<number, ProbeResult>();
    for (const [format, gpuFormat, bytesPerTexel] of FLOAT_FORMATS) {
        floatResults.set(format, await probeTexture(device, gpuFormat, "2d", bytesPerTexel));
    }
    if (!isCurrent()) return;
    setD3D9FloatCapabilityContract({
        supportsTexture: (format) => floatResults.get(format)?.texture === true,
        supportsUpload: (format) => floatResults.get(format)?.upload === true,
        supportsSampling: (format) => floatResults.get(format)?.sampling === true,
        supportsReadback: (format) => floatResults.get(format)?.readback === true,
    });

    const volume = await probeTexture(device, "rgba8unorm", "3d", 4);
    if (!isCurrent()) return;
    const maxExtent = limits.maxTextureDimension3D;
    setD3D9VolumeCapabilityContract(volume.texture && volume.upload && volume.sampling && volume.readback &&
        Number.isSafeInteger(maxExtent) && maxExtent > 0 ? {
        // The probe measures the generic rgba8unorm 3-D path, which is the path every
        // volume format takes: the level is decoded to RGBA8 on the CPU first. Answer
        // for the whole set that decoder covers, not for the one format probed.
        supportsTexture3D: (format) => D3D9_VOLUME_UPLOAD_FORMATS.has(format >>> 0),
        maxExtent,
        filterCaps: D3D9_VOLUME_FILTER_CAPS_MASK & (
            D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MINFLINEAR |
            D3DPTFILTERCAPS_MIPFPOINT | D3DPTFILTERCAPS_MIPFLINEAR |
            D3DPTFILTERCAPS_MAGFPOINT | D3DPTFILTERCAPS_MAGFLINEAR),
        addressCaps: D3D9_VOLUME_ADDRESS_CAPS_MASK & (
            D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_MIRROR |
            D3DPTADDRESSCAPS_CLAMP | D3DPTADDRESSCAPS_BORDER | D3DPTADDRESSCAPS_MIRRORONCE),
    } : null);
}
