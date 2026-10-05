# NFSU entry validation for v86 performance comparison

## Verified race restart and initial same-arm repeatability

The existing external `C:/Share/nfsu/reverse/oracle/bottleship/restart_race.harness.ts`
sequence was exercised on the owned baseline session: Escape, Down, Enter,
Left, Enter with its menu waits. Screenshots confirm Restart Race and its
default Cancel selection. After acceptance the race pointer changed and the
observed states passed through 0, 3, then 4. The process-global mover counter
did not reset. `logs/v86-app-perf/restart-check-1/` retains all stages and an
explicit key-down/up recording; replay of that recording is not yet verified.

`tools/probes/v86-nfsu-restart-windows.harness.ts` now requires observing state 3
before state 4, then waits for 8000 additional mover updates before a clean
12-second window. It requires bumper classification before/after. This is a
relative phase gate with polling uncertainty, not a deterministic snapshot.

Three consecutive restarts on the same loaded shipping baseline (3a50…) gave:

| Repeat | Mean ms | p50 ms | p95 ms | Updates after observed transition |
|---|---:|---:|---:|---:|
| 1 | 49.90 | 49.00 | 59.50 | 8036 |
| 2 | 49.71 | 48.50 | 59.75 | 8058 |
| 3 | 49.79 | 49.00 | 59.25 | 8058 |

Raw results: `logs/v86-app-perf/restart-baseline-1/results.json`. The interval
bracketing the state transition spans 140, 107 and 144 mover updates. Mean-frame
max/min differs by 0.38% in this small same-session sample, much less than the
earlier cold-entry candidate drift. This does not measure between-boot variation
or prove equal opponent simulation. It supports trying the same restart protocol
on the isolated candidate, with a baseline return, before any integration claim.

The max-detail fixture is `fixtures/nfsu-max`: `Rage.cfg` plus the profile and saves.
Restore with the CLI `bun tools/harness.ts fixture restore nfsu-max`, with explicit
`BS_CDP_PORT` and `BS_TAB` selecting the isolated benchmark browser. The old
`nfsu-aot-ab.harness.ts` uses a DSL fixture call; use the CLI sequence from
`tools/aot/opt/capture-attribution.harness.ts` instead.

## Replay contract correction

`logs/recordings/nfsu-to-race.json` has 52 input samples with millisecond timestamps
ending at 60600.01 ms. It does **not** contain present-frame offsets.
`hostReplay` calls `window.playRecording` (`src/app/App.tsx:2268`), which schedules
successive samples with `window.setTimeout`. `deterministic: true` additionally
sets manual virtual time at each sample; it does not gate input on rendered frames.
The existing attribution script/report's present-serial description is incorrect.

There is a separate worker `record`/`replay` API with `{startSerial, events}` and
`atFrame` fields in `src/worker/harness/cmds/record.ts`. The host JSON is not that
format, and converting milliseconds to frame indices would require evidence that
the original recording did not capture.

Consequently, replay completion or scene motion alone does not establish identical
in-race work. Validate the race state, advancing physics counter, screenshot, and
scene identity before accepting timing. This note contains no new performance claim.

## Current preflight

An isolated Chrome session `v86-app-perf` on port 9357 restored all five fixture files
and started the existing host recording with the installed candidate wasm
`3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a`.
The disposable probe is `tools/probes/v86-nfsu-replay.harness.ts`; result destination
is `logs/v86-app-perf/nfsu-replay-result.json`.

The preflight completed but **failed entry validation**: after 240 seconds,
`racePointer=0`, `raceState=null`, `moverCounter=0`. The screenshot
`logs/v86-app-perf/debug/nfsu-v86-replay.png` shows a letterboxed cinematic,
not an active race. Mean scene motion was 22.478 and every sample exceeded the
attribution script's 0.5 threshold (44.162, 3.122, 19.95, 22.68). Therefore that
threshold would admit this cinematic as an in-race attribution/performance scene.
No FPS result from this preflight is accepted.

The next entry attempt needs an explicit start-state gate before replay and an
in-race state/physics gate after it. Existing recording timestamps alone cannot
establish that the first Enter arrives after the title/menu is ready.

## Confirmed active race

Continuing the same loaded session from the observed title screen with staged
Enter holds reached Quick Race / Circuit, Volkswagen Golf GTI, Olympic Square.
The selected options screenshot shows 2 laps, catch-up On, traffic Minimum,
opponent skill Medium. These are race options, not graphics quality settings.
Selection screenshots are saved under `logs/v86-app-perf/debug/` as
`nfsu-selected-car.png`, `nfsu-selected-track.png`, `nfsu-race-options.png`.

`tools/probes/v86-nfsu-clean.harness.ts` then verified state 4 before and after
a 12-second clean window and an advancing mover counter. The result is
`logs/v86-app-perf/nfsu-clean-candidate.json`, with screenshot
`nfsu-confirmed-race.png`. It contains 200 frame intervals: mean 59.85 ms
(16.71 FPS), p50 56.75 ms, p95 78 ms. This is one candidate-only stationary-car
window; it establishes working gameplay and **does not establish uplift**.

