// Module management functions for kernel32
// GetModuleHandle*, LoadLibrary*, GetProcAddress, FreeLibrary, GetModuleFileName*

import { ThunkImplementation } from '../../../core/thunking/thunk-dispatcher';
import { System } from '../../../core/system';
import { Marshaler } from '../../../core/memory/marshaler';
import { Logger, LogCategory, LogLevel } from '../../../core/logger';
import { APIRegistry } from '../../../core/api-registry';
import { EMU_NATIVE_VIDEO_DLLS } from '../../../core/cpu/emulator-config';
import { EmulatorConfig } from '../../../core/emulator-config-manager';
import { encodeAnsi } from '../../codepage-utils';
import { resolveThunkedDllAlias } from '../../../core/dll-aliases';
import { THUNKED_DLL_PSEUDO_BASE } from '../../../core/hle-system-catalog';
import { getProcAddressRegistry } from '../../../core/diagnostics/get-proc-address-registry';

export const exports: Record<string, ThunkImplementation> = {};

const DEFAULT_EXE_BASE = 0x00400000;

function getMainExeHandle(): number {
    return System.getInstance().process?.moduleRegistry?.getMainExecutableBase() ?? DEFAULT_EXE_BASE;
}

// THUNKED_DLL_PSEUDO_BASE lives in hle-system-catalog.ts (shared with VFS virtual presence).
// UE1 native packages (e.g. Galaxy.dll) self-register their UClass via IMPLEMENT_CLASS in
// C++ static-init when the DLL actually loads. They MUST load for real: returning a thunked
// API pseudo-base makes LoadLibrary skip the real load (PRIORITY 3), so the class is never
// registered and UE1 aborts with "Failed to find object 'Class Galaxy.GalaxyAudioSubsystem'".
// The galaxy HLE is designed to PATCH the real DLL after load (native-patch.ts), never to
// replace it — so galaxy's APIRegistry presence must not hijack LoadLibrary/GetModuleHandle.
const FORCE_NATIVE_PACKAGE_LOAD = new Set<string>(['galaxy']);

const THUNKED_DLL_PSEUDO_BY_BASE = new Map<number, string>(
    Object.entries(THUNKED_DLL_PSEUDO_BASE).map(([name, base]) => [base >>> 0, name])
);

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

const EXE_DEBUG_CRT_PROBE_NAMES = new Set([
    "_malloc_dbg",
    "_calloc_dbg",
    "_realloc_dbg",
    "_free_dbg",
    "_strdup_dbg",
    "_msize_dbg",
    "_crtdbgreport",
    "_crtdbgreportw",
    "_crtsetdbgflag",
    "_crtcheckmemory",
    "_crtisvalidheappointer",
    "_crtdumpmemoryleaks",
    "_assert",
    "_wassert",
]);

/**
 * Get pseudo-base address for a thunked DLL
 */
function getThunkedModuleName(value: string): string {
    return resolveThunkedDllAlias(getDllBaseName(value));
}

