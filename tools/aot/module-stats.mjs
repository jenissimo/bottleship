#!/usr/bin/env node
// Size and shape of a wasm module body — the instrument that says what a producer (or a pass)
// actually emitted, and what it removed.
//
//   node tools/aot/module-stats.mjs units/k4.0.wasm jobs/k4.jit.wasm
//   node tools/aot/module-stats.mjs --json units/k4.0.wasm
//
// SELF-CHECKING BY CONSTRUCTION, because the failure mode of a histogram is to report a
// plausible number for a body it mis-decoded (project memory: "instruments that cannot fail
// loudly"). Four assertions, any of which is a hard error rather than a footnote:
//
//   1. the last instruction decoded starts at exactly `instrEnd - 1` — a byte-exact identity over
//      the whole body, so a mis-sized immediate desynchronises and is caught instead of averaged;
//   2. the last byte is the function's `end` (0x0b);
//   3. block depth is balanced: only the function's own `end` may take it below 0;
//   4. every opcode is in the known table. An unknown opcode is a decode hole, and a decode
//      hole silently mis-attributes every byte after it.
//
// "Plumbing" is const + local traffic: the memory-convention ABI made explicit. It is reported
// because it is the number that does NOT move between backends (design §0.1 F-a measured
// 52.4 % for v86's JIT, 53.2 % for this producer, 52.5 % for an LLVM route), so a pass claiming
// to remove plumbing has to move it here to be believed.

import fs from "node:fs";
import path from "node:path";
import { parseModule, walkBody } from "./lib/wdis.mjs";
import { G } from "./lib/abi.mjs";

