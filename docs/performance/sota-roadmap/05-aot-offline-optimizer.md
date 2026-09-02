# 05. AOT: профильная компиляция с оптимизатором, офлайн и онлайн

## Видение

Модель ART/Rosetta: корпус фиксирован (PE плюс DLL), код транслируется заранее с проходами,
которые JIT не может себе позволить по времени, JIT остаётся fallback-ом. Разница с «JIT
заранее» в оптимизаторе: время компиляции не на критическом пути, CFG известен целиком,
indirect-targets и горячие пути берутся из профиля, регионы выбираются по нему же.

Что уже есть (`plan/aot-compiler-design.md`, `tools/aot/`):

- Компилятор product B на чистом JS: свой декодер, CFG, emitter (`lib/decode.mjs`,
  `lib/cfg.mjs`, `lib/emit.mjs`), verifier. Никакого Binaryen и LLVM в пайплайне.
- Delivery channel: `aot-cache.ts` регистрирует единицы через staged transaction между
  входами модулей, content-binding по SHA страницы (единица не регистрируется, если байты
  страницы отличаются от захваченных), инвалидация по SMC, bounded exit.
- Integer-core slice: 92.6% инструкций на горячих страницах NFSU. Нет x87, SSE, string
  ops, div. Far Cry живёт на x87/SSE, поэтому для него покрытие мало: out-of-slice
  инструкция закрывает единицу.

Что говорит design §7 и чему этот файл обязан подчиняться:

- Оптимизатор общего назначения не помогает. LLVM-единица на той же memory-convention дала
  0.72–0.82 от production JIT; Binaryen не знает alias-фактов (CPU-state против guest RAM),
  и передавать их ему нельзя, потому что это лицензирует незаконный hoist store-guard-а.
  Оптимизатор здесь это свои проходы P1–P6 над байтами с annotation side-channel-ом.
- Дефицит в memory-convention ABI и обязательствах контракта (загрузка/сброс GPR, счётчик,
  flag tuple), а не в компиляторе. Честный диапазон для integer-единицы: 0.8–1.0× сейчас,
  1.3–1.6× с L1 (fastmem read shape), 1.5–2.0× с L1+L2 (flag-tuple в locals), выше только
  через N (region formation, L3).
- Множитель это функция N (инструкций между входом и выходом единицы); ни одно число без
  своего N не имеет смысла.

Пересчёт для Far Cry: guest-доля busy 50%, значит X=2 на единицах даёт +33% end-to-end,
X=3 даёт +50%. Это не 2–3× кадра. Это единственный рычаг, который масштабируется на
плоский профиль, но его размер задан контрактом, а не оптимизатором.

## Критический путь

1. **Slice x87**: тот же relaxed-f64 контракт, что у JIT, с теми же FAULT-ветками
   (memory `v86-relaxed-fpu-two-implementations`); precision control в fingerprint.
2. **Slice SSE**: XMM как v128 locals, MXCSR-семантика округления.
3. **Levers до проходов (Gate 1.5)**: L1, L2, L3 измеряются на стенде против A0-единиц
   раньше, чем пишется хоть один проход. Это уже предписано design §7.5.
4. **Проходы B**: P1 region formation (поднимает N), P2 whole-unit flag liveness, P3 CSE
   адресов и hoist read-guard, P4 counter folding, P5 per-unit cache lifetimes. P6 fusion
   за Gate 2. Каждый отдельно включаем и отдельно gated.
5. **Region selector**: пункт 06, офлайн по объединённому `hotblocks` нескольких сессий.

Пункт «x87 stack-value forwarding» из postmortem это P5 для `fpu_st`, не отдельный
emitter-хак.

## Онлайн-режим: компиляция в браузере перед запуском или в фоне

Реально, и текущая форма компилятора для этого уже подходит: он JS, без нативных
зависимостей; Node-специфика ограничена `node:fs`/`node:crypto` в capture/aotc-хостах и
заменяется на OPFS и `crypto.subtle`. Схема ART (JIT первым, профиль, AOT в фоне, кэш):

1. **Сессия 1**: обычный JIT. Собирается профиль: горячие страницы по retired
   (`jit_tier2_note_retired`), published entries и state flags (диспетчер их уже
   публикует), наблюдённые indirect-targets (из chaining memo), SMC-dirtied страницы.
   Профиль и SHA страниц персистятся в container dir (OPFS), рядом с `aot-cache`.
