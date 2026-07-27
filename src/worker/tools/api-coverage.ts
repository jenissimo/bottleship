/**
 * API coverage index — "what do we actually implement", read off the repo's own
 * sources of truth rather than a hand-maintained list.
 *
 * Two inputs, both already canonical:
 *   - `src/worker/api/<mod>.api.ts`      the DECLARED surface (what the PE loader can
 *                                        generate a correct stdcall stub for), read with
 *                                        SignatureValidator.extractApiFunctions.
 *   - `src/worker/modules/<mod>*`        the IMPLEMENTED surface, read with
 *                                        SignatureValidator.scanImplementationFile plus
 *                                        the registration shapes it does not model
 *                                        (object-literal export maps, registerFastPath,
 *                                        registerDataExport) — see {@link scanExtraExports}.
 *
 * The handler's parameter list is what separates "stubbed" from "implemented": a handler
 * declared `() => D3D_OK` cannot read its arguments, so it cannot fill the out-params its
 * caller reads back — the SILENT STUB. Statically we can be sharper than the runtime
 * census: a zero-parameter handler for a zero-argument export (GetTickCount, timeGetTime)
 * is perfectly correct, so the arity signal is only raised when the DESCRIPTOR says the
 * function takes arguments the handler is provably ignoring.
 *
 * `REFERENCE_ARG_COUNTS` is the third tier: a DLL we do NOT thunk, whose stdcall arg
 * count we still know, so the loader can emit a stack-correct trap stub instead of
 * throwing. Which side of that line an import falls on is the difference between "boots
 * and misbehaves" and "does not boot at all".
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { SignatureValidator } from './signature-validator';
import { SILENT_STUBS } from '../core/diagnostics/api-census';
import { REFERENCE_ARG_COUNTS } from '../reference-argcounts.generated';
import { resolveThunkedDllAlias } from '../core/dll-aliases';
import { EMU_NATIVE_VIDEO_DLLS, VIDEO_DLL_NAMES } from '../core/cpu/emulator-config';
import { deriveStackCleanupFromMangledName } from '../core/thunking/msvc-mangling';

/**
 * How well one export of one module is covered.
 *  - `implemented`   a real handler runs.
 *  - `silent-stub`   a handler runs but provably ignores its arguments (arity 0 for a
 *                    function the descriptor says takes some), or is curated in
 *                    SILENT_STUBS — returns success without doing the work.
 *  - `declared-stub` declared in the descriptor, no handler found: the dispatcher
 *                    answers ERROR_NOT_SUPPORTED. Stack-safe, non-functional.
 */
export type CoverageStatus = 'implemented' | 'silent-stub' | 'declared-stub';

export interface ExportCoverage {
    status: CoverageStatus;
    /** Declared argument count from the API descriptor, when the descriptor names it. */
    argCount?: number;
    /** Handler parameter count; -1 when the registration shape hides it. */
    arity?: number;
    /** Repo-relative source location of the handler. */
    file?: string;
    line?: number;
}

export interface ModuleCoverage {
    /** Canonical HLE module name (post-alias), e.g. "ddraw", "d3dx9". */
    module: string;
    apiFile: string;
    /** Repo-relative implementation files scanned for this module. */
    implFiles: string[];
    /** Lowercased export name → coverage. */
    exports: Map<string, ExportCoverage>;
    /** Ordinal → lowercased export name, for imports that carry no name at all. */
    ordinals: Map<number, string>;
}

/** One handler found in the implementation sources. `arity === -1` ⇒ unknown. */
interface ImplRecord {
    name: string;
    arity: number;
    file: string;
    line: number;
}

/**
 * Mirrors PELoader.DLL_FORCE_STUB — DLLs stubbed even when the bundle ships a real one.
 * Kept in sync by name; the loader's copy is private.
 */
const FORCE_STUB_DLLS = new Set(['ifc20', 'ifc21', 'ifc22', 'mscoree']);

function toPosix(p: string): string {
    return p.replace(/\\/g, '/');
}

/** Strip a stdcall/cdecl decoration (`_Foo@8`, `Foo@8`) down to the bare name. */
function undecorate(name: string): string {
    return name.replace(/^_+/, '').replace(/@\d+$/, '');
}

