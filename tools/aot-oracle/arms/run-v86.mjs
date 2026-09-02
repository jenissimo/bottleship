#!/usr/bin/env node
// aot-oracle ARM — v86-hosted. Two roles, one script, because they must be identical in
// every respect except the one under test:
//
//   reference : "what our JIT does today" — the fork booted headless with BottleShip's
//               production codegen configuration, relaxed FPU, paging on.
//   unit      : the same thing with a CANDIDATE AOT MODULE published for the case's code
//               pages before the guest runs (one staged transaction + one jit_aot_flush_tlb,
//               entered through wasm_table[idx+1024] — the real dispatch path, not a direct
//               export call).
//
//   node run-v86.mjs --case k1 [--outer N] [--warmup W] [--aot unit.json] [--capture out]
//                    [--fault name] [--flags "5=0"] [--relaxed 0]
//
// Prints ONE JSON object on stdout (the last line). Everything the oracle compares or gates
// on is in it: the compared guest regions (bytes, not just hashes), the full architectural
// state at the capture point, the JIT facts, and the AOT liveness facts.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { buildImage } from "../corpus/image.mjs";
import * as L from "../corpus/layout.mjs";
import { getCase } from "../corpus/cases.mjs";
import { readV86State } from "../lib/state.mjs";
import { parseArgs, parseFlagOverrides, usageExit } from "../lib/args.mjs";
import { findTlbDataBase, ORACLE_PROBE_PAGES } from "../../aot/lib/tlb-base.mjs";
import { SHIPPING_JIT } from "../../jit-config/shipping.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const WASM_TABLE_OFFSET = 1024;   // vendor/v86/src/const.js
const WASM_TABLE_SIZE = 900;      // vendor/v86/src/rust/jit.rs and src/const.js
const PAGE_SIZE = 4096;

const KNOWN = ["case", "outer", "warmup", "timeout", "aot", "capture", "fault", "flags", "relaxed"];
let args;
try { args = parseArgs(process.argv, KNOWN); } catch (e) { usageExit(e); }

const c = getCase(args.case || "k1");
const n1 = Number(args.outer || 20000);
const warmup = Number(args.warmup || 4000);
const n2 = n1 * 2;
const timeoutMs = Number(args.timeout || 600000);
if (n1 < 1 || warmup < 1) { console.error("--outer/--warmup must be >= 1"); process.exit(2); }

// BottleShip's production codegen configuration, from the ONE list every offline tool shares
// (tools/jit-config/shipping.mjs), so the arms measure the shape production runs. The WHOLE
// envelope is applied, not just the indices PreemptionManager overrides, so a reused engine
// cannot leak a diagnostic value into an arm.
//
// Tier-2 is intentionally OFF in shipping; pass `--flags "15=19200000"` for the separate
// experimental tiering oracle. `--flags "10=0,5=0"` overrides individual entries; `--relaxed 0`
// switches x87 to strict F80. These values are applied before capture; Rust exports the
// authoritative identity of their codegen effect, which is what capture/replay compare.
const JIT_FLAGS = new Map(SHIPPING_JIT);
let FLAG_OVERRIDES;
try { FLAG_OVERRIDES = parseFlagOverrides(args.flags); } catch (e) { usageExit(e); }
for (const [i, v] of FLAG_OVERRIDES) JIT_FLAGS.set(i, v);
const relaxed = args.relaxed === undefined ? 1 : Number(args.relaxed);
if (relaxed !== 0 && relaxed !== 1) { console.error(`--relaxed must be 0 or 1, got ${args.relaxed}`); process.exit(2); }

const ENGINE_DIR = path.resolve(process.env.V86_ENGINE_DIR || path.join(REPO, "vendor/v86"));
const libv86Path = path.join(ENGINE_DIR, "build/libv86.mjs");
const wasmPath = path.join(ENGINE_DIR, "build/v86.wasm");
for (const p of [libv86Path, wasmPath]) {
    if (!fs.existsSync(p)) { console.error(`missing ${p} — build the fork first`); process.exit(2); }
}
const { V86 } = await import(url.pathToFileURL(libv86Path).href);

const image = buildImage(c, { warmup, n1, n2 });
let faultApplied = null;
if (args.fault) {
    const f = c.faults?.[args.fault];
    if (!f) { console.error(`case ${c.id} has no fault "${args.fault}"`); process.exit(2); }
    faultApplied = { name: args.fault, detail: f(new DataView(image.buf.buffer), L.CODE_BASE) };
}

