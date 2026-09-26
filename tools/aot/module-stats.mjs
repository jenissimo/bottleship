#!/usr/bin/env node
// Size and shape of a wasm module body — the instrument that says what a producer (or a pass)
// actually emitted, and what it removed.
//
//   node tools/aot/module-stats.mjs units/k4.0.wasm jobs/k4.jit.wasm
//   node tools/aot/module-stats.mjs --json units/k4.0.wasm
//   node tools/aot/module-stats.mjs --state jobs/k1.jit.wasm     # per-address CPU-state r/w
//
// SELF-CHECKING BY CONSTRUCTION, because the failure mode of a histogram is to report a
// plausible number for a body it mis-decoded (project memory: "instruments that cannot fail
// loudly"). Six assertions, any of which is a hard error rather than a footnote:
//
//   1. the last instruction decoded starts at exactly `instrEnd - 1` — a byte-exact identity over
//      the whole body, so a mis-sized immediate desynchronises and is caught instead of averaged;
//   2. the last byte is the function's `end` (0x0b);
//   3. block depth is balanced: only the function's own `end` may take it below 0;
//   4. every opcode is in the known table. An unknown opcode is a decode hole, and a decode
//      hole silently mis-attributes every byte after it.
//   5. the modelled operand stack never pops below its block frame's entry height outside
//      stack-polymorphic (unreachable) code;
//   6. at every `else`/`end` (and the function's own `end`) the depth equals the frame's result
//      arity. 5 and 6 are what make the memory split trustworthy: the split reads each access's
//      address from a stack slot, and a wrong stack effect would read it from the wrong one.
//
// "Plumbing" is const + local traffic: the memory-convention ABI made explicit. It is reported
// because it is the number that does NOT move between backends (design §0.1 F-a measured
// 52.4 % for v86's JIT, 53.2 % for this producer, 52.5 % for an LLVM route), so a pass claiming
// to remove plumbing has to move it here to be believed.

import fs from "node:fs";
import path from "node:path";
import { parseModule, walkBody, uleb } from "./lib/wdis.mjs";
import { G, STATE_BLOCK, GLOBAL_BASE } from "./lib/abi.mjs";

