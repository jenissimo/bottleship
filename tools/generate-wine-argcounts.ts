#!/usr/bin/env bun
/**
 * generate-wine-argcounts: derive stdcall arities for win32 exports from Wine's
 * `.spec` files and emit them as `*.sig.json` under tools/reference/win32/.
 *
 * WHY: the ThunkGenerator refuses to emit a stdcall stub whose stack cleanup it
 * cannot size, and that refusal fails the WHOLE PE load — one unknown name takes
 * the process down at boot. Our hand-curated reference is derived from a handful of
 * ReactOS headers, so anything declared in a header we never fetched (winnls.h,
 * gdiplusflat.h, iphlpapi.h, …) is a boot blocker found one reload at a time.
 * A `.spec` line IS the arity: Wine's build needs the exact stack size for every
 * export of every DLL, so it is the canonical, complete list.
 *
 * We read arity ONLY — names and stack-slot counts, no code, no prose. The specs
 * are not vendored: point BS_WINE_DLLS at a Wine checkout (see CLAUDE.md's
 * ground-truth sources), run this, and commit the generated .sig.json — the same
 * arrangement the ReactOS-derived reference already uses.
 *
 * Usage:
 *   bun tools/generate-wine-argcounts.ts [--dlls a,b,c] [--wine <dir>] [--dry]
 *   bun tools/generate-reference-argcounts.ts     # then rebuild the TS map
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "..");
const OUT_ROOT = join(REPO, "tools", "reference", "win32");

/**
 * Every module we HLE, taken from the descriptors themselves so the set cannot lag
 * behind a newly added `*.api.ts`: hand-maintaining this list is how a title dies at
 * boot on one ordinal of a DLL nobody remembered to add (oledlg). Names with no Wine
 * spec (glide2x, mss32, binkw32 — not win32 at all) simply do not match and are
 * reported as skipped.
 */
function hleModuleNames(): string[] {
    const dir = join(REPO, "src", "worker", "api");
    const names = new Set<string>();
    for (const f of readdirSync(dir)) {
        if (!f.endsWith(".api.ts")) continue;
        const text = readFileSync(join(dir, f), "utf-8");
        // The descriptor's own `name:` is the import-table spelling ("winspool.drv"),
        // which the filename is not.
        const m = /name:\s*"([\w.\-]+)"/.exec(text);
        names.add((m?.[1] ?? f.slice(0, -".api.ts".length)).toLowerCase());
    }
    return [...names];
}

/**
 * Our module name differs from the spec directory. A versioned redistributable is
 * imported under a dozen names (`d3dx9_24` … `d3dx9_43`) that all resolve to one HLE
 * module, and its arities live in the newest spec.
 */
const SPEC_ALIASES: Record<string, string> = {
    d3dx9: "d3dx9_43",
};

/**
 * Win32 DLLs a guest imports that have no `*.api.ts` of their own — the stub
 * generator still has to size them.
 */
const EXTRA_DLLS = [
    "advapi32", "comctl32", "comdlg32", "crypt32", "dbghelp", "dsound", "gdi32",
    "gdiplus", "hid", "imagehlp", "imm32", "iphlpapi", "kernel32", "mpr", "msacm32",
    "msi", "msimg32", "msvfw32", "netapi32", "ntdll", "ole32", "oleacc", "oleaut32",
    "olepro32", "opengl32", "psapi", "rpcrt4", "setupapi", "shell32", "shlwapi",
    "user32", "userenv", "usp10", "uxtheme", "version", "wininet", "winmm",
    "winspool.drv", "wintrust", "ws2_32", "wsock32", "wtsapi32", "xinput1_3",
];

const DEFAULT_DLLS = [...new Set([...EXTRA_DLLS, ...hleModuleNames()])].sort();

/** Stack slots a Wine spec argument type occupies in a 32-bit stdcall frame. */
function slotsFor(type: string): number {
    switch (type) {
        case "double": case "int64": return 2;
        // word/float/long/ptr/str/wstr/segptr/segstr/ptr all take one 4-byte slot
        // (a `word` argument is still pushed padded to 4).
        default: return 1;
    }
}

interface Export { name: string; argCount: number; ordinal?: number; note?: string }

/**
 * One `.spec` line: `<ordinal|@> <calltype> [-flags…] Name(args…) [target]`.
 * Only stdcall carries a callee-cleanup contract; cdecl/varargs are caller-cleaned
 * and must NOT be seeded (the reference declares everything it seeds as stdcall,
 * so a cdecl entry here would emit a RET N that eats the caller's arguments).
 */
