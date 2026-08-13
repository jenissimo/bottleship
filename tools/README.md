# tools/

Public dev/build tooling. Game-specific RE/debug one-offs live in
[`internal/`](internal/README.md) and are not part of the supported surface.

## Bundles (WGB)

- **make-wgb.ts** — high-level bundle creator: raw game dir + flags → manifest/registry/packed `.wgb` in one step.
- **wgb.ts** — unified WGB archive tool: list / cat / extract / replace / manifest / set-manifest / patch-manifest.
- **gog-to-wgb.ts** — convert a GOG Inno Setup installer into a `.wgb` bundle (built-in WASM parser, `--innoextract` fallback).
- **iso-to-wgb.ts** — build a `.wgb` from an ISO/BIN+CUE disc image.
- **bin2iso.ts** — convert a MODE1/2352 raw CD `.bin` to a plain 2048-byte/sector `.iso`.
- **unshield-extract.ts** — extract InstallShield cabinet (`data1.cab`) installers.
- **inno-inspect.ts** — inspect an Inno Setup installer's headers/file table.
- **patch-wgb-vram.ts** — patch the VRAM override of an existing bundle.
- **patch-wgb-gog-script-registry.ts** — regenerate a bundle's registry from its GOG install script.
- **migrate-wgb-v2.ts** — migrate v1 bundles to the v2 manifest (gameId) format.
- **export-registry.ps1** — export a real Windows registry subtree into `registry.json` seed format.

## Debugging & profiling

- **harness.ts** — CLI for the AI-agent harness: cold-to-ready `up`, run `.harness.ts` scripts, `shot`, `report`, `re` proxy. Primary debugging entry point.
- **cdp-core.ts** — shared CDP session/eval/screenshot plumbing used by harness.ts.
- **cdp-trace.ts** — capture a browser-level performance trace (works even when the worker pump is starved) → feed analyze-trace.ts.
- **cdp-pausestack.ts** — pause a hard-pinned worker via CDP and dump its JS call stack.
- **analyze-trace.ts** — Chrome trace → per-thread self/total time, WASM/JIT breakdown, timeline. Primary perf tool.
- **log-manager.ts** — manage the dev-sidecar log archive (`logs`, `logs:clean`, `logs:stats`).
- **dev-sidecar/sidecar-loadtest.ts** — pump the sidecar's log ingest at a target MB/s and plot its
  memory against lines ingested; `--break-at` makes the archive writer fail mid-run (a full disk, a
  deleted `logs/`), which is the case where a log buffer either stays bounded or eats the machine.
- **re/** — warm RE service (Ghidra headless behind an HTTP daemon): decompile / resolve / exportSymbolMap.
- **pe-disas.py** — lightweight PE disassembler/xref helper (capstone + pefile), Ghidra-down fallback.
- **harness/** — checked-in harness scripts: `templates/` (copy-and-adapt starting points), `regression/`
  (self-judging per-game scenarios, run in a batch via `bun tools/harness.ts regress`), `perf/` (production
  A/B instruments). See `tools/harness/README.md` for the admission rule. One-off probes belong in the
  gitignored `tools/probes/` and die with the investigation, not here.

## Quality gate & codegen

- **generate-index.ts** — regenerate module indexes (gate step 1).
- **validate-signatures.ts** — validate API signatures against reference data (gate step 2).
- **validate-struct-offsets.ts** — validate struct layouts/offsets (gate step 3).
- **check-file-sizes.ts** — flag files exceeding the size budget.
- **generate-reference-argcounts.ts** — regenerate stdcall arg-count tables from reference signatures.
- **fetch-reference-headers.ts** / **parse-reference-headers.ts** — (re)fetch ReactOS-sourced Win32/DirectX headers locally and parse them into `.sig.json`. The `.h` files themselves are gitignored (local-only regen inputs); only the derived `.sig.json` are tracked.
- **backfill-api-from-reference.ts** — append missing `makeFunc()` API entries from reference `.sig.json` files.
- **generate-dinput-action-maps.ts** — emit DirectInput8 default action maps from `reference/directx/dinput.h` (fetch it first via `fetch-reference-headers.ts` — the header is gitignored).
- **load-guids.ts** — dump IID GUIDs from constants.ts vs reference headers for manual comparison.
- **parse-metadata.ts** / **import-metadata.ts** — parse and import game metadata.
- **reference/** — Win32/DirectX/mss32 `.sig.json` signature data consumed by the validators (headers are gitignored, re-fetchable via `fetch-reference-headers.ts`).
- **tests/** — unit tests (`bun test`).

## Builds

- **build-ffmpeg-decoder/** — WASM video-decoder build (`build:video-decoder`).
- **build-unpack-streaming/** — Rust→WASM installer-unpack build (`build:unpack-streaming`).
- **video-test/** — standalone decoder test page (no emulator dependency).
