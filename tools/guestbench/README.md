# guestbench — synthetic guest fixtures for the SOTA roadmap

`docs/performance/sota-roadmap/README.md` makes a perf fixture mandatory for every lever:
fixed work, a deterministic checksum, no sleep or frame limiter, a SCALE knob so the model
`ms = fixed + k × SCALE` can be checked, and — the part that has actually bitten this
project — the fixtures living **in this repository**, because a demo on one machine cannot
compare two branches.

That is what this is. The guest code is emitted from JS (`lib/asm.mjs`), so a fixture is a
few dozen lines, its instruction mix is exact by construction rather than by whatever a
compiler decided, and no C++ toolchain is in the loop. Each fixture runs as a multiboot
image under `vendor/v86/build/libv86.mjs`.

```
bun run guestbench list
bun run guestbench stack_mix --mix 80 --iterations 200000 --repeat 5
bun run guestbench x87_chain --scale chain=2,4,8,16 --repeat 3
bun run guestbench stack_mix --census          # the class table the run actually produced
bun run guestbench vcall_dense --dispatch      # the module-exit split
bun run guestbench stack_mix --ab mix=20 mix=80 --repeat 5
bun run guestbench:verify                      # every fixture against its own declaration
bun run guestbench stack_mix --mix 80 --stack-raw   # roadmap-02 ceiling arm (unsound; see below)
bun run guestbench heap_walk --raw-all              # roadmap-03 ceiling arm
```

## The `--stack-raw` / `--raw-all` arms

Roadmap items 02 and 03 both prescribe measuring the ceiling — what the accesses cost with
NO permission check — before writing the guard or the bitmap. `set_stack_raw_unsafe` in
`vendor/v86/src/rust/codegen.rs` is that measurement: mode 1 compiles ESP/EBP-relative
32-bit reads raw, mode 2 every flat 32-bit read.

It is **unsound on purpose**. It drops the present/writable/has-code checks, so a
decommitted page reads as garbage instead of faulting. It is default-off, exists to be
switched on for a synthetic fixture and switched off again, and must never be armed for a
game. The measured results and their caveats live in the two roadmap files.

## The fixtures

| fixture | roadmap | what it isolates |
|---|---|---|
| `stack_mix` | 02, 03 | memory operands with a tunable stack-relative share (`--mix 20\|50\|80`) |
| `heap_walk` | 03 | a dependent pointer chase across scattered pages — no locality to exploit |
| `branchy` | 06 | a small hot core inside a large, genuinely reached cold branch tree |
| `vcall_dense` | 07 | one indirect call per iteration over three implementations |
| `flags_dense` | 04 | ALU ops separated by stores, maximising lazy-flag reloads |
| `x87_chain` | 05 | long register-form x87 chains between one load and one store (`--chain`) |

## Why every run has two passes

v86 promotes a page only after `JIT_THRESHOLD` retired instructions, so a single-pass
measurement is a blend of interpreted and compiled execution whose ratio depends on the
fixture's size. Each fixture therefore runs its loop **twice** over the same emitted code,
with an `OUT` at the boundary; the numbers reported are the second pass, and the warm-up is
printed separately rather than averaged in.

## What `verify` checks, and why

`bun run guestbench:verify` is the fixtures' own instrument-can-fail check. For each one it
asserts:

- the census reproduces the fixture's declared `perIteration()` mix exactly — this is what
  stops a fixture drifting from its description and silently steering a decision, which is
  precisely how the previous campaign chose its target;
- the addressing census and the opcode census, produced independently, agree on how many
  memory operands ran;
- the checksum is **stable** across repeated runs (or no A/B using it means anything);
- the checksum **changes** when a parameter changes the work (or it cannot tell an arm that
  did the work from one that skipped it).

It has already earned this: it caught `branchy` entering only one of its sixteen cold arms
(so `--coldArms` changed the image but not the run) and `x87_chain` declaring one x87 store
where it emits two.

## A denominator caveat worth knowing

`cpu.instruction_counter` is **not** an exact retired-instruction count. The JIT credits
`block.number_of_instructions` per block *execution*, and on these fixtures that runs
exactly one ahead per iteration on every single-block loop — a five-instruction loop is
credited six. Any per-instruction rate derived from it (the census's `coveragePct`, the
dispatch report's `exitsPerKiloInsn`) is therefore biased by roughly `1/blockLength` on
tight loops: comparable between arms, not absolute.

## Reading a result

`--ab` prints both medians and both spreads and deliberately declares no winner. Run
`--ab` with the *same* spec twice first: that is this machine's noise floor for this
fixture in this session, and a delta below it is a direction, not a result. The protocol the
roadmap states (fresh load per arm, alternating order, N ≥ 5, raw values recorded) applies
here as it does to a game run.
