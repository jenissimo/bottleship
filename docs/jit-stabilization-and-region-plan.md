# JIT: план стабилизации и развития region-компилятора

## Краткое решение

Сначала закрыть integrity и lifecycle-дефекты существующего baseline JIT, затем
зафиксировать измеримый профиль реальных игровых сцен. Region JIT начинать только
как изолированный эксперимент с явным performance/correctness gate.

```text
Зафиксированный baseline
→ memory/JIT/ABI/AOT correctness
→ обязательный regression gate
→ профиль реальных сцен
→ новая hotness policy
→ минимальный region MVP
→ PIC
→ HLE
→ persistence и relocatable modules
```

## 1. Цели и границы

### Цели integrity milestone

- Исключить повреждение WASM runtime через raw guest-memory API.
- Восстанавливаться после неудачного `WebAssembly.instantiate()`.
- Явно обнаруживать несовместимый JS↔Rust ABI.
- Сделать публикацию AOT-модуля транзакционной.
- Строить AOT-key из фактического состояния codegen.
- Запускать критические repro-тесты в обязательном локальном и CI gate.

### Цели исследовательского трека

- Проверить, уменьшает ли profile-guided region JIT worker CPU и количество
  guest-level transitions на реальных сценах.
- Сохранить baseline JIT единственным надёжным fallback-path.

### Исключённый scope первого цикла

- Полная PE→WASM-рекомпиляция.
- Direct HLE lowering.
- Глобальная переделка identity модулей.
- Persistent optimized regions.
- Новые JIT-флаги и отдельные микрооптимизации dispatch.

Перед началом реализации нужен отдельный baseline-коммит: рабочее дерево может
содержать независимые изменения, в том числе в `vendor/v86`.

## 2. Последовательность реализации

### Этап 0. Зафиксировать baseline

Собрать для трёх-пяти воспроизводимых сцен:

- worker CPU median/p95/p99;
- guest instructions/frame;
- module entries и exits;
- helper calls;
- compile count, emitted bytes и compile wall time;
- table-slot high-water;
- correctness hashes;
- значения всех JIT-конфигураций.

Минимальный корпус:

- NFSU race;
- тяжёлый scene traversal;
- меню → гонка → меню;
- FP-heavy workload;
- SMC/page-protection-heavy workload;
- software-rendering loop;
- AOT cold и warm start.

Результат: commit SHA, JSON-артефакты измерений и оценка noise floor. Все
дальнейшие A/B сравниваются с этим baseline.

### Этап 1. Release-safe guest memory

Основной файл: `vendor/v86/src/rust/cpu/memory.rs`.

Изменения:

- Ввести единый `checked_guest_range(addr, len)` на `checked_add`.
- Проверять весь диапазон `[addr, addr + len)` относительно фактического RAM size.
- Не разыменовывать память после обнаружения OOB.
- Проверять обе стороны `memcpy`.
- Разделить checked API и явно `unsafe` unchecked API с локально доказанным
  контрактом.
- Сохранить OOB-счётчики и диагностику; в debug разрешить fail-fast, в release
  использовать детерминированный безопасный отказ.

Тесты:

- адрес ровно за концом памяти;
- частичное пересечение конца памяти;
- переполнение `u32`;
- OOB source и destination у `memcpy`;
- нулевой диапазон;
- отсутствие изменения runtime metadata после OOB;
- корректное overlapping-copy поведение в валидном диапазоне.

Критерий выхода: guest-derived адрес не достигает `mem8.offset()` без успешной
проверки или локально доказанного unsafe-контракта.

### Этап 2. Recovery после failed JIT instantiation

Основные файлы:

- `vendor/v86/src/cpu.js`;
- `vendor/v86/src/rust/jit.rs`.

Добавить симметричный API:

```text
codegen_finalize
├─ success → codegen_finalize_finished
└─ failure → codegen_finalize_failed
```

`codegen_finalize_failed` должен:

- атомарно забрать `ctx.compiling`;
- обработать оба состояния: `Compiling` и `CompilingWritten`;
- вернуть table slot ровно один раз;
- восстановить provisional page/TLB state;
- разрешить последующую компиляцию;
- записать страницу, класс ошибки и счётчик отказов.

Карантин повторно падающих страниц не входит в первый fix: его добавлять лишь
после подтверждённой compile storm по реальным логам.

Regression test:

