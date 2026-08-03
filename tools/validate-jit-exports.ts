#!/usr/bin/env bun
/**
 * Every helper the JIT codegen names in a generated module must be reachable through
 * `cpu.jit_imports`, or the module fails to LINK.
 *
 * A link failure is catastrophic and near-silent: `WebAssembly.instantiate` rejects, nothing
 * on the Rust side observes it, `codegen_finalize_finished` never runs, and JitState's single
 * in-flight `compiling` slot is never released — so `jit_increase_hotness_and_maybe_compile`
 * returns early forever and the JIT is dead for the life of the instance while the guest keeps
 * running interpreted (~7x slower) without an error anywhere. Every offline oracle still
 * passes, because none of them instantiate a generated module against the real export table.
 *
 * This check is that missing oracle. It costs milliseconds:
 *   1. collect every string literal the Rust codegen passes to a builder call_fn / gen_fn_const
 *      helper — those are the import names written into generated modules;
 *   2. read the export table of the BUILT vendor/v86/build/v86.wasm;
 *   3. apply cpu.js create_jit_imports()'s own filter (it skips `_*`, `zstd*` and `*_js`, so an
 *      export can exist and still not be importable);
 *   4. fail on any name the generated module would ask for and not get.
 *
 * Usual cause of a failure: a `#[no_mangle]` that drifted off the function it decorated.
 */
const WASM = process.env.V86_WASM_PATH || "vendor/v86/build/v86.wasm";
const RUST_DIRS = ["vendor/v86/src/rust"];

// The captured name must allow UPPERCASE: dozens of real imports are instruction helpers
// (`instr_0F6E`, `instr16_D9_4_reg`). A lowercase-only class silently sees none of them, which
// is the check quietly not checking most of its subject.
const CALL_SITE = /(?:call_fn\d*[a-z0-9_]*|gen_fn\d_const)\s*\(\s*(?:[a-z_]+\s*,\s*)?"([A-Za-z0-9_]+)"/;

async function rustFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for await (const e of new Bun.Glob("**/*.rs").scan({ cwd: dir, absolute: true })) out.push(e);
    return out;
}

/**
 * Collect emitted import names, SKIPPING call sites that the shipped build never reaches:
 * `if cfg!(feature = "profiler")` / `if cfg!(debug_assertions)` blocks and `#[cfg(test)]`
 * modules. Their callees are genuinely absent from the release wasm, and treating them as
 * failures would make the check cry wolf until someone turns it off.
 *
 * Brace-depth tracking rather than a hand-maintained allowlist, so the check keeps working
 * when a helper moves in or out of a gate.
 */
function emittedNames(src: string): string[] {
    const names: string[] = [];
    const skipUntil: number[] = [];     // brace depths at which an inactive region ends
    let depth = 0;
    // An `if cfg!(…)` carries its `{` on the same line, but a `#[cfg(…)]` attribute sits on
    // its OWN line and the block opens on the next one. Binding the region to the depth at
    // its opening brace covers both; deriving it from the attribute line's depth records -1
    // for a top-level `#[cfg(test)] mod tests`, a depth no `}` can ever reach — after which
    // every remaining line of the file is treated as inactive and the check silently stops
    // checking. `mod tests` conventionally comes last, which is the only reason that was
    // survivable.
    let pending = false;
    for (const line of src.split("\n")) {
        const opensGate = /\bif\s+cfg!\s*\(\s*(?:feature\s*=\s*"profiler"|debug_assertions)\s*\)/.test(line)
            // `#[cfg(test)]`, `#[cfg(any(test, …))]`, `#[cfg(all(test, …))]`, `#[cfg(debug_assertions)]`
            || /#\[cfg\([^\]]*\b(?:test|debug_assertions)\b/.test(line);
        if (opensGate) pending = true;

        if (skipUntil.length === 0 && !pending) {
            const m = CALL_SITE.exec(line);
            if (m) names.push(m[1]);
        }

        const code = line.replace(/\/\/.*$/, "");
        for (const ch of code) {
            if (ch === "{") {
                if (pending) { skipUntil.push(depth); pending = false; }
                depth++;
            } else if (ch === "}") {
                depth--;
                while (skipUntil.length && depth <= skipUntil[skipUntil.length - 1]) skipUntil.pop();
            }
        }
        // An attribute on a braceless item (`#[cfg(test)] const X: u32 = 1;`) gates nothing;
        // leaving `pending` armed would attach it to the next unrelated block.
        if (pending && !code.includes("{") && /;\s*$/.test(code)) pending = false;
    }
    return names;
}

const wanted = new Map<string, string>();   // import name -> first file that emits it
for (const dir of RUST_DIRS) {
    for (const f of await rustFiles(dir)) {
        for (const name of emittedNames(await Bun.file(f).text())) {
            if (!wanted.has(name)) wanted.set(name, f.replace(/\\/g, "/"));
        }
    }
}

if (wanted.size === 0) {
    console.error(`[validate-jit-exports] FAIL: found no call_fn*("…") sites under ${RUST_DIRS.join(", ")} — the scanner is broken, not the build`);
    process.exit(1);
}

const wasmFile = Bun.file(WASM);
if (!(await wasmFile.exists())) {
    console.error(`[validate-jit-exports] FAIL: ${WASM} not found — run vendor/v86/build-wasm.sh`);
    process.exit(1);
}
// A binary older than the sources certifies the PREVIOUS build — exactly the state in which a
// just-introduced missing export would pass. Refuse rather than reassure.
let newestRust = 0;
for (const dir of RUST_DIRS) {
    for (const f of await rustFiles(dir)) newestRust = Math.max(newestRust, Bun.file(f).lastModified);
}
if (wasmFile.lastModified < newestRust) {
    console.error(`[validate-jit-exports] FAIL: ${WASM} is older than the Rust sources — rebuild first (vendor/v86/build-wasm.sh).`);
    console.error("  Validating a stale binary would pass a missing export that the next build introduces.");
    process.exit(1);
}

const exports = new Set(
    WebAssembly.Module.exports(new WebAssembly.Module(await wasmFile.arrayBuffer())).map(e => e.name),
);
// cpu.js create_jit_imports(): these exports are deliberately NOT copied into jit_imports.
const importable = new Set([...exports].filter(n => !n.startsWith("_") && !n.startsWith("zstd") && !n.endsWith("_js")));

const missing = [...wanted].filter(([n]) => !importable.has(n));
if (missing.length) {
    console.error(`[validate-jit-exports] FAIL: ${missing.length} JIT import(s) are not reachable via cpu.jit_imports.`);
    console.error("Every generated module naming one of these will throw LinkError at instantiate,");
    console.error("wedging the JIT permanently. Usual cause: a lost/re-targeted #[no_mangle].\n");
    for (const [name, file] of missing) {
        const why = exports.has(name) ? "exported but FILTERED OUT by create_jit_imports" : "not exported by v86.wasm";
        console.error(`  ${name}\n      emitted by ${file}\n      ${why}`);
    }
    process.exit(1);
}

console.log(`[validate-jit-exports] OK — ${wanted.size} JIT import(s) all resolvable (${importable.size} importable exports)`);
