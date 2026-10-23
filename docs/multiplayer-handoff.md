# Multiplayer: передача работы и план продолжения

Обновлено: 2026-10-23. Цель пользователя: полный сетевой стек BottleShip с паритетом Winsock и DirectPlay, Socket.IO/WebSocket с HTTP polling fallback, настройкой LAN URL в эмуляторе и отдельным производительным Rust-сервером. Цель остаётся активной. Не объявлять её завершённой по одному успешному этапу.

## Текущий следующий шаг

Q2 game-fourth j22b55a завершён FAIL после настоящего соединения двух игроков. Первые sample показали Host guest/canvas63 и Peer22, затем обе страницы перестали отвечать даже на page-side Runtime.evaluate("true"). Следующий шаг — узкая диагностика main-page/render dispatch; увеличение таймаутов и повтор game-fourth вслепую не обоснованы. Основной .wt/lan-network runtime/source остаётся freeze30 HOLD. Подготовку диагностики ведёт /root/lan_transport: runtime-v5 готовится с независимым exact-ID CDP supervisor, direct PNG, CPU snapshots, durable phase records и bounded pause/resume только на подтверждённом page stall. Оба агента и Root остановили тесты перед диагностическим окном. **Actual V5 j95599a RUNNING** (начат15:52:27UTC), output logs/lan-conformance/stage30-quake2-diagnostic-preparation/runtime-v5/game-diagnostic-first; перед продолжением читать project_output и actual records, не запускать повторно. Reviewed MANIFEST.json SHA41e431726ab59af033ca057a8b2245b90afe3ae1fc757405cb90667b60d911ef; supervisor2faded6978df1984c640594374b9733026325cf004afe313ce7523d557c2b012, game4151c053a4d6025969c9740e9d691338a1bdeb77563025beed4d2abee46b833b. Свежие IDs app:bs30-quake2-v5-b67d92-host/peer, bs q2h5-b67d92/q2p5-b67d92. Probe25s, failure evidence15s, game240s/outer330s/privateCLI420s; exact-owned cleanup описан README. Тесты всех агентов HOLD до завершения. Следующие реализации уже разрешены в отдельных рабочих копиях ниже; это позволяет сохранить прежнюю проверенную сборку для диагностики.

Новый Native DP8 Host+2Peer baseline уже GREEN: j4f0e6d,599 checks/1198 words, все три exit0/без forced, actual ports55230..55232 rebind. Это reference Windows, не наш многопользовательский Host. Выход: stage30-directplay-host-mesh-preparation/native-runs/host2-native-3001001/verified.json, SHA6cb16f077e31b21c72b3c316bf10385a2764effc8ff9d5af306639d6a5dabdc0. PE4ea595ed91008dd9fd3808a938e6db4b9a5d7b168591ac858021f7457a4dbad3. Отдельно измерено Peer GetLocalHostAddresses=0x80158530 NOTHOST.

## Сначала прочитать

1. Этот документ, корневые README.md, AGENTS.md и CLAUDE.md. При работе с игрой — .claude/skills/bringup/SKILL.md в активном worktree.
2. Пользователь разрешил мультиагентную разработку, локальные изменения, проверки и коммиты. Повторное подтверждение обычной работы в этом объёме не требуется. Push, публикация и deploy не разрешены.
3. Проект находится на удалённом Windows-устройстве zhenya-pc. Все файлы и команды доступны через MCP luna-project. Начинать с project_info; VPS не содержит копии проекта. Команды project_run исполняются PowerShell, долгие задачи — project_start. Не читать .env, авторизации, токены и ключи.
4. Основной проект: C:/Projects/bottleship-oss. Активный worktree: C:/Projects/bottleship-oss/.wt/lan-network, ветка codex/lan-network. Все относительные пути ниже — от этого worktree, кроме явно обозначенных.
5. Перед продолжением проверить git status, project_jobs и текущие страницы CDP. Job IDs и процессы могут уже завершиться; не повторять команду с неизвестным исходом автоматически.

Ранее накопленный подробный журнал: plan/lan-handoff.md. Он содержит много исторических записей, поздние записи сверху отменяют старые. Этот документ — краткая точка входа; доказательства находятся в именованных manifest/report файлах.

## Проверенное состояние

Последний коммит функциональности основного worktree: **188a06635e2aaa7204736f91aeaf1364b0a40997** — virtual IPv4 multicast, coherent relay readiness и connected DirectPlay8 peer information. 73 файла; после коммита рабочая копия была чистой. Позднее HEAD может содержать отдельный коммит документации: сверять git log/status.

