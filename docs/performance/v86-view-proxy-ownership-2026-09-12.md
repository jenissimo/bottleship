# v86 `view()` Proxy: ownership, instruments, and the type break that was silent

2026-09-12. Stages 0-4 shipped, the live A/B run and measured, and the stage-5 gate answered.

## The class

v86 publishes both guest RAM and the CPU state block as `view()` Proxies
(`vendor/v86/src/lib.js`) so that a WASM memory grow stays transparent to every consumer.
The cost is paid **per access**: a `get` trap, a `resolve()` closure call, a buffer-identity
compare, then the element read. The event it guards against happens a handful of times per
session.

`getCurrentMemory()` / `toPlainGuestMemory` already solved this for guest RAM, with
`validate-guest-memory-borrow` holding the line. The CPU state block — `cpu.reg32`,
`cpu.instruction_pointer`, `cpu.instruction_counter`, `cpu.segment_offsets`, `cpu.flags` —
had no owner and ~330 sites across the worker.

## Stage 1 — the owner

**`src/worker/core/cpu/cpu-views.ts`** — the single owner of plain typed-array views over
the CPU state block, and of the offsets (pinned to `global_pointers.rs` by
`tools/tests/cpu-views.test.ts`, which parses *that file* rather than a second hand-copy).
`cpuViews(cpu)` rebuilds only when the WASM buffer's identity changes. `readEip(cpu)`,
`readEsp(cpu)`, `readRetiredInsns(cpu)` are the one-liners. A CPU without `wasm_memory`
(unit-test fakes) gets its own arrays back, so call sites need no branch.

Converted: the scheduler entirely (39 sites → 0) — `applyContextState`, `saveCpuContext`,
`retiredInsns`, `handleUnhandledFaultHalt`, `performSwitch`, `setFsBase`; hypercall-data's
instruction-counter reads; fpu-helper's dirty flag plus its per-context-switch
`new Uint8Array(buffer)` / `new DataView(buffer)` allocations.

**Gate step 15, `tools/validate-cpu-proxy-reads.ts`** — ownership plus a pinned per-file
census, the shape `validate-guest-memory-borrow` uses. It matches an index whose receiver
names a CPU; a local alias walks past it, which is why the counts are pinned rather than
trusted. Confirmed it can fail on a planted site — the first version could **not**, because
`cpu.segment_offsets![4]` puts a `!` between the field and the bracket.

Census: **346 → 230 sites, 54 → 35 files.**

## Stage 2 — the dispatcher, where the measurement pointed

- The per-thunk `X86Context` was assembled from `cachedReg32` — *the Proxy* — costing ten
  get traps on every JS-dispatched thunk. Now the `*Raw` plain views.
- `updateMemoryCache` resolved the Proxy seven times to read one geometry, twice through
  `byteLength`, which is **not in v86's `view()` whitelist** and trips `dbg_assert` in a
  DEBUG v86 build. Now three reads, via `length`.
- PHASE 5's offset+5 probe read five bytes through the Proxy per slow dispatch.
- The busy-wait detector read `instruction_counter` through the Proxy per slow dispatch.
- `writeShadowSlot` / `setShadowOwner` / `resetShadow` / `getShadowStats` built a fresh
  `DataView` from three Proxy reads **per `SetRenderState`**.
- `checkEbpSanity` read EBP through the Proxy with the plain view already in hand.
- `toPlainGuestMemory`'s miss path tested `raw.constructor === Uint8Array`, a `get` trap
  that, the property being a function, allocated a fresh `Uint8Array.bind(view)` every time
  the identity fast path missed. `ArrayBuffer.isView` reads an internal slot and answers
  without entering the Proxy (already pinned by `guest-memory-plain-view.test.ts`).

## Stage 3 — the fast-path signature, and the discovery that mattered

`FastPathImplementation` is now `(esp, dataView, mem8, mem32, cpu)`. ESP comes first
because every handler wants it and the dispatcher has already read it; reading
`cpu.reg32[4]` again inside the handler was a Proxy trap per call for a value the caller
was holding. It is the same read — taken immediately before the call, no guest execution in
between — so this is a parameter reshuffle, not a semantic change. 127 registration sites,
~110 distinct handlers.

**The plan assumed "TypeScript won't let you miss a handler". It was wrong, and that is the
load-bearing finding of this round.** Every `registerFastPath*` registrar took
`dispatcher: any`, so the compiler checked *nothing* about any handler. The type break
compiled clean with 32 handlers still on the old signature — each of which would have
received a `number` where it expected a CPU and a `DataView` where it expected a
`Uint8Array`, silently, at runtime.

