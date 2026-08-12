// Module management functions for kernel32
// GetModuleHandle*, LoadLibrary*, GetProcAddress, FreeLibrary, GetModuleFileName*

import { ThunkImplementation } from '../../../core/thunking/thunk-dispatcher';
import { System } from '../../../core/system';
import { Marshaler } from '../../../core/memory/marshaler';
import { Logger, LogCategory, LogLevel } from '../../../core/logger';
import { APIRegistry } from '../../../core/api-registry';
import { EMU_NATIVE_VIDEO_DLLS } from '../../../core/cpu/emulator-config';
import { EmulatorConfig, VER_PLATFORM_WIN32_WINDOWS } from '../../../core/emulator-config-manager';
import { encodeAnsi } from '../../codepage-utils';
import { resolveThunkedDllAlias } from '../../../core/dll-aliases';
import { FORCE_NATIVE_PACKAGE_LOAD, isUnderSystemDirectory } from '../../../core/hle-system-catalog';
import { findDllRule } from '../../../core/dll-rules';
import { hleImageBase, hleModuleNameByBase, isHleModuleLoaded, markHleModuleLoaded } from '../../../core/hle-module-images';
import { getProcAddressRegistry, type GetProcResolution } from '../../../core/diagnostics/get-proc-address-registry';
import { SILENT_STUBS } from '../../../core/diagnostics/api-census';
import { resolveHleExportAddress } from '../../../core/thunking/export-resolver';

export const exports: Record<string, ThunkImplementation> = {};

const DEFAULT_EXE_BASE = 0x00400000;

function getMainExeHandle(): number {
    return System.getInstance().process?.moduleRegistry?.getMainExecutableBase() ?? DEFAULT_EXE_BASE;
}

// The HLE module images (their bases ARE the HMODULEs) live in hle-module-images.ts;
// FORCE_NATIVE_PACKAGE_LOAD and the VFS presence rules in hle-system-catalog.ts.

const loadLibraryHandleCache = new Map<string, number>();
const handleToPathCache = new Map<number, string>();
const getProcAddressCache = new Map<string, number>();
const getProcAddressPointerCache = new Map<string, number>();
const loggedUnknownModuleHandles = new Set<number>();
// FreeLibrary refcounting. Modules that appear in the registry WITHOUT a dynamic
// LoadLibrary ref (the EXE + its static import closure, and static-import
// dependencies auto-loaded while mapping a dynamic DLL) are PINNED — a static
// import holds a permanent reference on real Windows, so FreeLibrary never unloads
// them. Only explicitly LoadLibrary'd modules unload at refcount 0.
const pinnedModuleBases = new Set<number>();
const dynamicLoadRefs = new Map<number, number>();
let cacheOwnerProcess: any = null;
let cacheOwnerResetGeneration = -1;

function ensureProcessLocalCaches(): void {
    const currentProcess = System.getInstance().process;
    // These caches store thunk-stub addresses. A new Process object is an obvious
    // invalidation trigger, but Process.reset() reuses the SAME object while
    // regenerating all thunk memory — so we must also drop the caches whenever the
    // process' resetGeneration advances, or stale pre-reset stub addresses survive
    // (e.g. a warmed dynamic export like Direct3DShaderValidatorCreate9 → NULL+1 deref).
    const gen = currentProcess?.resetGeneration ?? 0;
    if (currentProcess === cacheOwnerProcess && gen === cacheOwnerResetGeneration) return;
    cacheOwnerProcess = currentProcess;
    cacheOwnerResetGeneration = gen;
    loadLibraryHandleCache.clear();
    handleToPathCache.clear();
    getProcAddressCache.clear();
    getProcAddressPointerCache.clear();
    loggedUnknownModuleHandles.clear();
    getProcAddressRegistry.clear();
    pinnedModuleBases.clear();
    dynamicLoadRefs.clear();
}

/** Pin every registered module that holds no dynamic LoadLibrary ref (see
 *  pinnedModuleBases). Must run BEFORE the current call registers anything new —
 *  i.e. at the top of each LoadLibrary/FreeLibrary handler — so a module being
 *  dynamically loaded right now is never mistaken for a static one. */
function pinUntrackedModules(): void {
    const registry = System.getInstance().process?.moduleRegistry;
    for (const m of registry?.getAllModules?.() ?? []) {
        const base = m.baseAddress >>> 0;
        if (!dynamicLoadRefs.has(base)) pinnedModuleBases.add(base);
    }
}

/**
 * Some legacy binaries query CRT/SmartHeap symbols from the main EXE handle (0x400000)
 * even though the implementation actually lives in thunked DLLs.
 */
