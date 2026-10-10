# Contributing with an AI agent

Most open-source projects treat AI-generated contributions as a risk to be filtered out.
BottleShip is built the other way around: **the AI-assisted bring-up loop is the intended
contribution path**, and the repository ships the infrastructure that makes it verifiable.

Two things make that safe here where it isn't elsewhere:

1. **The game is the test.** "Load the game, drive it to the menu, check the surface isn't
   black" is a machine-checkable loop. An agent doesn't need a human to know whether its fix
   worked — the [automation harness](harness.md) gives it self-judging verbs (`report()`,
   `stubs()`, `expectSurfaceNonBlack()`, …) and your PR carries the evidence.
2. **The Prime Directive makes fixes reviewable.** No per-game hacks: every fix must close a
   gap between our recreation and the *documented* Windows behavior. That turns review from
   "read all the code" into "check the claim against the API contract" — a citation, not a
   vibe.

So: pick the game you want to preserve, bring your own agent, and let the loop do the
systems work.

## The loop

```
load your game  →  drive it  →  it misbehaves  →  report() / stubs() name the gap
      ↑                                                        │
      └──── harness script proves the fix ←──  fix the GENERIC layer bug ←┘
```

Any coding agent works. If you use [Claude Code](https://claude.com/claude-code), the repo
is pre-wired: `CLAUDE.md` is the project's system prompt (memory architecture, thunk
invariants, debugging discipline) and the `/bringup` skill walks the operational checklist.
Point your agent at the repo, tell it which game you're bringing up, and it has everything
it needs.

```bash
git clone --recurse-submodules <repo-url> && cd bottleship && bun install
bun tools/harness.ts up        # cold start: dev server + log server + browser
# then, in your agent or by hand:
#   harness().openWgb('/apps/external-wgb/mygame.wgb')
#            .waitForEvent('dialogShow').click('Play')
#            .tickFrames(120).expectSurfaceNonBlack('primary').run()
```

## Three ways to contribute (in increasing effort)

### Tier 0 — compatibility report

Run your game, file a **Compatibility report** issue with the harness output: how far it
gets (boots / menu / in-game / completable), the bundle parameters that got it there, and a
`report()` snapshot if it breaks. Zero systems knowledge required; every report grows the
[compatibility matrix](compatibility.md).

### Tier 1 — diagnosis

Let the agent drive the game to the point of failure and extract the *named* gap: a single
`report()` snapshot carries the unimplemented API the game hit (its `stubs()` registry), the
module-labelled guest call stack, and the recent WinAPI ring. File a **Bring-up diagnosis**
issue. A named stub with a call stack is a ready-to-implement work item — the scarcest
artifact in any bug tracker.

### Tier 2 — the fix

Implement the missing/incorrect behavior and open a PR. The bar (enforced by the PR
template):

- **Faithful and generic.** State the real API contract you implemented and cite a public
  source (Microsoft docs, public SDK headers, observed Wine behavior — cite it, never copy
  its code). Never branch on a game's
  name/exe/hash — if you're tempted, you've found the wrong layer. See
  [CONTRIBUTING.md](../CONTRIBUTING.md) for the ground rules.
- **Proven, not promised.** Include the harness script (or verb sequence) that demonstrates
  the fix, plus its output. If your game is commercial, the script still belongs in the PR
  body — reviewers run it against their own copies; CI runs the freeware suite.
- **Green quality gate** (`generate-index` → `validate-signatures` →
  `validate-struct-offsets` → `typecheck` → `bun test`).

## Rules that keep this fun

- **Keep session artifacts local.** Plans, handoffs, audits, experiment reports and research
  registries belong in ignored `plan/`; screenshots, dumps, traces and raw measurements in
  ignored `logs/`. `docs/` contains maintained guides and reference material. Put evidence
  in the issue or PR and commit reusable harness scenarios under `tools/harness/`.
- **Never commit game files**, box art you can't redistribute, decompiled binaries, or
  leaked source. Reports and fixes about commercial games are welcome; their bytes are not.
- **Use real cover art or the existing fallback.** If a catalog entry has no cover, omit
  `coverUrl` so the library shows its gradient and initial. Do not make synthetic cover
  files; the `subtitle` badge already identifies a demo. Preview covers and missing-image
  cards in the desktop and mobile library before submitting catalog changes.
- **You own what you submit.** AI-assisted is welcome and assumed — but you are the author:
  run the loop, read the diff, and stand behind the claim. "The agent said so" is not a
  citation.
- **Fix the class, not the symptom.** Nearly every "this one game is weird" in this
  project's history root-caused to a generic layer bug whose fix helped every game on that
  path. When your game misbehaves, the question is always: *what does real Windows do here,
  and what do we do differently?*
