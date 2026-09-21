# Census B — presenter kinds across the `.wgb` library

Stage 8.0 of `render-worker-plan-2026-09-11.md`, row 10 of its §12 checklist. Answers one
question: **stage 1 carries the D3D9 executor off the guest thread and refuses everything else
(§4) — how many titles in the library does that refuse?**

Static pass, no boot. Tool: `tools/census-presenter-kinds.ts`. Repo `eee6ffb`, scanned
2026-09-11.

```
bun tools/census-presenter-kinds.ts G:/WGB/running G:/WGB/prod-library
bun tools/census-presenter-kinds.ts G:/WGB/running G:/WGB/prod-library --out census-b.json
bun tools/census-presenter-kinds.ts --selftest          # the failure proofs below
```

Scan cost: **62 bundles, 49.2 GB of archives, 1138 32-bit PEs parsed — 3.0 s warm, 14 s cold.**
One file descriptor per bundle, central directory once, range reads for PE entries only. PE32+
images are excluded (31 of them, all in `satinav`): a 64-bit image cannot execute in the guest,
so a creation call inside one is not an entry point any session reaches.

## Counts

| Bucket | N | Meaning for stage 1 |
| --- | ---: | --- |
| CARRIED | 4 | d3d9 is the only creation call in the bundle |
| REFUSED | 28 | at least one ddraw/glide/opengl creation call, no d3d9 |
| UNCERTAIN | 29 | — |
| … mixed d3d9 + a refused kind | 8 | both calls exist; which one presents is a runtime fact |
| … d3d8 only | 3 | presents as `d3d8`; see the D3D8 note |
| … string-tier candidates only | 18 | renderer is `LoadLibrary`'d; static evidence is a candidate set |
| UNKNOWN | 1 | no creation symbol and no renderer literal anywhere |
| ERROR | 0 | a bundle that could not be read at all |

**The decision-grade number: 4 of 62 bundles (6%) reach only a d3d9 creation call, 28 of 62
(45%) reach a ddraw/glide/opengl one and no d3d9, and 30 of 62 (48%) cannot be decided without
a boot.** This is a DirectDraw/Glide library with a D3D9 minority; §4's loud-refusal path is
the common case, not the exception.

"Reaches a creation call" is NOT "presents with that kind", and the difference is not a rounding
error: **two of the four CARRIED rows and one REFUSED row are decided by a PE the game never
loads** — see "What this census cannot answer" §1 and §6. Do not pick the stage-1 stand off
this table without booting the candidate.

Bounds, not estimates: even if every UNCERTAIN row resolved to d3d9 the ceiling is 33/62, and
the floor stays 4/62. Nothing here narrows that range — only the Observed column does.

## Detection rules

Presenter kind at runtime is `PresenterKind` in `src/worker/runtime/runtime-services.ts:83`,
set by `RenderService.notifyPresent` (:221), read as `report().render.presenter`. It is **per
PRESENT, not per session** — a D3D9 title legitimately also presents `video` (Bink intro) and
`gdi` (dialog composite). So the static question is not "what is the kind" but "which graphics
creation entry points will this bundle reach", and the answer is a SET.

| Rule | Signal | Weight |
| --- | --- | --- |
| R1 import | a CREATION symbol in an import table: `Direct3DCreate9/9Ex`, `Direct3DCreate8`, `DirectDrawCreate/Ex/Clipper`, `grSstWinOpen/grGlideInit`, `wglCreateContext` | decides |
| R2 effective module | a shipped copy of an HLE-owned DLL (`HLE_ONLY_DLLS`, `src/worker/core/pe-loader.ts`) never executes unless `manifest.emulator.appDirDlls` names it; `disabledDlls` drops candidates; names normalised through `resolveThunkedDllAlias` | kills or revives an R1 record |
| R3 string | renderer DLL literals, scanned in latin1 AND utf16le, case-insensitively | widens a candidate set, never decides |

Scope of "a PE in the bundle": every entry with a PE extension that parses as a 32-bit image,
whatever directory it sits in. PE32+ images are skipped as unreachable. The census does **not**
know which PEs a session actually loads — the manifest entrypoint is not used as a filter, which
is what limits 1, 6 and 7 below are about.

