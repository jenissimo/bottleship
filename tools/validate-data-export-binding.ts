#!/usr/bin/env bun

/**
 * Quality-gate check: an HLE export has ONE address, and one place decides it.
 *
 * Since HLE modules got real PE images, an export can exist twice — as a call stub in
 * the module's image and as an address registered through `registerDataExport`. Windows
 * has a single address per export, so both the IAT the PE loader writes and the answer
 * GetProcAddress gives must come from the same decision. `hleExportBindingAddress`
 * (core/thunking/export-resolver.ts) IS that decision; a second consumer reading
 * `hleImageExportAddress` directly is how the two silently diverge — that shipped, and
 * it bound msvcrt's `_EH_prolog` to a call stub, which returns normally where the real
 * body rewrites its caller's frame, so the guest CRT unwound into nothing.
 *
 * Two checks:
 *   1. OWNERSHIP (hard): `hleImageExportAddress` is referenced only by its own module and
 *      by the owner of the precedence. Same shape as guest-code.ts's chokepoint.
 *   2. CENSUS (pinned): exports declared BOTH in a module's API descriptor and through
 *      `registerDataExport`. Being on this list is NOT a bug — the data export wins by
 *      construction — but a NEW one is a decision to acknowledge: the image's call stub
 *      must be wrong for that name (a variable, a vtable, or native x86 that calls back
 *      into the guest), not merely a second address. The descriptors are IMPORTED, not
 *      grepped, so a table that inherits another's (`...msvcrtModule.functions`) counts.
 *
 * Usage: bun tools/validate-data-export-binding.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const rel = (f: string) => relative(ROOT, f).split("/").join(sep);

/** Files allowed to read an image export address directly (check 1). */
const IMAGE_EXPORT_OWNERS = new Set([
    join("src", "worker", "core", "hle-module-images.ts"),
    join("src", "worker", "core", "thunking", "export-resolver.ts"),
]);

/**
 * Exports declared both ways, `dll:name` lowercased. The sharp ones — where the image's
 * call stub is not just a second address but wrong behaviour — are marked; the rest are
 * plain variables, where only the address is wrong.
 */
const PINNED_DOUBLE_DECLARED = new Set([
    "msvcrt:_eh_prolog",       // SHARP: rewrites the CALLER's frame (FS:[0], EBP, return address)
    "msvcrt:qsort",            // SHARP: native x86, calls the guest comparator
    "msvcrt:bsearch",          // SHARP: native x86, calls the guest comparator
    "msvcr90:qsort",           // SHARP
    "msvcr90:bsearch",         // SHARP
    "crtdll:qsort",            // SHARP
    "msvcrt:_acmdln",
    "msvcrt:_adjust_fdiv",
    "crtdll:_adjust_fdiv",
    "msvcrt:_iob",
    "msvcrt:_environ",
    "msvcrt:__environ",
    "msvcrt:_environ_dll",
    "msvcrt:_mbctype",
    "msvcrt:__pioinfo",
    "msvcrt:__badioinfo",
    "msvcp60:?npos@?$basic_string@du?$char_traits@d@std@@v?$allocator@d@2@@std@@2ib",
    "msvcp60:?_c@?1??_nullstr@?$basic_string@du?$char_traits@d@std@@v?$allocator@d@2@@std@@capbdxz@4db",
    "msvcp60:??_7out_of_range@std@@6b@",
    "msvcp60:??_7runtime_error@std@@6b@",
    "msvcp60:??_7logic_error@std@@6b@",
]);

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (entry.endsWith(".ts")) yield full;
    }
}

const errors: string[] = [];

// ---- 1. Ownership of the image-export lookup -------------------------------------
for (const file of walk(join(ROOT, "src"))) {
    const path = rel(file);
    if (IMAGE_EXPORT_OWNERS.has(path)) continue;
    const text = readFileSync(file, "utf8");
    if (/\bhleImageExportAddress\b/.test(text)) {
        errors.push(
            `${path}: reads hleImageExportAddress directly. The address an export is bound to is ` +
            `decided once, by hleExportBindingAddress (core/thunking/export-resolver.ts) — call that, ` +
            `or a data export loses to the image's call stub here while GetProcAddress still answers ` +
            `the data address.`);
    }
}

// ---- 2. Census of double-declared exports ----------------------------------------
/** `registerDataExport(<dll>, <name>, …)` with both arguments resolved to strings. */
const CALL = /registerDataExport\s*\??\.?\s*\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,/g;

