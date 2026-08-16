/**
 * D3D8 Device Adapter — holds D3D8 state, delegates rendering to FFPRenderer.
 *
 * This is NOT a copy of the renderer. It's a ~300 line adapter that:
 * 1. Holds D3D8 state (render states, TSS, transforms, bound textures, viewport)
 * 2. On draw calls, resolves state into FFPRenderer parameters and calls through
 */

import { DDrawWebGPUExecutor } from '../ddraw/ddraw-backend-executor';
import type { DirectDrawSurfaceState, RenderSurface, BitmapTextureSurface } from '../../../modules/ddraw/com-objects';
import { surfaceSyncManager } from '../../../modules/ddraw/surface-sync';
import type { Viewport } from '../ddraw/types';
import { sanitizeViewport } from '../ddraw/types';
import { recordGpuError } from '../../../core/gpu-error-log';
import { registerGpuDeviceObserver } from '../../../core/gpu/gpu-device-lifecycle';
import { registerDDrawSurfaceSource } from '../../../modules/ddraw/surface-device-loss';
import type { RenderActive } from '../../../runtime/runtime-services';
import { createRenderTarget } from '../shared/surface-factory';
import { decodeD3DTextureToRgba8, getD3DTextureLayout, D3DFMT_P8, D3DFMT_A8P8 } from '../shared/texture-formats';
import { TexturePaletteStore } from '../shared/texture-palette-store';
import { D3DTEXF_NONE, D3DTEXF_POINT } from './d3d8-sampler';
import { Logger, LogCategory } from '../../../core/logger';
import * as frameCapture from '../../../modules/ddraw/frame-capture';
import { System } from '../../../core/system';
import { framePacer, decodeD3DPresentInterval, PRESENT_INTERVAL_ONE } from '../../../core/frame-pacer';
import { frameProfiler } from '../../../core/frame-profiler';
import { profiler } from '../../../core/profiler';
import { statsOverlay } from '../../../core/stats-overlay';
import { WebGPUBackend } from '../webgpu-backend';
import { EmulatorConfig } from '../../../core/emulator-config-manager';
import { getOverlayCompositePlan } from '../../../modules/user32/dialog-overlay';
import {
    D3DRENDERSTATE_ALPHABLENDENABLE,
    D3DRENDERSTATE_ALPHAFUNC,
    D3DRENDERSTATE_ALPHAREF,
    D3DRENDERSTATE_ALPHATESTENABLE,
    D3DRENDERSTATE_AMBIENT,
    D3DRENDERSTATE_COLORKEYENABLE,
    D3DRENDERSTATE_CULLMODE,
    D3DRENDERSTATE_DESTBLEND,
    D3DRENDERSTATE_DITHERENABLE,
    D3DRENDERSTATE_FILLMODE,
    D3DRENDERSTATE_FOGENABLE,
    D3DRENDERSTATE_FOGTABLEMODE,
    D3DRENDERSTATE_FOGVERTEXMODE,
    D3DRENDERSTATE_FOGSTART,
    D3DRENDERSTATE_FOGEND,
    D3DRENDERSTATE_FOGDENSITY,
    D3DRENDERSTATE_LIGHTING,
    D3DRENDERSTATE_POINTSIZE,
    D3DRENDERSTATE_POINTSIZE_MIN,
    D3DRENDERSTATE_POINTSIZE_MAX,
    D3DRENDERSTATE_SHADEMODE,
    D3DRENDERSTATE_SPECULARENABLE,
    D3DRENDERSTATE_SRCBLEND,
    D3DRENDERSTATE_TEXTUREFACTOR,
    D3DRENDERSTATE_ZENABLE,
    D3DRENDERSTATE_ZFUNC,
    D3DRENDERSTATE_ZWRITEENABLE,
    D3DRENDERSTATE_DIFFUSEMATERIALSOURCE,
    D3DRENDERSTATE_AMBIENTMATERIALSOURCE,
    D3DRENDERSTATE_SPECULARMATERIALSOURCE,
    D3DRENDERSTATE_EMISSIVEMATERIALSOURCE,
    D3DRENDERSTATE_COLORVERTEX,
    D3DRENDERSTATE_LOCALVIEWER,
    D3DTADDRESS_WRAP,
    D3DTA_DIFFUSE,
    D3DTA_TEXTURE,
    D3DBLEND_ONE,
    D3DBLEND_ZERO,
    D3DCMP_ALWAYS,
    D3DCMP_LESSEQUAL,
    D3DCULL_CCW,
    D3DFILL_SOLID,
    D3DFOG_NONE,
    D3DSHADE_GOURAUD,
    D3DTOP_DISABLE,
    D3DTOP_MODULATE,
    D3DTOP_SELECTARG1,
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTSS_ALPHAARG1,
    D3DTSS_ALPHAARG2,
    D3DTSS_ALPHAOP,
    D3DTSS_COLORARG1,
    D3DTSS_COLORARG2,
    D3DTSS_COLOROP,
    D3DTSS_MAGFILTER,
    D3DTSS_MIPFILTER,
    D3DTSS_MINFILTER,
    D3DTSS_TEXCOORDINDEX,
    D3DTSS_TEXTURETRANSFORMFLAGS,
    D3DZB_FALSE,
    D3DZB_TRUE,
    D3DRENDERSTATE_VERTEXBLEND,
    D3DRENDERSTATE_INDEXEDVERTEXBLENDENABLE,
    D3DVBF_1WEIGHTS,
    D3DVBF_2WEIGHTS,
    D3DVBF_3WEIGHTS,
    D3DFVF_POSITION_MASK,
    D3DFVF_XYZB1,
    D3DFVF_XYZB2,
    D3DFVF_XYZB3,
    D3DFVF_XYZB4,
    D3DFVF_XYZB5,
    D3DFVF_LASTBETA_UBYTE4,
    D3DVBF_0WEIGHTS,
    D3DMULTISAMPLE_2_SAMPLES,
    D3DMULTISAMPLE_4_SAMPLES,
} from '../../../modules/ddraw/constants';
import { FFPLightingSource, FFPLightingState } from '../../../modules/ddraw/d3d/ffp-lighting';
import { D3DMaterial7Data, D3DLight7Data, createDefaultMaterial } from '../../../modules/ddraw/d3d/types';
import { RGBA } from '../ddraw/types';
import { computeFvfStride } from '../ddraw/compute/vertex-converter';
import type { VertexBlendInput } from '../ddraw/compute/vertex-converter';
import { MAX_FFP_SAMPLED_STAGES } from '../ddraw/ffp-stages';
import { D3D8ShaderRegistry, D3D8VsObject } from './d3d8-shader-registry';
import { D3D8ProgrammableRenderer } from './d3d8-programmable-draw';
import { KeyedStateBlockRecorder } from '../shared/state-block-recorder';
import type { D3D8StateBlockEntry } from './d3d8-state-block';
import {
    D3DSBT_ALL,
    D3DSBT_PIXELSTATE,
    D3DSBT_VERTEXSTATE,
    applyD3D8StateBlockEntries,
    captureD3D8StateToEntries,
    d3d8EntryKey,
    refreshD3D8CapturedEntries,
} from './d3d8-state-block';
import { declToSyntheticFvf, DeclStreamCopy } from './decl-to-ffp';
import { collectExtraStreamBindings, type StreamVertexBinding } from '../shared/vertex-streams';

// D3D transform types
const D3DTS_VIEW       = 2;
const D3DTS_PROJECTION = 3;
const D3DTS_WORLD      = 256; // 0x100
const D3DTS_TEXTURE0   = 16;  // D3DTS_TEXTURE0..7 = 16..23

export class D3D8DeviceAdapter implements RenderActive, FFPLightingSource {
    readonly suppressGdiOverlay = true;
    // State arrays — passed to FFPRenderer per draw call
    readonly renderStates = new Int32Array(256);
    readonly textureStates = new Int32Array(256); // 8 stages × 32 TSS types

    // Transforms
    private transforms = new Map<number, Float32Array>();
    private mvpDirty = true;
    private cachedMVP: Float32Array | null = null;

    // Viewport
    viewport: Viewport;

    // FVF (set via D3D8 SetVertexShader when the token is an FVF, not a shader handle)
    fvf = 0;
    private activeVertexShaderHandle = 0;
    private warnedShaderFallbacks = new Set<number>();

    // Stream sources — D3D8 supports up to 16 streams (caps.MaxStreams); index = stream number.
    // vb = VB COM pointer (resource lookup key), stride from SetStreamSource (D3D8 has no offset).
    readonly streamSources: { vb: number; stride: number }[] =
        Array.from({ length: 16 }, () => ({ vb: 0, stride: 0 }));

    // Index buffer
    indexIB: number = 0;     // IB COM pointer
    baseVertexIndex = 0;

    // Palettes for D3D8 palettized (P8/A8P8) textures — shared store with D3D9.
    readonly texturePalettes = new TexturePaletteStore();

    // Bound textures (up to 8 stages)
    readonly textures: (DirectDrawSurfaceState | null)[] = [null, null, null, null, null, null, null, null];
    /** COM ptr per stage — IDirect3DDevice8::GetTexture returns these with AddRef. */
    readonly textureHandles: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

    // Pixel shader handle mirrored from shader registry for GetPixelShader
    private pixelShaderHandle = 0;

    // Shader registry + programmable renderer
    readonly shaders = new D3D8ShaderRegistry();
    private programmable: D3D8ProgrammableRenderer | null = null;
    private vbGpuBuffers = new Map<number, GPUBuffer>();
    private ibGpuBuffers = new Map<number, GPUBuffer>();
    private syntheticDeclFvf = 0;
    private syntheticDeclStride = 0;
    /** Multi-stream decl-only shaders: copy plan into the canonical FVF layout
     *  (the FFP renderer consumes one interleaved stream). Null = single-stream. */
    private declInterleave: DeclStreamCopy[] | null = null;
    /** Per-stream decl strides — SetStreamSource(stride=0) fallback for the interleave. */
    private declStreamStrides: number[] = [];
    /** Reusable interleave scratch (vertices + appended index range). */
    private declScratch = new Uint8Array(0);

    // Bound depth-stencil surface COM ptr (0 = none)
    depthStencilSurfacePtr = 0;

    // Swap-chain back buffer — Present always composites THIS surface.
    renderTarget: RenderSurface;
    // Explicit SetRenderTarget override (offscreen RT); null = back buffer.
    private rtOverride: RenderSurface | null = null;

    // Profiling
    private prevPresentTime: number = 0;
    private presentCount: number = 0;

    // Debug GPU panel frame snapshot (same shape as the D3D9 device's).
    private frameIdCounter = 0;
    private readonly frameSnapshot: {
        frameId: number;
        drawCalls: number;
        presents: number;
        lastPresent?: { surfaceAddr: number; width: number; height: number; format: string; timestamp: number };
        lastDraw?: { api: "d3d8"; primitiveType: number; numVerts: number; numIndices?: number; timestamp: number };
    } = { frameId: 0, drawCalls: 0, presents: 0 };

    // Resource stores (COM ptr → data)
    readonly vbData = new Map<number, { guestPtr: number; size: number; fvf: number; usage: number; pool: number }>();
    readonly ibData = new Map<number, { guestPtr: number; size: number; format: number; usage: number; pool: number }>();
    readonly texSurfaces = new Map<number, DirectDrawSurfaceState>();
    
    // Lighting state
    private material: D3DMaterial7Data = createDefaultMaterial();
    private lights = new Map<number, D3DLight7Data>();
    private lightsEnabled = new Set<number>();

    constructor(
        readonly renderer: DDrawWebGPUExecutor,
        width: number,
        height: number,
        backend?: WebGPUBackend,
    ) {
        this.renderTarget = createRenderTarget(width, height);
        this.viewport = { x: 0, y: 0, width, height };
        this.initDefaultStates();
        if (backend) {
            this.programmable = new D3D8ProgrammableRenderer(backend);
        }
        // The two buffer maps are the only device-derived state this adapter owns directly;
        // both are refilled from guest memory by uploadVb/uploadIb on the next draw.
        registerGpuDeviceObserver("d3d8-adapter", {
            onDeviceLost: () => {
                this.vbGpuBuffers.clear();
                this.ibGpuBuffers.clear();
                this.programmable?.onDeviceLost();
            },
        });
        // A D3D8 texture's surface state is NOT a ddraw COM object, so the COM walk never sees
        // it — this device's own texture map and its render target are the only route to them.
        registerDDrawSurfaceSource(`d3d8-device-${D3D8DeviceAdapter.nextSourceId++}`, () => this.ownedSurfaces());
    }

    private static nextSourceId = 0;

    private *ownedSurfaces(): Iterable<{ state: DirectDrawSurfaceState }> {
        yield { state: this.renderTarget };
        if (this.rtOverride) yield { state: this.rtOverride };
        for (const surf of this.texSurfaces.values()) yield { state: surf };
    }

    /** Surface all draws/clears target right now (SetRenderTarget override or back buffer). */
    get activeRenderTarget(): RenderSurface {
        return this.rtOverride ?? this.renderTarget;
    }

