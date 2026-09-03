/// <reference types="@webgpu/types" />
import { WebGPUBackend } from "../webgpu-backend";
import { RenderFramePool, type ProgrammableDrawState, type RenderFrame } from "../render-frame";
import { LruCache } from "../../../core/collections/lru-cache";
import { registerGpuDeviceObserver } from "../../../core/gpu/gpu-device-lifecycle";
import { registerBackendQualitySupport } from "../shared/quality-capabilities";
// Side-effect import: the surface-side device-loss observer. A pure-d3d9 title never loads the
// ddraw executor, but its render targets and the texture-handle registry are the same objects.
import "../../../modules/ddraw/surface-device-loss";
import {
    D3D9StateTracker, FFP_TEXTURE_TRANSFORM_COUNT, D3D9_FFP_STAGE_COUNT, D3D9_TEXTURE_SLOT_COUNT,
    D3D9_VERTEX_TEXTURE_SAMPLER_BASE, D3D9_VERTEX_TEXTURE_SAMPLER_COUNT,
    d3d9TextureStageSlot, isD3D9TextureStage,
} from "./d3d9-state-tracker";
import { D3D9CommandRecorder } from "./d3d9-command-recorder";
import {
    censusD3D9MegaBatchFrame,
    createD3D9MegaBatchCensus,
    d3d9MegaBatchCensusMetrics,
    type D3D9MegaBatchCensus,
} from "./d3d9-megabatch-census";
import { DynamicVbPool } from "./dynamic-vb-pool";
import { D3D9BackendExecutor, UniformData } from "./d3d9-backend-executor";
import {
    d3d9MsaaSampleCount,
    D3D9MultisampleTargetCache,
    getD3D9MsaaCapabilityContract,
    resolveD3D9MrtCompatibility,
    resolveD3D9StandaloneDepthPolicyBySampleCount,
    type D3D9MsaaAdapterProbe,
    type D3D9MultisampleTarget,
} from "./multisample";
import { resolveD3D9ClearRegion, resolveD3D9RectClearPolicy } from "./clear-policy";
import { D3D9QueryManager } from "../../../modules/d3d9/query-manager";
import { VertexBufferStore, IndexBufferStore, TextureStore } from "./d3d9-resources";
import { copyD3D9SurfaceRectCpu, isD3D9CpuCopyDestinationFormat, writeD3D9Pixel } from "./copy-cpu";
import {
    DxSamplerCache, dxSamplerShaderStatesKey, dxSrgbViewFormat, dxSrgbViewFormats,
    type SamplerSpec,
} from "../shared/dx-sampler";
import { isDxDepthStencilFormat } from "../shared/dx-format-support";
import {
    makeD3D9FloatUpload,
    resolveD3D9FloatTexturePolicy,
} from "../shared/float-format-policy";
import { TexturePaletteStore } from "../shared/texture-palette-store";
import { decodeD3d9Sampler, d3d9SamplerStateDefault } from "./d3d9-sampler";
import { readGpuTextureRgba } from "../shared/gpu-readback";
import {
    buildColorTargetState, computeBlendKey, buildDepthStencilState, computeDepthKey,
    D3DRS_SRCBLENDALPHA, D3DRS_DESTBLENDALPHA, D3DRS_BLENDFACTOR,
    isD3D9BlendStateRepresentable, isD3D9DepthStencilStateRepresentable,
    hasUnsupportedStencilState, D3DRS_STENCILREF, d3dColorToGpu,
} from "./d3d9-blend";
import { d3dTextureMipUploadPlan, effectiveCubeMipLevels, effectiveMipLevels } from "../shared/mip-utils";
import {
    blockCompressedCopyDim,
    canUploadNativeBC,
    decodeD3DTextureToRgba8,
    getD3DTextureLayout,
    getNativeBCTextureFormat,
    isBlockCompressedFormat,
    isD3DFloatFormat,
} from "../shared/texture-formats";
import { TimeService } from "../../../runtime/time";
import { System } from "../../../core/system";
import {
    getVolumeLevel,
    volumeTextureResources,
    type VolumeTextureResource,
} from "../../../modules/d3d9/volume-resources";
import * as frameCapture from "../../../modules/ddraw/frame-capture";
import { getOverlayCompositePlan } from "../../../modules/user32/dialog-overlay";
import { Logger, LogCategory } from "../../../core/logger";
import {
    d3d9PerfInc, d3d9PerfAdd, d3d9PerfSkip, d3d9PerfBackendInc, d3d9DropDraw,
    d3d9PerfStateBlockApply, d3d9PerfStateBlockCapture,
    d3d9PerfStateBlockWasmApply, d3d9PerfStateBlockWasmCapture,
    d3d9PerfBufferLock, d3d9PerfBufferUpload, d3d9PerfIndexRangeOOB,
    d3d9PerfFfpUnimplemented, d3d9PerfFfpOp, d3d9PerfApproximation, d3d9PerfMaterialSet,
} from "../../../modules/d3d9/d3d9-perf";
import { addComRef, releaseComRef } from "../../../modules/d3d9/com-refs";
import { d3d9ReadbackCounters } from "../../../modules/d3d9/lock-stats";
import { isValidAddress } from "../../../core/memory/address-guard";
import { Mem } from "../../../core/memory/mem-accessor";
import { fullTargetViewport, sanitizeViewport } from "../ddraw/types";
import { frameProfiler } from "../../../core/frame-profiler";
import { framePacer, decodeD3DPresentInterval, PRESENT_INTERVAL_ONE } from "../../../core/frame-pacer";
import { recordGpuError } from "../../../core/gpu-error-log";
import { D3DSWAPEFFECT_DISCARD, d3d9SwapEffectDiscardsBackBuffer, readD3d9SwapEffect } from "../../../modules/d3d9/presentation-params";
import { statsOverlay } from "../../../core/stats-overlay";
import {
    compileVertexShader, compilePixelShader, linkProgram, computeCubeMask, computeVolumeMask,
    computeVertexVolumeMask,
    CompiledVs, CompiledPs, LinkResult, RawVertexElement, PROG_BIND,
} from "./shader";
import type { CensusSummary } from "./shader/census";
import { AlphaTest, alphaTestSnippet } from "./shader/sm-wgsl";
import { noteD3D9TextureUpload } from "../../../modules/d3d9/shared-state";
import { Op, opName } from "./shader/sm-enums";
import { VS_FLOAT_REGISTER_COUNT } from "./shader/vs-codegen";
import { SHADER_BOOLEAN_BANK_BYTES } from "./shader/link/uniforms";
import {
    FFP_UNIFORM_STRUCT_WGSL,
    FFP_SELECT_COLOR_WGSL,
    FFP_TEXGEN_WGSL,
    emitFfpComputeLighting,
    FFP_UNIFORM_FLOATS,
    FFP_STAGE_CONSTANT_FLOATS,
    FFP_MAX_STAGES,
    ffpStageOffset,
    ffpStageConstantOffset,
    FFP_MAX_LIGHTS,
    packFfpUniforms,
    makeFfpParams,
    newFfpColor,
    readFfpColor,
    unpackD3dColor,
    type FfpColor,
    type FfpLightInput,
    type FfpMaterial,
    type FfpUniformParams,
    D3DLIGHT_POINT,
    D3DLIGHT_DIRECTIONAL,
    D3DMCS_MATERIAL,
    D3DMCS_COLOR1,
    D3DMCS_COLOR2,
    D3D_ALPHALESS_FORMATS,
} from "./ffp-lighting";
import { FFP_FOG_WGSL, resolveFfpFogMode, resolveProgrammablePixelFogMode } from "./ffp-fog";
import { resolveFfpVertexBlend } from "./ffp-vertex-blend";
import { pixelCenterClipOffset, pixelCenterOffsetPx, withPixelCenterVersion } from "../pixel-center";
import { alignUploadRange } from "../buffer-upload";
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
import {
    d3d9WasmArena, isWasmPathEnabled, isArenaVerifyDrainEnabled,
    arenaSupportsFragmentSamplerBank, arenaSupportsVertexSamplerBank, D3D9_ARENA_FRAGMENT_STAGE_COUNT, ArenaCommandType,
} from "./d3d9-wasm-arena";
import {
    notePipelineMemoAgree,
    notePipelineMemoHit,
    notePipelineMemoMismatch,
    notePipelineMemoProf,
    pipelineMemoEnabled,
    pipelineMemoProfiling,
    pipelineMemoVerifying,
    PROF_CLOCK,
    PROF_GUARD,
    PROF_HASH,
    PROF_NOTE,
    PROF_HIT,
    PROF_TAIL,
} from "./d3d9-pipeline-memo";
import {
    arenaPipelineCacheBucket, buildArenaPipelineIdentity,
    type ArenaPipelineIdentitySnapshot,
} from "./arena-pipeline-identity";

import { resolveD3D9MultisampleRasterPolicy } from "./raster-emulation";
import { tessellateNpatchTriangleList, type NpatchTessellation } from "./npatch-tessellator";
import {
    MAX_VERTEX_BUFFER_SLOTS, MAX_VERTEX_STREAMS, StreamBindingPlan, StreamBindingTable,
    applyStepModes, bindingSize, declStreamMask, layoutAttributeEnds, layoutStrides, planInstancing,
    isWebGpuArrayStrideAligned, slotArrayStride, slotMaskExceedsLimit, slotsInMask, stepModeFromFreq, zeroStreamBuffer,
    streamInstanceDivisor, expandInstanceRateData,
} from "../shared/vertex-streams";
import {
    parseFvf, planFvf, makeFvfDeclaration,
    D3DFVF_XYZ, D3DFVF_XYZRHW, D3DFVF_POSITION_MASK, D3DFVF_NORMAL, D3DFVF_PSIZE, D3DFVF_DIFFUSE,
    D3DFVF_SPECULAR, D3DFVF_TEX1,
} from "./shader/fvf-layout";
import {
    processSoftwareVertices,
    type SwvpStream,
} from "./swvp";

/** Shared, never-mutated answer for the common "no shadow samplers bound" case: the
 *  bound-bank memo hands this out instead of allocating an empty Map for every draw. */
const EMPTY_COMPARISON_SAMPLERS: Map<number, { clampDref?: boolean }> = new Map();

/** Numeric sort comparator, hoisted: the light gather sorts per draw. */
const ascending = (a: number, b: number): number => a - b;

function validateWebGpuVertexBufferStrides(
    buffers: readonly (GPUVertexBufferLayout | null | undefined)[],
    context: string,
): boolean {
    for (let slot = 0; slot < buffers.length; slot++) {
        const stride = buffers[slot]?.arrayStride;
        if (stride !== undefined && !isWebGpuArrayStrideAligned(stride)) {
            d3d9DropDraw(`pipeline:unalignedStride:${slot}:${stride}`);
            Logger.error(LogCategory.D3D9,
                `[D3D9] ${context} stream ${slot} has WebGPU-unaligned array stride ${stride}; refusing draw`);
            return false;
        }
    }
    return true;
}

/** A *UP draw binds only the inline vertex data — slot 0 and nothing else. */
const UP_STREAM_SLOTS = 1;
/** The arena cache is a secondary alias index; keep its long-lived readable keys bounded. */
const ARENA_PIPELINE_CACHE_MAX_ENTRIES = 1024;
const PROG_PIPELINE_CACHE_MAX_ENTRIES = 1024;
/** Size of the stand-in binding for a stream the declaration wants and the guest never bound. */
const ZERO_STREAM_MIN_BYTES = 64 * 1024;

const D3DPT_POINTLIST = 1;
const D3DPT_LINELIST = 2;
const D3DPT_LINESTRIP = 3;
/** The WebGPU topologies a D3D9 draw can reach. `triangle-strip` implies a uint16 index
 *  buffer — WebGPU bakes `stripIndexFormat` into the pipeline, so an INDEXED strip draw may
 *  only ever meet the index width its key was built for (a non-indexed strip ignores it). */
type D3D9DrawTopology = "triangle-list" | "line-list" | "triangle-strip";

const D3DPT_TRIANGLELIST = 4;
const D3DPT_TRIANGLESTRIP = 5;
const D3DPT_TRIANGLEFAN = 6;
const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DERR_DEVICELOST = 0x88760868;
const D3D9_MAX_RENDER_TARGETS = 4;
const D3DCULL_NONE = 1;
const D3DCULL_CW = 2;
const D3DCULL_CCW = 3;
/** SetStreamSourceFreq dividers (d3d9types.h): the flag half of the setting word. */
const D3DSTREAMSOURCE_INDEXEDDATA = 0x40000000;
const D3DSTREAMSOURCE_INSTANCEDATA = 0x80000000;

type ShaderDiagnosticStage = "vs" | "ps";
type ShaderDiagnosticBuild = "pending" | "linked" | "built" | "failed";

interface ShaderDiagnosticRecord {
    handle: number;
    stage: ShaderDiagnosticStage;
    version: string;
    opcodeHistogram: Record<string, number>;
    unsupported: Set<string>;
    approximated: Set<string>;
    /** Opcodes the emitter dispatched across every link this shader took part in. */
    dispatched: number;
    drawsIssued: number;
}

interface ShaderPairDiagnosticRecord {
    handle: number;
    vsHandle: number;
    psHandle: number | null;
    vsVersion: string;
    psVersion: string | null;
    wgsl: string | null;
    build: ShaderDiagnosticBuild;
    error: string | null;
    pipelineId: number | null;
    drawsIssued: number;
    /** The two stage records this pair attributes its draws to, resolved once and revalidated
     *  by `epoch` — the draw path runs on every programmable draw and must not look them up. */
    vsDiag: ShaderDiagnosticRecord | null;
    psDiag: ShaderDiagnosticRecord | null;
    diagEpoch: number;
}

/**
 * Live-read, default on. Attribute a programmable draw to its two stage records through the
 * numeric index and a reference cached on the pair, instead of building `vs:<h>` and `ps:<h>`
 * to reach the string-keyed map. Same records, same counters — the two routes are compared by
 * `shaderInstrumentationSnapshot`, which reports `indexMismatch`.
 */
function fastDrawAttribution(): boolean {
    return (globalThis as { __d3d9FastDrawAttribution?: boolean }).__d3d9FastDrawAttribution !== false;
}

function opcodeHistogram(program: { instructions: Array<{ opcode: number }> }): Record<string, number> {
    const histogram: Record<string, number> = {};
    for (const instruction of program.instructions) {
        const name = opName(instruction.opcode);
        histogram[name] = (histogram[name] ?? 0) + 1;
    }
    return histogram;
}

/** The current WASM arena mirrors only c#; I/B draws must use the JS snapshot path. */
function shaderUsesIntegerBoolean(program: { instructions: Array<{ dst: { reg: { type: number } } | null; src: Array<{ reg: { type: number } }> }>; definitions: Array<{ reg: { type: number } }> }): boolean {
    const isBank = (type: number): boolean => type === 7 /* CONSTINT */ || type === 14 /* CONSTBOOL */;
    return program.instructions.some(ins =>
        (ins.dst !== null && isBank(ins.dst.reg.type)) || ins.src.some(src => isBank(src.reg.type)))
        || program.definitions.some(def => isBank(def.reg.type));
}
const D3DFMT_INDEX16 = 101;
const SHADER_INTEGER_REGISTER_COUNT = 16;
const SHADER_BOOLEAN_REGISTER_COUNT = 16;
const PS_FLOAT_REGISTER_COUNT = 224;

/**
 * D3D9 diagnostic toggles — the D3D9 half of the DDraw executor's DebugFlags, in the same
 * shape (`gpuToggle` addresses either backend). Each flag deletes exactly ONE pipeline
 * stage, so a picture that comes back under one of them names the stage that was hiding it.
 * Nothing here is a rendering option: they are all wrong on purpose.
 */
export interface D3D9DebugFlags {
    /** Ignore D3DRS_CULLMODE — is back-face culling eating the geometry? */
    forceCullNone: boolean;
    /** Ignore D3DRS_ZENABLE (no depth test AND no depth write) — is depth rejecting it? */
    forceDisableZTest: boolean;
    /** Ignore D3DRS_ALPHATESTENABLE — is the fragment being discarded by the alpha test? */
    forceDisableAlphaTest: boolean;
    /** Ignore D3DRS_ALPHABLENDENABLE — is the draw blending itself into invisibility? */
    forceDisableAlphaBlend: boolean;
}

export const DEFAULT_D3D9_DEBUG_FLAGS: D3D9DebugFlags = {
    forceCullNone: false,
    forceDisableZTest: false,
    forceDisableAlphaTest: false,
    forceDisableAlphaBlend: false,
};

// Alpha-test render states + D3DCMPFUNC ALWAYS (the no-op compare).
const D3DRS_ALPHAREF = 24;
const D3DRS_ALPHAFUNC = 25;
const D3DRS_ALPHATESTENABLE = 15;
const D3DCMP_ALWAYS = 8;

// Depth / blend / raster states the harness frame capture reports (d3d9types.h ordinals).
const D3DRS_ZENABLE = 7;
const D3DRS_FILLMODE = 8;
const D3DRS_SHADEMODE = 9;
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
const D3DRS_RANGEFOGENABLE = 48;
/** D3DRS_SRGBWRITEENABLE: select an sRGB render-target view for the draw. */
const D3DRS_SRGBWRITEENABLE = 194;

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
const D3DTSS_CONSTANT = 32;
const D3DTSS_COLORARG1 = 2;
const D3DTSS_COLORARG2 = 3;
const D3DTSS_ALPHAARG1 = 5;
const D3DTSS_ALPHAARG2 = 6;

/**
 * The D3D9 default for a D3DTSS_* state the game never touched — what GetTextureStageState (and
 * a D3DSBT_ALL state-block capture) must answer. This is deliberately NOT the same fallback
 * resolveFfpStages applies at draw time: that one additionally substitutes D3DTA_DIFFUSE for a
 * D3DTA_TEXTURE argument when no texture is bound, which is a rendering behaviour, not the
 * state's own default — GetTextureStageState must report D3DTA_TEXTURE regardless of whether a
 * texture happens to be bound right now. Mirrors wined3d's init_default_texture_state.
 */
export function d3d9TextureStageStateDefault(stage: number, type: number): number {
    switch (type) {
        case D3DTSS_COLOROP: return stage === 0 ? 4 /* D3DTOP_MODULATE */ : D3DTOP_DISABLE;
        case D3DTSS_COLORARG1: return 2; // D3DTA_TEXTURE
        case D3DTSS_COLORARG2: return 1; // D3DTA_CURRENT
        case D3DTSS_ALPHAOP: return stage === 0 ? 2 /* D3DTOP_SELECTARG1 */ : D3DTOP_DISABLE;
        case D3DTSS_ALPHAARG1: return 2; // D3DTA_TEXTURE
        case D3DTSS_ALPHAARG2: return 1; // D3DTA_CURRENT
        case D3DTSS_COLORARG0: return 1; // D3DTA_CURRENT
        case D3DTSS_ALPHAARG0: return 1; // D3DTA_CURRENT
        case D3DTSS_RESULTARG: return 1; // D3DTA_CURRENT
        case D3DTSS_TEXCOORDINDEX: return stage;
        default: return 0;
    }
}

/**
 * One texture stage with D3D's defaults already applied (resolveFfpStages). The shader, the
 * gap census and the frame capture all read THIS, never the raw state map: an unset COLOROP
 * is MODULATE, not 0, and a census reading the raw 0 would report the default as a gap.
 */
type FfpResolvedStage = FfpUniformParams["stages"][number];

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
// Fixed-function skinning state. Valid XYZBn/declaration blend inputs are lowered by emitFfpShader;
// malformed combinations are rejected at pipeline resolution rather than transformed by WORLD.
const D3DRS_VERTEXBLEND = 151;
const D3DRS_INDEXEDVERTEXBLENDENABLE = 167;

// ps_1_x TEXBEM/TEXBEML take these from the *destination* texture stage.
// Values are FLOAT-as-DWORD, not integer enum values.
const D3DTSS_BUMPENVMAT00 = 7;
const D3DTSS_BUMPENVMAT01 = 8;
const D3DTSS_BUMPENVMAT10 = 9;
const D3DTSS_BUMPENVMAT11 = 10;
const D3DTSS_BUMPENVLSCALE = 22;
const D3DTSS_BUMPENVLOFFSET = 23;

const LEGACY_BUMP_ENV_STAGE_STATES = [
    D3DTSS_BUMPENVMAT00, D3DTSS_BUMPENVMAT01, D3DTSS_BUMPENVMAT10, D3DTSS_BUMPENVMAT11,
    D3DTSS_BUMPENVLSCALE, D3DTSS_BUMPENVLOFFSET,
] as const;

/**
 * Cache-key fragment for the stage state a legacy TEXBEM/TEXBEML shader has baked into its
 * PS constant block. Empty for every other shader, so the ordinary compact key pays nothing.
 * These values live in texture-stage state, NOT in the constant bank, so no constant-bank
 * version can witness one changing under an otherwise identical draw state.
 */
export function legacyBumpEnvStageKey(
    ps: { analysis: { usesLegacyBumpEnv: boolean } } | null,
    getTextureStageState: (stage: number, state: number) => number,
): string {
    if (!ps?.analysis.usesLegacyBumpEnv) return "";
    let key = "b";
    for (let stage = 0; stage < FFP_MAX_STAGES; stage++) {
        for (const state of LEGACY_BUMP_ENV_STAGE_STATES) {
            key += `,${getTextureStageState(stage, state) >>> 0}`;
        }
    }
    return key;
}

const dwordFloatScratch = new ArrayBuffer(4);
const dwordFloatBits = new Uint32Array(dwordFloatScratch);
const dwordFloatValue = new Float32Array(dwordFloatScratch);
function dwordAsFloat(value: number): number {
    dwordFloatBits[0] = value >>> 0;
    return dwordFloatValue[0]!;
}

const FFP_IDENTITY_MATRIX = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
]);

function multiplyD3dMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            out[row * 4 + col] =
                a[row * 4] * b[col] + a[row * 4 + 1] * b[col + 4] +
                a[row * 4 + 2] * b[col + 8] + a[row * 4 + 3] * b[col + 12];
        }
    }
    return out;
}
// D3DLOCK_DISCARD — the guest is refilling the whole buffer; D3D gives it fresh memory
// rather than overwriting bytes already-issued draws read (see uploadBufferVersion).
const D3DLOCK_DISCARD = 0x00002000;

// Point-sprite render states (float-as-DWORD except the two BOOLs). Canonical d3d9types.h ordinals.
const D3DRS_POINTSIZE = 154;
const D3DRS_POINTSIZE_MIN = 155;
const D3DRS_POINTSPRITEENABLE = 156;
const D3DRS_POINTSCALEENABLE = 157;
const D3DRS_POINTSCALE_A = 158;
const D3DRS_POINTSCALE_B = 159;
const D3DRS_POINTSCALE_C = 160;
const D3DRS_POINTSIZE_MAX = 166;
const D3DRS_MULTISAMPLEANTIALIAS = 161;
const D3DRS_MULTISAMPLEMASK = 162;
const D3DRS_ANTIALIASEDLINEENABLE = 176;

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
const D3DRS_SCISSORTESTENABLE = 174;

const D3DTS_WORLD = 0x100;
const D3DTS_VIEW = 2;
const D3DTS_PROJECTION = 3;
const D3DTS_TEXTURE0 = 16;
const D3DMATERIAL9_SIZE = 68;
const D3DLIGHT9_SIZE = 104;

type ClearState = {
    color: GPUColor;
};

type ArenaRecordSpec =
    | { kind: "draw"; topology: number; vertexCount: number; startVertex: number; stride: number; forceCullNone: boolean }
    | { kind: "indexed"; topology: number; indexCount: number; startIndex: number; baseVertex: number; stride: number; forceCullNone: boolean }
    | { kind: "up"; topology: number; vertexCount: number; guestVertexPtr: number; stride: number; byteLen: number; forceCullNone: boolean };

interface PendingArenaRecord {
    key: number;
    identity: ArenaPipelineIdentitySnapshot;
    commandStart: number;
    checkpoint: { commandCount: number; bumpCursor: number };
}

/** How many constant registers a frame capture carries per draw. Enough for the ps_1_x banks
 *  and a vertex transform, without turning every draw record into a 4 KB blob. */
const PS_CAPTURE_REGISTERS = 8;
const VS_CAPTURE_REGISTERS = 16;

export class D3D9Device {
    /** Set when the parent interface is IDirect3D9Ex; Ex reset/pool rules follow the parent. */
    public isExtended = false;
    // A hardware-3D presenter owns the screen: GDI window-background paints must NOT composite
    // over (and black out) the rendered 3D frame. Matches D3D8/Glide/OpenGL (RenderActive contract).
    readonly suppressGdiOverlay = true;

    private frameCount: number = 0;
    private lastOverlayClearFrame: number = -1;
    private prevPresentTime: number = 0;
    /** Allocated only after the opt-in census sees its first finalized frame. */
    private megaBatchCensus: D3D9MegaBatchCensus | null = null;
    /** Coarse, accepted-run pricing. Kept out of pair loops so profiling does not create
     * the bookkeeping cost it is trying to measure. */
    private wbufRunAccepted = 0;
    private wbufRunTryMs = 0;
    private wbufRunRecordMs = 0;
    private compactShadowDescriptors = 0;
    private compactShadowParityFailures = 0;
    private compactAuthoritativeRuns = 0;
    private compactStorageRuns = 0;
    private wbufRunPipelineMs = 0;
    private wbufRunResourcesMs = 0;
    private wbufRunCaptureMs = 0;
    private wbufRunPublishMs = 0;
    private ordinaryIndexedProfiled = 0;
    private ordinaryIndexedHostMs = 0;
    private ordinaryIndexedUploadMs = 0;
    private ordinaryIndexedPipelineMs = 0;
    private ordinaryIndexedCaptureMs = 0;
    private ordinaryIndexedRecordMs = 0;
    private compactCaptureReuseHits = 0;
    private compactCaptureReuseMisses = 0;
    private compactPipelineIdentityHits = 0;
    private compactPipelineIdentityMisses = 0;

    private backend: WebGPUBackend;
    private readonly d3d9MsaaProbe: D3D9MsaaAdapterProbe | null;
    /** Device-wide sample count selected by the explicitly accepted presentation params. */
    private d3d9MsaaSampleCount = 1;
    /** Per-render-target sample type; zero means the ordinary single-sample target. */
    private renderTargetSampleTypes: number[] = new Array(D3D9_MAX_RENDER_TARGETS).fill(0);
    private d3d9MsaaCache: D3D9MultisampleTargetCache | null = null;
    /**
     * Standalone IDirect3DSurface9 depth attachments are not TextureStore entries: unlike a
     * texture-backed depth mip they have no guest-visible color image. Keep their identity and
     * GPU attachment here so SetDepthStencilSurface can select the real surface instead of
     * silently falling back to the implicit size-matched depth buffer.
     */
    private standaloneDepthSurfaces = new Map<number, {
        width: number;
        height: number;
        format: GPUTextureFormat;
        sampleCount: number;
        texture: GPUTexture | null;
        view: GPUTextureView | null;
    }>();
    private activeStandaloneDepthSurface: number | null = null;

    /**
     * Guest RAM, re-derived per use. A view stored across a WASM memory growth is
     * DETACHED, and every later subarray()/set() on it throws — the device outlives
     * any number of growths, so it may never hold one. This is the invariant
     * process.getCurrentMemory() documents for all of its callers.
     */
    private get memory(): Uint8Array {
        return System.getInstance().process!.getCurrentMemory();
    }

    /** THE per-slot stream state (see StreamBindingTable). Written only by setStreamSource. */
    private readonly streams = new StreamBindingTable();
    /** Reused per-draw binding plan — every slot a draw binds, slot 0 included. */
    private readonly streamPlan = new StreamBindingPlan();
    private stateTracker = new D3D9StateTracker(this.streams);
    private commandRecorder = new D3D9CommandRecorder(new RenderFramePool(2));
    private backendExecutor: D3D9BackendExecutor;
    private gpuQueryManager: D3D9QueryManager | null = null;

    private vertexBuffers = new VertexBufferStore();
    private indexBuffers = new IndexBufferStore();
    private textures = new TextureStore();
    /** Volume textures use a separate negative index namespace so the existing
     *  TextureStore's 2-D/cube metadata remains type-safe. */
    private volumeByPointer = new Map<number, number>();
    private volumeByIndex = new Map<number, { pointer: number; texture: GPUTexture | null; view: GPUTextureView | null; dirty: boolean }>();
    private nextVolumeIndex = -1;
    readonly texturePalettes = new TexturePaletteStore();

    private pipelineCache: LruCache<string, number>;
    private pipelineCacheMaxSize = 128;
    private currentPipelineKey: string | null = null;
    private currentPipelineId: number | null = null;

    /** Diagnostic overrides — each removes exactly ONE pipeline stage, so the first toggle
     *  that makes an invisible draw appear NAMES the stage. Sticky; read them back with
     *  getDebugFlags() before trusting any later observation. */
    private debugFlags: D3D9DebugFlags = { ...DEFAULT_D3D9_DEBUG_FLAGS };

    private clearState: ClearState = {
        color: { r: 0, g: 0, b: 0, a: 1 },
    };

    /** D3DCREATE_* / SetSoftwareVertexProcessing state.  The CPU FFP ProcessVertices path
     * consults this bit, while programmable SWVP remains capability-checked explicitly. */
    private softwareVertexProcessing = false;
    private npatchMode = 0;
    private dialogBoxMode = false;

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
    /** D3D9 keeps four independent render-target slots. Slot 0 selects the pass size;
     * slots 1..3 are additional color attachments for MRT. */
    private renderTargetIndices: Array<number | null> = new Array(D3D9_MAX_RENDER_TARGETS).fill(null);
    /** Texture-backed depth surface currently bound through SetDepthStencilSurface. */
    private depthTextureIndex: number | null = null;
    private renderTargetFaces: number[] = new Array(D3D9_MAX_RENDER_TARGETS).fill(-1);
    private renderTargetGpuFormats = new Map<number, GPUTextureFormat>();
    /** Per-GPU-texture sRGB views, keyed by dimension. WebGPU requires the
     *  compatible sRGB format in the texture's viewFormats at creation time. */
    private srgbTextureViews = new WeakMap<GPUTexture, Map<string, GPUTextureView>>();
    // Per-face 2D render views into cube RTs, cached by "index:face:level".
    private cubeFaceRenderViews: Map<string, GPUTextureView> = new Map();
    // Depth attachments for RT passes, cached by "WxH:format:samples" (most RTs share the screen size).
    private rtDepthCache: Map<string, { texture: GPUTexture; view: GPUTextureView }> = new Map();
    // [diag] dedup'd recent SetRenderTarget resolutions + RT texture creations (harness rtDebug verb).
    private rtResolveLog: string[] = [];
    private rtCreateLog: string[] = [];
    /** Raw form of the last recorded resolve, so a repeat costs a compare, not a format. */
    private rtResolveLast = { surf: -1, metaHit: false, tex: -1, idx: -1 as number | null, isRT: false };
    /** Record a SetRenderTarget surface→texture resolution (dedup'd) for diagnostics.
     *  Called on every SetRenderTarget, and games set the target per pass, so the dedup
     *  decision is made on the raw numbers — the string is built only when it changes. */
    noteRtResolve(surfacePtr: number, metaHit: boolean, texturePtr: number): void {
        const idx = texturePtr ? this.textures.getIndex(texturePtr) : null;
        const isRT = idx !== null && this.textures.isRenderTarget(idx);
        const last = this.rtResolveLast;
        if (last.surf === surfacePtr && last.metaHit === metaHit && last.tex === texturePtr
            && last.idx === idx && last.isRT === isRT) return;
        last.surf = surfacePtr; last.metaHit = metaHit; last.tex = texturePtr; last.idx = idx; last.isRT = isRT;
        this.rtResolveLog.push(
            `surf=0x${surfacePtr.toString(16)} metaHit=${metaHit} tex=0x${texturePtr.toString(16)} idx=${idx} isRT=${isRT}`);
        if (this.rtResolveLog.length > 16) this.rtResolveLog.shift();
    }
    /** HARNESS rtDebug verb: what SetRenderTarget saw + which textures were created as RTs. */
    getRtDebug(): { resolves: string[]; creates: string[]; currentRtIndex: number | null; targets: Array<number | null> } {
        return {
            resolves: [...this.rtResolveLog],
            creates: [...this.rtCreateLog],
            currentRtIndex: this.currentRtIndex,
            targets: [...this.renderTargetIndices],
        };
    }

    /** HARNESS passCensus verb: what each recently submitted render pass was opened with. */
    getPassDebug(): ReturnType<D3D9BackendExecutor["getPassDebug"]> {
        return this.backendExecutor.getPassDebug();
    }

    /** [diag] The executor, for harness censuses (submitCensus). */
    getBackendExecutor(): D3D9BackendExecutor {
        return this.backendExecutor;
    }

    /** The attachment formats used by both the render pass and every pipeline variant.
     * RT textures are allocated in the backend's color format; a missing GPU texture or a
     * size mismatch is a hard seam error because WebGPU would otherwise reject the pass and
     * discard unrelated draws in the same command buffer. */
    private activeColorTargetFormats(): Array<GPUTextureFormat | null> | null {
        const linearFormat = this.backend.getFormat();
        if (!linearFormat) {
            Logger.error(LogCategory.D3D9, "[D3D9] MRT: backend has no color format");
            return null;
        }
        const format = this.srgbWriteFormat(linearFormat);
        if (!format) {
            Logger.error(LogCategory.D3D9,
                `[D3D9] SRGBWRITEENABLE requested for a backend format without an sRGB view: ${linearFormat}`);
            return null;
        }
        const rt0 = this.renderTargetIndices[0];
        const base = rt0 === null
            ? this.backendExecutor.getCanvasSize()
            : { width: this.textures.getWidth(rt0), height: this.textures.getHeight(rt0) };
        let last = 0;
        for (let i = 1; i < this.renderTargetIndices.length; i++) {
            if (this.renderTargetIndices[i] !== null) last = i;
        }
        const formats: Array<GPUTextureFormat | null> = new Array(last + 1).fill(null);
        formats[0] = format;
        for (let i = 0; i <= last; i++) {
            const index = this.renderTargetIndices[i];
            if (index === null) continue;
            if (!this.textures.isRenderTarget(index) || !this.textures.getGpuTexture(index)) {
                Logger.error(LogCategory.D3D9,
                    `[D3D9] MRT: target ${i} is missing a renderable GPU surface (texture index ${index})`);
                return null;
            }
            const actualFormat = this.renderTargetGpuFormats.get(index);
            if (actualFormat !== undefined && actualFormat !== linearFormat) {
                Logger.error(LogCategory.D3D9,
                    `[D3D9] MRT: target ${i} GPU format ${actualFormat} is incompatible with ${linearFormat}`);
                return null;
            }
            const width = this.textures.getWidth(index), height = this.textures.getHeight(index);
            if (width !== base.width || height !== base.height) {
                Logger.error(LogCategory.D3D9,
                    `[D3D9] MRT: target ${i} size ${width}x${height} is incompatible with `
                    + `${base.width}x${base.height}`);
                return null;
            }
            // createTexture/createCubeTexture deliberately allocate every D3D render target in
            // backend.getFormat(). If that invariant changes, this is the loud validation point
            // rather than a deferred WebGPU pipeline/pass error.
            formats[i] = format;
        }
        return formats;
    }

    /** Return the attachment view format selected by D3DRS_SRGBWRITEENABLE. */
    private srgbWriteFormat(linearFormat: GPUTextureFormat): GPUTextureFormat | null {
        if (this.getRS(D3DRS_SRGBWRITEENABLE) === 0) return linearFormat;
        return dxSrgbViewFormat(linearFormat);
    }

    private renderTargetView(index: number, srgbWrite: boolean): GPUTextureView | null {
        const view = this.textures.getView(index);
        if (!srgbWrite) return view;
        const texture = this.textures.getGpuTexture(index);
        const linearFormat = this.renderTargetGpuFormats.get(index) ?? this.backend.getFormat();
        const srgbFormat = linearFormat ? dxSrgbViewFormat(linearFormat) : null;
        if (!texture || !srgbFormat) return null;
        let byFormat = this.srgbTextureViews.get(texture);
        if (!byFormat) {
            byFormat = new Map();
            this.srgbTextureViews.set(texture, byFormat);
        }
        const key = `rt:${srgbFormat}`;
        let srgbView = byFormat.get(key);
        if (!srgbView) {
            srgbView = texture.createView({ format: srgbFormat });
            byFormat.set(key, srgbView);
        }
        return srgbView;
    }

    /** Actual format of a texture in the WebGPU store (D3D format is converted on upload). */
    private textureGpuFormat(index: number): GPUTextureFormat | null {
        if (this.isVolumeIndex(index)) {
            return this.volumeEntry(index) ? "rgba8unorm" : null;
        }
        const rtFormat = this.renderTargetGpuFormats.get(index);
        if (rtFormat !== undefined) return rtFormat;
        const format = this.textures.getFormat(index);
        if (isD3DFloatFormat(format)) {
            return resolveD3D9FloatTexturePolicy(format).gpuFormat;
        }
        if (isBlockCompressedFormat(format) && canUploadNativeBC(
            format,
            this.textures.getWidth(index),
            this.textures.getHeight(index),
            this.backend.supportsBC(),
        )) {
            return getNativeBCTextureFormat(format);
        }
        // All non-RT, non-native-BC resources are decoded into rgba8unorm.
        return "rgba8unorm";
    }

    /** Resolve a bound texture view with D3DSAMP_SRGBTEXTURE applied. */
    private resolveTextureView(stage: number, index: number, cube: boolean): GPUTextureView | null {
        if (this.isVolumeIndex(index)) return this.resolveVolumeTextureView(index);
        const view = this.textures.getView(index);
        if (!view) return null;
        const spec = this.samplerSpecForStage(stage);
        if (!spec.srgbTexture) return view;
        const texture = this.textures.getGpuTexture(index);
        const format = texture ? this.textureGpuFormat(index) : null;
        const srgbFormat = format ? dxSrgbViewFormat(format) : null;
        if (!texture || !srgbFormat) return null;
        const key = `${srgbFormat}:${cube ? "cube" : "2d"}`;
        let byFormat = this.srgbTextureViews.get(texture);
        if (!byFormat) {
            byFormat = new Map();
            this.srgbTextureViews.set(texture, byFormat);
        }
        let srgbView = byFormat.get(key);
        if (!srgbView) {
            srgbView = texture.createView({
                format: srgbFormat,
                dimension: cube ? "cube" : "2d",
                ...(cube ? { arrayLayerCount: 6 } : {}),
            });
            byFormat.set(key, srgbView);
        }
        return srgbView;
    }

    private activeColorTargetKey(): string {
        const formats = this.activeColorTargetFormats();
        return formats ? formats.map(f => f ?? "-").join(",") : "invalid";
    }

    private activeColorTargetStates(): Array<GPUColorTargetState | null> | null {
        const formats = this.activeColorTargetFormats();
        if (!isD3D9BlendStateRepresentable(this.getRS)) {
            Logger.error(LogCategory.D3D9,
                "[D3D9] requested blend factor/operation is not representable by this WebGPU backend; refusing draw");
            return null;
        }
        return formats?.map((format, targetIndex) => format
            ? buildColorTargetState(format, this.getRS, targetIndex)
            : null) ?? null;
    }

    /** Sample count of the color attachment used by the next pass/pipeline. */
    private activeRenderTargetSampleCount(): number {
        const type = this.renderTargetSampleTypes[0] ?? 0;
        if (this.renderTargetIndices[0] === null && type === 0) return this.d3d9MsaaSampleCount;
        return d3d9MsaaSampleCount(type) ?? 1;
    }

    /** HARNESS: last `n` per-present summaries (newest last). See frameLog verb. */
    getFrameLog(n: number = 60): Array<{ p: number; hasClear: boolean; flags: number; cmds: number; draws: number; color: string; rtSets: number; rtNonBack: number }> {
        return this.frameLogRing.slice(-Math.max(1, n));
    }

    /** D3D9 SetRenderTarget(index, texturePtr). texturePtr 0 (or a non-RT surface) = render to the
     *  swap-chain backbuffer; an RT texture's pointer = render-to-texture. The module handler resolves
     *  the surface pointer → its parent texture pointer (surfaceMeta) before calling us. Switching the
     *  target eagerly flushes the commands accumulated for the previous target as their own pass. */
    setRenderTarget(_index: number, texturePtr: number, face: number = -1, multiSampleType = 0): number {
        const index = _index >>> 0;
        if (index >= D3D9_MAX_RENDER_TARGETS) {
            Logger.error(LogCategory.D3D9, `[D3D9] MRT: render-target index ${index} is out of range`);
            return D3DERR_INVALIDCALL;
        }
        if (!this.supportsD3D9MultisampleType(multiSampleType)) return D3DERR_NOTAVAILABLE;
        const requestedSampleCount = d3d9MsaaSampleCount(multiSampleType) ?? 1;
        // Pipelines are device-wide in this backend. A target with a different
        // sample count cannot be attached safely without a second pipeline cache.
        if (index === 0 && requestedSampleCount !== this.d3d9MsaaSampleCount) return D3DERR_NOTAVAILABLE;
        if (index === 0 && this.activeStandaloneDepthSurface !== null) {
            const depth = this.standaloneDepthBinding(this.activeStandaloneDepthSurface);
            if (depth && !resolveD3D9StandaloneDepthPolicyBySampleCount(
                depth.sampleCount,
                requestedSampleCount,
            ).supported) return D3DERR_INVALIDCALL;
        }
        this.rtSetsThisFrame++;
        let newTarget: number | null = null;
        let newFace = -1;
        if (texturePtr !== 0) {
            const idx = this.textures.getIndex(texturePtr);
            if (idx === null || !this.textures.isRenderTarget(idx)) {
                Logger.error(LogCategory.D3D9,
                    `[D3D9] MRT: SetRenderTarget(${index}) received missing/non-RT texture 0x${(texturePtr >>> 0).toString(16)}`);
                return D3DERR_INVALIDCALL;
            }
            // DEFAULT render-target handles survive a device loss, but their GPU object does
            // not. Recreate it before accepting the bind so Reset/rehydration can follow the
            // normal SetRenderTarget call order without making the app know about WebGPU loss.
            if (!this.textures.getGpuTexture(idx)) {
                if (!this.backend.getDevice()) return D3DERR_INVALIDCALL;
                this.ensureTexture(idx);
            }
            if (!this.textures.getGpuTexture(idx)) return D3DERR_INVALIDCALL;
            newTarget = idx;
            // Only a cube RT honors a face selector; a plain 2D RT renders to layer 0.
            newFace = this.textures.isCubeMap(idx) ? face : -1;
        }
        // WebGPU render passes use one sample count and one attachment extent
        // for every enabled color target.  D3D9 validates this at bind time;
        // accepting a mismatched MRT and dropping it later would silently turn
        // an MSAA target into a single-sample draw (or lose the whole frame).
        const anchorSampleCount = index === 0
            ? requestedSampleCount
            : this.renderTargetIndices[0] === null
                ? this.d3d9MsaaSampleCount
                : (d3d9MsaaSampleCount(this.renderTargetSampleTypes[0] ?? 0) ?? 1);
        if (index !== 0 && requestedSampleCount !== anchorSampleCount) return D3DERR_INVALIDCALL;
        if (index === 0) {
            for (let rt = 1; rt < D3D9_MAX_RENDER_TARGETS; rt++) {
                if (this.renderTargetIndices[rt] === null) continue;
                if ((d3d9MsaaSampleCount(this.renderTargetSampleTypes[rt] ?? 0) ?? 1) !== requestedSampleCount) {
                    return D3DERR_INVALIDCALL;
                }
            }
        }
        if (newTarget !== null) {
            const width = this.textures.getWidth(newTarget);
            const height = this.textures.getHeight(newTarget);
            // When RT0 is the implicit backbuffer, there is no texture index to
            // include in `peers`; use the actual canvas attachment as the MRT
            // anchor instead of accepting an extent that beginRenderPass will
            // reject later.
            if (index !== 0 && this.renderTargetIndices[0] === null) {
                const canvas = this.backendExecutor.getCanvasSize();
                const compatibility = resolveD3D9MrtCompatibility(
                    { sampleCount: this.d3d9MsaaSampleCount, width: canvas.width, height: canvas.height },
                    { sampleCount: requestedSampleCount, width, height },
                );
                if (!compatibility.supported) return D3DERR_INVALIDCALL;
            }
            const peers = index === 0
                ? this.renderTargetIndices.slice(1)
                : [this.renderTargetIndices[0]];
            for (const peer of peers) {
                if (peer === null) continue;
                const compatibility = resolveD3D9MrtCompatibility(
                    {
                        // For RT0 replacement the preceding loop has already
                        // established that every peer has requestedSampleCount.
                        // For an RT1..3 bind, peer is slot 0 and its recorded
                        // sample type is the anchor.
                        sampleCount: index === 0
                            ? requestedSampleCount
                            : d3d9MsaaSampleCount(this.renderTargetSampleTypes[0] ?? 0) ?? 1,
                        width: this.textures.getWidth(peer),
                        height: this.textures.getHeight(peer),
                    },
                    { sampleCount: requestedSampleCount, width, height },
                );
                if (!compatibility.supported) {
                    return D3DERR_INVALIDCALL;
                }
            }
        }
        if (newTarget !== null) this.rtNonBackThisFrame++;
        if (newTarget === this.renderTargetIndices[index] && newFace === this.renderTargetFaces[index]
            && (this.renderTargetSampleTypes[index] ?? 0) === (multiSampleType >>> 0)) {
            // D3D9 resets the viewport even when the caller rebinds the current target.
            if (index === 0) {
                const { w, h } = this.getCurrentTargetSize();
                this.viewport = fullTargetViewport(w, h);
            }
            return 0;
        }
        // Flush everything drawn for the current target/face before switching.
        this.submitFrame(false);
        this.renderTargetIndices[index] = newTarget;
        this.renderTargetFaces[index] = newFace;
        this.renderTargetSampleTypes[index] = multiSampleType >>> 0;
        this.currentRtIndex = this.renderTargetIndices[0] ?? null;
        this.currentRtFace = this.renderTargetFaces[0] ?? -1;
        this.invalidateLastResolve();
        // Per D3D9 SetRenderTarget, the new target starts with a full-target viewport.
        // In particular, returning from a 512x512 bloom RT must not leave a 512x480
        // viewport on a 1024x768 swap-chain backbuffer.
        if (index === 0) {
            const { w, h } = this.getCurrentTargetSize();
            this.viewport = fullTargetViewport(w, h);
        }
        return 0;
    }

    /** Bind a texture-backed depth surface. Standalone/implicit surfaces pass zero and
     * continue to use the executor's size-matched default depth attachment. */
    setDepthStencilTexture(texturePtr: number): number {
        let next: number | null = null;
        if (texturePtr !== 0) {
            const index = this.textures.getIndex(texturePtr >>> 0);
            if (index === null || !isDxDepthStencilFormat(this.textures.getFormat(index), 9)) {
                return D3DERR_INVALIDCALL;
            }
            const device = this.backend.getDevice();
            if (device) this.ensureDepthTexture(index, device);
            if (!this.textures.getView(index)) return D3DERR_INVALIDCALL;
            next = index;
        }
        if (next === this.depthTextureIndex && this.activeStandaloneDepthSurface === null) return D3D_OK;
        this.submitFrame(false);
        this.activeStandaloneDepthSurface = null;
        this.depthTextureIndex = next;
        this.currentPipelineKey = null;
        this.currentPipelineId = null;
        this.invalidateLastResolve();
        return D3D_OK;
    }

    /** Convert a D3D9 depth format to the portable WebGPU attachment format. */
    private standaloneDepthFormat(format: number): GPUTextureFormat {
        // D24S8/D24FS8/D24X4S4/D15S1 and the D32+stencil forms need a stencil plane.
        if (format === 73 || format === 75 || format === 79 || format === 83 || format === 85) {
            return "depth24plus-stencil8";
        }
        return format === 71 || format === 82 || format === 84 ? "depth32float" : "depth24plus";
    }

    private standaloneDepthBinding(surfacePtr: number): {
        width: number;
        height: number;
        format: GPUTextureFormat;
        sampleCount: number;
        texture: GPUTexture | null;
        view: GPUTextureView | null;
    } | null {
        return this.standaloneDepthSurfaces.get(surfacePtr >>> 0) ?? null;
    }

    private ensureStandaloneDepthSurface(surfacePtr: number): {
        width: number;
        height: number;
        format: GPUTextureFormat;
        sampleCount: number;
        texture: GPUTexture;
        view: GPUTextureView;
    } | null {
        const binding = this.standaloneDepthBinding(surfacePtr);
        if (!binding) return null;
        if (binding.texture && binding.view) return binding as {
            width: number;
            height: number;
            format: GPUTextureFormat;
            sampleCount: number;
            texture: GPUTexture;
            view: GPUTextureView;
        };
        const device = this.backend.getDevice();
        if (!device) return null;
        const texture = device.createTexture({
            size: { width: binding.width, height: binding.height, depthOrArrayLayers: 1 },
            format: binding.format,
            sampleCount: binding.sampleCount,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        binding.texture = texture;
        binding.view = texture.createView();
        return binding as {
            width: number;
            height: number;
            format: GPUTextureFormat;
            sampleCount: number;
            texture: GPUTexture;
            view: GPUTextureView;
        };
    }

    /**
     * Bind a standalone CreateDepthStencilSurface allocation. The sample count is checked
     * against the active RT before any command is flushed, and the resulting attachment is
     * reused by both single-sample passes and the MSAA resolve target.
     */
    setDepthStencilSurface(
        surfacePtr: number,
        width: number,
        height: number,
        format: number,
        multiSampleType: number,
    ): number {
        const ptr = surfacePtr >>> 0;
        if (!ptr || width <= 0 || height <= 0 || !isDxDepthStencilFormat(format >>> 0, 9)) {
            return D3DERR_INVALIDCALL;
        }
        if (!this.supportsD3D9MultisampleType(multiSampleType)) return D3DERR_NOTAVAILABLE;
        const sampleCount = d3d9MsaaSampleCount(multiSampleType) ?? 1;
        // Sample COUNTS on both sides: the active target's count already accounts for the
        // implicit backbuffer, and feeding it to the type-decoding entry point read count 1
        // as D3DMULTISAMPLE_NONMASKABLE and refused every non-MSAA depth surface.
        const depthPolicy = resolveD3D9StandaloneDepthPolicyBySampleCount(
            sampleCount, this.activeRenderTargetSampleCount());
        if (!depthPolicy.supported) return D3DERR_INVALIDCALL;
        const previous = this.activeStandaloneDepthSurface;
        const current = this.standaloneDepthSurfaces.get(ptr);
        if (!current || current.width !== width || current.height !== height
            || current.format !== this.standaloneDepthFormat(format)
            || current.sampleCount !== sampleCount) {
            if (current?.texture) current.texture.destroy();
            this.standaloneDepthSurfaces.set(ptr, {
                width,
                height,
                format: this.standaloneDepthFormat(format),
                sampleCount,
                texture: null,
                view: null,
            });
        }
        if (previous === ptr && this.depthTextureIndex === null) return D3D_OK;
        this.submitFrame(false);
        this.depthTextureIndex = null;
        this.activeStandaloneDepthSurface = ptr;
        if (!this.ensureStandaloneDepthSurface(ptr)) {
            this.activeStandaloneDepthSurface = null;
            return D3DERR_INVALIDCALL;
        }
        this.currentPipelineKey = null;
        this.currentPipelineId = null;
        this.invalidateLastResolve();
        return D3D_OK;
    }

    /** Release GPU state for a standalone depth surface when its COM object dies. */
    releaseStandaloneDepthSurface(surfacePtr: number): void {
        const ptr = surfacePtr >>> 0;
        if (this.activeStandaloneDepthSurface === ptr) {
            this.submitFrame(false);
            this.activeStandaloneDepthSurface = null;
            this.currentPipelineKey = null;
            this.currentPipelineId = null;
            this.invalidateLastResolve();
        }
        const binding = this.standaloneDepthSurfaces.get(ptr);
        binding?.texture?.destroy();
        this.standaloneDepthSurfaces.delete(ptr);
    }

    private clearStandaloneDepthSurfaces(): void {
        for (const binding of this.standaloneDepthSurfaces.values()) binding.texture?.destroy();
        this.standaloneDepthSurfaces.clear();
        this.activeStandaloneDepthSurface = null;
    }

    private depthTextureFormat(index: number): GPUTextureFormat {
        const format = this.textures.getFormat(index);
        // WebGPU has no D24FS8/D32-UNORM formats.  D24S8 (and the other D3D9
        // stencil-bearing depth formats) use the portable depth24plus-stencil8
        // attachment so the D3D9 stencil state has a real plane. Floating D24 and
        // both D32 variants remain depth32float until a depth32float-stencil8 probe
        // is available.
        if (format === 73 || format === 75 || format === 79 || format === 83 || format === 85) {
            return "depth24plus-stencil8";
        }
        return format === 71 || format === 82 || format === 83 || format === 84
            ? "depth32float" : "depth24plus";
    }

    private activeDepthTargetFormat(): GPUTextureFormat {
        if (this.depthTextureIndex !== null) return this.depthTextureFormat(this.depthTextureIndex);
        const standalone = this.activeStandaloneDepthSurface === null
            ? null : this.standaloneDepthBinding(this.activeStandaloneDepthSurface);
        return standalone?.format ?? "depth24plus-stencil8";
    }

    private ensureDepthTexture(index: number, device: GPUDevice): void {
        if (this.textures.getGpuTexture(index)) return;
        const texture = device.createTexture({
            size: {
                width: this.textures.getWidth(index),
                height: this.textures.getHeight(index),
                depthOrArrayLayers: 1,
            },
            format: this.depthTextureFormat(index),
            mipLevelCount: 1,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.textures.setGpuTexture(index, texture, texture.createView());
        this.gpuResourceGeneration++; // a new GPU object invalidates the redundant-RT fast path
        this.textures.setDirty(index, false);
    }

    /** A 2D render view into one face (+ mip level) of a cube RT. WebGPU renders into a single
     *  array layer via a 2d view with baseArrayLayer=face; the cube's sampling view stays the
     *  dimension:"cube" view created in createCubeTexture. Cached per (index, face, level). */
    private getCubeFaceRenderView(index: number, face: number, level: number, srgbWrite = false): GPUTextureView | null {
        const tex = this.textures.getGpuTexture(index);
        if (!tex) return null;
        const f = face < 0 ? 0 : face;
        const key = `${index}:${f}:${level}:${srgbWrite ? "srgb" : "linear"}`;
        let view = this.cubeFaceRenderViews.get(key);
        if (!view) {
            const linearFormat = this.renderTargetGpuFormats.get(index) ?? this.backend.getFormat();
            const format = srgbWrite && linearFormat ? dxSrgbViewFormat(linearFormat) : null;
            view = tex.createView({
                ...(format ? { format } : {}),
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
    private getRtDepthView(
        width: number,
        height: number,
        format: GPUTextureFormat = "depth24plus-stencil8",
        sampleCount = 1,
    ): GPUTextureView {
        const key = `${width}x${height}:${format}:${sampleCount}`;
        let entry = this.rtDepthCache.get(key);
        if (!entry) {
            const dev = this.backend.getDevice()!;
            const tex = dev.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format,
                sampleCount,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
            entry = { texture: tex, view: tex.createView() };
            this.rtDepthCache.set(key, entry);
        }
        return entry.view;
    }

    /**
     * The depth/stencil attachment for a pass whose color target is renderW x renderH.
     *
     * D3D9 lets the bound depth surface be LARGER than the render target — only its
     * top-left renderW x renderH sub-rect participates (DXVK BindFramebuffer encodes the
     * same rule, and Vulkan can bind the oversized image directly). WebGPU requires every
     * attachment of a pass to have identical dimensions, so an exact match binds the real
     * surface and any other size renders into a cached scratch depth of the render area in
     * the SAME format and sample count — the pipeline's depth format keeps agreeing with
     * the attachment, which a dropped depth attachment would not.
     */
    private resolveDepthAttachment(renderW: number, renderH: number): {
        view: GPUTextureView;
        format: GPUTextureFormat;
        width: number;
        height: number;
        substituted: boolean;
    } | null {
        let bound: { view: GPUTextureView; format: GPUTextureFormat; width: number; height: number; sampleCount: number } | null = null;
        if (this.depthTextureIndex !== null) {
            const device = this.backend.getDevice();
            if (device) this.ensureDepthTexture(this.depthTextureIndex, device);
            const view = this.textures.getView(this.depthTextureIndex);
            if (!view) return null;
            bound = {
                view,
                format: this.depthTextureFormat(this.depthTextureIndex),
                width: this.textures.getWidth(this.depthTextureIndex),
                height: this.textures.getHeight(this.depthTextureIndex),
                sampleCount: 1,
            };
        } else if (this.activeStandaloneDepthSurface !== null) {
            const depth = this.ensureStandaloneDepthSurface(this.activeStandaloneDepthSurface);
            if (!depth) return null;
            bound = { view: depth.view, format: depth.format, width: depth.width, height: depth.height, sampleCount: depth.sampleCount };
        }
        if (!bound) return null;
        if (bound.width === renderW && bound.height === renderH) {
            return { view: bound.view, format: bound.format, width: bound.width, height: bound.height, substituted: false };
        }
        const key = `${bound.width}x${bound.height}->${renderW}x${renderH}`;
        if (!this.depthResizeWarned.has(key)) {
            this.depthResizeWarned.add(key);
            Logger.warn(
                LogCategory.D3D9,
                `[D3D9] depth surface ${bound.width}x${bound.height} does not match the ${renderW}x${renderH} render area; ` +
                "rendering into a scratch depth of the render area (WebGPU requires equal attachment sizes)",
            );
        }
        return {
            view: this.getRtDepthView(renderW, renderH, bound.format, bound.sampleCount),
            format: bound.format,
            width: renderW,
            height: renderH,
            substituted: true,
        };
    }

    /** Dedup for the depth-resize warning, keyed "boundWxH->renderWxH". */
    private depthResizeWarned = new Set<string>();

    // Temporary lock records for mip levels > 0.
    private mipLevelLocks: Map<string, { guestPtr: number; pitch: number }> = new Map();
    // Persisted mip pixel data (level > 0) for D3DXFilterTexture and LockRect round-trips.
    private mipLevelData: Map<string, Uint8Array> = new Map();

    // ── Cube-texture per-face pixel storage (static / LockRect'd cubes) ──────
    // Active LockRect scratch for a cube face, keyed "cubePtr:face:level".
    private cubeFaceLocks: Map<string, {
        guestPtr: number;
        pitch: number;
        readOnly: boolean;
        noDirtyUpdate: boolean;
    }> = new Map();
    // Persisted per-face pixel data, keyed "cubePtr:face:level" (uploaded by ensureCubeTexture).
    private cubeFaceData: Map<string, Uint8Array> = new Map();

    // Reusable buffer for vertex conversion to avoid GC pressure
    private vertexConversionBuffer: Uint8Array | null = null;
    private vertexConversionBufferSize: number = 0;
    /** Widened index scratch for the de-indexing UP path (16- and 32-bit indices share it). */
    private indexScratch: Uint32Array | null = null;
    private dipUpIndexRangeWarned = false;

    /** D3DCAPS9.MaxStreams from the caps blob we report (caps.ts, offset 188). */
    static readonly MAX_STREAMS = MAX_VERTEX_STREAMS;
    /** Reuse pool for DrawPrimitiveUP vertex buffers (lazily created — needs the device). */
    private vbPool: DynamicVbPool | null = null;

    // Reusable buffer for texture ARGB→RGBA conversion to avoid GC pressure
    private textureConversionBuffer: Uint8Array | null = null;

    // ── Vertex / pixel shader state (programmable path) ──────────────────
    private vsShaderRegistry = new Map<number, CompiledVs>();
    private vsNextHandle = 1;
    private activeVertexShader: number = 0;   // 0 = FFP mode
    private vsConstants = new Float32Array(VS_FLOAT_REGISTER_COUNT * 4);   // HW c0-c255
    /** SWVP owns the expanded D3D9 register file (c0-c8191).  It is separate
     * from the bounded WebGPU uniform bank so enabling software VP never makes
     * a giant invalid uniform buffer. */
    private swvpVsConstants = new Float32Array(8192 * 4);
    private swvpVsIntegerConstants = new Int32Array(2048 * 4);
    private swvpVsBooleanConstants = new Uint8Array(2048);
    private vsConstantBits = new Uint32Array(this.vsConstants.buffer);
    /** Bit view of the SWVP bank. Its own field, not a slice of vsConstantBits: the two banks
     *  are separate allocations (c0-c255 vs c0-c8191). Neither Float32Array is ever
     *  reallocated — no assignment to either exists — so the view is bound once, per §3.1.
     *  A reallocation of the bank would have to rebuild this. */
    private swvpVsConstantBits = new Uint32Array(this.swvpVsConstants.buffer);
    private vsIntegerConstants = new Int32Array(SHADER_INTEGER_REGISTER_COUNT * 4); // i0-i15
    private vsIntegerBits = new Uint32Array(this.vsIntegerConstants.buffer);
    private vsBooleanMask = 0; // b0-b15, normalized to one bit per register
    private vsConstantsVersion = 0;

    private psShaderRegistry = new Map<number, CompiledPs>();
    private psNextHandle = 1;
    private activePixelShader: number = 0;
    /** Harness-only hybrid fragment output diagnostic: 0 normal, 1 tex0, 2 colour, 3 white. */
    private hybridDebugOutput = 0;
    // c0-c223. Integer and boolean registers have separate fixed banks in the WGSL block.
    private psConstants = new Float32Array(PS_FLOAT_REGISTER_COUNT * 4);
    private psConstantBits = new Uint32Array(this.psConstants.buffer);
    private psIntegerConstants = new Int32Array(SHADER_INTEGER_REGISTER_COUNT * 4); // i0-i15
    private psIntegerBits = new Uint32Array(this.psIntegerConstants.buffer);
    private psBooleanMask = 0; // b0-b15, normalized to one bit per register
    private psConstantsVersion = 0;

    /** Harness-only shader evidence. WGSL is retained before WebGPU validation so a failed
     * build remains inspectable; the opcode sidecar is deliberately marked incomplete until
     * every emitter dispatch records status directly. */
    private shaderDiagnosticNextPair = 1;
    private shaderDiagnostics = new Map<string, ShaderDiagnosticRecord>();
    /** A second INDEX over the very same records, keyed by the numeric handle the draw path
     *  already has. It exists because `shaderDiagnostics` can only be reached by building a
     *  `stage:handle` string, and the draw path would allocate two of them per draw. Written in
     *  exactly one place, beside the map it indexes, so the two cannot drift. */
    private vsDiagnosticsByHandle = new Map<number, ShaderDiagnosticRecord>();
    private psDiagnosticsByHandle = new Map<number, ShaderDiagnosticRecord>();
    /** Bumped whenever a record is (re)published, so a reference cached on a shader pair can
     *  tell it is still the record that handle names. */
    private shaderDiagnosticEpoch = 0;
    private shaderPairDiagnostics = new Map<number, ShaderPairDiagnosticRecord>();
    private shaderPipelinePairs = new Map<number, number>();
    private shaderBuildFailures = 0;
    private gpuPipelineValidationFailures = 0;

    // Programmable pipeline cache (VS+PS+decl+state → registered pipeline id). Bounded like
    // its two siblings: the key spans shader x sampler state x stream layout x target format,
    // so a shader-heavy title otherwise grows it without limit for the life of the device.
    // Eviction drops the CACHE ENTRY only, never the executor's pipeline registration: ids are
    // append-only indices and an already-recorded RenderFrame still names them at submit.
    private progPipelineCache = new LruCache<string, number>({
        maxEntries: PROG_PIPELINE_CACHE_MAX_ENTRIES,
        canEvict: (_key, value) => value !== this._lrPipelineId,
    });
    // Real-bypass alias cache.  The Rust arena key is only a compact hash and deliberately
    // omits several D3D9 pipeline fields; key this map by the hash PLUS the complete TS
    // pipeline fingerprint so a hash collision or an omitted Rust field can never reuse the
    // wrong registered GPURenderPipeline.
    private arenaPipelineCache = new Map<string, number>();
    /** Compact WBUF runs cycle through a small set of non-consecutive render states. The
     * ordinary last-resolve memo cannot see through those intervening setters, while the
     * complete Arena identity already is the collision-safe pipeline fingerprint we need.
     * Keep this cache separate from arenaPipelineCache: WBUF records one aggregate command,
     * so it has no per-draw Rust arena key with which to form arenaPipelineCache's bucket. */
    private compactPipelineIdentityCache = new Map<string, {
        pipelineId: number;
        identity: ArenaPipelineIdentitySnapshot;
    }>();
    // Last-resolve fast path: consecutive draws overwhelmingly share one pipeline identity, so a
    // numeric compare against the previous resolve skips the per-draw template-string alloc + the
    // string-Map lookup (the Map remains the second-level cache for non-consecutive repeats).
    private _lrValid = false;

    /** Drop the last-resolve memo AND the derived key fragments: every caller of this is a
     *  state change that can alter pipeline identity. */
    /** Single funnel for a render-state write: the tracker answers whether the value really
     *  changed, which is exactly when the derived key fragments must be rebuilt. */
    private noteRenderStateWrite(state: number, value: number): boolean {
        const changed = this.stateTracker.setRenderState(state, value);
        if (changed) this.pipelineStateGeneration++;
        return changed;
    }

    private stateKeyGeneration = -1;
    private stateKeyBlend = "";
    private stateKeyAlpha = "";
    private stateKeyDepth = "";
    private stateKeyTarget = "";
    private stateKeyProjected = 0;

    /** The four pipeline-key fragments derived from render/stage state and the current
     *  attachments. Pure functions of `pipelineStateGeneration`, rebuilt once per change
     *  rather than once per draw — each is a fresh string, and a title issues them a
     *  thousand times a frame. */
    private refreshStateKeys(): void {
        if (this.stateKeyGeneration === this.pipelineStateGeneration
            && !(globalThis as { __noD3D9KeyMemo?: boolean }).__noD3D9KeyMemo) return;
        this.stateKeyGeneration = this.pipelineStateGeneration;
        this.stateKeyBlend = computeBlendKey(this.getRS);
        this.stateKeyAlpha = this.alphaTestKey();
        this.stateKeyDepth = `${computeDepthKey(this.getRS)}:df${this.activeDepthTargetFormat()}:r${this.rasterStateKey()}`;
        this.stateKeyTarget = this.activeColorTargetKey();
        this.stateKeyProjected = this.projectedStageKey();
    }

    /** Bumped only by an ATTACHMENT change (render target, depth surface, MSAA config, a
     *  debug toggle). The resolved stage window depends on the attachments — through
     *  isTextureConflictingWithActiveRt — but not on render or stage state, so keying it on
     *  the much busier pipelineStateGeneration made it miss on every render-state write
     *  (~190 a frame against ~1000 draws). */
    private attachmentGeneration = 0;

    private invalidateLastResolve(): void {
        this._lrValid = false;
        this._pmValid = false;
        this.pipelineStateGeneration++;
        this.attachmentGeneration++;
    }

    // ── Programmable-pipeline PROLOGUE memo (see d3d9-pipeline-memo.ts) ───────
    // The inputs to every derived value the last-resolve compare needs. A hit asserts
    // that compare would have succeeded, so the ~25 derived values need not be rebuilt
    // to discover it. Everything here is either an explicit argument, a bound-object
    // handle, or one of the four generations the derived values are already memoised
    // on — no value read here lacks a generation behind it.
    private _pmValid = false;
    private _pmTopo = "";
    private _pmForceCull = false;
    private _pmStrideOverride = -1;
    private _pmSlotMask = 0;
    private _pmPointExp = false;
    private _pmVs = 0; private _pmPs = 0; private _pmDecl = 0; private _pmFvf = 0;
    private _pmStride: number | null = null;
    private _pmStreamHash = 0;
    private _pmGenPipeline = -1;
    private _pmGenSampler = -1;
    private _pmGenBank = -1;
    private _pmGenAttach = -1;
    /** Whether the memoised call had a pixel shader — the one input to arenaBaseEligible
     *  the reuse tail cannot cheaply re-derive without getActivePsShader(). */
    private _pmPsNonNull = false;
    /** Index of the most recent captured draw-state slot THIS frame
     *  (identical-consecutive-state elision); -1 = none. Reset at submitFrame. */
    private lastCaptureIndex = -1;
    private _lrVs = 0; private _lrPs = 0; private _lrDecl = 0; private _lrFvf = 0; private _lrStride: number | null = null;
    private _lrStateBits = 0; private _lrTopo = ""; private _lrForceCull = false;
    private _lrBlend = ""; private _lrAlpha = ""; private _lrDepth = ""; private _lrCube = 0; private _lrComparison = 0; private _lrComparisonKey = ""; private _lrVolume = 0; private _lrVertexVolume = 0; private _lrProj = 0; private _lrHybridStages = 0; private _lrSamplerKey = ""; private _lrPipelineId = -1;
    /** Identity of the vertex input: which slots the layout has and each one's stride. */
    private _lrStreamHash = 0;
    private _lrTarget = "";
    /** Arena-only canonical identity. The reduced last-resolve fields intentionally do not
     * include every shader/target/sampler variant, so an arena draw must never reuse a legacy
     * fast-path result captured for a different full fingerprint. */
    private _lrArenaIdentity: string | undefined;
    private _lrArenaIdentityWords: Uint32Array | undefined;
    /** WBUF pair-runs revisit a handful of programmable pipelines after intervening state
     *  changes, so the consecutive last-resolve memo cannot help them. Pipeline id covers the
     *  shader/layout/attachment/sampler variants; the full D3D state key preserves the extra
     *  canonical identity bits that are intentionally stricter than the GPU pipeline key. */
    private arenaIdentityByPipelineState = new Map<number, Map<number, ArenaPipelineIdentitySnapshot>>();
    /** Handed to recordArenaSpec on the last-resolve fast path; reused because that path
     *  runs once per draw and only ever borrows the two retained fields. */
    private readonly lastResolveIdentityScratch: { key: string; words: Uint32Array } =
        { key: "", words: new Uint32Array(0) };
    private pendingArenaRecord: PendingArenaRecord | null = null;

    /** Texture-bank changes invalidate the cheap arena representability memo. */
    private arenaSamplerBankGeneration = 0;
    /** Bumped by writeSamplerState — the single mutation of the sampler bank — so the
     *  per-draw sampler spec/key memo below can be exact without re-reading the bank. */
    private samplerStateGeneration = 0;
    /** Decoded sampler specs, one per stage, valid for one samplerStateGeneration. The decode
     *  ran per stage PER DRAW at five call sites and showed up as ~4% of the worker; the
     *  specs are never mutated, so a handed-out object stays a valid snapshot after a
     *  state change (the change makes a NEW object rather than editing this one). */
    private samplerSpecCache: Array<SamplerSpec | null> = [];
    private samplerSpecCacheGeneration = -1;
    /**
     * Bumped by every mutation that can change a pipeline-identity key fragment: a render
     * state, a texture-stage state, a debug toggle, and every attachment change that already
     * drops the last-resolve memo. The five string fragments a programmable draw needs
     * (blend / alpha / depth+raster / colour target / projected stages) are pure functions of
     * that state, so they are built once per generation instead of once per draw.
     */
    private pipelineStateGeneration = 0;
    private arenaBankCheckGeneration = -1;
    private arenaBankCheckVs = 0;
    private arenaBankCheckPs = 0;
    private arenaBankCheckResult = false;

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
    private stageSamplers = new Array<GPUSampler | null>(D3D9_TEXTURE_SLOT_COUNT).fill(null);
    private stageSamplersValid = 0;
    private stageSamplerQualityToken = -1;
    private stageSamplerDevice: GPUDevice | null = null;
    private materialData = new Uint8Array(D3DMATERIAL9_SIZE);
    private lights = new Map<number, Uint8Array>();
    private lightEnables = new Map<number, number>();
    private clipPlanes = new Map<number, Float32Array>();

    private stateBlockRecorder = new D3D9StateBlockRecorder();
    private boundTexturePtrs = new Array<number>(D3D9_TEXTURE_SLOT_COUNT).fill(0);
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
        for (let i = 0; i < MAX_VERTEX_STREAMS; i++) {
            this.replaceHeldComRef(this.streams.ptr[i]!, 0);
            this.streams.clear(i);
        }
        for (let i = 0; i < this.boundTexturePtrs.length; i++) {
            this.boundTexturePtrs[i] = this.replaceHeldComRef(this.boundTexturePtrs[i]!, 0);
        }
        for (const entry of this.rtDepthCache.values()) {
            entry.texture.destroy();
        }
        this.rtDepthCache.clear();
        this.clearStandaloneDepthSurfaces();
        // These unbinds bypass the setters, so nothing mirrored them into the guest-side
        // shadows. Re-sentinel instead of writing zeros: a sentinel makes the FIRST set of
        // every slot pass through, which is exactly the post-Reset contract.
        this.resetSetterShadows();
    }

    /** Put every shadowed D3D9 setter back to "never set". Any path that changes the bound
     *  state WITHOUT going through the setters must call this, or the trampoline keeps
     *  answering "already set" for state the device no longer holds. */
    private resetSetterShadows(): void {
        let d = this.shadowSyncDispatcher;
        if (!d) {
            d = (System.getInstance().process?.dispatcher as typeof this.shadowSyncDispatcher) ?? null;
            this.shadowSyncDispatcher = d;
        }
        for (const fn of ['IDirect3DDevice9_SetRenderState', 'IDirect3DDevice9_SetSamplerState',
            'IDirect3DDevice9_SetTexture', 'IDirect3DDevice9_SetVertexShader',
            'IDirect3DDevice9_SetPixelShader']) {
            d?.resetShadow?.('d3d9', fn);
        }
    }

    constructor(backend: WebGPUBackend, d3d9MsaaProbe: D3D9MsaaAdapterProbe | null = getD3D9MsaaCapabilityContract()) {
        this.backend = backend;
        this.d3d9MsaaProbe = d3d9MsaaProbe;

        this.backendExecutor = new D3D9BackendExecutor(backend);
        registerBackendQualitySupport("d3d9", ["anisotropy", "forceTrilinear", "msaa"]);
        this.pipelineCache = new LruCache<string, number>({
            maxEntries: this.pipelineCacheMaxSize,
            canEvict: (key) => key !== this.currentPipelineKey,
        });

        // Register as active renderer
        System.getInstance().services.render.setActive(this);

        registerGpuDeviceObserver("d3d9-device", { onDeviceLost: () => this.onDeviceLost() });
    }

    /** Capability gate used by D3D9 module entry points before creating MSAA surfaces. */
    supportsD3D9MultisampleType(multiSampleType: number): boolean {
        const type = multiSampleType >>> 0;
        if (type === 0) return true;
        const sampleCount = d3d9MsaaSampleCount(type);
        return sampleCount !== null && this.d3d9MsaaProbe?.supportsSampleCount(sampleCount) === true;
    }

    /** Active D3D9 presentation sample count; 1 means NONE. */
    getD3D9MultisampleSampleCount(): number {
        return this.d3d9MsaaSampleCount;
    }

    /** Apply a validated presentation sample type and invalidate sample-count-baked pipelines. */
    configureD3D9MultisampleType(multiSampleType: number): boolean {
        if (!this.supportsD3D9MultisampleType(multiSampleType)) return false;
        const sampleCount = d3d9MsaaSampleCount(multiSampleType) ?? 1;
        if (sampleCount === this.d3d9MsaaSampleCount) return true;
        if (!this.backendExecutor.configureD3D9BackbufferMsaa(sampleCount, this.d3d9MsaaProbe)) {
            return false;
        }
        this.d3d9MsaaSampleCount = sampleCount;
        this.renderTargetSampleTypes.fill(0);
        this.pipelineCache.clear();
        this.currentPipelineKey = null;
        this.currentPipelineId = null;
        this.progPipelineCache.clear();
        this.arenaPipelineCache.clear();
        this.compactPipelineIdentityCache.clear();
        this.arenaIdentityByPipelineState.clear();
        this.invalidateLastResolve();
        // Reset/creation parameters invalidate DEFAULT depth surfaces. The guest must bind a
        // fresh surface after the sample-count change; retaining an old attachment would make
        // the next pass fail WebGPU's sample-count compatibility validation.
        this.clearStandaloneDepthSurfaces();
        return true;
    }

    private ensureD3D9MsaaCache(): D3D9MultisampleTargetCache | null {
        const device = this.backend.getDevice();
        if (!device || !this.d3d9MsaaProbe) return null;
        if (!this.d3d9MsaaCache) this.d3d9MsaaCache = new D3D9MultisampleTargetCache(device, this.d3d9MsaaProbe);
        return this.d3d9MsaaCache;
    }

    private renderTargetMsaaTarget(
        index: number,
        face: number,
        sampleType: number,
        colorFormat: GPUTextureFormat,
        resolveTexture: GPUTexture,
        resolveView: GPUTextureView,
        width: number,
        height: number,
        depthFormat: GPUTextureFormat,
        externalDepth?: { texture: GPUTexture; view: GPUTextureView },
    ): D3D9MultisampleTarget | null {
        const sampleCount = d3d9MsaaSampleCount(sampleType);
        if (!sampleCount) return null;
        const cache = this.ensureD3D9MsaaCache();
        return cache?.acquire({
            key: `rt:${index}:${this.renderTargetIndices[index] ?? -1}:${face}`,
            width,
            height,
            colorFormat,
            colorViewFormats: dxSrgbViewFormats(colorFormat),
            depthFormat,
            sampleCount,
            resolveTexture,
            resolveView,
            depthTexture: externalDepth?.texture,
            depthView: externalDepth?.view,
        }) ?? null;
    }

    /**
     * Device loss. Everything below is either a dead handle or an INDEX into one — the
     * pipeline caches map a state key to a slot in the executor's `pipelines` array, which
     * the executor is emptying in the same fan-out, so they have to be cleared together or a
     * live key would resolve to a slot that no longer exists.
     *
     * MANAGED/SYSTEMMEM resources keep a CPU shadow, so dropping their GPU side and re-raising
     * `dirty` restores them on next use with no guest involvement. DEFAULT resources and render
     * targets lose their contents on D3D9 device loss and are reported instead (see
     * TextureStore.dropGpuResources).
     */
    /** Bumped whenever a GPU-side resource may have been dropped, so the redundant-
     *  SetRenderTarget fast path cannot skip the ensureTexture that would rebuild it. */
    private gpuResourceGeneration = 0;

    /** True when the surface already bound at `index` can be re-bound without re-validating:
     *  the module layer then only owes D3D9's viewport reset. */
    redundantRenderTargetOk(index: number, generationSeen: number): boolean {
        return !this.gpuGone && generationSeen === this.gpuResourceGeneration
            && index < D3D9_MAX_RENDER_TARGETS;
    }

    getGpuResourceGeneration(): number { return this.gpuResourceGeneration; }

    /** D3D9 resets the viewport even when the caller rebinds the target that is already
     *  bound — that, and the diagnostic counter, is all a redundant bind owes. */
    noteRedundantRenderTarget(index: number): void {
        this.rtSetsThisFrame++;
        if (index === 0) {
            const { w, h } = this.getCurrentTargetSize();
            this.viewport = fullTargetViewport(w, h);
        }
    }

    private onDeviceLost(): void {
        this.gpuResourceGeneration++;
        this.gpuQueryManager?.destroy();
        this.gpuQueryManager = null;
        this.backendExecutor.dropDeviceResources();
        this.d3d9MsaaCache = null;
        // Standalone depth surfaces are DEFAULT attachments; discard their lost GPU views and
        // let a post-reset SetDepthStencilSurface lazily recreate them from surface metadata.
        this.standaloneDepthSurfaces.clear();
        this.activeStandaloneDepthSurface = null;
        this.pipelineCache.clear();
        this.currentPipelineKey = null;
        this.currentPipelineId = null;
        this.progPipelineCache.clear();
        this.arenaPipelineCache.clear();
        this.compactPipelineIdentityCache.clear();
        this.arenaIdentityByPipelineState.clear();
        this.cubeFaceRenderViews.clear();
        this.rtDepthCache.clear();
        this.vbVersions.clear();
        this.ibVersions.clear();
        this.fetchAuditShadow.clear();
        this.vbPool = null;
        this.invalidateLastResolve();
        this.pendingArenaRecord = null;
        const tex = this.textures.dropGpuResources();
        const vb = this.vertexBuffers.dropGpuResources();
        const ib = this.indexBuffers.dropGpuResources();
        for (const entry of this.volumeByIndex.values()) {
            entry.texture?.destroy();
            entry.texture = null;
            entry.view = null;
            const resource = volumeTextureResources.get(entry.pointer);
            // DEFAULT volume contents are lost on reset; managed/system-memory volumes retain
            // their guest shadow and can be re-uploaded on first bind.
            entry.dirty = resource?.pool !== 0;
        }
        for (const handle of tex.contentLostHandles) this.clearMipLevelData(handle);
        Logger.warn(LogCategory.D3D9,
            `[GPU-LOST] d3d9 resources invalidated — textures=${tex.dropped} (${tex.contentLost} DEFAULT/render-target contents lost), ` +
            `vertexBuffers=${vb}, indexBuffers=${ib}; managed/system-memory resources restore from CPU shadow on next use`);
    }

    getDrawCount(): number {
        return this.drawCount;
    }

    /** Lazily expose the real WebGPU query-set seam to the D3D9 query module. A device with
     * no live GPU (for example during loss or a pure CPU probe) returns null and query.ts
     * retains its deterministic fallback behaviour. */
    getQueryManager(): D3D9QueryManager | null {
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!device || !queue) return null;
        if (!this.gpuQueryManager) {
            this.gpuQueryManager = new D3D9QueryManager({ device, queue });
        }
        return this.gpuQueryManager;
    }

    recordQueryBegin(queryPtr: number): void { this.commandRecorder.recordBeginOcclusionQuery(queryPtr); }
    recordQueryEnd(queryPtr: number): void { this.commandRecorder.recordEndOcclusionQuery(queryPtr); }
    recordQueryTimestamp(queryPtr: number): void { this.commandRecorder.recordTimestampQuery(queryPtr); }

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
        if (!Number.isInteger(state) || state < 0 || state >= 256) {
            d3d9PerfSkip("setRenderState");
            return D3DERR_INVALIDCALL;
        }
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
        // SRGBWRITEENABLE changes the color attachment view format. Split the
        // command stream before applying it so a pass and its pipelines use one format.
        if (state === D3DRS_SRGBWRITEENABLE
            && this.stateTracker.getRenderState(state) !== value
            && this.hasPendingWork()) {
            this.submitFrame(false);
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setRenderState(state, value);
        if (!this.noteRenderStateWrite(state, value)) {
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
    private shadowSyncDispatcher: {
        writeShadowSlot?: (d: string, f: string, s: number, v: number) => void;
        resetShadow?: (dll: string, fn: string) => void;
    } | null = null;
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

    private samplerSpecForStage(stage: number): SamplerSpec {
        if (this.samplerSpecCacheGeneration !== this.samplerStateGeneration) {
            this.samplerSpecCache.length = 0;
            this.samplerSpecCacheGeneration = this.samplerStateGeneration;
        }
        let spec = (globalThis as { __noD3D9TexMemo?: boolean }).__noD3D9TexMemo
            ? null : this.samplerSpecCache[stage];
        if (!spec) {
            spec = decodeD3d9Sampler(type => this.getSamplerState(stage, type));
            this.samplerSpecCache[stage] = spec;
        }
        return spec;
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
        // SetFVF(0) touches no state (DXVK D3D9DeviceEx::SetFVF returns D3D_OK immediately).
        if (fvf === 0) return 0;
        // SetFVF and SetVertexDeclaration are ONE state slot: D3D9 turns the FVF into a
        // declaration and installs it, so an FVF draw following a declaration must stop using
        // that declaration. Ahead of the tracker's unchanged-FVF dedupe, which must not be able
        // to skip the handover.
        this.clearActiveVertexDecl();
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setFvf(fvf);
        if (!this.stateTracker.setFVF(fvf)) {
            d3d9PerfSkip("setFVF");
            return 0;
        }
        return 0;
    }

    /** Release the active declaration so the FVF path owns the slot again. */
    private clearActiveVertexDecl(): void {
        if (this.activeVertexDecl !== 0) {
            this.activeVertexDecl = 0;
            this.currentPipelineKey = null;
            this.currentPipelineId = null;
            if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setVertexDeclaration(0);
        }
        this.activeVertexDeclComPtr = this.replaceHeldComRef(this.activeVertexDeclComPtr, 0);
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
            this.rememberShaderDiagnostic("vs", handle, compiled);
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
            this.rememberShaderDiagnostic("ps", handle, compiled);
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

    private rememberShaderDiagnostic(stage: ShaderDiagnosticStage, handle: number, compiled: CompiledVs | CompiledPs): void {
        const record: ShaderDiagnosticRecord = {
            handle,
            stage,
            version: `${stage}_${compiled.prog.major}_${compiled.prog.minor}`,
            opcodeHistogram: opcodeHistogram(compiled.prog),
            unsupported: new Set(),
            approximated: new Set(),
            dispatched: 0,
            drawsIssued: 0,
        };
        this.shaderDiagnostics.set(`${stage}:${handle}`, record);
        (stage === "vs" ? this.vsDiagnosticsByHandle : this.psDiagnosticsByHandle).set(handle, record);
        this.shaderDiagnosticEpoch++;
    }

    /** WebGPU shader and pipeline validation is asynchronous; retain its result instead of
     * treating createShaderModule/createRenderPipeline returning as proof of validity. */
    private observeShaderCompilation(module: GPUShaderModule, pair: ShaderPairDiagnosticRecord | null, site: string): void {
        const getCompilationInfo = module.getCompilationInfo;
        if (typeof getCompilationInfo !== "function") return;
        void getCompilationInfo.call(module).then((info) => {
            const errors = info.messages.filter((message) => message.type === "error");
            if (errors.length === 0) return;
            const detail = errors.map((message) => message.message).join("; ");
            this.shaderBuildFailures += errors.length;
            if (pair) {
                pair.build = "failed";
                pair.error = detail;
            }
            recordGpuError("scope", site, detail);
            Logger.error(LogCategory.D3D9, `[D3D9] shader compilation failed at ${site}: ${detail}`);
        }).catch((error) => {
            this.shaderBuildFailures++;
            if (pair) {
                pair.build = "failed";
                pair.error = String(error);
            }
            recordGpuError("scope", site, String(error));
            Logger.error(LogCategory.D3D9, `[D3D9] shader compilation inspection failed at ${site}: ${error}`);
        });
    }

    private observePipelineValidation(
        device: GPUDevice,
        pair: ShaderPairDiagnosticRecord | null,
        site: string,
    ): void {
        void device.popErrorScope().then((error) => {
            if (!error) return;
            this.gpuPipelineValidationFailures++;
            const detail = error.message || String(error);
            if (pair) {
                pair.build = "failed";
                pair.error = detail;
            }
            recordGpuError("scope", site, detail);
            Logger.error(LogCategory.D3D9, `[D3D9] GPU validation failed at ${site}: ${detail}`);
        }).catch((error) => {
            this.gpuPipelineValidationFailures++;
            recordGpuError("throw", site, String(error));
            Logger.error(LogCategory.D3D9, `[D3D9] GPU validation scope failed at ${site}: ${error}`);
        });
    }

    private beginShaderPair(vs: CompiledVs, ps: CompiledPs | null): ShaderPairDiagnosticRecord {
        const handle = this.shaderDiagnosticNextPair++;
        const pair: ShaderPairDiagnosticRecord = {
            handle,
            vsHandle: this.activeVertexShader,
            psHandle: ps ? this.activePixelShader : null,
            vsVersion: `vs_${vs.prog.major}_${vs.prog.minor}`,
            psVersion: ps ? `ps_${ps.prog.major}_${ps.prog.minor}` : null,
            wgsl: null,
            build: "pending",
            error: null,
            pipelineId: null,
            drawsIssued: 0,
            vsDiag: null,
            psDiag: null,
            diagEpoch: -1,
        };
        this.shaderPairDiagnostics.set(handle, pair);
        return pair;
    }

    /** Attribute each stage's census to the shader whose opcodes produced it. The status
     * comes from the emitter's own dispatch (LinkResult.census), so an opcode the emitter
     * never reaches cannot read as supported — which scanning the generated text for markers
     * could not distinguish. */
    private recordShaderCensus(pair: ShaderPairDiagnosticRecord, link: LinkResult): void {
        pair.wgsl = link.wgsl;
        pair.build = "linked";
        const apply = (record: ShaderDiagnosticRecord | undefined, summary: CensusSummary | null): void => {
            if (!record || !summary) return;
            record.dispatched += summary.total;
            for (const op of summary.unsupportedOps) record.unsupported.add(op);
            for (const op of summary.approximatedOps) record.approximated.add(op);
        };
        apply(this.shaderDiagnostics.get(`vs:${pair.vsHandle}`), link.census.vs);
        if (pair.psHandle !== null) {
            apply(this.shaderDiagnostics.get(`ps:${pair.psHandle}`), link.census.ps);
        }
    }

    /** Programmable draws that reached the resolver, and how many of them no shader pair
     *  could be found for. Counted independently of the pair map so an empty `pairs` list can
     *  say WHICH failure it is: no programmable draw happened, or attribution lost it. */
    private progDrawsSeen = 0;
    private progDrawsUnattributed = 0;

    private noteProgrammableDraw(pipelineId: number): number {
        this.progDrawsSeen++;
        const pairHandle = this.shaderPipelinePairs.get(pipelineId);
        if (pairHandle === undefined) { this.progDrawsUnattributed++; return pipelineId; }
        const pair = this.shaderPairDiagnostics.get(pairHandle);
        if (!pair) { this.progDrawsUnattributed++; return pipelineId; }
        // Compilation/pipeline validation is reported asynchronously by WebGPU. Once a
        // prior inspection has marked this pair invalid, refuse subsequent draws instead
        // of replaying a pipeline that the device has already rejected.
        if (pair.build === "failed") return -1;
        pair.drawsIssued++;
        if (!fastDrawAttribution()) {
            const vs = this.shaderDiagnostics.get(`vs:${pair.vsHandle}`);
            if (vs) vs.drawsIssued++;
            if (pair.psHandle !== null) {
                const ps = this.shaderDiagnostics.get(`ps:${pair.psHandle}`);
                if (ps) ps.drawsIssued++;
            }
            return pipelineId;
        }
        if (pair.diagEpoch !== this.shaderDiagnosticEpoch) this.resolvePairDiagnostics(pair);
        if (pair.vsDiag) pair.vsDiag.drawsIssued++;
        if (pair.psDiag) pair.psDiag.drawsIssued++;
        return pipelineId;
    }

    /** Exact accounting twin of noteProgrammableDraw for a fused run whose pipeline was
     *  accepted once before any logical draw was published. No asynchronous shader status
     *  can change during this synchronous increment, so all draws share the same records. */
    private noteProgrammableDraws(pipelineId: number, count: number): void {
        if (count <= 0) return;
        this.progDrawsSeen += count;
        const pairHandle = this.shaderPipelinePairs.get(pipelineId);
        if (pairHandle === undefined) { this.progDrawsUnattributed += count; return; }
        const pair = this.shaderPairDiagnostics.get(pairHandle);
        if (!pair) { this.progDrawsUnattributed += count; return; }
        pair.drawsIssued += count;
        if (!fastDrawAttribution()) {
            const vs = this.shaderDiagnostics.get(`vs:${pair.vsHandle}`);
            if (vs) vs.drawsIssued += count;
            if (pair.psHandle !== null) {
                const ps = this.shaderDiagnostics.get(`ps:${pair.psHandle}`);
                if (ps) ps.drawsIssued += count;
            }
            return;
        }
        if (pair.diagEpoch !== this.shaderDiagnosticEpoch) this.resolvePairDiagnostics(pair);
        if (pair.vsDiag) pair.vsDiag.drawsIssued += count;
        if (pair.psDiag) pair.psDiag.drawsIssued += count;
    }

    /** Validate asynchronous shader status without publishing draw attribution. Speculative
     * producers use this until their Rust/RenderFrame transaction is known to commit. */
    private programmablePipelineResult(pipelineId: number, attributeDraw: boolean): number {
        if (pipelineId < 0) return pipelineId;
        const pairHandle = this.shaderPipelinePairs.get(pipelineId);
        const pair = pairHandle === undefined ? undefined : this.shaderPairDiagnostics.get(pairHandle);
        if (pair?.build === "failed") return -1;
        return attributeDraw ? this.noteProgrammableDraw(pipelineId) : pipelineId;
    }

    /** Re-point a pair at the records its handles name now. Off the draw path: a shader is
     *  created a few hundred times in a session, and a draw happens tens of thousands of times
     *  a second. */
    private resolvePairDiagnostics(pair: ShaderPairDiagnosticRecord): void {
        pair.vsDiag = this.vsDiagnosticsByHandle.get(pair.vsHandle) ?? null;
        pair.psDiag = pair.psHandle !== null
            ? (this.psDiagnosticsByHandle.get(pair.psHandle) ?? null)
            : null;
        pair.diagEpoch = this.shaderDiagnosticEpoch;
    }

    /** Read-only harness seam for the shaderOps command. `complete:false` is intentional:
     * unsupported/approximated lists currently come from emitted WGSL markers. */
    shaderInstrumentationSnapshot(reset = false): Record<string, unknown> {
        if (reset) {
            for (const shader of this.shaderDiagnostics.values()) shader.drawsIssued = 0;
            for (const pair of this.shaderPairDiagnostics.values()) pair.drawsIssued = 0;
            this.progDrawsSeen = 0;
            this.progDrawsUnattributed = 0;
        }
        const shaders = [...this.shaderDiagnostics.values()].map((shader) => ({
            handle: shader.handle,
            stage: shader.stage,
            version: shader.version,
            opcodeHistogram: { ...shader.opcodeHistogram },
            dispatched: shader.dispatched,
            unsupported: [...shader.unsupported].sort(),
            approximated: [...shader.approximated].sort(),
            unsupportedCount: shader.unsupported.size,
            approximatedCount: shader.approximated.size,
            drawsIssued: shader.drawsIssued,
        }));
        const pairs = [...this.shaderPairDiagnostics.values()].map((pair) => ({
            handle: pair.handle,
            vsHandle: pair.vsHandle,
            psHandle: pair.psHandle,
            vsVersion: pair.vsVersion,
            psVersion: pair.psVersion,
            wgslAvailable: pair.wgsl !== null,
            build: pair.build,
            error: pair.error,
            pipelineId: pair.pipelineId,
            drawsIssued: pair.drawsIssued,
        }));
        // The numeric index the fast attribution path reads must name the RECORDS the
        // string-keyed map names. Checked at read time, where it costs nothing: a drift would
        // otherwise show up only as draw counts attributed to a record nobody reports.
        let indexChecked = 0;
        let indexMismatch = 0;
        for (const [key, record] of this.shaderDiagnostics) {
            indexChecked++;
            const index = key.startsWith("vs:") ? this.vsDiagnosticsByHandle : this.psDiagnosticsByHandle;
            if (index.get(record.handle) !== record) indexMismatch++;
        }
        return {
            instrumentationVersion: 2,
            shaderBuildFailures: this.shaderBuildFailures,
            gpuPipelineValidationFailures: this.gpuPipelineValidationFailures,
            census: {
                complete: true,
                source: "emitter-dispatch",
                note: "opcode status is recorded by the emitters themselves (LinkResult.census); a shader with dispatched=0 was never linked, which is not the same as having no unsupported opcodes",
            },
            shaders,
            pairs,
            drawsIssued: pairs.reduce((sum, pair) => sum + pair.drawsIssued, 0),
            attribution: {
                programmableDraws: this.progDrawsSeen,
                unattributed: this.progDrawsUnattributed,
                fastPath: fastDrawAttribution(),
                indexChecked,
                indexMismatch,
                indexVerdict: indexChecked === 0
                    ? "no shader records — the index check did not run"
                    : (indexMismatch === 0 ? "agree" : "DISAGREE"),
            },
        };
    }

    /** Read-only harness seam for the generated module text, including a failed pipeline build. */
    shaderInstrumentationWgsl(handle: number): Record<string, unknown> | null {
        const pair = this.shaderPairDiagnostics.get(handle);
        if (!pair) return null;
        return {
            handle: pair.handle,
            wgsl: pair.wgsl,
            build: pair.build,
            error: pair.error,
            vsHandle: pair.vsHandle,
            psHandle: pair.psHandle,
            vsVersion: pair.vsVersion,
            psVersion: pair.psVersion,
            pipelineId: pair.pipelineId,
        };
    }

    setVertexShader(handle: number, comPtr: number = 0): number {
        d3d9PerfInc("setVertexShader");
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "vertexShader", handle: comPtr });
            // The guest-side shadow already recorded `comPtr` before trapping, but recording a
            // state block does NOT apply — put the authoritative value back or the post-End set
            // of the same shader is skipped in guest code and never reaches the device.
            this.syncSetterShadow('IDirect3DDevice9_SetVertexShader', 0, this.activeVertexShaderComPtr);
            return 0;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setVertexShader(handle);
        if (this.activeVertexShader === handle && this.activeVertexShaderComPtr === comPtr) {
            d3d9PerfSkip("setVertexShader");
            return 0;
        }
        this.activeVertexShader = handle;
        this.activeVertexShaderComPtr = this.replaceHeldComRef(this.activeVertexShaderComPtr, comPtr);
        this.syncSetterShadow('IDirect3DDevice9_SetVertexShader', 0, comPtr);
        this.currentPipelineKey = null; // invalidate pipeline cache
        this.currentPipelineId = null;
        Logger.verbose(LogCategory.D3D9, `[D3D9] SetVertexShader(${handle})`);
        return 0;
    }

    /** WBUF-drain seam: a set that could NOT be applied (an unresolvable COM pointer) must put
     *  the guest-side shadow back to what the device actually holds, or the trampoline keeps
     *  answering "already set" and the guest never retries the bind. */
    resyncVertexShaderShadow(): void {
        this.syncSetterShadow('IDirect3DDevice9_SetVertexShader', 0, this.activeVertexShaderComPtr);
    }

    resyncPixelShaderShadow(): void {
        this.syncSetterShadow('IDirect3DDevice9_SetPixelShader', 0, this.activePixelShaderComPtr);
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
            this.syncSetterShadow('IDirect3DDevice9_SetPixelShader', 0, this.activePixelShaderComPtr);
            return 0;
        }
        if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setPixelShader(handle);
        if (this.activePixelShader === handle && this.activePixelShaderComPtr === comPtr) {
            d3d9PerfSkip("setPixelShader");
            return 0;
        }
        this.activePixelShader = handle;
        this.activePixelShaderComPtr = this.replaceHeldComRef(this.activePixelShaderComPtr, comPtr);
        this.syncSetterShadow('IDirect3DDevice9_SetPixelShader', 0, comPtr);
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

    /** Pack one programmable uniform block as c[] + i[] + b, preserving raw signed I lane bits. */
    private copyProgrammableBankWithKey(
        dstBits: Uint32Array,
        cBits: Uint32Array,
        cLen: number,
        iBits: Uint32Array,
        boolMask: number,
    ): number {
        let h1 = 0x811c9dc5;
        // b is a vec4<u32>; only .x carries the packed mask, but the complete
        // 16-byte member remains part of the fixed uniform layout and snapshot.
        const boolWords = SHADER_BOOLEAN_BANK_BYTES / 4;
        let h2 = (0x9e3779b9 ^ (cLen + SHADER_INTEGER_REGISTER_COUNT * 4 + boolWords)) >>> 0;
        let out = 0;
        const add = (bits: number): void => {
            dstBits[out++] = bits >>> 0;
            h1 = Math.imul(h1 ^ bits, 0x01000193) >>> 0;
            h2 = (Math.imul(h2 ^ bits, 0x85ebca6b) + 0x9e3779b9) >>> 0;
        };
        for (let i = 0; i < cLen; i++) add(cBits[i]!);
        for (let i = 0; i < SHADER_INTEGER_REGISTER_COUNT * 4; i++) add(iBits[i]!);
        add(boolMask);
        for (let i = 1; i < boolWords; i++) add(0);
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
        const swvp = this.softwareVertexProcessing;
        const max = (swvp ? this.swvpVsConstants : this.vsConstants).length;
        const n = vector4fCount * 4;
        if (this.recordingStateBlock) {
            const data = this.readGuestConstantsForRecording(pConstantData, Math.min(n, max - baseIdx), mem);
            if (data) this.recordStateBlock({ op: "vertexShaderConstantF", start: startRegister, data });
            return 0;
        }
        // The GPU draw path always consumes the bounded HW bank, while ProcessVertices
        // consumes the expanded SWVP bank. Both must stay coherent so switching consumers
        // cannot expose stale constants — but the SWVP bank is only ever READ while software
        // vertex processing is on, so mirroring every write into it costs a second copy and a
        // second view on the hottest setter in the API (a title issues ~1900 of these a frame)
        // to serve a consumer that may never run. Mirror eagerly only while SWVP is on, and
        // otherwise mark the bank stale — ensureSwvpBankSynced brings it up to date at the
        // OFF→ON transition and before any SWVP read, which is the same guarantee.
        const changedHw = this.copyShaderConstantsFromGuest(
            this.vsConstantBits, startRegister, pConstantData, vector4fCount, mem,
        );
        let changedSwvp = false;
        if (swvp) {
            changedSwvp = this.copyShaderConstantsFromGuest(
                this.swvpVsConstantBits, startRegister, pConstantData, vector4fCount, mem,
            );
        } else if (changedHw) {
            this.swvpBankStale = true;
        }
        if (!changedHw && !changedSwvp) {
            d3d9PerfSkip("vsConstantUnchanged");
        } else {
            this.vsConstantsVersion++;
        }
        if (d3d9WasmArena.isInitialized()) {
            // Mirror from the just-updated authoritative bank (not the raw guest pointer —
            // avoids re-deriving alignment/byte-order and guarantees identical bits).
            const count = Math.min(n, this.vsConstants.length - baseIdx);
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
        const max = PS_FLOAT_REGISTER_COUNT * 4;
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

    setPixelShaderConstantB(startRegister: number, pConstantData: number, boolCount: number, mem: Uint8Array): number {
        if (startRegister < 0 || boolCount < 0 || startRegister + boolCount > SHADER_BOOLEAN_REGISTER_COUNT ||
            !pConstantData || !isValidAddress(mem, pConstantData, boolCount * 4, "r")) return D3DERR_INVALIDCALL;
        const data = new Int32Array(boolCount);
        for (let i = 0; i < boolCount; i++) {
            const value = Mem.readInt32(pConstantData + i * 4);
            if (value === null) return D3DERR_INVALIDCALL;
            data[i] = value !== 0 ? 1 : 0;
        }
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "pixelShaderConstantB", start: startRegister, data });
            return D3D_OK;
        }
        this.setPixelShaderConstantBFromArray(startRegister, data);
        return D3D_OK;
    }

    /** Replay one recorded BOOL register (state-block Apply). */
    setPixelShaderConstantBFromArray(startRegister: number, data: Int32Array): number {
        if (startRegister < 0 || startRegister + data.length > SHADER_BOOLEAN_REGISTER_COUNT) return D3DERR_INVALIDCALL;
        for (let i = 0; i < data.length; i++) this.storePixelShaderConstantB(startRegister + i, data[i] ? 1 : 0);
        return D3D_OK;
    }

    /** Current values of `count` BOOL registers from `startRegister` (state-block Capture). */
    getPixelShaderConstantsB(startRegister: number, count: number): Int32Array {
        const out = new Int32Array(Math.max(0, count));
        for (let i = 0; i < out.length; i++) {
            const reg = startRegister + i;
            if (reg < 0 || reg >= SHADER_BOOLEAN_REGISTER_COUNT) continue;
            out[i] = (this.psBooleanMask >>> reg) & 1;
        }
        return out;
    }

    /** A b# register is normalized to one bit in the stage's packed uniform mask. */
    private storePixelShaderConstantB(register: number, value: number): void {
        const bit = (1 << register) >>> 0;
        const next = value !== 0 ? (this.psBooleanMask | bit) >>> 0 : (this.psBooleanMask & ~bit) >>> 0;
        if (next !== this.psBooleanMask) {
            this.psBooleanMask = next;
            this.psConstantsVersion++;
        }
    }

    setVertexShaderConstantI(startRegister: number, pConstantData: number, vector4iCount: number, mem: Uint8Array): number {
        const integerLimit = this.softwareVertexProcessing ? 2048 : SHADER_INTEGER_REGISTER_COUNT;
        if (startRegister < 0 || vector4iCount < 0 || startRegister + vector4iCount > integerLimit ||
            !pConstantData || !isValidAddress(mem, pConstantData, vector4iCount * 16, "r")) return D3DERR_INVALIDCALL;
        const data = new Int32Array(vector4iCount * 4);
        for (let i = 0; i < data.length; i++) {
            const value = Mem.readInt32(pConstantData + i * 4);
            if (value === null) return D3DERR_INVALIDCALL;
            data[i] = value;
        }
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "vertexShaderConstantI", start: startRegister, data });
            return D3D_OK;
        }
        return this.setVertexShaderConstantIFromArray(startRegister, data);
    }

    setVertexShaderConstantIFromArray(startRegister: number, data: Int32Array): number {
        const limit = this.softwareVertexProcessing ? 2048 : SHADER_INTEGER_REGISTER_COUNT;
        if (startRegister < 0 || (data.length & 3) !== 0 || startRegister + data.length / 4 > limit) {
            return D3DERR_INVALIDCALL;
        }
        const base = startRegister * 4;
        const target = this.softwareVertexProcessing ? this.swvpVsIntegerConstants : this.vsIntegerConstants;
        let changed = false;
        for (let i = 0; i < data.length; i++) {
            const index = base + i;
            if (index < this.vsIntegerConstants.length && this.vsIntegerConstants[index] !== data[i]) {
                this.vsIntegerConstants[index] = data[i]!;
                changed = true;
            }
            if (index < this.swvpVsIntegerConstants.length && this.swvpVsIntegerConstants[index] !== data[i]) {
                this.swvpVsIntegerConstants[index] = data[i]!;
                changed = true;
            }
        }
        if (changed) this.vsConstantsVersion++;
        return D3D_OK;
    }

    setPixelShaderConstantI(startRegister: number, pConstantData: number, vector4iCount: number, mem: Uint8Array): number {
        if (startRegister < 0 || vector4iCount < 0 || startRegister + vector4iCount > SHADER_INTEGER_REGISTER_COUNT ||
            !pConstantData || !isValidAddress(mem, pConstantData, vector4iCount * 16, "r")) return D3DERR_INVALIDCALL;
        const data = new Int32Array(vector4iCount * 4);
        for (let i = 0; i < data.length; i++) {
            const value = Mem.readInt32(pConstantData + i * 4);
            if (value === null) return D3DERR_INVALIDCALL;
            data[i] = value;
        }
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "pixelShaderConstantI", start: startRegister, data });
            return D3D_OK;
        }
        return this.setPixelShaderConstantIFromArray(startRegister, data);
    }

    setPixelShaderConstantIFromArray(startRegister: number, data: Int32Array): number {
        if (startRegister < 0 || (data.length & 3) !== 0 || startRegister + data.length / 4 > SHADER_INTEGER_REGISTER_COUNT) {
            return D3DERR_INVALIDCALL;
        }
        const base = startRegister * 4;
        let changed = false;
        for (let i = 0; i < data.length; i++) {
            if (this.psIntegerConstants[base + i] !== data[i]) {
                this.psIntegerConstants[base + i] = data[i]!;
                changed = true;
            }
        }
        if (changed) this.psConstantsVersion++;
        return D3D_OK;
    }

    setVertexShaderConstantB(startRegister: number, pConstantData: number, boolCount: number, mem: Uint8Array): number {
        const boolLimit = this.softwareVertexProcessing ? 2048 : SHADER_BOOLEAN_REGISTER_COUNT;
        if (startRegister < 0 || boolCount < 0 || startRegister + boolCount > boolLimit ||
            !pConstantData || !isValidAddress(mem, pConstantData, boolCount * 4, "r")) return D3DERR_INVALIDCALL;
        const data = new Int32Array(boolCount);
        for (let i = 0; i < boolCount; i++) {
            const value = Mem.readInt32(pConstantData + i * 4);
            if (value === null) return D3DERR_INVALIDCALL;
            data[i] = value !== 0 ? 1 : 0;
        }
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "vertexShaderConstantB", start: startRegister, data });
            return D3D_OK;
        }
        return this.setVertexShaderConstantBFromArray(startRegister, data);
    }

    setVertexShaderConstantBFromArray(startRegister: number, data: Int32Array): number {
        const limit = this.softwareVertexProcessing ? 2048 : SHADER_BOOLEAN_REGISTER_COUNT;
        if (startRegister < 0 || startRegister + data.length > limit) return D3DERR_INVALIDCALL;
        let nextMask = this.vsBooleanMask;
        let changed = false;
        for (let i = 0; i < data.length; i++) {
            const registerIndex = startRegister + i;
            const value = data[i] ? 1 : 0;
            if (registerIndex < this.swvpVsBooleanConstants.length
                && this.swvpVsBooleanConstants[registerIndex] !== value) {
                this.swvpVsBooleanConstants[registerIndex] = value;
                changed = true;
            }
            if (registerIndex < SHADER_BOOLEAN_REGISTER_COUNT) {
                const bit = (1 << registerIndex) >>> 0;
                const updated = value !== 0 ? (nextMask | bit) >>> 0 : (nextMask & ~bit) >>> 0;
                if (updated !== nextMask) {
                    nextMask = updated;
                    changed = true;
                }
            }
        }
        if (nextMask !== this.vsBooleanMask) this.vsBooleanMask = nextMask;
        if (changed) this.vsConstantsVersion++;
        return D3D_OK;
    }

    private storeVertexShaderConstantB(register: number, value: number): void {
        const bit = (1 << register) >>> 0;
        const next = value !== 0 ? (this.vsBooleanMask | bit) >>> 0 : (this.vsBooleanMask & ~bit) >>> 0;
        if (next !== this.vsBooleanMask) {
            this.vsBooleanMask = next;
            this.vsConstantsVersion++;
        }
    }

    getVertexShaderConstantsI(startRegister: number, count: number): Int32Array {
        const out = new Int32Array(Math.max(0, count) * 4);
        const base = startRegister * 4;
        const source = this.softwareVertexProcessing ? this.swvpVsIntegerConstants : this.vsIntegerConstants;
        for (let i = 0; i < out.length && base + i < source.length; i++) out[i] = source[base + i]!;
        return out;
    }

    getPixelShaderConstantsI(startRegister: number, count: number): Int32Array {
        const out = new Int32Array(Math.max(0, count) * 4);
        const base = startRegister * 4;
        for (let i = 0; i < out.length && base + i < this.psIntegerConstants.length; i++) out[i] = this.psIntegerConstants[base + i]!;
        return out;
    }

    getVertexShaderConstantsB(startRegister: number, count: number): Int32Array {
        const out = new Int32Array(Math.max(0, count));
        for (let i = 0; i < out.length; i++) {
            const reg = startRegister + i;
            if (this.softwareVertexProcessing) out[i] = this.swvpVsBooleanConstants[reg] ? 1 : 0;
            else if (reg >= 0 && reg < SHADER_BOOLEAN_REGISTER_COUNT) out[i] = (this.vsBooleanMask >>> reg) & 1;
        }
        return out;
    }

    setVertexShaderConstantFFromArray(startRegister: number, data: Float32Array, _mem: Uint8Array): number {
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "vertexShaderConstantF", start: startRegister, data: new Float32Array(data) });
            return 0;
        }
        const changedHw = this.copyShaderConstantsFromArray(this.vsConstants, startRegister, data);
        const changedSwvp = this.copyShaderConstantsFromArray(this.swvpVsConstants, startRegister, data);
        if (changedHw || changedSwvp) {
            this.vsConstantsVersion++;
        }
        if (d3d9WasmArena.isInitialized()) {
            const baseIdx = startRegister * 4;
            const count = Math.min(data.length, this.vsConstants.length - baseIdx);
            if (count > 0) d3d9WasmArena.setVertexShaderConstantF(baseIdx, data.subarray(0, count));
        }
        return 0;
    }

    setVertexShaderConstantFFromWbufRing(
        mem32: Uint32Array, dataPtr: number, arenaAlreadyUpdated = false,
    ): void {
        d3d9PerfInc("setVertexShaderConstantF");
        const w = dataPtr >> 2;
        const startRegister = mem32[w + 1]!;
        const vector4fCount = mem32[w + 2]!;
        const baseIdx = startRegister * 4;
        const count = vector4fCount * 4;
        if (count <= 0 || baseIdx < 0 || baseIdx >= this.swvpVsConstants.length) return;
        const srcIdx = w + 3;
        const swvpCount = Math.min(count, this.swvpVsConstants.length - baseIdx);
        const hwCount = Math.min(count, this.vsConstantBits.length - baseIdx);
        if (this.recordingStateBlock) {
            const data = new Float32Array(swvpCount);
            new Uint32Array(data.buffer).set(mem32.subarray(srcIdx, srcIdx + swvpCount));
            this.recordStateBlock({ op: "vertexShaderConstantF", start: startRegister, data });
            return;
        }
        const changedHw = hwCount > 0
            && this.copyShaderConstantBitsFromMem32(this.vsConstantBits, baseIdx, mem32, srcIdx, hwCount);
        const changedSwvp = this.copyShaderConstantBitsFromMem32(
            this.swvpVsConstantBits, baseIdx, mem32, srcIdx, swvpCount,
        );
        if (changedHw || changedSwvp) this.vsConstantsVersion++;
        else d3d9PerfSkip("vsConstantUnchanged");
        if (!arenaAlreadyUpdated && d3d9WasmArena.isInitialized() && hwCount > 0) {
            d3d9WasmArena.setVertexShaderConstantF(baseIdx, this.vsConstants.subarray(baseIdx, baseIdx + hwCount));
        }
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
        // State-block float constants must not spill into the packed b# bank.
        const floatBank = this.psConstants.subarray(0, PS_FLOAT_REGISTER_COUNT * 4);
        if (this.copyShaderConstantsFromArray(floatBank, startRegister, data)) {
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
        const unsupported = elements.find(element => !isD3D9DeclTypeGpuRepresentable(element.type));
        if (unsupported) {
            Logger.error(LogCategory.D3D9,
                `[D3D9] vertex declaration type ${unsupported.type} has no exact WebGPU vertex format; refusing declaration`);
            return { hr: D3DERR_NOTAVAILABLE, handle: 0 };
        }
        const handle = this.vsDeclNextHandle++;
        this.vsDeclRegistry.set(handle, elements);
        this.ptMemoDecl = -1;   // a handle just gained (or changed) elements — re-answer the layout question
        return { hr: 0, handle };
    }

    setVertexDeclaration(internalHandle: number, comPtr: number = 0): number {
        d3d9PerfInc("setVertexDeclaration");
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "vertexDeclaration", handle: comPtr });
            return 0;
        }
        // The other direction of the single slot setFVF documents: a real declaration replaces
        // whatever SetFVF installed, and GetFVF then reads 0 off it.
        if (internalHandle !== 0) {
            this.stateTracker.setFVF(0);
            if (d3d9WasmArena.isInitialized()) d3d9WasmArena.setFvf(0);
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

    /** Raw elements of the declaration currently describing source vertices, if any. */
    getActiveVertexDeclarationElements(): RawVertexElement[] | null {
        return this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) ?? null : null;
    }

    /**
     * Execute the supported CPU fixed-function ProcessVertices path.
     *
     * D3D9's ProcessVertices can execute either the fixed-function transform or
     * the active programmable VS when software vertex processing is selected.
     */
    processVertices(
        srcStartIndex: number,
        destIndex: number,
        vertexCount: number,
        destBufferPtr: number,
        destElements: RawVertexElement[],
        flags: number,
    ): number {
        if (vertexCount === 0) return D3D_OK;
        const dstIndex = this.vertexBuffers.getIndex(destBufferPtr >>> 0);
        if (dstIndex === null) return D3DERR_INVALIDCALL;
        const dstData = this.vertexBuffers.getData(dstIndex);
        if (!dstData) return D3DERR_INVALIDCALL;

        const streams: Array<SwvpStream | null> = new Array(D3D9Device.MAX_STREAMS).fill(null);
        const sourceDecl = this.getActiveVertexDeclarationElements();
        const sourceDeclIndices = new Set<number>();
        if (sourceDecl) for (const e of sourceDecl) sourceDeclIndices.add(e.stream);
        // A source and destination may legally be the same VB. Snapshot only those source
        // buffers, otherwise a write to an earlier output vertex can alter a later input.
        for (let stream = 0; stream < D3D9Device.MAX_STREAMS; stream++) {
            const binding = this.streams.bufferIndex[stream]!;
            if (binding < 0) continue;
            const data = this.vertexBuffers.getData(binding);
            if (!data) continue;
            const sourceData = binding === dstIndex && sourceDeclIndices.has(stream) ? data.slice() : data;
            streams[stream] = {
                data: sourceData,
                offset: this.streams.offsetBytes[stream]!,
                stride: this.streams.strideBytes[stream]!,
            };
        }

        const swvpFiles = this.getSwvpVertexConstants();
        const result = processSoftwareVertices({
            srcStartIndex, destIndex, vertexCount,
            sourceFvf: this.stateTracker.getFVF(),
            sourceElements: sourceDecl,
            streams,
            destElements,
            destData: dstData,
            mvp: this.stateTracker.getMVP(),
            viewport: this.viewport,
            flags,
            shader: this.activeVertexShader !== 0 ? this.getActiveVsShader()?.prog ?? null : null,
            constantsF: swvpFiles.f,
            constantsI: swvpFiles.i,
            constantsB: swvpFiles.b,
            fixedFunction: this.swvpFixedFunctionState(),
        });
        if (result !== D3D_OK) return result;

        this.vertexBuffers.setDirty(dstIndex, true);
        // Keep the CPU-visible Lock allocation coherent with the store shadow. Draws use the
        // shadow directly, but a caller that locks the destination immediately after this call
        // must observe the generated bytes too.
        const guestPtr = this.vertexBuffers.getGuestPtr(dstIndex);
        if (guestPtr >= 0) {
            const end = Math.min(dstData.byteLength, this.vertexBuffers.getSize(dstIndex));
            const memory = this.memory;
            if (guestPtr + end <= memory.byteLength) memory.set(dstData.subarray(0, end), guestPtr);
        }
        return D3D_OK;
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
            const streams = slotsInMask(declStreamMask(elements));
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
            const maxIndex = (e: RawVertexElement): number =>
                e.usage === DECLUSAGE_TEXCOORD_FFP ? FFP_MAX_STAGES - 1 : 1;
            const drops = elements
                .filter(e => FFP_CONSUMED_USAGES.has(e.usage) && e.usageIndex > (indexed(e) ? maxIndex(e) : 0))
                .map(describe);
            // COLOR1 reaches the shader only when the declaration carries a second colour;
            // report it separately because it is a valid conditional input, not a dropped
            // semantic. TEXCOORDn (n=0..7) is always addressable by the FFP stage generator.
            const conditional = elements
                .filter(e => indexed(e) && e.usageIndex === 1)
                .map(describe);
            // Streams the declaration reads that nothing is bound to — they draw against a
            // zero-filled stand-in (resolveDrawStreams), which reads as black/untextured.
            const unbound = streams.filter(s => !this.streams.isBound(s));
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

    /**
     * Per-shader census: version, how many float constants the generated WGSL array spans,
     * and whether the program indexes constants RELATIVELY (c[a0+n]).
     *
     * `relative` is the one property no capture and no screenshot can show: a relative read
     * past the array end is CLAMPED, not faulted, so a matrix-palette index the array does not
     * cover silently resolves to one fixed matrix and those vertices erupt from the mesh —
     * a picture that reads as a skinning or declaration bug. `constants` is the bound that
     * must cover the register file the app writes, and this is where the two are comparable.
     */
    shaderCensus(): Record<string, unknown> {
        const vs = [...this.vsShaderRegistry].map(([handle, s]) => ({
            handle,
            version: `vs_${s.prog.major}_${s.prog.minor}`,
            constants: s.analysis.constantCount,
            maxStaticConst: s.prog.maxConst,
            relative: s.prog.usesRelativeConst,
            inputs: s.analysis.inputDcls.map(d => ({ reg: d.reg, usage: d.usage, usageIndex: d.usageIndex })),
        }));
        const ps = [...this.psShaderRegistry].map(([handle, s]) => ({
            handle,
            version: `ps_${s.prog.major}_${s.prog.minor}`,
            constants: s.analysis.constantCount,
            maxStaticConst: s.prog.maxConst,
            relative: s.prog.usesRelativeConst,
        }));
        return { registerFile: VS_FLOAT_REGISTER_COUNT, vs, ps };
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
        vs: Array<{
            handle: number; version: string; instrs: number; active: boolean;
            writesColor: boolean[]; writesTexcoord: number[]; disasm: string[];
        }>;
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
            writesColor: [...c.analysis.writesColor],
            writesTexcoord: [...c.analysis.writesTexcoord].sort((a, b) => a - b),
            // Keep the numeric opcode in the diagnostic. It makes the census useful even
            // when an optimized build strips/const-folds an enum-name lookup.
            disasm: c.prog.instructions.map(ins => `${opName(ins.opcode)}(${ins.opcode})`),
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

    /**
     * True when the ACTIVE declaration hands the pipeline positions that are already in
     * screen space: D3DDECLUSAGE_POSITIONT, or FVF XYZRHW when no declaration is bound.
     *
     * POSITION declared as FLOAT4 does NOT count. It is an ordinary declaration — apps use the
     * w lane for w-tricks and pre-scaled positions — and wined3d sets position_transformed only
     * for POSITIONT. Counting it here would take the vertex stage away from a bound shader and
     * feed model-space coordinates to a screen-space stage, with nothing logged.
     */
    private ptMemoDecl = -1;
    private ptMemoFvf = -1;
    private ptMemoValue = false;
    private activeDeclIsPreTransformed(): boolean {
        // Per-DRAW question on the pipeline fast path, but it only changes when the layout does —
        // memoize on (declaration, FVF) so the common case is two integer compares.
        const fvf = this.stateTracker.getFVF();
        if (this.ptMemoDecl === this.activeVertexDecl && this.ptMemoFvf === fvf) return this.ptMemoValue;
        const decl = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
        this.ptMemoValue = (!decl || decl.length === 0)
            ? (fvf & D3DFVF_POSITION_MASK) === D3DFVF_XYZRHW
            : decl.some(e => e.usage === DECLUSAGE_POSITIONT_FFP);
        this.ptMemoDecl = this.activeVertexDecl;
        this.ptMemoFvf = fvf;
        return this.ptMemoValue;
    }

    /**
     * True when a programmable vertex shader is bound (the new render path).
     *
     * A PRE-TRANSFORMED declaration overrides a bound vertex shader: the vertices are already
     * in screen space, so there is nothing for a vertex shader to transform and the runtime
     * runs the fixed function. Wine encodes the same rule (`use_vs`, wined3d_private.h:
     * shader && (!decl || !decl->position_transformed)); the pixel shader is deliberately NOT
     * disabled with it (`use_ps` has no such clause). Without this a UI/post-process quad
     * whose engine left a shader bound feeds screen coordinates into a shader expecting model
     * space: the geometry lands off-screen or skewed, which is a menu that never appears and a
     * full-screen composite that ghosts — with nothing logged, because every draw "succeeded".
     */
    private isProgrammable(): boolean {
        if (this.activeVertexShader === 0 || !this.vsShaderRegistry.has(this.activeVertexShader)) return false;
        if (!this.activeDeclIsPreTransformed()) return true;
        // The PIXEL shader survives a pre-transformed declaration (`use_ps` carries no such
        // clause), so a draw that has one stays on this path and gets the fixed-function vertex
        // stage from the linker instead. Only a draw whose pixel side is fixed-function too can
        // go to the FFP path wholesale.
        return this.getActivePsShader() !== null;
    }

    setStreamSource(streamNumber: number, vbPtr: number, offset: number, stride: number): number {
        d3d9PerfInc("setStreamSource");
        if (streamNumber < 0 || streamNumber >= D3D9Device.MAX_STREAMS) return D3DERR_INVALIDCALL;
        const index = vbPtr === 0 ? null : this.vertexBuffers.getIndex(vbPtr);
        // Unknown pointer: clear the stream with the error (see setTexture) — a stale
        // vertex buffer would otherwise feed the next draw.
        const unknown = vbPtr !== 0 && index === null;
        if (this.recordingStateBlock) {
            if (unknown) return D3DERR_INVALIDCALL;
            this.recordStateBlock({
                op: "streamSource", stream: streamNumber,
                vbPtr, offset: offset >>> 0, stride: stride >>> 0,
            });
            return D3D_OK;
        }
        // ONE writer, every slot: GetStreamSource, the pipeline's per-slot strides and the
        // draw's bindings all read this table, so slot 0 cannot drift from slots 1+.
        const held = this.replaceHeldComRef(this.streams.ptr[streamNumber]!, unknown ? 0 : vbPtr);
        const changed = this.streams.set(
            streamNumber, held, unknown || index === null ? -1 : index,
            unknown ? 0 : offset >>> 0, unknown ? 0 : stride >>> 0,
        );
        if (!changed) d3d9PerfSkip("setStreamSource");
        else this.stateTracker.markStreamsDirty();
        // Every slot's stride shapes the per-slot vertex layout, so a change to any of them
        // invalidates the cached pipeline.
        if (changed) {
            this.currentPipelineKey = null;
            this.currentPipelineId = null;
        }
        if (streamNumber === 0 && d3d9WasmArena.isInitialized()) {
            const bound = this.streams.bufferIndex[0]!;
            d3d9WasmArena.setStreamSource(
                bound < 0 ? 0 : bound, this.streams.offsetBytes[0]!, this.streams.strideBytes[0]!);
        }
        return unknown ? D3DERR_INVALIDCALL : D3D_OK;
    }

    /**
     * SetStreamSourceFreq — the per-stream divider that makes a draw instanced.
     *
     * Advertising vs_3_0 IS the D3D9 statement that hardware instancing works (an engine reads
     * nothing else before committing to it), so refusing this call is a false capability answer
     * one layer down: CryEngine sets INDEXEDDATA|count on stream 0 and INSTANCEDATA|1 on the
     * per-instance stream, never checks the HRESULT, and draws. We store the divider so
     * GetStreamSourceFreq is honest and a reset to 1 succeeds; divisor-one instancing is
     * lowered to WebGPU's native instance step mode, while unsupported divisors are refused.
     */
    setStreamSourceFreq(streamNumber: number, setting: number): number {
        // A/B: bring back the E_NOTIMPL this replaced, so the failure it causes can be
        // reproduced on demand instead of argued about.
        if ((globalThis as { __noStreamSourceFreq?: boolean }).__noStreamSourceFreq) return 0x80004001;
        if (streamNumber < 0 || streamNumber >= D3D9Device.MAX_STREAMS) return D3DERR_INVALIDCALL;
        const value = setting >>> 0;
        const indexed = (value & D3DSTREAMSOURCE_INDEXEDDATA) !== 0;
        const instance = (value & D3DSTREAMSOURCE_INSTANCEDATA) !== 0;
        // The two flags are mutually exclusive, and the divider itself is never 0.
        if ((indexed && instance) || ((value & ~(D3DSTREAMSOURCE_INDEXEDDATA | D3DSTREAMSOURCE_INSTANCEDATA)) === 0)) {
            return D3DERR_INVALIDCALL;
        }
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "streamSourceFreq", stream: streamNumber, setting: value });
            return D3D_OK;
        }
        if (this.streams.freq[streamNumber] !== value) {
            this.streams.freq[streamNumber] = value;
            // The divider decides each slot's step mode, which is part of the vertex layout.
            this.currentPipelineKey = null;
            this.currentPipelineId = null;
        }
        return D3D_OK;
    }

    getStreamSourceFreq(streamNumber: number): number | null {
        if (streamNumber < 0 || streamNumber >= D3D9Device.MAX_STREAMS) return null;
        return this.streams.freq[streamNumber]!;
    }

    /** Vertex buffer COM ptr / offset / stride last bound to a stream (all zero = unbound).
     *  null for a stream index beyond the MaxStreams we advertise. */
    getStreamBinding(streamNumber: number): { ptr: number; offset: number; stride: number } | null {
        if (streamNumber >= D3D9Device.MAX_STREAMS) return null;
        return {
            ptr: this.streams.ptr[streamNumber]!,
            offset: this.streams.offsetBytes[streamNumber]!,
            stride: this.streams.strideBytes[streamNumber]!,
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

    createVertexBuffer(vbPtr: number, size: number, fvf: number, pool = 0): number {
        const process = System.getInstance().process;
        if (!process) return 0;
        try {
            // +16: tail canary (see BUF_CANARY) — kept outside the size the store/game sees.
            const guestPtr = process.memory.alloc(size + D3D9Device.BUF_CANARY_BYTES, "HEAP");
            const index = this.vertexBuffers.create(vbPtr, size, fvf, guestPtr, pool);
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
        // COPY_SRC: a slot a draw outruns is padded by COPYING its real bytes into a longer
        // buffer with a zeroed tail (executor robustness padding), which needs to read this one.
        const usage = (isVb ? GPUBufferUsage.VERTEX : GPUBufferUsage.INDEX)
            | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
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
        // A ring built now owns a buffer whose contents nothing has established — the store's
        // own buffer may predate the shadow, a fresh one holds zeros. Its first upload is whole.
        let ringIsNew = false;
        if (!ring) {
            const storeBuf = store.getGpuBuffer(index);
            const base = storeBuf && storeBuf.size >= gpuSize ? storeBuf : device.createBuffer({ size: gpuSize, usage });
            ring = [base];
            (isVb ? this.vbVersions : this.ibVersions).set(index, ring);
            slots.set(index, 0);
            ringIsNew = true;
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
            // Partial uploads are only sound into a slot that already holds this buffer's
            // previous bytes. A renamed slot and a just-built ring do not, so they take the
            // whole shadow; slot 0 across frames does, because syncBufferFrame re-dirties in
            // full any buffer whose frame ended on a higher slot.
            const whole = renamed || ringIsNew;
            const range = whole
                ? { offset: 0, length: gpuSize }
                : alignUploadRange(store.getDirtyStart(index), store.getDirtyEnd(index), gpuSize);
            if (range.length > 0) {
                this.commandRecorder.queueUpload(
                    target, data.subarray(range.offset, Math.min(range.offset + range.length, data.length)),
                    range.offset);
            }
            // The audit asks what the GPU will FETCH, which after a partial upload is the
            // shadow all the same: every slot converges on it (see `whole` above).
            if (this.fetchAuditFramesLeft > 0) this.fetchAuditShadow.set(target, data.slice());
            store.setDirty(index, false);
            uploaded.add(index);
            if (this.frameSnapshot.frameCounters) {
                this.frameSnapshot.frameCounters.uploads++;
                this.frameSnapshot.frameCounters.vertexBytes += range.length;
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

    createIndexBuffer(ibPtr: number, size: number, format: number, pool = 0): number {
        const process = System.getInstance().process;
        if (!process) return 0;
        try {
            // +16: tail canary, same scheme as createVertexBuffer.
            const guestPtr = process.memory.alloc(size + D3D9Device.BUF_CANARY_BYTES, "HEAP");
            const index = this.indexBuffers.create(ibPtr, size, format, guestPtr, pool);
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
        if (this.recordingStateBlock) {
            if (unknown) return D3DERR_INVALIDCALL;
            this.recordStateBlock({ op: "indices", ibPtr });
            return D3D_OK;
        }
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

    private isVolumeIndex(index: number | null): index is number {
        return index !== null && index < 0 && this.volumeByIndex.has(index);
    }

    private volumeIndexForPointer(texturePtr: number): number | null {
        return this.volumeByPointer.get(texturePtr >>> 0) ?? null;
    }

    private volumeEntry(index: number): { pointer: number; texture: GPUTexture | null; view: GPUTextureView | null; dirty: boolean } | null {
        return this.volumeByIndex.get(index) ?? null;
    }

    /** Register the API-owned CPU volume resource in the common texture-stage namespace. */
    registerVolumeTexture(texturePtr: number): boolean {
        const ptr = texturePtr >>> 0;
        if (!volumeTextureResources.has(ptr)) return false;
        if (this.volumeByPointer.has(ptr)) return true;
        const index = this.nextVolumeIndex--;
        this.volumeByPointer.set(ptr, index);
        this.volumeByIndex.set(index, { pointer: ptr, texture: null, view: null, dirty: true });
        // isVolumeIndex now answers differently for this index, which is what the bound-bank
        // memos are keyed on. The release path bumps for the same reason.
        this.arenaSamplerBankGeneration++;
        return true;
    }

    releaseVolumeTexture(texturePtr: number): void {
        const ptr = texturePtr >>> 0;
        const index = this.volumeByPointer.get(ptr);
        if (index === undefined) return;
        this.arenaSamplerBankGeneration++;
        const entry = this.volumeByIndex.get(index);
        entry?.texture?.destroy();
        this.volumeByIndex.delete(index);
        this.volumeByPointer.delete(ptr);
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            if (this.stateTracker.getTexture(stage) === index) this.stateTracker.setTexture(stage, null);
        }
        for (let n = 0; n < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            const stage = D3D9_VERTEX_TEXTURE_SAMPLER_BASE + n;
            if (this.stateTracker.getTexture(stage) === index) this.stateTracker.setTexture(stage, null);
        }
    }

    markVolumeTextureDirty(texturePtr: number): void {
        const index = this.volumeByPointer.get(texturePtr >>> 0);
        if (index === undefined) return;
        const entry = this.volumeByIndex.get(index);
        if (entry) entry.dirty = true;
    }

    private ensureVolumeTexture(index: number): void {
        const entry = this.volumeEntry(index);
        if (!entry) return;
        const resource = volumeTextureResources.get(entry.pointer);
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!resource || !device || !queue) return;
        if (!entry.texture) {
            entry.texture = device.createTexture({
                size: { width: resource.width, height: resource.height, depthOrArrayLayers: resource.depth },
                format: "rgba8unorm",
                mipLevelCount: resource.levels,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
            });
            entry.view = entry.texture.createView({ dimension: "3d" });
            // A freshly registered resource starts dirty, while a DEFAULT volume that
            // survived device loss is deliberately clean: D3D9 discards its contents on
            // reset and the guest must repopulate it. Do not resurrect the stale CPU shadow
            // merely because the lazy GPU object is being recreated.
            entry.dirty = entry.dirty || resource.pool !== 0;
        }
        if (!entry.dirty || !entry.texture) return;
        const memory = this.memory;
        for (let level = 0; level < resource.levels; level++) {
            const mip = getVolumeLevel(entry.pointer, level);
            if (!mip || mip.ptr + mip.bytes > memory.byteLength) continue;
            const rgba = new Uint8Array(mip.width * mip.height * 4);
            for (let z = 0; z < mip.depth; z++) {
                const source = memory.subarray(mip.ptr + z * mip.slicePitch, mip.ptr + z * mip.slicePitch + mip.slicePitch);
                decodeD3DTextureToRgba8(source, 0, mip.width, mip.height, resource.format, {
                    pitch: mip.pitch,
                    out: rgba,
                });
                // Queue texture uploads follow the copy-layout alignment rule: rows beyond
                // the first require bytesPerRow to be a multiple of 256. Keep the guest/CPU
                // decoder tightly packed, then pad only the transient upload staging view.
                const rowBytes = mip.width * 4;
                const bytesPerRow = (rowBytes + 255) & ~255;
                const upload = bytesPerRow === rowBytes
                    ? rgba
                    : (() => {
                        const padded = new Uint8Array(bytesPerRow * mip.height);
                        for (let row = 0; row < mip.height; row++) {
                            padded.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes), row * bytesPerRow);
                        }
                        return padded;
                    })();
                queue.writeTexture(
                    { texture: entry.texture, mipLevel: level, origin: { x: 0, y: 0, z } },
                    upload as any,
                    { bytesPerRow, rowsPerImage: mip.height },
                    { width: mip.width, height: mip.height, depthOrArrayLayers: 1 },
                );
            }
        }
        entry.dirty = false;
    }

    private resolveVolumeTextureView(index: number): GPUTextureView | null {
        this.ensureVolumeTexture(index);
        return this.volumeEntry(index)?.view ?? null;
    }

    createTexture(texPtr: number, width: number, height: number, levels: number, format: number, usage: number = 0, pool = 0): number {
        const process = System.getInstance().process;
        if (!process) return 0;
        const bytes = getD3DTextureLayout(format, width, height).bytes;
        try {
            const guestPtr = process.memory.alloc(bytes, "HEAP");
            const index = this.textures.create(texPtr, width, height, levels, format, guestPtr, pool);
            // Standard D3D depth textures are both render attachments and shadow-map
            // resources. Keeping them as a native depth format is required by WebGPU's
            // texture_depth_2d / sampler_comparison validation contract.
            if (isDxDepthStencilFormat(format, 9)) {
                const dev = this.backend.getDevice();
                if (dev) this.ensureDepthTexture(index, dev);
            }
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
                        viewFormats: dxSrgbViewFormats(rtFormat),
                        mipLevelCount: 1,
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
                               GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                    });
                    this.textures.setGpuTexture(index, tex, tex.createView());
                    this.gpuResourceGeneration++; // a new GPU object invalidates the redundant-RT fast path
                    this.textures.markRenderTarget(index);
                    this.renderTargetGpuFormats.set(index, rtFormat);
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
    createCubeTexture(cubePtr: number, edge: number, levels: number, format: number, usage: number = 0, pool = 0): number {
        const process = System.getInstance().process;
        if (!process) return 0;
        const e = Math.max(1, edge >>> 0);
        const levelCount = Math.max(1, levels >>> 0);
        try {
            // Scratch HEAP backing keeps TextureStore.create's bookkeeping uniform with 2D
            // textures; cube faces are locked into per-face scratch on demand (lockCubeFace).
            const guestPtr = process.memory.alloc(getD3DTextureLayout(format, e, e).bytes, "HEAP");
            const index = this.textures.create(cubePtr, e, e, levelCount, format, guestPtr, pool);
            this.textures.markCube(index);
            // Arena texture ids reserve zero for "unbound"; the resource store starts at
            // index zero, so mirror a one-based id in the compact Rust state.
            if (d3d9WasmArena.isInitialized()) d3d9WasmArena.markTextureCube(index + 1, true);

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
                    viewFormats: dxSrgbViewFormats(fmt),
                    mipLevelCount: isRT ? 1 : levelCount,
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
                           GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                });
                const cubeView = tex.createView({ dimension: "cube", arrayLayerCount: 6 });
                this.textures.setGpuTexture(index, tex, cubeView);
                this.gpuResourceGeneration++; // a new GPU object invalidates the redundant-RT fast path
                if (isRT) this.renderTargetGpuFormats.set(index, fmt);
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
    lockCubeFace(
        cubePtr: number,
        face: number,
        level: number,
        options: { discard?: boolean; readOnly?: boolean; noDirtyUpdate?: boolean } = {},
    ): { ptr: number; pitch: number } | null {
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
        if (!options.discard && prior && prior.length === bytes) this.memory.set(prior, guestPtr);

        this.cubeFaceLocks.set(key, {
            guestPtr,
            pitch,
            readOnly: options.readOnly === true,
            noDirtyUpdate: options.noDirtyUpdate === true,
        });
        return { ptr: guestPtr, pitch };
    }

    /** UnlockRect a cube face: persist the written pixels and mark the cube for re-upload. */
    unlockCubeFace(cubePtr: number, face: number, level: number, memory: Uint8Array): boolean {
        const index = this.textures.getIndex(cubePtr);
        if (index === null) return false;
        const key = `${cubePtr}:${face}:${level}`;
        const lock = this.cubeFaceLocks.get(key);
        if (!lock) return false;
        if (lock.readOnly) {
            System.getInstance().process?.memory.free(lock.guestPtr);
            this.cubeFaceLocks.delete(key);
            return true;
        }
        const edge = Math.max(1, this.textures.getHeight(index) >>> level);
        const format = this.textures.getFormat(index);
        const rows = getD3DTextureLayout(format, edge, edge).rows;
        const bytes = lock.pitch * rows;
        const saved = new Uint8Array(bytes);
        saved.set(memory.subarray(lock.guestPtr, lock.guestPtr + bytes));
        this.cubeFaceData.set(key, saved);
        System.getInstance().process?.memory.free(lock.guestPtr);
        this.cubeFaceLocks.delete(key);
        if (!lock.noDirtyUpdate) this.textures.setDirty(index, true);
        this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
        return true;
    }

    /**
     * Return the CPU shadow for a cube subresource.  Cube faces do not live in
     * TextureStore's level-0 array (the array is only the legacy COM backing
     * allocation), so copy/readback paths must use this accessor instead of
     * pretending face zero is the whole cube.
     */
    getCubeFacePixels(cubePtr: number, face: number, level: number): {
        data: Uint8Array;
        pitch: number;
        width: number;
        height: number;
    } | null {
        const index = this.textures.getIndex(cubePtr);
        if (index === null || !this.textures.isCubeMap(index) || face < 0 || face >= 6 || level < 0 ||
            level >= this.textures.getLevels(index)) return null;
        const width = Math.max(1, this.textures.getWidth(index) >>> level);
        const height = Math.max(1, this.textures.getHeight(index) >>> level);
        const layout = getD3DTextureLayout(this.textures.getFormat(index), width, height);
        const key = `${cubePtr}:${face}:${level}`;
        const prior = this.cubeFaceData.get(key);
        if (prior && prior.length >= layout.bytes) {
            return { data: prior, pitch: layout.pitch, width, height };
        }
        // An untouched cube face is a valid zero-initialised subresource.  Return
        // an owned buffer so callers can safely compose a copy into it.
        return { data: new Uint8Array(layout.bytes), pitch: layout.pitch, width, height };
    }

    /** Store one cube subresource and make the normal upload path publish it. */
    setCubeFacePixels(cubePtr: number, face: number, level: number, src: Uint8Array, srcPitch: number): boolean {
        const index = this.textures.getIndex(cubePtr);
        if (index === null || !this.textures.isCubeMap(index) || face < 0 || face >= 6 || level < 0 ||
            level >= this.textures.getLevels(index)) return false;
        const width = Math.max(1, this.textures.getWidth(index) >>> level);
        const height = Math.max(1, this.textures.getHeight(index) >>> level);
        const layout = getD3DTextureLayout(this.textures.getFormat(index), width, height);
        if (srcPitch < layout.pitch || src.length < srcPitch * layout.rows) return false;
        const out = new Uint8Array(layout.bytes);
        if (srcPitch === layout.pitch) out.set(src.subarray(0, layout.bytes));
        else for (let row = 0; row < layout.rows; row++) {
            out.set(src.subarray(row * srcPitch, row * srcPitch + layout.pitch), row * layout.pitch);
        }
        this.cubeFaceData.set(`${cubePtr}:${face}:${level}`, out);
        this.textures.setDirty(index, true);
        this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
        return true;
    }

    /**
     * Copy one level-0 GPU image into a CPU (`data`) store, converted to the destination's D3D
     * format layout. The one downloader behind both GetRenderTargetData and the read-lock of a
     * render target, so those two cannot disagree about channel order.
     *
     * Channel order comes from the GPU texture's OWN format, not from an assumption: a render
     * target is created in the swap chain's format (typically bgra8unorm) while a sampled
     * texture is rgba8unorm, and reading one as the other is right bytes in wrong lanes — a
     * colour that is exactly wrong rather than obviously broken.
     */
    private async downloadGpuTextureIntoData(
        srcIdx: number,
        dstIdx: number,
        srcLevel = 0,
        srcFace = -1,
    ): Promise<boolean> {
        const gpuTex = this.textures.getGpuTexture(srcIdx);
        const device = this.backend.getDevice();
        const queue = this.backend.getQueue();
        if (!gpuTex || !device || !queue) return false;

        if (srcLevel < 0 || srcLevel >= this.textures.getLevels(srcIdx) ||
            (srcFace >= 0 && (!this.textures.isCubeMap(srcIdx) || srcFace >= 6))) return false;
        const width = Math.min(
            Math.max(1, this.textures.getWidth(srcIdx) >>> srcLevel),
            this.textures.getWidth(dstIdx),
        );
        const height = Math.min(
            Math.max(1, this.textures.getHeight(srcIdx) >>> srcLevel),
            this.textures.getHeight(dstIdx),
        );
        if (width <= 0 || height <= 0) return false;

        // 21/22 = [A|X]R8G8B8; the packed 16-bit render-target formats use
        // their native D3D9 layouts on the CPU destination as well.
        const dstFormat = this.textures.getFormat(dstIdx);
        const dstIs32 = dstFormat === 21 || dstFormat === 22;
        const dstIs565 = dstFormat === 23;
        const dstIs1555 = dstFormat === 24 || dstFormat === 25;
        const dstIs4444 = dstFormat === 26 || dstFormat === 30;
        if (!dstIs32 && !dstIs565 && !dstIs1555 && !dstIs4444) {
            Logger.warn(LogCategory.D3D9,
                `texture readback: no conversion for D3D format ${dstFormat} — refusing rather ` +
                `than leaving the guest to read pixels nobody wrote`);
            return false;
        }
        // Which mapped byte holds red. bgra8unorm stores B,G,R,A; rgba8unorm stores R,G,B,A.
        const bgra = gpuTex.format.startsWith("bgra");
        const rOff = bgra ? 2 : 0, bOff = bgra ? 0 : 2;

        // Flush pending recorded draws so the readback sees this frame's rendering
        // (no-op when the recorder is empty).
        this.submitFrame(false);

        const padded = Math.ceil(width * 4 / 256) * 256;
        const readback = device.createBuffer({
            size: padded * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                {
                    texture: gpuTex,
                    mipLevel: srcLevel,
                    origin: { x: 0, y: 0, z: srcFace >= 0 ? srcFace : 0 },
                },
                { buffer: readback, bytesPerRow: padded },
                { width, height, depthOrArrayLayers: 1 },
            );
            queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(readback.getMappedRange());

            const dstData = this.textures.getData(dstIdx);
            if (!dstData) return false;
            const dstPitch = this.textures.getPitch(dstIdx);
            if (dstIs32) {
                // D3D 32-bit [A|X]RGB is B,G,R,A little-endian.
                for (let y = 0; y < height; y++) {
                    const srcRow = y * padded;
                    const dstRow = y * dstPitch;
                    for (let x = 0; x < width; x++) {
                        const s = srcRow + x * 4;
                        const d = dstRow + x * 4;
                        dstData[d] = mapped[s + bOff];
                        dstData[d + 1] = mapped[s + 1];
                        dstData[d + 2] = mapped[s + rOff];
                        dstData[d + 3] = mapped[s + 3];
                    }
                }
            } else {
                // → packed 16-bit D3D9 layouts, little-endian.
                for (let y = 0; y < height; y++) {
                    const srcRow = y * padded;
                    const dstRow = y * dstPitch;
                    for (let x = 0; x < width; x++) {
                        const s = srcRow + x * 4;
                        const r = mapped[s + rOff]!, g = mapped[s + 1]!, b = mapped[s + bOff]!, a = mapped[s + 3]!;
                        const packed = dstIs565
                            ? ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
                            : dstIs1555
                                ? ((dstFormat === 25 ? (a >> 7) : 0) << 15) |
                                  ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
                                : ((dstFormat === 26 ? (a >> 4) : 0) << 12) |
                                  ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
                        const d = dstRow + x * 2;
                        dstData[d] = packed & 0xff;
                        dstData[d + 1] = (packed >> 8) & 0xff;
                    }
                }
            }
            readback.unmap();
            // The CPU copy moved, so the guest buffer no longer mirrors it and the next Lock
            // republishes. NOT setDirty: these pixels came FROM the GPU and must not be
            // uploaded straight back to it.
            this.textures.noteDataWritten(dstIdx);
            d3d9ReadbackCounters.downloads++;
            d3d9ReadbackCounters.downloadedPixels += width * height;
            return true;
        } finally {
            readback.destroy();
        }
    }

    /** GetRenderTargetData: read the src texture's GPU pixels back into the dst texture's
     *  CPU store. Resolves 0 (D3D_OK) or D3DERR_INVALIDCALL. */
    async readTextureIntoGuestTexture(
        srcTexPtr: number,
        dstTexPtr: number,
        srcLevel = 0,
        srcFace = -1,
    ): Promise<number> {
        const D3DERR_INVALIDCALL = 0x8876086c;
        const srcIdx = this.textures.getIndex(srcTexPtr);
        const dstIdx = this.textures.getIndex(dstTexPtr);
        if (srcIdx === null || dstIdx === null) return D3DERR_INVALIDCALL;
        d3d9ReadbackCounters.getRenderTargetData++;
        return (await this.downloadGpuTextureIntoData(srcIdx, dstIdx, srcLevel, srcFace))
            ? 0
            : D3DERR_INVALIDCALL;
    }

    /**
     * GetRenderTargetData whose SOURCE is the implicit back buffer.
     *
     * The swap-chain image is not in the texture table — it is the presenter's own surface —
     * so the texture path above cannot reach it and every readback of the back buffer was
     * refused.
     *
     * Reads the LIVE back buffer, not the last presented frame. A guest calls this to get the
     * frame it has just drawn and not yet presented, so the presented snapshot the screenshot
     * routes use is one frame stale here — which stays invisible while consecutive frames are
     * identical and is wrong the instant one differs.
     */
    async readBackbufferIntoGuestTexture(dstTexPtr: number): Promise<number> {
        const D3DERR_INVALIDCALL = 0x8876086c;
        const dstIdx = this.textures.getIndex(dstTexPtr);
        if (dstIdx === null) return D3DERR_INVALIDCALL;

        // The destination is a SYSTEMMEM staging surface the guest reads with LockRect, so
        // the CPU layout it expects is D3D9's, not WebGPU's.
        const dstFormat = this.textures.getFormat(dstIdx);
        if (dstFormat !== 21 && dstFormat !== 22) { // [A|X]8R8G8B8
            Logger.warn(LogCategory.D3D9,
                `backbuffer readback: no conversion for D3D format ${dstFormat} — refusing rather `
                + "than leaving the guest to read pixels nobody wrote");
            return D3DERR_INVALIDCALL;
        }

        this.submitFrame(false);
        let shot: { rgba: Uint8Array; width: number; height: number };
        try {
            shot = await this.backendExecutor.readPresentedRgba({ live: true });
        } catch (e) {
            // "Nothing has been presented yet" is a real answer, not a crash: a guest that
            // reads the back buffer before its first Present gets INVALIDCALL and can retry.
            Logger.warn(LogCategory.D3D9, `backbuffer readback unavailable: ${e}`);
            return D3DERR_INVALIDCALL;
        }

        const dstData = this.textures.getData(dstIdx);
        if (!dstData) return D3DERR_INVALIDCALL;
        const dstPitch = this.textures.getPitch(dstIdx);
        const width = Math.min(shot.width, this.textures.getWidth(dstIdx));
        const height = Math.min(shot.height, this.textures.getHeight(dstIdx));
        if (width <= 0 || height <= 0) return D3DERR_INVALIDCALL;

        const opaque = dstFormat === 22; // X8R8G8B8 carries no alpha; D3D9 reads it back as 0xff
        for (let y = 0; y < height; y++) {
            const srcRow = y * shot.width * 4;
            const dstRow = y * dstPitch;
            for (let x = 0; x < width; x++) {
                const s = srcRow + x * 4;
                const d = dstRow + x * 4;
                // readPresentedRgba is tightly packed R,G,B,A; D3D 32-bit [A|X]RGB is a
                // little-endian 0xAARRGGBB word, i.e. B,G,R,A in memory.
                dstData[d] = shot.rgba[s + 2]!;
                dstData[d + 1] = shot.rgba[s + 1]!;
                dstData[d + 2] = shot.rgba[s]!;
                dstData[d + 3] = opaque ? 0xff : shot.rgba[s + 3]!;
            }
        }
        // These pixels came FROM the GPU, so the guest copy no longer mirrors it and the next
        // Lock republishes — but they must NOT be uploaded straight back (see the sibling path).
        this.textures.noteDataWritten(dstIdx);
        d3d9ReadbackCounters.getRenderTargetData++;
        d3d9ReadbackCounters.downloadedPixels += width * height;
        return 0;
    }

    /**
     * The GPU→CPU round trip a Lock of this level needs, or null when it needs none.
     *
     * DXVK reads a renderable image back on EVERY Map because the GPU is the only place its
     * current contents exist (d3d9_device.cpp:5036-5041: `needsReadback = NeedsReadback() ||
     * renderable`, then `&= GetImage() != nullptr || !DISCARD`). Everything else is served from
     * the CPU copy we already hold. Returning null rather than a resolved promise is
     * load-bearing: it keeps the ordinary upload lock a SYNCHRONOUS thunk, so the path every
     * texture upload takes pays nothing for this.
     */
    textureReadbackForLock(texPtr: number, level: number, discard: boolean): Promise<boolean> | null {
        if ((globalThis as { __noD3D9LockReadback?: boolean }).__noD3D9LockReadback === true) return null;
        // Only level 0 is GPU-backed here; deeper mips live in the side buffer.
        if (level !== 0 || discard) return null;
        const index = this.textures.getIndex(texPtr);
        if (index === null) return null;
        if (!this.textures.isRenderTarget(index) || !this.textures.getGpuTexture(index)) return null;
        d3d9ReadbackCounters.lockReadbacks++;
        return this.downloadGpuTextureIntoData(index, index);
    }

    /** Whether this texture's pixels are authored by the GPU — the `renderable` term of
     *  DXVK's readback rule, and what makes a lock's storage genuinely split. */
    isRenderTargetTexture(texPtr: number): boolean {
        const index = this.textures.getIndex(texPtr);
        return index !== null && this.textures.isRenderTarget(index);
    }

    /**
     * Explicit AddDirtyRect notification.  Managed clients may keep writing
     * through a LockRect pointer after UnlockRect and rely on AddDirtyRect to
     * make the next draw upload the CPU shadow; route that notification through
     * the same dirty bit used by ordinary unlocks.
     */
    markTextureDirty(texPtr: number): void {
        const index = this.textures.getIndex(texPtr);
        if (index !== null) this.textures.setDirty(index, true);
        this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
    }

    /** Level-0 texture lock whose staging bytes contain `addr` (see TextureStore). */
    findLockedTextureByPointer(addr: number): { pitch: number; width: number; height: number } | null {
        return this.textures.findLockedByPointer(addr);
    }

    /**
     * `discard` is a surviving D3DLOCK_DISCARD: the app has promised it will overwrite the
     * whole resource, so the current contents need not be produced in the buffer we hand back.
     * Absent it, the level's CPU copy is PUBLISHED into the guest buffer — without that the two
     * halves of our split storage never meet and the pointer addresses bytes nobody wrote.
     */
    lockTexture(texPtr: number, level: number, discard = false): { ptr: number; pitch: number } | null {
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
            const publish = !discard
                && (globalThis as { __noD3D9LockReadback?: boolean }).__noD3D9LockReadback !== true;
            const held = this.textures.lock(index, this.memory, { publish });
            if (held?.published) d3d9ReadbackCounters.publishes++;
            return held;
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
            this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
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

    /**
     * Unlock a texture level.  The boolean form is retained for D3DX and older callers;
     * the object form also carries D3DLOCK_NO_DIRTY_UPDATE, which copies guest bytes into
     * the CPU shadow without scheduling a GPU upload.
     */
    unlockTexture(
        texPtr: number,
        level: number,
        memory: Uint8Array,
        options: boolean | { readOnly?: boolean; noDirtyUpdate?: boolean } = false,
    ): number {
        const readOnly = typeof options === "boolean" ? options : options.readOnly === true;
        const noDirtyUpdate = typeof options === "boolean" ? false : options.noDirtyUpdate === true;
        const index = this.textures.getIndex(texPtr);
        if (index === null) return 0;

        if (level !== 0) {
            const key = `${texPtr}:${level}`;
            const lock = this.mipLevelLocks.get(key);
            if (lock) {
                if (readOnly) {
                    System.getInstance().process?.memory.free(lock.guestPtr);
                    this.mipLevelLocks.delete(key);
                    return 0;
                }
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
                if (!noDirtyUpdate) this.textures.setDirty(index, true);
                this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
            }
            return 0;
        }

        this.textures.unlock(index, memory, { readOnly, noDirtyUpdate });
        // A published write-back is the observable half of "the app draws its own video"
        // (see noteD3D9TextureUpload). read-only unlocks publish nothing and are not one.
        if (!readOnly) noteD3D9TextureUpload();
        return 0;
    }

    setTexture(stage: number, texPtr: number): number {
        d3d9PerfInc("setTexture");
        const slot = d3d9TextureStageSlot(stage);
        if (slot < 0) return D3DERR_INVALIDCALL;
        const index = texPtr === 0
            ? null
            : (this.textures.getIndex(texPtr) ?? this.volumeIndexForPointer(texPtr));
        // A pointer this store does not know names a texture that no longer exists (or
        // never was ours). Report the failure, but UNBIND the stage: leaving the previous
        // texture live would sample a stale image into every later draw.
        const unknown = texPtr !== 0 && index === null;
        if (this.recordingStateBlock) {
            if (unknown) return D3DERR_INVALIDCALL;
            this.recordStateBlock({ op: "texture", stage, texPtr });
            if (slot < 16) this.syncSetterShadow('IDirect3DDevice9_SetTexture', slot, this.boundTexturePtrs[slot]!);
            return D3D_OK;
        }
        // Arena representability includes high sampler banks and their bound resources. Keep
        // the draw-time probe memo cheap while invalidating it on the one state mutation that
        // can make an otherwise identical pipeline leave the eight-stage arena ABI.
        //
        // Only on a REAL change: a title re-binds the same texture constantly (NFS Underground
        // issues ~3400 SetTexture a frame and three quarters of them are redundant), and
        // bumping the generation unconditionally invalidated every memo keyed on it — the
        // resolved stage window included — once per call, so none of them could ever hit.
        const nextTexPtr = (unknown ? 0 : texPtr) >>> 0;
        if (this.boundTexturePtrs[slot] !== nextTexPtr) {
            this.arenaSamplerBankGeneration++;
            this.boundTexturePtrs[slot] = this.replaceHeldComRef(this.boundTexturePtrs[slot]!, nextTexPtr);
        }
        // The shadow must hold what the device ENDED UP with, not what the guest asked for —
        // an unknown pointer unbinds the stage. And it must be written on EVERY real change,
        // not just that case: a state-block Apply reaches this setter without going through
        // the trampoline, so the shadow would otherwise keep the pre-Apply texture and skip
        // the guest's next bind of it.
        if (slot < 16) this.syncSetterShadow('IDirect3DDevice9_SetTexture', slot, nextTexPtr);
        if (index === null) {
            if (stage < D3D9_ARENA_FRAGMENT_STAGE_COUNT && d3d9WasmArena.isInitialized()) d3d9WasmArena.setTexture(stage, 0);
            if (!this.stateTracker.setTexture(stage, null)) {
                d3d9PerfSkip("setTexture");
            }
            return unknown ? D3DERR_INVALIDCALL : D3D_OK;
        }
        // `index` is the SAME internal numeric id used everywhere else in this store (not
        // the raw guest COM pointer) — exactly what the arena's textureId expects.
        const validIndex = index;
        if (validIndex === null) return D3DERR_INVALIDCALL;
        if (validIndex >= 0 && stage < D3D9_ARENA_FRAGMENT_STAGE_COUNT && d3d9WasmArena.isInitialized()) {
            // Zero is the arena ABI's unbound sentinel. Store resource index + 1 so the
            // first TextureStore allocation (index 0) is not silently treated as absent.
            d3d9WasmArena.setTexture(stage, validIndex + 1);
        }
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
        if (!Number.isInteger(state) || matrix.length < 16 ||
            !Array.from(matrix.subarray(0, 16)).every(Number.isFinite)) {
            d3d9PerfSkip("setTransform");
            return D3DERR_INVALIDCALL;
        }
        // The tracker returns `false` both for an invalid selector and for an
        // unchanged matrix.  Validate the selector first so the former remains
        // an observable D3DERR_INVALIDCALL rather than a successful no-op.
        if (!this.getTransform(state)) {
            d3d9PerfSkip("setTransform");
            return D3DERR_INVALIDCALL;
        }
        if (this.recordingStateBlock) {
            // D3DTS_TEXTURE0..7 belong in a state block for the same reason the other three do:
            // the FFP texture transform is captured/applied state, and a block that restores the
            // stage's TEXTURETRANSFORMFLAGS but not its matrix restores half a transform.
            if ((state >= D3DTS_WORLD && state < D3DTS_WORLD + 8) || state === D3DTS_VIEW || state === D3DTS_PROJECTION
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

    multiplyTransform(state: number, matrix: Float32Array): number {
        d3d9PerfInc("setTransform");
        if (this.recordingStateBlock) {
            const current = this.getTransform(state);
            if (!current || matrix.length < 16) return D3DERR_INVALIDCALL;
            // State blocks journal the resulting value. This is equivalent to replaying the
            // relative operation against the state captured at BeginStateBlock and avoids
            // making the block depend on a later caller-side matrix lifetime.
            const result = new Float32Array(16);
            for (let row = 0; row < 4; row++) {
                for (let col = 0; col < 4; col++) {
                    let v = 0;
                    for (let k = 0; k < 4; k++) v += current[row * 4 + k]! * matrix[k * 4 + col]!;
                    result[row * 4 + col] = v;
                }
            }
            this.recordStateBlock({ op: "transform", state, matrix: result });
            return 0;
        }
        if (!this.stateTracker.multiplyTransform(state, matrix)) return D3DERR_INVALIDCALL;
        return 0;
    }

    getTransform(state: number): Float32Array | null {
        if (state === D3DTS_WORLD) return this.stateTracker.getWorldMatrix();
        if (state > D3DTS_WORLD && state < D3DTS_WORLD + 8) return this.stateTracker.getWorldMatrixPalette(state - D3DTS_WORLD);
        if (state === D3DTS_VIEW) return this.stateTracker.getViewMatrix();
        if (state === D3DTS_PROJECTION) return this.stateTracker.getProjectionMatrix();
        return this.stateTracker.getTextureMatrix(state);
    }

    setSoftwareVertexProcessing(enable: boolean): number {
        this.softwareVertexProcessing = !!enable;
        if (this.softwareVertexProcessing) this.ensureSwvpBankSynced();
        return 0;
    }

    /** True while HW-bank writes have been made that the SWVP mirror has not seen. Only the
     *  bounded HW prefix can diverge: registers above it are writable only under SWVP, where
     *  the mirror is eager. */
    private swvpBankStale = false;

    private ensureSwvpBankSynced(): void {
        if (!this.swvpBankStale) return;
        this.swvpBankStale = false;
        const mirror = this.swvpVsConstantBits;
        mirror.set(this.vsConstantBits.subarray(0, Math.min(this.vsConstantBits.length, mirror.length)));
    }

    getSoftwareVertexProcessing(): boolean { return this.softwareVertexProcessing; }

    getSwvpVertexConstants(): { f: Float32Array; i: Int32Array; b: Uint8Array } {
        this.ensureSwvpBankSynced();
        if (this.softwareVertexProcessing) {
            return { f: this.swvpVsConstants, i: this.swvpVsIntegerConstants, b: this.swvpVsBooleanConstants };
        }
        const bools = new Uint8Array(16);
        for (let n = 0; n < bools.length; n++) bools[n] = (this.vsBooleanMask >>> n) & 1;
        return { f: this.vsConstants, i: this.vsIntegerConstants, b: bools };
    }

    setNPatchMode(segments: number): number {
        if (!Number.isFinite(segments) || segments < 0) return D3DERR_INVALIDCALL;
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "npatchMode", segments });
            return D3D_OK;
        }
        this.npatchMode = segments;
        return 0;
    }

    getNPatchMode(): number { return this.npatchMode; }

    setDialogBoxMode(enable: boolean): number {
        this.dialogBoxMode = !!enable;
        return 0;
    }

    getDialogBoxMode(): boolean { return this.dialogBoxMode; }

    /** Validate the currently selected render state without building a draw
     * pipeline. This is the device-side truth used by ValidateDevice, so an
     * unsupported sampler/address mode or a lost WebGPU device cannot be
     * reported as a successful one-pass configuration. */
    validateDevice(): { hr: number; passes: number } {
        // One pass and D3D_OK unless the device is lost — the answer DXVK and the native
        // runtime give (d3d9_device.cpp: D3D9DeviceEx::ValidateDevice). This is a
        // TECHNIQUE probe, not a diagnostic: a title asks it once per material while
        // building its shader table and permanently drops every technique that answers
        // NOTAVAILABLE, so refusing on transient state costs the whole material class
        // (NFS Underground stopped drawing every car body) with no error anywhere.
        // Draw-time refusals stay where they can name the draw they refused.
        return { hr: this.gpuGone ? D3DERR_DEVICELOST : D3D_OK, passes: 1 };
    }

    private makeStageStateKey(stage: number, type: number): number {
        return (((stage & 0xffff) << 16) | (type & 0xffff)) >>> 0;
    }

    setTextureStageState(stage: number, type: number, value: number): number {
        d3d9PerfInc("setTextureStageState");
        if (!Number.isInteger(stage) || stage < 0 || stage >= D3D9_FFP_STAGE_COUNT) return D3DERR_INVALIDCALL;
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
        this.pipelineStateGeneration++;
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
        if (!Number.isInteger(stage) || stage < 0 || stage >= D3D9_FFP_STAGE_COUNT) return 0;
        const key = this.makeStageStateKey(stage, type);
        return this.textureStageStates.has(key)
            ? this.textureStageStates.get(key)!
            : d3d9TextureStageStateDefault(stage, type);
    }

    setSamplerState(sampler: number, type: number, value: number): number {
        d3d9PerfInc("setSamplerState");
        if (!isD3D9TextureStage(sampler)) return D3DERR_INVALIDCALL;
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
        if (sampler < D3D9_ARENA_FRAGMENT_STAGE_COUNT && d3d9WasmArena.isInitialized()) {
            d3d9WasmArena.setSamplerState(sampler, type, value);
        }
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
        this.samplerStateGeneration++;
        const slot = d3d9TextureStageSlot(sampler);
        if (slot >= 0) this.stageSamplersValid &= ~(1 << slot);
    }

    /** `.get() ?? 0` would answer 0 for an untouched D3DSAMP_MAXANISOTROPY (real default 1) and
     *  every other unset sampler state the same way decodeD3d9Sampler's rendering fallback
     *  already gets right — GetSamplerState/state-block capture must agree with what a game
     *  that never called SetSamplerState is actually running with. Only for a VALID sampler
     *  index, though — the D3D default doesn't apply to a stage that was never a sampler at
     *  all (the 16..256 gap between pixel and vertex-texture stages, matching setSamplerState's
     *  own isD3D9TextureStage guard), and a lookup miss there must stay 0, not a real default.
     */
    getSamplerState(sampler: number, type: number): number {
        const key = this.makeStageStateKey(sampler, type);
        if (this.samplerStates.has(key)) return this.samplerStates.get(key)!;
        return isD3D9TextureStage(sampler) ? d3d9SamplerStateDefault(type) : 0;
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
        // D3D9 light INDICES are a sparse DWORD space; MaxActiveLights caps how many may be
        // ENABLED at once, which is enforced where the bank is built. An engine that gives
        // each scene light its own slot and enables a subset is doing the documented thing.
        if (!Number.isInteger(index) || index < 0) {
            return D3DERR_INVALIDCALL;
        }
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
        if (!Number.isInteger(index) || index < 0) return null;
        return this.lights.get(index >>> 0) ?? null;
    }

    lightEnable(index: number, enable: number): number {
        if (!Number.isInteger(index) || index < 0) return D3DERR_INVALIDCALL;
        const value = enable ? 1 : 0;
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "lightEnable", index: index >>> 0, enable: value });
            return 0;
        }
        this.lightEnables.set(index >>> 0, value);
        return 0;
    }

    getLightEnable(index: number): number {
        if (!Number.isInteger(index) || index < 0) return 0;
        return this.lightEnables.get(index >>> 0) ?? 0;
    }

    setClipPlane(index: number, plane: Float32Array): number {
        if (!Number.isInteger(index) || index < 0 || index >= 6 || plane.length < 4) return 0x8876086c;
        if (![plane[0], plane[1], plane[2], plane[3]].every(Number.isFinite)) return 0x8876086c;
        const copy = new Float32Array(4);
        copy.set(plane.subarray(0, 4));
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "clipPlane", index: index >>> 0, plane: copy });
            return 0;
        }
        this.clipPlanes.set(index >>> 0, copy);
        // The plane equations ride the per-draw constant snapshot, so a write invalidates the
        // capture memo just like a render state does.
        this.pipelineStateGeneration++;
        return 0;
    }

    getClipPlane(index: number): Float32Array | null {
        if (!Number.isInteger(index) || index < 0 || index >= 6) return null;
        return this.clipPlanes.get(index >>> 0) ?? null;
    }

    // ── FFP lighting state gather ─────────────────────────────────────────
    // Reused scratch for the per-frame FFP uniform block (zero steady-state alloc).
    private ffpUniformBlock = new Float32Array(FFP_UNIFORM_FLOATS);
    // Reused scratch: the 6 raw user clip-plane equations packed as 6 × vec4 (index N at N*4).
    private ffpClipPlanesScratch = new Float32Array(6 * 4);
    // Reused scratch: inverse-transpose of worldView's 3×3, widened to 4×4 (see buildNormalMatrix).
    private ffpNormalMatrix = new Float32Array(16);
    // Reused world-matrix palette for D3DRS_VERTEXBLEND / indexed blending.
    private ffpBlendMatrices = new Float32Array(8 * 16);
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
    // The rest of the per-draw gather, pooled on the same rule: buildFfpUniformBlock runs per
    // draw, so every object literal it used to write out was ~500 short-lived allocations a
    // frame feeding the GC. packFfpUniforms reads the params synchronously into a Float32Array
    // and keeps nothing, which is what makes one reused record correct here.
    private readonly materialView = new DataView(
        this.materialData.buffer, this.materialData.byteOffset, this.materialData.byteLength);
    private ffpMaterial: FfpMaterial = {
        diffuse: newFfpColor(), ambient: newFfpColor(),
        specular: newFfpColor(), emissive: newFfpColor(), power: 0,
    };
    private ffpGlobalAmbient = newFfpColor();
    private ffpTFactor = newFfpColor();
    private ffpFogColor = newFfpColor();
    private ffpVertexColors = { hasColor: false, hasSpecular: false, hasNormal: false };
    private ffpParams: FfpUniformParams | null = null;

    /** Parse the stored D3DMATERIAL9 bytes into float colours + power.
     *  Returns the REUSED record (this runs per draw) — callers must read it, not keep it. */
    private parseMaterial(): FfpMaterial {
        const dv = this.materialView;
        const m = this.ffpMaterial;
        readFfpColor(dv, 0, m.diffuse);
        readFfpColor(dv, 16, m.ambient);
        readFfpColor(dv, 32, m.specular);
        readFfpColor(dv, 48, m.emissive);
        m.power = dv.getFloat32(64, true);
        return m;
    }

    /** Overwrite `out` with one stored D3DLIGHT9 record. */
    private parseLightInto(data: Uint8Array, out: FfpLightInput): void {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        out.type = dv.getUint32(0, true);
        readFfpColor(dv, 4, out.diffuse);
        readFfpColor(dv, 20, out.specular);
        readFfpColor(dv, 36, out.ambient);
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
     * usageIndex, and the caller's slot mask. Without the mask a colour living in a slot the
     * pipeline does not declare would resolve to COLOR1 here while the shader has no colour
     * attribute for it, and the material colour would silently drop out.
     */
    private resolveFfpVertexColors(
        slotMask: number = this.activeSlotMask(),
    ): { hasColor: boolean; hasSpecular: boolean; hasNormal: boolean } {
        // The REUSED record — this runs per draw, so neither the result nor a per-usage
        // predicate closure may be allocated. Callers destructure it; none keep it.
        const out = this.ffpVertexColors;
        const decl = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
        if (decl && decl.length > 0) {
            out.hasColor = out.hasSpecular = out.hasNormal = false;
            for (let i = 0; i < decl.length; i++) {
                const e = decl[i]!;
                if (((slotMask >>> e.stream) & 1) === 0) continue;
                if (e.usage === DECLUSAGE_COLOR_FFP && e.usageIndex === 0) out.hasColor = true;
                else if (e.usage === DECLUSAGE_COLOR_FFP && e.usageIndex === 1) out.hasSpecular = true;
                else if (e.usage === DECLUSAGE_NORMAL_FFP && e.usageIndex === 0) out.hasNormal = true;
            }
            return out;
        }
        const fvf = this.stateTracker.getFVF();
        out.hasColor = (fvf & D3DFVF_DIFFUSE) !== 0;
        out.hasSpecular = (fvf & D3DFVF_SPECULAR) !== 0;
        out.hasNormal = (fvf & D3DFVF_NORMAL) !== 0;
        return out;
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
        // getTextureStageState already applies d3d9TextureStageStateDefault for an unset slot —
        // this is the single source of truth for D3D9 TSS defaults; see its own comment for why
        // the no-texture substitution below is layered ON TOP rather than folded into it.
        const ts = (s: number, type: number): number => this.getTextureStageState(s, type);
        // With no texture bound, a D3DTA_TEXTURE selector resolves to D3DTA_DIFFUSE (MSDN
        // D3DTSS_COLORARG1: the default argument when no texture is set); modifiers kept.
        const tsArg = (s: number, noTex: boolean, type: number): number => {
            const v = ts(s, type);
            return noTex && (v & 0xf) === 2 ? (v & ~0xf) >>> 0 : v;
        };
        for (let s = 0; s < Math.max(1, stageCount); s++) {
            const noTex = this.stateTracker.getTexture(s) === null;
            // Stage 0 defaults to MODULATE/SELECTARG1; every stage above it defaults to
            // DISABLE, and collapses to DISABLE outright once its texture goes away —
            // sampling the fallback white would MODULATE the base texture by a blank stage.
            const first = s === 0;
            const st = this.ffpStagePool[s] ??= D3D9Device.emptyStage();
            st.colorOp = first ? ts(s, D3DTSS_COLOROP) : (noTex ? D3DTOP_DISABLE : ts(s, D3DTSS_COLOROP));
            st.colorArg1 = tsArg(s, noTex, D3DTSS_COLORARG1);
            st.colorArg2 = tsArg(s, noTex, D3DTSS_COLORARG2);
            st.alphaOp = ts(s, D3DTSS_ALPHAOP);
            st.alphaArg1 = tsArg(s, noTex, D3DTSS_ALPHAARG1);
            st.alphaArg2 = tsArg(s, noTex, D3DTSS_ALPHAARG2);
            // ARG0 is the third operand of MULTIPLYADD/LERP; every other op ignores it.
            st.colorArg0 = tsArg(s, noTex, D3DTSS_COLORARG0);
            st.alphaArg0 = tsArg(s, noTex, D3DTSS_ALPHAARG0);
            st.resultArg = ts(s, D3DTSS_RESULTARG); // default D3DTA_CURRENT
            st.texCoordIndex = ts(s, D3DTSS_TEXCOORDINDEX);
            st.texTransformFlags = ts(s, D3DTSS_TEXTURETRANSFORMFLAGS);
            // DXVK seeds D3DTSS_CONSTANT to zero. It is a D3DCOLOR, not a selector;
            // unpack it once here so the combiner can use the exact per-stage value.
            st.constant ??= newFfpColor();
            unpackD3dColor(ts(s, D3DTSS_CONSTANT) >>> 0, st.constant);
            stages.push(st);
        }
        return stages;
    }

    /** A reusable, zero-filled stage record for the resolved-stage pool. */
    private static emptyStage(): FfpResolvedStage {
        return {
            colorOp: 0, colorArg1: 0, colorArg2: 0, colorArg0: 0,
            alphaOp: 0, alphaArg1: 0, alphaArg2: 0, alphaArg0: 0,
            resultArg: 0, texCoordIndex: 0, texTransformFlags: 0, constant: newFfpColor(),
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
        /** The slot mask the pipeline was built with — see resolveFfpVertexColors. */
        slotMask: number = this.activeSlotMask(),
    ): Float32Array {
        const rs = (s: number) => this.stateTracker.getRenderState(s);

        const { hasColor, hasSpecular, hasNormal: hasNormalDecl } = this.resolveFfpVertexColors(slotMask);
        // Pre-transformed position — decides which fog the FFP runs (see resolveFfpFogMode),
        // and (isProgrammable) whether a bound vertex shader runs at all. One rule, one owner.
        const isRHW = this.activeDeclIsPreTransformed();
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
        enabled.sort(ascending);
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

        // Palette blending produces world-space positions in the vertex shader. Exclude WORLD
        // from the downstream transforms for palette modes, exactly as DXVK's fixed-function VS:
        // VS applies View·Proj to the blended position and View to lighting/normal inputs.
        const blendMode = rs(D3DRS_VERTEXBLEND) | 0;
        const indexedBlend = rs(D3DRS_INDEXEDVERTEXBLENDENABLE) !== 0;
        const paletteBlend = (blendMode >= 1 && blendMode <= 3) || blendMode === 256;
        const worldView = paletteBlend ? this.stateTracker.getViewMatrix() : this.stateTracker.getWorldView();
        const params = (this.ffpParams ??= makeFfpParams());
        params.viewportW = vpW;
        params.viewportH = vpH;
        params.mvp = paletteBlend
            ? multiplyD3dMatrices(this.stateTracker.getViewMatrix(), this.stateTracker.getProjectionMatrix())
            : this.stateTracker.getMVP();
        params.worldView = worldView;
        params.normalMatrix = this.buildNormalMatrix(worldView);
        params.view = this.stateTracker.getViewMatrix();
        params.world = paletteBlend ? FFP_IDENTITY_MATRIX : this.stateTracker.getWorldMatrix();
        this.ffpBlendMatrices.set(this.stateTracker.getWorldMatrices());
        params.blendMatrices = this.ffpBlendMatrices;
        params.blendVertexMode = blendMode;
        params.blendIndexed = indexedBlend;
        params.blendTweenFactor = this.rsFloat(rs(170)); // D3DRS_TWEENFACTOR
        params.blendMatrixCount = blendMode === 256 ? 1 : blendMode >= 1 && blendMode <= 3 ? blendMode + 1 : 1;
        params.clipPlanes = this.ffpClipPlanesScratch;
        params.clipPlaneEnable = clipPlaneEnable;
        params.material = this.parseMaterial();
        params.globalAmbient = unpackD3dColor(rs(D3DRS_AMBIENT) >>> 0, this.ffpGlobalAmbient);
        params.lightingEnabled = rs(D3DRS_LIGHTING) !== 0;
        params.specularEnable = rs(D3DRS_SPECULARENABLE) !== 0;
        params.localViewer = rs(D3DRS_LOCALVIEWER) !== 0;
        params.diffuseSrc = this.effectiveColorSource(rs(D3DRS_DIFFUSEMATERIALSOURCE), colorVertex, hasColor, hasSpecular);
        params.ambientSrc = this.effectiveColorSource(rs(D3DRS_AMBIENTMATERIALSOURCE), colorVertex, hasColor, hasSpecular);
        params.specularSrc = this.effectiveColorSource(rs(D3DRS_SPECULARMATERIALSOURCE), colorVertex, hasColor, hasSpecular);
        params.emissiveSrc = this.effectiveColorSource(rs(D3DRS_EMISSIVEMATERIALSOURCE), colorVertex, hasColor, hasSpecular);
        params.hasNormal = hasNormal;
        params.normalizeNormals = rs(D3DRS_NORMALIZENORMALS) !== 0;
        params.lights = lights;
        params.stages = stages;
        params.texMatrices = this.stateTracker.getTextureMatrices();
        // D3DRS_TEXTUREFACTOR (60) — the tracker seeds the white default.
        params.tfactor = unpackD3dColor(rs(60) >>> 0, this.ffpTFactor);
        params.fogColor = unpackD3dColor(rs(D3DRS_FOGCOLOR) >>> 0, this.ffpFogColor);
        params.fogColor.a = 1;
        params.fogStart = this.rsFloat(rs(D3DRS_FOGSTART));
        params.fogEnd = this.rsFloat(rs(D3DRS_FOGEND));
        params.fogDensity = this.rsFloat(rs(D3DRS_FOGDENSITY));
        params.fogMode = resolveFfpFogMode(
            rs(D3DRS_FOGENABLE), rs(D3DRS_FOGTABLEMODE), rs(D3DRS_FOGVERTEXMODE), isRHW, hasSpecular,
            rs(D3DRS_RANGEFOGENABLE) !== 0,
        );
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
        // D3D9 clears the VIEWPORT (intersected with the scissor when the test is on), not the
        // whole attachment. A frame-level loadOp cannot be scissored, so anything short of full
        // coverage goes through the rectangle lowering — otherwise a per-viewport clear (shadow
        // atlas, split screen, PIP) wipes the regions already drawn this frame.
        const size = this.getCurrentTargetSize();
        const region = resolveD3D9ClearRegion(
            this.viewport, this.effectiveScissorRect(), this.getRS(D3DRS_SCISSORTESTENABLE) !== 0,
            size.w, size.h,
        );
        if (region.empty) return 0;
        if (!region.full) {
            this.clearRegionRect.left = region.left;
            this.clearRegionRect.top = region.top;
            this.clearRegionRect.right = region.right;
            this.clearRegionRect.bottom = region.bottom;
            this.clearRegionRects[0] = this.clearRegionRect;
            if (this.clearTargetRects(this.clearRegionRects, color, flags, z, stencil)) return 0;
            Logger.error(LogCategory.D3D9,
                "[D3D9] viewport-limited Clear could not be lowered; falling back to a full clear");
        }
        // A Clear after a draw must happen after that draw. RenderFrame represents a
        // clear as the next pass's load operation, so close the current pass first.
        if (this.hasPendingWork()) this.submitFrame(false);
        const clearColor = d3dColorToGpu(color);
        this.commandRecorder.setClear(clearColor, z, stencil, flags);
        if (frameCapture.isCapturing()) {
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

    /** Reused by the viewport-limited Clear above — one rect per call, on the guest's hot
     *  per-frame path, so neither the array nor the rect is reallocated. */
    private readonly clearRegionRect = { left: 0, top: 0, right: 0, bottom: 0 };
    private readonly clearRegionRects = [this.clearRegionRect];

    /** Apply a D3D9 rectangle-list Clear without disturbing pixels outside the requested
     * attachment. Color uses a solid-fill pass; depth/stencil uses an attachment-only
     * load/store pass with a scissor. Both lower at the ATTACHMENT's sample count, so an
     * MSAA target clears in place rather than failing a call D3D9 cannot fail. */
    clearTargetRects(
        rects: Array<{ left: number; top: number; right: number; bottom: number }>,
        color: number,
        flags = 1,
        z = 1,
        stencil = 0,
    ): boolean {
        if (this.gpuGone || rects.length === 0) return false;
        if (frameCapture.isCapturing()) {
            const size = this.getCurrentTargetSize();
            frameCapture.recordClearRaw(flags, color, z, stencil,
                { surfacePtr: this.captureRtId(), width: size.w, height: size.h }, rects.length);
        }
        // A D3DMULTISAMPLE_TYPE is not a sample count (NONMASKABLE is 1 sample, enum 1);
        // activeRenderTargetSampleCount owns that decode for every other pipeline path too.
        const colorSampleCount = this.activeRenderTargetSampleCount();
        const standaloneDepth = this.activeStandaloneDepthSurface === null
            ? null : this.standaloneDepthBinding(this.activeStandaloneDepthSurface);
        const depthSampleCount = standaloneDepth?.sampleCount ?? 1;
        const depthFormat = this.activeDepthTargetFormat();
        const hasStencil = depthFormat === "depth24plus-stencil8" || depthFormat === "depth32float-stencil8";
        const clearPolicy = resolveD3D9RectClearPolicy(
            flags, Math.max(colorSampleCount, depthSampleCount), hasStencil,
        );
        if (!clearPolicy.supported) return false;

        this.submitFrame(false);
        const gpuColor = d3dColorToGpu(color);
        const target = this.renderTargetIndices[0];
        let ok = true;
        if (clearPolicy.target) {
            const device = this.backend.getDevice();
            if (!device) return false;
            // D3DCLEAR_TARGET addresses every currently bound MRT, not only RT0.
            for (let targetIndex = 0; targetIndex < this.renderTargetIndices.length; targetIndex++) {
                const index = this.renderTargetIndices[targetIndex];
                if (index === null) {
                    if (targetIndex !== 0) continue;
                    for (const rect of rects) {
                        if (!this.backendExecutor.colorFillBackbufferRect(rect, gpuColor)) ok = false;
                    }
                    continue;
                }
                this.ensureTexture(index);
                const gpuTex = this.textures.getGpuTexture(index);
                const format = this.renderTargetGpuFormats.get(index) ?? this.backend.getFormat();
                const view = gpuTex
                    ? (this.textures.isCubeMap(index)
                        ? this.getCubeFaceRenderView(index, this.renderTargetFaces[targetIndex] ?? -1, 0)
                        : gpuTex.createView())
                    : null;
                if (!view || !format) { ok = false; break; }
                const width = this.textures.getWidth(index);
                const height = this.textures.getHeight(index);
                for (const rect of rects) {
                    if (!this.backendExecutor.colorFillRect(view, format, width, height, rect, gpuColor,
                        colorSampleCount)) ok = false;
                }
                if (!ok) break;
            }
        }
        if (ok && (clearPolicy.depth || clearPolicy.stencil)) {
            const size = this.getCurrentTargetSize();
            let attachment: {
                view: GPUTextureView;
                format: GPUTextureFormat;
                width: number;
                height: number;
            } | null = null;
            let attachmentSamples = 1;
            if (this.depthTextureIndex !== null || this.activeStandaloneDepthSurface !== null) {
                // Same resolution as the render pass, so a partial clear lands on the very
                // attachment the following draws render into.
                const resolved = this.resolveDepthAttachment(size.w, size.h);
                if (resolved) {
                    attachment = {
                        view: resolved.view,
                        format: resolved.format,
                        width: resolved.width,
                        height: resolved.height,
                    };
                    attachmentSamples = depthSampleCount;
                }
            } else if (target !== null) {
                attachment = {
                    view: this.getRtDepthView(size.w, size.h, this.activeDepthTargetFormat()),
                    format: this.activeDepthTargetFormat(),
                    width: size.w,
                    height: size.h,
                };
            } else {
                const backbufferDepth = this.backendExecutor.getBackbufferDepthAttachment();
                attachment = backbufferDepth;
                attachmentSamples = backbufferDepth?.sampleCount ?? 1;
            }
            if (!attachment) ok = false;
            else {
                // Each helper has its own ordered queue submission. submitFrame(false) above
                // flushed all preceding draws, so a later draw is naturally after this clear.
                for (const rect of rects) {
                    if (!this.backendExecutor.clearDepthStencilRect(
                        attachment.view, attachment.format, attachment.width, attachment.height,
                        rect, z, stencil, flags, attachmentSamples,
                    )) {
                        ok = false;
                        break;
                    }
                }
            }
        }
        if (ok) {
            if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.clears++;
            const gdiContext = this.getGdiContext();
            if (gdiContext) gdiContext.clearOverlay();
        }
        return ok;
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
        this.setSwapEffect(readD3d9SwapEffect(view, pPresentationParameters));

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
        const { w: targetW, h: targetH } = this.getCurrentTargetSize();
        const viewport = sanitizeViewport({
            x: view.getUint32(pViewport + 0, true),
            y: view.getUint32(pViewport + 4, true),
            width: view.getUint32(pViewport + 8, true),
            height: view.getUint32(pViewport + 12, true),
            minZ: view.getFloat32(pViewport + 16, true),
            maxZ: view.getFloat32(pViewport + 20, true),
        }, targetW, targetH);
        // The viewport is state-block state (D3DSBT_ALL): BeginStateBlock → SetViewport →
        // EndStateBlock → Apply is the standard UI idiom, and without this branch the block
        // restores every render state but leaves the viewport wherever the guest left it.
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "viewport", ...viewport });
            return 0;
        }
        this.viewport = viewport;
        return 0;
    }

    /** Apply a viewport captured by a state block without fabricating a guest pointer. */
    setViewportValues(viewport: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number }): number {
        const { w: targetW, h: targetH } = this.getCurrentTargetSize();
        const sanitized = sanitizeViewport({ ...viewport }, targetW, targetH);
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "viewport", ...sanitized });
            return 0;
        }
        this.viewport = sanitized;
        return 0;
    }

    getViewport(): typeof this.viewport {
        return this.viewport;
    }

    private scissorRect = { left: 0, top: 0, right: 0, bottom: 0 };
    /** D3D9's scissor rect DEFAULTS to the whole render target, and follows the target until
     *  the app sets one. An all-zero default would clip everything away the moment a game
     *  enables D3DRS_SCISSORTESTENABLE without ever calling SetScissorRect. */
    private scissorRectSet = false;
    private scissorDrawRect = { left: 0, top: 0, width: 0, height: 0 };

    setScissorRect(left: number, top: number, right: number, bottom: number): void {
        if (this.recordingStateBlock) {
            this.recordStateBlock({ op: "scissorRect", left, top, right, bottom });
            return;
        }
        this.scissorRect = { left, top, right, bottom };
        this.scissorRectSet = true;
    }

    getScissorRect(): { left: number; top: number; right: number; bottom: number } {
        return this.effectiveScissorRect();
    }

    /** The scissor the app would read back: its own, or the whole current target. */
    private effectiveScissorRect(): { left: number; top: number; right: number; bottom: number } {
        if (this.scissorRectSet) return this.scissorRect;
        const { w, h } = this.getCurrentTargetSize();
        this.scissorRect.left = 0;
        this.scissorRect.top = 0;
        this.scissorRect.right = Math.max(0, w);
        this.scissorRect.bottom = Math.max(0, h);
        return this.scissorRect;
    }

    /** Snapshot the effective D3D scissor for a draw. WebGPU keeps scissor state on the pass,
     * so disabled draws explicitly receive the full target rectangle to prevent state leakage
     * from a preceding enabled draw. */
    getScissorRectForDraw(): { left: number; top: number; width: number; height: number } {
        const { w, h } = this.getCurrentTargetSize();
        if (this.getRS(D3DRS_SCISSORTESTENABLE) === 0) {
            this.scissorDrawRect.left = 0;
            this.scissorDrawRect.top = 0;
            this.scissorDrawRect.width = Math.max(0, w);
            this.scissorDrawRect.height = Math.max(0, h);
            return this.scissorDrawRect;
        }
        const scissor = this.effectiveScissorRect();
        const left = Math.max(0, Math.min(w, scissor.left | 0));
        const top = Math.max(0, Math.min(h, scissor.top | 0));
        const right = Math.max(left, Math.min(w, scissor.right | 0));
        const bottom = Math.max(top, Math.min(h, scissor.bottom | 0));
        this.scissorDrawRect.left = left;
        this.scissorDrawRect.top = top;
        this.scissorDrawRect.width = right - left;
        this.scissorDrawRect.height = bottom - top;
        return this.scissorDrawRect;
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
     * The fixed-function WGSL the CURRENT state generates, plus the layout decision behind it.
     *
     * A capture reports the states a draw ASKED for; it cannot say which of them the generated
     * shader went on to read. The gap between the two is invisible in both a capture and a
     * screenshot — a declaration carrying no COLOR and an FVF whose colour was dropped produce
     * the same full-bright pixels as a correct white-diffuse draw — so the emitted source is
     * the only direct evidence. `path` names which of the two layout owners won.
     */
    describeFfpShader(): Record<string, unknown> {
        const declElements = this.activeVertexDecl > 0
            ? (this.vsDeclRegistry.get(this.activeVertexDecl) ?? null)
            : null;
        const stageCount = this.activeStageCount();
        const alphaTest = this.getAlphaTest();
        const samplerStates = this.samplerShaderStates(null, null, stageCount);
        const lit = this.stateTracker.getRenderState(D3DRS_LIGHTING) !== 0;
        const fvf = this.stateTracker.getFVF();
        const boundStride = this.slotStride(0, 0);
        const common = {
            decl: this.activeVertexDecl,
            fvf,
            boundStride,
            stageCount,
            lit,
            alphaTest,
        };
        if (declElements && declElements.length > 0) {
            const built = buildShaderFromDecl(declElements, alphaTest, lit, stageCount,
                this.slotStrides(0), this.activeSlotMask(), this.texGenActive(stageCount), samplerStates,
                this.flatShadingEnabled());
            return {
                ...common,
                path: "declaration",
                elements: declElements.map(e => ({
                    stream: e.stream, offset: e.offset, type: e.type,
                    usage: e.usage, usageName: declUsageName(e.usage), usageIndex: e.usageIndex,
                })),
                buffers: built.buffers,
                wgsl: built.wgsl,
            };
        }
        return {
            ...common,
            path: "fvf",
            plan: planFvf(fvf, boundStride),
            wgsl: buildShader(fvf, alphaTest, lit, stageCount, this.texGenActive(stageCount), boundStride,
                samplerStates, this.flatShadingEnabled()),
        };
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
            const fmt = ti !== null && !this.isVolumeIndex(ti) ? this.textures.getFormat(ti) : null;
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
                texture: ti === null ? null
                    : this.isVolumeIndex(ti)
                        ? `0x${(this.volumeEntry(ti)?.pointer ?? 0).toString(16)}`
                        : `0x${this.textures.getHandle(ti).toString(16)}`,
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
    private captureLighting(slotMask: number = this.activeSlotMask()): Record<string, unknown> {
        const rs = (n: number): number => this.stateTracker.getRenderState(n);
        const m = this.parseMaterial();
        const c = (x: FfpColor): number[] => [x.r, x.g, x.b, x.a].map((v) => Math.round(v * 1000) / 1000);
        const { hasColor, hasSpecular } = this.resolveFfpVertexColors(slotMask);
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
        /** The slot mask this draw's pipeline will be built with, when the caller already
         *  knows it — so the reported colour sources match the shader's. */
        slotMask: number = this.activeSlotMask(),
    ): void {
        if (!frameCapture.isCapturing()) return;
        const stage0 = this.stateTracker.getTexture(0);
        const stage1 = this.stateTracker.getTexture(1);
        const rs = (n: number): number => this.stateTracker.getRenderState(n);
        const rt = this.currentRtIndex;
        const size = this.getCurrentTargetSize();
        const fvf = this.stateTracker.getFVF();
        // A declaration OWNS the vertex layout when one is active, so decoding the bytes by FVF
        // reports components at offsets this vertex never had — position from a hole, a diffuse
        // that is really padding. The numbers look plausible and are fiction, so the decode is
        // withheld and the declaration named instead.
        const declElems = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
        const declPos = declElems?.find(
            e => e.usage === DECLUSAGE_POSITION_FFP || e.usage === DECLUSAGE_POSITIONT_FFP) ?? null;
        const isRhw = declPos
            ? (declPos.usage === DECLUSAGE_POSITIONT_FFP || declPos.type === 3 /* FLOAT4 */)
            : (fvf & D3DFVF_POSITION_MASK) === D3DFVF_XYZRHW;
        const activeVs = this.getActiveVsShader();
        // Every field here is READ, not defaulted. D3D9 keeps one flat render-state array, so
        // the depth/blend/alpha/cull/lighting/fog states are as available as on the FFP path;
        // reporting them as schema zeros made a capture say "depth test off on every draw".
        frameCapture.recordRawDraw({
            backend: "d3d9",
            primitiveType,
            primitiveTypeName: `D3DPT(${primitiveType})`,
            vertexCount: verts ? verts.count : primitiveCount * 3,
            programmable: (this as any).isProgrammable?.() ?? false,
            vertexShader: this.activeVertexShader,
            pixelShader: this.activePixelShader,
            vsWritesColor: activeVs ? [...activeVs.analysis.writesColor] : [],
            // The constant banks a programmable draw actually sampled. A shader whose output
            // is `tex * c0 * v0` is invisible when c0 is zero and identical in every other
            // recorded field to one that works, so the capture has to carry the values —
            // "which constants did this draw see" is otherwise unanswerable after the fact.
            ...(((this as any).isProgrammable?.() ?? false)
                ? {
                    psConst: Array.from(this.psConstants.subarray(0, PS_CAPTURE_REGISTERS * 4)),
                    vsConst: Array.from(this.vsConstants.subarray(0, VS_CAPTURE_REGISTERS * 4)),
                }
                : {}),
            vsWritesTexcoord: activeVs ? [...activeVs.analysis.writesTexcoord].sort((a, b) => a - b) : [],
            derivedUseTexture: stage0 != null,
            vertexType: fvf,
            vertexDecl: this.activeVertexDecl,
            isRHW: isRhw,
            ...(verts
                ? {
                    ...(declElems
                        ? (() => {
                            const decoded = this.decodeFirstVerticesByDecl(verts, declElems, declPos?.stream ?? 0);
                            return decoded.length
                                ? { firstVertices: decoded, firstVerticesFrom: `decl ${this.activeVertexDecl}` }
                                : { firstVerticesUnavailable: `vertex declaration ${this.activeVertexDecl} puts position on a stream this capture does not carry` };
                        })()
                        : { firstVertices: this.decodeFirstVertices(verts, fvf) }),
                    srcStride: verts.stride,
                }
                : {}),
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
            lighting: this.captureLighting(slotMask),
            // The bound stages as GUEST HANDLES — the identity dumpTexture/textures() take, so a
            // capture row leads straight to the pixels. Stage 1 is called out because the FFP
            // path renders stage 0 only: a draw with a stage-1 texture bound is one whose second
            // stage we silently drop (lightmap, detail) — invisible in the picture as anything
            // but "the lighting looks wrong".
            warnings: [
                ...(stage0 != null ? [`tex0 handle=0x${this.textures.getHandle(stage0).toString(16)}`] : []),
                ...(stage1 != null
                    ? [`tex1 handle=0x${this.textures.getHandle(stage1).toString(16)}`]
                    : []),
                `tss0 cop=${this.getTextureStageState(0, D3DTSS_COLOROP)} c1=${this.getTextureStageState(0, 2)} c2=${this.getTextureStageState(0, 3)} ` +
                    `aop=${this.getTextureStageState(0, 4)} a1=${this.getTextureStageState(0, 5)} a2=${this.getTextureStageState(0, 6)} tci=${this.getTextureStageState(0, D3DTSS_TEXCOORDINDEX)}`,
                `tss1 cop=${this.getTextureStageState(1, D3DTSS_COLOROP)} c1=${this.getTextureStageState(1, 2)} c2=${this.getTextureStageState(1, 3)} ` +
                    `aop=${this.getTextureStageState(1, 4)} a1=${this.getTextureStageState(1, 5)} a2=${this.getTextureStageState(1, 6)} tci=${this.getTextureStageState(1, D3DTSS_TEXCOORDINDEX)}`,
                `colorWrite=0x${rs(168).toString(16)}`,
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
    /**
     * First vertices decoded through the active DECLARATION rather than the FVF.
     *
     * A declaration owns the layout, so the FVF decode is fiction there — but withholding the
     * numbers entirely leaves "are these quads even on screen, and what colour are they
     * modulated by" unanswerable for every shader-era title, which is most of them. The
     * declaration says exactly where each component sits, so decode from it.
     *
     * Only the captured stream can be read (the capture carries one vertex buffer), so an
     * element on another stream is reported as absent rather than decoded from the wrong bytes.
     */
    private decodeFirstVerticesByDecl(
        verts: { data: Uint8Array; offset: number; stride: number; count: number },
        elems: RawVertexElement[],
        stream: number,
    ): Array<{ x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number }> {
        const out: Array<{ x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number }> = [];
        const { data, offset, stride, count } = verts;
        if (stride <= 0) return out;
        const on = elems.filter(e => e.stream === stream && e.type !== 17 /* UNUSED */);
        const pos = on.find(e => e.usage === DECLUSAGE_POSITIONT_FFP)
            ?? on.find(e => e.usage === DECLUSAGE_POSITION_FFP);
        if (!pos) return out;
        const color = on.find(e => e.usage === 10 /* COLOR */ && e.usageIndex === 0);
        const tex = on.find(e => e.usage === 5 /* TEXCOORD */ && e.usageIndex === 0);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const cfgMax = ((globalThis as unknown as Record<string, unknown>).__captureVertsMax as number) >>> 0;
        const n = Math.min(count, cfgMax > 0 ? cfgMax : 4);
        for (let i = 0; i < n; i++) {
            const base = offset + i * stride;
            if (base + stride > data.byteLength) break;
            const end = Math.min(base + stride, data.byteLength);
            const f32 = (off: number): number | undefined =>
                base + off + 4 <= end ? view.getFloat32(base + off, true) : undefined;
            const v: { x: number; y: number; z: number; w?: number; u?: number; v?: number; diffuse?: number } = {
                x: f32(pos.offset) ?? 0,
                y: f32(pos.offset + 4) ?? 0,
                z: f32(pos.offset + 8) ?? 0,
            };
            // FLOAT4 position carries w (RHW on a POSITIONT stream); FLOAT3 does not.
            if (pos.type === 3) v.w = f32(pos.offset + 12);
            if (color && color.type === 4 /* D3DCOLOR */ && base + color.offset + 4 <= end) {
                v.diffuse = view.getUint32(base + color.offset, true);
            }
            if (tex) { v.u = f32(tex.offset); v.v = f32(tex.offset + 4); }
            out.push(v);
        }
        return out;
    }

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
            // The stream stride can be SMALLER than the FVF's packed size (planFvf drops the
            // components that fall outside it), so an FVF-derived offset is not guaranteed to
            // sit inside this vertex. DataView throws
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
     * Lower a programmable/declaration point list to a triangle list without changing the
     * guest vertex layout.  Each source vertex is copied six times; the linked VS receives
     * `@builtin(vertex_index)` and applies the shader's oPts value to the six clip-space
     * corners.  This keeps every declaration attribute and every VS/PS varying on the proven
     * normal pipeline path, while avoiding a WebGPU point rasterizer (which is only 1px and
     * has no programmable point-size output).
     *
     * The source span is checked before scratch/upload state is touched.  `startVertex` is
     * retained for extra declaration streams, whose bytes must follow the same duplication
     * order as stream 0.  A pre-transformed declaration is deliberately excluded: that path
     * replaces the guest VS with the fixed-function POSITIONT linker and has no oPts value.
     */
    private tryDrawProgrammablePointList(
        srcBytes: Uint8Array,
        pointCount: number,
        stride: number,
        startVertex: number,
        slotMask: number,
    ): boolean {
        if (!this.isProgrammable() || this.activeDeclIsPreTransformed()) return false;
        if (pointCount <= 0 || stride <= 0 || srcBytes.byteLength < pointCount * stride) return false;
        if (!Number.isSafeInteger(pointCount) || !Number.isSafeInteger(stride)
            || !Number.isSafeInteger(startVertex) || startVertex < 0) return false;
        const outputCount = pointCount * 6;
        if (!Number.isSafeInteger(outputCount) || outputCount <= 0) return false;
        const finalData = this.ensureConversionBuffer(outputCount * stride);
        const order = this.ensureRewindOrder(outputCount);
        for (let i = 0; i < pointCount; i++) {
            const source = i * stride;
            for (let corner = 0; corner < 6; corner++) {
                const output = (i * 6 + corner) * stride;
                finalData.set(srcBytes.subarray(source, source + stride), output);
                order[i * 6 + corner] = i;
            }
        }
        if (!this.expandStreamsByOrder(slotMask, order, outputCount, startVertex)) return false;
        // recordConvertedDraw owns pipeline refusal logging and pooled-buffer lifetime.  It
        // returns the API HRESULT (0 even when a draw is explicitly dropped), so this helper
        // reports "handled" once the source was safely lowered and lets the caller return.
        this.recordConvertedDraw(finalData, outputCount, stride, "triangle-list", slotMask, true);
        return true;
    }

    /** Indexed counterpart of tryDrawProgrammablePointList.  Indices are gathered first so
     * the six copies of one point retain exactly the source vertex selected by D3D9's index
     * buffer and the declaration's other streams use the same raw-index order. */
    private tryDrawIndexedProgrammablePointList(
        indexData: Uint8Array,
        indexByteOffset: number,
        indexIs32: boolean,
        pointCount: number,
        baseVertexIndex: number,
        minVertexIndex: number,
        numVertices: number,
        vertexData: Uint8Array,
        vertexBaseOffset: number,
        stride: number,
        slotMask: number,
    ): boolean {
        if (!this.isProgrammable() || this.activeDeclIsPreTransformed()) return false;
        if (pointCount <= 0 || stride <= 0 || numVertices <= 0) return false;
        const indexSize = indexIs32 ? 4 : 2;
        const rangeEnd = minVertexIndex + numVertices;
        if (!Number.isSafeInteger(indexByteOffset) || indexByteOffset < 0
            || !Number.isSafeInteger(rangeEnd) || rangeEnd < minVertexIndex
            || indexByteOffset + pointCount * indexSize > indexData.byteLength
            || !Number.isSafeInteger(vertexBaseOffset) || vertexBaseOffset < 0) return false;
        const outputCount = pointCount * 6;
        if (!Number.isSafeInteger(outputCount) || outputCount <= 0) return false;
        const finalData = this.ensureConversionBuffer(outputCount * stride);
        const order = this.ensureRewindOrder(outputCount);
        for (let i = 0; i < pointCount; i++) {
            const at = indexByteOffset + i * indexSize;
            const raw = indexIs32
                ? (indexData[at]! | (indexData[at + 1]! << 8)
                    | (indexData[at + 2]! << 16) | (indexData[at + 3]! << 24)) >>> 0
                : indexData[at]! | (indexData[at + 1]! << 8);
            if (raw >= rangeEnd) return false;
            const vertex = baseVertexIndex + raw;
            const source = vertexBaseOffset + vertex * stride;
            if (!Number.isSafeInteger(vertex) || vertex < 0 || !Number.isSafeInteger(source)
                || source < 0 || source + stride > vertexData.byteLength) return false;
            for (let corner = 0; corner < 6; corner++) {
                const output = (i * 6 + corner) * stride;
                finalData.set(vertexData.subarray(source, source + stride), output);
                order[i * 6 + corner] = raw;
            }
        }
        if (!this.expandStreamsByOrder(slotMask, order, outputCount, baseVertexIndex)) return false;
        this.recordConvertedDraw(finalData, outputCount, stride, "triangle-list", slotMask, true);
        return true;
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
        if (pipelineId < 0) {
            this.vbPool.release(gpuBuffer);
            d3d9DropDraw("pointSprite:noPipeline");
            return false;
        }
        // The synthetic FVF pipeline declares slot 0 alone, so the expansion binds slot 0 alone.
        const ffpStateIndex = this.captureFfpDrawState(UP_STREAM_SLOTS);
        this.streamPlan.reset();
        this.streamPlan.add(0, gpuBuffer, 0, outBytes);
        this.commandRecorder.recordDraw({
            pipelineId, streams: this.streamPlan,
            vertexCount: outVerts, startVertex: 0,
            ffpStateIndex,
            scissorRect: this.getScissorRectForDraw(),
            viewport: this.viewport,
            stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
            blendConstant: this.getRS(D3DRS_BLENDFACTOR) >>> 0,
        });
        this.commandRecorder.registerPooledBuffer(gpuBuffer);
        this.drawCount += 1;
        this.frameSnapshot.drawCalls++;
        return true;
    }

    /**
     * Indexed counterpart of tryDrawPointSprites. D3D9 point-list indices select source
     * vertices before fixed-function point-size/UV expansion; de-indexing into the same
     * contiguous scratch layout is equivalent to the non-indexed path. Declaration/programmatic
     * point lists still return false from tryDrawPointSprites and remain explicit refusals.
     */
    private tryDrawIndexedPointSprites(
        indexData: Uint8Array,
        indexByteOffset: number,
        indexIs32: boolean,
        pointCount: number,
        baseVertexIndex: number,
        minVertexIndex: number,
        numVertices: number,
        vertexData: Uint8Array,
        vertexBaseOffset: number,
        stride: number,
        fvf: number,
    ): boolean {
        if (pointCount <= 0 || stride <= 0 || numVertices <= 0) return false;
        const indexSize = indexIs32 ? 4 : 2;
        if (!Number.isSafeInteger(indexByteOffset) || indexByteOffset < 0
            || indexByteOffset + pointCount * indexSize > indexData.byteLength) return false;
        if (!Number.isSafeInteger(vertexBaseOffset) || vertexBaseOffset < 0) return false;
        const rangeEnd = minVertexIndex + numVertices;
        if (!Number.isSafeInteger(rangeEnd) || rangeEnd < minVertexIndex) return false;

        // Validate the complete source span before touching scratch/upload state.
        for (let i = 0; i < pointCount; i++) {
            const at = indexByteOffset + i * indexSize;
            const raw = indexIs32
                ? (indexData[at]! | (indexData[at + 1]! << 8)
                    | (indexData[at + 2]! << 16) | (indexData[at + 3]! << 24)) >>> 0
                : indexData[at]! | (indexData[at + 1]! << 8);
            // MinVertexIndex is an optimization bound supplied by the caller. Existing D3D9
            // UP paths validate the upper guaranteed span but still tolerate a lower raw index;
            // keep that contract and let the actual byte-span check below be authoritative.
            if (raw >= rangeEnd) return false;
            const vertex = baseVertexIndex + raw;
            if (!Number.isSafeInteger(vertex) || vertex < 0
                || vertexBaseOffset + vertex * stride + stride > vertexData.byteLength) return false;
        }

        const gathered = this.ensureConversionBuffer(pointCount * stride);
        for (let i = 0; i < pointCount; i++) {
            const at = indexByteOffset + i * indexSize;
            const raw = indexIs32
                ? (indexData[at]! | (indexData[at + 1]! << 8)
                    | (indexData[at + 2]! << 16) | (indexData[at + 3]! << 24)) >>> 0
                : indexData[at]! | (indexData[at + 1]! << 8);
            const source = vertexBaseOffset + (baseVertexIndex + raw) * stride;
            gathered.set(vertexData.subarray(source, source + stride), i * stride);
        }
        return this.tryDrawPointSprites(gathered.subarray(0, pointCount * stride), pointCount, stride, fvf);
    }

    /**
     * The fixed-function state the CPU vertex processor does NOT evaluate. ProcessVertices is
     * only allowed to answer for what it actually computes: transform and a semantic copy.
     * Reporting these lets it refuse instead of returning D3D_OK over unlit, unfogged output
     * the caller then draws pre-transformed.
     */
    private swvpFixedFunctionState(): { lighting: boolean; fog: boolean; texgen: boolean } {
        let anyLightEnabled = false;
        for (const on of this.lightEnables.values()) { if (on !== 0) { anyLightEnabled = true; break; } }
        const fogVertexMode = this.getRS(D3DRS_FOGVERTEXMODE);
        let texgen = false;
        for (let stage = 0; stage < D3D9_FFP_STAGE_COUNT; stage++) {
            // The high half of TEXCOORDINDEX is the D3DTSS_TCI_* generator; the low half is
            // just which declared coordinate set the stage reads, which IS a plain copy.
            if ((this.getTextureStageState(stage, D3DTSS_TEXCOORDINDEX) & 0xffff0000) !== 0
                || (this.getTextureStageState(stage, D3DTSS_TEXTURETRANSFORMFLAGS) & 0x7) !== 0) {
                texgen = true;
                break;
            }
        }
        return {
            lighting: this.getRS(D3DRS_LIGHTING) !== 0 && anyLightEnabled,
            fog: this.getRS(D3DRS_FOGENABLE) !== 0 && fogVertexMode !== 0,
            texgen,
        };
    }

    /**
     * Bounded NPatch lowering. The portable path is intentionally conservative: it accepts
     * fixed-function, non-RHW FVF vertices whose attributes are all float32 (XYZ, optional
     * normal and TEXCOORD sets), then linearly subdivides each triangle on the CPU. Packed
     * colours, blend betas/indices, declarations, programmable shaders and extra streams are
     * refused rather than interpolated as raw bytes. This is a real geometry path for the
     * common static FVF case; the cap stays zero because general D3D9 PN/displacement semantics
     * are not yet represented by this bounded lowering.
     */
    private tessellateNpatchSource(
        source: Uint8Array,
        stride: number,
        primitiveCount: number,
    ): NpatchTessellation | null {
        if (this.isProgrammable() || this.activeVertexDecl !== 0 || this.activeSlotMask() !== 1) return null;
        const fvf = this.stateTracker.getFVF();
        const layout = parseFvf(fvf);
        // Every field the tessellator touches must be a float32 lane. XYZB/RHW, packed colours,
        // point-size and LASTBETA encodings carry semantics a linear byte/float blend cannot
        // preserve. `stride === layout.stride` also avoids interpolating unknown padding.
        if ((fvf & D3DFVF_POSITION_MASK) !== D3DFVF_XYZ
            || (fvf & 0x4000) !== 0
            || layout.hasRhw || layout.hasColor || layout.hasSpecular
            || (fvf & D3DFVF_PSIZE) !== 0 || layout.blendWeightCount !== 0
            || layout.blendIndexFormat !== null || (fvf & 0x9000) !== 0
            || stride !== layout.stride) return null;
        // The control net needs position and normal; without a normal every lane is linear and
        // the tessellator collapses to the source triangle instead of emitting n² copies of it.
        return tessellateNpatchTriangleList(source, stride, primitiveCount, this.npatchMode, {
            positionOffset: layout.posOff,
            normalOffset: layout.hasNormal ? layout.normalOff : null,
        });
    }

    /** Record a tessellated triangle list through the ordinary pooled-VB path. */
    private drawNpatchSource(source: Uint8Array, stride: number, primitiveCount: number): number {
        const tessellation = this.tessellateNpatchSource(source, stride, primitiveCount);
        if (!tessellation) return d3d9DropDraw("npatch:unsupportedLayout");
        this.streamPlan.reset();
        const result = this.recordConvertedDraw(
            tessellation.data,
            tessellation.vertexCount,
            stride,
            "triangle-list",
            UP_STREAM_SLOTS,
        );
        if (result === 0) {
            this.frameSnapshot.drawCalls++;
            this.frameSnapshot.frameId = ++this.frameIdCounter;
            this.frameSnapshot.lastDraw = {
                api: "d3d9",
                primitiveType: D3DPT_TRIANGLELIST,
                numVerts: tessellation.vertexCount,
                timestamp: performance.now(),
            };
        }
        return result;
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
        if (this.npatchMode > 1.0) {
            if (primitiveType !== D3DPT_TRIANGLELIST) return d3d9DropDraw("drawPrimitive:npatchTopology");
            const streamSource = this.stateTracker.getStreamSource();
            const vb = streamSource ? this.vertexBuffers.getData(streamSource.index) : null;
            if (!streamSource || !vb || streamSource.stride <= 0 || this.activeSlotMask() !== 1) {
                return d3d9DropDraw("drawPrimitive:npatchSource");
            }
            const offset = streamSource.offset + startVertex * streamSource.stride;
            const bytes = primitiveCount * 3 * streamSource.stride;
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(bytes)
                || bytes <= 0 || offset + bytes > vb.byteLength) {
                return d3d9DropDraw("drawPrimitive:npatchRange");
            }
            return this.drawNpatchSource(
                vb.subarray(offset, offset + bytes), streamSource.stride, primitiveCount,
            );
        }
        if (primitiveType === D3DPT_POINTLIST) {
            const ss = this.stateTracker.getStreamSource();
            const vb = ss ? this.vertexBuffers.getData(ss.index) : null;
            if (ss && vb) {
                const off = ss.offset + startVertex * ss.stride;
                if (this.tryDrawPointSprites(vb.subarray(off), primitiveCount, ss.stride, this.stateTracker.getFVF())) return 0;
                if (this.isProgrammable() && Number.isSafeInteger(off) && off >= 0
                    && Number.isSafeInteger(primitiveCount * ss.stride)
                    && off + primitiveCount * ss.stride <= vb.byteLength
                    && this.tryDrawProgrammablePointList(
                        vb.subarray(off, off + primitiveCount * ss.stride), primitiveCount, ss.stride,
                        startVertex, this.activeSlotMask())) return 0;
            }
            // If the programmable/declaration lowering could not validate the complete source
            // span, refuse loudly instead of silently dropping the draw or binding a different
            // vertex range.
            return d3d9DropDraw("drawPrimitive:pointListUnsupported");
        }
        const streamMask = this.activeSlotMask();
        const instancing = planInstancing(this.streams.freq, streamMask);
        if (instancing.refuse) return d3d9DropDraw(`drawPrimitive:${instancing.refuse}`);
        // A NON-indexed strip is the easy half of the strip story: primitive restart and
        // `stripIndexFormat` are properties of an INDEXED draw, so a sequential strip needs
        // none of the guards canDrawIndexedStripNatively applies — it just draws.
        const nativeStrip = primitiveType === D3DPT_TRIANGLESTRIP
            && !instancing.instanced
            && !(globalThis as { __d3d9NoNativeStrips?: boolean }).__d3d9NoNativeStrips;
        if (primitiveType !== D3DPT_TRIANGLELIST && !nativeStrip) {
            if (instancing.instanced) return d3d9DropDraw("drawPrimitive:instancingNonListTopology");
            return this.drawStreamAsTriangleList(primitiveType, startVertex, primitiveCount);
        }
        const streamSource = this.stateTracker.getStreamSource();
        if (!streamSource) return d3d9DropDraw("drawPrimitive:noStreamSource");

        const vbIndex = streamSource.index;
        const vbData = this.vertexBuffers.getData(vbIndex);
        if (!vbData) return d3d9DropDraw("drawPrimitive:noVertexData");

        const topology: D3D9DrawTopology = nativeStrip ? "triangle-strip" : "triangle-list";
        // A strip spans primitiveCount + 2 vertices; a list spans 3 per triangle.
        const vertexCount = nativeStrip ? primitiveCount + 2 : primitiveCount * 3;
        const arenaTopology = nativeStrip ? 5 : 0;
        const device = this.backend.getDevice()!;
        const slotMask = streamMask;

        let pipelineId: number;
        let arenaRecord: PendingArenaRecord | null = null;
        let bindStateIndex: number | undefined;
        let ffpStateIndex: number | undefined;
        if (this.isProgrammable()) {
            pipelineId = this.resolveProgrammablePipeline(
                topology, false, undefined, slotMask, false,
                !instancing.instanced && slotMask === 1
                    ? { kind: "draw", topology: arenaTopology, vertexCount, startVertex, stride: streamSource.stride, forceCullNone: false }
                    : undefined,
            );
            arenaRecord = this.takePendingArenaRecord();
            if (pipelineId < 0) {
                if (arenaRecord) d3d9WasmArena.rollback(arenaRecord.checkpoint);
                return d3d9DropDraw("drawPrimitive:noPipeline");
            }
            bindStateIndex = this.captureDrawState();
        } else {
            // Same split as the indexed path: the list keeps its one-entry memo, a strip
            // asks for its topology explicitly.
            pipelineId = nativeStrip
                ? this.getPipelineIdForTopology(topology, false, 0, slotMask)
                : this.getPipelineId(slotMask);
            if (pipelineId < 0) return d3d9DropDraw("drawPrimitive:noPipeline");
            ffpStateIndex = this.captureFfpDrawState(slotMask);
        }
        // Slot 0 is resolved by the same code as every other slot — including its binding
        // size, which runs to the END of the buffer (the GPU applies startVertex itself).
        this.commandRecorder.recordDraw({
            pipelineId,
            streams: this.resolveDrawStreams(slotMask, device, instancing.instanceCount),
            vertexCount,
            startVertex,
            instanceCount: instancing.instanceCount,
            guestStride: streamSource.stride,
            bindStateIndex,
            ffpStateIndex,
            scissorRect: this.getScissorRectForDraw(),
            viewport: this.viewport,
            stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
            blendConstant: this.getRS(D3DRS_BLENDFACTOR) >>> 0,
        });
        this.linkArenaDraw(
            arenaRecord?.commandStart ?? -1, arenaRecord?.key, pipelineId, bindStateIndex,
            arenaRecord?.identity.words, arenaRecord?.identity.key,
        );
        this.drawCount += 1;

        // Update frame snapshot for debug panel
        this.frameSnapshot.drawCalls++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = {
            api: "d3d9",
            primitiveType,
            numVerts: vertexCount,
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
        { srcVertexCount: number; finalVertexCount: number; topology: D3D9DrawTopology } | null {
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

        const slotMask = this.activeSlotMask();
        if (!this.expandStreamsByOrder(slotMask, order, finalVertexCount, startVertex)) {
            return d3d9DropDraw("strip:extraStreamUnreadable");
        }
        return this.recordConvertedDraw(finalData, finalVertexCount, stride, topology, slotMask);
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
    /**
     * May this indexed strip be handed to WebGPU as a strip, or must it be rewound?
     *
     * Two things stand in the way, and both are decidable in O(1) from the draw's own
     * arguments — no index scan, which would cost what the native path is saving:
     *  - WebGPU treats the all-ones index as PRIMITIVE RESTART inside a strip; D3D9 has no
     *    restart, so an app that legitimately addresses vertex 0xFFFF would have its strip
     *    silently cut. D3D9 promises every index lies in [MinVertexIndex, +NumVertices), so
     *    the restart value is unreachable exactly when that range ends at or below it.
     *  - `stripIndexFormat` is baked into the pipeline, so a strip pipeline is built for one
     *    index width. Strips are restricted to uint16 (the era's norm) rather than making the
     *    width another dimension of every pipeline key; a uint32 strip keeps the rewind.
     */
    private canDrawIndexedStripNatively(minVertexIndex: number, numVertices: number): boolean {
        if ((globalThis as { __d3d9NoNativeStrips?: boolean }).__d3d9NoNativeStrips) return false;
        const ibIndex = this.stateTracker.getIndexSource();
        if (ibIndex === null) return false;
        if (this.indexBuffers.getFormat(ibIndex) !== D3DFMT_INDEX16) return false;
        if (!Number.isSafeInteger(minVertexIndex) || !Number.isSafeInteger(numVertices)) return false;
        if (minVertexIndex < 0 || numVertices <= 0) return false;
        return minVertexIndex + numVertices <= 0xFFFF;
    }

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

        const slotMask = this.activeSlotMask();
        if (!this.expandStreamsByOrder(slotMask, order, finalVertexCount, baseVertexIndex)) {
            return d3d9DropDraw("indexedStrip:extraStreamUnreadable");
        }
        return this.recordConvertedDraw(finalData, finalVertexCount, stride, shape.topology, slotMask);
    }

    /** Scratch for the strip/fan rewind permutation (grown, never per-draw allocated). */
    private rewindOrder: Uint32Array = new Uint32Array(0);
    private ensureRewindOrder(count: number): Uint32Array {
        if (this.rewindOrder.length < count) this.rewindOrder = new Uint32Array(Math.max(count, this.rewindOrder.length * 2, 256));
        return this.rewindOrder;
    }

    /**
     * Rewind the slots beyond 0 with the same vertex permutation a CPU-converted draw applied
     * to slot 0, into pooled buffers, and put them in the draw plan (slot 0 is added by
     * recordConvertedDraw once its own pooled buffer exists).
     *
     * The rewind IS the fetch — the resulting draw runs from vertex 0 — so the source offset
     * here legitimately folds in startVertex/baseVertex. That is the one place it may be
     * folded: nothing downstream steps these buffers again.
     *
     * False when a slot cannot be read: the caller drops the draw rather than binding vertices
     * that do not correspond to the ones slot 0 supplies.
     */
    private expandStreamsByOrder(
        slotMask: number,
        order: Uint32Array,
        vertexCount: number,
        startVertex: number,
    ): boolean {
        this.streamPlan.reset();
        if ((slotMask & ~1) === 0) return true;
        const device = this.backend.getDevice();
        if (!device) return false;
        if (!this.vbPool) this.vbPool = new DynamicVbPool(device);

        let maxIndex = 0;
        for (let v = 0; v < vertexCount; v++) if (order[v]! > maxIndex) maxIndex = order[v]!;

        for (let slot = 1; slot < MAX_VERTEX_STREAMS; slot++) {
            if (((slotMask >>> slot) & 1) === 0) continue;
            const index = this.streams.bufferIndex[slot]!;
            const stride = this.streams.strideBytes[slot]!;
            const data = index >= 0 ? this.vertexBuffers.getData(index) : null;
            if (!data || stride <= 0) {
                Logger.warn(LogCategory.D3D9, `converted draw: stream ${slot} unbound/unsized — dropping draw`);
                return false;
            }
            const base = this.streams.offsetBytes[slot]! + startVertex * stride;
            const size = vertexCount * stride;
            if (base < 0 || base + maxIndex * stride + stride > data.byteLength) return false;
            // Pooled scratch, refilled per stream: queue.writeBuffer copies at call time, so
            // one buffer can serve every stream of every draw. Write length padded to 4 —
            // writeBuffer throws on any other size.
            const paddedSize = (size + 3) & ~3;
            const bytes = this.ensureExtraStreamScratch(paddedSize);
            gatherVertices(bytes, data, base, order, vertexCount, stride);
            const buffer = this.vbPool.acquire(Math.max(16, paddedSize));
            device.queue.writeBuffer(buffer, 0, bytes, 0, paddedSize);
            this.commandRecorder.registerPooledBuffer(buffer);
            this.streamPlan.add(slot, buffer, 0, size);
        }
        return true;
    }

    /** Scratch for the extra-stream rewind, pooled like ensureConversionBuffer. */
    private extraStreamScratch: Uint8Array = new Uint8Array(0);
    private ensureExtraStreamScratch(size: number): Uint8Array {
        if (this.extraStreamScratch.length < size) {
            this.extraStreamScratch = new Uint8Array(Math.max(size, this.extraStreamScratch.length * 2, 4096));
        }
        return this.extraStreamScratch;
    }

    /** Upload a host-built vertex blob to a pooled VB and record one draw. Triangle-strip
     *  rewinds preserve the original winding (including the odd-triangle swap), so the guest
     *  cull mode remains meaningful for triangle-list conversion. Line-list conversion keeps
     *  culling disabled because it has no facing. The arena is deliberately not offered a key:
     *  the bytes drawn are CPU-converted and no longer match a contiguous guest range. */
    private recordConvertedDraw(
        finalData: Uint8Array,
        finalVertexCount: number,
        stride: number,
        topology: D3D9DrawTopology,
        /** The slots the plan already holds (slots 1+ rewound by expandStreamsByOrder); slot 0
         *  is this call's repacked buffer. 1 = slot 0 alone. */
        slotMask = 1,
        /** True when each source point was duplicated six times and the VS lowers oPts. */
        pointExpansion = false,
    ): number {
        const device = this.backend.getDevice();
        if (!device) return 0;

        const bufferSize = Math.max(16, finalData.byteLength);
        if (!this.vbPool) this.vbPool = new DynamicVbPool(device);
        const gpuBuffer = this.vbPool.acquire(bufferSize);
        device.queue.writeBuffer(gpuBuffer, 0, finalData);
        // Slot 0's stride is this draw's own repacked one, so it is the single legitimate
        // stride override — every other slot still steps by what SetStreamSource bound.
        this.streamPlan.add(0, gpuBuffer, 0, finalData.byteLength);

        let pipelineId: number;
        let bindStateIndex: number | undefined;
        let ffpStateIndex: number | undefined;
        // Point quads have no D3D face and must survive either guest cull mode, just like
        // the existing fixed-function point-sprite pipeline.  Their orientation is an
        // implementation detail of the corner ordering, not a user-visible triangle face.
        const forceCullNone = topology === "line-list" || pointExpansion;
        if (this.isProgrammable()) {
            pipelineId = this.resolveProgrammablePipeline(topology, forceCullNone, stride, slotMask, pointExpansion);
            if (pipelineId < 0) { this.commandRecorder.registerPooledBuffer(gpuBuffer); return d3d9DropDraw("converted:noPipeline"); }
            bindStateIndex = this.captureDrawState();
        } else {
            pipelineId = this.getPipelineIdForTopology(topology, forceCullNone, stride, slotMask);
            if (pipelineId < 0) { this.commandRecorder.registerPooledBuffer(gpuBuffer); return d3d9DropDraw("converted:noPipeline"); }
            ffpStateIndex = this.captureFfpDrawState(slotMask);
        }

        this.commandRecorder.recordDraw({
            pipelineId,
            streams: this.streamPlan,
            vertexCount: finalVertexCount,
            startVertex: 0,
            bindStateIndex,
            ffpStateIndex,
            scissorRect: this.getScissorRectForDraw(),
            viewport: this.viewport,
            stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
            blendConstant: this.getRS(D3DRS_BLENDFACTOR) >>> 0,
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
        if (!Number.isSafeInteger(minVertexIndex)
            || !Number.isSafeInteger(numVertices) || numVertices <= 0
            || !Number.isSafeInteger(primitiveCount) || primitiveCount <= 0
            || !Number.isSafeInteger(indexDataPtr) || indexDataPtr < 0
            || !Number.isSafeInteger(vertexDataPtr) || vertexDataPtr < 0
            || !Number.isSafeInteger(stride) || stride <= 0) {
            return d3d9DropDraw("drawIndexedPrimitiveUP:range");
        }
        let idxCount: number;
        let finalVertexCount: number;
        let topology: D3D9DrawTopology;
        switch (primitiveType) {
            case D3DPT_POINTLIST:
                idxCount = primitiveCount;
                finalVertexCount = primitiveCount;
                topology = "triangle-list";
                break;
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
                return d3d9DropDraw("drawIndexedPrimitiveUP:unsupportedTopology");
        }
        // One guest-memory snapshot for the whole call: the accessor re-derives the view from
        // v86 on every use (it must never be stored across an await), and a UP draw asked for
        // it five times. Same JS turn, so the view cannot detach underneath us.
        const guestMem = this.memory;
        const idxSize = indexIs32 ? 4 : 2;
        const vertexLimit = minVertexIndex + numVertices;
        const indexBytes = idxCount * idxSize;
        const vertexBytes = vertexLimit * stride;
        const captureOffset = vertexDataPtr + minVertexIndex * stride;
        const captureBytes = numVertices * stride;
        if (!Number.isSafeInteger(idxCount) || !Number.isSafeInteger(finalVertexCount)
            || !Number.isSafeInteger(vertexLimit) || vertexLimit <= 0
            || !Number.isSafeInteger(indexBytes) || !Number.isSafeInteger(vertexBytes)
            || !Number.isSafeInteger(captureOffset) || !Number.isSafeInteger(captureBytes)
            || !isValidAddress(guestMem, indexDataPtr, indexBytes)
            || !isValidAddress(guestMem, vertexDataPtr, vertexBytes)
            || !isValidAddress(guestMem, captureOffset, captureBytes)) {
            return d3d9DropDraw("drawIndexedPrimitiveUP:range");
        }
        if (frameCapture.isCapturing()) {
            this.captureDrawIfArmed(primitiveType, primitiveCount, {
                data: guestMem, offset: captureOffset, stride, count: numVertices,
            }, UP_STREAM_SLOTS);
        }
        if (this.scrubbedOut()) return 0;
        if (this.npatchMode > 1.0) {
            // Indexed NPatch requires the hardware patch evaluator's control-point and edge
            // sharing rules. The bounded path only handles a contiguous non-indexed FVF list;
            // refuse this shape instead of silently rendering an untessellated triangle list.
            return d3d9DropDraw("drawIndexedPrimitiveUP:npatchUnsupported");
        }

        if (primitiveType === D3DPT_POINTLIST) {
            if (this.isProgrammable() && this.tryDrawIndexedProgrammablePointList(
                this.memory,
                indexDataPtr,
                indexIs32,
                primitiveCount,
                0,
                minVertexIndex,
                numVertices,
                this.memory,
                vertexDataPtr,
                stride,
                UP_STREAM_SLOTS,
            )) return 0;
            const ok = this.tryDrawIndexedPointSprites(
                this.memory,
                indexDataPtr,
                indexIs32,
                primitiveCount,
                0,
                minVertexIndex,
                numVertices,
                this.memory,
                vertexDataPtr,
                stride,
                this.stateTracker.getFVF(),
            );
            return ok ? 0 : d3d9DropDraw("drawIndexedPrimitiveUP:pointListUnsupported");
        }

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
                return d3d9DropDraw("drawIndexedPrimitiveUP:indexRange");
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
        // No bound streams take part: a *UP draw supplies its vertices inline.
        this.streamPlan.reset();
        return this.recordConvertedDraw(finalData, finalVertexCount, stride, topology, UP_STREAM_SLOTS);
    }

    drawPrimitiveUP(primitiveType: number, primitiveCount: number, vertexDataPtr: number, stride: number): number {
        if (this.gpuGone) return d3d9DropDraw("drawPrimitiveUP:deviceLost");
        d3d9PerfInc("drawPrimitiveUP");
        if (!Number.isSafeInteger(primitiveCount) || primitiveCount <= 0) {
            return d3d9DropDraw("drawPrimitiveUP:range");
        }
        if (!Number.isSafeInteger(vertexDataPtr) || vertexDataPtr < 0
            || !Number.isSafeInteger(stride) || stride <= 0) {
            return d3d9DropDraw("drawPrimitiveUP:range");
        }
        let srcVertexCount: number;
        switch (primitiveType) {
            case D3DPT_POINTLIST:
                srcVertexCount = primitiveCount;
                break;
            case D3DPT_TRIANGLELIST:
                srcVertexCount = primitiveCount * 3;
                break;
            case D3DPT_TRIANGLEFAN:
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
                return d3d9DropDraw("drawPrimitiveUP:unsupportedTopology");
        }
        // One snapshot for the call (see drawIndexedPrimitiveUP).
        const guestMem = this.memory;
        const sourceByteLen = srcVertexCount * stride;
        if (!Number.isSafeInteger(srcVertexCount) || !Number.isSafeInteger(sourceByteLen)
            || sourceByteLen <= 0 || !isValidAddress(guestMem, vertexDataPtr, sourceByteLen)) {
            return d3d9DropDraw("drawPrimitiveUP:range");
        }
        // harness capture (UP renders non-trilist too)
        if (frameCapture.isCapturing()) {
            this.captureDrawIfArmed(primitiveType, primitiveCount, {
                data: guestMem, offset: vertexDataPtr, stride, count: srcVertexCount,
            }, UP_STREAM_SLOTS);
        }
        if (this.scrubbedOut()) return 0;

        const fvf = this.stateTracker.getFVF();
        const device = this.backend.getDevice()!;

        if (this.npatchMode > 1.0) {
            if (primitiveType !== D3DPT_TRIANGLELIST) return d3d9DropDraw("drawPrimitiveUP:npatchTopology");
            if (!Number.isSafeInteger(vertexDataPtr) || vertexDataPtr < 0 || stride <= 0
                || !isValidAddress(guestMem, vertexDataPtr, primitiveCount * 3 * stride)) {
                return d3d9DropDraw("drawPrimitiveUP:npatchRange");
            }
            const source = guestMem.subarray(vertexDataPtr, vertexDataPtr + primitiveCount * 3 * stride);
            return this.drawNpatchSource(source, stride, primitiveCount);
        }

        // Point sprites: expand D3DPT_POINTLIST into sized quads (see tryDrawPointSprites). The
        // point count equals primitiveCount for a point list. Falls through only if the
        // programmable/declaration or FFP lowering could not validate the source payload.
        if (primitiveType === D3DPT_POINTLIST) {
            if (!isValidAddress(guestMem, vertexDataPtr, primitiveCount * stride)) {
                return d3d9DropDraw("drawPrimitiveUP:range");
            }
            const srcBytes = guestMem.subarray(vertexDataPtr, vertexDataPtr + primitiveCount * stride);
            if (this.isProgrammable() && this.tryDrawProgrammablePointList(
                srcBytes, primitiveCount, stride, 0, UP_STREAM_SLOTS,
            )) return 0;
            return this.tryDrawPointSprites(srcBytes, primitiveCount, stride, fvf)
                ? 0 : d3d9DropDraw("drawPrimitiveUP:pointListUnsupported");
        }

        // Read source vertices from memory
        const srcData = this.memory.subarray(vertexDataPtr, vertexDataPtr + sourceByteLen);

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

        const isLine = primitiveType === D3DPT_LINELIST || primitiveType === D3DPT_LINESTRIP;
        const topology = isLine ? "line-list" : "triangle-list";
        const forceCullNone = topology === "line-list";

        // Preserve cull for converted triangle lists (the conversion keeps D3D winding); line
        // lists have no face and continue to use the explicit cull-none pipeline variant.
        let pipelineId: number;
        let resolvedArenaRecord: PendingArenaRecord | null = null;
        let bindStateIndex: number | undefined;
        let ffpStateIndex: number | undefined;
        // A *UP draw supplies its vertices inline; D3D9 reads no bound stream for it, so the
        // pipeline declares slot 0 alone even when the declaration spans more — and the draw
        // binds exactly that slot.
        if (this.isProgrammable()) {
            pipelineId = this.resolveProgrammablePipeline(
                topology, forceCullNone, stride, UP_STREAM_SLOTS, false,
                (primitiveType === D3DPT_TRIANGLELIST || primitiveType === D3DPT_LINELIST)
                    ? { kind: "up", topology: isLine ? 2 : 0, vertexCount: finalVertexCount, guestVertexPtr: vertexDataPtr, stride, byteLen: finalVertexCount * stride, forceCullNone }
                    : undefined,
            );
            const arenaRecord = this.takePendingArenaRecord();
            if (pipelineId < 0) {
                if (arenaRecord) d3d9WasmArena.rollback(arenaRecord.checkpoint);
                return 0;
            }
            bindStateIndex = this.captureDrawState();
            // Kept in a wider scope below so the shared pooled buffer can be uploaded by the
            // executor from the arena capture, instead of through RenderFrame's copy path.
            resolvedArenaRecord = arenaRecord;
        } else {
            pipelineId = this.getPipelineIdForTopology(topology, forceCullNone, stride, UP_STREAM_SLOTS);
            if (pipelineId < 0) {
                return d3d9DropDraw("up:noPipeline");
            }
            ffpStateIndex = this.captureFfpDrawState(UP_STREAM_SLOTS);
        }

        // The buffer is pooled for RenderFrame compatibility. Arena-authoritative draws leave
        // it unwritten here; the executor fills this same buffer from the captured bump bytes.
        const bufferSize = Math.max(16, finalData.byteLength);
        if (!this.vbPool) this.vbPool = new DynamicVbPool(device);
        const gpuBuffer = this.vbPool.acquire(bufferSize);
        if (!resolvedArenaRecord) device.queue.writeBuffer(gpuBuffer, 0, finalData);

        this.streamPlan.reset();
        this.streamPlan.add(0, gpuBuffer, 0, finalData.byteLength);
        this.commandRecorder.recordDraw({
            pipelineId,
            streams: this.streamPlan,
            vertexCount: finalVertexCount,
            startVertex: 0,
            bindStateIndex,
            ffpStateIndex,
            scissorRect: this.getScissorRectForDraw(),
            viewport: this.viewport,
            stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
            blendConstant: this.getRS(D3DRS_BLENDFACTOR) >>> 0,
        });
        const arenaLinked = this.linkArenaDraw(
            resolvedArenaRecord?.commandStart ?? -1, resolvedArenaRecord?.key, pipelineId, bindStateIndex,
            resolvedArenaRecord?.identity.words, resolvedArenaRecord?.identity.key,
        );
        if (resolvedArenaRecord && !arenaLinked) device.queue.writeBuffer(gpuBuffer, 0, finalData);

        this.commandRecorder.registerPooledBuffer(gpuBuffer);

        this.drawCount += 1;


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
        if (this.npatchMode > 1.0) {
            // The bounded tessellator accepts contiguous non-indexed control points only.
            // Refuse indexed patches until control-point sharing and edge tessellation are
            // implemented, rather than silently drawing the un-tessellated source.
            return d3d9DropDraw("drawIndexedPrimitive:npatchUnsupported");
        }
        // SetStreamSourceFreq makes this an instanced draw: the dividers decide each slot's
        // step mode (baked into the pipeline layout, and into its key) and the INDEXEDDATA
        // stream carries the instance count. Divisor-one pairs use WebGPU's native instance
        // step mode; larger divisors are lowered to expanded per-instance records before draw.
        const instancing = planInstancing(this.streams.freq, this.activeSlotMask());
        if (instancing.refuse) return d3d9DropDraw(`drawIndexed:${instancing.refuse}`);
        if (primitiveType === D3DPT_POINTLIST) {
            if (instancing.instanced) return d3d9DropDraw("drawIndexed:pointListInstancingUnsupported");
            const streamSource = this.stateTracker.getStreamSource();
            const indexSource = this.stateTracker.getIndexSource();
            if (!streamSource || indexSource === null) return d3d9DropDraw("drawIndexed:pointListNoBuffer");
            const vbData = this.vertexBuffers.getData(streamSource.index);
            const ibData = this.indexBuffers.getData(indexSource);
            if (!vbData || !ibData) return d3d9DropDraw("drawIndexed:pointListNoBufferData");
            const indexIs32 = this.indexBuffers.getFormat(indexSource) !== D3DFMT_INDEX16;
            if (this.isProgrammable() && this.tryDrawIndexedProgrammablePointList(
                ibData,
                startIndex * (indexIs32 ? 4 : 2),
                indexIs32,
                primitiveCount,
                baseVertexIndex,
                minVertexIndex,
                numVertices,
                vbData,
                streamSource.offset,
                streamSource.stride,
                this.activeSlotMask(),
            )) return 0;
            const ok = this.tryDrawIndexedPointSprites(
                ibData,
                startIndex * (indexIs32 ? 4 : 2),
                indexIs32,
                primitiveCount,
                baseVertexIndex,
                minVertexIndex,
                numVertices,
                vbData,
                streamSource.offset,
                streamSource.stride,
                this.stateTracker.getFVF(),
            );
            return ok ? 0 : d3d9DropDraw("drawIndexed:pointListUnsupported");
        }
        if (instancing.instanced && primitiveType !== D3DPT_TRIANGLELIST) {
            // The strip/fan converter repacks ONE instance's worth of indices on the CPU.
            return d3d9DropDraw("drawIndexed:instancingNonListTopology");
        }
        // An indexed TRIANGLESTRIP is drawn as a strip. The CPU rewind below exists for the
        // FAN (WebGPU has no such topology) and for the extra-stream repack; applying it to
        // strips as well gathers three vertices per triangle and uploads them every frame.
        const nativeStrip = primitiveType === D3DPT_TRIANGLESTRIP
            && !instancing.instanced
            && this.canDrawIndexedStripNatively(minVertexIndex, numVertices);
        if (primitiveType !== D3DPT_TRIANGLELIST && !nativeStrip) {
            return this.drawIndexedStreamAsTriangleList(primitiveType, baseVertexIndex, startIndex, primitiveCount);
        }
        const topology: D3D9DrawTopology = nativeStrip ? "triangle-strip" : "triangle-list";
        // A strip spans primitiveCount + 2 indices; a list spans 3 per triangle.
        const indexCount = nativeStrip ? primitiveCount + 2 : primitiveCount * 3;
        // The arena treats this as an opaque identity field, so a distinct number is all a
        // strip needs to keep its pipeline key apart from the list's.
        const arenaTopology = nativeStrip ? 5 : 0;
        const streamSource = this.stateTracker.getStreamSource();
        if (!streamSource) return d3d9DropDraw("drawIndexed:noStreamSource");
        const indexSource = this.stateTracker.getIndexSource();
        if (indexSource === null) return d3d9DropDraw("drawIndexed:noIndexSource");

        const vbIndex = streamSource.index;
        const ibIndex = indexSource;
        const vbData = this.vertexBuffers.getData(vbIndex);
        const ibData = this.indexBuffers.getData(ibIndex);
        if (!vbData || !ibData) return d3d9DropDraw("drawIndexed:noBufferData");

        const ordinaryProfile = (globalThis as { __d3d9CompactProfile?: boolean })
            .__d3d9CompactProfile === true;
        const ordinaryStarted = ordinaryProfile ? performance.now() : 0;
        let ordinaryPhaseStarted = ordinaryStarted;
        const device = this.backend.getDevice()!;
        const slotMask = this.activeSlotMask();
        const ibBuffer = this.uploadBufferVersion(ibIndex, ibData, "ib", device);
        if (ordinaryProfile) {
            this.ordinaryIndexedUploadMs += performance.now() - ordinaryPhaseStarted;
            ordinaryPhaseStarted = performance.now();
        }

        // D3D9 promises every index of this draw lies in [minVertexIndex, +numVertices), so
        // the bytes the GPU will fetch are known up front. WebGPU cannot check that itself for
        // an indexed draw — robust access silently substitutes zeros — so check it here or the
        // miss shows up only as geometry that never appears. See D3D9BufferPerf.
        const idxBytes = this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16 ? 2 : 4;
        const ibNeed = (startIndex + indexCount) * idxBytes;
        const ibBytes = this.indexBuffers.getSize(ibIndex);
        if (ibNeed > ibBytes) {
            // An over-long index range is the one case WebGPU does raise — and the rejection
            // invalidates the whole command buffer, not just this draw, so drop it here.
            d3d9PerfIndexRangeOOB(ibNeed - ibBytes);
            return d3d9DropDraw("drawIndexed:indexRangeOOB");
        }
        // No vertex-range check here: WebGPU validates a vertex range only for a NON-indexed
        // draw (the encoder enforces that one, where the pipeline's real stride is known).
        // An indexed draw gets robust access instead — an out-of-range fetch reads zero,
        // exactly what D3D9 hardware does with an undersized buffer — so dropping it would
        // delete geometry the hardware rasterizes.

        let pipelineId: number;
        let arenaRecord: PendingArenaRecord | null = null;
        let bindStateIndex: number | undefined;
        let ffpStateIndex: number | undefined;
        if (this.isProgrammable()) {
            pipelineId = this.resolveProgrammablePipeline(
                topology, false, undefined, slotMask, false,
                !instancing.instanced && baseVertexIndex >= 0 && slotMask === 1
                    ? { kind: "indexed", topology: arenaTopology, indexCount, startIndex, baseVertex: baseVertexIndex, stride: streamSource.stride, forceCullNone: false }
                    : undefined,
            );
            arenaRecord = this.takePendingArenaRecord();
            if (pipelineId < 0) {
                if (arenaRecord) d3d9WasmArena.rollback(arenaRecord.checkpoint);
                return d3d9DropDraw("drawIndexed:noPipeline");
            }
            if (ordinaryProfile) {
                this.ordinaryIndexedPipelineMs += performance.now() - ordinaryPhaseStarted;
                ordinaryPhaseStarted = performance.now();
            }
            bindStateIndex = this.captureDrawState();
            if (ordinaryProfile) {
                this.ordinaryIndexedCaptureMs += performance.now() - ordinaryPhaseStarted;
                ordinaryPhaseStarted = performance.now();
            }
        } else {
            // The list case keeps its own one-entry memo (getPipelineId); a strip asks for its
            // topology explicitly rather than teaching that memo a second key.
            pipelineId = nativeStrip
                ? this.getPipelineIdForTopology(topology, false, 0, slotMask)
                : this.getPipelineId(slotMask);
            if (pipelineId < 0) return d3d9DropDraw("drawIndexed:noPipeline");
            ffpStateIndex = this.captureFfpDrawState(slotMask);
        }
        // Slot 0 comes out of the same resolver as every other slot (its upload included).
        const plan = this.resolveDrawStreams(slotMask, device, instancing.instanceCount);
        const slot0 = plan.find(0);
        if (this.fetchAuditFramesLeft > 0 && slot0) {
            this.fetchAuditRecord(
                vbIndex, ibIndex, vbData, ibData, slot0.buffer, ibBuffer,
                streamSource.offset, streamSource.stride, baseVertexIndex, startIndex,
                indexCount, this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16,
            );
        }
        this.commandRecorder.recordDrawIndexed({
            pipelineId,
            streams: plan,
            ibGpuBuffer: ibBuffer,
            ibFormat: this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16 ? "uint16" : "uint32",
            indexCount,
            startIndex,
            baseVertex: baseVertexIndex,
            instanceCount: instancing.instanceCount,
            bindStateIndex,
            ffpStateIndex,
            scissorRect: this.getScissorRectForDraw(),
            viewport: this.viewport,
            stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
            blendConstant: this.getRS(D3DRS_BLENDFACTOR) >>> 0,
        });
        this.linkArenaDraw(
            arenaRecord?.commandStart ?? -1, arenaRecord?.key, pipelineId, bindStateIndex,
            arenaRecord?.identity.words, arenaRecord?.identity.key,
        );
        if (ordinaryProfile) {
            this.ordinaryIndexedRecordMs += performance.now() - ordinaryPhaseStarted;
        }
        this.drawCount += 1;

        // Update frame snapshot for debug panel
        this.frameSnapshot.drawCalls++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = {
            api: "d3d9",
            primitiveType,
            numVerts: numVertices,
            numIndices: indexCount,
            timestamp: performance.now(),
        };
        
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.vertexBytes += 
                (this.vertexBuffers.getSize(vbIndex) - streamSource.offset) +
                (this.indexBuffers.getSize(ibIndex) - startIndex * (this.indexBuffers.getFormat(ibIndex) === D3DFMT_INDEX16 ? 2 : 4));
        }
        if (ordinaryProfile) {
            this.ordinaryIndexedProfiled++;
            this.ordinaryIndexedHostMs += performance.now() - ordinaryStarted;
        }
        
        return 0;
    }

    /**
     * Consume an exact alternating WBUF run without re-entering the legacy TypeScript draw
     * path per pair. The dispatcher calls this before either entry handler has run; false is
     * therefore a strict decline and causes ordinary replay from the original first entry.
     */
    tryDrawIndexedWbufRun(
        mem32: Uint32Array, startPtr: number, endPtr: number, pairCount: number,
        prefixConstantPtr?: number, prefixDrawPtr?: number,
    ): boolean {
        const phaseProfile = (globalThis as { __d3d9CompactProfile?: boolean })
            .__d3d9CompactProfile === true;
        const tryStarted = phaseProfile ? performance.now() : 0;
        if ((globalThis as { __noD3D9ArenaRuns?: boolean }).__noD3D9ArenaRuns === true
            || pairCount < 2 || this.gpuGone || frameCapture.isCapturing()
            || this.recordingStateBlock || this.softwareVertexProcessing
            || this.npatchMode > 1.0 || this.scrubbedOut()
            || !d3d9WasmArena.supportsWbufIndexedRuns()) return false;

        const startWord = startPtr >> 2;
        const vsFuncId = mem32[startWord] >>> 0;
        const devicePtr = mem32[startWord + 1] >>> 0;
        const startRegister = mem32[startWord + 2] >>> 0;
        const vecCount = mem32[startWord + 3] >>> 0;
        if (devicePtr === 0 || vecCount === 0 || vecCount > 256) return false;
        const constantStride = (4 + vecCount * 4) * 4;
        const drawPtr = startPtr + constantStride;
        if (drawPtr + 32 > endPtr) return false;
        const drawWord = drawPtr >> 2;
        const drawFuncId = mem32[drawWord] >>> 0;
        if (mem32[drawWord + 1] >>> 0 !== devicePtr || mem32[drawWord + 2] !== D3DPT_TRIANGLELIST) return false;

        let prefixVsBits: Uint32Array | undefined;
        if (prefixConstantPtr !== undefined || prefixDrawPtr !== undefined) {
            if (prefixConstantPtr === undefined || prefixDrawPtr === undefined) return false;
            const pcw = prefixConstantPtr >> 2;
            const pdw = prefixDrawPtr >> 2;
            if ((mem32[pcw] >>> 0) !== vsFuncId
                || (mem32[pcw + 1] >>> 0) !== devicePtr
                || (mem32[pcw + 2] >>> 0) !== startRegister
                || (mem32[pcw + 3] >>> 0) !== vecCount
                || (mem32[pdw] >>> 0) !== drawFuncId
                || (mem32[pdw + 1] >>> 0) !== devicePtr
                || mem32[pdw + 2] !== D3DPT_TRIANGLELIST) return false;
            // Geometry must be identical: one physical instanced draw replays both sources.
            for (let word = 3; word <= 7; word++) {
                if ((mem32[pdw + word] >>> 0) !== (mem32[drawWord + word] >>> 0)) return false;
            }
            prefixVsBits = mem32.slice(pcw + 4, pcw + 4 + vecCount * 4);
        }
        const prefixCount = prefixVsBits ? 1 : 0;

        // Only the dominant single-stream, non-instanced programmable list shape is
        // accepted. Every excluded shape resumes unchanged.
        if (!this.isProgrammable() || this.getActivePsShader() === null
            || this.activeDeclIsPreTransformed() || this.activeSlotMask() !== 1
            || !this.arenaCanRepresentCurrentSamplerBank()) return false;
        const vs = this.getActiveVsShader();
        const ps = this.getActivePsShader();
        if (!vs || !ps || shaderUsesIntegerBoolean(vs.prog) || shaderUsesIntegerBoolean(ps.prog)) return false;
        const instancing = planInstancing(this.streams.freq, 1);
        if (instancing.refuse || instancing.instanced || instancing.instanceCount !== 1) return false;

        const streamSource = this.stateTracker.getStreamSource();
        const indexSource = this.stateTracker.getIndexSource();
        if (!streamSource || indexSource === null || streamSource.stride <= 0) return false;
        const vbData = this.vertexBuffers.getData(streamSource.index);
        const ibData = this.indexBuffers.getData(indexSource);
        if (!vbData || !ibData) return false;

        // Preflight every GPU-visible index range. Rust independently validates the packet
        // grammar and device/range invariants before mutating the arena transaction.
        const indexBytes = this.indexBuffers.getFormat(indexSource) === D3DFMT_INDEX16 ? 2 : 4;
        const ibSize = this.indexBuffers.getSize(indexSource);
        const pairStride = constantStride + 32;
        let compactMode = (globalThis as { __d3d9CompactMegaRun?: boolean })
            .__d3d9CompactMegaRun !== false ? 2
            : (globalThis as { __d3d9CompactMegaRunShadow?: boolean })
                .__d3d9CompactMegaRunShadow === true ? 1 : 0;
        let packetPtr = startPtr;
        let lastDrawWord = drawWord;
        if (compactMode === 2) {
            const runBytes = pairStride * pairCount;
            if (!Number.isSafeInteger(runBytes) || runBytes <= 0
                || startPtr + runBytes !== endPtr) return false;
            packetPtr = endPtr;
            lastDrawWord = (endPtr - 32) >> 2;
        } else {
            for (let pair = 0; pair < pairCount; pair++, packetPtr += pairStride) {
                const cw = packetPtr >> 2;
                const dw = (packetPtr + constantStride) >> 2;
                if (packetPtr + pairStride > endPtr || mem32[cw] !== vsFuncId
                    || mem32[cw + 1] !== devicePtr || mem32[cw + 2] !== startRegister
                    || mem32[cw + 3] !== vecCount || mem32[dw] !== drawFuncId
                    || mem32[dw + 1] !== devicePtr || mem32[dw + 2] !== D3DPT_TRIANGLELIST
                    || (mem32[dw + 3] | 0) < 0) return false;
                const primitiveCount = mem32[dw + 7] >>> 0;
                if (primitiveCount === 0 || primitiveCount > 0x55555555) return false;
                const indexCount = primitiveCount * 3;
                const startIndex = mem32[dw + 6] >>> 0;
                if (startIndex > Math.floor(ibSize / indexBytes) - indexCount) return false;
                lastDrawWord = dw;
            }
        }
        if (packetPtr !== endPtr) return false;

        // Resolve heavyweight host identities and generation-safe resources once while the
        // arena is still untouched. A later Rust decline only rewinds this pooled state slot;
        // queued buffer uploads are harmless and are reused by the fallback draw path.
        let phaseStarted = phaseProfile ? performance.now() : 0;
        const fullStateKey = this.stateTracker.computePipelineKey() >>> 0;
        const identityCacheEnabled = (globalThis as { __d3d9CompactPipelineIdentityCache?: boolean })
            .__d3d9CompactPipelineIdentityCache !== false;
        const compactPipelineKey = identityCacheEnabled
            ? this.compactPipelineFastKey(fullStateKey, streamSource.stride)
            : undefined;
        const compactPipelineHit = compactPipelineKey === undefined
            ? undefined
            : this.compactPipelineIdentityCache.get(compactPipelineKey);
        let pipelineId = compactPipelineHit?.pipelineId ?? -1;
        let identity = compactPipelineHit?.identity;
        if (compactPipelineHit !== undefined) {
            this.compactPipelineIdentityHits++;
            pipelineId = this.programmablePipelineResult(pipelineId, false);
        } else {
            this.compactPipelineIdentityMisses++;
            pipelineId = this.resolveProgrammablePipeline(
                "triangle-list", false, undefined, 1, false, undefined, false,
            );
        }
        if (pipelineId < 0) return false;
        identity ??= this.arenaIdentityByPipelineState.get(pipelineId)?.get(fullStateKey);
        if (identity === undefined) {
            identity = this.prepareArenaPipelineIdentity("triangle-list", false, undefined, 1, false);
            let stateMap = this.arenaIdentityByPipelineState.get(pipelineId);
            if (stateMap === undefined) {
                stateMap = new Map();
                this.arenaIdentityByPipelineState.set(pipelineId, stateMap);
            }
            stateMap.set(fullStateKey, identity);
        }
        if (compactPipelineKey !== undefined
            && !this.compactPipelineIdentityCache.has(compactPipelineKey)) {
            this.compactPipelineIdentityCache.set(compactPipelineKey, { pipelineId, identity });
            while (this.compactPipelineIdentityCache.size > ARENA_PIPELINE_CACHE_MAX_ENTRIES) {
                const oldest = this.compactPipelineIdentityCache.keys().next().value;
                if (oldest === undefined) break;
                this.compactPipelineIdentityCache.delete(oldest);
            }
        }
        d3d9WasmArena.setPipelineIdentity(identity.words);
        if (phaseProfile) this.wbufRunPipelineMs += performance.now() - phaseStarted;
        phaseStarted = phaseProfile ? performance.now() : 0;
        const gpuDevice = this.backend.getDevice();
        if (!gpuDevice) return false;
        const ibBuffer = this.uploadBufferVersion(indexSource, ibData, "ib", gpuDevice);
        const plan = this.resolveDrawStreams(1, gpuDevice, 1);
        if (!plan.find(0)) return false;
        if (phaseProfile) this.wbufRunResourcesMs += performance.now() - phaseStarted;
        phaseStarted = phaseProfile ? performance.now() : 0;
        const frame = this.commandRecorder.getCurrentFrame();
        const drawStateCountBefore = frame.drawStateCount;
        const bindStateIndex = compactMode === 2
            ? this.captureCompactDrawState(
                pipelineId, fullStateKey, startRegister * 4, vecCount * 4,
            )
            : this.captureDrawState();
        if (compactMode === 2
            && (globalThis as { __d3d9CompactMegaRunStorage?: boolean })
                .__d3d9CompactMegaRunStorage !== false) {
            const mega = this.backendExecutor.getPipelineInfo(pipelineId)?.megaBatch;
            const template = frame.drawStates[bindStateIndex];
            const slotWords = (mega?.vsSlotBytes ?? 0) >>> 2;
            if (template && slotWords > 0 && template.vsLen >= slotWords
                && d3d9WasmArena.setCompactRunTemplate(template.vsBits, slotWords)) {
                compactMode = 3;
            }
        }
        if (phaseProfile) this.wbufRunCaptureMs += performance.now() - phaseStarted;
        // Rust may reject after emitting a strict prefix of rows. Preserve both cursors so a
        // partial result is a real transaction rollback, not an invisible tail consumed by a
        // later run. Copy the arena's scratch checkpoint because callers must not retain it.
        const checkpoint = { ...d3d9WasmArena.checkpoint() };
        const commandStart = checkpoint.commandCount;
        const recordStarted = phaseProfile ? performance.now() : 0;
        const recorded = d3d9WasmArena.recordWbufIndexedRun(
            startPtr, endPtr - startPtr, vsFuncId, drawFuncId, devicePtr,
            streamSource.stride, false, compactMode, Math.floor(ibSize / indexBytes),
        );
        if (phaseProfile) this.wbufRunRecordMs += performance.now() - recordStarted;
        if (recorded !== pairCount) {
            d3d9WasmArena.rollback(checkpoint);
            if (frame.drawStateCount > drawStateCountBefore) {
                // The slot goes back to the pool; a memo still naming it would bind
                // whatever draw is captured into it next.
                frame.rollbackDrawState();
                this.lastCaptureIndex = -1;
                this.compactCaptureCache.clear();
            }
            return false;
        }
        const commandEnd = d3d9WasmArena.getCommandCount();
        let compactDescriptorOffset = -1;
        if (compactMode !== 0) {
            compactDescriptorOffset = d3d9WasmArena.getLastWbufCompactOffset();
            let parity = compactDescriptorOffset >= 0;
            let storageReady = compactMode === 3;
            // Shadow mode is the bit-exact oracle. Authoritative mode is decoded and fully
            // bounds-checked by the executor before GPU use, so repeating the same object-
            // allocating decode here buys no extra correctness. Keep it available as a
            // producer-side ABI oracle for diagnostics and bring-up of future revisions.
            const verifyProducer = compactMode === 1
                || (globalThis as { __d3d9CompactProducerVerify?: boolean })
                    .__d3d9CompactProducerVerify === true;
            if (verifyProducer) {
                try {
                    const compact = d3d9WasmArena.readCompactWbufRun(compactDescriptorOffset);
                    storageReady = compact.storageReady;
                    parity = parity && compact.pairCount === pairCount
                        && compact.startRegister === startRegister
                        && compact.floatCount === vecCount * 4
                        && compact.indexCount === (mem32[drawWord + 7]! >>> 0) * 3
                        && compact.startIndex === (mem32[drawWord + 6]! >>> 0)
                        && compact.baseVertex === (mem32[drawWord + 3]! | 0);
                    if (compactMode === 1) {
                        for (let pair = 0; parity && pair < pairCount; pair++) {
                            const source = ((startPtr + pair * pairStride) >> 2) + 4;
                            const target = pair * compact.floatCount;
                            for (let word = 0; word < compact.floatCount; word++) {
                                if ((mem32[source + word]! >>> 0) !== compact.payloadBits[target + word]) {
                                    parity = false;
                                    break;
                                }
                            }
                        }
                    }
                } catch {
                    parity = false;
                }
            }
            if (parity) {
                if (compactMode === 1) this.compactShadowDescriptors++;
                else {
                    this.compactAuthoritativeRuns++;
                    if (storageReady) this.compactStorageRuns++;
                }
            }
            else {
                this.compactShadowParityFailures++;
                compactDescriptorOffset = -1;
            }
            // Authoritative compact recording has no legacy rows to replay. A malformed or
            // missing descriptor must therefore decline the whole fusion before RenderFrame
            // publication; otherwise the executor would observe a committed zero-row run.
            if (compactMode >= 2 && compactDescriptorOffset < 0) {
                d3d9WasmArena.rollback(checkpoint);
                if (frame.drawStateCount > drawStateCountBefore) {
                    frame.rollbackDrawState();
                    this.lastCaptureIndex = -1;
                    this.compactCaptureCache.clear();
                }
                return false;
            }
        }

        phaseStarted = phaseProfile ? performance.now() : 0;
        // Publish the run's final API state to the TypeScript mirror. Intermediate values
        // already live in capture-at-call arena slots and are replayed by the executor.
        const lastConstantDataPtr = endPtr - 32 - constantStride + 4;
        // recordWbufIndexedRun already committed the final pair to the arena mirror.
        this.setVertexShaderConstantFFromWbufRing(mem32, lastConstantDataPtr, true);
        if ((globalThis as { __d3d9BatchRunAccounting?: boolean })
            .__d3d9BatchRunAccounting !== false) {
            d3d9PerfAdd("setVertexShaderConstantF", pairCount - 1);
            d3d9PerfAdd("drawIndexedPrimitive", pairCount + prefixCount);
        } else {
            for (let pair = 1; pair < pairCount; pair++) d3d9PerfInc("setVertexShaderConstantF");
            for (let pair = 0; pair < pairCount + prefixCount; pair++) d3d9PerfInc("drawIndexedPrimitive");
        }
        // Draw attribution is the commit marker: no speculative resolver/cache hit above has
        // changed these counters, so every false return leaves noteProgrammableDraw accounting
        // untouched and every accepted run publishes its full logical work exactly once.
        this.noteProgrammableDraws(pipelineId, pairCount + prefixCount);

        this.commandRecorder.recordDrawIndexedArenaRun({
            pipelineId,
            streams: plan,
            ibGpuBuffer: ibBuffer,
            ibFormat: indexBytes === 2 ? "uint16" : "uint32",
            bindStateIndex,
            arenaCommandStart: commandStart,
            arenaCommandEnd: commandEnd,
            pairCount,
            compactDescriptorOffset,
            prefixVsBits,
            prefixStartFloat: startRegister * 4,
            scissorRect: this.getScissorRectForDraw(),
            viewport: this.viewport,
            stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
            blendConstant: this.getRS(D3DRS_BLENDFACTOR) >>> 0,
        });
        this.drawCount += pairCount + prefixCount;
        this.frameSnapshot.drawCalls += pairCount + prefixCount;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = {
            api: "d3d9",
            primitiveType: D3DPT_TRIANGLELIST,
            numVerts: mem32[lastDrawWord + 5] >>> 0,
            numIndices: (mem32[lastDrawWord + 7] >>> 0) * 3,
            timestamp: performance.now(),
        };
        if (phaseProfile) this.wbufRunPublishMs += performance.now() - phaseStarted;
        this.wbufRunAccepted++;
        if (phaseProfile) this.wbufRunTryMs += performance.now() - tryStarted;
        return true;
    }

    private lastActualPresent = 0;

    /**
     * D3DPRESENT_PARAMETERS.PresentationInterval, as refreshes to hold each Present.
     * We advertise IMMEDIATE|ONE|TWO|THREE|FOUR in D3DCAPS9.PresentationIntervals, so the
     * app's choice has to reach the pacer. Re-declared by every CreateDevice/Reset.
     */
    private presentInterval = PRESENT_INTERVAL_ONE;
    /** D3DPRESENT_PARAMETERS.SwapEffect, re-declared by CreateDevice/Reset. */
    private swapEffect = D3DSWAPEFFECT_DISCARD;

    setPresentationInterval(rawInterval: number): void {
        this.presentInterval = decodeD3DPresentInterval(rawInterval);
    }

    setSwapEffect(rawSwapEffect: number): void {
        this.swapEffect = rawSwapEffect >>> 0;
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
        if (this.renderTargetIndices.some(index => index !== null)) {
            this.submitFrame(false);
            this.renderTargetIndices.fill(null);
            this.renderTargetFaces.fill(-1);
            this.currentRtIndex = null;
            this.currentRtFace = -1;
            this.invalidateLastResolve();
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

    /** D3D9Ex PresentEx control-plane seam.  DONOTWAIT is observable: when the current
     * command batch still has work, return WASSTILLDRAWING instead of silently entering the
     * ordinary throttled Present path.  The remaining documented flags only describe the
     * content/monitor policy and are harmless for this single-output presenter. */
    async presentEx(flags: number): Promise<number> {
        const known = 0x1f; // D3DPRESENT_DONOTWAIT plus the Ex content/monitor flags
        if ((flags >>> 0) & ~known) return 0x8876086c; // D3DERR_INVALIDCALL
        if ((flags & 0x1) !== 0 && this.hasPendingWork()) return 0x8876021c;
        return this.present();
    }

    /** PNG of the screen (canvas, post-fx and every overlay included); the executor's
     *  own readback of the presented offscreen is the fallback. */
    async captureFrame(): Promise<Blob> {
        const screen = await System.getInstance().services.render.tryCaptureScreen();
        if (screen) return screen;
        // The fallback refuses when there is no complete frame; an empty Blob is the
        // contract's "no image", which every caller already reports as a failed capture.
        try {
            return (await this.capturePresentedLayer()) ?? new Blob();
        } catch {
            return new Blob();
        }
    }

    /** The presented swap-chain image — the 3D frame before it reaches the canvas.
     *  Throws (never a black stand-in) when no complete frame has been presented. */
    async capturePresentedLayer(): Promise<Blob | null> {
        this.submitFrame(false);
        return this.backendExecutor.captureFrame();
    }

    /** Raw RGBA8 readback for GetFrontBufferData when image codecs are unavailable. */
    async readPresentedRgba(): Promise<{ rgba: Uint8Array; width: number; height: number } | null> {
        this.submitFrame(false);
        try {
            return await this.backendExecutor.readPresentedRgba();
        } catch {
            return null;
        }
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
            bindGroupBuilds: executorMetrics.bindGroupBuilds,
        };
    }

    /** Task A perf: subsystem counters not tracked on the API hot path. */
    collectSubsystemPerf(): {
        stateTracker: ReturnType<D3D9StateTracker["getMetrics"]>;
        backend: ReturnType<D3D9BackendExecutor["getMetrics"]> & Record<string, number>;
    } {
        const backend = {
            ...this.backendExecutor.getMetrics(),
            wbufRunAccepted: this.wbufRunAccepted,
            wbufRunTryMs: this.wbufRunTryMs,
            wbufRunRecordMs: this.wbufRunRecordMs,
            compactShadowDescriptors: this.compactShadowDescriptors,
            compactShadowParityFailures: this.compactShadowParityFailures,
            compactAuthoritativeRuns: this.compactAuthoritativeRuns,
            compactStorageRuns: this.compactStorageRuns,
            wbufRunPipelineMs: this.wbufRunPipelineMs,
            wbufRunResourcesMs: this.wbufRunResourcesMs,
            wbufRunCaptureMs: this.wbufRunCaptureMs,
            wbufRunPublishMs: this.wbufRunPublishMs,
            ordinaryIndexedProfiled: this.ordinaryIndexedProfiled,
            ordinaryIndexedHostMs: this.ordinaryIndexedHostMs,
            ordinaryIndexedUploadMs: this.ordinaryIndexedUploadMs,
            ordinaryIndexedPipelineMs: this.ordinaryIndexedPipelineMs,
            ordinaryIndexedCaptureMs: this.ordinaryIndexedCaptureMs,
            ordinaryIndexedRecordMs: this.ordinaryIndexedRecordMs,
            compactCaptureReuseHits: this.compactCaptureReuseHits,
            compactCaptureReuseMisses: this.compactCaptureReuseMisses,
            compactPipelineIdentityHits: this.compactPipelineIdentityHits,
            compactPipelineIdentityMisses: this.compactPipelineIdentityMisses,
        };
        return {
            stateTracker: this.stateTracker.getMetrics(),
            backend: this.megaBatchCensus
                ? { ...backend, ...d3d9MegaBatchCensusMetrics(this.megaBatchCensus) }
                : backend,
        };
    }

    resetSubsystemPerf(): void {
        this.stateTracker.resetMetrics();
        this.backendExecutor.resetMetrics();
        this.megaBatchCensus = null;
        this.wbufRunAccepted = 0;
        this.wbufRunTryMs = 0;
        this.wbufRunRecordMs = 0;
        this.compactShadowDescriptors = 0;
        this.compactShadowParityFailures = 0;
        this.compactAuthoritativeRuns = 0;
        this.compactStorageRuns = 0;
        this.wbufRunPipelineMs = 0;
        this.wbufRunResourcesMs = 0;
        this.wbufRunCaptureMs = 0;
        this.wbufRunPublishMs = 0;
        this.ordinaryIndexedProfiled = 0;
        this.ordinaryIndexedHostMs = 0;
        this.ordinaryIndexedUploadMs = 0;
        this.ordinaryIndexedPipelineMs = 0;
        this.ordinaryIndexedCaptureMs = 0;
        this.ordinaryIndexedRecordMs = 0;
        this.compactCaptureReuseHits = 0;
        this.compactCaptureReuseMisses = 0;
        this.compactPipelineIdentityHits = 0;
        this.compactPipelineIdentityMisses = 0;
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
        // The shared decoder handles DXT/BC blocks as well as plain pixels. Keeping BC
        // textures on the GPU-readback fallback is misleading: copyTextureToBuffer returns
        // compressed blocks, while that fallback interprets them as RGBA rows.
        decodeD3DTextureToRgba8(data, 0, w, h, format, { pitch: this.textures.getPitch(index), out: rgba });
        return { rgba, w, h, format };
    }

    /**
     * Copy/scale a surface on the GPU (IDirect3DDevice9::StretchRect). `null` is the
     * implicit backbuffer; explicit surfaces resolve to their parent texture in the
     * module layer. Pending draws are flushed first so the copy observes strict D3D
     * command ordering.
     */
    stretchRect(
        src: { texturePtr: number; face: number; width: number; height: number; multiSampleType?: number; offscreenPlain?: boolean } | null,
        dst: { texturePtr: number; face: number; width: number; height: number; multiSampleType?: number; offscreenPlain?: boolean } | null,
        srcRect: { left: number; top: number; right: number; bottom: number },
        dstRect: { left: number; top: number; right: number; bottom: number },
        linear: boolean,
    ): boolean | Promise<boolean> {
        // Sampling and attaching the same subresource in one render pass is invalid in
        // WebGPU and invalid for StretchRect on D3D9 as well.
        if (!src && !dst) return false;
        if (src && dst && src.texturePtr === dst.texturePtr && src.face === dst.face) return false;
        // The module layer has already validated this policy, but keep the backend seam
        // defensive for direct callers: the TextureStore view is the resolved single-sample
        // target, while a multisample destination has no legal textured-quad attachment.
        const sourceSampleCount = src?.multiSampleType === undefined
            ? 1
            : ((src.multiSampleType >>> 0) === 0 ? 1 : (d3d9MsaaSampleCount(src.multiSampleType) ?? 0));
        const destinationSampleCount = dst?.multiSampleType === undefined
            ? 1
            : ((dst.multiSampleType >>> 0) === 0 ? 1 : (d3d9MsaaSampleCount(dst.multiSampleType) ?? 0));
        if (sourceSampleCount === 0 || destinationSampleCount === 0 || destinationSampleCount > 1) return false;

        // DXVK permits a single-sample render-target source to be copied into a
        // DEFAULT offscreen-plain destination.  The destination is CPU-readable
        // in this backend, so use the same GPU readback/CPU scaler as
        // GetRenderTargetData rather than pretending the plain texture is a
        // render attachment.  MSAA and cube-face sources remain refused until
        // their resolve/readback ownership is explicit.
        if (src?.offscreenPlain !== true && dst?.offscreenPlain === true) {
            if (!src || src.face >= 0 || sourceSampleCount !== 1) return false;
            const dstIndex = this.textures.getIndex(dst.texturePtr);
            if (dstIndex === null || this.textures.isRenderTarget(dstIndex)) return false;
            const destinationPixels = this.getTextureLevelPixels(dst.texturePtr, 0);
            if (!destinationPixels) return false;
            return this.readRenderTargetRgba(src.texturePtr).then((sourcePixels) => {
                if ('err' in sourcePixels) return false;
                const copied = copyD3D9SurfaceRectCpu(
                    {
                        data: sourcePixels.rgba,
                        pitch: sourcePixels.w * 4,
                        width: sourcePixels.w,
                        height: sourcePixels.h,
                        format: 32, // A8B8G8R8 byte order matches WebGPU RGBA8 readback
                    },
                    {
                        ...destinationPixels,
                        format: this.textures.getFormat(dstIndex),
                    },
                    srcRect,
                    dstRect,
                    linear,
                );
                return !!copied && this.setTextureLevelPixels(
                    dst.texturePtr,
                    0,
                    destinationPixels.data,
                    destinationPixels.pitch,
                );
            });
        }

        // DEFAULT offscreen-plain surfaces are backed by CPU shadows rather than
        // render-attachment textures.  Their legal StretchRect path is therefore
        // a synchronous rect-local decode/scale/encode; this also covers format
        // conversion without pretending an ordinary sampled texture is attachable.
        if (src && dst && src.face < 0 && dst.face < 0 &&
            sourceSampleCount === 1 && destinationSampleCount === 1) {
            const sourcePixels = this.getTextureLevelPixels(src.texturePtr, 0);
            const destinationPixels = this.getTextureLevelPixels(dst.texturePtr, 0);
            if (sourcePixels && destinationPixels &&
                !this.textures.isRenderTarget(this.textures.getIndex(src.texturePtr) ?? -1) &&
                !this.textures.isRenderTarget(this.textures.getIndex(dst.texturePtr) ?? -1)) {
                const copied = copyD3D9SurfaceRectCpu(
                    { ...sourcePixels, format: this.textures.getFormat(this.textures.getIndex(src.texturePtr)!) },
                    { ...destinationPixels, format: this.textures.getFormat(this.textures.getIndex(dst.texturePtr)!) },
                    srcRect,
                    dstRect,
                    linear,
                );
                if (copied && this.setTextureLevelPixels(dst.texturePtr, 0, destinationPixels.data, destinationPixels.pitch)) {
                    return true;
                }
            }
        }

        this.submitFrame(false);
        const resolve = (surface: NonNullable<typeof src>):
            { view: GPUTextureView; width: number; height: number } | null => {
            const index = this.textures.getIndex(surface.texturePtr);
            if (index === null) return null;
            this.ensureTexture(index);
            const view = this.textures.isCubeMap(index)
                ? this.getCubeFaceRenderView(index, surface.face, 0)
                : this.textures.getView(index);
            return view ? { view, width: surface.width, height: surface.height } : null;
        };

        const source = src ? resolve(src) : null;
        const destination = dst ? resolve(dst) : null;
        if ((src && !source) || (dst && !destination)) return false;
        return this.backendExecutor.stretchRect(source, destination, srcRect, dstRect, linear);
    }

    /**
     * D3D9 ColorFill against an OFFSCREEN surface (an RT texture, or a plain one with a
     * guest-side store) — the `Clear`-on-the-backbuffer shortcut cannot express it.
     *
     * A game that composes its 2D layer into a texture and blits it as one quad erases that
     * layer with ColorFill, not Clear. Dropping the fill leaves every frame's UI painted on
     * top of the last, so text and cursors smear along whatever path they took.
     *
     * Returns false when the target/format is not attachable or the request is outside the
     * single-sample color-fill seam; the caller reports that rather than pretending it happened.
     */
    colorFillSurface(texturePtr: number, rect: { left: number; top: number; right: number; bottom: number } | null, color: number): boolean {
        if ((texturePtr >>> 0) === 0) {
            const size = this.backendExecutor.getCanvasSize();
            if (size.width <= 0 || size.height <= 0) return false;
            const effectiveRect = rect ?? { left: 0, top: 0, right: size.width, bottom: size.height };
            // Flush preceding draws before the direct offscreen fill, preserving command order
            // even when ColorFill targets a sub-rect of the implicit backbuffer.
            this.submitFrame(false);
            return this.backendExecutor.colorFillBackbufferRect(effectiveRect, d3dColorToGpu(color));
        }
        const index = this.textures.getIndex(texturePtr >>> 0);
        if (index === null) return false;
        const w = this.textures.getWidth(index), h = this.textures.getHeight(index);
        if (w <= 0 || h <= 0) return false;
        const full = !rect || (rect.left <= 0 && rect.top <= 0 && rect.right >= w && rect.bottom >= h);

        const gpuTex = this.textures.getGpuTexture(index);
        if (this.textures.isRenderTarget(index) || (gpuTex && !this.textures.getData(index))) {
            if (!gpuTex) return false;
            const device = this.backend.getDevice();
            const queue = this.backend.getQueue();
            if (!device || !queue) return false;
            // Order matters: everything recorded up to this call must land BEFORE the fill,
            // exactly as the guest issued it.
            this.submitFrame(false);
            const targetFormat = this.renderTargetGpuFormats.get(index) ?? this.backend.getFormat();
            if (!targetFormat) return false;
            if (!full) {
                return this.backendExecutor.colorFillRect(
                    gpuTex.createView(), targetFormat, w, h,
                    rect ?? { left: 0, top: 0, right: w, bottom: h },
                    d3dColorToGpu(color),
                );
            }
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
        const pitch = this.textures.getPitch(index);
        const x0 = Math.max(0, rect?.left ?? 0), y0 = Math.max(0, rect?.top ?? 0);
        const x1 = Math.min(w, rect?.right ?? w), y1 = Math.min(h, rect?.bottom ?? h);
        const b = color & 0xff, g = (color >>> 8) & 0xff, r = (color >>> 16) & 0xff, a = (color >>> 24) & 0xff;
        // Keep ColorFill on the same exact destination encoder as StretchRect. Exotic
        // and palettized layouts still refuse before touching the guest store.
        if (!isD3D9CpuCopyDestinationFormat(format)) return false;
        const bytesPerPixel = pitch / Math.max(1, w);
        if (!Number.isInteger(bytesPerPixel) || bytesPerPixel <= 0) return false;
        const pixel = [r, g, b, a];
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const offset = y * pitch + x * bytesPerPixel;
                if (!writeD3D9Pixel(format, data, offset, pixel)) return false;
            }
        }
        this.textures.setDirty(index, true);
        this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
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
        try {
            const rgba = await readGpuTextureRgba(device, queue, gpuTex, w, h);
            return { rgba, w, h, format: this.textures.getFormat(index) };
        } catch (e) {
            return { err: `render-target readback failed: ${e}` };
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
    private buildPipelineKey(): number {
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

        // Do not mix a hash or topology marker into this numeric value.  The bits are decoded
        // below to select the FFP lighting and cull variants, so perturbing them changes the
        // actual render state (for example default Gouraud/CCW becomes an arbitrary cull mode).
        // Fill/shade and topology are already present in the string cache fragments and are
        // validated before this key is consumed.
        return key >>> 0;
    }

    /** Bound render-state reader for the blend/depth/alpha-test helpers — and the single
     *  place the diagnostic toggles below take effect. Every one of those helpers feeds BOTH
     *  the pipeline descriptor and its cache-key fragment (computeBlendKey/computeDepthKey/
     *  alphaTestKey), so overriding here re-keys the caches too and a flipped toggle cannot
     *  silently reuse a pipeline built under the opposite setting. */
    private getRS = (state: number): number => {
        const f = this.debugFlags;
        if (f.forceDisableZTest && state === D3DRS_ZENABLE) return 0;
        if (f.forceDisableAlphaTest && state === D3DRS_ALPHATESTENABLE) return 0;
        if (f.forceDisableAlphaBlend && state === D3DRS_ALPHABLENDENABLE) return 0;
        return this.stateTracker.getRenderState(state);
    };

    /**
     * Guard raster states which cannot be represented by the current WebGPU attachment.
     * The policy is deliberately checked before every pipeline-cache fast path: changing a
     * sample mask must never let a previously-built pipeline draw with silently different
     * coverage or depth/stencil side effects.
     */
    private rasterStateSupported(topology: D3D9DrawTopology): boolean {
        const fillMode = this.getRS(D3DRS_FILLMODE);
        if (fillMode !== 3 /* D3DFILL_SOLID */) {
            Logger.error(LogCategory.D3D9,
                `[D3D9] refusing D3DRS_FILLMODE=${fillMode}: WebGPU has no fixed-function wireframe/point rasterizer`);
            return false;
        }
        if (this.getRS(D3DRS_ZENABLE) === 2 /* D3DZB_USEW */) {
            Logger.error(LogCategory.D3D9,
                "[D3D9] refusing D3DZB_USEW: WebGPU depth attachment cannot implement W-buffer semantics");
            return false;
        }
        if (!isD3D9DepthStencilStateRepresentable(this.getRS)) {
            Logger.error(LogCategory.D3D9,
                "[D3D9] refusing invalid depth/stencil/cull enum state");
            return false;
        }
        // Stencil state against a depth-only attachment makes WebGPU reject the PIPELINE, which
        // loses every draw that shader is used for. Both pipeline paths call through here, so
        // the check belongs to the shared raster gate, not to the fixed-function path alone.
        if (hasUnsupportedStencilState(this.getRS, this.activeDepthTargetFormat())) {
            Logger.error(LogCategory.D3D9,
                "[D3D9] stencil state requested without a stencil attachment; refusing draw");
            return false;
        }
        // D3DRS_RANGEFOGENABLE controls the fixed-function T&L fog calculation only.
        // A programmable vertex shader owns oFog and must provide its own range factor;
        // the state is therefore intentionally inert here (per the D3D9 vertex-fog contract).
        const multisample = resolveD3D9MultisampleRasterPolicy(
            this.activeRenderTargetSampleCount(),
            this.getRS(D3DRS_MULTISAMPLEANTIALIAS) !== 0,
            this.getRS(D3DRS_MULTISAMPLEMASK) >>> 0,
        );
        if (!multisample.supported) {
            Logger.error(LogCategory.D3D9, `[D3D9] refusing raster state: ${multisample.reason}`);
            return false;
        }
        if (topology === "line-list" && this.getRS(D3DRS_ANTIALIASEDLINEENABLE) !== 0) {
            Logger.error(LogCategory.D3D9,
                "[D3D9] D3DRS_ANTIALIASEDLINEENABLE is not representable by WebGPU line rasterization");
            return false;
        }
        return true;
    }

    /** D3DRS_SHADEMODE == D3DSHADE_FLAT (1). GOURAUD is the default and D3DSHADE_PHONG was
     *  never implemented by any D3D9 driver, so anything but FLAT interpolates.
     *  Lowered by the fixed-function shader emitter only: a programmable pixel shader
     *  declares its own interpolation and never reads the fixed-function colour varyings. */
    private flatShadingEnabled(): boolean {
        return this.getRS(D3DRS_SHADEMODE) === 1;
    }

    private rasterStateKey(): string {
        return `ms${this.activeRenderTargetSampleCount()}:aa${this.getRS(D3DRS_MULTISAMPLEANTIALIAS) !== 0 ? 1 : 0}`
            + `:mask${this.getRS(D3DRS_MULTISAMPLEMASK) >>> 0}:line${this.getRS(D3DRS_ANTIALIASEDLINEENABLE) !== 0 ? 1 : 0}`
            + `:fill${this.getRS(D3DRS_FILLMODE)}:shade${this.getRS(D3DRS_SHADEMODE)}`
            + `:range${this.getRS(D3DRS_RANGEFOGENABLE) !== 0 ? 1 : 0}:w${this.getRS(D3DRS_ZENABLE) === 2 ? 1 : 0}`;
    }

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

    // ── Vertex input: one table, one resolver, one identity ───────────────────────────────
    // Everything below reads `this.streams` (the binding table) and a slot MASK — the set of
    // slots the active declaration references, or {0} for an FVF / *UP draw that supplies its
    // own vertices. Slot 0 is resolved by exactly the same code as slots 1+; the only thing a
    // caller may override is slot 0's STRIDE, and only when it repacked the vertices itself.

    /** Slot mask per declaration handle. A declaration is immutable once created, so this is
     *  computed once instead of re-scanning the elements on every draw. */
    private declSlotMasks = new Map<number, number>();

    /** The slots this draw's pipeline declares: the active declaration's, or slot 0 alone. */
    private activeSlotMask(): number {
        const handle = this.activeVertexDecl;
        if (handle <= 0) return 1;
        const cached = this.declSlotMasks.get(handle);
        if (cached !== undefined) return cached;
        const decl = this.vsDeclRegistry.get(handle);
        const mask = decl && decl.length > 0 ? declStreamMask(decl) : 1;
        this.declSlotMasks.set(handle, mask);
        return mask;
    }

    /** The stride a slot steps by: the bound stride, unless the caller repacked slot 0. */
    /** Vertex-buffer slots this device can actually bind. D3D9 advertises 16 streams; WebGPU
     *  binds `maxVertexBuffers` (8 by default) and refuses a pipeline declaring more. */
    private maxVertexBufferSlots(): number {
        const limit = this.backend.getDevice()?.limits?.maxVertexBuffers ?? 0;
        return limit > 0 ? limit : MAX_VERTEX_BUFFER_SLOTS;
    }

    private slotStride(slot: number, stride0Override: number): number {
        return slot === 0 && stride0Override > 0 ? stride0Override : this.streams.strideBytes[slot]!;
    }

    /** Reused stride-per-slot scratch for the shader/layout builders (consumed synchronously). */
    private strideScratch = new Array<number>(MAX_VERTEX_STREAMS).fill(0);

    private slotStrides(stride0Override: number): number[] {
        for (let s = 0; s < MAX_VERTEX_STREAMS; s++) this.strideScratch[s] = this.slotStride(s, stride0Override);
        return this.strideScratch;
    }

    /**
     * Pipeline identity for the vertex input: which slots the layout has and what each steps
     * by. ONE key over every used slot including 0 — a stride that only reaches the key for
     * slot 0 is how a multi-stream draw reuses a pipeline built for a different layout.
     */
    private streamKey(slotMask: number, stride0Override: number): string {
        let key = "";
        for (let s = 0; s < MAX_VERTEX_STREAMS; s++) {
            if (((slotMask >>> s) & 1) === 0) continue;
            key += `|v${s}:${this.slotStride(s, stride0Override)}`;
            if (stepModeFromFreq(this.streams.freq[s]!).stepMode === "instance") key += "i";
        }
        return key;
    }

    /** Zero-alloc twin of streamKey — guards the hot last-resolve fast path. */
    private streamHash(slotMask: number, stride0Override: number): number {
        let h = slotMask | 0;
        for (let s = 0; s < MAX_VERTEX_STREAMS; s++) {
            if (((slotMask >>> s) & 1) === 0) continue;
            h = (Math.imul(h, 31) + this.slotStride(s, stride0Override)) | 0;
            h = (Math.imul(h, 31) + (stepModeFromFreq(this.streams.freq[s]!).stepMode === "instance" ? 1 : 0)) | 0;
        }
        return h;
    }

    /**
     * Canonical TypeScript identity for an arena-recorded programmable draw.
     *
     * The Rust arena's numeric key is intentionally compact and currently omits
     * attachment/depth/raster/sampler details.  Compute the complete identity before
     * calling recordDraw* so the arena alias cache can only reuse a pipeline when both
     * the Rust hash and every legacy cache component agree.  This is a fingerprint, not
     * a replacement for the Rust command key; the executor still consumes the arena's
     * command SoA and the legacy pipeline id remains the registered GPU object handle.
     */
    private prepareArenaPipelineIdentity(
        topology: D3D9DrawTopology,
        forceCullNone: boolean,
        strideOverride: number | undefined,
        slotMask: number,
        pointExpansion = false,
    ): ArenaPipelineIdentitySnapshot {
        const effectiveForceCull = forceCullNone || this.debugFlags.forceCullNone;
        const vs = this.getActiveVsShader();
        const ps = this.getActivePsShader();
        const hybridStages = ps ? 0 : this.activeStageCount();
        const samplerStates = this.samplerShaderStates(vs, ps, hybridStages);
        const samplerKey = dxSamplerShaderStatesKey(samplerStates);
        const pointSpriteEnable = pointExpansion && this.getRS(D3DRS_POINTSPRITEENABLE) !== 0;
        const stride = strideOverride ?? this.stateTracker.getStreamSource()?.stride ?? null;
        const stateKey = this.stateTracker.computePipelineKey() >>> 0;
        const stateBits = stateKey & 0x7FF0000;
        const streamHash = this.streamHash(slotMask, stride ?? 0);
        const streamKey = this.streamKey(slotMask, stride ?? 0);
        const ptSize = this.getCurrentTargetSize();
        const preTransformed = this.activeDeclIsPreTransformed()
            ? {
                viewportWidth: this.viewport.width || ptSize.w,
                viewportHeight: this.viewport.height || ptSize.h,
                pixelCenterOffset: pixelCenterOffsetPx(),
            }
            : null;
        const programmableClipPlanes = this.getRS(D3DRS_CLIPPLANEENABLE) !== 0 && preTransformed === null;
        const ptKey = preTransformed
            ? `:pt${preTransformed.viewportWidth}x${preTransformed.viewportHeight}c${preTransformed.pixelCenterOffset}`
            : "";
        const comparisonSamplers = ps ? this.boundComparisonSamplers() : EMPTY_COMPARISON_SAMPLERS;
        const comparisonMask = ps ? this.boundComparisonMask() : 0;
        const comparisonKey = ps ? this.boundComparisonKey() : "";
        const cubeMask = (computeCubeMask(ps) | this.boundCubeMask()) & ~comparisonMask;
        const volumeMask = ps ? ((computeVolumeMask(ps) | this.boundVolumeMask()) & ~comparisonMask) : 0;
        const vertexVolumeMask = computeVertexVolumeMask(vs) | this.boundVertexVolumeMask();
        this.refreshStateKeys();
        const projKey = this.stateKeyProjected;
        const blendKey = this.stateKeyBlend;
        const alphaKey = this.stateKeyAlpha;
        const depthKey = this.stateKeyDepth;
        const targetKey = this.stateKeyTarget;
        const fvf = this.stateTracker.getFVF() >>> 0;
        return buildArenaPipelineIdentity({
            shader: `vs${this.activeVertexShader}:ps${this.activePixelShader}:decl${this.activeVertexDecl}`,
            fvf: `:fvf${fvf}`,
            state: `:full${stateKey}:bits${stateBits}:top${topology}:fc${effectiveForceCull ? 1 : 0}`,
            point: `:pe${pointExpansion ? 1 : 0}:psp${pointSpriteEnable ? 1 : 0}:cp${programmableClipPlanes ? 1 : 0}`,
            blend: `:bl${blendKey}:at${alphaKey}:dep${depthKey}`,
            masks: `:cm${cubeMask}:dm${comparisonMask}:dc${comparisonKey}:vm${volumeMask}:vvm${vertexVolumeMask}`,
            projection: `:pj${projKey}:hs${hybridStages}`,
            sampler: `:sam${samplerKey}`,
            target: `:rt${targetKey}${ptKey}`,
            streams: `:smask${slotMask}:sh${streamHash}${streamKey}`,
        });
    }

    /**
     * Allocation-light exact front key for aggregate WBUF pipeline reuse.
     *
     * Render-state fragments are the same canonical strings consumed by the universal
     * resolver. Everything outside render state is guarded by an immutable handle/value or
     * by the monotonic generation owned by its sole mutation funnel. A generation change may
     * conservatively miss after state returns to an older value, but can never alias it with
     * an entry created under different sampler, texture, attachment, or resource state.
     */
    private compactPipelineFastKey(fullStateKey: number, stride: number): string {
        this.refreshStateKeys();
        const streamHash = this.streamHash(1, stride);
        return `${this.activeVertexShader}:${this.activePixelShader}:${this.activeVertexDecl}`
            + `:fvf${this.stateTracker.getFVF() >>> 0}:str${stride}:sh${streamHash}`
            + `:sg${this.samplerStateGeneration}:bg${this.arenaSamplerBankGeneration}`
            + `:ag${this.attachmentGeneration}:full${fullStateKey}`
            + `:bl${this.stateKeyBlend}:at${this.stateKeyAlpha}:dep${this.stateKeyDepth}`
            + `:pj${this.stateKeyProjected}:rt${this.stateKeyTarget}`
            + `:cp${this.getRS(D3DRS_CLIPPLANEENABLE) >>> 0}`
            // prepareArenaPipelineIdentity folds the debug cull override into `fc`; without it
            // here a toggle reuses the pipeline built under the other setting.
            + `:fc${this.debugFlags.forceCullNone ? 1 : 0}`;
    }

    /** Record one arena row after the numeric last-resolve memo has had first refusal. */
    private recordArenaSpec(spec: ArenaRecordSpec, identity: ArenaPipelineIdentitySnapshot, reuseIdentity = false): number | undefined {
        const checkpoint = d3d9WasmArena.checkpoint();
        if (!reuseIdentity) d3d9WasmArena.setPipelineIdentity(identity.words);
        const topology = spec.topology;
        let key: number;
        switch (spec.kind) {
            case "draw":
                key = d3d9WasmArena.recordDraw(
                    topology, spec.vertexCount, spec.startVertex, spec.stride, spec.forceCullNone,
                );
                break;
            case "indexed":
                key = d3d9WasmArena.recordDrawIndexed(
                    topology, spec.indexCount, spec.startIndex, spec.baseVertex, spec.stride, spec.forceCullNone,
                );
                break;
            case "up":
                key = d3d9WasmArena.recordDrawUP(
                    topology, spec.vertexCount, spec.guestVertexPtr, spec.stride, spec.byteLen, spec.forceCullNone,
                );
                break;
        }
        if (key < 0) {
            d3d9WasmArena.rollback(checkpoint);
            return undefined;
        }
        this.pendingArenaRecord = {
            key,
            identity,
            commandStart: checkpoint.commandCount,
            checkpoint,
        };
        return key;
    }

    private takePendingArenaRecord(): PendingArenaRecord | null {
        const record = this.pendingArenaRecord;
        this.pendingArenaRecord = null;
        return record;
    }

    private arenaPipelineCacheKey(arenaKey: number, fingerprint: string): string {
        // Rust's compact key is only a bucket. The canonical fingerprint is the
        // collision/omitted-field guard and is deliberately part of the map key.
        return arenaPipelineCacheBucket(arenaKey, fingerprint);
    }

    private cacheArenaPipeline(key: string, pipelineId: number): void {
        // Refresh insertion order for repeated identities so the bound behaves like a small LRU.
        this.arenaPipelineCache.delete(key);
        this.arenaPipelineCache.set(key, pipelineId);
        while (this.arenaPipelineCache.size > ARENA_PIPELINE_CACHE_MAX_ENTRIES) {
            const oldest = this.arenaPipelineCache.keys().next().value;
            if (oldest === undefined) break;
            this.arenaPipelineCache.delete(oldest);
        }
    }

    /**
     * The GPU buffer backing a slot's bound vertex buffer, uploaded and version-renamed.
     * Every slot goes through uploadBufferVersion — DISCARD renaming is a per-buffer property,
     * not a stream-0 privilege. Null when the slot has nothing usable bound.
     */
    private slotGpuBuffer(slot: number, device: GPUDevice): GPUBuffer | null {
        const index = this.streams.bufferIndex[slot]!;
        if (index < 0 || this.streams.strideBytes[slot]! <= 0) return null;
        const data = this.vertexBuffers.getData(index);
        if (!data) return null;
        return this.uploadBufferVersion(index, data, "vb", device);
    }

    /**
     * Resolve the bindings for every slot this draw's pipeline declares, slot 0 included, into
     * the reused plan.
     *
     * A binding runs [OffsetInBytes, end of buffer): the draw's firstVertex/baseVertex is
     * applied by the GPU to every slot uniformly, so folding it in here would double-count it.
     * A slot the guest left unbound gets the zero-filled stand-in rather than cancelling the
     * draw — real D3D9 binds an empty buffer there and still rasterizes (DXVK
     * D3D9DeviceEx::BindVertexBuffer with a null buffer), and WebGPU has no null binding at
     * all, so a slot the pipeline declares MUST have something in it.
     *
     * Draws that build their own vertex buffer (*UP, the CPU rewinds) fill the plan directly
     * instead — those bytes never came from a bound stream.
     */
    private resolveDrawStreams(slotMask: number, device: GPUDevice, instanceCount = 1): StreamBindingPlan {
        const plan = this.streamPlan;
        plan.reset();
        for (let slot = 0; slot < MAX_VERTEX_STREAMS; slot++) {
            if (((slotMask >>> slot) & 1) === 0) continue;
            const sourceIndex = this.streams.bufferIndex[slot]!;
            const divisor = streamInstanceDivisor(this.streams.freq[slot]!);
            // WebGPU has no vertex-buffer instance-rate divisor. For D3D9's
            // INSTANCEDATA|D (D > 1), upload a repeated-record view for this draw;
            // divisor-one stays on the native zero-copy path.
            if (instanceCount > 1 && divisor > 1 && sourceIndex >= 0) {
                const source = this.vertexBuffers.getData(sourceIndex);
                const stride = this.streams.strideBytes[slot]!;
                const expanded = source
                    ? expandInstanceRateData(source, this.streams.offsetBytes[slot]!, stride, instanceCount, divisor)
                    : null;
                if (!expanded) {
                    // Bind a zero stream below; the draw boundary will still be
                    // deterministic, while callers can observe the explicit refusal
                    // through the instancing diagnostic rather than a WebGPU throw.
                    plan.add(slot, zeroStreamBuffer(device, ZERO_STREAM_MIN_BYTES), 0, ZERO_STREAM_MIN_BYTES);
                    continue;
                }
                if (expanded.length === 0) {
                    plan.add(slot, zeroStreamBuffer(device, ZERO_STREAM_MIN_BYTES), 0, ZERO_STREAM_MIN_BYTES);
                    continue;
                }
                if (!this.vbPool) this.vbPool = new DynamicVbPool(device);
                const bytes = (expanded.byteLength + 3) & ~3;
                const buffer = this.vbPool.acquire(Math.max(16, bytes));
                const upload = bytes === expanded.byteLength ? expanded : new Uint8Array(bytes);
                if (upload !== expanded) upload.set(expanded);
                device.queue.writeBuffer(buffer, 0, upload);
                this.commandRecorder.registerPooledBuffer(buffer);
                plan.add(slot, buffer, 0, expanded.byteLength);
                continue;
            }
            const gpu = this.slotGpuBuffer(slot, device);
            const offset = this.streams.offsetBytes[slot]!;
            const size = gpu ? bindingSize(this.vertexBuffers.getSize(sourceIndex), offset) : 0;
            if (!gpu || size <= 0) {
                plan.add(slot, zeroStreamBuffer(device, ZERO_STREAM_MIN_BYTES), 0, ZERO_STREAM_MIN_BYTES);
                continue;
            }
            plan.add(slot, gpu, offset, size);
        }
        return plan;
    }

    private blendCacheKey(numericKey: number, stride0Override = 0, slotMask = this.activeSlotMask()): string {
        // The numeric key carries only FVF bits 0-15, so the TEXCOORDSIZE field (bit 16+) and
        // the stream stride — both of which change the vertex layout — must key the cache too,
        // or the first pipeline built for an FVF is reused for a differently-strided stream.
        // Stage count is baked into the shader, so it belongs here for the same reason.
        const fvfHigh = this.stateTracker.getFVF() >>> 16;
        // ZFUNC is not in the numeric key (bits 25/26 carry only ZENABLE/ZWRITEENABLE), so it
        // has to key the cache here or every depth compare collapses onto the first one built.
        const stages = this.activeStageCount();
        // BORDER/MIRRORONCE and shader-side LOD bias are lowered into the generated
        // fixed-function fragment shader. Their decoded state therefore belongs in the
        // FFP pipeline identity just like stage count and texgen.
        const samplerKey = this.samplerShaderStatesResolved(null, null, stages).key;
        // Appended only when texgen is on, so it multiplies pipelines for the draws that use
        // it and leaves every other key the shape it already had.
        const texGen = this.texGenActive(stages) ? "|tg" : "";
        return `${numericKey}|${fvfHigh}|s${stages}${texGen}|rt${this.activeColorTargetKey()}`
            + `|${computeBlendKey(this.getRS)}|${this.alphaTestKey()}|${computeDepthKey(this.getRS)}`
            + `|df${this.activeDepthTargetFormat()}`
            + `|${this.rasterStateKey()}`
            + `|sm${samplerKey}`
            + this.streamKey(slotMask, stride0Override);
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

    private getPipelineId(slotMask: number): number {
        const key = this.buildPipelineKey();
        const cacheKey = this.blendCacheKey(key, 0, slotMask);
        if (this.currentPipelineKey !== cacheKey || this.currentPipelineId === null) {
            this.currentPipelineKey = cacheKey;
            this.currentPipelineId = this.resolvePipelineId(key, "triangle-list", false, undefined, 0, slotMask);
        }
        return this.currentPipelineId ?? 0;
    }

    private getPipelineIdForTopology(
        topology: D3D9DrawTopology,
        forceCullNone: boolean,
        stride0Override: number,
        slotMask: number,
    ): number {
        const key = this.buildPipelineKey();
        return this.resolvePipelineId(key, topology, forceCullNone, undefined, stride0Override, slotMask);
    }

    /**
     * Pipeline for the point-sprite expansion: a synthetic pre-transformed FVF (XYZRHW +
     * diffuse [+ tex]) that the RHW FFP shader passes straight through. Distinct cache prefix
     * so it never collides with the game's own FVF/decl pipelines; cull is forced off (D3D
     * never back-face-culls points).
     */
    private getPointSpritePipelineId(syntheticFvf: number): number {
        const key = this.buildPipelineKey();
        return this.resolvePipelineId(key, "triangle-list", true, syntheticFvf);
    }

    private resolvePipelineId(
        key: number,
        topology: D3D9DrawTopology,
        forceCullNone: boolean = false,
        fvfOverride?: number,
        stride0Override = 0,
        slotMask = this.activeSlotMask(),
    ): number {
        if (!this.rasterStateSupported(topology)) return -1;
        // Validate blend inputs before creating the pipeline. Valid FVF XYZBn and declaration
        // BLENDWEIGHT/BLENDINDICES draws use the palette-aware shader below; malformed state is
        // still refused instead of silently applying WORLD once. D3DVBF_TWEENING is declaration
        // only (POSITION0/POSITION1), as the FVF has no second position stream.
        const blendMode = this.getRS(D3DRS_VERTEXBLEND) | 0;
        const indexedBlend = this.getRS(D3DRS_INDEXEDVERTEXBLENDENABLE) !== 0;
        if (blendMode !== 0 || indexedBlend) {
            const resolvedBlend = resolveFfpVertexBlend(blendMode, indexedBlend);
            if (resolvedBlend.mode === null) {
                d3d9PerfFfpUnimplemented("vertexBlendMode");
                Logger.error(LogCategory.D3D9,
                    `[D3D9] fixed-function vertex blend mode ${blendMode} is unsupported: `
                    + `${resolvedBlend.reason}; refusing draw`);
                return -1;
            }
            const decl = this.activeVertexDecl > 0 ? (this.vsDeclRegistry.get(this.activeVertexDecl) ?? []) : [];
            const hasWeight = decl.some(e => e.usage === DECLUSAGE_BLENDWEIGHT_FFP && e.usageIndex === 0);
            const hasIndex = decl.some(e => e.usage === DECLUSAGE_BLENDINDICES_FFP && e.usageIndex === 0);
            const hasTweenPosition = decl.some(e => e.usage === DECLUSAGE_POSITION_FFP && e.usageIndex === 1);
            let valid = false;
            if (blendMode === 255) {
                valid = !indexedBlend && hasTweenPosition;
            } else if (blendMode === 256) {
                valid = indexedBlend && hasIndex;
            } else if (blendMode >= 1 && blendMode <= 3) {
                valid = hasWeight && (!indexedBlend || hasIndex);
            if (decl.length === 0) {
                    const fvf = fvfOverride ?? this.stateTracker.getFVF();
                    const plan = planFvf(fvf, this.slotStride(0, stride0Override));
                    valid = plan.blendWeightLoc >= 0 && (!indexedBlend || plan.blendIndexLoc >= 0);
                }
            }
            if (decl.length > 0) {
                const pos = decl.find(e => e.usage === DECLUSAGE_POSITION_FFP || e.usage === DECLUSAGE_POSITIONT_FFP);
                if (pos?.usage === DECLUSAGE_POSITIONT_FFP) valid = false;
            } else if (fvfOverride === undefined) {
                valid = valid && !planFvf(this.stateTracker.getFVF(), this.slotStride(0, stride0Override)).hasRhw;
            }
            // Point-sprite synthetic FVF has no blend payload and must not inherit guest state.
            if (fvfOverride !== undefined) valid = false;
            if (!valid) {
                d3d9PerfFfpUnimplemented(indexedBlend ? "indexedVertexBlendInput" : "vertexBlendInput");
                Logger.error(LogCategory.D3D9,
                    `[D3D9] fixed-function vertex blend mode ${blendMode} has no valid weight/index input; refusing draw`);
                return -1;
            }
        }
        const unsupportedSampler = this.firstUnsupportedSamplerStage(false);
        if (unsupportedSampler !== null) {
            Logger.error(LogCategory.D3D9,
                `[D3D9] sampler stage ${unsupportedSampler.stage} uses unsupported feature ` +
                `${unsupportedSampler.reason}; refusing draw`);
            return -1;
        }
        // The fixed-function fragment ABI only declares 2-D textures. Programmable
        // dcl_volume draws take the path below; refuse a volume bound to FFP rather than
        // silently binding a dimension-mismatched fallback view.
        if (this.boundVolumeMask() !== 0 || this.boundVertexVolumeMask() !== 0) {
            Logger.error(LogCategory.D3D9, "[D3D9] volume texture requires the programmable 3-D shader path; refusing FFP draw");
            return -1;
        }
        const cubeMask = this.boundCubeMask();
        if (cubeMask !== 0) {
            for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
                if (((cubeMask >>> stage) & 1) !== 0) d3d9PerfFfpUnimplemented(`cubeTextureStage${stage}`);
            }
            Logger.error(LogCategory.D3D9,
                `[D3D9] cube texture stage mask 0x${cubeMask.toString(16)} requires a cube-sampler FFP path; refusing draw`);
            return -1;
        }
        // Cull is not read through getRS (it rides the numeric pipeline key), so the toggle
        // joins the per-draw override here; setDebugToggle drops the caches, so no entry
        // built under the opposite setting survives to be reused.
        forceCullNone = forceCullNone || this.debugFlags.forceCullNone;
        // Synthetic-FVF pipelines (point sprites) get their own cache namespace so they never
        // alias the game's decl/FVF pipelines that hash to the same numeric key.
        // Topology and the point/line cull override are call-site state, not bits in `key`.
        // Keep them in the cache namespace so a line pipeline cannot alias a triangle pipeline
        // now that the numeric key is reserved for the decodable D3D render-state bits.
        const topologyKey = `|topo${topology}|fc${forceCullNone ? 1 : 0}`;
        const cacheKey = (fvfOverride !== undefined
            ? `ps${fvfOverride}|${this.blendCacheKey(key, 0, 1)}`
            : this.blendCacheKey(key, stride0Override, slotMask)) + topologyKey;
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
        const colorTargets = this.activeColorTargetStates();
        if (!colorTargets) return -1;

        const declElements = this.activeVertexDecl > 0
            ? (this.vsDeclRegistry.get(this.activeVertexDecl) ?? null)
            : null;

        let shaderModule: GPUShaderModule;
        let vertexBuffers: (GPUVertexBufferLayout | null)[];
        let hasTexture: boolean;
        // Stages this pipeline's shader will declare bindings for. Both fixed-function paths
        // (FVF and vertex declaration) derive it from the same activeStageCount(); the synthetic
        // point-sprite FVF stays at one. The executor binds exactly this many pairs, so it MUST
        // equal what the shader declared (see PipelineInfo.ffpStageCount).
        let ffpStageCount = 1;

        const alphaTest = this.getAlphaTest();
        const ffpSamplerStates = this.samplerShaderStates(null, null,
            fvfOverride !== undefined ? 1 : this.activeStageCount());
        // D3DRS_LIGHTING bit (24) of the pipeline key selects the lit FFP shader variant.
        const lit = ((key >> 24) & 1) !== 0;
        if (fvfOverride !== undefined) {
            // Point-sprite synthetic FVF: pre-transformed (XYZRHW) quads, never lit; build the
            // shader + tightly-packed layout straight from the synthetic FVF (ignore decl/stream).
            const layout = buildVertexLayout(fvfOverride);
            shaderModule = gpuDevice.createShaderModule({
                code: buildShader(fvfOverride, alphaTest, false, 1, false, 0, ffpSamplerStates,
                    this.flatShadingEnabled()),
            });
            this.observeShaderCompilation(shaderModule, null, "ffp-point-sprite");
            vertexBuffers = [{ arrayStride: layout.arrayStride, attributes: layout.attributes }];
            hasTexture = layout.hasTexture;
        } else if (declElements && declElements.length > 0) {
            if (slotMaskExceedsLimit(slotMask, this.maxVertexBufferSlots())) {
                d3d9DropDraw("pipeline:streamSlotOverLimit");
                return -1;
            }
            // FFP + vertex declaration path: build shader and layout from declaration data.
            // One layout per slot the mask names — the same mask the draw's bindings come
            // from, so the pipeline can never declare a slot the draw leaves unbound. Only a
            // CPU-converted draw overrides slot 0's stride (its bytes are repacked).
            ffpStageCount = this.activeStageCount();
            const strides = this.slotStrides(stride0Override);
            const built = buildShaderFromDecl(declElements, alphaTest, lit, ffpStageCount, strides, slotMask,
                this.texGenActive(ffpStageCount), ffpSamplerStates, this.flatShadingEnabled());
            shaderModule = gpuDevice.createShaderModule({ code: built.wgsl });
            this.observeShaderCompilation(shaderModule, null, "ffp-declaration");
            vertexBuffers = built.buffers;
            hasTexture = built.hasTexture;
        } else {
            // FFP + FVF path. The BOUND stride wins (DrawPrimitiveUP's VertexStreamZeroStride /
            // SetStreamSource's Stride): that is what D3D9 steps the stream by, while the FVF
            // only says where components sit inside a vertex — raising it to the FVF's packed
            // size reads every vertex after the first out of its successor. planFvf drops the
            // components that no longer fit, so shader and layout stay in step.
            const fvf = this.stateTracker.getFVF();
            const boundStride = this.slotStride(0, stride0Override);
            const layout = buildVertexLayout(fvf, boundStride);
            ffpStageCount = this.activeStageCount();
            const texGen = this.texGenActive(ffpStageCount);
            shaderModule = gpuDevice.createShaderModule({
                code: buildShader(fvf, alphaTest, lit, ffpStageCount, texGen, boundStride, ffpSamplerStates,
                    this.flatShadingEnabled()),
            });
            this.observeShaderCompilation(shaderModule, null, "ffp-fvf");
            vertexBuffers = [{ arrayStride: layout.arrayStride, attributes: layout.attributes }];
            hasTexture = layout.hasTexture || texGen;
        }

        // A slot's SetStreamSourceFreq divider decides its step mode — see applyStepModes for
        // why this is one pass over the finished layouts rather than an argument in both builders.
        vertexBuffers = applyStepModes(vertexBuffers, this.streams.freq);
        if (!validateWebGpuVertexBufferStrides(vertexBuffers, "FFP")) return -1;

        const cullModeD3D = (key >> 16) & 0xff;
        let cullMode: GPUCullMode = "none";
        if (!forceCullNone) {
            if (cullModeD3D === D3DCULL_CW) cullMode = "front";
            else if (cullModeD3D === D3DCULL_CCW) cullMode = "back";
        }

        // A throw here (an unsupported format, a layout the shader disagrees with) must cost
        // this draw alone — uncaught it unwinds through the recorder and the whole frame dies.
        let pipeline: GPURenderPipeline;
        gpuDevice.pushErrorScope("validation");
        try {
            pipeline = gpuDevice.createRenderPipeline({
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
                    targets: colorTargets,
                },
                primitive: {
                    topology,
                    frontFace: "cw",
                    cullMode,
                    // WebGPU bakes the strip-cut width into the pipeline. Indexed strips are
                    // uint16 only (see D3D9DrawTopology), so the format is fixed rather than
                    // another dimension of the cache key.
                    ...(topology === "triangle-strip" ? { stripIndexFormat: "uint16" as const } : {}),
                },
                multisample: {
                    count: this.activeRenderTargetSampleCount(),
                    mask: this.getRS(D3DRS_MULTISAMPLEMASK) >>> 0,
                },
                depthStencil: buildDepthStencilState(this.activeDepthTargetFormat(), this.getRS),
            });
        } catch (e) {
            void gpuDevice.popErrorScope().catch(() => undefined);
            Logger.error(LogCategory.D3D9, `[D3D9] fixed-function pipeline build failed: ${e}`);
            return -1;
        }
        this.observePipelineValidation(gpuDevice, null, "ffp-pipeline");

        // Strides AND per-slot attribute extents from the SAME layouts this pipeline was built
        // with — the executor sizes every non-indexed draw against both (planVertexRangePadding).
        const pipelineId = this.backendExecutor.registerPipeline(pipeline, hasTexture, false, ffpStageCount,
            layoutStrides(vertexBuffers), layoutAttributeEnds(vertexBuffers));
        this.pipelineCache.set(cacheKey, pipelineId);
        return pipelineId;
    }

    // ── Programmable (VS/PS) pipeline + per-draw state ────────────────────

    /**
     * Resolve (and cache) the programmable pipeline for the current VS+PS+decl
     * +render-state, build using the executor's shared explicit layout.
     * Returns -1 on shader-compile failure (the draw is then skipped).
     */
    /**
     * The reuse tail: what a resolve does once it knows the previous draw's pipeline is
     * the right one. ONE definition, reached both by the last-resolve compare and by the
     * prologue memo, so the memo cannot skip a side effect (the arena record, the
     * counters, noteProgrammableDraw) the compare would have performed.
     *
     * arenaSpec is per-draw and is deliberately NOT memoised — recordArenaSpec runs on
     * every call and is what republishes pendingArenaRecord.
     */
    private _programmablePipelineReuse(
        arenaSpec: ArenaRecordSpec | undefined,
        psNonNull: boolean,
        attributeDraw = true,
    ): number {
        let arenaKey: number | undefined;
        let arenaIdentity: string | undefined;
        // The representability probe is itself memoised, but still belongs after the cheap
        // numeric comparison: a non-arena draw must not pay even its closure or sampler-bank
        // walk merely because a programmable shader is active.
        const arenaEligible = !!arenaSpec && psNonNull && isWasmPathEnabled()
            && d3d9WasmArena.isInitialized() && this.arenaCanRepresentCurrentSamplerBank();
        // No sampler-generation gate: the published identity is a pure function of the
        // compared fields and carries no texture state, so a SetTexture between two draws of
        // the same state run leaves it valid. Rust compares the bind-group key itself.
        // Gating here made the arena record only the FIRST draw of every run.
        if (arenaEligible && arenaSpec && this._lrArenaIdentity !== undefined
            && this._lrArenaIdentityWords !== undefined) {
            const identity = this.lastResolveIdentityScratch;
            identity.key = this._lrArenaIdentity;
            identity.words = this._lrArenaIdentityWords;
            arenaKey = this.recordArenaSpec(arenaSpec, identity, true);
            if (arenaKey !== undefined) arenaIdentity = identity.key;
        }
        d3d9PerfBackendInc("progPipelineCacheHits");
        if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheHits++;
        if (arenaKey !== undefined && arenaIdentity !== undefined) {
            this.backendExecutor.registerArenaPipelineIdentity(arenaIdentity, this._lrPipelineId);
        }
        if (this._lrPipelineId < 0) return this._lrPipelineId;
        if (!attributeDraw || !pipelineMemoProfiling()) {
            return this.programmablePipelineResult(this._lrPipelineId, attributeDraw);
        }
        const t0 = performance.now();
        const noted = this.programmablePipelineResult(this._lrPipelineId, true);
        notePipelineMemoProf(PROF_NOTE, performance.now() - t0);
        return noted;
    }

    /**
     * Does the armed prologue memo describe THIS call? Every input to the derived values
     * the last-resolve compare needs is either compared here directly or is a pure
     * function of one of the four generations compared here — that equivalence is the
     * whole safety argument, so a field added to the resolve body without a generation
     * behind it must be added here explicitly or the memo must be left disarmed.
     */
    private _pipelineMemoMatches(
        topology: string, forceCullNone: boolean, strideOverride: number | undefined,
        slotMask: number, pointExpansion: boolean,
    ): boolean {
        if (!this._pmValid) return false;
        if (this._pmTopo !== topology || this._pmForceCull !== forceCullNone) return false;
        if (this._pmStrideOverride !== (strideOverride ?? -1)) return false;
        if (this._pmSlotMask !== slotMask || this._pmPointExp !== pointExpansion) return false;
        if (this._pmVs !== this.activeVertexShader || this._pmPs !== this.activePixelShader) return false;
        if (this._pmDecl !== this.activeVertexDecl) return false;
        if (this._pmFvf !== (this.stateTracker.getFVF() >>> 0)) return false;
        if (this._pmGenPipeline !== this.pipelineStateGeneration) return false;
        if (this._pmGenSampler !== this.samplerStateGeneration) return false;
        if (this._pmGenBank !== this.arenaSamplerBankGeneration) return false;
        if (this._pmGenAttach !== this.attachmentGeneration) return false;
        const stride = strideOverride ?? this.stateTracker.getStreamSource()?.stride ?? null;
        if (this._pmStride !== stride) return false;
        return this._pmStreamHash === this.streamHash(slotMask, stride ?? 0);
    }

    /** Arm the prologue memo. Callers MUST already have established the three conditions
     *  the last-resolve compare itself requires — no pointExpansion, no pre-transformed
     *  viewport bake, no programmable clip planes — because the reduced `_lr*` fields do
     *  not carry them. */
    private _armPipelineMemo(
        topology: string, forceCullNone: boolean, strideOverride: number | undefined,
        slotMask: number, pointExpansion: boolean, stride: number | null,
        streamHash: number, psNonNull: boolean,
    ): void {
        this._pmTopo = topology;
        this._pmForceCull = forceCullNone;
        this._pmStrideOverride = strideOverride ?? -1;
        this._pmSlotMask = slotMask;
        this._pmPointExp = pointExpansion;
        this._pmVs = this.activeVertexShader;
        this._pmPs = this.activePixelShader;
        this._pmDecl = this.activeVertexDecl;
        this._pmFvf = this.stateTracker.getFVF() >>> 0;
        this._pmStride = stride;
        this._pmStreamHash = streamHash;
        this._pmGenPipeline = this.pipelineStateGeneration;
        this._pmGenSampler = this.samplerStateGeneration;
        this._pmGenBank = this.arenaSamplerBankGeneration;
        this._pmGenAttach = this.attachmentGeneration;
        this._pmPsNonNull = psNonNull;
        this._pmValid = true;
    }

    private resolveProgrammablePipeline(
        topology: D3D9DrawTopology,
        forceCullNone: boolean,
        strideOverride?: number,
        slotMask: number = this.activeSlotMask(),
        pointExpansion = false,
        arenaSpec?: ArenaRecordSpec,
        attributeDraw = true,
    ): number {
        this.pendingArenaRecord = null;
        // See resolvePipelineId: cull rides the numeric key, so the toggle joins here.
        forceCullNone = forceCullNone || this.debugFlags.forceCullNone;

        // ── Prologue memo ────────────────────────────────────────────────────
        // Everything from here to the last-resolve compare is derived state; when none
        // of its inputs moved, that compare's answer cannot have changed either. Both
        // the memo hit and the compare hit return through _programmablePipelineReuse,
        // so the shortcut cannot skip a side effect the compare would have run.
        // Stage profile (default off): where a HIT's time goes, split into the guard, the
        // marginal cost of the streamHash inside it, and the shared reuse tail.
        const prof = pipelineMemoProfiling();
        let tEntry = 0;
        if (prof) {
            const c0 = performance.now();
            const c1 = performance.now();
            notePipelineMemoProf(PROF_CLOCK, c1 - c0);
            tEntry = performance.now();
        }
        const memoKeyMatches = this._pipelineMemoMatches(
            topology, forceCullNone, strideOverride, slotMask, pointExpansion);
        if (prof) notePipelineMemoProf(PROF_GUARD, performance.now() - tEntry);
        const memoVerify = memoKeyMatches && pipelineMemoVerifying();
        if (memoKeyMatches && !memoVerify && pipelineMemoEnabled()) {
            notePipelineMemoHit();
            if (!prof) return this._programmablePipelineReuse(arenaSpec, this._pmPsNonNull, attributeDraw);
            const t0 = performance.now();
            const reused = this._programmablePipelineReuse(arenaSpec, this._pmPsNonNull, attributeDraw);
            const t1 = performance.now();
            notePipelineMemoProf(PROF_TAIL, t1 - t0);
            // guard + tail as one span. It carries the two probe clock reads between them —
            // bounded by the reported clockUs, and the probes below are outside it entirely.
            notePipelineMemoProf(PROF_HIT, t1 - tEntry);
            // streamHash is pure: an extra call after the timed span measures its marginal
            // cost without perturbing either of the numbers it is meant to explain.
            const h0 = performance.now();
            this.streamHash(slotMask, strideOverride ?? 0);
            notePipelineMemoProf(PROF_HASH, performance.now() - h0);
            return reused;
        }

        if (!this.rasterStateSupported(topology)) {
            if (memoVerify) notePipelineMemoMismatch("bail:rasterStateSupported");
            return -1;
        }
        const unsupportedSampler = this.firstUnsupportedSamplerStage(true);
        if (unsupportedSampler !== null) {
            if (memoVerify) notePipelineMemoMismatch("bail:unsupportedSamplerStage");
            Logger.error(LogCategory.D3D9,
                `[D3D9] sampler stage ${unsupportedSampler.stage} uses unsupported feature ` +
                `${unsupportedSampler.reason}; refusing draw`);
            return -1;
        }
        const vs = this.getActiveVsShader();
        if (!vs) {
            if (memoVerify) notePipelineMemoMismatch("bail:noVertexShader");
            return -1;
        }
        const ps = this.getActivePsShader();
        const hybridStages = ps ? 0 : this.activeStageCount();
        if (!ps && this.boundVolumeMask() !== 0) {
            if (memoVerify) notePipelineMemoMismatch("bail:volumeWithoutPs");
            Logger.error(LogCategory.D3D9, "[D3D9] pixel volume texture requires a programmable pixel shader; refusing hybrid FFP draw");
            return -1;
        }
        const samplerResolved = this.samplerShaderStatesResolved(vs, ps, hybridStages);
        const samplerStates = samplerResolved.states;
        const samplerKey = samplerResolved.key;
        const samplerNeedsShaderVariant = samplerResolved.needsVariant;
        const pointSpriteEnable = pointExpansion && this.getRS(D3DRS_POINTSPRITEENABLE) !== 0;
        const activeFvf = this.stateTracker.getFVF() >>> 0;
        const declElements = this.activeVertexDecl > 0
            ? (this.vsDeclRegistry.get(this.activeVertexDecl) ?? null)
            : activeFvf !== 0 ? makeFvfDeclaration(activeFvf) : null;
        // A programmable VS still consumes the active FVF declaration. Refuse an
        // unrepresentable weighted format instead of silently falling back to a tight FLOAT4
        // layout that would read the wrong bytes for every vertex.
        if (activeFvf !== 0 && this.activeVertexDecl === 0 && declElements === null) {
            if (memoVerify) notePipelineMemoMismatch("bail:unrepresentableFvfDecl");
            return -1;
        }
        const streamSource = this.stateTracker.getStreamSource();
        const stride = strideOverride ?? streamSource?.stride ?? null;
        const stateBits = this.stateTracker.computePipelineKey() & 0x7FF0000;
        // The layout has one entry per slot the draw will bind, so EVERY one of their strides
        // is part of the pipeline identity — not just slot 0's. One hash over the used slots.
        const multiSlot = !!declElements && declElements.length > 0 && (slotMask & ~1) !== 0;
        if (multiSlot && slotMaskExceedsLimit(slotMask, this.maxVertexBufferSlots())) {
            if (memoVerify) notePipelineMemoMismatch("bail:streamSlotOverLimit");
            d3d9DropDraw("pipeline:streamSlotOverLimit");
            return -1;
        }
        const streamStrides = multiSlot ? this.slotStrides(stride ?? 0) : null;
        const streamHash = this.streamHash(slotMask, stride ?? 0);

        // Pre-transformed declaration + a bound pixel shader: the fixed function owns the VERTEX
        // stage, the shader keeps the pixel stage (Wine use_vs/use_ps). The viewport is baked
        // into the generated vertex entry, so it is part of the pipeline identity — and both
        // fast paths below key on state that does not carry it, so those are skipped.
        const ptSize = this.getCurrentTargetSize();
        const preTransformed = this.activeDeclIsPreTransformed()
            ? {
                viewportWidth: this.viewport.width || ptSize.w,
                viewportHeight: this.viewport.height || ptSize.h,
                pixelCenterOffset: pixelCenterOffsetPx(),
            }
            : null;
        const programmableClipPlanes = this.getRS(D3DRS_CLIPPLANEENABLE) !== 0 && preTransformed === null;
        const ptKey = preTransformed
            ? `:pt${preTransformed.viewportWidth}x${preTransformed.viewportHeight}c${preTransformed.pixelCenterOffset}`
            : "";

        const alphaTest = this.getAlphaTest();
        // Effective cube mask (dcl_cube ∪ bound cube textures) — part of the pipeline identity since
        // the same shader sampled with a 2D vs a cube texture compiles to different texN dimensions.
        const comparisonSamplers = ps ? this.boundComparisonSamplers() : EMPTY_COMPARISON_SAMPLERS;
        const comparisonMask = ps ? this.boundComparisonMask() : 0;
        const comparisonKey = ps ? this.boundComparisonKey() : "";
        // A live depth resource fixes the stage to texture_depth_2d even if stale or
        // mismatched bytecode declared a cube sampler there.
        const cubeMask = (computeCubeMask(ps) | this.boundCubeMask()) & ~comparisonMask;
        const volumeMask = ps ? ((computeVolumeMask(ps) | this.boundVolumeMask()) & ~comparisonMask) : 0;
        const vertexVolumeMask = computeVertexVolumeMask(vs) | this.boundVertexVolumeMask();
        // Per-stage D3DTTFF_PROJECTED key — part of the pipeline identity: the same ps_1_x shader
        // compiles to a projective-divide sample vs a plain sample depending on the stage flag.
        // The pipeline descriptor also carries D3DRS_MULTISAMPLEMASK/ANTIALIAS, folded into the
        // depth fragment so the last-resolve and string caches cannot reuse a pipeline built
        // for a different sample coverage state. All five come from one memo (refreshStateKeys).
        this.refreshStateKeys();
        const projKey = this.stateKeyProjected;
        const blendKey = this.stateKeyBlend;
        const alphaKey = this.stateKeyAlpha;
        const depthKey = this.stateKeyDepth;
        const targetKey = this.stateKeyTarget;
        if (targetKey === "invalid") {
            if (memoVerify) notePipelineMemoMismatch("bail:invalidTarget");
            return -1;
        }
        const writesColor = ps?.analysis.writesColor ?? [true, false, false, false];
        for (let i = 1; i < writesColor.length; i++) {
            if (writesColor[i] && this.renderTargetIndices[i] === null) {
                if (memoVerify) notePipelineMemoMismatch("bail:mrtTargetUnbound");
                Logger.error(LogCategory.D3D9,
                    `[D3D9] MRT: pixel shader writes oC${i}, but render target ${i} is not bound`);
                return -1;
            }
        }

        const arenaBaseEligible = !!arenaSpec && ps !== null && isWasmPathEnabled()
            && d3d9WasmArena.isInitialized();
        let arenaKey: number | undefined;
        let arenaIdentity: string | undefined;
        let arenaIdentityWords: Uint32Array | undefined;

        // Fast path: identical pipeline identity as the previous draw → return without building
        // the large canonical key. Arena identity is pure over the fields compared below, so a
        // matching arena memo reuses its already-mixed words and records the row only after this
        // numeric comparison succeeds. This keeps arena setup behind the same last-resolve gate.
        const lastResolveMatches = !pointExpansion && !preTransformed && !programmableClipPlanes && this._lrValid
            && this._lrVs === this.activeVertexShader && this._lrPs === this.activePixelShader
            && this._lrDecl === this.activeVertexDecl && this._lrFvf === activeFvf && this._lrStride === stride
            && this._lrStateBits === stateBits && this._lrTopo === topology
            && this._lrForceCull === forceCullNone && this._lrBlend === blendKey
            && this._lrAlpha === alphaKey && this._lrDepth === depthKey
            && this._lrCube === cubeMask && this._lrComparison === comparisonMask
            && this._lrComparisonKey === comparisonKey
            && this._lrVolume === volumeMask && this._lrVertexVolume === vertexVolumeMask
            && this._lrProj === projKey && this._lrHybridStages === hybridStages
            && this._lrSamplerKey === samplerKey
            && this._lrStreamHash === streamHash
            && this._lrTarget === targetKey;
        if (lastResolveMatches) {
            if (memoVerify) notePipelineMemoAgree();
            this._armPipelineMemo(topology, forceCullNone, strideOverride, slotMask, pointExpansion,
                stride, streamHash, ps !== null);
            return this._programmablePipelineReuse(arenaSpec, ps !== null, attributeDraw);
        }
        if (memoVerify) notePipelineMemoMismatch("lastResolveMatches:false");

        // We only assemble/hash the canonical identity after the numeric memo misses. The
        // compact Rust hash remains a bucket; the full readable key prevents omitted-field and
        // compact-hash aliases in the JS pipeline cache.
        const arenaEligible = arenaBaseEligible && this.arenaCanRepresentCurrentSamplerBank();
        if (arenaEligible && arenaSpec) {
            const identity = this.prepareArenaPipelineIdentity(topology, forceCullNone, strideOverride, slotMask, pointExpansion);
            arenaKey = this.recordArenaSpec(arenaSpec, identity);
            if (arenaKey !== undefined) {
                arenaIdentity = identity.key;
                arenaIdentityWords = identity.words;
            }
        }
        const arenaCacheKey = ps && arenaKey !== undefined && arenaIdentity !== undefined
            ? this.arenaPipelineCacheKey(arenaKey, arenaIdentity)
            : null;
        if (isWasmPathEnabled() && arenaCacheKey !== null) {
            const cachedViaArena = this.arenaPipelineCache.get(arenaCacheKey);
            if (cachedViaArena !== undefined) {
                d3d9PerfBackendInc("progPipelineCacheHits");
                if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheHits++;
                if (!preTransformed) {
                    this._storeLastResolve(stride, stateBits, topology, forceCullNone, blendKey, alphaKey, depthKey, cubeMask, comparisonMask, comparisonKey, volumeMask, vertexVolumeMask, projKey, hybridStages, samplerKey, streamHash, targetKey, cachedViaArena, arenaIdentity, arenaIdentityWords);
                    if (!pointExpansion && !programmableClipPlanes) {
                        this._armPipelineMemo(topology, forceCullNone, strideOverride, slotMask, pointExpansion, stride, streamHash, ps !== null);
                    }
                }
                if (arenaIdentity !== undefined) this.backendExecutor.registerArenaPipelineIdentity(arenaIdentity, cachedViaArena);
                return this.programmablePipelineResult(cachedViaArena, attributeDraw);
            }
        }

        const cacheKey = `${this.activeVertexShader}:${this.activePixelShader}:${this.activeVertexDecl}:fvf${this.stateTracker.getFVF() >>> 0}:${stateBits}:${topology}:${forceCullNone ? 1 : 0}:pe${pointExpansion ? 1 : 0}:ps${pointSpriteEnable ? 1 : 0}:cp${programmableClipPlanes ? 1 : 0}:${blendKey}:${alphaKey}:${depthKey}:cm${cubeMask}:dm${comparisonMask}:dc${comparisonKey}:vm${volumeMask}:vvm${vertexVolumeMask}:pj${projKey}:hs${hybridStages}:sm${samplerKey}:rt${targetKey}${ptKey}${this.streamKey(slotMask, stride ?? 0)}`;
        const cached = this.progPipelineCache.get(cacheKey);
        if (cached !== undefined) {
            d3d9PerfBackendInc("progPipelineCacheHits");
            if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheHits++;
            if (!preTransformed) {
                this._storeLastResolve(stride, stateBits, topology, forceCullNone, blendKey, alphaKey, depthKey, cubeMask, comparisonMask, comparisonKey, volumeMask, vertexVolumeMask, projKey, hybridStages, samplerKey, streamHash, targetKey, cached, arenaIdentity, arenaIdentityWords);
                if (!pointExpansion && !programmableClipPlanes) {
                    this._armPipelineMemo(topology, forceCullNone, strideOverride, slotMask, pointExpansion, stride, streamHash, ps !== null);
                }
            }
            if (arenaIdentity !== undefined) this.backendExecutor.registerArenaPipelineIdentity(arenaIdentity, cached);
            if (isWasmPathEnabled() && arenaCacheKey !== null) this.cacheArenaPipeline(arenaCacheKey, cached);
            return this.programmablePipelineResult(cached, attributeDraw);
        }
        d3d9PerfBackendInc("progPipelineCacheMisses");
        if (this.frameSnapshot.frameCounters) this.frameSnapshot.frameCounters.cacheMisses++;

        const pipelineId = this.buildProgrammablePipeline(vs, ps, declElements, stride, stateBits, topology, forceCullNone, alphaTest, cubeMask, volumeMask, vertexVolumeMask, comparisonSamplers, samplerStates, projKey, hybridStages, streamStrides, preTransformed, pointExpansion, pointSpriteEnable, programmableClipPlanes, arenaIdentity);
        this.progPipelineCache.set(cacheKey, pipelineId);
        if (isWasmPathEnabled() && arenaCacheKey !== null) this.cacheArenaPipeline(arenaCacheKey, pipelineId);
        if (!preTransformed) {
            this._storeLastResolve(stride, stateBits, topology, forceCullNone, blendKey, alphaKey, depthKey, cubeMask, comparisonMask, comparisonKey, volumeMask, vertexVolumeMask, projKey, hybridStages, samplerKey, streamHash, targetKey, pipelineId, arenaIdentity, arenaIdentityWords);
            if (!pointExpansion && !programmableClipPlanes) {
                this._armPipelineMemo(topology, forceCullNone, strideOverride, slotMask, pointExpansion, stride, streamHash, ps !== null);
            }
        }
        return this.programmablePipelineResult(pipelineId, attributeDraw);
    }

    /** Pure pipeline build — shared by the legacy string-keyed miss path and the arena
     *  numeric-keyed miss path above. Reads no cache/mutable resolve state itself. */
    private buildProgrammablePipeline(
        vs: CompiledVs,
        ps: CompiledPs | null,
        declElements: RawVertexElement[] | null,
        stride: number | null,
        stateBits: number,
        topology: D3D9DrawTopology,
        forceCullNone: boolean,
        alphaTest: ReturnType<D3D9Device["getAlphaTest"]>,
        cubeMask: number,
        volumeMask: number,
        vertexVolumeMask: number,
        comparisonSamplers: ReadonlyMap<number, { clampDref?: boolean }>,
        samplerStates: ReadonlyMap<number, SamplerSpec>,
        projectedStages: number,
        hybridStages: number,
        streamStrides: number[] | null,
        preTransformed: { viewportWidth: number; viewportHeight: number } | null = null,
        pointExpansion = false,
        pointSpriteEnable = false,
        clipPlanes = false,
        arenaIdentity?: string,
    ): number {
        const pair = this.beginShaderPair(vs, ps);
        try {
            const link = linkProgram({ vs, ps, declElements, streamStride: stride, streamStrides, alphaTest, cubeMask, volumeMask, vertexVolumeMask, comparisonSamplers, samplerStates, projectedStages, ffpStageCount: hybridStages || undefined, preTransformed, pointExpansion, pointSpriteEnable, clipPlanes });
            this.recordShaderCensus(pair, link);
            if (link.interpolantBudgetExceeded) {
                throw new Error("D3D9 shader link exceeds WebGPU inter-stage interpolant budget");
            }
            const gpuDevice = this.backend.getDevice()!;
            const colorTargets = this.activeColorTargetStates();
            if (!colorTargets) return -1;
            const module = gpuDevice.createShaderModule({ code: link.wgsl });
            this.observeShaderCompilation(module, pair, `programmable:${pair.handle}`);
            // Cube-sampler stages need a cube-dimension bind-group layout; pick the variant that
            // matches the shader's declared texN dimensions (link.cubeMask == our effective mask).
            const { pipelineLayout } = this.backendExecutor.getProgrammableLayout(link.cubeMask, link.comparisonMask, link.volumeMask, link.vertexVolumeMask);

            const cullD3D = (stateBits >> 16) & 0xff;
            let cullMode: GPUCullMode = "none";
            if (!forceCullNone) {
                if (cullD3D === D3DCULL_CW) cullMode = "front";
                else if (cullD3D === D3DCULL_CCW) cullMode = "back";
            }
            // One layout per stream the declaration spans. A declaration addresses its elements
            // as (stream, offset) and each stream steps by ITS OWN stride, so folding them into
            // a single slot-0 layout reads every non-zero stream's attributes out of stream 0 —
            // and sizes the draw against the wrong stride, which WebGPU rejects (invalidating
            // the whole frame's command buffer, not just the draw).
            const buffers: (GPUVertexBufferLayout | null)[] = applyStepModes(streamStrides
                ? link.vertexBuffers
                : [{
                    arrayStride: (stride && stride > 0) ? stride : link.arrayStride,
                    attributes: link.vertexAttributes,
                }], this.streams.freq);
            if (!validateWebGpuVertexBufferStrides(buffers, "programmable")) return -1;
            gpuDevice.pushErrorScope("validation");
            let pipeline: GPURenderPipeline;
            try {
                pipeline = gpuDevice.createRenderPipeline({
                    layout: pipelineLayout,
                    vertex: {
                        module,
                        entryPoint: "vs_main",
                        buffers,
                    },
                    fragment: { module, entryPoint: "fs_main", targets: colorTargets },
                    primitive: {
                        topology, frontFace: "cw", cullMode,
                        ...(topology === "triangle-strip" ? { stripIndexFormat: "uint16" as const } : {}),
                    },
                    multisample: {
                        count: this.activeRenderTargetSampleCount(),
                        mask: this.getRS(D3DRS_MULTISAMPLEMASK) >>> 0,
                    },
                    depthStencil: buildDepthStencilState(this.activeDepthTargetFormat(), this.getRS),
                });
            } catch (error) {
                void gpuDevice.popErrorScope().catch(() => undefined);
                throw error;
            }
            this.observePipelineValidation(gpuDevice, pair, `programmable-pipeline:${pair.handle}`);
            const pipelineId = this.backendExecutor.registerPipeline(pipeline, link.hasTexture, true,
                1, layoutStrides(buffers), layoutAttributeEnds(buffers), arenaIdentity);
            // Exact programmable MegaBatch variant. It is created while the complete shader
            // and fixed pipeline descriptor are still available; GPURenderPipeline itself is
            // intentionally opaque and cannot be cloned later by the executor.
            const hasInstanceRateStream = buffers.some(buffer => buffer?.stepMode === "instance");
            // An explicit false is the A/B kill switch and avoids companion shader compilation.
            if (!preTransformed && !pointExpansion && !hasInstanceRateStream
                && !shaderUsesIntegerBoolean(vs.prog)
                && (globalThis as { __d3d9MegaBatch?: boolean }).__d3d9MegaBatch !== false) {
                try {
                    const megaLink = linkProgram({
                        vs, ps, declElements, streamStride: stride, streamStrides, alphaTest,
                        cubeMask, volumeMask, vertexVolumeMask, comparisonSamplers, samplerStates,
                        projectedStages, ffpStageCount: hybridStages || undefined,
                        pointSpriteEnable, clipPlanes, vsConstantMode: "instance-storage",
                    });
                    if (!megaLink.interpolantBudgetExceeded && megaLink.vsStorageSlotBytes > 0) {
                        const megaModule = gpuDevice.createShaderModule({ code: megaLink.wgsl });
                        this.observeShaderCompilation(megaModule, null, `programmable-megabatch:${pair.handle}`);
                        const megaLayout = this.backendExecutor.getProgrammableLayout(
                            megaLink.cubeMask, megaLink.comparisonMask,
                            megaLink.volumeMask, megaLink.vertexVolumeMask, true,
                        );
                        gpuDevice.pushErrorScope("validation");
                        const megaPipeline = gpuDevice.createRenderPipeline({
                            layout: megaLayout.pipelineLayout,
                            vertex: { module: megaModule, entryPoint: "vs_main", buffers },
                            fragment: { module: megaModule, entryPoint: "fs_main", targets: colorTargets },
                            primitive: {
                                topology, frontFace: "cw", cullMode,
                                ...(topology === "triangle-strip" ? { stripIndexFormat: "uint16" as const } : {}),
                            },
                            multisample: {
                                count: this.activeRenderTargetSampleCount(),
                                mask: this.getRS(D3DRS_MULTISAMPLEMASK) >>> 0,
                            },
                            depthStencil: buildDepthStencilState(this.activeDepthTargetFormat(), this.getRS),
                        });
                        this.observePipelineValidation(gpuDevice, null, `programmable-megabatch-pipeline:${pair.handle}`);
                        this.backendExecutor.attachMegaBatchPipeline(
                            pipelineId, megaPipeline, megaLink.vsStorageSlotBytes,
                        );
                    }
                } catch (error) {
                    // MegaBatch is an optional companion to the exact programmable pipeline.
                    // A variant build failure must never invalidate that base pipeline.
                    this.shaderBuildFailures++;
                    Logger.warn(LogCategory.D3D9, `[D3D9] MegaBatch variant unavailable: ${error}`);
                }
            }
            pair.build = "built";
            pair.pipelineId = pipelineId;
            this.shaderPipelinePairs.set(pipelineId, pair.handle);
            return pipelineId;
        } catch (e) {
            this.shaderBuildFailures++;
            pair.build = "failed";
            pair.error = String(e);
            Logger.error(LogCategory.D3D9,
                `[D3D9] programmable pipeline build failed: pair=${pair.handle} pipeline=-1: ${e}`);
            return -1;
        }
    }

    /** Remember the just-resolved pipeline identity for the next-draw numeric fast path. VS/PS/decl
     *  come from the current device state (unchanged across the resolve). */
    private _storeLastResolve(stride: number | null, stateBits: number, topo: string, forceCull: boolean,
        blend: string, alpha: string, depth: string, cube: number, comparison: number, comparisonKey: string,
        volume: number, vertexVolume: number, proj: number, hybridStages: number,
        samplerKey: string, streamHash: number, targetKey: string, id: number,
        arenaIdentity?: string, arenaIdentityWords?: Uint32Array): void {
        this._lrVs = this.activeVertexShader; this._lrPs = this.activePixelShader; this._lrDecl = this.activeVertexDecl; this._lrFvf = this.stateTracker.getFVF() >>> 0;
        this._lrStride = stride; this._lrStateBits = stateBits; this._lrTopo = topo; this._lrForceCull = forceCull;
        this._lrBlend = blend; this._lrAlpha = alpha; this._lrDepth = depth; this._lrCube = cube; this._lrComparison = comparison; this._lrComparisonKey = comparisonKey; this._lrVolume = volume; this._lrVertexVolume = vertexVolume; this._lrProj = proj; this._lrHybridStages = hybridStages; this._lrSamplerKey = samplerKey; this._lrStreamHash = streamHash; this._lrTarget = targetKey; this._lrPipelineId = id; this._lrArenaIdentity = arenaIdentity; this._lrArenaIdentityWords = arenaIdentityWords ? new Uint32Array(arenaIdentityWords) : undefined; this._lrValid = true;
    }

    /** Bitmask of stages that currently have a CUBE texture bound. D3D9 ps_1_x / FFP have no
     *  sampler dcls, so cube reflections (NFSU) are only detectable from the bound texture's type;
     *  this is unioned with the PS's declared dcl_cube mask to form the effective cube mask used
     *  for the pipeline layout + shader codegen + bind group (all three must agree). */
    /**
     * The four "what is bound right now" answers below are all functions of the texture bank
     * alone — a format IS resource identity, so they change exactly when a different texture
     * is bound (or a volume is registered/released). Every programmable draw asks for all of
     * them twice (pipeline resolve + draw-state capture), and each was a fresh 16-stage walk,
     * with the comparison map a fresh allocation on top. Resolve them once per bank
     * generation instead — the same generation the arena representability memo already
     * trusts for the same reason.
     */
    private boundBankGeneration = -1;
    private boundBankCubeMask = 0;
    private boundBankVolumeMask = 0;
    private boundBankVertexVolumeMask = 0;
    private boundBankComparison: Map<number, { clampDref?: boolean }> = EMPTY_COMPARISON_SAMPLERS;
    private boundBankComparisonMask = 0;
    private boundBankComparisonKey = "";

    private refreshBoundBank(): void {
        if (this.boundBankGeneration === this.arenaSamplerBankGeneration
            && !(globalThis as { __noD3D9KeyMemo?: boolean }).__noD3D9KeyMemo) return;
        this.boundBankGeneration = this.arenaSamplerBankGeneration;
        let cube = 0;
        let volume = 0;
        let vertexVolume = 0;
        let comparison: Map<number, { clampDref?: boolean }> | null = null;
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            const ti = this.stateTracker.getTexture(stage);
            if (ti === null) continue;
            if (this.isVolumeIndex(ti)) { volume |= (1 << stage); continue; }
            if (this.textures.isCubeMap(ti)) { cube |= (1 << stage); continue; }
            const format = this.textures.getFormat(ti);
            if (isDxDepthStencilFormat(format, 9)) {
                if (comparison === null) comparison = new Map<number, { clampDref?: boolean }>();
                comparison.set(stage, (format === 71 || format === 84) ? { clampDref: true } : {});
            }
        }
        for (let n = 0; n < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            if (this.isVolumeIndex(this.stateTracker.getTexture(D3D9_VERTEX_TEXTURE_SAMPLER_BASE + n))) {
                vertexVolume |= (1 << n);
            }
        }
        this.boundBankCubeMask = cube;
        this.boundBankVolumeMask = volume;
        this.boundBankVertexVolumeMask = vertexVolume;
        this.boundBankComparison = comparison ?? EMPTY_COMPARISON_SAMPLERS;
        // Depth sampling has a format-specific Dref clamp lowering, so the canonical identity
        // needs the per-stage flag, not just the mask. Built here for the same reason as the
        // masks: it is a function of the bank, and both the pipeline resolve and the draw-state
        // capture ask for it on every draw.
        let comparisonMask = 0;
        for (const stage of this.boundBankComparison.keys()) comparisonMask |= 1 << stage;
        this.boundBankComparisonMask = comparisonMask;
        this.boundBankComparisonKey = comparisonMask === 0
            ? ""
            : Array.from(this.boundBankComparison.entries())
                .sort(([a], [b]) => a - b)
                .map(([stage, spec]) => `${stage}:${spec.clampDref ? 1 : 0}`)
                .join(",");
    }

    private boundCubeMask(): number {
        this.refreshBoundBank();
        return this.boundBankCubeMask;
    }

    /** Bitmask of pixel sampler stages currently backed by a CPU volume resource. */
    private boundVolumeMask(): number {
        this.refreshBoundBank();
        return this.boundBankVolumeMask;
    }

    /** Bitmask of VS vertex-texture stages currently backed by a CPU volume resource. */
    private boundVertexVolumeMask(): number {
        this.refreshBoundBank();
        return this.boundBankVertexVolumeMask;
    }

    /** Standard D3D9 depth formats are shadow resources unless they are unsupported
     * vendor FOURCC variants. The format is resource identity, so this mask changes
     * exactly when a different texture is bound. */
    private boundComparisonSamplers(): Map<number, { clampDref?: boolean }> {
        this.refreshBoundBank();
        return this.boundBankComparison;
    }

    private boundComparisonMask(): number {
        this.refreshBoundBank();
        return this.boundBankComparisonMask;
    }

    private boundComparisonKey(): string {
        this.refreshBoundBank();
        return this.boundBankComparisonKey;
    }

    /** The Rust arena ABI remains at its stable eight-texture layout. Route any draw whose
     * effective state reaches s8..s15 through the complete TypeScript snapshot/key path. */
    private arenaCanRepresentCurrentSamplerBank(): boolean {
        const vsHandle = this.activeVertexShader;
        const psHandle = this.activePixelShader;
        if (this.arenaBankCheckGeneration === this.arenaSamplerBankGeneration
            && this.arenaBankCheckVs === vsHandle && this.arenaBankCheckPs === psHandle) {
            return this.arenaBankCheckResult;
        }
        // The Rust state mirror has no vertex-texture window. Keep those draws on the
        // complete RenderFrame path until the ABI carries stages 257..260; admitting them
        // would make the compact arena key appear complete while resources still come from
        // a different, unmirrored state bank.
        const vs = this.getActiveVsShader();
        if (vs && !arenaSupportsVertexSamplerBank(vs.prog.samplersUsed)) {
            this.arenaBankCheckGeneration = this.arenaSamplerBankGeneration;
            this.arenaBankCheckVs = vsHandle;
            this.arenaBankCheckPs = psHandle;
            this.arenaBankCheckResult = false;
            return false;
        }
        const sampledStages = this.getActivePsShader()?.analysis.samplers ?? [];
        const result = arenaSupportsFragmentSamplerBank(
            sampledStages,
            stage => this.stateTracker.getTexture(stage) !== null,
        );
        this.arenaBankCheckGeneration = this.arenaSamplerBankGeneration;
        this.arenaBankCheckVs = vsHandle;
        this.arenaBankCheckPs = psHandle;
        this.arenaBankCheckResult = result;
        return result;
    }

    /** Sampler intent baked into programmable shader variants. Fragment stages use their D3D9
     * API indices directly; vertex-texture declarations use the separate 257..260 API window. */
    /**
     * The sampler specs for one draw together with their pipeline-key fragment and the
     * shader-variant flag derived from them — memoised on the sampler bank's own generation
     * and the exact shader pair asked about.
     *
     * Every programmable draw needs all three, and building them costs a Map, one decoded
     * SamplerSpec per active stage and a string join. That is per DRAW, not per state change,
     * and the bank changes a few times a frame while a title issues a thousand draws
     * (measured at 3.5% of the whole worker thread on NFS Underground). The memo is a small
     * ring rather than one slot because a frame alternates between a handful of shader pairs
     * and a single slot would thrash on every material switch.
     */
    private samplerShaderStateMemo: Array<{
        gen: number; vs: CompiledVs | null; ps: CompiledPs | null; hybridStages: number;
        states: ReadonlyMap<number, SamplerSpec>; key: string; needsVariant: boolean;
    }> = [];
    private samplerShaderStateMemoNext = 0;

    private samplerShaderStatesResolved(
        vs: CompiledVs | null,
        ps: CompiledPs | null,
        hybridStages: number,
    ): { states: ReadonlyMap<number, SamplerSpec>; key: string; needsVariant: boolean } {
        // A/B: `__noD3D9KeyMemo` rebuilds every per-draw key fragment the way this path did
        // before the memos, so the win they are worth can be measured in one session instead
        // of argued about across two boots.
        if ((globalThis as { __noD3D9KeyMemo?: boolean }).__noD3D9KeyMemo) {
            const states = this.samplerShaderStates(vs, ps, hybridStages);
            return { states, key: dxSamplerShaderStatesKey(states), needsVariant: this.samplerNeedsShaderVariant(states) };
        }
        const gen = this.samplerStateGeneration;
        for (let i = 0; i < this.samplerShaderStateMemo.length; i++) {
            const e = this.samplerShaderStateMemo[i]!;
            if (e.gen === gen && e.vs === vs && e.ps === ps && e.hybridStages === hybridStages) return e;
        }
        const states = this.samplerShaderStates(vs, ps, hybridStages);
        const entry = {
            gen, vs, ps, hybridStages,
            states,
            key: dxSamplerShaderStatesKey(states),
            needsVariant: this.samplerNeedsShaderVariant(states),
        };
        if (this.samplerShaderStateMemo.length < 4) this.samplerShaderStateMemo.push(entry);
        else {
            this.samplerShaderStateMemo[this.samplerShaderStateMemoNext] = entry;
            this.samplerShaderStateMemoNext = (this.samplerShaderStateMemoNext + 1) & 3;
        }
        return entry;
    }

    private samplerShaderStates(
        vs: CompiledVs | null,
        ps: CompiledPs | null,
        hybridStages: number,
    ): ReadonlyMap<number, SamplerSpec> {
        const states = new Map<number, SamplerSpec>();
        const add = (stage: number): void => {
            if (stage < 0 || stage >= D3D9_VERTEX_TEXTURE_SAMPLER_BASE + D3D9_VERTEX_TEXTURE_SAMPLER_COUNT) return;
            states.set(stage, this.samplerSpecForStage(stage));
        };
        if (ps) {
            for (const stage of ps.analysis.samplers) {
                if (stage >= 0 && stage < PROG_BIND.MAX_TEX) add(stage);
            }
        } else {
            for (let stage = 0; stage < Math.min(hybridStages, PROG_BIND.MAX_TEX); stage++) add(stage);
        }
        if (vs) {
            for (const stage of vs.prog.samplersUsed) {
                if (stage >= 0 && stage < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT) {
                    add(D3D9_VERTEX_TEXTURE_SAMPLER_BASE + stage);
                }
            }
        }
        return states;
    }

    /** Custom address modes and non-zero LOD bias change generated WGSL. Native sampler state
     * changes remain represented by the GPUSampler bind state and need no shader variant. */
    private samplerNeedsShaderVariant(states: ReadonlyMap<number, SamplerSpec>): boolean {
        for (const spec of states.values()) {
            if (spec.addressU === "d3d9-border" || spec.addressU === "d3d9-mirror-once"
                || spec.addressV === "d3d9-border" || spec.addressV === "d3d9-mirror-once"
                || spec.addressW === "d3d9-border" || spec.addressW === "d3d9-mirror-once") return true;
            if (spec.mipLodBias !== undefined
                && (spec.mipLodBias !== 0 || !Number.isFinite(spec.mipLodBias))) return true;
        }
        return false;
    }

    /** Return a bound sampler stage whose D3D sampler semantics have no native WebGPU path.
     * Such a draw must be refused before bind-group construction; a null sampler would otherwise
     * select the executor fallback and silently change texels. */
    private firstUnsupportedSamplerStage(_allowShaderEmulation = false): { stage: number; reason: string } | null {
        const check = (stage: number): { stage: number; reason: string } | null => {
            const texture = this.stateTracker.getTexture(stage);
            if (texture === null) return null;
            const spec = this.samplerSpecForStage(stage);
            const reason = DxSamplerCache.unsupportedReason(spec);
            if (reason !== null) return { stage, reason };
            const hasLodBias = spec.mipLodBias !== undefined
                && (spec.mipLodBias !== 0 || !Number.isFinite(spec.mipLodBias));
            // BORDER/MIRRORONCE, ordinary LOD bias, and comparison-sampler bias are lowered
            // by the shader emitters. Comparison paths reconstruct the implicit footprint and
            // use textureSampleCompareLevel because WGSL has no compare-bias/compare-grad form.
            return null;
        };
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            const unsupported = check(stage);
            if (unsupported !== null) return unsupported;
        }
        for (let n = 0; n < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            const unsupported = check(D3D9_VERTEX_TEXTURE_SAMPLER_BASE + n);
            if (unsupported !== null) return unsupported;
        }
        return null;
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
        for (let stage = 0; stage < stages.length; stage++) {
            const st = stages[stage]!;
            // The stage combiner implements a SUBSET of D3DTEXTUREOP and silently substitutes a
            // fallback expression for the rest — in the alpha channel that fallback is the raw
            // texel alpha, which then decides the alpha test. So an unimplemented op does not
            // tint a surface, it deletes it. Histogram every op, not just the missing ones:
            // "nothing missing" is only trustworthy next to the distribution it was read from.
            d3d9PerfFfpOp("color", st.colorOp);
            d3d9PerfFfpOp("alpha", st.alphaOp);
            if (st.colorOp !== D3DTOP_DISABLE && !FFP_IMPLEMENTED_OPS.has(st.colorOp)) {
                d3d9PerfFfpUnimplemented(`colorOp${st.colorOp}`);
            }
            if (st.alphaOp !== D3DTOP_DISABLE && !FFP_IMPLEMENTED_OPS.has(st.alphaOp)) {
                d3d9PerfFfpUnimplemented(`alphaOp${st.alphaOp}`);
            }
            const tci = st.texCoordIndex;
            // Generators 0..4 are implemented; anything above is outside the documented
            // D3DTSS_TCI_* enum and would fall through to passthrough unnoticed.
            if (((tci >>> 16) & 0xffff) > 4) d3d9PerfFfpUnimplemented("texCoordGen");
            // Declaration and FVF FFP paths both expose all eight packed coordinate sets.
            const coordSet = tci & 0xffff;
            if (coordSet > 7) {
                const decl = this.activeVertexDecl > 0 ? this.vsDeclRegistry.get(this.activeVertexDecl) : null;
                const declared = decl
                    ? !!decl.some(e => e.usage === DECLUSAGE_TEXCOORD_FFP && e.usageIndex === coordSet)
                    : parseFvf(this.stateTracker.getFVF()).texCount > coordSet;
                if (!declared) d3d9PerfFfpUnimplemented("texCoordSet");
            }

            // WebGPU has no clamp-to-border or mirror-once sampler modes.  The emitted
            // coordinate/border branches preserve the common point/linear result, but they
            // cannot reproduce filtering across the exact D3D edge footprint. Keep this
            // visible in the per-frame census instead of presenting it as native parity.
            if (this.stateTracker.getTexture(stage) !== null) {
                const sampler = this.samplerSpecForStage(stage);
                if (sampler.addressU === "d3d9-border" || sampler.addressV === "d3d9-border") {
                    d3d9PerfApproximation(`sampler${stage}:border`);
                }
                if (sampler.addressU === "d3d9-mirror-once" || sampler.addressV === "d3d9-mirror-once") {
                    d3d9PerfApproximation(`sampler${stage}:mirror-once`);
                }
            }
        }
    }

    /** Snapshot the full FFP uniform block + stage-0 texture for one draw. The
     *  guest mutates transforms/stage-ops/TFACTOR/texture between draws, so
     *  FFP draws can't share the frame-level uniform buffer. */

    private captureFfpDrawState(slotMask: number = this.activeSlotMask()): number {
        this.declDrawCounts.set(this.activeVertexDecl, (this.declDrawCounts.get(this.activeVertexDecl) ?? 0) + 1);
        const targetSize = this.getCurrentTargetSize();
        // FFP RHW coordinates and the pixel-centre correction are expressed in the
        // active D3D9 viewport; the executor applies the same viewport to the pass.
        // Falling back to the target dimensions only covers a not-yet-initialized state.
        const w = this.viewport.width || targetSize.w;
        const h = this.viewport.height || targetSize.h;
        // Resolved once and shared: the uniform the shader reads and the census that reports
        // what it could not honor must be looking at the same stages.
        const stageCount = this.activeStageCount();
        const stages = this.resolveFfpStages(stageCount);
        const block = this.buildFfpUniformBlock(w, h, stages, slotMask);
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
            if (ti !== null && !this.isVolumeIndex(ti) && D3D_ALPHALESS_FORMATS.has(this.textures.getFormat(ti))) {
                slot.block[ffpStageOffset(s) + 4 + 2] = 1; // stage.b.z — read alpha as 1.0
            }
        }
        return index;
    }

    /**
     * The signature of the last per-draw snapshot: every input captureDrawState reads, as
     * generations rather than contents. Consecutive draws with an identical signature can
     * share the slot the previous one already filled — which the recorder was ALREADY
     * detecting downstream (its bind-state elision), after paying for the whole capture.
     * Constant banks are versioned by their own setters; render/stage state, clip planes and
     * attachments ride pipelineStateGeneration; bound textures and sampler specs ride their
     * two bank generations. The frame serial is in the signature because the slot pool is
     * reset per frame, so an index from a previous frame is not reusable.
     */
    /**
     * Bumped whenever the stage window below is actually re-resolved. Two draws stamped with
     * the same value hold the SAME texture/sampler objects — not merely equal state — because
     * the memo branch copies the previous resolution's references verbatim. That is the
     * property the executor's bind-group front memo rests on.
     */
    private stageWindowEpoch = 0;
    private stageWindowBankGen = -1;
    private stageWindowSamplerGen = -1;
    private stageWindowCube = -1;
    private stageWindowVolume = -1;
    private stageWindowComparison = -1;
    private stageWindowVertexVolume = -1;
    private stageWindowHasPs = false;
    private stageWindowRtGuard = -1;
    private stageWindowSampler0: GPUSampler | null = null;
    private stageWindowTextures: (GPUTextureView | null)[] = new Array(PROG_BIND.MAX_TEX).fill(null);
    private stageWindowSamplers: (GPUSampler | null)[] = new Array(PROG_BIND.MAX_TEX).fill(null);
    private stageWindowVertexTextures: (GPUTextureView | null)[] =
        new Array(D3D9_VERTEX_TEXTURE_SAMPLER_COUNT).fill(null);
    private stageWindowVertexSamplers: (GPUSampler | null)[] =
        new Array(D3D9_VERTEX_TEXTURE_SAMPLER_COUNT).fill(null);

    private lastCaptureVs: CompiledVs | null = null;
    private lastCapturePs: CompiledPs | null = null;
    private lastCaptureVsVersion = -1;
    private lastCapturePsVersion = -1;
    private lastCapturePipelineGen = -1;
    private lastCaptureBankGen = -1;
    private lastCaptureSamplerGen = -1;
    private lastCaptureViewportW = -1;
    private lastCaptureViewportH = -1;
    /** Frame-local templates whose VS float prefix is guaranteed to be overwritten by every
     * compact instance. All non-overwritten uniform/resource inputs remain in the key. */
    private compactCaptureCache = new Map<string, number>();

    /** Snapshot the current VS/PS constants + bound textures for one draw. */
    private captureDrawState(): number {
        const vs = this.getActiveVsShader();
        const ps = this.getActivePsShader();
        // Only the programmable-PS branch is memoised: the hybrid NULL-PS branch below reads
        // the fixed-function block (transforms, lights, material), which has no generation of
        // its own, and a memo without one would go stale invisibly.
        if (ps !== null && !(globalThis as { __noD3D9KeyMemo?: boolean }).__noD3D9KeyMemo) {
            // lastCaptureIndex is reset to -1 at the frame boundary, which is what keeps an
            // index from a recycled slot pool out of this comparison.
            if (this.lastCaptureIndex >= 0
                && this.lastCaptureVs === vs && this.lastCapturePs === ps
                && this.lastCaptureVsVersion === this.vsConstantsVersion
                && this.lastCapturePsVersion === this.psConstantsVersion
                && this.lastCapturePipelineGen === this.pipelineStateGeneration
                && this.lastCaptureBankGen === this.arenaSamplerBankGeneration
                && this.lastCaptureSamplerGen === this.samplerStateGeneration
                && this.lastCaptureViewportW === this.viewport.width
                && this.lastCaptureViewportH === this.viewport.height) {
                return this.lastCaptureIndex;
            }
        }
        const vsConstantLen = Math.min(vs ? vs.analysis.constantCount : 0, VS_FLOAT_REGISTER_COUNT) * 4;
        // Hidden c[] tail: pixel-centre correction, point-size/default/min/max sidecar, and
        // six programmable user clip-plane equations when enabled. All remain in c[] so the
        // shader's dynamic-offset snapshot and content hash cover state changes atomically.
        const programmableClipPlanes = !!vs
            && this.getRS(D3DRS_CLIPPLANEENABLE) !== 0
            && !this.activeDeclIsPreTransformed();
        const vsCVecs = vs
            ? Math.min(vs.analysis.constantCount, VS_FLOAT_REGISTER_COUNT)
                + 2 + (programmableClipPlanes ? 6 : 0)
            : 0;
        const vsLen = vs ? vsCVecs * 4 + SHADER_INTEGER_REGISTER_COUNT * 4 + SHADER_BOOLEAN_BANK_BYTES / 4 : 0;
        // ps_3_0 exposes two distinct banks: c0-c223 and b0-b15.  The WGSL
        // recompiler packs b# immediately after the float bank, so a shader that
        // references b# needs that tail included in every per-draw snapshot.
        // Keeping the old 224-register ceiling here silently uploaded zeros for
        // every dynamic branch even though SetPixelShaderConstantB had stored the
        // values in psConstants.
        // Hybrid VS + NULL-PS draws repurpose the PS uniform binding for one unused c-register,
        // TEXTUREFACTOR, and eight FfpStage {a,b} records: 4 + 4 + 8*8 floats.
        const psCVecs = ps ? Math.max(1, Math.min(ps.analysis.constantCount, PS_FLOAT_REGISTER_COUNT)) : 0;
        const psBankLen = ps ? psCVecs * 4 + SHADER_INTEGER_REGISTER_COUNT * 4 + SHADER_BOOLEAN_BANK_BYTES / 4 : 0;
        const psFogLen = ps ? 8 : 0;
        const psLen = ps
            ? (ps.analysis.usesLegacyBumpEnv
                // The WGSL struct has at least c[0], followed by two vec4 bump records for
                // every texture stage. Keep the appended state in the same per-draw snapshot
                // as c# so changing D3DTSS values cannot reuse stale bind data.
                ? psBankLen + FFP_MAX_STAGES * 2 * 4 + psFogLen
                : psBankLen + psFogLen)
            : 72 + FFP_STAGE_CONSTANT_FLOATS;

        // Zero-alloc capture: snapshot constants + bound views into a pooled, reused
        // draw-state slot (see RenderFrame.nextDrawState) instead of fresh Float32Arrays /
        // a fresh textures array / a fresh object on every draw. The frame index is the
        // slot count read before nextDrawState bumps it.
        const frame = this.commandRecorder.getCurrentFrame();
        const index = frame.drawStateCount;
        const state = frame.nextDrawState(vsLen, psLen);

        const { dx, dy } = pixelCenterClipOffset(this.viewport.width, this.viewport.height);
        // Only the hidden tail needs zeroing: the c# prefix below is overwritten wholesale by
        // the bank copy, and this slot is reused for every draw in the frame — clearing the
        // whole block first meant writing the constant bank twice on every draw.
        state.vsConst.fill(0, vsConstantLen, vsLen);
        if (vs) state.vsBits.set(this.vsConstantBits.subarray(0, vsConstantLen), 0);
        state.vsConst[vsConstantLen + 0] = dx;
        state.vsConst[vsConstantLen + 1] = dy;
        // The hidden c[] tail is also the point-expansion sidecar: programmable point-list
        // links use z/w for the active viewport dimensions when converting oPts pixels to
        // clip-space offsets.  Ordinary shaders continue to ignore these lanes.
        state.vsConst[vsConstantLen + 2] = this.viewport.width || this.getCurrentTargetSize().w;
        state.vsConst[vsConstantLen + 3] = this.viewport.height || this.getCurrentTargetSize().h;
        state.vsConst[vsConstantLen + 4] = this.rsFloat(this.getRS(D3DRS_POINTSIZE));
        state.vsConst[vsConstantLen + 5] = this.rsFloat(this.getRS(D3DRS_POINTSIZE_MIN));
        state.vsConst[vsConstantLen + 6] = this.rsFloat(this.getRS(D3DRS_POINTSIZE_MAX));
        if (programmableClipPlanes) {
            const clipEnable = this.getRS(D3DRS_CLIPPLANEENABLE) >>> 0;
            const clipBase = vsConstantLen + 8;
            for (let i = 0; i < 6; i++) {
                if ((clipEnable & (1 << i)) === 0) continue;
                const plane = this.clipPlanes.get(i);
                if (plane) state.vsConst.set(plane.subarray(0, 4), clipBase + i * 4);
            }
        }
        const constantsVersion = vs
            ? this.copyProgrammableBankWithKey(state.vsBits, state.vsBits, vsCVecs * 4, this.vsIntegerBits, this.vsBooleanMask)
            : 0;
        state.vsVersion = vs ? withPixelCenterVersion(constantsVersion, dx, dy) : 0;
        if (ps) {
            if (ps.analysis.usesLegacyBumpEnv) {
                state.psConst.fill(0, 0, psLen);
                this.copyProgrammableBankWithKey(state.psBits, this.psConstantBits, psCVecs * 4, this.psIntegerBits, this.psBooleanMask);
                // LegacyBumpStage { mat: vec4(M00,M01,M10,M11), lum: vec4(scale,offset,0,0) }
                // follows c#. See TEXBEM/TEXBEML's D3D9 formula and ps-codegen.ts.
                for (let stage = 0; stage < FFP_MAX_STAGES; stage++) {
                    const at = psBankLen + stage * 8;
                    state.psConst[at + 0] = dwordAsFloat(this.getTextureStageState(stage, D3DTSS_BUMPENVMAT00));
                    state.psConst[at + 1] = dwordAsFloat(this.getTextureStageState(stage, D3DTSS_BUMPENVMAT01));
                    state.psConst[at + 2] = dwordAsFloat(this.getTextureStageState(stage, D3DTSS_BUMPENVMAT10));
                    state.psConst[at + 3] = dwordAsFloat(this.getTextureStageState(stage, D3DTSS_BUMPENVMAT11));
                    state.psConst[at + 4] = dwordAsFloat(this.getTextureStageState(stage, D3DTSS_BUMPENVLSCALE));
                    state.psConst[at + 5] = dwordAsFloat(this.getTextureStageState(stage, D3DTSS_BUMPENVLOFFSET));
                }
            } else {
                state.psConst.fill(0, 0, psLen);
                this.copyProgrammableBankWithKey(state.psBits, this.psConstantBits, psCVecs * 4, this.psIntegerBits, this.psBooleanMask);
            }
            // Programmable PS fixed-function fog tail: color followed by
            // (start, end, density, effective mode). It is appended after any bump records,
            // matching PsUniforms, and included in the content hash below.
            const fogAt = psLen - psFogLen;
            const fogColor = unpackD3dColor(this.stateTracker.getRenderState(D3DRS_FOGCOLOR) >>> 0, this.ffpFogColor);
            state.psConst[fogAt + 0] = fogColor.r;
            state.psConst[fogAt + 1] = fogColor.g;
            state.psConst[fogAt + 2] = fogColor.b;
            state.psConst[fogAt + 3] = 1;
            state.psConst[fogAt + 4] = this.rsFloat(this.stateTracker.getRenderState(D3DRS_FOGSTART));
            state.psConst[fogAt + 5] = this.rsFloat(this.stateTracker.getRenderState(D3DRS_FOGEND));
            state.psConst[fogAt + 6] = this.rsFloat(this.stateTracker.getRenderState(D3DRS_FOGDENSITY));
            state.psConst[fogAt + 7] = ps.prog.major < 3
                ? resolveProgrammablePixelFogMode(
                    this.stateTracker.getRenderState(D3DRS_FOGENABLE),
                    this.stateTracker.getRenderState(D3DRS_FOGTABLEMODE),
                )
                : 0;
            state.psVersion = this.copyConstantPrefixWithKey(state.psBits, state.psBits, psLen);
        } else {
            const targetSize = this.getCurrentTargetSize();
            const w = this.viewport.width || targetSize.w;
            const h = this.viewport.height || targetSize.h;
            const ffp = this.buildFfpUniformBlock(w, h);
            const stageCount = this.activeStageCount();
            for (let stage = 0; stage < stageCount; stage++) {
                const ti = this.stateTracker.getTexture(stage);
                if (ti !== null && !this.isVolumeIndex(ti) && D3D_ALPHALESS_FORMATS.has(this.textures.getFormat(ti))) {
                    ffp[ffpStageOffset(stage) + 4 + 2] = 1;
                }
            }
            state.psConst.fill(0, 0, psLen);
            state.psConst[0] = this.hybridDebugOutput;
            // c[0] occupies [0..3]; tfactor follows at [4..7]. Preserve the FFP
            // stage tail and its per-stage D3DTSS_CONSTANT records bit-for-bit.
            state.psConst.set(ffp.subarray(ffpStageOffset(0) - 4, ffpStageOffset(0)), 4);
            state.psConst.set(ffp.subarray(ffpStageOffset(0), ffpStageOffset(0) + FFP_MAX_STAGES * 8), 8);
            state.psConst.set(ffp.subarray(ffpStageConstantOffset(0), ffpStageConstantOffset(0) + FFP_STAGE_CONSTANT_FLOATS), 8 + FFP_MAX_STAGES * 8);
            state.psVersion = this.copyConstantPrefixWithKey(state.psBits, state.psBits, psLen);
        }

        // Cube-sampler mask for this PS — must match the pipeline's layout (resolveProgrammablePipeline
        // built it with link.cubeMask, derived identically) so the bind group stays compatible.
        // Effective cube mask = shader dcl_cube ∪ stages with a cube texture bound. MUST equal the
        // mask resolveProgrammablePipeline used to build the pipeline layout (same derivation) so
        // the per-draw bind group stays compatible.
        const comparisonSamplers = ps
            ? this.boundComparisonSamplers()
            : new Map<number, { clampDref?: boolean }>();
        let comparisonMask = 0;
        for (const stage of comparisonSamplers.keys()) comparisonMask |= 1 << stage;
        const cubeMask = (computeCubeMask(ps) | this.boundCubeMask()) & ~comparisonMask;
        const volumeMask = ps ? ((computeVolumeMask(ps) | this.boundVolumeMask()) & ~comparisonMask) : 0;
        const vertexVolumeMask = vs ? (computeVertexVolumeMask(vs) | this.boundVertexVolumeMask()) : 0;
        state.cubeMask = cubeMask;
        state.volumeMask = volumeMask;
        state.vertexVolumeMask = vertexVolumeMask;
        state.comparisonMask = comparisonMask;

        // The whole stage window — 16 fragment texture views + 16 samplers + the four
        // vertex-texture pairs — is a function of the texture and sampler banks and the masks
        // above, none of which change per draw. Resolving it costs ~36 view/sampler lookups
        // EVERY draw, which is why decodeD3d9Sampler and resolveTextureView stay hot even
        // when every draw binds the same material. Resolve once per (bank, sampler, mask)
        // combination and copy the references out.
        const stageMemoValid = this.stageWindowBankGen === this.arenaSamplerBankGeneration
            && this.stageWindowSamplerGen === this.samplerStateGeneration
            && this.stageWindowCube === cubeMask && this.stageWindowVolume === volumeMask
            && this.stageWindowComparison === comparisonMask
            && this.stageWindowVertexVolume === vertexVolumeMask
            && this.stageWindowHasPs === (ps !== null)
            && this.stageWindowRtGuard === this.attachmentGeneration
            && !(globalThis as { __noD3D9KeyMemo?: boolean }).__noD3D9KeyMemo;
        if (stageMemoValid) {
            for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
                state.textures[stage] = this.stageWindowTextures[stage] ?? null;
                state.samplers[stage] = this.stageWindowSamplers[stage] ?? null;
            }
            for (let n = 0; n < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
                state.vertexTextures[n] = this.stageWindowVertexTextures[n] ?? null;
                state.vertexSamplers[n] = this.stageWindowVertexSamplers[n] ?? null;
            }
            state.sampler = this.stageWindowSampler0;
            state.stageEpoch = this.stageWindowEpoch;
            return this.finishCaptureDrawState(state, index, frame, vs, ps);
        }

        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            const ti = this.stateTracker.getTexture(stage);
            if (ti === null) { state.textures[stage] = null; continue; }
            if (this.isTextureConflictingWithActiveRt(ti)) {
                state.textures[stage] = null;
                continue;
            }
            const stageIsVolume = ((volumeMask >> stage) & 1) !== 0;
            if (stageIsVolume) {
                if (ps === null || !this.isVolumeIndex(ti)) {
                    state.textures[stage] = null;
                    continue;
                }
                state.textures[stage] = this.resolveVolumeTextureView(ti);
                continue;
            }
            // A volume resource bound to a 2-D/cube shader must not be passed to WebGPU.
            if (this.isVolumeIndex(ti)) {
                state.textures[stage] = null;
                continue;
            }
            // FFP/hybrid layouts expose ordinary float textures. A depth resource can only be
            // bound through the comparison-sampler layout used by a programmable PS; leave it
            // null here so the executor supplies the ordinary 2D fallback for the FFP layout.
            if (ps === null && isDxDepthStencilFormat(this.textures.getFormat(ti), 9)) {
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
                ? this.resolveTextureView(stage, ti, stageIsCube)
                : null;
        }

        // Binding 2 remains stage 0; later PS stages use the sampler window. Resolve each from
        // the game's D3DSAMP_* state via the shared DxSamplerCache (not a hardcoded linear).
        state.sampler = this.resolveStageSampler(0, (comparisonMask & 1) !== 0);
        // Programmable PS samples address each declared stage independently. Keep the full
        // stage snapshot here; the executor already binds the array into the sampler window.
        const samplerStages = ps ? PROG_BIND.MAX_TEX : this.activeStageCount();
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            state.samplers[stage] = stage < samplerStages
                ? this.resolveStageSampler(stage, ((comparisonMask >> stage) & 1) !== 0)
                : null;
        }
        for (let n = 0; n < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            const stage = D3D9_VERTEX_TEXTURE_SAMPLER_BASE + n;
            const ti = this.stateTracker.getTexture(stage);
            state.vertexSamplers[n] = this.resolveStageSampler(stage);
            const stageIsVolume = ((vertexVolumeMask >> n) & 1) !== 0;
            if (ti === null || this.isTextureConflictingWithActiveRt(ti)) {
                state.vertexTextures[n] = null;
                continue;
            }
            if (stageIsVolume) {
                state.vertexTextures[n] = this.isVolumeIndex(ti) ? this.resolveVolumeTextureView(ti) : null;
                continue;
            }
            if (this.isVolumeIndex(ti) || this.textures.isCubeMap(ti)) {
                state.vertexTextures[n] = null;
                continue;
            }
            this.ensureTexture(ti);
            state.vertexTextures[n] = this.resolveTextureView(stage, ti, false);
        }

        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            this.stageWindowTextures[stage] = state.textures[stage] ?? null;
            this.stageWindowSamplers[stage] = state.samplers[stage] ?? null;
        }
        for (let n = 0; n < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; n++) {
            this.stageWindowVertexTextures[n] = state.vertexTextures[n] ?? null;
            this.stageWindowVertexSamplers[n] = state.vertexSamplers[n] ?? null;
        }
        this.stageWindowSampler0 = state.sampler ?? null;
        this.stageWindowBankGen = this.arenaSamplerBankGeneration;
        this.stageWindowSamplerGen = this.samplerStateGeneration;
        this.stageWindowCube = cubeMask;
        this.stageWindowVolume = volumeMask;
        this.stageWindowComparison = comparisonMask;
        this.stageWindowVertexVolume = vertexVolumeMask;
        this.stageWindowHasPs = ps !== null;
        this.stageWindowRtGuard = this.attachmentGeneration;
        state.stageEpoch = ++this.stageWindowEpoch;

        return this.finishCaptureDrawState(state, index, frame, vs, ps);
    }

    private captureCompactDrawState(
        pipelineId: number, fullStateKey: number, startFloat: number, floatCount: number,
    ): number {
        const vs = this.getActiveVsShader();
        const ps = this.getActivePsShader();
        const neededVsFloats = Math.min(
            vs ? vs.analysis.constantCount : 0, VS_FLOAT_REGISTER_COUNT,
        ) * 4;
        // Relative c[a0] accesses can address the whole bank, and clip-plane equations live
        // in the hidden tail. Leave both on the universal capture path.
        const fullyOverwritten = !!vs && !!ps && !vs.prog.usesRelativeConst
            && !shaderUsesIntegerBoolean(vs.prog) && !shaderUsesIntegerBoolean(ps.prog)
            && startFloat === 0 && floatCount >= neededVsFloats
            && this.getRS(D3DRS_CLIPPLANEENABLE) === 0;
        if (!fullyOverwritten || (globalThis as { __d3d9CompactCaptureCache?: boolean })
            .__d3d9CompactCaptureCache === false) {
            this.compactCaptureReuseMisses++;
            return this.captureDrawState();
        }
        const key = [
            pipelineId, fullStateKey, this.activeVertexShader, this.activePixelShader,
            this.activeVertexDecl, this.psConstantsVersion,
            this.arenaSamplerBankGeneration, this.samplerStateGeneration,
            this.attachmentGeneration, this.gpuResourceGeneration,
            this.viewport.width, this.viewport.height,
            this.getRS(D3DRS_POINTSIZE), this.getRS(D3DRS_POINTSIZE_MIN),
            this.getRS(D3DRS_POINTSIZE_MAX), this.getRS(D3DRS_FOGCOLOR),
            this.getRS(D3DRS_FOGSTART), this.getRS(D3DRS_FOGEND),
            this.getRS(D3DRS_FOGDENSITY), this.getRS(D3DRS_FOGENABLE),
            this.getRS(D3DRS_FOGTABLEMODE),
            // captureDrawState bakes the bump-env stage states into psConst for a legacy
            // TEXBEM/TEXBEML shader; psConstantsVersion hashes the constant BANK and cannot
            // see them move.
            legacyBumpEnvStageKey(ps, (stage, state) => this.getTextureStageState(stage, state)),
        ].join(":");
        const cached = this.compactCaptureCache.get(key);
        if (cached !== undefined) {
            this.compactCaptureReuseHits++;
            return cached;
        }
        const captured = this.captureDrawState();
        this.compactCaptureCache.set(key, captured);
        this.compactCaptureReuseMisses++;
        return captured;
    }

    /** The tail both capture paths share: collapse an identical consecutive state onto the
     *  slot the previous draw already filled, and remember the signature either way. */
    private finishCaptureDrawState(
        state: ProgrammableDrawState,
        index: number,
        frame: RenderFrame,
        vs: CompiledVs | null,
        ps: CompiledPs | null,
    ): number {
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
                && prev.cubeMask === state.cubeMask && prev.volumeMask === state.volumeMask
                && prev.vertexVolumeMask === state.vertexVolumeMask
                && prev.comparisonMask === state.comparisonMask
                && prev.sampler === state.sampler) {
                let texEqual = true;
                for (let i = 0; i < PROG_BIND.MAX_TEX; i++) {
                    if (prev.textures[i] !== state.textures[i] || prev.samplers[i] !== state.samplers[i]) { texEqual = false; break; }
                }
                if (texEqual) {
                    for (let i = 0; i < D3D9_VERTEX_TEXTURE_SAMPLER_COUNT; i++) {
                        if (prev.vertexTextures[i] !== state.vertexTextures[i]
                            || prev.vertexSamplers[i] !== state.vertexSamplers[i]) { texEqual = false; break; }
                    }
                }
                if (texEqual) {
                    frame.rollbackDrawState();
                    d3d9PerfBackendInc("bindStateElided");
                    // The slot the previous draw filled is what this state produces, so record
                    // THIS state against it: the next draw can then skip the capture entirely
                    // instead of rediscovering the equality by rebuilding the snapshot.
                    this.rememberCaptureSignature(vs, ps);
                    return prevIdx;
                }
            }
        }
        this.lastCaptureIndex = index;
        this.rememberCaptureSignature(vs, ps);
        return index;
    }

    private rememberCaptureSignature(vs: CompiledVs | null, ps: CompiledPs | null): void {
        this.lastCaptureVs = vs;
        this.lastCapturePs = ps;
        this.lastCaptureVsVersion = this.vsConstantsVersion;
        this.lastCapturePsVersion = this.psConstantsVersion;
        this.lastCapturePipelineGen = this.pipelineStateGeneration;
        this.lastCaptureBankGen = this.arenaSamplerBankGeneration;
        this.lastCaptureSamplerGen = this.samplerStateGeneration;
        this.lastCaptureViewportW = this.viewport.width;
        this.lastCaptureViewportH = this.viewport.height;
    }

    /** Live diagnostic control; c0 is otherwise unused by a NULL pixel shader. */
    setHybridDebugOutput(mode: number): number {
        this.hybridDebugOutput = Math.max(0, Math.min(3, mode | 0));
        return this.hybridDebugOutput;
    }

    /**
     * Resolve the faithful GPU sampler for one texture stage from the game's D3DSAMP_* state.
     * Runs per stage per draw, so the result is memoised per stage; the decode (a closure plus a
     * spec/descriptor/key-string per call) only reruns when one of the descriptor's three input
     * groups actually moved — this stage's D3DSAMP_* block, the quality override, or the device.
     */
    private resolveStageSampler(stage: number, comparison = false): GPUSampler | null {
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
        const slot = d3d9TextureStageSlot(stage);
        const bit = slot >= 0 ? (1 << slot) : 0;
        if (!comparison && bit !== 0 && (this.stageSamplersValid & bit) !== 0) return this.stageSamplers[slot]!;

        // Keep unsupported D3D9 modes explicit all the way to the draw boundary.  Pipeline
        // resolution normally rejects them first; tryAcquire is the defensive second fence for
        // direct/cached binding paths and returns null instead of silently changing semantics.
        const sampler = this.samplerCache.tryAcquire(
            this.samplerSpecForStage(stage),
            comparison,
        );
        if (!comparison && bit !== 0) {
            this.stageSamplers[slot] = sampler;
            this.stageSamplersValid |= bit;
        }
        return sampler;
    }

    /** Link an arena draw row to the RenderFrame draw just emitted by the recorder.
     *
     * The arena command stream is intentionally compact and does not own GPU objects.  We
     * therefore retain the frame's generation-safe resource/state snapshot and use only the
     * arena's identity-selected pipeline/arguments at encode time.  A missing or malformed
     * row is ignored, leaving the legacy frame path authoritative for that draw.
     */
    private linkArenaDraw(
        arenaCommandStart: number,
        arenaKey: number | undefined,
        pipelineId: number,
        bindStateIndex: number | undefined,
        pipelineIdentity: ArrayLike<number> | undefined,
        pipelineIdentityKey: string | undefined,
    ): boolean {
        if (!isWasmPathEnabled() || arenaKey === undefined || arenaKey < 0
            || !d3d9WasmArena.isInitialized()) return false;
        const count = d3d9WasmArena.getCommandCount();
        if (count <= arenaCommandStart) return false;
        const types = d3d9WasmArena.getCommandTypes();
        const pipelineKeys = d3d9WasmArena.getPipelineKeys();
        const commandB = d3d9WasmArena.getCommandB();
        for (let i = count - 1; i >= arenaCommandStart; i--) {
            const type = types[i]!;
            if (type !== ArenaCommandType.Draw && type !== ArenaCommandType.DrawIndexed
                && type !== ArenaCommandType.DrawUP) continue;
            let stateOffset = -1;
            for (let j = i - 1; j >= arenaCommandStart; j--) {
                if (types[j] === ArenaCommandType.SetPipeline) {
                    stateOffset = commandB[j]! >>> 0;
                    break;
                }
            }
            if (stateOffset < 0) return false;
            this.commandRecorder.recordArenaBinding({
                arenaDrawCommand: i,
                arenaPipelineKey: pipelineKeys[i] ?? arenaKey,
                arenaStateOffset: stateOffset,
                pipelineIdentity,
                ...(pipelineIdentityKey !== undefined ? { pipelineIdentityKey } : {}),
                pipelineId,
                bindStateIndex,
                arenaCommandType: type,
            });
            return true;
        }
        return false;
    }

    /** Every finalized frame owns its arena rows, including a target pass refused before encode. */
    private resetArenaAfterSubmit(): void {
        this.backendExecutor.clearArenaPipelineIdentities();
        // Rust resetFrame() clears the shared identity and bump state; a last-resolve memo from
        // the previous frame must not record the next row with a zero/stale identity.
        this.invalidateLastResolve();
        this._lrArenaIdentity = undefined;
        this._lrArenaIdentityWords = undefined;
        this.pendingArenaRecord = null;
        if (!d3d9WasmArena.isInitialized()) return;
        d3d9WasmArena.resetFrame();
    }

    private submitFrame(present: boolean): void {
        if (!this.commandRecorder.hasWork() && !present) {
            return;
        }

        this.frameCount++;
        const frame = this.commandRecorder.finalize();
        // Read-only, default-OFF eligibility census. This is the one lifecycle point where
        // RenderFrame is finalized while its referenced WASM-arena rows are still live.
        if ((globalThis as { __d3d9MegaBatchCensus?: boolean }).__d3d9MegaBatchCensus === true
            && d3d9WasmArena.isInitialized()) {
            this.megaBatchCensus ??= createD3D9MegaBatchCensus();
            censusD3D9MegaBatchFrame(frame, d3d9WasmArena, this.megaBatchCensus);
        }
        this.lastCaptureIndex = -1; // draw-state slots recycle with the new frame
        this.compactCaptureCache.clear();
        const releasePooledBuffers = (): void => {
            if (!this.vbPool || frame.pooledBuffers.length === 0) return;
            const pooled = frame.pooledBuffers;
            for (let i = 0; i < pooled.length; i++) this.vbPool.release(pooled[i]);
            pooled.length = 0;
        };
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
        let target: {
            colorViews: Array<GPUTextureView | null>;
            /** Exact render-pass layout used to validate/cache GPURenderBundles. */
            colorFormats: Array<GPUTextureFormat | null>;
            depthView?: GPUTextureView;
            depthFormat?: GPUTextureFormat;
            stencilReference?: number;
            backbuffer?: boolean;
            multisample?: D3D9MultisampleTarget;
            multisampleDepth?: { texture: GPUTexture; view: GPUTextureView };
            srgbWrite?: boolean;
        } | null = null;
        let vpW = size.width, vpH = size.height;
        if (this.depthTextureIndex !== null) {
            const device = this.backend.getDevice();
            if (device) this.ensureDepthTexture(this.depthTextureIndex, device);
        }
        const standaloneDepth = this.activeStandaloneDepthSurface === null
            ? null : this.ensureStandaloneDepthSurface(this.activeStandaloneDepthSurface);
        if (this.activeStandaloneDepthSurface !== null && !standaloneDepth) {
            Logger.warn(LogCategory.D3D9, "[D3D9] standalone depth surface has no GPU attachment; refusing target pass");
            frame.releaseTemporaryBuffers();
            releasePooledBuffers();
            this.resetArenaAfterSubmit();
            return;
        }
        const hasExplicitTarget = this.renderTargetIndices.some(index => index !== null);
        if (hasExplicitTarget) {
            const formats = this.activeColorTargetFormats();
            if (!formats) {
                frame.releaseTemporaryBuffers();
                releasePooledBuffers();
                this.resetArenaAfterSubmit();
                return;
            }
            const colorViews: Array<GPUTextureView | null> = new Array(formats.length).fill(null);
            const srgbWrite = this.getRS(D3DRS_SRGBWRITEENABLE) !== 0;
            // Slot 0 remains the swap-chain attachment when only MRT slot 1+ is explicit;
            // the executor fills that null with its offscreen view before opening the pass.
            for (let i = 0; i < formats.length; i++) {
                const rt = this.renderTargetIndices[i];
                if (rt === null) continue;
                // A cube RT renders into one face via a per-face 2D view; the texture's own view
                // is the dimension:"cube" sampling view, which is not a color attachment.
                colorViews[i] = this.textures.isCubeMap(rt)
                    ? this.getCubeFaceRenderView(rt, this.renderTargetFaces[i] ?? -1, 0, srgbWrite)
                    : this.renderTargetView(rt, srgbWrite);
                if (!colorViews[i]) {
                    Logger.error(LogCategory.D3D9, `[D3D9] MRT: target ${i} has no color view`);
                    frame.releaseTemporaryBuffers();
                    releasePooledBuffers();
                    this.resetArenaAfterSubmit();
                    return;
                }
            }
            const rt0 = this.renderTargetIndices[0];
            if (rt0 !== null) {
                vpW = this.textures.getWidth(rt0);
                vpH = this.textures.getHeight(rt0);
            }
            if (rt0 === null && this.d3d9MsaaSampleCount > 1 && colorViews.slice(1).some((view) => view !== null)) {
                Logger.warn(LogCategory.D3D9, "[D3D9] MSAA backbuffer MRT is not yet supported; refusing target pass");
                frame.releaseTemporaryBuffers();
                releasePooledBuffers();
                this.resetArenaAfterSubmit();
                return;
            }
            let multisample: D3D9MultisampleTarget | null = null;
            const sampleType = rt0 === null ? this.d3d9MsaaSampleCount : (this.renderTargetSampleTypes[0] ?? 0);
            if (sampleType > 1 && rt0 !== null) {
                // The cache currently owns one color resolve per pass. Refuse MRT
                // rather than rendering an MSAA slot 0 while silently dropping slots 1+.
                if (colorViews.slice(1).some((view) => view !== null)) {
                    Logger.warn(LogCategory.D3D9, "[D3D9] MSAA MRT is not yet supported; refusing target switch");
                    frame.releaseTemporaryBuffers();
                    releasePooledBuffers();
                    this.resetArenaAfterSubmit();
                    return;
                }
                const resolveTexture = this.textures.getGpuTexture(rt0);
                const resolveView = colorViews[0];
                if (!resolveTexture || !resolveView) {
                    frame.releaseTemporaryBuffers();
                    releasePooledBuffers();
                    this.resetArenaAfterSubmit();
                    return;
                }
                multisample = this.renderTargetMsaaTarget(
                    0, this.renderTargetFaces[0] ?? -1, sampleType, formats[0]!,
                    resolveTexture, resolveView, vpW, vpH, this.activeDepthTargetFormat(),
                    standaloneDepth && standaloneDepth.sampleCount > 1
                        ? { texture: standaloneDepth.texture, view: standaloneDepth.view }
                        : undefined,
                );
                if (!multisample) {
                    Logger.warn(LogCategory.D3D9, "[D3D9] adapter probe refused the active MSAA render target");
                    frame.releaseTemporaryBuffers();
                    releasePooledBuffers();
                    this.resetArenaAfterSubmit();
                    return;
                }
            }
            const depthAttachment = this.resolveDepthAttachment(vpW, vpH);
            target = {
                colorViews,
                colorFormats: formats,
                depthView: depthAttachment?.view
                    ?? (rt0 === null ? undefined : this.getRtDepthView(vpW, vpH, this.activeDepthTargetFormat())),
                depthFormat: this.activeDepthTargetFormat(),
                stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
                backbuffer: rt0 === null,
                multisample: multisample ?? undefined,
                multisampleDepth: standaloneDepth && standaloneDepth.sampleCount > 1
                    && standaloneDepth.width === vpW && standaloneDepth.height === vpH
                    ? { texture: standaloneDepth.texture, view: standaloneDepth.view }
                    : undefined,
                srgbWrite,
            };
        } else if (this.depthTextureIndex !== null) {
            target = {
                colorViews: [null],
                colorFormats: this.activeColorTargetFormats() ?? [this.backend.getFormat()!],
                depthView: this.resolveDepthAttachment(vpW, vpH)?.view,
                depthFormat: this.activeDepthTargetFormat(),
                stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
                backbuffer: true,
                srgbWrite: this.getRS(D3DRS_SRGBWRITEENABLE) !== 0,
            };
        } else if (standaloneDepth) {
            target = {
                colorViews: [null],
                colorFormats: this.activeColorTargetFormats() ?? [this.backend.getFormat()!],
                depthView: this.resolveDepthAttachment(vpW, vpH)?.view,
                depthFormat: standaloneDepth.format,
                stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
                backbuffer: true,
                multisampleDepth: standaloneDepth.sampleCount > 1
                    && standaloneDepth.width === vpW && standaloneDepth.height === vpH
                    ? { texture: standaloneDepth.texture, view: standaloneDepth.view }
                    : undefined,
                srgbWrite: this.getRS(D3DRS_SRGBWRITEENABLE) !== 0,
            };
        } else {
            // Keep the backbuffer attachment format and pipeline format in sync even
            // when no explicit depth surface is bound.
            target = {
                colorViews: [null],
                colorFormats: this.activeColorTargetFormats() ?? [this.backend.getFormat()!],
                depthFormat: this.activeDepthTargetFormat(),
                stencilReference: this.getRS(D3DRS_STENCILREF) & 0xff,
                backbuffer: true,
                srgbWrite: this.getRS(D3DRS_SRGBWRITEENABLE) !== 0,
            };
        }

        // Programmable (VS/PS) draws carry their own per-draw constants/textures;
        // the frame-level uniforms serve only the FFP path.
        const renderViewport = { ...this.viewport };
        const uniforms: UniformData = {
            viewportWidth: renderViewport.width || vpW,
            viewportHeight: renderViewport.height || vpH,
            mvp: this.stateTracker.getMVP(),
            // Expanded FFP uniform block (viewport + MVP + worldView + material/lights/ambient).
            // Consumed by the FFP shader path; the programmable path ignores it.
            ffpBlock: this.buildFfpUniformBlock(
                renderViewport.width || vpW,
                renderViewport.height || vpH,
            ),
        };
        const textureView = this.resolveCurrentTexture();
        const system = System.getInstance();
        const videoOverlayService = system.videoRouting.getOverlayService();
        const gdiContext = this.getGdiContext();
        const composit = present && !hasExplicitTarget;
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
        }, target, present && !hasExplicitTarget && d3d9SwapEffectDiscardsBackBuffer(this.swapEffect),
            this.gpuQueryManager ?? undefined, this.frameCount, renderViewport, isWasmPathEnabled());
        this.d3d9MsaaCache?.flushGarbage();

        // Return DrawPrimitiveUP vertex buffers to the reuse pool. execute() has already
        // issued queue.submit, so by WebGPU queue ordering the next frame's writeBuffer
        // into a recycled buffer is sequenced after this frame's draws that read it —
        // safe to reuse without a GPU fence.
        releasePooledBuffers();

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
        this.resetArenaAfterSubmit();
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
        return textureIndex === this.depthTextureIndex
            || this.renderTargetIndices.some(index => index !== null && textureIndex === index);
    }

    private resolveCurrentTexture(stage = 0): GPUTextureView | null {
        const textureIndex = this.stateTracker.getTexture(stage);
        if (textureIndex === null) {
            return null;
        }
        if (this.isTextureConflictingWithActiveRt(textureIndex)) {
            return null;
        }
        if (this.isVolumeIndex(textureIndex)) return null;
        // The FFP bind-group layout's texture slot is 2D; a cube view would make it invalid.
        if (this.textures.isCubeMap(textureIndex)) return null;
        this.ensureTexture(textureIndex);
        return this.textures.getView(textureIndex);
    }

    private ensureTexture(index: number): void {
        const device = this.backend.getDevice()!;
        const width = this.textures.getWidth(index);
        const height = this.textures.getHeight(index);
        // Depth resources are created eagerly with a native sampleable depth format.
        // They cannot be uploaded through the RGBA conversion path below.
        if (isDxDepthStencilFormat(this.textures.getFormat(index), 9)) {
            this.ensureDepthTexture(index, device);
            return;
        }
        // Render-target textures own their GPU texture (created in createTexture, populated by
        // rendering). Never recreate or upload guest pixels over the rendered content.
        if (this.textures.isRenderTarget(index)) {
            // DEFAULT render targets lose their native GPU object on device loss. Recreate the
            // attachment lazily on first use; its contents remain cleared until the guest redraws.
            if (!this.textures.getGpuTexture(index)) {
                const rtFormat = this.backend.getFormat() ?? "rgba8unorm";
                const texture = device.createTexture({
                    size: { width, height, depthOrArrayLayers: this.textures.isCubeMap(index) ? 6 : 1 },
                    mipLevelCount: 1,
                    format: rtFormat,
                    viewFormats: dxSrgbViewFormats(rtFormat),
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
                           GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                });
                const view = this.textures.isCubeMap(index)
                    ? texture.createView({ dimension: "cube", arrayLayerCount: 6 })
                    : texture.createView();
                this.textures.setGpuTexture(index, texture, view);
                this.gpuResourceGeneration++; // a new GPU object invalidates the redundant-RT fast path
                this.renderTargetGpuFormats.set(index, rtFormat);
            }
            return;
        }
        // Cube textures own a 6-layer GPU texture created in createCubeTexture; upload LockRect'd
        // faces only (their sampling view is the cube view — never replace it with a 2D view).
        if (this.textures.isCubeMap(index)) { this.ensureCubeTexture(index, device); return; }
        const data = this.textures.getData(index);
        if (!data) return;

        const texFormat = this.textures.getFormat(index);
        // The 16-bit float family has an opt-in native storage path. Preserve
        // its little-endian rows exactly; decoding to rgba8unorm would destroy
        // values outside [0,1] before sampling.
        if (isD3DFloatFormat(texFormat)) {
            const policy = resolveD3D9FloatTexturePolicy(texFormat);
            if (!policy.supported) return;
            const texelBytes = policy.bytesPerTexel;
            const handle = this.textures.getHandle(index);
            const levelCount = effectiveMipLevels(
                this.textures.getLevels(index), width, height,
                (lvl) => this.mipLevelData.has(`${handle}:${lvl}`),
            );
            let gpuTexture = this.textures.getGpuTexture(index);
            if (!gpuTexture || gpuTexture.mipLevelCount !== levelCount || gpuTexture.format !== policy.gpuFormat) {
                gpuTexture = device.createTexture({
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: policy.gpuFormat!,
                    mipLevelCount: levelCount,
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
                });
                this.textures.setGpuTexture(index, gpuTexture, gpuTexture.createView());
                this.gpuResourceGeneration++; // a new GPU object invalidates the redundant-RT fast path
                this.textures.setDirty(index, true);
                this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
            }
            if (!this.textures.isDirty(index)) return;
            const queue = this.backend.getQueue()!;
            const uploadLevel = (pixels: Uint8Array, w: number, h: number, pitch: number, level: number): number => {
                const packed = makeD3D9FloatUpload(pixels, w, h, pitch, texelBytes);
                if (!packed) return 0;
                queue.writeTexture(
                    { texture: gpuTexture!, mipLevel: level },
                    packed.data as any,
                    { bytesPerRow: packed.bytesPerRow, rowsPerImage: h },
                    { width: w, height: h, depthOrArrayLayers: 1 },
                );
                return w * h * texelBytes;
            };
            let uploadedBytes = uploadLevel(data, width, height, this.textures.getPitch(index), 0);
            for (let lvl = 1; lvl < levelCount; lvl++) {
                const px = this.getTextureLevelPixels(handle, lvl);
                if (px) uploadedBytes += uploadLevel(px.data, px.width, px.height, px.pitch, lvl);
            }
            this.textures.setDirty(index, false);
            if (this.frameSnapshot.frameCounters) {
                this.frameSnapshot.frameCounters.uploads++;
                this.frameSnapshot.frameCounters.textureBytes += uploadedBytes;
            }
            return;
        }
        if (isBlockCompressedFormat(texFormat)) {
            this.ensureDxtTexture(index, device, data, texFormat);
            return;
        }

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
                viewFormats: dxSrgbViewFormats("rgba8unorm"),
                mipLevelCount: levelCount,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            // Default view covers all mip levels → the sampler's mip filter has a chain to walk.
            this.textures.setGpuTexture(index, gpuTexture, gpuTexture.createView());
            this.gpuResourceGeneration++; // a new GPU object invalidates the redundant-RT fast path
            this.textures.setDirty(index, true);
            this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
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
        // A resident, clean texture needs neither the mip upload plan nor the BC capability
        // probe, and this runs per BOUND TEXTURE PER DRAW. Every writer of mipLevelData marks
        // the texture dirty, so a clean one cannot have gained an authored level behind us.
        if (this.textures.getGpuTexture(index) && !this.textures.isDirty(index)
            && !(globalThis as { __noD3D9TexMemo?: boolean }).__noD3D9TexMemo) return;
        const width = this.textures.getWidth(index);
        const height = this.textures.getHeight(index);
        const handle = this.textures.getHandle(index);
        // Keep native-compressed and CPU-decoded uploads on the same authored-only
        // mip policy as ordinary textures.  The old path created a one-level BC image
        // even after LockRect(level > 0), so valid authored mips were silently ignored.
        const uploadPlan = d3dTextureMipUploadPlan(
            width, height, this.textures.getLevels(index),
            (level) => this.mipLevelData.has(`${handle}:${level}`),
        );
        const levelCount = uploadPlan.length;
        const useBc = canUploadNativeBC(format, width, height, this.backend.supportsBC());

        let gpuTexture = this.textures.getGpuTexture(index);
        if (!gpuTexture || gpuTexture.mipLevelCount !== levelCount) {
            gpuTexture = device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                mipLevelCount: levelCount,
                format: useBc ? getNativeBCTextureFormat(format)! : "rgba8unorm",
                viewFormats: dxSrgbViewFormats(useBc ? getNativeBCTextureFormat(format)! : "rgba8unorm"),
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            const view = gpuTexture.createView();
            this.textures.setGpuTexture(index, gpuTexture, view);
            this.gpuResourceGeneration++; // a new GPU object invalidates the redundant-RT fast path
            this.textures.setDirty(index, true);
            this.arenaSamplerBankGeneration++; // content change: the resolved stage window must re-run ensureTexture
        }

        if (!this.textures.isDirty(index)) return;

        const queue = this.backend.getQueue()!;
        let uploadedBytes = 0;
        for (const mip of uploadPlan) {
            const level = mip.level;
            const levelWidth = mip.width;
            const levelHeight = mip.height;
            const pixels = level === 0
                ? { data, pitch: this.textures.getPitch(index) }
                : this.getTextureLevelPixels(handle, level);
            if (!pixels) continue;

            if (useBc) {
                // Upload compressed blocks verbatim for every authored mip. The pitch is
                // block-row based, and so must the EXTENT be: WebGPU validates a compressed
                // copy in whole blocks, so a 2x2 or 1x1 mip tail copies as the one block that
                // backs it. Passing the logical size there invalidates the copy, the command
                // buffer, and every draw in the frame.
                queue.writeTexture(
                    { texture: gpuTexture, mipLevel: level },
                    pixels.data as any,
                    { bytesPerRow: pixels.pitch },
                    {
                        width: blockCompressedCopyDim(format, levelWidth),
                        height: blockCompressedCopyDim(format, levelHeight),
                        depthOrArrayLayers: 1,
                    },
                );
            } else {
                const size = levelWidth * levelHeight * 4;
                if (!this.textureConversionBuffer || this.textureConversionBuffer.length < size) {
                    this.textureConversionBuffer = new Uint8Array(size);
                }
                const rgba = this.textureConversionBuffer.subarray(0, size);
                decodeD3DTextureToRgba8(pixels.data, 0, levelWidth, levelHeight, format, {
                    pitch: pixels.pitch,
                    out: rgba,
                });
                queue.writeTexture(
                    { texture: gpuTexture, mipLevel: level },
                    rgba as any,
                    { bytesPerRow: levelWidth * 4 },
                    { width: levelWidth, height: levelHeight, depthOrArrayLayers: 1 },
                );
            }
            uploadedBytes += pixels.data.length;
        }

        this.textures.setDirty(index, false);
        if (this.frameSnapshot.frameCounters) {
            this.frameSnapshot.frameCounters.uploads++;
            this.frameSnapshot.frameCounters.textureBytes += uploadedBytes;
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
        // A cube mip is only useful when all six faces of that level were authored.  Creating
        // a full declared chain after only one face/level was locked makes the sampler walk
        // into transparent zeroes and differs from D3D's authored-subresource contract.  The
        // chain grows deterministically as the remaining faces arrive; old views stay alive
        // for already-recorded bind groups while the new view becomes the current one.
        const authoredLevels = effectiveCubeMipLevels(
            this.textures.getLevels(index), this.textures.getWidth(index), this.textures.getHeight(index),
            (face, lvl) => this.cubeFaceData.has(`${handle}:${face}:${lvl}`),
        );
        const isRenderTarget = this.textures.isRenderTarget(index);
        const levels = isRenderTarget ? gpuTexture.mipLevelCount : authoredLevels;
        if (!isRenderTarget && gpuTexture.mipLevelCount !== levels) {
            const replacement = device.createTexture({
                size: {
                    width: this.textures.getWidth(index),
                    height: this.textures.getHeight(index),
                    depthOrArrayLayers: 6,
                },
                format: "rgba8unorm",
                viewFormats: dxSrgbViewFormats("rgba8unorm"),
                mipLevelCount: levels,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.textures.setGpuTexture(index, replacement,
                replacement.createView({ dimension: "cube", arrayLayerCount: 6 }));
            this.gpuResourceGeneration++; // a new GPU object invalidates the redundant-RT fast path
            gpuTexture = replacement;
        }
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

    /** Current diagnostic overrides — they are sticky, and a forgotten one silently
     *  colours every later observation, so a caller must be able to read them back. */
    getDebugFlags(): D3D9DebugFlags {
        return { ...this.debugFlags };
    }

    /**
     * Arm/disarm one diagnostic override. Unknown names are REFUSED (false), because a
     * silently ignored toggle is an A/B that measures nothing while reading as "this stage
     * is not the cause" — the failure mode these knobs exist to avoid.
     */
    setDebugToggle(toggle: string, enabled: boolean): boolean {
        if (!(toggle in this.debugFlags)) return false;
        const key = toggle as keyof D3D9DebugFlags;
        if (this.debugFlags[key] === enabled) return true;
        this.debugFlags[key] = enabled;
        // Every pipeline in flight was built under the previous setting. The canonical arena
        // identity normally separates these states, but clear both caches and the last-resolve
        // memo at the toggle boundary so no stale in-flight alias survives.
        this.pipelineCache.clear();
        this.progPipelineCache.clear();
        this.arenaPipelineCache.clear();
        this.compactPipelineIdentityCache.clear();
        this.arenaIdentityByPipelineState.clear();
        this.invalidateLastResolve();
        this.currentPipelineKey = null;
        this.currentPipelineId = null;
        return true;
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
        const slot = d3d9TextureStageSlot(stage);
        return slot >= 0 ? (this.boundTexturePtrs[slot] ?? 0) : 0;
    }

    getBoundIndexBufferPtr(): number {
        return this.boundIndexPtr;
    }

    getAllRenderStates(): Array<{ state: number; value: number }> {
        const out: Array<{ state: number; value: number }> = [];
        for (let state = 0; state < 256; state++) {
            const value = this.getRenderState(state);
            // State-block Capture must include zero-valued states too: an unset/default zero
            // captured before a later SetRenderState must be able to restore that zero.
            out.push({ state, value });
        }
        return out;
    }

    getAllTextureStageStates(): Array<{ stage: number; type: number; value: number }> {
        const out: Array<{ stage: number; type: number; value: number }> = [];
        // CapturePixelState owns the complete fixed-function stage-state table. Include unset
        // defaults so a later Apply can restore a zero-valued state as well as a changed one.
        for (let stage = 0; stage < D3D9_FFP_STAGE_COUNT; stage++) {
            for (let type = 1; type <= 32; type++) {
                out.push({ stage, type, value: this.getTextureStageState(stage, type) });
            }
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
        for (const state of Array.from({ length: 8 }, (_u, i) => D3DTS_WORLD + i).concat([D3DTS_VIEW, D3DTS_PROJECTION])) {
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
        const source = this.softwareVertexProcessing ? this.swvpVsConstants : this.vsConstants;
        for (let i = 0; i < count && baseIdx + i < source.length; i++) {
            out[i] = source[baseIdx + i]!;
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
        return new Float32Array(this.softwareVertexProcessing ? this.swvpVsConstants : this.vsConstants);
    }

    getAllVertexShaderConstantsI(): Int32Array {
        return new Int32Array(this.softwareVertexProcessing ? this.swvpVsIntegerConstants : this.vsIntegerConstants);
    }

    getAllVertexShaderConstantsB(): Int32Array {
        return this.getVertexShaderConstantsB(0, this.softwareVertexProcessing ? 2048 : SHADER_BOOLEAN_REGISTER_COUNT);
    }

    getAllPixelShaderConstants(): Float32Array {
        return new Float32Array(this.psConstants);
    }

    getAllPixelShaderConstantsI(): Int32Array {
        return new Int32Array(this.psIntegerConstants);
    }

    getAllPixelShaderConstantsB(): Int32Array {
        return this.getPixelShaderConstantsB(0, SHADER_BOOLEAN_REGISTER_COUNT);
    }
}

// Point-sprite quad corners (screen space, +y down). Corner (0,0) UV = top-left = (-half,-half).
// 6 indices = 2 triangles; winding is irrelevant (points are never culled → forceCullNone).
const PS_CX = [-1, 1, -1, 1] as const; // per-corner x sign
const PS_CY = [-1, -1, 1, 1] as const; // per-corner y sign (screen down)
const PS_U = [0, 1, 0, 1] as const;    // generated sprite U
const PS_V = [0, 0, 1, 1] as const;    // generated sprite V
const PS_TRI = [0, 1, 2, 2, 1, 3] as const;

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
export function emitFfpShader(d: {
    inputFields: string[];
    hasRhw: boolean;
    hasTex: boolean;
    /** A second FVF texcoord set is present — a stage can sample its own coordinates. */
    hasTex1?: boolean;
    /** Some active stage generates its own coordinates (D3DTSS_TCI_*). Only load-bearing when
     *  the vertex carries NO texcoord: whether the shader declares samplers at all is then a
     *  structural choice a uniform cannot make, so it is part of the pipeline cache key. */
    texGen?: boolean;
    /** Expressions for the eight fixed-function vertex UV sets. Declaration-based FFP can
     *  carry all D3D9 TEXCOORDn semantics; the legacy FVF path supplies the two sets it has
     *  historically exposed and zero-fills the rest. Every expression must evaluate to vec4. */
    texCoordExprs?: string[];
    /** Texture blend stages to emit (1..FFP_MAX_STAGES); baked into the pipeline. */
    stageCount?: number;
    lit: boolean;
    colorExpr: string;
    specularExpr: string;
    normalExpr: string;
    /** Object-space position lanes. POSITION/FLOAT4 carries a real homogeneous W;
     * only POSITIONT denotes the screen-space XYZRHW path. */
    positionExpr?: string;
    positionWExpr?: string;
    /** Optional fixed-function palette/tween inputs. Fields are present only when the active
     * vertex declaration/FVF carries the corresponding data; the uniform control selects the
     * mode per draw. */
    blendWeightsExpr?: string;
    blendIndicesExpr?: string;
    tweenPosExpr?: string;
    tweenNormalExpr?: string;
    /** Decoded D3D sampler intent for the fixed-function fragment stages. */
    samplerStates?: ReadonlyMap<number, SamplerSpec>;
    alphaTest: AlphaTest | null;
    /** D3DRS_SHADEMODE == D3DSHADE_FLAT: the colour varyings take the provoking vertex
     *  unchanged instead of being interpolated. Part of the pipeline key (rasterStateKey). */
    flatShading?: boolean;
}): string {
    const objectPosition = d.positionExpr ?? "input.pos";
    const objectPositionW = d.positionWExpr ?? "1.0";
    // Pre-transformed (XYZRHW) vertices arrive in screen pixels with rhw = 1/w. Emitting them
    // with clip w = 1 would rasterize in the right place but interpolate every varying
    // AFFINELY — UVs shear across large polygons and swim as the camera moves, the classic
    // no-perspective-correction look. Recover w = 1/rhw and scale the clip coords by it: the
    // hardware divides back out to the same NDC, and now interpolates perspective-correctly.
    // Z is clamped to [0,1] first (D3D's rule for pre-transformed vertices) so an out-of-range
    // depth does not clip the triangle away. Matches the DDraw/D3D7 converter's treatment.
    // u.viewport.z is the pixel-centre offset in pixels (webgpu/pixel-center.ts): the same
    // half-pixel the transformed branch gets folded into u.mvp, so the two branches place the
    // same screen-space point identically. 0 until the convention is switched on.
    const blendBody = (!d.hasRhw && (d.blendWeightsExpr || d.blendIndicesExpr || d.tweenPosExpr))
        ? `var _ffpPos = ${objectPosition};
        var _ffpNormal = ${d.normalExpr};
        let _ffpMode = u32(u.blendCtrl.x);
        if (_ffpMode == 255u && ${d.tweenPosExpr ? "true" : "false"}) {
            _ffpPos = mix(${objectPosition}, ${d.tweenPosExpr ?? objectPosition}, u.blendCtrl.z);
            ${d.tweenNormalExpr ? `_ffpNormal = mix(${d.normalExpr}, ${d.tweenNormalExpr}, u.blendCtrl.z);` : ""}
        } else if ((_ffpMode >= 1u && _ffpMode <= 3u || _ffpMode == 256u) && ${d.blendWeightsExpr || d.blendIndicesExpr ? "true" : "false"}) {
            let _ffpCount = max(1u, min(4u, u32(u.blendCtrl.w)));
            var _ffpRemain = 1.0;
            var _ffpBlendPos = vec3<f32>(0.0);
            var _ffpBlendNormal = vec3<f32>(0.0);
            var _ffpI = 0u;
            loop {
                if (_ffpI >= _ffpCount) { break; }
                let _ffpW = select(1.0 - (_ffpRemain - 0.0), _ffpRemain, _ffpI + 1u == _ffpCount);
                // For explicit weights, subtract after reading; the final iteration consumes
                // the exact remaining partition of unity. Indexed indices are clamped to the
                // eight uniform palette entries, matching D3D9's advertised matrix-index cap.
                var _ffpWeight = _ffpW;
                if (_ffpI + 1u < _ffpCount) {
                    _ffpWeight = ${d.blendWeightsExpr ? `${d.blendWeightsExpr}[_ffpI]` : "0.0"};
                    _ffpRemain = _ffpRemain - _ffpWeight;
                }
                var _ffpIndex = _ffpI;
                if (u.blendCtrl.y > 0.5 && ${d.blendIndicesExpr ? "true" : "false"}) {
                    _ffpIndex = min(${d.blendIndicesExpr ?? "vec4<u32>(0u)"}[_ffpI], 7u);
                }
                let _ffpM = u.blendMatrices[_ffpIndex];
                _ffpBlendPos = _ffpBlendPos + _ffpWeight * (_ffpM * vec4<f32>(${objectPosition}, ${objectPositionW})).xyz;
                _ffpBlendNormal = _ffpBlendNormal + _ffpWeight * (_ffpM * vec4<f32>(_ffpNormal, 0.0)).xyz;
                _ffpI = _ffpI + 1u;
            }
            _ffpPos = _ffpBlendPos;
            _ffpNormal = _ffpBlendNormal;
        }`
        : `var _ffpPos = ${objectPosition};
        var _ffpNormal = ${d.normalExpr};`;

    const posBody = d.hasRhw
        ? `let rhw = input.pos.w;
        let w = select(1.0, 1.0 / rhw, rhw != 0.0);
        let ndcX = ((input.pos.x + u.viewport.z) / u.viewport.x) * 2.0 - 1.0;
        let ndcY = 1.0 - ((input.pos.y + u.viewport.z) / u.viewport.y) * 2.0;
        out.position = vec4<f32>(ndcX * w, ndcY * w, clamp(input.pos.z, 0.0, 1.0) * w, w);`
        : `let _ffpPositionW = select(${objectPositionW}, 1.0, u.blendCtrl.x != 0.0);
        out.position = u.mvp * vec4<f32>(_ffpPos, _ffpPositionW);`;

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
            let wp = select(u.world * vec4<f32>(${objectPosition}, ${objectPositionW}), vec4<f32>(_ffpPos, 1.0), u.blendCtrl.x != 0.0);
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
        const samplerSpec = d.samplerStates?.get(s);
        const coord = `_ffpSampleCoord${s}`;
        const coordParts: string[] = [];
        const outsideParts: string[] = [];
        for (const [component, mode] of [["x", samplerSpec?.addressU], ["y", samplerSpec?.addressV]] as const) {
            const value = `(${coord}).${component}`;
            if (mode === "d3d9-mirror-once") {
                coordParts.push(`clamp(abs(${value}), 0.0, 1.0)`);
            } else if (mode === "d3d9-border") {
                coordParts.push(`clamp(${value}, 0.0, 1.0)`);
                outsideParts.push(`(${value} < 0.0 || ${value} > 1.0)`);
            } else {
                coordParts.push(value);
            }
        }
        const sampledCoord = samplerSpec && (samplerSpec.addressU === "d3d9-border"
            || samplerSpec.addressU === "d3d9-mirror-once"
            || samplerSpec.addressV === "d3d9-border"
            || samplerSpec.addressV === "d3d9-mirror-once")
            ? `vec2<f32>(${coordParts.join(", ")})` : coord;
        const rawBorder = samplerSpec?.borderColor ?? 0;
        const borderColor = `vec4<f32>(${((rawBorder >>> 16) & 0xff) / 255}, ${((rawBorder >>> 8) & 0xff) / 255}, ${(rawBorder & 0xff) / 255}, ${((rawBorder >>> 24) & 0xff) / 255})`;
        const bias = samplerSpec?.mipLodBias;
        const biasText = bias !== undefined && Number.isFinite(bias) && bias !== 0
            ? (Number.isInteger(bias) ? `${bias}.0` : `${bias}`) : null;
        const sample = biasText
            ? `textureSampleBias(${tex}, ${smp}, ${sampledCoord}, ${biasText})`
            : `textureSample(${tex}, ${smp}, ${sampledCoord})`;
        const sampledTexel = outsideParts.length > 0
            ? `select(${sample}, ${borderColor}, ${outsideParts.join(" || ")})`
            : sample;
        // Every stage carries its own final coordinate (source select + texture matrix already
        // applied in the vertex stage), so nothing here needs to know about UV sets or texgen.
        const arg = (sel: string) => `ffpStageArg(${sel}, _t, _cur, _diff, _spec, _tmp, u.tfactor, u.stageConstants[${s}])`;
        return `
    if (u32(u.stages[${s}].a.x) != 1u) {
        let _ffpSampleCoord${s} = ffpProjectTexcoord(input.tc${s}, u32(u.texGen[${s}].y));
        var _t = ${sampledTexel};
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
        let _colorOp = u32(u.stages[${s}].a.x);
        let _rgb = ffpStageOp(_colorOp, _a0, _a1, _a2, _t, _cur, _diff, u.tfactor, _dst);
        var _al = _dst.a;
        // DOTPRODUCT3 is a four-channel operation. D3D replicates its signed dot
        // into alpha even when the stage's ALPHAOP selects another argument.
        if (_colorOp == 24u) {
            _al = _rgb.a;
        } else if (u32(u.stages[${s}].a.w) != 1u) {
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
    // Eye-space position is also needed by range fog. Keep it available even for an otherwise
    // unlit/untextured FFP draw; the extra matrix multiply is cheaper and safer than refusing a
    // valid D3DRS_RANGEFOGENABLE state or approximating Euclidean distance with clip W.
    const eyeSpaceBody = d.hasRhw
        ? `let _ecPos = input.pos.xyz;
        let _ecNormal = vec3<f32>(0.0);`
        : `let _ecPos = (u.worldView * vec4<f32>(_ffpPos, select(${objectPositionW}, 1.0, u.blendCtrl.x != 0.0))).xyz;
        ${d.lit || samples
            ? `var _ecNormal = (u.normalMatrix * vec4<f32>(_ffpNormal, 0.0)).xyz;
        if (u.ctrl2.w > 0.5 && any(_ecNormal != vec3<f32>(0.0))) { _ecNormal = normalize(_ecNormal); }`
            : ""}`;

    // Per-stage texture coordinates: source select (vertex UV set or a TCI_* generator) plus
    // the stage's D3DTS_TEXTURE matrix, both driven by uniforms — texgen turning on or off
    // never rebuilds the pipeline. XYZRHW skips the matrix, matching D3D.
    const uvExprs = [...(d.texCoordExprs ?? [
        // D3D texture coordinates are homogeneous with the projective divider in W:
        // (u, v, 1, 0) for a two-component FVF set.  The old (u, v, 0, 1) fallback
        // made the default TEXCOORD projection use an unintended Q of one.
        d.hasTex ? "vec4<f32>(input.uv, 1.0, 0.0)" : "vec4<f32>(0.0)",
        d.hasTex1 ? "vec4<f32>(input.uv1, 1.0, 0.0)" : (d.hasTex ? "vec4<f32>(input.uv, 1.0, 0.0)" : "vec4<f32>(0.0)"),
    ])];
    while (uvExprs.length < 8) uvExprs.push("vec4<f32>(0.0)");
    const uvSrc = uvExprs.slice(0, 8).map((expr, i) => `let _uv${i} = ${expr};`).join("\n    ");
    const texCoordBody = samples
        ? uvSrc + "\n" + Array.from({ length: stageCount }, (_unused, s) => {
            const uvArgs = Array.from({ length: 8 }, (_u, i) => `_uv${i}`).join(", ");
            const src = `ffpTexCoordSrc(u32(u.texGen[${s}].x), ${uvArgs}, _ecPos, _ecNormal)`;
            return d.hasRhw
                ? `    out.tc${s} = ${src};`
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
            // SPECULARENABLE controls whether the computed term replaces vertex
            // specular RGB. When disabled, D3D passes COLOR1 through unchanged.
            let litSpecular = select(vSpecular.xyz, lit[1].xyz, u.ctrl0.z > 0.5);
            out.specular = vec4<f32>(litSpecular, vSpecular.a);
        } else {
            out.color = vDiffuse;
            out.specular = vSpecular;
        }`
        : `out.color = ${d.colorExpr};
        out.specular = ${d.specularExpr};`;

    // D3DSHADE_FLAT: only the colour registers stop interpolating; texcoords, fog and the
    // clip distances stay perspective-correct (WGSL's default) exactly as on D3D9 hardware.
    const flat = d.flatShading ? " @interpolate(flat)" : "";
    return `
${FFP_UNIFORM_STRUCT_WGSL}
@group(0) @binding(0) var<uniform> u: Uniforms;
${stageBindings}

struct VertexInput {
    ${d.inputFields.join(",\n    ")}
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0)${flat} color: vec4<f32>,
    // D3D vertex fog factor (0 = unfogged). Table/pixel fog is intentionally recomputed from
    // interpolated FragCoord in fs_main rather than approximated at the vertex.
    @location(1) fog: f32,
    // Vertex colour 1. Present whether or not the draw is lit: the stage cascade can select it
    // as D3DTA_SPECULAR, which has nothing to do with D3DRS_LIGHTING.
    @location(2)${flat} specular: vec4<f32>,
    // FFP user clip-plane signed distances (planes 0..3 in clipA, 4..5 in clipB), interpolated
    // for the per-pixel discard in fs_main. Constant 1.0 (no clip) unless clipping is enabled.
    @location(3) clipA: vec4<f32>,
    @location(4) clipB: vec2<f32>,
    // One FINAL texture coordinate per emitted blend stage (location 5 + stage), not one per
    // vertex UV set: after texgen and the texture matrix, two stages reading the same set can
    // still need different coordinates. Locations stay under the 16-variable inter-stage limit
    // because the count is FFP_MAX_STAGES at most.
${Array.from({ length: samples ? stageCount : 0 }, (_unused, s) => `    @location(${5 + s}) tc${s}: vec4<f32>,`).join("\n")}
}
${FFP_UNPACK_COLOR_WGSL}
${FFP_FOG_WGSL}
${samples ? FFP_TEXGEN_WGSL : ""}
${d.lit ? FFP_SELECT_COLOR_WGSL + "\n" + emitFfpComputeLighting("u.lights") : ""}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    ${blendBody}
    ${posBody}
    ${eyeSpaceBody}
    ${colorBody}
${texCoordBody}
    ${clipVsBody}
    // Pre-transformed vertex fog reads the factor the app wrote into specular alpha, which
    // FFP lighting leaves alone (it replaces the specular RGB only) — so take it from the
    // raw vertex, not from a lit value.
    out.fog = 0.0;
    if (u.fogParams.w < 1.0 || u.fogParams.w >= 4.0) {
        out.fog = ffpFogFactor(u.fogParams.w, u.fogParams.x, u.fogParams.y, u.fogParams.z,
            out.position.z, abs(_ecPos.z), (${d.specularExpr}).a, length(_ecPos));
    }
    return out;
}

${emitFfpCombinerWgsl(unhandledOpMagenta() ? "vec4<f32>(1.0, 0.0, 1.0, 1.0)" : "dst")}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    ${clipFsBody}
    let _diff = input.color;
    var _c: vec4<f32> = _diff;
${stageBody}
    // SPECULARENABLE is a runtime render state, not a property of whether the
    // vertex shader was built with T&L lighting.  Unlit FFP draws can still
    // supply COLOR1 and D3D adds it after the texture cascade.
    if (u.ctrl0.z > 0.5) { _c = vec4<f32>(clamp(_c.rgb + input.specular.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), _c.a); }
    ${alphaTestSnippet(d.alphaTest, "_c.a")}
    var _fogFactor = input.fog;
    if (u.fogParams.w >= 1.0 && u.fogParams.w < 4.0) {
        let _fragDepth = input.position.z / input.position.w;
        _fogFactor = ffpFogFactor(u.fogParams.w, u.fogParams.x, u.fogParams.y, u.fogParams.z,
            _fragDepth, _fragDepth, input.specular.a, _fragDepth);
    }
    if (u.fogParams.w > 0.0) { _c = vec4<f32>(mix(_c.rgb, u.fogColor.rgb, _fogFactor), _c.a); }
    return _c;
}
`;
}

/** `boundStride` is SetStreamSource's Stride (0 = none bound); it decides which components fit
 *  the vertex and must be the same value buildVertexLayout is given — see planFvf. */
function buildShader(fvf: number, alphaTest: AlphaTest | null = null, litRequested = false, stageCount = 1,
                     texGen = false, boundStride = 0,
                     samplerStates?: ReadonlyMap<number, SamplerSpec>, flatShading = false): string {
    const f = planFvf(fvf, boundStride);
    const lit = litRequested && !f.hasRhw;

    const inputFields: string[] = [`@location(${f.posLoc}) pos: ${f.hasRhw ? "vec4<f32>" : "vec3<f32>"}`];
    if (f.hasNormal) inputFields.push(`@location(${f.normalLoc}) normal: vec3<f32>`);
    if (f.hasColor) inputFields.push(`@location(${f.colorLoc}) color: u32`);
    if (f.hasSpecular) inputFields.push(`@location(${f.specularLoc}) specColor: u32`);
    const texFieldType = (dims: number): string => dims === 1 ? "f32"
        : dims === 3 ? "vec3<f32>" : dims === 4 ? "vec4<f32>" : "vec2<f32>";
    for (let set = 0; set < f.texLocs.length; set++) {
        if (f.hasTexSets[set]) inputFields.push(
            `@location(${f.texLocs[set]}) uv${set}: ${texFieldType(f.texDims[set] ?? 2)}`);
    }
    const texCoordExprs = f.texLocs.map((_loc, set) => {
        if (!f.hasTexSets[set]) return "vec4<f32>(0.0)";
        const field = `input.uv${set}`;
        switch (f.texDims[set]) {
            case 1: return `vec4<f32>(${field}, 1.0, 0.0, 0.0)`;
            case 2: return `vec4<f32>(${field}, 1.0, 0.0)`;
            case 3: return `vec4<f32>(${field}, 1.0)`;
            default: return field;
        }
    });

    const weightInputType = f.blendWeightDims <= 1 ? "f32"
        : f.blendWeightDims === 2 ? "vec2<f32>"
        : f.blendWeightDims === 3 ? "vec3<f32>" : "vec4<f32>";
    if (f.blendWeightLoc >= 0) inputFields.push(`@location(${f.blendWeightLoc}) blendWeights: ${weightInputType}`);
    if (f.blendIndexLoc >= 0) inputFields.push(`@location(${f.blendIndexLoc}) blendIndices: ${f.blendIndexFormat === "uint8x4" ? "vec4<u32>" : "vec4<f32>"}`);
    const blendWeightsExpr = f.blendWeightLoc < 0 ? undefined
        : f.blendWeightDims <= 1 ? "vec4<f32>(input.blendWeights, 0.0, 0.0, 0.0)"
        : f.blendWeightDims === 2 ? "vec4<f32>(input.blendWeights, 0.0, 0.0)"
        : f.blendWeightDims === 3 ? "vec4<f32>(input.blendWeights, 0.0)" : "input.blendWeights";
    const blendIndicesExpr = f.blendIndexLoc < 0 ? undefined
        : f.blendIndexFormat === "uint8x4"
            ? "input.blendIndices"
            : "vec4<u32>(round(input.blendIndices * 255.0))";

    return emitFfpShader({
        inputFields,
        hasRhw: f.hasRhw,
        hasTex: f.hasTex,
        hasTex1: f.hasTex1,
        texCoordExprs,
        texGen,
        stageCount,
        lit,
        colorExpr: f.hasColor ? "unpackColor(input.color)" : "vec4<f32>(1.0, 1.0, 1.0, 1.0)",
        specularExpr: f.hasSpecular ? "unpackColor(input.specColor)" : "vec4<f32>(0.0, 0.0, 0.0, 0.0)",
        normalExpr: f.hasNormal ? "input.normal" : "vec3<f32>(0.0, 0.0, 1.0)",
        blendWeightsExpr,
        blendIndicesExpr,
        samplerStates,
        alphaTest,
        flatShading,
    });
}

function buildVertexLayout(fvf: number, boundStride = 0): {
    arrayStride: number;
    attributes: GPUVertexAttribute[];
    hasTexture: boolean;
    hasTexture1: boolean;
} {
    const f = planFvf(fvf, boundStride);
    return {
        arrayStride: f.arrayStride, attributes: f.attributes,
        hasTexture: f.hasTex, hasTexture1: f.hasTex1,
    };
}

// ── D3DVERTEXELEMENT9 helpers ─────────────────────────────────────────────────

/** UDEC3/DEC3N use packed 10-bit lanes, which WebGPU has no vertex format for.
 * Keep them explicit rather than reading four bytes as a fabricated float32x4. */
function isD3D9DeclTypeGpuRepresentable(type: number): boolean {
    return (type >= 0 && type <= 12) || type === 15 || type === 16;
}

/**
 * Map D3DDECLTYPE to a WebGPU vertex format and its byte size.
 * Formats without an exact WebGPU representation are refused by the caller;
 * never reinterpret their packed bytes as float32x4.
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
        default: throw new Error(`unsupported D3DDECLTYPE ${type}`);
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
const DECLUSAGE_BLENDWEIGHT_FFP = 1;
const DECLUSAGE_BLENDINDICES_FFP = 2;
const DECLUSAGE_NORMAL_FFP    = 3;
const DECLUSAGE_POSITIONT_FFP = 9;  // pre-transformed (XYZRHW)
const DECLUSAGE_TEXCOORD_FFP  = 5;
const DECLUSAGE_COLOR_FFP     = 10;
const D3DDECLTYPE_D3DCOLOR    = 4;  // stored as BGRA bytes

/** The semantics the fixed-function paths read out of a declaration. */
const FFP_CONSUMED_USAGES: ReadonlySet<number> = new Set([
    DECLUSAGE_POSITION_FFP, DECLUSAGE_NORMAL_FFP, DECLUSAGE_POSITIONT_FFP,
    DECLUSAGE_TEXCOORD_FFP, DECLUSAGE_COLOR_FFP, DECLUSAGE_BLENDWEIGHT_FFP,
    DECLUSAGE_BLENDINDICES_FFP,
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
    /** Bound stride per slot; a slot the guest bound with stride 0 falls back to the
     *  packed size its own elements imply. */
    streamStrides: readonly number[] = [],
    /** The slots this pipeline may declare, as a bitmask. A CPU-converted draw that repacks
     *  its vertices into one buffer passes 1 (slot 0 alone): the pipeline must declare exactly
     *  the buffers the draw binds, or WebGPU rejects it. */
    slotMask = 0xffff,
    /** Some active stage generates its own texture coordinates — see emitFfpShader.texGen. */
    texGen = false,
    samplerStates?: ReadonlyMap<number, SamplerSpec>,
    flatShading = false,
): {
    wgsl: string;
    /** One layout per stream slot, indexed by stream number; null for slots the
     *  declaration does not use (WebGPU accepts holes in `vertex.buffers`). */
    buffers: (GPUVertexBufferLayout | null)[];
    hasTexture: boolean;
} {
    const declared = elements.filter(e => ((slotMask >>> e.stream) & 1) !== 0);

    // The stride the guest BOUND is what D3D9 steps a stream by — the declaration only says
    // where components sit inside a vertex. It may legitimately exceed the packed size (data
    // this declaration names no attribute for), so the packed size is the fallback for an
    // UNBOUND stream, never a floor: stepping by a packed size that overshoots reads every
    // vertex after the first out of its successor and runs the draw past the buffer's end.
    const strideFor = (stream: number): number =>
        slotArrayStride(streamStrides[stream] ?? 0, computeDeclStride(declared, stream));
    // An element that does not fit the bound vertex is dropped HERE, before anything is
    // emitted, so the shader never declares an input the vertex state cannot supply — a
    // pipeline whose WGSL and layout disagree is rejected outright and takes the frame with
    // it. Position is exempt: without it there is no draw to salvage, so that stream keeps
    // the packed stride instead.
    const posStream = declared.find(
        e => e.usage === DECLUSAGE_POSITION_FFP || e.usage === DECLUSAGE_POSITIONT_FFP)?.stream ?? 0;
    const posFits = declared.every(e => e.stream !== posStream
        || (e.usage !== DECLUSAGE_POSITION_FFP && e.usage !== DECLUSAGE_POSITIONT_FFP)
        || e.offset + d3dDeclTypeToGpu(e.type).byteSize <= strideFor(e.stream));
    const streamStride = (stream: number): number => (!posFits && stream === posStream)
        ? Math.max(strideFor(stream), computeDeclStride(declared, stream))
        : strideFor(stream);
    const all = declared.filter(
        e => e.offset + d3dDeclTypeToGpu(e.type).byteSize <= streamStride(e.stream));
    if (all.length !== declared.length) {
        Logger.warn(LogCategory.D3D9,
            `[D3D9] declaration: ${declared.length - all.length} element(s) fall outside the bound `
            + `stride and were dropped (streams ${[...new Set(declared.map(e => e.stream))].join(",")})`);
    }

    // Find the key semantic elements we care about. A declaration addresses these by
    // (stream, offset) and each stream is bound separately, so the search spans every
    // stream — restricting it to stream 0 silently drops whatever the others carry.
    const posElem = all.find(e => e.usage === DECLUSAGE_POSITION_FFP || e.usage === DECLUSAGE_POSITIONT_FFP) ?? null;
    const posTweenElem = all.find(e => e.usage === DECLUSAGE_POSITION_FFP && e.usageIndex === 1) ?? null;
    const normElem = all.find(e => e.usage === DECLUSAGE_NORMAL_FFP   && e.usageIndex === 0) ?? null;
    const normTweenElem = all.find(e => e.usage === DECLUSAGE_NORMAL_FFP && e.usageIndex === 1) ?? null;
    const blendWeightElem = all.find(e => e.usage === DECLUSAGE_BLENDWEIGHT_FFP && e.usageIndex === 0) ?? null;
    const blendIndexElem = all.find(e => e.usage === DECLUSAGE_BLENDINDICES_FFP && e.usageIndex === 0) ?? null;
    // D3D9 exposes eight independent FFP coordinate sets. Keep one declaration element per
    // set instead of aliasing TEXCOORD2..7 to set zero; a stage's low TEXCOORDINDEX bits are
    // allowed to select any of them.
    const texElems: Array<RawVertexElement | null> = Array.from({ length: FFP_MAX_STAGES }, (_u, set) =>
        all.find(e => e.usage === DECLUSAGE_TEXCOORD_FFP && e.usageIndex === set) ?? null);
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

    // XYZRHW is identified by POSITIONT. POSITION/FLOAT4 is an object-space
    // homogeneous position and must still pass through the fixed-function MVP.
    const isRHW = posElem.usage === DECLUSAGE_POSITIONT_FFP;
    const hasNormal = !isRHW && normElem !== null;
    const hasColor = colElem !== null;
    const hasSpecular = specElem !== null;
    const hasTex   = texElems.some(e => e !== null);
    const hasTex1  = texElems[1] !== null;
    const lit = litRequested && !isRHW;

    // Assign contiguous shader locations in declaration order: pos, [normal], [color], [specular], [uv], [uv1].
    let loc = 0;
    const posLoc = loc++;
    const normLoc = hasNormal ? loc++ : -1;
    const colLoc = hasColor ? loc++ : -1;
    const specLoc = hasSpecular ? loc++ : -1;
    const texLocs = texElems.map(e => e !== null ? loc++ : -1);
    const blendWeightLoc = blendWeightElem ? loc++ : -1;
    const blendIndexLoc = blendIndexElem ? loc++ : -1;
    const posTweenLoc = posTweenElem ? loc++ : -1;
    const normTweenLoc = normTweenElem && hasNormal ? loc++ : -1;

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
    for (let set = 0; set < texElems.length; set++) addAttr(texElems[set], texLocs[set]!);
    addAttr(blendWeightElem, blendWeightLoc);
    addAttr(blendIndexElem, blendIndexLoc);
    addAttr(posTweenElem, posTweenLoc);
    addAttr(normTweenElem && hasNormal ? normTweenElem : null, normTweenLoc);

    const buffers: (GPUVertexBufferLayout | null)[] = [];
    for (const [stream, attrs] of [...perStream].sort((a, b) => a[0] - b[0])) {
        // Same stride the elements were filtered against, so the layout and the emitted
        // WGSL cannot disagree about which attributes exist.
        while (buffers.length < stream) buffers.push(null);
        buffers.push({ arrayStride: streamStride(stream) || 12, attributes: attrs });
    }

    // Build input struct fields. The WGSL base type must match the WebGPU vertex format;
    // declaring every colour as vec4<f32> makes UBYTE4/SHORT2 declarations invalidate the
    // whole module before the FFP shader can be observed.
    const declInputType = (elem: RawVertexElement): string => {
        switch (elem.type) {
            case 0: return "f32";
            case 1: return "vec2<f32>";
            case 2: return "vec3<f32>";
            case 3: return "vec4<f32>";
            case 4:
            case 8: return "vec4<f32>";
            case 5: return "vec4<u32>";
            case 6: return "vec2<i32>";
            case 7: return "vec4<i32>";
            case 9:
            case 11:
            case 15: return "vec2<f32>";
            case 10:
            case 12:
            case 16: return "vec4<f32>";
            default: return "vec4<f32>";
        }
    };
    const inputFields: string[] = [];
    inputFields.push(`@location(${posLoc}) pos: ${isRHW || posElem.type === 3 ? "vec4<f32>" : "vec3<f32>"}`);
    if (hasNormal) inputFields.push(`@location(${normLoc}) normal: vec3<f32>`);
    if (hasColor) inputFields.push(`@location(${colLoc}) color: ${declInputType(colElem)}`);
    if (hasSpecular) inputFields.push(`@location(${specLoc}) specColor: ${declInputType(specElem)}`);
    const texFieldType = (elem: RawVertexElement): string => declInputType(elem);
    for (let set = 0; set < texElems.length; set++) {
        const elem = texElems[set];
        if (elem) inputFields.push(`@location(${texLocs[set]}) uv${set}: ${texFieldType(elem)}`);
    }
    if (blendWeightElem) inputFields.push(`@location(${blendWeightLoc}) blendWeights: ${texFieldType(blendWeightElem)}`);
    if (blendIndexElem) inputFields.push(`@location(${blendIndexLoc}) blendIndices: ${blendIndexElem.type === 5 ? "vec4<u32>" : "vec4<f32>"}`);
    if (posTweenElem) inputFields.push(`@location(${posTweenLoc}) pos1: ${texFieldType(posTweenElem)}`);
    if (normTweenElem && hasNormal) inputFields.push(`@location(${normTweenLoc}) normal1: ${texFieldType(normTweenElem)}`);

    const texExpr = (set: number, elem: RawVertexElement | null): string => {
        if (!elem) return "vec4<f32>(0.0)";
        const field = `input.uv${set}`;
        switch (elem.type) {
            case 0: return `vec4<f32>(${field}, 1.0, 0.0, 0.0)`;
            case 1: return `vec4<f32>(${field}, 1.0, 0.0)`;
            case 2: return `vec4<f32>(${field}, 1.0)`;
            case 15: return `vec4<f32>(${field}, 1.0, 0.0)`;
            case 16: return field;
            case 5: return `vec4<f32>(${field})`;
            case 6: return `vec4<f32>(vec2<f32>(${field}), 1.0, 0.0)`;
            case 7: return `vec4<f32>(${field})`;
            case 9:
            case 11: return `vec4<f32>(${field}, 1.0, 0.0)`;
            default: return `vec4<f32>(${field})`;
        }
    };
    const texCoordExprs = texElems.map((elem, set) => texExpr(set, elem));

    const vec3Expr = (elem: RawVertexElement | null, field: string): string => {
        if (!elem) return "vec3<f32>(0.0, 0.0, 0.0)";
        if (elem.type === 0) return `vec3<f32>(${field}, 0.0, 0.0)`;
        if (elem.type === 1) return `vec3<f32>(${field}, 0.0)`;
        if (elem.type === 3) return `${field}.xyz`;
        if (elem.type === 15) return `vec3<f32>(${field}, 0.0)`;
        if (elem.type === 16) return `${field}.xyz`;
        return field;
    };
    const weightExpr = blendWeightElem
        ? blendWeightElem.type === 0 ? "vec4<f32>(input.blendWeights, 0.0, 0.0, 0.0)"
        : blendWeightElem.type === 1 || blendWeightElem.type === 15 ? "vec4<f32>(input.blendWeights, 0.0, 0.0)"
        : blendWeightElem.type === 2 ? "vec4<f32>(input.blendWeights, 0.0)"
        : blendWeightElem.type === 6 || blendWeightElem.type === 9 || blendWeightElem.type === 11
            ? "vec4<f32>(vec2<f32>(input.blendWeights), 0.0, 0.0)"
        : blendWeightElem.type === 5 ? "vec4<f32>(input.blendWeights)"
        : "vec4<f32>(input.blendWeights)"
        : undefined;
    const indexExpr = blendIndexElem
        ? blendIndexElem.type === 5 ? "input.blendIndices" : "vec4<u32>(round(input.blendIndices * 255.0))"
        : undefined;

    const declColorExpr = (elem: typeof colElem, field: string): string => {
        if (!elem) return "vec4<f32>(1.0, 1.0, 1.0, 1.0)";
        const value = `input.${field}`;
        switch (elem.type) {
            case D3DDECLTYPE_D3DCOLOR:
                return `vec4<f32>(${value}.z, ${value}.y, ${value}.x, ${value}.w)`;
            case 0: return `vec4<f32>(${value}, 0.0, 0.0, 1.0)`;
            case 1:
            case 15: return `vec4<f32>(${value}, 0.0, 1.0)`;
            case 2: return `vec4<f32>(${value}, 1.0)`;
            case 5: return `vec4<f32>(${value}) / 255.0`;
            case 6: return `vec4<f32>(vec2<f32>(${value}), 0.0, 1.0)`;
            case 7: return `vec4<f32>(vec4<f32>(${value}))`;
            case 9:
            case 11: return `vec4<f32>(${value}, 0.0, 1.0)`;
            default: return `vec4<f32>(${value})`;
        }
    };
    const colorExpr = hasColor ? declColorExpr(colElem, "color") : "vec4<f32>(1.0, 1.0, 1.0, 1.0)";
    const specularExpr = hasSpecular ? declColorExpr(specElem, "specColor") : "vec4<f32>(0.0, 0.0, 0.0, 0.0)";

    const wgsl = emitFfpShader({
        inputFields,
        hasRhw: isRHW,
        hasTex,
        hasTex1,
        texGen,
        texCoordExprs,
        stageCount,
        lit,
        colorExpr,
        specularExpr,
        normalExpr: hasNormal ? "input.normal" : "vec3<f32>(0.0, 0.0, 1.0)",
        positionExpr: !isRHW && posElem.type === 3 ? "input.pos.xyz" : undefined,
        positionWExpr: !isRHW && posElem.type === 3 ? "input.pos.w" : undefined,
        blendWeightsExpr: weightExpr,
        blendIndicesExpr: indexExpr,
        tweenPosExpr: posTweenElem ? vec3Expr(posTweenElem, "input.pos1") : undefined,
        tweenNormalExpr: normTweenElem && hasNormal ? vec3Expr(normTweenElem, "input.normal1") : undefined,
        samplerStates,
        alphaTest,
        flatShading,
    });

    return { wgsl, buffers, hasTexture: hasTex || texGen };
}