const emulator = new V86({
    autostart: false, memory_size: L.MEM_SIZE, vga_memory_size: 1024 * 1024,
    wasm_path: wasmPath, log_level: 0,
});

const marks = [];
let done = false;
const codePages = new Set([c.codeAddr >>> 12, L.CODE_BASE >>> 12]);
if (args.capture) globalThis["__wasmDump"] = { pages: codePages, out: [], keepLatestPerPage: true };

const aotUnits = [];     // EVERY unit we published, for liveness at the end
let relocApplied = null; // relocation values taken from the manifest, audited at the end
// The codegen shape READ BACK OUT of the engine, never the shape we asked for: the reported
// value has to be the measured one, or a knob that silently failed to take would be reported
// as if it had (see applyShape()).
let effectiveFlags = null, effectiveRelaxed = null, effectiveJitIdentity = null;
const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const shaPage = (mem, addr) => sha256(Buffer.from(mem.subarray(addr, addr + PAGE_SIZE)));

/**
 * Install the codegen shape and PROVE it took.
 *
 * `set_jit_config` on an index the engine does not know is a no-op in a release build
 * (`jit.rs` `_ => dbg_assert!(false)`), and a boolean knob silently normalizes any nonzero to
 * 1 — so "we called the setter" is not evidence the shape is what the report will claim. Every
 * value is read back through `get_jit_config` and a mismatch aborts the arm, because the
 * alternative is a run that measures one shape and is labelled another (design F-d).
 */
function jitIdentity(ex) {
    for (const fn of [
        "jit_config_abi_version", "jit_config_supported_mask",
        "jit_codegen_fingerprint_lo", "jit_codegen_fingerprint_hi",
    ]) {
        if (typeof ex[fn] !== "function") {
            console.error(`engine lacks ${fn} — cannot verify Rust JIT codegen identity`);
            process.exit(2);
        }
    }
    const abi = ex.jit_config_abi_version() >>> 0;
    if (abi !== 4) {
        console.error(`unsupported JIT config ABI ${abi}; expected 4`);
        process.exit(2);
    }
    return {
        abi,
        supported_mask: ex.jit_config_supported_mask() >>> 0,
        fingerprint_lo: ex.jit_codegen_fingerprint_lo() >>> 0,
        fingerprint_hi: ex.jit_codegen_fingerprint_hi() >>> 0,
    };
}

// This is the replay envelope, not a request-shaped configuration. Every field is measured
// from the instance that will receive the staged unit, so a manifest cannot cross an engine,
// RAM, codegen, or AOT-transaction ABI boundary by accident.
function aotIdentity(cpu) {
    const ex = cpu.wm.exports;
    // `memory_size` is the live guest-RAM word maintained by the engine (and is what the JS
    // allocator/restart paths use). It is authoritative even on builds that deliberately do
    // not expose a redundant wasm getter.
    if (!cpu.memory_size || !Number.isInteger(cpu.memory_size[0])) {
        console.error("engine lacks live memory_size — cannot verify AOT RAM identity");
        process.exit(2);
    }
    return {
        aot_abi: 5,
        engine_sha256: sha256(fs.readFileSync(wasmPath)),
        ram_size: cpu.memory_size[0] >>> 0,
        ...jitIdentity(ex),
    };
}

