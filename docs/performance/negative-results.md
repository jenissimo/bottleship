# Performance negative-results registry

Этот файл append-only хранит гипотезы, которые были измерены и не получили положительного
сигнала. Новое измерение не переписывает старое: оно добавляется отдельной датированной
записью с собственным environment envelope. Это важно для результатов, зависящих от V8,
драйвера и host microarchitecture.

Правило записи: workload/bundle SHA, baseline/candidate arms, все raw values или ссылка на
raw artifact, `N`, median/spread, correctness ledgers, browser/GPU/driver/power plan и решение.
Если поле не было сохранено, пишется `not recorded`; оно не восстанавливается догадкой.

## 2026-09-01 — FC Rebench campaign

Общий environment envelope для всех записей этого раздела:

- BottleShip base commit: `17a491d`, `vendor/v86@92d172ca80d1faee0643b5b906b7337f7685a291`,
  оба с незакоммиченным campaign diff;
- bundle SHA-256: `fa6cd035f46dbefa50076cce2712d145699f5a86ecd6de190c424d79fd9ab3d8`;
- host: AMD Ryzen 9 7900X3D, 12C/24T;
- GPU: NVIDIA GeForce RTX 3090, driver `32.0.15.9597` / 595.97;
- OS: Windows 11 Pro build 26200;
- browser: Google Chrome `153.0.8010.12`, dedicated harness profile;
- power plan: Balanced (`381b4222-f694-41f0-9685-ff5bb260df2e`);
- campaign noise floor: approximately 3.6%; clocks/thermals were not recorded.

| Гипотеза | Arms и наблюдение | Evidence quality | Решение |
|---|---|---|---|
| Structural pipeline MRU на 16 identity words | mixed medians 56.927 vs 58.244 FPS; candidate −2.3% | внутри noise floor; raw values/`N` not recorded | удалён: дополнительная сложность не получила положительного сигнала |
| Read micro-TLB | отрицательный или нейтральный CPU signal | raw values/`N` not recorded | default off; повторять только при новом host engine или иной локальности |
| Precision-control cache на весь basic block | CPU median около 100.3 против 104.1 FPS у short-run scope | raw values/`N` not recorded; magnitude выше noise floor | удалён; short arithmetic-run scope оставлен |
| Branchy conditional x87 rounding | CPU median около 99.9 FPS против более быстрого branchless shape | raw baseline/spread/`N` not recorded | удалён |
| Более крупный Tier-2 сам по себе | не соответствовал текущему hot shape и не пересёк потолок | qualitative campaign result; raw values not recorded | deprioritized ниже x87/memory specialization |

Интерпретация ограничена указанным Chrome/V8 и host. В частности, вывод о том, что несколько
JS comparisons проиграли оптимизированному string `Map`, не считается вечным свойством JS.

### Invalidated measurements — не использовать как perf evidence

| Измерение | Причина invalidation | Решение |
|---|---|---|
| x87 PC-local +4.7–6.2% | найден slow→fast lexical-run path с чтением неинициализированного PC local; workload не покрывал mixed tags | исправить correctness, добавить differential, измерить заново |
| Prefix MegaRun ON/OFF | compact-OFF legacy executor теряет отдельный prefix draw, то есть OFF выполняет меньше работы | старые arms удалить из causal accounting; повторить после `pairs + prefix` gate |
| `executedDelta == 0` на MegaBatch/render-bundle | executed counter копирует expected pairs | не использовать как доказательство исполнения |
| x87 opcode census 52.44% | profiler-build provenance/hash не сохранён; shipping stub возвращает нулевой buffer | quarantine до profiler artifact self-test |

### Default flips without an accepted arm

Переключены в default-on в campaign diff без записанного same-work A/B. Не отрицательные
результаты, а отсутствие evidence: по PERF EVIDENCE RULE до измерения они считаются
неатрибутированными изменениями поведения, а не принятыми оптимизациями.

| Флаг | Что меняет | Статус |
|---|---|---|
| `__d3d9ProgBindFastKey` | кэш bind-group по компактному ключу вместо полной identity | default-on, verify oracle есть, arm not recorded |
| `__d3d9FastDrawAttribution` | атрибуция draw по compact identity без повторного resolve | default-on, arm not recorded |
| `__d3d9CompactMegaRun`, `__d3d9CompactMegaRunStorage` | compact descriptor / storage path вместо legacy arena rows | default-on; ранняя запись «~57.83 FPS как default» относится к более старой форме и не является same-work A/B с текущей |

### Additional campaign negatives with incomplete raw retention

Эти записи предотвращают случайное повторение идей, но не содержат достаточного raw protocol
для точной оценки величины эффекта:

| Гипотеза | Наблюдение | Решение |
|---|---|---|
| Generic x87 locals | отрицательный сигнал относительно более узкого scope | не возвращать без нового run-boundary design |
| Generic direct chaining | не дал устойчивого end-to-end выигрыша | не принимать без hot-edge census |
| Fastmem writes | не дал устойчивого выигрыша при требуемых correctness guards | оставить off |
| Broad indirect regions / высокий `MAX_PAGES` | layout/code-size pressure и отрицательный/нейтральный сигнал | только узкие evidence-selected regions |
| 1 MiB read map | runtime-OFF baseline уже регрессировал из-за layout/allocation | механизм удалён; disabled-path parity обязательна |
| Read micro-TLB | около 27.4% hit rate, недостаточно для стоимости lookup | default off; сначала offline trace simulation |
| Generic inline WBUF | codegen вырос примерно до 141k units, наблюдалось около 6.3 FPS | удалён; специализировать только top callsites |
| RenderBundle variants | положительного end-to-end сигнала не подтверждено | не включать без submit/encoder attribution |
| Bulk counters / unused FFP fast path | null/шумный end-to-end результат | не усложнять shipping path |
| Consumer-sized pair run | drift/no positive signal | не принимать без paired blocks и sentinel |
