# GOG Installer Import

BottleShip can load GOG offline installers (`setup_*.exe`) directly — no manual WGB authoring required.

## Browser

1. Open BottleShip (`?game=dev` or any game page).
2. Drag a GOG `setup_*.exe` onto the page, or use **Load File…** in the dev panel.
3. First launch extracts the game in-browser and builds a WGB bundle (progress overlay).
4. The synthesized bundle is cached in OPFS; reloading or re-dropping the same installer skips extraction.

Supported: single-file Inno Setup installers (GOG 5.2.x–6.x, typically 5.5.x unicode).

Not supported in v1:

- Encrypted/password-protected installers
- Multi-part installers (`setup.exe` + `setup-1.bin` …) — drop the main `.exe` only
- Installers outside the supported Inno version range

Plain `.exe` files that are not Inno installers still load via the existing PE path.

## CLI

```bash
# Default: uses tools/bin/innoextract.exe
bun tools/gog-to-wgb.ts setup_game.exe game.wgb

# Native parser (no external binary)
bun tools/gog-to-wgb.ts --native setup_game.exe game.wgb
bun tools/gog-to-wgb.ts --native --extract-only setup_game.exe ./out-dir

```

Per-game emulator settings can be curated in `public/gog-overrides.json` (keyed by GOG product id from `goggame-*.info`).
