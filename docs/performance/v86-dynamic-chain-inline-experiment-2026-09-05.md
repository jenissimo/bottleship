# Dynamic-chain helper-free experiment

Status: isolated candidate, not integrated. The shipping wasm remains
`3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a`.

## Evidence and mechanism

The separate NFSU baseline profile attributed 5.0% worker self-time to
`jit_find_cache_entry_for_dynamic_chaining` and 6.6% to the broader indirect-jump
bucket. A following instrumented dispatch window (`logs/v86-app-perf/nfsu-dispatch-diagnostic.json`)
recorded 16,945,932 memo hits, 593,984 aliases, 1,687 cold misses, and 4,321,864
budget refusals. Its aggregate classes are not a partition and
`probeOutcomesSumOk=false`; do not quote their percentages as an exhaustive census.
Counters were disabled and the guest stopped before builds/performance work.

The experiment reuses the existing helper-free direct-chain emitter on dynamic
edges. It reads the current EIP, resolves DOD metadata and the entry slab, checks
state flags and budget/HLT, credits the retired activation and sampled entry census,
and tail-calls the target. A target's own prologue retains its generation check.
This removes the common Rust helper call and memo probe, rather than enlarging a
mostly hitting cache. Runtime wrong-entry verification uses the original dynamic
helper. With dispatch instrumentation compiled in, the entire original helper path
is retained; instrumented counter timing cannot evaluate this optimization.

The generator is intentionally duplicated in the snapshot for this mechanism test.
It must be refactored and reviewed before any integration. No new production flag
or runtime file was changed.

Preparation: `tools/bench-v86/prepare-dynamic-chain.mjs` rebuilds both copies.
Manifest: `C:/Users/jenis/AppData/Local/Temp/v86-dynamic-chain-lIeJMK/manifest.json`.
Baseline rebuild matches shipping byte-for-byte. Candidate SHA256:
`e1682d5c86e5db97e202faf3b8799f1bd536d6967fff7b9d37a5afa4f55de5ad`.

## Initial correctness

`test-dynamic-chain-snapshot.mjs` adapts the existing cross-page CALL/RET JIT-alive
regression to each snapshot with stats ON and OFF. All four cases pass. Each
published two modules, halted with ECX=0, and reported identical chain entries
(174,976) and retired census (1,074,980). Stats-OFF cases require advancing chain
entries and published JIT modules; zero disabled dispatch counters are not proof.
This covers a live dynamic path, not SMC/remapping/stale-entry/exception stress.
Those and emitted budget/HLT boundary tests remain required before integration.

## Fixed-work direction

`run-dynamic-chain-work.mjs` runs A/C/C/A with 50 million cross-page CALL/RET loop
iterations, MAX_PAGES=1, RET chaining ON, dispatch stats OFF, tier2 OFF. Every arm
retires exactly 200,000,000 instructions, publishes two JIT modules, and reports
49,774,976 sampled chain entries. The time includes initial JIT warm-up and excludes
engine construction; this is a specialized fixed-work test, not an NFSU result.

| Arm | Elapsed ms |
|---|---:|
| A | 1324.97 |
| C | 1200.09 |
| C | 1213.82 |
| A | 1339.87 |

Throughput direction is +10.41% and +10.38% for C. Same-arm repeat changes are about
1.1%, but there is no independent A/A noise-floor study or browser validation yet.
Raw rows and per-arm logs are in the snapshot root (`fixed-work.json`).
The result justifies further correctness and game testing; it does not justify
publishing the candidate or claiming significant end-to-end NFSU improvement.

## Emitted boundary checks and first NFSU result

`test-dynamic-chain-boundaries.mjs` directly invokes the warmed generated callee
module (not the Rust resolver). Ten cases on each arm with tier2 OFF and ON give
40 matching outcomes: hit, urgent zero budget, exhausted budget, HLT, legacy zero
budget with hypercalls disabled, missing entry, mismatched state flags, full TLB
flush, explicit target-code invalidation, and wrong-entry verification mode.
The ordinary hit must execute exactly one chain and decrement ECX from 10 to 9;
refusal/invalidation cases must execute no chain and leave ECX at 10. Registers,
EIP, EFLAGS, HLT, retired instruction delta, and chain count match between arms.
The metadata perturbations explicitly invalidate the memo; full-TLB and target-code
cases use the real invalidation entry points. This does not yet cover table-slot
recycling, all code-generation options, or guest-triggered paging faults.
Raw results: snapshot `emitted-boundaries.json` (40 rows).

The isolated proxy then served e168… as C and current shipping 3a50… as A.
The first sequential C/A NFSU pair **does not support integration**:

| Arm | Mean frame ms | p50 ms | p95 ms | Mover before → after |
|---|---:|---:|---:|---|
| Inline DOD candidate C | 53.48 | 50.25 | 72 | 13499 → 16106 |
| Current shipping A | 52.10 | 49 | 70 | 14547 → 17219 |

Direction is -2.58% throughput for C. Both remained in state 4, advanced physics,
matched all five fixture files, and showed the same bumper-camera starting-grid
scene. The simulation phases differ and the pair is sequential without a noise
floor, so this is a negative direction, not a precise regression measurement.
No performance claim may substitute the +10.4% synthetic result for this game result.
Raw files: `logs/v86-app-perf/{candidate,baseline}-dynamic-chain-1-entry/`.

The experiment remains unshipped. Two distinctions matter for the next decision:
the new DOD path also removed the compact memo (a different locality tradeoff from
merely inlining its hit path), and the current game protocol does not align the
simulation phase. A stronger game protocol is required before accepting a small
uplift; retaining the memo is a separate mechanism to test, not an assumed fix.
