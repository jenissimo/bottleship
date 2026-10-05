/**
 * Quality-gate check: `jit_dirty_cache` / `jit_clear_cache_js` have exactly ONE owner.
 *
 * v86 drops a compiled block only when it observes a *guest* store, so every JS-side write
 * of guest-executable bytes has to invalidate the range it wrote. That invariant is easy to
 * forget and its failure is silent and non-local (the CPU keeps running code compiled from
 * the old bytes — wrong thunk dispatched, ESP drift, wild ret). The defence is a single
 * chokepoint, `src/worker/core/memory/guest-code.ts`; a private copy of the invalidation
 * call somewhere else is how the chokepoint erodes back into 25 scattered call sites.
 *
 * Scope, deliberately: this checks OWNERSHIP, not coverage. Deciding whether an arbitrary
 * `mem[addr + i] = byte` targets executable memory needs dataflow (the address is computed,
 * the region kind is a runtime property), so a coverage lint would be either noisy enough to
 * be ignored or narrow enough to be useless. Coverage is enforced structurally instead: the
 * two allocators that hand out executable guest memory (ThunkGenerator's bump, MemoryManager
 * for executable kinds) invalidate what they hand out, so an emitter that forgets is still
 * covered — see guest-code.ts.
 *
 * Usage: bun tools/validate-guest-code-writes.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const JIT_RS = join(ROOT, "vendor", "v86", "src", "rust", "jit.rs");
const OWNER = join("src", "worker", "core", "memory", "guest-code.ts");

/** The only wasm export that clears EVERYTHING; the rest of the family is ranged/per-page. */
const GLOBAL_CLEAR = "jit_clear_cache_js";

/**
 * The invalidation family is DERIVED from v86's own `#[no_mangle]` exports rather than listed
 * here: `jit_dirty_page` is as reachable from JS as `jit_dirty_cache` and is the primitive an
 * in-place emitter reaches for first, so a hand-written pattern is one v86 rename away from
 * naming a hole it no longer covers. Anything v86 newly exports as `jit_dirty*`/`jit_clear*`
 * is in scope the moment the submodule updates.
 */
const BASELINE = [GLOBAL_CLEAR, "jit_dirty_cache", "jit_dirty_page"];

function invalidationExports(): string[] {
    const names = new Set(BASELINE);
    let rust = "";
    try {
        rust = readFileSync(JIT_RS, "utf8");
    } catch {
        console.warn(`[validate-guest-code-writes] ${JIT_RS} unreadable (submodule not checked out?) — using the baseline family only.`);
        return [...names];
    }
    for (const m of rust.matchAll(/#\[no_mangle\][\s\S]{0,200}?\bpub\s+fn\s+(jit_(?:dirty|clear)[A-Za-z0-9_]*)/g)) {
        names.add(m[1]!);
    }
    return [...names];
}

const FAMILY = invalidationExports();
const PATTERN = new RegExp(`\\b(?:${FAMILY.join("|")})\\b`);
/** Everything but the global clear: never legitimate outside guest-code.ts. */
const RANGED = new RegExp(`\\b(?:${FAMILY.filter((n) => n !== GLOBAL_CLEAR).join("|")})\\b`);

/** dbg-commands / preemption-manager own the *global* clear as a deliberate debug/perf knob. */
const GLOBAL_CLEAR_OWNERS = new Set([
    join("src", "worker", "core", "debug", "dbg-commands.ts"),
    join("src", "worker", "core", "cpu", "preemption-manager.ts"),
]);

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) yield full;
    }
}

const violations: string[] = [];

for (const file of walk(SRC)) {
    const rel = relative(ROOT, file).split("/").join(sep);
    if (rel === OWNER) continue;

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
        if (!PATTERN.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may name it
        // The global clear is a legitimate knob in its owners; a ranged/per-page dirty never is.
        if (GLOBAL_CLEAR_OWNERS.has(rel) && !RANGED.test(line)) return;
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
}

if (violations.length > 0) {
    console.error("JIT invalidation must go through memory/guest-code.ts");
    console.error("(invalidateGuestCode / writeGuestCode — see the header there for why).\n");
    for (const v of violations) console.error(`  ${v}`);
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
}

console.log(`Guest-code invalidation ownership OK — no private call sites (${FAMILY.length} export(s) watched: ${FAMILY.join(", ")}).`);
