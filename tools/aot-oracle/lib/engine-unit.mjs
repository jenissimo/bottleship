/**
 * Publishing a unit into a live v86 instance — the part that is the same wherever the engine runs.
 *
 * The Node arm and the browser arm must stage a unit through IDENTICAL steps, or a difference
 * between them is a difference between two loaders rather than between two runtimes. So the
 * transaction, the identity envelope, the codegen shape and the liveness read live here once and
 * both arms call them.
 *
 * Nothing in this file may touch Node: no `fs`, no `crypto`, no `process`. What needs those is
 * passed in — the engine hash by the caller, page hashing as a function — because that is exactly
 * the set of things a browser computes differently and everything else must not be.
 */

/** v86 places JIT slot i at wasm_table[i + WASM_TABLE_OFFSET] (vendor/v86/src/const.js). */
export const WASM_TABLE_OFFSET = 1024;
/** vendor/v86/src/rust/jit.rs and src/const.js. */
export const WASM_TABLE_SIZE = 900;
export const PAGE_SIZE = 4096;

/** The AOT ABI this loader speaks. A manifest naming another one is refused, never adapted. */
export const AOT_ABI = 5;
/** The JIT config ABI the shape knobs belong to. */
export const JIT_CONFIG_ABI = 4;

class EngineError extends Error {}

/** The Rust JIT's own codegen identity, read from the instance that will receive the unit. */
export function jitIdentity(ex) {
    for (const fn of [
        "jit_config_abi_version", "jit_config_supported_mask",
        "jit_codegen_fingerprint_lo", "jit_codegen_fingerprint_hi",
    ]) {
        if (typeof ex[fn] !== "function") {
            throw new EngineError(`engine lacks ${fn} — cannot verify Rust JIT codegen identity`);
        }
    }
    const abi = ex.jit_config_abi_version() >>> 0;
    if (abi !== JIT_CONFIG_ABI) {
        throw new EngineError(`unsupported JIT config ABI ${abi}; expected ${JIT_CONFIG_ABI}`);
    }
    return {
        abi,
        supported_mask: ex.jit_config_supported_mask() >>> 0,
        fingerprint_lo: ex.jit_codegen_fingerprint_lo() >>> 0,
        fingerprint_hi: ex.jit_codegen_fingerprint_hi() >>> 0,
    };
}

/**
 * The replay envelope: every field measured from the live instance, not requested of it.
 *
 * `engineSha256` is the one thing this cannot measure — a wasm module does not carry the hash of
 * its own bytes — so the caller supplies it, having hashed the file it loaded.
 */
export function aotIdentity(cpu, engineSha256) {
    if (!cpu.memory_size || !Number.isInteger(cpu.memory_size[0])) {
        throw new EngineError("engine lacks live memory_size — cannot verify AOT RAM identity");
    }
    return {
        aot_abi: AOT_ABI,
        engine_sha256: engineSha256,
        ram_size: cpu.memory_size[0] >>> 0,
        ...jitIdentity(cpu.wm.exports),
    };
}

export function manifestMatchesLiveIdentity(manifest, live) {
    const got = manifest.jit_identity;
    if (!got || typeof got !== "object") return false;
    return got.aot_abi === live.aot_abi
        && got.engine_sha256 === live.engine_sha256
        && got.ram_size === live.ram_size
        && got.abi === live.abi
        && got.supported_mask === live.supported_mask
        && got.fingerprint_lo === live.fingerprint_lo
        && got.fingerprint_hi === live.fingerprint_hi;
}

/**
 * Install the codegen shape and PROVE it took.
 *
 * Every knob is read back: a setter that silently normalises a value, or an index the build does
 * not support, would otherwise produce a run that measures one shape and is labelled another.
 */
