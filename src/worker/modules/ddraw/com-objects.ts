import { Logger, LogCategory } from "../../core/logger";
import { BaseComObject } from "../../core/com/base-com-object";
import { System } from "../../core/system";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { leaseRegistry } from "../../core/memory/lease-registry";
import { runSurfaceTeardownHooks } from "./surface-teardown";
import {
    IID_IDirect3D,
    IID_IDirect3D2,
    IID_IDirect3D3,
    IID_IDirect3D7,
    IID_IDirect3DDevice,
    IID_IDirect3DDevice2,
    IID_IDirect3DExecuteBuffer,
    IID_IDirect3DDevice3,
    IID_IDirect3DDevice3V5,
    IID_IDirect3DDevice7,
    IID_IDirect3DTexture,
    IID_IDirect3DTexture2,
    IID_IDirect3DViewport,
    IID_IDirect3DViewport2,
    IID_IDirect3DViewport3,
    IID_IDirectDrawSurface,
    IID_IDirectDrawSurface2,
    IID_IDirectDrawSurface3,
    IID_IDirectDrawSurface4,
    IID_IDirectDrawSurface7,
    IID_IDirectDrawGammaControl,
    IID_IDirect3DLight,
    IID_IDirect3DMaterial3,
    IID_IDirect3DVertexBuffer,
    D3DRENDERSTATE_LIGHTING,
    D3DRENDERSTATE_AMBIENT,
    D3DRENDERSTATE_DIFFUSEMATERIALSOURCE,
    D3DRENDERSTATE_AMBIENTMATERIALSOURCE,
    D3DRENDERSTATE_SPECULARMATERIALSOURCE,
    D3DRENDERSTATE_EMISSIVEMATERIALSOURCE,
    D3DRENDERSTATE_TEXTUREMAPBLEND,
} from "./constants";
import { FFPLightingSource, FFPLightingState } from "./d3d/ffp-lighting";
import { D3DTSS_ADDRESS, D3DTSS_ADDRESSU, D3DTSS_ADDRESSV } from "./d3d/sampler-constants";
import {
    isLegacyTextureSamplerRenderState,
    translateLegacyTextureSamplerState,
} from "./d3d/legacy-sampler-state";
import { RGBA } from "../../backends/webgpu/ddraw/types";
import {
    EMPTY_RENDER_STATES,
    EMPTY_TEX_STATES,
    D3DMaterial7Data,
    D3DLight7Data,
    D3DStateBlock,
    createDefaultMaterial,
    createDefaultLight,
} from "./d3d/types";
import {
    D3DTSS_COLOROP, D3DTSS_COLORARG1, D3DTSS_COLORARG2,
    D3DTSS_ALPHAOP, D3DTSS_ALPHAARG1, D3DTSS_ALPHAARG2,
} from "./constants";
import type { Rect } from "./helpers";

export { DirectDrawObject, DirectDrawClipperObject, DirectDrawPaletteObject } from "./com-objects-ddraw";

// D3D texture argument / operation constants (stable D3D enum values)
const D3DTA_TEXTURE = 2;
const D3DTA_DIFFUSE = 0;
const D3DTOP_SELECTARG1 = 2;
const D3DTOP_MODULATE = 4;
const D3DTOP_BLENDTEXTUREALPHA = 13; // real D3DTEXTUREOP value (see ddraw/constants.ts)

/**
 * Translate legacy D3DRENDERSTATE_TEXTUREMAPBLEND (state 21) into texture stage state writes.
 * Lives here so ALL paths (slow thunk, fast path, WBUF drain) get the translation automatically.
 */
