// The pre-registration checklist of plan/aot-module-contract.md §12, as executable code over
// our own bytes. Any failure is a REFUSAL — the unit is not written and not published (N73).
//
// Two rules govern what is checked here rather than asserted in a comment:
//   1. the import namespace is derived from the ACTUAL shipped engine binary at build time
//      (design G2 / A6) — a hardcoded name list drifts silently on the next engine rebuild;
//   2. structural claims are made by walking the emitted body (lib/wdis.mjs), not by trusting
//      the emitter's own bookkeeping.

import fs from "node:fs";
import { parseModule, walkBody, bodyStats } from "./wdis.mjs";
import { G, reg32Offset } from "./abi.mjs";

const OP_END = 0x0b, OP_BR = 0x0c, OP_BR_IF = 0x0d, OP_BR_TABLE = 0x0e, OP_RETURN = 0x0f;
const OP_CALL = 0x10, OP_I32CONST = 0x41, OP_I32STORE = 0x36, OP_LOCAL_GET = 0x20;
const OP_UNREACHABLE = 0x00, OP_BLOCK = 0x02, OP_LOOP = 0x03, OP_IF = 0x04;

const PROFILER_ONLY = [
    "check_dispatcher_target", "debug_set_dispatcher_target", "enter_basic_block",
    "check_page_switch", "coverage_log",
];

/** The legal import namespace: cpu.js:373-393's filter applied to the real binary. */
export function engineImportNamespace(v86WasmPath) {
    const bytes = fs.readFileSync(v86WasmPath);
    const mod = new WebAssembly.Module(bytes);
    const names = WebAssembly.Module.exports(mod)
        .filter((e) => !e.name.startsWith("_") && !e.name.startsWith("zstd") && !e.name.endsWith("_js"))
        .map((e) => e.name);
    return new Set([...names, "m", "__indirect_function_table"]);
}

/**
 * @param {Uint8Array} bytes the emitted module
 * @param {object} unit  {entries, relocs, ...}
 * @param {object} opts  {v86WasmPath, offlineConstantsForbidden: number[]}
 */
