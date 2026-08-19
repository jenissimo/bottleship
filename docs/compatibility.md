# Compatibility

BottleShip targets native Win32 games of roughly **1997–2004** — the DirectDraw / Direct3D
3–9 era. This is a living list of titles that have been brought up and observed running; it is
not exhaustive, and "runs" means different things at different stages (boots to menu vs. fully
playable). Your mileage will vary with the exact build/version you own.

**How to read the table**

- **Status** — `playable` (reaches gameplay and is enjoyable), `boots` (reaches menu / early
  gameplay, rough edges), `in progress` (actively being brought up).
- **GOG ✓** — the title is sold DRM-free on GOG; its offline installer can be dropped
  straight into BottleShip (see [`docs/gog-import.md`](gog-import.md)). Everything else:
  bring your own legally-owned copy.

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
| Carmageddon 2: Carpocalypse Now | playable | ✓ |
| Star Wars Episode I: Racer | playable | ✓ |
| Unreal Gold | playable | ✓ |
| Quake II | playable | ✓ |
| Half-Life: Uplink / Day One (demos) | playable | |
| Red Faction | playable | ✓ |
| Grand Theft Auto III | playable | |
| Hitman: Codename 47 | playable | ✓ |
| Thief Gold | playable | ✓ |
| System Shock 2 | playable | ✓ |
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

\* retail has an intermittent mode-switch hiccup; the demo does not.

## Stretch / in progress

| Title | Status | GOG |
|-------|--------|:---:|
| XIII | in progress | ✓ |
| The Longest Journey | in progress | ✓ |
| Deus Ex | in progress | ✓ |
| Serious Sam: The First Encounter | in progress | ✓ |
| KKND2: Krossfire | in progress | ✓ |
| Prince of Persia: The Sands of Time | in progress | ✓ |
| Painkiller Black Edition | in progress | ✓ |

## Reporting compatibility

If you get a title running (or find a regression), a compatibility report with the exact
edition/version, what worked, and what didn't is valuable. Attach a `report()` snapshot (see
[`docs/harness.md`](harness.md)) for anything that froze, exited, or rendered black — it names
the likely culprit. Please don't attach copyrighted game files.