function translateTexMapBlend(tss: Int32Array, value: number): void {
    switch (value) {
        case 1: // D3DTBLEND_DECAL
            tss[0 * 32 + D3DTSS_COLOROP] = D3DTOP_SELECTARG1;
            tss[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
            tss[0 * 32 + D3DTSS_ALPHAOP] = D3DTOP_SELECTARG1;
            tss[0 * 32 + D3DTSS_ALPHAARG1] = D3DTA_TEXTURE;
            break;
        case 2: // D3DTBLEND_MODULATE
            tss[0 * 32 + D3DTSS_COLOROP] = D3DTOP_MODULATE;
            tss[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
            tss[0 * 32 + D3DTSS_COLORARG2] = D3DTA_DIFFUSE;
            tss[0 * 32 + D3DTSS_ALPHAOP] = D3DTOP_SELECTARG1;
            tss[0 * 32 + D3DTSS_ALPHAARG1] = D3DTA_TEXTURE;
            break;
        case 3: // D3DTBLEND_DECALALPHA
            tss[0 * 32 + D3DTSS_COLOROP] = D3DTOP_BLENDTEXTUREALPHA;
            tss[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
            tss[0 * 32 + D3DTSS_COLORARG2] = D3DTA_DIFFUSE;
            tss[0 * 32 + D3DTSS_ALPHAOP] = D3DTOP_SELECTARG1;
            tss[0 * 32 + D3DTSS_ALPHAARG1] = D3DTA_TEXTURE;
            break;
        case 4: // D3DTBLEND_MODULATEALPHA
            tss[0 * 32 + D3DTSS_COLOROP] = D3DTOP_MODULATE;
            tss[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
            tss[0 * 32 + D3DTSS_COLORARG2] = D3DTA_DIFFUSE;
            tss[0 * 32 + D3DTSS_ALPHAOP] = D3DTOP_MODULATE;
            tss[0 * 32 + D3DTSS_ALPHAARG1] = D3DTA_TEXTURE;
            tss[0 * 32 + D3DTSS_ALPHAARG2] = D3DTA_DIFFUSE;
            break;
        case 5: // D3DTBLEND_COPY
            tss[0 * 32 + D3DTSS_COLOROP] = D3DTOP_SELECTARG1;
            tss[0 * 32 + D3DTSS_COLORARG1] = D3DTA_TEXTURE;
            tss[0 * 32 + D3DTSS_ALPHAOP] = D3DTOP_SELECTARG1;
            tss[0 * 32 + D3DTSS_ALPHAARG1] = D3DTA_TEXTURE;
            break;
    }
}

export type SurfaceFormat = {
    flags: number;
    fourCC?: number;
    bpp: number;
    rMask: number;
    gMask: number;
    bMask: number;
    aMask: number;
    /** DDPF_ZBUFFER surfaces only: the raw dwZBitMask / dwStencilBitMask the app declared.
     *  They alias gMask/bMask in DDPIXELFORMAT, but those go through RGB fallbacks that
     *  would corrupt a depth value, so the depth interpretation reads these instead. */
    zBitMask?: number;
    stencilBitMask?: number;
};

/** Device-held COM reference swap: AddRef the incoming object, Release the one it
 *  replaces. Devices cache guest addresses (parent D3, current viewport); the real
 *  device holds a reference on each, so a compliant guest Release can never free
 *  an object the device still points at. */
function swapDeviceComRef(oldAddr: number, newAddr: number): void {
    if (oldAddr === newAddr) return;
    const rp = SystemResourceProvider.getInstance();
    if (newAddr) rp.getComObjectByAddress(newAddr)?.addRef();
    if (oldAddr) rp.getComObjectByAddress(oldAddr)?.release();
}

// ============================================================================
// SURFACE TYPE SYSTEM - Big Bang Architectural Refactor
// ============================================================================

/**
 * Shared base interface for all surface types.
 * Contains fields common to both immutable bitmap textures and mutable render surfaces.
 */
export interface BaseSurfaceState {
    width: number;
    height: number;
    pitch: number;
    caps: number;              // DDSCAPS2.dwCaps (first 4 bytes)
    caps2?: number;            // DDSCAPS2.dwCaps2 (DX7+ extensions)
    caps3?: number;            // DDSCAPS2.dwCaps3 (DX7+ extensions)
    caps4?: number;            // DDSCAPS2.dwCaps4 / dwVolumeDepth (union)
    surfacePtr: number;
    format: SurfaceFormat;
    /** The FLIP-CHAIN link: the successor in the attachment ring a Flip rotates around.
     *  DirectDraw keeps a LIST of attachments, so this is only the chain member; a depth
     *  buffer or mip level attached to the same surface goes in `attachedSurfaceAddrs`
     *  and must never overwrite this, or Flip loses its target. */
    attachedSurfaceAddr: number;
    /** Every surface attached to this one (the flip link included), in attach order —
     *  what GetAttachedSurface/EnumAttachedSurfaces enumerate. */
    attachedSurfaceAddrs?: number[];
    /** Created BY DirectDraw as part of a complex surface (flip-chain back buffer, mip
     *  sublevel) rather than handed to AddAttachedSurface by the app. DirectDraw owns these:
     *  they carry no attachment reference, they die with the root, and DeleteAttachedSurface
     *  refuses them with DDERR_CANNOTDETACHSURFACE. */
    implicitChainMember?: boolean;
    /** The surface this one is attached to and holds ONE reference for — the reference
     *  AddAttachedSurface takes, dropped by DeleteAttachedSurface or by the owner's
     *  destruction. DirectDraw keeps exactly one such slot per surface, so an already-attached
     *  surface never takes a second reference. 0/undefined = holds none. */
    attachRefOwner?: number;
    /** DDSCAPS_ZBUFFER surfaces only: guest addresses of the render targets this depth
     *  buffer was attached to. Our depth attachments are keyed by render target, so a
     *  DDBLT_DEPTHFILL aimed at the z surface has to be resolved back to them. */
    zOwnerSurfaces?: number[];
    gpuTexture?: GPUTexture;
    /** Single-mip (level 0) view — used for render attachments, clears, uploads, and sampling
     *  when there is no mip chain. */
    gpuTextureView?: GPUTextureView;
    /** Mip level count of gpuTexture (1 = no chain). >1 → the all-mips sample view is derived
     *  from gpuTexture on demand (auto-mipmap). */
    gpuMipLevels?: number;
    /** Color format of gpuTexture (for clear pipeline selection). Set when texture is created. */
    gpuTextureFormat?: GPUTextureFormat;
    /** RGB565 source texture in r16uint format (for GPU-based conversion) */
    gpuTextureRGB565?: GPUTexture;
    gpuTextureRGB565View?: GPUTextureView;
    rgbaPaddedScratch?: Uint8Array; // Reused buffer for row-aligned padding inside uploadToGPUTexture
    surfacePtrAllocated?: boolean; // Flag to track if surfacePtr was allocated via process.memory.alloc()
    vidMemSize?: number; // Size of VRAM allocated for this surface
    activeLeaseId?: number; // Active memory lease ID (for Lock/Unlock tracking)
    activeLeaseSnapshot?: Uint8Array; // Exact pre-Lock bytes for faithful dirty detection
    activeLeaseSnapshotBase?: number;
    activeLeaseSnapshotSize?: number;
    srcColorKey?: { low: number; high: number }; // Source colorkey for Blt operations (DDCKEY_SRCBLT)
    destColorKey?: { low: number; high: number }; // Destination colorkey for Blt operations (DDCKEY_DESTBLT)
    mipMapCount?: number;      // Number of mipmap levels (for textures with mipmaps)
    /** For a mipmap-chain ROOT: the attached sublevel surface states in order (level 1, 2, ...).
     *  Lets the backend upload the game's AUTHORED mip pixels into the base texture's GPU mip slots
     *  (the executor has no attached-surface resolver). Set by CreateSurface's mip loop. */
    mipSublevels?: DirectDrawSurfaceState[];
    textureStage?: number;     // Texture stage index (for multi-texture rendering)
    alphaBitDepth?: number;    // Alpha bit depth (usually redundant with pixel format)
    paletteHandle?: number;    // Handle of attached IDirectDrawPalette
    clipperHandle?: number;    // Handle of attached IDirectDrawClipper
    lastPaletteVersion?: number; // Last palette version used for this surface (for optimization)
    needsColorClear?: boolean; // True if Clear was called with D3DCLEAR_TARGET - use loadOp: "clear" in next render pass
    clearColor?: number;       // Color value from last Clear call (ARGB format)
    /** Devices that have this surface bound as texture. Used for unbindFromDevices() cleanup.
     * Key format: "deviceHandle:stage" (e.g., "0x1234:0")
     */
    boundByDevices?: Map<string, { deviceHandle: number; stage: number }>; // Map of "deviceHandle:stage" -> {deviceHandle, stage}
    /** True if surface memory has ever been written to (for deferred Load detection).
     * Set when memory watch detects writes, or when Lock/Unlock/Blt operations occur.
     */
    surfaceEverWritten?: boolean;
    /** Fingerprint of last loaded source texture content (for Load() skip optimization).
     * 8 uint32 samples from specific positions across the source surface.
     */
    lastLoadFingerprint?: Uint32Array;
    /** Packed source dimensions of last loaded texture (width<<16|height). */
    lastLoadSrcDimensions?: number;
    /** Monotonic write generation counter. Incremented on every non-readonly Unlock.
     * Used by Load() dedup to detect when SYSMEM surface content has changed. */
    writeGeneration: number;
    /** Source writeGeneration at the time of the last successful Load() copy.
     * If current source writeGeneration matches, the copy can be skipped. */
    lastLoadSourceGeneration?: number;
    /** surfacePtr of the source used in last Load() (for multi-source invalidation). */
    lastLoadSourcePtr?: number;
    /** GUID-keyed application data attached with SetPrivateData. Per-surface and
     *  opaque to us: engines round-trip their own bookkeeping (source image size,
     *  mip level, wrapper object) through it, so dropping it silently corrupts
     *  whatever they read back. Freed with the surface. */
    privateData?: Map<string, PrivateDataEntry>;

    /** Executor bookkeeping for the copy→draw→copy→draw hazard: the encoderEpoch of the
     *  command buffer that last recorded a draw sampling this surface, and the content
     *  version those draws were recorded against. A guest that rewrites a texture between
     *  draws would otherwise have every draw in the buffer sample the LAST upload, because
     *  queue.writeTexture runs ahead of the single submit. See
     *  DDrawWebGPUExecutor.encoderEpoch / prepareStageTexture. */
    sampledEncoderEpoch?: number;
    sampledContentVersion?: number;

    /** Set when a device loss took the surface's ONLY copy (a GPU_ONLY render target); cleared
     *  by Restore()/RestoreAllSurfaces(). Lives here rather than in an address-keyed table
     *  because COM blocks are recycled — see gpu-device-loss-contract.ts. */
    surfaceLost?: boolean;
}

/** One SetPrivateData entry: either a byte blob or a (ref-counted) IUnknown pointer. */
export interface PrivateDataEntry {
    /** dwSize as the app set it — GetPrivateData reports exactly this. */
    size: number;
    /** Blob payload (absent for DDSPD_IUNKNOWNPOINTER entries). */
    bytes?: Uint8Array;
    /** Guest IUnknown pointer for DDSPD_IUNKNOWNPOINTER entries (we hold one ref). */
    unknownPtr?: number;
}

/**
 * IMMUTABLE: Bitmap textures loaded from BMP files.
 *
 * Key characteristics:
 * - rgbaScratch is AUTHORITATIVE (never invalidates) - contains original RGBA from BMP
 * - Simple upload flag (gpuNeedsUpload) - no version tracking
 * - No authority tracking (immutable = always valid)
 *
 * Prevents bugs P1-P4 by design:
 * - P1: No hasFreshRGBA check needed (rgbaScratch always fresh)
 * - P2: No rgbaScratchVersion to desync
 * - P3: ReleaseDC doesn't apply (read-only textures)
 * - P4: Flip doesn't apply (textures don't flip)
 */
export interface BitmapTextureSurface extends BaseSurfaceState {
    readonly surfaceType: "bitmap_texture";

    /** Authoritative RGBA from BMP file (NEVER invalidates). */
    rgbaScratch: Uint8Array;

    /** Simple upload flag - true if GPU texture needs upload from rgbaScratch. */
    gpuNeedsUpload: boolean;

    /** Bumped every time the guest rewrites this texture's pixels (CopyRects, Unlock,
     *  UpdateTexture). One GPU texture backs all draws that sample this surface, so a
     *  batch spanning a content change would render every draw with the LAST upload —
     *  the draw batcher compares this to break the batch, exactly as it does with a
     *  render surface's `version`. A game using one texture as a scratch tile buffer
     *  (copy tile → draw quad → copy next tile → draw) depends on it. */
    contentVersion?: number;

    /** D3D8/D3D9 format enum/FourCC used to decode guest texture memory. */
    d3dFormat?: number;

    /** Legacy alias for D3D8 DXT textures. Kept for compatibility with existing
     *  callers while decode paths migrate to d3dFormat. */
    dxtFormat?: number;

    /** Palette currently baked into rgbaScratch for D3D8 palettized (P8/A8P8)
     *  textures. Identity-compared against the device's current texture palette so
     *  the texture is re-decoded only when the bound palette actually changes. */
    palette?: Uint32Array;

    /** If true, texture needs UV flip (V coordinate inversion) in shader.
     * Used for bottom-up BMP files to avoid CPU array manipulation.
     * Set from isTopDown flag when creating texture from bitmap.
     */
    needsUVFlip?: boolean;

    // ============================================================================
    // COLORKEY CACHE - Supports dynamic colorkey changes in old D3D games
    // ============================================================================
    // Some games may call SetColorKey after texture load.
    // We cache the colorkey-applied version separately to avoid mutating
    // the authoritative rgbaScratch (needed for palette swaps, format changes).

    /** Cached RGBA with colorkey applied (alpha=0 for transparent pixels). */
    rgbaScratchWithColorKey?: Uint8Array;

    /** The colorkey that was used to generate rgbaScratchWithColorKey.
     * Format: { low, high } in surface pixel format (RGB565, palette index, etc.)
     * Used to detect when colorkey changes and cache needs rebuild.
     */
    appliedColorKey?: { low: number; high: number };

    // ✅ ELIMINATED: authority, version, cpuVersion, gpuVersion, rgbaScratchVersion
    // (immutable = no tracking needed)
}

/**
 * MUTABLE: Render surfaces, backbuffers, etc.
 *
 * CPU-First Architecture:
 * - surfacePtr (CPU memory) is ALWAYS authoritative
 * - GPU texture is ephemeral cache for final present and 3D render targets
 * - Simple dirty flag (gpuDirty) for upload decisions
 * - Deterministic mode (CPU vs GPU_ONLY) replaces authority heuristics
 */
export interface RenderSurface extends BaseSurfaceState {
    readonly surfaceType: "render_surface";

    /** Mode: deterministic surface type (not a heuristic). CPU = most surfaces, GPU_ONLY = pure 3D render targets. */
    mode: "CPU" | "GPU_ONLY";
    /** Global content version; incremented on any write. */
    version: number;
    /** True if GPU texture is stale and needs CPU upload. Set by Unlock/Blt CPU modifications. */
    gpuDirty: boolean;
    /** Version when GPU last wrote to texture (for demotion detection). */
    gpuWrittenVersion?: number;
    /** True if surface was ever Lock()'d (permanent CPU mode). */
    everLocked: boolean;
    /** The last Lock was D3DLOCK_READONLY — Unlock must not claim CPU authority for it. */
    lastLockReadOnly?: boolean;
    /** Version of last CPU→GPU upload (for debugging). */
    lastUploadVersion: number;
    /** Bounding box of dirty region (for partial upload optimization - Phase 2). */
    dirtyRegion?: Rect;

    /** Ephemeral RGBA cache (can invalidate/recreate). */
    rgbaScratch?: Uint8Array;
    /** Version of data currently in rgbaScratch. */
    rgbaScratchVersion?: number;

    /** Version whose GPU content is already present in guest memory at surfacePtr
     *  (set when a GPU→CPU readback completes). needsCPUSync returns false while it
     *  matches `version`, so N Locks between two GPU writes cost ONE round trip.
     *  Every writer bumps `version`, which invalidates this by construction; the paths
     *  that assign `version` across surfaces (flip rotation, sibling propagation) must
     *  carry or clear it explicitly. */
    cpuSyncedVersion?: number;
}

/**
 * Discriminated union type for all surfaces.
 * TypeScript enforces correct field access via type guards.
 */
export type DirectDrawSurfaceState = BitmapTextureSurface | RenderSurface;

// ============================================================================
// TYPE GUARDS - Compile-time safety
// ============================================================================

/**
 * Type guard for BitmapTextureSurface.
 * Use before accessing bitmap-specific fields (rgbaScratch, gpuNeedsUpload, needsUVFlip).
 */
export function isBitmapTexture(state: DirectDrawSurfaceState): state is BitmapTextureSurface {
    return state.surfaceType === "bitmap_texture";
}

/**
 * Type guard for RenderSurface.
 * Use before accessing render-surface-specific fields (authority, version, cpuValid, etc.).
 */
export function isRenderSurface(state: DirectDrawSurfaceState): state is RenderSurface {
    return state.surfaceType === "render_surface";
}

/**
 * DirectDraw Surface COM object implementation.
 */
export class DirectDrawSurfaceObject extends BaseComObject {
    private state: DirectDrawSurfaceState;
    // Cache for texture interface objects (COM Identity: same surface -> same texture interface)
    private cachedTexture2Handle: number = 0;
    private cachedTextureHandle: number = 0;
    /**
     * Guest address of the IDirectDraw interface this surface was created through.
     * GetDDInterface must return that exact interface version — a surface made via
     * IDirectDraw::CreateSurface hands back an IDirectDraw, never an IDirectDraw7.
     */
    private ddrawOwnerAddr: number = 0;

    constructor(vtableAddress: number, state: DirectDrawSurfaceState) {
        super(IID_IDirectDrawSurface7, vtableAddress);
        this.state = state;

        const ddrawModule = System.getInstance().process?.getModule("ddraw") as {
            purgeTextureRegistryForRecycledComSlot?: (slot: number, newHandle: number) => void;
        } | undefined;
        if (ddrawModule?.purgeTextureRegistryForRecycledComSlot) {
            const slot = (this.handle & SystemResourceProvider.COM_SLOT_MASK) >>> 0;
            ddrawModule.purgeTextureRegistryForRecycledComSlot(slot, this.handle);
        }
    }

    getCachedTexture2Handle(): number {
        return this.cachedTexture2Handle;
    }

    setCachedTexture2Handle(handle: number): void {
        this.cachedTexture2Handle = handle;
    }

    getCachedTextureHandle(): number {
        return this.cachedTextureHandle;
    }

    setCachedTextureHandle(handle: number): void {
        this.cachedTextureHandle = handle;
    }

    getDDrawOwnerAddr(): number {
        return this.ddrawOwnerAddr;
    }

    setDDrawOwnerAddr(addr: number): void {
        this.ddrawOwnerAddr = addr;
    }

    /**
     * Drop the reference AddAttachedSurface took on every surface EXPLICITLY attached to
     * this one. DirectDraw detaches before it destroys the root, and detaching is what
     * releases the attachment (Wine ddraw_surface_cleanup → ddraw_surface_delete_attached_surface).
     * Without this the reference is a leak, and a leaked reference on a primary or a
     * flip-chain member keeps a dead screen resolvable long after the app dropped it.
     */
    private releaseAttachRefs(): void {
        const attached = this.state.attachedSurfaceAddrs;
        if (!attached || attached.length === 0) return;
        const resourceProvider = SystemResourceProvider.getInstance();
        const myAddr = (resourceProvider.getAddressForHandle(this.handle) ?? 0) >>> 0;
        if (!myAddr) return;

        for (const addr of [...attached]) {
            const resolved = resourceProvider.getComObjectByAddress(addr);
            if (!(resolved instanceof DirectDrawSurfaceObject)) continue;
            const state = resolved.getState();
            if (((state.attachRefOwner ?? 0) >>> 0) !== myAddr) continue;
            // Clear the slot BEFORE releasing: the surface may go away inside release().
            state.attachRefOwner = 0;
            resolved.release();
        }
    }

    /**
     * A surface DirectDraw created as part of a complex one — a mip sublevel, a back buffer
     * of a DDSD_BACKBUFFERCOUNT chain — belongs to the root, not to the app: the app's
     * Release may take its count to zero, and DirectDraw IGNORES that. It dies with the root
     * (Wine surface.c ddraw_surface_release_iface: `if (This->is_implicit) ... return;`,
     * and ddraw_surface_cleanup destroys the complex members regardless of their count).
     *
     * NFS Porsche's dx7z walks a mip chain per texture update — GetAttachedSurface, use the
     * level, Release it — so destroying a level at zero hands the next iteration a freed COM
     * block, and the block pool then dispatches the guest through whatever reused it.
     */
    protected get leakOnZeroRef(): boolean {
        return this.state.implicitChainMember === true;
    }

    /** The complex root reaps its members (destroyImplicitMembers) — that is the whole
     *  point of keeping them past zero, so the root's teardown must be able to. */
    protected get reapableAtZero(): boolean {
        return this.state.implicitChainMember === true;
    }

    /**
     * Destroy the complex members this surface owns. Both chains DirectDraw builds itself
     * are followed: the flip ring (attachedSurfaceAddr, circular back to this) and the mip
     * chain. Implicit members only — a surface the app attached itself holds its own
     * reference and only loses the attachment one (releaseAttachRefs).
     */
    private destroyImplicitMembers(): void {
        const resourceProvider = SystemResourceProvider.getInstance();
        const myAddr = (resourceProvider.getAddressForHandle(this.handle) ?? 0) >>> 0;
        const visited = new Set<number>([myAddr]);
        const queue: number[] = [this.state.attachedSurfaceAddr >>> 0,
                                 ...(this.state.attachedSurfaceAddrs ?? [])];

        while (queue.length) {
            const addr = queue.shift()! >>> 0;
            if (!addr || visited.has(addr)) continue;
            visited.add(addr);
            const resolved = resourceProvider.getComObjectByAddress(addr);
            // A released member's COM block can already hold a device/texture.
            if (!(resolved instanceof DirectDrawSurfaceObject)) continue;
            const state = resolved.getState();
            if (!state.implicitChainMember) continue;
            queue.push(state.attachedSurfaceAddr >>> 0, ...(state.attachedSurfaceAddrs ?? []));
            resolved.forceRelease();
        }
    }

    release(): number {
        if (this.refCount === 1) {
            this.releaseAttachRefs();
        }

        const newRefCount = super.release();

        // Clear texture handle cache when refcount reaches 0
        // Prevents "zombie" handles from being reused if surface is recreated
        if (newRefCount === 0) {
            this.cachedTextureHandle = 0;
            this.cachedTexture2Handle = 0;

            // DIAGNOSTIC: Log when BitmapTextureSurface is destroyed
            if (isBitmapTexture(this.state)) {
                Logger.log(LogCategory.DDRAW,
                    `🗑️ BitmapTextureSurface destroyed (refCount=0): ` +
                    `handle=0x${this.handle.toString(16)} ` +
                    `surfacePtr=0x${this.state.surfacePtr.toString(16)} ` +
                    `size=${this.state.width}x${this.state.height}`
                );
            }

            // DIAGNOSTIC: Log when surface with colorkey is destroyed
            if (this.state.srcColorKey) {
                Logger.log(LogCategory.DDRAW,
                    `🗑️ Surface with COLORKEY destroyed (refCount=0): ` +
                    `handle=0x${this.handle.toString(16)} ` +
                    `surfacePtr=0x${this.state.surfacePtr.toString(16)} ` +
                    `colorkey=0x${this.state.srcColorKey.low.toString(16)}-0x${this.state.srcColorKey.high.toString(16)} ` +
                    `size=${this.state.width}x${this.state.height} ` +
                    `surfaceType=${this.state.surfaceType}`
                );
            }
        }

        return newRefCount;
    }

    protected destroy(): void {
        this.destroyImplicitMembers();

        const depthSurfacePtr =
            this.state.surfacePtrAllocated && this.state.surfacePtr > 0
                ? (this.state.surfacePtr >>> 0)
                : 0;

        // Auto-revoke active lease if surface destroyed while locked
        if (this.state.activeLeaseId !== undefined) {
            Logger.warn(LogCategory.DDRAW,
                `Surface destroyed while locked! Auto-revoking lease ${this.state.activeLeaseId}`);
            leaseRegistry.revokeLease(this.state.activeLeaseId);
            this.state.activeLeaseId = undefined;
        }

        // SetPrivateData entries die with the surface, releasing any IUnknown they hold.
        if (this.state.privateData) {
            const provider = System.getInstance().resourceProvider as any;
            for (const entry of this.state.privateData.values()) {
                if (entry.unknownPtr) provider?.getComObjectByAddress?.(entry.unknownPtr)?.release?.();
            }
            this.state.privateData = undefined;
        }

        // Unbind this surface from all active devices before destroying GPU resources
        // If device is using this texture in a render pass, WebGPU will error on destroyed texture
        this.unbindFromDevices();

        // Invalidate executor caches before destroying GPU resources
        // Prevents "Destroyed texture used in submit" errors from cached texture views
        const system = System.getInstance();
        const ddrawModule = system.process?.getModule("ddraw") as any;
        const executor = ddrawModule?.context?.executor;
        if (executor?.invalidateSurfaceCache) {
            executor.invalidateSurfaceCache(this.state);
        }

        // Drop the context's cached primary/back-buffer addresses if they point at THIS object.
        // The system object pool deliberately recycles same-size COM blocks, so an app that
        // releases its primary and creates a new DirectDraw gets the block back — and every
        // reader of the cached address then resolves it to whatever now lives there (a
        // DirectDrawObject), which is not a surface. Only the whole-DirectDraw cascade cleared
        // these; a lone Release of the primary did not.
        const surfaces = ddrawModule?.context?.surfaces;
        if (surfaces) {
            const self = (system.resourceProvider as any)?.getAddressForHandle?.(this.handle) >>> 0;
            if (self) {
                if ((surfaces.primary >>> 0) === self) surfaces.primary = 0;
                if ((surfaces.backBuffer >>> 0) === self) surfaces.backBuffer = 0;
            }
        }

        // Remove from deferred upload batch BEFORE freeing memory.
        // Without this, flushAll() reads from freed/reused surfacePtr → wrong pixel data
        // (wrong pixel data uploaded from freed/reused surfacePtr).
        const deferredMgr = ddrawModule?.context?.deferredUploadManager;
        if (deferredMgr) {
            deferredMgr.removeDirty(this.state);
        }

        runSurfaceTeardownHooks(this.state);

        // Deferred destruction of GPU resources
        // WebGPU commands are asynchronous - if we destroy texture immediately,
        // pending copyTextureToTexture commands will fail with validation error
        if (this.state.gpuTexture) {
            const deadGpu = this.state.gpuTexture;
            const keepForRegistry = ddrawModule?.isGpuTextureReferencedByRegistry?.(deadGpu) === true;
            if (!keepForRegistry) {
                const system = System.getInstance();
                if (system.gpuResourceManager) {
                    system.gpuResourceManager.enqueueForDestruction(deadGpu);
                    Logger.verbose(LogCategory.COM,
                        `DirectDrawSurfaceObject: Enqueued GPU texture for deferred destruction ` +
                        `(surfacePtr=0x${this.state.surfacePtr.toString(16)} type=${this.state.surfaceType})`
                    );
                } else {
                    try {
                        deadGpu.destroy();
                        Logger.log(LogCategory.COM,
                            `DirectDrawSurfaceObject: destroyed GPU texture for surface ` +
                            `(surfacePtr=0x${this.state.surfacePtr.toString(16)} type=${this.state.surfaceType})`
                        );
                    } catch (e) {
                        Logger.warn(LogCategory.COM, `DirectDrawSurfaceObject: error destroying GPU texture: ${e}`);
                    }
                }
            } else {
                Logger.verbose(LogCategory.COM,
                    `DirectDrawSurfaceObject: Keeping GPU texture alive — texture-handle registry still references it ` +
                    `(handle=0x${this.handle.toString(16)} surfacePtr=0x${this.state.surfacePtr.toString(16)})`
                );
            }
            this.state.gpuTexture = undefined;
            this.state.gpuTextureView = undefined;
            this.state.gpuMipLevels = undefined;
        }

        if (this.state.clipperHandle !== undefined) {
            try {
                SystemResourceProvider.getInstance()
                    .getComObject(this.state.clipperHandle)
                    ?.release();
            } catch (e) {
                Logger.verbose(LogCategory.COM, `DirectDrawSurfaceObject: error releasing clipper: ${e}`);
            }
            this.state.clipperHandle = undefined;
        }

        // Defer pixel buffer free until the next CreateSurface/reset. Guest renderers
        // such as ref_soft/Q2 can still touch vid.buffer after surface/DDraw Release
        // while DestroyWindow / VID_Shutdown finishes.
        if (this.state.surfacePtrAllocated && this.state.surfacePtr > 0) {
            const ptr = this.state.surfacePtr >>> 0;
            this.state.surfacePtr = 0;
            this.state.surfacePtrAllocated = false;
            const ddrawModule = System.getInstance().process?.getModule("ddraw") as {
                deferSurfacePtrFree?: (p: number) => void;
            } | undefined;
            if (ddrawModule?.deferSurfacePtrFree) {
                ddrawModule.deferSurfacePtrFree(ptr);
            } else {
                const process = System.getInstance().process;
                try {
                    process?.memory.free(ptr);
                } catch (e) {
                    Logger.warn(LogCategory.COM, `DirectDrawSurfaceObject: error freeing surfacePtr 0x${ptr.toString(16)}: ${e}`);
                }
            }
        }

        // Cleanup bitmapToSurfaceCache entry if this surface was created from a bitmap
        // Also cleanup depth buffer for this surface
        const process = System.getInstance().process;
        if (process) {
            try {
                const ddrawModule = process.getModule("ddraw") as any;
                if (ddrawModule?.unregisterSurfaceFromCache) {
                    ddrawModule.unregisterSurfaceFromCache(this.handle);
                }
                if (this.state.vidMemSize && ddrawModule?.releaseVidMem) {
                    ddrawModule.releaseVidMem(this.state.vidMemSize);
                }
                // Remove depth buffer for this surface (use ptr captured before deferred free)
                if (ddrawModule?.removeDepthForSurface && depthSurfacePtr > 0) {
                    ddrawModule.removeDepthForSurface(depthSurfacePtr);
                }
            } catch (e) {
                // Ignore errors during cleanup
                Logger.verbose(LogCategory.COM, `DirectDrawSurfaceObject: error unregistering from cache or releasing VRAM: ${e}`);
            }
        }

        Logger.verbose(LogCategory.COM, "DirectDrawSurfaceObject destroyed");
    }

    private unbindFromDevices(): void {
        try {
            const resourceProvider = SystemResourceProvider.getInstance();
            
            // Unbind this surface from all devices that have it bound as texture
            // This prevents WebGPU validation errors when surface is destroyed while still in use
            if (this.state.boundByDevices && this.state.boundByDevices.size > 0) {
                Logger.verbose(LogCategory.COM, 
                    `DirectDrawSurfaceObject: Unbinding from ${this.state.boundByDevices.size} device(s) before destruction`
                );
                
                for (const { deviceHandle, stage } of this.state.boundByDevices.values()) {
                    const deviceObj = resourceProvider.getComObject(deviceHandle);
                    if (deviceObj) {
                        // Check if device is Device3 or Device7
                        if (deviceObj instanceof Direct3DDevice3Object || deviceObj instanceof Direct3DDevice7Object) {
                            // Set texture to NULL on this stage to unbind
                            deviceObj.setTexture(stage, 0);
                            Logger.verbose(LogCategory.COM,
                                `DirectDrawSurfaceObject: Unbound from device 0x${deviceHandle.toString(16)} stage ${stage}`
                            );
                        }
                    }
                }
                
                // Clear the map after unbinding
                this.state.boundByDevices.clear();
            }
        } catch (e) {
            // Ignore errors during cleanup - we're in destroy(), errors here are non-critical
            Logger.verbose(LogCategory.COM, `DirectDrawSurfaceObject: error unbinding from devices: ${e}`);
        }
    }

    getState(): DirectDrawSurfaceState {
        return this.state;
    }

    protected queryAdditionalInterfaces(riid: string): string | null {
        const normalized = riid.replace(/[{}]/g, "").toLowerCase();
        const supported = [
            IID_IDirectDrawSurface.toLowerCase(),
            IID_IDirectDrawSurface2.toLowerCase(),
            IID_IDirectDrawSurface3.toLowerCase(),
            IID_IDirectDrawSurface4.toLowerCase(),
        ];
        if (supported.includes(normalized)) {
            return riid;
        }
        return null;
    }

    /** Set the FLIP-CHAIN link. Use addAttachment() for attachments in general. */
    setAttachedSurface(addr: number): void {
        const oldAddr = this.state.attachedSurfaceAddr;
        this.state.attachedSurfaceAddr = addr;
        this.addAttachment(addr);
        Logger.verbose(LogCategory.DDRAW,
            `DirectDrawSurfaceObject.setAttachedSurface: handle=0x${this.handle.toString(16)} ` +
            `old=0x${oldAddr.toString(16)} new=0x${addr.toString(16)}`
        );
    }

    /** Record `addr` in the attachment list without touching the flip-chain link. */
    addAttachment(addr: number): void {
        const a = addr >>> 0;
        if (!a) return;
        const list = this.state.attachedSurfaceAddrs ?? (this.state.attachedSurfaceAddrs = []);
        if (!list.includes(a)) list.push(a);
    }

    /** Drop `addr` from the attachment list, and from the flip link if it was the link. */
    removeAttachment(addr: number): void {
        const a = addr >>> 0;
        const list = this.state.attachedSurfaceAddrs;
        if (list) {
            const i = list.indexOf(a);
            if (i >= 0) list.splice(i, 1);
        }
        if ((this.state.attachedSurfaceAddr >>> 0) === a) {
            // Promote whatever else is attached; a chain of one is not a chain, and Flip
            // rejects it the same way DirectDraw does.
            this.state.attachedSurfaceAddr = list?.[0] ?? 0;
        }
    }
}

/**
 * Direct3D7 COM object implementation (minimal stub).
 */
export class Direct3D7Object extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IDirect3D7, vtableAddress);
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3D7Object destroyed");
    }
}

/**
 * Direct3D2 COM object implementation (minimal stub).
 */
export class Direct3D2Object extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IDirect3D2, vtableAddress);
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3D2Object destroyed");
    }
}

