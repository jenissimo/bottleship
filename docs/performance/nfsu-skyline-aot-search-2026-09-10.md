# NFSU Skyline: profiling and AOT search

Scene: the one-action entry adapter's maximum-settings Skyline, Free Run, Olympic
Square, no traffic. This is a same-session stationary workload, not a bit-exact
snapshot or an independent-boot performance study.

## First profile

Evidence is in `logs/nfsu-navigation-RibI1M/`.
Run `1789043335357` contains a 15-second warm-up, 20-second clean frame window,
15-second instrumented frame profile, then a separate guest-block probe.
The clean window passed race, progress, present-count, configuration and no-new-JIT
checks: 18.1981 FPS. This is a baseline observation, not an uplift.

The frame profiler's last-60-frame average was 54.13 ms, including 50.36 ms labelled
v86 and 3.70 ms labelled thunk. The v86 category is a residual bucket; it does not
separate JIT code, native Wasm helpers and uninstrumented glue, and must not be read
as 93% pure generated-Wasm execution. Sampled thunk costs at the clock resolution
are explicitly unreliable; SetRenderTarget was the largest reliable thunk row.

The default counted guest probe refused: the restored AOT did not populate the
tier-2 page inventory. It did not report zero work. The follow-up run
`1789043540468` explicitly armed ten selected physical pages. It recorded 1,050
blocks over eight seconds/144 presents, with no slot overflow. Their weighted
instruction count covered 37.6% of the global retired counter; percentages within
the row list are shares of the counted subset, not of total CPU time.

Examples: `0x5CDCA7` entered 3,002,024 times, `0x5CF33A` 3,074,891 times,
`0x5CF304` 1,420,034 times; the short `0x5D0236/244/24B/255/25C` loop blocks each
entered 2,829,836 times. This selects render-state integer/control-flow code for
the next experiment. EIP sampling alone overweights return/parking locations and
is not used to assign a speedup ceiling.

## Experimental Binaryen pass

`build-binaryen-cache.mjs` applies the local emsdk wasm-opt (version 123,
version_123-219-g1d2e23d5e) with `-O3` to selected original captured units. The
manifest, hashes, flags and optimizer executable hash are retained in
`binaryen-hot/optimization.json`. The input cache and production engine are not
changed. Four modules shrank by roughly 9–12%; this is not a performance result.

The first paired attempt stopped before measurement: module idx836 retained its
function but lost ownership of a constituent page during the original arm's
warm-up. The diagnostic repeat `1789043829665`
records the per-module ownership state. The initial comparison therefore excludes
idx836 and keeps idx831, idx741 and idx860, whose full page ownership survived.
The omitted module and reason are retained in `nfsu-binaryen-stable.json`.

`nfsu-paired-run.mjs` uses ordinary AotCache replacement/drop/replay, reconstructs
the original functions from hash-verified bytes, alternates warmed A/C in
ABBA/BAAB order, and checks every target's function and full page ownership,
positive entry deltas, no new JIT compilation, scene parameters and raw cadence
counts. It restores the original cache bytes and replays them on completion or
failure. OPFS saved AOT is never overwritten.

This is an exploratory game performance probe. Wasm validation and surviving a
race do not constitute the architectural state/exception oracle. A candidate must
pass that separate gate before production acceptance.

## Completed pilot and unfinished control

Run `1789043921663` completed all eight valid A/C windows. Median FPS were
18.6383645 / 17.6313954, ratio 0.9459733. All target modules had positive entry
deltas and retained full ownership; no new JIT compilations occurred in the
windows. Absolute FPS varied substantially over the run. This candidate supplied
no positive game signal; the ratio is not an accepted precise regression estimate.
Original bytes were restored and replayed in record `1789043921676`.

The subsequent identical-byte control `1789044103094` has only one saved timing
window (`1789044103098`). It was interrupted, and the browser inventory was empty
when inspected after the user's request to formulate hypotheses. It has no
completion/restore record and must not be reported as a completed A/A control.
The experiment only changed in-memory AOT; saved OPFS bytes remain original.

Next analysis plan: `docs/performance/v86-optimization-hypotheses-2026-09-10.md`.
