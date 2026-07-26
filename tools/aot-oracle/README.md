# aot-oracle — the differential oracle for the AOT compiler (product B)

**One claim, and it is checkable:** the same guest work, over the same memory image, at the
same guest addresses, through (a) our JIT and (b) a candidate AOT module, must leave **the
guest memory and the architectural register file byte-identical**. Anything else is a bug
report with an address on it.

Runs headless in Node. **No Chrome, no harness, no dev server, no game, no bundle.**

This is the promoted, first-class form of the differential comparison in
`tools/probes/aot-spike/` (a gitignored probe). What was added on promotion is what turns a
stopwatch into an oracle: the **register file is asserted**, not just the output bytes; the
comparator **names the first divergent address/register** instead of printing two hashes; a
candidate can be a **real contract-shaped unit published into v86's dispatcher**; and a run
that fails a validity gate is reported **INVALID rather than as a number**.

---

## Quick start

```sh
cd tools/aot-oracle

node oracle.mjs --self-test                      # the oracle's own logic, milliseconds
node verify-corpus.mjs                           # the corpus is still byte-exact retail code

# correctness only (no number claimed), seconds:
node oracle.mjs --check --case k1,k2 --candidate unit:auto
node oracle.mjs --check --case k1,k2 \
  --candidate "raw:../probes/aot-spike/variant-b/target/wasm32-unknown-unknown/release/aot_spike_b.wasm#b1t"

# a measurement (gates enforced), minutes — machine must be QUIET:
node oracle.mjs --case k1 --reps 5 --outer 40000 --warmup 200000 --warmup-calls 50000 \
  --candidate "raw:.../aot_spike_b.wasm#b1t"

# negative control: prove the oracle detects a divergence it did not create
node oracle.mjs --check --case k1 --candidate unit:auto --fault src-last
```

**Exit codes.** `0` VALID / CORRECT · `2` usage · `3` an arm failed · `4` INVALID (a gate
failed) · `5` DIVERGENT (the candidate computed something else).

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
| `aot.registered` | differential | **always**, incl. `--check` | the unit was refused (content hash / page taken / no slot) ⇒ the candidate arm ran the JIT: this is JIT-vs-JIT, and identical output means nothing |
| `aot.alive` | differential | **always** | the unit was evicted before the end (handoff §2.1(3)) ⇒ the JIT ran an unknown share |
| `aot.entered` | differential | **always** | nothing of the candidate executed |
| `steady_state.{reference,candidate}` | measurement | when a number is claimed | phase2/phase1 outside 1.8–2.25 ⇒ still tiering/compiling; raise `--warmup` / `--warmup-calls` |
| `spread_pct.{reference,candidate}` | measurement | when a number is claimed | median-relative spread over reps > 10% ⇒ noisy machine |
| `tier2Promotions.reference` | measurement | when a number is claimed | 0 ⇒ the reference was measured as **tier-1** code |
| `fastmemLoadsCompiled.reference` | measurement | when a number is claimed | 0 ⇒ paging/RAM setup broke and the reference ran the TLB shape, not production's fastmem |

`aot.alive`/`aot.entered` check **function identity in `wasm_table`**, not "the page points at
our slot" — a freed slot is recycled by the very next compilation, and an earlier version of
that check credited an AOT unit with a JIT module's work (handoff §3). Measured here: a unit
with `ownsPage: true` but `sameFn: false` after 339 718 entries.

---

## Candidate classes

### `unit:<manifest.json>` — a contract-shaped AOT module (the real target)

Exports `f(i32)->()`, imports from `"e"`. Published into a real v86 with
`jit_register_aot_module` + one `jit_aot_flush_tlb()` and entered **through
`wasm_table[idx+1024]`** — the production dispatch path, not a direct export call. The
publication path deliberately mirrors `src/worker/core/cpu/aot-cache.ts`, including both
constraints bought with failed attempts (handoff §2.1): a unit is only replayable in the slot
its bytes were compiled for, and registration must **not** stamp the TLB.

Manifest shape (what the compiler must emit; `unit:auto` writes one):

```json
{ "case": "k1", "jit_flags": {...}, "relaxed_fpu": 1, "engine_sha256": "...",
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

### `raw:<module.wasm>[#mode]` — a foreign module (the spike's variant B)

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

Include `STATE_REGION` — that is what makes the register file part of the assertion. Give the
case at least one fault: a case with no negative control has never been shown to be able to
fail. Then `node verify-corpus.mjs` guards the provenance from drift.

The seed corpus is the spike's two byte-exact NFSU kernels, kept for the reason they were
chosen: **k1** is the tightest self-contained loop on NFSU's hottest page (0x5d3, 156.6M
block-exec / 15 s), **k2** is the x87 class (48 x87 ops, 43 memory operands, one basic block).

---

## What this oracle has already found

- **The spike's variant B did not reproduce `movsd`'s ESI/EDI post-increment.** Memory was
  byte-identical (which is all the spike checked), the register file was not:
  `STATE.esi (guest 0x10c318): ref 0x10c240 vs candidate 0x10c230` — exactly 16 = 4 × `movsd`
  × 4 bytes. Fixed in `variant-b/src/lib.rs`; all five variants pass now.
- **A registered AOT unit is evicted at the first tier-2 promotion** — `entries: 339718`, then
  `ownsPage: true` / `sameFn: false`. Live confirmation of handoff §2.1(3) and of design §6
  prerequisite 1 (`jit_aot_mark_tier2`): **until that lands, every steady-state AOT number
  measures a corpse**, and this oracle refuses to print one.

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