// name, group, pops, pushes. Groups: plumb (const/local), mem (linear memory), alu, ctrl, call,
// misc. Pops/pushes are the operand-stack effect; null = derived from the type section (calls);
// block/loop/if/else/end/br/br_table/return/unreachable are handled by the control model.
const OPS = new Map(Object.entries({
    0x00: ["unreachable", "ctrl", 0, 0], 0x01: ["nop", "misc", 0, 0], 0x02: ["block", "ctrl", 0, 0],
    0x03: ["loop", "ctrl", 0, 0], 0x04: ["if", "ctrl", 1, 0], 0x05: ["else", "ctrl", 0, 0], 0x0b: ["end", "ctrl", 0, 0],
    0x0c: ["br", "ctrl", 0, 0], 0x0d: ["br_if", "ctrl", 1, 0], 0x0e: ["br_table", "ctrl", 1, 0],
    0x0f: ["return", "ctrl", 0, 0], 0x10: ["call", "call", null, null], 0x11: ["call_indirect", "call", null, null],
    0x12: ["return_call", "call", null, null], 0x13: ["return_call_indirect", "call", null, null],
    0x1a: ["drop", "plumb", 1, 0], 0x1b: ["select", "alu", 3, 1],
    0x20: ["local.get", "plumb", 0, 1], 0x21: ["local.set", "plumb", 1, 0], 0x22: ["local.tee", "plumb", 1, 1],
    0x23: ["global.get", "plumb", 0, 1], 0x24: ["global.set", "plumb", 1, 0],
    0x28: ["i32.load", "mem", 1, 1], 0x29: ["i64.load", "mem", 1, 1], 0x2a: ["f32.load", "mem", 1, 1],
    0x2b: ["f64.load", "mem", 1, 1], 0x2c: ["i32.load8_s", "mem", 1, 1], 0x2d: ["i32.load8_u", "mem", 1, 1],
    0x2e: ["i32.load16_s", "mem", 1, 1], 0x2f: ["i32.load16_u", "mem", 1, 1],
    0x30: ["i64.load8_s", "mem", 1, 1], 0x31: ["i64.load8_u", "mem", 1, 1], 0x32: ["i64.load16_s", "mem", 1, 1],
    0x33: ["i64.load16_u", "mem", 1, 1], 0x34: ["i64.load32_s", "mem", 1, 1], 0x35: ["i64.load32_u", "mem", 1, 1],
    0x36: ["i32.store", "mem", 2, 0], 0x37: ["i64.store", "mem", 2, 0], 0x38: ["f32.store", "mem", 2, 0],
    0x39: ["f64.store", "mem", 2, 0], 0x3a: ["i32.store8", "mem", 2, 0], 0x3b: ["i32.store16", "mem", 2, 0],
    0x3c: ["i64.store8", "mem", 2, 0], 0x3d: ["i64.store16", "mem", 2, 0], 0x3e: ["i64.store32", "mem", 2, 0],
    0x3f: ["memory.size", "misc", 0, 1], 0x40: ["memory.grow", "misc", 1, 1],
    0x41: ["i32.const", "plumb", 0, 1], 0x42: ["i64.const", "plumb", 0, 1], 0x43: ["f32.const", "plumb", 0, 1],
    0x44: ["f64.const", "plumb", 0, 1],
    0x45: ["i32.eqz", "alu", 1, 1], 0x46: ["i32.eq", "alu", 2, 1], 0x47: ["i32.ne", "alu", 2, 1],
    0x48: ["i32.lt_s", "alu", 2, 1], 0x49: ["i32.lt_u", "alu", 2, 1], 0x4a: ["i32.gt_s", "alu", 2, 1],
    0x4b: ["i32.gt_u", "alu", 2, 1], 0x4c: ["i32.le_s", "alu", 2, 1], 0x4d: ["i32.le_u", "alu", 2, 1],
    0x4e: ["i32.ge_s", "alu", 2, 1], 0x4f: ["i32.ge_u", "alu", 2, 1],
    0x50: ["i64.eqz", "alu", 1, 1], 0x51: ["i64.eq", "alu", 2, 1], 0x52: ["i64.ne", "alu", 2, 1],
    0x53: ["i64.lt_s", "alu", 2, 1], 0x54: ["i64.lt_u", "alu", 2, 1], 0x55: ["i64.gt_s", "alu", 2, 1],
    0x56: ["i64.gt_u", "alu", 2, 1], 0x57: ["i64.le_s", "alu", 2, 1], 0x58: ["i64.le_u", "alu", 2, 1],
    0x59: ["i64.ge_s", "alu", 2, 1], 0x5a: ["i64.ge_u", "alu", 2, 1],
    0x5b: ["f32.eq", "alu", 2, 1], 0x5c: ["f32.ne", "alu", 2, 1], 0x5d: ["f32.lt", "alu", 2, 1],
    0x5e: ["f32.gt", "alu", 2, 1], 0x5f: ["f32.le", "alu", 2, 1], 0x60: ["f32.ge", "alu", 2, 1],
    0x61: ["f64.eq", "alu", 2, 1], 0x62: ["f64.ne", "alu", 2, 1], 0x63: ["f64.lt", "alu", 2, 1],
    0x64: ["f64.gt", "alu", 2, 1], 0x65: ["f64.le", "alu", 2, 1], 0x66: ["f64.ge", "alu", 2, 1],
    0x67: ["i32.clz", "alu", 1, 1], 0x68: ["i32.ctz", "alu", 1, 1], 0x69: ["i32.popcnt", "alu", 1, 1],
    0x6a: ["i32.add", "alu", 2, 1], 0x6b: ["i32.sub", "alu", 2, 1], 0x6c: ["i32.mul", "alu", 2, 1],
    0x6d: ["i32.div_s", "alu", 2, 1], 0x6e: ["i32.div_u", "alu", 2, 1], 0x6f: ["i32.rem_s", "alu", 2, 1],
    0x70: ["i32.rem_u", "alu", 2, 1], 0x71: ["i32.and", "alu", 2, 1], 0x72: ["i32.or", "alu", 2, 1],
    0x73: ["i32.xor", "alu", 2, 1], 0x74: ["i32.shl", "alu", 2, 1], 0x75: ["i32.shr_s", "alu", 2, 1],
    0x76: ["i32.shr_u", "alu", 2, 1], 0x77: ["i32.rotl", "alu", 2, 1], 0x78: ["i32.rotr", "alu", 2, 1],
    0x79: ["i64.clz", "alu", 1, 1], 0x7a: ["i64.ctz", "alu", 1, 1], 0x7b: ["i64.popcnt", "alu", 1, 1],
    0x7c: ["i64.add", "alu", 2, 1], 0x7d: ["i64.sub", "alu", 2, 1], 0x7e: ["i64.mul", "alu", 2, 1],
    0x7f: ["i64.div_s", "alu", 2, 1], 0x80: ["i64.div_u", "alu", 2, 1], 0x81: ["i64.rem_s", "alu", 2, 1],
    0x82: ["i64.rem_u", "alu", 2, 1], 0x83: ["i64.and", "alu", 2, 1], 0x84: ["i64.or", "alu", 2, 1],
    0x85: ["i64.xor", "alu", 2, 1], 0x86: ["i64.shl", "alu", 2, 1], 0x87: ["i64.shr_s", "alu", 2, 1],
    0x88: ["i64.shr_u", "alu", 2, 1], 0x89: ["i64.rotl", "alu", 2, 1], 0x8a: ["i64.rotr", "alu", 2, 1],
    0x8b: ["f32.abs", "alu", 1, 1], 0x8c: ["f32.neg", "alu", 1, 1], 0x8d: ["f32.ceil", "alu", 1, 1],
    0x8e: ["f32.floor", "alu", 1, 1], 0x8f: ["f32.trunc", "alu", 1, 1], 0x90: ["f32.nearest", "alu", 1, 1],
    0x91: ["f32.sqrt", "alu", 1, 1], 0x92: ["f32.add", "alu", 2, 1], 0x93: ["f32.sub", "alu", 2, 1],
    0x94: ["f32.mul", "alu", 2, 1], 0x95: ["f32.div", "alu", 2, 1], 0x96: ["f32.min", "alu", 2, 1],
    0x97: ["f32.max", "alu", 2, 1], 0x98: ["f32.copysign", "alu", 2, 1],
    0x99: ["f64.abs", "alu", 1, 1], 0x9a: ["f64.neg", "alu", 1, 1], 0x9b: ["f64.ceil", "alu", 1, 1],
    0x9c: ["f64.floor", "alu", 1, 1], 0x9d: ["f64.trunc", "alu", 1, 1], 0x9e: ["f64.nearest", "alu", 1, 1],
    0x9f: ["f64.sqrt", "alu", 1, 1], 0xa0: ["f64.add", "alu", 2, 1], 0xa1: ["f64.sub", "alu", 2, 1],
    0xa2: ["f64.mul", "alu", 2, 1], 0xa3: ["f64.div", "alu", 2, 1], 0xa4: ["f64.min", "alu", 2, 1],
    0xa5: ["f64.max", "alu", 2, 1], 0xa6: ["f64.copysign", "alu", 2, 1],
    0xa7: ["i32.wrap_i64", "alu", 1, 1], 0xa8: ["i32.trunc_f32_s", "alu", 1, 1],
    0xa9: ["i32.trunc_f32_u", "alu", 1, 1], 0xaa: ["i32.trunc_f64_s", "alu", 1, 1],
    0xab: ["i32.trunc_f64_u", "alu", 1, 1], 0xac: ["i64.extend_i32_s", "alu", 1, 1],
    0xad: ["i64.extend_i32_u", "alu", 1, 1], 0xae: ["i64.trunc_f32_s", "alu", 1, 1],
    0xaf: ["i64.trunc_f32_u", "alu", 1, 1], 0xb0: ["i64.trunc_f64_s", "alu", 1, 1],
    0xb1: ["i64.trunc_f64_u", "alu", 1, 1], 0xb2: ["f32.convert_i32_s", "alu", 1, 1],
    0xb3: ["f32.convert_i32_u", "alu", 1, 1], 0xb4: ["f32.convert_i64_s", "alu", 1, 1],
    0xb5: ["f32.convert_i64_u", "alu", 1, 1], 0xb6: ["f32.demote_f64", "alu", 1, 1],
    0xb7: ["f64.convert_i32_s", "alu", 1, 1], 0xb8: ["f64.convert_i32_u", "alu", 1, 1],
    0xb9: ["f64.convert_i64_s", "alu", 1, 1], 0xba: ["f64.convert_i64_u", "alu", 1, 1],
    0xbb: ["f64.promote_f32", "alu", 1, 1], 0xbc: ["i32.reinterpret_f32", "alu", 1, 1],
    0xbd: ["i64.reinterpret_f64", "alu", 1, 1], 0xbe: ["f32.reinterpret_i32", "alu", 1, 1],
    0xbf: ["f64.reinterpret_i64", "alu", 1, 1],
    0xc0: ["i32.extend8_s", "alu", 1, 1], 0xc1: ["i32.extend16_s", "alu", 1, 1],
    0xc2: ["i64.extend8_s", "alu", 1, 1], 0xc3: ["i64.extend16_s", "alu", 1, 1],
    0xc4: ["i64.extend32_s", "alu", 1, 1],
}).map(([k, v]) => [Number(k), v]));