/**
 * Direct3D COM object implementation (minimal stub).
 */
export class Direct3DObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IDirect3D, vtableAddress);
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3DObject destroyed");
    }
}

/**
 * Direct3D3 COM object implementation (minimal stub).
 */
export class Direct3D3Object extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IDirect3D3, vtableAddress);
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3D3Object destroyed");
    }
}

/**
 * Direct3DDevice3 COM object implementation.
 */
export class Direct3DDevice3Object extends BaseComObject {
    protected get leakOnZeroRef(): boolean { return true; }
    /** IDirect3D3* that created this device (IDirect3DDevice3::GetDirect3D). */
    private parentD3Addr: number = 0;
    private renderTargetAddr: number = 0;
    private currentViewportAddr: number = 0;
    private textureAddrs: number[] = new Array(8).fill(0);
    private _destroying = false;
    private renderStates: Int32Array = new Int32Array(256);
    private textureStageStates: Int32Array = new Int32Array(8 * 32); // 8 stages, 32 states each

    // Transform matrices (World, View, Projection)
    private worldMatrix: Float32Array = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ]);
    private viewMatrix: Float32Array = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ]);
    private projMatrix: Float32Array = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ]);
    // MVP cache - avoid recomputing every draw call
    private transformVersion: number = 0;
    private cachedMVP: Float32Array = new Float32Array(16);
    private cachedMVPVersion: number = -1;

    // Texture transform matrices (D3DTRANSFORMSTATE_TEXTURE0..7 = states 16..23)
    // Row-major 4x4. index [i*16+12]=transU, [i*16+13]=transV, [i*16+0]=scaleU, [i*16+5]=scaleV
    private textureMatrices: Float32Array = new Float32Array(8 * 16); // 8 stages, each 4x4
    private textureMatricesSet: boolean[] = new Array(8).fill(false);

    // Lighting system state
    private material: D3DMaterial7Data = createDefaultMaterial();
    /** SetMaterial was called at least once — the DX6 ProcessVertices D3DVOP_LIGHT gate. */
    private materialSet: boolean = false;
    private lights: Map<number, D3DLight7Data> = new Map();
    private lightsEnabled: Set<number> = new Set();

    // State block system
    private stateBlocks: Map<number, D3DStateBlock> = new Map();
    private nextStateBlockId: number = 1;
    private isRecordingStateBlock: boolean = false;
    private recordingStateBlock: D3DStateBlock | null = null;

    constructor(vtableAddress: number) {
        super(IID_IDirect3DDevice3V5, vtableAddress);
        // Initialize with valid D3D7 default states (copy arrays to avoid sharing references)
        this.renderStates.set(EMPTY_RENDER_STATES);
        this.textureStageStates.set(EMPTY_TEX_STATES);
    }

    // --- Lighting system methods ---

    setMaterial(mat: D3DMaterial7Data): void {
        this.material = mat;
        this.materialSet = true;
    }

    isMaterialSet(): boolean {
        return this.materialSet;
    }

    getMaterial(): D3DMaterial7Data {
        return this.material;
    }

    setLight(index: number, light: D3DLight7Data): void {
        this.lights.set(index, light);
    }

    getLight(index: number): D3DLight7Data | null {
        return this.lights.get(index) ?? null;
    }

    setLightEnabled(index: number, enabled: boolean): void {
        if (enabled) {
            this.lightsEnabled.add(index);
        } else {
            this.lightsEnabled.delete(index);
        }
    }

    isLightEnabled(index: number): boolean {
        return this.lightsEnabled.has(index);
    }

    getAllLights(): Map<number, D3DLight7Data> {
        return this.lights;
    }

    getEnabledLights(): Set<number> {
        return this.lightsEnabled;
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
        // Collect enabled lights, sorted by index for deterministic behavior
        const sortedIndices = Array.from(this.lightsEnabled).sort((a, b) => a - b);
        for (const index of sortedIndices) {
            const light = this.lights.get(index);
            if (light) {
                enabledLights.push(light);
            }
            if (enabledLights.length >= 8) break; // Hard limit for emulation
        }

        return {
            lightingEnabled,
            material: this.material,
            lights: enabledLights,
            ambientColor,
            worldMatrix: this.worldMatrix,
            worldViewMatrix: this.computeWorldView(),
            viewMatrix: this.viewMatrix,
            diffuseSource: this.renderStates[D3DRENDERSTATE_DIFFUSEMATERIALSOURCE] ?? 0,
            ambientSource: this.renderStates[D3DRENDERSTATE_AMBIENTMATERIALSOURCE] ?? 0,
            specularSource: this.renderStates[D3DRENDERSTATE_SPECULARMATERIALSOURCE] ?? 0,
            emissiveSource: this.renderStates[D3DRENDERSTATE_EMISSIVEMATERIALSOURCE] ?? 0,
        };
    }

    /** World×View (camera/eye space) for D3DTSS_TCI_CAMERASPACE* texgen. Row-major,
     *  same convention as getCachedMVP's world*view step. */
    private computeWorldView(): Float32Array {
        const world = this.worldMatrix;
        const view = this.viewMatrix;
        const wv = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            const ai0 = world[i * 4 + 0], ai1 = world[i * 4 + 1], ai2 = world[i * 4 + 2], ai3 = world[i * 4 + 3];
            wv[i * 4 + 0] = ai0 * view[0] + ai1 * view[4] + ai2 * view[8] + ai3 * view[12];
            wv[i * 4 + 1] = ai0 * view[1] + ai1 * view[5] + ai2 * view[9] + ai3 * view[13];
            wv[i * 4 + 2] = ai0 * view[2] + ai1 * view[6] + ai2 * view[10] + ai3 * view[14];
            wv[i * 4 + 3] = ai0 * view[3] + ai1 * view[7] + ai2 * view[11] + ai3 * view[15];
        }
        return wv;
    }

    // --- State block methods ---

    isRecording(): boolean {
        return this.isRecordingStateBlock;
    }

    beginStateBlock(): void {
        this.isRecordingStateBlock = true;
        this.recordingStateBlock = {
            id: 0, // Will be assigned on EndStateBlock
            renderStates: new Int32Array(256),
            textureStageStates: new Int32Array(8 * 32),
            textures: new Array(8).fill(0),
            transforms: { world: null, view: null, projection: null },
            material: null,
            lights: new Map(),
            lightsEnabled: new Set(),
            viewport: null,
        };
    }

    endStateBlock(): number {
        if (!this.isRecordingStateBlock || !this.recordingStateBlock) {
            return 0;
        }
        const id = this.nextStateBlockId++;
        this.recordingStateBlock.id = id;
        this.stateBlocks.set(id, this.recordingStateBlock);
        this.isRecordingStateBlock = false;
        this.recordingStateBlock = null;
        return id;
    }

    createStateBlock(type: number): number {
        // Create a state block from current state
        const id = this.nextStateBlockId++;
        const block: D3DStateBlock = {
            id,
            renderStates: new Int32Array(this.renderStates),
            textureStageStates: new Int32Array(this.textureStageStates),
            textures: [...this.textureAddrs],
            transforms: {
                world: new Float32Array(this.worldMatrix),
                view: new Float32Array(this.viewMatrix),
                projection: new Float32Array(this.projMatrix),
            },
            material: { ...this.material, diffuse: { ...this.material.diffuse }, ambient: { ...this.material.ambient }, specular: { ...this.material.specular }, emissive: { ...this.material.emissive } },
            lights: new Map(Array.from(this.lights.entries()).map(([k, v]) => [k, { ...v, diffuse: { ...v.diffuse }, specular: { ...v.specular }, ambient: { ...v.ambient }, position: { ...v.position }, direction: { ...v.direction } }])),
            lightsEnabled: new Set(this.lightsEnabled),
            viewport: null,
        };
        this.stateBlocks.set(id, block);
        return id;
    }

    captureStateBlock(handle: number): boolean {
        const block = this.stateBlocks.get(handle);
        if (!block) return false;
        // Update block with current state
        block.renderStates.set(this.renderStates);
        block.textureStageStates.set(this.textureStageStates);
        block.textures = [...this.textureAddrs];
        block.transforms.world = new Float32Array(this.worldMatrix);
        block.transforms.view = new Float32Array(this.viewMatrix);
        block.transforms.projection = new Float32Array(this.projMatrix);
        block.material = { ...this.material, diffuse: { ...this.material.diffuse }, ambient: { ...this.material.ambient }, specular: { ...this.material.specular }, emissive: { ...this.material.emissive } };
        block.lights = new Map(Array.from(this.lights.entries()).map(([k, v]) => [k, { ...v, diffuse: { ...v.diffuse }, specular: { ...v.specular }, ambient: { ...v.ambient }, position: { ...v.position }, direction: { ...v.direction } }]));
        block.lightsEnabled = new Set(this.lightsEnabled);
        return true;
    }

    applyStateBlock(handle: number): boolean {
        const block = this.stateBlocks.get(handle);
        if (!block) return false;
        // Restore state from block
        this.renderStates.set(block.renderStates);
        this.textureStageStates.set(block.textureStageStates);
        this.textureAddrs = [...block.textures];
        if (block.transforms.world) this.worldMatrix.set(block.transforms.world);
        if (block.transforms.view) this.viewMatrix.set(block.transforms.view);
        if (block.transforms.projection) this.projMatrix.set(block.transforms.projection);
        if (block.material) {
            this.material = { ...block.material, diffuse: { ...block.material.diffuse }, ambient: { ...block.material.ambient }, specular: { ...block.material.specular }, emissive: { ...block.material.emissive } };
        }
        this.lights = new Map(Array.from(block.lights.entries()).map(([k, v]) => [k, { ...v, diffuse: { ...v.diffuse }, specular: { ...v.specular }, ambient: { ...v.ambient }, position: { ...v.position }, direction: { ...v.direction } }]));
        this.lightsEnabled = new Set(block.lightsEnabled);
        return true;
    }

    deleteStateBlock(handle: number): boolean {
        return this.stateBlocks.delete(handle);
    }

    setParentD3(addr: number): void {
        swapDeviceComRef(this.parentD3Addr, addr);
        this.parentD3Addr = addr;
    }

    getParentD3(): number {
        return this.parentD3Addr;
    }

    setRenderTarget(addr: number): void {
        this.renderTargetAddr = addr;
    }

    getRenderTarget(): number {
        return this.renderTargetAddr;
    }

    setCurrentViewport(addr: number): void {
        swapDeviceComRef(this.currentViewportAddr, addr);
        this.currentViewportAddr = addr;
    }

    getCurrentViewport(): number {
        return this.currentViewportAddr;
    }

    setTexture(stage: number, addr: number): void {
        if (this._destroying) return;
        if (stage >= 0 && stage < 8) {
            this.textureAddrs[stage] = addr;
        }
    }

    getTexture(stage: number): number {
        return this.textureAddrs[stage] || 0;
    }

    setRenderState(state: number, value: number): void {
        if (state < 0 || state >= 256) return;
        // Legacy sampler render states map to texture stage 0 on Device3. Always
        // retranslate because a direct SetTextureStageState call may have overwritten TSS.
        if (isLegacyTextureSamplerRenderState(state)) {
            this.renderStates[state] = value;
            translateLegacyTextureSamplerState(this.textureStageStates, state, value);
            return;
        }
        // D3DRENDERSTATE_TEXTUREMAPBLEND — always retranslate even if value unchanged,
        // because direct SetTextureStageState calls may have overwritten TSS in between.
        if (state === D3DRENDERSTATE_TEXTUREMAPBLEND) {
            this.renderStates[D3DRENDERSTATE_TEXTUREMAPBLEND] = value;
            translateTexMapBlend(this.textureStageStates, value);
        } else if (this.renderStates[state] !== value) {
            if (state === 27 || state === 15 || state === 19 || state === 20 || state === 25 || state === 41 || state === 137 || state === 139 || state === 145) {
                // 137=LIGHTING, 139=AMBIENT, 145=DIFFUSEMATERIALSOURCE (relevant for FFP lighting)
                // 27=ALPHABLENDENABLE, 15=ALPHATESTENABLE, 19=SRCBLEND, 20=DESTBLEND, 25=ALPHAFUNC, 60=COLORKEYENABLE
                Logger.log(LogCategory.DDRAW, `SetRenderState: [${state}] ${value} (was ${this.renderStates[state]})`);
            }
            this.renderStates[state] = value;
        }
    }

    getRenderState(state: number): number {
        return this.renderStates[state] || 0;
    }

    getAllRenderStates(): Int32Array {
        return this.renderStates;
    }

    getAllTextureStageStates(): Int32Array {
        return this.textureStageStates;
    }

    getTextureStageStates(): Int32Array {
        return this.textureStageStates;
    }

    private setTextureStageStateRaw(stage: number, state: number, value: number): void {
        const idx = stage * 32 + state;
        if (idx >= 0 && idx < this.textureStageStates.length && this.textureStageStates[idx] !== value) {
            this.textureStageStates[idx] = value;
        }
    }

    setTextureStageState(stage: number, state: number, value: number): void {
        // D3DTSS_ADDRESS (DX6/DX7) is a combined state: sets both U and V address modes.
        // Slot 12 is also stored so GetTextureStageState(D3DTSS_ADDRESS) returns the
        // last combined value (matches pre-fan-out behavior).
        if (state === D3DTSS_ADDRESS) {
            this.setTextureStageStateRaw(stage, D3DTSS_ADDRESSU, value);
            this.setTextureStageStateRaw(stage, D3DTSS_ADDRESSV, value);
            this.setTextureStageStateRaw(stage, D3DTSS_ADDRESS, value);
            return;
        }
        this.setTextureStageStateRaw(stage, state, value);
    }

    getTextureStageState(stage: number, state: number): number {
        const idx = stage * 32 + state;
        return this.textureStageStates[idx] || 0;
    }

    setTransform(type: number, matrix: Float32Array): void {
        // D3D3: D3DTRANSFORMSTATE_WORLD=1, VIEW=2, PROJECTION=3
        // D3D7: D3DTS_WORLD=256, VIEW=2, PROJECTION=3
        // D3DTRANSFORMSTATE_TEXTURE0..7 = 16..23
        if (type === 1 || type === 256) { // D3DTRANSFORMSTATE_WORLD (D3D3) or D3DTS_WORLD (D3D7)
            this.worldMatrix.set(matrix);
            this.transformVersion++;
        } else if (type === 2) { // D3DTS_VIEW
            this.viewMatrix.set(matrix);
            this.transformVersion++;
        } else if (type === 3) { // D3DTS_PROJECTION
            this.projMatrix.set(matrix);
            this.transformVersion++;
        } else if (type >= 16 && type <= 23) { // D3DTRANSFORMSTATE_TEXTURE0..7
            const stage = type - 16;
            this.textureMatrices.set(matrix.subarray(0, 16), stage * 16);
            this.textureMatricesSet[stage] = true;
        }
    }

    getTransform(type: number): Float32Array | null {
        if (type === 1 || type === 256) { // D3DTRANSFORMSTATE_WORLD (D3D3) or D3DTS_WORLD (D3D7)
            return this.worldMatrix;
        } else if (type === 2) { // D3DTS_VIEW
            return this.viewMatrix;
        } else if (type === 3) { // D3DTS_PROJECTION
            return this.projMatrix;
        } else if (type >= 16 && type <= 23) {
            const stage = type - 16;
            return this.textureMatrices.subarray(stage * 16, stage * 16 + 16) as Float32Array;
        }
        return null;
    }

    getTextureMatrix(stage: number): Float32Array | null {
        if (stage < 0 || stage > 7) return null;
        if (!this.textureMatricesSet[stage]) return null;
        return this.textureMatrices.subarray(stage * 16, stage * 16 + 16) as Float32Array;
    }

    getWorldMatrix(): Float32Array {
        return this.worldMatrix;
    }

    getViewMatrix(): Float32Array {
        return this.viewMatrix;
    }

    getProjMatrix(): Float32Array {
        return this.projMatrix;
    }

    getTransformVersion(): number {
        return this.transformVersion;
    }

    /**
     * Get cached MVP matrix, recalculating only if transforms changed.
     * Returns null if any of world/view/proj is missing.
     */
    getCachedMVP(): Float32Array | null {
        if (this.cachedMVPVersion === this.transformVersion) {
            return this.cachedMVP;
        }

        const world = this.worldMatrix;
        const view = this.viewMatrix;
        const proj = this.projMatrix;

        // Multiply world * view
        const wv = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            const ai0 = world[i * 4 + 0], ai1 = world[i * 4 + 1], ai2 = world[i * 4 + 2], ai3 = world[i * 4 + 3];
            wv[i * 4 + 0] = ai0 * view[0] + ai1 * view[4] + ai2 * view[8] + ai3 * view[12];
            wv[i * 4 + 1] = ai0 * view[1] + ai1 * view[5] + ai2 * view[9] + ai3 * view[13];
            wv[i * 4 + 2] = ai0 * view[2] + ai1 * view[6] + ai2 * view[10] + ai3 * view[14];
            wv[i * 4 + 3] = ai0 * view[3] + ai1 * view[7] + ai2 * view[11] + ai3 * view[15];
        }

        // Multiply wv * proj into cachedMVP
        for (let i = 0; i < 4; i++) {
            const ai0 = wv[i * 4 + 0], ai1 = wv[i * 4 + 1], ai2 = wv[i * 4 + 2], ai3 = wv[i * 4 + 3];
            this.cachedMVP[i * 4 + 0] = ai0 * proj[0] + ai1 * proj[4] + ai2 * proj[8] + ai3 * proj[12];
            this.cachedMVP[i * 4 + 1] = ai0 * proj[1] + ai1 * proj[5] + ai2 * proj[9] + ai3 * proj[13];
            this.cachedMVP[i * 4 + 2] = ai0 * proj[2] + ai1 * proj[6] + ai2 * proj[10] + ai3 * proj[14];
            this.cachedMVP[i * 4 + 3] = ai0 * proj[3] + ai1 * proj[7] + ai2 * proj[11] + ai3 * proj[15];
        }

        this.cachedMVPVersion = this.transformVersion;
        return this.cachedMVP;
    }

    protected destroy(): void {
        this._destroying = true;
        const resourceProvider = SystemResourceProvider.getInstance();

        // Release bound textures
        for (let stage = 0; stage < 8; stage++) {
            const addr = this.textureAddrs[stage];
            if (addr) {
                const texObj = resourceProvider.getComObjectByAddress(addr);
                if (texObj) {
                    // Clear boundByDevices reverse ref on surface state
                    const state = (texObj as any).state || (texObj as any).getState?.();
                    if (state?.boundByDevices) {
                        const key = `${this.handle}:${stage}`;
                        state.boundByDevices.delete(key);
                    }
                    texObj.release();
                }
                this.textureAddrs[stage] = 0;
            }
        }

        // Release render target
        if (this.renderTargetAddr) {
            const rtObj = resourceProvider.getComObjectByAddress(this.renderTargetAddr);
            if (rtObj) {
                rtObj.release();
            }
            this.renderTargetAddr = 0;
        }

        // Release device-held refs on the current viewport and parent D3
        if (this.currentViewportAddr) {
            resourceProvider.getComObjectByAddress(this.currentViewportAddr)?.release();
            this.currentViewportAddr = 0;
        }
        if (this.parentD3Addr) {
            resourceProvider.getComObjectByAddress(this.parentD3Addr)?.release();
            this.parentD3Addr = 0;
        }

        Logger.log(LogCategory.COM, "Direct3DDevice3Object cascade destroy complete");
    }
}

