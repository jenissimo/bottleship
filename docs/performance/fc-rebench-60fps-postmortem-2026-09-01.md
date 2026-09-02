# FC Rebench: postmortem выхода за 60 FPS

Дата: 2026-09-01  
Статус: **P0 REMEDIATED (две волны) — 66.984 host FPS измерены после первой волны и до второй; повторный N=3 на пересобранном runtime ещё не снят**  
Область: BottleShip x86→WASM dynarec, thunk/WBUF path и D3D9/WebGPU backend

> **Важно:** `67.440 FPS` сохранено ниже как историческое наблюдение host throughput.
> После code review это число нельзя называть auditably-clean результатом, доказанным
> ускорением кампании или доказательством отсутствия потерянной работы.

Live Far Cry follow-up после remediation сохранён в
`docs/performance/far-cry-draw-loss-and-frame-tail-followup-2026-09-01.md`.
Он подтверждает восстановление draw correctness, но одновременно показывает отдельный
CPU/HLE-bound потолок около 20–22 FPS на исследованной сцене; это не новый FC Rebench result.

Новый FC Rebench после remediation прошёл hardened runner: три fresh-load окна по 360
presents дали 66.984 / 66.795 / 67.302 host FPS. Старые 67.440 FPS остаются invalidated;
их заменяет новое измерение с исправленными runner boundaries, draw ledgers и query lifecycle.

## Review invalidation — 2026-09-01

Последующий review нашёл достижимый correctness defect в default-on x87 PC-local и потерю
prefix draw в legacy/compact-OFF ветке arena-run. Второй дефект делает соответствующий
OFF-arm неэквивалентным ON-arm и инвалидирует любой perf A/B между ними. Наблюдение
пользователя в живом Far Cry подтверждает, что потерянные draw — не только синтетический риск.

Также установлены границы трёх приборов, использованных в исходном выводе:

- `arenaRunExecutedPairs` в MegaBatch/render-bundle ветках увеличивается на ожидаемое число
  без независимого подтверждения каждой logical draw; `executedDelta == 0` там тавтологичен;
- query checksum различает readiness и zero/non-zero outcome, но не точный GPU sample count:
  ненулевой occlusion predicate нормализуется к площади viewport;
- opcode census доступен только в `profiler`-сборке; shipping stub возвращает нулевой buffer.
  Provenance бинарника, на котором были получены 52.44%, в raw artifacts не сохранён.

CPU checksum `47585765` остаётся точным для траектории этой демки, но демка не порождает
mixed relaxed/F80 tag sequence, которая активирует найденный x87 defect. Совпавший checksum
не является generic x87 oracle. Query Begin/End/Ready — guest-side lifecycle ledger, а не
доказательство семантики результата GPU. Present serial доказывает только точную длину окна.

Полная карта findings и порядок remediation сохранены в
`docs/performance/fc-rebench-review-invalidation-2026-09-01.md`.

## Executive summary

На фиксированной clean-room демке, моделирующей горячую форму, выделенную из Far Cry trace,
BottleShip достиг медианы **66.984 host FPS** в режиме `mixed`, `SCALE=3`, после
атомарного сброса полного session-scoped worker-flag envelope.

Это новое auditably-clean измерение пропускной способности конкретного proxy-workload, а не
замер Far Cry и не доказательство вклада каждой оптимизации по отдельности. Главный полезный
результат кампании — форма контракта «фиксированная работа + независимые oracles + ledgers»;
первоначально недостаточные ledgers были усилены и теперь закрывают точную длину окна,
CPU trajectory, query lifecycle и API/backend draw parity.

Финальный протокол:

| Параметр | Значение |
|---|---:|
| Bundle SHA-256 | `fa6cd035f46dbefa50076cce2712d145699f5a86ecd6de190c424d79fd9ab3d8` |
| Режим | `mixed` |
| Масштаб | `3` |
| Warmup | 120 presents |
| Измерение | 3 независимых запуска × 360 presents |
| Host FPS | 66.984 / 66.795 / 67.302 |
| Медиана | **66.984 FPS** |
| CPU checksum | `47585765` во всех трёх запусках |
| Query checksum | `f8985aca` во всех трёх запусках |
| Query Begin / End | 2880 / 2880 во всех трёх запусках |
| Query Ready | 2880 / 2880 / 2880 |
| Query errors / missing | 0 / 0 во всех трёх запусках |
| Present serial overshoot | 0 / 0 / 0 |
| API / backend indexed draws | 1,033,560 / 1,033,560 во всех трёх запусках |
| Dropped draws | `{}` во всех трёх запусках |

