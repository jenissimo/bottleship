#!/usr/bin/env bun

/**
 * wat-blockmap — Track 2b Phase M0 (plan/2b-codegen-quality.md §Phase M).
 *
 * Per-BLOCK anatomy of a v86 JIT module dump (`.flat.wat` from __wasmDump → wasm2wat).
 * wat-anatomy.ts gives module-level op categories; this tool segments the module into
 * guest basic blocks (via the instruction-counter local bump that opens every block)
 * and classifies ops into MECHANISM buckets keyed on the global_pointers address map,
 * so the G-M1 question ("what share of a hot short block is per-block fixed cost vs
 * per-instruction template tax vs real compute?") gets a measured answer.
 *
 * Buckets (production view excludes `stats` — dispatch-stats sextets only exist in
 * dumps captured with DISPATCH_STATS on):
 *   counter      IC-local bump quads (local.get ic / const / add / set ic)
 *   stats        profiler stat_array i64 increments (compile-time gated, prod-absent)
 *   lazyflags    loads/stores/RMW touching the lazy-flag tuple @96..123
 *                (last_op_size/flags_changed/last_op1/last_result/flags)
 *   eip          stores/loads @556/560 (instruction_pointer / previous_ip)
 *   regfile      loads/stores @64..95 (reg32 file) — value-forwarding target
 *   cpustate     other global_pointers traffic (segments, state_flags, cr, misc <2048)
 *   memcheck     TLB write-path checks (load offset=TLB_BASE + mask arithmetic) and
 *                fastmem read acceptance range compares (the split-range constants)
 *   guestmem     the actual RAM access: mem8-base adds + load/store with computed addr,
 *                (entry &~0xFFF)^addr translation ops
 *   slowglue     safe_*_slow_jit / get_phys_eip call sites + result tests
 *   dispatch     jit_find_cache_entry* calls + their glue
 *   edge         control ops (block/loop/if/else/end/br/br_if/br_table/return/select)
 *                + state-local sets feeding the dispatch loop
 *   compute      everything else (locals/consts/arith actually computing guest values)
 *
 * Usage:
 *   bun tools/internal/wat-blockmap.ts logs/debug/mod0.flat.wat
 *     [--top N]            top-N blocks by op count (default 12)
 *     [--csv out.csv]      per-block dump for spreadsheet cross-checks
 *     [--exec-ins-avg 3.4] exec-weighted avg guest ins/block from trace2 — prints the
 *                          fixed-share estimate for a block of that dynamic length
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

// global_pointers.rs address map (vendor/v86/src/rust/cpu/global_pointers.rs)
const REG32_LO = 64, REG32_HI = 96;
const LAZY_LO = 96, LAZY_HI = 124; // last_op_size 96, flags_changed 100, last_op1 104, state_flags 108, last_result 112, flags 120
const EIP_ADDRS = new Set([556, 560]);
const CPUSTATE_HI = 2048; // anything below this that isn't classified above
// Module-instance constants (stable across dumps of one boot; auto-detected below)
let STAT_ARRAY_LO = 26_000_000, STAT_ARRAY_HI = 27_000_000; // refined from observed i64 inc addrs
let TLB_OFFSET = 21_962_024; // load offset=<tlb_data base>
let MEM8_BASE = 27_529_216; // i32.const <mem8>; ... i32.add

type Bucket =
  | "counter" | "stats" | "lazyflags" | "eip" | "regfile" | "cpustate"
  | "memcheck" | "guestmem" | "slowglue" | "dispatch" | "edge" | "compute";

const BUCKETS: Bucket[] = [
  "counter", "stats", "lazyflags", "eip", "regfile", "cpustate",
  "memcheck", "guestmem", "slowglue", "dispatch", "edge", "compute",
];

interface Op { op: string; arg: string; line: number }

interface Block {
  index: number;
  startLine: number;
  guestIns: number;      // sum of IC bumps inside the block segment
  icBumps: number;       // 1 normally; 2 for cond-jump tails (fallthrough re-bump)
  ops: number;           // production ops (stats excluded)
  buckets: Record<Bucket, number>;
}

function parse(file: string): { ops: Op[]; importName: Map<number, string> } {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const importName = new Map<number, string>();
  const importRe = /\(import\s+"[^"]*"\s+"([^"]+)"\s+\(func\s+\(;(\d+);\)/;
  const ops: Op[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const imp = importRe.exec(line);
    if (imp) { importName.set(Number(imp[2]), imp[1]); continue; }
    if (line.startsWith("(")) continue;
    const sp = line.indexOf(" ");
    const op = sp < 0 ? line : line.slice(0, sp);
    if (!op || op === ")") continue;
    ops.push({ op, arg: sp < 0 ? "" : line.slice(sp + 1), line: i + 1 });
  }
  return { ops, importName };
}

// Find the IC local: the local X maximizing occurrences of
//   local.get X / i32.const N / i32.add / local.set X
function findIcLocal(ops: Op[]): number {
  const counts = new Map<number, number>();
  for (let i = 0; i + 3 < ops.length; i++) {
    if (
      ops[i].op === "local.get" &&
      ops[i + 1].op === "i32.const" &&
      ops[i + 2].op === "i32.add" &&
      ops[i + 3].op === "local.set" &&
      ops[i].arg === ops[i + 3].arg
    ) {
      const x = Number(ops[i].arg);
      counts.set(x, (counts.get(x) ?? 0) + 1);
    }
  }
  let best = -1, bestN = 0;
  for (const [x, n] of counts) if (n > bestN) { best = x; bestN = n; }
  return best;
}

function classify(ops: Op[], importName: Map<number, string>, icLocal: number) {
  const isSlowCall = (idx: number) => {
    const n = importName.get(idx) ?? "";
    return /^(safe_(read|write|read_write)\w*_slow_jit|get_phys_eip_slow_jit|trigger_fault_end_jit|fastmem_deopt_jit_unit)$/.test(n);
  };
  const isDispatchCall = (idx: number) => /^jit_find_cache_entry/.test(importName.get(idx) ?? "");

  // auto-detect stat-array address band from i64 inc idiom: const A / const A / i64.load / i64.const 1 / i64.add / i64.store
  for (let i = 0; i + 5 < ops.length; i++) {
    if (ops[i].op === "i32.const" && ops[i + 1].op === "i32.const" && ops[i].arg === ops[i + 1].arg &&
        ops[i + 2].op === "i64.load" && ops[i + 3].op === "i64.const" && ops[i + 4].op === "i64.add" && ops[i + 5].op === "i64.store") {
      const a = Number(ops[i].arg);
      if (a > CPUSTATE_HI) { STAT_ARRAY_LO = Math.min(STAT_ARRAY_LO, a); STAT_ARRAY_HI = Math.max(STAT_ARRAY_HI, a + 8); }
    }
  }

  const tags: Bucket[] = new Array(ops.length).fill("compute");
  const tag = (i: number, b: Bucket) => { tags[i] = b; };
  const tagRange = (lo: number, hi: number, b: Bucket) => { for (let i = lo; i <= hi; i++) tags[i] = b; };

  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];

    // 1) IC bump quad
    if (
      o.op === "local.get" && Number(o.arg) === icLocal &&
      ops[i + 1]?.op === "i32.const" && ops[i + 2]?.op === "i32.add" &&
      ops[i + 3]?.op === "local.set" && Number(ops[i + 3].arg) === icLocal
    ) { tagRange(i, i + 3, "counter"); i += 3; continue; }

    // 2) stats sextet
    if (
      o.op === "i32.const" && ops[i + 1]?.op === "i32.const" && o.arg === ops[i + 1].arg &&
      ops[i + 2]?.op === "i64.load" && ops[i + 3]?.op === "i64.const" &&
      ops[i + 4]?.op === "i64.add" && ops[i + 5]?.op === "i64.store" &&
      Number(o.arg) >= STAT_ARRAY_LO && Number(o.arg) < STAT_ARRAY_HI
    ) { tagRange(i, i + 5, "stats"); i += 5; continue; }

    // 3) const-addressed CPU-state access: i32.const A ... (load|store) consuming it.
    if (o.op === "i32.const") {
      const a = Number(o.arg);
      const nxt = ops[i + 1]?.op ?? "";
      const isLoad = /\.(load)/.test(nxt);
      // direct load:  const A / load        → 2 ops
      if (isLoad && a < CPUSTATE_HI) {
        const b: Bucket =
          a >= REG32_LO && a < REG32_HI ? "regfile" :
          a >= LAZY_LO && a < LAZY_HI ? "lazyflags" :
          EIP_ADDRS.has(a) ? "eip" : "cpustate";
        tagRange(i, i + 1, b); i += 1; continue;
      }
      // store with value computed after addr: const A / <valueexpr...> / store — handle
      // the two dominant literal shapes: (const A, local.get V, store) and
      // (const A, const V, store) and the RMW shape (const A, const A, load, ..., store).
      if (a < CPUSTATE_HI) {
        const b: Bucket =
          a >= REG32_LO && a < REG32_HI ? "regfile" :
          a >= LAZY_LO && a < LAZY_HI ? "lazyflags" :
          EIP_ADDRS.has(a) ? "eip" : "cpustate";
        // scan a short window for the consuming store at same nesting delta 0
        let depth = 0;
        for (let j = i + 1; j < Math.min(i + 12, ops.length); j++) {
          const oj = ops[j].op;
          if (oj === "block" || oj === "loop" || oj === "if") depth++;
          else if (oj === "end") { if (depth === 0) break; depth--; }
          else if (depth === 0 && /\.store/.test(oj)) { tag(i, b); tag(j, b); break; }
          else if (depth === 0 && /\.load/.test(oj) && ops[j - 1]?.op === "i32.const" && Number(ops[j - 1].arg) === a) { tag(j, b); tag(j - 1, b); }
        }
        if (tags[i] === b) continue;
      }
      // mem8 base add → guest RAM access
      if (a === MEM8_BASE) { tag(i, "guestmem"); continue; }
    }

    // 4) TLB check load (write path): load with offset=TLB base
    if (/\.load/.test(o.op) && o.arg.includes(`offset=${TLB_OFFSET}`)) {
      // tag the canonical check window: >>12 <<2 load &mask ==1 [pagecross] br_if
      tagRange(Math.max(0, i - 4), Math.min(ops.length - 1, i + 10), "memcheck");
      continue;
    }

    // 5) fastmem read acceptance constants (split-range compares)
    if (o.op === "i32.const" && ["1048576", "1073741820", "587202556", "603979776"].includes(o.arg)) {
      const j = ops[i + 1]?.op ?? "";
      if (/^i32\.(ge_u|le_u|lt_u|gt_u)$/.test(j)) { tag(i, "memcheck"); tag(i + 1, "memcheck"); continue; }
    }

    // 6) calls
    if (o.op === "call") {
      const idx = Number(o.arg.split(/\s/)[0]);
      if (isSlowCall(idx)) {
        tagRange(Math.max(0, i - 2), Math.min(ops.length - 1, i + 3), "slowglue");
      } else if (isDispatchCall(idx)) {
        tagRange(Math.max(0, i - 2), Math.min(ops.length - 1, i + 3), "dispatch");
      }
      continue;
    }

    // 7) control
    if (/^(block|loop|if|else|end|br|br_if|br_table|return|unreachable|select|drop|nop)$/.test(o.op)) {
      if (tags[i] === "compute") tag(i, "edge");
      continue;
    }

    // 8) computed guest memory access (load/store not const-addressed, not TLB):
    if (/\.(load|store)/.test(o.op) && tags[i] === "compute") {
      // reached with a computed address (mem8+addr or (entry&~fff)^addr)
      tag(i, "guestmem");
      continue;
    }
  }
  return tags;
}

function segment(ops: Op[], tags: Bucket[], icLocal: number): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (let i = 0; i < ops.length; i++) {
    const isBump =
      ops[i].op === "local.get" && Number(ops[i].arg) === icLocal &&
      ops[i + 1]?.op === "i32.const" && ops[i + 2]?.op === "i32.add" &&
      ops[i + 3]?.op === "local.set" && Number(ops[i + 3].arg) === icLocal;
    // A bump immediately following a previous segment's ops starts a NEW block —
    // except the conditional-jump fallthrough tail (bump with no intervening real op
    // since the last br_if... simplest robust rule: a bump starts a new block unless
    // the previous non-edge/non-stats op is < 8 ops away AND the previous block has
    // seen a br_if after its first bump. Keep it simple: new block per bump, then
    // merge tails (blocks whose segment contains only counter+stats+edge ops).
    if (isBump) {
      if (cur) blocks.push(cur);
      cur = {
        index: blocks.length, startLine: ops[i].line,
        guestIns: Number(ops[i + 1].arg), icBumps: 1,
        ops: 0, buckets: Object.fromEntries(BUCKETS.map(b => [b, 0])) as Record<Bucket, number>,
      };
    }
    if (cur) {
      cur.buckets[tags[i]]++;
      if (tags[i] !== "stats") cur.ops++;
    }
  }
  if (cur) blocks.push(cur);

  // merge pure-tail segments (cond-jump fallthrough: counter+edge only) into predecessor
  const merged: Block[] = [];
  for (const b of blocks) {
    const nonFixed = b.ops - b.buckets.counter - b.buckets.edge - b.buckets.eip - b.buckets.dispatch;
    const prev = merged[merged.length - 1];
    if (prev && nonFixed <= 2 && b.ops <= 14) {
      prev.guestIns += b.guestIns; prev.icBumps += b.icBumps ?? 1; prev.ops += b.ops;
      for (const k of BUCKETS) prev.buckets[k] += b.buckets[k];
    } else merged.push(b);
  }
  merged.forEach((b, i) => (b.index = i));
  return merged;
}

function pct(n: number, d: number) { return d ? ((100 * n) / d).toFixed(1).padStart(5) + "%" : "    -"; }

function main() {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let top = 12, csv = "", execInsAvg = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--top") top = Number(argv[++i]) || 12;
    else if (argv[i] === "--csv") csv = argv[++i];
    else if (argv[i] === "--exec-ins-avg") execInsAvg = Number(argv[++i]) || 0;
    else files.push(argv[i]);
  }
  if (!files.length) files.push("logs/debug/mod0.flat.wat");

  for (const file of files) {
    const { ops, importName } = parse(file);
    const icLocal = findIcLocal(ops);
    if (icLocal < 0) { console.error(`${file}: no IC-local pattern found`); continue; }
    const tags = classify(ops, importName, icLocal);
    const blocks = segment(ops, tags, icLocal);

    const tot = Object.fromEntries(BUCKETS.map(b => [b, 0])) as Record<Bucket, number>;
    let totalOps = 0, prodOps = 0, guestIns = 0;
    for (const b of blocks) {
      for (const k of BUCKETS) tot[k] += b.buckets[k];
      guestIns += b.guestIns;
    }
    totalOps = BUCKETS.reduce((s, k) => s + tot[k], 0);
    prodOps = totalOps - tot.stats;

    console.log(`\n=== ${basename(file)} ===  ic-local=$${icLocal}`);
    console.log(`blocks: ${blocks.length}   guest ins (static): ${guestIns}   wasm ops: ${totalOps.toLocaleString()} (prod ${prodOps.toLocaleString()}, stats ${tot.stats.toLocaleString()})`);
    console.log(`static prod expansion: ${(prodOps / Math.max(1, guestIns)).toFixed(1)} ops/guest-ins   avg block: ${(guestIns / blocks.length).toFixed(1)} ins, ${(prodOps / blocks.length).toFixed(0)} prod ops`);

    console.log("\nbucket           ops      %prod   nature");
    const NATURE: Record<Bucket, string> = {
      counter: "per-block fixed (mergeable)",
      stats: "dump-only (prod-absent)",
      lazyflags: "per-ALU-op tuple write + jcc re-derive (forwardable)",
      eip: "boundary/fault bookkeeping (batchable)",
      regfile: "reg32 file traffic (block-scope cacheable)",
      cpustate: "segments/state misc",
      memcheck: "TLB write checks + read range checks",
      guestmem: "actual RAM access + xlat",
      slowglue: "slow-path call sites",
      dispatch: "find_cache_entry glue",
      edge: "control structure + branches",
      compute: "real guest compute",
    };
    for (const k of BUCKETS) {
      if (k === "stats") continue;
      console.log(`  ${k.padEnd(12)} ${String(tot[k]).padStart(7)}   ${pct(tot[k], prodOps)}   ${NATURE[k]}`);
    }

    // G-M1 view: per-block FIXED = counter + eip + dispatch + edge share attributable
    // to block plumbing. Edge ops include real branch logic; report both bounds.
    const fixedLo = tot.counter + tot.eip + tot.dispatch;              // certainly fixed
    const fixedHi = fixedLo + tot.edge;                                 // upper bound (all control)
    console.log(`\nG-M1 fixed-cost share (static): ${pct(fixedLo, prodOps)} .. ${pct(fixedHi, prodOps)}  (counter+eip+dispatch .. +edge)`);
    const fwd = tot.regfile + tot.lazyflags + tot.eip + tot.counter;
    console.log(`value-motion attackable by forwarding pass (regfile+lazyflags+eip+counter): ${pct(fwd, prodOps)}`);

    if (execInsAvg > 0) {
      // model a dynamically-average block: fixed per block + per-ins template tax
      const perBlockFixed = (tot.counter + tot.eip + tot.dispatch + tot.edge * 0.5) / blocks.length;
      const perInsTax = (prodOps - perBlockFixed * blocks.length) / Math.max(1, guestIns);
      const dynOps = perBlockFixed + perInsTax * execInsAvg;
      console.log(`\nexec-weighted model @ ${execInsAvg} ins/block: fixed ${perBlockFixed.toFixed(1)} + ${perInsTax.toFixed(1)}/ins × ${execInsAvg} = ${dynOps.toFixed(0)} ops/block-exec`);
      console.log(`→ dynamic fixed share ≈ ${pct(perBlockFixed, dynOps)}`);
    }

    const byOps = [...blocks].sort((a, b) => b.ops - a.ops).slice(0, top);
    console.log(`\ntop ${top} blocks by prod ops:  (line, ins, ops, fixed%, top buckets)`);
    for (const b of byOps) {
      const f = b.buckets.counter + b.buckets.eip + b.buckets.dispatch;
      const tops = BUCKETS.filter(k => k !== "stats").sort((x, y) => b.buckets[y] - b.buckets[x]).slice(0, 3)
        .map(k => `${k}:${b.buckets[k]}`).join(" ");
      console.log(`  L${String(b.startLine).padStart(6)}  ins=${String(b.guestIns).padStart(3)}  ops=${String(b.ops).padStart(5)}  fixed=${pct(f, b.ops)}  ${tops}`);
    }

    // size histogram (static)
    const hist = new Map<string, number>();
    for (const b of blocks) {
      const bucket = b.guestIns <= 2 ? "1-2" : b.guestIns <= 4 ? "3-4" : b.guestIns <= 8 ? "5-8" : b.guestIns <= 16 ? "9-16" : "17+";
      hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
    }
    console.log(`\nblock-size histogram (guest ins): ${JSON.stringify(Object.fromEntries(hist))}`);

    if (csv) {
      const rows = ["index,line,ins,ops," + BUCKETS.join(",")];
      for (const b of blocks) rows.push([b.index, b.startLine, b.guestIns, b.ops, ...BUCKETS.map(k => b.buckets[k])].join(","));
      writeFileSync(csv, rows.join("\n"));
      console.log(`csv → ${csv}`);
    }
  }
}

main();