// name, group. Groups: plumb (const/local), mem (linear memory), alu, ctrl, call, misc.
const OPS = new Map(Object.entries({
    0x00: ["unreachable", "ctrl"], 0x01: ["nop", "misc"], 0x02: ["block", "ctrl"],
    0x03: ["loop", "ctrl"], 0x04: ["if", "ctrl"], 0x05: ["else", "ctrl"], 0x0b: ["end", "ctrl"],
    0x0c: ["br", "ctrl"], 0x0d: ["br_if", "ctrl"], 0x0e: ["br_table", "ctrl"],
    0x0f: ["return", "ctrl"], 0x10: ["call", "call"], 0x11: ["call_indirect", "call"],
    0x12: ["return_call", "call"], 0x13: ["return_call_indirect", "call"],
    0x1a: ["drop", "plumb"], 0x1b: ["select", "alu"],
    0x20: ["local.get", "plumb"], 0x21: ["local.set", "plumb"], 0x22: ["local.tee", "plumb"],
    0x23: ["global.get", "plumb"], 0x24: ["global.set", "plumb"],
    0x28: ["i32.load", "mem"], 0x29: ["i64.load", "mem"], 0x2a: ["f32.load", "mem"],
    0x2b: ["f64.load", "mem"], 0x2c: ["i32.load8_s", "mem"], 0x2d: ["i32.load8_u", "mem"],
    0x2e: ["i32.load16_s", "mem"], 0x2f: ["i32.load16_u", "mem"],
    0x30: ["i64.load8_s", "mem"], 0x31: ["i64.load8_u", "mem"], 0x32: ["i64.load16_s", "mem"],
    0x33: ["i64.load16_u", "mem"], 0x34: ["i64.load32_s", "mem"], 0x35: ["i64.load32_u", "mem"],
    0x36: ["i32.store", "mem"], 0x37: ["i64.store", "mem"], 0x38: ["f32.store", "mem"],
    0x39: ["f64.store", "mem"], 0x3a: ["i32.store8", "mem"], 0x3b: ["i32.store16", "mem"],
    0x3c: ["i64.store8", "mem"], 0x3d: ["i64.store16", "mem"], 0x3e: ["i64.store32", "mem"],
    0x3f: ["memory.size", "misc"], 0x40: ["memory.grow", "misc"],
    0x41: ["i32.const", "plumb"], 0x42: ["i64.const", "plumb"], 0x43: ["f32.const", "plumb"],
    0x44: ["f64.const", "plumb"],
    0x45: ["i32.eqz", "alu"], 0x46: ["i32.eq", "alu"], 0x47: ["i32.ne", "alu"],
    0x48: ["i32.lt_s", "alu"], 0x49: ["i32.lt_u", "alu"], 0x4a: ["i32.gt_s", "alu"],
    0x4b: ["i32.gt_u", "alu"], 0x4c: ["i32.le_s", "alu"], 0x4d: ["i32.le_u", "alu"],
    0x4e: ["i32.ge_s", "alu"], 0x4f: ["i32.ge_u", "alu"],
    0x50: ["i64.eqz", "alu"], 0x51: ["i64.eq", "alu"], 0x52: ["i64.ne", "alu"],
    0x53: ["i64.lt_s", "alu"], 0x54: ["i64.lt_u", "alu"], 0x55: ["i64.gt_s", "alu"],
    0x56: ["i64.gt_u", "alu"], 0x57: ["i64.le_s", "alu"], 0x58: ["i64.le_u", "alu"],
    0x59: ["i64.ge_s", "alu"], 0x5a: ["i64.ge_u", "alu"],
    0x5b: ["f32.eq", "alu"], 0x5c: ["f32.ne", "alu"], 0x5d: ["f32.lt", "alu"],
    0x5e: ["f32.gt", "alu"], 0x5f: ["f32.le", "alu"], 0x60: ["f32.ge", "alu"],
    0x61: ["f64.eq", "alu"], 0x62: ["f64.ne", "alu"], 0x63: ["f64.lt", "alu"],
    0x64: ["f64.gt", "alu"], 0x65: ["f64.le", "alu"], 0x66: ["f64.ge", "alu"],
    0x67: ["i32.clz", "alu"], 0x68: ["i32.ctz", "alu"], 0x69: ["i32.popcnt", "alu"],
    0x6a: ["i32.add", "alu"], 0x6b: ["i32.sub", "alu"], 0x6c: ["i32.mul", "alu"],
    0x6d: ["i32.div_s", "alu"], 0x6e: ["i32.div_u", "alu"], 0x6f: ["i32.rem_s", "alu"],
    0x70: ["i32.rem_u", "alu"], 0x71: ["i32.and", "alu"], 0x72: ["i32.or", "alu"],
    0x73: ["i32.xor", "alu"], 0x74: ["i32.shl", "alu"], 0x75: ["i32.shr_s", "alu"],
    0x76: ["i32.shr_u", "alu"], 0x77: ["i32.rotl", "alu"], 0x78: ["i32.rotr", "alu"],
    0x79: ["i64.clz", "alu"], 0x7a: ["i64.ctz", "alu"], 0x7b: ["i64.popcnt", "alu"],
    0x7c: ["i64.add", "alu"], 0x7d: ["i64.sub", "alu"], 0x7e: ["i64.mul", "alu"],
    0x7f: ["i64.div_s", "alu"], 0x80: ["i64.div_u", "alu"], 0x81: ["i64.rem_s", "alu"],
    0x82: ["i64.rem_u", "alu"], 0x83: ["i64.and", "alu"], 0x84: ["i64.or", "alu"],
    0x85: ["i64.xor", "alu"], 0x86: ["i64.shl", "alu"], 0x87: ["i64.shr_s", "alu"],
    0x88: ["i64.shr_u", "alu"], 0x89: ["i64.rotl", "alu"], 0x8a: ["i64.rotr", "alu"],
    0x8b: ["f32.abs", "alu"], 0x8c: ["f32.neg", "alu"], 0x8d: ["f32.ceil", "alu"],
    0x8e: ["f32.floor", "alu"], 0x8f: ["f32.trunc", "alu"], 0x90: ["f32.nearest", "alu"],
    0x91: ["f32.sqrt", "alu"], 0x92: ["f32.add", "alu"], 0x93: ["f32.sub", "alu"],
    0x94: ["f32.mul", "alu"], 0x95: ["f32.div", "alu"], 0x96: ["f32.min", "alu"],
    0x97: ["f32.max", "alu"], 0x98: ["f32.copysign", "alu"],
    0x99: ["f64.abs", "alu"], 0x9a: ["f64.neg", "alu"], 0x9b: ["f64.ceil", "alu"],
    0x9c: ["f64.floor", "alu"], 0x9d: ["f64.trunc", "alu"], 0x9e: ["f64.nearest", "alu"],
    0x9f: ["f64.sqrt", "alu"], 0xa0: ["f64.add", "alu"], 0xa1: ["f64.sub", "alu"],
    0xa2: ["f64.mul", "alu"], 0xa3: ["f64.div", "alu"], 0xa4: ["f64.min", "alu"],
    0xa5: ["f64.max", "alu"], 0xa6: ["f64.copysign", "alu"],
    0xa7: ["i32.wrap_i64", "alu"], 0xa8: ["i32.trunc_f32_s", "alu"],
    0xa9: ["i32.trunc_f32_u", "alu"], 0xaa: ["i32.trunc_f64_s", "alu"],
    0xab: ["i32.trunc_f64_u", "alu"], 0xac: ["i64.extend_i32_s", "alu"],
    0xad: ["i64.extend_i32_u", "alu"], 0xae: ["i64.trunc_f32_s", "alu"],
    0xaf: ["i64.trunc_f32_u", "alu"], 0xb0: ["i64.trunc_f64_s", "alu"],
    0xb1: ["i64.trunc_f64_u", "alu"], 0xb2: ["f32.convert_i32_s", "alu"],
    0xb3: ["f32.convert_i32_u", "alu"], 0xb4: ["f32.convert_i64_s", "alu"],
    0xb5: ["f32.convert_i64_u", "alu"], 0xb6: ["f32.demote_f64", "alu"],
    0xb7: ["f64.convert_i32_s", "alu"], 0xb8: ["f64.convert_i32_u", "alu"],
    0xb9: ["f64.convert_i64_s", "alu"], 0xba: ["f64.convert_i64_u", "alu"],
    0xbb: ["f64.promote_f32", "alu"], 0xbc: ["i32.reinterpret_f32", "alu"],
    0xbd: ["i64.reinterpret_f64", "alu"], 0xbe: ["f32.reinterpret_i32", "alu"],
    0xbf: ["f64.reinterpret_i64", "alu"],
    0xc0: ["i32.extend8_s", "alu"], 0xc1: ["i32.extend16_s", "alu"],
    0xc2: ["i64.extend8_s", "alu"], 0xc3: ["i64.extend16_s", "alu"],
    0xc4: ["i64.extend32_s", "alu"],
}).map(([k, v]) => [Number(k), v]));

