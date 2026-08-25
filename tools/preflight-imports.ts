#!/usr/bin/env bun
/**
 * preflight-imports: which imports of a game's PEs can we NOT bind yet?
 *
 * The ThunkGenerator refuses to emit a stdcall stub whose argument count it cannot
 * derive, and that refusal fails the WHOLE PE load — one missing name takes the
 * process down at boot with "Stub requires argCount or stackCleanupBytes". Found
 * one boot at a time, that is a reload per name; found here, it is one pass over
 * the bundle.
 *
 * "Bindable" is decided by replaying APIRegistry.getArgCount's resolution chain
 * against the same two sources it reads — `*.api.ts` descriptors and the generated
 * win32 reference. Replaying it matters: the chain ends in parsing `@N` off the
 * decorated import name, so a table that lists only `AIL_open_filter` still binds
 * `_AIL_open_filter@8`, and a preflight that merely diffed name sets would report
 * dozens of failures that never happen. Keep `resolveArity` in step with
 * `src/worker/core/api-registry.ts` — the registry cannot be imported here (it
 * resolves its descriptors through Vite's `import.meta.glob`).
 *
 * DLLs we have no HLE module for are skipped: those load from the VFS as real code,
 * so their imports are the guest's problem, not ours.
 *
 * Usage:
 *   bun tools/preflight-imports.ts <bundle.wgb | directory> [--json] [--dll kernel32]
 *
 * Exit 1 when anything is unbindable, so it can gate a bring-up attempt.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve, basename, extname } from "path";
import { pathToFileURL } from "url";
import { spawnSync } from "child_process";
import { parsePeImports, isPeImage } from "../packages/formats/src/pe";
import { resolveThunkedDllAlias } from "../src/worker/core/dll-aliases";

const REPO = resolve(import.meta.dir, "..");

interface Finding {
    dll: string;
    func: string;
    importers: Set<string>;
    /** Set when the name binds, but to a DIFFERENT @N than the import carries. */
    wrongArity?: string;
}

interface ArityTables {
    /** dll -> exact export names, lowercased exactly as the descriptor spells them. */
    byDll: Map<string, Set<string>>;
    /** DLLs that have an *.api.ts descriptor — the set getArgCount's cross-module step walks. */
    descriptorDlls: Set<string>;
}

/**
 * Local helpers that BUILD a FunctionDescriptor, found by their return annotation:
 * `const gl = (...): FunctionDescriptor => ({...})`. Every .api.ts declares its own,
 * so the set is per-file. The inner `(?!=>|const)` keeps the scan inside one
 * signature — without it a `ParameterDescriptor` helper would bind to the next
 * FunctionDescriptor helper's annotation.
 */
const DESCRIPTOR_HELPER = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\((?:(?!=>|\bconst\b)[\s\S])*?\)\s*:\s*FunctionDescriptor\s*=>/g;

/**
 * Every export name a descriptor declares, whichever helper spells it. Grepping one
 * helper by name (`makeFunc`) misses the rest — a `makeThiscall`/`makeCdecl`/`gl`
 * entry is just as bindable, and reporting it unbindable sends you implementing an
 * API that already exists.
 *
 * Recognised helpers are WHITELISTED, not "any call with a string first argument":
 * the parameter helpers (`u("dwFlags")`, `p("lpName")`, …) share that shape, and
 * folding a parameter name into the export set is how this tool would silently stop
 * reporting a genuinely missing export. Failing to recognise a helper only
 * over-reports, which is visible; the reverse is not.
 *
 * File-wide, not `functions:`-sliced: descriptors build that array from spreads
 * of tables declared above it (comctl32's `...imageListFuncs`), so a slice loses
 * exactly the entries a module keeps in named groups.
 *
 * `makeMethod` is excluded — those are COM vtable slots, not DLL exports, and
 * folding them in would let a missing export read as bindable. Inline literals get
 * the same exclusion by POSITION (see below), since shape alone cannot tell a method
 * literal from an export literal.
 */
function exportNames(text: string): string[] {
    const helpers = new Set<string>(["makeFunc"]);
    for (const m of text.matchAll(DESCRIPTOR_HELPER)) helpers.add(m[1]);
    helpers.delete("makeMethod");

    const names: string[] = [];
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\(\s*"([^"]+)"/g)) {
        if (helpers.has(m[1])) names.push(m[2]);
    }
    // Inline literals must be sliced to `functions:` even though the helper sweep above
    // is not: a COM method written out as a literal is the same SHAPE as an export
    // literal, so only position separates them. File-wide, this folded all 55 of d3d9's
    // vtable slots into the export set — Present, LockRect, SetTexture — and a missing
    // export whose name collides with a method would then read as bindable.
    const exportArrays = bracketSpans(text, /\bfunctions\s*:\s*\[/g);
    for (const m of text.matchAll(/\{\s*name:\s*"([^"]+)"\s*,\s*params:\s*\[/g)) {
        const at = m.index ?? 0;
        if (exportArrays.some(([from, to]) => at >= from && at < to)) names.push(m[1]);
    }
    return names;
}

