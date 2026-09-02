#!/usr/bin/env bun
/**
 * validate-wgsl-calls: does every call to a shader helper we WROTE pass the number of
 * arguments that helper declares?
 *
 * Our WGSL lives in TypeScript template strings, so it is a string to the type checker
 * and to every linter: adding a parameter to a shared `fn` and missing a call site is a
 * clean typecheck and a clean test run. The mismatch surfaces at pipeline-creation time
 * as `Error while parsing WGSL: too few arguments in call to 'X'`, which invalidates the
 * shader module, then the pipeline, then every draw in that pass — the game presents
 * black. GTA Vice City did exactly that when `ffpFogFactor` grew an `eyeDistance`
 * parameter and the ddraw generator kept calling it with seven.
 *
 * The check is deliberately narrow so it cannot cry wolf: only names declared as `fn` in
 * our own sources are considered, and a name declared with two different arities is
 * reported as ambiguous rather than guessed at.
 *
 * A `${...}` argument is an expression, so its commas are not separators — but it can also
 * expand to text that CONTAINS a separator (`vsBool(${storage ? "_bsInstance, " : ""}${n}u)`
 * calls a one-parameter helper with two arguments in one branch). An interpolation is
 * therefore EXPANDED when its expansions are knowable — a body with no comma-bearing literal
 * is one argument, and a conditional between string literals is checked once per branch —
 * and only a genuinely unknowable one is skipped.
 *
 * Usage: bun tools/validate-wgsl-calls.ts [--json]
 * Exits 1 on any mismatch.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const SCAN_DIRS = ["src/worker", "src/app"];

interface Decl { name: string; arity: number; file: string; line: number }
interface Mismatch { name: string; file: string; line: number; got: number; want: number; snippet: string }

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (entry.endsWith(".ts") || entry.endsWith(".wgsl")) out.push(full);
    }
    return out;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

/**
 * Blank out comments, keeping every byte offset so line numbers stay right. A prose comma
 * inside an argument list — "carries no D3DRENDERSTATE_NORMALIZENORMALS," sitting between
 * two real arguments — otherwise counts as a separator and the check reports a call that
 * is perfectly fine.
 */
function blankComments(src: string): string {
    const out = src.split("");
    for (let i = 0; i < src.length; i++) {
        if (src[i] === "/" && src[i + 1] === "/") {
            while (i < src.length && src[i] !== "\n") { out[i] = " "; i++; }
        } else if (src[i] === "/" && src[i + 1] === "*") {
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
                if (src[i] !== "\n") out[i] = " ";
                i++;
            }
            if (i < src.length) { out[i] = " "; out[i + 1] = " "; i++; }
        }
    }
    return out.join("");
}

interface ArgList {
    count: number;
    end: number;
    interpolated: boolean;
    /** Absolute [start, endExclusive) of every `${...}` inside the list. */
    spans: Array<[number, number]>;
}

/**
 * Split an argument list into top-level arguments. `${...}` is one argument piece however
 * many commas it hides, and nested (), [], <> keep their commas to themselves.
 */
function countArgs(src: string, open: number): ArgList | null {
    // `segment` is "something has appeared since the last top-level comma", which is what
    // separates a real final argument from WGSL's permitted trailing comma — counting the
    // latter reports every helper declared that way as one parameter too wide.
    let depth = 0, commas = 0, segment = false, interpolated = false;
    const spans: Array<[number, number]> = [];
    for (let i = open; i < src.length; i++) {
        const c = src[i]!;
        if (c === "$" && src[i + 1] === "{") {
            const start = i;
            let braces = 1; i += 2;
            while (i < src.length && braces > 0) {
                if (src[i] === "{") braces++;
                else if (src[i] === "}") braces--;
                i++;
            }
            spans.push([start, i]);
            i--; segment = true; interpolated = true; continue;
        }
        if (c === "(" || c === "[") { depth++; if (depth === 1) continue; }
        else if (c === ")" || c === "]") {
            depth--;
            if (depth === 0) return { count: segment ? commas + 1 : commas, end: i, interpolated, spans };
            continue;
        }
        if (depth === 1 && c === ",") { commas++; segment = false; continue; }
        if (depth >= 1 && !/\s/.test(c)) segment = true;
        if (c === "\n" && depth === 0) return null; // not a call after all
    }
    return null;
}

