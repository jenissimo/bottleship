/**
 * DirectDraw WebGPU Backend Executor
 *
 * Coordinates GPU rendering operations for DirectDraw/Direct3D7 emulation.
 * Uses modular components for ring buffers, pipelines, shaders, and sync.
 */

import { WebGPUBackend } from "../webgpu-backend";
import { pixelCenterOffsetPx } from '../pixel-center';
import { DirectDrawSurfaceState, DirectDrawSurfaceObject, RenderSurface, isBitmapTexture, isRenderSurface } from "../../../modules/ddraw/com-objects";
import { MEM_SURFACE_BASE, MEM_SURFACE_SIZE } from "../../../core/cpu/emulator-config";
import { Logger, LogCategory, LogLevel } from "../../../core/logger";
import { profiler } from "../../../core/profiler";
import { System } from "../../../core/system";
import { frameProfiler } from "../../../core/frame-profiler";
import { recordGpuError } from "../../../core/gpu-error-log";
import { registerGpuDeviceObserver } from "../../../core/gpu/gpu-device-lifecycle";
import { drawCostProfiler, DC } from "./draw-cost-profiler";
import {
    createGPUTexture,
    decodeColorKeyToRGBA,
    detectPixelFormat,
    PixelFormat,
    quantizeColorKey,
    uploadToGPUTexture,
    applyColorKeyToRGBA,
    colorKeyChanged,
} from "../../../modules/ddraw/gpu-texture-utils";
import {
    decodeSurfaceFormatToRgba8,
    getSurfaceFormatLayout,
} from "../shared/texture-formats";
import { fixupBoth } from "../shared/d3d-blend-factor";
import {
    markGpuSyncedFromCpu,
    setAuthorityCpu,
    setAuthorityGpu,
    surfaceSyncManager,
    needsRenderTargetUploadBeforeDraw,
    logSurfaceState,
} from "../../../modules/ddraw/surface-sync";
import { pumpReadbackPrefetch, prefetchAfterFlip } from "../../../modules/ddraw/surface-readback-prefetch";
import type { LockRect } from "../../../modules/ddraw/lock-flags";
// Side-effect import: registers the surface-side device-loss observer. Loaded here because
// every ddraw AND d3d8 path goes through this executor, so no consumer can miss it.
import "../../../modules/ddraw/surface-device-loss";
import { isValidAddress } from "../../../modules/ddraw/helpers";
import * as frameCapture from "../../../modules/ddraw/frame-capture";
import {
    D3DRENDERSTATE_ALPHAREF,
    D3DRENDERSTATE_ALPHABLENDENABLE,
    D3DRENDERSTATE_SRCBLEND,
    D3DRENDERSTATE_DESTBLEND,
    D3DBLEND_ONE,
    D3DBLEND_INVSRCALPHA,
    D3DRENDERSTATE_LIGHTING,
    D3DRENDERSTATE_CLIPPLANEENABLE,
    D3DRENDERSTATE_COLORVERTEX,
    D3DRENDERSTATE_LOCALVIEWER,
    D3DRENDERSTATE_AMBIENT,
    D3DRENDERSTATE_COLORKEYENABLE,
    D3DRENDERSTATE_FOGENABLE,
    D3DRENDERSTATE_FOGCOLOR,
    D3DRENDERSTATE_FOGTABLEMODE,
    D3DRENDERSTATE_FOGVERTEXMODE,
    D3DRENDERSTATE_FOGSTART,
    D3DRENDERSTATE_FOGEND,
    D3DRENDERSTATE_FOGDENSITY,
    D3DRENDERSTATE_SPECULARENABLE,
    D3DFOG_NONE,
    D3DPT_POINTLIST,
    D3DPT_TRIANGLESTRIP,
    D3DPT_TRIANGLELIST,
    D3DPT_TRIANGLEFAN,
    D3DCULL_CW,
    D3DRENDERSTATE_POINTSIZE,
    D3DRENDERSTATE_POINTSIZE_MIN,
    D3DRENDERSTATE_POINTSIZE_MAX,
    D3DRENDERSTATE_POINTSPRITEENABLE,
    D3DRENDERSTATE_POINTSCALEENABLE,
    D3DRENDERSTATE_POINTSCALE_A,
    D3DRENDERSTATE_POINTSCALE_B,
    D3DRENDERSTATE_POINTSCALE_C,
    D3DFVF_XYZ,
    D3DFVF_XYZRHW,
    D3DFVF_XYZW,
    D3DFVF_POSITION_MASK,
    D3DFVF_NORMAL,
    D3DFVF_PSIZE,
    D3DFVF_DIFFUSE,
    D3DFVF_SPECULAR,
    D3DFVF_TEX1,
    D3DTSS_COLOROP,
    D3DTSS_COLORARG1,
    D3DTSS_COLORARG2,
    D3DTSS_ALPHAOP,
    D3DTSS_MINFILTER,
    D3DTSS_MAGFILTER,
    D3DTSS_MIPFILTER,
    D3DTSS_MAXANISOTROPY,
    D3DTSS_TEXCOORDINDEX,
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTADDRESS_WRAP,
    D3DTADDRESS_CLAMP,
    D3DTFN_POINT,
    D3DTFN_LINEAR,
    D3DTFG_POINT,
    D3DTFG_LINEAR,
    D3DTFP_NONE,
    D3DTOP_DISABLE,
    D3DTOP_SELECTARG1,
    D3DTOP_SELECTARG2,
    D3DTOP_MODULATE,
    D3DTA_SELECTMASK,
    D3DTA_TEXTURE,
    D3DTA_DIFFUSE,
    D3DTA_TFACTOR,
    D3DCLEAR_ZBUFFER,
    D3DCLEAR_STENCIL,
    D3DRENDERSTATE_ZENABLE,
    D3DRENDERSTATE_ZWRITEENABLE,
    D3DRENDERSTATE_ZBIAS,
    D3DRENDERSTATE_TEXTUREFACTOR,
    D3DCLEAR_TARGET,
    D3DRENDERSTATE_ALPHATESTENABLE,
    D3DRENDERSTATE_ALPHAFUNC,
    D3DRENDERSTATE_CULLMODE,
    DDSCAPS_ZBUFFER,
    DDSCAPS_TEXTURE,
    DDSCAPS_MIPMAP,
    DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_3DDEVICE,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_BACKBUFFER,
    D3DTSS_ALPHAARG1,
    D3DTSS_ALPHAARG2,
    D3DTSS_TEXTURETRANSFORMFLAGS,
    D3DTTFF_COUNT2,
    D3DTA_CURRENT,
    D3DRENDERSTATE_STENCILREF,
} from "../../../modules/ddraw/constants";

// Modular components
import {
    DebugFlags,
    DEFAULT_DEBUG_FLAGS,
    DEFAULT_UNIFORM_BUFFER_CONFIG,
    DEFAULT_STORAGE_BUFFER_CONFIG,
    PrepareDrawResult,
    DrawExecutionDiagnostics,
    Viewport,
    sanitizeViewport,
    ClearConfig,
    MegaBatch,
    MegaBatchDraw,
    DrawUniformsAllocation,
} from "./types";
import { RHW_PRETRANSFORMED, RHW_DEPTH_CLAMP } from "./types";
import { RingBufferManager } from "./ring-buffer-manager";
import { BindGroupManager, FFP_CLIP_PLANES_BYTES } from "./bind-group-manager";
import { DepthManager } from "./depth-manager";
import { MipGenerator, mipLevelCountFor } from "./mip-generator";
import { EmulatorConfig } from "../../../core/emulator-config-manager";
import { ShaderGenerator } from "./shader-generator";
import { PipelineFactory } from "./pipeline-factory";
import { ClearPipeline } from "./clear-pipeline";
import { MsaaColorManager } from "./msaa-color-manager";
import { ColorKeyBlitPipeline } from "./colorkey-blit-pipeline";
import { VertexConverter, GPU_VERTEX_THRESHOLD, GpuVertexConversionResult, computeFvfStride, OUTPUT_VERTEX_BYTES, OUTPUT_VERTEX_U32S } from "./compute/vertex-converter";
import type { VertexBlendInput } from "./compute/vertex-converter";
import { TextureConverter, applyTextureConverterDebugPaintCPU } from "../shared/texture-converter";
import { FFPLightingState } from "../../../modules/ddraw/d3d/ffp-lighting";
import { createDefaultMaterial } from "../../../modules/ddraw/d3d/types";

const UNIFORM_SLOT_SIZE = DEFAULT_UNIFORM_BUFFER_CONFIG.slotSize;

import { toPlainGuestMemory } from "../../../core/memory/guest-memory";
import { sanitizeViewportInto, type SanitizedViewport } from "./types";
import { dwordToFloat } from './dword-float';
import { dwordToUnsignedLong } from '../shared/dword';
import { resolveFfpFogMode } from '../d3d9/ffp-fog';
import { maybeClampContainedUv, applySamplerDebugOverrides, updateLastDrawDiagnostics } from './executor-draw-debug';
import { normalizePortableWebGpuSampleCount } from '../shared/msaa-policy';
import { registerBackendQualitySupport } from '../shared/quality-capabilities';
import {
    FfpStagesState,
    type FfpFilterVocabulary,
    MAX_FFP_STAGES,
    MAX_FFP_SAMPLED_STAGES,
    MAX_FFP_TEX_MATRICES,
    MAX_FFP_UV_SETS,
    StageSamplerState,
} from './ffp-stages';

/**
 * "Have this surface's PIXELS changed?" — one definition, so the batch-compatibility check and
 * the early-submit gate can never disagree about what counts as a change. A render surface
 * carries `version`; a bitmap texture carries `contentVersion`, bumped wherever the guest
 * rewrites its backing (CopyRects, Unlock, palette re-bake). It is optional, so read it through
 * `?? 0` — comparing against `undefined` would report a change on every first draw.
 */
function surfaceContentVersion(tex: DirectDrawSurfaceState): number {
    return isRenderSurface(tex) ? tex.version : (tex.contentVersion ?? 0);
}

/** D3DTSS_TCI_* (d3d8types.h/d3d9types.h): the texgen mode occupies the high half of
 *  D3DTSS_TEXCOORDINDEX. SPHEREMAP (0x40000, D3D9-only) is deliberately absent — the
 *  shader generates only these three. */
const D3DTSS_TCI_CAMERASPACENORMAL = 0x10000;
const D3DTSS_TCI_CAMERASPACEPOSITION = 0x20000;
const D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR = 0x30000;

/** Lanes per stage in the sampler-identity scratch below. */
export const STAGE_SAMPLER_KEY_LANES = 4;

/**
 * Write one stage's sampler identity for the bind-group fast paths. EVERY field
 * getOrCreateStageSampler forwards takes part, or a draw that changes only LOD bias / max mip
 * level / border colour reuses the previous bind group. Lanes rather than one packed word
 * because three of the fields are raw DWORDs: a hash would let two distinct samplers collide
 * on one key, which is the failure this exists to prevent. Lane 0 is -1 for an unsampled stage.
 */
export function writeStageSamplerKey(out: Int32Array, stage: number, sp: StageSamplerState | null): void {
    const base = stage * STAGE_SAMPLER_KEY_LANES;
    if (!sp) {
        out[base] = -1;
        out[base + 1] = 0;
        out[base + 2] = 0;
        out[base + 3] = 0;
        return;
    }
    out[base] = (sp.minFilter & 0x3) | ((sp.magFilter & 0x3) << 2) | ((sp.mipFilter & 0x3) << 4) |
        ((sp.addressU & 0x7) << 6) | ((sp.addressV & 0x7) << 9) |
        ((Math.min(15, sp.maxAnisotropy) & 0xF) << 12);
    out[base + 1] = (sp.mipLodBiasBits ?? 0) | 0;
    out[base + 2] = (sp.maxMipLevel ?? 0) | 0;
    out[base + 3] = (sp.borderColor ?? 0) | 0;
}

function createDefaultStageSamplers(): StageSamplerState[] {
    const samplers: StageSamplerState[] = [];
    for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
        samplers.push({
            minFilter: 0,
            magFilter: 0,
            mipFilter: D3DTFP_NONE,
            maxAnisotropy: 1,
            addressU: D3DTADDRESS_WRAP,
            addressV: D3DTADDRESS_WRAP,
        });
    }
    return samplers;
}

/**
 * Raw draw inputs handed to a `drawObserver` (harness fade-quad probe) at the top
 * of every FFP draw, BEFORE any GPU work. The observer inspects the bound texture +
 * render/texture states and returns `true` to SUPPRESS the draw — the A/B lever for
 * "is this the quad covering the frame?". It reads the
 * same DirectDrawSurfaceState shape D3D8 and DDraw both use.
 */
export interface DrawObservation {
    indexed: boolean;
    primitiveType: number;
    vertexType: number;
    vertexCount: number;
    verticesAddr: number;
    target: DirectDrawSurfaceState;
    texture: DirectDrawSurfaceState | null;
    stageTextures: readonly (DirectDrawSurfaceState | null)[] | null;
    renderStates: Int32Array;
    textureStates: Int32Array;
    memory: Uint8Array;
}

/**
 * Resolve an effective FFP material colour source for a draw, mirroring D3D9's
 * effectiveColorSource: with D3DRS_COLORVERTEX off every source collapses to MATERIAL(0),
 * and a source naming a vertex colour the FVF lacks (COLOR1 without diffuse, COLOR2 without
 * specular) also falls back to MATERIAL. Generic FFP fix — keeps the shader's select() honest
 * for all D3D8/DDraw titles without needing the FVF inside the shader. Zero-alloc (module scope).
 */
function resolveFfpColorSource(src: number, colorVertex: boolean, hasDiffuse: boolean, hasSpecular: boolean): number {
    if (!colorVertex) return 0;                  // D3DMCS_MATERIAL
    if (src === 1 && !hasDiffuse) return 0;      // COLOR1 requested but no vertex diffuse
    if (src === 2 && !hasSpecular) return 0;     // COLOR2 requested but no vertex specular
    return src;
}

// Point-sprite quad corners (screen-space signs + generated sprite UVs), and the two
// index orders for the 2-triangle quad. Module-level (not per-draw) to keep the hot path
// zero-alloc. Corner layout: 0=TL 1=TR 2=BL 3=BR. sx/sy are screen-space signs
// (sx: +right, sy: +down); the expansion converts them to clip-space offsets.
const PS_CORNER_SX = [-1, 1, -1, 1] as const;
const PS_CORNER_SY = [-1, -1, 1, 1] as const;
const PS_CORNER_U = [0, 1, 0, 1] as const;
const PS_CORNER_V = [0, 0, 1, 1] as const;
// CW winding in the WebGPU framebuffer (front face, frontFace="cw"): TL,TR,BR / TL,BR,BL.
const PS_ORDER_CW = [0, 1, 3, 0, 3, 2] as const;
// Reversed winding — used only when the game's D3DRS_CULLMODE would cull the CW (front)
// face, so point sprites stay visible under ANY cull mode (D3D never back-face-culls points).
const PS_ORDER_CCW = [0, 3, 1, 0, 2, 3] as const;

/** Cap on the blank-check scan; textures above it are sampled with a stride. */
const BLANK_SCAN_BUDGET = 256 * 1024;

/**
 * True while a surface's pixel memory is still entirely zero — nothing has written it
 * since CreateSurface handed out zeroed pages. The direct measurement behind the
 * "defer an empty texture" decision, which the mediated-write flags can only guess at.
 */
function surfacePixelsAreBlank(state: DirectDrawSurfaceState): boolean {
    const mem = System.getInstance().process?.getCurrentMemory();
    if (!mem || !state.surfacePtr || state.width <= 0 || state.height <= 0) return true;
    const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
    const rowBytes = state.width * bytesPerPixel;
    const pitch = state.pitch && state.pitch >= rowBytes ? state.pitch : rowBytes;
    const bytes = Math.min(pitch * state.height, mem.length - state.surfacePtr);
    if (bytes <= 0) return true;
    const stride = bytes > BLANK_SCAN_BUDGET ? Math.ceil(bytes / BLANK_SCAN_BUDGET) : 1;
    for (let i = 0; i < bytes; i += stride) {
        if (mem[state.surfacePtr + i] !== 0) return false;
    }
    return true;
}

/**
 * Main executor class for DirectDraw WebGPU rendering
 */
export class DDrawWebGPUExecutor {
    private device!: GPUDevice;
    private queue!: GPUQueue;
    private swapChainFormat!: GPUTextureFormat;

    // Modular components
    /** @internal — exposed for D3D8 single-submit present path */
    ringBufferManager!: RingBufferManager;
    private bindGroupManager!: BindGroupManager;
    private depthManager!: DepthManager;
    private shaderGenerator!: ShaderGenerator;
    private pipelineFactory!: PipelineFactory;
    private clearPipeline!: ClearPipeline;
    // Per-surface multisample COLOR texture manager (quality.msaa override). No-op when msaa===1.
    private msaaColorManager!: MsaaColorManager;
    private colorKeyBlitPipeline!: ColorKeyBlitPipeline;
    private vertexConverter!: VertexConverter;
    private textureConverter!: TextureConverter;

    // Debug flags
    private debugFlags: DebugFlags = { ...DEFAULT_DEBUG_FLAGS };

    // Dummy texture for SetTexture(NULL) fallback
    private dummyTexture: GPUTexture | null = null;
    private dummyTextureView: GPUTextureView | null = null;
    // Auto-mipmap: lazily-created mip-chain generator (used only when quality.autoMipmap is on).
    private mipGenerator: MipGenerator | null = null;

    // Effective MSAA sample count currently pushed into the color/depth/pipeline/clear consumers.
    // -1 forces the first application. All four MUST carry the same sampleCount for a whole frame
    // or a render pass' color/depth/pipeline sampleCount mismatch = WebGPU validation error = black
    // screen. The count is applied ATOMICALLY at a frame boundary
    // (applyMsaaAtFrameBoundary), never mid-frame, so a live msaa 1→4 toggle takes effect at the
    // start of the NEXT frame and no straddling frame ever mixes sample counts.
    private lastAppliedMsaa = -1;

    // Guest-requested MSAA from the D3D8 present-params MultiSampleType (1 = NONE; 4 supported).
    // Folded into the effective count so a game enabling its in-engine 4× AA gets it even when
    // quality.msaa is 1. Default 1 keeps the guest-NONE path byte-identical to the pre-MSAA path.
    private guestRequestedMsaa = 1;

    /**
     * Record the guest's requested MSAA (D3D8 CreateDevice/Reset present-params MultiSampleType,
     * mapped to a sample count: NONE/unsupported→1, 4_SAMPLES→4). Device-global — folded into
     * the effective count at the next frame boundary. Does NOT change the count mid-frame.
     */
    setGuestRequestedMsaa(count: number): void {
        this.guestRequestedMsaa = normalizePortableWebGpuSampleCount(count);
    }

    /** Effective sample count for the frame = max(quality.msaa, guest-requested), clamped {1,4}. */
    private effectiveMsaa(): number {
        const q = EmulatorConfig.getInstance().quality.msaa | 0;
        const g = this.guestRequestedMsaa | 0;
        return normalizePortableWebGpuSampleCount(q >= g ? q : g);
    }

    /**
     * Apply the effective MSAA sample count to all four consumers (color/depth/pipeline/clear)
     * ATOMICALLY. Only ever mutates the count at a frame boundary — no command encoder, render
     * pass, or pending batch in flight — so within any single frame the color attachment, depth
     * attachment, and every pipeline used carry the SAME sampleCount (a straddling live toggle
     * can never leave a RenderPassEncoder@1 / RenderPipeline@4 mismatch). Called from the frame-end
     * chokepoints (endFrame / endFrameForPresent / postSubmitCleanup) and lazily once on first use.
     * Each setSampleCount early-returns when unchanged, so quality.msaa=1 + guest-NONE is a no-op
     * (byte-identical to the pre-MSAA path).
     */
    private applyMsaaAtFrameBoundary(): void {
        const m = this.effectiveMsaa();
        if (m === this.lastAppliedMsaa) return;
        // Never swap sample counts mid-frame; defer to the next boundary if anything is in flight.
        if (this.currentEncoder || this.currentRenderPass || this.currentBatch) return;
        this.lastAppliedMsaa = m;
        this.msaaColorManager.setSampleCount(m);
        this.depthManager.setSampleCount(m);
        this.pipelineFactory.setSampleCount(m);
        this.clearPipeline.setSampleCount(m);
    }

    /**
     * Frame-internal guard used by clear()/ensureRenderPass(): the sample count is owned by the
     * frame boundary (applyMsaaAtFrameBoundary), so within a frame this performs only the one-time
     * bootstrap before the very first pass (lastAppliedMsaa === -1, nothing in flight yet). It NEVER
     * changes the count mid-frame — a live toggle is picked up at the next frame boundary.
     */
    private syncMsaaSampleCount(): void {
        if (this.lastAppliedMsaa === -1) this.applyMsaaAtFrameBoundary();
    }
    // All-mips sample views, keyed by the LIVE gpuTexture so they can never dangle to a
    // recreated/destroyed texture (a fresh gpuTexture is a fresh key).
    private sampleViewCache = new WeakMap<GPUTexture, GPUTextureView>();
    private textureUploadDiagCount = 0;
    private textureDrawDiagCount = 0;
    /** Draws whose stage-0 texture was ready but not sampled — see SOLID-FILL-RISK. */
    droppedTextureDraws = 0;
    /** Log-once keys for TEXCOORDINDEX quirks (texgen flags / UV set >2) and stage>=3 use. */
    private loggedTexCoordQuirks = new Set<number>();
    private loggedStage3Plus = false;

    // Command encoder batching
    private currentEncoder: GPUCommandEncoder | null = null;
    private currentRenderPass: GPURenderPassEncoder | null = null;
    private currentRenderTarget: DirectDrawSurfaceState | null = null;
    private lastBindGroup: GPUBindGroup | null = null;
    private lastUniformOffset: number = -1;
    private lastLightsOffset: number = -1;

    private surfacesNeedingClear: Set<DirectDrawSurfaceState> = new Set();

    // Scratch buffer for vertex/index conversion
    private scratchBuffer: Uint8Array | null = null;
    private scratchBufferSize = 0;
    private scratchF32: Float32Array | null = null;
    private scratchDataView: DataView | null = null;

    // Reusable 1-element view to bit-cast a DWORD render state into its float value
    // (D3DRS_POINTSIZE / *_MIN / *_MAX / *_SCALE_* store floats as DWORDs). Zero-alloc.
    private readonly psBitsU32 = new Uint32Array(1);
    private readonly psBitsF32 = new Float32Array(this.psBitsU32.buffer);

    // Cached ddraw module reference (avoids System.getInstance() per draw)
    private cachedDDrawModule: any = null;
    private cachedDDrawModuleResolved = false;

    // Diagnostics
    private drawSkipNoTargetCount = 0;
    private warnedXYZNoMVP = false;
    private loggedXYZMVP = false;
    private debugRhwLogCount = 0;
    private debugRhwConvertLogCount = 0;
    private debugColorkeyLogCount = 0;
    private warnedMissingGpuFormat = new Set<number>();

    // Reused capture diagnostics for the most recently prepared draw.
    private readonly lastDrawDiagnostics: DrawExecutionDiagnostics = {
        valid: false,
        useTexture: false,
        minFilter: 0,
        magFilter: 0,
        mipFilter: D3DTFP_NONE,
        addressU: D3DTADDRESS_WRAP,
        addressV: D3DTADDRESS_WRAP,
        maxAnisotropy: 1,
        forcePointFilter: false,
    };

    // Per-draw sanitized-viewport scratch. Separate instances because drawPrimitive /
    // drawIndexedPrimitive hold their result across the call into prepareDraw, which
    // sanitizes again — one shared struct would let the inner call clobber the outer.
    private readonly safeVpScratchDraw: SanitizedViewport = { x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1 };
    private readonly safeVpScratchIndexed: SanitizedViewport = { x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1 };
    private readonly safeVpScratchPrepare: SanitizedViewport = { x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1 };
    private readonly safeVpScratchExpand: SanitizedViewport = { x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1 };
    private readonly safeVpScratchPass: SanitizedViewport = { x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1 };
    /** Stand-in when a draw carries no FFP material. Read-only on this path (its components
     *  are copied into the uniform slot), so one shared instance replaces a 5-object
     *  allocation on every unlit draw. */
    private readonly defaultMaterial = createDefaultMaterial();
    // Reusable prepare-draw result (DOD): mutate in prepareDraw, return same ref; no per-draw heap alloc.
    private readonly prepareResult: PrepareDrawResult = {
        uniformOffset: 0,
        lightsOffset: 0,
        drawIndex: 0,
        pipeline: null!,
        sampledMask: 0,
        stageCount: 1,
        stageViews: new Array<GPUTextureView | null>(MAX_FFP_SAMPLED_STAGES).fill(null),
        stageSamplers: createDefaultStageSamplers(),
        stencilRef: 0,
    };

    // Resolved FFP stage cascade for the current draw (reused, zero-alloc).
    private readonly ffpStages = new FfpStagesState();

    /** Which D3DTEXF_* vocabulary this device's TSS filter values are written in.
     *  D3D7 and D3D8 disagree on MIPFILTER's numbering, so the decode is a property of the
     *  API the device was created through, not something to infer from a value. Default stays
     *  D3D7 — a DDraw/D3D7 title that never calls this keeps its existing decode exactly. */
    setFfpFilterVocabulary(vocabulary: FfpFilterVocabulary): void {
        this.ffpStages.setFilterVocabulary(vocabulary);
    }
    // Per-stage batch-compatibility keys for the current draw (reused, zero-alloc).
    private readonly stageVersionsScratch = new Int32Array(MAX_FFP_SAMPLED_STAGES);
    private readonly stageSamplerKeysScratch = new Int32Array(MAX_FFP_SAMPLED_STAGES * STAGE_SAMPLER_KEY_LANES);

    // ===== FFP user clip planes (binding 6) =====
    // Device-global: one persistent 6×vec4f buffer, always bound so every FFP bind group
    // satisfies the layout even when clipping is inert. `packed` holds the current device's
    // plane coefficients (pushed via updateClipPlanes); `uploaded` mirrors what's currently
    // in the GPU buffer so we only re-upload (and flush) when the values actually change.
    private clipPlanesBuffer!: GPUBuffer;
    private readonly clipPlanesPacked = new Float32Array(6 * 4);
    private readonly clipPlanesUploaded = new Float32Array(6 * 4);

    /** No device: every entry point below bails instead of dispatching onto dead handles. */
    private deviceLost = false;

    constructor(private backend: WebGPUBackend) {
        this.buildDeviceResources(backend.getDevice()!, backend.getQueue()!);
        // Debug handle: pure-D3D8 games have no ddraw module context to hang the
        // executor off, so dbg rstats/fstats fall back to this.
        (globalThis as unknown as Record<string, unknown>).__ddrawExecutor = this;

        // This executor also backs D3D8 (D3D8DeviceAdapter.renderer IS this class), so the
        // declaration covers both DirectDraw and D3D8 titles.
        registerBackendQualitySupport("ddraw", ["anisotropy", "forceTrilinear", "autoMipmap", "msaa"]);

        // Every sub-manager below is built FROM the device, so a lost device makes all of
        // them dead references at once — they are rebuilt as a set, never patched.
        registerGpuDeviceObserver("ddraw-executor", {
            onDeviceLost: () => this.onDeviceLost(),
            onDeviceRecreated: (device) => this.onDeviceRecreated(device),
        });
    }