The imported DLL **name** never decides anything: most of the library names `ddraw.dll` and
never creates a DirectDraw object. `DirectDrawEnumerate*` is explicitly not a presenter — a
D3D9 title enumerating displays would otherwise be refused.

R2 is what stops the wrapper class from reading as D3D9. Shipped glide→D3D9 and ddraw→D3D9
wrappers import `Direct3DCreate9`, and every one of them is dead code under our loader:

```
carmageddon2_full  glide2x.dll → Direct3DCreate9  [DEAD]   (HLE-owned, not in appDirDlls)
starwars-racing    ddraw.dll   → Direct3DCreate9  [DEAD]
tiberian-sun       ddraw.dll   → wglCreateContext [DEAD]
gta3-ru            d3d8.dll    → Direct3DCreate9  [runs]   (appDirDlls: ddraw, d3d8)
gta3-ru            gta3.exe    → Direct3DCreate8  [runs, wrapped-by d3d8.dll]
```

`gta3-ru` is the only bundle in the library that app-dir-overrides a graphics DLL, so R2's
live branch is exercised by exactly one title — which is why it also has a synthetic fixture
(F4 below). The `HLE_ONLY_DLLS` list is parsed out of `pe-loader.ts` at run time rather than
copied: a copy would drift silently and invert precisely these verdicts.

## D3D8 is not a verdict

`D3D8DeviceAdapter` sends FFP draws to the **ddraw** executor and shader draws to a private
`D3D9BackendExecutor` (`d3d8-programmable-draw.ts:98`), and presents as `"d3d8"`
(`d3d8-device-adapter.ts:2459`). A d3d8 bundle is therefore carried only if it is wholly
programmable, which no static pass can know. The three d3d8-only rows (morrowind, farm-frenzy-ru,
xiii) are reported UNCERTAIN with that reason, never counted as carried or refused.

## Per-bundle detail

`Kinds` prefixed with `?` are string-tier candidates (R3), not creation calls. `(+N)` is the
number of further evidence records in the JSON. `Observed` is filled from a real boot
(`report().render.presenter` collected as a SET over a session) and is **empty on purpose** —
see "What is still owed".

