# bench-v86 — headless CPU benchmark for v86 engines

Runs upstream v86's own benchmark recipe (`tests/benchmark/arch-bytemark.js`: Arch
Linux guest + BYTEmark/nbench over serial) fully headless in Node, against any v86
engine build — upstream stock or the BottleShip fork — with per-flag JIT ablation.

Purpose: reproducible, HLE-free numbers for the lossless JIT work (upstream-relevant),
kept strictly separate from accuracy-tradeoff modes (relaxed x87).

## One-time setup

```sh
node tools/bench-v86/fetch-images.mjs        # arch_state + fs.json (~21 MB)
cd tools/bench-v86/engines && npm pack v86@latest && tar xzf v86-*.tgz && mv package stock
```

The 9p filesystem chunks lazy-mirror from https://i.copy.sh/arch/ on first use into
`images/arch/` (a benchmark run touches ~100–200 MB of the 6.3 GB tree, once).
After the first run everything is offline.

## Run

```sh
# single run, all 10 nbench tests
node tools/bench-v86/run-bytemark.mjs --engine vendor/v86 --label fork --flags "5=1,9=1,10=1,11=1,12=1,13=1,18=1"
node tools/bench-v86/run-bytemark.mjs --engine tools/bench-v86/engines/stock --label stock

# full matrix (medians of N runs + summary.md)
node tools/bench-v86/bench-matrix.mjs --runs 3 --configs stock,fork-off,fork-lossless
node tools/bench-v86/bench-matrix.mjs --runs 1 --configs abl-deadflag,abl-fastmem-r,abl-x87locals,abl-pushrun,abl-retchain,abl-retspec,abl-fastmem-w,abl-flaglocals,abl-tier2
```

## Methodology (why it's shaped this way)

- **Fresh `--boot fs` (default), not state resume.** nbench times itself with the
  *guest* clock. The published `arch_state` images carry a `tsc_khz` calibrated on
  the engine that saved them; an engine with a different TSC rate resumes with a
  proportionally wrong guest clock (the fork's 2^32 Hz TSC vs upstream's 1 GHz ⇒
  guest time ×4.3). A fresh boot recalibrates TSC against the running engine, so
  guest-timed scores are comparable across engines by construction.
- **Clock sanity gate.** Before the bench, the runner compares a guest `date` delta
  against host wall clock over 4 s and records the ratio in the result JSON. A >3%
  skew prints a loud warning — treat those scores as invalid.
- **Flags are applied at `emulator-started`,** before the kernel compiles anything,
  so the whole run uses one codegen configuration (`set_jit_config`, fork only).
- **Ablation configs include features that are OFF in BottleShip production**
  (fastmem writes, flag locals, tier-2). Our "no win" verdicts came from the
  Windows-game workload; a Linux/nbench workload may value them differently —
  that's exactly the upstream-relevant question.
- **Relaxed x87 (`fork-relaxed`) is an accuracy tradeoff** (raw f64 in F80 slots).
  It is never part of the lossless comparison; it exists as a separate labelled
  config only.

## Flag index map (fork `set_jit_config`)

| idx | feature | BottleShip prod |
|-----|---------|-----------------|
| 5   | cross-block dead-flag elision | on |
| 9   | fastmem reads | on |
| 10  | x87 stack-top locals | on |
| 11  | push-run coalescing | on |
| 12  | RET dynamic chaining | on |
| 13  | RET-target speculation | on |
| 15  | tier-2 hotness threshold (0 = off) | off |
| 17  | tier-2 max pages | (8) |
| 18  | fastmem read split-range | on |
| 19  | fastmem write map | off |
| 21  | arithmetic-flag locals | off |
| 22  | wasm branch hints (bitmask of guard sites) | off |
| 23  | branch-hint offset fuzz (verifier probe) | off |
| 24  | turbo-memory clamp reads (`exp/turbo-memory` only) | off |

Results land in `results/` (gitignored) as JSON per run + `summary.md` per matrix.
