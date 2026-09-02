/**
 * Gate step: the production JIT configuration is declared in THREE places and only one of
 * them runs in the product.
 *
 *   - vendor/v86/src/rust/jit.rs — the engine's own defaults (`static mut` initialisers,
 *     read back through `get_jit_config`).
 *   - src/worker/core/cpu/preemption-manager.ts — the indices the emulator overrides at
 *     every v86 init. These are the live product's choices.
 *   - tools/jit-config/shipping.mjs — what every OFFLINE tool (bench-v86, the AOT oracle
 *     arms, the AOT capture job) applies when it claims to measure "shipping".
 *
 * A drift is silent and expensive: an ablation arm reports a confident percentage for a
 * codegen shape the emulator never runs.
 *
 * Rules:
 *   1. Every index PreemptionManager applies ⇒ shipping.mjs must carry PM's value.
 *      Every other supported index ⇒ shipping.mjs must carry the engine's default as the
 *      engine reads it back (idx 25 reads log2, idx 27 reads mask+1, idx 30's setter masks
 *      the argument to 20 bits, so the raw `static mut` value is not what a reader sees).
 *   2. Every index in JIT_CONFIG_SUPPORTED_MASK is covered, and no unsupported one is.
 *   3. The all-off reference sits at the per-index minimum, each minimum is derived from the
 *      Rust source, and no minimum exceeds its shipping value.
 *
 * The Rust side is PARSED, never restated here: a second hand-written copy of the defaults
 * would be the fourth divergent list. Any `set_jit_config` / `get_jit_config` form the parser
 * does not model is a hard failure, so a future engine change makes this step red instead of
 * quietly unverified.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    JIT_CONFIG_ABI_VERSION, JIT_CONFIG_SUPPORTED_MASK, SUPPORTED_INDICES,
    SHIPPING_JIT, MIN_VALID, REFERENCE_ALL_OFF, minValid,
} from "./jit-config/shipping.mjs";

const REPO = resolve(import.meta.dir, "..");
const RUST = "vendor/v86/src/rust/jit.rs";
const PM = "src/worker/core/cpu/preemption-manager.ts";

const rust = readFileSync(resolve(REPO, RUST), "utf8");
const pmSrc = readFileSync(resolve(REPO, PM), "utf8");

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

// ── Rust: the ABI envelope ──────────────────────────────────────────────────
const abi = /JIT_CONFIG_ABI_VERSION:\s*u32\s*=\s*(\d+)/.exec(rust);
const mask = /JIT_CONFIG_SUPPORTED_MASK:\s*u32\s*=\s*0x([0-9A-Fa-f_]+)/.exec(rust);
if (!abi || !mask) {
    console.error(`Could not parse JIT_CONFIG_ABI_VERSION / JIT_CONFIG_SUPPORTED_MASK from ${RUST}.`);
    console.error("The parser has drifted from the source; this step would pass no matter what.");
    process.exit(1);
}
const rustAbi = Number(abi[1]);
const rustMask = Number.parseInt(mask[1]!.replace(/_/g, ""), 16) >>> 0;
if (rustAbi !== JIT_CONFIG_ABI_VERSION) fail(`ABI version: jit.rs says ${rustAbi}, shipping.mjs says ${JIT_CONFIG_ABI_VERSION}`);
if (rustMask !== (JIT_CONFIG_SUPPORTED_MASK >>> 0)) {
    fail(`supported mask: jit.rs says 0x${rustMask.toString(16)}, shipping.mjs says 0x${(JIT_CONFIG_SUPPORTED_MASK >>> 0).toString(16)}`);
}

// ── Rust: `static mut` initialisers ─────────────────────────────────────────
/** `512 - 1`, `u32::MAX`, `true`, `0x20`, `24` — the forms jit.rs actually uses. */
function rustLiteral(text: string): number | null {
    const t = text.trim();
    if (t === "true") return 1;
    if (t === "false") return 0;
    if (t === "u32::MAX") return 0xFFFFFFFF;
    const sub = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (sub) return Number(sub[1]) - Number(sub[2]);
    if (/^0x[0-9A-Fa-f_]+$/.test(t)) return Number.parseInt(t.replace(/_/g, ""), 16);
    if (/^\d+$/.test(t)) return Number(t);
    return null;
}

const statics = new Map<string, number>();
for (const m of rust.matchAll(/^\s*(?:pub\s+)?static mut ([A-Z0-9_]+)\s*:\s*[A-Za-z0-9_:]+\s*=\s*([^;]+);/gm)) {
    const value = rustLiteral(m[2]!);
    if (value !== null) statics.set(m[1]!, value);
}

