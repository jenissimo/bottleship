/**
 * D3D8 programmable draw layer — rewritten for flat renderStates/TSS (not D3D9 StateTracker).
 */

import type { DirectDrawSurfaceState } from "../../../modules/ddraw/com-objects";
import {
    D3DCULL_CCW,
    D3DCULL_CW,
    D3DCMP_ALWAYS,
    D3DRENDERSTATE_ALPHAFUNC,
    D3DRENDERSTATE_ALPHAREF,
    D3DRENDERSTATE_ALPHATESTENABLE,
    D3DRENDERSTATE_CULLMODE,
    D3DRENDERSTATE_TEXTUREFACTOR,
    D3DRENDERSTATE_ZENABLE,
    D3DRENDERSTATE_ZWRITEENABLE,
    D3DTOP_DISABLE,
    D3DTSS_ALPHAARG0,
    D3DTSS_ALPHAARG1,
    D3DTSS_ALPHAARG2,
    D3DTSS_ALPHAOP,
    D3DTSS_COLORARG0,
    D3DTSS_COLORARG1,
    D3DTSS_COLORARG2,
    D3DTSS_COLOROP,
    D3DTSS_RESULTARG,
    D3DTSS_TEXCOORDINDEX,
    D3DTSS_TEXTURETRANSFORMFLAGS,
    D3DTTFF_PROJECTED,
} from "../../../modules/ddraw/constants";
import { Logger, LogCategory } from "../../../core/logger";
import { recordGpuError } from "../../../core/gpu-error-log";
import { WebGPUBackend } from "../webgpu-backend";
import { D3D9BackendExecutor, UniformData } from "../d3d9/d3d9-backend-executor";
import { D3D9CommandRecorder } from "../d3d9/d3d9-command-recorder";
import { RenderFramePool } from "../render-frame";
import { buildColorTargetState, computeBlendKey } from "../d3d9/d3d9-blend";
import {
    linkProgram,
    computeCubeMask,
    PROG_BIND,
} from "../d3d9/shader";
import type { AlphaTest } from "../d3d9/shader/sm-wgsl";
import {
    D3D_ALPHALESS_FORMATS,
    FFP_MAX_STAGES,
    FFP_STAGE_CONSTANT_FLOATS,
    FFP_UNIFORM_FLOATS,
    ffpStageConstantOffset,
    ffpStageOffset,
    makeFfpParams,
    newFfpColor,
    packFfpUniforms,
    unpackD3dColor,
    type FfpUniformParams,
} from "../d3d9/ffp-lighting";
import { DxSamplerCache, dxSamplerShaderStatesKey, type SamplerSpec } from "../shared/dx-sampler";
import { decodeD3d8TssSampler } from "./d3d8-sampler";
import { pixelCenterClipOffset, withPixelCenterVersion } from "../pixel-center";
import { buildD3D8PipelineKey, D3D8ShaderRegistry } from "./d3d8-shader-registry";
import type { D3D8DeviceAdapter } from "./d3d8-device-adapter";
import type { DDrawWebGPUExecutor } from "../ddraw/ddraw-backend-executor";

/** D3DTSS_CONSTANT — not in the shared ddraw constants table; mirrors d3d9-device.ts's
 *  own local definition (same D3D8/9 TSS index numbering). */
const D3DTSS_CONSTANT = 32;

/**
 * Pipeline-cache identity of the fixed-function cascade a vertex-shader draw with NO pixel
 * shader runs (stage count, projected-texcoord mask, and the sampler state linkProgram bakes
 * into the WGSL: "d3d9-border" address emulation, LOD bias, border colour). Sampler state is
 * part of the SHADER here, not just the sampler object, so a stage switching CLAMP→BORDER
 * between two otherwise identical draws must land on a different key — the same reason
 * d3d9-device.ts keys on `dxSamplerShaderStatesKey`. Empty for a draw with a real pixel
 * shader, whose WGSL reads none of this.
 */
export function buildD3D8FfpVariantKey(
    hybridStages: number,
    projectedMask: number,
    samplerStates: ReadonlyMap<number, SamplerSpec> | null,
): string {
    if (!hybridStages) return `hs0:pj${projectedMask}`;
    return `hs${hybridStages}:pj${projectedMask}:sm${dxSamplerShaderStatesKey(samplerStates ?? new Map())}`;
}

