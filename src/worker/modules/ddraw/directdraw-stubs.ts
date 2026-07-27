/**
 * IDirectDraw7 stub methods (Compact, EnumSurfaces, etc.).
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { DD_OK, DDERR_INVALIDPARAMS, DDERR_CANTDUPLICATE } from "./constants";
import { isValidAddress } from "../../core/memory/address-guard";
import type { DDrawContext } from "./context";
import { System } from "../../core/system";
import { restoreDisplayModeToDesktop } from "./directdraw";

export function createDirectDrawStubsExports(context: DDrawContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const stubMethods = [
        "Compact",
        "RestoreDisplayMode",
        "GetSurfaceFromDC",
        "RestoreAllSurfaces",
        "StartModeTest",
        "EvaluateMode",
    ];

    for (const method of stubMethods) {
        exports[`IDirectDraw7_${method}`] = (ctx, mem, args) => {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
            Logger.log(LogCategory.SYSTEM, `IDirectDraw7_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
            if (method === "RestoreDisplayMode") {
                // Faithful: revert the current display mode back to the saved desktop mode,
                // resize the host, and broadcast WM_DISPLAYCHANGE. Leaving exclusive returns
                // the screen to GDI.
                restoreDisplayModeToDesktop(System.getInstance(), context);
                context.cooperative.exclusive = false;
                context.gdiSurfaceVisible = true;
            }
            return DD_OK;
        };
    }

    // GetMonitorFrequency(LPDWORD) — the refresh rate of the mode currently set.
    // Callers derive their frame budget from it; a DD_OK that leaves the DWORD
    // holding stack garbage yields a nonsense (or zero → division) frame time.
    exports["IDirectDraw7_GetMonitorFrequency"] = (ctx, mem, args) => {
        const lpdwFrequency = args[1];
        if (!lpdwFrequency || !isValidAddress(mem, lpdwFrequency, 4)) return DDERR_INVALIDPARAMS;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpdwFrequency, context.display.refresh || 60, true);
        return DD_OK;
    };

    // GetFourCCCodes(LPDWORD lpNumCodes, LPDWORD lpCodes) — *lpNumCodes is IN (array
    // capacity) and OUT (number of codes available). We expose no FourCC blit formats,
    // so the honest answer is zero; leaving it unwritten made the caller walk lpCodes
    // for however many entries its stack happened to hold.
    exports["IDirectDraw7_GetFourCCCodes"] = (ctx, mem, args) => {
        const lpNumCodes = args[1];
        if (!lpNumCodes || !isValidAddress(mem, lpNumCodes, 4)) return DDERR_INVALIDPARAMS;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpNumCodes, 0, true);
        return DD_OK;
    };

    // DuplicateSurface(LPDIRECTDRAWSURFACE, LPDIRECTDRAWSURFACE*) — we cannot clone a
    // surface, and DD_OK with an unwritten out-pointer sends the caller through a vtable
    // on whatever its stack held. DDERR_CANTDUPLICATE is a documented outcome of this
    // very call, so the guest takes its own fallback instead of a wild jump.
    exports["IDirectDraw7_DuplicateSurface"] = (ctx, mem, args) => {
        const lplpDupDDSurface = args[2];
        if (!lplpDupDDSurface || !isValidAddress(mem, lplpDupDDSurface, 4)) return DDERR_INVALIDPARAMS;
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(lplpDupDDSurface, 0, true);
        Logger.warn(LogCategory.DDRAW,
            `IDirectDraw7_DuplicateSurface: refusing to duplicate 0x${args[1].toString(16)}`);
        return DDERR_CANTDUPLICATE;
    };

    return exports;
}