/**
 * Direct3DViewport3 COM object implementation.
 * Supports both IDirect3DViewport3 and IDirect3DViewport2 interfaces via COM Identity.
 * 
 * COM identity is maintained via queryAdditionalInterfaces() — Viewport3 queried as
 * is queried for IID_IDirect3DViewport2, it returns the same handle with different vtable address.
 * This ensures that Viewport2 and Viewport3 share the same IUnknown and refcount.
 * 
 * Note: Direct3DViewport2Object exists as a separate class but should never be created directly.
 * All Viewport2 interfaces should be obtained via QueryInterface from Viewport3.
 */
export class Direct3DViewport3Object extends BaseComObject {
    private backgroundMaterial: number = 0;
    private backgroundColor: number = 0;
    private deviceAddr: number = 0;
    private viewport = {
        x: 0,
        y: 0,
        width: 640,
        height: 480,
        minZ: 0,
        maxZ: 1,
    };
    /** D3DVIEWPORT2 clipping volume (dvClipX/Y/Width/Height); D3D's default is the -1..1 cube. */
    private clipVolume = { x: -1, y: 1, width: 2, height: 2 };
    /**
     * Post-projection clip-space scale/bias this viewport contributes (ddraw viewport_activate).
     * A D3DVIEWPORT's clipping volume / dvScale / dvMinZ..dvMaxZ remap clip space; they never
     * change the rasterizer's own [0,1] depth range. Identity for a default viewport.
     */
    private clipSpace = { sx: 1, sy: 1, sz: 1, ox: 0, oy: 0, oz: 0 };
    private viewport2Address: number = 0; // Address for IDirect3DViewport2 vtable (if mapped)

