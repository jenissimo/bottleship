# tools/aot — the AOT compiler (product B), slice 1: **integer-core**

**Slice contents (2026-07-29).** 32-bit and **8-bit** mov / ALU / shift / rotate / test /
inc-dec-not-neg, `adc`/`sbb` at both sizes, `lea`, `movzx`/`movsx`, `setcc`, `cmovcc`,
`push`/`pop` in the register, immediate and r/m forms, `xchg`, `leave`, `cwde`/`cdq`, moffs
`mov`, `bswap`, `bsf`/`bsr`, `clc`/`stc`/`cld`/`std`, **`imul` in all four forms** (`0F AF`,
`69`, `6B`, `F7 /5`) and **`mul` (`F7 /4`)**, `Jcc`/`jmp`/`ret`, `call rel32`, the
**`loop`/`loope`/`loopne`/`jecxz` family (`E0`–`E3`)**, and the **indirect near `call`/`jmp`
(`FF /2`, `FF /4`)** in both the register and the memory form. On NFSU's five hot pages that is
**92.6 %** of decoded instructions, **88.5–94.8 % per page** (`slice-census.mjs`; 71.9 % before
the 8-bit family, adc/sbb, `push r/m`, `leave` and `call rel32`, 89.7 % before the indirect
terminators, 91.5 % before the `loop` family and the multiplies). No x87, no SSE, no string ops,
no prefixes, no `div`/`idiv`, no `OUT`/`IN` — an out-of-slice instruction ends the unit and exits
to the dispatcher, which degrades performance and never correctness.

**The `loop` family bought no hot-page coverage, and saying otherwise would have been the census
lying.** `slice-census.mjs` ranked `0xE0` third (28 sites) among the rejects, which is why the
family was added — but the census is a linear sweep with **1-byte resync**, so a reject count is
partly data and padding. With `E0`–`E3` in the slice, `decoder-oracle.mjs` (6720 instructions,
lengths agreeing with capstone 6720/6720) finds **zero** `loopcc` in the same five pages: the 28
"sites" were contamination, and the measured coverage gain is `imul` (16 `imul3` + 8 `imul_rm`) and
`cld`/`std` (10). The family stays in because it is real x86 on the branch core and because it is
what makes k6 contain self-loops at all — which is what first makes the B7 loop-head guard and its
EIP store reachable in this corpus — **not** because it moved a per-page number.

`div`/`idiv` are the one family deliberately left out of the *arithmetic* core rather than merely
not reached yet: they can raise `#DE`, which needs the `trigger_de_jit` exit shape (contract N67)
this slice does not emit, and the 8-bit forms additionally reach an interpreter helper that reads
`previous_ip` (N26 / checklist C5). `cmc` (`0xF5`) is out for a different reason — v86 lowers it
as flush → `call instr_F5` → reload, the one shape in the fallback ladder (design §4.3 row 1)
this producer has no emitter for yet.

The indirect terminators are the first members of the slice whose successor is a **run-time**
value, so they are lowered as the contract's terminator row (§4.3): compute the target, write an
absolute EIP, `br exit`. That still names no wasm table slot — no ret-chaining, no
ret-speculation, no `jit_find_cache_entry_in_page` — so E1 keeps holding by construction. `FF /2`
additionally publishes its **return point** as an entry, because the guest is guaranteed to come
back to it and a return that dispatches to a miss is what lets the JIT displace the unit
(design §4.2); `aotc.mjs` reports `callReturnPointsUnpublished` so that condition is visible
instead of surfacing later as an unexplained `aot.alive=false`.

Replaces the source of `AotUnit.bytes`. Everything else in the delivery channel — registration,
content binding, versioning, persistence, multi-page units — already existed
(`plan/aot-compiler-handoff.md` §0) and is untouched.