function manifestMatchesLiveIdentity(manifest, live) {
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

function applyShape(ex) {
    for (const fn of ["set_jit_config", "get_jit_config", "set_relaxed_fpu", "get_relaxed_fpu"]) {
        if (typeof ex[fn] !== "function") {
            console.error(`engine lacks ${fn} — not the BottleShip fork, or too old to verify its own codegen shape`);
            process.exit(2);
        }
    }
    const before = jitIdentity(ex);
    const eff = {};
    for (const [i, v] of JIT_FLAGS) {
        if (!(before.supported_mask & (1 << i))) {
            console.error(`JIT config index ${i} is unsupported by mask 0x${before.supported_mask.toString(16)}`);
            process.exit(2);
        }
        const status = ex.set_jit_config(i, v);
        if (status !== 0) {
            console.error(`set_jit_config(${i}, ${v}) failed with status ${status}`);
            process.exit(2);
        }
        const got = ex.get_jit_config(i) >>> 0;
        if (got !== (v >>> 0)) {
            console.error(`set_jit_config(${i}, ${v}) read back ${got} — the knob did not take `
                + `(unknown index, or a boolean normalised); refusing to run a shape nobody asked for`);
            process.exit(2);
        }
        eff[i] = got;
    }
    ex.set_relaxed_fpu(relaxed);
    const gotRelaxed = ex.get_relaxed_fpu() >>> 0;
    if (gotRelaxed !== relaxed) {
        console.error(`set_relaxed_fpu(${relaxed}) read back ${gotRelaxed}`);
        process.exit(2);
    }
    effectiveFlags = eff;
    effectiveRelaxed = gotRelaxed;
    effectiveJitIdentity = jitIdentity(ex);
}

function jitFacts(cpu) {
    const ex = cpu.wm.exports;
    const out = { pages: [], tier2Promotions: null, tier2Pages: null, speculatedStoresCompiled: null };
    try {
        const n = ex.jit_snapshot_cache();
        for (let i = 0; i < n; i++) {
            out.pages.push({
                page: "0x" + (ex.jit_snapshot_get_phys_addr(i) >>> 12).toString(16),
                entries: ex.jit_snapshot_get_entry_count(i),
            });
        }
        out.tier2Promotions = ex.jit_get_tier2_promotions ? ex.jit_get_tier2_promotions() : null;
        out.tier2Pages = ex.jit_get_tier2_page_count ? ex.jit_get_tier2_page_count() : null;
        out.speculatedStoresCompiled = ex.fastmem_get_speculated_stores_compiled
            ? ex.fastmem_get_speculated_stores_compiled() : null;
    } catch (e) { out.error = String(e); }
    return out;
}

function regions(cpu) {
    return c.regions.map((r) => {
        const slice = Buffer.from(cpu.mem8.subarray(r.addr, r.addr + r.len));
        return { name: r.name, addr: r.addr, len: r.len, fields: r.fields ?? null,
            sha256: sha256(slice), hex: slice.toString("hex") };
    });
}

/**
 * Publish a candidate unit. Mirrors src/worker/core/cpu/aot-cache.ts replay() — deliberately,
 * because the oracle must exercise the SAME publication path the emulator uses, including the
 * two constraints bought with failed attempts (handoff §2.1): a unit is only replayable in
 * the slot its bytes were compiled for, and transaction commit must not stamp the TLB (one
 * jit_aot_flush_tlb for the whole batch afterwards).
 */
/**
 * Overwrite the fixed-width padded LEB placeholders a relocatable unit declares (design §S3).
 * Only values that are properties of the LIVE engine instance are relocated; anything an
 * offline compiler could have known is baked. A unit that declares a relocation the loader has
 * no value for is REFUSED, never patched with a guess.
 */
function applyRelocations(bytes, unit, values) {
    for (const r of unit.relocs ?? []) {
        const v = values[r.kind];
        if (v === undefined) throw new Error(`no value for relocation ${r.kind}`);
        if (r.width !== 5) throw new Error(`relocation width ${r.width} unsupported`);
        let x = v >>> 0;
        for (let i = 0; i < 5; i++) { bytes[r.fileOffset + i] = (x & 0x7f) | (i < 4 ? 0x80 : 0); x >>>= 7; }
    }
    return bytes;
}

function publishUnit(cpu, unit, identity) {
    const w = cpu.wm.exports;
    const table = cpu.wm.wasm_table;
    const mem = cpu.mem8;
    const refuse = (why) => ({ registered: false, why });

    for (const p of unit.pages) {
        if (!Number.isInteger(p.physPage) || p.physPage < 0 || p.physPage > 0xFFFFF) return refuse("bad-physical-page");
        const live = shaPage(mem, p.physPage * PAGE_SIZE);
        if (live !== p.sha) return refuse(`content-mismatch page 0x${p.physPage.toString(16)}: live ${live.slice(0, 16)} != unit ${p.sha.slice(0, 16)}`);
    }
    let fn;
    try {
        const inst = new WebAssembly.Instance(new WebAssembly.Module(unit.bytes), { "e": cpu.jit_imports });
        fn = inst.exports["f"];
        if (typeof fn !== "function") return refuse("no-export-f");
    } catch (e) {
        return refuse(`instantiate: ${String(e).slice(0, 120)}`);
    }
    const required = ["jit_aot_tx_begin", "jit_aot_tx_page_begin", "jit_aot_tx_entry_push",
        "jit_aot_tx_page_finish", "jit_aot_tx_prepare_finish", "jit_aot_tx_commit", "jit_aot_tx_abort"];
    if (!required.every((name) => typeof w[name] === "function")) return refuse("transaction-api-unavailable");
    if (!(unit.tableIndex > 0 && unit.tableIndex < WASM_TABLE_SIZE)) return refuse("bad-table-index");
    let rc = w.jit_aot_tx_begin(unit.tableIndex, unit.pages.length, identity.fingerprint_lo, identity.fingerprint_hi) >>> 0;
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
    return { registered: true, idx: unit.tableIndex, fn, pages: unit.pages.map((p) => p.physPage) };
}

/**
 * Was EVERY published unit still ours at the end, and was each actually entered?
 *
 * A manifest may carry several units. Reading the last one only reported the liveness of one
 * unit while the JIT could have been running the rest — precisely what `aot.registered` exists
 * to catch, so the gate that guards against "the candidate arm silently ran the JIT" has to
 * quantify over all of them.
 */
function aotLiveness(cpu) {
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
            // Function identity, not "the page points at our slot": a freed slot is recycled by
            // the very next compilation, so a slot check credits the AOT unit with a JIT
            // module's work (handoff §3).
            alive: sameFn && ownsPage, sameFn, ownsPage, entries, entered: sameFn && ownsPage && entries > 0,
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
        why: per.filter((u) => !u.registered).map((u) => u.why).join("; ") || undefined,
        per_unit: per,
    };
}

