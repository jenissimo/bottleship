#!/usr/bin/env bun
/**
 * Gate step: per-session mutable state census (savestates, issue #66).
 *
 * A mutable binding that lives outside a function call outlives a guest session unless
 * something resets it, and a savestate cannot reach it unless it is registered. Such a
 * binding must either move into a registered store (one that System.reset() walks, see
 * core/session-state.ts) or say why it is not per-session state, with
 * `@transient(reason)` on or directly above its declaration. The reason must not be empty.
 *
 * The bindings that existed when the rule landed are PINNED BY NAME per file in
 * tools/session-state-census.json, exactly, the way validate-cpu-proxy-reads pins its
 * sites: a name that is not pinned fails (NEW), a pinned name that is gone fails (DRIFT),
 * and a pinned file with no bindings left fails (STALE PIN). Removing a binding is a
 * reviewable line in the pin diff (`bun tools/validate-session-state.ts --update`);
 * swapping one binding for another in the same file cannot pass unnoticed.
 *
 * SAVESTATE COVERAGE. A module that a savestate participant `covers` (the DLL names in
 * `covers: [...]`, matched to src/worker/modules/<dll>/, <dll>.ts and <dll>-*.ts) must
 * classify every binding in its files, pinned or not, with one of
 *   - `@participant(<id>)`: a participant captures it; the id must be listed in
 *     savestate/participant-ids.ts;
 *   - `@refuse(<reason>)`: capture refuses while it holds anything;
 *   - `@transient(<reason>)`: not per-session state.
 * A classified binding leaves the pin like a `@transient` one does.
 *
 * WHAT IT MATCHES, on code with comments, strings and regex literals blanked and braces
 * counted (so indentation does not matter):
 *   - module scope: `let` / `var`, and `const X = new Ctor(…)` / `const X = []`, with or
 *     without a type annotation (including one that contains `=>`). `new Ctor(` covers the
 *     class singletons (`export const registry = new HandleRegistry()`), Map/Set, typed
 *     arrays, ArrayBuffer and DataView alike;
 *   - the same at the top level of a `create…Exports` factory, written as a function
 *     declaration or as an arrow / function expression bound to a const;
 *   - `static` class fields at any depth: every non-readonly one (this includes the
 *     `private static instance` behind getInstance() singletons), and readonly ones whose
 *     initializer is `new Ctor(…)` or `[]`.
 *
 * WHAT IT DOES NOT SEE. The census counts what a line scan can name; it is not a list of all
 * session state, and the pinned total must not be read as one.
 *   Inside src/worker, by construction of a line scan:
 *   - object-literal stores (`const state = { count: 0 }`) and other containers built by a
 *     helper or hidden behind another name (`const m = makeCache()`);
 *   - a declaration whose initializer starts on the next line, and every name after the
 *     first in `let a = 0, b = 0` (the file's pin still moves when the first one does);
 *   - instance fields of long-lived objects (their owner is the unit; most are reset
 *     through a registered store);
 *   - closures inside functions other than create…Exports factories.
 *   Outside src/worker/*.ts, by design (issue #66 §9 treats these as explicit savestate
 *   participants, not census items):
 *   - Rust/WASM statics in v86 and in the AOT;
 *   - the AudioWorklet on the main thread;
 *   - the D3D9 render worker;
 *   - the io-worker.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO = join(import.meta.dir, "..");
const ROOT = join(REPO, "src", "worker");
const PIN = join(import.meta.dir, "session-state-census.json");

const TYPE = String.raw`(?::(?:[^=]|=>)*)?`;
const CONTAINER = String.raw`(?:new\s+[A-Z][\w$.]*\s*[<(]|\[\s*\])`;
const MUTABLE = new RegExp(
    String.raw`^(?:export\s+)?(?:declare\s+)?(?:(?:let|var)\s+([\w$]+)|const\s+([\w$]+)\s*${TYPE}=(?![=>])\s*${CONTAINER})`,
);
const FACTORY_START = [
    /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(create\w*Exports)\s*[<(]/,
    /^(?:export\s+)?(?:const|let|var)\s+(create\w*Exports)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\(|[\w$]+\s*=>|<)/,
];
const STATIC_FIELD = new RegExp(
    String.raw`^(?:(?:public|private|protected|declare|override)\s+)*static\s+(readonly\s+)?([\w$#]+)\s*[?!]?\s*(?:${TYPE}=(?![=>])\s*(.*)|:.*|;)$`,
);
const CLASS_DECL = /\bclass\s+([\w$]+)/;
const TRANSIENT = /@transient\(([^)]*)\)/;
const ANNOTATION = /@(transient|participant|refuse)\(([^)]*)\)/;
const COVERS = /\bcovers\s*:\s*\[([^\]]*)\]/g;
const QUOTED = /['"]([^'"]+)['"]/g;
const PARTICIPANT_IDS = join("savestate", "participant-ids.ts");
const STATELESS_MODULES = join("savestate", "stateless-modules.ts");
const STATELESS_ENTRY = /^\s*(['"]?)([\w.-]+)\1\s*:\s*(['"])(.*?)\3\s*,?\s*$/;
const BARE_REASON = /^(?:stateless|no state|nothing|none|n\/a)\.?$/i;

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|yield|await|do)$/;

/** Blank comments, string/template contents and regex literals, keeping line structure. */
export function stripNonCode(src: string): string {
    const out = src.split("");
    const blank = (from: number, to: number) => {
        for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
    };
    let i = 0;
    while (i < src.length) {
        const ch = src[i]!, next = src[i + 1];
        if (ch === "/" && next === "/") {
            let j = i; while (j < src.length && src[j] !== "\n") j++;
            blank(i, j); i = j;
        } else if (ch === "/" && next === "*") {
            let j = src.indexOf("*/", i + 2); j = j < 0 ? src.length : j + 2;
            blank(i, j); i = j;
        } else if (ch === "`") {
            const j = templateEnd(src, i + 1);
            blank(i + 1, Math.max(i + 1, j - 1)); i = j;
        } else if (ch === '"' || ch === "'") {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === "\\") { j += 2; continue; }
                if (src[j] === ch) { j++; break; }
                if (src[j] === "\n") break;
                j++;
            }
            blank(i + 1, Math.max(i + 1, j - 1)); i = j;
        } else if (ch === "/" && startsRegex(out, i)) {
            const j = regexEnd(src, i + 1);
            blank(i + 1, Math.max(i + 1, j - 1)); i = j;
        } else {
            i++;
        }
    }
    return out.join("");
}

