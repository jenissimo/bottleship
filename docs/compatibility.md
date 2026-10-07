# Compatibility

BottleShip targets native Win32 games of roughly **1997–2004** — the DirectDraw / Direct3D
3–9 era. This is a living list of titles that have been brought up and observed running; it is
not exhaustive, and "runs" means different things at different stages (boots to menu vs. fully
playable). Your mileage will vary with the exact build/version you own.

Updated **2026-10-07**. Working statuses include maintainer reports; every title has not
been retested for this release. Observed demo stages are listed separately below. Successful
GOG extraction does not establish gameplay coverage for that installer edition.

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
The original Bard's Tale and Worms World Party demos are older editions than the working
remasters. The original Bard's Tale demo has now been checked independently (see below);
Worms World Party's original demo remains unverified.

## Demo coverage

These observations cover the listed demo editions only; a rendered menu does not establish
full playability.

| Demo | Observed stage | Public catalog |
|---|---|:---:|
| Quake II 3.14 (classic Win32) | Entered a playable level, movement and rendered HUD; OpenGL | ✓ |
| American McGee's Alice | Main menu, OpenGL | ✓ |
| XIII UK demo | Rendered menu, D3D8 | ✓ |
| Hitman: Codename 47 revision 2 | Mission briefing, Direct3D; original OpenGL setup fails pixel-format selection | ✓ |
| Serious Sam: The First Encounter | English single-player menu, OpenGL; dismiss the normal first-run information dialog | ✓ |
| Worms Armageddon | Clean startup splashes, working single-player menu and quick match against the CPU; DirectDraw | ✓ |
| System Shock 2 (original demo) | Main menu, DirectDraw | ✓ |
| Half-Life: Uplink demo | Fresh-container launch reaches a rendered level and HUD; movement verified. Direct3D at 1024 × 768, 16-bit color; OpenGL exits during level load in the observed run | ✓ |
| Half-Life: Day One demo | Fresh-container launch reaches the rendered Black Mesa tram introduction; OpenGL at 1024 × 768 | ✓ |
| Red Faction Worldwide Demo | Entered gameplay with rendered weapon, HUD and mission messages | ✓ |
| Star Wars Episode I: Racer demo | Entered the Boonta Training Course race; acceleration and steering verified. Maintainer confirms correct rendering | ✓ |
| Discworld Noir demo | English interactive demo with native installation settings. Office movement, map transition, saving/loading across reload, F1 restart and extended idle-menu stability verified. Automatic attract-mode playback is disabled in the demo menu resource; original executable unchanged. WGB preloads into OPFS; direct HTTP startup fails an early CRT file read | ✓ |
| Far Cry Demo 2 (Research) | Research level playable with the WGB's AMD adapter profile; terrain, water and distance fog verified. Prepared WGB includes the engine's shader cache to shorten first level load | ✓ |
| Tomb Raider II: Great Wall demo | Fresh-container launch enters the level; movement and turning verified. WGB includes the native 640 × 480, 16-bit Direct3D settings. Opening the unconfigured first-run setup still crashes (`0x3003`) | ✓ |
| The Blackwell Legacy demo | Original English AGS demo: title menu, bridge introduction and Rosa’s apartment. Native saving and restoring verified; save persists across page reload | ✓ |
| KKND2: Krossfire demo | Original 1998 demo: army selection, mission briefing, rendered Survivors mission, unit movement and native saving/loading across page reload verified; DirectDraw | ✓ |
| The Bard's Tale original PC demo (2005) | Tutorial, summoning and the Mountain Tomb level verified; right mouse button movement and companion following. This is the original demo, separate from the working remaster | ✓ |
| Deponia demo 1.1 | English tutorial and Rufus's first room; clean OpenGL rendering and mouse input. Native saving/loading, including the save thumbnail, verified after page reload. WGB creates the engine's required temporary directory | ✓ |
| Blade of Darkness demo | Did not pass DirectInput initialization in the observed run | |
| Harry Potter and the Chamber of Secrets demo | Original English PC demo: launcher starts the real game process; entered the level, moved and collected beans. Selected English dialogue and localization files are installed in the WGB | ✓ |
| NFS Underground 2 demo | Original English PC demo: main menu and rendered Free Roam city verified; acceleration, braking and steering respond with visible HUD. Dedicated race and persistence checks remain pending | ✓ |
| Gothic USA demo 1.08h | English demo: Diego dialogue exit, rendered subtitles/HUD, movement and native saving verified. WGB recreates the required save directories; slots and thumbnails survive page reload. Restoring a saved game can stall in a resource-thread wait; further stability testing is pending | ✓ |
| Thief Gold demo | Crashed at boot (`0x7c07`); do not infer support from the working full edition | |

Harry Potter 1 and Unreal Tournament demos also reach their rendered menus.

The following demo installers have been acquired but are not ready for the public catalog:

| Demo source | Packaging result |
|---|---|
| [Cossacks: European Wars](https://archive.org/details/cossacks_202006) | Wise installer; this format is not supported by the project reader |
| [Mafia](https://archive.org/details/Mafia_201405) | RAR4 self-extractor; the project reader supports RAR5 stored entries |
| [Carmageddon II](https://archive.org/details/Carmageddon2CarpocalypseNowDemo) | ZIP contains an older InstallShield data.z payload, outside the supported cabinet formats |
| [Painkiller Demo 2](https://archive.org/details/Painkiller_Demo_2_build_v1.0) | VISE installer; payload is not supported by the current format reader |
| [Worms World Party original demo](https://ftp.zx.net.nz/pub/archive/ftp.team17.com/pub/t17/goodies/wwp_demo.exe) | RAR4 self-extractor wrapping an InstallShield cabinet set; the outer compression is not supported |

Time-limited shareware trials are excluded from the demo catalog, including Alice Greenfingers,
Montezuma, Natalie Brooks, Farm Frenzy and House of 1000 Doors.

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
