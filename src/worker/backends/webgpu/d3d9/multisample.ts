/**
 * D3D9 MSAA render-target resources for the WebGPU backend.
 *
 * D3D9 exposes a multisampled render target as one surface, while WebGPU
 * represents it as a multisample attachment plus a single-sample resolve
 * target.  This module owns that pair and the matching depth attachment.  It
 * intentionally does not change D3D9 capability queries: a caller must opt in
 * only after its adapter probe has established that the requested count works.
 */

import { bumpCapabilityGeneration } from '../shared/capability-generation';

export const D3D9_MSAA_SAMPLE_COUNTS = [2, 4] as const;
export type D3D9MsaaSampleCount = (typeof D3D9_MSAA_SAMPLE_COUNTS)[number];

export type D3D9MsaaTargetKey = string | number;

export interface D3D9MultisampleTargetDescriptor {
    /** Stable identity of the D3D9 render target/backbuffer. */
    key: D3D9MsaaTargetKey;
    width: number;
    height: number;
    colorFormat: GPUTextureFormat;
    depthFormat: GPUTextureFormat;
    sampleCount: number;
    /** Optional view formats for the color texture (for example an sRGB view). */
    colorViewFormats?: GPUTextureFormat[];
    /** Existing single-sample texture to receive the resolve (for a D3D9 RT). */
    resolveTexture?: GPUTexture;
    /** Existing resolve view; defaults to `resolveTexture.createView()`. */
    resolveView?: GPUTextureView;
    /** Optional externally-owned multisample depth attachment (standalone D3D9 surface). */
    depthTexture?: GPUTexture;
    /** Existing view for `depthTexture`; defaults to `depthTexture.createView()`. */
    depthView?: GPUTextureView;
}

export interface D3D9MultisampleTarget {
    readonly key: D3D9MsaaTargetKey;
    readonly width: number;
    readonly height: number;
    readonly colorFormat: GPUTextureFormat;
    readonly depthFormat: GPUTextureFormat;
    readonly sampleCount: D3D9MsaaSampleCount;
    /** Multisampled color attachment used as the render pass `view`. */
    readonly colorTexture: GPUTexture;
    readonly colorView: GPUTextureView;
    /** Single-sample color target used as the render pass `resolveTarget`. */
    readonly resolveTexture: GPUTexture;
    readonly resolveView: GPUTextureView;
    /** False when the resolve texture belongs to a D3D9 TextureStore. */
    readonly ownsResolveTexture: boolean;
    /** Multisampled depth/stencil attachment matching `sampleCount`. */
    readonly depthTexture: GPUTexture;
    readonly depthView: GPUTextureView;
    /** False when the depth attachment belongs to a standalone D3D9 surface. */
    readonly ownsDepthTexture: boolean;
}

export interface D3D9MsaaAdapterProbe {
    /**
     * Return true only after the adapter has accepted the requested sample count.
     * Keeping this as an injected probe is deliberate: WebGPU does not expose a
     * portable `maxSampleCount` field, and a failed pipeline/attachment probe
     * must refuse rather than create a descriptor that will poison the frame.
     */
    supportsSampleCount(sampleCount: D3D9MsaaSampleCount): boolean;
}

/** Explicit runtime capability contract used by D3D9 module entry points. */
export type D3D9MsaaCapabilityContract = D3D9MsaaAdapterProbe;

let activeMsaaCapabilityContract: D3D9MsaaCapabilityContract | null = null;

/** Read the probe published by the current live WebGPU device. */
export function getD3D9MsaaCapabilityContract(): D3D9MsaaCapabilityContract | null {
    return activeMsaaCapabilityContract;
}

/** Publish or clear the result of the current device's real sample-count probe. */
export function setD3D9MsaaCapabilityContract(
    contract: D3D9MsaaCapabilityContract | null,
): void {
    activeMsaaCapabilityContract = contract && typeof contract.supportsSampleCount === "function"
        ? contract
        : null;
    bumpCapabilityGeneration();
}

export function d3d9MsaaSampleCount(multiSampleType: number): D3D9MsaaSampleCount | null {
    const type = multiSampleType >>> 0;
    return type === 2 || type === 4 ? type : null;
}

export interface D3D9StretchRectMsaaPolicy {
    supported: boolean;
    sourceSampleCount: number;
    destinationSampleCount: number;
    requiresResolve: boolean;
    reason: string | null;
}

/**
 * D3D9 permits resolving a multisampled render target into an ordinary target,
 * but the WebGPU textured-quad copier cannot attach a multisample destination.
 * Keep this decision explicit so the module layer does not accidentally copy a
 * stale single-sample view or advertise MSAA-to-MSAA StretchRect.
 */
