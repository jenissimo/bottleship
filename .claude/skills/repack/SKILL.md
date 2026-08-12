---
name: repack
description: Turn a game installer/archive/disc (InstallShield, PackageForTheWeb/WinZip-SFX, Inno/GOG, ISO/BIN-CUE, CAB, FreeArc, plain ZIP) into a .wgb bundle using BottleShip's OWN self-hosted format readers — NEVER apt/7-Zip/cabextract/unshield/innoextract. Use when packing a new game, repacking an existing .wgb, or diagnosing a bundle that boots but writes nothing / loops a menu (the empty-directory pitfall). Covers make-wgb, wgb.ts, and the formats/ stack.
---

# BottleShip Repack

Everything to get a game from a distributed installer/archive/disc into a bootable
`.wgb` is **self-hosted in this repo**. Do NOT install or shell out to a system unpacker
(`apt install`, 7-Zip, cabextract, unshield, innoextract, WINE). The whole point is that
`.wgb` bring-up needs no external native tool and works headless (CI, cron, no root). If a
container isn't covered, EXTEND the stack (`packages/formats/<fmt>` core + a `tools/` CLI),
don't reach for a binary.

## 1. Identify the container, pick our reader

| Distribution | What it is | Our tool |
|---|---|---|
| `data1.hdr` + `data1.cab`… | InstallShield Cabinet (`ISc(`, v5/v6+) — most 1998–2003 game installers | `bun tools/unshield-extract.ts <data1.hdr> <out> [--list]` |
| `setup.exe` (WinZip-SFX / "PackageForTheWeb") | a ZIP or CAB **wrapping** an InstallShield disk set | unwrap outer with `cab-extract`/zip → then `unshield-extract` the inner `data1.hdr` |
| `.cab` (`MSCF`), incl. appended to an SFX stub | Microsoft Cabinet (NONE + MSZIP) | `bun tools/cab-extract.ts` |
| GOG `setup_*.exe` / Inno Setup | Inno headers (LZMA1/2) | end-to-end: `bun tools/gog-to-wgb.ts`; inspect: `bun tools/inno-inspect.ts` |
| `.iso` / `.bin`+`.cue` | ISO9660 / disc image | `bun tools/iso-to-wgb.ts`; `bun tools/bin2iso.ts` |
| `.arc` | FreeArc (srep+LZMA) repacks | `packages/formats/src/freearc/` |
| `.rar` | store-only RAR5 wrapper around an installer (typical game drop), incl. `.partN.rar` sets | `bun tools/rar-extract.ts <a.rar> <out> [--list]` — refuses compressed/solid/encrypted/RAR4 |
| `.zip` / `.wgb` | store+deflate ZIP (also the `.wgb` container) | `bun tools/wgb.ts` |

Cores live in `packages/formats/src/<fmt>/`; the native codec backend (LZMA1/2/srep) is
`public/unpack-streaming.wasm` (Rust crate `tools/build-unpack-streaming`). See CLAUDE.md
"Archive / installer formats" for the authoritative list.

## 2. Pack with make-wgb (never hand-write JSON)

```
bun tools/make-wgb.ts <game-dir> <out.wgb> \
    --name "Game Name" --exe GAME.EXE \
    --os win98 --width 1024 --height 768 --bpp 16 \
    --reg-path "Software\Vendor\Game" --skip-video
```
`make-wgb` generates manifest.json + registry.json via `JSON.stringify` (correct `\\`
escaping) and packs in one step. **Never** write registry.json/manifest.json by hand
(shell heredoc / Write) — backslash escaping is unreliable across editors/linters/hooks.
`--help` prints the full flag list.

## 3. THE EMPTY-DIRECTORY PITFALL (read this — it is brutal to diagnose)

A `.wgb` is a **store-only ZIP, and a ZIP has no entry for an empty directory.** An
installer-created empty folder (`user\rosters`, `user\save\photos`, save/config trees) is
**silently dropped** on pack. The game then does `fopen("user\rosters\x","wb")`, which on
Windows does NOT create parent dirs, so the write FAILS — and our VFS faithfully returns
null (`parentDirectoryExists` gate). Symptoms are nasty and non-obvious: the game boots and
renders fine but **saves nothing**, or a menu **resets/loops** (e.g. Airfix Dogfighter's
Enlist → the pilot-roster write failed → login re-opened New-Pilot forever).

Fixes, in order of preference:
- **make-wgb auto-detects** empty dirs in the source and writes them to
  `emulator.createDirs`. So if your EXTRACT preserved the empty dirs, you're covered for free.
- If the source already lost them (many extractors don't emit empty dirs either), pass them:
  `--create-dirs "user\rosters,user\save\photos,user\save\levels"` (comma/semicolon list,
  `/` or `\`).
- Existing bundle you can't repack: add the field to the manifest via
  `bun tools/wgb.ts set-manifest <archive.wgb> <manifest.json>` (edit JSON, never shell).

At boot the worker calls `ensureDirTreeSync` (mkdir -p) for each `createDirs` entry —
recreating the installer's on-disk layout. This is the **sanctioned** mechanism, not a
per-game hack.

How to SUSPECT this class: game writes/saves silently no-op, or a "create/confirm" action
bounces back. Confirm from a log window around the action — a `VFS: openSync(...) CREATE_*
parent missing` line is the smoking gun. Cross-check what dirs the game expects with the RE
service (strings for `user\...`, `save\...` paths) and seed exactly those.

## 4. Inspect / patch an existing .wgb

```
bun tools/wgb.ts list <a.wgb>              # ls entries
bun tools/wgb.ts manifest <a.wgb>          # print manifest.json
bun tools/wgb.ts cat <a.wgb> <entry>       # dump one entry
bun tools/wgb.ts replace <a.wgb> <entry> <file>
bun tools/wgb.ts patch-manifest <a.wgb> <json.path> <value>   # single field
bun tools/wgb.ts set-manifest <a.wgb> <manifest.json>         # whole manifest
```
`patch-wgb-vram` overrides VRAM for an existing bundle. Aliases: `ls`, `x`, `pm`.

Note: the dev server may hold the file handle (EPERM on rename during set-manifest). Stop
Vite (PowerShell kill of the `vite` process), patch, restart.

## 5. Verify

Load it and drive to the point the pack decision affects (a save, the menu that looped):
`?game=dev` then `window.loadApp('/apps/<name>.wgb')`, or the `/bringup` skill + harness. For
a save/dir fix, confirm via `bun tools/harness.ts fsStat "C:\\user\\rosters"` (isDir=true)
and `fsList` after the game writes — the file should enumerate from the overlay.

## Hard rules

- Self-hosted readers ONLY — no system unpacker, ever. New format ⇒ extend `formats/`.
- make-wgb / JSON.stringify for all manifest+registry — never hand-escape backslashes.
- Empty dirs are invisible in ZIP — trust make-wgb's auto-detect, or seed `createDirs`.
- A bundle that boots but won't save ⇒ suspect the empty-dir pitfall FIRST.
