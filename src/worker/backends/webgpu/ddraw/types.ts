/**
 * Shared types and interfaces for DirectDraw WebGPU backend
 */

import type { StageSamplerState } from "./ffp-stages";

/**
 * Debug flags for active diagnostics (3D blank-screen debugging)
 */
export interface DebugFlags {
    /** Force missing texture to render as magenta for visibility */
    forceMissingTextureMagenta: boolean;
    /** Debug view mode: normal, uv, vertexcolor, alpha, solid */
    debugView: "normal" | "uv" | "vertexcolor" | "alpha" | "solid";
    /** Force disable alpha blending */
    forceDisableAlphaBlend: boolean;
    /** Force disable Z test */
    forceDisableZTest: boolean;
    /** DIAG: keep the depth TEST but let no draw WRITE depth. Splits forceDisableZTest into
     *  its two halves: geometry that reappears under this one is being rejected by depth a
     *  DRAW wrote, while geometry still missing is rejected by the clear value or by its own
     *  z, with no draw to blame. */
    forceDisableZWrite: boolean;
    /** Force wireframe color mode */
    forceWireColor: boolean;
    /** Force Z = 0.5*w in clip space to isolate NDC/minZ/maxZ/projection issues */
    forceZMidpoint: boolean;
    /** Force cullMode "none" to rule out back-face culling killing 3D scene */
    forceCullNone: boolean;
    /** Force disable alpha test (ignore ALPHATESTENABLE) */
    forceDisableAlphaTest: boolean;
    /** Force re-sync all textures from guest memory every draw (diagnose stale GPU data) */
    forceTextureResync: boolean;
    /** Force POINT sampling on all draws without changing UV coordinates */
    forcePointFilter: boolean;
    /** Disable the POINT-filter UV bias without changing sampler state */
    disablePointUvBias: boolean;
    /** Disable the contained-UV WRAP->CLAMP seam suppression (XYZRHW draws with UVs in [0,1]) */
    disableContainedUvClamp: boolean;
    /** Texture converter debug mode: 0=normal, 1=show format (red=32bit, green=16bit, blue=8bit), 2=show read errors */
    textureConverterDebugMode: number;
    /** Disable the MegaBatch path entirely — legacy uniform slot AND no accumulation */
    disableMegaBatch: boolean;
    /** DIAG: keep the MegaBatch shader/storage path but never ACCUMULATE — one draw per
     *  batch. Splits `disableMegaBatch` into its two halves, so a picture that only comes
     *  back under this one blames the grouping, and one that needs the full flag blames
     *  the storage/shader path. */
    disableMegaBatchAccumulate: boolean;
    /** DIAG: skip the guest-memory content hash that detects texel writes a game made
     *  through a cached lpSurface (see prepareStageTexture). Off = hashing on. */
    disableCpuTextureHash: boolean;
    /** DIAG: stop submitting mid-frame when a texture already sampled by recorded draws is
     *  overwritten. On = the copy→draw→copy→draw pattern renders every draw with the LAST
     *  upload. */
    disableTextureOverwriteSubmit: boolean;
    /** DIAG: accumulate batches normally but DROP them at flush (render nothing) */
    skipMegaBatchDrawsRender: boolean;
    /** DIAG: with skipMegaBatchDrawsRender, drop only draws with indexCount >= this (0 = all) */
    skipMegaBatchMinIdx: number;
    /** Force the CPU vertex-conversion path for all draws, bypassing the GPU compute converter */
    forceCpuVertexPath: boolean;
    /** DIAG: render only the first N+1 draws of every frame (-1 = off, render all).
     *  The frame capture numbers draws in the same order, so bisecting this NAMES the draw
     *  that first covers a region — the only way to find which draw wrote the depth (or the
     *  pixels) that hides everything issued after it. */
    drawScrubMax: number;
}

/**
 * Default debug flags (all disabled)
 */
export const DEFAULT_DEBUG_FLAGS: DebugFlags = {
    forceMissingTextureMagenta: false,
    debugView: "normal",
    forceDisableAlphaBlend: false,
    forceDisableZTest: false,
    forceDisableZWrite: false,
    forceWireColor: false,
    forceZMidpoint: false,
    forceCullNone: false,
    forceDisableAlphaTest: false,
    forceTextureResync: false,
    forcePointFilter: false,
    disablePointUvBias: false,
    disableContainedUvClamp: false,
    textureConverterDebugMode: 0,
    disableMegaBatch: false,
    disableMegaBatchAccumulate: false,
    disableCpuTextureHash: false,
    disableTextureOverwriteSubmit: false,
    skipMegaBatchDrawsRender: false,
    skipMegaBatchMinIdx: 0,
    forceCpuVertexPath: false,
    drawScrubMax: -1,
};

