# Catching unimplemented imports cheaply — research & recommendation

**Date:** 2026-09-06
**Context:** After the Worms Armageddon `0xC06D007F` delay-load crash (root cause: 5 unimplemented
delay-load exports — `shlwapi:PathMatchSpecA/ColorHLSToRGB/ColorRGBToHLS`, `ole32:OleFlushClipboard/
OleIsCurrentClipboard`), and ahead of porting a large third-party catalog where every new title brings
its own unimplemented imports.
**Question (from Женя):** how do we catch this class cheaply and turn compatibility from
debugging-per-crash into a checklist? Evaluate three directions + propose a better one if it exists.

---

## TL;DR — recommendation

1. **Do first (½–1 day):** fix the *accuracy* of the static coverage index and wire the existing
   `api-census` into the bring-up checklist + a catalog sweep. The scanner already exists and is
   delay-load-aware and bundled-DLL-aware — but it is **currently lying** (see §5): it reports
   fully-implemented modules as unimplemented because it parses source heuristically and does not
   understand custom registration helpers (`bindA`, factory closures). Grounding "what we implement"
   in the **runtime dispatcher's authoritative table** (`getBindingCensus`, §6) instead of source
   scanning fixes both this and the guest-DLL noise, and is the same authority `GetProcAddress`
   resolves against — so "preflight says bindable" becomes "GetProcAddress will resolve it" **by
   construction**.

2. **Do second (~1 day):** add a **safe, gated stub-census run mode** (Женя's direction 2, done
   correctly): when an unimplemented delay-load/GetProcAddress miss occurs, in census mode hand back a
   logging stub that returns the **failure** value (never success) instead of NULL, so one boot
   enumerates *every hole the title actually reaches* — no crash-restart-per-hole. Zero false
   positives by construction (if it was called, it is a real hole).

3. **Skip Женя's direction 1 (hook `__delayLoadHelper2`).** It is redundant: the guest helper already
   calls *our* `GetProcAddress`, which already records every miss, and (as of the WA session) the
   `RaiseException` path already decodes and logs `DELAYLOAD FAIL: dll=… proc=…`. We own the
   chokepoint one layer down; hooking the guest CRT helper is more work (version-specific guest-code
   patching) for strictly less coverage.

**Why this order:** the static checklist (1) triages the whole catalog *without booting* — cheapest
per title, tells you which titles are one-function-away vs twenty — but only after its accuracy bug is
fixed, or it will send you implementing functions that already exist. The runtime stub-census (2) is
the precise, false-positive-free work-order per title, but costs a boot each. Together: static gives
the ceiling, runtime gives the priority.

---

## 1. What this session proved about the premise

- Preflight over-reports **massively** on real catalog titles. Empirically:
  - `worms-armageddon.wgb` → the **5** real holes (clean signal; WA does not bundle shlwapi/ole32).
  - `prince-of-persia-the-sands-of-time.wgb` → **130** "unbindable".
  - `the_longest_journey.wgb` → **146** "unbindable".
  Both PoP and TLJ *run* (gameplay / menu). The 130/146 are dominated by **false positives**: imports
  reached through the game's own bundled `MFC71.dll` / `mfc42.dll` (present as real files in the
  bundle) — mostly MFC's own delay-loaded `wininet` `Ftp*`/`Gopher*`/`Http*` functions that never fire
  unless the game uses MFC networking.
- So "count of unbindable imports" is **not** a usable measure of work. Signal quality depends on
  whether the missing import is from a **system DLL we must HLE** (real) or a **bundled DLL the game
  ships** (noise). Any checklist must subtract bundled-DLL-satisfied imports and rank by
  likelihood-of-being-called.

---

## 2. What already exists (inventory — a lot)

