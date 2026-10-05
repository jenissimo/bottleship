/**
 * The version each HLE system DLL reports to a guest that asks version.dll about it.
 *
 * We stand in for these DLLs, so the file version is not cosmetic: it is the only way a
 * pre-DirectX-setup app can discover which DirectX generation is installed, and games of
 * this era routinely refuse to start on a number they consider too old. The number must
 * therefore name the API level we actually implement — bumping it past that would trade a
 * clean "needs a newer DirectX" message for a crash on the first missing method.
 *
 * DLLs that ship with Windows report the manifest's OS version instead, because that is
 * literally what they are on a real install.
 */

import { EmulatorConfig } from "./emulator-config-manager";
import { buildVersionBlock, VersionInfo } from "./version-block";

/** VS_FIXEDFILEINFO.dwFileOS / dwFileType. */
const VOS__WINDOWS32 = 0x00000004;
const VOS_NT_WINDOWS32 = 0x00040004;
const VFT_DLL = 0x00000002;

const ver = (major: number, minor: number, build: number, revision: number): { ms: number; ls: number } => ({
    ms: (((major & 0xffff) << 16) | (minor & 0xffff)) >>> 0,
    ls: (((build & 0xffff) << 16) | (revision & 0xffff)) >>> 0,
});

/**
 * Version per canonical HLE module name (the keys of HLE_IMAGE_SLOT). A module absent
 * from this table has no version resource as far as the guest is concerned, which is the
 * honest answer for one whose real-world counterpart is a third-party DLL the bundle is
 * expected to ship itself — if it does, we read that file's own resource instead.
 */
const HLE_DLL_VERSION: Record<string, { major: number; minor: number; build: number; revision: number }> = {
    // DirectX 7.0 — the generation our DirectDraw/DirectSound/DirectInput/DirectPlay
    // surface implements (IDirectDraw7 and friends).
    ddraw: { major: 4, minor: 7, build: 0, revision: 700 },
    dsound: { major: 4, minor: 7, build: 0, revision: 700 },
    dinput: { major: 4, minor: 7, build: 0, revision: 700 },
    dplayx: { major: 4, minor: 7, build: 0, revision: 700 },
    // DirectX 8.1 — d3d8/dinput8 expose the 8.x interfaces.
    d3d8: { major: 4, minor: 8, build: 1, revision: 881 },
    dinput8: { major: 4, minor: 8, build: 1, revision: 881 },
    dpnhpast: { major: 4, minor: 8, build: 1, revision: 881 },
    dpnhupnp: { major: 4, minor: 8, build: 1, revision: 881 },
    // DirectX 9.0c.
    d3d9: { major: 4, minor: 9, build: 0, revision: 904 },
    d3dx9: { major: 9, minor: 29, build: 952, revision: 3111 },
    // Shipped with Windows but versioned independently of it: the common-controls
    // generation decides which control classes and message set exist.
    comctl32: { major: 5, minor: 80, build: 2614, revision: 3600 },
};

/** Modules that are part of Windows itself and therefore carry the OS version. */
const OS_VERSIONED_DLLS = new Set([
    "kernel32", "user32", "gdi32", "advapi32", "ntdll", "ole32", "shell32",
    "winmm", "version", "wsock32", "ws2_32", "riched32", "msacm32", "wtsapi32",
    "opengl32", "glu32",
]);

export interface HleDllVersion {
    major: number;
    minor: number;
    build: number;
    revision: number;
}

export function hleDllVersion(canonicalName: string): HleDllVersion | null {
    const pinned = HLE_DLL_VERSION[canonicalName];
    if (pinned) return pinned;
    if (!OS_VERSIONED_DLLS.has(canonicalName)) return null;
    const os = EmulatorConfig.getInstance().osVersion;
    return { major: os.major, minor: os.minor, build: os.build, revision: 0 };
}

const versionText = (v: HleDllVersion): string => `${v.major}.${v.minor}.${v.build}.${v.revision}`;

/**
 * Build the version resource an HLE DLL would have had on disk. Both string tables and the
 * translation record are present because an app that finds a fixed-file-info block with no
 * StringFileInfo behind it treats the file as unversioned.
 */
export function buildHleDllVersionBlock(canonicalName: string, fileName: string, wide: boolean): Uint8Array | null {
    const v = hleDllVersion(canonicalName);
    if (!v) return null;

    const os = EmulatorConfig.getInstance().osVersion;
    const fileVersion = ver(v.major, v.minor, v.build, v.revision);
    const info: VersionInfo = {
        fixed: {
            fileVersionMS: fileVersion.ms,
            fileVersionLS: fileVersion.ls,
            productVersionMS: fileVersion.ms,
            productVersionLS: fileVersion.ls,
            fileFlagsMask: 0x3f,
            fileFlags: 0,
            fileOS: os.platformId === 1 ? VOS__WINDOWS32 : VOS_NT_WINDOWS32,
            fileType: VFT_DLL,
            fileSubtype: 0,
        },
        strings: [{
            langCodePage: "040904B0",
            values: [
                ["CompanyName", "Microsoft Corporation"],
                ["FileDescription", fileName],
                ["FileVersion", versionText(v)],
                ["InternalName", canonicalName],
                ["OriginalFilename", fileName],
                ["ProductName", "Microsoft Windows Operating System"],
                ["ProductVersion", versionText(v)],
            ],
        }],
        translations: [{ lang: 0x0409, codePage: 0x04b0 }],
    };
    return buildVersionBlock(info, wide);
}
