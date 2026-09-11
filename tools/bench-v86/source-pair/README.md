# Source-paired compiler laboratory

One checked-in C++ workload follows two compilation paths:

```
fixture/{kernel,boundary}.cpp + windows.cpp -> MSVC x86 PE -> BottleShip JIT -> captured Wasm
fixture/{kernel,boundary}.cpp + emscripten.cpp -> Emscripten -> direct Wasm
```

This is a correctness and artifact-capture pilot, not an optimizing compiler or an accepted
performance benchmark. The current full-runtime runner uses the existing in-page harness
facade, so it also works when a separate CDP browser cannot be launched.

## Build and run

From the BottleShip repository on Windows, with MSVC and the Windows SDK installed:

```powershell
node tools/bench-v86/source-pair/build.mjs C:/Projects/bottleship-demos/demo_source_pair
node --test tools/bench-v86/source-pair/oracle.test.mjs
node tools/bench-v86/source-pair/verify-native.mjs C:/Projects/bottleship-demos/demo_source_pair
bun tools/bench-v86/source-pair/serve.ts C:/Projects/bottleship-demos/demo_source_pair
```

`EMSDK` overrides `C:/Projects/emsdk`. `VSINSTALLDIR` and `WindowsSdkDir` override the
Visual Studio Community 2022 and Windows SDK defaults. `BUN_EXE` overrides the bundler executable.
The build records the actual tool paths, commands, versions/output, source snapshots and hashes.
Canonical sources are here; `bottleship-demos/demo_source_pair/sources` is a build snapshot.

With the existing Vite dev server on port 5174, open the URL printed by `serve.ts`:

`http://localhost:5174/tools/bench-v86/source-pair/browser.html`

Click **Run full smoke**. The page creates and owns a fresh BottleShip iframe per case, uses
`openWgb`, `fsWrite`, `fsRead`, `jitPublications` and `evalWorker`, and pauses/removes its own
guest after the case. It does not use or reload other game tabs. Stop `serve.ts` with Ctrl+C
when finished. Its result collector is restricted to loopback and the Vite origin, with a
32 MiB request bound. Run only one copy at a time: the served artifact path is shared.

Native execution uses a unique temporary output directory under the build folder. Controlled
guest execution uses a random token in ready/go/result filenames; old overlay results cannot
be mistaken for the current run. No native guest is left running by the native verifier.

## Work and correctness

The scalar kernel blends packed color channels through a 1024-element working set, with a
strided cursor and a rolling carry. All arithmetic is unsigned 32-bit; the experiment avoids
floating-point precision differences and SIMD in its first slice. Input seeds include zero
and `UINT32_MAX`. Inputs arrive at runtime, and the host observes the complete final state.

Every phase calls a separate, non-inlined boundary function. It optionally invokes a platform
service, then mutates data that the next phase consumes. State includes independently checked
operation, phase and service counts. A separate JS scalar interpreter checks every one of the
1033 output words; PE/Emscripten equality alone is not the oracle. Negative controls corrupt
payload and ledger words, skip work and submit invalid input bounds.

| Mode | PE path | Direct Wasm adapter |
|---|---|---|
| 0 | C++ boundary mutation, no service | same mutation |
| 1 | `GetTickCount`, expected Wasm hypercall | synchronous imported clock call |
| 2 | `GetFileAttributesA`, synchronous JS thunk | synchronous imported JS side effect |
| 3 | `Sleep(1)`, park and resume | `emscripten_sleep(1)` with Asyncify |

The adapters deliberately do **not** implement equal-cost host services. Service return values
are excluded from the deterministic data contract. This preserves the payload across platforms
while allowing different boundary mechanisms; it is not a benchmark of API implementation speed.
Asyncify is present in every direct mode, and its cost is not attributed to x86 translation.

Burst sizes count **pixel updates**, not retired x86 instructions. Fixed and seeded-variable
phase schedules are saved in order and as histograms. They are synthetic sensitivity cases,
not a profile calibrated to NFSU or Far Cry. Changing burst size also changes the number of
boundary mutations; only cases with the same seed/operations/burst/variable have identical
payload work across service modes.