Финальный `v86.wasm`:

`7A4F6B9240CE3A53D1937C2747FEF5B3328A5C10160099E580986870C015A903`

Хэши `public/v86.wasm`, `dist/v86.wasm` и `vendor/v86/build/v86.wasm`
совпадают. Эта тройная проверка ловит stale/unrebuilt artifact: исходники могли измениться,
но runtime продолжал бы загружать старый `public/` или `dist/` binary.

До фикса повторного поколения scale-3 oracle поймал 603 query errors: `rearm()` отказывал,
пока readback предыдущего интервала был in-flight. Теперь каждый новый интервал получает
отдельный GPU slot/generation, а старый batch retire'ит только своё состояние. Query checksum
по-прежнему является timing/readiness diagnostic и не подтверждает точный GPU sample count,
поэтому verdict опирается также на точные Begin/End counts, draw parity и drop ledger.

Историческая калибровка около 24.8 FPS была сделана на более раннем SHA демки.
Она объясняет происхождение цели и сложность нагрузки, но **не является строгим A/B**
для финального результата. Для регрессионных утверждений необходимо сравнивать один и тот
же bundle SHA, workload contract и окружение.

### Отсутствующий baseline anchor

На момент публикации не выполнен прогон финального bundle SHA на pre-campaign сборке
BottleShip (`17a491d` + `vendor/v86@92d172ca80d1faee0643b5b906b7337f7685a291`). Поэтому допустимое внешнее
утверждение сейчас звучит только так: «финальная сборка выполняет зафиксированный workload
с медианой 66.984 FPS на reference host». Утверждения о суммарном ускорении кампании или
аддитивности отдельных дельт пока не доказаны.

Чтобы закрыть дыру, нужен отдельный чистый worktree pre-campaign состояния, тот же `.wgb`,
тот же Chrome profile/launch flags и чередующийся протокол baseline/candidate/baseline.
Смешивать baseline WASM с текущим TS нельзя: это создаёт новый, никогда не существовавший
ABI-комплект.

## Контракт нагрузки

Каждый measured frame при `SCALE=3` содержит:

- 6,144 обновления rigid bodies;
- 49,152 последовательных contact iterations;
- 24,576 косвенных вызовов scene-node visitors;
- 2,871 D3D9 state iterations и indexed draws;
- 8 render-target pass groups;
- 8 non-blocking query polls.

Демка не подстраивает объём работы под FPS и не содержит sleeps или искусственного
frame limiter. Это важно: улучшение означает больше выполненной фиксированной работы в
единицу host time, а не изменение pacing.

## Как был найден потолок

Исходный trace-анализ был недостаточно конкретен: он показывал дорогие области, но не давал
стабильного оптимизационного контракта. Переломным решением стала отдельная синтетическая
демка с детерминированными checksums и фиксированными operation counts.

Целевой цикл для гипотез выглядел так:

1. свежая загрузка эмулятора;
2. OFF/ON или A/B/A на одном bundle SHA;
3. CPU-only и mixed arms для отделения dynarec от backend;
4. проверка checksum, query ledger, logical draw accounting и present serial;
5. откат изменения при отрицательной медиане, даже если идея выглядела архитектурно красиво.

Не все ранние эксперименты выполнили этот протокол полностью или сохранили raw spread.
Поэтому нижележащие component deltas классифицированы по силе свидетельства, а не просто
перечислены как слагаемые финального результата.

Weighted opcode census за 60 CPU frames **синтетической демки** показал (provenance
бинарника не сохранён — см. «Review invalidation» выше; числа ниже — quarantine до
воспроизведения на profiler-сборке с зафиксированным хэшем):

| Класс | Доля guest instructions |
|---|---:|
| x87 | 52.44% |
| Memory operations | 36.54% |
| Branches | 7.05% |
| Calls | 1.04% |
| Returns | 1.04% |

