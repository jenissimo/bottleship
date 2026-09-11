# Оптимизирующий x86 user-mode транслятор: план реализации

Дата: 2026-09-04. Статус: revision 3 после второго архитектурного ревью.
Основание: [архитектурное видение](user-mode-optimizing-translator-vision-2026-09-04.md).

## 1. Цель и точка старта

Первый вертикальный срез должен ответить на один вопрос: **может ли semantic IR убрать
измеримую обязательную работу текущего v86, сохранив memory, fault, state и accounting
contracts?**

Существующая инфраструктура `tools/aot` используется для capture, corpus, сравнений и
проверки внешнего ABI. Текущий direct decoder-to-Wasm compiler остаётся независимым
контрольным producer. Новый compiler получает собственный versioned IR и verifier.

Первым workload выбирается реальный integer memory/branch kernel, для которого актуальный
профиль показывает один из двух измеримых buckets:

- повторная memory/permission/fault preparation;
- canonical state materialization и dispatch на конкретной границе, которую текущий
  shipping v86 не может оставить внутри одного исполнения.

`k6` используется как conformance vector, но не как источник performance claim. Нужен второй
реальный контрастный kernel, где выбранный механизм неприменим: он измеряет цену infrastructure
и candidate lookup на неподходящем коде.

До production registry regions запускаются через лабораторный adapter с canonical entry/exit.
Такой arm измеряет kernel, guards и materialization, но не объявляется измерением production
dispatch overhead.

## 2. Первый полезный результат

Вертикальный срез завершён, если одновременно выполнены условия:

1. Одна captured задача запускается четырьмя arms: shipping v86, IR без optimizing passes,
   IR с одним pass и direct-Wasm diagnostic.
2. Arm B совпадает с A по guest memory, GPR, materialized EFLAGS, EIP, fault identity,
   instruction accounting и независимому effect/work ledger.
3. На каждом canonical exit B восстанавливает представление state, которое текущий engine
   может продолжить без adapter-specific знаний.
4. Arm C отличается от B одним перечисленным pass и проходит тот же correctness oracle.
5. C быстрее A на fixed-work real kernel после учёта entry, guards, exits и materialization.
6. Guard miss до первого effect, fault, budget exit и unsupported instruction продолжаются
   в baseline с правильной точки и не повторяют уже совершённые stores.
7. Контрастный kernel не получает значимой регрессии при включённом candidate lookup.

Первый срез может не поддерживать x87/SSE, callbacks, SMP, persistence и полный x86. Для
неподдержанной инструкции lifter обязан знать её длину, чтобы завершить region точно перед ней.
Если длина неизвестна, region заканчивается на последней доказанной границе.

## 3. Архитектура реализации

Compiler core реализуется как отдельный Rust crate с чистым API и собирается в Wasm. Один
compiler artifact используется offline runner-ом и browser compile worker-ом. Предлагаемая
структура:

```text
tools/aot/opt/
  compiler/                  отдельный Rust crate
    src/
      contract.rs            envelope, dependency kinds, exit reasons
      decode.rs              минимальный decoder/lifter поддержанного slice
      ir.rs                  Guest IR и optimizing IR
      builder.rs             SSA values и effect chains
      interpret.rs           эталон поддержанного IR
      verify.rs              structural и semantic invariants
      lower_wasm.rs          conservative и optimized lowering
      passes/
        canonicalize.rs
        flag_liveness.rs
        constant_cse.rs
        memory_scope.rs
  adapter.mjs                лабораторный canonical entry/exit и baseline continuation
  runner.mjs                 A/B/C/D fixed-work orchestration
  result-schema.mjs          единый формат результатов и provenance
  print-ir.mjs               стабильный dump для review/snapshots
```

`tools/aot/lib/decode.mjs` остаётся полезным независимым slice и length oracle, но не считается
полным frontend нового compiler. `tools/aot/lib/abi.mjs`, текущий Wasm verifier и AOT oracle
переиспользуются только для тех частей внешнего ABI, которые они действительно проверяют.
Новый artifact получает новые compiler/IR/verifier versions.

