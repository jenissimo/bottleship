# 09. JS glue: три конкретных находки из трейса Far Cry

Это не SOTA-архитектура, а измеренные дефекты в JS-слое. Они дешёвые, каждый измерим по
хвосту кадра, и их стоит закрыть до пункта 01, чтобы render-worker не переносил лишнюю
работу на второй поток.

## 9.1 ADPCM-декодер читает guest-память через Proxy

Факты: `get` из libv86.mjs 1.42% self, `decodeMsAdpcmBlock` 1.62%, в хвостовых кадрах
до 11 ms. `convertFromBlocks` (msacm32.ts) получает `mem` из аргумента thunk-а, то есть
v86-Proxy (memory `guest-memory-proxy-is-25x`), и декодер индексирует его по нибблу.
Дополнительно на каждый блок аллоцируются четыре массива `predictor/delta/samp1/samp2`.

Рычаг: plain-view один раз на вызов (`toPlainGuestMemory` или `subarray` на диапазон
блоков после `isValidAddress` на весь extent), предаллоцированные типизированные массивы
на канал, затем Tier-3 hypercall или перенос на audio-worker (пункт 01).

Как снять: `profilerStats({filter:'acmStreamConvert'})` до и после, avg и max на вызов;
`frameReport` p95/p99. Ожидание: p95 минус 5–10 ms, медиана минус 1–2 ms.

Синтетический тест: `tools/tests/msacm32-adpcm.test.ts` с эталонными блоками из
реальных WAV (MS ADPCM и IMA, моно/стерео, 11/22/44 kHz), побайтовое сравнение выхода
до и после; perf-часть измеряет ns/блок на 10k блоков и падает при регрессии выше 2×.

## 9.2 Квадратичный cacheWrite на append-only лог

Факты: Far Cry пишет Log.txt непрерывно (3392 WriteFile за прогон). `cacheWrite`
(vfs.ts:2371) при росте файла делает `new Uint8Array(end)` и полное копирование, то есть
O(n²) для append-only; 1% self в трейсе. Каждая запись ещё и форматируется в строку лога
на уровне NORMAL. Это единственный найденный механизм, который деградирует со временем
сессии, что совпадает с наблюдавшимися нелинейными просадками.

Рычаг: геометрический рост буфера (capacity отдельно от length), формат контента только
при включённом sink.

Как снять: FPS в той же сцене на 1-й и 10-й минуте до и после; `profilerStats`
по `WriteFile`. Если деградация исчезает, гипотеза о «нелинейных просадках» закрыта.

Синтетический тест: `tools/tests/vfs-append.test.ts`: 100k append-ов по 100 байт;
проверка содержимого и O(n) времени (10k против 100k отличаются не более чем в 12×).
Self-check: с линейным ростом тест обязан падать по времени.

## 9.3 Per-draw JS вне MegaRun — ОПРОВЕРГНУТО ИЗМЕРЕНИЕМ (2026-09-02)

> **Рычаг, названный ниже, померен на NFSU в заезде и оказался регрессией.**
> `dbg.d3dWasmPath(true)` — это и есть «хеш pipeline-key в арене» — даёт **+11.2% к кадру**
> (ABBA 4×4 окна: OFF медиана 64.75 мс, ON 72.0 мс, популяции не пересекаются), при
> **полном покрытии и нулевых расхождениях**: 7 344 864 команды, `ffpFallbackCount` 0,
> `mismatchCount` 0, `overflowCount` 0. То есть «расширить с одной грамматики на все draw-и»
> нечего — арена уже берёт все draw-и NFSU, — а включать нельзя.
> Условие P0 (rollback-fuzz) при этом выполнено независимо:
> `tools/tests/wbuf-megarun-rollback-fuzz.test.ts`, и оно нашло настоящую дыру в откате.
> Разбор: [nfsu-max-settings-ceiling-2026-09-02.md §4.5](../nfsu-max-settings-ceiling-2026-09-02.md).
> Ниже — исходная формулировка, сохранена как контекст.

### Исходная формулировка

Факты: d3d9-device.ts 4.84% self плюс executor, resources, com-refs, lru-cache, около
7–8% busy, 3.5 ms/кадр. MegaRun снимает только alternating pairs; остальное идёт через
`drawIndexedPrimitive` → `captureDrawState` → `resolveProgrammablePipeline` в JS.

Рычаг: захват draw-state и хеш pipeline-key в WASM-арене для всех draws, а не для одной
грамматики. Это тот же «generated WBUF grammar» из postmortem, но с трейсовым обоснованием.
Условие из postmortem остаётся: P0 rollback-fuzz до default-on.

Как снять: `profilerStats({filter:'drawIndexed'})` avg на вызов и число вызовов за кадр;
ledgers submitted/encoded/consumed; `arenaRunExecutedPairs` только после починки
intention-counter-а.

Синтетический тест: fuzz producer-последовательностей (random setters/draw/query/RT)
через fused и slow consumer, diff позиций rollback, ledgers и скриншота. Демка
`demo_fc_rebench` режим `mixed` как perf fixture.

## Критерий успеха

JS bucket медианного кадра с 11 ms до 5 ms, p95 ниже 55 ms на той же сцене, все
correctness-тесты зелёные.