export function resolveD3D9StretchRectMsaaPolicy(
    sourceMultiSampleType: number,
    destinationMultiSampleType: number,
): D3D9StretchRectMsaaPolicy {
    const sourceSampleCount = (sourceMultiSampleType >>> 0) === 0
        ? 1 : (d3d9MsaaSampleCount(sourceMultiSampleType) ?? 0);
    const destinationSampleCount = (destinationMultiSampleType >>> 0) === 0
        ? 1 : (d3d9MsaaSampleCount(destinationMultiSampleType) ?? 0);
    if (sourceSampleCount === 0 || destinationSampleCount === 0) {
        return {
            supported: false,
            sourceSampleCount,
            destinationSampleCount,
            requiresResolve: false,
            reason: "StretchRect received an unsupported multisample type",
        };
    }
    if (destinationSampleCount > 1) {
        return {
            supported: false,
            sourceSampleCount,
            destinationSampleCount,
            requiresResolve: sourceSampleCount > 1,
            reason: "WebGPU StretchRect lowering has no multisample destination attachment",
        };
    }
    return {
        supported: true,
        sourceSampleCount,
        destinationSampleCount,
        requiresResolve: sourceSampleCount > 1,
        reason: null,
    };
}

export interface D3D9StandaloneDepthPolicy {
    supported: boolean;
    depthSampleCount: number;
    targetSampleCount: number;
    reason: string | null;
}

/**
 * A depth-stencil surface is an attachment, not a texture resolve. D3D9 requires its sample
 * count to match the active color target, so make that invariant reusable by module validation
 * and the backend bind path instead of silently substituting the implicit depth buffer.
 */
export function resolveD3D9StandaloneDepthPolicy(
    depthMultiSampleType: number,
    targetMultiSampleType: number,
): D3D9StandaloneDepthPolicy {
    const decode = (value: number): number => (value >>> 0) === 0
        ? 1 : (d3d9MsaaSampleCount(value) ?? 0);
    return resolveD3D9StandaloneDepthPolicyBySampleCount(
        decode(depthMultiSampleType), decode(targetMultiSampleType));
}

/**
 * The same rule for callers that already hold SAMPLE COUNTS. A D3DMULTISAMPLE_TYPE and a
 * sample count are not interchangeable — type 1 is NONMASKABLE while count 1 is "no MSAA" —
 * so a caller holding a count must not reach the type-decoding entry point.
 */
export function resolveD3D9StandaloneDepthPolicyBySampleCount(
    depthSampleCount: number,
    targetSampleCount: number,
): D3D9StandaloneDepthPolicy {
    if (depthSampleCount <= 0 || targetSampleCount <= 0) {
        return {
            supported: false,
            depthSampleCount,
            targetSampleCount,
            reason: "standalone depth surface has an unsupported multisample type",
        };
    }
    if (depthSampleCount !== targetSampleCount) {
        return {
            supported: false,
            depthSampleCount,
            targetSampleCount,
            reason: "standalone depth sample count must match the active color target",
        };
    }
    return { supported: true, depthSampleCount, targetSampleCount, reason: null };
}

export interface D3D9MrtAttachmentShape {
    sampleCount: number;
    width: number;
    height: number;
}

export interface D3D9MrtCompatibility {
    supported: boolean;
    reason: string | null;
}

/**
 * Validate the WebGPU invariants shared by all enabled D3D9 color targets.
 * WebGPU requires one sample count and one extent for every color attachment;
 * keeping this as a pure policy makes the SetRenderTarget bind-time check and
 * the attachment tests use the same rule instead of discovering a mismatch
 * only when beginRenderPass validates the descriptor.
 */
export function resolveD3D9MrtCompatibility(
    anchor: D3D9MrtAttachmentShape,
    candidate: D3D9MrtAttachmentShape,
): D3D9MrtCompatibility {
    if (anchor.sampleCount !== candidate.sampleCount) {
        return {
            supported: false,
            reason: "MRT color targets must use one sample count",
        };
    }
    if (anchor.width !== candidate.width || anchor.height !== candidate.height) {
        return {
            supported: false,
            reason: "MRT color targets must use one attachment extent",
        };
    }
    return { supported: true, reason: null };
}

export interface D3D9MsaaPassOptions {
    clearColor: GPUColor;
    colorLoadOp?: GPULoadOp;
    colorStoreOp?: GPUStoreOp;
    clearDepth?: number;
    depthLoadOp?: GPULoadOp;
    depthStoreOp?: GPUStoreOp;
    clearStencil?: number;
    stencilLoadOp?: GPULoadOp;
    stencilStoreOp?: GPUStoreOp;
    /** Single occlusion query set used by beginOcclusionQuery in this pass. */
    occlusionQuerySet?: GPUQuerySet;
}

