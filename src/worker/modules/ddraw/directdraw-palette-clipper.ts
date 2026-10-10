/**
 * IDirectDrawPalette and IDirectDrawClipper implementations.
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { DD_OK, E_FAIL, E_POINTER, E_NOINTERFACE, DDERR_INVALIDPARAMS, DDSCAPS_PRIMARYSURFACE } from "./constants";
import { bytesToGuid } from "./helpers";
import { DirectDrawPaletteObject, DirectDrawClipperObject, DirectDrawSurfaceObject } from "./com-objects";
import { setAuthorityCpu } from "./surface-sync";
import { isValidAddress } from "../../core/memory/address-guard";
import { Mem } from "../../core/memory/mem-accessor";
import type { DDrawContext } from "./context";

type CommonQueryInterface = (thisPtr: number, riidPtr: number, ppvObject: number, mem: Uint8Array) => number;

export function createDirectDrawPaletteClipperExports(
    context: DDrawContext,
    commonQueryInterface: CommonQueryInterface
): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const markSurfacesDirtyByPalette = (paletteHandle: number, mem: Uint8Array): void => {
        const allComObjects = context.resourceProvider.getAllComObjects();
        for (const obj of allComObjects) {
            if (!(obj instanceof DirectDrawSurfaceObject)) continue;
            const state = obj.getState();
            if (state.paletteHandle === paletteHandle) {
                setAuthorityCpu(state);
                // Palette animation changes scanout even when the application never flips.
                if ((state.caps & DDSCAPS_PRIMARYSURFACE) && !context.suppressPresent) {
                    void context.presenter?.present(state, mem, { throttle: true });
                }
            }
        }
    };

    exports["IDirectDrawPalette_QueryInterface"] = (ctx, mem, args) => commonQueryInterface(args[0], args[1], args[2], mem);
    exports["IDirectDrawPalette_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };
    exports["IDirectDrawPalette_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    exports["IDirectDrawPalette_SetEntries"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwFlags = args[1];
        const dwStartingEntry = args[2];
        const dwCount = args[3];
        const lpEntries = args[4];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawPaletteObject | null;
        if (!obj) return E_FAIL;

        if (dwCount > 0) {
            if (!lpEntries || !isValidAddress(mem, lpEntries, dwCount * 4)) {
                return E_POINTER;
            }
            if (dwStartingEntry + dwCount > 256) {
                return DDERR_INVALIDPARAMS;
            }
            obj.setEntries(dwStartingEntry, dwCount, lpEntries, mem);
            markSurfacesDirtyByPalette(obj.handle, mem);
        }

        Logger.log(LogCategory.DDRAW, `IDirectDrawPalette_SetEntries: this=0x${thisPtr.toString(16)} start=${dwStartingEntry} count=${dwCount}`);
        return DD_OK;
    };

    exports["IDirectDrawPalette_GetEntries"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const dwFlags = args[1];
        const dwStartingEntry = args[2];
        const dwCount = args[3];
        const lpEntries = args[4];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawPaletteObject | null;
        if (!obj) return E_FAIL;

        if (!lpEntries || !isValidAddress(mem, lpEntries, dwCount * 4)) {
            return E_POINTER;
        }

        if (dwStartingEntry + dwCount > 256) {
            return DDERR_INVALIDPARAMS;
        }

        const entriesRaw = obj.getEntriesRaw();
        for (let i = 0; i < dwCount; i++) {
            const idx = dwStartingEntry + i;
            const base = idx * 4;
            const dst = lpEntries + i * 4;

            if (dst < 0 || dst + 3 >= mem.length) {
                Logger.warn(LogCategory.DDRAW, `IDirectDrawPalette_GetEntries: out of bounds access at offset ${dst} (mem.length=${mem.length})`);
                break;
            }

            mem[dst] = entriesRaw[base];
            mem[dst + 1] = entriesRaw[base + 1];
            mem[dst + 2] = entriesRaw[base + 2];
            mem[dst + 3] = entriesRaw[base + 3];
        }

        Logger.verbose(LogCategory.DDRAW, `IDirectDrawPalette_GetEntries: this=0x${thisPtr.toString(16)} start=${dwStartingEntry} count=${dwCount}`);
        return DD_OK;
    };

    exports["IDirectDrawPalette_GetCaps"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpdwCaps = args[1];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawPaletteObject | null;
        if (!obj) return E_FAIL;

        if (!lpdwCaps || !isValidAddress(mem, lpdwCaps, 4)) {
            return E_POINTER;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(lpdwCaps, obj.getCaps(), true);

        Logger.verbose(LogCategory.DDRAW, `IDirectDrawPalette_GetCaps: this=0x${thisPtr.toString(16)} caps=0x${obj.getCaps().toString(16)}`);
        return DD_OK;
    };

    exports["IDirectDrawPalette_Initialize"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpDD = args[1];
        const dwFlags = args[2];
        const lpColorArray = args[3];

        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawPaletteObject | null;
        if (!obj) return E_FAIL;

        if (obj.getCaps() !== 0) {
            return DD_OK;
        }

        obj.setCaps(dwFlags);

        if (lpColorArray && isValidAddress(mem, lpColorArray, 4)) {
            obj.setEntries(0, 256, lpColorArray, mem);
        }

        Logger.log(LogCategory.DDRAW, `IDirectDrawPalette_Initialize: this=0x${thisPtr.toString(16)} flags=0x${dwFlags.toString(16)}`);
        return DD_OK;
    };

    exports["IDirectDrawClipper_QueryInterface"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const riidPtr = args[1];
        const ppvObject = args[2];
        if (!ppvObject || !isValidAddress(mem, ppvObject, 4)) return E_POINTER;
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr);
        if (!obj) return E_NOINTERFACE;
        return obj.queryInterface(bytesToGuid(mem.slice(riidPtr, riidPtr + 16)), ppvObject, mem);
    };
    exports["IDirectDrawClipper_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };
    exports["IDirectDrawClipper_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    exports["IDirectDrawClipper_SetHWnd"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const hWnd = args[2];
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawClipperObject | null;
        if (!obj) return E_FAIL;
        obj.setHwnd(hWnd);
        Logger.log(LogCategory.DDRAW, `IDirectDrawClipper_SetHWnd: this=0x${thisPtr.toString(16)} hwnd=0x${hWnd.toString(16)}`);
        return DD_OK;
    };

    exports["IDirectDrawClipper_GetHWnd"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lphWnd = args[1];
        if (!lphWnd || !isValidAddress(mem, lphWnd, 4)) return E_POINTER;
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawClipperObject | null;
        if (!obj) return E_FAIL;
        Mem.writeUint32(lphWnd, obj.getHwnd());
        return DD_OK;
    };

    exports["IDirectDrawClipper_SetClipList"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpClipList = args[1];
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawClipperObject | null;
        if (!obj) return E_FAIL;
        if (lpClipList && !isValidAddress(mem, lpClipList, 32)) return E_POINTER;
        if (!obj.setClipList(mem, lpClipList)) return DDERR_INVALIDPARAMS;
        Logger.verbose(LogCategory.DDRAW, `IDirectDrawClipper_SetClipList: this=0x${thisPtr.toString(16)} list=0x${lpClipList.toString(16)}`);
        return DD_OK;
    };

    exports["IDirectDrawClipper_GetClipList"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpClipList = args[1];
        const lpdwSize = args[2];
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawClipperObject | null;
        if (!obj) return E_FAIL;
        if (lpdwSize && !isValidAddress(mem, lpdwSize, 4)) return E_POINTER;
        if (lpClipList && !isValidAddress(mem, lpClipList, 4)) return E_POINTER;
        const result = obj.getClipList(mem, lpClipList, lpdwSize);
        if (result === "invalid") return DDERR_INVALIDPARAMS;
        if (result === "size") return DDERR_INVALIDPARAMS; // buffer too small - size written
        return DD_OK;
    };

    exports["IDirectDrawClipper_IsClipListChanged"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpbChanged = args[1];
        if (!lpbChanged || !isValidAddress(mem, lpbChanged, 4)) return E_POINTER;
        const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawClipperObject | null;
        if (!obj) return E_FAIL;
        Mem.writeUint32(lpbChanged, obj.isClipListChanged() ? 1 : 0);
        return DD_OK;
    };

    const clipperStubMethods = ["Initialize"];
    for (const method of clipperStubMethods) {
        exports[`IDirectDrawClipper_${method}`] = (ctx, mem, args) => {
            Logger.verbose(LogCategory.SYSTEM, `IDirectDrawClipper_${method}: this=0x${args[0].toString(16)}`);
            return DD_OK;
        };
    }

    return exports;
}
