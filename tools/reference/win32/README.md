# WIN32 Reference Headers

This directory holds the derived win32 `.sig.json` signature data. The raw inputs are
gitignored (local-only regeneration inputs); only the `.sig.json` are tracked and shipped.

Two generators write here, from two different ground truths:

- `*.sig.json` — full signatures parsed from ReactOS PSDK headers (the sections below).
- `*.wine.sig.json` — stdcall ARITIES ONLY, parsed from Wine `.spec` files by
  `tools/generate-wine-argcounts.ts`. A `.spec` line states the exact stack size for
  every export of every DLL, so it is the canonical, complete arity list; a header-derived
  reference covers only the headers we happened to fetch, and one export we cannot size
  fails the whole PE load at boot. Names and stack-slot counts are all that is read — no
  code, no prose. Wine is not vendored: point `BS_WINE_DLLS` at a checkout (CLAUDE.md
  names the ground-truth sources), regenerate, and commit the result.

  ```bash
  bun tools/generate-wine-argcounts.ts          # refresh *.wine.sig.json
  bun tools/generate-reference-argcounts.ts     # rebuild the TS map from both
  ```

## Source

Headers are fetched from the ReactOS GitHub repository:
- Base URL: `https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk`
- Repository: https://github.com/reactos/reactos
- Path: `sdk/include/psdk/`

## Files

- **winbase.h**: Windows Base API header (kernel32, advapi32 functions)
- **winuser.h**: Windows User API header (user32 functions)
- **wingdi.h**: Windows GDI API header (gdi32 functions)
- **mmsystem.h**: Windows Multimedia API header (winmm functions)
- **objbase.h**: OLE Base API header (ole32 functions)

## Updating

To update these headers, run:

```bash
bun run fetch-reference-headers win32
```

Or manually download from:
- winbase.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/winbase.h
- winuser.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/winuser.h
- wingdi.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/wingdi.h
- mmsystem.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/mmsystem.h
- objbase.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/objbase.h

## Usage

These headers are used as reference for validating API signatures in `src/worker/api/`.
The validator compares interface/function signatures against these reference files to ensure
binary compatibility with Windows implementations.
