# aot-oracle — the differential oracle for the AOT compiler (product B)

**One claim, and it is checkable:** the same guest work, over the same memory image, at the
same guest addresses, through (a) our JIT and (b) a candidate AOT module, must leave **the
guest memory and the architectural register file byte-identical**. Anything else is a bug
report with an address on it.

Runs headless in Node. **No Chrome, no harness, no dev server, no game, no bundle.**

This is the promoted, first-class form of the differential comparison the AOT spike did with a
stopwatch (that probe directory is gone; `tools/aot/` and this tool are its successors). What
promotion added is what turns a stopwatch into an oracle: the **register file is asserted**, not
just the output bytes; the comparator **names the first divergent address/register** instead of
printing two hashes; a candidate can be a **real contract-shaped unit published into v86's
dispatcher**; and a run that fails a validity gate is reported **INVALID rather than as a
number**.

---

## Quick start

```sh
cd tools/aot-oracle

node oracle.mjs --self-test                      # the oracle's own logic, milliseconds
node oracle.mjs --prove                          # the oracle works, end to end, on the whole corpus
node oracle.mjs --shape-check                    # --flags really reaches the emitter (needs the engine)
node verify-corpus.mjs                           # the corpus is still byte-exact retail code

# correctness only (no number claimed), seconds:
node oracle.mjs --check --case k1,k2,k3,k4 --candidate unit:auto            # opt-0 identity control
node oracle.mjs --check --case k3 --candidate unit:../aot/units/k3.json     # a real offline unit

# an ablation: the shape is forwarded to BOTH v86 arms and gated afterwards
node oracle.mjs --check --case k1 --candidate unit:auto --flags "5=0"
node oracle.mjs --check --case k2 --candidate unit:auto --relaxed 0

# a measurement (gates enforced), minutes — machine must be QUIET:
node oracle.mjs --case k1 --reps 5 --outer 40000 --warmup 200000 --candidate unit:auto

# negative control: prove the oracle detects a divergence it did not create
node oracle.mjs --check --case k1 --candidate unit:auto --fault src-last
```

**Exit codes.** `0` VALID / CORRECT / SELFTEST_PASS / PROVE_PASS · `1` a self-check failed
(`--self-test`, `--prove`, `--shape-check`) · `2` usage (including an **unknown option** — nothing
here silently ignores a flag it cannot honour) · `3` an arm failed or refused · `4` INVALID (a gate
failed) · `5` DIVERGENT (the candidate computed something else).

### `--prove` — the oracle's own end-to-end check

`--self-test` covers the comparator and the gates in-process; `--prove` covers **the whole loop on
the engine**. For every case it runs the opt-0 identity candidate (must be `CORRECT`) *and* every
fault the case declares (must be `DIVERGENT`, with a named first divergence, and with
`output_identical` present in `gates_failed`). Both halves are the point: a case that only ever
agrees has never been shown to be able to fail, and a comparator that always disagreed would pass a
negative control just as happily. 16 checks, ~8 s, no Chrome and no game. Restrict it with
`--case`.

It also takes `--candidate`, and that is what turns it from "the oracle works" into "this producer
works". The default `unit:auto` is the capture-and-republish producer, so it proves the harness;
a template containing `{case}` proves a real compiler over the whole corpus in one command:

```sh
node oracle.mjs --prove --case k1,k3,k4,k5,k6,k7 --candidate 'unit:../aot/units/{case}.json'
```

Use this rather than a hand-written loop of `--check` invocations when reporting a slice: a per-case
run can quietly omit its negative control, and `--prove` cannot.

---

## What is compared

Two independent views of "the registers came out the same". Neither is optional.

| view | who provides it | what it covers |
|---|---|---|
| **guest-visible** — the driver spills the 8 GPRs + EFLAGS to `L.STATE` at the capture point and that region is compared as memory | **every arm, no exceptions** | this is the assertion the module contract actually makes: a unit MUST have flushed its register locals to memory at every exit (`ms-aot-design.md` §4.2). A candidate that keeps the register file in wasm locals fails here, loudly, at a named register |
| **host-side** — the full CPU state read out of the engine | any v86-hosted arm (reference, `unit:`) | `reg32`, EIP, materialized EFLAGS, **the lazy flag 5-tuple**, x87 `st(0..7)` + stack ptr/empty + control/status word, `fpu_simd_dirty`, MXCSR/XMM, `instruction_counter` |

