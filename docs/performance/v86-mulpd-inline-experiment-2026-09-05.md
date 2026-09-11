# MULPD: изолированный эксперимент

Текущий итог продолжения: скалярный вариант с исправленным порядком операндов интегрирован; см. `v86-mulpd-lowering-order-2026-09-05.md`. Описанные ниже первоначальный unguarded и guarded варианты остаются экспериментальными.

Цель — убрать следующий частый вызов хелпера после MOVHPS/MOVLHPS. Ранее LU census насчитал 224 млн вызовов `instr_660F59`; инструментированные скорости census не используются как perf evidence.

`prepare-sse-move.mjs --mulpd` собирает обе руки из текущих исходников во временных каталогах, сохраняя уже интегрированный MOV-патч. Только кандидат получает `experiments/mulpd-inline.patch`. Shipping не меняется, idx21=0.

Snapshot: `C:/Users/jenis/AppData/Local/Temp/v86-mulpd-j2zd7r/manifest.json`.

- Baseline: `9be80a992f4b137546a0b248f600cdc4ef395a426322b3baca33fe3511569d6b` — совпадает с рабочей MOV-сборкой.
- Candidate: `224542dba5e2c33957da4aac614a134d9a982169d1645187995c224c783faa23`.

Хелпер делает два `source * destination` в f64. Кандидат генерирует эти два умножения и записи непосредственно. Каждая полоса читает оба операнда до записи, включая alias. Memory-форма сначала завершает существующее `gen_modrm_resolve_safe_read128` в scratch, затем меняет XMM. Маркировка FPU/SIMD dirty сохранена. Это сохранение текущего контракта v86, не расширение его поддержки MXCSR.

Первые 39 SSE/flags-проверок прошли на обеих руках: interpreter, idx21 off/on; обычные значения, alias, memory, signed zero, infinity, overflow/underflow и прежние MOV cases. Кандидат проверяется с `V86_INLINE_MULPD=1`, что требует отсутствия импорта MULPD; baseline — с 0.

Дополнительно подготовлены проверки NaN payload/sign/quieting относительно текущего helper-интерпретатора и 32 fault/restart случая (`sse-move-pagefault.mjs --mulpd`, 16 смещений × interpreter/JIT). Они требуют отдельного исполнения; первоначальные 39 PASS их не покрывают. Включение в shipping до этих проверок и оценки результата не разрешено самим состоянием доказательств.

Для первичной оценки направления запущен LU ABBA: `tools/bench-v86/results/mulpd-bytemark-XRz42P`. Это две пары без отдельного A/A floor; даже успешный результат не будет общей perf-приёмкой.

## Результаты и незакрытый контракт

LU ABBA завершён: A=232.65, C=290.28, C=295.75, A=254.49 iter/s. Парные изменения +24.77% и +16.21% поверх MOV-inline baseline. Guest/host clock ratios 0.9985–0.9995, flags readback выполнен, tier2 promotions=0. Между двумя A заметный дрейф; это направление и диапазон наблюдений, не установленная величина общего ускорения.

Обе руки прошли 57 SSE/flags cases и 32 fault/restart cases. Логи `tools/bench-v86/results/mulpd-{contract,fault}-{baseline,candidate}.log`. Fault охватывает все 16 смещений перед unmapped page, проверяет XMM до replay и после, EIP/CR2/EFLAGS/регистры и ровно одну доставку fault из JIT.

**Однако точная NaN-эквивалентность не доказана: кандидат пока не готов к shipping.** Начальная проверка строгого совпадения с интерпретатором упала уже на baseline `mulpd-nan-both-reg/off`. Существующие interpreter и helper-JIT выбирают разные входные NaN. Тест для двух NaN теперь проверяет quieting и принадлежность payload одному из входов; это более слабая проверка, и её PASS не закрывает различие поведения. Для одного NaN сохраняется точное сравнение с интерпретатором.

Сравнение 18 записей NaN между руками выявило 4 отличия (оба NaN × reg/mem × idx21 off/on). Старый JIT выбирает destination: `[2271560481,4294465144,2,4294443008]`; новый — source: `[305419896,2146964020,1,2146959360]`. Остальные записи совпадают. Из совпадения текста `source * destination` нельзя вывести совпадение выбора payload после компиляции. Прежде чем интегрировать, требуется определить требуемую семантику и сохранить её, при необходимости через редкий fallback; затем повторно измерить именно исправленный кандидат. Нельзя принимать текущие проценты как результат ещё не созданного исправления.

## Вариант с защитой non-finite

