import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";
import { registerGpuDeviceObserver } from "../../core/gpu/gpu-device-lifecycle";
import { createGlideContext, GlideContext, GlideDebugInfo, GlideFrameSnapshot, resetGlideContextRuntime } from "./context";
import { cloneFrameSnapshot, buildGlideDebugInfo } from "./diagnostics";
import { createHardwareExports } from "./hardware";
import { createStateExports } from "./state";
import { createTextureExports } from "./texture";
import { createLfbExports, destroyLfbSurfaces, revokeAllLfbLeases, syncSurfaceFromRenderedFrame } from "./lfb";
import { createDrawExports } from "./draw";
import { GlidePresenter, debugLfbRgba } from "./presenter";
import { registerGlideWriteBufferFunctions } from "./fast-path";
import { GlideLfbSurfaceState } from "./context";
import { decodeTextureRecordToRgba } from "./texture";

export class Glide2x implements IModule {
    name = "glide2x";
    exports: Record<string, ThunkImplementation> = {};
    private context: GlideContext | null = null;

    initialize(process: Process): void {
        this.context = createGlideContext(process);
        this.context.presenter = new GlidePresenter(this.context);

        Object.assign(this.exports, createHardwareExports(this.context));
        Object.assign(this.exports, createStateExports(this.context));
        Object.assign(this.exports, createTextureExports(this.context));
        Object.assign(this.exports, createLfbExports(this.context));
        Object.assign(this.exports, createDrawExports(this.context));

        // Move the per-triangle state setters off the OUT trap (see fast-path.ts).
        registerGlideWriteBufferFunctions(process.dispatcher, this.exports, this.context);

        // Device loss invalidates exactly what a backend swap does: the executor and every
        // uploaded TMU texture. The texture records keep the guest `dataPtr` they were
        // decoded from, so clearing `uploadedAt` makes grTexSource re-download them.
        registerGpuDeviceObserver("glide2x", { onDeviceLost: () => this.invalidateGpuState() });
    }

    setBackend(backend: WebGPUBackend): void {
        if (!this.context) return;
        this.context.backend = backend;
        this.invalidateGpuState();
        // Re-created lazily on grSstWinOpen
    }

    private invalidateGpuState(): void {
        if (!this.context) return;
        this.context.executor?.destroy();
        this.context.executor = null;
        for (const tmu of this.context.tmus) {
            for (const tex of tmu.texturesByAddress.values()) {
                tex.uploadedAt = 0;
            }
        }
    }

    getFrameSnapshot(): GlideFrameSnapshot {
        if (!this.context) {
            return {
                frameId: 0,
                drawCalls: 0,
                presents: 0,
                lfbLocks: 0,
                lfbReadLocks: 0,
                lfbUnlocks: 0,
                lfbReads: 0,
                lfbWrites: 0,
                texDownloads: 0,
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
        }
        return cloneFrameSnapshot(this.context.frameSnapshot);
    }

    getDebugResourcesInfo(scope: "summary" | "full" = "summary", onlyActive: boolean = false): GlideDebugInfo {
        if (!this.context) {
            return {
                state: {
                    initialized: false,
                    winOpen: false,
                    width: 0,
                    height: 0,
                    renderBuffer: 0,
                    selectedSst: 0,
                    colorFormat: 0,
                    origin: 0,
                },
                textures: [],
                lfbSurfaces: [],
                runtime: {
                    clipWindow: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
                    viewport: { x: 0, y: 0, width: 0, height: 0 },
                    cullMode: 0,
                    fogMode: 0,
                    stwHint: 0,
                    colorCombineDelta0: false,
                    lastGuColorCombineFunction: -1,
                    tmu0: { minFilter: -1, magFilter: -1, mipMapMode: -1, lodBias: 0, clampS: -1, clampT: -1 },
                },
                ringEvents: [],
                frameSnapshot: this.getFrameSnapshot(),
            };
        }
        return buildGlideDebugInfo(this.context, scope, onlyActive);
    }

    /**
     * The linear frame buffer as the presenter would upload it. `syncFromFrame` runs
     * the exact path a guest READ lock takes, so the dump is the positive control for
     * LFB read-back: it fails visibly (black) when the mirror is not reaching the LFB.
     */
    lfbRgbaForDebug(syncFromFrame = false): { width: number; height: number; rgba: Uint8Array } | null {
        if (!this.context) return null;
        if (syncFromFrame) {
            const surface = this.context.lfbSurfaces.get(this.context.renderBuffer)
                ?? this.context.lfbSurfaces.values().next().value;
            if (surface) {
                this.context.lfbSyncedFrame = -1;
                syncSurfaceFromRenderedFrame(this.context, surface, false);
            }
        }
        return debugLfbRgba(this.context);
    }

    /** The raw guest bytes the texture was decoded from, as captured at upload. */
    textureSourceBytesForDebug(handle: number): Uint8Array | null {
        if (!this.context) return null;
        for (const tmu of this.context.tmus) {
            for (const record of tmu.texturesByAddress.values()) {
                if (record.handle === handle) return record.sourceBytes;
            }
        }
        return null;
    }

    /**
     * Re-decode one uploaded texture from the guest bytes it was decoded from,
     * exactly the way the upload path decodes it — so a texture dump answers
     * "what did the TMU actually see", not "what do we think we sent".
     */
    decodeTextureForDebug(handle: number): { width: number; height: number; rgba: Uint8Array } | null {
        if (!this.context) return null;
        for (const tmu of this.context.tmus) {
            for (const record of tmu.texturesByAddress.values()) {
                if (record.handle !== handle) continue;
                const rgba = decodeTextureRecordToRgba(this.context, record);
                return rgba ? { width: record.width, height: record.height, rgba } : null;
            }
        }
        return null;
    }

    findLfbSurfaceByDataPtr(dataPtr: number): GlideLfbSurfaceState | null {
        if (!this.context || !dataPtr) return null;
        for (const surface of this.context.lfbSurfaces.values()) {
            if (surface.dataPtr === dataPtr) {
                return surface;
            }
        }
        return null;
    }

    reset(): void {
        if (!this.context) return;
        revokeAllLfbLeases(this.context);
        destroyLfbSurfaces(this.context);
        this.context.executor?.destroy();
        this.context.executor = null;
        this.context.diagnostics.reset();
        resetGlideContextRuntime(this.context);
    }
}