export class D3D8ProgrammableRenderer {
    private commandRecorder = new D3D9CommandRecorder(new RenderFramePool(2));
    private backendExecutor: D3D9BackendExecutor;
    private progPipelineCache = new Map<string, number>();
    private samplerCache?: DxSamplerCache;
    // Pooled scratch for the hybrid (VS + NULL PS) FFP pixel gather — reused across draws so
    // filling it costs no allocation (see packFfpHybridPixelState).
    private readonly ffpHybridParams: FfpUniformParams = makeFfpParams();
    private readonly ffpHybridBlock = new Float32Array(FFP_UNIFORM_FLOATS);
    private readonly ffpHybridStagePool: FfpUniformParams["stages"][number][] = [];

    constructor(private backend: WebGPUBackend) {
        this.backendExecutor = new D3D9BackendExecutor(backend);
    }

    /** Device loss — driven by the adapter that owns this renderer, not registered separately,
     *  so the two invalidate in one step and can never disagree about which device they are on. */
    onDeviceLost(): void {
        this.backendExecutor.dropDeviceResources();
        // Pipeline ids index the executor's (now empty) pipeline array.
        this.progPipelineCache.clear();
        this.samplerCache = undefined;
    }

    hasPendingWork(): boolean {
        return this.commandRecorder.hasWork();
    }