Новый snapshot `C:/Users/jenis/AppData/Local/Temp/v86-mulpd-qIfpUp/manifest.json`: baseline прежний `9be80a…`, candidate `7f0182a96dc300c61846f434db5a2eefe7fc6fb85003aed1fda28fa0e0e51f1d`. Прежний патч сохранён как `mulpd-inline-unguarded.patch`; основной экспериментальный патч теперь проверяет экспоненты обеих полос обоих операндов и при любом NaN/Infinity вызывает старый хелпер. Копирование reg source в scratch происходит только в fallback и сохраняет by-value ABI/alias контракт. Memory source полностью прочитан до ветвления и любых записей XMM. `if_void/else_/block_end` вызывают существующий `flag_boundary`, поэтому compile-time dirty-состояние idx21 не переносится ошибочно между ветками.

### Корректность

66 SSE/flags cases: прежние случаи + точные cross-artifact NaN comparisons, `0 * Infinity`, NaN alias. 32 fault/restart cases. Конечные входы требуют ноль фактических вызовов MULPD из JIT; non-finite — ненулевой счётчик. Логи: `mulpd-guarded-{baseline-contract,contract,fault}.log` в results. Для строгого сравнения `V86_SSE_REFERENCE` задаёт лог baseline; одной проверки допустимого NaN недостаточно. Прежний unguarded artifact этим сравнением отвергнут на `mulpd-nan-both-reg/off` (`mulpd-unguarded-regression.log`), guarded прошёл. Воспроизводимый полный запуск: `node tools/bench-v86/test-mulpd-snapshot.mjs <manifest.json>`.

### Fixed-work замер исправленного артефакта

Node: `flag-fixed-UyxMtf`, 16 рук, AA/AA/CC/CC/AC/CA/AC/CA, 7 samples × 5 млн итераций, без инструментирования и изменения V8 flags. Все проверки результата/retired/JIT activations прошли. Медианы изменения времени C/A: integer −0.70%, SSE reg −50.77%, SSE mem −45.68%. Все три ядра прошли прежние self ≤3% / spread ≤10%; reg AC-пары −49.68…−53.41%, mem −44.84…−46.86%. Это скорость специализированных циклов, не приложения целиком.

Chrome Worker: `flag-browser-g6POvO`, integer 30 млн, SSE 5 млн. Медианы C/A −4.02% / −50.58% / −45.18%, но **все noise gates FAIL**, общий FAIL: integer spread A/C 29.35/20.48%, reg A/A +5.75/−4.66%, mem C/C −6.23%. Направление согласовано с Node; Chrome-величины не принимаются. Raw и judgement сохранены.

Начата отдельная реальная нагрузка LU+FOURIER ABBA на guarded snapshot: `mulpd-guarded-bytemark-Q547YP`. До её окончания результат не установлен; shipping не менялся.

### Итог LU+FOURIER и решение

Серия завершилась без инструментирования, idx21=0, clock ratios 0.9990–0.9998, tier2 promotions=0:

| Порядок | Рука | FOURIER | LU |
|---:|---|---:|---:|
| 0 | A | 5857.2 | 241.17 |
| 1 | C | 5814.2 | 241.95 |
| 2 | C | 6596.0 | 260.48 |
| 3 | A | 6517.0 | 253.08 |

LU: +0.32% и +2.92%; FOURIER: −0.73% и +1.21%. Значительный LU-выигрыш **этого исправленного кандидата не доказан**. Между парами меняется и контроль FOURIER; отдельного A/A floor здесь нет. Нельзя переносить +16–25% unguarded-варианта на guarded и нельзя заменять результат LU ускорением специализированного SSE-цикла.

Повторяемый cross-artifact runner выполнен: `C:/Users/jenis/AppData/Local/Temp/mulpd-contract-ycmFCm` — обе руки 66/66 contracts + 32/32 fault/restart. Строгий NaN-регрессионный тест остаётся несущим: прежний кандидат не проходит его.

**Решение: guarded MULPD не интегрировать в shipping в текущем виде.** Он сохраняет наблюдаемое поведение baseline, но не подтверждает значительного эффекта на целевой LU-нагрузке. Следующее направление — удешевить сохранение NaN-контракта (например, исследовать эквивалентный SIMD lowering или более дешёвый предикат), после чего снова проверить точные NaN-биты, fault и реальную нагрузку. Причина различия эффекта между микротестом и LU пока не атрибутирована; предположение о цене предиката требует прямого сравнения. Рабочая MOV-inline сборка `9be80a…` сохранена.