const EXE_GETPROC_FORWARD_MAP: Record<string, Array<{ dll: string; name: string }>> = {
    "_environ": [{ dll: "msvcrt", name: "_environ" }],
    "__environ": [{ dll: "msvcrt", name: "__environ" }],
    "_environ_dll": [{ dll: "msvcrt", name: "_environ_dll" }],
    "_malloc_dbg": [{ dll: "msvcrt", name: "_malloc_dbg" }, { dll: "msvcrt", name: "malloc" }],
    "_calloc_dbg": [{ dll: "msvcrt", name: "_calloc_dbg" }, { dll: "msvcrt", name: "calloc" }],
    "_realloc_dbg": [{ dll: "msvcrt", name: "_realloc_dbg" }, { dll: "msvcrt", name: "realloc" }],
    "_free_dbg": [{ dll: "msvcrt", name: "_free_dbg" }, { dll: "msvcrt", name: "free" }],
    "_strdup_dbg": [{ dll: "msvcrt", name: "_strdup_dbg" }, { dll: "msvcrt", name: "_strdup" }],
    "_crtdbgreport": [{ dll: "msvcrt", name: "_CrtDbgReport" }],
    "_crtdbgreportw": [{ dll: "msvcrt", name: "_CrtDbgReportW" }],
    "_crtsetdbgflag": [{ dll: "msvcrt", name: "_CrtSetDbgFlag" }],
    "_crtcheckmemory": [{ dll: "msvcrt", name: "_CrtCheckMemory" }],
    "_crtisvalidheappointer": [{ dll: "msvcrt", name: "_CrtIsValidHeapPointer" }],
    "_crtdumpmemoryleaks": [{ dll: "msvcrt", name: "_CrtDumpMemoryLeaks" }],
    "_assert": [{ dll: "msvcrt", name: "_assert" }],
    "_wassert": [{ dll: "msvcrt", name: "_wassert" }],
    "calloc": [{ dll: "msvcrt", name: "calloc" }],
    "_calloc": [{ dll: "msvcrt", name: "_calloc" }, { dll: "msvcrt", name: "calloc" }],
    "realloc": [{ dll: "msvcrt", name: "realloc" }],
    "_realloc": [{ dll: "msvcrt", name: "_realloc" }, { dll: "msvcrt", name: "realloc" }],
    "free": [{ dll: "msvcrt", name: "free" }],
    "_free": [{ dll: "msvcrt", name: "_free" }, { dll: "msvcrt", name: "free" }],
    "_msize": [{ dll: "msvcrt", name: "_msize" }],
    "_msize_dbg": [{ dll: "msvcrt", name: "_msize_dbg" }, { dll: "msvcrt", name: "_msize" }],
    "__msize": [{ dll: "msvcrt", name: "__msize" }, { dll: "msvcrt", name: "_msize" }],
    "_expand": [{ dll: "msvcrt", name: "_expand" }],
    "__expand": [{ dll: "msvcrt", name: "__expand" }, { dll: "msvcrt", name: "_expand" }],
    "_heapmin": [{ dll: "msvcrt", name: "_heapmin" }],
    "__heapmin": [{ dll: "msvcrt", name: "__heapmin" }, { dll: "msvcrt", name: "_heapmin" }],
    "_heapadd": [{ dll: "msvcrt", name: "_heapadd" }],
    "__heapadd": [{ dll: "msvcrt", name: "__heapadd" }, { dll: "msvcrt", name: "_heapadd" }],
    "_heapchk": [{ dll: "msvcrt", name: "_heapchk" }],
    "__heapchk": [{ dll: "msvcrt", name: "__heapchk" }, { dll: "msvcrt", name: "_heapchk" }],
    "_heapset": [{ dll: "msvcrt", name: "_heapset" }],
    "__heapset": [{ dll: "msvcrt", name: "__heapset" }, { dll: "msvcrt", name: "_heapset" }],
    "_heapwalk": [{ dll: "msvcrt", name: "_heapwalk" }],
    "__heapwalk": [{ dll: "msvcrt", name: "__heapwalk" }, { dll: "msvcrt", name: "_heapwalk" }],
    "__rtl_heapwalk": [{ dll: "msvcrt", name: "__rtl_heapwalk" }, { dll: "msvcrt", name: "_heapwalk" }],
    "_heapused": [{ dll: "msvcrt", name: "_heapused" }],
    "__heapused": [{ dll: "msvcrt", name: "__heapused" }, { dll: "msvcrt", name: "_heapused" }],
    "malloc": [{ dll: "msvcrt", name: "malloc" }],
    "_malloc": [{ dll: "msvcrt", name: "_malloc" }, { dll: "msvcrt", name: "malloc" }],
    "??2@yapaxi@z": [{ dll: "msvcrt", name: "??2@YAPAXI@Z" }, { dll: "msvcrt", name: "malloc" }],
    "??3@yaxpax@z": [{ dll: "msvcrt", name: "??3@YAXPAX@Z" }, { dll: "msvcrt", name: "free" }],
    "??2cobject@@sapaxi@z": [{ dll: "msvcrt", name: "??2CObject@@SAPAXI@Z" }],
    "??3cobject@@saxpax@z": [{ dll: "msvcrt", name: "??3CObject@@SAXPAX@Z" }],
    "??2cobject@@sgpaxi@z": [{ dll: "msvcrt", name: "??2CObject@@SGPAXI@Z" }],
    "??3cobject@@sgxpax@z": [{ dll: "msvcrt", name: "??3CObject@@SGXPAX@Z" }],
    "@$bnew$qui": [{ dll: "msvcrt", name: "@$bnew$qui" }, { dll: "msvcrt", name: "malloc" }],
    "@$bnwa$qui": [{ dll: "msvcrt", name: "@$bnwa$qui" }, { dll: "msvcrt", name: "@$bnew$qui" }, { dll: "msvcrt", name: "malloc" }],
    "@$bdele$qpv": [{ dll: "msvcrt", name: "@$bdele$qpv" }, { dll: "msvcrt", name: "free" }],
    "@$bdla$qpv": [{ dll: "msvcrt", name: "@$bdla$qpv" }, { dll: "msvcrt", name: "@$bdele$qpv" }, { dll: "msvcrt", name: "free" }],
    "?_query_new_handler@@yap6ahi@zxz": [{ dll: "msvcrt", name: "?_query_new_handler@@YAP6AHI@ZXZ" }],
    "?_query_new_mode@@yahxz": [{ dll: "msvcrt", name: "?_query_new_mode@@YAHXZ" }],
    "?set_new_handler@@yap6axxzp6axxz@z": [{ dll: "msvcrt", name: "?set_new_handler@@YAP6AXXZP6AXXZ@Z" }],
    "@set_new_handler$qpqv$v": [{ dll: "msvcrt", name: "@set_new_handler$qpqv$v" }],
    "mempoolinit": [{ dll: "mss32", name: "MemPoolInit" }],
    "_memsetpatching@4": [{ dll: "mss32", name: "_MemSetPatching@4" }],
};

/**
 * Exports that live ONLY in the debug CRT (msvcrtd.dll / msvcr##d.dll). One msvcrt HLE
 * implementation serves every CRT flavour, so without this a GetProcAddress probe finds
 * them on a RELEASE CRT module and the caller concludes the process links a debug runtime
 * — SmartHeap (shw32.dll) walks the loaded modules doing exactly that probe and refuses to
 * start. IAT binding is untouched: a binary that really links the debug CRT imports these
 * by name and still gets the handler. _assert/_wassert are deliberately absent — the
 * release CRT exports both.
 */
const DEBUG_CRT_ONLY_EXPORTS = new Set([
    "_malloc_dbg", "_calloc_dbg", "_realloc_dbg", "_free_dbg", "_expand_dbg",
    "_strdup_dbg", "_wcsdup_dbg", "_msize_dbg", "_recalloc_dbg", "_aligned_malloc_dbg",
    "_crtdbgreport", "_crtdbgreportw", "_crtsetdbgflag", "_crtcheckmemory",
    "_crtisvalidheappointer", "_crtisvalidpointer", "_crtismemoryblock",
    "_crtdumpmemoryleaks", "_crtsetreportmode", "_crtsetreportfile", "_crtsetreporthook",
    "_crtsetreporthook2", "_crtsetallochook", "_crtsetdumpclient",
    "_crtmemcheckpoint", "_crtmemdifference", "_crtmemdumpstatistics",
    "_crtmemdumpallobjectssince", "_crtdopostterminate", "_crtdbgbreak",
]);

/** Release CRT flavours — the ones that must NOT answer a DEBUG_CRT_ONLY_EXPORTS probe. */
const RELEASE_CRT_MODULE_RE = /^(crtdll|msvcrt|msvcr\d+|msvcp\d+)$/;

/**
 * The same probe aimed at the EXE's own base. An exe never exports these, so the two
 * the release CRT does export (_assert/_wassert) belong here as well.
 */
const EXE_DEBUG_CRT_PROBE_NAMES = new Set([...DEBUG_CRT_ONLY_EXPORTS, "_assert", "_wassert"]);

/**
 * Get pseudo-base address for a thunked DLL
 */
function getThunkedModuleName(value: string): string {
    return resolveThunkedDllAlias(getDllBaseName(value));
}

function getThunkedDllBase(dllName: string): number | undefined {
    const thunkedName = getThunkedModuleName(dllName);
    const base = hleImageBase(thunkedName);
    // Asking for a module by name IS loading it, as far as the loader list is concerned.
    if (base !== undefined) markHleModuleLoaded(thunkedName);
    return base;
}

function getDllBaseName(value: string): string {
    const normalized = normalizeDllPathToken(value).toLowerCase();
    if (!normalized) return "";
    return stripDllExtension(normalized.split("\\").pop() ?? normalized);
}

/** Map WinSxS absolute paths to a plain DLL leaf for HLE resolution. */
function canonicalizeLibraryRequest(pathOrName: string): string {
    const normalized = normalizeDllPathToken(pathOrName);
    if (/\\winsxs\\/i.test(normalized)) {
        return normalized.split("\\").pop() ?? normalized;
    }
    return pathOrName;
}

function formatSystemDllPath(dllName: string): string {
    const normalized = stripDllExtension(getDllBaseName(normalizeDllPathToken(dllName)));
    if (!normalized) return "";
    return `C:\\WINDOWS\\SYSTEM32\\${normalized.toUpperCase()}.DLL`;
}

function formatModulePath(pathOrName: string, moduleName?: string): string {
    const token = normalizeDllPathToken(pathOrName);
    if (/^[a-z]:\\/i.test(token)) return token;
    if (token.includes("\\")) return `C:\\${token.replace(/^\\+/, "")}`;
    if (moduleName) return formatSystemDllPath(moduleName);
    return formatSystemDllPath(token);
}

function rememberModuleHandlePath(handle: number, pathOrName: string, moduleName?: string): void {
    const h = handle >>> 0;
    if (!h) return;
    const path = formatModulePath(pathOrName, moduleName);
    if (path) handleToPathCache.set(h, path);
}