/**
 * Ring buffer configuration
 */
export interface RingBufferConfig {
    /** Size of each ring buffer in bytes */
    bufferSize: number;
    /** Number of buffers in the ring (for GPU/CPU overlap) */
    bufferCount: number;
}

/**
 * Default ring buffer configuration
 * 64MB is sufficient now that drawIndexedPrimitive scans the index array to find
 * the actual max vertex referenced, avoiding the 100x+ overallocation that occurred
 * when DrawIndexedPrimitiveVB passed the full VB capacity as vCount.
 */
export const DEFAULT_RING_BUFFER_CONFIG: RingBufferConfig = {
    bufferSize: 128 * 1024 * 1024, // 128MB — prevents overflow/flush stalls in high-draw-count games
    bufferCount: 3, // Triple-buffering for better GPU/CPU overlap
};

/**
 * Uniform buffer configuration
 */
export interface UniformBufferConfig {
    /** Size of a single uniform slot in bytes (WebGPU minUniformBufferOffsetAlignment) */
    slotSize: number;
    /** Total uniform buffer size in bytes */
    bufferSize: number;
}

/**
 * Default uniform buffer configuration.
 * slotSize is the alignment stride for ring-buffer offsets (768 bytes), not the packed struct size.
 * 768 = 512 (base FFP state) + 256 (per-stage texture-transform flags + 3 mat4x4 matrices,
 * see the Uniforms tail in shader-generator.ts / allocateUniformSlot).
 */
export const DEFAULT_UNIFORM_BUFFER_CONFIG: UniformBufferConfig = {
    slotSize: 768,
    bufferSize: 16 * 1024 * 1024, // 16MB — ~21K unique uniform slots per frame at 768-byte stride
};

/**
 * Reusable prepare-draw result (DOD). Mutate in prepareDraw, return same ref.
 * Avoids per-draw heap allocations (GC pressure in 2k–5k draw-call scenes).
 */
export interface PrepareDrawResult {
    uniformOffset: number;
    /** Dynamic offset into the per-draw FFP light-set ring (binding 5). */
    lightsOffset: number;
    /** Index into storage buffer's draw uniform array (for MegaBatch) */
    drawIndex: number;
    pipeline: GPURenderPipeline;
    /** Bit N set = stage N binds + samples a texture (N < MAX_FFP_SAMPLED_STAGES). */
    sampledMask: number;
    /** Cascade depth compiled into the shader (1 + highest enabled stage). */
    stageCount: number;
    /** Per-stage resolved texture views (index = stage; length MAX_FFP_SAMPLED_STAGES).
     *  Stage 0 may fall back to the dummy view downstream; other stages were demoted if
     *  their view could not be resolved. */
    stageViews: (GPUTextureView | null)[];
    /** Per-stage sampler parameters (index = stage; fixed objects, mutated in place). */
    stageSamplers: StageSamplerState[];
    stencilRef: number; // D3DRENDERSTATE_STENCILREF (dynamic, set via setStencilReference)
}

/**
 * Reusable executor diagnostics for the most recently prepared draw.
 * The frame capture copies this only while capture is active.
 */
export interface DrawExecutionDiagnostics {
    valid: boolean;
    useTexture: boolean;
    minFilter: number;
    magFilter: number;
    mipFilter: number;
    addressU: number;
    addressV: number;
    maxAnisotropy: number;
    pointUvBiasApplied: boolean;
    forcePointFilter: boolean;
    disablePointUvBias: boolean;
}

/**
 * Viewport with optional depth range
 * D3D7 defaults: minZ=0, maxZ=1
 */
export interface Viewport {
    x: number;
    y: number;
    width: number;
    height: number;
    minZ?: number; // Default: 0 (D3D7 standard)
    maxZ?: number; // Default: 1 (D3D7 standard)
}

/** WebGPU spec limit for setViewport width/height. */
export const WEBGPU_MAX_VIEWPORT_DIM = 8192;

function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

export type SanitizedViewport = Viewport & { minZ: number; maxZ: number };

/**
 * Clamp a D3D viewport to render-target bounds and WebGPU limits.
 * Rejects garbage dimensions (null pointer reads, unset fields, float bit patterns).
 *
 * Allocating wrapper for cold callers; per-draw paths use sanitizeViewportInto.
 */
export function sanitizeViewport(
    viewport: Viewport,
    targetWidth: number,
    targetHeight: number,
): SanitizedViewport {
    return sanitizeViewportInto({ x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1 }, viewport, targetWidth, targetHeight);
}

