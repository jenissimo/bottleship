# Generic CPU/HLE/D3D: ревью и план v2

Дата: 2026-09-04. Статус: архитектурное ревью и план экспериментов; новых измерений перфа нет.
Заменяет [первый план](../../plan/generic-cpu-hle-d3d-performance-plan-2026-09-04.md).

Осмотрено дерево `88a8024dbb7b8b17e3426dbc5a2d61e3951e345a`,
v86 `443a22114e6678d107272deb9b2cda01b048c15b`, с незакоммиченными изменениями
в thunk-dispatcher, winapi-call-ring и harness/state. Это не хеш воспроизводимого performance-arm.
Ревью не меняет runtime, флаги, guest ABI или пользовательские изменения.

Цель: generic прирост **не менее 20% FPS** на нескольких CPU-bound workload-ах.
NFSU — один тест. Цель 60 FPS на максимальных настройках остаётся отдельным, значительно
более крупным разрывом. Сравнение с Pentium не заменяет измерение host-времени на ту же работу.

## 1. Что в первом плане требует исправления

### R1 — P1: предел текущего render-worker split принят за предел архитектуры

V1 §1.3/D6 ограничивает render worker примерно четырьмя миллисекундами и ставит его после
остальных D3D-оптимизаций. Основание — [старый scoping](../../plan/render-worker-scoping.md),
где `captureDrawState` и вычисление pipeline identity отнесены к producer, поскольку они
должны исполняться после соответствующих setters.

**Порядок исполнения не требует одного потока.** При захвате аргументов, порядке команд,
сохранении lifetime и локальном обслуживании guest-visible state последовательность можно
воспроизвести на graphics worker. Гостю нужен результат API, а не внутренний pipeline ID.

Есть существенное ограничение: текущий `resolveProgrammablePipeline()` также отказывает
на неподдерживаемом состоянии; `SetTexture` имеет refcount/shadow-эффекты. Просто перенести
эти функции нельзя. Нужно выделить обязательную синхронную семантику и отложенную подготовку.

**Исправление:** отдельно оценивать старый перенос `execute()` и новый перенос D3D frontend
после выделения небольшого guest-visible state owner. Старый `noExecute` не ограничивает второй.

### R2 — P1: Tier-3 выбран победителем до доказательства нового источника выигрыша

V1 A2 предлагает большой Wasm function с GPR locals, ограниченным CFG и guards. Но
`jit_generate_module()` уже загружает восемь GPR в locals; есть intra-module edges,
RET speculation/chaining, dead flags и экспериментальные regions. Само слово Tier-3 и длина
128–256 инструкций не создают нового execution contract.

Особенно слабый gate — закрыть весь трек, если один integer-only region не достиг 1.3x:
он может не содержать FP, memory или HLE-работу, ради которой нужен новый компилятор.

**Исправление:** сначала измерить три независимых механизма: устранение конкретных дорогих
границ, амортизация memory guards, оптимизация вычислений через границы функций/helpers.
Новым компилятором заниматься только для механизма с подтверждённым сигналом.

### R3 — P1: существующие fast paths и отрицательные результаты недоучтены

В текущем дереве уже есть:

- WBUF CALL intrinsic: `jit.rs::jit_wbuf_intrinsic_execute`, регистрация в
  `thunk-dispatcher.ts::registerWbufDynarecIntrinsic`, default enabled при отсутствии `false`;
- pipeline prologue memo и capture-state memo в `d3d9-device.ts`;
- `tryRenderBundleFastHit()` с exact guards, повторной staging constants и fallback;
- compact MegaRun/storage path, причём часть ранних performance-оценок инвалидирована.

[Negative-results registry](negative-results.md) уже содержит неудачи generic inline WBUF,
широких regions, structural MRU, fastmem writes и render-bundle variants.
Это не запрещает новые эксперименты, но требует явно назвать отличие.

**Исправление:** каждому эксперименту нужна строка «что исчезает относительно CURRENT baseline».
Для intrinsics это повторные проверки/маршалинг и границы helpers; для templates — построение
промежуточных draw objects и повторное получение identity, уже выполненное до bundle hit.

### R4 — P1: проценты и память перенесены между разными версиями baseline

71 мс — историческое окно из [отчёта NFSU](nfsu-max-settings-ceiling-2026-09-02.md).
Разбиение получено проекцией долей sampling trace на живой кадр; это sizing, а не пять
независимых таймеров. Часть описанных в отчёте изменений отгружена после исходного окна.

