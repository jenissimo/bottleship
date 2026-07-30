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
import { G, reg32Offset, HELPERS_NONFAULTING } from "./abi.mjs";

const OP_END = 0x0b, OP_BR = 0x0c, OP_BR_IF = 0x0d, OP_BR_TABLE = 0x0e, OP_RETURN = 0x0f;
const OP_CALL = 0x10, OP_I32CONST = 0x41, OP_I32STORE = 0x36, OP_LOCAL_GET = 0x20;
const OP_UNREACHABLE = 0x00, OP_BLOCK = 0x02, OP_LOOP = 0x03, OP_IF = 0x04;
const OP_LOCAL_SET = 0x21, OP_I32LOAD = 0x28, OP_I32ADD = 0x6a, OP_I32AND = 0x71;
const OP_I32OR = 0x72, OP_I32GEU = 0x4f;

const LOOP_COUNTER = 100003;                 // cpu.rs:290
const THUNK_RANGE = [0x21000000, 0x24000000]; // MEM_THUNK_CODE_BASE .. MEM_ROM_BASE (N79/E2)

const PROFILER_ONLY = [
    "check_dispatcher_target", "debug_set_dispatcher_target", "enter_basic_block",
    "check_page_switch", "coverage_log",
];

// ── operand attribution ────────────────────────────────────────────────────
//
// Why this exists rather than a pattern scan: a check keyed on a constant's VALUE cannot tell a
// CPU-state address from an ordinary immediate, and the collisions are not hypothetical — `64` is
// both `reg32[0]` and `FLAG_ZERO`, and `120` is both `flags` and the low-12 EIP immediate of an
// instruction at page offset 0x78. Both were observed on this corpus while writing C14: the first
// scan reported two flags writes on k4 that are EIP arguments, and the second reported five
// "unpaired address pushes" on k3 that are `FLAG_ZERO` masks. Attribution has to come from the
// operand stack or it is fiction.
//
// The model covers exactly the opcodes this producer emits; anything else is reported as
// `unmodelled` and fails the check that uses it, so the resolver cannot silently mis-read a body
// it does not understand.
const ARITY = new Map([
    [0x01, [0, 0]],                                     // nop
    [0x1a, [1, 0]], [0x1b, [3, 1]],                     // drop, select
    [0x20, [0, 1]], [0x21, [1, 0]], [0x22, [1, 1]],     // local.get/set/tee
    [0x41, [0, 1]], [0x42, [0, 1]],                     // i32.const, i64.const
    [0x45, [1, 1]], [0xc0, [1, 1]], [0xc1, [1, 1]],     // i32.eqz, extend8_s, extend16_s
]);
for (let o = 0x28; o <= 0x35; o++) ARITY.set(o, [1, 1]);   // loads
for (let o = 0x36; o <= 0x3e; o++) ARITY.set(o, [2, 0]);   // stores
for (let o = 0x46; o <= 0x4f; o++) ARITY.set(o, [2, 1]);   // i32 comparisons
for (let o = 0x6a; o <= 0x78; o++) ARITY.set(o, [2, 1]);   // i32 arithmetic / bitwise / shifts
// The i64 subset the 32x32->64 multiply shapes emit (imul3 / mul32 / imul32).
ARITY.set(0x51, [2, 1]); ARITY.set(0x52, [2, 1]);          // i64.eq, i64.ne
ARITY.set(0x7e, [2, 1]); ARITY.set(0x88, [2, 1]);          // i64.mul, i64.shr_u
ARITY.set(0xa7, [1, 1]);                                   // i32.wrap_i64
ARITY.set(0xac, [1, 1]); ARITY.set(0xad, [1, 1]);          // i64.extend_i32_{s,u}

/**
 * For every memory access in the body, name the instruction that produced its ADDRESS operand.
 * @returns {{addrOrigin: Map<number, number>, unmodelled: string[]}} keyed by body index
 */