// ── abstract operand stack ─────────────────────────────────────────────────
//
// Every slot is either TOP (unknown) or an unsigned interval [lo, hi] of a known-bounded i32. A
// singleton is an `i32.const`; the interval part exists because v86 indexes CPU-state arrays with
// a computed index (relaxed FPU: `fpu_st + ((stack_ptr + i) & 7) * 16`) and runtime tables with a
// masked page number (`tlb_data[addr >>> 12]`), and neither is a constant. Anything not modelled
// below is TOP, which classifies as guest RAM — the conservative direction for R2.

const TOP = null;
const U32 = 0xFFFF_FFFF;
// A range at least half the address space wide says nothing about where the access lands
// (`entry & -4096`, an `or` of two bounded values), so it is TOP rather than "bounded".
const iv = (lo, hi) => (lo < 0 || hi > U32 || lo > hi || hi - lo >= 2 ** 31 ? TOP : { lo, hi });
const k = (c) => iv(c >>> 0, c >>> 0);
const single = (a) => a !== TOP && a.lo === a.hi;
const maskOf = (n) => (n === 0 ? 0 : 2 ** (32 - Math.clz32(n)) - 1);

/** Transfer function for the i32 ops the address computations actually use. */
function alu(op, a, b) {
    if (op >= 0x45 && op <= 0x66) return iv(0, 1);                   // eqz + every comparison
    if (op === 0x6a) return a && b ? iv(a.lo + b.lo, a.hi + b.hi) : TOP;
    if (op === 0x6b) return a && b ? iv(a.lo - b.hi, a.hi - b.lo) : TOP;
    if (op === 0x6c) return a && b ? iv(a.lo * b.lo, a.hi * b.hi) : TOP;
    if (op === 0x71) {
        if (single(a) && single(b)) return k(a.lo & b.lo);
        if (a && b) return iv(0, Math.min(a.hi, b.hi));
        return a ? iv(0, a.hi) : b ? iv(0, b.hi) : TOP;
    }
    if (op === 0x72 || op === 0x73) {
        if (single(a) && single(b)) return k(op === 0x72 ? a.lo | b.lo : a.lo ^ b.lo);
        return a && b ? iv(0, maskOf(Math.max(a.hi, b.hi))) : TOP;
    }
    if (op === 0x74) {
        if (!single(b)) return TOP;
        const s = b.lo & 31;
        if (single(a)) return k(a.lo << s);
        return a ? iv(a.lo * 2 ** s, a.hi * 2 ** s) : TOP;
    }
    if (op === 0x76) {
        if (!single(b)) return TOP;
        const s = b.lo & 31;
        return a ? iv(a.lo >>> s, a.hi >>> s) : iv(0, U32 >>> s);
    }
    return TOP;
}

