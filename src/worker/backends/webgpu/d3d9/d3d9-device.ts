/// <reference types="@webgpu/types" />
import { WebGPUBackend } from "../webgpu-backend";
import { RenderFramePool } from "../render-frame";
import { LruCache } from "../../../core/collections/lru-cache";
import { registerGpuDeviceObserver } from "../../../core/gpu/gpu-device-lifecycle";
// Side-effect import: the surface-side device-loss observer. A pure-d3d9 title never loads the
// ddraw executor, but its render targets and the texture-handle registry are the same objects.
import "../../../modules/ddraw/surface-device-loss";
import { D3D9StateTracker, FFP_TEXTURE_TRANSFORM_COUNT } from "./d3d9-state-tracker";
import { D3D9CommandRecorder } from "./d3d9-command-recorder";
import { DynamicVbPool } from "./dynamic-vb-pool";
import { D3D9BackendExecutor, UniformData } from "./d3d9-backend-executor";
import { VertexBufferStore, IndexBufferStore, TextureStore } from "./d3d9-resources";
import { DxSamplerCache } from "../shared/dx-sampler";
import { TexturePaletteStore } from "../shared/texture-palette-store";
import { decodeD3d9Sampler } from "./d3d9-sampler";
import { buildColorTargetState, computeBlendKey, buildDepthStencilState, computeDepthKey } from "./d3d9-blend";
import { effectiveMipLevels } from "../shared/mip-utils";
import {
    canUploadNativeBC,
    decodeD3DTextureToRgba8,
    getD3DTextureLayout,
    getNativeBCTextureFormat,
    isBlockCompressedFormat,
} from "../shared/texture-formats";
import { TimeService } from "../../../runtime/time";
import { System } from "../../../core/system";
import * as frameCapture from "../../../modules/ddraw/frame-capture";
import { getOverlayCompositePlan } from "../../../modules/user32/dialog-overlay";
import { Logger, LogCategory } from "../../../core/logger";
import {
    d3d9PerfInc, d3d9PerfSkip, d3d9PerfBackendInc, d3d9DropDraw,
    d3d9PerfStateBlockApply, d3d9PerfStateBlockCapture,
    d3d9PerfStateBlockWasmApply, d3d9PerfStateBlockWasmCapture,
    d3d9PerfBufferLock, d3d9PerfBufferUpload, d3d9PerfVertexRangeOOB, d3d9PerfIndexRangeOOB,
    d3d9PerfFfpUnimplemented, d3d9PerfFfpOp, d3d9PerfMaterialSet,
} from "../../../modules/d3d9/d3d9-perf";
import { addComRef, releaseComRef } from "../../../modules/d3d9/com-refs";
import { isValidAddress } from "../../../core/memory/address-guard";
import { Mem } from "../../../core/memory/mem-accessor";
import { sanitizeViewport } from "../ddraw/types";
import { frameProfiler } from "../../../core/frame-profiler";
import { framePacer, decodeD3DPresentInterval, PRESENT_INTERVAL_ONE } from "../../../core/frame-pacer";
import { statsOverlay } from "../../../core/stats-overlay";
import {
    compileVertexShader, compilePixelShader, linkProgram, computeCubeMask,
    CompiledVs, CompiledPs, RawVertexElement, PROG_BIND,
} from "./shader";
import { AlphaTest, alphaTestSnippet } from "./shader/sm-wgsl";
import { Op, opName } from "./shader/sm-enums";
import {
    FFP_UNIFORM_STRUCT_WGSL,
    FFP_SELECT_COLOR_WGSL,
    FFP_TEXGEN_WGSL,
    emitFfpComputeLighting,
    FFP_UNIFORM_FLOATS,
    FFP_MAX_STAGES,
    ffpStageOffset,
    FFP_MAX_LIGHTS,
    packFfpUniforms,
    type FfpColor,
    type FfpLightInput,
    type FfpMaterial,
    type FfpUniformParams,
    D3DLIGHT_POINT,
    D3DLIGHT_DIRECTIONAL,
    D3DMCS_MATERIAL,
    D3DMCS_COLOR1,
    D3DMCS_COLOR2,
} from "./ffp-lighting";
import { FFP_FOG_WGSL, resolveFfpFogMode } from "./ffp-fog";
import { FFP_IMPLEMENTED_OPS, emitFfpCombinerWgsl } from "./ffp-combiner";
import {
    D3D9StateBlockRecorder,
    applyStateBlockEntries,
    captureStateToEntries,
    refreshCapturedEntries,
    classifyStateBlockCoverage,
    releaseStateBlockRefs,
    retainStateBlockRefs,
    type D3D9StateBlockData,
    type StateBlockEntry,
} from "./d3d9-state-block";
import { d3d9WasmArena, isWasmPathEnabled, isArenaVerifyDrainEnabled } from "./d3d9-wasm-arena";
import {
    collectExtraStreamBindings, declStreamsUsed, maxDeclStream, zeroStreamBuffer,
    type StreamVertexBinding,
} from "../shared/vertex-streams";

/** A *UP draw binds only the inline vertex data. */
const UP_STREAM_SLOTS: ReadonlySet<number> = new Set([0]);
/** Size of the stand-in binding for a stream the declaration wants and the guest never bound. */
const ZERO_STREAM_MIN_BYTES = 64 * 1024;

/** D3DFORMATs without an alpha channel — sampling them returns alpha 1.0 on real
 *  D3D9 (R8G8B8, X8R8G8B8, R5G6B5, X1R5G5B5, X4R4G4B4, X8B8G8R8, P8, L8). */
const D3D_ALPHALESS_FORMATS = new Set([20, 22, 23, 24, 30, 33, 41, 50]);

const D3DPT_POINTLIST = 1;
const D3DPT_LINELIST = 2;
const D3DPT_LINESTRIP = 3;
const D3DPT_TRIANGLELIST = 4;
const D3DPT_TRIANGLESTRIP = 5;
const D3DPT_TRIANGLEFAN = 6;
const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DCULL_NONE = 1;
const D3DCULL_CW = 2;
const D3DCULL_CCW = 3;
const D3DFMT_INDEX16 = 101;

// Alpha-test render states + D3DCMPFUNC ALWAYS (the no-op compare).
const D3DRS_ALPHAREF = 24;
const D3DRS_ALPHAFUNC = 25;
const D3DRS_ALPHATESTENABLE = 15;
const D3DCMP_ALWAYS = 8;

// Depth / blend / raster states the harness frame capture reports (d3d9types.h ordinals).
const D3DRS_ZENABLE = 7;
const D3DRS_ZWRITEENABLE = 14;
const D3DRS_ZFUNC = 23;
const D3DRS_SRCBLEND = 19;
const D3DRS_DESTBLEND = 20;
const D3DRS_ALPHABLENDENABLE = 27;
const D3DRS_CULLMODE = 22;
const D3DRS_FOGENABLE = 28;
const D3DRS_FOGCOLOR = 34;
const D3DRS_FOGTABLEMODE = 35;
// FOGSTART/FOGEND/FOGDENSITY are FLOATS bit-cast into the DWORD (the tracker seeds the
// D3D defaults, so a raw 0 is a legitimate 0.0f rather than "never set").
const D3DRS_FOGSTART = 36;
const D3DRS_FOGEND = 37;
const D3DRS_FOGDENSITY = 38;
const D3DRS_FOGVERTEXMODE = 140;

// D3DTSS_TEXTURETRANSFORMFLAGS: low bits are the coordinate count (D3DTTFF_COUNT1..4);
// the D3DTTFF_PROJECTED bit requests a projective divide by the last coordinate component
// in the pixel pipeline (projected spotlights, planar reflections).
const D3DTSS_TEXTURETRANSFORMFLAGS = 24;
const D3DTTFF_PROJECTED = 0x100;
const D3DTSS_COLOROP = 1;
const D3DTSS_ALPHAOP = 4;
// The third operand (D3DTOP_MULTIPLYADD / D3DTOP_LERP) and the stage's destination register.
const D3DTSS_COLORARG0 = 26;
const D3DTSS_ALPHAARG0 = 27;
const D3DTSS_RESULTARG = 28;

/**
 * One texture stage with D3D's defaults already applied (resolveFfpStages). The shader, the
 * gap census and the frame capture all read THIS, never the raw state map: an unset COLOROP
 * is MODULATE, not 0, and a census reading the raw 0 would report the default as a gap.
 */
type FfpResolvedStage = FfpUniformParams["stages"][number];

/**
 * D3DTA_CONSTANT (base 6) selects the stage's own D3DTSS_CONSTANT colour, which the stage
 * uniform does not carry — the combiner reads white for it. We advertise
 * D3DPMISCCAPS_PERSTAGECONSTANT (the caps blob is a real hardware dump), so a guest may
 * legitimately ask for it; count the ask instead of letting the substitution be silent.
 * ARG0 only counts when the op reads it (MULTIPLYADD / LERP), so the number stays a count of
 * arguments that actually reach a pixel.
 */
function censusStageConstantArg(st: FfpResolvedStage): void {
    const isConst = (v: number): boolean => (v & 0xf) === 6;
    const readsArg0 = (op: number): boolean => op === 25 || op === 26;
    if (isConst(st.colorArg1) || isConst(st.colorArg2) || isConst(st.alphaArg1) || isConst(st.alphaArg2)
        || (readsArg0(st.colorOp) && isConst(st.colorArg0))
        || (readsArg0(st.alphaOp) && isConst(st.alphaArg0))) {
        d3d9PerfFfpUnimplemented("stageArgConstant");
    }
}

/**
 * `setWorkerFlag('__ffpUnhandledOpMagenta', true)` makes the stage combiner's fallback paint
 * magenta instead of guessing. The census says WHICH op a frame needs; this says WHICH PIXELS
 * depend on it, which is the half a counter cannot answer — a surface that is absent and one
 * that is merely mis-combined look identical until the guess is made visible. Read at shader
 * emit time, so set it before the title loads.
 */
function unhandledOpMagenta(): boolean {
    return !!(globalThis as unknown as Record<string, unknown>).__ffpUnhandledOpMagenta;
}
// Must agree with the other copies in the tree (ddraw/d3d/sampler-constants.ts,
// modules/d3d8/state.ts) — a wrong value reads a slot nothing writes, so every stage
// silently resolves to UV set 0 with no texgen flag visible.
const D3DTSS_TEXCOORDINDEX = 11;
const D3DTOP_DISABLE = 1;
// Fixed-function skinning. The D3D9 FFP shader implements neither, so a draw that asks for
// them is counted (censusFfpGaps) rather than silently transformed by the wrong matrix.
const D3DRS_VERTEXBLEND = 151;
const D3DRS_INDEXEDVERTEXBLENDENABLE = 167;
// D3DLOCK_DISCARD — the guest is refilling the whole buffer; D3D gives it fresh memory
// rather than overwriting bytes already-issued draws read (see uploadBufferVersion).
const D3DLOCK_DISCARD = 0x00002000;

const D3DFVF_XYZ = 0x0002;
const D3DFVF_XYZRHW = 0x0004;
const D3DFVF_POSITION_MASK = 0x000e;
const D3DFVF_NORMAL = 0x0010;
const D3DFVF_PSIZE = 0x0020;
const D3DFVF_DIFFUSE = 0x0040;
const D3DFVF_SPECULAR = 0x0080;
const D3DFVF_TEX1 = 0x0100;
// Point-sprite render states (float-as-DWORD except the two BOOLs). Canonical d3d9types.h ordinals.
const D3DRS_POINTSIZE = 154;
const D3DRS_POINTSIZE_MIN = 155;
const D3DRS_POINTSPRITEENABLE = 156;
const D3DRS_POINTSCALEENABLE = 157;
const D3DRS_POINTSCALE_A = 158;
const D3DRS_POINTSCALE_B = 159;
const D3DRS_POINTSCALE_C = 160;
const D3DRS_POINTSIZE_MAX = 166;

// FFP lighting render states.
const D3DRS_SPECULARENABLE = 29;
const D3DRS_LIGHTING = 137;
const D3DRS_AMBIENT = 139;
const D3DRS_COLORVERTEX = 141;
const D3DRS_LOCALVIEWER = 142;
const D3DRS_NORMALIZENORMALS = 143;
const D3DRS_DIFFUSEMATERIALSOURCE = 145;
const D3DRS_SPECULARMATERIALSOURCE = 146;
const D3DRS_AMBIENTMATERIALSOURCE = 147;
const D3DRS_EMISSIVEMATERIALSOURCE = 148;
// D3DRS_CLIPPLANEENABLE (152): bitmask, bit N enables user clip plane N (same value D3D8/D3D9).
// FFP user clip planes are evaluated in WORLD space (see emitFfpShader / DXVK emitVsClipping).
const D3DRS_CLIPPLANEENABLE = 152;

const D3DTS_WORLD = 0x100;
const D3DTS_VIEW = 2;
const D3DTS_PROJECTION = 3;
const D3DTS_TEXTURE0 = 16;
const D3DMATERIAL9_SIZE = 68;
const D3DLIGHT9_SIZE = 104;

type ClearState = {
    color: GPUColor;
};

export class D3D9Device {
    // A hardware-3D presenter owns the screen: GDI window-background paints must NOT composite
    // over (and black out) the rendered 3D frame. Matches D3D8/Glide/OpenGL (RenderActive contract).
    readonly suppressGdiOverlay = true;

    private frameCount: number = 0;
    private lastOverlayClearFrame: number = -1;
    private prevPresentTime: number = 0;

    private backend: WebGPUBackend;

    /**
     * Guest RAM, re-derived per use. A view stored across a WASM memory growth is
     * DETACHED, and every later subarray()/set() on it throws — the device outlives
     * any number of growths, so it may never hold one. This is the invariant
     * process.getCurrentMemory() documents for all of its callers.
     */
    private get memory(): Uint8Array {
        return System.getInstance().process!.getCurrentMemory();
    }

    private stateTracker = new D3D9StateTracker();
    private commandRecorder = new D3D9CommandRecorder(new RenderFramePool(2));
    private backendExecutor: D3D9BackendExecutor;

    private vertexBuffers = new VertexBufferStore();
    private indexBuffers = new IndexBufferStore();
    private textures = new TextureStore();
    readonly texturePalettes = new TexturePaletteStore();

    private pipelineCache: LruCache<string, number>;
    private pipelineCacheMaxSize = 128;
    private currentPipelineKey: string | null = null;
    private currentPipelineId: number | null = null;

    private clearState: ClearState = {
        color: { r: 0, g: 0, b: 0, a: 1 },
    };

    private drawCount = 0;
    private lastPresentTime = 0;
    private fps = 0;
    // Frame snapshot tracking for debug panel
    private frameSnapshot: {
        frameId: number;
        drawCalls: number;
        presents: number;
        lastPresent?: {
            timestamp: number;
        };
        lastDraw?: {
            api: "ddraw" | "d3d9";
            primitiveType?: number;
            numVerts?: number;
            numIndices?: number;
            textureHandle?: number;
            timestamp: number;
        };
        frameCounters?: {
            textureBinds: number;
            uploads: number;
            clears: number;
            cacheHits: number;
            cacheMisses: number;
            waitTimeMs: number;
            vertexBytes: number;
            textureBytes: number;
        };
    } = {
        frameId: 0,
        drawCalls: 0,
        presents: 0,
        frameCounters: {
            textureBinds: 0,
            uploads: 0,
            clears: 0,
            cacheHits: 0,
            cacheMisses: 0,
            waitTimeMs: 0,
            vertexBytes: 0,
            textureBytes: 0,
        },
    };
    private frameIdCounter = 0;

    // Per-present diagnostic ring (harness frameLog verb). Each entry summarizes one
    // Present so an agent can correlate visible black frames with clear-only presents
    // (hasClear + zero draws) vs content presents — without ad-hoc logging.
    private frameLogRing: Array<{ p: number; hasClear: boolean; flags: number; cmds: number; draws: number; color: string; rtSets: number; rtNonBack: number }> = [];
    private frameLogSerial = 0;
    private rtSetsThisFrame = 0;
    private rtNonBackThisFrame = 0;
    // Active render target: null = swap-chain backbuffer (offscreen); else a TextureStore index.
    private currentRtIndex: number | null = null;
    // When the active RT is a cube map, the face (0..5) being rendered into; -1 otherwise.
    private currentRtFace: number = -1;
    // Per-face 2D render views into cube RTs, cached by "index:face:level".
    private cubeFaceRenderViews: Map<string, GPUTextureView> = new Map();
    // Depth attachments for RT passes, cached by "WxH" (most RTs share the screen size).
    private rtDepthCache: Map<string, { texture: GPUTexture; view: GPUTextureView }> = new Map();
    // [diag] dedup'd recent SetRenderTarget resolutions + RT texture creations (harness rtDebug verb).
    private rtResolveLog: string[] = [];
    private rtCreateLog: string[] = [];
    /** Record a SetRenderTarget surface→texture resolution (dedup'd) for diagnostics. */
    noteRtResolve(surfacePtr: number, metaHit: boolean, texturePtr: number): void {
        const idx = texturePtr ? this.textures.getIndex(texturePtr) : null;
        const isRT = idx !== null && this.textures.isRenderTarget(idx);
        const line = `surf=0x${surfacePtr.toString(16)} metaHit=${metaHit} tex=0x${texturePtr.toString(16)} idx=${idx} isRT=${isRT}`;
        if (this.rtResolveLog[this.rtResolveLog.length - 1] !== line) {
            this.rtResolveLog.push(line);
            if (this.rtResolveLog.length > 16) this.rtResolveLog.shift();
        }
    }
    /** HARNESS rtDebug verb: what SetRenderTarget saw + which textures were created as RTs. */
    getRtDebug(): { resolves: string[]; creates: string[]; currentRtIndex: number | null } {
        return { resolves: [...this.rtResolveLog], creates: [...this.rtCreateLog], currentRtIndex: this.currentRtIndex };
    }

    /** HARNESS: last `n` per-present summaries (newest last). See frameLog verb. */
    getFrameLog(n: number = 60): Array<{ p: number; hasClear: boolean; flags: number; cmds: number; draws: number; color: string; rtSets: number; rtNonBack: number }> {
        return this.frameLogRing.slice(-Math.max(1, n));
    }

    /** D3D9 SetRenderTarget(index, texturePtr). texturePtr 0 (or a non-RT surface) = render to the
     *  swap-chain backbuffer; an RT texture's pointer = render-to-texture. The module handler resolves
     *  the surface pointer → its parent texture pointer (surfaceMeta) before calling us. Switching the
     *  target eagerly flushes the commands accumulated for the previous target as their own pass. */
    setRenderTarget(_index: number, texturePtr: number, face: number = -1): number {
        this.rtSetsThisFrame++;
        let newTarget: number | null = null;
        let newFace = -1;
        if (texturePtr !== 0) {
            const idx = this.textures.getIndex(texturePtr);
            if (idx !== null && this.textures.isRenderTarget(idx)) {
                newTarget = idx;
                // Only a cube RT honors a face selector; a plain 2D RT renders to layer 0.
                newFace = this.textures.isCubeMap(idx) ? face : -1;
            }
        }
        if (newTarget !== null) this.rtNonBackThisFrame++;
        if (newTarget === this.currentRtIndex && newFace === this.currentRtFace) return 0;
        // Flush everything drawn for the current target/face before switching.
        this.submitFrame(false);
        this.currentRtIndex = newTarget;
        this.currentRtFace = newFace;
        return 0;
    }

    /** A 2D render view into one face (+ mip level) of a cube RT. WebGPU renders into a single
     *  array layer via a 2d view with baseArrayLayer=face; the cube's sampling view stays the
     *  dimension:"cube" view created in createCubeTexture. Cached per (index, face, level). */
    private getCubeFaceRenderView(index: number, face: number, level: number): GPUTextureView | null {
        const tex = this.textures.getGpuTexture(index);
        if (!tex) return null;
        const f = face < 0 ? 0 : face;
        const key = `${index}:${f}:${level}`;
        let view = this.cubeFaceRenderViews.get(key);
        if (!view) {
            view = tex.createView({
                dimension: "2d",
                baseArrayLayer: f,
                arrayLayerCount: 1,
                baseMipLevel: level,
                mipLevelCount: 1,
            });
            this.cubeFaceRenderViews.set(key, view);
        }
        return view;
    }

    /** Depth attachment for an RT pass of the given size (cached; RTs typically share screen size). */
    private getRtDepthView(width: number, height: number): GPUTextureView {
        const key = `${width}x${height}`;
        let entry = this.rtDepthCache.get(key);
        if (!entry) {
            const dev = this.backend.getDevice()!;
            const tex = dev.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format: "depth24plus",
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
            entry = { texture: tex, view: tex.createView() };
            this.rtDepthCache.set(key, entry);
        }
        return entry.view;
    }

    // Temporary lock records for mip levels > 0.
    private mipLevelLocks: Map<string, { guestPtr: number; pitch: number }> = new Map();
    // Persisted mip pixel data (level > 0) for D3DXFilterTexture and LockRect round-trips.
    private mipLevelData: Map<string, Uint8Array> = new Map();

    // ── Cube-texture per-face pixel storage (static / LockRect'd cubes) ──────
    // Active LockRect scratch for a cube face, keyed "cubePtr:face:level".
    private cubeFaceLocks: Map<string, { guestPtr: number; pitch: number }> = new Map();
    // Persisted per-face pixel data, keyed "cubePtr:face:level" (uploaded by ensureCubeTexture).
    private cubeFaceData: Map<string, Uint8Array> = new Map();

    // Reusable buffer for vertex conversion to avoid GC pressure
    private vertexConversionBuffer: Uint8Array | null = null;
    private vertexConversionBufferSize: number = 0;
    /** Widened index scratch for the de-indexing UP path (16- and 32-bit indices share it). */
    private indexScratch: Uint32Array | null = null;
    private dipUpIndexRangeWarned = false;

    /** D3DCAPS9.MaxStreams from the caps blob we report (caps.ts, offset 188). */
    static readonly MAX_STREAMS = 16;
    private streamBindingPtr = new Uint32Array(D3D9Device.MAX_STREAMS);
    private streamBindingOffset = new Uint32Array(D3D9Device.MAX_STREAMS);
    private streamBindingStride = new Uint32Array(D3D9Device.MAX_STREAMS);
    /** Vertex-buffer registry index per stream (null = nothing bound). The guest-visible
     *  ptr/offset/stride above answer GetStreamSource; this is what a draw binds. */
    private streamBindingIndex: (number | null)[] = new Array(D3D9Device.MAX_STREAMS).fill(null);
    /** Reuse pool for DrawPrimitiveUP vertex buffers (lazily created — needs the device). */
    private vbPool: DynamicVbPool | null = null;

    // Reusable buffer for texture ARGB→RGBA conversion to avoid GC pressure
    private textureConversionBuffer: Uint8Array | null = null;

    // ── Vertex / pixel shader state (programmable path) ──────────────────
    private vsShaderRegistry = new Map<number, CompiledVs>();
    private vsNextHandle = 1;
    private activeVertexShader: number = 0;   // 0 = FFP mode
    private vsConstants = new Float32Array(256 * 4);   // c0-c255
    private vsConstantBits = new Uint32Array(this.vsConstants.buffer);
    private vsConstantsVersion = 0;

    private psShaderRegistry = new Map<number, CompiledPs>();
    private psNextHandle = 1;
    private activePixelShader: number = 0;
    private psConstants = new Float32Array(224 * 4);   // c0-c223 (ps_3_0 ceiling)
    private psConstantBits = new Uint32Array(this.psConstants.buffer);
    private psConstantsVersion = 0;

    // Programmable pipeline cache (VS+PS+decl+state → registered pipeline id).
    private progPipelineCache = new Map<string, number>();
    // Real-bypass pipeline cache keyed by the arena's Rust-derived numeric pipelineKey (see
    // resolveProgrammablePipeline's arena fast path) — only populated/queried when
    // dbg.d3dWasmPath(true). Coexists with progPipelineCache; harmless if bypass is toggled
    // mid-session (each cache just handles whichever draws hit it).
    private arenaPipelineCache = new Map<number, number>();
    // Last-resolve fast path: consecutive draws overwhelmingly share one pipeline identity, so a
    // numeric compare against the previous resolve skips the per-draw template-string alloc + the
    // string-Map lookup (the Map remains the second-level cache for non-consecutive repeats).
    private _lrValid = false;
    /** Index of the most recent captured draw-state slot THIS frame
     *  (identical-consecutive-state elision); -1 = none. Reset at submitFrame. */
    private lastCaptureIndex = -1;
    private _lrVs = 0; private _lrPs = 0; private _lrDecl = 0; private _lrStride: number | null = null;
    private _lrStateBits = 0; private _lrTopo = ""; private _lrForceCull = false;
    private _lrBlend = ""; private _lrAlpha = ""; private _lrDepth = ""; private _lrCube = 0; private _lrProj = 0; private _lrPipelineId = -1;

    // Vertex declaration registry — stores raw D3DVERTEXELEMENT9 data
    private vsDeclRegistry = new Map<number, RawVertexElement[]>();
    /** FFP draws issued per vertex declaration — the denominator declCensus() needs to say
     *  whether a declaration we only partly honour is one the game actually draws with. */
    private declDrawCounts = new Map<number, number>();
    private vsDeclNextHandle = 1;
    private activeVertexDecl: number = 0;
    private activeVertexDeclComPtr: number = 0;

    private activeVertexShaderComPtr: number = 0;
    private activePixelShaderComPtr: number = 0;
    private boundIndexPtr: number = 0;

    // Fixed-function state commonly touched by older D3D9 games
    private textureStageStates = new Map<number, number>();
    /** Diagnostic (dbg.d3d9DumpShaders): sticky record of whether the app ever set D3DTTFF_PROJECTED. */
    private projectedSetCount = 0;
    private projectedFlagsSeen = 0;
    private samplerStates = new Map<number, number>();
    private samplerCache?: DxSamplerCache;
    /** Per-stage memo of the resolved GPUSampler (hot: one lookup per stage per draw). Its
     *  complete input set is this stage's D3DSAMP_* block, the live quality override, and the
     *  GPUDevice — invalidated by writeSamplerState (the sole mutator of samplerStates) and by
     *  the token/device compares in resolveStageSampler. */
    private stageSamplers = new Array<GPUSampler | null>(FFP_MAX_STAGES).fill(null);
    private stageSamplersValid = 0;
    private stageSamplerQualityToken = -1;
    private stageSamplerDevice: GPUDevice | null = null;
    private materialData = new Uint8Array(D3DMATERIAL9_SIZE);
    private lights = new Map<number, Uint8Array>();
    private lightEnables = new Map<number, number>();
    private clipPlanes = new Map<number, Float32Array>();

    // ── WASM arena dual-run cross-check ──────
    // Not a real pipeline cache: maps "legacy numeric pipeline id" -> "arena pipelineKey"
    // for THIS frame only, so a later draw sharing the same legacy id can assert the arena
    // returned the same key too (the two hash schemes are never expected to be numerically
    // equal — this checks CONSISTENCY, not identity). Reset alongside d3d9WasmArena.resetFrame().
    private arenaPipelineCrossCheck = new Map<number, number>();
    private arenaMismatchLogCounter = 0;

    private stateBlockRecorder = new D3D9StateBlockRecorder();
    private boundTexturePtrs = new Array<number>(8).fill(0);
    private suppressStateBlockRecording = false;
    private viewport = { x: 0, y: 0, width: 800, height: 600, minZ: 0, maxZ: 1 };

    private replaceHeldComRef(current: number, next: number): number {
        const currentPtr = current >>> 0;
        const nextPtr = next >>> 0;
        if (currentPtr === nextPtr) return currentPtr;
        if (nextPtr !== 0) addComRef(nextPtr);
        if (currentPtr !== 0) releaseComRef(currentPtr);
        return nextPtr;
    }

    releaseComBindings(): void {
        this.activeVertexShaderComPtr = this.replaceHeldComRef(this.activeVertexShaderComPtr, 0);
        this.activePixelShaderComPtr = this.replaceHeldComRef(this.activePixelShaderComPtr, 0);
        this.activeVertexDeclComPtr = this.replaceHeldComRef(this.activeVertexDeclComPtr, 0);
        this.boundIndexPtr = this.replaceHeldComRef(this.boundIndexPtr, 0);
        for (let i = 0; i < this.streamBindingPtr.length; i++) {
            this.streamBindingPtr[i] = this.replaceHeldComRef(this.streamBindingPtr[i]!, 0);
            this.streamBindingIndex[i] = null;
        }
        for (let i = 0; i < this.boundTexturePtrs.length; i++) {
            this.boundTexturePtrs[i] = this.replaceHeldComRef(this.boundTexturePtrs[i]!, 0);
        }
        for (const entry of this.rtDepthCache.values()) {
            entry.texture.destroy();
        }
        this.rtDepthCache.clear();
    }

    constructor(backend: WebGPUBackend) {
        this.backend = backend;

        this.backendExecutor = new D3D9BackendExecutor(backend);
        this.pipelineCache = new LruCache<string, number>({
            maxEntries: this.pipelineCacheMaxSize,
            canEvict: (key) => key !== this.currentPipelineKey,
        });

        // Register as active renderer
        System.getInstance().services.render.setActive(this);

        registerGpuDeviceObserver("d3d9-device", { onDeviceLost: () => this.onDeviceLost() });
    }

    /**
     * Device loss. Everything below is either a dead handle or an INDEX into one — the
     * pipeline caches map a state key to a slot in the executor's `pipelines` array, which
     * the executor is emptying in the same fan-out, so they have to be cleared together or a
     * live key would resolve to a slot that no longer exists.
     *
     * The textures/vertex/index stores keep a CPU shadow of every resource, so dropping their
     * GPU side and re-raising `dirty` restores them on next use with no guest involvement.
     * Render-target textures are the exception and are reported, not restored (see
     * TextureStore.dropGpuResources).
     */
    private onDeviceLost(): void {
        this.backendExecutor.dropDeviceResources();
        this.pipelineCache.clear();
        this.currentPipelineKey = null;
        this.currentPipelineId = null;
        this.progPipelineCache.clear();
        this.arenaPipelineCache.clear();
        this.cubeFaceRenderViews.clear();
        this.rtDepthCache.clear();
        this.vbVersions.clear();
        this.ibVersions.clear();
        this.fetchAuditShadow.clear();
        this.vbPool = null;
        const tex = this.textures.dropGpuResources();
        const vb = this.vertexBuffers.dropGpuResources();
        const ib = this.indexBuffers.dropGpuResources();
        Logger.warn(LogCategory.D3D9,
            `[GPU-LOST] d3d9 resources invalidated — textures=${tex.dropped} (${tex.contentLost} render targets whose contents are gone), ` +
            `vertexBuffers=${vb}, indexBuffers=${ib}; all restore from their CPU shadow on next use`);
    }

    getDrawCount(): number {
        return this.drawCount;
    }

    /**
     * Establish the backbuffer size from present params at CreateDevice time.
     * The D3D9 backbuffer is the single source of truth for resolution: the host
     * canvas, the viewport, and the XYZRHW->NDC divisor (vs_main) must all agree.
     * Without this the device kept its 800x600 default while the canvas/display
     * was sized by a separate path (DDraw / ChangeDisplaySettings), so 2D quads
     * were divided by 800x600 then stretched into a mismatched canvas (squish).
     * BackBufferWidth/Height of 0 means "use focus-window client area" (windowed)
     * in real D3D9 — only override host/viewport when an explicit size was given.
     */
    setBackBufferSize(width: number, height: number, fullscreen = false): void {
        if (width > 0 && height > 0) {
            // Only a fullscreen device's backbuffer IS the display mode; a windowed one is a
            // size inside the desktop and must not be published as SM_CXSCREEN.
            System.getInstance().requestHostResize(width, height, { modeSet: fullscreen });
            this.viewport = { x: 0, y: 0, width, height, minZ: 0, maxZ: 1 };
        }
    }

