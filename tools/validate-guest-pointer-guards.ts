/**
 * Quality-gate check: a thunk handler must not WRITE guest memory through a pointer the
 * guest handed it without validating that pointer first.
 *
 * CLAUDE.md §3.1 requires borrowed pointers (app-provided lpSurface, out-params, struct
 * pointers) to be validated against the region map. In ddraw the sanctioned shape is
 * validate-once-at-the-boundary — `isValidAddress(mem, ptr, size, perms)` — and then work
 * through a hoisted `DataView`, because a per-access accessor inside a per-pixel or
 * per-vertex loop fights the zero-alloc rule in the same section. That shape is correct
 * and fast; the problem is that it was a convention nobody could measure, so whole
 * subtrees drifted off it. `ddraw/d3d/` read AND wrote guest structs — SetLight, GetLight,
 * SetMaterial, GetMaterial, GetHandle, CreateDevice's out-params — with nothing but a NULL
 * check, while the mature files next door guarded 2:1.
 *
 * A bounds test is NOT a substitute. `ptr + size <= mem.length` says the address is inside
 * guest RAM; only the region map knows it is not THUNK_CODE, a NOACCESS red zone, or a
 * read-only page. `viewport-impl.ts` shipped a `validateViewportStruct` that checked only
 * bounds and read as validation at all four call sites.
 *
 * WHAT IS CHECKED: writes only. A raw read of a bad pointer yields garbage; a raw write
 * corrupts whatever it lands on, and on an identity-mapped address space it raises no #PF
 * to tell anyone. Reads are worth guarding too, but writes are the class that has to be
 * mechanically impossible to forget, and a rule with no false positives is a rule people
 * keep.
 *
 * Usage: bun tools/validate-guest-pointer-guards.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";

const ROOT = join(import.meta.dir, "..");
/**
 * Handler tables only — the shape this tool models is `Iface_Method: (ctx, mem, args) => …`.
 * The d3d9 BACKEND draw paths take guest pointers too (DrawPrimitiveUP and friends) and are
 * structurally outside that model; guarding those is a code-shape problem, not a scope one.
 */
const SCOPES = [
    join(ROOT, "src", "worker", "modules", "ddraw"),
    join(ROOT, "src", "worker", "modules", "d3d9"),
];

/** Anything that consults the region map, or an accessor that does it internally. */
const VALIDATORS = [
    "isValidAddress",
    "isSafeSurfaceAddress",
    "validateViewportStruct",
    "validateRange",
    "overlapsThunkCode",
];

/**
 * A write only counts when it lands in GUEST memory. Both receivers are resolved
 * syntactically per handler — the raw `mem` array, and any DataView built over
 * `mem.buffer`. Without this the rule also matches `hostMap[state] = value`, where
 * `state` is a scalar the guest passed and the target is a JS object: a false positive,
 * and a check that cries wolf is one people stop reading.
 */
function guestWriteReceivers(body: ts.Node, memParam: string): { views: Set<string>; arrays: Set<string> } {
    const views = new Set<string>();
    const arrays = new Set<string>([memParam]);
    const visit = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
            const init = n.initializer;
            if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)
                && init.expression.text === "DataView"
                && init.arguments?.[0] && derivesFrom(init.arguments[0], new Set([memParam]))) {
                views.add(n.name.text);
            }
            if (ts.isIdentifier(init) && arrays.has(init.text)) arrays.add(n.name.text);
        }
        ts.forEachChild(n, visit);
    };
    visit(body);
    return { views, arrays };
}

interface Finding {
    file: string;
    line: number;
    handler: string;
    pointer: string;
}

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (entry.endsWith(".ts")) yield full;
    }
}

type HandlerFn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

/**
 * Every named function in the file, so a table entry may point at one instead of inlining
 * it. `modules/d3d9/swapchain.ts` writes its whole table as `exports[...] = namedFn`, and
 * a matcher that only accepts an inline function expression reports a clean file having
 * looked at none of it.
 */
function namedFunctions(sf: ts.SourceFile): Map<string, HandlerFn> {
    const fns = new Map<string, HandlerFn>();
    const visit = (n: ts.Node) => {
        if (ts.isFunctionDeclaration(n) && n.name && n.body) fns.set(n.name.text, n);
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
            && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
            fns.set(n.name.text, n.initializer);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return fns;
}

/** `exports["IFoo_Bar"] = <fn | namedFn>` — the shape every thunk table uses. */
function handlerEntry(node: ts.Node, named: Map<string, HandlerFn>): { name: string; fn: HandlerFn } | null {
    if (!ts.isBinaryExpression(node)) return null;
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
    const lhs = node.left;
    if (!ts.isElementAccessExpression(lhs)) return null;
    if (!ts.isStringLiteral(lhs.argumentExpression)) return null;
    const rhs = node.right;
    const name = lhs.argumentExpression.text;
    if (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs)) return { name, fn: rhs };
    if (ts.isIdentifier(rhs)) {
        const fn = named.get(rhs.text);
        if (fn) return { name, fn };
    }
    return null;
}

