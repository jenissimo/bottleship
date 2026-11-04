# Contributing to BottleShip

Thanks for your interest! BottleShip is a low-level systems project — an x86 HLE engine that
re-implements the Windows API on web platform APIs. This guide covers how to build it, the
conventions we hold to, and how to get a change merged.

## Ground rules

- **Bring your own games.** Do **not** commit copyrighted game files, box art you don't have
  the right to redistribute, decompiled/leaked source, or vendored proprietary SDK headers.
  Test fixtures must be freeware/shareware/demo content that is legal to redistribute.
- **Cite behavior, don't copy code.** Referencing what Windows (or Wine, as observed
  behavior — its conformance tests especially) does is encouraged; copying implementation
  code from differently-licensed projects (e.g. Wine, LGPL) is not.
- **No leaked or proprietary source, ever.** Leaked or otherwise proprietary source code
  (including Windows/NT source leaks such as "nt5src" and "research" leaks) must not be used
  as input to your work, quoted, or cited in code, comments, tests, or docs. Base behavior on
  public documentation (Win32/DirectX SDK docs, Microsoft Open Specifications such as
  [MC-DPL4CS]/[MC-DPL8CS]) and on behavior observed on real Windows.
- **Faithful, generic recreations — no per-game hacks.** Implement WinAPI/COM/graphics as a
  faithful recreation of the real documented behavior (ABI, struct layouts, error codes, edge
  cases). Never branch on a game's name/exe/hash or hardcode a magic offset for one title. If
  a game misbehaves, find the generic layer bug and fix it so *every* game on that path
  benefits. `if (game === …)` is a smell.
- **Performance is part of correctness.** Hot paths are zero-allocation and cache-friendly
  (data-oriented design); GPU work is batched. A correct-but-slow path that starves the audio
  pump or frame loop isn't acceptable.

## Contributing with an AI agent

AI-assisted contributions are a first-class path here, not a tolerated one — the repo ships
the agent infrastructure (`CLAUDE.md` as system prompt, the self-judging automation harness)
that makes them verifiable. If you want to bring up the game you care about with an agent
doing the systems work, start with [`docs/contributing-with-ai.md`](docs/contributing-with-ai.md).
The ground rules above apply doubly: you own what you submit — run the loop, read the diff,
and back the faithfulness claim with a public citation.

## Getting set up

```bash
git clone --recurse-submodules <repo-url>   # vendor/v86 is a submodule
cd bottleship
bun install
bun run dev                                  # http://localhost:5174
```

If you forgot `--recurse-submodules`: `git submodule update --init --recursive`.

Requirements: [Bun](https://bun.sh/), a WebGPU-capable browser (Chrome/Edge 113+). The
engine core (`vendor/v86`) is Rust→WASM; rebuilding it needs the `wasm32-unknown-unknown`
target, clang, and Node — see `vendor/v86/build-wasm.sh`. You only need that if you change
the emulator core; most work is in TypeScript and needs no WASM rebuild.

## The quality gate (required before every PR)

Run these in order; all must be green:

```bash
bun tools/generate-index.ts          # regenerate module indexes
bun tools/validate-signatures.ts     # WinAPI signatures vs reference data
bun tools/validate-struct-offsets.ts # struct layout/offset checks
bun run typecheck
bun test
```

## Project layout

| Path | What lives there |
|------|------------------|
| `src/worker/core/` | CPU/scheduler, thunk dispatcher, memory/address-space, HLE framework |
| `src/worker/modules/` | WinAPI module implementations (kernel32, user32, gdi32, d3d9, dsound, …) |
| `src/worker/backends/webgpu/` | DirectDraw/Direct3D → WebGPU translation + post-FX |
| `src/worker/runtime/` | Virtual file system, bundle loader, input, dialogs |
| `src/app/`, `src/harness/` | React host UI and the main-thread automation harness |
| `packages/` | Standalone libraries (archive formats, repack) with no engine dependency |
| `tools/` | Build, bundling (`make-wgb`, `wgb`), the harness CLI, RE service, validators |
| `vendor/v86/` | The x86 emulator core (Rust→WASM), a submodule |

## Conventions

- **Safe memory access.** Use the `Mem.read*/write*` accessors, not raw typed-array indexing,
  in new/changed code. Debug builds validate accesses against the region map and permissions.
- **Zero-allocation hot paths.** Prefer flat arrays and reused `StructView` flyweights over
  allocating object trees in per-frame / per-call loops.
- **Comments are for the non-obvious.** Explain *why*, state invariants precisely, and don't
  narrate what the code already says. No multi-paragraph history/changelog blocks in code.
- **Top-level imports only** (`import type` where possible); no inline `require`/dynamic import
  for types.

## Adding a WinAPI function

Most modules are made of small "atomic" implementation files that are aggregated by a
generated `index.ts`. To add a function:

1. Implement it in the relevant module under `src/worker/modules/<dll>/`.
2. Register it with the correct **stdcall argument count** (this drives the thunk's `RET N`).
   A wrong count corrupts the stack — `validate-signatures` cross-checks against the reference
   `*.sig.json`, so add the export there if it's missing.
3. Run the quality gate.

If a function is a hot path (sync primitive, timer, math, string/memory), consider the WASM
hypercall tiers before adding a JS thunk — but the JS implementation is always a required
fallback, never remove it.

## Debugging

BottleShip ships an automation harness that wraps "load a game, drive it, see what happened"
into fluent, self-judging verbs (`bun tools/harness.ts …`, `window.__BS__.harness`). See
[`docs/harness.md`](docs/harness.md). When something behaves oddly, pull a `report()` first —
it's one structured snapshot with CPU regs, the module-labelled call stack, the recent WinAPI
ring, the unimplemented-stub registry, and recent page faults.

## Pull requests

- Keep changes focused; match the surrounding code's style and comment density.
- Include what you did to verify the change actually works (which game/flow you drove, not
  just that it typechecks).
- Green quality gate is required.

By contributing you agree your contributions are licensed under the project's
[`LICENSE`](LICENSE).
