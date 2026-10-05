import { surfaceAt } from "./helpers";
import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { recordGpuError } from '../../core/gpu-error-log';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { ddrawModule } from '../../api/ddraw.api';
import { InterfaceRegistry } from '../../core/com/interface-registry';
import { ComObjectFactory } from '../../core/com/base-com-object';
import { allocateComObject } from '../../core/com/com-memory';
import { SystemResourceProvider } from '../../core/resources/system-resource-provider';
import { System } from '../../core/system';
import { DDrawContext } from './context';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { DDrawPresenter } from './presenter';
import { framePacer } from '../../core/frame-pacer';
import { WebGPUBackend } from '../../backends/webgpu/webgpu-backend';
import { DDrawWebGPUExecutor } from '../../backends/webgpu/ddraw/ddraw-backend-executor';
import { DeferredUploadManager } from './deferred-upload-manager';
import {
    DDSCAPS_TEXTURE,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_BACKBUFFER,
    DDSCAPS_ZBUFFER,
    DDPF_ALPHAPIXELS,
    DDPF_RGB,
    IID_IDirectDraw,
    IID_IDirectDrawAlias,
    IID_IDirectDraw2,
    IID_IDirectDraw4,
    IID_IDirectDraw7,
    IID_IDirectDrawClipper,
    IID_IDirectDrawPalette,
    IID_IDirectDrawSurface,
    IID_IDirectDrawSurface4,
    IID_IDirectDrawSurface7,
    IID_IDirect3D,
    IID_IDirect3D2,
    IID_IDirect3D3,
    IID_IDirect3D7,
    IID_IDirect3DDevice,
    IID_IDirect3DDevice2,
    IID_IDirect3DExecuteBuffer,
    IID_IDirect3DDevice3,
    IID_IDirect3DDevice7,
    IID_IDirect3DTexture,
    IID_IDirect3DTexture2,
    IID_IDirect3DViewport,
    IID_IDirect3DViewport2,
    IID_IDirect3DViewport3,
    IID_IDirectDrawGammaControl,
    IID_IDirect3DLight,
    IID_IDirect3DMaterial,
    IID_IDirect3DMaterial3,
    IID_IDirect3DVertexBuffer,
} from './constants';
import {
    Direct3DObject,
    Direct3D2Object,
    Direct3D3Object,
    Direct3D7Object,
    Direct3DDeviceObject,
    Direct3DDevice2Object,
    Direct3DDevice3Object,
    Direct3DDevice7Object,
    Direct3DViewportObject,
    Direct3DViewport2Object,
    Direct3DViewport3Object,
    Direct3DTextureObject,
    Direct3DTexture2Object,
    DirectDrawObject,
    DirectDrawClipperObject,
    DirectDrawPaletteObject,
    DirectDrawSurfaceObject,
    DirectDrawGammaControlObject,
    Direct3DLightObject,
    Direct3DMaterial3Object,
    Direct3DExecuteBufferObject,
    Direct3DVertexBufferObject,
    DirectDrawSurfaceState,
    SurfaceFormat,
    isBitmapTexture,
    isRenderSurface,
} from './com-objects';
import { createDirectDrawExports } from './directdraw';
import { createSurfaceExports, registerFastPathSurfaceFunctions } from './surface';
import { createD3DExports, registerFastPathD3DFunctions } from './d3d/index';
import { freeExecuteBufferScratch } from './d3d/execute-buffer-impl';
import { createGPUTexture, convertRGBAToSurface, FormatInfo, readSurfaceStateRGBA } from './gpu-texture-utils';
import { resolveBitmapRgba, bitmapHasPixelSource } from '../gdi32/bitmap-resolve';
import { setAuthorityCpu } from './surface-sync';
import { startCapture as frameCaptureStart } from './frame-capture';
import type { CapturedFrame } from './frame-capture-types';

