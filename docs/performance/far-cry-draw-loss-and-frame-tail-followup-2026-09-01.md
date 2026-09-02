# Far Cry: follow-up по потерянным draw и frame-tail

Дата: 2026-09-01  
Статус: draw correctness исправлена и подтверждена live; 60 FPS в исследованной сцене не достигнуты  
Сцена: Far Cry, checkpoint Pier, D3D9/WebGPU

## Итог

Наблюдение пользователя о пропавшей геометрии подтвердилось, но после ремонта arena/prefix
пути осталось второе независимое нарушение. Chromium/Dawn отклонял часть программируемых
pipeline при lowering WGSL mutable swizzle views. Затем BottleShip продолжал принимать
`DrawIndexedPrimitive`, но `programmablePipelineResult()` возвращал отказ, и draw уходил в
`drawIndexed:noPipeline`.

В исходном live окне:

- `gpuPipelineValidationFailures`: 209;
- `drawIndexed:noPipeline`: 392,813;
- D3D9 API indexed draws: 651,180;
- backend indexed draws: 258,367;
- разница: ровно −392,813;
- типовая ошибка Tint IR: `swizzle view instruction still has usages after lowering`.

Arena ledger при этом был чистым: 12/12 run pairs, 12/12 logical draws, ноль invariant
failures. Это оказалось полезным отрицательным доказательством: текущая потеря была ниже
arena fast path, на этапе создания обычного programmable pipeline.

## Исправление

Генератор D3D9 shader model больше не создаёт writable component-swizzle assignments и не
читает mutable vector registers через прямые swizzle views в критических местах. Он:

- реконструирует masked destination как целый `vec4`;
- загружает mutable lanes через индексирование (`r0[0]`, `_st[2]`);
- материализует source vector value перед read-only swizzle;
- применяет ту же дисциплину к predicate registers, depth, fog и position output.

Основные файлы:

- `src/worker/backends/webgpu/d3d9/shader/emit/store.ts`;
- `src/worker/backends/webgpu/d3d9/shader/emit/expr.ts`;
- `src/worker/backends/webgpu/d3d9/shader/emit/vs.ts`;
- `src/worker/backends/webgpu/d3d9/shader/emit/ps.ts`.

Это workaround конкретной границы Dawn/Tint, но не guest-specific shader patch: lowering
остаётся общим для всех D3D9 SM1–SM3 программ.

## Live revalidation

После исправления тот же checkpoint визуально восстановил terrain, path, grass, weapon и
depth composition. Артефакт проверки:

`logs/fc-remediation/farcry-second-workaround-gameplay.png`

После reset в steady-state окне:

- `shaderBuildFailures`: 0;
- `gpuPipelineValidationFailures`: 0;
- failed shader pairs: 0;
- `droppedDraws`: `{}`;
- API indexed draws: 778,470;
- backend indexed draws: 778,436.

Разница 34 не соответствует ни одной ветке отказа и снята асинхронным snapshot посреди
обработки; в отличие от исходного инцидента она не имеет matching drop counter. Поэтому
correctness verdict строится на нулевом drop ledger, нулевых validation failures и полном
визуальном кадре, а не на требовании равенства двух неатомарных cumulative snapshots.

Полный gate после обновления generator contracts:

- 3,797 tests passed;
- 0 failed;
- 9 snapshots passed;
- typecheck, WGSL validator и D3D9 ABI/capture gates прошли.

## Почему FPS всё ещё проседает

После восстановления всей работы измеренная нагрузка стала тяжелее и честнее. `frameReport`
на live сцене дал:

| Метрика | Результат |
|---|---:|
| sample count | 330 presents |
| mean | 47.49 ms |
| p50 | 44 ms |
| p95 | 62 ms |
| p99 | 80 ms |
| max | 93.72 ms |
| кадры выше 16.67 ms | 100% |

Классификатор потерянного времени:

- 72.44% — `v86 / guest-cpu`;
- 27.56% — `v86 / io-stream`;
- GPU submit и Present в representative spike занимали доли миллисекунды.

Независимый 10-секундный Chrome trace (`logs/trace-10s.json.gz`) дал 19.9 FPS,
p50 47.75 ms, p95 66 ms, p99 86 ms. Roll-up busy time:

