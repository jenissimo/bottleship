# Search for broad v86 lowering improvements

## Read-pair fixed-work result: defer this candidate

`run-read-pair-work.mjs` executes warmed emitted functions with host budget
continuations included. Each long window retires exactly 350,000,001 guest
instructions (50 million iterations), makes 3,500 module calls, and verifies
ECX=0, result=4 and HLT. Both artifacts are hash-checked against the same snapshot
manifest. Twelve alternating warmups precede nine rounds of A/C/C/A plus A/A and
C/C controls. The user game was paused via the application button for each run
and resumed in `finally`; no concurrent build or test was started.

The initial million-iteration windows lasted only about 3 ms and had a 65%
maximum absolute same-arm control difference; their magnitude is unusable.
The subsequent 50-million-iteration run had median times 136.3585 ms (A) and
176.8226 ms (C). All nine paired speedup estimates were negative, with median
-22.3138%. Maximum absolute control difference was 23.2358%, so a precise
regression magnitude is not accepted under the strict control criterion.
Raw results: `logs/v86-read-pair-work-short.json`,
`logs/v86-read-pair-work-50m.json`; console logs have corresponding names.

Decision: do not integrate or expand this candidate on current evidence. Fewer
TLB loads did not deliver a positive signal even in its direct-pair fixture.
The implementation adds range computation, locals and a branch; attribution of
their individual cost is not established. This does not reject shared address
translation in general. Return to profile-weighted opportunities before further
investment. No gameplay speedup is claimed; installed runtime is unchanged.

## Executed shared-load branch and real paging faults

`test-read-pair-jit.mjs` now recognizes the shared-load branch in generated Wasm
and uses v86's `test_hook_did_generate_wasm` to mutate only its load offset from
zero to four with `--mutate-shared-load`. The baseline matches zero sites;
the direct-pair candidate matches one. The mutation changes the final result
from 4 to 5 and fails the existing semantic assertion. Thus the shared branch
executes, rather than merely appearing in emitted bytes. Raw failure:
`logs/v86-read-pair-live-mutation.log`. The ordinary twelve-case suite passes;
NOP, branch and base-write fences match no shared-load sites. This is execution
evidence, not a speed measurement.

`test-read-pair-fault.mjs` passes eighteen executions: interpreter/A/C across
missing first/second reads, negative displacement variants, and first/second
page-crossing reads. Real guest page tables and an IDT handler deliver one #PF,
restore the PTE, INVLPG and IRET. Fault EIP, CR2, error code, final values and
remaining loop count agree. At a second-read fault EAX already contains the
first result 42 while EDX remains the sentinel; A/C each deliver through the JIT
fault epilogue exactly once. Raw: snapshot `pagefault-results.json` and
`logs/v86-read-pair-fault.log`. CPL3 permission and real MMIO coverage remain open.

## First isolated JIT integration built and executed

`prepare-read-pair.mjs` creates source snapshots; transformation and MOV emitter
are retained in `tools/bench-v86/experiments/read-pair-{transform.mjs,mov.rs}`.
Manifest: `C:/Users/jenis/AppData/Local/Temp/v86-read-pair-Gqr7rJ/manifest.json`.
A is byte-identical to pinned 3a50…; C is
`23efa7f5d526b52ef331feafd90f4bf7a16f75b8ebf02d68697c9ff16bd97262`.
Vendor sources and installed runtime bytes are unchanged.

The prototype selects consecutive unprefixed 32-bit MOV memory reads, same flat
base without an index, displacement difference at most 64, first destination not
the base, second instruction still in the same known basic block. A cloned decoder
looks ahead; the real decoder still visits both instructions. Pair locals start
invalid and are freed at boundaries or unexpected EIPs. Only the first ordinary
TLB-hit predicate plus the complete range sets valid. Slow first reads never
populate valid; second reads branch to the original translator when invalid.

`test-read-pair-jit.mjs` passes twelve executions: interpreter/A/C × direct pair,
NOP fence, branch fence and base-register write. Each executes 300,000 iterations,
finishes the expected value and ECX=0; JIT publication is required in A/C.
Only the direct-pair module changes bytes; the three fence variants remain
byte-identical across A/C. Raw: snapshot `jit-shape-results.json`, log
`logs/v86-read-pair-jit.log`. The subsequent mutation check above establishes
that the shared fast branch was dynamically taken.

