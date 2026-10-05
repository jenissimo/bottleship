# FC Rebench review invalidation

Дата: 2026-09-01  
Статус: P0 remediation выполнена в две волны (вторая — по верификации первой, 2026-09-02);
synthetic benchmark после второй волны ещё не перевалидирован, live Far Cry проверен после первой

> Follow-up live validation и новый CPU/frame-tail профиль:
> `docs/performance/far-cry-draw-loss-and-frame-tail-followup-2026-09-01.md`.

## Решение

Постмортем 60 FPS понижен из `auditably-clean` в `INVALIDATED`. Значение 67.440 FPS
сохраняется как историческое наблюдение host throughput, но не как release claim, суммарный
speedup или доказательство сохранности всей работы.

Причина — review нашёл одновременно correctness defects в candidate paths и oracles, которые
считают заявленную/закодированную работу вместо независимого подтверждения исполнения.
Пользователь также наблюдал потерянные draw и нелинейные FPS-просадки в живом Far Cry.

## Confirmed P0 findings

| Область | Дефект | Влияние на кампанию | Требуемый gate |
|---|---|---|---|
| x87 PC-local | local создаётся внутри fast arm первой relaxed-binop; slow→fast sequence в одном lexical run читает неинициализированный/reused local | default-on generic x87 correctness нарушена; checksum демки не покрывает mixed tags | mixed relaxed/F80-tag differential; PC load/set доминирует над обеими runtime branches |
| Prefix MegaRun legacy fallback | executor воспроизводит `expectedPairCount`, но не отдельный `prefixVsBits` draw | compact-OFF arm выполняет меньше работы; старый ON/OFF A/B invalid | canonical expected draws = pairs + prefix; compact-OFF/fallback/descriptor-fail tests |
| Arena executed ledger | MegaBatch/render-bundle прибавляет expected pairs после одного instanced draw | `executedDelta == 0` не подтверждает per-logical-draw execution | независимый encoded transcript/instance oracle, не копия expected count |
| Query oracle | любой ненулевой occlusion predicate нормализуется к viewport area | checksum проверяет readiness/zero-vs-nonzero, не точный GPU result | отдельный lifecycle ledger и явно ограниченный semantic oracle |
| MegaBatch census | compact mode не имеет legacy command rows, но census трактует пустой range как malformed | shipping/default census сообщает ложный veto | fixtures для compact descriptor/storage path и mode-aware census |
| Opstats provenance | shipping export возвращает нулевой buffer без profiler feature | происхождение x87 52.44% нельзя воспроизвести по сохранённым artifacts | profiler-enabled build hash/feature manifest + nonzero self-test |
| WBUF intrinsic lifecycle | Rust registry/hot window не сбрасывается при process reset | адрес старого thunk может перехватить новый импорт после re-exec/game switch | reset API; reset/re-register test; отдельные hot slots |
| WBUF intrinsic parity | fast path меняет EFLAGS и проверяет только linear bounds вместо paging | расходится с OUT trampoline semantics и может обойти #PF | EFLAGS preservation и decommitted-page differential |

## Additional confirmed correctness gaps

- Rust arena parser должен проверять `float_count` против оставшегося input до вычитания,
  иначе экспортированный validator способен panic'нуть на malformed input.
- Partial arena recording rollback должен truncate'ить Rust frame, а не только TS slot.
- Prefix decline не должен оставлять `noteProgrammableDraw` accounting от не принятого пути.
- UniformArena capacity miss должен decline/fallback до encode, а не терять целый frame.
- MegaBatch не должен оставлять recorder memo, будто normal bind group всё ещё привязан.
- Instance-storage WGSL path и `vsBool` требуют compile-negative/positive tests; текущий
  call validator пропускает интерполированные вызовы.

## Plausible/P1 findings requiring focused repro

- compact capture key не включает legacy bump-env constants;
- exception во время prefix middle-setter handling может оставить drain cursor/state partial;
- debug `forceCullNone` отсутствует в compact identity и потому не является чистым A/B;
- Bink upload-route latch может срабатывать на обычные streaming/UI texture uploads;
- looped Bink pacing может сохранять старую baseline;
- `tools/wgb.ts extract-dir` требует zip-slip/path traversal audit;
- read micro-TLB OFF-path остаётся потенциально unsafe для MMIO/page-crossing entries;
- `bench-matrix` shipping mask должен реально включать все production JIT bits.

## Что review подтвердил чистым

- Rust transaction rollback mid-run восстанавливает command/bump/memo/constant-window state;
- barrier scan fusion убивает кандидата на pipeline, viewport/scissor, query и binding barriers;
- compact storage addressing и `firstInstance` согласованы;
- AOT ABI 4 и fingerprint mismatch gates действительно способны провалиться;
- x87 ST(0)/ST(i) address commoning не меняет alias/exception order по рассмотренным формам;
- удалённый read-map TS wiring был no-op относительно текущего v86 fastmem implementation.

## Revalidation order

1. Исправить x87 PC-local и добавить mixed-tag oracle.
2. Исправить prefix legacy/fallback и accounting `pairs + prefix`.
3. Исправить WBUF reset/EFLAGS/paging parity.
4. Починить независимые ledgers/census и их tests.
5. Закрыть arena rollback/capacity/bind-state defects.
6. Пересобрать runtime, зафиксировать TS diff/build artifact hashes и выполнить полный gate.
7. Только после этого повторить fixed-bundle benchmark, scale-ratio и pre-campaign A/B.

До шага 7 старые FPS числа не используются для принятия новых оптимизаций.
