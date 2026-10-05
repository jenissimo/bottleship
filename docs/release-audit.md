# Проверка перед develop → main

Дата: **2026-10-05**. Известные P1-нарушения §3.0 CLAUDE.md исправлены.
Этот документ фиксирует локальную подготовку; итоговые CI и Pages deployment проверяются
на релизном PR перед мерджем. Gate не доказывает всю семантику WinAPI. Между main и develop
512 исходных коммитов: выполнен целевой аудит, а не ручное ревью каждой строки диапазона.

## Исправленные нарушения

- Удалена UE1-материализация отсутствующих файлов из CreateFileA/W. OPEN_EXISTING
  возвращает FILE_NOT_FOUND без создания файлов; обе API покрыты тестом.
- Удалены no-op renderer probes и shellExecFake, включая соответствующие поля конфигурации.
  CreateProcess и ShellExecute запускают настоящего гостевого ребёнка; kernel handles
  отражают его время жизни и код выхода. Отсутствующий EXE даёт обычную ошибку.
- Удалено определение движка и автоматическая подмена INI при загрузке. Выбор рендера
  остаётся в данных WGB и обычных настройках самой игры.
- Скрытое окно ребёнка не перехватывает display/input. Выход видимого ребёнка восстанавливает
  живого родителя и его текущие audio registrations; отдельно проверен родитель,
  который уже завершился. Полная семантика произвольных деревьев процессов не заявляется.
- Удалён внешний innoextract fallback из GOG CLI: используется общий собственный reader.

Настоящий HP1 renderer helper исполнил гостевой код, завершился с кодом 0 и записал
Detected.log, Detected.ini и HPDemo.ini через общий VFS. Проверены чистый game ID и
повторный запуск того же ID; родитель достиг меню без crash, модалей и unimplemented API.
Production UT WGB очищен от четырёх fake rules и отладочного флага, исходный game ID сохранён;
проверено отрисованное меню. Полные XIII и Unreal Gold также достигли меню после удаления
runtime overrides. Проверки выполнялись последовательно в одной Chrome guest-вкладке.

## Исправленная уборка

- Удалён неиспользуемый `__noLockExclusivity`, позволявший отключать исключительность
  DirectDraw Lock. Обычная проверка живой lease сохранена.
- Исправлены ложные успешные завершения Natalie Brooks, Sea Dogs и breakpoint characterization:
  неудачный run или незавершённые trials теперь завершают сценарий с ошибкой.
- Warcraft-сценарий проверяет отрисованное D3D8-меню как для прямого EXE, так и для launcher
  bundle; наличие отдельного launcher не является требованием к пакету.
- 10 устаревших plan/handoff-документов и закрытый D3D8 A/B-пробник убраны из tracked tree.
  Их локальные копии сохранены в игнорируемом `plan/release-archive-2026-10-05`.
  Touch-сценарий перенесён в templates, измеритель readback — в diagnostics.
- Ссылки на удалённые документы заменены на воспроизводимые протоколы/результаты.
  Результаты измерений, negative results и инструменты с повторяемой проверкой сохранены.
- Architecture приведена к CLAUDE.md: mutable thunk arena, отдельная публикация гостевого
  кода, file-level CoW, quantum в retired instructions, D3D9 render worker.

## Проверки и границы покрытия

### CI

