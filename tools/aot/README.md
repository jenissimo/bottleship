# tools/aot — the AOT compiler (product B), slice 1: **integer-core**

Replaces the source of `AotUnit.bytes`. Everything else in the delivery channel — registration,
content binding, versioning, persistence, multi-page units — already existed
(`plan/aot-compiler-handoff.md` §0) and is untouched.

Normative spec: `plan/aot-module-contract.md`. Chosen architecture and gates:
`plan/aot-compiler-design.md`. Constraints bought with failed attempts:
`plan/aot-compiler-handoff.md` §2.1/§3/§4.

```sh
# 1. capture a compile job from a live reference run (design §S1)
node tools/aot/capture-job.mjs --case k3

# 2. compile + verify + pack (a verifier failure is a refusal: nothing is written)
node tools/aot/aotc.mjs --job tools/aot/jobs/k3.json --out tools/aot/units/k3

# 3. prove it byte-for-byte against the JIT
cd tools/aot-oracle && node oracle.mjs --check --case k3 --candidate unit:../aot/units/k3.json
#    ...and prove the oracle can still fail on this case
cd tools/aot-oracle && node oracle.mjs --check --case k3 --candidate unit:../aot/units/k3.json --fault src-last

# supporting measurements
python tools/aot/capstone-lengths.py > /tmp/lengths.json
node tools/aot/decoder-oracle.mjs --truth /tmp/lengths.json     # lengths vs an independent disassembler
node tools/aot/slice-census.mjs                                 # what the slice covers, and what blocks it
```

## What this producer does differently from the live JIT, and why

Three decisions, each of which removes a hazard the contract names rather than managing it:

| decision | what it buys |
|---|---|
| **TLB memory shapes only** (N45/N46/N40), never fastmem | the module prologue's `fastmem_deopt_jit_unit(<baked slot>)` guard disappears — one of the two sites that bake a wasm table index (§9.1 / handoff §2.1(1)) — and with it every baked `mem8` and `fastmem_generation` constant, because a TLB entry already carries `mem8` folded in. Costs the fastmem read fast path. |
| **indirect terminators leave the unit** — no ret-chaining, no ret-speculation, no `jit_find_cache_entry_in_page` | removes the second baked-index site |
| ⇒ **the body names no slot at all** | checklist **E1** is satisfied by construction instead of by pinning, so `AotUnit.tableIndex` is `null` and the unit publishes into any free slot. The 899-slot pinning budget (open question **O4**) does not bind this producer. |

One value still cannot be known offline: the address of v86's `tlb_data`, a `static mut` the
linker places and the engine exports no pointer to. It is emitted as a **relocation**
(design §S3) — a fixed-width padded LEB the loader overwrites — measured against the live
instance by `lib/tlb-base.mjs` and **re-derived after the run and compared** by the oracle's
`aot.relocations` gate. A relocation is the one place an offline unit can be quietly wrong
about the engine, so it is measured on both sides rather than trusted once.

## Files

| file | role |
|---|---|
| `capture-job.mjs` | live run -> compile job: final in-guest page bytes + sha, the engine's own published entry offsets, `CachedStateFlags`, jit config, engine sha, `tlb_data` base |
| `aotc.mjs` | job -> unit: compile, verify, pack a manifest the oracle's publication path consumes |
| `lib/decode.mjs` | x86 decoder for the slice; anything else is `unsupported` and ends the unit |
| `lib/cfg.mjs` | basic blocks + the dead-flag liveness walk transcribed from `jit.rs:1266-1430` |
| `lib/emit.mjs` | the code generator; every emitter cites the `vendor/v86` function it mirrors |
| `lib/wasm.mjs` | wasm encoder shaped to the contract's A-checklist, with relocation support |
| `lib/verify.mjs` | contract §12 A/B/C/D/E/G as executable checks over the emitted bytes |
| `lib/wdis.mjs` | wasm reader used by the verifier and by the size/shape reporting |
| `lib/tlb-base.mjs` | measures the linker-assigned address of `tlb_data` |
| `decoder-oracle.mjs` + `capstone-lengths.py` | decoded instruction LENGTHS vs an independent disassembler |
| `slice-census.mjs` | coverage of the slice over NFSU's hot pages, and the ranked reasons it stops |

## Why the flag protocol is transcribed and not reinvented

The differential oracle compares the **raw lazy 5-tuple**, not just `get_eflags()`. So the unit
must not merely be architecturally correct — it must leave the same `last_op1 / last_result /
last_op_size / flags_changed / flags` the JIT would have left, including the same **dead-flag
elision decisions** (idx 5 is ON in production). `lib/cfg.mjs` therefore mirrors
`classify_flag_class` / `should_elide_current_flags` instruction for instruction, and inherits
its safety condition verbatim: only a **non-faulting** full overwriter proves the flags dead
(contract N27 / checklist C5). Being *more* conservative than the JIT is not a safe default
here; it is simply a different tuple.

Conditions use v86's **unfused** (`Instruction::Other`) arms — the same predicate computed from
the same memory-resident tuple — so each instruction is independently correct rather than
correct-in-a-sequence.

## Known structural gaps (perf, not correctness)

1. **Back edges that are not a single-block self-loop re-enter the dispatcher** (`local.set 0` +
   `br $main`) instead of becoming a wasm `loop`. v86 runs `control_flow::loopify`; this slice
   only special-cases the self-loop. Visible on `k4`, whose two outer loops pay a dispatch per
   iteration.
2. **No fastmem, no push-run coalescing, no ret chaining** — all three are deliberate (see the
   table above) or simply not yet written.
3. **A hole is "rest of page", not "one instruction"**, because the decoder returns no length
   for an instruction outside the slice, so the linear sweep cannot resume after it. The fix is
   a length-only decoder for the whole ISA; until then an out-of-slice instruction inside a hot
   loop costs the whole page (design §4.2, "one hole costs the whole page").