function paramCount(node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration): number {
    return node.parameters.length;
}

/**
 * Ordinal → export name from an API descriptor. A PE that imports by ordinal carries no
 * name at all, and APIRegistry.getArgCountByOrdinal resolves it through the descriptor's
 * `{ name, ordinal }` pairs — so a census that only matched `ord_N` would call every
 * ordinal import of dsound/dplayx/oleaut32 unresolvable, which is exactly backwards.
 */
function scanOrdinals(apiFile: string, content: string): Map<number, string> {
    const sf = ts.createSourceFile(apiFile, content, ts.ScriptTarget.Latest, true);
    const out = new Map<number, string>();
    const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
            let name: string | null = null;
            let ordinal: number | null = null;
            for (const prop of node.properties) {
                if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
                if (prop.name.text === 'name'
                    && (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))) {
                    name = prop.initializer.text;
                } else if (prop.name.text === 'ordinal' && ts.isNumericLiteral(prop.initializer)) {
                    ordinal = parseInt(prop.initializer.text, 10);
                }
            }
            if (name && ordinal !== null && !out.has(ordinal)) out.set(ordinal, name.toLowerCase());
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/**
 * Registration shapes SignatureValidator.scanImplementationFile does not model, all of
 * which produce a genuinely dispatched handler:
 *   `export const exports: Record<string, ThunkImplementation> = { 'Name': (ctx,…) => … }`
 *   `dispatcher.registerFastPath('kernel32', 'Name', fn)`   — WASM/JS fast path
 *   `tg.registerDataExport('crtdll', '_adjust_fdiv', addr)` — IAT points at a variable
 * Missing these reads a fully working export as unimplemented, which is the difference
 * between a useful census and a misleading one.
 */
function scanExtraExports(filePath: string): ImplRecord[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const out: ImplRecord[] = [];
    const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const add = (name: string, arity: number, node: ts.Node): void => {
        if (name) out.push({ name, arity, file: filePath, line: lineOf(node) });
    };

    const literalText = (node: ts.Node | undefined): string | null => {
        if (!node) return null;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
        return null;
    };

    /** Harvest `{ 'Name': impl, Name2: impl2 }` as an export map. */
    const harvestObjectLiteral = (obj: ts.ObjectLiteralExpression): void => {
        for (const prop of obj.properties) {
            if (ts.isPropertyAssignment(prop)) {
                const name = literalText(prop.name) ?? (ts.isIdentifier(prop.name) ? prop.name.text : null);
                if (!name) continue;
                const init = prop.initializer;
                if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(name, paramCount(init), prop);
                else add(name, -1, prop); // an identifier/call reference — a real handler, arity unknown
            } else if (ts.isMethodDeclaration(prop)) {
                const name = literalText(prop.name) ?? (ts.isIdentifier(prop.name) ? prop.name.text : null);
                if (name) add(name, prop.parameters.length, prop);
            } else if (ts.isShorthandPropertyAssignment(prop)) {
                add(prop.name.text, -1, prop);
            }
        }
    };

    const looksLikeExportMap = (decl: ts.VariableDeclaration): boolean => {
        const varName = ts.isIdentifier(decl.name) ? decl.name.text : '';
        if (/exports$/i.test(varName)) return true;
        const typeText = decl.type ? decl.type.getText(sf) : '';
        return /ThunkImplementation/.test(typeText);
    };

    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer
            && ts.isObjectLiteralExpression(node.initializer) && looksLikeExportMap(node)) {
            harvestObjectLiteral(node.initializer);
        }

        // `function createXExports() { return { 'Name': … }; }` / `=> ({ … })`
        if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
            const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : '';
            if (/create\w*Exports/i.test(name)) {
                if (node.body && ts.isBlock(node.body)) {
                    for (const stmt of node.body.statements) {
                        if (ts.isReturnStatement(stmt) && stmt.expression
                            && ts.isObjectLiteralExpression(stmt.expression)) {
                            harvestObjectLiteral(stmt.expression);
                        }
                    }
                }
            }
        }

        // `exports["Name"] = socketExports.bind!` / `= someObj.fn` — a real handler
        // assigned from a property access, which the validator's thunk resolver skips.
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isElementAccessExpression(node.left)) {
            const obj = node.left.expression;
            const onExports = (ts.isIdentifier(obj) && obj.text === 'exports')
                || (ts.isPropertyAccessExpression(obj) && ts.isIdentifier(obj.name) && obj.name.text === 'exports');
            const key = literalText(node.left.argumentExpression);
            if (onExports && key) {
                const rhs = node.right;
                const arity = (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs)) ? paramCount(rhs) : -1;
                add(key, arity, node);
            }
        }

        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const fname = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
                ? callee.name.text
                : (ts.isIdentifier(callee) ? callee.text : '');
            if ((fname === 'registerFastPath' || fname === 'registerDataExport') && node.arguments.length >= 2) {
                const exportName = literalText(node.arguments[1]);
                if (exportName) add(exportName, -1, node);
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sf);
    return out;
}

