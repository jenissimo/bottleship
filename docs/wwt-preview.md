# Trying the WebWindows CPU backend in BottleShip

This branch connects the WebWindows ABI 11 i386-to-Wasm compiler to BottleShip's PE loader, scheduler, Win32 HLE, and graphics backends. It uses the compiler from WebWindows commit `5c845c1b45659cfb5ed00a0da5d3870025c022f3`. The upstream licenses are MIT or Apache-2.0. BottleShip distributes the compiler under Apache-2.0 with its modifications and license text. [Upstream license declaration](https://github.com/Glavin001/WebWindows/blob/5c845c1b45659cfb5ed00a0da5d3870025c022f3/Cargo.toml) · [Build and source patches](../tools/build-wwt-cpu/README.md) · [Notices](../THIRD-PARTY-NOTICES.md)

## Run the same workload

1. Start the project with `bun run dev` and use your own WGB. The default CPU backend on this branch is fast WWT. The `wwtMode=protected` URL parameter selects the protected WWT implementation for comparison.
2. To compare against v86, initialize the optional v86 submodule and use a separate dev origin with `VITE_CPU_BACKEND=v86`. The [harness documentation](harness.md) has the comparison commands.
3. Use the same browser version, window visibility, scene, camera, resolution and settings. Run one backend at a time. Record the backend shown by the harness. Measure time to gameplay and frame times separately. Report cold and warm AOT runs separately because the compiler and trained entries affect the cache key.

## Measurements from development

| Workload | Observation |
| --- | --- |
| UT2004 DM-Rankin timedemo | On `8980bf74`, visible Chrome 158.0.8127.38, 800×600, seed 8645. The cold run reported 81.0 FPS and the two warm runs reported 96.3 and 96.9 FPS. The 1,000-Present external frame window for the warm runs averaged 9.94 and 10.05 ms. Seventeen guest counters agreed with the Wine reference on all 1,201 rows. |
| NFS Porsche Unleashed, paused race | In an A/B/A test within one running fast WWT session at 1280×1024, yielding immediately at the scheduler's parking instruction changed 1.29 → 29.0 → 1.29 FPS. This measured the parking fix in a paused scene. |
| Far Cry Training load | One 11.2 s profile window sampled 6.9 s in a synchronous OPFS handle close under Win32 `WriteFile`. Faster x86 execution has limited leverage on that interval. |

The UT2004 results above are from the parent build. Compare BottleShip and stock WebWindows + Wine in the same window mode before reporting a speed ratio. Clocking a CPU benchmark, a loading transition and a rendered scene answers different questions.

## Why keep BottleShip HLE

Using the same compiler as WebWindows makes a second comparison possible. BottleShip can service some Win32 and DirectX calls through shorter host paths and avoid work that Wine or the guest would otherwise perform. We expect that to help selected workloads and want to measure where it does. An informative comparison keeps the compiler revision, scene and settings fixed and checks wall time, guest work counters and frame times. v86 improvements remain directly useful for the legacy backend and as a comparison point.
