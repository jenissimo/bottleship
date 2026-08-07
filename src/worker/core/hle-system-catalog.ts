/**
 * Canonical catalog of HLE-provided system DLLs and virtual filesystem presence rules.
 *
 * LoadLibrary resolves these via pseudo-handles; the VFS layer advertises matching paths
 * under C:\WINDOWS\SYSTEM and C:\WINDOWS\SYSTEM32 so pre-load existence probes
 * (GetFileAttributes, _access, SearchPath) agree with module load semantics.
 */

import { normalizeDllBaseName, resolveThunkedDllAlias } from "./dll-aliases";
import { EMU_NATIVE_VIDEO_DLLS, VIDEO_DLL_NAMES } from "./cpu/emulator-config";
import { EmulatorConfig } from "./emulator-config-manager";

/** Pseudo-handles for thunked system DLLs (LoadLibrary / GetModuleHandle). */
export const THUNKED_DLL_PSEUDO_BASE: Record<string, number> = {
    kernel32: 0x7c800000,
    user32: 0x77d40000,
    gdi32: 0x77f10000,
    advapi32: 0x77dd0000,
    ntdll: 0x7c900000,
    ole32: 0x774e0000,
    ddraw: 0x72770000,
    dsound: 0x72810000,
    dinput: 0x72850000,
    dinput8: 0x72860000,
    winmm: 0x76b40000,
    shell32: 0x7c9c0000,
    comctl32: 0x773d0000,
    version: 0x77c00000,
    wsock32: 0x71ad0000,
    ws2_32: 0x71ab0000,
    mss32: 0x10000000,
    dplayx: 0x10100000,
    smackw32: 0x72900000,
    binkw32: 0x72910000,
    glide2x: 0x72920000,
    quartz: 0x72930000,
    opengl32: 0x72940000,
    glu32: 0x72950000,
    gdiplus: 0x72960000,
    bass: 0x72970000,
    d3d8: 0x72980000,
    d3d9: 0x702e40e4,
    d3dx9: 0x72990000,
    dpnhpast: 0x729a0000,
    dpnhupnp: 0x729b0000,
    w32skrnl: 0x729c0000,
    riched32: 0x729d0000,
    wtsapi32: 0x729e0000,
    lgvid: 0x729f0000,
};

/**
 * The pseudo-handle IS the module identity: LoadLibrary hands it out and
 * GetProcAddress maps it back to a name. Two modules sharing one base makes that
 * map many-to-one, and the loser's every export resolves against the winner —
 * a live handle whose exports are all NULL, with nothing in the log to say why.
 * The table is a build-time constant, so a duplicate is a programming error and
 * is refused at import rather than left to surface as a mute lookup failure.
 */
(function assertDistinctPseudoBases(): void {
    const byBase = new Map<number, string[]>();
    for (const [name, base] of Object.entries(THUNKED_DLL_PSEUDO_BASE)) {
        const names = byBase.get(base);
        if (names) names.push(name); else byBase.set(base, [name]);
    }
    const collisions = [...byBase.entries()].filter(([, names]) => names.length > 1);
    if (collisions.length > 0) {
        throw new Error(
            "THUNKED_DLL_PSEUDO_BASE: duplicate pseudo-handle(s) — " +
            collisions.map(([base, names]) => `0x${base.toString(16)} shared by ${names.join(", ")}`).join("; "));
    }
})();

export const HLE_SYSTEM_DLL_NAMES = new Set(Object.keys(THUNKED_DLL_PSEUDO_BASE));

/** Win9x vs NT system directory segments (case-insensitive match). */
export const SYSTEM_DIRECTORY_SEGMENTS = ["windows\\system", "windows\\system32"] as const;

/** Directories always present on a Windows install even when absent from the ROM. */
export const VIRTUAL_SYSTEM_DIRECTORY_PATHS = new Set([
    "c:\\windows",
    "c:\\windows\\system",
    "c:\\windows\\system32",
]);

/** Placeholder size for virtual HLE DLL stat probes (non-zero like a real PE). */
export const VIRTUAL_HLE_DLL_SIZE = 262_144;

function wildcardToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

function normalizeDllPathToken(value: string): string {
    return value.trim().replace(/^"+|"+$/g, "").replace(/\//g, "\\");
}

function stripDllExtension(value: string): string {
    return value.replace(/\.dll$/i, "");
}

/** Mirrors LoadLibrary disabledDlls blocking for virtual presence. */
export function isBlockedByDisabledDlls(pathOrName: string): boolean {
    const rules = EmulatorConfig.getInstance().disabledDlls;
    if (!rules?.length) return false;

    const full = normalizeDllPathToken(pathOrName).toLowerCase();
    const fullNoDot = full.replace(/^[.\\]+/, "");
    const fullNoDrive = fullNoDot.replace(/^[a-z]:\\/, "");
    const base = full.split("\\").pop() ?? full;
    const baseNoExt = stripDllExtension(base);
    const candidates = Array.from(new Set([full, fullNoDot, fullNoDrive, base, baseNoExt]));

    for (const rawRule of rules) {
        const ruleToken = normalizeDllPathToken(rawRule);
        if (!ruleToken) continue;

        const rule = ruleToken.toLowerCase();
        const ruleNoDot = rule.replace(/^[.\\]+/, "");
        const ruleNoDrive = ruleNoDot.replace(/^[a-z]:\\/, "");
        const ruleBase = rule.split("\\").pop() ?? rule;
        const ruleBaseNoExt = stripDllExtension(ruleBase);
        const hasWildcard = /[*?]/.test(rule) || /[*?]/.test(ruleBase);

        if (hasWildcard) {
            const wildcardPatterns = Array.from(new Set([rule, ruleNoDot, ruleNoDrive, ruleBase, ruleBaseNoExt]));
            for (const pattern of wildcardPatterns) {
                if (!pattern) continue;
                const rx = wildcardToRegExp(pattern);
                if (candidates.some((candidate) => rx.test(candidate))) {
                    return true;
                }
            }
            continue;
        }

        if (
            candidates.includes(rule) ||
            candidates.includes(ruleNoDot) ||
            candidates.includes(ruleNoDrive) ||
            candidates.includes(ruleBase) ||
            candidates.includes(ruleBaseNoExt)
        ) {
            return true;
        }

        if (rule.includes("\\") && (full.endsWith(rule) || fullNoDot.endsWith(ruleNoDot) || fullNoDrive.endsWith(ruleNoDrive))) {
            return true;
        }
    }

    return false;
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
