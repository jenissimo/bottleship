# NFSU2: EAGL/HLE candidate после извлечения реального образа

2026-09-12. Offline RE по бандлу пользователя; без запуска игры и без изменения
runtime/HLE-кода. Исходный WGB не изменялся. Новая Ghidra analysis выполнена отдельно
от работающего RE service; последующие чтения проекта — read-only.

## Результат

Найден соответствующий **диспетчер состояний встроенного D3DX Effect runtime**:
`0x00669296–0x0066a1f6`, с цепочкой effect Begin/Pass/End. Это предметный кандидат
для отдельной версии библиотечного HLE, но **существующий NFSU handler 132 несовместим**.
Речь идёт о новом контракте аргументов и состояния, не о расширении wildcard.

Метка «EAGL» в прежнем плане недостаточно точна для этого узла: в NFSU2 есть и EAGL,
и статически встроенный D3DX; найденный объект относится к effect runtime. Точный
релиз D3DX SDK не установлен. Применимость к другим образам этого runtime нужно
проверять отдельно; она не ограничена именем NFSU2 или издателем EA.

## Образ и воспроизводимость

- WGB: `G:/WGB/running/need-for-speed-underground-2.wgb`.
- Manifest entrypoint: `rom/SPEED2.EXE`.
- Извлечённый PE: [SPEED2.EXE](../../tmp/nfsu2-eagl/SPEED2.EXE), 4 788 224 bytes.
- SHA-256: `08577b93d4b954c74679b6387792a9aca6c9434513fbc4eaeffdb343650bb899`.
- Image base: `0x00400000`; `.text` RVA `0x1000`, virtual size `0x381af1`.
- [Provenance](../../tmp/nfsu2-eagl/provenance.json), [manifest](../../tmp/nfsu2-eagl/manifest.json).
- [Ghidra functions](../../tmp/nfsu2-eagl/functions.json): 14 910 функций.
- [Выбранные функции, references и prototypes](../../tmp/nfsu2-eagl/selected-functions.json).

В архиве также есть `nfsu2_v1.2_uk.exe`, но наличие patch installer не доказывает
версию установленного `SPEED2.EXE`. Равенство SHA этого PE и образа из `prof-nfsu2`
не установлено: trace не несёт полного fingerprint guest image.

## Что означали прежние near misses

Все три текущие сигнатуры NFSU дают **0 exact matches** в executable `.text` NFSU2:

| Pattern | Максимальный общий префикс | Первый адрес |
|---|---:|---|
| shader_const_convert | 10 / 60 bytes | 0x006425ae |
| apply_reg_int | 10 / 61 bytes | 0x00704d87 |
| state_token_dispatch | 6 / 79 bytes | 0x00640dd9 |

Два последних результата воспроизводят прежний live census. Но «самый длинный
совпавший пролог» **не является опознанием соответствующей функции**. Нельзя делать
вывод о новом layout целевой функции по случайному кандидату `0x00640dd9`.
Настоящий dispatcher установлен ниже независимо, через вызовы D3D9 и граф effect runtime.
Его frame size — `0x158`, а не `0x338` из прежнего near miss.

Converter и apply_reg_int аналоги пока не локализованы с достаточной уверенностью.
Ноль signatures не доказывает, что в новой версии есть взаимно однозначные аналоги
старых leaf-функций: вычисление могло быть перераспределено.

## Как установлен dispatcher и его происхождение

В `FUN_00669296` есть switch по старшему байту state descriptor и прямые виртуальные
вызовы через device pointer `*(ctx+8)`:

| Класс NFSU2 | Call site | Vtable offset | Эффект |
|---:|---|---|---|
| 1 | 0x00669898 | +0xe4 | SetRenderState |
| 2 | 0x006698b9 | +0x10c | SetTextureStageState |
| 3 | 0x006698e4 | +0x114 | SetSamplerState |

Jump table `0x0066a1f7` содержит 17 классов. Декомпиляция и инструкция `RET 0x0c`
подтверждают три stack arguments и `this` в ECX. Тип `int*` для второго stack argument
в автодекомпиляции вводит в заблуждение: на входе читаются его младшие 16 бит как индекс.

Прямые callers: `0x00668e0d`, `0x006691b1`, `0x0066ac27`. Цепочка:

```text
Effect Begin 0x00664792 -> helper 0x0066404c
Effect Pass  0x0066ace2 -> pass/state walk 0x006691b1
                                    -> helper 0x0066404c
                                    -> state dispatcher 0x00669296
Effect End   0x0066ac27 -> pending-state dispatcher 0x00669296
```

Имена Begin/Pass/End здесь — RE-атрибуция по телам и интерфейсу, не отладочные символы.
Begin возвращает число passes, сохраняет/записывает состояния и выставляет режим 4;
Pass принимает индекс pass и вызывает walk; End завершает pending states и восстанавливает
FP control state. Их vtable slots 65/66/67 находятся в таблице от `0x007b6fe8`.

Особенно сильная привязка: метод `GetDesc` этого же объекта, `0x0065cb66`, возвращает
creator `D3DX Effect Compiler` через указатель `0x00809164 -> 0x007b6dec` и числа
parameters/techniques. Это больше, чем просто присутствие строки D3DX где-то в EXE.

