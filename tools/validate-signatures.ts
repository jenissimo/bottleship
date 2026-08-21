#!/usr/bin/env bun

/**
 * Unified Signature Validation CLI Tool
 * 
 * Validates API descriptors against:
 * 1. Their implementations (API/Implementation validation)
 * 2. Reference signatures from header files (Reference validation)
 * 
 * Supports both COM interfaces (DirectX) and regular functions (MSS32, etc.)
 */

import { validateSignatures, SignatureValidator } from '../src/worker/tools/signature-validator';
import { validateReferenceSignatures } from '../src/worker/tools/reference-validator';
import { REFERENCE_ARG_COUNTS } from '../src/worker/reference-argcounts.generated';
import { ApiCoverageIndex } from '../src/worker/tools/api-coverage';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Reference entries we have verified to be WRONG or version-ambiguous, so a descriptor
 * disagreeing with them proves nothing. Keyed `module:normalizedName`; the value is why.
 *
 * Every one of these was checked against the real API before being listed — the
 * generated reference is parsed out of headers and that parse can drop or invent a
 * parameter. Adding a name here is claiming "we checked, our side is right"; it is not
 * a way to quiet a fresh failure.
 */
const REFERENCE_KNOWN_WRONG: Record<string, string> = {
    // msacm.h parse lost/gained one parameter. Real signatures:
    //   acmFormatDetails(had, pafd, fdwDetails) = 3
    //   acmFormatTagEnum(had, patd, callback, dwInstance, fdwEnum) = 5
    // The reference says 4 for both, self-consistently (its @16 matches its own parse), so
    // no mechanical rule can see it — only checking against the real header can.
    'msacm32:acmformatdetailsa': 'reference mis-parse: real acmFormatDetailsA takes 3',
    'msacm32:acmformatdetailsw': 'reference mis-parse: real acmFormatDetailsW takes 3',
    'msacm32:acmfilterdetailsa': 'reference mis-parse: real acmFilterDetailsA takes 3',
    'msacm32:acmfilterdetailsw': 'reference mis-parse: real acmFilterDetailsW takes 3',
    'msacm32:acmformattagenuma': 'reference mis-parse: real acmFormatTagEnumA takes 5',
    'msacm32:acmformattagenumw': 'reference mis-parse: real acmFormatTagEnumW takes 5',
    'msacm32:acmfiltertagenuma': 'reference mis-parse: real acmFilterTagEnumA takes 5',
    'msacm32:acmfiltertagenumw': 'reference mis-parse: real acmFilterTagEnumW takes 5',
};

interface ArityFinding {
    module: string;
    func: string;
    message: string;
}

interface RefEntry {
    argCount: number;
    /** Why this entry cannot settle a disagreement; trusted entries have none. */
    distrust?: string;
}

/**
 * Trusted argument counts per module, read from the same `*.sig.json` the generated
 * reference map is built from — the raw files carry the fields that decide whether an
 * entry can be believed, which the flattened map has already thrown away:
 *
 *  - `note` marks an entry the author already knew was version-dependent (Miles).
 *  - the entry's own `@N` decoration must agree with its `argCount`.
 *  - the parsed `signature`'s parameter count must agree too — `UINT GetDpiForSystem(VOID)`
 *    with argCount 1 is the parse being wrong about itself, and a trailing `...` means
 *    varargs, whose slot count is a caller property and not comparable at all.
 *  - two entries that differ only in decoration (`_AIL_file_read@8` and `@12`) collapse to
 *    one key: the pair is ambiguous, so neither can be used.
 *
 * Everything that survives those is a source we are willing to fail the gate on.
 */