// Frame Debug Snapshot types
export type FrameDebugSnapshot = {
    frameId: number;
    drawCalls: number;
    presents: number;
    lastPresent?: {
        surfaceAddr: number;
        width: number;
        height: number;
        format: string;
        timestamp: number;
    };
    lastDraw?: {
        api: "ddraw" | "d3d9";
        textureHandle?: number;
        surfaceAddr?: number;
        numVerts?: number;
        fvf?: number;
        stride?: number;
        topology?: string;
        alphaBlend?: boolean;
        alphaTest?: boolean;
        zEnable?: boolean;
        zWrite?: boolean;
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
};

export type DDrawSurfaceDebugInfo = {
    address: number;
    handle: number;
    width: number;
    height: number;
    pitch: number;
    format: SurfaceFormat;
    caps: number;
    caps2?: number;
    surfacePtr: number;
    attachedSurfaceAddr: number;
    // CPU-First fields
    mode: "CPU" | "GPU_ONLY" | "bitmap_texture";
    version: number;
    gpuDirty: boolean;
    everLocked: boolean;
    lastUploadVersion: number;
    gpuUpToDate: boolean;
    hasGpuTexture: boolean;
    activeLeaseId?: number;
    vidMemSize?: number;
    srcColorKey?: { low: number; high: number };
    destColorKey?: { low: number; high: number };
    refCount: number;
    role?: "primary" | "backbuffer" | "z" | "texture" | "offscreen";
    lastUsedFrame?: number;
    lastUploadFrame?: number;
    attachedTo?: number[];
    isPrimaryChain?: boolean;
};

export class DDraw implements IModule {
    name = 'ddraw';
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;
    private context!: DDrawContext;
    private bitmapToSurfaceCache: Map<number, number> = new Map(); // HBITMAP -> Surface address
    private thrashAutoPresenterUnregister: (() => void) | null = null;
    
    // Frame snapshot tracking for debug panel
    private frameSnapshot: FrameDebugSnapshot = {
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

    setBackend(backend: WebGPUBackend): void {
        if (this.context) {
            this.context.executor?.destroy();
            this.context.backend = backend;
            this.context.executor = new DDrawWebGPUExecutor(backend);
            
            // Initialize GPU resource manager for deferred destruction
            const system = System.getInstance();
            if (!system.gpuResourceManager) {
                system.initializeGpuResourceManager();
            }
        }
    }

    /**
     * Create a DirectDraw texture surface from a GDI HBITMAP (LoadImageA or CreateDIBSection).
     */
    createTextureFromBitmap(bitmapHandle: number, gdiObj: any): number | null {
        // Check cache first
        const cached = this.bitmapToSurfaceCache.get(bitmapHandle);
        if (cached) {
            return cached;
        }

        if (!gdiObj || !gdiObj.width || !gdiObj.height || gdiObj.loading || !bitmapHasPixelSource(gdiObj)) {
            return null;
        }

        const width = gdiObj.width;
        const height = gdiObj.height;
        const mem = this.getMemory();
        const resolved = resolveBitmapRgba(bitmapHandle, mem);
        if (!resolved) {
            return null;
        }
        gdiObj.pixels = new Uint8Array(resolved.data.buffer, resolved.data.byteOffset, resolved.data.byteLength);
        const rgbaData = resolved.data;

        const bytesPerPixel = 2;
        const pitch = width * bytesPerPixel;
        const surfaceSize = pitch * height;

        let surfacePtr = this.process.allocateSurface(surfaceSize);
        if (surfacePtr === 0) {
            return null;
        }

        if (surfacePtr < 0x10000) {
            this.process.memory.free(surfacePtr);
            try {
                surfacePtr = this.process.memory.allocAt(0x10000, surfaceSize, "SURFACE");
            } catch {
                surfacePtr = this.process.allocateSurface(surfaceSize);
                if (surfacePtr < 0x10000) {
                    return null;
                }
            }
        }

        const rgb565FormatInfo: FormatInfo = {
            bpp: 16,
            rMask: 0xF800,  // RGB565: R=5 bits at bit 11
            gMask: 0x07E0,  // RGB565: G=6 bits at bit 5
            bMask: 0x001F,  // RGB565: B=5 bits at bit 0
            aMask: 0x0000,  // No alpha
        };
        // convertRGBAToSurface expects absolute guest address and RGBA input
        convertRGBAToSurface(rgbaData, mem, surfacePtr, width, height, pitch, rgb565FormatInfo);

        // Save original RGBA data for GPU upload to preserve alpha channel
        // RGB565 format loses alpha, but we need it for transparent UI textures
        const originalRGBA = new Uint8Array(rgbaData);

        // Determine if UV flip is needed (bottom-up BMP / DIB needs shader flip)
        const topDown = gdiObj.isTopDown !== undefined
            ? gdiObj.isTopDown
            : (gdiObj.dibTopDown ?? true);
        const needsUVFlip = topDown === false;

        // Create BitmapTextureSurface (immutable texture from BMP file)
        // Key characteristics:
        // - rgbaScratch is AUTHORITATIVE (never invalidates)
        // - Simple gpuNeedsUpload flag (no version tracking)
        // - No authority/version fields (immutable = always valid)
        const surfaceState: DirectDrawSurfaceState = {
            surfaceType: "bitmap_texture",
            width,
            height,
            pitch,
            caps: DDSCAPS_TEXTURE,
            surfacePtr,
            format: {
                flags: DDPF_RGB,
                bpp: 16,
                rMask: 0xF800,  // RGB565: R=5 bits at bit 11
                gMask: 0x07E0,  // RGB565: G=6 bits at bit 5
                bMask: 0x001F,  // RGB565: B=5 bits at bit 0
                aMask: 0x0000,  // No alpha
            },
            attachedSurfaceAddr: 0,
            surfacePtrAllocated: true, // Mark that this memory was allocated via process.allocateSurface()
            rgbaScratch: originalRGBA, // AUTHORITATIVE: Original RGBA from BMP (preserves alpha)
            gpuNeedsUpload: true, // Needs initial upload to GPU
            needsUVFlip, // Set UV flip flag for shader optimization
            writeGeneration: 0,
        };

        // Log BitmapTexture creation
        Logger.log(LogCategory.DDRAW,
            `createTextureFromBitmap: Created BitmapTexture surfacePtr=0x${surfacePtr.toString(16)} ` +
            `size=${width}x${height} rgbaScratch=${originalRGBA.length} bytes gpuNeedsUpload=true`);

        // Create GPU texture if backend is available (lazy upload on first use)
        if (this.context.backend) {
            const device = this.context.backend.getDevice();
            const texQueue = this.context.backend.getQueue();
            if (device) {
                // For bitmap textures, always use rgba8unorm to ensure predictable alpha/color
                const format = "rgba8unorm";
                // Include RENDER_ATTACHMENT usage for Blt/Clear operations
                // Some games use bitmap textures as Blt targets (e.g., Heroes 3 menu rendering)
                const gpuResult = createGPUTexture(
                    device,
                    texQueue ?? null,
                    width,
                    height,
                    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
                    format
                );
                if (gpuResult) {
                    surfaceState.gpuTexture = gpuResult.texture;
                    surfaceState.gpuTextureView = gpuResult.view;
                    surfaceState.gpuTextureFormat = format; // Store format for pipeline compatibility
                }
            }
        }

        // Create DirectDrawSurfaceObject
        const vtableInfo = this.vtables['IDirectDrawSurface7'];
        if (!vtableInfo) {
            return null;
        }

        const surfaceObj = new DirectDrawSurfaceObject(vtableInfo.address, surfaceState);
        const objAddr = allocateComObject(this.process.memory, mem, vtableInfo.address);
        this.context.resourceProvider.mapAddressToHandle(objAddr, surfaceObj.handle);

        // OPTIMIZATION: Register surfacePtr for fast lookup in ReleaseDC and other hot paths
        if (surfacePtr > 0) {
            this.context.resourceProvider.registerSurfacePtr(surfaceObj.handle, surfacePtr);
        }

        // Cache the mapping
        this.bitmapToSurfaceCache.set(bitmapHandle, objAddr);

        Logger.log(LogCategory.DDRAW,
            `✅ Created BitmapTextureSurface from HBITMAP 0x${bitmapHandle.toString(16)} ` +
            `→ surface=0x${objAddr.toString(16)} handle=0x${surfaceObj.handle.toString(16)} ` +
            `surfacePtr=0x${surfacePtr.toString(16)} size=${width}x${height} ` +
            `refCount=${surfaceObj.refCount}`
        );

        return objAddr;
    }

    /**
     * Update an existing cached texture from a GDI HBITMAP once pixel data is available.
     * If no cache exists, create it.
     */
    updateTextureFromBitmap(bitmapHandle: number, gdiObj: any): number | null {
        if (!gdiObj || !gdiObj.width || !gdiObj.height || !bitmapHasPixelSource(gdiObj)) {
            return null;
        }

        const mem = this.getMemory();
        const resolved = resolveBitmapRgba(bitmapHandle, mem);
        if (!resolved) {
            return null;
        }
        gdiObj.pixels = new Uint8Array(resolved.data.buffer, resolved.data.byteOffset, resolved.data.byteLength);

        const cached = this.bitmapToSurfaceCache.get(bitmapHandle);
        if (!cached) {
            const created = this.createTextureFromBitmap(bitmapHandle, gdiObj);
            return created;
        }

        const surfaceObj = surfaceAt(this.context.resourceProvider, cached);
        if (!surfaceObj) {
            Logger.warn(LogCategory.DDRAW, `updateTextureFromBitmap: Cached surface 0x${cached.toString(16)} not found, recreating`);
            return this.createTextureFromBitmap(bitmapHandle, gdiObj);
        }

        const state = surfaceObj.getState();
        if (state.width !== gdiObj.width || state.height !== gdiObj.height) {
            Logger.warn(
                LogCategory.DDRAW,
                `updateTextureFromBitmap: Size mismatch for HBITMAP 0x${bitmapHandle.toString(16)} cached=${state.width}x${state.height} new=${gdiObj.width}x${gdiObj.height}, recreating`
            );
            return this.createTextureFromBitmap(bitmapHandle, gdiObj);
        }

        const width = gdiObj.width;
        const height = gdiObj.height;
        const rgbaData = resolved.data;

        const bytesPerPixel = Math.max(1, state.format.bpp >> 3);
        const pitch = state.pitch || (width * bytesPerPixel);

        convertRGBAToSurface(rgbaData, mem, state.surfacePtr, width, height, pitch, state.format);

        // Update rgbaScratch - parseBMPPixels should have already converted BGRA → RGBA
        state.rgbaScratch = new Uint8Array(rgbaData);

        Logger.log(LogCategory.DDRAW,
            `updateTextureFromBitmap: Updated surface=0x${state.surfacePtr.toString(16)} ` +
            `size=${width}x${height} rgbaScratch=${state.rgbaScratch.length} bytes`);

        // Update needsUVFlip flag if BMP orientation changed (BitmapTextureSurface only)
        if (state.surfaceType === "bitmap_texture") {
            const topDown = gdiObj.isTopDown !== undefined
                ? gdiObj.isTopDown
                : (gdiObj.dibTopDown ?? true);
            const needsUVFlip = topDown === false;
            state.needsUVFlip = needsUVFlip;

            // Mark GPU texture needs re-upload (immutable texture, simple flag)
            state.gpuNeedsUpload = true;
        } else {
            // RenderSurface path (shouldn't happen for bitmap update, but handle gracefully)
            setAuthorityCpu(state);
        }

        if (!state.gpuTexture && this.context.backend) {
            const device = this.context.backend.getDevice();
            const updQueue = this.context.backend.getQueue();
            if (device) {
                // For bitmap textures, always use rgba8unorm
                const format = "rgba8unorm";
                // Include RENDER_ATTACHMENT usage for Blt/Clear operations
                const gpuResult = createGPUTexture(
                    device,
                    updQueue ?? null,
                    width,
                    height,
                    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
                    format
                );
                if (gpuResult) {
                    state.gpuTexture = gpuResult.texture;
                    state.gpuTextureView = gpuResult.view;
                    state.gpuTextureFormat = format; // Store format for pipeline compatibility
                }
            }
        }

        // Ensure bitmap handle resolves to the cached surface.
        Logger.log(LogCategory.DDRAW, `updateTextureFromBitmap: Updated cached surface 0x${cached.toString(16)} from HBITMAP 0x${bitmapHandle.toString(16)} (${width}x${height})`);
        return cached;
    }

    /** DIAG: snapshot every DirectDraw surface (pixel ptr, dims, caps, GPU state). */
    dbgListSurfaces(): any[] {
        const out: any[] = [];
        if (!this.context) return out;
        for (const obj of this.context.resourceProvider.getAllComObjects()) {
            const getState = (obj as any).getState;
            if (typeof getState !== "function") continue;
            const s = getState.call(obj);
            if (!s || typeof s.surfacePtr !== "number" || typeof s.width !== "number") continue;
            out.push({
                ptr: `0x${(s.surfacePtr >>> 0).toString(16)}`,
                w: s.width, h: s.height, bpp: s.format?.bpp,
                caps: `0x${((s.caps ?? 0) >>> 0).toString(16)}`,
                mode: s.mode ?? null, ver: s.version ?? null, gpuVer: s.gpuWrittenVersion ?? null,
                gpuTex: !!s.gpuTexture, gpuDirty: s.gpuDirty ?? null,
                fmt: s.gpuTextureFormat ?? null,
                isPrimary: s.surfacePtr === this.context.surfaces.primary || undefined,
            });
        }
        return out;
    }

    /** DIAG: GPU-readback of a surface's texture content. Finds the surface by its
     *  PIXEL pointer (the value shown in dbg.frame rtSurfacePtr / lockTrace), copies
     *  the texture to a mappable buffer, and reports min/max/avg luminance plus an
     *  8x8 sample grid. Ground truth for "did the draws actually land on this RT". */
    async dbgReadSurfacePixels(ptrLike: number | string): Promise<any> {
        const want = (typeof ptrLike === "string" ? parseInt(ptrLike, 16) : ptrLike) >>> 0;
        if (!this.context?.backend) return { err: "no backend" };
        let state: DirectDrawSurfaceState | null = null;
        for (const obj of this.context.resourceProvider.getAllComObjects()) {
            const getState = (obj as any).getState;
            if (typeof getState !== "function") continue;
            const s = getState.call(obj);
            if (s && (s.surfacePtr >>> 0) === want) { state = s; break; }
        }
        if (!state) return { err: `surface 0x${want.toString(16)} not found` };
        if (!state.gpuTexture) return { err: "no gpuTexture", mode: (state as any).mode };
        const device = this.context.backend.getDevice();
        const queue = this.context.backend.getQueue();
        if (!device || !queue) return { err: "no device/queue" };
        this.context.executor?.flush();

        const w = state.width, h = state.height;
        const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
        device.pushErrorScope("validation");
        const buf = device.createBuffer({
            size: bytesPerRow * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer(
            { texture: state.gpuTexture },
            { buffer: buf, bytesPerRow },
            { width: w, height: h, depthOrArrayLayers: 1 },
        );
        queue.submit([enc.finish()]);
        const verr = await device.popErrorScope();
        if (verr) {
            recordGpuError("scope", "ddrawSurfaceProbe", verr.message);
            buf.destroy();
            return { err: `validation: ${verr.message}` };
        }
        await buf.mapAsync(GPUMapMode.READ);
        const data = new Uint8Array(buf.getMappedRange());
        let min = 255, max = 0, nonBlack = 0;
        let sum = 0;
        const grid: number[][] = [];
        for (let gy = 0; gy < 8; gy++) {
            const row: number[] = [];
            for (let gx = 0; gx < 8; gx++) {
                const x = Math.floor(((gx + 0.5) / 8) * w);
                const y = Math.floor(((gy + 0.5) / 8) * h);
                const o = y * bytesPerRow + x * 4;
                row.push((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
            }
            grid.push(row);
        }
        // Full-coverage stats on a subsampled lattice (every 7th px) to keep it fast.
        for (let y = 0; y < h; y += 7) {
            for (let x = 0; x < w; x += 7) {
                const o = y * bytesPerRow + x * 4;
                const lum = (data[o] + data[o + 1] + data[o + 2]) / 3;
                if (lum < min) min = lum;
                if (lum > max) max = lum;
                sum += lum;
                if (lum > 2) nonBlack++;
            }
        }
        const samples = Math.ceil(h / 7) * Math.ceil(w / 7);
        buf.unmap();
        buf.destroy();
        return {
            ptr: `0x${want.toString(16)}`, w, h, fmt: state.gpuTextureFormat ?? "?",
            min: Math.round(min), max: Math.round(max), avg: +(sum / samples).toFixed(2),
            nonBlackPct: +((nonBlack / samples) * 100).toFixed(1),
            grid: grid.map(r => r.map(v => v.toString(16).padStart(6, "0"))),
        };
    }

    /** HARNESS: full RGBA readback of a surface by pixel pointer. Prefers
     *  the authoritative CPU rgbaScratch (zero GPU work, for bitmap textures), else
     *  GPU-reads the texture, de-pads rows, and applies the bgra->rgba swizzle so
     *  the bytes are straight top-down RGBA8 ready for PNG encoding. */
    async readSurfaceRGBA(ptrLike: number | string, from: "auto" | "gpu" | "scratch" = "auto"): Promise<{ w: number; h: number; rgba: Uint8Array; source: string } | { err: string }> {
        const want = (typeof ptrLike === "string" ? parseInt(ptrLike, 16) : ptrLike) >>> 0;
        if (!this.context) return { err: "no ddraw context" };
        let state: DirectDrawSurfaceState | null = null;
        for (const obj of this.context.resourceProvider.getAllComObjects()) {
            const getState = (obj as any).getState;
            if (typeof getState !== "function") continue;
            const s = getState.call(obj);
            if (s && (s.surfacePtr >>> 0) === want) { state = s; break; }
        }
        if (!state) return { err: `surface 0x${want.toString(16)} not found` };
        return readSurfaceStateRGBA(state, this.context.backend ?? null, () => this.context.executor?.flush(), from);
    }

    initialize(process: Process): void {
        this.process = process;

        const interfaceRegistry = InterfaceRegistry.getInstance();
        interfaceRegistry.registerFromModuleDescriptor(ddrawModule);

        this.vtables = createVTablesFromDescriptor(this.process, ddrawModule);
        for (const [name, info] of Object.entries(this.vtables)) {
            Logger.verbose(LogCategory.SYSTEM, `DirectDraw: Created vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
        }

        const system = System.getInstance();
        const resourceProvider = system.resourceProvider;
        const emulatorConfig = EmulatorConfig.getInstance();
        const screenRes = emulatorConfig.screenResolution;
        
        this.context = {
            process: this.process,
            vtables: this.vtables,
            resourceProvider,
            presenter: new DDrawPresenter(this.process),
            display: {
                width: screenRes.width || 640,
                height: screenRes.height || 480,
                bpp: screenRes.bpp || 16,
                refresh: screenRes.refreshRate || 60,
            },
            desktopMode: {
                width: screenRes.width || 640,
                height: screenRes.height || 480,
                bpp: screenRes.bpp || 16,
                refresh: screenRes.refreshRate || 60,
            },
            cooperative: {
                hwnd: 0,
                flags: 0,
                exclusive: false,
            },
            gdiSurfaceVisible: true,
            surfaces: {
                primary: 0,
                backBuffer: 0,
            },
            ddraw7ObjectAddr: 0,
            usedVidMem: 0,
            textureHandles: new Map(),
            nextTextureHandle: 1,
            defaults: {
                displayRefreshHz: 60,
                nextTextureHandleStart: 1,
            },
            deferredUploadManager: new DeferredUploadManager(),
            suppressPresent: false,
            deferredSurfacePtrFrees: [],
        };

        // Expose DDraw context on System so GetSystemMetrics can use the current display mode
        system.ddrawContext = this.context;

        // Register all DirectDraw interface versions - all use DirectDrawObject (tear-off pattern)
        ComObjectFactory.register(IID_IDirectDraw, DirectDrawObject); // IDirectDraw (v1) - returned by DirectDrawCreate
        ComObjectFactory.register(IID_IDirectDrawAlias, DirectDrawObject); // IDirectDraw (alias)
        ComObjectFactory.register(IID_IDirectDraw2, DirectDrawObject); // IDirectDraw2
        ComObjectFactory.register(IID_IDirectDraw4, DirectDrawObject); // IDirectDraw4 (DX6)
        ComObjectFactory.register(IID_IDirectDraw7, DirectDrawObject); // IDirectDraw7 (DX7 - DirectDrawCreateEx)
        ComObjectFactory.register(IID_IDirectDrawClipper, DirectDrawClipperObject); // CreateClipper
        ComObjectFactory.register(IID_IDirectDrawPalette, DirectDrawPaletteObject);
        ComObjectFactory.register(IID_IDirectDrawSurface, DirectDrawSurfaceObject); // IDirectDrawSurface (v1)
        ComObjectFactory.register(IID_IDirectDrawSurface4, DirectDrawSurfaceObject); // IDirectDrawSurface4 (DX6)
        ComObjectFactory.register(IID_IDirectDrawSurface7, DirectDrawSurfaceObject);
        ComObjectFactory.register(IID_IDirect3D, Direct3DObject);
        ComObjectFactory.register(IID_IDirect3D2, Direct3D2Object);
        ComObjectFactory.register(IID_IDirect3D3, Direct3D3Object);
        ComObjectFactory.register(IID_IDirect3DDevice, Direct3DDeviceObject);
        ComObjectFactory.register(IID_IDirect3DDevice2, Direct3DDevice2Object);
        ComObjectFactory.register(IID_IDirect3DDevice3, Direct3DDevice3Object);
        ComObjectFactory.register(IID_IDirect3DViewport, Direct3DViewportObject); // IDirect3DViewport (v1)
        ComObjectFactory.register(IID_IDirect3DViewport2, Direct3DViewport2Object);
        ComObjectFactory.register(IID_IDirect3DViewport3, Direct3DViewport3Object);
        ComObjectFactory.register(IID_IDirect3D7, Direct3D7Object);
        ComObjectFactory.register(IID_IDirect3DTexture, Direct3DTextureObject);
        ComObjectFactory.register(IID_IDirect3DTexture2, Direct3DTexture2Object);
        ComObjectFactory.register(IID_IDirect3DDevice7, Direct3DDevice7Object);
        ComObjectFactory.register(IID_IDirectDrawGammaControl, DirectDrawGammaControlObject);
        ComObjectFactory.register(IID_IDirect3DLight, Direct3DLightObject);
        ComObjectFactory.register(IID_IDirect3DMaterial, Direct3DMaterial3Object); // v1 material — same state, different vtable
        ComObjectFactory.register(IID_IDirect3DMaterial3, Direct3DMaterial3Object);
        ComObjectFactory.register(IID_IDirect3DExecuteBuffer, Direct3DExecuteBufferObject);
        ComObjectFactory.register(IID_IDirect3DVertexBuffer, Direct3DVertexBufferObject);


        Object.assign(this.exports, createDirectDrawExports(this.context));
        Object.assign(this.exports, createSurfaceExports(this.context));
        Object.assign(this.exports, createD3DExports(this.context));

        // Register FastPath for high-frequency D3D functions
        registerFastPathD3DFunctions(process.dispatcher, this.context);

        // Register FastPath for high-frequency surface functions
        registerFastPathSurfaceFunctions(process.dispatcher, this.context);

        // Auto-present for THRASH-style renderers that bypass DDraw Flip/Blt.
        // These renderers hold a write lock on the primary surface indefinitely and never call Unlock/Flip.
        // Hook into framePacer rAF loop for THRASH-style renderers.
        // These renderers Lock the primary surface once and render directly into guest memory
        // without ever calling Unlock or Flip. We present the surface every rAF ourselves.
        // NOTE: intentionally not unregistered in reset() — must survive system.reset() → loadPeData().
        if (this.thrashAutoPresenterUnregister !== null) {
            this.thrashAutoPresenterUnregister();
        }
        this.thrashAutoPresenterUnregister = framePacer.registerOnFrame(() => {
            const ctx = this.context;
            if (!ctx) return;
            const primaryAddr = ctx.surfaces.primary;
            if (!primaryAddr) return;
            const primaryObj = surfaceAt(ctx.resourceProvider, primaryAddr);
            if (!primaryObj) return;
            const state = primaryObj.getState();
            // Gate on write-lock: normal games release the lock before Flip
            // → activeLeaseId=undefined → this path is skipped entirely for them.
            if (state.activeLeaseId === undefined) return;
            if (!isRenderSurface(state)) return;
            // THRASH renderers write new pixels each frame without Unlock,
            // so uploadRGB565SurfaceToGPU's gpuDirty=false reset would otherwise stop presentation.
            // BUT: if GPU has authority (Flip did GPU→GPU copy), guest memory is stale —
            // calling setAuthorityCpu would mark gpuDirty=true, causing the presenter to
            // upload stale/black CPU data over the valid GPU texture → black frame flicker.
            if (state.gpuWrittenVersion !== state.version) {
                setAuthorityCpu(state);
            }
            const mem = this.getMemory();
            if (!mem) return;
            void ctx.presenter.present(state, mem, { throttle: true });
        });
    }

    /**
     * Unregister surface from bitmapToSurfaceCache when surface is destroyed
     */
    unregisterSurfaceFromCache(surfaceHandle: number): void {
        const surfaceAddr = this.context?.resourceProvider.getAddressForHandle(surfaceHandle) ?? null;
        // Find bitmap handle for this surface and remove from cache
        for (const [bitmapHandle, cachedHandle] of this.bitmapToSurfaceCache.entries()) {
            if (cachedHandle === surfaceHandle || (surfaceAddr !== null && cachedHandle === surfaceAddr)) {
                this.bitmapToSurfaceCache.delete(bitmapHandle);
                Logger.verbose(LogCategory.DDRAW, `unregisterSurfaceFromCache: removed HBITMAP 0x${bitmapHandle.toString(16)} -> surface 0x${surfaceHandle.toString(16)}`);
                break;
            }
        }
    }

    /**
     * Invalidate bitmap cache when HBITMAP is deleted
     * Prevents handle reuse bugs where new bitmap gets old surface data
     */
    invalidateBitmapCache(bitmapHandle: number): void {
        const cached = this.bitmapToSurfaceCache.get(bitmapHandle);
        if (cached) {
            this.bitmapToSurfaceCache.delete(bitmapHandle);
            Logger.log(LogCategory.DDRAW,
                `invalidateBitmapCache: Removed HBITMAP 0x${bitmapHandle.toString(16)} → surface 0x${cached.toString(16)}`);
        }
    }

    /**
     * Remove depth buffer for a surface when it's destroyed
     */
    removeDepthForSurface(surfacePtr: number): void {
        if (this.context?.executor) {
            this.context.executor.removeDepthForSurface(surfacePtr);
        }
    }

    /**
     * True when the persistent texture-handle registry still references a GPU texture.
     * Used to defer GPU destruction while D3DTEXTUREHANDLE draws may still use the snapshot.
     */
    isGpuTextureReferencedByRegistry(gpuTexture: GPUTexture): boolean {
        if (!this.context) return false;
        for (const entry of this.context.textureHandles.values()) {
            if (entry.gpuTexture === gpuTexture) return true;
        }
        return false;
    }

    /**
     * Drop registry entries orphaned by COM slot recycle (generation bump). Called when a new
     * DirectDrawSurface is allocated so a guest-cached D3DTEXTUREHANDLE from a prior generation
     * cannot keep serving the old GPU texture after the slot is reused (cursor / UE1 level load).
     * Does NOT run on surface destroy — TR2 keeps drawing via registry after COM Release.
     */
    purgeTextureRegistryForRecycledComSlot(slot: number, newHandle: number): void {
        if (!this.context) return;
        const reg = this.context.textureHandles;
        if (reg.size === 0) return;

        const orphanedGpus = new Set<GPUTexture>();
        let removed = 0;

        for (const [key, entry] of reg) {
            const entrySlot = (entry.handle & SystemResourceProvider.COM_SLOT_MASK) >>> 0;
            if (entrySlot !== slot || entry.handle === newHandle) continue;
            reg.delete(key);
            removed++;
            if (entry.gpuTexture) orphanedGpus.add(entry.gpuTexture);
        }

        if (removed > 0) {
            Logger.verbose(LogCategory.DDRAW,
                `purgeTextureRegistryForRecycledComSlot: removed ${removed} orphaned entries ` +
                `for slot=0x${slot.toString(16)} newHandle=0x${newHandle.toString(16)}`);
        }

        const gpuMgr = System.getInstance().gpuResourceManager;
        if (!gpuMgr) return;
        for (const gpu of orphanedGpus) {
            if (!this.isGpuTextureReferencedByRegistry(gpu)) {
                gpuMgr.enqueueForDestruction(gpu);
            }
        }
    }

    /**
     * Release VRAM when surface is destroyed
     */
    releaseVidMem(size: number): void {
        if (this.context) {
            this.context.usedVidMem = Math.max(0, this.context.usedVidMem - size);
            Logger.log(LogCategory.DDRAW, `DDraw: Released ${(size / 1024 / 1024).toFixed(2)} MB VRAM, total used: ${(this.context.usedVidMem / 1024 / 1024).toFixed(2)} MB`);
        }
    }

    deferSurfacePtrFree(ptr: number): void {
        const addr = ptr >>> 0;
        if (!addr || !this.context) return;
        this.context.deferredSurfacePtrFrees.push(addr);
        Logger.verbose(LogCategory.DDRAW,
            `DDraw: deferred surfacePtr free 0x${addr.toString(16)} (pending=${this.context.deferredSurfacePtrFrees.length})`);
    }

    flushDeferredSurfacePtrFrees(): void {
        if (!this.context) return;
        const pending = this.context.deferredSurfacePtrFrees;
        if (!pending.length) return;
        this.context.deferredSurfacePtrFrees = [];
        for (const ptr of pending) {
            try {
                this.process.memory.free(ptr);
                Logger.verbose(LogCategory.DDRAW, `DDraw: flushed deferred surfacePtr free 0x${ptr.toString(16)}`);
            } catch (e) {
                Logger.warn(LogCategory.DDRAW, `DDraw: deferred surfacePtr free failed 0x${ptr.toString(16)}: ${e}`);
            }
        }
    }

    reset(): void {
        // NOTE: thrashAutoPresenterUnregister is intentionally NOT called here.
        // The auto-presenter callback is registered once in initialize() and must survive
        // system.reset() → DDraw.reset() → loadPeData() flow. After reset, the callback
        // harmlessly returns early (primaryAddr=0, no lease) until the primary is initialized.
        // Unregistering here would leave frameCallbacks empty since initialize() is not
        // re-called after system.reset().

        if (this.context) {
            this.flushDeferredSurfacePtrFrees();
            freeExecuteBufferScratch(this.context.process.memory);

            // Reset primary/backbuffer surfaces
            this.context.surfaces.primary = 0;
            this.context.surfaces.backBuffer = 0;
            
            // Reset presenter
            this.context.presenter.reset();
            
            // Reset VRAM accounting
            this.context.usedVidMem = 0;
            
            // Reset texture handle registry (release GPU resources if needed)
            // Texture handles survive COM Release in DirectX, but on full reset
            // we should clean them up to prevent resource leaks
            if (this.context.textureHandles.size > 0) {
                Logger.log(LogCategory.DDRAW, 
                    `DDraw.reset: Cleaning up ${this.context.textureHandles.size} texture handles`
                );
                // Note: GPU resources will be cleaned up by deferred destruction in executor
                this.context.textureHandles.clear();
            }
            this.context.nextTextureHandle = this.context.defaults.nextTextureHandleStart;
            
            // Rebuild the GPU executor — pipeline/depth/texture caches are keyed for one
            // title's working set and must not survive an in-worker game switch.
            if (this.context.executor) {
                const backend = this.context.backend;
                try {
                    this.context.executor.destroy();
                } catch (e) {
                    Logger.warn(LogCategory.DDRAW, `DDraw.reset: executor.destroy failed: ${e}`);
                }
                this.context.executor = backend ? new DDrawWebGPUExecutor(backend) : undefined;
            }
            
            // Reset cooperative level
            this.context.cooperative.hwnd = 0;
            this.context.cooperative.flags = 0;
            this.context.cooperative.exclusive = false;

            this.context.deferredUploadManager.clear();
            this.context.ddraw7ObjectAddr = 0;
            this.context.gdiSurfaceVisible = true;
            this.context.suppressPresent = false;
            delete this.context.gammaRamp;
        }
        
        // Clear texture cache on reset
        this.bitmapToSurfaceCache.clear();
        Logger.log(LogCategory.DDRAW, 'DDraw.reset: Cleared bitmap texture cache and reset context state');
    }

    /**
     * Update display size from EmulatorConfig (e.g. after manifest apply).
     * Call after applyFromManifest so primary/createSurface use manifest screenResolution.
     */
    updateDisplayFromConfig(): void {
        if (!this.context) return;
        const cfg = EmulatorConfig.getInstance().screenResolution;
        this.context.display.width = cfg.width;
        this.context.display.height = cfg.height;
        this.context.display.bpp = cfg.bpp;
        this.context.display.refresh = cfg.refreshRate || 60;
        // Keep the desktop mode aligned with the (re)configured screen resolution; the
        // exclusive/restore baseline tracks the configured desktop, not a stale boot value.
        this.context.desktopMode.width = cfg.width;
        this.context.desktopMode.height = cfg.height;
        this.context.desktopMode.bpp = cfg.bpp;
        this.context.desktopMode.refresh = cfg.refreshRate || 60;
        Logger.log(
            LogCategory.DDRAW,
            `DDraw: display updated from config -> ${this.context.display.width}x${this.context.display.height} @ ${this.context.display.bpp}bpp ${this.context.display.refresh}Hz`
        );
        // Boot/manifest baseline — the desktop mode until a game sets its own.
        System.getInstance().requestHostResize(this.context.display.width, this.context.display.height, {
            modeSet: true, bpp: this.context.display.bpp, refreshRate: this.context.display.refresh,
        });
    }

    recreateVTables(): void {
        if (this.process) {
            this.vtables = createVTablesFromDescriptor(this.process, ddrawModule); if (this.context) { this.context.vtables = this.vtables; }
            Logger.verbose(LogCategory.SYSTEM, 'DirectDraw: Recreated vtables after reset');

            for (const [name, info] of Object.entries(this.vtables)) {
                Logger.verbose(LogCategory.SYSTEM, `DirectDraw: Recreated vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
            }
        }
    }

    private getMemory(): Uint8Array {
        return this.process.getCurrentMemory();
    }

    /**
     * Increment a frame counter
     */
    incrementFrameCounter(key: keyof NonNullable<FrameDebugSnapshot['frameCounters']>, amount: number = 1): void {
        if (this.frameSnapshot.frameCounters) {
            (this.frameSnapshot.frameCounters as any)[key] += amount;
        }
    }

    /**
     * Get frame debug snapshot (lastDraw/lastPresent) for debug panel
     */
    getFrameSnapshot(): FrameDebugSnapshot {
        return { ...this.frameSnapshot };
    }

    /**
     * Update frame snapshot on Present/Flip
     */
    updateFrameSnapshotOnPresent(surface: DirectDrawSurfaceState): void {
        this.frameSnapshot.presents++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastPresent = {
            surfaceAddr: surface.surfacePtr,
            width: surface.width,
            height: surface.height,
            format: `${surface.format.bpp}bpp`,
            timestamp: performance.now(),
        };
        
        // Reset frame counters for the next frame
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
    }

    /**
     * Update frame snapshot on DrawPrimitive
     */
    updateFrameSnapshotOnDraw(params: {
        textureHandle?: number;
        surfaceAddr?: number;
        numVerts?: number;
        fvf?: number;
        stride?: number;
        topology?: string;
        alphaBlend?: boolean;
        alphaTest?: boolean;
        zEnable?: boolean;
        zWrite?: boolean;
    }): void {
        this.frameSnapshot.drawCalls++;
        this.frameSnapshot.frameId = ++this.frameIdCounter;
        this.frameSnapshot.lastDraw = {
            api: "ddraw",
            ...params,
            timestamp: performance.now(),
        };
    }

    /**
     * Capture one frame of draw calls for analysis.
     * Returns a promise that resolves at the next Flip/Present.
     */
    captureNextFrame(): Promise<CapturedFrame> {
        return frameCaptureStart();
    }

    /**
     * Check bit15 statistics for an ARGB1555 surface — diagnostic for alpha stamping.
     * Accepts pixel data address and format directly (surfacePtr != COM object address).
     */
    checkBit15Stats(pixelPtr: number, width: number, height: number, pitch: number, bpp: number): {
        total: number; bit15set: number; bit15clear: number;
        blackWithBit15: number; blackWithoutBit15: number;
        sample: Array<{ x: number; y: number; raw: number; bit15: number; r: number; g: number; b: number }>;
    } | null {
        if (bpp !== 16 || !pixelPtr) return null;

        const mem = this.getMemory();
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const w = width;
        const h = height;
        const ptr = pixelPtr;

        let bit15set = 0, bit15clear = 0;
        let blackWithBit15 = 0, blackWithoutBit15 = 0;
        const sample: Array<{ x: number; y: number; raw: number; bit15: number; r: number; g: number; b: number }> = [];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const off = ptr + y * pitch + x * 2;
                if (off + 2 > mem.length) continue;
                const raw = view.getUint16(off, true);
                const a = (raw >> 15) & 1;
                const r5 = (raw >> 10) & 0x1F;
                const g5 = (raw >> 5) & 0x1F;
                const b5 = raw & 0x1F;
                if (a) bit15set++; else bit15clear++;
                const isBlack = (r5 === 0 && g5 === 0 && b5 === 0);
                if (isBlack && a) blackWithBit15++;
                if (isBlack && !a) blackWithoutBit15++;
                // Sample some interesting pixels (first 20 with bit15=0 that aren't pure 0x0000)
                if (!a && raw !== 0 && sample.length < 20) {
                    sample.push({ x, y, raw, bit15: a, r: r5, g: g5, b: b5 });
                }
            }
        }
        // Also sample a few opaque dark pixels (near-black with bit15=1)
        for (let y = 0; y < h && sample.length < 30; y++) {
            for (let x = 0; x < w && sample.length < 30; x++) {
                const off = ptr + y * pitch + x * 2;
                if (off + 2 > mem.length) continue;
                const raw = view.getUint16(off, true);
                const a = (raw >> 15) & 1;
                const r5 = (raw >> 10) & 0x1F;
                const g5 = (raw >> 5) & 0x1F;
                const b5 = raw & 0x1F;
                if (a && r5 + g5 + b5 <= 3 && sample.length < 30) {
                    sample.push({ x, y, raw, bit15: a, r: r5, g: g5, b: b5 });
                }
            }
        }
        return { total: w * h, bit15set, bit15clear, blackWithBit15, blackWithoutBit15, sample };
    }

    /**
     * Get debug info about all surfaces
     */
    getDebugSurfacesInfo(scope: "summary" | "full" = "summary", onlyActive: boolean = false): DDrawSurfaceDebugInfo[] {
        if (!this.context) return [];
        
        const surfaces: DDrawSurfaceDebugInfo[] = [];
        const resourceProvider = this.context.resourceProvider;
        const primaryAddr = this.context.surfaces.primary;
        const backBufferAddr = this.context.surfaces.backBuffer;
        
        // Iterate through all COM objects by address
        // Use getAllComObjects and find addresses via handleToAddress mapping
        const allComObjects = resourceProvider.getAllComObjects();
        
        for (const obj of allComObjects) {
            if (!(obj instanceof DirectDrawSurfaceObject)) continue;
            
            // Find address for this object's handle
            const handle = obj.handle;
            const address = resourceProvider.getAddressForHandle(handle);
            if (!address) continue;
            
            const state = obj.getState();
            
            // Determine role
            let role: "primary" | "backbuffer" | "z" | "texture" | "offscreen" | undefined;
            if (state.caps & DDSCAPS_PRIMARYSURFACE) {
                role = "primary";
            } else if (state.caps & DDSCAPS_BACKBUFFER) {
                role = "backbuffer";
            } else if (state.caps & DDSCAPS_TEXTURE) {
                role = "texture";
            } else if (state.caps & DDSCAPS_ZBUFFER) {
                role = "z";
            } else {
                role = "offscreen";
            }
            
            // Filter by scope
            if (scope === "summary") {
                // Only include primary, backbuffer, active textures
                if (role !== "primary" && role !== "backbuffer" && role !== "texture") {
                    continue;
                }
            }
            
            // Filter by onlyActive
            if (onlyActive) {
                const isActive = address === primaryAddr || 
                                address === backBufferAddr ||
                                (state.caps & DDSCAPS_TEXTURE) !== 0;
                if (!isActive) continue;
            }
            
            // Check if part of primary chain - traverse the chain in both directions
            let isPrimaryChain = false;
            
            // Direct check: is this primary or the registered backbuffer?
            if (address === primaryAddr || address === backBufferAddr) {
                isPrimaryChain = true;
            }
            
            // Traverse forward: follow attachedSurfaceAddr links
            if (!isPrimaryChain) {
                let currentAddr = address;
                const visited = new Set<number>();
                while (currentAddr && !visited.has(currentAddr)) {
                    visited.add(currentAddr);
                    // A released surface's slot can be reused by any COM object, so a
                    // stale attachedSurfaceAddr may resolve to a device / execute buffer —
                    // check the type instead of assuming (the backward walk below does too).
                    const currentObj = resourceProvider.getComObjectByAddress(currentAddr);
                    if (!(currentObj instanceof DirectDrawSurfaceObject)) break;
                    const currentState = currentObj.getState();
                    if (currentState.attachedSurfaceAddr === primaryAddr || currentState.attachedSurfaceAddr === backBufferAddr) {
                        isPrimaryChain = true;
                        break;
                    }
                    if (currentState.attachedSurfaceAddr === 0) break;
                    currentAddr = currentState.attachedSurfaceAddr;
                }
            }
            
            // Traverse backward: find surfaces that point to this one
            if (!isPrimaryChain) {
                for (const otherObj of allComObjects) {
                    if (otherObj instanceof DirectDrawSurfaceObject && otherObj !== obj) {
                        const otherState = otherObj.getState();
                        const otherAddr = resourceProvider.getAddressForHandle(otherObj.handle);
                        if (otherAddr && otherState.attachedSurfaceAddr === address) {
                            // Check if that other surface is in primary chain
                            if (otherAddr === primaryAddr || otherAddr === backBufferAddr) {
                                isPrimaryChain = true;
                                break;
                            }
                            // Recursively check if the other surface is in chain
                            let checkAddr = otherAddr;
                            const visited = new Set<number>();
                            while (checkAddr && !visited.has(checkAddr)) {
                                visited.add(checkAddr);
                                if (checkAddr === primaryAddr || checkAddr === backBufferAddr) {
                                    isPrimaryChain = true;
                                    break;
                                }
                                const checkObj = resourceProvider.getComObjectByAddress(checkAddr);
                                if (!(checkObj instanceof DirectDrawSurfaceObject)) break;
                                const checkState = checkObj.getState();
                                if (checkState.attachedSurfaceAddr === 0) break;
                                checkAddr = checkState.attachedSurfaceAddr;
                            }
                            if (isPrimaryChain) break;
                        }
                    }
                }
            }
            
            // Collect attached surfaces
            const attachedTo: number[] = [];
            if (state.attachedSurfaceAddr) {
                attachedTo.push(state.attachedSurfaceAddr);
            }
            
            surfaces.push({
                address,
                handle,
                width: state.width,
                height: state.height,
                pitch: state.pitch,
                format: state.format,
                caps: state.caps,
                caps2: state.caps2,
                surfacePtr: state.surfacePtr,
                attachedSurfaceAddr: state.attachedSurfaceAddr,
                // Debug info: Show authority/version for RenderSurface, special handling for BitmapTexture
                mode: isRenderSurface(state) ? state.mode : ("bitmap_texture" as any),
                version: isRenderSurface(state) ? state.version : 0,
                gpuDirty: isRenderSurface(state) ? state.gpuDirty : false,
                everLocked: isRenderSurface(state) ? state.everLocked : false,
                lastUploadVersion: isRenderSurface(state) ? state.lastUploadVersion : 0,
                gpuUpToDate: isRenderSurface(state) ? !state.gpuDirty : !isBitmapTexture(state) || !state.gpuNeedsUpload,
                hasGpuTexture: !!(state.gpuTexture && state.gpuTextureView),
                activeLeaseId: state.activeLeaseId,
                vidMemSize: state.vidMemSize,
                srcColorKey: state.srcColorKey,
                destColorKey: state.destColorKey,
                refCount: obj.refCount,
                role,
                attachedTo: attachedTo.length > 0 ? attachedTo : undefined,
                isPrimaryChain,
            });
        }
        
        return surfaces;
    }

    /**
     * Get surface preview (CPU snapshot) - reads pixels from memory
     * Returns base64 PNG data URL
     */
    async getSurfacePreview(surfaceAddr: number, maxSize: number = 512): Promise<{ data: string; width: number; height: number } | null> {
        if (!this.context) return null;
        
        const obj = surfaceAt(this.context.resourceProvider, surfaceAddr);
        if (!obj) return null;
        
        const state = obj.getState();
        if (!state.surfacePtr || state.width === 0 || state.height === 0) return null;
        
        // Downscale if needed
        let previewWidth = state.width;
        let previewHeight = state.height;
        const scale = Math.min(1, maxSize / Math.max(state.width, state.height));
        if (scale < 1) {
            previewWidth = Math.floor(state.width * scale);
            previewHeight = Math.floor(state.height * scale);
        }
        
        // Read pixels from memory — use fresh reference to avoid stale/detached buffer
        const mem = this.getMemory();
        const bytesPerPixel = Math.max(1, Math.floor(state.format.bpp / 8));
        const surfaceSize = state.pitch * state.height;
        // NOTE: surfacePtr maps directly to mem[] index — no byteOffset adjustment needed.
        const relSurfacePtr = state.surfacePtr;

        if (relSurfacePtr < 0 || relSurfacePtr + surfaceSize > mem.length) {
            return null;
        }
        
        // Create RGBA canvas
        const canvas = new OffscreenCanvas(previewWidth, previewHeight);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        
        const imageData = ctx.createImageData(previewWidth, previewHeight);
        const rgbaData = imageData.data;
        
        // Sample and convert pixels
        const stepX = state.width / previewWidth;
        const stepY = state.height / previewHeight;
        
        for (let py = 0; py < previewHeight; py++) {
            for (let px = 0; px < previewWidth; px++) {
                const srcX = Math.floor(px * stepX);
                const srcY = Math.floor(py * stepY);
                const srcOffset = relSurfacePtr + srcY * state.pitch + srcX * bytesPerPixel;
                
                if (srcOffset + bytesPerPixel > mem.length) continue;
                
                let r = 0, g = 0, b = 0, a = 255;
                
                if (bytesPerPixel === 2) {
                    // RGB565 or RGB555
                    const pixel = new DataView(mem.buffer, mem.byteOffset + srcOffset, 2).getUint16(0, true);
                    if (state.format.bpp === 16) {
                        if (state.format.rMask === 0xF800) {
                            // RGB565
                            r = ((pixel & 0xF800) >> 11) * 8;
                            g = ((pixel & 0x07E0) >> 5) * 4;
                            b = (pixel & 0x001F) * 8;
                        } else {
                            // RGB555
                            r = ((pixel & 0x7C00) >> 10) * 8;
                            g = ((pixel & 0x03E0) >> 5) * 8;
                            b = (pixel & 0x001F) * 8;
                        }
                    }
                } else if (bytesPerPixel === 4) {
                    // ARGB/XRGB
                    const pixel = new DataView(mem.buffer, mem.byteOffset + srcOffset, 4).getUint32(0, true);
                    r = (pixel & state.format.rMask) >> (state.format.rMask === 0xFF0000 ? 16 : 0);
                    g = (pixel & state.format.gMask) >> (state.format.gMask === 0xFF00 ? 8 : 0);
                    b = (pixel & state.format.bMask);
                    if (state.format.aMask) {
                        a = (pixel & state.format.aMask) >> (state.format.aMask === 0xFF000000 ? 24 : 0);
                    }
                }
                
                const dstIdx = (py * previewWidth + px) * 4;
                rgbaData[dstIdx] = r;
                rgbaData[dstIdx + 1] = g;
                rgbaData[dstIdx + 2] = b;
                rgbaData[dstIdx + 3] = a;
            }
        }
        
        ctx.putImageData(imageData, 0, 0);
        
        // Convert to base64
        try {
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    if (reader.result) {
                        resolve(reader.result as string);
                    } else {
                        reject(new Error('Failed to read blob'));
                    }
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            
            return {
                data: base64,
                width: previewWidth,
                height: previewHeight,
            };
        } catch (error) {
            Logger.warn(LogCategory.DDRAW, `getSurfacePreview failed: ${error}`);
            return null;
        }
    }

    /**
     * Get debug info about GPU textures from textureHandles registry
     */
    getGpuTexturesInfo(): Array<{
        handle: number;
        width: number;
        height: number;
        format: SurfaceFormat;
        surfaceAddress?: number;
    }> {
        if (!this.context) return [];
        
        const textures: Array<{
            handle: number;
            width: number;
            height: number;
            format: SurfaceFormat;
            surfaceAddress?: number;
        }> = [];
        
        // Iterate through textureHandles registry
        for (const [handle, entry] of this.context.textureHandles.entries()) {
            // Try to find associated surface
            let surfaceAddress: number | undefined;
            const allComObjects = this.context.resourceProvider.getAllComObjects();
            for (const obj of allComObjects) {
                if (obj instanceof DirectDrawSurfaceObject) {
                    const state = obj.getState();
                    if (state.gpuTexture === entry.gpuTexture) {
                        const addr = this.context.resourceProvider.getAddressForHandle(obj.handle);
                        if (addr) {
                            surfaceAddress = addr;
                            break;
                        }
                    }
                }
            }
            
            textures.push({
                handle,
                width: entry.width,
                height: entry.height,
                format: { ...entry.format, flags: entry.format.flags ?? 0 },
                surfaceAddress,
            });
        }
        
        return textures;
    }
}
