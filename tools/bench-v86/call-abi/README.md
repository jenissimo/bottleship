# call-abi — standalone Wasm call-shape microbenchmark

What a guest CALL/RET costs as a real Wasm call, by how the eight guest registers cross the
call and by where the callee lives:

| Arm | Callee | Registers |
|---|---|---|
| `same-call-mem` | same module, `call` | linear memory |
| `same-call-reg` | same module, `call` | 8 params, 8 multi-value results |
| `other-indirect-mem` | other module, `call_indirect` through a shared table | linear memory |
| `other-indirect-reg` | other module, `call_indirect` | params/results |
| `other-import-mem` | other module, imported function | linear memory |
| `other-import-reg` | other module, imported function | params/results |
| A/A | second instance of `same-call-mem`, identical bytes | noise floor |

No v86 is involved. This isolates the Wasm call shapes; it does not include the page-JIT
dispatch or state protocol, so it is not a measurement of what a function tier would remove
there, and it does not select a shipping ABI on its own.

## Work and state checks

The leaf does `r0 += r1; r2 += r3; r7 += 1`. From the reset state `r[i] = 3i + 1`, the state
after `n` calls is known in closed form: `r7 - 22` is the call count, `r0` and `r2` are two
independent checksums. Every timed run is checked against it, and a mismatch aborts the run.

`expected.json` holds the sha256 of every generated module and the expected state at
`n = 0, 1, 1000, 1000003`. `wasm/` holds the generated modules; `--check` verifies that the
generator, `wasm/` and `expected.json` agree and that every arm reaches the expected state.

## Commands

```sh
node tools/bench-v86/call-abi/bench.mjs --check
node tools/bench-v86/call-abi/bench.mjs --rounds 8 --n 1000000,2000000 --warmup 5 --json out.json
node tools/bench-v86/call-abi/bench.mjs --emit wasm          # regenerate wasm/
node tools/bench-v86/call-abi/bench.mjs --write-expected     # regenerate expected.json
```

## Timing

Per round, every arm is timed at `n` and `2n`. The slope `(t(2n) - t(n)) / n` is the cost per
call with the loop's fixed cost cancelled. Rounds alternate the arm order (forward, reversed)
so every arm sees both positions. Output: node and V8 version, flags, warmup, every raw
`t(n)`/`t(2n)` per round and arm, the slope per paired round, and per arm the median, min,
quartiles, max and the number of negative slopes. Nothing is filtered. `--json` writes the
same raw data plus module hashes and sizes.

A result is only meaningful on an idle machine, with the A/A spread as the noise floor, and
with normal tiering as the primary arm. Forced TurboFan or disabled inlining (V8 flags) explain
the mechanism; they are not the result.

## Not covered yet

- Live-register / clobber-set variants (fewer than eight registers crossing the call).
- A leaf large enough that the result does not depend on a trivial callee being inlined.
- The checked return/ESP and re-dispatch loop, an unexpected return target, the context-epoch
  failure path, the depth cap across nested guest execution.
- An iOS run under the notail policy (correctness and cost).
