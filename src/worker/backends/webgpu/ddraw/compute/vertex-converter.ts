/**
 * GPU Compute Shader for Vertex Format Conversion
 *
 * Converts D3D7 FVF vertex format to unified GPU format.
 * Uses compute shaders for large batches, CPU fallback for small ones.
 *
 * GPU path returns GPUBuffer directly (no readback) for maximum performance.
 * XYZRHW (TL-vertices) are converted to clip-space in shader.
 */

import { Logger, LogCategory } from "../../../../core/logger";
import { profiler } from "../../../../core/profiler";
import {
    D3DFVF_XYZ,
    D3DFVF_XYZRHW,
    D3DFVF_NORMAL,
    D3DFVF_PSIZE,
    D3DFVF_DIFFUSE,
    D3DFVF_SPECULAR,
    D3DFVF_POSITION_MASK,
    D3DFVF_XYZW,
    D3DFVF_XYZB1,
    D3DFVF_XYZB2,
    D3DFVF_XYZB3,
    D3DFVF_XYZB4,
    D3DFVF_XYZB5,
} from "../../../../modules/ddraw/constants";
import { D3D_PIXEL_CENTER_OFFSET_PX } from "../../pixel-center";

// Track warned FVF values to avoid log spam
const warnedFVFs = new Set<number>();

// One-off diagnostic log per FVF (fvf + posType + stride + first 1–2 verts) for "tunnel" debugging
const diagnosticLoggedFVFs = new Set<number>();

// Threshold for using GPU compute vs CPU fallback
// Lowered from 256 to 64 to reduce ring buffer pressure for high-draw-count games (Sea Dogs)
export const GPU_VERTEX_THRESHOLD = 64;

// Output vertex format: 64 bytes (16 x u32): pos(4) + normal(3) + diffuse(1) + specular(1) + uv0(2) + uv1(2) + uv2(2) + padding(1)
export const OUTPUT_VERTEX_BYTES = 64;
export const OUTPUT_VERTEX_U32S = 16;

function getFvfTexCoordComponentCount(fvf: number, stage: number): number {
    const texCount = (fvf & 0xf00) >> 8;
    if (stage < 0 || stage >= texCount) return 0;

    const sizeBits = (fvf >>> (16 + stage * 2)) & 0x3;
    switch (sizeBits) {
        case 0: return 2; // D3DFVF_TEXTUREFORMAT2
        case 1: return 3; // D3DFVF_TEXTUREFORMAT3
        case 2: return 4; // D3DFVF_TEXTUREFORMAT4
        case 3: return 1; // D3DFVF_TEXTUREFORMAT1
        default: return 2;
    }
}

/**
 * Compute FVF vertex stride from POSITION_MASK + other components.
 * Shared by vertex-converter, draw-handler, and ddraw-backend-executor.
 * @throws if posType is unsupported (e.g. unknown mask value)
 */
export function computeFvfStride(fvf: number): number {
    const posType = fvf & D3DFVF_POSITION_MASK;
    let posBytes = 0;
    switch (posType) {
        case D3DFVF_XYZ:
            posBytes = 12;
            break;
        case D3DFVF_XYZRHW:
        case D3DFVF_XYZW:
            posBytes = 16;
            break;
        case D3DFVF_XYZB1:
            posBytes = 16;
            break;
        case D3DFVF_XYZB2:
            posBytes = 20;
            break;
        case D3DFVF_XYZB3:
            posBytes = 24;
            break;
        case D3DFVF_XYZB4:
            posBytes = 28;
            break;
        case D3DFVF_XYZB5:
            posBytes = 32;
            break;
        default:
            throw new Error(`computeFvfStride: Unsupported POSITION_MASK posType=0x${posType.toString(16)} fvf=0x${fvf.toString(16)}`);
    }
    let stride = posBytes;
    if ((fvf & D3DFVF_NORMAL) !== 0) stride += 12;
    if ((fvf & D3DFVF_PSIZE) !== 0) stride += 4;
    if ((fvf & D3DFVF_DIFFUSE) !== 0) stride += 4;
    if ((fvf & D3DFVF_SPECULAR) !== 0) stride += 4;
    const texCount = (fvf & 0xf00) >> 8;
    for (let stage = 0; stage < texCount; stage++) {
        stride += getFvfTexCoordComponentCount(fvf, stage) * 4;
    }
    return stride || 32;
}


// Workgroup size for compute shader
const WORKGROUP_SIZE = 64;

/**
 * Result of GPU vertex conversion - returns buffer directly (no readback)
 */
export interface GpuVertexConversionResult {
    buffer: GPUBuffer;
    size: number;
    stride: number; // Always OUTPUT_VERTEX_BYTES (64)
    count: number;
    offset: number; // Offset in buffer where vertex data starts (for setVertexBuffer)
}

/**
 * Vertex format configuration for shader
 */
interface VertexFormatConfig {
    fvf: number;
    hasXYZRHW: boolean;
    hasXYZ: boolean;
    hasXYZW: boolean;
    hasNormal: boolean;
    hasPSize: boolean;
    hasDiffuse: boolean;
    hasSpecular: boolean;
    texCount: number;
    texCoordDims: readonly number[];
    texCoordOffsets: readonly number[];
    srcStride: number;
    posBytes: number;
    /** Number of blend weights stored in the vertex (D3DFVF_XYZBn → n). 0 for non-blend FVFs. */
    blendWeights: number;
}

/**
 * Fixed-function vertex-blend (GPU skinning) input for convertCPU.
 * `palette[i]` is the D3DTS_WORLDMATRIX(i) world matrix (row-major, row-vector convention;
 * null → identity). `count` is the matrix/iteration count (D3DRS_VERTEXBLEND weights + 1). The
 * blended output is WORLD-space position/normal: pos = Σ wᵢ·(pos·WORLDᵢ), the last weight
 * = 1 − Σ(others). The caller must supply an MVP of VIEW·PROJ and a World×View of VIEW
 * (i.e. world=identity) for the draw so the render VS / FFP lighting do not re-apply world.
 * Mirrors DXVK d3d9_fixed_function_vert.vert main() (D3D9FF_VertexBlendMode_Normal).
 *
 * INDEXED blend (D3DRS_INDEXEDVERTEXBLENDENABLE): when `indexed` is true the vertex's LAST beta
 * component is a D3DFVF_LASTBETA_UBYTE4 dword packing 4 unsigned-BYTE matrix indices; iteration i
 * then selects palette[index_i] (index_i = (packed >> (i*8)) & 0xFF) instead of palette[i]. In
 * this mode `palette` is the FULL matrix palette [0..cap) (a per-vertex index selects into it, so
 * it can't be shrunk to `count`), and `count` iterations consume index components 0..count-1 with
 * the same weight/last-implicit rule. Mirrors DXVK d3d9_fixed_function_vert.vert:380-409
 * (roundEven(in_BlendIndices[i]) → WorldViewArray[arrayIndex]).
 */
export interface VertexBlendInput {
    palette: readonly (Float32Array | null)[];
    count: number;
    /** D3DRS_INDEXEDVERTEXBLENDENABLE: read per-vertex UBYTE4 matrix indices (see above). */
    indexed?: boolean;
}

/**
 * Generate compute shader for specific vertex format
 */
