/**
 * Draw Handler - handles DrawPrimitive and DrawIndexedPrimitive calls
 * Optimized for D3D7 -> WebGPU HLE
 *
 * Matrix convention: D3D row-major (v * M) works directly with WGSL column-vector (M * v)
 * when using same memory layout - no transpose needed.
 */

import { Logger, LogCategory } from "../../../core/logger";
import { System } from "../../../core/system";
import { DDrawContext } from "../context";
import {
    DirectDrawSurfaceObject,
    DirectDrawSurfaceState,
    RenderSurface,
    Direct3DDevice3Object,
    Direct3DDevice7Object,
    Direct3DTextureObject,
    Direct3DTexture2Object,
    Direct3DViewport3Object,
} from "../com-objects";
import {
    D3DFVF_XYZ,
    D3DFVF_XYZRHW,
    D3DRENDERSTATE_ALPHABLENDENABLE,
    D3DRENDERSTATE_ALPHATESTENABLE,
    D3DRENDERSTATE_ZENABLE,
    D3DRENDERSTATE_ZWRITEENABLE,
    D3DPT_TRIANGLEFAN,
} from "../constants";
import {
    DrawHandler,
    TextureHandleEntry,
    TextureManager,
    EMPTY_RENDER_STATES,
    EMPTY_TEX_STATES,
} from "./types";
import { computeFvfStride } from "../../../backends/webgpu/ddraw/compute/vertex-converter";
import { drawCostProfiler, DC } from "../../../backends/webgpu/ddraw/draw-cost-profiler";
import * as frameCapture from "../frame-capture";
import { MAX_FFP_SAMPLED_STAGES } from "../../../backends/webgpu/ddraw/ffp-stages";

// Reusable per-draw stage-texture array (index = stage; stage 0 rides its own param).
// D3D7 titles drive at most stages 0..2; the executor supports up to MAX_FFP_SAMPLED_STAGES.
const stageTexturesScratch: (DirectDrawSurfaceState | null)[] =
    new Array(MAX_FFP_SAMPLED_STAGES).fill(null);

type MutableViewport = {
    x: number;
    y: number;
    width: number;
    height: number;
    minZ: number;
    maxZ: number;
};

const TOPOLOGY_MAP: Record<number, string> = {
    1: "pointlist",
    2: "linelist",
    3: "linestrip",
    4: "trianglelist",
    5: "trianglestrip",
    6: "trianglefan",
};

let cachedDefaultMvpWidth = -1;
let cachedDefaultMvpHeight = -1;
const cachedDefaultMvp = new Float32Array(16);

/**
 * Build default perspective projection matrix (D3D-style row-major).
 * Fallback when app gives no matrices for XYZ vertices.
 */
function writeDefaultPerspectiveMVP(width: number, height: number, out: Float32Array): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const aspect = w / h;

    const fov = 1.0; // radians
    const zn = 0.1;
    const zf = 100.0;
    const f = 1 / Math.tan(fov * 0.5);

    // Row-major D3D-like perspective projection (no transpose needed)
    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = zf / (zf - zn);
    out[11] = 1;
    out[12] = 0;
    out[13] = 0;
    out[14] = (-zn * zf) / (zf - zn);
    out[15] = 0;
}

function getDefaultPerspectiveMVP(width: number, height: number): Float32Array {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (cachedDefaultMvpWidth !== w || cachedDefaultMvpHeight !== h) {
        writeDefaultPerspectiveMVP(w, h, cachedDefaultMvp);
        cachedDefaultMvpWidth = w;
        cachedDefaultMvpHeight = h;
    }
    return cachedDefaultMvp;
}

function getStateFromTexOrSurface(
    resourceProvider: DDrawContext["resourceProvider"],
    obj: DirectDrawSurfaceObject | Direct3DTextureObject | Direct3DTexture2Object | null
): DirectDrawSurfaceState | null {
    if (!obj) return null;
    if (obj instanceof DirectDrawSurfaceObject) return obj.getState();
    if (obj instanceof Direct3DTexture2Object || obj instanceof Direct3DTextureObject) {
        const surfaceHandle = obj.getSurfaceHandle();
        if (!surfaceHandle) return null;
        const surfaceObj = resourceProvider.getComObject(surfaceHandle) as DirectDrawSurfaceObject | null;
        return surfaceObj ? surfaceObj.getState() : null;
    }
    return null;
}