Отдельный Rust-проект: C:/Projects/bottleship-oss/.wt/bottleship-multiplayer-server, чистый коммит **9ba35981d3db739e79cdb363f0ce2eeb4cb5d21e**. 139 tracked files, публикации/remotes не создавались. Старый отдельный TypeScript-проект .wt/bottleship-lan оставлен на 7a6662d4; основное направление сервера теперь Rust.

| Проверка | Результат | Где доказательства |
| --- | --- | --- |
| Общий gate с обязательным WGSL | 6642 pass, 0 fail, 689 files, 9 snapshots, 2696831 assertions | gate-stage30-first.log, job jf728b5 |
| Production frontend | Build EXIT0, sidecar 3003, entry index-DeVxPzNC.js | build-stage30-sidecar3003.log, job j85cedc |
| Статические SAME-PE сравнения в браузере | 70 fixtures, 20198 DWORD observations, 0 differences | production-25/attempts/static-1/static-result.json, jc9409f |
| Connected SetPeerInfo | Host и Peer × WebSocket и polling, 4 × 988 observations, INFO callback traces совпали | production-25/directplay8-peer-info/verified.json, j129a1c |
| Rust standalone | Все 5 crates: 106/0; release CLI и release conformance server проверены | standalone-rust29/, commit 9ba35981 |
| Production CLI lifecycle | PRIVATE console → READY/health → Ctrl-C → exit0 → port retired; forced=false | stage30-quake2-run/owner-smoke-first/result.json |

Все короткие пути доказательств в таблице находятся под logs/lan-conformance/.

Ключевые контрольные суммы:

- freeze-30/source.json: **71582326701092d11d0766e29a7298bc6cbb3b0c6850be8f33210b70616b40e5**, 2726 inputs.
- freeze-30/archive.json: **1e03bbe923d4a1628231137a1c05e6caaa46efc56ea6c5d53dfdd9923f4af873**. Исходники скопированы, assets ссылаются на проверенные копии production-25/runtime-assets.
- production-25/environment.json: **e298cba64a33d54a49ffe608412f38326707cd48a0eff0f5bde667eb65839bde**.
- production-25/checkpoint.json: **a2d813bcc89d0f270072479f989821f1f3f7d5f209d951084389daeaecae26bd**.
- production-25/attempts/static-1/static-result.json: **27f6d520eb446c6e0347e274070d3b205abb1a8c290a0ab716419fdcd6da81e0**.
- production-25/directplay8-peer-info/verified.json: **9802b741c521b9bb9422990911d027f59e1667760248a57fc6d4d12d1f396a62**.
- Release Rust CLI standalone-rust29/bin/bottleship-lan.exe: **db838c2af7b5a9c6205a633ba7c81d2baeacd70e61590927990db5502ea60551**.
- Release conformance-server.exe там же: **dee9548943ad1ac5d2fc745a6f144902108cb5326fc6f4c291d4c421f25e9401**.

Четвёртый Q2 proof: two-player-status.json SHA f2f6ae17bf67cbb33ea151a366f1dc9d42a50420c7310c1816a8e38078ca9619, game/report.json d7210296552a129fc97c406fc5cdc5c0a14b7393224fb1910c4424c9c2b96e36. Следующий host-probe-5 превысил25s, его tool process завершён принудительно; evidence с literal evalPage(true,5000) не ответил на обеих страницах. Console cleanup тоже не ответил. Fallback закрыл только exact owned tabs, siblings сохранены, observer peerLeft подтверждены. Production CLI51412/owner23400 штатно exit0/forced=false, port55702 ECONNREFUSED. Важно различать forced tool deadlines и graceful server shutdown. Оба gameIds V4 использованы, OPFS не удалять.

Итоговые коммиты и ссылки на proof записаны также в production-25/committed.json. Ни один из этих результатов не доказывает полный API-паритет, совместимость всех игр или производительность.

Оценка, сообщённая пользователю: около 85% рабочего LAN MVP и 60–65% полного паритета. Это субъективная инженерная оценка, не процент измеренного покрытия.

## Текущая операция и владение ресурсами

На момент обновления основной runtime/tests на HOLD ради coherent freeze30 и проверки настоящей игры. HOLD — внутренний барьер согласованности между агентами, не повод заново просить разрешение пользователя.

Сохранять чужие/предыдущие ресурсы:

