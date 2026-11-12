# func-ceiling — how fast can a "function tier" be? (x86 → Wasm, one Wasm function per guest function)

A standalone translator for the flat-pair lab PEs, running WITHOUT v86: guest function = Wasm
function, registers in locals, real Wasm `call`/`return`, structured control flow, guest stack in
guest memory. Every obligation a sound engine tier would carry is a translator switch, so one tool
produces the whole ladder from the free ceiling (F0) to the sound shape (S). Same PE, same plan,
same slope protocol and the same checksums as the v86 / Emscripten / native arms of
`../flat-pair` (that lab's README describes the protocol).

```
flat-pair/out/<wl>/flat.exe ──► discover.mjs (functions, CFGs, jump tables) ──► translate.mjs (rung switches) ──► out/<wl>/<rung>.wasm
                                                                                                  run-fc.mjs: PE image in linear memory, ports = imports
```

## Commands (PowerShell, from this directory)

```powershell
# 0. integer-only workloads for every arm (generator parameter x87:0; additive, default unchanged)
cd ../flat-pair; node build.mjs "tight-int=tight,x87:0" "medium-int=medium,x87:0" "flat-int=flat,x87:0" "flat-int-pad3=flat,x87:0,coldPad:3"; cd ../func-ceiling
# 1. decoder vs an independent disassembler (dumpbin) + discovery statistics
node check-decoder.mjs ../flat-pair/out/flat-int/flat.exe
# 2. build the rungs (+ run-time discovery loop, + executed-only twins from a profile run)
node build-fc.mjs --workloads tight-int,medium-int,flat-int --variants F0,F0b,RC,RT,LZ,S,Sb,F0G,F0Z,RTG,SnoRT,S-sf --exec
node build-fc.mjs --workloads flat-int-pad3 --variants F0,S --exec
node build-fc.mjs --workloads tight,medium,flat --variants F0,RT,LZ,S          # stage 2: x87
# 3. oracle can fail: corrupt one ALU result / one pushed return address / exhaust the budget
node oracle-negative.mjs --wl flat-int --variant S --n 3
node translate.mjs --exe ../flat-pair/out/medium-int/flat.exe --variant S --mutate-ret 4273e0 --out out/dev/negret.wasm
node run-fc.mjs --wasm out/dev/negret.wasm --exe ../flat-pair/out/medium-int/flat.exe     # -> EXIT_RETMISMATCH
node run-fc.mjs --wasm out/medium-int/S.wasm --exe ../flat-pair/out/medium-int/flat.exe --budget 100000   # -> EXIT_BUDGET
# 4. measure (pinned to logical cores 12-15, ABBA, A/A arms) and tabulate
powershell -File campaign.ps1
node summarize-fc.mjs out/results/final-*.json
```

Single run: `node [--no-liftoff --experimental-wasm-branch-hinting] run-fc.mjs --wasm out/flat-int/S.wasm
--exe ../flat-pair/out/flat-int/flat.exe --warm 4 --lo 20000 --hi 80000 --reps 4`.
Arm spec in `bench-fc.mjs`: everything `../flat-pair/bench.mjs` accepts, plus `fc:<rung>[@tier][#label]`.
`@tfhint` = `--no-liftoff --experimental-wasm-branch-hinting`, `@hint` = hints only (added to
`flat-pair/bench.mjs` V8_TIERS, additively). Node 22 / V8 12.4 has wasm branch hints OFF by
default; v86 emits them (they ship in Chrome), so every Wasm arm gets the same flags.

## The rungs (translator switches, cumulative)

| rung | what is added |
|---|---|
| **F0** | registers = params/locals, memory = `load/store offset=MEMBASE` (no check), no counter, RET = plain `return`, flags only where consumed (reaching definitions; fused compare+branch) |
| **RC** | +RET-check: caller compares the popped return address with the constant it pushed; mismatch or callee exit returns SENTINEL and propagates up; depth cap 48 (param); checked indirect-call table (slot -> guest entry); checked jump-table entries |
| **RT** | +retired: exact budget (per block, before calls / I/O), checked on loop back edges and before calls; budget exit = observation point (state materialised, exact count) |
| **LZ** | +lazy flags: v86's 5 words (`last_op1, last_result, last_op_size, flags_changed, flags`, formulas from `misc_instr.rs`/`arith.rs`) updated by EVERY flag instruction and carried across calls; fused evaluation only when the producer is in the same block (as v86), else the generic getters |
| **S** | +mem-guard: every guest access (incl. push/pop/call/ret) through the inline TLB probe of `gen_safe_read`/`gen_safe_write` (same masks, same `(entry & ~0xFFF) ^ addr`), real 4 MiB TLB table with identity entries, slow-path fill function, shared fault exit (v86's `exit_with_fault_label`), branch hints like v86 |
| Sb / F0b | same as S / F0 with ABI (b): state in Wasm globals, stores only of dirty slots, lazy loads (validity dataflow with edge fix-ups) |
| F0G, F0Z, RTG, SnoRT | single-obligation ablations (guard only, lazy only, S without lazy, S without retired) |
| S-sf | ceiling ablation, NOT sound as built: S without probes on esp/ebp-based accesses (upper bound of a once-per-frame stack guard) |
| S-exec, F0-exec | executed-only: blocks a profile run never executed become side exits, never-executed functions get no code |

## Automatic, general discovery (no symbols, no map, no generator knowledge)

Entries = PE entry + recursive descent over direct calls + code addresses found in non-executable
sections (vtables, pointer tables; the lab PEs are `/FIXED`, so there are no relocations — a 4-aligned
scan validated by decoding) + materialised immediates (`push/mov imm32`) + indirect targets observed
at run time (a checked miss exits with the target; `build-fc.mjs` rebuilds until none). Jump tables
by shape `jmp [T + r*4]` with the bound from `and r, imm` / `cmp r, imm ; ja|jae`. Tail `jmp` to an
entry = `return_call`. Stackifier = Ramsey, "Beyond Relooper" (dominator tree, merge nodes, loop
headers); irreducible functions would exit (none occurred).

## Validation

* checksums of every run of every arm agree in every series (v86, em, native, all rungs);
* decoder lengths vs dumpbin: 0 mismatches over 327 439 (flat-int) / 339 017 (flat) reachable
  instructions (non-boundaries are dumpbin desyncing after in-text jump tables);
* retired count of RT/LZ/S equals v86's instruction counter (medium-int lo/hi 1 020 985 / 4 046 644
  in both; flat-int slope 1387.70917 vs 1387.70908 ins/step — v86's counter is a block credit);
* negative controls: one ALU result ^1 diverges (flat-int S 3/3, flat S 2/2, medium-int F0 3/3,
  tight-int S 2/3 — the third site does not reach the checksum); a wrong pushed return address
  runs "ok" under F0 and exits `RETMISMATCH` at the right EIP under S; `--budget 100000` exits
  `BUDGET` at the same EIP with the same count (100 008) in ABI (a) and (b);
* the oracle caught a real bug while writing stage 2: the DC/DE `fsub/fsubr` operand order.

## Known gaps (what S does NOT carry yet — read the S number as a lower bound on cost)

Exits materialise state but nothing RESUMES at an arbitrary EIP (no fallback engine here); no
translation invalidation on code-page writes (they take the slow path and are counted, 0 here);
`#DE`/quotient overflow not checked; `fnstsw` AL (sticky exception bits) is 0; FPU depth must be 0
at calls/returns (true for this workload: 0 unsupported functions); v86's guard groups / push-run
coalescing are not reproduced (per-access probes only); budget is an i32 local (runs > 2^31
instructions exit — keep `warm` <= 12 on flat). Lua is not covered (see report): 45 unrecognised
indirect jumps, `rep stos/movs`, more x87/64-bit forms.

## Files

`wasm.mjs` encoder (multi-value, tail calls, branch-hint section) · `x86dec.mjs` decoder (integer
subset + x87 + IN/OUT/HLT) · `discover.mjs` PE + discovery + CFG · `translate.mjs` rungs, stackifier,
lowering, flags, guards, ABIs, x87 · `run-fc.mjs` runner · `build-fc.mjs` builds + run-time
discovery + profile · `bench-fc.mjs` ABBA bench · `summarize-fc.mjs` tables · `check-decoder.mjs`
dumpbin oracle · `oracle-negative.mjs` mutation control · `campaign.ps1` the measurements.