| Bucket | Доля busy time |
|---|---:|
| game JIT blocks | 50.3% |
| JS HLE + glue | 35.0% |
| v86 full-system tax | 14.7% |

В p90+ tail 52% лишнего времени относительно median band пришло из JS HLE/glue. Наиболее
явный периодический contributor — `msacm32:acmStreamConvert`/`decodeMsAdpcmBlock`: около
927 µs на вызов, примерно два вызова на кадр; в отдельных tail frames накопленный decode
занимал 6–11 ms. Это хороший p95/p99 target, но не объясняет весь разрыв до 60 FPS.

Горячие guest области распределены между `cry3dengine`, `xrenderd3d9`, `cryanimation`,
`crysound`, `cryscriptsystem` и `cryphysics`; одного доминирующего kernel, который сам даст
3×, trace не показывает.

## Взятые frame-tail fixes

Два найденных JS-механизма исправлены без guest-specific patch:

- `msacm32:acmStreamConvert` теперь берёт один plain guest-memory view на синхронный
  decode. Побайтовые/nibble reads и PCM writes больше не идут через v86 Proxy;
- authoritative content cache и отложенный writer buffer VFS растут геометрически. Серия
  маленьких append в `Log.txt` больше не копирует весь накопленный файл на каждый
  `WriteFile`; persistence всё ещё получает только точную логическую длину;
- содержимое обычных `.log`/`.txt` не декодируется и не форматируется на NORMAL. Оно
  доступно при VERBOSE, а `.err`/явные error logs остаются на NORMAL.

Регрессии закрыты независимыми ADPCM fixtures и тестом 128 маленьких последовательных
записей с точным EOF. Ожидаемый эффект относится прежде всего к p95/p99; новый live Far Cry
A/B после этих двух leaf fixes ещё не снят, поэтому численный выигрыш им не приписывается.

## Следующие измеримые рычаги

1. Подтвердить ADPCM/VFS изменения live A/B на одном checkpoint; ожидать улучшение хвоста,
   а не переход 20→60 FPS.
2. Разобрать `JS HLE + glue` по портовым сообщениям и D3D9
   capture/resolve; целиться в per-call cost, не в шумный FPS.
3. Для hot guest pages `cry3dengine+0x7a000`, `xrenderd3d9+0x6f000` и
   `cry3dengine+0x54000` получить disassembly/trace2 counts и искать формы для dynarec
   intrinsic/static-recomp.
4. Повторять frame-tail окно после каждого изменения. Correctness gates: ноль shader/pipeline
   failures, ноль dropped draws, полный screenshot и одинаковая сцена.
5. Не переносить синтетические 66.984 FPS на Far Cry: это разные workload и bottleneck mix.

## FC Rebench revalidation

Первый timeout оказался дефектом протокола runner: reset D3D9 counters не был атомарно
совмещён с границей present, а парковка происходила до публикации guest JSON. После
выравнивания окна короткий smoke прошёл, но первый `SCALE=3` честно поймал второй defect:
query ring переиспользовал логический occlusion query, пока его предыдущий GPU readback был
ещё in-flight. `rearm()` возвращал `NOTAVAILABLE`, что дало 603 query errors.

Query manager теперь выдаёт новому интервалу отдельный slot/generation. Старый `BatchEntry`
сохраняет старое состояние до readback и при завершении не может удалить или перезаписать
текущее поколение. После этого hardened default protocol (fresh loads, 120 warmup,
360 measured presents, `N=3`) прошёл:

| Метрика | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| host FPS | 66.984 | 66.795 | 67.302 |
| presents | 360 | 360 | 360 |
| API/backend indexed draws | 1,033,560 / 1,033,560 | 1,033,560 / 1,033,560 | 1,033,560 / 1,033,560 |
| query Begin/End/Ready | 2,880 / 2,880 / 2,880 | 2,880 / 2,880 / 2,880 | 2,880 / 2,880 / 2,880 |
| query errors/missing | 0 / 0 | 0 / 0 | 0 / 0 |

Медиана — **66.984 host FPS**. Во всех runs CPU checksum `47585765`, serial overshoot 0,
`droppedDraws={}`, arena reconcile healthy и query checksum `f8985aca`. Это новый
auditably-clean synthetic result; исторические 67.440 FPS остаются invalidated как старое
измерение, а не «реабилитируются» совпадением диапазона.