export function applyShape(ex, { flags, relaxed }) {
    for (const fn of ["set_jit_config", "get_jit_config", "set_relaxed_fpu", "get_relaxed_fpu"]) {
        if (typeof ex[fn] !== "function") {
            throw new EngineError(`engine lacks ${fn} — not the BottleShip fork, or too old to `
                + "verify its own codegen shape");
        }
    }
    const before = jitIdentity(ex);
    const effective = {};
    for (const [i, v] of flags) {
        if (!(before.supported_mask & (1 << i))) {
            throw new EngineError(`JIT config index ${i} is unsupported by mask `
                + `0x${before.supported_mask.toString(16)}`);
        }
        const status = ex.set_jit_config(i, v);
        if (status !== 0) {
            throw new EngineError(`set_jit_config(${i}, ${v}) failed with status ${status}`);
        }
        const got = ex.get_jit_config(i) >>> 0;
        if (got !== (v >>> 0)) {
            throw new EngineError(`set_jit_config(${i}, ${v}) read back ${got} — the knob did not `
                + "take (unknown index, or a boolean normalised); refusing to run a shape nobody "
                + "asked for");
        }
        effective[i] = got;
    }
    ex.set_relaxed_fpu(relaxed);
    const gotRelaxed = ex.get_relaxed_fpu() >>> 0;
    if (gotRelaxed !== relaxed) {
        throw new EngineError(`set_relaxed_fpu(${relaxed}) read back ${gotRelaxed}`);
    }
    return { flags: effective, relaxed: gotRelaxed, identity: jitIdentity(ex) };
}

/**
 * Patch the values only a live instance knows.
 *
 * Anything an offline compiler could have known is baked into the bytes; a unit that declares a
 * relocation the loader has no value for is REFUSED, never patched with a guess.
 */
export function applyRelocations(bytes, unit, values) {
    for (const r of unit.relocs ?? []) {
        const v = values[r.kind];
        if (v === undefined) throw new EngineError(`no value for relocation ${r.kind}`);
        if (r.width !== 5) throw new EngineError(`relocation width ${r.width} unsupported`);
        let x = v >>> 0;
        for (let i = 0; i < 5; i++) {
            bytes[r.fileOffset + i] = (x & 0x7f) | (i < 4 ? 0x80 : 0);
            x >>>= 7;
        }
    }
    return bytes;
}

/**
 * Stage one unit through the engine's own AOT transaction and commit it.
 *
 * `pageSha(physPage)` answers what the LIVE page hashes to. It is a parameter because hashing is
 * the one step a browser cannot do synchronously; everything else is the same call sequence.
 *
 * Refusal is always safe — the page keeps the ordinary JIT path — so every failure here costs
 * performance, never correctness.
 */