    constructor(vtableAddress: number) {
        super(IID_IDirect3DViewport3, vtableAddress);
    }

    setClipVolume(x: number, y: number, width: number, height: number): void {
        this.clipVolume = { x, y, width, height };
    }

    getClipVolume() {
        return this.clipVolume;
    }

    setClipSpace(sx: number, sy: number, sz: number, ox: number, oy: number, oz: number): void {
        this.clipSpace = { sx, sy, sz, ox, oy, oz };
    }

    getClipSpace() {
        return this.clipSpace;
    }

    setDevice(addr: number): void {
        this.deviceAddr = addr;
    }

    getDevice(): number {
        return this.deviceAddr;
    }

    setViewport(x: number, y: number, width: number, height: number, minZ?: number, maxZ?: number): void {
        this.viewport = {
            x,
            y,
            width,
            height,
            minZ: minZ ?? this.viewport.minZ,
            maxZ: maxZ ?? this.viewport.maxZ,
        };
    }

    getViewport() {
        return this.viewport;
    }

    setBackground(hMat: number): void {
        this.backgroundMaterial = hMat;
    }

    getBackground(): number {
        return this.backgroundMaterial;
    }

    setBackgroundColor(color: number): void {
        this.backgroundColor = color;
    }

    getBackgroundColor(): number {
        return this.backgroundColor;
    }