    /** Everything this executor owns that is derived from the device, in one place. */
    private buildDeviceResources(device: GPUDevice, queue: GPUQueue): void {
        this.device = device;
        this.queue = queue;
        // Persistent, zero-initialized clip-plane buffer (matches clipPlanesUploaded = 0).
        this.clipPlanesBuffer = this.device.createBuffer({
            size: FFP_CLIP_PLANES_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Initialize modular components
        this.ringBufferManager = new RingBufferManager(this.device, this.queue);
        this.bindGroupManager = new BindGroupManager(this.device);
        this.depthManager = new DepthManager(this.device, this.queue, {
            format: "depth24plus-stencil8", // Stencil for Shadow Volume / DX7–9 games
            enableDebugCopy: false,
        });
        this.shaderGenerator = new ShaderGenerator(this.device);
        this.swapChainFormat = this.backend.getFormat() || "rgba8unorm"; // Fallback to rgba8unorm if format not available
        this.pipelineFactory = new PipelineFactory(
            this.device,
            this.shaderGenerator,
            this.bindGroupManager,
            this.debugFlags,
            this.swapChainFormat
        );
        this.clearPipeline = new ClearPipeline(
            this.device,
            this.queue,
            this.depthManager.getDepthFormat()
        );
        this.msaaColorManager = new MsaaColorManager(this.device);
        this.colorKeyBlitPipeline = new ColorKeyBlitPipeline(this.device, this.queue);
        this.vertexConverter = new VertexConverter(this.device, this.queue);
        this.textureConverter = new TextureConverter(this.device, this.queue);

        // Create dummy texture (1x1 white) for SetTexture(NULL)
        this.initDummyTexture();

        // Initialize scratch buffer
        this.initScratchBuffer();
    }

    /**
     * Device gone. Drop the in-flight frame WITHOUT touching the GPU (the encoder belongs to
     * the dead device), then forget every cached handle. `deviceLost` gates the entry points
     * until a replacement arrives — the sub-manager fields stay pointing at dead objects
     * because they are non-nullable and are replaced wholesale on recreation.
     */
    private onDeviceLost(): void {
        this.deviceLost = true;
        this.currentEncoder = null;
        this.currentRenderPass = null;
        this.currentBatch = null;
        this.encoderEpoch++;
        this.lastBindGroup = null;
        this.lastPipeline = null;
        this.dummyTexture = null;
        this.dummyTextureView = null;
        this.mipGenerator = null;
        this.sampleViewCache = new WeakMap();
        this.lastAppliedMsaa = -1;
    }

    private onDeviceRecreated(device: GPUDevice): void {
        this.buildDeviceResources(device, device.queue);
        // A draw issued during the lost window may have parked an encoder built on the dead
        // device; using it against the new device's resources is a validation error that
        // costs the whole frame. Drop the in-flight frame a second time, on this edge too.
        this.currentEncoder = null;
        this.currentRenderPass = null;
        this.currentBatch = null;
        this.encoderEpoch++;
        this.lastBindGroup = null;
        this.lastPipeline = null;
        this.deviceLost = false;
    }

    private resolveSurfaceTextureFormat(
        state: DirectDrawSurfaceState,
        fallback?: GPUTextureFormat
    ): GPUTextureFormat {
        if (state.gpuTextureFormat) {
            return state.gpuTextureFormat;
        }

        const textureFormat = (state.gpuTexture as unknown as { format?: GPUTextureFormat } | undefined)?.format;
        if (textureFormat) {
            return textureFormat;
        }

        if (fallback) {
            const surfacePtr = state.surfacePtr >>> 0;
            if (!this.warnedMissingGpuFormat.has(surfacePtr)) {
                this.warnedMissingGpuFormat.add(surfacePtr);
                Logger.warn(
                    LogCategory.DDRAW,
                    `resolveSurfaceTextureFormat: missing gpuTextureFormat/texture.format ` +
                    `for surface=0x${surfacePtr.toString(16)}, using explicit fallback=${fallback}`
                );
            }
            return fallback;
        }

        const isRenderTarget =
            (state.caps & (DDSCAPS_PRIMARYSURFACE | DDSCAPS_BACKBUFFER | DDSCAPS_3DDEVICE)) !== 0;
        const inferred = isRenderTarget ? this.swapChainFormat : "rgba8unorm";
        const surfacePtr = state.surfacePtr >>> 0;
        if (!this.warnedMissingGpuFormat.has(surfacePtr)) {
            this.warnedMissingGpuFormat.add(surfacePtr);
            Logger.warn(
                LogCategory.DDRAW,
                `resolveSurfaceTextureFormat: missing gpuTextureFormat/texture.format ` +
                `for surface=0x${surfacePtr.toString(16)}, inferred=${inferred}`
            );
        }
        return inferred;
    }

    private initDummyTexture(): void {
        this.dummyTexture = this.device.createTexture({
            size: [1, 1],
            format: this.swapChainFormat, // Use swapchain format for consistency
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.dummyTextureView = this.dummyTexture.createView();
        this.writeDummyTexturePixel();
    }

    /** The dummy 1x1 sampled when a draw asks for a texture and none is bound. Rewritten
     *  (not just set once at init) so `forceMissingTextureMagenta` bites on toggle — the
     *  texture is created once at device init, long before any draw could observe it. */
    private writeDummyTexturePixel(): void {
        if (!this.dummyTexture) return;
        const pixel = this.debugFlags.forceMissingTextureMagenta
            ? new Uint8Array([255, 0, 255, 255])
            : new Uint8Array([255, 255, 255, 255]);
        this.queue.writeTexture(
            { texture: this.dummyTexture },
            pixel,
            { bytesPerRow: 4 },
            { width: 1, height: 1, depthOrArrayLayers: 1 }
        );
    }

    private initScratchBuffer(): void {
        this.scratchBufferSize = 64 * 1024;
        this.scratchBuffer = new Uint8Array(this.scratchBufferSize);
        this.scratchF32 = new Float32Array(
            this.scratchBuffer.buffer,
            this.scratchBuffer.byteOffset,
            this.scratchBufferSize / 4
        );
        this.scratchDataView = new DataView(
            this.scratchBuffer.buffer,
            this.scratchBuffer.byteOffset,
            this.scratchBufferSize
        );
    }

    /**
     * Remove depth buffer for a surface (called when surface is destroyed)
     */
    removeDepthForSurface(surfacePtr: number): void {
        this.depthManager.removeDepthForSurface(surfacePtr);
        this.msaaColorManager.removeForSurface(surfacePtr);
    }

    /** Depth format shared by FFP and programmable D3D8 draws (depth24plus-stencil8). */
    getDepthFormat(): GPUTextureFormat {
        return this.depthManager.getDepthFormat();
    }

    /**
     * Depth attachment for programmable draws — same buffer and load/clear semantics as FFP.
     */
    createDepthStencilForProgrammable(
        target: DirectDrawSurfaceState,
    ): GPURenderPassDepthStencilAttachment | undefined {
        this.ensureSurfaceGPUResources(target);
        this.depthManager.ensureDepthForTarget(target);
        return this.depthManager.createDepthStencilAttachmentForTarget(target);
    }

    /**
     * Release GPU resources. Call when tearing down DDraw/backend.
     */
    getTextureConverter(): TextureConverter {
        return this.textureConverter;
    }

    private shouldTraceLargeTexture(state: DirectDrawSurfaceState | null | undefined): state is DirectDrawSurfaceState {
        if (!state) return false;
        return state.width >= 128 || state.height >= 128 ||
            state.surfacePtr === 0x2c59f400 || state.surfacePtr === 0x2c5bf400;
    }

    private describeCpuSurfaceSamples(
        state: DirectDrawSurfaceState,
        mem: Uint8Array,
        pitch: number,
        bytesPerPixel: number
    ): string {
        const firstOffset = state.surfacePtr;
        const centerOffset = state.surfacePtr +
            ((state.height >> 1) * pitch) +
            ((state.width >> 1) * bytesPerPixel);
        const lastOffset = state.surfacePtr +
            ((state.height - 1) * pitch) +
            ((state.width - 1) * bytesPerPixel);

        const readWord = (offset: number): number => {
            if (offset < 0 || offset + 1 >= mem.length) return -1;
            return mem[offset] | (mem[offset + 1] << 8);
        };
        const readDword = (offset: number): number => {
            if (offset < 0 || offset + 3 >= mem.length) return -1;
            return (mem[offset] | (mem[offset + 1] << 8) | (mem[offset + 2] << 16) | (mem[offset + 3] << 24)) >>> 0;
        };

        let nonZeroSamples = 0;
        let zeroSamples = 0;
        let minSample = 0xffffffff;
        let maxSample = 0;
        const sampleCount = Math.min(512, Math.max(1, state.width * state.height));
        for (let i = 0; i < sampleCount; i++) {
            const x = ((i * 2654435761) >>> 0) % state.width;
            const y = ((i * 40503) >>> 0) % state.height;
            const offset = state.surfacePtr + y * pitch + x * bytesPerPixel;
            const sample = bytesPerPixel === 2 ? readWord(offset) : readDword(offset);
            if (sample < 0) continue;
            if (sample === 0) {
                zeroSamples++;
            } else {
                nonZeroSamples++;
                if (sample < minSample) minSample = sample;
                if (sample > maxSample) maxSample = sample;
            }
        }

        const fmt = (value: number, width: number): string =>
            value < 0 ? "OOB" : `0x${value.toString(16).padStart(width, "0")}`;
        const sampleWidth = bytesPerPixel === 2 ? 4 : 8;
        const first = bytesPerPixel === 2 ? readWord(firstOffset) : readDword(firstOffset);
        const center = bytesPerPixel === 2 ? readWord(centerOffset) : readDword(centerOffset);
        const last = bytesPerPixel === 2 ? readWord(lastOffset) : readDword(lastOffset);

        return `samples=${sampleCount} nonZero=${nonZeroSamples} zero=${zeroSamples} ` +
            `first=${fmt(first, sampleWidth)} center=${fmt(center, sampleWidth)} last=${fmt(last, sampleWidth)} ` +
            `minNonZero=${nonZeroSamples ? fmt(minSample, sampleWidth) : "none"} ` +
            `maxNonZero=${nonZeroSamples ? fmt(maxSample, sampleWidth) : "none"}`;
    }

    destroy(): void {
        this.flush();
        this.currentRenderTarget = null;

        this.vertexConverter.destroy();
        this.textureConverter.destroy();
        this.ringBufferManager.destroy();
        this.depthManager.destroy();
        this.msaaColorManager.destroy();
        this.clearPipeline.destroy();
        this.colorKeyBlitPipeline.destroy();

        if (this.dummyTexture) {
            this.dummyTexture.destroy();
            this.dummyTexture = null;
            this.dummyTextureView = null;
        }
    }

    // ===== Debug API =====

    /** DIAG: cumulative counters over every path that can silently lose a draw or
     *  break batching/passes. Read via dbg.rstats(); sample twice to get rates.
     *  Built for the HP "objects flicker/disappear for a frame" hunt. */
    public renderStats = {
        drawReq: 0,            // drawPrimitive + drawIndexedPrimitive entered
        drawIndexedReq: 0,     // subset: indexed
        skipNoRT: 0,           // target.gpuTextureView missing after prepareDraw
        skipBadRange: 0,       // vertex/index range invalid in guest memory
        skipRingOverflow: 0,   // vertex ring alloc overflow — DRAW DROPPED
        skipNoData: 0,         // no converted vertex data
        gpuConvFallback: 0,    // GPU vertex conversion failed → CPU retry
        midFrameFlush: 0,      // ensureSpaceForDraw ring switch (flush mid-frame)
        passes: 0,             // render passes created
        batches: 0,            // megabatches flushed
        batchedDraws: 0,       // draws inside flushed megabatches
        clears: 0,             // executor.clear() calls
        flushes: 0,            // full flush() calls
        nanVerts: 0,           // CPU-converted vertices with non-finite x/y/z/w (guest data bad?)
        nanDraws: 0,           // draws containing at least one such vertex
        texHashScans: 0,       // content-hash scans run (once per surface per frame)
        texHashBytes: 0,       // guest bytes read by those scans
        texHashDirty: 0,       // scans whose hash CHANGED → forced a re-upload
        texSyncs: 0,           // syncSurfaceFromMemory calls from the stage-texture path
        earlyTexSubmits: 0,    // mid-frame submits forced by a sampled texture being overwritten
    };

    /** Count non-finite positions in CPU-converted vertex data (diagnoses guest-side
     *  vertex corruption — e.g. FPU/softfloat garbage → GPU clips the triangle →
     *  single triangles/surfaces vanish for a frame). */
    private countNanVerts(converted: Uint8Array, vertexCount: number): void {
        // Diagnostic only — never let it outlive its data: a short/misaligned result would
        // otherwise throw out of the draw path instead of merely counting nothing.
        if ((converted.byteOffset & 3) !== 0) return;
        const avail = Math.min(vertexCount, (converted.length >>> 2) / OUTPUT_VERTEX_U32S | 0);
        if (avail <= 0) return;
        const f32 = new Float32Array(converted.buffer, converted.byteOffset, avail * OUTPUT_VERTEX_U32S);
        let bad = 0;
        for (let i = 0; i < avail; i++) {
            const base = i * OUTPUT_VERTEX_U32S;
            // First 4 floats of the output layout are x, y, z, rhw/w.
            if (!Number.isFinite(f32[base]) || !Number.isFinite(f32[base + 1]) ||
                !Number.isFinite(f32[base + 2]) || !Number.isFinite(f32[base + 3])) {
                bad++;
            }
        }
        if (bad) {
            this.renderStats.nanVerts += bad;
            this.renderStats.nanDraws++;
        }
    }

    getRenderStats(): typeof this.renderStats {
        return this.renderStats;
    }

    /** Upload the vertex converter's staged params. Every submit path that can carry a GPU
     *  vertex conversion must call this BEFORE queue.submit() — see VertexConverter. */
    flushVertexParams(): void {
        this.vertexConverter.flushParams();
    }

    /** Vertex scratch-pool counters (see VertexConverter.getScratchStats). */
    getVertexScratchStats(): ReturnType<VertexConverter["getScratchStats"]> {
        return this.vertexConverter.getScratchStats();
    }

    /** Per-frame delta ring over renderStats + ring-buffer high-water offsets, sampled
     *  at the endFrame chokepoint BEFORE ring rotation. Answers "did the engine emit
     *  fewer draws this frame, or did we drop them (and was any ring near capacity)"
     *  for the last ~17s without wrapping draw entry points live. Read via dbg.fstats(n). */
    private frameStatsRing: Array<Record<string, number>> = [];
    private frameStatsPrev: typeof this.renderStats | null = null;
    private frameStatsPrevLightsOvf = 0;
    private frameStatsPrevVc = { conversions: 0, gpuObjects: 0, perDraw: 0 };
    private frameStatsSerial = 0;
    private static readonly FRAME_STATS_CAPACITY = 1024;

    sampleFrameStats(): void {
        this.frameSerial++;
        if (this.opLogArmed > 0) {
            this.opLog("=== FRAME END ===");
            this.opLogArmed--;
        }
        const s = this.renderStats;
        const p = this.frameStatsPrev;
        const usage = this.ringBufferManager.getFrameUsage();
        // vcConv is the denominator for vcAlloc: "no GPU objects created this frame" only
        // means the vertex scratch pool held if conversions actually ran. vcPerDraw > 0 with
        // the pool enabled means it fell back, not that it was switched off.
        const vc = this.vertexConverter.getScratchStats();
        this.frameStatsRing.push({
            n: ++this.frameStatsSerial,
            t: Math.round(performance.now()),
            draws: s.drawReq - (p?.drawReq ?? 0),
            indexed: s.drawIndexedReq - (p?.drawIndexedReq ?? 0),
            skipNoRT: s.skipNoRT - (p?.skipNoRT ?? 0),
            skipBadRange: s.skipBadRange - (p?.skipBadRange ?? 0),
            skipRingOverflow: s.skipRingOverflow - (p?.skipRingOverflow ?? 0),
            skipNoData: s.skipNoData - (p?.skipNoData ?? 0),
            midFrameFlush: s.midFrameFlush - (p?.midFrameFlush ?? 0),
            batchedDraws: s.batchedDraws - (p?.batchedDraws ?? 0),
            clears: s.clears - (p?.clears ?? 0),
            passes: s.passes - (p?.passes ?? 0),
            nanVerts: s.nanVerts - (p?.nanVerts ?? 0),
            lightsOvf: usage.lightsOverflow - this.frameStatsPrevLightsOvf,
            vcConv: vc.conversions - this.frameStatsPrevVc.conversions,
            vcAlloc: vc.gpuObjects - this.frameStatsPrevVc.gpuObjects,
            vcPerDraw: vc.perDraw - this.frameStatsPrevVc.perDraw,
            vHW: usage.v, iHW: usage.i, uHW: usage.u, lHW: usage.l, sHW: usage.s,
        });
        this.frameStatsPrev = { ...s };
        this.frameStatsPrevLightsOvf = usage.lightsOverflow;
        this.frameStatsPrevVc = {
            conversions: vc.conversions,
            gpuObjects: vc.gpuObjects,
            perDraw: vc.perDraw,
        };
        const over = this.frameStatsRing.length - DDrawWebGPUExecutor.FRAME_STATS_CAPACITY;
        if (over > 0) this.frameStatsRing.splice(0, over);
    }

    /** One-frame GPU op log: exact sequence of pass creations (with depth loadOp),
     *  immediate draws, batch flushes and clears. Armed via armOpLog(); zero overhead
     *  when disarmed (single counter check). Read via dbg.gpuops(). */
    private opLogEntries: string[] = [];
    /** THE XYZRHW CONVERTER PIN, and the two counters that make it checkable.
     *
     *  Only for a pre-transformed position does the vertex converter itself compute the
     *  clip-space position (screen -> NDC -> * w), and there are two converters — a WGSL
     *  compute shader and a JS mirror of it — picked per draw by vertex count. They cannot
     *  agree bit-for-bit however carefully the JS follows the WGSL's operation order: WGSL
     *  specifies f32 division to 2.5 ULP, and the `* 2 - 1` after it cancels. A title that
     *  overlays a lightmap/decal pass on the SAME triangles with depth writes off then gets
     *  unequal depth wherever a base pass and its overlay straddle the threshold, and half
     *  the pixels fail the test. Transformed and XYZW positions are immune (both converters
     *  copy them), so the pin is confined to XYZRHW.
     *
     *  `rhwPinnedDraws` is COVERAGE: draws the pin actually diverted, so a zero violation
     *  count can be told apart from a scene that never reached the case. `rhwGpuConversions`
     *  is the VIOLATION: pre-transformed draws that reached the GPU converter anyway, which
     *  is the invariant itself and stays meaningful on a title that is not all XYZRHW. */
    private rhwPinnedDraws = 0;
    private rhwGpuConversions = 0;
    private opLogArmed = 0;
    private opLogViewIds = new WeakMap<object, number>();
    private opLogViewIdNext = 1;

    armOpLog(frames: number = 1): void {
        this.opLogEntries = [];
        this.opLogArmed = Math.max(1, frames | 0);
    }

    getOpLog(): string[] {
        return this.opLogEntries;
    }

    /** Coverage + violation counts for the XYZRHW converter pin (see the fields). */
    getRhwConverterCounts(): { pinnedDraws: number; gpuConversions: number } {
        return { pinnedDraws: this.rhwPinnedDraws, gpuConversions: this.rhwGpuConversions };
    }

    /** Per-draw call sites MUST test `opLogArmed` themselves before calling: the cost of
     *  this diagnostic is the template string the caller builds, which an early return
     *  inside here cannot avoid. Same reason drawCostProfiler exposes `enabled` publicly. */
    private opLog(s: string): void {
        if (this.opLogArmed <= 0) return;
        if (this.opLogEntries.length < 4000) this.opLogEntries.push(s);
    }

    /** Last n per-frame stat entries (newest last) + ring sizes for interpreting HW offsets. */
    getFrameStats(n: number): { sizes: { v: number; u: number; s: number }; frames: Array<Record<string, number>> } {
        const usage = this.ringBufferManager.getFrameUsage();
        return {
            sizes: { v: usage.vSize, u: usage.uSize, s: usage.sSize },
            frames: this.frameStatsRing.slice(-Math.max(1, n | 0)),
        };
    }

    /** Cached FFP pipeline count (debug GPU panel). */
    getPipelineCacheSize(): number {
        return this.pipelineFactory.getCacheSize();
    }

    /** Current DebugFlags — lets a caller see which diagnostic overrides are still armed
     *  (they are sticky, and a forgotten one silently colours every later observation). */
    getDebugFlags(): DebugFlags & { scrubLastFrameDraws: number } {
        return { ...this.debugFlags, scrubLastFrameDraws: this.scrubLastFrameDraws };
    }

    setDebugToggle(toggle: string, enabled: boolean, rawValue?: number | string): void {
        // debugView is the only flag whose value is a NAME, not a number. It had no case at all
        // below, so the switch fell through silently while gpuToggle still reported "applied" —
        // the flag IS a key of DebugFlags, so the name check upstream passed. An unknown mode is
        // an error here, never a quiet fall-back to "normal".
        if (toggle === "debugView") {
            const modes = ["normal", "uv", "vertexcolor", "alpha", "solid"] as const;
            const wanted = enabled ? String(rawValue ?? "normal") : "normal";
            if (!(modes as readonly string[]).includes(wanted)) {
                throw new Error(`debugView: unknown mode '${wanted}'. Modes: ${modes.join(", ")}`);
            }
            this.debugFlags.debugView = wanted as (typeof modes)[number];
            this.pipelineFactory.setDebugFlags(this.debugFlags);
            return;
        }
        const value = typeof rawValue === "number" ? rawValue : undefined;
        switch (toggle) {
            case "forceMissingTextureMagenta":
                this.debugFlags.forceMissingTextureMagenta = enabled;
                this.writeDummyTexturePixel();
                break;
            case "forceDisableAlphaBlend":
                this.debugFlags.forceDisableAlphaBlend = enabled;
                break;
            case "forceDisableLighting":
                this.debugFlags.forceDisableLighting = enabled;
                break;
            case "forceDisableZTest":
                this.debugFlags.forceDisableZTest = enabled;
                break;
            case "forceWireColor":
                this.debugFlags.forceWireColor = enabled;
                break;
            case "forceZMidpoint":
                this.debugFlags.forceZMidpoint = enabled;
                break;
            case "disableRhwDepthClamp":
                this.debugFlags.disableRhwDepthClamp = enabled;
                break;
            case "disableRhwCpuPin":
                this.debugFlags.disableRhwCpuPin = enabled;
                break;
            case "forceCullNone":
                this.debugFlags.forceCullNone = enabled;
                break;
            case "forceDisableAlphaTest":
                this.debugFlags.forceDisableAlphaTest = enabled;
                break;
            case "forceTextureResync":
                this.debugFlags.forceTextureResync = enabled;
                break;
            case "forcePointFilter":
                this.debugFlags.forcePointFilter = enabled;
                break;
            case "disableContainedUvClamp":
                this.debugFlags.disableContainedUvClamp = enabled;
                break;
            case "skipMegaBatchDrawsRender":
                this.debugFlags.skipMegaBatchDrawsRender = enabled;
                // Optional threshold: only drop batched draws with indexCount >= value
                // (0/undefined = drop ALL batched draws).
                this.debugFlags.skipMegaBatchMinIdx = enabled ? ((value ?? 0) | 0) : 0;
                break;
            case "disableMegaBatch":
                this.debugFlags.disableMegaBatch = enabled;
                break;
            case "disableMegaBatchAccumulate":
                this.debugFlags.disableMegaBatchAccumulate = enabled;
                break;
            case "disableGeometryStaging":
                this.debugFlags.disableGeometryStaging = enabled;
                this.ringBufferManager.setGeometryStagingEnabled(!enabled);
                break;
            case "disableCpuTextureHash":
                this.debugFlags.disableCpuTextureHash = enabled;
                break;
            case "disableTextureOverwriteSubmit":
                this.debugFlags.disableTextureOverwriteSubmit = enabled;
                break;
            case "forceCpuVertexPath":
                this.debugFlags.forceCpuVertexPath = enabled;
                break;
            case "forceColorWriteMask":
                // Positive control for D3DRS_COLORWRITEENABLE: `gpuToggle('forceColorWriteMask',
                // true, 0)` must make every draw stop writing colour. If the picture survives,
                // the mask is not reaching the colour target state at all.
                this.debugFlags.forceColorWriteMask = enabled ? ((value ?? 0) | 0) & 0xf : -1;
                break;
            case "forceDisableZWrite":
                this.debugFlags.forceDisableZWrite = enabled;
                break;
            case "drawScrubMax":
                // Bisect lever: render only draws 0..value of each frame. Off (-1) when
                // disabled, so a bare `gpuToggle('drawScrubMax', false)` restores the frame.
                this.debugFlags.drawScrubMax = enabled ? ((value ?? 0) | 0) : -1;
                break;
            case "drawSkipFrom":
                this.debugFlags.drawSkipFrom = enabled ? ((value ?? 0) | 0) : -1;
                break;
            case "drawSkipTo":
                this.debugFlags.drawSkipTo = enabled ? ((value ?? 0) | 0) : -1;
                break;
            case "textureConverterDebugMode":
                // For numeric values, use 'value' parameter if provided, otherwise use 'enabled' as number
                this.debugFlags.textureConverterDebugMode = value !== undefined ? value : (enabled ? 1 : 0);
                this.textureConverter.setDebugMode(this.debugFlags.textureConverterDebugMode);
                // Mark all textures as dirty so they reload with new debug mode
                this.invalidateAllTextures();
                break;
        }
        this.pipelineFactory.setDebugFlags(this.debugFlags);
    }

    getLastDrawDiagnostics(): DrawExecutionDiagnostics | null {
        return this.lastDrawDiagnostics.valid ? this.lastDrawDiagnostics : null;
    }

    /**
     * Invalidate all textures to force reload with new debug mode
     */
    private invalidateAllTextures(): void {
        const system = System.getInstance();
        const ddraw = system.process?.getModule("ddraw") as any;
        if (!ddraw?.context?.resourceProvider) return;

        const resourceProvider = ddraw.context.resourceProvider;
        const allComObjects = resourceProvider.getAllComObjects();

        let invalidatedCount = 0;
        for (const obj of allComObjects) {
            // Check if it's a DirectDrawSurfaceObject
            if (!(obj instanceof DirectDrawSurfaceObject)) continue;
            
            const state = obj.getState();
            if (!state || !state.gpuTexture) continue;

            // Force re-upload on next sync (authority=cpu)
            setAuthorityCpu(state);
            invalidatedCount++;
        }

        if (invalidatedCount > 0) {
            if (Logger.isEnabled(LogCategory.DDRAW, LogLevel.NORMAL)) {
                Logger.log(LogCategory.DDRAW, `Invalidated ${invalidatedCount} textures for debug mode change`);
            }
        }
    }

    private getSurfacePtrAliasSource(state: DirectDrawSurfaceState): RenderSurface | null {
        if (!isRenderSurface(state) || state.surfacePtr <= 0) {
            return null;
        }

        const system = System.getInstance();
        const ddraw = system.process?.getModule("ddraw") as any;
        const resourceProvider = ddraw?.context?.resourceProvider;
        if (!resourceProvider) {
            return null;
        }

        const aliases = resourceProvider.getComObjectsBySurfacePtr(state.surfacePtr);
        let bestAlias: RenderSurface | null = null;
        let bestUploadVersion = -1;

        for (const obj of aliases) {
            if (!(obj instanceof DirectDrawSurfaceObject)) {
                continue;
            }

            const candidate = obj.getState();
            if (candidate === state || !isRenderSurface(candidate)) {
                continue;
            }
            if (!candidate.gpuTexture || !candidate.gpuTextureView || candidate.gpuDirty) {
                continue;
            }
            if (candidate.lastUploadVersion < 0 || candidate.version !== candidate.lastUploadVersion) {
                continue;
            }
            if (candidate.width !== state.width || candidate.height !== state.height || candidate.pitch !== state.pitch) {
                continue;
            }
            if (candidate.gpuTextureFormat !== state.gpuTextureFormat) {
                continue;
            }
            if (candidate.format.bpp !== state.format.bpp ||
                candidate.format.rMask !== state.format.rMask ||
                candidate.format.gMask !== state.format.gMask ||
                candidate.format.bMask !== state.format.bMask ||
                candidate.format.aMask !== state.format.aMask ||
                (candidate.format.flags ?? 0) !== (state.format.flags ?? 0)) {
                continue;
            }

            if (candidate.lastUploadVersion > bestUploadVersion) {
                bestAlias = candidate;
                bestUploadVersion = candidate.lastUploadVersion;
            }
        }

        return bestAlias;
    }

    private tryAdoptFreshAliasUpload(_state: DirectDrawSurfaceState): boolean {
        // DISABLED: copying a sibling surface's GPU texture whenever guest addresses
        // coincide caused splash→menu content leakage.
        // Some titles reuse the same surfacePtr across scene transitions, so a
        // fresh RenderSurface (version===0, lastUploadVersion<0) can find an old
        // sibling with stale pixels and adopt them, then mark itself clean — the
        // real new-scene pixels never upload from guest memory.
        // Re-enable only with a stronger equivalence check (e.g. writeGeneration
        // or guest-memory hash) that confirms the sibling reflects current state.
        return false;
    }

    setDebugView(view: "normal" | "uv" | "vertexcolor" | "alpha" | "solid"): void {
        this.debugFlags.debugView = view;
        this.pipelineFactory.setDebugFlags(this.debugFlags);
    }

    /**
     * Invalidate caches that may reference a surface's GPU resources.
     * Call this after recreating a surface's gpuTexture/gpuTextureView to prevent
     * "Destroyed texture used in submit" errors.
     */
    invalidateSurfaceCache(surface: DirectDrawSurfaceState): void {
        // If this is the current render target, end the render pass
        // (render pass holds a reference to gpuTextureView which may be stale)
        if (this.currentRenderTarget === surface && this.currentRenderPass) {
            this.currentRenderPass.end();
            this.currentRenderPass = null;
            this.currentRenderTarget = null;
        }

        // Flush any active batch that might reference this surface
        // We cannot reliably check texture view equality after recreation, so flush unconditionally
        if (this.currentBatch) {
            this.flushBatch();
        }

        // Reset all cached texture views to force re-bind on next draw
        this.resetBindFastPath();
    }

    getDummyTextureView(): GPUTextureView | null {
        return this.dummyTextureView;
    }

    // ===== Clear Operations =====

    clear(
        target: DirectDrawSurfaceState,
        flags: number,
        color: number,
        depth: number,
        viewport?: { x: number; y: number; width: number; height: number },
        rects?: Array<{ x1: number; y1: number; x2: number; y2: number }>,
        stencil?: number
    ): void {
        // Frame capture (zero overhead when off). Record BEFORE the gpuTextureView
        // early-return so we always capture the clear intent (incl. failed clears).
        this.renderStats.clears++;
        if (frameCapture.isCapturing()) {
            frameCapture.recordClear(target, flags, color, depth, stencil ?? 0, rects?.length ?? 0);
        }

        this.ensureSurfaceGPUResources(target);
        if (!target.gpuTextureView) {
            Logger.warn(LogCategory.DDRAW, `clear: Failed to create GPU resources for surface 0x${target.surfacePtr.toString(16)}`);
            return;
        }

        // Sync sampleCount before any depth/color texture is ensured below, so an immediate clear
        // pass' color + depth attachments (and the clear pipeline) all share one sampleCount.
        this.syncMsaaSampleCount();

        const hasRects = rects && rects.length > 0;
        if (this.opLogArmed > 0) this.opLog(`CLEAR flags=${flags} rects=${rects?.length ?? 0} passOpen=${!!this.currentRenderPass} pendingBatch=${this.currentBatch ? (this.currentBatch.draws?.length ?? 0) : 0}`);
        // D3D semantics: Clear is constrained to the current viewport (∩ rects). A
        // partial viewport (e.g. cutscene letterbox bars cleared to black) must NOT
        // take the deferred full-target path — that wipes the whole frame.
        const vpIsFull = !viewport ||
            (viewport.x <= 0 && viewport.y <= 0 &&
             viewport.width >= target.width && viewport.height >= target.height);
        const isFullClear = !hasRects && vpIsFull;
        const hasColorClear = (flags & D3DCLEAR_TARGET) !== 0;

        // Flush pending batched draws BEFORE registering any deferred clear state.
        // flushBatch() may open a new render pass (ensureRenderPass), and pass creation
        // consumes the deferred depth needsClear flag. If setNeedsClear ran first, the
        // pre-clear batched draws would render into FRESHLY CLEARED depth — every one of
        // them passes the z-test and repaints over geometry already drawn this frame.
        // (Max Payne: the game z-clears late in the frame while floor tiles sit in the
        // pending MegaBatch; the flushed floor then overwrote the already-drawn player
        // legs at certain camera angles — "legless Max".)
        this.flushBatch();

        // Handle Z-buffer/stencil clear BEFORE the deferred color clear early return.
        // Skipping this when flags have both D3DCLEAR_TARGET and D3DCLEAR_ZBUFFER
        // leaves stale depth across frames → Z-test failures → surface flickering.
        if (flags & (D3DCLEAR_ZBUFFER | D3DCLEAR_STENCIL)) {
            this.depthManager.ensureDepthForTarget(target);
            if (flags & D3DCLEAR_ZBUFFER) {
                this.depthManager.setNeedsClear(target, depth);
            }
            if (flags & D3DCLEAR_STENCIL) {
                this.depthManager.setNeedsStencilClear(target, stencil ?? 0);
            }
        }

        if (isFullClear && hasColorClear) {
            // Close current render pass so that the next ensureRenderPass (from DrawPrimitive)
            // opens a new pass with loadOp:"clear" and consumes the deferred clear.
            if (this.currentRenderPass !== null && this.currentRenderTarget === target) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
                this.currentRenderTarget = null;
                this.lastBindGroup = null;
                this.lastUniformOffset = -1; this.lastLightsOffset = -1;
            }
            target.needsColorClear = true;
            target.clearColor = color;
            this.surfacesNeedingClear.add(target);
            setAuthorityGpu(target, true);
            return;
        }

        // (Pending batch already flushed above, before the deferred clear registration.)
        if (this.currentRenderPass) {
            this.currentRenderPass.end();
            this.currentRenderPass = null;
            this.currentRenderTarget = null;
            this.lastBindGroup = null;
            this.lastUniformOffset = -1; this.lastLightsOffset = -1;
        }

        if (!this.currentEncoder) {
            this.currentEncoder = this.device.createCommandEncoder();
        }

        const colorFormat = this.resolveSurfaceTextureFormat(target);
        const config: ClearConfig = {
            flags,
            color,
            depth,
            stencil,
            viewport: rects?.length ? undefined : viewport,
            rects,
        };

        // MSAA: clear into the multisample color texture (created here alongside the possibly-MSAA
        // depth so both attachments carry the same sampleCount) and resolve to the single-sample
        // surface. undefined when MSAA is off → clears the single-sample texture directly as before.
        let msaaColorView: GPUTextureView | undefined;
        if (this.msaaColorManager.isEnabled()) {
            this.msaaColorManager.ensureForTarget(target);
            msaaColorView = this.msaaColorManager.getColorViewForTarget(target) ?? undefined;
        }

        this.clearPipeline.clear(
            this.currentEncoder,
            target.gpuTextureView!,
            target.width,
            target.height,
            this.depthManager.getDepthViewForTarget(target),
            config,
            colorFormat,
            msaaColorView
        );

        if (flags & (D3DCLEAR_ZBUFFER | D3DCLEAR_STENCIL)) {
            this.depthManager.markUsedThisFrame(target);
            this.depthManager.markExplicitClearDone(target);
        }
        setAuthorityGpu(target, true);
    }

    // ===== Surface Sync =====

    /**
     * Sync surface from CPU memory to GPU texture.
     * Authority/version check is cheap. GPU path uses compute + queue.writeBuffer (non-blocking).
     * CPU fallback (small textures, unsupported formats) does convertToRGBA loops — can block main thread.
     */
    syncSurfaceFromMemory(state: DirectDrawSurfaceState): void {
        logSurfaceState(state, "syncSurfaceFromMemory entry");

        // Registry snapshot (surfacePtr=0): no CPU data — don't overwrite GPU with zeros.
        if (state.surfacePtr === 0 && state.gpuTexture && state.gpuTextureView) {
            if (Logger.isEnabled(LogCategory.DDRAW, LogLevel.NORMAL)) {
                Logger.log(
                    LogCategory.DDRAW,
                    `syncSurfaceFromMemory: SKIP (surfacePtr=0, registry snapshot) - keeping existing GPU texture 0x${state.width}x${state.height}`
                );
            }
            return;
        }

        // Log entry state for all surfaces
        if (isRenderSurface(state)) {
            Logger.verbose(LogCategory.DDRAW,
                `syncSurfaceFromMemory: RenderSurface=0x${state.surfacePtr.toString(16)} ${state.width}x${state.height} ` +
                `mode=${state.mode} gpuDirty=${state.gpuDirty} everLocked=${state.everLocked} ` +
                `rgbaScratch=${state.rgbaScratch ? 'present' : 'undefined'}`);
        } else {
            Logger.verbose(LogCategory.DDRAW,
                `syncSurfaceFromMemory: BitmapTexture=0x${state.surfacePtr.toString(16)} ${state.width}x${state.height} ` +
                `gpuNeedsUpload=${state.gpuNeedsUpload} rgbaScratch=${state.rgbaScratch ? 'present' : 'undefined'}`);
        }

        // Lazy GPU texture creation for SYSMEM surfaces that now need GPU backing
        // (e.g., SYSMEM texture used as Load() destination, or bound via SetTexture)
        if (!state.gpuTexture && state.surfacePtr > 0 && state.width > 0 && state.height > 0) {
            const isTextureFlag = (state.caps & DDSCAPS_TEXTURE) !== 0;
            if (isTextureFlag && this.device) {
                const format = "rgba8unorm";
                const gpuResult = createGPUTexture(
                    this.device,
                    this.queue,
                    state.width,
                    state.height,
                    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                    format
                );
                if (gpuResult) {
                    state.gpuTexture = gpuResult.texture;
                    state.gpuTextureView = gpuResult.view;
                    state.gpuTextureFormat = format;
                    if (isRenderSurface(state)) {
                        state.lastUploadVersion = -1;
                    }
                    // Only mark stale when CPU already has pixel data (Load/Unlock/Blt).
                    if (isRenderSurface(state)) {
                        if (state.surfaceEverWritten || state.everLocked || state.version > 0) {
                            state.gpuDirty = true;
                        }
                    } else if (isBitmapTexture(state)) {
                        state.gpuNeedsUpload = true;
                    }
                }
            }
        }

        // Authority-based sync: only upload when CPU has current data and GPU doesn't.
        const decision = surfaceSyncManager.needsGPUSync(state);
        if (!decision.needed) {
            // DIAGNOSTIC: Log why BitmapTexture upload was skipped
            if (isBitmapTexture(state)) {
                Logger.verbose(LogCategory.DDRAW,
                    `syncSurfaceFromMemory: SKIP BitmapTexture 0x${state.surfacePtr.toString(16)} - ` +
                    `gpuNeedsUpload=${state.gpuNeedsUpload} reason=${decision.reason}`
                );
            }
            return;
        }

        // Uninitialized SYSMEM/VidMem textures: defer GPU upload until pixels exist.
        // Early SetTexture bind used to upload CreateSurface zeros and poison sampling (black menu).
        const isTextureCap = (state.caps & DDSCAPS_TEXTURE) !== 0;
        if (
            isTextureCap &&
            isRenderSurface(state) &&
            !state.surfaceEverWritten &&
            !state.everLocked &&
            state.version === 0
        ) {
            // Those flags only see writes we mediate (Lock/Unlock, Load, Blt). DX6-era code
            // routinely caches the lpSurface of a SYSTEMMEMORY surface and fills texels through
            // it with no further Lock, which leaves every flag false on a surface that is full of
            // art — deferring it for ever, so the scene samples black. Ask the memory instead:
            // CreateSurface hands out zeroed pages, so "still all zeros" is the real predicate.
            if (surfacePixelsAreBlank(state)) {
                state.gpuDirty = false;
                Logger.verbose(LogCategory.DDRAW,
                    `syncSurfaceFromMemory: DEFER empty texture 0x${state.surfacePtr.toString(16)} ` +
                    `${state.width}x${state.height} (no guest writes yet)`);
                return;
            }
            state.surfaceEverWritten = true;
            Logger.verbose(LogCategory.DDRAW,
                `syncSurfaceFromMemory: texture 0x${state.surfacePtr.toString(16)} ` +
                `${state.width}x${state.height} holds pixels with no mediated write — uploading`);
        }

        const pf = detectPixelFormat(state.format);
        const targetFormat = this.resolveSurfaceTextureFormat(state);

        // Opt-in: set globalThis.__ddrawVerboseDiag = true for first-N texture sync dumps.
        if ((globalThis as any).__ddrawVerboseDiag === true) {
        if (!(this as any)._syncDiagDone) (this as any)._syncDiagN = 0;
        if (((this as any)._syncDiagN ?? 0) < 10 && state.surfacePtr > 0 && state.width > 0) {
            (this as any)._syncDiagN = ((this as any)._syncDiagN ?? 0) + 1;
            (this as any)._syncDiagDone = ((this as any)._syncDiagN ?? 0) >= 10;
            const system = System.getInstance();
            const diagMem = system?.process?.getCurrentMemory();
            const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
            const computedPitch = state.width * bytesPerPixel;
            const pitch = (state.pitch && state.pitch >= computedPitch) ? state.pitch : computedPitch;
            const lastOffset = state.surfacePtr + (state.height - 1) * pitch + (state.width - 1) * bytesPerPixel;
            if (diagMem && lastOffset + 4 <= diagMem.length) {
                const p0 = state.surfacePtr;
                const midX = state.width >> 1;
                const midY = state.height >> 1;
                const pMid = p0 + midY * pitch + midX * bytesPerPixel;
                const readPixel = (off: number) => {
                    if (bytesPerPixel !== 4) return [diagMem[off] ?? 0, diagMem[off + 1] ?? 0, diagMem[off + 2] ?? 0, 255];
                    return [diagMem[off], diagMem[off + 1], diagMem[off + 2], diagMem[off + 3]];
                };
                const pc = readPixel(p0);
                const pm = readPixel(pMid);

                // Magenta sentinel scan: count pixels where (R>=250 && G<=5 && B>=250)
                // across N random samples in the surface. This detects colorkey-style
                // backgrounds that old casual games fill with 0xFF00FF.
                let magentaCount = 0;
                let transparentCount = 0;
                const samples = 256;
                const totalPixels = state.width * state.height;
                for (let i = 0; i < samples; i++) {
                    const fx = ((i * 2654435761) >>> 0) % state.width;
                    const fy = ((i * 40503) >>> 0) % state.height;
                    const off = p0 + fy * pitch + fx * bytesPerPixel;
                    if (off + 4 > diagMem.length) continue;
                    if (bytesPerPixel === 4) {
                        const b = diagMem[off], g = diagMem[off + 1], r = diagMem[off + 2], a = diagMem[off + 3];
                        if (r >= 250 && g <= 5 && b >= 250) magentaCount++;
                        if (a === 0) transparentCount++;
                    } else if (bytesPerPixel === 2) {
                        const w = diagMem[off] | (diagMem[off + 1] << 8);
                        if (w === 0xF81F || w === 0xFC1F) magentaCount++; // RGB565 or ARGB1555 magenta
                    }
                }

                Logger.warn(LogCategory.DDRAW,
                    `[texture-sync] syncSurface 0x${state.surfacePtr.toString(16)} ${state.width}x${state.height} ` +
                    `pf=${pf} targetFmt=${targetFormat} gpuFmt=${state.gpuTextureFormat} ` +
                    `format={bpp=${state.format.bpp} R=0x${state.format.rMask.toString(16)} G=0x${state.format.gMask.toString(16)} ` +
                    `B=0x${state.format.bMask.toString(16)} A=0x${state.format.aMask.toString(16)} flags=0x${(state.format.flags??0).toString(16)}} ` +
                    `corner=[${pc.join(",")}] center=[${pm.join(",")}] ` +
                    `samples=${samples} magentaPixels=${magentaCount} alpha0=${totalPixels > 0 ? transparentCount : 0}`);
            }
        }
        }

        // DEFER only when nobody wrote (for RenderSurface: authority=none, version=0).
        // BitmapTextureSurface never defers (always has data).
        const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;
        if (isTexture && isRenderSurface(state) && state.version === 0 && !state.gpuDirty && state.lastUploadVersion >= 0) {
            return;
        }

        // BitmapTextureSurface: Fast path - use rgbaScratch directly (authoritative RGBA)
        // RenderSurface: Check if we have cached RGBA (hasFreshRGBA)
        const expectedSize = state.width * state.height * 4;
        const hasFreshRGBA = isBitmapTexture(state) ||
            (isRenderSurface(state) &&
             state.rgbaScratch !== undefined &&
             state.rgbaScratch.length === expectedSize &&
             state.rgbaScratchVersion === state.version);

        const useTextureConverter =
            pf === PixelFormat.RGB565 ||
            pf === PixelFormat.RGB555 ||
            pf === PixelFormat.ARGB1555 ||
            pf === PixelFormat.ARGB8888 ||
            pf === PixelFormat.XRGB8888 ||
            pf === PixelFormat.PALETTE8;

        // Full-surface convertToTexture would stomp GPU pixels outside a WRITEONLY
        // dirty box (skipped readback leaves stale CPU elsewhere). Partial dirty →
        // CPU convert + uploadPartialRegion via the syncToGPU path below.
        const dirty = isRenderSurface(state) ? state.dirtyRegion : undefined;
        const dirtyIsPartial = !!(dirty &&
            (dirty.left > 0 || dirty.top > 0 ||
             dirty.right < state.width || dirty.bottom < state.height));

        // Skip GPU path if we have fresh RGBA data in rgbaScratch (use CPU path instead)
        if (useTextureConverter && state.gpuTexture && !hasFreshRGBA && !dirtyIsPartial) {
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
                this.currentRenderTarget = null;
                this.resetBindFastPath();
            }
            // Ensure encoder exists (create if needed)
            if (!this.currentEncoder) {
                this.currentEncoder = this.device.createCommandEncoder();
            }

            const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
            const computedPitch = state.width * bytesPerPixel;
            // SAFE: Only use stored pitch if it's >= computed (allows row padding)
            const pitch = (state.pitch && state.pitch >= computedPitch) ? state.pitch : computedPitch;

            if (state.pitch && state.pitch < computedPitch) {
                Logger.warn(LogCategory.DDRAW,
                    `syncSurfaceFromMemory: Invalid pitch ${state.pitch} < ${computedPitch}, using computed`);
            }

            Logger.verbose(LogCategory.DDRAW,
                `syncSurfaceFromMemory: pitch=${pitch} (stored=${state.pitch} computed=${computedPitch})`);
            const pixelCount = state.width * state.height;

            if (pixelCount >= 64 * 64) {
                const system = System.getInstance();
                const process = system?.process;
                if (process) {
                    const mem = process.getCurrentMemory();
                    // Get palette entries if needed
                    let paletteEntries: Uint32Array | undefined;
                    if (pf === PixelFormat.PALETTE8 && state.paletteHandle) {
                        const paletteObj = system.resourceProvider.getComObject(state.paletteHandle) as any;
                        if (paletteObj?.getEntries) {
                            paletteEntries = paletteObj.getEntries();
                        }
                    }

                    const traceTextureUpload = this.shouldTraceLargeTexture(state) && this.textureUploadDiagCount < 128;
                    if (traceTextureUpload) {
                        this.textureUploadDiagCount++;
                        Logger.log(LogCategory.DDRAW,
                            `syncSurfaceFromMemory: GPU upload input #${this.textureUploadDiagCount} ` +
                            `ptr=0x${state.surfacePtr.toString(16)} ${state.width}x${state.height} ` +
                            `pf=${pf} targetFmt=${targetFormat} pitch=${pitch} ` +
                            `version=${state.version} lastUpload=${state.lastUploadVersion} ` +
                            `gpuDirty=${state.gpuDirty} ` +
                            this.describeCpuSurfaceSamples(state, mem, pitch, bytesPerPixel));
                    }

                    this.textureConverter.convertToTexture(
                        this.currentEncoder,
                        mem,
                        state.surfacePtr,
                        state.width,
                        state.height,
                        pitch,
                        state.format,
                        state.gpuTexture,
                        state.srcColorKey,
                        targetFormat, // Pass format (handles bgra8unorm swizzle in Compute Shader)
                        paletteEntries
                    );
                    markGpuSyncedFromCpu(state);
                    if (isRenderSurface(state)) {
                        state.dirtyRegion = undefined;
                    }

                    // Update frame snapshot counters
                    const ddraw = system.process?.getModule("ddraw") as any;
                    if (ddraw?.incrementFrameCounter) {
                        ddraw.incrementFrameCounter("uploads");
                        ddraw.incrementFrameCounter("textureBytes", state.width * state.height * 4);
                    }

                    Logger.verbose(
                        LogCategory.DDRAW,
                        `syncSurfaceFromMemory: COMPLETED GPU path for texture 0x${state.surfacePtr.toString(16)} ${state.width}x${state.height}`
                    );
                    if (traceTextureUpload) {
                        Logger.log(LogCategory.DDRAW,
                            `syncSurfaceFromMemory: COMPLETED GPU path ` +
                            `ptr=0x${state.surfacePtr.toString(16)} ${state.width}x${state.height} ` +
                            `version=${state.version} uploaded=${state.lastUploadVersion} ` +
                            `gpuDirty=${state.gpuDirty} hasView=${!!state.gpuTextureView}`);
                    }

                    return;
                }
            }
        }

        // CPU path: use rgbaScratch directly for bitmap textures, or convert from surface memory
        const convertToRGBA = (mem: Uint8Array, s: DirectDrawSurfaceState): Uint8Array => {
            // BitmapTexture: rgbaScratch IS the authoritative pixel source (parseBMPPixels).
            // RenderSurface: guest memory is authoritative — rgbaScratch is only a cache,
            // valid solely when rgbaScratchVersion matches the current version. A size-only
            // check here permanently re-uploaded stale RGBA for sub-64×64 textures (the
            // GPU-converter path above skips them): Unreal lightmap/HUD textures update via
            // Blt (version++) but kept uploading the first-ever cached pixels → black
            // "lightmap-only" world geometry and stale HUD icons.
            const sExpectedSize = s.width * s.height * 4;
            const sHasFreshRGBA = isTexture &&
                s.rgbaScratch !== undefined &&
                s.rgbaScratch.length === sExpectedSize &&
                (isBitmapTexture(s) || s.rgbaScratchVersion === s.version);

            if (sHasFreshRGBA && s.rgbaScratch) {
                // ================================================================
                // BITMAP TEXTURE: Apply colorkey if set
                // ================================================================
                // Old D3D games set colorkey AFTER loading texture.
                // We must apply colorkey to make pixels transparent.
                if (isBitmapTexture(s) && s.srcColorKey) {
                    // Check if we need to rebuild colorkey cache
                    const needsRebuild = colorKeyChanged(s.srcColorKey, s.appliedColorKey);

                    if (needsRebuild || !s.rgbaScratchWithColorKey) {
                        Logger.log(LogCategory.DDRAW,
                            `syncSurfaceFromMemory: Applying colorkey 0x${s.srcColorKey.low.toString(16)}-` +
                            `0x${s.srcColorKey.high.toString(16)} to BitmapTexture 0x${s.surfacePtr.toString(16)}`);

                        const bytesPerPixel = Math.max(1, Math.floor(s.format.bpp / 8));
                        const pitch = s.pitch || (s.width * bytesPerPixel);

                        s.rgbaScratchWithColorKey = applyColorKeyToRGBA(
                            s.rgbaScratch,
                            mem,
                            s.surfacePtr,
                            s.width,
                            s.height,
                            pitch,
                            s.format,
                            s.srcColorKey
                        );
                        s.appliedColorKey = { ...s.srcColorKey };
                    }

                    Logger.log(LogCategory.DDRAW,
                        `syncSurfaceFromMemory: Using rgbaScratchWithColorKey for surface 0x${s.surfacePtr.toString(16)} ` +
                        `${s.width}x${s.height}`);
                    return s.rgbaScratchWithColorKey;
                }

                // No colorkey - use rgbaScratch directly (fast path)
                Logger.log(LogCategory.DDRAW,
                    `syncSurfaceFromMemory: Using rgbaScratch path for surface 0x${s.surfacePtr.toString(16)} ` +
                    `${s.width}x${s.height} (${s.rgbaScratch.length} bytes)`);
                return s.rgbaScratch;
            }

            // Log conversion path
            Logger.log(LogCategory.DDRAW,
                `syncSurfaceFromMemory: Using convertSurfaceToRGBA path for surface 0x${s.surfacePtr.toString(16)} ` +
                `${s.width}x${s.height} (rgbaScratch ${s.rgbaScratch ? 'stale' : 'undefined'})`);


            const pf = detectPixelFormat(s.format);
            const useTextureConverter =
                pf === PixelFormat.RGB565 ||
                pf === PixelFormat.RGB555 ||
                pf === PixelFormat.ARGB1555 ||
                pf === PixelFormat.ARGB8888 ||
                pf === PixelFormat.XRGB8888 ||
                pf === PixelFormat.PALETTE8;

            let rgba: Uint8Array;

            if (useTextureConverter) {
                const requiredBytes = s.width * s.height * 4;
                const outBuffer =
                    s.rgbaScratch && s.rgbaScratch.length >= requiredBytes
                        ? s.rgbaScratch.subarray(0, requiredBytes)
                        : undefined;
                
                // Get palette entries if needed
                let paletteEntries: Uint32Array | undefined;
                if (pf === PixelFormat.PALETTE8 && s.paletteHandle) {
                    const system = System.getInstance();
                    const paletteObj = system.resourceProvider.getComObject(s.paletteHandle) as any;
                    if (paletteObj?.getEntries) {
                        paletteEntries = paletteObj.getEntries();
                    }
                }

                const layout = getSurfaceFormatLayout(s.format, s.width, s.height);
                const computedPitch = Math.max(s.pitch, layout.pitch);
                // Convert to logical RGBA; upload path handles swizzle for bgra8unorm
                rgba = this.textureConverter.convertSync(
                    mem,
                    s.surfacePtr,
                    s.width,
                    s.height,
                    computedPitch,
                    s.format,
                    s.srcColorKey,
                    outBuffer,
                    "rgba8unorm",
                    paletteEntries
                );
            } else {
                // Legacy path - always returns logical RGBA
                const layout = getSurfaceFormatLayout(s.format, s.width, s.height);
                rgba = decodeSurfaceFormatToRgba8(
                    mem,
                    s.surfacePtr,
                    s.width,
                    s.height,
                    Math.max(s.pitch, layout.pitch),
                    s.format,
                    s.rgbaScratch,
                    s.srcColorKey
                );
                
                // Format conversion (RGBA/BGRA) is handled at upload time in uploadToGPUTexture
            }

            // Update rgbaScratch cache for RenderSurface only
            if (isRenderSurface(s)) {
                s.rgbaScratch = rgba;
                s.rgbaScratchVersion = s.version;
            }
            // BitmapTextureSurface: rgbaScratch is immutable, don't update
            return rgba;
        };

        const didSync = surfaceSyncManager.syncToGPU(state, this.queue, {
            convertToRGBA,
            force: true,
            uploadToGPU: (queue: GPUQueue, texture: GPUTexture, rgbaData: Uint8Array, width: number, height: number, scratch?: Uint8Array) => {
                if ((globalThis as any).__ddrawVerboseDiag === true && ((this as any)._syncDiagN ?? 0) <= 10 && rgbaData.length >= 8) {
                    Logger.warn(LogCategory.DDRAW,
                        `[texture-sync] CPU RGBA output 0x${state.surfacePtr.toString(16)}: ` +
                        `pixel0=[${rgbaData[0]},${rgbaData[1]},${rgbaData[2]},${rgbaData[3]}] ` +
                        `pixel1=[${rgbaData[4]},${rgbaData[5]},${rgbaData[6]},${rgbaData[7]}] ` +
                        `targetFmt=${targetFormat}`);
                }
                const region = isRenderSurface(state) ? state.dirtyRegion : undefined;
                // The GPU compute-shader debug paint (textureConverterDebugMode) only runs
                // for the whole-surface upload branch above; this CPU path is taken for
                // BitmapTexture fast uploads (D3D8's normal route) and must honour the same
                // flag, on a copy — rgbaData may alias the cached rgbaScratch (readback/
                // colorkey source), which must stay the real pixels.
                if (this.debugFlags.textureConverterDebugMode !== 0) {
                    const painted = rgbaData.slice();
                    applyTextureConverterDebugPaintCPU(painted, width, height, this.debugFlags.textureConverterDebugMode, state.format.bpp);
                    uploadToGPUTexture(queue, texture, painted, width, height, scratch, targetFormat, region);
                } else {
                    uploadToGPUTexture(queue, texture, rgbaData, width, height, scratch, targetFormat, region);
                }
                if (isRenderSurface(state)) {
                    state.dirtyRegion = undefined;
                }

                // Update frame snapshot counters
                const system = System.getInstance();
                const ddraw = system.process?.getModule("ddraw") as any;
                if (ddraw?.incrementFrameCounter) {
                    ddraw.incrementFrameCounter("uploads");
                    ddraw.incrementFrameCounter("textureBytes", rgbaData.byteLength);
                }
            }
        });
        if (didSync) {
            logSurfaceState(state, "syncSurfaceFromMemory done");
        }
    }

    /**
     * Kick readback prefetches for the surfaces that have been read-Locked. The caller
     * must already have flushed — the readback has to see the draws of the frame it is
     * being started for.
     *
     * Shared with D3D8, whose render surfaces are these surfaces and whose LockRect is
     * answered by this same sync manager. Its frame boundary is EndScene/Present rather
     * than a Blt, so it kicks from there instead of from endFrame.
     */
    pumpLockReadbackPrefetch(): void {
        pumpReadbackPrefetch((state) =>
            surfaceSyncManager.syncToCPU(state, this.device, this.queue, this.textureConverter, {
                fromPrefetch: true,
            })
        );
    }

    /** `box` scopes the download to the rect a Lock exposed; omit it for the whole
     *  surface. A boxed download deliberately does NOT record cpuSyncedVersion, so
     *  needsCPUSync keeps asking — that is the memo staying honest, not a failure. */
    async syncSurfaceToMemory(state: DirectDrawSurfaceState, box?: LockRect | null): Promise<void> {
        // A speculative prefetch or direct map may complete after a newer GPU write.
        // syncToCPU rejects that version at its commit point; retry version races
        // so a guest Lock never resumes with bytes from the superseded frame.
        for (let attempt = 1; ; attempt++) {
            this.flush();
            this.ensureSurfaceGPUResources(state);
            const attemptedVersion = isRenderSurface(state) ? state.version : -1;
            const synced = await surfaceSyncManager.syncToCPU(
                state, this.device, this.queue, this.textureConverter, { box }
            );
            if (synced || !surfaceSyncManager.needsCPUSync(state).needed) return;
            // False can also mean an invalid pointer, active write lease, or a GPU
            // conversion failure. Only retry the race this loop is designed for.
            if (!isRenderSurface(state) || state.version === attemptedVersion) return;
            if (attempt === 3) {
                Logger.warn(LogCategory.DDRAW,
                    `syncSurfaceToMemory: surface 0x${state.surfacePtr.toString(16)} changed during 3 readbacks; waiting for a stable version`);
            }
        }
    }

    syncSurfaceToMemoryFromScratch(state: DirectDrawSurfaceState, mem?: Uint8Array): boolean {
        const targetMem = mem ?? System.getInstance()?.process?.getCurrentMemory();
        if (!targetMem) {
            return false;
        }
        return surfaceSyncManager.syncToCPUFromScratch(state, targetMem);
    }

    uploadImageData(state: DirectDrawSurfaceState, imageData: ImageData): void {
        if (!state.gpuTexture) return;

        this.ensureSurfaceGPUResources(state);

        const width = Math.min(state.width, imageData.width);
        const height = Math.min(state.height, imageData.height);
        
        // Use unified upload function which handles format conversion (RGBA/BGRA) and padding
        // Create a view instead of copying to keep it fast (zero-copy)
        const rgbaData = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
        uploadToGPUTexture(
            this.queue,
            state.gpuTexture,
            rgbaData,
            width,
            height,
            state.rgbaPaddedScratch,
            this.resolveSurfaceTextureFormat(state)
        );

        // Update frame snapshot counters
        const system = System.getInstance();
        const ddraw = system.process?.getModule("ddraw") as any;
        if (ddraw?.incrementFrameCounter) {
            ddraw.incrementFrameCounter("uploads");
            ddraw.incrementFrameCounter("textureBytes", rgbaData.byteLength);
        }

        setAuthorityGpu(state, true);
    }

    uploadCanvasToTexture(
        state: DirectDrawSurfaceState,
        canvas: OffscreenCanvas,
        dirtyRect: { x: number, y: number, width: number, height: number } | null
    ): void {
        if (!state.gpuTexture) return;

        this.flush();

        this.ensureSurfaceGPUResources(state);

        // Use full texture size if no dirty rect
        const x = dirtyRect?.x ?? 0;
        const y = dirtyRect?.y ?? 0;
        const width = dirtyRect?.width ?? state.width;
        const height = dirtyRect?.height ?? state.height;

        // Clamp to texture bounds
        const copyWidth = Math.min(width, state.width - x);
        const copyHeight = Math.min(height, state.height - y);

        if (copyWidth <= 0 || copyHeight <= 0) return;

        // Direct GPU-to-GPU copy (blazing fast!)
        // Note: copyExternalImageToTexture requires texture format to be rgba8unorm or bgra8unorm
        // Our textures are already created with these formats in ensureSurfaceGPUResources
        this.queue.copyExternalImageToTexture(
            { 
                source: canvas,
                origin: { x, y },
                flipY: false
            },
            { 
                texture: state.gpuTexture,
                origin: { x, y, z: 0 },
                premultipliedAlpha: true,
                colorSpace: "srgb"
            },
            { width: copyWidth, height: copyHeight }
        );

        setAuthorityGpu(state, true);
        
        if (state.needsColorClear) {
            state.needsColorClear = false;
            state.clearColor = undefined;
            this.surfacesNeedingClear.delete(state);
        }
    }

    copySurface(src: DirectDrawSurfaceState, dst: DirectDrawSurfaceState): void {
        this.ensureSurfaceGPUResources(src);
        this.ensureSurfaceGPUResources(dst);

        if (!src.gpuTexture || !dst.gpuTexture) {
            Logger.warn(LogCategory.SYSTEM, `copySurface: Missing GPU textures`);
            return;
        }

        // Flush before copySurface to ensure src texture is ready
        this.flush();

        if (surfaceSyncManager.needsGPUSync(src).needed) {
            this.syncSurfaceFromMemory(src);
            // flush again to submit commands from syncSurfaceFromMemory
            // (GPU compute path creates encoder with texture conversion commands)
            this.flush();
        }

        // Check format compatibility - copyTextureToTexture requires same format
        const srcFormat = src.gpuTextureFormat ?? "rgba8unorm";
        const dstFormat = dst.gpuTextureFormat ?? "rgba8unorm";
        const formatsMatch = srcFormat === dstFormat;

        if (!formatsMatch) {
            // Formats differ (e.g., bgra8unorm vs rgba8unorm) - use shader copy
            Logger.log(LogCategory.DDRAW,
                `copySurface: Format mismatch (src=${srcFormat}, dst=${dstFormat}), using shader copy`);
            const w = Math.min(src.width, dst.width);
            const h = Math.min(src.height, dst.height);
            this.blitWithShaderCopy(src, dst,
                { left: 0, top: 0, right: w, bottom: h },
                { left: 0, top: 0, right: w, bottom: h }
            );
            this.flush();
            return;
        }

        try {
            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToTexture(
                { texture: src.gpuTexture },
                { texture: dst.gpuTexture },
                {
                    width: Math.min(src.width, dst.width),
                    height: Math.min(src.height, dst.height),
                    depthOrArrayLayers: 1,
                }
            );
            this.queue.submit([encoder.finish()]);
            setAuthorityGpu(dst, true);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `copySurface: Failed: ${e}`);
        }
    }

    /** GPU→GPU copy for Load(src,dst) when src has authority=gpu. Caller sets dst state (setAuthorityGpu). */
    copySurfaceGpuToGpu(src: DirectDrawSurfaceState, dst: DirectDrawSurfaceState): void {
        this.ensureSurfaceGPUResources(src);
        this.ensureSurfaceGPUResources(dst);
        if (!src.gpuTexture || !dst.gpuTexture) {
            Logger.warn(LogCategory.SYSTEM, `copySurfaceGpuToGpu: Missing GPU textures`);
            return;
        }
        this.flush();

        // Check format compatibility - copyTextureToTexture requires same format
        const srcFormat = src.gpuTextureFormat ?? "rgba8unorm";
        const dstFormat = dst.gpuTextureFormat ?? "rgba8unorm";
        const formatsMatch = srcFormat === dstFormat;

        if (!formatsMatch) {
            // Formats differ (e.g., bgra8unorm vs rgba8unorm) - use shader copy
            Logger.log(LogCategory.DDRAW,
                `copySurfaceGpuToGpu: Format mismatch (src=${srcFormat}, dst=${dstFormat}), using shader copy`);
            const w = Math.min(src.width, dst.width);
            const h = Math.min(src.height, dst.height);
            this.blitWithShaderCopy(src, dst,
                { left: 0, top: 0, right: w, bottom: h },
                { left: 0, top: 0, right: w, bottom: h }
            );
            this.flush();
            return;
        }

        try {
            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToTexture(
                { texture: src.gpuTexture },
                { texture: dst.gpuTexture },
                {
                    width: Math.min(src.width, dst.width),
                    height: Math.min(src.height, dst.height),
                    depthOrArrayLayers: 1,
                }
            );
            this.queue.submit([encoder.finish()]);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `copySurfaceGpuToGpu: Failed: ${e}`);
        }
    }