/**
 * How the loader would come to know an import's stdcall stack cleanup. Anything but
 * `null` means ThunkGenerator can emit a correct RET N; `null` is the only case where
 * generateStubDll throws and the image fails to load.
 */
export type AbiSource = 'descriptor' | 'cross-module' | 'reference' | 'decoration' | 'mangled' | null;

export class ApiCoverageIndex {
    private modules = new Map<string, ModuleCoverage>();
    /** Undecorated lowercase export name → argCount, pooled across EVERY module. */
    private globalNames = new Map<string, number>();

    private constructor(private readonly repoRoot: string) { }

    /** Scan `src/worker/api` + `src/worker/modules` once. */
    static load(repoRoot: string): ApiCoverageIndex {
        const index = new ApiCoverageIndex(repoRoot);
        const apiDir = path.join(repoRoot, 'src/worker/api');
        const modulesDir = path.join(repoRoot, 'src/worker/modules');
        const validator = new SignatureValidator();

        const apiFiles = fs.existsSync(apiDir)
            ? fs.readdirSync(apiDir).filter(f => f.endsWith('.api.ts'))
            : [];
        const apiModuleNames = new Set(apiFiles.map(f => f.replace(/\.api\.ts$/, '').toLowerCase()));

        for (const file of apiFiles) {
            const moduleName = file.replace(/\.api\.ts$/, '').toLowerCase();
            const apiFile = path.join(apiDir, file);
            const apiContent = fs.readFileSync(apiFile, 'utf-8');
            const declared = validator.extractApiFunctions(apiFile, apiContent, { modulesOnly: true });
            const ordinals = scanOrdinals(apiFile, apiContent);

            const implFiles = collectImplFiles(modulesDir, moduleName, apiModuleNames);
            const implemented = new Map<string, ImplRecord>();
            // Keep the most informative sighting of a name: a known arity beats an
            // opaque one (-1), and a handler that takes arguments beats a `() => 0`
            // alias of the same name.
            const remember = (rec: ImplRecord): void => {
                const key = undecorate(rec.name).toLowerCase();
                const prev = implemented.get(key);
                if (!prev || rec.arity > prev.arity) implemented.set(key, rec);
            };
            for (const f of implFiles) {
                try {
                    for (const info of validator.scanImplementationFile(f)) {
                        remember({ name: info.name, arity: info.params.length, file: info.filePath, line: info.line });
                    }
                    for (const rec of scanExtraExports(f)) remember(rec);
                } catch { /* an unparseable file must not sink the whole census */ }
            }

            const exports = new Map<string, ExportCoverage>();
            const addExport = (rawName: string, argCount?: number): void => {
                const key = undecorate(rawName).toLowerCase();
                const impl = implemented.get(key);
                if (!impl) {
                    exports.set(key, { status: 'declared-stub', argCount });
                    return;
                }
                // Arity 0 only condemns a handler when the export actually takes arguments:
                // `timeGetTime()` legitimately needs none.
                const ignoresArgs = impl.arity === 0 && (argCount ?? 0) > 0;
                const curated = SILENT_STUBS.has(`${moduleName}:${impl.name}`);
                exports.set(key, {
                    status: (ignoresArgs || curated) ? 'silent-stub' : 'implemented',
                    argCount,
                    arity: impl.arity,
                    file: toPosix(path.relative(repoRoot, impl.file)),
                    line: impl.line,
                });
            };

            for (const [name, argCount] of Object.entries(declared)) addExport(name, argCount);
            // A handler with no descriptor entry is still real — the guest reaches it through
            // GetProcAddress or a DLL alias. COM methods (Iface_Method) are not DLL exports.
            for (const [key, impl] of implemented) {
                if (exports.has(key) || key.includes('_')) continue;
                addExport(impl.name);
            }

            for (const [name, argCount] of Object.entries(declared)) {
                const key = undecorate(name).toLowerCase();
                if (!index.globalNames.has(key)) index.globalNames.set(key, argCount);
            }

            index.modules.set(moduleName, {
                module: moduleName,
                apiFile: toPosix(path.relative(repoRoot, apiFile)),
                implFiles: implFiles.map(f => toPosix(path.relative(repoRoot, f))),
                exports,
                ordinals,
            });
        }

        return index;
    }