| Bundle | Verdict | Kinds | Tier | Evidence (PE → symbol) | Observed |
| --- | --- | --- | --- | --- | --- |
| deponia | CARRIED | d3d9 | import | `configtool/libGLESV2.dll` → `Direct3DCreate9` | — |
| house-1000-doors | CARRIED | d3d9 | import | `FBNCore.dll` → `Direct3DCreate9` | — |
| painkiller-black | CARRIED | d3d9 | import | `D3Dev.dll` → `Direct3DCreate9` (+1) | — |
| the-dark-eye-chains-of-satinav | CARRIED | d3d9 | import | `configtool/libGLESV2.dll` → `Direct3DCreate9` | — |
| american-mcgee-alice | UNCERTAIN | ?ddraw+glide+opengl | string | `Autoplay.exe` → `DDraw.dll` (+5) | — |
| blackwell-legacy | UNCERTAIN | ?d3d9+opengl | string | `Blackwell Legacy.exe` → `d3d9.dll` (+3) | — |
| bod | UNCERTAIN | d3d9+ddraw+opengl | import | `Blade.exe` → `DirectDrawCreate` (+11) | — |
| carmageddon2_full | UNCERTAIN | d3d9+ddraw | import | `Carma2_SW.exe` → `DirectDrawCreate` (+5) | — |
| far-cry | UNCERTAIN | d3d9+ddraw | import | `XRenderD3D9.dll` → `Direct3DCreate9` (+2) | — |
| farm-frenzy-ru | UNCERTAIN | d3d8 | import | `farm.exe` → `Direct3DCreate8` | — |
| gothic | UNCERTAIN | d3d9+ddraw | import | `GothicMod.exe` → `DirectDrawCreateEx` (+1) | — |
| gta3-ru | UNCERTAIN | d3d9+ddraw | import | `d3d8.dll` → `Direct3DCreate9` (+2) | — |
| harry-potter | UNCERTAIN | ?d3d8+ddraw+glide+opengl | string | `Harry Potter_EZ.exe` → `DDraw.dll` (+5) | — |
| harry-potter-cos | UNCERTAIN | ?d3d8+ddraw+opengl | string | `Go_EZ.exe` → `DDraw.dll` (+4) | — |
| harry-potter-demo | UNCERTAIN | ?ddraw | string | `WinDrv.dll` → `ddraw.dll` (+1) | — |
| max-payne | UNCERTAIN | ?d3d8+ddraw | string | `MaxPayne.exe` → `D3D8.DLL` (+2) | — |
| max-payne-demo | UNCERTAIN | ?d3d8+ddraw | string | `MaxPayneDemo.exe` → `D3D8.DLL` (+2) | — |
| montezuma | UNCERTAIN | ?d3d8 | string | `monezuma.exe` → `D3D8.DLL` | — |
| morrowind | UNCERTAIN | d3d8 | import | `Morrowind Launcher.exe` → `Direct3DCreate8` (+2) | — |
| nfs-underground | UNCERTAIN | d3d9+ddraw | import | `EasyInfo.exe` → `DirectDrawCreate` (+4) | — |
| nfs-underground-demo | UNCERTAIN | d3d9+ddraw | import | `speeddemo.exe` → `Direct3DCreate9` (+1) | — |
| re-volt-beta | UNCERTAIN | ?ddraw | string | `revolt.exe` → `DDRAW.dll` | — |
| re-volt-demo | UNCERTAIN | ?ddraw | string | `revolt.exe` → `DDRAW.dll` | — |
| re-volt_full | UNCERTAIN | d3d9+ddraw | import | `d3drm.dll` → `DirectDrawCreate` (+5) | — |
| red-faction | UNCERTAIN | ?d3d8+ddraw | string | `binkw32.dll` → `DDRAW.DLL` (+4) | — |
| serious-sam-the-first-encounter | UNCERTAIN | ?d3d8+opengl | string | `Engine.dll` → `D3D8.DLL` (+1) | — |
| starcraft | UNCERTAIN | ?ddraw+opengl | string | `Local.dll` → `ddraw.dll` (+6) | — |
| starcraft_demo | UNCERTAIN | ?ddraw | string | `Local.dll` → `ddraw.dll` (+3) | — |
| system-shock-ii | UNCERTAIN | ?d3d9+ddraw | string | `D3DX9_43.dll` → `d3d9.dll` (+2) | — |
| thief-gold | UNCERTAIN | ?ddraw | string | `DROMED.EXE` → `ddraw.dll` (+1) | — |
| unreal-gold | UNCERTAIN | ?ddraw+glide+opengl | string | `dsetup.dll` → `DDRAW.DLL` (+5) | — |
| ut_demo | UNCERTAIN | ?ddraw+glide+opengl | string | `D3DDrv.dll` → `ddraw.dll` (+4) | — |
| xiii | UNCERTAIN | d3d8 | import | `D3DDrv.dll` → `Direct3DCreate8` | — |
| airfix-dogfighter-demo | REFUSED | ddraw | import | `AfEngine.dll` → `DirectDrawCreate` (+2) | — |
| cossacks-european-wars | REFUSED | ddraw | import | `dmcr.exe` → `DirectDrawCreate` | — |
| cossacks-european-wars-skip-video | REFUSED | ddraw | import | `dmcr.exe` → `DirectDrawCreate` | — |
| d2_demo | REFUSED | ddraw | import | `D2DDraw.dll` → `DirectDrawCreate` (+2) | — |
| diablo2_full | REFUSED | ddraw | import | `Game.exe` → `DirectDrawCreate` | — |
| discworld-noir | REFUSED | ddraw | import | `TIN3_DXD.EXE` → `DirectDrawCreate` | — |
| gta-vice-city | REFUSED | d3d8+ddraw | import | `gta-vc.exe` → `DirectDrawCreateEx` (+1) | — |
| hitman-codename-47 | REFUSED | ddraw+opengl | import | `RenderD3D.dll` → `DirectDrawCreateEx` (+2) | — |
| hl-day-one | REFUSED | ddraw | import | `hl.exe` → `DirectDrawCreate` (+1) | — |
| hl-uplink | REFUSED | ddraw | import | `hldemo.exe` → `DirectDrawCreate` (+1) | — |
| hl-uplink-skipvideo | REFUSED | ddraw | import | `hldemo.exe` → `DirectDrawCreate` (+1) | — |
| homm3_demo | REFUSED | ddraw | import | `h3demo.exe` → `DirectDrawCreate` | — |
| homm3_full | REFUSED | ddraw | import | `Heroes3.exe` → `DirectDrawCreate` | — |
| krush-kill-n-destroy-2-krossfire | REFUSED | ddraw | import | `KKND2.exe` → `DirectDrawCreate` | — |
| mafia | REFUSED | d3d8+ddraw | import | `LS3DF.dll` → `Direct3DCreate8` (+2) | — |
| natalie-brooks | REFUSED | ddraw | import | `NatalieBrooksSTH.exe` → `DirectDrawCreateEx` | — |
| nfs-porsche | REFUSED | ddraw | import | `dx7z.dll` → `DirectDrawCreate` (+7) | — |
| overboard-demo | REFUSED | ddraw | import | `OB.EXE` → `DirectDrawCreate` | — |
| porsche-unleashed-demo | REFUSED | ddraw | import | `Porsche.exe` → `DirectDrawCreate` (+3) | — |
| quake2 | REFUSED | ddraw | import | `pvrgl.dll` → `DirectDrawCreate` | — |
| seadogs | REFUSED | ddraw | import | `Config.exe` → `DirectDrawCreate` (+1) | — |
| starwars-racing | REFUSED | ddraw | import | `SWEP1RCR.EXE` → `DirectDrawCreate` (+1) | — |
| thps2-demo | REFUSED | ddraw | import | `THawk2.exe` → `DirectDrawCreateEx` | — |
| tiberian-sun | REFUSED | ddraw | import | `Game.exe` → `DirectDrawCreate` (+2) | — |
| titbit | REFUSED | opengl | import | `titbit.exe` → `wglCreateContext` | — |
| tr2 | REFUSED | ddraw | import | `Tomb2.exe` → `DirectDrawCreate` (+1) | — |
| warcraft3-demo | REFUSED | opengl | import | `Game.dll` → `wglCreateContext` | — |
| worms-armageddon | REFUSED | ddraw+opengl | import | `WA.exe` → `DirectDrawCreate` (+2) | — |
| alice greenfingers | UNKNOWN | — | — | none | — |

