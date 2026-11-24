# BottleShip i386 compiler

Both CPU modes run PE code with BottleShip’s PE loader, Win32 HLE and graphics backends. The worker loads one compiler for the selected mode.

| Mode | Shipped compiler in `public/wwt-provider/` | Selection |
| --- | --- | --- |
| Fast | `wwt_abi11.wasm`, WebWindows ABI 11 with the OSR preemption fix | Default, or `wwtMode=fast` |
| Protected | `wwt_wasm.wasm`, BottleShip’s extended compiler | `wwtMode=protected` |

The WebWindows + Wine reference uses unmodified WebWindows commit `5c845c1b45659cfb5ed00a0da5d3870025c022f3` and Rust 1.99.0. Its compiler SHA-256 is `95f8ad6ee983acd0f7f466f25ebe71be3965da796d47befbc44b1cf56e958f42`. BottleShip builds its fast compiler from the same commit and adds [one OSR fix](abi11-osr-preempt.patch). The compiler checks the scheduling deadline at a synthetic loop latch before setting the internal OSR resume token. This lets the host resume at the corresponding x86 loop header.

To reproduce `wwt_abi11.wasm`, select Rust 1.99.0 for x86-64 Linux and install its `wasm32-unknown-unknown` target. Use Python 3.12 or newer. The script checks the source archive SHA-256, builds the unmodified compiler with the upstream lockfile and profile, and compares it with the Wine reference before applying the latch fix and rebuilding.

```sh
rustup toolchain install 1.99.0 --target wasm32-unknown-unknown
RUSTUP_TOOLCHAIN=1.99.0 python3 tools/build-wwt-cpu/build-fast.py WebWindows-5c845c1b45659cfb5ed00a0da5d3870025c022f3.tar.gz public/wwt-provider
sha256sum public/wwt-provider/wwt_abi11.wasm
```

The shipped fast compiler SHA-256 is `41879d5b9f8e8eafd7e224d69861be0fe2b2f06e0912891dc886070eb1e38364`.

Use `--offline` for a populated Cargo cache, or `--vendor DIRECTORY` for a cargo-vendor tree. Set `TMPDIR` and `CARGO_TARGET_DIR` to place the build outside the checkout. Set `VITE_CPU_BACKEND=v86` to build the legacy comparison app from the optional submodule.

To rebuild the protected compiler, install Python 3, Git and Rust with the `wasm32-unknown-unknown` target. Use the GitHub source archive of Glavin001/WebWindows at `5c845c1b45659cfb5ed00a0da5d3870025c022f3`. The script verifies the archive checksum, applies the BottleShip changes in a temporary directory and uses the locked Cargo dependencies.

```sh
python tools/build-wwt-cpu/build.py WebWindows-5c845c1b45659cfb5ed00a0da5d3870025c022f3.tar.gz public/wwt-provider
bun run build
```

`--offline` uses the Cargo cache. `--vendor DIRECTORY` accepts an existing cargo-vendor tree. Set `BS_WWT_PROVIDER_DIR` to package a protected compiler from a separate output directory. The production build takes ABI 11 from the pinned file in the repository. The editable Rust sources for the graphics and hypercall Wasm modules are in `tools/build-wwt-hypercall`.

## Translating a game ahead of execution

Pass `?wwtAot=on` on the game URL to compile its linked PE32 images as they load. To select modules, use filenames separated by commas, for example `wwtAot=core.dll,engine.dll`. Compiled modules live in local OPFS. Their keys cover the actual relocated image, patched imports and native hooks, compiler binary, translation options and guest RAM configuration. Missing addresses use demand translation. The first run includes compilation and browser module installation. The next run reads the matching modules from disk.

On a fresh browser profile, fast mode translates eligible read-only PE code at load time with the upstream compiler’s static entry points. It records additional entry points reached during play in OPFS. On later launches the compiler includes those entries and can reuse the cached module when the image, settings and entry list match. Protected mode defaults to `wwtAot=auto`, which learns entry points on the first run and loads linked AOT code on subsequent runs. Both the profile and generated code stay in this browser's OPFS. Modules with no saved hints continue learning. Use `wwtAot=off` for demand translation only, or `wwtLinkage=page-local` to request page-local code in auto mode. Without OPFS, demand translation remains available.

A training session with `wwtAot=learn` records dynamically reached addresses in local OPFS. Play the desired workload once, then run with `wwtAot=on`. The compiler uses the recorded entry points for matching game binaries. Hints are stored as relative offsets keyed by the original file SHA-256 and can be reused across loads at different bases.

Page-local AOT limits functions and links to one page. Adding `wwtLinkage=full` allows inter-function links across a PE. The protected compiler records source pages, including jump tables, so writes can evict dependent code and resume the guest. The upstream ABI 11 host watches writable pages with installed translation entries. It also drops linked PE translations when their executable sections become writable.

Fast mode uses a flat guest RAM window. Programs that depend on trapping per-page access violations or external MMIO can select the protected compiler. Add `"wwtMode": "protected"` under `emulator` in the WGB manifest to keep this choice specific to the game. A URL selection takes precedence, so you can run the same scene in both modes with the same WGB. The protected compiler defaults to paged access. The current x87 arithmetic uses binary64.