What closed it: `FastPathRegistrar` and
`HleDispatcher = FastPathRegistrar & Record<string, any>` in `thunk-dispatcher.ts`, applied
to all 19 registrars. The intersection keeps every other `dispatcher.foo` untyped — those
modules reach for a dozen members — while making the one signature that has a contract an
actual contract. Verified by planting an old-style handler: it now fails to compile.

What actually caught the 32: **the repo's own differential tests.** 107 failures across nine
`fast path == slow path` files (heap, virtualquery, locale, mbwc, dinput, user32 input, the
two d3d9 COM-ref oracles). They are the §3.4 ledger rule paying for itself.

Also fixed by that failure: seven locale handlers whose ESP binding was spelled
`const esp = (cpu.reg32[4]) >>> 0;` — the parentheses hid it from the transform, so their
parameters were reordered while their bodies still read the Proxy.

## Stage 4 — a plain `mem8`, for the fast-path tier only

Handlers that read a guest string or validate an extent were paying ~13x per byte through
the Proxy; several (all of `locale.ts`) had started calling `borrowGuestMemory()` to unwrap
it by hand. The fast-path tier now receives a plain view.

That is sound **only** because a fast path is synchronous — no re-entry, no await, no
allocation — which is exactly the window in which a plain view cannot go stale. The slow
path keeps the Proxy: its handlers re-enter the guest through WndProc callbacks and write
the return EIP afterwards, and a plain snapshot there drops post-grow writes into a detached
buffer (the 0x7c07 escape-to-bootloader class).

Two things make the contract enforced rather than asserted:

- **Derived per dispatch, never stored.** The first attempt cached it in a field and
  `validate-guest-memory-views` rejected it — correctly, and it is a better design anyway: a
  grow between dispatches is now picked up automatically.
- **A loud detector.** After every fast-path call the dispatcher checks whether the view it
  handed out detached, and if so names the export and says what it did wrong. Without it a
  fast path that allocated would read `undefined` and drop its writes in silence. Pinned by
  a test, with the check removed to confirm the test fails.

## Instruments

- **`report().wasmGrowth`** and `frameReport`'s `wasmGrowths` — how often the buffer
  identity actually changes. This is the safety margin of every cached-view decision in the
  worker, and nothing reported it before.
- **`analyze-trace.ts --proxy`** — folds every v86 Proxy `get`/`set`/`resolve` frame into
  its nearest caller *outside* v86's own JS. Measured from stack frames, not FPS, so it is
  the scene-independent second oracle a Proxy-removal A/B needs (§3.4). Prints two
  denominators (whole thread, JS bucket) because a share of a thread that is mostly
  JIT-executed guest code makes any JS cost look like rounding, and states that a sampler
  only catches a trap it lands inside — every number is a **lower bound**.

## What the measurement said (baseline, before this round)

`--proxy`, worker thread, three checked-in traces:

| trace | proxy share of JS bucket | top caller |
|---|---|---|
| Glide `trace-30s-BEFORE` | 2.0 % | `_handlePortWriteSlow` 81.5 % |
| Satinav `splash-60s` | 9.1 % | `_handlePortWriteSlow` 33.2 %, `isDataViewValid` 13.9 %, `applyContextState` 8.1 % |
| Far Cry live scene 15 s | 4.6 % | `_handlePortWriteSlow` 43.2 %, `handlePortWrite` 13.9 %, `registerFastPath.trivial` 8.0 % |

The dispatcher's slow path dominates on every one, which is where the ten-trap context build
was. `registerFastPath.trivial` — all of stage 3's ceiling — is 8.0 % / 2.1 % / below the
top twenty. Stage 3 was done anyway because it was asked for and it is now type-safe, but
**its measured ceiling is hundredths of a percent of worker time**; the reason to keep it is
the signature and the registrar typing, not the traps.

## The live A/B — measured, not argued

`__v86ProxyBaseline` (`setWorkerFlag`) routes the converted sites back through the Proxy,
reproducing the per-access trap the conversion removed. One build, one load, arms alternated
— which is what a paired A/B needs, and stronger than two loads. Its own switching is pinned
by a test, because an arm that silently fails to switch reports a delta of zero for the wrong
reason.

**Workload.** Re-Volt, language-select screen: a fully static 3-D scene (`sceneProbe` motion
0), vsync-locked. JS is 26-32 % of the worker thread there, so the dispatcher is actually hot.
Eight 15 s traces, ABAB then BABA; one baseline capture failed and was dropped (n=3 vs 4).