JavaScript prototype compiler допустим только как одноразовый diagnostic arm D. Он не становится
второй реализацией semantic core и не определяет production artifact format.

### 3.1 Минимальный IR v1

```text
Value       = Const | GprRead | Extract | Insert | Unary | Binary | Select
Address     = offset + segment semantics + width + wrap policy
MemoryOp    = Load | Store | Rmw, guestPC, permissions, effectIn/effectOut
FlagRecipe  = operation + operands + defined/preserved/undefined masks
State       = 8 GPR values + partial-register merges + FlagRecipe + FP/SIMD passthrough
Guard       = predicate + dependencies + miss statepoint
Statepoint  = continuationEIP + reconstruction + accounting delta + exit reason
Terminator  = Branch | Jump | BaselineExit | FaultExit | BudgetExit
Region      = envelope + CFG + entries + memory scopes + code dependencies + exits
```

IR v1 использует одну консервативную effect chain для guest memory, runtime state, helpers и
наблюдаемых scheduler effects. Loads не считаются pure. Разделение цепочки допускается после
отдельного alias/effect proof, который описывает порядок между классами и доказывает, что
операции одного класса не наблюдают другой. Арифметическое CSE применяется только к pure nodes.
Каждая potentially faulting operation несёт guest PC, fault order и statepoint.

FP/SIMD state, не изменяемый поддержанным integer slice, проходит через region без изменения.
Если instruction/helper может его изменить или наблюдать, region заканчивается перед boundary.

## 4. Контракты, которые фиксируются до compiler core

### 4.1 Execution envelope и владельцы зависимостей

Для каждого поля envelope фиксируются способ проверки, владелец изменения и срок действия.
Первоначальная матрица:

| Предпосылка | Проверка на entry/publication | Владелец изменения | Срок proof |
|---|---|---|---|
| Code bytes | content hash + code generation | guest SMC через v86; JS code writes через `guest-code.ts` | До invalidation соответствующих страниц |
| Mapping и guest permissions | page/TLB state + mapping generation | v86 page tables и `PageTableManager` | До mapping/protection/page-table effect |
| Ordinary RAM, не MMIO/runtime storage | region kind и TLB flags | memory map/AddressSpace owner | До region-map generation change |
| Отсутствие watchpoint/debug special path | debug/watch generation | CPU debug owner | До debug generation change |
| Store не требует SMC barrier | `TLB_HAS_CODE`/code-page metadata | JIT code ownership и invalidation owner | До code ownership change |
| A/D metadata уже допустима | accessed/dirty bits уже выставлены в нужном порядке | guest page tables/v86 walker | Только для проверенных страниц и access kinds |
| DS/SS/FS semantics | segment state + thread identity | CPU/thread scheduler | До segment write или thread switch |
| Single executing guest CPU | execution-mode bit | CPU scheduler/runtime configuration | До смены execution mode |
| Helper/intrinsic semantics | versioned descriptor hash | helper registry owner | До ABI/effect version change |
| Engine/memory layout | engine and ABI hashes | v86 build/runtime | Жизнь instance |

У каждого generation должен быть один названный owner и один publication/invalidation path.
Общий epoch без списка зависимостей не принимается как механизм корректности.

### 4.2 Instruction accounting и scheduler

P0 фиксирует актуальные conventions v86 исполнением и differential tests, а не переносит их
из исторического контракта. У compiler два разных понятия счётчика:

- **engine instruction counter** — наблюдаемое runtime-состояние; на canonical boundaries он
  обязан совпадать с актуальной convention v86, включая её block-level credit и fault behavior;
- **committed logical-work ledger** — независимый oracle/measurement counter фактически
  завершённых guest instructions, iterations и effects; он не управляет виртуальным временем.

