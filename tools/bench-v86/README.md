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
# single run, all 10 nbench tests. Take the flag string from the matrix rather than pasting
# one: `--configs shipping --list` prints exactly what the shared production list applies.
node tools/bench-v86/run-bytemark.mjs --engine vendor/v86 --label shipping \
  --flags "$(node tools/bench-v86/bench-matrix.mjs --list --configs shipping | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).flags')" --relaxed 1
node tools/bench-v86/run-bytemark.mjs --engine tools/bench-v86/engines/stock --label stock

# inspect the shipping-minus-one contour without launching a benchmark
node tools/bench-v86/bench-matrix.mjs --list
node tools/bench-v86/bench-matrix.mjs --self-test

# full shipping marginal matrix (medians of N runs + summary.md)
node tools/bench-v86/bench-matrix.mjs --runs 3 \
  --configs shipping,shipping-minus-deadflag,shipping-minus-pushrun,shipping-minus-retchain,shipping-minus-retspec,shipping-plus-tier2,shipping-minus-branch-hints,shipping-minus-x87-pc-local,reference-all-off
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
- **Flags are applied and read back at `emulator-started`,** before the kernel compiles
  anything. A missing getter or any requested/read-back mismatch aborts the run; the ABI,
  supported mask, request and readback are recorded as provenance in the result JSON.
- **`shipping` is the only keep/drop baseline.** It explicitly applies the current
  production values (including `x87Locals=0`, experimental tier-2 off, tier-2
  page cap `8` for opt-in runs, branch-hint group 0, and relaxed FPU on) using only supported JIT
  indices. Summary percentages are relative to `shipping` whenever it is selected.
- **Every `shipping-minus-*` arm removes exactly one active shipping JIT feature.**
  It preserves every other shipping flag and relaxed-FPU policy, so interactions
  remain in the measurement. These are the marginal numbers used for keep/drop.
- **`reference-all-off` and the `abl-*` arms are diagnostic references, never marginal
  comparisons.** They add features to all-off, which is useful for upstream exploration
  but cannot answer a shipping keep/drop question.
- **All-off means "every feature off at the smallest value the engine still works at",
  not "every index zero".** Several indices are budgets, not switches: a 0 page cap
  compiles nothing, and indices 25/27 are clamped by the setter, so a zero request reads
  back as the clamp and aborts the run on the provenance check. The floors live in
  `tools/jit-config/shipping.mjs` (`MIN_VALID`), each derived from `jit.rs`. For the same
  reason an `abl-*` arm carries its feature's BUDGET at the shipping value — tier-2 over a
  one-page module cap measures the flag, not the feature.
- **One production list, four consumers.** `tools/jit-config/shipping.mjs` is imported by
  this matrix, the AOT oracle arms and the AOT capture job; `bun run
  validate-jit-shipping-config` re-derives it from `jit.rs` plus `PreemptionManager` and
  fails on drift (it is a gate step).
- **No two arms may run the same command line.** A duplicate is one data point wearing two
  names. Legacy CLI names are kept as declared `aliasOf` entries and asserted to be
  identical to what they alias; anything else is refused by `--self-test`.
- **The runner judges what ran, not only what was asked for.** `run-bytemark.mjs` reads
  the live tier-2 threshold and promotion count and REFUSES the run (exit 4, JSON still
  written) when the two disagree in either direction: threshold on with zero promotions
  measured tier-1 code, threshold off with promotions is not the tier-2-off reference.
- **Strict FPU remains a separately labelled policy reference** (`fork-prod-lossless`),
  not a lossless-JIT marginal arm.

## Flag index map (fork `set_jit_config`)

| idx | feature | BottleShip prod |
|-----|---------|-----------------|
| 0–4 | JIT disable/page cap/loop safety/extra BB/block chaining | 0 / 3 / 1 / 250 / 0 |
| 5–8 | dead flags/indirect regions/min share/max pages | 1 / 0 / 5 / 8 |
| 10  | x87 stack-top locals | off (pending representative FP evidence) |
| 11  | push-run coalescing | on |
| 12  | RET dynamic chaining | on |
| 13  | RET-target speculation | on |
| 15  | tier-2 retired-instruction threshold (0 = off) | 0 (experimental opt-in) |
| 14, 16 | baseline/tier-2 RET speculation budgets | 24 / 96 |
| 17  | tier-2 max pages | 8 |
| 19  | fastmem write map | off |
| 20  | chained-entry census | on |
| 21  | arithmetic-flag locals | off |
| 22  | wasm branch hints (bitmask of guard sites) | 1 (group 0) |
| 23  | branch-hint offset fuzz (verifier probe) | off |
| 24  | wrong-entry refusal diagnostic | off |
| 25–27 | RET-cache bits/hash mix/chain-note stride | 9 / 0 / 32 |
| 28  | generated wasm function names | on |
| 29–30 | read-microTLB mode/target-page sentinel | 0 / 0xFFFFF (inert) |
| 31  | block-local x87 precision-control predicate | on |

Index 30's Rust default is `u32::MAX`, but the setter masks its argument to 20 bits
(`jit.rs:6329`), so `0xFFFFF` is that default as the engine can actually store it — asking
for `u32::MAX` reads back as `0xFFFFF` and fails the run's own provenance check.

Results land in `results/` (gitignored) as JSON per run + `summary.md` per matrix.
