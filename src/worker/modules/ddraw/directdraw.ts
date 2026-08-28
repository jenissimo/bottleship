import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { assignStubsOnce } from "../../core/thunking/stub-merge";
import { Marshaler } from "../../core/memory/marshaler";
import { ComObjectFactory } from "../../core/com/base-com-object";
import { allocateComObject, checkComGuard, COM_OBJECT_SIZE } from "../../core/com/com-memory";
import { System } from "../../core/system";
import { DDrawContext } from "./context";
import { memoryWatch } from "../../core/memory/memory-watch";
import {
    EMU_DDRAW_DEFAULT_CAPS,
    DDCAPS2_CANRENDERWINDOWED,
    MEM_SURFACE_BASE,
    MEM_SURFACE_SIZE,
} from "../../core/cpu/emulator-config";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { framePacer } from "../../core/frame-pacer";
import { initReturnPtr } from "../../backends/webgpu/shared/dx-com-helpers";
import { getSurfaceFormatLayout } from "../../backends/webgpu/shared/texture-formats";
import {
    DEFAULT_VENDOR_ID,
    DEFAULT_DEVICE_ID,
    DEFAULT_DRIVER_VERSION,
    DEFAULT_DEVICE_DESC,
    DEFAULT_DRIVER_DLL,
} from "../../backends/webgpu/shared/dx-adapter-identifier";
import {
    DD_OK,
    DDBD_16,
    DDBD_32,
    DDCAPS_OFFSETS,
    DDCAPS_SIZE_V7,
    DDERR_SURFACELOST,
    DDSCAPS_COMBINED_3D,
    CKCAPS_COMBINED,
    DDFXCAPS_COMBINED,
    DDPCAPS_COMBINED,
    DDDEVICEIDENTIFIER_SIZE,
    DDDEVICEIDENTIFIER2_SIZE,
    DDDEVICEIDENTIFIER2_OFFSETS,
    DDDEVICEIDENTIFIER2_STRING_SIZE,
    DDSD_CAPS,
    DDSD_LPSURFACE,
    DDSD_PITCH,
    DDSD_PIXELFORMAT,
    DDERR_INVALIDPARAMS,
    DDERR_NOTFOUND,
    DDERR_OUTOFVIDEOMEMORY,
    DDSCAPS_ALLOCONLOAD,
    DDSCAPS_BACKBUFFER,
    DDSCAPS_COMPLEX,
    DDSCAPS_FLIP,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_TEXTURE,
    DDSCAPS_MIPMAP,
    DDSCAPS_3DDEVICE,
    DDSCAPS_VIDEOMEMORY,
    DDSURFACEDESC_SIZE,
    DDSURFACEDESC2_SIZE,
    E_FAIL,
    E_INVALIDARG,
    E_NOINTERFACE,
    E_POINTER,
    HIGH_MEMORY_COM_AREA,
    DDPF_ALPHAPIXELS,
    IID_IDirectDraw,
    IID_IDirectDraw4,
    IID_IDirectDraw7,
    IID_IDirectDrawClipper,
    IID_IDirectDrawPalette,
    IID_IDirectDrawSurface,
    IID_IDirectDrawSurface4,
    IID_IDirectDrawSurface7,
    MIN_SURFACE_SIZE,
    STACK_CLEANUP_DIRECTDRAWENUMERATEA,
    STACK_CLEANUP_DIRECTDRAWENUMERATEEXA,
    STACK_CLEANUP_ENUMDISPLAYMODES,
    STACK_CLEANUP_ENUMSURFACES,
    DDENUMSURFACES_ALL,
    DDENUMSURFACES_MATCH,
    DDENUMSURFACES_DOESEXIST,
    DDWAITVB_BLOCKBEGIN,
    DDWAITVB_BLOCKEND,
    DDSD_WIDTH,
    DDSD_HEIGHT,
    DDSCL_NORMAL,
    DDSCL_EXCLUSIVE,
    DDSCL_FULLSCREEN,
    DDSURFACEDESC2_OFFSETS,
    DDPIXELFORMAT_OFFSETS,
    DDSCAPS_OFFSCREENPLAIN,
    DDSCAPS_LOCALVIDMEM,
    DDSCAPS_FRONTBUFFER,
} from "./constants";
import { bytesToGuid, surfaceAt } from "./helpers";
import { resolveDDrawTearOff } from "./com-tearoff";
import { isValidAddress, isSafeSurfaceAddress, overlapsThunkCode } from "../../core/memory/address-guard";
import { computePitch, normalizeSurfaceDesc, readSurfaceDesc, readSurfaceDescV1, writeDisplayModeDesc, writeDisplayModeDescV1, writeSurfaceDesc, writeSurfaceDescV1 } from "./structs";
import { rasterStatusAt } from "./raster-status";
import { DirectDrawSurfaceObject, DirectDrawSurfaceState, DirectDrawPaletteObject } from "./com-objects";
import { createGPUTexture, convertRGBAToSurface } from "./gpu-texture-utils";
import { gpuDeviceUsable } from "../../core/gpu/gpu-device-lifecycle";
import { restoreAllLostSurfaces } from "./surface-device-loss";
import { setAuthorityCpu, setAuthorityGpu, syncActiveGdiContext } from "./surface-sync";
import { createDirectDrawStubsExports } from "./directdraw-stubs";
import { createDirectDrawPaletteClipperExports } from "./directdraw-palette-clipper";
import { registerDirectDraw2Exports } from "./directdraw-v2";

import { windows as sharedWindows } from "../user32/shared-state";
import type { WindowInfo } from "../user32/shared-state";
import { resizeFullscreenWindowToMode } from "../../runtime/windowing/fullscreen-window";
import { repaintDialogOverlayIfVisible, requestGuestDialogPaint } from "../user32/dialog-paint";

type DDEnumCallback = (lpGUID: number, lpDriverDescription: number, lpDriverName: number, lpContext: number) => number;

/**
 * One log line per distinct DDPIXELFORMAT shape a title ever ASKS CreateSurface for, read
 * straight out of the guest descriptor. Deliberately upstream of readPixelFormat: a probe
 * placed after normalization can only ever report the format we decided on, so it cannot
 * distinguish "the title asked for RGB565" from "the title asked for DXT1 and we rewrote it".
 * dwSize is printed because an engine legitimately leaves it zero.
 */
const seenPixelFormatRequests = new Set<number>();
function notePixelFormatRequest(view: DataView, pfAddr: number): void {
    const size = view.getUint32(pfAddr + DDPIXELFORMAT_OFFSETS.size, true);
    const flags = view.getUint32(pfAddr + DDPIXELFORMAT_OFFSETS.flags, true);
    const fourCC = view.getUint32(pfAddr + DDPIXELFORMAT_OFFSETS.fourCC, true);
    const bpp = view.getUint32(pfAddr + DDPIXELFORMAT_OFFSETS.rgbBitCount, true);
    const key = ((flags ^ fourCC) >>> 0) * 65536 + ((bpp & 0xff) << 8) + (size & 0xff);
    if (seenPixelFormatRequests.has(key)) return;
    seenPixelFormatRequests.add(key);
    const tag = fourCC
        ? ` fourCC='${String.fromCharCode(fourCC & 0xff, (fourCC >>> 8) & 0xff, (fourCC >>> 16) & 0xff, (fourCC >>> 24) & 0xff)}'`
        : "";
    Logger.log(LogCategory.DDRAW,
        `CreateSurface REQUESTED ddpf: dwSize=${size} dwFlags=0x${flags.toString(16)} ` +
        `dwRGBBitCount=${bpp}${tag}`);
}

function resizeFullscreenWindow(system: System, width: number, height: number): void {
    const hwnd = system.ddrawContext?.cooperative.hwnd;
    if (!hwnd) return;
    resizeFullscreenWindowToMode(hwnd, width, height, "DDraw");
}

/**
 * Normalize the cooperative (exclusive-fullscreen) window to borderless-fullscreen at the
 * new display mode (faithful: DirectDraw resizes the focus window to the mode and brings it
 * to the front of the Z-order so it owns the screen). Without this the active window keeps
 * its WS_OVERLAPPEDWINDOW frame and a stale rect, which corrupts the windowed-vs-fullscreen
 * decision (the Unreal 1024x768 dead-cursor class).
 */
function normalizeExclusiveCoopWindow(system: System, ddrawCtx: DDrawContext, width: number, height: number): void {
    const hwnd = ddrawCtx.cooperative.hwnd;
    if (!hwnd) return;
    const wm = system.windowManager;
    const winObj = wm.getWindow(hwnd);
    if (winObj) {
        winObj.rect.x = 0;
        winObj.rect.y = 0;
        winObj.rect.w = width;
        winObj.rect.h = height;
        // Borderless-fullscreen: no client offset, owns the screen.
        winObj.clientOffsetX = 0;
        winObj.clientOffsetY = 0;
    }
    const sharedWin = sharedWindows.get(hwnd);
    if (sharedWin) {
        sharedWin.x = 0;
        sharedWin.y = 0;
        sharedWin.width = width;
        sharedWin.height = height;
    }
    // Bring to the top of the Z-order so the exclusive window owns hit-testing / paint.
    wm.bringWindowToTop(hwnd);
    Logger.log(LogCategory.DDRAW,
        `normalizeExclusiveCoopWindow: hwnd=0x${hwnd.toString(16)} -> borderless 0,0,${width}x${height} (brought to top)`);
}

/** Apply host resize + restore GDI launcher chrome after SetDisplayMode. */
function applyDisplayModeChange(system: System, ddrawCtx: DDrawContext, width: number, height: number): void {
    // SetDisplayMode IS a mode-set — this is the size SM_CXSCREEN must report from now on.
    system.requestHostResize(width, height, {
        modeSet: true, bpp: ddrawCtx.display.bpp, refreshRate: ddrawCtx.display.refresh,
    });
    // In exclusive/fullscreen, normalize the coop window to borderless-fullscreen at the
    // new mode and bring it to top; otherwise just track the size (resizeFullscreenWindow).
    if (ddrawCtx.cooperative.exclusive) {
        normalizeExclusiveCoopWindow(system, ddrawCtx, width, height);
    }
    resizeFullscreenWindow(system, width, height);
    const coopHwnd = ddrawCtx.cooperative.hwnd;
    const isDialogOverlayWindow = (win: WindowInfo): boolean => {
        return !!win.guestCustomPaint
            || (win.nativeClassName ?? '').toLowerCase() === '#32770';
    };
    if (coopHwnd) {
        const sharedWin = sharedWindows.get(coopHwnd);
        if (sharedWin && isDialogOverlayWindow(sharedWin)) {
            if (sharedWin.guestCustomPaint) {
                requestGuestDialogPaint(coopHwnd);
            } else {
                repaintDialogOverlayIfVisible(coopHwnd);
            }
            return;
        }
    }
    system.gdiContext.clearOverlay();
}

/**
 * Faithful SetDisplayMode core shared by all DDraw versions. Captures the prior mode on the
 * first exclusive entry (so RestoreDisplayMode can revert), mutates context.display, applies
 * the host resize + coop-window normalization, and — when the mode actually changed —
 * broadcasts WM_DISPLAYCHANGE to all top-level windows (the guest WinDrv keys its
 * windowed/fullscreen reconciliation off this).
 */
function applySetDisplayMode(
    system: System,
    ddrawCtx: DDrawContext,
    width: number,
    height: number,
    bpp: number,
    refresh: number
): void {
    const prevW = ddrawCtx.display.width;
    const prevH = ddrawCtx.display.height;
    const prevBpp = ddrawCtx.display.bpp;

    // On the FIRST exclusive SetDisplayMode (display still == desktop), snapshot the desktop
    // mode so RestoreDisplayMode can revert. We always keep desktopMode as the revert target;
    // it is set at boot/manifest and only re-baselined by updateDisplayFromConfig.

    if (width > 0 && height > 0) {
        ddrawCtx.display.width = width;
        ddrawCtx.display.height = height;
    }
    if (bpp > 0) ddrawCtx.display.bpp = bpp;
    ddrawCtx.display.refresh = refresh;

    applyDisplayModeChange(system, ddrawCtx, ddrawCtx.display.width, ddrawCtx.display.height);

    const changed = ddrawCtx.display.width !== prevW
        || ddrawCtx.display.height !== prevH
        || ddrawCtx.display.bpp !== prevBpp;
    if (changed) {
        system.windowManager.postDisplayChange(ddrawCtx.display.width, ddrawCtx.display.height, ddrawCtx.display.bpp);
    }
}

/**
 * Faithful RestoreDisplayMode: revert the current display mode back to the desktop mode,
 * resize the host, and broadcast WM_DISPLAYCHANGE if the mode actually changed. Returns the
 * screen to GDI (the caller also sets gdiSurfaceVisible).
 */
export function restoreDisplayModeToDesktop(system: System, ddrawCtx: DDrawContext): void {
    const prevW = ddrawCtx.display.width;
    const prevH = ddrawCtx.display.height;
    const prevBpp = ddrawCtx.display.bpp;

    ddrawCtx.display.width = ddrawCtx.desktopMode.width;
    ddrawCtx.display.height = ddrawCtx.desktopMode.height;
    ddrawCtx.display.bpp = ddrawCtx.desktopMode.bpp;
    ddrawCtx.display.refresh = ddrawCtx.desktopMode.refresh;

    // RestoreDisplayMode returns the desktop mode — also a mode-set, back to the original.
    system.requestHostResize(ddrawCtx.display.width, ddrawCtx.display.height, {
        modeSet: true, bpp: ddrawCtx.desktopMode.bpp, refreshRate: ddrawCtx.desktopMode.refresh,
    });

    const changed = ddrawCtx.display.width !== prevW
        || ddrawCtx.display.height !== prevH
        || ddrawCtx.display.bpp !== prevBpp;
    Logger.log(LogCategory.DDRAW,
        `RestoreDisplayMode -> desktop ${ddrawCtx.display.width}x${ddrawCtx.display.height}x${ddrawCtx.display.bpp} (changed=${changed})`);
    if (changed) {
        system.windowManager.postDisplayChange(ddrawCtx.display.width, ddrawCtx.display.height, ddrawCtx.display.bpp);
    }
}

