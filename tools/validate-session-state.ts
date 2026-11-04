#!/usr/bin/env bun
/**
 * Gate step: per-session mutable state census (savestates, issue #66).
 *
 * Every module-scope mutable binding, and every one inside a `create*Exports()` factory
 * closure, is state that outlives a guest session unless something resets it, and that a
 * savestate cannot reach unless it is registered. Such a binding must either belong to a
 * registered session store (annotate `@session-state` on or above its declaration) or say
 * why it is not per-session state (`@transient(reason)`).
 *
 * The bindings that existed when the rule landed are PINNED per file in
 * tools/session-state-census.json, so the class can shrink but never grow: a new
 * unannotated binding fails here, and a file whose count dropped asks for the pin to be
 * tightened (`bun tools/validate-session-state.ts --update`).
 *
 * WHAT IT MATCHES: `let`/`var` at module scope, `const X = new Map|Set|WeakMap|WeakSet|Array`
 * and `const X = []` at module scope, and the same at the top level of a factory function
 * named `create…Exports`. A container hidden behind another name or built by a helper walks
 * past this; the pinned counts still move when a file's state moves.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "src", "worker");
const PIN = join(import.meta.dir, "session-state-census.json");

const MODULE_BINDING = /^(?:export\s+)?(?:(?:let|var)\s+[\w$]+|const\s+[\w$]+\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b|\[\]))/;
const FACTORY_START = /^(?:export\s+)?function\s+create\w*Exports\s*\(/;
const FACTORY_BINDING = /^ {4}(?:(?:let|var)\s+[\w$]+|const\s+[\w$]+\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b|\[\]))/;
const ANNOTATED = /@session-state\b|@transient\(/;

function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full, out); continue; }
        if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(full);
    }
}

export function censusOf(source: string): number {
    const lines = source.split("\n");
    let count = 0;
    let inFactory = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (FACTORY_START.test(line)) { inFactory = true; continue; }
        if (inFactory && line.startsWith("}")) { inFactory = false; continue; }
        const hit = inFactory ? FACTORY_BINDING.test(line) : MODULE_BINDING.test(line);
        if (!hit) continue;
        if (ANNOTATED.test(line) || (i > 0 && ANNOTATED.test(lines[i - 1]!))) continue;
        count++;
    }
    return count;
}

function main(): void {
    const files: string[] = [];
    walk(ROOT, files);
    const current: Record<string, number> = {};
    for (const f of files.sort()) {
        const n = censusOf(readFileSync(f, "utf8"));
        if (n > 0) current[relative(join(ROOT, "..", ".."), f).split(sep).join("/")] = n;
    }
    if (process.argv.includes("--update")) {
        writeFileSync(PIN, JSON.stringify(current, null, 2) + "\n");
        const total = Object.values(current).reduce((a, b) => a + b, 0);
        console.log(`session-state census pinned: ${total} bindings in ${Object.keys(current).length} files`);
        return;
    }
    const pinned = JSON.parse(readFileSync(PIN, "utf8")) as Record<string, number>;
    const grew: string[] = [], shrank: string[] = [];
    for (const [file, n] of Object.entries(current)) {
        const p = pinned[file] ?? 0;
        if (n > p) grew.push(`${file}: ${p} → ${n}`);
        else if (n < p) shrank.push(`${file}: ${p} → ${n}`);
    }
    for (const [file, p] of Object.entries(pinned)) if (!(file in current)) shrank.push(`${file}: ${p} → 0`);
    if (shrank.length) console.log(`session-state census shrank (tighten the pin with --update):\n  ${shrank.join("\n  ")}`);
    if (grew.length) {
        console.error(`New per-session mutable state without @session-state / @transient(reason):\n  ${grew.join("\n  ")}`);
        process.exit(1);
    }
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    console.log(`session-state census OK: ${total} pinned bindings in ${Object.keys(current).length} files`);
}

if (import.meta.main) main();