/** Index just past the closing slash of a regex literal whose body starts at `from` (flags stay code). */
function regexEnd(src: string, from: number): number {
    let j = from, inClass = false;
    while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) return j + 1;
        j++;
    }
    return j;
}

/** Index just past the closing backtick of a template literal whose body starts at `from`; `${…}` may nest. */
function templateEnd(src: string, from: number): number {
    let j = from;
    while (j < src.length) {
        const c = src[j]!;
        if (c === "\\") { j += 2; continue; }
        if (c === "`") return j + 1;
        if (c === "$" && src[j + 1] === "{") {
            j += 2;
            let depth = 1;
            while (j < src.length && depth > 0) {
                const e = src[j]!;
                if (e === "`") { j = templateEnd(src, j + 1); continue; }
                if (e === '"' || e === "'") {
                    j++;
                    while (j < src.length && src[j] !== e && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
                    j++;
                    continue;
                }
                if (e === "/" && src[j + 1] !== "/" && src[j + 1] !== "*" && startsRegex(src, j)) {
                    j = regexEnd(src, j + 1);
                    continue;
                }
                if (e === "{") depth++;
                else if (e === "}") depth--;
                j++;
            }
            continue;
        }
        j++;
    }
    return j;
}

function startsRegex(code: string | string[], at: number): boolean {
    let k = at - 1;
    while (k >= 0 && (code[k] === " " || code[k] === "\t" || code[k] === "\r")) k--;
    if (k < 0 || code[k] === "\n") return true;
    const prev = code[k]!;
    if ("(,=:[!&|?{};+-*%<>~^".includes(prev)) return true;
    if (!/[\w$]/.test(prev)) return false;
    let s = k; while (s > 0 && /[\w$]/.test(code[s - 1]!)) s--;
    const word = code.slice(Math.max(0, s - 1), k + 1);
    return REGEX_AFTER_WORD.test(typeof word === "string" ? word : word.join(""));
}

export interface Census {
    /** Unannotated binding names, in source order: `name`, `factory.name` or `static Class.field`. */
    names: string[];
    /** 1-based lines carrying `@transient()`, `@participant()` or `@refuse()` with an empty argument. */
    emptyReasons: number[];
    /** `@participant(<id>)` annotations, by 1-based line. */
    participants: { line: number; id: string }[];
    /** 1-based lines carrying `@refuse(<reason>)`. */
    refusals: number[];
}

export function censusOf(source: string): Census {
    const raw = source.split(/\r?\n/);
    const code = stripNonCode(source).split(/\r?\n/);
    const names: string[] = [];
    const emptyReasons: number[] = [];
    const participants: { line: number; id: string }[] = [];
    const refusals: number[] = [];
    const classes: { name: string; depth: number }[] = [];
    let depth = 0;
    let factory: { name: string; entered: boolean } | null = null;

    const annotation = (i: number): "ok" | "empty" | "none" => {
        for (const line of [raw[i]!, i > 0 ? raw[i - 1]! : ""]) {
            const m = ANNOTATION.exec(line);
            if (!m) continue;
            const arg = m[2]!.trim();
            if (!arg) return "empty";
            if (m[1] === "participant") participants.push({ line: i + 1, id: arg });
            if (m[1] === "refuse") refusals.push(i + 1);
            return "ok";
        }
        return "none";
    };
    const record = (i: number, name: string) => {
        const a = annotation(i);
        if (a === "ok") return;
        if (a === "empty") emptyReasons.push(i + 1);
        names.push(name);
    };

    for (let i = 0; i < code.length; i++) {
        const line = code[i]!.trim();
        while (classes.length && classes[classes.length - 1]!.depth > depth) classes.pop();

        if (depth === 0 && !factory) {
            for (const re of FACTORY_START) {
                const m = re.exec(line);
                if (m) { factory = { name: m[1]!, entered: false }; break; }
            }
        }
        if (depth === 0 && !factory?.entered) {
            const m = MUTABLE.exec(line);
            if (m) record(i, m[1] ?? m[2]!);
        } else if (factory && factory.entered && depth === 1) {
            const m = MUTABLE.exec(line);
            if (m) record(i, `${factory.name}.${m[1] ?? m[2]!}`);
        }

        const s = STATIC_FIELD.exec(line);
        if (s) {
            const readonly = !!s[1];
            const init = s[3];
            const mutable = !readonly || (init !== undefined && new RegExp(`^${CONTAINER}`).test(init));
            if (mutable) {
                const owner = classes.find(c => c.depth === depth)?.name ?? "?";
                record(i, `static ${owner}.${s[2]!}`);
            }
        }

        const cls = CLASS_DECL.exec(line);
        const before = depth;
        let peak = depth;
        for (const ch of code[i]!) {
            if (ch === "{") peak = Math.max(peak, ++depth);
            else if (ch === "}") depth--;
        }
        if (cls && peak > before) classes.push({ name: cls[1]!, depth: before + 1 });
        if (factory) {
            if (!factory.entered) factory.entered = depth > 0;
            else if (depth === 0) factory = null;
        }
    }
    return { names, emptyReasons, participants, refusals };
}

/** The DLL a file under src/worker implements, by the modules/<dll>… layout; null outside it. */
export function moduleOfFile(relToRoot: string): string | null {
    const m = /^modules\/([^/]+?)(?:\/|\.ts$|-[^/]*\.ts$)/.exec(relToRoot);
    return m ? m[1]!.toLowerCase() : null;
}

export function statelessModulesOf(source: string): { modules: Map<string, string>; bad: string[] } {
    const modules = new Map<string, string>();
    const bad: string[] = [];
    const lines = source.split(/\r?\n/);
    let inside = false;
    lines.forEach((line, i) => {
        if (/STATELESS_MODULES\b[^=]*=\s*\{/.test(line)) { inside = true; return; }
        if (!inside) return;
        if (/^\s*\}/.test(line)) { inside = false; return; }
        if (!line.trim()) return;
        const m = STATELESS_ENTRY.exec(line);
        if (!m) { bad.push(`${i + 1}: cannot read the entry`); return; }
        const reason = m[4]!.trim();
        if (!reason || BARE_REASON.test(reason)) bad.push(`${i + 1}: ${m[2]} needs a reason that says why nothing survives a call`);
        modules.set(m[2]!.toLowerCase(), reason);
    });
    return { modules, bad };
}

/** DLL names some participant lists in `covers: [...]` anywhere in the scanned tree. */
export function coveredModulesOf(sources: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const src of sources) {
        const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        for (const m of code.matchAll(COVERS)) {
            for (const q of m[1]!.matchAll(QUOTED)) {
                const name = q[1]!.toLowerCase().replace(/\.(dll|drv|exe)$/, "");
                if (name !== "*") out.add(name);
            }
        }
    }
    return out;
}

