/**
 * Canonical catalog of HLE-provided system DLLs and virtual filesystem presence rules.
 *
 * Each of these gets a synthetic PE image in the HLE arena at the top of ROM, and its
 * HMODULE is that image's base — the Windows invariant HMODULE == ImageBase, which
 * pattern scanners, mod loaders and dbghelp!ImageNtHeader all depend on. The VFS layer
 * advertises matching paths under C:\WINDOWS\SYSTEM and C:\WINDOWS\SYSTEM32 so pre-load
 * existence probes (GetFileAttributes, _access, SearchPath) agree with module load
 * semantics.
 *
 * Note one divergence from real Windows that this does NOT close: a guest's IAT is
 * patched with THUNK_CODE stub addresses by the PE loader, while an export walk of the
 * image yields the in-image body. Patching the in-image body therefore does not
 * intercept calls another module makes through its IAT.
 */

import { normalizeDllBaseName, resolveThunkedDllAlias } from "./dll-aliases";
import { findDllRule } from "./dll-rules";
import {
    EMU_NATIVE_VIDEO_DLLS, VIDEO_DLL_NAMES,
    MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE, HLE_IMAGE_SLOT_SIZE,
} from "./cpu/emulator-config";
import { EmulatorConfig } from "./emulator-config-manager";

/**
 * Arena slot per thunked system DLL. The INDEX is the pinned identity, not the address:
 * appending a module must never move an existing one, or every base in a log, a saved
 * `re resolve --base` invocation or an open bug report silently means something else.
 * Append only; never renumber. Modules known only to the APIRegistry take the remaining
 * slots (see hle-module-images.ts).
 */
export const HLE_IMAGE_SLOT: Record<string, number> = {
    kernel32: 0,
    user32: 1,
    gdi32: 2,
    advapi32: 3,
    ntdll: 4,
    ole32: 5,
    ddraw: 6,
    dsound: 7,
    dinput: 8,
    dinput8: 9,
    winmm: 10,
    shell32: 11,
    comctl32: 12,
    version: 13,
    wsock32: 14,
    ws2_32: 15,
    mss32: 16,
    dplayx: 17,
    smackw32: 18,
    binkw32: 19,
    glide2x: 20,
    quartz: 21,
    opengl32: 22,
    glu32: 23,
    gdiplus: 24,
    bass: 25,
    d3d8: 26,
    d3d9: 27,
    d3dx9: 28,
    dpnhpast: 29,
    dpnhupnp: 30,
    w32skrnl: 31,
    riched32: 32,
    wtsapi32: 33,
    lgvid: 34,
    msacm32: 35,
};

/** Slots past the pinned block, handed to APIRegistry-only modules in sorted order. */
export const HLE_IMAGE_FIRST_FREE_SLOT = Object.values(HLE_IMAGE_SLOT).reduce((m, i) => Math.max(m, i), -1) + 1;
export const HLE_IMAGE_SLOT_COUNT = Math.floor(MEM_HLE_IMAGE_SIZE / HLE_IMAGE_SLOT_SIZE);

/** Image base for a pinned slot index. */
export function hleImageBaseForSlot(slot: number): number {
    return (MEM_HLE_IMAGE_BASE + slot * HLE_IMAGE_SLOT_SIZE) >>> 0;
}

/**
 * The image base IS the module identity: LoadLibrary hands it out and GetProcAddress
 * maps it back to a name. Two modules sharing one slot makes that map many-to-one, and
 * the loser's every export resolves against the winner — a live handle whose exports are
 * all NULL, with nothing in the log to say why. These are build-time constants, so a
 * violation is a programming error and is refused at import rather than left to surface
 * as a mute lookup failure.
 */
(function assertHleImageLayout(): void {
    const bySlot = new Map<number, string[]>();
    for (const [name, slot] of Object.entries(HLE_IMAGE_SLOT)) {
        if (!Number.isInteger(slot) || slot < 0) {
            throw new Error(`HLE_IMAGE_SLOT: "${name}" has a non-integer slot ${slot}`);
        }
        const names = bySlot.get(slot);
        if (names) names.push(name); else bySlot.set(slot, [name]);
    }
    const collisions = [...bySlot.entries()].filter(([, names]) => names.length > 1);
    if (collisions.length > 0) {
        throw new Error(
            "HLE_IMAGE_SLOT: duplicate slot(s) — " +
            collisions.map(([slot, names]) => `${slot} shared by ${names.join(", ")}`).join("; "));
    }
    if (HLE_IMAGE_FIRST_FREE_SLOT > HLE_IMAGE_SLOT_COUNT) {
        throw new Error(
            `HLE_IMAGE_SLOT: ${HLE_IMAGE_FIRST_FREE_SLOT} pinned slots exceed the ` +
            `${HLE_IMAGE_SLOT_COUNT}-slot arena (MEM_HLE_IMAGE_SIZE=0x${MEM_HLE_IMAGE_SIZE.toString(16)})`);
    }
    // Windows allocation granularity: a scanner that rounds a code address down with
    // `addr & 0xFFFF0000` to find its module must land on the base.
    if (MEM_HLE_IMAGE_BASE % 0x10000 !== 0 || HLE_IMAGE_SLOT_SIZE % 0x10000 !== 0) {
        throw new Error("HLE image arena must be 64KB-aligned in both base and slot size");
    }
})();

