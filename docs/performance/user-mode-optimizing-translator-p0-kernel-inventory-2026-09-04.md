# P0: corpus / kernel inventory

Дата: 2026-09-04. Статус: входные данные для реализации P0; это не performance claim.

## Решение

* Основной kernel P0: `k3` — реальный байтовый фрагмент `NFSU Speed.exe`, integer-only.
* Контрастный kernel: `k4` — также реальный фрагмент NFSU, но с много-блочным CFG,
  вложенными циклами и memory RMW.
* `k5` оставляем как следующий контраст для 8-bit/helper memory shape.
* `k1`/`k2` не подходят для первого integer P0: они требуют x87. `k6`/`k7` — только
  synthetic conformance/reg-only controls, не real kernels и не performance workload.

Критическое ограничение: в репозитории нет свежего trace, который одновременно фиксирует
`k3`/`k4` по точному EIP, имеет fixed-work denominator и связывает timing с одной function
identity. Поэтому имеющиеся trace-файлы — только directional evidence. До любого утверждения
о throughput нужно выполнить capture workflow ниже.

## Что найдено в репозитории

| Артефакт | Что является источником истины |
|---|---|
| `tools/aot-oracle/corpus/kernels.mjs` | Byte-exact extracts, original VA/file offset/SHA и provenance из retail `tmp/nfsu/Speed.exe`. |
| `tools/aot-oracle/corpus/cases.mjs` | Calls/prologues, `insPerIter`, compared regions, negative controls и raw entry identity. Каждый case содержит `STATE`. |
| `tools/aot-oracle/corpus/layout.mjs` | Детерминированная guest image; `COUNT`/`VCOUNT` читаются из env, `STATE` — 8 GPR + EFLAGS по 0x24 байта. |
| `tools/aot/capture-job.mjs` | Live v86 reference → job: финальные bytes/sha страницы, entry offsets, `CachedStateFlags`, JIT config, engine SHA/RAM, `tlb_data` relocation. |
| `tools/aot/aotc.mjs` | Job → проверенный unit/manifest; сохраняет ABI-5 identity и exact table slot. |
| `tools/aot-oracle/oracle.mjs` | Differential memory + guest STATE + host state/lazy flags, identity/entered/alive/relocation gates и negative controls. |
| `tools/harness.ts`, `src/worker/harness/cmds/perf.ts` | Chrome trace, `perfwindow` marks, sampled `hotblocks` и count-weighted `trace2`/`guestBlocks`. |
| `tools/analyze-trace.ts` | `bottleship.hotblocks` → module+RVA/page/EIP attribution. Это yield-point sampling, не elapsed time. |
| `tools/guestbench` | Controlled synthetic fixtures. Они полезны для isolated diagnostics, но не являются real game kernels. |

`tmp/nfsu/Speed.exe` присутствует. Его проверенный SHA-256:
`c0fad450912952f53809a54690d235aa8b4e25b9f46650693c7cbee1b4c074b7`.
`node tools/aot-oracle/verify-corpus.mjs` подтвердил k1–k5 и отдельно пометил k6/k7 как
`VERIFIED_SYNTHETIC`.

## Выбор kernels

Важно не смешивать адреса: original VA ниже — identity real binary; `cases.mjs` переносит
body в отдельную oracle image (`k3` code page `0x00103000`, `k4` `0x00104000`). Real
identity — это `(Speed.exe SHA, file offset, body SHA, VA)`, а не oracle `codeAddr`.

