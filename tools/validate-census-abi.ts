/**
 * Gate step: the guest-census ABI is declared twice — the bit layout and buffer sizes in
 * Rust (vendor/v86/src/rust/opstats.rs), the classification of those bits in TypeScript
 * (src/worker/core/debug/guest-opcode-classes.ts, read by harness/cmds/census.ts).
 *
 * The split is deliberate: Rust extracts bits, TS decides what they mean, so the judgement
 * has exactly one implementation and a test. The price is a seam, and a seam that drifts
 * here is the worst kind of failure this project has: a census that answers "6% x87, 40%
 * stack-relative" while reading the wrong bit. Nothing crashes. The number is simply about
 * something else, and roadmap items 02/03/05 pick their target from it.
 *
 * Four rules:
 *   1. The three buffer sizes agree (Rust ADDRKEY_COUNT / SIMDKEY_COUNT / SIZE against the
 *      constants census.ts loops to). A TS loop shorter than the Rust buffer silently drops
 *      the tail of the distribution.
 *   2. The addressing key's bit layout agrees. Rust writes it as a shift expression; TS
 *      reads it with shifts and masks, and both are extracted and compared field by field.
 *   3. The SIMD key's prefix encoding agrees (prefix<<8 | opcode, and which byte maps to
 *      which index).
 *   4. Every export the census reader calls exists in the BUILT artifact, so a not-rebuilt
 *      public/v86.wasm cannot present as an empty census. (Skipped, loudly, if the wasm is
 *      absent — same convention as validate-jit-exports.)
 *
 * Run: bun tools/validate-census-abi.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const RUST = "vendor/v86/src/rust/opstats.rs";
const TS_CLASSES = "src/worker/core/debug/guest-opcode-classes.ts";
const TS_CENSUS = "src/worker/harness/cmds/census.ts";
const WASM = "public/v86.wasm";

const rust = readFileSync(resolve(REPO, RUST), "utf8");
const tsClasses = readFileSync(resolve(REPO, TS_CLASSES), "utf8");
const tsCensus = readFileSync(resolve(REPO, TS_CENSUS), "utf8");

const failures: string[] = [];
const notes: string[] = [];
const fail = (m: string) => failures.push(m);

// --- rule 1: buffer sizes -------------------------------------------------

function rustConst(name: string): number | null {
    const m = rust.match(new RegExp(`const\\s+${name}\\s*:\\s*usize\\s*=\\s*(0[xX][0-9a-fA-F_]+|\\d[\\d_]*)`));
    return m ? Number(m[1]!.replaceAll("_", "")) : null;
}
function tsConst(src: string, name: string): number | null {
    const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(0[xX][0-9a-fA-F]+|\\d+)`));
    return m ? Number(m[1]!) : null;
}

const sizes: Array<[string, string, string]> = [
    ["SIZE", "OPCODE_KEYS", "opcode census"],
    ["ADDRKEY_COUNT", "ADDR_KEYS", "addressing census"],
    ["SIMDKEY_COUNT", "SIMD_KEYS", "SIMD-family census"],
];
for (const [rustName, tsName, label] of sizes) {
    const r = rustConst(rustName), t = tsConst(tsCensus, tsName);
    if (r === null) fail(`${RUST}: could not find \`const ${rustName}\` — the parser or the Rust changed`);
    else if (t === null) fail(`${TS_CENSUS}: could not find \`const ${tsName}\``);
    else if (r !== t) {
        fail(`${label} buffer size disagrees: Rust ${rustName}=${r}, TS ${tsName}=${t}. `
            + (t < r ? "The TS loop stops short, so the tail of the distribution reads as zero."
                : "The TS loop runs past the Rust buffer; get_opstats_* answers 0 there and dilutes every share."));
    } else notes.push(`${label} size ${r} agrees`);
}

// --- rule 2: addressing key bit layout ------------------------------------
//
// Rust:  (i.addr16 as u32) << 7 | (i.has_sib as u32) << 6 | md << 4 | base << 1 | index_present
// TS:    key & 0x80 / key & 0x40 / (key >> 4) & 3 / (key >> 1) & 7 / key & 1

const rustAddr = rust.match(/pub fn addr_key\(i: &Instruction\) -> u32 \{[\s\S]*?\n\}/)?.[0] ?? "";
if (!rustAddr) fail(`${RUST}: addr_key() not found`);
const tsAddr = tsClasses.match(/export function classifyAddrKey\(key: number\): AddrForm \{[\s\S]*?\n\}/)?.[0] ?? "";
if (!tsAddr) fail(`${TS_CLASSES}: classifyAddrKey() not found`);

type Field = { name: string; rust: RegExp; ts: RegExp; shift: number; width: number };
const FIELDS: Field[] = [
    { name: "addr16", rust: /addr16 as u32\)?\s*<<\s*7/, ts: /key\s*&\s*0x80/, shift: 7, width: 1 },
    { name: "has_sib", rust: /has_sib as u32\)?\s*<<\s*6/, ts: /key\s*&\s*0x40/, shift: 6, width: 1 },
    { name: "mod", rust: /md\s*<<\s*4/, ts: /\(key\s*>>\s*4\)\s*&\s*3/, shift: 4, width: 2 },
    { name: "base", rust: /base\s*<<\s*1/, ts: /\(key\s*>>\s*1\)\s*&\s*7/, shift: 1, width: 3 },
    { name: "index", rust: /\|\s*index_present/, ts: /key\s*&\s*1\)/, shift: 0, width: 1 },
];
for (const f of FIELDS) {
    const inRust = f.rust.test(rustAddr);
    const inTs = f.ts.test(tsAddr);
    if (!inRust || !inTs) {
        fail(`addressing key field \`${f.name}\` (shift ${f.shift}, ${f.width} bit(s)) is not readable on `
            + `${!inRust ? "the Rust" : "the TS"} side any more. The two sides encode and decode the same byte; `
            + "a field that moved on one of them makes every addressing share a share of something else.");
    } else notes.push(`addressing field ${f.name} agrees (shift ${f.shift})`);
}
// The fields must tile the byte exactly: 1+1+2+3+1 = 8 bits, no gap, no overlap.
let covered = 0;
for (const f of FIELDS) covered |= ((1 << f.width) - 1) << f.shift;
if (covered !== 0xff) fail(`addressing key fields do not tile a byte (covered mask 0x${covered.toString(16)})`);

// --- rule 3: SIMD key prefix encoding -------------------------------------

const rustSimd = rust.match(/fn mandatory_prefix\(i: &Instruction\) -> u32 \{[\s\S]*?\n\}/)?.[0] ?? "";
const tsSimd = tsClasses.match(/export function simdFamily\(key: number\): SimdFamily \{[\s\S]*?\n\}/)?.[0] ?? "";
if (!rustSimd) fail(`${RUST}: mandatory_prefix() not found`);
if (!tsSimd) fail(`${TS_CLASSES}: simdFamily() not found`);
for (const [byte, index, name] of [["0x66", 1, "66"], ["0xF3", 2, "F3"], ["0xF2", 3, "F2"]] as const) {
    if (!new RegExp(`${byte}\\s*=>\\s*p\\s*=\\s*${index}`).test(rustSimd)) {
        fail(`${RUST}: mandatory_prefix no longer maps ${name} to ${index}; the TS family table is keyed on that index`);
    }
}
if (!/prefix\s*=\s*\(key\s*>>\s*8\)\s*&\s*3/.test(tsSimd)) {
    fail(`${TS_CLASSES}: simdFamily no longer reads the prefix from bits 8-9`);
}
if (!/<<\s*8\s*\|\s*i\.opcode as u32/.test(rust)) {
    fail(`${RUST}: the SIMD key is no longer prefix<<8 | opcode`);
}

// --- rule 4: the built artifact carries the reader ------------------------

const REQUIRED_EXPORTS = ["set_opstats", "get_opstats", "opstats_reset", "get_opstats_buffer", "get_opstats_addr", "get_opstats_simd"];
const wasmPath = resolve(REPO, WASM);
if (!existsSync(wasmPath)) {
    notes.push(`${WASM} absent — export check skipped (build vendor/v86 to cover it)`);
} else {
    const bytes = readFileSync(wasmPath);
    const mod = new WebAssembly.Module(bytes);
    const present = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
    for (const name of REQUIRED_EXPORTS) {
        if (!present.has(name)) {
            fail(`${WASM} does not export \`${name}\`: the artifact predates the runtime census switch, so the `
                + "census would read as empty rather than as unavailable. Run vendor/v86/build-wasm.sh.");
        }
    }
    if (failures.length === 0) notes.push(`${WASM} exports all ${REQUIRED_EXPORTS.length} census readers`);
}

// -------------------------------------------------------------------------

if (failures.length > 0) {
    console.error("validate-census-abi: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log(`validate-census-abi: OK (${notes.length} checks)`);
for (const n of notes) console.log(`  - ${n}`);
