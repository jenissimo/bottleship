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
//                    [--fault name] [--flags "5=0"] [--relaxed 0] [--one-call] [--mmu scenario]
//
// --fault and --mmu are different things and neither substitutes for the other. `--fault`
// mutates INPUT BYTES (a negative control: does the oracle notice a changed result?).
// `--mmu` changes the PAGE TABLES, so the guest takes a real #PF whose identity — CR2, error
// code, faulting EIP, and which stores had already landed — is what a translator claiming to
// skip per-access permission work has to reproduce.
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
import * as MMU from "../corpus/mmu.mjs";
import { getCase } from "../corpus/cases.mjs";
import { readV86State } from "../lib/state.mjs";
import {
    WASM_TABLE_OFFSET, WASM_TABLE_SIZE, PAGE_SIZE,
    aotIdentity as sharedAotIdentity, applyRelocations, applyShape as sharedApplyShape,
    aotLiveness as sharedAotLiveness, jitIdentity as sharedJitIdentity,
    manifestMatchesLiveIdentity, publishUnit as sharedPublishUnit,
} from "../lib/engine-unit.mjs";
import { parseArgs, parseFlagOverrides, usageExit } from "../lib/args.mjs";
import { findTlbDataBase, ORACLE_PROBE_PAGES } from "../../aot/lib/tlb-base.mjs";
import { SHIPPING_JIT } from "../../jit-config/shipping.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(__dirname, "../../..");

const KNOWN = ["case", "outer", "warmup", "timeout", "aot", "capture", "fault", "flags", "relaxed", "one-call", "mmu"];
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

const oneCall = args["one-call"] === "1";
let mmuPlan = null;
if (args.mmu) {
    const scenario = MMU.getScenario(args.mmu);
    // Fail closed, and do it HERE: applicability depends on AOT_ORACLE_COUNT, which only this
    // process knows. A scenario whose premise the case cannot satisfy would still fault — on a
    // different access than the one it names — and that is a confidently wrong result, which is
    // worse than no result.
    const fit = MMU.applicability(c, scenario);
    if (!fit.applicable) {
        console.log(JSON.stringify({
            arm: "reference", impl: "v86", case: c.id, status: "MMU_SCENARIO_INAPPLICABLE",
            mmu: { scenario: scenario.id, applicable: false, reason: fit.reason },
        }));
        process.exit(4);
    }
    mmuPlan = {
        scenario,
        patches: MMU.resolvePatches(c, scenario),
        touch: MMU.resolveTouch(c, scenario),
        touchAfter: MMU.resolveTouch(c, scenario, "touch_after"),
        touchWriteAfter: MMU.resolveTouch(c, scenario, "touch_write_after"),
    };
}
const image = buildImage(c, { warmup, n1, n2, oneCall, mmu: mmuPlan });
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
/**
 * The shared loader REPORTS; this arm EXITS. Keeping that split here means the browser arm can
 * surface the same failure as a value instead of inheriting a process exit it has no process for.
 */
function orExit(fn) {
    try {
        return fn();
    } catch (e) {
        console.error(String(e.message ?? e));
        process.exit(2);
    }
}

const jitIdentity = (ex) => orExit(() => sharedJitIdentity(ex));
const aotIdentity = (cpu) => orExit(() => sharedAotIdentity(cpu, sha256(fs.readFileSync(wasmPath))));
const publishUnit = (cpu, unit, identity) =>
    sharedPublishUnit(cpu, unit, identity, { pageSha: (page) => shaPage(cpu.mem8, page * PAGE_SIZE) });
const aotLiveness = (cpu) => sharedAotLiveness(cpu, aotUnits);

