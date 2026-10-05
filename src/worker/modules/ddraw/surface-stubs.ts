/**
 * IDirectDrawSurface7 stub methods and delegate lists.
 * Real implementations (IsLost, Restore, etc.) live in surface.ts.
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { DD_OK, DDSCAPS_TEXTURE, DDGAMMARAMP_SIZE, DDERR_NOPALETTEATTACHED } from "./constants";
import { DirectDrawSurfaceObject } from "./com-objects";
import { isValidAddress } from "../../core/memory/address-guard";
import { gammaService } from "../../core/gamma-service";
import type { DDrawContext } from "./context";

// ddraw.h aliases DDERR_INVALIDPARAMS onto E_INVALIDARG; DDERR_INVALIDOBJECT is MAKE_DDHRESULT(130).
const DDERR_INVALIDPARAMS = 0x80070057;
const DDERR_INVALIDOBJECT = 0x88760082;

export function createSurfaceStubsExports(context: DDrawContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const stubMethods = [
        "AddOverlayDirtyRect",
        "BltBatch",
        "EnumOverlayZOrders",
        "GetOverlayPosition",
        "Initialize",
        "SetOverlayPosition",
        "UpdateOverlay",
        "UpdateOverlayDisplay",
        "UpdateOverlayZOrder",
        "GetUniquenessValue",
        "ChangeUniquenessValue",
        "SetPriority",
        "GetPriority",
        "SetLOD",
        "GetLOD",
    ];

    for (const method of stubMethods) {
        if (method === "BltBatch") {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                Logger.log(LogCategory.SYSTEM, `IDirectDrawSurface7_BltBatch: this=0x${args[0].toString(16)}`);
                return DD_OK;
            };
        } else if (method === "SetLOD" || method === "GetLOD") {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                const thisPtr = args[0];
                const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
                const isTexture = obj ? (obj.getState().caps & DDSCAPS_TEXTURE) !== 0 : false;
                const msg = `IDirectDrawSurface7_${method}: this=0x${thisPtr.toString(16)}${isTexture ? " [TEXTURE]" : ""}`;
                Logger.log(LogCategory.SYSTEM, msg);
                if (isTexture) {
                    Logger.log(LogCategory.DDRAW, msg);
                }
                return DD_OK;
            };
        } else {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
                Logger.verbose(LogCategory.SYSTEM, `IDirectDrawSurface7_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
                return DD_OK;
            };
        }
    }

    // GetDDInterface(lplpDD) — hands back the very IDirectDraw interface the surface was
    // created through, AddRef'd. The version matters: a surface from
    // IDirectDraw::CreateSurface must yield an IDirectDraw, never an IDirectDraw7,
    // or the caller invokes v7 slots through a 23-slot table.
    exports["IDirectDrawSurface7_GetDDInterface"] = (ctx, mem, args) => {
        const lplpDD = args[1];
        if (!lplpDD || !isValidAddress(mem, lplpDD, 4)) return DDERR_INVALIDPARAMS;

        const obj = context.resourceProvider.getComObjectByAddress(args[0]) as DirectDrawSurfaceObject | null;
        const ownerAddr = obj?.getDDrawOwnerAddr() ?? 0;
        const ownerObj = ownerAddr ? context.resourceProvider.getComObjectByAddress(ownerAddr) : null;
        if (!ownerObj) {
            Logger.warn(LogCategory.DDRAW,
                `IDirectDrawSurface7_GetDDInterface: no owning IDirectDraw for surface 0x${args[0].toString(16)}`);
            return DDERR_INVALIDOBJECT;
        }

        ownerObj.addRef();
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(lplpDD, ownerAddr, true);
        return DD_OK;
    };

    // GetPalette(lplpDDPalette) — the attached palette, AddRef'd, mirroring GetClipper.
    // Without a palette the out-pointer is NULLed and the call fails: returning DD_OK
    // over an untouched out-pointer had the caller invoke a vtable on stack garbage.
    exports["IDirectDrawSurface7_GetPalette"] = (ctx, mem, args) => {
        const lplpDDPalette = args[1];
        if (!lplpDDPalette || !isValidAddress(mem, lplpDDPalette, 4)) return DDERR_INVALIDPARAMS;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lplpDDPalette, 0, true);

        const obj = context.resourceProvider.getComObjectByAddress(args[0]) as DirectDrawSurfaceObject | null;
        if (!obj) return DDERR_INVALIDOBJECT;

        const state = obj.getState();
        const paletteObj = state.paletteHandle !== undefined
            ? context.resourceProvider.getComObject(state.paletteHandle)
            : null;
        if (!paletteObj) {
            state.paletteHandle = undefined;
            return DDERR_NOPALETTEATTACHED;
        }
        const paletteAddr = context.resourceProvider.getAddressForHandle(paletteObj.handle);
        if (!paletteAddr) return DDERR_NOPALETTEATTACHED;

        paletteObj.addRef();
        view.setUint32(lplpDDPalette, paletteAddr, true);
        return DD_OK;
    };

    // PageLock/PageUnlock pin a sysmem surface against the Windows pager. Nothing here is
    // pageable, so both succeed unconditionally — real ddraw does not validate dwFlags either.
    exports["IDirectDrawSurface7_PageLock"] = () => DD_OK;
    exports["IDirectDrawSurface7_PageUnlock"] = () => DD_OK;

    // =========================================================================
    // IDirectDrawGammaControl stubs
    // =========================================================================

    exports["IDirectDrawGammaControl_QueryInterface"] = (ctx, mem, args) => {
        Logger.log(LogCategory.COM, `IDirectDrawGammaControl_QueryInterface: this=0x${args[0].toString(16)} (stub)`);
        return 0x80004002; // E_NOINTERFACE
    };

    exports["IDirectDrawGammaControl_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirectDrawGammaControl_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    // GetGammaRamp(dwFlags, lpRampData) — write the current ramp (or linear identity) back to the guest.
    exports["IDirectDrawGammaControl_GetGammaRamp"] = (_ctx, mem, args) => {
        const lpRampData = args[2];
        if (!lpRampData || !isValidAddress(mem, lpRampData, DDGAMMARAMP_SIZE)) {
            return 0x80070057; // E_INVALIDARG
        }
        gammaService.writeToGuest(mem, lpRampData);
        return DD_OK;
    };

    // SetGammaRamp(dwFlags, lpRampData) — read the ramp from guest memory and apply via the shared sink.
    exports["IDirectDrawGammaControl_SetGammaRamp"] = (_ctx, mem, args) => {
        const lpRampData = args[2];
        if (!lpRampData || !isValidAddress(mem, lpRampData, DDGAMMARAMP_SIZE)) {
            return 0x80070057; // E_INVALIDARG
        }
        gammaService.applyFromGuest(mem, lpRampData);
        Logger.verbose(LogCategory.DDRAW, "IDirectDrawGammaControl_SetGammaRamp: applied");
        return DD_OK;
    };

    return exports;
}
