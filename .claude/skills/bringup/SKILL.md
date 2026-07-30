---
name: bringup
description: Drive and observe the BottleShip emulator to bring up a game, using the AI-agent harness (window.__BS__.harness + bun tools/harness.ts). Use when loading a game, making it reach a menu/level, diagnosing why it crashes/hangs/renders black, or writing a repeatable bring-up/regression script. Operationalizes CLAUDE.md's debugging workflow on top of the harness verbs. Use the project's CDP harness, not a browser MCP (chrome-devtools MCP is disabled for this project).
---

# BottleShip Bring-up

The harness turns bring-up from "poke `dbg.*` by hand, grep logs, guess from
screenshots" into fluent, self-judging automation. It is **headless** (CLI/CDP)
and **in-page** (`window.__BS__.harness`). Logic lives in the worker
`HarnessService`; the page facade and CLI are thin transports over one
`harness_rpc {id,cmd,args}→{id,ok,result|error}` contract.

## 1. Preconditions — `harness up`

```
bun tools/harness.ts up
```
Launches/attaches Chrome with `--autoplay-policy=no-user-gesture-required` (so
**audio unlocks with no gesture** — no canvas click needed in automation), opens
`http://localhost:5174/?game=dev`, arms log streaming, and probes Vite(:5174
`/health`) + dev-sidecar(:3001 `/health`) + Chrome(:9333). Bring the dev servers
up first: `bun run dev` and `bun run dev:sidecar` (`dev:logs` still works; start the
server BEFORE streaming). `bun tools/harness.ts health` re-probes.

### Parallel bring-up — one tab per agent

Set `BS_TAB=<name>` (once, for every harness command you run) when another agent is
already using the emulator:

```
BS_TAB=alpha bun tools/harness.ts up     # opens/claims ?game=dev&bs=alpha
BS_TAB=alpha bun tools/harness.ts run my.harness.ts
BS_TAB=alpha bun tools/harness.ts report
```

The name picks that tab and ONLY that tab, and re-roots this run's evidence under
`logs/alpha/` — screenshots, `run-N.harness.ts` journals, `dumpSurface`/`shot({save})`
PNGs, and the sidecar's log archive. Never read `logs/` at the top level while a
session is set; that is somebody else's guest.

Rules: pick a name nobody else is using; never close a tab you did not open; and
**do not measure** — parallel guests share the CPU, so `trace` refuses to run while
a second guest tab is open, and A/B timing needs a single tab. With `BS_TAB` unset
everything behaves exactly as it always has.

## 2. Drive

A fluent chain (`bun tools/harness.ts run <script.harness.ts>`, or in the browser
console `await window.__BS__.harness.chain()....run()`):

```ts
import { harness } from "../harness";
await harness()
  .streamLogs(["SYSTEM","DDRAW"])
  .openWgb(process.env.WGB ?? "/apps/external-wgb/<id>.wgb") // abs path (streamed off disk) or drop-folder URL — take it from env, don't hardcode local paths
  .waitForEvent("dialogShow")              // event-driven wait (HarnessEventBus)
  .click("Play Game")                      // faithful click by label (global coords)
  .tickFrames(120)                         // wait N presents after the click
  .waitUntil(() => read32(0x6b7bf8) === 0) // predicate evaluated IN the worker (spin-loop games)
  .expectSurfaceNonBlack("primary")        // assertion → aborts + auto fault snapshot on fail
  .state(["surfaces","threads"])
  .run();                                  // → one POJO (also written to logs/harness/)
```

Skip intros with the bundle's `skipVideo`. `audioGesture()` exists **only** for a
manually-opened browser; automation uses the autoplay flag.

Touch/mobile runs the same way — `.device('phone-landscape'|'tablet-landscape'|'desktop')`
then `.tap(x,y)` / `.touchDrag(x0,y0,x1,y1,ms)` / `.longPress(x,y,ms)` / `.twoFingerTap(x,y)` /
`.pinch(x,y,scale)`, all in GUEST px. These execute CDP-side, so keep `.device()` and its
gestures in ONE chain: the emulation override is owned by the CDP session and a separate
CLI invocation reconnects without it.

## 3. Observe

