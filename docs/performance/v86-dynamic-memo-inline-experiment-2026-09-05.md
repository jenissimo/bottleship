# Inline dynamic memo-hit experiment

Status: isolated candidate, not shipped. This follows the negative NFSU direction
of the [DOD-only experiment](v86-dynamic-chain-inline-experiment-2026-09-05.md).
It tests a different mechanism; cache locality is a hypothesis, not a proven cause
of that earlier result.

`prepare-dynamic-chain.mjs --memo` retains the compact RET memo and emits its hit
probe in generated code. It checks EIP, state flags, nonnegative packed target,
and the current invalidation epoch, with the existing runtime hash/mask options.
Budget/HLT checks precede lookup. On misses, the original Rust resolver fills the
cache; it receives zero retired credit because the activation was already credited.
Wrong-entry verification uses the original helper. Stats-enabled generated modules
also retain the original helper path; their timing cannot measure this optimization.

Manifest: `C:/Users/jenis/AppData/Local/Temp/v86-dynamic-chain-4stARz/manifest.json`.
Rebuilt A exactly matches shipping 3a50…; candidate SHA256 is
`20982e0adaaa664df2c47a527894fc2fc9ca477dd2bcef3afe5d35d519f013c8`.
The emitter body is retained in `tools/bench-v86/experiments/dynamic-chain-memo-body.rs`.

## Checks so far

- Four JIT-alive/accounting cases pass (two arms, stats ON/OFF).
- 56 emitted-boundary cases match: two arms × tier2 ON/OFF × 14 cases, including
  cold fallback, mixed hash, smaller memo, budget/HLT, TLB flush and target-code
  invalidation. Raw rows: snapshot `emitted-boundaries.json`.
- `--observe-helper` compiles with stats OFF and then enables only the runtime
  Rust counters without recompiling. The ordinary hit executes one chain in both
  arms, but records one helper hit in A and zero in C. Cold and verifier cases
  record one in each arm. This proves the new emitted path is exercised; it is
  deliberately not a complete dispatch census or a timed measurement.

Remaining correctness scope includes table-slot recycling, mutation evidence for
the guards, and broader option combinations. These checks do not establish full
ISA/paging correctness or justify integration alone.

## Fixed-work direction

50 million cross-page CALL/RET iterations, 200 million retired instructions per
arm, shipping tier2 OFF, MAX_PAGES=1, initial JIT compilation included:

| Arm order | ms |
|---|---:|
| A | 1276.75 |
| C | 1136.71 |
| C | 1138.35 |
| A | 1267.31 |

Paired throughput direction is +12.32% and +11.33%. Every arm publishes two JIT
modules, finishes ECX=0 and counts 49,774,976 sampled chained entries. Raw data is
snapshot `fixed-work.json`. No universal/browser/game speedup follows from this
specialized test; an independent noise-floor study has not been performed.

## Game protocol

The first NFSU A/C pair is under `logs/v86-app-perf/{baseline,candidate}-memo-phase-1-entry/`.
Compared with the previous cold-boot pairs, the clean window now waits until the
physics mover counter reaches 20,000, rejecting a start beyond 20,250. It still
checks race state 4 before/after, advancing physics, exact fixture readback and
the scene screenshot. This narrows phase mismatch; it does not make the entire
simulation or 12-second wall-time window deterministic.

The pair completed: A mean 53.30 ms / p50 51.75 / p95 66; C mean 50.44 ms /
p50 47.5 / p95 68. Starts were 20,044 and 20,051 mover updates, and both fixture
readbacks matched. **The pair is rejected**, despite the favorable timing:
A used the near chase camera and C the bumper camera. The visible race timers
also differ (51.61 vs 46.36 seconds at the end). Absolute mover count does not
establish equal race phase; it can include differing work before active racing.
Do not quote the ratio as an optimization gain.

## Camera mismatch isolated

An explicit Enter press in the active race changed bumper → far chase. A four-image
sweep confirmed the cycle far → near → bumper → far, driven by Enter in this saved
profile. Thus a confirmation landing just after loading can change the benchmark
camera. `logs/v86-app-perf/camera-cycle.json` and `debug/camera-cycle-{0..3}.png`
retain the observations.

`tools/probes/nfsu-camera-gate.ts` classifies these views from the yellow Golf's
screen coverage in a bounded image region: observed fractions 0.2043, 0.3315,
0.0012, 0.2043. All four calibration images classify as visually inspected.
`NORMALIZE_CAMERA=1` now asks the entry probe to select bumper before timing,
reject unknown views, and verify bumper again after timing. This is a
fixture-specific check, not a generic game-state oracle. The normalization passed
the four fresh entries below; simulation-phase alignment still needs a stronger
start-state definition.

## Camera-normalized A/C/C/A result

All four windows completed. Raw artifacts are under
`logs/v86-app-perf/{baseline,candidate}-memo-camera-{1,2}-entry/`.

| Order | Arm | Mean frame ms | p50 ms | Mover before → after |
|---|---|---:|---:|---|
| 1 | A | 48.95 | 47.50 | 20026 → 22805 |
| 2 | C | 48.35 | 46.75 | 20030 → 22829 |
| 3 | C | 45.51 | 45.00 | 20012 → 22854 |
| 4 | A | 48.93 | 47.25 | 20027 → 22797 |

Each window reports race state 4 before/after and bumper classification before/after.
All five persisted fixture files match their expected hashes in every arm. The
independent frame-report cross-check agrees on count and mean in all four windows.

The paired throughput directions are +1.24% and +7.51%. A repeats within 0.04%
in mean frame time, while C changes by −5.87%, larger than the first pair's effect.
This is not an independent A/A noise-floor experiment, and equal absolute mover
counts still do not establish equal race phase or identical opponent work.
Therefore the game magnitude is **not accepted**. The candidate remains isolated;
the specialized +11–12% CALL/RET result is insufficient evidence for integration.
Further game comparisons need a verified repeatable race start, rather than more
repetitions of this cold-entry protocol until a favorable aggregate appears.