/** The body of a `pub unsafe fn NAME(...)` match, as `index => arm` pairs. */
function matchArms(fnName: string): Map<number, string> {
    const at = rust.indexOf(`pub unsafe fn ${fnName}(`);
    if (at < 0) {
        console.error(`${fnName} not found in ${RUST} — the parser has drifted from the source.`);
        process.exit(1);
    }
    const body = rust.slice(at, rust.indexOf("\n}", at));
    const arms = new Map<number, string>();
    for (const m of body.matchAll(/^\s{8}(\d+) => ([\s\S]*?),$/gm)) arms.set(Number(m[1]), m[2]!.trim());
    // A multi-line arm (`15 => { ... }`) ends on its own line; capture those too.
    for (const m of body.matchAll(/^\s{8}(\d+) => \{/gm)) if (!arms.has(Number(m[1]))) arms.set(Number(m[1]), "{block}");
    return arms;
}

const setArms = matchArms("set_jit_config");
const getArms = matchArms("get_jit_config");
if (getArms.size !== SUPPORTED_INDICES.length || setArms.size < SUPPORTED_INDICES.length) {
    fail(`parsed ${getArms.size} get / ${setArms.size} set match arms for ${SUPPORTED_INDICES.length} supported indices`);
}

/**
 * The value `get_jit_config(index)` returns when nothing has been set: the arm's expression
 * evaluated over the `static mut` initialisers. Two indices publish a DERIVED value
 * (jit.rs:6365 log2 of the memo size, jit.rs:6367 mask+1), which is exactly why this is
 * evaluated rather than read off the static.
 */
function defaultReadback(index: number): number {
    const arm = getArms.get(index);
    if (arm === undefined) { fail(`get_jit_config has no arm for supported index ${index}`); return NaN; }
    const plain = /^([A-Z0-9_]+)(?: as u32)?$/.exec(arm);
    if (plain) {
        const v = statics.get(plain[1]!);
        if (v === undefined) { fail(`index ${index}: no parsed default for ${plain[1]}`); return NaN; }
        return v >>> 0;
    }
    const log2 = /^\(([A-Z0-9_]+) \+ 1\)\.trailing_zeros\(\)$/.exec(arm);
    if (log2) {
        const v = statics.get(log2[1]!);
        if (v === undefined) { fail(`index ${index}: no parsed default for ${log2[1]}`); return NaN; }
        return Math.log2(v + 1);
    }
    const plusOne = /^([A-Z0-9_]+) \+ 1$/.exec(arm);
    if (plusOne) {
        const v = statics.get(plusOne[1]!);
        if (v === undefined) { fail(`index ${index}: no parsed default for ${plusOne[1]}`); return NaN; }
        return (v + 1) >>> 0;
    }
    fail(`index ${index}: get_jit_config arm \`${arm}\` is a form this validator cannot model — `
        + "extend the evaluator rather than leave the index unchecked");
    return NaN;
}

/**
 * What the SETTER can actually store. A masked index (jit.rs:6329) cannot hold its own
 * default, so the shipping envelope must apply the masked value or every arm's readback
 * provenance check aborts the run.
 */
function storable(index: number, value: number): number {
    const arm = setArms.get(index) ?? "";
    const masked = /= value & (0x[0-9A-Fa-f_]+)$/.exec(arm);
    if (masked) return (value & Number.parseInt(masked[1]!.replace(/_/g, ""), 16)) >>> 0;
    return value >>> 0;
}

/** Numeric floors the setter enforces (`value.clamp(A, …)`), keyed by index. */
const rustClampFloor = new Map<number, number>();
for (const [index, arm] of setArms) {
    const clamp = /value\.clamp\((\d+)\s*,/.exec(arm);
    if (clamp) rustClampFloor.set(index, Number(clamp[1]));
    // A block arm hides its clamp behind `{block}`; re-read the raw source for those.
    if (arm === "{block}") {
        const at = rust.indexOf(`\n        ${index} => {`, rust.indexOf("pub unsafe fn set_jit_config("));
        if (at >= 0) {
            const c = /value\.clamp\((\d+)\s*,/.exec(rust.slice(at, rust.indexOf("\n        },", at)));
            if (c) rustClampFloor.set(index, Number(c[1]));
        }
    }
}

// ── PreemptionManager: the indices the product actually overrides ────────────
const fieldDefaults = new Map<string, number>();
for (const m of pmSrc.matchAll(/^\s*private (\w+)\s*=\s*(true|false|\d+);/gm)) {
    fieldDefaults.set(m[1]!, m[2] === "true" ? 1 : m[2] === "false" ? 0 : Number(m[2]));
}
const pmApplied = new Map<number, number>();
for (const m of pmSrc.matchAll(/applyJitConfig\(this\.wasmExports,\s*(\d+),\s*([^)]+)\)/g)) {
    const index = Number(m[1]);
    const expr = m[2]!.trim();
    const bool = /^this\.(\w+) \? 1 : 0$/.exec(expr);
    const plain = /^this\.(\w+)$/.exec(expr);
    const field = bool?.[1] ?? plain?.[1];
    if (!field || !fieldDefaults.has(field)) {
        fail(`PreemptionManager applies index ${index} as \`${expr}\`, which this validator cannot resolve to a default`);
        continue;
    }
    pmApplied.set(index, fieldDefaults.get(field)! >>> 0);
}
if (pmApplied.size === 0) {
    console.error(`Parsed 0 applyJitConfig() call sites from ${PM} — the parser has drifted and this step`);
    console.error("would pass no matter what PreemptionManager applied. Fix the regex.");
    process.exit(1);
}

// ── rule 2: coverage ────────────────────────────────────────────────────────
for (const index of SUPPORTED_INDICES) {
    if (!SHIPPING_JIT.has(index)) fail(`supported index ${index} is missing from SHIPPING_JIT`);
}
for (const index of SHIPPING_JIT.keys()) {
    if (!SUPPORTED_INDICES.includes(index)) fail(`SHIPPING_JIT declares index ${index}, which the supported mask excludes`);
}
for (const index of pmApplied.keys()) {
    if (!SUPPORTED_INDICES.includes(index)) fail(`PreemptionManager applies index ${index}, which the supported mask excludes`);
}

// ── rule 1: every shipping value is PM's, or the engine's ───────────────────
for (const index of SUPPORTED_INDICES) {
    const have = SHIPPING_JIT.get(index);
    if (have === undefined) continue;
    if (pmApplied.has(index)) {
        const want = pmApplied.get(index)!;
        if (have !== want) fail(`index ${index}: PreemptionManager applies ${want}, SHIPPING_JIT says ${have}`);
        continue;
    }
    const want = storable(index, defaultReadback(index));
    if (!Number.isFinite(want)) continue;
    if (have !== want) fail(`index ${index}: jit.rs default reads back ${want}, SHIPPING_JIT says ${have} `
        + "(and PreemptionManager does not apply this index)");
}

// ── rule 3: the all-off reference ───────────────────────────────────────────
for (const index of SUPPORTED_INDICES) {
    const ref = REFERENCE_ALL_OFF.get(index);
    if (ref !== minValid(index)) fail(`index ${index}: REFERENCE_ALL_OFF is ${ref}, minimum is ${minValid(index)}`);
    const ship = SHIPPING_JIT.get(index) ?? 0;
    if (minValid(index) > ship) fail(`index ${index}: minimum ${minValid(index)} exceeds the shipping value ${ship} — `
        + "the all-off reference would be MORE enabled than production");
}
for (const [index, floor] of rustClampFloor) {
    if (minValid(index) < floor) {
        fail(`index ${index}: jit.rs clamps to >= ${floor}, MIN_VALID says ${minValid(index)} — the setter would `
            + "substitute its floor and the arm's readback check would abort the run");
    }
}
for (const index of MIN_VALID.keys()) {
    if (!SUPPORTED_INDICES.includes(index)) fail(`MIN_VALID declares index ${index}, which the supported mask excludes`);
}

if (errors.length > 0) {
    console.error("Production JIT configuration drift:\n");
    for (const e of errors) console.error(`  ${e}`);
    console.error(`\n${errors.length} violation(s). Authority: ${RUST} + ${PM}; copy: tools/jit-config/shipping.mjs.`);
    process.exit(1);
}

console.log(
    `JIT shipping config OK — ${SUPPORTED_INDICES.length} supported index/es covered, ` +
    `${pmApplied.size} applied by PreemptionManager (${[...pmApplied.keys()].sort((a, b) => a - b).join(",")}), ` +
    `${SUPPORTED_INDICES.length - pmApplied.size} at the jit.rs default, ` +
    `${MIN_VALID.size} minimum(s) (${rustClampFloor.size} clamped by the setter), ABI ${rustAbi}.`,
);
