/**
 * IDirectDrawSurface (v1) methods. The v1 vtable's first 36 slots are identical
 * to IDirectDrawSurface7, so most v1 methods delegate to their v7 counterpart
 * (the rest are faithful DD_OK stubs). `enumAttachedSurfacesImpl` is the shared
 * enumerator from surface.ts.
 */
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { DD_OK } from "./constants";

type EnumAttachedImpl = (ctx: any, mem: Uint8Array, args: number[], useV2Desc: boolean) => any;

export function registerSurfaceV1Exports(
    exports: Record<string, ThunkImplementation>,
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
    exports["IDirectDrawSurface_DeleteAttachedSurface"] = () => DD_OK;
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
    exports["IDirectDrawSurface_GetCaps"] = (ctx, mem, args) => {
        return exports["IDirectDrawSurface7_GetCaps"]?.(ctx, mem, args) ?? DD_OK;
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
