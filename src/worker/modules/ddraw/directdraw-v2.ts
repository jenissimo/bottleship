/**
 * IDirectDraw2 (+ a couple of IDirectDraw4) methods. IDirectDraw2 adds
 * GetAvailableVidMem to IDirectDraw and needs its own vtable. Most handlers
 * delegate to shared closure helpers via `deps` (commonQueryInterface /
 * internalCreateSurface / enumDisplayModesImpl / v7Method).
 */
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { DDrawContext } from "./context";
import { isValidAddress } from "../../core/memory/address-guard";
import {
    DD_OK, E_POINTER,
    DDDEVICEIDENTIFIER_SIZE, DDDEVICEIDENTIFIER2_OFFSETS, DDDEVICEIDENTIFIER2_STRING_SIZE,
    IID_IDirectDrawSurface,
} from "./constants";
import {
    DEFAULT_VENDOR_ID,
    DEFAULT_DEVICE_ID,
    DEFAULT_DRIVER_VERSION,
    DEFAULT_DEVICE_DESC,
    DEFAULT_DRIVER_DLL,
} from "../../backends/webgpu/shared/dx-adapter-identifier";

interface DirectDraw2Deps {
    commonQueryInterface: (thisPtr: number, riidPtr: number, ppvObject: number, mem: Uint8Array) => number;
    internalCreateSurface: (...a: any[]) => any;
    enumDisplayModesImpl: (...a: any[]) => any;
    enumSurfacesImpl: (...a: any[]) => any;
}

