# Running an i386 WGB with WebWindows

Build with `VITE_WWT_EXPERIMENT=1` or use the development server. Open `/?engine=wwt` and select the WGB. A URL also works, for example `/?engine=wwt&load=/bench/ut2004-bench.wgb`.

The integration uses a separately supplied WebWindows provider on the same origin. The measured provider identifies itself as revision `5c845c1b45659cfb5ed00a0da5d3870025c022f3`. Mount these paths under `/wwt-provider/`, preserving their relative imports:

- `runtime/` contains the web worker, Wine host, input, audio, and GPU modules.
- `target/wasm32-unknown-unknown/release-wasm/wwt_wasm.wasm` contains the x86 translator.
- `target/wine-bundle/` contains the i386 Wine manifest and the files it references for the game.

Serve JavaScript modules as JavaScript and Wasm as `application/wasm`. The page needs cross-origin isolation (COOP `same-origin`, COEP `require-corp`), SharedArrayBuffer and WebGPU. Provider redistribution requires an independent license review.

The player opens local WGB v1/v2 archives, reads the ROM into memory, and starts the executable with its packaged arguments and display size. Wine supplies its own registry, Windows identity and graphics adapter. Guest writes are temporary. This entry point is for evaluating performance and compatibility on individual games. Opening the regular launcher uses BottleShip’s usual engine.
