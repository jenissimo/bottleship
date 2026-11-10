# flat-pair — flat, call-dense guest code, paired against Emscripten

`source-pair` measures tight kernels (k1–k6). Real games are flat: Half-Life 2 runs hundreds
of code pages at ~5.9 instructions per block with a module exit every ~22 instructions. This
lab produces that shape on purpose and runs the SAME C/C++ source through every arm:

```
gen.mjs (seed, shape) ─► workload.cpp ─┬─ MSVC x86 /O2 /arch:IA32, freestanding PE ─► current v86 JIT, headless Node   (arm A,  "v86")
                                        ├─ clang i686 -O3 -mno-sse, same PE wrapper  ─► current v86 JIT                  (arm A', "llvm-v86")
                                        ├─ Emscripten -O3 -fno-vectorize -fno-slp-vectorize ─► Wasm in the same Node/V8 (arm B,  "em")
                                        └─ the SAME MSVC / clang objects natively on the host                           (arm C/C', "native"/"llvm-native")
```

No Chrome, no harness, no dev server, no Win32 HLE. The engine is the MAIN checkout's
`vendor/v86/build/{libv86.mjs,v86.wasm}` (found via `git rev-parse --git-common-dir`;
override with `V86_ENGINE_DIR`), run with the shipping JIT shape from
`tools/jit-config/shipping.mjs`, applied and read back through `tools/aot-oracle/lib/engine-unit.mjs`.

## Commands

```powershell
node build.mjs                        # tight, medium, flat  (+ any "name=preset,key:value,..." spec)
node build.mjs "flat-dfs=flat,order:dfs" "flat-n60=flat,nfunc:60" "flat-n600=flat,nfunc:600" "flat-n18k=flat,nfunc:18000" "flat-s8=flat,size:8"
node build-lua.mjs                    # Lua 5.4.9 workload (needs third_party/lua, below)
powershell -File campaign.ps1         # every measurement below, pinned; results in out/results/*.json
```

Pieces: `bench.mjs` (paired timing), `characterize.mjs` (instrumented JIT readout), `probe.mjs`
(one-off calibration). Single runs: `node run-v86.mjs --exe out/flat/flat.exe --warm 4 --lo 20000
--hi 80000 --reps 4 [--flags "4=1"] [--dispatch] [--census]`, `node run-em.mjs --mjs out/flat/flat.mjs ...`.

Arm spec for `bench.mjs --arms`: `v86`, `v86[idx=val,...]` (JIT config override),
`v86{switch=val}` (codegen switch), `v86@liftoff` / `v86@tf` (V8 tier flags for that process),
`llvm-v86`, `em`, `native`, `llvm-native`; `#label` makes an identical second arm (A/A control).

### Lua download step (not committed)

The Lua workload uses the official Lua 5.4.9 release (MIT), unmodified:

```powershell
# https://www.lua.org/ftp/lua-5.4.9.tar.gz  sha256 2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6
curl.exe -L -o third_party/lua/lua-5.4.9.tar.gz https://www.lua.org/ftp/lua-5.4.9.tar.gz
tar -xzf third_party/lua/lua-5.4.9.tar.gz -C third_party/lua
```

`build-lua.mjs` checks the tarball hash. Lua is compiled against `src-lua/` — a small mini libc
(own headers, allocator, printf/strtod, libm) used by EVERY arm, `bs_luacfg.h` (C89 numbers:
32-bit `long` integers, `double` floats; `LUAI_TRY` = plain call since the scripts raise no
errors and use no coroutines; fixed hash seed) and `bench.lua`, a deterministic mix of
recursion, metatables/methods, string library, sort with a comparator, closures, exact floats
and string-keyed tables. Printed output is hashed into the checksum.

## Protocol

Driver (`src/driver.cpp`, identical in all arms): read config, `warm` passes of the hi phase,
then `reps` × (reset, mark, lo steps, mark; reset, mark, hi steps, mark). Each phase starts from
`wl_reset(seed)`, so lo and hi walk the same route prefix and
**slope = (t_hi − t_lo) / (n_hi − n_lo)** is the cost of the extra steps alone (fixed costs
and the reset cancel). One run's value is the median slope of reps 2..n. `bench.mjs` runs every
arm as its own process, in ABBA order, `--rounds` times; reports median, (max−min)/median
spread, and the A/A ratio when an arm is listed twice. Checksums of every run of every arm must
agree, or the table prints `*** DISAGREE ***`.

v86 arm validity: the PE is mapped at its fixed base with a 4 KiB identity page table and
CR0.PG on (production shape; fastmem needs paging). `characterize.mjs --census` (tier-2
threshold 2^31: compiled modules credit retired instructions, never promote) gives the share of
retired instructions executed in compiled code; `measuredCompiles` (from cpu.js
`__jitCompileStats`) must be 0 inside the measured reps.

## Generator (`gen.mjs`)

`nfunc` functions on `depth` levels (calls only go deeper, so every walk terminates); `size`
statements per function (arith, branch, struct, array, short loop, 8-way switch, x87);
`fanout` call sites per function, `condCall` of them conditional, `indirect` of them through a
function-pointer table or a virtual method; `hot` skews the root choice; `order` = emission
order (`shuffle`: callers and callees on unrelated pages; `dfs`: callee after first caller —
SAME code, different placement; placement is forced with `/Gy` + `/ORDER`, because MSVC's own
emission order ignores source order). Every function gets a static caller.

## Caveats

* **Pin the process.** On this 7900X3D an unpinned run lands on the V-cache CCD or the other
  one; the flat workload moves ~2.3× between them (that sensitivity is itself a finding: the
  JIT's working set is tens of MB). `bench.mjs --affinity 0xF0` pins all child runs.
* `cpu.instruction_counter` is a block credit, not an exact retired count (guestbench README).
* The machine is shared; the A/A arm is the noise floor of that session — read deltas against it.
* Instrumented runs (`--dispatch`, `--census`) are never timing runs.
* The Lua mini libc's float formatting/libm are simple, not correctly rounded; the scripts only
  feed them exact values, and all arms use the same implementation.