- Dev Vite 5175: job j1d0d62; sidecar 3003; Chrome CDP 9334.
- Предыдущая страница lan-oracle: 246B46F80BB9369439AEDB2611081AA7.
- Предыдущая about:blank: FE792D67E9B510A809329509295E0B8F.

Наш production preview 127.0.0.1:5176: job j38f28c. Останавливать только его перед следующей frontend сборкой. Нельзя запускать harness up на этом порту: проверка src/App.tsx может заменить preview dev-сервером.

Наша страница production25 BA5D615662B94C7DB98F63560CD7DE05 закрыта; обе предыдущие страницы сохранены. Четыре DP native процесса и четыре Rust conformance процесса штатно завершились, порты проверены до shutdown. Нельзя закрывать Chrome целиком или убивать процессы по общему имени.

Агенты команды, если они ещё доступны:

| Агент | Текущий участок |
| --- | --- |
| /root/lan_transport | MAIN .wt/lan-network: готовит ignored Q2 V5 independent CDP diagnostic; shipping source не меняет, запуск Root после HOLD |
| /root/winsock | .wt/lan-udp-connreset: разрешена реализация WSA API/physical flag/actor/completion policy и meaningful RED→GREEN; Native/browser/fullgate отдельно согласует Root |
| /root/directplay | .wt/lan-dp8-host-mesh: разрешена реализация native Host membership C2/D0/C6/D1 и binary-unit RED→GREEN; Native interop отдельно согласует Root |
| /root | .wt/lan-udp-connreset: generic local UDP port-unreachable в src/worker/net/* и core/network-namespace.ts; также review, main frozen game diagnosis и интеграция |

Обе новые рабочие копии созданы job jb31a47 EXIT0 от base **5f5fa934468f2c71efca197ffd05428398f44761**:

- C:/Projects/bottleship-oss/.wt/lan-udp-connreset, branch codex/lan-udp-connreset.
- C:/Projects/bottleship-oss/.wt/lan-dp8-host-mesh, branch codex/lan-dp8-host-mesh.

В каждой только node_modules и logs/tools являются junction к проверенному main worktree. Считать эти два каталога READONLY; не выполнять bun install и не редактировать зависимости через junction. Остальной logs у каждой копии собственный: whole-logs junction намеренно не создан, иначе imports тестов разрешились бы в старый src. Fixtures/tests переносить физически в нужную копию. Старые Native evidence читать по absolute path основного worktree, не редактировать. Package workspace symlinks в общих node_modules могут указывать в main: package-level изменения требуют отдельного решения, текущие реализации ограничены src/worker и tests/tools.

Все команды явно выполнять из соответствующей копии. main frozen frontend и его source manifest не менять. Лёгкие focused unit tests в новых копиях разрешены; перед actual browser/native diagnostic Root останавливает параллельные тесты. Пока не выполнять merges/cherry-picks/push. Сначала stable source manifest и review, затем свежий coherent freeze/build/proof при интеграции. Новые checkout могут иметь CRLF из Git autocrlf: нужны собственные новые source hashes, старые manifest не «исправлять».

## Настоящая игра: где остановились

Подготовлено неизменённое демо G:/WGB/prod-library/quake2-demo.wgb, SHA **35f6d119d96507cb58ef9a7f9cf23b84e1f071a021524602915be8451e097bd5**. У двух копий отличаются только обычные manifest gameId/args. Все 192 прочих entries, включая EXE/DLL/PAK/registry, побайтно сохранены. Исходное WGB не менялось.

Только карты demo1/demo2/demo3 имеются в PAK; base1 отсутствует. В demo1 найдено 9 deathmatch spawn points. Это ещё не доказательство работающего мультиплеера.

Артефакты подготовки: stage29-quake2-preparation/ и текущий stage30-quake2-run/. Изолированные gameIds: app:bs29-quake2-mvl24cjl-host/peer. Имена игроков BS29Host/BS29Peer; вкладки q2h-mvl24cjl/q2p-mvl24cjl; обычный UDP port 27910. Host запускает deathmatch +map demo1; Peer получает фактический Host virtual IP из network_state, затем обычный +connect.

Два первых запуска закончились инфраструктурным FAIL **до исполнения PE**:

1. j4343c7, game-first: listSessionTabs() ошибочно приняли за scoped по BS_TAB. Функция возвращает все game=dev страницы. Исправлено в ignored role.ts через exact bs + origin. Снимок старых шести scripts сохранён в game-first/input-snapshot/. Старые manifest и FAIL не переписывались.
2. j622fd1, game-second: абсолютный WGB путь ушёл на /__wgb/ у production preview и получил HTML вместо WGB. CPU оставался до загрузки PE, threads/frames=0, manifest не был прочитан. Вкладка закрыта, siblings сохранены; CLI11880/owner63436 exit0, forced=false, actual port64421 retired. Агент готовит обычные same-origin HTTP URL с exact SHA проверкой, как в уже прошедших PE fixtures.

После первых двух попыток gameIds оставались неиспользованными. В третьей Host уже исполнил PE: для следующего независимого повтора готовятся новые gameIds обеих ролей; старый OPFS не удалять.

Текущий HTTP serving fix: новые dist/apps/q2-proof-v3-host.wgb и q2-proof-v3-peer.wgb; job j0777f4 подтвердил HTTP200 и точные SHA исходных копий. Карта URL сохранена в stage30-quake2-run/preparation-v3.json. MANIFEST-v3.json SHA e336877a1b071ce9c45e99ed126ac7de37f11fe1d939054ddb3a2fcece1608e8, tools HOLD. Из прежних шести scripts изменён только game.ts, SHA51096c437dce328c67cab2f48fea42b255561b33a265557619d994d56acd2663. Проверки archive/HTTP/syntax j5baf9e/j0777f4/j4cf4e0 EXIT0. Не перезапускать Vite и не менять frozen frontend ради этой обвязки. Третий запуск jc646a5 завершён FAIL: Host реально запустил demo1 и ответил настоящим LAN status с BS29Host (host-only-status.json SHA7da4fc4d74196f669fc2c7b73973d6f9c30b7173250921cd1fed038b16be4a9b). Peer не исполнил PE: созданный CDP target ещё имел пустой URL, а harness сразу сделал findTab. Нужен bounded wait exact created target URL/origin/bs и page harness readiness до reload. Обе вкладки закрыты, siblings сохранены; server exit0/no forced. V4 подготовлен и запущен: MANIFEST-v4 f5db5f8c00fafd4a8c6b99bff24eed3299919382906483d1d7a4b202e9e9ea58; role d343f9a9…, game b74ae110…; свежие gameIds app:bs30-quake2-v4-a34f1c-host/peer. Третий ранний Host screenshot host-screen.png SHAf3516f62… был серым окном. Четвёртый запуск показал более поздние presents63/22 и соединение двух игроков, но затем page-side диагностика зависла; полного игрового GREEN нет.

Ниже использованная команда четвёртого запуска. **Не повторять** существующий output: он содержит FAIL. Для следующей диагностики нужны новый каталог, новые gameIds после фактического boot и отдельный диагностический план:

    Set-Location .wt/lan-network
    & ./logs/tools/bun-portable/package/bin/bun.exe logs/lan-conformance/stage30-quake2-run/controller.ts --run-authorized --manifest logs/lan-conformance/freeze-30/source.json --expected-sha 71582326701092d11d0766e29a7298bc6cbb3b0c6850be8f33210b70616b40e5 --output logs/lan-conformance/stage30-quake2-run/game-fourth

Положительный критерий runner: ответ настоящего Quake II status с mapname demo1 и сначала одним, потом ровно двумя именованными игроками; advancing guest/canvas presents у обеих ролей; настоящие GDI окна; повторный two-player status; qconsole logs, reports и screenshots. Observer отправляет только FFFF status newline, не изображает третьего игрового клиента. Обязательно визуально просмотреть screenshots: статус подключения сам по себе ещё не доказывает игровой кадр.

Cleanup: Peer перед Host, обычная попытка disconnect/quit, set_network null, один CDP close на exact owned ID с read-only ожиданием отсутствия и сохранением siblings, observer close. CLI запускается в собственной private console с roster owner+CLI; Ctrl-C только в неё; ждать exit0/физического закрытия порта. Owner-only аварийное завершение допускается для cleanup, но результат тогда FORCED+FAIL. Исходники owner и smoke доказаны; conformance example с auto-expire90s для холодной игры не использовать.

## Архитектура, которую сохранять

- Winsock/DirectPlay реализуются в эмуляторе. Rust-сервер перевозит пакеты и владеет разрешёнными native gateway sockets; он не подменяет WinAPI.
- Одна relay identity на process family, shared port registry и физические socket objects для aliases. Parent/child/descendant и source-process exit не должны разрушать живой дубликат.
- Descriptor-local состояние отделять от physical socket lifetime. Pending IO/callback/operation относится к owner thread/process epoch; reset/Close не должны публиковать старые writes в новую память.
- Socket.IO event arguments и старые wire formats сохранять. Новая возможность требует capability и отказа на старом сервере, если выполнить её нельзя.
- Multicast4 marker3/header20 несёт group/interface/TTL. LAN IF2 и TTL>=1 — fanout другим live peers одной room; loopback IF1 и TTL0 локальны. Native gateways multicast envelope не получают. Членство/IF/TTL/LOOP общие у physical aliases; Windows LOOP фильтрует локальное происхождение у receiver. См. plan/udp-multicast4-v1.md.
- Coherent ready: bounded 1MiB SAB snapshot/seqlock, единый writer, metadata целиком до online. Capabilities, DNS, routes и Host listeners нельзя доставлять разными временными состояниями. Generation/revision fences гасят queued stale state и старые leases.
- DirectPlay native wire и виртуальный guest-room protocol — разные backend. Сохранять actual native C2/D0/C6/C4/D1 и callback/lifetime правила, не заменять их собственной совместимой лишь между гостями схемой.

## Метод работы и ораклы

### Источники истины

1. Зафиксировать конкретный native профиль и реальные public API наблюдения. Текущий host — Windows11 Pro NT10.0.26300 x64, PE x86. Это не автоматически Windows95/XP.
2. G:/sources — read-only ground truth. Для DP8: G:/sources/nt5src/Source/XPSP1/NT/multimedia/directx/dplay/dnet/core. NT5 source объясняет механизм, порядок валидации и binary layouts; различия версий фиксировать отдельно.
3. Документация и заголовки дополняют измерения. Экспорт/ordinal audit подтверждает декларации, не поведение.
4. Если поведение не измерено, назвать его UNVERIFIED и сделать узкий probe. Не придумывать E_NOTIMPL/UNSUPPORTED как «паритет», когда native это не возвращает.

### Цикл изменения

1. Сформулировать наблюдаемый контракт и источник; pointer/capacity/LastError/alias/lifetime/callback/backpressure входят в контракт.
2. Создать конечный native oracle. Fresh output directory, nonce, source/compiler/PE SHA, реальные loopback endpoints, bounded deadlines, durable progress, exit/forced/port retirement.
3. Сохранить raw native reference. Запускать **тот же PE**, с теми же args/schema, в эмуляторе. Нельзя пересобрать C или «подправить expected» после получения guest RED.
4. Убрать непереносимые значения по заранее описанной схеме: PID/HANDLE/TID/динамические адреса/порты в separate raw audit; сравниваемые identity нормализовать через реальные имена/контексты/связи. Не заменять произвольные результаты ожидаемыми константами.
5. Сделать meaningful RED на реальном владельце механизма: physical socket/actor/namespace, настоящий Worker/SAB/transport или бинарный DNET обмен. Unit mock не заменяет прохождение настоящего process/transport пути.
6. Исправить общий механизм. Никаких веток по game/exe/hash, ROM/guest code patches, вымышленных ответов или sleep для сокрытия гонки. Нормальные игровые args и отдельные fixture/data copies допустимы.
7. Focused GREEN, затем достаточный связанный набор. После стабилизации всех агентов — общий gate с WGSL, новый source freeze, frontend build, exact served-assets proof, необходимые SAME-PE/native interop cases.
8. Записать пределы доказательства, обновить этот handoff, сделать локальный коммит. Новый native/guest/cohort output всегда новый; первый RED остаётся.

Обычный native record: little-endian DWORD header 0x42534c4e, total word count, fresh nonce; сравнение валидирует schema/count/nonce/PE/ref hashes и все eligible observations. Callback traces могут иметь отдельную структуру: фиксировать ABI sizes, callback thread/context, query visibility и ownership; не предполагать общий порядок независимых native threads без измерения.

Когда важен wire, сохранить raw datagrams плюс отдельную разборку DNET/ACK/fragmentation/core messages. IAT/network observer — дополнительная диагностика, не чистый public API oracle. Свежий API-only PE нужен отдельно.

### Как выбирать следующий шаг и передавать решения

Для каждого механизма вести короткую запись: наблюдаемый контракт → источник/версия → подтверждающий oracle → первый RED → общий владелец состояния → GREEN → границы и следующий шаг. Гипотеза, измеренный факт и принятое архитектурное решение должны быть различимы. В handoff достаточно пути и SHA к подробному manifest; секреты и гигабайты raw данных в документ не копировать.

При расхождении NT5 source, документации и текущей Windows не «усреднять» ответы: указать версии, измерить минимальный public API случай и выбрать явно названный compatibility profile. Чистый native oracle не должен зависеть от нашего expected или реализации. Binary protocol tests проверяют механизм по независимым native/source фактам; они сами по себе не доказывают совместимость с настоящим Windows Peer.

Приоритет: сначала prerequisite, который блокирует проверяемое поведение; затем небольшой общий механизм с сильным независимым oracle; затем интеграция по настоящему process/transport пути. Например, UDP_CONNRESET требует реального local UDP port-unreachable, а многопользовательский DP8 Host требует membership transaction, а не только снятия maxPlayers ограничения. У каждой параллельной задачи — отдельные файлы/worktree, критерий готовности, reviewer и барьер перед общим freeze.

Матрица прогресса должна разделять: экспорт/ABI, наблюдаемый API контракт, aliases/lifetime/completion, процесс/Worker/actor, wire/native interop, production WebSocket/polling и настоящую игру. Для каждого уровня хранить статус UNVERIFIED/RED/GREEN, путь к доказательству и пределы. Не складывать число assertions в «процент полного паритета». Производительность — отдельный замер throughput/latency/CPU/memory под заданной нагрузкой; язык Rust не является результатом benchmark.

### Что нельзя считать успешным proof

- Native timeout, exception, forced kill, отсутствующий final marker или неосвобождённый actual port.
- Удачный syntax/help/pack вместо исполнения игры/API.
- Старые worker assets вместе с новым main bundle без проверки actual entry и HTTP hashes.
- Проход component tests на разных source/build, объединённый в один «coherent GREEN».
- Только virtual local port rebind, когда реальный gateway владел другим OS port.
- Статус connected/два имени без доказательства guest execution/кадров, когда заявляется игровая сессия.
- Функциональные проверки как доказательство performance. Benchmark ещё не проводился.

## План реализации после текущего игрового proof

### 1. UDP_CONNRESET

9451 старых native observations: stage30-udp-connreset/observed-contract.json SHA 4abc6ed82ffa35c8ed4775204af2ce561a476dc4fec07ec295286447791493a8. Новая переносимая выборка уже измерена:

- portable-preparation/native-first/, job j302e80: 6168 observations / 560 records, 250 pointer cases, 32 completion variants.
- PE 2c2380a94009daa129178d4d0deeb1cd16f2349db82628d57f302f82d74c4d84.
- Reference 4f6eca17e4e07820f6fa8cd198d1fa5313d7b6149df3e662528ee7c11ef1d14d.
- Analysis f0f71e4f8d7e8f04913c859ddd021382f141256045f255a82bf890317c57a619.
- 40/40 live controls, 54/54 port retirement, no exception/timeout; все процессы завершились. Подготовительная оценка6368 ошиблась арифметически; raw6168 и прежние артефакты оставлены как есть.

Измеренные особенности: SIO_UDP_CONNRESET0x9800000c читает первый BYTE;256=off,257/on. Успешный nonnull returned pointer не dereference; NULL даёт14. TCP возвращает22 до dereference плохого nonnull input. Нет autobind. Flag физический, общий aliases и reserved import через WSACleanup/startup. Уже queued54 переживает off; suppressed54 не воскресает после on. Event/APC/IOCP и IOSB publication имеют измеренный порядок.

**Physical toggle effect IOCP+APC22 теперь измерен: отказ НЕ атомарный.** Followup je849e5:976 observations/123 records,8/8 cases IPv4/6 × initialON/OFF × queued/noqueued. Несмотря на return-1/10022 requested physical toggle применяется. Старый queued54 сохраняется; новые errors отражают новый flag. Returned sentinel/IOSB259/High0x22222222/offsets неизменны; APC0/IOCP packet отсутствует; live16/16,24ports retired, все процессы завершились. Analysis: iocp-apc-effect-preparation/native-first-analysis.json SHA3e859a9eb342e16bbaa200f93a1b2993f7229787343b2af003bbe5cac2ed96bd; PE2f598d655aa2d48585421cd37fa03b72c7604b1e01506952229c15308cbd3cae, refd5bc21485228c64cc2c79f8b9cbaae2f1a1ad749fcb38ba5c245b2d158e9a28b. Менять physical flag до completion-routine/IOCP rejection, не rollback на22.

Реализация начата в .wt/lan-udp-connreset: /root/winsock получил meaningful RED j007913 (1pass/22fail), затем control+related suites GREEN j44b9ed (102tests/1013assertions/5files). Внесены physical flag, first-byte IOCTL/validation/completion policy, actor serialization и suppression только новых UDP54; После generic unreachable physical+control jab8099 GREEN:26/0/301 assertions, actual actor IPv4/IPv6, aliases/reserved import/cleanup, queued54 и non-atomic22. Log actor-control-first.log SHA6dfa33b6645ed54552feb81366b36504bb2cfb5e513ef783c21ee725dc406a9b. Stable HOLD-1 manifest logs/lan-conformance/udp-connreset/hold-1.json SHA2e8eca7348f7b9339206e3211b13411355dda4ba8b0159e0dfb7004af9f21fff в isolated worktree; shared typecheck/fullgate/browser ещё не запускались. Root отдельно получил network/actual Worker RED j1952ef (5pass/4fail): closed local UDP не выдавал ошибку. Общий trusted-admission механизм в net/namespace GREEN j7b69cb:9/0/54 assertions, log logs/lan-udp-unreachable-green-first.log SHAa365005e422f859aaf67080ca6deeb813082191cdc106f1f9188258ca74e6471 в новом worktree. Проверены IPv4/6, actual Worker, targeted source при shared port, source close/rebind/reset и отрицательные live/foreign/broadcast/multicast controls. LanNetwork SHA142bb461cbd870720fa35611f840f4ac1ad4ae2cfe03749c533250013fa8e12a, namespace2abaf6fa653cdbe823d85273e02b46cf23c433bb75f221a0c48d946fe88d12a5. Error asynchronous, source bindingGeneration + internal deliveryGeneration и owner epoch fences; только accepted local unicast к отсутствующему owner. Другие physical reuse-policy случаи требуют собственного native oracle. UNVERIFIED resource concern: standalone/direct-loop создаёт microtask на каждый closed UDP send; namespace child ограничен MAX_FRAMES256, но произвольный cap/coalescing для standalone пока не выбран без native queued-error/tuple attribution измерений. Не выдавать его за доказанную bounded policy. После focused и связанного GREEN нужен тот же PE6168 в браузере на новом freeze/build. Не сбрасывать уже queued error при off. Не менять default gateway ICMP attribution произвольно. Отдельно проверить prerequisite whole-SAMEPE6168: producer сам создаёт closed loopback UDP port. Если virtual Winsock пока не генерирует соответствующий asynchronous port-unreachable/reset, нужен общий механизм; нельзя подменять expected words или перенаправлять весь127/8 на native gateway ради fixture.

### 2. Native DirectPlay8 Host с двумя remote Peer

Read-only аудит: stage30-directplay-host-mesh-preparation/review.md SHA f8d04789a30b2c297aa42d311dd783685804c115d7092389900afaf3a8749b6c; manifest83d75afa….

Недостаёт authoritative membership transaction/fanout: полный version-cutoff C2 newcomer, D0 существующим Peer, общий C6/version всем нужным участникам, D1 survivors при уходе. UDP exact-tuple/direct peer-channel механизм уже имеется. Просто убрать maxPlayers==2 проверку недостаточно.

Native source: coreconnect.cpp DNHostConnect1/2, nametable.cpp PackNameTable, worker.cpp DNWTSendNameTableOperation, disconnect.cpp DNHostDisconnect. Старый 3-party native capture показывает C2→D0→C6→C4→D1, но старый IAT diagnostic не является новым API-only oracle.

Следующие шаги: API-only Host/P1/P2 PE/reference → binary-unit RED/GREEN → наш NativeHost+два настоящих native Peer на dgram → configured gateway WS/polling → реальный guest x86 COM Host+два native Peer на новом coherent frontend. Проверять шесть SendTo направлений, роли/metadata/contexts, P2 Close и живой Host↔P1, затем P1 и Host Close, actual ports/PIDs. Ignored candidate собран и измерен единственным Native baseline j4f0e6d:599 checks/1198 words, nonce3001001, actual ports55230..55232 retired. Host19932/P126308/P234652 exit0, forced=false, все14 source guards неизменны. verified.json6cb16f07… и PE4ea595ed… зафиксированы выше. Наш Host с двумя remote пока не доказан; /root/directplay уже разрабатывает его в отдельном .wt/lan-dp8-host-mesh через binary-unit RED→GREEN. Основной freeze30 HOLD не снимается: новый runtime интегрировать только после отдельного review и свежего coherent proof.

Сохранять bounded all-recipient reservations до mutation, owner callback return gates, C3/reply ReturnBuffer once, admission epoch, snapshot/catch-up и reentrant Close/reset. C7/C8/E2/E3 failure arbitration, churn/wrap, группы, migration и security требуют отдельных наблюдений.

### 3. Остальной паритет

После измеримых предыдущих шагов вести явную матрицу API/provider coverage. Остаются классический DP4 native wire; DP security/NATResolver/groups/migration/larger mesh; Win32 named-section prerequisite некоторых process/lobby fixtures; SPX; native NIC/IPv6/source-specific/RAW multicast; less common socket/provider/namespace IOCTL/options; raw fragmentation/IPv6 headers; positive linger; completion на non-overlapped socket и отдельные urgent/ICMP политики. Полный список текущих ограничений — docs/multiplayer.md и package READMEs.

Не превращать все эти пункты в один большой непроверенный рефакторинг. Каждому наблюдаемому механизму — native source/measurement, узкий oracle, реальный RED, generic fix и proof с указанными границами.

## Команды и ловушки стенда

Portable Bun **1.4.3**: logs/tools/bun-portable/package/bin/bun.exe. Не использовать старый1.3 для Worker/SAB: он уже давал runtime crash.

Gate после необходимых source changes:

    Set-Location .wt/lan-network
    $lanBunDir=(Resolve-Path logs/tools/bun-portable/package/bin).Path
    $env:Path=$lanBunDir+';'+$env:Path
    cmd.exe /d /c "bun run gate > logs\lan-conformance\gate-NEW.log 2>&1"
    exit $LASTEXITCODE

Долгую команду запускать project_start, затем читать project_output нечасто. PowerShell *> давал неудобную кодировку; raw cmd redirection сохраняет UTF8 logs. Gate включает mandatory WGSL. Не ослаблять timeout/проверку ради GREEN: ранее untouched600-seed fuzz однажды упёрся в5s, focused тот же тест прошёл, затем полный gate прошёл без изменения теста.

Frontend build — только с явно заданным $env:VITE_SIDECAR_PORT='3003'. Сначала остановить собственный preview5176. Проверить actual index entry и encoded sidecar port. Vite emptyOutDir:false сохраняет старые НЕиспользуемые assets: наличие свежего файла не доказывает, что entry действительно ссылается на него. HMR не считается свежим proof.

Для browser harness устанавливать BS_TAB, BS_DEV_URL, BS_URL_MATCH, BS_CDP_PORT9334 и BS_SIDECAR_PORT3003. BS_URL_MATCH должен соответствовать точному origin; BS_TAB — отдельное имя владельца. listSessionTabs() перечисляет все game=dev tabs; фильтровать exact bs/origin самим. Закрывать только созданный exact ID, записать intent до запроса, затем read-only ждать исчезновения, не повторять close вслепую.

Frozen helpers: freeze-30/capture-source.ts --verify; verify-production25.ts <NEW-record-name>. Новый source freeze/cohort создавать отдельными каталогами, не перезаписывать30/production25. Старые production23/24 не GREEN:23 только подготовлен с неверным sidecar3001,24 дал48 измеренных Winsock differences; оба сохранены. Production25 их исправления проверил.

Тесты запускать по точному ./tools/tests/name.test.ts. Bare filter может найти ignored logs с архивными тестами. Поиск в .wt требует include_ignored:true; в rg использовать -g '*.ts', не Windows wildcard позиционный путь.

C: свободно около2GB; G: около896GB на последней проверке. Cargo target: G:/bottleship-lan-build/stage28, jobs1. Не запускать параллельно native/browser proof и тяжёлый Cargo/gate. Project file-tool directory move ранее возвращал явный422 PermissionError; обход через shell не применялся. Для новой доказательной серии создавать новые каталоги.

## Как обновлять этот документ

После каждого значимого этапа менять: текущую операцию/HOLD, последний функциональный commit, source/build/proof hashes, active jobs/tabs, completed/remaining механизмы и точный следующий шаг. RED не удалять: добавить причину и путь к следующей попытке. Перед остановкой/лимитом сохранить также ownership незавершённых процессов и команду read-only проверки их состояния. Не хранить секреты.

Если контекст или лимит закончится: новый агент читает этот документ, проверяет реальную удалённую машину и текущие jobs, затем продолжает с текущего незавершённого шага. Не начинать архитектуру, native references или весь gate заново без причины.