```text
инъекция одного невалидного WASM
→ publication отсутствует
→ free-list восстановлен
→ compiling очищен
→ следующая валидная hot page успешно компилируется
→ jit-alive подтверждает исполнение JIT
```

### Этап 3. ABI handshake и единый fingerprint

Основные файлы:

- `vendor/v86/src/cpu.js`;
- `vendor/v86/src/rust/jit.rs`;
- `src/worker/core/cpu/preemption-manager.ts`;
- `src/worker/core/cpu/aot-cache.ts`.

Минимальный ремонт:

- Удалить использование retired config index `4` и старый static block-chaining
  probe, если у него нет иных потребителей.
- Неизвестный `set_jit_config` должен возвращать ошибку.
- Неизвестный `get_jit_config` должен возвращать sentinel, не `0`.
- Экспортировать ABI version и supported mask.
- Проверять handshake до применения конфигурации.

Затем перенести создание AOT fingerprint в Rust:

```text
jit_config_abi_version
jit_config_supported_mask
jit_codegen_fingerprint
get_relaxed_fpu
```

Fingerprint включает все параметры, меняющие emitted bytes или допустимость
replay: `MAX_PAGES`, region/page budgets, RET-spec budgets, codegen flags,
фактический FPU mode и memory-layout/fastmem contract. TypeScript не должен
поддерживать этот список вручную через `SHAPE_FLAGS`.

Критерий выхода: несовместимый ABI или fingerprint безопасно отказывается от
JIT/AOT unit, а не даёт trap или тихое значение `0`.

### Этап 4. Transactional AOT publication

Основные файлы:

- `src/worker/core/cpu/aot-cache.ts`;
- `vendor/v86/src/rust/jit.rs`.

На первом шаге сохранять exact-slot AOT. Не объединять этот fix с `ModuleHandle`.

Предлагаемый протокол:

```text
begin_aot_unit(slot)
→ push_page(page, state, entries)
→ prepare_aot_unit()
→ JS instantiate + table.set
→ commit_aot_unit()
```

`prepare` обязан проверить:

- реальный `WASM_TABLE_SIZE`;
- отсутствие duplicate pages;
- валидные entry lists; coverage-page может иметь пустой list для SMC invalidation,
  но во всём AOT unit должен быть хотя бы один entry;
- что все страницы свободны;
- что до `commit` не меняются `ctx.pages` и dispatch metadata.

После успешного `prepare` `commit` не должен иметь обычных отказов. `abort`
полностью возвращает reservation.

Тесты:

- duplicate page;
- unit, в котором все entry lists пусты;
- занятая поздняя страница;
- invalid slot;
- instantiate failure;
- повторный abort/commit;
- успешный multi-page replay;
- после каждого отказа `ctx.pages`, table и free-list совпадают с состоянием до
  попытки публикации.

### Этап 5. Обязательный integrity gate

Добавить единый target, включающий:

- `jit-alive-repro`;
- failed-compile recovery;
- memory OOB;
- `fpu-absolute`;
- AOT transaction/rollback;
- AOT differential oracle;
- JIT export validation;
- Rust `#[test]` harness compile (`wasm32-unknown-unknown`, `--no-run`) plus executable exported-WASM contracts;
- TypeScript gate.

Базовые команды:

```text
bun run gate
node vendor/v86/tests/jit-alive-repro.mjs
node vendor/v86/tests/fpu-absolute.mjs
(cd vendor/v86 && RUSTFLAGS="-C link-arg=build/zstddeclib.o" \
  cargo test --target wasm32-unknown-unknown --lib --no-run)
```

`v86` is a wasm-only `cdylib`; this target has no configured Cargo test runner, so the gate does
not claim that Rust `#[test]` functions execute. Cargo can link the test harness only when given
the disposable `build/zstddeclib.o` that `build-wasm.sh` normally supplies; trying to run that
wasm test binary on the host fails before execution. The gate compiles the `cfg(test)` harness
with the strongest runner-free command above, and executes the raw/bulk memory boundary contract
against the freshly built disposable WASM artifact instead.

Новые recovery/OOB/AOT тесты должны быть частью этого target, а не ручными repro.

После этапа 5 получается самостоятельный releasable milestone.

### Статус решения (2026-08)

Этапы 1–5 реализованы и проверяются воспроизводимым integrity gate. Region MVP
**DEFERRED**, не реализован: нет воспроизводимого корпуса реальных сцен с выигрышем
выше `max(3 %, 2×noise)`. Синтетические benchmark'и — только sanity-check и не
являются основанием для решения. `x87Locals` остаётся default-off до такого же
многосценового FP-подтверждения.