/** Byte ranges of each array opened by `opener`, matched by bracket depth so nested
 *  arrays cannot end a span early. */
function bracketSpans(text: string, opener: RegExp): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    for (const m of text.matchAll(opener)) {
        const start = (m.index ?? 0) + m[0].length - 1;
        let depth = 0;
        let i = start;
        for (; i < text.length; i++) {
            const c = text[i];
            if (c === "[") depth++;
            else if (c === "]" && --depth === 0) break;
        }
        spans.push([start, i]);
    }
    return spans;
}

/** Names the thunk generator can size, per HLE module. */
async function loadKnownNames(): Promise<ArityTables> {
    const known = new Map<string, Set<string>>();
    const descriptorDlls = new Set<string>();
    const add = (mod: string, name: string) => {
        const key = mod.toLowerCase();
        let set = known.get(key);
        if (!set) known.set(key, (set = new Set()));
        set.add(name.toLowerCase());
    };

    const apiDir = join(REPO, "src", "worker", "api");
    for (const file of walk(apiDir)) {
        if (!file.endsWith(".api.ts")) continue;
        // Import the descriptor itself instead of approximating TypeScript with regexes.
        // This covers direct object literals (d3d9), generated/spread ordinal tables
        // (ws2_32/wsock32), and filename/name drift with the exact runtime values.
        try {
            const namespace = await import(pathToFileURL(file).href);
            for (const value of Object.values(namespace)) {
                const descriptor = value as { name?: unknown; functions?: unknown };
                if (typeof descriptor?.name !== "string" || !Array.isArray(descriptor.functions)) continue;
                const mod = descriptor.name.toLowerCase();
                descriptorDlls.add(mod);
                for (const fn of descriptor.functions as Array<{ name?: unknown; ordinal?: unknown }>) {
                    if (typeof fn.name === "string") add(mod, fn.name);
                    if (typeof fn.ordinal === "number") add(mod, `ord_${fn.ordinal}`);
                }
            }
        } catch (error) {
            // A few descriptors import runtime constants whose modules are not safe to
            // evaluate under Bun outside Vite. Retain a conservative static fallback —
            // announced, because it sees less than the import does and its blind spots
            // surface later as false "unbindable" rows for exactly this module.
            console.error(`[preflight] WARN: could not import ${basename(file)}, falling back to static scan`
                + ` — ${error instanceof Error ? error.message : String(error)}`);
            const text = readFileSync(file, "utf8");
            // Anchor on the `: ModuleDescriptor = {` declaration: a bare `name:\s*"..."`
            // search finds whichever literal comes first, and a module that declares an
            // ordinal table above its descriptor (ws2_32's `{ name: "ord_1", ... }`) then
            // gets filed under "ord_1" — every import of it would read as bindable.
            const declared = /ModuleDescriptor\s*=\s*\{[^}]*?name:\s*"([^"]+)"/.exec(text)?.[1]
                ?? basename(file).replace(/\.api\.ts$/, "");
            descriptorDlls.add(declared.toLowerCase());
            for (const name of exportNames(text)) add(declared, name);
            for (const m of text.matchAll(/\{\s*name:\s*"([^"]+)"\s*,\s*ordinal:\s*\d+\s*,\s*argCount:\s*\d+\s*\}/g)) {
                add(declared, m[1]);
            }
            // The import table exposes an import-by-ordinal as `ord_N`, which the descriptor
            // path adds from `fn.ordinal`. Without the same here, every ordinal import of a
            // module that degraded to this scan reads as unbindable — a false positive
            // affecting only the module that silently lost its descriptor. A numeric
            // `ordinal:` literal appears nowhere in a .api.ts but a descriptor entry (the
            // helpers spell it `ordinal: overrides.ordinal`), so a file-wide scrape is exact.
            for (const m of text.matchAll(/\bordinal:\s*(\d+)/g)) add(declared, `ord_${m[1]}`);
        }
    }

    // Data exports have no arity to know — the loader points the IAT straight at the
    // variable and never generates a stub, so they must not read as unbindable.
    for (const file of walk(join(REPO, "src", "worker", "modules"))) {
        if (!file.endsWith(".ts")) continue;
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/registerDataExport\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
            add(m[1], m[2]);
        }
    }

    for (const file of walk(join(REPO, "tools", "reference", "win32"))) {
        if (!file.endsWith(".json")) continue;
        const doc = JSON.parse(readFileSync(file, "utf8"));
        const mod = String(doc.module ?? basename(join(file, ".."))).toLowerCase();
        for (const fn of doc.functions ?? []) {
            // Reference names carry the stdcall decoration (_Foo@8); the import table does not.
            add(mod, String(fn.name).replace(/^_/, "").replace(/@\d+$/, ""));
        }
    }
    return { byDll: known, descriptorDlls };
}

