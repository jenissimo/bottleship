/**
 * Pipeline factory for DirectDraw/Direct3D7 WebGPU backend.
 * Handles creation and caching of render pipelines based on D3D state.
 */

import { Logger, LogCategory } from "../../../core/logger";
import { System } from "../../../core/system";
import { isBitmapTexture } from "../../../modules/ddraw/com-objects";
import {
    D3DRENDERSTATE_CULLMODE,
    D3DRENDERSTATE_SHADEMODE,
    D3DSHADE_FLAT,
    D3DRENDERSTATE_ZENABLE,
    D3DRENDERSTATE_ZWRITEENABLE,
    D3DRENDERSTATE_ZFUNC,
    D3DRENDERSTATE_ZBIAS,
    D3DRENDERSTATE_ALPHABLENDENABLE,
    D3DRENDERSTATE_ALPHATESTENABLE,
    D3DRENDERSTATE_ALPHAREF,
    D3DRENDERSTATE_SRCBLEND,
    D3DRENDERSTATE_DESTBLEND,
    D3DRENDERSTATE_ALPHAFUNC,
    D3DRENDERSTATE_COLORKEYENABLE,
    D3DRENDERSTATE_STENCILENABLE,
    D3DRENDERSTATE_STENCILFAIL,
    D3DRENDERSTATE_STENCILZFAIL,
    D3DRENDERSTATE_STENCILPASS,
    D3DRENDERSTATE_STENCILFUNC,
    D3DRENDERSTATE_STENCILREF,
    D3DRENDERSTATE_STENCILMASK,
    D3DRENDERSTATE_STENCILWRITEMASK,
    D3DCULL_CW,
    D3DCULL_CCW,
    D3DCMP_NEVER,
    D3DCMP_LESS,
    D3DCMP_EQUAL,
    D3DCMP_LESSEQUAL,
    D3DCMP_GREATER,
    D3DCMP_NOTEQUAL,
    D3DCMP_GREATEREQUAL,
    D3DCMP_ALWAYS,
    D3DSTENCILOP_KEEP,
    D3DSTENCILOP_ZERO,
    D3DSTENCILOP_REPLACE,
    D3DSTENCILOP_INCRSAT,
    D3DSTENCILOP_DECRSAT,
    D3DSTENCILOP_INVERT,
    D3DSTENCILOP_INCR,
    D3DSTENCILOP_DECR,
    D3DPT_POINTLIST,
    D3DPT_LINELIST,
    D3DPT_LINESTRIP,
    D3DPT_TRIANGLESTRIP,
    D3DPT_TRIANGLEFAN,
    D3DFVF_XYZRHW,
    D3DFVF_XYZ,
    D3DFVF_DIFFUSE,
    D3DTFN_POINT,
    D3DTFG_POINT,
} from "../../../modules/ddraw/constants";
import { DebugFlags, generatePipelineKey, generateMegaBatchPipelineKey, PipelineKeyConfig, makeEmptyPipelineKeyConfig,
    pipelineKeyConfigsEqual, megaBatchPipelineKeyConfigsEqual } from "./types";
import { ShaderGenerator, ShaderConfig } from "./shader-generator";
import { BindGroupManager } from "./bind-group-manager";
import { DirectDrawSurfaceState } from "../../../modules/ddraw/com-objects";
import { FfpStagesState, MAX_FFP_SAMPLED_STAGES } from "./ffp-stages";

/**
 * Maps D3D blend factor to WebGPU blend factor
 */
function mapBlendFactor(blend: number): GPUBlendFactor {
    // D3DBLEND_*: 1=ZERO, 2=ONE, 3=SRCCOLOR, 4=INVSRCCOLOR, 5=SRCALPHA, 6=INVSRCALPHA,
    // 7=DESTALPHA, 8=INVDESTALPHA, 9=DESTCOLOR, 10=INVDESTCOLOR, 11=SRCALPHASAT
    switch (blend | 0) {
        case 1: return "zero";
        case 2: return "one";
        case 3: return "src";
        case 4: return "one-minus-src";
        case 5: return "src-alpha";
        case 6: return "one-minus-src-alpha";
        case 7: return "dst-alpha";
        case 8: return "one-minus-dst-alpha";
        case 9: return "dst";
        case 10: return "one-minus-dst";
        case 11: return "src-alpha-saturated";
        default: return "src-alpha";
    }
}

/**
 * Maps D3D depth compare function to WebGPU compare function
 */
function mapDepthCompareFunction(d3dCmpFunc: number): GPUCompareFunction {
    switch (d3dCmpFunc) {
        case D3DCMP_NEVER: return "never";
        case D3DCMP_LESS: return "less";
        case D3DCMP_EQUAL: return "equal";
        case D3DCMP_LESSEQUAL: return "less-equal";
        case D3DCMP_GREATER: return "greater";
        case D3DCMP_NOTEQUAL: return "not-equal";
        case D3DCMP_GREATEREQUAL: return "greater-equal";
        case D3DCMP_ALWAYS: return "always";
        default:
            Logger.warn(
                LogCategory.SYSTEM,
                `PipelineFactory: Unknown depth compare function ${d3dCmpFunc}, using less-equal`
            );
            return "less-equal";
    }
}

/**
 * Maps D3D stencil operation to WebGPU stencil operation
 */
function mapStencilOperation(d3dStencilOp: number): GPUStencilOperation {
    switch (d3dStencilOp) {
        case D3DSTENCILOP_KEEP: return "keep";
        case D3DSTENCILOP_ZERO: return "zero";
        case D3DSTENCILOP_REPLACE: return "replace";
        case D3DSTENCILOP_INCRSAT: return "increment-clamp";
        case D3DSTENCILOP_DECRSAT: return "decrement-clamp";
        case D3DSTENCILOP_INVERT: return "invert";
        case D3DSTENCILOP_INCR: return "increment-wrap";
        case D3DSTENCILOP_DECR: return "decrement-wrap";
        default:
            Logger.warn(
                LogCategory.SYSTEM,
                `PipelineFactory: Unknown stencil operation ${d3dStencilOp}, using keep`
            );
            return "keep";
    }
}

function shouldUseLegacyPointSample(
    useTexture: boolean,
    minFilter: number,
    magFilter: number,
    forcePointFilter: boolean,
    disablePointUvBias: boolean
): boolean {
    if (!useTexture || disablePointUvBias) return false;

    const effectiveMin = forcePointFilter ? D3DTFN_POINT : (minFilter || D3DTFN_POINT);
    const effectiveMag = forcePointFilter ? D3DTFG_POINT : (magFilter || D3DTFG_POINT);
    return effectiveMin === D3DTFN_POINT && effectiveMag === D3DTFG_POINT;
}