IR может держать pending engine delta внутри region, но каждый statepoint материализует значение,
которое получил бы текущий v86 на том же пути. Logical-work ledger не начисляет instruction или
iteration до завершения соответствующей работы. Для каждого выхода задаётся:

| Событие | Continuation | Accounting obligation |
|---|---|---|
| Entry guard miss | исходный region entry | нулевая delta обоих счётчиков |
| Memory proof miss | начало ещё не исполненного scope | engine state по v86 convention; ledger содержит только завершённые предыдущие scopes |
| Cold/indirect exit | вычисленный guest target | engine state по v86 convention; ledger содержит завершённый путь |
| Реальный fault | faulting guest PC и текущий `previous_ip` contract | точное engine counter value v86; ledger отдельно отмечает завершённую работу до fault |
| Budget exit | разрешённый checkpoint | materialized engine delta и ledger завершённых instructions/iterations |
| Helper/unsupported boundary | инструкция перед существующим baseline path | boundary instruction не исполняется и не учитывается второй раз |

Runtime contract дополнительно фиксирует remaining quantum на entry, допустимый overshoot,
urgent-exit visibility и максимальный straight-line интервал между checkpoints. Для текущего
v86 отдельно фиксируется момент block-level credit относительно fault. Loop transforms хранят
engine delta и logical-work delta по фактически выбранному пути и числу iterations.

Tests обязаны покрыть маленький остаток quantum, fault в каждой memory operation, выход после
store и продолжение через scheduler. Производительность не принимается, если candidate выполняет
больше работы за окно благодаря более редким stop points.

### 4.3 Уровни correctness oracle

Старый AOT oracle разделяется на три слоя:

1. **Architectural/effect equivalence:** guest memory, GPR, materialized EFLAGS, EIP, FP/SIMD,
   fault vector/address/PC, completed effects и logical-work ledger.
2. **Canonical continuation:** после каждого exit baseline исполняет контролируемый suffix,
   который потребляет registers, flags, memory и scheduler state; итог сравнивается с A.
3. **Representation compatibility:** raw lazy-flags tuple, dirty masks и engine-private fields
   проверяются на canonical boundaries по выбранной ABI version.

Для MVP Arm B/C материализует тот же raw lazy tuple, что shipping v86. Это узкая compatibility
policy первого ABI, а не требование к private FlagRecipe внутри region. Будущая другая canonical
representation требует version bump, materialization adapter и continuation tests; совпадение
только `get_eflags()` недостаточно.

Проверки старого producer, завязанные на форму generated Wasm, не переносятся автоматически.
Например, реализация D7 считает relocated TLB loads и проверяет их соответствие relocation sites;
этого недостаточно, чтобы доказать заявленное свойство «один TLB probe на каждый access», и сама
такая форма конфликтует с целью scoped proof. Новый verifier вместо D7 проверяет proof
dependencies, dominance guard-а, отсутствие invalidating effects, правильный scope exit и
reconstructability statepoints.

## 5. Этапы реализации

### P0 — Измеримый contract и corpus

Задачи:

- записывать git/v86 revisions, engine SHA, shipping JIT readback, browser revision, memory,
  helper, compiler и FP ABI versions в каждый result;
- выбрать основной kernel по CPU-time и снять актуальный trace;
- определить fixed-work input и независимый effect/work ledger;
- измерить в A dispatch, body, safe-memory preparation, helpers, canonical flush/reload и exits;
- зафиксировать accounting/scheduler contract из §4.2;
- добавить absent, read-only, cross-page, A/D-unset, code-page и mapping-change cases;
- добавить контрастный real kernel;
- сохранить bytes, relevant initial state, mappings, permissions и ожидаемые effects.

Артефакты P0:

- versioned corpus manifest;
- baseline JSON с provenance и raw samples;
- dependency-owner matrix с реальными API/generations;
- таблица конкретной работы, которую может удалить каждый кандидат;
- воспроизводимые команды Node correctness и stock-browser timing runs.