function generateVertexConverterShader(config: VertexFormatConfig): string {
    const {
        hasXYZRHW,
        hasXYZ,
        hasXYZW,
        hasNormal,
        hasPSize,
        hasDiffuse,
        hasSpecular,
        texCount,
        posBytes,
        texCoordDims,
        texCoordOffsets,
    } = config;

    // Position: we read 3 floats (XYZ/XYZB*) or 4 (XYZRHW/XYZW). posBytes advances past blend weights.

    let srcOffset = 0;
    const posOffset = srcOffset;
    srcOffset += posBytes;

    const normalOffset = srcOffset;
    if (hasNormal) srcOffset += 12;

    const psizeOffset = srcOffset;
    if (hasPSize) srcOffset += 4;

    const diffuseOffset = srcOffset;
    if (hasDiffuse) srcOffset += 4;

    const specularOffset = srcOffset;
    if (hasSpecular) srcOffset += 4;

    const tex0Offset = texCoordOffsets[0] ?? srcOffset;
    const tex1Offset = texCoordOffsets[1] ?? tex0Offset;
    const tex2Offset = texCoordOffsets[2] ?? tex1Offset;
    const tex0Dims = texCoordDims[0] ?? 0;
    const tex1Dims = texCoordDims[1] ?? 0;
    const tex2Dims = texCoordDims[2] ?? 0;

    // For XYZRHW: convert screen coords to clip-space using rhw (1/w). For XYZW: already clip-space, pass through. For XYZ/XYZB*: world/view, MVP later.
    const posConversion =
        hasXYZRHW
            ? `
    // XYZRHW: screen pixels -> NDC, then to clip-space using w = 1/rhw
    // rhw = 1/w, so w = 1/rhw (avoid division by zero)
    // NOTE: We must multiply X,Y,Z by w for clip-space (WebGPU does perspective division: clip/w -> NDC)
    // This preserves perspective-correct interpolation for textures/colors.
    // Z is passed through, NOT clamped. D3D CLIPS a pre-transformed primitive against the
    // viewport's z range; it does not pin each vertex into [0,1]. Clamping keeps a polygon
    // that lies beyond the far plane and pastes it flat at z=1, and it deforms one that
    // straddles the plane — the far vertices move while the near ones do not — so the face
    // pokes through whatever should occlude it along a straight polygon edge. Letting the
    // value through hands the primitive to WebGPU's depth clipping, which is D3D's behaviour.
    let w = select(1.0, 1.0 / rhw, rhw != 0.0);
    // Half-pixel convention shift: legacy D3D (DX7-DX9) puts pixel centers at INTEGER
    // screen coordinates; WebGPU puts them at half-integers. +0.5 maps D3D pixel
    // centers onto WebGPU pixel centers so rasterization coverage and interpolated
    // UVs reproduce D3D exactly. The same shift for TRANSFORMED geometry is folded into
    // the MVP by webgpu/pixel-center.ts — read it for why the two are the same delta.
    // Games that pre-offset quads by -0.5 per MS's
    // "Directly Mapping Texels to Pixels" (e.g. FMV tile quads) otherwise
    // shift by one pixel: boundary pixels flip to the next tile and sample u=0,
    // where WRAP+LINEAR blends in the tile's opposite edge (visible tile seams).
    // Relative to the viewport ORIGIN, not the render target's. A pre-transformed vertex
    // carries render-target screen coordinates, and D3D maps them into the viewport's NDC by
    // subtracting the origin before dividing by the extent — the rasterizer's viewport then
    // maps that NDC back onto the same pixel, so the vertex lands where the app put it and the
    // viewport acts purely as a clip rect. Dropping the origin offsets every 2D draw by it,
    // which stays invisible only while the viewport covers the whole target.
    // (DXVK d3d9_fixed_function_vert.vert: pos * inverseExtent + inverseOffset, with
    //  inverseOffset = -origin * inverseExtent + (-1, 1).)
    let posX_ndc = ((posX - params.viewportX + ${D3D_PIXEL_CENTER_OFFSET_PX}) / params.viewportWidth) * 2.0 - 1.0;
    let posY_ndc = 1.0 - ((posY - params.viewportY + ${D3D_PIXEL_CENTER_OFFSET_PX}) / params.viewportHeight) * 2.0;
    // Convert NDC to clip-space by multiplying by w (for perspective-correct interpolation)
    let posX_clip = posX_ndc * w;
    let posY_clip = posY_ndc * w;
    let posZ_clip = posZ * w;
    let posW_clip = w;
    `
            : hasXYZW
              ? `
    // XYZW: already clip-space, pass through
    let posX_ndc = posX;
    let posY_ndc = posY;
    let posZ_clip = posZ;
    let posW_clip = posW;
    `
              : `
    // XYZ/XYZB*: world/view space, MVP in VS
    let posX_ndc = posX;
    let posY_ndc = posY;
    let posZ_clip = posZ;
    let posW_clip = posW;
    `;

    return `
// Vertex converter compute shader
// Converts D3D7 FVF format to unified 64-byte format
// XYZRHW vertices are converted from screen space to NDC

// srcByteBase / dstIndexBase let one bind group cover a whole frame's conversions: the
// buffers are bound in full and each draw addresses its own sub-range through the params
// instead of through a per-draw binding.
struct Params {
    vertexCount: u32,
    srcStride: u32,
    viewportWidth: f32,
    viewportHeight: f32,
    viewportX: f32,
    viewportY: f32,
    srcByteBase: u32,
    dstIndexBase: u32,
}

struct StorageBuf {
    data: array<u32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: StorageBuf;
@group(0) @binding(2) var<storage, read_write> dst: StorageBuf;

// Read float from byte offset
fn readFloat(byteOffset: u32) -> f32 {
    let wordOffset = (params.srcByteBase + byteOffset) >> 2u;
    return bitcast<f32>(src.data[wordOffset]);
}

// Read u32 from byte offset
fn readU32(byteOffset: u32) -> u32 {
    let wordOffset = (params.srcByteBase + byteOffset) >> 2u;
    return src.data[wordOffset];
}

// Write float to destination
fn writeFloat(dstIndex: u32, value: f32) {
    dst.data[dstIndex] = bitcast<u32>(value);
}

// Write u32 to destination
fn writeU32(dstIndex: u32, value: u32) {
    dst.data[dstIndex] = value;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) global_id: vec3u) {
    let vertexIndex = global_id.x;
    if (vertexIndex >= params.vertexCount) {
        return;
    }

    // Calculate source and destination offsets
    let srcBaseOffset = vertexIndex * params.srcStride;
    let dstBaseIndex = params.dstIndexBase + vertexIndex * 16u; // 64 bytes = 16 u32s

    // ===== POSITION (bytes 0-15) =====
    let posX = readFloat(srcBaseOffset + ${posOffset}u);
    let posY = readFloat(srcBaseOffset + ${posOffset + 4}u);
    let posZ = readFloat(srcBaseOffset + ${posOffset + 8}u);
    ${
        hasXYZRHW
            ? `let rhw = readFloat(srcBaseOffset + ${posOffset + 12}u);`
            : hasXYZW
              ? `let posW = readFloat(srcBaseOffset + ${posOffset + 12}u);`
              : "let posW = 1.0;"
    }
    ${posConversion}
    ${hasXYZRHW 
        ? `writeFloat(dstBaseIndex + 0u, posX_clip);
    writeFloat(dstBaseIndex + 1u, posY_clip);
    writeFloat(dstBaseIndex + 2u, posZ_clip);
    writeFloat(dstBaseIndex + 3u, posW_clip);`
        : `writeFloat(dstBaseIndex + 0u, posX_ndc);
    writeFloat(dstBaseIndex + 1u, posY_ndc);
    writeFloat(dstBaseIndex + 2u, posZ_clip);
    writeFloat(dstBaseIndex + 3u, posW_clip);`
    }

    // ===== NORMAL (bytes 16-27) =====
    ${
        hasNormal
            ? `writeFloat(dstBaseIndex + 4u, readFloat(srcBaseOffset + ${normalOffset}u));
    writeFloat(dstBaseIndex + 5u, readFloat(srcBaseOffset + ${normalOffset + 4}u));
    writeFloat(dstBaseIndex + 6u, readFloat(srcBaseOffset + ${normalOffset + 8}u));`
            : `writeFloat(dstBaseIndex + 4u, 0.0);
    writeFloat(dstBaseIndex + 5u, 0.0);
    writeFloat(dstBaseIndex + 6u, 1.0);`
    }

    // ===== DIFFUSE COLOR (bytes 28-31) =====
    ${
        hasDiffuse
            ? `
    // Read ARGB color as u32 (0xAARRGGBB)
    // In little-endian memory, this is [BB, GG, RR, AA]
    // WebGPU unorm8x4 will read it as (B, G, R, A)
    let diffuseColor = readU32(srcBaseOffset + ${diffuseOffset}u);
    writeU32(dstBaseIndex + 7u, diffuseColor);
    `
            : `
    // Default to white opaque (0xFFFFFFFF)
    writeU32(dstBaseIndex + 7u, 0xFFFFFFFFu);
    `
    }

    // ===== SPECULAR COLOR (bytes 32-35) =====
    ${hasSpecular
        ? `writeU32(dstBaseIndex + 8u, readU32(srcBaseOffset + ${specularOffset}u));`
        : `writeU32(dstBaseIndex + 8u, 0xFF000000u);`}  // alpha=0xFF=no fog, RGB=0

    // ===== TEXTURE COORDINATES UV0 (bytes 36-43) =====
    ${
        texCount > 0
            ? `
    let texU = readFloat(srcBaseOffset + ${tex0Offset}u);
    let texV = ${tex0Dims >= 2
        ? `readFloat(srcBaseOffset + ${tex0Offset + 4}u)`
        : `0.0`};
    writeFloat(dstBaseIndex + 9u, texU);
    writeFloat(dstBaseIndex + 10u, texV);
    `
            : `
    let texU = 0.0;
    let texV = 0.0;
    writeFloat(dstBaseIndex + 9u, 0.0);
    writeFloat(dstBaseIndex + 10u, 0.0);
    `
    }

    // ===== TEXTURE COORDINATES UV1 (bytes 44-51) =====
    ${
        texCount >= 2
            ? `
    let tex1U = readFloat(srcBaseOffset + ${tex1Offset}u);
    let tex1V = ${tex1Dims >= 2
        ? `readFloat(srcBaseOffset + ${tex1Offset + 4}u)`
        : `0.0`};
    writeFloat(dstBaseIndex + 11u, tex1U);
    writeFloat(dstBaseIndex + 12u, tex1V);
    `
            : `
    // No second UV set - copy UV0 (stage 1 falls back to stage 0 coords)
    writeFloat(dstBaseIndex + 11u, texU);
    writeFloat(dstBaseIndex + 12u, texV);
    `
    }

    // ===== TEXTURE COORDINATES UV2 (bytes 52-59) =====
    ${
        texCount >= 3
            ? `
    let tex2U = readFloat(srcBaseOffset + ${tex2Offset}u);
    let tex2V = ${tex2Dims >= 2
        ? `readFloat(srcBaseOffset + ${tex2Offset + 4}u)`
        : `0.0`};
    writeFloat(dstBaseIndex + 13u, tex2U);
    writeFloat(dstBaseIndex + 14u, tex2V);
    `
            : texCount >= 2
              ? `
    // No third UV set - copy UV1.
    writeFloat(dstBaseIndex + 13u, tex1U);
    writeFloat(dstBaseIndex + 14u, tex1V);
    `
              : `
    // No third UV set - copy UV0.
    writeFloat(dstBaseIndex + 13u, texU);
    writeFloat(dstBaseIndex + 14u, texV);
    `
    }

    // ===== PADDING (bytes 60-63) =====
    writeU32(dstBaseIndex + 15u, 0u);
}
`;
}