const BLOCK_VALTYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);
// Field names for the per-address histogram, read from the engine source itself when the
// submodule is present (G names only the fields the AOT ABI touches, so `cr` at 580 would print
// as "previous_ip+20"). Reading it also pins STATE_BLOCK: a pointer outside it means the engine's
// state block moved and every cpuState count would be wrong, so that is a hard error.
function stateFields() {
    const src = new URL("../../vendor/v86/src/rust/cpu/global_pointers.rs", import.meta.url);
    let text;
    try { text = fs.readFileSync(src, "utf8"); } catch { return Object.entries(G); }
    const out = [...text.matchAll(/pub const (\w+): \*mut [\w:]+ = (\d+) as \*mut/g)].map((x) => [x[1], +x[2]]);
    const lo = Math.min(...out.map((x) => x[1]));
    const bad = out.filter(([, a]) => a < STATE_BLOCK.lo || a >= STATE_BLOCK.hi);
    if (!out.length || lo !== STATE_BLOCK.lo || bad.length) {
        throw new Error(`global_pointers.rs disagrees with STATE_BLOCK [${STATE_BLOCK.lo}, ${STATE_BLOCK.hi}):`
            + ` lowest ${lo}, outside: ${bad.map(([n, a]) => `${n}@${a}`).join(", ") || "none"}`);
    }
    return out;
}
const stateName = (() => {
    const fields = stateFields().sort((x, y) => x[1] - y[1]);   // stable: reg8/reg16/reg32 -> reg32
    return (addr) => {
        let best = null;
        for (const [n, a] of fields) if (a <= addr) best = [n, a];
        return best[1] === addr ? `${addr} ${best[0]}` : `${addr} ${best[0]}+${addr - best[1]}`;
    };
})();

/**
 * Bucket of one access, from its address operand and memarg offset.
 *   cpuState     the whole effective range lies in v86's fixed state block (STATE_BLOCK)
 *   constOther   a constant address outside the state block. A JIT access to an absolute x86
 *                address reads tlb_data[<const page>] at a constant address, so these are listed
 *                and attributed against the capture's engine layout when one is supplied
 *   table        an indexed Rust static (tlb_data[page], the fastmem write map), not guest RAM: a
 *                bounded, non-constant address entirely at/above GLOBAL_BASE, or an unpatched
 *                relocation — the memarg offset is the 5-byte zero placeholder that
 *                wasm.mjs loadRelocOffset writes and publication patches with tlb_data's base
 *   boundedOther a bounded address matching none of the above (expected 0; sites are listed)
 *   guest        address not bounded by the model: TLB-entry- or mem8-derived guest RAM
 */