function applyShape(ex) {
    const got = orExit(() => sharedApplyShape(ex, { flags: JIT_FLAGS, relaxed }));
    effectiveFlags = got.flags;
    effectiveRelaxed = got.relaxed;
    effectiveJitIdentity = got.identity;
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

/**
 * The regions compared for this run. The PTE span is always present when a scenario is active:
 * accessed/dirty bits are guest-visible bytes the walker writes, so they are compared like any
 * other effect instead of being asserted in prose. FAULT/SFAULT carry the #PF identity and the
 * register file as of the faulting instruction.
 */
function comparedRegions() {
    if (!mmuPlan) return c.regions;
    const pte = MMU.pteRegion(c);
    return [
        ...c.regions,
        { name: "FAULT", addr: L.FAULT, len: L.FAULT_LEN, fields: L.FAULT_FIELDS },
        { name: "SFAULT", addr: L.SFAULT, len: L.STATE_LEN, fields: L.STATE_FIELDS },
        ...(pte ? [pte] : []),
    ];
}

/**
 * The scenario's own verdict: what was patched, what the CPU actually did, and how the page
 * tables looked afterwards. `verdict` compares the outcome against what the scenario declared
 * it expects, so a scenario that stops faulting (a patch that no longer lands, a TLB that was
 * never invalidated) reports FAILED rather than quietly passing as a clean run.
 */
function mmuReport(cpu) {
    if (!mmuPlan) return null;
    const rec = readFaultRecord(cpu);
    const expect = mmuPlan.scenario.expect;
    const dv = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.byteLength);
    const ptes = MMU.ptePagesForCase(c).map((page) => ({
        page: "0x" + page.toString(16),
        ...MMU.describePte(dv.getUint32(L.pteAddr(page), true)),
    }));
    const decoded = rec.taken ? MMU.describeErrorCode(rec.error_code) : null;
    const accessOk = !mmuPlan.scenario.expect_access || decoded?.access === mmuPlan.scenario.expect_access;
    const verdict = expect === "fault"
        ? (rec.taken === 1 && accessOk ? "AS_EXPECTED"
            : rec.taken !== 1 ? "FAILED_NO_FAULT" : `FAILED_ACCESS_${decoded?.access}`)
        : (rec.taken === 0 ? "AS_EXPECTED" : "FAILED_UNEXPECTED_FAULT");
    return {
        scenario: mmuPlan.scenario.id,
        why: mmuPlan.scenario.why,
        when: mmuPlan.scenario.when,
        wp: mmuPlan.scenario.wp,
        invalidate: mmuPlan.scenario.invalidate !== false,
        touched: mmuPlan.touch.map((p) => "0x" + p.toString(16)),
        patches: mmuPlan.patches.map((p) => ({
            target: p.target, mode: p.mode, page: "0x" + p.page.toString(16),
            pte_addr: "0x" + p.pte_addr.toString(16), value: "0x" + p.value.toString(16),
        })),
        expect, expect_access: mmuPlan.scenario.expect_access ?? null,
        observed: { ...rec, error: decoded },
        ptes,
        verdict,
    };
}

/** Decode the #PF record the handler spilled. Null when the image has no scenario. */
function readFaultRecord(cpu) {
    if (!mmuPlan) return null;
    const dv = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset + L.FAULT, L.FAULT_LEN);
    const u32 = (off) => dv.getUint32(off, true);
    return {
        cr2: u32(0x00), error_code: u32(0x04), fault_eip: u32(0x08),
        fault_cs: u32(0x0c), taken: u32(0x10),
    };
}

function regions(cpu) {
    // Only the CASE's own regions are checked: FAULT/SFAULT deliberately live inside the
    // scenario span, and comparing them against it would always "collide".
    if (mmuPlan) L.assertNoMmuOverlap(c.regions);
    return comparedRegions().map((r) => {
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
        node: process.version, fault: faultApplied, mmu: mmuReport(cpu) };

    if (status === "ok") {
        const timing = oneCall ? null : (() => {
            const ns = (i, j) => Number(marks[j] - marks[i]);
            const t1 = ns(0, 1), t2 = ns(1, 2);
            const nsPerOuter = (t2 - t1) / (n2 - n1);
            return { t1, t2, nsPerOuter };
        })();
        result = {
            ...result,
            ...(oneCall ? {
                conformance: {
                    mode: "one-call",
                    work: image.oneCallWork,
                    // The P1 k3 slice has exactly one faulting read effect and one store per
                    // body iteration. Other cases deliberately publish no invented ledger.
                    expected_ledger: c.id === "k3" ? {
                        source: "corpus-static-instruction/effect-count",
                        effects: c.iters * 2,
                        accounting: c.iters * c.insPerIter,
                    } : null,
                    // The raw HLT EIP belongs to the driver. This is the only EIP identity a
                    // one-call adapter may compare with an isolated kernel interpreter.
                    logical_continuation: "wrapper-return",
                    capture_eip: image.captureEip,
                },
            } : {
                outer: { warmup, n1, n2 },
                phase_ns: { p1: timing.t1, p2: timing.t2 },
                ns_per_outer: timing.nsPerOuter,
                guest_ins_per_outer: image.insPerOuter,
                guest_mips: image.insPerOuter / timing.nsPerOuter * 1000,
            }),
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
    // A scenario expecting a fault halts inside the #PF handler, so it has passed no phase
    // markers at all. `taken` is what separates that from a driver that halted early for an
    // unrelated reason: an untaken record and a run that never faulted are the same zeros.
    if (mmuPlan?.scenario.expect === "fault") {
        const taken = readFaultRecord(emulator.v86.cpu)?.taken;
        if (taken === 1) return finish("ok");
        return finish(`EXPECTED_FAULT_NOT_TAKEN_MARKS_${marks.length}`);
    }
    if (marks.length === (oneCall ? 0 : 3)) finish("ok");
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