    setRenderState(state: number, value: number): number {
        d3d9PerfInc("setRenderState");
        // BeginStateBlock recording: journal WITHOUT applying (real D3D9 semantics —
        // the runtime routes recorded Set* calls into the block and leaves device
        // state, including the WASM-arena mirror, untouched).
        if (this.recordingStateBlock) {
            if (state >= 0 && state < 256) this.recordStateBlock({ op: "renderState", state, value });
            // The guest-side setter-shadow trampoline optimistically wrote `value` into
            // its shadow slot before trapping. Since we did NOT apply, resync the slot
            // to the authoritative (unchanged) value — otherwise a post-End set of the
            // same value would be elided guest-side and never reach the device.
            this.syncSetterShadow('IDirect3DDevice9_SetRenderState', state, this.stateTracker.getRenderState(state));
            return 0;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setRenderState(state, value);
        if (!this.stateTracker.setRenderState(state, value)) {
            d3d9PerfSkip("setRenderState");
            return 0;
        }
        // Mirror the change into the guest-side setter shadow so it never drifts behind this
        // (authoritative) tracker. This setter is reached BOTH from the guest SetRenderState
        // trampoline AND from paths that bypass it — notably state-block Apply
        // (applyStateBlockEntries → setRenderState directly). Without this the shadow goes stale
        // and wrong-skips a later guest set that matches the stale value (NFSU translucency bug).
        this.syncSetterShadow('IDirect3DDevice9_SetRenderState', state, value);
        return 0;
    }

    /** Cached dispatcher ref for setter-shadow write-back (stable for the process). */
    private shadowSyncDispatcher: { writeShadowSlot?: (d: string, f: string, s: number, v: number) => void } | null = null;
    /** Keep a guest-side setter shadow slot in lock-step with this tracker on every real change,
     *  regardless of which path drove the change. No-op when the shadow isn't registered. */
    private syncSetterShadow(funcName: string, slot: number, value: number): void {
        let d = this.shadowSyncDispatcher;
        if (!d) {
            d = (System.getInstance().process?.dispatcher as typeof this.shadowSyncDispatcher) ?? null;
            this.shadowSyncDispatcher = d;
        }
        d?.writeShadowSlot?.('d3d9', funcName, slot, value);
    }

    getRenderState(state: number): number {
        return this.stateTracker.getRenderState(state);
    }

    setFVF(fvf: number): number {
        d3d9PerfInc("setFVF");
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "fvf", value: fvf });
            return 0;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setFvf(fvf);
        if (!this.stateTracker.setFVF(fvf)) {
            d3d9PerfSkip("setFVF");
            return 0;
        }
        return 0;
    }

    getFVF(): number {
        return this.stateTracker.getFVF();
    }

    // ── Vertex shader API ────────────────────────────────────────────────

    private readShaderTokens(bytecodePtr: number, mem: Uint8Array): Uint32Array {
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const maxTokens = 8192; // safety limit
        const tokens = new Uint32Array(maxTokens);
        let count = 0;
        for (let i = 0; i < maxTokens; i++) {
            const token = dv.getUint32(bytecodePtr + i * 4, true);
            tokens[count++] = token;
            if ((token & 0xFFFF) === 0xFFFF) break; // END token
        }
        return tokens.subarray(0, count);
    }

    createVertexShader(bytecodePtr: number, mem: Uint8Array): { hr: number; handle: number; bytecode: Uint32Array } {
        try {
            const bytecode = this.readShaderTokens(bytecodePtr, mem);
            const compiled = compileVertexShader(bytecode);
            const handle = this.vsNextHandle++;
            this.vsShaderRegistry.set(handle, compiled);
            const a = compiled.analysis;
            if (d3d9WasmArena.isInitialized()) {
                // constantCount is a vec4-register count; the arena bank is float-indexed.
                d3d9WasmArena.setShaderConstLen(true, handle, Math.min(a.constantCount, 256) * 4);
            }
            Logger.log(LogCategory.D3D9,
                `[D3D9] CreateVertexShader vs_${compiled.prog.major}_${compiled.prog.minor} → handle=${handle} ` +
                `consts=${a.constantCount} inputs=${a.inputDcls.length} instrs=${compiled.prog.instructions.length}`);
            return { hr: 0, handle, bytecode };
        } catch (e) {
            Logger.error(LogCategory.D3D9, `[D3D9] CreateVertexShader failed: ${e}`);
            return { hr: 0x8876086c, handle: 0, bytecode: new Uint32Array(0) }; // D3DERR_INVALIDCALL
        }
    }

    createPixelShader(bytecodePtr: number, mem: Uint8Array): { hr: number; handle: number; bytecode: Uint32Array } {
        try {
            const bytecode = this.readShaderTokens(bytecodePtr, mem);
            const compiled = compilePixelShader(bytecode);
            const handle = this.psNextHandle++;
            this.psShaderRegistry.set(handle, compiled);
            const a = compiled.analysis;
            if (d3d9WasmArena.isInitialized()) {
                // constantCount is a vec4-register count; the arena bank is float-indexed.
                d3d9WasmArena.setShaderConstLen(false, handle, Math.min(a.constantCount, 224) * 4);
            }
            Logger.log(LogCategory.D3D9,
                `[D3D9] CreatePixelShader ps_${compiled.prog.major}_${compiled.prog.minor} → handle=${handle} ` +
                `consts=${a.constantCount} samplers=${[...a.samplers].join(",")} instrs=${compiled.prog.instructions.length}`);
            return { hr: 0, handle, bytecode };
        } catch (e) {
            Logger.error(LogCategory.D3D9, `[D3D9] CreatePixelShader failed: ${e}`);
            return { hr: 0x8876086c, handle: 0, bytecode: new Uint32Array(0) }; // D3DERR_INVALIDCALL
        }
    }

    setVertexShader(handle: number, comPtr: number = 0): number {
        d3d9PerfInc("setVertexShader");
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "vertexShader", handle: comPtr });
            return 0;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setVertexShader(handle);
        if (this.activeVertexShader === handle && this.activeVertexShaderComPtr === comPtr) {
            d3d9PerfSkip("setVertexShader");
            return 0;
        }
        this.activeVertexShader = handle;
        this.activeVertexShaderComPtr = this.replaceHeldComRef(this.activeVertexShaderComPtr, comPtr);
        this.currentPipelineKey = null; // invalidate pipeline cache
        this.currentPipelineId = null;
        Logger.verbose(LogCategory.D3D9, `[D3D9] SetVertexShader(${handle})`);
        return 0;
    }

    getVertexShader(): number {
        return this.activeVertexShader;
    }

    getVertexShaderComPtr(): number {
        return this.activeVertexShaderComPtr;
    }

    setPixelShader(handle: number, comPtr: number = 0): number {
        d3d9PerfInc("setPixelShader");
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "pixelShader", handle: comPtr });
            return 0;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setPixelShader(handle);
        if (this.activePixelShader === handle && this.activePixelShaderComPtr === comPtr) {
            d3d9PerfSkip("setPixelShader");
            return 0;
        }
        this.activePixelShader = handle;
        this.activePixelShaderComPtr = this.replaceHeldComRef(this.activePixelShaderComPtr, comPtr);
        this.currentPipelineKey = null;
        this.currentPipelineId = null;
        Logger.verbose(LogCategory.D3D9, `[D3D9] SetPixelShader(${handle})`);
        return 0;
    }

    getPixelShader(): number {
        return this.activePixelShader;
    }

    getPixelShaderComPtr(): number {
        return this.activePixelShaderComPtr;
    }

    private copyShaderConstantsFromGuest(
        targetBits: Uint32Array,
        startRegister: number,
        pConstantData: number,
        vector4fCount: number,
        mem: Uint8Array,
    ): boolean {
        const baseIdx = startRegister * 4;
        if (vector4fCount <= 0 || baseIdx >= targetBits.length) return false;

        const count = Math.min(vector4fCount * 4, targetBits.length - baseIdx);
        const mem32 = new Uint32Array(mem.buffer, mem.byteOffset, mem.byteLength >> 2);
        const srcIdx = pConstantData >> 2;
        return this.copyShaderConstantBitsFromMem32(targetBits, baseIdx, mem32, srcIdx, count);
    }

    /** Apply shader constants captured in the WBUF ring (float bits already inlined). */
    private copyShaderConstantsFromWbufRing(
        targetBits: Uint32Array,
        onChanged: () => void,
        skipKey: "vsConstantUnchanged" | "psConstantUnchanged",
        apiKey: "setVertexShaderConstantF" | "setPixelShaderConstantF",
        stateOp: "vertexShaderConstantF" | "pixelShaderConstantF",
        mem32: Uint32Array,
        dataPtr: number,
        arenaWrite?: (startFloat: number, data: Float32Array) => void,
    ): void {
        d3d9PerfInc(apiKey);
        const w = dataPtr >> 2;
        const startRegister = mem32[w + 1]!;
        const vector4fCount = mem32[w + 2]!;
        const baseIdx = startRegister * 4;
        const count = Math.min(vector4fCount * 4, targetBits.length - baseIdx);
        if (count <= 0) return;

        const srcIdx = w + 3;
        if (this.recordingStateBlock) {
            // Journal the INCOMING ring data without touching the constant bank.
            const data = new Float32Array(count);
            new Uint32Array(data.buffer).set(mem32.subarray(srcIdx, srcIdx + count));
            this.recordStateBlock({ op: stateOp, start: startRegister, data });
            return;
        }
        if (this.copyShaderConstantBitsFromMem32(targetBits, baseIdx, mem32, srcIdx, count)) {
            onChanged();
        } else {
            d3d9PerfSkip(skipKey);
        }
        if (arenaWrite) {
            // targetBits shares its buffer (byteOffset 0) with the owning Float32Array
            // (vsConstants/psConstants), so this slices the exact bits just written above.
            arenaWrite(baseIdx, new Float32Array(targetBits.buffer, baseIdx * 4, count));
        }
    }

    private copyShaderConstantBitsFromMem32(
        targetBits: Uint32Array,
        baseIdx: number,
        srcMem32: Uint32Array,
        srcIdx: number,
        count: number,
    ): boolean {
        let changed = false;
        for (let i = 0; i < count; i++) {
            const bits = srcMem32[srcIdx + i]!;
            const dst = baseIdx + i;
            if (targetBits[dst] !== bits) {
                targetBits[dst] = bits;
                changed = true;
            }
        }
        return changed;
    }

    private copyConstantPrefixWithKey(srcBits: Uint32Array, dstBits: Uint32Array, floatLen: number): number {
        let h1 = 0x811c9dc5;
        let h2 = (0x9e3779b9 ^ floatLen) >>> 0;
        for (let i = 0; i < floatLen; i++) {
            const bits = srcBits[i]!;
            dstBits[i] = bits;
            h1 = Math.imul(h1 ^ bits, 0x01000193) >>> 0;
            h2 = (Math.imul(h2 ^ bits, 0x85ebca6b) + 0x9e3779b9) >>> 0;
        }
        return ((h1 & 0x1fffff) * 0x100000000) + h2;
    }

    private copyShaderConstantsFromArray(target: Float32Array, startRegister: number, data: Float32Array): boolean {
        const baseIdx = startRegister * 4;
        if (data.length <= 0 || baseIdx >= target.length) return false;

        const count = Math.min(data.length, target.length - baseIdx);
        const targetBits = new Uint32Array(target.buffer, target.byteOffset, target.length);
        const dataBits = new Uint32Array(data.buffer, data.byteOffset, data.length);
        let changed = false;
        for (let i = 0; i < count; i++) {
            const dst = baseIdx + i;
            const bits = dataBits[i]!;
            if (targetBits[dst] !== bits) {
                targetBits[dst] = bits;
                changed = true;
            }
        }
        return changed;
    }

    setVertexShaderConstantF(startRegister: number, pConstantData: number, vector4fCount: number, mem: Uint8Array): number {
        d3d9PerfInc("setVertexShaderConstantF");
        const baseIdx = startRegister * 4;
        const max = this.vsConstants.length;
        const n = vector4fCount * 4;
        if (this.recordingStateBlock) {
            const data = this.readGuestConstantsForRecording(pConstantData, Math.min(n, max - baseIdx), mem);
            if (data) this.recordStateBlock({ op: "vertexShaderConstantF", start: startRegister, data });
            return 0;
        }
        if (!this.copyShaderConstantsFromGuest(this.vsConstantBits, startRegister, pConstantData, vector4fCount, mem)) {
            d3d9PerfSkip("vsConstantUnchanged");
        } else {
            this.vsConstantsVersion++;
        }
        if (d3d9WasmArena.isInitialized()) {
            // Mirror from the just-updated authoritative bank (not the raw guest pointer —
            // avoids re-deriving alignment/byte-order and guarantees identical bits).
            const count = Math.min(n, max - baseIdx);
            if (count > 0) d3d9WasmArena.setVertexShaderConstantF(baseIdx, this.vsConstants.subarray(baseIdx, baseIdx + count));
        }
        return 0;
    }

    /** Journal helper: read `floatCount` floats of incoming constant data from guest memory. */
    private readGuestConstantsForRecording(pConstantData: number, floatCount: number, mem: Uint8Array): Float32Array | null {
        if (floatCount <= 0 || pConstantData < 0 || pConstantData + floatCount * 4 > mem.byteLength) return null;
        const mem32 = new Uint32Array(mem.buffer, mem.byteOffset, mem.byteLength >> 2);
        const data = new Float32Array(floatCount);
        new Uint32Array(data.buffer).set(mem32.subarray(pConstantData >> 2, (pConstantData >> 2) + floatCount));
        return data;
    }

    setPixelShaderConstantF(startRegister: number, pConstantData: number, vector4fCount: number, mem: Uint8Array): number {
        d3d9PerfInc("setPixelShaderConstantF");
        const baseIdx = startRegister * 4;
        const max = this.psConstants.length;
        const n = vector4fCount * 4;
        if (this.recordingStateBlock) {
            const data = this.readGuestConstantsForRecording(pConstantData, Math.min(n, max - baseIdx), mem);
            if (data) this.recordStateBlock({ op: "pixelShaderConstantF", start: startRegister, data });
            return 0;
        }
        if (!this.copyShaderConstantsFromGuest(this.psConstantBits, startRegister, pConstantData, vector4fCount, mem)) {
            d3d9PerfSkip("psConstantUnchanged");
        } else {
            this.psConstantsVersion++;
        }
        if (d3d9WasmArena.isInitialized()) {
            const count = Math.min(n, max - baseIdx);
            if (count > 0) d3d9WasmArena.setPixelShaderConstantF(baseIdx, this.psConstants.subarray(baseIdx, baseIdx + count));
        }
        return 0;
    }

    setVertexShaderConstantFFromArray(startRegister: number, data: Float32Array, _mem: Uint8Array): number {
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "vertexShaderConstantF", start: startRegister, data: new Float32Array(data) });
            return 0;
        }
        if (this.copyShaderConstantsFromArray(this.vsConstants, startRegister, data)) {
            this.vsConstantsVersion++;
        }
        if (d3d9WasmArena.isInitialized()) {
            const baseIdx = startRegister * 4;
            const count = Math.min(data.length, this.vsConstants.length - baseIdx);
            if (count > 0) d3d9WasmArena.setVertexShaderConstantF(baseIdx, data.subarray(0, count));
        }
        return 0;
    }

    setVertexShaderConstantFFromWbufRing(mem32: Uint32Array, dataPtr: number): void {
        this.copyShaderConstantsFromWbufRing(
            this.vsConstantBits,
            () => { this.vsConstantsVersion++; },
            "vsConstantUnchanged",
            "setVertexShaderConstantF",
            "vertexShaderConstantF",
            mem32,
            dataPtr,
            d3d9WasmArena.isInitialized() ? (sf, data) => d3d9WasmArena.setVertexShaderConstantF(sf, data) : undefined,
        );
    }

    setPixelShaderConstantFFromWbufRing(mem32: Uint32Array, dataPtr: number): void {
        this.copyShaderConstantsFromWbufRing(
            this.psConstantBits,
            () => { this.psConstantsVersion++; },
            "psConstantUnchanged",
            "setPixelShaderConstantF",
            "pixelShaderConstantF",
            mem32,
            dataPtr,
            d3d9WasmArena.isInitialized() ? (sf, data) => d3d9WasmArena.setPixelShaderConstantF(sf, data) : undefined,
        );
    }

    setPixelShaderConstantFFromArray(startRegister: number, data: Float32Array, _mem: Uint8Array): number {
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "pixelShaderConstantF", start: startRegister, data: new Float32Array(data) });
            return 0;
        }
        if (this.copyShaderConstantsFromArray(this.psConstants, startRegister, data)) {
            this.psConstantsVersion++;
        }
        if (d3d9WasmArena.isInitialized()) {
            const baseIdx = startRegister * 4;
            const count = Math.min(data.length, this.psConstants.length - baseIdx);
            if (count > 0) d3d9WasmArena.setPixelShaderConstantF(baseIdx, data.subarray(0, count));
        }
        return 0;
    }

    createVertexDeclaration(elements: RawVertexElement[]): { hr: number; handle: number } {
        const handle = this.vsDeclNextHandle++;
        this.vsDeclRegistry.set(handle, elements);
        return { hr: 0, handle };
    }

    setVertexDeclaration(internalHandle: number, comPtr: number = 0): number {
        d3d9PerfInc("setVertexDeclaration");
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "vertexDeclaration", handle: comPtr });
            return 0;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setVertexDeclaration(internalHandle);
        if (this.activeVertexDecl === internalHandle && this.activeVertexDeclComPtr === comPtr) {
            d3d9PerfSkip("setVertexDeclaration");
            return 0;
        }
        if (this.activeVertexDecl !== internalHandle) {
            this.activeVertexDecl = internalHandle;
            this.currentPipelineKey = null;
            this.currentPipelineId = null;
        }
        this.activeVertexDeclComPtr = this.replaceHeldComRef(this.activeVertexDeclComPtr, comPtr);
        return 0;
    }

    getVertexDeclaration(): number {
        return this.activeVertexDecl;
    }

    /**
     * Per-vertex-declaration census: what the game declared, what the FFP paths actually
     * consume, and how many draws rode each declaration. The FFP shader/layout is built from
     * stream 0 alone (buildShaderFromDecl) and one vertex buffer is bound per draw, so a
     * semantic declared on stream 1+ is silently DROPPED — the geometry still rasterizes,
     * just untextured/uncoloured. That failure renders as plausible flat-white output with no
     * error anywhere, which is exactly why it needs an instrument that names it rather than a
     * screenshot someone has to interpret. `drops` is empty for a declaration we honour whole.
     */
    declCensus(): unknown {
        const decls: { handle: number; draws: number; drops: unknown[]; [k: string]: unknown }[] = [];
        for (const [handle, elements] of this.vsDeclRegistry) {
            const streams = declStreamsUsed(elements);
            // What the FFP vertex path will NOT turn into an attribute. Every stream is bound
            // now, so a stream number is no longer a drop by itself — only a semantic the
            // shader builder has no input for is. Keep this in step with buildShaderFromDecl:
            // an instrument that reports the fix it was written to catch is worse than none.
            const describe = (e: RawVertexElement) => ({
                stream: e.stream, offset: e.offset, type: e.type,
                usage: e.usage, usageName: declUsageName(e.usage), usageIndex: e.usageIndex,
            });
            const indexed = (e: RawVertexElement) =>
                e.usage === DECLUSAGE_TEXCOORD_FFP || e.usage === DECLUSAGE_COLOR_FFP;
            const drops = elements
                .filter(e => FFP_CONSUMED_USAGES.has(e.usage) && e.usageIndex > (indexed(e) ? 1 : 0))
                .map(describe);
            // Set 1 reaches the shader only on a multi-stage draw, which is a per-draw
            // property this per-declaration view cannot see. Reported separately rather than
            // folded into `drops`, so a zero there is not read as "nothing is lost".
            const conditional = elements
                .filter(e => indexed(e) && e.usageIndex === 1)
                .map(describe);
            // Streams the declaration reads that nothing is bound to — they draw against a
            // zero-filled stand-in (collectFfpExtraStreams), which reads as black/untextured.
            const unbound = streams.filter(s => s !== 0 && this.streamBindingIndex[s] === null);
            decls.push({
                handle,
                draws: this.declDrawCounts.get(handle) ?? 0,
                streams,
                multiStream: streams.length > 1,
                elements: elements.map(describe),
                unbound,
                drops,
                conditional,
            });
        }
        decls.sort((a, b) => b.draws - a.draws);
        const bindings: unknown[] = [];
        for (let s = 0; s < D3D9Device.MAX_STREAMS; s++) {
            const b = this.getStreamBinding(s);
            if (b && b.ptr !== 0) bindings.push({ stream: s, ...b });
        }
        const drawsTotal = [...this.declDrawCounts.values()].reduce((a, b) => a + b, 0);
        const drawsDropping = decls
            .filter(d => d.drops.length > 0)
            .reduce((a, d) => a + d.draws, 0);
        return {
            activeDecl: this.activeVertexDecl,
            drawsTotal,
            drawsDropping,
            boundStreams: bindings,
            fvfDraws: this.declDrawCounts.get(0) ?? 0,
            decls,
        };
    }

    resetDeclCensus(): void { this.declDrawCounts.clear(); }

    getVertexDeclarationComPtr(): number {
        return this.activeVertexDeclComPtr;
    }

    /** Get active compiled VS (null if FFP). */
    getActiveVsShader(): CompiledVs | null {
        if (this.activeVertexShader === 0) return null;
        return this.vsShaderRegistry.get(this.activeVertexShader) ?? null;
    }

    /** Get active compiled PS (null if none). */
    getActivePsShader(): CompiledPs | null {
        if (this.activePixelShader === 0) return null;
        return this.psShaderRegistry.get(this.activePixelShader) ?? null;
    }

    /** Diagnostic: enumerate created vertex/pixel shaders with a compact disassembly.
     *  Surfaces the texld projected/bias control bits per pixel shader so we can tell at a
     *  glance whether a title uses texldp (projected spotlight/reflection). Consumed by
     *  dbg.d3d9DumpShaders(); kept here so the registries stay private. */
    dumpShaders(): {
        vs: Array<{ handle: number; version: string; instrs: number; active: boolean }>;
        ps: Array<{
            handle: number; version: string; instrs: number; samplers: number[];
            projectedTex: number; biasedTex: number; active: boolean; disasm: string[];
        }>;
        projectedStageKey: number;
        projectedStages: number[];
        projectedSetCount: number;
        projectedFlagsSeen: number;
    } {
        const vs = [...this.vsShaderRegistry.entries()].map(([handle, c]) => ({
            handle,
            version: `vs_${c.prog.major}_${c.prog.minor}`,
            instrs: c.prog.instructions.length,
            active: handle === this.activeVertexShader,
        }));
        const ps = [...this.psShaderRegistry.entries()].map(([handle, c]) => {
            let projectedTex = 0, biasedTex = 0;
            const disasm: string[] = [];
            for (const ins of c.prog.instructions) {
                let line = opName(ins.opcode);
                if (ins.opcode === Op.TEX && c.prog.major >= 2) {
                    if (ins.specificData & 1) { line += "p"; projectedTex++; }
                    if (ins.specificData & 2) { line += "b"; biasedTex++; }
                }
                disasm.push(line);
            }
            return {
                handle,
                version: `ps_${c.prog.major}_${c.prog.minor}`,
                instrs: c.prog.instructions.length,
                samplers: [...c.analysis.samplers],
                projectedTex,
                biasedTex,
                active: handle === this.activePixelShader,
                disasm,
            };
        });
        // Current D3DTTFF_PROJECTED stage state (what a ps_1_x / FFP draw would project by right now).
        const projectedStageKey = this.projectedStageKey();
        const projectedStages: number[] = [];
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            if ((projectedStageKey >> stage) & 1) projectedStages.push(stage);
        }
        return {
            vs, ps, projectedStageKey, projectedStages,
            projectedSetCount: this.projectedSetCount, projectedFlagsSeen: this.projectedFlagsSeen,
        };
    }

    /** True when a programmable vertex shader is bound (the new render path). */
    private isProgrammable(): boolean {
        return this.activeVertexShader !== 0 && this.vsShaderRegistry.has(this.activeVertexShader);
    }

    setStreamSource(streamNumber: number, vbPtr: number, offset: number, stride: number): number {
        d3d9PerfInc("setStreamSource");
        if (streamNumber < 0 || streamNumber >= D3D9Device.MAX_STREAMS) return D3DERR_INVALIDCALL;
        const index = vbPtr === 0 ? null : this.vertexBuffers.getIndex(vbPtr);
        // Unknown pointer: clear the stream with the error (see setTexture) — a stale
        // vertex buffer would otherwise feed the next draw.
        const unknown = vbPtr !== 0 && index === null;
        // Record the guest-visible binding for every stream — GetStreamSource must report
        // back exactly what was set even for streams the draw path below ignores.
        this.streamBindingPtr[streamNumber] = this.replaceHeldComRef(this.streamBindingPtr[streamNumber]!, unknown ? 0 : vbPtr);
        this.streamBindingOffset[streamNumber] = unknown ? 0 : offset >>> 0;
        this.streamBindingStride[streamNumber] = unknown ? 0 : stride >>> 0;
        this.streamBindingIndex[streamNumber] = unknown ? null : index;
        // Streams beyond 0 feed the draw through collectFfpExtraStreams; their strides shape
        // the per-stream vertex layout, so a change there invalidates the cached pipeline.
        if (streamNumber !== 0) {
            this.currentPipelineKey = null;
            this.currentPipelineId = null;
            return unknown ? D3DERR_INVALIDCALL : D3D_OK;
        }

        if (index === null) {
            if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setStreamSource(0, 0, 0);
            if (!this.stateTracker.clearStreamSource()) d3d9PerfSkip("setStreamSource");
            return unknown ? D3DERR_INVALIDCALL : D3D_OK;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setStreamSource(index, offset, stride);
        if (!this.stateTracker.setStreamSource(index, offset, stride)) d3d9PerfSkip("setStreamSource");
        return D3D_OK;
    }

    /** Vertex buffer COM ptr / offset / stride last bound to a stream (all zero = unbound).
     *  null for a stream index beyond the MaxStreams we advertise. */
    getStreamBinding(streamNumber: number): { ptr: number; offset: number; stride: number } | null {
        if (streamNumber >= D3D9Device.MAX_STREAMS) return null;
        return {
            ptr: this.streamBindingPtr[streamNumber]!,
            offset: this.streamBindingOffset[streamNumber]!,
            stride: this.streamBindingStride[streamNumber]!,
        };
    }

    /** Tail-guard canary written past every VB/IB guest allocation and
     *  verified on each Unlock. Catches a guest (or lock-path) overrun scribbling past the
     *  buffer into neighboring HEAP objects — the corruption signature of the in-race
     *  wild-EIP crash (indirect call through a float-clobbered pointer). 16 bytes/buffer,
     *  4-word compare per Unlock — cheap enough to keep always-on. */
    private static readonly BUF_CANARY = 0xbeefcafe;
    private static readonly BUF_CANARY_BYTES = 16;

    private writeCanary(_memory: Uint8Array | null, guestPtr: number, size: number): void {
        for (let i = 0; i < D3D9Device.BUF_CANARY_BYTES; i += 4) {
            Mem.writeUint32(guestPtr + size + i, D3D9Device.BUF_CANARY);
        }
    }

    private checkCanary(memory: Uint8Array, guestPtr: number, size: number, kind: string, handle: number): void {
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        for (let i = 0; i < D3D9Device.BUF_CANARY_BYTES; i += 4) {
            const got = view.getUint32(guestPtr + size + i, true);
            if (got !== D3D9Device.BUF_CANARY) {
                Logger.error(
                    LogCategory.D3D9,
                    `[BUF-CANARY] ${kind} 0x${handle.toString(16)} OVERRUN: guest wrote past ` +
                    `[0x${guestPtr.toString(16)}..0x${(guestPtr + size).toString(16)}) — ` +
                    `canary+${i}=0x${got.toString(16)} (expected 0x${D3D9Device.BUF_CANARY.toString(16)}). ` +
                    `Neighboring HEAP objects are corrupt — this is the wild-EIP crash mechanism.`,
                );
                // Re-arm so we report once per offending unlock, not once ever.
                this.writeCanary(memory, guestPtr, size);
                return;
            }
        }
    }

    createVertexBuffer(vbPtr: number, size: number, fvf: number): number {
        const process = System.getInstance().process;
        if (!process) return 0;
        try {
            // +16: tail canary (see BUF_CANARY) — kept outside the size the store/game sees.
            const guestPtr = process.memory.alloc(size + D3D9Device.BUF_CANARY_BYTES, "HEAP");
            const index = this.vertexBuffers.create(vbPtr, size, fvf, guestPtr);
            this.dropBufferVersions(index, "vb");
            this.writeCanary(null, guestPtr, size);
            return guestPtr;
        } catch (e) {
            Logger.error(LogCategory.D3D9, `createVertexBuffer: HEAP alloc failed size=${size}: ${e}`);
            return 0;
        }
    }

    // ── D3DLOCK_DISCARD buffer renaming ────────────────────────────────────────────────
    // The frame's queued buffer uploads all run BEFORE its render pass, so one GPU buffer can
    // only ever hold ONE version of its bytes per frame: whatever the last upload wrote. That
    // is fine for D3DLOCK_NOOVERWRITE (the guest promises it only wrote bytes no earlier draw
    // reads), but D3DLOCK_DISCARD means the opposite — the guest is refilling the same offsets
    // with unrelated data and D3D hands it fresh memory ("renaming"), leaving the draws already
    // issued reading the old contents. Engines that stream geometry through one dynamic VB
    // (RenderWare's vehicles/peds/Im3D) refill it many times per frame, so without renaming
    // every draw but the last reads another object's vertices.
    //
    // So do what D3D does: on the first upload after a DISCARD lock in a frame that already
    // uploaded this buffer, swap in a different GPU buffer. Versions are kept in a per-index
    // ring that grows to the frame's high-water mark and is then reused forever, so the steady
    // state allocates nothing.
    private discardedVb = new Set<number>();
    private discardedIb = new Set<number>();
    private vbVersions = new Map<number, GPUBuffer[]>();
    private ibVersions = new Map<number, GPUBuffer[]>();
    /** Ring slot this buffer is on for the CURRENT frame; advanced only by a DISCARD that
     *  follows an upload, so a NOOVERWRITE refill keeps the buffer earlier draws already bound. */
    private vbSlotThisFrame = new Map<number, number>();
    private ibSlotThisFrame = new Map<number, number>();
    private vbUploadedThisFrame = new Set<number>();
    private ibUploadedThisFrame = new Set<number>();
    private vbUploadCountThisFrame = new Map<number, number>();
    private ibUploadCountThisFrame = new Map<number, number>();
    /** Flags of the most recent Lock per buffer — diagnostic only (see D3D9BufferPerf). */
    private vbLastLockFlags = new Map<number, number>();
    private ibLastLockFlags = new Map<number, number>();
    private vertexRangeOobLogs = 0;
    private bufferFrameSerial = -1;

    /**
     * Reset the per-frame version bookkeeping when the producer frame boundary moves. Every
     * buffer restarts at ring slot 0, which is safe for GPU ordering because the previous
     * frame's draws have been submitted — but the buffer's current bytes live in the slot that
     * frame ENDED on, and an upload only happens while `store.isDirty`. So rewinding the slot
     * must also re-dirty the buffer, or slot 0 binds a stale version (or zeros, if it was never
     * written) and WebGPU reports nothing.
     */
    private syncBufferFrame(): void {
        const serial = frameCapture.getFrameBoundarySerial();
        if (serial === this.bufferFrameSerial) return;
        this.bufferFrameSerial = serial;
        for (const [index, slot] of this.vbSlotThisFrame) {
            if (slot > 0) this.vertexBuffers.setDirty(index, true);
        }
        for (const [index, slot] of this.ibSlotThisFrame) {
            if (slot > 0) this.indexBuffers.setDirty(index, true);
        }
        this.vbSlotThisFrame.clear();
        this.ibSlotThisFrame.clear();
        this.vbUploadedThisFrame.clear();
        this.ibUploadedThisFrame.clear();
        this.vbUploadCountThisFrame.clear();
        this.ibUploadCountThisFrame.clear();
    }

    /**
     * Forget every version cached for a store slot. MANDATORY whenever the slot's identity
     * changes — the store recycles indices through a free list, so a released 60-byte index
     * buffer and the 4 KB one created after it are the same `index`, and a ring that outlived
     * the release would hand the new buffer's draws the old buffer. WebGPU does not clamp
     * that: the undersized bind fails validation, and one failed draw invalidates the WHOLE
     * command buffer, so a single stale slot blanks every frame it appears in.
     */
    private dropBufferVersions(index: number, kind: "vb" | "ib"): void {
        const versions = kind === "vb" ? this.vbVersions : this.ibVersions;
        const ring = versions.get(index);
        if (ring) {
            // Deferred, not destroy(): draws already recorded this frame still reference these
            // buffers, and a buffer destroyed before submit fails validation exactly like an
            // undersized one. The recorder frees them right after queue.submit.
            for (const b of ring) this.commandRecorder.registerTemporaryBuffer(b);
            versions.delete(index);
        }
        if (kind === "vb") {
            this.vbSlotThisFrame.delete(index);
            this.vbUploadedThisFrame.delete(index);
            this.vbUploadCountThisFrame.delete(index);
            this.vbLastLockFlags.delete(index);
            this.discardedVb.delete(index);
        } else {
            this.ibSlotThisFrame.delete(index);
            this.ibUploadedThisFrame.delete(index);
            this.ibUploadCountThisFrame.delete(index);
            this.ibLastLockFlags.delete(index);
            this.discardedIb.delete(index);
        }
    }

    /**
     * The GPU buffer this draw must bind for `index`, with its data uploaded. Renames on a
     * DISCARD that would otherwise overwrite bytes an earlier draw in this frame already
     * references. Returns null only when the device is gone.
     */
    private uploadBufferVersion(
        index: number,
        data: Uint8Array,
        kind: "vb" | "ib",
        device: GPUDevice,
    ): GPUBuffer {
        this.syncBufferFrame();
        const isVb = kind === "vb";
        const store = isVb ? this.vertexBuffers : this.indexBuffers;
        const slots = isVb ? this.vbSlotThisFrame : this.ibSlotThisFrame;
        const uploaded = isVb ? this.vbUploadedThisFrame : this.ibUploadedThisFrame;
        const discarded = isVb ? this.discardedVb : this.discardedIb;
        const usage = (isVb ? GPUBufferUsage.VERTEX : GPUBufferUsage.INDEX) | GPUBufferUsage.COPY_DST;
        const size = store.getSize(index);
        // GPU-side ring buffers are padded to a 4-byte multiple to admit the padded
        // writeBuffer the flush performs (see RenderFrame.queueUpload) — a write past the
        // end is a validation error that invalidates the whole frame's command buffer.
        const gpuSize = (size + 3) & ~3;

        // The ring OWNS the buffer identity: slot 0 is the buffer the store was created with,
        // and every frame restarts at slot 0. Driving it from store.getGpuBuffer() instead would
        // make "version 0" mean whichever slot the previous frame happened to end on, and a
        // long frame would then wrap onto a slot it had already used.
        let ring = (isVb ? this.vbVersions : this.ibVersions).get(index);
        // Second line of defence behind dropBufferVersions: a ring slot smaller than the
        // slot's current size can only mean the store re-created under us, and binding it
        // would invalidate the whole frame's command buffer rather than just this draw.
        if (ring && ring[0]!.size < size) {
            Logger.warn(LogCategory.D3D9,
                `buffer version ring stale for ${kind} slot ${index} (ring ${ring[0]!.size} < ${size}) — rebuilding`);
            this.dropBufferVersions(index, kind);
            ring = undefined;
        }
        if (!ring) {
            const storeBuf = store.getGpuBuffer(index);
            const base = storeBuf && storeBuf.size >= gpuSize ? storeBuf : device.createBuffer({ size: gpuSize, usage });
            ring = [base];
            (isVb ? this.vbVersions : this.ibVersions).set(index, ring);
            slots.set(index, 0);
        }

        let slot = slots.get(index);
        if (slot === undefined) { slot = 0; slots.set(index, 0); }

        if (store.isDirty(index)) {
            // A DISCARD after this frame already uploaded the buffer is the renaming case.
            const overwrote = uploaded.has(index);
            const renamed = overwrote && discarded.has(index);
            if (renamed) {
                slot += 1;
                while (ring.length <= slot) ring.push(device.createBuffer({ size: gpuSize, usage }));
                slots.set(index, slot);
            }
            const counts = isVb ? this.vbUploadCountThisFrame : this.ibUploadCountThisFrame;
            const n = (counts.get(index) ?? 0) + 1;
            counts.set(index, n);
            const lastFlags = (isVb ? this.vbLastLockFlags : this.ibLastLockFlags).get(index) ?? 0;
            d3d9PerfBufferUpload(renamed, overwrote, lastFlags, n);
            const target = ring[slot]!;
            store.setGpuBuffer(index, target);
            this.commandRecorder.queueUpload(target, data);
            if (this.fetchAuditFramesLeft > 0) this.fetchAuditShadow.set(target, data.slice());
            store.setDirty(index, false);
            uploaded.add(index);
            if (this.frameSnapshot.frameCounters) {
                this.frameSnapshot.frameCounters.uploads++;
                this.frameSnapshot.frameCounters.vertexBytes += data.byteLength;
            }
        }
        discarded.delete(index);
        const current = ring[slot]!;
        store.setGpuBuffer(index, current);
        return current;
    }

    // ── Indexed-fetch audit (dbg.d3d9FetchAudit) ────────────────────────────────────────
    // Per indexed draw, verifies that the bytes the GPU will fetch at pass execution (the
    // bound ring buffer's final uploaded contents for this frame) equal the bytes the guest's
    // buffers held when the draw was recorded. Splits "the upload/ring layer served other
    // bytes" from "fetch parameters or shading are wrong" without a GPU readback: shadows are
    // keyed by GPUBuffer identity and updated at queueUpload time, so the last upload wins —
    // exactly the contents queue.writeBuffer leaves for the render pass.
    private fetchAuditFramesLeft = 0;
    private fetchAuditShadow = new Map<GPUBuffer, Uint8Array>();
    private fetchAuditRecords: Array<{
        draw: number; fvf: number; stride: number; vbOffset: number;
        baseVertex: number; startIndex: number; indexCount: number; is16: boolean;
        vbIndex: number; ibIndex: number; vbSlot: number; ibSlot: number;
        vbAssumed: boolean; ibAssumed: boolean;
        vbRef: GPUBuffer; ibRef: GPUBuffer;
        expIdxHash: number; expVtxHash: number; expMaxIndex: number;
    }> = [];
    private fetchAuditReport = {
        frames: 0, draws: 0, ok: 0, okAssumed: 0,
        ibMismatch: 0, vbMismatch: 0, bothMismatch: 0, gatherOOB: 0,
        samples: [] as Array<Record<string, unknown>>,
    };

    armFetchAudit(frames: number): void {
        this.fetchAuditFramesLeft = frames;
        this.fetchAuditRecords.length = 0;
        this.fetchAuditShadow.clear();
        this.fetchAuditReport = {
            frames: 0, draws: 0, ok: 0, okAssumed: 0,
            ibMismatch: 0, vbMismatch: 0, bothMismatch: 0, gatherOOB: 0, samples: [],
        };
    }

    getFetchAuditReport(): unknown {
        return { active: this.fetchAuditFramesLeft > 0, ...this.fetchAuditReport };
    }

    private static fnv1a(bytes: Uint8Array, off: number, len: number, h = 0x811c9dc5): number {
        for (let i = off, e = off + len; i < e; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
        return h >>> 0;
    }

    /** Hash the index list and the vertex bytes those indices fetch (mirrors the GPU's
     *  vbOffset + (baseVertex+idx)*stride reads). Returns null when the gather runs past
     *  either buffer — the robust-access case the GPU silently zero-fills. */
    private static hashIndexedFetch(
        ib: Uint8Array, vb: Uint8Array,
        startIndex: number, indexCount: number, is16: boolean,
        vbOffset: number, baseVertex: number, stride: number,
    ): { idxHash: number; vtxHash: number; maxIndex: number } | null {
        const idxBytes = is16 ? 2 : 4;
        const idxOff = startIndex * idxBytes;
        if (idxOff + indexCount * idxBytes > ib.byteLength) return null;
        const dv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
        let idxHash = 0x811c9dc5;
        let vtxHash = 0x811c9dc5;
        let maxIndex = 0;
        for (let i = 0; i < indexCount; i++) {
            const idx = is16 ? dv.getUint16(idxOff + i * 2, true) : dv.getUint32(idxOff + i * 4, true);
            idxHash = Math.imul(idxHash ^ idx, 0x01000193);
            idxHash = Math.imul(idxHash ^ (idx >>> 16), 0x01000193);
            if (idx > maxIndex) maxIndex = idx;
            const vOff = vbOffset + (baseVertex + idx) * stride;
            if (vOff < 0 || vOff + stride > vb.byteLength) return null;
            vtxHash = D3D9Device.fnv1a(vb, vOff, stride, vtxHash);
        }
        return { idxHash: idxHash >>> 0, vtxHash: vtxHash >>> 0, maxIndex };
    }

    /** Record-time half of the audit: expected hashes from the guest's CURRENT buffer bytes.
     *  A buffer the audit has never seen uploaded is seeded from those same bytes and marked
     *  `assumed` — its GPU copy predates the audit, so equality there is presumed, not proven. */
    private fetchAuditRecord(
        vbIndex: number, ibIndex: number, vbData: Uint8Array, ibData: Uint8Array,
        vbRef: GPUBuffer, ibRef: GPUBuffer,
        vbOffset: number, stride: number, baseVertex: number, startIndex: number,
        indexCount: number, is16: boolean,
    ): void {
        let vbAssumed = false, ibAssumed = false;
        if (!this.fetchAuditShadow.has(vbRef)) { this.fetchAuditShadow.set(vbRef, vbData.slice()); vbAssumed = true; }
        if (!this.fetchAuditShadow.has(ibRef)) { this.fetchAuditShadow.set(ibRef, ibData.slice()); ibAssumed = true; }
        const exp = D3D9Device.hashIndexedFetch(ibData, vbData, startIndex, indexCount, is16, vbOffset, baseVertex, stride);
        if (!exp) { this.fetchAuditReport.gatherOOB++; return; }
        this.fetchAuditRecords.push({
            draw: this.drawCount, fvf: this.stateTracker.getFVF(), stride, vbOffset,
            baseVertex, startIndex, indexCount, is16, vbIndex, ibIndex,
            vbSlot: this.vbSlotThisFrame.get(vbIndex) ?? 0, ibSlot: this.ibSlotThisFrame.get(ibIndex) ?? 0,
            vbAssumed, ibAssumed, vbRef, ibRef,
            expIdxHash: exp.idxHash, expVtxHash: exp.vtxHash, expMaxIndex: exp.maxIndex,
        });
    }

    /** Present-time half: replay every recorded fetch against the shadows (= the bytes the
     *  render pass will actually see) and tally agreement. */
    private fetchAuditOnPresent(): void {
        if (this.fetchAuditFramesLeft <= 0) return;
        const rep = this.fetchAuditReport;
        rep.frames++;
        for (const r of this.fetchAuditRecords) {
            rep.draws++;
            const vbShadow = this.fetchAuditShadow.get(r.vbRef)!;
            const ibShadow = this.fetchAuditShadow.get(r.ibRef)!;
            const act = D3D9Device.hashIndexedFetch(
                ibShadow, vbShadow, r.startIndex, r.indexCount, r.is16, r.vbOffset, r.baseVertex, r.stride);
            const idxOk = act !== null && act.idxHash === r.expIdxHash;
            const vtxOk = act !== null && act.vtxHash === r.expVtxHash;
            if (idxOk && vtxOk) {
                if (r.vbAssumed || r.ibAssumed) rep.okAssumed++; else rep.ok++;
                continue;
            }
            if (!idxOk && !vtxOk) rep.bothMismatch++;
            else if (!idxOk) rep.ibMismatch++;
            else rep.vbMismatch++;
            if (rep.samples.length < 24) {
                rep.samples.push({
                    frame: rep.frames, draw: r.draw, fvf: `0x${r.fvf.toString(16)}`, stride: r.stride,
                    vbIndex: r.vbIndex, ibIndex: r.ibIndex, vbSlot: r.vbSlot, ibSlot: r.ibSlot,
                    vbOffset: r.vbOffset, baseVertex: r.baseVertex, startIndex: r.startIndex,
                    indexCount: r.indexCount, is16: r.is16,
                    idxOk, vtxOk, gatherOOB: act === null,
                    expMaxIndex: r.expMaxIndex, actMaxIndex: act?.maxIndex ?? -1,
                    vbAssumed: r.vbAssumed, ibAssumed: r.ibAssumed,
                    vbShadowSize: vbShadow.byteLength, ibShadowSize: ibShadow.byteLength,
                });
            }
        }
        this.fetchAuditRecords.length = 0;
        if (--this.fetchAuditFramesLeft <= 0) this.fetchAuditShadow.clear();
    }

    lockVertexBuffer(vbPtr: number, offset: number, size: number, flags = 0): number {
        const index = this.vertexBuffers.getIndex(vbPtr);
        if (index === null) return 0;
        d3d9PerfBufferLock(flags);
        this.vbLastLockFlags.set(index, flags);
        if (flags & D3DLOCK_DISCARD) this.discardedVb.add(index);

        const bufSize = this.vertexBuffers.getSize(index);
        // Faithful D3D9: a lock range that starts at/past the end of the buffer is
        // INVALIDCALL. Returning guestBase+offset unvalidated would hand the guest a
        // pointer past the allocation (silent HEAP corruption).
        if (offset >= bufSize && bufSize !== 0) {
            Logger.error(
                LogCategory.D3D9,
                `VertexBuffer::Lock OUT-OF-RANGE offset=0x${offset.toString(16)} >= size=0x${bufSize.toString(16)} — refusing (INVALIDCALL)`,
            );
            return 0;
        }
        const maxSize = Math.max(0, bufSize - offset);
        const bytes = size === 0 ? maxSize : Math.min(size, maxSize);
        const ptr = this.vertexBuffers.lock(index, offset, bytes);
        return ptr >= 0 ? ptr : 0;
    }

    unlockVertexBuffer(vbPtr: number, memory: Uint8Array): number {
        const index = this.vertexBuffers.getIndex(vbPtr);
        if (index === null) return 0;
        const guestBase = this.vertexBuffers.getGuestPtr(index);
        if (guestBase >= 0) {
            this.checkCanary(memory, guestBase, this.vertexBuffers.getSize(index), "VB", vbPtr);
        }
        this.vertexBuffers.unlock(index, memory);
        return 0;
    }

    createIndexBuffer(ibPtr: number, size: number, format: number): number {
        const process = System.getInstance().process;
        if (!process) return 0;
        try {
            // +16: tail canary, same scheme as createVertexBuffer.
            const guestPtr = process.memory.alloc(size + D3D9Device.BUF_CANARY_BYTES, "HEAP");
            const index = this.indexBuffers.create(ibPtr, size, format, guestPtr);
            this.dropBufferVersions(index, "ib");
            this.writeCanary(null, guestPtr, size);
            return guestPtr;
        } catch (e) {
            Logger.error(LogCategory.D3D9, `createIndexBuffer: HEAP alloc failed size=${size}: ${e}`);
            return 0;
        }
    }

    lockIndexBuffer(ibPtr: number, offset: number, size: number, flags = 0): number {
        const index = this.indexBuffers.getIndex(ibPtr);
        if (index === null) return 0;
        d3d9PerfBufferLock(flags);
        this.ibLastLockFlags.set(index, flags);
        if (flags & D3DLOCK_DISCARD) this.discardedIb.add(index);

        const bufSize = this.indexBuffers.getSize(index);
        // Faithful D3D9: out-of-range lock start = INVALIDCALL (see lockVertexBuffer).
        if (offset >= bufSize && bufSize !== 0) {
            Logger.error(
                LogCategory.D3D9,
                `IndexBuffer::Lock OUT-OF-RANGE offset=0x${offset.toString(16)} >= size=0x${bufSize.toString(16)} — refusing (INVALIDCALL)`,
            );
            return 0;
        }
        const maxSize = Math.max(0, bufSize - offset);
        const bytes = size === 0 ? maxSize : Math.min(size, maxSize);
        const ptr = this.indexBuffers.lock(index, offset, bytes);
        return ptr >= 0 ? ptr : 0;
    }

    unlockIndexBuffer(ibPtr: number, memory: Uint8Array): number {
        const index = this.indexBuffers.getIndex(ibPtr);
        if (index === null) return 0;
        const guestBase = this.indexBuffers.getGuestPtr(index);
        if (guestBase >= 0) {
            this.checkCanary(memory, guestBase, this.indexBuffers.getSize(index), "IB", ibPtr);
        }
        this.indexBuffers.unlock(index, memory);
        return 0;
    }

    setIndices(ibPtr: number): number {
        d3d9PerfInc("setIndices");
        const index = ibPtr === 0 ? null : this.indexBuffers.getIndex(ibPtr);
        // Unknown pointer: clear the binding with the error (see setTexture) — a stale
        // index buffer would otherwise index the next draw's vertices.
        const unknown = ibPtr !== 0 && index === null;
        this.boundIndexPtr = this.replaceHeldComRef(this.boundIndexPtr, unknown ? 0 : ibPtr);
        if (index === null) {
            if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setIndices(0, 0);
            if (!this.stateTracker.setIndexSource(null)) d3d9PerfSkip("setIndices");
            return unknown ? D3DERR_INVALIDCALL : D3D_OK;
        }
        const validIndex = index;
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setIndices(validIndex, this.indexBuffers.getFormat(validIndex));
        if (!this.stateTracker.setIndexSource(validIndex)) d3d9PerfSkip("setIndices");
        return D3D_OK;
    }

    setPaletteEntries(paletteNumber: number, pEntries: number, mem: Uint8Array): void {
        this.texturePalettes.setPaletteEntries(paletteNumber, pEntries, mem);
    }

    getPaletteEntries(paletteNumber: number, pEntries: number, mem: Uint8Array): boolean {
        return this.texturePalettes.getPaletteEntries(paletteNumber, pEntries, mem);
    }

    setCurrentTexturePalette(paletteNumber: number): void {
        this.texturePalettes.setCurrentTexturePalette(paletteNumber);
    }

    getCurrentTexturePalette(): number {
        return this.texturePalettes.getCurrentTexturePalette();
    }

    createTexture(texPtr: number, width: number, height: number, levels: number, format: number, usage: number = 0): number {
        const process = System.getInstance().process;
        if (!process) return 0;
        const bytes = getD3DTextureLayout(format, width, height).bytes;
        try {
            const guestPtr = process.memory.alloc(bytes, "HEAP");
            const index = this.textures.create(texPtr, width, height, levels, format, guestPtr);
            // D3DUSAGE_RENDERTARGET (0x1): the guest renders INTO this texture (no LockRect
            // upload). Create a render-attachment-capable GPU texture eagerly so it is a valid
            // sample source the instant the guest binds it (otherwise ensureTexture would see
            // empty data and the draw would fall back to the white 1×1 texture → white flash).
            const D3DUSAGE_RENDERTARGET = 0x1;
            if (this.rtCreateLog.length < 24) this.rtCreateLog.push(`${width}x${height} usage=0x${usage.toString(16)} fmt=${format} -> tex=0x${texPtr.toString(16)}${(usage & D3DUSAGE_RENDERTARGET) ? " [RT]" : ""}`);
            if (usage & D3DUSAGE_RENDERTARGET) {
                const dev = this.backend.getDevice();
                if (dev) {
                    // Match the swap-chain/pipeline color format (pipelines target backend.getFormat();
                    // a mismatched RT attachment format is a WebGPU validation error). Sampling a
                    // bgra8unorm RT later still returns correct rgba in-shader.
                    const rtFormat = this.backend.getFormat() ?? "rgba8unorm";
                    const tex = dev.createTexture({
                        size: { width, height, depthOrArrayLayers: 1 },
                        format: rtFormat,
                        mipLevelCount: 1,
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
                               GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                    });
                    this.textures.setGpuTexture(index, tex, tex.createView());
                    this.textures.markRenderTarget(index);
                    this.textures.setDirty(index, false); // nothing to upload; content comes from rendering
                }
            }
            return guestPtr;
        } catch (e) {
            Logger.error(LogCategory.D3D9, `createTexture: HEAP alloc failed ${width}x${height}: ${e}`);
            return 0;
        }
    }

    /**
     * Create a cube texture: one GPU texture with 6 array layers (the cube faces) and a
     * dimension:"cube" sampling view. Created eagerly (like the RT-2D path) so the cube is a
     * valid sample/render source the instant the guest binds it. Render-target cubes (NFSU
     * reflection probes) render each face via a per-face 2D view (getCubeFaceRenderView);
     * static cubes upload LockRect'd face pixels via ensureCubeTexture.
     */
    createCubeTexture(cubePtr: number, edge: number, levels: number, format: number, usage: number = 0): number {
        const process = System.getInstance().process;
        if (!process) return 0;
        const e = Math.max(1, edge >>> 0);
        const levelCount = Math.max(1, levels >>> 0);
        try {
            // Scratch HEAP backing keeps TextureStore.create's bookkeeping uniform with 2D
            // textures; cube faces are locked into per-face scratch on demand (lockCubeFace).
            const guestPtr = process.memory.alloc(getD3DTextureLayout(format, e, e).bytes, "HEAP");
            const index = this.textures.create(cubePtr, e, e, levelCount, format, guestPtr);
            this.textures.markCube(index);
            if (d3d9WasmArena.isInitialized()) d3d9WasmArena.markTextureCube(index, true);

            const dev = this.backend.getDevice();
            if (dev) {
                const D3DUSAGE_RENDERTARGET = 0x1;
                const isRT = (usage & D3DUSAGE_RENDERTARGET) !== 0;
                // RT cube faces are color attachments → must match the pipeline color format
                // (backend format). Static cubes sample as rgba8unorm like 2D textures.
                const fmt: GPUTextureFormat = isRT ? (this.backend.getFormat() ?? "rgba8unorm") : "rgba8unorm";
                const tex = dev.createTexture({
                    size: { width: e, height: e, depthOrArrayLayers: 6 },
                    format: fmt,
                    mipLevelCount: isRT ? 1 : levelCount,
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
                           GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                });
                const cubeView = tex.createView({ dimension: "cube", arrayLayerCount: 6 });
                this.textures.setGpuTexture(index, tex, cubeView);
                if (this.rtCreateLog.length < 24) {
                    this.rtCreateLog.push(`cube ${e}x${e} L${levelCount} usage=0x${usage.toString(16)} fmt=${format} -> tex=0x${cubePtr.toString(16)}${isRT ? " [RT]" : ""}`);
                }
                if (isRT) {
                    this.textures.markRenderTarget(index);
                    this.textures.setDirty(index, false); // content comes from rendering into faces
                }
            }
            return guestPtr;
        } catch (e2) {
            Logger.error(LogCategory.D3D9, `createCubeTexture: alloc failed ${edge}px: ${e2}`);
            return 0;
        }
    }

    /** LockRect one face (+ mip level) of a cube texture: hands back a writable HEAP scratch
     *  buffer the guest fills, mirroring the mip-level>0 lock path for 2D textures. */
    lockCubeFace(cubePtr: number, face: number, level: number): { ptr: number; pitch: number } | null {
        const index = this.textures.getIndex(cubePtr);
        if (index === null) return null;
        const edge = Math.max(1, this.textures.getWidth(index) >>> level);
        const format = this.textures.getFormat(index);
        const layout = getD3DTextureLayout(format, edge, edge);
        const pitch = layout.pitch;
        const bytes = layout.bytes;

        const key = `${cubePtr}:${face}:${level}`;
        const existing = this.cubeFaceLocks.get(key);
        if (existing) return { ptr: existing.guestPtr, pitch: existing.pitch };

        const process = System.getInstance().process;
        if (!process) return null;
        let guestPtr: number;
        try {
            guestPtr = process.memory.alloc(bytes, "HEAP");
        } catch (err) {
            Logger.error(LogCategory.D3D9, `lockCubeFace: HEAP alloc failed bytes=${bytes}: ${err}`);
            return null;
        }
        // Seed with prior contents so a partial re-lock round-trips.
        const prior = this.cubeFaceData.get(key);
        if (prior && prior.length === bytes) this.memory.set(prior, guestPtr);

        this.cubeFaceLocks.set(key, { guestPtr, pitch });
        return { ptr: guestPtr, pitch };
    }

    /** UnlockRect a cube face: persist the written pixels and mark the cube for re-upload. */
    unlockCubeFace(cubePtr: number, face: number, level: number, memory: Uint8Array): number {
        const index = this.textures.getIndex(cubePtr);
        if (index === null) return 0;
        const key = `${cubePtr}:${face}:${level}`;
        const lock = this.cubeFaceLocks.get(key);
        if (!lock) return 0;
        const edge = Math.max(1, this.textures.getHeight(index) >>> level);
        const format = this.textures.getFormat(index);
        const rows = getD3DTextureLayout(format, edge, edge).rows;
        const bytes = lock.pitch * rows;
        const saved = new Uint8Array(bytes);
        saved.set(memory.subarray(lock.guestPtr, lock.guestPtr + bytes));
        this.cubeFaceData.set(key, saved);
        System.getInstance().process?.memory.free(lock.guestPtr);
        this.cubeFaceLocks.delete(key);
        this.textures.setDirty(index, true);
        return 0;
    }

    /** GetRenderTargetData: read the src texture's GPU pixels back into the dst
     *  texture's CPU/guest store, converted to the dst's D3D format layout.
     *  Resolves 0 (D3D_OK) or D3DERR_INVALIDCALL. */
    async readTextureIntoGuestTexture(srcTexPtr: number, dstTexPtr: number): Promise<number> {
        const D3DERR_INVALIDCALL = 0x8876086c;
        const srcIdx = this.textures.getIndex(srcTexPtr);
        const dstIdx = this.textures.getIndex(dstTexPtr);
        if (srcIdx === null || dstIdx === null) return D3DERR_INVALIDCALL;
        const gpuTex = this.textures.getGpuTexture(srcIdx);
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!gpuTex || !device || !queue) return D3DERR_INVALIDCALL;

        const width = Math.min(this.textures.getWidth(srcIdx), this.textures.getWidth(dstIdx));
        const height = Math.min(this.textures.getHeight(srcIdx), this.textures.getHeight(dstIdx));
        if (width <= 0 || height <= 0) return D3DERR_INVALIDCALL;

        // 21/22 = [A|X]R8G8B8, 23 = R5G6B5, 24 = X1R5G5B5.
        const dstFormat = this.textures.getFormat(dstIdx);
        const dstIs32 = dstFormat === 21 || dstFormat === 22;
        if (!dstIs32 && dstFormat !== 23 && dstFormat !== 24) return D3DERR_INVALIDCALL;

        // Flush pending recorded draws so the readback sees this frame's rendering
        // (no-op when the recorder is empty).
        this.submitFrame(false);

        const unpadded = width * 4;
        const padded = Math.ceil(unpadded / 256) * 256;
        const readback = device.createBuffer({
            size: padded * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture: gpuTex },
                { buffer: readback, bytesPerRow: padded },
                { width, height, depthOrArrayLayers: 1 },
            );
            queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(readback.getMappedRange());

            const dstData = this.textures.getData(dstIdx);
            if (!dstData) return D3DERR_INVALIDCALL;
            const dstPitch = this.textures.getPitch(dstIdx);
            if (dstIs32) {
                // rgba8 → D3D 32-bit [A|X]RGB byte order (B,G,R,A little-endian).
                for (let y = 0; y < height; y++) {
                    const srcRow = y * padded;
                    const dstRow = y * dstPitch;
                    for (let x = 0; x < width; x++) {
                        const s = srcRow + x * 4;
                        const d = dstRow + x * 4;
                        dstData[d] = mapped[s + 2];
                        dstData[d + 1] = mapped[s + 1];
                        dstData[d + 2] = mapped[s];
                        dstData[d + 3] = mapped[s + 3];
                    }
                }
            } else {
                // rgba8 → R5G6B5 / X1R5G5B5, little-endian 16-bit.
                const is565 = dstFormat === 23;
                for (let y = 0; y < height; y++) {
                    const srcRow = y * padded;
                    const dstRow = y * dstPitch;
                    for (let x = 0; x < width; x++) {
                        const s = srcRow + x * 4;
                        const r = mapped[s], g = mapped[s + 1], b = mapped[s + 2];
                        const packed = is565
                            ? ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
                            : ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                        const d = dstRow + x * 2;
                        dstData[d] = packed & 0xff;
                        dstData[d + 1] = (packed >> 8) & 0xff;
                    }
                }
            }
            readback.unmap();
            return 0;
        } finally {
            readback.destroy();
        }
    }

    lockTexture(texPtr: number, level: number): { ptr: number; pitch: number } | null {
        const index = this.textures.getIndex(texPtr);
        if (index === null) return null;

        // Level 0 is backed by the per-texture HEAP allocation.
        if (level === 0) {
            if (this.textures.isLocked(index)) {
                const ptr = this.textures.getLockedPtr(index);
                if (ptr >= 0) {
                    return { ptr, pitch: this.textures.getPitch(index) };
                }
            }
            return this.textures.lock(index);
        }

        // Compatibility path for mip levels > 0: provide a writable temp buffer and
        // accept UnlockRect, but do not upload/use mip data yet.
        const levelWidth = Math.max(1, this.textures.getWidth(index) >>> level);
        const levelHeight = Math.max(1, this.textures.getHeight(index) >>> level);
        const format = this.textures.getFormat(index);
        const layout = getD3DTextureLayout(format, levelWidth, levelHeight);
        const levelPitch = layout.pitch;
        const bytes = layout.bytes;

        const key = `${texPtr}:${level}`;
        const existingLock = this.mipLevelLocks.get(key);
        if (existingLock) {
            return { ptr: existingLock.guestPtr, pitch: existingLock.pitch };
        }

        const process = System.getInstance().process;
        if (!process) return null;
        let guestPtr: number;
        try {
            guestPtr = process.memory.alloc(bytes, "HEAP");
        } catch (e) {
            Logger.error(LogCategory.D3D9, `lockTexture mip${level}: HEAP alloc failed bytes=${bytes}: ${e}`);
            return null;
        }

        const existing = this.mipLevelData.get(key);
        if (existing && existing.length === bytes) {
            this.memory.set(existing, guestPtr);
        }

        this.mipLevelLocks.set(key, { guestPtr, pitch: levelPitch });
        return { ptr: guestPtr, pitch: levelPitch };
    }

    /** Read texture level pixels (level 0 from store, mips from persisted side buffer). */
    getTextureLevelPixels(texPtr: number, level: number): {
        data: Uint8Array;
        pitch: number;
        width: number;
        height: number;
    } | null {
        const index = this.textures.getIndex(texPtr);
        if (index === null) return null;

        const width = Math.max(1, this.textures.getWidth(index) >>> level);
        const height = Math.max(1, this.textures.getHeight(index) >>> level);
        const layout = getD3DTextureLayout(this.textures.getFormat(index), width, height);
        const pitch = level === 0 ? this.textures.getPitch(index) : layout.pitch;
        const bytes = pitch * layout.rows;

        if (level === 0) {
            const data = this.textures.getData(index);
            if (!data || data.length < bytes) return null;
            return { data, pitch, width, height };
        }

        const key = `${texPtr}:${level}`;
        const mip = this.mipLevelData.get(key);
        if (!mip || mip.length < bytes) {
            const empty = new Uint8Array(bytes);
            return { data: empty, pitch, width, height };
        }
        return { data: mip, pitch, width, height };
    }

    /** Write texture level pixels (level 0 to store, mips to side buffer). */
    setTextureLevelPixels(texPtr: number, level: number, src: Uint8Array, srcPitch: number): boolean {
        const index = this.textures.getIndex(texPtr);
        if (index === null) return false;

        const width = Math.max(1, this.textures.getWidth(index) >>> level);
        const height = Math.max(1, this.textures.getHeight(index) >>> level);
        const layout = getD3DTextureLayout(this.textures.getFormat(index), width, height);
        const pitch = level === 0 ? this.textures.getPitch(index) : layout.pitch;
        const bytes = pitch * layout.rows;
        if (src.length < srcPitch * layout.rows) return false;

        if (level === 0) {
            const data = this.textures.getData(index);
            if (!data) return false;
            if (srcPitch === pitch) {
                data.set(src.subarray(0, bytes));
            } else {
                for (let y = 0; y < layout.rows; y++) {
                    data.set(
                        src.subarray(y * srcPitch, y * srcPitch + pitch),
                        y * pitch,
                    );
                }
            }
            this.textures.setDirty(index, true);
            return true;
        }

        const out = new Uint8Array(bytes);
        if (srcPitch === pitch) {
            out.set(src.subarray(0, bytes));
        } else {
            for (let y = 0; y < layout.rows; y++) {
                out.set(
                    src.subarray(y * srcPitch, y * srcPitch + pitch),
                    y * pitch,
                );
            }
        }
        this.mipLevelData.set(`${texPtr}:${level}`, out);
        return true;
    }

    clearMipLevelData(texPtr?: number): void {
        if (texPtr === undefined) {
            this.mipLevelData.clear();
            return;
        }
        const prefix = `${texPtr}:`;
        for (const key of this.mipLevelData.keys()) {
            if (key.startsWith(prefix)) this.mipLevelData.delete(key);
        }
    }

    unlockTexture(texPtr: number, level: number, memory: Uint8Array): number {
        const index = this.textures.getIndex(texPtr);
        if (index === null) return 0;

        if (level !== 0) {
            const key = `${texPtr}:${level}`;
            const lock = this.mipLevelLocks.get(key);
            if (lock) {
                const levelWidth = Math.max(1, this.textures.getWidth(index) >>> level);
                const levelHeight = Math.max(1, this.textures.getHeight(index) >>> level);
                const rows = getD3DTextureLayout(this.textures.getFormat(index), levelWidth, levelHeight).rows;
                const bytes = lock.pitch * rows;
                const saved = new Uint8Array(bytes);
                saved.set(memory.subarray(lock.guestPtr, lock.guestPtr + bytes));
                this.mipLevelData.set(key, saved);
                System.getInstance().process?.memory.free(lock.guestPtr);
                this.mipLevelLocks.delete(key);
                // Mark dirty so ensureTexture re-uploads (and re-sizes the chain) with the new mip.
                this.textures.setDirty(index, true);
            }
            return 0;
        }

        this.textures.unlock(index, memory);
        return 0;
    }

    setTexture(stage: number, texPtr: number): number {
        d3d9PerfInc("setTexture");
        if (stage < 0 || stage >= PROG_BIND.MAX_TEX) return D3DERR_INVALIDCALL;
        const index = texPtr === 0 ? null : this.textures.getIndex(texPtr);
        // A pointer this store does not know names a texture that no longer exists (or
        // never was ours). Report the failure, but UNBIND the stage: leaving the previous
        // texture live would sample a stale image into every later draw.
        const unknown = texPtr !== 0 && index === null;
        if (this.recordingStateBlock) {
            if (unknown) return D3DERR_INVALIDCALL;
            this.recordStateBlock({ op: "texture", stage, texPtr });
            return D3D_OK;
        }
        if (stage < this.boundTexturePtrs.length) {
            this.boundTexturePtrs[stage] = this.replaceHeldComRef(this.boundTexturePtrs[stage]!, unknown ? 0 : texPtr);
        }
        if (index === null) {
            if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setTexture(stage, 0);
            if (!this.stateTracker.setTexture(stage, null)) {
                d3d9PerfSkip("setTexture");
            }
            return unknown ? D3DERR_INVALIDCALL : D3D_OK;
        }
        // `index` is the SAME internal numeric id used everywhere else in this store (not
        // the raw guest COM pointer) — exactly what the arena's textureId expects.
        const validIndex = index;
        if (validIndex === null) return D3DERR_INVALIDCALL;
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setTexture(stage, validIndex);
        if (!this.stateTracker.setTexture(stage, validIndex)) {
            d3d9PerfSkip("setTexture");
            return D3D_OK;
        }

        // Update frame snapshot counter
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.textureBinds++;
        }

        return D3D_OK;
    }

    /**
     * Release a vertex buffer and its GPU resources.
     * Called when the COM object's refCount reaches 0.
     */
    releaseVertexBuffer(vbPtr: number): void {
        const index = this.vertexBuffers.getIndex(vbPtr);
        if (index !== null) this.dropBufferVersions(index, "vb");
        const vb = this.vertexBuffers.release(vbPtr);
        if (vb?.gpuBuffer) {
            // Deferred for the same reason as the version ring — a draw recorded earlier in
            // this frame may still bind it (see dropBufferVersions).
            this.commandRecorder.registerTemporaryBuffer(vb.gpuBuffer);
        }
        if (vb && vb.guestPtr > 0) {
            System.getInstance().process?.memory.free(vb.guestPtr);
        }
    }

    /**
     * Release an index buffer and its GPU resources.
     * Called when the COM object's refCount reaches 0.
     */
    releaseIndexBuffer(ibPtr: number): void {
        const index = this.indexBuffers.getIndex(ibPtr);
        if (index !== null) this.dropBufferVersions(index, "ib");
        const ib = this.indexBuffers.release(ibPtr);
        if (ib?.gpuBuffer) {
            this.commandRecorder.registerTemporaryBuffer(ib.gpuBuffer);
        }
        if (ib && ib.guestPtr > 0) {
            System.getInstance().process?.memory.free(ib.guestPtr);
        }
    }

    /**
     * Release a texture and its GPU resources.
     * Called when the COM object's refCount reaches 0.
     */
    releaseTexture(texPtr: number): void {
        const mipPrefix = `${texPtr}:`;
        for (const [key, lock] of this.mipLevelLocks.entries()) {
            if (key.startsWith(mipPrefix)) {
                System.getInstance().process?.memory.free(lock.guestPtr);
                this.mipLevelLocks.delete(key);
            }
        }
        this.clearMipLevelData(texPtr);

        // Cube face scratch / persisted pixels / per-face render views keyed by this texPtr.
        const cubePrefix = `${texPtr}:`;
        for (const [key, lock] of this.cubeFaceLocks.entries()) {
            if (key.startsWith(cubePrefix)) {
                System.getInstance().process?.memory.free(lock.guestPtr);
                this.cubeFaceLocks.delete(key);
            }
        }
        for (const key of this.cubeFaceData.keys()) {
            if (key.startsWith(cubePrefix)) this.cubeFaceData.delete(key);
        }
        const relIndex = this.textures.getIndex(texPtr);
        if (relIndex !== null) {
            const viewPrefix = `${relIndex}:`;
            for (const key of this.cubeFaceRenderViews.keys()) {
                if (key.startsWith(viewPrefix)) this.cubeFaceRenderViews.delete(key);
            }
        }

        const tex = this.textures.release(texPtr);
        if (!tex) return;
        if (tex.guestPtr > 0) {
            System.getInstance().process?.memory.free(tex.guestPtr);
        }
        if (tex.gpuTexture) {
            tex.gpuTexture.destroy();
        }
    }

    setTransform(state: number, matrix: Float32Array): number {
        d3d9PerfInc("setTransform");
        if (this.recordingStateBlock) {
            // D3DTS_TEXTURE0..7 belong in a state block for the same reason the other three do:
            // the FFP texture transform is captured/applied state, and a block that restores the
            // stage's TEXTURETRANSFORMFLAGS but not its matrix restores half a transform.
            if (state === D3DTS_WORLD || state === D3DTS_VIEW || state === D3DTS_PROJECTION
                || (state >= D3DTS_TEXTURE0 && state < D3DTS_TEXTURE0 + FFP_TEXTURE_TRANSFORM_COUNT)) {
                this.recordStateBlock({ op: "transform", state, matrix: new Float32Array(matrix) });
            }
            return 0;
        }
        if (!this.stateTracker.setTransform(state, matrix)) {
            d3d9PerfSkip("setTransform");
            return 0;
        }
        return 0;
    }

    getTransform(state: number): Float32Array | null {
        if (state === D3DTS_WORLD) return this.stateTracker.getWorldMatrix();
        if (state === D3DTS_VIEW) return this.stateTracker.getViewMatrix();
        if (state === D3DTS_PROJECTION) return this.stateTracker.getProjectionMatrix();
        return this.stateTracker.getTextureMatrix(state);
    }

    private makeStageStateKey(stage: number, type: number): number {
        return (((stage & 0xffff) << 16) | (type & 0xffff)) >>> 0;
    }

    setTextureStageState(stage: number, type: number, value: number): number {
        d3d9PerfInc("setTextureStageState");
        const key = this.makeStageStateKey(stage, type);
        const v = value >>> 0;
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "textureStageState", stage, type, value: v });
            return 0;
        }
        if (this.textureStageStates.get(key) === v) {
            d3d9PerfSkip("setTextureStageState");
            return 0;
        }
        this.textureStageStates.set(key, v);
        // Diagnostic: remember if the title ever requests projective texturing (D3DTTFF_PROJECTED).
        // A per-draw flag toggled on/off is invisible to a between-frames stage-state snapshot, so a
        // sticky counter + flag-union is the reliable "does this game project at all" signal.
        if (type === D3DTSS_TEXTURETRANSFORMFLAGS && (v & D3DTTFF_PROJECTED)) {
            this.projectedSetCount++;
            this.projectedFlagsSeen |= v;
        }
        return 0;
    }

    getTextureStageState(stage: number, type: number): number {
        return this.textureStageStates.get(this.makeStageStateKey(stage, type)) ?? 0;
    }

    setSamplerState(sampler: number, type: number, value: number): number {
        d3d9PerfInc("setSamplerState");
        const key = this.makeStageStateKey(sampler, type);
        const v = value >>> 0;
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "samplerState", sampler, type, value: v });
            // Resync the optimistic guest-side shadow write (see setRenderState).
            if (sampler >= 0 && sampler < 16 && type >= 0 && type < 16) {
                this.syncSetterShadow('IDirect3DDevice9_SetSamplerState', (sampler << 4) | type, this.samplerStates.get(key) ?? 0);
            }
            return 0;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setSamplerState(sampler, type, value);
        if (this.samplerStates.get(key) === v) {
            d3d9PerfSkip("setSamplerState");
            return 0;
        }
        this.writeSamplerState(key, sampler, v);
        // Mirror into the guest shadow (slot = (Sampler<<4)|Type, matching the trampoline's fold;
        // only the shadowed range). Covers state-block Apply and any other non-trampoline path.
        if (sampler >= 0 && sampler < 16 && type >= 0 && type < 16) {
            this.syncSetterShadow('IDirect3DDevice9_SetSamplerState', (sampler << 4) | type, v);
        }
        return 0;
    }

    /** The ONLY mutation of samplerStates: dropping the stage's memoised sampler in the same
     *  statement is what makes resolveStageSampler's cache unable to go stale. A sampler index
     *  outside the memoised range (vertex-texture units 257+, or a bogus one) drops the whole
     *  memo rather than aliasing some stage's bit. */
    private writeSamplerState(key: number, sampler: number, value: number): void {
        this.samplerStates.set(key, value);
        const s = sampler >>> 0;
        this.stageSamplersValid = s < FFP_MAX_STAGES ? (this.stageSamplersValid & ~(1 << s)) : 0;
    }

    getSamplerState(sampler: number, type: number): number {
        return this.samplerStates.get(this.makeStageStateKey(sampler, type)) ?? 0;
    }

    setMaterial(data: Uint8Array): number {
        if (this.recordingStateBlock) {
            const copy = new Uint8Array(D3DMATERIAL9_SIZE);
            copy.set(data.subarray(0, Math.min(D3DMATERIAL9_SIZE, data.length)), 0);
            this.recordStateBlock({ op: "material", data: copy });
            return 0;
        }
        const size = Math.min(D3DMATERIAL9_SIZE, data.length);
        this.materialData.fill(0);
        this.materialData.set(data.subarray(0, size), 0);
        d3d9PerfMaterialSet();
        return 0;
    }

    getMaterial(): Uint8Array {
        return this.materialData;
    }

    setLight(index: number, data: Uint8Array): number {
        const copy = new Uint8Array(D3DLIGHT9_SIZE);
        copy.set(data.subarray(0, Math.min(D3DLIGHT9_SIZE, data.length)), 0);
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "light", index: index >>> 0, data: copy });
            return 0;
        }
        this.lights.set(index >>> 0, copy);
        return 0;
    }

    getLight(index: number): Uint8Array | null {
        return this.lights.get(index >>> 0) ?? null;
    }

    lightEnable(index: number, enable: number): number {
        const value = enable ? 1 : 0;
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "lightEnable", index: index >>> 0, enable: value });
            return 0;
        }
        this.lightEnables.set(index >>> 0, value);
        return 0;
    }

    getLightEnable(index: number): number {
        return this.lightEnables.get(index >>> 0) ?? 0;
    }

    setClipPlane(index: number, plane: Float32Array): number {
        if (plane.length < 4) return 0x8876086c;
        const copy = new Float32Array(4);
        copy.set(plane.subarray(0, 4));
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "clipPlane", index: index >>> 0, plane: copy });
            return 0;
        }
        this.clipPlanes.set(index >>> 0, copy);
        return 0;
    }

    getClipPlane(index: number): Float32Array | null {
        return this.clipPlanes.get(index >>> 0) ?? null;
    }

    // ── FFP lighting state gather ─────────────────────────────────────────
    // Reused scratch for the per-frame FFP uniform block (zero steady-state alloc).
    private ffpUniformBlock = new Float32Array(FFP_UNIFORM_FLOATS);
    // Reused scratch: the 6 raw user clip-plane equations packed as 6 × vec4 (index N at N*4).
    private ffpClipPlanesScratch = new Float32Array(6 * 4);
    // Reused scratch: inverse-transpose of worldView's 3×3, widened to 4×4 (see buildNormalMatrix).
    private ffpNormalMatrix = new Float32Array(16);
    // Reused scratch for the enabled-light gather: `ffpLightPool` holds parsed records that
    // parseLightInto overwrites, `ffpLights` is the (sub)list handed to packFfpUniforms and
    // `ffpEnabledIdx` the sorted enabled indices. buildFfpUniformBlock runs per submit, so the
    // gather must not allocate once these have grown to their steady-state size.
    private ffpLightPool: FfpLightInput[] = [];
    private ffpLights: FfpLightInput[] = [];
    private ffpEnabledIdx: number[] = [];
    // Same pool/list split for the resolved texture stages: `ffpStagePool` holds records
    // resolveFfpStages overwrites, `ffpStages` is the list its callers read.
    private ffpStagePool: FfpResolvedStage[] = [];
    private ffpStages: FfpResolvedStage[] = [];

    /** Parse the stored D3DMATERIAL9 bytes into float colours + power. */
    private parseMaterial(): FfpMaterial {
        const dv = new DataView(this.materialData.buffer, this.materialData.byteOffset, this.materialData.byteLength);
        const color = (o: number) => ({
            r: dv.getFloat32(o, true), g: dv.getFloat32(o + 4, true),
            b: dv.getFloat32(o + 8, true), a: dv.getFloat32(o + 12, true),
        });
        return {
            diffuse: color(0), ambient: color(16), specular: color(32), emissive: color(48),
            power: dv.getFloat32(64, true),
        };
    }

    /** Overwrite `out` with one stored D3DLIGHT9 record. */
    private parseLightInto(data: Uint8Array, out: FfpLightInput): void {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const color = (o: number, c: FfpColor) => {
            c.r = dv.getFloat32(o, true); c.g = dv.getFloat32(o + 4, true);
            c.b = dv.getFloat32(o + 8, true); c.a = dv.getFloat32(o + 12, true);
        };
        out.type = dv.getUint32(0, true);
        color(4, out.diffuse); color(20, out.specular); color(36, out.ambient);
        out.position[0] = dv.getFloat32(52, true);
        out.position[1] = dv.getFloat32(56, true);
        out.position[2] = dv.getFloat32(60, true);
        out.direction[0] = dv.getFloat32(64, true);
        out.direction[1] = dv.getFloat32(68, true);
        out.direction[2] = dv.getFloat32(72, true);
        out.range = dv.getFloat32(76, true);
        out.falloff = dv.getFloat32(80, true);
        out.att0 = dv.getFloat32(84, true);
        out.att1 = dv.getFloat32(88, true);
        out.att2 = dv.getFloat32(92, true);
        out.theta = dv.getFloat32(96, true);
        out.phi = dv.getFloat32(100, true);
    }

    /** A reusable, zero-filled FfpLightInput record for the light-gather pool. */
    private static emptyLight(): FfpLightInput {
        const c = (): FfpColor => ({ r: 0, g: 0, b: 0, a: 0 });
        return {
            type: 0, diffuse: c(), specular: c(), ambient: c(),
            position: [0, 0, 0], direction: [0, 0, 0],
            range: 0, falloff: 0, att0: 0, att1: 0, att2: 0, theta: 0, phi: 0,
        };
    }

    /**
     * Write the inverse-transpose of `wv`'s upper-left 3×3 into `this.ffpNormalMatrix`, widened
     * to a 4×4 (D3D row-major, translation dropped — normals carry w = 0). This is the matrix
     * FFP normals are transformed by; worldView itself is only correct for rigid transforms.
     * A singular 3×3 has no inverse-transpose, so fall back to the raw 3×3 rather than emit the
     * infinities the closed-form division would produce.
     */
    private buildNormalMatrix(wv: Float32Array): Float32Array {
        const n = this.ffpNormalMatrix;
        const a00 = wv[0], a01 = wv[1], a02 = wv[2];
        const a10 = wv[4], a11 = wv[5], a12 = wv[6];
        const a20 = wv[8], a21 = wv[9], a22 = wv[10];
        // Cofactor matrix / det == transpose(inverse(A)) in the same row-major convention.
        const c00 = a11 * a22 - a12 * a21;
        const c01 = a12 * a20 - a10 * a22;
        const c02 = a10 * a21 - a11 * a20;
        const det = a00 * c00 + a01 * c01 + a02 * c02;
        n.fill(0);
        n[15] = 1;
        if (det === 0 || !Number.isFinite(det)) {
            n[0] = a00; n[1] = a01; n[2] = a02;
            n[4] = a10; n[5] = a11; n[6] = a12;
            n[8] = a20; n[9] = a21; n[10] = a22;
            return n;
        }
        const inv = 1 / det;
        n[0] = c00 * inv;
        n[1] = c01 * inv;
        n[2] = c02 * inv;
        n[4] = (a02 * a21 - a01 * a22) * inv;
        n[5] = (a00 * a22 - a02 * a20) * inv;
        n[6] = (a01 * a20 - a00 * a21) * inv;
        n[8] = (a01 * a12 - a02 * a11) * inv;
        n[9] = (a02 * a10 - a00 * a12) * inv;
        n[10] = (a00 * a11 - a01 * a10) * inv;
        return n;
    }

    /**
     * Which colour/normal components the current vertex format actually carries.
     *
     * ONE definition, because the shader and the frame capture must not be able to disagree:
     * the declaration scan applies the same two rules buildShaderFromDecl does — usage +
     * usageIndex, and the caller's `streamAllow` filter. Without the filter a colour living in
     * a stream the pipeline does not declare would resolve to COLOR1 here while the shader has
     * no colour attribute for it, and the material colour would silently drop out.
     */
    private resolveFfpVertexColors(
        streamAllow: ReadonlySet<number> | null = null,
    ): { hasColor: boolean; hasSpecular: boolean; hasNormal: boolean } {
        const decl = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
        if (decl && decl.length > 0) {
            // Predicate rather than a filtered copy — this runs per draw.
            const has = (usage: number, index: number): boolean => decl.some(e =>
                e.usage === usage && e.usageIndex === index
                && (streamAllow === null || streamAllow.has(e.stream)));
            return {
                hasColor: has(DECLUSAGE_COLOR_FFP, 0),
                hasSpecular: has(DECLUSAGE_COLOR_FFP, 1),
                hasNormal: has(DECLUSAGE_NORMAL_FFP, 0),
            };
        }
        const fvf = this.stateTracker.getFVF();
        return {
            hasColor: (fvf & D3DFVF_DIFFUSE) !== 0,
            hasSpecular: (fvf & D3DFVF_SPECULAR) !== 0,
            hasNormal: (fvf & D3DFVF_NORMAL) !== 0,
        };
    }

    /**
     * Resolve an effective material colour source: a vertex-colour source (COLOR1/COLOR2)
     * degrades to MATERIAL when D3DRS_COLORVERTEX is off or that vertex colour is absent.
     * Resolving on the CPU keeps the shader's select() honest without needing the FVF there.
     */
    private effectiveColorSource(rsSource: number, colorVertex: boolean, hasColor: boolean, hasSpecular: boolean): number {
        if (!colorVertex) return D3DMCS_MATERIAL;
        if (rsSource === D3DMCS_COLOR1 && !hasColor) return D3DMCS_MATERIAL;
        if (rsSource === D3DMCS_COLOR2 && !hasSpecular) return D3DMCS_MATERIAL;
        return rsSource;
    }

    /**
     * The active texture stages with D3D's defaults applied, into the reused pool.
     *
     * The SINGLE resolver: the shader uniform, the gap census and the frame capture all read
     * its output, so none of them can disagree about what an unset state means. `has()` rather
     * than a `?? 0` read, because an explicitly-set 0 (COLOROP=DISABLE) is not "unset".
     * D3DTSS_TEXCOORDINDEX / D3DTSS_TEXTURETRANSFORMFLAGS stay RAW — the TCI_* generator in the
     * high bits and the D3DTTFF count/PROJECTED bits are decoded in the shader, so no CPU-side
     * pre-resolution can drop a mode. TEXCOORDINDEX defaults to the stage's own index.
     */
    private resolveFfpStages(stageCount: number): FfpResolvedStage[] {
        const stages = this.ffpStages;
        stages.length = 0;
        // Hoisted out of the loop: this runs per draw, and closures allocated per stage would
        // undo what the pooled stage records buy.
        const ts = (s: number, type: number, dflt: number): number =>
            this.textureStageStates.has(this.makeStageStateKey(s, type))
                ? this.getTextureStageState(s, type) : dflt;
        // With no texture bound, a D3DTA_TEXTURE selector resolves to D3DTA_DIFFUSE (MSDN
        // D3DTSS_COLORARG1: the default argument when no texture is set); modifiers kept.
        const tsArg = (s: number, noTex: boolean, type: number, dflt: number): number => {
            const v = ts(s, type, dflt);
            return noTex && (v & 0xf) === 2 ? (v & ~0xf) >>> 0 : v;
        };
        for (let s = 0; s < Math.max(1, stageCount); s++) {
            const noTex = this.stateTracker.getTexture(s) === null;
            // Stage 0 defaults to MODULATE/SELECTARG1; every stage above it defaults to
            // DISABLE, and collapses to DISABLE outright once its texture goes away —
            // sampling the fallback white would MODULATE the base texture by a blank stage.
            const first = s === 0;
            const st = this.ffpStagePool[s] ??= D3D9Device.emptyStage();
            st.colorOp = first
                ? ts(s, D3DTSS_COLOROP, 4)
                : (noTex ? D3DTOP_DISABLE : ts(s, D3DTSS_COLOROP, D3DTOP_DISABLE));
            st.colorArg1 = tsArg(s, noTex, 2, 2);
            st.colorArg2 = tsArg(s, noTex, 3, 1);
            st.alphaOp = ts(s, D3DTSS_ALPHAOP, first ? 2 : D3DTOP_DISABLE);
            st.alphaArg1 = tsArg(s, noTex, 5, 2);
            st.alphaArg2 = tsArg(s, noTex, 6, 1);
            // ARG0 is the third operand of MULTIPLYADD/LERP; every other op ignores it.
            st.colorArg0 = tsArg(s, noTex, D3DTSS_COLORARG0, 1);
            st.alphaArg0 = tsArg(s, noTex, D3DTSS_ALPHAARG0, 1);
            st.resultArg = ts(s, D3DTSS_RESULTARG, 1); // default D3DTA_CURRENT
            st.texCoordIndex = ts(s, D3DTSS_TEXCOORDINDEX, s);
            st.texTransformFlags = ts(s, D3DTSS_TEXTURETRANSFORMFLAGS, 0);
            stages.push(st);
        }
        return stages;
    }

    /** A reusable, zero-filled stage record for the resolved-stage pool. */
    private static emptyStage(): FfpResolvedStage {
        return {
            colorOp: 0, colorArg1: 0, colorArg2: 0, colorArg0: 0,
            alphaOp: 0, alphaArg1: 0, alphaArg2: 0, alphaArg0: 0,
            resultArg: 0, texCoordIndex: 0, texTransformFlags: 0,
        };
    }

    /**
     * Build the per-frame FFP uniform block (viewport + MVP + worldView + full lighting state)
     * into the reused scratch and return it. Mirrors how the FFP path already snapshots a single
     * transform per frame — the lighting state (material/lights/render-states) is read at submit.
     */
    private buildFfpUniformBlock(
        vpW: number,
        vpH: number,
        stages: FfpResolvedStage[] = this.resolveFfpStages(this.activeStageCount()),
        /** The stream restriction the pipeline was built with — see resolveFfpVertexColors. */
        streamAllow: ReadonlySet<number> | null = null,
    ): Float32Array {
        const rs = (s: number) => this.stateTracker.getRenderState(s);

        const fvf = this.stateTracker.getFVF();
        const decl = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
        const { hasColor, hasSpecular, hasNormal: hasNormalDecl } = this.resolveFfpVertexColors(streamAllow);
        // Pre-transformed position — decides which fog the FFP runs (see resolveFfpFogMode).
        // Same POSITIONT-or-POSITION+FLOAT4 rule buildShaderFromDecl uses.
        const isRHW = decl && decl.length > 0
            ? decl.some(e => e.usage === DECLUSAGE_POSITIONT_FFP
                || (e.usage === DECLUSAGE_POSITION_FFP && e.type === 3))
            : (fvf & D3DFVF_POSITION_MASK) === D3DFVF_XYZRHW;
        // A pre-transformed vertex is never lit, so it never has a usable normal either —
        // the shader builders drop the normal attribute for XYZRHW.
        const hasNormal = hasNormalDecl && !isRHW;

        const colorVertex = rs(D3DRS_COLORVERTEX) !== 0;

        // Gather enabled lights in ascending index order (D3D iterates by light index).
        const enabled = this.ffpEnabledIdx;
        enabled.length = 0;
        for (const [idx, on] of this.lightEnables) {
            if (on !== 0) enabled.push(idx);
        }
        enabled.sort((a, b) => a - b);
        const lights = this.ffpLights;
        lights.length = 0;
        for (const idx of enabled) {
            const raw = this.lights.get(idx);
            if (!raw) continue;
            const slot = this.ffpLightPool[lights.length] ??= D3D9Device.emptyLight();
            this.parseLightInto(raw, slot);
            // D3D lets an app set and enable a light with a bogus type; it just never
            // contributes. Dropping it here keeps the shader's type dispatch total.
            if (slot.type < D3DLIGHT_POINT || slot.type > D3DLIGHT_DIRECTIONAL) continue;
            lights.push(slot);
            if (lights.length >= FFP_MAX_LIGHTS) break;
        }

        // FFP user clip planes (device-global). Pack the enabled/stored planes into the reused
        // scratch; disabled slots stay zero and are ignored by the shader (clipPlaneEnable gate).
        // clipPlaneEnable defaults to 0 (D3DRS_CLIPPLANEENABLE unset) → clipping fully inert.
        const clipPlaneEnable = rs(D3DRS_CLIPPLANEENABLE) >>> 0;
        this.ffpClipPlanesScratch.fill(0);
        if (clipPlaneEnable !== 0) {
            for (const [index, plane] of this.clipPlanes.entries()) {
                if (index >= 6 || plane.length < 4) continue;
                this.ffpClipPlanesScratch.set(plane.subarray(0, 4), index * 4);
            }
        }

        const ambientVal = rs(D3DRS_AMBIENT) >>> 0;
        // One worldView for both the uniform and the normal matrix — multiplyMatrices allocates.
        const worldView = this.stateTracker.getWorldView();
        const params: FfpUniformParams = {
            viewportW: vpW,
            viewportH: vpH,
            mvp: this.stateTracker.getMVP(),
            worldView,
            normalMatrix: this.buildNormalMatrix(worldView),
            view: this.stateTracker.getViewMatrix(),
            world: this.stateTracker.getWorldMatrix(),
            clipPlanes: this.ffpClipPlanesScratch,
            clipPlaneEnable,
            material: this.parseMaterial(),
            globalAmbient: {
                r: ((ambientVal >> 16) & 0xff) / 255,
                g: ((ambientVal >> 8) & 0xff) / 255,
                b: (ambientVal & 0xff) / 255,
                a: ((ambientVal >> 24) & 0xff) / 255,
            },
            lightingEnabled: rs(D3DRS_LIGHTING) !== 0,
            specularEnable: rs(D3DRS_SPECULARENABLE) !== 0,
            localViewer: rs(D3DRS_LOCALVIEWER) !== 0,
            diffuseSrc: this.effectiveColorSource(rs(D3DRS_DIFFUSEMATERIALSOURCE), colorVertex, hasColor, hasSpecular),
            ambientSrc: this.effectiveColorSource(rs(D3DRS_AMBIENTMATERIALSOURCE), colorVertex, hasColor, hasSpecular),
            specularSrc: this.effectiveColorSource(rs(D3DRS_SPECULARMATERIALSOURCE), colorVertex, hasColor, hasSpecular),
            emissiveSrc: this.effectiveColorSource(rs(D3DRS_EMISSIVEMATERIALSOURCE), colorVertex, hasColor, hasSpecular),
            hasNormal,
            normalizeNormals: rs(D3DRS_NORMALIZENORMALS) !== 0,
            lights,
            stages,
            texMatrices: this.stateTracker.getTextureMatrices(),
            tfactor: (() => {
                const tf = rs(60) >>> 0; // D3DRS_TEXTUREFACTOR (tracker seeds the white default)
                return { r: ((tf >> 16) & 0xff) / 255, g: ((tf >> 8) & 0xff) / 255, b: (tf & 0xff) / 255, a: ((tf >> 24) & 0xff) / 255 };
            })(),
            fogColor: (() => {
                const fc = rs(D3DRS_FOGCOLOR) >>> 0;
                return { r: ((fc >> 16) & 0xff) / 255, g: ((fc >> 8) & 0xff) / 255, b: (fc & 0xff) / 255, a: 1 };
            })(),
            fogStart: this.rsFloat(rs(D3DRS_FOGSTART)),
            fogEnd: this.rsFloat(rs(D3DRS_FOGEND)),
            fogDensity: this.rsFloat(rs(D3DRS_FOGDENSITY)),
            fogMode: resolveFfpFogMode(
                rs(D3DRS_FOGENABLE), rs(D3DRS_FOGTABLEMODE), rs(D3DRS_FOGVERTEXMODE), isRHW, hasSpecular,
            ),
        };
        packFfpUniforms(this.ffpUniformBlock, params);
        return this.ffpUniformBlock;
    }

    /** True once the current frame has recorded work (clear/draws/uploads).
     *  Lets HLE callers know a fill-as-clear would be reordered before pending draws. */
    hasPendingWork(): boolean {
        return this.commandRecorder.hasWork();
    }

    clear(flags: number, color: number, z: number, stencil: number): number {
        if (this.gpuGone) return 0;
        d3d9PerfInc("clear");
        const clearColor = d3dColorToGpu(color);
        this.commandRecorder.setClear(clearColor, z, flags);
        if (frameCapture.isCapturing()) {
            const size = this.getCurrentTargetSize();
            frameCapture.recordClearRaw(flags, color, z, stencil,
                { surfacePtr: this.captureRtId(), width: size.w, height: size.h });
        }

        // Update frame snapshot counter
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.clears++;
        }

        // Clear GDI overlay when D3DCLEAR_TARGET is set
        // In real D3D9, Clear() clears the entire backbuffer including any GDI content.
        // Applications that use GetDC() redraw their GDI content every frame after Clear().
        // Not clearing the overlay causes text to accumulate (draw over itself),
        // which destroys antialiasing and causes "rough edges".
        const D3DCLEAR_TARGET = 1;
        if (flags & D3DCLEAR_TARGET) {
            const gdiContext = this.getGdiContext();
            if (gdiContext) {
                gdiContext.clearOverlay();
            }
        }

        return 0;
    }

    beginScene(): number {
        return 0;
    }

    endScene(): number {
        return 0;
    }

    reset(pPresentationParameters: number, mem: Uint8Array): number {
        if (!pPresentationParameters) return 0x8876086c; // D3DERR_INVALIDCALL

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const width = Math.max(1, view.getUint32(pPresentationParameters + 0, true) || 800);
        const height = Math.max(1, view.getUint32(pPresentationParameters + 4, true) || 600);
        const windowed = view.getUint32(pPresentationParameters + 32, true);
        const enableAutoDepthStencil = view.getUint32(pPresentationParameters + 36, true);
        const autoDepthStencilFormat = view.getUint32(pPresentationParameters + 40, true);
        // Reset re-declares the swap interval (PresentationInterval @ +52) like every other
        // present parameter — an in-game vsync toggle is exactly this call.
        this.setPresentationInterval(view.getUint32(pPresentationParameters + 52, true));

        Logger.log(
            LogCategory.D3D9,
            `Reset(${width}x${height}, windowed=${windowed}, depth=${enableAutoDepthStencil}, ` +
            `depthFmt=${autoDepthStencilFormat}, interval=${this.presentInterval})`,
        );

        // Only a FULLSCREEN device sets the display mode. A windowed device's backbuffer is a
        // size inside the desktop; publishing it would make SM_CXSCREEN report the window.
        System.getInstance().requestHostResize(width, height, { modeSet: windowed === 0 });
        this.viewport = { x: 0, y: 0, width, height, minZ: 0, maxZ: 1 };
        this.endScene();
        return 0; // D3D_OK
    }

    setViewport(pViewport: number, mem: Uint8Array): number {
        if (!pViewport || !isValidAddress(mem, pViewport, 24)) return 0x8876086c;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const targetW = this.viewport.width || 800;
        const targetH = this.viewport.height || 600;
        this.viewport = sanitizeViewport({
            x: view.getUint32(pViewport + 0, true),
            y: view.getUint32(pViewport + 4, true),
            width: view.getUint32(pViewport + 8, true),
            height: view.getUint32(pViewport + 12, true),
            minZ: view.getFloat32(pViewport + 16, true),
            maxZ: view.getFloat32(pViewport + 20, true),
        }, targetW, targetH);
        return 0;
    }

    getViewport(): typeof this.viewport {
        return this.viewport;
    }

    // Scissor state is tracked but not yet applied to draws (needs
    // D3DRS_SCISSORTESTENABLE plumbing into the render pass).
    private scissorRect = { left: 0, top: 0, right: 0, bottom: 0 };

    setScissorRect(left: number, top: number, right: number, bottom: number): void {
        this.scissorRect = { left, top, right, bottom };
    }

    getScissorRect(): { left: number; top: number; right: number; bottom: number } {
        return this.scissorRect;
    }

    /** Harness CaptureBus producer for D3D9. D3D9's programmable path has
     *  no FFP render-state arrays, so it records a backend-tagged minimal draw
     *  (primitive/counts/textured/programmable) into the one schema. Placed before
     *  the trilist guard so non-trilist draws are still counted. Gated → zero cost.
     *
     *  `verts` (the draw's stream-0 bytes) is what makes a capture answer "is the
     *  GEOMETRY wrong" rather than only "which states were set": it fills the
     *  schema's vertexType/isRHW/firstVertices/mvp/viewport. Without it a d3d9
     *  capture cannot distinguish a pre-transformed screen-space draw from an
     *  object-space one — the two need opposite reasoning about every artifact. */
    /** Capture identity of the CURRENT render target: the RT texture's guest handle, or 0 for
     *  the backbuffer. `currentRtIndex` cannot be reported directly — index 0 is a perfectly
     *  ordinary RT (SS2's UI layer is exactly that), so `currentRtIndex ?? 0` collapses it onto
     *  the backbuffer and a capture then swears every draw went to the screen. */
    private captureRtId(): number {
        const idx = this.currentRtIndex;
        if (idx === null) return 0;
        return (this.textures.getHandle(idx) >>> 0) || 0;
    }

    // ── Draw-scrub bisect (the D3D9 twin of the DDraw executor's drawScrubMax) ──────────
    // "Which draw painted / erased this?" is not answerable from a capture: it lists what was
    // submitted, not what each one did to the target. Rendering only draws [min, max] of every
    // frame turns that into a bisect over the picture itself.
    private scrubMin = 0;
    private scrubMax = -1;          // < 0 → inert
    private scrubFrameSerial = -1;
    private scrubDrawIndex = 0;
    /** Draws the scrub counted in the last completed frame — the instrument's own
     *  liveness signal, so "the flag does nothing" is distinguishable from "no draws". */
    private scrubLastFrameDraws = 0;

    setDrawScrub(min: number, max: number): void {
        this.scrubMin = min | 0;
        this.scrubMax = max | 0;
    }

    getDrawScrub(): { min: number; max: number; lastFrameDraws: number } {
        return { min: this.scrubMin, max: this.scrubMax, lastFrameDraws: this.scrubLastFrameDraws };
    }

    /**
     * No GPU device (lost, recreation in flight). Every draw/clear/present path dereferences
     * `backend.getDevice()!`, so without this a lost device turns each of them into a TypeError
     * thrown out of a guest thunk. The work is dropped instead: the frame is gone either way,
     * and the caches it would have populated must not be rebuilt onto a device that is about to
     * be replaced.
     */
    private get gpuGone(): boolean {
        return this.backend.getDevice() === null;
    }

    /** Count this draw and report whether the scrub cuts it. Counted BEFORE the test so the
     *  numbering matches the frame capture's `index` (which counts every draw the guest
     *  issued, kept or not) — a cut and a capture index name the same draw by construction.
     *  The frame boundary is the frame capture's producer boundary for the same reason. */
    private scrubbedOut(): boolean {
        if (this.scrubMax < 0) return false;
        const serial = frameCapture.getFrameBoundarySerial();
        if (serial !== this.scrubFrameSerial) {
            this.scrubFrameSerial = serial;
            this.scrubLastFrameDraws = this.scrubDrawIndex;
            this.scrubDrawIndex = 0;
        }
        const i = this.scrubDrawIndex++;
        return i < this.scrubMin || i > this.scrubMax;
    }

    /**
     * Per-stage combiner arguments + the texture each stage samples, for `captureFrame`.
     *
     * Reports the RESOLVED stages (resolveFfpStages), so a row shows the op the shader ran
     * rather than the 0 an unset state reads as. `alphalessFormat` is the flag the shader uses
     * to read a format's alpha as 1.0: whether a texture's alpha is real or substituted decides
     * an alpha-blended draw's visibility.
     */
    private captureStageArgs(): Array<Record<string, number | string | boolean | null>> {
        const out: Array<Record<string, number | string | boolean | null>> = [];
        const stages = this.resolveFfpStages(this.activeStageCount());
        for (let s = 0; s < stages.length; s++) {
            const st = stages[s]!;
            const ti = this.stateTracker.getTexture(s);
            const fmt = ti !== null ? this.textures.getFormat(ti) : null;
            out.push({
                stage: s,
                colorOp: st.colorOp,
                colorArg1: st.colorArg1,
                colorArg2: st.colorArg2,
                colorArg0: st.colorArg0,
                alphaOp: st.alphaOp,
                alphaArg1: st.alphaArg1,
                alphaArg2: st.alphaArg2,
                alphaArg0: st.alphaArg0,
                texCoordIndex: st.texCoordIndex,
                texTransformFlags: st.texTransformFlags,
                texture: ti !== null ? `0x${this.textures.getHandle(ti).toString(16)}` : null,
                d3dFormat: fmt,
                alphalessFormat: fmt !== null ? D3D_ALPHALESS_FORMATS.has(fmt) : null,
            });
        }
        return out;
    }

    /**
     * The inputs FFP lighting actually computes from, for `captureFrame`.
     *
     * Geometry whose vertex format carries no COLOR1/COLOR2 has no other source of colour:
     * every channel comes from the material, the lights and the ambient. A black surface there
     * is arithmetic, not a render bug, and telling the two apart needs the operands.
     */
    private captureLighting(streamAllow: ReadonlySet<number> | null = null): Record<string, unknown> {
        const rs = (n: number): number => this.stateTracker.getRenderState(n);
        const m = this.parseMaterial();
        const c = (x: FfpColor): number[] => [x.r, x.g, x.b, x.a].map((v) => Math.round(v * 1000) / 1000);
        const { hasColor, hasSpecular } = this.resolveFfpVertexColors(streamAllow);
        const colorVertex = rs(D3DRS_COLORVERTEX) !== 0;
        // Enabled AND actually supplied: LightEnable on an index the app never SetLight'd
        // contributes nothing, so counting the enable bits alone would overstate the light rig.
        let enabled = 0;
        for (const [idx, on] of this.lightEnables) if (on !== 0 && this.lights.has(idx)) enabled++;
        return {
            enabled: rs(D3DRS_LIGHTING) !== 0,
            specularEnable: rs(D3DRS_SPECULARENABLE),
            enabledLights: enabled,
            globalAmbientArgb: rs(D3DRS_AMBIENT) >>> 0,
            matDiffuse: c(m.diffuse),
            matAmbient: c(m.ambient),
            matSpecular: c(m.specular),
            matEmissive: c(m.emissive),
            power: m.power,
            // Resolved sources, not the raw render states: a source naming a vertex colour the
            // FVF does not carry silently becomes MATERIAL, and that substitution is the whole
            // question for a mesh with no vertex colours.
            diffuseSrc: this.effectiveColorSource(rs(D3DRS_DIFFUSEMATERIALSOURCE), colorVertex, hasColor, hasSpecular),
            specularSrc: this.effectiveColorSource(rs(D3DRS_SPECULARMATERIALSOURCE), colorVertex, hasColor, hasSpecular),
            hasVertexColor: hasColor,
            hasVertexSpecular: hasSpecular,
        };
    }

    private captureDrawIfArmed(
        primitiveType: number,
        primitiveCount: number,
        verts?: { data: Uint8Array; offset: number; stride: number; count: number },
        /** The stream restriction this draw's pipeline will be built with, when the caller
         *  already knows it — so the reported colour sources match the shader's. */
        streamAllow: ReadonlySet<number> | null = null,
    ): void {
        if (!frameCapture.isCapturing()) return;
        const stage0 = this.stateTracker.getTexture(0);
        const stage1 = this.stateTracker.getTexture(1);
        const rs = (n: number): number => this.stateTracker.getRenderState(n);
        const rt = this.currentRtIndex;
        const size = this.getCurrentTargetSize();
        const fvf = this.stateTracker.getFVF();
        const isRhw = (fvf & D3DFVF_POSITION_MASK) === D3DFVF_XYZRHW;
        // Every field here is READ, not defaulted. D3D9 keeps one flat render-state array, so
        // the depth/blend/alpha/cull/lighting/fog states are as available as on the FFP path;
        // reporting them as schema zeros made a capture say "depth test off on every draw".
        frameCapture.recordRawDraw({
            backend: "d3d9",
            primitiveType,
            primitiveTypeName: `D3DPT(${primitiveType})`,
            vertexCount: verts ? verts.count : primitiveCount * 3,
            programmable: (this as any).isProgrammable?.() ?? false,
            derivedUseTexture: stage0 != null,
            vertexType: fvf,
            isRHW: isRhw,
            ...(verts ? { firstVertices: this.decodeFirstVertices(verts, fvf), srcStride: verts.stride } : {}),
            mvp: Array.from(this.stateTracker.getMVP()),
            viewport: { ...this.viewport },
            rtSurfacePtr: this.captureRtId(),
            rtWidth: size.w,
            rtHeight: size.h,
            zEnable: rs(D3DRS_ZENABLE),
            zWrite: rs(D3DRS_ZWRITEENABLE),
            zFunc: rs(D3DRS_ZFUNC),
            alphaBlendEnabled: rs(D3DRS_ALPHABLENDENABLE),
            srcBlend: rs(D3DRS_SRCBLEND),
            dstBlend: rs(D3DRS_DESTBLEND),
            alphaTestEnabled: rs(D3DRS_ALPHATESTENABLE),
            alphaFunc: rs(D3DRS_ALPHAFUNC),
            alphaRef: rs(D3DRS_ALPHAREF),
            cullMode: rs(D3DRS_CULLMODE),
            lightingEnabled: rs(D3DRS_LIGHTING),
            fogEnabled: rs(D3DRS_FOGENABLE),
            fog: {
                enable: rs(D3DRS_FOGENABLE),
                tableMode: rs(D3DRS_FOGTABLEMODE),
                vertexMode: rs(D3DRS_FOGVERTEXMODE),
                colorArgb: rs(D3DRS_FOGCOLOR) >>> 0,
                start: this.rsFloat(rs(D3DRS_FOGSTART)),
                end: this.rsFloat(rs(D3DRS_FOGEND)),
                density: this.rsFloat(rs(D3DRS_FOGDENSITY)),
                specularEnable: rs(D3DRS_SPECULARENABLE),
            },
            derivedShouldBlend: rs(D3DRS_ALPHABLENDENABLE) !== 0,
            colorOp: this.getTextureStageState(0, 1),
            alphaOp: this.getTextureStageState(0, 4),
            colorArg1: this.getTextureStageState(0, 2),
            colorArg2: this.getTextureStageState(0, 3),
            alphaArg1: this.getTextureStageState(0, 5),
            alphaArg2: this.getTextureStageState(0, 6),
            // Two states that delete a draw's pixels with nothing else to show for it: a zero
            // write mask, and an enabled user clip plane.
            colorWriteEnable: rs(168),
            clipPlaneEnable: rs(D3DRS_CLIPPLANEENABLE),
            // The stage combiner's ARGUMENTS. An op alone does not say where a channel's value
            // came from: SELECTARG1 is the texture on one draw and the vertex colour on the
            // next, and "the alpha reaching the blender" is exactly that distinction.
            stages: this.captureStageArgs(),
            lighting: this.captureLighting(streamAllow),
            // The bound stages as GUEST HANDLES — the identity dumpTexture/textures() take, so a
            // capture row leads straight to the pixels. Stage 1 is called out because the FFP
            // path renders stage 0 only: a draw with a stage-1 texture bound is one whose second
            // stage we silently drop (lightmap, detail) — invisible in the picture as anything
            // but "the lighting looks wrong".
            warnings: [
                ...(stage0 != null ? [`tex0 handle=0x${this.textures.getHandle(stage0).toString(16)}`] : []),
                ...(stage1 != null
                    ? [`stage1 texture bound (handle=0x${this.textures.getHandle(stage1).toString(16)}) — FFP renders stage 0 only`]
                    : []),
            ],
        });
    }

    /** First few stream-0 vertices of a draw, decoded through the FVF layout. Capture-only
     *  (never on a render path), so it allocates freely. Position is always at offset 0;
     *  everything after it moves with NORMAL/DIFFUSE/SPECULAR, so the offsets come from the
     *  one parseFvf() the pipeline and shader also use.
     *
     *  Honors `setWorkerFlag('__captureVertsMax', N)` like the DDraw producer: four vertices
     *  answer "what kind of draw is this", but "which draws cover this patch of screen" needs
     *  the whole mesh, and a capture that silently caps at 4 answers that question wrongly. */
    private decodeFirstVertices(
        verts: { data: Uint8Array; offset: number; stride: number; count: number },
        fvf: number,
    ): Array<{ x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number }> {
        const out: Array<{ x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number }> = [];
        const { data, offset, stride, count } = verts;
        if (stride <= 0) return out;
        const layout = parseFvf(fvf);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const cfgMax = ((globalThis as unknown as Record<string, unknown>).__captureVertsMax as number) >>> 0;
        const n = Math.min(count, cfgMax > 0 ? cfgMax : 4);
        for (let i = 0; i < n; i++) {
            const base = offset + i * stride;
            if (base + stride > data.byteLength) break;
            // The stream stride can be SMALLER than the FVF's packed size — resolvePipelineId
            // already takes max(arrayStride, streamStride) for exactly that reason — so an
            // FVF-derived offset is not guaranteed to sit inside this vertex. DataView throws
            // on an out-of-range read, and this is capture-gated: an unclamped read would kill
            // the very draw captureFrame() was armed to explain. Read only what fits.
            const end = Math.min(base + stride, data.byteLength);
            const fits = (off: number, size: number) => base + off + size <= end;
            const v: { x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number } = {
                x: view.getFloat32(base, true),
                y: view.getFloat32(base + 4, true),
                z: view.getFloat32(base + 8, true),
            };
            if (layout.hasRhw && fits(12, 4)) v.w = view.getFloat32(base + 12, true);
            if (layout.hasColor && fits(layout.colorOff, 4)) v.diffuse = view.getUint32(base + layout.colorOff, true);
            if (layout.hasTex && fits(layout.texOff, 8)) {
                v.u = view.getFloat32(base + layout.texOff, true);
                v.v = view.getFloat32(base + layout.texOff + 4, true);
            }
            out.push(v);
        }
        return out;
    }

    // ── Point sprites (D3DPT_POINTLIST) ───────────────────────────────────
    // Reinterpret a render-state DWORD as the IEEE-754 float it actually stores
    // (D3DRS_POINTSIZE / *_MIN / *_MAX / *_SCALE_* are floats bit-cast into the DWORD).
    private readonly _rsF32 = new Float32Array(1);
    private readonly _rsU32 = new Uint32Array(this._rsF32.buffer);
    private rsFloat(raw: number): number { this._rsU32[0] = raw >>> 0; return this._rsF32[0]; }
    /** Growable scratch for expanded point-sprite quad bytes (6 verts/point). */
    private psScratch: Uint8Array | null = null;

    /** Effective render-target size the RHW FFP shader maps against (u.viewport). */
    private getCurrentTargetSize(): { w: number; h: number } {
        const rt = this.currentRtIndex;
        if (rt !== null) return { w: this.textures.getWidth(rt), h: this.textures.getHeight(rt) };
        const s = this.backendExecutor.getCanvasSize();
        return { w: s.width, h: s.height };
    }

    /**
     * DirectX fixed-function POINT SPRITES for the D3D9 FFP path.
     *
     * WebGPU point-list only ever rasterizes 1px points, so each D3DPT_POINTLIST vertex is
     * expanded on the CPU into a screen-aligned, camera-facing quad (2 triangles) emitted in the
     * synthetic pre-transformed FVF (XYZRHW | DIFFUSE [| TEX1]); the existing RHW FFP shader then
     * passes the screen-space position straight through. Returns true when it handled the draw.
     *
     * Formulas verified against DXVK d3d9_fixed_function_vert.vert calculatePointSize():
     *   size      = per-vertex PSIZE (D3DFVF_PSIZE) else D3DRS_POINTSIZE (float-as-DWORD, dflt 1).
     *   attenuate = D3DRS_POINTSCALEENABLE → size = Vh·size / sqrt(A + B·De + C·De²), De = eye-space
     *               distance |worldView·pos|; A/B/C = D3DRS_POINTSCALE_A/B/C. Otherwise size is
     *               screen-space pixels directly (no Vh scale, no attenuation).
     *   clamp     = clamp(size, D3DRS_POINTSIZE_MIN, D3DRS_POINTSIZE_MAX), applied last.
     *   sprite UV = D3DRS_POINTSPRITEENABLE → per-corner [0,1]² (origin top-left); else the point's
     *               own UV is replicated to all 4 corners.
     * Only fixed-function (no active VS) point lists are expanded; anything else returns false so
     * the caller keeps its legacy behavior (a VS point list stays a no-op, as before — unchanged).
     */
    private tryDrawPointSprites(srcBytes: Uint8Array, count: number, stride: number, fvf: number): boolean {
        if (count <= 0) return false;
        if (this.isProgrammable()) return false;      // VS point lists unsupported → leave as-is
        if (this.activeVertexDecl > 0) return false;  // decl (non-FVF) point lists → leave as-is
        if (fvf === 0 || stride <= 0) return false;
        const device = this.backend.getDevice();
        if (!device) return false;
        if (srcBytes.byteLength < count * stride) return false;

        const posType = fvf & D3DFVF_POSITION_MASK;
        const isRhw = posType === D3DFVF_XYZRHW;
        const hasNormal = !isRhw && (fvf & D3DFVF_NORMAL) !== 0;
        const hasPsize = (fvf & D3DFVF_PSIZE) !== 0;
        const hasColor = (fvf & D3DFVF_DIFFUSE) !== 0;
        const hasSpecular = (fvf & D3DFVF_SPECULAR) !== 0;
        const srcHasTex = (fvf & D3DFVF_TEX1) !== 0;

        const rs = (s: number) => this.stateTracker.getRenderState(s);
        const spriteEnable = rs(D3DRS_POINTSPRITEENABLE) !== 0;
        const scaleEnable = rs(D3DRS_POINTSCALEENABLE) !== 0;
        // Emit UVs when the game samples a texture on stage 0 or asked for generated sprite coords.
        const emitTex = srcHasTex || spriteEnable || this.stateTracker.getTexture(0) !== null;

        // Source component offsets (D3D FVF order: pos, [normal], [psize], [diffuse], [specular], [uv0]).
        const posBytes = isRhw ? 16 : 12;
        let off = posBytes + (hasNormal ? 12 : 0);
        const psizeOff = off; if (hasPsize) off += 4;
        const diffuseOff = off; if (hasColor) off += 4;
        if (hasSpecular) off += 4;
        const uvOff = off;

        // POINTSIZE / *_MIN / *_MAX are floats bit-cast into the DWORD; the state tracker seeds
        // the D3D defaults (1.0/1.0/8192.0) so an explicit 0.0f is honored, not read as "unset".
        const sizeRs = this.rsFloat(rs(D3DRS_POINTSIZE));
        const sizeMin = this.rsFloat(rs(D3DRS_POINTSIZE_MIN));
        const sizeMax = this.rsFloat(rs(D3DRS_POINTSIZE_MAX));
        const scaleA = this.rsFloat(rs(D3DRS_POINTSCALE_A));
        const scaleB = this.rsFloat(rs(D3DRS_POINTSCALE_B));
        const scaleC = this.rsFloat(rs(D3DRS_POINTSCALE_C));

        const { w: vpW, h: vpH } = this.getCurrentTargetSize();
        if (vpW <= 0 || vpH <= 0) return false;
        const M = isRhw ? null : this.stateTracker.getMVP();
        const WV = (!isRhw && scaleEnable) ? this.stateTracker.getWorldView() : null;

        // Synthetic output FVF + its packed stride (parseFvf layout: XYZRHW=16, DIFFUSE=4, TEX1=8).
        const outFvf = D3DFVF_XYZRHW | D3DFVF_DIFFUSE | (emitTex ? D3DFVF_TEX1 : 0);
        const outStride = emitTex ? 28 : 20;
        const outVerts = count * 6;
        const outBytes = outVerts * outStride;
        if (!this.psScratch || this.psScratch.byteLength < outBytes) this.psScratch = new Uint8Array(outBytes);
        const out = this.psScratch;
        const src = new DataView(srcBytes.buffer, srcBytes.byteOffset, srcBytes.byteLength);
        const dst = new DataView(out.buffer, out.byteOffset, out.byteLength);

        for (let i = 0; i < count; i++) {
            const b = i * stride;
            const px = src.getFloat32(b, true);
            const py = src.getFloat32(b + 4, true);
            const pz = src.getFloat32(b + 8, true);

            // Screen-space center (sx,sy in px) + depth (ndcZ in [0,1]) + eye distance De.
            let sx: number, sy: number, ndcZ: number, de = 1.0;
            if (isRhw) {
                sx = px; sy = py; ndcZ = pz; // already pre-transformed to screen space
            } else {
                // clip = pos · M (D3D row-vector × row-major), matching the FFP shader's u.mvp*pos.
                const cx = M![0] * px + M![4] * py + M![8] * pz + M![12];
                const cy = M![1] * px + M![5] * py + M![9] * pz + M![13];
                const cz = M![2] * px + M![6] * py + M![10] * pz + M![14];
                let cw = M![3] * px + M![7] * py + M![11] * pz + M![15];
                if (cw === 0) cw = 1e-6;
                const ndcX = cx / cw, ndcY = cy / cw;
                ndcZ = cz / cw;
                sx = (ndcX * 0.5 + 0.5) * vpW;
                sy = (0.5 - ndcY * 0.5) * vpH;
                if (WV) {
                    const ex = WV[0] * px + WV[4] * py + WV[8] * pz + WV[12];
                    const ey = WV[1] * px + WV[5] * py + WV[9] * pz + WV[13];
                    const ez = WV[2] * px + WV[6] * py + WV[10] * pz + WV[14];
                    de = Math.sqrt(ex * ex + ey * ey + ez * ez);
                }
            }

            let size = hasPsize ? src.getFloat32(b + psizeOff, true) : sizeRs;
            if (scaleEnable) {
                const denom = Math.max(scaleA + scaleB * de + scaleC * de * de, 1e-6);
                size = (vpH * size) / Math.sqrt(denom);
            }
            if (size < sizeMin) size = sizeMin;
            if (size > sizeMax) size = sizeMax;
            const half = size * 0.5;

            const color = hasColor ? src.getUint32(b + diffuseOff, true) : 0xffffffff;
            const u0 = srcHasTex ? src.getFloat32(b + uvOff, true) : 0.0;
            const v0 = srcHasTex ? src.getFloat32(b + uvOff + 4, true) : 0.0;

            for (let t = 0; t < 6; t++) {
                const c = PS_TRI[t];
                const o = (i * 6 + t) * outStride;
                dst.setFloat32(o, sx + PS_CX[c] * half, true);
                dst.setFloat32(o + 4, sy + PS_CY[c] * half, true);
                dst.setFloat32(o + 8, ndcZ, true);
                dst.setFloat32(o + 12, 1.0, true); // rhw
                dst.setUint32(o + 16, color, true);
                if (emitTex) {
                    dst.setFloat32(o + 20, spriteEnable ? PS_U[c] : u0, true);
                    dst.setFloat32(o + 24, spriteEnable ? PS_V[c] : v0, true);
                }
            }
        }

        // Upload the expanded quads to a pooled VB and record a triangle-list draw with the
        // synthetic-FVF pipeline (cull forced off). Same pooled-buffer flow as drawPrimitiveUP.
        const view = out.subarray(0, outBytes);
        if (!this.vbPool) this.vbPool = new DynamicVbPool(device);
        const gpuBuffer = this.vbPool.acquire(Math.max(16, outBytes));
        device.queue.writeBuffer(gpuBuffer, 0, view);

        const pipelineId = this.getPointSpritePipelineId(outFvf);
        const ffpStateIndex = this.captureFfpDrawState();
        this.commandRecorder.recordDraw({
            pipelineId, gpuBuffer, bufferOffset: 0, bufferSize: outBytes,
            vertexCount: outVerts, startVertex: 0,
            ffpStateIndex,
        });
        this.commandRecorder.registerPooledBuffer(gpuBuffer);
        this.drawCount += 1;
        this.frameSnapshot.drawCalls++;
        return true;
    }

    drawPrimitive(primitiveType: number, startVertex: number, primitiveCount: number): number {
        if (this.gpuGone) return d3d9DropDraw("drawPrimitive:deviceLost");
        d3d9PerfInc("drawPrimitive");
        if (frameCapture.isCapturing()) {
            const ss = this.stateTracker.getStreamSource();
            const vb = ss ? this.vertexBuffers.getData(ss.index) : null;
            this.captureDrawIfArmed(primitiveType, primitiveCount, ss && vb
                ? { data: vb, offset: ss.offset + startVertex * ss.stride, stride: ss.stride, count: primitiveCount * 3 }
                : undefined);
        }
        if (this.scrubbedOut()) return 0;
        if (primitiveType === D3DPT_POINTLIST) {
            const ss = this.stateTracker.getStreamSource();
            const vb = ss ? this.vertexBuffers.getData(ss.index) : null;
            if (ss && vb) {
                const off = ss.offset + startVertex * ss.stride;
                if (this.tryDrawPointSprites(vb.subarray(off), primitiveCount, ss.stride, this.stateTracker.getFVF())) return 0;
            }
            return 0;
        }
        if (primitiveType !== D3DPT_TRIANGLELIST) {
            return this.drawStreamAsTriangleList(primitiveType, startVertex, primitiveCount);
        }
        const streamSource = this.stateTracker.getStreamSource();
        if (!streamSource) return d3d9DropDraw("drawPrimitive:noStreamSource");

        const vbIndex = streamSource.index;
        const vbData = this.vertexBuffers.getData(vbIndex);
        if (!vbData) return d3d9DropDraw("drawPrimitive:noVertexData");

        const device = this.backend.getDevice()!;
        const gpuBuffer = this.uploadBufferVersion(vbIndex, vbData, "vb", device);

        // WASM arena. ONLY reachable for
        // D3DPT_TRIANGLELIST (the early-return above), so topology=0/forceCullNone=false,
        // matching the resolveProgrammablePipeline("triangle-list", false) call below.
        // Computed BEFORE pipeline resolution so a real-bypass hit (dbg.d3dWasmPath(true))
        // can skip the legacy string-key path entirely (see resolveProgrammablePipeline).
        let arenaKey: number | undefined;
        if (d3d9WasmArena.isInitialized()) {
            arenaKey = d3d9WasmArena.recordDraw(0, primitiveCount * 3, startVertex, streamSource.stride, false);
        }

        let pipelineId: number;
        let bindStateIndex: number | undefined;
        let ffpStateIndex: number | undefined;
        let extraStreams: StreamVertexBinding[] | undefined;
        if (this.isProgrammable()) {
            pipelineId = this.resolveProgrammablePipeline("triangle-list", false, undefined, arenaKey);
            if (pipelineId < 0) return d3d9DropDraw("drawIndexed:noPipeline");
            bindStateIndex = this.captureDrawState();
        } else {
            pipelineId = this.getPipelineId(streamSource.stride);
            ffpStateIndex = this.captureFfpDrawState();
            extraStreams = this.collectFfpExtraStreams();
        }
        this.commandRecorder.recordDraw({
            pipelineId,
            gpuBuffer,
            bufferOffset: streamSource.offset,
            bufferSize: this.vertexBuffers.getSize(vbIndex) - streamSource.offset,
            vertexCount: primitiveCount * 3,
            startVertex,
            bindStateIndex,
            ffpStateIndex,
            extraStreams,
        });
        this.drawCount += 1;

        // Cross-check is only meaningful in dual-run mode — in real-bypass mode
        // resolveProgrammablePipeline may have skipped the legacy path entirely, so
        // `pipelineId` no longer has an independent legacy value to compare against.
        if (arenaKey !== undefined && !isWasmPathEnabled()) {
            this.crossCheckArenaPipelineKey(arenaKey, pipelineId);
        }

        // Update frame snapshot for debug panel
        this.frameSnapshot.drawCalls++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = {
            api: "d3d9",
            primitiveType,
            numVerts: primitiveCount * 3,
            timestamp: performance.now(),
        };

        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.vertexBytes += this.vertexBuffers.getSize(vbIndex) - streamSource.offset;
        }

        return 0;
    }

    /**
     * How many source vertices a non-list primitive spans, how many the rewind emits, and the
     * WebGPU topology it becomes. Everything but D3DPT_TRIANGLELIST goes through the rewind:
     * WebGPU has no triangle fan at all, and strips (triangle or line) would otherwise need
     * their own pipeline topology on a path that already has to repack for extra streams.
     */
    private static convertedShape(primitiveType: number, primitiveCount: number):
        { srcVertexCount: number; finalVertexCount: number; topology: "triangle-list" | "line-list" } | null {
        switch (primitiveType) {
            case D3DPT_TRIANGLESTRIP:
            case D3DPT_TRIANGLEFAN:
                return { srcVertexCount: primitiveCount + 2, finalVertexCount: primitiveCount * 3, topology: "triangle-list" };
            case D3DPT_LINELIST:
                return { srcVertexCount: primitiveCount * 2, finalVertexCount: primitiveCount * 2, topology: "line-list" };
            case D3DPT_LINESTRIP:
                return { srcVertexCount: primitiveCount + 1, finalVertexCount: primitiveCount * 2, topology: "line-list" };
            default:
                return null;
        }
    }

    /** Fill `order` with the rewind permutation. `src` maps a primitive-relative position to a
     *  source VERTEX index — identity for a stream draw, the index buffer for an indexed one,
     *  so both paths share one definition of every primitive's winding. */
    private static fillConversionOrder(
        order: Uint32Array, primitiveType: number, primitiveCount: number, src: (i: number) => number,
    ): void {
        switch (primitiveType) {
            case D3DPT_TRIANGLEFAN:
                for (let i = 0; i < primitiveCount; i++) {
                    order[i * 3] = src(0); order[i * 3 + 1] = src(i + 1); order[i * 3 + 2] = src(i + 2);
                }
                return;
            case D3DPT_LINELIST:
                for (let i = 0; i < primitiveCount * 2; i++) order[i] = src(i);
                return;
            case D3DPT_LINESTRIP:
                for (let i = 0; i < primitiveCount; i++) { order[i * 2] = src(i); order[i * 2 + 1] = src(i + 1); }
                return;
            default: // D3DPT_TRIANGLESTRIP
                // An odd strip triangle is wound the other way, so the list form has to swap
                // a pair. Swap the LAST two, not the first: (v0,v2,v1) is the same cyclic
                // orientation as (v1,v0,v2) — identical facing — but keeps v_i first, and D3D
                // flat shading takes its colour from the triangle's FIRST vertex.
                for (let i = 0; i < primitiveCount; i++) {
                    const even = i % 2 === 0;
                    order[i * 3] = src(i);
                    order[i * 3 + 1] = src(even ? i + 1 : i + 2);
                    order[i * 3 + 2] = src(even ? i + 2 : i + 1);
                }
        }
    }

    /** Stream-source strip/fan/line primitives: rewind into a triangle or line LIST and draw
     *  via the same pooled-VB flow as drawPrimitiveUP. Sprite quads (AGS et al.) arrive as
     *  2-primitive strips on this path. */
    private drawStreamAsTriangleList(primitiveType: number, startVertex: number, primitiveCount: number): number {
        if (primitiveCount <= 0) return 0;
        const shape = D3D9Device.convertedShape(primitiveType, primitiveCount);
        if (!shape) return d3d9DropDraw(`strip:primType${primitiveType}`);
        const ss = this.stateTracker.getStreamSource();
        if (!ss || ss.stride <= 0) return d3d9DropDraw("strip:noStreamSource");
        const vb = this.vertexBuffers.getData(ss.index);
        if (!vb) return d3d9DropDraw("strip:noVertexData");
        const device = this.backend.getDevice();
        if (!device) return d3d9DropDraw("strip:noDevice");

        const stride = ss.stride;
        const { srcVertexCount, finalVertexCount, topology } = shape;
        const off = ss.offset + startVertex * stride;
        if (off + srcVertexCount * stride > vb.byteLength) return d3d9DropDraw("strip:vertexRangeOOB");
        const srcData = vb.subarray(off, off + srcVertexCount * stride);

        // The rewind is a permutation of source vertex indices. Expressing it as one order
        // array (instead of copying bytes inline) is what lets every stream the declaration
        // spans be rewound the SAME way — a second stream left in source order would pair
        // each triangle with another triangle's UVs.
        const order = this.ensureRewindOrder(finalVertexCount);
        D3D9Device.fillConversionOrder(order, primitiveType, primitiveCount, (i) => i);

        const finalData = this.ensureConversionBuffer(finalVertexCount * stride);
        gatherVertices(finalData, srcData, 0, order, finalVertexCount, stride);

        const extraStreams = this.expandExtraStreamsByOrder(order, finalVertexCount, startVertex);
        if (extraStreams === null) return d3d9DropDraw("strip:extraStreamUnreadable");
        return this.recordConvertedDraw(finalData, finalVertexCount, stride, topology, extraStreams);
    }

    /**
     * Indexed strip/fan/line → list: the INDEXED twin of drawStreamAsTriangleList.
     *
     * Our recorder only speaks list topologies, so an indexed strip/fan has to be rewound too
     * — engines that emit their world as indexed tri-strips (RenderWare) would otherwise lose
     * every such draw silently.
     *
     * Converting the INDICES (gathering vertices in list order) rather than re-topologizing on
     * the GPU keeps this on the proven pooled-buffer path, and reusing the same `order`
     * permutation keeps any extra streams paired with the vertices stream 0 supplies.
     */
    private drawIndexedStreamAsTriangleList(
        primitiveType: number,
        baseVertexIndex: number,
        startIndex: number,
        primitiveCount: number,
    ): number {
        if (primitiveCount <= 0) return 0;
        const shape = D3D9Device.convertedShape(primitiveType, primitiveCount);
        if (!shape) return d3d9DropDraw(`indexedStrip:primType${primitiveType}`);
        const ss = this.stateTracker.getStreamSource();
        if (!ss || ss.stride <= 0) return d3d9DropDraw("indexedStrip:noStreamSource");
        const vb = this.vertexBuffers.getData(ss.index);
        if (!vb) return d3d9DropDraw("indexedStrip:noVertexData");
        const ibIndex = this.stateTracker.getIndexSource();
        if (ibIndex === null) return d3d9DropDraw("indexedStrip:noIndexSource");
        const ibData = this.indexBuffers.getData(ibIndex);
        if (!ibData) return d3d9DropDraw("indexedStrip:noIndexData");

        const is16 = this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16;
        // Indices spanned == source vertices spanned: N+2 for a strip/fan, N+1 for a line
        // strip, 2N for a line list.
        const idxCount = shape.srcVertexCount;
        const idxBytes = is16 ? 2 : 4;
        const idxStart = startIndex * idxBytes;
        if (idxStart + idxCount * idxBytes > ibData.byteLength) return d3d9DropDraw("indexedStrip:indexRangeOOB");
        const idxView = new DataView(ibData.buffer, ibData.byteOffset, ibData.byteLength);
        const srcIndex = (i: number): number =>
            is16 ? idxView.getUint16(idxStart + i * 2, true) : idxView.getUint32(idxStart + i * 4, true);

        // Same rewind as the non-indexed path, but each entry is a source VERTEX index.
        const finalVertexCount = shape.finalVertexCount;
        const order = this.ensureRewindOrder(finalVertexCount);
        D3D9Device.fillConversionOrder(order, primitiveType, primitiveCount, srcIndex);

        const stride = ss.stride;
        const base = ss.offset + baseVertexIndex * stride;
        // One bounds test over the whole gathered extent (the largest index the rewind will
        // read) instead of one per output vertex — same guarantee, no per-vertex branch.
        let maxIndex = 0;
        for (let v = 0; v < finalVertexCount; v++) if (order[v]! > maxIndex) maxIndex = order[v]!;
        if (base < 0 || base + maxIndex * stride + stride > vb.byteLength) return d3d9DropDraw("indexedStrip:vertexOOB");
        const finalData = this.ensureConversionBuffer(finalVertexCount * stride);
        gatherVertices(finalData, vb, base, order, finalVertexCount, stride);

        const extraStreams = this.expandExtraStreamsByOrder(order, finalVertexCount, baseVertexIndex);
        if (extraStreams === null) return d3d9DropDraw("indexedStrip:extraStreamUnreadable");
        return this.recordConvertedDraw(finalData, finalVertexCount, stride, shape.topology, extraStreams);
    }

    /** Scratch for the strip/fan rewind permutation (grown, never per-draw allocated). */
    private rewindOrder: Uint32Array = new Uint32Array(0);
    private ensureRewindOrder(count: number): Uint32Array {
        if (this.rewindOrder.length < count) this.rewindOrder = new Uint32Array(Math.max(count, this.rewindOrder.length * 2, 256));
        return this.rewindOrder;
    }

    /**
     * Rewind the streams beyond 0 with the same vertex permutation a CPU-converted draw
     * applied to stream 0, into pooled buffers. Returns undefined when the declaration is
     * single-stream (the overwhelmingly common case, no work done), or null when a stream
     * cannot be read — the caller then drops the draw rather than binding vertices that do
     * not correspond to the ones stream 0 supplies.
     */
    private expandExtraStreamsByOrder(
        order: Uint32Array,
        vertexCount: number,
        startVertex: number,
    ): StreamVertexBinding[] | undefined | null {
        const decl = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
        if (!decl || maxDeclStream(decl) === 0) return undefined;
        const device = this.backend.getDevice();
        if (!device) return null;
        if (!this.vbPool) this.vbPool = new DynamicVbPool(device);

        let maxIndex = 0;
        for (let v = 0; v < vertexCount; v++) if (order[v]! > maxIndex) maxIndex = order[v]!;

        const out: StreamVertexBinding[] = [];
        for (const stream of declStreamsUsed(decl)) {
            if (stream === 0) continue;
            const index = this.streamBindingIndex[stream];
            const stride = this.streamBindingStride[stream]!;
            const data = index !== null ? this.vertexBuffers.getData(index) : null;
            if (!data || stride <= 0) {
                Logger.warn(LogCategory.D3D9, `converted draw: stream ${stream} unbound/unsized — dropping draw`);
                return null;
            }
            const base = this.streamBindingOffset[stream]! + startVertex * stride;
            const size = vertexCount * stride;
            if (base < 0 || base + maxIndex * stride + stride > data.byteLength) return null;
            // Pooled scratch, refilled per stream: queue.writeBuffer copies at call time, so
            // one buffer can serve every stream of every draw. Write length padded to 4 —
            // writeBuffer throws on any other size.
            const paddedSize = (size + 3) & ~3;
            const bytes = this.ensureExtraStreamScratch(paddedSize);
            gatherVertices(bytes, data, base, order, vertexCount, stride);
            const buffer = this.vbPool.acquire(Math.max(16, paddedSize));
            device.queue.writeBuffer(buffer, 0, bytes, 0, paddedSize);
            this.commandRecorder.registerPooledBuffer(buffer);
            out.push({ slot: stream, buffer, offset: 0, size });
        }
        return out;
    }

    /** Scratch for the extra-stream rewind, pooled like ensureConversionBuffer. */
    private extraStreamScratch: Uint8Array = new Uint8Array(0);
    private ensureExtraStreamScratch(size: number): Uint8Array {
        if (this.extraStreamScratch.length < size) {
            this.extraStreamScratch = new Uint8Array(Math.max(size, this.extraStreamScratch.length * 2, 4096));
        }
        return this.extraStreamScratch;
    }

    /** Upload a host-built vertex blob to a pooled VB and record one draw. Cull is forced off:
     *  every caller has already rewound strips/fans (or de-indexed), which alternates winding.
     *  The arena is deliberately not offered a key — the bytes drawn are CPU-converted and no
     *  longer match any contiguous guest range it could capture. */
    private recordConvertedDraw(
        finalData: Uint8Array,
        finalVertexCount: number,
        stride: number,
        topology: "triangle-list" | "line-list",
        extraStreams?: StreamVertexBinding[],
    ): number {
        const device = this.backend.getDevice();
        if (!device) return 0;

        const bufferSize = Math.max(16, finalData.byteLength);
        if (!this.vbPool) this.vbPool = new DynamicVbPool(device);
        const gpuBuffer = this.vbPool.acquire(bufferSize);
        device.queue.writeBuffer(gpuBuffer, 0, finalData);

        let pipelineId: number;
        let bindStateIndex: number | undefined;
        let ffpStateIndex: number | undefined;
        if (this.isProgrammable()) {
            pipelineId = this.resolveProgrammablePipeline(topology, true, stride, undefined);
            if (pipelineId < 0) { this.commandRecorder.registerPooledBuffer(gpuBuffer); return d3d9DropDraw("converted:noPipeline"); }
            bindStateIndex = this.captureDrawState();
        } else {
            const slots = new Set<number>([0]);
            for (const s of extraStreams ?? []) slots.add(s.slot);
            pipelineId = this.getPipelineIdForTopology(topology, true, stride, slots);
            ffpStateIndex = this.captureFfpDrawState(slots);
        }

        this.commandRecorder.recordDraw({
            pipelineId,
            gpuBuffer,
            bufferOffset: 0,
            bufferSize: finalData.byteLength,
            vertexCount: finalVertexCount,
            startVertex: 0,
            bindStateIndex,
            ffpStateIndex,
            extraStreams: extraStreams && extraStreams.length > 0 ? extraStreams : undefined,
        });
        this.commandRecorder.registerPooledBuffer(gpuBuffer);
        this.drawCount += 1;
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.vertexBytes += finalData.byteLength;
        }
        return 0;
    }

    /** DrawIndexedPrimitiveUP: both vertices and indices live in app memory, no VB/IB bound.
     *  De-indexes into a flat triangle/line list (the pooled-VB UP flow is non-indexed and
     *  WebGPU has no fan topology) and records one draw. Indices are absolute vertex numbers;
     *  minVertexIndex/numVertices only bound the range the app guarantees is readable. */
    drawIndexedPrimitiveUP(
        primitiveType: number,
        minVertexIndex: number,
        numVertices: number,
        primitiveCount: number,
        indexDataPtr: number,
        indexIs32: boolean,
        vertexDataPtr: number,
        stride: number,
    ): number {
        if (this.gpuGone) return d3d9DropDraw("drawIndexedPrimitiveUP:deviceLost");
        d3d9PerfInc("drawIndexedPrimitiveUP");
        if (primitiveCount <= 0 || numVertices <= 0 || stride <= 0) return 0;
        if (frameCapture.isCapturing()) {
            this.captureDrawIfArmed(primitiveType, primitiveCount, {
                data: this.memory, offset: vertexDataPtr + minVertexIndex * stride, stride, count: numVertices,
            }, UP_STREAM_SLOTS);
        }
        if (this.scrubbedOut()) return 0;

        let idxCount: number;
        let finalVertexCount: number;
        let topology: "triangle-list" | "line-list";
        switch (primitiveType) {
            case D3DPT_TRIANGLELIST:
                idxCount = primitiveCount * 3; finalVertexCount = idxCount; topology = "triangle-list"; break;
            case D3DPT_TRIANGLESTRIP:
            case D3DPT_TRIANGLEFAN:
                idxCount = primitiveCount + 2; finalVertexCount = primitiveCount * 3; topology = "triangle-list"; break;
            case D3DPT_LINELIST:
                idxCount = primitiveCount * 2; finalVertexCount = idxCount; topology = "line-list"; break;
            case D3DPT_LINESTRIP:
                idxCount = primitiveCount + 1; finalVertexCount = primitiveCount * 2; topology = "line-list"; break;
            default:
                return 0; // D3DPT_POINTLIST — no point-sprite expansion on the indexed path.
        }

        const idxSize = indexIs32 ? 4 : 2;
        const vertexLimit = minVertexIndex + numVertices;
        if (!isValidAddress(this.memory, indexDataPtr, idxCount * idxSize)) return 0;
        if (!isValidAddress(this.memory, vertexDataPtr, vertexLimit * stride)) return 0;

        // One scratch, two spans: [0, idxCount) holds the app's indices, [idxCount, …) the
        // per-output-vertex source index after the strip/fan rewind.
        const scratch = this.ensureIndexScratch(idxCount + finalVertexCount);
        const mem = this.memory;
        for (let i = 0; i < idxCount; i++) {
            const p = indexDataPtr + i * idxSize;
            const v = indexIs32
                ? (mem[p]! | (mem[p + 1]! << 8) | (mem[p + 2]! << 16) | (mem[p + 3]! << 24)) >>> 0
                : mem[p]! | (mem[p + 1]! << 8);
            // An index past the declared range reads outside what the app guaranteed readable —
            // drop the draw rather than upload neighbouring heap bytes as geometry.
            if (v >= vertexLimit) {
                if (!this.dipUpIndexRangeWarned) {
                    this.dipUpIndexRangeWarned = true;
                    Logger.warn(LogCategory.D3D9,
                        `DrawIndexedPrimitiveUP: index ${v} >= MinVertexIndex+NumVertices (${vertexLimit}) — draw dropped`);
                }
                return 0;
            }
            scratch[i] = v;
        }

        const o = idxCount;
        switch (primitiveType) {
            case D3DPT_TRIANGLEFAN:
                for (let i = 0; i < primitiveCount; i++) {
                    scratch[o + i * 3] = scratch[0]!;
                    scratch[o + i * 3 + 1] = scratch[i + 1]!;
                    scratch[o + i * 3 + 2] = scratch[i + 2]!;
                }
                break;
            case D3DPT_TRIANGLESTRIP:
                // Odd triangles swap the first two vertices to keep a consistent winding.
                for (let i = 0; i < primitiveCount; i++) {
                    const even = (i % 2) === 0;
                    scratch[o + i * 3] = scratch[even ? i : i + 1]!;
                    scratch[o + i * 3 + 1] = scratch[even ? i + 1 : i]!;
                    scratch[o + i * 3 + 2] = scratch[i + 2]!;
                }
                break;
            case D3DPT_LINESTRIP:
                for (let i = 0; i < primitiveCount; i++) {
                    scratch[o + i * 2] = scratch[i]!;
                    scratch[o + i * 2 + 1] = scratch[i + 1]!;
                }
                break;
            default: // TRIANGLELIST / LINELIST — index order is already primitive order.
                for (let i = 0; i < finalVertexCount; i++) scratch[o + i] = scratch[i]!;
                break;
        }

        const finalData = this.ensureConversionBuffer(finalVertexCount * stride);
        for (let i = 0; i < finalVertexCount; i++) {
            const src = vertexDataPtr + scratch[o + i]! * stride;
            finalData.set(mem.subarray(src, src + stride), i * stride);
        }

        this.frameSnapshot.drawCalls++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = {
            api: "d3d9",
            primitiveType,
            numVerts: finalVertexCount,
            timestamp: performance.now(),
        };
        return this.recordConvertedDraw(finalData, finalVertexCount, stride, topology);
    }

    drawPrimitiveUP(primitiveType: number, primitiveCount: number, vertexDataPtr: number, stride: number): number {
        if (this.gpuGone) return d3d9DropDraw("drawPrimitiveUP:deviceLost");
        d3d9PerfInc("drawPrimitiveUP");
        if (primitiveCount <= 0) return 0;
        // harness capture (UP renders non-trilist too)
        if (frameCapture.isCapturing()) {
            this.captureDrawIfArmed(primitiveType, primitiveCount, {
                data: this.memory, offset: vertexDataPtr, stride, count: primitiveCount * 3,
            }, UP_STREAM_SLOTS);
        }
        if (this.scrubbedOut()) return 0;

        const fvf = this.stateTracker.getFVF();
        const device = this.backend.getDevice()!;

        // Point sprites: expand D3DPT_POINTLIST into sized quads (see tryDrawPointSprites). The
        // point count equals primitiveCount for a point list. Falls through only if not handled
        // (VS active / decl / no FVF) — POINTLIST was a no-op on this path before, so still is.
        if (primitiveType === D3DPT_POINTLIST) {
            const srcBytes = this.memory.subarray(vertexDataPtr, vertexDataPtr + primitiveCount * stride);
            this.tryDrawPointSprites(srcBytes, primitiveCount, stride, fvf);
            return 0;
        }

        // Calculate source vertex count based on primitive type
        let srcVertexCount = 0;
        switch (primitiveType) {
            case D3DPT_TRIANGLELIST:
                srcVertexCount = primitiveCount * 3;
                break;
            case D3DPT_TRIANGLEFAN:
                srcVertexCount = primitiveCount + 2;
                break;
            case D3DPT_TRIANGLESTRIP:
                srcVertexCount = primitiveCount + 2;
                break;
            case D3DPT_LINELIST:
                srcVertexCount = primitiveCount * 2;
                break;
            case D3DPT_LINESTRIP:
                srcVertexCount = primitiveCount + 1;
                break;
            default:
                return 0;
        }

        // Read source vertices from memory
        const srcData = this.memory.subarray(vertexDataPtr, vertexDataPtr + srcVertexCount * stride);

        // Convert to triangle list if needed (WebGPU doesn't support TRIANGLEFAN)
        let finalData: Uint8Array;
        let finalVertexCount: number;

        if (primitiveType === D3DPT_TRIANGLEFAN) {
            // Convert fan to triangle list: for each triangle, copy v0, v[i], v[i+1]
            finalVertexCount = primitiveCount * 3;
            finalData = this.ensureConversionBuffer(finalVertexCount * stride);
            for (let i = 0; i < primitiveCount; i++) {
                // v0
                finalData.set(srcData.subarray(0, stride), i * 3 * stride);
                // v[i+1]
                finalData.set(srcData.subarray((i + 1) * stride, (i + 2) * stride), (i * 3 + 1) * stride);
                // v[i+2]
                finalData.set(srcData.subarray((i + 2) * stride, (i + 3) * stride), (i * 3 + 2) * stride);
            }
        } else if (primitiveType === D3DPT_TRIANGLESTRIP) {
            // Convert strip to triangle list
            finalVertexCount = primitiveCount * 3;
            finalData = this.ensureConversionBuffer(finalVertexCount * stride);
            for (let i = 0; i < primitiveCount; i++) {
                if (i % 2 === 0) {
                    finalData.set(srcData.subarray(i * stride, (i + 1) * stride), i * 3 * stride);
                    finalData.set(srcData.subarray((i + 1) * stride, (i + 2) * stride), (i * 3 + 1) * stride);
                    finalData.set(srcData.subarray((i + 2) * stride, (i + 3) * stride), (i * 3 + 2) * stride);
                } else {
                    finalData.set(srcData.subarray((i + 1) * stride, (i + 2) * stride), i * 3 * stride);
                    finalData.set(srcData.subarray(i * stride, (i + 1) * stride), (i * 3 + 1) * stride);
                    finalData.set(srcData.subarray((i + 2) * stride, (i + 3) * stride), (i * 3 + 2) * stride);
                }
            }
        } else if (primitiveType === D3DPT_LINESTRIP) {
            // Convert line strip to line list
            finalVertexCount = primitiveCount * 2;
            finalData = this.ensureConversionBuffer(finalVertexCount * stride);
            for (let i = 0; i < primitiveCount; i++) {
                finalData.set(srcData.subarray(i * stride, (i + 1) * stride), i * 2 * stride);
                finalData.set(srcData.subarray((i + 1) * stride, (i + 2) * stride), (i * 2 + 1) * stride);
            }
        } else {
            finalData = this.ensureConversionBuffer(srcData.length);
            finalData.set(srcData);
            finalVertexCount = srcVertexCount;
        }

        // Acquire a pooled vertex buffer (reused across frames — no per-draw
        // createBuffer/destroy churn) and upload immediately. queue.writeBuffer copies
        // the source synchronously, so finalData (a view into the shared conversion
        // scratch that the NEXT UP draw overwrites) is safe to pass without a staging
        // copy — unlike the deferred queueUpload path, which had to snapshot it.
        const bufferSize = Math.max(16, finalData.byteLength);
        if (!this.vbPool) this.vbPool = new DynamicVbPool(device);
        const gpuBuffer = this.vbPool.acquire(bufferSize);
        device.queue.writeBuffer(gpuBuffer, 0, finalData);

        const isLine = primitiveType === D3DPT_LINELIST || primitiveType === D3DPT_LINESTRIP;
        const topology = isLine ? "line-list" : "triangle-list";

        // WASM arena — only D3DPT_TRIANGLELIST/D3DPT_LINELIST reach here with NO CPU-side
        // conversion (srcData copied straight into finalData above), so
        // guestVertexPtr..+finalVertexCount*stride is a byte-for-byte match for what the
        // arena captures. D3DPT_TRIANGLEFAN/TRIANGLESTRIP/LINESTRIP get rewound/re-ordered
        // into finalData by the CPU conversion above; the arena has no such conversion (it
        // captures raw guest bytes verbatim), so recording those would capture the WRONG
        // bytes — decline for those shapes (arenaKey stays undefined, same as any other
        // unsupported draw, so resolveProgrammablePipeline below falls back to the legacy path).
        let arenaKey: number | undefined;
        if (d3d9WasmArena.isInitialized() && (primitiveType === D3DPT_TRIANGLELIST || primitiveType === D3DPT_LINELIST)) {
            const arenaTopology = isLine ? 2 : 0; // 2=line-list, 0=triangle-list
            arenaKey = d3d9WasmArena.recordDrawUP(
                arenaTopology, finalVertexCount, vertexDataPtr, stride, finalVertexCount * stride, true,
            );
        }

        // Force cull none for UP draws - D3D9 and WebGPU have different winding conventions
        let pipelineId: number;
        let bindStateIndex: number | undefined;
        let ffpStateIndex: number | undefined;
        if (this.isProgrammable()) {
            pipelineId = this.resolveProgrammablePipeline(topology, true, stride, arenaKey);
            if (pipelineId < 0) { this.commandRecorder.registerPooledBuffer(gpuBuffer); return 0; }
            bindStateIndex = this.captureDrawState();
        } else {
            // A *UP draw supplies its vertices inline; D3D9 reads no bound stream for it, so
            // the pipeline declares stream 0 alone even when the declaration spans more.
            pipelineId = this.getPipelineIdForTopology(topology, true, stride, UP_STREAM_SLOTS);
            ffpStateIndex = this.captureFfpDrawState(UP_STREAM_SLOTS);
        }

        this.commandRecorder.recordDraw({
            pipelineId,
            gpuBuffer,
            bufferOffset: 0,
            bufferSize: finalData.byteLength,
            vertexCount: finalVertexCount,
            startVertex: 0,
            bindStateIndex,
            ffpStateIndex,
        });

        this.commandRecorder.registerPooledBuffer(gpuBuffer);

        this.drawCount += 1;

        // Cross-check is only meaningful in dual-run mode (see drawPrimitive's identical
        // comment) — real-bypass mode may have skipped the legacy path entirely.
        if (arenaKey !== undefined && !isWasmPathEnabled()) {
            this.crossCheckArenaPipelineKey(arenaKey, pipelineId);
        }

        // Update frame snapshot for debug panel
        this.frameSnapshot.drawCalls++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = {
            api: "d3d9",
            primitiveType,
            numVerts: srcVertexCount,
            timestamp: performance.now(),
        };

        return 0;
    }

    drawIndexedPrimitive(
        primitiveType: number,
        baseVertexIndex: number,
        minVertexIndex: number,
        numVertices: number,
        startIndex: number,
        primitiveCount: number
    ): number {
        if (this.gpuGone) return d3d9DropDraw("drawIndexedPrimitive:deviceLost");
        d3d9PerfInc("drawIndexedPrimitive");
        if (frameCapture.isCapturing()) {
            const ss = this.stateTracker.getStreamSource();
            const vb = ss ? this.vertexBuffers.getData(ss.index) : null;
            this.captureDrawIfArmed(primitiveType, primitiveCount, ss && vb
                ? { data: vb, offset: ss.offset + (baseVertexIndex + minVertexIndex) * ss.stride, stride: ss.stride, count: numVertices }
                : undefined);
        }
        if (this.scrubbedOut()) return 0;
        if (primitiveType !== D3DPT_TRIANGLELIST) {
            return this.drawIndexedStreamAsTriangleList(primitiveType, baseVertexIndex, startIndex, primitiveCount);
        }
        const streamSource = this.stateTracker.getStreamSource();
        if (!streamSource) return d3d9DropDraw("drawIndexed:noStreamSource");
        const indexSource = this.stateTracker.getIndexSource();
        if (indexSource === null) return d3d9DropDraw("drawIndexed:noIndexSource");

        const vbIndex = streamSource.index;
        const ibIndex = indexSource;
        const vbData = this.vertexBuffers.getData(vbIndex);
        const ibData = this.indexBuffers.getData(ibIndex);
        if (!vbData || !ibData) return d3d9DropDraw("drawIndexed:noBufferData");

        const device = this.backend.getDevice()!;
        const vbBuffer = this.uploadBufferVersion(vbIndex, vbData, "vb", device);
        const ibBuffer = this.uploadBufferVersion(ibIndex, ibData, "ib", device);

        // D3D9 promises every index of this draw lies in [minVertexIndex, +numVertices), so
        // the bytes the GPU will fetch are known up front. WebGPU cannot check that itself for
        // an indexed draw — robust access silently substitutes zeros — so check it here or the
        // miss shows up only as geometry that never appears. See D3D9BufferPerf.
        const vbBytes = this.vertexBuffers.getSize(vbIndex);
        const idxBytes = this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16 ? 2 : 4;
        const ibNeed = (startIndex + primitiveCount * 3) * idxBytes;
        const ibBytes = this.indexBuffers.getSize(ibIndex);
        const firstVertex = baseVertexIndex + minVertexIndex;
        const need = streamSource.offset + (firstVertex + numVertices) * streamSource.stride;
        if (ibNeed > ibBytes) {
            // An over-long index range is the one case WebGPU does raise — and the rejection
            // invalidates the whole command buffer, not just this draw, so drop it here.
            d3d9PerfIndexRangeOOB(ibNeed - ibBytes);
            return d3d9DropDraw("drawIndexed:indexRangeOOB");
        }
        if (firstVertex < 0 || need > vbBytes) {
            d3d9PerfVertexRangeOOB(Math.max(0, need - vbBytes));
            this.vertexRangeOobLogs = (this.vertexRangeOobLogs + 1) >>> 0;
            if (this.vertexRangeOobLogs % 200 === 1) {
                Logger.warn(LogCategory.D3D9,
                    `drawIndexedPrimitive vertex range outside VB: off=${streamSource.offset} ` +
                    `base=${baseVertexIndex} min=${minVertexIndex} num=${numVertices} ` +
                    `stride=${streamSource.stride} need=${need} vbSize=${vbBytes}`);
            }
        }

        // WASM arena — computed BEFORE pipeline resolution so a real-bypass hit
        // (dbg.d3dWasmPath(true)) can skip the legacy string-key path entirely (see
        // resolveProgrammablePipeline). Only reachable for D3DPT_TRIANGLELIST (early-return
        // above), so topology=0/forceCullNone=false, matching the resolve call below.
        let arenaKey: number | undefined;
        if (d3d9WasmArena.isInitialized()) {
            arenaKey = d3d9WasmArena.recordDrawIndexed(0, primitiveCount * 3, startIndex, baseVertexIndex, streamSource.stride, false);
        }

        let pipelineId: number;
        let bindStateIndex: number | undefined;
        let ffpStateIndex: number | undefined;
        let extraStreams: StreamVertexBinding[] | undefined;
        if (this.isProgrammable()) {
            pipelineId = this.resolveProgrammablePipeline("triangle-list", false, undefined, arenaKey);
            if (pipelineId < 0) return 0;
            bindStateIndex = this.captureDrawState();
        } else {
            pipelineId = this.getPipelineId(streamSource.stride);
            ffpStateIndex = this.captureFfpDrawState();
            extraStreams = this.collectFfpExtraStreams();
        }
        if (this.fetchAuditFramesLeft > 0) {
            this.fetchAuditRecord(
                vbIndex, ibIndex, vbData, ibData, vbBuffer, ibBuffer,
                streamSource.offset, streamSource.stride, baseVertexIndex, startIndex,
                primitiveCount * 3, this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16,
            );
        }
        this.commandRecorder.recordDrawIndexed({
            pipelineId,
            vbGpuBuffer: vbBuffer,
            vbOffset: streamSource.offset,
            vbSize: this.vertexBuffers.getSize(vbIndex) - streamSource.offset,
            ibGpuBuffer: ibBuffer,
            ibFormat: this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16 ? "uint16" : "uint32",
            indexCount: primitiveCount * 3,
            startIndex,
            baseVertex: baseVertexIndex,
            bindStateIndex,
            ffpStateIndex,
            extraStreams,
        });
        this.drawCount += 1;

        // Cross-check is only meaningful in dual-run mode (see drawPrimitive's identical
        // comment) — real-bypass mode may have skipped the legacy path entirely.
        if (arenaKey !== undefined && !isWasmPathEnabled()) {
            this.crossCheckArenaPipelineKey(arenaKey, pipelineId);
        }

        // Update frame snapshot for debug panel
        this.frameSnapshot.drawCalls++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = {
            api: "d3d9",
            primitiveType,
            numVerts: numVertices,
            numIndices: primitiveCount * 3,
            timestamp: performance.now(),
        };
        
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.vertexBytes += 
                (this.vertexBuffers.getSize(vbIndex) - streamSource.offset) +
                (this.indexBuffers.getSize(ibIndex) - startIndex * (this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16 ? 2 : 4));
        }
        
        return 0;
    }

    private lastActualPresent = 0;

    /**
     * D3DPRESENT_PARAMETERS.PresentationInterval, as refreshes to hold each Present.
     * We advertise IMMEDIATE|ONE|TWO|THREE|FOUR in D3DCAPS9.PresentationIntervals, so the
     * app's choice has to reach the pacer. Re-declared by every CreateDevice/Reset.
     */
    private presentInterval = PRESENT_INTERVAL_ONE;

    setPresentationInterval(rawInterval: number): void {
        this.presentInterval = decodeD3DPresentInterval(rawInterval);
    }

    async present(): Promise<number> {
        d3d9PerfInc("present");
        // Nothing to present onto. Returning D3D_OK is the faithful answer for a Present on a
        // lost device: real D3D9 answers D3DERR_DEVICELOST there, and TestCooperativeLevel
        // (which the app polls for exactly this) already says so — see the loss contract.
        if (this.gpuGone) return 0x88760868;
        const presentStart = frameProfiler.startTimer();

        // Frame Pacer: hold for the swap interval the device was created with.
        await framePacer.waitForPresentInterval(this.presentInterval);
        framePacer.reserveFrameSlot();

        this.lastActualPresent = performance.now();
        this.fetchAuditOnPresent();
        // Defensive: if the guest left an RT bound at Present, flush its work to that RT, then
        // return authority to the backbuffer so the present actually copies the scene to the canvas.
        if (this.currentRtIndex !== null) {
            this.submitFrame(false);
            this.currentRtIndex = null;
            this.currentRtFace = -1;
        }
        this.submitFrame(true);
        this.updateFps();
        System.getInstance().services.render.notifyPresent("d3d9");
        frameCapture.onFrameEnd("d3d9"); // harness CaptureBus frame boundary (D3D9)

        // Update frame snapshot for debug panel
        this.frameSnapshot.presents++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastPresent = {
            timestamp: performance.now(),
        };

        // Reset frame counters for next frame
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.textureBinds = 0;
            this.frameSnapshot.frameCounters.uploads = 0;
            this.frameSnapshot.frameCounters.clears = 0;
            this.frameSnapshot.frameCounters.cacheHits = 0;
            this.frameSnapshot.frameCounters.cacheMisses = 0;
            this.frameSnapshot.frameCounters.waitTimeMs = 0;
            this.frameSnapshot.frameCounters.vertexBytes = 0;
            this.frameSnapshot.frameCounters.textureBytes = 0;
        }
        this.frameSnapshot.drawCalls = 0;

        frameProfiler.endTimer("present", presentStart);
        frameProfiler.markFrame("d3d9");

        // Feed frame time to stats overlay
        const now = performance.now();
        if (this.prevPresentTime > 0) {
            statsOverlay.updateMetrics(now - this.prevPresentTime);
        }
        this.prevPresentTime = now;

        // Release frame slot for FramePacer
        framePacer.releaseFrameSlot();

        return 0;
    }

    /** PNG of the screen (canvas, post-fx and every overlay included); the executor's
     *  own readback of the presented offscreen is the fallback. */
    async captureFrame(): Promise<Blob> {
        const screen = await System.getInstance().services.render.tryCaptureScreen();
        if (screen) return screen;
        return (await this.capturePresentedLayer()) ?? new Blob();
    }

    /** The presented offscreen target — the 3D frame before it reaches the canvas. */
    async capturePresentedLayer(): Promise<Blob | null> {
        this.submitFrame(false);
        return this.backendExecutor.captureFrame();
    }

    /** RenderActive: re-present the last frame to the canvas (GDI present loop, screen-owned path). */
    repaintLastFrame(): void {
        this.backendExecutor.repaintLastFrame();
    }

    getCounters(): Record<string, number> {
        const executorMetrics = this.backendExecutor.getMetrics();
        return {
            frames: this.frameCount,
            drawPrimitive: this.drawCount,
            fps: Math.round(this.fps),
            ...(this.frameSnapshot.frameCounters ?? {}),
            drawCalls: this.frameSnapshot.drawCalls,
            presents: this.frameSnapshot.presents,
            // Add executor metrics
            pipelineSets: executorMetrics.pipelineSets,
            bindGroupSets: executorMetrics.bindGroupSets,
            bindGroupCacheHits: executorMetrics.bindGroupCacheHits,
        };
    }

    /** Task A perf: subsystem counters not tracked on the API hot path. */
    collectSubsystemPerf(): {
        stateTracker: ReturnType<D3D9StateTracker["getMetrics"]>;
        backend: ReturnType<D3D9BackendExecutor["getMetrics"]>;
    } {
        return {
            stateTracker: this.stateTracker.getMetrics(),
            backend: this.backendExecutor.getMetrics(),
        };
    }

    resetSubsystemPerf(): void {
        this.stateTracker.resetMetrics();
        this.backendExecutor.resetMetrics();
    }

    /** HARNESS/dbg (dbg.d3dArenaStats): this device's WASM-arena verify-only drain counters. */
    getArenaDrainStats(): ReturnType<D3D9BackendExecutor["getArenaDrainStats"]> {
        return this.backendExecutor.getArenaDrainStats();
    }

    /** HARNESS: per-texture metadata for the texture gallery. The
     *  TextureStore is private; this is the read-only enumeration accessor. */
    getTexturesDebugInfo(): Array<{ handle: number; width: number; height: number; levels: number; format: number; isDirty: boolean; isLocked: boolean; hasGpuTexture: boolean }> {
        return this.textures.getAllDebugInfo();
    }

    /**
     * Level-0 pixels of a D3D9 texture as RGBA8 — the diagnostic counterpart to the DDraw
     * surface dump, which cannot see this store at all. Decoded through the SAME
     * decodeD3DTextureToRgba8 the upload path uses, so what this returns is what the GPU
     * copy holds (short of a later guest write we have not uploaded yet).
     *
     * A render target has no guest-side pixels — say so rather than return a blank image.
     */
    readTextureRgba(handle: number): { rgba: Uint8Array; w: number; h: number; format: number } | { err: string } {
        const index = this.textures.getIndex(handle);
        if (index === null) return { err: `no d3d9 texture with handle 0x${(handle >>> 0).toString(16)}` };
        if (this.textures.isRenderTarget(index)) {
            return { err: "render-target texture — rendered into, no guest pixels (capture the screen instead)" };
        }
        const data = this.textures.getData(index);
        if (!data) return { err: "texture has no backing store (never locked?)" };
        const w = this.textures.getWidth(index), h = this.textures.getHeight(index);
        const format = this.textures.getFormat(index);
        const rgba = new Uint8Array(w * h * 4);
        if (isBlockCompressedFormat(format)) return { err: `block-compressed format ${format} — not decoded on the dump path` };
        decodeD3DTextureToRgba8(data, 0, w, h, format, { pitch: this.textures.getPitch(index), out: rgba });
        return { rgba, w, h, format };
    }

    /**
     * D3D9 ColorFill against an OFFSCREEN surface (an RT texture, or a plain one with a
     * guest-side store) — the `Clear`-on-the-backbuffer shortcut cannot express it.
     *
     * A game that composes its 2D layer into a texture and blits it as one quad erases that
     * layer with ColorFill, not Clear. Dropping the fill leaves every frame's UI painted on
     * top of the last, so text and cursors smear along whatever path they took.
     *
     * Returns false when the request needs a scissored fill we cannot express (a sub-rect of
     * a render target); the caller reports that rather than pretending it happened.
     */
    colorFillSurface(texturePtr: number, rect: { left: number; top: number; right: number; bottom: number } | null, color: number): boolean {
        const index = this.textures.getIndex(texturePtr >>> 0);
        if (index === null) return false;
        const w = this.textures.getWidth(index), h = this.textures.getHeight(index);
        if (w <= 0 || h <= 0) return false;
        const full = !rect || (rect.left <= 0 && rect.top <= 0 && rect.right >= w && rect.bottom >= h);

        const gpuTex = this.textures.getGpuTexture(index);
        if (this.textures.isRenderTarget(index) || (gpuTex && !this.textures.getData(index))) {
            if (!full || !gpuTex) return false;
            const device = this.backend.getDevice();
            const queue = this.backend.getQueue();
            if (!device || !queue) return false;
            // Order matters: everything recorded up to this call must land BEFORE the fill,
            // exactly as the guest issued it.
            this.submitFrame(false);
            const encoder = device.createCommandEncoder();
            encoder.beginRenderPass({
                colorAttachments: [{
                    view: gpuTex.createView(),
                    clearValue: d3dColorToGpu(color),
                    loadOp: "clear",
                    storeOp: "store",
                }],
            }).end();
            queue.submit([encoder.finish()]);
            return true;
        }

        // Plain texture: fill its guest-side store and let the ordinary upload path carry it.
        const data = this.textures.getData(index);
        if (!data) return false;
        const format = this.textures.getFormat(index);
        if (format !== 21 && format !== 22) return false; // [A|X]R8G8B8 — the only packing this writes
        const pitch = this.textures.getPitch(index);
        const x0 = Math.max(0, rect?.left ?? 0), y0 = Math.max(0, rect?.top ?? 0);
        const x1 = Math.min(w, rect?.right ?? w), y1 = Math.min(h, rect?.bottom ?? h);
        const b = color & 0xff, g = (color >>> 8) & 0xff, r = (color >>> 16) & 0xff, a = (color >>> 24) & 0xff;
        for (let y = y0; y < y1; y++) {
            let o = y * pitch + x0 * 4;
            for (let x = x0; x < x1; x++, o += 4) { data[o] = b; data[o + 1] = g; data[o + 2] = r; data[o + 3] = a; }
        }
        this.textures.setDirty(index, true);
        return true;
    }

    /**
     * Level-0 pixels of a RENDER-TARGET texture, read back off the GPU.
     *
     * A game that composes its whole 2D layer into an RT and blits it as one quad (SS2's UI)
     * puts every interesting pixel somewhere `readTextureRgba` cannot reach — it has no guest
     * copy by construction. Without this the gallery lists the RT and no verb can open it,
     * which reads as "the texture does not exist".
     */
    async readRenderTargetRgba(handle: number): Promise<{ rgba: Uint8Array; w: number; h: number; format: number } | { err: string }> {
        const index = this.textures.getIndex(handle);
        if (index === null) return { err: `no d3d9 texture with handle 0x${(handle >>> 0).toString(16)}` };
        const gpuTex = this.textures.getGpuTexture(index);
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!gpuTex || !device || !queue) return { err: "texture has no GPU copy yet" };
        const w = this.textures.getWidth(index), h = this.textures.getHeight(index);
        if (w <= 0 || h <= 0) return { err: `degenerate size ${w}x${h}` };
        // Flush recorded draws so the readback sees what this frame rendered into it.
        this.submitFrame(false);
        const padded = Math.ceil(w * 4 / 256) * 256;
        const readback = device.createBuffer({
            size: padded * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture: gpuTex },
                { buffer: readback, bytesPerRow: padded },
                { width: w, height: h, depthOrArrayLayers: 1 },
            );
            queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(readback.getMappedRange());
            const rgba = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) rgba.set(mapped.subarray(y * padded, y * padded + w * 4), y * w * 4);
            return { rgba, w, h, format: this.textures.getFormat(index) };
        } catch (e) {
            return { err: `render-target readback failed: ${e}` };
        } finally {
            readback.destroy();
        }
    }

    /**
     * Compute a 32-bit pipeline cache key that encodes:
     *  - bits  0-14 : vertex decl handle (or low FVF bits when no decl/VS)
     *  - bits 15-15 : reserved
     *  - bits 16-26 : render-state bits (cull, z, lighting) from stateTracker
     *  - bits 27-31 : VS handle (0 = FFP)
     *
     * When neither VS nor decl is active the full stateTracker key is used
     * (bits 0-26 = FVF + render states) so the FFP path is unaffected.
     */
    private buildPipelineKey(topologyOffset: number = 0, cullOffset: number = 0): number {
        const stateKey = this.stateTracker.computePipelineKey(); // bits 0-26
        const vsHandle = this.activeVertexShader;
        const declHandle = this.activeVertexDecl;

        let key: number;
        if (vsHandle || declHandle) {
            // High render-state bits (cull, z-enable, z-write, lighting) stay in place.
            const stateBits = stateKey & 0x7FF0000;   // bits 16-26
            const declBits  = declHandle & 0x7FFF;     // bits  0-14 (max 32767 declarations)
            const vsBits    = (vsHandle & 0x1F) << 27; // bits 27-31 (max  31 VS handles)
            key = (stateBits | declBits | vsBits) >>> 0;
        } else {
            key = stateKey >>> 0;
        }

        return (key + topologyOffset + cullOffset) >>> 0;
    }

    /** Bound render-state reader for the blend helpers. */
    private getRS = (state: number): number => this.stateTracker.getRenderState(state);

    /**
     * Current D3D9 fixed-function alpha test, or null when disabled / ALWAYS.
     * Emitted as a fragment `discard` (WebGPU has no fixed-function alpha test) —
     * see alphaTestSnippet. D3DRS_ALPHATESTENABLE=15, ALPHAREF=24, ALPHAFUNC=25.
     */
    private getAlphaTest(): AlphaTest | null {
        if (this.getRS(D3DRS_ALPHATESTENABLE) === 0) return null;
        const func = this.getRS(D3DRS_ALPHAFUNC) || D3DCMP_ALWAYS;
        if (func === D3DCMP_ALWAYS) return null;
        return { func, ref: this.getRS(D3DRS_ALPHAREF) >>> 0 & 0xff };
    }

    /** Cache-key fragment so a change in alpha-test state rebuilds the pipeline. */
    private alphaTestKey(): string {
        const at = this.getAlphaTest();
        return at ? `a${at.func}.${at.ref}` : "a0";
    }

    /** Pipeline cache key = numeric state/decl/VS key + current blend + alpha test + depth. */
    /** Bound stride per stream, with stream 0 overridable by a CPU-converted draw's own
     *  stride. Feeds both the vertex layout and the pipeline cache key. */
    private declStreamStrides(stream0Override = 0): number[] {
        const strides = new Array<number>(D3D9Device.MAX_STREAMS);
        for (let s = 0; s < D3D9Device.MAX_STREAMS; s++) strides[s] = this.streamBindingStride[s]!;
        if (stream0Override > 0) strides[0] = stream0Override;
        return strides;
    }

    /** The active declaration's streams beyond 0, as a cache-key fragment: the vertex layout
     *  has one entry per stream, so two draws that differ only in a stream-1 stride need
     *  different pipelines. Empty for a single-stream declaration. */
    private extraStreamKey(streamAllow: ReadonlySet<number> | null): string {
        const decl = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
        if (!decl) return "";
        let key = "";
        for (const stream of declStreamsUsed(decl)) {
            if (stream === 0 || (streamAllow && !streamAllow.has(stream))) continue;
            key += `|x${stream}:${this.streamBindingStride[stream]}`;
        }
        return streamAllow ? `|only${[...streamAllow].join(",")}${key}` : key;
    }

    /**
     * GPU bindings for the streams beyond 0 that the active declaration references.
     *
     * A stream the guest left unbound gets a zero-filled buffer rather than cancelling the
     * draw: real D3D9 binds an empty buffer there and still rasterizes (DXVK
     * D3D9DeviceEx::BindVertexBuffer with a null buffer), and WebGPU rejects a draw whose
     * pipeline declares a layout for a slot with nothing bound.
     */
    private collectFfpExtraStreams(): StreamVertexBinding[] | undefined {
        const decl = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
        if (!decl || maxDeclStream(decl) === 0) return undefined;
        const device = this.backend.getDevice();
        if (!device) return undefined;

        const { bindings, missing } = collectExtraStreamBindings(decl, (s) => {
            const index = this.streamBindingIndex[s];
            if (index === null) return null;
            const data = this.vertexBuffers.getData(index);
            if (!data) return null;
            const size = this.vertexBuffers.getSize(index);
            let gpu = this.vertexBuffers.getGpuBuffer(index);
            if (!gpu) {
                gpu = device.createBuffer({ size: (size + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
                this.vertexBuffers.setGpuBuffer(index, gpu);
            }
            if (this.vertexBuffers.isDirty(index)) {
                this.commandRecorder.queueUpload(gpu, data);
                this.vertexBuffers.setDirty(index, false);
                if (this.frameSnapshot.frameCounters) {
                    this.frameSnapshot.frameCounters.uploads++;
                    this.frameSnapshot.frameCounters.vertexBytes += data.byteLength;
                }
            }
            const stride = this.streamBindingStride[s]!;
            if (stride <= 0) return null;
            return { buffer: gpu, offset: this.streamBindingOffset[s]!, size, stride };
        });

        for (const s of missing) {
            bindings.push({ slot: s, buffer: zeroStreamBuffer(device, ZERO_STREAM_MIN_BYTES), offset: 0, size: ZERO_STREAM_MIN_BYTES });
        }
        return bindings.length > 0 ? bindings : undefined;
    }

    private blendCacheKey(numericKey: number, streamStride = 0, streamAllow: ReadonlySet<number> | null = null): string {
        // The numeric key carries only FVF bits 0-15, so the TEXCOORDSIZE field (bit 16+) and
        // the stream stride — both of which change the vertex layout — must key the cache too,
        // or the first pipeline built for an FVF is reused for a differently-strided stream.
        // Stage count is baked into the shader, so it belongs here for the same reason.
        const fvfHigh = this.stateTracker.getFVF() >>> 16;
        // ZFUNC is not in the numeric key (bits 25/26 carry only ZENABLE/ZWRITEENABLE), so it
        // has to key the cache here or every depth compare collapses onto the first one built.
        const stages = this.activeStageCount();
        // Appended only when texgen is on, so it multiplies pipelines for the draws that use
        // it and leaves every other key the shape it already had.
        const texGen = this.texGenActive(stages) ? "|tg" : "";
        return `${numericKey}|${fvfHigh}|${streamStride}|s${stages}${texGen}`
            + `|${computeBlendKey(this.getRS)}|${this.alphaTestKey()}|${computeDepthKey(this.getRS)}`
            + this.extraStreamKey(streamAllow);
    }

    /**
     * True when some active stage generates its own texture coordinates (D3DTSS_TCI_* in the
     * high bits of D3DTSS_TEXCOORDINDEX).
     *
     * The generator itself is a uniform, so it never rebuilds a pipeline — but a vertex that
     * carries no texcoord at all makes it structural: the shader would declare no samplers and
     * the stage would drop out, leaving an env-mapped mesh with no UV set untextured. Hence
     * the pipeline cache key carries it (blendCacheKey).
     */
    private texGenActive(stageCount: number): boolean {
        for (let s = 0; s < stageCount; s++) {
            if ((this.getTextureStageState(s, D3DTSS_TEXCOORDINDEX) & 0xffff0000) !== 0) return true;
        }
        return false;
    }

    /**
     * How many texture blend stages this draw uses: 1 + the highest stage the guest enabled.
     * D3D's cascade STOPS at the first stage whose COLOROP is DISABLE (the default for every
     * stage above 0), so the scan stops there too — a single-texture draw costs one lookup.
     * Baked into the FFP shader (and therefore into the pipeline key), which keeps the common
     * one-stage shader small.
     */
    private activeStageCount(): number {
        let n = 1;
        for (let s = 1; s < FFP_MAX_STAGES; s++) {
            const op = this.textureStageStates.get(this.makeStageStateKey(s, D3DTSS_COLOROP));
            if (op === undefined || op === D3DTOP_DISABLE) break;
            if (this.stateTracker.getTexture(s) === null) break;
            n = s + 1;
        }
        return n;
    }

    private getPipelineId(streamStride = 0): number {
        const key = this.buildPipelineKey();
        const cacheKey = this.blendCacheKey(key, streamStride);
        if (this.currentPipelineKey !== cacheKey || this.currentPipelineId === null) {
            this.currentPipelineKey = cacheKey;
            this.currentPipelineId = this.resolvePipelineId(key, "triangle-list", false, undefined, streamStride);
        }
        return this.currentPipelineId ?? 0;
    }

    private getPipelineIdForTopology(
        topology: "triangle-list" | "line-list",
        forceCullNone: boolean = false,
        streamStride = 0,
        streamAllow: ReadonlySet<number> | null = null,
    ): number {
        const topologyOffset = topology === "line-list" ? 0x1000000 : 0;
        const cullOffset = forceCullNone ? 0x2000000 : 0;
        const key = this.buildPipelineKey(topologyOffset, cullOffset);
        return this.resolvePipelineId(key, topology, forceCullNone, undefined, streamStride, streamAllow);
    }

    /**
     * Pipeline for the point-sprite expansion: a synthetic pre-transformed FVF (XYZRHW +
     * diffuse [+ tex]) that the RHW FFP shader passes straight through. Distinct cache prefix
     * so it never collides with the game's own FVF/decl pipelines; cull is forced off (D3D
     * never back-face-culls points).
     */
    private getPointSpritePipelineId(syntheticFvf: number): number {
        const key = this.buildPipelineKey(0, 0x2000000);
        return this.resolvePipelineId(key, "triangle-list", true, syntheticFvf);
    }

    private resolvePipelineId(
        key: number,
        topology: "triangle-list" | "line-list",
        forceCullNone: boolean = false,
        fvfOverride?: number,
        streamStride = 0,
        streamAllow: ReadonlySet<number> | null = null,
    ): number {
        // Synthetic-FVF pipelines (point sprites) get their own cache namespace so they never
        // alias the game's decl/FVF pipelines that hash to the same numeric key.
        const cacheKey = fvfOverride !== undefined
            ? `ps${fvfOverride}|${this.blendCacheKey(key)}`
            : this.blendCacheKey(key, streamStride, streamAllow);
        const cachedId = this.pipelineCache.get(cacheKey);
        if (cachedId !== undefined) {
            d3d9PerfBackendInc("pipelineCacheHits");
            if (this.frameSnapshot.frameCounters) {
                this.frameSnapshot.frameCounters.cacheHits++;
            }
            return cachedId;
        }

        d3d9PerfBackendInc("pipelineCacheMisses");
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.cacheMisses++;
        }

        const gpuDevice = this.backend.getDevice()!;
        const format = this.backend.getFormat()!;

        const declElements = this.activeVertexDecl > 0
            ? (this.vsDeclRegistry.get(this.activeVertexDecl) ?? null)
            : null;
        const streamSource = this.stateTracker.getStreamSource();

        let shaderModule: GPUShaderModule;
        let vertexBuffers: (GPUVertexBufferLayout | null)[];
        let hasTexture: boolean;
        // Stages this pipeline's shader will declare bindings for. Both fixed-function paths
        // (FVF and vertex declaration) derive it from the same activeStageCount(); the synthetic
        // point-sprite FVF stays at one. The executor binds exactly this many pairs, so it MUST
        // equal what the shader declared (see PipelineInfo.ffpStageCount).
        let ffpStageCount = 1;

        const alphaTest = this.getAlphaTest();
        // D3DRS_LIGHTING bit (24) of the pipeline key selects the lit FFP shader variant.
        const lit = ((key >> 24) & 1) !== 0;
        if (fvfOverride !== undefined) {
            // Point-sprite synthetic FVF: pre-transformed (XYZRHW) quads, never lit; build the
            // shader + tightly-packed layout straight from the synthetic FVF (ignore decl/stream).
            const layout = buildVertexLayout(fvfOverride);
            shaderModule = gpuDevice.createShaderModule({ code: buildShader(fvfOverride, alphaTest, false) });
            vertexBuffers = [{ arrayStride: layout.arrayStride, attributes: layout.attributes }];
            hasTexture = layout.hasTexture;
        } else if (declElements && declElements.length > 0) {
            // FFP + vertex declaration path: build shader and layout from declaration data.
            // One layout per stream the declaration spans — a CPU-converted draw overrides
            // stream 0's stride (its bytes are repacked) and carries no other stream.
            ffpStageCount = this.activeStageCount();
            const strides = this.declStreamStrides(streamStride || streamSource?.stride || 0);
            const built = buildShaderFromDecl(declElements, alphaTest, lit, ffpStageCount, strides, streamAllow,
                this.texGenActive(ffpStageCount));
            shaderModule = gpuDevice.createShaderModule({ code: built.wgsl });
            vertexBuffers = built.buffers;
            hasTexture = built.hasTexture;
        } else {
            // FFP + FVF path. The STREAM decides the stride (DrawPrimitiveUP's
            // VertexStreamZeroStride / SetStreamSource's Stride); the FVF only says where the
            // components sit inside a vertex. They differ whenever the vertex carries data the
            // FFP layout declares no attribute for — padding, or texcoord sets past the first —
            // and stepping by the FVF's packed size then reads every vertex after the first
            // from the middle of its predecessor. Never go BELOW the packed size: a stride that
            // cannot hold the declared attributes is an invalid draw, not a tighter layout.
            const fvf = this.stateTracker.getFVF();
            const layout = buildVertexLayout(fvf);
            ffpStageCount = this.activeStageCount();
            const texGen = this.texGenActive(ffpStageCount);
            shaderModule = gpuDevice.createShaderModule({
                code: buildShader(fvf, alphaTest, lit, ffpStageCount, texGen),
            });
            vertexBuffers = [{
                arrayStride: Math.max(layout.arrayStride, streamStride || 0),
                attributes: layout.attributes,
            }];
            hasTexture = layout.hasTexture || texGen;
        }

        const cullModeD3D = (key >> 16) & 0xff;
        let cullMode: GPUCullMode = "none";
        if (!forceCullNone) {
            if (cullModeD3D === D3DCULL_CW) cullMode = "front";
            else if (cullModeD3D === D3DCULL_CCW) cullMode = "back";
        }

        const pipeline = gpuDevice.createRenderPipeline({
            // Shared explicit layout when the FFP dynamic-offset shape is on (one cached bind
            // group serves every FFP draw); WebGPU's implicit per-pipeline layout otherwise.
            layout: this.backendExecutor.getFfpPipelineLayout(),
            vertex: {
                module: shaderModule,
                entryPoint: "vs_main",
                buffers: vertexBuffers,
            },
            fragment: {
                module: shaderModule,
                entryPoint: "fs_main",
                targets: [buildColorTargetState(format, this.getRS)],
            },
            primitive: {
                topology,
                frontFace: "cw",
                cullMode,
            },
            depthStencil: buildDepthStencilState("depth24plus", this.getRS),
        });

        const pipelineId = this.backendExecutor.registerPipeline(pipeline, hasTexture, false, ffpStageCount);
        this.pipelineCache.set(cacheKey, pipelineId);
        return pipelineId;
    }

    // ── Programmable (VS/PS) pipeline + per-draw state ────────────────────

    /**
     * Resolve (and cache) the programmable pipeline for the current VS+PS+decl
     * +render-state, build using the executor's shared explicit layout.
     * Returns -1 on shader-compile failure (the draw is then skipped).
     */
    private resolveProgrammablePipeline(
        topology: "triangle-list" | "line-list",
        forceCullNone: boolean,
        strideOverride?: number,
        arenaKey?: number,
    ): number {
        const vs = this.getActiveVsShader();
        if (!vs) return -1;
        const ps = this.getActivePsShader();
        const declElements = this.activeVertexDecl > 0
            ? (this.vsDeclRegistry.get(this.activeVertexDecl) ?? null)
            : null;
        const streamSource = this.stateTracker.getStreamSource();
        const stride = strideOverride ?? streamSource?.stride ?? null;
        const stateBits = this.stateTracker.computePipelineKey() & 0x7FF0000;

        const alphaTest = this.getAlphaTest();
        // Effective cube mask (dcl_cube ∪ bound cube textures) — part of the pipeline identity since
        // the same shader sampled with a 2D vs a cube texture compiles to different texN dimensions.
        const cubeMask = computeCubeMask(ps) | this.boundCubeMask();
        // Per-stage D3DTTFF_PROJECTED key — part of the pipeline identity: the same ps_1_x shader
        // compiles to a projective-divide sample vs a plain sample depending on the stage flag.
        const projKey = this.projectedStageKey();
        const blendKey = computeBlendKey(this.getRS);
        const alphaKey = this.alphaTestKey();
        const depthKey = computeDepthKey(this.getRS);

        // Fast path: identical pipeline identity as the previous draw → return without building the
        // key string or touching the Map (the dominant case within a batch). Shared by both the
        // legacy and arena-keyed paths below — whichever cache backed `_lrPipelineId` last time.
        if (this._lrValid
            && this._lrVs === this.activeVertexShader && this._lrPs === this.activePixelShader
            && this._lrDecl === this.activeVertexDecl && this._lrStride === stride
            && this._lrStateBits === stateBits && this._lrTopo === topology
            && this._lrForceCull === forceCullNone && this._lrBlend === blendKey
            && this._lrAlpha === alphaKey && this._lrDepth === depthKey
            && this._lrCube === cubeMask && this._lrProj === projKey) {
            d3d9PerfBackendInc("progPipelineCacheHits");
            if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheHits++;
            return this._lrPipelineId;
        }

        // WASM-arena fast path (real bypass, only trusted once dbg.d3dWasmPath(true) is
        // on): arenaKey is a Rust-derived numeric
        // identity the caller already computed for free (as part of the mandatory arena
        // record call) — a Map<number,number> lookup here is far cheaper than building the
        // template-string key + Map<string,number> lookup below. It is verified consistent
        // with the legacy key space via dual-run cross-checking
        // BEFORE this fast path is ever taken; falls through to the legacy path below whenever
        // bypass is off, the arena declined this draw, or the arena isn't initialized.
        if (arenaKey !== undefined && arenaKey >= 0 && isWasmPathEnabled()) {
            const cachedViaArena = this.arenaPipelineCache.get(arenaKey);
            if (cachedViaArena !== undefined) {
                d3d9PerfBackendInc("progPipelineCacheHits");
                if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheHits++;
                this._storeLastResolve(stride, stateBits, topology, forceCullNone, blendKey, alphaKey, depthKey, cubeMask, projKey, cachedViaArena);
                return cachedViaArena;
            }
            d3d9PerfBackendInc("progPipelineCacheMisses");
            if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheMisses++;
            const built = this.buildProgrammablePipeline(vs, ps, declElements, stride, stateBits, topology, forceCullNone, alphaTest, cubeMask, projKey);
            this.arenaPipelineCache.set(arenaKey, built);
            this._storeLastResolve(stride, stateBits, topology, forceCullNone, blendKey, alphaKey, depthKey, cubeMask, projKey, built);
            return built;
        }

        const cacheKey = `${this.activeVertexShader}:${this.activePixelShader}:${this.activeVertexDecl}:${stride}:${stateBits}:${topology}:${forceCullNone ? 1 : 0}:${blendKey}:${alphaKey}:${depthKey}:cm${cubeMask}:pj${projKey}`;
        const cached = this.progPipelineCache.get(cacheKey);
        if (cached !== undefined) {
            d3d9PerfBackendInc("progPipelineCacheHits");
            if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheHits++;
            this._storeLastResolve(stride, stateBits, topology, forceCullNone, blendKey, alphaKey, depthKey, cubeMask, projKey, cached);
            return cached;
        }
        d3d9PerfBackendInc("progPipelineCacheMisses");
        if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheMisses++;

        const pipelineId = this.buildProgrammablePipeline(vs, ps, declElements, stride, stateBits, topology, forceCullNone, alphaTest, cubeMask, projKey);
        this.progPipelineCache.set(cacheKey, pipelineId);
        this._storeLastResolve(stride, stateBits, topology, forceCullNone, blendKey, alphaKey, depthKey, cubeMask, projKey, pipelineId);
        return pipelineId;
    }

    /** Pure pipeline build — shared by the legacy string-keyed miss path and the arena
     *  numeric-keyed miss path above. Reads no cache/mutable resolve state itself. */
    private buildProgrammablePipeline(
        vs: CompiledVs,
        ps: CompiledPs | null,
        declElements: RawVertexElement[] | null,
        stride: number | null,
        stateBits: number,
        topology: "triangle-list" | "line-list",
        forceCullNone: boolean,
        alphaTest: ReturnType<D3D9Device["getAlphaTest"]>,
        cubeMask: number,
        projectedStages: number,
    ): number {
        try {
            const link = linkProgram({ vs, ps, declElements, streamStride: stride, alphaTest, cubeMask, projectedStages });
            const gpuDevice = this.backend.getDevice()!;
            const format = this.backend.getFormat()!;
            const module = gpuDevice.createShaderModule({ code: link.wgsl });
            // Cube-sampler stages need a cube-dimension bind-group layout; pick the variant that
            // matches the shader's declared texN dimensions (link.cubeMask == our effective mask).
            const { pipelineLayout } = this.backendExecutor.getProgrammableLayout(link.cubeMask);

            const cullD3D = (stateBits >> 16) & 0xff;
            let cullMode: GPUCullMode = "none";
            if (!forceCullNone) {
                if (cullD3D === D3DCULL_CW) cullMode = "front";
                else if (cullD3D === D3DCULL_CCW) cullMode = "back";
            }
            const pipeline = gpuDevice.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module,
                    entryPoint: "vs_main",
                    buffers: [{
                        arrayStride: (stride && stride > 0) ? stride : link.arrayStride,
                        attributes: link.vertexAttributes,
                    }],
                },
                fragment: { module, entryPoint: "fs_main", targets: [buildColorTargetState(format, this.getRS)] },
                primitive: { topology, frontFace: "cw", cullMode },
                depthStencil: buildDepthStencilState("depth24plus", this.getRS),
            });
            return this.backendExecutor.registerPipeline(pipeline, link.hasTexture, true);
        } catch (e) {
            Logger.error(LogCategory.D3D9, `[D3D9] programmable pipeline build failed: ${e}`);
            return -1;
        }
    }

    /** Remember the just-resolved pipeline identity for the next-draw numeric fast path. VS/PS/decl
     *  come from the current device state (unchanged across the resolve). */
    private _storeLastResolve(stride: number | null, stateBits: number, topo: string, forceCull: boolean,
        blend: string, alpha: string, depth: string, cube: number, proj: number, id: number): void {
        this._lrVs = this.activeVertexShader; this._lrPs = this.activePixelShader; this._lrDecl = this.activeVertexDecl;
        this._lrStride = stride; this._lrStateBits = stateBits; this._lrTopo = topo; this._lrForceCull = forceCull;
        this._lrBlend = blend; this._lrAlpha = alpha; this._lrDepth = depth; this._lrCube = cube; this._lrProj = proj; this._lrPipelineId = id; this._lrValid = true;
    }

    /** Bitmask of stages that currently have a CUBE texture bound. D3D9 ps_1_x / FFP have no
     *  sampler dcls, so cube reflections (NFSU) are only detectable from the bound texture's type;
     *  this is unioned with the PS's declared dcl_cube mask to form the effective cube mask used
     *  for the pipeline layout + shader codegen + bind group (all three must agree). */
    private boundCubeMask(): number {
        let mask = 0;
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            const ti = this.stateTracker.getTexture(stage);
            if (ti !== null && this.textures.isCubeMap(ti)) mask |= (1 << stage);
        }
        return mask;
    }

    /** Bitmask of texture stages with D3DTTFF_PROJECTED set — feeds the ps_1_1-1_3 / fixed-function
     *  projective divide (by .w; the vertex stage places the projective q there). SM≥2 projects
     *  in-shader (texldp); ps_1_4 via the _dw modifier. The divide is always by .w — D3DTTFF_COUNT
     *  only matters for the fixed-function vertex transform, which doesn't run under a vertex shader
     *  (NFSU sets PROJECTED with no COUNT). Part of the pipeline-cache identity. */
    private projectedStageKey(): number {
        let key = 0;
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            const flags = this.textureStageStates.get(this.makeStageStateKey(stage, D3DTSS_TEXTURETRANSFORMFLAGS)) ?? 0;
            if (flags & D3DTTFF_PROJECTED) key |= (1 << stage);
        }
        return key;
    }

    /**
     * Count the fixed-function state this draw needs and `emitFfpShader` ignores.
     *
     * Ignoring it is silent by construction: the draw records, nothing is dropped, WebGPU is
     * happy, and only one class of object goes missing or lands untextured. Naming the feature
     * is what turns "some surfaces are gone" into a work item. Reads the RESOLVED stages, so a
     * state left at its D3D default is not counted as a gap.
     */
    private censusFfpGaps(stages: readonly FfpResolvedStage[]): void {
        const rs = (s: number): number => this.stateTracker.getRenderState(s);
        if (rs(D3DRS_VERTEXBLEND) !== 0) d3d9PerfFfpUnimplemented("vertexBlend");
        if (rs(D3DRS_INDEXEDVERTEXBLENDENABLE) !== 0) d3d9PerfFfpUnimplemented("indexedVertexBlend");
        for (const st of stages) {
            censusStageConstantArg(st);
            // The stage combiner implements a SUBSET of D3DTEXTUREOP and silently substitutes a
            // fallback expression for the rest — in the alpha channel that fallback is the raw
            // texel alpha, which then decides the alpha test. So an unimplemented op does not
            // tint a surface, it deletes it. Histogram every op, not just the missing ones:
            // "nothing missing" is only trustworthy next to the distribution it was read from.
            d3d9PerfFfpOp("color", st.colorOp);
            d3d9PerfFfpOp("alpha", st.alphaOp);
            if (!FFP_IMPLEMENTED_OPS.has(st.colorOp)) d3d9PerfFfpUnimplemented(`colorOp${st.colorOp}`);
            if (!FFP_IMPLEMENTED_OPS.has(st.alphaOp)) d3d9PerfFfpUnimplemented(`alphaOp${st.alphaOp}`);
            const tci = st.texCoordIndex;
            // Generators 0..4 are implemented; anything above is outside the documented
            // D3DTSS_TCI_* enum and would fall through to passthrough unnoticed.
            if (((tci >>> 16) & 0xffff) > 4) d3d9PerfFfpUnimplemented("texCoordGen");
            // Only UV sets 0 and 1 reach the shader as attributes; a higher set samples set 0.
            if ((tci & 0xffff) > 1) d3d9PerfFfpUnimplemented("texCoordSet");
        }
    }

    /** Snapshot the full FFP uniform block + stage-0 texture for one draw. The
     *  guest mutates transforms/stage-ops/TFACTOR/texture between draws, so
     *  FFP draws can't share the frame-level uniform buffer. */

    private captureFfpDrawState(streamAllow: ReadonlySet<number> | null = null): number {
        this.declDrawCounts.set(this.activeVertexDecl, (this.declDrawCounts.get(this.activeVertexDecl) ?? 0) + 1);
        const { w, h } = this.getCurrentTargetSize();
        // Resolved once and shared: the uniform the shader reads and the census that reports
        // what it could not honor must be looking at the same stages.
        const stageCount = this.activeStageCount();
        const stages = this.resolveFfpStages(stageCount);
        const block = this.buildFfpUniformBlock(w, h, stages, streamAllow);
        const frame = this.commandRecorder.getCurrentFrame();
        const index = frame.nextFfpState(block.length);
        const slot = frame.ffpStates[index];
        slot.block.set(block);
        this.censusFfpGaps(stages);
        slot.stageCount = stageCount;
        for (let s = 0; s < stageCount; s++) {
            slot.textures[s] = this.resolveCurrentTexture(s);
            slot.samplers[s] = this.resolveStageSampler(s);
            const ti = this.stateTracker.getTexture(s);
            if (ti !== null && D3D_ALPHALESS_FORMATS.has(this.textures.getFormat(ti))) {
                slot.block[ffpStageOffset(s) + 4 + 2] = 1; // stage.b.z — read alpha as 1.0
            }
        }
        return index;
    }

    /** Snapshot the current VS/PS constants + bound textures for one draw. */
    private captureDrawState(): number {
        const vs = this.getActiveVsShader();
        const ps = this.getActivePsShader();
        const vsLen = Math.min(vs ? vs.analysis.constantCount : 0, 256) * 4;
        const psLen = Math.min(ps ? ps.analysis.constantCount : 0, 224) * 4;

        // Zero-alloc capture: snapshot constants + bound views into a pooled, reused
        // draw-state slot (see RenderFrame.nextDrawState) instead of fresh Float32Arrays /
        // a fresh textures array / a fresh object on every draw. The frame index is the
        // slot count read before nextDrawState bumps it.
        const frame = this.commandRecorder.getCurrentFrame();
        const index = frame.drawStateCount;
        const state = frame.nextDrawState(vsLen, psLen);

        state.vsVersion = this.copyConstantPrefixWithKey(this.vsConstantBits, state.vsBits, vsLen);
        state.psVersion = this.copyConstantPrefixWithKey(this.psConstantBits, state.psBits, psLen);

        // Cube-sampler mask for this PS — must match the pipeline's layout (resolveProgrammablePipeline
        // built it with link.cubeMask, derived identically) so the bind group stays compatible.
        // Effective cube mask = shader dcl_cube ∪ stages with a cube texture bound. MUST equal the
        // mask resolveProgrammablePipeline used to build the pipeline layout (same derivation) so
        // the per-draw bind group stays compatible.
        const cubeMask = computeCubeMask(ps) | this.boundCubeMask();
        state.cubeMask = cubeMask;

        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            const ti = this.stateTracker.getTexture(stage);
            if (ti === null) { state.textures[stage] = null; continue; }
            if (this.isTextureConflictingWithActiveRt(ti)) {
                state.textures[stage] = null;
                continue;
            }
            this.ensureTexture(ti);
            // The bind-group layout slot for this stage is cube (cubeMask bit) or 2D, fixed by the
            // shader. A bound view of the OTHER dimension (e.g. a cube RT still bound on a stage a
            // 2D shader samples) makes the whole bind group invalid → the frame's submit is rejected
            // (blank screen). Only bind the view when its dimension matches the slot; otherwise leave
            // null so the executor supplies the correct-dimension fallback.
            const stageIsCube = ((cubeMask >> stage) & 1) !== 0;
            state.textures[stage] = (stageIsCube === this.textures.isCubeMap(ti))
                ? this.textures.getView(ti)
                : null;
        }

        // The programmable layout has a single shared sampler binding → resolve stage 0's sampler
        // from the game's D3DSAMP_* state via the shared DxSamplerCache (was a hardcoded linear).
        state.sampler = this.resolveStageSampler(0);

        // Identical-consecutive-state elision: consecutive draws that
        // captured an IDENTICAL state collapse to one slot → the recorder skips the redundant
        // BindProgrammable, the executor skips the redundant bind-group/uniform work.
        // vsVersion/psVersion are content hashes (copyConstantPrefixWithKey), textures/sampler
        // compare by GPU-object reference — equality means the bind would be byte-identical.
        const prevIdx = this.lastCaptureIndex;
        if (prevIdx >= 0 && prevIdx < index) {
            const prev = frame.drawStates[prevIdx];
            if (prev
                && prev.vsVersion === state.vsVersion && prev.psVersion === state.psVersion
                && prev.vsLen === state.vsLen && prev.psLen === state.psLen
                && prev.cubeMask === state.cubeMask && prev.sampler === state.sampler) {
                let texEqual = true;
                for (let i = 0; i < PROG_BIND.MAX_TEX; i++) {
                    if (prev.textures[i] !== state.textures[i]) { texEqual = false; break; }
                }
                if (texEqual) {
                    frame.rollbackDrawState();
                    d3d9PerfBackendInc("bindStateElided");
                    return prevIdx;
                }
            }
        }
        this.lastCaptureIndex = index;
        return index;
    }

    /**
     * Resolve the faithful GPU sampler for one texture stage from the game's D3DSAMP_* state.
     * Runs per stage per draw, so the result is memoised per stage; the decode (a closure plus a
     * spec/descriptor/key-string per call) only reruns when one of the descriptor's three input
     * groups actually moved — this stage's D3DSAMP_* block, the quality override, or the device.
     */
    private resolveStageSampler(stage: number): GPUSampler | null {
        const device = this.backend.getDevice();
        if (!device) return null;
        if (!this.samplerCache || device !== this.stageSamplerDevice) {
            this.samplerCache = new DxSamplerCache(device);
            this.stageSamplerDevice = device;
            this.stageSamplersValid = 0;
        }
        const token = DxSamplerCache.qualityToken();
        if (token !== this.stageSamplerQualityToken) {
            this.stageSamplerQualityToken = token;
            this.stageSamplersValid = 0;
        }
        const bit = (stage >>> 0) < FFP_MAX_STAGES ? (1 << stage) : 0;
        if (bit !== 0 && (this.stageSamplersValid & bit) !== 0) return this.stageSamplers[stage]!;

        const sampler = this.samplerCache.acquire(decodeD3d9Sampler((type) => this.getSamplerState(stage, type)));
        if (bit !== 0) {
            this.stageSamplers[stage] = sampler;
            this.stageSamplersValid |= bit;
        }
        return sampler;
    }

    /**
     * Dual-run consistency check between the legacy pipeline-id space and the arena's
     * FNV-hashed pipelineKey space. The two
     * hash schemes are NOT expected to produce numerically equal values for the "same"
     * pipeline identity — what's actually being verified is that whenever two draws share
     * the same legacy id (i.e. legacy treats them as the same cached pipeline), the arena
     * also returns the same key for both, and vice versa. `arenaKey < 0` means the arena
     * declined the draw (FFP, or full this frame) — nothing to compare.
     */
    private crossCheckArenaPipelineKey(arenaKey: number, legacyPipelineId: number): void {
        if (arenaKey < 0) return;
        const expected = this.arenaPipelineCrossCheck.get(legacyPipelineId);
        if (expected === undefined) {
            this.arenaPipelineCrossCheck.set(legacyPipelineId, arenaKey);
            return;
        }
        if (expected !== arenaKey) {
            d3d9WasmArena.incrementMismatchCount();
            this.arenaMismatchLogCounter = (this.arenaMismatchLogCounter + 1) >>> 0;
            // Rate-limited: this can fire every draw of a batch once it starts mismatching.
            if (this.arenaMismatchLogCounter % 500 === 1) {
                Logger.log(LogCategory.D3D9,
                    `[D3D9][arena] pipelineKey inconsistency: legacyId=${legacyPipelineId} ` +
                    `arenaKey=${arenaKey} expectedArenaKey=${expected} ` +
                    `vs=${this.activeVertexShader} ps=${this.activePixelShader} decl=${this.activeVertexDecl}`);
            }
        }
    }

    private submitFrame(present: boolean): void {
        if (!this.commandRecorder.hasWork() && !present) {
            return;
        }

        this.frameCount++;
        const frame = this.commandRecorder.finalize();
        this.lastCaptureIndex = -1; // draw-state slots recycle with the new frame
        if (present) {
            const c = frame.clear.color as any;
            this.frameLogRing.push({
                p: ++this.frameLogSerial,
                hasClear: frame.hasClear,
                flags: frame.clear.flags,
                cmds: frame.commandTypes.length,
                draws: this.frameSnapshot.drawCalls,
                color: `${c.r.toFixed(2)},${c.g.toFixed(2)},${c.b.toFixed(2)}`,
                rtSets: this.rtSetsThisFrame,
                rtNonBack: this.rtNonBackThisFrame,
            });
            if (this.frameLogRing.length > 240) this.frameLogRing.shift();
            this.rtSetsThisFrame = 0;
            this.rtNonBackThisFrame = 0;
        }
        const size = this.backendExecutor.getCanvasSize();
        // When a render target is active, the pass renders into that texture (its own size +
        // depth) instead of the swap-chain offscreen, and never composites overlays / presents.
        let target: { colorView: GPUTextureView; depthView: GPUTextureView } | null = null;
        let vpW = size.width, vpH = size.height;
        const rt = this.currentRtIndex;
        if (rt !== null) {
            // A cube RT renders into one face via a per-face 2D view; the texture's own view is
            // the dimension:"cube" sampling view, which is not a valid color attachment.
            const colorView = this.textures.isCubeMap(rt)
                ? this.getCubeFaceRenderView(rt, this.currentRtFace, 0)
                : this.textures.getView(rt);
            if (colorView) {
                const w = this.textures.getWidth(rt), h = this.textures.getHeight(rt);
                target = { colorView, depthView: this.getRtDepthView(w, h) };
                vpW = w; vpH = h;
            }
        }

        // Programmable (VS/PS) draws carry their own per-draw constants/textures;
        // the frame-level uniforms serve only the FFP path.
        const uniforms: UniformData = {
            viewportWidth: vpW,
            viewportHeight: vpH,
            mvp: this.stateTracker.getMVP(),
            // Expanded FFP uniform block (viewport + MVP + worldView + material/lights/ambient).
            // Consumed by the FFP shader path; the programmable path ignores it.
            ffpBlock: this.buildFfpUniformBlock(vpW, vpH),
        };
        const textureView = this.resolveCurrentTexture();
        const system = System.getInstance();
        const videoOverlayService = system.videoRouting.getOverlayService();
        const gdiContext = this.getGdiContext();
        const composit = present && !target;
        const videoOverlayCanvas = composit && videoOverlayService.hasContent() ? videoOverlayService.getCanvas() : null;
        const gdiOverlayCanvas = composit && gdiContext?.hasOverlayContent() ? gdiContext.getOverlayCanvas() : null;
        // GDI overlay compositing follows the single shared policy (getOverlayCompositePlan):
        // when this 3D renderer owns the screen, GDI windows behind the opaque fullscreen
        // device window are occluded on real Windows (a leftover loading-splash #32770), so
        // only live modal dialog rects composite, never the whole overlay. The executor's
        // rect param encodes the plan: undefined = whole overlay ('full', windowed); [] =
        // composite nothing ('none'); [rects] = only those dialog rects. Passing `this` keys
        // the 3D-owned check off this device.
        let gdiOverlayRects: Array<{ x: number; y: number; w: number; h: number }> | undefined;
        if (gdiOverlayCanvas) {
            const plan = getOverlayCompositePlan(this);
            if (plan.mode === 'rects') gdiOverlayRects = plan.rects;
            else if (plan.mode === 'none') gdiOverlayRects = [];
            // plan.mode === 'full' → leave undefined (composite the whole overlay)
        }

        // Optional verify-only exercise of the executor's arena-drain code path (diagnostic
        // only — reads the arena's command SoA and does lookup/decode bookkeeping, NEVER
        // builds a GPU pipeline/bind-group or touches an encoder). Decoupled from
        // isWasmPathEnabled() on purpose: that flag now drives the REAL bypass fast path in
        // resolveProgrammablePipeline, so auto-running this on every bypass frame would be
        // pure overhead taxing the exact perf number bypass mode is meant to improve. Opt in
        // via dbg.d3dArenaVerifyDrain(true) only when diagnosing the SoA decode path itself.
        if (isArenaVerifyDrainEnabled() && d3d9WasmArena.isInitialized()) {
            this.backendExecutor.drainArenaVerifyOnly();
        }

        this.backendExecutor.execute(frame, uniforms, textureView, present, {
            videoOverlayCanvas,
            gdiOverlayCanvas,
            gdiOverlayRects,
        }, target);

        // Return DrawPrimitiveUP vertex buffers to the reuse pool. execute() has already
        // issued queue.submit, so by WebGPU queue ordering the next frame's writeBuffer
        // into a recycled buffer is sequenced after this frame's draws that read it —
        // safe to reuse without a GPU fence.
        if (this.vbPool && frame.pooledBuffers.length > 0) {
            const pooled = frame.pooledBuffers;
            for (let i = 0; i < pooled.length; i++) this.vbPool.release(pooled[i]);
            pooled.length = 0;
        }

        if (present) {
            if (videoOverlayCanvas) {
                videoOverlayService.consumeDirty();
            }
            if (gdiContext?.isOverlayDirty()) {
                gdiContext.clearOverlayDirty();
            }
        }

        // Same lifecycle boundary as the legacy RenderFrame's pool-acquire reset above
        // (commandRecorder.finalize() already handed out a fresh RenderFrame for the next
        // batch) — rewind the arena's command SoA + bump cursor for the next submitFrame,
        // and drop this frame's dual-run cross-check map alongside it.
        if (d3d9WasmArena.isInitialized()) {
            d3d9WasmArena.resetFrame();
            this.arenaPipelineCrossCheck.clear();
        }
    }

    /**
     * Ensures the GDI overlay is cleared for the current frame.
     * This should be called before any GDI drawing operation in a new frame.
     * 
     * NOTE: Overlay is no longer automatically cleared here.
     * Overlay should persist between frames and only be cleared on explicit Clear() calls.
     */
    ensureOverlayClearedForFrame(): void {
        // Overlay should persist between frames
        // Only clear on explicit Clear() calls from the application
        if (this.lastOverlayClearFrame !== this.frameCount) {
            this.lastOverlayClearFrame = this.frameCount;
        }
    }

    private updateFps(): void {
        const now = TimeService.getInstance().nowMs();
        if (this.lastPresentTime > 0) {
            const delta = now - this.lastPresentTime;
            if (delta > 0) {
                const instant = 1000 / delta;
                this.fps = this.fps === 0 ? instant : (this.fps * 0.9 + instant * 0.1);
            }
        }
        this.lastPresentTime = now;
    }

    /** WebGPU forbids sampling a GPUTexture in the same render pass that writes it as an
     *  attachment (even via different views — e.g. cube face RT vs cube sampling view). */
    private isTextureConflictingWithActiveRt(textureIndex: number): boolean {
        return this.currentRtIndex !== null && textureIndex === this.currentRtIndex;
    }

    private resolveCurrentTexture(stage = 0): GPUTextureView | null {
        const textureIndex = this.stateTracker.getTexture(stage);
        if (textureIndex === null) {
            return null;
        }
        if (this.isTextureConflictingWithActiveRt(textureIndex)) {
            return null;
        }
        // The FFP bind-group layout's texture slot is 2D; a cube view would make it invalid.
        if (this.textures.isCubeMap(textureIndex)) return null;
        this.ensureTexture(textureIndex);
        return this.textures.getView(textureIndex);
    }

    private ensureTexture(index: number): void {
        const device = this.backend.getDevice()!;
        // Render-target textures own their GPU texture (created in createTexture, populated by
        // rendering). Never recreate or upload guest pixels over the rendered content.
        if (this.textures.isRenderTarget(index)) return;
        // Cube textures own a 6-layer GPU texture created in createCubeTexture; upload LockRect'd
        // faces only (their sampling view is the cube view — never replace it with a 2D view).
        if (this.textures.isCubeMap(index)) { this.ensureCubeTexture(index, device); return; }
        const data = this.textures.getData(index);
        if (!data) return;

        const texFormat = this.textures.getFormat(index);
        if (isBlockCompressedFormat(texFormat)) {
            this.ensureDxtTexture(index, device, data, texFormat);
            return;
        }

        const width = this.textures.getWidth(index);
        const height = this.textures.getHeight(index);
        const handle = this.textures.getHandle(index);

        // How many mip levels we can actually back with authored data (level 0 + contiguous mips the
        // guest LockRect'd). Conservative: never create empty slots that would sample as black.
        const levelCount = effectiveMipLevels(
            this.textures.getLevels(index), width, height,
            (lvl) => this.mipLevelData.has(`${handle}:${lvl}`),
        );

        let gpuTexture = this.textures.getGpuTexture(index);
        // (Re)create when missing, or when the authored level count changed (mips uploaded after the
        // texture was first bound). We replace the reference rather than destroy() the old texture so
        // any bind group still holding the previous view stays valid until it naturally expires.
        if (!gpuTexture || gpuTexture.mipLevelCount !== levelCount) {
            gpuTexture = device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                mipLevelCount: levelCount,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            // Default view covers all mip levels → the sampler's mip filter has a chain to walk.
            this.textures.setGpuTexture(index, gpuTexture, gpuTexture.createView());
            this.textures.setDirty(index, true);
        }

        if (this.textures.isDirty(index)) {
            const size = width * height * 4;
            // Reuse conversion buffer to avoid GC pressure (sized for level 0, the largest).
            if (!this.textureConversionBuffer || this.textureConversionBuffer.length < size) {
                this.textureConversionBuffer = new Uint8Array(size);
            }

            const queue = this.backend.getQueue()!;
            let uploadedBytes = 0;

            // Decode native-format pixels → RGBA8. 32-bit ARGB uses the fast in-place path; 16-bit
            // formats (R5G6B5 / A1R5G5B5 / X1R5G5B5 / A4R4G4B4) go through the mask-based converter —
            // they were previously uploaded verbatim as ARGB8888, i.e. wrong colors. The guest wrote
            // at the LockRect pitch we returned, so we read each row back at that same stride.
            // (8-/24-bit exotic formats stay on the legacy path — palette/luminance is a follow-up.)
            const decode = (src: Uint8Array, w: number, h: number, pitch: number, out: Uint8Array): void => {
                decodeD3DTextureToRgba8(src, 0, w, h, texFormat, { pitch, out });
            };

            // Level 0 (from the texture's HEAP store).
            const rgba0 = this.textureConversionBuffer.subarray(0, size);
            decode(data, width, height, this.textures.getPitch(index), rgba0);
            queue.writeTexture(
                { texture: gpuTexture, mipLevel: 0 },
                rgba0 as any,
                { bytesPerRow: width * 4 },
                { width, height, depthOrArrayLayers: 1 },
            );
            uploadedBytes += size;

            // Authored mip levels 1..N-1 (from the per-level side buffer), each to its own GPU slot.
            for (let lvl = 1; lvl < levelCount; lvl++) {
                const px = this.getTextureLevelPixels(handle, lvl);
                if (!px) continue;
                const lvlSize = px.width * px.height * 4;
                const lvlRgba = new Uint8Array(lvlSize); // small + rare; not worth pooling
                decode(px.data, px.width, px.height, px.pitch, lvlRgba);
                queue.writeTexture(
                    { texture: gpuTexture, mipLevel: lvl },
                    lvlRgba as any,
                    { bytesPerRow: px.width * 4 },
                    { width: px.width, height: px.height, depthOrArrayLayers: 1 },
                );
                uploadedBytes += lvlSize;
            }

            this.textures.setDirty(index, false);

            if (this.frameSnapshot.frameCounters) {
                this.frameSnapshot.frameCounters.uploads++;
                this.frameSnapshot.frameCounters.textureBytes += uploadedBytes;
            }
        }
    }

    /**
     * Upload a DXT/BC-compressed texture. Primary path: native bc1/2/3-rgba-unorm
     * (hardware decode, the blocks are uploaded verbatim). Fallback: CPU block
     * decode to rgba8unorm when the device lacks `texture-compression-bc` or the
     * dimensions are not 4×4-block-aligned (WebGPU rejects unaligned BC copies).
     * The GPU texture is sampled as texture_2d<f32> either way — no shader change.
     */
    private ensureDxtTexture(index: number, device: GPUDevice, data: Uint8Array, format: number): void {
        const width = this.textures.getWidth(index);
        const height = this.textures.getHeight(index);
        const useBc = canUploadNativeBC(format, width, height, this.backend.supportsBC());

        let gpuTexture = this.textures.getGpuTexture(index);
        if (!gpuTexture) {
            gpuTexture = device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format: useBc ? getNativeBCTextureFormat(format)! : "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            const view = gpuTexture.createView();
            this.textures.setGpuTexture(index, gpuTexture, view);
            this.textures.setDirty(index, true);
        }

        if (!this.textures.isDirty(index)) return;

        // The guest locked this surface at the registry pitch (width*4) and wrote
        // its DXT block rows at that same stride, so we read them back at width*4.
        const srcPitch = this.textures.getPitch(index);
        if (useBc) {
            // Upload compressed blocks straight to the BC texture.
            this.backend.getQueue()!.writeTexture(
                { texture: gpuTexture },
                data as any,
                { bytesPerRow: srcPitch },
                { width, height, depthOrArrayLayers: 1 }
            );
        } else {
            const size = width * height * 4;
            if (!this.textureConversionBuffer || this.textureConversionBuffer.length < size) {
                this.textureConversionBuffer = new Uint8Array(size);
            }
            const rgba = this.textureConversionBuffer.subarray(0, size);
            decodeD3DTextureToRgba8(data, 0, width, height, format, { pitch: srcPitch, out: rgba });
            this.backend.getQueue()!.writeTexture(
                { texture: gpuTexture },
                rgba as any,
                { bytesPerRow: width * 4 },
                { width, height, depthOrArrayLayers: 1 }
            );
        }

        this.textures.setDirty(index, false);
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.uploads++;
            this.frameSnapshot.frameCounters.textureBytes += data.length;
        }
    }

    /**
     * Upload LockRect'd pixels for a (static) cube texture. The 6-layer GPU texture and its
     * dimension:"cube" sampling view were created eagerly in createCubeTexture; here we only
     * push authored face/level pixels into their array layer (origin.z = face). Faces never
     * locked stay zero-initialised (transparent) — faithful to a half-authored cube.
     */
    private ensureCubeTexture(index: number, device: GPUDevice): void {
        let gpuTexture = this.textures.getGpuTexture(index);
        if (!gpuTexture) return; // created eagerly in createCubeTexture; defensive only
        if (!this.textures.isDirty(index)) return;

        const handle = this.textures.getHandle(index);
        const format = this.textures.getFormat(index);
        const levels = gpuTexture.mipLevelCount;
        const queue = this.backend.getQueue()!;

        let uploadedBytes = 0;

        for (let face = 0; face < 6; face++) {
            for (let lvl = 0; lvl < levels; lvl++) {
                const px = this.cubeFaceData.get(`${handle}:${face}:${lvl}`);
                if (!px) continue;
                const dim = Math.max(1, this.textures.getWidth(index) >>> lvl);
                const rgbaSize = dim * dim * 4;
                const rgba = new Uint8Array(rgbaSize);
                const pitch = getD3DTextureLayout(format, dim, dim).pitch;
                decodeD3DTextureToRgba8(px, 0, dim, dim, format, { pitch, out: rgba });
                queue.writeTexture(
                    { texture: gpuTexture, mipLevel: lvl, origin: { x: 0, y: 0, z: face } },
                    rgba as any,
                    { bytesPerRow: dim * 4 },
                    { width: dim, height: dim, depthOrArrayLayers: 1 },
                );
                uploadedBytes += rgbaSize;
            }
        }

        this.textures.setDirty(index, false);
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.uploads++;
            this.frameSnapshot.frameCounters.textureBytes += uploadedBytes;
        }
    }

    /**
     * Ensure conversion buffer is large enough and return a view of the required size
     */
    private ensureConversionBuffer(size: number): Uint8Array {
        // Padded to a 4-byte multiple because callers hand the returned view straight to
        // queue.writeBuffer, which throws on any other length (see RenderFrame.queueUpload).
        const padded = (size + 3) & ~3;
        if (!this.vertexConversionBuffer || this.vertexConversionBufferSize < padded) {
            this.vertexConversionBuffer = new Uint8Array(padded);
            this.vertexConversionBufferSize = padded;
        }
        return this.vertexConversionBuffer.subarray(0, padded);
    }

    private ensureIndexScratch(count: number): Uint32Array {
        if (!this.indexScratch || this.indexScratch.length < count) {
            this.indexScratch = new Uint32Array(count);
        }
        return this.indexScratch;
    }

    private getGdiContext() {
        return System.getInstance().gdiContext;
    }

    /**
     * Get debug resources info for debug panel
     */
    getDebugResourcesInfo(scope: "summary" | "full" = "summary", onlyActive: boolean = false): {
        textures: Array<{
            handle: number;
            width: number;
            height: number;
            levels: number;
            format: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuTexture: boolean;
        }>;
        vertexBuffers: Array<{
            handle: number;
            size: number;
            fvf: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuBuffer: boolean;
        }>;
        indexBuffers: Array<{
            handle: number;
            size: number;
            format: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuBuffer: boolean;
        }>;
        pipelineCacheSize: number;
    } {
        const textures = this.textures.getAllDebugInfo();
        const vertexBuffers = this.vertexBuffers.getAllDebugInfo();
        const indexBuffers = this.indexBuffers.getAllDebugInfo();
        
        // Filter by scope if needed
        let filteredTextures = textures;
        let filteredVBs = vertexBuffers;
        let filteredIBs = indexBuffers;
        
        if (onlyActive) {
            // For D3D9, "active" means currently bound or dirty
            filteredTextures = textures.filter(t => t.isDirty || t.isLocked);
            filteredVBs = vertexBuffers.filter(vb => vb.isDirty || vb.isLocked);
            filteredIBs = indexBuffers.filter(ib => ib.isDirty || ib.isLocked);
        }
        
        return {
            textures: filteredTextures,
            vertexBuffers: filteredVBs,
            indexBuffers: filteredIBs,
            pipelineCacheSize: this.pipelineCache.size,
        };
    }

    /**
     * Get frame snapshot for debug panel
     */
    getFrameSnapshot() {
        return { ...this.frameSnapshot };
    }

    /**
     * Set debug toggle (for debug panel)
     */
    setDebugToggle(toggle: string, enabled: boolean): void {
        // D3D9 debug toggles can be implemented here if needed
        // For now, just acknowledge the call
    }

    // ── State blocks ─────────────────────────────────────────────────────

    private recordStateBlock(entry: StateBlockEntry): void {
        if (!this.suppressStateBlockRecording) {
            this.stateBlockRecorder.record(entry);
        }
    }

    /**
     * True when a Set* call must be journaled into the active state block.
     * Hoist this to the call site so the per-call StateBlockEntry object — and,
     * for the constant/transform/material setters, a snapshot Float32Array/Uint8Array —
     * is built ONLY while a BeginStateBlock recording is open. During normal rendering
     * (the overwhelmingly common case) these setters fire 100K+/sec; the old code
     * allocated a throwaway entry (and a fresh typed array) on every call and let
     * recordStateBlock drop it. That churn was the GC source behind the frame-time
     * spikes (NFSU's ~550K throwaway Float32Arrays/sec from Set*ShaderConstantF).
     */
    private get recordingStateBlock(): boolean {
        return !this.suppressStateBlockRecording && this.stateBlockRecorder.isRecording();
    }

    isRecordingStateBlock(): boolean {
        return this.stateBlockRecorder.isRecording();
    }

    beginStateBlock(): number {
        if (this.stateBlockRecorder.isRecording()) {
            return 0x88760825; // D3DERR_INBEGINSTATEBLOCK
        }
        this.stateBlockRecorder.begin();
        return 0;
    }

    endStateBlock(): { hr: number; entries: StateBlockEntry[] } {
        if (!this.stateBlockRecorder.isRecording()) {
            return { hr: 0x88760826, entries: [] }; // D3DERR_NOTINBEGINSTATEBLOCK
        }
        return { hr: 0, entries: this.stateBlockRecorder.end() };
    }

    createStateBlockData(blockType: number): D3D9StateBlockData {
        return {
            devicePtr: 0,
            blockType,
            entries: captureStateToEntries(this, blockType),
        };
    }

    applyStateBlockData(data: D3D9StateBlockData): number {
        d3d9PerfStateBlockApply(data.coverable === true);
        this.suppressStateBlockRecording = true;
        try {
            if (data.wasmSlot !== undefined) {
                // WASM diffs the slot against the live mirror; only the actual
                // deltas come back, replayed through the ordinary setters (which keep
                // the JS tracker, the mirror, and the setter shadow coherent — the
                // arena never writes device state itself).
                d3d9PerfStateBlockWasmApply();
                const n = d3d9WasmArena.blockApply(data.wasmSlot);
                if (n > 0) {
                    const pairs = d3d9WasmArena.changedPairs();
                    // BLOCK_CHANGED_CAP guard (no silent caps): today the diff can emit at
                    // most 256 RS + 16 sampler + 4+4 const ranges = 280 < cap, but if the
                    // Rust side ever grows past the cap it drops deltas silently — surface it.
                    if (n * 2 >= pairs.length) {
                        Logger.warn(LogCategory.D3D9,
                            `applyStateBlockData: changed-list hit capacity (${n} pairs) — state deltas may have been dropped`);
                    }
                    let views: ReturnType<typeof d3d9WasmArena.blockSlotViews> | null = null;
                    for (let i = 0; i < n; i++) {
                        const k = pairs[i * 2]!;
                        const val = pairs[i * 2 + 1]!;
                        const kind = k >>> 16;
                        const idx = k & 0xffff;
                        if (kind === 0) {
                            this.setRenderState(idx, val | 0);
                        } else if (kind === 1) {
                            this.setSamplerState(0, idx, val | 0);
                        } else {
                            views ??= d3d9WasmArena.blockSlotViews(data.wasmSlot);
                            const ranges = kind === 2 ? views.vsRanges : views.psRanges;
                            const start = ranges[idx * 2]!;
                            const count = ranges[idx * 2 + 1]!;
                            const floats = views.constPool.subarray(val, val + count);
                            if (kind === 2) this.setVertexShaderConstantFFromArray(start, floats, this.memory);
                            else this.setPixelShaderConstantFFromArray(start, floats, this.memory);
                        }
                    }
                }
                if (data.handleEntries && data.handleEntries.length > 0) {
                    applyStateBlockEntries(this, data.handleEntries, this.memory);
                }
            } else {
                applyStateBlockEntries(this, data.entries, this.memory);
            }
        } finally {
            this.suppressStateBlockRecording = false;
        }
        return 0;
    }

    captureStateBlockData(data: D3D9StateBlockData): number {
        d3d9PerfStateBlockCapture(data.coverable === true);
        releaseStateBlockRefs(data);
        if (data.wasmSlot !== undefined) {
            // Bulk values refresh in WASM (memcpy from the live mirror —
            // refresh-only semantics, the recorded set is the slot's masks/ranges);
            // the few handle-shaped entries refresh on the JS path.
            d3d9PerfStateBlockWasmCapture();
            d3d9WasmArena.blockCapture(data.wasmSlot);
            if (data.handleEntries && data.handleEntries.length > 0) {
                refreshCapturedEntries(this, data.handleEntries);
            }
            retainStateBlockRefs(data);
            return 0;
        }
        if (data.entries.length > 0) {
            refreshCapturedEntries(this, data.entries);
        } else if (data.blockType !== 0) {
            data.entries = captureStateToEntries(this, data.blockType);
            data.coverable = classifyStateBlockCoverage(data.entries).coverable;
        }
        retainStateBlockRefs(data);
        return D3D_OK;
    }

    getBoundTexturePtr(stage: number): number {
        return this.boundTexturePtrs[stage] ?? 0;
    }

    getBoundIndexBufferPtr(): number {
        return this.boundIndexPtr;
    }

    getAllRenderStates(): Array<{ state: number; value: number }> {
        const out: Array<{ state: number; value: number }> = [];
        for (let state = 0; state < 256; state++) {
            const value = this.getRenderState(state);
            if (value !== 0) {
                out.push({ state, value });
            }
        }
        return out;
    }

    getAllTextureStageStates(): Array<{ stage: number; type: number; value: number }> {
        const out: Array<{ stage: number; type: number; value: number }> = [];
        for (const [key, value] of this.textureStageStates) {
            const stage = (key >>> 16) & 0xffff;
            const type = key & 0xffff;
            out.push({ stage, type, value });
        }
        return out;
    }

    getAllSamplerStates(): Array<{ sampler: number; type: number; value: number }> {
        const out: Array<{ sampler: number; type: number; value: number }> = [];
        for (const [key, value] of this.samplerStates) {
            const sampler = (key >>> 16) & 0xffff;
            const type = key & 0xffff;
            out.push({ sampler, type, value });
        }
        return out;
    }

    getAllTransforms(): Array<{ state: number; matrix: Float32Array }> {
        const out: Array<{ state: number; matrix: Float32Array }> = [];
        for (const state of [D3DTS_WORLD, D3DTS_VIEW, D3DTS_PROJECTION]) {
            const matrix = this.getTransform(state);
            if (matrix) {
                out.push({ state, matrix });
            }
        }
        // D3DTS_TEXTURE0..7 are vertex state too: a D3DSBT_VERTEXSTATE block that restored the
        // stage's TEXTURETRANSFORMFLAGS but not its matrix would restore half a transform.
        for (let s = 0; s < FFP_TEXTURE_TRANSFORM_COUNT; s++) {
            const state = D3DTS_TEXTURE0 + s;
            const matrix = this.getTransform(state);
            if (matrix) out.push({ state, matrix });
        }
        return out;
    }

    getAllLights(): Array<{ index: number; data: Uint8Array }> {
        return [...this.lights.entries()].map(([index, data]) => ({ index, data }));
    }

    getAllLightEnables(): Array<{ index: number; enable: number }> {
        return [...this.lightEnables.entries()].map(([index, enable]) => ({ index, enable }));
    }

    getAllClipPlanes(): Array<{ index: number; plane: Float32Array }> {
        return [...this.clipPlanes.entries()].map(([index, plane]) => ({ index, plane }));
    }

    getVertexShaderConstants(start: number, vector4fCount: number): Float32Array {
        const baseIdx = start * 4;
        const count = vector4fCount * 4;
        const out = new Float32Array(count);
        for (let i = 0; i < count && baseIdx + i < this.vsConstants.length; i++) {
            out[i] = this.vsConstants[baseIdx + i]!;
        }
        return out;
    }

    getPixelShaderConstants(start: number, vector4fCount: number): Float32Array {
        const baseIdx = start * 4;
        const count = vector4fCount * 4;
        const out = new Float32Array(count);
        for (let i = 0; i < count && baseIdx + i < this.psConstants.length; i++) {
            out[i] = this.psConstants[baseIdx + i]!;
        }
        return out;
    }

    getAllVertexShaderConstants(): Float32Array {
        let last = 0;
        for (let i = this.vsConstants.length - 1; i >= 0; i--) {
            if (this.vsConstants[i] !== 0) {
                last = i + 1;
                break;
            }
        }
        return last > 0 ? new Float32Array(this.vsConstants.subarray(0, last)) : new Float32Array(0);
    }

    getAllPixelShaderConstants(): Float32Array {
        let last = 0;
        for (let i = this.psConstants.length - 1; i >= 0; i--) {
            if (this.psConstants[i] !== 0) {
                last = i + 1;
                break;
            }
        }
        return last > 0 ? new Float32Array(this.psConstants.subarray(0, last)) : new Float32Array(0);
    }
}

