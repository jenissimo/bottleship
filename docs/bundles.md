# Game bundles (`.wgb`)

BottleShip runs a game from a **`.wgb`** bundle — a *store-only* (uncompressed) ZIP that
packages a game together with the metadata the engine needs to boot it. This document covers
the format and the tools for creating and inspecting bundles, plus how to bring your own games.

## What's in a bundle

```
game.wgb  (store-only ZIP)
├── manifest.json      # how to boot: exe, resolution, RAM, OS, args, flags
├── registry.json      # registry keys seeded into the HLE registry at boot
└── <game files>       # the executable and its data/assets
```

- **`manifest.json`** drives everything the engine needs that isn't in the files themselves:
  the entry `.exe`, display resolution and color depth, guest RAM, the emulated OS version,
  command-line args, and behavior flags (e.g. skipping intro videos). Persistence policy —
  which paths are durable (saves/config) vs. ephemeral (caches/temp) — is declared here too.
- **`registry.json`** seeds the HLE registry (install paths, product keys the game checks,
  video/audio settings) so the game finds what it expects on first run.

> Don't hand-edit `registry.json` — backslash escaping is easy to get wrong. Generate bundles
> with the tools below, which serialize JSON correctly.

## Creating a bundle: `make-wgb`

The high-level, one-step creator. Point it at a game directory and pass a few flags:

```bash
bun tools/make-wgb.ts <game-dir> <out.wgb> \
  --name "My Game" --exe game.exe \
  --width 640 --height 480 --bpp 16 \
  --ram 128 --os win98 \
  --reg-path "Software\\Vendor\\Game" --reg-install "C:\\Game" \
  --skip-video
```

It generates `manifest.json` + `registry.json` and packs everything in one step. Common flags:

| Flag | Meaning |
|------|---------|
| `--exe` | entry executable |
| `--width` / `--height` / `--bpp` | display mode |
| `--ram` | guest RAM (MB) |
| `--os` | `win95` \| `win98` \| `winnt` \| `win2k` \| `winxp` |
| `--reg-path` / `--reg-hive` / `--reg-install` | registry seed for the game's install key |
| `--args` | command-line arguments |
| `--skip-video` | make MCI/Bink/Smacker intros complete instantly |
| `--codepage` / `--lcid` | locale for non-Western titles |

## Inspecting & patching: `wgb.ts`

A unified archive tool for existing bundles:

```bash
bun tools/wgb.ts list    game.wgb          # list entries (alias: ls)
bun tools/wgb.ts cat     game.wgb manifest.json
bun tools/wgb.ts extract game.wgb ./out    # (alias: x)
bun tools/wgb.ts replace game.wgb path/in/zip local-file
bun tools/wgb.ts patch-manifest game.wgb …  # (alias: pm)
```

## Bringing your own game

`manifest.emulator.graphicsAdapter` selects the virtual adapter identity exposed by
DirectDraw 4/7 and Direct3D 8/9. Legacy engines use it to select driver paths. Supply
the complete identity: `vendorId`, `deviceId`, `description`, `driver` (DLL basename),
and `driverVersion` (four 16-bit version numbers). For example:

```json
"graphicsAdapter": {
  "vendorId": 4098,
  "deviceId": 29631,
  "description": "AMD Radeon RX 6900 XT",
  "driver": "aticfx32.dll",
  "driverVersion": [31, 0, 24033, 1003]
}
```

Rendering capabilities still come from BottleShip's renderer. Omitting the identity
uses the default adapter; loading another bundle clears the previous override.

BottleShip is the engine; you supply games you legally own. Three ways to get a game in:

1. **Load File…** in the UI — drop a `.wgb`, a raw game folder, or an installer.
2. **GOG installer → ROM.** Drag in a GOG Inno Setup installer; BottleShip parses it
   in-browser (a built-in Inno reader plus a WASM LZMA decoder) and builds a bundle. GOG's
   DRM-free installers make this a clean path — buy the game, drop the installer, play. See
   [`docs/gog-import.md`](gog-import.md).
3. **`make-wgb`** from a game directory you already have, as above.

## A note on distribution

The bundled/showcase set is limited to content that is legal to redistribute (freeware,
shareware, demo episodes). Commercial games are **bring-your-own** — BottleShip does not ship
their files. Keep your own bundles out of the repository.
