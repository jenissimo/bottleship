# P0 contract audit: user-mode optimizing translator

Дата: 2026-09-04
Статус: аудит фактического кода; новый translator/generation API этим документом не
добавляется.

## Итог

Текущий v86 JIT имеет рабочую page-granular coherence discipline, но у него нет
единого runtime `codeGeneration`, `mappingGeneration` или `segmentGeneration`,
который можно проверить при входе в оптимизированный блок. Имеющиеся сущности с
похожими именами не заменяют такой контракт: `Process.resetGeneration` относится к
reset/cache, `RET_CACHE_EPOCH` — к memo dispatch targets, `asyncParkGeneration` —
к async restore.

До появления явного контракта новый translator должен fail closed: сохранять обычный
v86 dirty/TLB/fault path и выходить при неопределённости. Ниже зафиксированы владельцы,
entry validation, invalidation и конкретные P0-проверки.

## Матрица контрактов

| Состояние | Owner и входная проверка | Invalidation/publication | P0 gap |
|---|---|---|---|
| Code bytes | Guest stores — Rust `cpu::memory`; JS — `memory/guest-code.ts`; JIT entry — физическая `PageInfo` + `TLB_HAS_CODE` + dispatch meta | `write8/16/32` dirty-ят page/range; JS обязана `writeGuestCode` или `invalidateGuestCode`; dirty page освобождает module forest | Нет byte hash/code generation; raw JS/Rust writes могут обойти choke point |
| Mapping/protection | PTE owner — `PageTableManager`; region intent — `AddressSpace`; TLB owner — `set_tlb_entry`; проверяются PRESENT/RW/USER и TLB bits | PTM commit/decommit/ensure/protect → `full_clear_tlb`; CR0 PG/WP, CR4 PSE/PAE/PGE → full clear; CR3 → `clear_tlb`; INVLPG/PF → entry clear | Нет mapping generation; execute/NX permission не поддерживается; JS `protect` и PTM `setProtection` могут расходиться |
| TLB/code pages | `set_tlb_entry` — единственный writer `tlb_data` + permission mirror; JIT owns `PageInfo/ctx.pages/entry_points` | `tlb_set_has_code(_multiple)`, `clear_tlb_code`, full/partial TLB clear; AOT требует отдельного `jit_aot_flush_tlb` | Страница, не байт, является единицей validity; нет generation; valid-entry list допускает duplicates после INVLPG |
| A/D bits | v86 page walker — архитектурный writer; guest видит PTE/PDE bytes | page walk с side effects пишет PDE.A, PTE.A и PTE.D для write; PTM PTE change делает TLB full clear | Нет A/D snapshot/generation; no-side-effects walk не эквивалентен observable execution |
| Segments/switch | `switch_seg/get_seg/update_state_flags`; scheduler `performSwitch`; FS — `setFsBase` | segment load обновляет 4 state flags; switch сохраняет GPR/EFLAGS/FPU/SIMD, восстанавливает FS и уведомляет dispatcher; обычный switch JIT не flush-ит | `CpuContext` не содержит segment selector/base/limit/null/access; state flags не включают DS/FS/GS details |
| Helper ABI | fixed linear-memory offsets — `global_pointers.rs`; imports/signatures — `tools/aot/lib/abi.mjs`; verifier — `tools/aot/lib/verify.mjs` | JIT config ABI/fingerprint и engine hash bind AOT; helper allowlist и two-phase PF проверяются build-time | Нет отдельного helper descriptor version/hash; JIT config ABI ≠ helper ABI |

## Фактические доказательства

### 1. Code bytes

- `src/worker/core/memory/guest-code.ts:2-8,16-20,60-78` фиксирует правило:
  v86 кэширует JIT blocks по 4 KiB physical page, JS `mem8` write сам по себе
  невидим; `invalidateGuestCode` — единственный ranged choke point.
- `guest-code.ts:110-128,146-157` показывает deferred ranges без wasm и
  атомарную пару `mem.set` + invalidation в одном JS turn.
- `vendor/v86/src/rust/cpu/memory.rs:279-337`: `write8` вызывает
  `jit_dirty_page`, `write16/32` — `jit_dirty_cache_small`; raw
  `memory_raw_write8/32` используют no-dirty accessors.
- `vendor/v86/src/rust/codegen.rs:1313-1424,1461-1567`: JIT store идёт через
  slow helper при небезопасном TLB; fastmem map читается per-store, но generation
  guard отсутствует.
- `src/worker/core/process.ts:55-72,310-335`: executable allocation
  defensive-invalidates; `src/worker/core/thunking/thunk-generator.ts:170-174`,
  `src/worker/core/pe-loader.ts:1786-1790,1835-1840`,
  `src/worker/core/hle-lib/lib-patcher.ts:202-247,291-299` — известные
  publication owners.