// Point-sprite quad corners (screen space, +y down). Corner (0,0) UV = top-left = (-half,-half).
// 6 indices = 2 triangles; winding is irrelevant (points are never culled → forceCullNone).
const PS_CX = [-1, 1, -1, 1] as const; // per-corner x sign
const PS_CY = [-1, -1, 1, 1] as const; // per-corner y sign (screen down)
const PS_U = [0, 1, 0, 1] as const;    // generated sprite U
const PS_V = [0, 0, 1, 1] as const;    // generated sprite V
const PS_TRI = [0, 1, 2, 2, 1, 3] as const;

function d3dColorToGpu(color: number): GPUColor {
    const a = (color >>> 24) & 0xff;
    const r = (color >>> 16) & 0xff;
    const g = (color >>> 8) & 0xff;
    const b = color & 0xff;
    return {
        r: r / 255,
        g: g / 255,
        b: b / 255,
        a: a / 255,
    };
}

/**
 * Parsed FVF stream-0 layout in D3D byte order (position, normal, psize, diffuse,
 * specular, texcoord sets), with contiguous shader locations. Shared by
 * buildVertexLayout (GPU attributes) and buildShader (WGSL inputs) so the two never
 * drift — important because every optional component shifts what follows it.
 *
 * `stride` is the whole vertex, INCLUDING components we declare no attribute for
 * (blend weights, point size, texcoord sets past the first). Getting that total wrong
 * is not a missing feature but corrupt geometry: the GPU walks the stream by
 * arrayStride, so a short stride reads every vertex after the first from the middle of
 * its predecessor.
 */
