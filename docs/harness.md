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
- **GDI font state.** `gdiFonts({text:'H', assert:true})` compares each DC's cached font
  with the canonical font Canvas actually uses and reports glyph measurements and selected
  bitmap dimensions. An unapplied lazy selection is allowed; a stale cache fails the assertion.
- **CPU texture transfers.** Arm `textureWrites({arm:true, width:512, format:21})` before
  loading, then read `textureWrites()` to distinguish textures that received no writes,
  zero-filled transfers, and populated transfers. The bounded journal reports dropped events;
  `textureWrites({arm:false})` stops collection.
- **Save durability.** `fsDurability(path)` snapshots guest-visible bytes, flushes, then
  compares them with the committed OPFS file while bypassing the content cache. It reports
  the first differing offset and prefixes for files up to 16 MiB. Pause after the guest
  finishes saving to compare stable content. `call('fsTrace', 'start', {writes:true, path:'.sav'})`
  also records write offsets, lengths and byte prefixes; `call('fsTrace', 'stop')` reads the journal.
- **Live string copies.** `call('memoryFind', 'menu.cfg', {start, end, context:32, limit:64})`
  searches readable guest regions and returns each match's address, region, surrounding
  hex bytes and ASCII. `encoding:'utf16le'` searches wide strings; `encoding:'hex'` accepts
  a byte pattern. Use the returned addresses with `trapWrites` or `trapJsWrites` to find
  where a correct source becomes a corrupted copy. `truncated` reports a hit limit.
- **D3D9 draw capture.** `captureFrame({ backend: "d3d9", timeoutMs: 5000 })`
  records the next complete frame, including draws executed by the separate render worker.
  Keep the guest running while capturing. `maxVerts` and `maxIndexedVerts` control vertex
  sample sizes; concurrent captures fail explicitly, and a timeout disarms the recording.
- **Emitted JIT code.** `jitBytes` captures the wasm module bytes the JIT emits for a set of hot
  guest pages and diffs two captures — per-section sizes, declared locals, first differing
  offset. It is the decisive test for any codegen flag: if the bytes don't change, the flag is
  dead on that workload, and no timing measurement can say otherwise.
- **GPU device loss.** A lost WebGPU device never throws — every later call is a validated
  no-op — so the picture stops changing while every counter keeps incrementing.
  **`gpuDeviceState()`** reports the device's status and generation alongside the answers the
  guest would get right now (`testCooperativeLevel` per d3d8/d3d9 device, `ddrawLostSurfaces`),
  and `report().gpuDevice` carries the same. **`gpuLoseDevice()`** destroys the live device on
  purpose — the same path a real loss takes — and returns `before` / `during` / `after`
  snapshots; `during` is sampled from inside the invalidation fan-out, which is the only
  instant at which "did we tell the guest?" is answerable.

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

## Inspecting a programmable D3D9 draw

`captureFrame({backend: 'd3d9', minDraws: 300, timeoutMs: 300000})` waits for a complete
frame meeting the draw threshold. Loading/menu frames are discarded and counted in
`skippedFilteredFrameEnds`; the initial partial frame is discarded separately. The
threshold selects a workload, and does not prove its correctness.
`minRenderTargets` also requires that many distinct render attachments, allowing a busy
single-target menu to be excluded while waiting for a scene with offscreen passes.

Captures include depth/stencil/bias state, sampler addressing/filtering and the actual
pipeline descriptor for captured programmable pairs. `shaderWgsl({handle, includeProgram:
true})` additionally returns the parsed shader program on devices exposing instrumentation.

`shaderOps()`, `shaderWgsl()` and `d3d9Census()` read the rendering twins when the
D3D9 render worker is active; `producer: 'render'` identifies that source. A synchronous
`report()` only sees the API front and marks its shader census incomplete. Frame captures
include colour and separate-alpha blend operations and factors, including refused draws.

`drawScrub(first, last, targetHandle, true)` excludes an inclusive interval of draws for
one D3D9 render target. Omit the fourth argument to include that interval instead.
`drawScrub(0, -1, 0)` restores normal drawing. `shaderOutputOverride(vsHandle, psHandle,
'vec4<f32>(...)')` replaces one pair's final fragment colour for diagnostics;
`shaderOutputOverride(vsHandle, psHandle, null)` restores its shader. The override refuses
multiple render targets/depth output, and disables programmable batching while armed.

`dumpTexture(handle, {from: 'auto', level: 2})` reads an authored CPU mip; `from: 'gpu'`
reads the GPU copy. BC1/BC2/BC3 readback handles padded block rows and small mip levels.
Missing mips and dropped GPU copies report errors rather than plausible black pixels.

`dumpSurface(handle, {from: 'gpu', save: 'mask'})` reads D3D9 targets from the render
worker when rendering is split. `renderTargetState()` reports that worker's active
color and depth bindings and recent passes, including their viewport and clear/load mode.

`gpuMathProbe([0, 1], ['log2(input[0])', 'input[1]'])` evaluates scalar WGSL expressions
with runtime f32 inputs on the live adapter. Non-finite answers are returned as
`NaN`, `+Inf` or `-Inf`, preserving their meaning in JSON evidence.

## Reverse-engineering the guest

For understanding the guest binary itself, a warm RE service (Ghidra headless behind an HTTP
daemon) is available through `tools/re/` — decompile a function, resolve a live EIP back to a
function name, or export a symbol map to load breakpoints from.

## Diagnostic discipline

Confirm with **data** — a dump, a logged value, a `report()` — not by reasoning about how you
think GDI or a vtable is laid out. Multi-DC composites, the canvas-vs-selected-bitmap
distinction, and COM vtable topology all mis-model easily; a dump settles it.

`counterRate(address, {sampleMs: 3000, intervalMs: 50, bits: 32})` samples an unsigned guest counter while JIT remains enabled and compares its increments with wall and guest time. It returns the raw samples; resets are reported as modulo wraps. `report().callbacks` includes pending/suspended callback frames and the most recent invocation and return.

`bun tools/harness.ts shot capture.png --mirror` saves the composited screen mirror directly to a local file, including on a busy or backgrounded tab where the browser compositor cannot answer. The default route still captures the browser; `--verify` compares the routes.

`BS_URL_MATCH=http://localhost:5174/` selects an existing library tab for host UI checks with `eval` and `shot`. Leave it unset for the normal `?game=dev` guest tab, or use `BS_TAB` to select a named guest tab.

The original Thief Gold demo scenario takes `WGB` from the environment: `bun tools/harness.ts run tools/harness/regression/thief-gold-demo.harness.ts`. It navigates to Thieves' Guild, requires actual reads from miss15.mis in the VFS census, and captures the mission after keyboard movement and mouse look, rejecting crashes and unimplemented APIs.