## Evidence and limitations

`build.json` points to source snapshots, PE map and source-annotated assembly, PE disassembly
and import/export tables, direct Wasm and WAT. `serve.ts` writes result JSON, checkpoints,
publication records, hash-verified JIT modules and existing `analyze-jit-wasm` reports under
`logs/source-pair-*/`. Missing/unrecognized static patterns stay explicit.

The runner refuses a full case with no newly published PE-text JIT module or a dropped capture.
The complete-state check proves work; publication proves byte provenance. Publication alone
does not prove that a particular module generation executed. Use the existing CDP corpus and
identity tools when execution/sample attribution is needed; do not infer it from table-slot names.

The GetTickCount case additionally checks the real runtime's served/fallback counters against
the independently expected service count. The snapshots include setup/completion around the
payload: for example, final parking adds a Sleep fallback. Do not treat these snapshots as exact
begin/end boundary traces. Sync JS and async cases have state/continuation checks, not a complete
ordered runtime transition ledger.

Direct `loadMs` and `elapsedMs` are labelled cold correctness-smoke observations. The smoke
does not establish a PE throughput ratio, per-frame percentile, or AOT hitch claim.
The embedded browser is recorded by user agent; it is not labelled stock Chrome.

The existing state/exit oracle remains necessary for a real JIT transformation: output equality
on this fixture does not prove x86 flags, fault ordering, SMC/CoW, budget exits or callbacks.

See `docs/performance/source-pair-lab-2026-09-09.md` for the laboratory inventory, first results
and the capabilities still needed before accepting an optimization.

## Offline rotate experiment

`Measure offline rotate variant` runs repeated fixed work using controlled mode 2 of the PE.
Each round reinitializes state before a ready/go handshake. `logPhase` measures host wall time
between the guest's begin/end markers, excluding result-file polling. A/C alternate ABBA in
one warmed engine; every round checks all 1033 state words. Measured rounds refuse fresh JIT
compilations by excluding the whole quartet (at most six attempts for two clean quartets).
They refuse lost function/page ownership and require positive module-entry deltas.

The candidate copies the exact current-engine `ror32` body, including all flag writes, into
the JIT module. It preserves imports, entry points and slots, remaps locals and branch hints,
and refuses an unreviewed engine helper. `aotArtifacts` replaces captured bytes, then the
ordinary AotCache drop/replay path publishes them before warmup and measurement. The A arm
uses the unmodified captured function under the same AOT page registration.

The collector exports each original cache directory. To produce a reusable optimized copy:

```sh
node tools/aot/optimize-cache.mjs <aot-original/index.json> public/v86.wasm <new-output-directory>
```

The full cache version (including RAM base and codegen fingerprint), pages and slots remain
unchanged. The pass is opt-in and offline; it is not installed globally on the JIT hot path.
These synthetic measurements do not establish gains in a game or on old physical hardware.
Use `browser.html?control=identity` for the identical-byte performance control.
Results and limitations: `docs/performance/aot-exact-rotate-2026-09-09.md`.

## Game capture on a separate origin

For the NFSU diagnostic probe, start the collector with PowerShell
`$env:SOURCE_PAIR_ORIGIN='http://127.0.0.1:5174'` before running `serve.ts`, then open
`http://127.0.0.1:5174/tools/bench-v86/source-pair/browser.html`.
The Load isolated NFSU button streams `G:/WGB/running/nfs-underground.wgb` through
the existing configured bundle route. The origin differs from the main localhost
application, so its OPFS data is separate; repeated probe boots on 127.0.0.1 share
their own saves. A new iframe alone does not isolate OPFS. Do not use that origin
for unrelated game sessions while running this probe.

Save game screenshot exports the existing harness `shot` and incident report.
Enter/Escape use `keyHold` with 350 ms duration. Capture game JIT records only
**new publications during the next 20 seconds**, then pauses the guest and exports
hash-checked modules. It does not clear/recompile the warm cache, so an empty capture
or zero eligible SHUFPS sites is not a census of all executing code. These captures
are diagnostics, not performance samples. The collector keeps JSON checkpoints;
the latest screenshot is `game-shot/0.png`.