/**
 * As sanitizeViewport, but writes into a caller-owned struct so a per-draw call site
 * allocates nothing (CLAUDE.md 3.1 zero-alloc hot paths). Every field of `viewport` is
 * read before any field of `out` is written, so `out` may alias `viewport`.
 */
export function sanitizeViewportInto(
    out: SanitizedViewport,
    viewport: Viewport,
    targetWidth: number,
    targetHeight: number,
): SanitizedViewport {
    const tw = Math.max(1, targetWidth | 0);
    const th = Math.max(1, targetHeight | 0);
    const maxDim = WEBGPU_MAX_VIEWPORT_DIM;

    let width = Math.trunc(finiteOr(viewport.width, tw));
    let height = Math.trunc(finiteOr(viewport.height, th));
    let x = Math.trunc(finiteOr(viewport.x, 0));
    let y = Math.trunc(finiteOr(viewport.y, 0));
    // The rasterizer depth range is [0,1] on every D3D generation — a D3DVIEWPORT's
    // dvMinZ/dvMaxZ scale z INTO that range, they never widen it. WebGPU rejects
    // anything outside [0,1] with minDepth <= maxDepth, and one rejected setViewport
    // invalidates the whole command buffer, so an app (or a struct mis-read) offering
    // e.g. -1..1 would silently drop every draw in the frame.
    const minZ = Math.min(1, Math.max(0, finiteOr(viewport.minZ ?? 0, 0)));
    const maxZ = Math.min(1, Math.max(minZ, finiteOr(viewport.maxZ ?? 1, 1)));

    const implausible =
        width <= 0 ||
        height <= 0 ||
        width > maxDim ||
        height > maxDim ||
        width > tw * 4 ||
        height > th * 4;

    if (implausible) {
        x = 0;
        y = 0;
        width = tw;
        height = th;
    }

    width = Math.max(1, Math.min(width, maxDim, tw));
    height = Math.max(1, Math.min(height, maxDim, th));
    x = Math.max(0, Math.min(x, Math.max(0, tw - 1)));
    y = Math.max(0, Math.min(y, Math.max(0, th - 1)));

    out.x = x;
    out.y = y;
    out.width = width;
    out.height = height;
    out.minZ = minZ;
    out.maxZ = maxZ;
    return out;
}

/**
 * Default viewport depth range (D3D7 standard)
 */
export const DEFAULT_VIEWPORT_DEPTH = {
    minZ: 0,
    maxZ: 1,
} as const;

/**
 * RGBA color components (0.0 - 1.0)
 * Used for ambient, color key, texture factor, fog color, etc.
 */
export interface RGBA {
    r: number;
    g: number;
    b: number;
    a: number;
}

/**
 * Ambient color components (0.0 - 1.0)
 * @deprecated Use RGBA instead for semantic clarity
 */
export type AmbientColor = RGBA;

/**
 * Clear operation configuration
 */