Roots: `G:/WGB/running` (49) and `G:/WGB/prod-library` (13). `G:/WGB/todo` is a staging area
and is deliberately not counted; re-run the tool over it when a bundle graduates. Full evidence
per row, including every DEAD and wrapped record, is in the tool's `--out` JSON.

## What this census cannot answer

1. **Reachability.** A creation call in a shipped PE is not proof the game reaches it. Known
   instances in this table: far-cry's ddraw comes only from PunkBuster (`pbcl.dll`,
   `pbcls.dll`); seadogs' from `Config.exe`; nfs-underground's from `3DSetup.dll` and
   `EasyInfo.exe`; re-volt_full's d3d9 from `dxcfg.exe`; quake2's from the optional `pvrgl.dll`
   renderer plugin, while the game actually presents `gdi` through its software renderer. Static
   analysis cannot decide these; only the Observed column can.
2. **Runtime renderer probes.** Unreal-1 class engines choose `RenderDevice` at run time and the
   bundle's `.ini` is not authoritative — harry-potter-demo's `Default.ini` names
   `GlideDrv.GlideRenderDevice` while the bundle ships no `GlideDrv.dll`. R4 (config tiebreak) is
   deliberately NOT implemented for that reason; the 18 string-tier rows stay candidate sets.
3. **Packed and encrypted payloads.** alice greenfingers is a Reflexive wrapper that decrypts the
   real image into a suspended child, so the renderer imports exist only in memory — hence
   UNKNOWN, not a guess. UPX-packed PEs are named as `opaque` in the note of each affected row
   (cossacks ×2, gothic, gta3-ru, natalie-brooks, quake2, red-faction, system-shock-ii).
4. **Per-present kinds.** `gdi` and `video` presents are produced by titles of every kind and are
   invisible here by construction. They are also the reason the §4 wording needs fixing (below).
