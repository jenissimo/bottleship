The stack-forwarding experiment compares the shipping JIT, semantic AOT, an identical-byte AOT control, the optimized AOT unit, and an optional Emscripten reference. It attaches to an existing BottleShip harness session; `stack-browser.ts` never launches Chrome or changes another session.

```powershell
node tools/aot/capture-job.mjs --case k8 --out tmp/stack-experiment/job-k8.json --warmup 20000
node tools/aot/opt/publish.mjs --case k8 --job tmp/stack-experiment/job-k8.json --out tmp/stack-experiment/k8-base --passes flag-liveness,scoped-memory,flags-in-locals
node tools/aot/opt/publish.mjs --case k8 --job tmp/stack-experiment/job-k8.json --out tmp/stack-experiment/k8-candidate --passes flag-liveness,scoped-memory,flags-in-locals,stack-load-forwarding
node tools/aot/opt/stack-reference-build.mjs
$env:BS_TAB = 'stack-experiment'
bun tools/harness.ts up
bun tools/aot/opt/stack-browser.ts --base tmp/stack-experiment/k8-base.json --candidate tmp/stack-experiment/k8-candidate.json --direct-module /tmp/stack-experiment/reference/reference.mjs --fresh-sample-workers --rounds 10 --min-rounds 10 --outer 2000000 --warmup 1000000 --out tmp/stack-experiment/browser.json
```

Run measurements with one browser page and no competing workloads. The owned page must use `game=dev` and expose no loaded modules. If its main worker has initialized a BIOS process, the CLI pauses it through the canonical harness RPC and verifies the paused state before measuring. It remains paused in this owned tab. Ping/state before and after the experiment must prove that the host process is absent or paused, with no loaded modules. Each even/odd pair reverses a rotated arm order; the rotation advances between pairs. Ten rounds with five arms place each arm twice in every position. Every sample creates and destroys a fresh V86 in the same browser module worker. The oracle image runs warmup, N, 2N and one untimed capture call. All hosted arms read back the shipping JIT configuration.

The JSON preserves sample order, phase times, complete CPU state, guest output, live instruction counters, AOT function ownership, hashes, command line, browser occupancy and idle probes. The actual two measured phase counts must equal `502*N+4` and `1004*N+4`; the four fixed instructions are the phase setup and port marker. Output also passes the independent scalar K8 oracle. A unit must still own its exact Wasm function and page at completion and have a positive engine entry count.

The default `shared-worker` mode retains the browser worker across samples while creating a fresh engine for each one. Optional `--fresh-sample-workers` keeps orchestration, digest checks and the compiled engine module in that worker, and runs each sample in a dedicated child module worker. Immutable unit bytes and the compiled module are structured-cloned to the child. The parent terminates every child after its result, error or timeout. Every arm uses this same lifetime; timed functions, warmup, shipping configuration and acceptance thresholds stay identical. The report records `execution_mode`, the flag and the child-worker source hash. This mode tests whether retained engine memory and worker GC contribute to timing pauses, without forcing collection or changing browser flags.

The identity control uses the semantic unit bytes under a second arm name. Its maximum absolute paired deviation defines this experiment's conservative noise floor. `measurement_valid` confirms correctness and measurement gates; `performance_accepted` additionally requires the candidate delta to exceed that floor. `causal_speedup_accepted` requires a positive delta. Values inside the floor are labeled `directional-only-within-noise`. Short smoke runs keep raw data and correctness results while withholding performance attribution.

The Emscripten reference has a separate contract: reconstructed scalar computation, compiled with `-O3` in separate translation units without vectorizers or LTO, and a completed-call ledger, without the x86 architectural state, memory protection or scheduling obligations. Its ledger counts returned kernel invocations, not independently observed inner-cell executions. Original retail source is unavailable. Its fetched JS and Wasm hashes are checked against local build artifacts; the exact digested Wasm bytes are passed to each fresh instance. Artifacts outside `public` are copied unchanged to a unique `public/apps/.stack-lab/<UUID>/` directory, so Vite serves the compiler output without a module transform. Original and served URLs/hashes remain in the report; generated artifacts are retained under the existing ignored game-asset directory. A neighboring `build.json`, when present, supplies checked artifact hashes, source/toolchain provenance and its own hash. Reference output is checked after warmup, N and 2N, with exactly `warmup+3*N` completed calls.