    /**
     * GPU blit with colorkey transparency.
     * Uses a render pass with fragment shader that discards colorkey-matching pixels.
     * This is much faster than CPU fallback for colorkey Blt operations.
     *
     * @param srcState Source surface state
     * @param dstState Destination surface state
     * @param srcRect Source rectangle in pixels
     * @param dstRect Destination rectangle in pixels
     * @param colorKey Colorkey range { low, high } in surface format
     */
    blitWithColorKey(
        srcState: DirectDrawSurfaceState,
        dstState: DirectDrawSurfaceState,
        srcRect: { left: number; top: number; right: number; bottom: number },
        dstRect: { left: number; top: number; right: number; bottom: number },
        colorKey: { low: number; high: number }
    ): void {
        this.ensureSurfaceGPUResources(srcState);
        this.ensureSurfaceGPUResources(dstState);

        if (!srcState.gpuTexture || !srcState.gpuTextureView) {
            Logger.warn(LogCategory.DDRAW, `blitWithColorKey: Source missing GPU texture`);
            return;
        }
        if (!dstState.gpuTexture || !dstState.gpuTextureView) {
            Logger.warn(LogCategory.DDRAW, `blitWithColorKey: Destination missing GPU texture`);
            return;
        }

        // Sync source from CPU to GPU if needed
        // This ensures the source texture has the latest data before the blit
        if (surfaceSyncManager.needsGPUSync(srcState).needed) {
            this.syncSurfaceFromMemory(srcState);
        }

        // Sync destination from CPU to GPU if needed!
        // If the game drew the background via Lock/Unlock (CPU), the GPU texture is stale.
        // We need the fresh background for loadOp:"load" to work correctly.
        if (surfaceSyncManager.needsGPUSync(dstState).needed) {
            Logger.log(LogCategory.DDRAW,
                `blitWithColorKey: Syncing destination 0x${dstState.surfacePtr.toString(16)} from CPU to GPU`);
            this.syncSurfaceFromMemory(dstState);
        }

        // Consume any pending deferred clear for the destination surface.
        // Without this, a prior D3D Clear stores needsColorClear=true, the Blt writes
        // pixels to the GPU texture, then the next DrawPrimitive's ensureRenderPass()
        // creates a render pass with loadOp:"clear" — overwriting the Blt result.
        if (dstState.needsColorClear) {
            dstState.needsColorClear = false;
            dstState.clearColor = undefined;
            this.surfacesNeedingClear.delete(dstState);
        }

        // End any active render pass
        if (this.currentRenderPass) {
            this.currentRenderPass.end();
            this.currentRenderPass = null;
            this.currentRenderTarget = null;
        }

        // Ensure encoder exists
        if (!this.currentEncoder) {
            this.currentEncoder = this.device.createCommandEncoder();
        }

        // Decode colorkey to normalized RGBA based on source surface pixel format
        const srcFormat = detectPixelFormat(srcState.format);
        const colorKeyLow = decodeColorKeyToRGBA(colorKey.low, srcFormat);
        const colorKeyHigh = decodeColorKeyToRGBA(colorKey.high, srcFormat);

        // Perform the blit
        this.colorKeyBlitPipeline.blit(this.currentEncoder, {
            srcView: srcState.gpuTextureView,
            srcWidth: srcState.width,
            srcHeight: srcState.height,
            dstView: dstState.gpuTextureView,
            dstFormat: this.resolveSurfaceTextureFormat(dstState),
            dstWidth: dstState.width,
            dstHeight: dstState.height,
            srcRect,
            dstRect,
            colorKeyLow,
            colorKeyHigh,
            enableColorKey: true,
        });

        // Mark destination as GPU authoritative
        setAuthorityGpu(dstState);

        Logger.log(LogCategory.DDRAW,
            `blitWithColorKey: src=0x${srcState.surfacePtr.toString(16)} -> dst=0x${dstState.surfacePtr.toString(16)} ` +
            `colorkey=0x${colorKey.low.toString(16)}-0x${colorKey.high.toString(16)}`);
    }

    /**
     * GPU blit with shader copy (no colorkey discard).
     * Useful when source/destination formats differ (copyTextureToTexture forbids that).
     */
    blitWithShaderCopy(
        srcState: DirectDrawSurfaceState,
        dstState: DirectDrawSurfaceState,
        srcRect: { left: number; top: number; right: number; bottom: number },
        dstRect: { left: number; top: number; right: number; bottom: number }
    ): void {
        // DIAGNOSTIC: Detect potentially invalid surface pointers
        // Valid surfaces have surfacePtr in the SURFACE region
        const SURFACE_REGION_START = MEM_SURFACE_BASE;
        const SURFACE_REGION_END = MEM_SURFACE_BASE + MEM_SURFACE_SIZE;
        const srcInRange = srcState.surfacePtr >= SURFACE_REGION_START && srcState.surfacePtr < SURFACE_REGION_END;
        const dstInRange = dstState.surfacePtr >= SURFACE_REGION_START && dstState.surfacePtr < SURFACE_REGION_END;

        if (!srcInRange || !dstInRange) {
            Logger.warn(LogCategory.DDRAW,
                `blitWithShaderCopy: Suspicious surface pointer(s) - src=0x${srcState.surfacePtr.toString(16)} (valid=${srcInRange}) ` +
                `dst=0x${dstState.surfacePtr.toString(16)} (valid=${dstInRange})`);
        }

        // Check if source texture was just created (no data uploaded yet)
        const srcHadTexture = !!srcState.gpuTextureView;

        this.ensureSurfaceGPUResources(srcState);
        this.ensureSurfaceGPUResources(dstState);

        if (!srcState.gpuTexture || !srcState.gpuTextureView) {
            Logger.warn(LogCategory.DDRAW, `blitWithShaderCopy: Source missing GPU texture`);
            return;
        }
        if (!dstState.gpuTexture || !dstState.gpuTextureView) {
            Logger.warn(LogCategory.DDRAW, `blitWithShaderCopy: Destination missing GPU texture`);
            return;
        }

        // DIAGNOSTIC: Warn if source texture was just created (likely empty/black)
        if (!srcHadTexture) {
            Logger.warn(LogCategory.DDRAW,
                `blitWithShaderCopy: Source texture 0x${srcState.surfacePtr.toString(16)} was just created ` +
                `(no prior data) - this may cause black output. ` +
                `width=${srcState.width} height=${srcState.height} caps=0x${srcState.caps.toString(16)}`);
        }

        if (surfaceSyncManager.needsGPUSync(srcState).needed) {
            this.syncSurfaceFromMemory(srcState);
        }
        if (surfaceSyncManager.needsGPUSync(dstState).needed) {
            Logger.verbose(LogCategory.DDRAW,
                `blitWithShaderCopy: Syncing destination 0x${dstState.surfacePtr.toString(16)} from CPU to GPU`);
            this.syncSurfaceFromMemory(dstState);
        }

        // Consume any pending deferred clear for the destination surface.
        // Without this, a prior D3D Clear stores needsColorClear=true, the Blt writes
        // pixels to the GPU texture, then the next DrawPrimitive's ensureRenderPass()
        // creates a render pass with loadOp:"clear" — overwriting the Blt result.
        if (dstState.needsColorClear) {
            dstState.needsColorClear = false;
            dstState.clearColor = undefined;
            this.surfacesNeedingClear.delete(dstState);
        }

        if (this.currentRenderPass) {
            this.currentRenderPass.end();
            this.currentRenderPass = null;
            this.currentRenderTarget = null;
        }
        if (!this.currentEncoder) {
            this.currentEncoder = this.device.createCommandEncoder();
        }

        // Dummy colorkey values; discard disabled by enableColorKey=false
        const zero = { r: 0, g: 0, b: 0, a: 0 };
        this.colorKeyBlitPipeline.blit(this.currentEncoder, {
            srcView: srcState.gpuTextureView,
            srcWidth: srcState.width,
            srcHeight: srcState.height,
            dstView: dstState.gpuTextureView,
            dstFormat: this.resolveSurfaceTextureFormat(dstState),
            dstWidth: dstState.width,
            dstHeight: dstState.height,
            srcRect,
            dstRect,
            colorKeyLow: zero,
            colorKeyHigh: zero,
            enableColorKey: false,
        });

        setAuthorityGpu(dstState);

        Logger.verbose(LogCategory.DDRAW,
            `blitWithShaderCopy: src=0x${srcState.surfacePtr.toString(16)} -> dst=0x${dstState.surfacePtr.toString(16)}`
        );
    }