Remaining: permission/MMIO faults, destination alias
cases, effect/instrumentation interactions, and
performance measurements. This first implementation also adds flag/range work
and an extra branch; fewer TLB loads alone cannot establish a net improvement.

## Exact direct-pair selection before lowering integration

The analyzer now matches the entire first-read tail through the next translation:
fault test/exit, fast physical load, destination-local assignment, unchanged-base
plus displacement and scratch initialization. Aliasing the base with the first
destination or either translation scratch rejects the pair. Scope depths and
all opcodes/immediates must match. This is a narrow shape recognizer, not a CFG.

It finds 59 pairs across the captured modules: 0 in 40d, 9 in 40e, 20 in 5cd,
30 in 5c8. Raw: `static-direct-pairs.json` in the capture directory. Seven tests
now cover recognition and rejection. These counts cover a different exact-shape
filter from the earlier 64-byte screen; do not interpret 59 as its subset count.

Integration constraint discovered during code review: do not consume the second
guest instruction from instr32_8B_mem_jit by advancing the decoder. The enclosing
JIT loop separately handles last-instruction EIP updates, tracing and per-instruction
state. Instead carry explicitly scoped pair metadata between the two ordinary
lowering invocations, resetting it at block boundaries and any unexpected instruction.
The later sections above describe the isolated integration and correctness
checks; performance has not yet been measured.

## Executable paired-range Wasm prototype

`node tools/bench-v86/test-read-pair-range.mjs` generates baseline and candidate
Wasm against a controlled memory model. For two four-byte reads at `a` and
`a+delta`, the candidate admits its shared fast path only when the TLB permission
test passes and `(a & 4095)` is between `max(0,-delta)` and
`4096-max(4,delta+4)`, inclusive. On failure it executes the original two checks
and helpers in order. No later operand is faulted early.

196,608 comparisons pass: six signed deltas (−36,−8,0,8,16,36), all 4096 page
offsets, ordinary and top-of-32-bit-space page bases, and RAM/slow/first-fault/
second-fault modes. Comparison includes intermediate committed output, helper
call order and fault outcome. Instrumented TLB lookup counts confirm one versus
two loads on the shared fast path. Raw: `logs/read-pair-range-contract.json`.

The `--omit-range` mutation fails immediately with an incorrect second value;
`logs/read-pair-range-mutation.log` records the differential failure. Thus the
range guard is load-bearing in this model. This is not live v86 MMIO, guest IDT
delivery or a performance result. Next integration work must preserve precise
guest mapping and only select regions with proven fast-path effects. Production
has not changed.

## Affine pair screening and first manually inspected opportunity

The analyzer reviews successive affine sites sharing a base-local index and records
intervening local writes, control operations, stores and named calls. It rejects
395 of 1156 such pairs for a redefined base. The other 761 still require control-flow
and effects proof; absence of a lexical write is not dominance or SSA evidence.

191 pairs have no intervening explicit Wasm store, equal permission/TLB identities
and a combined displacement range no wider than 64 bytes (22/70/58/41 in
40d/40e/5cd/5c8). Calls remain explicit and may write memory. These counts are neither
dynamic weights nor numbers of safely removable checks. Raw:
`logs/nfsu-freeroam-hot-modules-20260905/static-pair-analysis.json`.
Six analyzer tests pass, including recycled-base rejection and effect reporting.

Manually inspected example in 5cd: Wasm offsets 19214 and 19292 read four bytes
at local6−28 and local6−20. The first translation's successful branch skips its
slow helper, reads through `(entry & -4096) XOR address`, assigns local1, then
computes the next address from unchanged local6. No guest write/call intervenes
on that fast branch. The first slow branch calls safe_read32s_slow_jit and must
NOT contribute a reusable translation: it may return MMIO/page-crossing scratch.

Concrete prospective mechanism: widen the first successful-page range proof to
cover both reads, then reuse its entry for the second only on that proven fast
path. If the range proof fails, retain ordinary per-access checks and original
fault order. Do not fault early by validating the later operand ahead of prior
side effects. This differs from idx29's dynamic page-comparison cache, but still
needs a measured codegen experiment and a complete guest-block/alias proof before
integration. No new runtime optimization has been installed.

## Read-translation detector and address forms

The static analyzer now recognizes the complete ordinary read path: page index,
TLB load, permission mask, optional page-crossing predicate, fast branch and the
matching-width slow helper. Local identities and scope depth must agree. It records
the TLB base, permission mask, operand width, Wasm offsets and fault EIP page offset.