- `vendor/v86/src/rust/jit.rs:3686-3700` регистрирует даже compiled source
  pages без entry points; `jit.rs:5988-6077` удаляет module forest и range pages.
  `jit.rs:4219-4243` прямо говорит, что per-unit generation в dispatch meta нет.

**P0 tests:** compile→guest `write8`→execute; JS `writeGuestCode`; same/cross-page
write; reused thunk/DLL allocation; in-place patch. Arm
`takeGuestCodeAuditPages` (`guest-code.ts:33-44`) и сделай source census всех
executable writes. `__noCodeInvalidate` допускается только как negative diagnostic.

### 2. Mapping/protection, TLB и code pages

- `src/worker/core/memory/address-space.ts:18-44,220-315,350-364`: region
  kinds/perms; THUNK_CODE=`rx`, HEAP/SURFACE/THUNK_DATA=`rw`, ROM=`r`,
  guard=`noaccess`; `validateRange` — только JS metadata.
- `address-space.ts:200-206` — `protect` меняет exact region и write map.
  `address-space.ts:147-158` лишь комментирует generation; поля/реализации нет.
- `src/worker/core/memory/page-table-manager.ts:145-220,223-262`:
  decommit/commit/ensure переписывают PTE, full-clear TLB и обновляют fastmem map.
  `page-table-manager.ts:264-312`: NOACCESS=not-present, READONLY/EXECUTE_READ=
  present+user read-only, RW/EXECUTE_RW=present+RW.
- `page-table-manager.ts:319-364` строит fastmem bit 0 как intersection region
  intent и PTE PRESENT+RW; `page-table-manager.ts:268` принимает
  неиспользуемый `_bumpGeneration`.
- `vendor/v86/src/rust/cpu/cpu.rs:2208-2215,2263-2411` — page walk,
  permission bits, TLB entry and `update_tlb_code(virt,phys)`. PAE NX отвергается
  (`cpu.rs:2243-2253,2303-2314`), поэтому execute/read protection сейчас не
  является отдельной архитектурной проверкой.
- `cpu.rs:325-342`: `set_tlb_entry` — единственный writer `tlb_data` и
  permission mirror. `cpu.rs:2357-2373` документирует stale list duplicates после
  INVLPG. `cpu.rs:2421-2474` — full/partial TLB clear.
- `cpu.rs:2997-3040`, `vendor/v86/src/rust/cpu/instructions_0f.rs:804-845`:
  CR0/CR3/CR4 invalidation; `cpu.rs:2520-2559` PF invalidation;
  `cpu.rs:4806-4829` INVLPG.
- `vendor/v86/src/rust/jit.rs:1384-1399,1413-1443,3708-3720`: fastmem map,
  dispatch meta packing (state flags/table/slab only), code-page publication.
  `jit.rs:4131-4144`: AOT batch must call explicit `jit_aot_flush_tlb`.
  `jit.rs:465-542`: `RET_CACHE_EPOCH` is dispatch memo epoch, not mapping gen.

**P0 tests:** compiled read/write under decommit/recommit, RO↔RW/NOACCESS, CR3,
CR0 PG/WP, CR4 PSE/PAE/PGE, INVLPG, CPL/user reachability and non-identity alias.
Проверять TLB/meta/fastmem and PF error code. Test two virtual aliases to one
physical code page and AOT commit with/without `jit_aot_flush_tlb`.

### 3. A/D bits

