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
    D3DRENDERSTATE_ZENABLE,
    D3DRENDERSTATE_ZWRITEENABLE,
} from "../../../modules/ddraw/constants";
import { Logger, LogCategory } from "../../../core/logger";
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
import { DxSamplerCache } from "../shared/dx-sampler";
import { decodeD3d8TssSampler } from "./d3d8-sampler";
import { buildD3D8PipelineKey, D3D8ShaderRegistry } from "./d3d8-shader-registry";
import type { D3D8DeviceAdapter } from "./d3d8-device-adapter";
import type { DDrawWebGPUExecutor } from "../ddraw/ddraw-backend-executor";

export class D3D8ProgrammableRenderer {
    private commandRecorder = new D3D9CommandRecorder(new RenderFramePool(2));
    private backendExecutor: D3D9BackendExecutor;
    private progPipelineCache = new Map<string, number>();
    private samplerCache?: DxSamplerCache;

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

    private ensureTextureSurface(
        renderer: DDrawWebGPUExecutor,
        surface: DirectDrawSurfaceState | null,
    ): GPUTextureView | null {
        if (!surface) return null;
        renderer.syncSurfaceFromMemory(surface);
        return surface.gpuTextureView ?? null;
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
        topology: "triangle-list" | "line-list",
        forceCullNone: boolean,
        strideOverride?: number,
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
        const cacheKey = buildD3D8PipelineKey(
            adapter.renderStates,
            shaders.activeVsHandle,
            shaders.activePsHandle,
            vsObj.declStride,
            strideKey,
            topology,
            forceCullNone,
            this.blendKey(adapter),
            this.alphaTestKey(adapter),
            cubeMask,
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
            });
            const gpuDevice = this.backend.getDevice()!;
            const format = this.backend.getFormat()!;
            const module = gpuDevice.createShaderModule({ code: link.wgsl });
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

            const pipeline = gpuDevice.createRenderPipeline({
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
                primitive: { topology, frontFace: "cw", cullMode },
                depthStencil: {
                    format: depthFormat,
                    depthWriteEnabled: zWrite !== 0,
                    depthCompare: zEnable !== 0 ? "less-equal" : "always",
                },
            });
            pipelineId = this.backendExecutor.registerPipeline(pipeline, link.hasTexture, true);
        } catch (e) {
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
        const vsLen = Math.min(vs ? vs.analysis.constantCount : 0, 256) * 4;
        const psLen = Math.min(ps ? ps.analysis.constantCount : 0, 224) * 4;

        const frame = this.commandRecorder.getCurrentFrame();
        const index = frame.drawStateCount;
        const state = frame.nextDrawState(vsLen, psLen);

        state.vsConst.set(shaders.vsConstants.subarray(0, vsLen));
        state.psConst.set(shaders.psConstants.subarray(0, psLen));
        state.vsVersion = shaders.vsConstantsVersion;
        state.psVersion = shaders.psConstantsVersion;

        const cubeMask = computeCubeMask(ps) | this.boundCubeMask(adapter);
        state.cubeMask = cubeMask;

        const device = this.backend.getDevice();
        if (device && !this.samplerCache) this.samplerCache = new DxSamplerCache(device);

        for (let stage = 0; stage < PROG_BIND.MAX_TEX; stage++) {
            // stageTexForDraw drops a texture that IS the active render target
            // (WebGPU forbids sampling the pass's own color attachment).
            state.textures[stage] = this.ensureTextureSurface(renderer, adapter.stageTexForDraw(stage));
        }
        // Programmable layout has one shared sampler binding — same parity debt as D3D9 (stage 0 TSS).
        state.sampler = this.samplerCache?.acquire(
            decodeD3d8TssSampler(adapter.textureStates, 0),
        ) ?? null;
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
            colorView,
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