Старый AOT verdict говорит, что read-fastmem уже включён. CURRENT `codegen.rs::gen_safe_read`
использует inline TLB probe; `gen_fastmem_read_split` помечен DEAD, slots 9/18 retired в
`tools/jit-config/shipping.mjs`. Старые коэффициенты нельзя считать свойствами этой сборки.

**Исправление:** убрать «expected +12–25% / medium confidence». Оставить математические
сценарии с явными предпосылками и заново зафиксировать baseline перед implementation.

### R5 — P1: некоторые correctness-обещания ещё не задают исполнимого контракта

- Проверки instruction budget только на backedge недостаточно: entry/straight-line region
  тоже может пересечь предусмотренный scheduler stop. Нужны допустимые statepoints и счётчик
  исходной guest-работы, в том числе при intrinsic замене.
- «Frame ownership» не замораживает guest RAM. После Unlock гость может снова получить
  тот же ресурс и изменить байты раньше consumer upload. Нужны rename, snapshot или ожидание.
- `Present` не должен безусловно блокировать весь emulator worker через `Atomics.wait`:
  это может остановить async callbacks, audio и обслуживание зависимого RPC. Используется
  существующий guest-thread park/wake и явно определённое условие back-pressure.

**Исправление:** включить эти механизмы в вертикальные срезы, а не оставить их словами у конца плана.

### R6 — P2: измерительная программа слишком большая, зависимости искусственные

Все четыре workload-а и новый универсальный `perfArchitecture` обязательны до любого MVP;
render bundles поставлены после успешного instancing. Это замедляет получение ответа.
Для CPU уже существуют `opcodeCensus`, `dispatchReport`, `tools/s-time.ts::CORE_CLASSES`,
guestbench и AOT oracle. Bundles и instancing решают разные задачи и могут провалиться независимо.

**Исправление:** один основной workload плюс контрастный контроль для первой проверки;
широкий corpus перед default-on. Достраивать только недостающие измерения. Не выводить
generic пользу из одной игры или прокси.

## 2. Новая ставка и честная арифметика

Основной D3D-трек: **маленький синхронный owner гостевого состояния → захваченный поток
команд/данных → специализированная подготовка и выполнение на graphics worker**.

Основной CPU-трек: **убрать повторяющиеся доказательства безопасности и материализацию
состояния на часто исполняемых участках**, используя существующий JIT как baseline и fallback.

Эти треки связаны через описание API effects, но каждый получает самостоятельный эксперимент.
Guest SMP — последующая возможность для реально параллельной гостевой работы.

Чтобы получить прирост FPS, нужно убрать с critical path:

| Цель | Доля времени кадра | На условном кадре 71 мс |
|---|---:|---:|
| +20% | 16.67% | 11.83 мс |
| +30% | 23.08% | 16.38 мс |
| +50% | 33.33% | 23.67 мс |

Следовательно, план из четырёх неопределённых оптимизаций по 1 мс не отвечает задаче.
Нужен либо крупный удаляемый bucket, либо перенос достаточной работы за пределы critical path.

Для удаления работы: `T_new = T_old - R + C`, где R — реально удалённые миллисекунды,
C — новые guards, копии, обслуживание и компиляция, амортизированная на окно.
Для перекрытия: `T_new = T_old - O + C`, где O — измеренное перекрытие, а не весь вынесенный CPU.
При комбинации O считается **после** удаления R, иначе одни и те же миллисекунды учитываются дважды.

Идеальная установившаяся конвейерная модель — `max(frontend, graphics, GPU-process, GPU)`
плюс не перекрываемые зависимости, pacing и contention. В реальности этапы делят CPU/GPU
и память, поэтому модель проверяется трассой. Сумма CPU всех процессов не равна времени кадра.

Иллюстрация, не прогноз: если из 71 мс удалось скрыть 10 мс и транспорт добавил 1 мс,
получится 62 мс (+14.5%). Если отдельно удалить ещё 4 мс из оставшегося frontend,
получится 58 мс (+22.4%). Это объясняет, почему новый split и устранение работы стоит
проверять вместе, сохраняя отдельные arms.

## 3. G: выделить guest-visible D3D state и перенести подготовку рендера

### G0. Составить semantic cut по реальным эффектам