/**
 * Mirror of APIRegistry.getArgCount: true when the generator could size this import.
 * The step numbering follows that function so the two stay comparable.
 */
function isBindable(tables: ArityTables, dll: string, name: string): boolean {
    const func = name.toLowerCase();
    const table = tables.byDll.get(dll);
    const decorated = /@\d+$/.test(func);

    // 1. exact
    if (table?.has(func)) return true;
    // 2. without the A/W suffix
    if (table?.has(func.replace(/[wa]$/, ""))) return true;

    if (!decorated) {
        // 2.5 / 2.6: single-variant base-name match, also under the MSS `_` prefix.
        // "Single" is what stops _AIL_pause_stream@4 and @8 collapsing into each other.
        for (const candidate of [func, `_${func}`]) {
            const variants = [...(table ?? [])].filter(n => n.replace(/@\d+$/, "") === candidate);
            if (variants.length === 1) return true;
        }
    }

    // 3. the same name under any other descriptor module (imprecise DLL names)
    for (const other of tables.descriptorDlls) {
        if (other !== dll && tables.byDll.get(other)?.has(func)) return true;
    }

    // 4. the decoration itself carries the byte count
    const at = /@(\d+)$/.exec(func);
    if (at) {
        const bytes = parseInt(at[1], 10);
        if (bytes >= 0 && bytes % 4 === 0) return true;
    }
    return false;
}

/**
 * A DECORATED import binds through the single-variant base-name fallback to a variant
 * whose @N differs — so it binds, with the wrong RET N. Returns the variant it would
 * pick, or null when there is no such hazard.
 *
 * This is the failure the "bindable" question alone cannot see: the stub exists, the PE
 * loads, and the ESP drift moves every local in the CALLER's frame, so the fault lands in
 * unrelated code with nothing pointing back. Gothic's Bink intro imported
 * `_BinkSetVolume@8` against a table declaring only `@12` and died four frames away in
 * ZenGin's file layer.
 */
function wrongArityVariant(tables: ArityTables, dll: string, name: string): string | null {
    const func = name.toLowerCase();
    const at = /@(\d+)$/.exec(func);
    if (!at) return null;
    const table = tables.byDll.get(dll);
    if (!table || table.has(func)) return null;                 // exact match wins
    const base = func.replace(/@\d+$/, "");
    const variants = [...table].filter(n => n.replace(/@\d+$/, "") === base && /@\d+$/.test(n));
    return variants.length === 1 ? variants[0] : null;
}

function* walk(dir: string): Generator<string> {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* walk(p);
        else yield p;
    }
}

// A PE is a PE whatever it is named. Mod loaders (.asi), DirectShow filters (.ax), control
// panels (.cpl), codecs (.acm/.drv) and COM servers (.ocx) all load as DLLs and all fail the
// same way on one unbindable import — filtering to .exe/.dll reports "all bindable" for a
// game whose plugins are the very things that break.
const PE_EXTENSIONS = new Set([".exe", ".dll", ".asi", ".ax", ".ocx", ".cpl", ".drv", ".acm", ".flt", ".mix", ".m3d"]);

function listWgbEntries(archive: string): string[] {
    const list = spawnSync("bun", [join(REPO, "tools", "wgb.ts"), "list", archive], {
        encoding: "utf8",
        maxBuffer: 1 << 28,
    });
    if (list.status !== 0) throw new Error(`wgb list failed: ${list.stderr}`);
    return list.stdout.split("\n")
        .map(line => line.trim().split(/\s+/).slice(1).join(" "))
        .filter(Boolean);
}

/** (name, bytes) for every PE in a .wgb, read through our own container tool. */
function* peFilesFromWgb(archive: string, entries = listWgbEntries(archive)): Generator<[string, Uint8Array]> {
    for (const entry of entries) {
        if (!PE_EXTENSIONS.has(extname(entry).toLowerCase())) continue;
        const cat = spawnSync("bun", [join(REPO, "tools", "wgb.ts"), "cat", archive, entry], {
            maxBuffer: 1 << 29,
        });
        if (cat.status !== 0) continue;
        yield [basename(entry), new Uint8Array(cat.stdout)];
    }
}