Это изменило приоритет: общий Tier-2 и очередной cache layer уступили точечной работе с x87
и границами guest→WASM→JS. Но census нельзя использовать как доказательство
репрезентативности демки относительно Far Cry:

| Класс | FC Rebench CPU-arm | Far Cry gameplay | Расхождение |
|---|---:|---:|---:|
| x87 | 52.44% | не измерено | не вычисляется |
| Memory operations | 36.54% | не измерено | не вычисляется |
| Branches | 7.05% | не измерено | не вычисляется |
| Calls | 1.04% | не измерено | не вычисляется |
| Returns | 1.04% | не измерено | не вычисляется |

Chrome trace содержит sampled host/WASM attribution, но не эквивалентный retired guest-opcode
census. До появления обеих колонок демка остаётся намеренно x87/D3D9-heavy proxy, а не
статистически валидированной моделью игры.

## Инцидент с чистотой benchmark state

Первый длинный прогон пересёк цель с медианой 62.011 FPS и напечатал
`workerFlags: {}`. Это поле описывало только флаги, переданные текущим runner'ом, но не
session-scoped значения, сохранённые более ранними `setWorkerFlag` вызовами в localStorage.
Поэтому конфигурация была корректной по workload, но не самодокументируемой.

Попытка очищать известный список флагов вручную дала 58.503 FPS и обнаружила проблему, но
тоже не была достаточным доказательством: retired или переименованный флаг мог отсутствовать
в списке. После добавления harness-команды `resetWorkerFlags`, удаляющей весь session store,
тот же source-default дал 67.440 FPS. Конкретное старое отрицательное значение восстановить
после удаления envelope уже нельзя; журналы доказывают сам механизм загрязнения, но не полную
предысторию origin storage.

Итоговый протокол поэтому требует атомарный reset перед **каждым** repetition. Пустой
`WORKER_FLAGS` без такого reset больше не считается clean arm.

## Кандидатные изменения, требующие revalidation

### Сила причинного свидетельства

Измеренный для кампании noise floor — около **3.6%**. Решение оставить корректное изменение
в коде и право приписать ему ускорение — разные решения:

| Изменение | Сохранённое свидетельство | Относительно noise floor | Статус утверждения |
|---|---|---:|---|
| x87 PC-local | CPU A/B/A, наблюдавшийся диапазон +4.7–6.2%; полный raw spread ранних arm не сохранён | выше | вероятный причинный вклад, требуется повтор на pinned baseline |
| x87 ST commoning | candidate 105.705 / 107.852 / 106.883 FPS против ранее измеренного PC-local 104.089 | +2.7%, ниже | принято как корректная оптимизация; независимый perf-вклад не доказан |
| Structural pipeline MRU | медианы 56.927 против 58.244 FPS | −2.3%, ниже | удалён; это directional signal, не точная оценка штрафа |
| Prefix MegaRun fusion | около 1.19 ms/frame на целевой producer-shape; полный чередующийся raw protocol не сохранён | недостаточно данных | главный кандидат mixed-выигрыша, но не независимая causal delta |
| Историческая default runtime-сборка на фиксированном bundle | 61.873 / 67.440 / 69.408 FPS, `N=3` | spread 7.535 FPS | исторический throughput; correctness claim invalidated review'ом |
| Hardened post-remediation revalidation (первая волна) | 66.984 / 66.795 / 67.302 FPS, `N=3` | spread 0.507 FPS | честное измерение своей конфигурации: WBUF intrinsic инертен, executed ledger ещё копировал expected. Не переносится на текущее дерево; повторить после второй волны |

В частности, `+2.7%` ST commoning больше не используется в итогах как установленная
составляющая ускорения. Для будущего принятого perf-изменения обязательны `N`, все raw values,
median/spread, порядок arm и сравнение с noise floor.

### 1. x87 precision-control local

Проверка `fpu_control_word & 0x300` раньше повторялась для каждой relaxed arithmetic
инструкции. Теперь результат держится в WASM local внутри непрерывной серии x87 arithmetic
операций и сбрасывается на любой instruction fence.

