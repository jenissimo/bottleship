# 07. Dispatch tax: где именно 5% busy на переходах между единицами

## Видение

В трейсе Far Cry `cycle_internal` даёт около 3% busy, `jit_find_cache_entry_for_dynamic_chaining`
около 2%, вместе с `jit_tier2_drain_pending` и dispatch-meta lookup это около 5%. Это не
новая фича, а измерение: ret-chaining с memo, dynamic chaining regions и tail calls уже
есть. Вопрос в том, какой класс переходов промахивается мимо них.

Кандидаты, по опыту Dolphin/PPSSPP/FEX:

- **ret** через C++-вызовы между DLL (cry3dengine → xrenderd3d9): memo cold или alias,
  потому что call-site и return-site в разных регионах.
- **Виртуальные вызовы** (`call [eax+N]`): indirect без entry в регионе, потому что
  target-страница не в chaining region.
- **Cross-page прямые jmp/call** за пределами `MAX_PAGES = 3`.
- **Разные state flags** (`RUN_INTERPRETED_DIFFERENT_STATE_*`): переходы между
  CPL/сегментными состояниями, что для user-mode игры должно быть около нуля.

Каждый класс имеет свой рычаг: расширение memo, повышение `JIT_INDIRECT_REGION_MAX_PAGES`,
inline cache на call-site (сравнить target с последним и `br` без lookup), region
selector из пункта 06.

## Как снять

Профилерные счётчики уже есть, нужен только harness-глагол, который их печатает за окно:
`RET_CHAIN_HIT/MISS/BUDGET`, `RET_MEMO_HIT/COLD/ALIAS`, `RET_META_HIT`, `INDIRECT_JUMP`,
`INDIRECT_JUMP_NO_ENTRY`, `CHAIN_MISS`, `CHAIN_BUDGET_EXIT`, `RUN_INTERPRETED_*`. Нужна
profiler-сборка v86; в shipping-сборке stub возвращает нули, что зафиксировано в
postmortem как provenance-дыра. Глагол обязан отказывать, если счётчики нулевые при
ненулевом retired.

Порядок:

1. Окно 10 s на Pier, счётчики за окно, деление на число входов в `cycle_internal`.
2. Топ входных EIP в `cycle_internal` по частоте (сэмплер EIP на входе, не на блоках):
   называет конкретные call-site/ret-site, по которым видно класс.
3. По классу выбирается рычаг, и только тогда OFF/ON.

## Синтетические тесты

Correctness для любого выбранного рычага:

- **Chaining под инвалидацией**: цепочка A→B→A, где B перекомпилируется (guest пишет в
  его страницу). Возврат в A обязан пройти через свежую B, а не через устаревший
  chained target.
- **Ret под подменой стека**: `ret` после `mov esp, [x]` (SEH unwind, setjmp/longjmp,
  fiber switch). Memo обязан промахнуться, а не вернуться по предсказанному адресу.
- **Self-check**: намеренно неверный memo-адрес приводит к неправильному EIP, и тест
  обязан это увидеть по checksum.

Perf fixture: `demo_vcall_dense` (виртуальные вызовы по массиву объектов трёх типов,
фиксированный seed) и `demo_cross_dll` (два модуля в бандле, вызовы через экспорты).
Обе с checksum и retired count.

## Критерий успеха

Названный класс переходов с долей входов в `cycle_internal`, и после рычага снижение
этой доли с положительной медианой CPU-арма выше noise floor.