function loadTrustedReference(referenceDir: string): Map<string, Map<string, RefEntry>> {
    const byModule = new Map<string, Map<string, RefEntry>>();
    const win32Dir = path.join(referenceDir, 'win32');
    if (!fs.existsSync(win32Dir)) return byModule;

    const paramCount = (signature: unknown): number | null => {
        if (typeof signature !== 'string') return null;
        const open = signature.indexOf('(');
        const close = signature.lastIndexOf(')');
        if (open < 0 || close < open) return null;
        const inner = signature.slice(open + 1, close).trim();
        if (inner === '' || /^void$/i.test(inner)) return 0;
        if (inner.endsWith('...')) return -1; // varargs
        return inner.split(',').length;
    };

    for (const dir of fs.readdirSync(win32Dir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const file of fs.readdirSync(path.join(win32Dir, dir.name))) {
            if (!file.endsWith('.sig.json')) continue;
            const doc = JSON.parse(fs.readFileSync(path.join(win32Dir, dir.name, file), 'utf-8'));
            const moduleName = String(doc.module ?? dir.name).toLowerCase().replace(/\.dll$/, '');
            if (!Array.isArray(doc.functions)) continue;
            let table = byModule.get(moduleName);
            if (!table) byModule.set(moduleName, (table = new Map()));

            for (const fn of doc.functions) {
                if (typeof fn?.argCount !== 'number' || typeof fn?.name !== 'string') continue;
                const key = fn.name.replace(/^[_@]+/, '').replace(/@\d+$/, '').toLowerCase();
                let distrust: string | undefined;
                if (fn.note) distrust = `the reference entry itself notes: ${fn.note}`;
                const decorated = /@(\d+)$/.exec(fn.name);
                if (!distrust && decorated && parseInt(decorated[1], 10) / 4 !== fn.argCount) {
                    distrust = `reference entry is self-inconsistent (${fn.name} vs argCount ${fn.argCount})`;
                }
                const params = paramCount(fn.signature);
                if (!distrust && params === -1) distrust = 'varargs — the slot count is the caller\'s, not the callee\'s';
                if (!distrust && params !== null && params !== fn.argCount) {
                    distrust = `reference entry is self-inconsistent (signature has ${params} parameters, argCount ${fn.argCount})`;
                }
                const known = REFERENCE_KNOWN_WRONG[`${moduleName}:${key}`];
                if (!distrust && known) distrust = known;

                const existing = table.get(key);
                if (existing && existing.argCount !== fn.argCount) {
                    // Same name, two decorations, two counts — the reference cannot say which.
                    table.set(key, { argCount: fn.argCount, distrust: 'the reference declares more than one arity for this name' });
                    continue;
                }
                if (existing?.distrust) continue;
                table.set(key, { argCount: fn.argCount, distrust });
            }
        }
    }
    return byModule;
}

/** Descriptor entries that pin RET N explicitly, decoupling it from the decorated name. */
function namesWithExplicitCleanup(apiText: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of apiText.matchAll(/\(\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*\{([^}]*)\}/g)) {
        const cleanup = /stackCleanupBytes:\s*(\d+)/.exec(m[3]);
        if (cleanup) out.set(m[1], parseInt(cleanup[1], 10));
    }
    return out;
}

/**
 * Argument counts are the field most likely to be wrong in a new descriptor and the most
 * expensive to get wrong: argCount drives the thunk's RET N, so an off-by-one misaligns
 * the guest's ESP and corrupts the caller's frame far from the call. The API/Implementation
 * pass cannot see it at all — a handler spelled `() => FALSE` has no arity to compare
 * against — so a module of pure stubs used to PASS with its arities entirely unchecked.
 *
 * Two independent cross-checks, both of which can only ERROR on a provable mismatch:
 *   1. the name's own stdcall decoration (`_Foo@16` ⇒ 4 slots) — the linker computed it,
 *      so a descriptor that disagrees with itself is wrong with no external source needed;
 *   2. the generated win32 reference, for the functions it knows.
 * Anything the two sources cannot decide is reported as UNVERIFIED coverage, not as a
 * pass: the per-module counts below are what says how much of the green is real.
 */