function rememberLoadLibraryHandle(name: string, handle: number): void {
    const normalized = normalizeDllPathToken(name).toLowerCase();
    if (!normalized) return;
    const fullNoExt = stripDllExtension(normalized);
    const baseNoExt = stripDllExtension(normalized.split("\\").pop() ?? normalized);
    const value = handle >>> 0;
    if (fullNoExt) loadLibraryHandleCache.set(fullNoExt, value);
    if (baseNoExt) loadLibraryHandleCache.set(baseNoExt, value);
    rememberModuleHandlePath(value, name);
    dynamicLoadRefs.set(value, (dynamicLoadRefs.get(value) ?? 0) + 1);
}

function syncHandlePathCacheFromRegistry(): void {
    const registry = System.getInstance().process?.moduleRegistry;
    if (!registry) return;
    for (const mod of registry.getAllModules()) {
        const path = formatModulePath(mod.path, mod.name);
        handleToPathCache.set(mod.baseAddress >>> 0, path);
    }
}

function resolveModuleFilename(hModule: number): { path: string; found: boolean } {
    const h = hModule >>> 0;
    if (h === 0 || h === DEFAULT_EXE_BASE) {
        const system = System.getInstance();
        return {
            path: system.executablePath || `C:\\${system.executableName}`,
            found: true,
        };
    }

    syncHandlePathCacheFromRegistry();

    const cached = handleToPathCache.get(h);
    if (cached) return { path: cached, found: true };

    const registry = System.getInstance().process?.moduleRegistry;
    if (registry) {
        const mod = registry.getByBase(h) ?? registry.getModuleContainingAddress(h);
        if (mod) {
            const path = formatModulePath(mod.path, mod.name);
            handleToPathCache.set(h, path);
            handleToPathCache.set(mod.baseAddress >>> 0, path);
            return { path, found: true };
        }
    }

    // Only for a module the process actually loaded. The image arena is materialized for
    // every HLE'd DLL, so naming any base that lands in it turns a memory walk into a
    // loader-list enumeration and reports modules the app never linked.
    const hleName = hleModuleNameByBase(h);
    if (hleName && isHleModuleLoaded(hleName)) {
        const path = formatSystemDllPath(hleName);
        handleToPathCache.set(h, path);
        return { path, found: true };
    }

    for (const [name, handle] of loadLibraryHandleCache) {
        if (handle === h) {
            const path = formatModulePath(name);
            handleToPathCache.set(h, path);
            return { path, found: true };
        }
    }

    const mem = System.getInstance().process?.v86?.mem8 as Uint8Array | undefined;
    if (mem && h >= 0x10000 && h < 0x24000000) {
        const registry = System.getInstance().process?.moduleRegistry;
        if (registry) {
            for (let probe = h & ~0xFFF; probe + 0x1000 > h - 0x20000 && probe >= 0x10000; probe -= 0x1000) {
                if (mem[probe] !== 0x4D || mem[probe + 1] !== 0x5A) continue;
                const mod = registry.getByBase(probe) ?? registry.getModuleContainingAddress(probe);
                if (!mod) continue;
                const path = formatModulePath(mod.path, mod.name);
                handleToPathCache.set(h, path);
                handleToPathCache.set(mod.baseAddress >>> 0, path);
                return { path, found: true };
            }
        }
    }

    return { path: "", found: false };
}

function getCachedLoadLibraryHandle(name: string): number | undefined {
    const normalized = normalizeDllPathToken(name).toLowerCase();
    if (!normalized) return undefined;
    const fullNoExt = stripDllExtension(normalized);
    const baseNoExt = stripDllExtension(normalized.split("\\").pop() ?? normalized);
    const handle = loadLibraryHandleCache.get(fullNoExt) ?? loadLibraryHandleCache.get(baseNoExt);
    if (handle !== undefined) {
        // Repeat LoadLibrary on a live module takes another reference.
        dynamicLoadRefs.set(handle, (dynamicLoadRefs.get(handle) ?? 0) + 1);
    }
    return handle;
}

function buildGetProcCacheKey(hModule: number, procName: string, isOrdinal: boolean, ordinal: number): string {
    if (isOrdinal) return `${hModule >>> 0}#${ordinal >>> 0}`;
    return `${hModule >>> 0}:${procName.toLowerCase()}`;
}

function buildGetProcPointerCacheKey(hModule: number, lpProcName: number): string {
    return `${hModule >>> 0}@${lpProcName >>> 0}`;
}

const resolveThunkedExportAddress = resolveHleExportAddress;

/** Boot-time warmup for exports resolved only via GetProcAddress (not PE imports). */
export function ensureGetProcAddressDynamicExports(
    dispatcher: any,
    exports: Array<{ dll: string; name: string }>,
): void {
    ensureProcessLocalCaches();
    for (const entry of exports) {
        const dllLower = entry.dll.toLowerCase();
        const base = hleImageBase(dllLower);
        if (base === undefined) continue;
        const cacheKey = buildGetProcCacheKey(base, entry.name, false, 0);
        if (getProcAddressCache.has(cacheKey)) continue;

        const address = resolveThunkedExportAddress(dispatcher, entry.dll, entry.name, false);
        if (address !== 0) {
            getProcAddressCache.set(cacheKey, address >>> 0);
            Logger.log(
                LogCategory.KERNEL32,
                `GetProcAddress warmup: ${entry.dll}:${entry.name} -> 0x${address.toString(16)}`
            );
        }
    }
}

