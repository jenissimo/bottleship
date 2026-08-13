# The automation harness

Bringing up a game — load it, make it reach a menu or level, and figure out why it froze or
rendered black — is the core debugging loop. BottleShip wraps that loop in an **automation
harness**: fluent, self-judging verbs you can drive from the command line or the browser
console, plus structured introspection that survives the multi-megabyte-per-second log
firehose.

## Running it

```bash
bun tools/harness.ts up        # cold start: launch Chrome + dev servers, reach "ready"
bun tools/harness.ts report    # one structured snapshot of the whole machine state
bun tools/harness.ts shot      # screenshot the page (add --verify to cross-check the worker's own capture)
```

`up` starts the dev server and a log server, launches Chrome with the flags the engine needs
(including an autoplay policy so audio unlocks without a user gesture — audio-gated games stall
silently otherwise), opens the bare emulator page, and waits until everything is healthy.

In the browser console the same capability is on `window.__BS__.harness`.

## Several games at once

Bringing a game up is mostly *waiting* — a bundle is gigabytes, a boot is minutes — so the harness
supports several agents driving several tabs of the **same** Chrome:

```bash
BS_TAB=alpha bun tools/harness.ts up     # -> ?game=dev&bs=alpha, artifacts under logs/alpha/
BS_TAB=bravo bun tools/harness.ts up     # -> ?game=dev&bs=bravo, artifacts under logs/bravo/
```

A session name selects (or opens) its own tab and re-roots everything that run produces —
screenshots, journals, surface dumps, and the sidecar's log archive — under `logs/<name>/`. Two
sessions can therefore never read each other's evidence, which is the whole point: a diagnostic
that silently describes the wrong guest is worse than no diagnostic. With `BS_TAB` unset nothing
changes: the same tab, the same paths as always.

**Limits.** This is a bring-up facility, not a measurement one. Parallel guests share CPU and GPU,
so any timing you read while two are running is noise — `harness trace` refuses to record while a
second guest tab is open. Each tab also costs a full emulator (its own worker, SAB and VRAM), so
memory, not CPU, sets the ceiling; 2-3 concurrent bring-ups is the sane range on a normal desktop.

## Driving a game

The harness exposes a fluent, self-checking DSL. A bring-up script reads like the steps a human
would take, and each verb asserts its own success:

```js
harness()
  .openWgb('/apps/mygame.wgb')
  .waitForEvent('dialogShow')
  .click('Play')
  .tickFrames(120)
  .expectSurfaceNonBlack('primary')
  .run()
```

Verbs cover loading bundles, waiting for events, synthetic input (clicks, keys), advancing
frames, and asserting on rendered surfaces and engine state.

### Two mouse coordinate systems

`click`/`clickAt`/`move` address the **absolute** pointer — right for Win32 controls and for
in-engine menus that consume `WM_MOUSEMOVE`/`WM_LBUTTON*` (GTA III, Tiberian Sun, HL Uplink).

A title that steers by **motion** (exclusive DirectInput: Quake 3-lineage menus, mouse-look)
owns the cursor it hit-tests against and draws it itself. No absolute coordinate we publish
says where that cursor is, so an absolute click there lands wherever the *guest's* cursor
happens to be. Use `moveRelative(dx, dy)` to steer it and `clickHere()` to press without
disturbing it, and read the cursor's position back off a `shot` — it is the guest's, not ours.
Every pointer verb's result (and `state(['dinput'])`) carries `relativeMouse` when the guest is
in that mode, so you never have to guess which world you are in.

## Seeing what happened

The canvas is an `OffscreenCanvas` the main thread can't read directly, and the guest generates
far too much log output to grep. So the harness gives you structured views instead:

- **`report()`** — the firehose-immune snapshot. One plain object with CPU registers, the
  module-labelled guest call stack, the recent WinAPI call ring (the last thunks that ran), the
  **unimplemented-stub registry**, recent page faults, and thread states. This is the first
  thing to pull for *any* non-standard situation (froze / vanished / black frame / wild EIP).
- **Stub registry.** The usual reason a game "gracefully vanishes" is that it called an export
  or vtable slot with no implementation, got a garbage return, and took an "unsupported → exit"
  branch. The stub registry names exactly which unimplemented call it was and who called it.
- **Log tools.** Instead of grepping the stream: a template-deduped summary
  (`the same stub called 10,000× becomes one ranked row`), signal→event watchers that block
  until a specific message appears, and time-windowed captures. A durable dev sidecar (`tools/dev-sidecar`, :3001) archives
  the stream to disk.
- **Surfaces & textures.** Dump a specific guest surface or texture to a PNG when a screenshot
  of the composited canvas isn't enough.
- **Emitted JIT code.** `jitBytes` captures the wasm module bytes the JIT emits for a set of hot
  guest pages and diffs two captures — per-section sizes, declared locals, first differing
  offset. It is the decisive test for any codegen flag: if the bytes don't change, the flag is
  dead on that workload, and no timing measurement can say otherwise.

## Checked-in scripts & the regression batch

Durable `*.harness.ts` scripts live under `tools/harness/`: `templates/` (copy-and-adapt
starting points), `regression/` (self-judging per-game scenarios), `perf/` (production A/B
instruments). `tools/harness/README.md` has the admission rule for what earns a spot in
`regression/` versus staying a throwaway probe in the gitignored `tools/probes/`. Run the
whole regression set with:

```bash
bun tools/harness.ts regress                   # every scenario, sequentially
bun tools/harness.ts regress --only "quake2*"  # glob against the scenario name
```

which prints a scenario → verdict → screenshot table; a failure always has a picture next
to it even if the scenario itself never calls `.shot()`.

## Reverse-engineering the guest

For understanding the guest binary itself, a warm RE service (Ghidra headless behind an HTTP
daemon) is available through `tools/re/` — decompile a function, resolve a live EIP back to a
function name, or export a symbol map to load breakpoints from.

## Diagnostic discipline

Confirm with **data** — a dump, a logged value, a `report()` — not by reasoning about how you
think GDI or a vtable is laid out. Multi-DC composites, the canvas-vs-selected-bitmap
distinction, and COM vtable topology all mis-model easily; a dump settles it.
