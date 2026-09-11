# idx21 contracts: fixed-work и Chrome

Продолжение `v86-flag-helper-contract-2026-09-05.md`. Production idx21 остаётся 0. Предыдущий goal turn дал прогресс: отдельный корректный кандидат и BYTEmark A/B/C, показавший остаточную потерю LU. Здесь проверяется польза на фиксированном объёме работы; общий значительный прирост v86 ещё не доказан.

## Протокол и оракулы

Те же snapshot Wasm: A=shipping `c361f247…`, idx21=0; B=тот же Wasm, idx21=1; C=contracts `9d206ff3…`, idx21=1. SHIPPING_JIT и relaxed=1, idx10=0. Все input/config/Wasm checks исполняются до замера. Node v22.14.0; Chrome 153 headless, отдельный профиль, обычный V8 без performance overrides. Профиль закрыт после серии.

Три новых workload в общем для Node/браузера `x87-workload.mjs`:

- `flags-integer`: четыре MOV/ADD/ADC на итерацию. ADD выставляет CF, ADC накапливает 4×N в EDI.
- `flags-mixed`: FSQRT(1) между ADD и ADC; после ADC — FADD в отдельный накопитель ST1. Ожидаются независимо EDI=4×N и FP-сумма 4×N.
- `flags-fp`: четыре FSQRT(1)/FADD на итерацию; FP-сумма 4×N, EDI=0.

В каждом образе один цикл, 5 млн итераций на измерение. Проверяются абсолютные FP/integer результаты, SW, нулевой остаток ECX, ESI=N. Retired oracle: setup=6, end=7; body соответственно 15/23/11. Ожидаемые retired: **75000013 / 115000013 / 55000013**. Проверяется отсутствие новой JIT-компиляции в окне и число входов в JIT в пределах loop-budget envelope. Для FP-ядер проверяется импорт FSQRT-хелпера `instr16_D9_7_reg`. Это не только сравнение двух одинаково ошибочных checksum.

Кандидат дополнительно прошёл интерпретатор при N=120000. Старый pair smoke после расширения общего workload проходит. После 120000 async warmup — три прогрева по 1 млн, затем семь samples. Каждая рука — свежий emulator. Две self-пары для каждой A/B/C, затем четыре AC и четыре BC в прямом/обратном порядке. Итого 28 запусков. В Node порядок по рукам, в Chrome — по ядрам, сохраняя соседство пар. Raw серии не объединяются.

Пороги до запуска: каждая self-пара ≤3% по абсолютной разнице, разброс arm medians (max−min)/median ≤10%. Ни одного результата не выброшено.

## Node

Raw: `tools/bench-v86/results/flag-fixed-eRZK7l`, manifest и summary.json. Значения ниже — парная медиана **изменения времени**, отрицательное значит быстрее.

| Ядро | C/A | C/B | Noise gate |
|---|---:|---:|---|
| integer | −15.38% | +4.49% | PASS |
| mixed | −22.29% | −14.10% | PASS |
| FP helpers | −1.70% | −17.50% | FAIL |

Для mixed все C/A пары −21.45…−23.77%, разброс A/B/C 2.15/2.53/2.11%, self-пары ≤1.87%. Integer все C/A пары −13.54…−17.04%. Кандидат при этом медленнее B на integer в каждой паре (+3.14…+4.96%): whitelist не дал бесплатного улучшения всех ядер, этот результат не скрыт и причина не атрибутирована. FP-якорь не проходит из-за B/B +6.01%, поэтому общий noise gate серии не зелёный.

## Chrome

Raw: `tools/bench-v86/results/flag-browser-Jc3r1S/result.json` и `result.judgement.json`. Проверены одинаковые guest image hashes во всех руках.

| Ядро | C/A | C/B | Noise gate |
|---|---:|---:|---|
| integer | −17.40% | +0.99% | FAIL |
| mixed | −20.77% | −12.27% | FAIL |
| FP helpers | −0.70% | −15.76% | FAIL |

