# Constant-only draw capture: кандидат реализован, игровой A/B заблокирован

Обновление 14.09: на открытой гонке выполнены live verification и предварительный
A/B: 165 453 проверок без mismatch, +1.2% по медианам коротких окон. Fresh-load
acceptance по-прежнему не выполнен; кандидат default off. Подробности и новая
трасса езды: [nfsu-live-race-2026-09-14.md](nfsu-live-race-2026-09-14.md).

13.09.2026. Первый эксперимент из обсуждения NFSU/NFSU2 против Bard's Tale.

## Почему этот кандидат

Найден сохранённый census, а не оценка по CPU-сэмплам:
`logs/nfsu-navigation-Gj19CG/1789065177264.json`, `kind=draw-accounting`.
За 336 кадров: 692 617 draw, 468 889 `captureConstOnly`, 43 937 memo hits,
649 860 memo misses. Это **1395.5 constant-only draw/кадр**, 67.7% всех draw
или 72.2% capture misses. Окно старое; эти числа обосновывают эксперимент,
не доказывают его нынешний охват или выигрыш.

## Реализация

`src/worker/backends/webgpu/d3d9/d3d9-device.ts`:

- `__d3d9ConstOnlyCapture=true` включает эксперимент. По умолчанию **выключен**.
- После совпадения существующего материального ключа проверяются также frame,
  live slot, attachment/resource generation, vertex declaration и render scale.
  Нулевой viewport остаётся на полном пути. Поддерживается пара programmable VS/PS.
- Создаётся отдельный pooled draw-state slot. Предыдущий снимок не изменяется:
  он может уже принадлежать записанному draw.
- Сохраняются скрытые части uniform (pixel centre, point size, clip planes,
  fog, legacy bump) и ссылки на texture/sampler. Для изменившихся float/int/bool
  банков выполняется штатная упаковка и вычисление ключей. Неизменившийся банк
  переносится вместе с его ключом.
- Используется обычный `finishCaptureDrawState`: прежняя дедупликация одинакового
  состояния, запись команд и дальнейший executor сохранены. Pipeline resolver
  вызывается до capture и этим кандидатом не устраняется.
- `__d3d9VerifyConstOnlyCapture=true` на каждом попадании также строит полный
  снимок. Сравниваются все действующие слова VS/PS как uint32, ключи, masks,
  stage epoch и идентичность texture/sampler объектов. Расхождение увеличивает
  счётчик и выбрасывает ошибку; временный слот оракула убирается из frame.
- Новые штатные счётчики: `captureConstOnlyHits`, `captureConstOnlyChecked`,
  `captureConstOnlyMismatch` в `getD3D9PerfSnapshot().backend`.

Это сокращает сборку snapshot и повторный расчёт неизменившихся банков.
Число GPU draw, объём необходимых констант и число submit автоматически не уменьшаются.
Ускорение на десятки процентов этим патчем не заявлено.

## Проверка

```
bun test tools/tests/d3d9-constant-only-capture.test.ts tools/tests/d3d9-compact-capture-key.test.ts tools/tests/d3d9-pipeline-memo.test.ts tools/tests/d3d9-draw-reconcile.test.ts
bun run typecheck
```

**49 passed, 0 failed, 315 assertions; typecheck прошёл.** В Bun выводится
существующее диагностическое сообщение APIRegistry об отсутствии
`import.meta.glob`; проверяемые CPU-side capture методы выполняются и тесты проходят.

Новые тесты вызывают настоящий полный capture и новый путь; подменены только
внешние GPU resource resolvers. Проверены float/int/bool, payload NaN и -0,
полный relative-constant банк, fog/bump/clip хвосты, неизменность ранних draw,
отбрасывание кэша при смене входов, включение после старого снимка и oracle,
который действительно падает при испорченной ссылке. Через настоящий
`D3D9CommandRecorder` обе стороны записывают **12 ожидаемых indexed draw**, с
одинаковыми аргументами, битами uniform и query boundaries. Это проверка
producer transcript; реальное GPU исполнение в unit tests не измерялось.

Выводы проверок сохранены в `logs/frontier-review-20260912/const-capture-tests.txt`
и `const-capture-typecheck.txt`.

## Свежая проверка стенда

Созданы отдельные вкладки на `127.0.0.1:5174`; существующие RA3 и стенд другого
дерева на 5175 не навигировались и не останавливались.

| Проба | Новый capture | Результат |
|---|---|---|
| baseline, обычная конфигурация | выключен, hits=0 | `ExitProcess`, AV `0x592a29`, адрес `0x94`, 29 present |
| baseline-nofast, очистка JS fast-path table каждые 10 мс | выключен, hits=0 | тот же выход и AV |

Обе пробы остановились до подтверждения profile/menu и до гонки:
`distance=44.0541087962963`. Новый путь ещё не исполнялся и не является
причиной этого отказа. Вторая проба — диагностическая, не полное доказательство
отсутствия влияния fast paths: регистрация могла восстановить запись между
очистками, а guest/Wasm intrinsics этим вообще не отключались.

Disassembly места падения прочитан: `fstp [ecx+0x94]` после получения ECX через
структуры гостя. Само положение после `SetDepthStencilSurface` не доказывает
ошибку именно этого API. Источник нуля в этой работе не установлен.

Raw отчёты: `logs/frontier-review-20260912/const-capture-live-baseline.json`,
`const-capture-live-baseline-nofast.json`. Boot checkpoints и engine identity:
`logs/nfsu-navigation-sA72Bl/`.

## Дальнейшая приёмка

Runner: `tools/probes/nfsu-const-capture-run.ts baseline|verify|candidate`.
Нужны работающий dev server на 5174, harness Chrome и
`bun tools/bench-v86/source-pair/navigation-record-server.ts`.
Runner создаёт новую вкладку, выполняет свежий вход и при успехе снимает 15-секундный
smoke window с report до/после, затем ставит свой guest на паузу. Это подготовка
проверки охвата/корректности, **не** полноценный performance acceptance runner.

После восстановления входа: ненулевой live `captureConstOnlyChecked`, нулевой
`captureConstOnlyMismatch`, сохранённые draw/present ledgers и визуальная проверка;
затем balanced fresh-load A/B на одной сцене, с идентичными hashes, workload и
контролем disabled-path regression. Пока этих данных нет, кандидат остаётся opt-in.
HLE D3DX для NFSU2 и новый packet detector этим патчем не реализованы.
