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
    /**
     * Every distinct RET N the handler hard-codes across its return paths. More than one
     * value is itself a defect — a stdcall thunk pops the same amount on every path.
     */
    stackCleanups?: number[];
    /**
     * The HLE module the handler's source belongs to, when it is not this one — imagehlp
     * serving dbghelp's table, wsock32 serving ws2_32's. A shared handler is reached
     * through BOTH descriptors, so both must agree about its ABI.
     */
    origin?: string;
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
    /**
     * Export-table merges this scanner could not follow. NON-EMPTY means every
     * `declared-stub` verdict in this module is a GUESS: the handler may well be in the
     * table the merge contributes. Consumers must report this rather than print the count
     * as if it were known.
     */
    unresolvedMerges: UnresolvedMerge[];
    /**
     * Export-table merge sites seen in this module's sources, followed or not. A consumer
     * that finds ZERO across the whole tree is looking at a scanner that has stopped
     * working, not at a repo without merges — and "no unresolved merges" would then be a
     * green light produced by looking at nothing.
     */
    mergeSites: number;
}

/** One handler found in the implementation sources. `arity === -1` ⇒ unknown. */
interface ImplRecord {
    name: string;
    arity: number;
    file: string;
    line: number;
    /** Distinct literal `stackCleanup:` values the handler returns. */
    cleanups?: number[];
}

/**
 * A merge into a module's export table (`Object.assign(this.exports, …)`, `assignStubsOnce`,
 * a `...spread` inside an export map) whose source this scanner could not follow to the
 * names it contributes.
 *
 * This is the category that must exist for the census to be honest. A module assembled by
 * a shape we cannot resolve has an export table we do not know, and reporting its
 * declarations as "no handler" would be a WRONG number wearing a confident face — the
 * failure mode CLAUDE.md's quality-gate rule is about. Every such site is named here so a
 * reader can see exactly how much of the answer is guesswork.
 */
export interface UnresolvedMerge {
    /** Repo-relative file containing the merge. */
    file: string;
    line: number;
    /** The merge expression's source text, trimmed. */
    text: string;
    /** Why the scanner could not follow it. */
    reason: string;
}

/**
 * Mirrors PELoader.DLL_FORCE_STUB — DLLs stubbed even when the bundle ships a real one.
 * Kept in sync by name; the loader's copy is private.
 */
const FORCE_STUB_DLLS = new Set(['ifc20', 'ifc21', 'ifc22', 'mscoree']);

function toPosix(p: string): string {
    return p.replace(/\\/g, '/');
}

/** Which HLE module a handler's source file belongs to (`modules/dbghelp.ts` → dbghelp). */
function moduleOfImplFile(modulesDir: string, file: string): string | null {
    const rel = path.relative(modulesDir, file);
    if (!rel || rel.startsWith('..')) return null;
    const head = toPosix(rel).split('/')[0];
    return head.replace(/\.ts$/, '').toLowerCase();
}