Mixed C/A быстрее во всех четырёх парах (−19.07…−27.15%), но self-пары C/C расходятся на −14.49% и +13.72%, arm spread A/B/C 12.83/22.21/16.60%. Integer содержит A=36.2 ms при обычных ~24.5 ms, spread A=47.77%. FP содержит C/C +10.40%. **Общий гейт FAIL**, данные описательные, не browser acceptance.

Посмотрены все samples подозрительных запусков: замедление иногда держится всю семёрку, иногда исчезает к концу, иногда чередуется. Это не доказательство одной причины вроде недостаточного первого прогрева. Порог не ослаблялся, прогоны не повторялись до случайного PASS.

## Решение

Node fixed-work подтверждает пользу на смешанном коде с переносом через FP-хелпер, а браузер показывает согласованное направление. Однако широкая полезность и отсутствие FP-регрессий ещё не установлены. idx21 остаётся экспериментальным. Для следующего изменения собирается отдельный census фактических JIT→helper calls на LU. Его JS-обёртки меняют стоимость: runner сохраняет счётчики, но маркирует scores INVALID и завершает такой прогон кодом 4, чтобы их нельзя было принять за perf evidence.

## LU census: дальнейшее изменение

Диагностический прогон завершён: `tools/bench-v86/results/flag-contract-lu-census.json`. В окне, включающем запуск команды и LU, зарегистрированы **444845018 вызовов `instr_0F16` и 224028544 вызова `instr_660F59`**. `fpu_fadd` — 1285, группа D9/7 — 2. Это число реальных переходов JIT→helper, не оценка по статическому Wasm. Интерпретаторные вызовы и вложенные Rust→Rust вызовы сюда не входят. Частоты получены под инструментированием, поэтому не задают доли времени исходного запуска. Полученный throughput 51.33 намеренно INVALID и не сравнивается с baseline.

Таким образом, доминирующие helper calls этого LU — SSE, а не x87. Оставшуюся потерю нельзя без атрибуции объяснять x87-проверкой пустоты. Прочитаны `instructions_0f.rs:683/1848`, `cpu.rs:4489/4502/4536`, `jit_instructions.rs:163/178/201`: чистые `instr_0F16` и `instr_660F59` получают уже прочитанный operand (для reg128 копию в scratch), меняют XMM и dirty marker; EFLAGS/доставка исключений отсутствуют. Memory-safe read остаётся до вызова, memory wrappers не whitelist-ятся.

Подготовлен отдельный кандидат `prepare-flag-contract.mjs --sse`: прежние 17 имён плюс эти два. Snapshot `C:/Users/jenis/AppData/Local/Temp/v86-flag-contract-lv7qYA/manifest.json`, Wasm **`ab10ee47cf5d6d9f094758acce5348958924ac98a073dc16acc8e5a8720f8987`**, wasm_builder source `574b0268088bde14c84a56443bd8357b39da212ca5ad77d9116b5c3ae1e8b2ef`.

Новый `vendor/v86/tests/sse-flag-contract-diff.mjs`: **18 PASS** — MOVLHPS/MOVHPS и MULPD, регистр/память/alias, interpreter/idx21 OFF/ON, dirty EFLAGS и абсолютные обе XMM lanes, N=100000 и импорт фактически исполняемого JIT-хелпера. Прежний helper/flags regression: **68 PASS**. Производительность SSE-кандидата пока не измерена; следующим нужен обычный, не инструментированный LU с shipping и прежним кандидатом в сбалансированном порядке.

Runtime JS SHA256: `ca139f8e8134832f2a153f0eaed880c54f628ed0cd248613bf959d8042a44938`; SHIPPING_JIT source: `4b133750209f5ae22e0f6010c9c1f195f933d87d8603afdf3a719ede32852703`. Shipping Wasm по завершении не изменился: `c361f2470422fd83814a293a6f946598c2cfa67707e6f5dd357a6e6306a19b84`.

Команды:

```text
node tools/bench-v86/run-flag-fixed.mjs <snapshot-manifest>
bun tools/bench-v86/run-x87-browser.ts <snapshot-manifest> --flags
node tools/bench-v86/judge-flag-browser.mjs <result.json>
```