Gate P0: baseline устойчив на fixed work; mutations work ledger, entry identity, fault PC,
accounting и dependency generation обязательно проваливают соответствующий oracle. Выбранный
bucket имеет достаточную измеренную долю CPU-time, чтобы локальный выигрыш мог повлиять на цель.

### P1 — Rust semantic core, lifter и interpreter

Порядок:

1. Создать Rust crate, execution envelope, IR schema, stable serialization и verifier.
2. Реализовать минимальный decoder/lifter для instruction families первого kernel: GPR
   `mov/lea`, integer ALU, `cmp/test`, branches и необходимые loads/stores.
3. Явно реализовать `AL/AH/AX/EAX` merge semantics и INC/CF adversarial case.
4. Реализовать FlagRecipe и сохранить все operands, нужные любому statepoint.
5. Реализовать IR interpreter с byte-addressed memory, permissions, ordered effects и faults.

Gate P1:

- decoder/lifter differential проходит corpus и сгенерированные states;
- IR verifier отклоняет missing guest PC, effect edge, dependency и reconstruction input;
- interpreter совпадает с A на поддержанном slice;
- mutation tests ловят пропущенный store, неверный CF через INC, EIP, fault order, A/D effect,
  accounting delta и потерянный reconstruction value;
- interpreter exits содержат полную reconstruction и обе accounting deltas.

### P1.5 — Лабораторный adapter и точный fallback

До Arm B и optimized-entry registry нужен исполнимый partial-region contract:

1. Adapter принимает canonical CPU state, region entry и immutable captured environment.
2. Guard miss возвращает исходный entry без guest effects.
3. Unsupported/helper exit возвращает continuation перед ещё не исполненной instruction.
4. Fault exit использует существующий двухфазный v86 fault path после materialization.
5. После выхода baseline исполняет suffix до общего capture point.
6. Attribution считает только вызовы конкретной function identity и отдельно отмечает
   выполненную baseline residual work.

Сначала adapter проверяется на identity/diagnostic candidate с намеренными guard, unsupported,
fault и budget exits. После этого его ABI становится целью conservative lowering Arm B. Adapter
доказывает semantics и локальную цену entry/exit. Отчёт помечает production dispatch,
publication lookup и live invalidation overhead как ещё не измеренные.

Gate P1.5: identity/diagnostic candidate проходит canonical continuation oracle; unsupported
hole не вытесняет candidate и не превращает сравнение в незаметный JIT-vs-JIT arm.

### P1.6 — Conservative lowering и Arm B

1. Rust core генерирует Wasm с одной полной safe-memory preparation на access.
2. Entry/exit ABI реализует adapter contract P1.5 и accounting P0.
3. External artifact verifier проверяет envelope, imports, relocations и statepoints.
4. Все три уровня oracle сравнивают generated Arm B с A, включая baseline suffix.

Gate P1.6: B корректен на полном поддержанном corpus; его slowdown против A измерен по bucket-ам
в Node и stock browser и оставляет реалистичный performance budget для P2.

### P2 — Один новый mechanism

Механизм выбирается только из attribution P0/P1:

| Измеренное наблюдение | Допустимый первый механизм |
|---|---|
| Полная memory preparation занимает существенную долю | Scoped memory proof |
| Конкретная canonical boundary имеет измеримые flush/reload/dispatch | Boundary elimination/fusion |
| Оба bucket малы | Выбрать другой kernel/class и повторить P0 |

`constant-cse` и flag liveness включаются отдельными flags и ablation arms. Они не подменяют
доказательство нового execution mechanism.

#### P2-M — Scoped memory proof

Первый scope покрывает короткий straight-line участок или один bounded loop без helpers,
callbacks, mapping writes и scheduler-visible operations.

До emission pass строит proof certificate:

| Обязательство | MVP policy |
|---|---|
| Address arithmetic | 32-bit wrap, segment semantics и все затрагиваемые страницы доказаны |
| Permissions | read/write requirements проверены отдельно для каждого access kind |
| RAM class | MMIO, mapped range, watchpoint и runtime storage отклоняются |
| SMC | store scope отклоняет страницы с code/barrier obligation |
| A/D bits | необходимые bits уже установлены; guard сам не меняет guest metadata |
| Lifetime | dependency generations стабильны до конца scope; invalidating effect закрывает scope |
| Failure | guard отказывает до первого effect; baseline начинает scope с его первого instruction |

Page crossing разрешён только когда certificate покрывает обе страницы. Alias pointers не мешают
при сохранённом исходном порядке; load/store reorder требует отдельного alias proof.

Negative controls: pass off, one-access scope, forced miss, unset A/D bits, absent/read-only/
cross-page/code mappings, aliasing pointers, 32-bit wrap и generation change до publication.

#### P2-B — Elimination границы

Этот механизм допускается только после фиксации конкретной shipping boundary:

- где A выполняет canonical stores/loads, dispatch или helper transition;
- почему существующие multi-block modules и GPR locals её не устраняют;
- какое новое proof делает сохранение private state корректным;
- какие точные instructions/calls/stores исчезнут в C;
- где остаются callbacks, indirect targets, faults и scheduler fences.

Объединение обычных прямых blocks внутри уже существующего v86 module не считается новым
механизмом. Call/return fusion требует guard return target и точной stack semantics.

Gate P2: C быстрее A на real kernel с required faults, budget checks и materialization. A и C
измеряются как uninstrumented fixed work в одном stock-browser harness и одинаковом envelope;
Node runs используются для correctness и диагностической attribution. Отчёт содержит time
coverage, guard hit/miss reasons, exit reasons, удалённые и добавленные operations, compile cost,
code size и прогноз общего CPU speedup. Если browser C не быстрее browser A, результат заносится
в `negative-results.md` до добавления следующего pass и до перехода к runtime registry.

### P3 — Optimized-entry registry в runtime

Registry сосуществует с baseline page ownership и отвечает только за опубликованные
`process incarnation + guest EIP + envelope hash + dependency generations`.

Publication protocol:

1. На CPU safe point снять immutable code/profile/environment snapshot.
2. Скомпилировать и проверить artifact вне critical path.
3. Подготовить Wasm, relocations, dependencies и transaction до commit.
4. Синхронно повторить code, envelope и generation validation.
5. Опубликовать без `await` между последней validation и commit.
6. Dependency owner снимает stale entry; baseline для страницы остаётся доступным.

Registry использует общий table allocator, function-identity validation и owner invalidation
существующего JIT/AOT runtime. Он не создаёт независимый несогласованный page cache.

Counters: attempts, hits, misses по причинам, exits по statepoint, retired/logical work,
compile/validate/publish time, artifact bytes, invalidations, evictions, backoff и baseline residual.

Gate P3: SMC, decommit/recommit, process reset, slot reuse, mixed modes, callback reentry,
thread switch и budget tests проходят; low-coverage workload не регрессирует из-за lookup.

### P4 — Расширение time coverage

Следующая instruction family, helper adapter или pass выбирается по потерянной CPU-time доле:

1. family, разрывающая самые дорогие regions;
2. memory/flag pass с наибольшей projected net saving;
3. versioned non-reentrant HLE intrinsic с effect descriptor;
4. x87/SSE forwarding при измеримой materialization FP state;
5. indirect/call fusion и loop transforms после стабилизации exits.

Для каждого расширения повторяется A/B/C ablation. Ограничиваются region size, live SSA values,
versions per entry, compile budget и total artifact bytes.

### P5 — Compile worker и persistence

После интегрированного steady-state сигнала:

- cache key включает code/relocations, compiler/pass versions, engine/memory/helper ABI,
  FP policy и Wasm features;
- persisted artifact повторно проходит P3 validation;
- browser Wasm compilation/tiering измеряется отдельно от lift/optimize/emit;
- cold start остаётся работоспособным на baseline;
- worker contention, memory pressure и invalidation churn входят в end-to-end результат.

