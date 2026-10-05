import { Legacy3DCommandStream } from "../legacy3d/command-stream";
import { LegacyPrimitiveTopology } from "../legacy3d/types";

export interface GlideGpuTexture {
    handle: number;
    texture: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
    format: number;
    /** Levels actually uploaded — 1 unless the guest downloaded a chain. */
    mipLevelCount: number;
}

export interface GlidePipelineConfig {
    topology: LegacyPrimitiveTopology;
    useTexture: boolean;
    blendEnabled: boolean;
    // Packed GR_BLEND_* factors (packBlend) — only meaningful when blendEnabled.
    blend: number;
    depthTestEnabled: boolean;
    depthWriteEnabled: boolean;
    depthFunction: number;
    cullMode: number;
    // GPU color write mask bits (Red|Green|Blue|Alpha) from grColorMask.
    colorWriteMask: number;
}

export interface GlideFrameInput {
    stream: Legacy3DCommandStream;
    width: number;
    height: number;
    clearColor: number;
    clearDepth: number;
    alphaRef: number;
    constantColor: number;
    chromaKeyEnabled: boolean;
    chromaKey: number;
    // 64-entry Glide fog blend table (0..255 per entry); sampled by the shader.
    fogTable: Uint8Array;
    /** grGammaCorrectionValue — TMU pow(rgb, gamma) before the combine unit. */
    gammaCorrection: number;
    lfbPixels?: Uint8Array;
    lfbPitch?: number;
    /** Monotonic id of the LFB image; equal means the executor's staged copy is current. */
    lfbVersion?: number;
    /** The LFB write happened AFTER every draw: composite it over the frame, not under it. */
    lfbAfterDraws?: boolean;
    videoOverlayCanvas?: OffscreenCanvas | null;
    gdiOverlayCanvas?: OffscreenCanvas | null;
    /**
     * GDI overlay composite plan (getOverlayCompositePlan): undefined = whole overlay
     * ('full', windowed); [] = composite nothing ('none', game owns screen, no live dialog);
     * [rects] = only those live modal dialog rects. Same encoding as the D3D9 executor.
     */
    gdiOverlayRects?: Array<{ x: number; y: number; w: number; h: number }>;
}

export interface GlideExecutorMetrics {
    frames: number;
    draws: number;
    pipelineSets: number;
    textureUploads: number;
    bindGroupHits: number;
    bindGroupMisses: number;
    /** Draws folded into a neighbour because state and vertex range were contiguous. */
    mergedDraws: number;
    /** Distinct per-draw uniform slices written this frame (one writeBuffer covers all). */
    uniformSlices: number;
}
