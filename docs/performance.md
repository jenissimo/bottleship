# Performance measurement contracts

Durable instruments live in `tools/harness/perf`, `tools/guestbench`, `tools/bench-v86`,
`tools/aot` and `tools/aot-oracle`. One-off probes belong in ignored `tools/probes`;
session plans, research reports and experiment registries belong in ignored `plan`.
Keep screenshots, traces and raw measurements in ignored `logs`. Share relevant evidence
in the issue or PR; `docs` contains maintained guides and reference material.

Compare the same guest work and scene in interleaved, repeated runs. Record engine identity,
build/settings, warmup, work count and uncertainty. A win in a synthetic fixture establishes
its mechanism, not game FPS. Keep interpreter/JIT and counter-instrumented profiles separate
from normal execution measurements. Retired instructions are the guest-work counter; their
ratio is not a share of elapsed host time.

Render-worker accounting must name the active presenter and separate work that actually
moves from CPU/HLE work that remains. `tools/census-presenter-kinds.ts` and harness
`renderBoundary` expose that boundary. `tools/analyze-trace.ts` reports scoped costs, not
an unqualified prediction of overall FPS.

[`tools/bench-v86/source-pair`](../tools/bench-v86/source-pair/README.md) compares code
generation using fixed guest iteration counts. [`tools/guestbench`](../tools/guestbench/README.md)
provides synthetic guest fixtures. Their READMEs describe repeatable commands and correctness
checks; individual experiment results stay with the local evidence.
