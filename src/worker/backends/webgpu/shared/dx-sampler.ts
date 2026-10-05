/**
 * Shared GPU sampler builder/cache for the DirectX backends (DDraw/D3D7, D3D8, D3D9).
 *
 * Why this exists: every DX version expresses the same sampler intent (min/mag/mip filtering,
 * address modes, anisotropy, LOD clamping) but through DIFFERENT raw enum numbering — e.g. the
 * D3D7 mip-filter enum is D3DTFP_NONE=1/POINT=2/LINEAR=3 while D3D9's D3DTEXF_* is
 * NONE=0/POINT=1/LINEAR=2. So the *decode* of raw enums stays version-specific in each backend,
 * but the *descriptor construction* — quality overrides, the WebGPU anisotropy invariant, correct
 * LOD clamping for MIPFILTER=NONE / MAXMIPLEVEL, and sampler caching — is byte-for-byte identical.
 * Centralising it here keeps DX7/D3D8/D3D9 from drifting (a fix in one used to silently miss the others).
 *
 * Semantics notes vs real DirectX (Wine wined3d sampler.c / DXVK d3d9_device.cpp):
 *  - MIPFILTER == NONE means "sample the base level only". Real runtimes pin maxLod to 0; a WebGPU
 *    sampler that merely sets mipmapFilter="nearest" is STILL a mipmapping sampler, so we must set
 *    lodMaxClamp = 0 to actually pin the base level. (Done unless a quality override opts into mips.)
 *  - MAXMIPLEVEL is the index of the LARGEST (most detailed) mip the sampler may use → lodMinClamp.
 *  - MIPMAPLODBIAS is NOT representable on a WebGPU GPUSampler (no lodBias field; it was removed from
 *    the spec). The shader emitter adds it through textureSampleBias/explicit LOD lowering, and the
 *    raw bits participate in the linked-shader identity.
 */

import { EmulatorConfig } from "../../../core/emulator-config-manager";

/**
 * Address modes understood by the shared sampler path.
 *
 * WebGPU has no clamp-to-border or mirror-once sampler modes. Keep these Direct3D modes explicit;
 * the shader emitter lowers them around a clamp-to-edge native sampler.
 */
export type DxSamplerAddressMode =
    | GPUAddressMode
    | "d3d9-border"
    | "d3d9-mirror-once";

/** Sampler semantics that require shader/resource support not present in the native path. */
export type DxSamplerUnsupportedFeature =
    | "d3d9-anisotropy-limit";

const isUnsupportedAddressMode = (mode: DxSamplerAddressMode): mode is "d3d9-border" | "d3d9-mirror-once" =>
    mode === "d3d9-border" || mode === "d3d9-mirror-once";

/** Decoded, version-agnostic sampler intent. Filters are already mapped to WebGPU strings; the
 *  semantic flags the builder needs that the strings can't carry are passed alongside. */
export interface SamplerSpec {
    /** WebGPU min filter (anisotropic decodes to "linear"). */
    min: GPUFilterMode;
    /** WebGPU mag filter. */
    mag: GPUFilterMode;
    /** WebGPU mip filter (only consulted when a mip chain exists / a quality override applies). */
    mip: GPUMipmapFilterMode;
    /** True when the game requested NO mip filtering (D3D mip filter == NONE / unset). Pins base level. */
    mipNone: boolean;
    addressU: DxSamplerAddressMode;
    addressV: DxSamplerAddressMode;
    addressW?: DxSamplerAddressMode;
    /** Game-requested max anisotropy: >1 only when the game actually selected anisotropic filtering. */
    gameAnisotropy?: number;
    /** D3D MAXMIPLEVEL: index of the most-detailed usable mip → lodMinClamp. 0/undefined = no clamp. */
    maxMipLevel?: number;
    /** D3DSAMP_SRGBTEXTURE requests an sRGB-decoding texture view. This is a
     *  resource/view property, not a sampler descriptor field. */
    srgbTexture?: boolean;
    /** D3DSAMP_BORDERCOLOR as a packed ARGB DWORD. Border addressing is lowered in WGSL. */
    borderColor?: number;
    /** D3DSAMP_MIPMAPLODBIAS decoded from its IEEE-754 DWORD. Shader emitters add it to the
     *  implicit/explicit sample LOD; WebGPU has no sampler-descriptor lod-bias field. */
    mipLodBias?: number;
    /** Raw D3DSAMP_MIPMAPLODBIAS bits, retained for deterministic pipeline keys. */
    mipLodBiasBits?: number;
    /** Explicit capability refusals. An omitted field means this spec is natively representable. */
    unsupportedFeatures?: readonly DxSamplerUnsupportedFeature[];
}

/** Return the WebGPU sRGB view format compatible with a linear texture format. */
export function dxSrgbViewFormat(format: GPUTextureFormat): GPUTextureFormat | null {
    switch (format) {
        case "rgba8unorm": return "rgba8unorm-srgb";
        case "bgra8unorm": return "bgra8unorm-srgb";
        case "bc1-rgba-unorm": return "bc1-rgba-unorm-srgb";
        case "bc2-rgba-unorm": return "bc2-rgba-unorm-srgb";
        case "bc3-rgba-unorm": return "bc3-rgba-unorm-srgb";
        case "bc7-rgba-unorm": return "bc7-rgba-unorm-srgb";
        default: return null;
    }
}