    /** Canonical HLE module name for an imported DLL name (alias-resolved, no extension). */
    canonicalModule(dllName: string): string {
        return resolveThunkedDllAlias(dllName);
    }

    /** True when this DLL is intercepted by an HLE module (the PE loader "THUNKED" path). */
    isThunked(dllName: string): boolean {
        return this.modules.has(this.canonicalModule(dllName));
    }

    /**
     * DLLs the loader refuses to map natively NO MATTER WHAT the bundle ships — the HLE
     * module always wins. Distinct from the coverage-based fallback: `loadDll` returns
     * null for these before any import is examined, so a shipped copy is dead weight.
     *   - VIDEO_DLL_NAMES while EMU_NATIVE_VIDEO_DLLS is false (smackw32, binkw32)
     *   - every versioned d3dx9 redist
     *   - DLL_FORCE_STUB (ifc2x force-feedback, mscoree)
     * Missing this reads a shipped smackw32.dll as "the guest's own decoder runs", which
     * points a video bug at exactly the wrong layer.
     */
    isAlwaysHle(dllName: string): boolean {
        const base = this.canonicalModule(dllName);
        if (!EMU_NATIVE_VIDEO_DLLS && VIDEO_DLL_NAMES.has(base)) return true;
        if (base === 'd3dx9') return true;
        return FORCE_STUB_DLLS.has(base);
    }

    getModule(dllName: string): ModuleCoverage | undefined {
        return this.modules.get(this.canonicalModule(dllName));
    }

    listModules(): ModuleCoverage[] {
        return [...this.modules.values()].sort((a, b) => a.module.localeCompare(b.module));
    }

    /** Coverage for one export of one DLL, or null when nothing declares or implements it. */
    lookup(dllName: string, exportName: string): ExportCoverage | null {
        const mod = this.getModule(dllName);
        if (!mod) return null;
        return mod.exports.get(undecorate(exportName).toLowerCase()) ?? null;
    }

    /**
     * Coverage for an import-by-ordinal: resolve the ordinal to its declared export name
     * first, then fall back to a literal `ord_N` entry (how wsock32/ws2_32 declare theirs).
     */
    lookupOrdinal(dllName: string, ordinal: number): ExportCoverage | null {
        const mod = this.getModule(dllName);
        if (!mod) return null;
        const named = mod.ordinals.get(ordinal);
        if (named) {
            const cov = mod.exports.get(undecorate(named).toLowerCase());
            if (cov) return cov;
        }
        return mod.exports.get(`ord_${ordinal}`) ?? null;
    }

    /**
     * stdcall argument count from the curated win32 reference for a DLL we do NOT thunk.
     * Present ⇒ the loader emits a trap stub with a correct RET N, so the call faults
     * cleanly instead of corrupting the stack.
     */
    referenceArgCount(dllName: string, exportName: string): number | undefined {
        const dll = this.canonicalModule(dllName);
        return REFERENCE_ARG_COUNTS[dll]?.[undecorate(exportName).toLowerCase()];
    }