function getOrCreateRegistrySurfaceState(entry: TextureHandleEntry): RenderSurface {
    const format = entry.format;
    const registryTextureFormat =
        entry.gpuTextureFormat ??
        ((entry.gpuTexture as unknown as { format?: GPUTextureFormat } | null)?.format);
    const existing =
        entry.surfaceState && entry.surfaceState.surfaceType === "render_surface"
            ? entry.surfaceState
            : null;
    if (existing) {
        existing.width = entry.width;
        existing.height = entry.height;
        existing.pitch = entry.pitch;
        existing.format.flags = format.flags ?? 0;
        existing.format.bpp = format.bpp;
        existing.format.rMask = format.rMask;
        existing.format.gMask = format.gMask;
        existing.format.bMask = format.bMask;
        existing.format.aMask = format.aMask;
        existing.gpuTexture = entry.gpuTexture ?? undefined;
        existing.gpuTextureView = entry.gpuTextureView ?? undefined;
        existing.gpuTextureFormat = registryTextureFormat ?? existing.gpuTextureFormat;
        existing.version = entry.version ?? 0;
        existing.lastUploadVersion = entry.version ?? -1;
        existing.srcColorKey = entry.srcColorKey;
        return existing;
    }

    const created: RenderSurface = {
        surfaceType: "render_surface",
        width: entry.width,
        height: entry.height,
        pitch: entry.pitch,
        caps: 0,
        surfacePtr: 0,
        format: {
            flags: format.flags ?? 0,
            bpp: format.bpp,
            rMask: format.rMask,
            gMask: format.gMask,
            bMask: format.bMask,
            aMask: format.aMask,
        },
        attachedSurfaceAddr: 0,
        gpuTexture: entry.gpuTexture ?? undefined,
        gpuTextureView: entry.gpuTextureView ?? undefined,
        gpuTextureFormat: registryTextureFormat,
        mode: "GPU_ONLY",
        version: entry.version ?? 0,
        gpuDirty: false,
        everLocked: false,
        lastUploadVersion: entry.version ?? -1,
        srcColorKey: entry.srcColorKey,
        writeGeneration: 0,
    };
    entry.surfaceState = created;
    return created;
}

