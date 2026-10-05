# `packages/formats/src` — installer / archive unpack module

A self-contained module for reading the container, installer, and archive formats a game
ships in, and extracting the real game files. Used by the WGB build pipeline
(`worker/runtime/gog-import/container-extract.ts` + the headless `tools/iso-to-wgb.ts`,
`tools/gog-to-wgb.ts`) but written so the whole `packages/formats/src/*` tree could be lifted into a
standalone package (`@bottleship/unpack`) with no edits to its internals.

## Layout (dependency DAG)

```
unpack/   ← dependency-free CORE
  unpack.ts      WASM codec wrapper: UnpackDecoder + UNPACK_{STORE,LZMA1,LZMA2,SREP}
  source.ts      RandomAccessSource interface + in-memory BufferSource
  checksums.ts   CRC32 / MD5 / SHA-1 (incremental)
  → built from tools/build-unpack-streaming (Rust → public/unpack-streaming.wasm)

inno/         Inno Setup installer reader        → unpack (+ pako)
freearc/      FreeArc .arc / repack reader       → unpack
iso/          ISO9660 / BIN+CUE disc images      → unpack
installshield/ InstallShield 5/6 cabinets        → unpack
rtf/          Rich Text Format documents        → (nothing)
```

Every reader depends only on `unpack` (the core) and, for `inno`, the `pako` npm package.
Nothing in `formats/*` imports from `worker/`, `harness/`, or app code — the group is the
extraction engine; the *orchestration* (which format to try, junk-file filtering, manifest
synthesis) lives in the host (`worker/runtime/gog-import/`) and is injected via options.

## Native codecs (WASM)

Heavy decompression runs in `public/unpack-streaming.wasm` (Rust, `tools/build-unpack-streaming`), shared by
all readers. Rebuild with `bun run build:unpack-streaming` (needs `rustup target add
wasm32-unknown-unknown`); the artifact is committed. Supported: LZMA1/LZMA2 (Inno) and
**srep** — FreeArc's long-range dedup filter (Bulat Ziganshin's SREP, FUTURE_LZ v3).

The srep + LZMA decode is verified byte-exact against references compiled with MSVC: the
7-Zip LZMA SDK `LzmaDec.c` and Bulat Ziganshin's `decompress_FUTURE_LZ`.

## Public entry points

- `unpack`: `new UnpackDecoder()`, `decode(kind, bytes, props?)`; `BufferSource`; `Crc32`/`Md5`/`Sha1`.
- `inno`: `parseInnoHeader`, `extractInnoToMap`, `MultiSliceReader`, …
- `freearc`: `detectFreeArc`, `readFreeArcListing`, `extractFreeArc`, `extractFreeArcToMap`.
- `iso`: `IsoImage`, `parseIso9660`, `extractIsoToMap`, `parseCue`.
- `installshield`: `detectInstallShieldStem`, `extractInstallShield`.
- `rtf`: `isRtf`, `parseRtf` (styled runs; pass `decode` to supply code-page tables).

## Extraction-readiness checklist (for a separate repo)

- [x] `unpack` core has zero external deps; all readers depend only on it (+ pako).
- [x] No `formats/*` file imports `worker/`/`harness/`/app code.
- [x] Generic primitives (source/checksums) live in the core, not under a specific format.
- [x] Orchestrator (`container-extract.ts`) and the junk-file predicate (`gog-filter`) live in
      the `repack` package with no host-side imports, so container extraction ships self-contained.
