# Architecture

BottleShip is a high-level-emulation (HLE) engine: it runs a real x86 Windows executable and
re-implements the Windows API on top of web platform APIs, rather than emulating a full PC and
booting Windows. This document explains how the pieces fit together.

## Execution model

The x86 CPU and a flat 4 GB address space are provided by [v86](https://github.com/copy/v86)
(a fork, vendored as a submodule under `vendor/v86/`), compiled to WebAssembly and run inside
a Web Worker so the main thread stays responsive.

A Windows executable is loaded the way Windows loads it — the PE is mapped, relocations and
the import address table (IAT) are processed, TLS is set up — but instead of resolving imports
to real DLL code, each imported function's IAT slot is pointed at a small **thunk stub**. A
stub is a few bytes of x86 ending in an `OUT` to a reserved I/O port.

## Thunking: crossing from x86 into TypeScript

When the guest calls an imported WinAPI function, it lands in the thunk stub and executes the
`OUT`. v86 traps the port write and hands control to the **thunk dispatcher** in TypeScript:

1. The CPU is paused at a safe point.
2. The guest register/stack context is marshalled into JS — arguments are read off the x86
   stack according to the function's calling convention (usually `stdcall`).
3. The native implementation runs.
4. The result is written back (registers, `stdcall` `RET N` stack cleanup), and the CPU
   resumes at the return address.

Getting the **argument count** right matters: a `stdcall` function must clean the exact number
of stack bytes on return, so every registered function declares its arg count and this is
validated against reference signature data at build time. Callbacks (the app calling back into
guest code, e.g. window procedures) are re-entrant and handled carefully to avoid corrupting
the guest stack.

## The WASM hypercall layer

Marshalling into JS for *every* WinAPI call is too slow for hot paths. BottleShip adds a tiered
**hypercall** layer inside the WASM CPU: a compact `OUT`-based dispatch that services the
hottest, simplest APIs — time and tick counters, critical-section enter/leave and other sync
primitives, FPU/math helpers, and string/memory operations — without ever entering JS. If a
hypercall isn't handled at that tier, it falls through to the JS thunk. The JS implementations
are always present as the source of truth; the hypercall layer is a fast path over them, never
a replacement.

## Graphics

Legacy graphics are translated to **WebGPU/WGSL** in real time. The fixed-function pipeline and
Direct3D 3–9 render state (transforms, lighting, texture stages, blend/alpha/fog, etc.) are
mapped onto WebGPU pipelines and shaders. Draw commands are batched to minimize WebGPU
overhead, and pipelines and bind groups are aggressively cached. DirectDraw surfaces and GDI
blits go through the same GPU path, with surface pixel memory tracked in a dedicated region and
lock/unlock mediated by a lease registry so uploads always validate against a live lock.

## Audio

DirectSound and `waveOut` mixing run in an **AudioWorklet**. The worker mixes guest audio into
a ring buffer shared with the worklet over a `SharedArrayBuffer`; the worklet pulls from it on
the audio callback. Because audio is pull-driven, buffer bookkeeping (write frontier vs. play
cursor) is done faithfully so looping streams, one-shots, and abandoned buffers behave like a
real software mixer.

## Memory and storage

- **Address space.** A paged 4 GB space with per-region permissions (read-execute,
  read-write, no-access) enforced both at the JS accessor layer and at the CPU page level.
  Guest page faults enforce guest permissions and decommit; file copy-on-write lives in
  the VFS overlay. The thunk generator arena is mutable. HLE writes of executable bytes
  use `writeGuestCode` / `invalidateGuestCode` in the same JS turn so v86 cannot execute
  stale compiled blocks. Guest page faults cannot observe JS writes. New/changed HLE code
  uses safe `Mem.read*/write*` accessors rather than raw memory indexing.
- **Virtual file system.** Each game gets a copy-on-write **overlay** over a read-only ROM,
  backed by the Origin Private File System (OPFS). Persistent data (saves, config) is written
  through to OPFS; ephemeral data (caches, temp, unpacked assets) can be kept in memory and
  discarded. Each game is an isolated container, so state never leaks between titles.
- **Registry.** An in-memory HLE registry, seeded per game from the bundle's `registry.json`.
- **Installer workspace.** Direct Inno imports use ranged input and chunked decoding into
  an OPFS disk arena, followed by a streamed ZIP64 WGB. The wizard finalizes from that staged
  archive by range. Completed library imports remove their scratch files; Storage exposes
  temporary-file cleanup and cached WGB download. See [GOG import](gog-import.md).
  Chrome directory handles are cloned to the build worker; installed folder payloads are
  copied by range, while installer folders collect the setup and matching slice handles.

## Scheduling and CPU context

Guest threads are driven by a cooperative + preemptive scheduler. The quantum is counted in
retired guest instructions, derived from the 16 ms client quantum and `TARGET_INSN_PER_MS`;
it does not depend on how quickly the host executes those instructions.
Every context switch saves and restores the full CPU state that the guest shares through the
single v86 register file — including the x87 FPU stack, SSE (XMM/MXCSR), and lazily-computed
EFLAGS — so a thread preempted mid-computation resumes with exactly its own state. The thread's
segment base (FS/TEB) is switched on every context switch. Getting any of this wrong produces
rare, timing-dependent float/flag corruption, so context save-restore is centralized and
covered by characterization tests.

## Host / worker split

- **Main thread** (`src/app/`, `src/harness/`) — the React UI, `OffscreenCanvas`, the
  AudioWorklet, input capture into a `SharedArrayBuffer`, and the main-thread half of the
  automation harness.
- **Web Worker** (`src/worker/`) — the emulator: the v86 core, thunk dispatcher, scheduler,
  memory/address-space, the WinAPI module implementations (`modules/`), the WebGPU backends
  (`backends/webgpu/`), and the runtime (VFS, bundle loader, input, dialogs).
- **D3D9 render worker** (`src/worker/render/`) — executes recorded D3D9 commands separately
  from the CPU worker by default, and returns presented frames. Guest API/state ownership
  remains in the emulator worker; resources cross through the render transport.
- **Wizard worker** — builds/inspects/finalizes packages while the library has no running
  emulator. Play first persists a configured WGB, then navigates to a game and launches it.

Cross-origin isolation (COOP/COEP headers) is required for `SharedArrayBuffer`; the dev server
and `deploy/server.ts` set these.
