#!/usr/bin/env bun
/**
 * Parent-side D3D9 arena ABI gate.
 *
 * This intentionally reads the vendor source and the shipped parent artifact, but never
 * rewrites either one.  A missing, unreadable, or unparsable wasm artifact is a failure:
 * this check must not turn an unavailable binary into a green result.
 *
 * Usage: bun tools/validate-d3d9-arena-abi.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ARENA_RS = join(ROOT, "vendor", "v86", "crates", "d3d9-webgpu", "src", "arena.rs");
const ARENA_TS = join(ROOT, "src", "worker", "backends", "webgpu", "d3d9", "d3d9-wasm-arena.ts");
const WASM = join(ROOT, "public", "v86.wasm");

class AbiFailure extends Error {}

function readTextRequired(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new AbiFailure(`required ABI input is unreadable: ${path}\n  ${detail}`);
    }
}

function readBinaryRequired(path: string): Uint8Array {
    try {
        return readFileSync(path);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new AbiFailure(`required ABI input is unreadable: ${path}\n  ${detail}`);
    }
}

interface LayoutEntry {
    name: string;
    value: number;
}

function parseTsLayout(text: string): LayoutEntry[] {
    const body = /\bconst\s+enum\s+LayoutIdx\s*\{([\s\S]*?)\n\s*\}/.exec(text)?.[1];
    if (!body) throw new AbiFailure(`LayoutIdx enum not found in ${ARENA_TS}`);

    const entries: LayoutEntry[] = [];
    for (const line of body.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_$][\w$]*)\s*=\s*(\d+)\s*,?/.exec(line);
        if (match) entries.push({ name: match[1]!, value: Number(match[2]) });
    }
    if (entries.length === 0) throw new AbiFailure(`LayoutIdx enum has no numeric entries in ${ARENA_TS}`);
    return entries;
}

function parseRustLayout(text: string): { declaredLength: number; entries: LayoutEntry[] } {
    const length = /\bconst\s+LAYOUT_LEN:\s*usize\s*=\s*(\d+)\s*;/.exec(text)?.[1];
    if (!length) throw new AbiFailure(`LAYOUT_LEN not found in ${ARENA_RS}`);

    const body = /\bconst\s+LAYOUT_TABLE:\s*\[u32;\s*LAYOUT_LEN\]\s*=\s*\[([\s\S]*?)\n\s*\];/.exec(text)?.[1];
    if (!body) throw new AbiFailure(`LAYOUT_TABLE not found in ${ARENA_RS}`);

    // The trailing numbered comments are part of arena.rs's explicit order contract.
    const entries: LayoutEntry[] = [];
    for (const line of body.split(/\r?\n/)) {
        const match = /^\s*([^,]+?)\s*,\s*\/\/\s*(\d+)\b/.exec(line);
        if (match) entries.push({ name: match[1]!.trim(), value: Number(match[2]) });
    }
    if (entries.length === 0) throw new AbiFailure(`LAYOUT_TABLE has no numbered entries in ${ARENA_RS}`);
    return { declaredLength: Number(length), entries };
}

function parseSourceExports(text: string): Set<string> {
    const exports = new Set<string>();
    const pattern = /#\[no_mangle\]\s*pub\s+(?:(?:unsafe\s+)?fn|static(?:\s+mut)?)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of text.matchAll(pattern)) exports.add(match[1]!);
    if (exports.size === 0) throw new AbiFailure(`no #[no_mangle] arena exports found in ${ARENA_RS}`);
    return exports;
}

function sorted(values: Iterable<string>): string[] {
    return [...values].sort((a, b) => a.localeCompare(b));
}

function difference(left: Set<string>, right: Set<string>): string[] {
    return sorted([...left].filter((value) => !right.has(value)));
}

/**
 * The two sides name the same slot differently in a handful of places (arena.rs numbers the
 * state-block sub-offsets BLOCK_*, the TS enum calls them Slot*). Every legitimate spelling
 * difference is listed here BY HAND: normalizing them away with a loose rule would let a real
 * rename slip through, which is the whole bug this table exists to catch.
 */
const LAYOUT_NAME_ALIASES: Record<string, string> = {
    slotmaskrs: "blockmaskrs",
    slotmasksamp: "blockmasksamp",
    slotvsranges: "blockvsranges",
    slotpsranges: "blockpsranges",
    slotrsvalues: "blockrsvalues",
    slotsampvalues: "blocksampvalues",
    slotconstpool: "blockconstpool",
};

/** Canonical form of a slot name on either side: case, underscores and the Rust `OFF_`
 *  prefix carry no meaning; the identity of the slot does. */
function canonicalSlotName(name: string): string {
    const normalized = name.trim()
        .replace(/\s+as\s+u32$/, "")
        .replace(/^OFF_/, "")
        .replace(/_/g, "")
        .toLowerCase();
    return LAYOUT_NAME_ALIASES[normalized] ?? normalized;
}