interface FvfLayout {
    hasRhw: boolean;
    hasNormal: boolean;
    hasColor: boolean;
    hasSpecular: boolean;
    hasTex: boolean;
    /** Texture coordinate sets present (D3DFVF_TEXCOUNT). Sets 0 and 1 get attributes
     *  (stages 0 and 1); further sets occupy stride only. */
    texCount: number;
    hasTex1: boolean;
    posLoc: number; posOff: number;
    normalLoc: number; normalOff: number;
    colorLoc: number; colorOff: number;
    specularLoc: number; specularOff: number;
    texLoc: number; texOff: number;
    tex1Loc: number; tex1Off: number;
    stride: number;
}

const D3DFVF_TEXCOUNT_MASK = 0x0f00;
const D3DFVF_TEXCOUNT_SHIFT = 8;

/** Bytes the FVF position component occupies (d3d9types.h D3DFVF_POSITION_MASK values).
 *  XYZBn carries n blend weights after the xyz triple; the last one may be packed as
 *  UBYTE4/D3DCOLOR instead of a float (D3DFVF_LASTBETA_*), which costs the same 4 bytes. */
function fvfPositionBytes(fvf: number): number {
    switch (fvf & 0x000e) {
        case 0x0002: return (fvf & 0x4000) ? 16 : 12; // XYZ / XYZW
        case 0x0004: return 16;                        // XYZRHW
        case 0x0006: return 16;                        // XYZB1
        case 0x0008: return 20;                        // XYZB2
        case 0x000a: return 24;                        // XYZB3
        case 0x000c: return 28;                        // XYZB4
        case 0x000e: return 32;                        // XYZB5
        default: return 12;
    }
}