/** Resolve the literal forms these call sites actually use, or undefined. */
function resolveArg(raw: string, consts: Map<string, string>, moduleName: string | undefined): string | undefined {
    const arg = raw.trim();
    const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(arg);
    if (quoted) return quoted[1] ?? quoted[2];
    if (arg === "this.name") return moduleName;
    if (arg.startsWith("`") && arg.endsWith("`")) {
        const body = arg.slice(1, -1);
        let out = "";
        for (let i = 0; i < body.length;) {
            if (body.startsWith("${", i)) {
                const end = body.indexOf("}", i);
                if (end < 0) return undefined;
                const value = consts.get(body.slice(i + 2, end).trim());
                if (value === undefined) return undefined;
                out += value; i = end + 1;
            } else { out += body[i++]; }
        }
        return out;
    }
    return undefined;
}

const registered = new Set<string>();
const unresolved: string[] = [];
for (const file of walk(join(ROOT, "src", "worker"))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("registerDataExport")) continue;
    // File-level string consts and a module class's `name = "x"`, the two things these
    // call sites interpolate.
    const consts = new Map<string, string>();
    for (const m of text.matchAll(/^\s*(?:const|readonly)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*"([^"]*)"/gm)) {
        consts.set(m[1], m[2]);
    }
    const moduleName = /^\s*(?:readonly\s+)?name\s*(?::\s*string\s*)?=\s*"([^"]*)"/m.exec(text)?.[1];
    for (const m of text.matchAll(CALL)) {
        if (/^\s*dllName\s*:/.test(m[1])) continue; // the declaration in thunk-generator.ts
        const dll = resolveArg(m[1], consts, moduleName);
        const name = resolveArg(m[2], consts, moduleName);
        if (dll === undefined || name === undefined) {
            unresolved.push(`${rel(file)}: registerDataExport(${m[1].trim()}, ${m[2].trim()}, …)`);
            continue;
        }
        registered.add(`${dll.toLowerCase()}:${name.toLowerCase()}`);
    }
}

// Descriptors are imported so an inherited table (`...msvcrtModule.functions`) resolves.
const apiDir = join(ROOT, "src", "worker", "api");
const declared = new Map<string, Set<string>>();
for (const entry of readdirSync(apiDir)) {
    if (!entry.endsWith(".api.ts")) continue;
    const mod = await import(join(apiDir, entry));
    for (const value of Object.values(mod) as any[]) {
        if (!value || typeof value !== "object") continue;
        if (typeof value.name !== "string" || !Array.isArray(value.functions)) continue;
        const key = value.name.toLowerCase();
        const set = declared.get(key) ?? new Set<string>();
        declared.set(key, set);
        for (const fn of value.functions) if (fn?.name) set.add(String(fn.name).toLowerCase());
    }
}

const doubleDeclared = new Set<string>();
for (const key of registered) {
    const colon = key.indexOf(":");
    const dll = key.slice(0, colon);
    const name = key.slice(colon + 1);
    if (declared.get(dll)?.has(name)) doubleDeclared.add(key);
}

for (const key of doubleDeclared) {
    if (PINNED_DOUBLE_DECLARED.has(key)) continue;
    errors.push(
        `${key}: declared both in the API descriptor and through registerDataExport. The data ` +
        `export wins at binding time, so the image's call stub for it is never used — confirm ` +
        `that is what you want (it is, if the real export is a variable, a vtable, or native x86 ` +
        `that calls back into the guest) and add it to PINNED_DOUBLE_DECLARED in this tool.`);
}
for (const key of PINNED_DOUBLE_DECLARED) {
    if (!doubleDeclared.has(key)) {
        errors.push(
            `${key}: pinned as double-declared, but is no longer. Remove it from ` +
            `PINNED_DOUBLE_DECLARED so the list keeps meaning what it says.`);
    }
}

if (unresolved.length > 0) {
    console.log(
        `[data-export-binding] ${unresolved.length} registerDataExport call site(s) with arguments ` +
        `this check cannot resolve — the census below is a lower bound:\n  ` + unresolved.join("\n  "));
}

if (errors.length > 0) {
    console.error(`\n[data-export-binding] ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
}

console.log(
    `[data-export-binding] OK — image-export lookups stay behind hleExportBindingAddress; ` +
    `${doubleDeclared.size} export(s) declared both ways, all pinned.`);
