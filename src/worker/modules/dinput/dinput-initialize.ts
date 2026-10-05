/**
 * IDirectInput[7|8]::Initialize(hinst, dwVersion) — the version handshake, as dinput.dll
 * and dinput8.dll answer it (Wine dinput.c dinput7_Initialize / dinput8_Initialize).
 * The interface generation decides which versions are "too new" and which are "beta".
 */

export const DI_OK = 0;
export const DIERR_INVALIDPARAM = 0x80070057;
/** MAKE_HRESULT(SEVERITY_ERROR, FACILITY_WIN32, ERROR_NOT_READY). */
export const DIERR_NOTINITIALIZED = 0x80070015;
/** ... ERROR_OLD_WIN_VERSION: the app asked for a newer DirectInput than this interface. */
export const DIERR_OLDDIRECTINPUTVERSION = 0x8007047e;
/** ... ERROR_RMODE_APP: a pre-release version number. */
export const DIERR_BETADIRECTINPUTVERSION = 0x80070481;

export const DIRECTINPUT_VERSION_8 = 0x0800;

/** The released DirectInput versions a DX3–DX7 interface accepts. */
const RELEASED_LEGACY_VERSIONS = new Set([0x0300, 0x0500, 0x050a, 0x05b2, 0x0602, 0x061a, 0x0700]);

export function directInputInitialize(hinst: number, version: number, isDirectInput8: boolean): number {
    if (!hinst) return DIERR_INVALIDPARAM;
    if (version === 0) return DIERR_NOTINITIALIZED;
    if (isDirectInput8) {
        if (version < DIRECTINPUT_VERSION_8) return DIERR_BETADIRECTINPUTVERSION;
        if (version > DIRECTINPUT_VERSION_8) return DIERR_OLDDIRECTINPUTVERSION;
        return DI_OK;
    }
    if (version > 0x0700) return DIERR_OLDDIRECTINPUTVERSION;
    if (!RELEASED_LEGACY_VERSIONS.has(version)) return DIERR_BETADIRECTINPUTVERSION;
    return DI_OK;
}