**Same-work control.** Every arm presents at **60.0-60.1 FPS, p50 16.75 ms** — identical
presentation work — and `wasm %` does not separate between arms. The arms differ only in JS.

| trace | idle % | js % | wasm % | js/busy % | proxy ms | proxy samples |
|---|---|---|---|---|---|---|
| baseline-1 | 37.8 | 30.0 | 32.2 | 48.23 | 113.6 | 237 |
| baseline-2 | 38.7 | 29.4 | 31.9 | 47.96 | 118.8 | 253 |
| baseline-4 | 31.4 | 32.3 | 36.2 | 47.15 | 144.6 | 294 |
| new-1 | 41.8 | 26.4 | 31.8 | 45.36 | 3.8 | 18 |
| new-2 | 40.5 | 27.2 | 32.3 | 45.71 | 2.6 | 11 |
| new-3 | 36.6 | 28.6 | 34.8 | 45.11 | 5.3 | 22 |
| new-4 | 35.0 | 29.7 | 35.3 | 45.69 | 4.2 | 16 |

`js/busy` — JS as a share of non-idle time — is the statistic that carries the result: raw
`js %` moves with how much idle the scene leaves (sd 1.5), while `js/busy` normalises that out.

- **baseline** n=3: median **47.96 %** (sd 0.56, range 47.15-48.23)
- **new** n=4: median **45.52 %** (sd 0.29, range 45.11-45.71)

The ranges do not overlap; the gap between the worst new arm and the best baseline arm is
1.44 pp. **Δ = −2.44 pp of busy time, i.e. −5.1 % of the JS share of the worker's work**,
against a within-arm spread of 0.3-0.6 pp. Proxy samples: **253 → 17 (−93 %)**.

**Where it went.** FPS did not change and could not: the title is vsync-locked, so the saved
time became idle (38.7 → 40.5 % on the paired captures). This is headroom, not frame rate. On
a title that is CPU-bound rather than capped the same saving would appear as throughput; that
was not measured.

**Which sites.** The baseline arm's caller table names exactly what was converted —
`_handlePortWriteSlow` 46.3 %, `VertexConverter.convertCPU` 25.0 %, `handlePortWrite` 15.2 %,
`drawIndexedPrimitive` 9.2 %. All four are absent from the new arm, whose residue is a map of
what is left: `validateReturnAddr`, `validateViewportStruct`, `parkThreadAsync`, `resume`,
`restoreFpuSimdState`. `convertCPU` + `drawIndexedPrimitive` = 34 % of the baseline cost is
the stage-4 change alone (the vertex path indexing a Proxy per element).

**Correctness oracles over the run:** `gpuErrors.total` 0, `stubs()` 0, no
`FAST PATH GREW GUEST MEMORY` report.

## A second workload where the class is invisible

Quake II, in-game: **wasm 85.5 %, js 3.0 %, idle 11.3 %**. The proxy census is 24 vs 25
samples between arms — nothing to measure, correctly. The A/B switch was still visible in the
census (`applyContextStateViaProxy` appears only in the baseline arm), so the null is a real
null and not a broken arm. Whether this change is worth anything is a property of the title,
not of the change: it pays where the dispatcher is hot and is free where the guest is.

## Stage 5 is now unblocked by data

The whole question was how often the WASM buffer identity actually changes.
`report().wasmGrowth` over a 466 s session: **3 growths, all within the first 17.3 s, then
none for the remaining 7.5 minutes.** v86's `view()` Proxy re-resolves on every access to stay
transparent across an event that happened three times in eight minutes, all during load.
Replacing it with a plain view plus an explicit `rebind_views()` would retire the remaining
230 pinned sites without touching one of them.

## Open

- Measured on ONE title (Re-Volt) plus one null (Quake II). The archived Glide / Satinav /
  Far Cry baselines were not re-measured under the arms.
- The saving is headroom on a vsync-locked title. Nothing here shows what it is worth on a
  CPU-bound one.
- The armed arm is a REPRODUCTION of the pre-change cost, not the pre-change code. It is
  faithful by construction (the same reads, at the same sites) and it understates rather
  than exaggerates: a handler that already unwrapped the Proxy by hand stays fast in it.
- `validate-jit-exports` fails on a stale `vendor/v86/build/v86.wasm`, and
  `tools/runtime-test/*.mjs` need `V86_TEST_BINARY`. Both predate this work.
