#!/usr/bin/env bun
/**
 * Gate step: a PLAIN guest-RAM view may not outlive the turn that derived it.
 *
 * `process.getCurrentMemory()` normalizes v86's growth-transparent Proxy into a plain
 * Uint8Array, which is ~25x faster per element and detaches the instant WASM memory grows.
 * Detachment is silent at the store and loud much later: `.subarray()` throws
 * "Cannot perform Construct on a detached ArrayBuffer", while plain indexing just reads
 * undefined. Growth is issued from inside v86.wasm's own allocator, so it happens at no
 * point any call site can predict.
 *
 * The accessor's safety argument — "no `this.x = getCurrentMemory()` anywhere, every
 * consumer re-fetches" — is load-bearing, and prose cannot hold it: the shapes that
 * violate it mostly do not name the accessor at all.
 *
 * THE RULE — three shapes, because a stored view is reached three ways:
 *   1. stored directly:  `this.mem = process.getCurrentMemory()`
 *   2. handed to a constructor/factory that stores it:  `new Device(backend, mem())`
 *   3. the same, through a local:  `const m = mem(); createCtx(process, m)`
 *
 * ...each reachable either through the root accessor or through a module's own one-line
 * wrapper around it (`getMemory()`), which is how nearly every HLE module spells it. The
 * wrappers are collected first (see WRAPPER_DECLS) and then count as accessors, because a
 * check that greps only for the root reads a tree as clean while five modules hold a view
 * in a field.
 *
 * Deriving a view and USING it in the same turn is the sanctioned pattern and is not
 * flagged — including handing it to an ordinary function, or building a DataView/typed
 * array over its buffer. What this cannot see is a view held across an `await` inside one
 * function; that needs dataflow. Shapes 1-3 are what actually shipped, and they are a grep.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "src", "worker");

/** The accessors that yield a plain, detachable view. */
const ROOT_ACCESSOR = /\bgetCurrentMemory\s*\(\s*\)|\btoPlainGuestMemory\s*\(/;

/**
 * Almost NOTHING calls the root accessor on the line that stores the result. Every HLE
 * module wraps it in a one-line `getMemory()` of its own and writes
 * `this.memory = this.getMemory()`, which names neither accessor — so a check that greps
 * only for the root sees a clean tree while the shape it exists to forbid is in five
 * modules at once. The wrapper names are collected first and then count as accessors
 * everywhere, which is also what makes a cross-file wrapper (mss32/helpers.ts exports
 * one) reachable from the files that call it.
 *
 * Matched declaration shapes, all of them one-expression bodies that RETURN the view:
 *   getMemory(): Uint8Array { return this.process.getCurrentMemory(); }
 *   function getMemory(ctx) { return ctx.process.getCurrentMemory(); }
 *   const getMem = () => ctx.process.getCurrentMemory();
 *   getMemory: () => process.getCurrentMemory(),
 * A getter (`private get memory()`) is deliberately NOT collected: re-deriving per read
 * is the sanctioned pattern, and `.memory` is too common a property name to taint.
 */
const WRAPPER_DECLS: RegExp[] = [
    /(?<!\bget\s+)(?:function\s+)?([\w$]+)\s*\([^()]*\)\s*(?::[^{;]+)?\{\s*return\s+[^;{}]*(?:getCurrentMemory\s*\(\s*\)|toPlainGuestMemory\s*\([^;{}]*\))\s*;?\s*\}/g,
    /(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:\([^()]*\)|[\w$]+)\s*=>\s*[^;{}]*(?:getCurrentMemory\s*\(\s*\)|toPlainGuestMemory\s*\()/g,
    /([\w$]+)\s*:\s*(?:\([^()]*\)|[\w$]+)\s*=>\s*[^;,{}]*(?:getCurrentMemory\s*\(\s*\)|toPlainGuestMemory\s*\()/g,
];

function collectWrapperNames(sources: string[]): Set<string> {
    const names = new Set<string>();
    for (const src of sources) {
        for (const re of WRAPPER_DECLS) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(src)) !== null) {
                const name = m[1]!;
                // `return` / `if` etc. can be captured by the call-shaped pattern.
                if (!/^(return|if|for|while|switch|catch)$/.test(name)) names.add(name);
            }
        }
    }
    return names;
}

/** Root accessor, or a call to any wrapper that returns one. */
function makeAccessorTest(wrappers: Set<string>): (code: string) => boolean {
    const alt = [...wrappers].map((n) => n.replace(/[$]/g, "\\$")).join("|");
    const wrapperCall = alt ? new RegExp(`\\b(?:${alt})\\s*\\(`) : null;
    return (code) => ROOT_ACCESSOR.test(code) || (!!wrapperCall && wrapperCall.test(code));
}

/**
 * `new X(...)` receivers that BUILD a view over the buffer rather than retaining the
 * argument — the whole point of deriving a view is to read through one of these.
 */
const VIEW_CTORS = new Set([
    "DataView", "Uint8Array", "Uint8ClampedArray", "Int8Array",
    "Uint16Array", "Int16Array", "Uint32Array", "Int32Array",
    "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
]);

/** `<recv>.<field> = <expr>` — the direct store (shape 1). */
const MEMBER_STORE = /(?:this|[\w$]+)\s*(?:\?\.|\.)[\w$]+\s*=\s*[^=]/;

/** `new Foo(` / `createFoo(` / `makeFoo(` — callees whose job is to keep what they are given. */
const RETAINING_CALL = /\bnew\s+([A-Z][\w$]*)\s*\(|\b(create[A-Z][\w$]*|make[A-Z][\w$]*)\s*\(/g;

/**
 * `create*` callees VERIFIED to consume the view within the call and retain nothing.
 * Named individually, with the evidence, rather than loosening the pattern: the whole
 * point of the shape is that a `create*` normally does keep what it is handed.
 */
const SYNCHRONOUS_CALLEES = new Set([
    // scheduler.ts createThread: fill()s the new stack, builds a DataView, writes the out
    // thread id — all before it returns, and stores no view on the thread record.
    "createThread",
    // mss32/helpers.ts makeView: `return new DataView(mem.buffer, ...)` and nothing else —
    // a view builder, the same class as VIEW_CTORS, just spelled as a helper.
    "makeView",
    // dinput createDevice8Object / dplayx createDirectPlayInGuest: each forwards `mem` to
    // allocateComObject and returns the guest address. Neither keeps a reference.
    "createDevice8Object",
    "createDirectPlayInGuest",
]);

/**
 * String and template literals, removed before matching. A wrapper named `memory` or
 * `getMem` appears in ordinary prose ("no guest memory (no process loaded?)"), and a
 * check that reads its own error messages as code reports sites that do not exist.
 */
function stripLiterals(code: string): string {
    return code.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

/** `const|let|var NAME = <expr>` */
const LOCAL_DECL = /\b(?:const|let|var)\s+([\w$]+)\s*=/;

/**
 * Sites that predate this check, pinned EXACTLY (the shape validate-file-cursor and
 * validate-guest-memory-borrow use): fixing one means editing the number, which is a
 * reviewable line in a diff; adding one fails the gate.
 */
const LEGACY = new Map<string, number>([]);

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
}

/** Names of the retaining callees on a line, ignoring the view-building constructors. */
function retainingCallees(code: string): string[] {
    const names: string[] = [];
    RETAINING_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RETAINING_CALL.exec(code)) !== null) {
        const name = m[1] ?? m[2]!;
        if (!VIEW_CTORS.has(name) && !SYNCHRONOUS_CALLEES.has(name)) names.push(name);
    }
    return names;
}

type Offender = { file: string; line: number; shape: string; text: string };
const offenders: Offender[] = [];
const legacySeen = new Map<string, number>();

const FILES = walk(ROOT);
const SOURCES = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const WRAPPERS = collectWrapperNames([...SOURCES.values()]);
const isAccessor = makeAccessorTest(WRAPPERS);

for (const file of FILES) {
    const rel = relative(ROOT, file).split(sep).join("/");
    // The normalizer and the accessor themselves necessarily name it.
    if (rel === "core/memory/guest-memory.ts" || rel === "core/process.ts") continue;

    const lines = SOURCES.get(file)!.split(/\r?\n/);
    /** Locals in this file currently holding a plain view (shape 3). */
    const tainted = new Set<string>();

    lines.forEach((text, i) => {
        const code = stripLiterals(text.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""));
        const hit = (shape: string): void => {
            if (LEGACY.has(rel)) { legacySeen.set(rel, (legacySeen.get(rel) ?? 0) + 1); return; }
            offenders.push({ file: rel, line: i + 1, shape, text: text.trim() });
        };

        if (isAccessor(code)) {
            // 1 — stored into a field/property.
            if (MEMBER_STORE.test(code)) hit("stored in a field");
            // 2 — handed straight to something that retains it.
            else if (retainingCallees(code).length > 0) hit("passed to a constructor/factory");
            // Otherwise it is a local or a direct use; remember the local for shape 3.
            const decl = LOCAL_DECL.exec(code);
            if (decl) tainted.add(decl[1]!);
            return;
        }

        // 3 — a local that holds a view, later handed to something that retains it.
        if (tainted.size === 0) return;
        const callees = retainingCallees(code);
        if (callees.length === 0) return;
        for (const name of tainted) {
            // The identifier as a bare argument: `f(a, mem)` / `f(mem)` — not `mem.buffer`.
            if (new RegExp(`[(,]\\s*${name}\\s*[,)]`).test(code)) {
                hit(`local '${name}' passed to ${callees.join("/")}`);
                return;
            }
        }
    });
}

const drifted: string[] = [];
for (const [rel, expected] of LEGACY) {
    const found = legacySeen.get(rel) ?? 0;
    if (found !== expected) drifted.push(`  ${rel}: ${found} site(s), pinned at ${expected}`);
}

if (drifted.length > 0) {
    console.error("The pinned legacy stored-view count changed:\n");
    for (const d of drifted) console.error(d);
    console.error("\nFixed one? Lower the number. Added one? Re-derive per use instead.\n");
    process.exit(1);
}

if (offenders.length > 0) {
    console.error(
        `Stored guest-memory view — ${offenders.length} site(s) keep a PLAIN view past the turn\n` +
        `that derived it. WASM growth detaches it, and the throw lands far from here.\n` +
        `Call process.getCurrentMemory() per use instead of storing or handing on the result.\n`
    );
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  [${o.shape}]  ${o.text}`);
    process.exit(1);
}

const legacyTotal = [...LEGACY.values()].reduce((a, b) => a + b, 0);
console.log(
    `Guest-memory view lifetime OK — no plain view stored past its turn` +
    ` (${WRAPPERS.size} accessor wrapper(s) tracked` +
    (legacyTotal > 0 ? `, ${legacyTotal} pinned legacy site(s)` : "") + ").",
);