/** Locals bound directly from `args[N]` — i.e. values the guest chose. */
function guestPointerLocals(body: ts.Node): Set<string> {
    const names = new Set<string>();
    const visit = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
            const init = n.initializer;
            if (ts.isElementAccessExpression(init)
                && ts.isIdentifier(init.expression)
                && init.expression.text === "args") {
                names.add(n.name.text);
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(body);
    return names;
}

/** Does this expression derive from one of `names` (`p`, `p + 4`, `p + OFF.x`)? */
function derivesFrom(expr: ts.Node, names: Set<string>): string | null {
    let hit: string | null = null;
    const visit = (n: ts.Node) => {
        if (hit) return;
        if (ts.isIdentifier(n) && names.has(n.text)) { hit = n.text; return; }
        ts.forEachChild(n, visit);
    };
    visit(expr);
    return hit;
}

function analyse(file: string, findings: Finding[]): void {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = relative(ROOT, file);

    const named = namedFunctions(sf);
    const visitTop = (node: ts.Node) => {
        const entry = handlerEntry(node, named);
        if (entry) {
            const { name, fn } = entry;
            const body = fn.body!;
            const guestPtrs = guestPointerLocals(body);
            const memParam = fn.parameters[1] && ts.isIdentifier(fn.parameters[1].name)
                ? fn.parameters[1].name.text : "mem";
            if (guestPtrs.size > 0) {
                const { views, arrays } = guestWriteReceivers(body, memParam);
                let validated = false;
                const writes: Array<{ node: ts.Node; ptr: string }> = [];

                const scan = (n: ts.Node) => {
                    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
                        && VALIDATORS.includes(n.expression.text)) {
                        validated = true;
                    }
                    // `view.setUint32(addr, …)` on a DataView built over guest memory.
                    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
                        && /^set[A-Z]/.test(n.expression.name.text) && n.arguments.length > 0) {
                        const recv = n.expression.expression;
                        const onGuest = (ts.isIdentifier(recv) && views.has(recv.text))
                            || (ts.isNewExpression(recv) && ts.isIdentifier(recv.expression)
                                && recv.expression.text === "DataView"
                                && !!recv.arguments?.[0]
                                && !!derivesFrom(recv.arguments[0], new Set([memParam])));
                        if (onGuest) {
                            const ptr = derivesFrom(n.arguments[0]!, guestPtrs);
                            if (ptr) writes.push({ node: n, ptr });
                        }
                    }
                    // `mem[addr] = …` — only when the receiver IS the guest array.
                    if (ts.isBinaryExpression(n)
                        && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
                        && ts.isElementAccessExpression(n.left)
                        && ts.isIdentifier(n.left.expression)
                        && arrays.has(n.left.expression.text)) {
                        const ptr = derivesFrom(n.left.argumentExpression, guestPtrs);
                        if (ptr) writes.push({ node: n, ptr });
                    }
                    ts.forEachChild(n, scan);
                };
                scan(body);

                if (!validated) {
                    for (const w of writes) {
                        const { line } = sf.getLineAndCharacterOfPosition(w.node.getStart());
                        findings.push({ file: rel, line: line + 1, handler: name, pointer: w.ptr });
                    }
                }
            }
        }
        ts.forEachChild(node, visitTop);
    };
    visitTop(sf);
}

const findings: Finding[] = [];
for (const scope of SCOPES) for (const file of walk(scope)) analyse(file, findings);

if (findings.length === 0) {
    console.log(`Guest-pointer guards OK — every ddraw/d3d9 handler that writes through a guest pointer validates it.`);
    process.exit(0);
}

console.error(`Guest-pointer guard violations (${findings.length}):\n`);
for (const f of findings) {
    console.error(`  ${f.file.split(sep).join("/")}:${f.line}  ${f.handler} writes through '${f.pointer}' with no validation`);
}
console.error(
    `\nValidate the whole extent once at the top of the handler:\n` +
    `  if (!ptr || !isValidAddress(mem, ptr, SIZE, "rw")) return DDERR_INVALIDPARAMS;\n` +
    `then keep using the hoisted DataView — the loop stays unguarded on purpose (CLAUDE.md §3.1).\n` +
    `A bounds test against mem.length is not validation: only the region map knows the target\n` +
    `is not THUNK_CODE, a red zone, or read-only.`);
process.exit(1);