The lazy 5-tuple is compared *as well as* `get_eflags()` on purpose: `get_eflags()` alone
cannot catch a tuple that is incoherent in a way the current getters happen not to expose
(design §5.3 G1).

A field the candidate does not model is **never treated as equal** — it is returned in
`uncompared`, printed as `NOT COMPARED`, and named in the report.

### The capture point

Every arm executes **one more full outer iteration outside every measured phase** and spills
the register file immediately after it. The capture point is therefore "right after the
kernel's `ret`", identical for every arm, and never "right after an OUT marker clobbered
edx/eax". The cases are idempotent over the image, so the memory result is unchanged.

---

## Validity gates

The spike's rule, kept verbatim and extended: **a run that fails a gate is reported INVALID,
never as a number.** Gates come in two classes and the difference is not cosmetic.

| gate | class | enforced | meaning if it fails |
|---|---|---|---|
| `output_identical` | differential | **always**, incl. `--check` | guest memory and/or the register file differ ⇒ the candidate computed something else. The gate's `value` carries the first divergent address/register. It is a **gate** and not only the `DIVERGENT` verdict because a consumer that decides usability from `gates_failed` must see the equality failure there: before it existed, a divergent run's `gates_failed` read `["steady_state.reference","tier2Promotions.reference"]` — noise about warm-up — with nothing about the divergence in the array at all |
| `aot.registered` | differential | **always**, incl. `--check` | the unit was refused (content hash / page taken / no slot) ⇒ the candidate arm ran the JIT: this is JIT-vs-JIT, and identical output means nothing |
| `aot.alive` | differential | **always** | the unit was evicted or displaced before the end (handoff §2.1(3), design §0.1) ⇒ the JIT ran an unknown share |
| `aot.entered` | differential | **always** | nothing of the candidate executed *attributably* |
| `aot.relocations` | differential | **always**, when the unit declares any | a patched engine constant did not match the value re-derived from the live instance |
| `state.spilled` | differential | **always** | an arm published no non-zero `STATE` region ⇒ "registers identical" was two blocks of zeros. The image zero-fills `STATE` so that this is detectable |
| `shape.as_requested` | differential | **always** | a v86-hosted arm did not run the codegen shape `--flags`/`--relaxed` asked for ⇒ the run is not the experiment its label claims |
| `shape.arms_agree` | differential | **always**, `unit:` only | the two arms ran different codegen shapes ⇒ the difference is attributable to the shape, not the candidate |
| `timing_is_a_rate.{reference,candidate}` | measurement | when a number is claimed | a phase wall time or `ns_per_outer` came back zero, negative or non-finite ⇒ the two-point slope is not a rate. Observed on `k6`: `ref -857 ns/outer`, i.e. phase 2 (twice the work) cost *less* than phase 1. That condition also fails `steady_state` arithmetically, so this gate adds no coverage — it adds the **statement**, and the right diagnosis: `steady_state`'s "raise `--warmup`" is the wrong remedy for a timer that went backwards |
| `steady_state.{reference,candidate}` | measurement | when a number is claimed | phase2/phase1 outside 1.8–2.25 ⇒ still tiering/compiling; raise `--warmup` / `--warmup-calls` |
| `spread_pct.{reference,candidate}` | measurement | when a number is claimed | median-relative spread over reps > 10% ⇒ noisy machine |
| `tier2Promotions` | measurement | when a number is claimed | per rep, both directions: threshold > 0 with 0 promotions ⇒ measured as **tier-1** code; threshold 0 with promotions > 0 ⇒ the arm ran a shape its flags do not describe |

`evaluateGates()` **refuses to assemble a gate list without the comparator's result** — a caller
that forgot to pass it would otherwise get an all-green list for a divergent run, which is the
same failure one level up.

`aot.alive`/`aot.entered` check **function identity in `wasm_table`**, not "the page points at
our slot" — a freed slot is recycled by the very next compilation, and an earlier version of
that check credited an AOT unit with a JIT module's work (handoff §3). Measured here: a unit
with `ownsPage: true` but `sameFn: false` after 339 718 entries. `entries` comes from
`jit_get_module_entry_total(slot)`, a **per-slot** counter: once the slot has been recycled the
count is no longer attributable to our bytes, which is why `entered` requires identity and not
`entries > 0`.

