import { Process } from "../../core/process";
import { VTableInfo } from "../../api/adapters/module-adapter";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { DDrawPresenter } from "./presenter";
import { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";
import { DDrawWebGPUExecutor } from "../../backends/webgpu/ddraw/ddraw-backend-executor";
import { DirectDrawSurfaceState } from "./com-objects";
import { DeferredUploadManager } from "./deferred-upload-manager";

/**
 * Texture handle entry - stores GPU texture independently of COM object lifetime.
 * In DirectX, D3DTEXTUREHANDLE survives COM Release - this is how games expect it to work.
 * Store snapshot of fields, NOT reference to mutable state object.
 */
export type TextureHandleEntry = {
    handle: number;           // The D3DTEXTUREHANDLE returned to the game
    gpuTexture: GPUTexture | null;
    gpuTextureView: GPUTextureView | null;
    gpuTextureFormat?: GPUTextureFormat;
    width: number;
    height: number;
    pitch: number;            // Snapshot of pitch (for texture state reconstruction)
    format: {                 // Snapshot of format (for texture state reconstruction)
        flags?: number;
        bpp: number;
        rMask: number;
        gMask: number;
        bMask: number;
        aMask: number;
    };
    /** CPU-First: Surface mode and dirty tracking */
    mode?: "CPU" | "GPU_ONLY";
    version?: number;
    lastUploadVersion?: number;
    /** Source color key (DDCKEY_SRCBLT) for transparent texels; required for alpha color 0. */
    srcColorKey?: { low: number; high: number };
};

export type DDrawContext = {
    process: Process;
    vtables: Record<string, VTableInfo>;
    resourceProvider: SystemResourceProvider;
    presenter: DDrawPresenter;
    backend?: WebGPUBackend;
    executor?: DDrawWebGPUExecutor;
    display: {
        width: number;
        height: number;
        bpp: number;
        refresh: number;
    };
    /**
     * The desktop display mode (faithful: what GDI / the desktop runs at), distinct from
     * `display` which is the current/exclusive mode. Initialized to the boot screenResolution.
     * RestoreDisplayMode / leaving exclusive reverts `display` back to this. On the first
     * exclusive SetDisplayMode the prior `display` is captured here so it can be restored.
     */
    desktopMode: {
        width: number;
        height: number;
        bpp: number;
        refresh: number;
    };
    cooperative: {
        hwnd: number;
        flags: number;
        /** True when DDSCL_EXCLUSIVE was set (typically with DDSCL_FULLSCREEN). */
        exclusive: boolean;
    };
    /**
     * Exclusive-fullscreen screen ownership (real Windows semantics): once the app
     * Flips its primary chain, the flip chain owns the screen and GDI windows are
     * NOT visible until FlipToGDISurface / RestoreDisplayMode / DDSCL_NORMAL.
     * The presenter skips the GDI overlay composite while this is false in
     * DDSCL_EXCLUSIVE|FULLSCREEN mode.
     */
    gdiSurfaceVisible: boolean;
    surfaces: {
        primary: number;
        backBuffer: number;
    };
    /**
     * Guest address of the current IDirectDraw7 COM object (set by DirectDrawCreateEx /
     * QI-to-IDirectDraw7). DX7 lets a game retrieve the owning DirectDraw from a device via
     * `pDevice->QueryInterface(IID_IDirectDraw7, ...)`; Blade does exactly this and, when the
     * call fails, releases the device (its cleanup-on-failure path) — driving the refcount to
     * 0 so we destroy a device it keeps using, then it spins forever on the dead pointer.
     * Tracking the DDraw here lets the device QI return it. 0 = none yet.
     */
    ddraw7ObjectAddr: number;
    usedVidMem: number;
    /**
     * Registry of texture handles for D3DTEXTUREHANDLE support.
     * Key is the D3DTEXTUREHANDLE, value is the GPU texture info.
     */
    textureHandles: Map<number, TextureHandleEntry>;
    nextTextureHandle: number;
    /**
     * Default values container - "source of truth" for reset() and device recreation.
     * These are canonical defaults that should be applied when resetting state.
     */
    defaults: {
        displayRefreshHz: number;
        nextTextureHandleStart: number;
    };
    // lastBoundTextureByDevice removed — was too broad, causing wrong-texture artifacts
    /**
     * Deferred texture upload manager - batches uploads to end of frame for performance.
     * Reduces GPU submission overhead by ~50% (180ms in profiler data).
     */
    deferredUploadManager: DeferredUploadManager;
    /** When true, DDraw auto-present triggers (Unlock/Flip/Blt) are suppressed.
     *  Used during video playback so only _compositeToPrimary presents frames. */
    suppressPresent: boolean;
    /** Gamma ramp state — persists across interface releases (display property). */
    gammaRamp?: {
        red: Float32Array;
        green: Float32Array;
        blue: Float32Array;
        isIdentity: boolean;
    };
    /**
     * Surface pixel buffers deferred until the next CreateSurface/reset.
     * ref_soft/Q2 VID_restart can still touch vid.buffer after surface Release
     * while DestroyWindow / Z_Free finishes.
     */
    deferredSurfacePtrFrees: number[];
};
