# SOTA roadmap: структурные рычаги перфа поверх v86

Дата: 2026-09-01 (статус обновляется в [STATUS.md](STATUS.md))
Статус: видение и протоколы измерения. Инструменты пунктов 10/07/08 и общие perf-фикстуры
реализованы; ни один РЫЧАГ не принят и не измерен на игре — см. STATUS.md.
Источник фактов: `logs/trace-10s.json.gz` (Far Cry, Pier, 19.9 FPS),
`docs/performance/far-cry-draw-loss-and-frame-tail-followup-2026-09-01.md`,
`vendor/v86/src/rust/{jit,codegen}.rs`.

## Отправная точка

Форк уже закрывает классический чек-лист dynarec-а: регистры в wasm-locals,
dead-flag liveness, dynamic chaining regions, ret-chaining с memo, tier2 по retired
instructions, tail calls для chaining, relaxed x87 на f64, SIMD в кодогене, AOT-единицы,
которые диспетчер исполняет. Предлагать эти вещи заново бессмысленно.

Медианный кадр Far Cry (47.6 ms):

| Bucket | ms | доля busy |
|---|---:|---:|
| guest JIT blocks | 22.1 | 50% |
| JS HLE + glue | 11.0 | 35% |
| idle worker | 5.5 | (вне busy) |
| v86 core + dispatch | 4.4 | 11% |
| interpreter fallback | 0.7 | 1.3% |

Guest-код размазан ровно: самый горячий блок даёт 2.4% busy. Точечные intrinsics не
масштабируются; остаются только общие рычаги.

## Пункты

| # | Файл | Рычаг | Ожидаемый потолок | Риск для кодогена |
|---|---|---|---|---|
| 01 | [render-worker](01-render-worker.md) | D3D9-исполнение и ADPCM с CPU-worker-а | 1.3–1.5× кадр | нет |
| 02 | [stack-page-fastmem](02-stack-page-fastmem.md) | стековые обращения без TLB | до 10–15% guest | средний |
| 03 | [permission-bitmap](03-permission-bitmap.md) | проверка прав вместо TLB-entry | 3–8% guest | средний |
| 04 | [multi-memory](04-multi-memory-aliasing.md) | CPU-state в отдельной wasm-памяти | 0–5% guest | низкий, пробa |
| 05 | [aot-offline-optimizer](05-aot-offline-optimizer.md) | профильный AOT, свои проходы P1–P6, x87/SSE slice, онлайн-режим | 1.5–2× на единицу (+33–50% кадра) | высокий, долгий |
| 06 | [profile-guided-regions](06-profile-guided-regions.md) | регионы по hotblocks, а не BFS | 5–10% guest | средний |
| 07 | [dispatch-tax](07-dispatch-tax.md) | измерить, где 5% диспатча | 2–4% | низкий |
| 08 | [io-idle](08-io-idle.md) | диагноз 5.5 ms idle, readahead | до 5 ms/кадр | нет |
| 09 | [js-glue](09-js-glue.md) | ADPCM через Proxy, квадратичный cacheWrite, per-draw JS | 11 → 5 ms | нет |
| 10 | [guest-opcode-census](10-guest-opcode-census.md) | census самого Far Cry, не прокси | предпосылка для 02/03/05 | нет |

## Порядок

1. Инструменты: 10, 07, 08 (по дню каждый, без изменений в горячих путях).
2. Без риска для dynarec: 09, затем 01.
3. Под census: 02, потом 03. Оба с OFF-arm и differential-тестом paging/#PF.
4. Долгий трек: 05 с расширением slice на x87/SSE; 06 как его же region selector.
5. Однодневные пробы: 04.

## Общий протокол измерения

Каждый файл ссылается сюда, а не повторяет.

- Fresh load на каждый arm, атомарный `resetWorkerFlags` перед каждым repetition.
- Один Chrome tab, один агент (`harness trace` сам это проверяет).
- Порядок arms чередуется: OFF/ON/OFF/ON или A/B/A. N не меньше 5 для медианы.
- Noise floor измеряется на том же режиме и окне (OFF/OFF), а не берётся из прошлой кампании.
- Все raw values, медиана, разброс, bundle SHA, `v86.wasm` SHA (три копии совпадают),
  git SHA коммита, Chrome/driver/power plan.
- Correctness oracles обязательны и независимы от ускоряемого пути: CPU checksum демки,
  ledgers draw/query/present, ноль dropped draws, ноль GPU validation failures, скриншот.
- OFF-arm должен воспроизводить pre-feature baseline. Регрессия OFF-arm инвалидирует A/B.
- Дельта внутри noise floor это направление, не результат.

## Синтетические тесты: общая форма

Две обязательные линии для каждого рычага:

- **Correctness differential** (bun test или `tools/aot-oracle`-стиль): один и тот же
  guest-код прогоняется с рычагом OFF и ON, сравниваются регистры, флаги, память, счётчик
  retired instructions, наличие/отсутствие #PF в тех же точках. Тест обязан уметь падать:
  в него вносится намеренная поломка, и он должен её увидеть.
- **Perf fixture**: C++-демка по образцу `C:\Projects\bottleship-demos\demo_fc_rebench`
  (фиксированная работа, детерминированный checksum, без sleep и frame limiter), собранная
  в `.wgb`, с runner-ом, который печатает FPS/ms-per-frame и все ledgers. Масштаб через
  `SCALE`, чтобы проверять модель `ms/frame = fixed + k × SCALE`.

Демки должны переехать в этот репозиторий, иначе сравнение между ветками и машинами
невозможно. Сделано: `tools/guestbench/` (`bun run guestbench list`) — эмиттер x86 на JS,
шесть фикстур под пункты 02/03/04/05/06/07, детерминированный checksum и SCALE у каждой, и
`bun run guestbench:verify`, который сверяет объявленный состав фикстуры с census-ом.
