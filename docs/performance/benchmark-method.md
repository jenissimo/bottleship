# Performance measurement contracts

Durable instruments live in `tools/harness/perf`, `tools/guestbench`, `tools/bench-v86`,
`tools/aot` and `tools/aot-oracle`. One-off probes and session plans belong in ignored
`tools/probes` and `plan`, respectively. Preserve reproducible results and failed hypotheses
in this directory; session state is not a performance contract.

Compare the same guest work and scene in interleaved, repeated runs. Record engine identity,
build/settings, warmup, work count and uncertainty. A win in a synthetic fixture establishes
its mechanism, not game FPS. Keep interpreter/JIT and counter-instrumented profiles separate
from normal execution measurements. Retired instructions are the guest-work counter; their
ratio is not a share of elapsed host time.

Render-worker accounting must name the active presenter and separate work that actually
moves from CPU/HLE work that remains. `tools/census-presenter-kinds.ts` and harness
`renderBoundary` expose that boundary; [render-worker census](render-worker-census-b.md)
records the measurements. `tools/analyze-trace.ts` reports scoped costs, not an unqualified
prediction of overall FPS.

`tools/bench-v86/source-pair` compares code generation using fixed guest iteration counts.
See [source-pair codegen results](codegen-pair-2026-09-10.md) for scope and limits.
Permission-map and AOT/census protocols/results remain under `sota-roadmap`; those reports
are evidence for their exact experiments, not a current implementation schedule.
