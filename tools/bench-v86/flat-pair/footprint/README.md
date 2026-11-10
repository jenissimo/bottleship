# footprint — what the JIT's per-instruction cost slope is made of

Question: under the v86 JIT the cost per guest instruction grows ~7x from `flat-n60` (3 pages) to
`flat` (274 pages); under Emscripten 1.8x. Which of (1) machine-code footprint, (2) TurboFan code
quality in huge functions, (3) data, (4) exit cost explains it?

Everything here is additive to the lab: `gen.mjs` got three opt-in parameters (default output is
byte-identical, checked), the rest are new scripts. Results land in `footprint/out/` (ignored by the lab's `out/` rule;
nothing here is committed). The `func-ceiling` agent independently added `@hint` (same flag) to
`../bench.mjs`; `fp-bench.mjs` registers its own `@bh` so it does not depend on that edit.

## New generator parameters (`../gen.mjs`)

| param | effect | what it isolates |
|---|---|---|
| `subset:K` (+`subsetAfter`, default 4) | the first `subsetAfter` `wl_run` calls (the driver's warm-up) walk all roots, later calls only the first K roots | SAME compiled modules / pages / shape / exit rate, smaller DYNAMIC footprint |
| `coldPad:N` | N never-called functions after every function in emission order (own RNG; kept by `g_cold`) | same compiled Wasm (v86 compiles only from executed entry points), hot code spread over more pages -> more, smaller modules |
| `deadArm:S` | an `if` arm of S statements per function that is compiled (both arms are analysed) but never executed | more compiled bytes at the same executed work |

Built with `node build.mjs "flat-sub1=flat,subset:1" "flat-sub8=flat,subset:8" "flat-sub32=flat,subset:32" "flat-pad1=flat,coldPad:1" "flat-pad3=flat,coldPad:3" "flat-dead6=flat,deadArm:6" "n60-pad8=flat,nfunc:60,coldPad:8" "n60-dead6=flat,nfunc:60,deadArm:6" "n600-dead6=flat,nfunc:600,deadArm:6" "n600-pad3=flat,nfunc:600,coldPad:3"`.

## Scripts

| script | what |
|---|---|
| `run-fp.mjs` | `../run-v86.mjs` + `--dump` (every generated module, length-prefixed) + mark times on the `performance.now()` clock + RSS |
| `code-size.mjs` | parses `node --print-wasm-code` (release Node prints disassembly): TurboFan/Liftoff bytes of the JIT's modules (`g<eip>@t<slot>`, last record per name) and a static x64 instruction mix (stack-slot spill/fill, reg-reg moves, memory, branches, calls) |
| `wasm-classes.mjs` | `tools/aot/module-stats.mjs` over a dump: Wasm op groups, CPU-state fields touched, helper calls |
| `prof-split.mjs` | `--prof` ticks (Windows: ~15.6 ms) mapped through `--print-wasm-code` address ranges: JIT modules vs v86 runtime functions vs rest, after the warm-up mark only |
| `fp-bench.mjs` | ABBA ACROSS workloads (cells `<workload>:<arm>`), A/A cell, checksum agreement; adds V8 tier `@bh` = `--experimental-wasm-branch-hinting` |
| `char-fp.mjs` | `../characterize.mjs` (exits/1k instr, classes, compiled share) with results kept here |

## Commands (as run)

```powershell
# machine-code size + static mix (not timing; pinned to the agent's cores)
cmd /c "node --print-wasm-code footprint/run-fp.mjs --exe out/flat/flat.exe --warm 4 --lo 20000 --hi 80000 --reps 2 --dump footprint/out/flat.bin | node footprint/code-size.mjs --tag flat --out footprint/out/code-flat.json"
#   same for flat-n60, flat-n600, flat-dfs, flat-s8, the pad/dead variants, and --flags 1=1 / 1=8 / 12=0,13=0
node footprint/wasm-classes.mjs footprint/out/flat.bin --json footprint/out/wasm-classes-flat.json
# time split (ticks after warm-up)
cmd /c "node --prof --no-logfile-per-isolate --logfile=footprint/out/prof-flat.log --print-wasm-code footprint/run-fp.mjs --exe out/flat/flat.exe --warm 4 --lo 20000 --hi 300000 --reps 2 | node footprint/prof-split.mjs --log footprint/out/prof-flat.log --tag flat --out footprint/out/prof-flat.json"
#   small workloads: --hi 80000 --reps 70 (enough ticks)
# exits per 1k instructions
node footprint/char-fp.mjs --affinity 0xF00000 --tag char-fp --workloads "flat-sub1,flat-sub8,flat-sub32,flat,flat-pad1,flat-pad3,flat-dead6,n60-pad8,n60-dead6,flat-n60,n600-dead6,n600-pad3,flat-n600"
# timing (CCD1 = 0xF00000, CCD0 short series = 0xF00)
node footprint/fp-bench.mjs --affinity 0xF00000 --rounds 4 --tag fp-sub-ccd1 --cells "flat:v86 flat-sub32:v86 flat-sub8:v86 flat-sub1:v86 flat:v86#aa flat-n600:v86 flat-n60:v86 flat:em flat-sub8:em flat-sub1:em"
node footprint/fp-bench.mjs --affinity 0xF00000 --rounds 4 --tag fp-pad-ccd1 --cells "flat:v86 flat-pad1:v86 flat-pad3:v86 flat-dead6:v86 flat:v86#aa flat-n60:v86 n60-pad8:v86 n60-dead6:v86 flat-n600:v86 n600-pad3:v86 n600-dead6:v86 flat:em flat-dead6:em"
node footprint/fp-bench.mjs --affinity 0xF00 --rounds 2 --tag fp-ccd0 --cells "flat:v86 flat-sub1:v86 flat-sub8:v86 flat-pad3:v86 flat-dead6:v86 flat:v86#aa flat-n600:v86 flat-n60:v86 flat:em flat-sub1:em"
node footprint/fp-bench.mjs --affinity 0xF00 --rounds 3 --tag fp-ret-ccd0 --cells "flat:v86 flat:v86[12=0,13=0] flat:v86#aa flat-sub1:v86 flat-sub1:v86[12=0,13=0] flat-n60:v86 flat-n60:v86[12=0,13=0]"
node footprint/fp-bench.mjs --affinity 0xF00 --rounds 3 --tag fp-bh-ccd0 --cells "flat:v86 flat:v86@bh flat:v86#aa flat-sub1:v86 flat-sub1:v86@bh flat-n600:v86 flat-n600:v86@bh flat-n60:v86 flat-n60:v86@bh"
node footprint/fp-bench.mjs --affinity 0xF00 --rounds 3 --tag fp-bh2-ccd0 --cells "flat:v86@bh flat-sub1:v86@bh flat-sub8:v86@bh flat-dfs:v86@bh flat:v86[12=0,13=0]@bh flat-pad3:v86@bh flat-dead6:v86@bh flat-n60:v86@bh flat:v86@bh#aa"
```

## Findings (2026-11-10; numbers in the agent report, raw JSON in out/ and out/results/)

* **Lab caveat:** Node 22.14 does not honour the Wasm branch-hints section by default
  (`--experimental-wasm-branch-hinting` is off); Chrome does. Without it TurboFan keeps every
  slow-path call block INLINE in the hot stream (seen in the disassembly). With `@bh`: n60 −8.5 %,
  n600 −32 %, flat −24…−29 % (CCD0, 3/3). Lab numbers taken without `@bh` overstate the JIT
  and, above all, its slope.
* Shape is constant: spill/fill 21–23 %, reg-reg moves 12–15 % of x64 instructions, 4.0–4.3 B per
  instruction, 1.5–1.65 B machine code per Wasm byte, from n60 to s8 and for MAX_PAGES 1/3/8.
* `subset`: same 106 modules, same 41–43 exits/1k: 2.4 -> 7.4 -> 10.0 ns/instr (sub1/sub8/flat, CCD0).
* `deadArm`: +20 % compiled machine code, never executed: +1.5 % (CCD0), so it is TOUCHED code.
* `coldPad` / MAX_PAGES=1: fewer bytes, more modules: +11 % (n600-pad3, CCD1, clean), +16 % (flat).
* Time split (ticks): v86 runtime (cycle_internal + jit_find_cache_entry_for_dynamic_chaining)
  ≈ 7 % (n60) / 16–20 % (sub1…flat); per exit ≈ 5 -> 11 -> 45 ns (n60 -> sub1 -> flat).
* idx 12/13 (RET chaining + speculation) off: −12 % machine code; flat −10 % (3/3), n60 +2.4 % (3/3).