/** Floats in texture coordinate set `i` — 2 unless D3DFVF_TEXCOORDSIZE{1,3,4} says otherwise
 *  (2 bits per set from bit 16; 0=float2, 1=float3, 2=float4, 3=float1). */
function fvfTexCoordFloats(fvf: number, set: number): number {
    switch ((fvf >>> (16 + set * 2)) & 3) {
        case 1: return 3;
        case 2: return 4;
        case 3: return 1;
        default: return 2;
    }
}

function parseFvf(fvf: number): FvfLayout {
    const hasRhw = (fvf & D3DFVF_XYZRHW) !== 0;
    // RHW (pre-transformed) vertices carry no normal and skip lighting.
    const hasNormal = !hasRhw && (fvf & D3DFVF_NORMAL) !== 0;
    const hasPsize = (fvf & D3DFVF_PSIZE) !== 0;
    const hasColor = (fvf & D3DFVF_DIFFUSE) !== 0;
    const hasSpecular = (fvf & D3DFVF_SPECULAR) !== 0;
    const texCount = (fvf & D3DFVF_TEXCOUNT_MASK) >>> D3DFVF_TEXCOUNT_SHIFT;
    // Sets 0 and 1 feed texture stages 0 and 1; sets past those still occupy stride and must
    // be stepped over even though nothing samples them.
    const hasTex = texCount > 0 && fvfTexCoordFloats(fvf, 0) >= 2;
    const hasTex1 = texCount > 1 && fvfTexCoordFloats(fvf, 1) >= 2;

    let loc = 0, off = 0;
    const posLoc = loc++; const posOff = off; off += fvfPositionBytes(fvf);
    let normalLoc = -1, normalOff = 0;
    if (hasNormal) { normalLoc = loc++; normalOff = off; off += 12; }
    if (hasPsize) off += 4;
    let colorLoc = -1, colorOff = 0;
    if (hasColor) { colorLoc = loc++; colorOff = off; off += 4; }
    let specularLoc = -1, specularOff = 0;
    if (hasSpecular) { specularLoc = loc++; specularOff = off; off += 4; }
    let texLoc = -1, texOff = 0, tex1Loc = -1, tex1Off = 0;
    for (let i = 0; i < texCount; i++) {
        if (i === 0 && hasTex) { texLoc = loc++; texOff = off; }
        if (i === 1 && hasTex1) { tex1Loc = loc++; tex1Off = off; }
        off += fvfTexCoordFloats(fvf, i) * 4;
    }

    return {
        hasRhw, hasNormal, hasColor, hasSpecular, hasTex, hasTex1, texCount,
        posLoc, posOff, normalLoc, normalOff, colorLoc, colorOff,
        specularLoc, specularOff, texLoc, texOff, tex1Loc, tex1Off, stride: off,
    };
}

