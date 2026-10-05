/**
 * IDirectDrawSurface (v1) methods, also serving IDirectDrawSurface2/3.
 *
 * Most v1 slots take exactly the v7 parameters and delegate straight to their v7
 * counterpart. The exceptions are the slots whose STRUCT grew in DX7: delegating
 * those makes the v7 handler write DX7-sized data into a DX1-sized caller buffer,
 * silently smashing the frame behind it. GetCaps is one (DDSCAPS is a single
 * DWORD; DDSCAPS2 is four), so it is implemented here against the v1 layout.
 */
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { DD_OK, DDERR_INVALIDPARAMS, E_FAIL } from "./constants";
import { isValidAddress } from "../../core/memory/address-guard";
import type { DirectDrawSurfaceObject } from "./com-objects";
import type { DDrawContext } from "./context";

type EnumAttachedImpl = (ctx: any, mem: Uint8Array, args: number[], useV2Desc: boolean) => any;

export function registerSurfaceV1Exports(
    exports: Record<string, ThunkImplementation>,
    context: DDrawContext,
    enumAttachedSurfacesImpl: EnumAttachedImpl,
): void {
    exports["IDirectDrawSurface_AddAttachedSurface"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_AddAttachedSurface"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_AddOverlayDirtyRect"] = () => DD_OK;
    exports["IDirectDrawSurface_Blt"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_Blt"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_BltBatch"] = () => DD_OK;
    exports["IDirectDrawSurface_BltFast"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_BltFast"]?.(ctx, mem, args) ?? DD_OK;
    };
    // Same parameters as v7, and it must run the real thing: the v1 interface is how
    // pre-DX7 titles both build and dismantle a flip chain, and answering DD_OK without
    // detaching leaks the reference AddAttachedSurface took.
    exports["IDirectDrawSurface_DeleteAttachedSurface"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_DeleteAttachedSurface"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_EnumAttachedSurfaces"] = (ctx, mem, args) => {
        return enumAttachedSurfacesImpl(ctx, mem, args, false);
    };
    exports["IDirectDrawSurface_EnumOverlayZOrders"] = () => DD_OK;
    exports["IDirectDrawSurface_Flip"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_Flip"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_GetAttachedSurface"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetAttachedSurface"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_GetBltStatus"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetBltStatus"]?.(ctx, mem, args) ?? DD_OK;
    };
    // GetCaps(LPDDSCAPS) — DDSCAPS is ONE DWORD. IDirectDrawSurface4/7 take DDSCAPS2
    // (dwCaps, dwCaps2, dwCaps3, dwCaps4 = 16 bytes); running that handler over a v1
    // caller's DDSCAPS overwrites 12 bytes past it — typically the caller's own frame.
    exports["IDirectDrawSurface_GetCaps"] = (ctx, mem, args) => {
        const lpDDSCaps = args[1];
        if (!lpDDSCaps || !isValidAddress(mem, lpDDSCaps, 4)) return DDERR_INVALIDPARAMS;

        const obj = context.resourceProvider.getComObjectByAddress(args[0]) as DirectDrawSurfaceObject | null;
        if (!obj) return E_FAIL;

        new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
            .setUint32(lpDDSCaps, obj.getState().caps, true);
        return DD_OK;
    };
    exports["IDirectDrawSurface_GetClipper"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetClipper"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_GetColorKey"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetColorKey"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_GetDC"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetDC"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_GetFlipStatus"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetFlipStatus"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_GetOverlayPosition"] = () => DD_OK;
    exports["IDirectDrawSurface_GetPalette"] = () => DD_OK;
    exports["IDirectDrawSurface_GetPixelFormat"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetPixelFormat"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_Initialize"] = () => DD_OK;
    exports["IDirectDrawSurface_IsLost"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_IsLost"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_ReleaseDC"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_ReleaseDC"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_Restore"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_Restore"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_SetClipper"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_SetClipper"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_SetColorKey"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_SetColorKey"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_SetOverlayPosition"] = () => DD_OK;
    exports["IDirectDrawSurface_SetPalette"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_SetPalette"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_UpdateOverlay"] = () => DD_OK;
    exports["IDirectDrawSurface_UpdateOverlayDisplay"] = () => DD_OK;
    exports["IDirectDrawSurface_UpdateOverlayZOrder"] = () => DD_OK;

    // Slots 36-39 belong to IDirectDrawSurface2/3, which a guest reaches by QI'ing this
    // same object; they live in the v1 table because v2/v3 append to it.
    exports["IDirectDrawSurface_GetDDInterface"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetDDInterface"]?.(ctx, mem, args) ?? DD_OK;
    };
    exports["IDirectDrawSurface_PageLock"] = () => DD_OK;
    exports["IDirectDrawSurface_PageUnlock"] = () => DD_OK;
    // v3 marshals DDSURFACEDESC, not DDSURFACEDESC2 — the two agree on every field up to
    // ddsCaps (offset 104), and SetSurfaceDesc only consumes dwFlags and lpSurface, both
    // inside that shared prefix.
    exports["IDirectDrawSurface_SetSurfaceDesc"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_SetSurfaceDesc"]?.(ctx, mem, args) ?? DD_OK;
    };
}