const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const TERNARY_OF_LITERALS =
    /^[^?]*\?\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*:\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3\s*$/;

/**
 * The texts one `${...}` body can expand to, or null when that set is not knowable.
 *
 * A conditional between two string literals has exactly two expansions and is checked as
 * both — that is the shape that hides an arity defect. Otherwise the interpolation counts
 * as ONE value only when it is glued into a surrounding token (`vsBool(${n}u)`,
 * `stages[${s}].x`), where a comma-separated expansion could not be valid WGSL at all. A
 * standalone `${x}` argument stays unknowable: `x` may well be a joined argument list.
 */
function interpolationExpansions(body: string, glued: boolean): string[] | null {
    const ternary = body.match(TERNARY_OF_LITERALS);
    if (ternary) return [ternary[2]!, ternary[4]!];
    const literals = [...body.matchAll(STRING_LITERAL)];
    if (glued && !literals.some(literal => /[,()[\]{}]/.test(literal[2]!))) return ["_"];
    return null;
}

/** An interpolation whose neighbours make it part of one WGSL token, not a whole argument. */
function isGlued(text: string, start: number, end: number): boolean {
    const before = text.slice(0, start).replace(/\s+$/, "").slice(-1);
    const after = text.slice(end).replace(/^\s+/, "").slice(0, 1);
    const separator = (c: string): boolean => c === "" || c === "," || c === "(" || c === ")" || c === "$";
    return !separator(before) || !separator(after);
}

/** Every literal argument list `text` can expand to, or null when one part is unknowable. */
function expandArgList(text: string, spans: Array<[number, number]>): string[] | null {
    const options: string[][] = [];
    for (const [start, end] of spans) {
        const expansions = interpolationExpansions(
            text.slice(start + 2, end - 1), isGlued(text, start, end));
        if (!expansions) return null;
        options.push(expansions);
    }
    if (options.reduce((total, o) => total * o.length, 1) > 16) return null;
    const results: string[] = [];
    const build = (index: number, cursor: number, acc: string): void => {
        if (index === spans.length) { results.push(acc + text.slice(cursor)); return; }
        const [start, end] = spans[index]!;
        for (const choice of options[index]!) build(index + 1, end, acc + text.slice(cursor, start) + choice);
    };
    build(0, 0, "");
    return results;
}

/**
 * The names a `fn ${...}(` declaration can declare. The vs/ps constant banks are emitted from
 * ONE template whose helper name is interpolated; without this `vsBool` has no declaration
 * and none of its calls is compared against one.
 */
