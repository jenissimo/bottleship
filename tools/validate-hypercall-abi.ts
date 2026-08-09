/**
 * Gate step: the HYPERCALL_PAGE ABI is declared TWICE — once in Rust
 * (vendor/v86/src/rust/cpu/hypercall.rs) and once in TS
 * (src/worker/core/cpu/hypercall-data.ts) — and the only thing holding the two
 * copies together is a comment saying "must match hypercall.rs".
 *
 * A drift here is silent and vicious: JS publishes a value at one offset, WASM reads
 * another, and the guest gets a plausible-looking wrong answer with no fault, no log
 * and no crash. (This validator exists because a stale `OFF_HC_FALLBACK_COUNTS = 0x0C0`
 * sat in the TS file pointing at 68 bytes nothing ever wrote — overlapping the dispatch
 * table — and was read back as if it were data.)
 *
 * Four rules:
 *   1. Every OFF_HC_* name declared on BOTH sides must carry the same value.
 *   2. Every handler id TS can write into the dispatch table must have a Rust dispatch
 *      arm. A missing arm is not a crash — the match falls through to `_ => false` and
 *      the call quietly takes the slow JS path forever.
 *   3. No offset may point past the end of HYPERCALL_PAGE.
 *   4. No two slots may OVERLAP. Rules 1–3 could not see the very drift this header
 *      describes: a TS-only offset is skipped by rule 1 (no Rust counterpart to disagree
 *      with) and passes rule 3 (it is inside the page) while its 68 bytes sit on top of
 *      the dispatch table. An offset is only meaningful against its neighbours, so the
 *      check has to be about EXTENTS.
 *
 * Extents come from the Rust layout table at the top of hypercall.rs — which is why that
 * comment is parsed rather than trusted: it is the one place the array lengths are
 * written down ([u8; 4096], [u32; 256], …). A slot the table does not document is sized
 * from its `HC_*_SLOTS`/`_COUNT` companion (× 4) if it has one, else as a bare u32.
 *
 * Names declared on only one side are listed, not failed: some slots are legitimately
 * one-sided (JS-only bookkeeping, Rust-internal relative offsets).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const RUST = "vendor/v86/src/rust/cpu/hypercall.rs";
const TS = "src/worker/core/cpu/hypercall-data.ts";

const rust = readFileSync(resolve(REPO, RUST), "utf8");
const ts = readFileSync(resolve(REPO, TS), "utf8");

const num = (raw: string) => Number(raw.replaceAll("_", ""));

/** `const OFF_HC_FOO: usize = 0x123;` (optionally pub / pub(crate)) */
function rustOffsets(src: string): Map<string, number> {
    const out = new Map<string, number>();
    const re = /^\s*(?:pub(?:\([a-z]+\))?\s+)?const\s+(OFF_HC_[A-Z0-9_]+)\s*:\s*usize\s*=\s*(0[xX][0-9a-fA-F_]+|\d[\d_]*)\s*;/gm;
    for (const m of src.matchAll(re)) out.set(m[1]!, num(m[2]!));
    return out;
}

/** `const OFF_HC_FOO = 0x123;` (optionally export) */
function tsOffsets(src: string): Map<string, number> {
    const out = new Map<string, number>();
    const re = /^\s*(?:export\s+)?const\s+(OFF_HC_[A-Z0-9_]+)\s*=\s*(0[xX][0-9a-fA-F_]+|\d[\d_]*)\s*;/gm;
    for (const m of src.matchAll(re)) out.set(m[1]!, num(m[2]!));
    return out;
}

/**
 * The `//!   0x1100: hc_fls_allocated [u8; 129] — …` layout table. Offset -> byte extent.
 * `u32`/`i32` are 4; `[uN; C]` is C * N/8.
 */
function docExtents(src: string): Map<number, { name: string; size: number }> {
    const out = new Map<number, { name: string; size: number }>();
    const re = /^\/\/!\s+(0[xX][0-9a-fA-F_]+):\s+(\S+)\s+(\[\s*[iu](\d+)\s*;\s*(\d[\d_]*)\s*\]|[iu](?:8|16|32|64))/gm;
    for (const m of src.matchAll(re)) {
        const offset = num(m[1]!);
        const size = m[4]
            ? (num(m[5]!) * Number(m[4]) / 8)
            : Number(m[3]!.slice(1)) / 8;
        out.set(offset, { name: m[2]!, size });
    }
    return out;
}

/** `const HC_HANDLER_SLOTS = 256;` / `: usize = 256;`, either side. */
function slotCounts(...sources: string[]): Map<string, number> {
    const out = new Map<string, number>();
    const re = /^\s*(?:pub(?:\([a-z]+\))?\s+|export\s+)?const\s+([A-Z0-9_]+(?:_SLOTS|_COUNT|_SLOT_COUNT))\s*(?::\s*\w+\s*)?=\s*(0[xX][0-9a-fA-F_]+|\d[\d_]*)\s*;/gm;
    for (const src of sources) for (const m of src.matchAll(re)) out.set(m[1]!, num(m[2]!));
    return out;
}

const pageSizeMatch = rust.match(/static\s+mut\s+HYPERCALL_PAGE\s*:\s*\[u8;\s*(\d[\d_]*)\s*\]/);
if (!pageSizeMatch) {
    console.error(`Could not find the HYPERCALL_PAGE declaration in ${RUST}.`);
    console.error("This validator cannot check an ABI it cannot locate — fix the parser, do not delete the step.");
    process.exit(1);
}
const PAGE_SIZE = num(pageSizeMatch[1]!);