function validateArgCounts(apiDir: string, referenceDir: string, only: string | null): boolean {
    const validator = new SignatureValidator();
    const errors: ArityFinding[] = [];
    const skipped: ArityFinding[] = [];
    const coverage: Array<{ module: string; checked: number; total: number }> = [];
    let totalFuncs = 0;
    let totalChecked = 0;

    const trusted = loadTrustedReference(referenceDir);
    // The generated map is what the runtime resolves against; if the raw files it comes
    // from have gone missing, this check would silently verify nothing.
    if (trusted.size < Object.keys(REFERENCE_ARG_COUNTS).length) {
        console.error(`\x1b[31m✗ reference signatures missing:\x1b[0m read ${trusted.size} module(s) from `
            + `${referenceDir}, but the generated map has ${Object.keys(REFERENCE_ARG_COUNTS).length}.`);
        return false;
    }

    const files = fs.readdirSync(apiDir)
        .filter(f => f.endsWith('.api.ts'))
        .filter(f => !only || f === `${only}.api.ts`)
        .sort();

    for (const file of files) {
        const moduleName = file.replace(/\.api\.ts$/, '').toLowerCase();
        const apiFile = path.join(apiDir, file);
        const apiText = fs.readFileSync(apiFile, 'utf-8');
        // DLL exports only: COM vtable methods are not in the reference and carry no
        // decoration, so folding them in would only dilute the coverage number.
        const functions = validator.extractApiFunctions(apiFile, apiText, { modulesOnly: true });
        const reference = trusted.get(moduleName);
        const explicitCleanup = namesWithExplicitCleanup(apiText);
        // Arities the module's own DECORATED spellings claim, per base name. A descriptor
        // that declares both `AIL_stream_info` and `_AIL_stream_info@20` is describing a
        // multi-ABI export, and its decorated twin — not a reference entry written against
        // some other version of the library — is what the undecorated one must match.
        const decoratedSiblings = new Map<string, Set<number>>();
        for (const [n, c] of Object.entries(functions)) {
            const d = /@(\d+)$/.exec(n);
            if (!d) continue;
            const base = n.replace(/^[_@]+/, '').replace(/@\d+$/, '').toLowerCase();
            let set = decoratedSiblings.get(base);
            if (!set) decoratedSiblings.set(base, (set = new Set()));
            set.add(c);
        }

        let checked = 0;
        let total = 0;
        for (const [name, argCount] of Object.entries(functions)) {
            total++;
            let verified = false;

            // 1. The decoration is the byte count the real linker emitted, so it settles
            //    the arity for THIS import name with no external source — including which
            //    version of a multi-ABI export (Bink, Miles) the descriptor is describing.
            const decorated = /@(\d+)$/.exec(name);
            const cleanup = explicitCleanup.get(name);
            if (decorated && cleanup === undefined) {
                const bytes = parseInt(decorated[1], 10);
                verified = true;
                if (bytes % 4 !== 0) {
                    errors.push({ module: moduleName, func: name,
                        message: `decorated name says ${bytes} bytes, which is not a whole number of 32-bit slots` });
                } else if (bytes / 4 !== argCount) {
                    errors.push({ module: moduleName, func: name,
                        message: `argCount ${argCount} contradicts the name's own decoration @${bytes} (${bytes / 4} args) — RET N would be wrong` });
                }
            } else if (cleanup !== undefined) {
                // An explicit stackCleanupBytes deliberately overrides the decoration (a
                // wrapper DLL whose exported name lies about its ABI). It must still agree
                // with the arity the marshaller uses to read the arguments.
                verified = true;
                if (cleanup !== argCount * 4) {
                    errors.push({ module: moduleName, func: name,
                        message: `stackCleanupBytes ${cleanup} does not match argCount ${argCount} (${argCount * 4} bytes)` });
                }
            }

            // 2. The win32 reference, for the names it knows and can be believed about.
            //    Skipped once the decoration has spoken: the two disagree exactly where the
            //    real export has several ABIs, and there the decorated name is the truth.
            const key = name.replace(/^[_@]+/, '').replace(/@\d+$/, '').toLowerCase();
            const siblings = decorated ? undefined : decoratedSiblings.get(key);
            if (siblings) {
                // Verified against our own decorated spelling when it agrees; when it does
                // not, the module is deliberately carrying two ABIs and no source here can
                // say which one the undecorated name is for.
                if (siblings.has(argCount)) verified = true;
                else skipped.push({ module: moduleName, func: name,
                    message: `multi-ABI export: decorated spellings declare ${[...siblings].join('/')} args, this one ${argCount}` });
            }

            const ref = reference?.get(key);
            if (ref && !verified && !siblings) {
                if (ref.distrust) {
                    if (ref.argCount !== argCount) {
                        skipped.push({ module: moduleName, func: name, message: ref.distrust });
                    }
                } else {
                    verified = true;
                    if (ref.argCount !== argCount) {
                        errors.push({ module: moduleName, func: name,
                            message: `argCount ${argCount} but the win32 reference says ${ref.argCount} — one of them makes RET N wrong` });
                    }
                }
            }

            if (verified) checked++;
        }

        if (total > 0) {
            coverage.push({ module: moduleName, checked, total });
            totalFuncs += total;
            totalChecked += checked;
        }
    }

    console.log('Validating descriptor argument counts...\n');
    const unverified = coverage.filter(c => c.checked < c.total)
        .sort((a, b) => (b.total - b.checked) - (a.total - a.checked));
    console.log(`  Cross-checked ${totalChecked}/${totalFuncs} declared exports `
        + `(decoration + win32 reference; ${trusted.size} modules have a reference).`);
    if (unverified.length > 0) {
        // Listed in FULL, not truncated: this is the part of the green that is not backed
        // by anything, and a module hidden behind "+N more" reads as covered.
        const list = unverified.map(c => `${c.module} ${c.checked}/${c.total}`).join(', ');
        console.log(`  \x1b[33mUNVERIFIED arities\x1b[0m — no reference entry and no decoration to check against,`
            + ` in ${unverified.length} module(s):`);
        console.log(`    ${list}`);
        console.log('  Those arities are NOT checked by anything; a green run says nothing about them.');
    }
    for (const s of skipped) {
        console.log(`  \x1b[33m⚠ ${s.module}:${s.func}\x1b[0m: reference disagrees but is not trusted — ${s.message}`);
    }
    if (errors.length > 0) {
        console.log('\n\x1b[31mArgument-count errors:\x1b[0m');
        for (const e of errors) {
            console.log(`  \x1b[31m✗ ${e.module}:${e.func}\x1b[0m: ${e.message}`);
        }
    }
    console.log(`\nArgument counts: ${errors.length} errors\n`);
    return errors.length === 0;
}