| Case | Real identity / shape | Fixed-work ledger | Решение |
|---|---|---|---|
| **k3 (P0)** | VA `0x005d4f87`, file offset `0x001d4f87`, 16 B, body SHA `f92e8ad00d112bc46ea8bab9fd401410e4cefc3b9ad8ff4a21be9d67d44ae345`, page `0x5d4`. `xor edx,edx; cmp [ecx+edi],edx; setne dl; mov [ecx],edx; add ecx,4; dec eax; jne`. | One call, one read + one write, 7 static/dynamic instructions per element, `COUNT` elements. Logical body work: `outer * COUNT * 7`; report iterations separately. `src-last` must change `DST3` last dword and `STATE.edx`. | Лучший first slice: GPR/32-bit load-store, cmp/setcc, induction, conditional branch and self-loop; no x87/helper/indirect edge. |
| **k4 (contrast)** | VA `0x005cbd78`, file offset `0x001cbd78`, 82 B, body SHA `9344e7fbf320a3e077d36cb1c5000a2fed5adf508eaf405d806b329e297b77e1`, page `0x5cb`. 30 static instructions, 7 blocks, 3 back edges, 13 memory operands, 5 RMW. | Oracle fixture `OUTER=2,MID=3,INNER=8`, analytic `insPerIter=376`, one call. Logical body work: `outer * 376`. `src-first` changes `DST4[0]`. | Проверяет CFG/side exits, frame-relative addressing and two-phase RMW. Current compiler knowingly pays dispatcher on multi-block outer loops (`loopify` gap), so this is contrast, not P0 greenfield target. |
| k5 (P0.5) | VA `0x00674b94`, file offset `0x00274b94`, 27 B, body SHA `8ee6d7d49e82fced24f27391b9c3a73714a1e402f6ee11cb7b65489805ab2297`. | 12 instructions/iteration; 8-bit load, shift-by-CL helper, byte RMW and byte test. `src-last` and `src-term` are named faults. | Реальный, но добавлять после k3; иначе helper/8-bit shape смешает первый mechanism. |
| k1 | VA `0x005d3f1b`, 72 B, SHA `f10826b7b83d3d014d4888f2fbf4564d457303212a330866e6d8f3522b94f792`; historical hottest page `0x5d3`, 25 static/23 dynamic, 2 calls, 16 memory operands и 2 x87 (`fild/fstp`). | Two branch-diamond contexts; fault is valid. | Не брать: integer unit заканчивается на x87 hole, поэтому full unit `INVALID`. Historical “156.6M block-exec/15 s” не является текущим benchmark. |
| k2 | VA `0x005ae0ec`, 149 B, SHA `b064d50c6b398110aaa84510395533ad52f835bf7ab6a08c10f048969271ecd1`; 58 static, 48 x87, 43 memory. | 4x4 vertex transform. | FP/x87 kernel; не P0 integer. |
| k6/k7 | Нет retail VA/SHA; provenance явно synthetic (`k6-conformance.mjs`, hand-assembled k7). | k6 covers claimed forms; k7 tests register-only divergence. | Никогда не называть real kernel и не включать в application/performance result. |

## Instruction-family inventory и holes

Current `tools/aot` slice называется `integer-core`. Поддерживаются 32/8-bit mov, ALU,
shift/rotate/test/inc-dec-not-neg, `adc/sbb`, `lea`, `movzx/movsx`, `setcc`, `cmovcc`,
push/pop, xchg/leave, cwde/cdq, moffs mov, bswap/bsf/bsr, clc/stc/cld/std, imul/mul,
Jcc/jmp/ret, rel32 call, `loop` family и indirect near call/jmp (register/memory). Census
по пяти историческим NFSU hot pages сообщает 92.6% decoded (88.5–94.8% per page), но это
coverage slice, не measured CPU-time share.

Реальные P0 cases дают только узкую подмножество:

* k3: 32-bit GPR, memory read/write, cmp/setcc, add/dec, conditional self-loop;
* k4: frame addressing, test/branches, nested CFG и RMW;
* k5: 8-bit memory/helper/RMW/test.

Следующие формы в real k3/k4 отсутствуют и покрываются лишь synthetic k6 либо ещё не
покрываются: `adc/sbb`, `push r/m`, `leave`, rel32/indirect call, `imul/mul`, `bsf/bsr`,
часть flag/loop forms. Это не должно быть скрыто за названием “integer-core”.

Известные structural/semantic holes:

* нет x87/SSE/string ops и 0x66/0x67 prefixes; `IN/OUT` не входят в unit;
* нет `div/idiv`: нужен точный `#DE`/`previous_ip` exit contract; `cmc` пока требует
  flush → helper → reload;
* unsupported instruction заканчивает unit и отдаёт dispatcher; для k1 это делает
  integer unit непригодным целиком;
* multi-block back edges не `loopify`-ятся (k4 платит dispatcher); bounded exit B7 —
  correctness/preemption guard, не throughput optimization;