/** Bit N = sampled stage N uses the legacy POINT texel-selection bias in the shader. */
function computePointSampleMask(
    stages: FfpStagesState,
    colorKeyActive: boolean,
    debugFlags: DebugFlags
): number {
    let mask = 0;
    for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
        const sampled = (stages.sampledMask & (1 << s)) !== 0;
        if (shouldUseLegacyPointSample(
            sampled,
            stages.minFilter[s],
            stages.magFilter[s],
            debugFlags.forcePointFilter || (s === 0 && colorKeyActive),
            debugFlags.disablePointUvBias
        )) {
            mask |= 1 << s;
        }
    }
    return mask;
}

/**
 * Factory for creating and caching render pipelines
 */
export class PipelineFactory {
    private device: GPUDevice;
    private shaderGenerator: ShaderGenerator;
    private bindGroupManager: BindGroupManager;
    private debugFlags: DebugFlags;
    private swapChainFormat: GPUTextureFormat;
    // Colour format of the render target the next pipeline will be used with. A pipeline's
    // fragment target format must EQUAL the pass attachment's format or WebGPU rejects the
    // pass ("Attachment state of RenderPipeline is not compatible with RenderPassEncoder")
    // and invalidates the whole command buffer — silently dropping every draw AND every
    // texture upload recorded on that encoder. It is NOT always the swapchain format: a
    // DirectDraw surface owns its texture, and paths that recreate it (the presenter's
    // RGB565/PALETTE8 conversion needs an rgba8unorm target) legitimately give a
    // bgra8unorm-swapchain build an rgba8unorm render target. Keyed, not cleared, so a game
    // alternating targets of different formats does not thrash the cache.
    private colorFormat: GPUTextureFormat;
    // MSAA sample count (1 = off). Must equal the color + depth attachment sampleCount at
    // draw time. Baked into every pipeline's `multisample.count` and the cache key.
    private sampleCount = 1;

    // Pipeline cache
    private pipelineCache = new Map<string, GPURenderPipeline>();

    // Last-config fast path: avoids string allocation + Map lookup on consecutive same-state draws.
    // Double-buffered key scratch: the fast path RETAINS the previous config by reference,
    // so a single reusable object would alias `last` and make every comparison trivially
    // equal — returning the previous pipeline for a changed state. Flipping only on a miss
    // (the only moment `last` is reassigned) keeps write target and `last` distinct.
    private readonly getPipelineKeyScratch: [PipelineKeyConfig, PipelineKeyConfig] =
        [makeEmptyPipelineKeyConfig(), makeEmptyPipelineKeyConfig()];
    private getPipelineKeyIdx = 0;
    private readonly megaBatchKeyScratch: [PipelineKeyConfig, PipelineKeyConfig] =
        [makeEmptyPipelineKeyConfig(), makeEmptyPipelineKeyConfig()];
    private megaBatchKeyIdx = 0;
    /** Cached ddraw module for the frame counters — a registry lookup per draw is not free. */
    private cachedDDrawModule: any = null;
    private cachedDDrawModuleResolved = false;
    private ddrawModule(): any {
        if (!this.cachedDDrawModuleResolved) {
            this.cachedDDrawModuleResolved = true;
            this.cachedDDrawModule = System.getInstance().process?.getModule("ddraw");
        }
        return this.cachedDDrawModule;
    }
    private lastGetPipelineConfig: PipelineKeyConfig | null = null;
    private lastGetPipelinePipeline: GPURenderPipeline | null = null;

    // MegaBatch last-config fast path
    private lastMegaBatchConfig: PipelineKeyConfig | null = null;
    private lastMegaBatchPipeline: GPURenderPipeline | null = null;

    // Warn-once flag for XYZ without MVP
    private warnedXYZNoMVP = false;

    constructor(
        device: GPUDevice,
        shaderGenerator: ShaderGenerator,
        bindGroupManager: BindGroupManager,
        debugFlags: DebugFlags,
        swapChainFormat: GPUTextureFormat
    ) {
        this.device = device;
        this.shaderGenerator = shaderGenerator;
        this.bindGroupManager = bindGroupManager;
        this.debugFlags = debugFlags;
        this.swapChainFormat = swapChainFormat;
        this.colorFormat = swapChainFormat;
    }

    /** Declare the colour format of the render target subsequent pipelines will draw into.
     *  Called when a render pass is opened; see `colorFormat`. */
    setColorTargetFormat(format: GPUTextureFormat): void {
        if (format === this.colorFormat) return;
        this.colorFormat = format;
        // The last-config fast paths memoise a pipeline for a config that no longer implies
        // this format; drop them so the next draw re-keys.
        this.lastGetPipelineConfig = null;
        this.lastGetPipelinePipeline = null;
        this.lastMegaBatchConfig = null;
        this.lastMegaBatchPipeline = null;
    }

    /**
     * Update debug flags and invalidate cache
     */
    setDebugFlags(flags: DebugFlags): void {
        this.debugFlags = flags;
        this.pipelineCache.clear();
        this.lastGetPipelineConfig = null;
        this.lastGetPipelinePipeline = null;
        this.lastMegaBatchConfig = null;
        this.lastMegaBatchPipeline = null;
    }

    /**
     * Set the MSAA sample count (from quality.msaa). Clamps to {1,2,4}. On change, ALL cached
     * pipelines are invalidated (they baked the old sampleCount into multisample.count) and the
     * fast-path configs cleared. Returns true if the count actually changed. sampleCount===1 is
     * the default and produces `multisample.count:1` — WebGPU's default → byte-identical output.
     */
    setSampleCount(n: number): boolean {
        const clamped = n >= 4 ? 4 : n >= 2 ? 2 : 1;
        if (clamped === this.sampleCount) return false;
        this.sampleCount = clamped;
        this.invalidateCache();
        this.megaBatchPipelineCache.clear();
        return true;
    }

    getSampleCount(): number {
        return this.sampleCount;
    }

    /** Cached pipeline count (debug GPU panel). */
    getCacheSize(): number {
        return this.pipelineCache.size + this.megaBatchPipelineCache.size;
    }