```powershell
node --test tools/aot/opt/stack-browser.test.mjs
```

These tests exercise the acceptance gate with successful samples and deliberate output, counter, CPU state, identity, ownership and environment failures.

## Recorded experiment: 2026-10-10

The opt-in compiler pass lazily forwards read-only frame cells while preserving guest stores, fault boundaries and instruction accounting. A cache miss uses the original guarded or proved memory access. Slow helpers and possible physical-page alias stores invalidate cached values; frame-base changes invalidate their dependent cells. Diagnostic instrumentation of executed Wasm loads observed bias reads `64→1` and stride reads `8→1` for one complete K8 invocation. No stores were removed.

Correctness passed: 78 Rust tests, 38 generated-Wasm conformance checks, 17 browser gate/lifetime/payload tests, the 38-rule publication verifier, the live-engine differential oracle, the 11-check exit matrix, typecheck and all 18 repository validation gates. Conformance includes physical aliases, partial overlapping stores, partial output before faults, cold TLB, page crossings, code-bearing writes, permissions, budget resumptions and a deliberately reversed alias-invalidation predicate. The disabled pass emitted the exact pre-feature baseline bytes.

The final browser run used 10 rounds, one million warmup invocations, measured phases of two and four million invocations, fresh sample workers and rotated reversed pairs. All 50 samples passed correctness. Every hosted sample retired exactly `1,004,000,004` and `2,008,000,004` guest instructions in the two measured phases; the source reference returned exactly seven million calls including warmup. Full guest memory/CPU state and the independent 512-byte payload oracle agreed.

**Performance attribution is withheld.** The identical-byte control's maximum paired deviation was 55.86%; semantic round 3 and identity round 8 failed steadiness. Fresh sample workers did not resolve the timing instability. The candidate's median paired throughput change was −14.43%, inside that noise floor. These raw medians cannot establish a causal speedup or slowdown:

| Arm | Median ns/invocation | Full-range spread / median |
| --- | ---: | ---: |
| Shipping JIT | 264.82 | 2.91% |
| Previous semantic AOT | 471.67 | 65.94% |
| Identical semantic AOT control | 476.40 | 35.29% |
| Stack forwarding | 557.11 | 3.82% |
| Reconstructed scalar Emscripten | 11.13 | 25.41% |

Environment: Windows, Ryzen 9 7900X3D (12 cores/24 threads), balanced power plan, stock Chrome 156, Emscripten 4.0.11. The owned dev process was canonically paused; the browser had one page. Runtime/config/workload/build hashes, raw phase values, order, occupancy probes and refusals remain in the local evidence directory:

- [Final isolated run](../../../logs/stack-recompile/final.json), [shared-worker run rejected for noise](../../../logs/stack-recompile/noisy-shared-worker.json).
- [Generated-Wasm conformance](../../../logs/stack-recompile/conformance.json), [repository gate output](../../../logs/stack-recompile/quality-gates.txt).
- Earlier import/provenance refusals and correctness-only smoke runs are retained beside them; no samples were removed to obtain an accepted result.

Artifact SHA-256 identities:

```text
engine    ce21a0e21e2e2c9cc0bae9acfdf4615daf22664a5a3b94e907aea139e9693fa6
base/off  05e359c82755e6b9f7196756bc3be444c5e668cee3c5a818931fc3b7cb71e7c0
candidate c00d7e3da0b3ec6a89adbabe3fad0ff9a4f272d9064f93fc2c9421c69c08b34b
reference 4eceaf5e67393fd693b76fb1c74a42a08df67a90b39afa2e7bad68fece250677
```

The pass remains disabled by default. The next compiler hypothesis is a single entry guard proving frame/output disjointness, followed by stack values represented directly in SSA without per-store cache checks. Failure of that guard must retain the original guarded path and precise fault effects. This experiment supplies correctness machinery for that hypothesis; it establishes no game-level performance result.