* producer использует TLB shapes, не fastmem; indirect terminators leave unit, без
  ret-chaining/speculation. `call [mem]` fault-order требует отдельного negative control;
* `trace2` считает `exec * static instructions` и сам вносит instrumentation bias. Это
  count-weighted diagnostic denominator, не hardware-retired count и не wall-time.

## Как записывать identity, fixed work и state

Для каждого результата хранить одной строкой/JSON:

```text
kernel_id, process/binary_sha256, original_va, file_offset, body_sha256,
original_page, oracle_codeAddr_or_live_module+rva,
trace_file, perfwindow_begin/end, arm_identity,
calls, outer, iters, insPerIter,
logical_iterations = outer * calls * iters,
logical_work = logical_iterations * insPerIter,
trace2_exec, trace2_static_ins, trace2_weighted_ins, trace2_bias_note,
regions, fault_name, output_sha/state_sha
```

Для k3 минимальный denominator — `outer * COUNT * 7`; `COUNT` задаётся одинаково в обеих
arms через `AOT_ORACLE_COUNT`. Для k4 — `outer * 376` при текущих fixture trip counts.
`logical_work` явно помечать как logical, не выдавать за физический retired-instruction
counter. Warmup/compile/publication cost хранить отдельно от measured phase.

Function identity:

1. Binary side: `kernels.mjs` VA + file offset + body SHA, проверяемые `verify-corpus`.
2. Live sampled side: `bottleship.hotblocks`/`guestBlocks` дают guest address и
   `module+rva`; exact EIP сначала подтверждать disassembly, потому что sampler показывает,
   где worker park-ится.
3. Count side: `guestBlocks({pages|ranges})` возвращает block entry address, `exec`,
   static `instructions`, `weightedIns`; named range нужен для function roll-up.
4. AOT side: `capture-job`/manifest фиксируют page SHA, entry offsets, exact `tableIndex`,
   engine SHA, RAM, JIT ABI/mask/fingerprint и `tlb_data`. Oracle проверяет function identity
   в `wasm_table`; page ownership alone недостаточно.

Register/state identity — `STATE` at `layout.mjs` `0x...300`, 0x24 bytes:
`eax, ecx, edx, ebx, esp, ebp, esi, edi, eflags`. Oracle также сравнивает host-side
registers, EIP, materialized EFLAGS, lazy flag tuple and (when applicable) FP/SIMD state.
Missing candidate state is `UNCOMPARED`, never equality. Every P0 result must include a
clean run and declared fault run (`k3 --fault src-last`, `k4 --fault src-first`).

## Exact capture workflow

### 1. Corpus and binary integrity

```powershell
node tools/aot-oracle/verify-corpus.mjs
node -e "const fs=require('fs'),c=require('crypto'); console.log(c.createHash('sha256').update(fs.readFileSync('tmp/nfsu/Speed.exe')).digest('hex'))"
```

The second command must print the SHA above. Do not proceed on mismatch.

### 2. Real NFSU attribution trace (directional until fixed work is added)

Load the actual NFSU WGB in one guest tab and drive it to a repeatable scene first. The
`trace` command refuses parallel guest tabs by default.

```powershell
bun tools/harness.ts up
# manually open the actual NFSU WGB/bundle and reach the repeatable scene
bun tools/harness.ts trace 15 logs/p0-nfsu-2026-09-04.json.gz
bun tools/analyze-trace.ts logs/p0-nfsu-2026-09-04.json.gz --thread worker --top 40
```

For cold boot only, and only with the real bundle id/path:

```powershell
bun tools/harness.ts trace 30 logs/p0-nfsu-boot-2026-09-04.json.gz --boot <actual-nfsu-wgb-id-or-path>
```

Do not read `hotblocks` timing as kernel time; confirm the reported module+RVA against
`Speed.exe` disassembly.

### 3. Count-weighted page census, separate from clean timing

Arm exact original pages for k3/k4 (and optionally k5), drive the same fixed scene, then read:

```powershell
bun tools/harness.ts guestBlocks '{"phase":"arm","pages":["0x005d4000","0x005cb000","0x00674000"],"maxPages":64}'
# drive the fixed scene/workload while the recorder is armed
bun tools/harness.ts guestBlocks '{"phase":"read","top":100,"keepArmed":false}'
```