    /**
     * Invalidate pipeline cache
     */
    invalidateCache(): void {
        this.pipelineCache.clear();
        this.lastGetPipelineConfig = null;
        this.lastGetPipelinePipeline = null;
        this.lastMegaBatchConfig = null;
        this.lastMegaBatchPipeline = null;
    }

    /**
     * Get or create a render pipeline for the given configuration
     */
    getOrCreatePipeline(
        vertexType: number,
        primitiveType: number,
        stages: FfpStagesState,
        missingTexture: boolean,
        renderStates: Int32Array,
        texture?: DirectDrawSurfaceState | null
    ): GPURenderPipeline {
        const useTexture = (stages.sampledMask & 1) !== 0;
        // Read render states
        const d3dCull = renderStates[D3DRENDERSTATE_CULLMODE];
        const zEnableRaw = renderStates[D3DRENDERSTATE_ZENABLE];
        const zEnable = zEnableRaw > 0 ? 1 : 0; // Normalize: any non-zero = enabled
        const zFunc = renderStates[D3DRENDERSTATE_ZFUNC] || D3DCMP_LESSEQUAL;
        const zWrite = renderStates[D3DRENDERSTATE_ZWRITEENABLE];
        // D3DRENDERSTATE_ZBIAS: 0-16, used to reduce z-fighting for coplanar polygons (decals, shadows)
        const zBias = renderStates[D3DRENDERSTATE_ZBIAS] || 0;
        const alphaBlend = renderStates[D3DRENDERSTATE_ALPHABLENDENABLE];
        const alphaTest = renderStates[D3DRENDERSTATE_ALPHATESTENABLE];
        const srcBlend = renderStates[D3DRENDERSTATE_SRCBLEND];
        const dstBlend = renderStates[D3DRENDERSTATE_DESTBLEND];
        const alphaFunc = renderStates[D3DRENDERSTATE_ALPHAFUNC];
        const colorKeyEnabled = renderStates[D3DRENDERSTATE_COLORKEYENABLE] || 0;
        const colorKeyActive = useTexture && !!texture?.srcColorKey && colorKeyEnabled !== 0;
        const pointSampleMask = computePointSampleMask(stages, colorKeyActive, this.debugFlags);

        // Read stencil states
        const stencilEnable = renderStates[D3DRENDERSTATE_STENCILENABLE] || 0;
        const stencilFunc = renderStates[D3DRENDERSTATE_STENCILFUNC] || D3DCMP_ALWAYS;
        const stencilFail = renderStates[D3DRENDERSTATE_STENCILFAIL] || D3DSTENCILOP_KEEP;
        const stencilZFail = renderStates[D3DRENDERSTATE_STENCILZFAIL] || D3DSTENCILOP_KEEP;
        const stencilPass = renderStates[D3DRENDERSTATE_STENCILPASS] || D3DSTENCILOP_KEEP;
        const stencilRef = renderStates[D3DRENDERSTATE_STENCILREF] || 0;
        const stencilMask = renderStates[D3DRENDERSTATE_STENCILMASK] ?? 0xff;
        const stencilWriteMask = renderStates[D3DRENDERSTATE_STENCILWRITEMASK] ?? 0xff;

        const effectiveAlphaBlend = alphaBlend ? 1 : 0;
        const effectiveSrcBlend = effectiveAlphaBlend ? (srcBlend || 2) : 0;
        const effectiveDstBlend = effectiveAlphaBlend ? (dstBlend || 1) : 0;
        // EQUAL + depth-writes-off is a coplanar overlay pass (decal / detail / lightmap). It
        // relies on both passes interpolating identical depth, which differing triangulation
        // breaks into a crawling dither. LESSEQUAL asks the same question robustly — nearer
        // geometry still occludes it. NOTE: a divergence from real D3D (Wine and DXVK map
        // D3DCMP_EQUAL straight through); confined to depth-write-off passes so anything using
        // EQUAL while AUTHORING depth keeps exact semantics.
        const zFuncCoplanar = (zFunc === D3DCMP_EQUAL && !zWrite) ? D3DCMP_LESSEQUAL : zFunc;
        const coplanarPass = (zEnable && zFunc === D3DCMP_EQUAL && !zWrite) ? 1 : 0;
        const effectiveZFunc = zEnable ? (zFuncCoplanar || D3DCMP_LESSEQUAL) : 0;
        const effectiveZWrite = zEnable ? (zWrite ? 1 : 0) : 0;
        const keyAlphaBlend = (effectiveAlphaBlend && !this.debugFlags.forceDisableAlphaBlend) ? 1 : 0;
        
        const hasDiffuse = (vertexType & D3DFVF_DIFFUSE) !== 0;
        const isRHWVertex = (vertexType & D3DFVF_XYZRHW) !== 0;
        // UI detection: XYZRHW (pre-transformed) + no texture + diffuse only + fan/strip
        // This is more precise than just checking primitive type - avoids disabling culling for 3D geometry
        const isUIType = isRHWVertex && !useTexture && hasDiffuse && (
            primitiveType === D3DPT_TRIANGLEFAN || primitiveType === D3DPT_TRIANGLESTRIP
        );
        let effectiveCullMode = d3dCull;
        if (isUIType || this.debugFlags.forceCullNone) {
            effectiveCullMode = 0;
        }
        // (No RHW CW<->CCW swap: XYZRHW is culled identically to non-RHW — the old swap
        // inverted culling for pre-transformed geometry. See the cull-mode build below.)
        const keyConfig = this.getPipelineKeyScratch[this.getPipelineKeyIdx];
        keyConfig.vertexType = vertexType;
        keyConfig.primitiveType = primitiveType;
        keyConfig.sampledMask = stages.sampledMask;
        keyConfig.stageCount = stages.stageCount;
        keyConfig.pointSampleMask = pointSampleMask;
        keyConfig.missingTexture = missingTexture;
        keyConfig.cullMode = effectiveCullMode;
        keyConfig.zEnable = zEnable;
        keyConfig.zFunc = effectiveZFunc;
        keyConfig.zWrite = effectiveZWrite;
        keyConfig.zBias = zEnable ? zBias : 0; // Only include zBias when depth testing is enabled
        keyConfig.coplanarPass = coplanarPass;
        keyConfig.alphaBlend = keyAlphaBlend;
        keyConfig.alphaTest = alphaTest;
        keyConfig.srcBlend = effectiveSrcBlend;
        keyConfig.dstBlend = effectiveDstBlend;
        keyConfig.alphaFunc = alphaFunc;
        keyConfig.colorKeyEnabled = colorKeyEnabled > 0 ? 1 : 0;
        keyConfig.stencilEnable = stencilEnable > 0 ? 1 : 0;
        keyConfig.stencilFunc = stencilEnable > 0 ? stencilFunc : 0;
        keyConfig.stencilFail = stencilEnable > 0 ? stencilFail : 0;
        keyConfig.stencilZFail = stencilEnable > 0 ? stencilZFail : 0;
        keyConfig.stencilPass = stencilEnable > 0 ? stencilPass : 0;
        keyConfig.stencilRef = stencilRef;
        keyConfig.stencilMask = stencilMask;
        keyConfig.stencilWriteMask = stencilWriteMask;
        keyConfig.forceZMidpoint = this.debugFlags.forceZMidpoint;
        keyConfig.forceCullNone = this.debugFlags.forceCullNone;
        keyConfig.forceDisableZTest = this.debugFlags.forceDisableZTest;
        keyConfig.forceDisableZWrite = this.debugFlags.forceDisableZWrite;
        keyConfig.debugView = this.debugFlags.debugView;
        keyConfig.flatShading = renderStates[D3DRENDERSTATE_SHADEMODE] === D3DSHADE_FLAT;

        // Fast path: same config as last call → return cached pipeline without string alloc
        // `keyConfig !== last` is a safety interlock, not an optimisation: should the scratch
        // ever alias the retained config, every comparison would be trivially equal and this
        // would hand back the previous pipeline for a changed state. Requiring distinct objects
        // degrades to the (correct) cache lookup instead of rendering with the wrong pipeline.
        if (this.lastGetPipelineConfig !== null &&
            this.lastGetPipelinePipeline !== null &&
            keyConfig !== this.lastGetPipelineConfig &&
            pipelineKeyConfigsEqual(keyConfig, this.lastGetPipelineConfig)) {
            return this.lastGetPipelinePipeline;
        }

        // sampleCount prefix keeps MSAA and non-MSAA pipelines distinct without touching the
        // shared PipelineKeyConfig in types.ts (sampleCount is a factory-global, not per-draw).
        const key = this.sampleCount + "|" + this.colorFormat + "|" + generatePipelineKey(keyConfig);

        // Check cache
        let pipeline = this.pipelineCache.get(key);

        const ddraw = this.ddrawModule();

        if (pipeline) {
            if (ddraw?.incrementFrameCounter) {
                ddraw.incrementFrameCounter("cacheHits");
            }
            this.lastGetPipelineConfig = keyConfig;
            this.lastGetPipelinePipeline = pipeline;
            this.getPipelineKeyIdx ^= 1;
            return pipeline;
        }

        if (ddraw?.incrementFrameCounter) {
            ddraw.incrementFrameCounter("cacheMisses");
        }

        // needsUVFlip only exists on BitmapTextureSurface
        const needsUVFlip = (texture && isBitmapTexture(texture)) ? (texture.needsUVFlip ?? false) : false;

        pipeline = this.createPipeline(
            vertexType,
            primitiveType,
            stages.sampledMask,
            stages.stageCount,
            pointSampleMask,
            missingTexture,
            d3dCull,
            zEnable,
            effectiveZFunc,
            zWrite,
            zBias,
            coplanarPass,
            effectiveAlphaBlend, // Use normalized value
            alphaTest,
            srcBlend,
            dstBlend,
            alphaFunc,
            colorKeyEnabled > 0 ? 1 : 0,
            stencilEnable > 0 ? 1 : 0,
            stencilFunc,
            stencilFail,
            stencilZFail,
            stencilPass,
            stencilRef,
            stencilMask,
            stencilWriteMask,
            needsUVFlip,
            keyConfig.flatShading
        );

        this.pipelineCache.set(key, pipeline);
        this.lastGetPipelineConfig = keyConfig;
        this.lastGetPipelinePipeline = pipeline;
        this.getPipelineKeyIdx ^= 1;
        Logger.verbose(LogCategory.SYSTEM, `PipelineFactory: Created new pipeline with key: ${key}`);
        return pipeline;
    }

