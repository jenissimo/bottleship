# Guarded fast-path kernels: census and A/B on Morrowind (2026-09-12)

Negative result. The four guarded kernels (`bulk_memory`, `rep_memory`, `unaligned_memory`,
`string_memory`) fire tens of millions of times during a Morrowind load and produce **no
measurable change in wall clock**. Both paired series put the difference inside the noise,
and both point marginally the wrong way.

## Census first, not a guessed workload

Every kernel carries a hit/decline ledger, so the first question is not "how much faster"
but "is this path touched at all". `kernelLedgers` answers it; on a full Morrowind load:

| kernel | hits | composition |
|---|---:|---|
| `string_memory` | 26 741 448 | `stricmp` 26 736 677, `strcpy` 4 771, 2 845 declined |
| `rep_memory` | 17 862 858 | `scas` 17 808 220, `stosd` 51 086, `cmps` 3 552 |
| texture (DXT/pixel) | 8 138 | convert 7 823, decode 315, SIMD variant loaded |
| `bulk_memory` | 0 | never called |
| `unaligned_memory` | 0 | every operand aligned |

Two facts worth keeping:

- **`strlen` is 0 while `scas` is 17.8M.** Morrowind does not call the CRT `strlen`; the
  compiler inlined it as `repne scasb`. String length is therefore caught by the REP kernel,
  not the string kernel. No trace could have shown this: the REP kernels run inside guest
  instruction execution and never cross the dispatcher, so they appear in no thunk bucket.
- **`bulk_memory` is dead here.** The guest inlines its copies as `rep movs`, which already
  ran as one bulk copy before any of this work. A different title is needed to exercise it.

## Method

Both arms are the same binary with the kernels flipped through `kernelSwitch`, so no build
difference can be mistaken for the effect. The endpoint is a fixed count of retired guest
instructions, which is a property of the guest rather than of our speed, so both arms stop
after identical work and only the clock differs. The off arm is verified by its ledger
reading exactly zero.

The measured window excludes the first 1e9 instructions: that phase runs at ~42 MIPS because
the guest is streaming a 2 GB bundle with a cold JIT, and timing it measures disk.

## Result

| series | ON median | OFF median | delta | worst spread |
|---|---:|---:|---:|---:|
| segment 1e9, n=6/arm | 4 597 ms | 4 481 ms | +2.6% | 15.0% |
| segment 2e9, n=5/arm | 28 530 ms | 28 029 ms | +1.8% | 5.4% |

Positive delta means the kernels were slower. Both are inside the 3.6% noise floor and well
inside the run-to-run spread, so the sign carries no information. One emulator tab, host CPU
idle at 8%, so this is not contention.

The honest reading: whatever the effect is, it is **under a few percent** of a CPU-bound load
segment on the title where these kernels fire hardest.

## Why, most likely

The operands are short. Morrowind's `stricmp` compares record identifiers and its `scasb`
scans small strings, so a call spends most of its time in the residency probe and the
dispatch around it rather than in the vector body that replaces ten byte reads. The upstream
microbenchmarks that motivated this work used 4 KiB and 1 MiB spans in a loop, where the
guard is amortised to nothing; that is the ratio that does not transfer.

## Two instrument bugs found here, both worth not repeating

1. `retired()` defaulted an unreadable counter to 0, so the next wrap-safe delta was ~4.3e9
   and satisfied any target instantly — with a perfectly plausible elapsed time attached.
   An unreadable sample must report no progress, never invent it.
2. `retired()` counts from the start of its own wait, so after a warm-up the second target
   means "this many more", not "up to this total". Read as cumulative it silently measured a
   window three times the intended size.

## What would change the verdict

- A title that exercises `bulk_memory` at all: it never ran here, and large `memcpy`/`memcmp`
  is where the guard amortises. Candidates are software-blit DDraw titles and anything doing
  its own decompression through the CRT.
- Long strings rather than identifiers.
- An in-race measurement rather than a load: this says nothing about frame time.

Until then the kernels are correct, gated and free to leave enabled, but **no performance
claim is supported by this data**.