The shape gates exist because the shape knob was silently dropped: `oracle.mjs` parsed
`--flags` and never passed it to an arm, so every "ablation" measured the default codegen shape
and reported CORRECT (design F-d). Two mechanisms now make that non-repeatable — the arms
**read every knob back** through `get_jit_config`/`get_relaxed_fpu` and abort on a mismatch
(`set_jit_config` on an unknown index is a no-op in a release build), and `--shape-check`
proves end-to-end that the knob changes the produced module bytes.

---

## Candidate classes

### `unit:<manifest.json>` — a contract-shaped AOT module (the real target)

Exports `f(i32)->()`, imports from `"e"`. Published into a real v86 through the
staged Rust AOT transaction (`begin`/page builder/`prepare_finish`/`commit`) plus one
`jit_aot_flush_tlb()`, and entered **through
`wasm_table[idx+1024]`** — the production dispatch path, not a direct export call. The
publication path deliberately mirrors `src/worker/core/cpu/aot-cache.ts`, including both
constraints bought with failed attempts (handoff §2.1): a unit is only replayable in the slot
its bytes were compiled for, and registration must **not** stamp the TLB.

Manifest shape (what the compiler must emit; `unit:auto` writes one). `jit_identity` is a
required ABI-5 replay envelope: the loader rejects a missing or mismatched engine SHA, RAM size,
JIT config ABI/mask/fingerprint, or exact slot before it stages any unit.

```json
{ "case": "k1", "engine_sha256": "...",
  "jit_identity": { "aot_abi": 5, "engine_sha256": "...", "ram_size": 16777216,
                    "abi": 4, "supported_mask": 0, "fingerprint_lo": 0, "fingerprint_hi": 0 },
  "units": [{ "entryPage": 257, "tableIndex": 899, "file": "k1-unit.0.wasm",
              "pages": [{ "physPage": 257, "stateFlags": 5,
                          "entries": [[offset, initial_state], ...],
                          "sha": "<sha256 of the FINAL in-guest page content>" }] }] }
```

### `unit:auto` — the opt-0 identity candidate (the oracle's positive control)

Captures the JIT's own module for the case's page in a reference run and re-publishes **those
bytes** as the unit. This is design gate 2a — what a compiler at optimization level 0 must
reproduce byte-for-byte — and it is how you check the oracle is wired to the dispatcher at all
before any compiler exists.

### `raw:<module.wasm>[#mode]` — a foreign module (the shape the spike's variant B had)

*No such module is currently in the tree* — the spike that produced them is gone, and a
`raw:` candidate has to be built before this class can be exercised. The adapter and its
refusals are still here because a lowering study is the natural first thing anyone writes.

Performs the case's guest work over its **own** linear memory at the same guest addresses. It
is not entered through the dispatcher and has no v86 CPU behind it, so the only way it can
satisfy the register half of the differential is to do what the contract requires of a real
unit anyway. Required exports:

| export | role |
|---|---|
| `memory`, `guest_base() -> i32` | the guest image is written into `memory` at `guest_base()` |
| `run_<case>(outer, mode, ...args)` | the case's entry point (`Case.raw.fn` / `Case.raw.args`) |
| `bs_set_capture(state_addr, esp)` | where to flush the register file, and the guest ESP at the capture point |
| `bs_oracle_abi() -> i32` | declares ABI 1 |
| `bs_state_ptr()`, `bs_state_abi()` | *optional* — publishes the host-side state block (`lib/state.mjs`) so view 2 is comparable for a non-v86 candidate too |

The flush must be **unconditional**, not capture-only: a capture-only variant means the code
that is measured is not the code that is attested, which is exactly the hole an oracle exists
to close.

---

## Adding a case

Add an entry to `corpus/cases.mjs`. Everything else — image assembly, both arms, the
comparator, the gates — is driven from it.

```js
k3: {
    id: "k3",
    body: KERNELS.k3.bytes,          // byte-exact guest code
    codeAddr: L.K3_ADDR,             // its own page, like a real .text page
    insPerIter: 23, insStatic: 25,   // retired per inner iteration / in the byte range
    iters: L.COUNT,                  // inner iterations per call
    calls: [{ off: 0, prologue: [["mov", "ecx", L.CTXA], ["xor", "eax"]] }],
    regions: [{ name: "DST3", addr: L.DST3, len: 256 }, STATE_REGION],
    faults: { "src-last": flipWord(L.SRC3 + 252) },   // negative controls
    raw: { fn: "run_k3", args: (outer, mode) => [outer, mode, L.CTXA] },
    provenance: { va: 0x..., sha256: "...", from: "NFSU Speed.exe" },
}
```