const FFP_UNPACK_COLOR_WGSL = `
fn unpackColor(color: u32) -> vec4<f32> {
    let a = f32((color >> 24u) & 0xffu) / 255.0;
    let r = f32((color >> 16u) & 0xffu) / 255.0;
    let g = f32((color >> 8u) & 0xffu) / 255.0;
    let b = f32(color & 0xffu) / 255.0;
    return vec4<f32>(r, g, b, a);
}`;

/**
 * Assemble a fixed-function WGSL shader. Both the FVF path (buildShader) and the vertex-
 * declaration path (buildShaderFromDecl) feed prebuilt input fields + colour expressions
 * here, so the lighting / transform / texture-modulate body lives in one place.
 *
 * When `lit`, the vertex shader runs the full FFP lighting model (see ffp-lighting.ts),
 * gated at runtime on D3DRS_LIGHTING (u.ctrl0.y) so a single pipeline serves a material
 * that toggles lighting per draw. Specular is carried separately and added after the
 * texture stage, matching D3D (specular is not modulated by the texture).
 */
function emitFfpShader(d: {
    inputFields: string[];
    hasRhw: boolean;
    hasTex: boolean;
    /** A second FVF texcoord set is present — a stage can sample its own coordinates. */
    hasTex1?: boolean;
    /** Some active stage generates its own coordinates (D3DTSS_TCI_*). Only load-bearing when
     *  the vertex carries NO texcoord: whether the shader declares samplers at all is then a
     *  structural choice a uniform cannot make, so it is part of the pipeline cache key. */
    texGen?: boolean;
    /** Texture blend stages to emit (1..FFP_MAX_STAGES); baked into the pipeline. */
    stageCount?: number;
    lit: boolean;
    colorExpr: string;
    specularExpr: string;
    normalExpr: string;
    alphaTest: AlphaTest | null;
}): string {
    // Pre-transformed (XYZRHW) vertices arrive in screen pixels with rhw = 1/w. Emitting them
    // with clip w = 1 would rasterize in the right place but interpolate every varying
    // AFFINELY — UVs shear across large polygons and swim as the camera moves, the classic
    // no-perspective-correction look. Recover w = 1/rhw and scale the clip coords by it: the
    // hardware divides back out to the same NDC, and now interpolates perspective-correctly.
    // Z is clamped to [0,1] first (D3D's rule for pre-transformed vertices) so an out-of-range
    // depth does not clip the triangle away. Matches the DDraw/D3D7 converter's treatment.
    const posBody = d.hasRhw
        ? `let rhw = input.pos.w;
        let w = select(1.0, 1.0 / rhw, rhw != 0.0);
        let ndcX = (input.pos.x / u.viewport.x) * 2.0 - 1.0;
        let ndcY = 1.0 - (input.pos.y / u.viewport.y) * 2.0;
        out.position = vec4<f32>(ndcX * w, ndcY * w, clamp(input.pos.z, 0.0, 1.0) * w, w);`
        : `out.position = u.mvp * vec4<f32>(input.pos, 1.0);`;

    // FFP user clip planes. D3D fixed-function evaluates the plane equations in WORLD space
    // (DXVK d3d9_fixed_function_vert.vert emitVsClipping: worldPos = InverseView·viewPos ==
    // World·objPos, dist = dot(worldPos, plane), plane kept RAW). We upload WORLD directly, so
    // worldPos = u.world · objPos. Skipped for pre-transformed (XYZRHW) draws — no world xform.
    // The signed distances are interpolated to the fragment stage, which discards where any
    // ENABLED plane's distance is negative (portable stand-in for the optional clip-distance
    // builtin). Inert when clipPlaneEnable (u.ctrl2.z) == 0 — no branch, no discard.
    const clipVsBody = d.hasRhw
        ? `out.clipA = vec4<f32>(1.0); out.clipB = vec2<f32>(1.0);`
        : `if (u32(u.ctrl2.z) != 0u) {
            let wp = u.world * vec4<f32>(input.pos, 1.0);
            out.clipA = vec4<f32>(dot(wp, u.clipPlanes[0]), dot(wp, u.clipPlanes[1]), dot(wp, u.clipPlanes[2]), dot(wp, u.clipPlanes[3]));
            out.clipB = vec2<f32>(dot(wp, u.clipPlanes[4]), dot(wp, u.clipPlanes[5]));
        } else {
            out.clipA = vec4<f32>(1.0); out.clipB = vec2<f32>(1.0);
        }`;
    const clipFsBody = `let _clipEnable = u32(u.ctrl2.z);
    if (_clipEnable != 0u) {
        if ((_clipEnable & 1u) != 0u && input.clipA.x < 0.0) { discard; }
        if ((_clipEnable & 2u) != 0u && input.clipA.y < 0.0) { discard; }
        if ((_clipEnable & 4u) != 0u && input.clipA.z < 0.0) { discard; }
        if ((_clipEnable & 8u) != 0u && input.clipA.w < 0.0) { discard; }
        if ((_clipEnable & 16u) != 0u && input.clipB.x < 0.0) { discard; }
        if ((_clipEnable & 32u) != 0u && input.clipB.y < 0.0) { discard; }
    }`;

    // One (sampler, texture) binding pair per emitted stage — pairs 1/2 for stage 0, 3/4 for
    // stage 1, and so on. The bind-group LAYOUT always declares all FFP_MAX_STAGES pairs (a
    // pipeline layout may be a superset of what a shader uses), so a 1-stage shader and an
    // 8-stage one share one cached bind group shape.
    const stageCount = Math.max(1, Math.min(d.stageCount ?? 1, FFP_MAX_STAGES));
    // A stage samples whenever the pipeline was built to: either the vertex carries texture
    // coordinates, or a stage generates its own (D3DTSS_TCI_*) and needs no attribute at all.
    const samples = d.hasTex || d.texGen;
    const stageBindings = samples
        ? Array.from({ length: stageCount }, (_unused, s) =>
            `@group(0) @binding(${1 + s * 2}) var texSampler${s || ""}: sampler;\n` +
            `@group(0) @binding(${2 + s * 2}) var tex${s || ""}: texture_2d<f32>;`).join("\n")
        : "";

    /**
     * D3D's texture-stage cascade, unrolled: stage 0 combines the sampled texel with the
     * vertex colour, every stage after it combines its own texel with the previous stage's
     * result (D3DTA_CURRENT). Ops and args are read from the uniform, so one pipeline serves
     * any op combination at that stage count; only the NUMBER of stages is baked in. Dropping
     * the stages past 0 is what renders a lightmapped world full-bright.
     *
     * COLOROP=DISABLE ends the cascade in D3D — the CPU side stops counting stages there, so
     * an emitted stage is one the guest actually enabled; the runtime check stays because ops
     * change between draws that share a pipeline.
     */
    const emitStage = (s: number): string => {
        const tex = `tex${s || ""}`, smp = `texSampler${s || ""}`;
        // Every stage carries its own final coordinate (source select + texture matrix already
        // applied in the vertex stage), so nothing here needs to know about UV sets or texgen.
        const arg = (sel: string) => `ffpStageArg(${sel}, _t, _cur, _diff, _spec, _tmp, u.tfactor)`;
        return `
    if (u32(u.stages[${s}].a.x) != 1u) {
        var _t = textureSample(${tex}, ${smp}, input.tc${s});
        // Alpha-less D3D formats (X8R8G8B8 & friends, incl. RTs) read alpha as 1.0 on real
        // hardware; our GPU copies carry a live alpha channel that must be masked.
        if (u.stages[${s}].b.z > 0.5) { _t = vec4<f32>(_t.rgb, 1.0); }
        let _cur = _c;
        // COLORARG0 | ALPHAARG0<<8 | resultIsTemp<<16 (see FfpStage in ffp-lighting.ts).
        let _x = u32(u.stages[${s}].b.w);
        let _toTemp = (_x >> 16u) != 0u;
        // D3DTSS_RESULTARG: the stage reads CURRENT/TEMP as its arguments either way, but
        // writes only the selected register — and an unwritten channel keeps ITS old value,
        // not CURRENT's.
        let _dst = select(_c, _tmp, _toTemp);
        let _a0 = ${arg("_x & 0xffu")};
        let _a1 = ${arg(`u32(u.stages[${s}].a.y)`)};
        let _a2 = ${arg(`u32(u.stages[${s}].a.z)`)};
        let _rgb = ffpStageOp(u32(u.stages[${s}].a.x), _a0, _a1, _a2, _t, _cur, _diff, u.tfactor, _dst);
        var _al = _dst.a;
        if (u32(u.stages[${s}].a.w) != 1u) {
            let _b0 = ${arg("(_x >> 8u) & 0xffu")};
            let _b1 = ${arg(`u32(u.stages[${s}].b.x)`)};
            let _b2 = ${arg(`u32(u.stages[${s}].b.y)`)};
            _al = ffpStageOp(u32(u.stages[${s}].a.w), _b0, _b1, _b2, _t, _cur, _diff, u.tfactor, _dst).a;
        }
        let _out = vec4<f32>(clamp(_rgb.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(_al, 0.0, 1.0));
        if (_toTemp) { _tmp = _out; } else { _c = _out; }
    }`;
    };
    // TEMP starts at (0,0,0,0) and SPECULAR is vertex colour 1 — both are D3DTA registers the
    // stage cascade may read, so they exist for the whole cascade, not per stage.
    const stageBody = samples
        ? `    let _spec = input.specular;
    var _tmp: vec4<f32> = vec4<f32>(0.0);\n`
            + Array.from({ length: stageCount }, (_unused, s) => emitStage(s)).join("\n")
        : "";

    /**
     * View-space position + normal, shared by FFP lighting and the D3DTSS_TCI_* generators.
     * Normals go through the inverse-transpose of worldView, not worldView itself: under a
     * non-uniform world scale the two differ and only the former keeps a normal perpendicular
     * to its surface. NORMALIZENORMALS is applied here so the generated reflection vectors see
     * the same normal the lighting does (ffpComputeLighting re-normalizing a unit vector is a
     * no-op, so the flag still travels with it).
     *
     * A pre-transformed (XYZRHW) vertex has no world/view transform and no normal — texgen from
     * it reads the raw position, and D3D applies no texture matrix to it either.
     */
    const eyeSpaceBody = !(d.lit || samples)
        ? ""
        : d.hasRhw
        ? `let _ecPos = input.pos.xyz;
        let _ecNormal = vec3<f32>(0.0);`
        : `let _ecPos = (u.worldView * vec4<f32>(input.pos, 1.0)).xyz;
        var _ecNormal = (u.normalMatrix * vec4<f32>(${d.normalExpr}, 0.0)).xyz;
        if (u.ctrl2.w > 0.5 && any(_ecNormal != vec3<f32>(0.0))) { _ecNormal = normalize(_ecNormal); }`;

    // Per-stage texture coordinates: source select (vertex UV set or a TCI_* generator) plus
    // the stage's D3DTS_TEXTURE matrix, both driven by uniforms — texgen turning on or off
    // never rebuilds the pipeline. XYZRHW skips the matrix, matching D3D.
    const uvSrc = `let _uv0 = ${d.hasTex ? "input.uv" : "vec2<f32>(0.0)"};
    let _uv1 = ${d.hasTex1 ? "input.uv1" : "_uv0"};`;
    const texCoordBody = samples
        ? uvSrc + "\n" + Array.from({ length: stageCount }, (_unused, s) => {
            const src = `ffpTexCoordSrc(u32(u.texGen[${s}].x), _uv0, _uv1, _ecPos, _ecNormal)`;
            return d.hasRhw
                ? `    out.tc${s} = (${src}).xy;`
                : `    out.tc${s} = ffpTexTransform(${src}, u.texMatrices[${s}], u32(u.texGen[${s}].y));`;
        }).join("\n")
        : "";

    const colorBody = d.lit
        ? `let vDiffuse = ${d.colorExpr};
        let vSpecular = ${d.specularExpr};
        if (u.ctrl0.y > 0.5) {
            let lit = ffpComputeLighting(
                _ecPos, _ecNormal,
                u.matDiffuse, u.matAmbient, u.matSpecular, u.matEmissive,
                u.ctrl0.x, u.ctrl0.z > 0.5, u.ctrl0.w > 0.5, u.ctrl2.y > 0.5,
                u.ctrl2.w > 0.5,
                u.ctrl1.x, u.ctrl1.y, u.ctrl1.z, u.ctrl1.w,
                u.globalAmbient.xyz, i32(u.ctrl2.x),
                vDiffuse, vSpecular);
            out.color = lit[0];
            // Alpha rides through unlit: FFP lighting replaces specular RGB only, and D3DTA_SPECULAR
            // (plus vertex fog) reads the app's own specular alpha.
            out.specular = vec4<f32>(lit[1].xyz, vSpecular.a);
        } else {
            out.color = vDiffuse;
            out.specular = vec4<f32>(0.0, 0.0, 0.0, vSpecular.a);
        }`
        : `out.color = ${d.colorExpr};
        out.specular = ${d.specularExpr};`;

    return `
${FFP_UNIFORM_STRUCT_WGSL}
@group(0) @binding(0) var<uniform> u: Uniforms;
${stageBindings}

struct VertexInput {
    ${d.inputFields.join(",\n    ")}
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    // D3D fixed-function fog factor (0 = unfogged). Computed per vertex for every draw —
    // the mode lives in a uniform, so fog turning on or off never rebuilds the pipeline.
    @location(1) fog: f32,
    // Vertex colour 1. Present whether or not the draw is lit: the stage cascade can select it
    // as D3DTA_SPECULAR, which has nothing to do with D3DRS_LIGHTING.
    @location(2) specular: vec4<f32>,
    // FFP user clip-plane signed distances (planes 0..3 in clipA, 4..5 in clipB), interpolated
    // for the per-pixel discard in fs_main. Constant 1.0 (no clip) unless clipping is enabled.
    @location(3) clipA: vec4<f32>,
    @location(4) clipB: vec2<f32>,
    // One FINAL texture coordinate per emitted blend stage (location 5 + stage), not one per
    // vertex UV set: after texgen and the texture matrix, two stages reading the same set can
    // still need different coordinates. Locations stay under the 16-variable inter-stage limit
    // because the count is FFP_MAX_STAGES at most.
${Array.from({ length: samples ? stageCount : 0 }, (_unused, s) => `    @location(${5 + s}) tc${s}: vec2<f32>,`).join("\n")}
}
${FFP_UNPACK_COLOR_WGSL}
${FFP_FOG_WGSL}
${samples ? FFP_TEXGEN_WGSL : ""}
${d.lit ? FFP_SELECT_COLOR_WGSL + "\n" + emitFfpComputeLighting("u.lights") : ""}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    ${posBody}
    ${eyeSpaceBody}
    ${colorBody}
${texCoordBody}
    ${clipVsBody}
    // Pre-transformed vertex fog reads the factor the app wrote into specular alpha, which
    // FFP lighting leaves alone (it replaces the specular RGB only) — so take it from the
    // raw vertex, not from a lit value.
    out.fog = ffpFogFactor(u.fogParams.w, u.fogParams.x, u.fogParams.y, u.fogParams.z,
        out.position.z, out.position.w, (${d.specularExpr}).a);
    return out;
}

${emitFfpCombinerWgsl(unhandledOpMagenta() ? "vec4<f32>(1.0, 0.0, 1.0, 1.0)" : "dst")}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    ${clipFsBody}
    let _diff = input.color;
    var _c: vec4<f32> = _diff;
${stageBody}
    ${d.lit ? "_c = vec4<f32>(clamp(_c.rgb + input.specular.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), _c.a);" : ""}
    ${alphaTestSnippet(d.alphaTest, "_c.a")}
    if (u.fogParams.w > 0.0) { _c = vec4<f32>(mix(_c.rgb, u.fogColor.rgb, input.fog), _c.a); }
    return _c;
}
`;
}