If arm/read returns `refused`, no rows, or a disarmed recorder, record `unavailable`; never
convert it to zero. Keep timing from a clean, disarmed `frameReport`/trace window because
armed `trace2` increments slow guest execution. The live window can be bracketed with:

```powershell
bun tools/harness.ts frameReport '{"reset":true,"budgetMs":33.34}'
# drive the repeatable scene
bun tools/harness.ts frameReport '{}'
```

`frameReport` emits `bottleship.perfwindow.begin/end`; a Chrome trace must cover that whole
interval to join timing and attribution.

### 4. Deterministic P0 oracle / compiler job

The following is the reproducible fixed-work lane. It is an oracle image containing the
byte-exact retail body, not a claim that the browser trace executed only this function.

```powershell
node tools/aot/capture-job.mjs --case k3 --out tools/aot/jobs/p0-k3.json --warmup 20000
node tools/aot/aotc.mjs --job tools/aot/jobs/p0-k3.json --out tools/aot/units/p0-k3
Push-Location tools/aot-oracle
node oracle.mjs --check --case k3 --candidate unit:../aot/units/p0-k3.json
node oracle.mjs --check --case k3 --candidate unit:../aot/units/p0-k3.json --fault src-last
Pop-Location
```

For the contrast, repeat `--case k4` and `--fault src-first`. Before timing any candidate,
prove positive and negative controls:

```powershell
Push-Location tools/aot-oracle
node oracle.mjs --prove --case k3,k4 --candidate 'unit:../aot/units/p0-{case}.json'
Pop-Location
```

Use two element counts to separate fixed call/entry cost from the body slope. Both arms must
use the same count; keep each JSON report with `--out`:

```powershell
$env:AOT_ORACLE_COUNT = "64"
Push-Location tools/aot-oracle
node oracle.mjs --case k3 --candidate unit:auto --reps 5 --outer 40000 --warmup 200000 --out ../../tmp/p0-k3-count64.json
Pop-Location
$env:AOT_ORACLE_COUNT = "256"
Push-Location tools/aot-oracle
node oracle.mjs --case k3 --candidate unit:auto --reps 5 --outer 40000 --warmup 200000 --out ../../tmp/p0-k3-count256.json
Pop-Location
Remove-Item Env:AOT_ORACLE_COUNT
```

`unit:auto` is the opt-0 JIT identity control. A number is reportable only when differential,
steady-state, spread and tier-2 gates pass; otherwise the oracle verdict is `INVALID` and the
timings remain withheld. For independent slice evidence:

```powershell
python tools/aot/capstone-lengths.py > tmp/p0-lengths.json
node tools/aot/decoder-oracle.mjs --truth tmp/p0-lengths.json
node tools/aot/slice-census.mjs
```

## Existing traces: why they are not the baseline

* `logs/gpu-cat-check.json.gz` is a real NFSU trace (8,018 ms, 420,623 events, 232 embedded
  hotblock rows). It shows NFSU JIT activity, but its dominant sampled pages include
  `0x005db000`, `0x005ca000`, `0x0063e000`; `0x005d4000` appears only as a low-count page row.
  It has one `bottleship.hotblocks` mark and **no** `bottleship.perfwindow.begin/end`, so it
  has neither exact k3 function identity nor a fixed-work timing denominator.
* `logs/trace-30s.json.gz` is a GTA3 trace (30,018 ms, 430,476 events, 478 hotblock rows),
  also without perfwindow marks. `logs/trace-10s.json.gz` is a Carmageddon 2 trace
  (10,016 ms, 198,321 events, 328 rows), likewise not a k3/k4 baseline.
* `tmp/cossacks-probe.json` is a real Cossacks breakpoint/read-bytes harness probe, not a
  CPU profile or fixed-work trace.
* `git ls-files logs tmp` is empty: these runtime artifacts are not a reproducible checked-in
  benchmark baseline.

The honest P0 conclusion is therefore: implement and accept semantic coverage on real
corpus k3, use real k4 to expose CFG/RMW regressions, and rerun the capture workflow before
selecting the next optimization mechanism or quoting speedup.