export function publishUnit(cpu, unit, identity, { pageSha, countExecutions = true }) {
    const w = cpu.wm.exports;
    const table = cpu.wm.wasm_table;
    const refuse = (why) => ({ registered: false, why });
    /**
     * How many times the unit RAN, counted on our side of the import boundary.
     *
     * The engine's own per-module entry counter dies with the module, and a unit that hands
     * control back on its own page is freed by the engine the first time it does. So a run that
     * entered the unit and a run that never published it look identical afterwards — which makes
     * "the answer matched" evidence about nothing. Every exit calls `jit_tier2_note_aot_retired`
     * (contract N30), so wrapping it in an import object of OUR own leaves a count that survives
     * the module. The wrapper is per-instance and forwards, so the engine sees what it always saw.
     *
     * It is also a JS call per exit that only the CANDIDATE arm pays, so a run whose purpose is a
     * time is published with `countExecutions: false`. Such a run gives up the surviving count and
     * must establish entry the other way — the engine's own per-slot counter, read at the end
     * through `aotLiveness`, which is free and just as unforgeable for a unit that still owns its
     * page. A run that measures has to demand that anyway.
     */
    let executions = 0;

    for (const p of unit.pages) {
        if (!Number.isInteger(p.physPage) || p.physPage < 0 || p.physPage > 0xFFFFF) {
            return refuse("bad-physical-page");
        }
        const live = pageSha(p.physPage);
        if (live !== p.sha) {
            return refuse(`content-mismatch page 0x${p.physPage.toString(16)}: `
                + `live ${live.slice(0, 16)} != unit ${p.sha.slice(0, 16)}`);
        }
    }
    let fn;
    try {
        const engine = cpu.jit_imports;
        const imports = countExecutions
            ? {
                ...engine,
                jit_tier2_note_aot_retired: (n) => {
                    executions += 1;
                    return engine.jit_tier2_note_aot_retired?.(n);
                },
            }
            : engine;
        const inst = new WebAssembly.Instance(new WebAssembly.Module(unit.bytes), { e: imports });
        fn = inst.exports["f"];
        if (typeof fn !== "function") return refuse("no-export-f");
    } catch (e) {
        return refuse(`instantiate: ${String(e).slice(0, 120)}`);
    }
    const required = ["jit_aot_tx_begin", "jit_aot_tx_page_begin", "jit_aot_tx_entry_push",
        "jit_aot_tx_page_finish", "jit_aot_tx_prepare_finish", "jit_aot_tx_commit", "jit_aot_tx_abort"];
    if (!required.every((name) => typeof w[name] === "function")) return refuse("transaction-api-unavailable");
    if (!(unit.tableIndex > 0 && unit.tableIndex < WASM_TABLE_SIZE)) return refuse("bad-table-index");
    let rc = w.jit_aot_tx_begin(unit.tableIndex, unit.pages.length,
        identity.fingerprint_lo, identity.fingerprint_hi) >>> 0;
    if (rc !== 0) return refuse(`tx-begin-${rc}`);
    const abort = () => (w.jit_aot_tx_abort() >>> 0) === 0;
    for (const p of unit.pages) {
        rc = w.jit_aot_tx_page_begin(p.physPage * PAGE_SIZE, p.stateFlags, p.entries.length) >>> 0;
        if (rc !== 0) break;
        for (const [off, st] of p.entries) {
            rc = w.jit_aot_tx_entry_push(off, st) >>> 0;
            if (rc !== 0) break;
        }
        if (rc !== 0) break;
        rc = w.jit_aot_tx_page_finish() >>> 0;
        if (rc !== 0) break;
    }
    if (rc === 0) rc = w.jit_aot_tx_prepare_finish() >>> 0;
    if (rc !== 0) {
        return abort() ? refuse(`tx-prepare-${rc}`) : refuse(`tx-prepare-${rc}-abort-failed`);
    }
    let tableMayHaveBeenWritten = false;
    try {
        tableMayHaveBeenWritten = true;
        table.set(unit.tableIndex + WASM_TABLE_OFFSET, fn);
        rc = w.jit_aot_tx_commit() >>> 0;
        if (rc !== 0) throw new Error(`commit-${rc}`);
    } catch (e) {
        if (tableMayHaveBeenWritten) {
            try { table.set(unit.tableIndex + WASM_TABLE_OFFSET, null); }
            catch { return refuse("table-clear-failed-staged-slot-retained"); }
        }
        return abort() ? refuse(`tx-post-set-${String(e).slice(0, 120)}`) : refuse("tx-abort-failed");
    }
    w.jit_aot_flush_tlb();
    return {
        registered: true, idx: unit.tableIndex, fn,
        pages: unit.pages.map((p) => p.physPage),
        // Null, not zero: "we did not count" and "it never ran" must not read the same.
        executions: countExecutions ? () => executions : null,
        counted: countExecutions,
    };
}

/**
 * Was EVERY published unit still ours at the end, and was each actually entered?
 *
 * Function identity, not "the page points at our slot": a freed slot is recycled by the very next
 * compilation, so a slot check credits the AOT unit with a JIT module's work.
 */
export function aotLiveness(cpu, aotUnits) {
    if (aotUnits.length === 0) return null;
    const w = cpu.wm.exports;
    const table = cpu.wm.wasm_table;
    const per = aotUnits.map((u) => {
        if (!u.registered) return { registered: false, why: u.why };
        const sameFn = table.get(u.idx + WASM_TABLE_OFFSET) === u.fn;
        const ownsPage = u.pages.some((p) => (w.jit_aot_page_table_index(p * PAGE_SIZE) >>> 0) === u.idx);
        const entries = w.jit_get_module_entry_total ? w.jit_get_module_entry_total(u.idx) >>> 0 : null;
        return {
            registered: true, idx: u.idx, pages: u.pages.map((p) => "0x" + p.toString(16)),
            alive: sameFn && ownsPage, sameFn, ownsPage, entries,
            // The engine's counter is gone once the module is; ours is not — when there is one.
            executions: u.executions ? u.executions() : null,
            counted: u.counted === true,
            entered: sameFn && ownsPage && entries > 0,
        };
    });
    const all = (f) => per.every(f);
    return {
        registered: all((u) => u.registered === true),
        alive: all((u) => u.alive === true),
        entered: all((u) => u.entered === true),
        sameFn: all((u) => u.sameFn === true),
        ownsPage: all((u) => u.ownsPage === true),
        units: per.length,
        entries: per.reduce((n, u) => n + (u.entries ?? 0), 0),
        executions: per.every((u) => u.counted)
            ? per.reduce((n, u) => n + (u.executions ?? 0), 0)
            : null,
        why: per.filter((u) => !u.registered).map((u) => u.why).join("; ") || undefined,
        per_unit: per,
    };
}
