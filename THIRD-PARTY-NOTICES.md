# Third-Party Notices

BottleShip redistributes the third-party components listed below. Each component
remains under its own license; the corresponding license texts live in the
upstream projects referenced here.

> The license for BottleShip's own code is recorded in `LICENSE`. This file covers
> only third-party material.

## Emulation core

### v86 (`vendor/v86`, ships as `public/v86.wasm` + `libv86.mjs`)
- x86 CPU/system emulator. Git submodule of the BottleShip fork of
  [copy/v86](https://github.com/copy/v86).
- **License:** BSD-2-Clause (see `vendor/v86/LICENSE`). Portions of the floppy
  code derive from QEMU and are MIT-licensed (`vendor/v86/LICENSE.MIT`).

### SeaBIOS (`public/bios/seabios.bin`)
- Open-source x86 BIOS, redistributed as an unmodified binary as shipped with v86.
- **License:** LGPL-3.0 (see `vendor/v86/bios/COPYING.LESSER`).
  Source: <https://www.seabios.org/>.

### Bochs VGABIOS (`public/bios/vgabios.bin`)
- VGA BIOS from the Bochs project, redistributed as an unmodified binary as
  shipped with v86.
- **License:** LGPL-2.1. Source: <https://github.com/bochs-emu/vgabios>.

## Media / codec WASM builds

### FFmpeg (`public/video-decoder.wasm`)
- Video/audio decoding (Bink, Smacker, Indeo, MPEG, WMV, ADPCM, …) compiled to
  WebAssembly by `tools/build-ffmpeg-decoder/build.sh`.
- **License:** LGPL-2.1-or-later. The build is configured **without**
  `--enable-gpl` and without any GPL-only components; only LGPL decoders,
  demuxers and support libraries (libavformat/libavcodec/libavutil/libswscale/
  libswresample) are enabled.
- Complete corresponding source: upstream FFmpeg (<https://ffmpeg.org/>) at the
  release pinned in `tools/build-ffmpeg-decoder/build.sh`, plus the build script
  and `decoder_api.c` in this repository.

### unpack-buffered (`tools/build-unpack-buffered`, ships as `public/unpack-buffered.wasm`)
- First-party BottleShip Rust crate (7z/deflate/LZMA decode for game ingestion).
  Statically links the following Rust crates:
  - `sevenz-rust2` — Apache-2.0
  - `miniz_oxide` — MIT OR Zlib OR Apache-2.0
  - `lzma-rs` — MIT
  - `wasm-bindgen`, `js-sys` — MIT OR Apache-2.0

### unpack-streaming (`tools/build-unpack-streaming`, ships as `public/unpack-streaming.wasm`)
- First-party BottleShip Rust crate (Inno Setup LZMA1/LZMA2, FreeArc srep).
  Statically links:
  - `lzma-rust2` — Apache-2.0

## Fonts

### Liberation Fonts (`public/fonts/Liberation*.ttf`)
- Metric-compatible replacements for Arial/Times New Roman/Courier New, used
  for guest GDI text rendering.
- **License:** SIL Open Font License 1.1.
  Source: <https://github.com/liberationfonts/liberation-fonts>.

## Bundled JavaScript dependencies (production bundle)

| Package | License |
|---|---|
| `react`, `react-dom` | MIT |
| `pako` | MIT AND Zlib |
| `lucide-react` | ISC |
| `@phosphor-icons/react` | MIT |
| `socket.io-client` (with `engine.io-client`, `engine.io-parser`, `socket.io-parser`, `@socket.io/component-emitter`, `debug`, `ms`) | MIT |

Development-only dependencies (Vite, TypeScript, Tailwind, ESLint, …) are not
redistributed and are therefore not listed here.

## Multiplayer relay (`packages/lan`, `packages/lan-rust`)

### cszackrison/bottleship
- The virtual LAN adapter design and binary datagram layout used by the relay
  protocol (`packages/lan/src/protocol.ts`, `bottleship-lan-core`) derive from
  `src/worker/net/lan-network.ts` and `src/worker/net/netplay-wire.ts` of
  <https://github.com/cszackrison/bottleship>, modified for Socket.IO, isolated
  rooms, reconnect lifecycle, bounded queues and additional channels.
- **License:** Apache-2.0. Attribution is kept in the `NOTICE` files of
  `packages/lan`, `packages/lan-rust`, `packages/lan-rust/core` and
  `packages/lan-rust/gateway`.

### engineioxide (`packages/lan-rust/transport/vendor/engineioxide`)
- Engine.IO server crate from <https://github.com/totodore/socketioxide>,
  version 0.17.7, vendored **with modifications** (delivery guards, forced close,
  retirement observation, numeric error codes). Provenance, hashes and the list of
  changes are in `packages/lan-rust/transport/vendor/UPSTREAM.md`.
- **License:** MIT (see `packages/lan-rust/transport/vendor/engineioxide/LICENSE`).
- Other Rust crates of the server are ordinary Cargo dependencies pinned in the
  `Cargo.lock` files; their licenses are recorded in their crates.io metadata.

## Reference material (consulted, **not** redistributed)

BottleShip is an independent clean-room recreation of the Win32/COM/DirectX and
3D-graphics interfaces it targets. It ships **none** of the third-party source
below; the material was used only to confirm the public interface contracts
(function signatures, ABI struct layouts, enumerant values) that any conforming
implementation shares.

- **Win32/DirectX API headers** — signature/offset metadata under
  `tools/reference/**/*.sig.json` is regenerated locally from public SDK-style
  headers (re-fetchable from the [ReactOS](https://github.com/reactos/reactos)
  `sdk/include/psdk` tree via `bun run fetch-reference-headers`). Only the derived,
  **fact-only** `.sig.json` (interface/method names, parameter types, vtable
  indices — the Microsoft Win32/DirectX ABI, required for interoperability) are
  tracked and shipped. The upstream `.h` files themselves are git-ignored and never
  redistributed.
- **MSS32 (Miles Sound System)** — `mss32.sig.json` describes the interop
  signatures of a proprietary third-party library, reverse-engineered for
  compatibility. No Miles code is included; the header is BYO (git-ignored).
- **OpenGL / WGL** — enumerant values and entry-point signatures follow the public
  Khronos OpenGL registry and the Win32 WGL ABI.
- **Wine (LGPL-2.1) and DXVK (Zlib)** — used as behavioral references to validate
  our independent implementations of documented DirectX semantics. No Wine or DXVK
  source is incorporated.
- **Microsoft Open Specifications** ([MC-DPL4CS], [MC-DPL8CS], [MC-DPL8R],
  [MC-DPLHP]) — the public DirectPlay protocol documents that the native DirectPlay
  wire implementations follow. No leaked or proprietary source code is used.
