# idx21: точные контракты FP-хелперов

Эксперимент продолжает `v86-x87-broader-check-2026-09-05.md`. Shipping idx21 остаётся **0**. Кандидат собран отдельно; production Rust/Wasm не заменены. Pair guard из предыдущего эксперимента здесь не применяется.

## Изменение

При idx21=1 не включённый в whitelist вызов публикует dirty flag words и после вызова перезагружает пять слов. Ряд FP-хелперов не читает и не меняет арифметические флаги. Для них эта синхронизация избыточна.

Проверены тела функций и вызываемые функции в `cpu/fpu.rs`, `cpu/instructions.rs`, а для преобразований также scratch-аргументы в `codegen.rs`. В `flag_spill_whitelisted` добавлены ровно 17 имён:

- `fpu_get_sti_jit`;
- `f32_to_f80_jit`, `f64_to_f80_jit`, `i32_to_f80_jit`, `i64_to_f80_jit`, `f80_to_f32`, `f80_to_f64`;
- `fpu_fadd`, `fpu_fmul`, `fpu_fsub`, `fpu_fsubr`, `fpu_fdiv`, `fpu_fdivr`;
- `fpu_push`, `fpu_pop`;
- `instr16_D9_6_reg`, `instr16_D9_7_reg`.

Они меняют FPU/SW/softfloat status либо выделенную scratch-область. Нынешние FPU exception helpers устанавливают SW, но не доставляют x86 interrupt. Изменение этого контракта потребует пересмотра whitelist. FCOMI/FCOMIP пишут EFLAGS, FCMOV зависит от них; общее правило `fpu_*`/`instr_*` было бы ошибкой. Группа FNINIT также не добавлена: другие варианты её диспетчера могут вызвать UD.

Воспроизводимая сборка: `node tools/bench-v86/prepare-flag-contract.mjs`. Сохранённый патч: `tools/bench-v86/experiments/flag-helper-contract.patch`.

## Артефакты

Snapshot: `C:/Users/jenis/AppData/Local/Temp/v86-flag-contract-jzXFrt/manifest.json`.

| Артефакт | SHA256 |
|---|---|
| Baseline Wasm | `c361f2470422fd83814a293a6f946598c2cfa67707e6f5dd357a6e6306a19b84` |
| Candidate Wasm | `9d206ff39386a543bf88bffcacff80f209e662e70814f38aac32bae9ac68c07b` |
| Baseline wasm_builder.rs | `284948589e2e6b73161713558b9d6fc77bf15deaecd717a32973deed42e81053` |
| Candidate wasm_builder.rs | `17e1810c0a76f426d060a4efa91f2a88e535e8e645029781f73e8696a533e8ee` |

## Корректность

`vendor/v86/tests/flag-helper-contract-diff.mjs`: **68 PASS**. Каждая из 16 операций D9 F0..FF исполняется после ADD с известным набором OF/SF/AF/PF; PUSHFD наблюдает флаги. Есть отдельный FCOMI writer case. Матрица strict/relaxed × idx21 OFF/ON, 100000 итераций в каждом случае. Проверяются число итераций, отсутствие ошибки, наличие JIT-модулей и импорт тестируемой группы D9. Это проверка арифметических EFLAGS вокруг вызовов, а не полный контракт всех 17 функций.

`V86_WASM_PATH=<candidate> V86_FLAG_LOCALS=1 node vendor/v86/tests/fpu-relaxed-diff.mjs`: **all variants match**. Лог: `C:/Users/jenis/AppData/Local/Temp/flag-contract-fpu.log`. Переменная `V86_FLAG_LOCALS` добавлена в тест; по умолчанию остаётся 0.

Чувствительность проверена мутацией: `prepare-flag-contract.mjs --mutate-fcomi` намеренно добавляет `fpu_fcomi` в whitelist. Сборка `9387b3e8037a3eb4644bef227e44906a9410712ae8821e0ec8841154cb150a75` из `C:/Users/jenis/AppData/Local/Temp/v86-flag-contract-TZdAbR` ожидаемо **FAIL**: opcode DB F1, strict, idx21=1, error mask 2260 (`0x8d4`), ровно 100000 итераций и один JIT-модуль. В тесте также проверяется импорт `fpu_fcomi` для strict writer case. Повтор правильного кандидата с усиленной проверкой — **68 PASS**.

## Измерение

Кампания `tools/bench-v86/results/flag-contract-6ui2mL`, команда `node tools/bench-v86/run-flag-contract.mjs <snapshot-manifest>`. SHIPPING_JIT, relaxed=1, fresh Node/fs boot на руку. A=shipping idx21=0, B=текущий dirty-word idx21=1, C=кандидат idx21=1. Порядок **A B C C B A**, по два прогона, без отбора. Четыре теста: NUMERIC SORT, BITFIELD, FOURIER, LU. Конфигурация проверяется readback, guest/host clock ratio сохраняется в raw JSON.

Все шесть рук завершились:

| Порядок | Рука | NUMERIC SORT | BITFIELD, млн | FOURIER | LU |
|---:|---|---:|---:|---:|---:|
| 0 | A shipping | 720.11 | 273.73 | 5687.0 | 190.20 |
| 1 | B locals | 890.72 | 343.83 | 5610.1 | 180.01 |
| 2 | C contracts | 899.10 | 347.40 | 5977.3 | 189.52 |
| 3 | C contracts | 886.79 | 343.09 | 5735.6 | 184.98 |
| 4 | B locals | 816.71 | 315.11 | 5251.7 | 171.29 |
| 5 | A shipping | 743.35 | 263.23 | 5940.7 | 191.76 |

| Тест | C/A, отношение средних | C/B, отношение средних | Соседние пары C/B |
|---|---:|---:|---|
| NUMERIC SORT | +22.03% | +4.60% | +0.94%, +8.58% |
| BITFIELD | +28.59% | +4.79% | +1.04%, +8.88% |
| FOURIER | +0.73% | +7.84% | +6.55%, +9.21% |
| LU | −1.95% | +6.60% | +5.28%, +7.99% |

Это описательная статистика N=2, не доверительный интервал. Второй B медленнее первого на всех четырёх тестах; drift существенен. C/A по отдельным половинам для FOURIER **+5.10%, −3.45%**, для LU **−0.36%, −3.54%**. Все результаты сохранены, выбросы не исключались. Guest/host clock ratio 0.9975–0.9998, конфигурация подтверждена, tier2 promotions=0.

## Вывод

Точный whitelist даёт положительное направление относительно прежнего idx21 в обеих соседних парах, включая FP. Integer-выигрыш к shipping сохраняется. FOURIER приблизился к shipping, но знак C/A меняется; LU всё ещё ниже shipping в обеих половинах. Поэтому тезис «все FP-потери idx21 устранены» не подтверждён.

Это guest-timed BYTEmark, без отдельного A/A floor и без браузерного acceptance. Общий значительный прирост v86 не доказан, idx21 остаётся OFF. Следующий шаг — fixed-work mixed integer/FP workload с проверкой EFLAGS/результатов и A/A floor, затем браузер. Для атрибуции остатка стоит отдельно измерить загрузку пяти слов на входе в модуль и консервативный `flag_boundary`; текущий эксперимент их не меняет. Комбинировать изменения до такого замера нельзя считать доказательством их индивидуальной пользы.