export const createDirectDrawExports = (context: DDrawContext): Record<string, ThunkImplementation> => {
    const exports: Record<string, ThunkImplementation> = {};
    let lastVblankLog = 0;
    let vblankWaitCount = 0;
    let vblankStatusCount = 0;
    let scanlineCount = 0;

    const getVTable = (name: string) => (context.vtables as any)[name]?.address;

    // --- Common QueryInterface for tear-off interface support ---
    const commonQueryInterface = (thisPtr: number, riidPtr: number, ppvObject: number, mem: Uint8Array): number => {
        if (!ppvObject || !isValidAddress(mem, ppvObject, 4)) return E_POINTER;
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr);
        if (!obj) return E_NOINTERFACE;

        const iidStr = bytesToGuid(mem.slice(riidPtr, riidPtr + 16));
        const iidNorm = iidStr.replace(/[{}]/g, "").toLowerCase();

        // Every DirectDraw generation and the Direct3D interface of that generation live on
        // this one object; each needs its own vtable (method counts differ: IDirectDraw=23,
        // IDirectDraw2=24, IDirectDraw4=25, IDirectDraw7=27) but the same identity.
        const tearOff = resolveDDrawTearOff(context, obj, iidNorm, ppvObject, mem);
        if (tearOff !== null) return tearOff;

        return obj.queryInterface(iidStr, ppvObject, mem);
    };

    // --- Unified surface creation (v1-v7) ---
    // Handles all surface creation logic including backbuffers, VRAM accounting, GPU textures
    const internalCreateSurface = (
        mem: Uint8Array, 
        lpDesc: number, 
        lplpSurf: number, 
        vtableName: string,
        options?: { threadId?: number; enableDiagnostics?: boolean; surfaceIid?: string; ownerAddr?: number }
    ): number => {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const threadId = options?.threadId ?? 0;
        const enableDiagnostics = options?.enableDiagnostics ?? false;
        // Every surface of the chain remembers the IDirectDraw interface it came from,
        // so GetDDInterface can hand back that same version.
        const ownerAddr = options?.ownerAddr ?? 0;

        if (!lplpSurf || !isValidAddress(mem, lplpSurf, 4)) return E_POINTER;
        initReturnPtr(lplpSurf);

        const vtableAddr = getVTable(vtableName);
        if (!vtableAddr) {
            Logger.warn(LogCategory.SYSTEM, `${vtableName}: missing vtable`);
            view.setUint32(lplpSurf, 0, true);
            return DDERR_INVALIDPARAMS;
        }

        const rawDesc = lpDesc ? readSurfaceDesc(mem, lpDesc) : null;
        if (!rawDesc) {
            view.setUint32(lplpSurf, 0, true);
            return E_INVALIDARG;
        }

        if (lpDesc && (rawDesc.flags & DDSD_PIXELFORMAT) !== 0) {
            notePixelFormatRequest(view, lpDesc + DDSURFACEDESC2_OFFSETS.pixelFormat);
        }

        const isTexture = (rawDesc.caps & DDSCAPS_TEXTURE) !== 0;
        const isSystemMemory = (rawDesc.caps & DDSCAPS_SYSTEMMEMORY) !== 0;
        const isVideoMemory = (rawDesc.caps & DDSCAPS_VIDEOMEMORY) !== 0;
        const isPrimary = (rawDesc.caps & DDSCAPS_PRIMARYSURFACE) !== 0;
        const isBackBuffer = (rawDesc.caps & DDSCAPS_BACKBUFFER) !== 0;
        const isD3dRenderTarget = (rawDesc.caps & DDSCAPS_3DDEVICE) !== 0;

        if (enableDiagnostics) {
            if (isTexture && isSystemMemory) {
                const rawLpSurface = view.getUint32(lpDesc + 36, true);
                const hasFlag = (rawDesc.flags & DDSD_LPSURFACE) !== 0;
                Logger.log(LogCategory.DDRAW,
                    `CreateSurface SYSMEM texture ${rawDesc.width}x${rawDesc.height} ` +
                    `DDSD_LPSURFACE=${hasFlag} rawLpSurface=0x${rawLpSurface.toString(16)} ` +
                    `parsedSurfacePtr=0x${rawDesc.surfacePtr.toString(16)}`);
            }
            const pf = rawDesc.pixelFormat;
            const pfStr = pf ? `bpp=${pf.bpp} R=0x${pf.rMask.toString(16)} G=0x${pf.gMask.toString(16)} B=0x${pf.bMask.toString(16)} A=0x${pf.aMask.toString(16)} pflags=0x${pf.flags.toString(16)}` : 'none';
            Logger.log(LogCategory.DDRAW,
                `CreateSurface [TID=${threadId}]: caps=0x${rawDesc.caps.toString(16)} ${isTexture ? '[TEXTURE]' : ''} ` +
                `${isSystemMemory ? '[SYSMEM]' : ''} ${isVideoMemory ? '[VIDMEM]' : ''} ` +
                `${isPrimary ? '[PRIMARY]' : ''} ${isBackBuffer ? '[BACKBUFFER]' : ''} ${isD3dRenderTarget ? '[D3D]' : ''} ` +
                `size=${rawDesc.width}x${rawDesc.height} backbuffers=${rawDesc.backBufferCount} ` +
                `flags=0x${rawDesc.flags.toString(16)} inputLpSurface=0x${rawDesc.surfacePtr.toString(16)} ` +
                `pixelFormat=[${pfStr}]`
            );
        }

        // VRAM accounting
        let vidMemSize = 0;
        if (isVideoMemory && (isTexture || isPrimary || isBackBuffer || isD3dRenderTarget)) {
            const bytesPerPixel = Math.max(1, Math.floor((rawDesc.pixelFormat?.bpp || context.display.bpp) / 8));
            const vramSurfaceSize = rawDesc.width * rawDesc.height * bytesPerPixel;
            const vidMemTotal = EmulatorConfig.getInstance().ddrawCaps.dwVidMemTotal;

            if (context.usedVidMem + vramSurfaceSize > vidMemTotal) {
                Logger.warn(LogCategory.DDRAW, 
                    `CreateSurface: OUT OF VIDEO MEMORY! (used=${context.usedVidMem}, ` +
                    `requested=${vramSurfaceSize}, total=${vidMemTotal})`
                );
                view.setUint32(lplpSurf, 0, true);
                return DDERR_OUTOFVIDEOMEMORY;
            }
            context.usedVidMem += vramSurfaceSize;
            vidMemSize = vramSurfaceSize;
            Logger.log(LogCategory.DDRAW, 
                `CreateSurface: Allocated VRAM (${isTexture ? 'TEXTURE' : isPrimary ? 'PRIMARY' : isBackBuffer ? 'BACKBUFFER' : 'D3D'}), ` +
                `total used: ${(context.usedVidMem / 1024 / 1024).toFixed(2)} MB`
            );
        }

        const normalizedDesc = normalizeSurfaceDesc(rawDesc, context.display.width, context.display.height, context.display.bpp);

        // Detect primary surface size mismatch
        if ((rawDesc.caps & DDSCAPS_PRIMARYSURFACE) && rawDesc.width && rawDesc.height) {
            if (rawDesc.width !== context.display.width || rawDesc.height !== context.display.height) {
                Logger.warn(LogCategory.DDRAW,
                    `PRIMARY SURFACE SIZE MISMATCH! App requested: ${rawDesc.width}x${rawDesc.height}, ` +
                    `Display mode: ${context.display.width}x${context.display.height}. ` +
                    `Using display mode size (may cause rendering issues)`
                );
            }
        }

        const bytesPerPixel = Math.max(1, Math.floor(normalizedDesc.pixelFormat!.bpp / 8));
        const surfaceSize = Math.max(MIN_SURFACE_SIZE, normalizedDesc.pitch * normalizedDesc.height);
        let surfacePtr = normalizedDesc.surfacePtr;
        let isPtrValid = surfacePtr > 0 && isValidAddress(mem, surfacePtr, surfaceSize);

        // FIX: For SYSMEM textures, check if game provided lpSurface without DDSD_LPSURFACE flag.
        // Some games write the lpSurface field in the DDSURFACEDESC but don't set
        // the DDSD_LPSURFACE flag. readSurfaceDesc ignores lpSurface without the flag, leaving
        // surfacePtr=0. We then allocate our own buffer, but the game writes pixel data to ITS
        // buffer (the address it put in the descriptor). Result: Load() copies from our empty buffer.
        // Fix: read raw lpSurface from descriptor and use it if it looks valid.
        if (isTexture && isSystemMemory && !isPtrValid) {
            const rawLpSurface = view.getUint32(lpDesc + 36, true); // offset 36 = DDSURFACEDESC2.lpSurface
            // Only use if: non-null, not in our SURFACE allocation region (0x21-0x26),
            // within addressable memory, and passes safety checks
            const isInOurSurfaceRegion = rawLpSurface >= MEM_SURFACE_BASE && rawLpSurface < (MEM_SURFACE_BASE + MEM_SURFACE_SIZE);
            if (rawLpSurface > 0x10000 && !isInOurSurfaceRegion &&
                rawLpSurface + surfaceSize <= mem.length &&
                isValidAddress(mem, rawLpSurface, surfaceSize)) {
                Logger.warn(LogCategory.DDRAW,
                    `[CREATESURFACE-FIX] Using game's lpSurface=0x${rawLpSurface.toString(16)} ` +
                    `(no DDSD_LPSURFACE flag) for SYSMEM TEXTURE ${normalizedDesc.width}x${normalizedDesc.height} ` +
                    `size=0x${surfaceSize.toString(16)}`);
                surfacePtr = rawLpSurface;
                isPtrValid = true;
            }
        }

        if (enableDiagnostics) {
            if (surfacePtr && isPtrValid) {
                Logger.log(LogCategory.DDRAW, 
                    `CreateSurface [TID=${threadId}]: USING APP'S lpSurface=0x${surfacePtr.toString(16)} (size=${surfaceSize})`
                );
            } else if (surfacePtr && !isPtrValid) {
                Logger.warn(LogCategory.DDRAW, 
                    `CreateSurface [TID=${threadId}]: REJECTING APP'S lpSurface=0x${surfacePtr.toString(16)} ` +
                    `(isPtrValid=false, size=${surfaceSize})`
                );
            }
        }

        let didAllocateSurface = false;
        if (!surfacePtr || !isPtrValid) {
            if (enableDiagnostics) {
                let regions = null;
                try {
                    regions = context.process?.thunkMemoryManager?.getRegions() ?? null;
                } catch {}
                if (regions) {
                    Logger.warn(LogCategory.DDRAW,
                        `CreateSurface BEFORE alloc: THUNK_GENERATOR=0x${regions.thunkGeneratorBase.toString(16)}..` +
                        `0x${(regions.thunkGeneratorBase + regions.thunkGeneratorSize).toString(16)} ` +
                        `requesting size=0x${surfaceSize.toString(16)}`
                    );
                }
            }

            // VID_restart (Q2/ref_soft) may still touch old pixel buffers until the next
            // CreateSurface — flush any deferred frees from the previous session now.
            const ddrawMod = context.process.getModule("ddraw") as { flushDeferredSurfacePtrFrees?: () => void } | undefined;
            ddrawMod?.flushDeferredSurfacePtrFrees?.();

            try {
                surfacePtr = context.process.allocateSurface(surfaceSize);
            } catch (e) {
                // SURFACE bucket exhausted (most likely: 320 MB cap hit because of a
                // surface-lifetime leak elsewhere). On real HW DirectDraw returns
                // DDERR_OUTOFVIDEOMEMORY; game code is expected to handle that. Our
                // previous behaviour propagated the throw upward → surface COM object
                // never created → game read `[this+0x64]` on the NULL "out" pointer →
                // #PF at caller RVA 0x7bad5. Returning the error here preserves the
                // game's existing OOM path and keeps our address space sane.
                Logger.error(LogCategory.DDRAW,
                    `CreateSurface: allocateSurface(size=0x${surfaceSize.toString(16)}) failed: ${e}. ` +
                    `Returning DDERR_OUTOFVIDEOMEMORY.`);
                if (lplpSurf) view.setUint32(lplpSurf, 0, true);
                return DDERR_OUTOFVIDEOMEMORY;
            }
            if (!surfacePtr) {
                Logger.error(LogCategory.DDRAW,
                    `CreateSurface: allocateSurface(size=0x${surfaceSize.toString(16)}) returned 0. ` +
                    `Returning DDERR_OUTOFVIDEOMEMORY.`);
                if (lplpSurf) view.setUint32(lplpSurf, 0, true);
                return DDERR_OUTOFVIDEOMEMORY;
            }
            didAllocateSurface = true;

            if (enableDiagnostics && isTexture && isSystemMemory) {
                Logger.log(LogCategory.DDRAW,
                    `CreateSurface allocated surfacePtr=0x${surfacePtr.toString(16)} ` +
                    `size=0x${surfaceSize.toString(16)} SYSMEM texture ${normalizedDesc.width}x${normalizedDesc.height}`);
            }

            if (enableDiagnostics) {
                Logger.warn(LogCategory.DDRAW,
                    `CreateSurface AFTER alloc: memory.alloc() returned surfacePtr=0x${surfacePtr.toString(16)} ` +
                    `size=0x${surfaceSize.toString(16)} range=0x${surfacePtr.toString(16)}..` +
                    `0x${(surfacePtr + surfaceSize).toString(16)}`
                );
            }

            // Check if allocated address is safe for surface use
            if (!isSafeSurfaceAddress(surfacePtr, surfaceSize)) {
                Logger.error(LogCategory.DDRAW,
                    `🚨 CreateSurface: allocateSurface() returned unsafe address! ` +
                    `surfacePtr=0x${surfacePtr.toString(16)} size=0x${surfaceSize.toString(16)} ` +
                    `Address overlaps protected memory (THUNK_CODE or other protected region). ` +
                    `ABORTING to prevent corruption!`
                );
                view.setUint32(lplpSurf, 0, true);
                return E_FAIL;
            }

            if (!isValidAddress(mem, surfacePtr, surfaceSize)) {
                Logger.error(LogCategory.DDRAW,
                    `CreateSurface: memory.alloc() returned PROTECTED ADDRESS! ` +
                    `surfacePtr=0x${surfacePtr.toString(16)} size=0x${surfaceSize.toString(16)} ` +
                    `ABORTING fill to prevent thunk corruption!`
                );
                view.setUint32(lplpSurf, 0, true);
                return E_FAIL;
            }

            // Use guest address directly, not mem.byteOffset
            // Guest address should index from 0 of guest memory, not from byteOffset of Uint8Array view
            // mem is full view of guest memory starting at 0, so surfacePtr can be used directly
            //
            // Zero-fill ALL surfaces including SYSMEM textures!
            // Previous magenta debug fill broke IDirect3DTexture_Load deferred loading:
            // - Deferred loading waits for non-zero data to appear before copying
            // - Magenta fill (0xF81F) made surfaces appear "filled" immediately
            // - Load() would copy magenta instead of waiting for real texture data
            // - Result: text/sprites showed as magenta instead of actual textures
            if (surfacePtr >= 0 && surfacePtr + surfaceSize <= mem.length) {
                mem.fill(0, surfacePtr, surfacePtr + surfaceSize);
            }

            // Always log SYSMEM surfaces (especially cursor!) to catch THUNK_CODE overlap
            if (enableDiagnostics || isSystemMemory) {
                const overlaps = overlapsThunkCode(surfacePtr, surfaceSize);
                Logger.log(LogCategory.DDRAW,
                    `CreateSurface [TID=${threadId}]: ALLOCATED NEW surfacePtr=0x${surfacePtr.toString(16)} ` +
                    `size=0x${surfaceSize.toString(16)} caps=0x${normalizedDesc.caps.toString(16)} ` +
                    `${isSystemMemory ? 'SYSMEM' : ''} ${isTexture ? 'TEXTURE' : ''} ` +
                    `overlapsThunk=${overlaps} ${overlaps ? '🚨🚨🚨 DANGER!' : ''}`
                );
            }
        }

        // Diagnostic: Check if game provided surface has data
        // If surface was created with provided lpSurface, check if it has data
        // and set surfaceEverWritten flag accordingly
        let surfaceHasInitialData = false;
        if (isPtrValid && (isTexture || isSystemMemory) && surfaceSize > 0) {
            // Check multiple sample points to detect if surface has data
            // Don't just check first bytes - texture might start with zeros
            const samplePoints = [
                0,
                Math.floor(surfaceSize / 4),
                Math.floor(surfaceSize / 2),
                Math.floor(surfaceSize * 3 / 4),
                surfaceSize - Math.min(16, surfaceSize)
            ];
            
            for (const offset of samplePoints) {
                if (offset >= 0 && offset + 4 <= surfaceSize && surfacePtr + offset + 4 <= mem.length) {
                    const value = view.getUint32(surfacePtr + offset, true);
                    if (value !== 0) {
                        surfaceHasInitialData = true;
                        break;
                    }
                }
            }
            
            if (enableDiagnostics) {
                let sampleStr = "";
                for (let i = 0; i < Math.min(8, surfaceSize); i += 2) {
                    if (surfacePtr + i + 1 < mem.length) {
                        const px = view.getUint16(surfacePtr + i, true);
                        sampleStr += `0x${px.toString(16)} `;
                    }
                }
                Logger.log(LogCategory.DDRAW, 
                    `CreateSurface: surfacePtr=0x${surfacePtr.toString(16)} usedProvidedPtr=${!!(surfacePtr && isPtrValid)} ` +
                    `samplePixels: ${sampleStr} hasData=${surfaceHasInitialData}`
                );
            }
        }

        // DIAGNOSTIC: Check pitch calculation for alpha channel format
        const hasAlpha = (normalizedDesc.pixelFormat!.flags & DDPF_ALPHAPIXELS) !== 0;
        // Use stored pitch only if >= computed (allows row padding, rejects invalid)
        const expectedPitch = normalizedDesc.width * bytesPerPixel;
        const calculatedPitch = (normalizedDesc.pitch && normalizedDesc.pitch >= expectedPitch) ? normalizedDesc.pitch : expectedPitch;
        if (isTexture && hasAlpha && enableDiagnostics) {
            Logger.log(
                LogCategory.DDRAW,
                `CreateSurface PITCH CHECK: texture with alpha channel ` +
                `width=${normalizedDesc.width} bpp=${normalizedDesc.pixelFormat!.bpp} bytesPerPixel=${bytesPerPixel} ` +
                `normalizedDesc.pitch=${normalizedDesc.pitch} expectedPitch=${expectedPitch} ` +
                `calculatedPitch=${calculatedPitch} pitchMatch=${calculatedPitch === expectedPitch}`
            );
        }

        // CPU-First: Deterministic mode assignment
        // mode="GPU_ONLY" ONLY for pure 3D render targets (DDSCAPS_3DDEVICE)
        // mode="CPU" for everything else (default)
        // NOTE: Primary/backbuffer with 3DDEVICE must stay GPU_ONLY — D3D renders to GPU texture
        // and switching to CPU mode causes Flip to overwrite D3D content with zeros (black screen).
        // If a hybrid engine needs Lock(), the existing demotion logic in
        // IDirectDrawSurface7_Lock handles GPU_ONLY→CPU transition automatically.
        const initialMode: "CPU" | "GPU_ONLY" =
            (isD3dRenderTarget && !isSystemMemory) ? "GPU_ONLY" : "CPU";

        // Create RenderSurface (mutable surface for rendering, backbuffers, etc.)
        // CPU-First architecture: surfacePtr always authoritative, GPU is ephemeral cache
        const surfaceState: DirectDrawSurfaceState = {
            surfaceType: "render_surface",
            width: normalizedDesc.width,
            height: normalizedDesc.height,
            pitch: calculatedPitch,
            caps: normalizedDesc.caps,
            caps2: normalizedDesc.caps2,
            caps3: normalizedDesc.caps3,
            caps4: normalizedDesc.caps4,
            surfacePtr,
            surfacePtrAllocated: didAllocateSurface,
            format: normalizedDesc.pixelFormat!,
            attachedSurfaceAddr: 0,
            // CPU-First fields
            mode: initialMode,
            version: 0,
            gpuDirty: false, // Will be set to true if initial data exists
            everLocked: false,
            lastUploadVersion: -1,
            srcColorKey: normalizedDesc.srcColorKey,
            destColorKey: normalizedDesc.destColorKey,
            mipMapCount: normalizedDesc.mipMapCount,
            textureStage: normalizedDesc.textureStage,
            alphaBitDepth: normalizedDesc.alphaBitDepth,
            // If surface was provided by app with data, mark as written
            // This helps deferred Load() - if data is already there, copy immediately
            surfaceEverWritten: isPtrValid && surfaceHasInitialData,
            writeGeneration: 0,
        };

        // CPU-First: Mark GPU dirty flag based on initial state
        if (initialMode === "CPU") {
            // CPU mode: ordinary surfaces need upload from their CPU backing store.
            // Textures are different: a freshly allocated texture backing store is
            // zero-filled implementation storage, not app-authored content. Mark it
            // dirty only when the app supplied initial data; Lock/Load/Blt will mark
            // later real writes dirty.
            if (surfaceState.surfacePtr > 0 && (!isTexture || surfaceState.surfaceEverWritten)) {
                surfaceState.gpuDirty = true;
            }
        } else {
            // GPU_ONLY mode: GPU texture will be written by D3D, surfacePtr stays empty
            // gpuDirty=false is correct (GPU will be written directly)
            // BUT we need to clear GPU texture to black initially
            surfaceState.gpuDirty = false;
        }

        if (normalizedDesc.srcColorKey) {
            Logger.verbose(LogCategory.DDRAW,
                `CreateSurface: Surface 0x${surfacePtr.toString(16)} has srcColorKey=0x${normalizedDesc.srcColorKey.low.toString(16)}-0x${normalizedDesc.srcColorKey.high.toString(16)}`
            );
        }

        if (vidMemSize > 0) {
            surfaceState.vidMemSize = vidMemSize;
        }

        if ((surfaceState.caps & DDSCAPS_PRIMARYSURFACE) && normalizedDesc.backBufferCount > 0) {
            surfaceState.caps |= DDSCAPS_FLIP | DDSCAPS_COMPLEX;
        }

        // Real DirectDraw automatically adds VIDEOMEMORY for primary/backbuffer surfaces
        // Some engines check this flag when validating surface capabilities
        if ((surfaceState.caps & DDSCAPS_PRIMARYSURFACE) && !isSystemMemory) {
            surfaceState.caps |= DDSCAPS_VIDEOMEMORY;
        }

        // BPP sync: only when game explicitly specified DDSD_PIXELFORMAT
        // Without this guard, readSurfaceDesc returning null pixelFormat → normalizeSurfaceDesc
        // falls back to display BPP → spurious sync corrupts context.display.bpp
        if (isPrimary && (rawDesc.flags & DDSD_PIXELFORMAT) && normalizedDesc.pixelFormat!.bpp !== context.display.bpp) {
            Logger.log(LogCategory.DDRAW,
                `CreateSurface: PRIMARY BPP sync: display ${context.display.bpp}bpp -> ${normalizedDesc.pixelFormat!.bpp}bpp`);
            context.display.bpp = normalizedDesc.pixelFormat!.bpp;
        }

        // Determine if GPU texture is needed
        const isSysmemOnly = isSystemMemory && !isVideoMemory;
        const isAllocOnLoad = (surfaceState.caps & DDSCAPS_ALLOCONLOAD) !== 0;
        // PERFORMANCE: SYSMEM-only textures used as Load() sources don't need GPU backing.
        // Games create SYSMEM surfaces → write pixels → Load() to VIDMEM → release.
        // Creating GPU textures for these intermediaries wastes ~1ms per surface.
        // If a SYSMEM texture is later bound for rendering (rare), ensureGpuTexture() creates it lazily.
        // D3D render targets (DDSCAPS_3DDEVICE) ALWAYS need GPU texture regardless of memory type.
        const needsGpuTexture =
            isPrimary ||
            isBackBuffer ||
            isD3dRenderTarget ||
            (isTexture && !isSysmemOnly) ||  // VIDMEM textures get immediate GPU; SYSMEM deferred
            (isVideoMemory && !isAllocOnLoad);

        // DIAGNOSTIC: Log GPU texture decision for debugging
        Logger.log(LogCategory.DDRAW,
            `CreateSurface: Created RenderSurface mode=${surfaceState.mode} gpuDirty=${surfaceState.gpuDirty} ` +
            `surfacePtr=0x${surfacePtr.toString(16)} size=${normalizedDesc.width}x${normalizedDesc.height} ` +
            `caps=0x${surfaceState.caps.toString(16)} ` +
            `isPrimary=${isPrimary} isBackBuffer=${isBackBuffer} isD3dRenderTarget=${isD3dRenderTarget} ` +
            `isVideoMemory=${isVideoMemory} needsGpuTexture=${needsGpuTexture} hasBackend=${!!context.backend}`);

        // Initialize WebGPU texture only if needed
        if (needsGpuTexture && context.backend) {
            const device = context.backend.getDevice();
            if (device) {
                // Use swapchain format ONLY for render targets (primary/backbuffer/D3D target)
                // For textures, use stable rgba8unorm format for predictable conversion/shaders
                const isRenderTarget = isPrimary || isBackBuffer || isD3dRenderTarget;
                const format = isRenderTarget 
                    ? (context.backend.getFormat() || "rgba8unorm")
                    : "rgba8unorm";  // Stable format for textures
                const queue = context.backend.getQueue();
                const gpuResult = createGPUTexture(
                    device,
                    queue ?? null,
                    surfaceState.width,
                    surfaceState.height,
                    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                    format
                );
                if (gpuResult) {
                    surfaceState.gpuTexture = gpuResult.texture;
                    surfaceState.gpuTextureView = gpuResult.view;
                    surfaceState.gpuTextureFormat = format; // Store format for pipeline compatibility

                    if (enableDiagnostics) {
                        Logger.log(LogCategory.DDRAW,
                            `CreateSurface [TID=${threadId}]: GPU texture CREATED for ${surfaceState.width}x${surfaceState.height} ` +
                            `@ surfacePtr=0x${surfacePtr.toString(16)}`
                        );
                    }
                } else if (enableDiagnostics) {
                    Logger.warn(LogCategory.DDRAW, 
                        `CreateSurface [TID=${threadId}]: createGPUTexture RETURNED NULL for ${surfaceState.width}x${surfaceState.height}`
                    );
                }
            } else if (enableDiagnostics) {
                Logger.warn(LogCategory.DDRAW, 
                    `CreateSurface [TID=${threadId}]: backend.getDevice() RETURNED NULL - cannot create GPU texture`
                );
            }
        } else if (!needsGpuTexture && enableDiagnostics) {
            Logger.log(LogCategory.DDRAW, 
                `CreateSurface [TID=${threadId}]: SKIPPED GPU texture for SYSMEM surface ` +
                `${surfaceState.width}x${surfaceState.height} (isSysmemOnly=${isSysmemOnly}, isAllocOnLoad=${isAllocOnLoad})`
            );
        }

        // Write back to DDSURFACEDESC2
        if (lpDesc) {
            if (enableDiagnostics && isTexture) {
                const originalSize = view.getUint32(lpDesc + 0, true);
                Logger.log(LogCategory.DDRAW, 
                    `CreateSurface DIAG: Before write - DDSURFACEDESC2 at 0x${lpDesc.toString(16)} ` +
                    `originalSize=${originalSize} (needs >= 40 for lpSurface)`
                );
            }

            const outDesc: any = {
                ...normalizedDesc,
                pitch: surfaceState.pitch,
                caps: surfaceState.caps, // Use surfaceState.caps — includes FLIP|COMPLEX|VIDEOMEMORY additions
            };

            // Real DirectDraw behavior:
            // - SYSMEM surfaces: lpSurface IS returned in CreateSurface (app-managed memory)
            // - VIDMEM/primary/backbuffer: lpSurface is NOT returned — game must call Lock()
            // Some engines check for DDSD_LPSURFACE and may reject surfaces that have it set
            if (isSystemMemory) {
                outDesc.surfacePtr = surfacePtr;
                outDesc.flags = (outDesc.flags || 0) | DDSD_LPSURFACE | DDSD_PITCH | DDSD_PIXELFORMAT;
                if (normalizedDesc.caps) {
                    outDesc.flags |= DDSD_CAPS;
                }
            } else {
                // VIDMEM surfaces: do NOT expose lpSurface in CreateSurface response
                outDesc.surfacePtr = 0;
            }

            writeSurfaceDesc(mem, lpDesc, outDesc);
        }

        // Use correct IID for surface version (Surface4 vs Surface7)
        // This prevents IID mismatch that can cause QueryInterface to fail or return wrong behavior
        const surfaceIid = options?.surfaceIid ?? IID_IDirectDrawSurface7;
        const obj = ComObjectFactory.create(surfaceIid, vtableAddr, surfaceState) as DirectDrawSurfaceObject | null;
        if (!obj) {
            view.setUint32(lplpSurf, 0, true);
            return E_FAIL;
        }
        obj.setDDrawOwnerAddr(ownerAddr);

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        view.setUint32(lplpSurf, objAddr, true);
        context.resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        // OPTIMIZATION: Register surfacePtr for fast lookup in ReleaseDC and other hot paths
        if (surfacePtr > 0) {
            context.resourceProvider.registerSurfacePtr(obj.handle, surfacePtr);
        }

        if (isTexture) {
            Logger.log(LogCategory.DDRAW, 
                `CreateSurface: Created TEXTURE surface objAddr=0x${objAddr.toString(16)} ` +
                `handle=0x${obj.handle.toString(16)} (${normalizedDesc.width}x${normalizedDesc.height})`
            );
        }

        // Create mipmap chain for textures with DDSCAPS_MIPMAP|DDSCAPS_COMPLEX.
        // Legacy engines traverse mip levels via GetAttachedSurface().
        const requestedMipLevels = normalizedDesc.mipMapCount ?? 0;
        const needsMipChain =
            isTexture &&
            (surfaceState.caps & DDSCAPS_MIPMAP) !== 0 &&
            (surfaceState.caps & DDSCAPS_COMPLEX) !== 0 &&
            requestedMipLevels > 1;

        if (needsMipChain) {
            let prevAddr = objAddr;
            let mipWidth = Math.max(1, surfaceState.width);
            let mipHeight = Math.max(1, surfaceState.height);
            // Record the sublevels on the ROOT so the backend can upload their authored pixels into
            // the base GPU texture's mip slots (see ddraw-backend-executor uploadAuthoredMips).
            surfaceState.mipSublevels = [];

            for (let level = 1; level < requestedMipLevels; level++) {
                mipWidth = Math.max(1, mipWidth >> 1);
                mipHeight = Math.max(1, mipHeight >> 1);
                // A sublevel inherits the ROOT's pixel format, so its pitch has to come from
                // that format's own layout: computePitch is a bits-per-pixel formula and a
                // DDPF_FOURCC format has no bits per pixel, which would silently hand a
                // block-compressed level a linear stride.
                const mipLayout = getSurfaceFormatLayout(surfaceState.format, mipWidth, mipHeight);
                const mipPitch = mipLayout.compressed
                    ? mipLayout.pitch
                    : Math.max(mipWidth * bytesPerPixel, computePitch(mipWidth, surfaceState.format.bpp));
                const mipSize = Math.max(
                    MIN_SURFACE_SIZE,
                    mipLayout.compressed ? mipLayout.bytes : mipPitch * mipHeight);
                let mipSurfacePtr = 0;
                try {
                    mipSurfacePtr = context.process.allocateSurface(mipSize);
                } catch (e) {
                    Logger.warn(LogCategory.DDRAW,
                        `CreateSurface: allocateSurface for mip ${level} failed: ${e}, stopping mip chain`);
                    break;
                }

                if (!mipSurfacePtr || !isSafeSurfaceAddress(mipSurfacePtr, mipSize) || !isValidAddress(mem, mipSurfacePtr, mipSize)) {
                    Logger.warn(LogCategory.DDRAW,
                        `CreateSurface: Failed to allocate mip level ${level}/${requestedMipLevels - 1} ` +
                        `(ptr=0x${mipSurfacePtr.toString(16)} size=0x${mipSize.toString(16)}), stopping mip chain`
                    );
                    break;
                }

                mem.fill(0, mipSurfacePtr, mipSurfacePtr + mipSize);

                const mipState: DirectDrawSurfaceState = {
                    ...surfaceState,
                    surfaceType: "render_surface",
                    width: mipWidth,
                    height: mipHeight,
                    pitch: mipPitch,
                    surfacePtr: mipSurfacePtr,
                    surfacePtrAllocated: true,
                    attachedSurfaceAddr: 0,
                    // DirectDraw made this level, not the app: it is not reference-counted as
                    // an attachment and it cannot be detached.
                    implicitChainMember: true,
                    attachRefOwner: 0,
                    // Own attachment/z-owner lists — the spread copies the ROOT's array by
                    // reference, and a shared list would detach the root's members with this one.
                    attachedSurfaceAddrs: undefined,
                    zOwnerSurfaces: undefined,
                    mode: surfaceState.mode,
                    version: 0,
                    // Do not mark gpuDirty until guest writes — pre-Load bind must not upload zeros.
                    gpuDirty: false,
                    everLocked: false,
                    lastUploadVersion: -1,
                    surfaceEverWritten: false,
                    mipMapCount: Math.max(1, requestedMipLevels - level),
                    gpuTexture: undefined,
                    gpuTextureView: undefined,
                    gpuTextureFormat: undefined,
                };

                // Mip levels also need GPU backing so texture sampling from lower levels works.
                if (context.backend) {
                    const device = context.backend.getDevice();
                    const mipQueue = context.backend.getQueue();
                    if (device) {
                        const gpuResult = createGPUTexture(
                            device,
                            mipQueue ?? null,
                            mipState.width,
                            mipState.height,
                            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                            "rgba8unorm"
                        );
                        if (gpuResult) {
                            mipState.gpuTexture = gpuResult.texture;
                            mipState.gpuTextureView = gpuResult.view;
                            mipState.gpuTextureFormat = "rgba8unorm";
                        }
                    }
                }

                const mipObj = ComObjectFactory.create(surfaceIid, vtableAddr, mipState) as DirectDrawSurfaceObject | null;
                if (!mipObj) {
                    Logger.warn(LogCategory.DDRAW, `CreateSurface: Failed to create COM object for mip level ${level}, stopping mip chain`);
                    break;
                }
                mipObj.setDDrawOwnerAddr(ownerAddr);
                surfaceState.mipSublevels.push(mipState);

                const mipAddr = allocateComObject(context.process.memory, mem, vtableAddr);
                context.resourceProvider.mapAddressToHandle(mipAddr, mipObj.handle);
                context.resourceProvider.registerSurfacePtr(mipObj.handle, mipSurfacePtr);

                const prevObj = surfaceAt(context.resourceProvider, prevAddr);
                if (!prevObj) {
                    Logger.warn(LogCategory.DDRAW, `CreateSurface: Missing previous mip object at 0x${prevAddr.toString(16)}, stopping mip chain`);
                    break;
                }
                prevObj.setAttachedSurface(mipAddr);
                prevAddr = mipAddr;
            }
        }

        if (surfaceState.caps & DDSCAPS_PRIMARYSURFACE) {
            context.surfaces.primary = objAddr;
        }
        if (surfaceState.caps & DDSCAPS_BACKBUFFER) {
            context.surfaces.backBuffer = objAddr;
        }

        // dwBackBufferCount builds a flip chain, and DirectDraw does not reserve that for the
        // primary: an app may create an OFFSCREENPLAIN|3DDEVICE|FLIP|COMPLEX chain and flip it
        // off-screen (Wine ddraw7.c:20301 test_flip_3d does exactly that). The surface the app
        // asked for becomes the FRONT buffer of the chain either way.
        const buildsFlipChain = normalizedDesc.backBufferCount > 0
            && ((surfaceState.caps & DDSCAPS_PRIMARYSURFACE) !== 0
                || (surfaceState.caps & (DDSCAPS_FLIP | DDSCAPS_COMPLEX)) !== 0);
        if (buildsFlipChain && (surfaceState.caps & DDSCAPS_PRIMARYSURFACE) === 0) {
            surfaceState.caps |= DDSCAPS_FLIP | DDSCAPS_FRONTBUFFER;
        }
        if (buildsFlipChain) {
            let lastAddr = objAddr;
            let firstBackbufferAddr = 0;

            for (let i = 0; i < normalizedDesc.backBufferCount; i++) {
                // Create RenderSurface for backbuffer (spread from primary surface, but override key fields)
                let backbufferSurfacePtr = 0;
                try {
                    backbufferSurfacePtr = context.process.allocateSurface(surfaceSize);
                } catch (e) {
                    Logger.warn(LogCategory.DDRAW,
                        `CreateSurface: allocateSurface for backbuffer #${i} failed: ${e}, aborting flip chain`);
                    break;
                }
                if (!backbufferSurfacePtr) {
                    Logger.warn(LogCategory.DDRAW,
                        `CreateSurface: allocateSurface for backbuffer #${i} returned 0, aborting flip chain`);
                    break;
                }
                const backbufferState: DirectDrawSurfaceState = {
                    ...surfaceState,
                    surfaceType: "render_surface", // Explicit type (spread copies from primary)
                    // A back buffer keeps the chain root's residency and purpose bits (an
                    // off-screen 3D chain is not video memory just because a primary's is) and
                    // never inherits the bits that name the root: PRIMARYSURFACE, FRONTBUFFER.
                    caps: DDSCAPS_BACKBUFFER | DDSCAPS_FLIP
                        | (normalizedDesc.backBufferCount > 1 ? DDSCAPS_COMPLEX : 0)
                        | (surfaceState.caps & (DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN
                            | DDSCAPS_VIDEOMEMORY | DDSCAPS_SYSTEMMEMORY | DDSCAPS_LOCALVIDMEM))
                        | ((surfaceState.caps & DDSCAPS_PRIMARYSURFACE) ? DDSCAPS_VIDEOMEMORY : 0),
                    surfacePtr: backbufferSurfacePtr,
                    surfacePtrAllocated: true,
                    attachedSurfaceAddr: 0,
                    // A back buffer DirectDraw created for DDSD_BACKBUFFERCOUNT belongs to the
                    // chain, not to the app: no attachment reference, and it dies with the root.
                    implicitChainMember: true,
                    attachRefOwner: 0,
                    // Own attachment/z-owner lists — the spread copies the PRIMARY's array by
                    // reference, and from the second back buffer on that array is non-empty.
                    attachedSurfaceAddrs: undefined,
                    zOwnerSurfaces: undefined,
                    // Backbuffer should inherit mode from primary for consistency
                    // If primary is GPU_ONLY, backbuffer should also be GPU_ONLY to avoid CPU↔GPU sync
                    mode: surfaceState.mode,  // Inherit from primary (GPU_ONLY or CPU)
                    version: 0,
                    gpuDirty: surfaceState.mode === "CPU",  // If CPU mode, mark dirty for initial upload
                    everLocked: false,
                    lastUploadVersion: -1,
                    surfaceEverWritten: false, // Will be set when memory is actually written
                };

                Logger.verbose(LogCategory.DDRAW,
                    `CreateSurface: Creating backbuffer #${i} mode=${backbufferState.mode} ` +
                    `surfacePtr=0x${backbufferSurfacePtr.toString(16)} ` +
                    `(inherited from primary)`);

                backbufferState.caps &= ~DDSCAPS_PRIMARYSURFACE;

                // Initialize WebGPU texture for backbuffer
                if (context.backend) {
                    const device = context.backend.getDevice();
                    const bbQueue = context.backend.getQueue();
                    if (device) {
                        // Use swapchain format for backbuffer (render target)
                        const format = context.backend.getFormat() || "rgba8unorm";
                        const gpuResult = createGPUTexture(
                            device,
                            bbQueue ?? null,
                            backbufferState.width,
                            backbufferState.height,
                            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
                            format
                        );
                        if (gpuResult) {
                            backbufferState.gpuTexture = gpuResult.texture;
                            backbufferState.gpuTextureView = gpuResult.view;
                            backbufferState.gpuTextureFormat = format; // Store format for pipeline compatibility
                        }
                    }
                }

                // Use guest address directly, not mem.byteOffset
                const backbufferPtr = backbufferState.surfacePtr;
                if (backbufferPtr >= 0 && backbufferPtr + surfaceSize <= mem.length) {
                    mem.fill(0, backbufferPtr, backbufferPtr + surfaceSize);
                }

                const backbufferObj = ComObjectFactory.create(
                    surfaceIid,
                    vtableAddr,
                    backbufferState
                ) as DirectDrawSurfaceObject | null;

                if (backbufferObj) {
                    backbufferObj.setDDrawOwnerAddr(ownerAddr);
                    const backbufferAddr = allocateComObject(context.process.memory, mem, vtableAddr);
                    context.resourceProvider.mapAddressToHandle(backbufferAddr, backbufferObj.handle);

                    const prevObj = surfaceAt(context.resourceProvider, lastAddr);
                    if (prevObj) {
                        prevObj.setAttachedSurface(backbufferAddr);
                    }

                    if (i === 0) firstBackbufferAddr = backbufferAddr;
                    lastAddr = backbufferAddr;

                    if (i === normalizedDesc.backBufferCount - 1) {
                        backbufferObj.setAttachedSurface(objAddr);
                    }
                }
            }
            context.surfaces.backBuffer = firstBackbufferAddr;
            if (enableDiagnostics) {
                Logger.log(LogCategory.DDRAW, 
                    `CreateSurface: Created Flipping Chain, BackBuffer=0x${firstBackbufferAddr.toString(16)} ` +
                    `(primary=0x${objAddr.toString(16)}, backbuffers=${normalizedDesc.backBufferCount})`
                );
            }
        } else if (surfaceState.caps & DDSCAPS_BACKBUFFER) {
            context.surfaces.backBuffer = objAddr;
        }

        if (enableDiagnostics) {
            Logger.log(LogCategory.SYSTEM, 
                `CreateSurface -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)}, ${vtableName})`
            );
        }

        return DD_OK;
    };

    // BOOL SetAppCompatData(DWORD dwType, DWORD dwData) — ordinal 22
    // Undocumented compat shim hook; legacy titles resolve it from ddraw.dll via GetProcAddress.
    // Accept all known probes (e.g. type 12 = DXMaximizedWindowedMode) without changing runtime state.
    exports["SetAppCompatData"] = (ctx, mem, args) => {
        const dwType = args[0] >>> 0;
        const dwData = args[1] >>> 0;
        Logger.verbose(
            LogCategory.DDRAW,
            `SetAppCompatData(type=${dwType}, data=0x${dwData.toString(16)}) -> TRUE`
        );
        System.getInstance().scheduler.setLastError(0);
        return 1;
    };

    exports["DirectDrawCreate"] = (ctx, mem, args) => {
        const lpGUID = args[0];
        const lplpDD = args[1];
        const pUnkOuter = args[2];

        // Diagnostic: log full stack frame at entry (return addr + 3 args) to catch wrong RET / corruption
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = ctx.esp + 4 <= mem.length ? view.getUint32(ctx.esp, true) : 0;
        const stackFrameEnd = ctx.esp + 4 + 3 * 4;
        const lplpDDInFrame = lplpDD >= ctx.esp && lplpDD < stackFrameEnd;
        Logger.log(LogCategory.SYSTEM,
            `DirectDrawCreate ENTRY: ESP=0x${ctx.esp.toString(16)} [retAddr]=0x${retAddr.toString(16)} ` +
            `lpGUID=0x${lpGUID.toString(16)} lplpDD=0x${lplpDD.toString(16)} pUnkOuter=0x${(pUnkOuter ?? 0).toString(16)} ` +
            `lplpDDInFrame=${lplpDDInFrame} ${retAddr >= 0x7c00 && retAddr < 0x9000 ? "(retAddr in bootloader!)" : ""}`
        );

        if (!lplpDD || !isValidAddress(mem, lplpDD, 4)) return E_POINTER;

        // Avoid writing into current stack frame (return addr at ctx.esp) – prevents stack corruption / wrong RET
        if (lplpDDInFrame) {
            Logger.warn(LogCategory.SYSTEM, `DirectDrawCreate: lplpDD=0x${lplpDD.toString(16)} in stack frame [0x${ctx.esp.toString(16)}..0x${stackFrameEnd.toString(16)}), refusing write`);
            return E_POINTER;
        }
        initReturnPtr(lplpDD);

        // DirectDrawCreate ALWAYS returns IDirectDraw (v1), not v4 or v7
        // Games must use QueryInterface to get newer versions
        const vtableAddr = context.vtables.IDirectDraw.address;
        const obj = ComObjectFactory.create(IID_IDirectDraw, vtableAddr);
        if (!obj) return E_FAIL;

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        view.setUint32(lplpDD, objAddr, true);
        context.resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        // DIAGNOSTIC: Check return address before returning
        const retAddrAfter = ctx.esp + 4 <= mem.length ? view.getUint32(ctx.esp, true) : 0;
        if (retAddrAfter !== retAddr) {
            Logger.error(LogCategory.SYSTEM,
                `DirectDrawCreate EXIT: Return address CHANGED! Was 0x${retAddr.toString(16)}, now 0x${retAddrAfter.toString(16)}`);
        } else {
            Logger.log(LogCategory.SYSTEM,
                `DirectDrawCreate EXIT: Return address OK (0x${retAddrAfter.toString(16)}), objAddr=0x${objAddr.toString(16)}`);
        }

        // DIAGNOSTIC: Verify vtable contents are valid stub addresses
        const vtableCheck: string[] = [];
        for (let i = 0; i < 5; i++) {
            const methodAddr = view.getUint32(vtableAddr + i * 4, true);
            vtableCheck.push(`[${i}]=0x${methodAddr.toString(16)}`);
        }
        Logger.verbose(LogCategory.SYSTEM, `DirectDrawCreate VTABLE CHECK at 0x${vtableAddr.toString(16)}: ${vtableCheck.join(' ')}`);

        // Check if first method (QueryInterface) points to valid thunk code region
        const firstMethod = view.getUint32(vtableAddr, true);
        const space = System.getInstance().process?.addressSpace;
        const thunkRegion = space?.findRegionByKind?.("THUNK_CODE") ?? space?.getLayoutBucket("THUNK_CODE");
        if (thunkRegion) {
            const thunkStart = thunkRegion.base;
            const thunkEnd = thunkRegion.base + thunkRegion.size;
            if (firstMethod < thunkStart || firstMethod >= thunkEnd) {
                Logger.error(LogCategory.SYSTEM,
                    `VTABLE CORRUPTION! First method 0x${firstMethod.toString(16)} is outside thunk region ` +
                    `(expected 0x${thunkStart.toString(16)}-0x${thunkEnd.toString(16)})`);
            }
        }

        Logger.log(LogCategory.SYSTEM, `DirectDrawCreate -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        // Return with explicit stackCleanup=12 (3 args * 4 bytes) to ensure proper RET N
        return { value: DD_OK, stackCleanup: 12 };
    };

    exports["DirectDrawCreateEx"] = (ctx, mem, args) => {
        const lpGUID = args[0];
        const lplpDD = args[1];
        const iidPtr = args[2];

        Logger.log(LogCategory.SYSTEM, `DirectDrawCreateEx called: lpGUID=0x${lpGUID.toString(16)}, lplpDD=0x${lplpDD.toString(16)}, iid=0x${iidPtr.toString(16)}`);

        if (!lplpDD || !isValidAddress(mem, lplpDD, 4)) return E_POINTER;

        const stackFrameEndEx = ctx.esp + 4 + 4 * 4; // ret + 4 args
        if (lplpDD >= ctx.esp && lplpDD < stackFrameEndEx) {
            Logger.warn(LogCategory.SYSTEM, `DirectDrawCreateEx: lplpDD in stack frame, refusing write`);
            return E_POINTER;
        }
        initReturnPtr(lplpDD);

        let requestedIID: string | null = null;
        let vtableAddr: number;
        let factoryIID: string;

        // Parse IID if provided (iidPtr != 0)
        if (iidPtr && isValidAddress(mem, iidPtr, 16)) {
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) {
                iidBytes[i] = mem[iidPtr + i];
            }
            requestedIID = bytesToGuid(iidBytes);
            const iidNormalized = requestedIID.replace(/[{}]/g, "").toLowerCase();

            // Select vtable based on requested IID
            if (iidNormalized === IID_IDirectDraw4.toLowerCase()) {
                vtableAddr = context.vtables.IDirectDraw4?.address;
                factoryIID = IID_IDirectDraw4;
            } else if (iidNormalized === IID_IDirectDraw7.toLowerCase()) {
                vtableAddr = context.vtables.IDirectDraw7?.address;
                factoryIID = IID_IDirectDraw7;
            } else {
                // Unknown IID - return E_NOINTERFACE (not fallback to IDirectDraw7)
                Logger.warn(LogCategory.SYSTEM, `DirectDrawCreateEx: Unknown IID ${requestedIID}, returning E_NOINTERFACE`);
                return E_NOINTERFACE;
            }
        } else {
            // No IID specified - default to IDirectDraw7
            vtableAddr = context.vtables.IDirectDraw7.address;
            factoryIID = IID_IDirectDraw7;
        }

        if (!vtableAddr) {
            Logger.error(LogCategory.SYSTEM, `DirectDrawCreateEx: VTable not found for IID ${requestedIID || 'default'}`);
            return E_FAIL;
        }

        const obj = ComObjectFactory.create(factoryIID, vtableAddr);
        if (!obj) return E_FAIL;

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpDD, objAddr, true);
        context.resourceProvider.mapAddressToHandle(objAddr, obj.handle);
        if (factoryIID === IID_IDirectDraw7) context.ddraw7ObjectAddr = objAddr;

        Logger.verbose(LogCategory.SYSTEM, `DirectDrawCreateEx: requested IID=${requestedIID || 'default'}, using vtable=${factoryIID}, objAddr=0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        return DD_OK;
    };

    exports["DirectDrawCreateClipper"] = (ctx, mem, args) => {
        const dwFlags = args[0];
        const lplpDDClipper = args[1];
        const pUnkOuter = args[2];
        Logger.log(LogCategory.SYSTEM, `DirectDrawCreateClipper: flags=0x${dwFlags.toString(16)}, out=0x${lplpDDClipper.toString(16)}`);
        if (!lplpDDClipper || !isValidAddress(mem, lplpDDClipper, 4)) return E_POINTER;
        initReturnPtr(lplpDDClipper);
        const vtableAddr = getVTable("IDirectDrawClipper");
        if (!vtableAddr) {
            Logger.warn(LogCategory.SYSTEM, "DirectDrawCreateClipper: IDirectDrawClipper vtable not found");
            return E_FAIL;
        }
        const obj = ComObjectFactory.create(IID_IDirectDrawClipper, vtableAddr);
        if (!obj) return E_FAIL;
        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpDDClipper, objAddr, true);
        context.resourceProvider.mapAddressToHandle(objAddr, obj.handle);
        Logger.log(LogCategory.SYSTEM, `DirectDrawCreateClipper -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        return DD_OK;
    };

    // ===== IDirectDraw (v1) methods =====
    // These methods implement the legacy IDirectDraw interface returned by DirectDrawCreate

    exports["IDirectDraw_QueryInterface"] = (ctx, mem, args) => commonQueryInterface(args[0], args[1], args[2], mem);

    // Each DirectDraw generation carries its OWN refcount on the shared driver object,
    // so AddRef/Release must report the count of the interface they were called through.
    exports["IDirectDraw_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef(args[0]) : 0;
    };

    exports["IDirectDraw_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release(args[0]) : 0;
    };

    exports["IDirectDraw_Compact"] = () => DD_OK;

    exports["IDirectDraw_CreateClipper"] = (ctx, mem, args) => {
        return exports["IDirectDraw7_CreateClipper"]?.(ctx, mem, args) ?? DD_OK;
    };

    exports["IDirectDraw_CreatePalette"] = (ctx, mem, args) => {
        return exports["IDirectDraw7_CreatePalette"]?.(ctx, mem, args) ?? DD_OK;
    };

    exports["IDirectDraw_CreateSurface"] = (ctx, mem, args) => {
        // v1: CreateSurface(this, lpDDSurfaceDesc, lplpDDSurface, pUnkOuter) - 4 args
        // Uses DDSURFACEDESC (108 bytes) but internalCreateSurface handles dwSize.
        // The surface gets the v1 vtable, which also serves a QI to IDirectDrawSurface2/3.
        const lpDDSurfaceDesc = args[1];
        const lplpDDSurface = args[2];
        const threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;

        Logger.log(LogCategory.SYSTEM,
            `IDirectDraw_CreateSurface [TID=${threadId}]: this=0x${args[0].toString(16)}, ` +
            `desc=0x${lpDDSurfaceDesc.toString(16)}, out=0x${lplpDDSurface.toString(16)}`
        );

        return internalCreateSurface(mem, lpDDSurfaceDesc, lplpDDSurface, "IDirectDrawSurface", {
            threadId,
            enableDiagnostics: true,
            surfaceIid: IID_IDirectDrawSurface,
            ownerAddr: args[0]
        });
    };

    exports["IDirectDraw_EnumDisplayModes"] = (ctx, mem, args) => {
        return enumDisplayModesImpl(ctx, mem, args, true);
    };

    exports["IDirectDraw_EnumSurfaces"] = (ctx, mem, args) => {
        return enumSurfacesImpl(ctx, mem, args, true);
    };

    exports["IDirectDraw_GetCaps"] = (ctx, mem, args) => {
        return exports["IDirectDraw7_GetCaps"]?.(ctx, mem, args) ?? DD_OK;
    };

    exports["IDirectDraw_GetDisplayMode"] = (ctx, mem, args) => {
        return exports["IDirectDraw7_GetDisplayMode"]?.(ctx, mem, args) ?? DD_OK;
    };

    // GetFourCCCodes / GetMonitorFrequency / GetScanLine / GetVerticalBlankStatus /
    // DuplicateSurface are NOT overridden here: v1 takes exactly the v7 parameters, so
    // the delegation loop below routes them to the single v7 implementation. Overriding
    // them with `() => DD_OK` left the out-parameters holding stack garbage — a caller
    // spinning on GetVerticalBlankStatus then never sees the flag change.
    exports["IDirectDraw_Initialize"] = () => DD_OK;

    exports["IDirectDraw_RestoreDisplayMode"] = (ctx, mem, args) => {
        return exports["IDirectDraw7_RestoreDisplayMode"]?.(ctx, mem, args) ?? DD_OK;
    };

    exports["IDirectDraw_SetCooperativeLevel"] = (ctx, mem, args) => {
        // v1: 2 args (hwnd, flags) - same as v7
        return exports["IDirectDraw7_SetCooperativeLevel"]?.(ctx, mem, args) ?? DD_OK;
    };

    exports["IDirectDraw_SetDisplayMode"] = (ctx, mem, args) => {
        // v1: 3 args (width, height, bpp) vs v7: 6 args (width, height, bpp, refresh, flags)
        const width = args[1];
        const height = args[2];
        const bpp = args[3] || 16;
        const refresh = context.display.refresh || EmulatorConfig.getInstance().screenResolution.refreshRate || 60;

        Logger.log(LogCategory.DDRAW, `IDirectDraw_SetDisplayMode (v1): ${width}x${height} @ ${bpp}bpp ${refresh}Hz`);

        const system = System.getInstance();
        applySetDisplayMode(system, context, width, height, bpp, refresh);
        return DD_OK;
    };

    // v1/v2/v4: WaitForVerticalBlank returns DD_OK synchronously.
    // Only v7 is async (games that explicitly request v7 are newer and expect real VSync).
    // Making older versions async breaks hover/tooltip handling: during the async spin-loop
    // wait, no x86 code runs → hover detection logic doesn't execute.
    exports["IDirectDraw_WaitForVerticalBlank"] = () => DD_OK;

    // IDirectDraw4 methods (DX6)
    exports["IDirectDraw4_QueryInterface"] = (ctx, mem, args) => commonQueryInterface(args[0], args[1], args[2], mem);

    exports["IDirectDraw4_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef(args[0]) : 0;
    };

    exports["IDirectDraw4_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release(args[0]) : 0;
    };

    exports["IDirectDraw4_SetCooperativeLevel"] = (ctx, mem, args) => {
        // v4: 3 args - same as v7
        return exports["IDirectDraw7_SetCooperativeLevel"]?.(ctx, mem, args) ?? DD_OK;
    };

    exports["IDirectDraw4_SetDisplayMode"] = (ctx, mem, args) => {
        // v4: 5 args (width, height, bpp, refresh, flags) - same as v7 (which has 6, but ignores last)
        return exports["IDirectDraw7_SetDisplayMode"]?.(ctx, mem, args) ?? DD_OK;
    };

    // IDirectDraw4_CreateSurface (DX6)
    // Returns IDirectDrawSurface4 vtable (not Surface7)
    exports["IDirectDraw4_CreateSurface"] = (ctx, mem, args) => {
        const lpDDSurfaceDesc = args[1];
        const lplpDDSurface = args[2];
        const threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, 
            `IDirectDraw4_CreateSurface [TID=${threadId}]: this=0x${args[0].toString(16)}, ` +
            `desc=0x${lpDDSurfaceDesc.toString(16)}, out=0x${lplpDDSurface.toString(16)}, ` +
            `ret=0x${retAddr.toString(16)}`
        );

        return internalCreateSurface(mem, lpDDSurfaceDesc, lplpDDSurface, "IDirectDrawSurface4", {
            threadId,
            enableDiagnostics: false,
            surfaceIid: IID_IDirectDrawSurface4,
            ownerAddr: args[0]
        });
    };

    exports["DirectDrawEnumerateA"] = (ctx, mem, args) => {
        const lpCallback = args[0];
        const lpContext = args[1];
        if (!lpCallback) return E_POINTER;

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return E_FAIL;

        // Driver data - we emulate only one (Primary) driver, which is sufficient for 99.9% of old games
        const desc = "Primary Display Driver";
        const name = "display";
        const descAddr = context.process.memory.alloc(desc.length + 1);
        const nameAddr = context.process.memory.alloc(name.length + 1);
        Marshaler.writeString(mem, descAddr, desc);
        Marshaler.writeString(mem, nameAddr, name);

        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP_DIRECTDRAWENUMERATEA);

        const { callbackId } = callbackManager.invokeCallback(
            lpCallback, 
            [0, descAddr, nameAddr, lpContext], 
            0, 
            () => {
                context.process.memory.free(descAddr);
                context.process.memory.free(nameAddr);
                return DD_OK; 
            }
        );

        return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: STACK_CLEANUP_DIRECTDRAWENUMERATEA };
    };

    exports["DirectDrawEnumerateExA"] = (ctx, mem, args) => {
        const lpCallback = args[0];
        const lpContext = args[1];
        const dwFlags = args[2]; // DDENUM_ATTACHEDSECONDARYDEVICES, DDENUM_DETACHEDSECONDARYDEVICES, DDENUM_NONDISPLAYDEVICES
        if (!lpCallback) return E_POINTER;

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return E_FAIL;

        // Same as EnumerateA but callback gets an extra hMonitor parameter
        const desc = "Primary Display Driver";
        const name = "display";
        const descAddr = context.process.memory.alloc(desc.length + 1);
        const nameAddr = context.process.memory.alloc(name.length + 1);
        Marshaler.writeString(mem, descAddr, desc);
        Marshaler.writeString(mem, nameAddr, name);

        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP_DIRECTDRAWENUMERATEEXA);

        // ExA callback: BOOL WINAPI callback(GUID*, LPSTR desc, LPSTR name, LPVOID context, HMONITOR hMonitor)
        // hMonitor = 0 for primary display
        const { callbackId } = callbackManager.invokeCallback(
            lpCallback,
            [0, descAddr, nameAddr, lpContext, 0],
            0,
            () => {
                context.process.memory.free(descAddr);
                context.process.memory.free(nameAddr);
                return DD_OK;
            }
        );

        return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: STACK_CLEANUP_DIRECTDRAWENUMERATEEXA };
    };

    exports["IDirectDraw7_QueryInterface"] = (ctx, mem, args) => commonQueryInterface(args[0], args[1], args[2], mem);

    exports["IDirectDraw7_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef(args[0]) : 0;
    };

    exports["IDirectDraw7_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release(args[0]) : 0;
    };

    exports["IDirectDraw7_GetCaps"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDDriverCaps = args[1];
        const lpDDEHWCaps = args[2];

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_GetCaps: this=0x${thisPtr.toString(16)}, ret=0x${retAddr.toString(16)}`);
        // Use caps from emulator config (may be overridden by manifest)
        const emulatorConfig = EmulatorConfig.getInstance();
        const defaultCaps = emulatorConfig.ddrawCaps;
        const O = DDCAPS_OFFSETS;

        const fillDDCaps = (addr: number, dwSize: number, isHEL: boolean) => {
            const cappedSize = Math.min(dwSize, DDCAPS_SIZE_V7);
            if (cappedSize < 4 || !isValidAddress(mem, addr, cappedSize)) {
                Logger.warn(LogCategory.SYSTEM, `IDirectDraw7_GetCaps: Invalid dwSize ${dwSize} at 0x${addr.toString(16)}`);
                return;
            }

            const w32 = (offset: number, value: number) => {
                if (cappedSize > offset) view.setUint32(addr + offset, value, true);
            };

            // Zero out from offset 4 to cappedSize
            const fillStart = addr + 4;
            const fillEnd = addr + cappedSize;
            if (fillStart < fillEnd && isValidAddress(mem, fillStart, fillEnd - fillStart)) {
                mem.fill(0, fillStart, fillEnd);
            }

            // Primary caps
            w32(O.dwCaps, defaultCaps.dwCaps);
            // Some D3D7 titles require CANRENDERWINDOWED to treat adapter as usable.
            // Force-advertise it even if manifest overrides dwCaps2.
            w32(O.dwCaps2, defaultCaps.dwCaps2 | DDCAPS2_CANRENDERWINDOWED);
            w32(O.dwCKeyCaps, CKCAPS_COMBINED);
            w32(O.dwFXCaps, DDFXCAPS_COMBINED);
            w32(O.dwPalCaps, DDPCAPS_COMBINED);
            w32(O.dwSVCaps, 0);

            // Z-buffer bit depths
            w32(O.dwZBufferBitDepths, DDBD_16 | DDBD_32);

            // Video memory. FREE is the CURRENT remainder, not a constant: real DirectDraw
            // reports what is left right now, and DX6-era engines budget their texture uploads
            // from it. Reporting a fixed number means the game never sees VRAM shrink, never
            // backs off, and keeps creating surfaces until CreateSurface refuses with
            // DDERR_OUTOFVIDEOMEMORY — which it then does not check, dereferencing the NULL
            // it was handed. It also made GetCaps and GetAvailableVidMem, which already
            // computed the remainder, answer the same question differently.
            const vidMemFree = Math.max(0, defaultCaps.dwVidMemTotal - context.usedVidMem);
            w32(O.dwVidMemTotal, isHEL ? 0 : defaultCaps.dwVidMemTotal);
            w32(O.dwVidMemFree, isHEL ? 0 : vidMemFree);

            // ddsOldCaps (legacy DDSCAPS at offset 132)
            w32(O.ddsOldCaps, DDSCAPS_COMBINED_3D);

            // Sub-blt capabilities: SVB (System→Video), VSB (Video→System), SSB (System→System), NLVB (NonLocal→Local)
            // These are critical for colorkey — games check sub-blt CKeyCaps to decide if colorkey works
            if (isHEL) {
                // HEL: software fallback supports all blt paths with colorkey
                const helBltCaps = 0xF4C08241; // matches real HEL caps dump
                w32(O.dwSVBCaps, helBltCaps);
                w32(O.dwSVBCKeyCaps, CKCAPS_COMBINED);
                w32(O.dwSVBFXCaps, DDFXCAPS_COMBINED);
                w32(O.dwVSBCaps, helBltCaps);
                w32(O.dwVSBCKeyCaps, CKCAPS_COMBINED);
                w32(O.dwVSBFXCaps, DDFXCAPS_COMBINED);
                w32(O.dwSSBCaps, helBltCaps);
                w32(O.dwSSBCKeyCaps, CKCAPS_COMBINED);
                w32(O.dwSSBFXCaps, DDFXCAPS_COMBINED);
                w32(O.dwNLVBCaps, helBltCaps);
                w32(O.dwNLVBCKeyCaps, CKCAPS_COMBINED);
                w32(O.dwNLVBFXCaps, DDFXCAPS_COMBINED);
            } else {
                // HAL: hardware caps — NLVB has full caps + colorkey, SVB/VSB minimal
                w32(O.dwSVBCaps, 0x40); // BLT only
                w32(O.dwVSBCaps, 0x40); // BLT only
                w32(O.dwNLVBCaps, defaultCaps.dwCaps);
                w32(O.dwNLVBCKeyCaps, CKCAPS_COMBINED);
                w32(O.dwNLVBFXCaps, DDFXCAPS_COMBINED);
            }

            // ddsCaps (DDSCAPS2 at offset 364)
            w32(O.ddsCaps, DDSCAPS_COMBINED_3D);
        };

        if (lpDDDriverCaps && isValidAddress(mem, lpDDDriverCaps, 4)) {
            const dwSize = view.getUint32(lpDDDriverCaps, true);
            fillDDCaps(lpDDDriverCaps, dwSize, false); // HAL caps
        }

        if (lpDDEHWCaps && isValidAddress(mem, lpDDEHWCaps, 4)) {
            const dwSize = view.getUint32(lpDDEHWCaps, true);
            fillDDCaps(lpDDEHWCaps, dwSize, true); // HEL caps
        }

        return DD_OK;
    };

    exports["IDirectDraw7_GetAvailableVidMem"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpdwTotal = args[2];
        const lpdwFree = args[3];

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_GetAvailableVidMem: this=0x${thisPtr.toString(16)}, ret=0x${retAddr.toString(16)}`);

        // Use caps from emulator config (may be overridden by manifest)
        const emulatorConfig = EmulatorConfig.getInstance();
        const defaultCaps = emulatorConfig.ddrawCaps;
        const freeMem = Math.max(0, defaultCaps.dwVidMemTotal - context.usedVidMem);
        
        if (lpdwTotal && isValidAddress(mem, lpdwTotal, 4)) view.setUint32(lpdwTotal, defaultCaps.dwVidMemTotal, true);
        if (lpdwFree && isValidAddress(mem, lpdwFree, 4)) view.setUint32(lpdwFree, freeMem, true);

        return DD_OK;
    };

    exports["IDirectDraw7_CreateSurface"] = (ctx, mem, args) => {
        const lpDDSurfaceDesc = args[1];
        const lplpDDSurface = args[2];
        const threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, 
            `IDirectDraw7_CreateSurface [TID=${threadId}]: this=0x${args[0].toString(16)}, ` +
            `desc=0x${lpDDSurfaceDesc.toString(16)}, out=0x${lplpDDSurface.toString(16)}, ` +
            `ret=0x${retAddr.toString(16)}`
        );

        return internalCreateSurface(mem, lpDDSurfaceDesc, lplpDDSurface, "IDirectDrawSurface7", {
            threadId,
            enableDiagnostics: false,
            surfaceIid: IID_IDirectDrawSurface7,
            ownerAddr: args[0]
        });
    };

    exports["IDirectDraw7_Initialize"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_Initialize: this=0x${thisPtr.toString(16)}, ret=0x${retAddr.toString(16)}`);
        return DD_OK;
    };

    exports["IDirectDraw7_SetCooperativeLevel"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const hwnd = args[1];
        const flags = args[2];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_SetCooperativeLevel: this=0x${thisPtr.toString(16)}, hwnd=0x${hwnd.toString(16)}, flags=0x${flags.toString(16)}, ret=0x${retAddr.toString(16)}`);
        context.cooperative.hwnd = hwnd;
        context.cooperative.flags = flags;

        // Do NOT clear the GDI overlay here. DDraw launchers call
        // FlipToGDISurface and paint menus via GDI while in DDSCL_EXCLUSIVE|FULLSCREEN.
        // D3D9 clears overlay on first present when a 3D renderer takes over.

        const isExclusive = (flags & DDSCL_EXCLUSIVE) !== 0;
        const isFullscreen = (flags & DDSCL_FULLSCREEN) !== 0;
        if (isExclusive) {
            // Exclusive (typically with FULLSCREEN): the coop window becomes the screen owner.
            // Record it; the subsequent SetDisplayMode normalizes the window to borderless
            // fullscreen and brings it to top of the Z-order.
            context.cooperative.exclusive = true;
            Logger.log(LogCategory.DDRAW,
                `SetCooperativeLevel: EXCLUSIVE${isFullscreen ? '|FULLSCREEN' : ''} on hwnd=0x${hwnd.toString(16)}`);
        }

        if ((flags & DDSCL_NORMAL) !== 0) {
            // Windowed/normal mode: leave exclusive; the GDI desktop is the screen again.
            context.cooperative.exclusive = false;
            context.gdiSurfaceVisible = true;
        }

        return DD_OK;
    };

    exports["IDirectDraw7_CreateClipper"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwFlags = args[1];
        const lplpDDClipper = args[2];
        const pUnkOuter = args[3];
        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_CreateClipper: this=0x${thisPtr.toString(16)}, flags=0x${dwFlags.toString(16)}, out=0x${lplpDDClipper.toString(16)}`);
        if (!lplpDDClipper || !isValidAddress(mem, lplpDDClipper, 4)) return E_POINTER;
        initReturnPtr(lplpDDClipper);
        const vtableAddr = getVTable("IDirectDrawClipper");
        if (!vtableAddr) {
            Logger.warn(LogCategory.SYSTEM, "CreateClipper: IDirectDrawClipper vtable not found");
            return E_FAIL;
        }
        const obj = ComObjectFactory.create(IID_IDirectDrawClipper, vtableAddr);
        if (!obj) return E_FAIL;
        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpDDClipper, objAddr, true);
        context.resourceProvider.mapAddressToHandle(objAddr, obj.handle);
        Logger.log(LogCategory.SYSTEM, `CreateClipper -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        return DD_OK;
    };

    exports["IDirectDraw7_SetDisplayMode"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const width = args[1];
        const height = args[2];
        const bpp = args[3];
        const requestedRefresh = args[4];
        const refresh = requestedRefresh > 0
            ? requestedRefresh
            : (context.display.refresh || EmulatorConfig.getInstance().screenResolution.refreshRate || 60);
        const flags = args[5];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_SetDisplayMode: this=0x${thisPtr.toString(16)}, w=${width}, h=${height}, bpp=${bpp}, refresh=${refresh}, flags=0x${(flags ?? 0).toString(16)}, ret=0x${retAddr.toString(16)}`);

        const system = System.getInstance();
        applySetDisplayMode(system, context, width, height, bpp, refresh);
        return DD_OK;
    };

    // Internal helper for EnumDisplayModes shared by all DDraw versions.
    // useV1Desc=true for IDirectDraw/IDirectDraw2 (DDSURFACEDESC, 108 bytes),
    // false for IDirectDraw4/IDirectDraw7 (DDSURFACEDESC2, 124 bytes).
    const enumDisplayModesImpl = (ctx: any, mem: Uint8Array, args: number[], useV1Desc: boolean) => {
        const DDEDM_REFRESHRATES = 0x00000002;

        const thisPtr = args[0];
        const dwFlags = args[1];
        const lpDDSurfaceDesc = args[2];
        const lpContext = args[3];
        const lpCallback = args[4];

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, `IDirectDraw${useV1Desc ? '2' : '7'}_EnumDisplayModes: this=0x${thisPtr.toString(16)}, flags=0x${dwFlags.toString(16)}, desc=0x${lpDDSurfaceDesc.toString(16)}, cb=0x${lpCallback.toString(16)}, ret=0x${retAddr.toString(16)}`);

        if (!lpCallback) return E_POINTER;

        const emulatorConfig = EmulatorConfig.getInstance();
        // Enumerate every resolution at EVERY bit depth we can serve, not just the one the
        // manifest names. A manifest's bpp is the DESKTOP depth; real DirectDraw reports one
        // mode per (w,h,depth) combination the hardware supports, and era titles filter the
        // enumeration by depth: HP CoS's D3DDrv keeps only dwRGBBitCount==16 when it builds
        // the in-game resolution list, so a 32-bpp-only manifest left that list EMPTY (and
        // the game unable to change resolution). applySetDisplayMode honours any depth, so
        // everything advertised here can actually be set.
        // 16 before 32: some legacy titles stop enumerating early and then require their
        // RenderBitDepth to match a mode they collected. 8-bpp stays last, and only when the
        // manifest asked for it — a palettised mode changes what a surface MEANS.
        const supportedModes = emulatorConfig.supportedResolutions;
        const seen = new Set<string>();
        const expanded: typeof supportedModes = [];
        const push = (w: number, h: number, bpp: number, refreshRate: number): void => {
            const key = `${w}x${h}x${bpp}`;
            if (seen.has(key)) return;
            seen.add(key);
            expanded.push({ width: w, height: h, bpp, refreshRate });
        };
        for (const m of supportedModes) {
            if (m.bpp === 8) continue;
            for (const bpp of [16, 32]) push(m.width, m.height, bpp, m.refreshRate);
        }
        for (const m of supportedModes) {
            if (m.bpp === 8) push(m.width, m.height, 8, m.refreshRate);
        }
        let modes = expanded;

        // Faithful: honor the caller's input descriptor filter. If lpDDSurfaceDesc sets
        // DDSD_WIDTH/DDSD_HEIGHT/DDSD_PIXELFORMAT, only matching modes are enumerated
        // (DDSURFACEDESC and DDSURFACEDESC2 share these offsets: flags@4, height@8, width@12,
        // pixelFormat@72 → rgbBitCount@84). No filter flags set ⇒ enumerate all modes.
        if (lpDDSurfaceDesc && isValidAddress(mem, lpDDSurfaceDesc, 88)) {
            const fFlags = view.getUint32(lpDDSurfaceDesc + 4, true);
            const fHeight = view.getUint32(lpDDSurfaceDesc + 8, true);
            const fWidth = view.getUint32(lpDDSurfaceDesc + 12, true);
            const fBpp = view.getUint32(lpDDSurfaceDesc + 84, true); // pixelFormat.dwRGBBitCount
            const wantW = (fFlags & DDSD_WIDTH) !== 0;
            const wantH = (fFlags & DDSD_HEIGHT) !== 0;
            const wantPf = (fFlags & DDSD_PIXELFORMAT) !== 0;
            if (wantW || wantH || wantPf) {
                // Faithful: honor the caller's filter exactly — even when it matches zero
                // modes (real DDraw then invokes the callback zero times and returns DD_OK;
                // it does NOT fall back to enumerating everything). The empty-list case is
                // handled below by returning synchronously without parking the thunk.
                modes = modes.filter((m) =>
                    (!wantW || m.width === fWidth) &&
                    (!wantH || m.height === fHeight) &&
                    (!wantPf || m.bpp === fBpp)
                );
                Logger.log(LogCategory.DDRAW,
                    `EnumDisplayModes: filter flags=0x${fFlags.toString(16)} ` +
                    `${wantW ? `w=${fWidth} ` : ''}${wantH ? `h=${fHeight} ` : ''}${wantPf ? `bpp=${fBpp} ` : ''}` +
                    `-> ${modes.length} matching mode(s)`);
            }
        }
        const includeRefreshRate = !!(dwFlags & DDEDM_REFRESHRATES);

        Logger.log(LogCategory.DDRAW, `EnumDisplayModes: ${modes.length} modes, refreshRate=${includeRefreshRate}, v1=${useV1Desc}`);

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return DD_OK;
        // No modes to enumerate → return synchronously WITHOUT suspending the thunk.
        // Parking (saveSuspendedThunkContext) then invoking zero callbacks leaves the
        // thread async-parked with no completion to wake it (the SAFETY_NET spin).
        if (modes.length === 0) return DD_OK;
        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP_ENUMDISPLAYMODES);

        let index = 0;
        let firstCallbackId: number | null = null;
        const processNext = (): void => {
            try {
                if (index >= modes.length) return;
                const mode = modes[index++];
                const refreshRate = includeRefreshRate
                    ? (mode.refreshRate || emulatorConfig.screenResolution.refreshRate || 60)
                    : 0;

                if (useV1Desc) {
                    // IDirectDraw/IDirectDraw2: callback expects DDSURFACEDESC (108 bytes)
                    const descAddr = context.process.memory.alloc(DDSURFACEDESC_SIZE);
                    writeDisplayModeDescV1(mem, descAddr, mode.width, mode.height, mode.bpp, refreshRate);
                    invokeEnumCallback(descAddr);
                } else {
                    // IDirectDraw4/IDirectDraw7: callback expects DDSURFACEDESC2 (124 bytes)
                    const descSize = DDSURFACEDESC2_SIZE;
                    const descAddr = context.process.memory.alloc(descSize);
                    writeDisplayModeDesc(mem, descAddr, descSize, mode.width, mode.height, mode.bpp, refreshRate);
                    invokeEnumCallback(descAddr);
                }
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `EnumDisplayModes: error in callback: ${e}`);
            }
        };

        const invokeEnumCallback = (descAddr: number): void => {
            const mode = modes[index - 1];
            const { callbackId } = callbackManager.invokeCallback(
                lpCallback,
                [descAddr, lpContext],
                0,
                (callbackReturnValue) => {
                    Logger.log(
                        LogCategory.DDRAW,
                        `EnumDisplayModes callback: ${mode.width}x${mode.height}x${mode.bpp} -> ${callbackReturnValue === 0 ? "DDENUMRET_CANCEL" : "DDENUMRET_OK"}`
                    );

                    // Intentionally keep mode descriptors alive after callback return.
                    // Some games cache callback pointers and read mode data after
                    // EnumDisplayModes finishes (same pattern as EnumDevices pointers).
                    // Size impact is tiny (<=124 bytes per mode, typically one-time).

                    if (callbackReturnValue === 0 || index >= modes.length) {
                        return DD_OK;
                    }
                    return null;
                }
            );

            if (firstCallbackId === null) {
                firstCallbackId = callbackId;
            }

            const invocation = callbackManager.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = {
                    continueEnumeration: processNext,
                    finishEnumeration: () => {}
                };

                if (callbackId !== firstCallbackId && firstCallbackId !== null) {
                    const firstInvocation = callbackManager.getPendingCallback(firstCallbackId);
                    if (firstInvocation?.thunkContext) {
                        invocation.thunkContext = firstInvocation.thunkContext;
                    }
                }
            }
        };

        processNext();

        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: firstCallbackId || 0,
            stackCleanup: STACK_CLEANUP_ENUMDISPLAYMODES
        };
    };

    exports["IDirectDraw7_EnumDisplayModes"] = (ctx, mem, args) => {
        return enumDisplayModesImpl(ctx, mem, args, false);
    };

    // ========================================================================
    // IDirectDraw7::EnumSurfaces
    // ========================================================================
    // useV1Desc=true for IDirectDraw/IDirectDraw2 (callback receives DDSURFACEDESC,
    // 108 bytes), false for IDirectDraw4/IDirectDraw7 (DDSURFACEDESC2, 124 bytes).
    const enumSurfacesImpl = (ctx: any, mem: Uint8Array, args: number[], useV1Desc: boolean) => {
        const thisPtr = args[0];
        const dwFlags = args[1];
        const lpDDSD2 = args[2];
        const lpContext = args[3];
        const lpCallback = args[4];

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM,
            `IDirectDraw7_EnumSurfaces: this=0x${thisPtr.toString(16)}, flags=0x${dwFlags.toString(16)}, ` +
            `desc=0x${lpDDSD2.toString(16)}, cb=0x${lpCallback.toString(16)}, ret=0x${retAddr.toString(16)}`);

        if (!lpCallback) return E_POINTER;

        // Read filter criteria if provided
        let filterCaps = 0;
        let filterWidth = 0;
        let filterHeight = 0;
        let filterFlags = 0;
        if (lpDDSD2 && isValidAddress(mem, lpDDSD2, 4)) {
            const desc = readSurfaceDesc(mem, lpDDSD2);
            if (desc) {
                filterFlags = desc.flags;
                filterCaps = desc.caps;
                filterWidth = desc.width;
                filterHeight = desc.height;
            }
        }

        // Collect matching surfaces
        const allComObjects = context.resourceProvider.getAllComObjects();
        const matchingSurfaces: { address: number; state: DirectDrawSurfaceState }[] = [];

        for (const obj of allComObjects) {
            if (!(obj instanceof DirectDrawSurfaceObject)) continue;
            const state = obj.getState();
            const address = context.resourceProvider.getAddressForHandle(obj.handle);
            if (!address) continue;

            // DOESEXIST flag: only enumerate existing surfaces
            if (!(dwFlags & DDENUMSURFACES_DOESEXIST)) continue;

            if (dwFlags & DDENUMSURFACES_ALL) {
                // ALL: enumerate every surface
                matchingSurfaces.push({ address, state });
            } else if (dwFlags & DDENUMSURFACES_MATCH) {
                // MATCH: only surfaces matching the filter criteria
                let matches = true;
                if ((filterFlags & DDSD_CAPS) && filterCaps) {
                    if ((state.caps & filterCaps) !== filterCaps) matches = false;
                }
                if ((filterFlags & DDSD_WIDTH) && filterWidth) {
                    if (state.width !== filterWidth) matches = false;
                }
                if ((filterFlags & DDSD_HEIGHT) && filterHeight) {
                    if (state.height !== filterHeight) matches = false;
                }
                if (matches) {
                    matchingSurfaces.push({ address, state });
                }
            }
        }

        Logger.log(LogCategory.SYSTEM,
            `IDirectDraw7_EnumSurfaces: found ${matchingSurfaces.length} matching surfaces ` +
            `(filter: caps=0x${filterCaps.toString(16)} ${filterWidth}x${filterHeight})`);

        if (matchingSurfaces.length === 0) {
            return { value: DD_OK, stackCleanup: STACK_CLEANUP_ENUMSURFACES };
        }

        const callbackManager = context.process.dispatcher.callbackManager;
        if (!callbackManager) return { value: DD_OK, stackCleanup: STACK_CLEANUP_ENUMSURFACES };
        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP_ENUMSURFACES);

        let index = 0;
        let firstCallbackId: number | null = null;
        const allocatedMemory: number[] = [];

        const processNext = (): void => {
            try {
                if (index >= matchingSurfaces.length) return;
                const { address: surfAddr, state } = matchingSurfaces[index++];

                const descSize = useV1Desc ? DDSURFACEDESC_SIZE : DDSURFACEDESC2_SIZE;
                const descAddr = context.process.memory.alloc(descSize);
                allocatedMemory.push(descAddr);
                mem.fill(0, descAddr, descAddr + descSize);
                view.setUint32(descAddr, descSize, true); // dwSize

                const surfDesc: import("./structs").SurfaceDesc = {
                    size: descSize,
                    flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT,
                    width: state.width,
                    height: state.height,
                    pitch: state.pitch,
                    backBufferCount: 0,
                    caps: state.caps,
                    caps2: state.caps2,
                    surfacePtr: state.surfacePtr,
                    pixelFormat: state.format,
                };
                if (useV1Desc) writeSurfaceDescV1(mem, descAddr, surfDesc);
                else writeSurfaceDesc(mem, descAddr, surfDesc);

                // NOTE: Not calling AddRef here — many games don't
                // Release the surface in their EnumSurfaces callback, so AddRef would leak refs.
                // The surface stays alive as long as the DirectDraw object owns it.

                Logger.log(LogCategory.SYSTEM,
                    `IDirectDraw7_EnumSurfaces: callback #${index} surface=0x${surfAddr.toString(16)} ` +
                    `${state.width}x${state.height} caps=0x${state.caps.toString(16)}`);

                // Callback: (LPDIRECTDRAWSURFACE7, LPDDSURFACEDESC2, LPVOID)
                const { callbackId } = callbackManager.invokeCallback(
                    lpCallback,
                    [surfAddr, descAddr, lpContext],
                    0,
                    (callbackReturnValue) => {
                        const idx = allocatedMemory.indexOf(descAddr);
                        if (idx >= 0) {
                            allocatedMemory.splice(idx, 1);
                            context.process.memory.free(descAddr);
                        }

                        // DDENUMRET_CANCEL = 0, DDENUMRET_OK = 1
                        if (callbackReturnValue === 0) {
                            for (const addr of allocatedMemory) {
                                context.process.memory.free(addr);
                            }
                            allocatedMemory.length = 0;
                            return DD_OK;
                        }
                        if (index >= matchingSurfaces.length) {
                            for (const addr of allocatedMemory) {
                                context.process.memory.free(addr);
                            }
                            allocatedMemory.length = 0;
                            return DD_OK;
                        }
                        return null; // continue enumeration
                    }
                );

                if (firstCallbackId === null) {
                    firstCallbackId = callbackId;
                }

                const invocation = callbackManager.getPendingCallback(callbackId);
                if (invocation) {
                    invocation.enumerationState = {
                        continueEnumeration: processNext,
                        finishEnumeration: () => {
                            for (const addr of allocatedMemory) {
                                context.process.memory.free(addr);
                            }
                            allocatedMemory.length = 0;
                        }
                    };

                    if (callbackId !== firstCallbackId && firstCallbackId !== null) {
                        const firstInvocation = callbackManager.getPendingCallback(firstCallbackId);
                        if (firstInvocation?.thunkContext) {
                            invocation.thunkContext = firstInvocation.thunkContext;
                        }
                    }
                }
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `EnumSurfaces: error in callback: ${e}`);
                for (const addr of allocatedMemory) {
                    try {
                        context.process.memory.free(addr);
                    } catch (freeError) {
                        Logger.warn(LogCategory.SYSTEM, `EnumSurfaces: error freeing memory: ${freeError}`);
                    }
                }
                allocatedMemory.length = 0;
            }
        };

        processNext();

        return {
            value: 0,
            suspendedForCallback: true,
            callbackId: firstCallbackId || 0,
            stackCleanup: STACK_CLEANUP_ENUMSURFACES
        };
    };

    exports["IDirectDraw7_EnumSurfaces"] = (ctx, mem, args) => enumSurfacesImpl(ctx, mem, args, false);

    exports["IDirectDraw7_GetDisplayMode"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDDSurfaceDesc = args[1];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_GetDisplayMode: this=0x${thisPtr.toString(16)}, desc=0x${lpDDSurfaceDesc.toString(16)}, ret=0x${retAddr.toString(16)}`);

        if (!lpDDSurfaceDesc || !isValidAddress(mem, lpDDSurfaceDesc, 4)) return E_POINTER;
        const size = view.getUint32(lpDDSurfaceDesc, true);
        if (size < 16) return E_INVALIDARG;
        if (!isValidAddress(mem, lpDDSurfaceDesc, size)) return E_POINTER;

        writeDisplayModeDesc(mem, lpDDSurfaceDesc, size, context.display.width, context.display.height, context.display.bpp, context.display.refresh || 60);
        return DD_OK;
    };

    // Common implementation for all IDirectDraw versions (v1, v2, v4, v7)
    const flipToGDISurfaceImpl = async (ctx: any, mem: Uint8Array, args: number[]): Promise<number> => {
        const thisPtr = args[0];

        // GDI surface becomes the visible one again (overlay composite resumes).
        context.gdiSurfaceVisible = true;

        // Get primary surface
        const primaryAddr = context.surfaces.primary;
        if (!primaryAddr) {
            Logger.verbose(LogCategory.DDRAW, "FlipToGDISurface: no primary surface");
            return DDERR_NOTFOUND;
        }

        const primaryObj = surfaceAt(context.resourceProvider, primaryAddr);
        if (!primaryObj) {
            Logger.verbose(LogCategory.DDRAW, `FlipToGDISurface: primary missing at 0x${primaryAddr.toString(16)}`);
            return DDERR_NOTFOUND;
        }

        const primaryState = primaryObj.getState();

        // Sync active GDI DC to CPU surface memory
        syncActiveGdiContext(primaryState, primaryAddr, mem);

        // Frame Pacer: wait for next display refresh (pauses virtual time)
        await framePacer.waitForFrameSlot();

        // Present the primary surface to restore GDI control
        try {
            await context.presenter.present(primaryState, mem);
        } catch (e) {
            Logger.error(LogCategory.DDRAW, `FlipToGDISurface: Present failed: ${e}`);
            return E_FAIL;
        }

        return DD_OK;
    };

    // Register exports for all IDirectDraw interface versions (v1, v2, v4, v7)
    // NOTE: IDirectDraw7 exports must be defined directly (not via variable) for validator to find them
    exports["IDirectDraw_FlipToGDISurface"] = flipToGDISurfaceImpl;
    exports["IDirectDraw2_FlipToGDISurface"] = flipToGDISurfaceImpl;
    exports["IDirectDraw4_FlipToGDISurface"] = flipToGDISurfaceImpl;
    exports["IDirectDraw7_FlipToGDISurface"] = async (ctx: any, mem: Uint8Array, args: number[]): Promise<number> => {
        const thisPtr = args[0];

        // GDI surface becomes the visible one again (overlay composite resumes).
        context.gdiSurfaceVisible = true;

        // Get primary surface
        const primaryAddr = context.surfaces.primary;
        if (!primaryAddr) {
            Logger.verbose(LogCategory.DDRAW, "FlipToGDISurface: no primary surface");
            return DDERR_NOTFOUND;
        }

        const primaryObj = surfaceAt(context.resourceProvider, primaryAddr);
        if (!primaryObj) {
            Logger.verbose(LogCategory.DDRAW, `FlipToGDISurface: primary missing at 0x${primaryAddr.toString(16)}`);
            return DDERR_NOTFOUND;
        }

        const primaryState = primaryObj.getState();

        // Sync active GDI DC to CPU surface memory
        syncActiveGdiContext(primaryState, primaryAddr, mem);

        // Frame Pacer: wait for next display refresh (pauses virtual time)
        await framePacer.waitForFrameSlot();

        // Present the primary surface to restore GDI control
        try {
            await context.presenter.present(primaryState, mem);
        } catch (e) {
            Logger.error(LogCategory.DDRAW, `FlipToGDISurface: Present failed: ${e}`);
            return E_FAIL;
        }

        return DD_OK;
    };

    // Common implementation for all IDirectDraw versions (v1, v2, v4, v7)
    const getGDISurfaceImpl = (ctx: any, mem: Uint8Array, args: number[]): number => {
        const thisPtr = args[0];
        const lplpDDSurface = args[1];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;

        if (!lplpDDSurface || !isValidAddress(mem, lplpDDSurface, 4)) return E_POINTER;

        const primaryAddr = context.surfaces.primary;
        if (!primaryAddr) {
            view.setUint32(lplpDDSurface, 0, true);
            return DDERR_NOTFOUND;
        }

        const obj = context.resourceProvider.getComObjectByAddress(primaryAddr);
        if (obj) {
            obj.addRef();
            view.setUint32(lplpDDSurface, primaryAddr, true);
            return DD_OK;
        }

        view.setUint32(lplpDDSurface, 0, true);
        return DDERR_NOTFOUND;
    };

    // Register for all IDirectDraw interface versions (v1, v2, v4, v7)
    // NOTE: IDirectDraw7 exports must be defined directly (not via variable) for validator to find them
    exports["IDirectDraw_GetGDISurface"] = getGDISurfaceImpl;
    exports["IDirectDraw2_GetGDISurface"] = getGDISurfaceImpl;
    exports["IDirectDraw4_GetGDISurface"] = getGDISurfaceImpl;
    exports["IDirectDraw7_GetGDISurface"] = (ctx: any, mem: Uint8Array, args: number[]): number => {
        const thisPtr = args[0];
        const lplpDDSurface = args[1];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;

        if (!lplpDDSurface || !isValidAddress(mem, lplpDDSurface, 4)) return E_POINTER;

        const primaryAddr = context.surfaces.primary;
        if (!primaryAddr) {
            view.setUint32(lplpDDSurface, 0, true);
            return DDERR_NOTFOUND;
        }

        const obj = context.resourceProvider.getComObjectByAddress(primaryAddr);
        if (obj) {
            obj.addRef();
            view.setUint32(lplpDDSurface, primaryAddr, true);
            return DD_OK;
        }

        view.setUint32(lplpDDSurface, 0, true);
        return DDERR_NOTFOUND;
    };

    exports["IDirectDraw7_CreatePalette"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwFlags = args[1];
        const lpColorArray = args[2];
        const lplpDDPalette = args[3];
        const pUnkOuter = args[4];

        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_CreatePalette: this=0x${thisPtr.toString(16)}, flags=0x${dwFlags.toString(16)}, colors=0x${lpColorArray.toString(16)}, out=0x${lplpDDPalette.toString(16)}`);

        if (!lplpDDPalette || !isValidAddress(mem, lplpDDPalette, 4)) return E_POINTER;
        initReturnPtr(lplpDDPalette);

        const vtableAddr = getVTable("IDirectDrawPalette");
        if (!vtableAddr) return E_FAIL;

        const obj = ComObjectFactory.create(IID_IDirectDrawPalette, vtableAddr) as DirectDrawPaletteObject;
        if (!obj) return E_FAIL;

        obj.setCaps(dwFlags);

        if (lpColorArray && isValidAddress(mem, lpColorArray, 4)) {
            obj.setEntries(0, 256, lpColorArray, mem);
        }

        const objAddr = allocateComObject(context.process.memory, mem, vtableAddr);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpDDPalette, objAddr, true);
        context.resourceProvider.mapAddressToHandle(objAddr, obj.handle);

        Logger.log(LogCategory.SYSTEM, `CreatePalette -> 0x${objAddr.toString(16)} (handle=0x${obj.handle.toString(16)})`);
        return DD_OK;
    };

    /**
     * TestCooperativeLevel reports EXCLUSIVE-MODE ownership, not surface loss — that is
     * DirectDraw's split, and it is why a lost device shows up through IsLost/Restore instead
     * of here. Nothing else on this machine can take exclusive mode from us, so DD_OK is the
     * faithful answer even while surfaces are lost.
     */
    exports["IDirectDraw7_TestCooperativeLevel"] = (ctx, mem, args) => {
        return DD_OK;
    };

    /**
     * RestoreAllSurfaces: restore every lost surface owned by this DirectDraw object. Same
     * contract as IDirectDrawSurface7::Restore applied wholesale — the surfaces come back
     * valid with undefined (cleared) contents, and the call fails while there is still no
     * device to restore onto.
     */
    exports["IDirectDraw7_RestoreAllSurfaces"] = (ctx, mem, args) => {
        if (!gpuDeviceUsable()) {
            Logger.warn(LogCategory.DDRAW, `RestoreAllSurfaces refused — no GPU device yet (still recovering)`);
            return DDERR_SURFACELOST;
        }
        const restored = restoreAllLostSurfaces();
        if (restored > 0) {
            Logger.log(LogCategory.DDRAW,
                `RestoreAllSurfaces: ${restored} surface(s) revalidated (contents undefined, per DirectDraw)`);
        }
        return DD_OK;
    };

    exports["IDirectDraw7_GetDeviceIdentifier"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpdddi = args[1]; // Pointer to DDDEVICEIDENTIFIER2
        const dwFlags = args[2];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;

        Logger.log(LogCategory.SYSTEM, `IDirectDraw7_GetDeviceIdentifier: this=0x${thisPtr.toString(16)}, lpdddi=0x${lpdddi.toString(16)}, flags=0x${dwFlags.toString(16)}, ret=0x${retAddr.toString(16)}`);

        if (!lpdddi || !isValidAddress(mem, lpdddi, DDDEVICEIDENTIFIER2_SIZE)) {
            Logger.warn(LogCategory.SYSTEM, `GetDeviceIdentifier: Invalid lpdddi pointer 0x${lpdddi.toString(16)}`);
            return E_POINTER;
        }

        // Check if this buffer overlaps with any known COM object guards
        // Check the IDirectDraw object at thisPtr
        const thisGuardStart = thisPtr - 16;
        const thisGuardEnd = thisPtr + COM_OBJECT_SIZE + 16; // COM_OBJECT_SIZE + guard
        const bufferEnd = lpdddi + DDDEVICEIDENTIFIER2_SIZE;

        if ((lpdddi >= thisGuardStart && lpdddi < thisGuardEnd) ||
            (bufferEnd > thisGuardStart && bufferEnd <= thisGuardEnd)) {
            Logger.error(LogCategory.SYSTEM, `GetDeviceIdentifier buffer overlap 0x${lpdddi.toString(16)}-0x${bufferEnd.toString(16)} with COM guards 0x${thisGuardStart.toString(16)}-0x${thisGuardEnd.toString(16)}!`);
        }

        // Also check if the address is in the high memory COM allocation area
        if (lpdddi >= HIGH_MEMORY_COM_AREA) {
            Logger.warn(LogCategory.SYSTEM, `GetDeviceIdentifier: Buffer 0x${lpdddi.toString(16)} is in high memory (COM/thunk area) - potential overlap!`);
        }

        // Write minimal device info - matching the "Driver" and "Display" pattern we see
        const writeString = (offset: number, str: string, maxLen: number) => {
            const bytes = new TextEncoder().encode(str);
            const toWrite = Math.min(bytes.length, maxLen - 1);
            for (let i = 0; i < toWrite; i++) {
                mem[lpdddi + offset + i] = bytes[i];
            }
            mem[lpdddi + offset + toWrite] = 0; // Null terminator
        };

        // Zero the entire structure first
        mem.fill(0, lpdddi, lpdddi + DDDEVICEIDENTIFIER2_SIZE);

        // The SAME adapter D3D8/D3D9 report — see dx-adapter-identifier.ts. dwVendorId +
        // dwDeviceId is what an app matches against its own table of known cards to switch
        // work-arounds on and off; a pair that never shipped (the old ATI 0x1002 / 0x9999)
        // matches nothing, and a period-correct card would be worse still — it would ARM
        // work-arounds written for that silicon's bugs, which this renderer does not have.
        // An adapter newer than the title is the case with real evidence behind it: it is
        // exactly what these games get on a modern Windows machine, where they run.
        // szDriver is the display driver's file name, not a category word.
        writeString(DDDEVICEIDENTIFIER2_OFFSETS.szDriver, DEFAULT_DRIVER_DLL, DDDEVICEIDENTIFIER2_STRING_SIZE);
        writeString(DDDEVICEIDENTIFIER2_OFFSETS.szDescription, DEFAULT_DEVICE_DESC, DDDEVICEIDENTIFIER2_STRING_SIZE);

        // liDriverVersion (LARGE_INTEGER = 8 bytes)
        view.setBigUint64(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.liDriverVersion, DEFAULT_DRIVER_VERSION, true);

        // dwVendorId
        view.setUint32(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.dwVendorId, DEFAULT_VENDOR_ID, true);
        // dwDeviceId
        view.setUint32(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.dwDeviceId, DEFAULT_DEVICE_ID, true);
        // dwSubSysId
        view.setUint32(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.dwSubSysId, 0, true);
        // dwRevision
        view.setUint32(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.dwRevision, 1, true);

        // guidDeviceIdentifier (16 bytes) - fill with a recognizable pattern
        for (let i = 0; i < 16; i++) {
            mem[lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.guidDeviceIdentifier + i] = i;
        }

        // dwWHQLLevel
        view.setUint32(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.dwWHQLLevel, 0, true);

        return DD_OK;
    };

    exports["IDirectDraw7_GetScanLine"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpdwScanLine = args[1];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (lpdwScanLine && isValidAddress(mem, lpdwScanLine, 4)) {
            const status = rasterStatusAt(
                performance.now(),
                context.display.height,
                context.display.refresh || 60,
            );
            view.setUint32(lpdwScanLine, status.scanLine, true);
        }
        const now = performance.now();
        scanlineCount += 1;
        if (now - lastVblankLog >= 1000) {
            Logger.log(
                LogCategory.SYSTEM,
                `IDirectDraw7_GetScanLine: calls=${scanlineCount} this=0x${thisPtr.toString(16)}`
            );
            lastVblankLog = now;
            scanlineCount = 0;
        }
        return DD_OK;
    };

    exports["IDirectDraw7_GetVerticalBlankStatus"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpbIsInVB = args[1];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (lpbIsInVB && isValidAddress(mem, lpbIsInVB, 4)) {
            const status = rasterStatusAt(
                performance.now(),
                context.display.height,
                context.display.refresh || 60,
            );
            view.setUint32(lpbIsInVB, status.inVBlank ? 1 : 0, true);
        }
        const now = performance.now();
        vblankStatusCount += 1;
        if (now - lastVblankLog >= 1000) {
            Logger.log(
                LogCategory.SYSTEM,
                `IDirectDraw7_GetVerticalBlankStatus: calls=${vblankStatusCount} this=0x${thisPtr.toString(16)}`
            );
            lastVblankLog = now;
            vblankStatusCount = 0;
        }
        return DD_OK;
    };

    exports["IDirectDraw7_WaitForVerticalBlank"] = async (ctx, mem, args) => {
        const dwFlags = args[1];
        const now = performance.now();
        vblankWaitCount += 1;
        if (now - lastVblankLog >= 1000) {
            Logger.log(
                LogCategory.SYSTEM,
                `IDirectDraw7_WaitForVerticalBlank: calls=${vblankWaitCount} flags=0x${dwFlags.toString(16)}`
            );
            lastVblankLog = now;
            vblankWaitCount = 0;
        }

        // Block until next VBlank (rAF boundary) for BLOCKBEGIN and BLOCKEND.
        // rAF granularity is sufficient — no distinction needed between begin/end.
        if (dwFlags === DDWAITVB_BLOCKBEGIN || dwFlags === DDWAITVB_BLOCKEND) {
            await framePacer.waitForFrameSlot();
        }
        // DDWAITVB_BLOCKBEGINEVENT (0x04) — signal event, not needed yet

        return DD_OK;
    };

    assignStubsOnce(exports, createDirectDrawStubsExports(context), "ddraw stubs");
    Object.assign(exports, createDirectDrawPaletteClipperExports(context, commonQueryInterface));

    // IDirectDraw (v1) stub methods - delegate to v7 where possible
    const idirectDrawStubs = [
        "Compact", "CreateClipper", "CreatePalette", "CreateSurface",
        "DuplicateSurface", "EnumDisplayModes", "EnumSurfaces",
        "FlipToGDISurface", "GetCaps", "GetDisplayMode", "GetFourCCCodes",
        "GetGDISurface", "GetMonitorFrequency", "GetScanLine",
        "GetVerticalBlankStatus", "Initialize", "RestoreDisplayMode",
        "WaitForVerticalBlank"
    ];

    for (const method of idirectDrawStubs) {
        // Only create stub if method hasn't been explicitly defined above
        // Explicit definitions may have logging or special behavior that stubs would overwrite
        const key = `IDirectDraw_${method}`;
        if (!exports[key]) {
            exports[key] = (ctx, mem, args) => {
                const v7Method = exports[`IDirectDraw7_${method}`];
                if (v7Method) {
                    return v7Method(ctx, mem, args);
                }
                Logger.verbose(LogCategory.SYSTEM, `IDirectDraw_${method} stub called: this=0x${args[0].toString(16)}`);
                return DD_OK;
            };
        }
    }

    registerDirectDraw2Exports(exports, context, { commonQueryInterface, internalCreateSurface, enumDisplayModesImpl, enumSurfacesImpl });
    return exports;
};