Наблюдавшийся результат CPU A/B/A: примерно **+4.7–6.2%** при точном checksum. Это
был наиболее сильный component-level signal кампании, но найденный review'ом runtime-path
bug инвалидирует принятие изменения до исправления и mixed-tag differential test.

Дефект: PC-local инициализируется внутри fast `else` первой инструкции lexical run. Если
первая relaxed-binop уходит в F80 slow path, а следующая — в fast path, следующая читает
неинициализированный/reused local. Инициализация control-word-derived значения должна
доминировать над обеими runtime-ветками.

Почему область кэша короткая: попытка удерживать значение на весь basic block снизила CPU
median с 104.1 до 100.3 FPS. Локальная серия даёт выигрыш без роста register pressure и
лишних control-word fences.

### 2. Commoning адресов ST(0)/ST(i)

Генераторы relaxed x87 операций повторно вычисляли один и тот же физический slot через TOP.
Когда target, ST(0) и ST(i) совпадают, emitter теперь переиспользует один `WasmLocal`.

Candidate-arm дал около **+2.7% CPU throughput**, без runtime branch и без изменения
exception/order semantics. Дельта ниже noise floor и была получена не в полностью
чередующемся сравнении; изменение оставлено, но самостоятельный прирост не заявляется.

### 3. WBUF intrinsic и MegaRun

Горячие guest `CALL` в D3D9 write buffer получили точный intrinsic с обязательным fallback.
На стороне consumer повторяющиеся пары constant/draw записываются и исполняются как arena
run, сохраняя logical draw accounting и исходный порядок state changes.

Intrinsic, MegaBatch и compact authoritative/storage path теперь default-on. Каждый имеет
явный `false` kill switch для воспроизводимого отрицательного arm.

Paging-parity intrinsic'а прошла две итерации. Первая закрыла разрыв безусловным отказом при
`CR0.PG`; все гости BottleShip идут с пейджингом, поэтому intrinsic был инертен в каждом
тайтле и в самом revalidation-прогоне 66.984 FPS — это число получено без него. Вторая
итерация делает проверку faithful: каждая 4 KiB-страница stack-аргументов, constant-блока и
ring-записи проходит page-walk без побочных эффектов (`translate_address_no_fault`), требует
present/writable и `phys == linear`; перекрытие payload или stack-аргументов с ring
отклоняется. Любой отказ — decline до первого байта, guest берёт свой #PF через trampoline.
Вклад intrinsic'а в mixed FPS после этого не измерен и не заявляется.

### 4. Default-on Prefix MegaRun fusion

Реальная последовательность начиналась не с идеальной alternating pair run, а с:

`first constant → несколько setters → first draw → alternating tail`

Prefix fusion поглощает этот префикс, затем передаёт tail существующему MegaRun consumer.
На decline dispatcher возобновляет обработку с точной rollback-точки. Отрицательный рычаг
остаётся доступен как `__d3d9PrefixMegaRun=false`.

Это главный кандидат на смешанный выигрыш: наблюдалось около **1.19 ms/frame** на целевой
форме. Без сохранённого полного interleaved raw protocol число считается directional.
Default-on статус считается provisional: до release-ready статуса обязательны P0
rollback-fuzz/differential ledger test либо переход на generated grammar с теми же гарантиями.
Кроме того, legacy/compact-OFF executor не воспроизводит `prefixVsBits` draw. Поэтому старые
Prefix ON/OFF числа не являются same-work A/B и не используются как perf evidence.

### 5. Удаление работы, которая уже была сделана

- final vertex constants больше не публикуются в WASM arena второй раз;
- producer descriptor не декодируется повторно consumer'ом;
- phase `performance.now()` вызывается только при включённом профилировании;
- batch accounting заменяет сотни однотипных JS increments;
- compact capture и collision-safe pipeline identity caches сохраняют уже доказанные
  промежуточные результаты.

Эти изменения по отдельности шумны, но уменьшают количество JS↔WASM crossings и allocations
на каждом из сотен run'ов кадра.

### 6. AOT identity

Любое always-on изменение emitter shape повышает внутреннюю codegen revision. Конфигурация
x87 PC-local участвует в fingerprint, а JIT config ABI 4 описывает полный supported-mask
контракт. Старый AOT unit не может молча пережить смену code shape.