`export-game-aot.html` reads the saved `app-nfs-underground/aot` cache on its own
origin without restarting the game. Export after AOT Save has completed. It verifies
file lengths and an unchanged index across the read, then sends SHA-tagged bytes to
the collector. It never writes OPFS. The output uses the collector's `game-capture`
directory, with `source: saved-opfs-aot` in result.json; older submissions remain as
checkpoints. A snapshot of a concurrently overwritten cache is not atomic, so do
not save again during export.

`game-aot-paired.html` loads the saved cache and probes two alternate implementations
in one scene. Build its payload with:

```sh
node tools/bench-v86/source-pair/build-game-candidate.mjs <original-cache> <candidate-cache> public/apps/source-pair-lab/nfsu-candidate.json
```

The builder checks complete versions, page/slot metadata, lengths and Wasm validation.
The probe reconstructs A from the original bytes, replaces only changed captured
units, and uses ordinary AotCache drop/replay for C. Samples check function identity,
ownership of every target page, module entries, compile counts, race state and raw
present intervals. It keeps OPFS unchanged. `?identity=1` publishes original bytes
for both arms. This is a same-session diagnostic over a changing scene; even an
integrity-valid result does not establish independent-pair game performance.

## NFSU entry in one action

Continuation guide with experiment results, current WBUF candidate and unfinished
engine-comparison setup: [v86 FPS handoff](../../../docs/performance/v86-fps-handoff-2026-09-10.md).

With the dev app on `127.0.0.1:5174`, start the local evidence collector:

```sh
bun tools/bench-v86/source-pair/navigation-record-server.ts
```

Open `http://127.0.0.1:5174/tools/bench-v86/source-pair/nfsu-entry.html` and click
**Войти в эталонную гонку**. The default target is the saved profile's blue Skyline,
Free Run, Olympic Square, no traffic. The user accepted Skyline as the benchmark
car on September 10. The bundle is `G:/WGB/running/nfs-underground.wgb`.

The action creates a fresh guest, backs up and restores the five `nfsu-max` profile
and settings files, verifies byte readback, requests the existing skipVideo
manifest override. Before BootFlow construction, it temporarily changes the two
region-specific list-start operands to the final profile entry. This skips movies
and the splash screen. Exact expected bytes and the unconstructed BootFlow state
are checked; writes use `writeGuestCode` with cache invalidation. The original bytes
are restored and invalidated as soon as the profile screen is recognized, before
race entry. If BootFlow was already constructed, the observed-video input path is
retained as a slower fallback. The profile is selected automatically.
At the idle main menu it checks four
code signatures, seeds mode/track/traffic data, and queues the game's own
`0x004B5C00` initializer through its existing pending-transition slot. The CPU
instruction pointer, Wasm modules and saved AOT files are not patched. BootFlow's
temporary code change is restored before any measurement.

Completion requires the countdown→active race transition, advancing physics and
present serials, mode 3, track 1003, zero traffic, one player, and matching Skyline
scene/car image regions. It pauses the emulator after confirmation. Unknown screens,
binary signature drift and mismatched scene parameters stop the action with evidence.
The settings and manifest changes are confined to this lab origin; backups are in
the collector's run directory. The selected bundle override is merged, not replaced.

`?menu=1` retains the slower recorded menu path (Golf) as a diagnostic control.
`navigation-record.html` records manual input and periodic screenshots; it is not
a performance recorder. The JSON templates name their source screenshots in
`logs/nfsu-navigation-RibI1M`. `nfsu-entry-settings.json` embeds the fixture bytes;
`nfsu-entry-guards.json` records the external disassembly image identity and the
exact checked code spans (not a claim of a full live EXE hash).

**Limits:** this is a reproducible scene-entry tool, not a bit-exact savestate.
It does not establish CPU-bound attribution or performance uplift. Do not include
navigation, screenshots, or initialization in a warm AOT timing window. Warm-up and
paired measurement must run after entry with the usual AOT ownership/state checks.