function classify(addr, offset, reloc) {
    if (reloc) return "table";
    if (addr === TOP) return "guest";
    const lo = addr.lo + offset, hi = addr.hi + offset;
    if (lo >= STATE_BLOCK.lo && hi < STATE_BLOCK.hi) return "cpuState";
    if (lo === hi) return "constOther";
    if (lo >= GLOBAL_BASE) return "table";
    return "boundedOther";
}

/**
 * @returns {{ops:number, groups:object, plumbingPct:number, memSplit:object, cpuStateByAddr:object,
 *           oddSites:Array, calls:object, top:Array}}
 * @param {object} [opts]
 * @param {Map} [opts.ops] opcode table (a test substitutes a corrupted one to prove the checks fire)
 * @param {boolean} [opts.sites] include every memory access in the result
 * @param {{tlbDataBase?:number, mem8?:number, memorySize?:number}} [opts.layout] the capture's
 *        engine layout (job JSON `engine`), used only to attribute constOther addresses
 */
export function moduleStats(bytes, label = "", { ops: opsTable = OPS, sites = false, layout = null } = {}) {
    const m = parseModule(bytes);
    if (!m.code) throw new Error(`${label}: no code section`);
    const { instrStart, instrEnd } = m.code;
    if (bytes[instrEnd - 1] !== 0x0b) {                                        // self-check 2
        throw new Error(`${label}: body does not end in 0x0b (found 0x${bytes[instrEnd - 1].toString(16)})`);
    }
    const fnImportList = m.imports.filter((i) => i.kind === 0);
    const fnImports = fnImportList.map((i) => i.name);
    const fnType = (idx) => {
        const t = idx < fnImportList.length ? fnImportList[idx].type : m.functions[idx - fnImportList.length];
        const ty = m.types[t];
        if (!ty) throw new Error(`${label}: call to function ${idx} with no type (type index ${t})`);
        return ty;
    };
    if (m.functions.length < 1) throw new Error(`${label}: code section without a function section entry`);
    const bodyType = m.types[m.functions[0]];

    const groups = { plumb: 0, mem: 0, alu: 0, ctrl: 0, call: 0, misc: 0 };
    const hist = new Map();
    const calls = new Map();
    let ops = 0, depth = 0, minDepth = 0;
    const blank = () => ({ cpuState: 0, guest: 0, table: 0, constOther: 0, boundedOther: 0 });
    const memSplit = blank(), v128Split = blank();
    const stateHist = new Map();               // "addr name" -> {load, store}
    const oddSites = [];                       // constOther / boundedOther, for the report
    const siteList = [];
    const region = (a) => {
        if (a < STATE_BLOCK.lo) return "low";
        if (a < GLOBAL_BASE) return "fixed-low";
        const { tlbDataBase: t, mem8, memorySize } = layout ?? {};
        if (t != null && a >= t && a < t + 0x100000 * 4) return `tlb_data[${(a - t) >>> 2}]`;
        if (mem8 != null && memorySize != null && a >= mem8 && a < mem8 + memorySize) return "guest-ram";
        return layout ? "rust-static" : "unattributed";
    };
    let lastOff = -1, lastOp = -1;

    // Control frames: the function body is frame 0. `height` is the operand-stack depth at entry.
    const stack = [];
    const frames = [{ op: "func", height: 0, arity: bodyType.results.length, unreachable: false }];
    const top = () => frames[frames.length - 1];
    const where = (ins) => `+${ins.offset - instrStart}`;
    const pop = (ins, name) => {
        const f = top();
        if (stack.length > f.height) return stack.pop();
        if (f.unreachable) return TOP;         // stack-polymorphic after br/return/unreachable
        throw new Error(`${label}: operand stack underflow at ${where(ins)} (${name}) — a stack`   // self-check 5
            + " effect is mis-modelled, so every address after it would be read from the wrong slot");
    };
    const popN = (ins, name, n) => { for (let i = 0; i < n; i++) pop(ins, name); };
    const pushN = (n) => { for (let i = 0; i < n; i++) stack.push(TOP); };
    const peek = (i) => (stack.length - 1 - i >= top().height ? stack[stack.length - 1 - i] : TOP);
    const goUnreachable = () => { const f = top(); stack.length = f.height; f.unreachable = true; };
    // Locals, flow-sensitively: v86 computes an address once into a pooled local and uses it
    // later (relaxed FPU: `fpu_st + idx*16` -> local.set -> ... -> local.get -> i64.store), so a
    // stack-only model reads those CPU-state accesses as guest RAM. Structured control flow
    // makes the join points explicit: a block/if joins its fallthrough with every branch to its
    // label; a loop head is made sound without a fixpoint by forgetting (TOP) every local the loop
    // body assigns. `live` is false where no path reaches (the locals state is bottom there).
    const list = [...walkBody(bytes, instrStart, instrEnd)];
    const loopSets = new Map();                // loop instruction index -> locals it assigns
    {
        const open = [];
        for (let i = 0; i < list.length; i++) {
            const op = list[i].op;
            if (op === 0x02 || op === 0x03 || op === 0x04) {
                const set = op === 0x03 ? new Set() : null;
                if (set) loopSets.set(i, set);
                open.push(set);
            }
            else if (op === 0x0b) open.pop();
            else if (op === 0x21 || op === 0x22) for (const set of open) set?.add(list[i].imm);
        }
    }
    const nParams = bodyType.params.length;
    let L = Array.from({ length: nParams + m.code.localCount }, (_, i) => (i < nParams ? TOP : k(0)));
    let live = true;
    const joinV = (a, b) => (a && b ? iv(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi)) : TOP);
    const joinL = (a, b) => a.map((v, i) => joinV(v, b[i]));
    const branchTo = (ins, d) => {
        const t = frames[frames.length - 1 - d];
        if (!t) throw new Error(`${label}: branch depth ${d} escapes the function at ${where(ins)}`);
        if (!live || t.op === "loop") return;  // loop-head locals were already forgotten
        t.brL = t.brL ? joinL(t.brL, L) : L.slice();
    };
    const checkArity = (ins, f, what) => {                                     // self-check 6
        if (!f.unreachable && stack.length !== f.height + f.arity) {
            throw new Error(`${label}: operand stack depth ${stack.length - f.height} at ${what} ${where(ins)}`
                + ` of a ${f.op} frame, expected its result arity ${f.arity}`);
        }
    };

    // Walk INCLUDING the trailing function `end`, so that "the last instruction decoded starts at
    // exactly instrEnd-1 and is 0x0b" becomes a byte-exact identity over the whole body: any
    // immediate whose length we got wrong desynchronises the stream and lands somewhere else.
    // That is the closest thing to a second decoder available without a wabt dependency.
    for (let ii = 0; ii < list.length; ii++) {
        const ins = list[ii];
        const v128 = ins.op === 0xfd;
        const known = v128
            ? [ins.imm.subop === 0 ? "v128.load" : "v128.store", "mem", ins.imm.subop === 0 ? 1 : 2, ins.imm.subop === 0 ? 1 : 0]
            : opsTable.get(ins.op);
        if (!known) {                                                          // self-check 4
            throw new Error(`${label}: unknown opcode 0x${ins.op.toString(16)} at ${where(ins)}`
                + " — a decode hole mis-attributes every byte after it");
        }
        const [name, group, npop, npush] = known;
        ops++;
        groups[group]++;
        hist.set(name, (hist.get(name) ?? 0) + 1);
        if (ins.op === 0x10) {
            const n = fnImports[ins.imm] ?? `fn${ins.imm}`;
            calls.set(n, (calls.get(n) ?? 0) + 1);
        }

        if (group === "mem") {
            // A CPU-state access is `i32.const <addr>` + load/store with offset 0 (v86
            // wasm_builder load_fixed_*/store_*: the address is on the STACK, not in the memarg)
            // or any bounded address inside the block; a guest-RAM access goes through a
            // TLB- or mem8-derived address the model cannot bound.
            const isStore = npush === 0;
            const addr = peek(isStore ? 1 : 0);
            const at = ins.imm.offsetAt;
            const reloc = bytes[at] === 0x80 && bytes[at + 1] === 0x80 && bytes[at + 2] === 0x80
                && bytes[at + 3] === 0x80 && bytes[at + 4] === 0x00;
            const bucket = classify(addr, ins.imm.offset, reloc);
            memSplit[bucket]++;
            if (sites) siteList.push({ at: ins.offset - instrStart, op: name, bucket, offset: ins.imm.offset,
                lo: addr?.lo ?? null, hi: addr?.hi ?? null });
            if (v128) v128Split[bucket]++;
            if (bucket === "cpuState") {
                const key = stateName(addr.lo + ins.imm.offset);
                const e = stateHist.get(key) ?? { load: 0, store: 0 };
                e[isStore ? "store" : "load"]++;
                stateHist.set(key, e);
            }
            else if (bucket === "constOther" || bucket === "boundedOther") {
                const a = addr.lo + ins.imm.offset;
                oddSites.push({ at: ins.offset - instrStart, op: name, bucket,
                    lo: a, hi: addr.hi + ins.imm.offset, region: bucket === "constOther" ? region(a) : null });
            }
            popN(ins, name, npop);
            if (npush) stack.push(ins.op === 0x2d ? iv(0, 0xff) : ins.op === 0x2f ? iv(0, 0xffff) : TOP);
        }
        else if (ins.op === 0x02 || ins.op === 0x03 || ins.op === 0x04) {
            const bt = bytes[ins.offset + 1];
            if (bt !== 0x40 && !BLOCK_VALTYPES.has(bt)) {
                throw new Error(`${label}: type-indexed block type 0x${bt.toString(16)} at ${where(ins)} is not modelled`);
            }
            if (ins.op === 0x04) pop(ins, name);
            frames.push({ op: name, height: stack.length, arity: bt === 0x40 ? 0 : 1, unreachable: false,
                brL: null, entryL: ins.op === 0x04 ? L.slice() : null, entryLive: live, sawElse: false });
            if (ins.op === 0x03) for (const x of loopSets.get(ii)) L[x] = TOP;
        }
        else if (ins.op === 0x05) {
            const f = top();
            if (f.op !== "if") throw new Error(`${label}: else outside an if at ${where(ins)}`);
            checkArity(ins, f, "else");
            stack.length = f.height;
            f.unreachable = false;
            if (live) f.brL = f.brL ? joinL(f.brL, L) : L.slice();
            L = f.entryL.slice(); live = f.entryLive; f.sawElse = true;
        }
        else if (ins.op === 0x0b) {
            const f = top();
            checkArity(ins, f, "end");
            stack.length = f.height;
            frames.pop();
            if (f.op === "block" || f.op === "if") {
                let acc = live ? L : null;
                if (f.brL) acc = acc ? joinL(acc, f.brL) : f.brL;
                if (f.op === "if" && !f.sawElse && f.entryLive) acc = acc ? joinL(acc, f.entryL) : f.entryL;
                if (acc) { L = acc.slice(); live = true; } else live = false;
            }
            if (frames.length) pushN(f.arity);
        }
        else if (ins.op === 0x0c) { branchTo(ins, ins.imm); goUnreachable(); live = false; }
        else if (ins.op === 0x0d) { pop(ins, name); branchTo(ins, ins.imm); }
        else if (ins.op === 0x0f || ins.op === 0x00) { goUnreachable(); live = false; }
        else if (ins.op === 0x0e) {
            pop(ins, name);
            for (const d of ins.imm) branchTo(ins, d);
            goUnreachable(); live = false;
        }
        else if (ins.op === 0x20) stack.push(live ? L[ins.imm] : TOP);
        else if (ins.op === 0x21 || ins.op === 0x22) {
            if (ins.imm >= L.length) throw new Error(`${label}: local ${ins.imm} out of range at ${where(ins)}`);
            const v = pop(ins, name);
            if (live) L[ins.imm] = v;
            if (ins.op === 0x22) stack.push(v);
        }
        else if (ins.op === 0x10 || ins.op === 0x12) {
            const ty = fnType(ins.imm);
            popN(ins, name, ty.params.length);
            if (ins.op === 0x12) { goUnreachable(); live = false; } else pushN(ty.results.length);
        }
        else if (ins.op === 0x11 || ins.op === 0x13) {
            const [t] = uleb(bytes, ins.offset + 1);
            const ty = m.types[t];
            if (!ty) throw new Error(`${label}: call_indirect with no type ${t} at ${where(ins)}`);
            pop(ins, name);                    // table index
            popN(ins, name, ty.params.length);
            if (ins.op === 0x13) { goUnreachable(); live = false; } else pushN(ty.results.length);
        }
        else if (ins.op === 0x41) stack.push(k(ins.imm));
        else if (ins.op === 0x1b) {
            pop(ins, name);
            const b = pop(ins, name), a = pop(ins, name);
            stack.push(a && b ? iv(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi)) : TOP);
        }
        else if (group === "alu" && npop === 2 && npush === 1) {
            const b = pop(ins, name), a = pop(ins, name);
            stack.push(alu(ins.op, a, b));
        }
        else if (group === "alu" && npop === 1 && npush === 1) {
            pop(ins, name);
            stack.push(ins.op === 0x45 || ins.op === 0x50 ? iv(0, 1) : TOP);
        }
        else {
            if (npop == null) throw new Error(`${label}: no stack effect for ${name}`);
            popN(ins, name, npop);
            pushN(npush);
        }

        depth += (ins.op === 0x02 || ins.op === 0x03 || ins.op === 0x04) ? 1
            : (ins.op === 0x0b ? -1 : 0);
        if (depth < minDepth) minDepth = depth;
        lastOff = ins.offset; lastOp = ins.op;
    }
    // self-check 3: the function's own `end` takes depth from 0 to -1, and nothing before it may.
    if (minDepth < -1) throw new Error(`${label}: block depth went below the function body`);
    if (depth !== -1) throw new Error(`${label}: unbalanced blocks, depth ${depth + 1} at end`);
    // self-check 6 (function level): the function frame's `end` was checked against the body's
    // result arity above; the model must also have consumed exactly its frames.
    if (frames.length !== 0 || stack.length !== 0) {
        throw new Error(`${label}: control model left ${frames.length} frames / ${stack.length} values`);
    }
    // self-check 1: the decode landed byte-exactly on the trailing function END
    if (lastOff !== instrEnd - 1 || lastOp !== 0x0b) {
        throw new Error(`${label}: decode desynchronised — last op 0x${lastOp.toString(16)} at`
            + ` +${lastOff - instrStart}, expected 0x0b at +${instrEnd - 1 - instrStart}`);
    }
    ops -= 1;                      // do not count the function's own terminating `end`
    groups.ctrl -= 1;
    hist.set("end", hist.get("end") - 1);

    return {
        file: label,
        moduleBytes: bytes.length,
        bodyBytes: instrEnd - instrStart,
        ops,
        locals: m.code.localCount,
        imports: fnImports.length,
        groups,
        plumbingPct: +(groups.plumb / ops * 100).toFixed(1),
        memSplit: { ...memSplit, v128: v128Split },
        constOtherByRegion: oddSites.filter((o) => o.bucket === "constOther").reduce((acc, o) => {
            const r = o.region.startsWith("tlb_data[") ? "tlb_data" : o.region;
            acc[r] = (acc[r] ?? 0) + 1; return acc;
        }, {}),
        cpuStateByAddr: Object.fromEntries([...stateHist].sort((a, b) => parseInt(a[0]) - parseInt(b[0]))),
        oddSites,
        ...(sites ? { sites: siteList } : {}),
        calls: Object.fromEntries([...calls].sort((a, b) => b[1] - a[1])),
        top: [...hist].sort((a, b) => b[1] - a[1]).slice(0, 12)
            .map(([n, c]) => [n, c, +(c / ops * 100).toFixed(1)]),
    };
}