export interface ClearConfig {
    flags: number;
    color: number;
    depth: number;
    /** Stencil clear value (D3DCLEAR_STENCIL). Default 0. */
    stencil?: number;
    /** Color attachment format for partial-clear pipeline selection. Default "rgba8unorm". */
    colorFormat?: GPUTextureFormat;
    viewport?: { x: number; y: number; width: number; height: number };
    rects?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

/**
 * Pipeline key configuration for caching
 */
export interface PipelineKeyConfig {
    vertexType: number;
    primitiveType: number;
    sampledMask: number; // Bit N = stage N samples a texture (affects shader: bindings)
    stageCount: number; // Cascade stage blocks emitted (1 + highest enabled stage)
    pointSampleMask: number; // Bit N = stage N uses legacy POINT texel selection in shader
    missingTexture: boolean; // Affects shader: fallback texture handling
    cullMode: number;
    zEnable: number;
    zFunc: number;
    zWrite: number;
    zBias: number; // D3DRENDERSTATE_ZBIAS (0-16) for z-fighting prevention
    // The draw asked for EQUAL with depth writes off — a coplanar second pass. zFunc is
    // rewritten to LESSEQUAL for it, so the request is not recoverable from the other
    // fields, and it selects a depth bias: it must be part of the key.
    coplanarPass: number;
    alphaBlend: number;
    alphaTest: number;
    srcBlend: number;
    dstBlend: number;
    alphaFunc: number;
    colorKeyEnabled: number; // Affects shader: color key discard block
    // Stencil states (affect pipeline: depthStencil.stencilFront/Back)
    stencilEnable: number;
    stencilFunc: number;
    stencilFail: number;
    stencilZFail: number;
    stencilPass: number;
    stencilRef: number;
    stencilMask: number;
    stencilWriteMask: number;
    // Debug flags affecting pipeline/shader
    forceZMidpoint: boolean; // Affects shader: Z remap block
    forceCullNone: boolean;
    forceDisableZTest: boolean;
    forceDisableZWrite: boolean;
    debugView: "normal" | "uv" | "vertexcolor" | "alpha" | "solid"; // Affects shader: output mode
    flatShading: boolean; // D3DSHADE_FLAT: flat @interpolate on color/specular varyings (affects shader)
    // NOTE: colorOp, alphaOp, lightingEnabled, fogMode, colorOp1, alphaOp1 are NOT in key
    // because they are handled via uniforms in universal shader, not shader code generation
}

/**
 * A zeroed key config for use as reusable scratch. The field order matches the interface
 * so a scratch filled field-by-field keeps the same hidden class as a fresh literal.
 */
export function makeEmptyPipelineKeyConfig(): PipelineKeyConfig {
    return {
        vertexType: 0, primitiveType: 0, sampledMask: 0, stageCount: 0, pointSampleMask: 0,
        missingTexture: false, cullMode: 0, zEnable: 0, zFunc: 0, zWrite: 0, zBias: 0,
        coplanarPass: 0,
        alphaBlend: 0, alphaTest: 0, srcBlend: 0, dstBlend: 0, alphaFunc: 0, colorKeyEnabled: 0,
        stencilEnable: 0, stencilFunc: 0, stencilFail: 0, stencilZFail: 0, stencilPass: 0,
        stencilRef: 0, stencilMask: 0, stencilWriteMask: 0,
        forceZMidpoint: false, forceCullNone: false, forceDisableZTest: false, forceDisableZWrite: false,
        debugView: "normal", flatShading: false,
    };
}

/**
 * Generate pipeline cache key from configuration
 */
export function generatePipelineKey(config: PipelineKeyConfig): string {
    return [
        `vt:${config.vertexType}`,
        `pt:${config.primitiveType}`,
        `sm:${config.sampledMask}`,
        `sc:${config.stageCount}`,
        `psm:${config.pointSampleMask}`,
        `miss:${config.missingTexture ? 1 : 0}`,
        `cull:${config.cullMode}`,
        `z:${config.zEnable}`,
        `zf:${config.zFunc}`,
        `zw:${config.zWrite}`,
        `zb:${config.zBias}`,
        `cop:${config.coplanarPass}`,
        `abl:${config.alphaBlend}`,
        `at:${config.alphaTest}`,
        `sb:${config.srcBlend}`,
        `db:${config.dstBlend}`,
        `af:${config.alphaFunc}`,
        `ck:${config.colorKeyEnabled}`,
        `se:${config.stencilEnable}`,
        `sf:${config.stencilFunc}`,
        `sfail:${config.stencilFail}`,
        `szfail:${config.stencilZFail}`,
        `spass:${config.stencilPass}`,
        `sref:${config.stencilRef}`,
        `smask:${config.stencilMask}`,
        `swmask:${config.stencilWriteMask}`,
        `fzm:${config.forceZMidpoint ? 1 : 0}`,
        `fcn:${config.forceCullNone ? 1 : 0}`,
        `fzt:${config.forceDisableZTest ? 1 : 0}`,
        `fzw:${config.forceDisableZWrite ? 1 : 0}`,
        `dv:${config.debugView}`,
        `flat:${config.flatShading ? 1 : 0}`,
    ].join("|");
}

/**
 * Generate MegaBatch pipeline cache key from configuration.
 * IMPORTANT: Excludes alphaTest and alphaFunc since they are now dynamic uniforms in MegaBatch.
 * This allows batching draws with different alpha test settings.
 */
export function generateMegaBatchPipelineKey(config: PipelineKeyConfig): string {
    return [
        `vt:${config.vertexType}`,
        `pt:${config.primitiveType}`,
        `sm:${config.sampledMask}`,
        `sc:${config.stageCount}`,
        `psm:${config.pointSampleMask}`,
        `miss:${config.missingTexture ? 1 : 0}`,
        `cull:${config.cullMode}`,
        `z:${config.zEnable}`,
        `zf:${config.zFunc}`,
        `zw:${config.zWrite}`,
        `zb:${config.zBias}`,
        `cop:${config.coplanarPass}`,
        `abl:${config.alphaBlend}`,
        // NOTE: alphaTest (at) and alphaFunc (af) are EXCLUDED - they're dynamic uniforms now
        `sb:${config.srcBlend}`,
        `db:${config.dstBlend}`,
        `ck:${config.colorKeyEnabled}`,
        `se:${config.stencilEnable}`,
        `sf:${config.stencilFunc}`,
        `sfail:${config.stencilFail}`,
        `szfail:${config.stencilZFail}`,
        `spass:${config.stencilPass}`,
        `sref:${config.stencilRef}`,
        `smask:${config.stencilMask}`,
        `swmask:${config.stencilWriteMask}`,
        `fzm:${config.forceZMidpoint ? 1 : 0}`,
        `fcn:${config.forceCullNone ? 1 : 0}`,
        `fzt:${config.forceDisableZTest ? 1 : 0}`,
        `fzw:${config.forceDisableZWrite ? 1 : 0}`,
        `dv:${config.debugView}`,
        `flat:${config.flatShading ? 1 : 0}`,
    ].join("|");
}

/**
 * Compare two PipelineKeyConfig objects field-by-field.
 * Used for last-config fast path to avoid string allocation on repeated calls.
 */
export function pipelineKeyConfigsEqual(a: PipelineKeyConfig, b: PipelineKeyConfig): boolean {
    return a.vertexType === b.vertexType &&
        a.primitiveType === b.primitiveType &&
        a.sampledMask === b.sampledMask &&
        a.stageCount === b.stageCount &&
        a.pointSampleMask === b.pointSampleMask &&
        a.missingTexture === b.missingTexture &&
        a.cullMode === b.cullMode &&
        a.zEnable === b.zEnable &&
        a.zFunc === b.zFunc &&
        a.zWrite === b.zWrite &&
        a.zBias === b.zBias &&
        a.coplanarPass === b.coplanarPass &&
        a.alphaBlend === b.alphaBlend &&
        a.alphaTest === b.alphaTest &&
        a.srcBlend === b.srcBlend &&
        a.dstBlend === b.dstBlend &&
        a.alphaFunc === b.alphaFunc &&
        a.colorKeyEnabled === b.colorKeyEnabled &&
        a.stencilEnable === b.stencilEnable &&
        a.stencilFunc === b.stencilFunc &&
        a.stencilFail === b.stencilFail &&
        a.stencilZFail === b.stencilZFail &&
        a.stencilPass === b.stencilPass &&
        a.stencilRef === b.stencilRef &&
        a.stencilMask === b.stencilMask &&
        a.stencilWriteMask === b.stencilWriteMask &&
        a.forceZMidpoint === b.forceZMidpoint &&
        a.forceCullNone === b.forceCullNone &&
        a.forceDisableZTest === b.forceDisableZTest &&
        a.forceDisableZWrite === b.forceDisableZWrite &&
        a.debugView === b.debugView &&
        a.flatShading === b.flatShading;
}

/**
 * Compare two PipelineKeyConfig objects for MegaBatch (excludes alphaTest/alphaFunc).
 */
export function megaBatchPipelineKeyConfigsEqual(a: PipelineKeyConfig, b: PipelineKeyConfig): boolean {
    return a.vertexType === b.vertexType &&
        a.primitiveType === b.primitiveType &&
        a.sampledMask === b.sampledMask &&
        a.stageCount === b.stageCount &&
        a.pointSampleMask === b.pointSampleMask &&
        a.missingTexture === b.missingTexture &&
        a.cullMode === b.cullMode &&
        a.zEnable === b.zEnable &&
        a.zFunc === b.zFunc &&
        a.zWrite === b.zWrite &&
        a.zBias === b.zBias &&
        a.coplanarPass === b.coplanarPass &&
        a.alphaBlend === b.alphaBlend &&
        a.srcBlend === b.srcBlend &&
        a.dstBlend === b.dstBlend &&
        a.colorKeyEnabled === b.colorKeyEnabled &&
        a.stencilEnable === b.stencilEnable &&
        a.stencilFunc === b.stencilFunc &&
        a.stencilFail === b.stencilFail &&
        a.stencilZFail === b.stencilZFail &&
        a.stencilPass === b.stencilPass &&
        a.stencilRef === b.stencilRef &&
        a.stencilMask === b.stencilMask &&
        a.stencilWriteMask === b.stencilWriteMask &&
        a.forceZMidpoint === b.forceZMidpoint &&
        a.forceCullNone === b.forceCullNone &&
        a.forceDisableZTest === b.forceDisableZTest &&
        a.forceDisableZWrite === b.forceDisableZWrite &&
        a.debugView === b.debugView &&
        a.flatShading === b.flatShading;
}

/**
 * Uniform slot data layout
 * Total data: 224 bytes, but slot size is 256 bytes (aligned for WebGPU).
 * All slot offsets must use slotSize (256), never use 224 for offset calculations.
 *
 * Offsets:
 * 0..8   viewport: vec2f
 * 8..12  minZ: f32
 * 12..16 maxZ: f32
 * 16..20 alphaRef255: u32 (D3DRENDERSTATE_ALPHAREF as 0..255, not normalized)
 * 20..24 colorOp: u32
 * 24..28 alphaOp: u32
 * 28..32 isRHW: u32
 * 32..36 lightingEnabled: u32
 * 36..40 colorKeyEnabled: u32
 * 40..44 specularEnable: u32 (D3DRENDERSTATE_SPECULARENABLE)
 * 48..64 colorKey: vec4f (16 bytes, RGBA format)
 * 64..80 ambientColor: vec4f (16 bytes)
 * 80..96 textureFactor: vec4f (16 bytes, D3DRENDERSTATE_TEXTUREFACTOR)
 * 96..160 mvp: mat4x4<f32> (64 bytes)
 * 160..176 fogColor: vec4f (RGBA)
 * 176..192 fogParams: vec4f (x=start, y=end, z=density, w=mode: 0=none, 1=exp, 2=exp2, 3=linear)
 * 192..208 stage1Params: vec4f (x=colorOp1, y=alphaOp1, z=minFilter1, w=magFilter1)
 * 208..212 colorArg1: u32 (D3DTSS_COLORARG1: D3DTA_TEXTURE, D3DTA_DIFFUSE, D3DTA_TFACTOR, etc.)
 * 212..216 colorArg2: u32 (D3DTSS_COLORARG2: D3DTA_TEXTURE, D3DTA_DIFFUSE, D3DTA_TFACTOR, etc.)
 * 216..220 alphaArg1: u32 (D3DTSS_ALPHAARG1: D3DTA_TEXTURE, D3DTA_DIFFUSE, D3DTA_TFACTOR, etc.)
 * 220..224 alphaArg2: u32 (D3DTSS_ALPHAARG2: D3DTA_TEXTURE, D3DTA_DIFFUSE, D3DTA_TFACTOR, etc.)
 * 224..228 colorArg1_1: u32 (Stage1 D3DTSS_COLORARG1)
 * 228..232 colorArg2_1: u32 (Stage1 D3DTSS_COLORARG2)
 * 232..236 alphaArg1_1: u32 (Stage1 D3DTSS_ALPHAARG1)
 * 236..240 alphaArg2_1: u32 (Stage1 D3DTSS_ALPHAARG2)
 * 240..244 premultiplyOutput: u32 (1 if blend state requires premultiplied alpha: ONE/INVSRCALPHA)
 * Total: 244 bytes (aligned to 256 for uniform buffer alignment)
 */
export interface UniformSlotData {
    // Viewport and depth (0..16 bytes)
    viewportWidth: number;
    viewportHeight: number;
    minZ: number;
    maxZ: number;
    