## Отрицательные результаты

| Гипотеза | Наблюдение | Решение |
|---|---|---|
| Structural pipeline MRU на 16 identity words | 56.927 против 58.244 FPS (−2.3%, внутри noise floor); нет достаточных данных утверждать точный штраф | Полностью удалён: дополнительная сложность не получила положительного сигнала |
| Read micro-TLB | Отрицательный или нейтральный результат | Default off |
| Precision-control cache на весь BB | CPU median около 100.3 против 104.1 | Откат к коротким arithmetic runs |
| Branchy conditional x87 rounding | CPU median около 99.9 | Удалено |
| Более крупный Tier-2 сам по себе | Не соответствовал текущему hot-shape и не пересёк потолок | Ниже x87/memory specialization |

Главный вывод: уменьшение числа инструкций в исходнике не гарантирует ускорение V8/WASM.
Register pressure, форма control flow и качество оптимизации host JIT важнее локальной
«красоты» IR. Кумулятивный журнал хранится в `docs/performance/negative-results.md`.

## Что оказалось ключевым

1. **Сначала стабилизировать workload contract.** Без точной демки FPS легко улучшить,
   случайно потеряв работу.
2. **Checksums недостаточно.** Нужны отдельные query, draw и present ledgers.
3. **Профилировать guest mix, а не угадывать.** x87 занимал больше половины потока.
4. **Оптимизировать границы слоёв.** Основная implementation work была сосредоточена между
   guest code, WASM emitter, thunk dispatcher и D3D backend; доля её причинного вклада в
   финальное число не установлена.
5. **Отрицательные результаты — часть продукта.** Они предотвращают повторное внедрение
   привлекательных, но медленных решений.
6. **Не замедлять benchmark искусственно.** Для нового headroom следует повышать `SCALE`
   или operation counts, сохраняя детерминированность.
7. **Пустой список флагов не означает default.** `setWorkerFlag` переживает reload; ручной
   список очистки пропускает retired/переименованные эксперименты. Runner теперь удаляет
   весь session store до каждого repetition и только затем применяет явный `WORKER_FLAGS`.
8. **Correctness fast path доказывается ledger'ом.** Он обязан инкрементить те же логические
   счётчики, что и slow path; checksum сам по себе не видит тихо отброшенную работу.
9. **Emitter shape принимается только по A/B.** Меньше emitted instructions — гипотеза, а не
   доказательство; register pressure и host-JIT control flow могут обратить знак.

## Следующий SOTA backlog

### Закрытый P-1 — correctness и измерительные oracles

Блокирующий remediation выполнен до нового N=3:

1. x87 PC-local инициализируется до runtime fast/slow branch; mixed-tag differential test
   закрывает последовательность slow→fast.
2. Prefix draw учитывается и исполняется в legacy/compact-OFF, ledger проверяет `pairs + prefix`.
3. WBUF registry/window сбрасывается на `Process.reset()`; intrinsic сохраняет EFLAGS;
   paging-parity — page-walk без побочных эффектов по каждой затронутой странице плюс отказ
   на перекрытие (первая итерация была безусловным отказом под `CR0.PG`, см. §3 выше);
   VS/PS constants имеют раздельные hot slots. Тесты под включённым пейджингом.
4. Executed ledger на MegaBatch/render-bundle выводится из instance count, реально
   переданного в `drawIndexed`, а не из `expectedPairCount`: подмена одного на другое теперь
   валит `reconcileD3D9ArenaRuns().healthy`. Census mode-aware для compact descriptor.
   Query lifecycle ledger живёт в репозитории (`begin/end/ready/missing/error`,
   `measured` vs `synthesized`). Oracle по-прежнему не является независимым GPU
   raster-result checksum. Provenance census x87 не восстановлена — quarantine.
5. Rollback truncate'ит Rust frame; uniform budget проверяется до encode per run и
   отклоняет run вместо потери кадра; legacy replay overlay'ит prefix на pristine template;
   post-MegaBatch bind-state не мемоизируется. Всё покрыто тестами с red-trigger'ами.
6. Query reuse получил generation-safe GPU slots; `rearm` проходит capability/device-loss
   gate, вытесненные поколения видимы `markDeviceLost`/`destroy`, split пула внутри одного
   render pass деградирует один query, не весь pass.
