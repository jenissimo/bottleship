# BottleShip i386 compiler

The worker loads `public/wwt-provider/wwt_wasm.wasm` into its own CPU host. The default app includes BottleShip's PE loader, Win32 HLE and graphics backends. Set `VITE_CPU_BACKEND=v86` to build the legacy comparison app from the optional submodule.

To rebuild the compiler, install Python 3, Git and Rust with the `wasm32-unknown-unknown` target. Use the GitHub source archive of Glavin001/WebWindows at `5c845c1b45659cfb5ed00a0da5d3870025c022f3`. The script verifies the archive checksum, applies the BottleShip changes in a temporary directory and uses the locked Cargo dependencies.

```sh
python tools/build-wwt-cpu/build.py WebWindows-5c845c1b45659cfb5ed00a0da5d3870025c022f3.tar.gz public/wwt-provider
bun run build
```

`--offline` uses the Cargo cache. `--vendor DIRECTORY` accepts an existing cargo-vendor tree. Set `BS_WWT_PROVIDER_DIR` when making a production build from a separate compiler output directory. The editable Rust sources for the graphics and hypercall Wasm modules are in `tools/build-wwt-hypercall`.

## Translating a game ahead of execution

Pass `?wwtAot=on` on the game URL to compile its linked PE32 images as they load. To select modules, use filenames separated by commas, for example `wwtAot=core.dll,engine.dll`. Compiled modules live in local OPFS. Their keys cover the actual relocated image, patched imports and native hooks, compiler binary, translation options and guest RAM configuration. Missing addresses use demand translation. The first run includes compilation and browser module installation. The next run reads the matching modules from disk. The default uses demand translation.

A training session with `wwtAot=learn` records dynamically reached addresses in local OPFS. Play the desired workload once, then run with `wwtAot=on`. The compiler uses the recorded entry points for matching game binaries. Hints are stored as relative offsets keyed by the original file SHA-256 and can be reused across loads at different bases.

Page-local AOT limits functions and links to one page. Adding `wwtLinkage=full` allows inter-function links across a PE. The compiler records source pages, including jump tables, so writes can evict dependent code and resume the guest.

The default memory mode is paged. `wwtMemory=flat` selects a faster mode for compatible applications. It checks the guest RAM boundary and skips per-page guest access permissions. Registering an external MMIO mapping switches subsequent translated accesses to the checked path. The current x87 arithmetic uses binary64.
