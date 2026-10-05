# SSE helper contracts и следующий кандидат MOVHPS

Продолжение `v86-flag-fixed-work-2026-09-05.md`. Предыдущий goal turn дал прогресс: census выявил два доминирующих SSE-хелпера LU, подготовлен кандидат и регрессии. Shipping не изменён, idx21=0. Значительный общий прирост v86 пока не доказан.

## Обычный LU после census

Raw: `tools/bench-v86/results/flag-contract-zlkBFJ`. Счётчиков вызовов в этой серии **нет**. Fresh Node/fs boot, SHIPPING_JIT, relaxed=1, только DOLU. Порядок A B C C B A; A — shipping `c361f247…`, idx21=0; B — предыдущие 17 FP-контрактов `9d206ff3…`, idx21=1; C — 19 контрактов с двумя SSE-функциями `ab10ee47…`, idx21=1. Полные хеши/пути в manifest и предыдущем отчёте.

| Порядок | Рука | LU iter/s |
|---:|---|---:|
| 0 | A shipping | 190.10 |
| 1 | B FP contracts | 178.57 |
| 2 | C FP+SSE contracts | 187.96 |
| 3 | C FP+SSE contracts | 205.52 |
| 4 | B FP contracts | 189.57 |
| 5 | A shipping | 197.05 |

Соседние C/B пары: **+5.26%, +8.41%**. C/A по половинам: **−1.13%, +4.30%**. Отношение средних C/A около **+1.64%**, C/B около **+6.88%**. Guest/host clock ratios 0.9993–1.0005; readback конфигурации проходит; tier2 promotions=0.

N=2 на руку, A/A floor отсутствует, C расходится между запусками примерно на 9% от среднего. Из этого нельзя объявлять надёжный выигрыш к shipping. Направление C/B согласовано, то есть census дал полезную точку оптимизации, но возвращение к baseline не достигает цели значительного прироста.

## SSE fixed-work

Подготовлены `flags-sse-reg` и `flags-sse-mem` в общем Node/browser workload. На итерацию четыре группы ADD → MOVLHPS/MOVHPS → MULPD → ADC. Проверяются EDI=4N, обе SIMD lanes, SW, ESI/ECX, фактический retired и JIT activations; импорты проверяют нужные helper paths. MOV high source равен −1, нижняя lane меняет знак на каждом MULPD, верхняя возвращается к 1. Четыре группы дают [1,1] в конце.

Одноразовая настройка CR4 перенесена перед входом измеряемого фрагмента. Первая версия повторяла её внутри setup и обоснованно не проходила ограничение JIT entries из-за дополнительных выходов. После переноса первый rerun открыл новый JIT entry: это обнаружил запрет компиляции в measurement. Прогрев теперь явно отделён от измерения: фиксированные три warmup по 1 млн с сохранёнными `compiledDuring` и yield между ними. В **samples** запрет новой компиляции и прежний loop-entry envelope сохранены. Это изменение протокола; старые и новые серии нельзя смешивать.

Оба SSE ядра прошли smoke и сверку с интерпретатором на кандидате 19 contracts. Полная perf-серия ещё не запускалась. Setup=8, body=23, end=8; retired = 23N+16.

## Inline MOVHPS/MOVLHPS

Census также указывает более прямую возможность: убрать сам вызов `instr_0F16`, а не только синхронизацию idx21. Создан изолированный `prepare-sse-move.mjs`, который меняет только `jit_instructions.rs` относительно shipping. Никаких новых контрактов/настроек idx21 в этом кандидате нет.

Три entry point: MOVHPS memory, MOVLHPS register и MOVHPD memory. Memory path сохраняет `gen_modrm_resolve_safe_read64`; store пишет только верхние 64 бита XMM после успешного чтения. Register path читает исходные нижние 64 бита до записи верхних, включая alias source=destination. Dirty marker сохраняется. Недопустимая register-форма с 66 prefix остаётся UD. Это та же схема, которую соседний MOVLPS уже использует для нижней половины.

Snapshot: `C:/Users/jenis/AppData/Local/Temp/v86-sse-move-AtWvKW/manifest.json`.

| Артефакт | SHA256 |
|---|---|
| Baseline Wasm | `c361f2470422fd83814a293a6f946598c2cfa67707e6f5dd357a6e6306a19b84` |
| Candidate Wasm | `9be80a992f4b137546a0b248f600cdc4ef395a426322b3baca33fe3511569d6b` |
| Baseline jit_instructions.rs | `1a74625df8cf6e3d8671d2860f575c3f59205dfec1a518dedad7bb790ae2bca7` |
| Candidate jit_instructions.rs | `e60d168eb4d0703085476e907566e1f49a82bf9c1224575d38792825160472b2` |

`V86_INLINE_SSE_MOVE=1 V86_WASM_PATH=<candidate> node vendor/v86/tests/sse-flag-contract-diff.mjs`: **27 PASS**. Добавлены MOVHPD memory, negative zero и точное копирование NaN payload/signaling bits. Проверяется отсутствие MOV-хелпера в реально сгенерированных JIT-модулях и наличие прежнего MULPD-хелпера. Интерпретатор/idx21 OFF/ON, 100000 итераций.

Fixed-work SSE smoke при **idx21=0** проходит с абсолютными результатами и отсутствующим импортом MOV. Raw: `tools/bench-v86/results/sse-move-smoke.json`; один короткий sample на ядро — только корректность, не performance evidence. Понадобятся fault/cross-page проверки и полноценный A/B этого кандидата. Shipping остаётся нетронутым.