    // Render states as u32 (16..48 bytes)
    alphaRef255: number; // u32: D3DRENDERSTATE_ALPHAREF (0..255), stored as u32 in uniform buffer
    colorOp: number; // u32
    alphaOp: number; // u32
    isRHW: number; // u32
    lightingEnabled: number; // u32
    colorKeyEnabled: number; // u32
    
    // Colors as vec4f (48..96 bytes)
    colorKey: RGBA | null; // vec4f: Color key color in RGBA format
    ambientColor: RGBA; // vec4f: Ambient lighting color
    textureFactor: RGBA; // vec4f: D3DRENDERSTATE_TEXTUREFACTOR
    
    // Transform matrix (96..160 bytes)
    mvpMatrix: Float32Array | null; // mat4x4<f32>: MVP transformation matrix
    
    // Fog parameters (160..192 bytes)
    fogColor: RGBA; // vec4f: Fog color RGBA
    fogParams: { // vec4f: Fog parameters
        start: number; // x: fog start
        end: number; // y: fog end
        density: number; // z: fog density
        mode: number; // w: fog mode (0=none, 1=exp, 2=exp2, 3=linear)
    };
    
    // Stage 1 multi-texture parameters (192..208 bytes)
    stage1Params: { // vec4f: Stage 1 parameters
        colorOp1: number; // x: Stage 1 color operation
        alphaOp1: number; // y: Stage 1 alpha operation
        minFilter1: number; // z: Stage 1 min filter
        magFilter1: number; // w: Stage 1 mag filter
    };