    /**
     * Mirror of the chain APIRegistry.getArgCount / getStackCleanupBytes actually walk,
     * ending in ThunkGenerator.resolveBytesToPop. A census that guesses this predicate
     * instead of mirroring it invents load failures: step 3 in particular — the registry
     * accepts a name found in ANY module when the DLL name is imprecise — resolves most
     * CRT imports made by a shipped mfc42/msvcp60, which a naive per-DLL check calls
     * unresolvable.
     */
    resolveAbi(dllName: string, exportName: string): AbiSource {
        const dll = this.canonicalModule(dllName);
        const bare = undecorate(exportName).toLowerCase();
        const mod = this.modules.get(dll);

        // 1/2. exact, then A/W-stripped, within the module's own descriptor.
        if (mod?.exports.has(bare)) return 'descriptor';
        if (mod?.exports.has(bare.replace(/[wa]$/, ''))) return 'descriptor';
        // 2.6. MSS-style: descriptors carry the `_` decoration the DLL exports without.
        if (mod?.exports.has(`_${bare}`)) return 'descriptor';
        // 3. any module (the registry's imprecise-DLL-name fallback).
        if (this.globalNames.has(bare)) return 'cross-module';
        // Seeded win32 reference (also pooled across modules by the registry).
        if (REFERENCE_ARG_COUNTS[dll]?.[bare] !== undefined) return 'reference';
        for (const table of Object.values(REFERENCE_ARG_COUNTS)) {
            if (table[bare] !== undefined) return 'reference';
        }
        // 4. decoration, then MSVC C++ mangling (resolveBytesToPop's last resort).
        if (/@\d+$/.test(exportName)) return 'decoration';
        if (exportName.startsWith('?') && deriveStackCleanupFromMangledName(exportName) !== undefined) {
            return 'mangled';
        }
        return null;
    }

    /** Repo root this index was loaded from. */
    get root(): string {
        return this.repoRoot;
    }

    /** Aggregate counts per module — the "how much of ddraw is real" view. */
    summary(): Array<{ module: string; implemented: number; silentStubs: number; declaredStubs: number }> {
        return this.listModules().map(m => {
            let implemented = 0, silentStubs = 0, declaredStubs = 0;
            for (const cov of m.exports.values()) {
                if (cov.status === 'implemented') implemented++;
                else if (cov.status === 'silent-stub') silentStubs++;
                else declaredStubs++;
            }
            return { module: m.module, implemented, silentStubs, declaredStubs };
        });
    }
}

/**
 * Implementation sources for one module: its directory, its top-level file, and the
 * flat sibling helpers those files pull in (`winmm.ts` → `winmm-mci.ts`, `msvcrt.ts` →
 * `crt-format.ts`). Following one level of relative imports keeps the rule generic —
 * no per-module list — while refusing to cross into another api-backed module.
 */
function collectImplFiles(modulesDir: string, moduleName: string, apiModuleNames: Set<string>): string[] {
    const files = new Set<string>();

    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.endsWith('.ts')) files.add(full);
        }
    };

    const dirPath = path.join(modulesDir, moduleName);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) walk(dirPath);
    const filePath = path.join(modulesDir, `${moduleName}.ts`);
    if (fs.existsSync(filePath)) files.add(filePath);

    // Flat siblings named after the module (winmm-mci.ts, comctl32-init.ts).
    if (fs.existsSync(modulesDir)) {
        for (const entry of fs.readdirSync(modulesDir)) {
            if (entry.startsWith(`${moduleName}-`) && entry.endsWith('.ts')) {
                files.add(path.join(modulesDir, entry));
            }
        }
    }

    // One hop along relative imports, restricted to flat helper files that are not
    // themselves an api-backed module.
    for (const seed of [...files]) {
        let content: string;
        try { content = fs.readFileSync(seed, 'utf-8'); } catch { continue; }
        for (const m of content.matchAll(/from\s+["'](\.\.?\/[A-Za-z0-9._/-]+)["']/g)) {
            const candidate = path.resolve(path.dirname(seed), `${m[1]}.ts`);
            if (path.dirname(candidate) !== modulesDir) continue; // flat helpers only
            const helper = path.basename(candidate, '.ts').toLowerCase();
            if (apiModuleNames.has(helper)) continue;
            if (fs.existsSync(candidate)) files.add(candidate);
        }
    }

    return [...files];
}