Исследован [упавший run 37287279577](https://github.com/jenissimo/bottleship/actions/runs/37287279577)
на develop `93dd278`, Ubuntu, Bun **1.4.2**. Gate дошёл до тестов: 5206 pass, 18 skip,
15 fail. Все 15 ошибок относятся к EDIT: `ctx.measureText is not a function`.
`tools/tests/video-plane-policy.test.ts` оставлял глобальный урезанный `OffscreenCanvas`
без `measureText`; EDIT получал его в зависимости от порядка файлов. Это проблема
изоляции тестов, а не повод ослаблять качество проверок или подменять WinAPI.

Canvas/ImageData mock теперь ограничен двумя video-plane suites, восстанавливается
после каждого теста с исходными property descriptors. Принудительный порядок video → EDIT
до правки даёт **16 pass / 15 fail**, после — **31 pass / 0 fail**. Linux на той же Bun 1.4.2:
**63 pass / 0 fail** для этой проверки вместе с WGB/folder/streaming тестами.
GitHub Actions запускается на релизном коммите. Успех старого failed run не заявляется;
итоговый status доступен в [Actions](https://github.com/jenissimo/bottleship/actions).

Первый релизный [run 37323934570](https://github.com/jenissimo/bottleship/actions/runs/37323934570)
выявил вторую цепочку утечки с теми же 15 EDIT failures: DrawText-тест восстанавливал
отсутствующий canvas присваиванием `undefined`, создавая свойство. GDI clip-тест проверял
`"OffscreenCanvas" in globalThis`, устанавливал mock через `??=` и оставлял его, поскольку
свойство ранее существовало. Оба fixtures теперь восстанавливают descriptors, включая
исходное отсутствие свойства. Воспроизводимый начальный state `OffscreenCanvas = undefined`:
до правки **25 pass / 15 fail**, после **40 pass / 0 fail**. Полный Windows gate повторён:
**5227 pass / 0 fail**. Runtime EDIT не ослаблялся ради неполного тестового canvas.

Дополнительный полный Linux/Bun 1.4.2 прогон: **5215 pass, 34 skip, 0 fail**.
В локальном WSL нет Naga, поэтому соответствующие shader-проверки пропущены; это не полный
Linux gate. Timeout для этого диагностического прогона был 15 секунд из-за медленного
обхода файлов Windows через WSL; в workflow таймауты тестов не менялись. Первый прогон
также обнаружил отсутствие `bun` в PATH дочерних команд WSL; после настройки PATH проходит.
Обязательный gate с Naga выполняется отдельно на Windows.

### Release checks

- Исходный `bun run gate` до правок: **5241 pass, 0 fail**, 482 файла.
- Финальный `bun run gate`: **5227 pass, 0 fail**, 483 файла, 42.12 с; typecheck, все validators,
  native D3D9 capture gate и WGSL/Naga пройдены. Удалены тесты, подтверждавшие прежние UE1
  обходы; добавлены проверки реального child lifetime, ошибок API и восстановления родителя.
  InstallShield/container regression: **21 pass**, включая ранние дескрипторы, embedded headers
  и одинаковые имена loose-файлов. `git diff --check` пройден.
- Новые streaming-тесты: **8 pass**. Проверяются ZIP64/CRC независимым ZIP reader,
  ограниченные range reads, переключение WASM-декодеров, короткий I/O, границы OPFS extents,
  multipart-состав, chunked Blob save/abort, Galaxy zlib/MD5/dedup assembly.
- Реальный browser import: The Blackwell Legacy — 222 705 144 байт установщика,
  258 658 795 байт WGB, 15 записей, `rom/Blackwell Legacy.exe`.
- Реальный multipart browser import: Far Cry — BIN 2 921 094 987 байт,
  WGB **3 786 058 807 байт**, 3527 записей, `rom/Bin32/FarCry.exe`. Импорт завершился,
  вкладка осталась рабочей, staging удалён. Пиковая память не измерялась; это проверка
  конкретного установщика, не гарантия для любого размера/браузера.
- Warcraft III Demo: rendered menu, D3D8, без unimplemented API на boot;
  production-копия совпадает по SHA-256. Наличие объекта в R2 проверено, размер 111 182 186.
- Browser export/cleanup: получен disk-backed File 2 000 556 байт, изменения manifest
  сохранены, payload совпадает побайтно; 8 001 784 байт временных файлов очищены до нуля.
  Save sentinel и кешированный Far Cry 3 786 058 807 байт сохранились.
- На странице Re-Volt кнопкой импорта выбран реальный офлайн-инсталлятор Blackwell Legacy.
  Заголовок сменился, demo/GOG prompt исчез, отрисовано D3D9-меню: 8111 presents,
  средняя яркость проверенной области 30.47. Это smoke запуска импортированного пакета.
  Prompt скрывается после получения metadata импортированного пакета; неподдерживаемый
  установщик не убирает кнопку повторного выбора. Эта последняя правка включена в финальный gate.
- Chrome wizard: настоящий directory handle передан через structured clone в worker.
  Installed game folder сохранил пакет 601 218 байт в библиотеку; вложенный payload
  совпал побайтно. GOG installer folder собрал Blackwell Legacy 258 658 788 байт,
  entrypoint присутствует. Picker запрашивает `mode: read`. Источник теста, кеш тестовой
  папки и staging очищены. Снимок фоновой вкладки wizard не получен (таймаут CDP compositor);
  функциональные проверки пакетов прошли.

Локальная правка `vendor/v86/build/libv86.mjs` и исходный untracked
`docs/upstream-fork-triage-2026-09-29.md` существовали до задачи и сохранены. До фиксации
релизного коммита следует включать только предназначенные для него файлы. Новые демо, catalog и covers подготовлены к Pages deployment через main. Семантический
номер версии не выдумывался: в package.json его нет, changelog датирован 2026-10-05.

Во время работы `.git/index` оказался заполнен нулями. Копия сохранена в игнорируемом
`logs/git-index-corrupt-2026-10-05.bin`, индекс восстановлен из HEAD без checkout/reset
рабочих файлов. В последнем исправном состоянии staged-изменений не было. Локальный
`core.autocrlf=true` согласует восстановленный индекс с CRLF исходного Windows checkout,
избавляя статус от отличий только в окончаниях строк.