function buildShader(fvf: number, alphaTest: AlphaTest | null = null, litRequested = false, stageCount = 1,
                     texGen = false): string {
    const f = parseFvf(fvf);
    const lit = litRequested && !f.hasRhw;

    const inputFields: string[] = [`@location(${f.posLoc}) pos: ${f.hasRhw ? "vec4<f32>" : "vec3<f32>"}`];
    if (f.hasNormal) inputFields.push(`@location(${f.normalLoc}) normal: vec3<f32>`);
    if (f.hasColor) inputFields.push(`@location(${f.colorLoc}) color: u32`);
    if (f.hasSpecular) inputFields.push(`@location(${f.specularLoc}) specColor: u32`);
    if (f.hasTex) inputFields.push(`@location(${f.texLoc}) uv: vec2<f32>`);
    if (f.hasTex1) inputFields.push(`@location(${f.tex1Loc}) uv1: vec2<f32>`);

    return emitFfpShader({
        inputFields,
        hasRhw: f.hasRhw,
        hasTex: f.hasTex,
        hasTex1: f.hasTex1,
        texGen,
        stageCount,
        lit,
        colorExpr: f.hasColor ? "unpackColor(input.color)" : "vec4<f32>(1.0, 1.0, 1.0, 1.0)",
        specularExpr: f.hasSpecular ? "unpackColor(input.specColor)" : "vec4<f32>(0.0, 0.0, 0.0, 0.0)",
        normalExpr: f.hasNormal ? "input.normal" : "vec3<f32>(0.0, 0.0, 1.0)",
        alphaTest,
    });
}

