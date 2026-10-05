/**
 * Canonical thunked DLL name resolution.
 * Versioned or wrapper DLL names map to a single HLE module.
 */

import { APISET_SCHEMA } from "./apiset-schema.generated";

const STATIC_ALIASES: Record<string, string> = {
    xdd: "ddraw",
    ddraw32: "ddraw",
    dinput8: "dinput",
    openal32: "wrap_oal",
    // xinput9_1_0 exports the four-function subset BY NAME only, so routing it to the
    // 1.3 table is exact for every import that can occur; its own ordinals (assigned in
    // spec order) are not the 1.x table and no shipping title imports them.
    xinput9_1_0: "xinput1_3",
};

/**
 * The VS2015+ C runtime, which ships as a FAMILY of DLLs rather than one msvcrN.dll:
 * `api-ms-win-crt-<area>-l1-1-0.dll` are pure forwarders, `ucrtbase.dll` holds the C
 * library they forward to, and `vcruntime140.dll` holds the compiler-support half
 * (memcpy, the C++ EH personality routines, setjmp). One implementation, several import
 * names — so one HLE module answers for all of them, exactly as msvcr90 does.
 *
 * The area and version parts are matched, not enumerated: MS adds api sets (`-l1-1-1`,
 * `-private-l1-1-0`) without changing what is behind them.
 */
const UCRT_APISET = /^api-ms-win-crt-[a-z0-9]+(?:-[a-z0-9]+)*-l\d+-\d+-\d+$/i;

/**
 * The versioned C runtimes (msvcr70 … msvcr120) are the same C library under different
 * import names, exactly as the ucrt family is. Without the alias a name like `msvcr80` is
 * not a module we know: the loader looks for a real msvcr80.dll in the VFS, finds none, and
 * emits stubs with NO handler behind them — so every CRT call from a VC8-built image logs
 * Unimplemented and returns zero, including the SEH handler every __try frame runs through.
 */
const MSVCR_VERSIONED = /^msvcr\d+d?$/i;
/** The C++ runtime of the same generations. msvcp60 and msvcp140 have their own modules. */
const MSVCP_VERSIONED = /^msvcp(70|71|80|100|110|120)d?$/i;
/** ucrtbase / ucrtbased, vcruntime / vcruntime140 / vcruntime140d / vcruntime140_1. */
const UCRT_RUNTIME = /^(?:ucrtbased?|vcruntime(?:\d+(?:d|_\d+)?)?)$/i;

/** d3dx9_24 … d3dx9_43, d3dx924-style link names */
const D3DX9_VERSIONED = /^d3dx9_?\d+$/i;
/** Debug D3DX9 builds */
const D3DX9_DEBUG = /^d3dx9d_\d+$/i;
/**
 * xinput1_1 … xinput1_4. Every version shares one ordinal table (Wine's 1_3 and 1_4
 * specs agree on 1-8 and 100), so one HLE module answers for all of them — and an
 * ordinal import, which is how xinput is normally linked, resolves to the same export.
 */
const XINPUT_VERSIONED = /^xinput1_\d+$/i;

function stripDllExtension(value: string): string {
    return value.replace(/\.dll$/i, "");
}

/**
 * Normalize a DLL path or base name to lowercase without extension.
 */
export function normalizeDllBaseName(value: string): string {
    const trimmed = value.trim().replace(/^"+|"+$/g, "").replace(/\//g, "\\");
    const base = stripDllExtension(trimmed.split("\\").pop() ?? trimmed);
    return base.toLowerCase();
}

/**
 * Resolve a requested DLL name to the canonical HLE module name.
 * Returns the normalized base name when no alias applies.
 */
export function resolveThunkedDllAlias(name: string): string {
    const base = normalizeDllBaseName(name);
    if (!base) return base;

    const staticTarget = STATIC_ALIASES[base];
    if (staticTarget) return staticTarget;

    if (D3DX9_VERSIONED.test(base) || D3DX9_DEBUG.test(base)) {
        return "d3dx9";
    }

    if (XINPUT_VERSIONED.test(base)) {
        return "xinput1_3";
    }

    if (UCRT_APISET.test(base) || UCRT_RUNTIME.test(base) || MSVCR_VERSIONED.test(base)) {
        return "msvcrt";
    }

    if (MSVCP_VERSIONED.test(base)) {
        return "msvcp90";
    }

    const apiSetHost = resolveApiSetHost(base);
    if (apiSetHost) return resolveThunkedDllAlias(apiSetHost);

    return base;
}

/**
 * The host DLL an api-set contract (api-ms-win-*, ext-ms-win-*) resolves to, or undefined.
 *
 * The loader never maps a contract as a file: it looks the name up in the ApiSetSchema,
 * ignoring the last version component, and hands back the HOST's module. So
 * LoadLibrary("api-ms-win-core-synch-l1-2-0") returns kernelbase's HMODULE, and
 * GetProcAddress on it sees exactly kernelbase's exports.
 */
export function resolveApiSetHost(name: string): string | undefined {
    const base = normalizeDllBaseName(name);
    if (!base.startsWith("api-ms-") && !base.startsWith("ext-ms-")) return undefined;
    return APISET_SCHEMA[base.replace(/-\d+$/, "")];
}

/**
 * True when the requested name aliases to a different canonical module.
 */
export function isThunkedDllAlias(name: string): boolean {
    const base = normalizeDllBaseName(name);
    return base !== resolveThunkedDllAlias(name);
}