| Capability | Where | Notes |
|---|---|---|
| **PE import parser, delay-aware** | `packages/formats/src/pe/index.ts` `parsePeImports` | Parses **both** the normal import dir (1) **and** the delay-load dir (13), handling the VC6 VA-vs-RVA `grAttrs & 1` bias. `PeImportedDll.delayLoad` flag. This is solid; reuse it. |
| **Boot-gate scanner** | `tools/preflight-imports.ts` | Walks every PE in a bundle, replays `APIRegistry.getArgCount`, flags `unbindable` + `WRONG ARITY`. **But** does not use the `delayLoad` flag (reports delay imports as "fails PE load", which is false) and does not subtract bundled DLLs → noisy (§1). |
| **Ranked work-order census** | `tools/api-census.ts` + `src/worker/tools/import-census.ts` | The *smart* tool: statuses `implemented / silent-stub / unimplemented / guest-dll / no-hle / delay-gap / abi-gap`; **already** classifies bundled-DLL imports as `guest-dll` and delay-load-no-impl as `delay-gap`; **already counts call sites** ("2 call sites" / "no direct call site"). |
| **"What we implement" index** | `src/worker/tools/api-coverage.ts` `ApiCoverageIndex.load()` | Cross-refs `api/*.api.ts` (declared) vs `modules/*` (implemented) by **scanning source**. **This is the weak link — §5.** |
| **Runtime miss registry** | `src/worker/core/diagnostics/get-proc-address-registry.ts` | Records **every** `GetProcAddress` miss through one chokepoint (`finish()` in `module.ts`), kinds `hle/silent-stub/stub/guest/null`. Surfaced by `getProcMisses` verb, fault report, and the "Game exited" dialog. **Ring is only 32 entries** → evicts (why WA's was empty by the time we looked). |
| **Delay-load failure decode** | `src/worker/modules/kernel32/exception.ts` (added this session) | On `0xC06D007E/7F` decodes `DelayLoadInfo*` → logs `DELAYLOAD FAIL: dll=… proc=…`. |
| **Unimplemented-return policy** | `src/worker/core/thunking/unimplemented-return.ts` | A declared-but-unimplemented export returns **FAILURE (0)** by default, overridable per-descriptor (`hresult/mmresult/mcierror/win32Status/…`). The machinery direction 2 needs already exists. |
| **Runtime authoritative handler set** | `thunk-dispatcher.ts:639` `getBindingCensus()` → `implemented: string[]` | The dispatch table + registrations — the same authority `GetProcAddress` resolves against. **Ground truth**, immune to source-parse blind spots. Underused. |

There is **no import-coverage step in `bun run gate`**; both bundle tools are manual.

---

## 3. Direction 1 — intercept `__delayLoadHelper2` / `ResolveDelayLoadedAPI`

**Effort:** medium-high. **Payoff:** low (redundant). **Recommendation: skip.**

- Nothing intercepts the guest helper today, and it doesn't need to: the helper is guest CRT code that
  calls *our* `LoadLibrary` + `GetProcAddress`. We already own that chokepoint. A miss is already
  recorded in `getProcAddressRegistry`; the resulting `0xC06D007F` is already decoded to
  `DELAYLOAD FAIL: dll=… proc=…`. The "readable module:function in the log" this direction asks for
  **already happens**.
- Hooking the helper itself means patching version-specific guest CRT prologues (MSVC 6/7/8/… differ;
  `hle-lib` explicitly does *not* suit complex-state helpers — see CLAUDE.md §3.8). More work, more
  fragility, and it would see *only* delay-loads — whereas the `GetProcAddress` chokepoint one layer
  down already covers delay-load **and** `LoadLibrary`+`GetProcAddress` dynamic resolution uniformly.
- **The cheap, strictly-better equivalent** (part of the "do first"): make the *existing* miss loud and
  durable — promote a miss to a one-line `WARN` ("IMPORT HOLE: dll:proc [delay-load], N calls"),
  enlarge + dedup the 32-entry ring so it never evicts, and keep a persistent report section that
  survives to process exit. ~2–4h, and it subsumes everything direction 1 wanted.

---

## 4. Direction 2 — stub instead of crash, to enumerate all holes in one run

**Effort:** medium-low (machinery exists). **Payoff:** high. **Recommendation: do second — the precise
per-title work-order.**

- Mechanism: add a diagnostic worker flag (e.g. `__importCensusMode`). When `GetProcAddress` would
  return NULL for an unimplemented HLE export, in this mode synthesize a stub address whose handler
  logs `(dll, func, caller)` and returns the export's **`onUnimplemented` failure value** (0 /
  E_NOTIMPL / …). The guest's delay helper then gets a non-NULL address → no `0xC06D007F` → the title
  keeps running and hits the *next* hole. One boot yields the full batch, ranked by call count via
  `getProcAddressRegistry`.