/** Kill switch: setWorkerFlag('__noVertexScratchPool', true) restores the per-draw
 *  allocation path for a live A/B. */
function scratchPoolEnabled(): boolean {
    return (globalThis as { __noVertexScratchPool?: boolean }).__noVertexScratchPool !== true;
}

/**
 * GPU Vertex Converter
 * Converts D3D7 FVF vertex data to unified 64-byte format using compute shaders.
 *
 * THE ORDERING INVARIANT. `queue.writeBuffer` is scheduled on the queue timeline at the
 * moment it is called, while the dispatch that reads what it wrote is only recorded into
 * an encoder and submitted much later. So a scratch range written for draw N and rewritten
 * for draw N+1 before the frame's single submit hands BOTH dispatches draw N+1's bytes.
 * The invariant is therefore: a range referenced by a RECORDED-but-unsubmitted command is
 * never rewritten. Per-draw buffers satisfied it by never reusing anything; the pool
 * satisfies it by bump-allocating a disjoint sub-range per draw and rewinding to zero only
 * in startFrame(), which every caller reaches after queue.submit() — the same point at
 * which globalVertexBuffer already rewinds.
 */
export class VertexConverter {
    private static readonly MIN_GLOBAL_VERTEX_BUFFER_SIZE = 256 * 1024;
    private static readonly MIN_SCRATCH_SRC_SIZE = 256 * 1024;
    /** Params struct size — must match the WGSL `Params` layout above. */
    private static readonly PARAMS_BYTES = 32;
    private static readonly PARAMS_RING_SLOTS = 512;

    private device: GPUDevice;
    private queue: GPUQueue;

    // Pipeline cache by format config key
    private pipelineCache = new Map<string, GPUComputePipeline>();

    // Bind group layout (shared across all pipelines)
    private bindGroupLayout: GPUBindGroupLayout;

    // Global vertex buffer for frame (ring buffer pattern)
    // Per-call temp src/dst buffers; compute writes to tempDst, we copy to globalVertexBuffer at current offset
    private globalVertexBuffer: GPUBuffer | null = null;
    private globalVertexBufferSize = 0;
    private globalOffset = 0; // Current write offset in global buffer (reset each frame)
    private readonly maxGlobalVertexBufferSize: number;

    // Readback buffer for GPU->CPU copy (legacy path only)
    private readbackBuffer: GPUBuffer | null = null;
    private readbackBufferSize = 0;

    // Pending temporary buffers to destroy after frame (params buffers)
    private pendingDestroyBuffers: GPUBuffer[] = [];

    // Frame-scoped scratch pool (see the ordering invariant on the class).
    // Source staging arena: guest vertex bytes for every conversion of the frame, one
    // disjoint sub-range each; bound in full, addressed via Params.srcByteBase.
    private scratchSrcBuffer: GPUBuffer | null = null;
    private scratchSrcSize = 0;
    private scratchSrcOffset = 0;
    private readonly maxScratchSrcSize: number;

    // Params ring: one dynamic-offset uniform slot per conversion, staged CPU-side and
    // uploaded once per submit by flushParams().
    private paramsRingBuffer: GPUBuffer | null = null;
    private paramsRingSize = 0;
    private paramsRingOffset = 0;
    private paramsDirtyOffset = 0;
    private paramsStaging: Uint8Array | null = null;
    private paramsStagingView: DataView | null = null;
    private readonly paramsAlignment: number;

    // One bind group serves the whole frame: all three bindings cover a full buffer (params
    // via a dynamic offset), so it only changes when one of those buffers is replaced.
    private scratchBindGroup: GPUBindGroup | null = null;

    /** Counters for the pooled path. `conversions` is what makes `gpuObjects` readable:
     *  zero objects created is a claim about the pool only if conversions actually ran. */
    private stats = {
        conversions: 0,
        pooled: 0,
        perDraw: 0,
        gpuObjects: 0,
        srcGrows: 0,
        paramsGrows: 0,
        unflushedParams: 0,
    };

    // CPU fallback scratch buffers
    private cpuScratchF32: Float32Array | null = null;
    private cpuScratchU8: Uint8Array | null = null;

    // Cached memory views for CPU conversion fast path
    private cachedMemBuffer: ArrayBuffer | SharedArrayBuffer | null = null;
    private cachedMemByteOffset = 0;
    private cachedMemF32: Float32Array | null = null;
    private cachedMemU32: Uint32Array | null = null;
    private readonly isLittleEndian: boolean;

    // Cached format configs (fvf -> config)
    private formatCache = new Map<number, VertexFormatConfig>();