function declaredNameExpansions(src: string, body: string): string[] | null {
    const direct = body.match(TERNARY_OF_LITERALS);
    if (direct) return [direct[2]!, direct[4]!];
    const identifier = body.trim().match(/^[A-Za-z_]\w*$/);
    if (!identifier) return null;
    const bound = src.match(new RegExp(`\\bconst\\s+${identifier[0]}\\s*=\\s*([^;\\n]+)`));
    const initializer = bound?.[1]?.trim();
    if (!initializer) return null;
    const ternary = initializer.match(TERNARY_OF_LITERALS);
    return ternary ? [ternary[2]!, ternary[4]!] : null;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
const decls = new Map<string, Decl[]>();
const tsNames = new Set<string>();
const entryPoints = new Set<string>();

const sources = new Map<string, string>(files.map((f) => [f, blankComments(readFileSync(f, "utf8"))]));

const declSpans = new Map<string, Array<[number, number]>>();
/** `fn ${...}(` declarations whose name could not be resolved — reported, never silent. */
let undeclarableNames = 0;

for (const file of files) {
    const src = sources.get(file)!;
    for (const m of src.matchAll(/\bfn\s+(?:([A-Za-z_]\w*)|\$\{([^{}]*)\})\s*\(/g)) {
        const names = m[1] ? [m[1]] : declaredNameExpansions(src, m[2]!);
        if (!names) { undeclarableNames++; continue; }
        // Entry points are called by the pipeline, never from WGSL, and each generator
        // declares its own with whatever inputs that shader needs — comparing those across
        // files reports an arity conflict that means nothing.
        const before = src.slice(Math.max(0, m.index! - 120), m.index!);
        if (/@(?:fragment|vertex|compute)\s*$/.test(before)) {
            for (const name of names) entryPoints.add(name);
            continue;
        }
        // A parameter list is counted the same way an argument list is: `@location(0)`
        // and `array<f32, 4>` both carry parens/commas that are not separators.
        const parsed = countArgs(src, m.index! + m[0]!.length - 1);
        if (!parsed) continue;
        for (const name of names) {
            decls.set(name, [...(decls.get(name) ?? []), { name, arity: parsed.count, file, line: lineOf(src, m.index!) }]);
            declSpans.set(`${file}:${name}`, [...(declSpans.get(`${file}:${name}`) ?? []), [m.index!, parsed.end]]);
        }
    }
    // A TypeScript function of the same name would make every JS call site look like a
    // shader call; those names are excluded rather than reported wrongly.
    for (const m of src.matchAll(/(?:function|const|let|var)\s+([A-Za-z_]\w*)\s*[=(]/g)) tsNames.add(m[1]!);
}

const mismatches: Mismatch[] = [];
const ambiguous: string[] = [];
let interpolatedCalls = 0;
let expandedCalls = 0;
let checkedCalls = 0;

for (const [name, list] of decls) {
    const arities = new Set(list.map((d) => d.arity));
    if (tsNames.has(name) || entryPoints.has(name)) continue;
    if (arities.size > 1) {
        ambiguous.push(`${name}: ${[...arities].join("/")} args (${list.map((d) => `${relative(ROOT, d.file)}:${d.line}`).join(", ")})`);
        continue;
    }
    const want = list[0]!.arity;
    for (const file of files) {
        const src = sources.get(file)!;
        const spans = declSpans.get(`${file}:${name}`) ?? [];
        for (const m of src.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
            const line = lineOf(src, m.index!);
            if (spans.some(([a, b]) => m.index! >= a && m.index! <= b)) continue;
            const open = src.indexOf("(", m.index!);
            const parsed = countArgs(src, open);
            if (!parsed) continue;
            const snippet = (): string =>
                src.slice(m.index!, Math.min(parsed.end + 1, m.index! + 120)).replace(/\s+/g, " ");
            if (!parsed.interpolated) {
                checkedCalls++;
                if (parsed.count !== want) {
                    mismatches.push({ name, file: relative(ROOT, file), line, got: parsed.count, want, snippet: snippet() });
                }
                continue;
            }
            // An interpolated argument list is checked once per KNOWN expansion. Only a
            // list with an unknowable part is skipped, and that is counted out loud: an
            // unchecked call is a hole in the check, not a pass.
            const text = src.slice(open, parsed.end + 1);
            const candidates = expandArgList(
                text, parsed.spans.map(([a, b]) => [a - open, b - open] as [number, number]));
            if (!candidates) { interpolatedCalls++; continue; }
            checkedCalls++;
            expandedCalls++;
            for (const candidate of candidates) {
                const expansion = countArgs(candidate, 0);
                if (!expansion || expansion.count === want) continue;
                mismatches.push({
                    name, file: relative(ROOT, file), line, got: expansion.count, want,
                    snippet: `${snippet()}   [expansion: ${name}${candidate.replace(/\s+/g, " ")}]`,
                });
                break;
            }
        }
    }
}

if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ mismatches, ambiguous, helpers: decls.size, checkedCalls, expandedCalls, interpolatedCalls, undeclarableNames }, null, 2));
} else {
    console.log(`[wgsl-calls] ${decls.size} shader helpers, ${checkedCalls} calls checked `
        + `(${expandedCalls} by expanding an interpolated argument list), `
        + `${interpolatedCalls} skipped (an unknowable interpolation can expand to any count), `
        + `${undeclarableNames} declarations with an unresolvable interpolated name`);
    for (const a of ambiguous) console.log(`  ambiguous (not checked): ${a}`);
    for (const m of mismatches) {
        console.log(`  MISMATCH ${m.file}:${m.line}  ${m.name} called with ${m.got}, declared with ${m.want}`);
        console.log(`      ${m.snippet}`);
    }
    if (mismatches.length === 0) console.log("[wgsl-calls] OK — every helper call matches its declaration");
}

process.exit(mismatches.length > 0 ? 1 : 0);
