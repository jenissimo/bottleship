# Runtime 32-bit memory helper inlining — experiment, not accepted

## Mechanism and evidence that selected it

Fresh NFSU content profile `logs/nfsu-jit-fresh-content-20260905/` attributed
3.73% of self samples to `read32s`; the previous joint profile also attributed
1.87% to `safe_write32`. Caller stacks were predominantly EAGL HLE. The
experiment adds only `#[inline(always)]` to these two Rust functions in an
isolated source copy. Function bodies, memory bounds, paging, MMIO, dirty-page
handling, ordering and exported interfaces are unchanged. It may expose
redundant work to LLVM and remove direct calls; code growth may instead regress
the game. This is one potential contribution toward +20%, not a sufficient
standalone ceiling claim.

Reject without a positive fixed-work signal followed by phase-controlled game
A/C. Never transfer the kernel percentage to FPS. No integration yet.

## Artifacts

Builder: `tools/bench-v86/prepare-memory-inline.mjs`.
Manifest: `C:/Users/jenis/AppData/Local/Temp/v86-memory-inline-JoEdqh/manifest.json`.

- A: 2,581,025 bytes, SHA-256
  `3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a`.
  Rebuilt source matches pinned baseline exactly; builder refuses C otherwise.
- C: 2,616,310 bytes, SHA-256
  `1f57ade103fa2233fa2d974fb68b89b01c817fa346e10099e42565e280ae0cd9`.
  Growth 35,285 bytes (1.37%). No source edits applied to shipping vendor tree.

## Fixed-work early screen

`tools/bench-v86/run-memory-inline-work.mjs` executes the real `instr32_EF`
route to handler 128 (EAGL constant conversion, mode 3). Each observation is
10,000 calls copying 32 matrices of 16 dwords each. It checks the handler's
served count, unchanged fallback count, return value and full output bytes.
Cursor policy 1 matches application initialization. Both engines are stopped
except explicit calls. The live NFSU guest was paused for builds and this test.

Twelve alternating warmups; nine rounds of A C C A A A C C. Every round favoured
C: 53.0–96.6%, median 65.4%; maximum absolute A/A or C/C control 20.7%.
Positive early signal exceeds these observed controls, but the wide range
precludes a precise kernel percentage claim. Node/V8, flat nonpaging memory,
no FPS or comprehensive correctness claim. Raw data is
`.../v86-memory-inline-JoEdqh/eagl-memory-work.json`; console
`logs/v86-memory-inline-work-20260905.log`.

Candidate existing tests passed: 32 SSE page-fault/restart cases and 66
SSE/flags cases, with `V86_WASM_PATH` pointing to C. Logs:
`logs/v86-memory-inline-fault-20260905.log` and
`logs/v86-memory-inline-contract-20260905.log`. These cover relevant generated
memory/fallback paths, not all hypercall permission/MMIO cases. Inlining-only
source equivalence is also material evidence; full acceptance remains open.

## Game screen protocol

Fresh reload and exact restoration of corrected `fixtures/nfsu-max` (all effects
on, 1024x768). Observe countdown state 3 then poll at 100 ms for state 4; wait
for diagnostic moverCounter = observed start + 8000, tolerance +300; take one
20-second raw-present window. This removes the arbitrary minutes-long delay of
earlier pilots, but polling uncertainty and full simulation equivalence remain
limitations. Screenshots require review for the same circuit, car and camera.

First A: `logs/nfsu-max-phase-a1-20260905/`, start=6558, window starts=14581
(23 above target), 341 intervals, 17.083758 FPS, p95=73.965 ms. Checks passed.
One A is insufficient to infer noise. First C is being screened with the same
procedure, and the public artifact is restored to A in the command's finally.
The loaded worker must be identified independently after its window.

### Game screen result: not accepted

C1 (`logs/nfsu-max-phase-c1-memory-inline-20260905/`): 343 intervals,
17.157356 FPS, p95 72.340 ms. CDP bytecode from the loaded runtime independently
matched C SHA-256 in `logs/nfsu-memory-inline-c1-identity-20260905/identity.json`.
The public file was restored to A by finally before the next reload.

A2 (`logs/nfsu-max-phase-a2-20260905/`): 346 intervals, 17.307589 FPS,
p95 73.500 ms. A1-to-A2 variation is +1.31%, larger than C1-to-A1's +0.43%;
C1 is also below A2. This is an early A/C/A screen, not enough independent
pairs for a confidence interval. It provides no persuasive game uplift and
does not justify integration. Retain the candidate solely as an experiment.
Do not repeat it solely because the fixed-work kernel was faster. A2 loaded
runtime identity also independently matches pinned A (a2 identity log).

Manifest and fixed-work raw data also retained under `logs/` as
`v86-memory-inline-manifest-20260905.json` and
`v86-memory-inline-work-raw-20260905.json`.