/** Strip a stdcall/cdecl decoration (`_Foo@8`, `Foo@8`) down to the bare name. */
function undecorate(name: string): string {
    return name.replace(/^_+/, '').replace(/@\d+$/, '');
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

/** Result of following one merge source: the handlers it names, or why we could not. */
interface Harvest {
    records: ImplRecord[];
    /** Non-null when nothing could be enumerated — the confession text. */
    reason: string | null;
    /** The file the source was traced into, even when its names stayed opaque. */
    file: string | null;
}

/**
 * Cross-file resolver for export-table assembly.
 *
 * A module's export table is not written in one place: `imagehlp.ts` merges the whole
 * dbghelp surface with `Object.assign(this.exports, createDbgHelpExports())`, kernel32
 * merges eighteen per-area `exports` objects, ddraw merges factory results and stub
 * tables. A scanner that only looks at assignments it can see IN THE FILE reports those
 * exports as unimplemented — a wrong number that passes silently.
 *
 * So the merge is modelled as what it is: follow the source expression to the symbol it
 * names, follow the symbol to its defining file (across modules — the whole point of the
 * imagehlp/dbghelp case), and harvest the object literal it ultimately produces. What
 * cannot be followed is recorded as an {@link UnresolvedMerge}, never silently dropped.
 */
class SourceGraph {
    private parsed = new Map<string, ts.SourceFile | null>();
    /** file → local name → where it was imported from. */
    private importsOf = new Map<string, Map<string, { file: string | null; symbol: string; specifier: string }>>();

    parse(file: string): ts.SourceFile | null {
        if (this.parsed.has(file)) return this.parsed.get(file)!;
        let sf: ts.SourceFile | null = null;
        try {
            sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
        } catch { sf = null; }
        this.parsed.set(file, sf);
        return sf;
    }

    /** Resolve a relative module specifier the way the bundler does (`./x` → x.ts | x/index.ts). */
    resolveSpecifier(fromFile: string, specifier: string): string | null {
        if (!specifier.startsWith('.')) return null;
        const base = path.resolve(path.dirname(fromFile), specifier);
        for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), `${base}.tsx`]) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        }
        return null;
    }

    private imports(file: string): Map<string, { file: string | null; symbol: string; specifier: string }> {
        const cached = this.importsOf.get(file);
        if (cached) return cached;
        const map = new Map<string, { file: string | null; symbol: string; specifier: string }>();
        this.importsOf.set(file, map);
        const sf = this.parse(file);
        if (!sf) return map;
        for (const stmt of sf.statements) {
            if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
            const specifier = stmt.moduleSpecifier.text;
            const target = this.resolveSpecifier(file, specifier);
            const bindings = stmt.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
                for (const el of bindings.elements) {
                    map.set(el.name.text, { file: target, symbol: (el.propertyName ?? el.name).text, specifier });
                }
            } else if (bindings && ts.isNamespaceImport(bindings)) {
                map.set(bindings.name.text, { file: target, symbol: '*', specifier });
            }
            if (stmt.importClause?.name) {
                map.set(stmt.importClause.name.text, { file: target, symbol: 'default', specifier });
            }
        }
        return map;
    }

    /**
     * Harvest the handlers an expression contributes to an export table.
     *
     * `file` in the result is the source file the expression was traced INTO, whether or
     * not names came back. That is what lets a caller distinguish "followed it, and the
     * file is one we already scan" from "no idea where this table comes from" — the second
     * being the only case that has to be confessed.
     */
    harvestExpression(expr: ts.Node, file: string, seen: Set<string>): Harvest {
        const sf = this.parse(file);
        if (!sf) return { records: [], reason: `cannot parse ${toPosix(file)}`, file: null };

        if (ts.isObjectLiteralExpression(expr)) {
            return { records: this.harvestObject(expr, file, sf, seen), reason: null, file };
        }
        if (ts.isCallExpression(expr)) {
            // An IIFE builds the table right here; anything else names a factory whose
            // RESULT is the table (`createFooExports(ctx)`, `makeSocketExports(a, b)`).
            const callee = expr.expression;
            if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)
                || (ts.isParenthesizedExpression(callee)
                    && (ts.isArrowFunction(callee.expression) || ts.isFunctionExpression(callee.expression)))) {
                const fn = ts.isParenthesizedExpression(callee) ? callee.expression : callee;
                return {
                    records: this.harvestFunctionResult(fn as ts.ArrowFunction, file, sf, seen),
                    reason: null,
                    file,
                };
            }
            return this.harvestExpression(callee, file, seen);
        }
        if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
            return this.harvestExpression(expr.expression, file, seen);
        }
        if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
            return { records: this.harvestFunctionResult(expr, file, sf, seen), reason: null, file };
        }
        if (ts.isIdentifier(expr)) {
            return this.harvestSymbol(file, expr.text, seen);
        }
        if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
            const obj = expr.expression;
            // `ns.createFooExports` after `import * as ns`.
            if (ts.isIdentifier(obj)) {
                const imported = this.imports(file).get(obj.text);
                if (imported?.symbol === '*' && imported.file) {
                    return this.harvestSymbol(imported.file, expr.name.text, seen);
                }
            }
            // `fileIoModule.exports` / `this.safeArray.exports` — a runtime object graph.
            // We cannot enumerate its properties, but we CAN say which file builds it, and
            // that is enough to tell a covered merge from an opaque one.
            const owner = this.definingFileOf(obj, file, seen);
            return {
                records: [],
                reason: `source is a runtime property access (${expr.getText(sf).slice(0, 60)})`,
                file: owner,
            };
        }
        return { records: [], reason: `unsupported merge source (${ts.SyntaxKind[expr.kind]})`, file: null };
    }

    /** The file that builds the object an expression denotes, without enumerating it. */
    private definingFileOf(expr: ts.Node, file: string, seen: Set<string>): string | null {
        if (ts.isIdentifier(expr)) {
            const imported = this.imports(file).get(expr.text);
            if (imported?.file) return imported.file;
            const init = this.findInitializer(file, expr.text);
            if (init && ts.isCallExpression(init)) {
                const res = this.harvestExpression(init.expression, file, new Set(seen));
                if (res.file) return res.file;
            }
            return init ? file : null;
        }
        // `this.safeArray` — the class field's initializer says where the object is built.
        if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword
            && ts.isIdentifier(expr.name)) {
            const init = this.findClassFieldInitializer(file, expr.name.text);
            if (init && ts.isCallExpression(init)) {
                const res = this.harvestExpression(init.expression, file, new Set(seen));
                if (res.file) return res.file;
            }
            return init ? file : null;
        }
        return null;
    }

    private findInitializer(file: string, name: string): ts.Expression | null {
        const sf = this.parse(file);
        if (!sf) return null;
        let out: ts.Expression | null = null;
        const visit = (node: ts.Node): void => {
            if (out) return;
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
                && node.name.text === name && node.initializer) {
                out = node.initializer;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
        return out;
    }

    private findClassFieldInitializer(file: string, name: string): ts.Expression | null {
        const sf = this.parse(file);
        if (!sf) return null;
        let out: ts.Expression | null = null;
        const visit = (node: ts.Node): void => {
            if (out) return;
            if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)
                && node.name.text === name && node.initializer) {
                out = node.initializer;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
        return out;
    }

    /** Follow one symbol name to its definition — locally, then through imports/re-exports. */
    harvestSymbol(file: string, symbol: string, seen: Set<string>): Harvest {
        const key = `${file}#${symbol}`;
        if (seen.has(key)) return { records: [], reason: null, file }; // cycle: already accounted for
        seen.add(key);

        const sf = this.parse(file);
        if (!sf) return { records: [], reason: `cannot parse ${toPosix(file)}`, file: null };

        let found: Harvest | null = null;

        const visit = (node: ts.Node): void => {
            if (found) return;
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbol && node.initializer) {
                const res = this.harvestExpression(node.initializer, file, seen);
                // `export const exports: Record<…> = {}` populated by later top-level
                // `exports['Name'] = …` statements — the table is the declaration PLUS
                // every assignment to it in the same file.
                const assigned = this.harvestAssignmentsTo(file, symbol, sf);
                found = {
                    records: [...res.records, ...assigned],
                    reason: (res.records.length + assigned.length) > 0 ? null : res.reason,
                    file: res.file ?? file,
                };
                return;
            }
            if (ts.isFunctionDeclaration(node) && node.name?.text === symbol && node.body) {
                found = { records: this.harvestFunctionResult(node, file, sf, seen), reason: null, file };
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
        if (found) return found;

        // `export { createX } from './y'` / `export * from './y'`
        for (const stmt of sf.statements) {
            if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
            const target = this.resolveSpecifier(file, stmt.moduleSpecifier.text);
            if (!target) continue;
            if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
                for (const el of stmt.exportClause.elements) {
                    if (el.name.text === symbol) return this.harvestSymbol(target, (el.propertyName ?? el.name).text, seen);
                }
            } else if (!stmt.exportClause) {
                const res = this.harvestSymbol(target, symbol, seen);
                if (res.records.length > 0) return res;
            }
        }

        const imported = this.imports(file).get(symbol);
        if (imported) {
            if (!imported.file) {
                return { records: [], reason: `import "${imported.specifier}" does not resolve to a source file`, file: null };
            }
            return this.harvestSymbol(imported.file, imported.symbol, seen);
        }

        return { records: [], reason: `no definition of \`${symbol}\` in ${toPosix(path.basename(file))}`, file: null };
    }

    /** Every `<table>['Name'] = handler` in one file, for a table held in a variable. */
    private harvestAssignmentsTo(file: string, tableName: string, sf: ts.SourceFile): ImplRecord[] {
        const out: ImplRecord[] = [];
        const walk = (n: ts.Node): void => {
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && ts.isElementAccessExpression(n.left) && ts.isIdentifier(n.left.expression)
                && n.left.expression.text === tableName) {
                const key = literalTextOf(n.left.argumentExpression);
                if (key) out.push(makeRecord(key, n.right, file, sf, n));
            }
            ts.forEachChild(n, walk);
        };
        walk(sf);
        return out;
    }

    /** Object literals a function returns — the `create*Exports` shape, block-bodied or not. */
    private harvestFunctionResult(
        node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
        file: string,
        sf: ts.SourceFile,
        seen: Set<string>
    ): ImplRecord[] {
        const out: ImplRecord[] = [];
        if (!node.body) return out;
        if (!ts.isBlock(node.body)) {
            out.push(...this.harvestExpression(node.body, file, seen).records);
            return out;
        }
        const isNested = (n: ts.Node): boolean =>
            ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
            || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n);
        const locals = new Map<string, ts.ObjectLiteralExpression>();
        const walk = (n: ts.Node): void => {
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
                && ts.isObjectLiteralExpression(n.initializer)) {
                locals.set(n.name.text, n.initializer);
            }
            if (ts.isReturnStatement(n) && n.expression) {
                const expr = n.expression;
                if (ts.isObjectLiteralExpression(expr)) out.push(...this.harvestObject(expr, file, sf, seen));
                else if (ts.isIdentifier(expr) && locals.has(expr.text)) {
                    out.push(...this.harvestObject(locals.get(expr.text)!, file, sf, seen));
                } else out.push(...this.harvestExpression(expr, file, seen).records);
            }
            ts.forEachChild(n, child => { if (!isNested(child)) walk(child); });
        };
        for (const stmt of node.body.statements) walk(stmt);

        // A factory that builds its table by assignment (`exports["X"] = …`) instead of a
        // literal — same shape scanExtraExports handles at file scope.
        const assignWalk = (n: ts.Node): void => {
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && ts.isElementAccessExpression(n.left)) {
                const key = literalTextOf(n.left.argumentExpression);
                if (key && isExportTableExpression(n.left.expression)) {
                    out.push(makeRecord(key, n.right, file, sf, n));
                }
            }
            ts.forEachChild(n, assignWalk);
        };
        assignWalk(node.body);
        return out;
    }

    harvestObject(obj: ts.ObjectLiteralExpression, file: string, sf: ts.SourceFile, seen: Set<string>): ImplRecord[] {
        const out: ImplRecord[] = [];
        for (const prop of obj.properties) {
            if (ts.isSpreadAssignment(prop)) {
                out.push(...this.harvestExpression(prop.expression, file, seen).records);
            } else if (ts.isPropertyAssignment(prop)) {
                const name = literalTextOf(prop.name) ?? (ts.isIdentifier(prop.name) ? prop.name.text : null);
                if (name) out.push(makeRecord(name, prop.initializer, file, sf, prop));
            } else if (ts.isMethodDeclaration(prop)) {
                const name = literalTextOf(prop.name) ?? (ts.isIdentifier(prop.name) ? prop.name.text : null);
                if (name) {
                    out.push({ name, arity: prop.parameters.length, file, line: lineOf(sf, prop), ...cleanupOf(prop) });
                }
            } else if (ts.isShorthandPropertyAssignment(prop)) {
                out.push({ name: prop.name.text, arity: -1, file, line: lineOf(sf, prop) });
            }
        }
        return out;
    }
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function literalTextOf(node: ts.Node | undefined): string | null {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
}