    setViewport2Address(addr: number): void {
        this.viewport2Address = addr;
    }

    getViewport2Address(): number {
        return this.viewport2Address;
    }

    protected queryAdditionalInterfaces(riid: string): string | null {
        const normalized = riid.replace(/[{}]/g, "").toLowerCase();
        // Support IDirect3DViewport2 interface (COM Identity: same object, different vtable)
        if (normalized === IID_IDirect3DViewport2.toLowerCase()) {
            return riid;
        }
        return null;
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3DViewport3Object destroyed");
    }
}

/**
 * Direct3DViewport2 COM object implementation.
 */
export class Direct3DViewport2Object extends BaseComObject {
    private backgroundMaterial: number = 0;

    constructor(vtableAddress: number) {
        super(IID_IDirect3DViewport2, vtableAddress);
    }

    setBackground(hMat: number): void {
        this.backgroundMaterial = hMat;
    }

    getBackground(): number {
        return this.backgroundMaterial;
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3DViewport2Object destroyed");
    }
}

/**
 * Direct3DViewport COM object implementation.
 */
export class Direct3DViewportObject extends BaseComObject {
    private backgroundMaterial: number = 0;

    constructor(vtableAddress: number) {
        // Use correct IID for IDirect3DViewport (v1), not IID_IDirect3D2
        // This was causing QueryInterface to return wrong object type
        super(IID_IDirect3DViewport, vtableAddress);
    }

    setBackground(hMat: number): void {
        this.backgroundMaterial = hMat;
    }

    getBackground(): number {
        return this.backgroundMaterial;
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3DViewportObject destroyed");
    }
}

/**
 * Direct3DLight COM object — IDirect3DLight interface.
 * Stores D3DLIGHT2 data; attached to viewports via AddLight.
 */
export class Direct3DLightObject extends BaseComObject {
    private lightData: D3DLight7Data = createDefaultLight();
    private active: boolean = false;

    constructor(vtableAddress: number) {
        super(IID_IDirect3DLight, vtableAddress);
    }

    setLightData(data: D3DLight7Data): void {
        this.lightData = data;
    }

    getLightData(): D3DLight7Data {
        return this.lightData;
    }

    setActive(v: boolean): void {
        this.active = v;
    }

    isActive(): boolean {
        return this.active;
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3DLightObject destroyed");
    }
}

/**
 * Direct3DMaterial3 COM object — IDirect3DMaterial3 interface.
 * Stores D3DMATERIAL data; GetHandle returns a handle for SetLightState.
 */
export class Direct3DMaterial3Object extends BaseComObject {
    private materialData: D3DMaterial7Data = createDefaultMaterial();
    private materialHandle: number = 0;

    constructor(vtableAddress: number) {
        super(IID_IDirect3DMaterial3, vtableAddress);
    }

    setMaterialData(data: D3DMaterial7Data): void {
        this.materialData = data;
    }

    getMaterialData(): D3DMaterial7Data {
        return this.materialData;
    }

    setMaterialHandle(h: number): void {
        this.materialHandle = h;
    }

    getMaterialHandle(): number {
        return this.materialHandle;
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3DMaterial3Object destroyed");
    }
}

/**
 * Direct3DDevice7 COM object implementation.
 */
/** D3DVIEWPORT2-style viewport data (Device7 SetViewport/GetViewport) */
export type Device7Viewport = {
    x: number;
    y: number;
    width: number;
    height: number;
    minZ: number;
    maxZ: number;
};

export class Direct3DDevice7Object extends BaseComObject implements FFPLightingSource {
    protected get leakOnZeroRef(): boolean { return true; }
    /** IDirect3D7* that created this device (IDirect3DDevice7::GetDirect3D). */
    private parentD3Addr: number = 0;
    /**
     * Which enumerated DX7 device GUID the game passed to CreateDevice
     * (rgb | hal | tnlhal) — GetCaps echoes this device's GUID + dwDevCaps split
     * (see d3d-caps-utils D3d7DeviceKind). Default tnlhal: most capable, and matches
     * the pre-split reported caps for callers whose rclsid we could not read.
     */
    private d3d7DeviceKind: "rgb" | "hal" | "tnlhal" = "tnlhal";
    setD3d7DeviceKind(kind: "rgb" | "hal" | "tnlhal"): void { this.d3d7DeviceKind = kind; }
    getD3d7DeviceKind(): "rgb" | "hal" | "tnlhal" { return this.d3d7DeviceKind; }
    private renderTargetAddr: number = 0;
    private currentViewportAddr: number = 0;
    /** Viewport from SetViewport (D3DVIEWPORT2). Used by Clear when no rects. */
    private viewportData: Device7Viewport | null = null;
    private textureAddrs: number[] = new Array(8).fill(0);
    private _destroying = false;
    private renderStates: Int32Array = new Int32Array(256);
    private textureStageStates: Int32Array = new Int32Array(8 * 32); // 8 stages, 32 states each