/** Evaluate the small integer expressions both sides use for their capacity constants
 *  (`16 * 1024 * 1024`), so a literal-vs-product spelling is not a false mismatch. */
function evalIntExpression(text: string): number | null {
    const trimmed = text.trim().replace(/_/g, "");
    if (!/^[\d\s*+]+$/.test(trimmed)) return null;
    let total = 0;
    for (const term of trimmed.split("+")) {
        let product = 1;
        for (const factor of term.split("*")) {
            const value = Number(factor.trim());
            if (!Number.isFinite(value)) return null;
            product *= value;
        }
        total += product;
    }
    return total;
}

function findConstant(text: string, pattern: RegExp, label: string): number {
    const raw = pattern.exec(text)?.[1];
    if (raw === undefined) throw new AbiFailure(`${label} not found`);
    const value = evalIntExpression(raw);
    if (value === null) throw new AbiFailure(`${label} is not a plain integer expression: ${raw}`);
    return value;
}

/** Resolve the small acyclic Rust const expressions used by the descriptor/header ABI. */
function findRustConstant(text: string, name: string, seen = new Set<string>()): number {
    if (seen.has(name)) throw new AbiFailure(`arena.rs const cycle while resolving ${name}`);
    seen.add(name);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const raw = new RegExp(`\\b(?:pub\\s+)?const\\s+${escaped}:\\s*[^=]+?=\\s*([^;]+);`)
        .exec(text)?.[1];
    if (raw === undefined) throw new AbiFailure(`arena.rs ${name} not found`);
    const expanded = raw.replace(/\b[A-Z][A-Z0-9_]*\b/g, dependency =>
        String(findRustConstant(text, dependency, new Set(seen))));
    const value = evalIntExpression(expanded);
    if (value === null) {
        throw new AbiFailure(`arena.rs ${name} is not a supported integer expression: ${raw}`);
    }
    return value;
}

/** Capacity/version/descriptor constants the TS wrapper hand-mirrors from arena.rs. Nothing
 * at runtime reads these off the layout table, so drift is otherwise invisible until a decoder
 * silently reads a different header or accepts a payload beyond Rust's bank. */
function checkMirroredConstants(tsText: string, rustText: string): string[] {
    const pairs: Array<[string, RegExp, RegExp]> = [
        ["BUMP_CAP", /export\s+const\s+D3D9_ARENA_BUMP_CAP\s*=\s*([^;]+);/,
            /\bconst\s+BUMP_CAP:\s*usize\s*=\s*([^;]+);/],
        ["CMD_CAP", /export\s+const\s+D3D9_ARENA_CMD_CAP\s*=\s*([^;]+);/,
            /\bpub\s+const\s+CMD_CAP:\s*usize\s*=\s*([^;]+);/],
        ["ABI_VERSION", /export\s+const\s+D3D9_ARENA_ABI_VERSION\s*=\s*([^;]+);/,
            /\bconst\s+D3D9_ARENA_ABI_VERSION:\s*u32\s*=\s*([^;]+);/],
    ];
    const failures: string[] = [];
    for (const [label, tsPattern, rustPattern] of pairs) {
        const tsValue = findConstant(tsText, tsPattern, `TS ${label}`);
        const rustValue = findConstant(rustText, rustPattern, `arena.rs ${label}`);
        if (tsValue !== rustValue) {
            failures.push(`${label} mismatch: d3d9-wasm-arena.ts=${tsValue}, arena.rs=${rustValue}`);
        }
    }
    const descriptorPairs: Array<[string, RegExp, string]> = [
        ["SHADER_HANDLE_SLOTS", /export\s+const\s+D3D9_ARENA_SHADER_HANDLE_SLOTS\s*=\s*([^;]+);/,
            "SHADER_HANDLE_SLOTS"],
        ["VS_CONST_FLOATS", /export\s+const\s+D3D9_ARENA_VS_CONST_FLOATS\s*=\s*([^;]+);/,
            "VS_CONST_FLOATS"],
        ["PS_CONST_FLOATS", /export\s+const\s+D3D9_ARENA_PS_CONST_FLOATS\s*=\s*([^;]+);/,
            "PS_CONST_FLOATS"],
        ["DRAW_STATE_HEADER_LEN", /export\s+const\s+D3D9_ARENA_DRAW_STATE_HEADER_BYTES\s*=\s*([^;]+);/,
            "DRAW_STATE_HEADER_LEN"],
        ["COMPACT_RUN_HEADER_WORDS", /export\s+const\s+D3D9_ARENA_COMPACT_RUN_HEADER_WORDS\s*=\s*([^;]+);/,
            "COMPACT_RUN_HEADER_WORDS"],
    ];
    for (const [label, tsPattern, rustName] of descriptorPairs) {
        const tsValue = findConstant(tsText, tsPattern, `TS ${label}`);
        const rustValue = findRustConstant(rustText, rustName);
        if (tsValue !== rustValue) {
            failures.push(`${label} mismatch: d3d9-wasm-arena.ts=${tsValue}, arena.rs=${rustValue}`);
        }
    }
    return failures;
}