/**
 * Re-derive every relocated value from THIS instance and compare it with what was patched in.
 * A relocation is the one place an offline unit can be silently wrong about the engine, so it
 * is measured rather than assumed — a mismatch invalidates the run instead of producing a
 * plausible number over a unit reading the wrong addresses.
 */
function aotRelocationAudit(cpu) {
    if (!relocApplied) return null;
    const out = { applied: relocApplied, measured: {}, ok: true };
    if (relocApplied.tlb_data !== undefined) {
        const mem = cpu.wm.exports.memory ?? cpu.wm.memory;
        try {
            const r = findTlbDataBase(mem, cpu.mem8.byteOffset, ORACLE_PROBE_PAGES);
            out.measured.tlb_data = r.base;
            out.tlbProbeSupport = r.support;
            if (r.base !== relocApplied.tlb_data) out.ok = false;
        }
        catch (e) { out.measured.tlb_data = null; out.error = String(e.message); out.ok = false; }
    }
    return out;
}

/** Pair captured module bytes with the engine's publication record (aot-cache.snapshot). */
function captureUnit(cpu) {
    const w = cpu.wm.exports;
    const mem = cpu.mem8;
    const out = globalThis["__wasmDump"]?.out ?? [];
    const units = [];
    for (const rec of out) {
        const entryPage = rec.start >>> 12;
        if (entryPage !== (c.codeAddr >>> 12)) continue;    // only the case's kernel page
        const idx = rec.table_index >>> 0;
        if ((w.jit_aot_page_table_index(entryPage * PAGE_SIZE) >>> 0) !== idx) continue;
        const pageCount = w.jit_aot_module_page_count(idx) >>> 0;
        const pages = [];
        for (let p = 0; p < pageCount; p++) {
            const pAddr = w.jit_aot_module_page_at(idx, p) >>> 0;
            if (pAddr === 0xFFFFFFFF) continue;
            const n = w.jit_aot_page_entry_count(pAddr) >>> 0;
            const entries = [];
            for (let e = 0; e < n; e++) {
                const packed = w.jit_aot_page_entry_at(pAddr, e) >>> 0;
                if (packed === 0xFFFFFFFF) continue;
                entries.push([packed >>> 16, packed & 0xFFFF]);
            }
            pages.push({ physPage: pAddr >>> 12, stateFlags: w.jit_aot_page_state_flags(pAddr) >>> 0,
                entries, sha: shaPage(mem, pAddr) });
        }
        if (!pages.length) continue;
        units.push({ entryPage, tableIndex: idx, pages, len: rec.len, bytes: Buffer.from(rec.bytes) });
    }
    return units;
}