5. **Ordinal imports.** A creation call imported by ordinal carries no name and is missed. No row
   in this table is known to do it, but nothing rules it out.
6. **The OpenGL creation call is usually not `wglCreateContext`.** R1 recognises only that symbol,
   and a title that lets SDL/a loader create the context binds the rest of `opengl32` by name and
   never imports it. Measured over the library: **4 bundles import `opengl32` functions in a PE
   that runs yet carry no `opengl` in kinds or candidates** — `deponia` (`deponia.exe`, 25
   imports incl. `glDrawElements`/`wglGetCurrentDC`), `the-dark-eye-chains-of-satinav`
   (`satinav.exe`, 26), `far-cry` (`XRenderOGL.dll`), `tiberian-sun` (its shipped `ddraw.dll`,
   which R2 kills anyway). Two of them are CARRIED rows, so this blind spot sits exactly where
   the gate reads.
7. **A false import-tier hit silences the string tier.** R3 runs only when R1 produced nothing,
   so one creation call anywhere in the bundle suppresses the literal scan for the whole bundle.
   `deponia` and `satinav` are CARRIED on `rom/configtool/libGLESV2.dll` — the ANGLE copy inside
   a Qt **configuration utility**, a program the game never loads — and because that counted as a
   decision, their own exes' `OPENGL32.DLL` and `d3d9.dll` literals were never collected. Both
   titles do run D3D9 (`satinav-bringup`, `deponia-bringup`), but for a reason this census
   refuses to read: the bundle's `config.ini` sets `Device = DX9` over an engine that defaults to
   OGL. The bucket is right and the evidence behind it is not; had the bundle kept the default,
   the verdict would have been identical. **Fixing 6 and 7 is owed before these counts are
   quoted as a gate.**

## Failure proofs (CLAUDE.md §4: a validator that cannot fail is worse than none)

Every mechanism below was executed and its red result recorded. `bun tools/census-presenter-kinds.ts --selftest`
re-runs all of them (it builds synthetic `.wgb` fixtures with the repo's own `ZipStoreWriter`
and hand-assembled PE import tables).

| # | Bypass fed to it | Observed failure |
| --- | --- | --- |
| F1a | nonexistent path | `census-presenter-kinds: no such path: G:/WGB/running/no-such-game.wgb`, exit 2 |
| F1b | directory with no `.wgb` | `census-presenter-kinds: no .wgb found in the given paths`, exit 2 |
| F1c | first 400 KB of a real bundle | row `trunc [ERROR] ERROR: EOCD not found` + `1 bundle(s) could not be censused`, exit 1 |
| F1d | bundle with no `manifest.json` | `ERROR — no manifest.json in the bundle` |
| F1e | bundle whose PEs carry no graphics signal | `UNKNOWN — no creation symbol and no renderer literal in 1 PE(s)` (a printed outcome, not an empty row) |
| F2 | — | a non-UNKNOWN verdict with zero evidence records throws `internal: <bundle> got verdict X with no evidence records` |
| F3 | doc rows with a planted wrong Observed cell | `VERIFY FAIL painkiller-black: static CARRIED (d3d9) contradicts observed ddraw` / `VERIFY FAIL quake2: static REFUSED (ddraw) contradicts observed d3d9`, exit 1, while the honest `tr2` row passed |
| F3b | a copy of THIS doc with `painkiller-black`'s Observed set to `glide` and `tr2`'s to `ddraw + gdi` | `VERIFY FAIL painkiller-black: static CARRIED (d3d9) contradicts observed glide`, exit 1 — and `tr2` passed, so the real table below is parseable and `gdi` is correctly ignored |
| F3c | the same contradiction typed in caps (`DDRAW`) | `VERIFY FAIL`, exit 1. Before the case fix this cell was silently dropped and the run printed `0 contradiction(s)` |
| F3d | an Observed cell the vocabulary cannot parse (`d3d9 (menu)`) | `VERIFY UNREADABLE`, counted as a failure: an observation the oracle cannot read is not an observation that agrees |
| F3e | an Observed cell that no verdict pair can contradict (`gdi` alone against a REFUSED row; any cell against an UNCERTAIN/UNKNOWN row) | `VERIFY UNCHECKABLE`, counted and printed separately, so `0 contradictions` can never stand alone |
| F3f | an Observed cell naming a bundle outside the scan | `VERIFY UNMATCHED`, counted |
| F4a | shipped ddraw wrapper WITHOUT `appDirDlls` | verdict stays CARRIED, and the dead record is still reported as evidence |
| F4b | same bundle WITH `appDirDlls: ["ddraw"]` | verdict flips to UNCERTAIN `d3d9+ddraw` — the R2 rule's own test |
| F4c | uppercase `OPENGL32.DLL` literal | seen, and only as a candidate: `UNCERTAIN kinds=- candidates=opengl` |
| F5a | a `pe-loader.ts` with no `HLE_ONLY_DLLS` | `HLE_ONLY_DLLS not found in <file> … refusing to guess.` |
| F5b | an `HLE_ONLY_DLLS` missing `ddraw` | `HLE_ONLY_DLLS in <file> no longer lists "ddraw" — every wrapper verdict would flip; refusing to guess.` |