**Bounded exit (contract B7 / N18) is emitted and checked**, at both of the engine's sites: the
module top inside `loop $main` (`jit.rs:3377-3389`) and every single-entry loop head, whose EIP low
bits are stored unconditionally first (`jit.rs:4131-4149`). `LOOP_COUNTER = 100_003` (`cpu.rs:290`).
This is a preemption-**correctness** property here, not a throughput one: BottleShip's quantum is
observed only *between* module entries (N30), so it is the only bound on preemption latency inside a
unit — and a unit that never yields also flatters its own FPS window.

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

# 3b. both halves for the WHOLE corpus in one command, with the unit producer under test rather
#     than `unit:auto` — this is the artifact a slice report carries
cd tools/aot-oracle && node oracle.mjs --prove --case k1,k3,k4,k5,k6,k7 \
    --candidate 'unit:../aot/units/{case}.json'

# supporting measurements
python tools/aot/capstone-lengths.py > /tmp/lengths.json
node tools/aot/decoder-oracle.mjs --truth /tmp/lengths.json     # lengths vs an independent disassembler
node tools/aot/slice-census.mjs                                 # what the slice covers, and what blocks it
node tools/aot/module-stats.mjs units/k4.0.wasm jobs/k4.jit.wasm # our module vs the JIT's, same page
```

## How the B7 bound is proven rather than asserted

A guard that never fires is indistinguishable from a guard that is wrong. `--loop-bound N` lowers
the bound so a short kernel **reaches** it; the differential stand then shows the guard is taken
(the ratio degrades monotonically as the bound falls, because each firing costs a re-dispatch) and
that taking it changes nothing (`CORRECT`, memory and state identical). The value is recorded as
`loop_counter` in the manifest and pinned by the verifier, so an experiment-only bound cannot ship.

```sh
node tools/aot/aotc.mjs --job jobs/k5.json --out /tmp/k5-b8 --loop-bound 8
cd tools/aot-oracle && node oracle.mjs --check --case k5 --candidate unit:/tmp/k5-b8.json
```

Measured on k5, one session, four bounds — `CORRECT` at every one, ratio monotone:
`100003 → 1.05x · 512 → 0.93x · 64 → 0.84x · 8 → 0.45x`. The guard is taken and taking it costs a
re-dispatch and changes nothing.

**What that experiment immediately found** — a latent wrong-EIP bug that the production bound hides.
Our static back edges re-enter the dispatcher with `local.set 0; br $main`; the module-top guard can
exit from there, and no epilogue writes EIP (N25), so the guest resumed at a stale address: k4 with
the bound at 8 panicked `Unimplemented: #GP handler` out of `trigger_fault_end_jit`. The engine never
had the bug because both of *its* re-dispatch sites follow a dynamic EIP it reads back with
`gen_get_eip` (`jit.rs:3567-3577`, `:3581-3595`). The fix is one EIP store per back edge; check
**C4b** now refuses a re-dispatch without it, and the same store makes the `brtable_default` clean
exit (N16) safe as well.

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
| `module-stats.mjs` | self-checking size/shape histogram of any module body (hard-fails on decode drift, so it cannot report a plausible number for a body it mis-read); the instrument for "what did a pass actually remove" |
| `lib/tlb-base.mjs` | measures the linker-assigned address of `tlb_data` |
| `decoder-oracle.mjs` + `capstone-lengths.py` | decoded instruction LENGTHS vs an independent disassembler — and, via its kind histogram, the only honest counter of which forms REALLY occur (the census's reject counts are contaminated by the 1-byte resync) |
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

## Why the indirect terminators needed the conformance vector extended

`k6` gained four stages — `call reg`, `call [mem]`, `jmp reg`, `jmp [mem]` — because the retail
kernels contain none, and because these are the only forms in the slice that **exit the unit and
re-enter it**: the dispatcher has to find a published entry at the computed address, so a unit
that published the wrong return point fails here as `aot.alive=false` rather than as a wrong
value. Every target is derived from a `call +0` return address, so the stages are
position-independent (the body is emitted after a wrapper prologue whose length is not the body's
business).

**Two things that only running it revealed.** First, `pop` after `call +0` yields the address of
the `pop` itself, not of the following instruction — the existing `call +0; pop edx` pair in the
vector never used the value, so the off-by-one only surfaced as the guest executing zero bytes
(`instr_00_mem` → `#PF` → `Unimplemented: #GP handler`) in the REFERENCE arm. Second, and worse:
with the stages written the obvious way, an emitter that pushed `next + 1` as the return address
still verified **CORRECT**, because each stage pops the return address into `edx` and the next
stage overwrites it. The two `add [ebp+0xc], edx` folds exist to make the pushed address a
compared value; with them the same injected fault is `DIVERGENT … ref 0x20c34d vs candidate
0x20c34f`. A form that is executed but never observed is not covered.

## Why the corpus grew two cases

`k1`/`k3`/`k4` contain **not one** 8-bit ALU instruction, no `adc`/`sbb`, no `push r/m`, no
`leave` and no `call`. A slice cannot be verified by kernels that do not contain it, so the
oracle's corpus gained:

- **`k5`** — a byte-exact retail kernel (`0x674b94`, the charset-bitmap builder) for the 8-bit
  load / 8-bit shift-by-CL / **byte** read-modify-write / 8-bit self-test shapes;
- **`k6`** — a **synthetic** conformance vector (`corpus/k6-conformance.mjs`): every form the
  slice claims, once, **257 instructions in 881 bytes** (135 before stage 2). It is labelled
  synthetic and carries no retail provenance; `verify-corpus.mjs` guards it by re-deriving it from
  its generator and re-decoding it with this compiler's own decoder instead of hashing it against
  the binary.

  **Stage 2** (added with `imul`/`mul`/`bswap`/`bsf`/`bsr`/`cmovcc`/`clc`-`stc`-`cld`-`std`/the
  `loop` family) is where the vector stops being straight line: four self-loops and two forward
  `jecxz` branches, which is also what first makes the B7 loop-head guard and its EIP store
  reachable in this corpus. Each multiply form appears twice, once non-overflowing and once
  overflowing, because CF/OF is a *predicate* over the 64-bit product (`gen_imul3_reg32`,
  `gen_mul32`) and one operand pair covers only half of it. DF is landed **only** in the raw
  `flags` word, which is the point of C14: nothing else can observe it.

  **Two things stage 2 measured about the vector itself.** Written in its natural place — before
  stage 1's register landings — it silently **killed the case's negative control**: `--fault
  src-first` still reported `CORRECT`, because stage 2 re-seeds every GPR and the only carrier of
  the perturbation had been overwritten before anything stored it. It runs after those landings for
  that reason. And every stage-2 result goes to a slot written exactly once: a slot a later
  instruction overwrites is not a compared value, the same hole the `FF /2` return address had.

A scan of all of `.text` (735 candidate self-contained loops) found no retail loop that carries
those forms together, and none at all on the five hot pages — which is why the synthetic vector
exists rather than a sixth kernel.

**What that vector immediately found:** `gen_push32`'s port re-pushed the tee'd new ESP, leaking
one wasm operand per `push`. Wasm discards the operand stack at a `br`, so the leak was legal in
every block that ends in a branch and only became an instantiation failure in a block that falls
through — invisible to k1/k3/k4 (no pushes) and to per-form validation (a single instruction plus
`ret` ends in a `br`). `verify.mjs` now runs `WebAssembly.validate` as check **A0** so the class
is refused at build time rather than at publication time.

## Checklist coverage: 38 executable checks, and what is still by hand

`A0 A1 A1b A2 A3 A4 A5 A6 A7 A8 A9 · G9a G9b G9c G9d · B1 B2 B3 B4 B4b B4c B5 B6 B7 ·
C1 C2 C3 C4/D9 C4b C5 C6/C7 C14 · D4 D5 D7pre D7 · E1 E2`.

**C5 (N26) is new, and it is the check that keeps the slice honest as it grows.** `previous_ip` is
owed only to a potentially-faulting *interpreter* helper — the `*_jit` triggers rebuild EIP from a
compile-time immediate and never read it. This slice discharges the item by proving the premise
false: every function import is either on an explicit non-faulting allowlist that carries a reason
per name (`abi.mjs HELPERS_NONFAULTING`) or a member of the two-phase `#PF` family. An import
outside both is a **refusal**, so the next slice cannot silently acquire the obligation by adding
one helper call. Proven by injection: drop `bsf32`/`bsr32` from the allowlist and k6 reports
`FAIL C5: 26 imports … (unclassified: bsf32, bsr32)`.

**C14 (N106) is new**, and it closes one of the two checklist items the contract singles out as
able to produce a silent WRONG RESULT rather than a refusal: an authoritative `flags` write that
rebuilds the word instead of read-modify-writing it clears **DF** and **IF**, which no
guest-memory diff and no `get_eflags()`-only flag diff can see. It is proven by injection — with
`clearFlagsBits` rewritten to store a computed word, k3 reports `1 rebuild the word: +351` and k6
reports 15.

### What writing C14 measured about instruments keyed on constants

Two earlier versions of the check were wrong in the project's classic way — a plausible number
about something other than its label — and both were caught by running them, not by review:

1. **"an `i32.const` whose value is 120 is a `flags` address"** reported two flags writes on k4
   that are the `start_of_current_instruction & 0xFFF` argument of a slow-helper call, for an
   instruction at page offset 0x78.
2. **last-in-first-out pairing of address pushes to CPU-state stores** reported 5 "unpaired"
   pushes on k3, 12 on k4: `64` is both `reg32[0]` and `FLAG_ZERO`, and the masks are indexed by
   the same integers as the state addresses.
3. **`C6/C7` had the identical bug and it took a THIRD instance to be caught** — a *refusal* this
   time, not a false pass. It scanned every `i32.const` for an FP-state address and rejected k6
   because a slow-write helper's `start_of_current_instruction & 0xFFF` argument for the
   instruction at page offset **0x278** is the integer **632**, which is also `fpu_simd_dirty`.
   Same class as (1), a year of comments about (1) in this very file, and it still shipped: a
   constant-keyed instrument is *structurally* unable to tell an address from an arithmetic value.

So the check now resolves the operand stack (`resolveAccessAddresses`) and asks which instruction
produced each access's ADDRESS operand. The model covers exactly the opcodes this producer emits
and reports `unmodelled` — failing the check — on anything else, so it cannot mis-read a body it
does not understand. That resolver is reusable: it is what would let C1/C2 become the per-path
dominance queries design H15b asks for, instead of `>= 2` count proxies — and it is now shared by
C14 and C6/C7 rather than reimplemented per check.

`C6/C7`, `C8`, `C9`, `C12` and `C13` are discharged by **proving their premise false** rather than
by verifying the obligation: `C6/C7` asserts that no **access** in the body targets any FP-state
*range* (`fpu_st` is 8×16 B and `reg_xmm` is 8×16 B, so a word test is not enough either), so the
unit owes no x87/SSE write-back and no `fpu_simd_dirty` (contract §10 C14's pattern). `C5` does the
same for `previous_ip`, and `C4/D9`/`C4b` for EIP: single-page, every EIP write preserving the high
20 bits except a RET's absolute one, which must branch straight to the exit.

Still unchecked, and therefore by hand: `A10` (moot — no custom section is emitted, `A9`),
`C10`, `C11`, `D1`, `D2`, `D3`, `D6`, `D8`, `D10`, `E3`–`E10`, `F1`–`F5`, `G1`–`G5` (the oracle's
job). Each new check was verified to FAIL on an injected fault before being trusted — B7 with the
guard removed at either site, C3 with a zero counter credit, C4 with the high-bit mask dropped, C4b
with the re-dispatch EIP store removed, C5 with `bsf32`/`bsr32` dropped from the non-faulting
allowlist, C6/C7 with a `fpu_simd_dirty` store spliced into the flush, E2 with a page inside the
thunk bucket, G9d with `tlb_data` baked as a memarg offset instead of relocated.

## Size and shape versus the JIT, same page

`module-stats.mjs`, all six corpus cases (`.jit.wasm` = the JIT's own module for the same page,
captured by `capture-job.mjs`):

| page | JIT bytes / ops / plumb% | unit bytes / ops / plumb% |
|---|---|---|
| k1 | 5794 / 2488 / 53.3 % | 3404 / 1552 / 54.0 % *(not total — x87 hole, see gap 3)* |
| k3 | 1261 / 377 / 56.0 % | 1063 / 412 / 53.9 % |
| k4 | 3610 / 1503 / 55.6 % | 3861 / 1775 / 54.5 % |
| k5 | 1465 / 447 / 56.6 % | 1214 / 455 / 55.6 % |
| k6 | 20694 / 9647 / 55.3 % | 20212 / 9570 / 55.4 % |
| k7 | 1234 / 380 / 53.7 % | 957 / 377 / 53.3 % |

Two readings worth stating. **Plumbing share does not move** — 53–56 % on both sides, which is
design §0.1 F-a's finding reproduced by an in-tree instrument: it is a property of the
memory-convention ABI, not of the emitter, so no pass that only removes ops will move it. And
**op count is at parity or slightly worse**, expected from the two deliberate divergences: no
`loopify` (gap 1 — k4's `+272` ops are its two dispatcher-mediated outer loops) and no fused
flag fast paths (we always take v86's unfused `Instruction::Other` arm).

The **imports** column is where the two producers differ structurally rather than by a few percent:
on k6 the unit declares 26 against the JIT's 29, and the three it does not declare are
`fastmem_deopt_jit_unit`, `jit_find_cache_entry_in_page` and
`jit_find_cache_entry_for_dynamic_chaining` — i.e. exactly the two baked-slot consumers plus the
chaining helper. That is checklist **E1** visible as a measurement instead of as a claim.

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
   **This is what `k1` measures, and why its oracle verdict is INVALID rather than CORRECT**: its
   `fild`/`fstp` pair is outside the slice, the unit ends there, the guest heats the x87 address
   interpreted, the JIT compiles the page and displaces our unit (`aot.alive`/`aot.entered` both
   false). Memory, the register file and the host state still come out identical — the failure is
   of ATTRIBUTION, not of the result, which is exactly the degradation the design promises. It
   cannot be fixed inside an integer slice; it needs either x87 coverage or the helper-and-exit
   fallback of design §4.3 (which needs whole-ISA lengths, gap 3).
4. **The read-before-push order of `call dword [mem]` is unverified by execution.** v86 resolves
   and reads the target FIRST and only then pushes the return address
   (`jit_instructions.rs:4453`), so a `#PF` on the read leaves ESP untouched and the instruction
   is restartable (contract N62a); the lowering mirrors that order, but the corpus contains no
   fault-bearing kernel, so only a decommitted-page case (contract O10 / gate G3) can distinguish
   the two orders. Injecting the wrong order today produces a wild jump and a dead arm, which
   proves the arm is sensitive to *something* and not that the order is right.
5. **What is left of the branch/arithmetic core**, in the order the census ranks it: the
   **`0x66`/`0x67` prefixes** (32 sites — the whole 16-bit operand/address family, and the largest
   remaining non-x87 block), the **`rep`-prefixed string ops** (`0xF3` 21 + `movsd`/`scasd` 25),
   **`IN`/`OUT`** (33 — deliberately out; a trap ends the unit by design, contract N79/N93),
   **`div`/`idiv`** (the `#DE` shape), **`cmc`** (the helper-bracket shape), and `shld`/`shrd`,
   `bt`/`bts`/`btr`/`btc`, `xadd`, `cmpxchg`, `enter`. Everything above `0xd9`/`0xd8`/`0xdf`/`0xdd`/
   `0xdb` in the reject ranking is now x87 (329 of the 573 remaining rejects) plus data
   contamination (`0xc4`, `0xcc`), which is the census saying the same thing design §4.1 does:
   inside an integer slice there is little coverage left to buy.
