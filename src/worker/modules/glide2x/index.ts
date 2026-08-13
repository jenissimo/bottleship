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
import { createLfbExports, destroyLfbSurfaces, revokeAllLfbLeases } from "./lfb";
import { createDrawExports } from "./draw";
import { GlidePresenter } from "./presenter";
import { GlideLfbSurfaceState } from "./context";

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
                ringEvents: [],
                frameSnapshot: this.getFrameSnapshot(),
            };
        }
        return buildGlideDebugInfo(this.context, scope, onlyActive);
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
