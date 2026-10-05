# WBUF routing: dynamic census and isolated candidates

## Status

NFSU Skyline / Olympic Square / Free Run / no traffic / maximum settings.
The scene is reproducible through `tools/bench-v86/source-pair/nfsu-entry.html`.
This investigation found a promising **helper lookup** change, not a demonstrated
game FPS improvement. Shipping v86 source and engine were not replaced by this experiment.

Evidence directory: `logs/nfsu-navigation-RibI1M` (ignored local artifacts).
Baseline SHA256: `9aa38d8bf99d9b6d8c8371605c9d2070edaeb6af28de8e9d6f07ae86210af276`.
Isolated baseline rebuilds reproduce this hash exactly.

## What executes in the scene

The completed A/A run `1789044523238` has eight valid windows, with positive
entries, retained ownership, no JIT compilation and original AOT restored.
Quartet geometric ratios are 0.98082 and 1.07322. Entry counts per frame have
CV 0.35%, 1.09%, 0.37% for units 831, 741, 860 respectively. The monitored work
is stable, but small timing changes remain below this run's acceptance power.
See `identity-control-assessment.json`.

Imported-helper wrappers on these three units are diagnostic counters, **not
cost measurements**: JS wrappers affect scheduling and throughput.

- Run `1789044664888`: 103 frames, 1,436,847 dynamic-chain resolver calls and
  626,502 WBUF helper calls. Slow safe-read/write helpers were not called.
- Detailed run `1789044796586`: 101 frames, all 616,194 WBUF calls in unit 860
  decline. Two targets account for 308,097 each: `IDirect3DTexture9_AddRef`
  and `IDirect3DTexture9_Release`. Stub identities were resolved through the
  live thunk registry, not guessed from addresses.
- These targets fall inside the generated broad address-range guard but have
  no WBUF descriptor. Their ordinary execution is still required; skipping
  refcount semantics is not the proposed optimization.
- Native global WBUF counter window `1789045577490` → `1789045577491`:
  73 frames, 396,673 hits (~5,434/frame), 545,021 fallbacks (~7,466/frame).
  This is a separate window; do not combine it with wrapped counts to claim
  an exact global fraction attributable to AddRef/Release.
- Native dispatch counter probe `1789044945349` → `1789044945350`:
  7,829,222 memo hits, 92,575 metadata hits, 4,461,671 budget exits.
  Memo lookup is already commonly successful. Budget exits cannot simply
  be removed or delayed without changing scheduling semantics.

The earlier v86 frame-profiler residual includes uninstrumented glue, not
just generated Wasm. Counts do not establish how many milliseconds WBUF costs.

## Fixed-work experiments

`tools/bench-v86/prepare-wbuf-miss-cache.mjs` builds isolated engines from copied
sources. `test-wbuf-miss-cache.mjs <manifest> [--paging]` imports the actual
engine helper into a small Wasm module: Wasm-to-Wasm calls, eight ABBA quartets,
8 million calls per window. Ratios below are baseline time / candidate time;
greater than one means faster. Successful calls write scalar commands and
reset the ring head between calls. Registry size is 112, with two absent targets.

| Variant | Flat misses | Flat scalar hits | Paged misses | Paged scalar hits |
| --- | ---: | ---: | ---: | ---: |
| 16-entry missing-target cache before hot slots | 1.943 | 0.894 | — | — |
| Same cache after hot slots | 0.884 | 0.911 | — | — |
| Canonical hash table directly, without hot-slot scan | 1.880 | 1.695 | 1.436 | 1.207 |

Both cache variants are rejected: success-path regression matters because
the game has thousands of successful WBUF calls per frame too. The direct
table candidate is retained for further evaluation. Its engine is 652 bytes
smaller, SHA256 `3ee78d780847f28bd69a1def4eabfc5cc59dfc2bff70e178468c6d4a356294c0`.

Evidence archives contain manifests, engine bytes, original/candidate `jit.rs`,
raw windows and correctness results:

- `wbuf-miss-before-hot/`
- `wbuf-miss-after-hot/`
- `wbuf-hash-first/` (also contains script snapshots and hot lifecycle probe)

Manifests preserve original temporary build paths; archived `.wasm` files are
stored directly alongside them. These are Node measurements, not IAB/game
acceptance. Shader payloads, realistic mixed target/collision distributions,
and game TLB locality are not covered by throughput measurements. Paged tests
enter paging through guest CR0/CR3 instructions and include TLB clears during
permission tests; do not assume their translation cost matches the game.

## Correctness and an uncovered semantic distinction

Flat tests pass 88 checks; paged tests pass 100 checks across both arms.
They cover missing targets, collisions, registry clear/re-register, disabled
mode, capacity and stack failures, unmapped/read-only/nonidentity mappings,
cross-page access, and recovery. Every declining call is checked against a
full guest-memory copy. These are scoped tests, not a full architecture oracle.

An additional `test-wbuf-hot-lifecycle.mjs` probe exposes a difference:

1. Register target with command ID 77 and mark it hot: both engines write 77.
2. Update canonical registration to ID 88 without re-marking: baseline writes
   the stale hot copy, 77; direct-table candidate writes 88.
3. Re-mark the hot slot: both write 88.

Thus the candidate is **not unconditionally equivalent across all exported
registry operation sequences**. The normal TypeScript registrar re-marks a
hot descriptor after successful registration when a hot slot is supplied.
Before adoption, define and test the update contract and audit all callers;
do not silently count the behavior change as a pure optimization.

## Next acceptance gates

1. Resolve the hot-descriptor update contract, then extend differential checks
   to shader payloads, aliases and realistically colliding registrations.
2. Reproduce mixed hit/miss fixed work in the same browser used for game tests.
   Record engine/browser identities and raw timings.
3. Run isolated baseline/candidate engines through identical fresh scene
   entries and warm-up, with A/A controls and work counters. AOT is bound to
   engine identity: never replay the old engine's cache into the candidate.
4. Only accept a game uplift above measured control noise; then validate
   movement and the second game. Cold compilation hitches remain a separate metric.

The longer-term mechanism is exact registered-target routing with safe registry
lifecycle, so absent targets avoid the expensive helper path. It is not
profile-based removal of calls. Any batching/coalescing beyond existing WBUF
rules additionally needs resource lifetime, readback and drain-order contracts.