    // Transform matrices (World, View, Projection)
    private worldMatrix: Float32Array = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ]);
    private viewMatrix: Float32Array = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ]);
    private projMatrix: Float32Array = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ]);
    // MVP cache - avoid recomputing every draw call
    private transformVersion: number = 0;
    private cachedMVP: Float32Array = new Float32Array(16);
    private cachedMVPVersion: number = -1;

    // Lighting system state
    private material: D3DMaterial7Data = createDefaultMaterial();
    /** SetMaterial was called at least once — the DX6 ProcessVertices D3DVOP_LIGHT gate. */
    private materialSet: boolean = false;
    private lights: Map<number, D3DLight7Data> = new Map();
    private lightsEnabled: Set<number> = new Set();

    // State block system
    private stateBlocks: Map<number, D3DStateBlock> = new Map();
    private nextStateBlockId: number = 1;
    private isRecordingStateBlock: boolean = false;
    private recordingStateBlock: D3DStateBlock | null = null;

    constructor(vtableAddress: number) {
        super(IID_IDirect3DDevice7, vtableAddress);
        // Initialize with valid D3D7 default states (copy arrays to avoid sharing references)
        this.resetToDefaults();
    }

    /**
     * Reset device state to D3D7 defaults.
     * Called on construction and should be callable for device reset scenarios.
     * Defaults match DirectX 7 behavior.
     */
    resetToDefaults(): void {
        // Reset render states to defaults
        this.renderStates.set(EMPTY_RENDER_STATES);
        // Reset texture stage states to defaults
        this.textureStageStates.set(EMPTY_TEX_STATES);

        // Reset transform matrices to identity
        this.worldMatrix.set([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);
        this.viewMatrix.set([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);
        this.projMatrix.set([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);

        // Reset viewport data (will be set by SetViewport)
        this.viewportData = null;

        // Reset texture addresses
        this.textureAddrs.fill(0);

        // Reset render target and viewport addresses
        this.renderTargetAddr = 0;
        this.currentViewportAddr = 0;

        // Reset lighting state
        this.material = createDefaultMaterial();
        this.lights.clear();
        this.lightsEnabled.clear();

        // Reset state blocks
        this.stateBlocks.clear();
        this.nextStateBlockId = 1;
        this.isRecordingStateBlock = false;
        this.recordingStateBlock = null;
    }

    setParentD3(addr: number): void {
        swapDeviceComRef(this.parentD3Addr, addr);
        this.parentD3Addr = addr;
    }

    getParentD3(): number {
        return this.parentD3Addr;
    }

    setRenderTarget(addr: number): void {
        this.renderTargetAddr = addr;
    }

    getRenderTarget(): number {
        return this.renderTargetAddr;
    }

    setCurrentViewport(addr: number): void {
        swapDeviceComRef(this.currentViewportAddr, addr);
        this.currentViewportAddr = addr;
    }

    getCurrentViewport(): number {
        return this.currentViewportAddr;
    }

    setViewportData(v: Device7Viewport | null): void {
        this.viewportData = v;
    }

    getViewportData(): Device7Viewport | null {
        return this.viewportData;
    }

    setTexture(stage: number, addr: number): void {
        if (this._destroying) return;
        if (stage >= 0 && stage < 8) {
            this.textureAddrs[stage] = addr;
        }
    }

    getTexture(stage: number): number {
        return this.textureAddrs[stage] || 0;
    }

    setRenderState(state: number, value: number): void {
        if (state < 0 || state >= 256) return;
        if (state === D3DRENDERSTATE_TEXTUREMAPBLEND) {
            this.renderStates[D3DRENDERSTATE_TEXTUREMAPBLEND] = value;
            translateTexMapBlend(this.textureStageStates, value);
        } else if (this.renderStates[state] !== value) {
            if (state === 27 || state === 15 || state === 19 || state === 20 || state === 25 || state === 41 || state === 137 || state === 139 || state === 145) {
                // 137=LIGHTING, 139=AMBIENT, 145=DIFFUSEMATERIALSOURCE (relevant for FFP lighting)
                Logger.verbose(LogCategory.DDRAW, `SetRenderState(Dev7): [${state}] ${value} (was ${this.renderStates[state]})`);
            }
            this.renderStates[state] = value;
        }
    }

    getRenderState(state: number): number {
        return this.renderStates[state] || 0;
    }

    private setTextureStageStateRaw(stage: number, type: number, value: number): void {
        if (stage >= 0 && stage < 8 && type >= 0 && type < 32) {
            const idx = stage * 32 + type;
            if (this.textureStageStates[idx] !== value) {
                this.textureStageStates[idx] = value;
            }
        }
    }

    setTextureStageState(stage: number, type: number, value: number): void {
        // D3DTSS_ADDRESS (DX6/DX7) is a combined state: sets both U and V address modes.
        // Slot 12 is also stored so GetTextureStageState(D3DTSS_ADDRESS) returns the
        // last combined value (matches pre-fan-out behavior).
        if (type === D3DTSS_ADDRESS) {
            this.setTextureStageStateRaw(stage, D3DTSS_ADDRESSU, value);
            this.setTextureStageStateRaw(stage, D3DTSS_ADDRESSV, value);
            this.setTextureStageStateRaw(stage, D3DTSS_ADDRESS, value);
            return;
        }
        this.setTextureStageStateRaw(stage, type, value);
    }

    getTextureStageState(stage: number, type: number): number {
        if (stage >= 0 && stage < 8 && type >= 0 && type < 32) {
            return this.textureStageStates[stage * 32 + type];
        }
        return 0;
    }

    getAllRenderStates(): Int32Array {
        return this.renderStates;
    }

    getAllTextureStageStates(): Int32Array {
        return this.textureStageStates;
    }

    getTextureStageStates(): Int32Array {
        return this.textureStageStates;
    }

    setTransform(type: number, matrix: Float32Array): void {
        // D3D3: D3DTRANSFORMSTATE_WORLD=1, VIEW=2, PROJECTION=3
        // D3D7: D3DTS_WORLD=256, VIEW=2, PROJECTION=3
        if (type === 1 || type === 256) { // D3DTRANSFORMSTATE_WORLD (D3D3) or D3DTS_WORLD (D3D7)
            this.worldMatrix.set(matrix);
            this.transformVersion++;
        } else if (type === 2) { // D3DTS_VIEW
            this.viewMatrix.set(matrix);
            this.transformVersion++;
        } else if (type === 3) { // D3DTS_PROJECTION
            this.projMatrix.set(matrix);
            this.transformVersion++;
        }
    }

    getTransform(type: number): Float32Array | null {
        if (type === 1 || type === 256) { // D3DTRANSFORMSTATE_WORLD (D3D3) or D3DTS_WORLD (D3D7)
            return this.worldMatrix;
        } else if (type === 2) { // D3DTS_VIEW
            return this.viewMatrix;
        } else if (type === 3) { // D3DTS_PROJECTION
            return this.projMatrix;
        }
        return null;
    }

    getWorldMatrix(): Float32Array {
        return this.worldMatrix;
    }

    getViewMatrix(): Float32Array {
        return this.viewMatrix;
    }

    getProjMatrix(): Float32Array {
        return this.projMatrix;
    }

    getTransformVersion(): number {
        return this.transformVersion;
    }

    /**
     * Get cached MVP matrix, recalculating only if transforms changed.
     * Returns null if any of world/view/proj is missing.
     */
    getCachedMVP(): Float32Array | null {
        if (this.cachedMVPVersion === this.transformVersion) {
            return this.cachedMVP;
        }

        const world = this.worldMatrix;
        const view = this.viewMatrix;
        const proj = this.projMatrix;

        // Multiply world * view
        const wv = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            const ai0 = world[i * 4 + 0], ai1 = world[i * 4 + 1], ai2 = world[i * 4 + 2], ai3 = world[i * 4 + 3];
            wv[i * 4 + 0] = ai0 * view[0] + ai1 * view[4] + ai2 * view[8] + ai3 * view[12];
            wv[i * 4 + 1] = ai0 * view[1] + ai1 * view[5] + ai2 * view[9] + ai3 * view[13];
            wv[i * 4 + 2] = ai0 * view[2] + ai1 * view[6] + ai2 * view[10] + ai3 * view[14];
            wv[i * 4 + 3] = ai0 * view[3] + ai1 * view[7] + ai2 * view[11] + ai3 * view[15];
        }

        // Multiply wv * proj into cachedMVP
        for (let i = 0; i < 4; i++) {
            const ai0 = wv[i * 4 + 0], ai1 = wv[i * 4 + 1], ai2 = wv[i * 4 + 2], ai3 = wv[i * 4 + 3];
            this.cachedMVP[i * 4 + 0] = ai0 * proj[0] + ai1 * proj[4] + ai2 * proj[8] + ai3 * proj[12];
            this.cachedMVP[i * 4 + 1] = ai0 * proj[1] + ai1 * proj[5] + ai2 * proj[9] + ai3 * proj[13];
            this.cachedMVP[i * 4 + 2] = ai0 * proj[2] + ai1 * proj[6] + ai2 * proj[10] + ai3 * proj[14];
            this.cachedMVP[i * 4 + 3] = ai0 * proj[3] + ai1 * proj[7] + ai2 * proj[11] + ai3 * proj[15];
        }

        this.cachedMVPVersion = this.transformVersion;
        return this.cachedMVP;
    }

    // --- Lighting system methods ---

    setMaterial(mat: D3DMaterial7Data): void {
        this.material = mat;
        this.materialSet = true;
    }

    isMaterialSet(): boolean {
        return this.materialSet;
    }

    getMaterial(): D3DMaterial7Data {
        return this.material;
    }

    setLight(index: number, light: D3DLight7Data): void {
        this.lights.set(index, light);
    }

    getLight(index: number): D3DLight7Data | null {
        return this.lights.get(index) ?? null;
    }

    setLightEnabled(index: number, enabled: boolean): void {
        if (enabled) {
            this.lightsEnabled.add(index);
        } else {
            this.lightsEnabled.delete(index);
        }
    }

    isLightEnabled(index: number): boolean {
        return this.lightsEnabled.has(index);
    }

    getAllLights(): Map<number, D3DLight7Data> {
        return this.lights;
    }
    getEnabledLights(): Set<number> {
        return this.lightsEnabled;
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
        // Collect enabled lights, sorted by index for deterministic behavior
        const sortedIndices = Array.from(this.lightsEnabled).sort((a, b) => a - b);
        for (const index of sortedIndices) {
            const light = this.lights.get(index);
            if (light) {
                enabledLights.push(light);
            }
            if (enabledLights.length >= 8) break; // Hard limit for emulation
        }

        return {
            lightingEnabled,
            material: this.material,
            lights: enabledLights,
            ambientColor,
            worldMatrix: this.worldMatrix,
            worldViewMatrix: this.computeWorldView(),
            viewMatrix: this.viewMatrix,
            diffuseSource: this.renderStates[D3DRENDERSTATE_DIFFUSEMATERIALSOURCE] ?? 0,
            ambientSource: this.renderStates[D3DRENDERSTATE_AMBIENTMATERIALSOURCE] ?? 0,
            specularSource: this.renderStates[D3DRENDERSTATE_SPECULARMATERIALSOURCE] ?? 0,
            emissiveSource: this.renderStates[D3DRENDERSTATE_EMISSIVEMATERIALSOURCE] ?? 0,
        };
    }

    /** World×View (camera/eye space) for D3DTSS_TCI_CAMERASPACE* texgen. Row-major,
     *  same convention as getCachedMVP's world*view step. */
    private computeWorldView(): Float32Array {
        const world = this.worldMatrix;
        const view = this.viewMatrix;
        const wv = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            const ai0 = world[i * 4 + 0], ai1 = world[i * 4 + 1], ai2 = world[i * 4 + 2], ai3 = world[i * 4 + 3];
            wv[i * 4 + 0] = ai0 * view[0] + ai1 * view[4] + ai2 * view[8] + ai3 * view[12];
            wv[i * 4 + 1] = ai0 * view[1] + ai1 * view[5] + ai2 * view[9] + ai3 * view[13];
            wv[i * 4 + 2] = ai0 * view[2] + ai1 * view[6] + ai2 * view[10] + ai3 * view[14];
            wv[i * 4 + 3] = ai0 * view[3] + ai1 * view[7] + ai2 * view[11] + ai3 * view[15];
        }
        return wv;
    }

    // --- State block methods ---

    isRecording(): boolean {
        return this.isRecordingStateBlock;
    }

    beginStateBlock(): void {
        this.isRecordingStateBlock = true;
        this.recordingStateBlock = {
            id: 0, // Will be assigned on EndStateBlock
            renderStates: new Int32Array(256),
            textureStageStates: new Int32Array(8 * 32),
            textures: new Array(8).fill(0),
            transforms: { world: null, view: null, projection: null },
            material: null,
            lights: new Map(),
            lightsEnabled: new Set(),
            viewport: null,
        };
    }

    endStateBlock(): number {
        if (!this.isRecordingStateBlock || !this.recordingStateBlock) {
            return 0;
        }
        const id = this.nextStateBlockId++;
        this.recordingStateBlock.id = id;
        this.stateBlocks.set(id, this.recordingStateBlock);
        this.isRecordingStateBlock = false;
        this.recordingStateBlock = null;
        return id;
    }

    createStateBlock(type: number): number {
        // Create a state block from current state
        const id = this.nextStateBlockId++;
        const block: D3DStateBlock = {
            id,
            renderStates: new Int32Array(this.renderStates),
            textureStageStates: new Int32Array(this.textureStageStates),
            textures: [...this.textureAddrs],
            transforms: {
                world: new Float32Array(this.worldMatrix),
                view: new Float32Array(this.viewMatrix),
                projection: new Float32Array(this.projMatrix),
            },
            material: { ...this.material, diffuse: { ...this.material.diffuse }, ambient: { ...this.material.ambient }, specular: { ...this.material.specular }, emissive: { ...this.material.emissive } },
            lights: new Map(Array.from(this.lights.entries()).map(([k, v]) => [k, { ...v, diffuse: { ...v.diffuse }, specular: { ...v.specular }, ambient: { ...v.ambient }, position: { ...v.position }, direction: { ...v.direction } }])),
            lightsEnabled: new Set(this.lightsEnabled),
            viewport: this.viewportData ? { ...this.viewportData } : null,
        };
        this.stateBlocks.set(id, block);
        return id;
    }

    captureStateBlock(handle: number): boolean {
        const block = this.stateBlocks.get(handle);
        if (!block) return false;
        // Update block with current state
        block.renderStates.set(this.renderStates);
        block.textureStageStates.set(this.textureStageStates);
        block.textures = [...this.textureAddrs];
        block.transforms.world = new Float32Array(this.worldMatrix);
        block.transforms.view = new Float32Array(this.viewMatrix);
        block.transforms.projection = new Float32Array(this.projMatrix);
        block.material = { ...this.material, diffuse: { ...this.material.diffuse }, ambient: { ...this.material.ambient }, specular: { ...this.material.specular }, emissive: { ...this.material.emissive } };
        block.lights = new Map(Array.from(this.lights.entries()).map(([k, v]) => [k, { ...v, diffuse: { ...v.diffuse }, specular: { ...v.specular }, ambient: { ...v.ambient }, position: { ...v.position }, direction: { ...v.direction } }]));
        block.lightsEnabled = new Set(this.lightsEnabled);
        block.viewport = this.viewportData ? { ...this.viewportData } : null;
        return true;
    }

    applyStateBlock(handle: number): boolean {
        const block = this.stateBlocks.get(handle);
        if (!block) return false;
        // Restore state from block
        this.renderStates.set(block.renderStates);
        this.textureStageStates.set(block.textureStageStates);
        this.textureAddrs = [...block.textures];
        if (block.transforms.world) this.worldMatrix.set(block.transforms.world);
        if (block.transforms.view) this.viewMatrix.set(block.transforms.view);
        if (block.transforms.projection) this.projMatrix.set(block.transforms.projection);
        if (block.material) {
            this.material = { ...block.material, diffuse: { ...block.material.diffuse }, ambient: { ...block.material.ambient }, specular: { ...block.material.specular }, emissive: { ...block.material.emissive } };
        }
        this.lights = new Map(Array.from(block.lights.entries()).map(([k, v]) => [k, { ...v, diffuse: { ...v.diffuse }, specular: { ...v.specular }, ambient: { ...v.ambient }, position: { ...v.position }, direction: { ...v.direction } }]));
        this.lightsEnabled = new Set(block.lightsEnabled);
        if (block.viewport) {
            this.viewportData = { ...block.viewport };
        }
        return true;
    }

    deleteStateBlock(handle: number): boolean {
        return this.stateBlocks.delete(handle);
    }

    protected destroy(): void {
        this._destroying = true;
        const resourceProvider = SystemResourceProvider.getInstance();

        // Release bound textures
        for (let stage = 0; stage < 8; stage++) {
            const addr = this.textureAddrs[stage];
            if (addr) {
                const texObj = resourceProvider.getComObjectByAddress(addr);
                if (texObj) {
                    const state = (texObj as any).state || (texObj as any).getState?.();
                    if (state?.boundByDevices) {
                        const key = `${this.handle}:${stage}`;
                        state.boundByDevices.delete(key);
                    }
                    texObj.release();
                }
                this.textureAddrs[stage] = 0;
            }
        }

        // Release render target
        if (this.renderTargetAddr) {
            const rtObj = resourceProvider.getComObjectByAddress(this.renderTargetAddr);
            if (rtObj) {
                rtObj.release();
            }
            this.renderTargetAddr = 0;
        }

        Logger.log(LogCategory.COM, "Direct3DDevice7Object cascade destroy complete");
    }
}