2. **Compile-worker**: отдельный Web Worker с тем же `lib/{decode,cfg,emit,verify}.mjs`.
   Вход: байты страниц (финальные, после relocation и IAT patch, значит снимаются с живого
   guest-а после загрузки образа) и профиль. Выход: единицы с relocation table и
   manifest (codegen revision, jit config ABI, engine SHA). Verifier refusing, как офлайн.
3. **Публикация**: `aot-cache` регистрирует через staged transaction между входами
   модулей; content-binding по SHA страницы сам отсеивает устаревшие единицы. Это
   работает и в фоне во время игры, и как шаг «перед запуском» с прогресс-баром.
4. **Кэш**: единицы сохраняются в OPFS, ключ бандл SHA плюс codegen revision плюс
   engine SHA. Следующий запуск регистрирует их до первого входа в горячий код.

Что отличает онлайн от офлайн:

- Нет RE-данных из Ghidra. Indirect-targets только из профиля; guard chain на
  неизвестный target уходит в диспетчер. Для C++ с vtables это означает, что первая
  сессия должна быть достаточно длинной, иначе N в единицах будет мал.
- Время компиляции ограничено: единицы только для страниц, дающих, скажем, 90% retired
  (по трейсу Far Cry это порядка сотни страниц, не тысячи). Compile-worker не блокирует
  CPU-worker; шаг «перед запуском» это тот же worker с ожиданием.
- Второй экземпляр движка для environment reconstruction (S1) не нужен: product B не
  зависит от aot-driver-сборки, декодер и emitter свои. Это и делает браузерный режим
  дешёвым.
- Verifier обязан работать в браузере в полном объёме; онлайн-единица без verifier-а
  это единица без контракта.

Офлайн-режим при этом остаётся: те же модули под Node с Ghidra-обогащением
indirect-targets и объединённым профилем нескольких машин; результат кладётся в бандл
(`make-wgb`) как pre-warmed cache с тем же content-binding. Две точки входа, один код.

## Как снять

- Покрытие: `slice-census.mjs` и `decoder-oracle.mjs` на страницах Far Cry из `hotblocks`.
  Число до и после каждого расширения slice.
- Correctness: `tools/aot-oracle` self-test плюс differential против JIT на той же трассе;
  `fpu-absolute` для x87; K5 totality validator.
- N: гистограмма retired между входом и выходом единицы на Far Cry (Gate 0b). Без неё
  ни один множитель не заявляется.
- Perf: CPU-арм демки OFF/ON, затем Far Cry `frameReport` с `aot.alive` и долей retired
  внутри AOT (`jit_tier2_note_aot_retired`). Доля ниже 50% означает, что измерять рано.
- Онлайн-режим отдельно: время компиляции в worker-е, размер кэша, доля единиц, отвергнутых
  content-binding-ом при следующем запуске (высокая доля означает, что страницы
  патчатся после снимка).

## Синтетические тесты

Correctness:

- **Differential per slice**: для каждой добавленной инструкции набор входов с граничными
  значениями (NaN, denormal, переполнение, precision control 24/53/64); сравнение
  регистров/флагов/x87-стека/памяти с интерпретатором v86. Расширение существующего
  oracle.
- **Exit-shape parity**: единица, где середина региона даёт #DE/#PF/OUT; состояние и
  retired count совпадают с JIT-путём.
- **Displacement**: guest пишет в код под AOT-единицей; единица уходит, диспетчер входит
  в JIT.
- **Онлайн round-trip**: сессия 1 в harness собирает профиль, compile-worker компилирует,
  сессия 2 регистрирует из кэша; checksum демки совпадает, `aot.alive` true, доля retired
  в AOT выше порога. Отдельно: подменить байты одной страницы между сессиями и убедиться,
  что именно эта единица отвергнута, остальные приняты.
- **Self-check**: намеренно неверный emitter одной инструкции; differential обязан
  назвать её. Намеренно сломанный manifest (чужой engine SHA); кэш обязан отказать.

Perf fixture: `demo_fc_rebench` CPU-арм (x87-heavy), `demo_x87_chain` (длинные x87-цепочки
без memory fences, максимум для P5), `demo_sse_mix`, и `demo_vcall_dense` из пункта 07
для проверки, что профильные indirect-targets реально поднимают N.

## Критерий успеха

На Far Cry доля retired в AOT выше 70%, N медианный выше 100, медиана кадра ниже OFF-arm
за пределами noise floor, все differential-тесты зелёные. Онлайн-режим: компиляция
горячего набора укладывается в фон одной сессии, кэш принимается на следующем запуске
без единого отказа content-binding-а на непатченных страницах.