export function registerDirectDraw2Exports(
    exports: Record<string, ThunkImplementation>,
    context: DDrawContext,
    deps: DirectDraw2Deps,
): void {
    const { commonQueryInterface, internalCreateSurface, enumDisplayModesImpl, enumSurfacesImpl } = deps;
    // ===== IDirectDraw2 methods =====
    // IDirectDraw2 = IDirectDraw + GetAvailableVidMem (24 methods total)
    // Must have its own vtable — IDirectDraw vtable has 23 slots,
    // so slot 23 (GetAvailableVidMem) would read past the end!

    exports["IDirectDraw2_QueryInterface"] = (ctx, mem, args) => commonQueryInterface(args[0], args[1], args[2], mem);

    exports["IDirectDraw2_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef(args[0]) : 0;
    };

    exports["IDirectDraw2_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release(args[0]) : 0;
    };

    exports["IDirectDraw2_SetCooperativeLevel"] = (ctx, mem, args) => {
        return exports["IDirectDraw7_SetCooperativeLevel"]?.(ctx, mem, args) ?? DD_OK;
    };

    exports["IDirectDraw2_EnumDisplayModes"] = (ctx, mem, args) => {
        return enumDisplayModesImpl(ctx, mem, args, true);
    };

    // v1/v2 hand the callback a DDSURFACEDESC (108 bytes); only v4/v7 use DDSURFACEDESC2.
    exports["IDirectDraw2_EnumSurfaces"] = (ctx, mem, args) => {
        return enumSurfacesImpl(ctx, mem, args, true);
    };

    exports["IDirectDraw2_SetDisplayMode"] = (ctx, mem, args) => {
        // v2+: 5 data args (width, height, bpp, refreshRate, flags) — delegate to v7
        return exports["IDirectDraw7_SetDisplayMode"]?.(ctx, mem, args) ?? DD_OK;
    };

    exports["IDirectDraw2_CreateSurface"] = (ctx, mem, args) => {
        // v2: CreateSurface uses DDSURFACEDESC (v1, 108 bytes) — same as IDirectDraw
        const lpDDSurfaceDesc = args[1];
        const lplpDDSurface = args[2];
        const threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;

        Logger.log(LogCategory.SYSTEM,
            `IDirectDraw2_CreateSurface [TID=${threadId}]: this=0x${args[0].toString(16)}, ` +
            `desc=0x${lpDDSurfaceDesc.toString(16)}, out=0x${lplpDDSurface.toString(16)}`
        );

        return internalCreateSurface(mem, lpDDSurfaceDesc, lplpDDSurface, "IDirectDrawSurface", {
            threadId,
            enableDiagnostics: true,
            surfaceIid: IID_IDirectDrawSurface,
            ownerAddr: args[0]
        });
    };

    exports["IDirectDraw2_GetAvailableVidMem"] = (ctx, mem, args) => {
        return exports["IDirectDraw7_GetAvailableVidMem"]?.(ctx, mem, args) ?? DD_OK;
    };

    // Keep WaitForVerticalBlank synchronous for v2 (see v1 comment above)
    exports["IDirectDraw2_WaitForVerticalBlank"] = () => DD_OK;

    // IDirectDraw2 stub methods - delegate to v7 where possible
    const idirectDraw2Stubs = [
        "Compact", "CreateClipper", "CreatePalette",
        "DuplicateSurface", "EnumDisplayModes", "EnumSurfaces",
        "GetCaps", "GetDisplayMode", "GetFourCCCodes",
        "GetMonitorFrequency", "GetScanLine", "GetVerticalBlankStatus",
        "Initialize", "RestoreDisplayMode", "WaitForVerticalBlank",
    ];

    for (const method of idirectDraw2Stubs) {
        const key = `IDirectDraw2_${method}`;
        if (!exports[key]) {
            exports[key] = (ctx, mem, args) => {
                const v7Method = exports[`IDirectDraw7_${method}`];
                if (v7Method) {
                    return v7Method(ctx, mem, args);
                }
                Logger.verbose(LogCategory.SYSTEM, `IDirectDraw2_${method} stub called: this=0x${args[0].toString(16)}`);
                return DD_OK;
            };
        }
    }

    // Keep WaitForVerticalBlank synchronous for v4 (see v1 comment above)
    exports["IDirectDraw4_WaitForVerticalBlank"] = () => DD_OK;

    // IDirectDraw4::GetDeviceIdentifier uses DDDEVICEIDENTIFIER (DX6, 1064 bytes, NO dwWHQLLevel).
    // MUST NOT delegate to IDirectDraw7_GetDeviceIdentifier which uses DDDEVICEIDENTIFIER2 (DX7, 1068 bytes)
    // and writes dwWHQLLevel at offset 1064 — that offset may lie outside the game's allocated buffer,
    // corrupting adjacent stack data (including callback return stubs).
    exports["IDirectDraw4_GetDeviceIdentifier"] = (ctx, mem, args) => {
        const thisPtr = args[0];
        const lpdddi = args[1]; // Pointer to DDDEVICEIDENTIFIER (DX6, 1064 bytes, no WHQL)
        const dwFlags = args[2];
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        Logger.log(LogCategory.SYSTEM, `IDirectDraw4_GetDeviceIdentifier: this=0x${thisPtr.toString(16)}, lpdddi=0x${lpdddi.toString(16)}, flags=0x${dwFlags.toString(16)}`);

        if (!lpdddi || !isValidAddress(mem, lpdddi, DDDEVICEIDENTIFIER_SIZE)) {
            Logger.warn(LogCategory.SYSTEM, `IDirectDraw4_GetDeviceIdentifier: Invalid lpdddi pointer 0x${lpdddi.toString(16)}`);
            return E_POINTER;
        }

        // Zero DDDEVICEIDENTIFIER (DX6, 1064 bytes — no dwWHQLLevel)
        mem.fill(0, lpdddi, lpdddi + DDDEVICEIDENTIFIER_SIZE);

        // The SAME adapter D3D8/D3D9 report — see dx-adapter-identifier.ts. An app that
        // asks both interfaces in one process must not be told it is on two machines.
        // szDriver at offset 0 — the display driver's file name, not a category word.
        const driverBytes = new TextEncoder().encode(DEFAULT_DRIVER_DLL);
        const driverLen = Math.min(driverBytes.length, DDDEVICEIDENTIFIER2_STRING_SIZE - 1);
        for (let i = 0; i < driverLen; i++) mem[lpdddi + i] = driverBytes[i];

        // szDescription at offset 512
        const descBytes = new TextEncoder().encode(DEFAULT_DEVICE_DESC);
        const descLen = Math.min(descBytes.length, DDDEVICEIDENTIFIER2_STRING_SIZE - 1);
        for (let i = 0; i < descLen; i++) mem[lpdddi + 512 + i] = descBytes[i];

        // liDriverVersion at offset 1024
        view.setBigUint64(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.liDriverVersion, DEFAULT_DRIVER_VERSION, true);
        // dwVendorId at offset 1032
        view.setUint32(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.dwVendorId, DEFAULT_VENDOR_ID, true);
        // dwDeviceId at offset 1036
        view.setUint32(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.dwDeviceId, DEFAULT_DEVICE_ID, true);
        // dwSubSysId at offset 1040 stays zero; dwRevision at 1044 matches the D3D answer.
        view.setUint32(lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.dwRevision, 1, true);
        // guidDeviceIdentifier at offset 1048 (16 bytes)
        for (let i = 0; i < 16; i++) mem[lpdddi + DDDEVICEIDENTIFIER2_OFFSETS.guidDeviceIdentifier + i] = i;
        // NO dwWHQLLevel write — field does not exist in DX6 DDDEVICEIDENTIFIER

        return DD_OK;
    };

    // IDirectDraw4 stub methods - delegate to v7 where possible
    const idirectDraw4Stubs = [
        "Compact", "CreateClipper", "CreatePalette", "DuplicateSurface",
        "EnumDisplayModes", "EnumSurfaces", "FlipToGDISurface",
        "GetCaps", "GetDisplayMode", "GetFourCCCodes", "GetGDISurface",
        "GetMonitorFrequency", "GetScanLine", "GetVerticalBlankStatus",
        "Initialize", "RestoreDisplayMode", "WaitForVerticalBlank",
        "GetAvailableVidMem", "GetSurfaceFromDC", "RestoreAllSurfaces",
        "TestCooperativeLevel",
        // NOTE: GetDeviceIdentifier is NOT here — it has its own implementation above
        // that uses the correct DX6 DDDEVICEIDENTIFIER struct (1064 bytes, no dwWHQLLevel)
    ];

    for (const method of idirectDraw4Stubs) {
        const key = `IDirectDraw4_${method}`;
        if (!exports[key]) {
            exports[key] = (ctx, mem, args) => {
                const v7Method = exports[`IDirectDraw7_${method}`];
                if (v7Method) {
                    return v7Method(ctx, mem, args);
                }
                Logger.verbose(LogCategory.SYSTEM, `IDirectDraw4_${method} stub called: this=0x${args[0].toString(16)}`);
                return DD_OK;
            };
        }
    }

}