/**
 * The RET N a handler hard-codes. A `{ value, stackCleanup: N }` is the thunk's own claim
 * about its ABI, independent of the descriptor — which is exactly what makes the pair
 * checkable. Returns disagreeing about N leave nothing to check.
 */
function cleanupOf(node: ts.Node): { cleanups?: number[] } {
    const values = new Set<number>();
    const walk = (n: ts.Node): void => {
        if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'stackCleanup') {
            // A computed value is the descriptor's own arg count in disguise; only literals
            // are a claim independent enough to compare against it.
            if (ts.isNumericLiteral(n.initializer)) values.add(parseInt(n.initializer.text, 10));
        }
        ts.forEachChild(n, walk);
    };
    ts.forEachChild(node, walk);
    return values.size > 0 ? { cleanups: [...values].sort((a, b) => a - b) } : {};
}

/** `exports`, `this.exports`, `foo.exports`, `socketExports` — the shapes an export table is held in. */
function isExportTableExpression(expr: ts.Node): boolean {
    if (ts.isIdentifier(expr)) return /^(exports|.*Exports)$/.test(expr.text);
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
        return /^(exports|.*Exports)$/.test(expr.name.text);
    }
    return false;
}

function makeRecord(name: string, init: ts.Expression, file: string, sf: ts.SourceFile, at: ts.Node): ImplRecord {
    const arity = (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init.parameters.length : -1;
    return { name, arity, file, line: lineOf(sf, at), ...cleanupOf(init) };
}

/**
 * Every merge into an export table in one file, resolved to the handlers it contributes.
 * Sites that cannot be followed come back in `unresolved` — the honest half of the answer.
 */
function scanExportMerges(
    file: string,
    graph: SourceGraph,
    isScanned: (f: string) => boolean
): { records: ImplRecord[]; unresolved: UnresolvedMerge[]; sites: number } {
    const sf = graph.parse(file);
    const records: ImplRecord[] = [];
    const unresolved: UnresolvedMerge[] = [];
    let sites = 0;
    if (!sf) return { records, unresolved, sites };

    const take = (src: ts.Expression, at: ts.Node): void => {
        sites++;
        const res = graph.harvestExpression(src, file, new Set());
        records.push(...res.records);
        if (res.records.length > 0) return;
        // Nothing enumerated — but if the source was traced into a file this module already
        // scans handler-by-handler, its names are in the census anyway and the merge is
        // accounted for. Only a source we could neither enumerate NOR place is a hole.
        if (res.file && isScanned(res.file)) return;
        if (!res.reason) return;
        unresolved.push({
            file,
            line: lineOf(sf, at),
            text: at.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
            reason: res.reason,
        });
    };

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const isObjectAssign = ts.isPropertyAccessExpression(callee)
                && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object'
                && ts.isIdentifier(callee.name) && callee.name.text === 'assign';
            const isStubMerge = ts.isIdentifier(callee) && callee.text === 'assignStubsOnce';
            if ((isObjectAssign || isStubMerge) && node.arguments.length >= 2
                && isExportTableExpression(node.arguments[0])) {
                for (const arg of node.arguments.slice(1, isStubMerge ? 2 : undefined)) take(arg, node);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { records, unresolved, sites };
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
function scanExtraExports(filePath: string, graph: SourceGraph): ImplRecord[] {
    const sf = graph.parse(filePath);
    const out: ImplRecord[] = [];
    if (!sf) return out;

    const literalText = literalTextOf;

    /** Harvest `{ 'Name': impl, …spread }` as an export map — spreads followed like any merge. */
    const harvestObjectLiteral = (obj: ts.ObjectLiteralExpression): void => {
        out.push(...graph.harvestObject(obj, filePath, sf, new Set()));
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
            if (onExports && key) out.push(makeRecord(key, node.right, filePath, sf, node));
        }

        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const fname = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
                ? callee.name.text
                : (ts.isIdentifier(callee) ? callee.text : '');
            if ((fname === 'registerFastPath' || fname === 'registerDataExport') && node.arguments.length >= 2) {
                const exportName = literalText(node.arguments[1]);
                if (exportName) out.push({ name: exportName, arity: -1, file: filePath, line: lineOf(sf, node) });
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
        const graph = new SourceGraph();

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
            const unresolvedMerges: UnresolvedMerge[] = [];
            let mergeSites = 0;
            // Keep the most informative sighting of a name: a known arity beats an
            // opaque one (-1), and a handler that takes arguments beats a `() => 0`
            // alias of the same name.
            const remember = (rec: ImplRecord): void => {
                const key = undecorate(rec.name).toLowerCase();
                const prev = implemented.get(key);
                // Sightings of one name are complementary, not competing: the validator's scan
                // knows the parameter list, the merge scan knows the hard-coded RET N. Keep the
                // more informative arity, but never drop an ABI claim by preferring it.
                const keepCleanup = (a: ImplRecord, b: ImplRecord | undefined) =>
                    (a.cleanups === undefined && b?.cleanups) ? { ...a, cleanups: b.cleanups } : a;
                if (!prev || rec.arity > prev.arity) implemented.set(key, keepCleanup(rec, prev));
                else implemented.set(key, keepCleanup(prev, rec));
            };
            for (const f of implFiles) {
                try {
                    for (const info of validator.scanImplementationFile(f)) {
                        remember({ name: info.name, arity: info.params.length, file: info.filePath, line: info.line });
                    }
                    for (const rec of scanExtraExports(f, graph)) remember(rec);
                    // Merges are how most modules actually assemble their table; a scan that
                    // stops at the file boundary reads imagehlp as 3 exports instead of 25.
                    const scannedSet = new Set(implFiles.map(p => path.resolve(p)));
                    const merged = scanExportMerges(f, graph, target => scannedSet.has(path.resolve(target)));
                    for (const rec of merged.records) remember(rec);
                    mergeSites += merged.sites;
                    unresolvedMerges.push(...merged.unresolved.map(u => ({ ...u, file: toPosix(path.relative(repoRoot, u.file)) })));
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
                const originModule = moduleOfImplFile(modulesDir, impl.file);
                exports.set(key, {
                    status: (ignoresArgs || curated) ? 'silent-stub' : 'implemented',
                    argCount,
                    arity: impl.arity,
                    file: toPosix(path.relative(repoRoot, impl.file)),
                    line: impl.line,
                    stackCleanups: impl.cleanups,
                    origin: originModule && originModule !== moduleName ? originModule : undefined,
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
                unresolvedMerges,
                mergeSites,
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