    // ===== Drawing =====

    // DEBUG: Set to true to skip all rendering and measure pure overhead
    private DEBUG_SKIP_RENDERING = false;

    /** Optional harness draw observer (fade-quad probe). Null by default → the two
     *  field reads it adds per draw are the only cost when unset. When set, called
     *  at the top of drawPrimitive/drawIndexedPrimitive; returning true suppresses
     *  the draw. Installed/cleared by the `fadeProbe`/`fadeProbeOff` harness verbs. */
    public drawObserver: ((d: DrawObservation) => boolean) | null = null;

    // Effective per-stage texture-transform flags for the current draw (reused, zero-alloc).
    private texXformFlagsScratch = new Int32Array(MAX_FFP_TEX_MATRICES);

    /**
     * Resolve the effective per-stage texture-transform flags (stages 0..MAX_FFP_TEX_MATRICES-1) for a draw.
     * A stage transforms its texcoords only when BOTH a texture matrix and a non-DISABLE
     * D3DTSS_TEXTURETRANSFORMFLAGS are present (flags = count | PROJECTED, 9 bits).
     * D3D7 legacy compatibility: the D3D7 device layer supplies a stage-0 matrix without
     * ever setting TTFF — a non-identity matrix there acts as a 2-component UV transform
     * (COUNT2), preserving the previous scale/offset behavior for D3D7 titles.
     * Writes this.texXformFlagsScratch; returns true if any stage is active.
     */
    private resolveTexXformFlags(
        textureStates: Int32Array,
        texMatrices: readonly (Float32Array | null)[] | null | undefined
    ): boolean {
        const flags = this.texXformFlagsScratch;
        flags.fill(0);
        if (!texMatrices) return false;
        let any = false;
        for (let stage = 0; stage < MAX_FFP_TEX_MATRICES; stage++) {
            const m = texMatrices[stage];
            if (!m || m.length < 16) continue;
            let f = textureStates[stage * 32 + D3DTSS_TEXTURETRANSFORMFLAGS] & 0x1ff;
            if (f === 0 && stage === 0 &&
                // Fast inline identity check on the elements a 2D UV transform reads
                // (scale m0/m5, rotation m1/m4, translation m8/m9 and m12/m13).
                (m[0] !== 1 || m[5] !== 1 || m[1] !== 0 || m[4] !== 0 ||
                 m[8] !== 0 || m[9] !== 0 || m[12] !== 0 || m[13] !== 0)) {
                f = D3DTTFF_COUNT2;
            }
            if (f !== 0) {
                flags[stage] = f;
                any = true;
            }
        }
        return any;
    }

    /**
     * True if any sampling stage uses one of the three D3DTSS_TCI_CAMERASPACE* texgen modes.
     * Tested against the KNOWN values, not "any high bit set": SPHEREMAP and stale garbage in
     * the high half are not camera-space texgen, and this predicate also widens `hasTexCoords`
     * on the shared DDraw/D3D7 path — a legacy title with junk there would otherwise sample a
     * stage whose vertices carry no UVs. Camera-space texgen needs the World×View matrix,
     * which lives only in the legacy uniform slot — the MegaBatch storage slot has no room for
     * it — so such a draw must take the legacy path even with no texture matrix.
     */
    private hasCameraSpaceTexgen(textureStates: Int32Array): boolean {
        for (let stage = 0; stage < MAX_FFP_SAMPLED_STAGES; stage++) {
            const tci = textureStates[stage * 32 + D3DTSS_TEXCOORDINDEX] & ~0xffff;
            if (tci === D3DTSS_TCI_CAMERASPACENORMAL ||
                tci === D3DTSS_TCI_CAMERASPACEPOSITION ||
                tci === D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR) return true;
        }
        return false;
    }

    /**
     * Ensure GPU vertex conversion has room in the global conversion buffer.
     * If not, submit pending work first so converter can safely reuse offset 0.
     */
    private ensureGpuVertexConversionBudget(requiredBytes: number): void {
        if (!this.vertexConverter.needsSubmitForBytes(requiredBytes)) return;

        const usage = this.vertexConverter.getGlobalUsage();
        Logger.warn(
            LogCategory.SYSTEM,
            `DDrawWebGPUExecutor: vertex conversion buffer pressure ` +
                `(used=${usage.used} + next=${requiredBytes} > limit=${usage.limit}), flushing before GPU convert`
        );
        this.flush();
    }

    /**
     * Push the active device's FFP user clip planes (device-global state). Called from the
     * device's SetClipPlane; cheap repack of ≤6 vec4s into `clipPlanesPacked`. The actual GPU
     * upload is deferred to draw time (ensureClipPlanesUploaded) so it happens only when a
     * clip-ENABLED draw is issued and only when the values changed — zero cost for the common
     * (no-clip) case and correct across the shared executor's multiple device front-ends.
     */
    updateClipPlanes(planes: ReadonlyArray<{ index: number; plane: Float32Array }> | null): void {
        this.clipPlanesPacked.fill(0);
        if (planes) {
            for (const { index, plane } of planes) {
                if (index < 0 || index >= 6 || plane.length < 4) continue;
                const base = index * 4;
                this.clipPlanesPacked[base] = plane[0];
                this.clipPlanesPacked[base + 1] = plane[1];
                this.clipPlanesPacked[base + 2] = plane[2];
                this.clipPlanesPacked[base + 3] = plane[3];
            }
        }
    }

    /**
     * Ensure the device-global clip-plane buffer holds the current plane coefficients before a
     * clip-enabled draw is encoded. Only touches the GPU when the values changed. Because the
     * whole frame is encoded into one command buffer submitted at flush(), a mid-frame plane
     * change must FLUSH already-encoded draws before the buffer is overwritten — otherwise those
     * earlier draws (whose submit runs after the later writeBuffer on the queue timeline) would
     * read the new planes. Clip-plane changes are rare, so the occasional flush is negligible.
     */
    private ensureClipPlanesUploaded(): void {
        let changed = false;
        for (let i = 0; i < 24; i++) {
            if (this.clipPlanesPacked[i] !== this.clipPlanesUploaded[i]) { changed = true; break; }
        }
        if (!changed) return;
        // Submit any draws already encoded with the previous plane values first.
        if (this.currentEncoder) this.flush();
        this.queue.writeBuffer(
            this.clipPlanesBuffer, 0,
            this.clipPlanesPacked.buffer, this.clipPlanesPacked.byteOffset, FFP_CLIP_PLANES_BYTES
        );
        this.clipPlanesUploaded.set(this.clipPlanesPacked);
    }

    drawPrimitive(
        target: DirectDrawSurfaceState,
        primitiveType: number,
        vertexType: number,
        verticesAddr: number,
        count: number,
        memory: Uint8Array,
        viewport: Viewport,
        texture: DirectDrawSurfaceState | null = null,
        renderStates: Int32Array,
        textureStates: Int32Array,
        mvpMatrix?: Float32Array,
        /** Textures for stages 1..MAX_FFP_SAMPLED_STAGES-1, indexed by stage (index 0 ignored — stage 0 is `texture`). */
        stageTextures?: readonly (DirectDrawSurfaceState | null)[] | null,
        texMatrices?: readonly (Float32Array | null)[] | null,
        lighting?: FFPLightingState,
        sourceStride?: number,
        /** World×View (eye space), row-major. Optional; only consumed by the point-sprite
         *  expansion for D3DRS_POINTSCALEENABLE distance attenuation. Absent → clip.w proxy. */
        worldViewMatrix?: Float32Array | null,
        /** Fixed-function vertex blend (GPU skinning). When present, this draw is forced onto
         *  the CPU converter path so positions/normals are blended against the world-matrix
         *  palette (mvpMatrix/worldViewMatrix must already exclude world — see VertexBlendInput). */
        vertexBlend?: VertexBlendInput | null
    ): void {
        this.lastDrawDiagnostics.valid = false;
        if (this.DEBUG_SKIP_RENDERING) return;
        if (this.drawObserver && this.drawObserver({
            indexed: false, primitiveType, vertexType, vertexCount: count, verticesAddr,
            target, texture, stageTextures: stageTextures ?? null, renderStates, textureStates, memory,
        })) return;
        this.renderStats.drawReq++;
        if (this.scrubbedOut()) return;

        // Point sprites: D3DPT_POINTLIST with a real size (per-vertex PSIZE, or POINTSIZE>1px)
        // or POINTSPRITEENABLE expands each point into a screen-aligned, camera-facing quad so
        // it rasterizes as a sized sprite (WebGPU "point-list" only ever draws 1px points).
        // Everything else — including tiny 1px point lists with no sprite — falls through to the
        // legacy point-list path below, byte-identical. See shouldExpandPointSprites().
        if (primitiveType === D3DPT_POINTLIST && this.shouldExpandPointSprites(vertexType, renderStates)) {
            this.drawPointSprites(
                target, vertexType, verticesAddr, count, memory, viewport, texture,
                renderStates, textureStates, stageTextures ?? null, texMatrices ?? null,
                lighting, sourceStride, mvpMatrix, worldViewMatrix ?? null
            );
            return;
        }
        // Per-stage texture transforms and camera-space texgen live only in the legacy
        // uniform slot (the MegaBatch storage slot has no matrix / World×View fields) —
        // either one vetoes the MegaBatch path. FFP lighting vetoes it too: the MegaBatch
        // shader models only emissive + global ambient + the first directional light,
        // while the legacy path runs the full ffpLightSet (point/spot/attenuation/specular)
        // — a point-lit scene under the MegaBatch model renders BLACK (Max Payne in-game).
        const texXformActive = this.resolveTexXformFlags(textureStates, texMatrices);
        // FFP user clip planes veto the MegaBatch path (its 512-byte storage slot carries no
        // clip-plane-enable word); a clip-enabled draw falls to the legacy per-draw uniform
        // path. ensureClipPlanesUploaded refreshes the device-global binding-6 buffer (and
        // flushes prior draws on a value change) only when a plane is actually enabled.
        const clipPlaneEnable = renderStates[D3DRENDERSTATE_CLIPPLANEENABLE] | 0;
        if (clipPlaneEnable !== 0) this.ensureClipPlanesUploaded();
        const megaBatchEnabled = !this.debugFlags.disableMegaBatch && !texXformActive &&
            !this.hasCameraSpaceTexgen(textureStates) &&
            !(renderStates[D3DRENDERSTATE_LIGHTING] | 0) &&
            clipPlaneEnable === 0;
        const megaBatchAccumulate = !this.debugFlags.disableMegaBatch && !this.debugFlags.disableMegaBatchAccumulate;
        // Vertex-blend draws MUST use the CPU converter (the GPU compute shader has no palette);
        // force the threshold to +∞ so the count-based branch below always picks the CPU path.
        const blendActive = !!vertexBlend && vertexBlend.count >= (vertexBlend.indexed ? 1 : 2);
        // So must a PRE-TRANSFORMED draw, for its own reason — see rhwPinnedDraws.
        const rhwPosition = (vertexType & D3DFVF_POSITION_MASK) === D3DFVF_XYZRHW;
        const preTransformed = !this.debugFlags.disableRhwCpuPin && rhwPosition;
        const gpuVertexThreshold = (this.debugFlags.forceCpuVertexPath || blendActive || preTransformed)
            ? Number.MAX_SAFE_INTEGER : GPU_VERTEX_THRESHOLD;


        // Calculate required buffer sizes
        const packedStride = computeFvfStride(vertexType);
        const stride = sourceStride && sourceStride > 0 ? Math.max(sourceStride, packedStride) : packedStride;
        const isTriangleFan = primitiveType === D3DPT_TRIANGLEFAN && count >= 3;
        let drawCount = count;
        if (isTriangleFan) {
            drawCount = (count - 2) * 3;
        }
        const requiredVertexBytes = drawCount * OUTPUT_VERTEX_BYTES;
        const requiredUniformBytes = this.ringBufferManager.getUniformAlignment();

        // Only reserve ring-buffer vertex bytes for CPU-path draws.
        // GPU-path draws (count >= GPU_VERTEX_THRESHOLD, non-fan) go to globalVertexBuffer.
        // TriangleFan always uses CPU path (needs expansion).
        const willUseCpuPath = isTriangleFan || count < gpuVertexThreshold;
        // Coverage: only a draw the pin actually diverted. A fan is CPU-converted on this path
        // whatever its count, so the pin changed nothing there.
        if (preTransformed && !isTriangleFan && count >= GPU_VERTEX_THRESHOLD) this.rhwPinnedDraws++;
        const ringVertexBytes = willUseCpuPath ? requiredVertexBytes : 0;
        const storageBytes = megaBatchEnabled ? DEFAULT_STORAGE_BUFFER_CONFIG.slotSize : 0;

        // Ensure space in ring buffers
        this.ringBufferManager.ensureSpaceForDraw(ringVertexBytes, 0, requiredUniformBytes, () => {
            this.renderStats.midFrameFlush++;
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
            }
            // Only flush if ring buffer is full - this is a necessary sync point
            this.flush();
        }, storageBytes);

        // Hint: batchable primitives that will use MegaBatch path → skip legacy uniform allocation
        // Only skip when draw is small enough to batch and primitive type is batchable
        const isBatchableHint = megaBatchEnabled && drawCount <= 8192 && (
            primitiveType === D3DPT_TRIANGLESTRIP ||
            primitiveType === D3DPT_TRIANGLELIST ||
            primitiveType === D3DPT_TRIANGLEFAN);

        // Prepare draw
        const _tPrep = drawCostProfiler.now();
        const prepareResult = this.prepareDraw(
            target,
            vertexType,
            primitiveType,
            viewport,
            texture,
            renderStates,
            textureStates,
            mvpMatrix,
            stageTextures ?? null,
            isBatchableHint,
            texMatrices,
            lighting
        );
        maybeClampContainedUv(this, prepareResult, memory, verticesAddr, count, stride, vertexType);
        drawCostProfiler.add(DC.prepare, _tPrep);

        if (!target.gpuTextureView) {
            this.renderStats.skipNoRT++;
            return;
        }

        const vertexRange = count * stride;
        if (!isValidAddress(memory, verticesAddr, vertexRange)) {
            this.renderStats.skipBadRange++;
            Logger.warn(
                LogCategory.SYSTEM,
                `DDrawWebGPUExecutor: Invalid vertex range 0x${verticesAddr.toString(16)}+${vertexRange}`
            );

            return;
        }

        const safeViewport = sanitizeViewportInto(this.safeVpScratchDraw, viewport, target.width, target.height);

        // Convert vertices via VertexConverter
        // Use GPU path for large batches (no readback), CPU for small batches or TriangleFan (needs expansion)
        const _tConv = drawCostProfiler.now();
        let convertedData: Uint8Array | null = null;
        let gpuConversionResult: GpuVertexConversionResult | null = null;
        let useNativeTopology = false;

        if (primitiveType === D3DPT_TRIANGLEFAN && count >= 3) {
            // TriangleFan needs expansion, use CPU path for now
            const convSize = count * OUTPUT_VERTEX_BYTES;
            const expSize = drawCount * OUTPUT_VERTEX_BYTES;
            const scratch = this.ensureScratchBuffer(convSize + expSize);
            const scratchA = scratch.subarray(0, convSize);
            const expanded = scratch.subarray(convSize, convSize + expSize);

            this.vertexConverter.convertSync(
                memory,
                verticesAddr,
                count,
                vertexType,
                scratchA,
                safeViewport.width,
                safeViewport.height,
                stride,
                vertexBlend ?? null,
                safeViewport.x,
                safeViewport.y
            );

            // Optimize TriangleFan expansion to avoid subarray allocations in tight loop.
            const scratchA32 = new Int32Array(scratchA.buffer, scratchA.byteOffset, scratchA.length / 4);
            const expanded32 = new Int32Array(expanded.buffer, expanded.byteOffset, expanded.length / 4);
            const vertexInt32Count = OUTPUT_VERTEX_BYTES / 4; // 16 int32s per vertex (64 bytes)

            for (let i = 0; i < count - 2; i++) {
                const v0 = 0;
                const v1 = i + 1;
                const v2 = i + 2;
                const dstBase = i * 3 * vertexInt32Count; // 3 vertices per triangle

                // Copy vertex 0 (fan center)
                const src0Base = v0 * vertexInt32Count;
                for (let j = 0; j < vertexInt32Count; j++) {
                    expanded32[dstBase + j] = scratchA32[src0Base + j];
                }

                // Copy vertex 1
                const src1Base = v1 * vertexInt32Count;
                const dst1Base = dstBase + vertexInt32Count;
                for (let j = 0; j < vertexInt32Count; j++) {
                    expanded32[dst1Base + j] = scratchA32[src1Base + j];
                }

                // Copy vertex 2
                const src2Base = v2 * vertexInt32Count;
                const dst2Base = dstBase + vertexInt32Count * 2;
                for (let j = 0; j < vertexInt32Count; j++) {
                    expanded32[dst2Base + j] = scratchA32[src2Base + j];
                }
            }
            convertedData = expanded;
        } else if (count >= gpuVertexThreshold) {
            // A pre-transformed draw reaching the GPU converter IS the defect the pin exists
            // to prevent; count it whatever put it here, kill switch included.
            if (rhwPosition) this.rhwGpuConversions++;
            this.ensureGpuVertexConversionBudget(count * OUTPUT_VERTEX_BYTES);
            // The compute converter cannot run inside a render pass, so the pass has to end
            // here — and a batch must not outlive the pass it was opened for. Its draws are
            // still unencoded; leaving them pending puts them in a pass opened LATER, after
            // work the guest issued after them. Flush first, then close: same draw-order rule
            // the texture-sync path already follows. The bind fast-path describes bindings
            // that lived in the closed pass, so it goes too.
            if (this.currentBatch) this.flushBatch();
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
                this.currentRenderTarget = null;
                this.resetBindFastPath();
            }
            if (!this.currentEncoder) {
                this.currentEncoder = this.device.createCommandEncoder();
            }

