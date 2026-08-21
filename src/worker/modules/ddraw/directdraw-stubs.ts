/**
 * IDirectDraw7 stub methods (Compact, EnumSurfaces, etc.).
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { DD_OK, DDERR_INVALIDPARAMS, DDERR_CANTDUPLICATE, SUPPORTED_FOURCC_CODES } from "./constants";
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
    // capacity, only when lpCodes is non-NULL) and OUT (how many codes exist). Answering
    // zero while DDCAPS advertises DDCAPS_BLTFOURCC contradicted the Blt path, which really
    // does take a block-compressed source (surface-blt-flip copyCompressedSurfaceRegion →
    // decodeD3DTextureToRgba8). These five are exactly the FourCCs that decoder accepts.
    exports["IDirectDraw7_GetFourCCCodes"] = (ctx, mem, args) => {
        const lpNumCodes = args[1];
        const lpCodes = args[2];
        if (!lpNumCodes || !isValidAddress(mem, lpNumCodes, 4)) return DDERR_INVALIDPARAMS;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const capacity = lpCodes ? view.getUint32(lpNumCodes, true) : 0;
        view.setUint32(lpNumCodes, SUPPORTED_FOURCC_CODES.length, true);
        if (!lpCodes) return DD_OK;
        // Real DDraw fills up to the caller's capacity and reports the full count.
        const n = Math.min(capacity, SUPPORTED_FOURCC_CODES.length);
        if (n > 0 && !isValidAddress(mem, lpCodes, n * 4, "rw")) return DDERR_INVALIDPARAMS;
        for (let i = 0; i < n; i++) view.setUint32(lpCodes + i * 4, SUPPORTED_FOURCC_CODES[i], true);
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
