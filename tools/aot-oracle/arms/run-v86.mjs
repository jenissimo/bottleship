#!/usr/bin/env node
// aot-oracle ARM — v86-hosted. Two roles, one script, because they must be identical in
// every respect except the one under test:
//
//   reference : "what our JIT does today" — the fork booted headless with BottleShip's
//               production codegen configuration, relaxed FPU, paging on.
//   unit      : the same thing with a CANDIDATE AOT MODULE published for the case's code
//               pages before the guest runs (jit_register_aot_module + one jit_aot_flush_tlb,
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
import { findTlbDataBase, ORACLE_PROBE_PAGES } from "../../aot/lib/tlb-base.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const WASM_TABLE_OFFSET = 1024;   // vendor/v86/src/const.js
const PAGE_SIZE = 4096;

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { args[a.slice(2)] = next; i++; }
    else args[a.slice(2)] = "1";
}

const c = getCase(args.case || "k1");
const n1 = Number(args.outer || 20000);
const warmup = Number(args.warmup || 4000);
const n2 = n1 * 2;
const timeoutMs = Number(args.timeout || 600000);
if (n1 < 1 || warmup < 1) { console.error("--outer/--warmup must be >= 1"); process.exit(2); }

// BottleShip production codegen configuration (preemption-manager.ts defaults). `--flags
// "10=0,5=0"` overrides individual entries; `--relaxed 0` switches x87 to strict F80. These
// values are part of the unit's version tuple — a unit compiled under one shape is not valid
// under another (aot-cache.ts SHAPE_FLAGS).
const JIT_FLAGS = new Map([
    [5, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1], [18, 1], [19, 0], [21, 0], [15, 300000],
]);
for (const pair of (args.flags || "").split(",").filter(Boolean)) {
    const [i, v] = pair.split("=").map(Number);
    if (!Number.isFinite(i) || !Number.isFinite(v)) { console.error(`bad --flags ${pair}`); process.exit(2); }
    JIT_FLAGS.set(i, v);
}
const relaxed = args.relaxed === undefined ? 1 : Number(args.relaxed);

const libv86Path = path.join(REPO, "vendor/v86/build/libv86.mjs");
const wasmPath = path.join(REPO, "vendor/v86/build/v86.wasm");
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

let aot = null;          // what we published, for liveness at the end
let relocApplied = null; // relocation values taken from the manifest, audited at the end
const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const shaPage = (mem, addr) => sha256(Buffer.from(mem.subarray(addr, addr + PAGE_SIZE)));

