/**
 * Which library an import descriptor binds to: our HLE module, or the real PE the game ships.
 *
 * Extracted from the import walk so the decision is one pure function with a test — the
 * binding it produces is invisible until the guest CALLS the slot, and a wrong answer there
 * surfaces as an illegal instruction or a silent zero return somewhere else entirely.
 */

import { EMU_NATIVE_VIDEO_DLLS, VIDEO_DLL_NAMES } from './cpu/emulator-config';
import { normalizeDllBaseName, resolveThunkedDllAlias } from './dll-aliases';
import { deriveStackCleanupFromMangledName } from './thunking/msvc-mangling';

/**
 * DLLs whose implementation IS the emulator. The "registry cannot cover these imports, but
 * a real file exists in the VFS — load it natively" fallback must never reach them: a real
 * kernel32/ntdll/user32 expects an NT kernel underneath (syscalls, PEB/TEB internals, a
 * real GDI driver) and there is none, so satisfying the import from a shipped copy trades
 * a handful of missing exports for a certain, unexplainable death. A bundle that happens
 * to ship one of these (installers routinely do) must stay thunked; unknown imports keep
 * their trap stubs, which fail one call loudly instead of the whole process silently.
 */
export const HLE_ONLY_DLLS = new Set<string>([
    'kernel32', 'kernelbase', 'ntdll', 'user32', 'gdi32', 'advapi32',
    'ddraw', 'd3d8', 'd3d9', 'dsound', 'dinput', 'dinput8', 'opengl32', 'glide2x', 'glide3x',
]);

export function isD3dx9VersionedDll(dllNameLower: string): boolean {
    return resolveThunkedDllAlias(normalizeDllBaseName(dllNameLower)) === 'd3dx9';
}

export interface ImportFn { name?: string; ordinal?: number }

/** What the API registry knows about one export of the thunked module. */
export interface ExportFacts {
    callingConvention?: string;
    argCount?: number;
    stackCleanupBytes?: number;
    isDataExport?: boolean;
}

export interface ImportBindingDeps {
    /** Is there an HLE module under this (alias-resolved) name? */
    hasThunkedModule(name: string): boolean;
    /** The real file's stored path, or null. Probed under the name the IMAGE asked for. */
    findDllPath(name: string): string | null;
    /** The matching manifest.appDirDlls rule for the raw import name, or null. */
    appDirRule(dllNameRaw: string): string | null;
    /** Would that path resolve to our own synthetic system directory rather than the game's? */
    isUnderSystemDirectory(path: string): boolean;
    exportFacts(thunkedName: string, f: ImportFn): ExportFacts;
    log(message: string): void;
    warn(message: string): void;
}

export interface ImportBinding {
    /** The name to bind under: the alias target while thunked, else the name the image asked for. */
    dllName: string;
    aliasTarget: string | null;
    isThunked: boolean;
}

/**
 * Can the thunked module answer this import at all?
 *
 * A derivable MSVC-mangled name buys stack discipline, not an implementation. That is enough
 * for a module that IS the DLL — the OUT trap then reports one unimplemented export — but not
 * for an ALIAS standing in for a file the app ships: there the absence of a registry entry is
 * the absence of the library, and binding it anyway hands the guest a trap stub or a zero.
 */
function coversImport(thunkedName: string, f: ImportFn, aliased: boolean, deps: ImportBindingDeps): boolean {
    const facts = deps.exportFacts(thunkedName, f);
    if (f.name === undefined) {
        return f.ordinal === undefined || facts.argCount !== undefined;
    }
    if (facts.callingConvention && facts.callingConvention !== 'stdcall') return true;
    if (facts.isDataExport) return true;
    if (facts.argCount !== undefined || facts.stackCleanupBytes !== undefined) return true;
    return !aliased && deriveStackCleanupFromMangledName(f.name) !== undefined;
}

export function resolveImportBinding(
    dllNameRaw: string,
    functions: readonly ImportFn[],
    deps: ImportBindingDeps,
): ImportBinding {
    const dllNameBeforeAlias = dllNameRaw.toLowerCase().replace(/\.dll$/i, '');
    let dllName = resolveThunkedDllAlias(dllNameBeforeAlias);
    let aliasTarget = dllName !== dllNameBeforeAlias ? dllName : null;
    if (aliasTarget) {
        deps.log(`[PE] DLL alias: ${dllNameRaw} → ${aliasTarget} (using thunked implementation)`);
    }

    // Video DLLs are excluded when native loading is enabled — they fall through to VFS.
    let isThunked = deps.hasThunkedModule(dllName) &&
        !(EMU_NATIVE_VIDEO_DLLS && VIDEO_DLL_NAMES.has(dllName));

    // manifest.appDirDlls: the game ships its own copy of this DLL next to the exe, and
    // Windows' search order binds to THAT — it is a wrapper/proxy (ASI loader, Glide or ddraw
    // shim) whose whole purpose is to run first. Checked before the coverage rule below and
    // outside its exclusions, because the DLLs games wrap are exactly the video ones that rule
    // skips. A rule with no file on disk stays thunked: metadata must not be able to turn an
    // import into an unbound one.
    if (isThunked && deps.appDirRule(dllNameRaw) !== null) {
        const appDirPath = deps.findDllPath(dllName);
        if (appDirPath && !deps.isUnderSystemDirectory(appDirPath)) {
            deps.log(`[PE] "${dllNameRaw}" -> the game's own ${appDirPath} (manifest.appDirDlls), not the HLE module`);
            isThunked = false;
        }
    }

    // A thunked module must cover every requested import — stdcall stubs need argCount or
    // stackCleanupBytes, and generateStubDll throws otherwise. A registry module name can
    // collide with an unrelated real DLL a game ships (same filename, different library).
    //
    // An ALIAS is our substitute for a DLL the app does not ship (msvcp71 -> msvcp90, an
    // api-set -> msvcrt), so it must not outrank the file the app DOES ship: Windows binds
    // `MSVCP71.dll` to the copy next to the exe, and our substitute answering for it with trap
    // stubs turns "we do not implement this export" into an illegal instruction inside a static
    // constructor. Probe under the name the image asked for, and drop the alias when that file
    // takes over. DLLs the native loader refuses (HLE-only, video, d3dx9) stay thunked.
    if (isThunked &&
        !HLE_ONLY_DLLS.has(dllName) &&
        !(!EMU_NATIVE_VIDEO_DLLS && VIDEO_DLL_NAMES.has(dllName)) &&
        !isD3dx9VersionedDll(dllName)) {
        const uncovered = functions.filter(f => !coversImport(dllName, f, aliasTarget !== null, deps));
        if (uncovered.length > 0 && deps.findDllPath(dllNameBeforeAlias) !== null) {
            const names = uncovered.slice(0, 5).map(f => f.name ?? `ord_${f.ordinal}`).join(', ');
            deps.warn(
                `[PE] Thunked module "${dllName}" cannot cover ${uncovered.length}/${functions.length} ` +
                `imports of ${dllNameRaw} (${names}${uncovered.length > 5 ? ', …' : ''}); ` +
                `real DLL exists in VFS — loading natively instead of thunking`);
            isThunked = false;
            dllName = dllNameBeforeAlias;
            aliasTarget = null;
        }
    }

    return { dllName, aliasTarget, isThunked };
}