const rOff = rustOffsets(rust);
const tOff = tsOffsets(ts);

// Rust dispatch arms: `82 => handle_get_capture(),` plus the `128..=255 =>` band.
const dispatched = new Set<number>();
let bandLo = -1, bandHi = -1;
for (const m of rust.matchAll(/^\s*(\d+)\s*=>\s*\w+\(/gm)) dispatched.add(Number(m[1]!));
const band = rust.match(/^\s*(\d+)\s*\.\.=\s*(\d+)\s*=>/m);
if (band) { bandLo = Number(band[1]!); bandHi = Number(band[2]!); }
const isDispatched = (id: number) => dispatched.has(id) || (id >= bandLo && id <= bandHi && bandLo >= 0);

// TS handler ids: `const HANDLER_FOO = 82;` (exported or not).
const tsHandlers = new Map<string, number>();
for (const m of ts.matchAll(/^\s*(?:export\s+)?const\s+(HANDLER_[A-Z0-9_]+)\s*=\s*(\d+)\s*;/gm)) {
    tsHandlers.set(m[1]!, Number(m[2]!));
}

const errors: string[] = [];

// Rule 1 — shared names must agree.
const shared: string[] = [];
for (const [name, rv] of rOff) {
    const tv = tOff.get(name);
    if (tv === undefined) continue;
    shared.push(name);
    if (tv !== rv) {
        errors.push(
            `${name}: Rust 0x${rv.toString(16)} vs TS 0x${tv.toString(16)}\n` +
            `      ${RUST} and ${TS} disagree — JS would write where WASM does not read.`,
        );
    }
}

// Rule 2 — every TS handler id must be dispatched in Rust.
for (const [name, id] of tsHandlers) {
    if (!isDispatched(id)) {
        errors.push(
            `${name} = ${id}: no dispatch arm in ${RUST}\n` +
            `      try_dispatch's match falls to \`_ => false\`, so every call silently takes the JS path.`,
        );
    }
}

// Rule 3 — nothing may point past the page.
for (const [name, v] of [...rOff, ...tOff]) {
    if (v >= PAGE_SIZE) {
        errors.push(`${name} = 0x${v.toString(16)} is at/past the end of HYPERCALL_PAGE (${PAGE_SIZE} bytes).`);
    }
}

// Rule 4 — no two slots may overlap.
const doc = docExtents(rust);
const counts = slotCounts(rust, ts);

/** `OFF_HC_A_B_C` -> the widest `HC_A_B_C_SLOTS` / `HC_A_B_SLOTS` / … that is declared. */
function slotCountFor(name: string): number | undefined {
    const words = name.replace(/^OFF_(HC_)?/, "").split("_");
    for (let take = words.length; take > 0; take--) {
        const stem = `HC_${words.slice(0, take).join("_")}`;
        for (const suffix of ["_SLOTS", "_COUNT", "_SLOT_COUNT"]) {
            const n = counts.get(stem + suffix);
            if (n !== undefined) return n;
        }
    }
    return undefined;
}

const slots: { name: string; start: number; end: number; sized: string }[] = [];
for (const name of new Set([...rOff.keys(), ...tOff.keys()])) {
    const start = rOff.get(name) ?? tOff.get(name)!;
    const documented = doc.get(start);
    const declared = documented ? undefined : slotCountFor(name);
    const size = documented?.size ?? (declared !== undefined ? declared * 4 : 4);
    const sized = documented ? "layout table" : declared !== undefined ? `${declared} slots x u32` : "u32";
    slots.push({ name, start, end: start + size, sized });
}
slots.sort((a, b) => a.start - b.start || a.end - b.end);
for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1]!, cur = slots[i]!;
    if (cur.start < prev.end) {
        errors.push(
            `${cur.name} (0x${cur.start.toString(16)}..0x${cur.end.toString(16)}, ${cur.sized}) OVERLAPS ` +
            `${prev.name} (0x${prev.start.toString(16)}..0x${prev.end.toString(16)}, ${prev.sized})\n` +
            `      One of them is writing over the other's bytes — silently, with no fault and no log.`,
        );
    }
}

if (doc.size === 0) {
    console.error(`Parsed 0 entries from the layout table at the top of ${RUST} — the overlap rule would`);
    console.error("size every slot as a bare u32 and stop seeing array collisions. Fix the regex.");
    process.exit(1);
}

if (shared.length === 0) {
    console.error("Parsed 0 shared OFF_HC_* names — the parser has drifted from the source and this");
    console.error("step would pass no matter what the two files said. Fix the regexes.");
    process.exit(1);
}

if (errors.length > 0) {
    console.error("HYPERCALL_PAGE ABI drift between Rust and TS:\n");
    for (const e of errors) console.error(`  ${e}\n`);
    console.error(`${errors.length} violation(s).`);
    process.exit(1);
}

const rustOnly = [...rOff.keys()].filter(n => !tOff.has(n));
const tsOnly = [...tOff.keys()].filter(n => !rOff.has(n));
console.log(
    `Hypercall ABI OK — ${shared.length} shared offset(s) agree, ` +
    `${tsHandlers.size} handler id(s) all dispatched, ${slots.length} slot(s) sized from ` +
    `${doc.size} layout-table entries with no overlap, page ${PAGE_SIZE} bytes ` +
    `(${rustOnly.length} Rust-only, ${tsOnly.length} TS-only slot(s)).`,
);