| Captured module | Recognized read translations | Immediate local + constant address forms |
|---|---:|---:|
| 40d | 108 | 75 |
| 40e | 730 | 421 |
| 5cd | 631 | 474 |
| 5c8 | 280 | 214 |

Raw: `logs/nfsu-freeroam-hot-modules-20260905/static-memory-analysis.json`.
The 1184 local-plus-constant sites out of 1749 recognized read paths identify a
promising address class, not 1184 removable checks. Recycled locals, changes of
base values, control-flow boundaries, helper effects and page crossings remain
unresolved. The detector deliberately does not label these as equivalent addresses.
This motivates local-definition/guest-block tracking before a grouped range proof.
Five analyzer tests cover exact recognition and negative lookalikes, including
wrong width/helper/address/scope and non-affine defining expressions.

## CR0 candidate deprioritized after interleaved measurement

The follow-up `run-x87-cr0-work.mjs <manifest> --interleaved` uses twelve alternating
warm-up windows followed by nine rounds of A/C/C/A plus A/A and C/C controls. Each
window executes one million iterations with exactly 12,000,001 retired instructions.
Earlier results are preserved; the tool now refuses to overwrite result files.

Median paired throughput direction is +2.03%, positive in 7/9 rounds. Maximum
absolute same-arm difference is 29.50%; even several other control differences
exceed the putative effect. The predeclared requirement that every paired effect
exceed every control difference fails. No performance gain is accepted and no
cause of variability is inferred. Raw: snapshot `fixed-work-interleaved.json`,
log `logs/v86-x87-cr0-work-interleaved.log`. The user's game was resumed afterwards.

Decision: retain this candidate and its correctness/shape evidence, but do not
integrate it or spend game A/B effort on it now. The next search target is redundant
memory-translation work. This must not repeat the existing idx29 read micro-TLB:
the negative-results inventory already records approximately 27.4% hits and an
unfavorable lookup cost. A new candidate needs compile-time proof of repeated
address/page work, not another per-access runtime cache probe.

## First CR0 fixed-work timing: inconclusive

`run-x87-cr0-work.mjs <manifest>` times warm emitted code for 10 million loop
iterations. The first implementation correctly refused an incomplete single-call
run: v86 returned after its internal 100,008-instruction budget. The measured
version resumes only at the asserted loop entry until HLT. Every arm completes
1200 invocations and exactly 120,000,001 retired guest instructions, ECX=0 and
the expected 256.0 result. No compilation or event-loop scheduling is inside timing;
the host continuation loop is included equally in both arms.

The user-opened emulator was paused through its UI for the benchmark and resumed
in a finally block. This is not a measurement of NFSU or browser performance.

| Order | Arm | ms |
|---|---|---:|
| 1 | A | 980.74 |
| 2 | C | 1045.28 |
| 3 | C | 1118.54 |
| 4 | A | 1358.65 |
| 5 | A control | 1274.59 |
| 6 | A control | 1264.40 |
| 7 | C control | 1262.67 |
| 8 | C control | 1238.22 |

The large time drift makes the A/C/C/A comparison inconclusive. Later same-arm
controls do not retroactively validate the earlier windows. No speedup is accepted,
and no cause (host load, JIT tiering or thermal changes) is established. Raw snapshot
`fixed-work-results.json`; log `logs/v86-x87-cr0-work.log`. A better interleaved,
explicitly prewarmed experiment is required before spending game A/B effort on this
candidate. It remains isolated and unproven as a performance optimization.

## Full #NM delivery and restart verified

`node tools/bench-v86/test-x87-cr0-fault.mjs <manifest>` now supplies a guest GDT,
IDT vector 7 and real interrupt handler. After 299,999 warm iterations, the guest
sets EM, TS or both through MOV CR0, then reaches the compiled FLD1/arithmetic
sequence. Earlier x87 work in the iteration exercises invalidation across the
CR0 writer. The handler records EIP and ECX, clears EM/TS and executes IRET.

All nine executions (three masks × interpreter/baseline/candidate) deliver exactly
one #NM at 0x0010007f with ECX=1, resume to finish ECX=0, and store exactly 256.0.
Both JIT arms call the real fault-delivery epilogue once; the interpreter calls it
zero times. There is no interception suppressing interrupt delivery in this suite.
Raw snapshot: `fault-delivery-results.json`; log `logs/v86-x87-cr0-fault.log`.
This closes the earlier IDT/restart and guest CR0-writer test gaps for these cases;
it does not constitute a whole-ISA proof or a performance result. Shipping remains
at the pinned 3a50… hash, verified again after the test.