7. Shader emitter: MOVA, DDraw z-block и все mutable-var swizzle reads переведены на
   whole-vector/indexed форму; размер WGSL вернулся к 1.055x от pre-rewrite; storage-variant
   отказывает на link для int/bool-констант; `validate-wgsl-calls` разворачивает
   интерполированные вызовы (skipped 37 → 12).
8. Один источник production JIT-флагов (`tools/jit-config/shipping.mjs`) для bench-matrix,
   AOT oracle и capture-job; `validate-jit-shipping-config` в gate. AOT oracle до этого
   мерил без branch hints под ярлыком production.

Пункты 3–8 второй волны применены ПОСЛЕ прогона 66.984 FPS. Число остаётся честным
измерением своей конфигурации, но не конфигурации текущего дерева; следующий N=3 обязан
идти на пересобранном runtime с зафиксированными хэшами.

### P0 — x87 stack-value forwarding

Держать TOP и доказанно живые ST values в WASM locals между несколькими операциями,
материализуя FPU stack только на exception/control-flow/memory fence. Это прямое продолжение
двух сохранённых x87 оптимизаций; теперь его можно мерить поверх закрытого P-1 baseline.

### P0 — static memory translation hoisting

Для адресов на доказанно стабильной guest page вычислять host address один раз. Заранее
зафиксированное предсказание: **per-straight-line-run обойдёт per-superblock**, поскольку
PC-local run выиграл, BB-scope проиграл, а read micro-TLB уже показал цену слишком широкой
области кэша. Проверять обе формы как отдельные arms; обязательны page-generation и fault
guards. Потенциал по proxy-census высокий из-за 36.54% memory instructions.

### P0 — Prefix MegaRun rollback fuzz

До признания default-on fusion release-ready прогонять случайные producer-последовательности
через fused и slow consumer и диффать decline/rollback position, logical draw/state/query
ledgers и результат. Это минимальное архитектурное условие для fast path, выведенного из
одной наблюдённой producer-формы.

### P0 — workload contract как примитив репозитория

Перенести source, manifest и runner FC Rebench в этот репозиторий и дать harness отдельный
глагол `bench <fixture>`. Соседняя папка `C:\Projects\bottleship-demos` не является git
repository; одних SHA локальных файлов достаточно для forensic-повтора, но недостаточно для
долговременного сравнения между ветками и машинами.

### P1 — x87+memory superinstructions

Специализировать повторяемые формы `load → arithmetic → store`, не нарушая точный x87
rounding и fault order.

### P1 — generated WBUF grammar

Собирать census producer sequences и генерировать ограниченные fusion rules с общей моделью
rollback/parity, вместо ручного добавления каждого нового префикса.

### P1 — pass-shell batching

После снижения CPU overhead измерить объединение command/pass shells для восьми render-target
groups. Критерий — уменьшение host submission overhead без потери query boundaries.

### P2 — новый benchmark tier

Зафиксировать текущий `SCALE=3` как compatibility/performance gate, а для дальнейшей работы
добавить `SCALE=4` или отдельный `sota` preset, целящийся в 25–35 FPS на новом baseline.

### Открытая falsification-проверка: scale ratio

В изолированной single-tab сессии прогнать `mixed` при `SCALE=2/3/4`, одинаковом warmup и
`N≥3`. Анализировать не FPS напрямую, а модель `ms/frame = fixed + k × SCALE`:

- примерно линейный рост `ms/frame` подтверждает, что throughput зависит от объёма работы;
- почти плоский `ms/frame` около cadence boundary укажет на pacing-bound измерение;
- checksum и все ledgers должны масштабироваться ровно по контракту.

Тест ещё не выполнен и не используется как аргумент в итоговом числе.

## Воспроизведение

Запустить BottleShip/harness server из репозитория, затем runner демки:

```powershell
Set-Location C:\Projects\bottleship-oss
bun tools/harness.ts up

Set-Location C:\Projects\bottleship-demos\demo_fc_rebench
$env:MODE = "mixed"
$env:SCALE = "3"
$env:WARMUP_FRAMES = "120"
$env:MEASURED_FRAMES = "360"
$env:REPEATS = "3"
bun run-bottleship.harness.ts
```

