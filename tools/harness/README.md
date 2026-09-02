# tools/harness/ — checked-in harness scripts

`*.harness.ts` scripts driven by `bun tools/harness.ts run <script>` (see the `bringup`
skill and `docs/harness.md`). This directory is the **checked-in, durable** tier;
one-off investigation probes never land here — see "Admission rule" below.

## Layout

- **templates/** — copy-and-adapt starting points, not run as-is in CI/regress:
  `bringup.harness.ts` (generic bring-up chain), `diagnose-eip.harness.ts`
  (API-breakpoint + worker-side `waitUntil`).
- **regression/** — self-judging per-game scenarios, meant to be run as a batch:
  `bun tools/harness.ts regress`. Each one throws (or sets `process.exitCode`) with
  a stated reason on failure and prints `OK — ...` on success; none of them ask a
  human to eyeball a screenshot.
- **perf/** — production A/B measurement instruments that compute their own
  pass/fail gate from repeated boots. Not part of `regress` —
  they run a multi-boot campaign and write a JSON report, not a single quick verdict.

Throwaway bring-up/debug probes (a one-off script written to answer a single question
mid-investigation) belong in the gitignored `tools/probes/`, **not** here, and die with
the investigation. Turning a probe into a regression script is a deliberate promotion,
not the default — see "Admission rule".

## Admission rule

A script earns a place under `tools/harness/regression/` only if it is **all three**:

1. **Self-judging.** It fails loudly with a specific, actionable message (a thrown
   `Error`, or `process.exitCode = 1` plus a printed reason) — never "run it and look
   at the screenshot." A human should be able to read stdout/stderr alone and know
   pass/fail and why.
2. **Not tied to one closed bug.** It regresses a class of behavior for a game (a
   dialog composites, a launcher paints, settings persist across a reload, cutscenes
   play through) — not a one-time A/B or diff that only made sense while a specific
   investigation was open. Once the investigation closes, the probe that answered it
   should be deleted, not preserved as a "regression" nothing else will ever trip.
3. **Takes its bundle path from the environment.** `process.env.WGB ?? <default>` —
   never a hardcoded path to one machine's disk. The default may be a drop-folder URL
   (`/apps/external-wgb/<name>.wgb`, works once `public/apps/external-wgb` points at a
   local WGB folder) or a plain disk path; either way it MUST be overridable by
   setting `WGB` before the run, so the same script works on a different checkout.

If a script fails any of these, it either gets fixed to comply or stays a probe.

## Running the batch

```bash
bun tools/harness.ts regress                    # every scenario in regression/
bun tools/harness.ts regress --only "quake2*"    # glob against the scenario name (no .harness.ts)
```

Scenarios run **sequentially** — the shared Chrome tab drives one guest at a time, and
parallel guests would make any timing-sensitive assertion noise anyway (same rule as
`harness trace`). Each scenario is its own `harness run` subprocess, so one script's
thrown error or `process.exitCode` can never leak into the next one's state. Bundle
paths are entirely each scenario's own concern (its `WGB` env var / built-in default)
— `regress` itself holds no bundle paths, so it runs unmodified regardless of where a
given machine's `.wgb` files live (this repo's convention is `G:\WGB\running\`, but
that lives in each scenario's own default/env, never in the runner).

Output is a scenario → verdict → screenshot table:

```
[regress] ── summary ──────────────────────────────────────────────
  PASS  tiberian-sun-dialog    38.4s  logs/hscripts/regress/tiberian-sun-dialog.png
  FAIL  red-faction-launcher   12.1s  logs/hscripts/regress/red-faction-launcher.png
        launcher's WM_PAINT died before the default paint chain (erase=true flush=false drawitem=false)

[regress] 1/2 passed
[regress] FAILED: red-faction-launcher
```

The screenshot is taken unconditionally (pass or fail) straight from the tab, so a
failure always has a picture next to its verdict even if the scenario itself never
calls `.shot()`. Under `BS_TAB=<name>` the table (and every screenshot) re-roots under
`logs/<name>/regress/`, same as any other harness artifact.