/**
 * Descriptor → handler binding.
 *
 * The API/Implementation pass reads one module's own files and reports what it finds
 * there. A module whose table is assembled by a MERGE — `Object.assign(this.exports,
 * createDbgHelpExports())`, a `...spread`, an `assignStubsOnce` stub table — binds exports
 * that pass could not see, and it printed the shortfall as a plain count ("imagehlp: 3
 * implemented") with no error and no caveat. Twenty-two working exports read as absent, in
 * green ink. That is the shape CLAIMED to be checked while nothing checks it.
 *
 * So binding is resolved through {@link ApiCoverageIndex}, which follows merges to the
 * file and symbol they name, and reports three things instead of one number:
 *
 *   BOUND        a handler is reachable — locally, or through a merge, possibly from
 *                another module's implementation (imagehlp serves dbghelp's table).
 *   NO HANDLER   declared with nothing behind it. NOT an error: the dispatcher answers
 *                ERROR_NOT_SUPPORTED, which is stack-safe and deliberate for 638 exports
 *                today. Counting it is the point; failing on it would be a false alarm.
 *   UNVERIFIABLE a merge whose source could not be followed. Its module's "no handler"
 *                verdicts are GUESSES, and saying so is the whole reason this section
 *                exists — a silent wrong number is worse than an admitted unknown.
 *
 * Two things here are provable contradictions, and those DO fail the gate:
 *   1. a handler's hard-coded `stackCleanup: N` against the descriptor's argCount — the
 *      thunk and the descriptor disagreeing about RET N corrupts the caller's frame.
 *      (The old text-search check only ever saw single-quoted keys, so every
 *      `exports["Name"]` module — imagehlp among them — was skipped in silence.)
 *   2. two descriptors reaching ONE handler with different arities. One function cannot
 *      pop two different amounts; whichever caller is wrong misaligns ESP.
 * Agreement in case 2 is NOT counted as verification: imagehlp's arities were copied from
 * dbghelp's, so they agree by construction. It is a contradiction detector, not a source.
 */
