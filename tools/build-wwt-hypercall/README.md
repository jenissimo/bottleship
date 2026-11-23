# BottleShip Wasm kernels for WWT

Build with Bun and Rust’s `wasm32-unknown-unknown` target.

```sh
bun tools/build-wwt-hypercall/build.mjs
bun test tools/tests/wwt-hypercall.test.ts
```

The build produces `public/wwt-hypercall.wasm` and `public/wwt-d3d9-arena.wasm`. The first imports WWT’s shared memory and uses the existing BottleShip hypercall table, register ABI and counters. Its stack and hypercall page occupy reserved WWT native memory. The build checks that the Wasm cannot initialize or reserve static data in guest memory. The second owns its memory and receives a checked guest-memory reader for UP draws and write-buffer batches.

Handler support is reported by the Wasm module itself. The worker keeps the corresponding TypeScript handlers registered for guarded declines. The port dispatcher also routes generated COM method stubs, callback returns and async traps. Existing x86 write-buffer trampolines are generated and executed as guest instructions. The D3D9 arena retains its programmable-draw constraints.

The Wasm handles Win32 timing, thread and synchronization leaves, CRT string and memory routines, heap slab, RTTI and EAGL shader and token operations. The FPU path covers `_ftol` and `fabs` using WWT’s relaxed x87 state. Other CRT math, `GetTickCount64`, and authoritative FLS state use the shared handlers.

The local [source snapshots](reused/README.md) preserve the original RTTI and D3D9 Rust implementations and attribution. Building both modules requires no v86 checkout or v86 Wasm.