    // MegaBatch pipeline cache
    private megaBatchPipelineCache = new Map<string, GPURenderPipeline>();

    /**
     * Get or create a MegaBatch render pipeline.
     * MegaBatch pipelines use storage buffer for per-draw uniforms and instance_index.
     */
    getOrCreateMegaBatchPipeline(
        vertexType: number,
        primitiveType: number,
        stages: FfpStagesState,
        missingTexture: boolean,
        renderStates: Int32Array,
        texture?: DirectDrawSurfaceState | null
    ): GPURenderPipeline {
        const useTexture = (stages.sampledMask & 1) !== 0;
        // Read render states (same as regular pipeline)
        const d3dCull = renderStates[D3DRENDERSTATE_CULLMODE];
        const zEnableRaw = renderStates[D3DRENDERSTATE_ZENABLE];
        const zEnable = zEnableRaw > 0 ? 1 : 0;
        const zFunc = renderStates[D3DRENDERSTATE_ZFUNC] || D3DCMP_LESSEQUAL;
        const zWrite = renderStates[D3DRENDERSTATE_ZWRITEENABLE];
        const zBias = renderStates[D3DRENDERSTATE_ZBIAS] || 0;
        const alphaBlend = renderStates[D3DRENDERSTATE_ALPHABLENDENABLE];
        const alphaTest = renderStates[D3DRENDERSTATE_ALPHATESTENABLE];
        const srcBlend = renderStates[D3DRENDERSTATE_SRCBLEND];
        const dstBlend = renderStates[D3DRENDERSTATE_DESTBLEND];
        const alphaFunc = renderStates[D3DRENDERSTATE_ALPHAFUNC];
        const colorKeyEnabled = renderStates[D3DRENDERSTATE_COLORKEYENABLE] || 0;
        const colorKeyActive = useTexture && !!texture?.srcColorKey && colorKeyEnabled !== 0;
        const pointSampleMask = computePointSampleMask(stages, colorKeyActive, this.debugFlags);
        const stencilEnable = renderStates[D3DRENDERSTATE_STENCILENABLE] || 0;
        const stencilFunc = renderStates[D3DRENDERSTATE_STENCILFUNC] || D3DCMP_ALWAYS;
        const stencilFail = renderStates[D3DRENDERSTATE_STENCILFAIL] || D3DSTENCILOP_KEEP;
        const stencilZFail = renderStates[D3DRENDERSTATE_STENCILZFAIL] || D3DSTENCILOP_KEEP;
        const stencilPass = renderStates[D3DRENDERSTATE_STENCILPASS] || D3DSTENCILOP_KEEP;
        const stencilRef = renderStates[D3DRENDERSTATE_STENCILREF] || 0;
        const stencilMask = renderStates[D3DRENDERSTATE_STENCILMASK] ?? 0xff;
        const stencilWriteMask = renderStates[D3DRENDERSTATE_STENCILWRITEMASK] ?? 0xff;

        const effectiveAlphaBlend = alphaBlend ? 1 : 0;
        const effectiveSrcBlend = effectiveAlphaBlend ? (srcBlend || 2) : 0;
        const effectiveDstBlend = effectiveAlphaBlend ? (dstBlend || 1) : 0;
        // EQUAL + depth-writes-off is a coplanar overlay pass (decal / detail / lightmap). It
        // relies on both passes interpolating identical depth, which differing triangulation
        // breaks into a crawling dither. LESSEQUAL asks the same question robustly — nearer
        // geometry still occludes it. NOTE: a divergence from real D3D (Wine and DXVK map
        // D3DCMP_EQUAL straight through); confined to depth-write-off passes so anything using
        // EQUAL while AUTHORING depth keeps exact semantics.
        const zFuncCoplanar = (zFunc === D3DCMP_EQUAL && !zWrite) ? D3DCMP_LESSEQUAL : zFunc;
        const coplanarPass = (zEnable && zFunc === D3DCMP_EQUAL && !zWrite) ? 1 : 0;
        const effectiveZFunc = zEnable ? (zFuncCoplanar || D3DCMP_LESSEQUAL) : 0;
        const effectiveZWrite = zEnable ? (zWrite ? 1 : 0) : 0;
        const keyAlphaBlend = (effectiveAlphaBlend && !this.debugFlags.forceDisableAlphaBlend) ? 1 : 0;

        const hasDiffuse = (vertexType & D3DFVF_DIFFUSE) !== 0;
        const isRHWVertex = (vertexType & D3DFVF_XYZRHW) !== 0;
        const isUIType = isRHWVertex && !useTexture && hasDiffuse && (
            primitiveType === D3DPT_TRIANGLEFAN || primitiveType === D3DPT_TRIANGLESTRIP
        );
        let effectiveCullMode = d3dCull;
        if (isUIType || this.debugFlags.forceCullNone) {
            effectiveCullMode = 0;
        }
        // (No RHW CW<->CCW swap: XYZRHW is culled identically to non-RHW — the old swap
        // inverted culling for pre-transformed geometry. See the cull-mode build below.)

        // Generate cache key with "mb_" prefix for MegaBatch
        const keyConfig = this.megaBatchKeyScratch[this.megaBatchKeyIdx];
        keyConfig.vertexType = vertexType;
        keyConfig.primitiveType = primitiveType;
        keyConfig.sampledMask = stages.sampledMask;
        keyConfig.stageCount = stages.stageCount;
        keyConfig.pointSampleMask = pointSampleMask;
        keyConfig.missingTexture = missingTexture;
        keyConfig.cullMode = effectiveCullMode;
        keyConfig.zEnable = zEnable;
        keyConfig.zFunc = effectiveZFunc;
        keyConfig.zWrite = effectiveZWrite;
        keyConfig.zBias = zEnable ? zBias : 0;
        keyConfig.coplanarPass = coplanarPass;
        keyConfig.alphaBlend = keyAlphaBlend;
        keyConfig.alphaTest = alphaTest;
        keyConfig.srcBlend = effectiveSrcBlend;
        keyConfig.dstBlend = effectiveDstBlend;
        keyConfig.alphaFunc = alphaFunc;
        keyConfig.colorKeyEnabled = colorKeyEnabled > 0 ? 1 : 0;
        keyConfig.stencilEnable = stencilEnable > 0 ? 1 : 0;
        keyConfig.stencilFunc = stencilEnable > 0 ? stencilFunc : 0;
        keyConfig.stencilFail = stencilEnable > 0 ? stencilFail : 0;
        keyConfig.stencilZFail = stencilEnable > 0 ? stencilZFail : 0;
        keyConfig.stencilPass = stencilEnable > 0 ? stencilPass : 0;
        keyConfig.stencilRef = stencilRef;
        keyConfig.stencilMask = stencilMask;
        keyConfig.stencilWriteMask = stencilWriteMask;
        keyConfig.forceZMidpoint = this.debugFlags.forceZMidpoint;
        keyConfig.forceCullNone = this.debugFlags.forceCullNone;
        keyConfig.forceDisableZTest = this.debugFlags.forceDisableZTest;
        keyConfig.forceDisableZWrite = this.debugFlags.forceDisableZWrite;
        keyConfig.debugView = this.debugFlags.debugView;
        keyConfig.flatShading = renderStates[D3DRENDERSTATE_SHADEMODE] === D3DSHADE_FLAT;

        // Fast path: same config as last call → return cached pipeline without string alloc
        // Distinct-object interlock — see getOrCreatePipeline.
        if (this.lastMegaBatchConfig !== null &&
            this.lastMegaBatchPipeline !== null &&
            keyConfig !== this.lastMegaBatchConfig &&
            megaBatchPipelineKeyConfigsEqual(keyConfig, this.lastMegaBatchConfig)) {
            return this.lastMegaBatchPipeline;
        }

        // Use MegaBatch key generator (excludes alphaTest/alphaFunc - they're dynamic uniforms).
        // sampleCount prefix segregates MSAA pipelines (see getOrCreatePipeline).
        const key = "mb_" + this.sampleCount + "|" + this.colorFormat + "|" + generateMegaBatchPipelineKey(keyConfig);

        // Check cache
        let pipeline = this.megaBatchPipelineCache.get(key);
        if (pipeline) {
            this.lastMegaBatchConfig = keyConfig;
            this.lastMegaBatchPipeline = pipeline;
            this.megaBatchKeyIdx ^= 1;
            return pipeline;
        }

        // needsUVFlip only exists on BitmapTextureSurface
        const needsUVFlip = (texture && isBitmapTexture(texture)) ? (texture.needsUVFlip ?? false) : false;

        pipeline = this.createMegaBatchPipeline(
            vertexType,
            primitiveType,
            stages.sampledMask,
            stages.stageCount,
            pointSampleMask,
            missingTexture,
            d3dCull,
            zEnable,
            effectiveZFunc,
            zWrite,
            zBias,
            coplanarPass,
            effectiveAlphaBlend,
            alphaTest,
            srcBlend,
            dstBlend,
            alphaFunc,
            colorKeyEnabled > 0 ? 1 : 0,
            stencilEnable > 0 ? 1 : 0,
            stencilFunc,
            stencilFail,
            stencilZFail,
            stencilPass,
            stencilRef,
            stencilMask,
            stencilWriteMask,
            needsUVFlip,
            keyConfig.flatShading
        );

        this.megaBatchPipelineCache.set(key, pipeline);
        this.lastMegaBatchConfig = keyConfig;
        this.lastMegaBatchPipeline = pipeline;
        this.megaBatchKeyIdx ^= 1;
        Logger.verbose(LogCategory.SYSTEM, `PipelineFactory: Created MegaBatch pipeline with key: ${key}`);
        return pipeline;
    }