`vendor/v86/src/rust/cpu/cpu.rs:153-168` defines PRESENT/RW/USER/A/D. Large-page
walk writes PDE A (+D for write) at `cpu.rs:2274-2293`; ordinary walk writes PDE A
and PTE A (+PTE D for write) at `cpu.rs:2339-2353`, through `memory::write8`.
`translate_address_read_no_side_effects` intentionally skips fault, A/D and TLB fill
(`cpu.rs:2111-2133)); `side_effects=false` also skips JIT code lookup
(`cpu.rs:2385-2394`).

**P0 gap/test:** no A/D owner-facing snapshot or generation API. Matrix must start with
A=0,D=0 and compare read, write, failed read/write, TLB hit, INVLPG and CR3 switch:
read sets A not D; write sets A+D on PTE; no-side-effects leaves both unchanged.

### 4. Segments and thread switches

- `vendor/v86/src/rust/cpu/cpu.rs:2742-2867`: `switch_seg` handles real/vm86,
  null DS/ES/FS/GS, SS rules, descriptor presence/DPL/RPL, base/limit/access and
  writes Accessed descriptor byte at `cpu.rs:2849-2855`.
- `cpu.rs:2984-2995`: null non-CS/SS `get_seg` raises #GP.
  `state_flags.rs:1-27` and `cpu.rs:3487-3506`: cache key has only IS_32,
  SS32, CPL3, FLAT_SEGS. `codegen.rs:18-23` adds CS base only when non-flat.
- `src/worker/core/scheduler/scheduler.ts:1543-1682`: `performSwitch` saves
  current, restores next, writes FS and notifies dispatcher. The snapshot is
  `src/worker/core/scheduler/scheduler-context.ts:27-53`; its type has only GPR,
  EIP/EFLAGS and optional FPU/SIMD (`src/worker/core/scheduler/types.ts:78-105`).
- `src/worker/core/scheduler/fs-base.ts:5-32`: `setFsBase` writes live
  `segment_offsets[FS]` and GDT descriptor; deliberately no code invalidation.

**P0 gap/test:** same four state flags can hide different DS/FS/GS base/limit/selectors.
Run non-flat DS, nonzero FS, null DS, limit fault and Accessed-bit cases; switch two
threads with different TEBs at guest/thunk/callback boundaries. A segment-specialized
block must carry an exact segment snapshot or deopt before switch.

### 5. Helper ABI

- `vendor/v86/src/rust/cpu/global_pointers.rs:7-76`: fixed offsets include
  `instruction_pointer=556`, `previous_ip=560`, `instruction_counter=664`,
  `sreg=668`, `segment_offsets=736`, `segment_limits=768`, `is_32=804`,
  `stack_size_32=808`.
- `tools/aot/lib/abi.mjs:7-80`: transcribed offsets/masks and helper signatures.
  `tools/aot/lib/verify.mjs:458-470` rejects imports outside the non-faulting
  allowlist or two-phase `safe_*_slow_jit` family.
- `abi.mjs:82-97`: interpreter-faulting helpers owe `previous_ip`; JIT slow
  helpers reconstruct EIP from compile-time page offset.
- `vendor/v86/src/rust/jit.rs:6228-6249` and
  `src/worker/core/cpu/aot-cache.ts:398-425` version JIT config/fingerprint/
  engine identity, not an independent helper descriptor.

**P0 gap/test:** add no API in this audit; require import census of names, wasm types,
offsets and fault class. Negative mutation of each signature/offset must refuse the
artifact. Exercise every slow helper on PF, page crossing, MMIO and code-page store.

## Instruction counter, fault and budget contract

- Counter is wrapping `u32` at offset 664 (`global_pointers.rs:23-42`); scheduler
  uses unsigned sub-quantum delta (`scheduler.ts:759-778`) and stamps after switch
  (`scheduler.ts:1664-1682`).
- Interpreter increments local `i` before each instruction and commits at loop exit
  (`cpu.rs:3441-3485`). JIT increments module-local count by whole basic block before
  its body (`jit.rs:5605-5622`), then spills at normal/fault exits
  (`jit.rs:5478-5492`; helper `codegen.rs:139-147`).
- JIT PF records CR2/error in `jit_fault`, clears affected TLB/code, then generated
  exit restores registers and calls `trigger_fault_end_jit`
  (`cpu.rs:2508-2559)); non-JIT PF restores EIP from `previous_ip`.
- `hypercall.rs:246-262`: cycle_limit=0 means default 100003 only when HC disabled;
  with HC enabled it is urgent zero. `cpu.rs:3643-3662` reads it once per slice
  and loops while unsigned counter delta < limit, not HLT and not park EIP.
  `cpu.rs:3540-3555` makes smaller-than-LOOP_COUNTER a preempt yield.
- `jit.rs:4524-4540` has module-local `instruction_counter >= LOOP_COUNTER`
  safety; chain helpers repeat limit/HALT checks (`jit.rs:2589-2600,2646-2671`).
  TS writes urgent/normal limits at `preemption-manager.ts:352-441`.
- `run_guest_until` is a distinct HLE loop: max_blocks, no IRQ/slice bookkeeping
  (`cpu.rs:3572-3641`).

Therefore a requested budget is an upper bound on globally observed retired instructions,
but stop points are block/chain granular and can overshoot by the current block. A new
translator must preserve counter delta, fault/interrupt result and exit reason separately;
there is no current logical-work ledger.

## P0 blockers and acceptance tests

1. Add/define code-byte identity and prove every executable write is covered.
2. Add/define PTM/v86 mapping-protection identity; do not reuse reset, ret-cache or
   async generations.
3. Define segment snapshot/deopt at `performSwitch`/FS changes.
4. Decide and test whether A/D writes are part of the candidate's observable effects.
5. Bind a versioned helper descriptor (offsets, signatures, fault/previous_ip protocol)
   to translator/AOT identity.
6. Differentially compare interpreter vs translator at normal exit, block overshoot,
   chain, PF/#GP/#UD, HLT, park and urgent-zero boundaries.

Required existing checks (where applicable): `npm run validate:tlb-mirror`,
`npm run validate:eagl-read-cursor`, `npm run validate:jit-shipping-config`,
`npm run census:aot-abi`, `npm run typecheck`, plus relevant v86/scheduler tests.

No generation API is claimed or added here.
