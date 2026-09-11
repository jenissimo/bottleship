# Inline MOVHPS/MOVLHPS: корректность и измерения

Продолжение `v86-sse-contract-and-move-2026-09-05.md`. Кандидат `9be80a99…`, baseline `c361f247…`, полные хеши и snapshot в предыдущем отчёте. Обе руки SHIPPING_JIT, **idx21=0**. Production Rust/Wasm не заменены. Предыдущий goal turn дал прогресс: измерил SSE contracts и создал отдельный кандидат инлайнинга; этот turn проверяет отказ и производительность.

## Fault/restart

Новый `vendor/v86/tests/sse-move-pagefault.mjs`: **32 PASS**. MOVHPS и MOVHPD, offsets 0..7 перед границей отсутствующей страницы, interpreter/JIT. После 60000 горячих итераций операнд указывает на отсутствующую страницу; handler проверяет состояние до replay и отображает страницу, затем IRET повторяет инструкцию.

Абсолютные проверки: один #PF, CR2, error code=0, EIP ровно MOV, живые EAX/EBX, сохранённые arithmetic EFLAGS, XMM до replay без частичной записи, XMM после replay с новым high half и прежним low half, завершённый цикл. Обёртка `trigger_fault_end_jit` в JIT-режиме подтверждает ровно одну доставку из скомпилированного кода с нужным EIP; в interpreter — ноль. Наличие модулей само по себе не считается доказательством JIT-fault. Полный повтор с этой дополнительной проверкой проходит.

Чувствительность: `prepare-sse-move.mjs --mutate-before-read` намеренно обнуляет high half до safe read. Mutation Wasm `4a12126bf7503b0648d9b7234c8f54ffff37121a15fe9e604165ce89e12b840a`, snapshot `C:/Users/jenis/AppData/Local/Temp/v86-sse-move-5E2TsW`. **FAIL** на первом JIT-case: handler увидел high half [0,0] вместо [0x33445566,0x778899aa], хотя окончательный XMM после replay правильный. Следовательно, тест ловит потерю атомарности, которую сравнение одного финального результата пропустило бы. Mutation запрещена в perf runners.

Также сохраняются **27 PASS** обычной SSE/flags матрицы из предыдущего turn. Проверено сохранение dirty marker: прежний `gen_mark_fpu_simd_dirty_once` остался, и его состояние сбрасывается при генерации нового basic block. Пропущен только вызов копирующего хелпера.

## BYTEmark LU, обычный Node

Raw: `tools/bench-v86/results/sse-move-bytemark-WUeKRV`. Без census/wrappers. Fresh fs boot, три пары AB/BA/AB, ни один результат не отброшен.

| Пара | Baseline | Candidate | Throughput delta |
|---:|---:|---:|---:|
| 1 | 198.92 | 237.05 | +19.17% |
| 2 (BA) | 193.75 | 248.65 | +28.34% |
| 3 | 190.12 | 238.22 | +25.30% |

Парная медиана **+25.30%**. Readback конфигурации проходит, tier2 promotions=0, clock ratio 0.9960–1.0000. N=3, без отдельного A/A этого guest-timed окна; точный общий uplift не следует из одного LU.

## Fixed work: Node

Raw: `tools/bench-v86/results/flag-fixed-pHOFJZ`. Две A/A и две C/C пары, четыре AC/CA; семь samples по 5 млн итераций на руку, три ядра. Результаты, retired=23N+16, actual JIT entries и отсутствие новой компиляции в samples проверяются общим workload. В inline-руке проверяется отсутствие импорта MOV и наличие MULPD.

| Ядро | Парная медиана изменения времени | Noise gate |
|---|---:|---|
| integer control | +0.05% | FAIL |
| SSE reg | −20.93% | FAIL |
| SSE mem | −14.15% | PASS |