Include `STATE_REGION` — that is what makes the register file part of the assertion, and what the
`state.spilled` gate checks is not vacuous. Give the case at least one fault: a case with no
negative control has never been shown to be able to fail. Then `node verify-corpus.mjs` guards
the provenance from drift: a retail body is re-extracted from the binary, a **generated** body is
re-derived from the generator the case itself names (`provenance.generator = {build, selfCheck}`),
and a **hand-assembled** body is decoded end to end with the compiler's own decoder. A synthetic
case is never *skipped*.

Two things measured while adding `k7`, worth knowing before adding the next case:

- **A case needs a real trip count or it is never compiled.** `jit_increase_hotness_and_maybe_compile`
  accrues heat in **retired instructions** against `JIT_THRESHOLD = 200_000` (`jit.rs:1254`,
  `cpu.rs:3284`). k7's first shape was 3 instructions straight-line: at any plausible `--outer` the
  page produced `jit.pages: []`, `fastmemLoadsCompiled: 0`, an empty capture and `ARM_FAILED`. With a
  64-trip self-loop (329 instructions/outer) it compiles inside the warm-up.
- **A fault must not touch the case's code page.** Faults perturb the *data* image on purpose: the
  wrapper prologue lives on the same page as the body, so a fault that patched a prologue immediate
  would change the page hash, `publishUnit` would refuse on content-mismatch, and the run would come
  back `INVALID` (`aot.registered: false`) instead of `DIVERGENT`.

The corpus is five byte-exact NFSU kernels plus two synthetic vectors: **k1** the tightest
self-contained loop on NFSU's hottest page (0x5d3, 156.6M block-exec / 15 s, two call sites
through both sides of a branch diamond), **k2** the x87 class (48 x87 ops, 43 memory operands, one
basic block), **k3** the integer core (7 instructions, one read, one write, a `setcc`, a
register-counted self-loop), **k4** nested loops with five read-modify-write operands (7 basic
blocks, three back edges — the two-phase RMW shape), **k5** the 8-bit family (0x674b94: 8-bit
load, 8-bit shift by CL, a **byte** read-modify-write, an 8-bit self-test as the loop condition),
**k6** a *synthetic* slice-conformance vector — every instruction form the compiler claims, once,
straight-line (`corpus/k6-conformance.mjs`) — and **k7** the *synthetic* **register-only channel**
(`eax` from an uncompared input that is never stored, `ecx` from one that is), the only case whose
fault leaves every compared **data** region byte-identical while an architectural register differs.
That is the class the spike's headline bug lived in (variant B did not reproduce `movsd`'s ESI/EDI
post-increment: memory identical, register file wrong), and until k7 existed it was covered by the
self-test and by nothing that ran on the engine.

`k6` is the one case with `provenance.sha256 = null`, and it is guarded differently rather than
loosely: `verify-corpus.mjs` re-derives it from its generator, refuses any mismatch, and decodes it
with the compiler's own decoder to prove every byte is still in-slice. Its reason to exist is
measured: a scan of all of `.text` found 735 self-contained position-independent loops and **none**
containing the 8-bit ALU, adc/sbb, `push r/m`, `leave` and `call rel32` shapes together — and none
at all on the five hot pages. A retail corpus therefore cannot cover a slice.

---

## What this oracle has already found

- **The spike's variant B did not reproduce `movsd`'s ESI/EDI post-increment.** Memory was
  byte-identical (which is all the spike checked), the register file was not:
  `STATE.esi (guest 0x10c318): ref 0x10c240 vs candidate 0x10c230` — exactly 16 = 4 × `movsd`
  × 4 bytes. Fixed in `variant-b/src/lib.rs`; all five variants pass now. *(Those modules are
  gone with the probe directory; `k7` is the in-tree case that keeps this class covered — see
  below.)*
- **Nothing in the tree could still fail that way, and now something can.** Every retail case's
  negative control perturbs a compared data region first, so the register half of the differential
  was only ever exercised in the self-test. `k7 --fault reg-only` closes it end to end, through the
  real dispatcher: `FRAME7 identical`, first divergence `STATE.eax (guest 0x10c300): ref
  0x51eedca7 vs candidate 0x0`, host state `eax` agreeing, and
  `aot: {registered, alive, sameFn, ownsPage, entered} all true, entries: 8001` — so it is an
  AOT-vs-JIT divergence and not a refused unit.