    constructor(device: GPUDevice, queue: GPUQueue) {
        this.device = device;
        this.queue = queue;
        this.isLittleEndian = VertexConverter.detectLittleEndian();
        const reportedMaxBufferSize = Number(device.limits.maxBufferSize || 0);
        // The global vertex buffer is also the compute dst, bound in full — so its ceiling is
        // the storage-binding limit as well as maxBufferSize.
        const maxStorageBinding = Number(device.limits.maxStorageBufferBindingSize || 0);
        const bufferCeiling = Math.min(
            reportedMaxBufferSize > 0 ? reportedMaxBufferSize : 256 * 1024 * 1024,
            maxStorageBinding > 0 ? maxStorageBinding : 256 * 1024 * 1024
        );
        this.maxGlobalVertexBufferSize = Math.max(
            VertexConverter.MIN_GLOBAL_VERTEX_BUFFER_SIZE,
            bufferCeiling
        );
        this.maxScratchSrcSize = Math.max(VertexConverter.MIN_SCRATCH_SRC_SIZE, bufferCeiling);
        this.paramsAlignment = Math.max(
            VertexConverter.PARAMS_BYTES,
            Number(device.limits.minUniformBufferOffsetAlignment) || 256
        );

        // Create bind group layout
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    // Dynamic offset so one bind group covers every conversion of the frame.
                    // The per-draw path binds its own 32-byte buffer at dynamic offset 0.
                    buffer: {
                        type: "uniform",
                        hasDynamicOffset: true,
                        minBindingSize: VertexConverter.PARAMS_BYTES,
                    },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
            ],
        });

        this.startFrame();
    }

    private static detectLittleEndian(): boolean {
        const buf = new ArrayBuffer(4);
        new Uint32Array(buf)[0] = 0x11223344;
        return new Uint8Array(buf)[0] === 0x44;
    }

    private updateMemoryViews(memory: Uint8Array): void {
        if (this.cachedMemBuffer === memory.buffer && this.cachedMemByteOffset === memory.byteOffset) {
            return;
        }
        this.cachedMemBuffer = memory.buffer;
        this.cachedMemByteOffset = memory.byteOffset;
        // Whole-buffer word views: the byte LENGTH must be word-aligned too. Guest RAM always
        // is, but a synthesized view (d3d8 interleaved decl scratch) need not be — and a throw
        // here would take the whole draw down the catch path. Fall back to the DataView reader.
        if ((memory.byteOffset & 3) === 0 && (memory.buffer.byteLength & 3) === 0) {
            this.cachedMemF32 = new Float32Array(memory.buffer);
            this.cachedMemU32 = new Uint32Array(memory.buffer);
        } else {
            this.cachedMemF32 = null;
            this.cachedMemU32 = null;
        }
    }

    /**
     * Start new frame - reset global offset for vertex buffer
     * Call this at the beginning of each frame before any convertToGpuBuffer calls
     */
    startFrame(): void {
        this.globalOffset = 0;
        // Rewinding the scratch arenas is legal here and ONLY here: every caller reaches
        // startFrame() after queue.submit(), so nothing recorded still references them.
        if (this.paramsRingOffset !== this.paramsDirtyOffset) {
            // Params were staged for a dispatch that has already been submitted without ever
            // being uploaded — those draws read stale bytes. A submit path is missing its
            // flushParams() call; say so instead of silently rewinding over the evidence.
            this.stats.unflushedParams++;
            Logger.error(
                LogCategory.SYSTEM,
                `VertexConverter: ${this.paramsRingOffset - this.paramsDirtyOffset} bytes of params ` +
                    `were never flushed before submit (missing flushParams() on a submit path)`
            );
        }
        this.scratchSrcOffset = 0;
        this.paramsRingOffset = 0;
        this.paramsDirtyOffset = 0;
    }

    /**
     * Upload the params staged since the last flush. MUST run before every queue.submit()
     * that carries conversions — writeBuffer is ordered on the queue timeline, so a write
     * issued after the submit lands too late for the dispatch that reads it.
     */
    flushParams(): void {
        if (!this.paramsRingBuffer || !this.paramsStaging) return;
        if (this.paramsRingOffset <= this.paramsDirtyOffset) return;
        this.queue.writeBuffer(
            this.paramsRingBuffer,
            this.paramsDirtyOffset,
            this.paramsStaging.buffer,
            this.paramsDirtyOffset,
            this.paramsRingOffset - this.paramsDirtyOffset
        );
        this.paramsDirtyOffset = this.paramsRingOffset;
    }

    /**
     * Pool counters. `conversions` is the denominator that makes the rest legible: a frame
     * with gpuObjects=0 says nothing unless conversions>0, and perDraw>0 with the pool on
     * means the pool ran out of room and fell back rather than that it was disabled.
     */
    getScratchStats(): { enabled: boolean } & typeof this.stats {
        return { enabled: scratchPoolEnabled(), ...this.stats };
    }

    /** Bump-allocate `size` bytes of source staging. Returns -1 when the arena cannot hold it. */
    private allocScratchSrc(size: number): number {
        const aligned = (size + 15) & ~15;
        if (this.scratchSrcBuffer && this.scratchSrcOffset + aligned <= this.scratchSrcSize) {
            const offset = this.scratchSrcOffset;
            this.scratchSrcOffset = offset + aligned;
            return offset;
        }
        if (aligned > this.maxScratchSrcSize) return -1;

        // Grow: the old arena is still referenced by recorded commands, so it is destroyed
        // after submit, not now. The replacement starts empty — nothing points into it yet.
        const newSize = Math.min(
            this.maxScratchSrcSize,
            Math.max(aligned, this.scratchSrcSize * 2, VertexConverter.MIN_SCRATCH_SRC_SIZE)
        );
        if (newSize < aligned) return -1;
        if (this.scratchSrcBuffer) this.pendingDestroyBuffers.push(this.scratchSrcBuffer);
        this.scratchSrcBuffer = this.device.createBuffer({
            size: newSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        this.stats.gpuObjects++;
        this.stats.srcGrows++;
        this.scratchSrcSize = newSize;
        this.scratchSrcOffset = aligned;
        this.scratchBindGroup = null;
        return 0;
    }

    /** Bump-allocate one params slot. Returns -1 when the ring cannot hold it. */
    private allocParamsSlot(): number {
        if (this.paramsRingBuffer && this.paramsRingOffset + this.paramsAlignment <= this.paramsRingSize) {
            const offset = this.paramsRingOffset;
            this.paramsRingOffset = offset + this.paramsAlignment;
            return offset;
        }

        // Grow. Staged-but-unwritten bytes still belong to the OLD buffer (that is what the
        // recorded dispatches are bound to), so they must be uploaded before the swap.
        this.flushParams();
        const newSize = Math.max(
            this.paramsRingSize * 2,
            this.paramsAlignment * VertexConverter.PARAMS_RING_SLOTS
        );
        if (this.paramsRingBuffer) {
            this.pendingDestroyBuffers.push(this.paramsRingBuffer);
            this.stats.paramsGrows++;
        }
        this.paramsRingBuffer = this.device.createBuffer({
            size: newSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.stats.gpuObjects++;
        this.paramsRingSize = newSize;
        this.paramsStaging = new Uint8Array(newSize);
        this.paramsStagingView = new DataView(this.paramsStaging.buffer);
        this.paramsRingOffset = this.paramsAlignment;
        this.paramsDirtyOffset = 0;
        this.scratchBindGroup = null;
        return 0;
    }

    /** The frame-wide bind group: params ring (dynamic), source arena, global vertex buffer. */
    private getScratchBindGroup(): GPUBindGroup {
        if (this.scratchBindGroup) return this.scratchBindGroup;
        this.scratchBindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.paramsRingBuffer!, size: VertexConverter.PARAMS_BYTES },
                },
                { binding: 1, resource: { buffer: this.scratchSrcBuffer! } },
                { binding: 2, resource: { buffer: this.globalVertexBuffer! } },
            ],
        });
        this.stats.gpuObjects++;
        return this.scratchBindGroup;
    }

    /**
     * Returns true when the next GPU conversion should submit pending commands first.
     * This prevents global vertex buffer growth beyond device limits in high-draw scenes.
     */
    needsSubmitForBytes(requiredBytes: number): boolean {
        if (requiredBytes <= 0) return false;
        const alignedRequired = Math.ceil(requiredBytes / OUTPUT_VERTEX_BYTES) * OUTPUT_VERTEX_BYTES;
        return this.globalOffset + alignedRequired > this.maxGlobalVertexBufferSize;
    }

    /**
     * Current global vertex buffer usage and hard device limit.
     */
    getGlobalUsage(): { used: number; limit: number } {
        return {
            used: this.globalOffset,
            limit: this.maxGlobalVertexBufferSize,
        };
    }

    /**
     * Destroy pending temporary buffers after queue.submit()
     * Call this after queue.submit() to safely destroy buffers that are no longer in use
     */
    destroyPendingAfterSubmit(): void {
        for (const buffer of this.pendingDestroyBuffers) {
            buffer.destroy();
        }
        this.pendingDestroyBuffers = [];
    }

    /**
     * Parse FVF to format configuration.
     * Position type is determined via D3DFVF_POSITION_MASK; unsupported posType throws.
     * @throws Error if FVF has unsupported position type (e.g. unknown mask value)
     */
    private parseFormat(fvf: number): VertexFormatConfig {
        const cached = this.formatCache.get(fvf);
        if (cached) return cached;

        const posType = fvf & D3DFVF_POSITION_MASK;

        let hasXYZRHW = false;
        let hasXYZ = false;
        let hasXYZW = false;
        let blendWeights = 0;
        let posBytes = 0;

        switch (posType) {
            case D3DFVF_XYZ:
                hasXYZ = true;
                posBytes = 12;
                break;
            case D3DFVF_XYZRHW:
                hasXYZRHW = true;
                posBytes = 16;
                break;
            case D3DFVF_XYZW:
                hasXYZW = true;
                posBytes = 16;
                break;
            case D3DFVF_XYZB1:
                hasXYZ = true;
                blendWeights = 1;
                posBytes = 16;
                break;
            case D3DFVF_XYZB2:
                hasXYZ = true;
                blendWeights = 2;
                posBytes = 20;
                break;
            case D3DFVF_XYZB3:
                hasXYZ = true;
                blendWeights = 3;
                posBytes = 24;
                break;
            case D3DFVF_XYZB4:
                hasXYZ = true;
                blendWeights = 4;
                posBytes = 28;
                break;
            case D3DFVF_XYZB5:
                hasXYZ = true;
                blendWeights = 5;
                posBytes = 32;
                break;
            default:
                throw new Error(
                    `VertexConverter: Unsupported POSITION_MASK posType=0x${posType.toString(16)} fvf=0x${fvf.toString(16)}`
                );
        }

        const hasNormal = (fvf & D3DFVF_NORMAL) !== 0;
        const hasPSize = (fvf & D3DFVF_PSIZE) !== 0;
        const hasDiffuse = (fvf & D3DFVF_DIFFUSE) !== 0;
        const hasSpecular = (fvf & D3DFVF_SPECULAR) !== 0;
        const texCount = (fvf & 0xf00) >> 8;

        let srcStride = posBytes;
        if (hasNormal) srcStride += 12;
        if (hasPSize) srcStride += 4;
        if (hasDiffuse) srcStride += 4;
        if (hasSpecular) srcStride += 4;
        const texCoordDims: number[] = [];
        const texCoordOffsets: number[] = [];
        for (let stage = 0; stage < texCount; stage++) {
            texCoordOffsets.push(srcStride);
            const dims = getFvfTexCoordComponentCount(fvf, stage);
            texCoordDims.push(dims);
            srcStride += dims * 4;
        }

        // TEXCOORDSIZE flags (bits 16–31): we only support float2 per stage
        // TEXCOORDSIZE bits affect stride; converter reads UV.xy from the first two stages.
        const hasNonDefaultTexDims = texCoordDims.some((dims) => dims !== 2);
        if (hasNonDefaultTexDims && !warnedFVFs.has(fvf | 0x20000)) {
            warnedFVFs.add(fvf | 0x20000);
            Logger.warn(
                LogCategory.DDRAW,
                `VertexConverter: FVF 0x${fvf.toString(16)} has TEXCOORDSIZE dims [` +
                    `${texCoordDims.join(", ")}]. Using the first two components of TEX0/TEX1 ` +
                    `and preserving full stride for skipped components.`
            );
        }

        if (texCount > 3 && !warnedFVFs.has(fvf | 0x30000)) {
            warnedFVFs.add(fvf | 0x30000);
            Logger.warn(
                LogCategory.DDRAW,
                `VertexConverter: FVF 0x${fvf.toString(16)} has ${texCount} texture coordinate sets. ` +
                    `Only the first three sets (TEX0+TEX1+TEX2) are converted; later sets still contribute to stride.`
            );
        }

        // XYZW / XYZB*: if not fully supported, results may explode (e.g. "tunnel"). Warn once.
        if ((hasXYZW || blendWeights > 0) && !warnedFVFs.has(fvf | 0xdead0000)) {
            warnedFVFs.add(fvf | 0xdead0000);
            Logger.warn(
                LogCategory.DDRAW,
                `VertexConverter: FVF 0x${fvf.toString(16)} uses ${hasXYZW ? "XYZW" : `XYZB${blendWeights}`} position. ` +
                    `Stride=${srcStride}. If not fully supported, results may explode.`
            );
        }

        const config: VertexFormatConfig = {
            fvf,
            hasXYZRHW,
            hasXYZ: hasXYZ && !hasXYZRHW,
            hasXYZW,
            hasNormal,
            hasPSize,
            hasDiffuse,
            hasSpecular,
            texCount,
            texCoordDims,
            texCoordOffsets,
            srcStride,
            posBytes,
            blendWeights,
        };

        const strideFromShared = computeFvfStride(fvf);
        if (srcStride !== strideFromShared) {
            Logger.error(
                LogCategory.DDRAW,
                `VertexConverter FVF mismatch: parseFormat stride=${srcStride} computeFvfStride=${strideFromShared} fvf=0x${fvf.toString(16)}`
            );
        }
        this.formatCache.set(fvf, config);
        return config;
    }

    private resolveSourceStride(config: VertexFormatConfig, fvf: number, sourceStride?: number): number {
        if (sourceStride === undefined || sourceStride === null || sourceStride <= 0) {
            return config.srcStride;
        }
        if (sourceStride < config.srcStride) {
            Logger.warn(
                LogCategory.DDRAW,
                `VertexConverter: ignoring short stride override=${sourceStride} for FVF 0x${fvf.toString(16)} packed=${config.srcStride}`
            );
            return config.srcStride;
        }
        return sourceStride;
    }

    /**
     * Get format config key for caching
     */
    private getFormatKey(config: VertexFormatConfig): string {
        return `fvf:${config.fvf.toString(16)}`;
    }

    /**
     * Get or create compute pipeline for format
     */
    private getOrCreatePipeline(config: VertexFormatConfig): GPUComputePipeline {
        const key = this.getFormatKey(config);

        let pipeline = this.pipelineCache.get(key);
        if (pipeline) return pipeline;

        const shaderCode = generateVertexConverterShader(config);
        const shaderModule = this.device.createShaderModule({ code: shaderCode });

        pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.bindGroupLayout],
            }),
            compute: {
                module: shaderModule,
                entryPoint: "main",
            },
        });

        this.pipelineCache.set(key, pipeline);
        Logger.log(LogCategory.SYSTEM, `VertexConverter: Created pipeline for format ${key}`);
        return pipeline;
    }

    /**
     * Ensure global vertex buffer is large enough
     * This is the ring buffer where we accumulate all converted vertices for the frame
     */
    private ensureGlobalVertexBuffer(size: number): void {
        if (this.globalVertexBuffer && this.globalVertexBufferSize >= size) return;

        if (size > this.maxGlobalVertexBufferSize) {
            throw new Error(
                `VertexConverter: Requested global vertex buffer size ${size} exceeds device limit ${this.maxGlobalVertexBufferSize}`
            );
        }

        if (this.globalVertexBuffer) {
            // Defer destruction: existing draw commands in the current encoder still reference
            // this buffer via copyBufferToBuffer/setVertexBuffer. Immediate destroy() causes
            // "buffer used in submit while destroyed". Destroy after queue.submit() instead.
            this.pendingDestroyBuffers.push(this.globalVertexBuffer);
        }

        const requestedSize = Math.max(
            size,
            this.globalVertexBufferSize * 2,
            VertexConverter.MIN_GLOBAL_VERTEX_BUFFER_SIZE
        );
        this.globalVertexBufferSize = Math.min(requestedSize, this.maxGlobalVertexBufferSize);
        // STORAGE: the pooled path has the compute shader write its output here directly,
        // at Params.dstIndexBase, instead of into a per-draw buffer that is then copied in.
        this.globalVertexBuffer = this.device.createBuffer({
            size: this.globalVertexBufferSize,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE |
                GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this.stats.gpuObjects++;
        this.scratchBindGroup = null;
    }

    /**
     * Validate memory bounds before conversion
     */
    private validateBounds(memory: Uint8Array, srcAddr: number, srcSize: number): boolean {
        if (srcAddr < 0) {
            Logger.error(
                LogCategory.SYSTEM,
                `VertexConverter: Invalid srcAddr=${srcAddr} (negative)`
            );
            return false;
        }
        if (srcAddr + srcSize > memory.length) {
            Logger.error(
                LogCategory.SYSTEM,
                `VertexConverter: Invalid memory range: srcAddr=${srcAddr} size=${srcSize} ` +
                    `exceeds memory.length=${memory.length}`
            );
            return false;
        }
        return true;
    }

    /**
     * One-off diagnostic log per FVF: fvf, posType, srcStride, hasXYZRHW/XYZ, texCount, first 1–2 verts (pos, diffuse, uv).
     * Use when debugging "tunnel" / exploded geometry (wrong stride/offset).
     */
    private logDiagnosticOnce(
        memory: Uint8Array,
        srcAddr: number,
        vertexCount: number,
        fvf: number,
        config: VertexFormatConfig
    ): void {
        if (diagnosticLoggedFVFs.has(fvf)) return;
        diagnosticLoggedFVFs.add(fvf);

        const posType = fvf & D3DFVF_POSITION_MASK;
        const posKind = config.hasXYZRHW ? "hasXYZRHW" : config.hasXYZ ? "hasXYZ" : config.hasXYZW ? "hasXYZW" : "?";
        let diffuseOffset = config.posBytes;
        if (config.hasNormal) diffuseOffset += 12;
        if (config.hasPSize) diffuseOffset += 4;
        const tex0Offset = config.texCoordOffsets[0] ?? -1;
        const tex1Offset = config.texCoordOffsets[1] ?? -1;
        const tex2Offset = config.texCoordOffsets[2] ?? -1;
        const tex0Dims = config.texCoordDims[0] ?? 0;
        const tex1Dims = config.texCoordDims[1] ?? 0;
        const tex2Dims = config.texCoordDims[2] ?? 0;
        const line0 =
            `VertexConverter diag: fvf=0x${fvf.toString(16)} posType=0x${posType.toString(16)} ` +
            `srcStride=${config.srcStride} diffuseOffset=${diffuseOffset} ` +
            `texDims=[${config.texCoordDims.join(", ")}] texOffsets=[${config.texCoordOffsets.join(", ")}] ` +
            `${posKind} texCount=${config.texCount}`;
        Logger.verbose(LogCategory.DDRAW, line0);

        const view = new DataView(memory.buffer, memory.byteOffset + srcAddr, config.srcStride * Math.min(2, vertexCount));

        for (let i = 0; i < Math.min(2, vertexCount); i++) {
            const base = i * config.srcStride;
            const px = view.getFloat32(base + 0, true);
            const py = view.getFloat32(base + 4, true);
            const pz = view.getFloat32(base + 8, true);
            const diffuse = config.hasDiffuse ? view.getUint32(base + diffuseOffset, true) : 0;
            const uv0u = tex0Dims >= 1 ? view.getFloat32(base + tex0Offset, true) : 0;
            const uv0v = tex0Dims >= 2 ? view.getFloat32(base + tex0Offset + 4, true) : 0;
            const uv1u = tex1Dims >= 1 ? view.getFloat32(base + tex1Offset, true) : uv0u;
            const uv1v = tex1Dims >= 2 ? view.getFloat32(base + tex1Offset + 4, true) : uv0v;
            const uv2u = tex2Dims >= 1 ? view.getFloat32(base + tex2Offset, true) : uv1u;
            const uv2v = tex2Dims >= 2 ? view.getFloat32(base + tex2Offset + 4, true) : uv1v;
            Logger.verbose(
                LogCategory.DDRAW,
                `  v${i}: pos=(${px.toFixed(3)},${py.toFixed(3)},${pz.toFixed(3)}) ` +
                `diffuse=0x${diffuse.toString(16)} uv0=(${uv0u.toFixed(3)},${uv0v.toFixed(3)}) ` +
                `uv1=(${uv1u.toFixed(3)},${uv1v.toFixed(3)}) ` +
                `uv2=(${uv2u.toFixed(3)},${uv2v.toFixed(3)})`
            );
        }
    }

    /**
     * Convert vertices using GPU compute shader.
     * Returns GPUBuffer directly (no readback) for maximum performance.
     * 
     * Creates temporary params buffer per call to avoid race conditions.
     * Result is copied to global vertex buffer at current offset (ring buffer pattern).
     * 
     * @param encoder - Command encoder (must be same encoder used for render pass)
     * @param memory - Guest memory array
     * @param srcAddr - Source address in guest memory
     * @param vertexCount - Number of vertices to convert
     * @param fvf - Flexible Vertex Format flags
     * @param viewportWidth - Viewport width for XYZRHW conversion (optional)
     * @param viewportHeight - Viewport height for XYZRHW conversion (optional)
     * @returns Result with buffer, offset, size, stride, count - or null on error
     */
    convertToGpuBuffer(
        encoder: GPUCommandEncoder,
        memory: Uint8Array,
        srcAddr: number,
        vertexCount: number,
        fvf: number,
        viewportWidth?: number,
        viewportHeight?: number,
        sourceStride?: number,
        viewportX?: number,
        viewportY?: number
    ): GpuVertexConversionResult | null {
        profiler.start("VertexConverter.convertToGpuBuffer");

        try {
            const config = this.parseFormat(fvf);
            const srcStride = this.resolveSourceStride(config, fvf, sourceStride);
            const srcSize = vertexCount * srcStride;
            const dstSize = vertexCount * OUTPUT_VERTEX_BYTES;

            // Validate bounds
            if (!this.validateBounds(memory, srcAddr, srcSize)) {
                profiler.end("VertexConverter.convertToGpuBuffer");
                return null;
            }

            this.logDiagnosticOnce(memory, srcAddr, vertexCount, fvf, config);

            // Keep offsets aligned to vertex stride so firstVertex stays integer in batched draws.
            const alignedDstSize = Math.ceil(dstSize / OUTPUT_VERTEX_BYTES) * OUTPUT_VERTEX_BYTES;
            this.ensureGlobalVertexBuffer(this.globalOffset + alignedDstSize);

            const pipeline = this.getOrCreatePipeline(config);
            const vpW = viewportWidth && viewportWidth > 0 ? viewportWidth : 640;
            const vpH = viewportHeight && viewportHeight > 0 ? viewportHeight : 480;
            const vpX = viewportX ?? 0;
            const vpY = viewportY ?? 0;

            // Pooled path: sub-ranges of frame-scoped arenas, one bind group for the frame,
            // and the compute shader writes straight into the global vertex buffer.
            const srcBase = scratchPoolEnabled() ? this.allocScratchSrc(srcSize) : -1;
            const paramsOffset = srcBase >= 0 ? this.allocParamsSlot() : -1;

            if (paramsOffset >= 0) {
                this.queue.writeBuffer(
                    this.scratchSrcBuffer!,
                    srcBase,
                    memory.buffer,
                    memory.byteOffset + srcAddr,
                    srcSize
                );

                const pv = this.paramsStagingView!;
                pv.setUint32(paramsOffset + 0, vertexCount, true);
                pv.setUint32(paramsOffset + 4, srcStride, true);
                pv.setFloat32(paramsOffset + 8, vpW, true);
                pv.setFloat32(paramsOffset + 12, vpH, true);
                pv.setFloat32(paramsOffset + 16, vpX, true);
                pv.setFloat32(paramsOffset + 20, vpY, true);
                pv.setUint32(paramsOffset + 24, srcBase, true);
                pv.setUint32(paramsOffset + 28, this.globalOffset / 4, true);

                const pass = encoder.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.getScratchBindGroup(), [paramsOffset]);
                pass.dispatchWorkgroups(Math.ceil(vertexCount / WORKGROUP_SIZE));
                pass.end();
                this.stats.pooled++;
            } else {
                // Per-draw path: a fresh buffer per binding satisfies the ordering invariant by
                // never reusing anything. Reached via the kill switch, or when an arena is at
                // its device ceiling.
                const tempSrc = this.device.createBuffer({
                    size: srcSize,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
                });
                const tempDst = this.device.createBuffer({
                    size: dstSize,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
                });
                this.stats.gpuObjects += 2;

                this.queue.writeBuffer(
                    tempSrc,
                    0,
                    memory.buffer,
                    memory.byteOffset + srcAddr,
                    srcSize
                );

                const tempParamsBuffer = this.device.createBuffer({
                    size: VertexConverter.PARAMS_BYTES,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    mappedAtCreation: true,
                });
                this.stats.gpuObjects++;
                const paramsView = new DataView(tempParamsBuffer.getMappedRange());
                paramsView.setUint32(0, vertexCount, true);
                paramsView.setUint32(4, srcStride, true);
                paramsView.setFloat32(8, vpW, true);
                paramsView.setFloat32(12, vpH, true);
                paramsView.setFloat32(16, vpX, true);
                paramsView.setFloat32(20, vpY, true);
                // Bases are zero: each binding starts at the range this draw owns.
                paramsView.setUint32(24, 0, true);
                paramsView.setUint32(28, 0, true);
                tempParamsBuffer.unmap();

                const bindGroup = this.device.createBindGroup({
                    layout: this.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: tempParamsBuffer, size: VertexConverter.PARAMS_BYTES } },
                        { binding: 1, resource: { buffer: tempSrc, size: srcSize } },
                        { binding: 2, resource: { buffer: tempDst, size: dstSize } },
                    ],
                });
                this.stats.gpuObjects++;

                const pass = encoder.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup, [0]);
                pass.dispatchWorkgroups(Math.ceil(vertexCount / WORKGROUP_SIZE));
                pass.end();

                encoder.copyBufferToBuffer(
                    tempDst,
                    0,
                    this.globalVertexBuffer!,
                    this.globalOffset,
                    dstSize
                );

                // Lifecycle invariant: push only after commands are recorded.
                this.pendingDestroyBuffers.push(tempParamsBuffer, tempSrc, tempDst);
                this.stats.perDraw++;
            }
            this.stats.conversions++;

            const result: GpuVertexConversionResult = {
                buffer: this.globalVertexBuffer!,
                size: dstSize,
                stride: OUTPUT_VERTEX_BYTES,
                count: vertexCount,
                offset: this.globalOffset, // Return offset for use in setVertexBuffer
            };

            // Update frame snapshot counters
            const system = (globalThis as any).System?.getInstance?.();
            const ddraw = system?.process?.getModule("ddraw") as any;
            if (ddraw?.incrementFrameCounter) {
                ddraw.incrementFrameCounter("vertexBytes", dstSize);
            }

            // Advance global offset (aligned to vertex stride)
            this.globalOffset += alignedDstSize;

            profiler.end("VertexConverter.convertToGpuBuffer");
            return result;
        } catch (error) {
            Logger.error(
                LogCategory.SYSTEM,
                `VertexConverter.convertToGpuBuffer failed: ${error}`
            );
            profiler.end("VertexConverter.convertToGpuBuffer");
            return null;
        }
    }

    /**
     * Convert vertices using GPU compute shader (legacy method with readback).
     * DEPRECATED: Use convertToGpuBuffer() instead for better performance.
     * Kept for compatibility with code that needs CPU-side data.
     */
    async convertGPU(
        memory: Uint8Array,
        srcAddr: number,
        vertexCount: number,
        fvf: number,
        viewportWidth?: number,
        viewportHeight?: number,
        sourceStride?: number,
        viewportX?: number,
        viewportY?: number
    ): Promise<Uint8Array> {
        profiler.start("VertexConverter.convertGPU");

        try {
            const config = this.parseFormat(fvf);
            const srcStride = this.resolveSourceStride(config, fvf, sourceStride);
            const srcSize = vertexCount * srcStride;
            const dstSize = vertexCount * OUTPUT_VERTEX_BYTES;

            // Validate bounds
            if (!this.validateBounds(memory, srcAddr, srcSize)) {
                profiler.end("VertexConverter.convertGPU");
                return new Uint8Array(0);
            }

            // Ensure readback buffer (only for this legacy path)
            if (!this.readbackBuffer || this.readbackBufferSize < dstSize) {
                if (this.readbackBuffer) this.readbackBuffer.destroy();
                this.readbackBufferSize = Math.max(dstSize, this.readbackBufferSize * 2, 64 * 1024);
                this.readbackBuffer = this.device.createBuffer({
                    size: this.readbackBufferSize,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                });
                this.stats.gpuObjects++;
            }

            // Use convertToGpuBuffer for the actual conversion
            const encoder = this.device.createCommandEncoder();
            const result = this.convertToGpuBuffer(encoder, memory, srcAddr, vertexCount, fvf, viewportWidth, viewportHeight, srcStride, viewportX, viewportY);
            
            if (!result) {
                profiler.end("VertexConverter.convertGPU");
                return new Uint8Array(0);
            }

            // Copy from global vertex buffer at result.offset (data written by convertToGpuBuffer)
            encoder.copyBufferToBuffer(result.buffer, result.offset, this.readbackBuffer!, 0, dstSize);
            this.flushParams();
            this.queue.submit([encoder.finish()]);

            // Read back result
            await this.readbackBuffer!.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(this.readbackBuffer!.getMappedRange(0, dstSize));
            const cpuResult = new Uint8Array(dstSize);
            cpuResult.set(mapped);
            this.readbackBuffer!.unmap();

            profiler.end("VertexConverter.convertGPU");
            return cpuResult;
        } catch (error) {
            Logger.error(
                LogCategory.SYSTEM,
                `VertexConverter.convertGPU failed: ${error}`
            );
            profiler.end("VertexConverter.convertGPU");
            return new Uint8Array(0);
        }
    }

    /**
     * Convert vertices using CPU (fallback for small batches).
     * Returns converted data in 64-byte format.
     * XYZRHW vertices are converted from screen space to NDC.
     */
    convertCPU(
        memory: Uint8Array,
        srcAddr: number,
        vertexCount: number,
        fvf: number,
        outBuffer?: Uint8Array,
        viewportWidth?: number,
        viewportHeight?: number,
        sourceStride?: number,
        blend?: VertexBlendInput | null,
        viewportX?: number,
        viewportY?: number
    ): Uint8Array {
        profiler.start("VertexConverter.convertCPU");

        try {
            const config = this.parseFormat(fvf);
            const srcStride = this.resolveSourceStride(config, fvf, sourceStride);
            const srcSize = vertexCount * srcStride;
            const dstSize = vertexCount * OUTPUT_VERTEX_BYTES;

            // Validate bounds
            if (!this.validateBounds(memory, srcAddr, srcSize)) {
                profiler.end("VertexConverter.convertCPU");
                return new Uint8Array(0);
            }

            const result = outBuffer && outBuffer.length >= dstSize ? outBuffer : new Uint8Array(dstSize);

            // Create Float32 view for efficient writes
            const dstF32 = new Float32Array(result.buffer, result.byteOffset, dstSize / 4);
            const dstU32 = new Uint32Array(result.buffer, result.byteOffset, dstSize / 4);

            // Viewport for XYZRHW conversion
            const vpW = viewportWidth && viewportWidth > 0 ? viewportWidth : 640;
            const vpH = viewportHeight && viewportHeight > 0 ? viewportHeight : 480;
            const vpX = viewportX ?? 0;
            const vpY = viewportY ?? 0;
            const scaleX = 2.0 / vpW;
            const scaleY = 2.0 / vpH;

            const baseOffset = memory.byteOffset + srcAddr;

            // Vertex blend (GPU skinning) — INERT unless the caller passes a palette AND the FVF
            // actually carries enough blend weights (XYZBn). Positions/normals are blended on the
            // CPU here because the 64-byte output format has no room for weights. Uses the DataView
            // path only (the typed fast path stays byte-identical for every non-blended draw).
            const blendCount = blend ? (blend.count | 0) : 0;
            const blendIndexed = !!(blend && blend.indexed);
            // Non-indexed: N explicit weights stored (config.blendWeights = N), N+1 matrices, so
            // require blendWeights >= count-1. Indexed: the FVF also stores the UBYTE4 index dword
            // as a beta (config.blendWeights = count), and a single-matrix 0WEIGHTS case (count=1)
            // is legitimate, so require count>=1 and blendWeights >= count.
            const doBlend =
                (blendIndexed ? blendCount >= 1 : blendCount >= 2) &&
                config.blendWeights >= (blendIndexed ? blendCount : blendCount - 1) &&
                !config.hasXYZRHW &&
                !config.hasXYZW;
            const blendPalette = doBlend ? blend!.palette : null;
            // Indexed blend: the packed UBYTE4 matrix-index dword is the LAST beta = the dword
            // just before the non-position data (config.posBytes - 4).
            const ubyte4IndexOffset = config.posBytes - 4;

            const canUseTyped =
                !doBlend && this.isLittleEndian && (baseOffset & 3) === 0 && (srcStride & 3) === 0;

            let diffuseOffset = config.posBytes;
            if (config.hasNormal) diffuseOffset += 12;
            if (config.hasPSize) diffuseOffset += 4;
            const normalOffset = config.posBytes;
            const specularOffset = diffuseOffset + (config.hasDiffuse ? 4 : 0);
            const tex0Offset = config.texCoordOffsets[0] ?? specularOffset + (config.hasSpecular ? 4 : 0);
            const tex1Offset = config.texCoordOffsets[1] ?? tex0Offset;
            const tex2Offset = config.texCoordOffsets[2] ?? tex1Offset;
            const tex0Dims = config.texCoordDims[0] ?? 0;
            const tex1Dims = config.texCoordDims[1] ?? 0;
            const tex2Dims = config.texCoordDims[2] ?? 0;

            if (canUseTyped) {
                this.updateMemoryViews(memory);
                const memF32 = this.cachedMemF32;
                const memU32 = this.cachedMemU32;
                if (memF32 && memU32) {
                    const baseIndex = baseOffset >>> 2;
                    const strideWords = srcStride >>> 2;
                    const diffuseIndex = diffuseOffset >>> 2;
                    const normalIndex = config.hasNormal ? (normalOffset >>> 2) : -1;
                    const specularIndex = specularOffset >>> 2;
                    const tex0Index = tex0Offset >>> 2;
                    const tex1Index = tex1Offset >>> 2;
                    const tex2Index = tex2Offset >>> 2;

                    for (let i = 0; i < vertexCount; i++) {
                        const srcIndex = baseIndex + i * strideWords;
                        const dstBase = i * OUTPUT_VERTEX_U32S;

                        let posX = memF32[srcIndex + 0];
                        let posY = memF32[srcIndex + 1];
                        let posZ = memF32[srcIndex + 2];
                        let posW = 1.0;

                        if (config.hasXYZRHW) {
                            // f32 at every step and in the WGSL's operation order — see the
                            // matching branch below for why bit-equality with the GPU converter
                            // is load-bearing (D3DCMP_EQUAL second passes).
                            const rhw = memF32[srcIndex + 3];
                            const w = rhw !== 0 ? Math.fround(1.0 / rhw) : 1.0;
                            // +0.5: D3D integer pixel centers -> WebGPU half-integer centers (see WGSL above)
                            posX = Math.fround(Math.fround(Math.fround(Math.fround(Math.fround(Math.fround(posX - vpX) + D3D_PIXEL_CENTER_OFFSET_PX) / vpW) * 2.0) - 1.0) * w);
                            posY = Math.fround(Math.fround(1.0 - Math.fround(Math.fround(Math.fround(Math.fround(posY - vpY) + D3D_PIXEL_CENTER_OFFSET_PX) / vpH) * 2.0)) * w);
                            posZ = Math.fround(posZ * w);
                            posW = w;
                        } else if (config.hasXYZW) {
                            posW = memF32[srcIndex + 3];
                        }

                        // Bytes 0-15: Position
                        dstF32[dstBase + 0] = posX;
                        dstF32[dstBase + 1] = posY;
                        dstF32[dstBase + 2] = posZ;
                        dstF32[dstBase + 3] = posW;

                        // Bytes 16-27: Normal
                        if (config.hasNormal && normalIndex >= 0) {
                            dstF32[dstBase + 4] = memF32[srcIndex + normalIndex];
                            dstF32[dstBase + 5] = memF32[srcIndex + normalIndex + 1];
                            dstF32[dstBase + 6] = memF32[srcIndex + normalIndex + 2];
                        } else {
                            dstF32[dstBase + 4] = 0.0;
                            dstF32[dstBase + 5] = 0.0;
                            dstF32[dstBase + 6] = 1.0;
                        }

                        // Byte 28: Diffuse
                        dstU32[dstBase + 7] = config.hasDiffuse ? memU32[srcIndex + diffuseIndex] : 0xffffffff;
                        
                        // Byte 32: Specular
                        dstU32[dstBase + 8] = config.hasSpecular ? memU32[srcIndex + specularIndex] : 0xFF000000;

                        // Bytes 36-43: UV0
                        const tex0U = tex0Dims >= 1 ? memF32[srcIndex + tex0Index] : 0.0;
                        const tex0V = tex0Dims >= 2 ? memF32[srcIndex + tex0Index + 1] : 0.0;
                        dstF32[dstBase + 9] = tex0U;
                        dstF32[dstBase + 10] = tex0V;

                        // Bytes 44-51: UV1
                        const tex1U = tex1Dims >= 1 ? memF32[srcIndex + tex1Index] : tex0U;
                        const tex1V = tex1Dims >= 2 ? memF32[srcIndex + tex1Index + 1] : tex0V;
                        dstF32[dstBase + 11] = tex1U;
                        dstF32[dstBase + 12] = tex1V;

                        // Bytes 52-59: UV2
                        dstF32[dstBase + 13] = tex2Dims >= 1 ? memF32[srcIndex + tex2Index] : tex1U;
                        dstF32[dstBase + 14] = tex2Dims >= 2 ? memF32[srcIndex + tex2Index + 1] : tex1V;
                        
                        // Byte 60: Padding
                        dstU32[dstBase + 15] = 0;
                    }

                    profiler.end("VertexConverter.convertCPU");
                    return result;
                }
            }

            // Use DataView for reliable float/int reading (handles endianness correctly)
            const srcView = new DataView(memory.buffer, baseOffset, srcSize);

            for (let i = 0; i < vertexCount; i++) {
                const srcBase = i * srcStride;
                const dstBase = i * OUTPUT_VERTEX_U32S;

                let posX = srcView.getFloat32(srcBase + 0, true);
                let posY = srcView.getFloat32(srcBase + 4, true);
                let posZ = srcView.getFloat32(srcBase + 8, true);
                let posW = 1.0;
                // Blended (skinned) normal accumulators — written below when doBlend && hasNormal.
                let bnx = 0.0, bny = 0.0, bnz = 0.0;

                if (config.hasXYZRHW) {
                    // Round after EVERY step, exactly as the WGSL above does. JS arithmetic is
                    // f64 and would round only once on the store, so the same vertex converted
                    // here and on the GPU lands on different f32 bits. Depth is then unequal
                    // between a base pass and a coplanar second pass whose vertex counts put
                    // them on opposite sides of GPU_VERTEX_THRESHOLD — and D3DCMP_EQUAL, which
                    // is exactly how a decal/lightmap pass asks "same surface", fails on a
                    // pixel-dependent subset: a dither grid that crawls as the camera moves.
                    const rhw = srcView.getFloat32(srcBase + 12, true);
                    const w = rhw !== 0 ? Math.fround(1.0 / rhw) : 1.0;
                    // +0.5: D3D integer pixel centers -> WebGPU half-integer centers (see WGSL above)
                    // Same operation ORDER as the WGSL too — (x+0.5)/vp then *2 then -1 is not
                    // the same f32 value as (x+0.5)*(2/vp) - 1.
                    posX = Math.fround(Math.fround(Math.fround(Math.fround(Math.fround(Math.fround(posX - vpX) + D3D_PIXEL_CENTER_OFFSET_PX) / vpW) * 2.0) - 1.0) * w);
                    posY = Math.fround(Math.fround(1.0 - Math.fround(Math.fround(Math.fround(Math.fround(posY - vpY) + D3D_PIXEL_CENTER_OFFSET_PX) / vpH) * 2.0)) * w);
                    posZ = Math.fround(posZ * w);
                    posW = w;
                } else if (config.hasXYZW) {
                    posW = srcView.getFloat32(srcBase + 12, true);
                } else if (doBlend) {
                    // pos_blended = Σ wᵢ·(pos·WORLDᵢ), normal_blended = Σ wᵢ·(normal·WORLDᵢ₃ₓ₃).
                    // The last weight completes the partition of unity (1 − Σ others), exactly as
                    // DXVK d3d9_fixed_function_vert.vert does. WORLDᵢ is row-major/row-vector.
                    // Indexed: iteration m selects palette[(packed >> (m*8)) & 0xFF] (UBYTE4 index),
                    // matching DXVK's uint(roundEven(in_BlendIndices[m])) with R8G8B8A8 byte order.
                    const nX = config.hasNormal ? srcView.getFloat32(srcBase + normalOffset, true) : 0.0;
                    const nY = config.hasNormal ? srcView.getFloat32(srcBase + normalOffset + 4, true) : 0.0;
                    const nZ = config.hasNormal ? srcView.getFloat32(srcBase + normalOffset + 8, true) : 0.0;
                    const packedIdx = blendIndexed ? srcView.getUint32(srcBase + ubyte4IndexOffset, true) : 0;
                    let bx = 0.0, by = 0.0, bz = 0.0;
                    let weightRemaining = 1.0;
                    for (let m = 0; m < blendCount; m++) {
                        let w: number;
                        if (m < blendCount - 1) {
                            w = srcView.getFloat32(srcBase + 12 + 4 * m, true);
                            weightRemaining -= w;
                        } else {
                            w = weightRemaining;
                        }
                        const paletteIdx = blendIndexed ? ((packedIdx >>> (m * 8)) & 0xff) : m;
                        const M = blendPalette![paletteIdx] ?? null;
                        if (M) {
                            bx += w * (posX * M[0] + posY * M[4] + posZ * M[8] + M[12]);
                            by += w * (posX * M[1] + posY * M[5] + posZ * M[9] + M[13]);
                            bz += w * (posX * M[2] + posY * M[6] + posZ * M[10] + M[14]);
                            if (config.hasNormal) {
                                bnx += w * (nX * M[0] + nY * M[4] + nZ * M[8]);
                                bny += w * (nX * M[1] + nY * M[5] + nZ * M[9]);
                                bnz += w * (nX * M[2] + nY * M[6] + nZ * M[10]);
                            }
                        } else {
                            // Identity world matrix: pass position/normal through, weighted.
                            bx += w * posX; by += w * posY; bz += w * posZ;
                            if (config.hasNormal) { bnx += w * nX; bny += w * nY; bnz += w * nZ; }
                        }
                    }
                    posX = bx; posY = by; posZ = bz; posW = 1.0;
                }

                // Bytes 0-15: Position
                dstF32[dstBase + 0] = posX;
                dstF32[dstBase + 1] = posY;
                dstF32[dstBase + 2] = posZ;
                dstF32[dstBase + 3] = posW;

                // Bytes 16-27: Normal
                if (doBlend && config.hasNormal) {
                    dstF32[dstBase + 4] = bnx;
                    dstF32[dstBase + 5] = bny;
                    dstF32[dstBase + 6] = bnz;
                } else if (config.hasNormal) {
                    dstF32[dstBase + 4] = srcView.getFloat32(srcBase + normalOffset, true);
                    dstF32[dstBase + 5] = srcView.getFloat32(srcBase + normalOffset + 4, true);
                    dstF32[dstBase + 6] = srcView.getFloat32(srcBase + normalOffset + 8, true);
                } else {
                    dstF32[dstBase + 4] = 0.0;
                    dstF32[dstBase + 5] = 0.0;
                    dstF32[dstBase + 6] = 1.0;
                }

                // Byte 28: Diffuse
                dstU32[dstBase + 7] = config.hasDiffuse ? srcView.getUint32(srcBase + diffuseOffset, true) : 0xffffffff;
                
                // Byte 32: Specular
                dstU32[dstBase + 8] = config.hasSpecular ? srcView.getUint32(srcBase + specularOffset, true) : 0xFF000000;

                // Bytes 36-43: UV0
                let texU = 0.0, texV = 0.0;
                if (tex0Dims >= 1) texU = srcView.getFloat32(srcBase + tex0Offset, true);
                if (tex0Dims >= 2) texV = srcView.getFloat32(srcBase + tex0Offset + 4, true);
                dstF32[dstBase + 9] = texU;
                dstF32[dstBase + 10] = texV;

                // Bytes 44-51: UV1
                const tex1U = tex1Dims >= 1 ? srcView.getFloat32(srcBase + tex1Offset, true) : texU;
                const tex1V = tex1Dims >= 2 ? srcView.getFloat32(srcBase + tex1Offset + 4, true) : texV;
                dstF32[dstBase + 11] = tex1U;
                dstF32[dstBase + 12] = tex1V;

                // Bytes 52-59: UV2
                dstF32[dstBase + 13] = tex2Dims >= 1 ? srcView.getFloat32(srcBase + tex2Offset, true) : tex1U;
                dstF32[dstBase + 14] = tex2Dims >= 2 ? srcView.getFloat32(srcBase + tex2Offset + 4, true) : tex1V;
                
                // Byte 60: Padding
                dstU32[dstBase + 15] = 0;
            }

            profiler.end("VertexConverter.convertCPU");
            
            // Update frame snapshot counters
            const system = (globalThis as any).System?.getInstance?.();
            const ddraw = system?.process?.getModule("ddraw") as any;
            if (ddraw?.incrementFrameCounter) {
                ddraw.incrementFrameCounter("vertexBytes", dstSize);
            }

            return result;
        } catch (error) {
            Logger.error(
                LogCategory.SYSTEM,
                `VertexConverter.convertCPU failed: ${error}`
            );
            profiler.end("VertexConverter.convertCPU");
            return new Uint8Array(0);
        }
    }

    /**
     * Convert vertices using optimal method (GPU for large batches, CPU for small).
     * DEPRECATED: Use convertToGpuBuffer() for GPU path or convertCPU() for CPU path.
     */
    async convert(
        memory: Uint8Array,
        srcAddr: number,
        vertexCount: number,
        fvf: number,
        outBuffer?: Uint8Array,
        viewportWidth?: number, 
        viewportHeight?: number,
        sourceStride?: number,
        viewportX?: number,
        viewportY?: number
    ): Promise<Uint8Array> {
        if (vertexCount < GPU_VERTEX_THRESHOLD) {
            return this.convertCPU(memory, srcAddr, vertexCount, fvf, outBuffer, viewportWidth, viewportHeight, sourceStride, null, viewportX, viewportY);
        }
        return this.convertGPU(memory, srcAddr, vertexCount, fvf, viewportWidth, viewportHeight, sourceStride, viewportX, viewportY);
    }

    /**
     * Synchronous convert using CPU only
     */
    convertSync(
        memory: Uint8Array,
        srcAddr: number,
        vertexCount: number,
        fvf: number,
        outBuffer?: Uint8Array,
        viewportWidth?: number,
        viewportHeight?: number,
        sourceStride?: number,
        blend?: VertexBlendInput | null,
        viewportX?: number,
        viewportY?: number
    ): Uint8Array {
        return this.convertCPU(memory, srcAddr, vertexCount, fvf, outBuffer, viewportWidth, viewportHeight, sourceStride, blend, viewportX, viewportY);
    }

    /**
     * Destroy resources
     */
    destroy(): void {
        if (this.globalVertexBuffer) this.globalVertexBuffer.destroy();
        if (this.readbackBuffer) this.readbackBuffer.destroy();
        if (this.scratchSrcBuffer) this.scratchSrcBuffer.destroy();
        if (this.paramsRingBuffer) this.paramsRingBuffer.destroy();
        this.scratchSrcBuffer = null;
        this.paramsRingBuffer = null;
        this.scratchBindGroup = null;
        for (const buffer of this.pendingDestroyBuffers) {
            buffer.destroy();
        }
        this.pendingDestroyBuffers = [];
        this.pipelineCache.clear();
    }
}