    /**
     * Retarget rendering (IDirect3DDevice8::SetRenderTarget). null restores the back
     * buffer. Pending programmable draws are flushed first so they land in the OLD
     * target. Real D3D8 resets the viewport to cover the whole new target.
     */
    setRenderTargetOverride(surface: RenderSurface | null): void {
        const next = surface ?? null;
        if (next !== this.rtOverride) {
            this.flushProgrammablePending();
            this.rtOverride = next;
        }
        // Real D3D8 resets the viewport on EVERY SetRenderTarget — including
        // re-setting the current target (apps rely on it to restore a full viewport).
        const rt = this.activeRenderTarget;
        this.viewport = { x: 0, y: 0, width: rt.width, height: rt.height, minZ: 0, maxZ: 1 };
    }

    /**
     * Stage texture for a draw, dropping a self-reference: WebGPU forbids sampling
     * the texture the render pass is writing (same guard as the D3D9 backend).
     */
    stageTexForDraw(stage: number): DirectDrawSurfaceState | null {
        const t = this.textures[stage];
        return t && t === this.rtOverride ? null : t;
    }

    // Reusable per-draw stage-texture array for the executor (index = stage; index 0
    // unused — stage 0 rides its own parameter).
    private readonly stageTexturesScratch: (DirectDrawSurfaceState | null)[] =
        new Array(MAX_FFP_SAMPLED_STAGES).fill(null);

    /** Textures for stages 1..MAX_FFP_SAMPLED_STAGES-1, with the self-sampling guard applied. */
    stageTexturesForDraw(): (DirectDrawSurfaceState | null)[] {
        for (let s = 1; s < MAX_FFP_SAMPLED_STAGES; s++) {
            this.stageTexturesScratch[s] = this.stageTexForDraw(s);
        }
        return this.stageTexturesScratch;
    }

    /** Guest RAM, re-derived per use — a stored view detaches on WASM growth and the
     *  adapter outlives any number of growths. */
    private getMemoryView(): Uint8Array {
        return System.getInstance().process!.getCurrentMemory();
    }

    setStreamSource(streamNumber: number, vbPtr: number, stride: number): void {
        // Recording lives in the device layer so the Tier-0 WBUF drain path (which bypasses
        // the thunk/FastPath) journals correctly during BeginStateBlock — same model as D3D9.
        // The thunk/FastPath recording branches short-circuit before this, so no double-record.
        if (this.recordingStateBlock) { this.recordStateBlock({ op: 'streamSource', stream: streamNumber, vb: vbPtr >>> 0, stride: stride >>> 0 }); return; }
        const src = this.streamSources[streamNumber];
        if (!src) return;
        src.vb = vbPtr >>> 0;
        src.stride = stride >>> 0;
    }

    /** SetIndices(pIB, BaseVertexIndex) — D3D8 folds BaseVertexIndex into the IB binding. */
    setIndices(ibPtr: number, baseVertex: number): void {
        if (this.recordingStateBlock) { this.recordStateBlock({ op: 'indices', ib: ibPtr >>> 0, baseVertex: baseVertex | 0 }); return; }
        this.indexIB = ibPtr >>> 0;
        this.baseVertexIndex = baseVertex | 0;
    }

    getStreamSource(streamNumber: number): { vb: number; stride: number } {
        return this.streamSources[streamNumber] ?? { vb: 0, stride: 0 };
    }

    private getSourceStride(activeFvf: number): number {
        if (this.streamSources[0].stride > 0) {
            return this.streamSources[0].stride;
        }
        try {
            return computeFvfStride(activeFvf);
        } catch {
            return 0;
        }
    }

    getActiveVertexToken(): number {
        return this.shaders.activeVsHandle !== 0
            ? this.shaders.activeVsHandle
            : this.fvf;
    }

    isProgrammable(): boolean {
        return this.shaders.isProgrammable();
    }

    isDeclOnly(): boolean {
        return this.shaders.isDeclOnly();
    }

    flushProgrammablePending(): void {
        if (!this.programmable || !this.programmable.hasPendingWork()) return;
        // GUEST-ORDER SUBMIT: FFP draws accumulate in the ddraw executor's currentEncoder
        // (submitted LATE at flush()/present), while the programmable batch runs through
        // D3D9BackendExecutor.execute() which creates its OWN encoder and submits it
        // IMMEDIATELY. Without submitting the FFP-so-far first, the LATE FFP world pass
        // lands on the GPU AFTER the already-submitted programmable meshes and overpaints
        // them (and, sharing the depth buffer, corrupts occlusion). Ending + submitting the
        // FFP encoder here makes both paths hit the GPU timeline in the guest's interleaved
        // order. flush() submits without rotating the ring / ending the frame; the shared
        // depthManager's needsClear flag guarantees the depth clear still happens exactly
        // once per frame regardless of which path opens the frame's first pass (FFP resuming
        // after a programmable batch opens a new pass with depthLoadOp="load").
        // A/B kill-switch (globalThis.__d3d8NoOrderFix, default off): skip the pre-flush to
        // reproduce the LATE-FFP-overpaints-programmable ordering bug for regression/diagnosis.
        if (!(globalThis as { __d3d8NoOrderFix?: boolean }).__d3d8NoOrderFix) {
            this.renderer.flush();
        }
        this.programmable.flush(this);
    }

    private getGpuDevice(): GPUDevice | null {
        const backend = System.getInstance().services.render.getBackend();
        if (backend?.kind === "webgpu") {
            return (backend as WebGPUBackend).getDevice() ?? null;
        }
        return null;
    }