function normalizeDllPathToken(value: string): string {
    return value.trim().replace(/^"+|"+$/g, "").replace(/\//g, "\\");
}

function stripDllExtension(value: string): string {
    return value.replace(/\.dll$/i, "");
}

function findDisabledDllRule(dllName: string): string | null {
    return findDllRule(EmulatorConfig.getInstance().disabledDlls, dllName);
}

/**
 * Does the game directory's copy of this DLL outrank our HLE module (manifest.appDirDlls)?
 *
 * An EXPLICIT system-directory path never does: that is how a proxy reaches the library it
 * wraps ("C:\WINDOWS\SYSTEM32\ddraw.dll" from an ASI loader's own DllMain). Without this
 * carve-out the proxy resolves to itself and recurses.
 */
function prefersAppDirDll(requestedName: string): boolean {
    if (!requestedName) return false;
    if (isUnderSystemDirectory(normalizeDllPathToken(requestedName))) return false;
    return findDllRule(EmulatorConfig.getInstance().appDirDlls, requestedName) !== null;
}

/**
 * The mirror of prefersAppDirDll: an EXPLICIT system-directory request for a name that has
 * an app-dir rule. Such a request must bypass both the handle cache and the loaded-module
 * registry (which key on the bare name and would hand the proxy back its own base) and land
 * on the HLE module.
 */
function requestsSystemCopyOfAppDirDll(requestedName: string): boolean {
    if (!requestedName) return false;
    if (!isUnderSystemDirectory(normalizeDllPathToken(requestedName))) return false;
    return findDllRule(EmulatorConfig.getInstance().appDirDlls, requestedName) !== null;
}

/**
 * Does a real game-directory PE actually exist to take the HLE module's place? A rule alone
 * is not enough — without the file we would skip the HLE and then fail the load outright,
 * turning a metadata typo into a missing import. The VFS also advertises virtual HLE system
 * files, so a hit under the system directory is our own presence, not the game's copy.
 */
function appDirDllShadowsHle(dllName: string): boolean {
    if (!prefersAppDirDll(dllName)) return false;
    const path = System.getInstance().process?.loader?.findDllPath(dllName);
    return !!path && !isUnderSystemDirectory(normalizeDllPathToken(path));
}

function formatLoadLibraryCaller(ctx: { eip?: number } | null | undefined): string {
    const eip = ctx?.eip ?? 0;
    if (!eip) return "";
    const registry = System.getInstance().process?.moduleRegistry;
    if (!registry) return ` [caller: 0x${eip.toString(16)}]`;
    const mod = registry.getModuleContainingAddress(eip);
    if (!mod) return ` [caller: 0x${eip.toString(16)}]`;
    const offset = (eip - mod.baseAddress) >>> 0;
    return ` [caller: ${mod.name}+0x${offset.toString(16)} @0x${eip.toString(16)}]`;
}

function tryBlockThunkedDllLoad(
    requestedDllName: string,
    thunkedModuleName: string,
    stackCleanup: number,
    apiName: string,
    callerInfo = ""
): { value: number; stackCleanup: number } | null {
    const matchedRule =
        findDisabledDllRule(requestedDllName) ??
        findDisabledDllRule(thunkedModuleName) ??
        findDisabledDllRule(`${thunkedModuleName}.dll`);
    if (!matchedRule) return null;

    const system = System.getInstance();
    if (system.process) {
        system.process.lastError = 126; // ERROR_MOD_NOT_FOUND
    }
    Logger.log(
        LogCategory.KERNEL32,
        `${apiName}("${requestedDllName}") -> BLOCKED THUNKED MODULE "${thunkedModuleName}" by manifest.disabledDlls rule "${matchedRule}"${callerInfo}`
    );
    return { value: 0, stackCleanup };
}

function initModuleFunctions(): void {
    exports['GetModuleHandleA'] = (ctx, mem, args) => {
        const lpModuleNameAddr = args[0];
        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;

        if (lpModuleNameAddr === 0) {
            // NULL means get handle to main executable
            return { value: getMainExeHandle(), stackCleanup: 4 };
        }

        const name = Marshaler.readString(mem, lpModuleNameAddr);
        const nameLower = name.toLowerCase().replace(/\.dll$/, '');

        // Try module registry first (real loaded DLLs)
        if (moduleRegistry) {
            const mod = moduleRegistry.getByName(name);
            if (mod) {
                Logger.log(LogCategory.KERNEL32, `GetModuleHandleA("${name}") -> 0x${mod.baseAddress.toString(16)}`);
                return { value: mod.baseAddress, stackCleanup: 4 };
            }
        }

        // Check if it's asking for main exe by name
        const exeName = system.executableName.toLowerCase();
        if (nameLower === exeName || nameLower === exeName.replace(/\.exe$/, '')) {
            const exeBase = getMainExeHandle();
            Logger.log(LogCategory.KERNEL32, `GetModuleHandleA("${name}") -> 0x${exeBase.toString(16)} (main exe)`);
            return { value: exeBase, stackCleanup: 4 };
        }

        const thunkedName = getThunkedModuleName(name);

        // Check if it's a thunked (HLE) system DLL - return pseudo-handle
        const pseudoBase = getThunkedDllBase(nameLower);
        if (pseudoBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(name, thunkedName, 4, "GetModuleHandleA");
            if (blocked) {
                return blocked;
            }
            Logger.log(LogCategory.KERNEL32, `GetModuleHandleA("${name}") -> 0x${pseudoBase.toString(16)} (thunked DLL)`);
            return { value: pseudoBase, stackCleanup: 4 };
        }


        Logger.log(LogCategory.KERNEL32, `GetModuleHandleA("${name}") -> 0 (not found)`);
        system.process!.lastError = 126; // ERROR_MOD_NOT_FOUND
        return { value: 0, stackCleanup: 4 };
    };

    exports['GetModuleHandleW'] = (ctx, mem, args) => {
        const lpModuleNameAddr = args[0];
        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;

        if (lpModuleNameAddr === 0) {
            return { value: getMainExeHandle(), stackCleanup: 4 };
        }

        const name = Marshaler.readStringW(mem, lpModuleNameAddr);
        const nameLower = name.toLowerCase().replace(/\.dll$/, '');

        // Try module registry first (real loaded DLLs)
        if (moduleRegistry) {
            const mod = moduleRegistry.getByName(name);
            if (mod) {
                Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleW("${name}") -> 0x${mod.baseAddress.toString(16)}`);
                return { value: mod.baseAddress, stackCleanup: 4 };
            }
        }

        // Check if it's asking for main exe by name
        const exeName = system.executableName.toLowerCase();
        if (nameLower === exeName || nameLower === exeName.replace(/\.exe$/, '')) {
            const exeBase = getMainExeHandle();
            Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleW("${name}") -> 0x${exeBase.toString(16)} (main exe)`);
            return { value: exeBase, stackCleanup: 4 };
        }

        const thunkedName = getThunkedModuleName(name);

        // Check if it's a thunked (HLE) system DLL - return pseudo-handle
        const pseudoBase = getThunkedDllBase(nameLower);
        if (pseudoBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(name, thunkedName, 4, "GetModuleHandleW");
            if (blocked) {
                return blocked;
            }
            Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleW("${name}") -> 0x${pseudoBase.toString(16)} (thunked DLL)`);
            return { value: pseudoBase, stackCleanup: 4 };
        }


        Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleW("${name}") -> 0 (not found)`);
        system.process!.lastError = 126; // ERROR_MOD_NOT_FOUND
        return { value: 0, stackCleanup: 4 };
    };

    const GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS = 0x04;
    const GET_MODULE_HANDLE_EX_FLAG_PIN = 0x01;
    const GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT = 0x02;

    exports['GetModuleHandleExW'] = (ctx, mem, args) => {
        const dwFlags = args[0];
        const lpModuleName = args[1];
        const phModule = args[2];

        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        let moduleHandle = 0;

        if (dwFlags & GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS) {
            // Treat lpModuleName as an address and find module containing it
            if (moduleRegistry) {
                const mod = moduleRegistry.getModuleContainingAddress(lpModuleName);
                if (mod) {
                    moduleHandle = mod.baseAddress;
                    Logger.verbose(LogCategory.KERNEL32,
                        `GetModuleHandleExW(FROM_ADDRESS, 0x${lpModuleName.toString(16)}) -> 0x${moduleHandle.toString(16)}`);
                } else {
                    const exeMod = moduleRegistry.getExecutableModule();
                    if (exeMod) {
                        const base = exeMod.baseAddress;
                        if (lpModuleName >= base && lpModuleName < base + exeMod.size) {
                            moduleHandle = base;
                        }
                    }
                }
            }
            if (moduleHandle === 0) {
                moduleHandle = getMainExeHandle();
            }
        } else if (lpModuleName !== 0) {
            const name = Marshaler.readStringW(mem, lpModuleName);
            const nameLower = name.toLowerCase().replace(/\.dll$/, '');

            // Try module registry first
            if (moduleRegistry) {
                const mod = moduleRegistry.getByName(name);
                if (mod) {
                    moduleHandle = mod.baseAddress;
                }
            }

            // Check thunked DLLs
            if (moduleHandle === 0) {
                const thunkedName = getThunkedModuleName(name);
                const pseudoBase = getThunkedDllBase(nameLower);
                if (pseudoBase !== undefined) {
                    const blocked = tryBlockThunkedDllLoad(name, thunkedName, 12, "GetModuleHandleExW");
                    if (blocked) {
                        if (phModule !== 0 && phModule + 4 <= mem.length) {
                            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                            view.setUint32(phModule, 0, true);
                        }
                        return blocked;
                    }
                    moduleHandle = pseudoBase;
                    Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleExW("${name}") -> 0x${moduleHandle.toString(16)} (thunked DLL)`);
                }
            }

            if (moduleHandle === 0) {
                Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleExW("${name}") -> 0 (not found)`);
                system.process!.lastError = 126; // ERROR_MOD_NOT_FOUND
                if (phModule !== 0 && phModule + 4 <= mem.length) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(phModule, 0, true);
                }
                return { value: 0, stackCleanup: 12 };
            }
        } else {
            // NULL module name = main exe
            moduleHandle = getMainExeHandle();
        }

        if (phModule !== 0 && phModule + 4 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(phModule, moduleHandle, true);
        }

        return { value: 1, stackCleanup: 12 };
    };

    exports['GetModuleHandleExA'] = (ctx, mem, args) => {
        const dwFlags = args[0];
        const lpModuleName = args[1];
        const phModule = args[2];

        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        let moduleHandle = 0;

        if (dwFlags & GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS) {
            if (moduleRegistry) {
                const mod = moduleRegistry.getModuleContainingAddress(lpModuleName);
                if (mod) {
                    moduleHandle = mod.baseAddress;
                } else {
                    const exeMod = moduleRegistry.getExecutableModule();
                    if (exeMod) {
                        const base = exeMod.baseAddress;
                        if (lpModuleName >= base && lpModuleName < base + exeMod.size) {
                            moduleHandle = base;
                        }
                    }
                }
            }
            if (moduleHandle === 0) {
                moduleHandle = getMainExeHandle();
            }
        } else if (lpModuleName !== 0) {
            const name = Marshaler.readString(mem, lpModuleName);
            const nameLower = name.toLowerCase().replace(/\.dll$/, '');

            // Try module registry first
            if (moduleRegistry) {
                const mod = moduleRegistry.getByName(name);
                if (mod) {
                    moduleHandle = mod.baseAddress;
                }
            }

            // Check thunked DLLs
            if (moduleHandle === 0) {
                const thunkedName = getThunkedModuleName(name);
                const pseudoBase = getThunkedDllBase(nameLower);
                if (pseudoBase !== undefined) {
                    const blocked = tryBlockThunkedDllLoad(name, thunkedName, 12, "GetModuleHandleExA");
                    if (blocked) {
                        if (phModule !== 0 && phModule + 4 <= mem.length) {
                            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                            view.setUint32(phModule, 0, true);
                        }
                        return blocked;
                    }
                    moduleHandle = pseudoBase;
                    Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleExA("${name}") -> 0x${moduleHandle.toString(16)} (thunked DLL)`);
                }
            }

            if (moduleHandle === 0) {
                Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleExA("${name}") -> 0 (not found)`);
                system.process!.lastError = 126;
                if (phModule !== 0 && phModule + 4 <= mem.length) {
                    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                    view.setUint32(phModule, 0, true);
                }
                return { value: 0, stackCleanup: 12 };
            }
        } else {
            moduleHandle = getMainExeHandle();
        }

        if (phModule !== 0 && phModule + 4 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(phModule, moduleHandle, true);
        }

        return { value: 1, stackCleanup: 12 };
    };

    exports['GetModuleFileNameA'] = (ctx, mem, args) => {
        const hModule = args[0];
        const lpFilename = args[1];
        const nSize = args[2];

        ensureProcessLocalCaches();
        const { path: filename, found } = resolveModuleFilename(hModule);
        if (!found) {
            const h = hModule >>> 0;
            if (!loggedUnknownModuleHandles.has(h)) {
                loggedUnknownModuleHandles.add(h);
                Logger.warn(LogCategory.KERNEL32, `GetModuleFileNameA(0x${h.toString(16)}) -> unresolved module handle`);
            }
            System.getInstance().scheduler.setLastError(6); // ERROR_INVALID_HANDLE
            return { value: 0, stackCleanup: 12 };
        }

        const bytes = encodeAnsi(filename + "\0");
        const toWrite = Math.min(bytes.length, nSize);
        mem.set(bytes.slice(0, toWrite), lpFilename);

        Logger.verbose(LogCategory.KERNEL32, `GetModuleFileNameA(0x${hModule.toString(16)}) -> "${filename}"`);
        return { value: toWrite - 1, stackCleanup: 12 };
    };

    exports['GetModuleFileNameW'] = (ctx, mem, args) => {
        const hModule = args[0];
        const lpFilename = args[1];
        const nSize = args[2];

        ensureProcessLocalCaches();
        const { path: filename, found } = resolveModuleFilename(hModule);
        if (!found) {
            const h = hModule >>> 0;
            if (!loggedUnknownModuleHandles.has(h)) {
                loggedUnknownModuleHandles.add(h);
                Logger.warn(LogCategory.KERNEL32, `GetModuleFileNameW(0x${h.toString(16)}) -> unresolved module handle`);
            }
            System.getInstance().scheduler.setLastError(6); // ERROR_INVALID_HANDLE
            return { value: 0, stackCleanup: 12 };
        }

        const encodeUTF16LE = (str: string): Uint8Array => {
            const result = new Uint8Array(str.length * 2 + 2);
            const view = new DataView(result.buffer);
            for (let i = 0; i < str.length; i++) {
                view.setUint16(i * 2, str.charCodeAt(i), true);
            }
            view.setUint16(str.length * 2, 0, true);
            return result;
        };

        const bytes = encodeUTF16LE(filename);
        const toWrite = Math.min(bytes.length, nSize * 2);
        mem.set(bytes.slice(0, toWrite), lpFilename);

        Logger.verbose(LogCategory.KERNEL32, `GetModuleFileNameW(0x${hModule.toString(16)}) -> "${filename}"`);
        return { value: (toWrite / 2) - 1, stackCleanup: 12 };
    };

    exports['LoadLibraryExW'] = async (ctx, mem, args) => {
        const lpLibFileName = args[0];
        const hFile = args[1]; // Reserved, must be NULL
        const dwFlags = args[2];
        const dllName = canonicalizeLibraryRequest(
            lpLibFileName ? Marshaler.readStringW(mem, lpLibFileName) : ""
        );

        ensureProcessLocalCaches();
        pinUntrackedModules();

        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        const loader = system.process?.loader;

        // PRIORITY 1: Check if already loaded (real DLL from VFS)
        if (moduleRegistry && !requestsSystemCopyOfAppDirDll(dllName)) {
            const existing = moduleRegistry.getByName(dllName);
            if (existing) {
                Logger.log(LogCategory.KERNEL32, `LoadLibraryExW("${dllName}") -> 0x${existing.baseAddress.toString(16)} (already loaded)`);
                return { value: existing.baseAddress, stackCleanup: 12 };
            }
        }

        // PRIORITY 2: Check if it's a thunked DLL (unless the game ships its own — appDirDlls)
        const thunkedName = getThunkedModuleName(dllName);
        const thunkedBase = appDirDllShadowsHle(dllName) ? undefined : getThunkedDllBase(dllName);
        if (thunkedBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 12, "LoadLibraryExW");
            if (blocked) {
                return blocked;
            }
            rememberLoadLibraryHandle(dllName, thunkedBase);
            Logger.log(LogCategory.KERNEL32, `LoadLibraryExW("${dllName}") -> 0x${thunkedBase.toString(16)} (thunked DLL)`);
            return { value: thunkedBase, stackCleanup: 12 };
        }


        // PRIORITY 3: Try to load real DLL from VFS
        if (loader) {
            Logger.log(LogCategory.KERNEL32, `LoadLibraryExW("${dllName}"): trying to load from VFS...`);
            try {
                const module = await loader.loadDll(dllName, true);
                if (module) {
                    const dllInits = loader.getPendingDllInits();
                    if (dllInits.length > 0) {
                        Logger.log(LogCategory.KERNEL32,
                            `LoadLibraryExW("${dllName}") -> 0x${module.baseAddress.toString(16)} (loaded from VFS, ${dllInits.length} DllMain pending)`);
                        return { value: module.baseAddress, stackCleanup: 12, dllInits };
                    }
                    Logger.log(LogCategory.KERNEL32,
                        `LoadLibraryExW("${dllName}") -> 0x${module.baseAddress.toString(16)} (loaded from VFS)`);
                    return { value: module.baseAddress, stackCleanup: 12 };
                }
            } catch (e) {
                Logger.warn(LogCategory.KERNEL32,
                    `LoadLibraryExW("${dllName}"): VFS load failed: ${e}`);
            }
        }

        Logger.log(LogCategory.KERNEL32, `LoadLibraryExW("${dllName}"): NOT FOUND`);
        system.process!.lastError = 126; // ERROR_MOD_NOT_FOUND
        return { value: 0, stackCleanup: 12 };
    };

    exports['LoadLibraryExA'] = async (ctx, mem, args) => {
        const lpLibFileName = args[0];
        const hFile = args[1];
        const dwFlags = args[2];
        const dllName = canonicalizeLibraryRequest(
            lpLibFileName ? Marshaler.readString(mem, lpLibFileName) : ""
        );

        ensureProcessLocalCaches();
        pinUntrackedModules();

        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        const loader = system.process?.loader;

        // PRIORITY 1: Check if already loaded (real DLL from VFS)
        if (moduleRegistry && !requestsSystemCopyOfAppDirDll(dllName)) {
            const existing = moduleRegistry.getByName(dllName);
            if (existing) {
                Logger.log(LogCategory.KERNEL32, `LoadLibraryExA("${dllName}") -> 0x${existing.baseAddress.toString(16)} (already loaded)`);
                return { value: existing.baseAddress, stackCleanup: 12 };
            }
        }

        // PRIORITY 2: Check if it's a thunked DLL (unless the game ships its own — appDirDlls)
        const thunkedName = getThunkedModuleName(dllName);
        const thunkedBase = appDirDllShadowsHle(dllName) ? undefined : getThunkedDllBase(dllName);
        if (thunkedBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 12, "LoadLibraryExA");
            if (blocked) {
                return blocked;
            }
            rememberLoadLibraryHandle(dllName, thunkedBase);
            Logger.log(LogCategory.KERNEL32, `LoadLibraryExA("${dllName}") -> 0x${thunkedBase.toString(16)} (thunked DLL)`);
            return { value: thunkedBase, stackCleanup: 12 };
        }


        // PRIORITY 3: Try to load real DLL from VFS
        if (loader) {
            Logger.log(LogCategory.KERNEL32, `LoadLibraryExA("${dllName}"): trying to load from VFS...`);
            try {
                const module = await loader.loadDll(dllName, true);
                if (module) {
                    const dllInits = loader.getPendingDllInits();
                    if (dllInits.length > 0) {
                        Logger.log(LogCategory.KERNEL32,
                            `LoadLibraryExA("${dllName}") -> 0x${module.baseAddress.toString(16)} (loaded from VFS, ${dllInits.length} DllMain pending)`);
                        return { value: module.baseAddress, stackCleanup: 12, dllInits };
                    }
                    Logger.log(LogCategory.KERNEL32,
                        `LoadLibraryExA("${dllName}") -> 0x${module.baseAddress.toString(16)} (loaded from VFS)`);
                    return { value: module.baseAddress, stackCleanup: 12 };
                }
            } catch (e) {
                Logger.warn(LogCategory.KERNEL32,
                    `LoadLibraryExA("${dllName}"): VFS load failed: ${e}`);
            }
        }

        Logger.log(LogCategory.KERNEL32, `LoadLibraryExA("${dllName}"): NOT FOUND`);
        system.process!.lastError = 126;
        return { value: 0, stackCleanup: 12 };
    };

    exports['LoadLibraryW'] = async (_ctx, mem, args) => {
        const lpLibFileName = args[0];
        const dllName = canonicalizeLibraryRequest(
            lpLibFileName ? Marshaler.readStringW(mem, lpLibFileName) : ""
        );
        const verbose = Logger.isEnabled(LogCategory.KERNEL32, LogLevel.VERBOSE);

        ensureProcessLocalCaches();
        pinUntrackedModules();
        const wantsSystemCopy = requestsSystemCopyOfAppDirDll(dllName);
        const cached = wantsSystemCopy ? undefined : getCachedLoadLibraryHandle(dllName);
        if (cached !== undefined) {
            return { value: cached, stackCleanup: 4 };
        }

        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        const loader = system.process?.loader;

        // PRIORITY 1: already loaded native DLL
        if (moduleRegistry && !wantsSystemCopy) {
            const existing = moduleRegistry.getByName(dllName);
            if (existing) {
                rememberLoadLibraryHandle(dllName, existing.baseAddress);
                return { value: existing.baseAddress, stackCleanup: 4 };
            }
        }

        // PRIORITY 2: thunked DLL (unless the game ships its own — appDirDlls)
        const thunkedName = getThunkedModuleName(dllName);
        const thunkedBase = appDirDllShadowsHle(dllName) ? undefined : getThunkedDllBase(dllName);
        if (thunkedBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 4, "LoadLibraryW");
            if (blocked) return blocked;
            rememberLoadLibraryHandle(dllName, thunkedBase);
            return { value: thunkedBase, stackCleanup: 4 };
        }


        // PRIORITY 3: load native DLL from VFS
        if (loader) {
            try {
                const module = await loader.loadDll(dllName, true);
                if (module) {
                    rememberLoadLibraryHandle(dllName, module.baseAddress);
                    const dllInits = loader.getPendingDllInits();
                    if (dllInits.length > 0) {
                        return { value: module.baseAddress, stackCleanup: 4, dllInits };
                    }
                    return { value: module.baseAddress, stackCleanup: 4 };
                }
            } catch (e) {
                Logger.warn(LogCategory.KERNEL32, `LoadLibraryW("${dllName}") failed: ${e}`);
            }
        }

        if (verbose) {
            Logger.verbose(LogCategory.KERNEL32, `LoadLibraryW("${dllName}") -> NOT FOUND`);
        }
        system.process!.lastError = 126; // ERROR_MOD_NOT_FOUND
        return { value: 0, stackCleanup: 4 };
    };

    exports['LoadLibraryA'] = async (ctx, mem, args) => {
        const lpLibFileName = args[0];
        const dllName = canonicalizeLibraryRequest(
            lpLibFileName ? Marshaler.readString(mem, lpLibFileName) : ""
        );
        const dllBaseName = getDllBaseName(dllName);
        const thunkedName = getThunkedModuleName(dllName);

        ensureProcessLocalCaches();
        pinUntrackedModules();
        const wantsSystemCopy = requestsSystemCopyOfAppDirDll(dllName);
        const cached = wantsSystemCopy ? undefined : getCachedLoadLibraryHandle(dllName);
        if (cached !== undefined) {
            return { value: cached, stackCleanup: 4 };
        }

        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        const loader = system.process?.loader;

        const callerInfo = formatLoadLibraryCaller(ctx);
        let callerNameLower = "";
        let callerName = "";
        if (moduleRegistry && ctx?.eip) {
            const callerMod = moduleRegistry.getModuleContainingAddress(ctx.eip);
            if (callerMod) {
                callerName = callerMod.name;
                callerNameLower = callerMod.name.toLowerCase();
            }
        }
        const isSmackerCaller = callerNameLower.includes('smack');
        const isBinkCaller = callerNameLower.includes('bink');

        // PRIORITY 1: already loaded native DLL
        if (moduleRegistry && !wantsSystemCopy) {
            const existing = moduleRegistry.getByName(dllName);
            if (existing) {
                rememberLoadLibraryHandle(dllName, existing.baseAddress);
                return { value: existing.baseAddress, stackCleanup: 4 };
            }
        }

        // PRIORITY 2: thunked DLL (unless the game ships its own — appDirDlls)
        const thunkedBase = appDirDllShadowsHle(dllName) ? undefined : getThunkedDllBase(dllName);
        if (thunkedBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 4, "LoadLibraryA", callerInfo);
            if (blocked) return blocked;

            // Under HLE video stubs, deny MSS32 for Smacker/Bink callers.
            if (!EMU_NATIVE_VIDEO_DLLS && dllBaseName === 'mss32' && (isSmackerCaller || isBinkCaller)) {
                system.process!.lastError = 126; // ERROR_MOD_NOT_FOUND
                Logger.warn(LogCategory.KERNEL32, `LoadLibraryA("${dllName}") denied for caller "${callerName || "unknown"}"`);
                return { value: 0, stackCleanup: 4 };
            }

            rememberLoadLibraryHandle(dllName, thunkedBase);
            return { value: thunkedBase, stackCleanup: 4 };
        }


        // PRIORITY 3: load native DLL from VFS
        if (loader) {
            try {
                const module = await loader.loadDll(dllName, true);
                if (module) {
                    rememberLoadLibraryHandle(dllName, module.baseAddress);
                    Logger.verbose(
                        LogCategory.KERNEL32,
                        `LoadLibraryA("${dllName}") -> 0x${module.baseAddress.toString(16)} (native)${callerInfo}`
                    );
                    const dllInits = loader.getPendingDllInits();
                    if (dllInits.length > 0) {
                        return { value: module.baseAddress, stackCleanup: 4, dllInits };
                    }
                    return { value: module.baseAddress, stackCleanup: 4 };
                }
            } catch (e) {
                Logger.warn(LogCategory.KERNEL32, `LoadLibraryA("${dllName}") failed: ${e}${callerInfo}`);
            }
        }

        system.process!.lastError = 126; // ERROR_MOD_NOT_FOUND
        Logger.log(
            LogCategory.KERNEL32,
            `LoadLibraryA("${dllName}") -> NOT FOUND (err=126)${callerInfo}`
        );
        return { value: 0, stackCleanup: 4 };
    };

    exports['FreeLibrary'] = (ctx, mem, args) => {
        const hModule = args[0] >>> 0;
        ensureProcessLocalCaches();
        pinUntrackedModules();

        const registry = System.getInstance().process?.moduleRegistry;
        const mod = registry?.getByBase?.(hModule);

        // Pinned (EXE + static imports), thunked pseudo-bases, and unknown handles:
        // report success without unloading (a static import holds a permanent ref).
        if (!mod || pinnedModuleBases.has(hModule)) {
            Logger.verbose(LogCategory.KERNEL32, `FreeLibrary(0x${hModule.toString(16)}) -> 1 (pinned/unknown)`);
            return { value: 1, stackCleanup: 4 };
        }

        const refs = (dynamicLoadRefs.get(hModule) ?? 1) - 1;
        if (refs > 0) {
            dynamicLoadRefs.set(hModule, refs);
            Logger.verbose(LogCategory.KERNEL32, `FreeLibrary(0x${hModule.toString(16)}) -> 1 (refs=${refs})`);
            return { value: 1, stackCleanup: 4 };
        }
        dynamicLoadRefs.delete(hModule);

        // Refcount hit zero: drop the module from the registry and all handle caches so
        // the NEXT LoadLibrary maps a FRESH image (clean .data/.bss, DllMain re-run) —
        // games rely on statics resetting across an unload/reload cycle (e.g. a UI DLL
        // whose static object lists must not survive into the next menu session). The
        // old image bytes stay mapped: safer than a real unmap, and any straggler
        // pointer into the old code keeps working instead of faulting.
        registry!.unregister(mod.name);
        for (const [k, v] of loadLibraryHandleCache) {
            if (v === hModule) loadLibraryHandleCache.delete(k);
        }
        handleToPathCache.delete(hModule);
        const prefix = `${hModule}:`;
        const ordPrefix = `${hModule}#`;
        for (const k of getProcAddressCache.keys()) {
            if (k.startsWith(prefix) || k.startsWith(ordPrefix)) getProcAddressCache.delete(k);
        }
        for (const k of getProcAddressPointerCache.keys()) {
            if (k.startsWith(prefix) || k.startsWith(ordPrefix)) getProcAddressPointerCache.delete(k);
        }
        Logger.log(LogCategory.KERNEL32,
            `FreeLibrary(0x${hModule.toString(16)}): unloaded "${mod.name}" (image left mapped; next LoadLibrary maps fresh)`);
        return { value: 1, stackCleanup: 4 };
    };

    exports['FreeLibraryAndExitThread'] = (ctx, mem, args) => {
        const hModule = args[0];
        const dwExitCode = args[1] >>> 0;
        Logger.verbose(
            LogCategory.KERNEL32,
            `FreeLibraryAndExitThread(hModule=0x${hModule.toString(16)}, exitCode=0x${dwExitCode.toString(16)})`
        );
        // We do not unload modules dynamically yet; terminate current thread as expected.
        System.getInstance().scheduler.exitThread(dwExitCode);
        return { value: 0, terminated: true, stackCleanup: 8 };
    };

    // LoadModule - Win16 compatibility function, deprecated
    // Returns module handle on success, or error code < 32 on failure
    exports['LoadModule'] = (ctx, mem, args) => {
        const lpModuleName = args[0];
        const lpParameterBlock = args[1];

        const moduleName = lpModuleName ? Marshaler.readString(mem, lpModuleName) : "";
        Logger.warn(LogCategory.KERNEL32,
            `LoadModule("${moduleName}", 0x${lpParameterBlock.toString(16)}): Win16 API stub - returning ERROR_BAD_FORMAT`);

        // Return 11 = ERROR_BAD_FORMAT (Win16 programs not supported)
        return { value: 11, stackCleanup: 8 };
    };

    // APIs that do NOT exist on Win9x kernel32 (XP SP2+ pointer obfuscation).
    // Era software feature-detects them via GetProcAddress and switches behavior on
    // the result — e.g. the VS2005 CRT treats __encoded_null() as 0 when EncodePointer
    // is absent, and __crtMessageBoxA's NT-only statics stay raw 0 on Win9x: presence
    // of EncodePointer while GetVersion says Win98 is a hybrid no real code was
    // written for (decodes a raw-0 slot into the XOR cookie and calls it).
    // Static PE imports are unaffected — this gates only dynamic lookups.
    const WIN9X_ABSENT_APIS = new Set([
        'encodepointer', 'decodepointer', 'encodesystempointer', 'decodesystempointer',
    ]);

    const getProcAddressImpl = (ctx: any, mem: Uint8Array, args: number[]): any => {
        const hModule = args[0] >>> 0;
        const lpProcName = args[1] >>> 0;

        ensureProcessLocalCaches();
        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        const apiRegistry = APIRegistry.getInstance();
        const verbose = Logger.isEnabled(LogCategory.KERNEL32, LogLevel.VERBOSE);

        let procName: string;
        let isOrdinal = false;
        let ordinal = 0;
        let ptrCacheKey: string | null = null;

        if (lpProcName > 0 && lpProcName < 0x10000) {
            procName = `ord_${lpProcName}`;
            isOrdinal = true;
            ordinal = lpProcName;
        } else {
            // Do NOT cache by the lpProcName *pointer*. UE1 UFunction::Bind resolves non-indexed
            // natives lazily via GetProcAddress(dll, name) where `name` is built into a REUSED
            // stack buffer (alloca at a fixed call depth) — so the same guest pointer carries
            // DIFFERENT names across successive binds. A pointer-keyed cache short-circuits before
            // reading the (now-changed) string and returns a stale export: e.g.
            // PlayerPawn.ConsoleCommand binds to StatLog.ExecuteSilentLogBatcher → bytecode derail
            // → "escaped to bootloader 0x7c07". Always read the string; the content-keyed
            // getProcAddressCache below is the correct, safe cache. (UT99 boot crash, 2026-06-02.)
            procName = Marshaler.readString(mem, lpProcName);
        }

        const readCaller = (): number => {
            const esp = ctx?.esp >>> 0;
            if (!esp || esp + 4 > mem.length) return 0;
            return new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getUint32(esp, true) >>> 0;
        };
        /**
         * What the address we are about to hand back actually leads to. A dynamic
         * resolution is invisible to the import table, so without this the census can
         * see THAT a game asked for an export but not whether it got anything usable —
         * and "resolved to a stub" is the failure mode that reads as success.
         */
        const classifyResolution = (address: number): { kind: GetProcResolution; dll?: string } => {
            if (address === 0) return { kind: 'null' };
            const dispatcher = system.process?.dispatcher as any;
            const stub = dispatcher?.thunkGenerator?.getStubByAddress?.(address >>> 0);
            if (!stub) return { kind: 'guest' };
            const info = dispatcher?.getImplementationInfo?.(stub.functionId) ?? null;
            if (!info) return { kind: 'stub', dll: stub.dllName };
            // Arity 0 only condemns a handler when the export takes arguments it is
            // therefore provably ignoring — GetTickCount legitimately needs none.
            const silent = (info.arity === 0 && info.argCount > 0)
                || SILENT_STUBS.has(`${stub.dllName}:${stub.functionName}`);
            return { kind: silent ? 'silent-stub' : 'hle', dll: stub.dllName };
        };
        const finish = (address: number): { value: number; stackCleanup: number } => {
            const resolution = classifyResolution(address >>> 0);
            getProcAddressRegistry.record(
                hModule, procName, address >>> 0, readCaller(), resolution.kind, resolution.dll);
            return { value: address >>> 0, stackCleanup: 8 };
        };

        if (!isOrdinal
            && EmulatorConfig.getInstance().osVersion.platformId === VER_PLATFORM_WIN32_WINDOWS
            && WIN9X_ABSENT_APIS.has(procName.toLowerCase())) {
            system.process!.lastError = 127; // ERROR_PROC_NOT_FOUND
            if (verbose) {
                Logger.verbose(LogCategory.KERNEL32,
                    `GetProcAddress("${procName}") -> NULL (absent on Win9x)`);
            }
            return finish(0);
        }

        const cacheKey = buildGetProcCacheKey(hModule, procName, isOrdinal, ordinal);
        const cached = getProcAddressCache.get(cacheKey);
        if (cached !== undefined && cached !== 0) {
            if (ptrCacheKey) {
                getProcAddressPointerCache.set(ptrCacheKey, cached >>> 0);
            }
            return finish(cached);
        }
        // Retry previously-missed thunked exports — stubs may appear after warmup / HMR.
        if (cached === 0 && hleModuleNameByBase(hModule) !== undefined) {
            getProcAddressCache.delete(cacheKey);
        } else if (cached === 0) {
            system.process!.lastError = 127;
            return finish(0);
        }

        let address = 0;
        const procKey = isOrdinal ? "" : procName.toLowerCase();
        const isMainExeDebugCrtProbe = hModule === DEFAULT_EXE_BASE && EXE_DEBUG_CRT_PROBE_NAMES.has(procKey);

        // A real HMODULE scopes lookup to that PE image. Falling through to the global
        // thunk table after a miss can return a same-named export from another DLL.
        if (moduleRegistry && hModule !== 0) {
            const peBase = moduleRegistry.resolvePeModuleBase(hModule);
            const mod = moduleRegistry.getByBase(peBase);
            if (mod) {
                if (isOrdinal) {
                    const addr = mod.ordinalExports.get(ordinal);
                    if (addr !== undefined) address = addr >>> 0;
                } else {
                    const addr = mod.exports.get(procName.toLowerCase());
                    if (addr !== undefined) address = addr >>> 0;
                }

                if (address !== 0) {
                    getProcAddressCache.set(cacheKey, address);
                    if (ptrCacheKey) {
                        getProcAddressPointerCache.set(ptrCacheKey, address >>> 0);
                    }
                    return finish(address);
                }

                if (!mod.isExecutable) {
                    getProcAddressCache.set(cacheKey, 0);
                    system.process!.lastError = 127;
                    return finish(0);
                }
            }
        }

        // Thunked APIs (including on-demand stub creation).
        if (system.process?.dispatcher) {
            const dispatcher = system.process.dispatcher as any;

            if (address === 0 && hModule !== 0) {
                const dllName = hleModuleNameByBase(hModule) ?? null;

                const debugCrtProbeOnRelease = dllName !== null
                    && DEBUG_CRT_ONLY_EXPORTS.has(procKey)
                    && RELEASE_CRT_MODULE_RE.test(dllName);

                if (dllName && !debugCrtProbeOnRelease) {
                    const dataAddr = dispatcher.thunkGenerator?.getDataExportAddress(dllName, procName);
                    if (dataAddr !== undefined) {
                        address = dataAddr >>> 0;
                    } else {
                        address = resolveThunkedExportAddress(dispatcher, dllName, procName, verbose);
                    }
                }

                if (address === 0 && hModule === DEFAULT_EXE_BASE) {
                    const forwards = isMainExeDebugCrtProbe ? undefined : EXE_GETPROC_FORWARD_MAP[procKey];
                    if (forwards) {
                        for (const candidate of forwards) {
                            address = resolveThunkedExportAddress(dispatcher, candidate.dll, candidate.name, verbose);
                            if (address !== 0) break;
                        }
                    }
                }
            }
        }

        if (address !== 0) {
            getProcAddressCache.set(cacheKey, address >>> 0);
            if (ptrCacheKey) {
                getProcAddressPointerCache.set(ptrCacheKey, address >>> 0);
            }
            return finish(address);
        }

        getProcAddressCache.set(cacheKey, 0);
        if (ptrCacheKey) {
            getProcAddressPointerCache.set(ptrCacheKey, 0);
        }
        system.process!.lastError = 127; // ERROR_PROC_NOT_FOUND
        Logger.warn(
            LogCategory.KERNEL32,
            `GetProcAddress(0x${hModule.toString(16)}, "${procName}") -> NULL (ERROR_PROC_NOT_FOUND)`
        );
        return finish(0);
    };

    exports['GetProcAddress'] = getProcAddressImpl;
}