const CPU_STATE = new Map(Object.entries(G).map(([k, v]) => [v, k]));

/** @returns {{ops:number, bytes:number, groups:object, plumbingPct:number, hist:Array, calls:object}} */
export function moduleStats(bytes, label = "") {
    const m = parseModule(bytes);
    if (!m.code) throw new Error(`${label}: no code section`);
    const { instrStart, instrEnd } = m.code;
    if (bytes[instrEnd - 1] !== 0x0b) {                                        // self-check 2
        throw new Error(`${label}: body does not end in 0x0b (found 0x${bytes[instrEnd - 1].toString(16)})`);
    }
    const fnImports = m.imports.filter((i) => i.kind === 0).map((i) => i.name);

    const groups = { plumb: 0, mem: 0, alu: 0, ctrl: 0, call: 0, misc: 0 };
    const hist = new Map();
    const calls = new Map();
    let ops = 0, depth = 0, minDepth = 0;
    let cpuStateTouch = 0, guestMemTouch = 0;
    let lastOff = -1, lastOp = -1;

    // Walk INCLUDING the trailing function `end`, so that "the last instruction decoded starts at
    // exactly instrEnd-1 and is 0x0b" becomes a byte-exact identity over the whole body: any
    // immediate whose length we got wrong desynchronises the stream and lands somewhere else.
    // That is the closest thing to a second decoder available without a wabt dependency.
    for (const ins of walkBody(bytes, instrStart, instrEnd)) {
        const known = OPS.get(ins.op);
        if (!known) {                                                          // self-check 4
            throw new Error(`${label}: unknown opcode 0x${ins.op.toString(16)} at +${ins.offset - instrStart}`
                + " — a decode hole mis-attributes every byte after it");
        }
        const [name, group] = known;
        ops++;
        groups[group]++;
        hist.set(name, (hist.get(name) ?? 0) + 1);
        if (ins.op === 0x10) {
            const n = fnImports[ins.imm] ?? `fn${ins.imm}`;
            calls.set(n, (calls.get(n) ?? 0) + 1);
        }
        if (group === "mem") {
            // A CPU-state access is `i32.const <global_pointers addr>` + load/store, or the
            // memarg-offset form; a guest-RAM access goes through a TLB-derived address. The
            // split is what says how much of a body is architectural bookkeeping.
            if (CPU_STATE.has(ins.imm?.offset)) cpuStateTouch++;
            else guestMemTouch++;
        }
        depth += (ins.op === 0x02 || ins.op === 0x03 || ins.op === 0x04) ? 1
            : (ins.op === 0x0b ? -1 : 0);
        if (depth < minDepth) minDepth = depth;
        lastOff = ins.offset; lastOp = ins.op;
    }
    // self-check 3: the function's own `end` takes depth from 0 to -1, and nothing before it may.
    if (minDepth < -1) throw new Error(`${label}: block depth went below the function body`);
    if (depth !== -1) throw new Error(`${label}: unbalanced blocks, depth ${depth + 1} at end`);
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
        memSplit: { cpuState: cpuStateTouch, guest: guestMemTouch },
        calls: Object.fromEntries([...calls].sort((a, b) => b[1] - a[1])),
        top: [...hist].sort((a, b) => b[1] - a[1]).slice(0, 12)
            .map(([n, c]) => [n, c, +(c / ops * 100).toFixed(1)]),
    };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("module-stats.mjs")) {
    const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    const asJson = process.argv.includes("--json");
    if (!files.length) {
        process.stderr.write("usage: node module-stats.mjs <module.wasm> [more.wasm ...] [--json]\n");
        process.exit(2);
    }
    const out = files.map((f) => moduleStats(new Uint8Array(fs.readFileSync(f)), path.basename(f)));
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
        console.log(`\n${s.file}: mem = ${s.memSplit.cpuState} cpu-state + ${s.memSplit.guest} guest`
            + `\n  calls: ${Object.entries(s.calls).map(([n, c]) => `${n}x${c}`).join(" ") || "none"}`
            + `\n  top:   ${s.top.map(([n, c, p]) => `${n} ${c} (${p}%)`).join(", ")}`);
    }
}
