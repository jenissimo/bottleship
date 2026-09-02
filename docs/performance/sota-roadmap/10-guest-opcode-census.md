# 10. Guest opcode census самого Far Cry

## Видение

Кампания FC Rebench оптимизировала x87 на прокси-демке (52% x87 по её census), а живой
Far Cry упёрся в другое место. Прокси не был валидирован как репрезентативный до
кампании. Пункты 02, 03, 05 выбирают цель по доле классов инструкций, и без census самой
игры это снова будет угадывание.

Census должен считать retired-инструкции по классам за окно на живой игре:

- x87 (с разбивкой load/store/arith/compare/control-word);
- SSE/SSE2 (по семейству: mov, arith, shuffle, cvt);
- memory ops с классификацией операнда: ESP/EBP-based с константой, base+index,
  absolute, string ops;
- branches: direct/indirect/ret/call, cross-page или нет;
- ALU без памяти.

Chrome trace даёт sampled host-attribution, но не retired guest-opcode census. Это
разные величины; нужны обе колонки рядом.

## Как снять

Профилерная сборка v86 с opcode-census (есть в `profiler`-feature, shipping stub
возвращает нулевой буфер). Требования, вытекающие из postmortem:

1. Provenance обязательна: хеш `v86.wasm`, feature manifest, nonzero self-test в
   выводе. Нулевой буфер это ошибка, а не «нет данных».
2. Harness-глагол `opcodeCensus({window})`: старт/стоп, таблица по классам, число
   retired, сравнение с `frameReport` того же окна.
3. Один прогон на Pier, один на другой сцене (open terrain, interior), чтобы понять
   разброс между сценами до выбора цели.
4. Тот же census на `demo_fc_rebench` тем же инструментом, чтобы таблица «прокси против
   игры» из postmortem получила вторую колонку.

Census замедляет guest; он годится для долей, не для FPS того же окна.

## Синтетические тесты

- **Census self-test**: демка с известным числом инструкций каждого класса
  (`demo_census_probe`: 1000 x87, 1000 SSE, 1000 стековых, 1000 indirect); census обязан
  выдать эти числа с точностью до прологов. Тест обязан падать, если census
  недосчитывает класс.
- **Operand classification**: юнит-тест классификатора на таблице инструкций с
  ожидаемым классом (bun test поверх Rust через wasm-экспорт или на TS-зеркале
  декодера с `decoder-oracle.mjs`).
- **Provenance**: тест, который запускает census на shipping-сборке и ожидает явный
  отказ, а не нули.

## Критерий успеха

Таблица классов для Far Cry на двух сценах с provenance, рядом с колонкой прокси-демки,
и решение по пунктам 02/03/05, принятое по этой таблице.