Runner атомарно удаляет весь session-scoped persistent worker-flag envelope, после чего
применяет только явно заданный `WORKER_FLAGS`. Это предотвращает загрязнение default-run
предыдущим, в том числе уже удалённым из исходников, A/B экспериментом.

На момент финального прогона benchmark-артефакты вне git имели следующие content hashes:

| Артефакт | SHA-256 |
|---|---|
| `src/main.cpp` | `5fdb0ea36519aefec878bcd2a4fbf1aaf5f13fc265c6177eb09dbbe1a8040744` |
| `run-bottleship.harness.ts` | `f47322458f4c0f9a1091b2a609c82e8b4ed960642eb7b8af0b69f64dfa7c7580` |
| `build.ps1` | `ac2371cdc92447ba4b06e99e2d5a1427d404714b7cd2691e14799b803bedfd75` |
| `manifest.json` | `634c28aca1b89fe3b3037c49863b8b375a4c4427998a511a3103a072d316526b` |
| `demo_fc_rebench.wgb` | `fa6cd035f46dbefa50076cce2712d145699f5a86ecd6de190c424d79fd9ab3d8` |

Reference host:

| Параметр | Значение |
|---|---|
| CPU | AMD Ryzen 9 7900X3D, 12C/24T |
| GPU | NVIDIA GeForce RTX 3090 |
| GPU driver | `32.0.15.9597` (Windows form; 595.97 vendor form) |
| OS | Windows 11 Pro `10.0.26200`, build 26200 |
| Browser | Google Chrome `153.0.8010.12` |
| Harness launch | remote debugging 9333, dedicated `tmp/cdp-profile`, native occlusion disabled |
| Power plan | Balanced (`381b4222-f694-41f0-9685-ff5bb260df2e`) |

Не были зафиксированы clocks/thermals и WebGPU adapter limits; это остаётся частью
воспроизводимого environment envelope для следующего прогона.

Быстрая петля итерации:

```powershell
bun run typecheck
bun test tools/aot/identity-envelope.test.mjs
bun run gate:jit-integrity
```

Release gate:

```powershell
bun run gate
```

Он выполняет полный 24-шаговый порядок из `CLAUDE.md`, включая artifact/ABI validators и
полный test suite. Быстрая петля не заменяет release gate.

Исторический промежуточный итог до финального remediation:

- project static gate: **3774 pass / 0 fail**;
- targeted D3D9 suite: **54 pass / 0 fail**;
- AOT identity envelope и oracle self-test: pass, self-test **41/41**;
- memory OOB и staged AOT transaction contracts: pass;
- `fpu-absolute`: interpreter/JIT × strict/relaxed — `VERDICT: all OK`;
- TypeScript typecheck: pass.

Финальный `bun run gate` прошёл целиком: 3,797 tests, 0 failures, 9 snapshots,
TypeScript typecheck, Naga WGSL validator, D3D9 ABI/capture и memory/JIT validators зелёные.

В процессе уборки были найдены два устаревших oracle expectation: JIT config ABI 3 вместо 4
и старый комментарий, что relaxed FPU игнорирует x87 precision control. Runtime contract уже
явно требует PC rounding и interpreter/JIT совпадали; fixtures синхронизированы с этим
контрактом.

## Ограничения заявления

Результат фиксирует, что данная runtime-сборка выполнила 60+ host FPS для конкретного
x86/D3D9 proxy на reference host при чистых API/backend/arena/query ledgers. Он всё ещё
**не доказывает** raster-result каждой GPU операции или корректность default runtime на всём x87
state-space. Он также не доказывает глобальное превосходство над каждым существующим
x86→WASM эмулятором и не заменяет проверку оригинальной игры. Для внешнего заявления «SOTA»
нужны публичный cross-emulator corpus, одинаковый browser/toolchain и
опубликованные raw results.

Кроме того, до строгого заявления о величине ускорения всей кампании остаются: final-bundle
baseline на pre-campaign build, Far Cry guest-opcode census рядом с proxy-census и
scale-ratio falsification test. Correctness/instrumentation remediation и новый full
revalidation закрыты.