- **The danger Женя flagged is real and the design must respect it:** a stub that returns *success*
  produces silently-wrong behavior instead of an honest failure. **Mitigation, non-negotiable:**
  (a) return the **failure** value, never success — this is *exactly* as safe as our existing
  declared-but-unimplemented behavior, no more dangerous; (b) **diagnostic-mode-only**, gated behind a
  flag, **never shipped** — shipping blanket stubs would convert honest crashes into silent
  data-corruption across the catalog, the opposite of the Prime Directive.
- **Honest caveat:** returning failure can still provoke a *different* downstream crash (a title that
  NULL-derefs the failed return). So a single run isn't guaranteed to reach the end — but each run
  harvests a **batch** of holes instead of one, converging in a few iterations vs one-per-ERRORLOG.
  That is the whole win: it kills the crash-restart-per-hole loop.
- **Zero false positives** by construction: if the stub was invoked, the guest really called it. This
  is the key advantage over every static approach (§5).

---

## 5. Direction 3 — pre-flight scanner as the checklist — and its hidden accuracy bug

**Effort to make trustworthy:** medium. **Payoff:** high (catalog-scale triage without booting).
**Recommendation: do first — but fix the accuracy bug, don't just run it.**

The capability is ~80% built (`api-census` is delay-aware, guest-dll-aware, counts call sites). The
gap is **not** parsing — it's **trust**. Proven this session:

- `ApiCoverageIndex` reports **fully-implemented** shlwapi functions as `declared-stub`
  (= not implemented). Direct query:

  ```
  PathFindFileNameA      declared-stub     ← implemented for years
  PathFileExistsA        declared-stub     ← implemented for years
  PathStripToRootA       declared-stub     ← implemented for years
  PathMatchSpecA         declared-stub     ← implemented this session
  ColorHLSToRGB          declared-stub     ← implemented this session
  ColorRGBToHLS          declared-stub     ← implemented this session
  ```

- **Root cause:** `shlwapi.ts` registers its whole export table through a *local* helper
  `bindA("Name", fn, cleanup)`. `api-coverage.ts`'s `scanExtraExports` understands `exports['X'] =`,
  `registerFastPath`, object literals, `Object.assign` merges — but **not** an arbitrary custom
  closure like `bindA`. So the entire module reads as unimplemented. `api-census` on WA therefore
  buries the real holes (`ColorHLSToRGB`, `ColorRGBToHLS`) among ~dozens of **false** "missing" rows
  and de-prioritizes them (delay-gap = severity 4).

- This is the project's own documented failure class — *an instrument that reports a plausible number
  while measuring something other than its label* (memory: "Instruments that cannot fail loudly").
  A checklist built on it would send someone to re-implement `PathFindFileNameA`.

**Two ways to fix, and one is strictly better:**
- Teach the source scanner every registration idiom (`bindA`, and the next module's custom factory,
  and the one after that). Whack-a-mole; guaranteed to rot again.
- **Ground "implemented" in runtime, not source (§6).** The dispatcher already knows the exact
  `(dll, func)→handler` set after `initialize()`. Diff a bundle's parsed imports against *that*.