- `state([...])` — windows/surfaces/memory/threads/rings/audio/video/modules/cpu/screen as one POJO.
- `shot({save})` — PNG of the SCREEN: the frame that reached the canvas, every overlay
  (video plane, live GDI dialog rects, stats) composited, read from the mirror the present
  path keeps. `shot({source:'layer'})` asks for the presenter's pre-composite game layer
  instead — the split between "which layer holds the pixels" and "does the composite show
  it" — and is always labelled `composited:false`. A capture that cannot see the screen
  errors out; it never returns a plausible substitute.
- `bun tools/harness.ts shot [file] --verify` — the browser's own capture of the canvas,
  plus a cross-check of every worker-side route against it (with the screen's own churn as
  the noise floor). Run it when a screenshot and the tab seem to disagree.
- `textures()` + `dumpSurface(ptr|'primary')` — gallery + per-surface PNG to `logs/debug/`.
- `surfacePixels(sel)` / `expectSurfaceNonBlack(sel)` — cheap liveness from a subsampled readback.
- Dump PNGs preserve ALPHA: an area that looks WHITE in a viewer but BLACK on the canvas is
  transparent (a=0), not white — sample the RGBA (readSurfaceRGBA) before concluding a color.
- A Win32 FRONT-END presents nothing — its dialogs run before the render device does. Gate on
  `waitForControl("New Game")`, never `tickFrames`, or you wait on presents that never come and
  it reads exactly like a hang.
- BLANK control / unpainted dialog → `paintTrace("start")` … `paintTrace("read")`. The chain has
  many links (posted → pump filter → dispatched → BeginPaint/EndPaint+flush → owner-draw chain
  with its task counts → per-flush child-window exclusions) and the pixels look identical
  whichever one dropped it; the trace names the link and its reason.

## 4. Diagnose

- **Prefer API breakpoints** (`breakOnApi("d3d9.*")`) — JS layer, **no JIT-off**,
  resolves on first hit with args + caller. Best for "where does it first touch X".
- `breakOnExport("d3d9.dll!Direct3DCreate9")`, `breakOnSymbol("core!UInput::ReadInput")`
  (needs `loadSymbols(module, {name:rva})` from the RE layer first), `watchMem(addr)`,
  `breakOn(eip)` — all require **JIT OFF** (auto-enabled; **perf collapses while
  armed** — `clearBreaks()` to restore). Addresses inside the async-park spin loop
  are refused (CLAUDE.md §3.5).
- Read the streamed log; `events(n)` shows recent harness events; on a WASM trap a
  `fault` event carries the fault-grade snapshot.

## 5. Hypothesis from DATA, not reasoning

Confirm with a dump / a logged value (a `dumpSurface` PNG, a `state` field, a
`breakOnApi` snapshot) before theorizing about DC topology / vtable layout — the
canvas-vs-selected-bitmap distinction and multi-DC composites are easy to mis-model
(CLAUDE.md diagnostic discipline).

## 6. Fix → re-run → keep tools, drop probes

Every `.run()` writes a re-runnable `logs/harness/run-N.harness.ts` (journal). Turn
the winning chain into a checked-in `*.harness.ts` regression script. **Remove
one-off probes**; keep only reusable harness verbs.

## Hard rules (don't relearn these)

- **Quality gate order** (CLAUDE.md): `bun tools/generate-index.ts` →
  `bun tools/validate-signatures.ts` → `bun tools/validate-struct-offsets.ts` →
  `bun tools/validate-guest-code-writes.ts` → `bun tools/validate-stub-tables.ts` →
  `bun run typecheck`.
- **Reload, not HMR**, after editing `src/worker` (HMR doesn't reload the worker
  entry and hangs the game). The harness ships in the worker bundle — iterate via
  a page reload.
- **JIT-off collapses perf** — only EIP/export/symbol/watch breakpoints need it;
  prefer API breakpoints. `clearBreaks()` when done.
- **Audio** needs the autoplay flag (`harness up`) or a real transport click; a
  synthetic event won't satisfy the browser autoplay policy.

## Division of labor

The **skill** = workflow/checklist; the **harness** (`src/worker/harness/`,
`src/harness/`, `tools/harness.ts`) = capability/verbs; **CLAUDE.md** = invariants.

Bundled examples: `tools/examples/bringup.harness.ts` (template),
`tools/examples/diagnose-eip.harness.ts` (API-breakpoint + waitUntil).
