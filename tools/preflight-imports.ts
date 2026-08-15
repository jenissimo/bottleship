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
import { spawnSync } from "child_process";
import { parsePeImports, isPeImage } from "../packages/formats/src/pe";

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
 * folding them in would let a missing export read as bindable.
 */
function exportNames(text: string): string[] {
    const helpers = new Set<string>(["makeFunc"]);
    for (const m of text.matchAll(DESCRIPTOR_HELPER)) helpers.add(m[1]);
    helpers.delete("makeMethod");

    const names: string[] = [];
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\(\s*"([^"]+)"/g)) {
        if (helpers.has(m[1])) names.push(m[2]);
    }
    return names;
}

/** Names the thunk generator can size, per HLE module. */
function loadKnownNames(): ArityTables {
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
        const text = readFileSync(file, "utf8");
        // The MODULE descriptor's own `name:` is authoritative — the filename drifts from it
        // (kernel32-vista-supplement.ts, msvcp60.api.ts → "msvcp60"). Anchor on the
        // `: ModuleDescriptor = {` declaration: a bare `name:\s*"..."` search finds whichever
        // literal comes first in the file, and a module that declares an ordinal table above
        // its descriptor (ws2_32's `{ name: "ord_1", ... }`) then gets filed under "ord_1" —
        // so every one of its imports is treated as "no HLE module" and silently reported
        // bindable. This tool exists to fail loudly; keep it anchored.
        const declared =
            /ModuleDescriptor\s*=\s*\{[^}]*?name:\s*"([^"]+)"/.exec(text)?.[1];
        const mod = declared ?? basename(file).replace(/\.api\.ts$/, "");
        descriptorDlls.add(mod.toLowerCase());
        for (const name of exportNames(text)) add(mod, name);
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

/** (name, bytes) for every PE in a .wgb, read through our own container tool. */
function* peFilesFromWgb(archive: string): Generator<[string, Uint8Array]> {
    const list = spawnSync("bun", [join(REPO, "tools", "wgb.ts"), "list", archive], {
        encoding: "utf8",
        maxBuffer: 1 << 28,
    });
    if (list.status !== 0) throw new Error(`wgb list failed: ${list.stderr}`);
    for (const line of list.stdout.split("\n")) {
        const entry = line.trim().split(/\s+/).slice(1).join(" ");
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

function main(): void {
    const args = process.argv.slice(2);
    const dllAt = args.indexOf("--dll");
    // --dll takes a value, so its operand is not the target. Absent, indexOf is -1 and
    // the exclusion would land on index 0 — the sole positional in the documented form.
    const target = args.find((a, i) => !a.startsWith("--") && (dllAt < 0 || i !== dllAt + 1));
    if (!target) {
        console.error("usage: bun tools/preflight-imports.ts <bundle.wgb | directory> [--json] [--dll <name>]");
        process.exit(2);
    }
    const asJson = args.includes("--json");
    const dllFilter = args[args.indexOf("--dll") + 1];
    const onlyDll = args.includes("--dll") ? dllFilter?.toLowerCase() : undefined;

    const tables = loadKnownNames();
    const findings = new Map<string, Finding>();
    let scanned = 0;

    const isArchive = statSync(target).isFile();
    const source = isArchive ? peFilesFromWgb(resolve(target)) : peFilesFromDir(resolve(target));

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
            const mod = dll.dll.toLowerCase().replace(/\.dll$/, "");
            if (onlyDll && mod !== onlyDll) continue;
            // No HLE module for this DLL — it loads as real guest code from the VFS.
            if (!tables.byDll.has(mod)) continue;
            for (const entry of dll.entries) {
                if (!entry.name) continue;
                const mismatch = wrongArityVariant(tables, mod, entry.name);
                if (!mismatch && isBindable(tables, mod, entry.name)) continue;
                const key = `${mod}!${entry.name}`;
                let f = findings.get(key);
                if (!f) {
                    findings.set(key, (f = {
                        dll: mod, func: entry.name, importers: new Set(),
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

main();