## Executed guard-reduction and fence checks

`test-x87-cr0-shape.mjs <manifest>` runs 300,000 iterations of FLD1, eight
doublings and FSTP, in interpreter/baseline/candidate configurations. All nine
executions (plain, NOP-separated and JMP-separated instructions) produce exactly
256.0 and ECX=0. The JIT arms must actually publish code; interpreter must not.

The analyzer confirms plain baseline has 11 guards / 549 Wasm ops, candidate has
2 guards / 468 ops. NOP-separated arms both have 11 guards / 549 ops and identical
module hashes. JMP-separated arms both have 11 / 585 and identical hashes.
This is emitted-code reduction with executable fence evidence, not measured speed.

The suite additionally invokes the already compiled loop entry with CR0.EM, TS,
or both set. All 18 JIT cases invoke the real fault-preparation helper once and
reach the intercepted fault epilogue once, with the original FLD1 EIP and unchanged
ECX. Interrupt delivery is deliberately intercepted: full IDT #NM delivery/restart
and guest CR0-writer cases remain unproven. Raw result and captured modules are in
the experiment snapshot's `shape-results.json`; log `logs/v86-x87-cr0-shape.log`.

## Static analyzer first executable stage

Run `node tools/bench-v86/analyze-jit-wasm.mjs <captured.wasm> ...` for a JSON
report. It validates the Wasm independently, refuses multiple defined functions,
uses the checked opcode walker, records full SHA256 identity and recognizes the
complete CR0 mask/test/exception-helper/exit sequence. It never classifies an
arbitrary repeated load as a removable guard. Unknown helper shapes are counted
explicitly. The AOT-specific memory-address classification is omitted.

On four captured modules it recognizes all 659 task-switch guards: 111 in 40d,
465 in 40e, 70 in 5cd and 13 in 5c8. All test address 580 with mask 12.
Per-site Wasm offsets and fault EIP page offsets are retained in
`logs/nfsu-freeroam-hot-modules-20260905/static-analysis.json`.
Slow-memory fallback sites are also inventoried; they are neither executed misses
nor proven repeated translations. No static count is presented as a time share.

`node --test tools/bench-v86/analyze-jit-wasm.test.mjs` passes three tests covering
recognition, similar non-matching patterns, broken control scopes, truncation and
invalid Wasm. Guest block mapping, dominance/write barriers and dynamic weighting
are still required before this becomes a redundant-check detector or cost model.

## Consecutive CR0-check experiment prepared

`tools/bench-v86/prepare-x87-cr0-run.mjs` builds two isolated source snapshots.
Manifest: `C:/Users/jenis/AppData/Local/Temp/v86-x87-cr0-run-yDFH94/manifest.json`.
Rebuilt baseline exactly matches the pinned 3a50… bytes. Candidate SHA256 is
`22f689d34c51958b104e815713a925657a65b18b828c97a02b322a564129078c`.
Production artifacts and vendor source are unchanged by this experiment.

The candidate reuses a successful CR0.EM/TS test only through consecutive guest
instructions which invoke gen_task_switch_test. Every other guest instruction
invalidates the compile-time fact after emission, and every basic-block start
resets it. The first test remains at its original instruction, preserving the
intended fault location; no check is hoisted ahead of prior side effects.
FXSAVE/FXRSTOR also use this generator but explicitly terminate their blocks.

The candidate completed `vendor/v86/tests/fpu-relaxed-diff.mjs` with
`VERDICT: all variants match`; log `logs/v86-x87-cr0-run-diff.log`.
This suite covers arithmetic/control-word/cache behavior, not forced #NM delivery.
Remaining acceptance work: emitted-code proof that redundant tests are removed,
forced EM/TS faults at block entry, CR0-changing fences and fault/restart checks,
then fixed-work and game measurements. No performance claim or integration yet.

## New objective baseline and fresh free-roam evidence

The +20% FPS objective starts at SHA256
`3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a`.
Public, vendor/build and dist wasm agree. A byte-verified copy and manifest are
under `logs/v86-20pct-baseline-20260905/`. Prior MOV/MULPD gains do not count again.

The user opened a new free-roam session on port 9333. Its screenshot confirms
active NFSU, stationary yellow Golf at the starting grid with chase camera; its
settings/loaded wasm provenance are not yet independently sufficient for a timed
A/B acceptance. This session is used for diagnosis without restarting the game.