### Этап 6. Измерительный gate

Повторить baseline-корпус после стабилизации и принять решения:

- `x87Locals` остаётся default-off, пока несколько FP-нагрузок не покажут выигрыш
  выше шума;
- default-on оптимизации без устойчивой пользы отключаются;
- отдельно измеряется стоимость transitions, проверок, materialization состояния и
  helper/dispatcher calls в горячих циклах.

Только если профиль показывает существенную устранимую стоимость, переходить к
region MVP.

### Этап 7. Новая hotness policy

Сначала добавить observational mode без изменения compilation policy:

- sliding windows;
- decay;
- `exec_count × instruction_count`;
- top-K replacement;
- code generation/content hash;
- state flags;
- отдельная boundary-pressure метрика;
- старение или сброс при смене сцены и версии кода.

Сравнить ranking с текущими `tier2_pages`. Затем под отдельным флагом добавить
вытеснение устаревших страниц и запретить смешивание статистики разных версий кода.

### Этап 8. Минимальный region MVP

До реализации требуется отдельный RFC с форматом side exit и точной моделью
fault semantics.

Первый MVP:

- один горячий loop;
- максимум один backedge;
- только direct edges;
- 128–256 guest instructions;
- GPR и только живые flags в WASM locals;
- page-generation guards;
- interrupt/budget check на backedge;
- canonical side exit;
- feature flag, default-off;
- без x87/MMX/SSE, HLE, callbacks и сложных indirects;
- без persistence.

Правила correctness:

- Guard проверяется до необратимого изменения состояния.
- Side exit восстанавливает EIP, GPR, flags и instruction counter.
- SMC немедленно инвалидирует region.
- Baseline JIT остаётся единственным fallback.

Performance gate:

- выигрыш выше `max(3%, 2 × noise floor)` по worker CPU;
- отсутствие существенной p95-регрессии;
- снижение module entries/helper calls;
- compile cost окупается в пределах измерительного окна;
- ноль расхождений correctness oracle.

Если gate не пройден, MVP остаётся исследовательским флагом; PIC, HLE и
persistence не начинаются.

### Этап 9. Расширения

Только после успешного region MVP, по одному изменению и с отдельным A/B gate:

1. Per-site PIC на 2 цели, затем при необходимости до 4.
2. Versioned region profiles.
3. Ограниченный HLE allowlist для pure/non-reentrant leaf-функций.
4. Persistent optimized regions.
5. Relocatable table placement.
6. `ModuleHandle { slot, generation }` — только при доказанной необходимости для
   persistence или при неустранимых slot-lifetime проблемах.

## 3. Стабильные интерфейсы

Во время integrity-этапов сохраняются:

- baseline interpreter/JIT fallback;
- guest-visible fault semantics;
- `WASM_TABLE_OFFSET` и текущий dispatch contract;
- текущий формат AOT до явного повышения `AOT_ABI`;
- возможность отключить экспериментальные оптимизации;
- работа уже опубликованных JIT-модулей после запрета новых компиляций.

Любое изменение AOT descriptor или fingerprint повышает `AOT_ABI` и безопасно
инвалидирует старый cache без миграции.

## 4. Ограничения и условия остановки

- Не добавлять numbered JIT flags до ABI handshake.
- Не совмещать memory safety, lifecycle и region codegen в одном PR.
- Не включать region JIT по умолчанию по синтетическому benchmark.
- Любое correctness-расхождение блокирует оптимизацию независимо от ускорения.
- Неудачный side-exit/deopt профиль — повод остановиться и измерить заново, а не
  добавлять новые глобальные кеши.
- `ModuleHandle` не делать до доказанной потребности в relocatable persistence.
- Direct HLE не допускает callback/reentrancy до появления формального ABI/effect
  descriptor.

## 5. Критерии приёмки

### Integrity milestone

- OOB никогда не разыменовывается.
- Failed WASM не клинит JIT.
- ABI drift обнаруживается сразу.
- AOT publication атомарна.
- Fingerprint отражает фактическое состояние codegen.
- Обязательный regression target проходит.
- Нет существенной p95-регрессии относительно baseline.

### Region milestone

- Несколько реальных сцен показывают выигрыш выше шума.
- Снижаются worker CPU и число transitions.
- Compile/deopt cost контролируем.
- Correctness oracle не находит расхождений.
- Отключение флага полностью возвращает baseline path.
