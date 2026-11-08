# Compatibility

BottleShip targets native Win32 games of roughly **1997–2004** — the DirectDraw / Direct3D
3–9 era. This is a living list of titles that have been brought up and observed running; it is
not exhaustive, and "runs" means different things at different stages (boots to menu vs. fully
playable). Your mileage will vary with the exact build/version you own.

Updated **2026-11-07** for the `develop` branch after **BottleShip 0.7** (titles added since
2026-10-26 come from merged pull requests; see [Added since 0.7](#added-since-07)). Working
statuses include maintainer and contributor reports; every title has not been retested for this
release. Observed demo stages are listed separately below. Successful
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
| Heroes of Might and Magic II Gold (GOG) | playable | ✓ |
| StarCraft / Brood War | playable | |
| Warcraft III (demo) | playable | |
| Diablo II | playable | |
| Max Payne | playable | |
| Harry Potter and the Philosopher's Stone | playable | |
| Harry Potter and the Chamber of Secrets | playable | |
| Need for Speed: Porsche Unleashed | playable\* | |
| Need for Speed: Underground | playable | |
| Need for Speed: Underground 2 | playable | |
| Colin McRae Rally 2.0 | playable | |
| Midtown Madness 2 (full game) | runtime imported; gameplay unverified† | |
| Carmageddon 2: Carpocalypse Now | playable | ✓ |
| Star Wars Episode I: Racer | playable | ✓ |
| Star Wars Episode I: Battle for Naboo | playable | |
| Unreal Gold | playable | |
| Unreal Tournament (demo) | playable | |
| Unreal Tournament GOTY (full game, v432) | playable | |
| Quake II | playable | ✓ |
| Half-Life: Uplink / Day One (demos) | playable | |
| Half-Life 2 (20th Anniversary) | playable | |
| Empires: Dawn of the Modern World (2003, GOG) | boots; random map reaches gameplay | ✓ |
| Red Faction | playable | ✓ |
| Grand Theft Auto (1997, Rockstar Classics freeware) | playable | |
| Grand Theft Auto 2 (Rockstar Classics freeware) | playable | |
| Grand Theft Auto III | playable | |
| Grand Theft Auto: Vice City | playable | |
| Hitman: Codename 47 | playable | ✓ |
| Thief Gold | playable | ✓ |
| System Shock 2 (original) | playable | |
| Blade of Darkness | playable | ✓ |
| American McGee's Alice | playable | |
| Gothic | playable | ✓ |
| Command & Conquer: Tiberian Sun | playable | |
| Command & Conquer: Red Alert 3 | playable | |
| Cossacks: European Wars | playable | ✓ |
| Worms: Armageddon | playable | ✓ |
| Discworld Noir | playable | |
| Tony Hawk's Pro Skater 2 (demo) | playable | |
| Tomb Raider II | playable | ✓ |
| The Elder Scrolls III: Morrowind | playable | ✓ |
| Nuclear Titbit (Ядерный Титбит) | playable | |
| Neighbours from Hell (2003, Buka/Russian) | boots; tutorial movement verified | |
| Airfix Dogfighter (demo) | playable | |
| The Blackwell Legacy | playable | ✓ |
| Sea Dogs | playable | ✓ |
| Sid Meier's Pirates! (2004) | playable | ✓ |
| Deus Ex: Game of the Year Edition | playable | ✓ |
| The Longest Journey | playable | ✓ |
| Overboard! / Shipwreckers! (demo) | playable | |
| House of 1000 Doors: Family Secrets | playable | |
| Natalie Brooks: Secrets of Treasure House | playable | |
| Alice Greenfingers | playable | |
| Farm Frenzy | playable | |
| Montezuma | playable | |
| Diner Dash | boots | |
| Safari Biathlon (2001, Lithuanian) | playable | |
| Shrek 2 (English PC) | playable§ | |
| RollerCoaster Tycoon Deluxe (Steam) | playable | |
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
| Empire Earth (2.00, single player) | playable‡ | |
| Empire Earth: The Art of Conquest (1.00, single player) | playable‡ | |
| Command & Conquer (Tiberian Dawn, Win95 edition) | playable | |
| Command & Conquer: Red Alert (Win95 edition) | playable | |
| Heart of Empty (Delphi, OpenGL) | playable | |
| Bigfoot 4x4 Challenge | playable | |
| Stabilo Boss Mania | playable | |
| Amore | playable | |
| Beavis and Butt-Head in Hock-A-Loogie | playable | |
| T-32K (freeware) | playable | |
| I'm OK (freeware) | playable | |
| Zep's Dreamland (freeware, Allegro 4) | playable | |
| Echoes (freeware, DarkBASIC Pro) | playable | |
| Gravity Bone (freeware) | boots; in game at about 17 fps | |

\* retail has an intermittent mode-switch hiccup; the demo does not.

§ First level only: movies, menu, new game, the storybook and the first swamp level, with
smooth audio confirmed by the contributor. Not a complete playthrough.

‡ Single player only, checked 2026-10-21 with the unmodified Empire Earth 2.00
(v2.00.3466) and The Art of Conquest 1.00 (v1.00.2657) game files: the first Learning
Scenario's lit world, unit selection and movement, native saving, Quit to the post-game
statistics, and loading the save in a fresh worker (Empire Earth also after a full browser
restart). Multiplayer is not covered.
`tools/harness/regression/empire-earth-single-player.harness.ts` re-checks that path for
either game (`EE_ROOT` names the install folder). Bundles were packed
with `tools/make-wgb.ts` from the installed folder kept under its own name: 1024 × 768 × 32,
`--os winxp --ram 1536`, `--app-dir-dlls "binkw32.dll,mss32.dll"` (the game's own Bink and
Miles) and the resolution/rasterizer values the installer writes under
`HKCU\Software\SSSI\Empire Earth`. The Art of Conquest refuses to start without the base
game, so its bundle carries both installed folders and also
`HKCU\Software\Mad Doc Software\EE-AOC`.

† The MCIWnd and DirectMusic runtime was imported from LinusU's full-game branch,
with targeted stack, stream, lifetime and parser regressions. The October 12 integration
does not include a game run; full-game playability and audio/video fidelity have not been
independently accepted. Use a lawfully obtained installed game for any future test.
BottleShip does not implement SafeDisc or ship the game, movies or Windows gm.dls.
Instruments that reference the default GM collection remain silent when that collection
is absent. The trial's earlier gameplay verification does not validate the full game.

The working collection also covers full builds alongside the production demos of Re-Volt,
Heroes III, StarCraft, Diablo II, Max Payne, Harry Potter 1, NFS Porsche and NFS Underground.
The Re-Volt beta is a separate working build, not a replacement for the released demo.

On 2026-10-26 the maintainer confirmed Sid Meier's Pirates! (2004), Half-Life 2
(20th Anniversary), Command & Conquer: Red Alert 3, Deus Ex: Game of the Year Edition
and The Longest Journey as working. These playable statuses include that maintainer
report. The local bundles are `sid-meiers-pirates.wgb`, `hl2-20th.wgb`,
`red-alert-3.wgb`, `deus-ex-goty.wgb` and `the_longest_journey.wgb`.
Red Alert 3 was also launched through the Bundles UI: the opening movie and the
Leningrad mission briefing rendered. The observed run recorded a browser-cache write
failure while the system disk was full; startup subsequently succeeded. This check
covers the base game; Uprising and campaign completion have not been verified.

System Shock 2 coverage is for the original 1999 game, including previously purchased GOG
copies; it does not cover the 2025 remaster. Unreal Gold's former GOG edition is delisted.
Quake II coverage is for the classic Win32 executable, rather than the Enhanced executable.
Half-Life 2 coverage is for `hl2-20th.wgb` (checked 2026-10-10): ordinary New Game plays the
G-Man introduction and reaches the starting train, platform, station corridor, waiting hall
and security checkpoint, with movement, turning and audio verified. Menu text, sky textures
and interior lighting are corrected; these scenes use `mat_fullbright=0`. Quicksaves from
the ordinary starting train survive a full browser/worker restart and match committed OPFS
bytes exactly. A separate direct-map check of `d1_trainstation_02` verifies quicksave
overwrites, F9 restoration and loading after a full browser/worker restart. The normal
transition to the second map and the full campaign have not been tested. Occlusion intervals
spanning render passes currently report unavailable.
The original Bard's Tale and Worms World Party demos are older editions than the working
remasters. The original Bard's Tale demo has now been checked independently (see below);
Worms World Party's original demo reaches its startup splash; match entry remains unverified.

Empires: Dawn of the Modern World (2003, GOG offline edition): startup is now confirmed
by the maintainer (2026-10-20), following the resource-loading and x87 precision fixes
in `7b25393`, now included in main. This updates the earlier startup failure reported in
[issue #31](https://github.com/jenissimo/bottleship/issues/31). Gameplay, campaign completion
and stability have not been established by this confirmation; the original macOS/Apple
Silicon environment from the issue has not been independently retested.

Neighbours from Hell (2003, Russian Buka disc): the title screen, menus, first tutorial,
character movement and room transition were checked. Russian speech and music play;
MPEG assets with leading padding are recognized. The original disc's three stale MSI
hash records require explicit acceptance during import. Later episodes and campaign
completion have not been tested.

## Added since 0.7

These titles were brought up in pull requests merged between 2026-10-26 and 2026-11-07. The
observed stage is what the PR reports; the maintainer has not retested every one of them.

- **Safari Biathlon** (2001, Lithuanian, DirectX 7 + DirectShow): menus and levels play. The
  Lithuanian text needs the wizard's *Language for non-Unicode programs* set to Lithuanian
  (CP1257). The contributor reports it working fully (#44, #45).
- **Colin McRae Rally 2.0**: menu with its DXT textures and text, MS-ADPCM menu music at the
  correct pitch, and a full race in 3D with the HUD (#160).
- **RollerCoaster Tycoon Deluxe** (Steam): title screen, menu, and New Game → Forest Frontiers
  loads (#158).
- **Diner Dash** (Director 8 behind a Reflexive wrapper, XP bundle): intro, animated loading
  screen (some stutter) and a fully drawn main menu (#42). Gameplay is unverified.
- **Heroes of Might and Magic II Gold** (GOG installer): intro videos, main menu, a new
  standard game, the adventure map and the town screen, with CD music in the menu, map and town
  (#113, #129).
- **Grand Theft Auto** (1997) and **Grand Theft Auto 2**, both the freeware Rockstar Classics
  releases: playable in-game with music and sound; GTA2 plays its Bink intro. The GTA Settings
  dialog works. Multiplayer was checked as a two-tab DirectPlay match for GTA1 and through the
  GTA2 Manager with lobby chat for GTA2 (#67, #69, #75, #76, #78; audio and timing fixes in
  #51–#53, #57/#65, #58, #59).
- **Unreal Tournament GOTY** (full game, CD v432): single player, and LAN multiplayer through
  bottleship-lan with a listen server and a joining client (#79, #80).
- **Star Wars Episode I: Battle for Naboo** (retail, Direct3D 7): opening crawl, in-engine
  cutscene and the playable first level, Escape from Theed (#22).
- **Shrek 2** (English PC): see § above (#34–#37).

Fixes since 0.7 for titles already listed:

- **Empires**: one C runtime per process fixes the random-map `abort()` (#116, #123), and the
  black "Loading Game Window" drops from 50–115 s to 25–30 s. Single Player → Play Random Map →
  Start Game reaches gameplay (#145).
- **Harry Potter and the Chamber of Secrets**: voice-over no longer starts mid-line or stutters
  (#147, checked in game over the Privet Drive / Diagon Alley intro and the Lockhart
  cutscene). An intermittent startup failure from a `Game.ini` race is fixed (#144).
- **The Longest Journey**: no more trails behind characters' heads (#156), and the opening
  voice-over plays (#157). Only the opening scene was checked.
- **Max Payne**: the intro movie is visible again (#141, #142).
- **Half-Life: Day One demo**: New Game no longer crashes and reaches the tram introduction
  (#146).
- **Quake II**: sound no longer arrives about 1.5 s late (#143). The same fix is expected to
  remove the splash-sound stutter in Serious Sam: The First Encounter (not yet confirmed by
  ear).
- **Deus Ex: GOTY**: the first-run wizard no longer ends in a Critical Error; a fresh profile
  reaches Liberty Island (#128).
- **Blade of Darkness**: loading the first level as Naglfar no longer hangs (#131).
- **Star Wars Episode I: Racer**: cutscene audio plays (#132).
- **Grand Theft Auto: Vice City**: the radio resumes mid-song on car entry and engine loops hold
  steady (#49).
- **Cossacks: European Wars (GOG)**: the GOG Video Player plays its videos and hands over to
  the game. Existing bundles need the GOG shortcut arguments in the manifest, or a fresh repack
  (#121).
- **Alice Greenfingers**: no longer closes itself after 10–20 s; reaches the first garden level
  (#119).
- **Mafia**: the Steam Czech edition plays its intro mission with Czech menus and dubbing when
  the bundle is packed with `make-wgb --sdb` for the game's own registry shims (#50).
- **Red Alert 3**: the cold load no longer spends about 41 s hashing the bundle (#120).
- **Hitman: Codename 47 demo**: touch controls can map movement to the numpad on phones (#63).

## Contributor bring-ups (freeware and late-90s titles)

These titles were brought up by a contributor who mainly targets games from the late 1990s
and early 2000s, especially ones that are awkward or impossible to install and start on
Windows 10/11 today, plus newer freeware titles up to a modest download size. The stage is
what the contributor observed in the browser; none is claimed finished, and more titles will
be added in later updates.

- **Command & Conquer** (Tiberian Dawn) and **Command & Conquer: Red Alert**, Win95 editions:
  missions played (#74, #139).
- **Heart of Empty** (Delphi, OpenGL): several levels played, shooting and level loads work;
  the game itself caps at about 30 fps (#106–#110).
- **Bigfoot 4x4 Challenge**: reaches races; sound effects since #168.
- **Stabilo Boss Mania** and **Amore**: in game and played.
- **Beavis and Butt-Head in Hock-A-Loogie**: character selection and in game.
- **T-32K** (freeware): start, movement and shooting (shot-heavy scenes sped up by #167).
- **I'm OK** (freeware): level 1, walking, jumping and hitting.
- **Zep's Dreamland** (freeware, Allegro 4): playable with its MIDI soundtrack through the
  General MIDI synth (#151–#155).
- **Echoes** (freeware, DarkBASIC Pro): reaches the playfield at about 115 fps (#150, #169).
- **Gravity Bone** (freeware): in game, but limited to about 17 fps; performance work is
  ongoing.

## Demo coverage

These observations cover the listed demo editions only; a rendered menu does not establish
full playability.

| Demo | Observed stage | Public catalog |
|---|---|:---:|
| The Lord of the Rings: The Return of the King (English 2003 demo) | Entered the Minas Tirith mission as Gandalf; character movement, rendered scene/HUD and sound verified. Mission completion is untested | ✓ |
| Quake II 3.14 (classic Win32) | Entered a playable level, movement and rendered HUD; OpenGL | ✓ |
| American McGee's Alice | Main menu, OpenGL; bundled 1280 × 1024, 32-bit color/textures and high texture detail | ✓ |
| XIII UK demo | Rendered menu, D3D8 | ✓ |
| Hitman: Codename 47 revision 2 | Mission briefing and the first level's HUD, Direct3D; original OpenGL setup fails pixel-format selection. WGB includes `Setup\Locale.zip`, which the installer script copies from the English language pack; without it the briefing and HUD show resource keys | ✓ |
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
| Blade of Darkness demo | Original demo v0.6: native Direct3D/audio settings included; character selection and Sargon's prison level render with readable text and HUD. Keyboard movement, turning and mouse attack verified. Saving and full mission completion remain unverified; Miles sample reverb is not implemented | ✓ |
| Harry Potter and the Chamber of Secrets demo | Original English PC demo: launcher starts the real game process; entered the level, moved and collected beans. Selected English dialogue and localization files are installed in the WGB | ✓ |
| NFS Underground 2 demo | Original English PC demo: Free Roam and the City Hall Circuit race with three AI opponents verified; rendered city, traffic and HUD, acceleration, braking, reverse and steering. Production HTTP launch and race tested; cold startup/level loading can take several minutes. Persistence remains unverified | ✓ |
| Gothic USA demo 1.08h | English demo: Diego dialogue exit, rendered subtitles/HUD, movement and native saving verified. WGB recreates the required save directories; slots and thumbnails survive page reload. Restoring a saved game can stall in a resource-thread wait; further stability testing is pending | ✓ |
| Cossacks: European Wars demo | Original Wise demo: rendered menu and playable random map; primary scanout and palette animation verified. Native Slow mode with a 50 ms interval gives 20 simulation steps/s | ✓ |
| Thief Gold demo | Original demo: menu, Thieves Guild mission, movement and mouse look verified. Bundle includes the installer-generated install.cfg pointing at its root-level resource archives; without it the guest dereferences a missing interface image | ✓ |
| [Mafia original demo](https://archive.org/details/Mafia_201405) | Rendered mission with a car, city and HUD. WGB includes the native Setup registry value for 1024 × 768, 32-bit fullscreen startup; fresh launch bypasses Setup | ✓ |
| Star Wars Episode I: Battle for Naboo (LucasArts web demo) | Playable Neimoidian Plunder level with the Heavy STAP; thrust, steering and blaster input verified | ✓ |
| Midtown Madness 2 trial | San Francisco Cruise driving (accelerate, steer, brake, horn), Blitz and Checkpoint races, and the first Crash Course gate. "Trial Time Up!" is the trial's own limit | ✓ |
| [Carmageddon II demo](https://archive.org/details/Carmageddon2CarpocalypseNowDemo) | Rendered Controls screen; race entry remains unverified | ✓ |
| [Painkiller Demo 2](https://archive.org/details/Painkiller_Demo_2_build_v1.0) | Rendered main menu; level entry remains unverified | ✓ |
| [Worms World Party original demo](https://ftp.zx.net.nz/pub/archive/ftp.team17.com/pub/t17/goodies/wwp_demo.exe) | Rendered demo splash; match entry remains unverified | ✓ |
| Crimson Skies trial | [Contributor bring-up (#33)](https://github.com/jenissimo/bottleship/issues/33), independently verified on 2026-10-20: visible pilot-name editing, campaign hangar, voiced briefing, legible Flight Check objectives and the Hawaii mission in flight with HUD and keyboard roll controls. Direct3D 6; graphical glitches remain. Repacked from the original CrimsonTrial.exe with its own TrueType fonts installed under Windows Fonts. Wrapped DrawTextEx measurement and text color after solid GDI blits were fixed against native Windows oracles. Force feedback and mission completion remain unverified | ✓ |

Harry Potter 1 and Unreal Tournament demos also reach their rendered menus.

These four original installers use the project's own readers: Mafia's RAR4 LZ payload
(27 files, CRC verified), Carmageddon II's ZIP → InstallShield 3 `data.z` payload
(1,605 files, decoded sizes checked), Painkiller's VISE payload (55 files, CRC verified),
and Worms World Party's RAR4 → InstallShield cabinet set (625 files, outer CRC and inner
size/MD5 verified). The captured Mafia settings and repack command are recorded in
[`demo-presets/README.md`](demo-presets/README.md).

Time-limited shareware trials are excluded from the demo catalog, including Alice Greenfingers,
Montezuma, Natalie Brooks, Farm Frenzy and House of 1000 Doors.

## Stretch / in progress

| Title | Status | GOG |
|-------|--------|:---:|
| Prince of Persia: The Sands of Time | in progress | ✓ |

## Reporting compatibility

If you get a title running (or find a regression), a compatibility report with the exact
edition/version, what worked, and what didn't is valuable. Attach a `report()` snapshot (see
[`docs/harness.md`](harness.md)) for anything that froze, exited, or rendered black — it names
the likely culprit. Please don't attach copyrighted game files.