function buildVertexLayout(fvf: number): {
    arrayStride: number;
    attributes: GPUVertexAttribute[];
    hasTexture: boolean;
    hasTexture1: boolean;
} {
    const f = parseFvf(fvf);
    const attributes: GPUVertexAttribute[] = [
        { shaderLocation: f.posLoc, offset: f.posOff, format: f.hasRhw ? "float32x4" : "float32x3" },
    ];
    if (f.hasNormal) attributes.push({ shaderLocation: f.normalLoc, offset: f.normalOff, format: "float32x3" });
    if (f.hasColor) attributes.push({ shaderLocation: f.colorLoc, offset: f.colorOff, format: "uint32" });
    if (f.hasSpecular) attributes.push({ shaderLocation: f.specularLoc, offset: f.specularOff, format: "uint32" });
    if (f.hasTex) attributes.push({ shaderLocation: f.texLoc, offset: f.texOff, format: "float32x2" });
    if (f.hasTex1) attributes.push({ shaderLocation: f.tex1Loc, offset: f.tex1Off, format: "float32x2" });

    return { arrayStride: f.stride, attributes, hasTexture: f.hasTex, hasTexture1: f.hasTex1 };
}

// ── D3DVERTEXELEMENT9 helpers ─────────────────────────────────────────────────

/**
 * Map D3DDECLTYPE to a WebGPU vertex format and its byte size.
 * For formats that have no direct WebGPU equivalent we fall back to float32x4.
 */
function d3dDeclTypeToGpu(type: number): { gpuFormat: GPUVertexFormat; byteSize: number } {
    switch (type) {
        case 0:  return { gpuFormat: "float32",   byteSize: 4  }; // FLOAT1
        case 1:  return { gpuFormat: "float32x2", byteSize: 8  }; // FLOAT2
        case 2:  return { gpuFormat: "float32x3", byteSize: 12 }; // FLOAT3
        case 3:  return { gpuFormat: "float32x4", byteSize: 16 }; // FLOAT4
        case 4:  return { gpuFormat: "unorm8x4",  byteSize: 4  }; // D3DCOLOR (BGRA → needs swizzle)
        case 5:  return { gpuFormat: "uint8x4",   byteSize: 4  }; // UBYTE4
        case 6:  return { gpuFormat: "sint16x2",  byteSize: 4  }; // SHORT2
        case 7:  return { gpuFormat: "sint16x4",  byteSize: 8  }; // SHORT4
        case 8:  return { gpuFormat: "unorm8x4",  byteSize: 4  }; // UBYTE4N
        case 9:  return { gpuFormat: "snorm16x2", byteSize: 4  }; // SHORT2N
        case 10: return { gpuFormat: "snorm16x4", byteSize: 8  }; // SHORT4N
        case 11: return { gpuFormat: "unorm16x2", byteSize: 4  }; // USHORT2N
        case 12: return { gpuFormat: "unorm16x4", byteSize: 8  }; // USHORT4N
        case 15: return { gpuFormat: "float16x2", byteSize: 4  }; // FLOAT16_2
        case 16: return { gpuFormat: "float16x4", byteSize: 8  }; // FLOAT16_4
        default: return { gpuFormat: "float32x4", byteSize: 16 }; // fallback
    }
}

/**
 * Gather `count` vertices of `stride` bytes out of `src` (from byte `base`, in the order
 * `order` gives) into the front of `dst`. Callers validate the extent first.
 *
 * Word-at-a-time whenever stride and both byte offsets are 4-aligned, which is every real
 * vertex format; a per-vertex `subarray().set()` would allocate one view per OUTPUT vertex
 * on a draw path (CLAUDE.md 3.1).
 */
function gatherVertices(
    dst: Uint8Array, src: Uint8Array, base: number, order: Uint32Array, count: number, stride: number,
): void {
    if ((stride & 3) === 0 && (dst.byteOffset & 3) === 0 && ((src.byteOffset + base) & 3) === 0) {
        const words = stride >>> 2;
        const d32 = new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >>> 2);
        const s32 = new Uint32Array(src.buffer, src.byteOffset + base, (src.byteLength - base) >>> 2);
        for (let v = 0; v < count; v++) {
            const s = order[v]! * words;
            const d = v * words;
            for (let w = 0; w < words; w++) d32[d + w] = s32[s + w]!;
        }
        return;
    }
    for (let v = 0; v < count; v++) {
        const s = base + order[v]! * stride;
        const d = v * stride;
        for (let b = 0; b < stride; b++) dst[d + b] = src[s + b]!;
    }
}

/** Compute the minimum vertex stride for stream 0 from a declaration element array. */
function computeDeclStride(elements: RawVertexElement[], stream = 0): number {
    let maxEnd = 0;
    for (const e of elements) {
        if (e.stream !== stream) continue;
        const { byteSize } = d3dDeclTypeToGpu(e.type);
        maxEnd = Math.max(maxEnd, e.offset + byteSize);
    }
    return maxEnd;
}

// D3DDECLUSAGE constants
const DECLUSAGE_POSITION_FFP  = 0;
const DECLUSAGE_NORMAL_FFP    = 3;
const DECLUSAGE_POSITIONT_FFP = 9;  // pre-transformed (XYZRHW)
const DECLUSAGE_TEXCOORD_FFP  = 5;
const DECLUSAGE_COLOR_FFP     = 10;
const D3DDECLTYPE_D3DCOLOR    = 4;  // stored as BGRA bytes

/** The semantics the fixed-function paths read out of a declaration. */
const FFP_CONSUMED_USAGES: ReadonlySet<number> = new Set([
    DECLUSAGE_POSITION_FFP, DECLUSAGE_NORMAL_FFP, DECLUSAGE_POSITIONT_FFP,
    DECLUSAGE_TEXCOORD_FFP, DECLUSAGE_COLOR_FFP,
]);

function declUsageName(usage: number): string {
    switch (usage) {
        case 0: return "POSITION";
        case 1: return "BLENDWEIGHT";
        case 2: return "BLENDINDICES";
        case 3: return "NORMAL";
        case 4: return "PSIZE";
        case 5: return "TEXCOORD";
        case 6: return "TANGENT";
        case 7: return "BINORMAL";
        case 8: return "TESSFACTOR";
        case 9: return "POSITIONT";
        case 10: return "COLOR";
        case 11: return "FOG";
        case 12: return "DEPTH";
        case 13: return "SAMPLE";
        default: return `USAGE(${usage})`;
    }
}

/**
 * Build a WGSL FFP-style shader + GPU vertex attributes from a D3D9 vertex declaration.
 * This is used when SetVertexDeclaration is active but no vertex shader is set.
 * The generated shader is compatible with the expanded FFP uniform layout (ffp-lighting.ts).
 *
 * `stageCount` bakes the texture-blend cascade depth into the shader exactly as the FVF path
 * does — a declaration is just another way to describe the same fixed-function vertex, so it
 * must reach the same multi-stage shader or a lightmapped draw renders full-bright.
 */
function buildShaderFromDecl(
    elements: RawVertexElement[],
    alphaTest: AlphaTest | null = null,
    litRequested = false,
    stageCount = 1,
    /** Bound stride per stream; a stream the guest bound with stride 0 falls back to the
     *  packed size its own elements imply. */
    streamStrides: readonly number[] = [],
    /** Restrict the declaration to these streams. A CPU-converted draw that repacks its
     *  vertices into one buffer passes {0}: the pipeline must declare exactly the buffers
     *  the draw binds, or WebGPU rejects it. */
    streamAllow: ReadonlySet<number> | null = null,
    /** Some active stage generates its own texture coordinates — see emitFfpShader.texGen. */
    texGen = false,
): {
    wgsl: string;
    /** One layout per stream slot, indexed by stream number; null for slots the
     *  declaration does not use (WebGPU accepts holes in `vertex.buffers`). */
    buffers: (GPUVertexBufferLayout | null)[];
    hasTexture: boolean;
} {
    const all = streamAllow ? elements.filter(e => streamAllow.has(e.stream)) : elements;

    // Find the key semantic elements we care about. A declaration addresses these by
    // (stream, offset) and each stream is bound separately, so the search spans every
    // stream — restricting it to stream 0 silently drops whatever the others carry.
    const posElem = all.find(e => e.usage === DECLUSAGE_POSITION_FFP || e.usage === DECLUSAGE_POSITIONT_FFP) ?? null;
    const normElem = all.find(e => e.usage === DECLUSAGE_NORMAL_FFP   && e.usageIndex === 0) ?? null;
    const texElem = all.find(e => e.usage === DECLUSAGE_TEXCOORD_FFP && e.usageIndex === 0) ?? null;
    // Coordinate set 1 — the only set beyond 0 a stage can select (see emitStage's coordSet).
    const tex1Elem = all.find(e => e.usage === DECLUSAGE_TEXCOORD_FFP && e.usageIndex === 1) ?? null;
    const colElem = all.find(e => e.usage === DECLUSAGE_COLOR_FFP    && e.usageIndex === 0) ?? null;
    const specElem = all.find(e => e.usage === DECLUSAGE_COLOR_FFP   && e.usageIndex === 1) ?? null;

    if (!posElem) {
        // No position — fall back to FVF 0 (XYZ-only shader, no texture).
        const layout = buildVertexLayout(D3DFVF_XYZ);
        return {
            wgsl: buildShader(D3DFVF_XYZ),
            buffers: [{ arrayStride: layout.arrayStride, attributes: layout.attributes }],
            hasTexture: false,
        };
    }

    // XYZRHW: the position is pre-transformed. In D3D9 this is signalled either by
    // D3DDECLUSAGE_POSITIONT (9) or by POSITION+FLOAT4 — we accept both.
    const isRHW = posElem.usage === DECLUSAGE_POSITIONT_FFP || posElem.type === 3 /* FLOAT4 */;
    const hasNormal = !isRHW && normElem !== null;
    const hasColor = colElem !== null;
    const hasSpecular = specElem !== null;
    const hasTex   = texElem !== null;
    // A second set only earns an attribute + varying when something can sample it; a
    // single-stage draw keeps the shader it has always had even if the decl carries TEXCOORD1.
    const hasTex1 = hasTex && tex1Elem !== null && stageCount > 1;
    const lit = litRequested && !isRHW;

    // Assign contiguous shader locations in declaration order: pos, [normal], [color], [specular], [uv], [uv1].
    let loc = 0;
    const posLoc = loc++;
    const normLoc = hasNormal ? loc++ : -1;
    const colLoc = hasColor ? loc++ : -1;
    const specLoc = hasSpecular ? loc++ : -1;
    const texLoc = hasTex  ? loc++ : -1;
    const tex1Loc = hasTex1 ? loc++ : -1;

    // Build the GPUVertexAttribute list per stream: an attribute's offset is relative to its
    // OWN stream's vertex, so it belongs to that stream's layout, not to one flat list.
    const perStream = new Map<number, GPUVertexAttribute[]>();
    const addAttr = (elem: RawVertexElement | null, shaderLocation: number): void => {
        if (!elem || shaderLocation < 0) return;
        const { gpuFormat } = d3dDeclTypeToGpu(elem.type);
        const list = perStream.get(elem.stream) ?? [];
        list.push({ shaderLocation, offset: elem.offset, format: gpuFormat });
        perStream.set(elem.stream, list);
    };
    addAttr(posElem, posLoc);
    if (hasNormal) addAttr(normElem, normLoc);
    if (hasColor) addAttr(colElem, colLoc);
    if (hasSpecular) addAttr(specElem, specLoc);
    if (hasTex) addAttr(texElem, texLoc);
    if (hasTex1) addAttr(tex1Elem, tex1Loc);

    const buffers: (GPUVertexBufferLayout | null)[] = [];
    for (const [stream, attrs] of [...perStream].sort((a, b) => a[0] - b[0])) {
        // The bound stride wins: a vertex may carry data this declaration names no attribute
        // for, and stepping by the packed size would then read each vertex after the first
        // out of the middle of its predecessor. Never go below the packed size.
        const packed = computeDeclStride(all, stream);
        const bound = streamStrides[stream] ?? 0;
        while (buffers.length < stream) buffers.push(null);
        buffers.push({ arrayStride: Math.max(bound, packed) || 12, attributes: attrs });
    }

    // Build input struct fields. D3DCOLOR is delivered as unorm8x4 (BGRA) → vec4; the
    // BGRA→RGBA swizzle happens in the colour expressions below. Other colour types pass through.
    const inputFields: string[] = [];
    inputFields.push(`@location(${posLoc}) pos: ${isRHW ? "vec4<f32>" : "vec3<f32>"}`);
    if (hasNormal) inputFields.push(`@location(${normLoc}) normal: vec3<f32>`);
    if (hasColor) inputFields.push(`@location(${colLoc}) color: vec4<f32>`);
    if (hasSpecular) inputFields.push(`@location(${specLoc}) specColor: vec4<f32>`);
    if (hasTex)   inputFields.push(`@location(${texLoc}) uv: vec2<f32>`);
    if (hasTex1)  inputFields.push(`@location(${tex1Loc}) uv1: vec2<f32>`);

    const declColorExpr = (elem: typeof colElem, field: string): string => {
        if (!elem) return "vec4<f32>(1.0, 1.0, 1.0, 1.0)";
        return elem.type === D3DDECLTYPE_D3DCOLOR
            ? `vec4<f32>(input.${field}.z, input.${field}.y, input.${field}.x, input.${field}.w)`
            : `input.${field}`;
    };
    const colorExpr = hasColor ? declColorExpr(colElem, "color") : "vec4<f32>(1.0, 1.0, 1.0, 1.0)";
    const specularExpr = hasSpecular ? declColorExpr(specElem, "specColor") : "vec4<f32>(0.0, 0.0, 0.0, 0.0)";

    const wgsl = emitFfpShader({
        inputFields,
        hasRhw: isRHW,
        hasTex,
        hasTex1,
        texGen,
        stageCount,
        lit,
        colorExpr,
        specularExpr,
        normalExpr: hasNormal ? "input.normal" : "vec3<f32>(0.0, 0.0, 1.0)",
        alphaTest,
    });

    return { wgsl, buffers, hasTexture: hasTex || texGen };
}
