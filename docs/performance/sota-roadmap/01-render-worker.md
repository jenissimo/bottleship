# 01. Render-worker: D3D9-исполнение и аудио-кодеки с CPU-worker-а

## Видение

Все SOTA-эмуляторы многопоточны там, где это не требует многопоточного guest-а: DXVK
держит command-stream thread, Dolphin рисует на втором ядре, Xenia выносит GPU-трансляцию.
У нас один worker выполняет guest CPU, HLE, трансляцию D3D9 в WebGPU, submit и декодирование
ADPCM. Трейс Far Cry: 35% busy это JS, и весь он на критическом пути guest-а.

Целевая архитектура:

- CPU-worker: guest, HLE, D3D9-фронт (валидация вызовов, lease, COM), запись команд в arena.
  Recorder уже пишет arena-run в память; это точка разреза.
- Render-worker: владеет `GPUDevice`, читает arena через SharedArrayBuffer, резолвит
  pipeline/bind group, кодирует pass-ы, submit и present.
- Audio-worker (уже есть AudioWorklet): ADPCM/MS-ADPCM decode, ресемплинг.

Guest-thread-per-worker, как у FEX, недоступен: одна register file, однопоточный HLE,
Proxy-семантика памяти. Это граница, а не задача.

## Что нужно решить

- **Обратные ответы.** `GetRenderTargetData`, `LockRect` на RT, `GetData` у occlusion query,
  readback back buffer требуют результат от render-worker-а. Форма: CPU-worker парковает
  guest-поток как async thunk (CLAUDE.md §3.5) и ждёт ответа; остальные guest-потоки идут.
  Sync-ожидание через `Atomics.wait` допустимо только там, где D3D9 сам блокирует.
- **Ресурсы, которые пишет guest.** Unlock vertex/index buffer уже проходит через upload
  path; данные копируются в arena или в SAB staging. Render-worker не читает guest-память
  напрямую, иначе Proxy-инварианты и lease-модель ломаются.
- **Ledgers.** Submitted/encoded/consumed draws, query boundaries, present serial
  становятся кросс-поточными. Каждый счётчик пишется одной стороной и читается другой,
  через Atomics.
- **Back-pressure.** Кольцо на N кадров; при переполнении CPU-worker ждёт, и это ожидание
  должно быть видно как отдельный bucket в frameReport, а не как idle.

## Как снять

До реализации, чтобы оценить потолок:

1. `frameReport` плюс `profilerStats({filter:'d3d9'})` на той же сцене: сумма JS-времени
   D3D9-бэкенда за кадр (executor, resolve, bind group, writeBuffer, submit). Это верхняя
   граница выигрыша минус стоимость передачи.
2. Из trace: bucket «JS HLE + glue», разделённый на d3d9-device/executor/render-frame против
   остального. В `logs/trace-10s.json.gz` это около 7–8% busy, 3.5 ms/кадр, плюс ADPCM
   1.6–3% и до 11 ms в хвосте.
3. Имитация без второго потока: kill-switch, при котором executor записывает команды в
   arena, а исполняет пачкой в конце кадра. Разница кадра между «по ходу» и «пачкой»
   показывает, сколько времени переезжает, а не исчезает.

После реализации: OFF-arm это тот же код с render-worker-ом в режиме in-process (тот же
исполнитель, вызванный синхронно). ON-arm через SAB. Сравниваются ms/кадр, хвост
`frameReport`, ledgers обоих потоков, present serial, скриншоты.

## Синтетические тесты

Correctness:

- **Ledger parity**: демка с фиксированным числом draws, state changes, query begin/end,
  RT switches и readback. OFF и ON должны дать одинаковые submitted/encoded/consumed,
  одинаковый query checksum, одинаковый скриншот по хешу. Тест обязан падать, если в
  ON-arm намеренно пропустить один draw.
- **Readback ordering**: guest пишет в RT, читает `GetRenderTargetData`, пишет снова.
  Прочитанное соответствует первому draw, а не второму.
- **Lock/Unlock под очередью**: guest пишет VB, рисует, перезаписывает VB, рисует. Второй
  draw обязан видеть второй upload. Тот же класс бага, что D3D8 scratch texture
  single-submit.
- **Back-pressure**: демка шлёт 10× draws за кадр. Кадр замедляется, ledgers остаются
  равными, ни один draw не потерян.

Perf fixture: `demo_fc_rebench` в режиме `mixed` уже моделирует нужную форму (2871 draws,
8 RT-групп, 8 query polls). Добавить режим `gpu-heavy` с SCALE по числу draws при
фиксированной CPU-работе: выигрыш виден как уменьшение k в `ms/frame = fixed + k × draws`.

## Критерий успеха

JS-время D3D9 на CPU-worker-е падает до стоимости записи в arena (ожидание меньше
1 ms/кадр), ledgers и скриншоты идентичны OFF-arm, хвост p95 снижается не меньше медианы.