F3's first implementation found the Observed column **by cell shape**, matched the Kinds column
instead, compared the static verdict to itself and passed both planted contradictions. Locating
the column by its header closed that, and F3c–F3f close the same class in its other spellings:
an adversarial pass planted `DDRAW` against a CARRIED row plus `gdi` against `quake2` and got
`2 bundle(s) had an Observed kind set; 0 contradiction(s)`, exit 0. Every filled cell now lands
in one of four counters. F4c exists because the string tier was case-sensitive and reported
Serious Sam — an OpenGL title — as having no renderer literal at all.

What the oracle still cannot see, stated so it is not read as coverage: a REFUSED row is only
contradicted by an observation containing `d3d9` and no refused kind, so `warcraft3-demo`
(static `opengl`, bring-up notes say it runs D3D8) passes as `checked`; and `--verify` can decide
nothing at all for the 30 UNCERTAIN/UNKNOWN rows.

## What is still owed

- **Two detection-rule fixes, before these counts are quoted as a gate** (limits 6 and 7): an
  `opengl32` function import in a PE that runs is an opengl signal, `wglCreateContext` or not;
  and the string tier must not be gated on the import tier, so a candidate set is published even
  when one PE somewhere in the bundle produced a creation call. Both change rows, so both are a
  re-run plus a rewrite of the table, not an edit.
- **Observed column.** Every cell is `—`. Filling it is a boot per bundle
  (`openWgb` → `tickFrames` → record the SET of `report().render.presenter` values), then
  `--verify docs/performance/render-worker-census-b.md` until static and observed agree or the
  disagreement is written down as a named rule limit. Priority rows: the 4 CARRIED, plus the 6
  where bring-up notes already suggest the static reading is incomplete — system-shock-ii
  (string-tier only, known D3D9), gothic (mixed, known DirectDraw/D3D7), far-cry (mixed, known
  XRenderD3D9), warcraft3-demo (opengl statically, run on D3D8), quake2 (ddraw statically,
  presents `gdi`), gta3-ru (mixed, d3d8to9 → d3d9).
- **Plan §4 wording (owner: the plan doc's track).** Lines 386–391 say a session "in which a
  non-D3D9 presenter is created" must fail loudly, while the same paragraph carries the GDI
  overlay and the video plane into stage 1. Read literally, `gdi` and `video` presents refuse
  every title, D3D9 ones included. The gate needs to be stated as the refused EXECUTOR set
  {ddraw/D3D7, D3D8, glide, opengl} with gdi+video explicitly kept; until it is, "refused" has
  no stable definition and the counts above cannot be compared to the one the project acts on.
- **A runtime oracle for the refusal itself (another track).** `DDrawWebGPUExecutor` is
  constructed unconditionally in `DDraw.setBackend` (`modules/ddraw/index.ts:196`) for any
  process that merely LOADED ddraw, so "an executor exists" is not a usable refusal trigger — a
  D3D9 title that imports ddraw for `DirectDrawEnumerate` would be refused wrongly. The trigger
  must be first ENCODED WORK / first present by a non-D3D9 executor, and a harness verb exposing
  that set is what the Observed column should read.