function checkLayout(tsText: string, rustText: string): string[] {
    const ts = parseTsLayout(tsText);
    const rust = parseRustLayout(rustText);
    const failures: string[] = [];

    if (rust.declaredLength !== rust.entries.length) {
        failures.push(
            `arena.rs LAYOUT_LEN=${rust.declaredLength}, but LAYOUT_TABLE has ${rust.entries.length} numbered entries`,
        );
    }
    if (ts.length !== rust.declaredLength) {
        failures.push(`TS LayoutIdx has ${ts.length} entries, arena.rs LAYOUT_LEN is ${rust.declaredLength}`);
    }
    if (ts.length !== rust.entries.length) {
        failures.push(`TS LayoutIdx has ${ts.length} entries, arena.rs LAYOUT_TABLE has ${rust.entries.length}`);
    }
    // The TS wrapper reads the layout table with its OWN length; a LAYOUT_LEN that lags the
    // enum builds views over one entry of garbage rather than failing.
    const tsDeclaredLength = /\bconst\s+LAYOUT_LEN\s*=\s*(\d+)\s*;/.exec(tsText)?.[1];
    if (tsDeclaredLength === undefined) {
        failures.push(`LAYOUT_LEN constant not found in ${ARENA_TS}`);
    } else if (Number(tsDeclaredLength) !== ts.length) {
        failures.push(`TS LAYOUT_LEN=${tsDeclaredLength}, but LayoutIdx has ${ts.length} entries`);
    }

    const count = Math.min(ts.length, rust.entries.length);
    for (let i = 0; i < count; i++) {
        const tsEntry = ts[i]!;
        const rustEntry = rust.entries[i]!;
        if (tsEntry.value !== rustEntry.value) {
            failures.push(
                `LayoutIdx order mismatch at position ${i}: TS ${tsEntry.name}=${tsEntry.value}, ` +
                `arena.rs ${rustEntry.name}=${rustEntry.value}`,
            );
        }
        // Values alone cannot see two slots whose NAMES were swapped while both stayed in
        // ascending order — and that is exactly the edit that makes buildViews map commandA
        // onto the B array.
        if (canonicalSlotName(tsEntry.name) !== canonicalSlotName(rustEntry.name)) {
            failures.push(
                `LayoutIdx slot ${i} names disagree: TS ${tsEntry.name}, arena.rs ${rustEntry.name} ` +
                `(add an explicit LAYOUT_NAME_ALIASES entry if this rename is intended)`,
            );
        }
        if (rustEntry.value !== i) {
            failures.push(`arena.rs LAYOUT_TABLE entry ${rustEntry.name} is numbered ${rustEntry.value}, expected ${i}`);
        }
    }
    return failures;
}

function checkWasmExports(sourceText: string, wasmBytes: Uint8Array): string[] {
    const expected = parseSourceExports(sourceText);
    let actual: Set<string>;
    try {
        const module = new WebAssembly.Module(wasmBytes);
        actual = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new AbiFailure(`public/v86.wasm cannot be parsed as WebAssembly; refusing to pass\n  ${detail}`);
    }

    // Include all D3D9-shaped exports so stale extras fail too, not just missing source names.
    const arenaActual = new Set(
        [...actual].filter((name) =>
            name === "D3D9_ARENA" || name === "LAYOUT_TABLE_STATIC" || name.startsWith("d3d9_") || name.startsWith("get_d3d9_")),
    );
    const failures: string[] = [];
    const missing = difference(expected, actual);
    const extra = difference(arenaActual, expected);
    if (missing.length) failures.push(`public/v86.wasm is missing arena exports: ${missing.join(", ")}`);
    if (extra.length) failures.push(`public/v86.wasm has stale/unexpected arena exports: ${extra.join(", ")}`);
    return failures;
}

function main(): void {
    const rustText = readTextRequired(ARENA_RS);
    const tsText = readTextRequired(ARENA_TS);
    const wasmBytes = readBinaryRequired(WASM);

    const failures = [
        ...checkLayout(tsText, rustText),
        ...checkMirroredConstants(tsText, rustText),
        ...checkWasmExports(rustText, wasmBytes),
    ];
    if (failures.length) {
        console.error("D3D9 arena ABI validation FAILED (fail-closed):");
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exitCode = 1;
        return;
    }

    const rustLayout = parseRustLayout(rustText);
    console.log(`D3D9 arena ABI OK — ${rustLayout.entries.length} layout entries and source/wasm exports match.`);
}

try {
    main();
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`D3D9 arena ABI validation FAILED (fail-closed):\n  - ${detail}`);
    process.exitCode = 1;
}