    // Material properties (256..336 bytes)
    material: {
        diffuse: RGBA;    // vec4f
        ambient: RGBA;    // vec4f
        specular: RGBA;   // vec4f
        emissive: RGBA;   // vec4f
        power: number;    // f32
    };

    // Transformation matrices (336..400 bytes)
    worldMatrix: Float32Array | null; // mat4x4<f32>
}

/**
 * Ring buffer slot with buffer reference and current offset
 */
export interface RingBufferSlot {
    buffer: GPUBuffer;
    offset: number;
    size: number;
}

/**
 * Allocation result from ring buffer
 */
export interface AllocationResult {
    buffer: GPUBuffer;
    offset: number;
    overflow?: boolean;
}

// ===== MegaBatch Architecture Types =====

/**
 * Storage buffer configuration for per-draw uniforms (MegaBatch).
 * Each draw gets a slotSize-byte slot in a storage buffer array.
 */
export interface StorageBufferConfig {
    /** Size of a single draw uniform slot in bytes */
    slotSize: number;
    /** Total storage buffer size in bytes */
    bufferSize: number;
}

/** Default storage buffer configuration for per-draw uniforms. */
export const DEFAULT_STORAGE_BUFFER_CONFIG: StorageBufferConfig = {
    slotSize: 512,
    bufferSize: 8 * 1024 * 1024, // 8MB — ~16K draw slots per frame
};

/**
 * Per-draw uniforms stored in storage buffer.
 * Total: 256 bytes (padded for WebGPU alignment).
 *
 * Layout (offsets in bytes):
 *   0..64   mvp: mat4x4<f32>
 *  64..80   textureFactor: vec4f
 *  80..96   colorKey: vec4f
 *  96..112  ambientColor: vec4f
 * 112..128  fogColor: vec4f
 * 128..144  fogParams: vec4f (start, end, density, mode)
 * 144..160  stage1Params: vec4f (colorOp1, alphaOp1, minFilter1, magFilter1)
 * 160..176  viewport: vec4f (width, height, minZ, maxZ)
 * 176..192  colorOps: vec4u (colorOp, alphaOp, colorOp1, alphaOp1)
 * 192..208  colorArgs: vec4u (colorArg1, colorArg2, alphaArg1, alphaArg2)
 * 208..224  colorArgs1: vec4u (stage1 args)
 * 224..240  misc: vec4u (alphaRef255, isRHW, lightingEnabled, colorKeyEnabled)
 * 240..256  misc2: vec4u (premultiplyOutput, alphaTestEnabled, alphaFunc, specularEnable)
 * 256..320  world: mat4x4<f32>
 * 320..336  matDiffuse: vec4f
 * 336..352  matAmbient: vec4f
 * 352..368  matSpecular: vec4f
 * 368..384  matEmissive: vec4f
 * 384..400  matParams: vec4f (x=power, y=diffuseSrc, z=ambientSrc, w=specularSrc)
 * 400..416  matParams2: vec4f (x=emissiveSrc, y=hasDirLight, z..w reserved)
 * 416..432  lightColor: vec4f
 * 432..448  lightDir: vec4f (xyz=dir, w=0)
 * 448..464  stage2Params: vec4f (colorOp2, alphaOp2, minFilter2, magFilter2)
 * 464..480  texCoordIndices: vec4u (stage0, stage1, stage2, reserved)
 * 480..496  colorArgs2: vec4u (stage2 args)
 * 496..512  trailing padding so WGSL natural array stride matches slotSize=512
 */
export interface DrawUniforms {
    /** MVP transformation matrix (64 bytes) */
    mvp: Float32Array;
    /** D3DRENDERSTATE_TEXTUREFACTOR RGBA */
    textureFactor: RGBA;
    /** Color key color in RGBA format */
    colorKey: RGBA;
    /** Ambient lighting color */
    ambientColor: RGBA;
    /** Fog color RGBA */
    fogColor: RGBA;
    /** Fog parameters: start, end, density, mode (0=none, 0.5=vertex, 1=exp, 2=exp2, 3=linear) */
    fogParams: { start: number; end: number; density: number; mode: number };
    /** Stage 1 parameters: colorOp1, alphaOp1, minFilter1, magFilter1 */
    stage1Params: { colorOp1: number; alphaOp1: number; minFilter1: number; magFilter1: number };
    /** Stage 2 parameters: colorOp2, alphaOp2, minFilter2, magFilter2 */
    stage2Params: { colorOp2: number; alphaOp2: number; minFilter2: number; magFilter2: number };
    /** Texture coordinate source indices for stages 0..2 */
    texCoordIndices: { stage0: number; stage1: number; stage2: number };
    /** Viewport: width, height, minZ, maxZ */
    viewport: { width: number; height: number; minZ: number; maxZ: number };
    /** Color operations: colorOp, alphaOp */
    colorOp: number;
    alphaOp: number;
    /** Alpha reference (0-255) */
    alphaRef255: number;
    /** Is RHW vertex format (pre-transformed) */
    isRHW: number;
    /** Lighting enabled flag */
    lightingEnabled: number;
    /** Color key enabled flag */
    colorKeyEnabled: number;
    /** Specular add enabled flag */
    specularEnable: number;
    /** Color arguments for stage 0 */
    colorArg1: number;
    colorArg2: number;
    alphaArg1: number;
    alphaArg2: number;
    /** Color arguments for stage 1 */
    colorArg1_1: number;
    colorArg2_1: number;
    alphaArg1_1: number;
    alphaArg2_1: number;
    /** Color arguments for stage 2 */
    colorArg1_2: number;
    colorArg2_2: number;
    alphaArg1_2: number;
    alphaArg2_2: number;
    /** Premultiply output flag */
    premultiplyOutput: number;
    /** Alpha test enabled flag (dynamic uniform for MegaBatch) */
    alphaTestEnabled: number;
    /** Alpha function for alpha test (D3DCMP_*, dynamic uniform for MegaBatch) */
    alphaFunc: number;