    private createMegaBatchPipeline(
        vertexType: number,
        primitiveType: number,
        sampledMask: number,
        stageCount: number,
        pointSampleMask: number,
        missingTexture: boolean,
        d3dCull: number,
        zEnable: number,
        zFunc: number,
        zWrite: number,
        zBias: number,
        coplanarPass: number,
        effectiveAlphaBlend: number,
        alphaTest: number,
        srcBlend: number,
        dstBlend: number,
        alphaFunc: number,
        colorKeyEnabled: number,
        stencilEnable: number,
        stencilFunc: number,
        stencilFail: number,
        stencilZFail: number,
        stencilPass: number,
        stencilRef: number,
        stencilMask: number,
        stencilWriteMask: number,
        needsUVFlip: boolean,
        flatShading: boolean
    ): GPURenderPipeline {
        const useTexture = (sampledMask & 1) !== 0;
        const isRHWVertex = (vertexType & D3DFVF_XYZRHW) !== 0;
        const hasDiffuse = (vertexType & D3DFVF_DIFFUSE) !== 0;

        const isUIType = isRHWVertex && !useTexture && hasDiffuse && (
            primitiveType === D3DPT_TRIANGLEFAN || primitiveType === D3DPT_TRIANGLESTRIP
        );
        let cullMode: GPUCullMode = "none";
        if (!isUIType && !this.debugFlags.forceCullNone) {
            if (isRHWVertex) {
                // XYZRHW is culled the SAME as non-RHW. The old
                // CW<->CCW swap (intended to compensate the converter's screen->NDC Y-flip)
                // was inverted and culled the visible FRONT faces — the car/garage rendered
                // see-through. Verified live via forceCullNone. Non-RHW draws use the
                // mvp path, so they never exercised this branch. frontFace stays "cw".
                if (d3dCull === D3DCULL_CW) cullMode = "front";
                else if (d3dCull === D3DCULL_CCW) cullMode = "back";
            } else {
                if (d3dCull === D3DCULL_CW) cullMode = "front";
                else if (d3dCull === D3DCULL_CCW) cullMode = "back";
            }
        }

        let topology: GPUPrimitiveTopology = "triangle-list";
        if (primitiveType === D3DPT_POINTLIST) topology = "point-list";
        else if (primitiveType === D3DPT_LINELIST) topology = "line-list";
        else if (primitiveType === D3DPT_LINESTRIP) topology = "line-strip";
        else if (primitiveType === D3DPT_TRIANGLESTRIP) topology = "triangle-strip";

        const shouldEnableBlending = this.debugFlags.forceDisableAlphaBlend ? false : effectiveAlphaBlend !== 0;

        if ((globalThis as any).__ddrawVerboseDiag === true && (!(this as any)._blendDiagDone || ((this as any)._blendDiagN ?? 0) < 10)) {
            (this as any)._blendDiagN = ((this as any)._blendDiagN ?? 0) + 1;
            (this as any)._blendDiagDone = ((this as any)._blendDiagN ?? 0) >= 10;
            Logger.log(LogCategory.DDRAW,
                `[blend-diag MegaBatch#${(this as any)._blendDiagN}] shouldEnableBlending=${shouldEnableBlending} ` +
                `effectiveAlphaBlend=${effectiveAlphaBlend} src=${srcBlend} dst=${dstBlend} ` +
                `alphaTest=${alphaTest} alphaFunc=${alphaFunc} ` +
                `useTexture=${useTexture} colorKeyEnabled=${colorKeyEnabled}`);
        }

        // Use MegaBatch shader (storage buffer + instance_index)
        const shaderConfig: ShaderConfig = {
            sampledMask,
            stageCount,
            pointSampleMask,
            flatShading,
            alphaTestEnabled: this.debugFlags.forceDisableAlphaTest ? false : alphaTest !== 0,
            alphaFunc,
            shouldEnableBlending,
            missingTexture,
            colorKeyEnabled: colorKeyEnabled > 0,
            colorKey: null,
            debugFlags: this.debugFlags,
            needsUVFlip,
            useMegaBatch: true,
        };
        const shader = this.shaderGenerator.getOrCreateMegaBatchShader(shaderConfig);

        const effectiveSrcBlend = srcBlend || 2;
        const effectiveDstBlend = dstBlend || 1;
        const blendState: GPUBlendState | undefined = shouldEnableBlending
            ? {
                  color: {
                      srcFactor: mapBlendFactor(effectiveSrcBlend),
                      dstFactor: mapBlendFactor(effectiveDstBlend),
                      operation: "add" as GPUBlendOperation,
                  },
                  alpha: {
                      srcFactor: mapBlendFactor(effectiveSrcBlend),
                      dstFactor: mapBlendFactor(effectiveDstBlend),
                      operation: "add" as GPUBlendOperation,
                  },
              }
            : undefined;

        // Use MegaBatch pipeline layout (storage buffer at binding 0)
        const pipelineLayout = this.bindGroupManager.createMegaBatchPipelineLayout(sampledMask);

        return this.device.createRenderPipeline({
            layout: pipelineLayout,
            multisample: { count: this.sampleCount },
            vertex: {
                module: shader,
                entryPoint: "vs_main",
                buffers: [
                    {
                        arrayStride: 64,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x4" },  // position
                            { shaderLocation: 1, offset: 16, format: "float32x3" }, // normal
                            { shaderLocation: 2, offset: 28, format: "unorm8x4" },  // diffuse
                            { shaderLocation: 3, offset: 32, format: "unorm8x4" },  // specular
                            { shaderLocation: 4, offset: 36, format: "float32x2" },  // UV0
                            { shaderLocation: 5, offset: 44, format: "float32x2" },  // UV1
                            { shaderLocation: 6, offset: 52, format: "float32x2" },  // UV2
                        ],
                    },
                ],
            },
            fragment: {
                module: shader,
                entryPoint: "fs_main",
                targets: [
                    {
                        format: this.colorFormat,
                        blend: blendState,
                    },
                ],
            },
            primitive: {
                topology,
                cullMode,
                frontFace: "cw",
                // WebGPU requires stripIndexFormat for strip topologies used with indexed draws
                ...(topology === "triangle-strip" || topology === "line-strip"
                    ? { stripIndexFormat: "uint16" as GPUIndexFormat }
                    : {}),
            },
            depthStencil: {
                format: "depth24plus-stencil8",
                depthWriteEnabled: (zEnable !== 0 && !this.debugFlags.forceDisableZTest && !this.debugFlags.forceDisableZWrite) && (zWrite !== 0),
                depthCompare:
                    (zEnable !== 0 && !this.debugFlags.forceDisableZTest)
                        ? mapDepthCompareFunction(zFunc)
                        : "always",
                // Coplanar overlay pass (see effectiveZFunc): nudge it toward the camera so it
                // survives the depth compare. The SLOPE term carries grazing-angle surfaces,
                // where dz/dx across a pixel dwarfs any constant. Keyed on coplanarPass, never
                // on writes-off alone — every blended particle and HUD quad is writes-off, and
                // biasing those would pull them through geometry that occludes them. A
                // game-supplied ZBIAS still wins.
                depthBias: (zEnable !== 0 && zBias > 0) ? -zBias * 4 : (coplanarPass !== 0 ? -1 : 0),
                depthBiasSlopeScale: (zEnable !== 0 && zBias > 0) || coplanarPass !== 0 ? -1.0 : 0,
                depthBiasClamp: 0,
                stencilFront: stencilEnable !== 0 ? {
                    compare: mapDepthCompareFunction(stencilFunc),
                    failOp: mapStencilOperation(stencilFail),
                    depthFailOp: mapStencilOperation(stencilZFail),
                    passOp: mapStencilOperation(stencilPass),
                } : { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
                stencilBack: stencilEnable !== 0 ? {
                    compare: mapDepthCompareFunction(stencilFunc),
                    failOp: mapStencilOperation(stencilFail),
                    depthFailOp: mapStencilOperation(stencilZFail),
                    passOp: mapStencilOperation(stencilPass),
                } : { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
                stencilReadMask: stencilMask,
                stencilWriteMask: stencilEnable !== 0 ? stencilWriteMask : 0,
            },
        });
    }

    private createPipeline(
        vertexType: number,
        primitiveType: number,
        sampledMask: number,
        stageCount: number,
        pointSampleMask: number,
        missingTexture: boolean,
        d3dCull: number,
        zEnable: number,
        zFunc: number,
        zWrite: number,
        zBias: number, // D3DRENDERSTATE_ZBIAS (0-16) for z-fighting prevention
        coplanarPass: number, // draw asked for EQUAL with depth writes off
        effectiveAlphaBlend: number, // Already normalized (0 or 1)
        alphaTest: number,
        srcBlend: number,
        dstBlend: number,
        alphaFunc: number,
        colorKeyEnabled: number,
        stencilEnable: number,
        stencilFunc: number,
        stencilFail: number,
        stencilZFail: number,
        stencilPass: number,
        stencilRef: number,
        stencilMask: number,
        stencilWriteMask: number,
        needsUVFlip: boolean,
        flatShading: boolean
    ): GPURenderPipeline {
        const useTexture = (sampledMask & 1) !== 0;
        const isRHWVertex = (vertexType & D3DFVF_XYZRHW) !== 0;
        const hasDiffuse = (vertexType & D3DFVF_DIFFUSE) !== 0;

        // Determine cull mode
        // D3D7 uses CW (clockwise) as front face. We set frontFace="cw" to match D3D convention.
        // D3DCULL_NONE (1) = no culling -> cullMode "none"
        // D3DCULL_CW (2) = cull CW faces (front faces in D3D) -> cullMode "front"
        // D3DCULL_CCW (3) = cull CCW faces (back faces in D3D) -> cullMode "back"
        // If d3dCull is 0 (uninitialized), default to "none" (no culling)
        // UI detection: XYZRHW (pre-transformed) + no texture + diffuse only + fan/strip
        // This is more precise than just checking primitive type - avoids disabling culling for 3D geometry
        const isUIType = isRHWVertex && !useTexture && hasDiffuse && (
            primitiveType === D3DPT_TRIANGLEFAN || primitiveType === D3DPT_TRIANGLESTRIP
        );
        let cullMode: GPUCullMode = "none";
        if (!isUIType && !this.debugFlags.forceCullNone) {
            if (isRHWVertex) {
                // XYZRHW is culled the SAME as non-RHW. The old
                // CW<->CCW swap (intended to compensate the converter's screen->NDC Y-flip)
                // was inverted and culled the visible FRONT faces — the car/garage rendered
                // see-through. Verified live via forceCullNone. Non-RHW draws use the
                // mvp path, so they never exercised this branch. frontFace stays "cw".
                if (d3dCull === D3DCULL_CW) cullMode = "front";
                else if (d3dCull === D3DCULL_CCW) cullMode = "back";
            } else {
                if (d3dCull === D3DCULL_CW) cullMode = "front"; // Cull front faces (CW in D3D)
                else if (d3dCull === D3DCULL_CCW) cullMode = "back"; // Cull back faces (CCW in D3D)
            }
            // D3DCULL_NONE (1) or 0 (uninitialized) -> cullMode "none" (already set)
        }

        let topology: GPUPrimitiveTopology = "triangle-list";
        if (primitiveType === D3DPT_POINTLIST) topology = "point-list";
        else if (primitiveType === D3DPT_LINELIST) topology = "line-list";
        else if (primitiveType === D3DPT_LINESTRIP) topology = "line-strip";
        else if (primitiveType === D3DPT_TRIANGLESTRIP) topology = "triangle-strip";
        // D3DPT_TRIANGLEFAN is not directly supported in WebGPU, will fall back to triangle-list

        // Note: XYZ vertex format requires MVP matrix for proper transformation.
        // This warning is informational - MVP matrix is checked at draw time in prepareDraw().
        // Pipeline is cached, so this may appear even when MVP is provided later.
        const isXYZ = (vertexType & D3DFVF_XYZ) !== 0 && (vertexType & D3DFVF_XYZRHW) === 0;
        if (isXYZ && !this.warnedXYZNoMVP) {
            this.warnedXYZNoMVP = true;
            Logger.verbose(
                LogCategory.SYSTEM,
                "PipelineFactory: Created pipeline for XYZ vertex format (MVP matrix checked at draw time)"
            );
        }

        const shouldEnableBlending = this.debugFlags.forceDisableAlphaBlend ? false : effectiveAlphaBlend !== 0;

        const shaderConfig: ShaderConfig = {
            sampledMask,
            stageCount,
            pointSampleMask,
            flatShading,
            alphaTestEnabled: this.debugFlags.forceDisableAlphaTest ? false : alphaTest !== 0,
            alphaFunc,
            shouldEnableBlending,
            missingTexture,
            colorKeyEnabled: colorKeyEnabled > 0,
            colorKey: null,
            debugFlags: this.debugFlags,
            needsUVFlip,
        };
        const shader = this.shaderGenerator.getOrCreateShader(shaderConfig);

        const effectiveSrcBlend = srcBlend || 2; // D3D7 default: ONE
        const effectiveDstBlend = dstBlend || 1; // D3D7 default: ZERO
        const blendState: GPUBlendState | undefined = shouldEnableBlending
            ? {
                  color: {
                      srcFactor: mapBlendFactor(effectiveSrcBlend),
                      dstFactor: mapBlendFactor(effectiveDstBlend),
                      operation: "add" as GPUBlendOperation,
                  },
                  alpha: {
                      srcFactor: mapBlendFactor(effectiveSrcBlend),
                      dstFactor: mapBlendFactor(effectiveDstBlend),
                      operation: "add" as GPUBlendOperation,
                  },
              }
            : undefined;

        // Diagnostic: Log shadow-style blending (ZERO/INVSRCCOLOR for multiplicative darkening)
        if (shouldEnableBlending && effectiveSrcBlend === 1 && effectiveDstBlend === 4) {
            Logger.log(LogCategory.DDRAW,
                `PipelineFactory: Shadow blend mode (ZERO/INVSRCCOLOR) - tex=${useTexture} cull=${cullMode} zWrite=${zWrite !== 0}`);
        }

        // Get pipeline layout for the sampled-stage mask
        const pipelineLayout = this.bindGroupManager.createPipelineLayout(sampledMask);

        // Create pipeline
        return this.device.createRenderPipeline({
            layout: pipelineLayout,
            multisample: { count: this.sampleCount },
            vertex: {
                module: shader,
                entryPoint: "vs_main",
                buffers: [
                    {
                        arrayStride: 64,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x4" },  // position
                            { shaderLocation: 1, offset: 16, format: "float32x3" }, // normal
                            { shaderLocation: 2, offset: 28, format: "unorm8x4" },  // diffuse (BGRA, swizzled in VS)
                            { shaderLocation: 3, offset: 32, format: "unorm8x4" },  // specular (BGRA, swizzled in VS)
                            { shaderLocation: 4, offset: 36, format: "float32x2" },  // UV0
                            { shaderLocation: 5, offset: 44, format: "float32x2" },  // UV1
                            { shaderLocation: 6, offset: 52, format: "float32x2" },  // UV2
                        ],
                    },
                ],
            },
            fragment: {
                module: shader,
                entryPoint: "fs_main",
                targets: [
                    {
                        format: this.colorFormat, // The render target's own format (see colorFormat)
                        blend: blendState,
                    },
                ],
            },
            primitive: {
                topology,
                cullMode,
                frontFace: "cw", // Match D3D: CW = front (avoids "inside out" with D3D-style models)
                // WebGPU requires stripIndexFormat for strip topologies used with indexed draws
                ...(topology === "triangle-strip" || topology === "line-strip"
                    ? { stripIndexFormat: "uint16" as GPUIndexFormat }
                    : {}),
            },
            depthStencil: {
                format: "depth24plus-stencil8",
                // Enable depth test/write for both XYZ and XYZRHW when app sets Z (RHW vertices pass depth 0..1 in pos.z)
                depthWriteEnabled: (zEnable !== 0 && !this.debugFlags.forceDisableZTest && !this.debugFlags.forceDisableZWrite) && (zWrite !== 0),
                depthCompare:
                    (zEnable !== 0 && !this.debugFlags.forceDisableZTest)
                        ? mapDepthCompareFunction(zFunc)
                        : "always",
                // D3DRENDERSTATE_ZBIAS: 0-16, used to reduce z-fighting for coplanar polygons
                // Negative depthBias pushes geometry toward camera (smaller Z values)
                // D3D ZBIAS is integer 0-16; we scale it appropriately for 24-bit depth buffer
                // Each unit of D3D ZBIAS approximately corresponds to 1/65536 of depth range
                // Coplanar overlay pass (see effectiveZFunc): nudge it toward the camera so it
                // survives the depth compare. The SLOPE term carries grazing-angle surfaces,
                // where dz/dx across a pixel dwarfs any constant. Keyed on coplanarPass, never
                // on writes-off alone — every blended particle and HUD quad is writes-off, and
                // biasing those would pull them through geometry that occludes them. A
                // game-supplied ZBIAS still wins.
                depthBias: (zEnable !== 0 && zBias > 0) ? -zBias * 4 : (coplanarPass !== 0 ? -1 : 0),
                depthBiasSlopeScale: (zEnable !== 0 && zBias > 0) || coplanarPass !== 0 ? -1.0 : 0,
                depthBiasClamp: 0,
                stencilFront: stencilEnable !== 0 ? {
                    compare: mapDepthCompareFunction(stencilFunc),
                    failOp: mapStencilOperation(stencilFail),
                    depthFailOp: mapStencilOperation(stencilZFail),
                    passOp: mapStencilOperation(stencilPass),
                } : { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
                stencilBack: stencilEnable !== 0 ? {
                    compare: mapDepthCompareFunction(stencilFunc),
                    failOp: mapStencilOperation(stencilFail),
                    depthFailOp: mapStencilOperation(stencilZFail),
                    passOp: mapStencilOperation(stencilPass),
                } : { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
                stencilReadMask: stencilMask,
                stencilWriteMask: stencilEnable !== 0 ? stencilWriteMask : 0,
            },
        });
    }
}