- **A divergence was absent from `gates_failed`.** Equality was the verdict and no gate, so a
  DIVERGENT k3 run published `gates_failed: ["steady_state.reference","tier2Promotions.reference"]`
  — a script gating on that array saw only warm-up noise. `output_identical` is now a differential
  gate, and `evaluateGates()` refuses a gate list assembled without the comparator's result.
- **A registered AOT unit used to be evicted at the first tier-2 promotion** — `entries: 339718`,
  then `ownsPage: true` / `sameFn: false`. Transaction begin now reserves capacity for the whole
  unit and commit atomically marks its pages active without fallible allocation; the steady-state
  gates still refuse any run in which ownership/function identity is lost.
- **`oracle.mjs` accepted `--flags` and dropped it** (design F-d): `--flags "5=0"` ran with dead
  flag elision still ON in both arms and the report said `CORRECT`, with nothing in the JSON
  recording which shape had actually run. Closed by forwarding the shape, by the arms' readback
  refusal, by `--shape-check`, and by the two shape gates.
- **`push` leaked one wasm operand per instruction, and four cases could not see it.** The
  synthetic conformance case (`k6`, `corpus/k6-conformance.mjs`) refused to instantiate:
  `expected 0 elements on the stack for fallthru, found 1`. Root cause: the compiler's port of
  `gen_push32` re-pushed the tee'd new ESP. Wasm discards the operand stack at a `br`, so the leak
  was legal in every block that ends in a branch — k1/k3/k4 contain no `push` at all, and
  compiling each form alone (followed by `ret`) also ends in a `br`. It surfaced only where a
  block falls through into the next one. The oracle reported **INVALID** (`aot.registered: false`)
  rather than a verdict, which is the gate doing its job: memory and register file were identical,
  because the candidate arm had silently run the JIT.
- **A per-rep progress line printed a negative duration and an ungated ratio.** `k6` against the
  offline unit logged `ref -857 ns/outer … ratio -1.58x` — a slope that cannot be a duration —
  while the verdict machinery correctly withheld the number. Nothing *asserted* the invariant the
  slope relies on; `steady_state` happened to catch the condition and blamed warm-up.
  `timing_is_a_rate` now states it, and the progress line prints `NOT A RATE (…): ratio withheld`
  and labels the ratio `(ungated)` when it does print one.
- **The offline `tools/aot` unit for k1 is displaced mid-run** while k3's and k4's are not:
  memory, register file and host state all came out identical, and the run is still **INVALID**
  (`registered: true`, `ownsPage: true`, `sameFn: false`, `entries: 15598`) — the JIT compiled
  the page and recycled the slot, so part of the work was the JIT's. A memory-only diff would
  have called that a pass; this is design §4.2's totality law showing up as a verdict.

---

## Known limits — state them in any report

1. **A `raw:` candidate publishes no host-side state** unless it implements the optional state
   block, so the lazy 5-tuple, x87, XMM and `instruction_counter` go **uncompared** for it. The
   report says so on every line; do not read "CORRECT" as "all channels compared". A `unit:`
   candidate has all of them by construction.
2. **The reference arm pays v86's outer main loop** inside the measured window. A hybrid AOT
   design would keep some of it, so a small part of any ratio is structural, not codegen.
3. **Branches in the corpus are perfectly predictable.** Both arms benefit equally, but the
   absolute ns/iteration is optimistic for both.
4. **The measurement protocol here is the spike's, not `plan/aot-compiler-handoff.md` §3.**
   §3 governs the *in-game* verdict (in-race pause, ABBA within one session, wall-clock over a
   fixed frame count). This stand answers a different question — equivalence, and a per-kernel
   ratio — and cannot substitute for it at gate 2d.
5. Single machine, single V8. Ratios are ratios on this host, not portable constants.
6. **A busy box publishes no number at all.** `spread_pct` refuses at >10 % median-relative
   spread over reps, and a developer workstation running anything else routinely lands at
   12–29 %. That is the gate working; it is not a reason to raise the threshold.
7. **`--flags`/`--relaxed` are refused for a `raw:` candidate**: a foreign module has no codegen
   shape, so the knob would move the reference arm only and the ratio would be a shape
   difference wearing the candidate's name.