    /** World transformation matrix (64 bytes) */
    world: Float32Array;
    /** Material diffuse color */
    matDiffuse: RGBA;
    /** Material ambient color */
    matAmbient: RGBA;
    /** Material specular color */
    matSpecular: RGBA;
    /** Material emissive color */
    matEmissive: RGBA;
    /** Material parameters: power, diffuseSrc, ambientSrc, specularSrc */
    matPower: number;
    matDiffuseSrc: number;
    matAmbientSrc: number;
    matSpecularSrc: number;
    /** Material parameters 2: emissiveSrc */
    matEmissiveSrc: number;
}

/**
 * Global uniforms shared by all draws in a MegaBatch.
 * These are constant across all draws and stored in a small uniform buffer.
 */
export interface GlobalUniforms {
    /** Reserved for future use */
    _reserved: number;
}

/**
 * Individual draw command within a MegaBatch.
 * Stores the vertex/index range and the index into the storage buffer.
 */
export interface MegaBatchDraw {
    /** First vertex offset (in vertex count, not bytes) */
    firstVertex: number;
    /** Number of vertices to draw */
    vertexCount: number;
    /** Index into the storage buffer's draw uniform array */
    drawIndex: number;
    /** First index offset (for indexed draws) */
    firstIndex?: number;
    /** Number of indices to draw (for indexed draws) */
    indexCount?: number;
}

/**
 * MegaBatch accumulates multiple compatible draws into a single batch.
 * uniformOffset is not part of the batch compatibility check — per-draw data
 * (MVP, states) lives in a storage buffer indexed by instance_index.
 */
export interface MegaBatch {
    // Pipeline state (all draws must share these)
    pipeline: GPURenderPipeline;
    target: DirectDrawSurfaceState;