function validateExportBindings(repoRoot: string, only: string | null): boolean {
    let index: ApiCoverageIndex;
    try {
        index = ApiCoverageIndex.load(repoRoot);
    } catch (e: any) {
        console.error(`\x1b[31m✗ export-binding scan failed:\x1b[0m ${e?.message ?? e}`);
        return false;
    }

    const modules = index.listModules().filter(m => !only || m.module === only);
    if (modules.length === 0) {
        console.error(`\x1b[31m✗ export-binding scan matched no module\x1b[0m${only ? ` for --module ${only}` : ''}.`);
        return false;
    }

    const errors: string[] = [];
    const unverifiable: Array<{ module: string; site: { file: string; line: number; text: string; reason: string } }> = [];
    let bound = 0, unbound = 0, viaOtherModule = 0, cleanupChecked = 0, crossChecked = 0, mergeSites = 0;

    for (const mod of modules) {
        mergeSites += mod.mergeSites;
        for (const site of mod.unresolvedMerges) unverifiable.push({ module: mod.module, site });

        for (const [name, cov] of mod.exports) {
            if (cov.status === 'declared-stub') { unbound++; continue; }
            bound++;
            if (cov.origin) viaOtherModule++;

            // Every return path, not the unanimous case only: a handler that pops 20 on
            // success and 16 on its error branch is wrong on one of them, and treating
            // disagreement as "nothing to compare" is how that hides.
            if (cov.stackCleanups?.length && cov.argCount !== undefined) {
                cleanupChecked++;
                const wrong = cov.stackCleanups.filter(c => c !== cov.argCount! * 4);
                if (wrong.length > 0) {
                    errors.push(`${mod.module}:${name} — descriptor declares ${cov.argCount} args `
                        + `(${cov.argCount * 4} bytes) but the handler returns stackCleanup `
                        + `${wrong.join('/')} (${cov.file}:${cov.line}). One of them makes RET N wrong.`);
                }
            }

            if (cov.origin && cov.argCount !== undefined) {
                const origin = index.getModule(cov.origin)?.exports.get(name);
                if (origin?.argCount !== undefined) {
                    crossChecked++;
                    if (origin.argCount !== cov.argCount) {
                        errors.push(`${mod.module}:${name} declares ${cov.argCount} args but `
                            + `${cov.origin}:${name} — the SAME handler, reached through both descriptors `
                            + `(${cov.file}:${cov.line}) — declares ${origin.argCount}.`);
                    }
                }
            }
        }
    }

    console.log('Validating export bindings (descriptor → handler)...\n');
    console.log(`  ${bound + unbound} declared exports in ${modules.length} module(s): `
        + `${bound} bound to a handler, ${unbound} with no handler `
        + `(declared-only — the dispatcher answers ERROR_NOT_SUPPORTED).`);
    console.log(`  ${viaOtherModule} of the bound ones run a handler that lives in ANOTHER module's `
        + `implementation, reached through a merge.`);
    console.log(`  Cross-checked ${cleanupChecked} hard-coded stackCleanup value(s) and `
        + `${crossChecked} shared handler(s) declared by two descriptors.`);

    if (unverifiable.length > 0) {
        const byModule = new Map<string, number>();
        for (const u of unverifiable) byModule.set(u.module, (byModule.get(u.module) ?? 0) + 1);
        console.log(`  \x1b[33mBINDING UNVERIFIABLE\x1b[0m — ${unverifiable.length} export-table merge(s) `
            + `this scanner cannot follow, in ${byModule.size} module(s):`);
        for (const u of unverifiable) {
            console.log(`    \x1b[33m${u.module}\x1b[0m ${u.site.file}:${u.site.line} — ${u.site.reason}`);
            console.log(`      ${u.site.text}`);
        }
        console.log('  Every "no handler" count above is a GUESS for those modules: the handler may be');
        console.log('  in the table the merge contributes. Teach the resolver that shape rather than');
        console.log('  reading the number as fact.');
    } else if (mergeSites > 0) {
        console.log(`  All ${mergeSites} export-table merge site(s) were followed to the handlers they contribute.`);
    }

    // "no unresolved merges" out of a scan that found no merges AT ALL is the green a dead
    // instrument prints. Every HLE module of any size assembles its table this way.
    if (mergeSites === 0 && !only) {
        errors.push('the merge scanner found no export-table merge site at all — '
            + 'Object.assign/assignStubsOnce/spread into an exports table is how these modules '
            + 'are built, so this means the scanner stopped working, not that the merges are gone.');
    }

    if (errors.length > 0) {
        console.log('\n\x1b[31mExport-binding errors:\x1b[0m');
        for (const e of errors) console.log(`  \x1b[31m✗\x1b[0m ${e}`);
    }
    console.log(`\nExport bindings: ${errors.length} errors\n`);
    return errors.length === 0;
}