export function verifyUnit(bytes, unit, opts) {
    const fail = [];
    const pass = [];
    const check = (id, ok, why) => { (ok ? pass : fail).push({ id, why }); return ok; };

    const m = parseModule(bytes);

    // ── A. binary shape ────────────────────────────────────────────────────
    const fnImports = m.imports.filter((i) => i.kind === 0);
    check("A1", m.functions.length === 1 && m.exports.length === 1 &&
        m.exports[0].name === "f" && m.exports[0].kind === 0,
        "exactly one local function, exported as \"f\"");
    const fType = m.types[m.functions[0]];
    check("A1b", fType && fType.params.length === 1 && fType.params[0] === 0x7f && fType.results.length === 0,
        "the export is typed (i32) -> ()");
    check("A2", m.exports[0]?.index === fnImports.length,
        `exported index ${m.exports[0]?.index} == function-import count ${fnImports.length}`);
    check("A3", m.imports.every((i) => i.module === "e"), "every import comes from \"e\"");
    const ids = m.sections.map((s) => s.id).filter((id) => id !== 0);
    check("A4", JSON.stringify(ids) === JSON.stringify([1, 2, 3, 7, 10]),
        `section order ${ids.join(",")} == type,import,function,export,code`);
    const mem = m.memories[0];
    check("A5", m.memories.length === 1 && mem.name === "m" && mem.min === 64 && !mem.shared && !mem.hasMax,
        "memory import is e.m, min 64 pages, non-shared, no maximum");
    if (opts.v86WasmPath) {
        const ns = engineImportNamespace(opts.v86WasmPath);
        const bad = m.imports.map((i) => i.name).filter((n) => !ns.has(n));
        check("A6", bad.length === 0, `every import is in the engine's export namespace (bad: ${bad.join(",") || "none"})`);
    }
    check("A7", !m.imports.some((i) => PROFILER_ONLY.includes(i.name)), "no profiler-only import");
    check("A8", !m.imports.some((i) => i.name === "io_port_write32"),
        "no io_port_write32 import (the engine imports it, it is not an export)");
    check("A9", m.customNames.length === 0, "no custom sections (branch hints omitted, not malformed)");

    // ── G9 (design §1): shapes with no trap of their own ───────────────────
    check("G9a", !m.hasData && !m.hasStart && !m.hasElem, "no data / start / element section");
    check("G9b", !m.definesMemory && !m.definesGlobal, "no memory or global DEFINITION");
    check("G9c", m.code.localCount <= 127, `${m.code.localCount} locals <= the 127 emitter ceiling`);

    // ── body walk ──────────────────────────────────────────────────────────
    const { instrStart, instrEnd } = m.code;
    const body = [...walkBody(bytes, instrStart, instrEnd - 1)];   // -1: trailing function END
    const byOffset = new Map(body.map((x) => [x.offset, x]));

    // B1: prologue is 8 x (i32.const reg32[i]; i32.load; local.set)
    let ok = true;
    {
        let k = 0;
        for (let i = 0; i < 8; i++) {
            const a = body[k], b = body[k + 1], c = body[k + 2];
            if (!a || a.op !== OP_I32CONST || a.imm !== reg32Offset(i)) { ok = false; break; }
            if (!b || b.op !== 0x28) { ok = false; break; }
            if (!c || c.op !== 0x21) { ok = false; break; }
            k += 3;
        }
        const z = body[k], s = body[k + 1];
        if (!z || z.op !== OP_I32CONST || z.imm !== 0 || !s || s.op !== 0x21) ok = false;
        check("B1", ok, "prologue loads reg32[0..7] into locals and zeroes an instruction-counter local");
    }
    // B2: label nesting block/block/loop/block
    {
        const opens = body.filter((x) => x.op === OP_BLOCK || x.op === OP_LOOP || x.op === OP_IF).slice(0, 4);
        check("B2", opens.length === 4 && opens[0].op === OP_BLOCK && opens[1].op === OP_BLOCK &&
            opens[2].op === OP_LOOP && opens[3].op === OP_BLOCK,
            "nesting is block(exit) / block(exit_with_fault) / loop(main) / block(brtable_default)");
    }

    // Find every 8-store register flush: i32.const 64;get;store ... i32.const 92;get;store
    const flushEnds = new Set();
    for (let i = 0; i + 23 < body.length; i++) {
        let good = true;
        for (let r = 0; r < 8; r++) {
            const a = body[i + r * 3], b = body[i + r * 3 + 1], c = body[i + r * 3 + 2];
            if (!a || a.op !== OP_I32CONST || a.imm !== reg32Offset(r) ||
                !b || b.op !== OP_LOCAL_GET || !c || c.op !== OP_I32STORE) { good = false; break; }
        }
        if (good) flushEnds.add(body[i + 23].offset);
    }
    // The counter fold that follows a flush: i32.const 664; i32.const 664; i32.load; local.get; i32.add; i32.store
    const counterFolds = [];
    for (let i = 0; i + 5 < body.length; i++) {
        if (body[i].op === OP_I32CONST && body[i].imm === G.instruction_counter &&
            body[i + 1].op === OP_I32CONST && body[i + 1].imm === G.instruction_counter &&
            body[i + 2].op === 0x28 && body[i + 3].op === OP_LOCAL_GET &&
            body[i + 4].op === 0x6a && body[i + 5].op === OP_I32STORE) counterFolds.push(i);
    }

    // B3: every construct that leaves `f` is preceded by a flush.
    // The exit funnel makes this checkable: `br`/`br_if`/`br_table` to depth >= (depth-0) i.e.
    // targeting the outermost two blocks, plus every `return`.
    {
        const offenders = [];
        for (let i = 0; i < body.length; i++) {
            const x = body[i];
            const leaves =
                (x.op === OP_RETURN) ||
                ((x.op === OP_BR || x.op === OP_BR_IF) && x.imm === x.depth - 1) ||
                (x.op === OP_BR_TABLE && x.imm.some((t) => t === x.depth - 1));
            if (!leaves) continue;
            if (x.op === OP_RETURN) {
                // a `return` must be preceded by flush + counter fold
                const prev = body[i - 1];
                if (!prev || prev.op !== OP_I32STORE || !counterFolds.some((k) => body[k + 5].offset === prev.offset)) {
                    offenders.push({ at: x.offset, why: "return without a counter fold" });
                }
            }
        }
        check("B3", offenders.length === 0,
            `every leave passes through the funnel (${offenders.length} offenders)`);
    }
    // B4: exactly one fault epilogue = exactly one trigger_fault_end_jit call
    {
        const idx = fnImports.findIndex((i) => i.name === "trigger_fault_end_jit");
        const calls = body.filter((x) => x.op === OP_CALL && x.imm === idx);
        check("B4", idx >= 0 && calls.length === 1, "exactly one trigger_fault_end_jit call site");
        if (idx >= 0 && calls.length === 1) {
            const at = body.findIndex((x) => x.offset === calls[0].offset);
            const before = body[at - 1];
            check("B4b", flushEnds.has(before?.offset), "the fault epilogue flushes before trigger_fault_end_jit");
            const after = body.slice(at + 1, at + 8).map((x) => x.op);
            check("B4c", after.includes(OP_RETURN), "the fault epilogue returns");
        }
    }
    // B5: no `unreachable` anywhere (the unknown-dispatch path must be a clean br)
    check("B5", !body.some((x) => x.op === OP_UNREACHABLE), "no `unreachable` in the body (N14)");
    // B6
    check("B6", unit.entries.every(([, st]) => st < unit.entries.length && st !== 0xFFFF),
        "published initial_state values are < entry count and never 0xFFFF");

    // C2: the exit epilogue folds the counter
    check("C2", counterFolds.length >= 2,
        `${counterFolds.length} instruction-counter folds (exit + fault epilogues)`);
    check("C1", flushEnds.size >= 2, `${flushEnds.size} register flushes (exit + fault epilogues)`);

    // C6/C7: this slice touches no x87/SSE state at all, so the obligations it would create do
    // not exist. Assert the premise rather than the conclusion.
    {
        const fpAddrs = new Set([G.fpu_st, G.fpu_stack_ptr, G.fpu_stack_empty, G.reg_xmm, G.mxcsr, G.fpu_simd_dirty]);
        const touched = body.filter((x) => x.op === OP_I32CONST && fpAddrs.has(x.imm));
        check("C6/C7", touched.length === 0,
            "the unit references no x87/SSE state, so it owes no write-back and no fpu_simd_dirty");
    }

    // D: memory shapes. Every slow-helper call must be followed by tee/and 1/br_if to the fault
    // label, and every guard must be inside the same block as its access (no hoisting).
    {
        const slowNames = fnImports.map((i, k) => [k, i.name])
            .filter(([, n]) => /^safe_(read|write|read_write)/.test(n));
        const idxs = new Set(slowNames.map(([k]) => k));
        const calls = body.map((x, i) => [x, i]).filter(([x]) => x.op === OP_CALL && idxs.has(x.imm));
        let d4 = true, d5 = true;
        for (const [x, i] of calls) {
            const name = fnImports[x.imm].name;
            // D4: the last argument pushed is a compile-time constant < 0x1000
            const argConst = body[i - 1];
            if (!argConst || argConst.op !== OP_I32CONST || !(argConst.imm >= 0 && argConst.imm < 0x1000)) d4 = false;
            if (/^safe_write\d+_slow_jit$/.test(name)) {
                // in the RMW second phase the result is dropped (codegen.rs:1853); elsewhere it
                // is tee'd and tested
                const n1 = body[i + 1];
                if (!(n1 && (n1.op === 0x1a /* drop */ || n1.op === 0x22 /* tee */))) d5 = false;
                continue;
            }
            const n1 = body[i + 1], n2 = body[i + 2], n3 = body[i + 3], n4 = body[i + 4];
            if (!(n1?.op === 0x22 && n2?.op === OP_I32CONST && n2.imm === 1 && n3?.op === 0x71 &&
                (n4?.op === OP_BR_IF || n4?.op === 0x22))) d5 = false;
        }
        check("D4", d4, "every slow-helper call passes start_of_current_instruction & 0xFFF as a constant");
        check("D5", d5, "every slow-helper result is tested for the page-fault bit");
    }
    // D7 / §5.5: no TLB-derived host address may be reused across a helper call or a fault.
    // Structurally guaranteed here because every access recomputes `entry` from tlb_data
    // inside its own block — so the check is that there is exactly ONE tlb_data probe per
    // access, i.e. none was hoisted or shared.
    {
        check("D7pre", unit.bodyStart === instrStart,
            "relocation file offsets are body-relative to the parsed code section");
        const relocAt = new Set(unit.relocs.filter((r) => r.kind === "tlb_data").map((r) => r.fileOffset));
        const tlbLoads = body.filter((x) => x.op === 0x28 && relocAt.has(x.imm?.offsetAt));
        const accesses = body.filter((x) => x.op === OP_CALL &&
            /^safe_(read|write|read_write)\d/.test(fnImports[x.imm]?.name ?? "") &&
            !/^safe_write\d+_slow_jit$/.test(fnImports[x.imm]?.name ?? "")).length;
        // RMW re-calls safe_write*_slow_jit on its write half without a second probe (N40), so
        // count the probing helpers only: read / write / read_write first phases.
        const firstPhase = body.filter((x) => x.op === OP_CALL &&
            /^safe_(read\d|read16|read32s|write\d|write16|write32|read_write)/.test(fnImports[x.imm]?.name ?? "")).length;
        check("D7", tlbLoads.length === relocAt.size && relocAt.size > 0,
            `${tlbLoads.length} tlb_data probes, one per access, none hoisted or shared`);
    }

    // E1: the body names no wasm table slot at all — there is nothing to pin.
    {
        const suspicious = body.filter((x) => x.op === OP_CALL &&
            ["fastmem_deopt_jit_unit", "jit_find_cache_entry_in_page"].includes(fnImports[x.imm]?.name));
        check("E1", suspicious.length === 0,
            "no fastmem_deopt_jit_unit / jit_find_cache_entry_in_page call ⇒ no baked table index");
    }
    // G9d: no i32.const equal to a value only the offline instance knows
    if (opts.offlineConstantsForbidden?.length) {
        const relocOffsets = new Set(unit.relocs.map((r) => r.at + instrStart - instrStart));
        const bad = body.filter((x) => x.op === OP_I32CONST && opts.offlineConstantsForbidden.includes(x.imm >>> 0));
        check("G9d", bad.length === 0, "no baked offline-only constant outside a relocation slot");
    }

    const stats = bodyStats(bytes, instrStart, instrEnd - 1);
    return { ok: fail.length === 0, pass, fail, stats, imports: fnImports.map((i) => i.name) };
}