export const createDrawHandler = (context: DDrawContext, textureManager: TextureManager): DrawHandler => {
    const resourceProvider = context.resourceProvider;
    const viewportScratch: MutableViewport = { x: 0, y: 0, width: 0, height: 0, minZ: 0, maxZ: 1 };
    // Reused per-draw texture-matrix list for the executor (index = stage). The D3D7
    // path threads only stage 0 today; stages 1-2 stay null. Zero-alloc hot path.
    const texMatricesScratch: (Float32Array | null)[] = [null, null, null];
    // Cache ddraw module reference to avoid System.getInstance().process?.getModule() on every draw
    let cachedDDrawModule: any = null;
    let cachedDDrawModuleResolved = false;
    const resolveTextureObject = (texHandle: number, preferAddressLookup: boolean): DirectDrawSurfaceObject | null => {
        if (!texHandle) return null;
        if (preferAddressLookup) {
            const byAddr = resourceProvider.getComObjectByAddress(texHandle) as DirectDrawSurfaceObject | null;
            if (byAddr) return byAddr;
        }
        const byHandle = resourceProvider.getComObject(texHandle) as DirectDrawSurfaceObject | null;
        if (byHandle) return byHandle;
        const addr = resourceProvider.getAddressForHandle(texHandle);
        if (!addr) return null;
        return resourceProvider.getComObjectByAddress(addr) as DirectDrawSurfaceObject | null;
    };

    const lookupRegistryTextureEntry = (texId: number): ReturnType<typeof context.textureHandles.get> => {
        const entry = context.textureHandles.get(texId);
        if (!entry) return undefined;
        const live = resourceProvider.getComObjectByAddress(texId) as DirectDrawSurfaceObject | null;
        if (live) {
            const liveGpu = live.getState().gpuTexture;
            if (liveGpu && entry.gpuTexture && liveGpu !== entry.gpuTexture) {
                context.textureHandles.delete(texId);
                return undefined;
            }
        }
        return entry;
    };

    const handleDrawPrimitive = (
        devicePtr: number,
        type: number,
        vtype: number,
        lpVertices: number,
        count: number,
        mem: Uint8Array,
        isIndexed = false,
        lpIndices = 0,
        iCount = 0
    ): void => {
        // Fast exit checks
        if (!context.executor || !lpVertices) return;
        if (isIndexed && !lpIndices) return;

        // Per-draw cost profiler — 'resolve' = all CPU work in this
        // handler before the executor draw call. Zero overhead unless drawCostEnable().
        const _tResolve = drawCostProfiler.now();

        const devObj = resourceProvider.getComObjectByAddress(devicePtr) as (Direct3DDevice3Object | Direct3DDevice7Object) | null;

        // Resolve Render Target
        const rtAddr = (devObj ? devObj.getRenderTarget() : 0) || context.surfaces.backBuffer || context.surfaces.primary;
        if (!rtAddr) return;

        const rtObj = resourceProvider.getComObjectByAddress(rtAddr) as DirectDrawSurfaceObject | null;
        if (!rtObj) return;
        const rtState = rtObj.getState();

        // Viewport resolution
        // Default to RT size, not display size (display might be wrong for windowed mode)
        viewportScratch.x = 0;
        viewportScratch.y = 0;
        viewportScratch.width = rtState.width;
        viewportScratch.height = rtState.height;
        viewportScratch.minZ = 0;
        viewportScratch.maxZ = 1;

        if (devObj) {
            // Try Device7 viewport first (SetViewport) - only Device7 has getViewportData
            if (devObj instanceof Direct3DDevice7Object) {
                const vpData = devObj.getViewportData();
                if (vpData && vpData.width > 0 && vpData.height > 0) {
                    viewportScratch.x = vpData.x;
                    viewportScratch.y = vpData.y;
                    viewportScratch.width = vpData.width;
                    viewportScratch.height = vpData.height;
                    viewportScratch.minZ = vpData.minZ;
                    viewportScratch.maxZ = vpData.maxZ;
                }
            }
            
            // Fallback to Device3 viewport (SetCurrentViewport) if Device7 viewport not set
            if (viewportScratch.width === rtState.width && viewportScratch.height === rtState.height) {
                const vpAddr = devObj.getCurrentViewport();
                if (vpAddr) {
                    const vpObj = resourceProvider.getComObjectByAddress(vpAddr) as Direct3DViewport3Object | null;
                    if (vpObj) {
                        const vp = vpObj.getViewport();
                        if (vp.width > 0 && vp.height > 0) {
                            viewportScratch.x = vp.x;
                            viewportScratch.y = vp.y;
                            viewportScratch.width = vp.width;
                            viewportScratch.height = vp.height;
                            // A D3DVIEWPORT's dvMinZ/dvMaxZ remap CLIP space (they reach the
                            // pipeline through the viewport's clip-space scale/bias); the
                            // rasterizer's own depth range stays 0..1, as ddraw's
                            // viewport_activate hardcodes.
                            viewportScratch.minZ = 0;
                            viewportScratch.maxZ = 1;
                        }
                    }
                }
            }
        }

        // --- Texture Resolution (Stage 0) ---
        let texHandle = devObj ? devObj.getTexture(0) : 0;
        let texObj: DirectDrawSurfaceObject | null = null;
        let texStateFromRegistry: DirectDrawSurfaceState | null = null;

        // Legacy DX3 fallback
        if (!texHandle && devObj) {
            const hTex = devObj.getRenderState(1); // D3DRENDERSTATE_TEXTUREHANDLE
            if (hTex) texHandle = hTex;
        }

        if (texHandle) {
            try {
                // Check Registry (created via CreateSurface)
                const handleEntry = lookupRegistryTextureEntry(texHandle);
                if (handleEntry) texStateFromRegistry = getOrCreateRegistrySurfaceState(handleEntry);

                // Check COM Object (Active Surface)
                // In DX7, SetTexture passes the surface ADDRESS, not a handle!
                // Try by address first (most common case), then by handle as fallback
                texObj = resolveTextureObject(texHandle, true);
            } catch (e) {
                Logger.error(LogCategory.DDRAW, `draw-handler: EXCEPTION in texture resolution: ${e}`);
            }
        }

        // --- Texture Resolution (Stage 1) ---
        let texHandle1 = devObj ? devObj.getTexture(1) : 0;
        let texObj1: DirectDrawSurfaceObject | null = null;
        let texStateFromRegistry1: DirectDrawSurfaceState | null = null;

        if (texHandle1) {
            const handleEntry1 = lookupRegistryTextureEntry(texHandle1);
            if (handleEntry1) texStateFromRegistry1 = getOrCreateRegistrySurfaceState(handleEntry1);
            texObj1 = resolveTextureObject(texHandle1, false);
        }

        // --- Texture Resolution (Stage 2) ---
        let texHandle2 = devObj ? devObj.getTexture(2) : 0;
        let texObj2: DirectDrawSurfaceObject | null = null;
        let texStateFromRegistry2: DirectDrawSurfaceState | null = null;

        if (texHandle2) {
            const handleEntry2 = lookupRegistryTextureEntry(texHandle2);
            if (handleEntry2) texStateFromRegistry2 = getOrCreateRegistrySurfaceState(handleEntry2);
            texObj2 = resolveTextureObject(texHandle2, false);
        }

        // --- MVP Matrix Calculation (CACHED) ---
        let mvpMatrix: Float32Array | undefined = undefined;
        const isXYZ = (vtype & D3DFVF_XYZ) !== 0 && (vtype & D3DFVF_XYZRHW) === 0;

        if (devObj && isXYZ) {
            // Use cached MVP - only recomputed when SetTransform is called
            const cached = devObj.getCachedMVP ? devObj.getCachedMVP() : null;
            if (cached) {
                mvpMatrix = cached;
            }
        }

        // --- Texture Matrix (Stage 0) ---
        const texMatrix0 = (devObj instanceof Direct3DDevice3Object)
            ? devObj.getTextureMatrix(0)
            : null;
        texMatricesScratch[0] = texMatrix0;
        const texMatrices = texMatrix0 ? texMatricesScratch : null;

        // Fallback MVP if missing (prevents vertex explosion)
        if (isXYZ && !mvpMatrix) {
            mvpMatrix = getDefaultPerspectiveMVP(viewportScratch.width || 640, viewportScratch.height || 480);
        }

        // --- Execution ---
        const renderStates = devObj ? devObj.getAllRenderStates() : EMPTY_RENDER_STATES;
        const texStates = devObj ? devObj.getAllTextureStageStates() : EMPTY_TEX_STATES;

        // Cull mode handled by executor (reads renderStates[D3DRENDERSTATE_CULLMODE] directly)

        // Resolve texture -> surface state. Texture objects (Direct3DTexture2Object) don't have getState();
        // they wrap a surface. Prefer registry state when we have both: it already has gpuTextureView from
        // registration; surface state may lack it until ensureSurfaceGPUResources runs, which can skip
        // (e.g. !width/!height) and leave hasTexture false for XYZRHW draws (UI quad).
        // Prefer live surface state when available so we keep a valid surfacePtr for CPU->GPU sync.
        // Registry snapshot lacks surfacePtr and would cause syncSurfaceFromMemory to be skipped.
        let texStateObj = getStateFromTexOrSurface(resourceProvider, texObj as DirectDrawSurfaceObject | Direct3DTextureObject | Direct3DTexture2Object | null) ?? texStateFromRegistry;
        if (texStateObj && texStateFromRegistry && texStateObj !== texStateFromRegistry) {
            // If surface state exists but GPU view is missing, borrow from registry snapshot.
            if (!texStateObj.gpuTextureView && texStateFromRegistry.gpuTextureView) {
                texStateObj.gpuTexture = texStateFromRegistry.gpuTexture ?? texStateObj.gpuTexture;
                texStateObj.gpuTextureView = texStateFromRegistry.gpuTextureView ?? texStateObj.gpuTextureView;
            }
            if (!texStateObj.gpuTextureFormat && texStateFromRegistry.gpuTextureFormat) {
                texStateObj.gpuTextureFormat = texStateFromRegistry.gpuTextureFormat;
            }
            if (!texStateObj.srcColorKey && texStateFromRegistry.srcColorKey) {
                texStateObj.srcColorKey = texStateFromRegistry.srcColorKey;
            }
        }
        const isRHW = (vtype & 0x0004) !== 0;
        if (!texStateObj && texHandle) {
            const resolved = textureManager.resolve(texHandle);
            if (resolved.obj instanceof DirectDrawSurfaceObject) {
                texStateObj = resolved.obj.getState();
            } else if (resolved.textureHandleEntry) {
                texStateObj = getOrCreateRegistrySurfaceState(resolved.textureHandleEntry);
            }
        }
        // SetTexture(0, NULL) means "no texture" — prepareDraw's DIFFUSE fallback
        // supplies vertex color. Do not rebind a previous texture for untextured
        // XYZRHW draws (D3DTSS_COLORARG1 defaults to D3DTA_TEXTURE).
        let texStateObj1 = getStateFromTexOrSurface(resourceProvider, texObj1 as DirectDrawSurfaceObject | Direct3DTextureObject | Direct3DTexture2Object | null) ?? texStateFromRegistry1;
        if (texStateObj1 && texStateFromRegistry1 && texStateObj1 !== texStateFromRegistry1) {
            if (!texStateObj1.gpuTextureView && texStateFromRegistry1.gpuTextureView) {
                texStateObj1.gpuTexture = texStateFromRegistry1.gpuTexture ?? texStateObj1.gpuTexture;
                texStateObj1.gpuTextureView = texStateFromRegistry1.gpuTextureView ?? texStateObj1.gpuTextureView;
            }
            if (!texStateObj1.gpuTextureFormat && texStateFromRegistry1.gpuTextureFormat) {
                texStateObj1.gpuTextureFormat = texStateFromRegistry1.gpuTextureFormat;
            }
            if (!texStateObj1.srcColorKey && texStateFromRegistry1.srcColorKey) {
                texStateObj1.srcColorKey = texStateFromRegistry1.srcColorKey;
            }
        }
        if (!texStateObj1 && texHandle1) {
            const resolved1 = textureManager.resolve(texHandle1);
            if (resolved1.obj instanceof DirectDrawSurfaceObject) {
                texStateObj1 = resolved1.obj.getState();
            } else if (resolved1.textureHandleEntry) {
                texStateObj1 = getOrCreateRegistrySurfaceState(resolved1.textureHandleEntry);
            }
        }
        let texStateObj2 = getStateFromTexOrSurface(resourceProvider, texObj2 as DirectDrawSurfaceObject | Direct3DTextureObject | Direct3DTexture2Object | null) ?? texStateFromRegistry2;
        if (texStateObj2 && texStateFromRegistry2 && texStateObj2 !== texStateFromRegistry2) {
            if (!texStateObj2.gpuTextureView && texStateFromRegistry2.gpuTextureView) {
                texStateObj2.gpuTexture = texStateFromRegistry2.gpuTexture ?? texStateObj2.gpuTexture;
                texStateObj2.gpuTextureView = texStateFromRegistry2.gpuTextureView ?? texStateObj2.gpuTextureView;
            }
            if (!texStateObj2.gpuTextureFormat && texStateFromRegistry2.gpuTextureFormat) {
                texStateObj2.gpuTextureFormat = texStateFromRegistry2.gpuTextureFormat;
            }
            if (!texStateObj2.srcColorKey && texStateFromRegistry2.srcColorKey) {
                texStateObj2.srcColorKey = texStateFromRegistry2.srcColorKey;
            }
        }
        if (!texStateObj2 && texHandle2) {
            const resolved2 = textureManager.resolve(texHandle2);
            if (resolved2.obj instanceof DirectDrawSurfaceObject) {
                texStateObj2 = resolved2.obj.getState();
            } else if (resolved2.textureHandleEntry) {
                texStateObj2 = getOrCreateRegistrySurfaceState(resolved2.textureHandleEntry);
            }
        }

        stageTexturesScratch.fill(null);
        stageTexturesScratch[1] = texStateObj1 ?? null;
        stageTexturesScratch[2] = texStateObj2 ?? null;

        // Opt-in per-draw dump: set globalThis.__vtxDiagEnabled = true in dbg console.
        const vtxDiagEnabled = (globalThis as any).__vtxDiagEnabled === true;
        const vtxN = vtxDiagEnabled ? (((globalThis as any)._vtxDiagN ?? 0) + 1) : 0;
        if (vtxDiagEnabled) (globalThis as any)._vtxDiagN = vtxN;
        if (vtxDiagEnabled && (vtxN <= 40 || vtxN % 200 === 0)) {
            const stride = computeFvfStride(vtype);
            const hasDiffuse = (vtype & 0x40) !== 0; // D3DFVF_DIFFUSE
            let diffHex = "none";
            if (hasDiffuse && lpVertices > 0 && stride > 0 && count > 0) {
                const isRHW_ = (vtype & 0x4) !== 0;
                const hasNormal_ = (vtype & 0x10) !== 0;
                let posBytes = isRHW_ ? 16 : 12;
                if (hasNormal_ && !isRHW_) posBytes += 12;
                const diffOff = lpVertices + posBytes;
                if (diffOff + 4 <= mem.length) {
                    const d0 = mem[diffOff], d1 = mem[diffOff + 1], d2 = mem[diffOff + 2], d3 = mem[diffOff + 3];
                    const argb = (d3 << 24) | (d2 << 16) | (d1 << 8) | d0;
                    diffHex = `0x${(argb >>> 0).toString(16).padStart(8, "0")} [B=${d0} G=${d1} R=${d2} A=${d3}]`;
                }
            }
            const texFactor = renderStates[35] ?? 0xffffffff;
            const lighting = renderStates[137] ?? 1; // D3DRS_LIGHTING (default TRUE)
            const ambient = renderStates[139] ?? 0;
            const diffMatSrc = renderStates[145] ?? 0; // 0=MATERIAL (default), 1=COLOR1, 2=COLOR2
            const colorOp = texStates[1] ?? 0;
            const colorArg1 = texStates[2] ?? 0;
            const colorArg2 = texStates[3] ?? 0;
            const alphaOp = texStates[4] ?? 0;
            const alphaArg1 = texStates[5] ?? 0;
            const alphaArg2 = texStates[6] ?? 0;
            const texSurf = texStateObj ? `0x${texStateObj.surfacePtr?.toString(16)}` : "none";
            const pfFlags = texStateObj?.format?.flags ?? 0;
            const mat = (devObj as any)?.getMaterial?.();
            const matStr = mat
                ? `diff=(${mat.diffuse.r.toFixed(2)},${mat.diffuse.g.toFixed(2)},${mat.diffuse.b.toFixed(2)},${mat.diffuse.a.toFixed(2)}) ` +
                  `amb=(${mat.ambient.r.toFixed(2)},${mat.ambient.g.toFixed(2)},${mat.ambient.b.toFixed(2)},${mat.ambient.a.toFixed(2)}) ` +
                  `emiss=(${mat.emissive.r.toFixed(2)},${mat.emissive.g.toFixed(2)},${mat.emissive.b.toFixed(2)},${mat.emissive.a.toFixed(2)})`
                : "<no material>";

            // Bounding box over first min(4, count) vertices. For XYZRHW this is
            // screen space; for XYZ it's pre-MVP model space. Also capture UV range
            // so we can detect collapsed/wrong sampling (uniform-coloured output).
            const isRHW_ = (vtype & 0x4) !== 0;
            const hasNormal_ = (vtype & 0x10) !== 0;
            const hasDiffuse_ = (vtype & 0x40) !== 0;
            const hasSpecular_ = (vtype & 0x80) !== 0;
            const hasTex_ = ((vtype & 0xf00) >> 8) >= 1;
            let uvOffset = isRHW_ ? 16 : 12;
            if (hasNormal_ && !isRHW_) uvOffset += 12;
            if (hasDiffuse_) uvOffset += 4;
            if (hasSpecular_) uvOffset += 4;
            let bbox = "<na>";
            let uvBbox = "<na>";
            const texSize = texStateObj ? `${texStateObj.width}x${texStateObj.height}` : "?";
            const texFmt = (texStateObj as any)?.gpuTextureFormat ?? "?";
            if (lpVertices > 0 && stride > 0 && count > 0) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                let minZ = Infinity, maxZ = -Infinity;
                let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
                const vN = Math.min(4, count);
                for (let i = 0; i < vN; i++) {
                    const off = lpVertices + i * stride;
                    if (off + 12 > mem.length) break;
                    const x = view.getFloat32(off + 0, true);
                    const y = view.getFloat32(off + 4, true);
                    const z = view.getFloat32(off + 8, true);
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                    if (hasTex_ && off + uvOffset + 8 <= mem.length) {
                        const u = view.getFloat32(off + uvOffset, true);
                        const v = view.getFloat32(off + uvOffset + 4, true);
                        if (u < minU) minU = u; if (u > maxU) maxU = u;
                        if (v < minV) minV = v; if (v > maxV) maxV = v;
                    }
                }
                bbox = `x=[${minX.toFixed(1)}..${maxX.toFixed(1)}] y=[${minY.toFixed(1)}..${maxY.toFixed(1)}] z=[${minZ.toFixed(2)}..${maxZ.toFixed(2)}]`;
                uvBbox = hasTex_ && minU !== Infinity
                    ? `u=[${minU.toFixed(3)}..${maxU.toFixed(3)}] v=[${minV.toFixed(3)}..${maxV.toFixed(3)}]`
                    : "<no-tex>";
            }

            const abEnable = renderStates[27] ?? 0;
            const srcBlend = renderStates[19] ?? 0;
            const dstBlend = renderStates[20] ?? 0;

            // Full per-vertex dump for first few draws (to spot mis-strided / corrupted
            // vertex positions that produce triangular artifacts on the final frame).
            let verts = "";
            if (vtxN <= 10 && lpVertices > 0 && stride > 0 && count > 0) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const vN = Math.min(4, count);
                const lines: string[] = [];
                for (let i = 0; i < vN; i++) {
                    const off = lpVertices + i * stride;
                    if (off + stride > mem.length) break;
                    const x = view.getFloat32(off + 0, true);
                    const y = view.getFloat32(off + 4, true);
                    const z = view.getFloat32(off + 8, true);
                    let u = 0, v = 0;
                    if (hasTex_ && off + uvOffset + 8 <= mem.length) {
                        u = view.getFloat32(off + uvOffset, true);
                        v = view.getFloat32(off + uvOffset + 4, true);
                    }
                    lines.push(`v${i}=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(2)}|uv=${u.toFixed(3)},${v.toFixed(3)})`);
                }
                verts = ` verts=[${lines.join(" ")}]`;

                // Also dump first 12 indices if indexed
                if (isIndexed && lpIndices > 0 && iCount > 0) {
                    const iN = Math.min(12, iCount);
                    const ix: number[] = [];
                    for (let i = 0; i < iN; i++) {
                        const off = lpIndices + i * 2;
                        if (off + 2 > mem.length) break;
                        ix.push(view.getUint16(off, true));
                    }
                    verts += ` idx=[${ix.join(",")}${iCount > iN ? "..." : ""}] iCount=${iCount}`;
                }
            }

            Logger.log(LogCategory.DDRAW,
                `[VTX-DIAG #${vtxN}] fvf=0x${vtype.toString(16)} count=${count} ${isRHW_ ? "RHW" : "XYZ"} tex=${texSurf} (${texSize}, ${texFmt}) pfFlags=0x${pfFlags.toString(16)} ` +
                `diffuse0=${diffHex} TFACTOR=0x${(texFactor >>> 0).toString(16)} ` +
                `LIGHTING=${lighting} AMBIENT=0x${(ambient >>> 0).toString(16)} DIFFMATSRC=${diffMatSrc} ` +
                `AB=${abEnable} src=${srcBlend} dst=${dstBlend} ` +
                `mat{${matStr}} ` +
                `bbox{${bbox}} ` +
                `uv{${uvBbox}} ` +
                `stage0: COLOROP=${colorOp} CARG1=0x${colorArg1.toString(16)} CARG2=0x${colorArg2.toString(16)} ` +
                `ALPHAOP=${alphaOp} AARG1=0x${alphaArg1.toString(16)} AARG2=0x${alphaArg2.toString(16)}` +
                verts);
        }
        drawCostProfiler.add(DC.resolve, _tResolve);

        if (isIndexed) {
            context.executor.drawIndexedPrimitive(
                rtState,
                type,
                vtype,
                lpVertices,
                count,
                lpIndices,
                iCount,
                mem,
                viewportScratch,
                texStateObj,
                renderStates,
                texStates,
                mvpMatrix,
                stageTexturesScratch,
                texMatrices,
                0,
                devObj?.getFFPLightingState() ?? undefined
            );
        } else {
            context.executor.drawPrimitive(
                rtState,
                type,
                vtype,
                lpVertices,
                count,
                mem,
                viewportScratch,
                texStateObj,
                renderStates,
                texStates,
                mvpMatrix,
                stageTexturesScratch,
                texMatrices,
                devObj?.getFFPLightingState() ?? undefined
            );
        }

        // 'tail' = post-draw bookkeeping in this handler (VTX-DIAG ran in 'resolve'; this
        // covers frame-capture + per-draw snapshot update, which fire on every draw).
        const _tTail = drawCostProfiler.now();

        // Frame capture (zero overhead when off)
        if (frameCapture.isCapturing()) {
            frameCapture.recordDrawCall({
                primitiveType: type, vertexType: vtype,
                lpVertices: lpVertices, count, lpIndices, iCount,
                mem, isIndexed,
                rtState,
                texStateObj: texStateObj ?? null,
                texStateObj1: texStateObj1 ?? null,
                stageTextures: stageTexturesScratch,
                renderStates,
                texStates,
                sourceStride: computeFvfStride(vtype),
                mvp: mvpMatrix ?? null,
                viewport: viewportScratch,
                lighting: devObj?.getFFPLightingState() ?? null,
                executionDiagnostics: context.executor.getLastDrawDiagnostics(),
            });
        }

        // Debug Snapshot Update (cached ddraw module reference)
        if (!cachedDDrawModuleResolved) {
            cachedDDrawModuleResolved = true;
            cachedDDrawModule = System.getInstance().process?.getModule("ddraw") as any;
        }
        if (cachedDDrawModule?.updateFrameSnapshotOnDraw) {
            cachedDDrawModule.updateFrameSnapshotOnDraw({
                textureHandle: texHandle,
                surfaceAddr: rtAddr,
                numVerts: count,
                fvf: vtype,
                stride: computeFvfStride(vtype),
                topology: TOPOLOGY_MAP[type] || "unknown",
                alphaBlend: renderStates[D3DRENDERSTATE_ALPHABLENDENABLE] !== 0,
                alphaTest: renderStates[D3DRENDERSTATE_ALPHATESTENABLE] !== 0,
                zEnable: renderStates[D3DRENDERSTATE_ZENABLE] !== 0,
                zWrite: renderStates[D3DRENDERSTATE_ZWRITEENABLE] !== 0,
            });
        }
        drawCostProfiler.add(DC.tail, _tTail);
    };

    return { handleDrawPrimitive };
};