Recording caveat: `record()` was enabled during navigation, but `keyHold` is
explicitly excluded from the recorder (timer release), so the resulting worker
recording has no navigation events. Journals preserve the executed steps, not a
replay-ready frame recording. A subsequent capture must use separate recordable
`key(vk,{down:true})` and `key(vk,{up:true})` calls with present-frame waits,
and must be replay-validated rather than declared repeatable from its format.

## First isolated A/C direction check

`tools/probes/v86-app-proxy.ts` serves the shared dev app through localhost:5175
but substitutes immutable, hash-checked wasm bytes only at `/v86.wasm`.
The same isolated Chrome/tab ran each arm sequentially. Delivery hashes are
in `logs/v86-app-perf/wasm-delivery.log`; the shared public wasm stayed at 3a50….

| Arm | SHA256 prefix | Mean frame ms | p50 ms | p95 ms | Mover counter before → after |
|---|---|---:|---:|---:|---|
| Pre-MOV/MULPD fork | c361f247 | 59.55 | 53.75 | 80 | 14226 → 16638 |
| Current MOV+MULPD | 3a50af7f | 56.45 | 52 | 76 | 14242 → 16756 |

Both windows passed state 4 before/after with advancing physics. Both used the
bumper camera at the Olympic Square starting grid; do not compare these to the
earlier third-person candidate-only window. Each fresh entry took 15 iterations,
recorded 30 explicit key down/up events, and waited 12 seconds before the clean
12-second window. Raw windows and recordings are in `baseline-entry/` and
`candidate-entry/` under `logs/v86-app-perf/`. All five persisted fixture files
were read back after each run and matched the max-profile fixture byte-for-byte.

This single sequential pair gives **+5.49% frame throughput direction**, not an
accepted magnitude: there is no reverse-order pair or A/A noise floor yet, the
navigation loops were adaptive rather than replaying one recording, and game-time
phase is not fixed-work. Do not infer a broad NFSU uplift from this pair.

Harness issues exposed and handled:
- Restoring while the guest holds OPFS writers fails. Reload to stop the guest,
  then restore and check success, then boot. An initial candidate attempt after
  a failed restore was explicitly stopped and discarded before its window.
- Worker `shot.saved` is an intended sidecar path, not an acknowledgement that
  the file exists. On the proxy origin the baseline's sidecar images were absent;
  its in-race view was inspected via a direct CDP screenshot. The probe now writes
  returned PNG bytes locally and checks them, so candidate entry images exist.
- The new frame recording has real events, but replay repeatability is still
  unproven. Do not label it a validated deterministic benchmark yet.

## Reverse pair and residual CPU profile

`tools/probes/v86-nfsu-reverse-pair.ts` completed C then A, restoring the fixture
after stopping each guest and failing on any preparation error. Both arms passed
active-race checks and five-file fixture readback. Images were written locally
and inspected: same bumper camera, Olympic Square starting grid, stationary car.

| Chronological arm | Mean ms | p50 ms | p95 ms |
|---|---:|---:|---:|
| A initial | 59.55 | 53.75 | 80 |
| C initial | 56.45 | 52 | 76 |
| C reverse | 55.23 | 51.25 | 72 |
| A reverse | 57.11 | 52.5 | 76 |

The reverse pair is +3.40% throughput for C, versus +5.49% in the first pair.
Direction agrees, but same-arm mean changes are -4.10% for A and -2.16% for C.
This is **not** an independent A/A noise-floor experiment, and the A variation is
larger than the smaller observed gain. Treat the game's uplift magnitude as
unconfirmed; no significant NFSU performance gate has passed. The scenario uses
wall-time entry/settling and does not fix the game's simulation phase.
Reverse artifacts are `logs/v86-app-perf/{candidate,baseline}-reverse-entry/`.

After all clean timing, a separate 8-second baseline diagnostic trace was saved
as `logs/v86-app-perf/nfsu-baseline-attribution.json.gz`, with analyzer output in
the adjacent `.txt`. It contains 22,194 samples on the emulator worker:
54.5% wasm, 28.6% JS, 16.9% idle/program/root categories (not necessarily usable
idle time). `jit_find_cache_entry_for_dynamic_chaining` alone has 5.0% self-time;
the analyzer's indirect-jump/cache bucket is 6.6%. SSE primitives total only 1.1%
and x87 primitives 0.1% in this stationary scene. These are sampling estimates
from an instrumented diagnostic window, not FPS evidence or universal workload
shares. Sampled guest-page joins are not used here: some printed block names and
joined page addresses disagree, so module/RVA attribution needs verification.

The next v86 target suggested by this evidence is the dynamic-chain resolver and
its accounting/lookup cost. More isolated SSE primitive work has a small measured
share here; synthetic LU uplift should not be extrapolated to NFSU.
