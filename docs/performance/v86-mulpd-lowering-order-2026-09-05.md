# MULPD: операция и порядок операндов в собранном хелпере

Продолжение `v86-mulpd-inline-experiment-2026-09-05.md`. Итог: скалярный MULPD с порядком destination × source интегрирован поверх MOV-inline. Рабочий Wasm `3a50af…`; SIMD и guarded-варианты не включены. Ниже сохранены этапы эксперимента и границы доказательств.

## Наблюдение по артефакту

В рабочем Wasm export `instr_660F59` имеет function index 2605 (22 импортированные функции). Извлечённое тело содержит `v128.load` destination, сохранение в local v128, затем `local.get` destination и `v128.load` source, `fd f2 01`, `v128.store`. Это **destination × source через f64x2.mul**, хотя Rust-текст записан `source * destination` по отдельным полосам. Кодировка подтверждается [таблицей WebAssembly SIMD](https://github.com/WebAssembly/simd/blob/main/proposals/simd/BinarySIMD.md). Воспроизводимое извлечение: `node tools/bench-v86/extract-wasm-function.mjs public/v86.wasm instr_660F59`.

Следовательно, прежний unguarded-кандидат менял одновременно две вещи: SIMD на scalar и порядок операндов. По его NaN-отличию нельзя заключить, что безусловный инлайнинг невозможен; нужно разделить эти изменения.

## SIMD-кандидат

`prepare-sse-move.mjs --mulpd-simd`, snapshot `C:/Users/jenis/AppData/Local/Temp/v86-mulpd-YlF99n/manifest.json`.

- A: `9be80a992f4b137546a0b248f600cdc4ef395a426322b3baca33fe3511569d6b`.
- C: `82c762b7a0a04430fdcf5388ef429e8c1d077d70015a3e45092bb4e768d91aa4`.
- Патч: `mulpd-inline-simd.patch`. Полное 128-битное чтение памяти до записи XMM, оба SIMD-операнда загружены до store; одна f64x2.mul в наблюдаемом порядке helper. Никакого guard или fallback.
- Cross-artifact Node suite: обе руки 66 contracts + 32 fault/restart PASS; точные NaN сравнения включены, импорт MULPD у C запрещён. Raw: `C:/Users/jenis/AppData/Local/Temp/mulpd-contract-eaRemI`.

Для проверки в другой версии V8 тот же контракт вынесен в `sse-flag-contract-core.mjs`; Node entrypoint сохраняет прежние env/CLI. Новый `run-x87-browser.ts <manifest> --mulpd-contract` запускает этот общий suite в Worker, сравнивая baseline и candidate, и сохраняет 27 NaN-наблюдений каждой руки. Это correctness-only, не benchmark.

LU+FOURIER ABBA: `tools/bench-v86/results/mulpd-simd-bytemark-P7Opt9`. До завершения серии итог не принят.

Серия завершилась: A 6169.4/253.80, C 5747.9/238.06, C 6037.8/253.96, A 5999.1/240.87 (FOURIER/LU). LU-пары −6.20% и +5.44%; FOURIER −6.83% и +0.65%. Значительного воспроизводимого выигрыша SIMD-кандидата эта серия не доказывает; в shipping он не включён. Clock ratios 0.9968–1.0005, config readback штатный, tier2 promotions=0.

После выделения общего test core Node suite повторён: `C:/Users/jenis/AppData/Local/Temp/mulpd-contract-XeIBEC`, обе руки 66+32 PASS. Chrome 153 Worker suite: `tools/bench-v86/results/x87-browser-2OFKTN/result.json`, обе руки 66 contracts, точные baseline/candidate NaN-биты совпали. Browser fault suite в этот запуск не входит; 32 fault/restart выше проверены в Node. Correctness-only результаты явно запрещены в perf judge.

## Следующая независимая гипотеза

Подготовлен `mulpd-inline-scalar-order.patch`: прежний scalar lowering, но destination × source, без проверок non-finite. `prepare-sse-move.mjs --mulpd-scalar-order` изолирует его от SIMD и guarded-вариантов. Простой обмен порядка не считается доказанным исправлением: обязательны точные baseline/candidate NaN-проверки в Node и Chrome, fault/restart и замер именно этой сборки.

## Скалярный вариант: результат

Snapshot `C:/Users/jenis/AppData/Local/Temp/v86-mulpd-mZWHfr/manifest.json`, candidate SHA256 `3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a`, baseline `9be80a…`.

LU+FOURIER ABBA, `mulpd-scalar-order-bytemark-skODep`:

| Порядок | Рука | FOURIER | LU |
|---:|---|---:|---:|
| 0 | A | 5904.4 | 238.27 |
| 1 | C | 6046.0 | 279.79 |
| 2 | C | 6246.5 | 279.96 |
| 3 | A | 5914.4 | 237.41 |

LU-пары **+17.43% / +17.92%**; FOURIER +2.40% / +5.62%. Clock ratios 0.9995–0.9998, flags readback проверен, tier2 promotions=0. Это две пары, не оценка универсального ускорения; контроль тоже различается. Проценты относятся к кандидатам поверх MOV-inline, не суммируются с прежними процентами MOV.

Node fixed-work `flag-fixed-g2ft6S`: integer +0.19% медиана C/A, но FAIL из-за одной C/C-пары −5.52%. SSE reg **−63.54% времени, PASS**, SSE mem **−57.00%, PASS** по прежним 3% self / 10% spread. Поэтому весь fixed-work набор не объявлен зелёным. Из ускорения этих циклов не выводится скорость целого приложения.

Node cross-artifact после выделения обоих test cores: `C:/Users/jenis/AppData/Local/Temp/mulpd-contract-h5z0Fb`, обе руки 66 contracts + 32 faults PASS. Chrome 153 Worker: `x87-browser-LebcPU/result.json`, обе руки **66 contracts + 32 faults PASS**, 27 точных NaN-записей на руку. Последний browser run включает fault/restart, в отличие от ранних contract-only запусков. Обычный helper отсутствует в JIT-модулях кандидата; исходный unguarded с неправильным порядком остаётся отрицательным регрессионным примером. Браузерные проверки корректности не считаются измерением скорости.

## Интеграция и проверки

Применён только `mulpd-inline-scalar-order.patch` к рабочему `jit_instructions.rs`. Пересборка обеих рук после интеграции (`v86-mulpd-Zc1uep/manifest.json`) побайтно воспроизвела baseline `9be80a…` и измеренный C `3a50af…`. `prepare-sse-move.mjs` поддерживает воспроизведение этого сравнения после интеграции через обратное применение патча только к временной baseline-копии.

`vendor/v86/build/v86.wasm`, `public/v86.wasm`, `dist/v86.wasm` имеют одинаковый полный SHA256 `3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a`. idx21 остаётся 0. Изменения других агентов сохранены.

- `bun run test:sse-move`: 66 contracts + 32 MOV faults + 32 MULPD faults PASS. Лог `C:/Users/jenis/AppData/Local/Temp/mulpd-scalar-sse-tests.log`.
- `bun run gate`: **4181 PASS, 0 FAIL**, 351 files, 9 snapshots, все статические проверки и обязательный WGSL validator. Лог `…/Temp/mulpd-scalar-integration-gate.log`.
- `census-selftest`, `perm-map-differential`: OK; dead flags 12/12; relaxed x87 all variants match. Лог `…/Temp/mulpd-scalar-runtime-checks.log`.
- `aot:opt:gate`: успешно, **73 Rust tests PASS**. Лог `…/Temp/mulpd-scalar-aot-gate.log`.
- Whitespace checks затронутых tracked-файлов прошли.

Отдельная общая browser perf-приёмка по-прежнему не доказана: прежние шумные серии не переименованы в успешные. Интеграция опирается на локальную корректность, точные наблюдаемые NaN-биты в двух V8, fault/restart, измеренный LU-эффект и прошедшие проверки SSE-ядер; она не устанавливает общий процент ускорения всех нагрузок.