function getThunkedDllBase(dllName: string): number | undefined {
    return THUNKED_DLL_PSEUDO_BASE[getThunkedModuleName(dllName)];
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

    const thunked = THUNKED_DLL_PSEUDO_BY_BASE.get(h);
    if (thunked) {
        const path = formatSystemDllPath(thunked);
        handleToPathCache.set(h, path);
        return { path, found: true };
    }

    const generated = getHashToDllNameMap().get(h);
    if (generated) {
        const path = formatSystemDllPath(generated);
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

/**
 * Resolve a thunked DLL export by name, creating an on-demand stub when needed.
 * Used by GetProcAddress and boot-time warmup for dynamic-only exports.
 */
function resolveThunkedExportAddress(
    dispatcher: any,
    dllName: string,
    exportName: string,
    verbose = false,
): number {
    const system = System.getInstance();
    const apiRegistry = APIRegistry.getInstance();
    const tg = dispatcher?.thunkGenerator;
    if (!tg) return 0;

    const dataAddr = tg.getDataExportAddress(dllName, exportName);
    if (dataAddr !== undefined) return dataAddr >>> 0;

    const byQualifiedName = tg.getExportAddress(`${dllName}:${exportName}`);
    if (byQualifiedName !== undefined) return byQualifiedName >>> 0;
    const byShortName = tg.getExportAddress(exportName);
    if (byShortName !== undefined) return byShortName >>> 0;

    const inApi = apiRegistry.hasExportedFunction(dllName, exportName);
    const pendingKey = `${dllName}:${exportName}`.toLowerCase();
    const hasPending = !!dispatcher?.pendingRegistrations?.has(pendingKey);
    if (!apiRegistry.hasModule(dllName) && !hasPending) return 0;

    const argCount = apiRegistry.getArgCount(dllName, exportName);
    const stackCleanupBytes = apiRegistry.getStackCleanupBytes(dllName, exportName);
    if (!inApi && !hasPending && argCount === undefined && stackCleanupBytes === undefined) {
        return 0;
    }

    const callingConv = apiRegistry.getCallingConvention(dllName, exportName);
    try {
        const { address: stubAddr, code } = tg.allocateOneStub(
            dllName,
            exportName,
            argCount ?? 0,
            callingConv || 'stdcall',
            stackCleanupBytes ?? 0,
        );

        const memArray = system.process?.getCurrentMemory();
        if (memArray && stubAddr + code.length <= memArray.length) {
            memArray.set(code, stubAddr);
            if (typeof dispatcher.bindPendingRegistrationsForFunctionId === "function") {
                dispatcher.bindPendingRegistrationsForFunctionId(tg.getStubByAddress(stubAddr)?.functionId ?? 0);
            } else {
                dispatcher.applyPendingRegistrations();
            }
            if (verbose) {
                Logger.verbose(
                    LogCategory.KERNEL32,
                    `GetProcAddress: created stub ${dllName}:${exportName} at 0x${stubAddr.toString(16)}`
                );
            }
            Logger.log(
                LogCategory.KERNEL32,
                `GetProcAddress: created on-demand stub ${dllName}:${exportName} -> 0x${stubAddr.toString(16)}`
            );
            return stubAddr >>> 0;
        }
        Logger.warn(
            LogCategory.KERNEL32,
            `GetProcAddress: stub ${dllName}:${exportName} at 0x${stubAddr.toString(16)} exceeds guest mem (len=${memArray?.length ?? 0})`
        );
    } catch (e) {
        Logger.warn(LogCategory.KERNEL32, `GetProcAddress: stub creation failed for ${dllName}:${exportName}: ${e}`);
    }
    return 0;
}

/** Boot-time warmup for exports resolved only via GetProcAddress (not PE imports). */
export function ensureGetProcAddressDynamicExports(
    dispatcher: any,
    exports: Array<{ dll: string; name: string }>,
): void {
    ensureProcessLocalCaches();
    for (const entry of exports) {
        const dllLower = entry.dll.toLowerCase();
        let base: number | undefined = THUNKED_DLL_PSEUDO_BASE[dllLower];
        if (base === undefined) base = computeGeneratedPseudoBase(dllLower);
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

/** Lazily-built cache: hash → module name for APIRegistry modules not in THUNKED_DLL_PSEUDO_BASE */
let hashToDllNameCache: Map<number, string> | null = null;

function computeGeneratedPseudoBase(moduleName: string): number {
    let hash = 0x70000000;
    for (let i = 0; i < moduleName.length; i++) {
        hash = ((hash << 5) - hash + moduleName.charCodeAt(i)) >>> 0;
    }
    return (hash & 0x0FFFFFFF) | 0x70000000;
}

function getHashToDllNameMap(): Map<number, string> {
    if (hashToDllNameCache) return hashToDllNameCache;
    hashToDllNameCache = new Map();
    const apiRegistry = APIRegistry.getInstance();
    for (const modName of apiRegistry.getModuleNames()) {
        hashToDllNameCache.set(computeGeneratedPseudoBase(modName), modName);
    }
    return hashToDllNameCache;
}

function normalizeDllPathToken(value: string): string {
    return value.trim().replace(/^"+|"+$/g, "").replace(/\//g, "\\");
}

function stripDllExtension(value: string): string {
    return value.replace(/\.dll$/i, "");
}

function wildcardToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

function findDisabledDllRule(dllName: string): string | null {
    if (!dllName) return null;
    const rules = EmulatorConfig.getInstance().disabledDlls;
    if (!rules || rules.length === 0) return null;

    const full = normalizeDllPathToken(dllName).toLowerCase();
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
                    return rawRule;
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
            return rawRule;
        }

        // Path-like explicit rules should also match suffix of full path.
        if (rule.includes("\\") && (full.endsWith(rule) || fullNoDot.endsWith(ruleNoDot) || fullNoDrive.endsWith(ruleNoDrive))) {
            return rawRule;
        }
    }

    return null;
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

        // Also check APIRegistry for any thunked module we might have missed in the pseudo-base list
        const apiRegistry = APIRegistry.getInstance();
        if (apiRegistry.hasModule(thunkedName) && !FORCE_NATIVE_PACKAGE_LOAD.has(thunkedName)) {
            const blocked = tryBlockThunkedDllLoad(name, thunkedName, 4, "GetModuleHandleA");
            if (blocked) {
                return blocked;
            }
            const hash = computeGeneratedPseudoBase(thunkedName);
            Logger.log(LogCategory.KERNEL32, `GetModuleHandleA("${name}") -> 0x${hash.toString(16)} (thunked DLL, generated)`);
            return { value: hash, stackCleanup: 4 };
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

        // Also check APIRegistry for any thunked module we might have missed
        const apiRegistry = APIRegistry.getInstance();
        if (apiRegistry.hasModule(thunkedName) && !FORCE_NATIVE_PACKAGE_LOAD.has(thunkedName)) {
            const blocked = tryBlockThunkedDllLoad(name, thunkedName, 4, "GetModuleHandleW");
            if (blocked) {
                return blocked;
            }
            const hash = computeGeneratedPseudoBase(thunkedName);
            Logger.verbose(LogCategory.KERNEL32, `GetModuleHandleW("${name}") -> 0x${hash.toString(16)} (thunked DLL, generated)`);
            return { value: hash, stackCleanup: 4 };
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
        if (moduleRegistry) {
            const existing = moduleRegistry.getByName(dllName);
            if (existing) {
                Logger.log(LogCategory.KERNEL32, `LoadLibraryExW("${dllName}") -> 0x${existing.baseAddress.toString(16)} (already loaded)`);
                return { value: existing.baseAddress, stackCleanup: 12 };
            }
        }

        // PRIORITY 2: Check if it's a thunked DLL
        const thunkedName = getThunkedModuleName(dllName);
        const thunkedBase = getThunkedDllBase(dllName);
        if (thunkedBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 12, "LoadLibraryExW");
            if (blocked) {
                return blocked;
            }
            rememberLoadLibraryHandle(dllName, thunkedBase);
            Logger.log(LogCategory.KERNEL32, `LoadLibraryExW("${dllName}") -> 0x${thunkedBase.toString(16)} (thunked DLL)`);
            return { value: thunkedBase, stackCleanup: 12 };
        }

        // Also check APIRegistry for any thunked module not in the explicit list
        const apiRegistry = APIRegistry.getInstance();
        if (apiRegistry.hasModule(thunkedName) && !FORCE_NATIVE_PACKAGE_LOAD.has(thunkedName)) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 12, "LoadLibraryExW");
            if (blocked) {
                return blocked;
            }
            const hash = computeGeneratedPseudoBase(thunkedName);
            rememberLoadLibraryHandle(dllName, hash);
            Logger.log(LogCategory.KERNEL32, `LoadLibraryExW("${dllName}") -> 0x${hash.toString(16)} (thunked DLL, generated)`);
            return { value: hash, stackCleanup: 12 };
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
        if (moduleRegistry) {
            const existing = moduleRegistry.getByName(dllName);
            if (existing) {
                Logger.log(LogCategory.KERNEL32, `LoadLibraryExA("${dllName}") -> 0x${existing.baseAddress.toString(16)} (already loaded)`);
                return { value: existing.baseAddress, stackCleanup: 12 };
            }
        }

        // PRIORITY 2: Check if it's a thunked DLL
        const thunkedName = getThunkedModuleName(dllName);
        const thunkedBase = getThunkedDllBase(dllName);
        if (thunkedBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 12, "LoadLibraryExA");
            if (blocked) {
                return blocked;
            }
            rememberLoadLibraryHandle(dllName, thunkedBase);
            Logger.log(LogCategory.KERNEL32, `LoadLibraryExA("${dllName}") -> 0x${thunkedBase.toString(16)} (thunked DLL)`);
            return { value: thunkedBase, stackCleanup: 12 };
        }

        // Also check APIRegistry for any thunked module not in the explicit list
        const apiRegistry = APIRegistry.getInstance();
        if (apiRegistry.hasModule(thunkedName) && !FORCE_NATIVE_PACKAGE_LOAD.has(thunkedName)) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 12, "LoadLibraryExA");
            if (blocked) {
                return blocked;
            }
            const hash = computeGeneratedPseudoBase(thunkedName);
            rememberLoadLibraryHandle(dllName, hash);
            Logger.log(LogCategory.KERNEL32, `LoadLibraryExA("${dllName}") -> 0x${hash.toString(16)} (thunked DLL, generated)`);
            return { value: hash, stackCleanup: 12 };
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
        const cached = getCachedLoadLibraryHandle(dllName);
        if (cached !== undefined) {
            return { value: cached, stackCleanup: 4 };
        }

        const system = System.getInstance();
        const moduleRegistry = system.process?.moduleRegistry;
        const loader = system.process?.loader;

        // PRIORITY 1: already loaded native DLL
        if (moduleRegistry) {
            const existing = moduleRegistry.getByName(dllName);
            if (existing) {
                rememberLoadLibraryHandle(dllName, existing.baseAddress);
                return { value: existing.baseAddress, stackCleanup: 4 };
            }
        }

        // PRIORITY 2: thunked DLL
        const thunkedName = getThunkedModuleName(dllName);
        const thunkedBase = getThunkedDllBase(dllName);
        if (thunkedBase !== undefined) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 4, "LoadLibraryW");
            if (blocked) return blocked;
            rememberLoadLibraryHandle(dllName, thunkedBase);
            return { value: thunkedBase, stackCleanup: 4 };
        }

        // Also check APIRegistry for generated thunked module pseudo-bases.
        const apiRegistry = APIRegistry.getInstance();
        if (apiRegistry.hasModule(thunkedName) && !FORCE_NATIVE_PACKAGE_LOAD.has(thunkedName)) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 4, "LoadLibraryW");
            if (blocked) return blocked;
            const hash = computeGeneratedPseudoBase(thunkedName);
            rememberLoadLibraryHandle(dllName, hash);
            return { value: hash, stackCleanup: 4 };
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
        const cached = getCachedLoadLibraryHandle(dllName);
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
        if (moduleRegistry) {
            const existing = moduleRegistry.getByName(dllName);
            if (existing) {
                rememberLoadLibraryHandle(dllName, existing.baseAddress);
                return { value: existing.baseAddress, stackCleanup: 4 };
            }
        }

        // PRIORITY 2: thunked DLL
        const thunkedBase = getThunkedDllBase(dllName);
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

        // Also check APIRegistry for generated thunked module pseudo-bases.
        const apiRegistry = APIRegistry.getInstance();
        if (apiRegistry.hasModule(thunkedName) && !FORCE_NATIVE_PACKAGE_LOAD.has(thunkedName)) {
            const blocked = tryBlockThunkedDllLoad(dllName, thunkedName, 4, "LoadLibraryA", callerInfo);
            if (blocked) return blocked;
            const hash = computeGeneratedPseudoBase(thunkedName);
            rememberLoadLibraryHandle(dllName, hash);
            return { value: hash, stackCleanup: 4 };
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
        const finish = (address: number): { value: number; stackCleanup: number } => {
            getProcAddressRegistry.record(hModule, procName, address >>> 0, readCaller());
            return { value: address >>> 0, stackCleanup: 8 };
        };

        const cacheKey = buildGetProcCacheKey(hModule, procName, isOrdinal, ordinal);
        const cached = getProcAddressCache.get(cacheKey);
        if (cached !== undefined && cached !== 0) {
            if (ptrCacheKey) {
                getProcAddressPointerCache.set(ptrCacheKey, cached >>> 0);
            }
            return finish(cached);
        }
        // Retry previously-missed thunked exports — stubs may appear after warmup / HMR.
        if (cached === 0 && (THUNKED_DLL_PSEUDO_BY_BASE.has(hModule) || getHashToDllNameMap().has(hModule))) {
            getProcAddressCache.delete(cacheKey);
        } else if (cached === 0) {
            system.process!.lastError = 127;
            return finish(0);
        }

        let address = 0;
        const procKey = isOrdinal ? "" : procName.toLowerCase();
        const isMainExeDebugCrtProbe = hModule === DEFAULT_EXE_BASE && EXE_DEBUG_CRT_PROBE_NAMES.has(procKey);

        // First, try to find in module registry (real DLLs).
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
            }
        }

        // Thunked APIs (including on-demand stub creation).
        if (system.process?.dispatcher) {
            const dispatcher = system.process.dispatcher as any;

            if (!isMainExeDebugCrtProbe) {
                const direct = dispatcher.thunkGenerator?.getExportAddress(procName);
                if (direct !== undefined) {
                    address = direct >>> 0;
                }
            }

            if (address === 0 && hModule !== 0) {
                let dllName = THUNKED_DLL_PSEUDO_BY_BASE.get(hModule) ?? null;
                if (!dllName) {
                    dllName = getHashToDllNameMap().get(hModule) ?? null;
                }

                if (dllName) {
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
        let base: number | undefined = THUNKED_DLL_PSEUDO_BASE[dllLower];
        if (base === undefined) base = computeGeneratedPseudoBase(dllLower);
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
        const base = getThunkedDllBase(name.toLowerCase().replace(/\.dll$/, ''));
        if (base !== undefined) return base;
        return null; // Fall through to slow path for real DLLs, exe name, etc.
    };

    dispatcher.registerFastPath('kernel32', 'GetModuleHandleA', impl);
    Logger.log(LogCategory.KERNEL32, 'Registered fast path for GetModuleHandleA');
}