export { OPS };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("module-stats.mjs")) {
    const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    const asJson = process.argv.includes("--json");
    const showState = process.argv.includes("--state");
    if (!files.length) {
        process.stderr.write("usage: node module-stats.mjs <module.wasm> [more.wasm ...] [--json] [--state]\n");
        process.exit(2);
    }
    // A capture (`jobs/<case>.json`, written by capture-job.mjs) records the engine layout the
    // module was compiled against; pick it up for `<case>.jit.wasm` so constOther is attributed.
    const layoutFor = (f) => {
        const j = path.join(path.dirname(f), path.basename(f).replace(/\.jit\.wasm$|(-unit)?\.\d+\.wasm$/, "") + ".json");
        try { return JSON.parse(fs.readFileSync(j, "utf8")).engine ?? null; } catch { return null; }
    };
    const out = files.map((f) => moduleStats(new Uint8Array(fs.readFileSync(f)), path.basename(f), { layout: layoutFor(f) }));
    if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
    const pad = (s, n) => String(s).padStart(n);
    console.log(`${"module".padEnd(16)}${pad("bytes", 8)}${pad("body", 8)}${pad("ops", 7)}`
        + `${pad("plumb%", 8)}${pad("mem", 6)}${pad("alu", 6)}${pad("ctrl", 6)}${pad("call", 6)}`
        + `${pad("locals", 8)}${pad("imports", 8)}`);
    for (const s of out) {
        console.log(`${s.file.padEnd(16)}${pad(s.moduleBytes, 8)}${pad(s.bodyBytes, 8)}${pad(s.ops, 7)}`
            + `${pad(s.plumbingPct, 8)}${pad(s.groups.mem, 6)}${pad(s.groups.alu, 6)}`
            + `${pad(s.groups.ctrl, 6)}${pad(s.groups.call, 6)}${pad(s.locals, 8)}${pad(s.imports, 8)}`);
    }
    for (const s of out) {
        const ms = s.memSplit, v = ms.v128;
        console.log(`\n${s.file}: mem = ${ms.cpuState} cpu-state + ${ms.guest} guest + ${ms.table} table`
            + ` + ${ms.constOther} const-other + ${ms.boundedOther} bounded-other`
            + `  (v128: ${v.cpuState} cpu-state, ${v.guest} guest, ${v.table} table, ${v.constOther} const-other)`
            + (s.oddSites.length ? `\n  const-other by region: ${JSON.stringify(s.constOtherByRegion)}`
                + `\n  odd:   ${s.oddSites.slice(0, 6).map((o) => `${o.op}@+${o.at} [${o.lo}..${o.hi}]${o.region ? " " + o.region : ""}`).join(", ")}`
                + (s.oddSites.length > 6 ? ` ... (${s.oddSites.length} total)` : "") : "")
            + (showState ? `\n  state: ${Object.entries(s.cpuStateByAddr).map(([a, e]) => `${a} ${e.load}r/${e.store}w`).join(", ")}` : "")
            + `\n  calls: ${Object.entries(s.calls).map(([n, c]) => `${n}x${c}`).join(" ") || "none"}`
            + `\n  top:   ${s.top.map(([n, c, p]) => `${n} ${c} (${p}%)`).join(", ")}`);
    }
}