    private ensureVbGpuBuffer(vbPtr: number, size: number): GPUBuffer | null {
        const device = this.getGpuDevice();
        if (!device) return null;
        let buf = this.vbGpuBuffers.get(vbPtr);
        if (!buf || size > ((buf as GPUBuffer & { __size?: number }).__size ?? 0)) {
            buf?.destroy();
            buf = device.createBuffer({
                size: Math.max(16, size),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            (buf as GPUBuffer & { __size?: number }).__size = size;
            this.vbGpuBuffers.set(vbPtr, buf);
        }
        return buf;
    }

    private ensureIbGpuBuffer(ibPtr: number, size: number): GPUBuffer | null {
        const device = this.getGpuDevice();
        if (!device) return null;
        let buf = this.ibGpuBuffers.get(ibPtr);
        if (!buf || size > ((buf as GPUBuffer & { __size?: number }).__size ?? 0)) {
            buf?.destroy();
            buf = device.createBuffer({
                size: Math.max(16, size),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            (buf as GPUBuffer & { __size?: number }).__size = size;
            this.ibGpuBuffers.set(ibPtr, buf);
        }
        return buf;
    }

    private uploadVb(vbPtr: number, guestPtr: number, size: number, mem: Uint8Array): GPUBuffer | null {
        const buf = this.ensureVbGpuBuffer(vbPtr, size);
        if (!buf) return null;
        const device = this.getGpuDevice();
        device?.queue.writeBuffer(buf, 0, mem.buffer, mem.byteOffset + guestPtr, size);
        return buf;
    }

    private uploadIb(ibPtr: number, guestPtr: number, size: number, mem: Uint8Array): GPUBuffer | null {
        const buf = this.ensureIbGpuBuffer(ibPtr, size);
        if (!buf) return null;
        const device = this.getGpuDevice();
        device?.queue.writeBuffer(buf, 0, mem.buffer, mem.byteOffset + guestPtr, size);
        return buf;
    }

    private resolveDrawFVF(vbFvf: number): number {
        if (this.shaders.isDeclOnly()) {
            return this.syntheticDeclFvf || vbFvf;
        }
        if (this.shaders.isProgrammable()) {
            const vs = this.shaders.getActiveVs();
            if (vs && vs.declStride > 0) {
                return vbFvf || this.fvf;
            }
        }
        if (this.activeVertexShaderHandle !== 0 && vbFvf !== 0) {
            if (!this.warnedShaderFallbacks.has(this.activeVertexShaderHandle)) {
                this.warnedShaderFallbacks.add(this.activeVertexShaderHandle);
                Logger.warn(
                    LogCategory.SYSTEM,
                    `D3D8: vertex shader handle 0x${this.activeVertexShaderHandle.toString(16)}; falling back to VB FVF=0x${vbFvf.toString(16)}`
                );
            }
            return vbFvf;
        }
        return this.fvf;
    }

    private resolveDrawStride(activeFvf: number): number {
        if (this.shaders.isDeclOnly() && this.syntheticDeclStride > 0) {
            return this.syntheticDeclStride;
        }
        return this.getSourceStride(activeFvf);
    }

    private updateDeclOnlyMapping(): void {
        const vs = this.shaders.getActiveVs();
        if (!vs || vs.compiled !== null) {
            this.syntheticDeclFvf = 0;
            this.syntheticDeclStride = 0;
            this.declInterleave = null;
            this.declStreamStrides = [];
            return;
        }
        const mapped = declToSyntheticFvf(vs.decl, vs.declStride);
        this.syntheticDeclFvf = mapped.fvf;
        this.syntheticDeclStride = mapped.stride;
        this.declInterleave = mapped.interleave ?? null;
        this.declStreamStrides = vs.streamStrides;
        if (!mapped.faithful) {
            Logger.warn(LogCategory.SYSTEM, "D3D8: decl-only layout may not map faithfully to FVF");
        }
    }

    private initDefaultStates(): void {
        // Keep D3D8 defaults aligned with DX7 executor defaults.
        // The renderer consumes a single shared render-state namespace, so mismatched
        // indices here can silently turn on invalid states (e.g. ZFUNC=NEVER).
        this.renderStates[D3DRENDERSTATE_ZENABLE] = D3DZB_TRUE;
        this.renderStates[D3DRENDERSTATE_ZWRITEENABLE] = 1;
        this.renderStates[D3DRENDERSTATE_ZFUNC] = D3DCMP_LESSEQUAL;
        this.renderStates[D3DRENDERSTATE_FILLMODE] = D3DFILL_SOLID;
        this.renderStates[D3DRENDERSTATE_SHADEMODE] = D3DSHADE_GOURAUD;
        this.renderStates[D3DRENDERSTATE_ALPHATESTENABLE] = 0;
        this.renderStates[D3DRENDERSTATE_ALPHAREF] = 0;
        this.renderStates[D3DRENDERSTATE_ALPHAFUNC] = D3DCMP_ALWAYS;
        this.renderStates[D3DRENDERSTATE_ALPHABLENDENABLE] = 0;
        this.renderStates[D3DRENDERSTATE_SRCBLEND] = D3DBLEND_ONE;
        this.renderStates[D3DRENDERSTATE_DESTBLEND] = D3DBLEND_ZERO;
        this.renderStates[D3DRENDERSTATE_CULLMODE] = D3DCULL_CCW;
        this.renderStates[D3DRENDERSTATE_DITHERENABLE] = 0;
        this.renderStates[D3DRENDERSTATE_FOGENABLE] = 0;
        this.renderStates[D3DRENDERSTATE_FOGTABLEMODE] = D3DFOG_NONE;
        this.renderStates[D3DRENDERSTATE_FOGVERTEXMODE] = D3DFOG_NONE;
        // Float-as-DWORD fog params, D3D defaults (start=0.0, end=1.0, density=1.0).
        this.renderStates[D3DRENDERSTATE_FOGSTART] = 0x00000000;
        this.renderStates[D3DRENDERSTATE_FOGEND] = 0x3F800000;
        this.renderStates[D3DRENDERSTATE_FOGDENSITY] = 0x3F800000;
        this.renderStates[D3DRENDERSTATE_COLORKEYENABLE] = 0;
        // KNOWN DEVIATION, shared with the D3D7 backend: D3D8's documented default is TRUE,
        // exactly as in D3D9 — and the D3D9 state tracker does seed TRUE. Seeding FALSE here
        // keeps the two legacy backends' lighting behaviour identical until this path reaches
        // parity, at the cost of a title routed through a d3d8→d3d9 wrapper being lit while
        // the same title on native d3d8 is not. Explicit SetRenderState(LIGHTING, TRUE) works
        // either way. Close this by flipping it to 1, not by reverting the D3D9 tracker.
        this.renderStates[D3DRENDERSTATE_LIGHTING] = 0;
        this.renderStates[D3DRENDERSTATE_AMBIENT] = 0;
        this.renderStates[D3DRENDERSTATE_SPECULARENABLE] = 0;
        this.renderStates[D3DRENDERSTATE_TEXTUREFACTOR] = 0xffffffff;
        // D3D FFP colour-source defaults: DIFFUSE=COLOR1, SPECULAR=COLOR2, AMBIENT/EMISSIVE=MATERIAL.
        // Matches the D3D9 state-tracker defaults; the executor resolves these against COLORVERTEX
        // and the per-draw FVF so a source naming an absent vertex colour falls back to MATERIAL.
        this.renderStates[D3DRENDERSTATE_DIFFUSEMATERIALSOURCE] = 1; // D3DMCS_COLOR1
        this.renderStates[D3DRENDERSTATE_AMBIENTMATERIALSOURCE] = 0; // D3DMCS_MATERIAL
        this.renderStates[D3DRENDERSTATE_SPECULARMATERIALSOURCE] = 2; // D3DMCS_COLOR2
        this.renderStates[D3DRENDERSTATE_EMISSIVEMATERIALSOURCE] = 0; // D3DMCS_MATERIAL
        // COLORVERTEX/LOCALVIEWER default TRUE per D3D. renderStates is an Int32Array, so an
        // unseeded slot reads 0 — the executor would treat that as an explicit FALSE and
        // collapse every material source to MATERIAL (white ambient×ambient), turning e.g.
        // translucent black vertex-colored UI panels opaque white (Morrowind main menu).
        this.renderStates[D3DRENDERSTATE_COLORVERTEX] = 1;
        this.renderStates[D3DRENDERSTATE_LOCALVIEWER] = 1;
        // Point-sprite size render states are FLOATS bit-cast into the DWORD. Seed the D3D
        // defaults so an explicit 0.0f (points suppressed / no lower clamp) is distinguishable
        // from "never set" — the point-sprite path reads these directly via rsFloat.
        this.renderStates[D3DRENDERSTATE_POINTSIZE] = 0x3F800000;     // 1.0f
        this.renderStates[D3DRENDERSTATE_POINTSIZE_MIN] = 0x3F800000; // 1.0f
        this.renderStates[D3DRENDERSTATE_POINTSIZE_MAX] = 0x46000000; // 8192.0f (advertised MaxPointSize)

        // Stage 0: modulate texture with diffuse, alpha from texture.
        this.textureStates[0 * 32 + D3DTSS_COLOROP] = D3DTOP_MODULATE;
        this.textureStates[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
        this.textureStates[0 * 32 + D3DTSS_COLORARG2] = D3DTA_DIFFUSE;
        this.textureStates[0 * 32 + D3DTSS_ALPHAOP] = D3DTOP_SELECTARG1;
        this.textureStates[0 * 32 + D3DTSS_ALPHAARG1] = D3DTA_TEXTURE;
        this.textureStates[0 * 32 + D3DTSS_ALPHAARG2] = D3DTA_DIFFUSE;

        for (let stage = 0; stage < 8; stage++) {
            const offset = stage * 32;
            this.textureStates[offset + D3DTSS_ADDRESSU] = D3DTADDRESS_WRAP;
            this.textureStates[offset + D3DTSS_ADDRESSV] = D3DTADDRESS_WRAP;
            this.textureStates[offset + D3DTSS_TEXCOORDINDEX] = stage;
            this.textureStates[offset + D3DTSS_MINFILTER] = D3DTEXF_POINT;
            this.textureStates[offset + D3DTSS_MAGFILTER] = D3DTEXF_POINT;
            this.textureStates[offset + D3DTSS_MIPFILTER] = D3DTEXF_NONE;
            if (stage > 0) {
                this.textureStates[offset + D3DTSS_COLOROP] = D3DTOP_DISABLE;
                this.textureStates[offset + D3DTSS_ALPHAOP] = D3DTOP_DISABLE;
            }
        }
    }

    // ---------------------------------------------------------------
    // State setters
    // ---------------------------------------------------------------

    setRenderState(state: number, value: number): void {
        if (this.recordingStateBlock) { this.recordStateBlock({ op: 'renderState', state, value }); return; }
        if (state >= 0 && state < 256) {
            this.renderStates[state] = value;
        }
    }

    getRenderState(state: number): number {
        return (state >= 0 && state < 256) ? this.renderStates[state] : 0;
    }

    setTextureStageState(stage: number, type: number, value: number): void {
        if (this.recordingStateBlock) { this.recordStateBlock({ op: 'textureStageState', stage, type, value }); return; }
        if (stage >= 0 && stage < 8 && type >= 0 && type < 32) {
            this.textureStates[stage * 32 + type] = value;
        }
    }

    getTextureStageState(stage: number, type: number): number {
        if (stage >= 0 && stage < 8 && type >= 0 && type < 32) {
            return this.textureStates[stage * 32 + type];
        }
        return 0;
    }

    setTransform(type: number, matrix: Float32Array): void {
        if (this.recordingStateBlock) { this.recordStateBlock({ op: 'transform', state: type, matrix: new Float32Array(matrix) }); return; }
        this.transforms.set(type, new Float32Array(matrix));
        this.mvpDirty = true;
    }

    getTransform(type: number): Float32Array | null {
        return this.transforms.get(type) ?? null;
    }

    // Reused per-draw texture-matrix list (index = stage 0..2); zero-alloc hot path.
    private texMatricesScratch: (Float32Array | null)[] = [null, null, null];

    /** Collect the D3DTS_TEXTURE0..2 matrices for stages whose
     *  D3DTSS_TEXTURETRANSFORMFLAGS is non-DISABLE. Returns null when no stage
     *  transforms so untransformed draws pay nothing (and stay MegaBatch-eligible). */
    private getTexMatricesForDraw(): (Float32Array | null)[] | null {
        let any = false;
        for (let stage = 0; stage < 3; stage++) {
            let m: Float32Array | null = null;
            if (this.textureStates[stage * 32 + D3DTSS_TEXTURETRANSFORMFLAGS] !== 0) {
                m = this.transforms.get(D3DTS_TEXTURE0 + stage) ?? null;
            }
            this.texMatricesScratch[stage] = m;
            if (m) any = true;
        }
        return any ? this.texMatricesScratch : null;
    }

    setTexture(stage: number, surface: DirectDrawSurfaceState | null, texComPtr = 0): void {
        if (this.recordingStateBlock) { this.recordStateBlock({ op: 'texture', stage, texPtr: texComPtr >>> 0 }); return; }
        if (stage >= 0 && stage < 8) {
            this.textures[stage] = surface;
            this.textureHandles[stage] = texComPtr >>> 0;
        }
    }

    getTextureComPtr(stage: number): number {
        if (stage < 0 || stage >= 8) return 0;
        return this.textureHandles[stage] >>> 0;
    }

    /** Drop a released texture from every stage that still references it. */
    invalidateTextureComPtr(texComPtr: number): void {
        const ptr = texComPtr >>> 0;
        if (!ptr) return;
        for (let stage = 0; stage < 8; stage++) {
            if ((this.textureHandles[stage] >>> 0) === ptr) {
                this.textures[stage] = null;
                this.textureHandles[stage] = 0;
            }
        }
    }

    clearTextureBindings(): void {
        for (let stage = 0; stage < 8; stage++) {
            this.textures[stage] = null;
            this.textureHandles[stage] = 0;
        }
    }

    /** SetPaletteEntries(PaletteNumber, pEntries): capture 256 PALETTEENTRY
     *  ({peRed,peGreen,peBlue,peFlags}) verbatim — that byte order already matches the
     *  RGBA the shared decoder expects (peFlags = alpha for P8). A fresh array per call
     *  makes the draw-time identity check re-decode textures bound to a swapped palette. */
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

    /** Re-decode bound P8/A8P8 textures against the device's current palette before a
     *  draw. Only fires when the bound palette differs (by identity) from the one baked
     *  into rgbaScratch, so it is a no-op for the steady state and for non-palettized
     *  textures. This decouples palette binding from upload order (RenderWare sets the
     *  texture palette per glyph, often after the font texture was already uploaded). */
    private bakeTexturePalettes(): void {
        this.ensureTexturePalette(this.textures[0]);
        this.ensureTexturePalette(this.textures[1]);
        this.ensureTexturePalette(this.textures[2]);
    }

    private ensureTexturePalette(surface: DirectDrawSurfaceState | null): void {
        if (!surface || surface.surfaceType !== 'bitmap_texture') return;
        const bmp = surface as BitmapTextureSurface;
        const fmt = bmp.d3dFormat;
        if (fmt !== D3DFMT_P8 && fmt !== D3DFMT_A8P8) return;

        const pal = this.texturePalettes.getPalette(this.texturePalettes.getCurrentTexturePalette());
        if (bmp.palette === pal || !bmp.surfacePtr) return;
        bmp.palette = pal;

        const mem = this.getMemoryView();
        const layout = getD3DTextureLayout(fmt, bmp.width, bmp.height);
        const pitch = bmp.pitch || layout.pitch;
        const px = bmp.width * bmp.height * 4;
        if (bmp.rgbaScratch.length !== px) bmp.rgbaScratch = new Uint8Array(px);
        if (bmp.surfacePtr + pitch * bmp.height > mem.length) return;

        decodeD3DTextureToRgba8(mem, bmp.surfacePtr, bmp.width, bmp.height, fmt, {
            pitch,
            out: bmp.rgbaScratch,
            surfaceFormat: bmp.format,
            palette: pal,
        });
        bmp.gpuNeedsUpload = true;
        bmp.contentVersion = (bmp.contentVersion ?? 0) + 1;
    }

    // NOTE (perf): setPixelShader/setVertexShader/setFVF must NOT invalidate the programmable
    // pipeline cache. The cache key embeds vsHandle:psHandle and shader handles are allocated
    // monotonically (never reused — see D3D8ShaderRegistry.allocHandle), so switching the active
    // shader simply selects a different key; no entry can ever alias a different shader.
    // Clearing here made every SetVertexShader (UE2 does one per mesh) rebuild the
    // GPURenderPipeline + shader module on the next draw — measured ~170 createRenderPipeline/s
    // on XIII. Invalidation lives in delete*Shader (handle retirement) only.
    setPixelShader(handle: number): number {
        const token = handle >>> 0;
        if (token === 0) {
            this.flushProgrammablePending();
            this.pixelShaderHandle = 0;
            this.shaders.activePsHandle = 0;
            return 0;
        }
        if (!this.shaders.getPsObject(token)) return 0x8876086c;
        this.pixelShaderHandle = token;
        this.shaders.activePsHandle = token;
        return 0;
    }

    getPixelShaderHandle(): number {
        return this.pixelShaderHandle >>> 0;
    }

    /** DeleteVertexShader: registry delete + retire its cached pipelines (hygiene). */
    deleteVertexShader(handle: number): number {
        const hr = this.shaders.deleteVertexShader(handle);
        if (hr === 0) this.programmable?.purgeShaderPipelines(handle >>> 0, null);
        return hr;
    }

    /** DeletePixelShader: registry delete + retire its cached pipelines (hygiene). */
    deletePixelShader(handle: number): number {
        const hr = this.shaders.deletePixelShader(handle);
        if (hr === 0) this.programmable?.purgeShaderPipelines(null, handle >>> 0);
        return hr;
    }

    /**
     * Map a D3DPRESENT_PARAMETERS MultiSampleType (D3DMULTISAMPLE_TYPE) to a supported sample
     * count (2 or 4, else 1) and push it to the shared executor. The executor folds it as
     * max(quality.msaa, guest-requested) at the next frame boundary, so a game that asks for
     * back-buffer MSAA gets it even when quality.msaa is 1. NONE/NONMASKABLE/other → 1 keeps
     * the guest-NONE default byte-identical. Device-global (matches our single-count backend).
     */
    applyPresentMultiSampleType(multiSampleType: number): void {
        const t = multiSampleType >>> 0;
        const count = t === D3DMULTISAMPLE_4_SAMPLES ? 4 : t === D3DMULTISAMPLE_2_SAMPLES ? 2 : 1;
        this.renderer.setGuestRequestedMsaa(count);
    }

    /**
     * D3DPRESENT_PARAMETERS.FullScreen_PresentationInterval, as refreshes to hold each
     * Present. Same encoding as d3d9's PresentationInterval; windowed mode is required to
     * pass DEFAULT, which decodes to ONE, so no mode-dependent branch is needed.
     */
    private presentInterval = PRESENT_INTERVAL_ONE;

    setPresentationInterval(rawInterval: number): void {
        this.presentInterval = decodeD3DPresentInterval(rawInterval);
    }

    reset(pPresentationParameters: number, mem: Uint8Array): number {
        if (!pPresentationParameters) return 0x8876086c;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const width = Math.max(1, view.getUint32(pPresentationParameters + 0, true) || 800);
        const height = Math.max(1, view.getUint32(pPresentationParameters + 4, true) || 600);
        // D3DPRESENT_PARAMETERS.MultiSampleType is at offset +16 (D3D8 has no MultiSampleQuality).
        this.applyPresentMultiSampleType(view.getUint32(pPresentationParameters + 16, true));
        // FullScreen_PresentationInterval @ +48 — re-declared by every Reset.
        this.setPresentationInterval(view.getUint32(pPresentationParameters + 48, true));

        Logger.log(LogCategory.SYSTEM, `D3D8 Reset(${width}x${height}, interval=${this.presentInterval})`);

        this.flushProgrammablePending();
        // Windowed @ +28 (d3d8): only a fullscreen Reset sets the display mode.
        System.getInstance().requestHostResize(width, height, {
            modeSet: view.getUint32(pPresentationParameters + 28, true) === 0,
        });
        this.renderTarget = createRenderTarget(width, height);
        this.rtOverride = null;
        this.viewport = sanitizeViewport({ x: 0, y: 0, width, height, minZ: 0, maxZ: 1 }, width, height);
        this.depthStencilSurfacePtr = 0;
        this.clearTextureBindings();
        this.initDefaultStates();
        this.transforms.clear();
        this.mvpDirty = true;
        this.cachedMVP = null;
        return 0;
    }

    /** Copy the current back-buffer contents into a CPU-backed image surface (GetFrontBuffer). */
    copyFrontBufferTo(dest: BitmapTextureSurface): boolean {
        const process = System.getInstance().process;
        if (!process) return false;

        const guestMem = process.getCurrentMemory();
        const rt = this.renderTarget;
        if (!this.copyRenderTargetPixelsTo(guestMem, rt, dest)) {
            return false;
        }
        return true;
    }

    /** GPU→CPU readback of the device render target, then row-copy into dest. */
    async readRenderTargetToBitmapSurface(dest: BitmapTextureSurface): Promise<boolean> {
        const process = System.getInstance().process;
        if (!process) return false;

        const rt = this.renderTarget;
        if (!rt.surfacePtr) {
            const bytesPerPixel = Math.max(1, Math.floor(rt.format.bpp / 8));
            const pitch = Math.max(rt.pitch, rt.width * bytesPerPixel);
            try {
                rt.surfacePtr = process.memory.alloc(pitch * rt.height);
                rt.pitch = pitch;
            } catch {
                return false;
            }
        }

        if (surfaceSyncManager.syncToCPUFromScratch(rt, process.getCurrentMemory())) {
            return this.copyRenderTargetPixelsTo(process.getCurrentMemory(), rt, dest);
        }

        if (surfaceSyncManager.needsCPUSync(rt).needed) {
            await this.renderer.syncSurfaceToMemory(rt);
        }

        return this.copyRenderTargetPixelsTo(process.getCurrentMemory(), rt, dest);
    }

    private copyRenderTargetPixelsTo(
        guestMem: Uint8Array,
        rt: RenderSurface,
        dest: BitmapTextureSurface,
    ): boolean {
        const process = System.getInstance().process;
        if (!process || !rt.surfacePtr) return false;

        const copyW = Math.min(dest.width, rt.width);
        const copyH = Math.min(dest.height, rt.height);
        const srcBpp = Math.max(1, Math.floor(rt.format.bpp / 8));
        const dstBpp = Math.max(1, Math.floor(dest.format.bpp / 8));
        const rowBytes = Math.min(copyW * srcBpp, copyW * dstBpp);

        if (!dest.surfacePtr) {
            dest.surfacePtr = process.memory.alloc(dest.pitch * dest.height);
        }

        for (let row = 0; row < copyH; row++) {
            const srcRow = rt.surfacePtr + row * rt.pitch;
            const dstRow = dest.surfacePtr + row * dest.pitch;
            if (srcRow + rowBytes > guestMem.length || dstRow + rowBytes > guestMem.length) {
                return false;
            }
            guestMem.set(guestMem.subarray(srcRow, srcRow + rowBytes), dstRow);
        }
        return true;
    }

    setFVF(fvf: number): void {
        this.flushProgrammablePending();
        this.fvf = fvf;
        this.activeVertexShaderHandle = 0;
        this.shaders.activeVsHandle = 0;
        // No pipeline-cache invalidation — see the note on setPixelShader.
    }

    setVertexShaderHandle(handle: number): number {
        this.flushProgrammablePending();
        const h = handle >>> 0;
        if (!this.shaders.getVsObject(h)) return 0x8876086c;
        this.activeVertexShaderHandle = h;
        this.shaders.activeVsHandle = h;
        this.fvf = 0;
        this.updateDeclOnlyMapping();
        // No pipeline-cache invalidation — see the note on setPixelShader.
        return 0;
    }

    setMaterial(mat: D3DMaterial7Data): void {
        this.material = mat;
    }

    /** Snapshot of the current material (GetMaterial / state-block capture). */
    getMaterial(): D3DMaterial7Data {
        const m = this.material;
        return {
            diffuse: { ...m.diffuse },
            ambient: { ...m.ambient },
            specular: { ...m.specular },
            emissive: { ...m.emissive },
            power: m.power,
        };
    }

    getAllTransforms(): { state: number; matrix: Float32Array }[] {
        const out: { state: number; matrix: Float32Array }[] = [];
        for (const [state, matrix] of this.transforms) out.push({ state, matrix });
        return out;
    }

    getAllLights(): { index: number; light: D3DLight7Data }[] {
        const out: { index: number; light: D3DLight7Data }[] = [];
        for (const [index, light] of this.lights) out.push({ index, light });
        return out;
    }

    getEnabledLightIndices(): number[] {
        return Array.from(this.lightsEnabled).sort((a, b) => a - b);
    }

    /** MultiplyTransform: the given matrix composes BEFORE the current one
     *  (row-vector order v' = v·M·T — hierarchical child-then-parent). */
    multiplyTransform(type: number, matrix: Float32Array): void {
        const current = this.transforms.get(type);
        const result = current ? multiplyMatrices(matrix, current) : new Float32Array(matrix);
        this.transforms.set(type, result);
        this.mvpDirty = true;
    }

    // Clip planes: stored faithfully for Get/Set + state blocks and pushed to the shared
    // ddraw executor (device-global binding-6 buffer) so the FFP raster path evaluates them
    // (world space, per D3DRS_CLIPPLANEENABLE). See DDrawWebGPUExecutor.updateClipPlanes.
    private clipPlanes = new Map<number, Float32Array>();

    setClipPlane(index: number, plane: Float32Array): void {
        this.clipPlanes.set(index, new Float32Array(plane));
        this.renderer.updateClipPlanes(this.getAllClipPlanes());
    }

    getClipPlane(index: number): Float32Array | null {
        return this.clipPlanes.get(index) ?? null;
    }

    getAllClipPlanes(): { index: number; plane: Float32Array }[] {
        const out: { index: number; plane: Float32Array }[] = [];
        for (const [index, plane] of this.clipPlanes) out.push({ index, plane });
        return out;
    }

    // ── State blocks (D3D8 DWORD tokens) ────────────────────────────────
    private readonly stateBlockRecorder = new KeyedStateBlockRecorder<D3D8StateBlockEntry>(d3d8EntryKey);
    private readonly stateBlocks = new Map<number, D3D8StateBlockEntry[]>();
    private nextStateBlockToken = 1;

    /** True while BeginStateBlock recording is open — Set* calls journal, not apply. */
    get recordingStateBlock(): boolean {
        return this.stateBlockRecorder.isRecording();
    }

    recordStateBlock(entry: D3D8StateBlockEntry): void {
        this.stateBlockRecorder.record(entry);
    }

    beginStateBlock(): number {
        if (this.stateBlockRecorder.isRecording()) return 0x88760825; // D3DERR_INBEGINSTATEBLOCK
        this.stateBlockRecorder.begin();
        return 0;
    }

    endStateBlock(): { hr: number; token: number } {
        if (!this.stateBlockRecorder.isRecording()) return { hr: 0x88760826, token: 0 }; // D3DERR_NOTINBEGINSTATEBLOCK
        const entries = this.stateBlockRecorder.end();
        const token = this.nextStateBlockToken++;
        this.stateBlocks.set(token, entries);
        return { hr: 0, token };
    }

    applyStateBlock(token: number): number {
        const entries = this.stateBlocks.get(token >>> 0);
        if (!entries) return 0x8876086c; // D3DERR_INVALIDCALL
        applyD3D8StateBlockEntries(this, entries);
        return 0;
    }

    captureStateBlock(token: number): number {
        const entries = this.stateBlocks.get(token >>> 0);
        if (!entries) return 0x8876086c;
        refreshD3D8CapturedEntries(this, entries);
        return 0;
    }

    createStateBlock(blockType: number): { hr: number; token: number } {
        if (blockType !== D3DSBT_ALL && blockType !== D3DSBT_PIXELSTATE && blockType !== D3DSBT_VERTEXSTATE) {
            return { hr: 0x8876086c, token: 0 };
        }
        const token = this.nextStateBlockToken++;
        this.stateBlocks.set(token, captureD3D8StateToEntries(this, blockType));
        return { hr: 0, token };
    }

    deleteStateBlock(token: number): number {
        return this.stateBlocks.delete(token >>> 0) ? 0 : 0x8876086c;
    }

    setLight(index: number, light: D3DLight7Data): void {
        this.lights.set(index, light);
    }

    /** Retrieve a previously-Set light (for IDirect3DDevice8::GetLight). */
    getLight(index: number): D3DLight7Data | undefined {
        return this.lights.get(index);
    }

    lightEnable(index: number, enable: boolean): void {
        if (this.recordingStateBlock) { this.recordStateBlock({ op: 'lightEnable', index, enable }); return; }
        if (enable) this.lightsEnabled.add(index);
        else this.lightsEnabled.delete(index);
    }

    isLightEnabled(index: number): boolean {
        return this.lightsEnabled.has(index);
    }

    getFFPLightingState(): FFPLightingState | null {
        const lightingEnabled = !!this.renderStates[D3DRENDERSTATE_LIGHTING];
        
        const ambientVal = this.renderStates[D3DRENDERSTATE_AMBIENT] >>> 0;
        const ambientColor: RGBA = {
            r: ((ambientVal >> 16) & 0xFF) / 255.0,
            g: ((ambientVal >> 8) & 0xFF) / 255.0,
            b: (ambientVal & 0xFF) / 255.0,
            a: ((ambientVal >> 24) & 0xFF) / 255.0,
        };

        const enabledLights: D3DLight7Data[] = [];
        const sortedIndices = Array.from(this.lightsEnabled).sort((a, b) => a - b);
        for (const index of sortedIndices) {
            const light = this.lights.get(index);
            if (light) {
                enabledLights.push(light);
            }
            if (enabledLights.length >= 8) break;
        }

        return {
            lightingEnabled,
            material: this.material,
            lights: enabledLights,
            ambientColor,
            worldMatrix: this.transforms.get(D3DTS_WORLD) ?? identityMatrix(),
            worldViewMatrix: this.getWorldViewMatrix(),
            viewMatrix: this.transforms.get(D3DTS_VIEW) ?? identityMatrix(),
            diffuseSource: this.renderStates[D3DRENDERSTATE_DIFFUSEMATERIALSOURCE] ?? 0,
            ambientSource: this.renderStates[D3DRENDERSTATE_AMBIENTMATERIALSOURCE] ?? 0,
            specularSource: this.renderStates[D3DRENDERSTATE_SPECULARMATERIALSOURCE] ?? 0,
            emissiveSource: this.renderStates[D3DRENDERSTATE_EMISSIVEMATERIALSOURCE] ?? 0,
        };
    }

    // ---------------------------------------------------------------
    // MVP matrix computation
    // ---------------------------------------------------------------

    /** World×View (camera/eye space) for D3DTSS_TCI_CAMERASPACE* texgen. Row-major, same
     *  convention as getMVP. Null only when neither world nor view has been set. */
    getWorldViewMatrix(): Float32Array | null {
        const world = this.transforms.get(D3DTS_WORLD);
        const view = this.transforms.get(D3DTS_VIEW);
        if (!world && !view) return null;
        const result = world ? new Float32Array(world) : identityMatrix();
        return view ? multiplyMatrices(result, view) : result;
    }

    // Reused world-matrix palette for fixed-function vertex blend (max 4 matrices = D3DVBF_3WEIGHTS).
    private readonly blendPaletteScratch: (Float32Array | null)[] = [null, null, null, null];

    // Indexed-blend palette cap. Real HW (DXVK D3D9MaxVertexBlendTransformsHw / the
    // MaxVertexBlendMatrixIndex=8 we advertise) exposes 8 world matrices D3DTS_WORLDMATRIX(0..7);
    // the per-vertex UBYTE4 selects an index into this palette. SWVP's 256 is out of scope for the
    // FFP path — 8 covers the practical fixed-function skinning set. Documented cap.
    private static readonly MAX_INDEXED_BLEND_MATRICES = 8;
    // Reused full palette for indexed blend (index selects into it; can't shrink to `count`).
    private readonly indexedBlendPaletteScratch: (Float32Array | null)[] =
        new Array(D3D8DeviceAdapter.MAX_INDEXED_BLEND_MATRICES).fill(null);

    /**
     * Fixed-function vertex blend (D3DRS_VERTEXBLEND / GPU skinning) descriptor for a draw whose
     * FVF is XYZBn, else null (→ every non-skinned draw is byte-identical).
     * palette[i] = D3DTS_WORLDMATRIX(i) = transform index D3DTS_WORLD(256)+i (identity when unset),
     * matching the D3D macro. Model verified against DXVK d3d9_device.cpp UpdateFixedFunction /
     * d3d9_fixed_function_vert.vert (D3D9FF_VertexBlendMode_Normal): N+1 matrices for N weights,
     * last weight = 1 − Σ(others).
     *
     * INDEXED (D3DRS_INDEXEDVERTEXBLENDENABLE): the vertex's LAST beta is a D3DFVF_LASTBETA_UBYTE4
     * dword packing 4 unsigned-BYTE matrix indices; iteration i selects palette[index_i] instead of
     * palette[i] (index_i = (packed >> (i*8)) & 0xFF, matching DXVK's R8G8B8A8_USCALED unpack +
     * uint(roundEven(in_BlendIndices[i]))). Requires the UBYTE4 flag. Iteration count = weights + 1
     * (D3DVBF_0WEIGHTS → 1 matrix from index_0, implicit weight 1.0). The full [0..cap) palette is
     * passed since the per-vertex index selects into it. D3DVBF_TWEENING stays inert (null).
     */
    private resolveVertexBlend(activeFvf: number): VertexBlendInput | null {
        const vbf = this.renderStates[D3DRENDERSTATE_VERTEXBLEND] | 0;
        const indexed = (this.renderStates[D3DRENDERSTATE_INDEXEDVERTEXBLENDENABLE] | 0) !== 0;
        const posType = activeFvf & D3DFVF_POSITION_MASK;
        if (posType !== D3DFVF_XYZB1 && posType !== D3DFVF_XYZB2 && posType !== D3DFVF_XYZB3 &&
            posType !== D3DFVF_XYZB4 && posType !== D3DFVF_XYZB5) return null;

        if (indexed) {
            // Requires the UBYTE4 last-beta flag; without it the last beta is a float weight (a
            // non-indexed blend was requested with the indexed enable spuriously set — stay inert).
            if ((activeFvf & D3DFVF_LASTBETA_UBYTE4) === 0) return null;
            // D3DVBF_0WEIGHTS(256)&0xff = 0 explicit weights (single index); 1/2/3 → N weights.
            const w = vbf === D3DVBF_0WEIGHTS ? 0 : vbf;
            if (w !== 0 && w !== D3DVBF_1WEIGHTS && w !== D3DVBF_2WEIGHTS && w !== D3DVBF_3WEIGHTS) return null;
            const count = w + 1; // N weights → N+1 iterations/indices
            for (let i = 0; i < D3D8DeviceAdapter.MAX_INDEXED_BLEND_MATRICES; i++) {
                this.indexedBlendPaletteScratch[i] = this.transforms.get(D3DTS_WORLD + i) ?? null;
            }
            return { palette: this.indexedBlendPaletteScratch, count, indexed: true };
        }

        if (vbf !== D3DVBF_1WEIGHTS && vbf !== D3DVBF_2WEIGHTS && vbf !== D3DVBF_3WEIGHTS) return null;
        const count = vbf + 1; // N weights → N+1 matrices
        for (let i = 0; i < count; i++) {
            this.blendPaletteScratch[i] = this.transforms.get(D3DTS_WORLD + i) ?? null;
        }
        return { palette: this.blendPaletteScratch, count };
    }

    /** View×Projection (world excluded), row-major — the MVP a vertex-blend draw needs because
     *  its positions are pre-blended into WORLD space on the CPU. Null when neither is set. */
    private getViewProjMatrix(): Float32Array | null {
        const view = this.transforms.get(D3DTS_VIEW);
        const proj = this.transforms.get(D3DTS_PROJECTION);
        if (!view && !proj) return null;
        let result = view ? new Float32Array(view) : identityMatrix();
        if (proj) result = multiplyMatrices(result, proj);
        return result;
    }

    /**
     * Resolve the per-draw FFP matrices + lighting, honoring fixed-function vertex blend. For a
     * normal draw these are exactly getMVP()/getWorldViewMatrix()/getFFPLightingState(). For a
     * blended (skinned) draw the CPU converter emits WORLD-space positions/normals, so world MUST
     * be excluded from everything downstream — equivalent to "world = identity for this draw":
     *   mvp        → View·Proj   (VS applies this to the world-space position → correct clip)
     *   worldView  → View        (FFP lighting eye-space pos/normal = View·world-space → correct)
     *   lighting.worldMatrix/worldViewMatrix likewise reset to identity/View.
     * This keeps BOTH the MVP transform and the eye-space lighting inputs correct simultaneously.
     */
    private buildFfpDrawContext(activeFvf: number): {
        blend: VertexBlendInput | null;
        mvp: Float32Array | undefined;
        worldView: Float32Array | null;
        lighting: FFPLightingState | undefined;
    } {
        const blend = this.resolveVertexBlend(activeFvf);
        let mvp = this.getMVP() ?? undefined;
        let worldView = this.getWorldViewMatrix();
        const lighting = this.getFFPLightingState() ?? undefined;
        if (blend) {
            const view = this.transforms.get(D3DTS_VIEW) ?? null;
            mvp = this.getViewProjMatrix() ?? undefined;
            worldView = view ? new Float32Array(view) : null;
            if (lighting) {
                lighting.worldMatrix = identityMatrix();
                lighting.worldViewMatrix = view ? new Float32Array(view) : identityMatrix();
            }
        }
        return { blend, mvp, worldView, lighting };
    }

    getMVP(): Float32Array | null {
        if (!this.mvpDirty && this.cachedMVP) return this.cachedMVP;

        const world = this.transforms.get(D3DTS_WORLD);
        const view = this.transforms.get(D3DTS_VIEW);
        const proj = this.transforms.get(D3DTS_PROJECTION);

        if (!world && !view && !proj) {
            this.cachedMVP = null;
            this.mvpDirty = false;
            return null;
        }

        // MVP = World × View × Projection
        let result = world ? new Float32Array(world) : identityMatrix();
        if (view) result = multiplyMatrices(result, view);
        if (proj) result = multiplyMatrices(result, proj);

        this.cachedMVP = result;
        this.mvpDirty = false;
        return result;
    }

    // ---------------------------------------------------------------
    // Draw calls — delegate to FFPRenderer
    // ---------------------------------------------------------------

    // Draw call diagnostic: log first N draws per frame to identify blurry textures
    private drawDiagCount = 0;
    private drawDiagFrame = 0;
    private drawDiagMaxPerFrame = 0; // 0 = disabled, set via console: d3d8DiagDraws(N)
    private drawDiagLog(kind: string, verticesAddr: number, vertexCount: number, sourceStride = 0, activeFvf = 0, indicesAddr = 0): void {
        if (this.drawDiagMaxPerFrame <= 0) return;
        if (this.drawDiagCount >= this.drawDiagMaxPerFrame) return;
        this.drawDiagCount++;

        const tex0 = this.textures[0];
        const tex1 = this.textures[1];
        const minF = this.textureStates[0 * 32 + D3DTSS_MINFILTER];
        const magF = this.textureStates[0 * 32 + D3DTSS_MAGFILTER];
        const fvf = activeFvf || this.getActiveVertexToken();
        const posType = fvf & 0x000E; // D3DFVF_POSITION_MASK
        const fvfType = posType === 0x0004 ? "RHW" : (posType === 0x0002 ? "XYZ" : `pos0x${posType.toString(16)}`);

        const stride = sourceStride || this.streamSources[0].stride || 32;
        const mem = this.getMemoryView();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Follow the index buffer for indexed draws so we read the ACTUAL drawn
        // vertices (linear VB[0..] is meaningless for indexed glyph runs).
        const idx = (i: number): number => {
            if (!indicesAddr) return i;
            const a = indicesAddr + i * 2;
            return a + 2 <= mem.length ? view.getUint16(a, true) : i;
        };
        // Apply the MVP (row-vector × row-major matrix, D3D convention) → NDC.
        const mvp = this.getMVP();
        const ndcOf = (x: number, y: number, z: number): string => {
            if (!mvp || mvp.length < 16) return "(no-mvp)";
            const cx = x*mvp[0] + y*mvp[4] + z*mvp[8]  + mvp[12];
            const cy = x*mvp[1] + y*mvp[5] + z*mvp[9]  + mvp[13];
            const cw = x*mvp[3] + y*mvp[7] + z*mvp[11] + mvp[15];
            if (Math.abs(cw) < 1e-6) return "(w~0)";
            return `ndc(${(cx/cw).toFixed(3)},${(cy/cw).toFixed(3)})`;
        };

        let verts = "";
        for (let i = 0; i < Math.min(4, vertexCount); i++) {
            const base = verticesAddr + idx(i) * stride;
            if (base + 16 > mem.length) break;
            const x = view.getFloat32(base, true);
            const y = view.getFloat32(base + 4, true);
            const z = view.getFloat32(base + 8, true);
            const uvOff = base + stride - 8; // UVs are typically last 8 bytes
            const u = uvOff + 8 <= mem.length ? view.getFloat32(uvOff, true).toFixed(3) : "?";
            const v = uvOff + 8 <= mem.length ? view.getFloat32(uvOff + 4, true).toFixed(3) : "?";
            verts += ` v${i}=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(2)} uv=${u},${v} ${ndcOf(x,y,z)})`;
        }

        const mvpTag = mvp ? `mvp[sx=${mvp[0].toFixed(3)},sy=${mvp[5].toFixed(3)},tx=${mvp[12].toFixed(3)},ty=${mvp[13].toFixed(3)},w3=${mvp[3].toFixed(3)},w7=${mvp[7].toFixed(3)}]` : "mvp=none";

        // Diffuse vertex color (ARGB) of v0, if FVF has DIFFUSE — offset depends on
        // whether a NORMAL is present (XYZ=12, +NORMAL=12, then DIFFUSE).
        let diffuseTag = "noDiffuse";
        if (fvf & 0x40) {
            const dOff = verticesAddr + 12 + ((fvf & 0x10) ? 12 : 0);
            if (dOff + 4 <= mem.length) diffuseTag = `diffuse=0x${(view.getUint32(dOff, true) >>> 0).toString(16).padStart(8, "0")}`;
        }
        const L = this.getFFPLightingState();
        const c3 = (c: { r: number; g: number; b: number } | undefined) => c ? `${c.r.toFixed(2)},${c.g.toFixed(2)},${c.b.toFixed(2)}` : "?";
        const lightTag = L
            ? `LIGHT[on=${L.lightingEnabled ? 1 : 0} n=${L.lights.length} gAmb=${c3(L.ambientColor)} mEmis=${c3(L.material?.emissive)} mAmb=${c3(L.material?.ambient)} mDif=${c3(L.material?.diffuse)} dSrc=${L.diffuseSource} aSrc=${L.ambientSource} eSrc=${L.emissiveSource}]`
            : "LIGHT[null]";
        const rs = this.renderStates;
        const stateTag =
            `LIGHTING=${rs[D3DRENDERSTATE_LIGHTING] ?? 0} ` +
            `aBlend=${rs[D3DRENDERSTATE_ALPHABLENDENABLE] ?? 0} src=${rs[D3DRENDERSTATE_SRCBLEND] ?? 0} dst=${rs[D3DRENDERSTATE_DESTBLEND] ?? 0} ` +
            `aTest=${rs[D3DRENDERSTATE_ALPHATESTENABLE] ?? 0} aRef=${rs[D3DRENDERSTATE_ALPHAREF] ?? 0} aFunc=${rs[D3DRENDERSTATE_ALPHAFUNC] ?? 0} ` +
            `texF=0x${(rs[D3DRENDERSTATE_TEXTUREFACTOR] >>> 0).toString(16)} ` +
            `cOp=${this.textureStates[0 * 32 + D3DTSS_COLOROP] ?? 0} aOp=${this.textureStates[0 * 32 + D3DTSS_ALPHAOP] ?? 0}`;

        const line =
            `#${this.drawDiagCount} ${kind} fvf=0x${fvf.toString(16)}(${fvfType}) stride=${stride} ` +
            `tex0=${tex0 ? `${tex0.width}x${tex0.height}` : 'none'}${tex0 ? ` fmt=0x${((tex0 as { d3dFormat?: number }).d3dFormat ?? 0).toString(16)}/aMask=0x${((tex0.format?.aMask ?? 0) >>> 0).toString(16)}${(() => { const s = (tex0 as { rgbaScratch?: Uint8Array }).rgbaScratch; if (!s) return '/noScratch'; let a0 = 0, a255 = 0, aMid = 0, a0white = 0, sampleRGB = ''; for (let i = 3; i < s.length; i += 4) { const a = s[i]; if (a === 0) { a0++; if (s[i-3] >= 250 && s[i-2] >= 250 && s[i-1] >= 250) a0white++; if (!sampleRGB) sampleRGB = `${s[i-3]},${s[i-2]},${s[i-1]}`; } else if (a === 255) a255++; else aMid++; } return `/aHist[0=${a0}(white=${a0white},rgb0=${sampleRGB}),255=${a255},mid=${aMid}]`; })()}` : ''} ` +
            `filter=${minF}/${magF} vp=${this.viewport.width}x${this.viewport.height} ${diffuseTag} ${lightTag} ${stateTag} ${mvpTag} ` +
            `vCount=${vertexCount}${verts}`;
        Logger.warn(LogCategory.SYSTEM, `[D3D8-DIAG] ${line}`);
        // Durable sink: the log ring rotates out under D3D8 state spam before a
        // harness can fetch it; this array survives until the next enable.
        const sink = ((globalThis as any).__d3d8diag ??= []);
        sink.push(line);
    }

    /** Console API: call d3d8DiagDraws(N) to log next N draw calls */
    enableDrawDiag(maxPerFrame: number): void {
        this.drawDiagMaxPerFrame = maxPerFrame;
        this.drawDiagCount = 0;
        (globalThis as any).__d3d8diag = [];
        Logger.warn(LogCategory.SYSTEM, `[D3D8-DIAG] Enabled: logging ${maxPerFrame} draws`);
    }

    /** Harness CaptureBus producer for D3D8. D3D8 bypasses draw-handler.ts
     *  but its renderStates/textureStates/textures are the SAME layout the FFP
     *  recordDrawCall consumes — so it feeds the one schema with backend:"d3d8".
     *  Gated by isCapturing() → zero cost when not capturing. */
    private captureDrawIfArmed(primitiveType: number, vertexType: number, lpVertices: number, count: number, isIndexed: boolean, lpIndices: number, iCount: number, mem: Uint8Array, sourceStride: number): void {
        if (!frameCapture.isCapturing()) return;
        frameCapture.recordDrawCall({
            primitiveType, vertexType, lpVertices, count, lpIndices, iCount, mem, isIndexed,
            rtState: this.activeRenderTarget,
            texStateObj: this.textures[0] ?? null,
            texStateObj1: this.textures[1] ?? null,
            renderStates: this.renderStates,
            texStates: this.textureStates,
            backend: "d3d8",
            sourceStride,
            mvp: this.getMVP(),
            viewport: {
                x: this.viewport.x, y: this.viewport.y,
                width: this.viewport.width, height: this.viewport.height,
                minZ: this.viewport.minZ ?? 0, maxZ: this.viewport.maxZ ?? 1,
            },
            executionDiagnostics: (this.renderer as any).getLastDrawDiagnostics?.() ?? null,
        });
    }

    /** Gather + upload the GPU bindings for streams ≥ 1 referenced by the active decl.
     *  Offsets follow stream 0's convention: firstVertex × per-stream stride, and the size
     *  runs from that offset — the same origin the executor's vertex-range guard compares
     *  against, which is why a stream too SHORT for the draw is not rejected here: the guard
     *  owns that rule for every backend and substitutes zeros the way hardware does. Returns
     *  [] for single-stream decls, null when a referenced stream is unbound/unsized. */
    private collectExtraStreamBindings(
        vsObj: D3D8VsObject,
        firstVertex: number,
        mem: Uint8Array,
    ): StreamVertexBinding[] | null {
        const { bindings, missing } = collectExtraStreamBindings(vsObj.decl, (s) => {
            const src = this.streamSources[s];
            const vb = this.vbData.get(src.vb);
            if (!vb) return null;
            const stride = src.stride > 0 ? src.stride : (vsObj.streamStrides[s] ?? 0);
            if (stride <= 0) return null;
            const gpu = this.uploadVb(src.vb, vb.guestPtr, vb.size, mem);
            if (!gpu) return null;
            return { buffer: gpu, offset: 0, size: vb.size, stride };
        }, firstVertex);

        // D3D8's programmable path indexes streams through a shader-declared register map, so
        // an unresolvable stream leaves a register with no source at all: abort rather than
        // feed the shader something arbitrary. (D3D9 substitutes an empty binding instead —
        // see D3D9Device.resolveDrawStreams.)
        if (missing.length > 0) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 draw: decl references unbound/unsized stream(s) ${missing.join(",")}`);
            return null;
        }
        return bindings;
    }

    /** Interleave vertices [firstVertex, firstVertex+vertexCount) of every stream the
     *  decl-only plan references into the canonical FVF layout at scratch[0..). Extra
     *  bytes (copied index range) are reserved after the vertex block. Null on failure.
     *  upStream0 substitutes stream 0's source for DrawPrimitiveUP. */
    private interleaveDeclStreams(
        firstVertex: number,
        vertexCount: number,
        mem: Uint8Array,
        extraBytes: number,
        upStream0: { guestPtr: number; stride: number } | null = null,
    ): Uint8Array | null {
        const plan = this.declInterleave!;
        const dstStride = this.syntheticDeclStride;
        const vertexBytes = vertexCount * dstStride;
        // The scratch stands in for a guest memory view downstream, and the vertex converter
        // takes whole-buffer u32/f32 views over it — so its LENGTH must be word-aligned, which
        // the appended index block (16-bit indices, odd count) otherwise breaks.
        const total = (vertexBytes + extraBytes + 3) & ~3;
        if (this.declScratch.length < total) {
            this.declScratch = new Uint8Array(Math.max(total, this.declScratch.length * 2, 4096));
        }
        const scratch = this.declScratch;

        // Resolve per-stream sources once.
        const bases: number[] = [];
        const strides: number[] = [];
        for (const c of plan) {
            if (bases[c.stream] !== undefined) continue;
            if (c.stream === 0 && upStream0) {
                bases[0] = upStream0.guestPtr;
                strides[0] = upStream0.stride;
                continue;
            }
            const src = this.streamSources[c.stream];
            const vb = this.vbData.get(src.vb);
            if (!vb) {
                Logger.warn(LogCategory.SYSTEM, `D3D8 decl-only draw: stream ${c.stream} has no VB bound`);
                return null;
            }
            const stride = src.stride > 0 ? src.stride : (this.declStreamStrides[c.stream] ?? 0);
            if (stride <= 0) {
                Logger.warn(LogCategory.SYSTEM, `D3D8 decl-only draw: stream ${c.stream} has no resolvable stride`);
                return null;
            }
            const end = (firstVertex + vertexCount) * stride;
            if (end > vb.size) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `D3D8 decl-only draw: stream ${c.stream} range out of bounds first=${firstVertex} count=${vertexCount} stride=${stride} size=${vb.size}`
                );
                return null;
            }
            bases[c.stream] = vb.guestPtr;
            strides[c.stream] = stride;
        }

        for (const c of plan) {
            const srcStride = strides[c.stream];
            let src = bases[c.stream] + firstVertex * srcStride + c.srcOffset;
            let dst = c.dstOffset;
            const size = c.size;
            if (src < 0 || src + (vertexCount - 1) * srcStride + size > mem.length) return null;
            for (let v = 0; v < vertexCount; v++) {
                for (let b = 0; b < size; b++) scratch[dst + b] = mem[src + b];
                src += srcStride;
                dst += dstStride;
            }
        }
        return scratch;
    }

    /** FFP draw for a multi-stream decl-only shader: streams are interleaved into the
     *  canonical FVF layout, then rendered as a single-stream draw from scratch memory. */
    private drawDeclInterleavedFFP(
        primitiveType: number,
        startVertex: number,
        vertexCount: number,
        upStream0: { guestPtr: number; stride: number } | null = null,
    ): number {
        const mem = this.getMemoryView();
        const scratch = this.interleaveDeclStreams(startVertex, vertexCount, mem, 0, upStream0);
        if (!scratch) return 0x8876086c;

        this.flushProgrammablePending();
        const mvp = this.getMVP();
        this.renderer.drawPrimitive(
            this.activeRenderTarget,
            primitiveType,
            this.syntheticDeclFvf,
            0,
            vertexCount,
            scratch,
            this.viewport,
            this.stageTexForDraw(0),
            this.renderStates,
            this.textureStates,
            mvp ?? undefined,
            this.stageTexturesForDraw(),
            this.getTexMatricesForDraw(),
            this.getFFPLightingState() ?? undefined,
            this.syntheticDeclStride,
            this.getWorldViewMatrix() // point-sprite attenuation (D3DRS_POINTSCALEENABLE)
        );
        this.captureDrawIfArmed(primitiveType, this.syntheticDeclFvf, 0, vertexCount, false, 0, 0, scratch, this.syntheticDeclStride);
        return 0;
    }

    /** Indexed variant of drawDeclInterleavedFFP — the used index range is copied into
     *  the scratch after the vertex block so both resolve within one memory view.
     *  upStream0/upIndices substitute UP data for DrawIndexedPrimitiveUP. */
    private drawIndexedDeclInterleavedFFP(
        primitiveType: number,
        minIndex: number,
        numVertices: number,
        startIndex: number,
        indexCount: number,
        upStream0: { guestPtr: number; stride: number } | null = null,
        upIndices: { guestPtr: number; is32: boolean } | null = null,
    ): number {
        let indexIsUint32: boolean;
        let ibGuestPtr: number;
        let indexByteOffset: number;
        if (upIndices) {
            indexIsUint32 = upIndices.is32;
            ibGuestPtr = upIndices.guestPtr;
            indexByteOffset = startIndex * (indexIsUint32 ? 4 : 2);
        } else {
            const ib = this.ibData.get(this.indexIB);
            if (!ib) {
                Logger.warn(LogCategory.SYSTEM, `D3D8 DrawIndexedPrimitive: no IB bound`);
                return 0x8876086c;
            }
            indexIsUint32 = ib.format === 102;
            const indexStride = indexIsUint32 ? 4 : 2;
            indexByteOffset = startIndex * indexStride;
            const indexBytes = indexCount * indexStride;
            if (indexByteOffset < 0 || indexBytes < 0 || indexByteOffset + indexBytes > ib.size) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `D3D8 DrawIndexedPrimitive: IB range out of bounds start=${startIndex} count=${indexCount} size=${ib.size}`
                );
                return 0x8876086c;
            }
            ibGuestPtr = ib.guestPtr;
        }
        const indexBytes = indexCount * (indexIsUint32 ? 4 : 2);

        const mem = this.getMemoryView();
        const vertexRangeCount = (minIndex >>> 0) + numVertices;
        const baseVertex = upStream0 ? 0 : this.baseVertexIndex;
        const scratch = this.interleaveDeclStreams(baseVertex, vertexRangeCount, mem, indexBytes, upStream0);
        if (!scratch) return 0x8876086c;

        const indicesOffset = vertexRangeCount * this.syntheticDeclStride;
        const ibStart = ibGuestPtr + indexByteOffset;
        if (ibStart < 0 || ibStart + indexBytes > mem.length) return 0x8876086c;
        scratch.set(mem.subarray(ibStart, ibStart + indexBytes), indicesOffset);

        this.flushProgrammablePending();
        const mvp = this.getMVP();
        this.renderer.drawIndexedPrimitive(
            this.activeRenderTarget,
            primitiveType,
            this.syntheticDeclFvf,
            0,
            vertexRangeCount,
            indicesOffset,
            indexCount,
            scratch,
            this.viewport,
            this.stageTexForDraw(0),
            this.renderStates,
            this.textureStates,
            mvp ?? undefined,
            this.stageTexturesForDraw(),
            this.getTexMatricesForDraw(),
            0,
            this.getFFPLightingState() ?? undefined,
            this.syntheticDeclStride,
            indexIsUint32
        );
        this.captureDrawIfArmed(primitiveType, this.syntheticDeclFvf, 0, vertexRangeCount, true, indicesOffset, indexCount, scratch, this.syntheticDeclStride);
        return 0;
    }

    private noteDrawForDebug(primitiveType: number, numVerts: number, numIndices?: number): void {
        this.frameSnapshot.drawCalls++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = { api: "d3d8", primitiveType, numVerts, numIndices, timestamp: Date.now() };
    }

    drawPrimitive(primitiveType: number, startVertex: number, primitiveCount: number): number {
        this.bakeTexturePalettes();
        const vertexCount = primCountToVertexCount(primitiveType, primitiveCount);
        this.noteDrawForDebug(primitiveType, vertexCount);
        if (this.isDeclOnly() && this.declInterleave) {
            return this.drawDeclInterleavedFFP(primitiveType, startVertex, vertexCount);
        }
        const vb = this.vbData.get(this.streamSources[0].vb);
        if (!vb) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 DrawPrimitive: no VB bound`);
            return 0x8876086c;
        }

        const activeFvf = this.resolveDrawFVF(vb.fvf);
        const sourceStride = this.resolveDrawStride(activeFvf);
        if (sourceStride <= 0) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 DrawPrimitive: invalid source stride=${sourceStride} fvf=0x${activeFvf.toString(16)}`);
            return 0x8876086c;
        }
        const vertexByteOffset = startVertex * sourceStride;
        const vertexBytes = vertexCount * sourceStride;
        if (vertexByteOffset < 0 || vertexBytes < 0 || vertexByteOffset + vertexBytes > vb.size) {
            Logger.warn(
                LogCategory.SYSTEM,
                `D3D8 DrawPrimitive: VB range out of bounds start=${startVertex} count=${vertexCount} stride=${sourceStride} size=${vb.size}`
            );
            return 0x8876086c;
        }

        const mem = this.getMemoryView();

        if (this.isProgrammable() && this.programmable) {
            const gpuBuffer = this.uploadVb(this.streamSources[0].vb, vb.guestPtr, vb.size, mem);
            if (!gpuBuffer) return 0x8876086c;
            const extraStreams = this.collectExtraStreamBindings(
                this.shaders.getActiveVs()!, startVertex, mem,
            );
            if (extraStreams === null) return 0x8876086c;
            const topology = primitiveType === 2 || primitiveType === 3 ? "line-list" : "triangle-list";
            const pipelineId = this.programmable.resolveProgrammablePipeline(
                this, this.shaders, topology, false, sourceStride,
            );
            if (pipelineId < 0) return 0x8876086c;
            const bindStateIndex = this.programmable.captureDrawState(this, this.shaders, this.renderer);
            this.programmable.getCommandRecorder().recordDraw({
                pipelineId,
                gpuBuffer,
                bufferOffset: vertexByteOffset,
                bufferSize: vb.size - vertexByteOffset,
                vertexCount,
                startVertex: 0,
                bindStateIndex,
                extraStreams: extraStreams.length > 0 ? extraStreams : undefined,
            });
            this.drawDiagLog("DP-prog", vb.guestPtr + vertexByteOffset, vertexCount, sourceStride, activeFvf);
            return 0;
        }

        this.flushProgrammablePending();

        const verticesAddr = vb.guestPtr + vertexByteOffset;
        const ctx = this.buildFfpDrawContext(activeFvf);

        this.drawDiagLog("DP", verticesAddr, vertexCount, sourceStride, activeFvf);

        this.renderer.drawPrimitive(
            this.activeRenderTarget,
            primitiveType,
            activeFvf,
            verticesAddr,
            vertexCount,
            mem,
            this.viewport,
            this.stageTexForDraw(0),
            this.renderStates,
            this.textureStates,
            ctx.mvp,
            this.stageTexturesForDraw(),
            this.getTexMatricesForDraw(),
            ctx.lighting,
            sourceStride,
            ctx.worldView, // point-sprite attenuation (D3DRS_POINTSCALEENABLE)
            ctx.blend      // fixed-function vertex blend (GPU skinning)
        );
        this.captureDrawIfArmed(primitiveType, activeFvf, verticesAddr, vertexCount, false, 0, 0, mem, sourceStride);
        return 0;
    }

    drawPrimitiveUP(primitiveType: number, primitiveCount: number, dataPtr: number, stride: number): number {
        this.bakeTexturePalettes();
        const vertexCount = primCountToVertexCount(primitiveType, primitiveCount);
        this.noteDrawForDebug(primitiveType, vertexCount);
        if (this.isDeclOnly() && this.declInterleave) {
            // UP data feeds stream 0; streams ≥ 1 keep their SetStreamSource bindings.
            const s0 = stride > 0 ? stride : (this.declStreamStrides[0] ?? 0);
            if (s0 <= 0) return 0x8876086c;
            return this.drawDeclInterleavedFFP(primitiveType, 0, vertexCount, { guestPtr: dataPtr, stride: s0 });
        }
        const mem = this.getMemoryView();
        const activeFvf = this.isDeclOnly()
            ? this.syntheticDeclFvf
            : (this.shaders.activeVsHandle !== 0 ? this.fvf : this.getActiveVertexToken());
        const effectiveStride = this.isDeclOnly() && this.syntheticDeclStride > 0
            ? this.syntheticDeclStride
            : stride;
        if (activeFvf === 0) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 DrawPrimitiveUP: no valid FVF for active vertex shader token=0x${this.getActiveVertexToken().toString(16)}`);
            return 0x8876086c;
        }

        if (this.isProgrammable() && this.programmable) {
            const device = this.getGpuDevice();
            if (!device) return 0x8876086c;
            const byteSize = vertexCount * effectiveStride;
            const gpuBuffer = device.createBuffer({
                size: Math.max(16, byteSize),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(gpuBuffer, 0, mem.buffer, mem.byteOffset + dataPtr, byteSize);
            const extraStreams = this.collectExtraStreamBindings(
                this.shaders.getActiveVs()!, 0, mem,
            );
            if (extraStreams === null) { gpuBuffer.destroy(); return 0x8876086c; }
            const topology = primitiveType === 2 || primitiveType === 3 ? "line-list" : "triangle-list";
            const pipelineId = this.programmable.resolveProgrammablePipeline(
                this, this.shaders, topology, true, effectiveStride,
            );
            if (pipelineId < 0) { gpuBuffer.destroy(); return 0x8876086c; }
            const bindStateIndex = this.programmable.captureDrawState(this, this.shaders, this.renderer);
            this.programmable.getCommandRecorder().recordDraw({
                pipelineId,
                gpuBuffer,
                bufferOffset: 0,
                bufferSize: byteSize,
                vertexCount,
                startVertex: 0,
                bindStateIndex,
                extraStreams: extraStreams.length > 0 ? extraStreams : undefined,
            });
            this.programmable.getCommandRecorder().registerPooledBuffer(gpuBuffer);
            return 0;
        }

        this.flushProgrammablePending();

        const ctx = this.buildFfpDrawContext(activeFvf);

        this.drawDiagLog("DPUP", dataPtr, vertexCount, effectiveStride, activeFvf);

        this.renderer.drawPrimitive(
            this.activeRenderTarget,
            primitiveType,
            activeFvf,
            dataPtr,
            vertexCount,
            mem,
            this.viewport,
            this.stageTexForDraw(0),
            this.renderStates,
            this.textureStates,
            ctx.mvp,
            this.stageTexturesForDraw(),
            this.getTexMatricesForDraw(),
            ctx.lighting,
            effectiveStride,
            ctx.worldView, // point-sprite attenuation (D3DRS_POINTSCALEENABLE)
            ctx.blend      // fixed-function vertex blend (GPU skinning)
        );
        this.captureDrawIfArmed(primitiveType, activeFvf, dataPtr, vertexCount, false, 0, 0, mem, effectiveStride);
        return 0;
    }

    drawIndexedPrimitive(primitiveType: number, minIndex: number, numVertices: number, startIndex: number, primitiveCount: number): number {
        this.bakeTexturePalettes();
        const indexCount = primCountToVertexCount(primitiveType, primitiveCount);
        this.noteDrawForDebug(primitiveType, numVertices, indexCount);
        if (this.isDeclOnly() && this.declInterleave) {
            return this.drawIndexedDeclInterleavedFFP(primitiveType, minIndex, numVertices, startIndex, indexCount);
        }
        const vb = this.vbData.get(this.streamSources[0].vb);
        const ib = this.ibData.get(this.indexIB);
        if (!vb || !ib) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 DrawIndexedPrimitive: no VB/IB bound`);
            return 0x8876086c;
        }

        const activeFvf = this.resolveDrawFVF(vb.fvf);
        const sourceStride = this.resolveDrawStride(activeFvf);
        if (sourceStride <= 0) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 DrawIndexedPrimitive: invalid source stride=${sourceStride} fvf=0x${activeFvf.toString(16)}`);
            return 0x8876086c;
        }
        const minVertexIndex = minIndex >>> 0;
        const baseVertexByteOffset = this.baseVertexIndex * sourceStride;
        const vertexRangeCount = (minVertexIndex + numVertices) >>> 0;
        const vertexBytes = vertexRangeCount * sourceStride;
        if (baseVertexByteOffset < 0 || vertexBytes < 0 || baseVertexByteOffset + vertexBytes > vb.size) {
            Logger.warn(
                LogCategory.SYSTEM,
                `D3D8 DrawIndexedPrimitive: VB range out of bounds base=${this.baseVertexIndex} min=${minVertexIndex} count=${numVertices} stride=${sourceStride} size=${vb.size}`
            );
            return 0x8876086c;
        }

        const indexIsUint32 = ib.format === 102;
        const indexStride = indexIsUint32 ? 4 : 2;
        const indexByteOffset = startIndex * indexStride;
        const indexBytes = indexCount * indexStride;
        if (indexByteOffset < 0 || indexBytes < 0 || indexByteOffset + indexBytes > ib.size) {
            Logger.warn(
                LogCategory.SYSTEM,
                `D3D8 DrawIndexedPrimitive: IB range out of bounds start=${startIndex} count=${indexCount} size=${ib.size}`
            );
            return 0x8876086c;
        }

        const mem = this.getMemoryView();

        if (this.isProgrammable() && this.programmable) {
            const vbGpu = this.uploadVb(this.streamSources[0].vb, vb.guestPtr, vb.size, mem);
            const ibGpu = this.uploadIb(this.indexIB, ib.guestPtr, ib.size, mem);
            if (!vbGpu || !ibGpu) return 0x8876086c;
            const extraStreams = this.collectExtraStreamBindings(
                this.shaders.getActiveVs()!, this.baseVertexIndex, mem,
            );
            if (extraStreams === null) return 0x8876086c;
            const topology = primitiveType === 2 || primitiveType === 3 ? "line-list" : "triangle-list";
            const pipelineId = this.programmable.resolveProgrammablePipeline(
                this, this.shaders, topology, false, sourceStride,
            );
            if (pipelineId < 0) return 0x8876086c;
            const bindStateIndex = this.programmable.captureDrawState(this, this.shaders, this.renderer);
            this.programmable.getCommandRecorder().recordDrawIndexed({
                pipelineId,
                vbGpuBuffer: vbGpu,
                vbOffset: baseVertexByteOffset,
                vbSize: vb.size - baseVertexByteOffset,
                ibGpuBuffer: ibGpu,
                ibFormat: indexIsUint32 ? "uint32" : "uint16",
                indexCount,
                startIndex,
                baseVertex: 0,
                bindStateIndex,
                extraStreams: extraStreams.length > 0 ? extraStreams : undefined,
            });
            return 0;
        }

        this.flushProgrammablePending();

        const verticesAddr = vb.guestPtr + baseVertexByteOffset;
        const indicesAddr = ib.guestPtr + indexByteOffset;
        const ctx = this.buildFfpDrawContext(activeFvf);

        this.drawDiagLog("DIP", verticesAddr, indexCount, sourceStride, activeFvf, indicesAddr);

        this.renderer.drawIndexedPrimitive(
            this.activeRenderTarget,
            primitiveType,
            activeFvf,
            verticesAddr,
            vertexRangeCount,
            indicesAddr,
            indexCount,
            mem,
            this.viewport,
            this.stageTexForDraw(0),
            this.renderStates,
            this.textureStates,
            ctx.mvp,
            this.stageTexturesForDraw(),
            this.getTexMatricesForDraw(),
            0,
            ctx.lighting,
            sourceStride,
            indexIsUint32,
            ctx.blend // fixed-function vertex blend (GPU skinning)
        );
        this.captureDrawIfArmed(primitiveType, activeFvf, verticesAddr, vertexRangeCount, true, indicesAddr, indexCount, mem, sourceStride);
        return 0;
    }

    /** DrawIndexedPrimitiveUP: vertices AND indices come from app memory (no VB/IB).
     *  Indices address the UP vertex data directly (no BaseVertexIndex). */
    drawIndexedPrimitiveUP(
        primitiveType: number,
        minVertexIndex: number,
        numVertices: number,
        primitiveCount: number,
        indexPtr: number,
        indexIsUint32: boolean,
        dataPtr: number,
        stride: number,
    ): number {
        this.bakeTexturePalettes();
        const indexCount = primCountToVertexCount(primitiveType, primitiveCount);
        this.noteDrawForDebug(primitiveType, numVertices >>> 0, indexCount);
        const minIndex = minVertexIndex >>> 0;
        const vertexRangeCount = minIndex + (numVertices >>> 0);

        if (this.isDeclOnly() && this.declInterleave) {
            const s0 = stride > 0 ? stride : (this.declStreamStrides[0] ?? 0);
            if (s0 <= 0) return 0x8876086c;
            return this.drawIndexedDeclInterleavedFFP(
                primitiveType, minIndex, numVertices >>> 0, 0, indexCount,
                { guestPtr: dataPtr, stride: s0 },
                { guestPtr: indexPtr, is32: indexIsUint32 },
            );
        }

        const mem = this.getMemoryView();
        const activeFvf = this.isDeclOnly()
            ? this.syntheticDeclFvf
            : (this.shaders.activeVsHandle !== 0 ? this.fvf : this.getActiveVertexToken());
        const effectiveStride = this.isDeclOnly() && this.syntheticDeclStride > 0
            ? this.syntheticDeclStride
            : stride;
        if (activeFvf === 0 || effectiveStride <= 0) {
            Logger.warn(LogCategory.SYSTEM, `D3D8 DrawIndexedPrimitiveUP: no valid FVF/stride for token=0x${this.getActiveVertexToken().toString(16)}`);
            return 0x8876086c;
        }

        if (this.isProgrammable() && this.programmable) {
            const device = this.getGpuDevice();
            if (!device) return 0x8876086c;
            const vertexBytes = vertexRangeCount * effectiveStride;
            const indexBytes = indexCount * (indexIsUint32 ? 4 : 2);
            const vbGpu = device.createBuffer({
                size: Math.max(16, vertexBytes),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(vbGpu, 0, mem.buffer, mem.byteOffset + dataPtr, vertexBytes);
            const ibGpu = device.createBuffer({
                size: Math.max(16, (indexBytes + 3) & ~3),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(ibGpu, 0, mem.buffer, mem.byteOffset + indexPtr, indexBytes);
            const extraStreams = this.collectExtraStreamBindings(
                this.shaders.getActiveVs()!, 0, mem,
            );
            if (extraStreams === null) { vbGpu.destroy(); ibGpu.destroy(); return 0x8876086c; }
            const topology = primitiveType === 2 || primitiveType === 3 ? "line-list" : "triangle-list";
            const pipelineId = this.programmable.resolveProgrammablePipeline(
                this, this.shaders, topology, true, effectiveStride,
            );
            if (pipelineId < 0) { vbGpu.destroy(); ibGpu.destroy(); return 0x8876086c; }
            const bindStateIndex = this.programmable.captureDrawState(this, this.shaders, this.renderer);
            this.programmable.getCommandRecorder().recordDrawIndexed({
                pipelineId,
                vbGpuBuffer: vbGpu,
                vbOffset: 0,
                vbSize: vertexBytes,
                ibGpuBuffer: ibGpu,
                ibFormat: indexIsUint32 ? "uint32" : "uint16",
                indexCount,
                startIndex: 0,
                baseVertex: 0,
                bindStateIndex,
                extraStreams: extraStreams.length > 0 ? extraStreams : undefined,
            });
            this.programmable.getCommandRecorder().registerPooledBuffer(vbGpu);
            this.programmable.getCommandRecorder().registerPooledBuffer(ibGpu);
            return 0;
        }

        this.flushProgrammablePending();

        const ctx = this.buildFfpDrawContext(activeFvf);
        this.drawDiagLog("DIPUP", dataPtr, indexCount, effectiveStride, activeFvf, indexPtr);

        this.renderer.drawIndexedPrimitive(
            this.activeRenderTarget,
            primitiveType,
            activeFvf,
            dataPtr,
            vertexRangeCount,
            indexPtr,
            indexCount,
            mem,
            this.viewport,
            this.stageTexForDraw(0),
            this.renderStates,
            this.textureStates,
            ctx.mvp,
            this.stageTexturesForDraw(),
            this.getTexMatricesForDraw(),
            0,
            ctx.lighting,
            effectiveStride,
            indexIsUint32,
            ctx.blend // fixed-function vertex blend (GPU skinning)
        );
        this.captureDrawIfArmed(primitiveType, activeFvf, dataPtr, vertexRangeCount, true, indexPtr, indexCount, mem, effectiveStride);
        return 0;
    }

    clear(flags: number, color: number, z: number, stencil: number): void {
        this.flushProgrammablePending();
        const rt = this.activeRenderTarget;
        const vp = sanitizeViewport(this.viewport, rt.width, rt.height);
        this.renderer.clear(rt, flags, color, z, vp, undefined, stencil);
    }

    async present(): Promise<number> {
        // Reset draw diagnostic counter each frame
        if (this.drawDiagCount > 0 && this.drawDiagMaxPerFrame > 0) {
            Logger.warn(LogCategory.SYSTEM, `[D3D8-DIAG] Frame ${this.drawDiagFrame}: ${this.drawDiagCount} draws logged`);
            this.drawDiagFrame++;
            this.drawDiagCount = 0;
            // Auto-disable after first frame dump
            this.drawDiagMaxPerFrame = 0;
        }

        profiler.start("present");
        const presentStart = frameProfiler.startTimer();
        // Present is an unambiguous frame boundary (unlike DDraw's many-Blts-per-frame
        // primary), so it paces on the interval the device declared, exactly like d3d9.
        await framePacer.waitForPresentInterval(this.presentInterval);
        framePacer.reserveFrameSlot();

        try {
            this.flushProgrammablePending();

            const system = System.getInstance();
            const backend = system.services.render.getBackend();
            if (!backend || backend.kind !== "webgpu") {
                this.renderer.endFrameForPresent();
                return 0;
            }

            const webgpu = backend as WebGPUBackend;
            const device = webgpu.getDevice();
            const queue = webgpu.getQueue();
            const context = webgpu.getContext();
            const sourceView = this.renderTarget.gpuTextureView;
            if (!device || !queue || !context || !sourceView) {
                Logger.warn(
                    LogCategory.SYSTEM,
                    `D3D8 Present skipped: device=${!!device} queue=${!!queue} context=${!!context} sourceView=${!!sourceView}`
                );
                this.renderer.endFrameForPresent();
                // Clear canvas to prevent undefined swapchain content (white flash)
                if (device && queue && context) {
                    const encoder = device.createCommandEncoder();
                    const targetView = context.getCurrentTexture().createView();
                    encoder.beginRenderPass({
                        colorAttachments: [{
                            view: targetView,
                            loadOp: "clear" as const,
                            clearValue: { r: 0, g: 0, b: 0, a: 1 },
                            storeOp: "store" as const,
                        }],
                    }).end();
                    queue.submit([encoder.finish()]);
                }
                return 0;
            }

            // SINGLE-SUBMIT PRESENT: Finalize draws + present copy in ONE queue.submit().
            // Two submits (endFrameForPresent then drawTexture) can flicker: the
            // compositor may read the swap-chain texture between submits.
            const drawEncoder = this.renderer.finalizePendingDraws();

            // GPU error scopes for first 10 frames
            const useErrorScopes = this.presentCount < 10;
            if (useErrorScopes) {
                device.pushErrorScope("out-of-memory");
                device.pushErrorScope("validation");
            }

            // Reuse the draw encoder if available, otherwise create a new one
            const encoder = drawEncoder ?? device.createCommandEncoder();
            const targetView = context.getCurrentTexture().createView();
            const clearColor = EmulatorConfig.getInstance().screenBackgroundColor;
            webgpu.drawTexture(
                sourceView,
                targetView,
                encoder,
                true,
                undefined,
                undefined,
                clearColor,
                true // nearest-neighbor: pixel-perfect present (no bilinear stretch)
            );

            // Composite GDI overlay (cursor / text / dialogs drawn via GDI on top of D3D8)
            // per the single shared policy (getOverlayCompositePlan): when this 3D renderer
            // owns the screen, GDI windows behind the opaque fullscreen device window are
            // occluded on real Windows (e.g. a UE2 loading-splash #32770), so only live modal
            // dialog rects composite ('rects'), never the whole overlay ('none'); windowed →
            // whole overlay ('full'). Passing `this` keys the 3D-owned check off this device.
            const overlay = system.gdiContext.getOverlayCanvas();
            if (overlay && system.gdiContext.hasOverlayContent()) {
                const plan = getOverlayCompositePlan(this);
                if (plan.mode === 'rects') {
                    webgpu.blitRects(overlay, targetView, encoder, plan.rects);
                } else if (plan.mode === 'full') {
                    webgpu.blit(overlay, targetView, encoder);
                }
                if (system.gdiContext.isOverlayDirty()) {
                    system.gdiContext.clearOverlayDirty();
                }
            }

            // Composite video overlay
            const videoOverlayService = system.videoRouting.getOverlayService();
            const videoOverlay = videoOverlayService.getCanvas();
            if (videoOverlay && videoOverlayService.hasContent()) {
                webgpu.blit(videoOverlay, targetView, encoder);
                videoOverlayService.consumeDirty();
            }

            // Composite stats overlay (worker-side FPS display)
            if (statsOverlay.isEnabled()) {
                const statsCanvas = statsOverlay.getCanvas();
                if (statsCanvas) {
                    if (statsOverlay.isDirty()) {
                        webgpu.updateStatsTexture(statsCanvas);
                        statsOverlay.clearDirty();
                    }
                    webgpu.renderStatsOverlay(targetView, encoder, this.renderTarget.width, this.renderTarget.height);
                }
            }

            this.renderer.ringBufferManager.flushUniforms();
            this.renderer.ringBufferManager.flushStorageBuffer();

            const submitStart = frameProfiler.startTimer();
            queue.submit([encoder.finish()]);
            frameProfiler.endTimer("gpu", submitStart);

            // Post-submit cleanup: rotate ring buffers, destroy pending resources
            this.renderer.sampleFrameStats(); // per-frame draw/skip/ring-HW ring (dbg.fstats)
            this.renderer.ringBufferManager.nextFrame();
            this.renderer.postSubmitCleanup();

            // Pop error scopes and log any GPU errors
            if (useErrorScopes) {
                const frameNum = this.presentCount;
                device.popErrorScope().then(err => {
                    if (!err) return;
                    recordGpuError("scope", "d3d8Present.validation", err.message);
                    Logger.error(LogCategory.SYSTEM, `[D3D8 PRESENT] Validation error frame=${frameNum}: ${err.message}`);
                });
                device.popErrorScope().then(err => {
                    if (!err) return;
                    recordGpuError("scope", "d3d8Present.oom", err.message);
                    Logger.error(LogCategory.SYSTEM, `[D3D8 PRESENT] OOM error frame=${frameNum}: ${err.message}`);
                });
            }

            // Flush pending GPU resource destruction
            if (system.gpuResourceManager) {
                system.gpuResourceManager.flushPendingDestruction();
            }

            if (system.services.render.getActive() !== this) {
                system.services.render.setActive(this);
            }

            this.presentCount++;
            this.frameSnapshot.presents = this.presentCount;
            this.frameSnapshot.lastPresent = {
                surfaceAddr: this.renderTarget.surfacePtr ?? 0,
                width: this.renderTarget.width,
                height: this.renderTarget.height,
                format: `${this.renderTarget.format?.bpp ?? 32}bpp`,
                timestamp: Date.now(),
            };
            this.frameSnapshot.drawCalls = 0;
            system.services.render.notifyPresent("d3d8");
            frameCapture.onFrameEnd("d3d8"); // harness CaptureBus frame boundary (D3D8)

            const now = performance.now();
            if (this.prevPresentTime > 0) {
                statsOverlay.updateMetrics(now - this.prevPresentTime);
            }
            this.prevPresentTime = now;

            return 0;
        } finally {
            profiler.end("present");
            frameProfiler.endTimer("present", presentStart);
            frameProfiler.markFrame("d3d8");
            framePacer.releaseFrameSlot();
        }
    }

    /** PNG of the screen — the canvas, i.e. the final composite (RT + GDI/video/stats
     *  overlays), snapshotted from the last present so it works while paused. */
    async captureFrame(): Promise<Blob> {
        return (await System.getInstance().services.render.tryCaptureScreen())
            ?? new Blob([], { type: "image/png" });
    }

    getCounters(): Record<string, number> {
        return { presents: this.presentCount };
    }

    /** Debug GPU panel — same shape as the D3D9 device's getDebugResourcesInfo. */
    getDebugResourcesInfo(_scope: "summary" | "full" = "summary", onlyActive = false): {
        textures: Array<{ handle: number; width: number; height: number; levels: number; format: number; isDirty: boolean; isLocked: boolean; hasGpuTexture: boolean }>;
        vertexBuffers: Array<{ handle: number; size: number; fvf: number; isDirty: boolean; isLocked: boolean; hasGpuBuffer: boolean }>;
        indexBuffers: Array<{ handle: number; size: number; format: number; isDirty: boolean; isLocked: boolean; hasGpuBuffer: boolean }>;
        pipelineCacheSize: number;
    } {
        const boundTextures = new Set(this.textureHandles.filter(h => h !== 0));
        const boundVbs = new Set(this.streamSources.map(s => s.vb).filter(vb => vb !== 0));

        const textures: Array<{ handle: number; width: number; height: number; levels: number; format: number; isDirty: boolean; isLocked: boolean; hasGpuTexture: boolean }> = [];
        for (const [handle, surf] of this.texSurfaces) {
            const isDirty = surf.surfaceType === "bitmap_texture" ? surf.gpuNeedsUpload : false;
            if (onlyActive && !boundTextures.has(handle) && !isDirty) continue;
            textures.push({
                handle,
                width: surf.width,
                height: surf.height,
                levels: surf.mipMapCount ?? surf.gpuMipLevels ?? 1,
                format: (surf.surfaceType === "bitmap_texture" ? surf.d3dFormat : undefined) ?? 0,
                isDirty,
                isLocked: surf.activeLeaseId !== undefined,
                hasGpuTexture: !!surf.gpuTexture,
            });
        }

        const vertexBuffers: Array<{ handle: number; size: number; fvf: number; isDirty: boolean; isLocked: boolean; hasGpuBuffer: boolean }> = [];
        for (const [handle, vb] of this.vbData) {
            if (onlyActive && !boundVbs.has(handle)) continue;
            vertexBuffers.push({
                handle,
                size: vb.size,
                fvf: vb.fvf,
                isDirty: false,
                isLocked: false,
                hasGpuBuffer: this.vbGpuBuffers.has(handle),
            });
        }

        const indexBuffers: Array<{ handle: number; size: number; format: number; isDirty: boolean; isLocked: boolean; hasGpuBuffer: boolean }> = [];
        for (const [handle, ib] of this.ibData) {
            if (onlyActive && handle !== this.indexIB) continue;
            indexBuffers.push({
                handle,
                size: ib.size,
                format: ib.format,
                isDirty: false,
                isLocked: false,
                hasGpuBuffer: this.ibGpuBuffers.has(handle),
            });
        }

        return {
            textures,
            vertexBuffers,
            indexBuffers,
            pipelineCacheSize: this.renderer.getPipelineCacheSize(),
        };
    }

    /** Debug GPU panel frame snapshot (drawCalls reset each Present, like D3D9). */
    getFrameSnapshot() {
        return { ...this.frameSnapshot };
    }
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function primCountToVertexCount(type: number, primCount: number): number {
    switch (type) {
        case 1: return primCount;          // POINTLIST
        case 2: return primCount * 2;      // LINELIST
        case 3: return primCount + 1;      // LINESTRIP
        case 4: return primCount * 3;      // TRIANGLELIST
        case 5: return primCount + 2;      // TRIANGLESTRIP
        case 6: return primCount + 2;      // TRIANGLEFAN
        default: return primCount * 3;
    }
}

function identityMatrix(): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const r = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            r[i * 4 + j] =
                a[i * 4 + 0] * b[0 * 4 + j] +
                a[i * 4 + 1] * b[1 * 4 + j] +
                a[i * 4 + 2] * b[2 * 4 + j] +
                a[i * 4 + 3] * b[3 * 4 + j];
        }
    }
    return r;
}
