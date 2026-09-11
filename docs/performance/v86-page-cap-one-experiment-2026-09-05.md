# Single-page JIT modules — early game screen

Hypothesis: constrain generated functions to one physical guest page instead of
three, reducing compiler/register-allocation and internal-dispatch cost. Risk:
more cross-module transitions. This differs from the previously negative broad
region expansion. The large sampled baseline modules motivated testing the
opposite direction: g005cf304 237,925 bytes, g005cd001 341,536 bytes,
g0040e002 387,571 bytes in `logs/nfsu-jit-fresh-content-20260905/`.
Whole-module byte sizes are not time or register-pressure measurements.

Only `static mut MAX_PAGES: u32 = 3` changes to 1 in the isolated C source.
Existing code generation, cross-page exits, chaining, paging and budgets remain
in use. Tier2 and indirect regions remain off; idx21 remains off. There is no
game-specific condition and no shipping source change.

Builder: `bun tools/bench-v86/prepare-memory-inline.mjs --page-cap-one`.
The option selects a separate arm and does not include memory-helper inlining.
Manifest: `C:/Users/jenis/AppData/Local/Temp/v86-page-cap-one-zPOHgR/manifest.json`.
Both binaries are 2,581,025 bytes. A rebuilt exactly as pinned
`3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a`;
C is `4b7479fa124490332d602c224867ac240301f3170acdd90dabc1e0c7ef67ef47`.

Existing emitted-boundary test ran both artifacts with one-page modules,
covering hot/cold/memo hits, urgent/exhausted budget, HLT, absent/incompatible
entries, TLB flush, code invalidation and verification fallback, with tier2
both off and on. All 56 executions matched across artifacts and passed their
assertions. Log `logs/v86-page-cap-one-boundaries-20260905.log`; raw
`.../v86-page-cap-one-zPOHgR/emitted-boundaries.json`. This checks relevant
exits, not a new exhaustive proof of every multipage graph.

## First game result

Same fresh-boot protocol as the memory-inline experiment, corrected max-effects
fixture, countdown observation, moverCounter start+8000 (tolerance300), one
20-second raw-present window. C: 332 intervals, 16.657602 FPS, p95 71.865 ms;
all window guards passed and config[1] read back 1. Evidence:
`logs/nfsu-max-phase-pagecap-c1-20260905/`.
Earlier A windows: 17.083758 and 17.307589 FPS. This is an unfavourable early
screen, not enough repetitions for a precise regression estimate.

Post-window profile `logs/nfsu-pagecap-one-content-20260905/` returned exact
sampled runtime bytes matching C (scriptId886). The public binary was restored
to A in finally before further startup. Smaller modules really were emitted:
g005cf304 is 140,004 bytes, g005cd001 160,152, g0040e002 151,053. These are
different module boundaries/versions, so per-name sample shares cannot be
treated as matched instruction costs. Aggregate generated JIT share is 35.58%,
dispatch/loop/drain 16.09%; profile phase is not the timed window.

Decision: do not integrate a global one-page cap. A smaller static shape did
not produce a positive game signal. A fresh A3 control is being gathered;
do not claim +20% or acceptance from this screen.

A3 completed at 16.738318 FPS, 334 intervals, p95 74.820 ms
(`logs/nfsu-max-phase-a3-20260905/`). The wider A1/A2/A3 variation is now
about 3.4%, so the first C result does not establish a precise regression
either. It establishes no positive signal: C is below all three A observations.
The loaded game is back on baseline after the A3 reload. Further analysis
uses an explicitly instrumented dispatch census outside FPS windows.