/** Texture descriptor helper: sRGB views must be declared at texture creation. */
export function dxSrgbViewFormats(format: GPUTextureFormat): GPUTextureFormat[] {
    const srgb = dxSrgbViewFormat(format);
    return srgb === null ? [] : [srgb];
}

/** Stable numeric key for an address mode, used by shader-pipeline cache identities. */
export function dxSamplerAddressKey(mode: DxSamplerAddressMode | undefined): string {
    switch (mode) {
        case "repeat": return "r";
        case "mirror-repeat": return "m";
        case "clamp-to-edge": return "c";
        case "d3d9-border": return "b";
        case "d3d9-mirror-once": return "o";
        default: return "c";
    }
}

/** Pipeline identity for the shader-side sampler semantics. sRGB is deliberately omitted: it
 * changes the resource view, not WGSL, and the view identity is already in the draw snapshot. */
export function dxSamplerShaderKey(spec: SamplerSpec): string {
    // Keep every numeric field fixed-width.  Concatenating variable-width hex
    // strings aliases distinct variants (e.g. border=1,bias=0x23 and
    // border=0x12,bias=3), which can make a pipeline reuse the wrong WGSL.
    const hex32 = (value: number | undefined): string =>
        (value === undefined ? 0 : value >>> 0).toString(16).padStart(8, "0");
    return [
        dxSamplerAddressKey(spec.addressU),
        dxSamplerAddressKey(spec.addressV),
        dxSamplerAddressKey(spec.addressW),
        hex32(spec.borderColor),
        hex32(spec.mipLodBiasBits),
    ].join("|");
}

/** Stable key over the stage-indexed sampler state used by a generated shader. */
export function dxSamplerShaderStatesKey(states: ReadonlyMap<number, SamplerSpec>): string {
    return [...states.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([stage, spec]) => `${stage}=${dxSamplerShaderKey(spec)}`)
        .join(";");
}

const clampAniso = (n: number): number => Math.max(1, Math.min(16, Math.floor(n)));

/**
 * Cache + factory for DirectX GPU samplers. One instance per backend executor (bound to its GPUDevice).
 * Keyed on the EFFECTIVE descriptor (post quality-override) so two draws that resolve identically share
 * a sampler, and a config change that alters the effective result lands on a fresh key automatically.
 */
export class DxSamplerCache {
    private device: GPUDevice;
    private cache = new Map<string, GPUSampler>();

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /** Resolve a SamplerSpec to an effective GPUSamplerDescriptor, applying quality overrides,
     *  the WebGPU anisotropy invariant, and LOD clamping. Exposed for unit testing;
     *  `quality` is injectable (defaults to the live EmulatorConfig). */
    static resolveDescriptor(
        spec: SamplerSpec,
        quality?: { anisotropy: number; forceTrilinear: boolean },
    ): GPUSamplerDescriptor {
        const unsupported = DxSamplerCache.unsupportedReason(spec);
        if (unsupported !== null) {
            throw new Error(`D3D sampler feature ${unsupported} has no native WebGPU implementation`);
        }
        // Custom D3D modes are emulated around the sample in WGSL. Clamp the native sampler
        // on those axes so an out-of-range coordinate never leaks a repeat/mirror texel before
        // the shader's border/mirror-once transform runs.
        const addressU = DxSamplerCache.toGpuAddressMode(spec.addressU, "U");
        const addressV = DxSamplerCache.toGpuAddressMode(spec.addressV, "V");
        const addressW = DxSamplerCache.toGpuAddressMode(spec.addressW ?? "clamp-to-edge", "W");
        let min = spec.min;
        let mag = spec.mag;
        let mip = spec.mip;

        // Default: MIPFILTER=NONE samples the base level only.
        let baseLevelOnly = spec.mipNone;
        // D3DTEXF_ANISOTROPIC with MIPFILTER=NONE is legal and worked on every era card:
        // anisotropy is in-plane footprint filtering, not mip selection. WebGPU only requires
        // the three filters to be "linear", which the LOD clamps below still pin to one level.
        let aniso = clampAniso(spec.gameAnisotropy ?? 1);

        // Quality overrides. NEVER smooth intentionally point-sampled
        // textures (pixel-art / crisp UI) — only upgrade ones the game already filters bilinearly.
        const q = quality ?? EmulatorConfig.getInstance().quality;
        const gameUsesPoint = min === "nearest" || mag === "nearest";
        if (q.anisotropy > 1 && !gameUsesPoint) {
            aniso = Math.max(aniso, clampAniso(q.anisotropy));
        }
        if (q.forceTrilinear && !gameUsesPoint && !spec.mipNone) {
            mip = "linear";
            baseLevelOnly = false;
        }

        // WebGPU invariant: maxAnisotropy > 1 requires min/mag/mip all "linear". (Also retroactively
        // fixes a latent spec violation when a game paired anisotropic with a non-linear mip filter.)
        if (aniso > 1) {
            min = "linear";
            mag = "linear";
            mip = "linear";
            // Only a real mip request lifts the base-level pin; MIPFILTER=NONE keeps it,
            // so the linear mipmapFilter demanded above never selects a second level.
            if (!spec.mipNone) baseLevelOnly = false;
        }

        const desc: GPUSamplerDescriptor = {
            minFilter: min,
            magFilter: mag,
            mipmapFilter: mip,
            addressModeU: addressU,
            addressModeV: addressV,
            addressModeW: addressW,
            maxAnisotropy: aniso,
        };

        // LOD clamping. lodMinClamp from MAXMIPLEVEL (most-detailed usable level);
        // lodMaxClamp=0 pins the base level when no mip filtering was requested.
        const lodMin = spec.maxMipLevel && spec.maxMipLevel > 0 ? spec.maxMipLevel : 0;
        if (lodMin > 0) desc.lodMinClamp = lodMin;
        if (baseLevelOnly) desc.lodMaxClamp = Math.max(lodMin, 0);

        return desc;
    }

