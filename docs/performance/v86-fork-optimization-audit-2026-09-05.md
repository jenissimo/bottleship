# Аудит оптимизаций форка v86 — 2026-09-05

## Объём и база сравнения

Инвентаризация изменений относительно `11cf7dd926c5901309e7df0d34905c9a21ad4d89`, аудит CPU/JIT до `443a22114e66`, включая включённые, выключенные и безусловные изменения. Это целевая проверка исходников и adversarial probes, не доказательство корректности всего форка. В `src` относительно базы 32 изменённых файла, 15127 добавлений / 1151 удалений; туда входят HLE, диагностика и исправления, а не только оптимизации.

Аудит выполнялся без изменений production-кода и без включения флагов продукта. Другой агент во время проверки изменил `wasm_builder.rs` и пересобрал бинарь. Для deadflags повторный repro закреплён на извлечённом `HEAD:build/v86.wasm`: SHA256 `9383487b438f28cfee98e623d550b0131ea4b240191aedbd468f21fddd594a4a`. Нельзя переносить результаты на параллельную новую сборку без повторения.

**«Все флаги OFF» не равно original-v86.** В форке остаются DOD dispatch, helper-free AbsoluteEip, SSE, JS view caching, HLE и другие изменения. Shipping authority: `tools/jit-config/shipping.mjs`; idx0–3 были upstream. GPR locals и предшествующие локальные flag peepholes также уже были upstream.

## Подтверждённые дефекты

### P1 — dead-flag elimination теряет флаги на выходе по бюджету

> **ИСПРАВЛЕНО** — переход по ребру в голову цикла больше не считается доказательством;
> регрессия `bun run test:dead-flags` (12/12, до исправления 9/12).
> Отчёт: `v86-p1-fixes-deadflags-x87-2026-09-05.md`.

Shipping idx5=1. Cross-block анализ (`vendor/v86/src/rust/jit.rs:2419`) считает флаги мёртвыми до следующего writer, но не учитывает вставленный loop-safety exit на входе в successor (`jit.rs:5358`). Выход возможен до writer: опубликованные флаги должны принадлежать предшествующей инструкции.

Реальный сгенерированный Wasm, idx5 OFF/ON, одинаковые EIP `0x100054`, EAX `33334`, ECX `988889`: EFLAGS **0x6 против 0x2**, потерян PF. Повторено на закреплённом HEAD-бинаре; pad sweep 0..11 даёт расхождение на 0/9/10. TEMP repro: `%TEMP%/audit-deadflag-budget.mjs`, запуск `node` с этим файлом. Он прогревает настоящий JIT, захватывает модуль и сравнивает состояние на его budget exit.

Исправление должно сделать все генерируемые выходы наблюдателями флагов либо материализовать необходимое состояние на таком ребре. Регрессия обязана сравнивать флаги на самом выходе и при продолжении, а не только результат завершившегося цикла. Это отдельный механизм от `dead-flag-stores` нового optimizing translator.

### P1 — relaxed x87 inline читает освобождённый ST как число

> **ИСПРАВЛЕНО** — предикат inline-пути требует ещё и «регистр не пуст»; регрессия —
> вариант `fadd_empty_src` в `fpu-relaxed-diff.mjs`. Стоимость измерена и атрибутирована
> (−4.9% FOURIER, −8.2% LU). Отчёт: `v86-p1-fixes-deadflags-x87-2026-09-05.md`.

Relaxed FPU включён продуктом по умолчанию (`preemption-manager.ts:29`). `gen_fpu_relaxed_tag_ok` (`codegen.rs:3644`) проверяет представление значения, но не `fpu_stack_empty`.

Последовательность `FLD1; FLD .75; FFREE ST0; FNCLEX; FADD ST1,ST0` в differential probe: JIT получает **1.75, SW=0x3000**, интерпретатор — **NaN, SW=0x3041** (SF|IE). Strict режим совпадает; relaxed расходится как с idx10=0, так и с idx10=1. Около 752939 fast hits доказывают выполнение inline-пути. TEMP: `%TEMP%/v86-fadd-empty-audit.mjs` (адаптация `fpu-relaxed-diff`). Это нарушение обработки empty stack, а не разрешённая разница точности f64/80-bit.

### P2 — sampling приписывает горячесть неверному модулю

`jit.rs:2552–2571`, аналогичная генерация `4249–4295`: глобальный tick выбирает каждое 32-е ребро и выдаёт выбранному модулю credit32. При периодическом потоке фаза не меняется.