function formatError(error: any): string {
    const lines: string[] = [];
    
    lines.push(`  \x1b[31m✗ ${error.type}\x1b[0m: ${error.message}`);
    
    if (error.method) {
        lines.push(`    Method: ${error.method}`);
    }
    
    if (error.function) {
        lines.push(`    Function: ${error.function}`);
    }
    
    if (error.interface) {
        lines.push(`    Interface: ${error.interface}`);
    }
    
    if (error.expected !== undefined) {
        lines.push(`    Expected: ${JSON.stringify(error.expected)}`);
    }
    
    if (error.actual !== undefined) {
        lines.push(`    Actual: ${JSON.stringify(error.actual)}`);
    }
    
    return lines.join('\n');
}

function formatWarning(warning: any): string {
    return `  \x1b[33m⚠ ${warning.type}\x1b[0m: ${warning.message}`;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    
    // Anchored on this file, not the cwd: from any other directory the defaults resolved to
    // nothing, validateAllModules returned [] for the missing tree, and the gate printed
    // "0 errors, 0 warnings" and passed having scanned no module at all.
    // `--repo-root` retargets every default at another tree holding the same layout. It is
    // how this validator is tested: run it against a COPY with a deliberate bypass planted
    // (an implementation removed, an arity changed) and watch it go red. A check nobody has
    // ever seen fail is not known to work.
    const rootFlag = args.indexOf('--repo-root');
    const repoRoot = rootFlag >= 0 && args[rootFlag + 1]
        ? path.resolve(args[rootFlag + 1])
        : path.resolve(import.meta.dir, '..');
    let apiDir = path.join(repoRoot, 'src/worker/api');
    let modulesDir = path.join(repoRoot, 'src/worker/modules');
    let referenceDir = path.join(repoRoot, 'tools/reference');
    let moduleName: string | null = null;
    let reference = false;
    let apiOnly = false;
    let report = false;
    let skipMissing = false;
    
    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--reference') {
            reference = true;
        } else if (arg === '--api-only') {
            apiOnly = true;
        } else if (arg === '--report') {
            report = true;
        } else if (arg === '--skip-missing') {
            skipMissing = true;
        } else if (arg === '--repo-root' && i + 1 < args.length) {
            i++; // already applied above
        } else if (arg === '--module' && i + 1 < args.length) {
            moduleName = args[++i];
        } else if (arg === '--api-dir' && i + 1 < args.length) {
            apiDir = args[++i];
        } else if (arg === '--modules-dir' && i + 1 < args.length) {
            modulesDir = args[++i];
        } else if (arg === '--reference-dir' && i + 1 < args.length) {
            referenceDir = args[++i];
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: bun run validate-signatures [options]

Options:
  --module <name>        Validate specific module only
  --repo-root <path>     Read src/worker/{api,modules} and tools/reference from another tree
                         (used to prove the checks can fail, against a mutated copy)
  --reference            Include validation against reference headers
  --api-only             Only validate API/Implementation (skip reference)
  --api-dir <path>       Path to API directory (default: src/worker/api)
  --modules-dir <path>   Path to modules directory (default: src/worker/modules)
  --reference-dir <path> Path to reference directory (default: tools/reference)
  --report               Generate detailed JSON report
  --skip-missing          Skip missing_method and missing_function errors (show only argCount/vtable errors)
  --help, -h             Show this help message

Examples:
  bun run validate-signatures                    # API/Implementation validation for all modules
  bun run validate-signatures --reference        # Include reference validation
  bun run validate-signatures --module mss32     # Validate specific module
  bun run validate-signatures --api-only         # Skip reference validation
  bun run validate-signatures --report > report.json
`);
            process.exit(0);
        }
    }
    
    // An empty scan is indistinguishable from a clean one in the output below, so refuse it
    // here: a validator that can only report success is not an instrument.
    const countIn = (dir: string, suffix: string) => {
        if (!fs.existsSync(dir)) return -1;
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isDirectory() || e.name.endsWith(suffix)).length;
    };
    const apiCount = countIn(apiDir, '.api.ts');
    const moduleCount = countIn(modulesDir, '.ts');
    if (apiCount <= 0 || moduleCount <= 0) {
        console.error('\x1b[31m✗ validate-signatures scanned nothing.\x1b[0m');
        console.error(`  API directory:     ${apiDir} (${apiCount < 0 ? 'missing' : apiCount + ' entries'})`);
        console.error(`  Modules directory: ${modulesDir} (${moduleCount < 0 ? 'missing' : moduleCount + ' entries'})`);
        process.exit(1);
    }

    // Default: validate all modules with API/Implementation check
    // If --reference is specified, also validate against reference headers

    let arityOk = true;
    let bindingOk = true;
    try {
        // 0. Argument counts. Runs before the API/Implementation pass because that one
        //    exits the process on its own errors, and an arity mismatch is the more
        //    dangerous of the two failures.
        if (!reference || !apiOnly) {
            arityOk = validateArgCounts(apiDir, referenceDir, moduleName);
        }

        // 0.5 Descriptor → handler binding. Skipped only when the caller points the scan at
        //     directories other than the repo's own, where the coverage index has nothing to
        //     read; said out loud, because a section that quietly evaporates is the failure
        //     mode this whole pass exists to remove.
        if (!reference || !apiOnly) {
            const defaultLayout = path.resolve(apiDir) === path.join(repoRoot, 'src/worker/api')
                && path.resolve(modulesDir) === path.join(repoRoot, 'src/worker/modules');
            if (defaultLayout) {
                bindingOk = validateExportBindings(repoRoot, moduleName);
            } else {
                console.log('\x1b[33mExport bindings: NOT CHECKED\x1b[0m — --api-dir/--modules-dir point '
                    + 'outside the repo layout the coverage index reads.\n');
            }
        }

        // 1. API/Implementation validation (always runs unless --reference-only)
        if (!reference || !apiOnly) {
            console.log('Validating API/Implementation signatures...\n');
            console.log(`API directory: ${apiDir}`);
            console.log(`Modules directory: ${modulesDir}\n`);
            
            if (moduleName) {
                // Validate single module
                const apiFile = path.join(apiDir, `${moduleName}.api.ts`);
                // A module is a directory OR a single file (imagehlp.ts, oleaut32.ts). Only
                // the directory was accepted, so --module on a file-based module died with
                // "Module directory not found" — the one form you reach for when a
                // single-file module is the thing under suspicion.
                const moduleDir = fs.existsSync(path.join(modulesDir, moduleName))
                    ? path.join(modulesDir, moduleName)
                    : path.join(modulesDir, `${moduleName}.ts`);

                if (!fs.existsSync(apiFile)) {
                    console.error(`API file not found: ${apiFile}`);
                    process.exit(1);
                }

                if (!fs.existsSync(moduleDir)) {
                    console.error(`Module implementation not found: ${path.join(modulesDir, moduleName)}[.ts]`);
                    process.exit(1);
                }

                // Use signature-validator for single module
                const { SignatureValidator } = require('../src/worker/tools/signature-validator');
                const v = new SignatureValidator();
                const result = v.validateModule(moduleName, apiFile, moduleDir);
                
                console.log(`\nModule: ${result.moduleName}`);
                console.log(`Status: ${result.valid ? '✅ PASS' : '❌ FAIL'}`);
                console.log(`Functions: ${result.stats.totalFunctions} handlers in its own files`
                    + ` (the export-binding section above counts the merged table)`);
                
                if (result.errors.length > 0) {
                    console.log('Errors:');
                    for (const error of result.errors) {
                        console.log(`  ❌ ${error.functionName}: ${error.message}`);
                    }
                }
                
                if (result.warnings.length > 0) {
                    console.log('Warnings:');
                    for (const warning of result.warnings) {
                        console.log(`  ⚠️  ${warning.functionName}: ${warning.message}`);
                    }
                }
                
                if (!result.valid) {
                    process.exit(1);
                }
            } else {
                // Validate all modules
                validateSignatures(apiDir, modulesDir);
            }
        }
        
        // 2. Reference validation (if requested)
        if (reference && !apiOnly) {
            console.log('\n' + '─'.repeat(60));
            console.log('Validating against reference signatures...\n');
            console.log(`Reference directory: ${referenceDir}\n`);
            
            const apiFiles = moduleName 
                ? [path.join(apiDir, `${moduleName}.api.ts`)]
                : fs.readdirSync(apiDir).filter(f => f.endsWith('.api.ts')).map(f => path.join(apiDir, f));
            
            let totalStats = {
                interfacesChecked: 0,
                methodsChecked: 0,
                functionsChecked: 0,
                errorsFound: 0,
                warningsFound: 0
            };
            const allErrors: any[] = [];
            const allWarnings: any[] = [];
            
            for (const apiFile of apiFiles) {
                if (!fs.existsSync(apiFile)) continue;
                
                const result = await validateReferenceSignatures(apiFile, referenceDir);
                totalStats.interfacesChecked += result.stats.interfacesChecked || 0;
                totalStats.methodsChecked += result.stats.methodsChecked || 0;
                totalStats.functionsChecked += result.stats.functionsChecked || 0;
                totalStats.errorsFound += result.stats.errorsFound;
                totalStats.warningsFound += result.stats.warningsFound;
                allErrors.push(...result.errors);
                allWarnings.push(...result.warnings);
            }
            
            // Print statistics
            console.log('─'.repeat(60));
            console.log('Reference Validation Results:');
            if (totalStats.interfacesChecked > 0) {
                console.log(`  Interfaces checked: ${totalStats.interfacesChecked}`);
                console.log(`  Methods checked: ${totalStats.methodsChecked}`);
            }
            if (totalStats.functionsChecked > 0) {
                console.log(`  Functions checked: ${totalStats.functionsChecked}`);
            }
            // Filter errors if --skip-missing is set (hide missing_method/missing_function errors)
            const errorsToShow = skipMissing 
                ? allErrors.filter(e => e.type !== 'missing_method' && e.type !== 'missing_function')
                : allErrors;
            const filteredErrorsCount = skipMissing 
                ? allErrors.filter(e => e.type === 'missing_method' || e.type === 'missing_function').length
                : 0;
            const displayedErrorsCount = totalStats.errorsFound - filteredErrorsCount;
            
            console.log(`  Errors: ${displayedErrorsCount}${skipMissing && filteredErrorsCount > 0 ? ` (${filteredErrorsCount} missing_method/missing_function skipped)` : ''}`);
            console.log(`  Warnings: ${totalStats.warningsFound}`);
            console.log('─'.repeat(60));
            
            // Print warnings (show all warnings)
            if (allWarnings.length > 0) {
                console.log('\n\x1b[33mWarnings:\x1b[0m');
                for (const warning of allWarnings) {
                    console.log(formatWarning(warning));
                }
            }
            
            // Print errors (filter missing_method/missing_function if --skip-missing is set)
            if (errorsToShow.length > 0) {
                console.log('\n\x1b[31mErrors:\x1b[0m');
                
                // Group by interface/function
                const errorsByGroup = new Map<string, any[]>();
                for (const error of errorsToShow) {
                    const key = error.interface || error.function || 'unknown';
                    if (!errorsByGroup.has(key)) {
                        errorsByGroup.set(key, []);
                    }
                    errorsByGroup.get(key)!.push(error);
                }
                
                for (const [groupName, errors] of errorsByGroup) {
                    console.log(`\n  \x1b[1m${groupName}:\x1b[0m`);
                    for (const error of errors) {
                        console.log(formatError(error));
                    }
                }
                
                console.log('\n');
            }
            
            // Generate report if requested
            if (report) {
                const reportData = {
                    timestamp: new Date().toISOString(),
                    stats: totalStats,
                    errors: allErrors,
                    warnings: allWarnings
                };
                console.log(JSON.stringify(reportData, null, 2));
            }
            
            // Exit with error code if validation failed (only count non-filtered errors)
            if (errorsToShow.length > 0) {
                console.log('\x1b[31m✗ Reference validation failed!\x1b[0m');
                process.exit(1);
            } else {
                console.log('\n\x1b[32m✓ All reference signatures are valid!\x1b[0m');
            }
        }
        
    } catch (error: any) {
        console.error('\x1b[31mFatal error:\x1b[0m', error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }

    if (!arityOk) {
        console.error('\x1b[31m✗ Argument-count validation failed!\x1b[0m');
    }
    if (!bindingOk) {
        console.error('\x1b[31m✗ Export-binding validation failed!\x1b[0m');
    }
    if (!arityOk || !bindingOk) process.exit(1);
}

main();