    /** Return the first address mode with no native WebGPU equivalent, if any. */
    static unsupportedAddressMode(spec: SamplerSpec): "d3d9-border" | "d3d9-mirror-once" | null {
        for (const mode of [spec.addressU, spec.addressV, spec.addressW]) {
            if (mode !== undefined && isUnsupportedAddressMode(mode)) return mode;
        }
        return null;
    }

    /** Return the first sampler capability that cannot be represented natively. */
    static unsupportedReason(spec: SamplerSpec):
        | DxSamplerUnsupportedFeature
        | null {
        return spec.unsupportedFeatures?.[0] ?? null;
    }

    private static toGpuAddressMode(mode: DxSamplerAddressMode, axis: "U" | "V" | "W"): GPUAddressMode {
        if (isUnsupportedAddressMode(mode)) {
            // Shader-side address emulation supplies the missing semantics. Clamp is the only
            // native mode that is safe as the helper's baseline for both border and mirror-once.
            return "clamp-to-edge";
        }
        return mode;
    }

    /** Comparison token over the LIVE quality inputs resolveDescriptor reads (the only descriptor
     *  inputs that don't come from the SamplerSpec). A caller memoising an acquired sampler against
     *  its own state compares this too; it lives here, next to the reads, so a new quality input
     *  cannot be added without the token covering it. Raw (unclamped) values — over-invalidating
     *  costs a rebuild, under-invalidating is a silently wrong sampler. */
    static qualityToken(): number {
        const q = EmulatorConfig.getInstance().quality;
        return q.anisotropy * 2 + (q.forceTrilinear ? 1 : 0);
    }

    /** Stable cache key for an effective descriptor. */
    private static keyOf(d: GPUSamplerDescriptor): string {
        const fb = (f: GPUFilterMode | GPUMipmapFilterMode | undefined): number => (f === "linear" ? 1 : 0);
        const ab = (a: GPUAddressMode | undefined): number =>
            a === "repeat" ? 1 : a === "mirror-repeat" ? 2 : a === "clamp-to-edge" ? 0 : 3;
        return [
            fb(d.minFilter), fb(d.magFilter), fb(d.mipmapFilter),
            ab(d.addressModeU), ab(d.addressModeV), ab(d.addressModeW),
            d.maxAnisotropy ?? 1,
            d.lodMinClamp ?? 0,
            d.lodMaxClamp === undefined ? -1 : d.lodMaxClamp,
            d.compare ?? "none",
        ].join(":");
    }

    /** Acquire (create-or-reuse) a natively representable GPU sampler for the given spec. */
    acquire(spec: SamplerSpec, comparison = false): GPUSampler {
        const unsupported = DxSamplerCache.unsupportedReason(spec);
        if (unsupported !== null) {
            throw new Error(`Cannot create D3D sampler with unsupported feature ${unsupported}`);
        }
        const desc = DxSamplerCache.resolveDescriptor(spec);
        if (comparison) desc.compare = "less-equal";
        const key = DxSamplerCache.keyOf(desc);
        let s = this.cache.get(key);
        if (!s) {
            s = this.device.createSampler(desc);
            this.cache.set(key, s);
        }
        return s;
    }

    /**
     * Capability-aware acquire for callers that have an explicit sampler fallback. Unsupported
     * modes return null without creating a misleading sampler; native modes share acquire's
     * cache and descriptor path.
     */
    tryAcquire(spec: SamplerSpec, comparison = false): GPUSampler | null {
        if (DxSamplerCache.unsupportedReason(spec) !== null) return null;
        try {
            return this.acquire(spec, comparison);
        } catch (error) {
            // Keep draw paths non-throwing if a future descriptor validation adds a
            // capability refusal between the preflight and acquire calls.
            if (DxSamplerCache.unsupportedReason(spec) !== null) return null;
            throw error;
        }
    }

    /** Drop cached samplers (e.g. on device loss / executor reset). */
    clear(): void {
        this.cache.clear();
    }
}