Runtime generations из другой process incarnation не используются как persistent identity.

### P6 — Критерий результата видения

Исследование достигает исходной цели, когда stock-browser fixed-work CPU throughput примерно
вдвое выше A на нескольких реальных CPU-heavy workloads с достаточным time coverage. Для каждого
workload рассчитывается:

```text
CPU speedup = 1 / ((1 - S) + S / X + C)
```

где `S` измерен по CPU-time, `X` включает guards/exits, а `C` включает dispatch, compilation,
publication и непокрытый-path overhead. Node oracle доказывает корректность и помогает локальным
timings; итоговый throughput измеряется в целевом stock browser.

Application FPS/loading/audio результат сообщается отдельно. Перед default-on нужны несколько
приложений разных профилей, SMC/mapping/thread/callback suite, cold/warm/steady-state runs,
отсутствие scheduler/audio starvation и ограниченные compile CPU, memory и invalidation churn.

## 6. Arms и формат результата

| Arm | Реализация | Что доказывает |
|---|---|---|
| A | Shipping v86 с полным config readback | Реальный baseline |
| B | Новый IR с conservative lowering | Цена semantic infrastructure |
| C | B + ровно перечисленные passes | Причинный выигрыш |
| D | Direct Wasm той же задачи | Diagnostic compute-cost reference |

Каждый result содержит provenance/envelope, fixed-work id и count, raw timing samples, warmup,
median/p95 и interval, entry/guard/body/materialization/helper/exit buckets, state/effect digests,
coverage по CPU-time, code size, compile stages, function identity и oracle verdict.

D не входит в accepted gains. Instrumented run объясняет стоимость; отдельный uninstrumented
fixed-work run принимает performance result.

## 7. Последовательность reviewable changes

1. **Contract/corpus:** P0 provenance, owner matrix, accounting, real kernel и baseline report.
2. **Rust core skeleton:** envelope, IR, serialization, printer и structural verifier.
3. **Lifter/interpreter:** минимальный slice и differential tests.
4. **Laboratory adapter:** canonical exits, baseline suffix и attribution.
5. **Arm B:** conservative Wasm lowering и трёхуровневый oracle.
6. **First mechanism:** один pass, proof verifier, negative controls и A/B/C/D report.
7. **Runtime registry:** coexistence, transactional publication, invalidation и counters.
8. **Browser/live evidence:** integrated workloads и решение expand/stop по P6.

Новый opcode, optimizing pass и runtime publication не объединяются в один change: oracle
должен однозначно связывать divergence с изменённым слоем.

## 8. Stop conditions

Направление пересматривается, если:

- D почти не быстрее A на выбранном kernel;
- infrastructure B оставляет недостаточный budget для достижимой экономии;
- guards и materialization съедают savings при реалистичном scope;
- time coverage недостаточен для заметного общего CPU effect;
- корректность требует weakened fault semantics, глобального fastmem или недоказанного SMP;
- low-coverage lookup overhead нельзя убрать;
- compile time, code size или invalidation churn растут быстрее полезных entries;
- после P3 расчёт по `S`, `X`, `C` показывает недостижимость целевого throughput на выбранных
  workload classes.

Отрицательный результат сохраняется с точным envelope и закрывает проверенную форму механизма,
а не весь semantic-IR подход.

## 9. Первый практический change

Первый change реализует P0:

1. выбирает один real memory/branch kernel из актуального trace;
2. добавляет captured input и независимый effect/work ledger;
3. фиксирует dependency-owner matrix и accounting cases;
4. вводит единый result schema при реально работающем Arm A;
5. снимает Node correctness baseline и stock-browser fixed-work attribution;
6. доказывает mutations для ledger, fault PC, accounting и function identity;
7. выбирает P2-M или P2-B по измеренному удаляемому bucket.

После этого минимальный P1 slice определяется фактическими instructions выбранного kernel.