Two fresh 12-second traces were collected:
`logs/nfsu-freeroam-hot-search-20260905.json.gz` (with hotBlocksMark) and
`logs/nfsu-freeroam-hot-search-no-mark-20260905.json.gz` (without that callback).
Their adjacent text reports use the corrected named-address annotation. The
second follows cache clearing for module capture, so it is NOT a controlled
estimate of the callback overhead.

The no-mark trace has guest modules 0x005cf304 at 4.6% self, 0x0040da30 at 3.5%,
0x005c9152 at 2.3%, 0x0040f000 at 2.0%, and 0x005cb000 at 1.9% of sampled time.
The first trace's 3.8% read32s spike was concentrated at the beginning and does
not appear among the second trace's top 25. Do not select it as a large production
target without separating diagnostic work. Module composition also changed after
cache clearing; entry-address shares are module shares, not exact instruction costs.

`logs/nfsu-freeroam-hot-modules-20260905/` contains five byte-captured modules,
configuration readback and static opcode/call histograms. idx21=0, idx12=1,
idx15=0, raw-unsafe=0. The 0x40d module contains 111 static task_switch_test_jit
sites; 0x40e contains 465. Codegen emits CR0.EM/TS load/test per such instruction.
This identifies a possible generic redundant-guard optimization; these are cold
exception call sites and their counts do NOT imply actual helper calls or a
measured time share. A safe once-per-basic-block proof and isolated cost experiment
are needed before promoting it. Memory translation remains another candidate.

The module-stats `cpuState/guest` split assumes another CPU-state ABI and does not
track the address-producing stack; it is not valid attribution for these modules.
Only decoded opcode/import counts are used here. Captured modules precede the
no-mark trace and must not be silently matched to its changed table occupants.

The objective is tens-of-percent improvement, not another isolated microbenchmark
win. This first pass uses the existing pre-MOV/MULPD NFSU trace; a new shipping
trace has not yet been collected. Do not present these shares as current shipping.

## Attribution defect fixed first

`tools/analyze-trace.ts` annotated a named `g<address>@t<slot>` module through a
sampled table-slot map, despite slots being recyclable. The embedded module address
is authoritative. The named path now always prints that address, preserving the
existing anonymous-module path. Re-analysis of the existing real trace confirms
`g0040e002@t795` prints guest 0x0040e002 rather than page 0x0040f000, and
`g005cd001@t838` prints 0x005cd001 rather than page 0x005d6000.
Artifact: `logs/v86-app-perf/nfsu-baseline-attribution-address-fixed.txt`.
This changes labels, not sample weights or the performance of v86.

## Evidence-directed priorities

The old trace attributes 28.6% of total sampled time to generated guest blocks,
6.6% to indirect-jump/cache work, and only 1.1% to SSE primitives. The 16.9%
V8 idle/program category is not established reclaimable CPU time.

1. Inspect actual generated modules for the largest guest blocks, starting with
   0x005cf304 (4.8% self in this trace), then 0x0040da30 (2.1%). The existing
   reverse-engineering report identifies the former as a descriptor/list walk.
   Candidate mechanisms are repeated memory translation, state publication and
   call boundaries; their individual costs are **not yet measured**. The module
   entry name does not locate the particular hot instruction inside the module.
2. Examine other hot modules for the same code-generation pattern before
   designing a generic optimization. A game-specific replacement of the walk
   would not satisfy the v86 objective or repository architecture rules.
3. Keep dynamic memo inlining secondary: its current specialized +11–12%
   CALL/RET evidence and noisy game pairs do not establish a large game effect.
4. Avoid blind SSE-helper expansion: the old whole bucket is too small to promise
   tens of percent here, and shipping already removes some of that work.

`jitBytes arm/snap/export/off` in `src/worker/harness/cmds/codegen.ts` provides the
existing generated-module capture mechanism. Capture/recompilation must be outside
clean timing, and exported bytes must be associated with their compilation identity.

## Fresh-capture attempt

The owned browser displayed an I/O-worker read error after remaining loaded.
The baseline restart runner then terminated at fixture restore: the profile file
could not acquire a writable handle even after reload. No new performance window
was produced. Logs: `logs/v86-app-perf/baseline-hot-search-1-entry/` and
`logs/v86-app-perf/hot-search-1.log`. An attempted identity-checked restart of the
owned browser process was rejected by automatic policy; no restart was performed.
This is a runtime-preparation limitation, not evidence against a lowering candidate.