Live-Wasm probe: 3200 успешных resolver hits, два живых модуля строго чередуются. Фактически **1600/1600**, `jit_get_module_entry_total` выдаёт **0/3200**. TEMP: `%TEMP%/v86-controlflow-sampling-audit.mjs`. Влияет на census и выбор кандидатов, не на retired-instruction promotion. Для точного census нужен idx27=1; production sampling требует другой схемы либо честной маркировки ограничений.

### P2 — fastmem write watch пропускает JIT stores

Idx19 OFF в shipping. Watch bit переводит store в `safe_write_slow_jit`, но in-page RAM branch (`cpu.rs:4223–4230`) возвращает host offset; последующий inline store обходит `dbg_check_write`. Комментарий `cpu.rs:469` обещает обратное. При 100000 stores и реально активном compiled path получено только 83335 watch hits. Reset/rebuild дополнительно теряет watch bit (map5 → map1). TEMP: `%TEMP%/v86-write-watch-audit.mjs`. Это дефект диагностического watch-контракта; неверное guest RAM значение этим тестом не показано.

### P2 — read-TLB stats UI неверно требует DISPATCH_STATS

`src/worker/core/debug/dbg-commands.ts:1341` отказывается читать статистику при DISPATCH_STATS=0, хотя mode>=2 считает независимо (`codegen.rs:779–785`, `profiler.rs:266`). Probe: DISPATCH_STATS=0, idx29=2, hits=39998, fills=39998, correctness PASS. TEMP: `%TEMP%/v86-read-tlb-audit.mjs`. Mode1 действительно не считает: старый отрицательный результат нельзя автоматически объявить неверным без его конфигурации.

## Каталог механизмов и покрытие

| Механизм поверх базы | Shipping | Результат проверки |
|---|---|---|
| Cross-block dead flags idx5 | ON | Подтверждён P1 на budget exit |
| Push-run coalescing idx11 | ON | Cache lifetime/fault ordering просмотрены; нового воспроизведённого дефекта нет. Даже одиночный PUSH оплачивает cache machinery; marginal вклад не переизмерялся |
| Arithmetic flag locals idx21 | OFF | Без liveness: пять загрузок на входе, spill/reload вокруг helpers; отрицательный результат относится к этой реализации |
| Relaxed x87 inline | ON | Подтверждён P1 empty-stack; не только вопрос precision |
| x87 stack locals idx10 | OFF | Write-through cache: mantissa/tag stores остаются, TOP/address вычисляется до hit; это не устранение x87 stores |
| x87 precision-control local idx31 | ON | Старый uplift был связан с неправильной PC initialization; старые числа непригодны |
| SSE scalar/SIMD и integer/bitwise inline | Без общего OFF | Наши e593721b/33f4e730: lane preservation, aliasing, shift fallback просмотрены, sse3-absolute PASS; полный nasm corpus не запускался |
| Direct block chaining idx4 | OFF | Existing live regression PASS, budget/HLT/missing/refuse/accounting |
| RET chaining idx12 | ON | Resolver/memo просмотрены, jit-alive PASS |
| RET speculation idx13/14 | ON / 24 | Runtime target guard и bounded traversal просмотрены; отдельного adversarial repro нет |
| Indirect regions idx6/7/8 | OFF / 5 / 8 | PIC regression PASS, реально создана двухстраничная region |
| Tier2 idx15/16/17 | OFF / 96 / 8 | Replacement PASS: 260 promotions, 4 evictions; disable clears cache |
| Chain accounting idx20/27 | ON / 32 | Подтверждён biased census; retired accounting checks PASS |
| RET memo idx25/26 | 9 / OFF | Epoch invalidation просмотрена; wrap/recycle stress не выполнен |
| Branch hints idx22/23 | 1 / 0 | Metadata/offsets просмотрены; browser consumption и uplift не подтверждены этим аудитом |
| DOD dispatch / helper-free AbsoluteEip | Always-on | Lookup/unpublication просмотрены; полный SMC/paging stress не выполнен |
| AOT publication | Отдельный API | Transaction contract PASS; это не то же, что новый translator |
| Fastmem writes idx19 | OFF | Подтверждён дефект watch; свежего принятого uplift нет |
| Read micro-TLB idx29/30 | OFF | Slow scratch не кэшируется, existing correctness PASS; ошибка чтения census выше |
| Permission/read map | OFF / отдельный экспорт | Старые differential revocation проверки описаны; FC live A/B не превысил noise. Removed read-map имел OFF regression |
| Raw stack-page experiment | Diagnostic only | Только unsafe 32-bit reads, guard не реализован; не production optimization |
| Cached TypedArray proxy | Always-on | Рост Wasm memory, индексация и method binding проверены Node: PASS |
| Direct MessageChannel yield | Включается worker | Инвентаризирован; отдельного lifecycle/perf теста здесь нет |
| Lazy FPU/SIMD dirty tracking | Отдельная интеграция | Инвентаризирован; полный context-switch differential здесь не выполнен |
| Wasm WinAPI/CRT hypercalls | Отдельная интеграция | Таймеры, TLS/FLS, sync, строки/память, math, heap, RTTI, park/resume: каталог, не полный аудит контрактов |
| Engine HLE / D3D9 kernels | Отдельная интеграция | Инвентаризированы как замещение guest work; требуют самостоятельного ledger/decline/rollback аудита |
| Upstream optimization/correctness ports | Разные | Prevalidated helpers/page-fault cleanup и прочие cherry-picks отделять от собственных изобретений |