| Обязанность | Синхронно у CPU-гостя | Graphics worker |
|---|---|---|
| HRESULT, pointer validation, поддержка state/caps | Достаточно для точного ответа API; неизвестный случай идёт старым путём | Не определяет задним числом уже возвращённый HRESULT |
| Get*, state blocks, device reset state | Авторитетное логическое состояние, точный порядок и маски Capture/Apply | Реплика состояния для подготовки изображения |
| COM lifetime | Видимые refcounts, binding refs, zero transition | Отдельные internal pins на ресурс до окончания использования |
| Set* constants, UP data | Захват значений/байтов на вызове, без сохранения изменяемого указателя | Последовательное применение delta и формирование GPU-представления |
| Pipeline/bind identity, WGSL, samplers | Только проверки, необходимые для API-результата | Полное deriving/caching/preparation |
| Draw-state snapshots, upload, encode | Короткая команда и корректный resource version | Формирование snapshot и исполнение |
| Queries/readback/Lock hazards | Обработка точного sync-контракта; park при необходимости | Выполнение до нужного sequence и ответ |

Software vertex processing и ProcessVertices с результатом в гостевой памяти требуют
отдельного контракта наблюдения: они не становятся асинхронными только потому, что относятся к D3D.

State blocks — не просто набор GPU-команд: Capture сохраняет соответствующее состояние,
Apply восстанавливает только предусмотренные поля. Это часть producer contract.
Источник: [Microsoft, State Blocks](https://learn.microsoft.com/en-us/windows/win32/direct3d9/state-blocks-save-and-restore-state).

Начать с одной полной programmable draw family: shaders, scalar state, constants, texture
bindings, VB/IB, DrawIndexedPrimitive. StateBlock, query, UP и reset сначала проходят явный
согласованный fallback; недопустимо обходить их через несовпадающие mirrors.

### G1. Проверить разделение в одном worker

Ввести frontend contract и consumer replay, пока оба исполняются последовательно.
Payload содержит ids+generations, state deltas и захваченные байты. У каждой команды sequence.
GPU-derived состояние вычисляется только consumer-ом: прежний путь его больше не считает.

Измерить F (обязательный frontend), G (перенесённая подготовка), C (новые копии/записи).
Сравнить результат каждого API, state snapshots на наблюдениях, lifetimes, draw/query/present
ledgers и изображение. Как диагностический ceiling допустим replay consumer отдельно от guest;
он не является end-to-end ускорением и не подменяет живые query/readback results.

Если G после новых frontend-обязанностей мал или C его съедает, менять границу либо закрыть G.
Не переносить worker лишь ради уже написанного транспорта.

### G2. Chunked pipeline на отдельном worker

Публиковать завершённые chunks в течение кадра: graphics worker начинает подготовку,
пока guest продолжает вызовы. Transport может сначала быть отдельным SAB с payload arena;
полная shared guest RAM для этого не обязательна. Её цена оценивается отдельно при zero-copy.

Owner GPUDevice/context/ресурсов один. В первой поддержанной конфигурации mixed GDI/video/
DDraw маршруты либо имеют явный путь передачи, либо режим выбирает старый backend с начала
сессии. Нельзя переключать ownership GPUDevice посреди кадра.

Ограничить очередь и lifetime payload, выбрать размер chunk по замерам latency/overhead.
Различать published, consumed, submitted и GPU-completed sequence: reuse CPU payload,
уничтожение GPU-ресурса и возврат Present требуют разных гарантий.
Не ждать GPU completion на каждом Present без требования API/pacing; не разрешать
неограниченную очередь ради FPS. Использовать guest park/wake, не блокировать event loop.

**Первый критерий:** измеренное O-C на одном workload заметно превышает шум и прогнозирует
существенную долю требуемых 16.67% кадра. Полезный +8–10% результат можно сохранить как компонент;
он не считается выполнением общей цели. До generic/default-on — второй графический workload,
sync-heavy контроль, отсутствие audio underruns и ухудшения frame tails/input latency.

## 4. T: компилятор повторяющихся D3D-последовательностей

Идея сильнее ещё одного state cache: интерпретировать повторяющуюся последовательность API
один раз, затем исполнять небольшой специализированный план с текущими параметрами.

### T0. Новизна относительно существующего кода

`tryRenderBundleFastHit()` уже умеет сохранять план. Но на вход он получает RenderFrame,
candidate.draws и drawStates; затем сравнивает material/bindings/arguments для каждого draw.
Значительная часть producer-работы к этому моменту оплачена.

Новый template работает **до** `resolveProgrammablePipeline`/`captureDrawState` и построения
больших draw-state objects. Он потребляет сырой захваченный command stream и выводит компактный
список render packets. Это можно проверить на одном worker, независимо от G2.

### T1. Ограниченный partial evaluator

Начать с повторяемого участка 8–64 команд между semantic barriers. Разделить поля на:

- структуру: API sequence, shader/layout identity, topology, маски зависимостей;
- параметры: constant bytes, draw arguments, resource versions и другие изменяемые входы;
- observable effects: результаты, refs, stateblock effects, queries и порядок.

Скомпилированный план содержит готовые маршруты записи constants и dependency transitions.
На hit пройти компактные guards и заполнить параметры; не строить старые objects с последующим
их выбрасыванием. Structural state identities интернируются по точному значению, а monotonic
generations служат проверке свежести: один лишь новый generation не узнаёт повторение A→B→A.

Все поступившие команды по-прежнему учитываются. Цель — уменьшить стоимость на команду,
а не предположить, что можно перестать читать вызовы игры. Для узких hot API callsites
связка с I-треком позже сможет выдавать packet непосредственно.

Guard mismatch имеет точный checkpoint: consumer ещё не опубликовал спорные GPU-команды;
уже применённые frontend effects не выполняются повторно. Capture pointer payload остаётся
на вызове, даже если template обработает его позже. Не переносить последние constants
через Draw, Capture или иное наблюдение. Shader-unused данные сохраняются в логическом
device state для будущих shaders/Get*/Capture, даже если не загружаются на GPU сейчас.

Оценить три независимых варианта: packets с обычным encoder, packets с существующими bundles,
packets с fusion. Bundles переиспользуют записанные команды; dynamic offsets входят в запись,
поэтому changing frame slot требует стабильного layout/отдельного bundle или indirect данных.
Нельзя считать `executeBundles` параметризованным вызовом функции.
Контракт записи: [WebGPU specification, render bundles](https://gpuweb.github.io/gpuweb/#render-bundles).

### T2. Shader-specialized state packets

Сделать shader analysis источником **точного dependency mask** для pipeline, samplers и
constants. Изменение неиспользуемого поля обновляет guest state, но не инвалидирует GPU packet.
Для FFP сначала явно определить зависимости transforms/lights/material; сейчас programmable
capture memo исключает часть hybrid состояния из-за отсутствия нужных generations.

Sparse packing live constant registers остаётся полезным, но решение принимается после
измерения: важны captured/uploaded bytes и стоимость version/hash, а не размер банка сам по себе.
Relative addressing, hidden fog/bump/clip/point tails, int/bool banks имеют полный fallback.

**Gate T:** на одинаковом stream существенно уменьшается суммарная подготовка, включая guards,
parameter packing, uploads и GC; есть end-to-end выигрыш. HIT rate, число packets или bundle
builds сами по себе не доказывают пользу. Начинать с существующих metrics и измерять недостающий
pre-capture участок, а не строить второй набор bundle counters.

## 5. I: объединить JIT и HLE через effect-aware intrinsics

### I0. Описание effects как оптимизируемый контракт

Первый срез — 2–3 горячих семейства API. Расширить существующую WBUF registry, не вводить
ещё один параллельный механизм регистрации. Descriptor задаёт ABI, read/write ranges,
visible state/refcount effects, возможные faults/callbacks/blocking, alias restrictions,
instruction-accounting policy и version guards.

Текущий intrinsic уже убирает вход в x86 trampoline. Он всё ещё ищет descriptor, читает
stack arguments, валидирует страницы и пишет ring для каждого вызова. Это отправная точка.

### I1. Специализация только доказанно горячих callsites

Runtime guards на зарегистрированную цель, process/registry generation и код; затем
короткий специализированный путь с постоянным descriptor. Общий helper остаётся для холодных
и неизвестных сайтов. Размер кода и baseline на промахе входят в gate: предыдущий broad inline
WBUF раздувал код и регрессировал.

Следующий уровень: несколько последовательных effect operations используют один проверенный
ring reservation и scoped доказательства доступности памяти. Удаляются повторные проверки,
а не guest-observable writes. Arguments из SSA можно передавать прямо только после доказательства
их совпадения со stack arguments; записанные guest stack bytes и допустимые faults не исчезают
автоматически. Alias/exception/control-flow mismatch — precise fallback.

Никакие объединённые side effects не откатываются повторным выполнением уже обработанных API.
При невозможности обеспечить original instruction/scheduler accounting участок заканчивается
на прежней границе. Helper, способный callback/park/change memory map, заканчивает scope.

### I2. Оптимизировать уже существующий Wasm HLE compute

Исторические 10.8 мс HLE Wasm — отдельный bucket, который «лучший x86 JIT» сам не ускоряет.
Разделить его на полезную арифметику, обход данных, validation/memory access, повторные загрузки
и dispatch. Для чистого ядра: validate-once по доказанному extent, hoisted plain views, bulk/SIMD,
передача готового результата следующему потребителю без промежуточного формата.

Static-library HLE может удалять **guest JIT** работу тоже; оценивать по фактическому прежнему
выполнению функции, а не только по JS/trap slice. Но это не разрешение заменять EAGL state machine:
сложные mutable controllers остаются гостевыми согласно CLAUDE §3.8, заменяются только чистые
листья/контракты допустимого класса. Версия библиотечного ABI подтверждается; совпадение сигнатуры
само по себе не доказывает семантическую эквивалентность.

**Gate I:** removed helper/guard/guest cost минус новые guards, code-size/tiering и вызовы.
Zero JS traps не означает zero overhead. Не пересчитывать падение числа вызовов напрямую в FPS.

## 6. C: CPU-компилятор, который меняет цену памяти и границ

Подробное архитектурное развитие этого трека:
[Оптимизирующий x86 user-mode транслятор](user-mode-optimizing-translator-vision-2026-09-04.md).

### C0. Сначала найти реально дорогой механизм

Использовать существующие opcode/addressing/dispatch instruments и CPU-time attribution.
Retired instructions, exit frequency и EIP на tick boundary не являются time coverage.
Для top участков нужны времена, причины остановки, число повторных проверок и охват реально
поддержанного slice. Счётчики и sampling запускать отдельно от основного timing-arm.

Три отдельных вопроса:

1. Сколько стоит materialization/dispatch на тех edges, которые baseline ещё не объединяет?
2. Сколько стоит **полная** memory/exception preparation на серии обращений, а не один TLB lookup?
3. Сколько арифметики/адресации/flag/x87 state traffic можно удалить при анализе нескольких блоков?

Старые измерения дешёвого stack guard (~1.7% проекции) запрещают обещать +20% только от стека.
Одной неудачной integer-петлёй не закрывается оптимизация FP или иных memory patterns.

### C1. Scoped memory proofs в существующем JIT

Первый кандидат — короткий прямой участок с несколькими обращениями к одному объекту или
небольшому набору страниц. Guard один раз доказывает точный mapping, права, границы, RAM-kind,
отсутствие MMIO/watch/code-store hazards; арифметика адресов проверяется с x86 wrap semantics.
Внутри scope обращения используют доказанную адресацию.

Это сильнее micro-TLB, который сохраняет lookup на каждом доступе: цель — один guard на группу.
Но early guard failure **не генерирует ранний #PF**. Он отдаёт исполнение baseline до первого
side effect, чтобы исключение возникло на исходной инструкции после исходных предыдущих writes.
Guard не должен иметь посторонних side effects. Accessed/dirty bits и write barriers сохраняются
точно в требуемые моменты; если это нельзя доказать, кандидат отклоняется.

SMC, изменения mapping/protection, data-page→code-page, guest page-table writes, helpers,
callbacks и budget boundaries заканчивают или инвалидируют proof. В первом MVP исключить
участки, способные менять эти предпосылки. Code invalidation распространяется на все зависимые
страницы/алиасы. Не превращать весь HEAP в безусловный fastmem и не включать global fastmem writes.

Для будущего SMP proof отдельно пересматривается: проверка epoch на входе не защищает от
concurrent unmap/write после проверки. Нельзя автоматически совместить single-CPU scope с SMP.

### C2. Hot regions с доказанным удалением границ

Только если C0 показывает boundary cost, строить regions из реально переходящих друг в друга
блоков. Приоритет call/return и indirect edges с устойчивыми целями; локальная прямая петля,
которая уже внутри одного module, может не давать такого выигрыша.

Сначала сохранить baseline lowering всех нужных opcodes, включая FP/helpers как точные fences.
Оптимизировать GPR/flags/addresses на поддержанном подмножестве. Не требовать полного нового
SSE/x87 backend для исполнения смешанного участка; пропущенный helper всё равно имеет цену.

Statepoints обеспечивают точный EIP, lazy flags/FPU/SSE, memory state и retired count.
Вход проверяет остаток budget; внутренние checkpoints не допускают перехода через допустимый
stop. Нужны тесты #PF/#DE, mixed fast/slow FP tags, SMC, helper reentry и прерывания.

### C3. Loop lifting и специализация вычислений

После C1/C2 попробовать обычные compiler transforms над поднятым guest IR: address induction,
load forwarding, dead stores только с доказанным alias/exception contract, scalar replacement
короткоживущих stack slots, loop-invariant work, pure-loop vectorization.

Это позволяет ускорять плоский профиль через **класс циклов**, без списка игровых адресов.
В отличие от ручного HLE контроллера, исходные ветвления и writes программы задают семантику.
Неизвестные calls/aliases остаются barriers. Для FP сохраняются текущий режим и rounding;
нельзя молча включить reassociation или заменить x87 precision/NaN/exception behavior.

CPU-state/guest-RAM separation или multi-memory — отдельный маленький alias-analysis spike,
если сгенерированный host code показывает потери именно из-за aliasing. Не считать его
автоматическим выигрышем и не требовать переписывания памяти до положительного proof of concept.

**Gate C:** measured savings на реальных hot участках, стоимость guards/side exits/compile,
достаточное time coverage для end-to-end результата. Не gate по одному универсальному «1.5x»:
малый локальный прирост на большой доле может быть полезнее большого на редком регионе.

## 7. F: уменьшить число GPU draw-команд шире, чем identical-geometry instancing

Сначала собрать census соседних draw runs с одинаковым pipeline/material и разной геометрией.
Identical geometry — только один случай. Для static geometry можно исследовать объединённый
index stream и per-draw parameter table с преобразованием vertex fetching/идентификатора draw.
Rebuild индексов кешируется по resource version; dynamic-heavy workload может всё проиграть
на копировании и дополнительном vertex work.

Сохранить порядок primitives, topology/strip boundaries, baseVertex, инстансирование, shader
inputs и query границы. Прозрачность, stencil и overlapping geometry запрещают произвольную
пересортировку. Материалы с разными bindings в первом срезе не объединяются.

Render bundles проверяются независимо: они уменьшают повторную запись/validation, но не
гарантируют уменьшение физической GPU работы. Аналогично instancing может увеличить shader
cost. Измерять worker, GPU-process CPU и hardware GPU отдельно.

Не строить portable baseline на предположении о bindless/multi-draw. Документация
[Dawn Multi Draw Indirect](https://dawn.googlesource.com/dawn/+/HEAD/docs/dawn/features/multi_draw_indirect.md)
описывает feature и native API, что само по себе не доказывает наличие в браузерном JS API.
Фактические adapter/device capabilities проверяются на целевой сборке; поддержанный multi-draw
может стать дополнительным arm. Bundle-пример команды WebGPU:
[Animometer](https://webgpu.github.io/webgpu-samples/samples/animometer/).

**Gate F:** экономия encode/submit CPU больше стоимости repack/guard и GPU-regression;
encoded/consumed instance/primitive counts подтверждены независимо от expected counts.

## 8. Resource lifetime и SMP как отдельные задачи

Для G/T/F нужны immutable версии payload, а не лозунг zero-copy:

- DISCARD-совместимое переименование backing, где это допускает контракт;
- dirty-range snapshots для изменяемых данных, на которые уже ссылаются команды;
- прямое чтение backing только при доказанном отсутствии изменения до consumption;
- UP pointer capture на вызове; ring reuse только после consumer ack;
- при memory growth переобретать typed views, не хранить plain guest views между turns.

Стоимость лишней копии сравнивать со стоимостью блокировки/renaming. Нулевая копия не цель,
если ради неё исчезает перекрытие кадров или нарушаются данные.

Guest SMP включать в приоритет только по профилю после G/I: actual secondary-thread host CPU,
RPC frequency, зависимости и waits. Если доля p действительно исчезает с critical path,
идеальный прирост `1/(1-p)`: 11.5% даёт +13.0%, 19.8% даёт +24.7%. Это разные знаменатели,
не «процент retired» и не обещание, что весь secondary CPU можно скрыть.

Потребуются per-CPU state, совместимость memory model, LOCK/Interlocked, unaligned/ordinary
access semantics, SMC/TLB coherence и owner-HLE RPC. Wasm atomics только для LOCK — ещё не
полное доказательство x86 memory contract. Сначала deterministic serialized-two-CPU oracle,
затем concurrency litmus tests и настоящий workload. Старый shared-memory nbench — полезная
проверка feasibility на той сборке, но не текущий browser performance-arm.

## 9. Исполнимый порядок и результаты каждого этапа

| Этап | Конкретная работа | Результат для решения |
|---|---|---|
| M0 | Зафиксировать CURRENT flags/hashes, один NFSU race и один контрастный реальный workload; переиспользовать существующие окна | Новый frame budget, noise floor, версии исходных данных; список уже включённых fast paths |
| M1-G | Измерить guest-visible vs derived D3D effects и стоимость F/G/C; single-worker split для одной draw family | Видно, сколько **новой** работы можно перенести; API/state/ledger differential проходит |
| M1-T | Записать command windows, replay до capture, сравнить старую подготовку и один специализированный template | Цена template hit/miss с parameter capture, без прежних draw objects; same-output oracle |
| M1-C | Census costly boundaries/memory scopes; один scoped-proof или boundary-removal prototype по данным | Первый CPU механизм с причинным сигналом относительно существующего JIT |
| M2 | Выбрать лучший M1 по net saved ms и сложности доказательства; довести один вертикальный срез в живой workload | End-to-end arm с correctness, frame tails и стоимостью compilation/transport |
| M3 | Добавить следующий независимый механизм; переснять budget | Composition по новому critical path, без сложения процентов старых окон |
| M4 | Проверить минимум три реальных workload-а в сумме, включая неграфический/другой API и sync-heavy случаи | Основание для generic default-on или точного runtime eligibility predicate |

M1-G/T/C — независимые проверки, не требование одновременно строить три архитектуры.
Практический первый приоритет — **M1-G**, следом **M1-T**; CPU-прототип выбирать по новому census.
I1 может опередить их, если оставшаяся цена WBUF helper оказывается большим подтверждённым bucket.
Полный guest SMP, новый AOT backend и heterogeneous draw fusion не находятся на critical path
первого +20% результата.

Для каждого arm сохранять baseline/candidate raw results, exact hashes/config, balanced paired
order и same-work scene/input evidence. API/draw/query/present ledgers и output должны совпасть;
candidate-off повторяет pre-feature baseline. Счётчики выполненной работы независимы от плановой.
Performance claim делается по непропрофилированным окнам с оценкой разброса пар, не по снижению
числа инструкций в Wasm или красивому HIT rate. Неизвестные данные отмечаются unavailable.

Проверки runtime-кода: соответствующие CPU/HLE/D3D differential tests и repository gate;
перед performance acceptance — cold/warm cost, p95/p99, audio/pacing и негативный workload.
Для этого документа runtime-тесты не запускались: архитектуры ещё не реализованы.

Работа считается достигшей цели только при воспроизводимом +20% на нескольких CPU-bound
workload-ах, с объявленным охватом и без потери guest-visible работы. Если лучший совокупный
результат меньше — публикуется измеренный предел и причина, а не новая таблица ожидаемых процентов.

## 10. Опорные места для реализации

- [JIT и существующий WBUF intrinsic](../../vendor/v86/src/rust/jit.rs),
  [memory lowering](../../vendor/v86/src/rust/codegen.rs),
  [shipping config](../../tools/jit-config/shipping.mjs).
- [D3D device state/capture/pipeline](../../src/worker/backends/webgpu/d3d9/d3d9-device.ts),
  [backend и существующий bundle fast-hit](../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor.ts),
  [WBUF и stateblock barriers](../../src/worker/modules/d3d9/fast-path.ts).
- [Negative results](negative-results.md),
  [инвалидация ранних FC-оценок](fc-rebench-review-invalidation-2026-09-01.md),
  [текущий статус старого roadmap](sota-roadmap/STATUS.md),
  [измерения census, не профиль NFSU](sota-roadmap/RESULTS-2026-09-02.md).
- [Исторический AOT verdict](../../plan/aot-absorption-verdict-2026-08-28.md),
  [исторический render-worker split](../../plan/render-worker-scoping.md),
  [shared-memory эксперимент](../../plan/experiments/e5a-shared-memory-perf.md).
