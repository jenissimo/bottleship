# BottleShip i386 compiler

For a runnable comparison and the development measurements, see [Trying the WebWindows CPU backend](../../docs/wwt-preview.md).

Both CPU modes run PE code with BottleShip’s PE loader, Win32 HLE and graphics backends. The worker loads one compiler for the selected mode.

| Mode | Shipped compiler in `public/wwt-provider/` | Selection |
| --- | --- | --- |
| Fast | `wwt_abi11.wasm`, WebWindows ABI 11 with BottleShip fixes for preemption and flat data segments | Default, or `wwtMode=fast` |
| Protected | `wwt_wasm.wasm`, BottleShip’s extended compiler | `wwtMode=protected` |

The WebWindows + Wine reference uses unmodified WebWindows commit `5c845c1b45659cfb5ed00a0da5d3870025c022f3` and Rust 1.99.0. Its compiler SHA-256 is `95f8ad6ee983acd0f7f466f25ebe71be3965da796d47befbc44b1cf56e958f42`. BottleShip builds its fast compiler from the same commit and adds [a patch for scheduler preemption, flat data segments and exact x87 integer copies](abi11-osr-preempt.patch). The compiler checks the deadline at a synthetic loop latch before setting the OSR resume token. It also retains the original block identity for back edges when OSR moves the function entry. Backward direct jumps out of a translated region also check the deadline before dispatch. Each check resumes the guest at the corresponding x86 address. The compiler accepts selector `0x10` for ES and DS when SS uses the flat data segment from BottleShip’s boot GDT.

To reproduce `wwt_abi11.wasm`, select Rust 1.99.0 for x86-64 Linux and install its `wasm32-unknown-unknown` target. Use Python 3.12 or newer. The script checks the source archive SHA-256, builds the unmodified compiler with the upstream lockfile and profile, and compares it with the Wine reference before applying the BottleShip patches and rebuilding.

```sh
rustup toolchain install 1.99.0 --target wasm32-unknown-unknown
RUSTUP_TOOLCHAIN=1.99.0 python3 tools/build-wwt-cpu/build-fast.py WebWindows-5c845c1b45659cfb5ed00a0da5d3870025c022f3.tar.gz public/wwt-provider
sha256sum public/wwt-provider/wwt_abi11.wasm
```

The shipped fast compiler SHA-256 is `4baeba541b14627aaed6359d14f9c2c65a2237703ba95816d7bff09784ad718c`.

Use `--offline` for a populated Cargo cache, or `--vendor DIRECTORY` for a cargo-vendor tree. Set `TMPDIR` and `CARGO_TARGET_DIR` to place the build outside the checkout. Set `VITE_CPU_BACKEND=v86` to build the legacy comparison app from the optional submodule.

To rebuild the protected compiler, install Python 3, Git and Rust with the `wasm32-unknown-unknown` target. Use the GitHub source archive of Glavin001/WebWindows at `5c845c1b45659cfb5ed00a0da5d3870025c022f3`. The script verifies the archive checksum, applies the BottleShip changes in a temporary directory and uses the locked Cargo dependencies.

```sh
python tools/build-wwt-cpu/build.py WebWindows-5c845c1b45659cfb5ed00a0da5d3870025c022f3.tar.gz public/wwt-provider
bun run build
```

`--offline` uses the Cargo cache. `--vendor DIRECTORY` accepts an existing cargo-vendor tree. Set `BS_WWT_PROVIDER_DIR` to package a protected compiler from a separate output directory. The production build takes ABI 11 from the pinned file in the repository. The editable Rust sources for the graphics and hypercall Wasm modules are in `tools/build-wwt-hypercall`.

## Translating a game ahead of execution

Pass `?wwtAot=on` on the game URL to compile its linked PE32 images as they load. To select modules, use filenames separated by commas, for example `wwtAot=core.dll,engine.dll`. Compiled modules live in local OPFS. Their keys cover the actual relocated image, patched imports and native hooks, compiler binary, translation options and guest RAM configuration. Missing addresses use demand translation. The first run includes compilation and browser module installation. The next run reads the matching modules from disk.

On a fresh browser profile, fast mode attempts to translate eligible read-only PE code at load time using the upstream compiler’s static entry points. Each uncached linked translation runs in a separate worker and has a 30-second budget. The [PE progress patch](abi11-pe-progress.patch) reports decoded instructions and functions processed in each stage. Optimization and Wasm generation report the number of functions planned for that stage. BottleShip supplies the `bottleship.pe_progress` host import when instantiating the compiler. The regular `wwt_translate_pe` export runs without reporting progress. If it runs out of time, the guest starts and translates code on demand. It records additional entry points reached during play in OPFS. On later launches the compiler includes those entries and can reuse the cached module when the image, settings and entry list match. Protected mode defaults to `wwtAot=auto`, which learns entry points on the first run and loads linked AOT code on subsequent runs. Both the profile and generated code stay in this browser's OPFS. Modules with no saved hints continue learning. Use `wwtAot=off` for demand translation only, or `wwtLinkage=page-local` to request page-local code in auto mode. Without OPFS, demand translation remains available.

A training session with `wwtAot=learn` records dynamically reached addresses in local OPFS. Play the desired workload once, then run with `wwtAot=on`. The compiler uses the recorded entry points for matching game binaries. Hints are stored as relative offsets keyed by the original file SHA-256 and can be reused across loads at different bases.

Page-local AOT limits functions and links to one page. Adding `wwtLinkage=full` allows inter-function links across a PE. The protected compiler records source pages, including jump tables, so writes can evict dependent code and resume the guest. The upstream ABI 11 host watches writable pages with installed translation entries. It also drops linked PE translations when their executable sections become writable.

Fast mode uses a flat guest RAM window. Programs that depend on trapping per-page access violations or external MMIO can select the protected compiler. Add `"wwtMode": "protected"` under `emulator` in the WGB manifest to keep this choice specific to the game. A URL selection takes precedence, so you can run the same scene in both modes with the same WGB. The protected compiler defaults to paged access. The current x87 arithmetic uses binary64. The [x87 int64 patch](abi11-x87-int64.patch) (and [its protected counterpart](protected-x87-int64.patch)) keeps an exact 64-bit integer beside each x87 register that `FILD m64` loaded. `FIST`, `FISTP`, `FISTTP` and `FBSTP` store that exact value until the register is written, across instructions and block boundaries. `FBSTP` and `FBLD` are implemented. The shadow and its validity mask live at the CPU state offsets `FPU_I64` and `FPU_I64_VALID`.