function* peFilesFromDir(dir: string): Generator<[string, Uint8Array]> {
    for (const file of walk(dir)) {
        if (!PE_EXTENSIONS.has(extname(file).toLowerCase())) continue;
        yield [basename(file), new Uint8Array(readFileSync(file))];
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const positional: string[] = [];
    let onlyDll: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--json") continue;
        if (arg === "--dll") {
            const value = args[++i];
            if (!value || value.startsWith("--")) {
                console.error("--dll requires a module name");
                process.exit(2);
            }
            onlyDll = value.toLowerCase();
            continue;
        }
        if (arg.startsWith("--")) {
            console.error(`unknown option: ${arg}`);
            process.exit(2);
        }
        positional.push(arg);
    }
    const target = positional[0];
    if (!target) {
        console.error("usage: bun tools/preflight-imports.ts <bundle.wgb | directory> [--json] [--dll <name>]");
        process.exit(2);
    }
    if (positional.length > 1) {
        console.error(`unexpected positional argument: ${positional[1]}`);
        process.exit(2);
    }
    const asJson = args.includes("--json");

    const tables = await loadKnownNames();
    const findings = new Map<string, Finding>();
    let scanned = 0;

    const isArchive = statSync(target).isFile();
    const resolvedTarget = resolve(target);
    const archiveEntries = isArchive ? listWgbEntries(resolvedTarget) : undefined;
    const source = isArchive
        ? peFilesFromWgb(resolvedTarget, archiveEntries)
        : peFilesFromDir(resolvedTarget);
    // An imported DLL with no HLE descriptor is safe to skip only when the bundle
    // actually carries that guest DLL. Otherwise the runtime must synthesize stubs
    // for its imports, and still needs exact stdcall arities (e.g. oledlg in Painkiller).
    const guestDlls = new Set((isArchive
        ? archiveEntries!
        : [...walk(resolvedTarget)])
        .filter(file => extname(file).toLowerCase() === ".dll")
        .map(file => basename(file, extname(file)).toLowerCase()));

    for (const [name, bytes] of source) {
        if (!isPeImage(bytes)) continue;
        let imports;
        try {
            imports = parsePeImports(bytes);
        } catch {
            continue;
        }
        scanned++;
        for (const dll of imports.dlls) {
            const importedMod = dll.dll.toLowerCase().replace(/\.dll$/, "");
            const mod = resolveThunkedDllAlias(importedMod);
            if (onlyDll && importedMod !== onlyDll && mod !== onlyDll) continue;
            const hasDescriptor = tables.byDll.has(mod);
            if (!hasDescriptor && guestDlls.has(importedMod)) continue;
            for (const entry of dll.entries) {
                // The runtime exposes import-by-ordinal entries as `ord_N`; skipping
                // them makes preflight claim a bundle is clean, then the real loader
                // dies on the first unknown ordinal (Painkiller: oleaut32 ordinal 150).
                const func = entry.name ?? (entry.ordinal === undefined ? undefined : `ord_${entry.ordinal}`);
                if (!func) continue;
                const mismatch = hasDescriptor ? wrongArityVariant(tables, mod, func) : null;
                if (!mismatch && hasDescriptor && isBindable(tables, mod, func)) continue;
                const key = `${importedMod}!${func}`;
                let f = findings.get(key);
                if (!f) {
                    findings.set(key, (f = {
                        dll: importedMod, func, importers: new Set(),
                        wrongArity: mismatch ?? undefined,
                    }));
                }
                f.importers.add(name);
            }
        }
    }

    const rows = [...findings.values()].sort((a, b) =>
        a.dll === b.dll ? a.func.localeCompare(b.func) : a.dll.localeCompare(b.dll));

    if (asJson) {
        console.log(JSON.stringify({
            scanned,
            missing: rows.map(r => ({
                dll: r.dll, func: r.func, wrongArity: r.wrongArity ?? null,
                importers: [...r.importers].sort(),
            })),
        }, null, 2));
    } else {
        console.log(`scanned ${scanned} PE image(s) in ${target}`);
        if (rows.length === 0) {
            console.log("every import of every HLE'd DLL is bindable");
        } else {
            let current = "";
            for (const r of rows) {
                if (r.dll !== current) {
                    current = r.dll;
                    console.log(`\n${current}:`);
                }
                const why = r.wrongArity ? `WRONG ARITY: binds to ${r.wrongArity}` : "unbindable";
                console.log(`  ${r.func.padEnd(38)} ${why.padEnd(36)} <- ${[...r.importers].sort().join(", ")}`);
            }
            const unbindable = rows.filter(r => !r.wrongArity).length;
            const skewed = rows.length - unbindable;
            if (unbindable) {
                console.log(`\n${unbindable} unbindable import(s) — each one fails the importing PE's load.`);
            }
            if (skewed) {
                console.log(`${skewed} arity mismatch(es) — these DO bind, with the wrong RET N. The`
                    + ` caller's stack drifts and the fault surfaces in unrelated code.`);
            }
        }
    }
    process.exit(rows.length === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