function parseSpec(text: string): Export[] {
    const out: Export[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trim();
        if (!line) continue;
        const m = /^(@|\d+)\s+(\w+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const ordinal = m[1] === "@" ? undefined : parseInt(m[1], 10);
        if (m[2] !== "stdcall") continue;

        let rest = m[3];
        let arch: string | null = null;
        // Flags precede the name. `-register` takes its arguments off the raw stack
        // frame, so its declared list is not a stdcall signature — skip it entirely.
        let skip = false;
        while (rest.startsWith("-")) {
            const f = /^(-[\w=,.]+)\s+(.*)$/.exec(rest);
            if (!f) { skip = true; break; }
            if (f[1] === "-register") skip = true;
            if (f[1].startsWith("-arch=")) arch = f[1].slice(6);
            rest = f[2];
        }
        if (skip) continue;
        // 64-bit-only and ARM-only exports have no 32-bit x86 stub to size.
        if (arch && !/\b(win32|i386)\b/.test(arch)) continue;

        const sig = /^([\w.@?$]+)\s*\(([^)]*)\)/.exec(rest);
        if (!sig) continue;
        const args = sig[2].trim();
        const types = args === "" ? [] : args.split(/\s+/);
        const argCount = types.reduce((n, t) => n + slotsFor(t), 0);
        // A descriptor counts PARAMETERS; this file counts SLOTS, and an 8-byte argument
        // makes the two differ legitimately. Say so on the entry rather than letting
        // validate-signatures read the difference as a wrong RET N.
        const note = argCount !== types.length
            ? `slot count exceeds parameter count (${types.filter((t) => slotsFor(t) > 1).join(", ")} occupy two slots each)`
            : undefined;
        out.push({ name: sig[1], argCount, ordinal, note });
    }
    return out;
}

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
};
const wineDir = flag("--wine") ?? process.env.BS_WINE_DLLS ?? "G:/sources/wine/dlls";
const dlls = (flag("--dlls") ?? "").trim() ? flag("--dlls")!.split(",").map((s) => s.trim()) : DEFAULT_DLLS;
const dry = argv.includes("--dry");

if (!existsSync(wineDir)) {
    console.error(`Wine dlls directory not found: ${wineDir}`);
    console.error(`Set BS_WINE_DLLS or pass --wine <dir> (a Wine source checkout's dlls/).`);
    process.exit(1);
}

let totalFns = 0, totalDlls = 0, missing: string[] = [];
for (const dll of dlls) {
    const specDir = SPEC_ALIASES[dll] ?? dll;
    const spec = join(wineDir, specDir, `${specDir}.spec`);
    if (!existsSync(spec)) { missing.push(dll); continue; }
    const fns = parseSpec(readFileSync(spec, "utf-8"));
    if (fns.length === 0) { missing.push(dll); continue; }

    // Ordinal aliases: an import BY ordinal reaches the registry as `ord_<N>` when no
    // descriptor names that slot (pe-loader), so the arity has to be findable under
    // that spelling too — otherwise an ordinal-only import table (oleaut32, shlwapi)
    // is unbindable however complete the named list is.
    const withOrdinals: Export[] = [];
    for (const f of fns) {
        withOrdinals.push({ name: f.name, argCount: f.argCount, note: f.note });
        if (f.ordinal !== undefined) withOrdinals.push({ name: `ord_${f.ordinal}`, argCount: f.argCount, note: f.note });
    }

    // Keep the import-name spelling: the registry keys modules by the name in the PE
    // import table (`winspool.drv`), stripping only `.dll`. Folding `.drv` away here
    // put the arities under a key no import ever asks for.
    const moduleName = dll.replace(/\.dll$/i, "");
    const payload = {
        source: "wine .spec (arity only)",
        generated: new Date().toISOString(),
        module: moduleName,
        functions: withOrdinals.sort((a, b) => a.name.localeCompare(b.name)),
    };
    const outDir = join(OUT_ROOT, moduleName);
    if (!dry) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${moduleName}.wine.sig.json`), JSON.stringify(payload, null, 2) + "\n");
    }
    totalDlls++; totalFns += withOrdinals.length;
    console.log(`  ${moduleName.padEnd(14)} ${String(fns.length).padStart(5)} stdcall exports (+${withOrdinals.length - fns.length} ordinal aliases)`);
}

if (missing.length) console.log(`\nno spec for: ${missing.join(", ")}`);
console.log(`\n${dry ? "[dry] " : ""}${totalFns} arities across ${totalDlls} modules -> tools/reference/win32/*/**.wine.sig.json`);
console.log(`Next: bun tools/generate-reference-argcounts.ts`);