function finish(status) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const cpu = emulator.v86.cpu;
    let result = { arm: args.aot ? "unit" : "reference", impl: "v86", case: c.id, status,
        node: process.version, fault: faultApplied };

    if (status === "ok") {
        const ns = (i, j) => Number(marks[j] - marks[i]);
        const t1 = ns(0, 1), t2 = ns(1, 2);
        const nsPerOuter = (t2 - t1) / (n2 - n1);
        result = {
            ...result,
            outer: { warmup, n1, n2 },
            phase_ns: { p1: t1, p2: t2 },
            ns_per_outer: nsPerOuter,
            guest_ins_per_outer: image.insPerOuter,
            guest_mips: image.insPerOuter / nsPerOuter * 1000,
            jit: jitFacts(cpu),
            aot: aotLiveness(cpu),
            aot_relocations: aotRelocationAudit(cpu),
            regions: regions(cpu),
            state: readV86State(cpu),
            paging_on: ((cpu.cr[0] >>> 0) & 0x80000000) !== 0,
            // Read back out of the engine, not copied from the request (applyShape).
            jit_flags: effectiveFlags,
            jit_flag_overrides: Object.fromEntries([...FLAG_OVERRIDES]),
            relaxed_fpu: effectiveRelaxed,
            capture_eip: "0x" + image.captureEip.toString(16),
        };
    }

    if (args.capture && status === "ok") {
        const units = captureUnit(cpu);
        const base = path.resolve(args.capture);
        fs.mkdirSync(path.dirname(base), { recursive: true });
        const index = units.map((u, i) => {
            const file = `${path.basename(base)}.${i}.wasm`;
            fs.writeFileSync(path.join(path.dirname(base), file), u.bytes);
            return { entryPage: u.entryPage, tableIndex: u.tableIndex, pages: u.pages, file, bytes: u.bytes.length };
        });
        // The manifest records the shape THAT PRODUCED THESE BYTES (read back from the engine),
        // because that is what makes it valid or invalid to replay them later (AotVersion F1).
        const identity = aotIdentity(cpu);
        fs.writeFileSync(base + ".json", JSON.stringify({
            case: c.id, jit_identity: identity,
            engine_sha256: identity.engine_sha256, units: index,
        }, null, 2));
        result.capture = { file: base + ".json", units: index.length };
    }

    try { emulator.stop(); } catch { /* already stopped */ }
    console.log(JSON.stringify(result));
    process.exit(status === "ok" ? 0 : 3);
}

emulator.bus.register("cpu-event-halt", () => {
    if (marks.length === 3) finish("ok");
    else finish(`HALT_WITH_${marks.length}_MARKS`);
});

emulator.add_listener("emulator-loaded", () => {
    const cpu = emulator.v86.cpu;
    cpu.reboot_internal();
    cpu.reset_memory();
    cpu.load_multiboot(image.buf.buffer);

    applyShape(cpu.wm.exports);
    if (cpu.jit_clear_cache) cpu.jit_clear_cache();

    if (args.aot) {
        const manifest = JSON.parse(fs.readFileSync(args.aot, "utf8"));
        const dir = path.dirname(path.resolve(args.aot));
        const results = [];
        // Relocation values come from the manifest (measured offline against the SAME engine
        // binary, keyed by its sha256) and are re-derived from this instance at the end of the
        // run — see aotRelocationAudit(). Trusting the manifest without that check would make
        // the whole memory contract depend on an unverified constant.
        const relocValues = manifest.relocations ?? {};
        relocApplied = relocValues;
        const liveIdentity = aotIdentity(cpu);
        // Legacy manifests did not carry this envelope. Do not manufacture values for them:
        // the only safe compatibility mode is refusal, because a missing RAM/AOT ABI check is
        // not evidence that the old bytes can be staged into this engine.
        if (manifest.engine_sha256 !== liveIdentity.engine_sha256
            || !manifestMatchesLiveIdentity(manifest, liveIdentity)) {
            console.error("AOT manifest ABI-5 identity envelope does not match the live engine");
            process.exit(3);
        }
        if (!Array.isArray(manifest.units) || !manifest.units.length
            || !manifest.units.every((u) => Number.isInteger(u.tableIndex)
                && u.tableIndex > 0 && u.tableIndex < WASM_TABLE_SIZE)) {
            console.error("AOT manifest lacks exact valid table slot(s)");
            process.exit(3);
        }
        for (const u of manifest.units) {
            const bytes = applyRelocations(fs.readFileSync(path.join(dir, u.file)), u, relocValues);
            const published = publishUnit(cpu, { ...u, bytes }, liveIdentity);
            aotUnits.push(published);
            results.push(published);
        }
        if (!aotUnits.length || !aotUnits.every((u) => u.registered)) {
            // Refusing to publish is always safe (the page keeps the JIT path) but it makes
            // the run meaningless as a CANDIDATE run — say so instead of measuring the JIT
            // twice and calling the second one AOT.
            console.error(`AOT publication refused: ${JSON.stringify(results)}`);
        }
    }

    cpu.io.register_write(L.PORT, { name: "aot-oracle" }, () => { marks.push(process.hrtime.bigint()); });
    emulator.run();
});