            useNativeTopology = primitiveType === D3DPT_TRIANGLESTRIP && count >= 3;
            gpuConversionResult = this.vertexConverter.convertToGpuBuffer(
                this.currentEncoder!,
                memory,
                verticesAddr,
                count,
                vertexType,
                safeViewport.width,
                safeViewport.height,
                stride,
                safeViewport.x,
                safeViewport.y
            );
            if (!gpuConversionResult) {
                this.renderStats.gpuConvFallback++;
                Logger.warn(LogCategory.SYSTEM, `drawPrimitive: GPU conversion failed, falling back to CPU`);
                const requiredSize = count * OUTPUT_VERTEX_BYTES;
                const scratch = this.ensureScratchBuffer(requiredSize);
                convertedData = this.vertexConverter.convertSync(
                    memory,
                    verticesAddr,
                    count,
                    vertexType,
                    scratch,
                    safeViewport.width,
                    safeViewport.height,
                    stride,
                    null,
                    safeViewport.x,
                    safeViewport.y
                );
            }
        } else {
            // Use CPU path for small batches
            useNativeTopology = primitiveType === D3DPT_TRIANGLESTRIP && count >= 3;
            const requiredSize = count * OUTPUT_VERTEX_BYTES;
            const scratch = this.ensureScratchBuffer(requiredSize);
            convertedData = this.vertexConverter.convertSync(
                memory,
                verticesAddr,
                count,
                vertexType,
                scratch,
                safeViewport.width,
                safeViewport.height,
                stride,
                vertexBlend ?? null,
                safeViewport.x,
                safeViewport.y
            );
        }

        drawCostProfiler.add(DC.vconvert, _tConv);

        // Allocate vertex data in ring buffer
        const _tRing = drawCostProfiler.now();
        let vBuffer: GPUBuffer;
        let vOffset: number;
        let vSize: number;
        if (gpuConversionResult) {
            // GPU path: result already contains buffer and offset from global vertex buffer
            // No need to copy again - use directly
            vBuffer = gpuConversionResult.buffer;
            vOffset = gpuConversionResult.offset;
            vSize = gpuConversionResult.size;
        } else if (convertedData && convertedData.length > 0) {
            this.countNanVerts(convertedData, drawCount);
            // CPU path: copy from CPU array to ring buffer
            const alloc = this.ringBufferManager.allocateVertexData(convertedData);
            if (alloc.overflow) {
                this.renderStats.skipRingOverflow++;
                return; // Skip draw — ring buffer full, no valid vertex data
            }
            vBuffer = alloc.buffer;
            vOffset = alloc.offset;
            vSize = convertedData.length; // Use actual converted data size (may be expanded for fan)
        } else {
            this.renderStats.skipNoData++;
            Logger.error(LogCategory.SYSTEM, `drawPrimitive: No converted vertex data`);

            return;
        }
        drawCostProfiler.add(DC.ringup, _tRing);

        // Per-stage batch-compatibility keys (texture versions + sampler keys).
        const _tSubmit = drawCostProfiler.now();
        this.computeStageBatchKeys(prepareResult, texture, stageTextures ?? null);

        // MegaBatch: Allow batching WITHOUT uniformOffset constraint
        // Each draw gets its own drawIndex into storage buffer
        const allowBatch = true;

        // Check if we can batch this draw call
        // MEGABATCH KEY CHANGE: Removed uniformOffset from compatibility check!
        // Per-draw uniforms are in storage buffer, indexed by drawIndex
        const isBatchablePrimitive = primitiveType === D3DPT_TRIANGLESTRIP ||
                                     primitiveType === D3DPT_TRIANGLELIST ||
                                     primitiveType === D3DPT_TRIANGLEFAN;

        // Get MegaBatch pipeline for comparison (cached, very fast lookup)
        const megaBatchPipeline = megaBatchEnabled && isBatchablePrimitive
            ? this.pipelineFactory.getOrCreateMegaBatchPipeline(
                vertexType,
                primitiveType,
                this.ffpStages,
                false,
                renderStates,
                texture
            )
            : null;

        // Normalize viewport once — used in canBatch check and in currentBatch creation below.
        const vpX = viewport.x || 0;
        const vpY = viewport.y || 0;
        const vpW = viewport.width || target.width || 640;
        const vpH = viewport.height || target.height || 480;
        const vpMinZ = viewport.minZ ?? 0;
        const vpMaxZ = viewport.maxZ ?? 1;

        const canBatch = megaBatchEnabled &&
            megaBatchAccumulate &&
            allowBatch &&
            isBatchablePrimitive &&
            megaBatchPipeline !== null &&
            this.currentBatch !== null &&
            this.currentBatch.useMegaBatch && // Must be MegaBatch mode
            this.currentBatch.target === target &&
            this.currentBatch.pipeline === megaBatchPipeline && // Compare MegaBatch pipelines
            // REMOVED: this.currentBatch.uniformOffset === prepareResult.uniformOffset
            this.batchStageStateCompatible(this.currentBatch, prepareResult) &&
            this.currentBatch.vertexBuffer === vBuffer &&
            this.currentBatch.primitiveType === primitiveType &&
            this.currentBatch.stencilRef === prepareResult.stencilRef &&
            // Viewport is set once per render pass (not per draw). Accumulating
            // draws with different viewports would render them all under the
            // first viewport — break the batch instead.
            this.currentBatch.viewport.x === vpX &&
            this.currentBatch.viewport.y === vpY &&
            this.currentBatch.viewport.width === vpW &&
            this.currentBatch.viewport.height === vpH &&
            this.currentBatch.viewport.minZ === vpMinZ &&
            this.currentBatch.viewport.maxZ === vpMaxZ &&
            !this.currentBatch.indexBuffer; // Only batch non-indexed draws

        if (canBatch && this.currentBatch) {
            // Add to existing MegaBatch - each draw has its own drawIndex
            if (this.opLogArmed > 0) this.opLog(`BATCH+ v=${useNativeTopology ? count : drawCount} z=${renderStates[D3DRENDERSTATE_ZENABLE]|0} zw=${renderStates[D3DRENDERSTATE_ZWRITEENABLE]|0} zb=${renderStates[D3DRENDERSTATE_ZBIAS]|0} bl=${renderStates[D3DRENDERSTATE_ALPHABLENDENABLE]|0} sb=${renderStates[D3DRENDERSTATE_SRCBLEND]|0} db=${renderStates[D3DRENDERSTATE_DESTBLEND]|0} tex=${!!texture}`);
            const vertexOffset = vOffset / OUTPUT_VERTEX_BYTES;
            this.currentBatch.draws.push({
                firstVertex: vertexOffset,
                vertexCount: useNativeTopology ? count : drawCount,
                drawIndex: prepareResult.drawIndex, // MegaBatch: per-draw storage buffer index
                vertexBufferOffset: vOffset,
                vertexBufferSize: vSize,
            });
            this.currentBatch.vertexCount += (useNativeTopology ? count : drawCount);
        } else {
            // Flush previous batch if exists
            this.flushBatch();

            // Start new batch or draw immediately
            // Note: TRIANGLEFAN is expanded to TRIANGLELIST data, so it's batchable
            const shouldBatch = megaBatchEnabled &&
                allowBatch &&
                isBatchablePrimitive &&
                drawCount <= 8192;

            if (shouldBatch && megaBatchPipeline) {
                // Start new MegaBatch - reuse megaBatchPipeline computed above
                if (this.opLogArmed > 0) this.opLog(`BATCH-NEW v=${useNativeTopology ? count : drawCount} z=${renderStates[D3DRENDERSTATE_ZENABLE]|0} zw=${renderStates[D3DRENDERSTATE_ZWRITEENABLE]|0} zb=${renderStates[D3DRENDERSTATE_ZBIAS]|0} bl=${renderStates[D3DRENDERSTATE_ALPHABLENDENABLE]|0} sb=${renderStates[D3DRENDERSTATE_SRCBLEND]|0} db=${renderStates[D3DRENDERSTATE_DESTBLEND]|0} tex=${!!texture}`);
                const vertexOffset = vOffset / OUTPUT_VERTEX_BYTES;

                // Create MegaBatch bind group bound to the WHOLE storage buffer.
                // flushBatch passes draw.drawIndex as firstInstance, so the shader's
                // instance_index is an absolute index into draws[]. Binding a slice
                // at drawIndex*slotSize would put out-of-range slots out of view once
                // a batch accumulates more than one draw.
                const storageBuffer = this.ringBufferManager.getCurrentStorageBuffer();
                const megaBatchBindGroup = this.bindGroupManager.createMegaBatchBindGroup(
                    storageBuffer,
                    prepareResult.sampledMask,
                    prepareResult.stageViews,
                    prepareResult.stageSamplers,
                    this.dummyTextureView
                );

                // Ensure render pass is active
                this.ensureRenderPass(target, viewport);

                this.currentBatch = {
                    target,
                    viewport: {
                        x: vpX,
                        y: vpY,
                        width: vpW,
                        height: vpH,
                        minZ: vpMinZ,
                        maxZ: vpMaxZ,
                    },
                    pipeline: megaBatchPipeline, // MegaBatch pipeline with storage buffer
                    bindGroup: megaBatchBindGroup, // Used for legacy fallback
                    uniformOffset: prepareResult.uniformOffset,
                    lightsOffset: prepareResult.lightsOffset,
                    sampledMask: prepareResult.sampledMask,
                    stageVersions: Array.from(this.stageVersionsScratch),
                    stageViews: prepareResult.stageViews.slice(),
                    stageSamplerKeys: Array.from(this.stageSamplerKeysScratch),
                    vertexBuffer: vBuffer,
                    firstVertex: vertexOffset,
                    vertexCount: useNativeTopology ? count : drawCount,
                    vertexSize: OUTPUT_VERTEX_BYTES,
                    primitiveType,
                    draws: [{
                        firstVertex: vertexOffset,
                        vertexCount: useNativeTopology ? count : drawCount,
                        drawIndex: prepareResult.drawIndex, // MegaBatch: storage buffer index
                        vertexBufferOffset: vOffset,
                        vertexBufferSize: vSize,
                    }],
                    // MegaBatch mode
                    useMegaBatch: true,
                    storageBuffer,
                    megaBatchBindGroup,
                    stencilRef: prepareResult.stencilRef,
                };
            } else {
                // Draw immediately (large draws or incompatible types)
                this.ensureRenderPass(target, viewport);
                this.setupPipelineAndBindings(prepareResult);

                // Pass size to setVertexBuffer to prevent reading beyond vertex data in ring buffer
                this.currentRenderPass!.setVertexBuffer(0, vBuffer, vOffset, vSize);
                this.currentRenderPass!.draw(useNativeTopology ? count : drawCount);
                if (this.opLogArmed > 0) this.opLog(`DRAW-IMM v=${useNativeTopology ? count : drawCount} lit=${(renderStates[D3DRENDERSTATE_LIGHTING] | 0) !== 0} z=${renderStates[D3DRENDERSTATE_ZENABLE] | 0} zw=${renderStates[D3DRENDERSTATE_ZWRITEENABLE] | 0} vp=${viewport.x||0},${viewport.y||0},${viewport.width},${viewport.height},${viewport.minZ??0},${viewport.maxZ??1}`);
                setAuthorityGpu(target, true);

                // Update frame snapshot counters
                if (!this.cachedDDrawModuleResolved) {
                    this.cachedDDrawModuleResolved = true;
                    this.cachedDDrawModule = System.getInstance().process?.getModule("ddraw");
                }
                if (this.cachedDDrawModule?.incrementFrameCounter) {
                    this.cachedDDrawModule.incrementFrameCounter("vertexBytes", vSize);
                }
            }
        }
        drawCostProfiler.add(DC.submit, _tSubmit);
        drawCostProfiler.countDraw(false);

        // setAuthorityGpu lives in flushBatch — calling it here double-bumps
        // version for immediate draws and bumps early for batched draws.
    }

    drawIndexedPrimitive(
        target: DirectDrawSurfaceState,
        primitiveType: number,
        vertexType: number,
        verticesAddr: number,
        vCount: number,
        indicesAddr: number,
        iCount: number,
        memory: Uint8Array,
        viewport: Viewport,
        texture: DirectDrawSurfaceState | null = null,
        renderStates: Int32Array,
        textureStates: Int32Array,
        mvpMatrix?: Float32Array,
        /** Textures for stages 1..MAX_FFP_SAMPLED_STAGES-1, indexed by stage (index 0 ignored — stage 0 is `texture`). */
        stageTextures?: readonly (DirectDrawSurfaceState | null)[] | null,
        texMatrices?: readonly (Float32Array | null)[] | null,
        vertexIndexBase: number = 0,
        lighting?: FFPLightingState,
        sourceStride?: number,
        indexIsUint32: boolean = false,
        /** Fixed-function vertex blend (GPU skinning). When present, this draw is forced onto
         *  the CPU converter path so positions/normals are blended against the world-matrix
         *  palette (mvpMatrix/worldViewMatrix must already exclude world — see VertexBlendInput). */
        vertexBlend?: VertexBlendInput | null
    ): void {
        this.lastDrawDiagnostics.valid = false;
        if (this.DEBUG_SKIP_RENDERING) return;
        if (this.drawObserver && this.drawObserver({
            indexed: true, primitiveType, vertexType, vertexCount: vCount, verticesAddr,
            target, texture, stageTextures: stageTextures ?? null, renderStates, textureStates, memory,
        })) return;
        this.renderStats.drawReq++;
        this.renderStats.drawIndexedReq++;
        if (this.scrubbedOut()) return;
        // Per-stage texture transforms and camera-space texgen live only in the legacy
        // uniform slot (the MegaBatch storage slot has no matrix / World×View fields) —
        // either one vetoes the MegaBatch path. FFP lighting vetoes it too: the MegaBatch
        // shader models only emissive + global ambient + the first directional light,
        // while the legacy path runs the full ffpLightSet (point/spot/attenuation/specular)
        // — a point-lit scene under the MegaBatch model renders BLACK (Max Payne in-game).
        const texXformActive = this.resolveTexXformFlags(textureStates, texMatrices);
        // FFP user clip planes veto the MegaBatch path (its 512-byte storage slot carries no
        // clip-plane-enable word); a clip-enabled draw falls to the legacy per-draw uniform
        // path. ensureClipPlanesUploaded refreshes the device-global binding-6 buffer (and
        // flushes prior draws on a value change) only when a plane is actually enabled.
        const clipPlaneEnable = renderStates[D3DRENDERSTATE_CLIPPLANEENABLE] | 0;
        if (clipPlaneEnable !== 0) this.ensureClipPlanesUploaded();
        const megaBatchEnabled = !this.debugFlags.disableMegaBatch && !texXformActive &&
            !this.hasCameraSpaceTexgen(textureStates) &&
            !(renderStates[D3DRENDERSTATE_LIGHTING] | 0) &&
            clipPlaneEnable === 0;
        const megaBatchAccumulate = !this.debugFlags.disableMegaBatch && !this.debugFlags.disableMegaBatchAccumulate;
        // Vertex-blend draws MUST use the CPU converter (the GPU compute shader has no palette);
        // force the threshold to +∞ so the count-based branch below always picks the CPU path.
        const blendActive = !!vertexBlend && vertexBlend.count >= (vertexBlend.indexed ? 1 : 2);
        // So must a PRE-TRANSFORMED draw, for its own reason — see rhwPinnedDraws.
        const rhwPosition = (vertexType & D3DFVF_POSITION_MASK) === D3DFVF_XYZRHW;
        const preTransformed = !this.debugFlags.disableRhwCpuPin && rhwPosition;
        const gpuVertexThreshold = (this.debugFlags.forceCpuVertexPath || blendActive || preTransformed)
            ? Number.MAX_SAFE_INTEGER : GPU_VERTEX_THRESHOLD;


        const _tIScan = drawCostProfiler.now();
        const packedStride = computeFvfStride(vertexType);
        const stride = sourceStride && sourceStride > 0 ? Math.max(sourceStride, packedStride) : packedStride;
        // Rebase to the smallest index actually referenced. D3D7 titles commonly pass
        // the full 32768-vertex scratch capacity while each draw touches a small window
        // near the tail. Uploading [0..maxIndex] made Half-Life convert 8-13 MiB of
        // vertices per frame and amplified any out-of-range index into giant polygons.
        // This is algebraically exact: shift the source pointer by minIndex and subtract
        // the same value from every index before uploading it.
        void vertexIndexBase;

        // D3D7 DrawIndexedPrimitive ABI uses WORD* indices, so uint16 is the default.
        // Callers that know the real index width (d3d8 with a declared INDEX32 buffer)
        // pin it via indexIsUint32 — the uint16 range of a 32-bit buffer is still
        // in-bounds, so the size heuristic below can't detect it on its own.
        let isUint32Indices = indexIsUint32;
        let indexDataSize = iCount * (isUint32Indices ? 4 : 2);
        if (!isValidAddress(memory, indicesAddr, indexDataSize)) {
            // Only probe the wider width when the caller didn't pin the format.
            const fallbackIndexSize = iCount * 4;
            if (!indexIsUint32 && isValidAddress(memory, indicesAddr, fallbackIndexSize)) {
                isUint32Indices = true;
                indexDataSize = fallbackIndexSize;
                Logger.warn(
                    LogCategory.DDRAW,
                    `drawIndexedPrimitive: invalid uint16 index range at 0x${indicesAddr.toString(16)}; using uint32 fallback`
                );
            } else {
                this.renderStats.skipBadRange++;
                Logger.warn(
                    LogCategory.SYSTEM,
                    `DDrawWebGPUExecutor: Invalid index range 0x${indicesAddr.toString(16)} + ${indexDataSize} bytes`
                );
                return;
            }
        }
        // Scan index array to find the actual maximum vertex index referenced.
        // DrawIndexedPrimitiveVB passes the entire VB capacity as vCount, but indices
        // typically reference only a small subset. Without this, we convert/upload ALL
        // vCount vertices (e.g. 65536) when indices may only reference ~500, causing
        // 100x+ overallocation and ring buffer overflow.
        
        let minRawIdx = Number.MAX_SAFE_INTEGER;
        let maxRawIdx = 0;
        if (iCount > 0 && isValidAddress(memory, indicesAddr, indexDataSize)) {
            // memory is a Uint8Array view into WASM linear memory with
            // byteOffset ~9.5MB. Must add memory.byteOffset when constructing
            // TypedArray views from memory.buffer.
            const baseOff = memory.byteOffset + indicesAddr;
            if (isUint32Indices) {
                // Use DataView to avoid alignment issues (indicesAddr may not be 4-aligned)
                const dv = new DataView(memory.buffer, baseOff, iCount * 4);
                for (let i = 0; i < iCount; i++) {
                    const rawIdx = dv.getUint32(i * 4, true);
                    if (rawIdx < minRawIdx) minRawIdx = rawIdx;
                    if (rawIdx > maxRawIdx) maxRawIdx = rawIdx;
                }
            } else {
                const dv = new DataView(memory.buffer, baseOff, iCount * 2);
                for (let i = 0; i < iCount; i++) {
                    const rawIdx = dv.getUint16(i * 2, true);
                    if (rawIdx < minRawIdx) minRawIdx = rawIdx;
                    if (rawIdx > maxRawIdx) maxRawIdx = rawIdx;
                }
            }
        }
        if (iCount > 0 && maxRawIdx >= vCount) {
            this.renderStats.skipBadRange++;
            Logger.warn(
                LogCategory.SYSTEM,
                `drawIndexedPrimitive: vertex index ${maxRawIdx} is outside vCount=${vCount}`
            );
            return;
        }
        const appliedIndexBase = iCount > 0 && minRawIdx !== Number.MAX_SAFE_INTEGER ? minRawIdx : 0;
        const sourceVerticesAddr = appliedIndexBase > 0
            ? verticesAddr + appliedIndexBase * stride
            : verticesAddr;
        const availableVertexCount = appliedIndexBase > 0
            ? (vCount - appliedIndexBase)
            : vCount;
        const effectiveMaxIdx = maxRawIdx - appliedIndexBase;
        const effectiveVCount = iCount > 0
            ? Math.min(availableVertexCount, effectiveMaxIdx + 1)
            : availableVertexCount;
        const effectiveVertexBytes = effectiveVCount * OUTPUT_VERTEX_BYTES;
        // Coverage, against the count the choice is actually made on: vCount is the whole VB
        // capacity here, while the indices typically reference a small window of it.
        if (preTransformed && effectiveVCount >= GPU_VERTEX_THRESHOLD) this.rhwPinnedDraws++;

        const requiredUniformBytes = this.ringBufferManager.getUniformAlignment();

        // Calculate final index size (may be expanded for triangle fan)
        let finalIndexSize = indexDataSize;
        if (primitiveType === D3DPT_TRIANGLEFAN && iCount >= 3) {
            const expandedCount = (iCount - 2) * 3;
            const bytesPerIndex = isUint32Indices ? 4 : 2;
            finalIndexSize = expandedCount * bytesPerIndex;
        }

        // Ensure space — only reserve ring-buffer vertex bytes for CPU-path draws.
        // Draws with effectiveVCount >= GPU_VERTEX_THRESHOLD use the GPU compute path and
        // land in globalVertexBuffer (VertexConverter), NOT the ring buffer.
        // Passing vertex bytes for GPU-path draws causes false overflow detection:
        // the ring buffer would flush and stall even though no ring-buffer space is needed.
        const ringVertexBytes = effectiveVCount >= gpuVertexThreshold ? 0 : effectiveVertexBytes;
        const storageBytes = megaBatchEnabled ? DEFAULT_STORAGE_BUFFER_CONFIG.slotSize : 0;
        this.ringBufferManager.ensureSpaceForDraw(ringVertexBytes, finalIndexSize, requiredUniformBytes, () => {
            this.renderStats.midFrameFlush++;
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
            }
            // Only flush if ring buffer is full - this is a necessary sync point
            this.flush();
        }, storageBytes);

        drawCostProfiler.add(DC.iscan, _tIScan);

        // Hint: batchable primitives that will use MegaBatch path → skip legacy uniform allocation
        const isBatchableHint = megaBatchEnabled &&
            iCount <= 8192 && primitiveType !== D3DPT_TRIANGLEFAN && (
            primitiveType === D3DPT_TRIANGLESTRIP ||
            primitiveType === D3DPT_TRIANGLELIST);

        // Prepare draw
        const _tPrep = drawCostProfiler.now();
        const prepareResult = this.prepareDraw(
            target,
            vertexType,
            primitiveType,
            viewport,
            texture,
            renderStates,
            textureStates,
            mvpMatrix,
            stageTextures ?? null,
            isBatchableHint,
            texMatrices,
            lighting
        );
        maybeClampContainedUv(this, prepareResult, memory, sourceVerticesAddr, effectiveVCount, stride, vertexType);
        drawCostProfiler.add(DC.prepare, _tPrep);

        if (!target.gpuTextureView) {
            this.renderStats.skipNoRT++;
            if (++this.drawSkipNoTargetCount % 100 === 1 &&
                Logger.isEnabled(LogCategory.DDRAW, LogLevel.VERBOSE)) {
                Logger.verbose(LogCategory.DDRAW, "drawIndexedPrimitive: skip (no gpuTextureView)");
            }

            return;
        }

        const vertexRange = effectiveVCount * stride;
        if (!isValidAddress(memory, sourceVerticesAddr, vertexRange)) {
            this.renderStats.skipBadRange++;
            Logger.warn(
                LogCategory.SYSTEM,
                `DDrawWebGPUExecutor: Invalid vertex range 0x${sourceVerticesAddr.toString(16)}+${vertexRange}`
            );

            return;
        }

        // Convert vertices - use GPU path for large batches
        // Use effectiveVCount (clamped by max index) to avoid converting unreferenced vertices.
        const safeViewport = sanitizeViewportInto(this.safeVpScratchIndexed, viewport, target.width, target.height);

        const _tConv = drawCostProfiler.now();
        let convertedData: Uint8Array | null = null;
        let gpuConversionResult: GpuVertexConversionResult | null = null;

        if (effectiveVCount >= gpuVertexThreshold) {
            if (rhwPosition) this.rhwGpuConversions++;
            this.ensureGpuVertexConversionBudget(effectiveVCount * OUTPUT_VERTEX_BYTES);
            // GPU path requires ending current render pass
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
                this.currentRenderTarget = null;
            }
            if (!this.currentEncoder) {
                this.currentEncoder = this.device.createCommandEncoder();
            }

            gpuConversionResult = this.vertexConverter.convertToGpuBuffer(
                this.currentEncoder!,
                memory,
                sourceVerticesAddr,
                effectiveVCount,
                vertexType,
                safeViewport.width,
                safeViewport.height,
                stride,
                safeViewport.x,
                safeViewport.y
            );
            if (!gpuConversionResult) {
                this.renderStats.gpuConvFallback++;
                Logger.warn(LogCategory.SYSTEM, `drawIndexedPrimitive: GPU conversion failed, falling back to CPU`);
                const requiredSize = effectiveVCount * OUTPUT_VERTEX_BYTES;
                const scratch = this.ensureScratchBuffer(requiredSize);
                convertedData = this.vertexConverter.convertSync(
                    memory,
                    sourceVerticesAddr,
                    effectiveVCount,
                    vertexType,
                    scratch,
                    safeViewport.width,
                    safeViewport.height,
                    stride,
                    vertexBlend ?? null,
                    safeViewport.x,
                    safeViewport.y
                );
            }
        } else {
            // Use CPU path for small batches
            const requiredSize = effectiveVCount * OUTPUT_VERTEX_BYTES;
            const scratch = this.ensureScratchBuffer(requiredSize);
            convertedData = this.vertexConverter.convertSync(
                memory,
                sourceVerticesAddr,
                effectiveVCount,
                vertexType,
                scratch,
                safeViewport.width,
                safeViewport.height,
                stride,
                null,
                safeViewport.x,
                safeViewport.y
            );
        }

        drawCostProfiler.add(DC.vconvert, _tConv);

        // Allocate vertex data in ring buffer
        const _tRing = drawCostProfiler.now();
        let vBuffer: GPUBuffer;
        let vOffset: number;
        let vSize: number;
        if (gpuConversionResult) {
            // GPU path: result already contains buffer and offset from global vertex buffer
            // No need to copy again - use directly
            vBuffer = gpuConversionResult.buffer;
            vOffset = gpuConversionResult.offset;
            vSize = gpuConversionResult.size;
        } else if (convertedData && convertedData.length > 0) {
            this.countNanVerts(convertedData, effectiveVCount);
            // CPU path: copy from CPU array to ring buffer
            const alloc = this.ringBufferManager.allocateVertexData(convertedData);
            if (alloc.overflow) {
                this.renderStats.skipRingOverflow++;
                return; // Skip draw — ring buffer full, no valid vertex data
            }
            vBuffer = alloc.buffer;
            vOffset = alloc.offset;
            vSize = convertedData.length; // Use actual converted data size
        } else {
            this.renderStats.skipNoData++;
            Logger.error(LogCategory.SYSTEM, `drawIndexedPrimitive: No converted vertex data`);

            return;
        }
        drawCostProfiler.add(DC.ringup, _tRing);

        // Per-stage batch-compatibility keys (texture versions + sampler keys).
        // 'submit' here also covers index marshal/upload (indexed-only) + the batch decision.
        const _tSubmit = drawCostProfiler.now();
        this.computeStageBatchKeys(prepareResult, texture, stageTextures ?? null);

        // Prepare index data
        // Handle indexed TRIANGLEFAN - expand indices to triangle-list
        const _tSIdx = drawCostProfiler.now();
        let finalIndexCount = iCount;
        let indexFormat: GPUIndexFormat = "uint16";
        if (indexDataSize === iCount * 4) {
            indexFormat = "uint32";
        }

        let expandedIndices: Uint8Array | null = null;
        if (primitiveType === D3DPT_TRIANGLEFAN && iCount >= 3) {
            // Expand indexed triangle fan to triangle list: for each triangle (0, i+1, i+2) create 3 indices
            finalIndexCount = (iCount - 2) * 3;
            const expandedIndexSize = finalIndexCount * (indexFormat === "uint32" ? 4 : 2);
            const alignedExpandedSize = (expandedIndexSize + 3) & ~3;
            expandedIndices = this.ensureScratchBuffer(alignedExpandedSize);
            
            // Read original indices
            const originalIndices = memory.subarray(indicesAddr, indicesAddr + indexDataSize);
            
            if (indexFormat === "uint32") {
                // 32-bit indices
                const srcView = new Uint32Array(originalIndices.buffer, originalIndices.byteOffset, iCount);
                const dstView = new Uint32Array(expandedIndices.buffer, expandedIndices.byteOffset, finalIndexCount);
                
                for (let i = 0; i < iCount - 2; i++) {
                    const raw0 = srcView[0];      // Fan center (always first index)
                    const raw1 = srcView[i + 1];
                    const raw2 = srcView[i + 2];
                    if (raw0 < appliedIndexBase || raw1 < appliedIndexBase || raw2 < appliedIndexBase) {
                        Logger.warn(LogCategory.SYSTEM, `drawIndexedPrimitive: triangle fan index rebase underflow (base=${appliedIndexBase})`);
                        return;
                    }
                    const idx0 = raw0 - appliedIndexBase;
                    const idx1 = raw1 - appliedIndexBase;
                    const idx2 = raw2 - appliedIndexBase;
                    const dstBase = i * 3;
                    dstView[dstBase] = idx0;
                    dstView[dstBase + 1] = idx1;
                    dstView[dstBase + 2] = idx2;
                }
            } else {
                // 16-bit indices
                const srcView = new Uint16Array(originalIndices.buffer, originalIndices.byteOffset, iCount);
                const dstView = new Uint16Array(expandedIndices.buffer, expandedIndices.byteOffset, finalIndexCount);
                
                for (let i = 0; i < iCount - 2; i++) {
                    const raw0 = srcView[0];
                    const raw1 = srcView[i + 1];
                    const raw2 = srcView[i + 2];
                    if (raw0 < appliedIndexBase || raw1 < appliedIndexBase || raw2 < appliedIndexBase) {
                        Logger.warn(LogCategory.SYSTEM, `drawIndexedPrimitive: triangle fan index rebase underflow (base=${appliedIndexBase})`);
                        return;
                    }
                    const idx0 = raw0 - appliedIndexBase;
                    const idx1 = raw1 - appliedIndexBase;
                    const idx2 = raw2 - appliedIndexBase;
                    if (idx0 > 0xFFFF || idx1 > 0xFFFF || idx2 > 0xFFFF) {
                        Logger.warn(LogCategory.SYSTEM, `drawIndexedPrimitive: rebased uint16 index overflow`);
                        return;
                    }
                    const dstBase = i * 3;
                    dstView[dstBase] = idx0;
                    dstView[dstBase + 1] = idx1;
                    dstView[dstBase + 2] = idx2;
                }
            }
        }

        const indexScratch = expandedIndices || this.ensureScratchBuffer((indexDataSize + 3) & ~3);
        if (!expandedIndices) {
            if (appliedIndexBase === 0) {
                indexScratch.set(memory.subarray(indicesAddr, indicesAddr + indexDataSize));
            } else {
                const srcOffset = memory.byteOffset + indicesAddr;
                if (indexFormat === "uint32") {
                    const srcView = new DataView(memory.buffer, srcOffset, iCount * 4);
                    const dstView = new DataView(indexScratch.buffer, indexScratch.byteOffset, indexScratch.byteLength);
                    for (let i = 0; i < iCount; i++) {
                        const raw = srcView.getUint32(i * 4, true);
                        if (raw < appliedIndexBase) {
                            Logger.warn(LogCategory.SYSTEM, `drawIndexedPrimitive: index rebase underflow (base=${appliedIndexBase})`);
                            return;
                        }
                        dstView.setUint32(i * 4, (raw - appliedIndexBase) >>> 0, true);
                    }
                } else {
                    const srcView = new DataView(memory.buffer, srcOffset, iCount * 2);
                    const dstView = new DataView(indexScratch.buffer, indexScratch.byteOffset, indexScratch.byteLength);
                    for (let i = 0; i < iCount; i++) {
                        const raw = srcView.getUint16(i * 2, true);
                        if (raw < appliedIndexBase) {
                            Logger.warn(LogCategory.SYSTEM, `drawIndexedPrimitive: index rebase underflow (base=${appliedIndexBase})`);
                            return;
                        }
                        const rebased = raw - appliedIndexBase;
                        if (rebased > 0xFFFF) {
                            Logger.warn(LogCategory.SYSTEM, `drawIndexedPrimitive: rebased uint16 index overflow`);
                            return;
                        }
                        dstView.setUint16(i * 2, rebased, true);
                    }
                }
            }
        }
        const alignedIndexSize = expandedIndices ? expandedIndices.length : ((indexDataSize + 3) & ~3);
        const indexAlloc = this.ringBufferManager.allocateIndexData(
            indexScratch.subarray(0, alignedIndexSize)
        );
        if (indexAlloc.overflow) {

            return; // Skip draw — index ring buffer full
        }
        const { buffer: iBuffer, offset: iOffset } = indexAlloc;
        drawCostProfiler.add(DC.s_idx, _tSIdx);

        // MegaBatch for indexed draws: same as drawPrimitive — per-draw uniforms in storage buffer,
        // removes uniformOffset constraint, allows batching across different render states.
        const isBatchablePrimitive = primitiveType === D3DPT_TRIANGLESTRIP ||
                                     primitiveType === D3DPT_TRIANGLELIST ||
                                     primitiveType === D3DPT_TRIANGLEFAN;

        const _tSPipe = drawCostProfiler.now();
        const megaBatchPipeline = megaBatchEnabled && isBatchablePrimitive
            ? this.pipelineFactory.getOrCreateMegaBatchPipeline(
                vertexType,
                primitiveType,
                this.ffpStages,
                false,
                renderStates,
                texture
            )
            : null;
        drawCostProfiler.add(DC.s_pipe, _tSPipe);

        // Normalize viewport once — used in canBatch check and in currentBatch creation below.
        const vpX = viewport.x || 0;
        const vpY = viewport.y || 0;
        const vpW = viewport.width || target.width || 640;
        const vpH = viewport.height || target.height || 480;
        const vpMinZ = viewport.minZ ?? 0;
        const vpMaxZ = viewport.maxZ ?? 1;

        const canBatch = megaBatchEnabled &&
            megaBatchAccumulate &&
            isBatchablePrimitive &&
            megaBatchPipeline !== null &&
            this.currentBatch !== null &&
            this.currentBatch.useMegaBatch &&
            this.currentBatch.target === target &&
            this.currentBatch.pipeline === megaBatchPipeline &&
            // REMOVED: uniformOffset constraint — per-draw uniforms in storage buffer
            this.batchStageStateCompatible(this.currentBatch, prepareResult) &&
            this.currentBatch.vertexBuffer === vBuffer &&
            this.currentBatch.indexBuffer === iBuffer &&
            this.currentBatch.indexFormat === indexFormat &&
            this.currentBatch.primitiveType === primitiveType &&
            this.currentBatch.stencilRef === prepareResult.stencilRef &&
            this.currentBatch.viewport.x === vpX &&
            this.currentBatch.viewport.y === vpY &&
            this.currentBatch.viewport.width === vpW &&
            this.currentBatch.viewport.height === vpH &&
            this.currentBatch.viewport.minZ === vpMinZ &&
            this.currentBatch.viewport.maxZ === vpMaxZ &&
            iCount <= 8192;

        if (canBatch && this.currentBatch) {
            // Add to existing MegaBatch — each draw has its own drawIndex
            if (this.opLogArmed > 0) this.opLog(`BATCH+ i=${finalIndexCount} v=${effectiveVCount} z=${renderStates[D3DRENDERSTATE_ZENABLE]|0} zw=${renderStates[D3DRENDERSTATE_ZWRITEENABLE]|0} zb=${renderStates[D3DRENDERSTATE_ZBIAS]|0} bl=${renderStates[D3DRENDERSTATE_ALPHABLENDENABLE]|0} sb=${renderStates[D3DRENDERSTATE_SRCBLEND]|0} db=${renderStates[D3DRENDERSTATE_DESTBLEND]|0} tex=${!!texture}`);
            const vertexOffset = vOffset / OUTPUT_VERTEX_BYTES;
            const indexOffset = iOffset / (indexFormat === "uint32" ? 4 : 2);
            this.currentBatch.draws.push({
                firstVertex: vertexOffset,
                vertexCount: effectiveVCount,
                drawIndex: prepareResult.drawIndex,
                vertexBufferOffset: vOffset,
                vertexBufferSize: vSize,
                firstIndex: indexOffset,
                indexCount: finalIndexCount,
                indexBufferOffset: iOffset,
                indexBufferSize: alignedIndexSize,
            });
        } else {
            // Flush previous batch if exists
            this.flushBatch();

            // Start new batch or draw immediately
            const shouldBatch = megaBatchEnabled &&
                isBatchablePrimitive &&
                iCount <= 8192 &&
                primitiveType !== D3DPT_TRIANGLEFAN; // Don't batch triangle fan (already expanded)

            if (shouldBatch && megaBatchPipeline) {
                // Start new MegaBatch for indexed draws
                if (this.opLogArmed > 0) this.opLog(`BATCH-NEW i=${finalIndexCount} v=${effectiveVCount} z=${renderStates[D3DRENDERSTATE_ZENABLE]|0} zw=${renderStates[D3DRENDERSTATE_ZWRITEENABLE]|0} zb=${renderStates[D3DRENDERSTATE_ZBIAS]|0} bl=${renderStates[D3DRENDERSTATE_ALPHABLENDENABLE]|0} sb=${renderStates[D3DRENDERSTATE_SRCBLEND]|0} db=${renderStates[D3DRENDERSTATE_DESTBLEND]|0} tex=${!!texture}`);
                const vertexOffset = vOffset / OUTPUT_VERTEX_BYTES;
                const indexOffset = iOffset / (indexFormat === "uint32" ? 4 : 2);

                // Create MegaBatch bind group bound to the WHOLE storage buffer
                // (absolute addressing via firstInstance=drawIndex — see drawPrimitive).
                const storageBuffer = this.ringBufferManager.getCurrentStorageBuffer();
                const megaBatchBindGroup = this.bindGroupManager.createMegaBatchBindGroup(
                    storageBuffer,
                    prepareResult.sampledMask,
                    prepareResult.stageViews,
                    prepareResult.stageSamplers,
                    this.dummyTextureView
                );

                this.ensureRenderPass(target, viewport);

                this.currentBatch = {
                    target,
                    viewport: {
                        x: vpX,
                        y: vpY,
                        width: vpW,
                        height: vpH,
                        minZ: vpMinZ,
                        maxZ: vpMaxZ,
                    },
                    pipeline: megaBatchPipeline,
                    bindGroup: megaBatchBindGroup,
                    uniformOffset: prepareResult.uniformOffset,
                    lightsOffset: prepareResult.lightsOffset,
                    sampledMask: prepareResult.sampledMask,
                    stageVersions: Array.from(this.stageVersionsScratch),
                    stageViews: prepareResult.stageViews.slice(),
                    stageSamplerKeys: Array.from(this.stageSamplerKeysScratch),
                    vertexBuffer: vBuffer,
                    firstVertex: vertexOffset,
                    vertexCount: effectiveVCount,
                    vertexSize: OUTPUT_VERTEX_BYTES,
                    primitiveType,
                    indexFormat,
                    indexBuffer: iBuffer,
                    firstIndex: indexOffset,
                    indexCount: finalIndexCount,
                    draws: [{
                        firstVertex: vertexOffset,
                        vertexCount: effectiveVCount,
                        drawIndex: prepareResult.drawIndex,
                        vertexBufferOffset: vOffset,
                        vertexBufferSize: vSize,
                        firstIndex: indexOffset,
                        indexCount: finalIndexCount,
                        indexBufferOffset: iOffset,
                        indexBufferSize: alignedIndexSize,
                    }],
                    useMegaBatch: true,
                    storageBuffer,
                    megaBatchBindGroup,
                    stencilRef: prepareResult.stencilRef,
                };
            } else {
                // Draw immediately (large draws or incompatible types)
                this.ensureRenderPass(target, viewport);
                this.setupPipelineAndBindings(prepareResult);

                // Pass size to setVertexBuffer to prevent reading beyond vertex data in ring buffer
                this.currentRenderPass!.setVertexBuffer(0, vBuffer, vOffset, vSize);
                this.currentRenderPass!.setIndexBuffer(iBuffer, indexFormat, iOffset);
                // Use finalIndexCount (expanded for triangle fan) instead of original iCount
                this.currentRenderPass!.drawIndexed(finalIndexCount);
                if (this.opLogArmed > 0) this.opLog(`DRAW-IMM-IDX i=${finalIndexCount} v=${effectiveVCount} lit=${(renderStates[D3DRENDERSTATE_LIGHTING] | 0) !== 0} z=${renderStates[D3DRENDERSTATE_ZENABLE] | 0} zw=${renderStates[D3DRENDERSTATE_ZWRITEENABLE] | 0} vp=${viewport.x||0},${viewport.y||0},${viewport.width},${viewport.height},${viewport.minZ??0},${viewport.maxZ??1}`);
                setAuthorityGpu(target, true);

                // Update frame snapshot counters
                if (!this.cachedDDrawModuleResolved) {
                    this.cachedDDrawModuleResolved = true;
                    this.cachedDDrawModule = System.getInstance().process?.getModule("ddraw");
                }
                if (this.cachedDDrawModule?.incrementFrameCounter) {
                    this.cachedDDrawModule.incrementFrameCounter("vertexBytes", vSize + alignedIndexSize);
                }
            }
        }
        drawCostProfiler.add(DC.submit, _tSubmit);
        drawCostProfiler.countDraw(true);

        // setAuthorityGpu lives in flushBatch — calling it here double-bumps
        // version for immediate draws and bumps early for batched draws.
    }

    // ===== Frame Management =====

    /**
     * Flush pending GPU commands to queue.
     * Only submits if there are actual commands to execute.
     * For better performance, prefer batching commands until endFrame().
     */
    /**
     * @param drainDeferredClears Frame-end callers must drain `surfacesNeedingClear` — nothing
     *   after them will. A MID-frame submit must NOT: the pending clear lives on the surface
     *   state, so leaving it lets the next ensureRenderPass fold it into `loadOp:"clear"`
     *   instead of paying a separate clearPipeline pass.
     */
    flush(drainDeferredClears = true): void {
        // No device: submitting is a silent no-op anyway, and the recorded commands would be
        // built from handles that are already dead. Skip the whole frame instead.
        if (this.deviceLost) return;
        this.renderStats.flushes++;
        this.flushBatch();
        // These publish this frame's staged uploads. A throw here — an oversize or
        // misaligned writeBuffer — would otherwise skip the submit AND its teardown
        // below, leaving currentEncoder alive with an open pass for every later frame
        // to append to: one bad frame becomes every frame after it. Losing this frame's
        // uploads is recoverable; losing the encoder is not.
        try {
            this.vertexConverter.flushParams();
            this.ringBufferManager.flushGeometry();
            this.ringBufferManager.flushUniforms();
            this.ringBufferManager.flushLights();
            this.ringBufferManager.flushStorageBuffer();
        } catch (e) {
            recordGpuError("throw", "ddrawExecutor.flushUploads", String(e));
            Logger.error(LogCategory.DDRAW, `[WEBGPU] flush() upload publish failed — frame's uploads dropped: ${e}`);
        }

        if (drainDeferredClears && this.surfacesNeedingClear.size > 0) {
            Logger.log(LogCategory.DDRAW,
                `flush: processing ${this.surfacesNeedingClear.size} deferred clears (no draws consumed them)`);
            // flushBatch() may leave a render pass open via ensureRenderPass().
            // clearPipeline.clear() calls encoder.beginRenderPass() internally — encoder must be unlocked first.
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
                this.currentRenderTarget = null;
            }
            if (!this.currentEncoder) {
                this.currentEncoder = this.device.createCommandEncoder();
            }

            for (const target of this.surfacesNeedingClear) {
                if (target.needsColorClear && target.clearColor !== undefined && target.gpuTextureView) {
                    const colorFormat = this.resolveSurfaceTextureFormat(target);
                    
                    this.clearPipeline.clear(
                        this.currentEncoder,
                        target.gpuTextureView,
                        target.width,
                        target.height,
                        this.depthManager.getDepthViewForTarget(target),
                        {
                            flags: D3DCLEAR_TARGET,
                            color: target.clearColor,
                            depth: 0,
                            stencil: undefined,
                            viewport: undefined,
                            rects: undefined,
                        },
                        colorFormat,
                        this.msaaColorManager.getColorViewForTarget(target) ?? undefined
                    );

                    target.needsColorClear = false;
                    target.clearColor = undefined;
                }
            }

            this.surfacesNeedingClear.clear();
        }
        
        if (this.currentRenderPass) {
            this.currentRenderPass.end();
            this.currentRenderPass = null;
        }
        if (this.currentEncoder) {
            const submitStart = frameProfiler.startTimer();
            try {
                this.queue.submit([this.currentEncoder.finish()]);
            } catch (e) {
                // The teardown below must run even on a throw. A finish()/submit() that throws
                // leaves the encoder already finished, so keeping it would hand every later
                // frame an unusable encoder — one bad frame becomes every frame after it.
                recordGpuError("throw", "ddrawExecutor.flush", String(e));
                Logger.error(LogCategory.DDRAW, `[WEBGPU] flush() submit failed — frame discarded: ${e}`);
            }
            frameProfiler.endTimer("gpu", submitStart);
            this.currentEncoder = null;
            this.encoderEpoch++;
            // Flush garbage list after submit to safely destroy unused depth textures
            this.depthManager.flushGarbage();
            this.msaaColorManager.flushGarbage();
            // Destroy deferred TextureConverter buffers (resized mid-frame) so no "used while destroyed"
            this.textureConverter.destroyPendingAfterSubmit();
            // Destroy deferred VertexConverter buffers after submit to avoid "used while destroyed"
            this.vertexConverter.destroyPendingAfterSubmit();
            // Reuse global conversion buffer from offset 0 after each submit.
            this.vertexConverter.startFrame();
        }
        this.currentRenderTarget = null;
        this.resetBindFastPath();
    }

    /**
     * Post-submit cleanup for single-submit present path (D3D8).
     * Call after queue.submit() when using finalizePendingDraws().
     */
    postSubmitCleanup(): void {
        this.depthManager.flushGarbage();
        this.msaaColorManager.flushGarbage();
        this.textureConverter.destroyPendingAfterSubmit();
        this.vertexConverter.destroyPendingAfterSubmit();
        this.vertexConverter.startFrame();
        this.depthManager.resetFrameDirtyFlags();
        // Frame boundary (post-submit, nothing in flight): swap in any pending MSAA count change.
        this.applyMsaaAtFrameBoundary();
    }

    private frameEndedThisFrame = false;
    /** Per-frame draw counter feeding the drawScrubMax bisect. See scrubbedOut(). */
    private frameDrawIndex = 0;
    /** Present serial the draw counter is currently numbering against (-1 = not yet seen). */
    private scrubFrameSerial = -1;
    /** Draws the scrub counted in the last completed frame. The instrument's own
     *  self-check: a cut of N that leaves the picture whole is meaningless unless this
     *  says the frame really did contain more than N draws. */
    private scrubLastFrameDraws = 0;

    /**
     * Finalize all pending draws and return the command encoder WITHOUT submitting.
     * Caller is responsible for finishing and submitting the encoder.
     * Used by D3D8 present to combine draw commands + present copy in one submit.
     */
    finalizePendingDraws(): GPUCommandEncoder | null {
        this.flushBatch();
        this.vertexConverter.flushParams();
        this.ringBufferManager.flushGeometry();
        this.ringBufferManager.flushUniforms();
        this.ringBufferManager.flushLights();
        this.ringBufferManager.flushStorageBuffer();

        if (this.surfacesNeedingClear.size > 0) {
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
                this.currentRenderTarget = null;
            }
            if (!this.currentEncoder) {
                this.currentEncoder = this.device.createCommandEncoder();
            }
            for (const target of this.surfacesNeedingClear) {
                if (target.needsColorClear && target.clearColor !== undefined && target.gpuTextureView) {
                    const colorFormat = this.resolveSurfaceTextureFormat(target);
                    this.clearPipeline.clear(
                        this.currentEncoder,
                        target.gpuTextureView,
                        target.width,
                        target.height,
                        this.depthManager.getDepthViewForTarget(target),
                        { flags: D3DCLEAR_TARGET, color: target.clearColor, depth: 0, stencil: undefined, viewport: undefined, rects: undefined },
                        colorFormat,
                        this.msaaColorManager.getColorViewForTarget(target) ?? undefined
                    );
                    target.needsColorClear = false;
                    target.clearColor = undefined;
                }
            }
            this.surfacesNeedingClear.clear();
        }

        if (this.currentRenderPass) {
            this.currentRenderPass.end();
            this.currentRenderPass = null;
        }

        const encoder = this.currentEncoder;
        this.currentEncoder = null;
        // The caller submits this encoder (D3D8 single-submit present). Bump unconditionally:
        // if it was already null the frame boundary passed anyway, and a missed bump would let
        // a texture marked in frame N still match the epoch in frame N+1.
        this.encoderEpoch++;
        this.currentRenderTarget = null;
        this.resetBindFastPath();
        return encoder;
    }

    endFrameForPresent(): void {
        this.flush();

        if (!this.frameEndedThisFrame) {
            // No EndScene was called (pure DDraw game) — rotate ring buffer
            this.sampleFrameStats();
            this.ringBufferManager.nextFrame();
            this.depthManager.resetFrameDirtyFlags();
            this.vertexConverter.startFrame();
        }
        this.frameEndedThisFrame = false;
        // Frame boundary (flush() above submitted + nulled the encoder): apply pending MSAA change.
        this.applyMsaaAtFrameBoundary();
    }

    /** Public face of the draw-scrub gate, for draws that do NOT go through this executor's
     *  own drawPrimitive/drawIndexedPrimitive — the D3D8 programmable (vertex-shader) path
     *  submits through the D3D9 executor instead. Without this the scrub silently cut nothing
     *  for those draws while still reporting a cut, and the per-frame counter drifted out of
     *  step with the frame capture's draw indices. */
    scrubDraw(): boolean {
        return this.scrubbedOut();
    }

    /** drawScrubMax bisect: count this draw and report whether it is past the cut.
     *  Counted BEFORE the cut test so the numbering matches the frame capture's `index`
     *  (which counts every draw the guest issued, kept or not).
     *
     *  The frame boundary is the FRAME CAPTURE's own producer boundary, so a scrub cut and
     *  a capture index cannot disagree. endFrame() is not it: a title that presents with
     *  Blt never calls it and the counter runs away, so the scrub freezes the picture.
     *  Neither is the guest's full-RT Clear (an engine that clears per render target resets
     *  several times per frame) nor RenderService's present serial (the GDI presenter
     *  advances it independently, resetting the counter mid-frame). All three failure modes
     *  read as "the flag does nothing", which is why the counter reports scrubLastFrameDraws. */
    private scrubbedOut(): boolean {
        const max = this.debugFlags.drawScrubMax;
        const skipFrom = this.debugFlags.drawSkipFrom;
        if (max < 0 && skipFrom < 0) return false;
        const serial = frameCapture.getFrameBoundarySerial();
        if (serial !== this.scrubFrameSerial) {
            this.scrubFrameSerial = serial;
            this.scrubLastFrameDraws = this.frameDrawIndex;
            this.frameDrawIndex = 0;
        }
        const idx = this.frameDrawIndex++;
        if (max >= 0 && idx > max) return true;
        if (skipFrom < 0) return false;
        const skipTo = this.debugFlags.drawSkipTo;
        return idx >= skipFrom && idx <= (skipTo < 0 ? skipFrom : skipTo);
    }

    /**
     * Start the post-Flip readback prefetch for the chain members that just rotated.
     * Public because the FLIP handler owns the moment: the rotation has settled, and the
     * frame-pacer wait that follows is dead time the copy can hide in.
     */
    prefetchRotatedForReadback(states: readonly DirectDrawSurfaceState[]): void {
        prefetchAfterFlip(states, (state) =>
            surfaceSyncManager.syncToCPU(state, this.device, this.queue, this.textureConverter, {
                fromPrefetch: true,
            })
        );
    }

    endFrame(): void {
        this.flush();

        const usage = this.ringBufferManager.getFrameVertexUsage();
        if (usage.percent > 50) {
            Logger.warn(LogCategory.SYSTEM,
                `Frame vertex ring: ${(usage.bytes / 1024 / 1024).toFixed(1)}MB (${usage.percent.toFixed(0)}%)`);
        }
        // Overlap GPU→CPU readback with the next scene for surfaces that read-Lock
        // (R-D). Do not go through syncSurfaceToMemory — that re-flushes.
        this.pumpLockReadbackPrefetch();
        this.sampleFrameStats();
        this.ringBufferManager.nextFrame();
        this.depthManager.resetFrameDirtyFlags();
        this.vertexConverter.startFrame();
        this.frameEndedThisFrame = true;
        // Frame boundary (flush() above submitted + nulled the encoder): apply pending MSAA change.
        this.applyMsaaAtFrameBoundary();
    }

    // ===== Private Helpers =====

    private ensureSurfaceGPUResources(state: DirectDrawSurfaceState): void {
        if (state.gpuTextureView) return;

        const device = this.backend.getDevice();
        if (!device || !state.width || !state.height) {
            Logger.warn(LogCategory.DDRAW,
                `ensureSurfaceGPUResources: BAIL for 0x${state.surfacePtr.toString(16)} ` +
                `device=${!!device} w=${state.width} h=${state.height}`);
            return;
        }

        // Use existing format if set, otherwise determine based on surface type
        // Textures should use rgba8unorm for predictable conversion, render targets use swapchain format
        // If surface is used as texture (has DDSCAPS_TEXTURE or is not a render target),
        // always use rgba8unorm to avoid B/R swap issues. Only render targets (primary/backbuffer/D3D) use swapchain format.
        let format: GPUTextureFormat;
        if (state.gpuTextureFormat) {
            format = state.gpuTextureFormat;
        } else {
            const isTexture = (state.caps & DDSCAPS_TEXTURE) !== 0;
            const isRenderTarget = (state.caps & (DDSCAPS_PRIMARYSURFACE | DDSCAPS_BACKBUFFER | DDSCAPS_3DDEVICE)) !== 0;
            // All textures (even without DDSCAPS_TEXTURE flag) should use rgba8unorm
            // Only true render targets (primary/backbuffer/D3D) should use swapchain format
            format = isRenderTarget ? this.swapChainFormat : "rgba8unorm";
            
            if (Logger.isEnabled(LogCategory.DDRAW, LogLevel.NORMAL)) {
                Logger.log(
                    LogCategory.DDRAW,
                    `ensureSurfaceGPUResources: format decision for 0x${(state.surfacePtr ?? 0).toString(16)} ` +
                    `isTexture=${isTexture} isRenderTarget=${isRenderTarget} format=${format} ` +
                    `caps=0x${state.caps.toString(16)}`
                );
            }
        }
        
        // Mip chains. A texture that declares DDSCAPS_MIPMAP genuinely wants mipmapping, so it gets a
        // real chain even when the auto-mipmap quality toggle is off — otherwise the game's MIPLINEAR/
        // MIPNEAREST sampler state is a silent no-op (the "DX7 mipmaps don't work" bug). The quality
        // toggle additionally synthesises chains for NON-mipmapped textures (forced AF/trilinear).
        // Levels are box-generated from level 0 in regenerateMipsIfNeeded (the authored lower-mip pixels
        // are not yet routed into their slots — a follow-up; box-gen matches authored mips for the
        // common case). Render targets, tiny surfaces and non-8888 formats are excluded. The level-0
        // view stays single-mip for render/clear/upload; sampling uses an all-mips view (see prepareDraw).
        const isTextureSurface = (state.caps & DDSCAPS_TEXTURE) !== 0;
        const isRT = (state.caps & (DDSCAPS_PRIMARYSURFACE | DDSCAPS_BACKBUFFER | DDSCAPS_3DDEVICE)) !== 0;
        const wantsAuthoredMips = (state.caps & DDSCAPS_MIPMAP) !== 0;
        const mipEligible = (wantsAuthoredMips || EmulatorConfig.getInstance().quality.autoMipmap) &&
            isTextureSurface && !isRT &&
            (format === "rgba8unorm" || format === "bgra8unorm") &&
            state.width >= 2 && state.height >= 2;
        let mipLevels = mipEligible ? mipLevelCountFor(state.width, state.height) : 1;
        // When the game supplied an authored chain, allocate exactly its depth (root + sublevels) so
        // uploadAuthoredMips fills every slot — no empty levels that would sample as black.
        if (mipEligible && state.mipSublevels && state.mipSublevels.length > 0) {
            mipLevels = Math.min(mipLevels, 1 + state.mipSublevels.length);
        }

        // NOTE: Texture usage includes COPY_DST for TextureConverter.convertToTexture() which uses
        // copyBufferToTexture (not storage texture binding), so STORAGE_BINDING is not needed.
        state.gpuTexture = device.createTexture({
            size: [state.width, state.height],
            format,
            mipLevelCount: mipLevels,
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC |
                GPUTextureUsage.COPY_DST,
        });
        // Level-0 view only (identical to createView() when mipLevels===1).
        state.gpuTextureView = state.gpuTexture.createView({ baseMipLevel: 0, mipLevelCount: 1 });
        state.gpuMipLevels = mipLevels;
        state.gpuTextureFormat = format;
        if (isRenderSurface(state)) {
            state.lastUploadVersion = -1;
        }

        // Clear newly created texture to transparent black to prevent uninitialized GPU memory
        // from being sampled as white/garbage if a draw happens before data upload completes.
        {
            const encoder = device.createCommandEncoder();
            encoder.beginRenderPass({
                colorAttachments: [{
                    view: state.gpuTextureView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                }],
            }).end();
            this.queue.submit([encoder.finish()]);
        }

        // Invalidate cached bind group state — the old textureView references are now stale.
        // Without this, the draw path may skip bind group recreation and keep using a
        // bind group that references a destroyed/different GPUTextureView.
        this.resetBindFastPath();
    }

    /**
     * The view to SAMPLE a surface texture with. When auto-mipmap gave the texture a chain
     * (gpuMipLevels > 1), return the all-mips view (cached by live GPUTexture); otherwise the
     * plain level-0 view. Falls back gracefully so a stale gpuMipLevels can never error.
     */
    private sampleViewFor(state: DirectDrawSurfaceState): GPUTextureView | null {
        if (state.gpuMipLevels && state.gpuMipLevels > 1 && state.gpuTexture) {
            let v = this.sampleViewCache.get(state.gpuTexture);
            if (!v) {
                v = state.gpuTexture.createView();
                this.sampleViewCache.set(state.gpuTexture, v);
            }
            return v;
        }
        return state.gpuTextureView ?? null;
    }

    /** Regenerate mip levels 1..N from level 0 after a fresh upload. No-op without a chain. */
    private regenerateMipsIfNeeded(state: DirectDrawSurfaceState): void {
        if (!this.device || !state.gpuTexture || !state.gpuTextureFormat) return;
        if (!state.gpuMipLevels || state.gpuMipLevels <= 1) return;
        if (!this.mipGenerator) this.mipGenerator = new MipGenerator(this.device);
        this.mipGenerator.generate(state.gpuTexture, state.gpuTextureFormat, state.gpuMipLevels);
    }

    /**
     * Upload the game's AUTHORED mip sublevels (recorded on the root by CreateSurface) into the base
     * texture's GPU mip slots — the faithful alternative to box-generating from level 0. Each sublevel
     * surface holds its own guest pixels (filled by the game via Load/Blt); we decode them with the
     * same converter used for level 0 and writeTexture into slot (i+1). Mipmapped textures are always
     * rgba8unorm (render targets, the only bgra case, are never mip-eligible), so no swizzle is needed.
     * Returns false (caller falls back to box-gen) if anything is missing.
     */
    private uploadAuthoredMips(state: DirectDrawSurfaceState): boolean {
        const subs = state.mipSublevels;
        const levels = state.gpuMipLevels ?? 1;
        if (!subs || subs.length === 0 || !state.gpuTexture || levels <= 1) return false;
        // Plain view: decodeSurfaceFormatToRgba8 below reads this per texel.
        const mem = toPlainGuestMemory(System.getInstance()?.process?.getCurrentMemory());
        if (!mem) return false;

        for (let i = 0; i < subs.length && i + 1 < levels; i++) {
            const sub = subs[i];
            if (!sub.surfacePtr) continue;
            const w = Math.max(1, sub.width);
            const h = Math.max(1, sub.height);
            const layout = getSurfaceFormatLayout(sub.format, w, h);
            const pitch = Math.max(sub.pitch, layout.pitch);
            const rgba = decodeSurfaceFormatToRgba8(mem, sub.surfacePtr, w, h, pitch, sub.format, undefined, sub.srcColorKey);
            this.queue.writeTexture(
                { texture: state.gpuTexture, mipLevel: i + 1 },
                rgba as any,
                { bytesPerRow: w * 4 },
                { width: w, height: h, depthOrArrayLayers: 1 },
            );
        }
        return true;
    }

    /** Last observed guest-memory content hash per texture surfacePtr (see prepareStageTexture). */
    private readonly cpuContentHashes = new Map<number, number>();
    /** Frame in which each surfacePtr was last hashed, so the scan runs once per frame. */
    private readonly cpuHashFrame = new Map<number, number>();
    /** Monotonic frame counter for the hash memo; bumped at each frame boundary. */
    private frameSerial = 0;

    /** Monotonic id of the command buffer currently being recorded. Bumped on every submit that
     *  nulls currentEncoder. Draws recorded into epoch N observe every queue.writeTexture issued
     *  before submit(N) — INCLUDING writes issued after those draws were recorded, because the
     *  write lands on the queue while the draws are still sitting in an unsubmitted buffer. That
     *  is the whole copy→draw→copy→draw hazard, and comparing this to a surface's
     *  sampledEncoderEpoch is how we detect it. */
    private encoderEpoch = 1;

    /** Samples per surface for the content hash. The scan runs once per surface per frame, so
     *  its cost is charged to every textured frame — a full sweep of every bound texture cost
     *  ~45% of the frame rate here. A fixed budget makes it O(1) per surface instead of O(size)
     *  while staying far denser than any real texel update: a lightmap block rewrite touches
     *  hundreds of contiguous bytes, so it cannot slip between samples. */
    private static readonly CONTENT_HASH_SAMPLES = 1024;

    /** FNV-1a over a bounded, evenly spaced sample of the surface's guest bytes. Returns 0 when
     *  the memory is not addressable (the caller then leaves the freshness flags alone). */
    private hashSurfaceBytes(tex: RenderSurface): number {
        // Plain view, not v86's Proxy: every raw `mem[i]` costs a trap + regex assert
        // (~25-40x), and this is a per-element loop. Borrowed locally — never held across
        // a yield, so a memory growth cannot detach it under us.
        const mem = toPlainGuestMemory(System.getInstance()?.process?.getCurrentMemory());
        if (!mem) return 0;
        const start = tex.surfacePtr >>> 0;
        const bytes = Math.max(0, tex.pitch * tex.height);
        if (!start || bytes <= 0 || start + bytes > mem.length) return 0;
        // Odd step so the sample positions do not land on one texel component forever.
        const step = Math.max(1, Math.floor(bytes / DDrawWebGPUExecutor.CONTENT_HASH_SAMPLES)) | 1;
        let h = 0x811c9dc5;
        let n = 0;
        for (let i = start; i < start + bytes; i += step) {
            h ^= mem[i];
            h = Math.imul(h, 0x01000193);
            n++;
        }
        this.renderStats.texHashScans++;
        this.renderStats.texHashBytes += n;
        return h >>> 0 || 1;
    }

    /** Ensure a stage texture's GPU resources exist and are synced from guest memory. */
    /**
     * True when draws already recorded into the CURRENT (unsubmitted) command buffer sampled
     * this surface, and its pixels have changed since. Both halves matter: after any submit the
     * epoch advances and this goes false on its own, so no per-submit bookkeeping sweep is
     * needed, and a re-upload of unchanged content (forceTextureResync, a hash-driven gpuDirty)
     * does not move contentVersion and so cannot trigger a spurious submit.
     */
    private isSampledContentOverwritten(tex: DirectDrawSurfaceState): boolean {
        return tex.sampledEncoderEpoch === this.encoderEpoch
            && tex.sampledContentVersion !== surfaceContentVersion(tex);
    }

    private prepareStageTexture(stage: number, tex: DirectDrawSurfaceState): void {
        const justCreated = !tex.gpuTextureView;
        this.ensureSurfaceGPUResources(tex);
        // If GPU texture was just created, force dirty to guarantee initial upload
        if (justCreated && isRenderSurface(tex) && !tex.gpuDirty) {
            tex.gpuDirty = true;
        }
        // A game that Locked a texture once may keep the returned lpSurface and rewrite texels
        // with no further Lock/Unlock/Load — legal, because real D3D6 reads a system-memory
        // texture's texels at draw time and never needed to be told. Our GPU copy is a cache the
        // contract does not know about, and every dirty flag stays false, so the first upload
        // would be the only one for the surface's whole life (Half-Life's lightmaps: permanently
        // black world faces). Ask the memory instead — hash it at bind and re-upload on change.
        // Restricted to ever-Locked textures that we believe are already in sync, so the scan
        // does not run for surfaces whose freshness the flags already describe.
        // Once per surface per frame: the same texture is bound by many draws, and re-hashing it
        // for each one costs the scan over and over for an answer that cannot change mid-frame.
        if (!this.debugFlags.disableCpuTextureHash &&
            isRenderSurface(tex) && tex.everLocked && (tex.caps & DDSCAPS_TEXTURE) !== 0 &&
            !tex.gpuDirty && tex.lastUploadVersion === tex.version &&
            this.cpuHashFrame.get(tex.surfacePtr >>> 0) !== this.frameSerial) {
            this.cpuHashFrame.set(tex.surfacePtr >>> 0, this.frameSerial);
            const _tHash = drawCostProfiler.now();
            const h = this.hashSurfaceBytes(tex);
            drawCostProfiler.add(DC.p_hash, _tHash);
            if (h !== 0 && this.cpuContentHashes.get(tex.surfacePtr >>> 0) !== h) {
                this.cpuContentHashes.set(tex.surfacePtr >>> 0, h);
                this.renderStats.texHashDirty++;
                tex.gpuDirty = true;
            }
        }
        // Force resync: mark texture dirty to force re-upload from guest memory (diagnostic)
        if (this.debugFlags.forceTextureResync) {
            if (isRenderSurface(tex)) {
                tex.gpuDirty = true;
                tex.lastUploadVersion = -1;
                tex.rgbaScratch = undefined;
                tex.rgbaScratchVersion = undefined;
            } else if (isBitmapTexture(tex)) {
                tex.gpuNeedsUpload = true;
            }
        } else {
            this.tryAdoptFreshAliasUpload(tex);
        }
        // Re-evaluate sync need AFTER GPU resources exist. Computing sync-need
        // while gpuTexture is still null makes needsGPUSync return false, so
        // IDirect3DTexture2_Load data never reaches the GPU → invisible textures.
        const syncDecision = surfaceSyncManager.needsGPUSync(tex);
        if (tex.surfacePtr && syncDecision.needed) {
            if (this.shouldTraceLargeTexture(tex) && this.textureDrawDiagCount < 256) {
                Logger.log(LogCategory.DDRAW,
                    `prepareDraw: sync texture${stage} ` +
                    `ptr=0x${tex.surfacePtr.toString(16)} ${tex.width}x${tex.height} ` +
                    `reason="${syncDecision.reason}" ` +
                    (isRenderSurface(tex)
                        ? `version=${tex.version} lastUpload=${tex.lastUploadVersion} gpuDirty=${tex.gpuDirty} `
                        : `bitmap gpuNeedsUpload=${tex.gpuNeedsUpload} `) +
                    `hasView=${!!tex.gpuTextureView}`);
            }
            this.renderStats.texSyncs++;
            const _tSync = drawCostProfiler.now();
            this.syncSurfaceFromMemory(tex);
            // Prefer the game's authored mip pixels; fall back to box-gen from level 0.
            if (!this.uploadAuthoredMips(tex)) this.regenerateMipsIfNeeded(tex);
            drawCostProfiler.add(DC.p_sync, _tSync);
        }
        // Record which command buffer will hold the draw about to be encoded, and the content
        // it samples. Marking at PREPARE time (not when flushBatch records the draw) is
        // deliberately conservative: a prepared draw sits in currentBatch, and the early-submit
        // path flushes that batch first, so it lands in the epoch it was marked with. Being
        // conservative can cost an extra submit; it can never miss one.
        tex.sampledEncoderEpoch = this.encoderEpoch;
        tex.sampledContentVersion = surfaceContentVersion(tex);
    }

    /** Bit-cast a DWORD render state to its float value (POINTSIZE/SCALE are stored as floats). */
    private rsFloat(raw: number): number {
        this.psBitsU32[0] = raw >>> 0;
        return this.psBitsF32[0];
    }

    /**
     * Gate for the point-sprite expansion. A D3DPT_POINTLIST draw expands into sized quads
     * only when it actually needs a size > 1px or generated sprite texcoords:
     *   - the FVF carries per-vertex D3DFVF_PSIZE, OR
     *   - D3DRS_POINTSPRITEENABLE is on, OR
     *   - D3DRS_POINTSIZE (float-as-DWORD) is > 1.0.
     * Otherwise (unset size, or size≈1, no sprite) the draw stays on the legacy 1px
     * WebGPU point-list path, byte-identical — so nothing that relied on 1px points shifts.
     */
    private shouldExpandPointSprites(vertexType: number, renderStates: Int32Array): boolean {
        if ((vertexType & D3DFVF_PSIZE) !== 0) return true;
        if ((renderStates[D3DRENDERSTATE_POINTSPRITEENABLE] | 0) !== 0) return true;
        const rawSize = renderStates[D3DRENDERSTATE_POINTSIZE] | 0;
        if (rawSize === 0) return false; // unset → D3D default 1.0 → 1px
        return this.rsFloat(rawSize) > 1.0;
    }

    /**
     * DirectX fixed-function POINT SPRITES.
     *
     * Expands each input point (D3DPT_POINTLIST) into a screen-aligned, camera-facing quad
     * (2 triangles = 6 verts) in the shared 64-byte FFP vertex format, then draws it as a
     * TRIANGLELIST through the normal FFP fragment path (texture stages / blending / fog for
     * free). The quad is emitted directly in clip space with the vertex flagged XYZRHW so the
     * render VS passes the position through (no MVP re-apply) — corners are the projected point
     * center offset by ±half_size in *screen* space, which is exactly D3D's screen-space,
     * always-viewer-facing point-sprite model.
     *
     * Formulas (verified against DXVK src/d3d9/shaders/d3d9_fixed_function_vert.vert
     * calculatePointSize() + src/d3d9/d3d9_device.cpp UpdatePointMode/BindMultisampleState):
     *   size source : per-vertex PSIZE if D3DFVF_PSIZE, else D3DRS_POINTSIZE.
     *   attenuation : with D3DRS_POINTSCALEENABLE, final = Vh·size / sqrt(A + B·De + C·De²),
     *                 De = eye-space distance |worldView·pos|, A/B/C = D3DRS_POINTSCALE_A/B/C.
     *                 (DXVK folds 1/Vh² into A/B/C; algebraically identical to the D3D docs'
     *                  ScreenSize = Vh·size·sqrt(1/(A+B·De+C·De²)).) Without POINTSCALEENABLE,
     *                 size is screen-space pixels directly (no Vh scale, no attenuation).
     *   clamp       : clamp(size, D3DRS_POINTSIZE_MIN, D3DRS_POINTSIZE_MAX), applied last.
     *   sprite UVs  : D3DRS_POINTSPRITEENABLE ON → each corner gets [0,1]² texcoords
     *                 (overriding the point's UV); OFF → the point's single UV is replicated
     *                 to all 4 corners (whole quad samples one texel).
     */
    private drawPointSprites(
        target: DirectDrawSurfaceState,
        vertexType: number,
        verticesAddr: number,
        count: number,
        memory: Uint8Array,
        viewport: Viewport,
        texture: DirectDrawSurfaceState | null,
        renderStates: Int32Array,
        textureStates: Int32Array,
        stageTextures: readonly (DirectDrawSurfaceState | null)[] | null,
        texMatrices: readonly (Float32Array | null)[] | null,
        lighting: FFPLightingState | undefined,
        sourceStride: number | undefined,
        mvpMatrix: Float32Array | undefined,
        worldViewMatrix: Float32Array | null
    ): void {
        if (this.DEBUG_SKIP_RENDERING) return;
        if (count <= 0) return;

        const packedStride = computeFvfStride(vertexType);
        const stride = sourceStride && sourceStride > 0 ? Math.max(sourceStride, packedStride) : packedStride;
        const vertexRange = count * stride;
        if (!isValidAddress(memory, verticesAddr, vertexRange)) {
            this.renderStats.skipBadRange++;
            return;
        }

        const safeViewport = sanitizeViewportInto(this.safeVpScratchExpand, viewport, target.width, target.height);
        const vpW = safeViewport.width > 0 ? safeViewport.width : 640;
        const vpH = safeViewport.height > 0 ? safeViewport.height : 480;

        // Base per-point attributes (diffuse/specular/uv/normal + base position) via the shared
        // converter, then expand each point to 6 quad verts. Both live in one scratch block.
        const outCount = count * 6;
        const convSize = count * OUTPUT_VERTEX_BYTES;
        const expSize = outCount * OUTPUT_VERTEX_BYTES;
        const scratch = this.ensureScratchBuffer(convSize + expSize);
        const baseView = scratch.subarray(0, convSize);
        const expanded = scratch.subarray(convSize, convSize + expSize);

        this.vertexConverter.convertCPU(memory, verticesAddr, count, vertexType, baseView, vpW, vpH, stride, null, safeViewport.x, safeViewport.y);

        const baseF32 = new Float32Array(baseView.buffer, baseView.byteOffset, convSize / 4);
        const baseU32 = new Uint32Array(baseView.buffer, baseView.byteOffset, convSize / 4);
        const expF32 = new Float32Array(expanded.buffer, expanded.byteOffset, expSize / 4);
        const expU32 = new Uint32Array(expanded.buffer, expanded.byteOffset, expSize / 4);
        const U = OUTPUT_VERTEX_U32S; // 16 u32 per vertex

        const posType = vertexType & D3DFVF_POSITION_MASK;
        const isPreTransformed = posType === D3DFVF_XYZRHW || posType === D3DFVF_XYZW;
        const hasPsize = (vertexType & D3DFVF_PSIZE) !== 0;
        const hasNormal = (vertexType & D3DFVF_NORMAL) !== 0;
        const spriteEnable = (renderStates[D3DRENDERSTATE_POINTSPRITEENABLE] | 0) !== 0;
        const scaleEnable = (renderStates[D3DRENDERSTATE_POINTSCALEENABLE] | 0) !== 0;

        // Per-vertex PSIZE offset in the SOURCE vertex (after position + optional normal).
        const posBytes = isPreTransformed ? 16 : 12;
        const psizeOffset = posBytes + (hasNormal ? 12 : 0);
        const srcView = hasPsize ? new DataView(memory.buffer, memory.byteOffset + verticesAddr, vertexRange) : null;

        // POINTSIZE / *_MIN / *_MAX are floats bit-cast into the DWORD; the device adapter seeds
        // the D3D defaults (1.0/1.0/8192.0) so an explicit 0.0f is honored, not read as "unset".
        const sizeRs = this.rsFloat(renderStates[D3DRENDERSTATE_POINTSIZE] | 0);
        const sizeMin = this.rsFloat(renderStates[D3DRENDERSTATE_POINTSIZE_MIN] | 0);
        const sizeMax = this.rsFloat(renderStates[D3DRENDERSTATE_POINTSIZE_MAX] | 0);
        const scaleA = this.rsFloat(renderStates[D3DRENDERSTATE_POINTSCALE_A] | 0);
        const scaleB = this.rsFloat(renderStates[D3DRENDERSTATE_POINTSCALE_B] | 0);
        const scaleC = this.rsFloat(renderStates[D3DRENDERSTATE_POINTSCALE_C] | 0);

        const M = mvpMatrix && mvpMatrix.length >= 16 ? mvpMatrix : null;
        const WV = worldViewMatrix && worldViewMatrix.length >= 16 ? worldViewMatrix : null;

        // D3D never back-face-culls points. Pick the winding that survives the game's cull mode.
        const d3dCull = renderStates[D3DRENDERSTATE_CULLMODE] | 0;
        const order = d3dCull === D3DCULL_CW ? PS_ORDER_CCW : PS_ORDER_CW;

        let outV = 0;
        for (let i = 0; i < count; i++) {
            const b = i * U;
            const bx = baseF32[b + 0], by = baseF32[b + 1], bz = baseF32[b + 2], bw = baseF32[b + 3];

            // Clip-space center + eye-space distance De.
            let cx: number, cy: number, cz: number, cw: number, de: number;
            if (isPreTransformed) {
                // Converter already produced clip space for XYZRHW; XYZW is clip too.
                cx = bx; cy = by; cz = bz; cw = bw;
                de = Math.abs(cw) || 1.0;
            } else if (M) {
                // Row-major MVP applied exactly as the render VS does (uniforms.mvp * vec4(pos,1)).
                cx = M[0] * bx + M[4] * by + M[8] * bz + M[12];
                cy = M[1] * bx + M[5] * by + M[9] * bz + M[13];
                cz = M[2] * bx + M[6] * by + M[10] * bz + M[14];
                cw = M[3] * bx + M[7] * by + M[11] * bz + M[15];
                // "Exactly as the render VS does" includes the pixel-centre shift the VS
                // receives folded into its matrix (backends/webgpu/pixel-center.ts). Without
                // it, expanded point sprites sit half a pixel off every other primitive.
                const px = pixelCenterOffsetPx();
                if (px > 0) {
                    if (vpW > 0) cx += cw * (2 * px) / vpW;
                    if (vpH > 0) cy -= cw * (2 * px) / vpH;
                }
                if (WV) {
                    const ex = WV[0] * bx + WV[4] * by + WV[8] * bz + WV[12];
                    const ey = WV[1] * bx + WV[5] * by + WV[9] * bz + WV[13];
                    const ez = WV[2] * bx + WV[6] * by + WV[10] * bz + WV[14];
                    de = Math.sqrt(ex * ex + ey * ey + ez * ez);
                } else {
                    de = Math.abs(cw) || 1.0; // proxy: eye depth ≈ clip.w for a standard projection
                }
            } else {
                cx = bx; cy = by; cz = bz; cw = 1.0;
                de = 1.0;
            }

            if (cw === 0) cw = 1e-6; // avoid degenerate offset scale for clipped points

            // Effective size (px) with optional distance attenuation, then clamp.
            let size = hasPsize ? srcView!.getFloat32(i * stride + psizeOffset, true) : sizeRs;
            if (scaleEnable) {
                const denom = Math.max(scaleA + scaleB * de + scaleC * de * de, 1e-6);
                size = (vpH * size) / Math.sqrt(denom);
            }
            if (size < sizeMin) size = sizeMin;
            if (size > sizeMax) size = sizeMax;

            const half = size * 0.5;
            // Half-extent in clip space: NDC px→[-1,1] is 2/viewport; ×cw lifts NDC→clip.
            const offX = (half / vpW) * 2.0 * cw;
            const offY = (half / vpH) * 2.0 * cw;
            const baseU = baseF32[b + 9];
            const baseV = baseF32[b + 10];

            for (let t = 0; t < 6; t++) {
                const c = order[t];
                const dst = outV * U;
                outV++;
                // Copy all base attributes (normal/diffuse/specular/uv0-2/padding), then override.
                for (let j = 0; j < U; j++) expU32[dst + j] = baseU32[b + j];
                // Position: center + screen-aligned corner offset. Screen +y is down, so the
                // clip-y offset is negated (NDC y is up).
                expF32[dst + 0] = cx + PS_CORNER_SX[c] * offX;
                expF32[dst + 1] = cy - PS_CORNER_SY[c] * offY;
                expF32[dst + 2] = cz;
                expF32[dst + 3] = cw;
                // UV0: generated sprite coords when POINTSPRITEENABLE, else keep the point's UV.
                if (spriteEnable) {
                    expF32[dst + 9] = PS_CORNER_U[c];
                    expF32[dst + 10] = PS_CORNER_V[c];
                } else {
                    expF32[dst + 9] = baseU;
                    expF32[dst + 10] = baseV;
                }
            }
        }

        // Draw the expanded quads through the normal FFP path as a pre-transformed (XYZRHW,
        // clip-space passthrough) TRIANGLELIST. Drop position/PSIZE bits, force XYZRHW.
        const effVertexType = (vertexType & ~D3DFVF_POSITION_MASK & ~D3DFVF_PSIZE) | D3DFVF_XYZRHW;

        const requiredUniformBytes = this.ringBufferManager.getUniformAlignment();
        this.ringBufferManager.ensureSpaceForDraw(expSize, 0, requiredUniformBytes, () => {
            this.renderStats.midFrameFlush++;
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
            }
            this.flush();
        }, 0);

        const prepareResult = this.prepareDraw(
            target,
            effVertexType,
            D3DPT_TRIANGLELIST,
            viewport,
            texture,
            renderStates,
            textureStates,
            undefined, // MVP unused: XYZRHW passthrough
            stageTextures,
            false,
            texMatrices,
            lighting
        );

        if (!target.gpuTextureView) {
            this.renderStats.skipNoRT++;
            return;
        }

        const alloc = this.ringBufferManager.allocateVertexData(expanded);
        if (alloc.overflow) {
            this.renderStats.skipRingOverflow++;
            return;
        }

        // Preserve draw order: emit any pending MegaBatch before this immediate draw.
        this.flushBatch();
        this.ensureRenderPass(target, viewport);
        this.setupPipelineAndBindings(prepareResult);
        this.currentRenderPass!.setVertexBuffer(0, alloc.buffer, alloc.offset, expSize);
        this.currentRenderPass!.draw(outCount);
        if (this.opLogArmed > 0) this.opLog(`PSPRITE v=${outCount} pts=${count} sprite=${spriteEnable ? 1 : 0} scale=${scaleEnable ? 1 : 0}`);
        setAuthorityGpu(target, true);
    }

    private prepareDraw(
        target: DirectDrawSurfaceState,
        vertexType: number,
        primitiveType: number,
        viewport: Viewport,
        texture: DirectDrawSurfaceState | null,
        renderStates: Int32Array,
        textureStates: Int32Array,
        mvpMatrix: Float32Array | undefined,
        stageTextures: readonly (DirectDrawSurfaceState | null)[] | null,
        skipLegacyUniform?: boolean,
        texMatrices?: readonly (Float32Array | null)[] | null,
        lighting?: FFPLightingState
    ): PrepareDrawResult {
        this.ensureSurfaceGPUResources(target);

        // Pipelines are built HERE, before ensureRenderPass opens the pass they will run in,
        // so the target's colour format has to be declared here too — declaring it only at
        // pass-open would cache this draw's pipeline against the previous target's format.
        this.pipelineFactory.setColorTargetFormat(
            target.gpuTexture?.format ?? this.resolveSurfaceTextureFormat(target)
        );

        // CPU drawing can target a normal video-memory backbuffer too. In particular,
        // TLJ restores its previous software-cursor rectangle with a DDraw CPU Blt
        // *inside* BeginScene, before the first primitive. Restricting this upload to
        // texture/system-memory targets lets D3D continue from the stale GPU image that
        // still contains the cursor; the next Lock readback then bakes that cursor into
        // the saved background and produces permanent trails.
        const targetNeedsSync = needsRenderTargetUploadBeforeDraw(target);

        // Conservative pre-check: flush batch if any stage texture lacks GPU resources
        // or needs sync (evaluated per stage; stage 0 = `texture`). No `break` — the
        // overwrite gate below has to see EVERY stage, not just the first that needs sync.
        let anyTexMayNeedSync = false;
        let anySampledTexOverwritten = false;
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            const tex = s === 0 ? texture : stageTextures?.[s] ?? null;
            if (!tex) continue;
            if (surfaceSyncManager.needsGPUSync(tex).needed || !tex.gpuTextureView) {
                anyTexMayNeedSync = true;
            }
            if (this.isSampledContentOverwritten(tex)) anySampledTexOverwritten = true;
        }
        if (targetNeedsSync && this.isSampledContentOverwritten(target)) anySampledTexOverwritten = true;

        // The upload that is about to happen is a queue.writeTexture, and the draws that sampled
        // the PREVIOUS content are still sitting in an unsubmitted command buffer — so the write
        // would run ahead of them and they would all sample the new pixels. Submit first, exactly
        // as ensureClipPlanesUploaded does for its writeBuffer. flush() is reused rather than
        // open-coded because it also restores the bind fast-path and clears currentRenderTarget,
        // which is what forces the next pass to re-apply its viewport.
        if (anySampledTexOverwritten && this.currentEncoder
            && !this.debugFlags.disableTextureOverwriteSubmit) {
            this.renderStats.earlyTexSubmits++;
            if (this.opLogArmed > 0) this.opLog(`SUBMIT-EARLY epoch=${this.encoderEpoch}`);
            this.flush(false); // mid-frame: deferred clears stay pending for the next pass
        }

        // Preserve draw order: if we are about to sync textures, flush any pending batch first.
        if (this.currentBatch && (targetNeedsSync || anyTexMayNeedSync)) {
            this.flushBatch();
        }
        if (this.currentRenderPass && (targetNeedsSync || anyTexMayNeedSync)) {
            this.currentRenderPass.end();
            this.currentRenderPass = null;
            this.currentRenderTarget = null;
            this.resetBindFastPath();
        }

        if (targetNeedsSync) {
            this.syncSurfaceFromMemory(target);
        }

        const _tPTex = drawCostProfiler.now();
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            const tex = s === 0 ? texture : stageTextures?.[s] ?? null;
            if (tex) this.prepareStageTexture(s, tex);
        }
        drawCostProfiler.add(DC.p_tex, _tPTex);

        if (!target.gpuTextureView) {
            const pr = this.prepareResult;
            pr.uniformOffset = 0;
            pr.lightsOffset = 0;
            // Neutral cascade: stage 0 only, nothing sampled.
            this.ffpStages.resolve(textureStates, 0, false, false);
            this.ffpStages.pack();
            pr.pipeline = this.pipelineFactory.getOrCreatePipeline(
                vertexType,
                primitiveType,
                this.ffpStages,
                false,
                renderStates,
                null
            );
            pr.sampledMask = 0;
            pr.stageCount = this.ffpStages.stageCount;
            pr.stageViews.fill(null);
            for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
                const sp = pr.stageSamplers[s];
                sp.minFilter = D3DTFN_LINEAR;
                sp.magFilter = D3DTFG_LINEAR;
                sp.mipFilter = D3DTFP_NONE;
                sp.maxAnisotropy = 1;
                sp.addressU = D3DTADDRESS_WRAP;
                sp.addressV = D3DTADDRESS_WRAP;
                sp.mipLodBiasBits = 0;
                sp.maxMipLevel = 0;
                sp.borderColor = 0;
            }
            pr.stencilRef = dwordToUnsignedLong(renderStates[D3DRENDERSTATE_STENCILREF]);
            applySamplerDebugOverrides(this, pr);
            updateLastDrawDiagnostics(this, pr);
            return pr;
        }

        // "Zero-Depth" Initialization Bug
        const depthWasCreated = this.depthManager.ensureDepthForTarget(target);
        if (depthWasCreated) {
            // New depth buffer created - must clear to 1.0 (far plane) to prevent "nothing renders" bug
            const zEnable = renderStates[D3DRENDERSTATE_ZENABLE] || 0;
            if (zEnable) {
                this.clear(target, D3DCLEAR_ZBUFFER, 0, 1.0);
            }
        }

        // XYZRHW and XYZW are both pre-transformed (clip-space), no MVP needed
        // Use POSITION_MASK for comparison, not bitwise AND with overlapping constants!
        // D3DFVF_XYZW = 0x4002 includes D3DFVF_XYZ = 0x0002 bit, so (fvf & D3DFVF_XYZW) !== 0 gives
        // false positives when FVF has XYZ set.
        const posType = vertexType & D3DFVF_POSITION_MASK;
        const isRHWVertex = posType === D3DFVF_XYZRHW;
        const isXYZWVertex = posType === D3DFVF_XYZW;
        const isPreTransformed = isRHWVertex || isXYZWVertex;
        const isXYZVertex = posType === D3DFVF_XYZ;
        // Depth CLAMP, not CLIP, for a pre-transformed draw with depth testing off: with
        // D3DRS_ZENABLE=FALSE nothing reads or writes depth, so z can only decide whether the
        // clipper keeps the primitive — and real hardware keeps it. See RHW_DEPTH_CLAMP.
        const depthUnused = (renderStates[D3DRENDERSTATE_ZENABLE] || 0) === 0;
        const clampDepth = depthUnused && !this.debugFlags.disableRhwDepthClamp;
        const isRHW = isPreTransformed
            ? (RHW_PRETRANSFORMED | (clampDepth ? RHW_DEPTH_CLAMP : 0))
            : 0;


        // XYZ vertices without MVP matrix cause "vertex explosion"
        if (isXYZVertex && (!mvpMatrix || mvpMatrix.length < 16)) {
            if (!this.warnedXYZNoMVP) {
                this.warnedXYZNoMVP = true;
                Logger.warn(
                    LogCategory.SYSTEM,
                    `DDrawWebGPUExecutor: XYZ vertex format (0x${vertexType.toString(16)}) used without MVP matrix! ` +
                        `World coordinates will not be transformed correctly, causing vertex explosion. ` +
                        `Ensure SetTransform(D3DTS_WORLD/VIEW/PROJECTION) is called before drawing.`
                );
            }
        } else if (isXYZVertex && mvpMatrix && mvpMatrix.length >= 16) {
            // Debug: log MVP matrix for first XYZ draw to verify it's correct
            if (!this.loggedXYZMVP) {
                this.loggedXYZMVP = true;
                Logger.verbose(
                    LogCategory.DDRAW,
                    `DDrawWebGPUExecutor: XYZ vertex format (0x${vertexType.toString(16)}) with MVP matrix:\n` +
                        `  [${mvpMatrix[0].toFixed(3)}, ${mvpMatrix[1].toFixed(3)}, ${mvpMatrix[2].toFixed(3)}, ${mvpMatrix[3].toFixed(3)}]\n` +
                        `  [${mvpMatrix[4].toFixed(3)}, ${mvpMatrix[5].toFixed(3)}, ${mvpMatrix[6].toFixed(3)}, ${mvpMatrix[7].toFixed(3)}]\n` +
                        `  [${mvpMatrix[8].toFixed(3)}, ${mvpMatrix[9].toFixed(3)}, ${mvpMatrix[10].toFixed(3)}, ${mvpMatrix[11].toFixed(3)}]\n` +
                        `  [${mvpMatrix[12].toFixed(3)}, ${mvpMatrix[13].toFixed(3)}, ${mvpMatrix[14].toFixed(3)}, ${mvpMatrix[15].toFixed(3)}]`
                );
            }
        }

        const alphaRefRaw = renderStates[D3DRENDERSTATE_ALPHAREF] || 0;
        let alphaRef = Math.max(0, Math.min(255, alphaRefRaw & 0xff));

        // D3DRENDERSTATE_TEXTUREFACTOR: ARGB color
        const textureFactorDword = renderStates[D3DRENDERSTATE_TEXTUREFACTOR] ?? 0xFFFFFFFF;
        const textureFactorR = ((textureFactorDword >> 16) & 0xff) / 255.0;
        const textureFactorG = ((textureFactorDword >> 8) & 0xff) / 255.0;
        const textureFactorB = (textureFactorDword & 0xff) / 255.0;
        const textureFactorA = ((textureFactorDword >> 24) & 0xff) / 255.0;

        // Resolve the FFP stage cascade for ALL stages in one pass (per-stage defaults,
        // missing-texture remaps, cascade termination, sampling decisions) — the D3D7/D3D8
        // per-stage rules live in ffp-stages.ts.
        // D3DTSS_TEXCOORDINDEX defaults (stage index) are seeded into the state array at
        // device creation (D3D7 createDefaultTextureStates / D3D8 adapter resetState), so a
        // 0 there is an EXPLICIT SetTextureStageState(N, TEXCOORDINDEX, 0).
        let realTexMask = 0;
        if (texture?.gpuTextureView) realTexMask |= 1;
        if (stageTextures) {
            for (let s = 1; s < MAX_FFP_SAMPLED_STAGES; s++) {
                if (stageTextures[s]?.gpuTextureView) realTexMask |= 1 << s;
            }
        }
        
        // A stage with D3DTSS_TCI_CAMERASPACE* texgen GENERATES its coordinates from the
        // camera-space position/normal/reflection, so the vertex format carries no UV set at
        // all — deriving "has texcoords" from the FVF alone dropped the texture, D3DTA_TEXTURE
        // then resolved to white, and the surrounding blend turned that into a solid fill:
        // SRCALPHA/INVSRCALPHA painted it white, ZERO/INVSRCCOLOR painted it black. That is
        // what XIII's projected shadows and decals look like when this is wrong.
        const hasTexCoords = (vertexType & 0xf00) !== 0 || this.hasCameraSpaceTexgen(textureStates);
        const stages = this.ffpStages;
        stages.resolve(textureStates, realTexMask, hasTexCoords, !!this.dummyTextureView);

        // Per-stage texture transforms (D3DTS_TEXTUREn matrices gated by TTFF; see
        // resolveTexXformFlags). The resolved flags ride stages[N].w in the packed
        // cascade; the full row-major matrices ride the legacy uniform slot tail.
        // Recomputed here (cheap, zero-alloc) rather than passed in so prepareDraw
        // stays self-contained.
        this.resolveTexXformFlags(textureStates, texMatrices);
        for (let s = 0; s < MAX_FFP_TEX_MATRICES; s++) {
            stages.texXformFlags[s] = this.texXformFlagsScratch[s];
        }

        const useTexture = (stages.sampledMask & 1) !== 0;
        const missingTexture = (stages.missingMask & 1) !== 0;

        // DIAGNOSTIC: Detect "texture set but no gpuTextureView" — this causes white flash
        // (shader falls back to the diffuse color when stage 0 samples nothing)
        if (texture && !texture.gpuTextureView) {
            Logger.warn(LogCategory.DDRAW,
                `⚠️ WHITE-FLASH-RISK: texture 0x${texture.surfacePtr.toString(16)} has NO gpuTextureView ` +
                `after ensureSurfaceGPUResources! ${texture.width}x${texture.height} ` +
                `caps=0x${texture.caps.toString(16)} type=${texture.surfaceType} ` +
                `gpuTexture=${!!texture.gpuTexture}`);
        }

        // DIAGNOSTIC: the complement of the check above — the texture IS ready on the GPU and
        // stage 0 asks for it, yet the cascade resolved to "not sampled". The stage then reads
        // D3DTA_TEXTURE as white and the surrounding blend turns that into a SOLID FILL:
        // SRCALPHA/INVSRCALPHA paints it white, ZERO/INVSRCCOLOR paints it black. This is the
        // shape a texgen-only draw took before hasTexCoords accounted for texgen; it is worth a
        // standing alarm because the picture alone reads as "that surface is just white".
        if (texture?.gpuTextureView && !useTexture && stages.colorOp[0] !== D3DTOP_DISABLE) {
            this.droppedTextureDraws++;
            if (this.droppedTextureDraws <= 8) {
                Logger.warn(LogCategory.DDRAW,
                    `⚠️ SOLID-FILL-RISK: stage 0 wants a texture but the cascade dropped it — ` +
                    `tex 0x${(texture.surfacePtr ?? 0).toString(16)} ${texture.width}x${texture.height} ` +
                    `fvfTexSets=${(vertexType >>> 8) & 0xf} ` +
                    `colorOp=${stages.colorOp[0]} arg1=0x${stages.colorArg1[0].toString(16)} ` +
                    `tci=0x${(textureStates[D3DTSS_TEXCOORDINDEX] >>> 0).toString(16)} ` +
                    `hasTexCoords=${hasTexCoords}`);
            }
        }

        if (this.shouldTraceLargeTexture(texture) && this.textureDrawDiagCount < 256) {
            this.textureDrawDiagCount++;
            Logger.log(LogCategory.DDRAW,
                `prepareDraw: bind texture0 #${this.textureDrawDiagCount} ` +
                `ptr=0x${texture.surfacePtr.toString(16)} ${texture.width}x${texture.height} ` +
                `hasGpuTexture=${!!texture.gpuTexture} hasView=${!!texture.gpuTextureView} ` +
                (isRenderSurface(texture)
                    ? `version=${texture.version} lastUpload=${texture.lastUploadVersion} gpuDirty=${texture.gpuDirty} `
                    : `bitmap gpuNeedsUpload=${texture.gpuNeedsUpload} `) +
                `hasTexCoords=${hasTexCoords} useTexture=${useTexture} ` +
                `colorOp=${stages.colorOp[0]} colorArg1=0x${stages.colorArg1[0].toString(16)} colorArg2=0x${stages.colorArg2[0].toString(16)} ` +
                `alphaOp=${stages.alphaOp[0]} alphaArg1=0x${stages.alphaArg1[0].toString(16)} alphaArg2=0x${stages.alphaArg2[0].toString(16)}`);
        }

        // DIAGNOSTIC: Log when texture is missing but required
        if (missingTexture && texture) {
            Logger.warn(LogCategory.DDRAW,
                `⚠️ MISSING TEXTURE in draw call! ` +
                `surfacePtr=0x${texture.surfacePtr.toString(16)} ` +
                `surfaceType=${texture.surfaceType} ` +
                `gpuTexture=${!!texture.gpuTexture} ` +
                `gpuTextureView=${!!texture.gpuTextureView} ` +
                `${isBitmapTexture(texture) ? `gpuNeedsUpload=${texture.gpuNeedsUpload}` : `mode=${texture.mode} gpuDirty=${texture.gpuDirty} version=${texture.version}`}`
            );
        }

        // Detector (log-once): passthrough UV set beyond the converted vertex layout.
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            const tci = stages.tci[s];
            if ((tci & ~0xffff) === 0 && (tci & 0xffff) >= MAX_FFP_UV_SETS &&
                !this.loggedTexCoordQuirks.has(tci | (s << 24))) {
                this.loggedTexCoordQuirks.add(tci | (s << 24));
                Logger.warn(LogCategory.DDRAW,
                    `FFP: stage ${s} TEXCOORDINDEX=${tci} references UV set >${MAX_FFP_UV_SETS - 1} — ` +
                    `only ${MAX_FFP_UV_SETS} UV sets are converted, falling back to UV set 0`);
            }
        }
        // Detector (log-once): a stage beyond the sampled-stage limit is active. The
        // arithmetic cascade still runs for it, but it can never bind a texture.
        if (!this.loggedStage3Plus) {
            for (let s = MAX_FFP_SAMPLED_STAGES; s < MAX_FFP_STAGES; s++) {
                const opN = textureStates[s * 32 + D3DTSS_COLOROP] || 0;
                if (opN !== 0 && opN !== D3DTOP_DISABLE) {
                    this.loggedStage3Plus = true;
                    Logger.warn(LogCategory.DDRAW,
                        `FFP: stage ${s} is active (COLOROP=${opN}) — arithmetic ops run, but texture ` +
                        `sampling is limited to stages 0..${MAX_FFP_SAMPLED_STAGES - 1}`);
                    break;
                }
            }
        }

        // Read lighting and ambient
        const lightingEnabled = this.debugFlags.forceDisableLighting
            ? 0
            : (renderStates[D3DRENDERSTATE_LIGHTING] || 0);
        const ambientDword = renderStates[D3DRENDERSTATE_AMBIENT] || 0;
        const ambientR = ((ambientDword >> 16) & 0xff) / 255.0;
        const ambientG = ((ambientDword >> 8) & 0xff) / 255.0;
        const ambientB = (ambientDword & 0xff) / 255.0;
        const ambientA = ((ambientDword >> 24) & 0xff) / 255.0;

        // Read color key
        const colorKeyRenderState = renderStates[D3DRENDERSTATE_COLORKEYENABLE] || 0;
        let textureHasColorKey = !!(texture?.srcColorKey);

        // Colorkey is active only when the texture has a srcColorKey AND
        // D3DRENDERSTATE_COLORKEYENABLE (41) is set to non-zero by the game.
        // Ignoring COLORKEYENABLE would make auto-assigned srcColorKey on 16-bit
        // textures (texture-manager) treat ALL black pixels as transparent.
        const colorKeyEnabled = textureHasColorKey && colorKeyRenderState !== 0;

        let colorKeyR = 1.0;
        let colorKeyG = 0.0;
        let colorKeyB = 1.0;
        let colorKeyA = 1.0;
        if (colorKeyEnabled && texture?.srcColorKey) {
            const fmt = detectPixelFormat(texture.format);
            let ck = decodeColorKeyToRGBA(texture.srcColorKey.low, fmt);

            // Apply quantization to match surface format degradation (888->565->888)
            // This ensures Color Key exactly matches quantized values from texture
            // Only quantize for non-32-bit formats (16-bit formats lose precision)
            if (texture.format.bpp !== 32) {
                const ck255 = {
                    r: Math.round(ck.r * 255),
                    g: Math.round(ck.g * 255),
                    b: Math.round(ck.b * 255),
                    a: Math.round(ck.a * 255),
                };
                const quantized = quantizeColorKey(ck255, texture.format);
                ck = {
                    r: quantized.r / 255,
                    g: quantized.g / 255,
                    b: quantized.b / 255,
                    a: quantized.a / 255,
                };
            }

            colorKeyR = ck.r;
            colorKeyG = ck.g;
            colorKeyB = ck.b;
            colorKeyA = ck.a;

            // DIAGNOSTIC: Log colorkey usage in draw (first 10 at LOG level, rest verbose)
            if (this.debugColorkeyLogCount < 10) {
                this.debugColorkeyLogCount++;
                Logger.log(LogCategory.DDRAW,
                    `[COLORKEY-DRAW #${this.debugColorkeyLogCount}] Colorkey ENABLED for texture 0x${texture.surfacePtr.toString(16)} ` +
                    `srcColorKey=0x${texture.srcColorKey.low.toString(16)}-0x${texture.srcColorKey.high.toString(16)} ` +
                    `decoded RGBA=(${(colorKeyR*255)|0}, ${(colorKeyG*255)|0}, ${(colorKeyB*255)|0}, ${(colorKeyA*255)|0})`);
            } else {
                Logger.verbose(LogCategory.DDRAW,
                    `prepareDraw: Colorkey ENABLED for texture 0x${texture.surfacePtr.toString(16)} ` +
                    `srcColorKey=0x${texture.srcColorKey.low.toString(16)}-0x${texture.srcColorKey.high.toString(16)} ` +
                    `decoded RGBA=(${(colorKeyR*255)|0}, ${(colorKeyG*255)|0}, ${(colorKeyB*255)|0}, ${(colorKeyA*255)|0})`);
            }
        } else if (colorKeyRenderState && useTexture && !textureHasColorKey) {
            // DIAGNOSTIC: Render state is set but texture has no colorkey - correctly ignoring
            if (this.debugColorkeyLogCount < 10) {
                this.debugColorkeyLogCount++;
                Logger.log(LogCategory.DDRAW,
                    `[COLORKEY-DRAW #${this.debugColorkeyLogCount}] Colorkey render state ON but texture has no srcColorKey ` +
                    `texture=0x${texture?.surfacePtr?.toString(16) ?? 'null'}`);
            } else {
                Logger.verbose(LogCategory.DDRAW,
                    `prepareDraw: Colorkey render state ON but texture has no srcColorKey (correctly ignored) ` +
                    `texture=0x${texture?.surfacePtr?.toString(16) ?? 'null'}`);
            };
        }


        // Fog
        const fogEnable = renderStates[D3DRENDERSTATE_FOGENABLE] || 0;
        const fogTableMode = renderStates[D3DRENDERSTATE_FOGTABLEMODE] ?? D3DFOG_NONE;
        const fogVertexMode = renderStates[D3DRENDERSTATE_FOGVERTEXMODE] ?? D3DFOG_NONE;
        const fogMode = resolveFfpFogMode(fogEnable, fogTableMode, fogVertexMode, !!isRHW,
            (vertexType & D3DFVF_SPECULAR) !== 0);
        const specularEnable = renderStates[D3DRENDERSTATE_SPECULARENABLE] ? 1 : 0;
        const fogColorDword = renderStates[D3DRENDERSTATE_FOGCOLOR] ?? 0;
        const fogColorR = ((fogColorDword >> 16) & 0xff) / 255.0;
        const fogColorG = ((fogColorDword >> 8) & 0xff) / 255.0;
        const fogColorB = (fogColorDword & 0xff) / 255.0;
        const fogColorA = 1.0;
        
        // Fog params are float bits in the render-state DWORD. Device layers seed the
        // D3D defaults (start=0.0f, end=1.0f, density=1.0f), so raw values are always
        // trustworthy — a raw 0 IS a legitimate 0.0f (e.g. LINEAR fog with start=0).
        let fogStart = 0.0;
        let fogEnd = 1.0;
        let fogDensity = 1.0;
        if (fogEnable) {
            const fsRaw = renderStates[D3DRENDERSTATE_FOGSTART];
            const feRaw = renderStates[D3DRENDERSTATE_FOGEND];
            const densityRaw = renderStates[D3DRENDERSTATE_FOGDENSITY];

            if (fsRaw !== undefined) fogStart = dwordToFloat(fsRaw);
            if (feRaw !== undefined) fogEnd = dwordToFloat(feRaw);
            if (densityRaw !== undefined) fogDensity = dwordToFloat(densityRaw);
        }

        // sanitizeViewportInto already defaults a missing minZ/maxZ to 0/1, so the spread
        // that used to build those defaults was a second per-draw allocation for nothing.
        const safeViewport = sanitizeViewportInto(this.safeVpScratchPrepare, viewport, target.width, target.height);

        // Determine if blend state requires premultiplied alpha (ONE/INVSRCALPHA)
        // When srcBlend=ONE and dstBlend=INVSRCALPHA, WebGPU expects premultiplied alpha input.
        // Without premultiply, RGB gets added at full intensity, causing white overexposure.
        const alphaBlend = renderStates[D3DRENDERSTATE_ALPHABLENDENABLE] || 0;
        const srcBlend = renderStates[D3DRENDERSTATE_SRCBLEND] || 0;
        const dstBlend = renderStates[D3DRENDERSTATE_DESTBLEND] || 0;
        // Same resolution PipelineFactory applies: unwritten-state defaults, then the
        // BOTH*SRCALPHA legacy fixup (DESTBLEND is moot once SRCBLEND names one of those).
        const [effectiveSrcBlend, effectiveDstBlend] = alphaBlend
            ? fixupBoth(srcBlend || 2, dstBlend || 1) // Defaults: ONE(2)/ZERO(1)
            : [0, 0];

        // Premultiply is required when blend state is ONE/INVSRCALPHA (premultiplied alpha blending)
        const premultiplyOutput = (alphaBlend && effectiveSrcBlend === D3DBLEND_ONE && effectiveDstBlend === D3DBLEND_INVSRCALPHA) ? 1 : 0;

        // Alpha test (now dynamic uniforms for MegaBatch)
        const rawAlphaTestRS = renderStates[D3DRENDERSTATE_ALPHATESTENABLE] || 0;
        let alphaTestEnabled = this.debugFlags.forceDisableAlphaTest ? 0 : rawAlphaTestRS;
        let alphaFunc = renderStates[D3DRENDERSTATE_ALPHAFUNC] || 8; // Default to D3DCMP_ALWAYS (8)

        // Auto-alpha-test DISABLED: some DX6 games set ALPHATESTENABLE=0
        // right before DrawIndexedPrimitive.
        // Auto-alpha-test was injecting alphaFunc=GREATEREQUAL ref=1, which discarded ALL pixels
        // with alpha=0 — including black tire pixels (ARGB1555 bit15=0 → alpha=0).
        // Transparency in these games works via blend equations:
        //   - UI sprites: additive blend (ONE/ONE) — black=(0,0,0) adds nothing → transparent
        //   - Foliage/particles: SRCALPHA/INVSRCALPHA — alpha=0 → src*0 + dst*1 → transparent
        //   - 3D scene (tires): blending OFF → all pixels write directly → opaque
        // The shader's conditional alpha=1.0 override (when blending disabled) prevents alpha
        // leakage to intermediate render targets. Canvas alphaMode="opaque" handles final display.

        // ARGB1555 alpha-discard: When texture has alpha channel (aMask=0x8000) but neither
        // alpha blending nor alpha test is enabled, inject alpha test to discard alpha=0 pixels.
        // Without this, the shader's alpha=1.0 override (for blending-off) makes transparent
        // ARGB1555 pixels (bit15=0) opaque — stale pixels with non-zero RGB appear as white flash.
        // Opaque ARGB1555 pixels have bit15=1 → alpha=255 → pass GREATEREQUAL 1.
        // Skip when ALPHAOP=MODULATE — the game explicitly modulates texture alpha
        // with vertex alpha. Auto-test uses the MODULATE result, so if vertex alpha=0,
        // MODULATE produces 0 → fails GREATEREQUAL 1 → ALL pixels discarded → black screen.
        // UT99 demo uses ALPHAOP=MODULATE + ALPHABLENDENABLE=0 + ALPHATESTENABLE=0.
        if (!alphaBlend && !rawAlphaTestRS && useTexture && texture?.format?.aMask
            && stages.alphaOp[0] !== D3DTOP_MODULATE) {
            alphaTestEnabled = 1;
            alphaFunc = 7; // D3DCMP_GREATEREQUAL
            alphaRef = 1;  // Discard alpha=0, pass alpha>=1
        }

        // Determine texture format for swizzle flag
        // Use texture's actual format, not swapchain format
        // Bitmap textures are always rgba8unorm, but swapchain might be bgra8unorm
        // If texture exists but gpuTextureFormat is undefined, default to rgba8unorm
        // (not swapChainFormat) because bitmap textures are always uploaded as RGBA.
        // Using swapChainFormat (bgra8unorm on Windows) would cause incorrect swizzle.
        let textureFormat: GPUTextureFormat;
        if (texture) {
            // Texture exists - use its format, or default to rgba8unorm for bitmap textures
            textureFormat = texture.gpuTextureFormat ?? "rgba8unorm";
            if (!texture.gpuTextureFormat && Logger.isEnabled(LogCategory.DDRAW, LogLevel.WARN)) {
                Logger.warn(LogCategory.DDRAW,
                    `prepareDraw: texture at 0x${texture.surfacePtr?.toString(16)} has undefined gpuTextureFormat, defaulting to rgba8unorm`);
            }
        } else {
            // No texture - use swapchain format (for render target output)
            textureFormat = this.swapChainFormat;
        }
        
        
        const mat = lighting?.material ?? this.defaultMaterial;
        const world = lighting?.worldMatrix ?? null;
        // World×View for camera-space texgen (D3DTSS_TCI_CAMERASPACE*); rides the legacy
        // uniform slot only (texgen draws carry a texture matrix → MegaBatch is vetoed).
        const worldView = lighting?.worldViewMatrix ?? null;
        const matDiffuse = mat.diffuse;
        const matAmbient = mat.ambient;
        const matSpecular = mat.specular;
        const matEmissive = mat.emissive;
        const matPower = mat.power;
        // Resolve effective material colour sources against D3DRS_COLORVERTEX and this draw's
        // FVF (see resolveFfpColorSource). This MUST accompany the corrected D3D8 defaults
        // (DIFFUSE=COLOR1/SPECULAR=COLOR2): otherwise a normal-lit mesh with no vertex colours
        // would sample garbage. COLORVERTEX defaults to TRUE per D3D — the default is SEEDED
        // into renderStates at device init (D3D7 createDefaultRenderStates / D3D8
        // initDefaultStates): renderStates is an Int32Array, so a `?? 1` fallback can never
        // fire and a raw 0 here is an EXPLICIT SetRenderState(COLORVERTEX, FALSE).
        const colorVertex = renderStates[D3DRENDERSTATE_COLORVERTEX] !== 0;
        const hasDiffuseFvf = (vertexType & D3DFVF_DIFFUSE) !== 0;
        const hasSpecularFvf = (vertexType & D3DFVF_SPECULAR) !== 0;
        const matDiffuseSrc = resolveFfpColorSource(lighting?.diffuseSource ?? 0, colorVertex, hasDiffuseFvf, hasSpecularFvf);
        const matAmbientSrc = resolveFfpColorSource(lighting?.ambientSource ?? 0, colorVertex, hasDiffuseFvf, hasSpecularFvf);
        const matSpecularSrc = resolveFfpColorSource(lighting?.specularSource ?? 0, colorVertex, hasDiffuseFvf, hasSpecularFvf);
        const matEmissiveSrc = resolveFfpColorSource(lighting?.emissiveSource ?? 0, colorVertex, hasDiffuseFvf, hasSpecularFvf);
        // FFP lighting flags for the uniform: a real per-draw normal-presence flag (the vertex
        // converter substitutes (0,0,1) for a missing normal, which would otherwise produce bogus
        // directional shading instead of the D3D-correct ambient+emissive-only result), and the
        // real D3DRS_LOCALVIEWER (default TRUE) for specular half-vector computation.
        const hasNormalFlag = (vertexType & D3DFVF_NORMAL) !== 0 ? 1 : 0;
        const localViewerFlag = renderStates[D3DRENDERSTATE_LOCALVIEWER] !== 0 ? 1 : 0;

        // TEMP DIAG (__ffpSrcDiag): log resolved lighting sources for lit untextured draws.
        {
            const g = globalThis as { __ffpSrcDiag?: number; __ffpSrcSink?: string[] };
            if (g.__ffpSrcDiag && g.__ffpSrcDiag > 0 && !texture && (renderStates[D3DRENDERSTATE_LIGHTING] | 0) !== 0) {
                g.__ffpSrcDiag--;
                const line = `[ffp-src] fvf=0x${vertexType.toString(16)} lighting=${lighting ? 'yes' : 'NULL'} ` +
                    `colorVertex=${colorVertex} dSrc=${lighting?.diffuseSource}→${matDiffuseSrc} aSrc=${lighting?.ambientSource}→${matAmbientSrc} ` +
                    `eSrc=${lighting?.emissiveSource}→${matEmissiveSrc} mAmb=${matAmbient.r},${matAmbient.g},${matAmbient.b} ` +
                    `mDif=${matDiffuse.r},${matDiffuse.g},${matDiffuse.b},${matDiffuse.a} gAmb=${lighting?.ambientColor?.r},${lighting?.ambientColor?.g},${lighting?.ambientColor?.b} ` +
                    `nLights=${lighting?.lights?.length ?? 0} hasNormal=${hasNormalFlag}`;
                Logger.warn(LogCategory.DDRAW, line);
                (g.__ffpSrcSink ??= []).push(line);
            }
        }

        // Resolve stage views BEFORE packing + allocating uniforms: the pipeline layout
        // declares a binding per sampling stage, so a stage whose view is unexpectedly
        // missing must be demoted here — and the demotion re-terminates the cascade,
        // which must be reflected in the packed ops the shader reads.
        const pr = this.prepareResult;
        pr.stageViews[0] = useTexture
            ? ((texture ? this.sampleViewFor(texture) : null) ?? this.dummyTextureView)
            : null;
        for (let s = 1; s < MAX_FFP_SAMPLED_STAGES; s++) {
            if ((stages.sampledMask & (1 << s)) === 0) {
                pr.stageViews[s] = null;
                continue;
            }
            const tex = stageTextures?.[s] ?? null;
            const view = tex ? this.sampleViewFor(tex) : null;
            if (!view) {
                Logger.warn(LogCategory.DDRAW,
                    `prepareDraw: stage ${s} texture has no sample view — demoting it (and the cascade above it)`);
                stages.demoteSampling(s);
            }
            pr.stageViews[s] = view;
        }
        // A demotion re-terminates the cascade — clear views of any stage it disabled.
        for (let s = 1; s < MAX_FFP_SAMPLED_STAGES; s++) {
            if ((stages.sampledMask & (1 << s)) === 0) pr.stageViews[s] = null;
        }

        if (useTexture && !texture?.gpuTextureView) {
            if ((globalThis as any).__ddrawVerboseDiag === true && (!(this as any)._dummyDiagDone || ((this as any)._dummyDiagN ?? 0) < 20)) {
                (this as any)._dummyDiagN = ((this as any)._dummyDiagN ?? 0) + 1;
                (this as any)._dummyDiagDone = ((this as any)._dummyDiagN ?? 0) >= 20;
                const surfAddr = texture ? `0x${texture.surfacePtr?.toString(16) ?? "?"}` : "<null>";
                const size = texture ? `${texture.width}x${texture.height}` : "<null>";
                const hasTex = !!texture;
                const hasGpuTex = !!texture?.gpuTexture;
                Logger.warn(LogCategory.DDRAW,
                    `[DUMMY-TEX #${(this as any)._dummyDiagN}] fell back to the 1×1 dummy texture: useTexture=true but ` +
                    `gpuTextureView missing. surfaceAddr=${surfAddr} size=${size} hasTexture=${hasTex} ` +
                    `hasGpuTexture=${hasGpuTex} gpuTextureFormat=${texture?.gpuTextureFormat} ` +
                    `caps=0x${(texture?.caps ?? 0).toString(16)} mode=${(texture as any)?.mode ?? "?"}`);
            }
        }

        // Pack the final (post-demotion) cascade for the GPU slots.
        stages.pack();

        // Skip legacy uniform allocation when MegaBatch path will be used (saves the slot write + ring buffer advance)
        const _tPUni = drawCostProfiler.now();
        const uniformOffset = skipLegacyUniform ? -1 : this.ringBufferManager.allocateUniformSlot(
            safeViewport.width,
            safeViewport.height,
            safeViewport.minZ,
            safeViewport.maxZ,
            alphaRef,
            isRHW,
            lightingEnabled,
            ambientR,
            ambientG,
            ambientB,
            ambientA,
            colorKeyEnabled ? 1 : 0,
            colorKeyR,
            colorKeyG,
            colorKeyB,
            colorKeyA,
            mvpMatrix,
            fogMode,
            fogStart,
            fogEnd,
            fogDensity,
            fogColorR,
            fogColorG,
            fogColorB,
            fogColorA,
            textureFactorR,
            textureFactorG,
            textureFactorB,
            textureFactorA,
            stages,
            specularEnable,
            premultiplyOutput,
            hasNormalFlag,
            localViewerFlag,
            texMatrices ?? null,
            worldView,
            world,
            matDiffuse,
            matAmbient,
            matSpecular,
            matEmissive,
            matPower,
            matDiffuseSrc,
            matAmbientSrc,
            matSpecularSrc,
            matEmissiveSrc,
            lighting,
            // D3DRS_CLIPPLANEENABLE — per-draw enable bitmask for the FFP user clip planes
            // (plane coefficients ride the device-global binding-6 buffer). 0 → inert.
            renderStates[D3DRENDERSTATE_CLIPPLANEENABLE] | 0
        );

        // MegaBatch: Also allocate in storage buffer for batching without uniformOffset constraint
        const drawUniformsAlloc = this.ringBufferManager.allocateDrawUniforms(
            safeViewport.width,
            safeViewport.height,
            safeViewport.minZ,
            safeViewport.maxZ,
            alphaRef,
            isRHW,
            lightingEnabled,
            ambientR,
            ambientG,
            ambientB,
            ambientA,
            colorKeyEnabled ? 1 : 0,
            colorKeyR,
            colorKeyG,
            colorKeyB,
            colorKeyA,
            mvpMatrix,
            fogMode,
            fogStart,
            fogEnd,
            fogDensity,
            fogColorR,
            fogColorG,
            fogColorB,
            fogColorA,
            textureFactorR,
            textureFactorG,
            textureFactorB,
            textureFactorA,
            stages,
            specularEnable,
            premultiplyOutput,
            alphaTestEnabled ? 1 : 0,
            alphaFunc,
            world,
            matDiffuse,
            matAmbient,
            matSpecular,
            matEmissive,
            matPower,
            matDiffuseSrc,
            matAmbientSrc,
            matSpecularSrc,
            matEmissiveSrc,
            lighting
        );
        const drawIndex = drawUniformsAlloc.index;
        drawCostProfiler.add(DC.p_uni, _tPUni);

        const _tPPipe = drawCostProfiler.now();
        const pipeline = this.pipelineFactory.getOrCreatePipeline(
            vertexType,
            primitiveType,
            stages,
            stages.missingMask !== 0,
            renderStates,
            texture
        );
        drawCostProfiler.add(DC.p_pipe, _tPPipe);

        pr.uniformOffset = uniformOffset;
        // Per-draw FFP light set (binding 5) — captured here so each object lights with its own
        // active light set (Gamebryo re-selects lights per object). Skipped when lighting is off.
        pr.lightsOffset = lightingEnabled ? this.ringBufferManager.allocateLightSlot(lighting) : 0;
        pr.drawIndex = drawIndex;
        pr.pipeline = pipeline;
        pr.sampledMask = stages.sampledMask;
        pr.stageCount = stages.stageCount;
        // Per-stage sampler parameters. D3D7 default filter is POINT (1), not LINEAR (2):
        // using LINEAR when the game doesn't set filters causes half-texel shifts in
        // 2D/font rendering where UVs land on exact texel boundaries.
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            const sp = pr.stageSamplers[s];
            sp.minFilter = stages.minFilter[s] || D3DTFN_POINT;
            sp.magFilter = stages.magFilter[s] || D3DTFG_POINT;
            sp.mipFilter = stages.mipFilter[s] || D3DTFP_NONE;
            sp.maxAnisotropy = stages.maxAnisotropy[s] || 1;
            sp.addressU = stages.addressU[s];
            sp.addressV = stages.addressV[s];
            // D3DTSS_MIPMAPLODBIAS / MAXMIPLEVEL / BORDERCOLOR: resolve() decodes them and
            // getOrCreateStageSampler consumes them, so they must be carried here too — a stage
            // left at the default reads them as 0, which is exactly "no bias, full mip chain,
            // transparent border".
            sp.mipLodBiasBits = stages.mipLodBiasBits[s];
            sp.maxMipLevel = stages.maxMipLevel[s];
            sp.borderColor = stages.borderColor[s];
        }
        // Force point filtering on stage 0 when color key is enabled (must match the
        // pointSample bias decision in the pipeline factory).
        if (colorKeyEnabled && useTexture) {
            pr.stageSamplers[0].minFilter = D3DTFN_POINT;
            pr.stageSamplers[0].magFilter = D3DTFG_POINT;
        }

        applySamplerDebugOverrides(this, pr);
        pr.stencilRef = dwordToUnsignedLong(renderStates[D3DRENDERSTATE_STENCILREF]);
        updateLastDrawDiagnostics(this, pr);
        return pr;
    }

    /**
     * Seam suppression: when a pre-transformed (XYZRHW) LINEAR-filtered draw keeps all
     * its UVs inside [0,1], WRAP and CLAMP addressing differ ONLY in the bilinear edge
     * bleed — under WRAP the boundary half-texel blends with the texture's OPPOSITE
     * edge. Games that tile the screen with per-tile textures (FMV grids,
     * floor tiles) show this as seam lines at every tile boundary
     * (real DX7 hardware bled identically, but on modern crisp displays it pops).
     * True tiling requires UVs outside [0,1], so swapping to CLAMP cannot break it.
     * Per-axis: an axis is clamped only if its coordinates stay inside [0,1].
     */
    private ensureRenderPass(target: DirectDrawSurfaceState, viewport?: Viewport): void {
        const needsNewPass = !this.currentRenderPass || this.currentRenderTarget !== target;

        if (needsNewPass) {
            // Keep color/depth/pipeline/clear sampleCount in lockstep before opening the pass.
            this.syncMsaaSampleCount();
            this.renderStats.passes++;
            if (this.currentRenderPass) {
                this.currentRenderPass.end();
                this.currentRenderPass = null;
            }
            
            if (!this.currentEncoder) {
                this.currentEncoder = this.device.createCommandEncoder();
            }
            
            const useClear = target.needsColorClear && target.clearColor !== undefined;
            const clearColor = useClear && target.clearColor !== undefined
                ? this.clearPipeline.parseColor(target.clearColor)
                : undefined;
            
            // Always use depthManager for depth stencil attachment
            // Note: Attached Z-buffer surfaces are created with BGRA8Unorm format (not depth format),
            // so we cannot use them directly as depth attachments. Instead, we use the depthManager
            // which creates proper depth24plus-stencil8 textures.
            this.depthManager.ensureDepthForTarget(target);
            const depthStencilAttachment = this.depthManager.createDepthStencilAttachmentForTarget(target);

            // MSAA: render into the per-surface multisample color texture and resolve into the
            // surface's single-sample texture (what the present/Blt path samples). No-op when off.
            this.msaaColorManager.ensureForTarget(target);
            const msaaColorView = this.msaaColorManager.isEnabled()
                ? this.msaaColorManager.getColorViewForTarget(target)
                : null;
            const colorAttachment: GPURenderPassColorAttachment = msaaColorView
                ? {
                    view: msaaColorView,
                    resolveTarget: target.gpuTextureView!,
                    loadOp: useClear ? "clear" : "load",
                    clearValue: clearColor,
                    storeOp: "store",
                }
                : {
                    view: target.gpuTextureView!,
                    loadOp: useClear ? "clear" : "load",
                    clearValue: clearColor,
                    storeOp: "store",
                };

            // Pipelines must be built for THIS attachment's colour format, not the swapchain's.
            // A DirectDraw surface owns its texture and paths that recreate it (presenter
            // RGB565/PALETTE8 conversion) can hand a bgra8unorm-swapchain build an rgba8unorm
            // render target; a mismatch makes WebGPU reject the pass and invalidate the whole
            // command buffer, dropping every draw and every texture upload recorded on it.
            // Ask the texture, not the config.
            const attachmentFormat = target.gpuTexture?.format ?? this.resolveSurfaceTextureFormat(target);
            this.pipelineFactory.setColorTargetFormat(attachmentFormat);

            this.currentRenderPass = this.currentEncoder.beginRenderPass({
                colorAttachments: [colorAttachment],
                depthStencilAttachment,
            });
            if (this.opLogArmed > 0) {
                const vid = (v: unknown): number => {
                    if (!v) return -1;
                    let id = this.opLogViewIds.get(v as object);
                    if (id === undefined) { id = this.opLogViewIdNext++; this.opLogViewIds.set(v as object, id); }
                    return id;
                };
                const vpDesc = viewport && viewport.width && viewport.height
                    ? (() => { const s = sanitizeViewport(viewport, target.width, target.height); return `${s.x},${s.y},${s.width},${s.height},${s.minZ ?? 0},${s.maxZ ?? 1}`; })()
                    : `full(${target.width}x${target.height})`;
                if (this.opLogArmed > 0) this.opLog(`PASS rt=${target.surfacePtr.toString(16)} color=${useClear ? "CLEAR" : "load"} depth=${depthStencilAttachment?.depthLoadOp ?? "none"} cview=#${vid(target.gpuTextureView)} dview=#${vid(depthStencilAttachment?.view)} vp=${vpDesc}`);
            }
            
            if (useClear) {
                Logger.log(LogCategory.DDRAW,
                    `ensureRenderPass: consumed deferred clear for 0x${target.surfacePtr.toString(16)} color=0x${((target.clearColor ?? 0) >>> 0).toString(16)}`);
                target.needsColorClear = false;
                target.clearColor = undefined;
                this.surfacesNeedingClear.delete(target);
            }
            
            this.currentRenderTarget = target;

            // Reset bind group cache when starting a new render pass.
            // WebGPU requires bind groups to be set per render pass, but the optimization
            // cache will skip setBindGroup if parameters haven't changed. Force re-bind.
            this.lastBindGroup = null;
            this.lastUniformOffset = -1; this.lastLightsOffset = -1;

            // Apply viewport from draw call, or use full target size as fallback
            this.appliedPassViewport = null;
            this.applyPassViewport(target, viewport);
        } else {
            // Pass REUSED: the draw's viewport must still win over whatever the pass
            // currently has. D3D viewport is per-draw device state — Max Payne switches
            // to a portal-clipped viewport (e.g. a 75×568 doorway rect) and back
            // mid-frame; inheriting the stale pass viewport renders a fullscreen draw
            // squeezed into the portal rect (missing geometry / vanishing walls).
            this.applyPassViewport(target, viewport);
        }
    }

    /** Viewport+scissor last applied to the current pass (null right after creation). */
    private appliedPassViewport: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number } | null = null;

    /** Apply the draw's viewport+scissor to the open pass, skipping redundant re-application. */
    private applyPassViewport(target: DirectDrawSurfaceState, viewport?: Viewport): void {
        let vpX = 0, vpY = 0, vpW = target.width, vpH = target.height, vpMinZ = 0, vpMaxZ = 1;
        if (viewport && viewport.width && viewport.height) {
            const safeVp = sanitizeViewportInto(this.safeVpScratchPass, viewport, target.width, target.height);
            vpX = safeVp.x; vpY = safeVp.y; vpW = safeVp.width; vpH = safeVp.height;
            vpMinZ = safeVp.minZ ?? 0; vpMaxZ = safeVp.maxZ ?? 1;
        }
        const cur = this.appliedPassViewport;
        if (cur && cur.x === vpX && cur.y === vpY && cur.width === vpW && cur.height === vpH &&
            cur.minZ === vpMinZ && cur.maxZ === vpMaxZ) {
            return;
        }
        this.currentRenderPass!.setViewport(vpX, vpY, vpW, vpH, vpMinZ, vpMaxZ);
        // Scissor rect clamped to render target dimensions (WebGPU requires containment).
        const scissorX = Math.max(0, Math.min(vpX, target.width));
        const scissorY = Math.max(0, Math.min(vpY, target.height));
        const scissorW = Math.max(0, Math.min(vpW, target.width - scissorX));
        const scissorH = Math.max(0, Math.min(vpH, target.height - scissorY));
        this.currentRenderPass!.setScissorRect(scissorX, scissorY, scissorW, scissorH);
        if (cur && this.opLogArmed > 0) this.opLog(`SET-VP(reuse) ${vpX},${vpY},${vpW},${vpH},${vpMinZ},${vpMaxZ}`);
        this.appliedPassViewport = { x: vpX, y: vpY, width: vpW, height: vpH, minZ: vpMinZ, maxZ: vpMaxZ };
    }

    private lastRenderTarget: DirectDrawSurfaceState | null = null;
    private lastPipeline: GPURenderPipeline | null = null;
    private readonly lastStageViews: (GPUTextureView | null)[] =
        new Array<GPUTextureView | null>(MAX_FFP_SAMPLED_STAGES).fill(null);
    private readonly lastStageSamplerKeys = new Int32Array(MAX_FFP_SAMPLED_STAGES * STAGE_SAMPLER_KEY_LANES).fill(-1);
    /** Scratch for the bind fast path's comparison — distinct from the batch-compatibility
     *  scratch above, whose contents stay live until the batch flushes. */
    private readonly stageSamplerKeyScratch = new Int32Array(MAX_FFP_SAMPLED_STAGES * STAGE_SAMPLER_KEY_LANES);

    /** Invalidate the setupPipelineAndBindings fast-path cache. */
    private resetBindFastPath(): void {
        this.lastBindGroup = null;
        this.lastUniformOffset = -1;
        this.lastLightsOffset = -1;
        this.lastPipeline = null;
        this.lastStageViews.fill(null);
        this.lastStageSamplerKeys.fill(-1);
    }

    /**
     * Fill the per-stage batch-compatibility scratch (texture versions + sampler keys)
     * for the current draw. Versions apply only to RenderSurfaces (BitmapTexture is
     * immutable); sampler keys mirror the BindGroupManager cache key format.
     */
    private computeStageBatchKeys(
        pr: PrepareDrawResult,
        texture: DirectDrawSurfaceState | null,
        stageTextures: readonly (DirectDrawSurfaceState | null)[] | null
    ): void {
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            const sampled = (pr.sampledMask & (1 << s)) !== 0;
            const tex = s === 0 ? texture : stageTextures?.[s] ?? null;
            this.stageVersionsScratch[s] = sampled && tex ? surfaceContentVersion(tex) : -1;
            writeStageSamplerKey(this.stageSamplerKeysScratch, s, sampled ? pr.stageSamplers[s] : null);
        }
    }

    /** Compare the accumulated batch's per-stage state against the current draw's. */
    private batchStageStateCompatible(
        batch: NonNullable<DDrawWebGPUExecutor["currentBatch"]>,
        pr: PrepareDrawResult
    ): boolean {
        if (batch.sampledMask !== pr.sampledMask) return false;
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            if (batch.stageVersions[s] !== this.stageVersionsScratch[s]) return false;
            if (batch.stageViews[s] !== pr.stageViews[s]) return false;
            for (let lane = 0; lane < STAGE_SAMPLER_KEY_LANES; lane++) {
                const i = s * STAGE_SAMPLER_KEY_LANES + lane;
                if (batch.stageSamplerKeys[i] !== this.stageSamplerKeysScratch[i]) return false;
            }
        }
        return true;
    }

    // Batching state - MegaBatch enabled: each draw has its own drawIndex into storage buffer
    private currentBatch: {
        target: DirectDrawSurfaceState;
        viewport: Viewport;
        pipeline: GPURenderPipeline;
        bindGroup: GPUBindGroup;
        uniformOffset: number; // For legacy path (first draw's offset)
        lightsOffset: number;  // Per-draw FFP light-set dynamic offset (binding 5)
        // Per-stage state snapshots for accurate batch compatibility checks
        sampledMask: number;
        stageVersions: number[];
        stageViews: (GPUTextureView | null)[];
        stageSamplerKeys: number[];
        vertexBuffer: GPUBuffer;
        firstVertex: number;
        vertexCount: number;
        vertexSize: number;
        primitiveType: number;
        indexFormat?: GPUIndexFormat;
        indexBuffer?: GPUBuffer;
        firstIndex?: number;
        indexCount?: number;
        // MegaBatch: each draw includes its storage buffer index
        draws: Array<{
            firstVertex: number;
            vertexCount: number;
            drawIndex: number;
            vertexBufferOffset?: number;
            vertexBufferSize?: number;
            firstIndex?: number;
            indexCount?: number;
            indexBufferOffset?: number;
            indexBufferSize?: number;
        }>;
        // MegaBatch mode flag and storage buffer reference
        useMegaBatch: boolean;
        storageBuffer: GPUBuffer;
        megaBatchBindGroup?: GPUBindGroup;
        stencilRef: number;
    } | null = null;

    /**
     * Flush accumulated batch to GPU.
     * MegaBatch mode: Each draw uses drawIndex as firstInstance to index storage buffer.
     * Legacy mode: Merges consecutive draws into single GPU draw calls.
     */
    private flushBatch(): void {
        if (!this.currentBatch) return;

        // DIAG: drop batched draws at flush time (batching machinery still runs).
        // Splits "a batched draw paints over X" from "batch state management breaks X".
        // With skipMegaBatchMinIdx > 0 only draws that large are dropped (per-draw, below).
        // Machinery-bisect modes: 9001 = skip all draws but run flushStorageBuffer;
        // 9002 = skip all draws but run ensureRenderPass(batch.target, batch.viewport).
        const diagMode = this.debugFlags.skipMegaBatchDrawsRender ? this.debugFlags.skipMegaBatchMinIdx : 0;
        if (this.debugFlags.skipMegaBatchDrawsRender && (!diagMode || diagMode === 9001 || diagMode === 9002)) {
            if (this.opLogArmed > 0) this.opLog(`FLUSH-BATCH SKIPPED mode=${diagMode} n=${this.currentBatch.draws?.length ?? 0}`);
            if (diagMode === 9001 && this.currentBatch.useMegaBatch) this.ringBufferManager.flushStorageBuffer();
            if (diagMode === 9002) this.ensureRenderPass(this.currentBatch.target, this.currentBatch.viewport);
            this.currentBatch = null;
            this.resetBindFastPath();
            return;
        }
        const skipMinIdx = diagMode;

        const batch = this.currentBatch;
        if (this.opLogArmed > 0) {
            const counts = (batch.draws ?? []).map(d => d.indexCount ?? d.vertexCount).join(",");
            this.opLog(`FLUSH-BATCH mega=${batch.useMegaBatch} n=${batch.draws?.length ?? 0} counts=[${counts}]`);
        }
        this.renderStats.batches++;
        this.renderStats.batchedDraws += batch.draws?.length ?? 0;
        if (batch.useMegaBatch) {
            // MegaBatch shaders read per-draw state from the storage ring buffer via drawIndex.
            // The data is staged on CPU in prepareDraw() and must be uploaded before issuing
            // any draw that references it; flushing later in flush()/endFrame() is too late.
            this.ringBufferManager.flushStorageBuffer();
        }
        this.ensureRenderPass(batch.target, batch.viewport);

        let actualDrawCalls = 0;
        let totalVertexBytes = 0;

        // MegaBatch mode: use storage buffer bind group, each draw has separate drawIndex
        if (batch.useMegaBatch && batch.megaBatchBindGroup) {
            this.currentRenderPass!.setPipeline(batch.pipeline);
            this.currentRenderPass!.setStencilReference(batch.stencilRef);
            // MegaBatch: no dynamic offset - storage buffer bound directly
            this.currentRenderPass!.setBindGroup(0, batch.megaBatchBindGroup);

            if (batch.indexBuffer) {
                // MegaBatch indexed: each draw has unique drawIndex, cannot merge
                for (const draw of batch.draws) {
                    if (!draw.indexCount || draw.indexCount <= 0) continue;
                    if (skipMinIdx && draw.indexCount >= skipMinIdx) { this.opLog(`SKIP-DRAW i=${draw.indexCount}`); continue; }

                    const vertexOffset = draw.vertexBufferOffset ?? ((draw.firstVertex ?? 0) * batch.vertexSize);
                    const vertexSize = draw.vertexBufferSize ?? (draw.vertexCount * batch.vertexSize);
                    const indexOffset = draw.indexBufferOffset ?? 0;
                    const bytesPerIndex = batch.indexFormat === "uint32" ? 4 : 2;
                    const indexSize = draw.indexBufferSize ?? (draw.indexCount * bytesPerIndex);

                    this.currentRenderPass!.setVertexBuffer(0, batch.vertexBuffer, vertexOffset, vertexSize);
                    this.currentRenderPass!.setIndexBuffer(batch.indexBuffer, batch.indexFormat!, indexOffset, indexSize);
                    // firstInstance = drawIndex: shader indexes draws[] via @builtin(instance_index)
                    this.currentRenderPass!.drawIndexed(
                        draw.indexCount,
                        1,
                        0,
                        0,
                        draw.drawIndex ?? 0
                    );
                    actualDrawCalls++;
                    totalVertexBytes += draw.vertexCount * batch.vertexSize;
                }
            } else {
                // MegaBatch non-indexed: each draw has unique drawIndex
                for (const draw of batch.draws) {
                    if (draw.vertexCount <= 0) continue;
                    if (skipMinIdx && draw.vertexCount >= skipMinIdx) { this.opLog(`SKIP-DRAW v=${draw.vertexCount}`); continue; }

                    const vertexOffset = draw.vertexBufferOffset ?? ((draw.firstVertex ?? 0) * batch.vertexSize);
                    const vertexSize = draw.vertexBufferSize ?? (draw.vertexCount * batch.vertexSize);

                    this.currentRenderPass!.setVertexBuffer(0, batch.vertexBuffer, vertexOffset, vertexSize);
                    // firstInstance = drawIndex: shader indexes draws[] via @builtin(instance_index)
                    this.currentRenderPass!.draw(
                        draw.vertexCount,
                        1,
                        0,
                        draw.drawIndex ?? 0
                    );
                    actualDrawCalls++;
                    totalVertexBytes += draw.vertexCount * batch.vertexSize;
                }
            }
        } else {
            // Legacy mode: use uniform buffer with dynamic offset, try to merge draws
            this.currentRenderPass!.setPipeline(batch.pipeline);
            this.currentRenderPass!.setStencilReference(batch.stencilRef);
            this.currentRenderPass!.setBindGroup(0, batch.bindGroup, [batch.uniformOffset, batch.lightsOffset]);
            this.currentRenderPass!.setVertexBuffer(0, batch.vertexBuffer, 0);

            if (batch.indexBuffer) {
                // Indexed draws - try to merge consecutive index ranges
                this.currentRenderPass!.setIndexBuffer(batch.indexBuffer, batch.indexFormat!);

                let i = 0;
                while (i < batch.draws.length) {
                    const startDraw = batch.draws[i];
                    if (!startDraw.indexCount || startDraw.indexCount <= 0) {
                        i++;
                        continue;
                    }

                    // Try to merge consecutive draws with same baseVertex and sequential indices
                    let mergedIndexCount = startDraw.indexCount;
                    let expectedNextIndex = (startDraw.firstIndex ?? 0) + startDraw.indexCount;
                    let j = i + 1;

                    while (j < batch.draws.length) {
                        const nextDraw = batch.draws[j];
                        // Can merge if: same base vertex and indices are consecutive
                        if (nextDraw.firstVertex === startDraw.firstVertex &&
                            nextDraw.firstIndex === expectedNextIndex &&
                            nextDraw.indexCount && nextDraw.indexCount > 0) {
                            mergedIndexCount += nextDraw.indexCount;
                            expectedNextIndex += nextDraw.indexCount;
                            j++;
                        } else {
                            break;
                        }
                    }

                    // Draw merged range
                    this.currentRenderPass!.drawIndexed(
                        mergedIndexCount,
                        1,
                        startDraw.firstIndex ?? 0,
                        startDraw.firstVertex ?? 0
                    );
                    actualDrawCalls++;

                    // Track vertex bytes for merged draws
                    for (let k = i; k < j; k++) {
                        totalVertexBytes += batch.draws[k].vertexCount * batch.vertexSize;
                    }

                    i = j;
                }
            } else {
                // Non-indexed draws - merge consecutive vertex ranges into single draw calls
                let i = 0;
                while (i < batch.draws.length) {
                    const startDraw = batch.draws[i];
                    if (startDraw.vertexCount <= 0) {
                        i++;
                        continue;
                    }

                    // Try to merge consecutive draws
                    let mergedVertexCount = startDraw.vertexCount;
                    let expectedNextVertex = (startDraw.firstVertex ?? 0) + startDraw.vertexCount;
                    let j = i + 1;

                    while (j < batch.draws.length) {
                        const nextDraw = batch.draws[j];
                        // Can merge if vertices are consecutive in buffer
                        if (nextDraw.firstVertex === expectedNextVertex && nextDraw.vertexCount > 0) {
                            mergedVertexCount += nextDraw.vertexCount;
                            expectedNextVertex += nextDraw.vertexCount;
                            j++;
                        } else {
                            break;
                        }
                    }

                    // Draw merged range
                    const vertexOffset = (startDraw.firstVertex ?? 0) * batch.vertexSize;
                    this.currentRenderPass!.setVertexBuffer(0, batch.vertexBuffer, vertexOffset);
                    this.currentRenderPass!.draw(mergedVertexCount);
                    actualDrawCalls++;
                    totalVertexBytes += mergedVertexCount * batch.vertexSize;

                    i = j;
                }
            }
        }

        // Mark render target as GPU-authoritative only after draws are actually
        // issued. Calling this unconditionally at the end of drawPrimitive /
        // drawIndexedPrimitive double-bumps version for immediate draws and
        // bumps it early for batched draws before they flush to the GPU.
        if (actualDrawCalls > 0) {
            setAuthorityGpu(batch.target, true);
        }

        // flushBatch mutates render-pass state directly, bypassing setupPipelineAndBindings().
        // Invalidate the fast-path cache so the next immediate draw rebinds explicitly.
        this.resetBindFastPath();

        // Update counters with ACTUAL GPU draw calls
        const system = System.getInstance();
        const ddraw = system.process?.getModule("ddraw") as any;
        if (ddraw?.incrementFrameCounter) {
            ddraw.incrementFrameCounter("drawCalls", actualDrawCalls);
            ddraw.incrementFrameCounter("vertexBytes", totalVertexBytes);
        }

        // Increment correct profiler counter based on batch type
        if (batch.indexBuffer) {
            profiler.increment("drawIndexedPrimitive", "drawCalls", actualDrawCalls);
        } else {
            profiler.increment("drawPrimitive", "drawCalls", actualDrawCalls);
        }
        this.currentBatch = null;
    }

    private setupPipelineAndBindings(pr: PrepareDrawResult): void {
        const pipeline = pr.pipeline;
        this.currentRenderPass!.setPipeline(pipeline);
        this.currentRenderPass!.setStencilReference(pr.stencilRef);

        // OPTIMIZATION: Skip BindGroupManager lookup if all inputs are identical to last call.
        // This is a massive win for 30k+ draw calls per frame.
        // Sampler keys must match the BindGroupManager cache key format.
        let bindInputsChanged = !this.lastBindGroup || pipeline !== this.lastPipeline;
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            writeStageSamplerKey(
                this.stageSamplerKeyScratch, s,
                (pr.sampledMask & (1 << s)) !== 0 ? pr.stageSamplers[s] : null,
            );
            let sameSampler = true;
            for (let lane = 0; lane < STAGE_SAMPLER_KEY_LANES; lane++) {
                const i = s * STAGE_SAMPLER_KEY_LANES + lane;
                if (this.stageSamplerKeyScratch[i] !== this.lastStageSamplerKeys[i]) { sameSampler = false; break; }
            }
            if (pr.stageViews[s] !== this.lastStageViews[s] || !sameSampler) {
                bindInputsChanged = true;
                this.lastStageViews[s] = pr.stageViews[s];
                for (let lane = 0; lane < STAGE_SAMPLER_KEY_LANES; lane++) {
                    const i = s * STAGE_SAMPLER_KEY_LANES + lane;
                    this.lastStageSamplerKeys[i] = this.stageSamplerKeyScratch[i];
                }
            }
        }

        let bindGroup = this.lastBindGroup;
        if (bindInputsChanged) {
            bindGroup = this.bindGroupManager.getOrCreateBindGroup(
                pipeline,
                this.ringBufferManager.getCurrentUniformBuffer(),
                pr.sampledMask,
                pr.stageViews,
                pr.stageSamplers,
                this.dummyTextureView,
                this.ringBufferManager.getCurrentLightsBuffer(),
                this.clipPlanesBuffer
            );
            this.lastPipeline = pipeline;
        }

        if (bindGroup) {
            // OPTIMIZATION: Skip redundant setBindGroup calls if bindGroup and offsets haven't changed.
            if (bindGroup !== this.lastBindGroup || pr.uniformOffset !== this.lastUniformOffset || pr.lightsOffset !== this.lastLightsOffset) {
                // Two dynamic offsets in binding order: slot uniform (0), then light set (5).
                this.currentRenderPass!.setBindGroup(0, bindGroup, [pr.uniformOffset, pr.lightsOffset]);
                this.lastBindGroup = bindGroup;
                this.lastUniformOffset = pr.uniformOffset;
                this.lastLightsOffset = pr.lightsOffset;

                // Update frame snapshot counter
                const system = System.getInstance();
                const ddraw = system.process?.getModule("ddraw") as any;
                if (ddraw?.incrementFrameCounter) {
                    ddraw.incrementFrameCounter("textureBinds");
                }
            }
        }
    }

    private ensureScratchBuffer(requiredSize: number): Uint8Array {
        if (!this.scratchBuffer || this.scratchBufferSize < requiredSize) {
            this.scratchBufferSize = Math.max(requiredSize, this.scratchBufferSize * 2);
            this.scratchBuffer = new Uint8Array(this.scratchBufferSize);
            this.scratchF32 = new Float32Array(
                this.scratchBuffer.buffer,
                this.scratchBuffer.byteOffset,
                this.scratchBufferSize / 4
            );
            this.scratchDataView = new DataView(
                this.scratchBuffer.buffer,
                this.scratchBuffer.byteOffset,
                this.scratchBufferSize
            );
        }
        return this.scratchBuffer;
    }

}
