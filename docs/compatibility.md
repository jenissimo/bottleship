# Compatibility

BottleShip targets native Win32 games of roughly **1997–2004** — the DirectDraw / Direct3D
3–9 era. This is a living list of titles that have been brought up and observed running; it is
not exhaustive, and "runs" means different things at different stages (boots to menu vs. fully
playable). Your mileage will vary with the exact build/version you own.

Updated **2026-10-05** against the maintainer's working collection in `G:\WGB\running`
and existing production demos. Newly listed working titles and promotions from "in progress"
reflect the maintainer's report; this release pass did not replay every game. Warcraft III
Demo was freshly checked to its rendered menu. New demo coverage is separated below.
GOG extraction was checked with The Blackwell
Legacy and Far Cry, which does not establish fresh gameplay coverage for those installers.

**How to read the table**

- **Status** — `playable` (reaches gameplay and is enjoyable), `boots` (reaches menu / early
  gameplay, rough edges), `in progress` (actively being brought up).
- **GOG ✓** — a GOG edition is a source for an owned copy. Supported Win32 offline installers
  can be imported (see [GOG import](gog-import.md)); this is not a claim that every installer
  revision or bundled remaster has been tested. Blank cells do not establish that no GOG
  edition has ever existed. Delisted editions are called out separately below.
- **Demo** — only the demo is covered unless a full build is also stated. In particular,
  **Airfix Dogfighter and Overboard! full versions have not been tested**.

## Working

| Title | Status | GOG |
|-------|--------|:---:|
| Re-Volt | playable | ✓ |
| Heroes of Might & Magic III | playable | ✓ |
| StarCraft / Brood War | playable | |
| Warcraft III (demo) | playable | |
| Diablo II | playable | |
| Max Payne | playable | |
| Harry Potter and the Philosopher's Stone | playable | |
| Harry Potter and the Chamber of Secrets | playable | |
| Need for Speed: Porsche Unleashed | playable\* | |
| Need for Speed: Underground | playable | |
| Need for Speed: Underground 2 | playable | |
| Carmageddon 2: Carpocalypse Now | playable | ✓ |
| Star Wars Episode I: Racer | playable | ✓ |
| Unreal Gold | playable | |
| Unreal Tournament (demo) | playable | |
| Quake II | playable | ✓ |
| Half-Life: Uplink / Day One (demos) | playable | |
| Red Faction | playable | ✓ |
| Grand Theft Auto III | playable | |
| Grand Theft Auto: Vice City | playable | |
| Hitman: Codename 47 | playable | ✓ |
| Thief Gold | playable | ✓ |
| System Shock 2 (original) | playable | |
| Blade of Darkness | playable | ✓ |
| American McGee's Alice | playable | |
| Gothic | playable | ✓ |
| Command & Conquer: Tiberian Sun | playable | |
| Cossacks: European Wars | playable | ✓ |
| Worms: Armageddon | playable | ✓ |
| Discworld Noir | playable | |
| Tony Hawk's Pro Skater 2 (demo) | playable | |
| Tomb Raider II | playable | ✓ |
| The Elder Scrolls III: Morrowind | playable | ✓ |
| Nuclear Titbit (Ядерный Титбит) | playable | |
| Airfix Dogfighter (demo) | playable | |
| The Blackwell Legacy | playable | ✓ |
| Sea Dogs | playable | ✓ |
| Overboard! / Shipwreckers! (demo) | playable | |
| House of 1000 Doors: Family Secrets | playable | |
| Natalie Brooks: Secrets of Treasure House | playable | |
| Alice Greenfingers | playable | |
| Farm Frenzy | playable | |
| Montezuma | playable | |
| Far Cry | playable | ✓ |
| Mafia (original) | playable | ✓ |
| The Bard's Tale ARPG (Remastered and Resnarkled, Win32) | playable | ✓ |
| Deponia | playable | ✓ |
| The Dark Eye: Chains of Satinav | playable | ✓ |
| Worms World Party Remastered (Win32) | playable | ✓ |
| XIII (original, 2003) | playable | ✓ |
| Serious Sam: The First Encounter (Classic) | playable | ✓ |
| KKND2: Krossfire | playable | ✓ |
| Painkiller Black Edition | playable | ✓ |

\* retail has an intermittent mode-switch hiccup; the demo does not.

The working collection also covers full builds alongside the production demos of Re-Volt,
Heroes III, StarCraft, Diablo II, Max Payne, Harry Potter 1, NFS Porsche and NFS Underground.
The Re-Volt beta is a separate working build, not a replacement for the released demo.

System Shock 2 coverage is for the original 1999 game, including previously purchased GOG
copies; it does not cover the 2025 remaster. Unreal Gold's former GOG edition is delisted.
Quake II coverage is for the classic Win32 executable, rather than the Enhanced executable.
The Bard's Tale and Worms World Party demos listed in [demo sources](demo-sources.md) are
older editions than the working remasters and need their own compatibility checks.

## Demo checks in this release

These checks used one Chrome guest tab, with no engine-specific runtime overrides.
They describe these demo editions only; a rendered menu does not establish full playability.

| Demo | Freshly observed | Public catalog |
|---|---|:---:|
| Quake II 3.14 (classic Win32) | Entered a playable level, movement and rendered HUD; OpenGL | ✓ |
| American McGee's Alice | Main menu, OpenGL | ✓ |
| XIII UK demo | Rendered menu, D3D8 | ✓ |
| Hitman: Codename 47 revision 2 | Mission briefing, Direct3D; original OpenGL setup fails pixel-format selection | ✓ |
| Serious Sam: The First Encounter | Russian single-player menu, OpenGL; dismiss the normal first-run information dialog | ✓ |
| Worms Armageddon | Main menu, DirectDraw | ✓ |
| System Shock 2 (original demo) | Main menu, DirectDraw | ✓ |
| Harry Potter: Chamber of Secrets | Start menu and real renderer-probe child exit; entering gameplay remains unverified | |
| NFS Underground 2 | Rendered startup notice; did not reach the menu | |
| Gothic USA demo | SmartHeap / debug CRT dialog; did not reach the menu | |
| Thief Gold demo | Crashed at boot (`0x7c07`); do not infer support from the working full edition | |

Harry Potter 1's existing demo was checked on a clean game ID and again with the same
saved state. Its renderer helper actually ran and wrote detection/configuration files;
the hidden helper did not replace the parent display. The updated Unreal Tournament WGB
contains no fabricated ShellExecute rules and reaches its rendered menu.

## Stretch / in progress

| Title | Status | GOG |
|-------|--------|:---:|
| The Longest Journey | in progress | ✓ |
| Deus Ex | in progress | ✓ |
| Prince of Persia: The Sands of Time | in progress | ✓ |

## Reporting compatibility

If you get a title running (or find a regression), a compatibility report with the exact
edition/version, what worked, and what didn't is valuable. Attach a `report()` snapshot (see
[`docs/harness.md`](harness.md)) for anything that froze, exited, or rendered black — it names
the likely culprit. Please don't attach copyrighted game files.