QueryInterface `0x0065b8e8` сравнивает IID
`0f0dcc9f-6152-4117-a933-ffac29c43aa4` и IUnknown. Этот IID отличается от текущего
`ID3DXEffect` descriptor BottleShip (`f6ceb4b3-4e4c-40dd-b883-8d8de5ea0cd5`). Нельзя
назначать названия/ABI методов по современным slot numbers: в текущем descriptor
Begin находится в другом слоте. [Raw vtable](../../tmp/nfsu2-eagl/effect-vtable.json).

Основные тела:
[dispatcher](../../tmp/nfsu2-eagl/decompiled-00669296.c),
[walk](../../tmp/nfsu2-eagl/decompiled-006691b1.c),
[Begin](../../tmp/nfsu2-eagl/decompiled-00664792.c),
[Pass](../../tmp/nfsu2-eagl/decompiled-0066ace2.c),
[End](../../tmp/nfsu2-eagl/decompiled-0066ac27.c),
[GetDesc](../../tmp/nfsu2-eagl/decompiled-0065cb66.c).

## Почему старый HLE не подходит

| Контракт | NFSU current handler/filter | Найденный NFSU2 dispatcher |
|---|---|---|
| Вход | node pointer, stage; this=ECX; RET 8 | два индекса и stage, младшие 16 бит; this=ECX; RET 12 |
| Поиск узла | alias через node+0x64 | parent = ctx[+0x2c] + index0×0x64; state = parent[+4] + index1×0x64 |
| Descriptor | static token table, stride 0x1c | state[+0x58] |
| Значение | node[+0x68] | *(parent[+0] + state[+0x48]) |
| Stage default | stage==-1 -> rawNode[+4] | low16(stage)==0xffff -> u16(state+0x54) |
| Класс sampler | 8 | 3 |
| Число switch cases | 10 | 17 |
| Предварительная работа | контракт старого token node | если state[+0] != 0, есть запись state[0]=state[1], вычисления и вспомогательные вызовы |
| Дополнительное условие sampler | старые gates | при ctx[+0x3c]==1 sampler call пропускается |
| Результат | текущий быстрый путь опирается на известные WBUF stubs | сохраняется фактический HRESULT вызванного метода/вычислений |

Новая версия не сводится к трём другим offsets: существенны indexed storage,
предварительная оценка выражений, изменения dirty state, mode и return contract.
Старый guest filter содержит `RET 8`, старый handler читает прежнюю структуру —
подключить их через новую сигнатуру было бы некорректно.

## Конкретный ограниченный proof

Первая полезная область — **уже вычисленные simple states**, то есть `state[0]==0`
и class 1/2/3. На этом пути исходная функция идёт прямо к switch, без предварительной
записи и evaluator calls. Это проверяемая гипотеза ускорения, не готовый shipping guard.

1. Библиотечный recognizer для версии: сверить entry CFG, индексирование, структуру
   switch/calls и ABI. Не ветвиться по имени игры/адресу; нынешние адреса — RE-данные.
2. Разрешить индексы и stage с исходными truncation/default semantics. Сохранить
   memory/fault contract и mode-specific no-op sampler.
3. В fast path входить только для известного D3D9 device/stub contract, согласованных
   shadows, доступных диапазонов и корректного состояния записи. `ctx+8` нельзя
   считать постоянным device: Begin временно меняет это поле.
4. Переиспользовать общую инфраструктуру setter/shadow/ring, но написать новый decoder
   и фильтр аргументов. Dirty/evaluator/непроверенные классы — original до любых
   побочных эффектов, без повторного исполнения уже сделанных записей.
5. Differential на captured inputs: HRESULT, touched memory, logical D3D calls,
   record/replay modes, aliases/faults/declines и guest accounting. Только затем A/B.

Нужный короткий census: calls по class, доля `state[0]==0`, значения mode, original
time по пригодным путям, длины проходов и decline reasons. 98.6% неэффективных TSS
в предыдущем NFSU2 отчёте не доказывают такое же coverage этого конкретного пути.
Весь Begin/Pass/End или shader/preshader evaluator первым целиком не заменять.

## Связь с имеющимися трассами и границы вывода

В `nfsu2-detail.json` горячий entry `g0066404c@t879` занимает 4.455% времени worker.
`0x0066404c–0x006641a6` в извлечённом образе — effect helper, вызываемый Begin и
pass/state walk. Это конкретная связь направления с горячим адресом, **не доказательство,
что именно эта исходная функция стоит 4.455% или что dispatcher имеет такой бюджет**:
Wasm module включает несколько guest regions, а SHA trace image не зафиксирован.

Предварительный осмотр самого дорогого entry `0x00575340` обнаружил другой класс:
нормализация строки (ASCII upper-case, slash -> backslash), с повторным вызовом helper
в условии цикла. Это отдельная зацепка для guest-region анализа, не часть доказательства
EAGL/D3DX и не измеренные 5.3% стоимости этого loop.

Итог: отсутствие образа устранено, адрес и новый контракт state dispatcher найдены,
reuse текущего handler отвергнут по конкретным инструкциям. Кандидат узкого HLE есть;
его dynamic coverage, корректность реализации и игровой uplift ещё не измерены.