const COPY_SRC = 0x0001;
const COPY_DST = 0x0002;
const TEXTURE_BINDING = 0x0004;
const RENDER_ATTACHMENT = 0x0010;

function textureUsage(name: "COPY_SRC" | "COPY_DST" | "TEXTURE_BINDING" | "RENDER_ATTACHMENT", fallback: number): number {
    const usage = (globalThis as typeof globalThis & { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage;
    return usage?.[name] ?? fallback;
}

function colorResolveUsage(): number {
    return textureUsage("COPY_SRC", COPY_SRC) |
        textureUsage("COPY_DST", COPY_DST) |
        textureUsage("TEXTURE_BINDING", TEXTURE_BINDING) |
        textureUsage("RENDER_ATTACHMENT", RENDER_ATTACHMENT);
}

function renderAttachmentUsage(): number {
    return textureUsage("RENDER_ATTACHMENT", RENDER_ATTACHMENT);
}

function normalizedKey(key: D3D9MsaaTargetKey): string {
    return `${typeof key}:${String(key)}`;
}

function descriptorFingerprint(desc: D3D9MultisampleTargetDescriptor): string {
    return [
        normalizedKey(desc.key),
        desc.width,
        desc.height,
        desc.colorFormat,
        desc.depthFormat,
        desc.sampleCount,
        desc.resolveTexture ? objectIdentity(desc.resolveTexture) : "internal-resolve",
        desc.resolveView ? objectIdentity(desc.resolveView) : "default-resolve-view",
        desc.depthTexture ? objectIdentity(desc.depthTexture) : "internal-depth",
        desc.depthView ? objectIdentity(desc.depthView) : "default-depth-view",
        ...(desc.colorViewFormats ?? []),
    ].join("|");
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function objectIdentity(value: object): number {
    const existing = objectIds.get(value);
    if (existing !== undefined) return existing;
    const id = nextObjectId++;
    objectIds.set(value, id);
    return id;
}

function asSampleCount(value: number): D3D9MsaaSampleCount | null {
    const count = value >>> 0;
    return count === 2 || count === 4 ? count : null;
}

function validateDimensions(desc: D3D9MultisampleTargetDescriptor): boolean {
    return Number.isInteger(desc.width) && desc.width > 0 &&
        Number.isInteger(desc.height) && desc.height > 0;
}

/**
 * Build a WebGPU render-pass descriptor for one D3D9 multisample target.
 * WebGPU performs the color resolve when this pass ends; no copy operation is
 * legal from a multisampled texture, so callers must use this `resolveTarget`
 * path instead of `copyTextureToTexture`.
 */
export function makeD3D9MultisamplePassDescriptor(
    target: D3D9MultisampleTarget,
    options: D3D9MsaaPassOptions,
): GPURenderPassDescriptor {
    const colorStoreOp = options.colorStoreOp ?? "store";
    // A resolve target is produced at pass end and therefore must not be paired
    // with a discarded color attachment.  Force the safe value if a caller asks
    // for discard rather than silently dropping the D3D9 render result.
    const resolvedColorStoreOp: GPUStoreOp = colorStoreOp === "discard" ? "store" : colorStoreOp;
    const depthStencilAttachment: GPURenderPassDepthStencilAttachment = {
        view: target.depthView,
        depthClearValue: options.clearDepth ?? 1,
        depthLoadOp: options.depthLoadOp ?? "load",
        depthStoreOp: options.depthStoreOp ?? "store",
    };
    // Do not attach stencil load/store fields to a depth-only view.  Some
    // WebGPU implementations validate these fields against the texture format
    // instead of ignoring them (D24S8/D32S8 are the formats that need them).
    if (target.depthFormat === "depth24plus-stencil8" || target.depthFormat === "depth32float-stencil8") {
        depthStencilAttachment.stencilClearValue = options.clearStencil ?? 0;
        depthStencilAttachment.stencilLoadOp = options.stencilLoadOp ?? "load";
        depthStencilAttachment.stencilStoreOp = options.stencilStoreOp ?? "store";
    }
    return {
        colorAttachments: [{
            view: target.colorView,
            resolveTarget: target.resolveView,
            clearValue: options.clearColor,
            loadOp: options.colorLoadOp ?? "load",
            storeOp: resolvedColorStoreOp,
        }],
        depthStencilAttachment,
        ...(options.occlusionQuerySet ? { occlusionQuerySet: options.occlusionQuerySet } : {}),
    };
}

/** Begin a D3D9 multisample render pass, including the automatic color resolve. */
export function beginD3D9MultisampleRenderPass(
    encoder: GPUCommandEncoder,
    target: D3D9MultisampleTarget,
    options: D3D9MsaaPassOptions,
): GPURenderPassEncoder {
    return encoder.beginRenderPass(makeD3D9MultisamplePassDescriptor(target, options));
}

/**
 * Cache and lifecycle manager for color/depth MSAA attachments.
 *
 * The cache identity includes target identity, dimensions, formats, view
 * formats, and sample count.  A changed descriptor retires all three textures;
 * callers invoke `flushGarbage` only after the corresponding queue submission.
 */
export class D3D9MultisampleTargetCache {
    private readonly byTarget = new Map<string, { fingerprint: string; target: D3D9MultisampleTarget }>();
    private garbage: GPUTexture[] = [];
    private readonly adapterProbe: D3D9MsaaAdapterProbe;

    constructor(
        private readonly device: GPUDevice,
        adapterProbe?: D3D9MsaaAdapterProbe,
    ) {
        // No portable WebGPU query exposes the complete sample-count set.  Do
        // not create a multisample texture until the caller supplies a probe;
        // this is safer than assuming that every adapter accepts 2x and 4x.
        this.adapterProbe = adapterProbe ?? { supportsSampleCount: () => false };
    }

    acquire(desc: D3D9MultisampleTargetDescriptor): D3D9MultisampleTarget | null {
        const sampleCount = asSampleCount(desc.sampleCount);
        if (!sampleCount || !validateDimensions(desc) || !this.adapterProbe.supportsSampleCount(sampleCount)) {
            return null;
        }

        const targetKey = normalizedKey(desc.key);
        const fingerprint = descriptorFingerprint(desc);
        const existing = this.byTarget.get(targetKey);
        if (existing?.fingerprint === fingerprint) return existing.target;
        if (existing) this.retire(existing.target);

        const size = { width: desc.width, height: desc.height, depthOrArrayLayers: 1 };
        const colorTexture = this.device.createTexture({
            size,
            format: desc.colorFormat,
            ...(desc.colorViewFormats?.length ? { viewFormats: desc.colorViewFormats } : {}),
            sampleCount,
            usage: renderAttachmentUsage(),
        });
        const ownsResolveTexture = !desc.resolveTexture;
        const resolveTexture = desc.resolveTexture ?? this.device.createTexture({
            size,
            format: desc.colorFormat,
            ...(desc.colorViewFormats?.length ? { viewFormats: desc.colorViewFormats } : {}),
            sampleCount: 1,
            usage: colorResolveUsage(),
        });
        const ownsDepthTexture = !desc.depthTexture;
        const depthTexture = desc.depthTexture ?? this.device.createTexture({
            size,
            format: desc.depthFormat,
            sampleCount,
            usage: renderAttachmentUsage(),
        });
        const target: D3D9MultisampleTarget = {
            key: desc.key,
            width: desc.width,
            height: desc.height,
            colorFormat: desc.colorFormat,
            depthFormat: desc.depthFormat,
            sampleCount,
            colorTexture,
            colorView: colorTexture.createView(),
            resolveTexture,
            resolveView: desc.resolveView ?? resolveTexture.createView(),
            ownsResolveTexture,
            depthTexture,
            depthView: desc.depthView ?? depthTexture.createView(),
            ownsDepthTexture,
        };
        this.byTarget.set(targetKey, { fingerprint, target });
        return target;
    }

    remove(key: D3D9MsaaTargetKey): boolean {
        const targetKey = normalizedKey(key);
        const existing = this.byTarget.get(targetKey);
        if (!existing) return false;
        this.retire(existing.target);
        this.byTarget.delete(targetKey);
        return true;
    }

    get(key: D3D9MsaaTargetKey): D3D9MultisampleTarget | null {
        return this.byTarget.get(normalizedKey(key))?.target ?? null;
    }

    /** Destroy resources retired after the last queue submission. */
    flushGarbage(): void {
        for (const texture of this.garbage) texture.destroy();
        this.garbage = [];
    }

    destroy(): void {
        for (const entry of this.byTarget.values()) this.retire(entry.target);
        this.byTarget.clear();
        this.flushGarbage();
    }

    private retire(target: D3D9MultisampleTarget): void {
        this.garbage.push(target.colorTexture);
        if (target.ownsResolveTexture) this.garbage.push(target.resolveTexture);
        if (target.ownsDepthTexture) this.garbage.push(target.depthTexture);
    }
}