    /**
     * The FFP pixel state a vertex-shader draw with NO pixel shader still needs.
     *
     * A 2001-2004 D3D8 title routinely pairs a vertex shader with the fixed-function
     * pixel pipeline; `ps === null` then means "run the texture-stage cascade", not
     * "there is no fragment work". linkProgram defaults `ffpStageCount` to 1 and takes
     * no sampler/projection state, so a draw handed the bare `{vs, ps}` pair loses every
     * stage past the first and samples with default sampler state — geometry renders as
     * an untextured flat fill. These three read the same TSS the FFP executor reads, so
     * the two paths cannot disagree about how many stages are live.
     */
    private ffpStageCount(adapter: D3D8DeviceAdapter): number {
        const ts = adapter.textureStates;
        let count = 0;
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            if ((ts[stage * 32 + D3DTSS_COLOROP] | 0) === D3DTOP_DISABLE) break;
            count = stage + 1;
        }
        return count;
    }

    /** Per-stage sampler state for the hybrid cascade (stage 0's sampler is not the others'). */
    private ffpSamplerStates(adapter: D3D8DeviceAdapter, stageCount: number): Map<number, SamplerSpec> {
        const out = new Map<number, SamplerSpec>();
        for (let stage = 0; stage < stageCount; stage++) {
            out.set(stage, decodeD3d8TssSampler(adapter.textureStates, stage));
        }
        return out;
    }

    /** Bitmask of stages whose texture transform carries D3DTTFF_PROJECTED. */
    private projectedStageMask(adapter: D3D8DeviceAdapter, stageCount: number): number {
        const ts = adapter.textureStates;
        let mask = 0;
        for (let stage = 0; stage < stageCount; stage++) {
            if (((ts[stage * 32 + D3DTSS_TEXTURETRANSFORMFLAGS] | 0) & D3DTTFF_PROJECTED) !== 0) {
                mask |= 1 << stage;
            }
        }
        return mask;
    }

    private getRS(adapter: D3D8DeviceAdapter, state: number): number {
        return adapter.renderStates[state] ?? 0;
    }

    private getAlphaTest(adapter: D3D8DeviceAdapter): AlphaTest | null {
        if (this.getRS(adapter, D3DRENDERSTATE_ALPHATESTENABLE) === 0) return null;
        const func = this.getRS(adapter, D3DRENDERSTATE_ALPHAFUNC) || D3DCMP_ALWAYS;
        if (func === D3DCMP_ALWAYS) return null;
        return { func, ref: this.getRS(adapter, D3DRENDERSTATE_ALPHAREF) >>> 0 & 0xff };
    }

    private alphaTestKey(adapter: D3D8DeviceAdapter): string {
        const at = this.getAlphaTest(adapter);
        return at ? `a${at.func}.${at.ref}` : "a0";
    }

    private blendKey(adapter: D3D8DeviceAdapter): string {
        return computeBlendKey((s) => this.getRS(adapter, s));
    }

    private boundCubeMask(_adapter: D3D8DeviceAdapter): number {
        return 0; // D3D8 cube maps not wired for programmable bind yet
    }

    /**
     * Gather the fixed-function PIXEL state (texture-stage cascade + TEXTUREFACTOR) a hybrid
     * VS + NULL-PS draw needs, into `out` using packFfpUniforms' own layout (ffp-lighting.ts) —
     * the same function/offsets d3d9-device.ts's hybrid path and emitHybridFixedFunctionFragment
     * (shader/link/index.ts) already share, so this can never invent a second layout.
     *
     * Only the pixel half is meaningful here: stage ops/args/RESULTARG, per-stage
     * D3DTSS_CONSTANT and D3DRENDERSTATE_TEXTUREFACTOR. Everything else in the block (MVP,
     * world/view matrices, material, lights, fog, texgen, blend palette...) is left at
     * makeFfpParams()'s zeroed/identity defaults and is INERT here: the vertex stage on this
     * path is the game's own compiled vertex shader, which never reads psc.* — only the
     * fragment cascade emitted by emitHybridFixedFunctionFragment does, and it reads exactly
     * c[0]/tfactor/stages/stageConstants.
     */
    private packFfpHybridPixelState(
        adapter: D3D8DeviceAdapter,
        stageCount: number,
        out: Float32Array,
    ): void {
        const ts = adapter.textureStates;
        const p = this.ffpHybridParams;
        p.stages.length = 0;
        for (let s = 0; s < stageCount; s++) {
            const base = s * 32;
            const st = this.ffpHybridStagePool[s] ??= {
                colorOp: 0, colorArg1: 0, colorArg2: 0, colorArg0: 0,
                alphaOp: 0, alphaArg1: 0, alphaArg2: 0, alphaArg0: 0,
                resultArg: 0, texCoordIndex: 0, texTransformFlags: 0, constant: newFfpColor(),
            };
            st.colorOp = ts[base + D3DTSS_COLOROP] | 0;
            st.colorArg1 = ts[base + D3DTSS_COLORARG1] | 0;
            st.colorArg2 = ts[base + D3DTSS_COLORARG2] | 0;
            st.alphaOp = ts[base + D3DTSS_ALPHAOP] | 0;
            st.alphaArg1 = ts[base + D3DTSS_ALPHAARG1] | 0;
            st.alphaArg2 = ts[base + D3DTSS_ALPHAARG2] | 0;
            st.colorArg0 = ts[base + D3DTSS_COLORARG0] | 0;
            st.alphaArg0 = ts[base + D3DTSS_ALPHAARG0] | 0;
            st.resultArg = ts[base + D3DTSS_RESULTARG] | 0;
            st.texCoordIndex = ts[base + D3DTSS_TEXCOORDINDEX] | 0;
            st.texTransformFlags = ts[base + D3DTSS_TEXTURETRANSFORMFLAGS] | 0;
            unpackD3dColor(ts[base + D3DTSS_CONSTANT] >>> 0, st.constant!);
            p.stages.push(st);
        }
        p.tfactor = unpackD3dColor(this.getRS(adapter, D3DRENDERSTATE_TEXTUREFACTOR) >>> 0, p.tfactor);
        packFfpUniforms(out, p);

        // Alpha-less D3D formats read alpha as 1.0 on real hardware; our GPU copies carry a
        // live alpha channel that must be masked (stage.b.z — emitHybridFixedFunctionFragment).
        // packFfpUniforms cannot set this itself: it has no notion of a bound texture's format.
        for (let s = 0; s < stageCount; s++) {
            const tex = adapter.stageTexForDraw(s);
            const fmt = tex?.surfaceType === "bitmap_texture" ? tex.d3dFormat : undefined;
            if (fmt !== undefined && D3D_ALPHALESS_FORMATS.has(fmt)) {
                out[ffpStageOffset(s) + 4 + 2] = 1;
            }
        }
    }

    /**
     * Content hash of `len` PS uniform words, mirroring d3d9-device.ts's
     * copyConstantPrefixWithKey. The hybrid path has no SetPixelShaderConstant call to derive
     * a version from (it's driven by SetRenderState/SetTextureStageState instead), so the
     * cached-draw-state elision in render-frame.ts needs a real hash of the packed bytes —
     * a stage-state change between two otherwise-identical draws must not be cached away.
     */
    private hashPsConstants(bits: Uint32Array, len: number): number {
        let h1 = 0x811c9dc5;
        let h2 = (0x9e3779b9 ^ len) >>> 0;
        for (let i = 0; i < len; i++) {
            const w = bits[i]!;
            h1 = Math.imul(h1 ^ w, 0x01000193) >>> 0;
            h2 = (Math.imul(h2 ^ w, 0x85ebca6b) + 0x9e3779b9) >>> 0;
        }
        return ((h1 & 0x1fffff) * 0x100000000) + h2;
    }

    private ensureTextureSurface(
        renderer: DDrawWebGPUExecutor,
        surface: DirectDrawSurfaceState | null,
    ): GPUTextureView | null {
        if (!surface) return null;
        renderer.syncSurfaceFromMemory(surface);
        return surface.gpuTextureView ?? null;
    }

    /** Shader-module validation is asynchronous in WebGPU. Do not leave a rejected build in
     * the D3D8 pipeline cache: the next draw must retry after the diagnostic is visible. */
    private observeShaderCompilation(module: GPUShaderModule, cacheKey: string, site: string): void {
        const getCompilationInfo = module.getCompilationInfo;
        if (typeof getCompilationInfo !== "function") {
            this.progPipelineCache.delete(cacheKey);
            const detail = "GPUShaderModule.getCompilationInfo is unavailable; shader validity is unverified";
            recordGpuError("scope", site, detail);
            Logger.error(LogCategory.SYSTEM, `[D3D8] shader compilation could not be observed at ${site}: ${detail}`);
            return;
        }
        void getCompilationInfo.call(module).then((info) => {
            const errors = info.messages.filter((message) => message.type === "error");
            if (errors.length === 0) return;
            this.progPipelineCache.delete(cacheKey);
            const detail = errors.map((message) => message.message).join("; ");
            recordGpuError("scope", site, detail);
            Logger.error(LogCategory.SYSTEM, `[D3D8] shader compilation failed at ${site}: ${detail}`);
        }).catch((error) => {
            this.progPipelineCache.delete(cacheKey);
            recordGpuError("throw", site, String(error));
            Logger.error(LogCategory.SYSTEM, `[D3D8] shader compilation inspection failed at ${site}: ${error}`);
        });
    }

    private observePipelineValidation(device: GPUDevice, cacheKey: string, site: string): void {
        void device.popErrorScope().then((error) => {
            if (!error) return;
            this.progPipelineCache.delete(cacheKey);
            recordGpuError("scope", site, error.message);
            Logger.error(LogCategory.SYSTEM, `[D3D8] pipeline validation failed at ${site}: ${error.message}`);
        }).catch((error) => {
            this.progPipelineCache.delete(cacheKey);
            recordGpuError("throw", site, String(error));
            Logger.error(LogCategory.SYSTEM, `[D3D8] pipeline validation scope failed at ${site}: ${error}`);
        });
    }

    /** Per-stream effective strides for the active decl: SetStreamSource stride wins,
     *  else null → linkProgram falls back to the decl's computed stride for that stream.
     *  strideOverride (UP draws / caller-resolved stream-0 stride) applies to stream 0. */
    private effectiveStreamStrides(
        adapter: D3D8DeviceAdapter,
        decl: { stream: number }[],
        stride0: number | null,
    ): (number | null)[] {
        let maxStream = 0;
        for (const e of decl) if (e.stream > maxStream) maxStream = e.stream;
        const strides: (number | null)[] = [stride0];
        for (let s = 1; s <= maxStream; s++) {
            const src = adapter.streamSources[s];
            strides[s] = src.stride > 0 ? src.stride : null;
        }
        return strides;
    }

    resolveProgrammablePipeline(
        adapter: D3D8DeviceAdapter,
        shaders: D3D8ShaderRegistry,
        // WebGPU natively expresses D3DPT_LINESTRIP/TRIANGLESTRIP/POINTLIST as their matching
        // topology; only D3DPT_TRIANGLEFAN has no native equivalent and must be CPU-expanded
        // into a triangle-list index buffer by the caller before reaching here.
        topology: GPUPrimitiveTopology,
        forceCullNone: boolean,
        strideOverride?: number,
        // Required by WebGPU only for an INDEXED draw using a strip topology (must match the
        // index buffer's own format); irrelevant/unused for non-indexed draws and non-strip
        // topologies. Omitted callers get "uint16" — safe because it's ignored unless the
        // topology is a strip AND the draw is indexed, and every indexed strip call site here
        // passes its real format explicitly.
        indexFormat?: GPUIndexFormat,
    ): number {
        const vsObj = shaders.getActiveVs();
        if (!vsObj?.compiled) return -1;
        const psObj = shaders.getActivePs();
        const vs = vsObj.compiled;
        const ps = psObj?.compiled ?? null;
        const stream0 = adapter.streamSources[0];
        const stride = strideOverride ?? (stream0.stride > 0 ? stream0.stride : null);
        const streamStrides = this.effectiveStreamStrides(adapter, vsObj.decl, stride);
        // Single-stream keys stay identical to the pre-multi-stream format.
        const strideKey = streamStrides.length <= 1
            ? String(stride)
            : streamStrides.map(s => s ?? "null").join("|");
        const cubeMask = computeCubeMask(ps) | this.boundCubeMask(adapter);
        // No pixel shader ⇒ the fragment stage IS the fixed-function cascade, whose depth and
        // projection come from TSS. Both change the emitted WGSL, so they belong in the key —
        // otherwise a stage-count change silently reuses the pipeline built for the old one.
        const hybridStages = ps ? 0 : this.ffpStageCount(adapter);
        const projectedMask = hybridStages ? this.projectedStageMask(adapter, hybridStages) : 0;
        const hybridSamplers = hybridStages ? this.ffpSamplerStates(adapter, hybridStages) : null;
        const isStrip = topology === "triangle-strip" || topology === "line-strip";
        const cacheKey = buildD3D8PipelineKey(
            adapter.renderStates,
            shaders.activeVsHandle,
            shaders.activePsHandle,
            vsObj.declStride,
            strideKey,
            isStrip ? `${topology}:${indexFormat ?? "uint16"}` : topology,
            forceCullNone,
            this.blendKey(adapter),
            this.alphaTestKey(adapter),
            cubeMask,
            buildD3D8FfpVariantKey(hybridStages, projectedMask, hybridSamplers),
        );
        const cached = this.progPipelineCache.get(cacheKey);
        if (cached !== undefined) return cached;

        let pipelineId: number;
        try {
            const link = linkProgram({
                vs,
                ps,
                declElements: vsObj.decl,
                streamStride: stride,
                streamStrides,
                alphaTest: this.getAlphaTest(adapter),
                cubeMask,
                ffpStageCount: hybridStages || undefined,
                samplerStates: hybridSamplers ?? undefined,
                projectedStages: projectedMask,
            });
            if (link.interpolantBudgetExceeded) {
                throw new Error("D3D8 shader link exceeds WebGPU inter-stage interpolant budget");
            }
            const gpuDevice = this.backend.getDevice()!;
            const format = this.backend.getFormat()!;
            const module = gpuDevice.createShaderModule({ code: link.wgsl });
            this.observeShaderCompilation(module, cacheKey, `d3d8-programmable:${shaders.activeVsHandle}`);
            const { pipelineLayout } = this.backendExecutor.getProgrammableLayout(link.cubeMask);
            const depthFormat = adapter.renderer.getDepthFormat();

            const cullD3D = this.getRS(adapter, D3DRENDERSTATE_CULLMODE);
            let cullMode: GPUCullMode = "none";
            if (!forceCullNone) {
                if (cullD3D === D3DCULL_CW) cullMode = "front";
                else if (cullD3D === D3DCULL_CCW) cullMode = "back";
            }
            const zEnable = this.getRS(adapter, D3DRENDERSTATE_ZENABLE) !== 0 ? 1 : 0;
            const zWrite = this.getRS(adapter, D3DRENDERSTATE_ZWRITEENABLE) !== 0 ? 1 : 0;

            gpuDevice.pushErrorScope("validation");
            let pipeline: GPURenderPipeline;
            try {
                pipeline = gpuDevice.createRenderPipeline({
                    layout: pipelineLayout,
                    vertex: {
                        module,
                        entryPoint: "vs_main",
                        // One layout per used stream, slot = stream number (null holes kept).
                        buffers: link.vertexBuffers,
                    },
                    fragment: {
                        module,
                        entryPoint: "fs_main",
                        targets: [buildColorTargetState(format, (s) => this.getRS(adapter, s))],
                    },
                    primitive: {
                        topology,
                        frontFace: "cw",
                        cullMode,
                        // WebGPU requires stripIndexFormat for strip topologies used with an
                        // indexed draw, and it must match the actual index buffer format.
                        ...(isStrip ? { stripIndexFormat: indexFormat ?? "uint16" } : {}),
                    },
                    depthStencil: {
                        format: depthFormat,
                        depthWriteEnabled: zWrite !== 0,
                        depthCompare: zEnable !== 0 ? "less-equal" : "always",
                    },
                });
            } catch (error) {
                this.observePipelineValidation(gpuDevice, cacheKey, `d3d8-programmable-pipeline:${shaders.activeVsHandle}`);
                throw error;
            }
            this.observePipelineValidation(gpuDevice, cacheKey, `d3d8-programmable-pipeline:${shaders.activeVsHandle}`);
            // Per-slot strides from the SAME layouts the pipeline was built with: the executor's
            // vertex-range guard sizes a non-indexed draw by them, and an empty array disables it.
            pipelineId = this.backendExecutor.registerPipeline(pipeline, link.hasTexture, true, 1,
                link.vertexBuffers.map(b => b?.arrayStride ?? 0));
        } catch (e) {
            this.progPipelineCache.delete(cacheKey);
            recordGpuError("throw", `d3d8-programmable-build:${shaders.activeVsHandle}`, String(e));
            Logger.error(LogCategory.SYSTEM, `[D3D8] programmable pipeline build failed: ${e}`);
            pipelineId = -1;
        }
        if (pipelineId >= 0) {
            this.progPipelineCache.set(cacheKey, pipelineId);
        }
        return pipelineId;
    }

    captureDrawState(
        adapter: D3D8DeviceAdapter,
        shaders: D3D8ShaderRegistry,
        renderer: DDrawWebGPUExecutor,
    ): number {
        const vsObj = shaders.getActiveVs();
        const psObj = shaders.getActivePs();
        const vs = vsObj?.compiled ?? null;
        const ps = psObj?.compiled ?? null;
        const vsConstantLen = Math.min(vs ? vs.analysis.constantCount : 0, 256) * 4;
        const vsLen = vsConstantLen + 4; // hidden c[] pixel-centre tail
        // A bound VS with NO pixel shader still needs the fixed-function texture-stage
        // cascade's state (see packFfpHybridPixelState / resolveProgrammablePipeline's
        // hybridStages) — same PS-uniform-binding repurposing as d3d9-device.ts's hybrid path:
        // c[0] (debug selector) + tfactor + FFP_MAX_STAGES stage records + their constants.
        const hybridStages = ps ? 0 : this.ffpStageCount(adapter);
        const psLen = ps
            ? Math.min(ps.analysis.constantCount, 224) * 4
            : 4 + 4 + FFP_MAX_STAGES * 8 + FFP_STAGE_CONSTANT_FLOATS;

        const frame = this.commandRecorder.getCurrentFrame();
        const index = frame.drawStateCount;
        const state = frame.nextDrawState(vsLen, psLen);

        state.vsConst.set(shaders.vsConstants.subarray(0, vsConstantLen));
        const { dx, dy } = pixelCenterClipOffset(adapter.viewport.width, adapter.viewport.height);
        state.vsConst[vsConstantLen + 0] = dx;
        state.vsConst[vsConstantLen + 1] = dy;
        state.vsConst[vsConstantLen + 2] = 0;
        state.vsConst[vsConstantLen + 3] = 0;
        state.vsVersion = withPixelCenterVersion(shaders.vsConstantsVersion, dx, dy);
        if (ps) {
            state.psConst.set(shaders.psConstants.subarray(0, psLen));
            state.psVersion = shaders.psConstantsVersion;
        } else {
            this.packFfpHybridPixelState(adapter, hybridStages, this.ffpHybridBlock);
            state.psConst.fill(0, 0, psLen);
            // c[0] (state.psConst[0..3]) is a harness-only debug selector and stays zero here
            // (see emitHybridFixedFunctionFragment); [4..7] is TEXTUREFACTOR, immediately
            // before ffpStageOffset(0) in packFfpUniforms' layout.
            state.psConst.set(this.ffpHybridBlock.subarray(ffpStageOffset(0) - 4, ffpStageOffset(0)), 4);
            state.psConst.set(
                this.ffpHybridBlock.subarray(ffpStageOffset(0), ffpStageOffset(0) + FFP_MAX_STAGES * 8),
                8,
            );
            state.psConst.set(
                this.ffpHybridBlock.subarray(
                    ffpStageConstantOffset(0), ffpStageConstantOffset(0) + FFP_STAGE_CONSTANT_FLOATS,
                ),
                8 + FFP_MAX_STAGES * 8,
            );
            state.psVersion = this.hashPsConstants(state.psBits, psLen);
        }

        const cubeMask = computeCubeMask(ps) | this.boundCubeMask(adapter);
        state.cubeMask = cubeMask;

        const device = this.backend.getDevice();
        if (device && !this.samplerCache) this.samplerCache = new DxSamplerCache(device);

        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            // stageTexForDraw drops a texture that IS the active render target
            // (WebGPU forbids sampling the pass's own color attachment).
            state.textures[stage] = this.ensureTextureSurface(renderer, adapter.stageTexForDraw(stage));
        }
        // Per-stage sampler decode, mirroring d3d9-device.ts's resolveStageSampler: state.sampler
        // is the PROG_BIND.SAMPLER fallback binding (stage 0), state.samplers[] is what the
        // per-texture bind-group entries actually use (see acquireProgBindGroup).
        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            state.samplers[stage] = this.samplerCache?.tryAcquire(
                decodeD3d8TssSampler(adapter.textureStates, stage),
            ) ?? null;
        }
        state.sampler = state.samplers[0];
        return index;
    }

    flush(adapter: D3D8DeviceAdapter): void {
        if (!this.commandRecorder.hasWork()) return;

        const frame = this.commandRecorder.finalize();
        const rt = adapter.activeRenderTarget;
        const renderer = adapter.renderer;

        const depthStencil = renderer.createDepthStencilForProgrammable(rt);
        if (!depthStencil) {
            Logger.warn(LogCategory.SYSTEM, "[D3D8] programmable flush: no depth attachment for RT");
            return;
        }

        const colorView = rt.gpuTextureView;
        if (!colorView) return;

        const uniforms: UniformData = {
            viewportWidth: rt.width,
            viewportHeight: rt.height,
            mvp: adapter.getMVP() ?? new Float32Array(16),
        };

        this.backendExecutor.execute(frame, uniforms, null, false, {}, {
            colorViews: [colorView],
            depthStencil,
        });
    }

    getCommandRecorder(): D3D9CommandRecorder {
        return this.commandRecorder;
    }

    getBackendExecutor(): D3D9BackendExecutor {
        return this.backendExecutor;
    }

    invalidatePipelineCache(): void {
        this.progPipelineCache.clear();
    }

    /**
     * Retire a deleted shader handle's pipelines from the cache. Handles are never reused
     * (monotonic allocHandle), so this is memory hygiene only — a stale entry could never be
     * looked up again. Key format: `${vsHandle}:${psHandle}:...` (see buildD3D8PipelineKey).
     */
    purgeShaderPipelines(vsHandle: number | null, psHandle: number | null): void {
        for (const key of this.progPipelineCache.keys()) {
            const sep1 = key.indexOf(":");
            const sep2 = key.indexOf(":", sep1 + 1);
            if (vsHandle !== null && Number(key.slice(0, sep1)) === vsHandle) {
                this.progPipelineCache.delete(key);
            } else if (psHandle !== null && Number(key.slice(sep1 + 1, sep2)) === psHandle) {
                this.progPipelineCache.delete(key);
            }
        }
    }
}