function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full, out); continue; }
        if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(full);
    }
}

export interface CensusOptions {
    /** Directory to scan. */
    root: string;
    /** Directory the pinned file keys are relative to. */
    base: string;
    /** Pin file. */
    pin: string;
    /** Rewrite the pin from the tree instead of checking it. */
    update?: boolean;
}

export interface CensusResult { ok: boolean; lines: string[] }

interface FileCensus { rel: string; module: string | null; census: Census; source: string }

function checkCoverage(root: string, scanned: FileCensus[]): string[] {
    const problems: string[] = [];
    const covered = coveredModulesOf(scanned.map(f => f.source));
    const ids = new Set<string>();
    try {
        const text = readFileSync(join(root, PARTICIPANT_IDS), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        for (const q of text.matchAll(QUOTED)) ids.add(q[1]!);
    } catch {
        ids.clear();
    }
    let stateless = new Map<string, string>();
    try {
        const parsed = statelessModulesOf(readFileSync(join(root, STATELESS_MODULES), "utf8"));
        stateless = parsed.modules;
        for (const b of parsed.bad) problems.push(`  STATELESS REASON: ${STATELESS_MODULES.split(sep).join("/")}:${b}`);
    } catch {
        stateless.clear();
    }
    for (const name of stateless.keys()) {
        if (covered.has(name)) problems.push(`  STATELESS AND COVERED: ${name} — a participant covers it, so it cannot also be declared stateless`);
    }
    for (const { rel, module, census } of scanned) {
        if (module && stateless.has(module)) {
            const lines = [...census.participants.map(p => p.line), ...census.refusals].sort((a, b) => a - b);
            if (lines.length) problems.push(`  STATEFUL: ${rel}:${lines.join(",")} — ${module} is declared stateless, but a binding here is captured or refused`);
            if (census.names.length) problems.push(`  UNCLASSIFIED: ${rel} — ${census.names.join(", ")} (${module} is declared stateless: annotate each @transient(reason))`);
        }
        for (const p of census.participants) {
            if (!ids.has(p.id)) problems.push(`  UNKNOWN PARTICIPANT: ${rel}:${p.line} — ${p.id} is not listed in ${PARTICIPANT_IDS.split(sep).join("/")}`);
        }
        if (module && covered.has(module) && census.names.length) {
            problems.push(`  UNCLASSIFIED: ${rel} — ${census.names.join(", ")} (${module} is covered by a savestate participant)`);
        }
    }
    return problems;
}

/** Compare the tree against the pin (or rewrite it). Never exits; main() does. */
export function runCensus(opts: CensusOptions): CensusResult {
    const files: string[] = [];
    walk(opts.root, files);
    const current: Record<string, string[]> = {};
    const problems: string[] = [];
    const scanned: FileCensus[] = [];
    for (const f of files.sort()) {
        const rel = relative(opts.base, f).split(sep).join("/");
        const source = readFileSync(f, "utf8");
        const census = censusOf(source);
        scanned.push({ rel, module: moduleOfFile(relative(opts.root, f).split(sep).join("/")), census, source });
        for (const line of census.emptyReasons) problems.push(`  EMPTY REASON: ${rel}:${line} — the annotation needs a reason or a participant id`);
        if (census.names.length) current[rel] = [...census.names].sort();
    }
    problems.push(...checkCoverage(opts.root, scanned));
    const total = (m: Record<string, string[]>) => Object.values(m).reduce((a, b) => a + b.length, 0);

    if (opts.update) {
        writeFileSync(opts.pin, JSON.stringify(current, null, 2) + "\n");
        return {
            ok: problems.length === 0,
            lines: [...problems, `session-state census pinned: ${total(current)} bindings in ${Object.keys(current).length} files`],
        };
    }

    const pinned = JSON.parse(readFileSync(opts.pin, "utf8")) as Record<string, string[]>;
    for (const [file, names] of Object.entries(current)) {
        const pin = pinned[file];
        if (!pin) { problems.push(`  NEW: ${file} — ${names.join(", ")}`); continue; }
        const left = [...pin];
        const added: string[] = [];
        for (const n of names) {
            const k = left.indexOf(n);
            if (k >= 0) left.splice(k, 1); else added.push(n);
        }
        if (added.length) problems.push(`  NEW: ${file} — ${added.join(", ")}`);
        if (left.length) problems.push(`  DRIFT: ${file} — pinned but gone: ${left.join(", ")}`);
    }
    for (const [file, names] of Object.entries(pinned)) {
        if (!(file in current)) problems.push(`  STALE PIN: ${file} — pinned ${names.join(", ")}, none found; delete the entry`);
    }

    if (problems.length) {
        return {
            ok: false,
            lines: [
                "Per-session mutable state census CHANGED.\n\n" +
                "A NEW binding outlives the guest session: move it into a store that System.reset()\n" +
                "walks (core/session-state.ts), or annotate it `@transient(reason)`. A DRIFT or\n" +
                "STALE PIN means a pinned binding is gone: re-pin with --update so the pin stays exact.\n" +
                "UNCLASSIFIED bindings sit in a module a savestate participant covers: annotate each with\n" +
                "`@participant(<id>)`, `@refuse(reason)` or `@transient(reason)`.\n",
                ...problems,
            ],
        };
    }
    return {
        ok: true,
        lines: [`session-state census OK: ${total(current)} pinned bindings in ${Object.keys(current).length} files`],
    };
}

function main(): void {
    const result = runCensus({ root: ROOT, base: REPO, pin: PIN, update: process.argv.includes("--update") });
    (result.ok ? console.log : console.error)(result.lines.join("\n"));
    if (!result.ok) process.exit(1);
}

if (import.meta.main) main();