Порог прежний: каждая self-пара ≤3%, arm spread ≤10%. Integer self-пара −3.14%; reg self −8.56% и −4.77%, baseline spread 10.25%. Mem все пары −12.32…−16.60%, self-пары ≤0.62%, spread A/C 2.69/2.34%.

Проверены хеши сгенерированных модулей в медленном и обычных baseline reg-запусках: совпадают. Поэтому различие скорости нельзя приписать разному Wasm, но причина различия не установлена.

## Chrome, обычное планирование

Raw: `tools/bench-v86/results/flag-browser-fjiKVn/result.json`, judgement рядом. Chrome 153, отдельный профиль, без V8 overrides. Та же корректность и порядок по ядрам с соседними парами.

| Ядро | Изменение времени | Noise gate |
|---|---:|---|
| integer control | +2.35% | FAIL |
| SSE reg | −16.11% | PASS |
| SSE mem | −14.22% | PASS |

SSE reg все AC пары −15.80…−16.82%, self ≤2.62%, spread A/C 8.54/9.63%. Mem все AC пары −11.47…−15.27%, self ≤2.08%, spread 2.62/4.21%. Общий гейт **FAIL** из-за integer: одна пара +43.32%, spread C=45.31%. Последовательности хешей integer-модулей побайтно одинаковы во всех руках; отличие не внесено в guest code.

## Проверка гипотезы планировщика

Host: AMD Ryzen 9 7900X3D, 12 cores/24 logical processors. Отдельная серия закрепила только новую PowerShell→Bun→Chrome семью за logical CPU 0 (mask 1). Пользовательские процессы не менялись. Это проверка гипотезы, не установленная причина шума. Порог 3%/10% и порядок не менялись, прежняя серия сохранена.

Raw: `tools/bench-v86/results/flag-browser-GOBEOz/result.json`. После тайминга и до завершения Chrome сохранён readback ProcessAffinity: Bun и все девять живых Chrome processes имеют mask `1`.

| Ядро | Изменение времени | Noise gate |
|---|---:|---|
| integer control | −0.19% | FAIL |
| SSE reg | −16.16% | FAIL |
| SSE mem | −14.19% | PASS |

Integer spread C=10.79%, reg A/A −4.33%. Mem self ≤2.79%, spread 4.17/7.22%. Общий гейт снова **FAIL**. Affinity не устранила нестабильность; переносы между CPU нельзя считать доказанным объяснением. Профили закрыты после каждой серии; affinity задавалась только дочернему shell, который завершился.

## Вывод и оставшаяся работа

Есть значимый выигрыш на LU и согласованные, прошедшие свои проверки результаты SSE memory kernel в Node и обоих Chrome-протоколах. Это существенно сильнее одного synthetic result. Но общий browser gate не зелёный, более широкие контрольные workload ещё не проверены, production-интеграция не сделана. Цель общего значительного ускорения не объявляется достигнутой. Следующая работа должна проверить пригодность кандидата к интеграции и более широкие контроли; нельзя выдавать повторные попытки до случайного PASS за независимое доказательство.

## Подготовка интеграции

Патч применён к рабочему `vendor/v86/src/rust/jit_instructions.rs`: 11 добавленных/3 удалённых строки, те же три entry point, без изменения idx21. Добавлена команда `bun run test:sse-move`, запускающая 27 SSE/flags и 32 fault/restart случая с требованием inline MOV. Другие изменения агента сохранены; diff whitespace check проходит. **Рабочий build/v86.wasm и public/v86.wasm на этом шаге ещё не заменены.** Нужны сборка из рабочего дерева и проверки интеграции после окончания perf-серии.

Запущена расширенная серия `tools/bench-v86/results/sse-move-broad-bytemark-qTUrqw`: NUMERIC SORT, BITFIELD, FOURIER, LU; fresh fs boot, ABBA, idx21=0. Она использует прежние неизменяемые snapshot-артефакты и пока выполняется. Итоги и решение о готовом wasm будут записаны после её завершения; запущенная серия не считается подтверждением отсутствия регрессий.