export const HLE_SYSTEM_DLL_NAMES = new Set(Object.keys(HLE_IMAGE_SLOT));

/** Win9x vs NT system directory segments (case-insensitive match). */
export const SYSTEM_DIRECTORY_SEGMENTS = ["windows\\system", "windows\\system32"] as const;

/** Directories always present on a Windows install even when absent from the ROM. */
export const VIRTUAL_SYSTEM_DIRECTORY_PATHS = new Set([
    "c:\\windows",
    "c:\\windows\\system",
    "c:\\windows\\system32",
]);

/**
 * Size reported for a virtual HLE DLL stat probe. It IS the arena slot size, so the size
 * a guest sees on disk and the SizeOfImage in the synthetic PE cannot drift apart.
 */
export const VIRTUAL_HLE_DLL_SIZE = HLE_IMAGE_SLOT_SIZE;

/** Mirrors LoadLibrary disabledDlls blocking for virtual presence. */
export function isBlockedByDisabledDlls(pathOrName: string): boolean {
    return findDllRule(EmulatorConfig.getInstance().disabledDlls, pathOrName) !== null;
}

export function isUnderSystemDirectory(normalizedPath: string): boolean {
    const lower = normalizedPath.toLowerCase();
    if (!lower.startsWith("c:\\")) return false;
    const rest = lower.slice(3);
    return SYSTEM_DIRECTORY_SEGMENTS.some((seg) => rest === seg || rest.startsWith(`${seg}\\`));
}

export function isVirtualSystemDirectory(normalizedPath: string): boolean {
    return VIRTUAL_SYSTEM_DIRECTORY_PATHS.has(normalizedPath.toLowerCase());
}

/**
 * UE1 native packages (e.g. Galaxy.dll) self-register their UClass via IMPLEMENT_CLASS in
 * C++ static-init when the DLL actually loads. They MUST load for real: an HLE presence
 * makes LoadLibrary satisfy the request without the real load, so the class is never
 * registered and UE1 aborts with "Failed to find object 'Class Galaxy.GalaxyAudioSubsystem'".
 * Their HLE is designed to PATCH the real DLL after load (native-patch.ts), never to
 * replace it — so they get neither a synthetic image nor a registry entry.
 */
export const FORCE_NATIVE_PACKAGE_LOAD = new Set<string>(["galaxy"]);

/**
 * May this module have a synthetic image, i.e. may an HMODULE for it ever exist?
 *
 * Deliberately NOT the same question as isVirtualHleSystemFile: that one asks whether the
 * VFS advertises the file, and answers no under disabledDlls or native-video mode so the
 * REAL DLL is found instead. Whether an image exists is separate from who is handed its
 * base — LoadLibrary and GetModuleHandle still apply those policies before returning one.
 * The only modules that must never have an image are the forced-native packages, because
 * for them an HLE presence at all is what suppresses the real load.
 */
export function hleModuleMayHaveImage(canonicalName: string): boolean {
    return !!canonicalName && !FORCE_NATIVE_PACKAGE_LOAD.has(canonicalName);
}

/**
 * True when the guest path names an HLE system DLL that LoadLibrary would satisfy
 * without a ROM/overlay PE (respects disabledDlls and native-video mode).
 */
export function isVirtualHleSystemFile(normalizedPath: string): boolean {
    if (!isUnderSystemDirectory(normalizedPath)) return false;

    const canonical = resolveThunkedDllAlias(normalizeDllBaseName(normalizedPath));
    if (!canonical || !HLE_SYSTEM_DLL_NAMES.has(canonical)) return false;

    if (EMU_NATIVE_VIDEO_DLLS && VIDEO_DLL_NAMES.has(canonical)) {
        return false;
    }

    if (isBlockedByDisabledDlls(normalizedPath) || isBlockedByDisabledDlls(canonical)) {
        return false;
    }

    return true;
}
