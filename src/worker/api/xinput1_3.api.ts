/**
 * XINPUT1_3.DLL API descriptor — the Xbox 360 controller API.
 *
 * Ordinals and arities are the Wine spec's (dlls/xinput1_3/xinput1_3.spec), which is the
 * only published table for a DLL whose import libraries link BY ORDINAL: a PE that imports
 * xinput carries no names at all, so an ordinal we do not declare is an unbindable import
 * that fails the whole image load. Every export is therefore declared TWICE — once under
 * its name, once as `ord_N` with the `ordinal:` tag — because the two are separate lookup
 * keys (PELoader.resolveImportName maps an ordinal through `ordinal:`, then the dispatcher
 * looks the resulting name up in the export table).
 *
 * The DWORD these functions return is a Win32 STATUS, so 0 is ERROR_SUCCESS: an export
 * declared here with no handler must say so with `onUnimplemented`, or a caller reads the
 * default zero as "the pad answered" and walks a success branch over an untouched struct.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    ...overrides,
    name,
    ordinal: overrides.ordinal,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
    // A DWORD Win32 status: ERROR_CALL_NOT_IMPLEMENTED, never the success-shaped 0.
    onUnimplemented: overrides.onUnimplemented ?? "win32Status",
});

export const xinput1_3Module: ModuleDescriptor = {
    name: "xinput1_3",
    functions: [
        // 1 — DllMain(HINSTANCE, DWORD, LPVOID). Private in the spec, but an ordinal import
        // of it still has to bind, and BOOL FALSE is the honest answer for a call we never
        // route (the loader runs our own init, not the guest's).
        makeFunc("ord_1", 3, { ordinal: 1, onUnimplemented: "zero" }),
        makeFunc("DllMain", 3, { onUnimplemented: "zero" }),

        // 2 — XInputGetState(DWORD dwUserIndex, XINPUT_STATE *pState)
        makeFunc("ord_2", 2, { ordinal: 2 }),
        makeFunc("XInputGetState", 2),

        // 3 — XInputSetState(DWORD dwUserIndex, XINPUT_VIBRATION *pVibration)
        makeFunc("ord_3", 2, { ordinal: 3 }),
        makeFunc("XInputSetState", 2),

        // 4 — XInputGetCapabilities(DWORD dwUserIndex, DWORD dwFlags, XINPUT_CAPABILITIES *pCaps)
        makeFunc("ord_4", 3, { ordinal: 4 }),
        makeFunc("XInputGetCapabilities", 3),

        // 5 — void XInputEnable(BOOL enable). No status to return, so "zero" is not a lie.
        makeFunc("ord_5", 1, { ordinal: 5, onUnimplemented: "zero" }),
        makeFunc("XInputEnable", 1, { onUnimplemented: "zero" }),

        // 6 — XInputGetDSoundAudioDeviceGuids(DWORD, GUID *pRender, GUID *pCapture)
        makeFunc("ord_6", 3, { ordinal: 6 }),
        makeFunc("XInputGetDSoundAudioDeviceGuids", 3),

        // 7 — XInputGetBatteryInformation(DWORD, BYTE devType, XINPUT_BATTERY_INFORMATION *)
        makeFunc("ord_7", 3, { ordinal: 7 }),
        makeFunc("XInputGetBatteryInformation", 3),

        // 8 — XInputGetKeystroke(DWORD, DWORD dwReserved, PXINPUT_KEYSTROKE)
        makeFunc("ord_8", 3, { ordinal: 8 }),
        makeFunc("XInputGetKeystroke", 3),

        // 10 / 108 — xinput1_4 additions, reached through the version alias. Declared so an
        // ordinal import of a 1.4-linked title binds; both are stubs upstream too.
        makeFunc("ord_10", 5, { ordinal: 10 }),
        makeFunc("XInputGetAudioDeviceIds", 5),
        makeFunc("ord_108", 4, { ordinal: 108 }),
        makeFunc("XInputGetCapabilitiesEx", 4),

        // 100 — XInputGetStateEx(DWORD, XINPUT_STATE *). Undocumented; identical to
        // XInputGetState except that it also reports the guide button.
        makeFunc("ord_100", 2, { ordinal: 100 }),
        makeFunc("XInputGetStateEx", 2),
    ],
};