Two smaller, concrete refinements once trust is restored:
- **`delay-gap` severity is miscalibrated for the crash question.** It is ranked lowest because "the
  loader never walks the delay directory, so it cannot block load" — true for *load*, false for
  *runtime*: a delay-gap that is **actually called** is a hard `0xC06D007F` crash (exactly WA). Re-rank
  delay-gaps **with call sites** to top severity; the call-site count the census already computes is
  the signal.
- **Deprecate `preflight-imports` in favor of `api-census`** (or make preflight consume census's
  classification). Preflight's "unbindable = fails PE load" is wrong for the delay + bundled-DLL cases
  that dominate real bundles (§1).

**Static's inherent limit:** it lists imports that *exist in the tables*, not imports the game
*calls* — a title imports hundreds it never touches. Static is a safe **superset** (never misses a
real hole) but noisy; runtime (§4) is the exact **subset** actually hit. This is why they're
complementary, not competing.

---

## 6. Fourth approach (recommended core) — ground coverage in the runtime dispatcher, not source

Both static tools rest on the same fragile foundation: *scan our TypeScript to guess what we
implement.* §5 shows that foundation is provably wrong for at least one whole module and will keep
breaking as registration idioms multiply. The fix that dissolves the problem:

**Boot the worker once headless, let every module `initialize()`, dump the dispatcher's authoritative
handler set (`getBindingCensus().implemented`), and diff each bundle's delay-aware parsed imports
against *that* set** (minus exports satisfied by DLLs the bundle actually ships).

Why this is the right primitive:
- **Same authority as the real resolver.** `getBindingCensus` reads the live `dispatchTable` +
  registrations — the exact structure `GetProcAddress` walks. So "preflight says bindable" ≡
  "`GetProcAddress` will resolve it at runtime," by construction — no drift, no idiom-scanning.
- **Immune to §5.** `bindA`, factory closures, future patterns — all produce real dispatch entries,
  so all are seen. No scanner maintenance, ever.
- **Cheap.** `getBindingCensus` already exists; the delay-aware parser already exists; the guest-DLL
  subtraction logic already exists in the census. This is ~a day of *wiring*, not building.
- **One snapshot serves the whole catalog.** Dump the implemented set once; diff N bundles against the
  cached snapshot offline. Turns catalog triage into a table: per title, the ranked list of
  system-DLL exports we don't yet bind, call-site-weighted.

Then layer the runtime stub-census (§4) on top for the titles the static pass flags as "needs work":
static says *what could be called*, the one-boot stub run says *what actually is*, ranked.

---

## 7. Recommended sequence & effort

| Step | What | Effort | Payoff |
|---|---|---|---|
| **1a** | Ground `ApiCoverageIndex`'s "implemented" set in `getBindingCensus()` (runtime dump) instead of source scanning; keep source scan only as a fallback for un-booted modules | ~1 day | Fixes the §5 lie; makes every static tool trustworthy |
| **1b** | Wire `api-census` into the `/bringup` checklist + a `--queue` catalog sweep that emits a ranked per-title report; re-rank called delay-gaps to top | ~½ day | Catalog triaged without booting; would have named WA's 5 pre-boot |
| **1c** | Make the runtime miss loud + durable (WARN line, un-evicting deduped ring, persistent report section). Subsumes direction 1 | ~2–4h | Any hole that slips to runtime is one grep, not an ERRORLOG dig |
| **2** | Safe gated stub-census run mode (failure-returning, never shipped) | ~1 day | Precise, false-positive-free per-title work-order in one boot |
| **—** | Direction 1 (hook the guest helper) | — | Skip: redundant with 1c |

**If only one thing:** step **1a** (ground coverage in runtime authority). It is the root fix — without
it, the "checklist" that this whole request is about actively misleads. With it, `api-census` becomes
the honest pre-boot triage the catalog port needs, and the stub-census (2) becomes the precise
follow-up. Neither preflight nor census is safe to trust as-is today; that is the headline.