    // Textures (all draws share)
    textureView: GPUTextureView | null;
    textureView1: GPUTextureView | null;
    textureView2: GPUTextureView | null;
    samplerKey: number;
    sampler1Key: number;
    sampler2Key: number;
    textureVersion: number;
    texture1Version: number;
    texture2Version: number;

    // Vertex data (accumulated in ring buffer)
    vertexBuffer: GPUBuffer;
    vertexOffset: number;
    vertexCount: number;
    vertexSize: number; // OUTPUT_VERTEX_BYTES bytes per vertex

    // Index data (for indexed draws)
    indexBuffer?: GPUBuffer;
    indexFormat?: GPUIndexFormat;
    indexOffset?: number;
    indexCount?: number;

    // Primitive type
    primitiveType: number;

    // Per-draw uniforms (storage buffer)
    storageBuffer: GPUBuffer;
    firstDrawIndex: number;
    drawCount: number;

    // Bind group for this batch
    bindGroup: GPUBindGroup;

    // Draw commands
    draws: MegaBatchDraw[];
}

/**
 * Allocation result for draw uniforms in storage buffer.
 */
export interface DrawUniformsAllocation {
    /** GPU buffer containing the storage data */
    buffer: GPUBuffer;
    /** Index into the draws array (not byte offset) */
    index: number;
}

// Import for MegaBatch interface (circular dependency prevention)
import type { DirectDrawSurfaceState } from "../../../modules/ddraw/com-objects";