function jitFacts(cpu) {
    const ex = cpu.wm.exports;
    const out = { pages: [], tier2Promotions: null, tier2Pages: null, fastmemLoadsCompiled: null };
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
        out.fastmemLoadsCompiled = ex.fastmem_get_speculated_loads_compiled
            ? ex.fastmem_get_speculated_loads_compiled() : null;
        out.fastmemGeneration = ex.fastmem_get_generation ? ex.fastmem_get_generation() : null;
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
 * the slot its bytes were compiled for, and registration must not stamp the TLB (one
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

function publishUnit(cpu, unit) {
    const w = cpu.wm.exports;
    const table = cpu.wm.wasm_table;
    const mem = cpu.mem8;
    const refuse = (why) => ({ registered: false, why });

    for (const p of unit.pages) {
        const live = shaPage(mem, p.physPage * PAGE_SIZE);
        if (live !== p.sha) return refuse(`content-mismatch page 0x${p.physPage.toString(16)}: live ${live.slice(0, 16)} != unit ${p.sha.slice(0, 16)}`);
    }
    // A unit whose body bakes a wasm table index is only replayable in that ONE slot: drain the
    // free list down to it and hand the rest back (aot-cache.reserveTableIndex). A unit that
    // names no slot (tableIndex null — see plan/aot-module-contract.md §9.1 / E1) has no such
    // constraint and takes whatever the engine hands out.
    const spare = [];
    let idx = -1;
    const wantAny = unit.tableIndex === null || unit.tableIndex === undefined;
    for (;;) {
        const i = w.jit_aot_alloc_table_index() >>> 0;
        if (i === 0xFFFF) break;
        if (wantAny || i === unit.tableIndex) { idx = i; break; }
        spare.push(i);
    }
    const giveBack = () => { for (const i of spare) w.jit_aot_free_table_index(i); };
    if (idx < 0 || (!wantAny && idx !== unit.tableIndex)) { giveBack(); return refuse("slot-unavailable"); }

    let fn;
    try {
        const inst = new WebAssembly.Instance(new WebAssembly.Module(unit.bytes), { "e": cpu.jit_imports });
        fn = inst.exports["f"];
        if (typeof fn !== "function") { w.jit_aot_free_table_index(idx); giveBack(); return refuse("no-export-f"); }
        table.set(idx + WASM_TABLE_OFFSET, fn);
    } catch (e) {
        w.jit_aot_free_table_index(idx); giveBack();
        return refuse(`instantiate: ${String(e).slice(0, 120)}`);
    }
    // Check-then-act: half-published units cannot be unwound safely (aot-cache.ts).
    for (const p of unit.pages) {
        if ((w.jit_aot_page_table_index(p.physPage * PAGE_SIZE) >>> 0) !== 0xFFFF) {
            table.set(idx + WASM_TABLE_OFFSET, null); w.jit_aot_free_table_index(idx); giveBack();
            return refuse(`page-taken 0x${p.physPage.toString(16)}`);
        }
    }
    let rc = 0;
    for (const p of unit.pages) {
        w.jit_aot_entry_reset();
        for (const [off, st] of p.entries) w.jit_aot_entry_push(off, st);
        rc = w.jit_register_aot_module(idx, p.physPage * PAGE_SIZE, p.stateFlags) >>> 0;
        if (rc !== 0) break;
    }
    giveBack();
    if (rc !== 0) {
        table.set(idx + WASM_TABLE_OFFSET, null); w.jit_aot_free_table_index(idx);
        return refuse(`register-rc-${rc}`);
    }
    w.jit_aot_flush_tlb();
    return { registered: true, idx, fn, pages: unit.pages.map((p) => p.physPage) };
}

/** Was the published unit still ours at the end, and was it actually entered? */
function aotLiveness(cpu) {
    if (!aot) return null;
    if (!aot.registered) return { registered: false, why: aot.why };
    const w = cpu.wm.exports;
    const table = cpu.wm.wasm_table;
    const sameFn = table.get(aot.idx + WASM_TABLE_OFFSET) === aot.fn;
    const ownsPage = aot.pages.some((p) => (w.jit_aot_page_table_index(p * PAGE_SIZE) >>> 0) === aot.idx);
    const entries = w.jit_get_module_entry_total ? w.jit_get_module_entry_total(aot.idx) >>> 0 : null;
    return {
        registered: true, idx: aot.idx, pages: aot.pages.map((p) => "0x" + p.toString(16)),
        // Function identity, not "the page points at our slot": a freed slot is recycled by
        // the very next compilation, so a slot check credits the AOT unit with a JIT
        // module's work (handoff §3).
        alive: sameFn && ownsPage, sameFn, ownsPage, entries, entered: sameFn && ownsPage && entries > 0,
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
            if (!entries.length) continue;
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
            jit_flags: Object.fromEntries([...JIT_FLAGS]),
            relaxed_fpu: cpu.wm.exports.get_relaxed_fpu ? cpu.wm.exports.get_relaxed_fpu() : null,
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
        fs.writeFileSync(base + ".json", JSON.stringify({
            case: c.id, jit_flags: Object.fromEntries([...JIT_FLAGS]), relaxed_fpu: relaxed,
            engine_sha256: sha256(fs.readFileSync(wasmPath)), units: index,
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

    const ex = cpu.wm.exports;
    if (!ex.set_jit_config || !ex.set_relaxed_fpu) {
        console.error("engine lacks set_jit_config/set_relaxed_fpu — not the BottleShip fork?");
        process.exit(2);
    }
    for (const [i, v] of JIT_FLAGS) ex.set_jit_config(i, v);
    ex.set_relaxed_fpu(relaxed);
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
        if (manifest.engine_sha256) {
            const liveSha = sha256(fs.readFileSync(wasmPath));
            if (liveSha !== manifest.engine_sha256) {
                console.error(`AOT manifest engine sha ${manifest.engine_sha256.slice(0, 16)} != live ${liveSha.slice(0, 16)}`);
                process.exit(3);
            }
        }
        // AotVersion F1: the shape flags a unit was built under are part of its validity. Only
        // idx 5 changes THIS producer's output (dead-flag elision), but a silent mismatch on
        // any of them would mean the arms are not the experiment that was designed.
        for (const [k, v] of Object.entries(manifest.jit_flags ?? {})) {
            if (JIT_FLAGS.get(Number(k)) !== v) {
                console.error(`AOT manifest jit_flags[${k}]=${v} != live ${JIT_FLAGS.get(Number(k))}`);
                process.exit(3);
            }
        }
        if (manifest.relaxed_fpu !== undefined && manifest.relaxed_fpu !== relaxed) {
            console.error(`AOT manifest relaxed_fpu=${manifest.relaxed_fpu} != live ${relaxed}`);
            process.exit(3);
        }
        for (const u of manifest.units) {
            const bytes = applyRelocations(fs.readFileSync(path.join(dir, u.file)), u, relocValues);
            aot = publishUnit(cpu, { ...u, bytes });
            results.push(aot);
        }
        if (!aot || !aot.registered) {
            // Refusing to publish is always safe (the page keeps the JIT path) but it makes
            // the run meaningless as a CANDIDATE run — say so instead of measuring the JIT
            // twice and calling the second one AOT.
            console.error(`AOT publication refused: ${JSON.stringify(results)}`);
        }
    }

    cpu.io.register_write(L.PORT, { name: "aot-oracle" }, () => { marks.push(process.hrtime.bigint()); });
    emulator.run();
});