Idx24 — wrong-entry diagnostic refusal, idx28 — module names; это не самостоятельные ускоряющие проходы. Idx9/18 retired. Менять budgets вместе с feature toggle — не измерять marginal вклад feature.

## Что говорят отрицательные результаты

1. x87 locals сохраняют backing stores. Их отрицательный результат не опровергает иной register-resident lowering с доказанными точками публикации.
2. Flag locals idx21 сеют все пять слов и делают пять stores + пять loads вокруг не-whitelist вызовов (`wasm_builder.rs:1283`, `jit.rs:4506`). Часть чистых helpers потенциально допускает менее дорогой контракт, но whitelist нельзя расширять без проверки каждого helper. Глобальное OFF не доказывает бесполезность liveness-aware варианта.
3. Permission map дал разнонаправленный FC A/B на фоне шума; synthetic heapwalk win не становится общим browser uplift. Raw stack эксперимент покрывал узкую форму чтений.
4. Старые заявления о PC-local speedup были загрязнены некорректной инициализацией. Отчёт о новом translator ошибочно приписывал shipping v86 включённый idx21: фактически он OFF.
5. Новые translator `dead-flag-stores`, scoped-memory и flags-in-locals — отдельные реализации. Его текущие Node улучшения пока сокращают отставание от shipping JIT, а не показывают выигрыш над оригиналом.

## Следующие действия

Сначала исправить и закрепить двумя regression tests production P1 deadflags/x87. Затем исправить census перед выбором новых hot targets. Отдельно закрыть diagnostic watch и UI stats. Не включать отвергнутые оптимизации только потому, что обнаружены недостатки их реализации.

Для performance-аудита каждой группы нужны shipping-minus-one и original-vs-fork на закреплённых build/config hashes, свежих парных arms с одинаковым выполненным guest work, raw N/spread и workload-specific noise floor. «Add-one поверх all-off» отвечает на другой вопрос. В этом аудите новые performance claims не принимались.

Полная инвентаризация CPU-направлений выполнена; исчерпывающий аудит всех HLE/graphics обработчиков и всех взаимодействий оптимизаций не выполнен. Зелёные перечисленные проверки относятся только к покрытым сценариям. TEMP probes необходимо оформить постоянными regression tests при исправлении.

## Дополнительная проверка и воспроизводимость

`fpu-relaxed-diff.mjs`, `fpu-absolute.mjs`, `sse3-absolute.mjs` прошли на исходном бинаре с SHA256 `9383487b438f28cfee98e623d550b0131ea4b240191aedbd468f21fddd594a4a`. Новый empty-binop probe показывает пробел существующего зелёного suite. Запуск x87-контрпримера: `node "$env:TEMP/v86-fadd-empty-audit.mjs" fst_empty_src`; SHA256 скрипта `FCBBE490FF4D9B81C532EE8E00C393BA5D7937734AAD99B79AC311EF72CA75DD`. Watch probe SHA256 `707BF035FD283C1DB4FD3B17C14B85CDE9DA62341B58A9DC454AD5095D2095E1`; аргумент `reset` проверяет потерю watch bit.

Push-run кеш живёт весь basic block и не инвалидируется после промежуточных slow helpers. Корректность зависит от отсутствия изменений permissions/HAS_CODE кешированной страницы внутри блока. Это уже отмечено в `plan/aot-module-contract.md` N110/O19; в данном аудите контрпример не найден, поэтому это незакрытый контракт, а не подтверждённый баг.

Permission mirror обновляется каждым `set_tlb_entry()` даже при выключенных read probes (`cpu.rs:339`). Одинаковый OFF emitted code не доказывает нулевую стоимость механизма относительно upstream: runtime maintenance остаётся. Регрессия времени здесь не измерялась.