initModuleFunctions();

/**
 * Pre-populate GetProcAddress cache for all known thunked exports.
 * Call after applyPendingRegistrations() to eliminate cold-miss stub allocation
 * at runtime (~0.3s saved during loading).
 */
export function prePopulateGetProcAddressCache(dispatcher: any): void {
    ensureProcessLocalCaches();
    const tg = dispatcher?.thunkGenerator;
    if (!tg || typeof tg.getAllStubs !== 'function') return;
    const stubs = tg.getAllStubs();
    let count = 0;
    for (const stub of stubs) {
        const dllLower = stub.dllName.toLowerCase();
        const base = hleImageBase(dllLower);
        if (base === undefined) continue;
        const key = buildGetProcCacheKey(base, stub.functionName, false, 0);
        if (!getProcAddressCache.has(key)) {
            getProcAddressCache.set(key, stub.address >>> 0);
            count++;
        }
    }
    if (count > 0) {
        Logger.log(LogCategory.KERNEL32, `GetProcAddress cache pre-populated: ${count} entries`);
    }
}

/**
 * Register GetModuleHandleA fast path — covers the common case of thunked DLL lookups.
 */
export function registerFastPathModuleFunctions(dispatcher: any): void {
    if (!dispatcher?.registerFastPath) return;

    const impl = (cpu: any, mem8: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
        const esp = cpu.reg32[4] >>> 0;
        if (esp + 8 > mem8.length) return null;
        const lpName = view.getUint32(esp + 4, true) >>> 0;
        if (lpName === 0) return getMainExeHandle();
        const name = Marshaler.readString(mem8, lpName);
        const thunkedName = getThunkedModuleName(name);
        // Answer ONLY where the slow path would answer the same. It consults the loaded-module
        // registry FIRST, so a game shipping its own ddraw/d3d8 (manifest.appDirDlls) must not
        // get the HLE image's base here — two handles for one name means it patches the wrong
        // image. Same for manifest.disabledDlls: a module we must not provide.
        const registry = System.getInstance().process?.moduleRegistry;
        if (registry?.getByName(name)) return null;
        if (appDirDllShadowsHle(name) || requestsSystemCopyOfAppDirDll(name)) return null;
        if (findDisabledDllRule(name) || findDisabledDllRule(thunkedName)) return null;
        const base = hleImageBase(thunkedName);
        if (base !== undefined) {
            markHleModuleLoaded(thunkedName);
            return base;
        }
        return null; // Fall through to slow path for real DLLs, exe name, etc.
    };

    dispatcher.registerFastPath('kernel32', 'GetModuleHandleA', impl);
    Logger.log(LogCategory.KERNEL32, 'Registered fast path for GetModuleHandleA');
}