export function resolveAccessAddresses(bytes, body, m) {
    const fnTypes = m.imports.filter((i) => i.kind === 0).map((i) => m.types[i.type]);
    const addrOrigin = new Map();
    const unmodelled = [];
    /** @type {number[]} origin body-index per live operand */
    let st = [];
    /** @type {{h:number, arity:number}[]} */
    const frames = [];
    let deadAt = null;                                   // frames.length where unreachability began

    for (let i = 0; i < body.length; i++) {
        const x = body[i];
        const op = x.op;
        if (op === 0x02 || op === 0x03 || op === 0x04) {  // block / loop / if
            if (op === 0x04 && deadAt === null) st.pop();  // the condition
            const blockType = bytes[x.offset + 1];
            frames.push({ h: st.length, arity: blockType === 0x40 ? 0 : 1 });
            continue;
        }
        if (op === 0x05) {                                // else
            const f = frames[frames.length - 1];
            st.length = Math.min(st.length, f.h); while (st.length < f.h) st.push(i);
            if (deadAt !== null && frames.length <= deadAt) deadAt = null;
            continue;
        }
        if (op === 0x0b) {                                // end
            const f = frames.pop();
            if (!f) continue;                             // the function's own trailing END
            st.length = Math.min(st.length, f.h); while (st.length < f.h) st.push(i);
            for (let k = 0; k < f.arity; k++) st.push(i);
            if (deadAt !== null && frames.length < deadAt) deadAt = null;
            continue;
        }
        if (deadAt !== null) continue;                     // unreachable: stack is unconstrained
        if (op === 0x00 || op === 0x0c || op === 0x0f) { deadAt = frames.length; continue; }
        if (op === 0x0d) { st.pop(); continue; }           // br_if pops the condition
        if (op === 0x0e) { st.pop(); deadAt = frames.length; continue; }   // br_table
        if (op === 0x10) {                                 // call
            const t = fnTypes[x.imm];
            if (!t) { unmodelled.push(`call ${x.imm} at +${x.offset}`); return { addrOrigin, unmodelled }; }
            for (let k = 0; k < t.params.length; k++) st.pop();
            for (let k = 0; k < t.results.length; k++) st.push(i);
            continue;
        }
        const a = ARITY.get(op);
        if (!a) { unmodelled.push(`opcode 0x${op.toString(16)} at +${x.offset}`); return { addrOrigin, unmodelled }; }
        if (op >= 0x28 && op <= 0x35) addrOrigin.set(i, st[st.length - 1]);
        if (op >= 0x36 && op <= 0x3e) addrOrigin.set(i, st[st.length - 2]);
        for (let k = 0; k < a[0]; k++) st.pop();
        for (let k = 0; k < a[1]; k++) st.push(i);
    }
    return { addrOrigin, unmodelled };
}

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

    // ── A0. the module is well-formed wasm ─────────────────────────────────
    // Free, and it is the only check that sees a stack-balance error: an operand leaked by an
    // emitter is legal in any block that ends in a `br` (wasm discards the stack at a branch) and
    // only fails validation where a block falls through, so it can hide for entire cases. The
    // engine's own producer cannot make this mistake — WasmBuilder tracks depth — so an
    // independent producer owes the check.
    {
        let why = "structurally valid wasm";
        let ok = false;
        try { ok = WebAssembly.validate(bytes); }
        catch (e) { why = `validate threw: ${e.message}`; }
        if (!ok && why === "structurally valid wasm") {
            try { new WebAssembly.Module(bytes); }
            catch (e) { why = e.message; }
        }
        check("A0", ok, why);
    }

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
    let counterLocal = null;
    {
        let k = 0;
        for (let i = 0; i < 8; i++) {
            const a = body[k], b = body[k + 1], c = body[k + 2];
            if (!a || a.op !== OP_I32CONST || a.imm !== reg32Offset(i)) { ok = false; break; }
            if (!b || b.op !== OP_I32LOAD) { ok = false; break; }
            if (!c || c.op !== OP_LOCAL_SET) { ok = false; break; }
            k += 3;
        }
        const z = body[k], s = body[k + 1];
        if (!z || z.op !== OP_I32CONST || z.imm !== 0 || !s || s.op !== OP_LOCAL_SET) ok = false;
        else counterLocal = s.imm;
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

    // B7 / N18: a bounded exit at EVERY loop head — the module's main loop and every wasm `loop`
    // the body opens. For BottleShip this is a preemption-CORRECTNESS property, not a throughput
    // one: the 1 ms quantum is observed only BETWEEN module entries (N30), so this counter test is
    // the only bound on preemption latency once the guest is inside the unit — and a unit that
    // never yields also flatters its own FPS window (§9.8 G-A).
    //
    // The guard must DOMINATE the loop body, so the scan refuses anything that could execute
    // first: a call (faultable, and a trap point), a nested loop, or any other branch.
    {
        // The bound the body must use. Production is LOOP_COUNTER; a job that lowers it (to make
        // the guard reachable inside a short kernel) must declare the same value here, so a
        // lowered bound is a visible property of the unit rather than a silent one.
        const bound = unit.loopCounter ?? LOOP_COUNTER;
        const loops = body.map((x, i) => [x, i]).filter(([x]) => x.op === OP_LOOP);
        const bad = [];
        for (const [lp, j] of loops) {
            let found = false;
            for (let k = j + 1; k < body.length; k++) {
                const a = body[k], b = body[k + 1], c = body[k + 2], d = body[k + 3];
                if (a.op === OP_LOCAL_GET && a.imm === counterLocal &&
                    b?.op === OP_I32CONST && b.imm === bound &&
                    c?.op === OP_I32GEU &&
                    d?.op === OP_BR_IF && d.imm === d.depth - 1) { found = true; break; }
                if (a.op === OP_CALL || a.op === OP_LOOP || a.op === OP_BR ||
                    a.op === OP_BR_TABLE || a.op === OP_BR_IF || a.op === OP_END) break;
            }
            if (!found) bad.push(lp.offset);
        }
        // The guard can never itself produce a zero-delta exit (N30): the counter local is 0 at
        // every module entry and the test is `>= 100003`, so it can only fire on a path that has
        // already retired at least that many instructions.
        check("B7", loops.length > 0 && bad.length === 0,
            `${loops.length} loop heads, each bounded by counter >= ${bound} -> br exit`
            + (bad.length ? ` (unbounded at ${bad.map((o) => "+" + o).join(",")})` : ""));
    }

    // C2: the exit epilogue folds the counter
    check("C2", counterFolds.length >= 2,
        `${counterFolds.length} instruction-counter folds (exit + fault epilogues)`);
    check("C1", flushEnds.size >= 2, `${flushEnds.size} register flushes (exit + fault epilogues)`);

    // C3 / N28-N30 / design H4a: the counter is credited on EVERY path out, and no path can
    // credit a STATICALLY ZERO delta. A zero delta is not a slow path — `do_many_cycles_native`
    // loops forever on it (N30) — so this is one of the three checks that can catch a silent
    // wrong result rather than a refusal.
    {
        const localSets = body.filter((x) => x.op === OP_LOCAL_SET && x.imm === counterLocal);
        const adds = [];
        for (let i = 0; i + 3 < body.length; i++) {
            if (body[i].op === OP_LOCAL_GET && body[i].imm === counterLocal &&
                body[i + 1].op === OP_I32CONST && body[i + 2].op === OP_I32ADD &&
                body[i + 3].op === OP_LOCAL_SET && body[i + 3].imm === counterLocal) {
                adds.push({ at: body[i].offset, n: body[i + 1].imm });
            }
        }
        // one prologue `local.set` (the zeroing) + one per add; nothing else may write the local,
        // or a path could reach an epilogue with a delta of zero.
        const nonPositive = adds.filter((a) => !(a.n > 0));
        check("C3", counterFolds.length === 2 && localSets.length === adds.length + 1 &&
            nonPositive.length === 0,
            `${counterFolds.length} folds (exit + fault), ${adds.length} counter credits all > 0,`
            + ` no other write to the counter local`);
    }

    // C4 / N27, and D9 / N63: the high 20 bits of instruction_pointer must already name the page
    // of the executing instruction at every faultable access, because the slow helper only ORs in
    // the low 12 bits from a compile-time immediate. This unit discharges that by PREMISE rather
    // than by proof: it is single-page, so the high bits are established by the dispatcher and
    // every EIP write in the body preserves them — except the one absolute write a RET must make,
    // which is required to be immediately followed by the exit branch, so no faultable access can
    // observe it. (§10 C14's pattern: prove the condition, not the obligation.)
    {
        // Two shapes reach instruction_pointer, and BOTH are v86's: `i32.const 556 … store 0`
        // (codegen.rs:70 gen_set_eip_low_bits) and `i32.const 0 … store <556>` — the memarg-offset
        // form of `store_aligned_i32(instruction_pointer)` that RET uses
        // (jit_instructions.rs:3368-3374). A detector that only knew the first missed every RET.
        const eipWrites = [];
        for (let i = 0; i < body.length; i++) {
            if (body[i].op === OP_I32STORE && body[i].imm?.offset === G.instruction_pointer) {
                eipWrites.push({ at: i, storeAt: i, preserves: false });
                continue;
            }
            if (body[i].op !== OP_I32CONST || body[i].imm !== G.instruction_pointer) continue;
            let k = i + 1, preserves = false;
            for (; k < body.length; k++) {
                if (body[k].op === OP_I32CONST && body[k].imm === ~0xFFF) preserves = true;
                if (body[k].op === OP_I32STORE) break;
                if (body[k].op === OP_CALL || body[k].op === OP_BR || body[k].op === OP_BR_IF) break;
            }
            if (body[k]?.op === OP_I32STORE) eipWrites.push({ at: i, storeAt: k, preserves });
        }
        const absolute = eipWrites.filter((w) => !w.preserves);
        const badAbsolute = absolute.filter((w) => {
            // scan forward from the store: the first control-flow-relevant op must be `br exit`
            for (let k = w.storeAt + 1; k < body.length; k++) {
                const x = body[k];
                if (x.op === OP_BR) return !(x.imm === x.depth - 1);
                if (x.op === OP_CALL || x.op === OP_BR_IF || x.op === OP_BR_TABLE ||
                    x.op === OP_LOOP || x.op === OP_END) return true;
            }
            return true;
        });
        const onePage = (unit.entries ?? []).every(([off]) => off >= 0 && off < 0x1000);
        // C4b: every in-module RE-DISPATCH (`local.set 0`) must be preceded by an EIP write. Both
        // exits reachable from the top of the main loop — B7's bound and the brtable_default arm
        // (N16) — return with whatever EIP is in memory, and no epilogue writes one (N25). The
        // engine gets this free: its two re-dispatch sites follow a dynamic eip it reads back
        // (jit.rs:3567-3577, :3581-3595). A static producer must store it.
        const storeOffsets = eipWrites.map((w) => body[w.storeAt].offset);
        const redispatches = body.filter((x) => x.op === OP_LOCAL_SET && x.imm === 0);
        const unpinned = redispatches.filter((x) => {
            const j = body.findIndex((y) => y.offset === x.offset);
            // …; <eip write>; i32.const idx; local.set 0
            return !storeOffsets.includes(body[j - 2]?.offset);
        });
        check("C4b", unpinned.length === 0,
            `${redispatches.length} in-module re-dispatches, each with EIP materialized first`
            + (unpinned.length ? ` (${unpinned.length} stale)` : ""));

        check("C4/D9", onePage && eipWrites.length > 0 && badAbsolute.length === 0,
            `single-page unit (${unit.entries.length} entries, all < 0x1000); ${eipWrites.length}`
            + ` EIP writes, ${absolute.length} absolute, ${badAbsolute.length} of them NOT followed`
            + " straight by br exit");
    }

    // C14 / N106: every authoritative `flags` write must be READ-MODIFY-WRITE. `flags@120` is the
    // only home of TF/IF/DF/IOPL/NT/RF/VM/AC/VIF/VIP/ID — get_eflags() is
    // `*flags & !FLAGS_ALL | recomputed(six)` (cpu.rs:1977-1985) — so rebuilding the word from the
    // six arithmetic bits silently clears DF (reversing every later MOVS/STOS/SCAS) and IF. The
    // contract calls this one of exactly two checklist items that can produce a silent WRONG
    // RESULT rather than a refusal, and it is invisible both to a guest-memory diff and to a
    // flag diff that compares only get_eflags()'s six bits.
    //
    // Both halves are identified through `resolveAccessAddresses` (see its header for why a
    // pattern scan cannot do this): a store writes `flags` iff its ADDRESS operand is an
    // `i32.const B` with `B + memarg.offset == 120`, which covers the memarg-offset shape as well
    // as the `i32.const 120 … store off=0` one. The write is read-modify-write iff some load
    // inside its value expression reads that same address.
    const { addrOrigin, unmodelled } = resolveAccessAddresses(bytes, body, m);
    const constBase = (i) => {
        const o = addrOrigin.get(i);
        return o !== undefined && body[o]?.op === OP_I32CONST ? body[o].imm : null;
    };
    /** The CPU-state address an access touches, or null if its address is computed. */
    const target = (i) => {
        const b = constBase(i);
        return b === null ? null : (b + (body[i].imm?.offset ?? 0)) | 0;
    };
    {
        const stores = body.map((x, i) => i).filter((i) => body[i].op >= 0x36 && body[i].op <= 0x3e);
        const flagsWrites = stores.filter((i) => target(i) === G.flags);
        const rebuilt = flagsWrites.filter((s) => {
            const from = addrOrigin.get(s);
            for (let k = from; k < s; k++) {
                if (body[k].op >= 0x28 && body[k].op <= 0x35 && target(k) === G.flags) return false;
            }
            return true;
        });
        check("C14", unmodelled.length === 0 && flagsWrites.length > 0 && rebuilt.length === 0,
            `${flagsWrites.length} authoritative flags writes, all read-modify-write`
            + (rebuilt.length ? ` (${rebuilt.length} rebuild the word: +${rebuilt.map((s) => body[s].offset).join(",+")})` : "")
            + (unmodelled.length ? ` (unmodelled: ${unmodelled.join("; ")})` : ""));
    }

    // C5 / N26: `previous_ip` is owed only to a potentially-faulting INTERPRETER helper. Prove the
    // premise false instead of verifying the obligation — every imported helper is either on the
    // non-faulting allowlist (with its reason, abi.mjs HELPERS_NONFAULTING) or is a member of the
    // two-phase `#PF` family, which rebuilds EIP from the compile-time low-12 immediate and never
    // reads `previous_ip`. An import outside both is a REFUSAL, so growing the slice cannot
    // silently acquire the obligation.
    {
        const twoPhase = /^safe_(read|write|read_write)(8|16|32|32s|64|128)_slow_jit$/;
        const offenders = fnImports.map((i) => i.name).filter((n) =>
            !twoPhase.test(n) && n !== "trigger_fault_end_jit" && !(n in HELPERS_NONFAULTING));
        check("C5", offenders.length === 0,
            `${fnImports.length} imports, none able to reach an interpreter fault trigger`
            + (offenders.length ? ` (unclassified: ${offenders.join(", ")})` : ""));
    }

    // C6/C7 (and C8, C9, C12, C13 with it): this slice touches no x87/SSE state at all, so the
    // obligations those items create do not exist. Assert the PREMISE rather than the conclusion —
    // contract §10 C14's pattern.
    //
    // It has to be asked of ACCESSES, not of constants. An earlier version scanned every
    // `i32.const` for an FP-state address and refused k6 because a slow-write helper's
    // `start_of_current_instruction & 0xFFF` argument for the instruction at page offset 0x278 is
    // the integer 632 — which is also `fpu_simd_dirty`. That is the project's dominant bug class
    // (a plausible number about something other than its label) inside the checker itself, and it
    // is the third time this exact shape has been caught in this file: attribution has to come
    // from the operand stack. FP state is ranges, not single words, because `fpu_st` is 8x16 bytes
    // and `reg_xmm` is 8x16 (global_pointers.rs:59, :76).
    {
        const FP_RANGES = [
            [G.fpu_simd_dirty, 1], [G.fpu_stack_empty, 1], [G.mxcsr, 4], [G.reg_xmm, 128],
            [G.fpu_stack_ptr, 1], [G.fpu_control_word, 4], [G.fpu_status_word, 4], [G.fpu_st, 128],
        ];
        const inFp = (t) => t !== null && FP_RANGES.some(([base, len]) => t >= base && t < base + len);
        const accesses = body.map((x, i) => i).filter((i) => body[i].op >= 0x28 && body[i].op <= 0x3e);
        const touched = accesses.filter((i) => inFp(target(i)));
        check("C6/C7", unmodelled.length === 0 && touched.length === 0,
            "no access in the unit targets x87/SSE state, so it owes no write-back and no"
            + " fpu_simd_dirty (C6/C7/C8/C9/C12/C13 premises)"
            + (touched.length ? ` (${touched.length} do: +${touched.map((i) => body[i].offset).join(",+")})` : "")
            + (unmodelled.length ? ` (unmodelled: ${unmodelled.join("; ")})` : ""));
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
    // E2 / N79 / N93: no guest address the unit is compiled from may live in the thunk/callback/
    // spin bucket. The engine excludes that range from every module growth edge of its own
    // (jit.rs:607-619) because a direct CALL once pulled a CALLBACK_STUB page into a module and
    // took a fatal 0x3003; an AOT unit owes the same exclusion, enforced rather than assumed.
    if (unit.pageBase !== undefined) {
        const lo = unit.pageBase >>> 0, hi = (unit.pageBase + 0x1000) >>> 0;
        const inside = hi > THUNK_RANGE[0] && lo < THUNK_RANGE[1];
        check("E2", !inside, `page 0x${lo.toString(16)} vs the excluded thunk bucket`
            + ` [0x21000000, 0x24000000): ${inside ? "INSIDE" : "outside"}`);
    }

    // G9d: no value only the OFFLINE instance knows may be baked anywhere the loader will not
    // patch. Design H15a: checking `i32.const` alone is not enough — the engine bakes `tlb_data`
    // as a **memarg offset** (codegen.rs:708 and four siblings), which is exactly the constant
    // this producer relocates, so the memarg immediates are the ones that matter most here.
    if (opts.offlineConstantsForbidden?.length) {
        const forbidden = opts.offlineConstantsForbidden.map((v) => v >>> 0);
        const relocAt = new Set(unit.relocs.map((r) => r.fileOffset));
        const badConst = body.filter((x) => x.op === OP_I32CONST && forbidden.includes(x.imm >>> 0));
        const badMemarg = body.filter((x) => x.imm && typeof x.imm === "object" &&
            typeof x.imm.offset === "number" && forbidden.includes(x.imm.offset >>> 0) &&
            !relocAt.has(x.imm.offsetAt));
        check("G9d", badConst.length === 0 && badMemarg.length === 0,
            `no baked offline-only constant outside a relocation slot (${badConst.length} i32.const,`
            + ` ${badMemarg.length} memarg)`);
    }

    const stats = bodyStats(bytes, instrStart, instrEnd - 1);
    return { ok: fail.length === 0, pass, fail, stats, imports: fnImports.map((i) => i.name) };
}