/**
 * Direct3DDevice2 COM object implementation (minimal stub).
 */
export class Direct3DDevice2Object extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IDirect3DDevice2, vtableAddress);
    }

    protected get leakOnZeroRef(): boolean { return true; }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3DDevice2Object destroyed");
    }
}

/**
 * Direct3DDevice COM object implementation (minimal stub).
 */
export class Direct3DDeviceObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IDirect3DDevice, vtableAddress);
    }

    protected get leakOnZeroRef(): boolean { return true; }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "Direct3DDeviceObject destroyed");
    }
}

/** D3DEXECUTEDATA — where the vertices and the instruction stream sit inside the buffer. */
export interface ExecuteData {
    vertexOffset: number;
    vertexCount: number;
    instructionOffset: number;
    instructionLength: number;
    hVertexOffset: number;
    /** D3DSTATUS the interpreter branches on; D3DOP_SETSTATUS writes it and
     *  GetExecuteData hands it back to the app. */
    statusFlags: number;
    status: number;
    statusExtent: { left: number; top: number; right: number; bottom: number };
}

/**
 * Direct3DExecuteBuffer COM object — a guest-visible byte buffer plus the
 * D3DEXECUTEDATA describing it. The guest Locks it, writes vertices and an
 * opcode stream, then hands it to IDirect3DDevice::Execute.
 */
export class Direct3DExecuteBufferObject extends BaseComObject {
    private dataAddr = 0;
    private dataSize = 0;
    private locked = false;
    private execData: ExecuteData = {
        vertexOffset: 0, vertexCount: 0, instructionOffset: 0, instructionLength: 0, hVertexOffset: 0,
        statusFlags: 0, status: 0, statusExtent: { left: 0, top: 0, right: 0, bottom: 0 },
    };

    constructor(vtableAddress: number) {
        super(IID_IDirect3DExecuteBuffer, vtableAddress);
    }

    setData(addr: number, size: number): void {
        this.dataAddr = addr;
        this.dataSize = size;
    }
    getDataAddr(): number { return this.dataAddr; }
    getDataSize(): number { return this.dataSize; }

    setLocked(v: boolean): void { this.locked = v; }
    isLocked(): boolean { return this.locked; }

    setExecuteData(d: ExecuteData): void { this.execData = d; }
    getExecuteData(): ExecuteData { return this.execData; }

    protected destroy(): void {
        if (this.dataAddr) {
            System.getInstance().process?.memory?.free(this.dataAddr);
            this.dataAddr = 0;
        }
        Logger.verbose(LogCategory.COM, "Direct3DExecuteBufferObject destroyed");
    }
}

/**
 * Direct3DTexture COM object — thin wrapper delegating IUnknown to parent surface (COM identity).
 */
export class Direct3DTextureObject extends BaseComObject {
    private surfaceHandle: number = 0; // Handle of parent DirectDrawSurfaceObject for lifetime management

    constructor(vtableAddress: number, surfaceHandle: number) {
        super(IID_IDirect3DTexture, vtableAddress);
        this.surfaceHandle = surfaceHandle;

        if (!this.surfaceHandle) {
            Logger.warn(LogCategory.COM, `Direct3DTextureObject: No surfaceHandle provided!`);
        }
    }

    // `ifacePtr` must be forwarded, not dropped: the base tracks per-interface references by
    // the pointer the guest holds, and an arity-0 override silently discards it — which
    // TypeScript accepts. Delegation goes to the parent surface, so the pointer travels there.
    addRef(ifacePtr = 0): number {
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const surfaceObj = resourceProvider.getComObject(this.surfaceHandle);
            if (surfaceObj) {
                return surfaceObj.addRef(ifacePtr);
            }
        }
        // Fallback: increment our own refcount if surface not found (shouldn't happen)
        return super.addRef(ifacePtr);
    }

    release(ifacePtr = 0): number {
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const surfaceObj = resourceProvider.getComObject(this.surfaceHandle);
            if (surfaceObj) {
                return surfaceObj.release(ifacePtr);
            }
        }
        // Fallback: decrement our own refcount if surface not found (shouldn't happen)
        return super.release(ifacePtr);
    }

    queryInterface(riid: string, ppvObject: number, memory: Uint8Array): number {
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const surfaceObj = resourceProvider.getComObject(this.surfaceHandle);
            if (surfaceObj) {
                // Delegate to surface's QueryInterface - it knows about all supported interfaces
                return surfaceObj.queryInterface(riid, ppvObject, memory);
            }
        }
        // Fallback: use our own QueryInterface if surface not found
        return super.queryInterface(riid, ppvObject, memory);
    }

    getSurfaceAddr(): number {
        // Get address dynamically via handle to avoid desynchronization
        // In emulators with dynamic memory, object address in guest memory may change
        // (e.g., when memory blocks are moved), but handle in ResourceProvider remains constant.
        // This solves the problem of "stale" pointers and is the gold standard for emulators.
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const address = resourceProvider.getAddressForHandle(this.surfaceHandle);
            if (address !== null) {
                return address;
            }
        }
        return 0;
    }

    setSurfaceHandle(handle: number): void {
        this.surfaceHandle = handle;
    }

    getSurfaceHandle(): number {
        return this.surfaceHandle;
    }

    protected destroy(): void {
        // Refcount owned by parent surface; clear cached texture handle if we run anyway.
        // Clear cache in parent Surface (best-effort cleanup)
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const surfaceObj = resourceProvider.getComObject(this.surfaceHandle) as DirectDrawSurfaceObject | null;
            if (surfaceObj) {
                // Clear the cached texture handle so QueryInterface will create new object if needed
                surfaceObj.setCachedTextureHandle(0);
            }
        }
        Logger.verbose(LogCategory.COM, "Direct3DTextureObject destroyed (cache cleared)");
    }
}

/**
 * Direct3DTexture2 COM object — thin wrapper delegating IUnknown to parent surface (COM identity).
 */
export class Direct3DTexture2Object extends BaseComObject {
    private surfaceHandle: number = 0; // Handle of parent DirectDrawSurfaceObject for lifetime management

    constructor(vtableAddress: number, surfaceHandle: number) {
        super(IID_IDirect3DTexture2, vtableAddress);
        this.surfaceHandle = surfaceHandle;

        if (!this.surfaceHandle) {
            Logger.warn(LogCategory.COM, `Direct3DTexture2Object: No surfaceHandle provided!`);
        }
    }

    // `ifacePtr` must be forwarded, not dropped: the base tracks per-interface references by
    // the pointer the guest holds, and an arity-0 override silently discards it — which
    // TypeScript accepts. Delegation goes to the parent surface, so the pointer travels there.
    addRef(ifacePtr = 0): number {
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const surfaceObj = resourceProvider.getComObject(this.surfaceHandle);
            if (surfaceObj) {
                return surfaceObj.addRef(ifacePtr);
            }
        }
        // Fallback: increment our own refcount if surface not found (shouldn't happen)
        return super.addRef(ifacePtr);
    }

    release(ifacePtr = 0): number {
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const surfaceObj = resourceProvider.getComObject(this.surfaceHandle);
            if (surfaceObj) {
                return surfaceObj.release(ifacePtr);
            }
        }
        // Fallback: decrement our own refcount if surface not found (shouldn't happen)
        return super.release(ifacePtr);
    }

    queryInterface(riid: string, ppvObject: number, memory: Uint8Array): number {
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const surfaceObj = resourceProvider.getComObject(this.surfaceHandle);
            if (surfaceObj) {
                // Delegate to surface's QueryInterface - it knows about all supported interfaces
                return surfaceObj.queryInterface(riid, ppvObject, memory);
            }
        }
        // Fallback: use our own QueryInterface if surface not found
        return super.queryInterface(riid, ppvObject, memory);
    }

    getSurfaceAddr(): number {
        // Get address dynamically via handle to avoid desynchronization
        // In emulators with dynamic memory, object address in guest memory may change
        // (e.g., when memory blocks are moved), but handle in ResourceProvider remains constant.
        // This solves the problem of "stale" pointers and is the gold standard for emulators.
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const address = resourceProvider.getAddressForHandle(this.surfaceHandle);
            if (address !== null) {
                return address;
            }
        }
        return 0;
    }

    setSurfaceHandle(handle: number): void {
        this.surfaceHandle = handle;
    }

    getSurfaceHandle(): number {
        return this.surfaceHandle;
    }

    protected destroy(): void {
        // Refcount owned by parent surface; clear cached texture handle if we run anyway.
        // Clear cache in parent Surface (best-effort cleanup)
        if (this.surfaceHandle) {
            const resourceProvider = SystemResourceProvider.getInstance();
            const surfaceObj = resourceProvider.getComObject(this.surfaceHandle) as DirectDrawSurfaceObject | null;
            if (surfaceObj) {
                // Clear the cached texture handle so QueryInterface will create new object if needed
                surfaceObj.setCachedTexture2Handle(0);
            }
        }
        Logger.verbose(LogCategory.COM, "Direct3DTexture2Object destroyed (cache cleared)");
    }
}

/**
 * IDirectDrawGammaControl COM object implementation.
 * Provides gamma ramp get/set for primary surfaces.
 * Currently a stub (identity ramp / log-only set).
 */
export class DirectDrawGammaControlObject extends BaseComObject {
    private surfaceHandle: number;

    constructor(vtableAddress: number, surfaceHandle: number) {
        super(IID_IDirectDrawGammaControl, vtableAddress);
        this.surfaceHandle = surfaceHandle;
    }

    getSurfaceHandle(): number {
        return this.surfaceHandle;
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectDrawGammaControlObject destroyed");
    }
}

/**
 * IDirect3DVertexBuffer COM object implementation (DX6).
 * Manages a guest-memory vertex data buffer.
 */
export class Direct3DVertexBufferObject extends BaseComObject {
    private dataPtr: number = 0;
    private fvf: number = 0;
    private numVertices: number = 0;
    private caps: number = 0;
    private vertexSize: number = 0;
    private locked: boolean = false;
    /** 3 for IDirect3D3::CreateVertexBuffer, 7 for IDirect3D7 — ProcessVertices lights differently. */
    private interfaceVersion: 3 | 7 = 3;

    constructor(vtableAddress: number) {
        super(IID_IDirect3DVertexBuffer, vtableAddress);
    }

    setBufferInfo(dataPtr: number, fvf: number, numVertices: number, caps: number, vertexSize: number): void {
        this.dataPtr = dataPtr;
        this.fvf = fvf;
        this.numVertices = numVertices;
        this.caps = caps;
        this.vertexSize = vertexSize;
    }

    setInterfaceVersion(v: 3 | 7): void { this.interfaceVersion = v; }
    getInterfaceVersion(): 3 | 7 { return this.interfaceVersion; }

    beginLock(): void { this.locked = true; }
    /** Returns false for an Unlock with no matching Lock (real ddraw still reports D3D_OK). */
    endLock(): boolean {
        const wasLocked = this.locked;
        this.locked = false;
        return wasLocked;
    }
    isLocked(): boolean { return this.locked; }

    getDataPtr(): number { return this.dataPtr; }
    getFVF(): number { return this.fvf; }
    getNumVertices(): number { return this.numVertices; }
    getCaps(): number { return this.caps; }
    getVertexSize(): number { return this.vertexSize; }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, `Direct3DVertexBufferObject destroyed (data=0x${this.dataPtr.toString(16)})`);
    }
}
